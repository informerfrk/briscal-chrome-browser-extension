import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const tests = process.argv.includes('--tests');

// Test builds go to out/ext (with a test hook in the panel); real builds to dist/.
const outdir = tests ? 'out/ext' : 'dist';
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

const common = {
    bundle: true,
    sourcemap: production ? false : 'inline',
    minify: production,
    logLevel: 'warning',
    platform: 'browser',
    format: 'iife',
    target: 'chrome116',
    define: { __TEST__: tests ? 'true' : 'false' },
};
const builds = [
    { ...common, entryPoints: ['src/background.ts'], outfile: `${outdir}/background.js` },
    { ...common, entryPoints: ['src/panel/main.ts'], outfile: `${outdir}/sidepanel.js` },
    // The page script is injected into web pages: never inline a source map there.
    { ...common, sourcemap: false, entryPoints: ['src/content/page.ts'], outfile: `${outdir}/content.js` },
];
if (tests) {
    builds.push({ ...common, platform: 'node', format: 'cjs', target: 'node20', define: {}, entryPoints: ['test/core.test.ts'], outfile: 'out/test/core.test.js' });
}

// Production builds start clean (no leftovers from development builds in the package).
if (production) fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(`${outdir}/icons`, { recursive: true });

function copyStatic() {
    for (const f of ['sidepanel.html', 'sidepanel.css']) fs.copyFileSync(`static/${f}`, `${outdir}/${f}`);
    for (const f of fs.readdirSync('static/icons')) fs.copyFileSync(`static/icons/${f}`, `${outdir}/icons/${f}`);
    const manifest = JSON.parse(fs.readFileSync('static/manifest.json', 'utf8'));
    manifest.version = pkg.version;
    fs.writeFileSync(`${outdir}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
}

/** Users must never see which providers power Brisqal: fail the build if a name slipped into the bundle. */
function brandCheck() {
    // Assembled from pieces so this file itself never spells the names (Tailwind scans the whole project).
    const names = [['ki', 'mi'], ['moon', 'shot'], ['deep', 'seek'], ['cla', 'ude'], ['anthro', 'pic'], ['\\bop', 'us\\b'], ['bra', 've']];
    const banned = new RegExp(names.map((n) => n.join('')).join('|'), 'i');
    const bad = [];
    const walk = (dir) => {
        for (const f of fs.readdirSync(dir)) {
            const p = path.join(dir, f);
            if (fs.statSync(p).isDirectory()) walk(p);
            else if (/\.(js|html|css|json)$/.test(f)) {
                const text = fs.readFileSync(p, 'utf8');
                const m = text.match(banned);
                if (m) bad.push(`${p}: "${text.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, ' ')}"`);
            }
        }
    };
    walk(outdir);
    if (bad.length) {
        console.error(`Provider names found in the extension:\n${bad.join('\n')}`);
        process.exit(1);
    }
}

copyStatic();
if (watch) {
    for (const b of builds) (await esbuild.context(b)).watch();
} else {
    await Promise.all(builds.map((b) => esbuild.build(b)));
    brandCheck();
}
