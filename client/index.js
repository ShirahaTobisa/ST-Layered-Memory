import { KEY } from '../shared/model.js';
import { createRuntime } from './runtime.js';

const getContext = () => SillyTavern.getContext();
const panel = document.createElement('details');
panel.id = 'rph-memory';
panel.innerHTML = `<summary>RPH 记忆</summary>
<div class="rph-toolbar"><label class="checkbox_label"><input data-enabled type="checkbox">启用记忆</label><button data-action="connect" title="刷新连接"><i class="fa-solid fa-rotate"></i></button></div>
<p data-status role="status">未连接后端</p>
<nav class="rph-tabs"><button data-tab="settings" aria-pressed="true">设置</button><button data-tab="memories" aria-pressed="false">记忆</button><button data-tab="search" aria-pressed="false">检索</button></nav>
<section data-view="settings">
<form data-settings>
<div class="rph-fields"><label>模式<select name="mode"><option value="classic">基础总结</option><option value="enhanced">总结与检索</option></select></label>
<label>保留原文楼数<input name="keep" type="number" min="2" max="100" value="20"></label>
<label>记忆 Token 预算<input name="budget" type="number" min="128" max="16000" value="2048"></label>
<label>召回条数<input name="topK" type="number" min="1" max="30" value="10"></label>
<label>向量相似度<input name="threshold" type="number" min="-1" max="1" step="0.01" value="0.48"></label>
<label>任务并发<input name="concurrency" type="number" min="1" max="4" value="2"></label></div>
<div data-providers></div>
<label class="checkbox_label"><input name="rerank.enabled" type="checkbox">启用重排</label>
<label class="checkbox_label"><input data-raw-search type="checkbox">允许模型检索聊天原文</label>
<button type="submit" class="menu_button"><i class="fa-solid fa-floppy-disk"></i> 保存设置</button>
</form></section>
<section data-view="memories" hidden>
<div class="rph-toolbar"><button data-action="sync" title="交付当前聊天"><i class="fa-solid fa-cloud-arrow-up"></i></button><button data-action="pause" title="停止后台任务"><i class="fa-solid fa-stop"></i></button><button data-action="retry" title="补录及重试"><i class="fa-solid fa-play"></i></button><button data-action="approve" title="确认最后回复可记忆"><i class="fa-solid fa-check"></i></button><button data-action="export" title="导出记忆"><i class="fa-solid fa-download"></i></button><button data-action="import" title="恢复当前聊天记忆"><i class="fa-solid fa-upload"></i></button><button data-action="clear" title="清空记忆"><i class="fa-solid fa-trash"></i></button></div>
<p data-progress></p><div data-errors></div><div data-memories></div>
<div class="rph-toolbar"><button data-action="previous" title="上一页"><i class="fa-solid fa-chevron-left"></i></button><span data-page>1</span><button data-action="next" title="下一页"><i class="fa-solid fa-chevron-right"></i></button></div>
<input data-import type="file" accept="application/json,.json" hidden>
</section>
<section data-view="search" hidden><form data-search><label>聊天原文检索<input name="query" maxlength="2000" required></label><button class="menu_button" type="submit"><i class="fa-solid fa-magnifying-glass"></i> 检索</button></form><div data-results></div><p>本轮记忆</p><div data-used></div></section>`;
for (const [key, title] of [['summary', '总结模型'], ['embedding', '向量模型'], ['rerank', '重排模型']]) {
    const fieldset = document.createElement('fieldset');
    fieldset.innerHTML = `<legend>${title}</legend><label>接口地址<input name="${key}.url" type="url" placeholder="https://example.com/v1"></label><label>模型<input name="${key}.model"></label><label>API Key<input name="${key}.key" type="password" autocomplete="new-password"></label><label class="checkbox_label"><input name="${key}.clearKey" type="checkbox">清除已保存密钥</label>`;
    if (key === 'embedding') fieldset.insertAdjacentHTML('beforeend', '<label>向量维度（0 为默认）<input name="embedding.dimensions" type="number" min="0" max="8192" value="0"></label>');
    if (key === 'summary') fieldset.insertAdjacentHTML('beforeend', '<label>总结最大输出 Token<input name="summary.maxTokens" type="number" min="128" max="4096" value="700"></label>');
    panel.querySelector('[data-providers]').append(fieldset);
}
document.querySelector('#extensions_settings')?.append(panel);
const select = query => panel.querySelector(query);
const status = text => { select('[data-status]').textContent = text; };
const runtime = createRuntime(getContext, window, (type, data) => {
    if (type === 'error') status(data);
    if (type === 'state') renderState(data);
    if (type === 'prompt') {
        status(data.reason);
        select('[data-used]').textContent = [...data.used.map(m => `第 ${m.turn}${m.end ? `–${m.end}` : ''} 轮：${m.why.join('、')}`), ...data.warnings].join('\n') || '本轮未注入记忆';
    }
});
const settings = () => getContext().extensionSettings[KEY];
let offset = 0, total = 0, busy = false;

function renderState(data) {
    const c = data.counts || {};
    select('[data-progress]').textContent = `${data.paused ? '已停止' : '后台就绪'} · ${data.total} 条记忆 · 等待 ${c.queued || 0} · 运行 ${c.running || 0} · 失败 ${c.error || 0}`;
    select('[data-errors]').textContent = (data.errors || []).map(e => e.error).join('\n');
}
function fill(config) {
    const form = select('[data-settings]');
    for (const input of form.elements) {
        if (!input.name) continue;
        const [group, key] = input.name.split('.');
        const value = key ? config[group]?.[key] : config[group];
        if (key === 'key') { input.value = ''; input.placeholder = config[group].hasKey ? '已保存；留空不变' : '未保存'; }
        else if (key === 'clearKey') input.checked = false;
        else if (input.type === 'checkbox') input.checked = !!value;
        else input.value = value ?? '';
    }
}
async function refreshMemories() {
    const data = await runtime.request('list', { offset });
    renderState(data); total = data.total;
    select('[data-page]').textContent = `${Math.floor(offset / 20) + 1} / ${Math.max(1, Math.ceil(total / 20))}`;
    select('[data-action="previous"]').disabled = offset === 0;
    select('[data-action="next"]').disabled = offset + 20 >= total;
    const container = select('[data-memories]'); container.replaceChildren();
    if (!data.items.length) container.textContent = '暂无记忆';
    for (const memory of data.items) {
        const row = document.createElement('article'); row.className = 'rph-memory-row';
        const heading = document.createElement('div'); heading.className = 'rph-toolbar';
        const title = document.createElement('span'); title.textContent = `第 ${memory.turn}${memory.end ? `–${memory.end}` : ''} 轮 · ${memory.kind === 'group' ? '合并' : '逐轮'}${memory.indexed ? ' · 已建索引' : ''}`;
        const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = memory.enabled; enabled.title = '使用这条记忆';
        enabled.onchange = () => action(async () => { await runtime.request('edit', { id: memory.id, enabled: enabled.checked }); await refreshMemories(); });
        const text = document.createElement('textarea'); text.value = memory.summary; text.rows = 5; text.setAttribute('aria-label', `第 ${memory.turn} 轮记忆`);
        const save = document.createElement('button'); save.title = '保存修改'; save.innerHTML = '<i class="fa-solid fa-floppy-disk"></i>';
        save.onclick = () => action(async () => { await runtime.request('edit', { id: memory.id, summary: text.value }); await refreshMemories(); });
        const retry = document.createElement('button'); retry.title = '重新生成'; retry.innerHTML = '<i class="fa-solid fa-rotate-right"></i>';
        retry.onclick = () => action(async () => { await runtime.request('retry', { id: memory.id }); await refreshMemories(); });
        const sources = document.createElement('details'), summary = document.createElement('summary'), original = document.createElement('pre');
        summary.textContent = '来源原文'; original.textContent = memory.sources.map(m => `${m.name}：${m.text}`).join('\n\n'); sources.append(summary, original);
        heading.append(enabled, title, save, retry); row.append(heading, text, sources); container.append(row);
    }
}
async function action(fn) {
    if (busy) return;
    busy = true; panel.setAttribute('aria-busy', 'true');
    try { await fn(); } catch (error) { status(error.message); }
    finally { busy = false; panel.removeAttribute('aria-busy'); }
}
select('[data-enabled]').checked = settings().enabled;
select('[data-raw-search]').checked = settings().rawSearch;
select('[data-enabled]').onchange = () => action(async () => {
    settings().enabled = select('[data-enabled]').checked; getContext().saveSettingsDebounced();
    if (settings().enabled) { fill((await runtime.connect()).config); await runtime.sync(); renderState(await runtime.request('pause', { paused: false })); status('记忆已开启'); }
    else { if (runtime.session) await runtime.request('pause', { paused: true }); status('记忆已关闭'); }
});
select('[data-raw-search]').onchange = () => { settings().rawSearch = select('[data-raw-search]').checked; getContext().saveSettingsDebounced(); };
select('[data-settings]').onsubmit = event => {
    event.preventDefault(); action(async () => {
        const value = {};
        for (const input of event.target.elements) {
            if (!input.name || input.name.endsWith('clearKey')) continue;
            const [group, key] = input.name.split('.');
            if (key === 'key' && !input.value && !event.target.elements[`${group}.clearKey`].checked) continue;
            const val = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
            if (key) { value[group] ??= {}; value[group][key] = key === 'key' && event.target.elements[`${group}.clearKey`].checked ? '' : val; }
            else value[group] = val;
        }
        fill((await runtime.saveConfig(value)).config); status('设置已保存到服务器');
    });
};
for (const tab of panel.querySelectorAll('[data-tab]')) tab.onclick = () => action(async () => {
    for (const item of panel.querySelectorAll('[data-tab]')) item.setAttribute('aria-pressed', String(item === tab));
    for (const view of panel.querySelectorAll('[data-view]')) view.hidden = view.dataset.view !== tab.dataset.tab;
    if (tab.dataset.tab === 'memories') await refreshMemories();
});
const commands = {
    connect: async () => { fill((await runtime.connect()).config); status('后端已连接'); },
    sync: async () => { renderState(await runtime.sync()); await refreshMemories(); status('聊天已交付'); },
    pause: async () => renderState(await runtime.request('pause', { paused: true })),
    retry: async () => { await runtime.sync(); renderState(await runtime.request('retry')); },
    approve: async () => { if (window.confirm('确认最后一条回复已整理完整，可以用于记忆？')) renderState(await runtime.approveLatest()); },
    clear: async () => { if (window.confirm('清空当前聊天的记忆并停止补录？聊天原文保留。')) { await runtime.request('clear'); await refreshMemories(); } },
    previous: async () => { offset = Math.max(0, offset - 20); await refreshMemories(); },
    next: async () => { if (offset + 20 < total) offset += 20; await refreshMemories(); },
    export: async () => {
        const backup = await runtime.request('export');
        const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'rph-memory-backup.json'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    import: async () => select('[data-import]').click(),
};
for (const button of panel.querySelectorAll('[data-action]')) button.onclick = () => action(commands[button.dataset.action]);
select('[data-import]').onchange = event => action(async () => {
    const file = event.target.files[0]; if (!file) return;
    if (file.size > 20 * 1024 * 1024) throw new Error('备份文件超过 20 MiB');
    const backup = JSON.parse(await file.text());
    if (window.confirm('用备份恢复当前聊天中来源匹配的逐轮记忆？')) { await runtime.request('import', { backup }); await refreshMemories(); }
    event.target.value = '';
});
select('[data-search]').onsubmit = event => {
    event.preventDefault(); action(async () => {
        await runtime.sync(); const data = await runtime.request('search', { query: event.target.elements.query.value });
        select('[data-results]').textContent = data.matches.map(m => `第 ${m.floor} 楼 · ${m.name}\n${m.text}`).join('\n\n') || '没有命中';
    });
};
getContext().eventSource.on(getContext().eventTypes.CHAT_CHANGED, () => { offset = 0; select('[data-memories]').replaceChildren(); select('[data-results]').replaceChildren(); select('[data-used]').replaceChildren(); });
const poll = setInterval(() => {
    if (panel.open && !busy && runtime.session) action(async () => {
        if (!select('[data-view="memories"]').hidden && !select('[data-memories]').contains(document.activeElement)) await refreshMemories();
        else renderState(await runtime.request('state'));
    });
}, 4000);
window.addEventListener('beforeunload', () => clearInterval(poll));
action(async () => { fill((await runtime.connect()).config); status('后端已连接'); if (settings().enabled && getContext().chatId) renderState(await runtime.sync()); });
