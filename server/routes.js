import { scopeId, sourceTurns } from './store.js';
import { configure, hash, publicConfig, vectorSignature } from './providers.js';
import { recall, rawSearch, unpackEmbedding } from './search.js';
import { roleText } from '../shared/model.js';

const stripVector = ({ vector, vectorSignature, embeddingQ, embeddingDims, embeddingScale, embeddingEncoding, ...memory }) => memory;

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
    route('/status', async store => ({ version: '0.2.0', config: publicConfig(store.config) }));
    route('/config', async (store, body) => ({ config: publicConfig(store.setConfig(body)) }));
    route('/models', async (store, body, engine) => {
        if (!['summary', 'embedding'].includes(body.provider)) throw new Error('未知模型类型');
        const setting = configure({ [body.provider]: body.setting || {} }, store.config)[body.provider];
        return { models: await engine.providers.models(setting) };
    });
    route('/check', async (store, body, engine) => {
        if (!['summary', 'embedding'].includes(body.provider)) throw new Error('未知模型类型');
        const config = configure({ [body.provider]: body.setting || {} }, store.config);
        if (body.provider === 'embedding') {
            const [vector] = await engine.providers.embed(config, ['连接测试']);
            return { message: `向量模型可用，${vector.length} 维` };
        }
        const data = await engine.providers.request(config.summary, 'chat/completions', { model: config.summary.model, stream: false, temperature: 0, max_tokens: 32, messages: [{ role: 'user', content: '只回复 OK' }] });
        if (!data.choices?.[0]?.message) throw new Error('接口没有返回聊天结果');
        return { message: '总结模型接口可用' };
    });
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
    route('/reindex', async (store, body) => {
        const { id } = expectedChat(store, body);
        store.db.transaction(() => {
            for (const memory of store.memories(id)) { memory.vectorSignature = null; store.put(id, memory); }
        })();
        store.retry(id);
        return store.state(id);
    });
    route('/rebuild', async (store, body) => {
        const { id } = expectedChat(store, body);
        store.clear(id); store.pause(id, false); return store.state(id);
    });
    route('/list', async (store, body) => {
        const { id, chat } = expectedChat(store, body);
        let all = store.memories(id).sort((a, b) => a.turn - b.turn || a.kind.localeCompare(b.kind));
        if (['summary', 'group'].includes(body.kind)) all = all.filter(m => m.kind === body.kind);
        if (body.query) all = all.filter(m => `${m.summary}\n${m.userText || ''}`.includes(String(body.query).slice(0, 300)));
        const offset = Math.max(0, Number(body.offset) || 0);
        const items = all.slice(offset, offset + 10).map(m => ({ ...stripVector(m), indexed: m.vectorSignature === vectorSignature(store.config) && !!unpackEmbedding(m).length, sources: chat.messages.filter(source => m.ids.includes(source.id)) }));
        return { ...store.state(id), items, offset, filteredTotal: all.length };
    });
    route('/edit', async (store, body) => {
        const { id } = expectedChat(store, body); store.edit(id, body.id, body); return store.state(id);
    });
    route('/plan', async (store, body, engine) => {
        const { id, chat } = expectedChat(store, body), revision = chat.revision;
        const memories = store.memories(id);
        const before = JSON.stringify([memories, store.config]);
        const result = store.config.mode === 'enhanced'
            ? await recall(store, id, String(body.query || ''), engine.providers)
            : { memories: [], warnings: [] };
        if (store.chat(id)?.revision !== revision || before !== JSON.stringify([store.memories(id), store.config])) throw Object.assign(new Error('检索期间聊天或记忆发生变化'), { status: 409 });
        return { revision, summaries: memories.filter(m => m.kind === 'summary').map(stripVector), groups: memories.filter(m => m.kind === 'group').map(stripVector), recall: result.memories.map(stripVector), warnings: result.warnings };
    });
    route('/search', async (store, body) => {
        const { chat } = expectedChat(store, body);
        if (typeof body.query !== 'string' || !body.query.trim() || body.query.length > 2000) throw new Error('请输入有效检索词');
        return { matches: rawSearch(chat.messages, body.query, store.config.rawLimit), revision: chat.revision };
    });
    route('/export', async (store, body) => {
        const { id, chat } = expectedChat(store, body);
        return { version: 1, scope: chat.scope, revision: chat.revision, memories: store.memories(id).map(stripVector) };
    });
    route('/import', async (store, body) => {
        const { id, chat } = expectedChat(store, body), backup = body.backup;
        if (backup?.version !== 1 || !Array.isArray(backup.memories) || backup.memories.length > 20000 || scopeId(backup.scope) !== id || backup.revision !== chat.revision) throw new Error('备份不属于当前聊天版本，未导入');
        const turns = new Map(sourceTurns(chat.messages).filter(t => t.eligible && !t.empty).map(t => [t.key, t]));
        const summaries = backup.memories.filter(m => m.kind === 'summary');
        const restored = new Map();
        for (const m of summaries) {
            const turn = turns.get(m.id);
            if (!turn || turn.sourceHash !== m.sourceHash || typeof m.summary !== 'string' || !m.summary.trim() || m.summary.length > 20000) throw new Error('备份来源或正文不匹配，未导入');
            restored.set(m.id, { ...m, id: turn.key, kind: 'summary', turn: turn.number, ids: turn.ids, sourceUserIds: turn.userIds, sourceAssistantIds: turn.assistantIds, sourceHash: turn.sourceHash, userText: m.userText || roleText(turn.user, false), enabled: m.enabled !== false });
        }
        const groups = backup.memories.filter(m => m.kind === 'group');
        for (const group of groups) {
            const children = (group.children || []).map(childId => restored.get(childId));
            if (children.length < 2 || children.some(child => !child) || typeof group.summary !== 'string' || !group.summary.trim() || group.summary.length > 20000) throw new Error('备份合并记忆来源不匹配，未导入');
            const expectedSourceHash = hash(children.map(child => [child.id, child.summary, child.enabled]));
            if (group.sourceHash !== expectedSourceHash) throw new Error('备份合并记忆已变化，未导入');
        }
        store.db.transaction(() => {
            for (const memory of restored.values()) store.put(id, memory);
            for (const group of groups) store.put(id, { ...group, ids: [...new Set(group.ids || group.sourceMemories?.flatMap(memory => memory.ids || []) || [])], enabled: group.enabled !== false, recipe: 'rph-1.9.5' });
            store.schedule(id);
        })();
        return { ...store.state(id), restored: restored.size + groups.length };
    });
}
