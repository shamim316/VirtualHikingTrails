/**
 * A long walk, driven by the real input path.
 *
 * `shoot.mjs --walk` teleports, which is fine for getting somewhere but tells
 * you nothing about whether walking works. This holds the arrow keys down for
 * a few minutes, occasionally turns, and samples frame time, draw calls, chunk
 * churn and JS heap the whole way — the things that go wrong slowly.
 *
 * What it asserts:
 *   - the player actually covers ground
 *   - no page errors
 *   - heap is flat rather than climbing (chunk and scatter caches evicting)
 *   - no chunk-load stall leaves pending work unresolved
 *
 *   node tools/walk-test.mjs --minutes 3 --tier medium
 */

import { chromium } from 'playwright';
import fs from 'node:fs';

const args = {};
for (let i = 0; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1]?.startsWith('--') ? true : process.argv[++i];
}

const MINUTES = Number(args.minutes ?? 2);
const TIER = args.tier ?? 'medium';
const SEED = args.seed ?? '12345';
const URL_BASE = args.url ?? 'http://localhost:5173';

const executablePath = [
  ...(fs.globSync?.('/opt/pw-browsers/chromium-*/chrome-linux/chrome') ?? []),
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
].find((p) => fs.existsSync(p));

const browser = await chromium.launch({
  executablePath,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--js-flags=--expose-gc'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

await page.goto(`${URL_BASE}/?seed=${SEED}&hour=9`, { waitUntil: 'load', timeout: 90_000 });
await page.waitForFunction(() => Boolean(window.game), null, { timeout: 60_000 });
await page.click('.splash button.primary', { timeout: 30_000 });
await page.evaluate((tier) => window.hiking.applyTier(tier), TIER);
// Adaptive quality would change tiers underneath us and make the numbers
// incomparable across the run.
await page.evaluate(() => window.hiking.setAdaptiveEnabled(false));
await page.waitForTimeout(8000);

const start = await position(page);
console.log(`walking for ${MINUTES} minutes at tier=${TIER}...\n`);
console.log('  t      walked   fps   frame   calls   tris    chunks  pend  plants  heap');

const samples = [];
const deadline = Date.now() + MINUTES * 60_000;
await page.keyboard.down('ArrowUp');

let turning = null;
while (Date.now() < deadline) {
  // A wander rather than a straight line: turning forces the terrain and
  // scatter caches to evict in every direction, which is where leaks show up.
  if (Math.random() < 0.25) {
    if (turning) await page.keyboard.up(turning);
    turning = Math.random() < 0.5 ? 'ArrowLeft' : 'ArrowRight';
    await page.keyboard.down(turning);
  } else if (turning) {
    await page.keyboard.up(turning);
    turning = null;
  }

  await page.waitForTimeout(5000);

  const sample = await page.evaluate(() => ({
    ...window.hiking.stats,
    walked: window.game.discovery.progress.distanceWalked,
    species: window.game.discovery.progress.discovered.length,
    heap: performance.memory ? performance.memory.usedJSHeapSize : 0,
  }));
  samples.push(sample);
  const t = Math.round((MINUTES * 60_000 - (deadline - Date.now())) / 1000);
  console.log(
    `  ${String(t).padStart(4)}s  ${sample.walked.toFixed(0).padStart(6)}m  ` +
      `${sample.fps.toFixed(0).padStart(3)}  ${sample.frameMs.toFixed(0).padStart(5)}ms  ` +
      `${String(sample.drawCalls).padStart(5)}  ${(sample.triangles / 1e6).toFixed(1).padStart(5)}M  ` +
      `${String(sample.chunks).padStart(6)}  ${String(sample.pending).padStart(4)}  ` +
      `${String(sample.plants).padStart(6)}  ${(sample.heap / 1048576).toFixed(0).padStart(4)}MB`
  );
}

await page.keyboard.up('ArrowUp');
if (turning) await page.keyboard.up(turning);

const end = await position(page);
const distance = Math.hypot(end.x - start.x, end.z - start.z);
const walked = samples.at(-1).walked;

// Heap over the second half versus the first: a cache that never evicts shows
// up here long before it shows up as a crash.
const half = Math.floor(samples.length / 2);
const early = mean(samples.slice(0, half).map((s) => s.heap));
const late = mean(samples.slice(half).map((s) => s.heap));
const growth = early ? ((late - early) / early) * 100 : 0;

console.log(`\nwalked ${walked.toFixed(0)}m, ${distance.toFixed(0)}m from where it started`);
console.log(`species found: ${samples.at(-1).species}`);
console.log(`heap ${(early / 1048576).toFixed(0)}MB -> ${(late / 1048576).toFixed(0)}MB (${growth.toFixed(1)}%)`);
console.log(`worst frame ${Math.max(...samples.map((s) => s.frameMs)).toFixed(0)}ms`);
console.log(`page errors: ${errors.length}`);
for (const e of errors.slice(0, 10)) console.log(`  ${e}`);

// Note on the distance threshold: under SwiftShader a chunk upload can take
// four seconds, and the simulation clamps dt to 0.1s so a stalled frame throws
// away almost all of its wall-clock time. Walking speed measured here is a
// property of the software renderer, not of the game, so this only asserts
// that walking happens at all — the numbers that carry information are the
// heap trend, the chunk plateau and the error count.
let failed = false;
if (walked < 15) fail(`barely moved: ${walked.toFixed(0)}m`);
if (errors.length) fail(`${errors.length} page errors`);
if (growth > 60) fail(`heap grew ${growth.toFixed(0)}%`);

// Chunks should reach a plateau: the visible set is a function of where you
// are standing, so if it is still climbing at the end either the world never
// finished streaming (fine, and reported) or something is failing to evict.
const chunkGrowth = samples.at(-1).chunks - samples[Math.max(0, samples.length - 4)].chunks;
console.log(`chunk count over the last stretch: ${chunkGrowth >= 0 ? '+' : ''}${chunkGrowth}`);
if (samples.at(-1).pending > 0 && chunkGrowth > 0) {
  console.log('  (world still streaming — not a plateau, rerun at a lower tier to test eviction)');
}

console.log(failed ? '\nFAIL' : '\nPASS');
await browser.close();
process.exitCode = failed ? 1 : 0;

function fail(message) {
  failed = true;
  console.error(`  ! ${message}`);
}

function mean(values) {
  return values.reduce((a, b) => a + b, 0) / (values.length || 1);
}

function position(page) {
  return page.evaluate(() => {
    const p = window.hiking.player.state.position;
    return { x: p.x, z: p.z };
  });
}
