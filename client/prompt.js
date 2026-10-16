import { enhancedMemoryRecallDescription } from '../shared/summary-prompts.js';
import { KEY } from '../shared/model.js';

const plain = message => typeof message.content === 'string' && !message.tool_calls && !message.tool_call_id && !message.reasoning && !message.reasoning_content;
const xml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function appendRecall(messages, memories) {
    const index = messages.findLastIndex(m => m.role === 'user' && plain(m));
    if (index < 0 || !memories.length) return { messages, used: [] };
    const block = ['<enhanced_memory_recall>', ...enhancedMemoryRecallDescription, ...memories.map(m => [
        `  <memory_fragment turn="${xml(m.turn)}" similarity="${(m.score * 100).toFixed(1)}%">`,
        `    <user_input>${xml(m.userText)}</user_input>`, `    <summary>${xml(m.summary)}</summary>`, '  </memory_fragment>',
    ].join('\n')), '</enhanced_memory_recall>'].join('\n');
    return { messages: messages.map((m, i) => i === index ? { ...m, content: `${m.content}\n\n${block}` } : m), used: memories };
}

function mergeHistory(history) {
    const entries = [];
    for (const [index, message] of history.entries()) {
        const ids = Array.isArray(message.__memorySourceIds) ? message.__memorySourceIds.filter(Boolean) : message.id ? [message.id] : [];
        const previous = entries.at(-1);
        const mergeable = plain(message) && ['user', 'assistant'].includes(message.role)
            && !message._preventContextMerge && previous?.mergeable && previous.role === message.role;
        if (mergeable) {
            previous.content = [previous.content, message.content].filter(Boolean).join('\n\n');
            previous.ids.push(...ids);
            previous.known &&= ids.length > 0;
            previous.originalIndexes.push(index);
            continue;
        }
        entries.push({ message: { ...message }, role: message.role, content: message.content, ids, known: ids.length > 0,
            originalIndexes: [index], mergeable: plain(message) && ['user', 'assistant'].includes(message.role) && !message._preventContextMerge });
    }
    return entries;
}

function conversationTurns(entries) {
    const turns = [];
    let pending = null;
    for (const entry of entries) {
        if (entry.role === 'user' && entry.mergeable) { pending = entry; continue; }
        if (entry.role !== 'assistant' || !entry.mergeable || !pending) {
            pending = null;
            continue;
        }
        turns.push({ number: turns.length + 1, user: pending, assistant: entry });
        pending = null;
    }
    return turns;
}

function memoryTurns(memory, turns, sourceById) {
    const assistantIds = new Set(memory.sourceAssistantIds?.length ? memory.sourceAssistantIds
        : (memory.ids || []).filter(id => sourceById.get(id)?.role === 'assistant'));
    return turns.filter(turn => turn.assistant.ids.length && turn.assistant.ids.every(id => assistantIds.has(id)));
}

// Mirrors the postprocessed history: recent merged floors remain raw, while
// older matching assistant floors receive their summaries.
export function compressHistory(history, source, plan = {}, keep, preserveRaw = false) {
    const entries = mergeHistory(history), turns = conversationTurns(entries);
    const sourceById = new Map(source.map(message => [message.id, message]));
    // Every non-system postprocessed floor counts, including tool and media
    // messages. Only user/assistant floors can be replaced by a memory.
    const contextEntries = entries.filter(entry => entry.role !== 'system');
    const contextIndex = new Map(contextEntries.map((entry, index) => [entry, index]));
    const candidateCount = Math.max(0, contextEntries.length - Number(keep || 0));
    const safe = entry => entry.known && entry.ids.every(id => sourceById.has(id) && !sourceById.get(id).blocked && !sourceById.get(id).protected);
    const eligible = turn => contextIndex.get(turn.assistant) < candidateCount && safe(turn.assistant);
    const groups = (plan.groups || []).filter(memory => memory.enabled !== false);
    const covered = new Set((plan.groups || []).flatMap(memory => memory.children || []));
    const summaries = (plan.summaries || []).filter(memory => memory.enabled !== false && !covered.has(memory.id));
    const replacements = new Map(), removed = new Set(), used = [];

    for (const memory of [...groups].sort((a, b) => Number(a.turn) - Number(b.turn))) {
        const matched = memoryTurns(memory, turns, sourceById).filter(turn => eligible(turn) && safe(turn.user));
        if (!matched.length) continue;
        const retained = matched.at(-1);
        for (const turn of matched) {
            if (turn !== retained) { removed.add(turn.user); removed.add(turn.assistant); }
        }
        replacements.set(retained.user, {
            ...retained.user.message, role: 'user', content: `总结记忆 第 ${memory.turn}-${memory.end} 轮`,
            __memorySourceIds: [], _sourceIndexes: [], _preventContextMerge: true,
        });
        replacements.set(retained.assistant, {
            ...retained.assistant.message, role: 'assistant', content: memory.summary,
            __memorySourceIds: [], _sourceIndexes: [],
        });
        used.push(memory);
    }

    for (const memory of [...summaries].sort((a, b) => Number(a.turn) - Number(b.turn))) {
        const turn = memoryTurns(memory, turns, sourceById).find(eligible);
        if (!turn || replacements.has(turn.assistant) || removed.has(turn.assistant)) continue;
        replacements.set(turn.assistant, { ...turn.assistant.message, content: memory.summary, __memorySourceIds: [], _sourceIndexes: [] });
        used.push(memory);
    }

    const messages = [];
    for (const entry of entries) {
        if (removed.has(entry)) continue;
        const replacement = replacements.get(entry);
        if (replacement) messages.push(replacement);
        else if (preserveRaw) messages.push(...entry.originalIndexes.map(index => history[index]));
        else messages.push({ ...entry.message, content: entry.content });
    }
    return { messages, used };
}

// Fallback for requests that did not pass through the normal ST history hook.
export async function buildPrompt(messages, source, prepared, plan, config, count, promptLimit, tools = []) {
    if (messages.some(m => Array.isArray(m.content))) return { messages, used: [], reason: '本轮含多媒体，保留原请求' };
    const rendered = new Map(prepared.filter(m => (m.extra?.[KEY] ?? m.extra?.rph_memory)?.id).map(m => [(m.extra[KEY] ?? m.extra.rph_memory).id, m.mes]));
    const candidates = source.map(m => ({ ...m, text: rendered.get(m.id) ?? m.text }));
    const history = messages.map(m => {
        const found = candidates.filter(s => plain(m) && m.role === s.role && [s.text, `${s.name}: ${s.text}`].includes(m.content));
        const unique = found.length === 1 && messages.filter(p => p.role === m.role && p.content === m.content).length === 1;
        return unique ? { ...m, id: found[0].id } : { ...m };
    });
    const compressed = compressHistory(history, source, plan, config.keep, true);
    const output = compressed.messages.map(({ id, __memorySourceIds, _sourceIndexes, _preventContextMerge, origin, ...m }) => m);
    const recall = appendRecall(output, plan.recall);
    const used = [...compressed.used, ...recall.used];
    if (count && Number.isFinite(promptLimit)) {
        const tokens = await count(JSON.stringify({ messages: recall.messages, tools }));
        if (!Number.isFinite(tokens)) throw new Error('Token 计数失败');
        if (tokens > promptLimit) throw new Error('完整记忆超过当前上下文容量，请提高上下文上限；未截掉记忆');
    }
    return { messages: recall.messages, used: used.map(m => ({ ...m, why: m.why || ['脉络总结'] })), reason: used.length ? `本轮使用 ${used.length} 条记忆` : '本轮保留原文，暂无可替换的记忆' };
}
