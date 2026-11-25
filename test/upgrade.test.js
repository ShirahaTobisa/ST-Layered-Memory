import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { Store, scopeId, sourceTurns, shownText } from '../server/store.js';
import { Engine } from '../server/engine.js';
import { registerRoutes } from '../server/routes.js';
import { Providers, vectorSignature } from '../server/providers.js';
import { recall, packEmbedding, retrievalQuery } from '../server/search.js';
import { compressHistory, buildPrompt, appendRecall } from '../client/prompt.js';
import { mountCitations } from '../client/citations.js';
import { DEFAULTS, hideTargets } from '../shared/model.js';

const scope = { actor: 'character:test', chat: 'story', lineage: 'test' }, id = scopeId(scope);
const messages = count => Array.from({ length: count }, (_, i) => [
    { id: `u${i}`, role: 'user', text: `问 ${i}` }, { id: `a${i}`, role: 'assistant', text: `答 ${i}` },
]).flat();
const summary = turn => ({ id: turn.key, kind: 'summary', turn: turn.number, ids: turn.ids,
    sourceHash: turn.sourceHash, sourceUserIds: turn.userIds, sourceAssistantIds: turn.assistantIds,
    summary: `总结 ${turn.number}`, userText: shownText(turn.user), enabled: true });
function fixture(t, count = 4) {
    const store = new Store(':memory:'); t.after(() => store.close());
    store.sync(scope, messages(count));
    const source = store.chat(id).messages;
    for (const turn of sourceTurns(source)) store.put(id, summary(turn));
    return { store, source, memories: store.memories(id).sort((a, b) => a.turn - b.turn) };
}
function routes(store) {
    const handlers = new Map();
    registerRoutes({ post(path, handler) { handlers.set(path, handler); } }, () => ({ store, wake() {} }));
    return async (path, body = {}) => {
        let result, status = 200;
        await handlers.get(path)({ user: { directories: { root: 'test' } }, body: { scope, revision: store.revision(id), ...body } },
            { json(data) { result = data; }, status(code) { status = code; return this; } });
        if (status !== 200) throw new Error(result.error);
        return result;
    };
}

test('an empty prompt view stays empty and merged coverage leaves disabled gaps visible', t => {
    assert.equal(shownText([{ role: 'user', text: '不应泄露的原文', view: '' }]), '');
    const { store, source, memories } = fixture(t, 30);
    store.edit(id, memories[2].id, { enabled: false });
    const children = memories.slice(0, 5).filter(m => m.turn !== 3);
    store.put(id, { id: 'g', kind: 'group', turn: 1, end: 5, children: children.map(m => m.id), ids: children.flatMap(m => m.ids), summary: '合并', enabled: true });
    const state = store.state(id);
    assert.deepEqual(state.covered.slice(0, 2), [[1, 2], [4, 5]]);
    assert.ok(!hideTargets(source, state.covered, 20).has('u2'));
});

test('mixed hidden user messages are restored individually in order without duplicating visible attachments', () => {
    const source = [{ id: 'u0', role: 'user', text: '原文', view: '清洗后的第一句', hidden: true, autoHidden: true },
        { id: 'extra', role: 'user', text: '附件说明', protected: true },
        { id: 'manual', role: 'user', text: '手动隐藏，不回填', hidden: true },
        { id: 'a0', role: 'assistant', text: '长回复', hidden: true, autoHidden: true }, ...messages(2).slice(2)];
    const memories = sourceTurns(source).map(summary);
    const visible = source.filter(m => !m.hidden).map(m => ({ id: m.id, role: m.role, content: m.text }));
    visible[0].content = [{ type: 'text', text: '附件说明' }, { type: 'image_url', image_url: { url: 'picture' } }];
    const result = compressHistory(visible, source, { summaries: memories }, 2, true);
    assert.equal(result.messages[0].content, '清洗后的第一句');
    assert.equal(result.messages[1], visible[0]);
    assert.equal(result.messages[2].content, '总结 1');
    assert.ok(!JSON.stringify(result.messages).includes('手动隐藏，不回填'));
    assert.ok(!JSON.stringify(result.messages).includes('总结记忆 第 1 轮'));
});

test('a visible protected assistant is not duplicated by a summary when its user was auto hidden', () => {
    const source = messages(2); source[0].hidden = true; source[0].autoHidden = true; source[1].protected = true;
    const result = compressHistory(source.slice(1).map(m => ({ id: m.id, role: m.role, content: m.text })), source, { summaries: sourceTurns(source).map(summary) }, 2, true);
    assert.deepEqual(result.messages.map(m => m.content), source.map(m => m.text));
    assert.equal(result.used.length, 0);
});

test('auto-hidden unmerged turns before a visible merged group are not merged or dropped, and empty views emit no blank user turn', () => {
    const source = messages(8);
    // Turns 1-2: auto-hidden unmerged summaries immediately preceding visible merged group turns 3-7.
    for (let i = 0; i < 4; i++) { source[i].hidden = true; source[i].autoHidden = true; }
    const turns = sourceTurns(source);
    const s1 = { ...summary(turns[0]), no: 1 }, s2 = { ...summary(turns[1]), no: 2 };
    const groupTurns = turns.slice(2, 7);
    const group = {
        id: 'g3_7', kind: 'group', turn: 3, end: 7, no: 9, enabled: true,
        children: groupTurns.map(t => t.key),
        ids: groupTurns.flatMap(t => t.ids),
        sourceUserIds: groupTurns.flatMap(t => t.userIds),
        sourceAssistantIds: groupTurns.flatMap(t => t.assistantIds),
        summary: '合并 3-7',
    };
    const visible = source.filter(m => !m.hidden).map(m => ({ id: m.id, role: m.role, content: m.text }));
    const result = compressHistory(visible, source, { summaries: [s1, s2], groups: [group] }, 2, true, true);
    assert.deepEqual(result.messages.map(m => [m.role, m.content]), [
        ['user', '问 0'], ['assistant', '[M1] 总结 1'],
        ['user', '问 1'], ['assistant', '[M2] 总结 2'],
        ['user', '总结记忆 第 3-7 轮'], ['assistant', '[M9] 合并 3-7'],
        ['user', '问 7'], ['assistant', '答 7'],
    ]);
    // Auto-hidden user with an empty prompt view must not emit a blank user message.
    const emptySource = messages(2);
    emptySource[0].hidden = true; emptySource[0].autoHidden = true; emptySource[0].view = '';
    emptySource[1].hidden = true; emptySource[1].autoHidden = true;
    const emptyVisible = emptySource.filter(m => !m.hidden).map(m => ({ id: m.id, role: m.role, content: m.text }));
    const emptyResult = compressHistory(emptyVisible, emptySource, { summaries: [summary(sourceTurns(emptySource)[0])] }, 2, true);
    assert.ok(emptyResult.messages.every(m => String(m.content).trim().length > 0));
    assert.deepEqual(emptyResult.messages.map(m => [m.role, m.content]), [
        ['user', '总结记忆 第 1 轮'], ['assistant', '总结 1'],
        ['user', '问 1'], ['assistant', '答 1'],
    ]);
});

test('multimodal recall stays on the newest input in both prompt entry paths', async () => {
    const source = messages(2), memory = { ...summary(sourceTurns(source)[0]), no: 1, score: 0.8 };
    const history = [{ role: 'user', content: '旧问题' }, { role: 'assistant', content: '旧回复' },
        { role: 'user', content: [{ type: 'text', text: '看图片' }, { type: 'image_url', image_url: { url: 'picture' } }] }];
    const recalled = appendRecall(history, [memory], true);
    assert.equal(recalled.messages[0], history[0]);
    assert.equal(recalled.messages[2].content[1], history[2].content[1]);
    assert.match(recalled.messages[2].content[2].text, /id="M1"/);
    const result = await buildPrompt(history, source, [], { recall: [memory] }, DEFAULTS, () => 100, 1000);
    assert.equal(result.messages.at(-1).content[1], history[2].content[1]);
    assert.match(result.messages.at(-1).content[2].text, /id="M1"/);
});

test('citation numbers survive edits, clearing, branches, renames and backup restoration', async t => {
    const { store, source, memories } = fixture(t);
    const first = memories[0];
    store.edit(id, first.id, { summary: '修改后的记忆' });
    assert.equal(store.memory(id, first.id).no, first.no);
    store.remove(id, memories.at(-1).id);
    const call = routes(store), backup = await call('/export');
    assert.equal(backup.numbers.length, 4);
    const restored = new Store(':memory:'); t.after(() => restored.close());
    restored.sync(scope, source);
    await routes(restored)('/import', { backup });
    restored.put(id, { id: 'fresh-memory', summary: '恢复后的新内容' });
    assert.equal(restored.memory(id, 'fresh-memory').no, 5);
    const branch = { ...scope, chat: 'branch' }, branchId = scopeId(branch);
    store.sync(branch, source, null, scope.chat);
    store.put(branchId, { id: 'new-branch-memory', summary: '分支新记忆' });
    assert.equal(store.memory(branchId, 'new-branch-memory').no, 5);
    store.clear(id);
    assert.equal((await call('/citation', { no: first.no })).memory, null);
    await call('/import', { backup });
    assert.equal((await call('/citation', { no: first.no })).memory.summary, '修改后的记忆');
    store.put(id, { id: 'new-memory', summary: '新内容' });
    assert.equal(store.memory(id, 'new-memory').no, 5);
    store.move(scope.actor, scope.chat, 'renamed');
    const renamed = scopeId({ ...scope, chat: 'renamed' });
    assert.equal(store.memory(renamed, first.id).no, first.no);
    assert.equal(store.db.prepare('SELECT no FROM memory_numbers WHERE chat_id=? AND memory_id=?').get(renamed, first.id).no, first.no);
});

test('v0.2.5 databases gain citation numbers and timing without losing existing summaries or vectors', t => {
    fs.mkdirSync('test-output', { recursive: true });
    const directory = fs.mkdtempSync(path.resolve('test-output/upgrade-')), filename = path.join(directory, 'memory.sqlite');
    let store = new Store(filename);
    t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    store.sync(scope, messages(2));
    for (const turn of store.turns(id)) store.put(id, { ...summary(turn), ...packEmbedding([1, 0]), vectorSignature: vectorSignature(store.config) });
    store.db.exec("DROP TABLE memory_numbers; ALTER TABLE jobs DROP COLUMN duration_ms; UPDATE memories SET data=json_remove(data,'$.no');");
    store.close(); store = new Store(filename);
    assert.deepEqual(store.memories(id).map(m => m.no).sort(), [1, 2]);
    assert.ok(store.memories(id).every(m => m.summary));
    assert.equal(store.embeddings(id, vectorSignature(store.config)).size, 2);
    assert.ok(store.db.prepare('PRAGMA table_info(jobs)').all().some(column => column.name === 'duration_ms'));
    assert.equal(store.state(id).counts.queued || 0, 0);
});

test('a conflicting citation backup rolls back without replacing existing memories', async t => {
    const { store, memories } = fixture(t), call = routes(store), backup = await call('/export');
    backup.numbers[0].no = 999;
    backup.memories[0].summary = '不应写入';
    await assert.rejects(call('/import', { backup }), /编号.*冲突/);
    assert.equal(store.memory(id, memories[0].id).summary, memories[0].summary);
});

test('progress counts current work and estimates remaining time from completed requests', async t => {
    const store = new Store(':memory:'); t.after(() => store.close());
    store.setConfig({ concurrency: 1, summary: { url: 'http://model.local', model: 'summary' } });
    store.sync(scope, messages(2));
    const engine = new Engine(store, { summarize: async () => '记忆' });
    engine.wake();
    while (engine.active.size) await Promise.all([...engine.active.values()].map(task => task.promise));
    store.db.prepare("UPDATE jobs SET duration_ms=60000 WHERE status='done'").run();
    store.sync(scope, messages(4), store.revision(id));
    const progress = store.state(id).progress.find(stage => stage.kind === 'summary');
    assert.deepEqual(progress, { kind: 'summary', done: 2, total: 4, failed: 0, eta: 120 });
    store.pause(id, true);
    assert.equal(store.state(id).progress[0].eta, null);
});

test('recall excludes fully visible recent turns, but keeps old or hidden candidates', async t => {
    const { store, source, memories } = fixture(t, 12);
    store.setConfig({ mode: 'enhanced', embedding: { url: 'http://model.local', model: 'embedding' } });
    for (const memory of memories) store.put(id, { ...memory, ...packEmbedding([1, 0]), vectorSignature: vectorSignature(store.config) });
    const provider = { embed: async () => [[1, 0]] };
    assert.deepEqual((await recall(store, id, '钥匙', provider)).memories.map(m => m.turn), [1, 2]);
    source.at(-1).hidden = true;
    store.sync(scope, source, store.revision(id));
    assert.deepEqual((await recall(store, id, '钥匙', provider)).memories.map(m => m.turn), [1, 2, 12]);
});

test('keyword matches recover named details below the vector threshold and during outages', async t => {
    const { store, memories } = fixture(t);
    store.setConfig({ recallExcludeRaw: false, mode: 'enhanced', embedding: { url: 'http://model.local', model: 'embedding' } });
    for (const [index, memory] of memories.entries()) store.put(id, { ...memory, summary: index === 1 ? '琥珀钥匙放在 B-17 柜子里' : '一起聊天', ...packEmbedding([0, 1]), vectorSignature: vectorSignature(store.config) });
    const result = await recall(store, id, '琥珀钥匙 B-17', { embed: async () => [[1, 0]] });
    assert.deepEqual(result.memories.map(m => m.turn), [2]);
    assert.deepEqual(result.memories[0].why, ['关键词命中']);
    const failed = await recall(store, id, 'B-17', { embed: async () => { throw new Error('offline'); } });
    assert.deepEqual(failed.memories.map(m => m.turn), [2]);
    assert.match(failed.warnings[0], /向量召回失败/);
});

test('short inputs use preceding reply context without issuing a separate rewrite request', () => {
    const source = [{ role: 'assistant', text: '<think>私密思考</think>她把琥珀钥匙交给你。[M4]' }, { role: 'user', text: '我收下它' }];
    assert.equal(retrievalQuery(source, '我收下它'), '她把琥珀钥匙交给你。\n当前输入：我收下它');
    assert.equal(retrievalQuery(source, '另一个查询'), '另一个查询');
});

test('keyword-only recall rejects a shared generic fragment but keeps exact identifiers without an index', async t => {
    const { store, memories } = fixture(t, 2);
    store.setConfig({ mode: 'enhanced', recallExcludeRaw: false });
    store.put(id, { ...memories[0], userText: '记录行程', summary: '今天修理了汽车轮胎' });
    store.put(id, { ...memories[1], userText: '放好物品', summary: '琥珀钥匙在B-17柜子里，暗号星辉7419请记住' });
    const provider = { embed: () => { throw new Error('Unindexed recall must not call the provider'); } };
    assert.equal((await recall(store, id, '今天晚餐吃什么', provider)).memories.length, 0);
    assert.equal((await recall(store, id, '<think>B-17</think>今天晚餐吃什么', provider)).memories.length, 0);
    for (const query of ['B-17', '星辉7419', '琥珀钥匙', '请找回 B-17 的约定']) {
        assert.deepEqual((await recall(store, id, query, provider)).memories.map(m => m.turn), [2]);
    }
});

test('keyword recall rejects bare 1-2 digit numbers, frequent chat words, and ubiquitous timestamp years in longer chats', async t => {
    const { store, memories } = fixture(t, 20);
    store.setConfig({ mode: 'enhanced', recallExcludeRaw: false, embedding: { url: 'http://model.local', model: 'embedding' } });
    for (const [index, memory] of memories.entries()) {
        let text = `【2023年08月01日】\n普通剧情推进 ${index + 1}`;
        if (index === 0) text = '【2023年08月01日】\n3楼有2个人在等电梯，今天谈了什么事情';
        else if (index === 1) text = '【2023年08月01日】\n今天去修车，问需要修什么零件';
        else if (index === 2) text = '【2023年08月01日】\n琥珀钥匙锁在B-17柜子里，暗号星辉7419';
        else if (index >= 3 && index < 12) text = '【2023年08月01日】\n今天大家聊了什么日常安排';
        store.put(id, { ...memory, userText: '记录', summary: text, ...packEmbedding([0, 1]), vectorSignature: vectorSignature(store.config) });
    }
    const orthogonal = { embed: async () => [[1, 0]] };
    // Bare 1-2 digit numbers ('3', '2') must NOT trigger false identifier recall.
    assert.equal((await recall(store, id, '等3分钟买2杯咖啡', orthogonal)).memories.length, 0);
    // High-frequency generic words ('今天', '什么') must NOT flood recall even when two overlap.
    assert.equal((await recall(store, id, '今天晚上想吃什么', orthogonal)).memories.length, 0);
    // Ubiquitous timestamp year ('2023') present on every turn must NOT match every turn.
    assert.equal((await recall(store, id, '2023年那次散步', orthogonal)).memories.length, 0);
    // Rare specific identifiers still match cleanly even with orthogonal embeddings.
    for (const query of ['B-17', '星辉7419', '请找回 B-17 的约定']) {
        assert.deepEqual((await recall(store, id, query, orthogonal)).memories.map(m => m.turn), [3]);
    }
});

test('short mixed identifiers still recall inside longer questions', async t => {
    const { store, memories } = fixture(t, 20);
    store.setConfig({ mode: 'enhanced', recallExcludeRaw: false });
    for (const code of ['A1', '1A', 'B-17', '7419']) {
        store.put(id, { ...memories[2], userText: '钥匙位置', summary: `钥匙在${code}柜子里` });
        const result = await recall(store, id, `请找回 ${code} 的约定`, {});
        assert.deepEqual(result.memories.map(m => m.turn), [3], code);
    }
});

test('exact identifier recall survives a full vector candidate list', async t => {
    const { store, memories } = fixture(t, 20);
    store.setConfig({ mode: 'enhanced', recallExcludeRaw: false, recallLimit: 3,
        embedding: { url: 'http://model.local', model: 'embedding' } });
    for (const [index, memory] of memories.entries()) {
        store.put(id, { ...memory, userText: '记录', summary: index === 19 ? '钥匙在B-17柜子里' : '在花园里散步',
            ...packEmbedding(index === 19 ? [0, 1] : [1, 0]), vectorSignature: vectorSignature(store.config) });
    }
    const result = await recall(store, id, 'B-17', { embed: async () => [[1, 0]] });
    assert.equal(result.memories.length, 3);
    assert.ok(result.memories.some(m => m.turn === 20 && m.why.includes('关键词命中')));
});

test('recent raw exclusion requires visible nonempty user and assistant sources', async t => {
    const { store, source, memories } = fixture(t, 2);
    store.setConfig({ mode: 'enhanced', embedding: { url: 'http://model.local', model: 'embedding' } });
    for (const memory of memories) store.put(id, { ...memory, ...packEmbedding([1, 0]), vectorSignature: vectorSignature(store.config) });
    const provider = { embed: async () => [[1, 0]] };
    assert.equal((await recall(store, id, '旧约定', provider)).memories.length, 0);
    source[0].hidden = true;
    source[3].view = '';
    store.sync(scope, source, store.revision(id));
    assert.deepEqual((await recall(store, id, '旧约定', provider)).memories.map(m => m.turn), [1, 2]);
});

test('short-context and rerank cutoffs remain configurable after merging retrieval', async t => {
    const { store, memories } = fixture(t, 2);
    store.setConfig({ mode: 'enhanced', recallExcludeRaw: false, recallShortContext: false, rerankThreshold: 0.6,
        embedding: { url: 'http://model.local', model: 'embedding' }, rerank: { url: 'http://model.local', model: 'rerank' } });
    for (const memory of memories) store.put(id, { ...memory, ...packEmbedding([1, 0]), vectorSignature: vectorSignature(store.config) });
    const queries = [];
    const provider = { embed: async (_, texts) => { queries.push(texts[0]); return [[1, 0]]; }, rerank: async () => [0.8, 0.2] };
    const result = await recall(store, id, '问 1', provider, { shortContext: '上文线索' });
    assert.deepEqual(result.memories.map(m => m.turn), [1]);
    assert.equal(queries[0], '问 1');
    store.setConfig({ recallShortContext: true });
    await recall(store, id, '问 1', provider, { shortContext: '上文线索' });
    assert.match(queries[1], /上文线索/);
});

test('memory listing retains sorting, character counts and last-page clamping', async t => {
    const { store } = fixture(t, 12), call = routes(store);
    const latest = await call('/list');
    assert.equal(latest.items[0].turn, 12);
    assert.equal(latest.items[0].originalChars, '问 11答 11'.length);
    assert.equal(latest.items[0].summaryChars, '总结 12'.length);
    const last = await call('/list', { order: 'asc', offset: 999 });
    assert.equal(last.offset, 10);
    assert.deepEqual(last.items.map(m => m.turn), [11, 12]);
});

test('compression estimates keep protected replies raw and reflect enabled summaries', t => {
    const { store, source, memories } = fixture(t, 6);
    store.setConfig({ keep: 10 });
    store.edit(id, memories[0].id, { summary: '简' });
    const rawChars = source.reduce((sum, m) => sum + m.text.length, 0);
    assert.equal(store.state(id).compression.compressedChars, rawChars - source[1].text.length + 1);
    store.edit(id, memories[0].id, { enabled: false });
    assert.equal(store.state(id).compression.compressedChars, rawChars);
    source[1].protected = true;
    store.sync(scope, source, store.revision(id));
    const turn = sourceTurns(store.chat(id).messages)[0];
    store.put(id, { ...summary(turn), summary: '简' });
    assert.equal(store.state(id).compression.compressedChars, rawChars);
});

test('prompt citations identify included summaries and remove stale citations from ordinary history', async () => {
    const source = messages(3), memories = sourceTurns(source).map((turn, i) => ({ ...summary(turn), no: i + 1 }));
    const history = source.map(m => ({ role: m.role, content: m.text }));
    history.at(-1).content += '[M999]';
    const result = await buildPrompt(history, source, [], { summaries: memories }, { ...DEFAULTS, keep: 2 }, () => 100, 1000);
    assert.match(result.messages[0].content, /memory_citation/);
    assert.ok(result.messages.some(m => m.content === '[M1] 总结 1'));
    assert.ok(!JSON.stringify(result.messages).includes('M999'));
    const disabled = await buildPrompt(history, source, [], { summaries: memories }, { ...DEFAULTS, keep: 2, citations: false }, () => 100, 1000);
    assert.ok(!JSON.stringify(disabled.messages).includes('memory_citation'));
});

test('citation buttons show source text, skip code and user input, and do not display a response from the previous chat', async t => {
    const dom = new JSDOM('<body><div id="chat"><div class="mes" is_user="false" mesid="0"><div class="mes_text">约定[M12] <code>[M8]</code></div></div><div class="mes" is_user="true" mesid="1"><div class="mes_text">文字[M12]</div></div></div></body>');
    const host = dom.window, handlers = new Map();
    host.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    host.HTMLDialogElement.prototype.close = function () { this.open = false; };
    const context = { eventTypes: { CHAT_CHANGED: 'changed', CHARACTER_MESSAGE_RENDERED: 'render' }, eventSource: { on(name, handler) { handlers.set(name, handler); }, removeListener(name) { handlers.delete(name); } } };
    let finish;
    const runtime = { target: {}, request: async (path, body) => { assert.equal(path, 'citation'); assert.equal(body.no, 12); return new Promise(resolve => { finish = resolve; }); } };
    const dispose = mountCitations(() => context, runtime, host);
    t.after(() => { dispose(); host.close(); });
    handlers.get('render')(0);
    handlers.get('render')(1);
    assert.equal(host.document.querySelectorAll('.lm-citation').length, 1);
    host.document.querySelector('.lm-citation').click();
    finish({ memory: { turn: 1, summary: '<script>文字，不执行</script>' }, sources: [{ role: 'user', text: '约好再见' }] });
    await new Promise(resolve => setImmediate(resolve));
    const dialog = host.document.querySelector('dialog');
    assert.equal(dialog.querySelector('p').textContent, '<script>文字，不执行</script>');
    assert.equal(dialog.querySelector('script'), null);
    assert.match(dialog.querySelector('details').textContent, /约好再见/);
    host.document.querySelector('.lm-citation').click(); handlers.get('changed')();
    finish({ memory: { turn: 99, summary: '旧聊天迟到的内容' }, sources: [] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(dialog.open, false);
    assert.ok(!dialog.textContent.includes('旧聊天迟到的内容'));
});

test('upstream errors retain useful reasons while redacting the configured key', async () => {
    const provider = new Providers(async () => Response.json({ error: { message: 'quota exceeded for secret-test-key' } }, { status: 429 }));
    await assert.rejects(provider.request({ url: 'http://model.local', model: 'm', key: 'secret-test-key' }, 'chat/completions', {}), error => /quota exceeded/.test(error.message) && !error.message.includes('secret-test-key'));
});
