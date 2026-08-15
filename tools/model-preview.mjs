/**
 * Photograph one asset, on its own.
 *
 * Drives `preview.html`, which draws a single model against a one-metre grid
 * with a two-metre pole beside it. Use this before looking at anything in the
 * forest: a broken tree standing among two hundred correct ones is very hard
 * to see, and every conifer bug in this project cost extra because it was
 * diagnosed in a landscape instead of against a grid.
 *
 *   node tools/model-preview.mjs fir_tree pine_tree
 *   node tools/model-preview.mjs fir_tree --eye        # standing next to it
 *   node tools/model-preview.mjs fir_tree --variant 0
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flags = {};
const models = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const key = argv[i].slice(2);
    flags[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  } else {
    models.push(argv[i]);
  }
}
if (!models.length) models.push('fir_tree');

const OUT = flags.out ?? 'shots/models';
const BASE = flags.url ?? 'http://localhost:5173';
const ANGLES = String(flags.angles ?? '0.6').split(',').map(Number);

const executablePath = [
  ...(fs.globSync?.('/opt/pw-browsers/chromium-*/chrome-linux/chrome') ?? []),
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
].find((p) => fs.existsSync(p));

const browser = await chromium.launch({
  executablePath,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 1100 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));

await mkdir(OUT, { recursive: true });

for (const model of models) {
  for (const angle of ANGLES) {
    const query = new URLSearchParams({ model, angle: String(angle) });
    if (flags.eye) query.set('eye', '1');
    if (flags.variant !== undefined) query.set('variant', String(flags.variant));

    await page.goto(`${BASE}/preview.html?${query}`, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForFunction(() => window.preview?.ready, null, { timeout: 60_000 });
    // A beat for textures to decode; the model itself is already in the scene.
    await page.waitForTimeout(2500);

    const stats = await page.evaluate(() => ({ ...window.preview }));
    const suffix = `${flags.eye ? '-eye' : ''}${ANGLES.length > 1 ? `-a${String(angle).replace('.', '_')}` : ''}`;
    const file = path.join(OUT, `${model}${suffix}.png`);
    await page.screenshot({ path: file });
    console.log(
      `  ${file.padEnd(40)} ${Math.round(stats.triangles).toLocaleString().padStart(9)} tris  ` +
        `${stats.height.toFixed(2)}m tall  ${stats.variants} variant(s)${stats.note ? '  ' + stats.note : ''}`
    );
  }
}

await browser.close();
