/**
 * The browser agent loop: call the model, run the tools it asks for, show it the tab again,
 * repeat until it answers without tool calls. No chrome.* APIs here, so it can be unit-tested.
 *
 * Usage-saving rules:
 *  - one screenshot per step, taken after all of that step's actions (not one per action);
 *  - screenshots only when the page changed a lot (otherwise a short text report), downscaled by
 *    the host (≤ 1024×768, ~1,000 tokens each);
 *  - only the latest screenshot and page snapshot stay in the history (older ones become a short
 *    note), so each call re-sends little and almost all of it is billed at the cached rate;
 *  - long sessions are summarized (screenshots never go to the summarizer);
 *  - every tool result is size-capped.
 */
import { AgentApi, ApiError, ChatMessage, ContentPart, PlanStatus, ToolCall, ToolDefinition } from './api';

export interface Screenshot {
    /** data:image/jpeg;base64,… */
    dataUrl: string;
    width: number;
    height: number;
    /** Short description for the model, e.g. the tab's title and address. */
    caption?: string;
}

export interface ToolResult {
    output: string;
    isError?: boolean;
    /** A screenshot this tool took (the "screenshot" tool). */
    image?: Screenshot;
    /** The tool changed the page: take a fresh screenshot after this step. */
    observe?: boolean;
    /** What was done, in plain words with the element's name (replaces the step's label in the panel). */
    label?: string;
}

export interface ToolHost {
    definitions(): ToolDefinition[];
    execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult>;
    /** Capture the tab being worked on (null when it can't be captured, e.g. a browser page). */
    screenshot(signal: AbortSignal): Promise<Screenshot | null>;
    /** Messages the user typed while the task was running; they're shown to the model at the next step. */
    takeNotes?(): string[];
}

export interface AgentUI {
    turnStart(): void;
    reasoning(delta: string): void;
    content(delta: string): void;
    turnEnd(): void;
    toolStart(call: ToolCall): void;
    toolEnd(call: ToolCall, result: ToolResult): void;
    screenshot?(shot: Screenshot): void;
    plan(status: PlanStatus): void;
    notice(text: string): void;
}

export interface AgentOptions {
    model?: string;
    effort?: string;
    /** Steps before stopping; 0 = no limit (works until the task is done or it needs the user). */
    maxSteps: number;
    /** Largest prompt the server accepts for this model on the user's plan. */
    maxInputTokens?: number;
}

/**
 * With no step limit nobody has to type "continue", so an unattended task stops only when it
 * makes no progress: this many steps in a row with the same actions AND an unchanged tab.
 */
export const MAX_IDENTICAL_STEPS = 6;

/** Tools whose (large) output describes the page at one moment; older copies are dropped in batches. */
export const SNAPSHOT_TOOLS = new Set(['read_page', 'get_page_text', 'find']);

export const LIMITS = {
    maxToolResult: 20000,
    /**
     * Only the latest screenshot stays in the history. The previous one is always the most recent
     * image, near the end, so replacing it keeps nearly the whole prompt cached; keeping several and
     * dropping them in batches broke the cache far back (measured: 2-3× the cost on those calls) and
     * every kept image was re-sent with every call.
     */
    maxImages: 1,
    keepImages: 1,
    /** Page snapshots longer than snapshotMinChars: only the latest stays, for this many model turns. */
    maxSnapshots: 1,
    snapshotTurns: 3,
    snapshotMinChars: 1200,
    imageTokens: 1000,
    summaryAt: 0.75,
    keepShare: 0.35,
    defaultMaxInput: 32000,
};

export const OLD_SNAPSHOT = '[Older page snapshot removed. Call read_page or get_text again for the current page.]';

const encoder = new TextEncoder();
const textTokens = (s: string) => Math.ceil(encoder.encode(s).length / 3) + 4;

export function estimateTokens(m: ChatMessage): number {
    let n = 0;
    if (typeof m.content === 'string') n += textTokens(m.content);
    else for (const p of m.content) n += p.type === 'image_url' ? LIMITS.imageTokens : textTokens(p.text);
    if (m.role === 'assistant' && m.tool_calls) n += textTokens(JSON.stringify(m.tool_calls));
    return n;
}

const imageCount = (messages: ChatMessage[]) =>
    messages.reduce((n, m) => n + (m.role === 'user' && Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url').length : 0), 0);

/** Text-only copy of a message (for the summarizer and for storage). */
export function withoutImages(m: ChatMessage, placeholder = '[screenshot]'): ChatMessage {
    if (m.role !== 'user' || typeof m.content === 'string') return m;
    return { role: 'user', content: m.content.map((p) => (p.type === 'image_url' ? placeholder : p.text)).join('\n') };
}

export const NOTE_PREFIX = '[Message from the user while you were working]';

export class Agent {
    messages: ChatMessage[] = [];
    summary?: string;

    constructor(
        private readonly api: AgentApi,
        private readonly tools: ToolHost,
        private readonly system: () => string,
    ) {}

    reset() {
        this.messages = [];
        this.summary = undefined;
    }

    lastText(): string {
        for (let i = this.messages.length - 1; i >= 0; i--) {
            const m = this.messages[i];
            if (m.role === 'assistant' && m.content.trim()) return m.content;
        }
        return '';
    }

    async run(task: string | ContentPart[], ui: AgentUI, opts: AgentOptions, signal: AbortSignal): Promise<{ steps: number; hitLimit: boolean }> {
        this.messages.push({ role: 'user', content: task });

        const limit = opts.maxSteps > 0 ? opts.maxSteps : Infinity;
        let lastSignature = '';
        let repeats = 0;
        for (let step = 0; step < limit; step++) {
            if (signal.aborted) return { steps: step, hitLimit: false };
            this.addNotes();
            this.pruneImages();
            this.pruneSnapshots();
            await this.maybeSummarize(ui, signal, opts.maxInputTokens);

            const result = await this.callModel(ui, opts, signal);
            this.messages.push({ role: 'assistant', content: result.content, ...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {}) });
            if (!result.toolCalls.length) return { steps: step, hitLimit: false };

            let shot: Screenshot | undefined;
            let stale = false;
            for (const call of result.toolCalls) {
                if (result.finishReason === 'length' && !isCompleteJson(call.function.arguments)) {
                    const r: ToolResult = { output: 'Error: your reply was cut off while writing this action, so it was NOT done. Use shorter steps (for long text, type it in parts).', isError: true };
                    ui.toolStart(call);
                    ui.toolEnd(call, r);
                    this.messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: r.output });
                    continue;
                }
                if (signal.aborted) {
                    this.messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: 'Cancelled by the user.' });
                    continue;
                }
                ui.toolStart(call);
                let r: ToolResult;
                try {
                    r = await this.tools.execute(call, signal);
                } catch (e: any) {
                    if (e?.name === 'AbortError' || signal.aborted) r = { output: 'Cancelled by the user.', isError: true };
                    else r = { output: `Error: ${e?.message || String(e)}`, isError: true };
                }
                if (r.output.length > LIMITS.maxToolResult) {
                    r = { ...r, output: r.output.slice(0, LIMITS.maxToolResult) + `\n…[cut: ${r.output.length - LIMITS.maxToolResult} more characters]` };
                }
                ui.toolEnd(call, r);
                this.messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: r.output });
                if (r.image) { shot = r.image; stale = false; }
                if (r.observe) stale = true;
            }

            // One look at the tab after the whole step (an explicit screenshot followed by
            // actions is out of date, so take a new one).
            if (stale && !signal.aborted) {
                try {
                    shot = (await this.tools.screenshot(signal)) ?? undefined;
                } catch (e: any) {
                    if (e?.name !== 'AbortError' && !signal.aborted) ui.notice(`Couldn't take a screenshot: ${e?.message || e}`);
                }
            }
            if (limit === Infinity) {
                const signature = JSON.stringify(result.toolCalls.map((c) => [c.function.name, c.function.arguments])) + '|' + (shot ? fingerprint(shot.dataUrl) : '');
                repeats = signature === lastSignature ? repeats + 1 : 1;
                lastSignature = signature;
                if (repeats >= MAX_IDENTICAL_STEPS) {
                    ui.notice(`Stopped: Brisqal repeated the same actions ${MAX_IDENTICAL_STEPS} times and nothing on the page changed. Say "continue" to try again.`);
                    return { steps: step + 1, hitLimit: true };
                }
            }
            if (shot && !signal.aborted) {
                ui.screenshot?.(shot);
                this.messages.push({
                    role: 'user',
                    content: [
                        { type: 'image_url', image_url: { url: shot.dataUrl } },
                        { type: 'text', text: `[Screenshot of the tab now${shot.caption ? `: ${shot.caption}` : ''}, ${shot.width}×${shot.height} px. Continue the task.]` },
                    ],
                });
            }
        }
        ui.notice(`Stopped after ${opts.maxSteps} steps (the step limit in Settings). Say "continue" to keep going.`);
        return { steps: opts.maxSteps, hitLimit: true };
    }

    /** Messages the user typed while Brisqal worked join the conversation before the next model call. */
    private addNotes() {
        const notes = this.tools.takeNotes?.() ?? [];
        if (!notes.length) return;
        const text = notes.map((n) => `${NOTE_PREFIX} ${n}`).join('\n');
        const last = this.messages[this.messages.length - 1];
        if (last?.role === 'user') {
            const parts: ContentPart[] = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : [...last.content];
            parts.push({ type: 'text', text });
            this.messages[this.messages.length - 1] = { role: 'user', content: parts };
        } else {
            this.messages.push({ role: 'user', content: text });
        }
    }

    /** Replace all but the last keepImages screenshots with a short note (see LIMITS.maxImages). */
    pruneImages(): boolean {
        if (imageCount(this.messages) <= LIMITS.maxImages) return false;
        let keep = LIMITS.keepImages;
        for (let i = this.messages.length - 1; i >= 0; i--) {
            const m = this.messages[i];
            if (m.role !== 'user' || !Array.isArray(m.content)) continue;
            const parts: ContentPart[] = [];
            for (let j = m.content.length - 1; j >= 0; j--) {
                const p = m.content[j];
                if (p.type === 'image_url') {
                    if (keep > 0) { keep--; parts.unshift(p); } else parts.unshift({ type: 'text', text: '[older screenshot removed]' });
                } else parts.unshift(p);
            }
            this.messages[i] = { role: 'user', content: parts };
        }
        return true;
    }

    /**
     * Big page snapshots (read_page / get_page_text / find) go stale quickly: only the latest is kept,
     * and only for SNAPSHOT_TURNS model turns. Replaced while still near the end of the history,
     * they barely disturb the prompt cache; kept, they would be re-sent with every later call.
     */
    pruneSnapshots(): boolean {
        const big = this.messages
            .map((m, i) => (m.role === 'tool' && SNAPSHOT_TOOLS.has(m.name) && m.content.length >= LIMITS.snapshotMinChars ? i : -1))
            .filter((i) => i >= 0);
        if (!big.length) return false;
        const latest = big[big.length - 1];
        const turnsSince = this.messages.slice(latest + 1).filter((m) => m.role === 'assistant').length;
        const stale = big.slice(0, -1);
        if (turnsSince >= LIMITS.snapshotTurns) stale.push(latest);
        for (const i of stale) {
            const m = this.messages[i] as Extract<ChatMessage, { role: 'tool' }>;
            this.messages[i] = { ...m, content: OLD_SNAPSHOT };
        }
        return stale.length > 0;
    }

    /** Fold the older part of a long session into a summary (cut only where tool calls keep their results). */
    async maybeSummarize(ui: AgentUI, signal: AbortSignal, maxInputTokens = LIMITS.defaultMaxInput): Promise<boolean> {
        const fixed = textTokens(this.systemWithSummary()) + textTokens(JSON.stringify(this.tools.definitions()));
        const budget = Math.max(8000, Math.floor(maxInputTokens * LIMITS.summaryAt) - fixed);
        const total = this.messages.reduce((n, m) => n + estimateTokens(m), 0);
        if (total < budget) return false;

        const keepTokens = Math.max(6000, Math.floor(budget * LIMITS.keepShare));
        let cut = this.messages.length;
        let kept = 0;
        while (cut > 1 && kept + estimateTokens(this.messages[cut - 1]) <= keepTokens) {
            cut--;
            kept += estimateTokens(this.messages[cut]);
        }
        while (cut < this.messages.length && this.messages[cut].role === 'tool') cut++;
        if (cut >= this.messages.length) cut = this.messages.length - 1;
        while (cut > 0 && this.messages[cut].role === 'tool') cut--;
        if (cut <= 0) return false;

        let summary: string;
        try {
            summary = (await this.api.summarize(this.summary, this.messages.slice(0, cut).map((m) => withoutImages(m)), signal)).summary;
        } catch {
            return false;
        }
        if (!summary) return false;
        const rest = this.messages.slice(cut);
        this.summary = summary;
        this.messages = rest[0]?.role === 'user'
            ? rest
            : [{ role: 'user', content: '(The earlier part of this task is summarized in the system prompt. Continue from where you left off.)' }, ...rest];
        ui.notice('Summarized the earlier part of this task to keep it fast and economical.');
        return true;
    }

    private systemWithSummary(): string {
        return this.summary
            ? `${this.system()}\n\n# Summary of earlier work in this conversation\n(Older messages are not repeated; rely on this summary.)\n${this.summary}`
            : this.system();
    }

    private async callModel(ui: AgentUI, opts: AgentOptions, signal: AbortSignal) {
        for (let attempt = 0; attempt < 4; attempt++) {
            ui.turnStart();
            try {
                const res = await this.api.chat(
                    {
                        model: opts.model,
                        reasoning_effort: opts.effort,
                        purpose: 'browser',
                        messages: [{ role: 'system', content: this.systemWithSummary() }, ...this.messages],
                        tools: this.tools.definitions(),
                    },
                    { reasoning: (d) => ui.reasoning(d), content: (d) => ui.content(d) },
                    signal,
                );
                ui.turnEnd();
                if (res.plan) ui.plan(res.plan);
                return res;
            } catch (e) {
                ui.turnEnd();
                if (e instanceof ApiError && e.isContextTooLarge && this.compact(attempt)) {
                    ui.notice('Shortened the conversation to fit your plan\'s limit.');
                    continue;
                }
                throw e;
            }
        }
        throw new ApiError('This conversation is too long for your plan. Start a new task.', 413, 'context_too_large');
    }

    /** Emergency shrink after "context too large": drop screenshots, old tool output, old exchanges. */
    compact(level: number): boolean {
        const before = JSON.stringify(this.messages).length;
        const keepRecent = 6;
        // Keep only the very last screenshot.
        let seenImage = false;
        for (let i = this.messages.length - 1; i >= 0; i--) {
            const m = this.messages[i];
            if (m.role !== 'user' || !Array.isArray(m.content)) continue;
            if (!seenImage && m.content.some((p) => p.type === 'image_url')) { seenImage = true; continue; }
            this.messages[i] = withoutImages(m, '[older screenshot removed]');
        }
        this.messages = this.messages.map((m, i) =>
            m.role === 'tool' && i < this.messages.length - keepRecent && m.content.length > 400
                ? { ...m, content: m.content.slice(0, 400) + '\n…[older output removed]' }
                : m);
        for (let t = 0; t < level + 1; t++) {
            const userIdx = this.messages.map((m, i) => (m.role === 'user' && typeof m.content === 'string' && !m.content.startsWith(NOTE_PREFIX) ? i : -1)).filter((i) => i >= 0);
            if (userIdx.length < 2) break;
            this.messages = this.messages.slice(userIdx[1]);
        }
        return JSON.stringify(this.messages).length < before;
    }
}

function isCompleteJson(s: string): boolean {
    try {
        JSON.parse(s || '{}');
        return true;
    } catch {
        return false;
    }
}

/** Cheap fingerprint of a screenshot (identical images → identical value). */
export function fingerprint(dataUrl: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < dataUrl.length; i++) h = Math.imul(h ^ dataUrl.charCodeAt(i), 0x01000193);
    return `${dataUrl.length}:${(h >>> 0).toString(36)}`;
}
