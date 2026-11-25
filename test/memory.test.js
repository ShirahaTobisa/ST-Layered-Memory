import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store, scopeId, sourceTurns } from '../server/store.js';
import { registerRoutes } from '../server/routes.js';
import { Engine } from '../server/engine.js';
import { Providers, configure, publicConfig, vectorSignature, summaryMessages, hash } from '../server/providers.js';
import { recall, rawSearch, cosine, packEmbedding } from '../server/search.js';
import { buildClassicSummarySystemPrompt, buildClassicSummaryFinalInstruction, buildClassicSecondarySummaryPrompt, enhancedMemoryRecallDescription } from '../shared/summary-prompts.js';
import { turnsFrom, sourceData, cleanText, roleText, DEFAULTS } from '../shared/model.js';
import { appendRecall, buildPrompt, compressHistory } from '../client/prompt.js';

const scope = { actor: 'character:alice.png', chat: 'story', lineage: 'lineage-a' };
const config = { summary: { url: 'http://model.local/v1', model: 'summary', key: 'private-test' } };
const messages = count => Array.from({ length: count }, (_, i) => [
    { id: `u${i}`, role: 'user', name: '用户', text: `用户问题 ${i}`, swipe: 0 },
    { id: `a${i}`, role: 'assistant', name: '角色', text: `角色经历 ${i}`, swipe: 0 },
]).flat();
function fixture(t) {
    const directory = fs.mkdtempSync(path.resolve('test-output/store-'));
    const filename = path.join(directory, 'memory.sqlite');
    const store = new Store(filename); store.setConfig(config);
    t.after(() => { if (store.db.isOpen) store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    return { store, filename };
}
fs.mkdirSync('test-output', { recursive: true });
async function settle(engine) {
    engine.wake();
    for (let i = 0; i < 200; i++) {
        if (!engine.active.size && !engine.store.db.prepare("SELECT id FROM jobs WHERE status='queued' LIMIT 1").get()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Engine did not settle');
}
const provider = { summarize: async (_, input) => `总结 ${input.kind} ${input.memory.turn}`, embed: async (_, texts) => texts.map(() => [1, 0, 0]) };

test('turns preserve speaker identity, adjacent user input, greeting and incomplete exclusion', () => {
    const data = [{ id: 'hello', role: 'assistant', text: '开场' }, ...messages(2)];
    data.splice(2, 0, { id: 'user-extra', role: 'user', name: '用户', text: '补充' });
    data.splice(4, 0, { id: 'second', role: 'assistant', name: '另一角色', text: '插话', blocked: true });
    data.push({ id: 'pending', role: 'user', text: '下一句' });
    const turns = turnsFrom(data);
    assert.equal(turns.length, 2); assert.equal(turns[0].user.length, 2); assert.equal(turns[0].assistant.length, 2);
    assert.equal(turns[0].eligible, false); assert.match(roleText(turns[0].assistant), /另一角色/);
});

test('durable handoff deduplicates retries, applies summaries and preserves raw snapshots', async t => {
    const { store } = fixture(t), original = messages(2);
    const state = store.sync(scope, original, null), id = scopeId(scope);
    assert.equal(state.counts.queued, 2);
    store.sync(scope, original, null);
    assert.equal(store.state(id).counts.queued, 2);
    let calls = 0;
    const engine = new Engine(store, { ...provider, summarize: async (...args) => { calls++; return provider.summarize(...args); } });
    await settle(engine);
    assert.equal(calls, 2); assert.equal(store.memories(id).length, 2);
    store.sync(scope, original, state.revision); await settle(engine);
    assert.equal(calls, 2); assert.deepEqual(store.chat(id).messages.map(m => m.text), original.map(m => m.text));
});

test('changed/swiped/deleted sources invalidate only their own summaries; stale pages conflict', async t => {
    const { store } = fixture(t), id = scopeId(scope), data = messages(7);
    const first = store.sync(scope, data, null); await settle(new Engine(store, provider));
    data[1].text = '改变剧情'; data[1].swipe = 1;
    const second = store.sync(scope, data, first.revision);
    assert.equal(store.memories(id).filter(m => m.kind === 'summary').length, 6);
    await settle(new Engine(store, provider));
    assert.equal(store.memories(id).filter(m => m.kind === 'summary').length, 7);
    assert.throws(() => store.sync(scope, messages(7), first.revision), error => error.status === 409);
    const oldIds = new Set(data.slice(-2).map(m => m.id));
    store.sync(scope, data.slice(0, -2), second.revision);
    assert.ok(store.memories(id).every(m => m.ids.every(id => !oldIds.has(id))));
});

test('obsolete model results cannot overwrite edited chat or stopped work', async t => {
    for (const stop of [false, true]) {
        const { store } = fixture(t), id = scopeId(scope), data = messages(1);
        let release;
        const engine = new Engine(store, { summarize: () => new Promise(resolve => { release = resolve; }) });
        const state = store.sync(scope, data, null); engine.wake();
        if (stop) store.pause(id, true);
        else { data[1].text = '新版'; store.sync(scope, data, state.revision); store.pause(id, true); }
        engine.wake(); release('过期总结'); await settle(engine);
        assert.equal(store.memories(id).length, 0);
    }
});

test('persistent storage failure stops the worker without pretending a summary was saved', async t => {
    const { store } = fixture(t), id = scopeId(scope);
    store.setConfig({ concurrency: 1 }); store.sync(scope, messages(1), null);
    store.put = () => { throw new Error('simulated disk failure'); };
    const engine = new Engine(store, provider); engine.wake();
    await Promise.allSettled([...engine.active.values()].map(task => task.promise));
    assert.match(engine.fault, /存储写入失败/);
    assert.equal(store.memories(id).length, 0);
    assert.equal(store.state(id).counts.done, undefined);
});

test('server restart requeues in-flight tasks without requiring an open page', async t => {
    const { store, filename } = fixture(t); store.sync(scope, messages(2), null);
    store.db.prepare("UPDATE jobs SET status='running',lease='old'").run(); store.close();
    const resumed = new Store(filename);
    const engine = new Engine(resumed, provider); await settle(engine);
    assert.equal(resumed.memories(scopeId(scope)).length, 2);
    assert.equal(resumed.state(scopeId(scope)).counts.done, 2);
    resumed.close();
});

test('v0.1 database upgrade preserves edited summaries, disabled merged memories and a recovery copy', async t => {
    const { store, filename } = fixture(t), id = scopeId(scope), data = messages(31);
    data[5].text = '';
    store.sync(scope, data, null); await settle(new Engine(store, provider));
    const turns = sourceTurns(store.chat(id).messages);
    const oldSummaries = store.memories(id).filter(m => m.kind === 'summary').map(memory => {
        const index = memory.turn - 1, turn = turns[index];
        const { sourceUserIds, sourceAssistantIds, recipe, no, ...old } = memory;
        return { ...old, id: hash(turn.ids), sourceHash: hash(turns.slice(Math.max(0, index - 3), index + 1).map(sourceData)),
            ...(index === 0 ? { summary: '旧版手动编辑必须保留', edited: true } : {}) };
    });
    const oldChildren = oldSummaries.filter(memory => memory.turn <= 5).sort((a, b) => a.turn - b.turn), ids = data.slice(0, 10).map(m => m.id);
    store.clear(id);
    for (const memory of oldSummaries) store.put(id, memory);
    store.put(id, { id: hash(ids), kind: 'group', turn: 1, end: 5, ids, children: oldChildren.map(m => m.id), sourceHash: hash(oldChildren.map(m => [m.id, m.summary, m.enabled])), summary: '旧版合并手动编辑', enabled: false, edited: true });
    const { version, ...oldConfig } = store.config;
    store.db.prepare('UPDATE config SET data=? WHERE id=1').run(JSON.stringify(oldConfig));
    store.close();
    const upgraded = new Store(filename);
    const memories = upgraded.memories(id), first = memories.find(m => m.id === turns[0].key), group = memories.find(m => m.kind === 'group');
    assert.equal(first.summary, '旧版手动编辑必须保留'); assert.equal(first.sourceHash, turns[0].sourceHash);
    assert.equal(group.summary, '旧版合并手动编辑'); assert.equal(group.enabled, false);
    assert.ok(group.children.every(key => memories.some(m => m.id === key)));
    upgraded.pause(id, false); await settle(new Engine(upgraded, { ...provider, summarize: async () => { throw new Error('upgrade must not regenerate saved memories'); } }));
    assert.equal(upgraded.memories(id).length, 31); assert.equal(upgraded.state(id).counts.error || 0, 0);
    assert.equal(upgraded.state(id).legacy, 29);
    const backup = JSON.parse(fs.readFileSync(`${filename}.v1-memory-backup.json`, 'utf8'));
    assert.equal(backup.chats[0].memories.length, 31);
    assert.ok(!JSON.stringify(backup).includes('private-test'));
    upgraded.close();
    const reopened = new Store(filename); assert.equal(reopened.memories(id).length, 31); reopened.close();
});

test('five-turn compaction skips empty turns, retains all valid per-turn sources and allows retry', async t => {
    const { store } = fixture(t), data = messages(31), id = scopeId(scope);
    data[5].text = '';
    store.sync(scope, data, null); const engine = new Engine(store, provider); await settle(engine);
    const memories = store.memories(id), group = memories.find(m => m.kind === 'group');
    assert.equal(memories.filter(m => m.kind === 'summary').length, 30);
    assert.equal(group.children.length, 4); assert.equal(group.turn, 1); assert.equal(group.end, 5);
    store.retry(id, group.id); await settle(engine);
    assert.ok(store.memories(id).some(m => m.id === group.id));
    store.edit(id, group.children[0], { summary: '人工纠正' });
    assert.ok(!store.memories(id).some(m => m.id === group.id));
});

test('branches reuse exact target sources only; unrelated imports do not inherit memories', async t => {
    const { store } = fixture(t); store.sync(scope, messages(5), null); await settle(new Engine(store, provider));
    const branch = { ...scope, chat: 'branch' };
    store.sync(branch, messages(3), null, scope.chat); assert.equal(store.memories(scopeId(branch)).length, 3);
    const imported = messages(3).map(m => ({ ...m, id: `import-${m.id}` }));
    const other = { ...scope, chat: 'import' }; store.sync(other, imported, null);
    assert.equal(store.memories(scopeId(other)).length, 0);
});

test('embedding failure retains summaries; switching embedding config never resummarizes', async t => {
    const { store } = fixture(t), id = scopeId(scope);
    store.setConfig({ mode: 'enhanced', embedding: { url: 'http://model.local/v1', model: 'embed', dimensions: 3 } });
    store.sync(scope, messages(1), null);
    let summaries = 0;
    const engine = new Engine(store, { summarize: async () => { summaries++; return '记忆'; }, embed: async () => { throw new Error('嵌入失败'); } });
    await settle(engine);
    assert.equal(store.memories(id).length, 1); assert.equal(store.state(id).counts.error, 1);
    store.setConfig({ embedding: { model: 'new-embed' } }); engine.providers = provider; await settle(engine);
    assert.equal(summaries, 1); assert.equal(store.memories(id)[0].vectorSignature, vectorSignature(store.config));
});

test('separate user stores do not share snapshots, keys, or task results', t => {
    const a = fixture(t).store, b = fixture(t).store;
    a.sync(scope, messages(1), null);
    assert.equal(b.chat(scopeId(scope)), null); assert.equal(b.memories(scopeId(scope)).length, 0);
    const visible = JSON.stringify(publicConfig(a.config));
    assert.ok(!visible.includes('private-test')); assert.ok(!visible.includes('"key"'));
    assert.equal(publicConfig(a.config).summary.hasKey, true);
});

test('provider accepts complete text with optional finish metadata, rejects malformed embeddings and invalid model URLs', async () => {
    for (const finish of ['stop', undefined]) {
        const p = new Providers(async () => Response.json({ choices: [{ message: { content: '半截' }, finish_reason: finish }] }));
        assert.equal(await p.summarize(config, { kind: 'summary', memory: { turn: 1 }, contextTurns: [{ number: 1, user: '问题', assistant: '回复' }] }), '半截');
    }
    const empty = new Providers(async () => Response.json({ choices: [{ message: { content: '' } }] }));
    await assert.rejects(empty.summarize(config, { kind: 'summary', memory: { turn: 1 }, contextTurns: [{ number: 1, user: '问题', assistant: '回复' }] }), /有效正文/);
    const p = new Providers(async () => Response.json({ data: [{ index: 0, embedding: [1, 2] }, { index: 0, embedding: [1, 2] }] }));
    await assert.rejects(p.embed({ embedding: { url: 'http://local/v1', model: 'e' } }, ['a', 'b']), /无效/);
    assert.throws(() => configure({ summary: { url: 'file:///private' } }));
    assert.equal(cosine([1, 0], [1, 0, 0]), -1);
});

test('fixture output matches postprocessed replacement positions', () => {
    const fixtureData = JSON.parse(fs.readFileSync(path.join('test', 'fixtures', 'history-replacement.json'), 'utf8'));
    for (const item of fixtureData.cases) {
        const source = item.chat.map(message => ({ id: message.id, role: message.role, name: message.name, text: message.content }));
        const summaries = item.memories.map(memory => ({
            id: memory.id, kind: 'summary', turn: memory.turn, summary: memory.summary,
            ids: [...memory.sourceUserIds, ...memory.sourceAssistantIds],
            sourceUserIds: memory.sourceUserIds, sourceAssistantIds: memory.sourceAssistantIds,
            enabled: memory.enabled
        }));
        const groups = item.groups.map(memory => ({
            id: memory.id, kind: 'group', turn: memory.turnStart, end: memory.turnEnd,
            summary: memory.summary, enabled: memory.enabled, children: memory.sourceMemories.map(child => child.id),
            ids: [...memory.sourceUserIds, ...memory.sourceAssistantIds],
            sourceUserIds: memory.sourceUserIds, sourceAssistantIds: memory.sourceAssistantIds
        }));
        const result = compressHistory(
            item.chat.map(message => ({ role: message.role, content: message.content, id: message.id, name: message.name })),
            source, { summaries, groups, recall: [] }, item.keep
        ).messages.map(({ id, name, __memorySourceIds, _sourceIndexes, _preventContextMerge, ...message }) => message);
        assert.deepEqual(result, item.expected, item.name);
    }
});

test('summary request layout and nonzero vector encoding are stable', () => {
    const fixtureData = JSON.parse(fs.readFileSync(path.join('test', 'fixtures', 'history-replacement.json'), 'utf8'));
    const names = { userName: '用户', characterName: '角色' };
    assert.match(buildClassicSummarySystemPrompt(names), /唯一总结目标/);
    assert.match(buildClassicSecondarySummaryPrompt({ ...names, startTurn: 1, endTurn: 5 }), /第 1–5 轮/);
    assert.equal(enhancedMemoryRecallDescription.length, 3);
    const request = summaryMessages({ kind: 'summary', names, memory: { turn: 4 }, contextTurns: [1, 2, 3, 4].map(number => ({ number, user: '问题', assistant: '回复' })) });
    assert.equal(request.length, 10);
    assert.match(request[1].content, /历史背景.*第 1 轮/);
    assert.match(request[7].content, /唯一总结目标.*第 4 轮/);
    assert.equal(request.at(-1).content, buildClassicSummaryFinalInstruction(4));
    for (const { vector, expected } of fixtureData.quantization.filter(item => item.vector.some(n => n !== 0))) assert.deepEqual(packEmbedding(vector), expected);
});

test('unknown sources and protected user attachments cannot be removed by a grouped memory', () => {
    const source = messages(3), history = source.map(m => ({ id: m.id, role: m.role, content: m.text }));
    source[0].protected = true;
    const group = { id: 'g', turn: 1, end: 2, summary: '合并', sourceAssistantIds: ['a0', 'a1'], children: [] };
    const result = compressHistory(history, source, { groups: [group] }, 2, true);
    assert.deepEqual(result.messages.slice(0, 2), history.slice(0, 2));
    const unknown = [...history.slice(0, 2), { role: 'assistant', content: '插件追加说明' }, ...history.slice(2)];
    const summary = { id: 's', turn: 1, summary: '不可替换', sourceAssistantIds: ['a0'] };
    assert.deepEqual(compressHistory(unknown, source, { summaries: [summary] }, 2, true).messages, unknown);
    assert.deepEqual(compressHistory(history.map(({ id, ...m }) => m), source, { summaries: [{ ...summary, sourceAssistantIds: undefined }] }, 2, true).used, []);
});

test('retrieval respects raw-window exclusion by default, supports including recent memories, and falls back on vector failure', async t => {
    const { store } = fixture(t), id = scopeId(scope), data = messages(3);
    data[1].text += '遗失钥匙藏在灯塔';
    store.setConfig({ mode: 'enhanced', embedding: { url: 'http://model.local/v1', model: 'embedding' } });
    store.sync(scope, data, null); await settle(new Engine(store, provider));
    const memories = store.memories(id);
    store.edit(id, memories[0].id, { summary: '约好明天去灯塔' });
    store.edit(id, memories[1].id, { summary: '灯塔的风很大' });
    await settle(new Engine(store, provider));
    // With default recallExcludeRaw=true, all 3 turns are in keep=20 raw window so recall does not duplicate them.
    assert.equal((await recall(store, id, '灯塔', provider)).memories.length, 0);
    store.setConfig({ recallExcludeRaw: false });
    const result = await recall(store, id, '灯塔', provider);
    assert.equal(result.memories.length, 3); assert.equal(result.memories.at(-1).turn, 3);
    const failed = await recall(store, id, '灯塔', { embed: async () => { throw new Error('failure'); } });
    // Embedding failure falls back to strict lexical matches with warning, while noisy queries stay empty.
    assert.equal(failed.memories.length, 2); assert.ok(failed.warnings.length);
    assert.ok(failed.memories.every(m => m.score === undefined && m.why.includes('关键词命中')));
    const failedNoMatch = await recall(store, id, '完全无关的查询词', { embed: async () => { throw new Error('failure'); } });
    assert.equal(failedNoMatch.memories.length, 0); assert.ok(failedNoMatch.warnings.length);
    assert.match(rawSearch(store.chat(id).messages, '钥匙')[0].text, /钥匙藏在灯塔/);
});

test('prompt replacement has no independent memory cap and leaves preset/tool messages intact', async () => {
    const source = messages(3), turns = sourceTurns(source);
    const summaries = turns.map(t => ({ id: t.key, kind: 'summary', turn: t.number, ids: t.ids, summary: `短总结 ${t.number}` }));
    const input = [{ role: 'system', content: '世界书与作者注释' }, ...source.map(m => ({ role: m.role, content: m.text })), { role: 'assistant', tool_calls: [{ id: 'tool-id' }], content: null }, { role: 'tool', tool_call_id: 'tool-id', content: 'result' }];
    const original = structuredClone(input);
    const result = await buildPrompt(input, source, [], { summaries, groups: [], recall: [] }, { ...DEFAULTS, keep: 2 }, async text => text.length, 10000);
    assert.equal(result.used.length, 3); assert.deepEqual(input, original);
    assert.equal(result.messages[0].content, '世界书与作者注释'); assert.equal(result.messages.at(-1).tool_call_id, 'tool-id');
    assert.equal(result.messages.at(-3).content, '短总结 3');
    const tiny = await buildPrompt(input, source, [], { summaries, groups: [], recall: [] }, { ...DEFAULTS, keep: 2, budget: 1 }, async text => text.length, 10000);
    assert.deepEqual(tiny.messages, result.messages); assert.equal(tiny.used.length, 3);
    await assert.rejects(buildPrompt(input, source, [], { summaries, groups: [], recall: [] }, { ...DEFAULTS, keep: 2 }, async text => text.length, 1), /超过当前上下文/);
});

test('ambiguous text, media and protected messages are never blindly replaced', async () => {
    const source = messages(2); source[1].protected = true;
    const turns = sourceTurns(source), memory = { id: turns[0].key, kind: 'summary', turn: 1, ids: turns[0].ids, summary: '替换' };
    const input = source.map(m => ({ role: m.role, content: m.text }));
    const args = [source, [], { summaries: [memory], groups: [], recall: [] }, { ...DEFAULTS, keep: 2 }, async text => text.length, 10000];
    assert.deepEqual((await buildPrompt(input, ...args)).messages, input);
    const media = [{ role: 'user', content: [{ type: 'image_url' }] }];
    assert.deepEqual((await buildPrompt(media, ...args)).messages, media);
});

test('a repeated old source cannot claim the single matching message left in the final request', async () => {
    const source = messages(3); source[0].text = source[2].text = '重复问题'; source[1].text = source[3].text = '重复回答';
    const turns = sourceTurns(source), summaries = turns.slice(0, 2).map(t => ({ id: t.key, kind: 'summary', turn: t.number, ids: t.ids, summary: `不能套错 ${t.number}` }));
    const input = source.slice(2).map(m => ({ role: m.role, content: m.text }));
    const result = await buildPrompt(input, source, [], { summaries, groups: [], recall: [] }, { ...DEFAULTS, keep: 2 }, async text => text.length, 10000);
    assert.deepEqual(result.messages, input);
});

test('thinking blocks stay out of summaries, vectors and long original-text searches', async t => {
    assert.equal(cleanText('<analysis mode="private">secret<think>nested</think>hidden</analysis>正文<reasoning>unfinished'), '正文');
    assert.equal(cleanText('<konatan_planning~>secret</konatan_planning~>正文'), '正文');
    const { store } = fixture(t), id = scopeId(scope), data = messages(2);
    data[0].text = '<think>private input</think>问题';
    data[1].text = 'x'.repeat(6000) + '月光钥匙';
    const state = store.sync(scope, data, null);
    await settle(new Engine(store, { ...provider, summarize: async () => '<analysis mode="private">secret</analysis>事实' }));
    assert.ok(store.memories(id).every(m => m.summary === '事实' && !m.userText.includes('private')));
    assert.match(rawSearch(data, '月光钥匙')[0]?.text || '', /月光钥匙/);
    assert.ok(rawSearch(data, '月光钥匙')[0].text.length <= 1406);
    const first = store.memories(id)[0];
    assert.throws(() => store.edit(id, first.id, { summary: '<think>only thinking</think>' }), /正文|为空/);
    assert.equal(store.chat(id).revision, state.revision);
    assert.equal(store.chat(id).messages[0].text, data[0].text);
});

test('summary content excludes reasoning parts and refuses explicitly truncated results', async () => {
    const input = { kind: 'summary', memory: { turn: 1 }, contextTurns: [{ number: 1, user: '问', assistant: '答' }] };
    const provider = body => new Providers(async () => Response.json({ choices: [body] }));
    const mixed = provider({ message: { content: [{ type: 'reasoning', text: 'secret' }, { type: 'text', text: '正文' }] } });
    assert.equal(await mixed.summarize(config, input), '正文');
    for (const finish_reason of ['length', 'content_filter', 'tool_calls']) {
        await assert.rejects(provider({ message: { content: '半截' }, finish_reason }).summarize(config, input), /完整/);
    }
});

test('disabled summaries cannot return through automatic merged memories', async t => {
    const { store } = fixture(t), id = scopeId(scope);
    store.sync(scope, messages(31), null);
    const engine = new Engine(store, provider); await settle(engine);
    const first = store.memories(id).find(m => m.kind === 'summary' && m.turn === 1);
    store.edit(id, first.id, { enabled: false }); await settle(engine);
    assert.ok(store.memories(id).filter(m => m.kind === 'group').every(m => !m.children.includes(first.id)));
});

test('branches inherit only their declared parent including manual group edits', async t => {
    const { store } = fixture(t), data = messages(31), parentId = scopeId(scope);
    store.sync(scope, data, null); await settle(new Engine(store, provider));
    const first = store.memories(parentId).find(m => m.kind === 'summary' && m.turn === 1);
    const sibling = { ...scope, chat: 'sibling' };
    store.sync(sibling, data, null, scope.chat);
    store.edit(scopeId(sibling), first.id, { summary: 'sibling-only edit' });
    const parentGroup = store.memories(parentId).find(m => m.kind === 'group');
    store.edit(parentId, parentGroup.id, { summary: 'parent manual group', enabled: false });
    const branch = { ...scope, chat: 'new-branch' };
    store.sync(branch, data, null, scope.chat);
    const copied = store.memories(scopeId(branch));
    assert.equal(copied.find(m => m.id === first.id).summary, first.summary);
    assert.equal(copied.find(m => m.id === parentGroup.id)?.summary, 'parent manual group');
    assert.equal(copied.find(m => m.id === parentGroup.id)?.enabled, false);
    const independent = { ...scope, chat: 'independent' };
    store.sync(independent, data, null);
    assert.equal(store.memories(scopeId(independent)).length, 0);
});

test('failed configuration writes restore the in-memory configuration too', t => {
    const { store } = fixture(t);
    store.sync(scope, messages(1), null);
    const previous = structuredClone(store.config);
    store.schedule = () => { throw new Error('schedule failed'); };
    assert.throws(() => store.setConfig({ keep: 40 }), /schedule failed/);
    assert.deepEqual(store.config, previous);
    assert.deepEqual(JSON.parse(store.db.prepare('SELECT data FROM config').get().data), previous);
});

test('uncompleted earlier replies are not sent as background for a later summary', t => {
    const { store } = fixture(t), data = messages(3);
    data[1].text = 'cancelled private draft'; data[1].blocked = true;
    store.sync(scope, data, null);
    const rows = store.db.prepare("SELECT * FROM jobs WHERE kind='summary'").all(), inputs = rows.map(row => store.input(row));
    assert.equal(inputs.length, 2);
    assert.ok(inputs.every(input => !JSON.stringify(input).includes('cancelled private draft')));
    assert.deepEqual(inputs.map(input => input.contextTurns.map(turn => turn.number)).sort(), [[2], [2, 3]]);
    assert.ok(rows.every(row => !/用户问题|角色经历/.test(row.input)));
});

test('editing one source during an embedding batch requeues unaffected memories', async t => {
    const { store } = fixture(t), id = scopeId(scope);
    store.sync(scope, messages(3), null); await settle(new Engine(store, provider));
    store.setConfig({ mode: 'enhanced', embedding: { url: 'http://local/v1', model: 'embedding' } });
    let started;
    const waiting = new Promise(resolve => { started = resolve; });
    const engine = new Engine(store, { ...provider, embed: async (_, texts, signal) => {
        started();
        return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } });
    engine.wake(); await waiting;
    const first = store.memories(id).find(m => m.turn === 1);
    store.edit(id, first.id, { summary: 'changed while indexing' });
    engine.providers = provider;
    await settle(engine);
    assert.equal(store.state(id).indexed, 3);
    assert.equal(store.state(id).counts.error || 0, 0);
});

test('startup cleans legacy thinking and stale vectors even in a paused chat', async t => {
    const { store, filename } = fixture(t), id = scopeId(scope), data = messages(1);
    store.sync(scope, data, null); await settle(new Engine(store, provider)); store.pause(id, true);
    const memory = store.memories(id)[0];
    memory.summary = '<reasoning>private</reasoning>保留事实'; memory.userText = '<analysis>private</analysis>用户问题 0';
    Object.assign(memory, packEmbedding([1, 0]), { vectorSignature: vectorSignature(store.config) });
    store.db.prepare('UPDATE memories SET data=? WHERE chat_id=? AND id=?').run(JSON.stringify(memory), id, memory.id);
    store.close();
    const reopened = new Store(filename);
    try {
        const cleaned = reopened.memories(id)[0];
        assert.equal(cleaned.summary, '保留事实'); assert.equal(cleaned.userText, '用户问题 0');
        assert.equal(cleaned.embeddingQ, undefined); assert.equal(cleaned.vectorSignature, undefined);
        assert.equal(reopened.state(id).paused, true);
        assert.deepEqual(reopened.chat(id).messages.map(m => m.text), data.map(m => m.text));
    } finally { reopened.close(); }
});

test('hide and unhide preserve edited summaries, disabled states and vectors', async t => {
    const { store } = fixture(t), id = scopeId(scope), data = messages(31);
    store.setConfig({ mode: 'enhanced', embedding: { url: 'http://local/v1', model: 'embedding' } });
    let state = store.sync(scope, data, null);
    await settle(new Engine(store, provider));
    const first = store.memories(id).find(m => m.kind === 'summary' && m.turn === 1);
    store.edit(id, first.id, { summary: '必须保留的手动修改' });
    await settle(new Engine(store, provider));
    const group = store.memories(id).find(m => m.kind === 'group');
    store.edit(id, group.id, { enabled: false });
    const before = store.memories(id);
    const hidden = data.map((m, index) => index < 10 ? { ...m, hidden: true } : m);
    state = store.sync(scope, hidden, state.revision);
    assert.ok(store.chat(id).messages[1].hidden);
    assert.deepEqual(store.memories(id), before);
    assert.equal(store.state(id).counts.queued || 0, 0);
    assert.match(rawSearch(store.chat(id).messages, '角色经历 0')[0].text, /角色经历 0/);
    store.sync(scope, data, state.revision);
    assert.deepEqual(store.memories(id), before);
});

test('hidden histories inject summaries in both modes without restoring raw text', async () => {
    const source = messages(4), turns = sourceTurns(source);
    for (const message of source.slice(0, 4)) message.hidden = true;
    const summaries = turns.map(t => ({ id: t.key, turn: t.number, ids: t.ids, sourceAssistantIds: t.assistantIds, sourceUserIds: t.userIds, summary: `记忆${t.number}`, enabled: true }));
    const history = source.filter(m => !m.hidden).map(m => ({ id: m.id, role: m.role, content: m.text }));
    for (const mode of ['classic', 'enhanced']) {
        const result = await buildPrompt(history.map(({ id, ...m }) => m), source, [], { summaries, groups: [], recall: [] }, { ...DEFAULTS, mode }, async () => 100, 1000);
        assert.deepEqual(result.used.map(m => m.id), summaries.slice(0, 2).map(m => m.id));
        assert.ok(result.messages.some(m => m.content === '记忆1'));
        assert.ok(result.messages.some(m => m.content === '记忆2'));
        assert.ok(!JSON.stringify(result.messages).includes('角色经历 0'));
        assert.ok(!JSON.stringify(result.messages).includes('用户问题 0'));
        assert.deepEqual(result.messages.slice(-4), history.map(({ id, ...m }) => m));
    }
    const disabled = structuredClone(summaries); disabled[0].enabled = false;
    assert.deepEqual(compressHistory(history, source, { summaries: disabled }, 20, true).used.map(m => m.id), [summaries[1].id]);
    assert.deepEqual(compressHistory(history, source, {}, 20, true).messages, history);
    const prefills = [{ role: 'system', content: 'system instruction' }, { role: 'assistant', content: 'prefill' }];
    const continued = compressHistory(prefills, source, { summaries }, 20, true).messages;
    assert.equal(continued[0], prefills[0]); assert.equal(continued.at(-1), prefills[1]);
});

test('a hidden merged memory is injected once and hiding one side keeps visible text intact', () => {
    const source = messages(4), turns = sourceTurns(source);
    source[1].hidden = true;
    const summaries = turns.map(t => ({ id: t.key, turn: t.number, ids: t.ids, summary: `记忆${t.number}`, enabled: true }));
    const group = { id: 'merged', kind: 'group', turn: 1, end: 2, ids: turns.slice(0, 2).flatMap(t => t.ids), children: summaries.slice(0, 2).map(m => m.id), summary: '旧剧情合并', enabled: true };
    const history = source.filter(m => !m.hidden).map(m => ({ id: m.id, role: m.role, content: m.text }));
    const result = compressHistory(history, source, { groups: [group], summaries }, 20, true);
    assert.deepEqual(result.used.map(m => m.id), [group.id]);
    assert.equal(result.messages.filter(m => m.content === group.summary).length, 1);
    for (const m of history) assert.ok(result.messages.some(item => item === m));
    const off = compressHistory(history, source, { groups: [{ ...group, enabled: false }], summaries }, 20, true);
    assert.deepEqual(off.messages, history);
    assert.deepEqual(off.used, []);
});

test('hidden sources still invalidate memories when edited, swiped or deleted', async t => {
    const { store } = fixture(t), id = scopeId(scope), data = messages(2).map(m => ({ ...m, hidden: true }));
    let state = store.sync(scope, data, null); await settle(new Engine(store, provider));
    data[1].text = '隐藏期间换了回复'; data[1].swipe = 1;
    state = store.sync(scope, data, state.revision);
    assert.equal(store.memories(id).length, 1);
    await settle(new Engine(store, provider));
    store.sync(scope, data.slice(2), state.revision);
    assert.ok(store.memories(id).every(m => !m.ids.includes('a0')));
});

test('a freshly read chat file replaces the snapshot; a page that fell behind is refused', t => {
    const { store } = fixture(t), id = scopeId(scope), data = messages(3);
    const first = store.sync(scope, data.slice(0, 4), null), second = store.sync(scope, data, first.revision);
    assert.equal(store.sync(scope, data.slice(0, 4), null).revision, first.revision);
    assert.equal(store.chat(id).messages.length, 4);
    assert.throws(() => store.sync(scope, messages(5), second.revision), error => error.status === 409);
    const writes = () => store.db.prepare('SELECT total_changes() AS n').get().n, before = writes();
    store.sync(scope, data.slice(0, 4), first.revision);
    assert.equal(writes(), before);
});

test('unchanged messages can be handed over as bare ids', t => {
    const { store } = fixture(t), id = scopeId(scope), data = messages(3);
    const first = store.sync(scope, data, null), edited = { ...data[5], text: '改过的回复' };
    const second = store.sync(scope, [...data.slice(0, 5).map(m => m.id), edited], first.revision);
    assert.deepEqual(store.chat(id).messages.map(m => m.text), [...data.slice(0, 5).map(m => m.text), '改过的回复']);
    assert.throws(() => store.sync(scope, data.map(m => m.id), first.revision), error => error.status === 409);
    assert.throws(() => store.sync({ ...scope, chat: 'never seen' }, ['u0'], null), error => error.status === 409);
    assert.throws(() => store.sync(scope, ['missing', edited], second.revision), /来源 ID 无效/);
    assert.equal(store.sync(scope, [...data.slice(0, 5), edited], null).revision, second.revision);
});

test('deleting a turn or shortening the chat only redoes the merged memory that lost a turn', async t => {
    const { store } = fixture(t), id = scopeId(scope), data = messages(46);
    let merges = 0, state = store.sync(scope, data, null);
    const engine = new Engine(store, { ...provider, summarize: async (config, input) => { merges += input.kind === 'group'; return provider.summarize(config, input); } });
    await settle(engine);
    const groups = () => store.memories(id).filter(m => m.kind === 'group').sort((a, b) => a.turn - b.turn);
    const untouched = groups().slice(1).map(m => m.summary);
    assert.deepEqual(groups().map(m => [m.turn, m.end]), [[1, 5], [6, 10], [11, 15], [16, 20]]);
    merges = 0; data.splice(4, 2);
    state = store.sync(scope, data, state.revision); await settle(engine);
    assert.equal(merges, 1);
    assert.deepEqual(groups().map(m => [m.turn, m.end]), [[1, 4], [5, 9], [10, 14], [15, 19]]);
    assert.deepEqual(groups().slice(1).map(m => m.summary), untouched);
    store.sync(scope, data.slice(0, -20), state.revision); await settle(engine);
    assert.equal(merges, 1); assert.equal(groups().length, 4);
});

test('a renamed chat keeps its memories and a deleted chat stops all its work', async t => {
    const { store } = fixture(t), id = scopeId(scope), renamed = { ...scope, chat: 'renamed' }, engine = new Engine(store, provider);
    store.sync(scope, messages(3), null); await settle(engine);
    store.edit(id, store.memories(id)[0].id, { summary: '手动改过的记忆' });
    store.move(scope.actor, scope.chat, renamed.chat);
    assert.equal(store.chat(id), null);
    assert.ok(store.memories(scopeId(renamed)).some(m => m.summary === '手动改过的记忆'));
    assert.equal(store.sync(renamed, messages(3), null).counts.queued || 0, 0);
    // The page may hand the chat over under its new name before the rename arrives.
    const again = { ...scope, chat: 'renamed again' };
    store.sync(again, messages(3), null, renamed.chat);
    store.move(scope.actor, renamed.chat, again.chat);
    assert.equal(store.chat(scopeId(renamed)), null); assert.equal(store.memories(scopeId(again)).length, 3);
    assert.equal(store.sync(again, messages(5), null).counts.queued, 2);
    store.move(scope.actor, again.chat);
    assert.equal(store.chat(scopeId(again)), null);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM jobs').get().n, 0);
    await settle(engine);
});

test('summaries already merged are not sent to the page again', async t => {
    const { store } = fixture(t), id = scopeId(scope), routes = new Map(), engine = new Engine(store, provider);
    registerRoutes({ post: (path, handler) => routes.set(path, handler) }, () => engine);
    const plan = body => new Promise(resolve => routes.get('/plan')({ user: { directories: { root: 'user' } }, body: { scope, ...body } }, { json: resolve, status: () => ({ json: resolve }) }));
    store.setConfig({ mode: 'enhanced', embedding: { url: 'http://local/v1', model: 'embedding' } });
    const state = store.sync(scope, messages(31), null); await settle(engine);
    const merged = await plan({ revision: state.revision });
    assert.equal(merged.groups.length, 1); assert.equal(merged.summaries.length, 26);
    assert.ok(merged.summaries.every(m => !merged.groups[0].children.includes(m.id)));
    // A summary rewritten while the search is running is delivered as it now is, and its old text is not recalled.
    const last = store.memories(id).find(m => m.turn === 31);
    engine.providers = { ...provider, embed: async (...args) => { engine.providers = provider; store.edit(id, last.id, { summary: '检索途中改写' }); return provider.embed(...args); } };
    const during = await plan({ revision: state.revision, query: '用户问题' });
    assert.equal(during.error, undefined);
    assert.equal(during.summaries.find(m => m.id === last.id).summary, '检索途中改写');
    assert.ok(during.recall.length); assert.ok(during.recall.every(m => m.id !== last.id));
    await settle(engine);
});

test('recalled memories follow an input that was moved into a tool result', () => {
    const memory = { turn: 3, score: 0.9, userText: '问 <钥匙>', summary: '钥匙在灯塔' };
    const plain = [{ role: 'user', content: '旧问题' }, { role: 'assistant', content: '旧回复' }, { role: 'user', content: '钥匙呢' }];
    const appended = appendRecall(plain, [memory]).messages;
    assert.match(appended[2].content, /^钥匙呢\n\n<enhanced_memory_recall>[\s\S]*&lt;钥匙&gt;[\s\S]*<\/enhanced_memory_recall>$/);
    assert.deepEqual(appended.slice(0, 2), plain.slice(0, 2));
    const moved = [...plain.slice(0, 2), { role: 'user', content: '读取工具结果' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call', type: 'function', function: { name: 'read_user_input', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call', content: JSON.stringify({ source: 'user_input', text: '钥匙呢' }) }];
    const result = appendRecall(moved, [memory]).messages;
    assert.equal(result[2].content, '读取工具结果');
    assert.match(JSON.parse(result[4].content).text, /^钥匙呢\n\n<enhanced_memory_recall>[\s\S]*钥匙在灯塔/);
    assert.deepEqual(appendRecall(moved, []).messages, moved);
});

test('a reply emptied by the user\'s prompt regexes is replaced by its summary even among the recent floors', () => {
    const source = messages(3), turns = sourceTurns(source);
    const summaries = turns.map(t => ({ id: t.key, turn: t.number, ids: t.ids, sourceAssistantIds: t.assistantIds, summary: `记忆${t.number}`, enabled: true }));
    const history = source.map(m => ({ id: m.id, role: m.role, content: m.id === 'a0' || m.id === 'u0' ? '' : m.text }));
    const result = compressHistory(history, source, { summaries }, 20, true).messages;
    assert.deepEqual(result.map(m => m.content), ['', '记忆1', ...source.slice(2).map(m => m.text)]);
});

test('summaries are written from the text the main model was shown; a changed view redoes nothing', async t => {
    const { store } = fixture(t), id = scopeId(scope), data = messages(2);
    data[0] = { ...data[0], text: '问题<选项>甲乙丙</选项>', view: '问题' };
    data[1] = { ...data[1], text: '剧情正文<状态栏>体力 3</状态栏>', view: '剧情正文' };
    const inputs = [];
    const engine = new Engine(store, { ...provider, summarize: async (config, input) => { inputs.push(input); return provider.summarize(config, input); } });
    let state = store.sync(scope, data, null); await settle(engine);
    const first = inputs.find(input => input.memory.turn === 1);
    assert.deepEqual(first.contextTurns, [{ number: 1, user: '问题', assistant: '剧情正文' }]);
    assert.equal(store.memories(id).find(m => m.turn === 1).userText, '问题');
    const before = store.memories(id);
    data[1] = { ...data[1], view: '换了正则以后的样子' };
    state = store.sync(scope, data, state.revision);
    assert.equal(state.counts.queued || 0, 0); assert.deepEqual(store.memories(id), before);
    assert.equal(store.chat(id).messages[1].view, '换了正则以后的样子');
    assert.match(rawSearch(store.chat(id).messages, '体力')[0].text, /状态栏/);
});

test('a rerank model picks the recalled memories when more candidates are found than fit', async t => {
    const { store } = fixture(t), id = scopeId(scope);
    store.setConfig({ mode: 'enhanced', recallExcludeRaw: false, embedding: { url: 'http://local/v1', model: 'embedding' } });
    store.sync(scope, messages(14), null); await settle(new Engine(store, provider));
    const asked = [], ranked = { ...provider, rerank: async (config, query, documents) => { asked.push([query, documents]); return documents.map((_, index) => index); } };
    assert.deepEqual((await recall(store, id, '问题', ranked)).memories.map(m => m.turn), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    store.setConfig({ rerank: { url: 'http://local/v1', model: 'rerank', key: 'rerank-secret' } });
    const picked = await recall(store, id, '问题', ranked);
    assert.deepEqual(picked.memories.map(m => m.turn), [5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    assert.equal(asked.length, 1); assert.equal(asked[0][0], '问题'); assert.equal(asked[0][1].length, 14);
    assert.match(asked[0][1][0], /^用户原输入：\n用户问题 0\n\n本轮总结：\n/);
    // rerankThreshold filters out low-scoring reranked candidates.
    store.setConfig({ rerankThreshold: 0.5 });
    const cutoff = await recall(store, id, '问题', { ...provider, rerank: async (_, __, docs) => docs.map((_, i) => i >= 11 ? 0.8 : 0.1) });
    assert.deepEqual(cutoff.memories.map(m => m.turn), [12, 13, 14]);
    store.setConfig({ rerankThreshold: 0 });
    const failed = await recall(store, id, '问题', { ...provider, rerank: async () => { throw new Error('down'); } });
    assert.deepEqual(failed.memories.map(m => m.turn), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]); assert.match(failed.warnings[0], /重排失败/);
    assert.equal(publicConfig(store.config).rerank.hasKey, true); assert.ok(!JSON.stringify(publicConfig(store.config)).includes('rerank-secret'));
    const p = new Providers(async (url, init) => { assert.match(url, /\/v1\/rerank$/); assert.equal(JSON.parse(init.body).top_n, 2); return Response.json({ results: [{ index: 1, score: 0.9 }, { index: 0, relevance_score: 0.2 }] }); });
    assert.deepEqual(await p.rerank(store.config, '问', ['甲', '乙']), [0.2, 0.9]);
    await assert.rejects(new Providers(async () => Response.json({ results: [] })).rerank(store.config, '问', ['甲']), /有效分数/);
});

test('a held turn gets no new summary but keeps the one it has', async t => {
    const { store } = fixture(t), id = scopeId(scope), data = messages(3), engine = new Engine(store, provider);
    const hold = from => data.map((m, index) => m.role === 'assistant' && index >= from ? { ...m, held: true } : m);
    let state = store.sync(scope, hold(2), null); await settle(engine);
    assert.deepEqual(store.memories(id).map(m => m.turn), [1]);
    state = store.sync(scope, hold(6), state.revision); await settle(engine);
    assert.deepEqual(store.memories(id).map(m => m.turn).sort(), [1, 2, 3]);
    const before = store.memories(id);
    state = store.sync(scope, hold(0), state.revision);
    assert.equal(state.counts.queued || 0, 0); assert.deepEqual(store.memories(id), before);
});

test('a summary request is given three minutes before it is given up on', async t => {
    const waits = [];
    t.mock.method(AbortSignal, 'timeout', ms => { waits.push(ms); return new AbortController().signal; });
    const p = new Providers(async () => Response.json({ choices: [{ message: { content: '合并总结' } }] }));
    assert.equal(await p.summarize(configure(config), { kind: 'group', names: {}, prompt: '五条总结', memory: { turn: 1, end: 5 } }), '合并总结');
    assert.deepEqual(waits, [180000]);
});

test('a chosen thinking level goes out with summary and test requests; with none chosen the requests say nothing about it', async t => {
    const { store } = fixture(t), bodies = [], routes = new Map();
    const engine = new Engine(store, new Providers(async (url, init) => { bodies.push(JSON.parse(init.body)); return Response.json({ choices: [{ message: { content: '总结' } }] }); }));
    registerRoutes({ post: (path, handler) => routes.set(path, handler) }, () => engine);
    const check = setting => new Promise(resolve => routes.get('/check')({ user: { directories: { root: 'user' } }, body: { provider: 'summary', setting } }, { json: resolve, status: () => ({ json: resolve }) }));
    const input = { kind: 'group', names: {}, prompt: '五条总结', memory: { turn: 1, end: 5 } };
    await engine.providers.summarize(store.config, input);
    assert.equal((await check({ effort: 'low' })).message, '总结模型接口可用');
    assert.equal(store.config.summary.effort, '');
    store.setConfig({ summary: { effort: 'low' } }); store.setConfig({ keep: 30 });
    await engine.providers.summarize(store.config, input);
    assert.deepEqual(bodies.map(body => body.reasoning_effort), [undefined, 'low', 'low']);
    assert.ok(bodies.every(body => !('max_tokens' in body)));
    assert.equal(store.setConfig({ summary: { effort: '' } }).summary.effort, '');
    assert.throws(() => store.setConfig({ summary: { effort: 'extreme' } }), /思考强度/);
    assert.match((await check({ effort: ['low'] })).error, /思考强度/);
});

test('empty view is respected by shownText and multimodal user messages receive recall as a text part', async t => {
    const { store } = fixture(t), data = messages(1);
    data[0] = { ...data[0], text: '<status>only status</status>', view: '' };
    const inputs = [];
    const engine = new Engine(store, { ...provider, summarize: async (_, input) => { inputs.push(input); return '总结'; } });
    store.sync(scope, data, null); await settle(engine);
    assert.equal(inputs[0].contextTurns[0].user, '');
    const multimodal = [
        { role: 'user', content: '上一轮文字' },
        { role: 'assistant', content: '上一轮回复' },
        { role: 'user', content: [{ type: 'text', text: '看看这张图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] },
    ];
    const recalled = appendRecall(multimodal, [{ turn: 1, score: 0.9, userText: '问', summary: '记忆' }]);
    assert.equal(recalled.messages[0].content, '上一轮文字');
    assert.equal(recalled.messages[2].content.length, 3);
    assert.equal(recalled.messages[2].content[2].type, 'text');
    assert.match(recalled.messages[2].content[2].text, /<enhanced_memory_recall>/);
    // Keyword-only fallback memory without vector score omits similarity attribute instead of rendering NaN%.
    const kwOnly = appendRecall([{ role: 'user', content: 'hi' }], [{ turn: 2, userText: '问', summary: '记忆' }]);
    assert.ok(!kwOnly.messages[0].content.includes('NaN'));
    // Fallback buildPrompt path also supports multimodal user messages without bailing out.
    const src = messages(2), turns = sourceTurns(src);
    const fallbackOut = await buildPrompt(
        [...src.map(m => ({ role: m.role, content: m.text })),
            { role: 'user', content: [{ type: 'text', text: '看看图' }, { type: 'image_url', image_url: { url: 'x' } }] }],
        src, [], { summaries: [{ id: turns[0].key, kind: 'summary', turn: 1, ids: turns[0].ids, summary: '旧总结' }], groups: [], recall: [{ turn: 1, userText: '问', summary: '召回' }] },
        { ...DEFAULTS, keep: 2 }, async text => text.length, 10000
    );
    assert.equal(fallbackOut.messages[1].content, '旧总结');
    assert.equal(fallbackOut.messages[4].content.length, 3);
    assert.match(fallbackOut.messages[4].content[2].text, /<enhanced_memory_recall>/);
});

test('hybrid retrieval fuses lexical exact hits and enriches short queries with preceding context', async t => {
    const { store } = fixture(t), id = scopeId(scope), data = messages(15);
    store.setConfig({ mode: 'enhanced', keep: 10, recallThreshold: 0.48, embedding: { url: 'http://local/v1', model: 'embedding' } });
    store.sync(scope, data, null);
    let idx = 0;
    const embedVectors = texts => texts.map(() => {
        const i = idx++;
        return i === 1 ? [0.4, 0.9165, 0] : [0.05, 0.9987, 0];
    });
    const engine = new Engine(store, {
        summarize: async (_, input) => input.memory.turn === 2 ? '约定暗号星辉7419并藏好钥匙' : `普通日常第 ${input.memory.turn} 轮`,
        embed: async (_, texts) => embedVectors(texts),
    });
    await settle(engine);
    // Query vector [1, 0, 0]: turn 2 has cosine ~0.40 (below 0.48 threshold!), but exact keyword '星辉7419' rescues it via hybrid RRF.
    const seenQueries = [];
    const recalled = await recall(store, id, '星辉7419', {
        embed: async (_, texts) => { seenQueries.push(texts[0]); return [[1, 0, 0]]; },
    }, { shortContext: '她在地下室门口低声提醒你密码' });
    assert.equal(recalled.memories.length, 1);
    assert.equal(recalled.memories[0].turn, 2);
    assert.ok(recalled.memories[0].why.includes('关键词命中'));
    assert.match(seenQueries[0], /地下室门口[\s\S]*星辉7419/);
    // Common 2-char word overlap ('今天') must NOT pull irrelevant car-repair logs when query is about dinner.
    store.edit(id, store.memories(id).find(m => m.turn === 3).id, { summary: '今天去修车，花了三百元换轮胎' });
    const noisy = await recall(store, id, '今天晚餐吃什么', { embed: async () => [[0, 0, 1]] });
    assert.equal(noisy.memories.length, 0);
    // Even before indexing / when embedding fails, exact proper noun still recalls cleanly.
    store.clearEmbeddings(id);
    const unindexed = await recall(store, id, '星辉7419', { embed: async () => { throw new Error('should not even be needed'); } });
    assert.equal(unindexed.memories.length, 1);
    assert.equal(unindexed.memories[0].turn, 2);
});

test('transient 429 errors retry with backoff while 400 and timeouts fail immediately; upstream details redact keys', async t => {
    const { store } = fixture(t), id = scopeId(scope);
    store.setConfig({ summary: { url: 'http://local/v1', model: 'summary', key: 'sk-super-secret-key' } });
    store.sync(scope, messages(1), null);
    let calls = 0;
    const flaky = new Providers(async () => {
        calls++;
        if (calls < 3) return new Response(JSON.stringify({ error: { message: 'rate limited for sk-super-secret-key' } }), { status: 429 });
        return Response.json({ choices: [{ message: { content: '重试后成功' } }] });
    });
    const engine = new Engine(store, flaky, { retryBaseMs: 15 });
    engine.wake();
    for (let i = 0; i < 100 && !store.memories(id).length; i++) await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(calls, 3);
    assert.equal(store.memories(id)[0]?.summary, '重试后成功');
    await engine.close();
    // Retry-After header is parsed and bounded; non-retryable 400 fails immediately with sanitized upstream error (no secret leaked).
    const retryAfterProvider = new Providers(async () => new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }));
    await assert.rejects(retryAfterProvider.request(store.config.summary, 'chat/completions', {}), error => {
        assert.equal(error.retryable, true);
        assert.equal(error.retryAfter, 2000);
        return true;
    });
    const bad = new Providers(async () => new Response(JSON.stringify({ error: { message: 'invalid model with sk-super-secret-key' } }), { status: 400 }));
    await assert.rejects(bad.request(store.config.summary, 'chat/completions', {}), error => {
        assert.equal(error.retryable, false);
        assert.match(error.message, /HTTP 400.*invalid model/);
        assert.ok(!error.message.includes('sk-super-secret-key'));
        return true;
    });
});

test('embeddings migrate into dedicated BLOB table and survive rename and branch inheritance', async t => {
    const { store, filename } = fixture(t), id = scopeId(scope), data = messages(2);
    store.setConfig({ mode: 'enhanced', embedding: { url: 'http://local/v1', model: 'embedding' } });
    store.sync(scope, data, null);
    await settle(new Engine(store, provider));
    // Verify vectors live in embeddings table, not inside memories.data JSON.
    const rawRow = store.db.prepare('SELECT data FROM memories WHERE chat_id=? LIMIT 1').get(id);
    assert.ok(!rawRow.data.includes('embeddingQ'));
    assert.equal(store.embeddings(id, vectorSignature(store.config)).size, 2);
    // Branch inherits embeddings without re-embedding.
    const branch = { ...scope, chat: 'branch-emb' };
    store.sync(branch, data, null, scope.chat);
    assert.equal(store.state(scopeId(branch)).indexed, 2);
    assert.equal(store.state(scopeId(branch)).counts.queued || 0, 0);
    // Rename cascades embeddings to new chat id.
    const renamed = { ...scope, chat: 'renamed-emb' };
    store.move(scope.actor, scope.chat, renamed.chat);
    assert.equal(store.state(scopeId(renamed)).indexed, 2);
    // Legacy inline embeddingQ JSON migrates cleanly on reopen without re-embedding.
    const mem = store.memories(scopeId(renamed))[0];
    store.clearEmbeddings(scopeId(renamed));
    const legacyBlob = { ...mem, ...packEmbedding([0.5, 0.5, 0]), vectorSignature: vectorSignature(store.config) };
    store.db.prepare('UPDATE memories SET data=? WHERE chat_id=? AND id=?').run(JSON.stringify(legacyBlob), scopeId(renamed), mem.id);
    store.close();
    const reopened = new Store(filename);
    try {
        assert.equal(reopened.embeddings(scopeId(renamed), vectorSignature(reopened.config)).size, 1);
        const migratedRaw = reopened.db.prepare('SELECT data FROM memories WHERE chat_id=? AND id=?').get(scopeId(renamed), mem.id).data;
        assert.ok(!migratedRaw.includes('embeddingQ'));
    } finally { reopened.close(); }
});

test('a slow summary in one chat does not block embedding or merge jobs in another chat', async t => {
    const { store } = fixture(t);
    store.setConfig({ mode: 'enhanced', concurrency: 2, embedding: { url: 'http://local/v1', model: 'embedding' } });
    const chatA = { ...scope, chat: 'slow-a' }, chatB = { ...scope, chat: 'fast-b' };
    store.sync(chatB, messages(1), null);
    await settle(new Engine(store, { summarize: async () => 'B总结', embed: async () => { throw new Error('pause'); } }));
    store.retry(scopeId(chatB)); // chatB now has a queued embedding job
    store.sync(chatA, messages(1), null); // chatA has a queued summary job
    let releaseA;
    const engine = new Engine(store, {
        summarize: () => new Promise(resolve => { releaseA = resolve; }),
        embed: async (_, texts) => texts.map(() => [1, 0, 0]),
    });
    engine.wake();
    for (let i = 0; i < 40 && store.state(scopeId(chatB)).indexed < 1; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(store.state(scopeId(chatB)).indexed, 1);
    releaseA('A总结');
    await settle(engine);
    assert.equal(store.state(scopeId(chatA)).summaries, 1);
});

test('state reports 3-stage progress with ETA and compression stats; provider filters and sorts model lists by role', async t => {
    const { store } = fixture(t), id = scopeId(scope);
    store.setConfig({ keep: 10, summary: { url: 'http://local/v1', model: 'summary', key: 'k' } });
    const data = Array.from({ length: 8 }, (_, i) => [
        { id: `u${i}`, role: 'user', name: '用户', text: `用户问题 ${i}` },
        { id: `a${i}`, role: 'assistant', name: '角色', text: '很长的剧情正文。'.repeat(40) + i },
    ]).flat();
    store.sync(scope, data, null);
    const engine = new Engine(store, { summarize: async (_, input) => `精简总结${input.memory.turn}`, embed: async () => [] });
    await settle(engine);
    const st = store.state(id);
    assert.equal(st.progress.length, 3);
    assert.equal(st.progress[0].kind, 'summary');
    assert.equal(st.progress[0].done, 8);
    assert.equal(st.progress[0].total, 8);
    assert.ok(st.compression.rawChars > st.compression.compressedChars && st.compression.savedPct > 0);
    // Model list smart filtering/sorting by role
    const p = new Providers(async () => Response.json({ data: [
        { id: 'bge-m3' }, { id: 'bge-reranker-v2-m3' }, { id: 'gemini-2.5-flash' }, { id: 'text-embedding-3-small' }, { id: 'gpt-4o-mini' },
    ] }));
    assert.deepEqual(await p.models({ url: 'http://local/v1' }, 'summary'), ['gemini-2.5-flash', 'gpt-4o-mini']);
    assert.deepEqual((await p.models({ url: 'http://local/v1' }, 'embedding')).slice(0, 2), ['bge-m3', 'text-embedding-3-small']);
    assert.equal((await p.models({ url: 'http://local/v1' }, 'rerank'))[0], 'bge-reranker-v2-m3');
});
