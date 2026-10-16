import { KEY, DEFAULTS } from '../shared/model.js';
import { createRuntime } from './runtime.js';

const command = (name, label, style = '') => `<button type="button" data-action="${name}" class="${style}">${label}</button>`;
const providers = [['summary', '总结模型', '将每轮对话整理为记忆；基础和增强模式都需要。'], ['embedding', '向量模型', '增强模式使用，用当前输入找回相关的逐轮记忆。']];

export function mountMemoryPanel(getContext, host = window) {
    const document = host.document;
    const launcher = document.createElement('div'); launcher.className = 'lm-launcher';
    launcher.innerHTML = '<button type="button" class="menu_button">分层记忆 · 打开设置</button><small>未连接服务器</small>';
    document.querySelector('#extensions_settings')?.append(launcher);
    const panel = document.createElement('dialog'); panel.id = 'layered-memory';
    panel.setAttribute('aria-labelledby', 'lm-title');
    panel.innerHTML = `<header class="lm-header"><div><small>LAYERED MEMORY · 0.2.0</small><h2 id="lm-title">记住经历，接着故事</h2></div><div class="lm-actions"><label class="lm-switch"><input data-enabled type="checkbox">启用记忆</label>${command('close', '关闭')}</div></header>
<div class="lm-layout"><nav class="lm-nav" aria-label="记忆设置分区">
<button type="button" data-tab="connection" aria-pressed="true">连接与模型</button><button type="button" data-tab="rules" aria-pressed="false">记忆规则</button><button type="button" data-tab="memories" aria-pressed="false">记忆管理</button><button type="button" data-tab="context" aria-pressed="false">本轮上下文</button></nav>
<main class="lm-content"><form id="lm-settings" data-settings>
<section data-view="connection"><h3>连接与模型</h3><p class="lm-muted">配置保存在当前酒馆账号的服务器数据库中。先配置总结模型，再开启记忆。</p><div class="lm-provider-grid">
${providers.map(([key, title, hint]) => `<fieldset class="lm-card"><legend>${title}</legend><p class="lm-muted">${hint}</p>
<label>API 地址<input name="${key}.url" type="url" placeholder="https://example.com/v1" autocomplete="off"></label>
<label>API Key<input name="${key}.key" type="password" autocomplete="new-password" placeholder="填写密钥"></label><label class="lm-inline"><input name="${key}.clearKey" type="checkbox">清除已保存的密钥</label>
<label>模型名称<input name="${key}.model" list="lm-${key}-models" placeholder="选择或手动填写模型名" autocomplete="off"></label><datalist id="lm-${key}-models"></datalist>
<div class="lm-actions"><button type="button" data-models="${key}">获取模型列表</button><button type="button" data-check="${key}">测试模型</button></div><small data-provider-status="${key}">测试模型会向所填接口发送一条小请求。</small></fieldset>`).join('')}
</div><p class="lm-note">API 地址填根地址。OpenAI 兼容接口通常以 /v1 结尾；Gemini 可使用 /v1beta/openai 兼容地址。密钥留空会保留已保存的值。</p></section>
<section data-view="rules" hidden><h3>记忆方式</h3><div class="lm-mode-grid"><label class="lm-mode"><input name="mode" type="radio" value="classic"><strong>基础模式</strong><span>逐轮总结与旧记忆合并，保留最近原文。</span></label><label class="lm-mode"><input name="mode" type="radio" value="enhanced"><strong>增强模式</strong><span>在相同总结上增加向量召回，补回有关细节。</span></label></div>
<div class="lm-card"><label><span>保留最近 <output data-value="keep">20</output> 楼原文</span><input name="keep" type="range" min="10" max="40" step="2" value="20"></label><p class="lm-muted">连续同角色发言合并算一楼。普通一问一答是两楼；这部分始终保留原文。</p><label><span>总结并发 <output data-value="concurrency">5</output></span><input name="concurrency" type="range" min="1" max="10" step="1" value="5"></label><p class="lm-muted">同时进行的总结请求数量，默认 5。接口限流时可调低。</p></div>
<div class="lm-rules"><div><strong>近期</strong><span>最近原文保持完整</span></div><div><strong>较早</strong><span>用户原输入＋逐轮总结</span></div><div><strong>更早</strong><span>最近 25 轮之外，每 5 轮合并</span></div></div>
<p class="lm-note">增强模式：用最新用户输入找回相关经历，最多 10 条，按时间排列。总结和召回内容共同参与对话，酒馆按模型上下文容量组装请求。</p>
<div class="lm-card"><label class="lm-inline"><input data-raw-search type="checkbox">允许模型检索聊天原文</label><p class="lm-muted">用于找回总结省略的原话，需要主模型支持工具调用。默认关闭。</p><label>每次原文检索结果数<input name="rawLimit" type="number" min="5" max="10" value="5"></label></div>${command('defaults', '恢复默认规则')}</section></form>
<section data-view="memories" hidden><div class="lm-section-heading"><div><h3>记忆管理</h3><p data-chat class="lm-muted">请打开一段聊天</p></div>${command('sync', '刷新记录')}</div>
<div class="lm-stats"><span>逐轮 <b data-count="summaries">0</b></span><span>合并 <b data-count="groups">0</b></span><span>已索引 <b data-count="indexed">0</b></span></div>
<p data-progress role="status">尚未交付聊天</p><div data-errors class="lm-error"></div><p data-legacy class="lm-note" hidden></p>
<div class="lm-actions">${command('retry', '补录 / 重试', 'lm-primary')}${command('pause', '停止后台任务')}${command('approve', '确认最后回复完整')}</div>
<form data-filter class="lm-actions"><input name="query" placeholder="搜索记忆正文" aria-label="搜索记忆正文"><select name="kind" aria-label="记忆类型"><option value="all">全部记忆</option><option value="summary">逐轮总结</option><option value="group">合并总结</option></select><button type="submit">筛选</button></form><div data-memories></div>
<div class="lm-pagination">${command('previous', '上一页')}<span data-page>1 / 1</span>${command('next', '下一页')}</div>
<details class="lm-card"><summary>备份与维护</summary><p class="lm-muted">导出当前聊天的记忆，不包含 API Key。数据库完整备份需停止酒馆后复制用户目录中的 layered-memory 文件夹。</p><div class="lm-actions">${command('export', '导出记忆')}${command('import', '恢复备份')}${command('reindex', '重建向量')}${command('rebuild', '重新整理全部')}${command('clear', '清空当前记忆', 'lm-danger')}</div></details><input data-import type="file" accept="application/json,.json" hidden></section>
<section data-view="context" hidden><h3>本轮上下文</h3><p class="lm-muted">查看上次发送时使用的记忆和实际请求内容。切换聊天后会清空记录。</p><div data-used class="lm-card">尚未生成</div><details class="lm-card"><summary>查看实际发送的上下文</summary><div data-preview></div></details>
<h3>查找聊天原话</h3><form data-search class="lm-actions"><input name="query" maxlength="300" required placeholder="输入人名、物品或约定的关键词" aria-label="原文关键词"><button type="submit">搜索原文</button></form><div data-results></div></section>
</main></div><footer class="lm-footer"><p data-status role="status" aria-live="polite">正在连接服务器…</p><div class="lm-actions">${command('connect', '重新连接')}<button type="submit" form="lm-settings" class="lm-primary">保存设置</button></div></footer>`;
    document.body.append(panel);
    const select = query => panel.querySelector(query), settings = () => getContext().extensionSettings[KEY];
    const drafts = new Map();
    let offset = 0, total = 0, busy = false, dirty = false, paused = false, filter = { query: '', kind: 'all' };
    const status = text => { select('[data-status]').textContent = text; launcher.querySelector('small').textContent = text; };
    const runtime = createRuntime(getContext, host, (type, data) => {
        if (type === 'error') status(data);
        if (type === 'state') renderState(data);
        if (type === 'prompt') {
            status(data.reason);
            select('[data-used]').textContent = [...data.used.map(m => `第 ${m.turn}${m.end ? `–${m.end}` : ''} 轮 · ${(m.why || []).join('、')}\n${m.summary || ''}`), ...(data.warnings || [])].join('\n\n') || '本轮保留原文，没有注入记忆';
            const preview = select('[data-preview]'); preview.replaceChildren();
            for (const message of data.preview || []) { const item = document.createElement('pre'); item.textContent = `${message.role}\n${typeof message.content === 'string' ? message.content : '工具或多媒体消息'}`; preview.append(item); }
        }
    });
    function renderState(data) {
        for (const node of panel.querySelectorAll('[data-count]')) node.textContent = data[node.dataset.count] || 0;
        const c = data.counts || {};
        paused = !!data.paused;
        select('[data-action="pause"]').textContent = paused ? '继续后台任务' : '停止后台任务';
        select('[data-progress]').textContent = `${data.paused ? '已停止' : '后台就绪'} · 等待 ${c.queued || 0} · 运行 ${c.running || 0} · 失败 ${c.error || 0}`;
        select('[data-errors]').textContent = (data.errors || []).map(e => e.error).join('\n');
        select('[data-legacy]').hidden = !data.legacy;
        select('[data-legacy]').textContent = `${data.legacy || 0} 条记忆来自旧版提示词。需要按当前提示词重做时，使用“备份与维护 → 重新整理全部”；会重新调用模型。`;
    }
    function fill(config) {
        for (const input of select('[data-settings]').elements) {
            if (!input.name) continue;
            const [group, key] = input.name.split('.'), value = key ? config[group]?.[key] : config[group];
            if (key === 'key') { input.value = ''; input.placeholder = config[group]?.hasKey ? '已保存；留空保留' : '未保存'; }
            else if (key === 'clearKey') input.checked = false;
            else if (input.type === 'radio') input.checked = input.value === value;
            else input.value = value ?? '';
        }
        select('[data-raw-search]').checked = !!settings().rawSearch;
        for (const output of panel.querySelectorAll('[data-value]')) output.textContent = config[output.dataset.value];
        dirty = false;
    }
    function readConfig() {
        const value = {};
        for (const input of select('[data-settings]').elements) {
            if (!input.name || input.name.endsWith('clearKey') || (input.type === 'radio' && !input.checked)) continue;
            const [group, key] = input.name.split('.');
            const clear = key === 'key' && select(`[name="${group}.clearKey"]`).checked;
            if (key === 'key' && !input.value && !clear) continue;
            const val = clear ? '' : ['range', 'number'].includes(input.type) ? Number(input.value) : input.value;
            if (key) { value[group] ??= {}; value[group][key] = val; } else value[group] = val;
        }
        return value;
    }
    async function action(fn) {
        if (busy) return;
        busy = true; panel.setAttribute('aria-busy', 'true');
        try { await fn(); } catch (error) { status(error.message); }
        finally { busy = false; panel.removeAttribute('aria-busy'); }
    }
    async function refreshMemories() {
        const data = await runtime.request('list', { offset, ...filter });
        renderState(data); total = data.filteredTotal ?? data.total;
        select('[data-chat]').textContent = getContext().chatId || '请打开一段聊天';
        select('[data-page]').textContent = `${Math.floor(offset / 10) + 1} / ${Math.max(1, Math.ceil(total / 10))}`;
        select('[data-action="previous"]').disabled = offset === 0;
        select('[data-action="next"]').disabled = offset + 10 >= total;
        const container = select('[data-memories]'); container.replaceChildren();
        if (!data.items.length) container.textContent = '暂无匹配的记忆。完成对话后自动整理，也可点击“补录 / 重试”。';
        for (const memory of data.items) {
            const row = document.createElement('article'); row.className = 'lm-card';
            row.innerHTML = '<div class="lm-section-heading"><strong></strong><label class="lm-inline"><input type="checkbox">使用</label></div><p class="lm-summary"></p><details><summary>编辑与来源</summary><textarea rows="5" aria-label="编辑记忆正文"></textarea><div class="lm-actions"><button type="button" data-save>保存修改</button><button type="button" data-retry>重新生成</button></div><pre></pre></details>';
            row.querySelector('strong').textContent = `第 ${memory.turn}${memory.end ? `–${memory.end}` : ''} 轮 · ${memory.kind === 'group' ? '合并' : '逐轮'}${memory.indexed ? ' · 已索引' : ''}`;
            row.querySelector('.lm-summary').textContent = memory.summary;
            const input = row.querySelector('input'); input.checked = memory.enabled;
            input.onchange = () => action(async () => { await runtime.request('edit', { id: memory.id, enabled: input.checked }); await refreshMemories(); });
            const text = row.querySelector('textarea'); text.value = drafts.get(memory.id) ?? memory.summary;
            if (drafts.has(memory.id)) row.querySelector('details').open = true;
            text.oninput = () => drafts.set(memory.id, text.value);
            row.querySelector('[data-save]').onclick = () => action(async () => { await runtime.request('edit', { id: memory.id, summary: text.value }); drafts.delete(memory.id); await refreshMemories(); status('记忆已保存，相关索引将重新建立'); });
            row.querySelector('[data-retry]').onclick = () => action(async () => { if (host.confirm('重新生成这条记忆？当前编辑内容将被模型结果替换。')) { await runtime.request('retry', { id: memory.id }); drafts.delete(memory.id); await refreshMemories(); } });
            row.querySelector('pre').textContent = memory.sources.map(m => `${m.name}：${m.text}`).join('\n\n'); container.append(row);
        }
    }
    async function open() { panel.showModal(); if (!dirty) await action(async () => { fill((await runtime.connect()).config); status('服务器已连接'); }); }
    function close() { if ((dirty || drafts.size) && !host.confirm('还有未保存的修改，确定关闭面板？')) return; panel.close(); }
    launcher.querySelector('button').onclick = open;
    panel.addEventListener('cancel', event => { event.preventDefault(); close(); });
    select('[data-enabled]').checked = !!runtime.enabled;
    select('[data-enabled]').onchange = () => action(async () => {
        const enabled = select('[data-enabled]').checked;
        try {
            await runtime.setEnabled(enabled); status(enabled ? '本聊天记忆已开启' : '本聊天记忆已关闭');
        } finally { select('[data-enabled]').checked = !!runtime.enabled; }
    });
    select('[data-settings]').addEventListener('input', event => { dirty = true; const output = select(`[data-value="${event.target.name}"]`); if (output) output.textContent = event.target.value; status('设置已修改，记得保存'); });
    select('[data-settings]').onsubmit = event => { event.preventDefault(); action(async () => { const rawSearch = select('[data-raw-search]').checked; fill((await runtime.saveConfig(readConfig())).config); settings().rawSearch = rawSearch; select('[data-raw-search]').checked = rawSearch; getContext().saveSettingsDebounced(); status('设置已保存'); }); };
    for (const button of panel.querySelectorAll('[data-models], [data-check]')) button.onclick = () => action(async () => {
        const provider = button.dataset.models || button.dataset.check, node = select(`[data-provider-status="${provider}"]`);
        node.textContent = '正在请求…';
        try {
            const result = await runtime.api(button.dataset.models ? 'models' : 'check', { provider, setting: readConfig()[provider] });
            if (result.models) { const list = select(`#lm-${provider}-models`); list.replaceChildren(); for (const model of result.models) { const option = document.createElement('option'); option.value = model; list.append(option); } node.textContent = `已获取 ${result.models.length} 个模型，点击模型名称选择。`; }
            else node.textContent = result.message;
        } catch (error) { node.textContent = error.message; }
    });
    for (const tab of panel.querySelectorAll('[data-tab]')) tab.onclick = () => action(async () => {
        for (const item of panel.querySelectorAll('[data-tab]')) item.setAttribute('aria-pressed', String(item === tab));
        for (const view of panel.querySelectorAll('[data-view]')) view.hidden = view.dataset.view !== tab.dataset.tab;
        if (tab.dataset.tab === 'memories') await refreshMemories();
    });
    const commands = {
        close, connect: async () => { const data = await runtime.connect(); if (!dirty) fill(data.config); status('服务器已连接'); },
        defaults: () => {
            for (const key of ['keep', 'concurrency', 'rawLimit']) { select(`[name="${key}"]`).value = DEFAULTS[key]; const output = select(`[data-value="${key}"]`); if (output) output.textContent = DEFAULTS[key]; }
            for (const input of panel.querySelectorAll('[name="mode"]')) input.checked = input.value === DEFAULTS.mode;
            select('[data-raw-search]').checked = false;
            dirty = true; status('已恢复默认规则，点击保存生效');
        },
        sync: async () => { await runtime.sync(); await refreshMemories(); }, pause: async () => renderState(await runtime.request('pause', { paused: !paused })),
        retry: async () => { await runtime.sync(); renderState(await runtime.request('retry')); },
        approve: async () => { if (host.confirm('确认最后一条回复已经完整，可以用于记忆？')) renderState(await runtime.approveLatest()); },
        reindex: async () => { if (host.confirm('重建当前聊天的全部向量？会重新调用向量模型，原总结保留。')) renderState(await runtime.request('reindex')); },
        rebuild: async () => { if (host.confirm('删除当前聊天已有记忆并按当前提示词重新整理？手动修改也会被替换，并重新调用模型。建议先导出备份。')) { await runtime.request('rebuild'); drafts.clear(); await refreshMemories(); } },
        clear: async () => { if (host.confirm('清空当前聊天的记忆并停止后台任务？聊天原文保留。')) { await runtime.request('clear'); drafts.clear(); await refreshMemories(); } },
        previous: async () => { offset = Math.max(0, offset - 10); await refreshMemories(); }, next: async () => { if (offset + 10 < total) offset += 10; await refreshMemories(); },
        export: async () => { const data = await runtime.request('export'); const url = host.URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = 'layered-memory-backup.json'; link.click(); host.setTimeout(() => host.URL.revokeObjectURL(url), 1000); },
        import: () => select('[data-import]').click(),
    };
    for (const button of panel.querySelectorAll('[data-action]')) button.onclick = () => action(commands[button.dataset.action]);
    select('[data-import]').onchange = event => action(async () => { const file = event.target.files[0]; if (!file) return; if (file.size > 20 * 1024 * 1024) throw new Error('备份文件超过 20 MiB'); const backup = JSON.parse(await file.text()); if (host.confirm('恢复备份中与当前聊天来源匹配的记忆？')) { await runtime.request('import', { backup }); await refreshMemories(); } event.target.value = ''; });
    select('[data-filter]').onsubmit = event => { event.preventDefault(); filter = { query: event.target.elements.query.value, kind: event.target.elements.kind.value }; offset = 0; action(refreshMemories); };
    select('[data-search]').onsubmit = event => { event.preventDefault(); action(async () => { await runtime.sync(); const data = await runtime.request('search', { query: event.target.elements.query.value }); select('[data-results]').textContent = data.matches.map(m => `第 ${m.floor} 楼 · ${m.name}\n${m.text}`).join('\n\n') || '没有命中'; }); };
    getContext().eventSource.on(getContext().eventTypes.CHAT_CHANGED, () => { offset = 0; drafts.clear(); select('[data-enabled]').checked = !!runtime.enabled; select('[data-memories]').replaceChildren(); select('[data-preview]').replaceChildren(); select('[data-used]').textContent = '尚未生成'; select('[data-results]').textContent = ''; if (panel.open && getContext().chatId) action(refreshMemories); });
    const poll = host.setInterval(() => { if (panel.open && !busy && runtime.session) action(async () => { if (!select('[data-view="memories"]').hidden && !select('[data-memories]').contains(document.activeElement)) await refreshMemories(); else renderState(await runtime.request('state')); }); }, 4000);
    const dispose = () => { host.clearInterval(poll); panel.remove(); launcher.remove(); };
    host.addEventListener('beforeunload', () => host.clearInterval(poll));
    fill(DEFAULTS);
    action(async () => { const data = await runtime.connect(); if (!dirty) fill(data.config); status('服务器已连接'); });
    return { panel, runtime, open, dispose };
}

if (typeof SillyTavern !== 'undefined') mountMemoryPanel(() => SillyTavern.getContext());
