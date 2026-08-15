/**
 * Download the raw Poly Haven assets named in tools/assets.json.
 *
 * Everything lands in assets-raw/, which is gitignored — these are the source
 * files, often hundreds of megabytes of raw scan data, and only the processed
 * output belongs in the repository.
 *
 * Downloads are resumable in the sense that anything already present with the
 * right size is skipped, so re-running after a dropped connection is cheap.
 *
 *   node tools/fetch-assets.mjs                # everything
 *   node tools/fetch-assets.mjs --skip-heavy   # leave out the huge tree scans
 *   node tools/fetch-assets.mjs --only fern,boulder
 */

import { mkdir, writeFile, stat, readFile } from 'node:fs/promises';
import path from 'node:path';

const API = 'https://api.polyhaven.com';
const RAW = 'assets-raw';

const argv = process.argv.slice(2);
const SKIP_HEAVY = argv.includes('--skip-heavy');
const ONLY = (() => {
  const i = argv.indexOf('--only');
  return i >= 0 && argv[i + 1] ? new Set(argv[i + 1].split(',')) : null;
})();

const manifest = JSON.parse(await readFile(new URL('./assets.json', import.meta.url), 'utf8'));

await mkdir(RAW, { recursive: true });

let totalBytes = 0;
const credits = [];

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------

for (const tex of manifest.textures) {
  if (ONLY && !ONLY.has(tex.id)) continue;
  const files = await api(`/files/${tex.slug}`);
  const info = await api(`/info/${tex.slug}`);

  // Poly Haven publishes an `arm` map (AO/roughness/metal packed) for most
  // surfaces, which is exactly the layout the terrain shader wants. Where it's
  // missing we would have to pack one, so fail loudly rather than silently
  // shipping a surface with no roughness variation.
  const wanted = { diff: 'Diffuse', nor: 'nor_gl', arm: 'arm' };
  for (const [suffix, key] of Object.entries(wanted)) {
    const entry = files[key]?.[tex.res]?.jpg;
    if (!entry) throw new Error(`${tex.slug}: no ${key} at ${tex.res} (available: ${Object.keys(files).join(', ')})`);
    const dest = path.join(RAW, 'textures', `${tex.id}_${suffix}.jpg`);
    totalBytes += await download(entry.url, dest, entry.size);
  }
  credits.push(creditLine('texture', tex.slug, info));
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

for (const model of manifest.models) {
  if (ONLY && !ONLY.has(model.id)) continue;
  if (SKIP_HEAVY && model.heavy) {
    console.log(`skip (heavy)  ${model.slug}`);
    continue;
  }

  const files = await api(`/files/${model.slug}`);
  const info = await api(`/info/${model.slug}`);

  const gltf = files.gltf?.[model.res]?.gltf;
  if (!gltf) throw new Error(`${model.slug}: no glTF at ${model.res}`);

  const dir = path.join(RAW, 'models', model.id);
  await mkdir(dir, { recursive: true });

  // The .gltf itself is tiny; its `include` map lists the .bin and every
  // texture, with their real sizes.
  totalBytes += await download(gltf.url, path.join(dir, 'model.gltf'), gltf.size);

  const includes = Object.entries(gltf.include ?? {});
  const bytes = includes.reduce((sum, [, f]) => sum + f.size, 0);
  console.log(`${model.slug}: ${includes.length} files, ${(bytes / 1e6).toFixed(1)}MB`);

  for (const [relative, file] of includes) {
    const dest = path.join(dir, relative);
    await mkdir(path.dirname(dest), { recursive: true });
    totalBytes += await download(file.url, dest, file.size);
  }

  credits.push(creditLine('model', model.slug, info));
}

await writeFile(path.join(RAW, 'credits.json'), JSON.stringify(credits, null, 2));
console.log(`\ndownloaded ${(totalBytes / 1e6).toFixed(0)}MB into ${RAW}/`);

// ---------------------------------------------------------------------------

async function api(route) {
  const res = await fetchRetry(`${API}${route}`);
  return res.json();
}

/** Fetch with a few retries; the CDN occasionally drops a large transfer. */
async function fetchRetry(url, attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return res;
    } catch (err) {
      lastError = err;
      const wait = 1500 * 2 ** i;
      console.warn(`  retry in ${wait}ms: ${err.message}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastError;
}

/** Download unless a file of exactly the expected size is already there. */
async function download(url, dest, expectedSize) {
  try {
    const existing = await stat(dest);
    if (!expectedSize || existing.size === expectedSize) return 0;
  } catch {
    // Not downloaded yet.
  }

  await mkdir(path.dirname(dest), { recursive: true });
  const started = Date.now();
  const res = await fetchRetry(url);
  const buffer = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buffer);

  const seconds = (Date.now() - started) / 1000;
  const mb = buffer.length / 1e6;
  if (mb > 5) {
    console.log(`  ${path.basename(dest)}  ${mb.toFixed(1)}MB in ${seconds.toFixed(1)}s (${(mb / seconds).toFixed(1)}MB/s)`);
  }
  return buffer.length;
}

function creditLine(kind, slug, info) {
  return {
    kind,
    slug,
    title: info?.name ?? slug,
    authors: Object.keys(info?.authors ?? {}),
    license: 'CC0',
    source: `https://polyhaven.com/a/${slug}`,
  };
}
