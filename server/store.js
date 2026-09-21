import fs from 'node:fs';
import path from 'node:path';
import { Database } from './database.js';
import { DEFAULTS, turnsFrom, sourceData, eligibleGroups } from '../shared/model.js';
import { configure, hash, summarySignature, vectorSignature } from './providers.js';

const parse = row => row ? JSON.parse(row.data) : null;
export function scopeId(scope) {
    for (const key of ['actor', 'chat', 'lineage']) if (typeof scope?.[key] !== 'string' || !scope[key] || scope[key].length > 512) throw new Error('聊天身份无效');
    return hash([scope.actor, scope.chat, scope.lineage]);
}

export function sourceTurns(messages) {
    const turns = turnsFrom(messages);
    for (const [index, turn] of turns.entries()) {
        turn.key = hash(turn.ids);
        turn.sourceHash = hash(turns.slice(Math.max(0, index - 3), index + 1).map(sourceData));
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
        `);
        this.config = configure(parse(this.db.prepare('SELECT data FROM config WHERE id=1').get()) || {}, DEFAULTS);
        this.db.prepare("UPDATE jobs SET status='queued', lease=NULL WHERE status='running'").run();
        for (const row of this.db.prepare('SELECT id FROM chats WHERE paused=0').all()) this.schedule(row.id);
    }

    close() { this.db.close(); }
    chat(id) {
        const row = this.db.prepare('SELECT * FROM chats WHERE id=?').get(id);
        return row ? { ...row, scope: JSON.parse(row.scope), messages: JSON.parse(row.snapshot) } : null;
    }
    memories(id) { return this.db.prepare('SELECT data FROM memories WHERE chat_id=?').all(id).map(parse); }
    put(id, memory) { this.db.prepare('INSERT OR REPLACE INTO memories VALUES (?,?,?)').run(id, memory.id, JSON.stringify(memory)); }
    remove(id, key) { this.db.prepare('DELETE FROM memories WHERE chat_id=? AND id=?').run(id, key); }
    job(id) { return this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id); }

    setConfig(input) {
        const next = configure(input, this.config);
        this.db.transaction(() => {
            this.db.prepare('INSERT OR REPLACE INTO config VALUES (1,?)').run(JSON.stringify(next));
            this.config = next;
            for (const row of this.db.prepare('SELECT id FROM chats').all()) this.schedule(row.id);
        })();
        return next;
    }

    sync(scope, messages, expected) {
        const id = scopeId(scope);
        if (!Array.isArray(messages) || messages.length > 20000) throw new Error('聊天消息数量无效');
        const ids = new Set();
        const snapshot = messages.map(m => {
            if (typeof m.id !== 'string' || !m.id || m.id.length > 128 || ids.has(m.id) || !['user', 'assistant', 'system'].includes(m.role) || typeof m.text !== 'string' || m.text.length > 200000) throw new Error('聊天消息格式或来源 ID 无效');
            ids.add(m.id);
            return { id: m.id, role: m.role, name: String(m.name || '').slice(0, 128), text: m.text, swipe: Number.isInteger(m.swipe) ? m.swipe : 0, blocked: !!m.blocked, protected: !!m.protected };
        });
        const revision = hash(snapshot);
        const existing = this.chat(id);
        if (existing && expected !== existing.revision && revision !== existing.revision) throw Object.assign(new Error('聊天已在其他页面更新，请刷新后重试'), { status: 409 });
        this.db.transaction(() => {
            this.db.prepare('INSERT INTO chats(id,scope,revision,snapshot) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,snapshot=excluded.snapshot').run(id, JSON.stringify(scope), revision, JSON.stringify(snapshot));
            if (!existing) {
                const related = this.db.prepare('SELECT m.data,c.scope FROM memories m JOIN chats c ON c.id=m.chat_id WHERE c.id<>?').all(id);
                const turns = new Map(sourceTurns(snapshot).map(t => [t.key, t]));
                for (const row of related) {
                    const parent = JSON.parse(row.scope), memory = parse(row), target = turns.get(memory.id);
                    if (parent.actor === scope.actor && parent.lineage === scope.lineage && memory.kind === 'summary' && target?.eligible && target.sourceHash === memory.sourceHash) this.put(id, { ...memory, turn: target.number });
                }
            }
            this.schedule(id);
        })();
        return this.state(id);
    }

    schedule(id) {
        const chat = this.chat(id);
        if (!chat) return;
        const turns = sourceTurns(chat.messages);
        const validTurns = new Map(turns.filter(t => t.eligible && !t.empty).map(t => [t.key, t]));
        const summaries = new Map();
        for (const memory of this.memories(id)) {
            if (memory.kind !== 'summary') continue;
            const turn = validTurns.get(memory.id);
            if (!turn || turn.sourceHash !== memory.sourceHash) { this.remove(id, memory.id); continue; }
            if (memory.turn !== turn.number) { memory.turn = turn.number; this.put(id, memory); }
            summaries.set(memory.id, memory);
        }
        const jobs = [];
        if (this.config.summary.url && this.config.summary.model) for (const [index, turn] of turns.entries()) {
            if (!validTurns.has(turn.key) || summaries.has(turn.key)) continue;
            jobs.push({ kind: 'summary', key: turn.key, sourceHash: turn.sourceHash, config: summarySignature(this.config),
                memory: { id: turn.key, kind: 'summary', turn: turn.number, ids: turn.ids, sourceHash: turn.sourceHash, userText: turn.user.map(m => `${m.name}: ${m.text}`).join('\n'), enabled: true },
                prompt: `背景（只供理解）：\n${turns.slice(Math.max(0, index - 3), index).map(t => t.text).join('\n\n')}\n\n目标轮次：\n${turn.text}` });
        }
        const groups = eligibleGroups(turns, summaries).map(group => ({ ...group, key: hash(group.ids), sourceHash: hash(group.children.map(m => [m.id, m.summary, m.enabled])) }));
        const currentGroups = new Map();
        for (const memory of this.memories(id).filter(m => m.kind === 'group')) {
            const group = groups.find(g => g.key === memory.id && g.sourceHash === memory.sourceHash);
            if (!group) this.remove(id, memory.id);
            else {
                if (memory.turn !== group.start || memory.end !== group.end) {
                    memory.turn = group.start; memory.end = group.end; this.put(id, memory);
                }
                currentGroups.set(memory.id, memory);
            }
        }
        if (this.config.summary.url && this.config.summary.model) for (const group of groups) {
            if (currentGroups.has(group.key)) continue;
            jobs.push({ kind: 'group', key: group.key, sourceHash: group.sourceHash, config: summarySignature(this.config),
                memory: { id: group.key, kind: 'group', turn: group.start, end: group.end, ids: group.ids, children: group.children.map(m => m.id), sourceHash: group.sourceHash, enabled: true },
                prompt: group.children.map(m => `第 ${m.turn} 轮：${m.summary}`).join('\n\n') });
        }
        if (this.config.mode === 'enhanced' && this.config.embedding.url && this.config.embedding.model) for (const memory of summaries.values()) {
            if (!memory.enabled || memory.vectorSignature === vectorSignature(this.config)) continue;
            jobs.push({ kind: 'embedding', key: memory.id, sourceHash: hash(memory.summary), config: vectorSignature(this.config), prompt: `用户原输入：\n${memory.userText}\n本轮总结：\n${memory.summary}` });
        }
        const wanted = new Set(jobs.map(j => hash([id, j.kind, j.key, j.sourceHash, j.config])));
        for (const job of this.db.prepare("SELECT id FROM jobs WHERE chat_id=? AND status IN ('queued','running','error')").all(id)) {
            if (!wanted.has(job.id) || chat.paused) this.db.prepare("UPDATE jobs SET status='cancelled',lease=NULL,input='{}' WHERE id=?").run(job.id);
        }
        if (chat.paused) return;
        for (const input of jobs) {
            const jobId = hash([id, input.kind, input.key, input.sourceHash, input.config]);
            this.db.prepare(`INSERT INTO jobs(id,chat_id,kind,status,input) VALUES(?,?,?,'queued',?)
                ON CONFLICT(id) DO UPDATE SET status=CASE WHEN jobs.status IN ('done','cancelled') THEN 'queued' ELSE jobs.status END,input=excluded.input`).run(jobId, id, input.kind, JSON.stringify(input));
        }
    }

    state(id) {
        const chat = this.chat(id);
        if (!chat) return { revision: null, counts: {}, total: 0, paused: false };
        const counts = Object.fromEntries(this.db.prepare('SELECT status,count(*) AS n FROM jobs WHERE chat_id=? GROUP BY status').all(id).map(r => [r.status, r.n]));
        return { revision: chat.revision, counts, total: this.memories(id).length, paused: !!chat.paused,
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
        const memory = this.memories(id).find(m => m.id === memoryId);
        if (!memory) throw new Error('记忆已失效，请刷新');
        if (input.summary !== undefined) {
            if (typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > 20000) throw new Error('记忆正文无效');
            memory.summary = input.summary.trim(); memory.vector = null; memory.vectorSignature = null; memory.edited = true;
        }
        if (input.enabled !== undefined) memory.enabled = !!input.enabled;
        this.db.transaction(() => { this.put(id, memory); this.schedule(id); })();
    }

    clear(id) {
        this.db.transaction(() => {
            this.db.prepare('DELETE FROM memories WHERE chat_id=?').run(id);
            this.db.prepare('DELETE FROM jobs WHERE chat_id=?').run(id);
            this.db.prepare('UPDATE chats SET paused=1 WHERE id=?').run(id);
        })();
    }
}
