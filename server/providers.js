import { createHash } from 'node:crypto';
import { DEFAULTS, assertNumber, cleanText } from '../shared/model.js';
import { buildClassicSummarySystemPrompt, buildClassicSummaryFinalInstruction, buildClassicSecondarySummaryPrompt } from '../shared/summary-prompts.js';

export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const summarySignature = config => hash(['lm-1.9.5', config.summary.url, config.summary.model]);
export const vectorSignature = config => hash(['lm-1.9.5', config.embedding.url, config.embedding.model]);

export function configure(input, previous = DEFAULTS) {
    const next = structuredClone(DEFAULTS);
    for (const name of ['summary', 'embedding']) {
        for (const key of ['url', 'model', 'key']) next[name][key] = previous[name]?.[key] || '';
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
    next.mode = input.mode ?? previous.mode ?? DEFAULTS.mode;
    if (!['classic', 'enhanced'].includes(next.mode)) throw new Error('未知记忆模式');
    const keep = Number(input.keep ?? previous.keep);
    next.keep = Number.isFinite(keep) ? Math.max(10, Math.min(40, Math.round(keep / 2) * 2)) : 20;
    const concurrency = Number(input.concurrency ?? (previous.version === 2 ? previous.concurrency : 5));
    next.concurrency = Number.isFinite(concurrency) ? Math.max(1, Math.min(10, Math.round(concurrency))) : 5;
    next.rawLimit = Math.round(assertNumber(input.rawLimit ?? previous.rawLimit ?? 5, 5, 10, '原文结果数量'));
    return next;
}

export function publicConfig(config) {
    const value = structuredClone(config);
    for (const name of ['summary', 'embedding']) {
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
        const messages = summaryMessages(input);
        const data = await this.request(config.summary, 'chat/completions', {
            model: config.summary.model, temperature: 0.2, stream: false, messages,
        }, signal);
        const choice = data.choices?.[0];
        const raw = choice?.message?.content;
        const text = Array.isArray(raw) ? raw.map(part => part?.text || part?.content || '').join('') : raw;
        if (typeof text !== 'string' || !text.trim()) throw new Error('总结未返回有效正文，保留原文');
        if (text.length > 20000) throw new Error('总结过长，保留原文');
        const summary = cleanText(text).replace(/^```(?:text|markdown)?\s*/i, '').replace(/\s*```$/, '')
            .replace(/^(?:最新对话总结|总结)[:：]\s*/i, '').trim().replace(/\n{3,}/g, '\n\n');
        if (!summary) throw new Error('副模型没有返回有效总结');
        return summary;
    }

    async embed(config, texts, signal, timeout = 60000) {
        const setting = config.embedding;
        const data = await this.request(setting, 'embeddings', { model: setting.model, input: texts }, signal, timeout);
        const items = data.data;
        if (!Array.isArray(items) || items.length !== texts.length) throw new Error('向量数量不匹配');
        const ordered = [...items].sort((a, b) => a.index - b.index);
        const dim = ordered[0]?.embedding?.length;
        if (!dim || dim > 8192 || ordered.some((item, i) => item.index !== i || !Array.isArray(item.embedding) || item.embedding.length !== dim || item.embedding.some(n => typeof n !== 'number' || !Number.isFinite(n)))) throw new Error('向量索引、维度或数值无效');
        return ordered.map(item => item.embedding);
    }

    async models(setting) {
        if (!setting.url) throw new Error('请填写接口地址');
        const response = await this.fetcher(endpoint(setting.url, 'models'), { headers: setting.key ? { authorization: `Bearer ${setting.key}` } : {}, signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(`模型列表返回 HTTP ${response.status}`);
        const data = await response.json();
        if (!Array.isArray(data.data)) throw new Error('接口未返回 OpenAI 格式的模型列表，可手动填写模型名');
        return [...new Set(data.data.map(m => m.id).filter(id => typeof id === 'string'))].sort();
    }
}

export function summaryMessages(input) {
    if (input.kind === 'group') return [
        { role: 'system', content: buildClassicSecondarySummaryPrompt({ ...input.names, startTurn: input.memory.turn, endTurn: input.memory.end }) },
        { role: 'user', content: input.prompt },
    ];
    const messages = [{ role: 'system', content: buildClassicSummarySystemPrompt(input.names || {}) }];
    for (const turn of input.contextTurns || []) {
        const marker = turn.number === input.memory.turn ? `【最新对话：唯一总结目标｜第 ${turn.number} 轮】` : `【历史背景：仅供理解，不得作为总结目标｜第 ${turn.number} 轮】`;
        messages.push({ role: 'user', content: `${marker}\n${turn.user}` }, { role: 'assistant', content: `${marker}\n${turn.assistant}` });
    }
    messages.push({ role: 'user', content: buildClassicSummaryFinalInstruction(input.memory.turn) });
    return messages;
}
