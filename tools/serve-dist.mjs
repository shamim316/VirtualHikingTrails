/**
 * Serve `dist/` with the production headers applied.
 *
 * This exists because of a bug that reached the live site. `public/_headers` is
 * a Cloudflare convention: Vite's dev server ignores it completely, so the
 * Content-Security-Policy in it had never once been exercised before deploy.
 * It turned out to forbid something the game does on every model load, and the
 * first time anybody saw that was on the deployed URL.
 *
 * So: a static server that parses the same `_headers` file Cloudflare will and
 * applies it. Anything the policy breaks now breaks here first.
 *
 *   node tools/serve-dist.mjs            # http://localhost:4180
 *   node tools/serve-dist.mjs --port 8080 --dir dist
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const DIR = path.resolve(flag('dir', 'dist'));
const PORT = Number(flag('port', 4180));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};

/**
 * Parse Cloudflare's `_headers` format: a URL pattern on its own line, then
 * indented `Name: value` lines until the next pattern.
 */
async function loadRules(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    console.warn(`no ${file}; serving without production headers`);
    return [];
  }

  const rules = [];
  let current = null;
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      current = { pattern: raw.trim(), headers: [] };
      rules.push(current);
      continue;
    }
    const line = raw.trim();
    const colon = line.indexOf(':');
    if (colon < 0 || !current) continue;
    current.headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return rules;
}

/** Cloudflare's patterns are plain paths with `*` as a wildcard. */
function matches(pattern, pathname) {
  if (!pattern.includes('*')) return pattern === pathname;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(pathname);
}

const rules = await loadRules(path.join('public', '_headers'));
console.log(`loaded ${rules.length} header rule(s) from public/_headers`);

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';

  const file = path.join(DIR, pathname);
  // Refuse to serve outside the directory.
  if (!file.startsWith(DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  let info;
  try {
    info = await stat(file);
  } catch {
    res.writeHead(404).end('not found');
    return;
  }
  if (!info.isFile()) {
    res.writeHead(404).end('not found');
    return;
  }

  // Later rules win, matching Cloudflare's own precedence closely enough that
  // a policy which works here works there.
  const headers = {
    'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    'Content-Length': info.size,
  };
  for (const rule of rules) {
    if (!matches(rule.pattern, pathname)) continue;
    for (const [name, value] of rule.headers) headers[name] = value;
  }

  res.writeHead(200, headers);
  createReadStream(file).pipe(res);
}).listen(PORT, () => {
  console.log(`serving ${DIR} on http://localhost:${PORT} with production headers`);
});
