import { randomUUID } from 'node:crypto';
import { hash } from './providers.js';
import { packEmbedding } from './search.js';

export class Engine {
    constructor(store, providers) { this.store = store; this.providers = providers; this.active = new Map(); this.closed = false; }

    wake() {
        if (this.closed || this.fault) return;
        const { db } = this.store;
        for (const [id, task] of this.active) {
            if (task.rows.some(row => { const saved = this.store.job(row.id); return !saved || saved.status !== 'running' || saved.lease !== task.lease; })) task.controller.abort();
        }
        while (this.active.size < this.store.config.concurrency) {
            const row = db.prepare("SELECT j.* FROM jobs j JOIN chats c ON c.id=j.chat_id WHERE j.status='queued' AND c.paused=0 ORDER BY CASE j.kind WHEN 'summary' THEN 0 WHEN 'embedding' THEN 1 ELSE 2 END,j.rowid LIMIT 1").get();
            if (!row || this.active.has(row.id)) break;
            if (row.kind !== 'summary' && [...this.active.values()].some(t => t.rows.some(r => r.kind === 'summary'))) break;
            if ([...this.active.values()].some(t => t.rows.some(r => r.kind === 'embedding'))) break;
            const rows = row.kind === 'embedding' ? db.prepare("SELECT * FROM jobs WHERE chat_id=? AND status='queued' AND kind='embedding' ORDER BY rowid LIMIT 16").all(row.chat_id) : [row];
            const lease = randomUUID();
            for (const item of rows) db.prepare("UPDATE jobs SET status='running',lease=?,attempts=attempts+1,error=NULL WHERE id=?").run(lease, item.id);
            const task = { lease, rows, controller: new AbortController() };
            this.active.set(row.id, task);
            task.promise = this.run(row, task).catch(() => {
                this.fault = '记忆存储写入失败，后台已暂停；请检查磁盘并重启酒馆';
                for (const active of this.active.values()) active.controller.abort();
            }).finally(() => { this.active.delete(row.id); this.wake(); });
        }
    }

    async run(row, task) {
        if (row.kind === 'embedding') return this.embedBatch(task);
        const input = JSON.parse(row.input), config = structuredClone(this.store.config);
        const current = () => {
            const saved = this.store.job(row.id);
            return !this.closed && saved?.status === 'running' && saved.lease === task.lease;
        };
        try {
            if (input.prompt.length > 200000) throw new Error('本轮文本过长，需手动整理；原文保留');
            const result = await this.providers.summarize(config, input, task.controller.signal);
            if (!current()) return;
            this.store.db.transaction(() => {
                this.store.put(row.chat_id, { ...input.memory, summary: result, model: config.summary.model, updated: Date.now() });
                this.store.db.prepare("UPDATE jobs SET status='done',lease=NULL,input='{}' WHERE id=?").run(row.id);
                this.store.schedule(row.chat_id);
            })();
        } catch (error) {
            if (current()) this.store.db.prepare("UPDATE jobs SET status='error',lease=NULL,error=? WHERE id=?").run(
                task.controller.signal.aborted ? '任务已停止' : error.name === 'TimeoutError' ? '模型响应超时，可手动重试' : String(error.message).slice(0, 250), row.id);
        }
    }

    async embedBatch(task) {
        const inputs = task.rows.map(row => JSON.parse(row.input));
        const current = row => { const saved = this.store.job(row.id); return !this.closed && saved?.status === 'running' && saved.lease === task.lease; };
        try {
            const vectors = await this.providers.embed(structuredClone(this.store.config), inputs.map(input => input.prompt), task.controller.signal);
            if (vectors.length !== inputs.length) throw new Error('向量数量不匹配');
            const packed = vectors.map(packEmbedding);
            this.store.db.transaction(() => {
                task.rows.forEach((row, index) => {
                    if (!current(row)) return;
                    const input = inputs[index], memory = this.store.memories(row.chat_id).find(m => m.id === input.key);
                    if (!memory || hash(memory.summary) !== input.sourceHash) return;
                    delete memory.vector;
                    this.store.put(row.chat_id, { ...memory, ...packed[index], vectorSignature: input.config });
                    this.store.db.prepare("UPDATE jobs SET status='done',lease=NULL,input='{}' WHERE id=?").run(row.id);
                });
                this.store.schedule(task.rows[0].chat_id);
            })();
        } catch (error) {
            for (const row of task.rows) if (current(row)) this.store.db.prepare("UPDATE jobs SET status='error',lease=NULL,error=? WHERE id=?").run(task.controller.signal.aborted ? '任务已停止' : String(error.message).slice(0, 250), row.id);
        }
    }

    async close() {
        this.closed = true;
        for (const task of this.active.values()) task.controller.abort();
        await Promise.allSettled([...this.active.values()].map(task => task.promise));
        this.store.close();
    }
}
