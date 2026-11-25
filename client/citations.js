export function mountCitations(getContext, runtime, host = window) {
    const document = host.document, dialog = document.createElement('dialog');
    dialog.className = 'lm-citation-dialog';
    dialog.innerHTML = '<header><strong></strong><button type="button" aria-label="关闭记忆">关闭</button></header><p></p><details><summary>聊天来源</summary><div></div></details>';
    document.body.append(dialog);
    let sequence = 0;
    const close = () => { sequence++; if (dialog.open) dialog.close(); };
    dialog.querySelector('button').onclick = close;
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    const render = id => {
        const roots = Number.isInteger(Number(id)) && id !== undefined
            ? document.querySelectorAll(`#chat .mes[is_user="false"][mesid="${Number(id)}"] .mes_text`)
            : document.querySelectorAll('#chat .mes[is_user="false"] .mes_text');
        for (const root of roots) {
            const walker = document.createTreeWalker(root, 4), nodes = [];
            while (walker.nextNode()) if (!walker.currentNode.parentElement.closest('a, button, code, pre, script, style')) nodes.push(walker.currentNode);
            for (const node of nodes) {
                const matches = [...node.textContent.matchAll(/\[M([1-9]\d*)\]/g)];
                if (!matches.length) continue;
                const fragment = document.createDocumentFragment();
                let offset = 0;
                for (const match of matches) {
                    fragment.append(node.textContent.slice(offset, match.index));
                    const button = document.createElement('button');
                    button.type = 'button'; button.className = 'lm-citation'; button.dataset.memoryNo = match[1];
                    button.textContent = match[0]; button.title = `查看记忆 M${match[1]}`;
                    fragment.append(button); offset = match.index + match[0].length;
                }
                fragment.append(node.textContent.slice(offset)); node.replaceWith(fragment);
            }
        }
    };
    const click = async event => {
        const button = event.target.closest?.('.lm-citation');
        if (!button) return;
        const current = ++sequence, no = Number(button.dataset.memoryNo), target = runtime.target;
        dialog.querySelector('strong').textContent = `记忆 M${no}`;
        dialog.querySelector('p').textContent = '正在读取…';
        dialog.querySelector('details').hidden = true;
        if (!dialog.open) dialog.showModal();
        try {
            const data = await runtime.request('citation', { no }, target);
            if (current !== sequence) return;
            dialog.querySelector('p').textContent = data.memory?.summary || '这条记忆已被清空或删除。';
            if (data.memory) dialog.querySelector('strong').textContent += ` · 第 ${data.memory.turn}${data.memory.end ? `–${data.memory.end}` : ''} 轮${data.memory.enabled === false ? ' · 已停用' : ''}`;
            dialog.querySelector('details').hidden = !data.sources?.length;
            dialog.querySelector('details div').textContent = (data.sources || []).map(m => `${m.name || m.role}：${m.text}`).join('\n\n');
        } catch (error) { if (current === sequence) dialog.querySelector('p').textContent = error.message; }
    };
    document.addEventListener('click', click);
    const { eventSource, eventTypes } = getContext();
    const handlers = ['CHARACTER_MESSAGE_RENDERED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MORE_MESSAGES_LOADED'].filter(name => eventTypes[name]).map(name => [eventTypes[name], render]);
    handlers.push([eventTypes.CHAT_CHANGED, () => { close(); render(); }]);
    for (const [event, handler] of handlers) eventSource.on(event, handler);
    render();
    return () => {
        sequence++; document.removeEventListener('click', click); dialog.remove();
        for (const [event, handler] of handlers) eventSource.removeListener?.(event, handler);
    };
}
