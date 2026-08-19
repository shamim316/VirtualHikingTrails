/**
 * Where the frame actually goes.
 *
 * Draw calls and a triangle total tell you there is a problem; they never tell
 * you which asset caused it. This walks the vegetation renderers and reports
 * triangles *per species*, which is the number that leads somewhere. The first
 * run of it found that a 0.4-metre shrub was costing seven million triangles a
 * frame — a third of the whole picture — because its budget was eight thousand
 * triangles an instance and eight hundred of them were on screen.
 *
 * Run it on real hardware. Under SwiftShader the frame *times* here are
 * meaningless, but the counts are exact, and the counts are the point.
 *
 *   node tools/perf-census.mjs
 *   node tools/perf-census.mjs --tiers high --biome 2 --settle 40
 */

import { chromium } from 'playwright';
import fs from 'node:fs';

const args = {};
for (let i = 0; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1]?.startsWith('--') ? true : process.argv[++i];
}

const TIERS = String(args.tiers ?? 'low,medium,high,ultra').split(',');
const SEED = args.seed ?? '12345';
const BIOME = Number(args.biome ?? 2);
const SETTLE = Number(args.settle ?? 26) * 1000;
const URL_BASE = args.url ?? 'http://localhost:5173';
const TOP = Number(args.top ?? 10);

const executablePath = [
  ...(fs.globSync?.('/opt/pw-browsers/chromium-*/chrome-linux/chrome') ?? []),
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
].find((p) => fs.existsSync(p));

const browser = await chromium.launch({
  executablePath,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));

const summary = [];

for (const tier of TIERS) {
  await page.goto(`${URL_BASE}/?seed=${SEED}&hour=10&tier=${tier}`, { waitUntil: 'load', timeout: 90_000 });
  await page.waitForFunction(() => Boolean(window.game), null, { timeout: 60_000 });
  await page.click('.splash button.primary', { timeout: 30_000 });

  // Stand in the thickest wood of the requested biome: the worst case that is
  // still somewhere a player would actually be.
  await page.evaluate((biome) => {
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
      if (biome >= 0 && s.biome !== biome) continue;
      const score = s.canopy * 4 - s.slope * 2 - radius * 0.0008;
      if (!best || score > best.score) best = { x, z, score };
    }
    if (best) engine.player.placeAt(best.x, best.z, 0.6);
    engine.setAdaptiveEnabled(false);
  }, BIOME);

  await page.waitForTimeout(SETTLE);

  const result = await page.evaluate(() => {
    const engine = window.hiking;
    const rows = [];
    let vegetation = 0;

    for (const [, renderer] of engine.vegetation.renderers) {
      let triangles = 0;
      let instances = 0;
      for (const variant of renderer.variants) {
        const first = variant.meshes[0];
        if (!first || !first.count) continue;
        instances += first.count;
        for (const mesh of variant.meshes) {
          const g = mesh.geometry;
          const per = (g.index ? g.index.count : g.attributes.position.count) / 3;
          triangles += per * mesh.count;
        }
      }
      if (renderer.impostorMesh?.count) {
        triangles += renderer.impostorMesh.count * 2;
        instances += renderer.impostorMesh.count;
      }
      if (!triangles) continue;
      vegetation += triangles;
      rows.push({
        id: renderer.species.id,
        group: renderer.species.group,
        instances,
        triangles,
        each: Math.round(triangles / Math.max(1, instances)),
      });
    }

    rows.sort((a, b) => b.triangles - a.triangles);
    const stats = engine.stats;
    return {
      calls: stats.drawCalls,
      triangles: stats.triangles,
      vegetation,
      chunks: stats.chunks,
      plants: stats.plants,
      post: engine.post.enabled,
      spray: engine.spray.particleCount,
      rows,
    };
  });

  console.log(`\n=== ${tier} ===`);
  console.log(
    `${result.calls} draw calls, ${(result.triangles / 1e6).toFixed(1)}M triangles ` +
      `(${((result.vegetation / Math.max(1, result.triangles)) * 100).toFixed(0)}% vegetation), ` +
      `${result.chunks} chunks, post ${result.post ? 'on' : 'off'}, ${result.spray} spray`
  );
  console.log('  species           group        instances     Mtris   per instance');
  for (const row of result.rows.slice(0, TOP)) {
    console.log(
      `  ${row.id.padEnd(17)} ${row.group.padEnd(12)} ${String(row.instances).padStart(9)} ` +
        `${(row.triangles / 1e6).toFixed(2).padStart(9)} ${String(row.each).padStart(14)}`
    );
  }

  summary.push({ tier, calls: result.calls, mtris: +(result.triangles / 1e6).toFixed(1) });
}

console.log('\nsummary');
for (const s of summary) {
  console.log(`  ${s.tier.padEnd(8)} ${String(s.calls).padStart(4)} calls  ${String(s.mtris).padStart(6)}M tris`);
}

await browser.close();
