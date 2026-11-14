/**
 * End-to-end tests in real Chrome (run under Xvfb: npm run test:e2e). Loads the test build
 * (out/ext), opens local test pages, and drives the extension's browser tools through the side
 * panel's test hook: page outline and refs, trusted clicks and typing, the password guard, forms,
 * keys, scrolling, navigation, tabs, shadow DOM, iframes, approvals, a full scripted agent run, and
 * the cleanup when the panel is closed mid-task.
 *
 * Optional live run against a Brisqal server (a real model does a task):
 *   BRISQAL_SERVER=http://127.0.0.1:8000 BRISQAL_TOKEN=… npm run test:e2e
 */
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const EXT = path.join(ROOT, 'out/ext');
const FIX = path.join(ROOT, 'test/fixtures');
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';

let passed = 0;
const failures = [];
async function check(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        failures.push(name);
        console.log(`  ✗ ${name}\n      ${String(e?.stack || e).split('\n').slice(0, 4).join('\n      ')}`);
    }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ test server
const server = http.createServer((req, res) => {
    const file = path.join(FIX, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(FIX) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ------------------------------------------------------------------ browser
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'brisqal-e2e-'));
const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    pipe: true,
    enableExtensions: true,
    userDataDir: profile,
    defaultViewport: null,
    args: ['--no-first-run', '--no-default-browser-check', '--window-size=1400,900', '--password-store=basic',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});
const extId = await browser.installExtension(EXT);
console.log(`Chrome ${await browser.version()} · extension ${extId} · pages on ${BASE}`);

const page = (await browser.pages())[0];
await page.goto(`${BASE}/form.html`);

/** Open the side panel's page in its own window (stays in the foreground, so its timers aren't throttled). */
async function openPanel() {
    const url = `chrome-extension://${extId}/sidepanel.html`;
    const cdp = await browser.target().createCDPSession();
    await cdp.send('Target.createTarget', { url, newWindow: true });
    const target = await browser.waitForTarget((t) => t.url() === url && !panels.has(t));
    panels.add(target);
    const p = await target.asPage();
    await p.waitForFunction(() => !!globalThis.__brisqalTest, { timeout: 15000 });
    const ids = await p.evaluate(async (base) => {
        const t = (await chrome.tabs.query({})).find((x) => x.url?.startsWith(`${base}/form.html`));
        return { tab: t.id, win: t.windowId };
    }, BASE);
    await p.evaluate((i) => { __brisqalTest.useWindow(i.win); __brisqalTest.useTab(i.tab); }, ids);
    return { panel: p, ...ids };
}
const panels = new Set();
let { panel, tab: formTab } = await openPanel();

// Older short names in these tests map onto the computer tool's actions.
const ACTIONS = { click: 'left_click', type: 'type', key: 'key', scroll: 'scroll', hover: 'hover', drag: 'drag', wait: 'wait', screenshot: 'screenshot' };
const tool = (name, args = {}) => {
    if (ACTIONS[name]) { args = { ...args, action: name === 'click' && args.clicks === 2 ? 'double_click' : ACTIONS[name] }; name = 'computer'; }
    if (name === 'get_text') name = 'get_page_text';
    return rawTool(name, args);
};
const rawTool = (name, args = {}) => panel.evaluate(async (n, a) => {
    const r = await __brisqalTest.host.execute({ id: `e${Math.random()}`, type: 'function', function: { name: n, arguments: JSON.stringify(a) } }, new AbortController().signal);
    return { output: r.output, isError: !!r.isError, observe: !!r.observe, image: r.image ? { w: r.image.width, h: r.image.height, len: r.image.dataUrl.length } : null };
}, name, args);
const refFor = (outline, re) => {
    const m = outline.match(new RegExp(`\\[(\\d+)\\] ${re}`));
    if (!m) throw new Error(`no ref for /${re}/ in:\n${outline.slice(0, 2500)}`);
    return Number(m[1]);
};
const resetForm = () => page.goto(`${BASE}/form.html`);
const val = (sel) => page.$eval(sel, (el) => (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' ? el.value : el.textContent));
/** Whether this extension (not the test driver, which is always attached) controls the tab via the debugger. */
const extAttached = (p, tabId) => p.evaluate(async (t) => {
    try { await chrome.debugger.sendCommand({ tabId: t }, 'Runtime.evaluate', { expression: '1' }); return true; } catch { return false; }
}, tabId);

console.log('\nPage reading');
let outline = '';
await check('read_page lists controls with refs, labels, values and states', async () => {
    const r = await tool('read_page');
    outline = r.output;
    if (process.env.SHOW_OUTLINE) console.log(outline);
    assert(!r.isError, r.output);
    for (const s of ['Page: Newsletter – Test Shop', 'heading "Join our newsletter" (h1)', 'textbox "Email" type=email placeholder="you@example.com"',
        'textbox "Password" type=password private', 'combobox "Plan" value="Free" options: Free | Pro | Team', 'checkbox "I agree to the terms" unchecked',
        'button "Subscribe"', 'link "Read the article"', 'searchbox "Search the shop"', 'form']) {
        assert(outline.includes(s), `missing «${s}»:\n${outline}`);
    }
    assert(!outline.includes('Hidden button'), 'display:none content is left out');
    assert(!/Bottom button/.test(outline) && /more elements? further down\. Scroll, or use find/.test(outline), 'elements far down the page are counted, not listed');
});
await check('styled checkbox (hidden input) is described through its label', async () => {
    assert(/\[\d+\] checkbox "Weekly digest" unchecked/.test(outline), outline);
});
await check('shadow DOM and same-origin iframe contents are included', async () => {
    assert(/button "Shadow button"/.test(outline), 'shadow');
    assert(/iframe "Embedded widget"/.test(outline) && /button "Frame button"/.test(outline), 'iframe');
});
await check('refs stay the same between reads', async () => {
    const again = (await tool('read_page')).output;
    assert(refFor(again, 'button "Subscribe"') === refFor(outline, 'button "Subscribe"'), 'stable refs');
});
await check('find returns matching refs', async () => {
    const r = await tool('find', { query: 'subscribe button' });
    assert(r.output.includes(`[${refFor(outline, 'button "Subscribe"')}] button "Subscribe"`), r.output);
    const none = await tool('find', { query: 'zebra unicorn' });
    assert(/Nothing on this page matches/.test(none.output), none.output);
});
await check('get_text reads long pages in parts', async () => {
    await tool('navigate', { url: `${BASE}/article.html` });
    const p1 = await tool('get_text');
    assert(/How to test a browser agent/.test(p1.output) && /call get_text with offset (\d+)/.test(p1.output), p1.output.slice(0, 300));
    let part = p1, parts = 1;
    while (/offset (\d+)/.test(part.output) && parts < 10) { part = await tool('get_text', { offset: Number(part.output.match(/offset (\d+)\./)[1]) }); parts++; }
    assert(parts > 1 && /The end of the article/.test(part.output) && !/How to test a browser agent/.test(part.output.split('\n\n').slice(1).join('')), `${parts} parts; ${part.output.slice(-300)}`);
    await tool('navigate', { url: 'back' });
    assert(page.url().endsWith('/form.html'), page.url());
});

console.log('\nActing on the page');
await resetForm();
outline = (await tool('read_page')).output;
await check('type into a field by ref: trusted events, value reported back', async () => {
    const r = await tool('type', { ref: refFor(outline, 'textbox "Email"'), text: 'ada@example.com' });
    assert(!r.isError && !r.observe, `${r.output} (typing needs no screenshot)`);
    assert(/now contains “ada@example.com”/.test(r.output), r.output);
    assert(await val('#email') === 'ada@example.com', 'value set');
    const ev = await page.evaluate(() => __events);
    assert(ev.includes('click:true') && ev.includes('input:true') && !ev.some((e) => e.endsWith(':false')), `events ${ev.join()}`);
});
await check('clear: true replaces what is in the field', async () => {
    const r = await tool('type', { ref: refFor(outline, 'textbox "Email"'), text: 'grace@example.com', clear: true });
    assert(await val('#email') === 'grace@example.com', r.output);
});
await check('password fields are refused (by ref and when focused)', async () => {
    const r = await tool('type', { ref: refFor(outline, 'textbox "Password"'), text: 'hunter2' });
    assert(r.isError && /Not typed: this is a password field/.test(r.output), r.output);
    await page.focus('#pw');
    const r2 = await tool('type', { text: 'hunter2' });
    assert(r2.isError && /password/.test(r2.output), r2.output);
    const r3 = await tool('form_input', { ref: refFor(outline, 'textbox "Password"'), value: 'hunter2' });
    assert(r3.isError, r3.output);
    assert(await val('#pw') === '', 'nothing typed');
});
await check('form_input: dropdown by option text, checkbox, styled checkbox', async () => {
    const a = await tool('form_input', { ref: refFor(outline, 'combobox "Plan"'), value: 'Team' });
    assert(/Selected "Team"/.test(a.output) && await val('#plan') === 'team', a.output);
    const b = await tool('form_input', { ref: refFor(outline, 'checkbox "I agree to the terms"'), value: 'true' });
    assert(/now checked/.test(b.output) && await page.$eval('#agree', (e) => e.checked), b.output);
    const c = await tool('click', { ref: refFor(outline, 'checkbox "Weekly digest"') });
    assert(!c.isError && await page.$eval('#weekly', (e) => e.checked), c.output);
    const bad = await tool('form_input', { ref: refFor(outline, 'combobox "Plan"'), value: 'Platinum' });
    assert(bad.isError && /Options: Free \| Pro \| Team/.test(bad.output), bad.output);
});
await check('click by ref submits the form; the report says what appeared (no screenshot needed)', async () => {
    const r = await tool('click', { ref: refFor(outline, 'button "Subscribe"') });
    assert(!r.isError && /New on the page: “Thanks, grace@example.com/.test(r.output) && !r.observe, `${r.output} observe=${r.observe}`);
    assert(await val('#result') === 'Thanks, grace@example.com (team, agreed=true, weekly=true)', await val('#result'));
});
await check('status messages show up in read_page', async () => {
    assert(/status "Thanks, grace@example.com/.test((await tool('read_page')).output), 'status line');
});
await check('screenshot: ≤ 1280×800; clicking by its coordinates hits the right element', async () => {
    const s = await tool('screenshot');
    assert(s.image && s.image.w <= 1280 && s.image.h <= 800 && s.image.len > 5000, JSON.stringify(s.image));
    const pos = await page.evaluate(() => { const r = document.getElementById('counter').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, vw: innerWidth }; });
    const k = s.image.w / pos.vw;
    const r = await tool('click', { x: Math.round(pos.x * k), y: Math.round(pos.y * k) });
    assert(!r.isError && await val('#counter') === 'Clicked 1', `${r.output} / ${await val('#counter')}`);
    assert(r.observe, 'clicks by coordinates are followed by a screenshot');
    assert(s.image.w <= 1024 && s.image.h <= 768, `screenshot ${s.image.w}×${s.image.h}`);
    const d = await tool('click', { x: Math.round(pos.x * k), y: Math.round(pos.y * k), clicks: 2 });
    assert(!d.isError && await val('#counter') === 'Clicked 3', await val('#counter'));
    const out = await tool('click', { x: 99999, y: 5 });
    assert(out.isError && /outside the screenshot/.test(out.output), out.output);
});
await check('a click reports the element\'s new state; a click that changes nothing says so', async () => {
    const o = (await tool('read_page')).output;
    const r = await tool('click', { ref: refFor(o, 'button "Clicked 3"') });
    assert(/It is now: button "Clicked 4"/.test(r.output), r.output);
    const h = await tool('click', { ref: refFor(o, 'heading "Join our newsletter"') });
    assert(/No visible change on the page/.test(h.output), h.output);
});
await check('Brisqal\'s cursor is drawn on the page but not in its own screenshots', async () => {
    const o = (await tool('read_page')).output;
    await tool('click', { ref: refFor(o, 'button "Clicked 4"') });
    await sleep(500);
    await page.screenshot({ path: path.join(ROOT, 'out/cursor-page.png') });
    const shot = await panel.evaluate(async () => (await __brisqalTest.host.execute({ id: 's', type: 'function', function: { name: 'computer', arguments: '{"action":"screenshot"}' } }, new AbortController().signal)).image.dataUrl);
    fs.writeFileSync(path.join(ROOT, 'out/cursor-brisqal.jpg'), Buffer.from(shot.split(',')[1], 'base64'));
    assert(await page.$('#__brisqal_overlay'), 'overlay present');
    assert(await page.$eval('#__brisqal_overlay', (e) => getComputedStyle(e).visibility) === 'visible', 'overlay visible again after the screenshot');
});
await check('shadow DOM and iframe buttons can be clicked by ref', async () => {
    const o = (await tool('read_page')).output;
    await tool('click', { ref: refFor(o, 'button "Shadow button"') });
    assert(await page.evaluate(() => document.getElementById('host').shadowRoot.querySelector('button').textContent) === 'shadow clicked', 'shadow');
    await tool('click', { ref: refFor(o, 'button "Frame button"') });
    const frame = page.frames().find((f) => f.url().endsWith('/frame.html'));
    assert(await frame.$eval('#fb', (e) => e.textContent) === 'frame clicked', 'iframe');
});
await check('a click on a covered element says what covered it', async () => {
    const o = (await tool('read_page')).output;
    await page.evaluate(() => { document.getElementById('cover').style.display = 'block'; });
    const r = await tool('click', { ref: refFor(o, 'button "Under the cover"') });
    await page.evaluate(() => { document.getElementById('cover').style.display = 'none'; });
    assert(/was on top of it/.test(r.output), r.output);
});
await check('keys: select all + type replaces; Enter submits a search (page change reported)', async () => {
    await resetForm();
    const o = (await tool('read_page')).output;
    await tool('type', { ref: refFor(o, 'searchbox "Search the shop"'), text: 'old words' });
    await tool('key', { keys: 'ctrl+a' });
    await tool('type', { text: 'boots' });
    assert(await val('#search') === 'boots', await val('#search'));
    const r = await tool('key', { keys: 'Enter' });
    assert(/The page is now “Page two”/.test(r.output), r.output);
    assert(page.url().endsWith('/page2.html?q=boots'), page.url());
    const bad = await tool('key', { keys: 'hyper+x' });
    assert(bad.isError && /Unknown key/.test(bad.output), bad.output);
});
await check('type with \\n submits', async () => {
    await resetForm();
    const o = (await tool('read_page')).output;
    const r = await tool('type', { ref: refFor(o, 'searchbox "Search the shop"'), text: 'socks\n' });
    assert(page.url().endsWith('/page2.html?q=socks'), `${page.url()} ${r.output}`);
});
await check('scroll moves the page and reports the position; scroll to a ref', async () => {
    await resetForm();
    const r = await tool('scroll', { direction: 'down', amount: 1 });
    assert(/Scrolled down\. Now \d+% down the page/.test(r.output), r.output);
    assert(await page.evaluate(() => scrollY) > 300, 'moved');
    const o = (await tool('find', { query: 'Bottom button' })).output;
    assert(/button "Bottom button" offscreen/.test(o), o);
    const r2 = await tool('scroll', { ref: refFor(o, 'button "Bottom button"') });
    assert(/into view/.test(r2.output) && await page.evaluate(() => scrollY) > 2000, r2.output);
    await tool('scroll', { direction: 'up', amount: 20 });
    const top = await tool('scroll', { direction: 'up' });
    assert(/already at the top/.test(top.output), top.output);
});
await check('wait for text that appears later', async () => {
    await page.evaluate(() => setTimeout(() => { document.getElementById('late').textContent = 'Order confirmed'; }, 1200));
    const r = await tool('wait', { for_text: 'order confirmed', seconds: 8 });
    assert(/is on the page now/.test(r.output), r.output);
});

console.log('\nNavigation and tabs');
await check('navigate: host names, a web search for plain words, blocked schemes', async () => {
    const r = await tool('navigate', { url: `127.0.0.1:${new URL(BASE).port}/page2.html` });
    assert(/Opened “Page two”/.test(r.output), r.output);
    const bad = await tool('navigate', { url: 'javascript:alert(1)' });
    assert(bad.isError && /only opens web pages/.test(bad.output), bad.output);
    await tool('navigate', { url: 'back' });
    assert(page.url().endsWith('/form.html'), page.url());
});
await check('a link that opens a new tab makes it the current tab', async () => {
    const o = (await tool('read_page')).output;
    const r = await tool('click', { ref: refFor(o, 'link "Open page 2 in a new tab"') });
    assert(/opened a new tab, which is now the current tab: “Page two”/.test(r.output), r.output);
    const t = await tool('get_text');
    assert(/query: \?from=blank/.test(t.output), t.output);
    const list = await tool('tabs', { action: 'list' });
    assert(/Page two .*\(current\).*\(opened by Brisqal\)/.test(list.output), list.output);
    const id = Number(list.output.match(/^(\d+) · Page two/m)[1]);
    const c = await tool('tabs', { action: 'close', tab_id: id });
    assert(/current tab is now/.test(c.output), c.output);
});
await check('tabs: open, switch, close', async () => {
    const o = await tool('tabs', { action: 'open', url: `${BASE}/article.html` });
    assert(/now the current tab: “An article about testing”/.test(o.output), o.output);
    assert(/How to test/.test((await tool('get_text')).output), 'reads the new tab');
    const sw = await tool('tabs', { action: 'switch', tab_id: formTab });
    assert(/Switched to “Newsletter/.test(sw.output), sw.output);
    const list = await tool('tabs', { action: 'list' });
    const id = Number(list.output.match(/^(\d+) · An article/m)[1]);
    await tool('tabs', { action: 'close', tab_id: id });
    assert(!(await tool('tabs', { action: 'list' })).output.includes('An article'), 'closed');
});
await check('blocked sites can\'t be read or opened', async () => {
    await panel.evaluate(() => __brisqalTest.update({ blockedSites: ['127.0.0.1'] }));
    const r = await tool('read_page');
    const n = await tool('navigate', { url: `${BASE}/page2.html` });
    await panel.evaluate(() => __brisqalTest.update({ blockedSites: [] }));
    assert(r.isError && /blocked sites/.test(r.output), r.output);
    assert(n.isError && /blocked sites/.test(n.output), n.output);
});
await check('browser pages are explained, not crashed on', async () => {
    const o = await tool('tabs', { action: 'open' });
    const r = await tool('read_page');
    assert(r.isError && /browser page/.test(r.output), `${o.output} / ${r.output}`);
    const list = await tool('tabs', { action: 'list' });
    const id = Number(list.output.match(/^(\d+) · .*\(current\)/m)[1]);
    await tool('tabs', { action: 'close', tab_id: id });
    await panel.evaluate((t) => __brisqalTest.useTab(t), formTab);
});

console.log('\nWhile a task runs');
await check('the border marks the tab; ending the task removes it and lets go of the debugger', async () => {
    await resetForm();
    await tool('screenshot');
    assert(await page.$('#__brisqal_overlay'), 'border shown');
    assert(await extAttached(panel, formTab), 'debugger attached while working');
    await panel.evaluate(() => __brisqalTest.host.end());
    assert(!(await page.$('#__brisqal_overlay')), 'border removed');
    assert(!(await extAttached(panel, formTab)), 'debugger detached');
});

// The panel UI needs a signed-in user: a fake account (no server calls in these tests).
const FAKE_ME = {
    user: { name: 'Test User', email: 'test@example.com' },
    usage: { plan: 'plus', plan_name: 'Plus', unlimited: false, can_send: true, reason: null, percent_used: 12, resets_at: null, period_end: null },
    models: [{ id: 'brisqal-pro', label: 'Brisqal Pro', description: 'Smart', efforts: ['low', 'high', 'max'], cost: 'low', cost_label: 'Low cost' }, { id: 'brisqal-pro-fast', label: 'Brisqal Pro Fast', description: 'Faster', efforts: ['low', 'high', 'max'], cost: 'high', cost_label: 'High cost' }],
    efforts: [{ id: 'low', label: 'Fast' }, { id: 'high', label: 'Thorough' }, { id: 'max', label: 'Maximum' }],
    default_model: 'brisqal-pro', default_effort: 'low', web_search: false,
    limits: { max_input_tokens: { 'brisqal-pro': 100000 } },
    links: { pricing: `${BASE}/pricing`, billing: `${BASE}/billing`, chat: `${BASE}/chat` },
};

await check('ask mode: an action waits for Allow in the panel', async () => {
    await panel.evaluate((me) => { __brisqalTest.setMe(me); return __brisqalTest.update({ consent: 1, mode: 'ask' }); }, FAKE_ME);
    try { await askModeChecks(); } finally {
        await panel.evaluate(() => { __brisqalTest.runner.stop(); return __brisqalTest.update({ mode: 'balanced' }); });
    }
});
async function askModeChecks() {
    await resetForm();
    const o = (await tool('read_page')).output;
    const pending = tool('click', { ref: refFor(o, 'button "Click me"') });
    pending.catch(() => undefined);
    await panel.waitForSelector('.card [data-decision="allow"]', { visible: true, timeout: 5000 });
    const titleText = await panel.$eval('.card .c-title', (e) => e.textContent);
    assert(/Click button "Click me"\?/.test(titleText), titleText);
    assert(await val('#counter') === 'Click me', 'nothing happened before approval');
    await panel.click('.card [data-decision="allow"]');
    const r = await pending;
    assert(!r.isError && await val('#counter') === 'Clicked 1', r.output);
    // Don't allow → nothing happens, and the model is told why.
    const p2 = tool('click', { ref: refFor(o, 'button "Click me"') });
    p2.catch(() => undefined);
    await panel.waitForSelector('.card:not(.resolved) [data-decision="deny"]', { visible: true });
    await panel.type('.card:not(.resolved) [data-feedback]', 'not now');
    await panel.click('.card:not(.resolved) [data-decision="deny"]');
    const r2 = await p2;
    assert(r2.isError && /declined.*They said: not now/.test(r2.output) && await val('#counter') === 'Clicked 1', r2.output);
    await panel.evaluate(() => __brisqalTest.host.end());
}

await check('a full task with a scripted model: reads, fills, submits, answers; UI shows the steps', async () => {
    await resetForm();
    await page.bringToFront();
    await panel.evaluate(() => {
        const api = __brisqalTest.api;
        let n = 0;
        api.chat = async (req, on) => {
            const step = n++;
            const tc = (name, args) => ({ id: `s${step}${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
            if (step === 0) { on.content?.('I\'ll fill in the form.'); return { content: 'I\'ll fill in the form.', reasoning: '', toolCalls: [tc('read_page', {})], finishReason: 'tool_calls' }; }
            if (step === 1) {
                const outline = [...req.messages].reverse().find((m) => m.role === 'tool').content;
                const ref = (re) => Number(outline.match(new RegExp(`\\[(\\d+)\\] ${re}`))[1]);
                const t = await chrome.tabs.get(__brisqalTest.host.tabId);
                globalThis.__groupDuring = t.groupId === -1 ? null : (await chrome.tabGroups.get(t.groupId)).title;
                return { content: '', reasoning: '', finishReason: 'tool_calls', toolCalls: [
                    tc('computer', { action: 'type', ref: ref('textbox "Email"'), text: 'agent@example.com' }),
                    tc('form_input', { ref: ref('combobox "Plan"'), value: 'Pro' }),
                    tc('computer', { action: 'left_click', ref: ref('button "Subscribe"') }),
                ] };
            }
            globalThis.__lastRequest = req;
            on.content?.('Done: you are subscribed with **agent@example.com** on the Pro plan.');
            return { content: 'Done: you are subscribed with **agent@example.com** on the Pro plan.', reasoning: '', toolCalls: [], finishReason: 'stop' };
        };
    });
    await panel.evaluate(() => { document.getElementById('input').value = 'Subscribe me to the newsletter'; document.getElementById('input').dispatchEvent(new Event('input')); });
    await panel.click('#send');
    await panel.waitForFunction(() => document.querySelectorAll('.msg.assistant').length >= 2 && !document.querySelector('.tool.running') && document.getElementById('stop').classList.contains('hidden'), { timeout: 30000 });
    assert(await val('#result') === 'Thanks, agent@example.com (pro, agreed=false, weekly=false)', await val('#result'));
    const ui = await panel.evaluate(() => ({
        steps: [...document.querySelectorAll('.tool .label')].map((e) => e.textContent.trim()),
        final: [...document.querySelectorAll('.msg.assistant .md')].pop().innerHTML,
        shot: !!document.querySelector('.shot img'),
        chip: document.getElementById('tabchip').textContent,
        title: document.getElementById('title').textContent,
        lastReq: { purpose: globalThis.__lastRequest.purpose, shots: JSON.stringify(globalThis.__lastRequest.messages).split('image_url').length - 1, report: JSON.stringify(globalThis.__lastRequest.messages.at(-1)) },
        firstTask: JSON.stringify(globalThis.__lastRequest.messages[1].content),
        group: globalThis.__groupDuring,
    }));
    assert(ui.steps.length === 4 && /Read the page/.test(ui.steps[0]) && /Type “agent@example.com” into textbox "Email"/.test(ui.steps[1])
        && /Choose “Pro” in combobox "Plan"/.test(ui.steps[2]) && /^Click button "Subscribe"/.test(ui.steps[3]), ui.steps.join(' | '));
    assert(/<strong>.*agent@example.com.*<\/strong>/.test(ui.final) && (!/<a /.test(ui.final) || /target="_blank"/.test(ui.final)), ui.final);
    assert(ui.lastReq.purpose === 'browser' && ui.lastReq.shots === 0 && /New on the page: “Thanks, agent@example.com/.test(ui.lastReq.report), JSON.stringify(ui.lastReq));
    assert(/\[Current tab: “Newsletter – Test Shop”/.test(ui.firstTask), `the task says where it starts: ${ui.firstTask}`);
    assert(ui.group === 'Brisqal', `tab group during the task: ${ui.group}`);
    assert(await panel.evaluate(async (t) => (await chrome.tabs.get(t)).groupId === -1, formTab), 'the user\'s tab leaves the group when the task ends');
    assert(/This tab.*Newsletter/.test(ui.chip) && ui.title === 'Subscribe me to the newsletter', `${ui.chip} / ${ui.title}`);
    assert(!(await page.$('#__brisqal_overlay')), 'border removed after the task');
    const hist = await panel.evaluate(async () => {
        const s = await chrome.storage.local.get(null);
        const key = Object.keys(s).find((k) => k.startsWith('session:'));
        return { count: s.sessions?.length, images: JSON.stringify(s[key]).includes('base64') };
    });
    assert(hist.count === 1 && !hist.images, `history ${JSON.stringify(hist)}`);

    // The real side panel is narrow: no sideways scrolling, in light and dark.
    for (const scheme of ['light', 'dark']) {
        await panel.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
        await panel.setViewport({ width: 360, height: 720 });
        await sleep(200);
        const overflow = await panel.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        await panel.screenshot({ path: path.join(ROOT, `out/panel-narrow-${scheme}.png`) });
        assert(overflow <= 0, `${scheme}: ${overflow}px wider than the panel`);
    }
    await panel.emulateMediaFeatures([]);
    await panel.setViewport(null);
});

await check('closing the panel mid-task releases the tab (debugger bar and border)', async () => {
    await resetForm();
    await page.bringToFront();
    await panel.evaluate(() => {
        let n = 0;
        __brisqalTest.api.chat = async () => {
            if (n++ === 0) return { content: '', reasoning: '', finishReason: 'tool_calls', toolCalls: [{ id: 'h1', type: 'function', function: { name: 'computer', arguments: '{"action":"screenshot"}' } }] };
            return new Promise(() => {}); // the model "thinks" forever
        };
    });
    await panel.evaluate(() => { document.getElementById('input').value = 'Take a look'; document.getElementById('input').dispatchEvent(new Event('input')); });
    await panel.click('#send');
    await page.waitForSelector('#__brisqal_overlay', { timeout: 10000 });
    await panel.waitForFunction(() => document.querySelector('.shot img'), { timeout: 10000 });
    await panel.close();
    ({ panel } = await openPanel());
    let attached = true;
    for (let i = 0; i < 20 && attached; i++) {
        await sleep(250);
        attached = await extAttached(panel, formTab);
    }
    assert(!attached, 'debugger released');
    assert(!(await page.$('#__brisqal_overlay')), 'border removed');
});

// ------------------------------------------------------------------ optional: a live model run
if (process.env.BRISQAL_SERVER && process.env.BRISQAL_TOKEN) {
    console.log('\nLive run against', process.env.BRISQAL_SERVER);
    await check('a real model fills in and submits the form on its own', async () => {
        await resetForm();
        await panel.evaluate(async (server, token) => {
            await __brisqalTest.update({ serverUrl: server, consent: 1, mode: 'balanced' });
            await chrome.storage.local.set({ auth: { token, user: { name: 'Live', email: 'live@test' } } });
        }, process.env.BRISQAL_SERVER, process.env.BRISQAL_TOKEN);
        // A fresh panel reads the saved sign-in at start (no reload of the old one).
        await panel.close();
        ({ panel } = await openPanel());
        await panel.waitForFunction(() => document.getElementById('model').options.length > 0, { timeout: 20000 });
        await page.bringToFront();
        const started = Date.now();
        await panel.evaluate(() => {
            document.getElementById('input').value = 'On this page, subscribe to the newsletter with the email live-test@example.com, choose the Team plan and tick "I agree to the terms". Then tell me the confirmation message.';
            document.getElementById('input').dispatchEvent(new Event('input'));
        });
        await panel.click('#send');
        let error;
        const deadline = Date.now() + 240000;
        try {
            for (;;) {
                const st = await panel.evaluate(() => {
                    const open = document.querySelector('.card:not(.resolved)');
                    if (open) {
                        // Answer like a user would: the first suggested answer, or "Yes" / Allow.
                        const btn = open.querySelector('[data-answer], [data-decision="allow"]');
                        if (btn) btn.click();
                        else { open.querySelector('[data-answer-input]').value = 'Yes, go ahead.'; open.querySelector('[data-answer-send]').click(); }
                        return 'answered';
                    }
                    return __brisqalTest.runner.busy ? 'busy' : 'done';
                });
                if (st === 'done') break;
                if (Date.now() > deadline) throw new Error('the task took more than 4 minutes');
                await sleep(1000);
            }
        } catch (e) { error = e; }
        const ev = await panel.evaluate(() => __brisqalTest.events).catch((e) => [{ type: 'unreadable', e: String(e) }]);
        const result = await val('#result');
        const final = await panel.evaluate(() => [...document.querySelectorAll('.msg.assistant .md')].pop()?.textContent ?? '').catch(() => '');
        const steps = ev.filter((e) => e.type === 'toolStart').map((e) => `${e.name}(${JSON.stringify(e.args).slice(0, 60)})`);
        console.log(`      ${steps.length} steps in ${Math.round((Date.now() - started) / 1000)} s:\n        ${steps.join('\n        ')}`);
        for (const e of ev.filter((x) => ['notice', 'error', 'planBlocked', 'question', 'approval', 'signedOut'].includes(x.type))) console.log(`      [${e.type}] ${e.text ?? e.message ?? e.question ?? e.title}`);
        console.log(`      result on the page: ${result || '(empty)'}\n      answer: ${final.slice(0, 400)}`);
        fs.writeFileSync(path.join(ROOT, 'out/live-events.json'), JSON.stringify(ev, null, 1));
        await panel.screenshot({ path: path.join(ROOT, 'out/live-panel.png') }).catch(() => undefined);
        if (error) throw error;
        assert(result === 'Thanks, live-test@example.com (team, agreed=true, weekly=false)', `page shows: ${result}`);
        assert(/Thanks/.test(final), 'reports the confirmation');
    });
}

if (process.env.BRISQAL_SERVER && process.env.BRISQAL_TOKEN && process.env.BRISQAL_LIVE_WEB) {
    await check('a real model does a multi-step task on a real website', async () => {
        await page.goto('https://en.wikipedia.org/wiki/Main_Page');
        await page.bringToFront();
        const started = Date.now();
        await panel.evaluate(() => {
            document.getElementById('input').value = 'Search Wikipedia for Alan Turing, open his article, and tell me his date of birth and the name of the test named after him.';
            document.getElementById('input').dispatchEvent(new Event('input'));
        });
        const before = await panel.evaluate(() => __brisqalTest.events.length);
        await panel.click('#send');
        const deadline = Date.now() + 300000;
        while (await panel.evaluate(() => { const c = document.querySelector('.card:not(.resolved)'); if (c) (c.querySelector('[data-answer], [data-decision="allow"]') ?? c.querySelector('[data-answer-send]'))?.click(); return __brisqalTest.runner.busy; })) {
            if (Date.now() > deadline) throw new Error('the task took more than 5 minutes');
            await sleep(1000);
        }
        const ev = (await panel.evaluate(() => __brisqalTest.events)).slice(before);
        const steps = ev.filter((e) => e.type === 'toolStart').map((e) => `${e.name}(${JSON.stringify(e.args).slice(0, 70)})`);
        const final = await panel.evaluate(() => [...document.querySelectorAll('.msg.assistant .md')].pop()?.textContent ?? '');
        console.log(`      ${steps.length} actions, ${ev.filter((e) => e.type === 'turnStart').length} model calls, ${Math.round((Date.now() - started) / 1000)} s:\n        ${steps.join('\n        ')}`);
        console.log(`      answer: ${final.slice(0, 300)}`);
        fs.writeFileSync(path.join(ROOT, 'out/live-web-events.json'), JSON.stringify(ev, null, 1));
        await page.screenshot({ path: path.join(ROOT, 'out/live-web-page.png') });
        assert(/1912/.test(final) && /Turing test/i.test(final), final);
    });
}

await browser.close();
server.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `: ${failures.join('; ')}` : ''}`);
process.exit(failures.length ? 1 : 0);
