import fs from 'node:fs';
import path from 'node:path';
import { Store } from './store.js';
import { Engine } from './engine.js';
import { Providers } from './providers.js';
import { registerRoutes } from './routes.js';

export const info = { id: 'rph-memory', name: 'RPH Memory', description: 'Persistent conversation memory for SillyTavern' };
const engines = new Map();
function engineFor(root) {
    const filename = path.join(root, 'rph-memory', 'memory.sqlite');
    if (!engines.has(filename)) {
        const engine = new Engine(new Store(filename), new Providers());
        engines.set(filename, engine); engine.wake();
    }
    return engines.get(filename);
}

export async function init(router) {
    registerRoutes(router, engineFor);
    const root = globalThis.DATA_ROOT;
    if (root && fs.existsSync(root)) for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() && fs.existsSync(path.join(root, entry.name, 'rph-memory', 'memory.sqlite'))) engineFor(path.join(root, entry.name));
    }
}

export async function exit() {
    await Promise.all([...engines.values()].map(engine => engine.close()));
    engines.clear();
}
