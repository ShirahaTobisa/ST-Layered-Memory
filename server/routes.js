import { scopeId, sourceTurns } from './store.js';
import { publicConfig } from './providers.js';
import { recall, rawSearch } from './search.js';

function expectedChat(store, body) {
    const id = scopeId(body.scope), chat = store.chat(id);
    if (!chat || body.revision !== chat.revision) throw Object.assign(new Error('聊天版本已变化，请重新同步'), { status: 409 });
    return { id, chat };
}

export function registerRoutes(router, getEngine) {
    const route = (path, handler) => router.post(path, async (req, res) => {
        try {
            if (!req.user?.directories?.root) return res.sendStatus(401);
            const engine = getEngine(req.user.directories.root);
            if (engine.fault) throw Object.assign(new Error(engine.fault), { status: 503 });
            const result = await handler(engine.store, req.body || {}, engine);
            engine.wake();
            res.json(result);
        } catch (error) {
            res.status(error.status || 400).json({ error: String(error.message).slice(0, 300) });
        }
    });
    route('/status', async store => ({ version: '0.1.0', config: publicConfig(store.config) }));
    route('/config', async (store, body) => ({ config: publicConfig(store.setConfig(body)) }));
    route('/state', async (store, body) => store.state(scopeId(body.scope)));
    route('/sync', async (store, body) => store.sync(body.scope, body.messages, body.revision));
    route('/pause', async (store, body) => {
        const { id } = expectedChat(store, body); store.pause(id, !!body.paused); return store.state(id);
    });
    route('/retry', async (store, body) => {
        const { id } = expectedChat(store, body); store.retry(id, body.id); return store.state(id);
    });
    route('/clear', async (store, body) => {
        const { id } = expectedChat(store, body); store.clear(id); return store.state(id);
    });
    route('/list', async (store, body) => {
        const { id, chat } = expectedChat(store, body);
        const all = store.memories(id).sort((a, b) => a.turn - b.turn || a.kind.localeCompare(b.kind));
        const offset = Math.max(0, Number(body.offset) || 0);
        const items = all.slice(offset, offset + 20).map(({ vector, vectorSignature, ...memory }) => ({ ...memory, indexed: !!vector, sources: chat.messages.filter(m => memory.ids.includes(m.id)) }));
        return { ...store.state(id), items, offset };
    });
    route('/edit', async (store, body) => {
        const { id } = expectedChat(store, body); store.edit(id, body.id, body); return store.state(id);
    });
    route('/plan', async (store, body, engine) => {
        const { id, chat } = expectedChat(store, body), revision = chat.revision;
        const memories = store.memories(id).filter(m => m.enabled);
        const before = JSON.stringify([memories, store.config]);
        const result = store.config.mode === 'enhanced'
            ? await recall(store, id, String(body.query || '').slice(0, 8000), Array.isArray(body.exclude) ? body.exclude : [], engine.providers)
            : { memories: [], warnings: [] };
        if (store.chat(id)?.revision !== revision || before !== JSON.stringify([store.memories(id).filter(m => m.enabled), store.config])) throw Object.assign(new Error('检索期间聊天或记忆发生变化'), { status: 409 });
        const strip = ({ vector, vectorSignature, ...memory }) => memory;
        return { revision, summaries: memories.filter(m => m.kind === 'summary').map(strip), groups: memories.filter(m => m.kind === 'group').map(strip), recall: result.memories.map(strip), warnings: result.warnings };
    });
    route('/search', async (store, body) => {
        const { chat } = expectedChat(store, body);
        if (typeof body.query !== 'string' || !body.query.trim() || body.query.length > 2000) throw new Error('请输入有效检索词');
        return { matches: rawSearch(chat.messages, body.query), revision: chat.revision };
    });
    route('/export', async (store, body) => {
        const { id, chat } = expectedChat(store, body);
        return { version: 1, scope: chat.scope, revision: chat.revision, memories: store.memories(id).map(({ vector, vectorSignature, ...m }) => m) };
    });
    route('/import', async (store, body) => {
        const { id, chat } = expectedChat(store, body), backup = body.backup;
        if (backup?.version !== 1 || !Array.isArray(backup.memories) || backup.memories.length > 20000 || scopeId(backup.scope) !== id || backup.revision !== chat.revision) throw new Error('备份不属于当前聊天版本，未导入');
        const turns = new Map(sourceTurns(chat.messages).filter(t => t.eligible && !t.empty).map(t => [t.key, t]));
        const summaries = backup.memories.filter(m => m.kind === 'summary');
        for (const m of summaries) if (!turns.has(m.id) || turns.get(m.id).sourceHash !== m.sourceHash || typeof m.summary !== 'string' || !m.summary.trim() || m.summary.length > 20000) throw new Error('备份来源或正文不匹配，未导入');
        store.db.transaction(() => {
            for (const m of summaries) {
                const turn = turns.get(m.id);
                store.put(id, { id: turn.key, kind: 'summary', turn: turn.number, ids: turn.ids, sourceHash: turn.sourceHash, userText: turn.user.map(m => `${m.name}: ${m.text}`).join('\n'), summary: m.summary, enabled: m.enabled !== false, edited: true });
            }
            store.schedule(id);
        })();
        return { ...store.state(id), restored: summaries.length };
    });
}
