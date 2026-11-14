/**
 * Injected into the tab Brisqal works on (only while a task runs, by chrome.scripting). Runs in the
 * extension's isolated world: the page can't see or call it. It describes the page for the model
 * (elements get numeric refs that stay stable while the page lives), finds elements, reads text,
 * locates elements for the trusted mouse/keyboard input sent by the side panel, sets form controls,
 * refuses password/payment/one-time-code fields, and draws the "Brisqal is working" border.
 *
 * Everything returned must be JSON-serializable (it goes back through chrome.scripting).
 */

import { PAGE_VERSION as VERSION } from './version';

const OVERLAY_ID = '__brisqal_overlay';
const MAX_NODES = 40000;

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'BR', 'WBR', 'BASE', 'PARAM', 'SOURCE', 'TRACK']);
const INTERACTIVE = new Set(['link', 'button', 'checkbox', 'radio', 'textbox', 'searchbox', 'combobox', 'listbox', 'slider', 'spinbutton', 'switch', 'tab',
    'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem', 'file upload', 'clickable']);
const CONTAINERS = new Set(['dialog', 'alertdialog', 'form', 'navigation', 'main', 'search', 'table', 'tablist', 'menu', 'menubar', 'tree', 'grid', 'region', 'toolbar', 'radiogroup', 'group']);
const ALERTS = new Set(['alert', 'status']);
const CLICKABLE_TAGS = new Set(['DIV', 'SPAN', 'LI', 'IMG', 'svg', 'SVG', 'I', 'TD', 'TR', 'P', 'SECTION', 'ARTICLE', 'FIGURE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'STRONG', 'B', 'EM']);
const TEXTLIKE_INPUTS = new Set(['text', 'email', 'search', 'tel', 'url', 'password', 'number', '']);

type Filter = 'interactive' | 'all';
interface Line { depth: number; text: string; offscreen: boolean; keep: boolean; pos: 'above' | 'near' | 'below' }
interface Walk { filter: Filter; lines: Line[]; count: number; vw: number; vh: number; cursor: Map<Element, string>; focused: Element | null }

// ------------------------------------------------------------------ refs
const refs = new Map<number, WeakRef<Element>>();
const ids = new WeakMap<Element, number>();
let nextRef = 1;

function refOf(el: Element): number {
    let id = ids.get(el);
    if (!id) {
        id = nextRef++;
        ids.set(el, id);
        refs.set(id, new WeakRef(el));
    }
    return id;
}

function byRef(id: number): Element | null {
    const el = refs.get(Number(id))?.deref();
    return el && el.isConnected ? el : null;
}

const goneRef = (ref: number) => ({ error: `Element ref ${ref} isn't on the page anymore (the page changed). Call read_page or find again for fresh refs.` });

// ------------------------------------------------------------------ helpers
const clean = (s: string | null | undefined, max = 100) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
};
const q = (s: string) => JSON.stringify(s);

function isHidden(el: Element): boolean {
    const r = el.getBoundingClientRect();
    if (r.width < 2 && r.height < 2) return true;
    const cv = (el as any).checkVisibility;
    if (typeof cv === 'function') {
        return !cv.call(el, { opacityProperty: true, visibilityProperty: true, checkOpacity: true, checkVisibilityCSS: true });
    }
    return false;
}

/** Offset of an element's document inside the top-level viewport (same-origin frames only). */
function frameOffset(el: Element): { x: number; y: number } {
    let x = 0, y = 0;
    let win: Window | null = el.ownerDocument.defaultView;
    while (win && win !== window.top) {
        const fe = win.frameElement as HTMLElement | null;
        if (!fe) break;
        const r = fe.getBoundingClientRect();
        x += r.left + fe.clientLeft;
        y += r.top + fe.clientTop;
        win = fe.ownerDocument.defaultView;
    }
    return { x, y };
}

function topRect(el: Element) {
    const r = el.getBoundingClientRect();
    const o = frameOffset(el);
    return { left: r.left + o.x, top: r.top + o.y, width: r.width, height: r.height, right: r.right + o.x, bottom: r.bottom + o.y };
}

function viewport() {
    const se = document.scrollingElement || document.documentElement;
    return {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY),
        docWidth: se.scrollWidth,
        docHeight: se.scrollHeight,
        dpr: window.devicePixelRatio || 1,
        title: document.title,
        url: location.href,
    };
}

function deepActive(): Element | null {
    let a: Element | null = document.activeElement;
    for (let i = 0; i < 20 && a; i++) {
        if (a.shadowRoot?.activeElement) { a = a.shadowRoot.activeElement; continue; }
        if (a.tagName === 'IFRAME' || a.tagName === 'FRAME') {
            try {
                const inner = (a as HTMLIFrameElement).contentDocument?.activeElement;
                if (inner && inner !== (a as HTMLIFrameElement).contentDocument?.body) { a = inner; continue; }
            } catch { /* cross-origin */ }
        }
        break;
    }
    return a;
}

function deepElementFromPoint(doc: Document, x: number, y: number): Element | null {
    let el = doc.elementFromPoint(x, y);
    for (let i = 0; i < 20 && el?.shadowRoot; i++) {
        const inner = el.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === el) break;
        el = inner;
    }
    return el;
}

// ------------------------------------------------------------------ roles and names
function inputType(el: Element): string {
    return el.tagName === 'INPUT' ? ((el as HTMLInputElement).type || 'text').toLowerCase() : '';
}

function isEditableRoot(el: Element): boolean {
    const ce = (el as HTMLElement).contentEditable;
    if (ce !== 'true' && ce !== 'plaintext-only') return false;
    const p = el.parentElement;
    return !p || !(p as HTMLElement).isContentEditable;
}

function roleOf(el: Element): string | null {
    const explicit = el.getAttribute('role')?.trim().split(/\s+/)[0];
    if (explicit && explicit !== 'presentation' && explicit !== 'none' && explicit !== 'generic') return explicit;
    switch (el.tagName) {
        case 'A': case 'AREA': return el.hasAttribute('href') ? 'link' : null;
        case 'BUTTON': return 'button';
        case 'SUMMARY': return 'button';
        case 'INPUT': {
            const t = inputType(el);
            if (t === 'hidden') return null;
            if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
            if (t === 'checkbox') return 'checkbox';
            if (t === 'radio') return 'radio';
            if (t === 'range') return 'slider';
            if (t === 'number') return 'spinbutton';
            if (t === 'search') return 'searchbox';
            if (t === 'file') return 'file upload';
            return 'textbox';
        }
        case 'TEXTAREA': return 'textbox';
        case 'SELECT': return (el as HTMLSelectElement).multiple || (el as HTMLSelectElement).size > 1 ? 'listbox' : 'combobox';
        case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': return 'heading';
        case 'IMG': return el.getAttribute('alt')?.trim() ? 'img' : null;
        case 'DIALOG': return 'dialog';
        case 'FORM': return 'form';
        case 'NAV': return 'navigation';
        case 'MAIN': return 'main';
        case 'TABLE': return 'table';
        case 'FIELDSET': return 'group';
        case 'IFRAME': case 'FRAME': return 'iframe';
        case 'VIDEO': return 'video';
        case 'AUDIO': return 'audio';
        case 'SECTION': return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : null;
    }
    if (isEditableRoot(el)) return 'textbox';
    return null;
}

function textOfIds(el: Element, attr: string): string {
    const v = el.getAttribute(attr);
    if (!v) return '';
    const root = el.getRootNode() as Document | ShadowRoot;
    return v.split(/\s+/).map((id) => (root.getElementById?.(id) ?? el.ownerDocument.getElementById(id))?.textContent ?? '').join(' ');
}

function nameOf(el: Element, role: string | null): string {
    const by = clean(textOfIds(el, 'aria-labelledby'));
    if (by) return by;
    const aria = clean(el.getAttribute('aria-label'));
    if (aria) return aria;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        const t = inputType(el);
        if (['button', 'submit', 'reset'].includes(t)) return clean((el as HTMLInputElement).value) || (t === 'submit' ? 'Submit' : t);
        if (t === 'image') return clean(el.getAttribute('alt')) || 'Submit';
        const labels = (el as HTMLInputElement).labels;
        const lab = labels && labels.length ? clean(Array.from(labels).map((l) => (l as HTMLElement).innerText).join(' ')) : '';
        if (lab) return lab;
        return clean(el.getAttribute('placeholder')) || clean(el.getAttribute('title')) || clean(el.getAttribute('name'));
    }
    if (tag === 'IMG') return clean(el.getAttribute('alt')) || clean(el.getAttribute('title'));
    if (tag === 'IFRAME' || tag === 'FRAME') return clean(el.getAttribute('title')) || clean(el.getAttribute('name'));
    if (role === 'textbox' && isEditableRoot(el)) return clean(el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || el.getAttribute('title'));
    if (CONTAINERS.has(role ?? '')) {
        if (tag === 'FIELDSET') return clean(el.querySelector('legend')?.textContent);
        if (tag === 'TABLE') return clean(el.querySelector('caption')?.textContent);
        const h = role === 'dialog' || role === 'alertdialog' ? el.querySelector('h1,h2,h3,[role=heading]') : null;
        return clean(h?.textContent) || clean(el.getAttribute('title'));
    }
    const text = clean((el as HTMLElement).innerText ?? el.textContent, 120);
    if (text) return text;
    const img = el.querySelector('img[alt]');
    if (img) return clean(img.getAttribute('alt'));
    const labelled = el.querySelector('[aria-label]');
    if (labelled) return clean(labelled.getAttribute('aria-label'));
    const svgTitle = el.querySelector('svg title');
    if (svgTitle) return clean(svgTitle.textContent);
    return clean(el.getAttribute('title'));
}

/** Why this field must never be typed into by the agent (null = fine). */
function sensitiveReason(el: Element | null): string | null {
    if (!el) return null;
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        const s = `${el.getAttribute('src') ?? ''} ${el.getAttribute('name') ?? ''} ${el.getAttribute('title') ?? ''}`;
        let readable = false;
        try { readable = !!(el as HTMLIFrameElement).contentDocument; } catch { /* cross-origin */ }
        if (!readable && /stripe|braintree|adyen|paypal|checkout|payment|card|cvc|klarna|squareup|recurly|chargebee|worldpay|authorize\.net|hosted.?fields/i.test(s)) return 'a payment field';
        return null;
    }
    const t = inputType(el);
    if (t === 'password') return 'a password field';
    const ac = (el.getAttribute('autocomplete') ?? '').toLowerCase();
    if (/current-password|new-password/.test(ac)) return 'a password field';
    if (/cc-number|cc-csc|cc-exp/.test(ac)) return 'a card number or security code field';
    if (/one-time-code/.test(ac)) return 'a one-time code field';
    const hint = `${el.getAttribute('name') ?? ''} ${el.id} ${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('placeholder') ?? ''} ${el.getAttribute('data-testid') ?? ''}`;
    if (/pass(word|wd|phrase)|\bpwd\b/i.test(hint)) return 'a password field';
    if (/card.?(number|num|no)\b|cardnumber|cc.?num|\bcvv\b|\bcvc\b|\bcsc\b|security.?code|expir(y|ation)/i.test(hint)) return 'a card number or security code field';
    if (/\botp\b|one.?time|\b2fa\b|totp|verification.?code|auth(entication)?.?code|passcode/i.test(hint)) return 'a one-time code field';
    return null;
}

/** A checkbox/radio whose real input is hidden behind a styled label: describe/act through the label. */
function hiddenControlOfLabel(el: Element): HTMLInputElement | null {
    if (el.tagName !== 'LABEL') return null;
    const c = (el as HTMLLabelElement).control as HTMLInputElement | null;
    if (!c || c.tagName !== 'INPUT' || !['checkbox', 'radio'].includes(inputType(c))) return null;
    return isHidden(c) ? c : null;
}

function cursorOf(el: Element, w: Walk): string {
    let c = w.cursor.get(el);
    if (c === undefined) {
        c = getComputedStyle(el).cursor;
        w.cursor.set(el, c);
    }
    return c;
}

function isClickableGeneric(el: Element, w: Walk): boolean {
    if (!CLICKABLE_TAGS.has(el.tagName)) return false;
    if (el.hasAttribute('onclick') || el.hasAttribute('ng-click') || el.hasAttribute('@click') || el.hasAttribute('v-on:click')) return true;
    if (el.hasAttribute('tabindex') && (el as HTMLElement).tabIndex >= 0 && el.tagName !== 'DIV' && el.tagName !== 'SPAN') return true;
    if (cursorOf(el, w) !== 'pointer') return false;
    const p = el.parentElement;
    return !p || cursorOf(p, w) !== 'pointer';
}

function stateOf(el: Element, role: string, focused: boolean): string {
    const s: string[] = [];
    const tag = el.tagName;
    const t = inputType(el);
    const hidden = hiddenControlOfLabel(el);
    if (role === 'textbox' || role === 'searchbox' || role === 'spinbutton' || role === 'combobox' && tag === 'INPUT') {
        if (t && !['text', 'search', 'number'].includes(t)) s.push(`type=${t}`);
        if (tag === 'INPUT' || tag === 'TEXTAREA') {
            const v = (el as HTMLInputElement).value;
            if (sensitiveReason(el)) { if (v) s.push('value=(hidden)'); s.push('private'); }
            else if (v) s.push(`value=${q(clean(v, 80))}`);
            const ph = clean(el.getAttribute('placeholder'), 60);
            if (ph && !v && ph !== nameOf(el, role)) s.push(`placeholder=${q(ph)}`);
        } else if (isEditableRoot(el)) {
            const v = clean((el as HTMLElement).innerText, 80);
            if (v) s.push(`value=${q(v)}`);
        }
    }
    if (tag === 'SELECT') {
        const sel = el as HTMLSelectElement;
        const chosen = Array.from(sel.selectedOptions).map((o) => clean(o.text, 50));
        if (chosen.length) s.push(`value=${q(chosen.join(', '))}`);
        const opts = Array.from(sel.options).map((o) => clean(o.text, 40)).filter(Boolean);
        s.push(`options: ${opts.slice(0, 15).join(' | ')}${opts.length > 15 ? ` | …(${opts.length - 15} more)` : ''}`);
    }
    const checkable = hidden ?? (t === 'checkbox' || t === 'radio' ? el as HTMLInputElement : null);
    if (checkable) s.push(checkable.checked ? 'checked' : 'unchecked');
    else if (['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(role)) {
        const ac = el.getAttribute('aria-checked');
        if (ac) s.push(ac === 'true' ? 'checked' : ac === 'mixed' ? 'mixed' : 'unchecked');
    }
    if (role === 'slider' && tag === 'INPUT') s.push(`value=${(el as HTMLInputElement).value} (${(el as HTMLInputElement).min || 0}–${(el as HTMLInputElement).max || 100})`);
    const ex = el.getAttribute('aria-expanded');
    if (ex) s.push(ex === 'true' ? 'expanded' : 'collapsed');
    if (el.getAttribute('aria-selected') === 'true') s.push('selected');
    if (el.getAttribute('aria-pressed') === 'true') s.push('pressed');
    const cur = el.getAttribute('aria-current');
    if (cur && cur !== 'false') s.push('current');
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') s.push('disabled');
    if ((el as HTMLInputElement).required || el.getAttribute('aria-required') === 'true') s.push('required');
    if (el.getAttribute('aria-invalid') === 'true') s.push('invalid');
    if ((el as HTMLInputElement).readOnly && (tag === 'INPUT' || tag === 'TEXTAREA')) s.push('read-only');
    if (role === 'heading') s.push(`(h${el.getAttribute('aria-level') || tag.slice(1) || 2})`);
    if (focused) s.push('focused');
    // Link addresses only when the link has no name (the model clicks by ref; addresses cost tokens).
    if (role === 'link' && !nameOf(el, role)) {
        const href = (el as HTMLAnchorElement).href;
        if (href && !href.startsWith('javascript:')) s.push(`→ ${shortHref(href)}`);
    }
    return s.join(' ');
}

function shortHref(href: string): string {
    try {
        const u = new URL(href);
        const path = u.pathname + u.search;
        const s = u.origin === location.origin ? path : u.host + (path === '/' ? '' : path);
        return s.length > 70 ? s.slice(0, 69) + '…' : s;
    } catch {
        return href.slice(0, 70);
    }
}

function describe(el: Element, role: string, focused: boolean): string {
    const hidden = hiddenControlOfLabel(el);
    const shown = hidden ? inputType(hidden) : role;
    const name = nameOf(el, role);
    const state = stateOf(el, role, focused);
    return `${shown}${name ? ' ' + q(name) : ''}${state ? ' ' + state : ''}`;
}

function shortDesc(el: Element): string {
    const role = roleOf(el) ?? el.tagName.toLowerCase();
    const name = nameOf(el, role);
    return `${role}${name ? ' ' + q(clean(name, 60)) : ''}`;
}

// ------------------------------------------------------------------ the page outline
type Kind = 'interactive' | 'container' | 'heading' | 'alert' | 'media' | null;

function kindOf(el: Element, role: string | null, w: Walk): { kind: Kind; role: string } {
    if (role === 'heading') return { kind: 'heading', role };
    if (role && ALERTS.has(role)) return { kind: 'alert', role };
    if (role && CONTAINERS.has(role)) return { kind: 'container', role };
    if (role === 'img' || role === 'video' || role === 'audio' || role === 'iframe') return { kind: 'media', role };
    if (role && INTERACTIVE.has(role)) return { kind: 'interactive', role };
    const hidden = hiddenControlOfLabel(el);
    if (hidden) return { kind: 'interactive', role: inputType(hidden) };
    if (el.tagName === 'LABEL') return { kind: null, role: '' };
    if (!role && isClickableGeneric(el, w)) return { kind: 'interactive', role: 'clickable' };
    return { kind: null, role: role ?? '' };
}

function ownText(el: Element): string {
    let s = '';
    for (const n of Array.from(el.childNodes)) if (n.nodeType === Node.TEXT_NODE) s += n.textContent;
    return clean(s, 300);
}

function emit(w: Walk, el: Element, depth: number, text: string, keep: boolean) {
    const r = topRect(el);
    const offscreen = r.bottom <= 0 || r.top >= w.vh || r.right <= 0 || r.left >= w.vw;
    // "near": on screen, a little above, or up to half a screen below (what a person would look at).
    const pos = r.bottom < -0.25 * w.vh ? 'above' : r.top > 1.5 * w.vh ? 'below' : 'near';
    w.lines.push({ depth, text: offscreen ? `${text} offscreen` : text, offscreen, keep, pos });
}

function walkChildren(parent: Element, depth: number, w: Walk, inInteractive: boolean) {
    for (const el of Array.from(parent.children)) walkEl(el, depth, w, inInteractive);
}

function walkEl(el: Element, depth: number, w: Walk, inInteractive: boolean) {
    if (++w.count > MAX_NODES) return;
    if (SKIP_TAGS.has(el.tagName) || el.id === OVERLAY_ID) return;
    if ((el as HTMLElement).inert) return;
    const cv = (el as any).checkVisibility;
    if (typeof cv === 'function' && !cv.call(el) && el.tagName !== 'SLOT' && getComputedStyle(el).display !== 'contents') return;

    let childDepth = depth;
    let childInteractive = inInteractive;
    if (!inInteractive) {
        const role = roleOf(el);
        const { kind, role: r } = kindOf(el, role, w);
        if (kind && !isHidden(el)) {
            const line = `[${refOf(el)}] ${describe(el, r, el === w.focused)}`;
            if (kind === 'alert') {
                const t = clean((el as HTMLElement).innerText, 200);
                if (t) emit(w, el, depth, `[${refOf(el)}] ${r} ${q(t)}`, true);
            } else if (kind === 'media' && r === 'iframe') {
                let readable = false;
                try { readable = !!(el as HTMLIFrameElement).contentDocument?.body; } catch { /* cross-origin */ }
                emit(w, el, depth, `${line}${readable ? '' : ' (another site inside the page: its contents can only be seen in the screenshot)'}`, true);
                if (readable) childDepth = depth + 1;
            } else if (kind !== 'media' || w.filter === 'all' || r !== 'img') {
                emit(w, el, depth, line, kind === 'container' || kind === 'heading');
            }
            if (kind === 'container') childDepth = depth + 1;
            if (kind === 'interactive') childInteractive = true;
        } else if (w.filter === 'all' && !kind) {
            const t = ownText(el);
            if (t.length > 1 && !isHidden(el)) emit(w, el, depth, `text ${q(t)}`, false);
        }
    }

    if (el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') return;
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        let body: HTMLElement | null = null;
        try { body = (el as HTMLIFrameElement).contentDocument?.body ?? null; } catch { /* cross-origin */ }
        if (body) walkEl(body, childDepth, w, childInteractive);
        return;
    }
    if (el.shadowRoot) {
        walkShadow(el.shadowRoot, childDepth, w, childInteractive);
        return;
    }
    if (el.tagName === 'SLOT') {
        for (const a of (el as HTMLSlotElement).assignedElements({ flatten: true })) walkEl(a, childDepth, w, childInteractive);
        return;
    }
    walkChildren(el, childDepth, w, childInteractive);
}

function walkShadow(root: ShadowRoot, depth: number, w: Walk, inInteractive: boolean) {
    for (const el of Array.from(root.children)) walkEl(el, depth, w, inInteractive);
}

function header(focusLine?: string): string {
    const v = viewport();
    const screens = v.docHeight / Math.max(1, v.height);
    const pct = v.docHeight > v.height ? Math.round((v.scrollY / (v.docHeight - v.height)) * 100) : 0;
    const lines = [
        `Page: ${clean(v.title, 150) || '(no title)'}`,
        `URL: ${v.url}`,
        `Viewport: ${v.width}×${v.height} CSS px · ${screens > 1.05 ? `scrolled ${pct}% down a page ${screens.toFixed(1)} screens tall` : 'the whole page fits on screen'}`,
    ];
    if (focusLine) lines.push(`Focused: ${focusLine}`);
    return lines.join('\n');
}

function snapshot(opts: { filter?: Filter; ref?: number; maxChars?: number }) {
    const filter: Filter = opts.filter === 'all' ? 'all' : 'interactive';
    const maxChars = Math.max(2000, opts.maxChars ?? 14000);
    const focused = deepActive();
    const w: Walk = { filter, lines: [], count: 0, vw: window.innerWidth, vh: window.innerHeight, cursor: new Map(), focused };
    let start: Element = document.body ?? document.documentElement;
    if (opts.ref) {
        const el = byRef(opts.ref);
        if (!el) return goneRef(opts.ref);
        start = el;
    }
    walkEl(start, 0, w, false);

    const fid = focused && focused !== document.body ? ids.get(focused) : undefined;
    const head = header(fid ? `[${fid}] ${shortDesc(focused!)}` : undefined);
    const fmt = (l: Line) => '  '.repeat(Math.min(l.depth, 8)) + l.text;
    let lines = w.lines;
    let note = '';
    if (!opts.ref) {
        // The whole page would cost too much on big sites: describe what's around the view and count the rest.
        const below = lines.filter((l) => l.pos === 'below').length, above = lines.filter((l) => l.pos === 'above').length;
        lines = lines.filter((l) => l.pos === 'near');
        if (below || above) note = `\n…${below ? `${below} more elements further down` : ''}${below && above ? ' and ' : ''}${above ? `${above} above` : ''}. Scroll, or use find to reach them.`;
    }
    const total = lines.reduce((n, l) => n + fmt(l).length + 1, 0);
    if (total > maxChars) {
        // Over budget: what's on screen first, then offscreen elements in page order while they fit.
        let used = lines.filter((l) => !l.offscreen || l.keep).reduce((n, l) => n + fmt(l).length + 1, 0);
        const keep = new Set<Line>(lines.filter((l) => !l.offscreen || l.keep));
        for (const l of lines) {
            if (keep.has(l)) continue;
            const len = fmt(l).length + 1;
            if (used + len > maxChars) break;
            keep.add(l);
            used += len;
        }
        const dropped = lines.length - keep.size;
        lines = lines.filter((l) => keep.has(l));
        if (dropped) note += `\n…${dropped} more nearby elements not shown. Scroll, or use find to search for them.`;
    }
    let body = lines.map(fmt).join('\n');
    if (body.length > maxChars) body = body.slice(0, maxChars) + '\n…[cut]';
    if (w.count > MAX_NODES) note += '\n(The page is very large: only the first part was read.)';
    return { text: `${head}\n\n${body || '(no interactive elements found: the page may still be loading, or it is drawn as an image; look at the screenshot)'}${note}` };
}

// ------------------------------------------------------------------ find
const SYNONYMS: Record<string, string> = {
    textbox: 'textbox field input box text', searchbox: 'search box field input', combobox: 'dropdown select combobox menu list',
    listbox: 'list select options', button: 'button btn', link: 'link', checkbox: 'checkbox tick box', radio: 'radio option choice',
    slider: 'slider range', spinbutton: 'number field input', heading: 'heading title header', tab: 'tab', menuitem: 'menu item option',
    clickable: 'button clickable', img: 'image picture photo', 'file upload': 'file upload attach',
};

function find(query: string, limit = 12) {
    const words = clean(query, 200).toLowerCase().split(/[\s,]+/).filter((x) => x.length > 1 || /\d/.test(x));
    if (!words.length) return { error: 'Give some words to search for.' };
    const phrase = words.join(' ');
    const w: Walk = { filter: 'all', lines: [], count: 0, vw: window.innerWidth, vh: window.innerHeight, cursor: new Map(), focused: deepActive() };
    const hits: { el: Element; score: number; role: string }[] = [];

    const visit = (el: Element, inInteractive: boolean) => {
        if (++w.count > MAX_NODES || SKIP_TAGS.has(el.tagName) || el.id === OVERLAY_ID) return;
        const cv = (el as any).checkVisibility;
        if (typeof cv === 'function' && !cv.call(el) && getComputedStyle(el).display !== 'contents') return;
        let nowInteractive = inInteractive;
        if (!inInteractive) {
            const { kind, role } = kindOf(el, roleOf(el), w);
            const textBlock = !kind && ownText(el).length > 1;
            if ((kind || textBlock) && !isHidden(el)) {
                const name = nameOf(el, role).toLowerCase();
                const extra = `${el.getAttribute('placeholder') ?? ''} ${el.getAttribute('title') ?? ''} ${el.getAttribute('name') ?? ''} ${(el as HTMLInputElement).value ?? ''} ${el.id}`.toLowerCase();
                const hay = `${name} ${extra} ${SYNONYMS[role] ?? ''} ${kind ? '' : 'text'}`;
                let matched = 0;
                for (const word of words) if (hay.includes(word)) matched++;
                if (matched) {
                    let score = matched / words.length;
                    if (name.includes(phrase)) score += 0.6;
                    if (name === phrase) score += 0.4;
                    if (kind === 'interactive') score += 0.25;
                    const r = topRect(el);
                    if (r.bottom > 0 && r.top < w.vh) score += 0.1;
                    hits.push({ el, score, role: kind ? role : 'text' });
                }
            }
            if (kind === 'interactive') nowInteractive = true;
        }
        if (el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') return;
        if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
            try { const b = (el as HTMLIFrameElement).contentDocument?.body; if (b) visit(b, nowInteractive); } catch { /* cross-origin */ }
            return;
        }
        const kids = el.shadowRoot ? Array.from(el.shadowRoot.children)
            : el.tagName === 'SLOT' ? (el as HTMLSlotElement).assignedElements({ flatten: true }) : Array.from(el.children);
        for (const k of kids) visit(k, nowInteractive);
    };
    visit(document.body ?? document.documentElement, false);
    hits.sort((a, b) => b.score - a.score);
    const top = hits.filter((h) => h.score >= 0.5 || hits.length < 4).slice(0, limit);
    if (!top.length) return { text: `Nothing on this page matches ${q(query)}. Try other words, scroll, or read_page.` };
    const lines = top.map((h) => {
        const r = topRect(h.el);
        const off = r.bottom <= 0 || r.top >= w.vh ? ' offscreen' : '';
        const body = h.role === 'text' ? `text ${q(clean((h.el as HTMLElement).innerText, 160))}` : describe(h.el, h.role, h.el === w.focused);
        return `[${refOf(h.el)}] ${body}${off}`;
    });
    return { text: `${top.length} match${top.length === 1 ? '' : 'es'} for ${q(query)}:\n${lines.join('\n')}` };
}

// ------------------------------------------------------------------ text
function text(offset = 0, maxChars = 12000) {
    const body = document.body;
    const all = (body?.innerText ?? document.documentElement.textContent ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    const start = Math.max(0, Math.min(Number(offset) || 0, all.length));
    let end = Math.min(all.length, start + maxChars);
    if (end < all.length) {
        const nl = all.lastIndexOf('\n', end);
        if (nl > start + maxChars * 0.6) end = nl;
    }
    const v = viewport();
    const parts = Math.max(1, Math.ceil(all.length / maxChars));
    const part = Math.floor(start / maxChars) + 1;
    const head = `Page: ${clean(v.title, 150) || '(no title)'}\nURL: ${v.url}\n${all.length > maxChars ? `Text part ${part} of about ${parts} (characters ${start}–${end} of ${all.length})` : `Text (${all.length} characters)`}`;
    const more = end < all.length ? `\n\n…more text follows: call get_text with offset ${end}.` : '';
    return { text: `${head}\n\n${all.slice(start, end) || '(the page has no text)'}${more}` };
}

function hasText(s: string): boolean {
    const needle = clean(s, 500).toLowerCase();
    return !!needle && (document.body?.innerText ?? '').toLowerCase().replace(/\s+/g, ' ').includes(needle);
}

// ------------------------------------------------------------------ acting on elements
/** The element to point the mouse at for a ref (a styled label stands in for its hidden checkbox). */
function pointTarget(el: Element): Element {
    if (el.tagName === 'INPUT' && ['checkbox', 'radio'].includes(inputType(el)) && isHidden(el)) {
        const lab = (el as HTMLInputElement).labels?.[0];
        if (lab && !isHidden(lab)) return lab;
    }
    if (el.tagName === 'OPTION') return el.closest('select') ?? el;
    return el;
}

function locate(ref: number, scroll = true) {
    const found = byRef(ref);
    if (!found) return goneRef(ref);
    const el = pointTarget(found);
    let r = topRect(el);
    const vw = window.innerWidth, vh = window.innerHeight;
    const fully = r.top >= 0 && r.left >= 0 && r.bottom <= vh && r.right <= vw;
    if (scroll && !fully) {
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
        r = topRect(el);
    }
    if (r.width < 1 && r.height < 1) return { error: `Element ref ${ref} has no size on the page (it is hidden). Try another element.` };
    // The center of the part that is on screen.
    const left = Math.max(0, r.left), right = Math.min(vw, r.right), top = Math.max(0, r.top), bottom = Math.min(vh, r.bottom);
    if (right <= left || bottom <= top) return { error: `Element ref ${ref} is outside the visible page and can't be scrolled into view. Try scrolling.` };
    const x = Math.round((left + right) / 2), y = Math.round((top + bottom) / 2);
    let covered: string | undefined;
    const o = frameOffset(el);
    const hit = deepElementFromPoint(el.ownerDocument, x - o.x, y - o.y);
    if (hit && hit !== el && !el.contains(hit) && !hit.contains(el) && !(el.tagName === 'LABEL' && (el as HTMLLabelElement).control === hit)) {
        covered = shortDesc(hit);
    }
    return { x, y, width: Math.round(r.width), height: Math.round(r.height), covered, desc: shortDesc(found), sensitive: sensitiveReason(found) ?? undefined };
}

function isEditable(el: Element | null): boolean {
    if (!el) return false;
    if (el.tagName === 'TEXTAREA') return !(el as HTMLTextAreaElement).readOnly && !(el as HTMLTextAreaElement).disabled;
    if (el.tagName === 'INPUT') {
        const t = inputType(el);
        return (TEXTLIKE_INPUTS.has(t) || ['date', 'time', 'datetime-local', 'month', 'week'].includes(t)) && !(el as HTMLInputElement).readOnly && !(el as HTMLInputElement).disabled;
    }
    return !!(el as HTMLElement).isContentEditable;
}

function fieldValue(el: Element | null): string | undefined {
    if (!el || sensitiveReason(el)) return undefined;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return (el as HTMLInputElement).value;
    if ((el as HTMLElement).isContentEditable) return (el as HTMLElement).innerText;
    return undefined;
}

function focusInfo() {
    const a = deepActive();
    const none = !a || a === document.body || a === document.documentElement;
    return {
        desc: none ? 'nothing' : shortDesc(a!),
        editable: isEditable(a),
        sensitive: sensitiveReason(a),
        value: fieldValue(a),
        ref: !none && a ? refOf(a) : undefined,
    };
}

/**
 * Before typing: make sure the field (by ref, or whatever has focus) is focused, select its
 * contents when they should be replaced, and report whether it is a field Brisqal must not fill.
 */
function prepareTyping(ref: number | null, clear: boolean) {
    let el: Element | null = deepActive();
    if (ref) {
        const target = byRef(ref);
        if (!target) return goneRef(ref);
        const reason = sensitiveReason(target);
        if (reason) return { sensitive: reason, desc: shortDesc(target) };
        // The click may have focused an inner input (custom widgets), or nothing.
        if (!el || !(target === el || target.contains(el))) {
            const inner = isEditable(target) ? target : target.querySelector('input,textarea,[contenteditable=""],[contenteditable=true]');
            const toFocus = (inner ?? target) as HTMLElement;
            toFocus.focus?.();
            el = deepActive();
        }
    }
    const reason = sensitiveReason(el);
    if (reason) return { sensitive: reason, desc: el ? shortDesc(el) : 'field' };
    if (clear && el) {
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            try { (el as HTMLInputElement).select(); } catch { /* some input types can't be selected */ }
        } else if ((el as HTMLElement).isContentEditable) {
            const root = editableRoot(el);
            const sel = root.ownerDocument.getSelection();
            sel?.selectAllChildren(root);
        }
    }
    return { editable: isEditable(el), desc: el && el !== document.body ? shortDesc(el) : 'nothing', value: fieldValue(el) };
}

function editableRoot(el: Element): HTMLElement {
    let r = el as HTMLElement;
    while (r.parentElement && r.parentElement.isContentEditable) r = r.parentElement;
    return r;
}

const truthy = (v: unknown) => /^(true|yes|on|checked|1|tick|ticked|selected)$/i.test(String(v).trim());

function setNative(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
}

function setValue(ref: number, value: unknown) {
    let el = byRef(ref);
    if (!el) return goneRef(ref);
    if (el.tagName === 'LABEL' && (el as HTMLLabelElement).control) el = (el as HTMLLabelElement).control!;
    if (el.tagName === 'OPTION') el = el.closest('select') ?? el;
    const reason = sensitiveReason(el);
    if (reason) return { sensitive: reason, desc: shortDesc(el) };
    const v = String(value ?? '');

    if (el.tagName === 'SELECT') {
        const sel = el as HTMLSelectElement;
        const opts = Array.from(sel.options);
        const want = clean(v, 200).toLowerCase();
        const opt = opts.find((o) => clean(o.text, 200).toLowerCase() === want) ?? opts.find((o) => o.value.toLowerCase() === want)
            ?? opts.find((o) => clean(o.text, 200).toLowerCase().includes(want));
        if (!opt) return { error: `No option ${q(v)} in this dropdown. Options: ${opts.map((o) => clean(o.text, 40)).slice(0, 30).join(' | ')}` };
        if (opt.disabled) return { error: `The option ${q(clean(opt.text))} is disabled.` };
        sel.focus();
        setNative(sel, opt.value);
        return { message: `Selected ${q(clean(opt.text))} in ${shortDesc(sel)}.` };
    }
    if (el.tagName === 'INPUT' && ['checkbox', 'radio'].includes(inputType(el))) {
        const box = el as HTMLInputElement;
        const want = inputType(el) === 'radio' ? true : truthy(value);
        if (box.checked !== want) box.click();
        return { message: `${shortDesc(box)} is now ${box.checked ? 'checked' : 'unchecked'}.` };
    }
    const role = roleOf(el);
    if (role && ['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio', 'option'].includes(role) && el.tagName !== 'INPUT') {
        const cur = el.getAttribute('aria-checked') ?? el.getAttribute('aria-selected');
        const want = role === 'radio' || role === 'option' ? true : truthy(value);
        if ((cur === 'true') !== want) (el as HTMLElement).click();
        return { message: `Clicked ${shortDesc(el)}${el.getAttribute('aria-checked') ? ` (now ${el.getAttribute('aria-checked') === 'true' ? 'checked' : 'unchecked'})` : ''}.` };
    }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        const input = el as HTMLInputElement;
        if (input.disabled || input.readOnly) return { error: `${shortDesc(el)} can't be changed (it is ${input.disabled ? 'disabled' : 'read-only'}).` };
        if (inputType(el) === 'file') return { error: 'File uploads need the user: ask them to choose the file (ask_user).' };
        input.focus();
        setNative(input, v);
        if (v && input.value === '' && !['text', 'search', 'email', 'tel', 'url', ''].includes(inputType(el))) {
            const fmt: Record<string, string> = { date: 'YYYY-MM-DD', time: 'HH:MM', 'datetime-local': 'YYYY-MM-DDTHH:MM', month: 'YYYY-MM', week: 'YYYY-W##', color: '#rrggbb', number: 'a number' };
            return { error: `That value doesn't fit this ${inputType(el)} field${fmt[inputType(el)] ? `: use ${fmt[inputType(el)]}` : ''}.` };
        }
        return { message: `Set ${shortDesc(el)} to ${q(clean(input.value, 80))}.` };
    }
    if ((el as HTMLElement).isContentEditable) return { error: 'This is a rich text editor: click it and use type instead.' };
    return { error: `${shortDesc(el)} isn't a form control. Use click or type instead.` };
}

/** One outline line for a ref with its current state (e.g. 'checkbox "I agree" checked'), or null. */
function describeRef(ref: number): string | null {
    const el = byRef(ref);
    if (!el) return null;
    const w: Walk = { filter: 'interactive', lines: [], count: 0, vw: window.innerWidth, vh: window.innerHeight, cursor: new Map(), focused: deepActive() };
    const { role } = kindOf(el, roleOf(el), w);
    return describe(el, role || roleOf(el) || el.tagName.toLowerCase(), el === w.focused);
}

function focusRef(ref: number) {
    const el = byRef(ref);
    if (!el) return goneRef(ref);
    (el as HTMLElement).focus?.();
    return { ok: true };
}

function scrollIntoView(ref: number) {
    const el = byRef(ref);
    if (!el) return goneRef(ref);
    pointTarget(el).scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior });
    return { message: `Scrolled ${shortDesc(el)} into view.` };
}

// ------------------------------------------------------------------ fallbacks (when the debugger can't be used)
function fallbackClick(x: number, y: number, clicks = 1) {
    const el = deepElementFromPoint(document, x, y) as HTMLElement | null;
    if (!el) return { error: `Nothing at (${x}, ${y}).` };
    const opts = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.focus?.();
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    for (let i = 0; i < clicks; i++) el.click();
    if (clicks === 2) el.dispatchEvent(new MouseEvent('dblclick', opts));
    return { desc: shortDesc(el) };
}

function fallbackType(text: string) {
    const el = deepActive();
    if (!el) return { error: 'Nothing is focused.' };
    if (sensitiveReason(el)) return { sensitive: sensitiveReason(el) };
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        const input = el as HTMLInputElement;
        const s = input.selectionStart ?? input.value.length, e = input.selectionEnd ?? input.value.length;
        setNative(input, input.value.slice(0, s) + text + input.value.slice(e));
        return { value: input.value };
    }
    if ((el as HTMLElement).isContentEditable) {
        el.ownerDocument.execCommand('insertText', false, text);
        return { value: (el as HTMLElement).innerText };
    }
    return { error: 'The focused element is not a text field.' };
}

function fallbackKey(key: string) {
    const el = (deepActive() ?? document.body) as HTMLElement;
    const opts = { key, bubbles: true, cancelable: true, composed: true };
    const ok = el.dispatchEvent(new KeyboardEvent('keydown', opts));
    if (ok && key === 'Enter' && el.tagName === 'INPUT') (el as HTMLInputElement).form?.requestSubmit();
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
    return { ok: true };
}

function fallbackScroll(dx: number, dy: number, x?: number, y?: number) {
    let el: Element | null = x !== undefined && y !== undefined ? deepElementFromPoint(document, x, y) : null;
    while (el && el !== document.body && el !== document.documentElement) {
        const s = getComputedStyle(el);
        if ((/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight) || (/(auto|scroll)/.test(s.overflowX) && el.scrollWidth > el.clientWidth)) break;
        el = el.parentElement;
    }
    const target = el && el !== document.body && el !== document.documentElement ? el : (document.scrollingElement ?? document.documentElement);
    target.scrollBy({ left: dx, top: dy, behavior: 'instant' as ScrollBehavior });
    return { ok: true };
}

// ------------------------------------------------------------------ overlay: border + Brisqal's own cursor
/**
 * Everything lives in a closed shadow root, styled through the CSSOM (never markup), so page CSS
 * can't touch it and strict CSPs can't block it. It never takes clicks (pointer-events: none) and is
 * hidden while screenshots are taken, so the model always sees the page itself.
 */
interface Overlay { host: HTMLElement; root: ShadowRoot; cursor: HTMLElement; pos: { x: number; y: number } | null }
let ov: Overlay | null = null;
const BRAND = '#6c63ff';

function svgEl(tag: string, attrs: Record<string, string>): SVGElement {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
}

function ensureOverlay(): Overlay {
    if (ov && ov.host.isConnected) return ov;
    const host = document.createElement('div');
    host.id = OVERLAY_ID;
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    // Static border (no animation): identical pages must give identical screenshots.
    const glow = document.createElement('div');
    glow.style.cssText = `position:fixed;inset:0;pointer-events:none;box-shadow:inset 0 0 0 2px ${BRAND}e6,inset 0 0 22px ${BRAND}59;`;
    root.appendChild(glow);
    // The cursor: an arrow with the Brisqal name tag. Its tip is at (0,0) of the element.
    const cursor = document.createElement('div');
    cursor.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;opacity:0;pointer-events:none;will-change:transform;'
        + 'transition-property:transform,opacity;transition-timing-function:cubic-bezier(.3,.7,.2,1);transition-duration:0ms;';
    const arrow = svgEl('svg', { width: '22', height: '26', viewBox: '0 0 22 26' });
    (arrow as unknown as HTMLElement).style.cssText = 'position:absolute;left:-2px;top:-2px;overflow:visible;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35));';
    arrow.appendChild(svgEl('path', { d: 'M2 2 L2 21 L7.2 16.3 L10.6 24 L14 22.5 L10.7 15 L18 15 Z', fill: BRAND, stroke: '#fff', 'stroke-width': '1.8', 'stroke-linejoin': 'round' }));
    cursor.appendChild(arrow as unknown as Node);
    const tag = document.createElement('div');
    tag.textContent = 'Brisqal';
    tag.style.cssText = `position:absolute;left:16px;top:20px;padding:2px 7px;border-radius:9px;background:linear-gradient(135deg,#5a78ff,#8b5cf6);color:#fff;`
        + 'font:600 11px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.25);';
    cursor.appendChild(tag);
    root.appendChild(cursor);
    (document.documentElement || document.body).appendChild(host);
    ov = { host, root, cursor, pos: null };
    return ov;
}

function placeCursor(o: Overlay, x: number, y: number, ms: number) {
    o.cursor.style.transitionDuration = `${Math.round(ms)}ms`;
    o.cursor.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    o.cursor.style.opacity = '1';
    o.pos = { x, y };
}

/** Show the border; restore the cursor where it was (after a page load). */
function overlay(on: boolean, pos?: { x: number; y: number } | null) {
    if (!on) {
        document.getElementById(OVERLAY_ID)?.remove();
        ov = null;
        return { ok: true };
    }
    const o = ensureOverlay();
    if (pos && !o.pos) placeCursor(o, pos.x, pos.y, 0);
    return { ok: true };
}

/** Glide the cursor to a point (top-level viewport, CSS px). Returns how long the glide takes. */
function cursorTo(x: number, y: number) {
    const o = ensureOverlay();
    let from = o.pos;
    if (!from) {
        // First appearance: start from the middle of the page, then glide.
        from = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
        placeCursor(o, from.x, from.y, 0);
        void o.cursor.getBoundingClientRect(); // apply the start position before the transition
    }
    const d = Math.hypot(x - from.x, y - from.y);
    const ms = d < 3 ? 0 : Math.min(360, 120 + d / 4);
    placeCursor(o, x, y, ms);
    return { ms };
}

/** A ripple where the cursor clicks. */
function cursorClick() {
    const o = ensureOverlay();
    if (!o.pos) return { ok: true };
    const ring = document.createElement('div');
    ring.style.cssText = `position:fixed;left:${o.pos.x - 14}px;top:${o.pos.y - 14}px;width:28px;height:28px;border-radius:50%;`
        + `border:2px solid ${BRAND};background:${BRAND}33;pointer-events:none;`;
    o.root.appendChild(ring);
    const anim = ring.animate([{ transform: 'scale(.3)', opacity: 1 }, { transform: 'scale(1.5)', opacity: 0 }], { duration: 450, easing: 'ease-out' });
    anim.onfinish = () => ring.remove();
    o.cursor.animate([{ transform: o.cursor.style.transform + ' scale(1)' }, { transform: o.cursor.style.transform + ' scale(.82)' }, { transform: o.cursor.style.transform + ' scale(1)' }], { duration: 180 });
    return { ok: true };
}

/** Hide the border and cursor for a screenshot (resolves once the change is painted). */
function captureMode(hidden: boolean): Promise<{ ok: boolean }> {
    const host = document.getElementById(OVERLAY_ID);
    if (!host) return Promise.resolve({ ok: true });
    host.style.visibility = hidden ? 'hidden' : 'visible';
    if (!hidden) return Promise.resolve({ ok: true });
    return new Promise((resolve) => {
        const done = () => resolve({ ok: true });
        const t = setTimeout(done, 120);
        requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); done(); }));
    });
}

// ------------------------------------------------------------------ what an action changed
/**
 * Watches the page during an action, then waits until it is quiet (no changes for 200 ms) and
 * reports what changed: dialogs that opened or closed, and new text. The model gets this short
 * report instead of a screenshot after every action (much cheaper and faster).
 */
interface Watch { obs: MutationObserver; added: Set<Node>; count: number; last: number; dialogs: Set<Element> }
let watching: Watch | null = null;
const DIALOG_SEL = 'dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]';

function openDialogs(): Set<Element> {
    return new Set(Array.from(document.querySelectorAll(DIALOG_SEL)).filter((d) => !isHidden(d)));
}

function watchStart() {
    watching?.obs.disconnect();
    const w: Watch = { obs: null as unknown as MutationObserver, added: new Set(), count: 0, last: performance.now(), dialogs: openDialogs() };
    w.obs = new MutationObserver((records) => {
        w.last = performance.now();
        for (const r of records) {
            if ((r.target as Element).id === OVERLAY_ID || (r.target as Element).closest?.(`#${OVERLAY_ID}`)) continue;
            w.count += r.addedNodes.length + (r.type === 'attributes' || r.type === 'characterData' ? 1 : 0);
            if (r.type === 'characterData' && r.target.parentElement) w.added.add(r.target.parentElement);
            for (const n of Array.from(r.addedNodes)) {
                if (w.added.size > 300) break;
                if (n.nodeType === Node.TEXT_NODE && n.parentElement) w.added.add(n.parentElement);
                else if (n.nodeType === Node.ELEMENT_NODE && (n as Element).id !== OVERLAY_ID) w.added.add(n);
            }
        }
    });
    w.obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['open', 'hidden', 'aria-hidden', 'aria-expanded', 'class', 'style'] });
    watching = w;
    return { ok: true };
}

async function watchReport(maxMs = 1500) {
    const w = watching;
    if (!w) return { text: [], opened: [], closed: 0, big: false };
    const start = performance.now();
    while (performance.now() - start < maxMs && performance.now() - w.last < 200) await new Promise((r) => setTimeout(r, 40));
    w.obs.disconnect();
    watching = null;

    const now = openDialogs();
    const opened = [...now].filter((d) => !w.dialogs.has(d)).map((d) => nameOf(d, 'dialog') || 'untitled');
    const closed = [...w.dialogs].filter((d) => !now.has(d)).length;
    // New visible text, outermost elements only, deduplicated.
    const els = [...w.added].filter((n): n is Element => n.nodeType === Node.ELEMENT_NODE && (n as Element).isConnected
        && !SKIP_TAGS.has((n as Element).tagName) && !isHidden(n as Element));
    const outer = els.filter((e) => !els.some((o) => o !== e && o.contains(e)));
    const text: string[] = [];
    let used = 0;
    for (const e of outer) {
        const t = clean((e as HTMLElement).innerText, 160);
        if (!t || text.includes(t)) continue;
        if (used + t.length > 420) break;
        text.push(t);
        used += t.length;
    }
    const addedEls = els.length;
    return { text, opened, closed, big: opened.length > 0 || addedEls > 40 || w.count > 400 };
}

// ------------------------------------------------------------------ export
const api = {
    version: VERSION,
    snapshot, find, text, hasText, viewport, locate, describeRef, focusInfo, prepareTyping, setValue, focusRef, scrollIntoView,
    fallbackClick, fallbackType, fallbackKey, fallbackScroll, overlay, cursorTo, cursorClick, captureMode, watchStart, watchReport,
};
export type PageApi = typeof api;

const g = globalThis as any;
if (!g.__brisqal || g.__brisqal.version !== VERSION) g.__brisqal = api;
