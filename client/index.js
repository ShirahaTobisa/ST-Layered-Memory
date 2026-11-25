import { KEY, DEFAULTS, EFFORTS, VERSION } from '../shared/model.js';
import { createRuntime } from './runtime.js';
import { mountCitations } from './citations.js';

const command = (name, label, style = '') => `<button type="button" data-action="${name}" class="${style}">${label}</button>`;
const sw = attrs => `<span class="lm-switch"><input ${attrs} type="checkbox"><span class="lm-switch-knob"></span></span>`;
const providers = [
    ['summary', '总结模型', '必选', 'var(--lm-c1)', '将每轮对话整理为长期记忆；基础与增强模式都需要。'],
    ['embedding', '向量模型', '增强', 'var(--lm-c2)', '用于语义混合召回；未建索引或断线时自动降级关键词检索。'],
    ['rerank', '重排模型', '可选', 'var(--lm-c3)', '候选多于上限或设了最低分时调用 /rerank 精选，留空不用。'],
];
const LAYERS_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 12 12 17 22 12"/><polyline points="2 17 12 22 22 17"/></svg>';
const EYE_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
const CLOSE_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

export function mountMemoryPanel(getContext, host = window, view) {
    const document = host.document;
    const launcher = document.createElement('button'); launcher.type = 'button'; launcher.className = 'menu_button lm-launcher';
    launcher.innerHTML = '<b>分层记忆设置</b><small>未连接服务器</small>';
    document.querySelector('#extensions_settings')?.append(launcher);
    const panel = document.createElement('dialog'); panel.id = 'layered-memory';
    panel.setAttribute('aria-labelledby', 'lm-title');
    panel.innerHTML = `<header class="lm-header">
<div class="lm-brand"><span class="lm-brand-icon">${LAYERS_SVG}</span><h2 id="lm-title" class="lm-title">分层记忆</h2><span class="lm-ver-badge"><span class="lm-dot" data-conn-dot></span>${VERSION}</span></div>
<div class="lm-header-right"><label class="lm-inline"><span class="lm-enabled-full">启用记忆</span><span class="lm-enabled-short">启用</span>${sw('data-enabled')}</label><button type="button" data-action="close" class="lm-icon-btn" aria-label="关闭面板" title="关闭">${CLOSE_SVG}</button></div>
</header>
<div class="lm-nav-wrap"><nav class="lm-nav" aria-label="记忆设置分区"><div class="lm-tab-pill" data-tab-pill></div>
<button type="button" data-tab="connection" aria-pressed="true">连接与模型</button><button type="button" data-tab="rules" aria-pressed="false">记忆规则</button><button type="button" data-tab="memories" aria-pressed="false">记忆管理<span class="lm-nav-count" data-nav-count></span></button><button type="button" data-tab="context" aria-pressed="false">本轮上下文</button></nav></div>
<main class="lm-content"><form id="lm-settings" data-settings>
<section data-view="connection"><div><h3>连接与模型</h3><p class="lm-muted">配置与密钥仅保存在服务器数据库中。先配置总结模型，再开启记忆；支持 OpenAI 兼容与 Gemini <code>/v1beta/openai</code> 根地址。</p></div>
<div class="lm-grid-3">${providers.map(([key, title, badge, dot, hint]) => `<fieldset class="lm-card lm-provider-card"><div class="lm-provider-head"><span class="lm-provider-title"><span class="lm-dot" style="background:${dot}"></span>${title}</span><span class="lm-chip${key === 'summary' ? ' lm-chip-accent' : ''}">${badge}</span></div><p class="lm-muted">${hint}</p>
<label><span class="lm-field-label">API 根地址</span><input name="${key}.url" type="url" placeholder="https://example.com/v1" autocomplete="off"></label>
<div class="lm-between"><span class="lm-field-label">API Key</span><label class="lm-inline lm-muted"><input name="${key}.clearKey" type="checkbox">清除已保存</label></div>
<div class="lm-pw-wrap"><input name="${key}.key" type="password" autocomplete="new-password" placeholder="填写密钥" aria-label="${title} API Key"><button type="button" class="lm-pw-eye" data-toggle-pw="${key}" title="显示或隐藏密钥" aria-label="显示或隐藏密钥">${EYE_SVG}</button></div>
<label><span class="lm-field-label">模型名称</span><input name="${key}.model" list="lm-${key}-models" placeholder="选择或手动填写模型名" autocomplete="off"></label><datalist id="lm-${key}-models"></datalist>${key === 'summary' ? `
<div class="lm-between"><span class="lm-field-label">思考强度</span><small data-effort-note>带思考模型一般选“低”即可</small></div>
<select name="summary.effort" class="lm-sr-select" aria-label="思考强度">${Object.entries(EFFORTS).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select>
<div class="lm-effort-pills" data-effort-pills>${Object.entries(EFFORTS).map(([value, label]) => `<button type="button" data-effort-pick="${value}" aria-pressed="${value === '' ? 'true' : 'false'}">${label}</button>`).join('')}</div>` : ''}
<div class="lm-provider-foot"><div class="lm-provider-btns"><button type="button" data-models="${key}">获取模型</button><button type="button" data-check="${key}">测试模型</button></div><small data-provider-status="${key}">测试会向所填接口发送一条小请求。</small></div></fieldset>`).join('')}
</div><p class="lm-muted">密钥留空会保留已保存的值；模型测试不会阻塞切换标签或关闭面板。</p></section>
<section data-view="rules" hidden>
<div class="lm-grid-2"><label class="lm-card lm-mode-card"><input name="mode" type="radio" value="classic"><span><strong>基础模式</strong><br><small>两级时间线压缩：逐轮总结与每 5 轮合并，保留最近原文。</small></span></label><label class="lm-card lm-mode-card"><input name="mode" type="radio" value="enhanced"><span><strong>增强模式</strong><br><small>在脉络总结上叠加向量 + 防噪声关键词混合召回与可选重排。</small></span></label></div>
<div class="lm-card"><div class="lm-between"><strong>三层窗口预览</strong><small data-layer-summary>合并 15 轮 · 逐轮 15 轮 · 原文 10 轮（以 40 轮为例）</small></div>
<div class="lm-layer-bar" aria-hidden="true"><div class="lm-layer-seg" data-layer-seg="merged" style="width:37.5%"></div><div class="lm-layer-seg" data-layer-seg="summary" style="width:37.5%"></div><div class="lm-layer-seg" data-layer-seg="raw" style="width:25%"></div></div>
<div class="lm-grid-3"><span class="lm-inline"><span class="lm-legend-dot" style="background:var(--lm-c3)"></span><small>更早：25 轮外每 5 轮合并</small></span><span class="lm-inline"><span class="lm-legend-dot" style="background:var(--lm-c2)"></span><small>较早：原输入＋逐轮总结</small></span><span class="lm-inline"><span class="lm-legend-dot" style="background:var(--lm-c1)"></span><small>近期：保留最近原文</small></span></div></div>
<div class="lm-card"><div class="lm-grid-2">
<label><span class="lm-between"><span class="lm-field-label">保留最近原文楼数</span><span class="lm-val-pill"><output data-value="keep">20</output> 楼</span></span><input name="keep" type="range" min="10" max="40" step="2" value="20"><small>连续同角色合并算一楼，普通一问一答为两楼。</small></label>
<label><span class="lm-between"><span class="lm-field-label">总结并发</span><span class="lm-val-pill"><output data-value="concurrency">5</output> 路</span></span><input name="concurrency" type="range" min="1" max="10" step="1" value="5"><small>429 或网络波动自动退避重试最多 3 次。</small></label>
</div><div class="lm-divider lm-card" style="padding:11px 0 0;border:0;background:transparent">
<label class="lm-toggle-row"><span class="lm-toggle-copy"><span>已总结的旧楼自动隐藏</span><small>保留窗口外、已有生效记忆的楼层自动隐藏（可明显减轻云酒馆渲染压力）；未合并轮次发送时原位补回用户输入，不触碰手动隐藏。</small></span>${sw('name="autoHide"')}</label>
<label class="lm-toggle-row"><span class="lm-toggle-copy"><span>回复中标注记忆来源 <code>[M编号]</code></span><small>点击角色回复里的编号弹出对应总结与原文；代码块和用户输入自动跳过。</small></span>${sw('name="citations"')}</label>
</div></div>
<div class="lm-card" data-recall-card><div class="lm-between"><strong>增强召回与原文工具</strong><small data-recall-hint>增强模式生效</small></div>
<label><span class="lm-between"><span class="lm-field-label">向量相似度门槛</span><span class="lm-val-pill"><output data-value="recallThreshold">0.48</output></span></span><input name="recallThreshold" type="range" min="0.1" max="0.9" step="0.02" value="0.48"></label>
<div class="lm-grid-3"><label><span class="lm-field-label">最多召回条数 (3–20)</span><input name="recallLimit" type="number" min="3" max="20" step="1" value="10"></label><label><span class="lm-field-label">重排最低分 (0 不截断)</span><input name="rerankThreshold" type="number" min="0" max="1" step="0.05" value="0"></label><label><span class="lm-field-label">原文工具结果数 (5–10)</span><input name="rawLimit" type="number" min="5" max="10" step="1" value="5"></label></div>
<div class="lm-divider lm-card" style="padding:11px 0 0;border:0;background:transparent">
<label class="lm-toggle-row"><span class="lm-toggle-copy"><span>召回时跳过近期已完整发送原文的轮次</span></span>${sw('name="recallExcludeRaw"')}</label>
<label class="lm-toggle-row"><span class="lm-toggle-copy"><span>短输入时补充上一轮检索语境</span></span>${sw('name="recallShortContext"')}</label>
<label class="lm-toggle-row"><span class="lm-toggle-copy"><span>允许模型检索聊天原文</span><small>注册 <code>layered_memory_search</code>，用于找回总结省略的原话（需主模型支持工具调用）。</small></span>${sw('data-raw-search')}</label>
</div></div>
<div class="lm-row" style="justify-content:flex-end">${command('defaults', '恢复默认规则')}</div></section></form>
<section data-view="memories" hidden>
<div class="lm-card"><div class="lm-between"><div class="lm-grow"><h3>记忆管理</h3><p data-chat class="lm-muted">请打开一段聊天</p></div><div class="lm-row">${command('retry', '补录 / 重试', 'lm-primary')}${command('pause', '停止后台任务')}${command('sync', '刷新')}</div></div>
<div class="lm-between"><span>逐轮 <b data-count="summaries">0</b> · 合并 <b data-count="groups">0</b> · 已索引 <b data-count="indexed">0</b></span><small data-progress role="status">尚未交付聊天</small></div>
<div data-stages class="lm-grid-3"></div><p data-compression class="lm-muted" hidden></p><div data-errors class="lm-log lm-danger"></div><p data-legacy class="lm-muted" hidden></p></div>
<form data-filter class="lm-row"><input name="query" class="lm-grow" placeholder="搜索记忆正文" aria-label="搜索记忆正文"><select name="kind" aria-label="记忆类型"><option value="all">全部记忆</option><option value="summary">逐轮总结</option><option value="group">合并总结</option></select><select name="order" aria-label="记忆顺序"><option value="desc">最新在前</option><option value="asc">最早在前</option></select><button type="submit">筛选</button></form>
<div data-memories></div>
<div class="lm-row">${command('previous', '上一页')}<span data-page class="lm-grow">1 / 1</span>${command('next', '下一页')}</div>
<details class="lm-card"><summary>备份与维护</summary><p class="lm-muted">导出当前聊天的记忆与固定编号，不包含 API Key。数据库完整备份需停止酒馆后复制用户目录中的 layered-memory 文件夹。</p><div class="lm-row">${command('export', '导出记忆')}${command('import', '恢复备份')}${command('reindex', '重建向量')}${command('rebuild', '重新整理全部')}${command('clear', '清空当前记忆', 'lm-danger')}</div></details><input data-import type="file" accept="application/json,.json" hidden></section>
<section data-view="context" hidden>
<div class="lm-card"><h3>本轮上下文</h3><p class="lm-muted">查看上次发送时使用的记忆和实际请求内容。切换聊天后会清空记录。</p><div data-used class="lm-log">尚未生成</div><details><summary>查看实际发送的上下文</summary><div data-preview class="lm-log"></div></details></div>
<div class="lm-card"><h3>查找聊天原话</h3><form data-search class="lm-row"><input name="query" class="lm-grow" maxlength="300" required placeholder="输入人名、物品或约定的关键词" aria-label="原文关键词"><button type="submit" class="lm-primary">搜索原文</button></form><div data-results class="lm-text"></div></div></section>
</main><footer class="lm-footer"><div class="lm-status-wrap"><span class="lm-dirty-dot" data-dirty-dot hidden></span><p data-status role="status" aria-live="polite" class="lm-grow lm-muted">正在连接服务器…</p></div><div class="lm-footer-actions">${command('connect', '重新连接')}<button type="submit" form="lm-settings" class="lm-primary">保存设置</button></div></footer>`;
    document.body.append(panel);
    const select = query => panel.querySelector(query), settings = () => getContext().extensionSettings[KEY];
    const drafts = new Map();
    let offset = 0, total = 0, busy = 0, polling = false, dirty = false, paused = false, notice = '', filter = { query: '', kind: 'all', order: 'desc' };
    let actions = Promise.resolve(), listSignature = '', refreshSequence = 0, activeTab = 'connection';
    const status = text => { select('[data-status]').textContent = text; launcher.querySelector('small').textContent = text; };
    const setDirty = flag => { dirty = flag; select('[data-dirty-dot]').hidden = !flag; };

    // Sliding tab pill (pure transform, ResizeObserver-synced for 60fps smooth transitions).
    const navEl = select('.lm-nav'), pillEl = select('[data-tab-pill]');
    function syncTabPill(instant = false) {
        const tab = select(`[data-tab="${activeTab}"]`);
        if (!tab || !navEl || !pillEl || !tab.getBoundingClientRect) return;
        const navRect = navEl.getBoundingClientRect(), rect = tab.getBoundingClientRect();
        if (!rect.width) return;
        if (instant) pillEl.style.transition = 'none';
        pillEl.style.opacity = '1';
        pillEl.style.width = `${rect.width}px`;
        pillEl.style.transform = `translateX(${rect.left - navRect.left}px)`;
        if (instant) { void pillEl.offsetWidth; pillEl.style.transition = ''; }
    }
    let navObserver = null;
    if (typeof host.ResizeObserver === 'function') {
        navObserver = new host.ResizeObserver(() => syncTabPill(true));
        navObserver.observe(navEl);
    }

    function syncRuleVisuals() {
        const keep = Number(select('[name="keep"]')?.value) || DEFAULTS.keep;
        const rawTurns = Math.min(40, Math.round(keep / 2));
        const mergedTurns = 15;
        const summaryTurns = Math.max(0, 40 - mergedTurns - rawTurns);
        const segMerged = select('[data-layer-seg="merged"]'), segSummary = select('[data-layer-seg="summary"]'), segRaw = select('[data-layer-seg="raw"]');
        if (segMerged) segMerged.style.width = `${mergedTurns / 40 * 100}%`;
        if (segSummary) segSummary.style.width = `${summaryTurns / 40 * 100}%`;
        if (segRaw) segRaw.style.width = `${rawTurns / 40 * 100}%`;
        const summaryLabel = select('[data-layer-summary]');
        if (summaryLabel) summaryLabel.textContent = `合并 ${mergedTurns} 轮 · 逐轮 ${summaryTurns} 轮 · 原文 ${rawTurns} 轮（以 40 轮为例）`;
        const enhanced = select('[name="mode"][value="enhanced"]')?.checked;
        const recallCard = select('[data-recall-card]'), recallHint = select('[data-recall-hint]');
        if (recallCard) recallCard.style.opacity = enhanced ? '1' : '.72';
        if (recallHint) recallHint.textContent = enhanced ? '增强模式已启用' : '基础模式下召回不调用';
    }

    function syncEffortPills(value) {
        for (const btn of panel.querySelectorAll('[data-effort-pick]')) btn.setAttribute('aria-pressed', String(btn.dataset.effortPick === String(value ?? '')));
    }

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
        const navCount = select('[data-nav-count]');
        if (navCount) navCount.textContent = data.total ? String(data.total) : '';
        const c = data.counts || {};
        paused = !!data.paused;
        select('[data-action="pause"]').textContent = paused ? '继续后台任务' : '停止后台任务';
        select('[data-progress]').textContent = data.revision ? `${data.paused ? '已停止' : '后台就绪'} · 等待 ${c.queued || 0} · 运行 ${c.running || 0} · 失败 ${c.error || 0}` : '尚未交付聊天';
        const stages = select('[data-stages]'); stages.replaceChildren();
        for (const stage of data.progress || []) {
            if (stage.kind === 'embedding' && runtime.config?.mode !== 'enhanced' && !stage.total) continue;
            const item = document.createElement('div'); item.className = 'lm-stage-card';
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
        syncEffortPills(select('[name="summary.effort"]')?.value ?? '');
        syncRuleVisuals();
        setDirty(false);
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
        const fragment = document.createDocumentFragment();
        for (const memory of data.items) {
            const row = document.createElement('article'); row.className = 'lm-card'; row.dataset.memoryId = memory.id;
            if (!memory.enabled) row.dataset.disabled = 'true';
            row.innerHTML = `<div class="lm-between"><div class="lm-row lm-grow"><span class="lm-mem-no" hidden></span><strong></strong></div><label class="lm-inline"><small>使用</small>${sw('')}</label></div><p class="lm-text"></p><details><summary>编辑与来源</summary><textarea rows="5" aria-label="编辑记忆正文"></textarea><div class="lm-row"><button type="button" data-save class="lm-primary">保存修改</button><button type="button" data-retry>重新生成</button></div><div class="lm-log"></div></details>`;
            const noBadge = row.querySelector('.lm-mem-no');
            if (memory.no) { noBadge.hidden = false; noBadge.textContent = `M${memory.no}`; }
            row.querySelector('strong').textContent = `第 ${memory.turn}${memory.end ? `–${memory.end}` : ''} 轮 · ${memory.kind === 'group' ? '合并' : '逐轮'}${memory.indexed ? ' · 已索引' : ''}`;
            row.querySelector('.lm-text').textContent = memory.summary;
            if (Number.isFinite(memory.originalChars)) {
                const size = document.createElement('small');
                const pct = memory.originalChars > 0 ? Math.max(0, Math.round((1 - (memory.summaryChars ?? memory.summary.length) / memory.originalChars) * 100)) : 0;
                size.textContent = `来源 ${memory.originalChars} 字 → 总结 ${memory.summaryChars} 字${pct ? `（-${pct}%）` : ''}`;
                row.querySelector('.lm-text').after(size);
            }
            const input = row.querySelector('input'); input.checked = memory.enabled;
            input.onchange = () => {
                // Optimistic toggle for responsive Cloud ST feel; reverts automatically if the server rejects it.
                const enabled = input.checked, previous = memory.enabled;
                row.dataset.disabled = enabled ? 'false' : 'true';
                action(async () => {
                    try {
                        await runtime.request('edit', { id: memory.id, enabled });
                        await refreshMemories();
                    } catch (error) {
                        input.checked = previous;
                        row.dataset.disabled = previous ? 'false' : 'true';
                        throw error;
                    }
                });
            };
            const text = row.querySelector('textarea'); text.value = drafts.get(memory.id) ?? memory.summary;
            if (drafts.has(memory.id) || expanded.has(memory.id)) row.querySelector('details').open = true;
            text.oninput = () => drafts.set(memory.id, text.value);
            row.querySelector('[data-save]').onclick = () => action(async () => { await runtime.request('edit', { id: memory.id, summary: text.value }); drafts.delete(memory.id); await refreshMemories(); status('记忆已保存，相关索引将重新建立'); });
            row.querySelector('[data-retry]').onclick = () => action(async () => { if (host.confirm('重新生成这条记忆？当前编辑内容将被模型结果替换。')) { await runtime.request('retry', { id: memory.id }); drafts.delete(memory.id); await refreshMemories(); } });
            row.querySelector('.lm-log').textContent = memory.sources.map(m => `${m.name}：${m.text}`).join('\n\n');
            fragment.append(row);
        }
        container.append(fragment);
    }

    async function open() {
        panel.showModal();
        select('[data-enabled]').checked = !!runtime.enabled;
        if (typeof host.requestAnimationFrame === 'function') host.requestAnimationFrame(() => syncTabPill(true));
        if (!dirty) await action(async () => {
            fill((await runtime.connect()).config);
            status(notice || '服务器已连接');
            if (!select('[data-view="memories"]').hidden && getContext().chatId) await refreshMemories();
        });
    }
    function close() { if ((dirty || drafts.size) && !host.confirm('还有未保存的修改，确定关闭面板？')) return; panel.close(); }
    launcher.onclick = open;
    panel.addEventListener('cancel', event => { event.preventDefault(); close(); });
    panel.addEventListener('click', event => { if (event.target === panel) close(); });

    select('[data-enabled]').checked = !!runtime.enabled;
    select('[data-enabled]').onchange = () => {
        const input = select('[data-enabled]'), enabled = input.checked;
        input.checked = !!runtime.enabled; input.disabled = true;
        return action(async () => {
            await runtime.setEnabled(enabled); status(enabled ? '本聊天记忆已开启' : '本聊天记忆已关闭');
            if (panel.open && !select('[data-view="memories"]').hidden && getContext().chatId) await refreshMemories().catch(() => {});
        }).finally(() => { input.disabled = false; input.checked = !!runtime.enabled; });
    };

    for (const btn of panel.querySelectorAll('[data-toggle-pw]')) btn.onclick = () => {
        const input = select(`[name="${btn.dataset.togglePw}.key"]`);
        if (input) input.type = input.type === 'password' ? 'text' : 'password';
    };
    for (const btn of panel.querySelectorAll('[data-effort-pick]')) btn.onclick = () => {
        const effortSelect = select('[name="summary.effort"]');
        if (!effortSelect) return;
        effortSelect.value = btn.dataset.effortPick;
        syncEffortPills(effortSelect.value);
        setDirty(true); status('设置已修改，记得保存');
    };
    select('[name="summary.effort"]')?.addEventListener('change', event => syncEffortPills(event.target.value));

    select('[data-settings]').addEventListener('input', event => {
        setDirty(true);
        const output = select(`[data-value="${event.target.name}"]`);
        if (output) output.textContent = event.target.value;
        if (['keep', 'mode'].includes(event.target.name)) syncRuleVisuals();
        status('设置已修改，记得保存');
    });
    select('[data-settings]').addEventListener('change', event => {
        if (event.target.name === 'mode') syncRuleVisuals();
    });
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
        activeTab = tab.dataset.tab;
        for (const item of panel.querySelectorAll('[data-tab]')) item.setAttribute('aria-pressed', String(item === tab));
        for (const viewNode of panel.querySelectorAll('[data-view]')) viewNode.hidden = viewNode.dataset.view !== tab.dataset.tab;
        syncTabPill(false);
        if (tab.dataset.tab === 'memories') return refreshMemories().catch(error => status(error.message));
    };

    const commands = {
        close, connect: async () => { const data = await runtime.connect(); if (!dirty) fill(data.config); status('服务器已连接'); },
        defaults: () => {
            for (const key of ['keep', 'concurrency', 'rawLimit', 'recallThreshold', 'recallLimit', 'rerankThreshold']) { select(`[name="${key}"]`).value = DEFAULTS[key]; const output = select(`[data-value="${key}"]`); if (output) output.textContent = DEFAULTS[key]; }
            for (const input of panel.querySelectorAll('[name="mode"]')) input.checked = input.value === DEFAULTS.mode;
            for (const key of ['autoHide', 'citations', 'recallExcludeRaw', 'recallShortContext']) select(`[name="${key}"]`).checked = DEFAULTS[key];
            select('[data-raw-search]').checked = false;
            syncRuleVisuals();
            setDirty(true); status('已恢复默认规则，点击保存生效');
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
    const dispose = () => { host.clearInterval(poll); navObserver?.disconnect(); disposeCitations(); panel.remove(); launcher.remove(); };
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
