import { createHash } from 'node:crypto';
import { DEFAULTS, PROVIDERS, EFFORTS, assertNumber, cleanText } from '../shared/model.js';
import { buildClassicSummarySystemPrompt, buildClassicSummaryFinalInstruction, buildClassicSecondarySummaryPrompt } from '../shared/summary-prompts.js';

export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const summarySignature = config => hash(['lm-1.9.5', config.summary.url, config.summary.model]);
export const vectorSignature = config => hash(['lm-1.9.5', config.embedding.url, config.embedding.model]);

export function configure(input, previous = DEFAULTS) {
    const next = structuredClone(DEFAULTS);
    for (const name of PROVIDERS) {
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
    next.summary.effort = input.summary?.effort ?? previous.summary?.effort ?? '';
    if (!Object.keys(EFFORTS).includes(next.summary.effort)) throw new Error('思考强度无效');
    next.mode = input.mode ?? previous.mode ?? DEFAULTS.mode;
    if (!['classic', 'enhanced'].includes(next.mode)) throw new Error('未知记忆模式');
    const keep = Number(input.keep ?? previous.keep);
    next.keep = Number.isFinite(keep) ? Math.max(10, Math.min(40, Math.round(keep / 2) * 2)) : 20;
    next.autoHide = input.autoHide ?? previous.autoHide ?? DEFAULTS.autoHide;
    if (typeof next.autoHide !== 'boolean') throw new Error('自动隐藏设置格式错误');
    next.citations = input.citations ?? previous.citations ?? DEFAULTS.citations;
    if (typeof next.citations !== 'boolean') throw new Error('记忆引用设置格式错误');
    const concurrency = Number(input.concurrency ?? (previous.version === 2 ? previous.concurrency : 5));
    next.concurrency = Number.isFinite(concurrency) ? Math.max(1, Math.min(10, Math.round(concurrency))) : 5;
    next.rawLimit = Math.round(assertNumber(input.rawLimit ?? previous.rawLimit ?? 5, 5, 10, '原文结果数量'));
    next.recallLimit = Math.round(assertNumber(input.recallLimit ?? previous.recallLimit ?? DEFAULTS.recallLimit, 3, 20, '召回条数上限'));
    next.recallThreshold = Math.round(assertNumber(input.recallThreshold ?? previous.recallThreshold ?? DEFAULTS.recallThreshold, 0.1, 0.9, '召回相似度门槛') * 100) / 100;
    next.recallExcludeRaw = input.recallExcludeRaw ?? previous.recallExcludeRaw ?? DEFAULTS.recallExcludeRaw;
    if (typeof next.recallExcludeRaw !== 'boolean') throw new Error('召回排除原文设置格式错误');
    next.rerankThreshold = Math.round(assertNumber(input.rerankThreshold ?? previous.rerankThreshold ?? DEFAULTS.rerankThreshold, 0, 1, '重排最低分') * 100) / 100;
    next.recallShortContext = input.recallShortContext ?? previous.recallShortContext ?? DEFAULTS.recallShortContext;
    if (typeof next.recallShortContext !== 'boolean') throw new Error('短输入补充上下文设置格式错误');
    return next;
}

export function publicConfig(config) {
    const value = structuredClone(config);
    for (const name of PROVIDERS) {
        value[name].hasKey = !!value[name].key;
        delete value[name].key;
    }
    return value;
}

const endpoint = (url, suffix) => url.endsWith(`/${suffix}`) ? url : `${url}/${suffix}`;
// The summary model is told how hard to think only when a level was chosen.
export const effort = setting => setting.effort ? { reasoning_effort: setting.effort } : {};

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const BAD_FINISH_REASONS = new Set(['length', 'max_tokens', 'content_filter', 'safety', 'recitation', 'tool_calls', 'function_call']);

function sanitizeDetail(raw, secret) {
    let text = String(raw || '').replace(/\s+/g, ' ').trim();
    if (secret) text = text.replaceAll(secret, '***');
    text = text.replace(/Bearer\s+\S+|\bsk-[\w-]+/gi, '***');
    return text.slice(0, 180);
}

function retryAfterMs(response) {
    const header = response.headers?.get?.('retry-after');
    if (!header) return null;
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1000, Math.min(60000, Math.round(seconds * 1000)));
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.max(1000, Math.min(60000, at - Date.now()));
    return null;
}

export function completionText(data) {
    const choice = data.choices?.[0];
    const reason = String(choice?.finish_reason || '').toLowerCase();
    if (BAD_FINISH_REASONS.has(reason) || choice?.message?.tool_calls?.length) throw new Error('总结没有完整结束，保留原文');
    const raw = choice?.message?.content;
    const text = Array.isArray(raw) ? raw.filter(part => part?.type === 'text').map(part => part.text || '').join('') : raw;
    if (typeof text !== 'string' || !cleanText(text)) throw new Error('总结未返回有效正文，保留原文');
    return cleanText(text);
}

export class Providers {
    constructor(fetcher = fetch) { this.fetcher = fetcher; }

    async request(config, suffix, body, signal, timeout = 60000) {
        if (!config.url || !config.model) throw new Error('尚未配置接口地址和模型');
        let response;
        try {
            response = await this.fetcher(endpoint(config.url, suffix), {
                method: 'POST', headers: { 'content-type': 'application/json', ...(config.key ? { authorization: `Bearer ${config.key}` } : {}) },
                body: JSON.stringify(body), signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeout)]),
            });
        } catch (error) {
            if (!signal?.aborted && error?.name !== 'TimeoutError' && error?.name !== 'AbortError') error.retryable = true;
            throw error;
        }
        if (!response.ok) {
            let detail = '';
            try {
                const raw = await response.text();
                try {
                    const parsed = JSON.parse(raw);
                    detail = sanitizeDetail(typeof parsed?.error === 'string' ? parsed.error : (parsed?.error?.message || parsed?.message || parsed?.detail || raw), config.key);
                } catch { detail = sanitizeDetail(raw, config.key); }
            } catch { /* ignore unreadable error body */ }
            throw Object.assign(new Error(`模型接口返回 HTTP ${response.status}${detail ? `：${detail}` : ''}`), {
                status: response.status, retryable: RETRYABLE_STATUS.has(response.status), retryAfter: retryAfterMs(response),
            });
        }
        let data;
        try { data = await response.json(); }
        catch { throw Object.assign(new Error('模型接口返回了非 JSON 响应'), { retryable: true }); }
        if (data.error) {
            const detail = sanitizeDetail(typeof data.error === 'string' ? data.error : (data.error?.message || data.error?.type || ''), config.key);
            const code = Number(data.error?.code || data.error?.status);
            throw Object.assign(new Error(`模型接口返回错误${detail ? `：${detail}` : ''}`), { retryable: RETRYABLE_STATUS.has(code) });
        }
        return data;
    }

    async summarize(config, input, signal) {
        const messages = summaryMessages(input);
        // Thinking models can take well over a minute on one summary, and a request given up on is still paid for.
        const data = await this.request(config.summary, 'chat/completions', {
            model: config.summary.model, temperature: 0.2, stream: false, messages, ...effort(config.summary),
        }, signal, 180000);
        const text = completionText(data);
        if (text.length > 20000) throw new Error('总结过长，保留原文');
        const unfenced = text.match(/^\s*```(?:text|markdown|md)?\s*\r?\n([\s\S]*?)\r?\n?```\s*$/i)?.[1] ?? text;
        const summary = unfenced.replace(/^(?:最新对话总结|总结)[:：]\s*/i, '').trim().replace(/\n{3,}/g, '\n\n');
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

    // Jina/Cohere-style rerank: how well each document fits the query, in the order the documents were given.
    async rerank(config, query, documents, signal, timeout = 10000) {
        const setting = config.rerank, scores = documents.map(() => -Infinity);
        const data = await this.request(setting, 'rerank', { model: setting.model, query, documents, top_n: documents.length }, signal, timeout);
        for (const item of Array.isArray(data.results) ? data.results : []) {
            const score = Number.isFinite(item?.relevance_score) ? item.relevance_score : item?.score;
            if (Number.isInteger(item?.index) && item.index in scores && Number.isFinite(score)) scores[item.index] = score;
        }
        if (!scores.some(Number.isFinite)) throw new Error('重排接口没有返回有效分数');
        return scores;
    }

    async models(setting, provider = '') {
        if (!setting.url) throw new Error('请填写接口地址');
        const response = await this.fetcher(endpoint(setting.url, 'models'), { headers: setting.key ? { authorization: `Bearer ${setting.key}` } : {}, signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(`模型列表返回 HTTP ${response.status}`);
        const data = await response.json();
        if (!Array.isArray(data.data)) throw new Error('接口未返回 OpenAI 格式的模型列表，可手动填写模型名');
        const list = [...new Set(data.data.map(m => m.id).filter(id => typeof id === 'string'))].sort();
        const isEmbed = id => /(?:^|[\/_-])(?:text-)?embed(?:ding)?|bge-m3|bge-(?:large|base|small)|m3e|gte-|e5-/i.test(id);
        const isRerank = id => /rerank/i.test(id);
        if (provider === 'summary') {
            const chat = list.filter(id => !isEmbed(id) && !isRerank(id));
            return chat.length ? chat : list;
        }
        if (provider === 'embedding') return [...list.filter(isEmbed), ...list.filter(id => !isEmbed(id))];
        if (provider === 'rerank') return [...list.filter(isRerank), ...list.filter(id => !isRerank(id))];
        return list;
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
