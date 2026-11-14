import type { ToolDefinition } from './api';

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDefinition =>
    ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });

export const COMPUTER_ACTIONS = ['left_click', 'double_click', 'triple_click', 'right_click', 'hover', 'drag', 'type', 'key', 'scroll', 'scroll_to', 'wait', 'screenshot'] as const;
export type ComputerAction = typeof COMPUTER_ACTIONS[number];

/** computer actions that change the page (need approval in "Ask before acting" mode). */
export const ACTING = new Set<string>(['left_click', 'double_click', 'triple_click', 'right_click', 'drag', 'type', 'key']);

/**
 * Tool list. The order and wording never change between calls (keeps the prompt cacheable,
 * so repeated input is billed at the cheap cached rate). Kept short: it is sent with every call.
 */
export function toolDefinitions(opts: { webSearch: boolean }): ToolDefinition[] {
    const defs: ToolDefinition[] = [
        fn('computer',
            'Use the mouse and keyboard in the current tab, like a person. Target an element by ref (from read_page/find; preferred) or by x,y in the latest screenshot. After each action you get a short text report of what changed; you get a screenshot only when the page changes a lot (or use action "screenshot"). Do several predictable actions in one turn.',
            {
                action: { type: 'string', enum: COMPUTER_ACTIONS, description: 'left_click/double_click/triple_click/right_click/hover: at ref or x,y. drag: to to_ref or to_x,to_y. type: text into ref or the focused field. key: a key or shortcut. scroll: direction at ref/x,y/page. scroll_to: bring ref into view. wait: seconds or for_text. screenshot: look at the tab.' },
                ref: { type: 'integer' },
                x: { type: 'integer' },
                y: { type: 'integer' },
                to_ref: { type: 'integer' },
                to_x: { type: 'integer' },
                to_y: { type: 'integer' },
                text: { type: 'string', description: 'type: the text (\\n presses Enter). Passwords, card numbers and codes are refused.' },
                clear: { type: 'boolean', description: 'type: replace the field\'s current text' },
                keys: { type: 'string', description: 'key: e.g. "Enter", "Escape", "Tab", "ctrl+a", "ArrowDown"' },
                repeat: { type: 'integer', description: 'key: times (max 20)' },
                modifiers: { type: 'string', description: 'clicks: keys to hold, e.g. "ctrl"' },
                direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
                amount: { type: 'number', description: 'scroll: screens (default 0.8)' },
                seconds: { type: 'number', description: 'wait: max 30' },
                for_text: { type: 'string', description: 'wait: until this text is on the page' },
            }, ['action']),
        fn('read_page',
            'The current tab\'s headings and interactive elements (links, buttons, fields, menus) with refs for computer/form_input. Elements beyond the visible area are summarized; scroll or use find for them.',
            {
                filter: { type: 'string', enum: ['interactive', 'all'], description: 'interactive (default, smallest) or all (also text)' },
                ref: { type: 'integer', description: 'Only this part of the page (a form, dialog, list…)' },
            }),
        fn('find', 'Find elements by text, label or purpose (e.g. "search box", "Add to cart"). Returns refs. Cheaper than read_page.',
            { query: { type: 'string' } }, ['query']),
        fn('get_page_text', 'The page\'s text (articles, results, emails), in parts: pass offset for the next part. Cheaper than screenshots for reading.',
            { offset: { type: 'integer' } }),
        fn('form_input', 'Set a form control directly: a dropdown option (by its text), a checkbox or radio ("true"/"false"), or a date, time, number, range or color value.',
            { ref: { type: 'integer' }, value: { type: 'string' } }, ['ref', 'value']),
        fn('navigate', 'Open an address in the current tab, or "back", "forward", "reload". Other words are searched on the web.',
            { url: { type: 'string' } }, ['url']),
        fn('tabs', 'Tabs in this window: list, open (becomes the current tab), switch, close.',
            {
                action: { type: 'string', enum: ['list', 'open', 'switch', 'close'] },
                tab_id: { type: 'integer' },
                url: { type: 'string' },
            }, ['action']),
        fn('read_webpage', 'Fetch a public page\'s text in the background, without opening it (no sign-in state).',
            { url: { type: 'string' } }, ['url']),
    ];
    if (opts.webSearch) defs.push(fn('web_search', 'Search the web for current information.', { query: { type: 'string' } }, ['query']));
    defs.push(fn('ask_user',
        'Ask the user and wait for the answer: before anything irreversible or sensitive they didn\'t explicitly ask for, for information only they have, or when they must act themselves (password, code, CAPTCHA, sign-in).',
        { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' }, description: 'Optional answer buttons' } },
        ['question']));
    return defs;
}
