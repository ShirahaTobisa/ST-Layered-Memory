import { createHash } from 'node:crypto';
import { DEFAULTS, assertNumber } from '../shared/model.js';

export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const summarySignature = config => hash(['summary-v1', config.summary.url, config.summary.model]);
export const vectorSignature = config => hash([config.embedding.url, config.embedding.model, config.embedding.dimensions]);

export function configure(input, previous = DEFAULTS) {
    const next = structuredClone(previous);
    for (const name of ['summary', 'embedding', 'rerank']) {
        const section = input[name];
        if (!section) continue;
        for (const key of ['url', 'model', 'key']) if (Object.hasOwn(section, key)) {
            if (typeof section[key] !== 'string' || section[key].length > 4096) throw new Error('模型配置格式错误');
            next[name][key] = section[key].trim();
        }
        if (next[name].url) {
            const url = new URL(next[name].url);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('接口地址需为 HTTP(S)，不能带用户名或查询参数');
            next[name].url = url.href.replace(/\/$/, '');
        }
    }
    if (input.mode !== undefined) {
        if (!['classic', 'enhanced'].includes(input.mode)) throw new Error('未知记忆模式');
        next.mode = input.mode;
    }
    for (const [key, min, max] of [['keep', 2, 100], ['topK', 1, 30], ['threshold', -1, 1], ['budget', 128, 16000], ['concurrency', 1, 4]]) {
        if (input[key] !== undefined) next[key] = assertNumber(input[key], min, max, key);
        if (key !== 'threshold') next[key] = Math.floor(next[key]);
    }
    if (input.embedding?.dimensions !== undefined) next.embedding.dimensions = Math.floor(assertNumber(input.embedding.dimensions, 0, 8192, '向量维度'));
    if (input.summary?.maxTokens !== undefined) next.summary.maxTokens = Math.floor(assertNumber(input.summary.maxTokens, 128, 4096, '总结长度'));
    if (input.rerank?.enabled !== undefined) next.rerank.enabled = !!input.rerank.enabled;
    return next;
}

export function publicConfig(config) {
    const value = structuredClone(config);
    for (const name of ['summary', 'embedding', 'rerank']) {
        value[name].hasKey = !!value[name].key;
        delete value[name].key;
    }
    return value;
}

const endpoint = (url, suffix) => url.endsWith(`/${suffix}`) ? url : `${url}/${suffix}`;

export class Providers {
    constructor(fetcher = fetch) { this.fetcher = fetcher; }

    async request(config, suffix, body, signal, timeout = 60000) {
        if (!config.url || !config.model) throw new Error('尚未配置接口地址和模型');
        const response = await this.fetcher(endpoint(config.url, suffix), {
            method: 'POST', headers: { 'content-type': 'application/json', ...(config.key ? { authorization: `Bearer ${config.key}` } : {}) },
            body: JSON.stringify(body), signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeout)]),
        });
        if (!response.ok) throw new Error(`模型接口返回 HTTP ${response.status}`);
        const data = await response.json();
        if (data.error) throw new Error('模型接口返回错误');
        return data;
    }

    async summarize(config, input, signal) {
        const instruction = input.kind === 'group'
            ? '合并以下逐轮记忆，保持时间顺序、因果、人物关系、承诺、物品变化和未解决事项。不能添加事实，区分猜测与事实。只输出 350–500 字的中文记忆正文，可更短。'
            : '将目标轮次整理为第三人称的中文记忆，200–250 字，可更短。背景仅用于理解，不能当作本轮事件重复记入。明确人物身份，保留事件变化、关系、因果、承诺、物品和未解决事项，区分事实、想法和猜测。仅保留原文明确时间，不编造日期。只输出记忆正文。';
        const data = await this.request(config.summary, 'chat/completions', {
            model: config.summary.model, temperature: 0.2, stream: false, max_tokens: config.summary.maxTokens,
            messages: [{ role: 'system', content: instruction }, { role: 'user', content: input.prompt }],
        }, signal);
        const choice = data.choices?.[0];
        const text = choice?.message?.content;
        if (choice?.finish_reason !== 'stop' || choice.message?.refusal || choice.message?.tool_calls?.length || typeof text !== 'string' || !text.trim()) throw new Error('总结未完整完成，保留原文');
        if (text.length > 20000) throw new Error('总结过长，保留原文');
        return text.trim();
    }

    async embed(config, texts, signal, timeout = 60000) {
        const setting = config.embedding;
        const data = await this.request(setting, 'embeddings', { model: setting.model, input: texts, ...(setting.dimensions ? { dimensions: setting.dimensions } : {}) }, signal, timeout);
        const items = data.data;
        if (!Array.isArray(items) || items.length !== texts.length) throw new Error('向量数量不匹配');
        const ordered = [...items].sort((a, b) => a.index - b.index);
        const dim = setting.dimensions || ordered[0]?.embedding?.length;
        if (!dim || dim > 8192 || ordered.some((item, i) => item.index !== i || !Array.isArray(item.embedding) || item.embedding.length !== dim || item.embedding.some(n => typeof n !== 'number' || !Number.isFinite(n)))) throw new Error('向量索引、维度或数值无效');
        return ordered.map(item => item.embedding);
    }

    async rerank(config, query, documents, signal) {
        const data = await this.request(config.rerank, 'rerank', { model: config.rerank.model, query, documents, top_n: documents.length }, signal, 10000);
        const seen = new Set();
        if (!Array.isArray(data.results) || data.results.some(r => !Number.isInteger(r.index) || r.index < 0 || r.index >= documents.length || seen.has(r.index) || !Number.isFinite(r.relevance_score) || !seen.add(r.index))) throw new Error('重排结果格式无效');
        return data.results;
    }
}
