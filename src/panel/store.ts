/**
 * Settings, sign-in and task history in chrome.storage.local (private to the extension).
 * Saved tasks never contain screenshots, and long tool output is shortened before saving.
 */
import type { ChatMessage } from '../core/api';
import { withoutImages } from '../core/agent';
import type { Mode } from '../core/prompt';

export const DEFAULT_SERVER = 'https://brisqal.codespeedy.com';
/** Bump to show the "Before you start" screen again (e.g. when what the extension does changes). */
export const CONSENT_VERSION = 1;
const MAX_SESSIONS = 30;
const MAX_SAVED_TOOL_OUTPUT = 4000;

export interface Settings {
    serverUrl: string;
    mode: Mode;
    model?: string;
    effort?: string;
    /** 0 = no limit. */
    stepLimit: number;
    consent?: number;
    /** Sites Brisqal must never open or act on (host names; subdomains included). */
    blockedSites: string[];
}

export interface Auth {
    token: string;
    user: { name: string; email: string };
}

export interface SessionMeta { id: string; title: string; updatedAt: number }
export interface Session extends SessionMeta { messages: ChatMessage[]; summary?: string }

const DEFAULTS: Settings = { serverUrl: DEFAULT_SERVER, mode: 'balanced', stepLimit: 0, blockedSites: [] };

async function get<T>(key: string): Promise<T | undefined> {
    try {
        return (await chrome.storage.local.get(key))[key] as T | undefined;
    } catch {
        return undefined;
    }
}

export async function loadSettings(): Promise<Settings> {
    const s = { ...DEFAULTS, ...(await get<Partial<Settings>>('settings')) };
    if (!['ask', 'balanced', 'auto'].includes(s.mode)) s.mode = 'balanced';
    s.stepLimit = normalizeStepLimit(s.stepLimit);
    s.blockedSites = normalizeSites(s.blockedSites);
    return s;
}

export async function saveSettings(s: Settings) {
    await chrome.storage.local.set({ settings: s });
}

/** 0 (no limit) or 5–1000. */
export function normalizeStepLimit(v: unknown): number {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(1000, Math.max(5, n));
}

export function normalizeServer(v: string): string {
    let s = String(v ?? '').trim().replace(/\/+$/, '');
    if (!s) return DEFAULT_SERVER;
    if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
    return s;
}

/** "https://www.example.com/x, shop.test" → ["example.com", "shop.test"]. */
export function normalizeSites(v: unknown): string[] {
    const list = Array.isArray(v) ? v : String(v ?? '').split(/[\s,]+/);
    const out = new Set<string>();
    for (const raw of list) {
        let s = String(raw ?? '').trim().toLowerCase();
        if (!s) continue;
        try { s = new URL(/^[a-z]+:\/\//.test(s) ? s : `https://${s}`).hostname; } catch { continue; }
        s = s.replace(/^www\./, '');
        if (s) out.add(s);
    }
    return [...out].slice(0, 200);
}

export async function loadAuth(): Promise<Auth | undefined> {
    return get<Auth>('auth');
}

export async function saveAuth(a: Auth | undefined) {
    if (a) await chrome.storage.local.set({ auth: a });
    else await chrome.storage.local.remove('auth');
}

export function newSessionId(): string {
    return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export async function listSessions(): Promise<SessionMeta[]> {
    return ((await get<SessionMeta[]>('sessions')) ?? []).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadSession(id: string): Promise<Session | undefined> {
    return get<Session>(`session:${id}`);
}

/** Text-only copy for storage: no screenshots, long tool output shortened. */
export function storable(messages: ChatMessage[]): ChatMessage[] {
    return messages.map((m) => {
        const t = withoutImages(m);
        if (t.role === 'tool' && t.content.length > MAX_SAVED_TOOL_OUTPUT) return { ...t, content: t.content.slice(0, MAX_SAVED_TOOL_OUTPUT) + '\n…[shortened when saved]' };
        return t;
    });
}

export async function saveSession(s: Session) {
    if (!s.messages.length) return;
    const meta: SessionMeta = { id: s.id, title: s.title, updatedAt: s.updatedAt };
    const list = (await listSessions()).filter((x) => x.id !== s.id);
    list.unshift(meta);
    const drop = list.splice(MAX_SESSIONS);
    await chrome.storage.local.set({ sessions: list, [`session:${s.id}`]: { ...meta, messages: storable(s.messages), summary: s.summary } });
    if (drop.length) await chrome.storage.local.remove(drop.map((d) => `session:${d.id}`));
}

export async function deleteSession(id: string): Promise<SessionMeta[]> {
    const list = (await listSessions()).filter((x) => x.id !== id);
    await chrome.storage.local.set({ sessions: list });
    await chrome.storage.local.remove(`session:${id}`);
    return list;
}
