/**
 * Service worker. Small on purpose: the agent runs in the side panel. This worker
 *  - opens the side panel when the toolbar button (or its shortcut) is used;
 *  - forwards the "stop" shortcut to the panel;
 *  - cleans up if a panel is closed in the middle of a task: lets go of the tabs it was
 *    controlling (Chrome's "controlled" bar) and removes the border from the page.
 */

// Every time the worker starts (install, update, browser start, wake-up): the toolbar button opens the panel.
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);

chrome.commands.onCommand.addListener((command) => {
    if (command === 'stop-task') void chrome.runtime.sendMessage({ type: 'brisqal:stop' }).catch(() => undefined);
});

/** Tabs each open panel has worked in during its current task. */
const panels = new Map<chrome.runtime.Port, { tabs: Set<number>; busy: boolean }>();

chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'panel') return;
    const state = { tabs: new Set<number>(), busy: false };
    panels.set(port, state);
    port.onMessage.addListener((m) => {
        if (m?.type === 'touched' && typeof m.tabId === 'number') state.tabs.add(m.tabId);
        if (m?.type === 'busy') {
            state.busy = !!m.busy;
            if (!state.busy) state.tabs.clear();
        }
    });
    port.onDisconnect.addListener(() => {
        panels.delete(port);
        if (state.busy) void release([...state.tabs]);
    });
});

async function release(tabIds: number[]) {
    for (const tabId of tabIds) {
        try { await chrome.debugger.detach({ tabId }); } catch { /* not attached */ }
        try {
            await chrome.scripting.executeScript({
                target: { tabId, frameIds: [0] },
                func: () => { (globalThis as any).__brisqal?.overlay(false); },
            });
        } catch { /* closed or not scriptable */ }
    }
}
