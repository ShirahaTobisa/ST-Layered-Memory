export const KEY = 'layered_memory';
export const VERSION = '0.2.3';
export const MAIN_TYPES = new Set(['normal', 'regenerate', 'swipe', 'continue']);
export const DEFAULTS = {
    version: 2, mode: 'classic', keep: 20, concurrency: 5, rawLimit: 5,
    summary: { url: '', model: '', key: '' },
    embedding: { url: '', model: '', key: '' },
    rerank: { url: '', model: '', key: '' },
};
export const PROVIDERS = ['summary', 'embedding', 'rerank'];

// SillyTavern also uses is_system for hidden ordinary dialogue.
export function memoryRole(message) {
    const type = message.extra?.type;
    if (message.extra?.tool_invocations?.length || (message.is_system &&
        (message.name === 'SillyTavern System' || (type && type !== 'narrator')))) return 'system';
    return message.is_user ? 'user' : 'assistant';
}

const HIDDEN_TAGS = new Set(['think', 'thinking', 'thought', 'thoughts', 'cot', 'analysis', 'reasoning',
    'scratchpad', 'reflection', 'planning', 'konatan_planning',
    'next_response', 'ui_template_state_context', 'ui_template_updates']);

export function cleanText(text) {
    const value = String(text || ''), output = [], stack = [];
    const tags = /<(\/?)([a-z][\w:.-]*~?)(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gi;
    let cursor = 0;
    for (const match of value.matchAll(tags)) {
        const name = match[2].toLowerCase().replace(/~$/, '');
        if (!HIDDEN_TAGS.has(name)) continue;
        if (!stack.length) output.push(value.slice(cursor, match.index));
        if (match[1]) {
            const opened = stack.lastIndexOf(name);
            if (opened >= 0) stack.length = opened;
        } else if (!/\/\s*>$/.test(match[0])) stack.push(name);
        cursor = match.index + match[0].length;
    }
    if (!stack.length) output.push(value.slice(cursor));
    return output.join('').trim();
}

// The stored form of a message. Both sides build it the same way, so a page can tell
// from a hash alone that the server already holds its chat.
export const storedMessage = m => ({ id: m.id, role: m.role, name: String(m.name || '').slice(0, 128), text: m.text,
    swipe: Number.isInteger(m.swipe) ? m.swipe : 0, blocked: !!m.blocked, protected: !!m.protected,
    ...(m.hidden && m.role !== 'system' ? { hidden: true } : {}), ...(m.held && m.role === 'assistant' ? { held: true } : {}),
    ...(typeof m.view === 'string' && m.view !== m.text && m.view.length <= 200000 && m.role !== 'system' ? { view: m.view } : {}) });

export const stripVector = ({ vector, vectorSignature, embeddingQ, embeddingDims, embeddingScale, embeddingEncoding, ...memory }) => memory;

export function cleanMemory(memory) {
    const summary = cleanText(memory.summary);
    const userText = memory.userText === undefined ? undefined : cleanText(memory.userText);
    if (summary === memory.summary && userText === memory.userText) return memory;
    return { ...stripVector(memory), summary, ...(userText === undefined ? {} : { userText }) };
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
    return messages.map(m => {
        const text = clean ? cleanText(m.text) : m.text || '';
        return text ? `${names.size > 1 ? `${m.name || m.role}：` : ''}${text}` : '';
    }).filter(Boolean).join('\n\n');
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
            eligible: turn.assistant.every(m => !m.blocked), held: turn.assistant.some(m => m.held),
            empty: turn.assistant.every(m => !cleanText(m.text)),
        };
    });
}

export function sourceData(turn) {
    // Hiding changes prompt visibility, not the identity or contents of a memory.
    return [...turn.user, ...turn.assistant].map(m => [m.id, m.role, m.name, m.text, m.swipe, !!m.blocked, !!m.protected]);
}

// A merged memory stays with the summaries it was made from, so deleting or adding a
// turn only touches its own group. Turns outside the latest 25 that no group covers
// yet are taken five at a time.
export function eligibleGroups(turns, memories, existing = []) {
    const position = new Map(turns.map((turn, index) => [turn.key, index]));
    const group = children => ({ start: children[0].turn, end: children.at(-1).turn, children, ids: children.flatMap(m => m.ids || []) });
    const kept = new Map(), covered = new Set();
    for (const saved of existing) {
        const children = (saved.children || []).map(key => memories.get(key));
        const valid = children.length > 1 && children.every((m, i) => m && m.enabled !== false && !covered.has(m.id)
            && position.has(m.id) && (!i || position.get(children[i - 1].id) < position.get(m.id)));
        if (!valid) continue;
        kept.set(position.get(children[0].id), children);
        for (const child of children) covered.add(child.id);
    }
    const groups = [], limit = Math.max(0, turns.length - 25);
    let open = [], keptEnd = -1;
    const close = () => {
        const children = open.flatMap(turn => !turn.eligible || turn.empty ? [] : [memories.get(turn.key)].filter(m => m && m.enabled !== false));
        if (children.length > 1 && open.every(turn => turn.empty || memories.has(turn.key))) groups.push(group(children));
        open = [];
    };
    for (const [index, turn] of turns.entries()) {
        if (kept.has(index)) {
            close();
            groups.push(group(kept.get(index)));
            keptEnd = Math.max(keptEnd, position.get(kept.get(index).at(-1).id));
        }
        if (index <= keptEnd || index >= limit) continue;
        if (open.push(turn) === 5) close();
    }
    return groups;
}

export function assertNumber(value, min, max, name) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} 范围应为 ${min}–${max}`);
    return n;
}
