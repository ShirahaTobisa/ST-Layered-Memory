import { vectorSignature } from './providers.js';
import { cleanText, floorsFrom, turnsFrom, roleText } from '../shared/model.js';

export function cosine(a, b) {
    if (!a?.length || a.length !== b?.length) return -1;
    let dot = 0, left = 0, right = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; left += a[i] * a[i]; right += b[i] * b[i]; }
    return left && right ? dot / Math.sqrt(left * right) : -1;
}

export function packEmbedding(vector) {
    const max = vector.reduce((value, n) => Math.max(value, Math.abs(n)), 0);
    if (!max) throw new Error('向量模型返回了全零向量');
    const bytes = Int8Array.from(vector, n => Math.max(-127, Math.min(127, Math.round(n / max * 127))));
    return { embeddingQ: Buffer.from(bytes.buffer).toString('base64'), embeddingScale: max / 127, embeddingDims: vector.length, embeddingEncoding: 'int8:maxabs:v1' };
}

export function unpackEmbedding(memory) {
    if (!memory.embeddingQ) return [];
    const bytes = Buffer.from(memory.embeddingQ, 'base64');
    return bytes.length === memory.embeddingDims ? new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length) : [];
}

export async function recall(store, id, query, providers) {
    const config = store.config, all = store.memories(id);
    const disabled = new Set(all.filter(m => m.kind === 'group' && !m.enabled).flatMap(m => m.children));
    const memories = all.filter(m => m.kind === 'summary' && m.enabled && !disabled.has(m.id) && m.vectorSignature === vectorSignature(config) && unpackEmbedding(m).length);
    if (!memories.length || !query.trim()) return { memories: [], warnings: [] };
    try {
        const [vector] = await providers.embed(config, [query.trim()], undefined, 10000);
        const found = memories.map(m => ({ ...m, score: cosine(vector, unpackEmbedding(m)), why: ['向量召回'] }))
            .filter(m => m.score >= 0.48).sort((a, b) => b.score - a.score || a.turn - b.turn).slice(0, 10).sort((a, b) => a.turn - b.turn);
        return { memories: found, warnings: [] };
    } catch {
        return { memories: [], warnings: ['记忆召回失败，本次仍使用总结上下文'] };
    }
}

export function rawSearch(messages, query, limit = 5) {
    const text = String(query || '').trim().slice(0, 300);
    const terms = [...new Set([text, ...text.split(/[\s,，、;；|｜/\\]+/u)].filter(Boolean))].slice(0, 12);
    if (!terms.length) return [];
    const turns = turnsFrom(messages), turnById = new Map(turns.flatMap(t => t.ids.map(id => [id, t.number])));
    const results = [];
    floorsFrom(messages).filter(floor => floor.role !== 'system').forEach((floor, index) => {
        if (floor.messages.some(m => m.blocked)) return;
        const original = cleanText(roleText(floor.messages, false)).slice(0, 5000), lower = original.toLowerCase();
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
