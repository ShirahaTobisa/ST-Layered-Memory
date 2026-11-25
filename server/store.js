import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Database } from './database.js';
import { DEFAULTS, floorsFrom, turnsFrom, sourceData, eligibleGroups, roleText, cleanMemory, cleanText, stripVector, storedMessage, turnRanges } from '../shared/model.js';
import { configure, hash, summarySignature, vectorSignature } from './providers.js';

const parse = row => row ? JSON.parse(row.data) : null;
export const groupHash = children => hash(children.map(m => [m.id, m.summary, m.enabled]));
// Summaries are written from what the main model was shown, when the page reported it.
export const shownText = messages => roleText(messages.map(m => m.view !== undefined ? { ...m, text: m.view } : m));
export const vectorText = memory => `用户原输入：\n${memory.userText || ''}\n\n本轮总结：\n${memory.summary}`;
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
        this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, scope TEXT NOT NULL, revision TEXT NOT NULL, snapshot TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS memories (chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(chat_id,id));
            CREATE TABLE IF NOT EXISTS memory_numbers (chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
                memory_id TEXT NOT NULL, no INTEGER NOT NULL, PRIMARY KEY(chat_id,memory_id), UNIQUE(chat_id,no));
            CREATE TABLE IF NOT EXISTS embeddings (
                chat_id TEXT NOT NULL,
                memory_id TEXT NOT NULL,
                signature TEXT NOT NULL,
                dims INTEGER NOT NULL,
                scale REAL NOT NULL,
                encoding TEXT NOT NULL,
                vector BLOB NOT NULL,
                PRIMARY KEY(chat_id, memory_id),
                FOREIGN KEY(chat_id, memory_id) REFERENCES memories(chat_id, id) ON DELETE CASCADE ON UPDATE CASCADE
            );
            CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, kind TEXT NOT NULL, status TEXT NOT NULL, input TEXT NOT NULL, lease TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0, retry_after INTEGER NOT NULL DEFAULT 0, duration_ms REAL);
            CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
            CREATE INDEX IF NOT EXISTS jobs_chat ON jobs(chat_id);
            CREATE INDEX IF NOT EXISTS embeddings_chat_sig ON embeddings(chat_id, signature);
        `);
        const jobColumns = this.db.prepare('PRAGMA table_info(jobs)').all().map(c => c.name);
        if (!jobColumns.includes('retry_after')) this.db.exec('ALTER TABLE jobs ADD COLUMN retry_after INTEGER NOT NULL DEFAULT 0');
        if (!jobColumns.includes('duration_ms')) this.db.exec('ALTER TABLE jobs ADD COLUMN duration_ms REAL');
        this.db.exec('CREATE INDEX IF NOT EXISTS jobs_sched ON jobs(status, retry_after)');
        this.stmts = {
            getConfig: this.db.prepare('SELECT data FROM config WHERE id=1'),
            putConfig: this.db.prepare('INSERT OR REPLACE INTO config VALUES (1,?)'),
            getChat: this.db.prepare('SELECT * FROM chats WHERE id=?'),
            getRevision: this.db.prepare('SELECT revision FROM chats WHERE id=?'),
            getPaused: this.db.prepare('SELECT paused FROM chats WHERE id=?'),
            getChatMeta: this.db.prepare('SELECT revision,paused FROM chats WHERE id=?'),
            upsertChat: this.db.prepare('INSERT INTO chats(id,scope,revision,snapshot) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,snapshot=excluded.snapshot'),
            deleteChat: this.db.prepare('DELETE FROM chats WHERE id=?'),
            allChats: this.db.prepare('SELECT id,scope FROM chats'),
            allChatIds: this.db.prepare('SELECT id FROM chats'),
            existsChat: this.db.prepare('SELECT 1 FROM chats WHERE id=?'),
            copyChat: this.db.prepare('INSERT INTO chats(id,scope,revision,snapshot,paused) SELECT ?,?,revision,snapshot,paused FROM chats WHERE id=?'),
            setPaused: this.db.prepare('UPDATE chats SET paused=? WHERE id=?'),
            getMemories: this.db.prepare('SELECT m.data, e.signature AS vector_sig FROM memories m LEFT JOIN embeddings e ON e.chat_id=m.chat_id AND e.memory_id=m.id WHERE m.chat_id=?'),
            getMemoryOne: this.db.prepare('SELECT m.data, e.signature AS vector_sig FROM memories m LEFT JOIN embeddings e ON e.chat_id=m.chat_id AND e.memory_id=m.id WHERE m.chat_id=? AND m.id=?'),
            upsertMemory: this.db.prepare('INSERT INTO memories(chat_id,id,data) VALUES(?,?,?) ON CONFLICT(chat_id,id) DO UPDATE SET data=excluded.data'),
            deleteMemory: this.db.prepare('DELETE FROM memories WHERE chat_id=? AND id=?'),
            deleteChatMemories: this.db.prepare('DELETE FROM memories WHERE chat_id=?'),
            moveMemories: this.db.prepare('UPDATE memories SET chat_id=? WHERE chat_id=?'),
            getNumber: this.db.prepare('SELECT no FROM memory_numbers WHERE chat_id=? AND memory_id=?'),
            numberOwner: this.db.prepare('SELECT memory_id FROM memory_numbers WHERE chat_id=? AND no=?'),
            putNumber: this.db.prepare('INSERT INTO memory_numbers VALUES (?,?,?)'),
            nextNumber: this.db.prepare('INSERT INTO memory_numbers SELECT ?,?,COALESCE(MAX(no),0)+1 FROM memory_numbers WHERE chat_id=? RETURNING no'),
            copyNumbers: this.db.prepare('INSERT INTO memory_numbers SELECT ?,memory_id,no FROM memory_numbers WHERE chat_id=?'),
            moveNumbers: this.db.prepare('UPDATE memory_numbers SET chat_id=? WHERE chat_id=?'),
            upsertEmbedding: this.db.prepare('INSERT INTO embeddings(chat_id,memory_id,signature,dims,scale,encoding,vector) VALUES(?,?,?,?,?,?,?) ON CONFLICT(chat_id,memory_id) DO UPDATE SET signature=excluded.signature,dims=excluded.dims,scale=excluded.scale,encoding=excluded.encoding,vector=excluded.vector'),
            deleteEmbedding: this.db.prepare('DELETE FROM embeddings WHERE chat_id=? AND memory_id=?'),
            deleteChatEmbeddings: this.db.prepare('DELETE FROM embeddings WHERE chat_id=?'),
            getChatEmbeddings: this.db.prepare('SELECT memory_id,dims,vector FROM embeddings WHERE chat_id=? AND signature=?'),
            copyEmbedding: this.db.prepare('INSERT OR REPLACE INTO embeddings(chat_id,memory_id,signature,dims,scale,encoding,vector) SELECT ?,memory_id,signature,dims,scale,encoding,vector FROM embeddings WHERE chat_id=? AND memory_id=?'),
            getJob: this.db.prepare('SELECT * FROM jobs WHERE id=?'),
            getActiveJobs: this.db.prepare("SELECT id FROM jobs WHERE chat_id=? AND status IN ('queued','running','error')"),
            deleteJob: this.db.prepare('DELETE FROM jobs WHERE id=?'),
            deleteChatJobs: this.db.prepare('DELETE FROM jobs WHERE chat_id=?'),
            deleteErrorJobs: this.db.prepare("DELETE FROM jobs WHERE chat_id=? AND status='error'"),
            resetRetryAfter: this.db.prepare("UPDATE jobs SET retry_after=0, error=NULL WHERE chat_id=? AND status='queued' AND retry_after>0"),
            upsertJob: this.db.prepare("INSERT INTO jobs(id,chat_id,kind,status,input,retry_after) VALUES(?,?,?,'queued',?,0) ON CONFLICT(id) DO UPDATE SET status='queued',input=excluded.input,retry_after=0,attempts=0,error=NULL"),
            jobCounts: this.db.prepare('SELECT status,count(*) AS n FROM jobs WHERE chat_id=? GROUP BY status'),
            jobKindCounts: this.db.prepare("SELECT kind,status,count(*) AS n FROM jobs WHERE chat_id=? AND status IN ('queued','running','error') GROUP BY kind,status"),
            jobAvgDuration: this.db.prepare("SELECT kind,avg(duration_ms) AS ms FROM jobs WHERE chat_id=? AND status='done' AND duration_ms IS NOT NULL GROUP BY kind"),
            jobErrors: this.db.prepare("SELECT id,kind,error FROM jobs WHERE chat_id=? AND status='error' LIMIT 10"),
        };
        this.cache = new Map();
        const savedConfig = parse(this.stmts.getConfig.get()) || {};
        this.config = configure(savedConfig, DEFAULTS);
        if (savedConfig.version !== 2) this.migrateLegacy(filename);
        this.db.prepare("UPDATE jobs SET status='queued', lease=NULL, retry_after=0 WHERE status='running'").run();
        this.db.transaction(() => {
            this.migrateInlineEmbeddings();
            for (const row of this.stmts.allChatIds.all()) {
                this.schedule(row.id, { clean: true });
                for (const memory of this.memories(row.id)) if (!this.stmts.getNumber.get(row.id, memory.id)) this.put(row.id, memory);
            }
        })();
    }

    close() { this.db.close(); }

    // Moves legacy base64 embeddings stored inside memories.data into the dedicated BLOB table without re-embedding.
    migrateInlineEmbeddings() {
        const rows = this.db.prepare(`SELECT chat_id, id, data FROM memories WHERE instr(data, '"embeddingQ"') > 0 OR instr(data, '"vector"') > 0`).all();
        for (const row of rows) {
            const memory = JSON.parse(row.data);
            const cleaned = cleanMemory(memory);
            if (!cleaned.summary) { this.stmts.deleteMemory.run(row.chat_id, row.id); continue; }
            if (cleaned !== memory) {
                this.stmts.upsertMemory.run(row.chat_id, row.id, JSON.stringify(stripVector(cleaned)));
                this.stmts.deleteEmbedding.run(row.chat_id, row.id);
                continue;
            }
            if (memory.embeddingQ && memory.vectorSignature && memory.embeddingDims) {
                const bytes = Buffer.from(memory.embeddingQ, 'base64');
                if (bytes.length === memory.embeddingDims) {
                    this.stmts.upsertEmbedding.run(row.chat_id, row.id, memory.vectorSignature, memory.embeddingDims,
                        Number.isFinite(memory.embeddingScale) ? memory.embeddingScale : 1,
                        memory.embeddingEncoding || 'int8:maxabs:v1', bytes);
                }
            }
            this.stmts.upsertMemory.run(row.chat_id, row.id, JSON.stringify(stripVector(memory)));
        }
    }

    migrateLegacy(filename) {
        const chats = this.stmts.allChatIds.all().map(({ id }) => ({ ...this.chat(id), memories: this.memories(id) }));
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
                    const next = { ...memory, no: undefined, id: turn.key, ids: turn.ids, turn: turn.number, sourceHash: turn.sourceHash,
                        sourceUserIds: turn.userIds, sourceAssistantIds: turn.assistantIds, userText: roleText(turn.user, false), recipe: 'legacy-v1' };
                    this.remove(chat.id, memory.id); this.put(chat.id, next); migrated.set(memory.id, next);
                }
                for (const memory of chat.memories.filter(memory => memory.kind === 'group')) {
                    const oldChildren = memory.children.map(id => originals.get(id)), children = memory.children.map(id => migrated.get(id));
                    if (children.some(child => !child) || oldChildren.some(child => !child) || groupHash(oldChildren) !== memory.sourceHash) continue;
                    const ids = children.flatMap(child => child.ids);
                    this.remove(chat.id, memory.id);
                    this.put(chat.id, { ...memory, no: undefined, id: hash(ids), ids, children: children.map(child => child.id),
                        sourceHash: groupHash(children), recipe: 'legacy-v1',
                        sourceUserIds: children.flatMap(child => child.sourceUserIds), sourceAssistantIds: children.flatMap(child => child.sourceAssistantIds) });
                }
            }
            this.stmts.putConfig.run(JSON.stringify(this.config));
        })();
    }

    chat(id) {
        const row = this.stmts.getChat.get(id);
        if (!row) return null;
        const cached = this.cache.get(id);
        const messages = cached?.revision === row.revision ? cached.messages : JSON.parse(row.snapshot);
        return { ...row, scope: JSON.parse(row.scope), messages };
    }
    revision(id) { return this.stmts.getRevision.get(id)?.revision; }
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

    memories(id) {
        return this.stmts.getMemories.all(id).map(row => {
            const memory = JSON.parse(row.data);
            if (row.vector_sig) memory.vectorSignature = row.vector_sig;
            return memory;
        });
    }

    memory(id, key) {
        const row = this.stmts.getMemoryOne.get(id, key);
        if (!row) return null;
        const memory = JSON.parse(row.data);
        if (row.vector_sig) memory.vectorSignature = row.vector_sig;
        return memory;
    }

    embeddings(id, signature) {
        const map = new Map();
        for (const row of this.stmts.getChatEmbeddings.all(id, signature)) {
            if (row.vector && row.vector.byteLength === row.dims) {
                map.set(row.memory_id, new Int8Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength));
            }
        }
        return map;
    }

    putEmbedding(id, memoryId, signature, packed) {
        this.stmts.upsertEmbedding.run(id, memoryId, signature, packed.dims, packed.scale, packed.encoding, packed.vector);
    }

    clearEmbeddings(id) {
        this.stmts.deleteChatEmbeddings.run(id);
    }

    number(id, memory) {
        let no = this.stmts.getNumber.get(id, memory.id)?.no;
        if (!no) {
            if (Number.isSafeInteger(memory.no) && memory.no > 0) {
                const owner = this.stmts.numberOwner.get(id, memory.no);
                if (owner && owner.memory_id !== memory.id) throw new Error('记忆编号与当前聊天冲突');
                this.stmts.putNumber.run(id, memory.id, memory.no);
                no = memory.no;
            } else no = this.stmts.nextNumber.get(id, memory.id, id).no;
        }
        return no;
    }

    put(id, memory, { clearEmbedding = false } = {}) {
        const cleaned = cleanMemory(memory);
        if (!cleaned.summary) throw new Error('记忆过滤思考内容后为空，保留原文');
        const stripped = stripVector(cleaned);
        this.stmts.upsertMemory.run(id, memory.id, JSON.stringify({ ...stripped, no: this.number(id, memory) }));
        if (clearEmbedding || cleaned !== memory) {
            this.stmts.deleteEmbedding.run(id, memory.id);
        } else if (cleaned.embeddingQ && cleaned.vectorSignature && cleaned.embeddingDims) {
            const bytes = Buffer.from(cleaned.embeddingQ, 'base64');
            if (bytes.length === cleaned.embeddingDims) {
                this.stmts.upsertEmbedding.run(id, memory.id, cleaned.vectorSignature, cleaned.embeddingDims,
                    Number.isFinite(cleaned.embeddingScale) ? cleaned.embeddingScale : 1,
                    cleaned.embeddingEncoding || 'int8:maxabs:v1', bytes);
            }
        }
    }
    remove(id, key) { this.stmts.deleteMemory.run(id, key); }
    job(id) { return this.stmts.getJob.get(id); }

    setConfig(input) {
        const previous = this.config, next = configure(input, previous);
        try {
            this.db.transaction(() => {
                this.stmts.putConfig.run(JSON.stringify(next));
                this.config = next;
                for (const row of this.stmts.allChatIds.all()) this.schedule(row.id);
            })();
        } catch (error) { this.config = previous; throw error; }
        return next;
    }

    inherit(id, parentId) {
        this.stmts.copyNumbers.run(id, parentId);
        const turns = new Map(this.turns(id).filter(t => t.eligible && !t.empty).map(t => [t.key, t]));
        const memories = this.memories(parentId), copied = new Set();
        for (const memory of memories.filter(m => m.kind === 'summary')) {
            const target = turns.get(memory.id);
            if (target?.sourceHash !== memory.sourceHash) continue;
            this.put(id, { ...memory, turn: target.number });
            this.stmts.copyEmbedding.run(id, parentId, memory.id);
            copied.add(memory.id);
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
            this.stmts.upsertChat.run(id, JSON.stringify(scope), revision, text);
            this.turns(id, snapshot);
            if (!existing && parentId) this.inherit(id, parentId);
            this.schedule(id);
        })();
        return this.state(id);
    }

    schedule(id, { clean = false } = {}) {
        const chat = this.stmts.getPaused.get(id);
        if (!chat) return;
        const turns = this.turns(id);
        const validTurns = new Map(turns.filter(t => t.eligible && !t.empty).map(t => [t.key, t]));
        const rawMemories = this.memories(id);
        const savedMemories = [];
        for (const memory of rawMemories) {
            if (!clean) { savedMemories.push(memory); continue; }
            const cleaned = cleanMemory(memory);
            if (!cleaned.summary) { this.remove(id, memory.id); continue; }
            if (cleaned !== memory) this.put(id, cleaned, { clearEmbedding: true });
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
        const sumSig = summarySignature(this.config);
        if (ready) for (const turn of validTurns.values()) {
            if (!summaries.has(turn.key) && !turn.held) jobs.push({ kind: 'summary', key: turn.key, sourceHash: turn.sourceHash, config: sumSig });
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
            if (!currentGroups.has(group.key)) jobs.push({ kind: 'group', key: group.key, sourceHash: group.sourceHash, config: sumSig, children: group.children.map(m => m.id) });
        }
        const vecSig = vectorSignature(this.config);
        if (this.config.mode === 'enhanced' && this.config.embedding.url && this.config.embedding.model) for (const memory of summaries.values()) {
            if (!memory.enabled || memory.vectorSignature === vecSig) continue;
            jobs.push({ kind: 'embedding', key: memory.id, sourceHash: hash(vectorText(memory)), config: vecSig });
        }
        const wanted = new Map(jobs.map(job => [hash([id, job.kind, job.key, job.sourceHash, job.config]), job]));
        for (const job of this.stmts.getActiveJobs.all(id)) {
            if (!wanted.has(job.id) || chat.paused) this.stmts.deleteJob.run(job.id);
            else wanted.delete(job.id);
        }
        if (chat.paused) return;
        for (const [jobId, job] of wanted) this.stmts.upsertJob.run(jobId, id, job.kind, JSON.stringify(job));
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
        const chat = this.stmts.getChatMeta.get(id);
        if (!chat) return { revision: null, counts: {}, total: 0, paused: false };
        const counts = Object.fromEntries(this.stmts.jobCounts.all(id).map(r => [r.status, r.n]));
        const memories = this.memories(id), summaries = memories.filter(m => m.kind === 'summary');
        const summaryTurn = new Map(summaries.filter(m => m.enabled !== false).map(m => [m.id, m.turn]));
        // Turns a memory in use actually stands for: contiguous runs of enabled merged children, plus enabled unmerged summaries.
        const groups = memories.filter(m => m.kind === 'group'), merged = new Set(groups.flatMap(m => m.children || []));
        const covered = [
            ...groups.filter(m => m.enabled !== false).flatMap(m => turnRanges((m.children || []).map(key => summaryTurn.get(key)))),
            ...summaries.filter(m => m.enabled !== false && !merged.has(m.id)).map(m => [m.turn, m.turn]),
        ];
        const vecSig = vectorSignature(this.config);
        const indexed = summaries.filter(m => m.vectorSignature === vecSig).length;
        const kindJobs = this.stmts.jobKindCounts.all(id);
        const averages = new Map(this.stmts.jobAvgDuration.all(id).map(row => [row.kind, row.ms]));
        const progress = ['summary', 'embedding', 'group'].map(kind => {
            const pending = kindJobs.filter(job => job.kind === kind);
            const remaining = pending.reduce((sum, job) => sum + job.n, 0);
            const failed = pending.find(job => job.status === 'error')?.n || 0;
            const done = kind === 'summary' ? summaries.length : kind === 'group' ? groups.length : indexed;
            const activeCount = remaining - failed;
            const slots = kind === 'embedding' ? 1 : this.config.concurrency;
            const eta = !chat.paused && activeCount > 0 && averages.has(kind)
                ? Math.max(1, Math.ceil(activeCount * averages.get(kind) / slots / 1000))
                : null;
            return { kind, done, total: done + remaining, failed, eta };
        });
        const compression = this.compressionStats(id, summaries, groups, merged);
        return { revision: chat.revision, counts, total: memories.length, paused: !!chat.paused, covered, progress, compression,
            summaries: summaries.length, groups: memories.length - summaries.length,
            indexed,
            legacy: summaries.filter(m => m.recipe !== 'lm-1.9.5' && !m.edited).length,
            errors: this.stmts.jobErrors.all(id) };
    }

    compressionStats(id, summaries, groups, merged) {
        const turns = this.turns(id);
        if (!turns.length) return { rawChars: 0, compressedChars: 0, savedPct: 0 };
        const activeGroups = groups.filter(m => m.enabled !== false);
        const activeSummaries = summaries.filter(m => m.enabled !== false && !merged.has(m.id));
        const activeByChild = new Map();
        for (const group of activeGroups) for (const childId of group.children || []) activeByChild.set(childId, group);
        const activeSummaryById = new Map(activeSummaries.map(m => [m.id, m]));
        const raw = new Set(floorsFrom(this.chat(id).messages).filter(floor => floor.role !== 'system').slice(-this.config.keep)
            .flatMap(floor => floor.messages.map(m => m.id)));
        let rawChars = 0, compressedChars = 0;
        const countedGroups = new Set();
        for (const turn of turns) {
            const userLen = shownText(turn.user).length, assistantLen = shownText(turn.assistant).length;
            const turnRaw = userLen + assistantLen;
            rawChars += turnRaw;
            const compressible = turn.assistant.every(m => !m.protected && (!raw.has(m.id) || m.view === ''));
            const group = activeByChild.get(turn.key);
            if (group && compressible && turn.user.every(m => !m.protected)) {
                if (!countedGroups.has(group.id)) {
                    countedGroups.add(group.id);
                    compressedChars += (`总结记忆 第 ${group.turn}-${group.end} 轮`).length + (group.summary || '').length;
                }
                continue;
            }
            const summary = activeSummaryById.get(turn.key);
            if (summary && compressible) {
                compressedChars += userLen + (summary.summary || '').length;
                continue;
            }
            compressedChars += turnRaw;
        }
        const savedPct = rawChars > 0 ? Math.max(0, Math.round((1 - compressedChars / rawChars) * 100)) : 0;
        return { rawChars, compressedChars, savedPct };
    }

    pause(id, paused) {
        this.db.transaction(() => {
            this.stmts.setPaused.run(+paused, id);
            this.schedule(id);
        })();
    }

    retry(id, memoryId) {
        this.db.transaction(() => {
            if (memoryId) this.remove(id, memoryId);
            this.stmts.deleteErrorJobs.run(id);
            this.stmts.resetRetryAfter.run(id);
            this.stmts.setPaused.run(0, id);
            this.schedule(id);
        })();
    }

    edit(id, memoryId, input) {
        let memory = this.memory(id, memoryId);
        if (!memory) throw new Error('记忆已失效，请刷新');
        let clearEmbedding = false;
        if (input.summary !== undefined) {
            if (typeof input.summary !== 'string' || !cleanText(input.summary) || input.summary.length > 20000) throw new Error('记忆正文无效');
            memory = { ...stripVector(memory), summary: cleanText(input.summary) };
            memory.edited = true;
            clearEmbedding = true;
        }
        if (input.enabled !== undefined) memory.enabled = !!input.enabled;
        this.db.transaction(() => { this.put(id, memory, { clearEmbedding }); this.schedule(id); })();
    }

    // A renamed chat keeps its memories under the new name; without a new name the chat was deleted.
    move(actor, from, to) {
        this.db.transaction(() => {
            for (const row of this.stmts.allChats.all()) {
                const scope = JSON.parse(row.scope);
                if (scope.actor !== actor || scope.chat !== from) continue;
                const id = to && scopeId({ ...scope, chat: to });
                // A page that has already handed the chat over under its new name took the memories along.
                if (id && !this.stmts.existsChat.get(id)) {
                    this.stmts.copyChat.run(id, JSON.stringify({ ...scope, chat: to }), row.id);
                    this.stmts.moveMemories.run(id, row.id);
                    this.stmts.moveNumbers.run(id, row.id);
                    this.schedule(id);
                }
                this.stmts.deleteChat.run(row.id);
                this.cache.delete(row.id);
            }
        })();
    }

    clear(id) {
        this.db.transaction(() => {
            this.stmts.deleteChatMemories.run(id);
            this.stmts.deleteChatJobs.run(id);
            this.stmts.setPaused.run(1, id);
        })();
    }
}
