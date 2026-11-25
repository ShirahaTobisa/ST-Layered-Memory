import { vectorSignature } from './providers.js';
import { vectorText, shownText } from './store.js';
import { cleanText, floorsFrom, turnsFrom, roleText } from '../shared/model.js';

export function cosine(a, b) {
    return cosineWithNorm(a, a?.length ? Math.sqrt(a.reduce((sum, value) => sum + value * value, 0)) : 0, b);
}

function cosineWithNorm(query, queryNorm, target) {
    if (!queryNorm || !target?.length || query.length !== target.length) return -1;
    let dot = 0, right = 0;
    for (let i = 0; i < query.length; i++) { dot += query[i] * target[i]; right += target[i] * target[i]; }
    return right ? dot / (queryNorm * Math.sqrt(right)) : -1;
}

function quantize(vector) {
    const max = vector.reduce((value, n) => Math.max(value, Math.abs(n)), 0);
    if (!max) throw new Error('向量模型返回了全零向量');
    const bytes = Int8Array.from(vector, n => Math.max(-127, Math.min(127, Math.round(n / max * 127))));
    return { bytes, scale: max / 127, dims: vector.length, encoding: 'int8:maxabs:v1' };
}

export function packEmbedding(vector) {
    const { bytes, scale, dims, encoding } = quantize(vector);
    return { embeddingQ: Buffer.from(bytes.buffer).toString('base64'), embeddingScale: scale, embeddingDims: dims, embeddingEncoding: encoding };
}

export function packEmbeddingBlob(vector) {
    const { bytes, scale, dims, encoding } = quantize(vector);
    return { vector: Buffer.from(bytes.buffer), scale, dims, encoding };
}

export function unpackEmbedding(memory) {
    if (!memory.embeddingQ) return [];
    const bytes = Buffer.from(memory.embeddingQ, 'base64');
    return bytes.length === memory.embeddingDims ? new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length) : [];
}

export function retrievalQuery(messages, input, shortContext = '') {
    const query = cleanText(input), index = messages.findLastIndex(m => m.role === 'user');
    if (!query || query.length >= 30) return query;
    const cleanedShort = shortContext ? cleanText(shortContext).slice(-180) : '';
    if (cleanedShort) return `${cleanedShort}\n当前输入：${query}`;
    if (cleanText(messages[index]?.text) !== query) return query;
    const previous = messages.slice(0, index).findLast(m => m.role === 'assistant');
    const context = previous && shownText([previous]).slice(-150);
    return context ? `${context}\n当前输入：${query}` : query;
}

const terms = text => (String(text).toLowerCase().match(/[\p{Script=Han}]+|(?:(?!\p{Script=Han})[\p{L}\p{N}_-])+/gu) || []).flatMap(word =>
    /^[\p{Script=Han}]+$/u.test(word) && word.length > 1 ? Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2)) : [word]);

// Specific identifiers: digit mixed with letters/symbols (e.g. b-17, a1) or 3+ digit codes (e.g. 7419), excluding bare 1-2 digit numbers.
const isIdentifier = term => /\p{N}/u.test(term) && (term.length >= 3 || /[\p{L}_-]/u.test(term));
const isMeaningful = term => term.length >= 2 && !/^\p{N}{1,2}$/u.test(term);

// BM25 supplies a separate ranking for exact names, identifiers and specific phrases while guarding against bare digits and common chat words.
export function keywordRanking(memories, query) {
    const queryTerms = [...new Set(terms(query))].filter(isMeaningful);
    if (!queryTerms.length || !memories.length) return [];
    const documents = memories.map(memory => {
        const words = terms(vectorText(memory)), counts = new Map();
        for (const word of words) counts.set(word, (counts.get(word) || 0) + 1);
        return { memory, counts, length: words.length };
    });
    const totalDocs = documents.length;
    const average = documents.reduce((sum, doc) => sum + doc.length, 0) / totalDocs || 1;
    const frequencies = new Map(queryTerms.map(term => [term, documents.filter(doc => doc.counts.has(term)).length]));
    const rareLimit = Math.max(2, Math.floor(totalDocs * 0.3));
    const isRare = term => totalDocs <= 5 || (frequencies.get(term) || 0) <= rareLimit;
    const scoreOf = (doc, term) => {
        const count = doc.counts.get(term) || 0, frequency = frequencies.get(term) || 0;
        if (!count || !frequency) return 0;
        return Math.log(1 + (totalDocs - frequency + 0.5) / (frequency + 0.5)) * count * 2.2 / (count + 1.2 * (0.25 + 0.75 * doc.length / average));
    };
    const results = [];
    for (const doc of documents) {
        const hits = queryTerms.filter(term => doc.counts.has(term));
        if (!hits.length) continue;
        const identifierHit = hits.some(term => isIdentifier(term) && isRare(term));
        const exactShortHit = queryTerms.length === 1 && isRare(hits[0]);
        const keyword = hits.reduce((sum, term) => sum + scoreOf(doc, term), 0);
        const multiHit = hits.length >= 2 && (totalDocs <= 5 || (hits.some(isRare) && keyword >= 1.8));
        if (keyword > 0 && (identifierHit || exactShortHit || multiHit)) results.push({ ...doc.memory, keyword });
    }
    return results.sort((a, b) => b.keyword - a.keyword || a.turn - b.turn);
}

export async function recall(store, id, input, providers, { shortContext = '' } = {}) {
    const config = store.config, all = store.memories(id), messages = store.chat(id)?.messages || [];
    const query = config.recallShortContext ? retrievalQuery(messages, input, shortContext) : cleanText(input);
    const disabled = new Set(all.filter(m => m.kind === 'group' && m.enabled === false).flatMap(m => m.children));
    const raw = new Set(floorsFrom(messages).filter(f => f.role !== 'system').slice(-config.keep)
        .flatMap(f => f.messages.filter(m => !m.hidden && m.view !== '').map(m => m.id)));
    const memories = all.filter(m => m.kind === 'summary' && m.enabled !== false && !disabled.has(m.id)
        && !(config.recallExcludeRaw && m.ids?.length && m.ids.every(mid => raw.has(mid))));
    if (!memories.length || !query) return { memories: [], warnings: [] };
    const warnings = [], signature = vectorSignature(config), limit = config.recallLimit;
    const keyword = keywordRanking(memories, cleanText(input)), embeddings = store.embeddings(id, signature);
    const indexed = memories.filter(m => embeddings.has(m.id));
    let vectors = [];
    if (indexed.length) try {
        const [vector] = await providers.embed(config, [query], undefined, 10000);
        const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
        vectors = indexed.map(m => ({ ...m, score: cosineWithNorm(vector, norm, embeddings.get(m.id)) }))
            .filter(m => m.score >= config.recallThreshold).sort((a, b) => b.score - a.score || a.turn - b.turn);
    } catch { warnings.push('向量召回失败，本次使用关键词与总结上下文'); }
    const combined = new Map();
    for (const [ranking, why] of [[vectors, '向量召回'], [keyword, '关键词命中']]) ranking.slice(0, Math.max(30, limit * 3)).forEach((memory, index) => {
        const previous = combined.get(memory.id);
        combined.set(memory.id, { ...previous, ...memory, rank: (previous?.rank || 0) + 1 / (60 + index + 1), why: [...previous?.why || [], why] });
    });
    let found = [...combined.values()].sort((a, b) => b.rank - a.rank || a.turn - b.turn);
    if (found.length && (found.length > limit || config.rerankThreshold > 0) && config.rerank.url && config.rerank.model) try {
        const candidates = found.slice(0, limit * 3), scores = await providers.rerank(config, query, candidates.map(vectorText));
        found = candidates.map((m, i) => ({ ...m, rerank: scores[i], why: [...m.why, '重排'] }))
            .filter(m => !config.rerankThreshold || m.rerank >= config.rerankThreshold)
            .sort((a, b) => b.rerank - a.rerank || b.rank - a.rank);
    } catch { warnings.push('重排失败，本次按向量与关键词排序'); }
    return { memories: found.slice(0, limit).sort((a, b) => a.turn - b.turn), warnings };
}

export function rawSearch(messages, query, limit = 5) {
    const text = String(query || '').trim().slice(0, 300);
    const terms = [...new Set([text, ...text.split(/[\s,，、;；|｜/\\]+/u)].filter(Boolean))].slice(0, 12);
    if (!terms.length) return [];
    const turns = turnsFrom(messages), turnById = new Map(turns.flatMap(t => t.ids.map(id => [id, t.number])));
    const results = [];
    floorsFrom(messages).filter(floor => floor.role !== 'system').forEach((floor, index) => {
        if (floor.messages.some(m => m.blocked)) return;
        const original = roleText(floor.messages), lower = original.toLowerCase();
        if (!original || original.startsWith('[角色记忆')) return;
        const matchedTerms = terms.filter(term => lower.includes(term.toLowerCase()));
        if (!matchedTerms.length) return;
        const hit = Math.min(...matchedTerms.map(term => lower.indexOf(term.toLowerCase())));
        const start = original.length > 1400 ? Math.max(0, hit - 420) : 0;
        const end = original.length > 1400 ? Math.min(original.length, hit + 900) : original.length;
        results.push({ id: floor.messages[0].id, floor: index + 1, turn: turnById.get(floor.messages[0].id) || '?', name: floor.messages[0].name || floor.role, role: floor.role,
            matchedTerms, score: (lower.includes(terms[0].toLowerCase()) ? 100 : 0) + matchedTerms.length,
            text: `${start ? '...' : ''}${original.slice(start, end).trim()}${end < original.length ? '...' : ''}`, truncated: start > 0 || end < original.length });
    });
    return results.sort((a, b) => b.score - a.score || b.floor - a.floor).slice(0, Math.max(5, Math.min(10, Number(limit) || 5))).sort((a, b) => a.floor - b.floor);
}
