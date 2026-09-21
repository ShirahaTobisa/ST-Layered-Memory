// Run against the unmodified RP-Hub cd7fb2b checkout. No model or network calls.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = process.argv[2];
if (!root) throw new Error('Pass the RP-Hub 1.9.5 checkout directory');
const expected = { 'app.js': 'a125b6f8f1a0526d674406380899f3898977f5ebbd78518e2c49b0803eacf61a', 'data-services.js': '6d4e514f067938246ccd1c9bfdf25bd8b866367b2a4fa66475dccd585f556559', 'built-in-content.js': '45bd8e61ace7019c69ab6100dca7450fd29654ffa5ad886252c99230cd7981cf' };
const sources = Object.fromEntries(Object.entries(expected).map(([file, hash]) => {
    const data = fs.readFileSync(path.join(root, 'assets/js', file));
    assert.equal(crypto.createHash('sha256').update(data).digest('hex'), hash, file);
    return [file, data.toString('utf8')];
}));
const lines = (file, from, to) => sources[file].split(/\r?\n/).slice(from - 1, to).join('\n');
const box = vm.createContext({ window: {}, Vue: { markRaw: value => value }, btoa, atob, structuredClone, console: { warn() {}, error() {} } });
const run = code => vm.runInContext(code, box);
run(sources['built-in-content.js']);
run(lines('data-services.js', 218, 371));
run([
    'const { getSummarySources, getSummaryEmbedding, cosineSimilarity, prepareClassicMemoriesForRuntime, quantizeEmbeddingForStorage, markRuntimeRaw, getClassicMemoryKey } = window.RPHubMemoryUtils;',
    'const chatHistory = {value:[]}, classicMemories = {value:[]};',
    'const memorySettings = {enabled:true,mode:"enhanced",summaryKeepFloors:20};',
    'const CLASSIC_SECONDARY_KEEP_TURNS=25, CLASSIC_SECONDARY_GROUP_SIZE=5;',
    'const getMemoryMessageText = message => String(message?.content || "");',
    lines('data-services.js', 416, 544), lines('app.js', 2955, 3005), lines('app.js', 5123, 5144),
    'const outgoing = () => { const postprocessedChatHistory = getPostprocessedChatMessages(chatHistory.value);', lines('app.js', 4527, 4603), 'return chatHistoryForContext; };',
].join('\n'));
const json = code => JSON.parse(JSON.stringify(run(code)));
const fixture = { baseline: 'RP-Hub 1.9.5 / cd7fb2b946f5985991b60597960852671013f36f', sha256: expected, cases: [] };
const scenarios = [
    { name: 'forty turns', count: 40, keep: 20 }, { name: 'all recent', count: 4, keep: 20 },
    { name: 'minimum retention with pending input', count: 36, keep: 10, pending: true },
    { name: 'maximum retention', count: 40, keep: 40 },
    { name: 'adjacent speakers and greeting', count: 38, keep: 20, adjacent: true, greeting: true },
    { name: 'empty turn inside an old group', count: 40, keep: 20, empty: [3] },
    { name: 'empty turn at a group edge', count: 40, keep: 20, empty: [1, 5] },
    { name: 'missing summary keeps original', count: 40, keep: 20, missing: [2, 21] },
    { name: 'disabled summary', count: 20, keep: 10, disabled: [2] },
    { name: 'disabled merged group', count: 40, keep: 20, disabledGroup: true },
];
for (const scenario of scenarios) {
    const chat = Array.from({ length: scenario.count }, (_, i) => [{ role: 'user', id: `u${i + 1}`, name: '用户', content: `user ${i + 1}` }, { role: 'assistant', id: `a${i + 1}`, name: '角色', content: scenario.empty?.includes(i + 1) ? '' : `assistant ${i + 1}` }]).flat();
    if (scenario.adjacent) { chat.splice(1, 0, { role: 'user', id: 'extra-u', name: '用户', content: 'extra user' }); chat.splice(3, 0, { role: 'assistant', id: 'extra-a', name: '角色', content: 'extra assistant' }); }
    if (scenario.greeting) chat.unshift({ role: 'assistant', id: 'greeting', name: '角色', content: 'greeting' });
    if (scenario.pending) chat.push({ role: 'user', id: 'pending', name: '用户', content: 'next question' });
    run('chatHistory.value=' + JSON.stringify(chat) + '; memorySettings.summaryKeepFloors=' + scenario.keep + ';');
    const turns = json('buildConversationTurnSnapshot(chatHistory.value).turns');
    const memories = turns.filter(t => t.assistant.content && !scenario.missing?.includes(t.turn)).map(t => ({ id: `m${t.turn}`, turn: t.turn, summary: `summary ${t.turn}`, classicMemory: true, enabled: !scenario.disabled?.includes(t.turn), sourceUserIds: t.user._sourceIndexes.map(i => chat[i].id), sourceAssistantIds: t.assistant._sourceIndexes.map(i => chat[i].id), sourceUserText: t.user.content }));
    run('classicMemories.value=' + JSON.stringify(memories) + ';');
    const groups = json('getEligibleClassicSecondaryGroups(' + scenario.count + ')').map(g => ({ id: `g${g[0].turn}`, turn: g.at(-1).turn, turnStart: g[0].turn, turnEnd: g.at(-1).turn, summary: `merged ${g[0].turn}-${g.at(-1).turn}`, classicMemory: true, secondaryCompressed: true, enabled: !scenario.disabledGroup, sourceUserIds: g.flatMap(m => m.sourceUserIds), sourceAssistantIds: g.flatMap(m => m.sourceAssistantIds), sourceMemories: g }));
    const covered = new Set(groups.flatMap(g => g.sourceMemories.map(m => m.id)));
    run('classicMemories.value=' + JSON.stringify([...groups, ...memories.filter(m => !covered.has(m.id))]) + ';');
    const expectedMessages = json('outgoing().map(m => ({role:m.role,content:m.content}))');
    fixture.cases.push({ name: scenario.name, keep: scenario.keep, chat, memories, groups, expected: expectedMessages });
}
fixture.prompts = json('({single:window.RPHubBuiltinContent.prompts.buildClassicSummarySystemPrompt({userName:"用户",characterName:"角色"}),final:window.RPHubBuiltinContent.prompts.buildClassicSummaryFinalInstruction(4),group:window.RPHubBuiltinContent.prompts.buildClassicSecondarySummaryPrompt({userName:"用户",characterName:"角色",startTurn:1,endTurn:5}),recall:window.RPHubBuiltinContent.prompts.enhancedMemoryRecallDescription})');
fixture.quantization = [[], [1, 0], [0.1, -0.3, 0.8], [0, 0]].map(vector => ({ vector, expected: json('quantizeEmbeddingForStorage(' + JSON.stringify(vector) + ')') }));
const output = path.join(__dirname, '../test/fixtures/rph-1.9.5.json');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(fixture) + '\n');
console.log('Captured ' + fixture.cases.length + ' original-source context cases, original prompts, and vector fixtures.');
