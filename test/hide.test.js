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
        if (url.endsWith('/sync') || url.endsWith('/state')) return Response.json({ revision: `r${++version}`, counts: {}, total: 0, covered: server.covered });
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
