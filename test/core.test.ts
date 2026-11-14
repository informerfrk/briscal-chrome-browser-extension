/** Unit tests for the parts without chrome.* APIs: agent loop, keys, addresses, stream parsing, prompt. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent, AgentUI, LIMITS, MAX_IDENTICAL_STEPS, NOTE_PREFIX, OLD_SNAPSHOT, Screenshot, ToolHost, ToolResult } from '../src/core/agent';
import { AgentApi, ApiError, ChatRequest, ChatResult, parseStream, ToolCall } from '../src/core/api';
import { keyEvents, modifierBits, parseCombo } from '../src/core/keys';
import { systemPrompt } from '../src/core/prompt';
import { toolDefinitions } from '../src/core/tools';
import { blockedBy, normalizeTarget, uncontrollableReason } from '../src/core/urls';
import { normalizeServer, normalizeSites, normalizeStepLimit, storable } from '../src/panel/store';

// ------------------------------------------------------------------ fakes
const call = (name: string, args: unknown, id = `c${Math.random().toString(36).slice(2, 8)}`): ToolCall =>
    ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

class FakeApi implements AgentApi {
    requests: ChatRequest[] = [];
    constructor(private readonly script: (n: number, req: ChatRequest) => Partial<ChatResult>) {}
    async chat(req: ChatRequest): Promise<ChatResult> {
        this.requests.push(JSON.parse(JSON.stringify(req)));
        const r = this.script(this.requests.length - 1, req);
        return { content: '', reasoning: '', toolCalls: [], finishReason: 'stop', ...r };
    }
    async summarize() { return { summary: 'summary' }; }
}

class FakeHost implements ToolHost {
    calls: string[] = [];
    shots = 0;
    notes: string[] = [];
    sameShot = false;
    definitions() { return toolDefinitions({ webSearch: true }); }
    async execute(c: ToolCall): Promise<ToolResult> {
        this.calls.push(c.function.name);
        if (c.function.name === 'read_page') return { output: 'x'.repeat(LIMITS.snapshotMinChars + 10) };
        const a = JSON.parse(c.function.arguments || '{}');
        return { output: `ok ${c.function.name}`, observe: c.function.name === 'computer' && a.action === 'left_click' };
    }
    async screenshot(): Promise<Screenshot> {
        this.shots++;
        return { dataUrl: `data:image/jpeg;base64,${this.sameShot ? 'AAAA' : btoa(String(this.shots))}`, width: 1280, height: 720, caption: 'Shop (https://shop.test)' };
    }
    takeNotes() { return this.notes.splice(0); }
}

const ui = (): AgentUI & { notices: string[] } => {
    const notices: string[] = [];
    return { notices, turnStart() {}, reasoning() {}, content() {}, turnEnd() {}, toolStart() {}, toolEnd() {}, plan() {}, notice: (t) => notices.push(t) };
};
const run = (agent: Agent, task: string, maxSteps = 0) => agent.run(task, ui(), { maxSteps }, new AbortController().signal);

// ------------------------------------------------------------------ agent loop
test('runs tools, then one screenshot per step that changed the page, metered as browser', async () => {
    const api = new FakeApi((n) => (n === 0 ? { toolCalls: [call('read_page', {}), call('computer', { action: 'left_click', ref: 3 }), call('computer', { action: 'left_click', ref: 4 })] } : { content: 'Done.' }));
    const host = new FakeHost();
    const agent = new Agent(api, host, () => 'system');
    await run(agent, 'Add it to the cart');
    assert.deepEqual(host.calls, ['read_page', 'computer', 'computer']);
    assert.equal(host.shots, 1, 'one screenshot after the whole step');
    assert.equal(api.requests[0].purpose, 'browser');
    const last = api.requests[1].messages.at(-1)!;
    assert.equal(last.role, 'user');
    assert.ok(Array.isArray(last.content) && last.content[0].type === 'image_url');
    assert.match(JSON.stringify(last.content), /Screenshot of the tab now: Shop \(https:\/\/shop\.test\)/);
    assert.equal(agent.lastText(), 'Done.');
});

test('no step limit by default; a stuck loop (same actions, same page) stops by itself', async () => {
    let n = 0;
    const api = new FakeApi(() => ({ toolCalls: [call('computer', { action: 'left_click', ref: 1 }, `id${n++}`)] }));
    const host = new FakeHost();
    host.sameShot = true;
    const u = ui();
    const r = await new Agent(api, host, () => 's').run('x', u, { maxSteps: 0 }, new AbortController().signal);
    assert.equal(r.steps, MAX_IDENTICAL_STEPS);
    assert.ok(r.hitLimit);
    assert.match(u.notices.join(), /repeated the same actions/);

    // Progress (the page changes) keeps it going well past any old step limit.
    let k = 0;
    const api2 = new FakeApi((i) => (i < 60 ? { toolCalls: [call('computer', { action: 'left_click', ref: 1 }, `k${k++}`)] } : { content: 'done' }));
    const r2 = await run(new Agent(api2, new FakeHost(), () => 's'), 'long task');
    assert.equal(r2.steps, 60);
    assert.equal(r2.hitLimit, false);
});

test('an explicit step limit still stops and says how to continue', async () => {
    const api = new FakeApi(() => ({ toolCalls: [call('find', { query: 'a' })] }));
    const u = ui();
    const r = await new Agent(api, new FakeHost(), () => 's').run('x', u, { maxSteps: 3 }, new AbortController().signal);
    assert.equal(r.steps, 3);
    assert.match(u.notices.join(), /step limit/);
});

test('messages typed during a task reach the model at its next step', async () => {
    const host = new FakeHost();
    const api = new FakeApi((n) => {
        if (n === 0) { host.notes.push('Pick the blue one'); return { toolCalls: [call('computer', { action: 'left_click', ref: 2 })] }; }
        return { content: 'ok' };
    });
    await run(new Agent(api, host, () => 's'), 'Buy a shirt');
    const last = api.requests[1].messages.at(-1)!;
    assert.equal(last.role, 'user');
    assert.match(JSON.stringify(last.content), new RegExp(`${NOTE_PREFIX.replace(/[[\]]/g, '\\$&')} Pick the blue one`));
    assert.ok(Array.isArray(last.content) && last.content.some((p) => p.type === 'image_url'), 'merged into the screenshot message');
});

test('old page snapshots and screenshots are dropped in batches', async () => {
    let n = 0;
    const api = new FakeApi((i) => (i < 8 ? { toolCalls: [call('read_page', {}, `r${n++}`), call('computer', { action: 'left_click', ref: 1 }, `c${n++}`)] } : { content: 'done' }));
    const agent = new Agent(api, new FakeHost(), () => 's');
    await run(agent, 'x');
    const snaps = agent.messages.filter((m) => m.role === 'tool' && m.name === 'read_page');
    const live = snaps.filter((m) => m.content !== OLD_SNAPSHOT).length;
    assert.ok(live <= LIMITS.maxSnapshots, `at most ${LIMITS.maxSnapshots} full snapshots kept (got ${live})`);
    // A lone snapshot also expires after a few turns.
    const agent2 = new Agent(api, new FakeHost(), () => 's');
    agent2.messages = [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: '', tool_calls: [call('read_page', {}, 'r')] },
        { role: 'tool', tool_call_id: 'r', name: 'read_page', content: 'y'.repeat(LIMITS.snapshotMinChars) },
        ...Array.from({ length: LIMITS.snapshotTurns }, (_, i) => [
            { role: 'assistant' as const, content: '', tool_calls: [call('computer', { action: 'key', keys: 'Tab' }, `k${i}`)] },
            { role: 'tool' as const, tool_call_id: `k${i}`, name: 'computer', content: 'ok' },
        ]).flat(),
    ];
    agent2.pruneSnapshots();
    assert.equal((agent2.messages[2] as any).content, OLD_SNAPSHOT);
    assert.ok(snaps.some((m) => m.content === OLD_SNAPSHOT));
    const images = agent.messages.reduce((k, m) => k + (m.role === 'user' && Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url').length : 0), 0);
    assert.ok(images <= LIMITS.maxImages + 1);
});

test('only the latest screenshot stays, and everything before it is unchanged from call to call (cached)', async () => {
    let n = 0;
    const api = new FakeApi((i) => (i < 10 ? { toolCalls: [call('computer', { action: 'left_click', ref: 1 }, `p${n++}`)] } : { content: 'done' }));
    await run(new Agent(api, new FakeHost(), () => 's'), 'x');
    const images = (r: ChatRequest) => r.messages.filter((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')).length;
    for (let k = 1; k < api.requests.length; k++) {
        const prev = api.requests[k - 1].messages, cur = api.requests[k].messages;
        assert.ok(images(api.requests[k]) <= 1, `call ${k} carries ${images(api.requests[k])} screenshots`);
        const lastImage = prev.map((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')).lastIndexOf(true);
        const stable = lastImage >= 0 ? lastImage : prev.length;
        assert.equal(JSON.stringify(cur.slice(0, stable)), JSON.stringify(prev.slice(0, stable)), `call ${k}: the prompt before the previous screenshot changed`);
    }
});

test('a tool call cut off by the output limit is not run', async () => {
    const api = new FakeApi((n) => (n === 0 ? { toolCalls: [{ id: 'x', type: 'function', function: { name: 'computer', arguments: '{"action":"type","text":"hel' } }], finishReason: 'length' } : { content: 'ok' }));
    const host = new FakeHost();
    await run(new Agent(api, host, () => 's'), 'x');
    assert.deepEqual(host.calls, []);
    assert.match(JSON.stringify(api.requests[1].messages), /cut off/);
});

test('context too large: compacts and retries', async () => {
    let calls = 0;
    const api: AgentApi = {
        async chat() {
            calls++;
            if (calls === 1) throw new ApiError('too big', 413, 'context_too_large');
            return { content: 'ok', reasoning: '', toolCalls: [], finishReason: 'stop' };
        },
        async summarize() { return { summary: '' }; },
    };
    const agent = new Agent(api, new FakeHost(), () => 's');
    agent.messages.push({ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'sure' });
    await run(agent, 'now');
    assert.equal(calls, 2);
});

// ------------------------------------------------------------------ keys
test('key combos become debugger key events', () => {
    const enter = keyEvents('Enter');
    assert.equal(enter.length, 2);
    assert.equal(enter[0].type, 'keyDown');
    assert.equal(enter[0].text, '\r');
    assert.equal(enter[0].windowsVirtualKeyCode, 13);

    const selectAll = keyEvents('ctrl+a');
    assert.deepEqual(selectAll.map((e) => [e.type, e.key, e.modifiers]), [['rawKeyDown', 'Control', 2], ['rawKeyDown', 'a', 2], ['keyUp', 'a', 2], ['keyUp', 'Control', 0]]);
    assert.equal(selectAll[1].text, undefined, 'no text while ctrl is held');

    const mac = keyEvents('ctrl+a', 'mac');
    assert.equal(mac[0].key, 'Meta', 'ctrl means Cmd on a Mac');
    assert.deepEqual(mac[1].commands, ['selectAll']);
    assert.deepEqual(keyEvents('cmd+shift+z', 'mac')[2].commands, ['redo']);

    const back = keyEvents('shift+Tab');
    assert.equal(back[1].modifiers, 8);
    assert.equal(keyEvents('A')[1].text, 'A');
    assert.equal(keyEvents('space')[0].text, ' ');
    assert.equal(parseCombo('Return').key.key, 'Enter');
    assert.equal(parseCombo('esc').key.key, 'Escape');
    assert.equal(parseCombo('PageDown').key.keyCode, 34);
    assert.throws(() => parseCombo('ctrl+a+b'), /more than one key/);
    assert.throws(() => parseCombo('hyper'), /Unknown key/);
    assert.equal(modifierBits('ctrl+shift'), 10);
    assert.equal(modifierBits('ctrl', 'mac'), 4);
});

// ------------------------------------------------------------------ addresses
test('addresses: web pages only, host names get https, words become a search', () => {
    assert.deepEqual(normalizeTarget('example.com/shop'), { kind: 'url', url: 'https://example.com/shop' });
    assert.deepEqual(normalizeTarget('localhost:8000/x'), { kind: 'url', url: 'http://localhost:8000/x' });
    assert.deepEqual(normalizeTarget('back'), { kind: 'history', action: 'back' });
    assert.deepEqual(normalizeTarget('Refresh'), { kind: 'history', action: 'reload' });
    assert.equal((normalizeTarget('best hiking boots') as any).url, 'https://www.google.com/search?q=best%20hiking%20boots');
    assert.equal(normalizeTarget('javascript:alert(1)').kind, 'error');
    assert.equal(normalizeTarget('file:///etc/passwd').kind, 'error');
    assert.equal(normalizeTarget('chrome://settings').kind, 'error');

    assert.equal(blockedBy('https://www.mybank.com/login', ['mybank.com']), 'mybank.com');
    assert.equal(blockedBy('https://online.mybank.com/', ['mybank.com']), 'mybank.com');
    assert.equal(blockedBy('https://notmybank.com/', ['mybank.com']), null);

    assert.equal(uncontrollableReason('https://example.com'), null);
    assert.match(uncontrollableReason('chrome://newtab/')!, /browser page/);
    assert.match(uncontrollableReason('https://chromewebstore.google.com/detail/x')!, /Web Store/);
    assert.deepEqual(normalizeSites('https://www.Example.com/x, shop.test\n\n'), ['example.com', 'shop.test']);
    assert.equal(normalizeStepLimit(''), 0);
    assert.equal(normalizeStepLimit(2), 5);
    assert.equal(normalizeServer('brisqal.example/'), 'https://brisqal.example');
});

test('saved tasks contain no screenshots and shortened tool output', () => {
    const saved = storable([
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }, { type: 'text', text: 'hi' }] },
        { role: 'tool', tool_call_id: 'a', name: 'get_text', content: 'y'.repeat(10000) },
    ]);
    assert.doesNotMatch(JSON.stringify(saved), /base64/);
    assert.ok((saved[1].content as string).length < 4100);
});

// ------------------------------------------------------------------ stream and prompt
test('the SSE stream is parsed; comment lines are ignored; errors throw', async () => {
    const body = (s: string) => new Response(s).body!;
    const deltas: string[] = [];
    const r = await parseStream(body(': connected\n\nevent: content\ndata: {"d":"Hel"}\n\n: keep-alive\n\nevent: content\ndata: {"d":"lo"}\n\nevent: done\ndata: {"finish_reason":"tool_calls","tool_calls":[{"id":"1","type":"function","function":{"name":"click","arguments":"{}"}}]}\n\n'), { content: (d) => deltas.push(d) });
    assert.equal(r.content, 'Hello');
    assert.deepEqual(deltas, ['Hel', 'lo']);
    assert.equal(r.toolCalls[0].function.name, 'click');
    await assert.rejects(parseStream(body('event: error\ndata: {"message":"The AI service had a problem."}\n\n'), {}), /problem/);
    await assert.rejects(parseStream(body('event: content\ndata: {"d":"x"}\n\n'), {}), /interrupted/);
});

test('prompt and tools never name an AI provider, and tool schemas are well-formed', () => {
    const text = systemPrompt({ os: 'mac', browser: 'Google Chrome 155', date: 'Fri Nov 14 2026', language: 'en-US', mode: 'balanced' })
        + JSON.stringify(toolDefinitions({ webSearch: true }));
    // Assembled from pieces so the source never spells the names (Tailwind scans the whole project).
    const banned = new RegExp([['ki', 'mi'], ['moon', 'shot'], ['deep', 'seek'], ['cla', 'ude'], ['anthro', 'pic'], ['\\bop', 'us\\b'], ['bra', 've'], ['open', 'ai'], ['g', 'pt']].map((n) => n.join('')).join('|'), 'i');
    assert.doesNotMatch(text, banned);
    assert.match(text, /sent as Cmd on this Mac/);
    for (const t of toolDefinitions({ webSearch: true })) {
        const props = (t.function.parameters as any).properties as Record<string, any>;
        for (const [k, v] of Object.entries(props)) assert.ok(typeof v.type === 'string', `${t.function.name}.${k} has a type`);
        for (const r of (t.function.parameters as any).required) assert.ok(r in props, `${t.function.name} requires a known field ${r}`);
    }
    assert.ok(!toolDefinitions({ webSearch: false }).some((t) => t.function.name === 'web_search'));
});
