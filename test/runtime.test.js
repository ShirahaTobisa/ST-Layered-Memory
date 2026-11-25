import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../client/runtime.js';
import { KEY, VERSION } from '../shared/model.js';

function harness(view) {
    const listeners = new Map(), types = Object.fromEntries(['GROUP_WRAPPER_STARTED', 'GROUP_WRAPPER_FINISHED', 'WORLDINFO_ENTRIES_LOADED', 'CHAT_COMPLETION_SETTINGS_READY', 'GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'STREAM_TOKEN_RECEIVED', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'CHAT_CHANGED', 'CHAT_RENAMED', 'CHAT_DELETED', 'GROUP_CHAT_DELETED'].map(t => [t, t]));
    const events = { on(type, callback) { listeners.set(type, [...listeners.get(type) || [], callback]); }, async emit(type, ...args) { for (const callback of listeners.get(type) || []) await callback(...args); } };
    const ctx = { chatId: 'chat', characters: [{ avatar: 'alice.png' }], characterId: 0, groupId: null, name1: 'User', name2: 'Alice',
        chat: [{ name: 'User', is_user: true, mes: 'hello' }, { name: 'Alice', is_user: false, mes: 'reply' }], chatMetadata: {}, extensionSettings: { [KEY]: { enabled: false } },
        getRequestHeaders: () => ({ 'content-type': 'application/json' }), saveChat: async () => {}, saveMetadata: async () => {}, registerFunctionTool: tool => { ctx.tool = tool; },
        eventSource: events, eventTypes: types, getTokenCountAsync: async text => text.length, chatCompletionSettings: { openai_max_context: 10000, openai_max_tokens: 1000 },
    };
    const requests = [], notices = [];
    let version = 0;
    const host = { crypto, fetch: async (url, init) => {
        const body = JSON.parse(init.body); requests.push({ url, body });
        if (url.endsWith('/sync')) return Response.json({ revision: `r${++version}`, total: 0, counts: {} });
        if (url.endsWith('/status')) return Response.json({ version: VERSION, config: { keep: 2, budget: 1000 } });
        if (url.endsWith('/plan')) return Response.json({ summaries: [], groups: [], recall: [], warnings: [] });
        return Response.json({ revision: 'remote-revision', matches: [] });
    } };
    const runtime = createRuntime(() => ctx, host, (type, value) => notices.push({ type, value }), view);
    return { runtime, ctx, host, events, requests, notices };
}

test('source IDs survive reload; a freshly read chat is the truth and later handoffs only carry what changed', async () => {
    const h = harness();
    h.ctx.chat[0].extra = { files: [{ url: 'notes.txt' }] };
    await h.runtime.sync();
    const first = h.requests.find(r => r.url.endsWith('/sync')).body;
    assert.equal(first.revision, null); assert.ok(first.scope.lineage);
    assert.equal(first.messages[0].protected, true);
    const ids = h.ctx.chat.map(m => m.extra[KEY].id), handoffs = () => h.requests.filter(r => r.url.endsWith('/sync')).length;
    assert.deepEqual(h.ctx.chatMetadata[KEY], { lineage: first.scope.lineage, chat: 'chat' });
    await h.runtime.sync();
    assert.equal(handoffs(), 1);
    h.ctx.chat[1].mes = 'reply edited';
    await h.runtime.sync();
    assert.deepEqual(h.ctx.chat.map(m => m.extra[KEY].id), ids);
    assert.equal(h.requests.at(-1).body.revision, 'r1');
    assert.deepEqual(h.requests.at(-1).body.messages.map(m => typeof m), ['string', 'object']);
    // A chat file restored from a backup or synced from another device still carries an old revision.
    h.ctx.chatMetadata[KEY].revision = 'old-local';
    await h.events.emit('CHAT_CHANGED'); await h.runtime.sync();
    assert.equal(h.requests.at(-1).body.revision, null);
    assert.ok(h.requests.at(-1).body.messages.every(m => typeof m === 'object'));
});

test('quiet generations leave the main prompt alone', async () => {
    const h = harness(); h.ctx.extensionSettings[KEY].enabled = true;
    const body = { type: 'quiet', messages: [{ role: 'user', content: 'quiet' }] }, original = structuredClone(body);
    await h.events.emit('CHAT_COMPLETION_SETTINGS_READY', body); assert.deepEqual(body, original); assert.equal(h.requests.length, 0);
});

test('disabled extension leaves requests alone; backend errors leave original enabled requests intact', async () => {
    const h = harness(), body = { type: 'normal', messages: [{ role: 'user', content: 'hello' }] };
    await h.events.emit('CHAT_COMPLETION_SETTINGS_READY', body); assert.equal(h.requests.length, 0);
    h.ctx.extensionSettings[KEY].enabled = true;
    h.host.fetch = async () => new Response('', { status: 404 });
    const original = structuredClone(body);
    await h.events.emit('CHAT_COMPLETION_SETTINGS_READY', body);
    assert.deepEqual(body, original); assert.match(h.notices.at(-1).value, /后端未安装/);
});

test('chat switch during handoff cannot overwrite new chat metadata or attribute old results to it', async () => {
    const h = harness();
    await h.runtime.connect();
    h.host.fetch = async () => {
        h.ctx.chatId = 'new-chat'; h.ctx.chat = []; h.ctx.chatMetadata = {};
        return Response.json({ revision: 'old-result' });
    };
    await assert.rejects(h.runtime.sync(), /聊天已切换/);
    assert.deepEqual(h.ctx.chatMetadata, {});
});

test('chat-specific switches persist independently and pause handed-off work', async () => {
    const h = harness();
    await h.runtime.setEnabled(true);
    const firstMetadata = h.ctx.chatMetadata, firstChat = h.ctx.chat;
    assert.equal(firstMetadata[KEY].enabled, true);
    assert.equal(h.ctx.extensionSettings[KEY].enabled, false);
    h.ctx.chatId = 'other'; h.ctx.chat = []; h.ctx.chatMetadata = {};
    await h.events.emit('CHAT_CHANGED');
    assert.equal(h.runtime.enabled, false);
    h.ctx.chatId = 'chat'; h.ctx.chat = firstChat; h.ctx.chatMetadata = firstMetadata;
    await h.events.emit('CHAT_CHANGED');
    await h.runtime.setEnabled(false);
    assert.equal(h.runtime.enabled, false);
    assert.equal(h.requests.at(-1).body.paused, true);
    h.ctx.chatMetadata[KEY].enabled = true;
    h.host.fetch = async () => { throw new Error('offline'); };
    await assert.rejects(h.runtime.setEnabled(false), /已关闭记忆.*尚未确认/);
    assert.equal(h.runtime.enabled, false);
});

test('ST history hook compresses before prompt budgeting while preserving WI input and recent speaker/media metadata', async () => {
    const h = harness(); h.ctx.extensionSettings[KEY].enabled = true;
    h.ctx.chat = Array.from({ length: 4 }, (_, i) => [
        { is_user: true, name: 'User', mes: `question ${i}` },
        { is_user: false, name: 'Alice', mes: `answer ${i}` },
    ]).flat();
    h.ctx.chat.push({ is_user: false, name: 'Bob', mes: 'recent second speaker', extra: { media: [{ url: 'image.png' }] } });
    const fallbackFetch = h.host.fetch;
    h.host.fetch = async (url, init) => {
        if (url.endsWith('/plan')) return Response.json({ groups: [], recall: [], warnings: [], summaries: Array.from({ length: 4 }, (_, i) => ({
            id: `m${i}`, turn: i + 1, summary: `summary ${i}`, sourceAssistantIds: [h.ctx.chat[i * 2 + 1].extra[KEY].id],
        })) });
        return fallbackFetch(url, init);
    };
    const history = h.ctx.chat.map((m, index) => ({ ...structuredClone(m), index }));
    let counted = 0; h.ctx.getTokenCountAsync = async text => { counted++; return text.length; };
    await h.host.layeredMemoryInterceptor(history, 10000, () => {}, 'normal');
    const wiInput = history.map(m => m.mes).reverse();
    const saved = structuredClone(h.ctx.chat);
    await h.events.emit('WORLDINFO_ENTRIES_LOADED');
    assert.equal(history[1].mes, 'summary 0');
    assert.equal(history[5].mes, 'summary 2');
    assert.equal(history[7].mes, 'answer 3');
    assert.equal(history[8].name, 'Bob');
    assert.deepEqual(history[8].extra.media, [{ url: 'image.png' }]);
    assert.ok(wiInput.includes('answer 0'));
    assert.deepEqual(h.ctx.chat, saved);
    const body = { type: 'normal', messages: history.map(m => ({ role: m.is_user ? 'user' : 'assistant', content: m.mes })) };
    await h.events.emit('CHAT_COMPLETION_SETTINGS_READY', body);
    assert.equal(h.notices.at(-1).value.used.length, 3);
    assert.equal(body.messages[1].content, 'summary 0');
    assert.equal(counted, 0);
});

test('a queued chat sync and enable action never move to a newly opened chat', async () => {
    const h = harness();
    const oldChat = h.ctx.chat;
    const pending = h.runtime.sync();
    h.ctx.chatId = 'new'; h.ctx.chat = []; h.ctx.chatMetadata = {};
    await assert.rejects(pending, /聊天已切换/);
    assert.equal(h.requests.filter(r => r.url.endsWith('/sync')).length, 0);
    assert.deepEqual(oldChat.map(m => m.extra), [undefined, undefined]);
    const base = h.host.fetch;
    h.host.fetch = async (url, init) => {
        const result = await base(url, init);
        if (url.endsWith('/status')) { h.ctx.chatId = 'another'; h.ctx.chat = []; h.ctx.chatMetadata = {}; }
        return result;
    };
    await assert.rejects(h.runtime.setEnabled(true), /聊天已切换/);
    assert.equal(h.requests.filter(r => r.url.endsWith('/pause')).length, 0);
});

test('automatic handoff checks backend version before writing snapshots', async () => {
    const h = harness(); h.ctx.extensionSettings[KEY].enabled = true;
    const base = h.host.fetch;
    h.host.fetch = async (url, init) => url.endsWith('/status') ? Response.json({ version: 'incompatible', config: {} }) : base(url, init);
    await assert.rejects(h.runtime.sync(), /版本不一致/);
    assert.equal(h.requests.filter(r => r.url.endsWith('/sync')).length, 0);
});

test('recall added after history compression respects the final prompt capacity', async () => {
    const h = harness(); h.ctx.extensionSettings[KEY].enabled = true;
    const base = h.host.fetch;
    h.host.fetch = async (url, init) => url.endsWith('/plan')
        ? Response.json({ summaries: [], groups: [], recall: [{ turn: 1, score: 1, summary: 'x'.repeat(12000) }], warnings: [] }) : base(url, init);
    const history = h.ctx.chat.map((m, index) => ({ ...structuredClone(m), index }));
    await h.host.layeredMemoryInterceptor(history, 10000, () => {}, 'normal');
    await h.events.emit('WORLDINFO_ENTRIES_LOADED');
    const body = { type: 'normal', messages: history.map(m => ({ role: m.is_user ? 'user' : 'assistant', content: m.mes })) };
    const original = structuredClone(body);
    await h.events.emit('CHAT_COMPLETION_SETTINGS_READY', body);
    assert.deepEqual(body, original); assert.match(h.notices.at(-1).value, /超过当前上下文/);
});

test('a memory is not used for a message that changed while retrieval was pending', async () => {
    const h = harness(); h.ctx.extensionSettings[KEY].enabled = true;
    h.ctx.chat.push({ is_user: true, name: 'User', mes: 'new question' }, { is_user: false, name: 'Alice', mes: 'new answer' });
    const base = h.host.fetch;
    h.host.fetch = async (url, init) => {
        if (!url.endsWith('/plan')) return base(url, init);
        h.ctx.chat[1].mes = 'edited during retrieval';
        return Response.json({ summaries: [{ id: 'stale', sourceAssistantIds: [h.ctx.chat[1].extra[KEY].id], summary: 'stale memory' }], groups: [], recall: [] });
    };
    const history = h.ctx.chat.map((m, index) => ({ ...structuredClone(m), index }));
    const original = structuredClone(history);
    await h.host.layeredMemoryInterceptor(history, 10000, () => {}, 'normal');
    await h.events.emit('WORLDINFO_ENTRIES_LOADED');
    assert.deepEqual(history.map(m => m.mes), original.map(m => m.mes));
});

test('the fallback can compress the first request before source IDs were saved', async () => {
    const h = harness(); h.ctx.extensionSettings[KEY].enabled = true;
    h.ctx.chat.push({ is_user: true, mes: 'second question' }, { is_user: false, mes: 'second answer' }, { is_user: true, mes: 'new question' }, { is_user: false, mes: 'new answer' });
    const base = h.host.fetch;
    h.host.fetch = async (url, init) => url.endsWith('/plan') ? Response.json({ summaries: [{ id: 's', sourceAssistantIds: [h.ctx.chat[1].extra[KEY].id], summary: 'valid memory' }], groups: [], recall: [] }) : base(url, init);
    const body = { type: 'normal', messages: h.ctx.chat.map(m => ({ role: m.is_user ? 'user' : 'assistant', content: m.mes })) };
    await h.events.emit('CHAT_COMPLETION_SETTINGS_READY', body);
    assert.equal(body.messages[1].content, 'valid memory');
});

test('legacy source IDs survive migration and a branch declares its actual parent', async () => {
    const h = harness();
    h.ctx.chatMetadata = { main_chat: 'parent', rph_memory: { lineage: 'legacy-lineage', chat: 'chat', revision: 'old' } };
    for (const [index, message] of h.ctx.chat.entries()) message.extra = { rph_memory: { id: `old-${index}` } };
    let saved = 0; h.ctx.saveChat = async () => { saved++; };
    await h.runtime.sync();
    assert.equal(saved, 1);
    const body = h.requests.find(r => r.url.endsWith('/sync')).body;
    assert.equal(body.parentChat, 'parent'); assert.equal(body.scope.lineage, 'legacy-lineage');
    assert.deepEqual(body.messages.map(m => m.id), ['old-0', 'old-1']);
});

test('disabling waits for in-flight handoff before pausing its latest revision', async () => {
    const h = harness(); h.ctx.extensionSettings[KEY].enabled = true;
    await h.runtime.sync();
    const base = h.host.fetch;
    let release, started;
    const ready = new Promise(resolve => { started = resolve; });
    h.host.fetch = async (url, init) => {
        if (url.endsWith('/sync')) { started(); return new Promise(resolve => { release = resolve; }); }
        return base(url, init);
    };
    h.ctx.chat[1].mes = 'changed';
    const syncing = h.runtime.sync(); await ready;
    const disabling = h.runtime.setEnabled(false);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(h.requests.filter(r => r.url.endsWith('/pause')).length, 0);
    release(Response.json({ revision: 'latest', counts: {} }));
    await syncing; await disabling;
    const paused = h.requests.find(r => r.url.endsWith('/pause'));
    assert.equal(paused.body.revision, 'latest'); assert.equal(paused.body.paused, true);
});

test('hidden dialogue keeps its original role while system notices, comments and tools stay excluded', async () => {
    const h = harness();
    h.ctx.chat[0].is_system = true; h.ctx.chat[1].is_system = true;
    h.ctx.chat.push(
        { name: 'SillyTavern System', is_system: true, mes: 'system notice' },
        { name: 'Comment', is_system: true, mes: 'private comment', extra: { type: 'comment' } },
        { name: 'Alice', is_system: true, mes: 'tool intermediate', extra: { tool_invocations: [{ name: 'tool' }] } },
        { name: 'Narrator', is_system: true, mes: 'story narration', extra: { type: 'narrator' } },
    );
    await h.runtime.sync();
    const messages = h.requests.find(r => r.url.endsWith('/sync')).body.messages;
    assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'system', 'system', 'system', 'assistant']);
    assert.deepEqual(messages.map(m => !!m.hidden), [true, true, false, false, false, true]);
});

test('the main history hook uses hidden memories before token budgeting without unhiding messages', async () => {
    const h = harness(); h.ctx.extensionSettings[KEY].enabled = true;
    h.ctx.chat[0].is_system = true; h.ctx.chat[1].is_system = true;
    h.ctx.chat.push({ name: 'User', is_user: true, mes: '上上轮' }, { name: 'Alice', is_user: false, mes: '上上轮的回复' }, { name: 'User', is_user: true, mes: '上一轮' }, { name: 'Alice', is_user: false, mes: '上一轮的回复' }, { name: 'User', is_user: true, mes: '继续剧情' });
    const base = h.host.fetch;
    h.host.fetch = async (url, init) => url.endsWith('/plan') ? Response.json({ groups: [], recall: [], warnings: [], summaries: [{
        id: 'hidden-summary', turn: 1, ids: h.ctx.chat.slice(0, 2).map(m => m.extra[KEY].id), summary: '隐藏消息的记忆', enabled: true,
    }] }) : base(url, init);
    const history = h.ctx.chat.filter(m => !m.is_system).map((m, index) => ({ ...structuredClone(m), index }));
    await h.host.layeredMemoryInterceptor(history, 10000, () => {}, 'normal');
    const wiInput = history.map(m => m.mes);
    await h.events.emit('WORLDINFO_ENTRIES_LOADED');
    assert.ok(history.some(m => m.mes === '隐藏消息的记忆'));
    assert.deepEqual(wiInput, ['上上轮', '上上轮的回复', '上一轮', '上一轮的回复', '继续剧情']);
    assert.equal(history.at(-1).mes, '继续剧情');
    assert.ok(h.ctx.chat.slice(0, 2).every(m => m.is_system));
    assert.ok(!history.some(m => ['hello', 'reply'].includes(m.mes)));
    const body = { type: 'normal', messages: history.map(m => ({ role: m.is_user ? 'user' : 'assistant', content: m.mes })) };
    await h.events.emit('CHAT_COMPLETION_SETTINGS_READY', body);
    assert.equal(body.messages.filter(m => m.content === '隐藏消息的记忆').length, 1);
});

test('messages deleted one after another are handed over once the chat has settled', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = harness(); h.ctx.extensionSettings[KEY].enabled = true;
    h.ctx.chat.push({ name: 'User', is_user: true, mes: 'second' }, { name: 'Alice', is_user: false, mes: 'second reply' });
    await h.runtime.sync();
    const handoffs = () => h.requests.filter(r => r.url.endsWith('/sync'));
    h.ctx.chat.splice(2, 1); await h.events.emit('MESSAGE_DELETED', 3);
    h.ctx.chat.splice(2, 1); await h.events.emit('MESSAGE_DELETED', 2);
    assert.equal(handoffs().length, 1);
    t.mock.timers.tick(1500);
    await h.runtime.sync();
    assert.equal(handoffs().length, 2); assert.equal(handoffs()[1].body.messages.length, 2);
});

test('renames, deletions and copies tell the server which chat the memories belong to', async () => {
    const h = harness();
    await h.events.emit('CHAT_RENAMED', { avatarId: 'alice.png', oldFileName: 'old.jsonl', newFileName: 'new.jsonl' });
    assert.deepEqual(h.requests.at(-1), { url: '/api/plugins/layered-memory/rename', body: { actor: 'character:alice.png', from: 'old', to: 'new' } });
    await h.events.emit('CHAT_DELETED', 'gone');
    assert.deepEqual(h.requests.at(-1), { url: '/api/plugins/layered-memory/forget', body: { actor: 'character:alice.png', chat: 'gone' } });
    h.ctx.chatMetadata = { main_chat: 'origin', [KEY]: { lineage: 'family', chat: 'copied from' } };
    await h.runtime.sync();
    assert.equal(h.requests.at(-1).body.parentChat, 'copied from');
    assert.equal(h.ctx.chatMetadata[KEY].chat, 'chat');
});

test('a handoff the server cannot follow is repeated in full', async () => {
    const h = harness();
    await h.runtime.sync();
    h.ctx.chat[1].mes = 'changed';
    const base = h.host.fetch;
    let refused = 0;
    h.host.fetch = async (url, init) => {
        if (!url.endsWith('/sync') || JSON.parse(init.body).messages.every(m => typeof m === 'object')) return base(url, init);
        refused++; return Response.json({ error: 'conflict' }, { status: 409 });
    };
    await h.runtime.sync();
    assert.equal(refused, 1); assert.deepEqual(h.requests.at(-1).body.messages.map(m => m.text), ['hello', 'changed']);
});

test('a script rewriting the new message mid-request neither discards the plan nor compresses the history twice', async () => {
    const h = harness(); h.ctx.extensionSettings[KEY].enabled = true;
    h.ctx.chat[0].is_system = true; h.ctx.chat[1].is_system = true;
    h.ctx.chat.push({ name: 'User', is_user: true, mes: 'old question' }, { name: 'Alice', is_user: false, mes: 'old answer' }, { name: 'User', is_user: true, mes: 'newer question' }, { name: 'Alice', is_user: false, mes: 'newer answer' },
        { name: 'User', is_user: true, mes: 'last question' }, { name: 'Alice', is_user: false, mes: 'last answer' }, { name: 'User', is_user: true, mes: 'what I really typed' });
    const base = h.host.fetch;
    h.host.fetch = async (url, init) => url.endsWith('/plan') ? Response.json({ groups: [], recall: [], warnings: [], summaries: [
        { id: 'hidden', turn: 1, ids: h.ctx.chat.slice(0, 2).map(m => m.extra[KEY].id), summary: 'memory of the hidden turn', enabled: true },
        { id: 'edited', turn: 2, ids: h.ctx.chat.slice(2, 4).map(m => m.extra[KEY].id), sourceAssistantIds: [h.ctx.chat[3].extra[KEY].id], summary: 'memory of the old answer', enabled: true },
    ] }) : base(url, init);
    const history = h.ctx.chat.filter(m => !m.is_system).map((m, index) => ({ ...structuredClone(m), index }));
    await h.host.layeredMemoryInterceptor(history, 10000, () => {}, 'normal');
    h.ctx.chat[8].mes = 'a fixed sentence written by a preset script';
    h.ctx.chat[3].mes = 'old answer, edited meanwhile';
    await h.events.emit('WORLDINFO_ENTRIES_LOADED');
    assert.equal(history.filter(m => m.mes === 'memory of the hidden turn').length, 1);
    assert.ok(history.some(m => m.mes === 'old answer') && !history.some(m => m.mes === 'memory of the old answer'));
    const handoffs = h.requests.filter(r => r.url.endsWith('/sync')).length;
    const body = { type: 'normal', messages: history.map(m => ({ role: m.is_user ? 'user' : 'assistant', content: m.mes })) };
    await h.events.emit('CHAT_COMPLETION_SETTINGS_READY', body);
    assert.equal(body.messages.filter(m => m.content === 'memory of the hidden turn').length, 1);
    assert.equal(h.requests.filter(r => r.url.endsWith('/sync')).length, handoffs);
    assert.match(h.notices.at(-1).value.reason, /已按规则压缩/);
});

test('each message carries the text it is sent as, worked out once per message text', async () => {
    let calls = 0;
    const h = harness(message => { calls++; return message.mes.replace(/<status>.*<\/status>/, ''); });
    h.ctx.chat[1].mes = 'reply<status>hp 3</status>';
    await h.runtime.sync();
    const first = h.requests.at(-1).body.messages;
    assert.deepEqual([first[1].text, first[1].view, first[0].view], ['reply<status>hp 3</status>', 'reply', undefined]);
    h.ctx.chat[0].mes = 'hello again';
    await h.runtime.sync();
    assert.equal(calls, 3);
    assert.deepEqual(h.requests.at(-1).body.messages.map(m => typeof m), ['object', 'string']);
});

test('opening a chat the server already holds uploads nothing', async () => {
    const h = harness();
    await h.runtime.sync();
    const first = h.requests.find(r => r.url.endsWith('/sync')).body.messages, base = h.host.fetch;
    const { createHash } = await import('node:crypto');
    const { storedMessage } = await import('../shared/model.js');
    const held = createHash('sha256').update(JSON.stringify(first.map(storedMessage))).digest('hex');
    h.host.fetch = async (url, init) => url.endsWith('/state') ? Response.json({ revision: held, counts: {} }) : base(url, init);
    await h.events.emit('CHAT_CHANGED');
    const state = await h.runtime.sync();
    assert.equal(h.requests.filter(r => r.url.endsWith('/sync')).length, 1);
    assert.equal(state.revision, held);
    h.ctx.chat[1].mes = 'changed after opening';
    await h.runtime.sync();
    assert.equal(h.requests.at(-1).body.revision, held);
    assert.deepEqual(h.requests.at(-1).body.messages.map(m => typeof m), ['string', 'object']);
});

test('the two newest turns are held back until later turns are complete', async () => {
    const h = harness();
    h.ctx.chat[1].extra = { gemini_reply: { complete: false, mode: 'plain', state: 'cancelled' } };
    h.ctx.chat.push({ name: 'User', is_user: true, mes: 'second' }, { name: 'Alice', is_user: false, mes: 'second reply' }, { name: 'User', is_user: true, mes: 'third' });
    await h.runtime.sync();
    assert.deepEqual(h.requests.at(-1).body.messages.map(m => !!m.held), [false, true, false, true, false]);
    h.ctx.chat.push({ name: 'Alice', is_user: false, mes: 'third reply' }, { name: 'Bob', is_user: false, mes: 'another speaker' });
    await h.runtime.sync();
    const sent = h.requests.at(-1).body.messages;
    assert.equal(sent[1].held, undefined); assert.equal(typeof sent[3], 'string');
    assert.deepEqual(sent.slice(5).map(m => m.held), [true, true]);
});

test('a reply costs no chat save of its own and is handed over once generation has ended', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = harness(); h.ctx.extensionSettings[KEY].enabled = true;
    h.ctx.chat.push({ name: 'User', is_user: true, mes: 'second' }, { name: 'Alice', is_user: false, mes: 'second reply' });
    await h.runtime.sync();
    let saves = 0; h.ctx.saveChat = h.ctx.saveMetadata = async () => { saves++; };
    const before = h.requests.length;
    h.ctx.chat.push({ name: 'User', is_user: true, mes: 'next' });
    await h.host.layeredMemoryInterceptor(h.ctx.chat.map((m, index) => ({ ...structuredClone(m), index })), 10000, () => {}, 'normal');
    h.ctx.chat.push({ name: 'Alice', is_user: false, mes: 'finished answer' });
    await h.events.emit('GENERATION_ENDED');
    t.mock.timers.tick(1500);
    await h.runtime.sync();
    const handoffs = h.requests.slice(before).filter(r => r.url.endsWith('/sync')).map(r => r.body.messages);
    assert.equal(saves, 0);
    assert.deepEqual(handoffs.map(messages => messages.map(m => typeof m)), [['string', 'string', 'string', 'string', 'object'], ['string', 'object', 'string', 'string', 'string', 'object']]);
    assert.deepEqual([handoffs[1][1].held, handoffs[1][5].held], [undefined, true]);
});

test('a request sent right after a memory change carries the revision that change left', async () => {
    const h = harness(); h.ctx.extensionSettings[KEY].enabled = true;
    await h.runtime.sync();
    h.ctx.chat[1].mes = 'reply edited';
    await h.runtime.request('retry');
    await h.runtime.request('list');
    assert.equal(h.requests.at(-1).body.revision, 'r2');
});

test('a chat with its memory off is not handed over; the switch is saved before the server is told', async () => {
    const h = harness(), base = h.host.fetch, handoffs = () => h.requests.filter(r => r.url.endsWith('/sync')).length;
    let saved;
    h.ctx.saveMetadata = async () => { saved = structuredClone(h.ctx.chatMetadata[KEY]); };
    h.host.fetch = async (url, init) => {
        if (url.endsWith('/state')) return Response.json({ revision: null });
        if (url.endsWith('/pause')) throw new Error('page closed');
        return base(url, init);
    };
    await assert.rejects(h.runtime.sync(), /未启用记忆/);
    await h.runtime.setEnabled(false);
    assert.equal(saved.enabled, false); assert.equal(handoffs(), 0);
    await assert.rejects(h.runtime.setEnabled(true), /page closed/);
    assert.equal(saved.enabled, true); assert.equal(h.runtime.enabled, true); assert.equal(handoffs(), 1);
});

test('LAN HTTP without crypto.subtle uses pure-JS SHA-256 fallback to avoid re-uploading unchanged chats', async () => {
    const { createHash } = await import('node:crypto');
    const { sha256Fallback } = await import('../client/runtime.js');
    for (const sample of ['', 'hello', '分层记忆中文测试：' + '长文本'.repeat(40)]) {
        assert.equal(sha256Fallback(new TextEncoder().encode(sample)), createHash('sha256').update(sample).digest('hex'));
    }
    const h = harness();
    h.host.crypto = { randomUUID: () => crypto.randomUUID() }; // no crypto.subtle
    await h.runtime.sync();
    const first = h.requests.find(r => r.url.endsWith('/sync')).body.messages, base = h.host.fetch;
    const { storedMessage } = await import('../shared/model.js');
    const held = createHash('sha256').update(JSON.stringify(first.map(storedMessage))).digest('hex');
    h.host.fetch = async (url, init) => url.endsWith('/state') ? Response.json({ revision: held, counts: {} }) : base(url, init);
    await h.events.emit('CHAT_CHANGED');
    const state = await h.runtime.sync();
    assert.equal(h.requests.filter(r => r.url.endsWith('/sync')).length, 1);
    assert.equal(state.revision, held);
});

test('held turn calculation respects system barriers just like turnsFrom', async () => {
    const h = harness();
    h.ctx.chat = [
        { name: 'User', is_user: true, mes: 't1' },
        { name: 'Alice', is_user: false, mes: 'a1' },
        { name: 'User', is_user: true, mes: 't2' },
        { name: 'Alice', is_user: false, mes: 'a2' },
        { name: 'User', is_user: true, mes: 't3' },
        { name: 'Alice', is_system: true, mes: 'tool', extra: { tool_invocations: [{ name: 't' }] } },
        { name: 'Alice', is_user: false, mes: 'orphan after tool' },
    ];
    await h.runtime.sync();
    const sent = h.requests.at(-1).body.messages;
    // Only 2 complete turns exist (t1/a1 and t2/a2), so both a1 and a2 must be held.
    assert.equal(sent[1].held, true);
    assert.equal(sent[3].held, true);
    assert.equal(sent[6].held, undefined);
});

test('both runtime prompt paths restore automatically hidden inputs without sending the local flag to the server', async () => {
    for (const normal of [false, true]) {
        const h = harness(); h.ctx.extensionSettings[KEY].enabled = true;
        h.ctx.chat.push({ name: 'User', is_user: true, mes: '现在呢' }, { name: 'Alice', is_user: false, mes: '现在的回复' });
        await h.runtime.sync();
        const [user, assistant] = h.ctx.chat;
        user.is_system = assistant.is_system = true;
        user.extra[KEY].autoHidden = assistant.extra[KEY].autoHidden = true;
        const memory = { id: 'summary', kind: 'summary', turn: 1, ids: [user.extra[KEY].id, assistant.extra[KEY].id], sourceAssistantIds: [assistant.extra[KEY].id], summary: '旧轮总结' };
        const base = h.host.fetch;
        h.host.fetch = (url, init) => url.endsWith('/plan') ? Promise.resolve(Response.json({ summaries: [memory] })) : base(url, init);
        let messages = h.ctx.chat.slice(2).map(m => ({ role: m.is_user ? 'user' : 'assistant', content: m.mes }));
        if (normal) {
            const history = h.ctx.chat.slice(2).map((m, index) => ({ ...m, index }));
            await h.host.layeredMemoryInterceptor(history, 10000, () => {}, 'normal');
            await h.events.emit('WORLDINFO_ENTRIES_LOADED');
            messages = history.map(m => ({ role: m.is_user ? 'user' : 'assistant', content: m.mes }));
        }
        const body = { type: 'normal', messages };
        await h.events.emit('CHAT_COMPLETION_SETTINGS_READY', body);
        assert.deepEqual(body.messages.slice(0, 2).map(m => m.content), ['hello', '旧轮总结']);
        assert.ok(!JSON.stringify(h.requests.filter(r => r.url.endsWith('/sync'))).includes('autoHidden'));
    }
});

test('holding the newest two turns respects system-message boundaries', async () => {
    const h = harness();
    h.ctx.chat.push({ name: 'User', is_user: true, mes: '没有配对的输入' },
        { name: 'SillyTavern System', is_system: true, mes: '边界' }, { name: 'Alice', is_user: false, mes: '没有配对的回复' },
        { name: 'User', is_user: true, mes: '第二轮' }, { name: 'Alice', is_user: false, mes: '第二轮回复' },
        { name: 'User', is_user: true, mes: '第三轮' }, { name: 'Alice', is_user: false, mes: '第三轮回复' });
    await h.runtime.sync();
    assert.deepEqual(h.runtime.session.messages.filter(m => m.held).map(m => m.text), ['第二轮回复', '第三轮回复']);
});

test('undefined message text is not falsely treated as protected and wrapped .mes nodes sync is_system', async () => {
    const h = harness(); h.ctx.extensionSettings[KEY].enabled = true;
    h.ctx.chat[1].mes = undefined;
    h.ctx.chat.push({ name: 'User', is_user: true, mes: '新问题' }, { name: 'Alice', is_user: false, mes: '新回复' });
    const attrs = new Map();
    const fakeNode = { getAttribute: k => k === 'mesid' ? '0' : attrs.get(k), setAttribute: (k, v) => attrs.set(k, v) };
    h.host.document = { querySelectorAll: selector => selector === '#chat .mes[mesid]' ? [fakeNode] : [] };
    const base = h.host.fetch;
    let planMemory;
    h.host.fetch = async (url, init) => {
        if (url.endsWith('/status')) return Response.json({ version: VERSION, config: { keep: 2, autoHide: true, citations: false } });
        if (url.endsWith('/sync')) return Response.json({ revision: 'r1', counts: {}, total: 1, covered: [[1, 1]] });
        if (url.endsWith('/state')) return Response.json({ revision: 'r1', counts: {}, total: 1, covered: [[1, 1]] });
        if (url.endsWith('/plan')) return Response.json({ summaries: [planMemory] });
        return base(url, init);
    };
    await h.runtime.sync();
    // Apply state to trigger tidy() on wrapped #chat .mes[mesid] node.
    await h.runtime.request('state');
    assert.equal(attrs.get('is_system'), 'true');
    // Un-hide so turn 1 stays visible and verify mes === undefined on assistant does NOT falsely mark it protected.
    h.ctx.chat[0].is_system = false; h.ctx.chat[1].is_system = false;
    delete h.ctx.chat[0].extra[KEY].autoHidden; delete h.ctx.chat[1].extra[KEY].autoHidden;
    planMemory = { id: 's1', kind: 'summary', turn: 1, ids: [h.ctx.chat[0].extra[KEY].id, h.ctx.chat[1].extra[KEY].id], sourceAssistantIds: [h.ctx.chat[1].extra[KEY].id], summary: '空原文总结' };
    const history = h.ctx.chat.map((m, idx) => ({ ...m, mes: m.mes ?? '' }));
    await h.host.layeredMemoryInterceptor(history, 10000, () => {}, 'normal');
    await h.events.emit('WORLDINFO_ENTRIES_LOADED');
    assert.equal(history[1].mes, '空原文总结');
});
