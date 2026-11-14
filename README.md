# Brisqal for Chrome

A Chrome extension (Manifest V3) that puts the Brisqal agent in Chrome's side panel. The user describes
a task. Brisqal reads the current tab, clicks, types, fills in forms, scrolls, navigates and opens tabs
until the task is done, and asks before anything risky.

It uses the same server API as Brisqal Code and Brisqal Desktop (`/api/ext/*`):
- Sign-in uses the browser approval flow with `client: chrome`, so the approval page says "Brisqal for Chrome".
- Model calls send `purpose: browser` and are metered as `usage_events.kind = browser`.

## How it works

| Part | File | Role |
|---|---|---|
| Side panel | `src/panel/main.ts` | UI: sign-in, consent, chat, approvals, settings, history. **The agent loop runs here**, so service-worker idle limits never cut a task off. Closing the panel stops the task. |
| Runner | `src/panel/runner.ts` | Starts and stops tasks, handles approvals, questions and messages typed mid-task, saves history. |
| Browser tools | `src/panel/browser.ts` | The tools (below). Mouse, keyboard and screenshots go through `chrome.debugger`. That input is *trusted*, so every site treats it like the user's own. If the debugger can't attach, there is a plain-script fallback. Brisqal's own cursor glides to each target before it clicks. The tabs it works in sit in a "Brisqal" tab group; the user's own tab leaves the group when the task ends. |
| Page script | `src/content/page.ts` | Injected on demand into the tab being worked on, in the isolated world, so the page can't see it. It provides: the page outline with numeric refs, `find`, page text, element locations, form setting, the password/payment guard, the border and cursor (hidden while screenshots are taken), and the change reports after actions. |
| Agent loop | `src/core/agent.ts` | Only the latest screenshot and the latest page outline stay in the history (outlines for 3 turns at most), rolling summary, stop on 6 identical steps on an unchanged page. |
| Service worker | `src/background.ts` | Opens the panel from the toolbar, forwards the stop shortcut, and cleans up if a panel closes mid-task (detaches the debugger, removes the border). |

**Tools:**
- `computer`: mouse and keyboard, with actions `left_click`, `double_click`, `triple_click`, `right_click`, `hover`, `drag`, `type`, `key`, `scroll`, `scroll_to`, `wait`, `screenshot`. It targets an element by ref, or a point in the latest screenshot.
- Reading: `read_page`, `find`, `get_page_text`.
- Other: `form_input`, `navigate`, `tabs`.
- Server-side: `read_webpage`, `web_search`.
- `ask_user`.

### Cost and speed (measured live, 2026-11-14)
Each model call re-sends the conversation, so the size of what stays in it is what costs money.
- **Text reports instead of screenshots.** After an action the model gets a short report of what changed:
  - new text, dialogs that opened or closed;
  - the clicked element's new state, or the field's value;
  - "no visible change".

  A screenshot follows only when the page changed a lot (a new page, a dialog, many new elements), after coordinate-based actions, or when the model asks for one.
- **Only the latest screenshot stays.** Older ones become a one-line note. The previous screenshot is always near the end, so replacing it keeps nearly the whole prompt cached. The old approach dropped screenshots in batches far back, which broke the cache; on those calls that cost 2–3×.
- **Screenshots** are at most 1024×768, about 1,000 tokens each. The cursor and border are hidden while one is taken.
- **`read_page`** describes the visible area plus half a screen, and counts the rest; reach it with `find` or by scrolling. Links have no addresses, and the outline is capped at 6,000 characters.
- **Fewer turns.** Actions wait until the page is quiet instead of fixed delays. The task message says which tab it starts in, and the prompt asks for predictable actions to be batched in one turn.
- **Results:**
  - The test form task went from 5 calls / $0.021 / 36 s to 4 calls / $0.012 / 15 s.
  - Each step now adds a few hundred tokens instead of about 1,500.

There is intentionally no "run JavaScript" tool. The Chrome Web Store forbids executing code that isn't in the package.

### Safety that doesn't depend on the model
- **Password, payment and one-time-code fields are never typed into.** This covers `type="password"`, `autocomplete` cc-*/one-time-code, matching names/labels, and cross-origin payment iframes. The model is told to ask the user instead.
- **Only http(s) pages.** `javascript:`, `file:`, `chrome://` and similar are refused. Chrome itself blocks the Web Store and browser pages.
- **Blocked sites** (Settings): never opened, read or acted on, subdomains included.
- **Permission modes.** Default: act, and ask before risky steps.
  - "Ask before acting" asks before every page-changing action.
  - Closing a tab Brisqal didn't open asks, except in "Act without asking".
- **The user can always stop it:**
  - the Stop button or Esc in the panel;
  - Alt+Shift+Q from anywhere (Ctrl+Shift+Y opens the panel);
  - "Cancel" on Chrome's "controlled by" bar, which stops the task.
- **Consent first.** A one-time "Before you start" screen (`CONSENT_VERSION` in `src/panel/store.ts`) must be accepted before anything is read.
- **Nothing is read between tasks.** The page script is injected only while a task runs, and the debugger is detached when the task ends.
- **No screenshots in history.** Saved history (in `chrome.storage.local`) has no screenshots, and long tool output is shortened before saving.

### Branding
The bundle must never contain provider names. `esbuild.mjs` fails the build if one appears. The identity
rules are added to the system prompt on the server (`ExtApiController::withIdentity`).

## Develop

```bash
npm install
npm run build        # → dist/ (load it in chrome://extensions → Developer mode → Load unpacked)
npm run watch        # rebuild on change (then click ⟳ on the extension card)
npm run typecheck
npm test             # unit tests: agent loop, keys, addresses, stream parsing, prompt (no browser)
npm run test:e2e     # real Chrome under Xvfb: every tool on local test pages, approvals, a scripted task, cleanup
npm run package      # production build + release/brisqal-chrome-<version>.zip for the Chrome Web Store
npm run test:smoke   # loads the production build (dist/) in Chrome: manifest, worker, sign-in screen, shortcuts
```

**End-to-end tests:**
- They use the installed Google Chrome (`CHROME_PATH` to override) through `puppeteer-core`. The extension is loaded with `browser.installExtension`, because branded Chrome ignores `--load-extension`.
- Test builds go to `out/ext` and expose a test hook (`__brisqalTest`). Production builds don't.
- Add a live run with a real model:
  `BRISQAL_SERVER=http://127.0.0.1:8000 BRISQAL_TOKEN=<an ext token> npm run test:e2e`
- Make the token with
  `php artisan tinker --execute="echo App\Models\User::where('email','…')->first()->createToken('e2e', ['ext'])->plainTextToken;"`
  and delete it afterwards.

The default server is `https://brisqal.codespeedy.com`. Change it on the sign-in screen (under "Server") or in Settings.

## Publish on the Chrome Web Store

1. Raise `version` in `package.json`, then run `npm run package && npm run test:smoke`.
2. Make sure the server is deployed with `client: chrome` / `purpose: browser` support, and the Privacy Policy and Terms that cover Brisqal for Chrome.
3. Upload `release/brisqal-chrome-<version>.zip` in the Chrome Web Store Developer Dashboard. Fill in the listing from `store/LISTING.md`.
