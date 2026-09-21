import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountMemoryPanel } from '../client/index.js';
import { KEY } from '../shared/model.js';

function harness() {
    const dom = new JSDOM('<body><div id="extensions_settings"></div></body>', { url: 'http://localhost/' });
    const listeners = new Map();
    const types = Object.fromEntries([
        'WORLDINFO_ENTRIES_LOADED', 'CHAT_COMPLETION_SETTINGS_READY', 'GENERATION_STARTED', 'GENERATION_ENDED',
        'GENERATION_STOPPED', 'STREAM_TOKEN_RECEIVED', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_DELETED',
        'MESSAGE_SWIPED', 'CHAT_CHANGED'
    ].map(type => [type, type]));
    const events = { on(type, callback) { listeners.set(type, [...listeners.get(type) || [], callback]); } };
    const context = {
        chatId: 'chat', characters: [{ avatar: 'alice.png' }], characterId: 0, groupId: null,
        name1: 'User', name2: 'Alice', chat: [], chatMetadata: {}, extensionSettings: { [KEY]: { enabled: false } },
        eventSource: events, eventTypes: types, registerFunctionTool() {}, getRequestHeaders: () => ({ }),
        saveChat: async () => {}, saveMetadata: async () => {}, saveSettingsDebounced() {},
        mainApi: 'openai', chatCompletionSettings: { openai_max_context: 10000, openai_max_tokens: 1000 },
        getTokenCountAsync: async text => text.length
    };
    const host = {
        ...dom.window, document: dom.window.document, crypto, setInterval: () => 0, clearInterval() {},
        addEventListener() {}, confirm: () => true,
        fetch: async url => {
            if (url.endsWith('/status')) return Response.json({ version: '0.2.0', config: { mode: 'classic', keep: 20, concurrency: 5, rawLimit: 5, summary: { url: '', model: '', hasKey: false }, embedding: { url: '', model: '', hasKey: false } } });
            return Response.json({ revision: 'r1', counts: {}, items: [], filteredTotal: 0 });
        }
    };
    return { dom, context, host };
}

test('settings panel exposes Anima-style model, rules, memory and context controls', async () => {
    const h = harness();
    const panel = mountMemoryPanel(() => h.context, h.host);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(panel.panel.querySelectorAll('[data-tab]').length, 4);
    assert.ok(panel.panel.querySelector('[name="summary.url"]'));
    assert.ok(panel.panel.querySelector('[name="embedding.model"]'));
    assert.ok(panel.panel.querySelector('[name="keep"][type="range"]'));
    assert.ok(panel.panel.querySelector('[name="concurrency"][type="range"]'));
    assert.ok(panel.panel.querySelector('[data-action="export"]'));
    assert.ok(panel.panel.querySelector('[data-action="import"]'));
    assert.ok(panel.panel.querySelector('[data-view="context"]'));
    panel.dispose();
    h.dom.window.close();
});
