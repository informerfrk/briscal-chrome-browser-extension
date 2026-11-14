/**
 * The side panel: sign-in, consent, the chat with Brisqal, approvals and questions, settings and
 * history. The agent runs right here (not in the service worker), so long tasks are never cut off
 * by the worker going idle; closing the panel stops the task.
 */
import DOMPurify from 'dompurify';
import { Marked } from 'marked';
import { NOTE_PREFIX } from '../core/agent';
import { ApiClient, ApiError, MeResponse, PlanStatus } from '../core/api';
import type { Mode } from '../core/prompt';
import { Runner } from './runner';
import {
    Auth, CONSENT_VERSION, deleteSession, listSessions, loadAuth, loadSession, loadSettings, normalizeServer, normalizeSites,
    normalizeStepLimit, saveAuth, saveSettings, SessionMeta, Settings,
} from './store';
import { esc, ICONS, logo, requestCard, resolveCard, stepLabel, wireRequestCards } from './ui';

declare const __TEST__: boolean;

const marked = new Marked({ gfm: true, breaks: false });
// Links in replies open in a new tab (a plain link would navigate the side panel itself away).
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
});
const md = (s: string) => DOMPurify.sanitize(marked.parse(s) as string, { ADD_ATTR: ['target'] });
const VERSION = chrome.runtime.getManifest().version;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ state
let settings: Settings;
let auth: Auth | undefined;
let me: MeResponse | undefined;
let authState: 'signedOut' | 'signingIn' | 'signedIn' = 'signedOut';
let authError = '';
let signIn: { code: string; url: string; abort: AbortController; tabId?: number } | null = null;
let serverProblem = '';
let planBlocked = '';
let busy = false;
let windowId: number = chrome.windows.WINDOW_ID_CURRENT;
let title = 'New task';
let stopShortcut = '';
let platform: { os: 'windows' | 'mac' | 'linux' | 'chromeos' | 'other'; browser: string } = { os: 'other', browser: 'Chrome' };
let shownTab: { id?: number; title?: string; url?: string; favIconUrl?: string } | null = null;

const api = new ApiClient(() => settings.serverUrl, () => auth?.token);
let runner: Runner;

// ------------------------------------------------------------------ layout
const root = document.getElementById('root')!;
root.innerHTML = `
<section id="gate" class="gate hidden"></section>
<div id="app" class="app hidden">
  <header class="top">
    <span class="brand">${logo(22)}</span>
    <h1 id="title" title="">New task</h1>
    <button id="plan" class="plan" title="Plan &amp; usage"></button>
    <button id="new-task" class="icon-btn" title="New task">${ICONS.plus}</button>
    <button id="history-btn" class="icon-btn" title="Recent tasks">${ICONS.history}</button>
    <button id="settings-btn" class="icon-btn" title="Settings">${ICONS.gear}</button>
  </header>
  <div id="banner" class="banner hidden"></div>
  <div id="log" class="log" tabindex="-1"></div>
  <form id="composer" class="composer">
    <div id="tabchip" class="tabchip"></div>
    <textarea id="input" rows="2" placeholder="What should Brisqal do in this tab?"></textarea>
    <div class="bar">
      <label class="chip" title="What Brisqal may do without asking"><span id="mode-label"></span><select id="mode">
        <option value="ask">Ask before acting</option>
        <option value="balanced">Act, ask before risky steps</option>
        <option value="auto">Act without asking</option>
      </select></label>
      <label class="chip" title="Model"><span id="model-label"></span><select id="model"></select></label>
      <label class="chip" title="Thinking"><span id="effort-label"></span><select id="effort"></select></label>
      <div class="spacer"></div>
      <button type="button" id="stop" class="round stop hidden" title="Stop (Esc)">${ICONS.stop}</button>
      <button type="submit" id="send" class="round send" title="Send (Enter)">${ICONS.send}</button>
    </div>
  </form>
</div>
<div id="modal" class="modal hidden"></div>`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const log = $('log'), input = $<HTMLTextAreaElement>('input');
const modeSel = $<HTMLSelectElement>('mode'), modelSel = $<HTMLSelectElement>('model'), effortSel = $<HTMLSelectElement>('effort');

// ------------------------------------------------------------------ rendering: gate, header, banner
function render() {
    const gate = authState !== 'signedIn' || (settings.consent ?? 0) < CONSENT_VERSION;
    $('gate').classList.toggle('hidden', !gate);
    $('app').classList.toggle('hidden', gate);
    if (authState !== 'signedIn') return renderSignIn();
    if ((settings.consent ?? 0) < CONSENT_VERSION) return renderConsent();
    renderHeader();
    renderChoices();
    renderBanner();
    updateComposer();
}

function renderHeader() {
    const u = me?.usage;
    $('plan').innerHTML = !u ? '' : u.unlimited
        ? '<span class="pill">Owner</span>'
        : u.plan
            ? `<span class="pill">${esc(u.plan_name)}</span><span class="meter"><span class="${u.percent_used >= 90 ? 'hot' : u.percent_used >= 70 ? 'warm' : ''}" style="width:${Math.min(100, u.percent_used)}%"></span></span>`
            : '<span class="pill warn">No plan</span>';
    $('plan').title = u ? `${me!.user.email}: ${u.unlimited ? 'unlimited' : u.plan ? `${u.percent_used}% used` : 'choose a plan'}` : '';
    $('title').textContent = title;
    $('title').title = title;
}

function renderChoices() {
    if (me) {
        modelSel.innerHTML = me.models.map((m) => `<option value="${esc(m.id)}" title="${esc(m.description)}" data-short="${esc(m.label)}" data-cost="${esc(m.cost ?? '')}">${esc(m.label)}${m.cost_label ? ` · ${esc(m.cost_label)}` : ''}</option>`).join('');
        modelSel.value = settings.model && me.models.some((m) => m.id === settings.model) ? settings.model : me.default_model;
        renderEfforts();
    }
    modeSel.value = settings.mode;
    syncChips();
}

/** Thinking menu for the selected model: only the levels it supports (the nearest cheaper one when the saved one is missing). */
function renderEfforts() {
    if (!me) return;
    const all = me.efforts;
    const model = me.models.find((m) => m.id === modelSel.value);
    const ids = model?.efforts?.length ? model.efforts : all.map((e) => e.id);
    const list = all.filter((e) => ids.includes(e.id));
    effortSel.innerHTML = list.map((e) => `<option value="${esc(e.id)}">${esc(e.label)}</option>`).join('');
    const order = all.map((e) => e.id);
    const want = order.indexOf(settings.effort ?? me.default_effort ?? '');
    let pick = list[0]?.id;
    for (const e of list) if (order.indexOf(e.id) <= want) pick = e.id;
    effortSel.value = list.some((e) => e.id === settings.effort) ? settings.effort! : (pick ?? '');
}

/** The visible chip text mirrors each invisible native select. */
function syncChips() {
    const label = (sel: HTMLSelectElement) => sel.selectedOptions[0]?.textContent ?? '';
    $('mode-label').textContent = { ask: 'Ask first', balanced: 'Act', auto: 'Auto' }[modeSel.value as Mode] ?? '';
    const model = modelSel.selectedOptions[0];
    $('model-label').textContent = model?.dataset.short ?? label(modelSel);
    $('model-label').parentElement!.title = `Model: ${label(modelSel)}`;
    $('model-label').parentElement!.dataset.cost = model?.dataset.cost ?? '';
    $('effort-label').textContent = label(effortSel);
    $('mode-label').parentElement!.classList.toggle('chip-auto', modeSel.value === 'auto');
}

function renderSignIn() {
    const el = $('gate');
    if (authState === 'signingIn' && signIn) {
        el.innerHTML = `<div class="gate-card">${logo(52)}
            <h1>Finish signing in</h1>
            <p>Approve the request in the tab that just opened. It should show this code:</p>
            <div class="code-box">${esc(signIn.code)}</div>
            <div class="spinner"></div>
            <button class="btn btn-secondary" data-act="reopen">Open the sign-in page again</button>
            <button class="btn btn-link" data-act="cancelSignIn">Cancel</button></div>`;
        return;
    }
    el.innerHTML = `<div class="gate-card">${logo(52)}
        <h1>Brisqal for Chrome</h1>
        <p>Your AI helper in the browser. Tell it what you need, and it reads pages, clicks, types and fills in forms while you watch.</p>
        <button class="btn btn-primary wide" data-act="signIn">Sign in with Brisqal</button>
        ${authError ? `<div class="err">${esc(authError)}</div>` : ''}
        <p class="legal">By signing in you agree to the <a href="#" data-act="terms">Terms of Service</a> and <a href="#" data-act="privacy">Privacy Policy</a>. AI can make mistakes: watch what Brisqal does and check important results.</p>
        <details class="server-row"><summary>Server: ${esc(settings.serverUrl)}</summary>
          <div class="row"><input id="server-url" class="input" value="${esc(settings.serverUrl)}"><button class="btn btn-secondary" data-act="saveServer">Save</button></div></details>
    </div>`;
}

/** One-time consent before Brisqal may read pages, take screenshots or use the mouse and keyboard. */
function renderConsent() {
    $('gate').innerHTML = `<div class="gate-card consent">${logo(44)}
        <h1>Before you start</h1>
        <p>To do tasks for you, Brisqal for Chrome needs to:</p>
        <ul class="consent-list">
          <li><b>Read the pages it works on.</b> While a task runs, Brisqal reads the tab's content and takes screenshots of it, and sends them to Brisqal's servers so the AI can decide what to do next. Nothing is read when no task is running.</li>
          <li><b>Click and type for you.</b> It controls the tab like a person would. Chrome shows a bar saying the browser is being controlled while it works.</li>
          <li><b>Ask before anything risky.</b> It asks before buying, sending, posting or deleting, and it never types passwords, card details or codes: you type those yourself.</li>
        </ul>
        <p class="small muted">Stop it anytime with the stop button${stopShortcut ? `, <kbd>${esc(stopShortcut)}</kbd>` : ''} or "Cancel" on Chrome's bar. AI can make mistakes: check important results.</p>
        <button class="btn btn-primary wide" data-act="consent">Allow and continue</button>
        <p class="legal">How page content and screenshots are handled: <a href="#" data-act="privacy">Privacy Policy</a>. <a href="#" data-act="signOut">Not now (sign out)</a></p>
    </div>`;
}

function renderBanner() {
    const b = $('banner');
    let cls = '';
    let html = '';
    const u = me?.usage;
    if (serverProblem) {
        cls = 'err';
        html = `<div class="b-text"><b>Can't reach Brisqal</b>${esc(serverProblem)}</div><button class="btn btn-secondary" data-act="refreshPlan">Try again</button>`;
    } else if (u && !u.can_send) {
        cls = 'err';
        html = u.reason === 'no_plan'
            ? '<div class="b-text"><b>Choose a plan to use Brisqal</b>Plans start at $20/month.</div><button class="btn btn-primary" data-act="pricing">See plans</button><button class="btn btn-link" data-act="refreshPlan">I\'ve subscribed</button>'
            : `<div class="b-text"><b>Usage limit reached</b>You can continue ${u.resets_at ? 'in ' + timeUntil(u.resets_at) : 'soon'}, or upgrade for more.</div><button class="btn btn-primary" data-act="pricing">Upgrade</button>`;
    } else if (planBlocked) {
        cls = 'err';
        html = `<div class="b-text"><b>Can't continue</b>${esc(planBlocked)}</div><button class="btn btn-primary" data-act="pricing">Plans</button>`;
    }
    b.className = `banner ${cls}`;
    b.innerHTML = html;
    b.classList.toggle('hidden', !html);
}

function timeUntil(iso: string) {
    const ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return 'a moment';
    const h = Math.floor(ms / 3600000), m = Math.round((ms % 3600000) / 60000);
    return h ? `${h}h ${m}m` : `${m}m`;
}

function updateComposer() {
    const blocked = !me || !me.usage.can_send;
    $('send').classList.toggle('hidden', busy && !input.value.trim());
    $('stop').classList.toggle('hidden', !busy);
    ($('send') as HTMLButtonElement).disabled = blocked || !input.value.trim();
    input.placeholder = busy ? 'Brisqal is working… Type to add instructions' : 'What should Brisqal do in this tab?';
    $('title').textContent = title;
}

function renderTabChip() {
    const t = shownTab;
    const el = $('tabchip');
    if (!t) { el.innerHTML = ''; el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    let host = '';
    try { host = new URL(t.url ?? '').hostname; } catch { /* browser page */ }
    const icon = t.favIconUrl && /^https?:|^data:image\//.test(t.favIconUrl) ? `<img src="${esc(t.favIconUrl)}" alt="">` : ICONS.globe;
    el.innerHTML = `<span class="tc-label">${busy ? 'Working in' : 'This tab'}</span>${icon}<span class="tc-title">${esc(t.title || host || 'New tab')}</span>`;
    el.title = t.url ?? '';
    el.classList.toggle('working', busy);
}

/** While idle, the chip follows the tab the user is looking at (that's where the next task starts). */
async function followActiveTab() {
    if (busy) return;
    const [t] = await chrome.tabs.query({ active: true, windowId });
    shownTab = t ? { id: t.id, title: t.title, url: t.url, favIconUrl: t.favIconUrl } : null;
    renderTabChip();
}

// ------------------------------------------------------------------ rendering: transcript
let turn: { el: HTMLElement; content: string; reasoning: string; raf: number } | null = null;
const tools = new Map<string, HTMLElement>();

/**
 * Follow the bottom of the transcript while new text arrives, until the user scrolls up; scrolling
 * back to the bottom follows again. Decided from the user's scrolling, not from the amount of new content.
 */
const STICK_PX = 48;
let stickToBottom = true;
let lastScrollTop = 0;
let followFrame = 0;

log.addEventListener('scroll', () => {
    const dist = log.scrollHeight - log.scrollTop - log.clientHeight;
    if (dist <= STICK_PX) stickToBottom = true;
    else if (log.scrollTop < lastScrollTop - 1) stickToBottom = false; // the user scrolled up
    lastScrollTop = log.scrollTop;
}, { passive: true });
log.addEventListener('pointerdown', (e) => { if (e.target === log && e.offsetX >= log.clientWidth) stickToBottom = false; });

function scroll(force = false) {
    if (force) stickToBottom = true;
    if (!stickToBottom) return;
    log.scrollTop = log.scrollHeight;
    lastScrollTop = log.scrollTop;
}

new MutationObserver(() => {
    if (!stickToBottom || followFrame) return;
    followFrame = requestAnimationFrame(() => { followFrame = 0; scroll(); });
}).observe(log, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
log.addEventListener('load', () => { if (stickToBottom) scroll(); }, true);
new ResizeObserver(() => { if (stickToBottom) scroll(); }).observe(log);

function empty() {
    const first = me?.user.name.split(' ')[0];
    log.innerHTML = `<div class="empty">${logo(44)}
        <h2>What can I do for you${first ? ', ' + esc(first) : ''}?</h2>
        <p>Brisqal works in the tab you're on: it reads the page, clicks and types for you, and asks before anything risky.</p>
        <div class="ideas">
          <button data-idea="Summarize this page in 5 bullet points, then tell me the single most important takeaway."><b>Summarize this page</b><span>Key points in seconds</span></button>
          <button data-idea="Fill in the form on this page. Ask me for any details you need, and show me what you entered before submitting."><b>Fill in a form</b><span>It asks for anything it needs</span></button>
          <button data-idea="Search for the best-reviewed noise-cancelling headphones under $200 and compare the top 3 in a table with price, battery life and rating."><b>Compare products</b><span>Research across sites</span></button>
          <button data-idea="Find the contact email, phone number and opening hours on this website."><b>Find contact details</b><span>Digs through the site for you</span></button>
          <button data-idea="List the tabs I have open, grouped by topic, and tell me which ones look like duplicates."><b>Tidy my tabs</b><span>Groups and spots duplicates</span></button>
          <button data-idea="Translate the main content of this page into Spanish and show it to me here."><b>Translate this page</b><span>Shown here in the panel</span></button>
        </div></div>`;
}

function addUser(text: string, note = false) {
    log.querySelector('.empty')?.remove();
    const el = document.createElement('div');
    el.className = `msg user${note ? ' note' : ''}`;
    el.textContent = text;
    if (note) el.title = 'Sent while Brisqal was working: it reads this at its next step';
    log.appendChild(el);
    scroll(true);
}

function startTurn() {
    const el = document.createElement('div');
    el.className = 'msg assistant';
    el.innerHTML = '<details class="thinking hidden"><summary>Thinking…</summary><div class="thinking-text"></div></details><div class="md"></div><div class="dots"><i></i><i></i><i></i></div>';
    log.appendChild(el);
    turn = { el, content: '', reasoning: '', raf: 0 };
    scroll();
}

function paint() {
    if (!turn || turn.raf) return;
    turn.raf = requestAnimationFrame(() => {
        if (!turn) return;
        turn.raf = 0;
        if (turn.reasoning) {
            const th = turn.el.querySelector('.thinking') as HTMLElement;
            th.classList.remove('hidden');
            const tt = th.querySelector('.thinking-text') as HTMLElement;
            const following = tt.scrollHeight - tt.scrollTop - tt.clientHeight <= STICK_PX;
            tt.textContent = turn.reasoning;
            if (following) tt.scrollTop = tt.scrollHeight;
        }
        if (turn.content) {
            turn.el.querySelector('.dots')?.remove();
            (turn.el.querySelector('.md') as HTMLElement).innerHTML = md(turn.content);
        }
        scroll();
    });
}

function endTurn() {
    if (!turn) return;
    cancelAnimationFrame(turn.raf);
    const t = turn;
    turn = null;
    t.el.querySelector('.dots')?.remove();
    (t.el.querySelector('.thinking summary') as HTMLElement).textContent = 'Thought process';
    if (t.reasoning) { t.el.querySelector('.thinking')!.classList.remove('hidden'); (t.el.querySelector('.thinking-text') as HTMLElement).textContent = t.reasoning; }
    if (t.content) (t.el.querySelector('.md') as HTMLElement).innerHTML = md(t.content);
    if (!t.content && !t.reasoning) t.el.remove();
}

function addTool(id: string, name: string, args: any) {
    log.querySelector('.empty')?.remove();
    const { icon, html } = stepLabel(name, args);
    const el = document.createElement('div');
    el.className = 'tool running';
    el.innerHTML = `<span class="ic">${ICONS[icon]}</span><details><summary class="label">${html} <span class="elapsed" data-since="${Date.now()}"></span></summary><pre class="out"></pre></details>`;
    log.appendChild(el);
    tools.set(id, el);
    scroll();
}

function endTool(id: string, output: string, isError: boolean, label?: string) {
    const el = tools.get(id);
    if (!el) return;
    if (label && !isError) {
        const since = el.querySelector('.elapsed');
        const summary = el.querySelector('summary') as HTMLElement;
        summary.textContent = label + ' ';
        if (since) summary.appendChild(since);
    }
    el.classList.remove('running');
    el.classList.toggle('error', isError);
    el.querySelector('.elapsed')?.removeAttribute('data-since');
    (el.querySelector('.out') as HTMLElement).textContent = output;
}

function addShot(dataUrl: string) {
    // One live thumbnail: the latest look at the page replaces the previous one (no pile-up of images).
    log.querySelectorAll('.shot').forEach((s) => s.remove());
    const el = document.createElement('div');
    el.className = 'shot';
    el.innerHTML = `<img alt="What Brisqal saw" src="${esc(dataUrl)}">`;
    log.appendChild(el);
    scroll();
}

function addNotice(text: string, cls = 'notice') {
    const el = document.createElement('div');
    el.className = cls;
    el.textContent = text;
    log.appendChild(el);
    scroll();
}

const HIDDEN_USER = /^\[Screenshot of the tab now|^\[screenshot\]|^\(The earlier part|^\[older screenshot removed\]|^\[Current tab:/;

function renderTranscript(messages: any[]) {
    log.innerHTML = '';
    tools.clear();
    turn = null;
    if (!messages.length) return empty();
    const results = new Map<string, string>();
    for (const m of messages) if (m.role === 'tool') results.set(m.tool_call_id, m.content);
    for (const m of messages) {
        if (m.role === 'user') {
            const full = typeof m.content === 'string' ? m.content : m.content.map((p: any) => p.text ?? '').join('\n');
            // A user message may carry messages typed mid-task after its own text (or after a screenshot).
            full.split(NOTE_PREFIX).forEach((seg: string, i: number) => {
                const text = seg.split('\n').filter((l) => !HIDDEN_USER.test(l.trim())).join('\n').trim();
                if (text) addUser(text, i > 0);
            });
        }
        if (m.role === 'assistant') {
            if (m.content) {
                const el = document.createElement('div');
                el.className = 'msg assistant';
                el.innerHTML = `<div class="md">${md(m.content)}</div>`;
                log.appendChild(el);
            }
            for (const tc of m.tool_calls || []) {
                let a = {};
                try { a = JSON.parse(tc.function.arguments); } catch { /* ignore */ }
                addTool(tc.id, tc.function.name, a);
                const out = results.get(tc.id) ?? '';
                endTool(tc.id, out, /^Error:|^The user declined|^Not typed/.test(out));
            }
        }
    }
    scroll(true);
}

// ------------------------------------------------------------------ modals
function openSettings() {
    const s = settings;
    $('modal').innerHTML = `<div class="modal-card" role="dialog" aria-label="Settings">
        <div class="modal-head"><h2>Settings</h2><button class="icon-btn" data-act="closeModal" title="Close">${ICONS.close}</button></div>
        <div class="field"><label for="set-mode">What Brisqal may do without asking</label>
            <select id="set-mode" class="input">
              <option value="ask">Ask before every action</option>
              <option value="balanced">Act, and ask before risky steps (recommended)</option>
              <option value="auto">Act without asking</option>
            </select>
            <div class="help">In every mode Brisqal asks before buying, sending, posting or deleting, and never types passwords, card details or codes.</div></div>
        <div class="field"><label for="set-blocked">Blocked sites</label>
            <textarea id="set-blocked" class="input" rows="3" placeholder="e.g. mybank.com, work-portal.example">${esc(s.blockedSites.join('\n'))}</textarea>
            <div class="help">Brisqal won't open, read or act on these sites (subdomains included). One per line.</div></div>
        <div class="field"><label for="set-steps">Most steps per task</label><input id="set-steps" class="input" type="number" min="0" max="1000" placeholder="No limit" value="${s.stepLimit || ''}">
            <div class="help">Leave empty for no limit: Brisqal keeps working until the task is done and only waits when it needs you (for example to sign in). Each step uses a little of your plan.</div></div>
        <div class="field"><label>Keyboard shortcuts</label><div class="status-row">${stopShortcut ? `Stop: <kbd>${esc(stopShortcut)}</kbd>` : 'No stop shortcut set'}<span class="spacer"></span><button class="btn btn-link" data-act="shortcuts">Change</button></div></div>
        <div class="field"><label for="set-server">Server</label><input id="set-server" class="input" value="${esc(s.serverUrl)}">
            <div class="help">Changing it signs you out.</div></div>
        <div class="field"><label>Account</label><div class="status-row"><span class="ellipsis">${esc(me?.user.email ?? auth?.user.email ?? '')}</span><span class="spacer"></span><button class="btn btn-link" data-act="billing">Billing</button><button class="btn btn-link" data-act="signOut">Sign out</button></div></div>
        <p class="muted small">Brisqal for Chrome ${esc(VERSION)} · <a href="#" data-act="terms">Terms</a> · <a href="#" data-act="privacy">Privacy</a></p>
        <div class="modal-actions"><button class="btn btn-secondary" data-act="closeModal">Cancel</button><button class="btn btn-primary" data-act="saveSettings">Save</button></div>
    </div>`;
    ($('set-mode') as HTMLSelectElement).value = s.mode;
    $('modal').classList.remove('hidden');
}

async function openHistory() {
    const list = await listSessions();
    const items = list.length
        ? list.map((s: SessionMeta) => `<button class="session ${s.id === runner.session.id ? 'active' : ''}" data-session="${esc(s.id)}"><span class="s-title">${esc(s.title)}</span><span class="s-date">${esc(relDate(s.updatedAt))}</span><span class="del" data-del="${esc(s.id)}" title="Delete">${ICONS.trash}</span></button>`).join('')
        : '<p class="muted small">Your tasks will appear here. Screenshots are never saved.</p>';
    $('modal').innerHTML = `<div class="modal-card" role="dialog" aria-label="Recent tasks">
        <div class="modal-head"><h2>Recent tasks</h2><button class="icon-btn" data-act="closeModal" title="Close">${ICONS.close}</button></div>
        <div class="sessions">${items}</div></div>`;
    $('modal').classList.remove('hidden');
}

function relDate(t: number) {
    const d = Date.now() - t;
    if (d < 60000) return 'now';
    if (d < 3600000) return `${Math.round(d / 60000)} min`;
    if (d < 86400000) return `${Math.round(d / 3600000)} h`;
    return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function closeModal() {
    $('modal').classList.add('hidden');
    $('modal').innerHTML = '';
}

// ------------------------------------------------------------------ events from the runner
/** Test builds keep a log of the runner's events (without text deltas or images) for diagnostics. */
const testEvents: Record<string, unknown>[] = [];

function onEvent(m: Record<string, any>) {
    if (__TEST__ && !['reasoning', 'content', 'screenshot'].includes(m.type)) testEvents.push({ ...m, t: Date.now() });
    switch (m.type) {
        case 'user': addUser(m.text, m.note); break;
        case 'busy':
            busy = m.busy;
            if (!busy) { endTurn(); void followActiveTab(); }
            port.post({ type: 'busy', busy });
            updateComposer();
            renderTabChip();
            break;
        case 'turnStart': startTurn(); break;
        case 'reasoning': if (turn) { turn.reasoning += m.d; paint(); } break;
        case 'content': if (turn) { turn.content += m.d; paint(); } break;
        case 'turnEnd': endTurn(); break;
        case 'toolStart': addTool(m.id, m.name, m.args); break;
        case 'toolEnd': endTool(m.id, m.output, m.isError, m.label); break;
        case 'screenshot': addShot(m.dataUrl); break;
        case 'approval': case 'question':
            log.insertAdjacentHTML('beforeend', requestCard(m));
            scroll(true);
            (log.lastElementChild?.querySelector('[data-answer-input], [data-decision="allow"]') as HTMLElement | null)?.focus();
            break;
        case 'resolved': resolveCard(log, m.id, m.decision, m.text); break;
        case 'notice': addNotice(m.text); break;
        case 'error': addNotice(m.message, 'notice err'); break;
        case 'planBlocked': planBlocked = m.message; addNotice(m.message, 'notice err'); renderBanner(); updateComposer(); break;
        case 'signedOut': void doSignOut(m.message); break;
        case 'tab':
            if (m.tab) {
                shownTab = m.tab;
                if (m.tab.id !== undefined) port.post({ type: 'touched', tabId: m.tab.id });
            }
            renderTabChip();
            break;
        case 'sessionsChanged': break;
    }
}

// ------------------------------------------------------------------ the service worker: cleanup if the panel closes mid-task
/**
 * If the panel is closed while a task runs, the worker lets go of the tabs this panel was controlling
 * (debugger bar, border). A heartbeat keeps the worker awake while a task runs.
 */
const port = (() => {
    let p: chrome.runtime.Port | null = null;
    const tabs = new Set<number>();
    let isBusy = false;
    const connect = () => {
        p = chrome.runtime.connect({ name: 'panel' });
        p.onDisconnect.addListener(() => { p = null; setTimeout(connect, 1000); });
        for (const t of tabs) p.postMessage({ type: 'touched', tabId: t });
        p.postMessage({ type: 'busy', busy: isBusy });
    };
    connect();
    setInterval(() => { if (isBusy) p?.postMessage({ type: 'ping' }); }, 20000);
    return {
        post(m: { type: string; tabId?: number; busy?: boolean }) {
            if (m.type === 'touched' && m.tabId !== undefined) tabs.add(m.tabId);
            if (m.type === 'busy') { isBusy = !!m.busy; if (!isBusy) tabs.clear(); }
            try { p?.postMessage(m); } catch { /* reconnecting */ }
        },
    };
})();

// ------------------------------------------------------------------ account
async function refreshMe() {
    try {
        me = await api.me();
        serverProblem = '';
        if (planBlocked && me.usage.can_send) planBlocked = '';
    } catch (e: any) {
        if (e instanceof ApiError && e.isAuth) return doSignOut('Your session ended. Please sign in again.');
        serverProblem = e?.message || String(e);
    }
    render();
}

async function startSignIn() {
    authError = '';
    const abort = new AbortController();
    try {
        const start = await api.startDeviceAuth({
            client_name: 'Brisqal for Chrome',
            client_version: VERSION,
            hostname: { windows: 'Windows', mac: 'Mac', linux: 'Linux', chromeos: 'ChromeOS', other: 'this computer' }[platform.os],
        });
        const tab = await chrome.tabs.create({ url: start.verification_uri_complete, windowId: windowId >= 0 ? windowId : undefined });
        signIn = { code: start.user_code, url: start.verification_uri_complete, abort, tabId: tab.id };
        authState = 'signingIn';
        render();
        const until = Date.now() + start.expires_in * 1000;
        while (Date.now() < until && !abort.signal.aborted) {
            await sleep(Math.max(1, start.interval) * 1000);
            if (abort.signal.aborted) break;
            const r = await api.pollDeviceAuth(start.device_code);
            if (r) {
                auth = { token: r.access_token, user: r.user };
                await saveAuth(auth);
                authState = 'signedIn';
                // Close the approval tab we opened (it says "you can close this tab").
                if (signIn?.tabId !== undefined) {
                    const t = await chrome.tabs.get(signIn.tabId).catch(() => null);
                    if (t?.url?.startsWith(settings.serverUrl)) await chrome.tabs.remove(t.id!).catch(() => undefined);
                }
                signIn = null;
                await refreshMe();
                if (!log.children.length) empty();
                return;
            }
        }
        if (!abort.signal.aborted) throw new Error('The sign-in request expired. Please try again.');
    } catch (e: any) {
        authError = e?.message || String(e);
    }
    if (authState !== 'signedIn') {
        authState = 'signedOut';
        signIn = null;
        render();
    }
}

async function doSignOut(message = '') {
    await runner?.stopAndWait();
    try { if (auth) await api.logout(); } catch { /* token already gone */ }
    auth = undefined;
    me = undefined;
    await saveAuth(undefined);
    authState = 'signedOut';
    authError = message;
    render();
}

function openUrl(url: string) {
    void chrome.tabs.create({ url, windowId: windowId >= 0 ? windowId : undefined });
}

function link(which: 'pricing' | 'billing' | 'terms' | 'privacy') {
    const base = settings.serverUrl;
    if (which === 'terms' || which === 'privacy') return openUrl(`${base}/legal/${which}`);
    openUrl(me?.links?.[which] ?? `${base}/${which}`);
}

async function updateSettings(patch: Partial<Settings>) {
    const serverChanged = patch.serverUrl !== undefined && normalizeServer(patch.serverUrl) !== settings.serverUrl;
    settings = { ...settings, ...patch };
    if (patch.serverUrl !== undefined) settings.serverUrl = normalizeServer(patch.serverUrl);
    await saveSettings(settings);
    if (serverChanged && auth) await doSignOut();
    render();
}

// ------------------------------------------------------------------ user input
function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
    updateComposer();
}

function submit() {
    const text = input.value.trim();
    if (!text || !me || !me.usage.can_send) return;
    if (!busy && title === 'New task') { title = text.slice(0, 80); renderHeader(); }
    void runner.send(text);
    input.value = '';
    autosize();
}

input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
});
$('composer').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
$('stop').addEventListener('click', () => runner.stop());
$('new-task').addEventListener('click', async () => {
    await runner.newSession();
    title = 'New task';
    planBlocked = '';
    empty(); renderHeader(); renderBanner(); updateComposer(); input.focus();
});
$('plan').addEventListener('click', () => link(me?.usage.plan ? 'billing' : 'pricing'));
$('settings-btn').addEventListener('click', openSettings);
$('history-btn').addEventListener('click', () => void openHistory());
modeSel.addEventListener('change', () => { void updateSettings({ mode: modeSel.value as Mode }); });
modelSel.addEventListener('change', () => { renderEfforts(); void updateSettings({ model: modelSel.value }); });
effortSel.addEventListener('change', () => { void updateSettings({ effort: effortSel.value }); });
wireRequestCards(log, (id, r) => runner.answer(id, r));

document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('modal').classList.contains('hidden')) closeModal();
    else if (busy) runner.stop();
});

document.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act) e.preventDefault();
    switch (act) {
        case 'signIn': void startSignIn(); break;
        case 'consent': await updateSettings({ consent: CONSENT_VERSION }); if (!log.children.length) empty(); input.focus(); break;
        case 'cancelSignIn': signIn?.abort.abort(); break;
        case 'reopen': if (signIn) openUrl(signIn.url); break;
        case 'saveServer': await updateSettings({ serverUrl: ($('server-url') as HTMLInputElement).value }); break;
        case 'terms': link('terms'); break;
        case 'privacy': link('privacy'); break;
        case 'pricing': link('pricing'); break;
        case 'billing': link('billing'); break;
        case 'shortcuts': openUrl('chrome://extensions/shortcuts'); break;
        case 'refreshPlan': void refreshMe(); break;
        case 'closeModal': closeModal(); break;
        case 'signOut': closeModal(); void doSignOut(); break;
        case 'saveSettings':
            await updateSettings({
                mode: ($('set-mode') as HTMLSelectElement).value as Mode,
                stepLimit: normalizeStepLimit(($('set-steps') as HTMLInputElement).value),
                blockedSites: normalizeSites(($('set-blocked') as HTMLTextAreaElement).value),
                serverUrl: ($('set-server') as HTMLInputElement).value,
            });
            closeModal();
            break;
    }

    const idea = t.closest<HTMLElement>('[data-idea]')?.dataset.idea;
    if (idea) { input.value = idea; autosize(); input.focus(); }

    const del = t.closest<HTMLElement>('[data-del]')?.dataset.del;
    if (del) {
        e.stopPropagation();
        await deleteSession(del);
        if (del === runner.session.id && !busy) { await runner.newSession(); title = 'New task'; empty(); renderHeader(); }
        void openHistory();
        return;
    }
    const sid = t.closest<HTMLElement>('[data-session]')?.dataset.session;
    if (sid) {
        if (busy) { addNotice('Stop the current task before opening another one.'); closeModal(); return; }
        const s = await loadSession(sid);
        closeModal();
        if (s) { await runner.loadSession(s); title = s.title; renderTranscript(s.messages); renderHeader(); updateComposer(); }
    }

    const shot = t.closest<HTMLElement>('.shot img') as HTMLImageElement | null;
    if (shot) {
        $('modal').innerHTML = `<div class="zoom" data-act="closeModal"><img src="${esc(shot.src)}" alt="What Brisqal saw"></div>`;
        $('modal').classList.remove('hidden');
    }
    if (t.id === 'modal') closeModal();
});

// Live elapsed time on running steps.
setInterval(() => {
    document.querySelectorAll<HTMLElement>('.elapsed[data-since]').forEach((el) => {
        const s = Math.floor((Date.now() - Number(el.dataset.since)) / 1000);
        el.textContent = s >= 2 ? `${s}s` : '';
    });
}, 1000);

// The stop shortcut (handled by the service worker, which forwards it here).
chrome.runtime.onMessage.addListener((m) => {
    if (m?.type === 'brisqal:stop' && busy) runner.stop();
});

// ------------------------------------------------------------------ start
async function detectPlatform() {
    const info = await chrome.runtime.getPlatformInfo();
    const os = ({ mac: 'mac', win: 'windows', linux: 'linux', cros: 'chromeos' } as Record<string, typeof platform.os>)[info.os] ?? 'other';
    const brands: { brand: string; version: string }[] = (navigator as any).userAgentData?.brands ?? [];
    // The first real browser brand (not "Chromium" or the GREASE "Not…Brand" entry).
    const b = brands.find((x) => !/chromium|not.?a.?brand|^not/i.test(x.brand));
    platform = { os, browser: b ? `${b.brand} ${b.version}` : 'Chrome' };
}

async function start() {
    const win = await chrome.windows.getCurrent();
    windowId = win.id ?? chrome.windows.WINDOW_ID_CURRENT;
    settings = await loadSettings();
    auth = await loadAuth();
    await detectPlatform();
    try {
        const stop = (await chrome.commands.getAll()).find((c) => c.name === 'stop-task');
        stopShortcut = stop?.shortcut ?? '';
    } catch { /* not available */ }

    runner = new Runner({
        api,
        windowId: () => windowId,
        settings: () => settings,
        setMode: (m) => { void updateSettings({ mode: m }); },
        me: () => me,
        updateUsage: (u: PlanStatus) => { if (me) { me.usage = u; renderHeader(); renderBanner(); updateComposer(); } },
        emit: onEvent,
        platform,
    });

    chrome.tabs.onActivated.addListener((info) => { if (info.windowId === windowId) void followActiveTab(); });
    chrome.tabs.onUpdated.addListener((_id, info, tab) => {
        if (tab.windowId !== windowId || !tab.active || !(info.title || info.url || info.favIconUrl || info.status)) return;
        if (busy) { if (tab.id === runner.host.tabId) { shownTab = { id: tab.id, title: tab.title, url: tab.url, favIconUrl: tab.favIconUrl }; renderTabChip(); } }
        else void followActiveTab();
    });

    authState = auth ? 'signedIn' : 'signedOut';
    render();
    void followActiveTab();
    if (auth) {
        await refreshMe();
        if (authState === 'signedIn') empty();
    }
    input.focus();

    if (__TEST__) {
        (globalThis as any).__brisqalTest = {
            runner, api, events: testEvents,
            get host() { return runner.host; },
            settings: () => settings,
            update: updateSettings,
            setMe: (m: MeResponse) => { me = m; authState = 'signedIn'; render(); },
            useTab: (id: number) => { runner.host.tabId = id; },
            useWindow: (id: number) => { windowId = id; },
        };
    }
}

void start();
