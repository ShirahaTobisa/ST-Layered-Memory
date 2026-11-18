import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Database } from './database.js';
import { DEFAULTS, turnsFrom, sourceData, eligibleGroups, roleText, cleanMemory, cleanText, stripVector, storedMessage } from '../shared/model.js';
import { configure, hash, summarySignature, vectorSignature } from './providers.js';

const parse = row => row ? JSON.parse(row.data) : null;
export const groupHash = children => hash(children.map(m => [m.id, m.summary, m.enabled]));
// Summaries are written from what the main model was shown, when the page reported it.
export const shownText = messages => roleText(messages.map(m => m.view ? { ...m, text: m.view } : m));
export const vectorText = memory => `用户原输入：\n${memory.userText}\n\n本轮总结：\n${memory.summary}`;
export function scopeId(scope) {
    for (const key of ['actor', 'chat', 'lineage']) if (typeof scope?.[key] !== 'string' || !scope[key] || scope[key].length > 512) throw new Error('聊天身份无效');
    return hash([scope.actor, scope.chat, scope.lineage]);
}

export function sourceTurns(messages) {
    const turns = turnsFrom(messages);
    for (const turn of turns) {
        turn.key = hash(turn.assistantIds.length ? turn.assistantIds : turn.ids);
        // A summary is bound to the target turn's source messages. Earlier
        // turns are prompt context and do not invalidate an existing summary.
        turn.sourceHash = hash(sourceData(turn));
    }
    return turns;
}

export class Store {
    constructor(filename) {
        fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
        this.db = new Database(filename);
        this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, scope TEXT NOT NULL, revision TEXT NOT NULL, snapshot TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS memories (chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(chat_id,id));
            CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, kind TEXT NOT NULL, status TEXT NOT NULL, input TEXT NOT NULL, lease TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0);
            CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
            CREATE INDEX IF NOT EXISTS jobs_chat ON jobs(chat_id);
        `);
        this.cache = new Map();
        const savedConfig = parse(this.db.prepare('SELECT data FROM config WHERE id=1').get()) || {};
        this.config = configure(savedConfig, DEFAULTS);
        if (savedConfig.version !== 2) this.migrateLegacy(filename);
        this.db.prepare("UPDATE jobs SET status='queued', lease=NULL WHERE status='running'").run();
        this.db.transaction(() => {
            for (const row of this.db.prepare('SELECT id FROM chats').all()) this.schedule(row.id);
        })();
    }

    close() { this.db.close(); }
    migrateLegacy(filename) {
        const chats = this.db.prepare('SELECT id FROM chats').all().map(({ id }) => ({ ...this.chat(id), memories: this.memories(id) }));
        const backup = `${filename}.v1-memory-backup.json`;
        if (chats.some(chat => chat.memories.length) && !fs.existsSync(backup)) {
            fs.writeFileSync(backup, JSON.stringify({ version: 1, chats: chats.map(chat => ({ scope: chat.scope, revision: chat.revision, memories: chat.memories })) }), { mode: 0o600, flag: 'wx' });
        }
        this.db.transaction(() => {
            for (const chat of chats) {
                const turns = sourceTurns(chat.messages), targets = new Map(turns.map(turn => [hash(turn.ids), turn]));
                // v0.1 ignored system boundaries and hashed the preceding three turns.
                const previousTurns = sourceTurns(chat.messages.filter(message => message.role !== 'system'));
                const previous = new Map(previousTurns.map((turn, index) => [hash(turn.ids), hash(previousTurns.slice(Math.max(0, index - 3), index + 1).map(sourceData))]));
                const migrated = new Map(), originals = new Map(chat.memories.map(memory => [memory.id, memory]));
                for (const memory of chat.memories.filter(memory => memory.kind === 'summary')) {
                    const turn = targets.get(memory.id);
                    if (!turn?.eligible || previous.get(memory.id) !== memory.sourceHash) continue;
                    const next = { ...memory, id: turn.key, ids: turn.ids, turn: turn.number, sourceHash: turn.sourceHash,
                        sourceUserIds: turn.userIds, sourceAssistantIds: turn.assistantIds, userText: roleText(turn.user, false), recipe: 'legacy-v1' };
                    this.remove(chat.id, memory.id); this.put(chat.id, next); migrated.set(memory.id, next);
                }
                for (const memory of chat.memories.filter(memory => memory.kind === 'group')) {
                    const oldChildren = memory.children.map(id => originals.get(id)), children = memory.children.map(id => migrated.get(id));
                    if (children.some(child => !child) || oldChildren.some(child => !child) || groupHash(oldChildren) !== memory.sourceHash) continue;
                    const ids = children.flatMap(child => child.ids);
                    this.remove(chat.id, memory.id);
                    this.put(chat.id, { ...memory, id: hash(ids), ids, children: children.map(child => child.id),
                        sourceHash: groupHash(children), recipe: 'legacy-v1',
                        sourceUserIds: children.flatMap(child => child.sourceUserIds), sourceAssistantIds: children.flatMap(child => child.sourceAssistantIds) });
                }
            }
            this.db.prepare('INSERT OR REPLACE INTO config VALUES (1,?)').run(JSON.stringify(this.config));
        })();
    }
    chat(id) {
        const row = this.db.prepare('SELECT * FROM chats WHERE id=?').get(id);
        return row ? { ...row, scope: JSON.parse(row.scope), messages: JSON.parse(row.snapshot) } : null;
    }
    revision(id) { return this.db.prepare('SELECT revision FROM chats WHERE id=?').get(id)?.revision; }
    // Parsed turns of the chats in use, so a long chat is not read again for every finished task.
    turns(id, messages) {
        const revision = this.revision(id);
        let cached = this.cache.get(id);
        if (cached?.revision !== revision) {
            messages ||= revision ? this.chat(id).messages : [];
            cached = { revision, messages, turns: sourceTurns(messages) };
            this.cache.delete(id); this.cache.set(id, cached);
            if (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value);
        }
        return cached.turns;
    }
    memories(id) { return this.db.prepare('SELECT data FROM memories WHERE chat_id=?').all(id).map(parse); }
    put(id, memory) {
        const cleaned = cleanMemory(memory);
        if (!cleaned.summary) throw new Error('记忆过滤思考内容后为空，保留原文');
        this.db.prepare('INSERT OR REPLACE INTO memories VALUES (?,?,?)').run(id, memory.id, JSON.stringify(cleaned));
    }
    remove(id, key) { this.db.prepare('DELETE FROM memories WHERE chat_id=? AND id=?').run(id, key); }
    job(id) { return this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id); }

    setConfig(input) {
        const previous = this.config, next = configure(input, previous);
        try {
            this.db.transaction(() => {
                this.db.prepare('INSERT OR REPLACE INTO config VALUES (1,?)').run(JSON.stringify(next));
                this.config = next;
                for (const row of this.db.prepare('SELECT id FROM chats').all()) this.schedule(row.id);
            })();
        } catch (error) { this.config = previous; throw error; }
        return next;
    }

    inherit(id, parentId) {
        const turns = new Map(this.turns(id).filter(t => t.eligible && !t.empty).map(t => [t.key, t]));
        const memories = this.memories(parentId), copied = new Set();
        for (const memory of memories.filter(m => m.kind === 'summary')) {
            const target = turns.get(memory.id);
            if (target?.sourceHash !== memory.sourceHash) continue;
            this.put(id, { ...memory, turn: target.number }); copied.add(memory.id);
        }
        for (const memory of memories.filter(m => m.kind === 'group')) {
            if (memory.children.every(key => copied.has(key))) this.put(id, memory);
        }
    }

    sync(scope, messages, expected, parentChat) {
        const id = scopeId(scope);
        const parentId = parentChat && parentChat !== scope.chat ? scopeId({ ...scope, chat: parentChat }) : null;
        if (!Array.isArray(messages) || messages.length > 20000) throw new Error('聊天消息数量无效');
        const existing = this.revision(id);
        const conflict = () => Object.assign(new Error('聊天已在其他页面更新，请刷新后重试'), { status: 409 });
        if (messages.some(m => typeof m === 'string')) {
            // Unchanged messages arrive as bare ids and are read from the snapshot this page last confirmed.
            if (!existing || expected !== existing) throw conflict();
            const cached = this.cache.get(id);
            const known = new Map((cached?.revision === existing ? cached.messages : this.chat(id).messages).map(m => [m.id, m]));
            messages = messages.map(m => typeof m === 'string' ? known.get(m) : m);
        }
        const ids = new Set();
        const snapshot = messages.map(m => {
            if (!m || typeof m.id !== 'string' || !m.id || m.id.length > 128 || ids.has(m.id) || !['user', 'assistant', 'system'].includes(m.role) || typeof m.text !== 'string' || m.text.length > 200000) throw new Error('聊天消息格式或来源 ID 无效');
            ids.add(m.id);
            return storedMessage(m);
        });
        const text = JSON.stringify(snapshot), revision = createHash('sha256').update(text).digest('hex');
        // A page that has just read the chat file sends no revision and is taken as the truth;
        // after that it must continue from the revision it was given.
        if (existing && expected && expected !== existing && revision !== existing) throw conflict();
        if (existing === revision) return this.state(id);
        this.db.transaction(() => {
            this.db.prepare('INSERT INTO chats(id,scope,revision,snapshot) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,snapshot=excluded.snapshot').run(id, JSON.stringify(scope), revision, text);
            this.turns(id, snapshot);
            if (!existing && parentId) this.inherit(id, parentId);
            this.schedule(id);
        })();
        return this.state(id);
    }

    schedule(id) {
        const chat = this.db.prepare('SELECT paused FROM chats WHERE id=?').get(id);
        if (!chat) return;
        const turns = this.turns(id);
        const validTurns = new Map(turns.filter(t => t.eligible && !t.empty).map(t => [t.key, t]));
        const savedMemories = [];
        for (const memory of this.memories(id)) {
            const cleaned = cleanMemory(memory);
            if (!cleaned.summary) { this.remove(id, memory.id); continue; }
            if (cleaned !== memory) this.put(id, cleaned);
            savedMemories.push(cleaned);
        }
        const summaries = new Map();
        for (const memory of savedMemories) {
            if (memory.kind !== 'summary') continue;
            const turn = validTurns.get(memory.id);
            if (!turn || turn.sourceHash !== memory.sourceHash) { this.remove(id, memory.id); continue; }
            if (memory.turn !== turn.number) { memory.turn = turn.number; this.put(id, memory); }
            summaries.set(memory.id, memory);
        }
        // A task row only says what to do; its text is read from the chat when the work starts.
        const jobs = [], ready = this.config.summary.url && this.config.summary.model;
        if (ready) for (const turn of validTurns.values()) {
            if (!summaries.has(turn.key) && !turn.held) jobs.push({ kind: 'summary', key: turn.key, sourceHash: turn.sourceHash, config: summarySignature(this.config) });
        }
        const savedGroups = savedMemories.filter(m => m.kind === 'group');
        const groups = eligibleGroups(turns, summaries, savedGroups).map(group => ({ ...group, key: hash(group.ids), sourceHash: groupHash(group.children) }));
        const groupsById = new Map(groups.map(group => [group.key, group]));
        const currentGroups = new Set();
        for (const memory of savedGroups) {
            const group = groupsById.get(memory.id);
            if (!group || group.sourceHash !== memory.sourceHash) this.remove(id, memory.id);
            else {
                if (memory.turn !== group.start || memory.end !== group.end) { memory.turn = group.start; memory.end = group.end; this.put(id, memory); }
                currentGroups.add(memory.id);
            }
        }
        if (ready) for (const group of groups) {
            if (!currentGroups.has(group.key)) jobs.push({ kind: 'group', key: group.key, sourceHash: group.sourceHash, config: summarySignature(this.config), children: group.children.map(m => m.id) });
        }
        if (this.config.mode === 'enhanced' && this.config.embedding.url && this.config.embedding.model) for (const memory of summaries.values()) {
            if (!memory.enabled || memory.vectorSignature === vectorSignature(this.config)) continue;
            jobs.push({ kind: 'embedding', key: memory.id, sourceHash: hash(memory.summary), config: vectorSignature(this.config) });
        }
        const wanted = new Map(jobs.map(job => [hash([id, job.kind, job.key, job.sourceHash, job.config]), job]));
        for (const job of this.db.prepare("SELECT id FROM jobs WHERE chat_id=? AND status IN ('queued','running','error')").all(id)) {
            if (!wanted.has(job.id) || chat.paused) this.db.prepare("UPDATE jobs SET status='cancelled',lease=NULL,input='{}' WHERE id=?").run(job.id);
            else wanted.delete(job.id);
        }
        if (chat.paused) return;
        for (const [jobId, job] of wanted) {
            this.db.prepare("INSERT INTO jobs(id,chat_id,kind,status,input) VALUES(?,?,?,'queued',?) ON CONFLICT(id) DO UPDATE SET status='queued',input=excluded.input").run(jobId, id, job.kind, JSON.stringify(job));
        }
    }

    // The full request for one summary or merge task, built from the chat as it is now.
    input(row) {
        const job = JSON.parse(row.input), turns = this.turns(row.chat_id);
        const names = turn => ({ userName: turn?.user[0]?.name, characterName: turn?.assistant[0]?.name });
        if (job.kind === 'group') {
            const memories = new Map(this.memories(row.chat_id).map(m => [m.id, m]));
            const children = (job.children || job.memory.children).map(key => memories.get(key));
            return { ...job, names: names(turns.at(-1)), prompt: children.map(m => `【第 ${m.turn} 轮】\n${m.summary}`).join('\n\n'),
                memory: { id: job.key, kind: 'group', turn: children[0].turn, end: children.at(-1).turn, ids: children.flatMap(m => m.ids),
                    sourceUserIds: [...new Set(children.flatMap(m => m.sourceUserIds || []))], sourceAssistantIds: [...new Set(children.flatMap(m => m.sourceAssistantIds || []))],
                    children: children.map(m => m.id), sourceHash: job.sourceHash, enabled: true, recipe: 'lm-1.9.5' } };
        }
        const index = turns.findIndex(turn => turn.key === job.key), turn = turns[index];
        const background = turns.slice(Math.max(0, index - 3), index).filter(t => t.eligible && !t.empty);
        return { ...job, names: names(turn),
            memory: { id: turn.key, kind: 'summary', turn: turn.number, ids: turn.ids, sourceUserIds: turn.userIds, sourceAssistantIds: turn.assistantIds, sourceHash: turn.sourceHash, userText: shownText(turn.user), enabled: true, recipe: 'lm-1.9.5' },
            contextTurns: [...background, turn].map(t => ({ number: t.number, user: shownText(t.user), assistant: shownText(t.assistant) })) };
    }

    state(id) {
        const chat = this.db.prepare('SELECT revision,paused FROM chats WHERE id=?').get(id);
        if (!chat) return { revision: null, counts: {}, total: 0, paused: false };
        const counts = Object.fromEntries(this.db.prepare('SELECT status,count(*) AS n FROM jobs WHERE chat_id=? GROUP BY status').all(id).map(r => [r.status, r.n]));
        const memories = this.memories(id), summaries = memories.filter(m => m.kind === 'summary');
        // Turns a memory in use stands for in the prompt: enabled merged memories, and enabled summaries no merge took in.
        const groups = memories.filter(m => m.kind === 'group'), merged = new Set(groups.flatMap(m => m.children || []));
        const covered = [...groups.filter(m => m.enabled !== false).map(m => [m.turn, m.end]),
            ...summaries.filter(m => m.enabled !== false && !merged.has(m.id)).map(m => [m.turn, m.turn])];
        return { revision: chat.revision, counts, total: memories.length, paused: !!chat.paused, covered,
            summaries: summaries.length, groups: memories.length - summaries.length,
            indexed: summaries.filter(m => m.embeddingQ && m.vectorSignature === vectorSignature(this.config)).length,
            legacy: summaries.filter(m => m.recipe !== 'lm-1.9.5' && !m.edited).length,
            errors: this.db.prepare("SELECT id,kind,error FROM jobs WHERE chat_id=? AND status='error' LIMIT 10").all(id) };
    }

    pause(id, paused) {
        this.db.transaction(() => {
            this.db.prepare('UPDATE chats SET paused=? WHERE id=?').run(+paused, id);
            this.schedule(id);
        })();
    }

    retry(id, memoryId) {
        this.db.transaction(() => {
            if (memoryId) this.remove(id, memoryId);
            this.db.prepare("UPDATE jobs SET status='cancelled',lease=NULL WHERE chat_id=? AND status='error'").run(id);
            this.db.prepare('UPDATE chats SET paused=0 WHERE id=?').run(id);
            this.schedule(id);
        })();
    }

    edit(id, memoryId, input) {
        let memory = this.memories(id).find(m => m.id === memoryId);
        if (!memory) throw new Error('记忆已失效，请刷新');
        if (input.summary !== undefined) {
            if (typeof input.summary !== 'string' || !cleanText(input.summary) || input.summary.length > 20000) throw new Error('记忆正文无效');
            memory = { ...stripVector(memory), summary: cleanText(input.summary) };
            memory.edited = true;
        }
        if (input.enabled !== undefined) memory.enabled = !!input.enabled;
        this.db.transaction(() => { this.put(id, memory); this.schedule(id); })();
    }

    // A renamed chat keeps its memories under the new name; without a new name the chat was deleted.
    move(actor, from, to) {
        this.db.transaction(() => {
            for (const row of this.db.prepare('SELECT id,scope FROM chats').all()) {
                const scope = JSON.parse(row.scope);
                if (scope.actor !== actor || scope.chat !== from) continue;
                const id = to && scopeId({ ...scope, chat: to });
                // A page that has already handed the chat over under its new name took the memories along.
                if (id && !this.db.prepare('SELECT 1 FROM chats WHERE id=?').get(id)) {
                    this.db.prepare('INSERT INTO chats(id,scope,revision,snapshot,paused) SELECT ?,?,revision,snapshot,paused FROM chats WHERE id=?').run(id, JSON.stringify({ ...scope, chat: to }), row.id);
                    this.db.prepare('UPDATE memories SET chat_id=? WHERE chat_id=?').run(id, row.id);
                    this.schedule(id);
                }
                this.db.prepare('DELETE FROM chats WHERE id=?').run(row.id);
            }
        })();
    }

    clear(id) {
        this.db.transaction(() => {
            this.db.prepare('DELETE FROM memories WHERE chat_id=?').run(id);
            this.db.prepare('DELETE FROM jobs WHERE chat_id=?').run(id);
            this.db.prepare('UPDATE chats SET paused=1 WHERE id=?').run(id);
        })();
    }
}
