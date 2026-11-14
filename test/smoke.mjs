/**
 * Smoke test of the production build (dist/, what goes into the store zip): Chrome accepts the
 * manifest, the service worker starts, and the side panel shows the sign-in screen without errors.
 * Run: npm run package && npm run test:smoke
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'brisqal-smoke-'));
const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: false, pipe: true, enableExtensions: true,
    userDataDir: profile, args: ['--no-first-run', '--no-default-browser-check'],
});
let ok = true;
try {
    const id = await browser.installExtension(path.join(ROOT, 'dist'));
    const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url() === `chrome-extension://${id}/background.js`, { timeout: 10000 });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`chrome-extension://${id}/sidepanel.html`);
    await page.waitForFunction(() => document.querySelector('[data-act="signIn"]'), { timeout: 10000 });
    const info = await page.evaluate(async () => ({
        title: document.querySelector('.gate-card h1')?.textContent,
        hook: 'brisqalTest' in globalThis || '__brisqalTest' in globalThis,
        commands: (await chrome.commands.getAll()).map((c) => `${c.name}=${c.shortcut || '(unset)'}`),
        version: chrome.runtime.getManifest().version,
    }));
    console.log(`service worker: ${sw.url()}\npanel: "${info.title}", version ${info.version}, shortcuts ${info.commands.join(', ')}`);
    if (info.title !== 'Brisqal for Chrome' || info.hook || errors.length) { ok = false; console.log('PROBLEM', info, errors); }
} catch (e) {
    ok = false;
    console.log('FAILED', e);
} finally {
    await browser.close();
    fs.rmSync(profile, { recursive: true, force: true });
}
console.log(ok ? 'smoke test passed' : 'smoke test FAILED');
process.exit(ok ? 0 : 1);
