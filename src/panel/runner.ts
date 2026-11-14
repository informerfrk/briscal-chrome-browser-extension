/**
 * Runs tasks in the side panel: the agent loop + the browser tools, with the user's permission
 * mode, approvals, questions, mid-task messages, history and stop.
 */
import { Agent, AgentUI } from '../core/agent';
import { ApiClient, ApiError, MeResponse, PlanStatus, ToolCall } from '../core/api';
import { Mode, systemPrompt } from '../core/prompt';
import { BrowserHost, Decision } from './browser';
import { CONSENT_VERSION, newSessionId, saveSession, Session, Settings } from './store';

export type Emit = (msg: Record<string, any>) => void;

export interface RunnerDeps {
    api: ApiClient;
    windowId: () => number;
    settings: () => Settings;
    setMode: (m: Mode) => void;
    me: () => MeResponse | undefined;
    updateUsage: (u: PlanStatus) => void;
    emit: Emit;
    platform: { os: 'windows' | 'mac' | 'linux' | 'chromeos' | 'other'; browser: string };
}

interface Pending { msg: Record<string, unknown>; resolve: (r: { decision?: Decision; text?: string }) => void }

export class Runner {
    readonly host: BrowserHost;
    readonly agent: Agent;
    session: Session = { id: newSessionId(), title: 'New task', updatedAt: Date.now(), messages: [] };
    busy = false;

    private abort?: AbortController;
    private running?: Promise<void>;
    private pending = new Map<string, Pending>();
    private seq = 0;

    constructor(private readonly d: RunnerDeps) {
        this.host = new BrowserHost({
            api: d.api,
            windowId: d.windowId,
            mode: () => d.settings().mode,
            setMode: d.setMode,
            blockedSites: () => d.settings().blockedSites,
            webSearch: () => !!d.me()?.web_search,
            platform: d.platform.os === 'mac' ? 'mac' : 'other',
            approve: (title, detail) => this.request(title, detail),
            ask: (q, o) => this.ask(q, o),
            tabChanged: (t) => d.emit({ type: 'tab', tab: t ? { id: t.id, title: t.title, url: t.url, favIconUrl: t.favIconUrl } : null }),
        });
        this.host.dbg.onUserCancel = () => {
            if (!this.busy) return;
            d.emit({ type: 'notice', text: 'You cancelled Brisqal\'s control of the browser, so it stopped.' });
            this.stop();
        };
        this.agent = new Agent(d.api, this.host, () => this.systemPrompt());
    }

    private systemPrompt(): string {
        return systemPrompt({
            os: this.d.platform.os,
            browser: this.d.platform.browser,
            date: new Date().toDateString(),
            language: navigator.language,
            mode: this.d.settings().mode,
        });
    }

    // ------------------------------------------------------------------ tasks

    /** A new message: starts a task, or (while one runs) is passed to Brisqal at its next step. */
    async send(text: string) {
        text = text.trim();
        if (!text) return;
        if (this.busy) {
            this.host.addNote(text);
            this.d.emit({ type: 'user', text, note: true });
            return;
        }
        const me = this.d.me();
        if (!me) {
            this.d.emit({ type: 'error', message: 'Sign in first.' });
            return;
        }
        // Nothing is read or controlled before the user has agreed to it.
        if ((this.d.settings().consent ?? 0) < CONSENT_VERSION) {
            this.d.emit({ type: 'error', message: 'Please allow Brisqal to read and use the pages it works on first.' });
            return;
        }
        let done!: () => void;
        this.running = new Promise<void>((r) => { done = r; });
        this.busy = true;
        this.abort = new AbortController();
        if (!this.session.messages.length) this.session.title = text.slice(0, 80);
        this.d.emit({ type: 'user', text });
        this.d.emit({ type: 'busy', busy: true });

        const s = this.d.settings();
        const model = me.models.some((m) => m.id === s.model) ? s.model : me.default_model;
        let leftover: string[] = [];
        try {
            await this.host.begin();
            // Where the task starts, so the model needn't spend a first step looking.
            const task = `${text}\n\n[Current tab: ${await this.host.currentTabLine()}]`;
            await this.agent.run(task, this.ui(), {
                model,
                effort: s.effort ?? me.default_effort,
                maxSteps: s.stepLimit,
                maxInputTokens: me.limits?.max_input_tokens?.[model ?? ''],
            }, this.abort.signal);
        } catch (e: any) {
            if (e?.name === 'AbortError' || this.abort.signal.aborted) {
                this.d.emit({ type: 'notice', text: 'Stopped.' });
            } else if (e instanceof ApiError && e.isPlan) {
                if (e.data?.usage) this.d.updateUsage(e.data.usage);
                this.d.emit({ type: 'planBlocked', message: e.message });
            } else if (e instanceof ApiError && e.isAuth) {
                this.d.emit({ type: 'signedOut', message: 'Your session ended. Please sign in again.' });
            } else {
                this.d.emit({ type: 'error', message: e?.message || String(e) });
            }
        } finally {
            leftover = this.abort.signal.aborted ? [] : this.host.takeNotes();
            this.rejectPending();
            await this.host.end().catch(() => undefined);
            this.busy = false;
            this.d.emit({ type: 'busy', busy: false });
            this.session.messages = this.agent.messages;
            this.session.summary = this.agent.summary;
            this.session.updatedAt = Date.now();
            try { await saveSession(this.session); } catch { /* storage full: not fatal */ }
            this.d.emit({ type: 'sessionsChanged' });
            done();
        }
        // Messages typed just as the task finished: carry on with them.
        if (leftover.length) await this.send(leftover.join('\n'));
    }

    stop() {
        this.abort?.abort();
        this.rejectPending();
    }

    async stopAndWait() {
        if (!this.busy) return;
        this.stop();
        await Promise.race([this.running, new Promise((r) => setTimeout(r, 5000))]);
    }

    answer(id: string, r: { decision?: Decision; text?: string }) {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        p.resolve(r);
        this.d.emit({ type: 'resolved', id, decision: r.decision, text: r.text });
    }

    async newSession() {
        await this.stopAndWait();
        this.session = { id: newSessionId(), title: 'New task', updatedAt: Date.now(), messages: [] };
        this.agent.reset();
    }

    async loadSession(s: Session) {
        await this.stopAndWait();
        this.session = { ...s };
        this.agent.messages = [...s.messages];
        this.agent.summary = s.summary;
    }

    private rejectPending() {
        for (const [id, p] of this.pending) {
            p.resolve({ decision: 'deny', text: '' });
            this.d.emit({ type: 'resolved', id, decision: 'deny' });
        }
        this.pending.clear();
    }

    private request(title: string, detail: string): Promise<{ decision: Decision; feedback?: string }> {
        const id = `a${++this.seq}`;
        const msg = { type: 'approval', id, title, detail };
        return new Promise((resolve) => {
            this.pending.set(id, { msg, resolve: (r) => resolve({ decision: r.decision ?? 'deny', feedback: r.text }) });
            this.d.emit(msg);
        });
    }

    private ask(question: string, options: string[]): Promise<string> {
        const id = `q${++this.seq}`;
        const msg = { type: 'question', id, question, options };
        return new Promise((resolve) => {
            this.pending.set(id, { msg, resolve: (r) => resolve(r.text ?? '') });
            this.d.emit(msg);
        });
    }

    private ui(): AgentUI {
        return {
            turnStart: () => this.d.emit({ type: 'turnStart' }),
            reasoning: (t) => this.d.emit({ type: 'reasoning', d: t }),
            content: (t) => this.d.emit({ type: 'content', d: t }),
            turnEnd: () => this.d.emit({ type: 'turnEnd' }),
            toolStart: (c) => this.d.emit({ type: 'toolStart', id: c.id, name: c.function.name, args: safeArgs(c) }),
            toolEnd: (c, r) => this.d.emit({ type: 'toolEnd', id: c.id, output: r.output.slice(0, 4000), isError: !!r.isError, label: r.label }),
            screenshot: (s) => this.d.emit({ type: 'screenshot', dataUrl: s.dataUrl }),
            plan: (u) => this.d.updateUsage(u),
            notice: (t) => this.d.emit({ type: 'notice', text: t }),
        };
    }
}

function safeArgs(call: ToolCall): Record<string, unknown> {
    try {
        return JSON.parse(call.function.arguments || '{}') ?? {};
    } catch {
        return {};
    }
}
