import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../client/runtime.js';
import { KEY } from '../shared/model.js';

function harness() {
    const listeners = new Map(), types = Object.fromEntries(['WORLDINFO_ENTRIES_LOADED', 'CHAT_COMPLETION_SETTINGS_READY', 'GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'STREAM_TOKEN_RECEIVED', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'CHAT_CHANGED'].map(t => [t, t]));
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
        if (url.endsWith('/status')) return Response.json({ config: { keep: 2, budget: 1000 } });
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
    await h.host.rphMemoryInterceptor(history, 10000, () => {}, 'normal');
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
