import { DatabaseSync } from 'node:sqlite';

export class Database extends DatabaseSync {
    transaction(action) {
        return (...args) => {
            this.exec('BEGIN IMMEDIATE');
            try { const result = action(...args); this.exec('COMMIT'); return result; }
            catch (error) { this.exec('ROLLBACK'); throw error; }
        };
    }
}
