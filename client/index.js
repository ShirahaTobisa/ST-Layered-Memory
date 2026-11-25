import { KEY, DEFAULTS, EFFORTS, VERSION } from '../shared/model.js';
import { createRuntime } from './runtime.js';
import { mountCitations } from './citations.js';

const command = (name, label, style = '') => `<button type="button" data-action="${name}" class="${style}">${label}</button>`;
const providers = [['summary', '总结模型', '将每轮对话整理为记忆；基础和增强模式都需要。'], ['embedding', '向量模型', '增强模式使用，用当前输入找回相关的逐轮记忆。'],
    ['rerank', '重排模型', '可选。候选多于召回条数或设置了最低分时，由它挑出最贴合的记忆；接口是 /rerank，留空不用。']];

export function mountMemoryPanel(getContext, host = window, view) {
    const document = host.document;
    const launcher = document.createElement('button'); launcher.type = 'button'; launcher.className = 'menu_button lm-launcher';
    launcher.innerHTML = '<b>分层记忆设置</b><small>未连接服务器</small>';
    document.querySelector('#extensions_settings')?.append(launcher);
    const panel = document.createElement('dialog'); panel.id = 'layered-memory';
    panel.setAttribute('aria-labelledby', 'lm-title');
    panel.innerHTML = `<header class="lm-row lm-bar"><h2 id="lm-title" class="lm-grow">分层记忆 <small>${VERSION}</small></h2><label class="lm-inline"><input data-enabled type="checkbox">启用记忆</label>${command('close', '关闭')}</header>
<nav class="lm-row lm-nav" aria-label="记忆设置分区">
<button type="button" data-tab="connection" aria-pressed="true">连接与模型</button><button type="button" data-tab="rules" aria-pressed="false">记忆规则</button><button type="button" data-tab="memories" aria-pressed="false">记忆管理</button><button type="button" data-tab="context" aria-pressed="false">本轮上下文</button></nav>
<main class="lm-content"><form id="lm-settings" data-settings>
<section data-view="connection"><h3>连接与模型</h3><p class="lm-muted">配置保存在当前酒馆账号的服务器数据库中。先配置总结模型，再开启记忆。</p><div class="lm-grid">
${providers.map(([key, title, hint]) => `<fieldset class="lm-card"><legend>${title}</legend><p class="lm-muted">${hint}</p>
<label>API 地址<input name="${key}.url" type="url" placeholder="https://example.com/v1" autocomplete="off"></label>
<label>API Key<input name="${key}.key" type="password" autocomplete="new-password" placeholder="填写密钥"></label><label class="lm-inline"><input name="${key}.clearKey" type="checkbox">清除已保存的密钥</label>
<label>模型名称<input name="${key}.model" list="lm-${key}-models" placeholder="选择或手动填写模型名" autocomplete="off"></label><datalist id="lm-${key}-models"></datalist>${key === 'summary' ? `
<label>思考强度<select name="summary.effort">${Object.entries(EFFORTS).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label><p class="lm-muted">带思考的模型写总结时可能想很久，又慢又费 token，一般选“低”就够。选“不指定”就不传这个参数，由模型自己决定。</p>` : ''}
<div class="lm-row"><button type="button" data-models="${key}">获取模型列表</button><button type="button" data-check="${key}">测试模型</button></div><small data-provider-status="${key}">测试模型会向所填接口发送一条小请求。</small></fieldset>`).join('')}
</div><p class="lm-muted">API 地址填根地址。OpenAI 兼容接口通常以 /v1 结尾；Gemini 可使用 /v1beta/openai 兼容地址。密钥留空会保留已保存的值。</p></section>
<section data-view="rules" hidden><h3>记忆方式</h3><div class="lm-grid"><label class="lm-card lm-inline"><input name="mode" type="radio" value="classic"><span><strong>基础模式</strong><br><small>逐轮总结与旧记忆合并，保留最近原文。</small></span></label><label class="lm-card lm-inline"><input name="mode" type="radio" value="enhanced"><span><strong>增强模式</strong><br><small>在相同总结上增加混合召回，补回有关细节。</small></span></label></div>
<div class="lm-card"><label><span>保留最近 <output data-value="keep">20</output> 楼原文</span><input name="keep" type="range" min="10" max="40" step="2" value="20"></label><p class="lm-muted">连续同角色发言合并算一楼。普通一问一答是两楼；这部分始终保留原文。</p><label class="lm-inline"><input name="autoHide" type="checkbox">已总结的旧楼自动隐藏</label><p class="lm-muted">保留楼数以外、已有记忆的楼层自动隐藏，整理聊天界面；模型仍收到未合并轮次的用户输入与总结。只会取消插件自己隐藏的楼层；手动或其他脚本隐藏的不动，插件隐藏后你手动取消的也不会再被隐藏。</p><label><span>总结并发 <output data-value="concurrency">5</output></span><input name="concurrency" type="range" min="1" max="10" step="1" value="5"></label><p class="lm-muted">同时进行的总结请求数量，默认 5。接口限流时可调低；临时错误会自动等待后重试，最多 3 次。</p></div>
<div class="lm-grid"><div class="lm-card"><strong>近期</strong><small>最近原文保持完整</small></div><div class="lm-card"><strong>较早</strong><small>用户原输入＋逐轮总结</small></div><div class="lm-card"><strong>更早</strong><small>最近 25 轮之外，每 5 轮合并</small></div></div>
<div class="lm-card"><label class="lm-inline"><input name="citations" type="checkbox">回复中标注记忆来源，点击编号查看</label><label class="lm-inline"><input name="recallShortContext" type="checkbox">短输入时补充上一轮检索语境</label><label class="lm-inline"><input name="recallExcludeRaw" type="checkbox">召回时跳过已完整发送原文的近期轮次</label><div class="lm-grid"><label>向量相似度门槛<input name="recallThreshold" type="number" min="0.1" max="0.9" step="0.01"></label><label>最多召回条数<input name="recallLimit" type="number" min="3" max="20" step="1"></label><label>重排最低分（0 不截断）<input name="rerankThreshold" type="number" min="0" max="1" step="0.05"></label></div><p class="lm-muted">增强模式结合向量与关键词查找相关经历；短输入会结合上一轮语境。结果按时间排列，酒馆负责最终上下文容量。</p></div>
<div class="lm-card"><label class="lm-inline"><input data-raw-search type="checkbox">允许模型检索聊天原文</label><p class="lm-muted">用于找回总结省略的原话，需要主模型支持工具调用。默认关闭。</p><label>每次原文检索结果数<input name="rawLimit" type="number" min="5" max="10" value="5"></label></div><div class="lm-row">${command('defaults', '恢复默认规则')}</div></section></form>
<section data-view="memories" hidden><div class="lm-row"><div class="lm-grow"><h3>记忆管理</h3><p data-chat class="lm-muted">请打开一段聊天</p></div>${command('sync', '刷新记录')}</div>
<p>逐轮 <b data-count="summaries">0</b> · 合并 <b data-count="groups">0</b> · 已索引 <b data-count="indexed">0</b></p>
<p data-progress role="status">尚未交付聊天</p><div data-stages class="lm-grid"></div><p data-compression class="lm-muted" hidden></p><div data-errors class="lm-log lm-danger"></div><p data-legacy class="lm-muted" hidden></p>
<div class="lm-row">${command('retry', '补录 / 重试', 'lm-primary')}${command('pause', '停止后台任务')}</div>
<form data-filter class="lm-row"><input name="query" class="lm-grow" placeholder="搜索记忆正文" aria-label="搜索记忆正文"><select name="kind" aria-label="记忆类型"><option value="all">全部记忆</option><option value="summary">逐轮总结</option><option value="group">合并总结</option></select><select name="order" aria-label="记忆顺序"><option value="desc">最新在前</option><option value="asc">最早在前</option></select><button type="submit">筛选</button></form><div data-memories></div>
<div class="lm-row">${command('previous', '上一页')}<span data-page class="lm-grow">1 / 1</span>${command('next', '下一页')}</div>
<details class="lm-card"><summary>备份与维护</summary><p class="lm-muted">导出当前聊天的记忆，不包含 API Key。数据库完整备份需停止酒馆后复制用户目录中的 layered-memory 文件夹。</p><div class="lm-row">${command('export', '导出记忆')}${command('import', '恢复备份')}${command('reindex', '重建向量')}${command('rebuild', '重新整理全部')}${command('clear', '清空当前记忆', 'lm-danger')}</div></details><input data-import type="file" accept="application/json,.json" hidden></section>
<section data-view="context" hidden><h3>本轮上下文</h3><p class="lm-muted">查看上次发送时使用的记忆和实际请求内容。切换聊天后会清空记录。</p><div data-used class="lm-card lm-log">尚未生成</div><details class="lm-card"><summary>查看实际发送的上下文</summary><div data-preview class="lm-log"></div></details>
<h3>查找聊天原话</h3><form data-search class="lm-row"><input name="query" class="lm-grow" maxlength="300" required placeholder="输入人名、物品或约定的关键词" aria-label="原文关键词"><button type="submit">搜索原文</button></form><div data-results class="lm-text"></div></section>
</main><footer class="lm-row lm-bar"><p data-status role="status" aria-live="polite" class="lm-grow">正在连接服务器…</p>${command('connect', '重新连接')}<button type="submit" form="lm-settings" class="lm-primary">保存设置</button></footer>`;
    document.body.append(panel);
    const select = query => panel.querySelector(query), settings = () => getContext().extensionSettings[KEY];
    const drafts = new Map();
    let offset = 0, total = 0, busy = 0, polling = false, dirty = false, paused = false, notice = '', filter = { query: '', kind: 'all', order: 'desc' };
    let actions = Promise.resolve(), listSignature = '', refreshSequence = 0;
    const status = text => { select('[data-status]').textContent = text; launcher.querySelector('small').textContent = text; };
    const runtime = createRuntime(getContext, host, (type, data) => {
        if (type === 'error') status(notice = data);
        if (type === 'state') renderState(data);
        if (type === 'prompt') {
            status(notice = data.reason);
            select('[data-used]').textContent = [...data.used.map(m => `${m.no ? `M${m.no} · ` : ''}第 ${m.turn}${m.end ? `–${m.end}` : ''} 轮 · ${(m.why || []).join('、')}\n${m.summary || ''}`), ...(data.warnings || [])].join('\n\n') || '本轮保留原文，没有注入记忆';
            const preview = select('[data-preview]'); preview.replaceChildren();
            for (const message of data.preview || []) { const item = document.createElement('p'); item.textContent = `${message.role}\n${typeof message.content === 'string' ? message.content : '工具或多媒体消息'}`; preview.append(item); }
        }
    }, view);
    const disposeCitations = mountCitations(getContext, runtime, host);
    function renderState(data) {
        for (const node of panel.querySelectorAll('[data-count]')) node.textContent = data[node.dataset.count] || 0;
        const c = data.counts || {};
        paused = !!data.paused;
        select('[data-action="pause"]').textContent = paused ? '继续后台任务' : '停止后台任务';
        select('[data-progress]').textContent = data.revision ? `${data.paused ? '已停止' : '后台就绪'} · 等待 ${c.queued || 0} · 运行 ${c.running || 0} · 失败 ${c.error || 0}` : '尚未交付聊天';
        const stages = select('[data-stages]'); stages.replaceChildren();
        for (const stage of data.progress || []) {
            if (stage.kind === 'embedding' && runtime.config?.mode !== 'enhanced' && !stage.total) continue;
            const item = document.createElement('div'); item.className = 'lm-card';
            const label = document.createElement('label'), progress = document.createElement('progress');
            label.textContent = `${{ summary: '逐轮总结', embedding: '向量索引', group: '旧轮合并' }[stage.kind]} ${stage.done} / ${stage.total}${stage.failed ? ` · 失败 ${stage.failed}` : ''}`;
            progress.max = Math.max(1, stage.total); progress.value = stage.done;
            label.append(progress); item.append(label);
            if (stage.eta !== null && stage.eta !== undefined) { const estimate = document.createElement('small'); estimate.textContent = `预计剩余约 ${stage.eta < 60 ? `${Math.max(1, stage.eta)} 秒` : `${Math.ceil(stage.eta / 60)} 分钟`}`; item.append(estimate); }
            stages.append(item);
        }
        const compression = select('[data-compression]'), estimate = data.compression;
        compression.hidden = !estimate?.rawChars;
        compression.textContent = estimate?.rawChars ? `历史文字估算：${estimate.rawChars.toLocaleString()} → ${estimate.compressedChars.toLocaleString()} 字，减少约 ${estimate.savedPct}%；实际发送量见本轮上下文。` : '';
        select('[data-errors]').textContent = (data.errors || []).map(e => e.error).join('\n');
        select('[data-legacy]').hidden = !data.legacy;
        select('[data-legacy]').textContent = `${data.legacy || 0} 条记忆来自旧版提示词。需要按当前提示词重做时，使用“备份与维护 → 重新整理全部”；会重新调用模型。`;
    }
    function fill(config) {
        for (const input of select('[data-settings]').elements) {
            if (!input.name) continue;
            const [group, key] = input.name.split('.');
            const value = (key ? config[group]?.[key] : config[group]) ?? (key ? DEFAULTS[group]?.[key] : DEFAULTS[group]);
            if (key === 'key') { input.value = ''; input.placeholder = config[group]?.hasKey ? '已保存；留空保留' : '未保存'; }
            else if (key === 'clearKey') input.checked = false;
            else if (input.type === 'radio') input.checked = input.value === value;
            else if (input.type === 'checkbox') input.checked = !!value;
            else input.value = value ?? '';
        }
        select('[data-raw-search]').checked = !!settings().rawSearch;
        for (const output of panel.querySelectorAll('[data-value]')) output.textContent = config[output.dataset.value] ?? DEFAULTS[output.dataset.value];
        dirty = false;
    }
    function readConfig() {
        const value = {};
        for (const input of select('[data-settings]').elements) {
            if (!input.name || input.name.endsWith('clearKey') || (input.type === 'radio' && !input.checked)) continue;
            const [group, key] = input.name.split('.');
            const clear = key === 'key' && select(`[name="${group}.clearKey"]`).checked;
            if (key === 'key' && !input.value && !clear) continue;
            const val = clear ? '' : input.type === 'checkbox' ? input.checked : ['range', 'number'].includes(input.type) ? Number(input.value) : input.value;
            if (key) { value[group] ??= {}; value[group][key] = val; } else value[group] = val;
        }
        return value;
    }
    function action(fn) {
        const target = runtime.target;
        busy++; panel.setAttribute('aria-busy', 'true');
        actions = actions.then(async () => { if (runtime.isCurrent(target)) await fn(); }).catch(error => { if (runtime.isCurrent(target)) status(error.message); })
            .finally(() => { if (!--busy) panel.removeAttribute('aria-busy'); });
        return actions;
    }
    async function refreshMemories({ poll = false } = {}) {
        const sequence = ++refreshSequence;
        const data = await runtime.request('list', { offset, ...filter });
        if (sequence !== refreshSequence) return;
        renderState(data); total = data.filteredTotal ?? data.total;
        offset = data.offset ?? Math.min(offset, Math.max(0, Math.ceil(total / 10) - 1) * 10);
        select('[data-chat]').textContent = getContext().chatId || '请打开一段聊天';
        select('[data-page]').textContent = `${Math.floor(offset / 10) + 1} / ${Math.max(1, Math.ceil(total / 10))}`;
        select('[data-action="previous"]').disabled = offset === 0;
        select('[data-action="next"]').disabled = offset + 10 >= total;
        const container = select('[data-memories]'), signature = JSON.stringify([offset, data.items]);
        if (signature === listSignature || (poll && container.contains(document.activeElement))) return;
        const expanded = new Set([...container.querySelectorAll('article')].filter(row => row.querySelector('details').open).map(row => row.dataset.memoryId));
        listSignature = signature; container.replaceChildren();
        if (!data.items.length) container.textContent = '暂无匹配的记忆。最新两轮要等后面聊完才整理；也可点击“补录 / 重试”。';
        for (const memory of data.items) {
            const row = document.createElement('article'); row.className = 'lm-card'; row.dataset.memoryId = memory.id;
            row.innerHTML = '<div class="lm-row"><strong class="lm-grow"></strong><label class="lm-inline"><input type="checkbox">使用</label></div><p class="lm-text"></p><details><summary>编辑与来源</summary><textarea rows="5" aria-label="编辑记忆正文"></textarea><div class="lm-row"><button type="button" data-save>保存修改</button><button type="button" data-retry>重新生成</button></div><div class="lm-log"></div></details>';
            row.querySelector('strong').textContent = `${memory.no ? `M${memory.no} · ` : ''}第 ${memory.turn}${memory.end ? `–${memory.end}` : ''} 轮 · ${memory.kind === 'group' ? '合并' : '逐轮'}${memory.indexed ? ' · 已索引' : ''}`;
            row.querySelector('.lm-text').textContent = memory.summary;
            if (Number.isFinite(memory.originalChars)) {
                const size = document.createElement('small');
                size.textContent = `来源 ${memory.originalChars} 字 · 总结 ${memory.summaryChars} 字`;
                row.querySelector('.lm-text').after(size);
            }
            const input = row.querySelector('input'); input.checked = memory.enabled;
            input.onchange = () => {
                const enabled = input.checked;
                input.checked = memory.enabled;
                action(async () => { await runtime.request('edit', { id: memory.id, enabled }); await refreshMemories(); });
            };
            const text = row.querySelector('textarea'); text.value = drafts.get(memory.id) ?? memory.summary;
            if (drafts.has(memory.id) || expanded.has(memory.id)) row.querySelector('details').open = true;
            text.oninput = () => drafts.set(memory.id, text.value);
            row.querySelector('[data-save]').onclick = () => action(async () => { await runtime.request('edit', { id: memory.id, summary: text.value }); drafts.delete(memory.id); await refreshMemories(); status('记忆已保存，相关索引将重新建立'); });
            row.querySelector('[data-retry]').onclick = () => action(async () => { if (host.confirm('重新生成这条记忆？当前编辑内容将被模型结果替换。')) { await runtime.request('retry', { id: memory.id }); drafts.delete(memory.id); await refreshMemories(); } });
            row.querySelector('.lm-log').textContent = memory.sources.map(m => `${m.name}：${m.text}`).join('\n\n'); container.append(row);
        }
    }
    async function open() {
        panel.showModal();
        select('[data-enabled]').checked = !!runtime.enabled;
        if (!dirty) await action(async () => {
            fill((await runtime.connect()).config);
            status(notice || '服务器已连接');
            if (!select('[data-view="memories"]').hidden && getContext().chatId) await refreshMemories();
        });
    }
    function close() { if ((dirty || drafts.size) && !host.confirm('还有未保存的修改，确定关闭面板？')) return; panel.close(); }
    launcher.onclick = open;
    panel.addEventListener('cancel', event => { event.preventDefault(); close(); });
    select('[data-enabled]').checked = !!runtime.enabled;
    select('[data-enabled]').onchange = () => {
        const input = select('[data-enabled]'), enabled = input.checked;
        input.checked = !!runtime.enabled; input.disabled = true;
        return action(async () => {
            await runtime.setEnabled(enabled); status(enabled ? '本聊天记忆已开启' : '本聊天记忆已关闭');
            if (panel.open && !select('[data-view="memories"]').hidden && getContext().chatId) await refreshMemories().catch(() => {});
        }).finally(() => { input.disabled = false; input.checked = !!runtime.enabled; });
    };
    select('[data-settings]').addEventListener('input', event => { dirty = true; const output = select(`[data-value="${event.target.name}"]`); if (output) output.textContent = event.target.value; status('设置已修改，记得保存'); });
    select('[data-settings]').onsubmit = event => { event.preventDefault(); action(async () => { const rawSearch = select('[data-raw-search]').checked; fill((await runtime.saveConfig(readConfig())).config); settings().rawSearch = rawSearch; select('[data-raw-search]').checked = rawSearch; getContext().saveSettingsDebounced(); status('设置已保存'); }); };
    for (const button of panel.querySelectorAll('[data-models], [data-check]')) button.onclick = async () => {
        const provider = button.dataset.models || button.dataset.check, node = select(`[data-provider-status="${provider}"]`);
        const buttons = [...panel.querySelectorAll(`[data-models="${provider}"], [data-check="${provider}"]`)];
        if (buttons.some(item => item.disabled)) return;
        buttons.forEach(item => { item.disabled = true; });
        node.textContent = '正在请求…';
        try {
            const result = await runtime.api(button.dataset.models ? 'models' : 'check', { provider, setting: readConfig()[provider] });
            if (result.models) { const list = select(`#lm-${provider}-models`); list.replaceChildren(); for (const model of result.models) { const option = document.createElement('option'); option.value = model; list.append(option); } node.textContent = `已获取 ${result.models.length} 个模型，点击模型名称选择。`; }
            else node.textContent = result.message;
        } catch (error) { node.textContent = error.message; }
        finally { buttons.forEach(item => { item.disabled = false; }); }
    };
    for (const tab of panel.querySelectorAll('[data-tab]')) tab.onclick = () => {
        for (const item of panel.querySelectorAll('[data-tab]')) item.setAttribute('aria-pressed', String(item === tab));
        for (const viewNode of panel.querySelectorAll('[data-view]')) viewNode.hidden = viewNode.dataset.view !== tab.dataset.tab;
        if (tab.dataset.tab === 'memories') return refreshMemories().catch(error => status(error.message));
    };
    const commands = {
        close, connect: async () => { const data = await runtime.connect(); if (!dirty) fill(data.config); status('服务器已连接'); },
        defaults: () => {
            for (const key of ['keep', 'concurrency', 'rawLimit', 'recallThreshold', 'recallLimit', 'rerankThreshold']) { select(`[name="${key}"]`).value = DEFAULTS[key]; const output = select(`[data-value="${key}"]`); if (output) output.textContent = DEFAULTS[key]; }
            for (const input of panel.querySelectorAll('[name="mode"]')) input.checked = input.value === DEFAULTS.mode;
            for (const key of ['autoHide', 'citations', 'recallExcludeRaw', 'recallShortContext']) select(`[name="${key}"]`).checked = DEFAULTS[key];
            select('[data-raw-search]').checked = false;
            dirty = true; status('已恢复默认规则，点击保存生效');
        },
        sync: async () => { await runtime.sync(); await refreshMemories(); }, pause: async () => renderState(await runtime.request('pause', { paused: !paused })),
        retry: async () => { const target = runtime.target; await runtime.sync({ target }); renderState(await runtime.request('retry', {}, target)); },
        reindex: async () => { if (host.confirm('重建当前聊天的全部向量？会重新调用向量模型，原总结保留。')) renderState(await runtime.request('reindex')); },
        rebuild: async () => { if (host.confirm('删除当前聊天已有记忆并按当前提示词重新整理？手动修改也会被替换，并重新调用模型。建议先导出备份。')) { await runtime.request('rebuild'); drafts.clear(); await refreshMemories(); } },
        clear: async () => { if (host.confirm('清空当前聊天的记忆并停止后台任务？聊天原文保留。')) { await runtime.request('clear'); drafts.clear(); await refreshMemories(); } },
        previous: async () => { offset = Math.max(0, offset - 10); await refreshMemories(); }, next: async () => { if (offset + 10 < total) offset += 10; await refreshMemories(); },
        export: async () => { const data = await runtime.request('export'); const url = host.URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = `layered-memory-${String(getContext().chatId).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80)}-${new Date().toLocaleDateString('sv-SE').replaceAll('-', '')}.json`; link.click(); host.setTimeout(() => host.URL.revokeObjectURL(url), 1000); },
        import: () => select('[data-import]').click(),
    };
    for (const button of panel.querySelectorAll('[data-action]')) button.onclick = () => ['close', 'defaults', 'import'].includes(button.dataset.action)
        ? commands[button.dataset.action]() : action(commands[button.dataset.action]);
    select('[data-import]').onchange = event => action(async () => {
        try {
            const file = event.target.files[0]; if (!file) return;
            if (file.size > 20 * 1024 * 1024) throw new Error('备份文件超过 20 MiB');
            let backup;
            try { backup = JSON.parse(await file.text()); } catch { throw new Error('备份不是有效的 JSON 文件'); }
            if (host.confirm('恢复备份中与当前聊天来源匹配的记忆？')) { const result = await runtime.request('import', { backup }); await refreshMemories(); status(`已恢复 ${result.restored} 条记忆`); }
        } finally { event.target.value = ''; }
    });
    select('[data-filter]').onsubmit = event => { event.preventDefault(); filter = { query: event.target.elements.query.value, kind: event.target.elements.kind.value, order: event.target.elements.order.value }; offset = 0; action(refreshMemories); };
    select('[data-search]').onsubmit = event => { event.preventDefault(); action(async () => { const target = runtime.target; await runtime.sync({ target }); const data = await runtime.request('search', { query: event.target.elements.query.value }, target); select('[data-results]').textContent = data.matches.map(m => `第 ${m.floor} 楼 · ${m.name}\n${m.text}`).join('\n\n') || '没有命中'; }); };
    getContext().eventSource.on(getContext().eventTypes.CHAT_CHANGED, () => { offset = 0; notice = ''; listSignature = ''; refreshSequence++; drafts.clear(); select('[data-enabled]').checked = !!runtime.enabled; renderState({}); select('[data-chat]').textContent = getContext().chatId || '请打开一段聊天'; select('[data-memories]').replaceChildren(); select('[data-preview]').replaceChildren(); select('[data-used]').textContent = '尚未生成'; select('[data-results]').textContent = ''; if (panel.open && getContext().chatId) refreshMemories().catch(error => status(error.message)); });
    const poll = host.setInterval(async () => {
        const counts = runtime.session?.data?.counts;
        if (polling || busy || !runtime.session || (!panel.open && !(runtime.enabled && (counts?.queued || counts?.running)))) return;
        polling = true;
        try {
            if (panel.open && !select('[data-view="memories"]').hidden) await refreshMemories({ poll: true });
            else renderState(await runtime.request('state'));
        } catch (error) { status(error.message); }
        finally { polling = false; }
    }, 4000);
    const dispose = () => { host.clearInterval(poll); disposeCitations(); panel.remove(); launcher.remove(); };
    host.addEventListener('beforeunload', () => host.clearInterval(poll));
    fill(DEFAULTS);
    action(async () => { const data = await runtime.connect(); if (!dirty) fill(data.config); status('服务器已连接'); if (getContext().chatId && runtime.enabled) await runtime.request('state'); });
    return { panel, runtime, open, dispose };
}

if (typeof SillyTavern !== 'undefined') {
    // Summaries are written from what the main model is shown: the message with the prompt-only regexes of SillyTavern applied.
    let regex;
    const view = message => regex ? regex.getRegexedString(message.mes || '',
        message.is_user ? regex.regex_placement.USER_INPUT : regex.regex_placement.AI_OUTPUT, { isPrompt: true, depth: 0 }) : message.mes || '';
    view.ready = import('../../../regex/engine.js').then(module => { regex = module; }).catch(() => {});
    mountMemoryPanel(() => SillyTavern.getContext(), window, view);
}
