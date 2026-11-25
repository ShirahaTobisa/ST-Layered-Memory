import { randomUUID } from 'node:crypto';
import { hash } from './providers.js';
import { packEmbeddingBlob } from './search.js';
import { vectorText } from './store.js';
import { cleanText } from '../shared/model.js';

const MAX_RETRIES = 3;

export class Engine {
    constructor(store, providers, { retryBaseMs = 5000 } = {}) {
        this.store = store; this.providers = providers; this.retryBaseMs = retryBaseMs;
        this.active = new Map(); this.closed = false; this.retryTimer = null;
    }

    wake() {
        if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
        if (this.closed || this.fault) return;
        const { db } = this.store;
        for (const task of this.active.values()) {
            if (task.rows.some(row => !this.current(row, task))) task.controller.abort();
        }
        const activeJobIds = new Set(), activeSummaryChats = new Set(), activeEmbedChats = new Set();
        for (const task of this.active.values()) {
            for (const row of task.rows) {
                activeJobIds.add(row.id);
                if (row.kind === 'summary') activeSummaryChats.add(row.chat_id);
                if (row.kind === 'embedding') activeEmbedChats.add(row.chat_id);
            }
        }
        const claimStmt = db.prepare("UPDATE jobs SET status='running',lease=?,attempts=attempts+1,error=NULL,retry_after=0 WHERE id=?");
        const readyStmt = db.prepare("SELECT j.* FROM jobs j JOIN chats c ON c.id=j.chat_id WHERE j.status='queued' AND c.paused=0 AND j.retry_after<=? ORDER BY CASE j.kind WHEN 'summary' THEN 0 WHEN 'embedding' THEN 1 ELSE 2 END,j.rowid");
        const embedBatchStmt = db.prepare("SELECT * FROM jobs WHERE chat_id=? AND status='queued' AND kind='embedding' AND retry_after<=? ORDER BY rowid LIMIT 16");
        while (this.active.size < this.store.config.concurrency) {
            const now = Date.now();
            const row = readyStmt.all(now).find(candidate => !activeJobIds.has(candidate.id)
                && !activeEmbedChats.has(candidate.chat_id)
                && (candidate.kind === 'summary' || !activeSummaryChats.has(candidate.chat_id)));
            if (!row) break;
            const rows = row.kind === 'embedding' ? embedBatchStmt.all(row.chat_id, now) : [row];
            const lease = randomUUID();
            for (const item of rows) {
                claimStmt.run(lease, item.id);
                activeJobIds.add(item.id);
            }
            if (row.kind === 'summary') activeSummaryChats.add(row.chat_id);
            if (row.kind === 'embedding') activeEmbedChats.add(row.chat_id);
            const task = { lease, rows, controller: new AbortController(), started: Date.now() };
            this.active.set(row.id, task);
            task.promise = this.run(row, task).catch(error => {
                console.error('[layered-memory] storage fault:', error);
                this.fault = '记忆存储写入失败，后台已暂停；请检查磁盘并重启酒馆';
                for (const active of this.active.values()) active.controller.abort();
            }).finally(() => { this.active.delete(row.id); this.wake(); });
        }
        if (!this.closed && !this.fault) {
            const next = db.prepare("SELECT MIN(j.retry_after) AS at FROM jobs j JOIN chats c ON c.id=j.chat_id WHERE j.status='queued' AND c.paused=0 AND j.retry_after>?").get(Date.now())?.at;
            if (next) {
                this.retryTimer = setTimeout(() => { this.retryTimer = null; this.wake(); }, Math.max(10, next - Date.now()));
                this.retryTimer.unref?.();
            }
        }
    }

    current(row, task) {
        const saved = this.store.job(row.id);
        return !this.closed && saved?.status === 'running' && saved.lease === task.lease;
    }

    fail(task, error) {
        const interrupted = task.controller.signal.aborted;
        const retryable = !interrupted && !!error?.retryable && error?.name !== 'TimeoutError';
        const message = error?.name === 'TimeoutError' ? '模型响应超时，可手动重试' : String(error?.message || error).slice(0, 250);
        const update = this.store.db.prepare('UPDATE jobs SET status=?,lease=NULL,error=?,retry_after=? WHERE id=?');
        for (const row of task.rows) {
            const saved = this.store.job(row.id);
            if (this.closed || saved?.status !== 'running' || saved.lease !== task.lease) continue;
            if (interrupted) {
                // A changed item cancels the shared request, not its unaffected neighbours.
                update.run('queued', null, 0, row.id);
            } else if (retryable && (saved.attempts || 1) <= MAX_RETRIES) {
                const attempt = saved.attempts || 1;
                const delay = error.retryAfter ?? Math.min(60000, this.retryBaseMs * (3 ** (attempt - 1)));
                update.run('queued', `${message}（自动重试 ${attempt}/${MAX_RETRIES}）`, Date.now() + delay, row.id);
            } else {
                update.run('error', message, 0, row.id);
            }
        }
    }

    async run(row, task) {
        if (row.kind === 'embedding') return this.embedBatch(task);
        const config = structuredClone(this.store.config);
        let input, result;
        try {
            input = this.store.input(row);
            if (JSON.stringify(input.contextTurns || input.prompt).length > 200000) throw new Error('本轮文本过长，需手动整理；原文保留');
            result = cleanText(await this.providers.summarize(config, input, task.controller.signal));
            if (!result) throw new Error('总结未返回有效正文，保留原文');
        } catch (error) { this.fail(task, error); return; }
        if (!this.current(row, task)) return;
        // Storage failures must reach wake() and stop the worker, not become model errors.
        this.store.db.transaction(() => {
            this.store.put(row.chat_id, { ...input.memory, summary: result, model: config.summary.model, updated: Date.now() });
            this.store.db.prepare("UPDATE jobs SET status='done',lease=NULL,input='{}',retry_after=0,duration_ms=? WHERE id=?").run(Math.max(1, Date.now() - task.started), row.id);
            this.store.schedule(row.chat_id);
        })();
    }

    async embedBatch(task) {
        const inputs = task.rows.map(row => JSON.parse(row.input));
        const texts = new Map(this.store.memories(task.rows[0].chat_id).map(memory => [memory.id, vectorText(memory)]));
        let packed;
        try {
            const vectors = await this.providers.embed(structuredClone(this.store.config), inputs.map(input => texts.get(input.key)), task.controller.signal);
            if (vectors.length !== inputs.length) throw new Error('向量数量不匹配');
            packed = vectors.map(packEmbeddingBlob);
        } catch (error) { this.fail(task, error); return; }
        const markDone = this.store.db.prepare("UPDATE jobs SET status='done',lease=NULL,input='{}',retry_after=0,duration_ms=? WHERE id=?");
        const perItemMs = Math.max(1, (Date.now() - task.started) / task.rows.length);
        this.store.db.transaction(() => {
            const memories = new Map(this.store.memories(task.rows[0].chat_id).map(memory => [memory.id, memory]));
            task.rows.forEach((row, index) => {
                if (!this.current(row, task)) return;
                const input = inputs[index], memory = memories.get(input.key);
                if (!memory || hash(vectorText(memory)) !== input.sourceHash) return;
                this.store.putEmbedding(row.chat_id, memory.id, input.config, packed[index]);
                markDone.run(perItemMs, row.id);
            });
            this.store.schedule(task.rows[0].chat_id);
        })();
    }

    async close() {
        this.closed = true;
        if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
        for (const task of this.active.values()) task.controller.abort();
        await Promise.allSettled([...this.active.values()].map(task => task.promise));
        this.store.close();
    }
}
