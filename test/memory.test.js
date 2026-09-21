import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store, scopeId, sourceTurns } from '../server/store.js';
import { Engine } from '../server/engine.js';
import { Providers, configure, publicConfig, vectorSignature, summaryMessages, hash } from '../server/providers.js';
import { recall, rawSearch, cosine, packEmbedding } from '../server/search.js';
import { buildClassicSummarySystemPrompt, buildClassicSummaryFinalInstruction, buildClassicSecondarySummaryPrompt, enhancedMemoryRecallDescription } from '../shared/rph-prompts.js';
import { turnsFrom, sourceData, DEFAULTS } from '../shared/model.js';
import { buildPrompt, compressHistory } from '../client/prompt.js';

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
    assert.equal(turns[0].eligible, false); assert.match(turns[0].text, /另一角色/);
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
    const prepare = store.db.prepare.bind(store.db);
    store.put = () => { throw new Error('simulated disk failure'); };
    store.db.prepare = sql => {
        if (sql.includes("SET status='error'")) throw new Error('simulated disk failure');
        return prepare(sql);
    };
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
        const { sourceUserIds, sourceAssistantIds, recipe, ...old } = memory;
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
    store.sync(branch, messages(3), null); assert.equal(store.memories(scopeId(branch)).length, 3);
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

test('provider accepts any non-empty completion body, rejects malformed embeddings and invalid model URLs', async () => {
    for (const finish of ['length', 'content_filter', undefined]) {
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

test('RPH 1.9.5 fixture output matches postprocessed replacement positions', () => {
    const fixtureData = JSON.parse(fs.readFileSync(path.join('test', 'fixtures', 'rph-1.9.5.json'), 'utf8'));
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
        ).messages.map(({ id, name, __rphSourceIds, _sourceIndexes, _preventContextMerge, ...message }) => message);
        assert.deepEqual(result, item.expected, item.name);
    }
});

test('summary prompts and nonzero vector encoding match the fixed RPH source', () => {
    const fixtureData = JSON.parse(fs.readFileSync(path.join('test', 'fixtures', 'rph-1.9.5.json'), 'utf8'));
    const names = { userName: '用户', characterName: '角色' };
    assert.equal(buildClassicSummarySystemPrompt(names), fixtureData.prompts.single);
    assert.equal(buildClassicSummaryFinalInstruction(4), fixtureData.prompts.final);
    assert.equal(buildClassicSecondarySummaryPrompt({ ...names, startTurn: 1, endTurn: 5 }), fixtureData.prompts.group);
    assert.deepEqual(enhancedMemoryRecallDescription, fixtureData.prompts.recall);
    const request = summaryMessages({ kind: 'summary', names, memory: { turn: 4 }, contextTurns: [1, 2, 3, 4].map(number => ({ number, user: '问题', assistant: '回复' })) });
    assert.equal(request.length, 10);
    assert.match(request[1].content, /历史背景.*第 1 轮/);
    assert.match(request[7].content, /唯一总结目标.*第 4 轮/);
    assert.equal(request.at(-1).content, fixtureData.prompts.final);
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

test('RPH retrieval includes recent memories and falls back to summaries on vector failure; raw search finds omitted detail', async t => {
    const { store } = fixture(t), id = scopeId(scope), data = messages(3);
    data[1].text += '遗失钥匙藏在灯塔';
    store.setConfig({ mode: 'enhanced', embedding: { url: 'http://model.local/v1', model: 'embedding' } });
    store.sync(scope, data, null); await settle(new Engine(store, provider));
    const memories = store.memories(id);
    store.edit(id, memories[0].id, { summary: '约好明天去灯塔' });
    store.edit(id, memories[1].id, { summary: '灯塔的风很大' });
    await settle(new Engine(store, provider));
    const result = await recall(store, id, '灯塔', provider);
    assert.equal(result.memories.length, 3); assert.equal(result.memories.at(-1).turn, 3);
    const failed = await recall(store, id, '灯塔', { embed: async () => { throw new Error('failure'); } });
    assert.equal(failed.memories.length, 0); assert.ok(failed.warnings.length);
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
