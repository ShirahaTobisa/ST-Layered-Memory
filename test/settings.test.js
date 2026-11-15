import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountMemoryPanel } from '../client/index.js';
import { KEY, VERSION, DEFAULTS } from '../shared/model.js';

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
            if (url.endsWith('/status')) return Response.json({ version: VERSION, config: { mode: 'classic', keep: 20, concurrency: 5, rawLimit: 5, summary: { url: '', model: '', hasKey: false }, embedding: { url: '', model: '', hasKey: false } } });
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

test('failed config saves preserve the draft; successful saves clear the key input', async () => {
    const h = harness(), panel = mountMemoryPanel(() => h.context, h.host);
    await new Promise(resolve => setTimeout(resolve, 0));
    const form = panel.panel.querySelector('[data-settings]'), key = form.elements.namedItem('summary.key');
    key.value = 'unsaved-test-key';
    const base = h.host.fetch;
    h.host.fetch = async (url, init) => url.endsWith('/config') ? Response.json({ error: 'save failed' }, { status: 400 }) : base(url, init);
    form.onsubmit({ preventDefault() {} });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(key.value, 'unsaved-test-key');
    assert.match(panel.panel.querySelector('[data-status]').textContent, /save failed/);
    let received;
    h.host.fetch = async (url, init) => {
        if (!url.endsWith('/config')) return base(url, init);
        received = JSON.parse(init.body);
        return Response.json({ config: { ...DEFAULTS, summary: { url: '', model: '', hasKey: true }, embedding: { url: '', model: '', hasKey: false } } });
    };
    form.onsubmit({ preventDefault() {} });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(received.summary.key, 'unsaved-test-key'); assert.equal(key.value, '');
    assert.match(key.placeholder, /已保存/);
    panel.dispose(); h.dom.window.close();
});

test('a failed memory switch does not display an unsaved enabled state', async () => {
    const h = harness();
    const base = h.host.fetch, memory = { id: 'summary', kind: 'summary', turn: 1, summary: '记忆', enabled: true, sources: [] };
    h.host.fetch = async (url, init) => {
        if (url.endsWith('/list')) return Response.json({ revision: 'r1', items: [memory], filteredTotal: 1, counts: {} });
        if (url.endsWith('/edit')) return Response.json({ error: 'edit failed' }, { status: 400 });
        return base(url, init);
    };
    const panel = mountMemoryPanel(() => h.context, h.host);
    await new Promise(resolve => setTimeout(resolve, 0));
    await panel.panel.querySelector('[data-tab="memories"]').onclick();
    const toggle = panel.panel.querySelector('[data-memories] input[type="checkbox"]');
    toggle.checked = false; toggle.onchange();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(toggle.checked, true);
    assert.match(panel.panel.querySelector('[data-status]').textContent, /edit failed/);
    panel.dispose(); h.dom.window.close();
});
