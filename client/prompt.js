import { enhancedMemoryRecallDescription } from '../shared/summary-prompts.js';
import { KEY, cleanText, stripCitations } from '../shared/model.js';

const plain = message => typeof message.content === 'string' && !message.tool_calls && !message.tool_call_id && !message.reasoning && !message.reasoning_content;
const xml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const memoryIds = memory => memory.ids?.length ? memory.ids : [...memory.sourceUserIds || [], ...memory.sourceAssistantIds || []];
const memoryText = (memory, cite) => `${cite && Number.isSafeInteger(memory.no) ? `[M${memory.no}] ` : ''}${memory.summary}`;

export function appendRecall(messages, memories, cite = false) {
    if (!memories.length) return { messages, used: [] };
    const block = ['<enhanced_memory_recall>', ...enhancedMemoryRecallDescription, ...memories.map(m => [
        `  <memory_fragment${cite && Number.isSafeInteger(m.no) ? ` id="M${m.no}"` : ''} turn="${xml(m.turn)}"${Number.isFinite(m.score) ? ` similarity="${(m.score * 100).toFixed(1)}%"` : ''}>`,
        `    <user_input>${xml(m.userText)}</user_input>`, `    <summary>${xml(m.summary)}</summary>`, '  </memory_fragment>',
    ].join('\n')), '</enhanced_memory_recall>'].join('\n');
    const put = (index, content) => ({ messages: messages.map((m, i) => i === index ? { ...m, content } : m), used: memories });
    // The input obfuscation extension moves the newest input into a tool result; the recalled memories go with it.
    const moved = messages.findLastIndex(m => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('"source":"user_input"'));
    if (moved >= 0) try {
        const result = JSON.parse(messages[moved].content);
        if (typeof result.text === 'string') return put(moved, JSON.stringify({ ...result, text: `${result.text}\n\n${block}` }));
    } catch { /* another tool's result */ }
    const index = messages.findLastIndex(m => m.role === 'user' && !m.tool_calls && !m.tool_call_id && (typeof m.content === 'string' || Array.isArray(m.content)));
    if (index < 0) return { messages, used: [] };
    if (Array.isArray(messages[index].content)) return put(index, [...messages[index].content, { type: 'text', text: `\n\n${block}` }]);
    return put(index, `${messages[index].content}\n\n${block}`);
}

export function appendCitationInstruction(messages, used, enabled) {
    if (!enabled || !used.some(memory => Number.isSafeInteger(memory.no))) return messages;
    const instruction = { role: 'system', content: '<memory_citation>带 [M编号] 的总结和带 id="M编号" 的召回片段是历史记忆。正文承接其中的事件、约定或关系时，可在对应句末标注 [M编号]，同一编号每次回复只标一次。只引用本次上下文实际提供的编号，不编造，不为无关句子标注。标注后继续正常叙事。</memory_citation>' };
    const index = messages.findIndex(message => message.role !== 'system');
    return [...messages.slice(0, index < 0 ? messages.length : index), instruction, ...messages.slice(index < 0 ? messages.length : index)];
}

export async function checkPromptSize(messages, tools, count, limit) {
    if (!count || !Number.isFinite(limit)) return;
    const tokens = await count(JSON.stringify({ messages, tools }));
    if (!Number.isFinite(tokens)) throw new Error('Token 计数失败');
    if (tokens > limit) throw new Error('完整记忆超过当前上下文容量，请提高上下文上限；未截掉记忆');
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

function insertBySource(messages, source, records, anchorMap) {
    if (!records.length) return messages;
    const positions = new Map(source.map((m, index) => [m.id, index]));
    const anchors = messages.map(m => (anchorMap?.get(m) || (m.__memorySourceIds?.length ? m.__memorySourceIds : m.id ? [m.id] : [])).map(id => positions.get(id)).filter(index => index !== undefined));
    const insertions = new Map();
    const positioned = records.map(record => {
        const pos = record.ids.map(id => positions.get(id)).filter(index => index !== undefined);
        return { ...record, end: pos.length ? Math.max(...pos) : -1 };
    }).filter(record => record.end >= 0).sort((a, b) => a.end - b.end);
    for (const { end, items } of positioned) {
        let index = anchors.findIndex(ids => ids.some(position => position > end));
        if (index < 0) {
            const previous = anchors.findLastIndex(ids => ids.some(position => position <= end));
            index = previous >= 0 ? previous + 1 : messages.findLastIndex(m => m.role === 'user');
            if (index < 0) index = messages.findIndex(m => m.role !== 'system');
            if (index < 0) index = messages.length;
        }
        insertions.set(index, [...insertions.get(index) || [], ...items]);
    }
    return messages.flatMap((m, index) => [...insertions.get(index) || [], m]).concat(insertions.get(messages.length) || []);
}

// Mirrors the postprocessed history: recent merged floors remain raw, while
// older matching assistant floors receive their summaries.
export function compressHistory(history, source, plan = {}, keep, preserveRaw = false, cite = false) {
    history = history.map(m => m.role === 'assistant' && typeof m.content === 'string' && !m.tool_calls && /\[M[1-9]\d*\]/.test(m.content) ? { ...m, content: stripCitations(m.content) } : m);
    const entries = mergeHistory(history), turns = conversationTurns(entries);
    const sourceById = new Map(source.map(message => [message.id, message]));
    // Every non-system postprocessed floor counts, including tool and media
    // messages. Only user/assistant floors can be replaced by a memory.
    const contextEntries = entries.filter(entry => entry.role !== 'system');
    const contextIndex = new Map(contextEntries.map((entry, index) => [entry, index]));
    const candidateCount = Math.max(0, contextEntries.length - Number(keep || 0));
    const safe = entry => entry.known && entry.ids.every(id => sourceById.has(id) && !sourceById.get(id).protected);
    // A reply that the user's own regexes have emptied for the prompt gets its summary wherever it is.
    const eligible = turn => (contextIndex.get(turn.assistant) < candidateCount || !turn.assistant.content.trim()) && safe(turn.assistant);
    const groups = (plan.groups || []).filter(memory => memory.enabled !== false);
    const covered = new Set((plan.groups || []).flatMap(memory => memory.children || []));
    const summaries = (plan.summaries || []).filter(memory => memory.enabled !== false && !covered.has(memory.id));
    const isGroup = memory => memory.kind === 'group' || !!memory.end;
    const summaryUserIds = memory => memory.sourceUserIds?.length ? memory.sourceUserIds
        : (memory.ids || []).filter(id => sourceById.get(id)?.role === 'user');
    const summaryAssistantIds = memory => memory.sourceAssistantIds?.length ? memory.sourceAssistantIds
        : (memory.ids || []).filter(id => sourceById.get(id)?.role === 'assistant');
    // For unmerged summaries, only a hidden assistant triggers hidden insertion; if the assistant is still visible
    // (e.g. protected attachment), we never duplicate it with its summary.
    const hasHiddenSource = memory => isGroup(memory)
        ? memoryIds(memory).some(id => sourceById.get(id)?.hidden)
        : summaryAssistantIds(memory).some(id => sourceById.get(id)?.hidden);
    const hidden = [...groups, ...summaries].filter(memory => hasHiddenSource(memory) && memoryIds(memory).every(id => {
        const message = sourceById.get(id);
        return message && message.role !== 'system';
    }));
    const replacements = new Map(), removed = new Set(), anchorMap = new WeakMap(), used = [];

    for (const memory of groups.filter(memory => !hasHiddenSource(memory)).sort((a, b) => Number(a.turn) - Number(b.turn))) {
        const matched = memoryTurns(memory, turns, sourceById).filter(turn => eligible(turn) && safe(turn.user));
        if (!matched.length) continue;
        const retained = matched.at(-1);
        for (const turn of matched) {
            if (turn !== retained) { removed.add(turn.user); removed.add(turn.assistant); }
        }
        const userReplacement = {
            ...retained.user.message, role: 'user', content: `总结记忆 第 ${memory.turn}-${memory.end} 轮`,
            __memorySourceIds: [], _sourceIndexes: [], _preventContextMerge: true,
        };
        const assistantReplacement = {
            ...retained.assistant.message, role: 'assistant', content: memoryText(memory, cite),
            __memorySourceIds: [], _sourceIndexes: [],
        };
        anchorMap.set(userReplacement, retained.user.ids);
        anchorMap.set(assistantReplacement, retained.assistant.ids);
        replacements.set(retained.user, userReplacement);
        replacements.set(retained.assistant, assistantReplacement);
        used.push(memory);
    }

    for (const memory of summaries.filter(memory => !hasHiddenSource(memory)).sort((a, b) => Number(a.turn) - Number(b.turn))) {
        const turn = memoryTurns(memory, turns, sourceById).find(eligible);
        if (!turn || replacements.has(turn.assistant) || removed.has(turn.assistant)) continue;
        const assistantReplacement = { ...turn.assistant.message, content: memoryText(memory, cite), __memorySourceIds: [], _sourceIndexes: [] };
        anchorMap.set(assistantReplacement, turn.assistant.ids);
        replacements.set(turn.assistant, assistantReplacement);
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

    // Restore each plugin auto-hidden user message of active unmerged summaries after visible merging/group removal,
    // so restored inputs never merge into or get deleted by an adjacent visible merged group, and empty views are skipped.
    const sentIds = new Set(messages.flatMap(m => anchorMap.has(m) ? [] : (m.__memorySourceIds?.length ? m.__memorySourceIds : m.id ? [m.id] : [])));
    const records = [], restoredUserIds = new Set();
    for (const memory of summaries) {
        for (const uid of summaryUserIds(memory)) {
            const msg = sourceById.get(uid);
            if (!msg || msg.role !== 'user' || !msg.hidden || !msg.autoHidden || sentIds.has(uid) || restoredUserIds.has(uid)) continue;
            const text = cleanText(msg.view ?? msg.text);
            if (!text) continue;
            restoredUserIds.add(uid);
            records.push({ ids: [uid], items: [{ role: 'user', content: text, _preventContextMerge: true }] });
        }
    }
    for (const memory of hidden) {
        const hasUser = !isGroup(memory) && summaryUserIds(memory).some(uid => sentIds.has(uid) || restoredUserIds.has(uid));
        const assistantIds = summaryAssistantIds(memory);
        const marker = { role: 'user', content: `总结记忆 第 ${memory.turn}${isGroup(memory) ? `-${memory.end}` : ''} 轮`, _preventContextMerge: true };
        records.push({
            ids: hasUser && assistantIds.length ? assistantIds : memoryIds(memory),
            items: [...(hasUser ? [] : [marker]), { role: 'assistant', content: memoryText(memory, cite) }],
        });
    }
    return { messages: insertBySource(messages, source, records, anchorMap), used: [...used, ...hidden] };
}

// Fallback for requests that did not pass through the normal ST history hook.
export async function buildPrompt(messages, source, prepared, plan, config, count, promptLimit, tools = []) {
    const rendered = new Map(prepared.filter(m => (m.extra?.[KEY] ?? m.extra?.rph_memory)?.id).map(m => [(m.extra[KEY] ?? m.extra.rph_memory).id, m.mes]));
    const candidates = source.filter(m => !m.hidden).map(m => ({ ...m, text: rendered.get(m.id) ?? m.text }));
    const history = messages.map(m => {
        const found = candidates.filter(s => plain(m) && m.role === s.role && [s.text, `${s.name}: ${s.text}`].includes(m.content));
        const unique = found.length === 1 && messages.filter(p => p.role === m.role && p.content === m.content).length === 1;
        return unique ? { ...m, id: found[0].id } : { ...m };
    });
    const compressed = compressHistory(history, source, plan, config.keep, true, config.citations);
    const output = compressed.messages.map(({ id, __memorySourceIds, _sourceIndexes, _preventContextMerge, origin, ...m }) => m);
    const recall = appendRecall(output, plan.recall || [], config.citations);
    const used = [...compressed.used, ...recall.used];
    const result = appendCitationInstruction(recall.messages, used, config.citations);
    await checkPromptSize(result, tools, count, promptLimit);
    return { messages: result, used: used.map(m => ({ ...m, why: m.why || ['脉络总结'] })), reason: used.length ? `本轮使用 ${used.length} 条记忆` : '本轮保留原文，暂无可替换的记忆' };
}
