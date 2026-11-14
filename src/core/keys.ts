/**
 * Key combos written by the model ("ctrl+a", "Enter", "shift+Tab", "cmd+c") → the key events that
 * Chrome's debugger protocol needs (Input.dispatchKeyEvent). Pure functions, unit-tested.
 */

export interface KeyEvent {
    type: 'keyDown' | 'rawKeyDown' | 'keyUp';
    key: string;
    code: string;
    windowsVirtualKeyCode: number;
    nativeVirtualKeyCode: number;
    modifiers: number;
    text?: string;
    unmodifiedText?: string;
    location?: number;
    /** Editing commands (macOS only: there, key events alone don't run Cmd+A/C/V/X/Z). */
    commands?: string[];
}

interface KeyDef { key: string; code: string; keyCode: number; text?: string; shiftKey?: string; location?: number }

const MOD_BITS = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;
type Mod = keyof typeof MOD_BITS;
const MOD_DEFS: Record<Mod, KeyDef> = {
    alt: { key: 'Alt', code: 'AltLeft', keyCode: 18, location: 1 },
    ctrl: { key: 'Control', code: 'ControlLeft', keyCode: 17, location: 1 },
    meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91, location: 1 },
    shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16, location: 1 },
};
const MOD_ORDER: Mod[] = ['ctrl', 'meta', 'alt', 'shift'];

const ALIASES: Record<string, string> = {
    control: 'ctrl', ctl: 'ctrl', cmd: 'meta', command: 'meta', win: 'meta', windows: 'meta', super: 'meta', os: 'meta',
    option: 'alt', opt: 'alt',
    return: 'enter', ret: 'enter', esc: 'escape', del: 'delete', ins: 'insert',
    bksp: 'backspace', back_space: 'backspace',
    pgup: 'pageup', page_up: 'pageup', pgdn: 'pagedown', page_down: 'pagedown',
    up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright',
    spacebar: 'space', ' ': 'space',
    plus: '+', minus: '-', equal: '=', equals: '=', comma: ',', period: '.', dot: '.', slash: '/', backslash: '\\',
    semicolon: ';', quote: "'", apostrophe: "'", grave: '`', backtick: '`', bracketleft: '[', bracketright: ']',
};

const NAMED: Record<string, KeyDef> = {
    enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
    tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
    escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
    backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
    insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
    home: { key: 'Home', code: 'Home', keyCode: 36 },
    end: { key: 'End', code: 'End', keyCode: 35 },
    pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
    pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
    arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
    contextmenu: { key: 'ContextMenu', code: 'ContextMenu', keyCode: 93 },
    ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, { key: `F${i + 1}`, code: `F${i + 1}`, keyCode: 112 + i }])),
};

const PUNCT: Record<string, KeyDef> = {
    ',': { key: ',', code: 'Comma', keyCode: 188, text: ',', shiftKey: '<' },
    '.': { key: '.', code: 'Period', keyCode: 190, text: '.', shiftKey: '>' },
    '/': { key: '/', code: 'Slash', keyCode: 191, text: '/', shiftKey: '?' },
    ';': { key: ';', code: 'Semicolon', keyCode: 186, text: ';', shiftKey: ':' },
    "'": { key: "'", code: 'Quote', keyCode: 222, text: "'", shiftKey: '"' },
    '[': { key: '[', code: 'BracketLeft', keyCode: 219, text: '[', shiftKey: '{' },
    ']': { key: ']', code: 'BracketRight', keyCode: 221, text: ']', shiftKey: '}' },
    '\\': { key: '\\', code: 'Backslash', keyCode: 220, text: '\\', shiftKey: '|' },
    '-': { key: '-', code: 'Minus', keyCode: 189, text: '-', shiftKey: '_' },
    '=': { key: '=', code: 'Equal', keyCode: 187, text: '=', shiftKey: '+' },
    '+': { key: '+', code: 'Equal', keyCode: 187, text: '+' },
    '`': { key: '`', code: 'Backquote', keyCode: 192, text: '`', shiftKey: '~' },
};

const SHIFTED_DIGITS = ')!@#$%^&*(';

function lookup(k: string): KeyDef | null {
    if (NAMED[k]) return NAMED[k];
    if (PUNCT[k]) return PUNCT[k];
    if (/^[a-z]$/.test(k)) return { key: k, code: `Key${k.toUpperCase()}`, keyCode: k.toUpperCase().charCodeAt(0), text: k, shiftKey: k.toUpperCase() };
    if (/^[0-9]$/.test(k)) return { key: k, code: `Digit${k}`, keyCode: k.charCodeAt(0), text: k, shiftKey: SHIFTED_DIGITS[Number(k)] };
    return null;
}

export interface Combo { mods: Mod[]; key: KeyDef }

/** "Ctrl + Shift + T" → modifiers + one key. Throws on unknown keys (the model gets the message). */
export function parseCombo(combo: string, platform: 'mac' | 'other' = 'other'): Combo {
    const raw = String(combo ?? '').trim();
    if (!raw) throw new Error('No key given.');
    const parts = raw === '+' ? ['+'] : raw.replace(/\+\+$/, '+plus').split(/\s*\+\s*/).filter((p) => p !== '');
    const mods = new Set<Mod>();
    let key: KeyDef | null = null;
    for (const p of parts) {
        const lower = p.toLowerCase();
        let k = ALIASES[lower] ?? lower;
        // On a Mac, page shortcuts use Cmd where Windows and Linux use Ctrl.
        if (k === 'ctrl' && platform === 'mac') k = 'meta';
        if (k in MOD_BITS) { mods.add(k as Mod); continue; }
        if (key) throw new Error(`"${raw}" has more than one key. Press one combination at a time.`);
        // Single printable characters keep their case: "A" means shift+a.
        if (p.length === 1 && /[A-Z]/.test(p)) { mods.add('shift'); k = p.toLowerCase(); }
        key = lookup(k);
        if (!key) throw new Error(`Unknown key "${p}". Use names like Enter, Escape, Tab, Space, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown, F1-F12, a letter or digit, with ctrl, alt, shift or meta.`);
    }
    if (!key) {
        // Only modifiers ("shift"): press the last one on its own.
        const last = parts[parts.length - 1].toLowerCase();
        const m = ((ALIASES[last] ?? last) === 'ctrl' && platform === 'mac' ? 'meta' : (ALIASES[last] ?? last)) as Mod;
        mods.delete(m);
        return { mods: MOD_ORDER.filter((x) => mods.has(x)), key: MOD_DEFS[m] };
    }
    return { mods: MOD_ORDER.filter((x) => mods.has(x)), key };
}

const MAC_COMMANDS: Record<string, string> = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo' };

/** The full down/up sequence for one combo. */
export function keyEvents(combo: string, platform: 'mac' | 'other' = 'other'): KeyEvent[] {
    const { mods, key } = parseCombo(combo, platform);
    const events: KeyEvent[] = [];
    let bits = 0;
    for (const m of mods) {
        bits |= MOD_BITS[m];
        const d = MOD_DEFS[m];
        events.push({ type: 'rawKeyDown', key: d.key, code: d.code, windowsVirtualKeyCode: d.keyCode, nativeVirtualKeyCode: d.keyCode, modifiers: bits, location: d.location });
    }
    const shift = mods.includes('shift');
    const command = mods.includes('ctrl') || mods.includes('meta') || mods.includes('alt');
    const keyName = shift && key.shiftKey ? key.shiftKey : key.key;
    const text = command ? undefined : key.key === 'Enter' ? '\r' : shift && key.shiftKey ? key.shiftKey : key.text;
    const base = { key: keyName, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode, modifiers: bits, ...(key.location ? { location: key.location } : {}) };
    const down: KeyEvent = { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}) };
    if (platform === 'mac' && mods.includes('meta')) {
        const cmd = key.key === 'z' && shift ? 'redo' : MAC_COMMANDS[key.key];
        if (cmd) down.commands = [cmd];
    }
    events.push(down, { type: 'keyUp', ...base });
    for (const m of [...mods].reverse()) {
        bits &= ~MOD_BITS[m];
        const d = MOD_DEFS[m];
        events.push({ type: 'keyUp', key: d.key, code: d.code, windowsVirtualKeyCode: d.keyCode, nativeVirtualKeyCode: d.keyCode, modifiers: bits, location: d.location });
    }
    return events;
}

/** Modifier bitmask for mouse events ("ctrl+shift" → 10). */
export function modifierBits(spec: string | undefined, platform: 'mac' | 'other' = 'other'): number {
    if (!spec) return 0;
    let bits = 0;
    for (const p of String(spec).split(/\s*\+\s*|\s*,\s*|\s+/).filter(Boolean)) {
        const lower = p.toLowerCase();
        let k = ALIASES[lower] ?? lower;
        if (k === 'ctrl' && platform === 'mac') k = 'meta';
        if (!(k in MOD_BITS)) throw new Error(`Unknown modifier "${p}". Use ctrl, alt, shift or meta.`);
        bits |= MOD_BITS[k as Mod];
    }
    return bits;
}
