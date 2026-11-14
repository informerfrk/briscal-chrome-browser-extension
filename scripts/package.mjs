/**
 * Zips the production build (dist/) for the Chrome Web Store: release/brisqal-chrome-<version>.zip.
 * Plain Node (zlib), so it works on Windows, macOS and Linux without a zip program.
 * Run through `npm run package`, which builds dist/ first.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const manifest = JSON.parse(fs.readFileSync('dist/manifest.json', 'utf8'));
if (manifest.version !== pkg.version) throw new Error(`dist/ is stale: manifest ${manifest.version}, package.json ${pkg.version}. Run npm run package.`);

const files = [];
const walk = (dir) => {
    for (const f of fs.readdirSync(dir).sort()) {
        const p = path.join(dir, f);
        if (fs.statSync(p).isDirectory()) walk(p);
        else files.push(p);
    }
};
walk('dist');
for (const f of files) {
    if (f.endsWith('.map')) throw new Error(`Source map in the package: ${f}. Run npm run package (production build).`);
    if (/sourceMappingURL=data:/.test(fs.readFileSync(f, 'latin1'))) throw new Error(`Inline source map in ${f}. Run npm run package (production build).`);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});
const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
};

// Fixed timestamp (2026-01-01 00:00) so the same build always gives the same zip.
const DOS_TIME = 0, DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const local = [];
const central = [];
let offset = 0;
for (const file of files) {
    const name = Buffer.from(path.relative('dist', file).split(path.sep).join('/'));
    const data = fs.readFileSync(file);
    const packed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(8, 8);
    head.writeUInt16LE(DOS_TIME, 10); head.writeUInt16LE(DOS_DATE, 12); head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(name.length, 26); head.writeUInt16LE(0, 28);
    local.push(head, name, packed);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x0800, 8); dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(DOS_TIME, 12); dir.writeUInt16LE(DOS_DATE, 14); dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(packed.length, 20);
    dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(name.length, 28); dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += head.length + name.length + packed.length;
}
const centralSize = central.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);

fs.mkdirSync('release', { recursive: true });
const out = `release/brisqal-chrome-${pkg.version}.zip`;
fs.writeFileSync(out, Buffer.concat([...local, ...central, end]));
console.log(`${out}: ${files.length} files, ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
