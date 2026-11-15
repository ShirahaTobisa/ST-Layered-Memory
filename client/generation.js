import { KEY, MAIN_TYPES, memoryRole } from '../shared/model.js';

export function trackGeneration(getContext, { capture, same, enabled, persist }) {
    let generation = null, group = null;
    const { eventSource, eventTypes } = getContext();
    const on = (name, listener) => { if (eventTypes[name]) eventSource.on(eventTypes[name], listener); };
    const metadata = message => {
        message.extra ??= {};
        return message.extra[KEY] ??= { ...message.extra.rph_memory };
    };
    const start = type => getContext().chat.length - (['swipe', 'continue', 'regenerate'].includes(type) ? 1 : 0);
    const assistant = message => message && memoryRole(message) === 'assistant';

    function update() {
        const processor = getContext().streamingProcessor;
        const index = generation.index ?? processor?.messageId, message = getContext().chat[index];
        const failed = generation.cancelled || generation.signal?.aborted || processor?.abortController?.signal.aborted || processor?.isStopped;
        // Streaming and nonstreaming replies emit these two events in opposite orders.
        generation.finished ||= !!failed || !!(generation.received && generation.ended);
        generation.failed ||= !!failed || !!processor?.toolCalls?.length;
        if (same(group)) group.failed ||= generation.failed;
        if (index >= generation.start && assistant(message)) {
            const state = metadata(message);
            state.pending = !generation.finished || generation.failed;
            if (generation.failed) state.blocked = message.mes;
            else if (generation.finished) {
                delete state.blocked;
                // Other candidates created in this request share the completed state.
                for (const swipe of message.swipe_info?.slice(generation.swipeCount) || []) if (swipe.extra?.[KEY]) {
                    swipe.extra[KEY].pending = false;
                    delete swipe.extra[KEY].blocked;
                }
            }
        }
        persist();
    }
    on('GENERATION_STARTED', (type, options, dryRun) => {
        if (!enabled() || dryRun || !MAIN_TYPES.has(type)) return;
        generation = { ...capture(), start: start(type), signal: options?.signal,
            swipeCount: ['swipe', 'continue'].includes(type) ? getContext().chat.at(-1)?.swipes?.length || 0 : 0 };
    });
    on('STREAM_TOKEN_RECEIVED', () => {
        if (!same(generation) || generation.finished) return;
        generation.index = getContext().streamingProcessor?.messageId;
        const message = getContext().chat[generation.index];
        if (assistant(message) && !metadata(message).pending) { metadata(message).pending = true; persist(); }
    });
    on('MESSAGE_RECEIVED', (index, type) => {
        if (!same(generation) || !MAIN_TYPES.has(type === 'appendFinal' ? 'continue' : type) || index < generation.start || !assistant(getContext().chat[index])) return;
        generation.received = true; generation.index = index; update();
    });
    on('GENERATION_STOPPED', () => {
        if (same(group)) group.failed = true;
        if (!same(generation)) return;
        generation.cancelled = true;
        generation.index ??= getContext().chat.length - 1;
        update();
    });
    on('GENERATION_ENDED', () => {
        if (!same(generation)) return;
        const processor = getContext().streamingProcessor;
        if (processor && !processor.isFinished && !processor.isStopped) return;
        if (!generation.received && !processor && !generation.cancelled && !generation.signal?.aborted) return;
        generation.ended = true; update();
    });
    on('GROUP_WRAPPER_STARTED', ({ type }) => {
        if (enabled() && MAIN_TYPES.has(type || 'normal')) group = { ...capture(), start: start(type) };
    });
    on('GROUP_WRAPPER_FINISHED', () => {
        if (!same(group)) return;
        const failed = group.failed || (same(generation) && (!generation.received || !generation.finished || generation.failed));
        for (const message of getContext().chat.slice(group.start)) if (assistant(message)) {
            const state = metadata(message);
            delete state.groupPending;
            for (const swipe of message.swipe_info || []) if (swipe.extra?.[KEY]) delete swipe.extra[KEY].groupPending;
            if (failed) { state.pending = true; state.blocked = message.mes; }
        }
        if (same(generation)) generation.finished = true;
        group = null; persist();
    });
    return {
        pending: index => ({ pending: !!(same(generation) && !generation.finished && index >= generation.start), groupPending: !!(same(group) && index >= group.start) }),
        active: () => (same(generation) && !generation.finished) || same(group),
        reset: () => { generation = null; group = null; },
    };
}
