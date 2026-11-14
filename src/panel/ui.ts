/** Rendering helpers for the side panel: escaping, the logo, icons, step labels and request cards. */

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

let logoSeq = 0;
/** The Brisqal logo. Each copy gets its own gradient id (a gradient inside a hidden copy wouldn't render elsewhere). */
export function logo(size?: number): string {
    const id = `bqg${++logoSeq}`;
    const dims = size ? ` width="${size}" height="${size}"` : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"${dims} aria-hidden="true"><defs><linearGradient id="${id}" x1="8" y1="4" x2="58" y2="62" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#5a78ff"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="url(#${id})"/><path fill="#fff" fill-rule="evenodd" d="M18 13H33.5C39 13 42.5 16.8 42.5 21.6C42.5 24.6 41.2 27 39.2 28.6C43.4 30.1 46 33.8 46 38.6C46 45.6 41 51 33.8 51H18ZM29.5 15.8C30.1 19.7 31.6 21.2 35.5 21.8C31.6 22.4 30.1 23.9 29.5 27.8C28.9 23.9 27.4 22.4 23.5 21.8C27.4 21.2 28.9 19.7 29.5 15.8ZM24.5 34.5V45H33C36 45 38 43 38 39.75C38 36.5 36 34.5 33 34.5Z"/></svg>`;
}

const svg = (d: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const ICONS: Record<string, string> = {
    eye: svg('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>'),
    page: svg('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>'),
    pointer: svg('<path d="m4 4 7 17 2.5-7.5L21 11Z"/>'),
    keyboard: svg('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>'),
    scroll: svg('<path d="M12 3v18M7 8l5-5 5 5M7 16l5 5 5-5"/>'),
    clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    link: svg('<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>'),
    tabs: svg('<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M7 7V5a1 1 0 0 1 1-1h5l2 3"/>'),
    form: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h10M7 13h4M14 13l1.5 1.5L18 12"/>'),
    globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'),
    search: svg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'),
    question: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17h.01"/>'),
    gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    history: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>'),
    trash: svg('<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>'),
    send: svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),
    stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>',
    close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
    drag: svg('<path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20"/>'),
};

/** Icon + plain-language label for a step. */
export function stepLabel(name: string, a: any): { icon: string; html: string } {
    const code = (s: unknown, n = 60) => { const t = String(s ?? ''); return `<code>${esc(t.length > n ? t.slice(0, n) + '…' : t)}</code>`; };
    const q = (s: unknown, n = 50) => { const t = String(s ?? '').replace(/\n/g, '⏎'); return `“${esc(t.length > n ? t.slice(0, n) + '…' : t)}”`; };
    const where = a.ref !== undefined && a.ref !== null && a.ref !== '' ? '' : a.x !== undefined ? ` at (${esc(a.x)}, ${esc(a.y)})` : '';
    const host = (u: unknown) => { try { return new URL(String(u)).hostname || String(u); } catch { return String(u ?? ''); } };
    if (name === 'computer') {
        switch (a.action) {
            case 'screenshot': return { icon: 'eye', html: 'Look at the page' };
            case 'left_click': return { icon: 'pointer', html: `Click${where}` };
            case 'double_click': return { icon: 'pointer', html: `Double-click${where}` };
            case 'triple_click': return { icon: 'pointer', html: `Triple-click${where}` };
            case 'right_click': return { icon: 'pointer', html: `Right-click${where}` };
            case 'hover': return { icon: 'pointer', html: `Point at an element${where}` };
            case 'drag': return { icon: 'drag', html: 'Drag an element' };
            case 'type': return { icon: 'keyboard', html: `Type ${q(a.text)}` };
            case 'key': return { icon: 'keyboard', html: `Press <kbd>${esc(a.keys)}</kbd>${a.repeat > 1 ? ` ×${esc(a.repeat)}` : ''}` };
            case 'scroll': return { icon: 'scroll', html: `Scroll ${esc(a.direction || 'down')}` };
            case 'scroll_to': return { icon: 'scroll', html: 'Scroll to an element' };
            case 'wait': return { icon: 'clock', html: a.for_text ? `Wait for ${q(a.for_text)}` : `Wait ${esc(a.seconds ?? 2)} s` };
            default: return { icon: 'pointer', html: esc(a.action) };
        }
    }
    switch (name) {
        case 'read_page': return { icon: 'page', html: 'Read the page' };
        case 'find': return { icon: 'search', html: `Find ${q(a.query)} on the page` };
        case 'get_page_text': return { icon: 'page', html: a.offset ? 'Read more of the page' : 'Read the page text' };
        case 'form_input': return { icon: 'form', html: `Set a field to ${q(a.value)}` };
        case 'navigate': {
            const u = String(a.url ?? '');
            if (['back', 'forward'].includes(u.toLowerCase())) return { icon: 'link', html: `Go ${esc(u.toLowerCase())}` };
            if (['reload', 'refresh'].includes(u.toLowerCase())) return { icon: 'link', html: 'Reload the page' };
            return { icon: 'link', html: /^\S+\.\S+|^https?:/.test(u) ? `Open ${code(host(/^https?:/.test(u) ? u : `https://${u}`))}` : `Search for ${q(u)}` };
        }
        case 'tabs': {
            switch (a.action) {
                case 'list': return { icon: 'tabs', html: 'Check the open tabs' };
                case 'open': return { icon: 'tabs', html: a.url ? `Open a new tab: ${code(host(/^https?:/.test(a.url) ? a.url : `https://${a.url}`))}` : 'Open a new tab' };
                case 'switch': return { icon: 'tabs', html: 'Switch tab' };
                case 'close': return { icon: 'tabs', html: 'Close a tab' };
                default: return { icon: 'tabs', html: 'Tabs' };
            }
        }
        case 'read_webpage': return { icon: 'globe', html: `Read ${code(host(a.url))}` };
        case 'web_search': return { icon: 'search', html: `Search the web for ${q(a.query)}` };
        case 'ask_user': return { icon: 'question', html: 'Ask you a question' };
        default: return { icon: 'gear', html: esc(name) };
    }
}

/** Approval / question card. */
export function requestCard(m: any): string {
    if (m.type === 'question') {
        return `<div class="card" data-req="${esc(m.id)}">
            <div class="c-title">${esc(m.question)}</div>
            ${m.options?.length ? `<div class="actions">${m.options.map((o: string) => `<button class="btn btn-secondary" data-answer="${esc(o)}">${esc(o)}</button>`).join('')}</div>` : ''}
            <div class="answer-row"><input class="input" data-answer-input placeholder="Type your answer…"><button class="btn btn-primary" data-answer-send>Send</button></div>
        </div>`;
    }
    return `<div class="card" data-req="${esc(m.id)}">
        <div class="c-title">${esc(m.title)}</div>
        <div class="actions">
            <button class="btn btn-primary" data-decision="allow">Allow</button>
            <button class="btn btn-secondary" data-decision="always" title="Stop asking before each action (you can change this below the message box)">Allow all</button>
            <button class="btn btn-secondary" data-decision="deny">Don't allow</button>
        </div>
        <input class="input" data-feedback placeholder="Optional: tell Brisqal what to do instead">
    </div>`;
}

/** Wire clicks/Enter inside request cards of a container. */
export function wireRequestCards(container: HTMLElement, answer: (id: string, r: { decision?: 'allow' | 'always' | 'deny'; text?: string }) => void) {
    container.addEventListener('click', (e) => {
        const t = e.target as HTMLElement;
        const card = t.closest<HTMLElement>('[data-req]');
        if (!card || card.classList.contains('resolved')) return;
        const id = card.dataset.req!;
        const decision = t.closest<HTMLElement>('[data-decision]')?.dataset.decision as 'allow' | 'always' | 'deny' | undefined;
        if (decision) {
            const feedback = (card.querySelector('[data-feedback]') as HTMLInputElement | null)?.value.trim() || undefined;
            answer(id, { decision, text: feedback });
        }
        const a = t.closest<HTMLElement>('[data-answer]')?.dataset.answer;
        if (a !== undefined) answer(id, { text: a });
        if (t.closest('[data-answer-send]')) {
            const v = (card.querySelector('[data-answer-input]') as HTMLInputElement).value.trim();
            if (v) answer(id, { text: v });
        }
    });
    container.addEventListener('keydown', (e) => {
        const t = e.target as HTMLElement;
        if (e.key !== 'Enter' || e.isComposing) return;
        const card = t.closest<HTMLElement>('[data-req]');
        if (!card) return;
        const v = (t as HTMLInputElement).value?.trim();
        if (t.matches('[data-answer-input]') && v) answer(card.dataset.req!, { text: v });
        if (t.matches('[data-feedback]')) answer(card.dataset.req!, { decision: 'deny', text: v || undefined });
    });
}

export function resolveCard(container: HTMLElement, id: string, decision?: string, text?: string) {
    const card = container.querySelector<HTMLElement>(`[data-req="${CSS.escape(id)}"]`);
    if (!card) return;
    card.classList.add('resolved');
    const summary = text !== undefined && decision === undefined ? `Your answer: ${esc(text || '(none)')}`
        : decision === 'deny' ? '✕ Not allowed' : decision === 'always' ? '✓ Allowed (and all further actions)' : '✓ Allowed';
    card.querySelectorAll('.actions, .answer-row, [data-feedback]').forEach((el) => el.remove());
    card.insertAdjacentHTML('beforeend', `<div class="muted small">${summary}</div>`);
}
