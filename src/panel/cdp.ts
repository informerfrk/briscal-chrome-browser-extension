/**
 * chrome.debugger wrapper. Trusted mouse and keyboard input (sites treat it exactly like the user's)
 * and screenshots go through Chrome's debugger protocol. While attached, Chrome shows a bar
 * saying that Brisqal is controlling the browser; we attach only while a task runs and detach at
 * the end. Pressing "Cancel" on that bar is treated as the user taking back control.
 */

export class Debugger {
    private attached = new Set<number>();
    /** Why the last attach failed (shown to the model and the user). */
    lastError = '';
    onUserCancel?: (tabId: number) => void;

    constructor() {
        chrome.debugger.onDetach.addListener((src, reason) => {
            if (src.tabId === undefined) return;
            const was = this.attached.delete(src.tabId);
            if (was && reason === 'canceled_by_user') this.onUserCancel?.(src.tabId);
        });
    }

    isAttached(tabId: number) {
        return this.attached.has(tabId);
    }

    async attach(tabId: number): Promise<boolean> {
        if (this.attached.has(tabId)) return true;
        try {
            await chrome.debugger.attach({ tabId }, '1.3');
            this.attached.add(tabId);
            return true;
        } catch (e: any) {
            const msg = String(e?.message ?? e);
            // Already attached by this extension (e.g. from the side panel in another window).
            if (/already attached/i.test(msg)) {
                try {
                    await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: '1' });
                    this.attached.add(tabId);
                    return true;
                } catch { /* attached by someone else */ }
            }
            this.lastError = msg;
            return false;
        }
    }

    async send<T = any>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
        return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
    }

    async detach(tabId: number) {
        if (!this.attached.delete(tabId)) return;
        try { await chrome.debugger.detach({ tabId }); } catch { /* tab closed */ }
    }

    async detachAll() {
        await Promise.all([...this.attached].map((t) => this.detach(t)));
    }
}
