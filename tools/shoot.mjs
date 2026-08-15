/**
 * Screenshot harness.
 *
 * Drives a real Chromium against the dev server, waits for the terrain to
 * settle, and captures the world at whatever time of day and viewpoint you ask
 * for. Used to actually look at the game rather than to reason about what the
 * shaders ought to be producing.
 *
 *   node tools/shoot.mjs --out shots --seed 12345 --hours 6.2,9,13,18.4,21.5
 *   node tools/shoot.mjs --mobile --hours 8
 *   node tools/shoot.mjs --walk 400        # walk 400m, then shoot
 */

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const OUT = args.out ?? 'shots';
const URL_BASE = args.url ?? 'http://localhost:5173';
const SEED = args.seed ?? '12345';
const HOURS = (args.hours ?? '6.4,9.5,13,18.6,22').split(',').map(Number);
const MOBILE = 'mobile' in args;
const WALK = Number(args.walk ?? 0);
const SETTLE = Number(args.settle ?? 9);
const TIER = args.tier ?? 'high';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const viewport = MOBILE ? { width: 430, height: 932 } : { width: 1600, height: 900 };

// The bundled browser lives under a versioned directory; find whichever one
// this image shipped rather than pinning a version that will drift.
const executablePath = [
  ...(fs.globSync?.('/opt/pw-browsers/chromium-*/chrome-linux/chrome') ?? []),
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
].find((p) => fs.existsSync(p));

const browser = await chromium.launch({
  executablePath,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
    '--disable-dev-shm-usage',
  ],
});

const context = await browser.newContext({
  viewport,
  deviceScaleFactor: 1,
  isMobile: MOBILE,
  hasTouch: MOBILE,
});
const page = await context.newPage();

const logs = [];
page.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}\n${err.stack ?? ''}`));

await mkdir(OUT, { recursive: true });

const url = `${URL_BASE}/?seed=${encodeURIComponent(SEED)}&hour=${HOURS[0]}`;
console.log(`opening ${url} (${viewport.width}x${viewport.height}, tier=${TIER})`);
await page.goto(url, { waitUntil: 'load', timeout: 90_000 });

// Wait for the engine to exist and for WebGL to have come up at all.
await page.waitForFunction(() => Boolean(window.hiking), null, { timeout: 60_000 });
await page.evaluate((tier) => window.hiking.applyTier(tier), TIER);

if ('forest' in args) {
  // Relocate to somewhere genuinely wooded. Looking at a bare hillside tells
  // you nothing about whether the forest works.
  await page.evaluate((c) => { window.__wantConifer = c; }, 'conifer' in args);
  const where = await page.evaluate(() => {
    const engine = window.hiking;
    const field = engine.terrain.field;
    let best = null;
    for (let i = 0; i < 4000; i++) {
      const angle = i * 2.39996;
      const radius = Math.sqrt(i) * 26;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      const s = field.sample(x, z);
      if (s.slope > 0.28 || s.waterHeight > s.height) continue;
      // Biome 2 is Conifer; pass --conifer to look for a fir and pine wood
      // rather than whatever broadleaf stand happens to be nearest.
      if (window.__wantConifer && s.biome !== 2) continue;
      const score = s.canopy * 4 - s.slope * 2 - radius * 0.0008;
      if (!best || score > best.score) best = { x, z, score, canopy: s.canopy, h: s.height, biome: s.biome };
    }
    if (!best) return null;
    engine.player.placeAt(best.x, best.z, 0.6);
    return best;
  });
  console.log(where ? `forest spot (${where.x.toFixed(0)}, ${where.z.toFixed(0)}) canopy=${where.canopy.toFixed(2)} h=${where.h.toFixed(0)}m biome=${where.biome}` : 'no forest found');
}

if (WALK > 0) {
  console.log(`walking ${WALK}m...`);
  await page.evaluate(async (metres) => {
    const engine = window.hiking;
    const step = 2.0;
    let walked = 0;
    while (walked < metres) {
      const p = engine.player.state.position;
      const yaw = engine.player.state.yaw;
      engine.player.placeAt(p.x - Math.sin(yaw) * step, p.z - Math.cos(yaw) * step, yaw);
      walked += step;
      if (walked % 40 < step) await new Promise((r) => setTimeout(r, 60));
    }
  }, WALK);
}

if (args.pitch) {
  await page.evaluate((p) => { window.hiking.player.state.pitch = Number(p); }, args.pitch);
}

console.log(`settling ${SETTLE}s for terrain streaming...`);
await waitForQuiet(page, SETTLE);

const report = [];
for (const hour of HOURS) {
  await page.evaluate(([h, p]) => {
    const engine = window.hiking;
    engine.weather.setHour(h);
    engine.weather.timeRunning = false;
    if (p !== null) engine.player.state.pitch = Number(p);
  }, [hour, args.pitch ?? null]);
  // Let the sky's environment capture and the exposure ease settle.
  await page.waitForTimeout(2500);

  const stats = await page.evaluate(() => ({ ...window.hiking.stats }));
  const label = `${MOBILE ? 'mobile-' : ''}h${String(hour).replace('.', '_')}`;
  const file = path.join(OUT, `${label}.png`);
  await page.screenshot({ path: file, timeout: 180_000 });
  report.push({ hour, file, ...stats });
  console.log(
    `  ${file}  ${stats.fps.toFixed(0)}fps  ${stats.drawCalls} calls  ` +
      `${(stats.triangles / 1000).toFixed(0)}k tris  ${stats.chunks} chunks`
  );
}

await writeFile(path.join(OUT, 'report.json'), JSON.stringify({ seed: SEED, tier: TIER, report, logs }, null, 2));

if (logs.length) {
  console.log('\n--- page console ---');
  for (const line of logs.slice(0, 40)) console.log(line);
}

await browser.close();

/** Wait until no chunks are pending, or the timeout expires. */
async function waitForQuiet(page, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const pending = await page.evaluate(() => window.hiking?.stats?.pending ?? 1);
    if (pending === 0) {
      await page.waitForTimeout(600);
      return;
    }
    await page.waitForTimeout(300);
  }
}
