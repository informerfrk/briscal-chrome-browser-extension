# Brisqal for Chrome: Chrome Web Store submission kit

Everything to paste into the Chrome Web Store Developer Dashboard, in the order the dashboard asks for it.
Never mention any AI provider or model vendor in the listing.

**Before you submit:**
- The Brisqal server must accept this extension (sign-in `client: chrome`, metering `purpose: browser`).
- The live Privacy Policy must describe the extension. Reviewers check that it matches the "Privacy practices" answers below.
- Have a test account with an active plan ready for the reviewers (section 5).

---

## 1. Package
Upload `release/brisqal-chrome-<version>.zip`. Build it with `npm run package`. Each upload needs a higher `version` in `package.json`.

## 2. Store listing

**Name:** Brisqal for Chrome (from the manifest)

**Summary** (from the manifest, up to 132 characters):
> Your AI helper in the browser. Brisqal reads pages, clicks, types and fills in forms for you, and asks before anything risky.

**Description:**
> Brisqal for Chrome is an AI assistant that does tasks in your browser for you. Open it in the side panel, describe what you need in plain words, and Brisqal reads the page, clicks, types, fills in forms and opens tabs, step by step, while you watch its cursor at work.
>
> What you can ask for:
> • "Summarize this article in five bullet points."
> • "Fill in this form with my details. Ask me for anything you need."
> • "Find the three best-reviewed headphones under $200 and compare them in a table."
> • "Find the contact email and opening hours on this website."
> • "List my open tabs grouped by topic and spot the duplicates."
>
> You stay in control:
> • Brisqal works only in the tab where you give it a task, and only while the task runs.
> • It asks before anything risky, like buying, sending, posting or deleting.
> • It never types passwords, card details or one-time codes. It asks you to enter them yourself and then carries on.
> • Stop it at any time with the stop button, Alt+Shift+Q, or "Cancel" on Chrome's bar.
> • Choose how much it may do on its own: ask before every action, ask before risky steps, or act without asking.
> • Block sites you never want it to touch.
>
> Built for long tasks: Brisqal keeps working until the job is done, and you can add instructions while it works.
>
> Brisqal for Chrome needs a Brisqal account with an active plan. Sign in with your browser; your password never goes through the extension. While a task runs, the content of the tab Brisqal works in and screenshots of it are sent securely to Brisqal's servers so the AI can decide the next step. They are not stored in your account. See the Privacy Policy for details.

**Category:** Productivity → Tools (or "Workflow & Planning")

**Language:** English

**Graphics:**
- **Store icon:** 128×128, `static/icons/icon128.png`.
- **Screenshots:** 1280×800, at least 1, up to 5. Take them in Chrome with the side panel open on a real site:
  1. A task in progress: the transcript in the panel, with Brisqal's cursor and the glowing border on the page.
  2. The "Before you start" consent screen.
  3. An approval card ("Click button … ?") in "Ask before acting" mode.
  4. A finished summary or comparison table in the panel.
- **Small promo tile:** 440×280, optional. The logo plus "Your AI helper in the browser".

**Official URL / homepage:** https://brisqal.codespeedy.com
**Support URL:** https://brisqal.codespeedy.com (or the support email)

## 3. Privacy practices

**Single purpose:**
> Brisqal for Chrome is an AI assistant in the side panel that completes browsing tasks the user asks for (reading, clicking, typing and filling in forms in the current tab) and shows the results.

**Permission justifications:**

| Permission | Justification |
|---|---|
| `sidePanel` | The assistant's chat interface lives in Chrome's side panel. |
| `tabs` | To know which tab the user is on, show its title in the panel, and open, switch to and close tabs as part of the user's task. |
| `tabGroups` | To put the tabs Brisqal is working in into a "Brisqal" tab group, so the user can see which tabs it controls. |
| `scripting` | To read the content of the tab the user asked Brisqal to work in (text, links, form fields) and to fill in forms there. The script is injected only while a task runs, and only into that tab. |
| `debugger` | To click, type and take screenshots in the tab the user asked Brisqal to work in, the same way the user would. Many sites ignore simulated clicks and typing from scripts, so trusted input through the debugger protocol is needed to complete tasks reliably. It is attached only while a task runs and detached when the task ends; Chrome shows its "controlled" bar meanwhile, and "Cancel" stops the task. |
| `storage` | To keep the user's settings, sign-in token and local task history (without screenshots). |
| Host permission `<all_urls>` | The user can ask for a task on any website, so the extension must be able to read and act on whichever site the current tab shows. It reads a page only while the user's task runs in that tab. It also calls the Brisqal server. |

**Remote code:** "No, I am not using remote code." All JavaScript is in the package; the extension doesn't run code it downloads, and it has no tool for running scripts in pages.

**Data usage.** Tick what is collected:
- **Website content:** yes. Text, form fields and screenshots of the tab Brisqal works in, during a task.
- **User activity:** yes. The actions Brisqal performs on pages during a task: clicks, typing and navigation.
- **Web history:** yes. The addresses and titles of pages Brisqal works on during a task.
- **Personally identifiable information:** yes. The account's name and email address. Pages may also show personal data.
- **Authentication information:** no. Passwords are never typed or collected by the extension; sign-in happens on the Brisqal website.
- **Personal communications:** only if the user asks Brisqal to work on an email or messaging page. To be safe, tick it.
- **Financial and payment information:** no. Card fields are refused.
- **Health information:** no.
- **Location:** no.

**Certifications.** Tick all three:
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** https://brisqal.codespeedy.com/legal/privacy

## 4. Distribution
- **Visibility:** Public. Use Unlisted first if you want a private test with real users.
- **Regions:** all regions, or only the ones you serve.
- **Pricing:** free. Plans are bought on the Brisqal website.

## 5. Notes for the reviewer (Test instructions)

> Brisqal for Chrome needs a Brisqal account with an active plan. Test account (plan active, terms accepted):
> Email: <REVIEWER_EMAIL>   Password: <REVIEWER_PASSWORD>
>
> 1. Click the Brisqal icon in the toolbar (or press Ctrl+Shift+Y) to open the side panel.
> 2. Click "Sign in with Brisqal". A tab opens on the Brisqal website: sign in with the test account and click "Authorize". The panel signs in within a few seconds and closes that tab.
> 3. Click "Allow and continue" on the "Before you start" screen.
> 4. Open any article (for example a Wikipedia page) and type "Summarize this page in 5 bullet points".
> 5. To see it act: open a page with a search box and type "Search this site for 'privacy' and open the first result". Chrome shows the "controlled" bar while it works; "Cancel" there, the stop button or Alt+Shift+Q stops it.
>
> Why the debugger permission: it is the only way to send trusted clicks and key presses and capture the tab, which sites require. It is attached only during a task the user started, in the tab they chose.
