export const KEY = 'rph_memory';
export const MAIN_TYPES = new Set(['normal', 'regenerate', 'swipe', 'continue']);
export const DEFAULTS = {
    version: 2, mode: 'classic', keep: 20, concurrency: 5, rawLimit: 5,
    summary: { url: '', model: '', key: '' },
    embedding: { url: '', model: '', key: '' },
};

export function cleanText(text) {
    return String(text || '').replace(/<(think|thinking|cot|analysis)>[\s\S]*?(?:<\/\1>|$)/gi, '')
        .replace(/<next_response>[\s\S]*?(?:<\/next_response>|$)/gi, '')
        .replace(/<ui_template_state_context>[\s\S]*?(?:<\/ui_template_state_context>|$)/gi, '')
        .replace(/<ui_template_updates>[\s\S]*?(?:<\/ui_template_updates>|$)/gi, '').trim();
}

export function floorsFrom(messages) {
    const floors = [];
    for (const message of messages) {
        if (message.role === 'system') { floors.push({ role: 'system', messages: [message], barrier: true }); continue; }
        const last = floors.at(-1);
        if (last?.role === message.role && !last.barrier && !last.preventMerge && !message.preventMerge) last.messages.push(message);
        else floors.push({ role: message.role, messages: [message], preventMerge: !!message.preventMerge });
    }
    return floors;
}

export const roleText = (messages, clean = true) => {
    const names = new Set(messages.map(m => m.name).filter(Boolean));
    return messages.map(m => `${names.size > 1 ? `${m.name || m.role}：` : ''}${clean ? cleanText(m.text) : m.text || ''}`).filter(Boolean).join('\n\n');
};

export function turnsFrom(messages) {
    const floors = floorsFrom(messages);
    const turns = [];
    let pendingUser = null;
    for (const floor of floors) {
        if (floor.role === 'system') { pendingUser = null; continue; }
        if (floor.role === 'user') {
            pendingUser = floor;
            continue;
        }
        if (floor.role !== 'assistant' || !pendingUser) continue;
        turns.push({ user: pendingUser.messages, assistant: floor.messages });
        pendingUser = null;
    }
    return turns.map((turn, index) => {
        const all = [...turn.user, ...turn.assistant];
        return {
            ...turn, number: index + 1, ids: all.map(m => m.id),
            userIds: turn.user.map(m => m.id), assistantIds: turn.assistant.map(m => m.id),
            eligible: turn.assistant.every(m => !m.blocked),
            empty: turn.assistant.every(m => !cleanText(m.text)),
            text: roleText(all),
        };
    });
}

export function sourceData(turn) {
    return [...turn.user, ...turn.assistant].map(m => [m.id, m.role, m.name, m.text, m.swipe, !!m.blocked, !!m.protected]);
}

export function eligibleGroups(turns, memories) {
    const groups = [];
    const limit = Math.max(0, turns.length - 25);
    for (let start = 0; start + 5 <= limit; start += 5) {
        const subset = turns.slice(start, start + 5);
        const children = subset.flatMap(turn => {
            if (!turn.eligible || turn.empty) return [];
            return [memories.get(turn.key)].filter(Boolean);
        });
        const complete = subset.every(turn => turn.empty || memories.has(turn.key));
        if (!complete || children.length < 2) continue;
        groups.push({ start: children[0].turn, end: children.at(-1).turn, children, ids: children.flatMap(m => m.ids || []) });
    }
    return groups;
}

export function assertNumber(value, min, max, name) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} 范围应为 ${min}–${max}`);
    return n;
}
