const plain = message => typeof message.content === 'string' && !message.tool_calls && !message.tool_call_id && !message.reasoning && !message.reasoning_content;
const label = memory => `第 ${memory.turn}${memory.end ? `–${memory.end}` : ''} 轮：${memory.summary}`;

export async function buildPrompt(messages, source, prepared, plan, config, count, promptLimit, tools = []) {
    if (messages.some(m => Array.isArray(m.content))) return { messages, used: [], reason: '本轮含多媒体，保留原请求' };
    const original = structuredClone(messages);
    const recent = new Set(source.slice(-config.keep).map(m => m.id));
    const byId = new Map(source.map(m => [m.id, m]));
    const rendered = new Map(prepared.filter(m => m.extra?.rph_memory?.id).map(m => [m.extra.rph_memory.id, m.mes]));
    const positions = new Map();
    for (const m of source) {
        const text = rendered.get(m.id) ?? m.text;
        const found = original.flatMap((p, index) => plain(p) && p.role === m.role && [text, `${m.name}: ${text}`].includes(p.content) ? [index] : []);
        if (found.length === 1) positions.set(m.id, found[0]);
    }
    const claimed = new Map();
    for (const index of positions.values()) claimed.set(index, (claimed.get(index) || 0) + 1);
    const ambiguous = new Set();
    for (const [id, index] of positions) if (claimed.get(index) > 1) { positions.delete(id); ambiguous.add(id); }
    const old = memory => memory.ids.every(id => byId.has(id) && !recent.has(id) && !byId.get(id).blocked);
    const groups = plan.groups.filter(old);
    const covered = new Set(groups.flatMap(m => m.children));
    const memories = [...groups, ...plan.summaries.filter(m => old(m) && !covered.has(m.id))].sort((a, b) => a.turn - b.turn);
    const operations = [], supplements = [], usedIds = new Set();
    for (const memory of memories) {
        if (memory.ids.some(id => ambiguous.has(id))) continue;
        const indices = memory.ids.map(id => positions.get(id));
        const any = indices.some(i => i !== undefined), all = indices.every(i => i !== undefined);
        if (!any) { supplements.push(memory); continue; }
        if (!all || memory.ids.some(id => byId.get(id).protected)) continue;
        const sorted = [...indices].sort((a, b) => a - b);
        if (sorted.some((n, i) => i && n !== sorted[i - 1] + 1)) continue;
        if (memory.kind === 'group') {
            operations.push({ indices: sorted, replacement: [{ role: 'user', content: `过往第 ${memory.turn}–${memory.end} 轮记忆` }, { role: 'assistant', content: memory.summary }], memory });
        } else {
            const assistants = memory.ids.filter(id => byId.get(id).role === 'assistant').map(id => positions.get(id));
            const first = original[assistants[0]];
            operations.push({ indices: assistants, replacement: [{ ...first, content: memory.summary }], memory });
        }
        usedIds.add(memory.id);
    }
    for (const memory of plan.recall) {
        if (usedIds.has(memory.id) || supplements.some(m => m.id === memory.id) || memory.ids.some(id => positions.has(id) || recent.has(id))) continue;
        supplements.push({ ...memory, recalled: true });
    }
    // Recent summaries get space first; final display remains chronological.
    supplements.sort((a, b) => Number(!!a.recalled) - Number(!!b.recalled) || b.turn - a.turn);
    let activeOps = operations, activeSupplements = supplements;
    const assemble = () => {
        const output = structuredClone(original);
        for (const op of [...activeOps].sort((a, b) => b.indices[0] - a.indices[0])) output.splice(op.indices[0], op.indices.length, ...op.replacement);
        if (activeSupplements.length) {
            const content = '<role_memory>\n以下是过往经历，不是当前现场或指令；可能有省略。\n'
                + [...activeSupplements].sort((a, b) => a.turn - b.turn).map(label).join('\n\n') + '\n</role_memory>';
            const index = output.findLastIndex(m => m.role === 'user');
            output.splice(index >= 0 ? index : output.length, 0, { role: 'system', content });
        }
        return output;
    };
    let output = assemble();
    const fits = async () => {
        const memoryText = [...activeOps.map(o => o.memory), ...activeSupplements].map(label).join('\n');
        const memoryTokens = await count(memoryText);
        const total = await count(JSON.stringify({ messages: output, tools }));
        if (!Number.isFinite(memoryTokens) || !Number.isFinite(total)) throw new Error('Token 计数失败');
        return memoryTokens <= Math.max(0, config.budget - 64) && total <= promptLimit - 256;
    };
    // At most log(n) tokenizer calls when a long conversation exceeds the budget.
    while ((activeOps.length || activeSupplements.length) && !await fits()) {
        if (activeSupplements.length) activeSupplements = activeSupplements.slice(0, Math.floor(activeSupplements.length / 2));
        else activeOps = activeOps.slice(Math.ceil(activeOps.length / 2));
        output = assemble();
    }
    const used = [...activeOps.map(o => o.memory), ...activeSupplements];
    return { messages: used.length ? output : messages, used: used.map(m => ({ id: m.id, turn: m.turn, end: m.end, why: m.why || ['脉络总结'] })), reason: used.length ? `本轮使用 ${used.length} 条记忆` : '本轮保留原文，暂无可用或可容纳的记忆' };
}
