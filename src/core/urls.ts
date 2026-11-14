/** Address handling for navigate/tabs. Pure functions (unit-tested). */

/** "example.com/x" → https URL; "back"/"forward"/"reload" pass through; other words → a web search. */
export function normalizeTarget(input: string): { kind: 'history'; action: 'back' | 'forward' | 'reload' } | { kind: 'url'; url: string } | { kind: 'error'; message: string } {
    const s = String(input ?? '').trim();
    if (!s) return { kind: 'error', message: 'Give an address (https://…), or back, forward or reload.' };
    const lower = s.toLowerCase();
    if (lower === 'back' || lower === 'forward' || lower === 'reload' || lower === 'refresh') {
        return { kind: 'history', action: lower === 'refresh' ? 'reload' : lower };
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^\s/:]+:\d+(\/|$)/.test(s)) {
        let u: URL;
        try { u = new URL(s); } catch { return { kind: 'error', message: `"${s}" isn't a valid address.` }; }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
            return { kind: 'error', message: `Brisqal only opens web pages (http and https), not ${u.protocol} addresses.` };
        }
        return { kind: 'url', url: u.href };
    }
    // Looks like a host name (has a dot or is localhost, no spaces): add https://.
    if (!/\s/.test(s) && (/^[^/]+\.[a-z]{2,}(:\d+)?(\/|$|\?|#)/i.test(s) || /^localhost(:\d+)?(\/|$)/i.test(s) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(s))) {
        const scheme = /^(localhost|127\.|\d{1,3}(\.\d{1,3}){3})/.test(s) ? 'http' : 'https';
        try { return { kind: 'url', url: new URL(`${scheme}://${s}`).href }; } catch { /* fall through to search */ }
    }
    return { kind: 'url', url: `https://www.google.com/search?q=${encodeURIComponent(s)}` };
}

/** The blocked-sites entry this URL falls under (subdomains included), or null. */
export function blockedBy(url: string, blocked: string[]): string | null {
    let host: string;
    try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
    return blocked.find((b) => host === b || host.endsWith(`.${b}`)) ?? null;
}

/** Why Chrome won't let an extension read or control this page (null = it can). */
export function uncontrollableReason(url: string | undefined): string | null {
    if (!url) return 'The tab has no page yet.';
    let u: URL;
    try { u = new URL(url); } catch { return 'The tab has no page yet.'; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return u.protocol === 'file:'
            ? 'This is a file on the computer. Chrome lets Brisqal work only on web pages.'
            : 'This is a browser page (like the new tab page or settings), which Chrome doesn\'t let extensions read or control.';
    }
    if (u.hostname === 'chromewebstore.google.com' || (u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore'))) {
        return 'Chrome doesn\'t let extensions read or control the Chrome Web Store.';
    }
    return null;
}
