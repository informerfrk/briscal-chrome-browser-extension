/**
 * HTTP client for the Brisqal server. Plain fetch, no chrome.* APIs, so it can be unit-tested.
 * The extension uses the same agent API as the VS Code extension and Brisqal Desktop (/api/ext/*);
 * its model calls are metered as "browser".
 */

export interface PlanStatus {
    plan: string | null;
    plan_name: string | null;
    unlimited: boolean;
    can_send: boolean;
    reason: 'no_plan' | 'daily_limit' | 'usage_limit' | null;
    percent_used: number;
    window_label?: string;
    resets_at: string | null;
    period_end: string | null;
}

export interface MeResponse {
    user: { name: string; email: string };
    usage: PlanStatus;
    /** `efforts`: the effort ids this model supports. */
    models: { id: string; label: string; description: string; efforts?: string[]; cost?: string; cost_label?: string }[];
    efforts: { id: string; label: string }[];
    default_model: string;
    default_effort: string;
    web_search: boolean;
    limits?: { max_input_tokens?: Record<string, number> };
    links: { pricing: string; billing: string; chat: string };
}

export interface ToolCall {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
}

export type ContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } };

export type ChatMessage =
    | { role: 'system'; content: string }
    | { role: 'user'; content: string | ContentPart[] }
    | { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
    | { role: 'tool'; tool_call_id: string; name: string; content: string };

export interface ToolDefinition {
    type: 'function';
    function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
    model?: string;
    reasoning_effort?: string;
    max_output_tokens?: number;
    purpose?: 'browser';
    messages: ChatMessage[];
    tools?: ToolDefinition[];
}

export interface ChatResult {
    content: string;
    reasoning: string;
    toolCalls: ToolCall[];
    finishReason: string | null;
    plan?: PlanStatus;
}

export interface DeviceStart {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
}

export class ApiError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly code: string | null = null,
        readonly data: any = null,
    ) {
        super(message);
    }

    get isAuth() { return this.status === 401 || this.status === 403; }
    get isPlan() { return this.status === 402; }
    get isContextTooLarge() { return this.status === 413; }
}

/** What the agent loop needs from the server (a fake in tests). */
export interface AgentApi {
    chat(req: ChatRequest, on: { reasoning?: (d: string) => void; content?: (d: string) => void }, signal?: AbortSignal): Promise<ChatResult>;
    summarize(summary: string | undefined, messages: ChatMessage[], signal?: AbortSignal): Promise<{ summary: string }>;
}

export class ApiClient implements AgentApi {
    constructor(
        private readonly baseUrl: () => string,
        private readonly token: () => string | undefined,
    ) {}

    private url(path: string) {
        return this.baseUrl().replace(/\/+$/, '') + path;
    }

    private headers(): Record<string, string> {
        const h: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' };
        const t = this.token();
        if (t) h.Authorization = `Bearer ${t}`;
        return h;
    }

    private networkError(e: any): ApiError {
        return new ApiError(`Can't reach the Brisqal server at ${this.baseUrl()} (${e?.message || e}). Check your internet connection and the server address in Settings.`, 0, 'network');
    }

    private async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
        let res: Response;
        try {
            res = await fetch(this.url(path), { method, headers: this.headers(), body: body ? JSON.stringify(body) : undefined, signal, credentials: 'omit' });
        } catch (e: any) {
            if (e?.name === 'AbortError') throw e;
            throw this.networkError(e);
        }
        const data: any = await res.json().catch(() => ({}));
        if (!res.ok) throw new ApiError(data.message || data.error || `HTTP ${res.status}`, res.status, data.error ?? null, data);
        return data as T;
    }

    // ---- sign-in (device flow: approve in a browser tab) ---------------------------------
    startDeviceAuth(info: { client_name: string; client_version: string; hostname: string }) {
        return this.request<DeviceStart>('POST', '/api/ext/auth/start', { ...info, client: 'chrome' });
    }

    /** Resolves with the token, or null while still pending. Throws on denial/expiry. */
    async pollDeviceAuth(deviceCode: string): Promise<{ access_token: string; user: { name: string; email: string } } | null> {
        try {
            return await this.request('POST', '/api/ext/auth/poll', { device_code: deviceCode });
        } catch (e) {
            if (e instanceof ApiError && e.code === 'authorization_pending') return null;
            throw e;
        }
    }

    logout() {
        return this.request('POST', '/api/ext/auth/logout');
    }

    me() {
        return this.request<MeResponse>('GET', '/api/ext/me');
    }

    summarize(summary: string | undefined, messages: ChatMessage[], signal?: AbortSignal) {
        return this.request<{ summary: string }>('POST', '/api/ext/summarize', { summary: summary ?? null, messages }, signal);
    }

    webSearch(query: string, signal?: AbortSignal) {
        return this.request<{ content: string; sources: { title: string; url: string }[] }>('POST', '/api/ext/tools/web_search', { query }, signal);
    }

    readWebpage(url: string, signal?: AbortSignal) {
        return this.request<{ url: string; title: string; text: string }>('POST', '/api/ext/tools/read_webpage', { url }, signal);
    }

    /** One model call, streamed (SSE). Deltas are reported through callbacks. */
    async chat(
        req: ChatRequest,
        on: { reasoning?: (d: string) => void; content?: (d: string) => void },
        signal?: AbortSignal,
    ): Promise<ChatResult> {
        let res: Response;
        try {
            res = await fetch(this.url('/api/ext/chat'), {
                method: 'POST',
                headers: { ...this.headers(), Accept: 'text/event-stream' },
                body: JSON.stringify(req),
                signal,
                credentials: 'omit',
            });
        } catch (e: any) {
            if (e?.name === 'AbortError') throw e;
            throw this.networkError(e);
        }
        if (!res.ok || !res.body) {
            const data: any = await res.json().catch(() => ({}));
            throw new ApiError(data.message || `HTTP ${res.status}`, res.status, data.error ?? null, data);
        }
        return parseStream(res.body, on);
    }
}

/** Reads the server's SSE stream (event: reasoning|content|tool_progress|done|error). Comment lines are ignored. */
export async function parseStream(
    body: ReadableStream<Uint8Array>,
    on: { reasoning?: (d: string) => void; content?: (d: string) => void },
): Promise<ChatResult> {
    const result: ChatResult = { content: '', reasoning: '', toolCalls: [], finishReason: null };
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let done = false;
    while (!done) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            let event = 'message';
            let data = '';
            for (const line of block.split('\n')) {
                if (line.startsWith('event:')) event = line.slice(6).trim();
                else if (line.startsWith('data:')) data += line.slice(5).trim();
            }
            if (!data) continue;
            const payload = JSON.parse(data);
            switch (event) {
                case 'reasoning': result.reasoning += payload.d; on.reasoning?.(payload.d); break;
                case 'content': result.content += payload.d; on.content?.(payload.d); break;
                case 'done':
                    result.toolCalls = payload.tool_calls || [];
                    result.finishReason = payload.finish_reason;
                    result.plan = payload.plan;
                    done = true;
                    break;
                case 'error': throw new ApiError(payload.message || 'The AI service had a problem. Please try again.', 502, 'upstream');
            }
        }
    }
    if (!done) throw new ApiError('The connection to the server was interrupted.', 0, 'network');
    return result;
}
