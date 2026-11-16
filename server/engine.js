import { randomUUID } from 'node:crypto';
import { hash } from './providers.js';
import { packEmbedding } from './search.js';
import { vectorText } from './store.js';
import { cleanText } from '../shared/model.js';

export class Engine {
    constructor(store, providers) { this.store = store; this.providers = providers; this.active = new Map(); this.closed = false; }

    wake() {
        if (this.closed || this.fault) return;
        const { db } = this.store;
        for (const task of this.active.values()) {
            if (task.rows.some(row => !this.current(row, task))) task.controller.abort();
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

    current(row, task) {
        const saved = this.store.job(row.id);
        return !this.closed && saved?.status === 'running' && saved.lease === task.lease;
    }

    fail(task, error) {
        const interrupted = task.controller.signal.aborted;
        for (const row of task.rows) if (this.current(row, task)) {
            // A changed item cancels the shared request, not its unaffected neighbours.
            this.store.db.prepare('UPDATE jobs SET status=?,lease=NULL,error=? WHERE id=?').run(
                interrupted ? 'queued' : 'error', interrupted ? null : error.name === 'TimeoutError' ? '模型响应超时，可手动重试' : String(error.message).slice(0, 250), row.id);
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
            this.store.db.prepare("UPDATE jobs SET status='done',lease=NULL,input='{}' WHERE id=?").run(row.id);
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
            packed = vectors.map(packEmbedding);
        } catch (error) { this.fail(task, error); return; }
        this.store.db.transaction(() => {
            const memories = new Map(this.store.memories(task.rows[0].chat_id).map(memory => [memory.id, memory]));
            task.rows.forEach((row, index) => {
                if (!this.current(row, task)) return;
                const input = inputs[index], memory = memories.get(input.key);
                if (!memory || hash(memory.summary) !== input.sourceHash) return;
                delete memory.vector;
                this.store.put(row.chat_id, { ...memory, ...packed[index], vectorSignature: input.config });
                this.store.db.prepare("UPDATE jobs SET status='done',lease=NULL,input='{}' WHERE id=?").run(row.id);
            });
            this.store.schedule(task.rows[0].chat_id);
        })();
    }

    async close() {
        this.closed = true;
        for (const task of this.active.values()) task.controller.abort();
        await Promise.allSettled([...this.active.values()].map(task => task.promise));
        this.store.close();
    }
}
