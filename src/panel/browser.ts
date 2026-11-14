/**
 * The tools the agent uses in Chrome. Reading the page goes through the injected page script;
 * mouse, keyboard and screenshots go through the debugger protocol (trusted input that sites treat
 * like the user's), with a plain-script fallback when the debugger can't be attached.
 *
 * Like a person: Brisqal's own cursor glides to each target before it clicks, and the tabs it
 * works in sit in a "Brisqal" tab group.
 *
 * Cost and speed: after an action the model gets a short text report of what changed (new text,
 * dialogs, the element's new state). A screenshot follows only when the page changed a lot (a new
 * page, a dialog, many new elements), after coordinate-based actions, or when the model asks.
 * Instead of fixed delays, actions wait until the page is quiet.
 */
import type { PageApi } from '../content/page';
import { PAGE_VERSION } from '../content/version';
import type { Screenshot, ToolHost, ToolResult } from '../core/agent';
import type { ApiClient, ToolCall, ToolDefinition } from '../core/api';
import { keyEvents, modifierBits, parseCombo } from '../core/keys';
import type { Mode } from '../core/prompt';
import { toolDefinitions } from '../core/tools';
import { blockedBy, normalizeTarget, uncontrollableReason } from '../core/urls';
import { Debugger } from './cdp';

export type Decision = 'allow' | 'always' | 'deny';

export interface HostDeps {
    api: ApiClient;
    windowId: () => number;
    mode: () => Mode;
    setMode: (m: Mode) => void;
    blockedSites: () => string[];
    webSearch: () => boolean;
    platform: 'mac' | 'other';
    approve: (title: string, detail: string) => Promise<{ decision: Decision; feedback?: string }>;
    ask: (question: string, options: string[]) => Promise<string>;
    tabChanged: (tab: chrome.tabs.Tab | null) => void;
}

/** Screenshots: at most 1024×768 (never more than the page's CSS size), JPEG. About 800-1,000 tokens each. */
export const SHOT = { width: 1024, height: 768, quality: 0.7 };
const PAGE_MAX_CHARS = 6000;
const TEXT_MAX_CHARS = 8000;
const GROUP_TITLE = 'Brisqal';

type Geometry = { tabId: number; cssW: number; cssH: number; imgW: number; imgH: number };
type Point = { x: number; y: number };
type Located = { x: number; y: number; covered?: string; desc: string; sensitive?: string };
type Report = { text: string[]; opened: string[]; closed: number; big: boolean };
type ActResult = { note: string; observe: boolean; navigated: boolean; quiet: boolean };

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
    if (ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});
const clip = (s: unknown, n = 60) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const num = (v: unknown) => (typeof v === 'number' ? v : v === undefined || v === null || v === '' ? NaN : Number(v));
const has = (v: unknown) => v !== undefined && v !== null && v !== '';
const BUTTONS: Record<string, number> = { left: 1, right: 2, middle: 4 };
const timeout = <T>(p: Promise<T>, ms: number): Promise<T | null> => Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);

class ToolError extends Error {}

export class BrowserHost implements ToolHost {
    readonly dbg = new Debugger();
    /** The tab the agent works in. */
    tabId: number | null = null;
    private opened = new Set<number>();
    private touched = new Set<number>();
    private geometry: Geometry | null = null;
    private notes: string[] = [];
    /** Where Brisqal's cursor is in each tab (restored after a page load). */
    private cursor = new Map<number, Point>();
    private groupId: number | null = null;
    /** The user's own tabs put into the Brisqal group for this task (taken out again at the end). */
    private ungroupAtEnd = new Set<number>();

    constructor(private readonly d: HostDeps) {}

    definitions(): ToolDefinition[] {
        return toolDefinitions({ webSearch: this.d.webSearch() });
    }

    addNote(text: string) {
        this.notes.push(text);
    }

    takeNotes(): string[] {
        return this.notes.splice(0);
    }

    /** A task starts in the tab the user is looking at. */
    async begin() {
        const [tab] = await chrome.tabs.query({ active: true, windowId: this.d.windowId() });
        this.tabId = tab?.id ?? null;
        this.geometry = null;
        this.d.tabChanged(tab ?? null);
        if (tab?.id !== undefined && !uncontrollableReason(tab.url)) await this.joinGroup(tab.id, true);
    }

    /** One line about the tab the task starts in (so the model knows where it is without a first look). */
    async currentTabLine(): Promise<string> {
        if (this.tabId === null) return 'none';
        const t = await chrome.tabs.get(this.tabId).catch(() => null);
        return t ? tabLine(t) : 'none';
    }

    /** Task over: remove the border and cursor, let go of the debugger (Chrome's "controlled" bar goes away). */
    async end() {
        for (const t of this.touched) {
            try { await this.page(t, 'overlay', false); } catch { /* closed or navigated away */ }
        }
        this.touched.clear();
        this.cursor.clear();
        this.notes = [];
        const mine = [...this.ungroupAtEnd];
        this.ungroupAtEnd.clear();
        if (mine.length) {
            const still = (await Promise.all(mine.map((id) => chrome.tabs.get(id).catch(() => null))))
                .filter((t): t is chrome.tabs.Tab => !!t && t.groupId === this.groupId).map((t) => t.id!);
            if (still.length) await chrome.tabs.ungroup(still).catch(() => undefined);
        }
        await this.dbg.detachAll();
    }

    /** Put a tab into the "Brisqal" tab group (never a pinned tab, never one in the user's own group). */
    private async joinGroup(tabId: number, usersTab: boolean) {
        try {
            const t = await chrome.tabs.get(tabId);
            if (t.pinned || (t.groupId !== -1 && t.groupId !== this.groupId)) return;
            if (this.groupId !== null && t.groupId === this.groupId) return;
            if (this.groupId === null) {
                const [g] = await chrome.tabGroups.query({ windowId: t.windowId, title: GROUP_TITLE });
                this.groupId = g?.id ?? null;
            }
            try {
                this.groupId = await chrome.tabs.group(this.groupId !== null ? { tabIds: tabId, groupId: this.groupId } : { tabIds: tabId, createProperties: { windowId: t.windowId } });
            } catch {
                // The old group was closed: start a new one.
                this.groupId = await chrome.tabs.group({ tabIds: tabId, createProperties: { windowId: t.windowId } });
            }
            await chrome.tabGroups.update(this.groupId, { title: GROUP_TITLE, color: 'purple' });
            if (usersTab) this.ungroupAtEnd.add(tabId);
        } catch { /* tab groups unavailable: not essential */ }
    }

    // ------------------------------------------------------------------ tabs and pages

    private async currentTab(): Promise<chrome.tabs.Tab> {
        if (this.tabId !== null) {
            try { return await chrome.tabs.get(this.tabId); } catch { /* the tab was closed */ }
        }
        const [tab] = await chrome.tabs.query({ active: true, windowId: this.d.windowId() });
        const lost = this.tabId !== null;
        this.tabId = tab?.id ?? null;
        this.d.tabChanged(tab ?? null);
        if (!tab?.id) throw new ToolError('There is no tab to work in. Use tabs with action "open".');
        if (lost) throw new ToolError(`The tab Brisqal was working in was closed. The current tab is now ${tabLine(tab)}.`);
        return tab;
    }

    /** The current tab, if Brisqal may read and control it. */
    private async controllable(): Promise<chrome.tabs.Tab & { id: number }> {
        const tab = await this.currentTab();
        const why = uncontrollableReason(tab.url);
        if (why) throw new ToolError(`${why} Use navigate to open a website in this tab.`);
        const blocked = blockedBy(tab.url!, this.d.blockedSites());
        if (blocked) throw new ToolError(`${blocked} is on the user's list of blocked sites, so Brisqal can't read or use this page. Tell the user, or go to another site.`);
        return tab as chrome.tabs.Tab & { id: number };
    }

    /** Bring the tab to the front (screenshots and input need it visible) with the border and cursor. */
    private async front(tab: chrome.tabs.Tab & { id: number }) {
        if (!tab.active) {
            await chrome.tabs.update(tab.id, { active: true });
            await sleep(120);
        }
        this.touched.add(tab.id);
        try { await this.page(tab.id, 'overlay', true, this.cursor.get(tab.id) ?? null); } catch { /* not scriptable: no border */ }
    }

    /** Call a function of the injected page script (injecting it first when needed). */
    private async page<K extends keyof PageApi>(tabId: number, name: K, ...args: Parameters<Extract<PageApi[K], (...a: any) => any>>): Promise<Awaited<ReturnType<Extract<PageApi[K], (...a: any) => any>>>> {
        const call = async () => {
            const [r] = await chrome.scripting.executeScript({
                target: { tabId, frameIds: [0] },
                // async: the page functions that wait (screenshots, change reports) return promises.
                func: async (n: string, a: unknown[], v: number) => {
                    const b = (globalThis as any).__brisqal;
                    return b && b.version === v ? { ok: true, v: await b[n](...a) } : { ok: false };
                },
                args: [name, args, PAGE_VERSION],
            });
            return r?.result as { ok: boolean; v?: any } | undefined;
        };
        try {
            let r = await call();
            if (!r?.ok) {
                await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['content.js'] });
                r = await call();
            }
            if (!r?.ok) throw new ToolError('Couldn\'t read this page. Try again in a moment, or reload it.');
            return r.v;
        } catch (e: any) {
            throw new ToolError(scriptingError(e));
        }
    }

    private async debuggerOn(tabId: number): Promise<boolean> {
        if (this.dbg.isAttached(tabId)) return true;
        const ok = await this.dbg.attach(tabId);
        if (ok) {
            // The page behaves as if it had focus even while the user types in the side panel.
            try { await this.dbg.send(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }); } catch { /* older Chrome */ }
        }
        return ok;
    }

    // ------------------------------------------------------------------ screenshots

    async screenshot(signal: AbortSignal): Promise<Screenshot | null> {
        if (signal.aborted) return null;
        let tab: chrome.tabs.Tab & { id: number };
        try { tab = await this.controllable(); } catch { return null; }
        return this.capture(tab);
    }

    private async capture(tab: chrome.tabs.Tab & { id: number }): Promise<Screenshot> {
        await this.front(tab);
        const vp = await this.page(tab.id, 'viewport');
        // The border and cursor are hidden for the shot: the model sees the page itself.
        try { await this.page(tab.id, 'captureMode', true); } catch { /* fine */ }
        let b64: string;
        try {
            if (await this.debuggerOn(tab.id)) {
                b64 = (await this.dbg.send<{ data: string }>(tab.id, 'Page.captureScreenshot', { format: 'jpeg', quality: 85, fromSurface: true, captureBeyondViewport: false })).data;
            } else {
                b64 = (await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 85 })).split(',')[1];
            }
        } finally {
            try { await this.page(tab.id, 'captureMode', false); } catch { /* fine */ }
        }
        const ratio = Math.min(1, SHOT.width / vp.width, SHOT.height / vp.height);
        const w = Math.max(1, Math.round(vp.width * ratio)), h = Math.max(1, Math.round(vp.height * ratio));
        const bmp = await createImageBitmap(new Blob([base64ToBytes(b64)], { type: 'image/jpeg' }));
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext('2d')!;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bmp, 0, 0, w, h);
        bmp.close();
        const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: SHOT.quality });
        const dataUrl = `data:image/jpeg;base64,${bytesToBase64(new Uint8Array(await blob.arrayBuffer()))}`;
        this.geometry = { tabId: tab.id, cssW: vp.width, cssH: vp.height, imgW: w, imgH: h };
        return { dataUrl, width: w, height: h, caption: `${clip(vp.title, 80) || 'untitled'} (${clip(vp.url, 140)})` };
    }

    /** Screenshot coordinates → page (CSS) coordinates. */
    private toCss(tabId: number, x: unknown, y: unknown): Point {
        const g = this.geometry;
        if (!g || g.tabId !== tabId) throw new ToolError('Take a screenshot first (or use a ref), so the coordinates match this tab.');
        const px = num(x), py = num(y);
        if (!Number.isFinite(px) || !Number.isFinite(py)) throw new ToolError('Give a ref, or x and y from the screenshot.');
        if (px < 0 || py < 0 || px >= g.imgW || py >= g.imgH) throw new ToolError(`(${px}, ${py}) is outside the screenshot (${g.imgW}×${g.imgH}).`);
        return { x: Math.round((px * g.cssW) / g.imgW), y: Math.round((py * g.cssH) / g.imgH) };
    }

    private async locate(tabId: number, ref: unknown, scroll = true): Promise<Located> {
        const r = num(ref);
        if (!Number.isInteger(r) || r <= 0) throw new ToolError('ref must be a number from read_page or find.');
        const loc: any = await this.page(tabId, 'locate', r, scroll);
        if (loc.error) throw new ToolError(loc.error);
        return loc;
    }

    /** A ref, or x/y from the screenshot → where to point the mouse. */
    private async target(tabId: number, a: any, refKey = 'ref', xKey = 'x', yKey = 'y'): Promise<Located> {
        if (has(a[refKey])) return this.locate(tabId, a[refKey]);
        const p = this.toCss(tabId, a[xKey], a[yKey]);
        return { ...p, desc: `the point (${a[xKey]}, ${a[yKey]})` };
    }

    private async describeRef(tabId: number, ref: unknown): Promise<string | null> {
        try { return await this.page(tabId, 'describeRef', num(ref)); } catch { return null; }
    }

    // ------------------------------------------------------------------ input (with the visible cursor)

    /** Glide Brisqal's cursor to the point, and wait for the glide. */
    private async moveCursor(tabId: number, p: Point) {
        this.cursor.set(tabId, { x: p.x, y: p.y });
        try {
            const { ms } = await this.page(tabId, 'cursorTo', p.x, p.y);
            await sleep(ms);
        } catch { /* no overlay on this page */ }
    }

    private async mouse(tabId: number, type: string, p: Point, extra: Record<string, unknown> = {}) {
        await this.dbg.send(tabId, 'Input.dispatchMouseEvent', { type, x: p.x, y: p.y, ...extra });
    }

    private async click(tabId: number, p: Point, button = 'left', clicks = 1, modifiers = 0) {
        await this.moveCursor(tabId, p);
        void this.page(tabId, 'cursorClick').catch(() => undefined);
        if (!(await this.debuggerOn(tabId))) {
            const r: any = await this.page(tabId, 'fallbackClick', p.x, p.y, clicks);
            if (r.error) throw new ToolError(r.error);
            return;
        }
        await this.mouse(tabId, 'mouseMoved', p, { modifiers });
        for (let i = 1; i <= clicks; i++) {
            await this.mouse(tabId, 'mousePressed', p, { button, clickCount: i, modifiers, buttons: BUTTONS[button] ?? 1 });
            await this.mouse(tabId, 'mouseReleased', p, { button, clickCount: i, modifiers, buttons: 0 });
        }
    }

    private async press(tabId: number, combo: string, times = 1) {
        const events = keyEvents(combo, this.d.platform);
        if (!(await this.debuggerOn(tabId))) {
            const { key } = parseCombo(combo, this.d.platform);
            for (let i = 0; i < times; i++) await this.page(tabId, 'fallbackKey', key.key);
            return;
        }
        for (let i = 0; i < times; i++) {
            for (const ev of events) await this.dbg.send(tabId, 'Input.dispatchKeyEvent', ev as any);
        }
    }

    private async typeText(tabId: number, text: string, editable: boolean) {
        const dbg = await this.debuggerOn(tabId);
        for (const part of text.split(/(\n|\t)/)) {
            if (part === '\n') { await this.press(tabId, 'Enter'); continue; }
            if (part === '\t') { await this.press(tabId, 'Tab'); continue; }
            if (!part) continue;
            if (!dbg) {
                const r: any = await this.page(tabId, 'fallbackType', part);
                if (r.sensitive) throw new ToolError(refusal(r.sensitive));
                if (r.error) throw new ToolError(r.error);
            } else if (editable) {
                await this.dbg.send(tabId, 'Input.insertText', { text: part });
            } else {
                // Not a text field (canvas apps, games, custom editors): send real key presses.
                for (const ch of part.slice(0, 500)) {
                    await this.dbg.send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch });
                    await this.dbg.send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
                }
            }
        }
    }

    /**
     * Run an action and wait for its effects (until the page is quiet, a page load it started has
     * finished, or a tab it opened has loaded; that tab then becomes the current tab). Returns a
     * short report for the model, and whether the page changed enough to need a screenshot.
     */
    private async act(tab: chrome.tabs.Tab & { id: number }, fn: () => Promise<void>, signal: AbortSignal): Promise<ActResult> {
        const created: chrome.tabs.Tab[] = [];
        let started = false;
        const onCreated = (t: chrome.tabs.Tab) => { if (t.openerTabId === tab.id) created.push(t); };
        const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo) => { if (id === tab.id && (info.status === 'loading' || info.url)) started = true; };
        chrome.tabs.onCreated.addListener(onCreated);
        chrome.tabs.onUpdated.addListener(onUpdated);
        let watching = false;
        let report: Report | null = null;
        try {
            try { await this.page(tab.id, 'watchStart'); watching = true; } catch { /* not scriptable */ }
            await fn();
            await sleep(60, signal);
            if (watching && !started) report = await timeout(this.page(tab.id, 'watchReport', 1500).catch(() => null), 2500) as Report | null;
            if (started) await waitForLoad(tab.id, 15000, signal);
            if (created.length) await sleep(250, signal);
        } finally {
            chrome.tabs.onCreated.removeListener(onCreated);
            chrome.tabs.onUpdated.removeListener(onUpdated);
        }
        const opened = created[0];
        if (opened?.id !== undefined) {
            this.opened.add(opened.id);
            const now = await chrome.tabs.get(opened.id).catch(() => opened);
            if (now.active) {
                await waitForLoad(opened.id, 15000, signal);
                this.tabId = opened.id;
                this.geometry = null;
                const loaded = await chrome.tabs.get(opened.id).catch(() => now);
                this.d.tabChanged(loaded);
                await this.joinGroup(opened.id, false);
                return { note: ` It opened a new tab, which is now the current tab: ${tabLine(loaded)}.`, observe: true, navigated: true, quiet: false };
            }
            await this.joinGroup(opened.id, false);
            return { note: ` It opened a tab in the background (tab ${opened.id}). Use tabs to switch to it.`, observe: false, navigated: false, quiet: false };
        }
        if (started) {
            const t = await chrome.tabs.get(tab.id).catch(() => null);
            this.geometry = null;
            if (t) this.d.tabChanged(t);
            return { note: t ? ` The page is now ${tabLine(t)}.` : '', observe: true, navigated: true, quiet: false };
        }
        if (!report) return { note: '', observe: false, navigated: false, quiet: false };
        const parts: string[] = [];
        if (report.opened.length) parts.push(`A dialog opened: ${report.opened.map((n) => `“${clip(n, 60)}”`).join(', ')}.`);
        if (report.closed) parts.push(report.closed === 1 ? 'A dialog closed.' : `${report.closed} dialogs closed.`);
        if (report.text.length) parts.push(`New on the page: ${report.text.map((t) => `“${t}”`).join(' · ')}`);
        return { note: parts.length ? ' ' + parts.join(' ') : '', observe: report.big, navigated: false, quiet: !parts.length };
    }

    private async approve(title: string, detail: string): Promise<ToolResult | null> {
        if (this.d.mode() !== 'ask') return null;
        const r = await this.d.approve(title, detail);
        if (r.decision === 'deny') {
            return { output: `The user declined: ${detail}.${r.feedback ? ` They said: ${r.feedback}` : ' Ask what they would like instead, or continue another way.'}`, isError: true };
        }
        if (r.decision === 'always') this.d.setMode('balanced');
        return null;
    }

    private checkUrl(url: string) {
        const blocked = blockedBy(url, this.d.blockedSites());
        if (blocked) throw new ToolError(`${blocked} is on the user's list of blocked sites, so Brisqal won't open it.`);
    }

    // ------------------------------------------------------------------ ToolHost.execute

    async execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
        let a: any;
        try {
            a = JSON.parse(call.function.arguments || '{}') ?? {};
        } catch {
            return { output: 'Error: the action\'s arguments were not valid JSON.', isError: true };
        }
        try {
            return await this.run(call.function.name, a, signal);
        } catch (e: any) {
            if (e?.name === 'AbortError' || signal.aborted) throw e;
            return { output: `Error: ${e?.message || String(e)}`, isError: true };
        }
    }

    private async run(name: string, a: any, signal: AbortSignal): Promise<ToolResult> {
        switch (name) {
            case 'computer': return this.computer(a, signal);
            case 'read_page': {
                const tab = await this.controllable();
                const r: any = await this.page(tab.id, 'snapshot', { filter: a.filter === 'all' ? 'all' : 'interactive', ref: a.ref ? num(a.ref) : undefined, maxChars: PAGE_MAX_CHARS });
                if (r.error) throw new ToolError(r.error);
                this.touched.add(tab.id);
                return { output: r.text };
            }
            case 'find': {
                const tab = await this.controllable();
                const r: any = await this.page(tab.id, 'find', String(a.query ?? ''), 10);
                if (r.error) throw new ToolError(r.error);
                return { output: r.text };
            }
            case 'get_page_text': {
                const tab = await this.controllable();
                const r: any = await this.page(tab.id, 'text', Math.max(0, num(a.offset) || 0), TEXT_MAX_CHARS);
                return { output: r.text };
            }
            case 'form_input': {
                const tab = await this.controllable();
                await this.front(tab);
                const loc = await this.locate(tab.id, a.ref);
                if (loc.sensitive) return { output: refusal(loc.sensitive), isError: true };
                const label = `Set ${loc.desc} to “${clip(a.value, 60)}”`;
                const no = await this.approve(`${label}?`, label);
                if (no) return no;
                await this.moveCursor(tab.id, loc);
                let r: any;
                const res = await this.act(tab, async () => { r = await this.page(tab.id, 'setValue', num(a.ref), a.value); }, signal);
                if (r.sensitive) return { output: refusal(r.sensitive), isError: true };
                if (r.error) throw new ToolError(r.error);
                return { output: `${r.message}${res.note}`, observe: res.observe, label: formLabel(loc.desc, a.value, r.message) };
            }
            case 'navigate': {
                const target = normalizeTarget(String(a.url ?? ''));
                if (target.kind === 'error') throw new ToolError(target.message);
                const tab = await this.currentTab();
                if (target.kind === 'url') this.checkUrl(target.url);
                const label = target.kind === 'url' ? `Open ${target.url}` : `Go ${target.action === 'reload' ? 'reload the page' : target.action}`;
                const no = await this.approve(`${label}?`, label);
                if (no) return no;
                const id = tab.id!;
                if (!tab.active) await chrome.tabs.update(id, { active: true });
                if (target.kind === 'url') await chrome.tabs.update(id, { url: target.url });
                else if (target.action === 'back') await chrome.tabs.goBack(id).catch(() => { throw new ToolError('There is no previous page in this tab.'); });
                else if (target.action === 'forward') await chrome.tabs.goForward(id).catch(() => { throw new ToolError('There is no next page in this tab.'); });
                else await chrome.tabs.reload(id);
                await sleep(250, signal);
                await waitForLoad(id, 20000, signal);
                this.geometry = null;
                const now = await chrome.tabs.get(id);
                this.d.tabChanged(now);
                if (!uncontrollableReason(now.url)) await this.joinGroup(id, !this.opened.has(id));
                return { output: `Opened ${tabLine(now)}.${now.url && uncontrollableReason(now.url) ? ' (Brisqal can\'t read or control this kind of page.)' : ''}`, observe: true };
            }
            case 'tabs': return this.tabs(a, signal);
            case 'read_webpage': {
                const r = await this.d.api.readWebpage(String(a.url ?? ''), signal);
                return { output: `Page: ${r.title}\nURL: ${r.url}\n\n${r.text}` };
            }
            case 'web_search': return { output: (await this.d.api.webSearch(String(a.query ?? ''), signal)).content };
            case 'ask_user': {
                const options = Array.isArray(a.options) ? a.options.map(String).filter(Boolean).slice(0, 6) : [];
                const reply = await this.d.ask(String(a.question ?? ''), options);
                if (signal.aborted) return { output: 'Cancelled by the user.', isError: true };
                // The user may have done something in the page (signed in, typed a code): look again.
                return { output: reply ? `The user answered: ${reply}` : 'The user did not answer.', observe: true };
            }
            default:
                return { output: `Error: unknown tool ${name}`, isError: true };
        }
    }

    /** The computer tool: mouse and keyboard, like a person. */
    private async computer(a: any, signal: AbortSignal): Promise<ToolResult> {
        const action = String(a.action ?? '');
        switch (action) {
            case 'screenshot': {
                const tab = await this.controllable();
                const shot = await this.capture(tab);
                return { output: `Screenshot of ${shot.caption}: ${shot.width}×${shot.height} px.`, image: shot };
            }
            case 'left_click': case 'double_click': case 'triple_click': case 'right_click': {
                const tab = await this.controllable();
                await this.front(tab);
                const t = await this.target(tab.id, a);
                const clicks = action === 'double_click' ? 2 : action === 'triple_click' ? 3 : 1;
                const button = action === 'right_click' ? 'right' : 'left';
                const mods = modifierBits(a.modifiers, this.d.platform);
                const verb = `${clicks === 2 ? 'Double-click' : clicks === 3 ? 'Triple-click' : button === 'right' ? 'Right-click' : 'Click'} ${t.desc}`;
                const no = await this.approve(`${verb}?`, verb);
                if (no) return no;
                const before = has(a.ref) ? await this.describeRef(tab.id, a.ref) : null;
                const res = await this.act(tab, () => this.click(tab.id, t, button, clicks, mods), signal);
                const after = has(a.ref) && !res.navigated ? await this.describeRef(tab.id, a.ref) : null;
                const state = after && after !== before ? ` It is now: ${after}.` : '';
                const warn = t.covered ? ` Note: ${t.covered} was on top of it, so the click may have landed there instead. Close it first if it is a pop-up.` : '';
                const nothing = res.quiet && !state && !warn ? ' No visible change on the page.' : '';
                return {
                    output: `Done: ${verb[0].toLowerCase()}${verb.slice(1)}.${warn}${state}${res.note}${nothing}`,
                    // Working by coordinates is visual work: show the result.
                    observe: res.observe || !has(a.ref),
                    label: verb,
                };
            }
            case 'hover': {
                const tab = await this.controllable();
                await this.front(tab);
                const t = await this.target(tab.id, a);
                const res = await this.act(tab, async () => {
                    await this.moveCursor(tab.id, t);
                    if (await this.debuggerOn(tab.id)) await this.mouse(tab.id, 'mouseMoved', t);
                    await sleep(250, signal);
                }, signal);
                return { output: `The mouse is over ${t.desc}.${res.note}`, observe: res.observe || !has(a.ref), label: `Point at ${t.desc}` };
            }
            case 'drag': {
                const tab = await this.controllable();
                await this.front(tab);
                const from = await this.target(tab.id, a);
                const to = await this.target(tab.id, a, 'to_ref', 'to_x', 'to_y');
                const label = `Drag ${from.desc} to ${to.desc}`;
                const no = await this.approve(`${label}?`, label);
                if (no) return no;
                if (!(await this.debuggerOn(tab.id))) throw new ToolError(`Dragging needs the browser control that Chrome refused: ${this.dbg.lastError}`);
                const res = await this.act(tab, async () => {
                    await this.moveCursor(tab.id, from);
                    await this.mouse(tab.id, 'mouseMoved', from);
                    await this.mouse(tab.id, 'mousePressed', from, { button: 'left', clickCount: 1, buttons: 1 });
                    void this.page(tab.id, 'cursorTo', to.x, to.y).catch(() => undefined);
                    for (let i = 1; i <= 10; i++) {
                        await this.mouse(tab.id, 'mouseMoved', { x: Math.round(from.x + ((to.x - from.x) * i) / 10), y: Math.round(from.y + ((to.y - from.y) * i) / 10) }, { buttons: 1 });
                        await sleep(25);
                    }
                    this.cursor.set(tab.id, { x: to.x, y: to.y });
                    await this.mouse(tab.id, 'mouseReleased', to, { button: 'left', clickCount: 1, buttons: 0 });
                }, signal);
                return { output: `Dragged ${from.desc} to ${to.desc}.${res.note}`, observe: true, label };
            }
            case 'type': {
                if (typeof a.text !== 'string') throw new ToolError('type needs text.');
                const tab = await this.controllable();
                await this.front(tab);
                let loc: Located | null = null;
                if (has(a.ref)) {
                    loc = await this.locate(tab.id, a.ref);
                    if (loc.sensitive) return { output: refusal(loc.sensitive), isError: true };
                } else {
                    const f: any = await this.page(tab.id, 'focusInfo');
                    if (f.sensitive) return { output: refusal(f.sensitive), isError: true };
                }
                const shown = clip(a.text.replace(/\n/g, '⏎'), 80);
                const label = `Type “${shown}”${loc ? ` into ${loc.desc}` : ''}`;
                const no = await this.approve(`${label}?`, label);
                if (no) return no;
                let prep: any;
                const res = await this.act(tab, async () => {
                    if (loc) await this.click(tab.id, loc);
                    prep = await this.page(tab.id, 'prepareTyping', loc ? num(a.ref) : null, !!a.clear);
                    if (prep.error) throw new ToolError(prep.error);
                    if (prep.sensitive) throw new ToolError(refusal(prep.sensitive));
                    await this.typeText(tab.id, a.text, !!prep.editable);
                }, signal);
                let value = '';
                if (!res.navigated) {
                    try {
                        const f: any = await this.page(this.tabId ?? tab.id, 'focusInfo');
                        if (typeof f.value === 'string') value = ` The field now contains “${clip(f.value, 200)}”.`;
                    } catch { /* navigated */ }
                }
                const into = prep?.desc && prep.desc !== 'nothing' ? ` into ${prep.desc}` : '';
                return { output: `Typed “${shown}”${into}.${value}${res.note}`, observe: res.observe, label: `Type “${clip(a.text.replace(/\n/g, '⏎'), 40)}”${into}` };
            }
            case 'key': {
                const keys = String(a.keys ?? a.text ?? '').trim();
                parseCombo(keys, this.d.platform); // validates (throws a helpful message)
                const times = Math.min(20, Math.max(1, Math.floor(num(a.repeat)) || 1));
                const tab = await this.controllable();
                await this.front(tab);
                const label = `Press ${keys}${times > 1 ? ` ${times} times` : ''}`;
                const no = await this.approve(`${label}?`, label);
                if (no) return no;
                const res = await this.act(tab, () => this.press(tab.id, keys, times), signal);
                return { output: `Pressed ${keys}${times > 1 ? ` ${times} times` : ''}.${res.note}`, observe: res.observe, label };
            }
            case 'scroll_to': {
                if (!has(a.ref)) throw new ToolError('scroll_to needs a ref.');
                const tab = await this.controllable();
                await this.front(tab);
                const r: any = await this.page(tab.id, 'scrollIntoView', num(a.ref));
                if (r.error) throw new ToolError(r.error);
                await sleep(200, signal);
                return { output: r.message + (await this.position(tab.id)), observe: true };
            }
            case 'scroll': {
                const tab = await this.controllable();
                await this.front(tab);
                if (has(a.ref) && !a.direction) return this.computer({ ...a, action: 'scroll_to' }, signal);
                const dir = ['up', 'down', 'left', 'right'].includes(a.direction) ? a.direction : 'down';
                const vp: any = await this.page(tab.id, 'viewport');
                const amount = Math.min(20, Math.max(0.1, num(a.amount) || 0.8));
                const dist = Math.round(amount * (dir === 'left' || dir === 'right' ? vp.width : vp.height));
                const dx = dir === 'left' ? -dist : dir === 'right' ? dist : 0, dy = dir === 'up' ? -dist : dir === 'down' ? dist : 0;
                const at = has(a.ref) || has(a.x);
                const p: Point = has(a.ref) ? await this.locate(tab.id, a.ref, false)
                    : has(a.x) ? this.toCss(tab.id, a.x, a.y) : { x: Math.round(vp.width / 2), y: Math.round(vp.height / 2) };
                if (at) await this.moveCursor(tab.id, p);
                if (await this.debuggerOn(tab.id)) await this.mouse(tab.id, 'mouseWheel', p, { deltaX: dx, deltaY: dy });
                else await this.page(tab.id, 'fallbackScroll', dx, dy, p.x, p.y);
                await sleep(350, signal);
                const now: any = await this.page(tab.id, 'viewport');
                const moved = now.scrollY !== vp.scrollY || now.scrollX !== vp.scrollX;
                const where = moved ? await this.position(tab.id) : at
                    ? ' The page itself didn\'t move; check the screenshot to see whether that part of the page scrolled.'
                    : ` The page didn't move: it is already at the ${dir === 'up' ? 'top' : dir === 'down' ? 'bottom' : 'edge'}, or the content scrolls inside a panel (scroll at a ref or point in it).`;
                return { output: `Scrolled ${dir}.${where}`, observe: moved || at };
            }
            case 'wait': {
                const secs = Math.min(30, Math.max(0.2, num(a.seconds) || (a.for_text ? 10 : 2)));
                if (a.for_text) {
                    const tab = await this.controllable();
                    const until = Date.now() + secs * 1000;
                    while (Date.now() < until && !signal.aborted) {
                        try { if (await this.page(tab.id, 'hasText', String(a.for_text))) return { output: `“${clip(a.for_text)}” is on the page now.` }; } catch { /* page loading */ }
                        await sleep(400, signal);
                    }
                    return { output: `“${clip(a.for_text)}” didn't appear within ${secs} s.`, observe: true };
                }
                await sleep(secs * 1000, signal);
                return { output: `Waited ${secs} s.`, observe: true };
            }
            default:
                throw new ToolError(`Unknown computer action "${action}". Use one of: left_click, double_click, triple_click, right_click, hover, drag, type, key, scroll, scroll_to, wait, screenshot.`);
        }
    }

    private async position(tabId: number): Promise<string> {
        const v: any = await this.page(tabId, 'viewport');
        if (v.docHeight <= v.height + 2) return '';
        const pct = Math.round((v.scrollY / (v.docHeight - v.height)) * 100);
        return ` Now ${Math.max(0, Math.min(100, pct))}% down the page.`;
    }

    private async tabs(a: any, signal: AbortSignal): Promise<ToolResult> {
        const windowId = this.d.windowId();
        switch (a.action) {
            case 'list': {
                const tabs = await chrome.tabs.query({ windowId });
                const lines = tabs.map((t) => `${t.id} · ${clip(t.title, 70) || 'untitled'} · ${clip(t.url, 100)}${t.id === this.tabId ? ' (current)' : ''}${t.active && t.id !== this.tabId ? ' (on screen)' : ''}${this.opened.has(t.id!) ? ' (opened by Brisqal)' : ''}`);
                return { output: lines.join('\n') || 'No tabs.' };
            }
            case 'open': {
                const target = normalizeTarget(String(a.url ?? '') || 'about:blank');
                if (target.kind === 'error' && a.url) throw new ToolError(target.message);
                const url = target.kind === 'url' ? target.url : undefined;
                if (url) this.checkUrl(url);
                const label = `Open a new tab${url ? ` with ${url}` : ''}`;
                const no = await this.approve(`${label}?`, label);
                if (no) return no;
                const t = await chrome.tabs.create({ windowId, url, active: true });
                this.opened.add(t.id!);
                this.tabId = t.id!;
                this.geometry = null;
                await this.joinGroup(t.id!, false);
                await sleep(250, signal);
                if (url) await waitForLoad(t.id!, 20000, signal);
                const now = await chrome.tabs.get(t.id!);
                this.d.tabChanged(now);
                return { output: `Opened a new tab, now the current tab: ${tabLine(now)}.`, observe: !!url };
            }
            case 'switch': {
                const id = Math.floor(num(a.tab_id));
                const t = await chrome.tabs.get(id).catch(() => null);
                if (!t || t.windowId !== windowId) throw new ToolError(`There is no tab ${a.tab_id} in this window. Use tabs with action "list".`);
                await chrome.tabs.update(id, { active: true });
                this.tabId = id;
                this.geometry = null;
                this.d.tabChanged(t);
                if (!uncontrollableReason(t.url)) await this.joinGroup(id, !this.opened.has(id));
                return { output: `Switched to ${tabLine(t)}.`, observe: !uncontrollableReason(t.url) };
            }
            case 'close': {
                const id = Math.floor(num(a.tab_id ?? this.tabId));
                const t = await chrome.tabs.get(id).catch(() => null);
                if (!t || t.windowId !== windowId) throw new ToolError(`There is no tab ${a.tab_id} in this window.`);
                if (!this.opened.has(id) && this.d.mode() !== 'auto') {
                    const r = await this.d.approve('Close this tab?', `Close the tab ${tabLine(t)}`);
                    if (r.decision === 'deny') return { output: `The user declined closing that tab.${r.feedback ? ` They said: ${r.feedback}` : ''}`, isError: true };
                }
                await chrome.tabs.remove(id);
                this.opened.delete(id);
                this.touched.delete(id);
                this.ungroupAtEnd.delete(id);
                if (id === this.tabId) {
                    await sleep(200, signal);
                    const [now] = await chrome.tabs.query({ active: true, windowId });
                    this.tabId = now?.id ?? null;
                    this.geometry = null;
                    this.d.tabChanged(now ?? null);
                    return { output: `Closed it. The current tab is now ${now ? tabLine(now) : 'none'}.`, observe: !!now && !uncontrollableReason(now.url) };
                }
                return { output: 'Closed the tab.' };
            }
            default:
                throw new ToolError('tabs needs action: list, open, switch or close.');
        }
    }
}

// ------------------------------------------------------------------ helpers

/** "Tick checkbox "I agree"", "Choose “Team” in combobox "Plan"", "Set textbox "Date" to “…”". */
function formLabel(desc: string, value: unknown, message: string): string {
    if (/^(checkbox|switch|menuitemcheckbox)/.test(desc)) return `${/now unchecked/.test(message) ? 'Untick' : 'Tick'} ${desc}`;
    if (/^(radio|option|menuitemradio)/.test(desc)) return `Choose ${desc}`;
    if (/^(combobox|listbox)/.test(desc)) return `Choose “${clip(value, 40)}” in ${desc}`;
    return `Set ${desc} to “${clip(value, 40)}”`;
}

export function refusal(what: string): string {
    return `Not typed: this is ${what}. Brisqal never types passwords, card details or one-time codes. Ask the user to type it in the page themselves (ask_user), then continue.`;
}

function tabLine(t: chrome.tabs.Tab): string {
    return `“${clip(t.title, 80) || 'untitled'}” (${clip(t.url || t.pendingUrl, 140)})`;
}

/** Resolves when the tab has finished loading (or after the timeout). */
export function waitForLoad(tabId: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(onUpdated);
            // A moment for scripts to render after the load event.
            setTimeout(resolve, 250);
        };
        const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo) => { if (id === tabId && info.status === 'complete') finish(); };
        const timer = setTimeout(finish, timeoutMs);
        chrome.tabs.onUpdated.addListener(onUpdated);
        signal?.addEventListener('abort', finish, { once: true });
        chrome.tabs.get(tabId).then((t) => { if (t.status === 'complete') finish(); }, finish);
    });
}

function scriptingError(e: any): string {
    const m = String(e?.message ?? e);
    if (/Cannot access|cannot be scripted|chrome:\/\/|extensions gallery|Missing host permission/i.test(m)) {
        return 'Chrome doesn\'t let Brisqal read or control this page (browser pages, the Chrome Web Store and some built-in viewers). Use navigate to open a website.';
    }
    if (/showing error page/i.test(m)) return 'The page didn\'t load (Chrome is showing an error page). Check the address, or reload.';
    if (/No tab with id|tab was closed/i.test(m)) return 'The tab was closed. Use tabs to open or switch to a tab.';
    if (/Frame with ID 0 was removed|document unloaded|navigat/i.test(m)) return 'The page was changing (loading a new page). Try again.';
    return m;
}

function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function bytesToBase64(bytes: Uint8Array): string {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
}
