import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRuntime } from '../client/runtime.js';
import { Store, scopeId } from '../server/store.js';
import { Engine } from '../server/engine.js';
import { KEY, VERSION, hideTargets } from '../shared/model.js';

const types = Object.fromEntries(['WORLDINFO_ENTRIES_LOADED', 'CHAT_COMPLETION_SETTINGS_READY', 'GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED',
    'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'CHAT_CHANGED', 'CHAT_RENAMED', 'CHAT_DELETED', 'GROUP_CHAT_DELETED'].map(t => [t, t]));
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };
fs.mkdirSync('test-output', { recursive: true });

// Four turns; the server says the memories in use stand for the turns in `covered`.
function harness() {
    const listeners = new Map(), events = { on(type, callback) { listeners.set(type, [...listeners.get(type) || [], callback]); }, async emit(type, ...args) { for (const callback of listeners.get(type) || []) await callback(...args); } };
    const chat = [0, 1, 2, 3].flatMap(i => [{ name: 'User', is_user: true, mes: `问 ${i}` }, { name: 'Alice', is_user: false, mes: `答 ${i}` }]);
    const ctx = { chatId: 'chat', characters: [{ avatar: 'alice.png' }], characterId: 0, groupId: null, name1: 'User', name2: 'Alice', chat,
        chatMetadata: { [KEY]: { enabled: true } }, extensionSettings: { [KEY]: { enabled: false } }, saves: 0,
        getRequestHeaders: () => ({}), saveChat: async () => { ctx.saves++; }, saveMetadata: async () => {}, registerFunctionTool: () => {}, eventSource: events, eventTypes: types };
    const server = { covered: [[1, 3]], config: { keep: 2, autoHide: true } };
    let version = 0;
    const host = { crypto, fetch: async url => {
        if (url.endsWith('/status') || url.endsWith('/config')) return Response.json({ version: VERSION, config: server.config });
        if (url.endsWith('/sync')) version++;
        if (url.endsWith('/sync') || url.endsWith('/state')) return Response.json({ revision: `r${version}`, counts: {}, total: 0, covered: server.covered });
        return Response.json({ revision: 'x' });
    } };
    const runtime = createRuntime(() => ctx, host, () => {});
    const reopen = async () => { await events.emit('CHAT_CHANGED'); await settle(); };
    return { runtime, ctx, host, server, reopen, hidden: () => ctx.chat.map(m => !!m.is_system) };
}

test('turns a memory stands for are hidden except the newest floors and messages with attachments', () => {
    const messages = [0, 1, 2, 3].flatMap(i => [{ id: `u${i}`, role: 'user', text: `问 ${i}` }, { id: `a${i}`, role: 'assistant', text: `答 ${i}` }]);
    assert.deepEqual([...hideTargets(messages, [[1, 3]], 2)], ['u0', 'a0', 'u1', 'a1', 'u2', 'a2']);
    // Floors are counted by position, hidden ones included; two replies in a row are one floor.
    messages.splice(6, 0, { id: 'a2b', role: 'assistant', text: '续', hidden: true });
    messages[2].protected = true;
    assert.deepEqual([...hideTargets(messages, [[1, 3]], 3)], ['u0', 'a0', 'a1', 'u2']);
});

test('old floors are hidden and marked; floors come back when their memory goes away', async () => {
    const h = harness();
    await h.reopen();
    assert.deepEqual(h.hidden(), [true, true, true, true, true, true, false, false]);
    assert.ok(h.ctx.chat.slice(0, 6).every(m => m.extra[KEY].autoHidden));
    assert.ok(h.ctx.saves > 0);
    h.server.covered = [[1, 1]];
    await h.reopen();
    assert.deepEqual(h.hidden(), [true, true, false, false, false, false, false, false]);
    assert.ok(h.ctx.chat.slice(2).every(m => !m.extra[KEY].autoHidden));
});

test('a floor shown by hand stays shown, and floors hidden by someone else are never touched', async () => {
    const h = harness();
    h.ctx.chat[7].is_system = true; // hidden by hand or by another script
    await h.reopen();
    h.ctx.chat[0].is_system = false; // the user shows a floor the plugin hid
    await h.reopen();
    assert.equal(h.ctx.chat[0].is_system, false);
    assert.equal(h.ctx.chat[0].extra[KEY].keepVisible, true);
    assert.equal(h.ctx.chat[7].is_system, true); assert.ok(!h.ctx.chat[7].extra[KEY].autoHidden);
    // Turning memory off puts back only what the plugin hid.
    h.ctx.chatMetadata[KEY].enabled = false;
    await h.reopen();
    assert.deepEqual(h.hidden(), [false, false, false, false, false, false, false, true]);
    assert.ok(h.ctx.chat.every(m => !m.extra[KEY].autoHidden));
});

test('switching automatic hiding off puts the floors back', async () => {
    const h = harness();
    await h.reopen(); assert.equal(h.hidden()[0], true);
    h.server.config = { keep: 2, autoHide: false };
    await h.runtime.saveConfig({ autoHide: false }); await settle();
    assert.ok(h.hidden().every(hidden => !hidden));
});

test('the server reports the turns that memories in use stand for; hiding a floor keeps its memory', async t => {
    const directory = fs.mkdtempSync(path.resolve('test-output/hide-'));
    const store = new Store(path.join(directory, 'memory.sqlite'));
    t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    store.setConfig({ summary: { url: 'http://model.local/v1', model: 'summary', key: 'k' } });
    const scope = { actor: 'character:alice.png', chat: 'story', lineage: 'l' }, id = scopeId(scope);
    const messages = Array.from({ length: 30 }, (_, i) => [{ id: `u${i}`, role: 'user', name: '用户', text: `问 ${i}` }, { id: `a${i}`, role: 'assistant', name: '角色', text: `答 ${i}` }]).flat();
    let state = store.sync(scope, messages, null);
    const engine = new Engine(store, { summarize: async (_, input) => `总结 ${input.kind} ${input.memory.turn}`, embed: async () => [] });
    for (let i = 0; i < 400 && (engine.wake(), store.db.prepare("SELECT 1 FROM jobs WHERE status IN ('queued','running')").get() || engine.active.size); i++) await new Promise(resolve => setTimeout(resolve, 5));
    state = store.state(id);
    // Turns 1–5 are merged into one memory; the rest each have their own.
    assert.deepEqual(state.covered[0], [1, 5]); assert.equal(state.covered.length, 26);
    assert.ok(!state.covered.some(([first, last]) => first === 1 && last === 1));
    const memory = store.memories(id).find(m => m.kind === 'summary' && m.turn === 30);
    store.edit(id, memory.id, { enabled: false });
    assert.ok(!store.state(id).covered.some(([first]) => first === 30));
    const before = store.memories(id).length;
    store.sync(scope, messages.map((m, i) => i < 10 ? { ...m, hidden: true } : m), state.revision);
    assert.equal(store.memories(id).length, before);
});

test('disabling one turn inside a merged group excludes it from covered so autoHide never hides it', async t => {
    const directory = fs.mkdtempSync(path.resolve('test-output/hide-gap-'));
    const store = new Store(path.join(directory, 'memory.sqlite'));
    t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    store.setConfig({ summary: { url: 'http://model.local/v1', model: 'summary', key: 'k' } });
    const scope = { actor: 'character:alice.png', chat: 'gap', lineage: 'l' }, id = scopeId(scope);
    const messages = Array.from({ length: 30 }, (_, i) => [{ id: `u${i}`, role: 'user', name: '用户', text: `问 ${i}` }, { id: `a${i}`, role: 'assistant', name: '角色', text: `答 ${i}` }]).flat();
    store.sync(scope, messages, null);
    const engine = new Engine(store, { summarize: async (_, input) => `总结 ${input.kind} ${input.memory.turn}`, embed: async () => [] });
    const run = async () => { for (let i = 0; i < 400 && (engine.wake(), store.db.prepare("SELECT 1 FROM jobs WHERE status IN ('queued','running')").get() || engine.active.size); i++) await new Promise(resolve => setTimeout(resolve, 5)); };
    await run();
    const third = store.memories(id).find(m => m.kind === 'summary' && m.turn === 3);
    store.edit(id, third.id, { enabled: false });
    await run();
    const state = store.state(id);
    assert.ok(state.covered.some(([first, last]) => first === 1 && last === 2));
    assert.ok(state.covered.some(([first, last]) => first === 4 && last === 5));
    assert.ok(!state.covered.some(([first, last]) => first <= 3 && last >= 3));
    const targets = hideTargets(messages, state.covered, 20);
    assert.ok(!targets.has('u2') && !targets.has('a2'));
    assert.ok(targets.has('u0') && targets.has('a0') && targets.has('u3') && targets.has('a3'));
});

test('clear/edit and background state updates reconcile autoHide immediately without reopening chat', async () => {
    const h = harness();
    let covered = [[1, 3]];
    let version = 0;
    const baseFetch = h.host.fetch;
    h.host.fetch = async (url, init) => {
        if (url.endsWith('/clear')) { covered = []; return Response.json({ revision: `r${version}`, counts: {}, total: 0, covered }); }
        if (url.endsWith('/sync')) version++;
        if (url.endsWith('/state') || url.endsWith('/sync')) return Response.json({ revision: `r${version}`, counts: {}, total: covered.length, covered });
        return baseFetch(url, init);
    };
    await h.reopen();
    assert.deepEqual(h.hidden(), [true, true, true, true, true, true, false, false]);
    // Clearing memories while already synced must unhide plugin-hidden floors right away.
    await h.runtime.request('clear');
    assert.deepEqual(h.hidden(), [false, false, false, false, false, false, false, false]);
    // Background polling receiving newly covered turns hides them right away too.
    covered = [[1, 2]];
    await h.runtime.request('state');
    await settle();
    assert.deepEqual(h.hidden(), [true, true, true, true, false, false, false, false]);
});

test('auto-hidden unmerged summaries preserve userText while manually hidden turns stay masked', async () => {
    const { compressHistory } = await import('../client/prompt.js');
    const source = [
        { id: 'u0', role: 'user', name: 'U', text: '手动隐藏输入', hidden: true },
        { id: 'a0', role: 'assistant', name: 'A', text: '手动隐藏回复', hidden: true },
        { id: 'u1', role: 'user', name: 'U', text: '自动隐藏输入', hidden: true, autoHidden: true },
        { id: 'a1', role: 'assistant', name: 'A', text: '自动隐藏回复', hidden: true, autoHidden: true },
        { id: 'u2', role: 'user', name: 'U', text: '带附件的可见输入', protected: true },
        { id: 'a2', role: 'assistant', name: 'A', text: '仅回复自动隐藏', hidden: true, autoHidden: true },
        { id: 'u3', role: 'user', name: 'U', text: '当前输入' },
    ];
    const summaries = [
        { id: 's0', kind: 'summary', turn: 1, ids: ['u0', 'a0'], sourceUserIds: ['u0'], sourceAssistantIds: ['a0'], userText: '手动隐藏输入', summary: '总结1', enabled: true },
        { id: 's1', kind: 'summary', turn: 2, ids: ['u1', 'a1'], sourceUserIds: ['u1'], sourceAssistantIds: ['a1'], userText: '自动隐藏输入', summary: '总结2', enabled: true },
        { id: 's2', kind: 'summary', turn: 3, ids: ['u2', 'a2'], sourceUserIds: ['u2'], sourceAssistantIds: ['a2'], userText: '带附件的可见输入', summary: '总结3', enabled: true },
    ];
    const history = source.filter(m => !m.hidden).map(m => ({ id: m.id, role: m.role, content: m.text }));
    const out = compressHistory(history, source, { summaries, groups: [] }, 20, true).messages;
    assert.deepEqual(out.map(m => [m.role, m.content]), [
        ['user', '总结记忆 第 1 轮'], ['assistant', '总结1'],
        ['user', '自动隐藏输入'], ['assistant', '总结2'],
        ['user', '带附件的可见输入'], ['assistant', '总结3'],
        ['user', '当前输入'],
    ]);
});

test('partial-visible multi-user turns, protected visible replies, and consecutive auto-hidden turns assemble cleanly', async () => {
    const { compressHistory } = await import('../client/prompt.js');
    // Case 1: two user messages in same turn (one visible attachment + one auto-hidden) in both orders
    // Case 2: visible protected assistant reply + auto-hidden user input (must NOT duplicate with summary)
    // Case 3: visible protected assistant reply + manually hidden user input (must NOT restore user or duplicate summary)
    // Case 4: two consecutive auto-hidden unmerged turns right before a visible turn (must NOT merge users across turns)
    const source = [
        { id: 'u1a', role: 'user', name: 'U', text: '首句带附件', protected: true },
        { id: 'u1b', role: 'user', name: 'U', text: '同轮补充句', hidden: true, autoHidden: true },
        { id: 'a1', role: 'assistant', name: 'A', text: '回复1', hidden: true, autoHidden: true },
        { id: 'u2a', role: 'user', name: 'U', text: '先藏后见-前句', hidden: true, autoHidden: true },
        { id: 'u2b', role: 'user', name: 'U', text: '先藏后见-附件句', protected: true },
        { id: 'a2', role: 'assistant', name: 'A', text: '回复2', hidden: true, autoHidden: true },
        { id: 'u3', role: 'user', name: 'U', text: '用户自动藏', hidden: true, autoHidden: true },
        { id: 'a3', role: 'assistant', name: 'A', text: '带图回复保持可见', protected: true },
        { id: 'u4', role: 'user', name: 'U', text: '用户手动藏', hidden: true },
        { id: 'a4', role: 'assistant', name: 'A', text: '另一带图回复可见', protected: true },
        { id: 'u5', role: 'user', name: 'U', text: '连续自动藏A', hidden: true, autoHidden: true },
        { id: 'a5', role: 'assistant', name: 'A', text: '回复5', hidden: true, autoHidden: true },
        { id: 'u6', role: 'user', name: 'U', text: '连续自动藏B', hidden: true, autoHidden: true },
        { id: 'a6', role: 'assistant', name: 'A', text: '回复6', hidden: true, autoHidden: true },
        { id: 'u7', role: 'user', name: 'U', text: '最新可见问' },
        { id: 'a7', role: 'assistant', name: 'A', text: '最新可见答' },
    ];
    const summaries = [
        { id: 's1', kind: 'summary', turn: 1, ids: ['u1a', 'u1b', 'a1'], sourceUserIds: ['u1a', 'u1b'], sourceAssistantIds: ['a1'], userText: '首句带附件\n\n同轮补充句', summary: '总结1', enabled: true },
        { id: 's2', kind: 'summary', turn: 2, ids: ['u2a', 'u2b', 'a2'], sourceUserIds: ['u2a', 'u2b'], sourceAssistantIds: ['a2'], userText: '先藏后见-前句\n\n先藏后见-附件句', summary: '总结2', enabled: true },
        { id: 's3', kind: 'summary', turn: 3, ids: ['u3', 'a3'], sourceUserIds: ['u3'], sourceAssistantIds: ['a3'], userText: '用户自动藏', summary: '总结3不应重复', enabled: true },
        { id: 's4', kind: 'summary', turn: 4, ids: ['u4', 'a4'], sourceUserIds: ['u4'], sourceAssistantIds: ['a4'], userText: '用户手动藏', summary: '总结4不应重复', enabled: true },
        { id: 's5', kind: 'summary', turn: 5, ids: ['u5', 'a5'], sourceUserIds: ['u5'], sourceAssistantIds: ['a5'], userText: '连续自动藏A', summary: '总结5', enabled: true },
        { id: 's6', kind: 'summary', turn: 6, ids: ['u6', 'a6'], sourceUserIds: ['u6'], sourceAssistantIds: ['a6'], userText: '连续自动藏B', summary: '总结6', enabled: true },
    ];
    const history = source.filter(m => !m.hidden).map(m => ({ id: m.id, role: m.role, content: m.text }));
    const out = compressHistory(history, source, { summaries, groups: [] }, 20, true).messages;
    assert.deepEqual(out.map(m => [m.role, m.content]), [
        ['user', '首句带附件'], ['user', '同轮补充句'], ['assistant', '总结1'],
        ['user', '先藏后见-前句'], ['user', '先藏后见-附件句'], ['assistant', '总结2'],
        ['user', '用户自动藏'], ['assistant', '带图回复保持可见'],
        ['assistant', '另一带图回复可见'],
        ['user', '连续自动藏A'], ['assistant', '总结5'],
        ['user', '连续自动藏B'], ['assistant', '总结6'],
        ['user', '最新可见问'], ['assistant', '最新可见答'],
    ]);
});

test('background state updates hide newly summarized turns and return the synchronized revision', async () => {
    const h = harness(); h.server.covered = [];
    await h.reopen(); assert.ok(h.hidden().every(hidden => !hidden));
    h.server.covered = [[1, 1]];
    const before = h.runtime.session.revision, result = await h.runtime.request('state');
    assert.deepEqual(h.hidden(), [true, true, false, false, false, false, false, false]);
    assert.notEqual(result.revision, before);
    assert.equal(result.revision, h.runtime.session.revision);
    assert.ok(h.runtime.session.messages[0].hidden);
});

test('clearing memories restores automatic hides before returning and leaves manual hides alone', async () => {
    const h = harness(); h.ctx.chat[7].is_system = true;
    await h.reopen();
    const base = h.host.fetch;
    h.host.fetch = async (url, init) => {
        if (url.endsWith('/clear')) { h.server.covered = []; return Response.json({ revision: h.runtime.session.revision, covered: [], paused: true }); }
        return base(url, init);
    };
    const result = await h.runtime.request('clear');
    assert.deepEqual(h.hidden(), [false, false, false, false, false, false, false, true]);
    assert.equal(result.revision, h.runtime.session.revision);
    assert.ok(h.runtime.session.messages.slice(0, 7).every(m => !m.hidden));
});

test('a state from another page cannot become the revision of an older local snapshot', async () => {
    const h = harness(); await h.reopen();
    const before = h.runtime.session.revision, base = h.host.fetch;
    h.host.fetch = (url, init) => url.endsWith('/state') ? Promise.resolve(Response.json({ revision: 'another-page', covered: [] })) : base(url, init);
    await assert.rejects(h.runtime.request('state'), /其他页面更新/);
    assert.equal(h.runtime.session.revision, before);
    assert.equal(h.hidden()[0], true);
});
