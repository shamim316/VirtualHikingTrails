/**
 * What the player actually downloads.
 *
 * Walks `dist/` and reports transferred bytes by category, both raw and gzipped
 * where gzip is what the CDN will serve. The target is ~80MB; the point of this
 * script is that the target is checked rather than assumed.
 *
 *   node tools/size-report.mjs
 */

import { readdir, stat, readFile } from 'node:fs/promises';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import path from 'node:path';

const ROOT = process.argv[2] ?? 'dist';
const BUDGET = 80 * 1024 * 1024;

/** Things a CDN will compress on the way out. Everything else is already packed. */
const COMPRESSIBLE = new Set(['.js', '.css', '.html', '.json', '.svg']);

const CATEGORIES = [
  { name: 'Models (GLB)', match: (p) => p.includes('/models/') },
  { name: 'Ground textures', match: (p) => p.includes('/textures/') },
  { name: 'Birdsong', match: (p) => p.includes('/audio/') },
  { name: 'three.js', match: (p) => /three-[\w-]+\.js$/.test(p) },
  { name: 'Game code', match: (p) => p.endsWith('.js') },
  { name: 'Stylesheet', match: (p) => p.endsWith('.css') },
  { name: 'Document', match: (p) => p.endsWith('.html') },
  { name: 'Other', match: () => true },
];

const files = [];
await walk(ROOT);

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full);
      continue;
    }
    const { size } = await stat(full);
    const ext = path.extname(entry.name);
    let transferred = size;
    if (COMPRESSIBLE.has(ext)) {
      const bytes = await readFile(full);
      // Pages serves brotli where the client accepts it, gzip otherwise. Report
      // the pessimistic one so the number is never a pleasant surprise.
      const gzip = gzipSync(bytes, { level: 9 }).length;
      const brotli = brotliCompressSync(bytes, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
      }).length;
      transferred = Math.max(gzip, brotli);
    }
    files.push({ path: full.replaceAll('\\', '/'), size, transferred });
  }
}

const totals = new Map(CATEGORIES.map((c) => [c.name, { raw: 0, transferred: 0, count: 0 }]));
for (const file of files) {
  const category = CATEGORIES.find((c) => c.match(file.path));
  const bucket = totals.get(category.name);
  bucket.raw += file.size;
  bucket.transferred += file.transferred;
  bucket.count++;
}

const raw = files.reduce((n, f) => n + f.size, 0);
const transferred = files.reduce((n, f) => n + f.transferred, 0);

console.log(`\n${ROOT}/ — ${files.length} files\n`);
console.log(pad('Category', 20) + pad('Files', 8) + pad('On disk', 12) + 'Transferred');
console.log('-'.repeat(56));
for (const [name, bucket] of totals) {
  if (!bucket.count) continue;
  console.log(
    pad(name, 20) + pad(String(bucket.count), 8) + pad(mb(bucket.raw), 12) + mb(bucket.transferred)
  );
}
console.log('-'.repeat(56));
console.log(pad('Total', 20) + pad(String(files.length), 8) + pad(mb(raw), 12) + mb(transferred));

const pct = ((transferred / BUDGET) * 100).toFixed(0);
console.log(`\nBudget ${mb(BUDGET)} — using ${mb(transferred)} (${pct}%)\n`);

console.log('Ten largest:');
for (const file of files.sort((a, b) => b.transferred - a.transferred).slice(0, 10)) {
  console.log(`  ${pad(mb(file.transferred), 11)}${file.path}`);
}
console.log();

if (transferred > BUDGET) {
  console.error(`over budget by ${mb(transferred - BUDGET)}`);
  process.exitCode = 1;
}

function mb(bytes) {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(2)} MB`
    : `${(bytes / 1024).toFixed(0)} kB`;
}

function pad(text, width) {
  return String(text).padEnd(width);
}
