import MiniSearch from 'minisearch';
import { vectorSignature } from './providers.js';

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const tokenize = text => [...segmenter.segment(text.toLowerCase())].filter(s => s.isWordLike).map(s => s.segment);
export function lexical(documents, query) {
    if (!documents.length || !query.trim()) return [];
    const index = new MiniSearch({ fields: ['text'], storeFields: [], tokenize, searchOptions: { combineWith: 'OR', prefix: true } });
    index.addAll(documents);
    return index.search(query);
}

export function cosine(a, b) {
    if (!a?.length || a.length !== b?.length) return -1;
    let dot = 0, left = 0, right = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; left += a[i] * a[i]; right += b[i] * b[i]; }
    return left && right ? dot / Math.sqrt(left * right) : -1;
}

export async function recall(store, id, query, excludedIds, providers) {
    const config = store.config;
    const excluded = new Set(excludedIds);
    const memories = store.memories(id).filter(m => m.kind === 'summary' && m.enabled && !m.ids.some(source => excluded.has(source)));
    const terms = lexical(memories.map(m => ({ id: m.id, text: `${m.userText}\n${m.summary}` })), query).slice(0, 50);
    const warnings = [], ranks = new Map();
    const add = (list, why) => list.forEach((r, i) => {
        const found = ranks.get(r.id) || { id: r.id, score: 0, why: [] };
        found.score += 1 / (60 + i + 1); found.why.push(why);
        ranks.set(r.id, found);
    });
    add(terms, '关键词');
    const vectors = memories.filter(m => m.vector && m.vectorSignature === vectorSignature(config));
    if (vectors.length && query.trim()) {
        try {
            const [vector] = await providers.embed(config, [query], undefined, 10000);
            add(vectors.map(m => ({ id: m.id, score: cosine(vector, m.vector) })).filter(m => m.score >= config.threshold).sort((a, b) => b.score - a.score).slice(0, 50), '向量');
        } catch { warnings.push('向量检索不可用，本轮使用关键词结果'); }
    }
    let selected = [...ranks.values()].sort((a, b) => b.score - a.score).slice(0, 30).map(r => ({ ...memories.find(m => m.id === r.id), ...r }));
    if (config.rerank.enabled && selected.length) {
        try {
            const ranked = await providers.rerank(config, query, selected.map(m => m.summary));
            selected = ranked.sort((a, b) => b.relevance_score - a.relevance_score).map(r => ({ ...selected[r.index], score: r.relevance_score, why: [...selected[r.index].why, '重排'] }));
        } catch { warnings.push('重排不可用，本轮保留初选结果'); }
    }
    return { memories: selected.slice(0, config.topK).sort((a, b) => a.turn - b.turn), warnings };
}

export function rawSearch(messages, query, limit = 5) {
    const docs = messages.filter(m => m.role !== 'system' && !m.blocked).map(m => ({ id: m.id, text: m.text, name: m.name, index: messages.indexOf(m) }));
    return lexical(docs, query).slice(0, limit).map(hit => {
        const doc = docs.find(d => d.id === hit.id);
        const words = tokenize(query);
        const positions = words.map(word => doc.text.toLowerCase().indexOf(word)).filter(n => n >= 0);
        const start = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 250);
        return { id: doc.id, floor: doc.index + 1, name: doc.name, text: doc.text.slice(start, start + 1600), truncated: doc.text.length > 1600 };
    }).sort((a, b) => a.floor - b.floor);
}
