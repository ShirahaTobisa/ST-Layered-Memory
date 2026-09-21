import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { Store } from '../server/store.js';
import { Engine } from '../server/engine.js';
import { registerRoutes } from '../server/routes.js';

test('authenticated HTTP routes isolate users, reject stale mutations and import only verified sources', async t => {
    const root = fs.mkdtempSync(path.resolve('test-output/http-')), engines = new Map();
    const getEngine = userRoot => {
        if (!engines.has(userRoot)) engines.set(userRoot, new Engine(new Store(path.join(userRoot, 'memory.sqlite')), { summarize: async () => 'source-checked summary', embed: async () => [[1, 0]] }));
        return engines.get(userRoot);
    };
    const app = express(); app.use(express.json());
    app.use((req, res, next) => { if (req.headers['x-test-user']) req.user = { directories: { root: path.join(root, req.headers['x-test-user']) } }; next(); });
    registerRoutes(app, getEngine);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(async () => { await new Promise(resolve => server.close(resolve)); for (const e of engines.values()) await e.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const call = async (route, body = {}, user = 'a') => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) }, body: JSON.stringify(body) });
        return { status: response.status, data: response.status === 401 ? null : await response.json() };
    };
    assert.equal((await call('status', {}, '')).status, 401);
    const saved = await call('config', { summary: { url: 'http://local/v1', model: 'test', key: 'never-return-this-key' } });
    assert.ok(!JSON.stringify(saved).includes('never-return-this-key'));
    const scope = { actor: 'a', chat: 'chat', lineage: 'l' }, messages = [{ id: 'u', role: 'user', name: 'user', text: 'query' }, { id: 'a', role: 'assistant', name: 'character', text: 'detail' }];
    const synced = (await call('sync', { scope, messages, revision: null })).data;
    assert.equal((await call('state', { scope }, 'b')).data.total, 0);
    for (let i = 0; i < 100; i++) {
        if ((await call('state', { scope })).data.total) break;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    const ref = { scope, revision: synced.revision };
    const listed = (await call('list', ref)).data; assert.equal(listed.items.length, 1);
    assert.equal((await call('edit', { ...ref, revision: 'old', id: listed.items[0].id, summary: 'bad' })).status, 409);
    const backup = (await call('export', ref)).data;
    assert.equal(backup.memories.length, 1); assert.ok(!JSON.stringify(backup).includes('key'));
    await call('clear', ref); assert.equal((await call('state', { scope })).data.total, 0);
    const restored = await call('import', { ...ref, backup }); assert.equal(restored.data.restored, 1);
    const altered = structuredClone(backup); altered.memories[0].sourceHash = 'wrong';
    assert.equal((await call('import', { ...ref, backup: altered })).status, 400);
    assert.equal((await call('state', { scope })).data.total, 1);
    assert.equal((await call('import', { ...ref, backup }, 'b')).status, 409);
    const searched = await call('search', { ...ref, query: 'detail' }); assert.equal(searched.data.matches.length, 1);
});
