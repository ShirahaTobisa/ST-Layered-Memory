import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../client/runtime.js';
import { KEY, VERSION } from '../shared/model.js';

function harness() {
    const listeners = new Map(), types = Object.fromEntries(['GROUP_WRAPPER_STARTED', 'GROUP_WRAPPER_FINISHED', 'WORLDINFO_ENTRIES_LOADED', 'CHAT_COMPLETION_SETTINGS_READY', 'GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'STREAM_TOKEN_RECEIVED', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'CHAT_CHANGED'].map(t => [t, t]));
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
    const runtime = createRuntime(() => ctx, host, (type, value) => notices.push({ type, value }));
    return { runtime, ctx, host, events, requests, notices };
}

test('frontend source IDs and server revision survive reload; stale client never adopts remote revision blindly', async () => {
    const h = harness();
    h.ctx.chat[0].extra = { files: [{ url: 'notes.txt' }] };
    await h.runtime.sync();
    const first = h.requests.find(r => r.url.endsWith('/sync')).body;
    assert.equal(first.revision, null); assert.ok(first.scope.lineage);
    assert.equal(first.messages[0].protected, true);
    const ids = h.ctx.chat.map(m => m.extra[KEY].id);
    assert.equal(h.ctx.chatMetadata[KEY].revision, 'r1');
    await h.runtime.sync();
    assert.deepEqual(h.ctx.chat.map(m => m.extra[KEY].id), ids);
    assert.equal(h.requests.at(-1).body.revision, 'r1');
    h.ctx.chatMetadata[KEY].revision = 'old-local';
    await h.events.emit('CHAT_CHANGED'); await h.runtime.sync();
    assert.equal(h.requests.at(-1).body.revision, 'old-local');
});

test('unfinished Gemini/tool-stage messages are excluded, and edited replies remain excluded until confirmed', async () => {
    for (const anti of [{ complete: false, mode: 'tool' }, { complete: true, mode: 'tools' }, { complete: false, mode: 'plain', state: 'edited' }]) {
        const h = harness(); h.ctx.chat[1].extra = { gemini_reply: anti };
        await h.runtime.sync(); assert.equal(h.requests.at(-1).body.messages[1].blocked, true);
    }
});

test('quiet generations do not alter main prompt or finish an ongoing nonstream generation', async () => {
    const h = harness(); h.ctx.extensionSettings[KEY].enabled = true;
    const body = { type: 'quiet', messages: [{ role: 'user', content: 'quiet' }] }, original = structuredClone(body);
    await h.events.emit('CHAT_COMPLETION_SETTINGS_READY', body); assert.deepEqual(body, original); assert.equal(h.requests.length, 0);
    await h.events.emit('GENERATION_STARTED', 'normal', {}, false);
    h.ctx.chat.push({ is_user: true, mes: 'next' }, { is_user: false, mes: 'still receiving' });
    await h.events.emit('GENERATION_ENDED');
    await h.runtime.sync(); assert.equal(h.requests.at(-1).body.messages.at(-1).blocked, true);
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

test('ST generation-ended can precede message-received; successful final message still hands off', async () => {
    const h = harness(); h.ctx.extensionSettings[KEY].enabled = true;
    await h.events.emit('GENERATION_STARTED', 'normal', {}, false);
    h.ctx.chat.push({ is_user: true, mes: 'next' }, { is_user: false, mes: 'finished' });
    h.ctx.streamingProcessor = { messageId: 3, isFinished: true, abortController: new AbortController() };
    await h.events.emit('STREAM_TOKEN_RECEIVED');
    await h.events.emit('GENERATION_ENDED');
    await h.events.emit('MESSAGE_RECEIVED', 3, 'normal');
    await h.runtime.sync();
    assert.equal(h.requests.at(-1).body.messages[3].blocked, false);
});

test('stream failures stay excluded after lifecycle ends; manual confirmation applies only to current text', async () => {
    const h = harness(); h.ctx.extensionSettings[KEY].enabled = true;
    await h.events.emit('GENERATION_STARTED', 'normal', {}, false);
    h.ctx.chat.push({ is_user: true, mes: 'next' }, { is_user: false, mes: 'partial' });
    const controller = new AbortController(); controller.abort();
    h.ctx.streamingProcessor = { messageId: 3, isFinished: false, isStopped: true, abortController: controller };
    await h.events.emit('STREAM_TOKEN_RECEIVED');
    await h.events.emit('MESSAGE_RECEIVED', 3, 'normal');
    await h.runtime.sync(); assert.equal(h.requests.at(-1).body.messages[3].blocked, true);
    await h.runtime.approveLatest(); assert.equal(h.requests.at(-1).body.messages[3].blocked, false);
    h.ctx.chat[3].mes = 'different';
    await h.runtime.sync(); assert.equal(h.requests.at(-1).body.messages[3].blocked, true);
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
});

test('nonstream and continue replies wait for generation completion and persist cancellation', async () => {
    for (const type of ['normal', 'continue']) {
        const h = harness(); h.ctx.extensionSettings[KEY].enabled = true;
        await h.events.emit('GENERATION_STARTED', type, {}, false);
        if (type === 'normal') h.ctx.chat.push({ is_user: true, mes: 'next' }, { is_user: false, mes: 'answer' });
        const index = h.ctx.chat.length - 1;
        h.ctx.chat[index].swipe_id = 0; h.ctx.chat[index].swipe_info = [{ extra: {} }];
        await h.events.emit('MESSAGE_RECEIVED', index, type === 'continue' ? 'appendFinal' : type);
        await h.runtime.sync();
        assert.equal(h.requests.at(-1).body.messages[index].blocked, true);
        await h.events.emit('GENERATION_ENDED'); await h.runtime.sync();
        assert.equal(h.requests.at(-1).body.messages[index].blocked, false);
    }
    const h = harness(); h.ctx.extensionSettings[KEY].enabled = true;
    h.ctx.chat[1].swipe_id = 0; h.ctx.chat[1].swipe_info = [{ extra: {} }];
    await h.runtime.sync();
    await h.events.emit('GENERATION_STARTED', 'continue', {}, false);
    h.ctx.chat[1].mes += ' partial';
    let saved = 0; h.ctx.saveChat = async () => { saved++; };
    h.ctx.chatMetadata[KEY].enabled = false;
    await h.events.emit('GENERATION_STOPPED');
    await h.runtime.sync();
    assert.ok(saved > 0);
    assert.equal(h.ctx.chat[1].swipe_info[0].extra[KEY].blocked, h.ctx.chat[1].mes);
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

test('group replies remain blocked until the whole group batch finishes', async () => {
    const h = harness(); h.ctx.groupId = 'group'; h.ctx.extensionSettings[KEY].enabled = true;
    await h.events.emit('GROUP_WRAPPER_STARTED', { type: 'normal' });
    h.ctx.chat.push({ is_user: true, mes: 'group question' });
    await h.events.emit('GENERATION_STARTED', 'normal', {}, false);
    h.ctx.chat.push({ is_user: false, mes: 'first speaker' });
    await h.events.emit('MESSAGE_RECEIVED', 3, 'normal'); await h.events.emit('GENERATION_ENDED');
    await h.runtime.sync(); assert.equal(h.requests.at(-1).body.messages[3].blocked, true);
    await h.events.emit('GROUP_WRAPPER_FINISHED');
    await h.runtime.sync(); assert.equal(h.requests.at(-1).body.messages[3].blocked, false);
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

test('history plans are discarded if sources change while retrieval is pending', async () => {
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
    assert.deepEqual(history, original);
});

test('the fallback can compress the first request before source IDs were saved', async () => {
    const h = harness(); h.ctx.extensionSettings[KEY].enabled = true;
    h.ctx.chat.push({ is_user: true, mes: 'new question' }, { is_user: false, mes: 'new answer' });
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
    h.ctx.chat.push({ name: 'User', is_user: true, mes: '继续剧情' });
    const base = h.host.fetch;
    h.host.fetch = async (url, init) => url.endsWith('/plan') ? Response.json({ groups: [], recall: [], warnings: [], summaries: [{
        id: 'hidden-summary', turn: 1, ids: h.ctx.chat.slice(0, 2).map(m => m.extra[KEY].id), summary: '隐藏消息的记忆', enabled: true,
    }] }) : base(url, init);
    const history = h.ctx.chat.filter(m => !m.is_system).map((m, index) => ({ ...structuredClone(m), index }));
    await h.host.layeredMemoryInterceptor(history, 10000, () => {}, 'normal');
    const wiInput = history.map(m => m.mes);
    await h.events.emit('WORLDINFO_ENTRIES_LOADED');
    assert.ok(history.some(m => m.mes === '隐藏消息的记忆'));
    assert.deepEqual(wiInput, ['继续剧情']);
    assert.equal(history.at(-1).mes, '继续剧情');
    assert.ok(h.ctx.chat.slice(0, 2).every(m => m.is_system));
    assert.ok(!history.some(m => ['hello', 'reply'].includes(m.mes)));
    const body = { type: 'normal', messages: history.map(m => ({ role: m.is_user ? 'user' : 'assistant', content: m.mes })) };
    await h.events.emit('CHAT_COMPLETION_SETTINGS_READY', body);
    assert.equal(body.messages.filter(m => m.content === '隐藏消息的记忆').length, 1);
});

test('hiding a reply during generation does not bypass its completion checks', async () => {
    const h = harness(); h.ctx.extensionSettings[KEY].enabled = true;
    h.ctx.chat.push({ name: 'User', is_user: true, mes: 'next' });
    await h.events.emit('GENERATION_STARTED', 'normal', {}, false);
    h.ctx.chat.push({ name: 'Alice', is_user: false, is_system: true, mes: 'hidden answer' });
    await h.events.emit('MESSAGE_RECEIVED', 3, 'normal'); await h.runtime.sync();
    assert.equal(h.requests.at(-1).body.messages[3].blocked, true);
    await h.events.emit('GENERATION_ENDED'); await h.runtime.sync();
    const message = h.requests.at(-1).body.messages[3];
    assert.equal(message.role, 'assistant'); assert.equal(message.hidden, true); assert.equal(message.blocked, false);
});
