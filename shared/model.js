export const KEY = 'rph_memory';
export const MAIN_TYPES = new Set(['normal', 'regenerate', 'swipe', 'continue']);
export const DEFAULTS = {
    mode: 'classic', keep: 20, topK: 10, threshold: 0.48, budget: 2048, concurrency: 2,
    summary: { url: '', model: '', key: '', maxTokens: 700 },
    embedding: { url: '', model: '', key: '', dimensions: 0 },
    rerank: { url: '', model: '', key: '', enabled: false },
};

export function cleanText(text) {
    return String(text || '').replace(/<(think|thinking)>[\s\S]*?(?:<\/\1>|$)/gi, '').replace(/<!--[^]*?-->/g, '').trim();
}

export function turnsFrom(messages) {
    const turns = [];
    let current = null;
    const flush = () => { if (current?.assistant.length) turns.push(current); };
    for (const message of messages) {
        if (message.role === 'system') continue;
        if (message.role === 'user') {
            if (current?.assistant.length) { flush(); current = null; }
            current ??= { user: [], assistant: [] };
            current.user.push(message);
        } else if (current && message.role === 'assistant') current.assistant.push(message);
    }
    flush();
    return turns.map((turn, index) => {
        const all = [...turn.user, ...turn.assistant];
        return {
            ...turn, number: index + 1, ids: all.map(m => m.id),
            eligible: turn.assistant.every(m => !m.blocked),
            empty: turn.assistant.every(m => !cleanText(m.text)),
            text: all.map(m => `${m.name || m.role}: ${cleanText(m.text)}`).join('\n'),
        };
    });
}

export function sourceData(turn) {
    return [...turn.user, ...turn.assistant].map(m => [m.id, m.role, m.name, m.text, m.swipe, !!m.blocked, !!m.protected]);
}

export function eligibleGroups(turns, memories) {
    const groups = [];
    for (let i = 0; i + 5 <= turns.length - 25; i += 5) {
        const subset = turns.slice(i, i + 5);
        if (subset.some(t => !t.eligible)) continue;
        const children = subset.filter(t => !t.empty).map(t => memories.get(t.key));
        if (children.length < 2 || children.some(m => !m?.enabled)) continue;
        groups.push({ start: i + 1, end: i + 5, children, ids: subset.flatMap(t => t.ids) });
    }
    return groups;
}

export function assertNumber(value, min, max, name) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} 范围应为 ${min}–${max}`);
    return n;
}
