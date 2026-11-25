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
    return { dom, context, host, listeners };
}

test('settings panel exposes Anima-style model, rules, memory and context controls', async () => {
    const h = harness();
    const panel = mountMemoryPanel(() => h.context, h.host);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(panel.panel.querySelectorAll('[data-tab]').length, 4);
    assert.ok(panel.panel.querySelector('[name="summary.url"]'));
    assert.ok(panel.panel.querySelector('[name="embedding.model"]'));
    assert.ok(panel.panel.querySelector('[name="rerank.url"]') && panel.panel.querySelector('[data-check="rerank"]'));
    assert.deepEqual([...panel.panel.querySelector('[name="summary.effort"]').options].map(option => option.value), ['', 'none', 'minimal', 'low', 'medium', 'high']);
    assert.equal(panel.panel.querySelector('[name="embedding.effort"], [name="rerank.effort"]'), null);
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
    key.value = 'unsaved-test-key'; form.elements.namedItem('summary.effort').value = 'low';
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
    assert.equal(received.summary.effort, 'low'); assert.equal(received.embedding.effort, undefined);
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

test('switching chats clears what the memory page showed for the previous chat', async () => {
    const h = harness(), panel = mountMemoryPanel(() => h.context, h.host), base = h.host.fetch, text = query => panel.panel.querySelector(query).textContent;
    await new Promise(resolve => setTimeout(resolve, 0));
    h.host.fetch = async (url, init) => url.endsWith('/list') ? Response.json({ revision: 'r1', counts: { queued: 2 }, summaries: 7, items: [], filteredTotal: 0 }) : base(url, init);
    await panel.panel.querySelector('[data-tab="memories"]').onclick();
    assert.deepEqual([text('[data-count="summaries"]'), text('[data-chat]')], ['7', 'chat']); assert.match(text('[data-progress]'), /等待 2/);
    h.context.chatId = 'other';
    for (const listener of h.listeners.get('CHAT_CHANGED')) listener();
    assert.deepEqual([text('[data-count="summaries"]'), text('[data-chat]'), text('[data-progress]')], ['0', 'other', '尚未交付聊天']);
    panel.dispose(); h.dom.window.close();
});

test('opening the panel keeps the notice left by the last request', async () => {
    const h = harness(), panel = mountMemoryPanel(() => h.context, h.host);
    await new Promise(resolve => setTimeout(resolve, 0));
    h.context.extensionSettings[KEY].enabled = true;
    const base = h.host.fetch;
    h.host.fetch = async (url, init) => url.endsWith('/sync') ? Response.json({ error: 'handoff refused' }, { status: 400 }) : base(url, init);
    for (const listener of h.listeners.get('CHAT_COMPLETION_SETTINGS_READY')) await listener({ type: 'normal', messages: [{ role: 'user', content: 'hi' }] });
    panel.panel.showModal = () => {};
    await panel.open();
    assert.match(panel.panel.querySelector('[data-status]').textContent, /本轮保留原请求：handoff refused/);
    panel.dispose();
    h.dom.window.close();
});

test('closing the panel and switching tabs are not blocked by a slow model test; defaults reset recall rules', async () => {
    const h = harness(), panel = mountMemoryPanel(() => h.context, h.host);
    await new Promise(resolve => setTimeout(resolve, 0));
    let releaseCheck;
    const base = h.host.fetch;
    h.host.fetch = async (url, init) => url.endsWith('/check') ? new Promise(resolve => { releaseCheck = () => resolve(Response.json({ message: '总结模型接口可用' })); }) : base(url, init);
    let closed = false;
    panel.panel.close = () => { closed = true; };
    const checkBtn = panel.panel.querySelector('[data-check="summary"]');
    const checkPromise = checkBtn.onclick();
    assert.equal(checkBtn.disabled, true);
    // Switching tabs and closing work immediately while model test is in flight.
    await panel.panel.querySelector('[data-tab="rules"]').onclick();
    assert.equal(panel.panel.querySelector('[data-view="rules"]').hidden, false);
    panel.panel.querySelector('[data-action="close"]').onclick();
    assert.equal(closed, true);
    // Recall rule controls exist and reset cleanly.
    panel.panel.querySelector('[name="recallThreshold"]').value = '0.7';
    panel.panel.querySelector('[name="recallExcludeRaw"]').checked = false;
    panel.panel.querySelector('[data-action="defaults"]').onclick();
    assert.equal(panel.panel.querySelector('[name="recallThreshold"]').value, String(DEFAULTS.recallThreshold));
    assert.equal(panel.panel.querySelector('[name="recallExcludeRaw"]').checked, DEFAULTS.recallExcludeRaw);
    releaseCheck();
    await checkPromise;
    assert.equal(checkBtn.disabled, false);
    panel.dispose();
    h.dom.window.close();
});

test('memory details stay open across refreshes and failed imports clear the file input', async () => {
    const h = harness();
    const base = h.host.fetch;
    const item = { id: 'm1', kind: 'summary', turn: 1, summary: '测试记忆', enabled: true, indexed: false, sources: [{ name: 'U', text: '原文' }] };
    h.host.fetch = async (url, init) => url.endsWith('/list')
        ? Response.json({ revision: 'r1', items: [item], filteredTotal: 1, total: 1, counts: {} }) : base(url, init);
    const panel = mountMemoryPanel(() => h.context, h.host);
    await new Promise(resolve => setTimeout(resolve, 0));
    await panel.panel.querySelector('[data-tab="memories"]').onclick();
    const details = panel.panel.querySelector('[data-memories] details');
    details.open = true; details.dispatchEvent(new h.dom.window.Event('toggle'));
    // Re-opening the tab with unchanged data keeps the details element open.
    await panel.panel.querySelector('[data-tab="memories"]').onclick();
    assert.equal(panel.panel.querySelector('[data-memories] details').open, true);
    // Invalid JSON backup fails cleanly and still resets input.value.
    const fakeInput = { files: [{ size: 10, text: async () => '{bad json' }], value: 'backup.json' };
    await panel.panel.querySelector('[data-import]').onchange({ target: fakeInput });
    assert.equal(fakeInput.value, '');
    assert.match(panel.panel.querySelector('[data-status]').textContent, /JSON/);
    // Filter bar supports desc/asc sort order.
    assert.deepEqual([...panel.panel.querySelector('[data-filter] [name="order"]').options].map(o => o.value), ['desc', 'asc']);
    panel.dispose();
    h.dom.window.close();
});

test('polling preserves expanded records and refreshes the displayed stage progress', async () => {
    const h = harness(); let poll;
    h.host.setInterval = callback => { poll = callback; return 1; };
    const memory = { id: 's', no: 12, turn: 1, kind: 'summary', summary: '旧记忆', enabled: true, sources: [] }, base = h.host.fetch;
    h.host.fetch = (url, init) => url.endsWith('/list') ? Promise.resolve(Response.json({ revision: 'r1', items: [memory], filteredTotal: 1, offset: 0,
        progress: [{ kind: 'summary', done: 2, total: 4, failed: 0, eta: 120 }] })) : base(url, init);
    const panel = mountMemoryPanel(() => h.context, h.host);
    await new Promise(resolve => setTimeout(resolve, 0));
    panel.panel.open = true;
    await panel.panel.querySelector('[data-tab="memories"]').onclick();
    const oldRow = panel.panel.querySelector('article'); oldRow.querySelector('details').open = true;
    await poll();
    assert.equal(panel.panel.querySelector('article'), oldRow);
    memory.summary = '后台更新后的记忆';
    await poll();
    assert.equal(panel.panel.querySelector('article details').open, true);
    assert.match(panel.panel.querySelector('[data-stages]').textContent, /2 \/ 4.*2 分钟/);
    assert.equal(panel.panel.querySelector('progress').value, 2);
    panel.dispose(); h.dom.window.close();
});

test('model checks do not block navigation or closing the panel', async () => {
    const h = harness(), base = h.host.fetch;
    let finish;
    h.host.fetch = (url, init) => url.endsWith('/check') ? new Promise(resolve => { finish = resolve; }) : base(url, init);
    const panel = mountMemoryPanel(() => h.context, h.host);
    await new Promise(resolve => setTimeout(resolve, 0));
    panel.panel.open = true; panel.panel.close = () => { panel.panel.open = false; };
    const button = panel.panel.querySelector('[data-check="summary"]'), request = button.onclick();
    assert.equal(button.disabled, true);
    await panel.panel.querySelector('[data-tab="rules"]').onclick();
    assert.equal(panel.panel.querySelector('[data-view="rules"]').hidden, false);
    panel.panel.querySelector('[data-action="close"]').onclick();
    assert.equal(panel.panel.open, false);
    finish(Response.json({ message: '模型可用' })); await request;
    assert.equal(button.disabled, false);
    panel.dispose(); h.dom.window.close();
});

test('a memory switch clicked during a poll is applied after the poll instead of being dropped', async () => {
    const h = harness(); let poll, release;
    h.host.setInterval = callback => { poll = callback; return 1; };
    const panel = mountMemoryPanel(() => h.context, h.host);
    await new Promise(resolve => setTimeout(resolve, 0));
    await panel.runtime.sync(); panel.panel.open = true;
    const base = h.host.fetch;
    h.host.fetch = (url, init) => url.endsWith('/state') ? new Promise(resolve => { release = resolve; }) : base(url, init);
    const polling = poll();
    await new Promise(resolve => setImmediate(resolve));
    const toggle = panel.panel.querySelector('[data-enabled]'); toggle.checked = true;
    const switching = toggle.onchange();
    assert.equal(toggle.disabled, true);
    release(Response.json({ revision: 'r1', counts: {} }));
    await polling; await switching;
    assert.equal(panel.runtime.enabled, true); assert.equal(toggle.checked, true); assert.equal(toggle.disabled, false);
    panel.dispose(); h.dom.window.close();
});

test('reopening on memories tab syncs enabled toggle, refreshes list, and handles partial config defaults', async () => {
    const h = harness();
    let listCalls = 0;
    const base = h.host.fetch;
    h.host.fetch = (url, init) => {
        if (url.endsWith('/status')) return Promise.resolve(Response.json({ version: VERSION, config: { mode: 'classic' } }));
        if (url.endsWith('/list')) { listCalls++; return Promise.resolve(Response.json({ revision: 'r1', items: [], filteredTotal: 0, offset: 0 })); }
        return base(url, init);
    };
    const panel = mountMemoryPanel(() => h.context, h.host);
    panel.panel.showModal = () => { panel.panel.open = true; };
    panel.panel.close = () => { panel.panel.open = false; };
    await new Promise(resolve => setTimeout(resolve, 0));
    // Partial config from server falls back to DEFAULTS rather than rendering "undefined".
    assert.equal(panel.panel.querySelector('[data-value="keep"]').textContent, '20');
    assert.equal(panel.panel.querySelector('[name="recallLimit"]').value, '10');
    await panel.panel.querySelector('[data-tab="memories"]').onclick();
    const before = listCalls;
    h.context.chatMetadata[KEY] = { enabled: true };
    await panel.open();
    assert.equal(panel.panel.querySelector('[data-enabled]').checked, true);
    assert.equal(listCalls, before + 1);
    panel.dispose(); h.dom.window.close();
});
