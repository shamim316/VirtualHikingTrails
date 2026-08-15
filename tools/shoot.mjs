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

// Dismiss the splash unless we are deliberately photographing it. Clicking the
// real button rather than hiding the element means the audio graph gets its
// gesture too, so a broken soundscape shows up here as a console error.
if (!('splash' in args)) {
  // Generous: under SwiftShader the main thread is saturated by the render
  // loop, so Playwright's actionability checks crawl.
  await page
    .click('.splash button.primary', { timeout: 30_000 })
    .catch((err) => console.warn(`could not dismiss splash: ${err.message.split('\n')[0]}`));
  await page.waitForTimeout(800);
}

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

if (args.weather) {
  // Force a weather state and let it ease in, so the cloud deck and the light
  // can be judged under something other than the default fair day.
  await page.evaluate((kind) => {
    const weather = window.hiking.weather;
    weather.setKind(kind);
    // The smoothed overcast/rain/haze values ease over minutes, which is right
    // in play and useless in a screenshot. Run the state machine forward until
    // it has actually arrived. The clock it advances is overwritten below.
    for (let i = 0; i < 600; i++) weather.update(0.5);
    weather.setKind(kind);
  }, args.weather);
}

if ('water' in args) {
  // Stand on the bank of the nearest interesting water, looking at it. Water
  // is the one subsystem a forest viewpoint tells you nothing about.
  const where = await page.evaluate((wantFall) => {
    const engine = window.hiking;
    const field = engine.terrain.field;

    let best = null;
    for (let i = 0; i < 12000; i++) {
      const angle = i * 2.39996;
      const radius = Math.sqrt(i) * 18;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      const s = field.sample(x, z);
      if (s.waterHeight <= s.height + 0.05) continue;
      // A waterfall is fast water on steep ground; a tarn is the opposite.
      // Default: open standing water, which is what shows the shader. A
      // stream in a narrow cut is mostly bank from anywhere you can stand.
      const depth = s.waterHeight - s.height;
      const score = wantFall
        ? s.riverT * 2 + s.slope * 7 - radius * 0.0006
        : (1 - s.slope) * 4 + Math.min(depth, 4) - s.riverT * 2 - radius * 0.0012;
      if (!best || score > best.score) best = { x, z, score, slope: s.slope, riverT: s.riverT };
    }
    if (!best) return null;

    // Nearest dry bank, searched outward in rings rather than along one
    // arbitrary diagonal — a stream is narrow in exactly one direction.
    let bank = null;
    // Start well back: standing at the very edge of the water fills the frame
    // with bank. Ten metres out is where you would actually stop to look.
    for (let radius = 10; radius <= 90 && !bank; radius += 4) {
      for (let i = 0; i < 24; i++) {
        const angle = (i / 24) * Math.PI * 2;
        const px = best.x + Math.cos(angle) * radius;
        const pz = best.z + Math.sin(angle) * radius;
        const h = field.height(px, pz);
        // Dry, and standing a little above the surface so the bank is in shot.
        if (field.waterHeight(px, pz) > h - 0.4) continue;
        if (field.normal(px, pz, 1.2).y < 0.86) continue;
        bank = { px, pz, h };
        break;
      }
    }
    if (!bank) return null;

    const yaw = Math.atan2(-(best.x - bank.px), -(best.z - bank.pz));
    engine.player.placeAt(bank.px, bank.pz, yaw);
    return { ...best, ...bank };
  }, 'waterfall' in args);
  console.log(where
    ? `bank at (${where.px.toFixed(0)}, ${where.pz.toFixed(0)}) ${where.h.toFixed(0)}m, ` +
      `water riverT=${where.riverT.toFixed(2)} slope=${where.slope.toFixed(2)}`
    : 'no water found');
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

// UI states worth photographing on their own.
if ('rest' in args) await page.evaluate(() => window.game.modes.set('resting'));
if ('photo' in args) await page.evaluate(() => window.game.modes.set('photo'));
if ('journal' in args) await page.evaluate(() => window.game.ui.toggleJournal(window.game.discovery, []));
if ('settings' in args) await page.evaluate(() => window.game.ui.openSettings());

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
  // Let the sky's environment capture and the exposure ease settle. Generous,
  // because under SwiftShader the frame rate is low enough that a few seconds
  // is only a couple of dozen frames of damping.
  await page.waitForTimeout(Number(args.ease ?? 9000));

  const stats = await page.evaluate(() => ({ ...window.hiking.stats }));
  const mode = ['rest', 'photo', 'journal', 'settings', 'splash', 'water', 'waterfall'].find((m) => m in args);
  const label =
    `${MOBILE ? 'mobile-' : ''}${mode ? `${mode}-` : ''}` +
    `${args.weather ? `${args.weather}-` : ''}h${String(hour).replace('.', '_')}`;
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
