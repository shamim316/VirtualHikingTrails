/**
 * Render the heightfield straight to a PNG: hillshade, water, and a slope map.
 *
 * Looking at terrain through a first-person camera is a slow way to find out
 * whether a world is shaped well. This draws a few square kilometres from
 * above in a second, which makes it obvious at a glance whether the valleys
 * are walkable, whether the streams run where streams should run, and whether
 * the mountains are mountains or just noise.
 *
 *   node tools/map-preview.mjs --seed 12345 --size 4000 --out map.png
 */

import { Heightfield, createColumn } from '../src/world/heightfield';
import { clamp01, smoothstep } from '../src/world/noise';
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}

const seed = Number(args.get('seed') ?? 12345);
const extent = Number(args.get('size') ?? 4000);
const pixels = Number(args.get('px') ?? 700);
const centerX = Number(args.get('x') ?? 0);
const centerZ = Number(args.get('z') ?? 0);
const out = args.get('out') ?? 'map.png';

const field = new Heightfield(seed);
const step = extent / pixels;

const heights = new Float32Array(pixels * pixels);
const water = new Float32Array(pixels * pixels);
const column = createColumn();

let min = Infinity;
let max = -Infinity;
for (let j = 0; j < pixels; j++) {
  for (let i = 0; i < pixels; i++) {
    const x = centerX - extent / 2 + i * step;
    const z = centerZ - extent / 2 + j * step;
    field.columnSample(x, z, column);
    const idx = j * pixels + i;
    heights[idx] = column.height;
    water[idx] = column.water;
    if (column.height < min) min = column.height;
    if (column.height > max) max = column.height;
  }
}

// Slope statistics, in degrees, so the shape can be judged numerically too.
const slopes: number[] = [];
const rgb = new Uint8Array(pixels * pixels * 3);
const sunX = -0.6;
const sunZ = -0.5;
const sunY = 0.62;

for (let j = 0; j < pixels; j++) {
  for (let i = 0; i < pixels; i++) {
    const idx = j * pixels + i;
    const hL = heights[j * pixels + Math.max(0, i - 1)];
    const hR = heights[j * pixels + Math.min(pixels - 1, i + 1)];
    const hD = heights[Math.max(0, j - 1) * pixels + i];
    const hU = heights[Math.min(pixels - 1, j + 1) * pixels + i];

    let nx = (hL - hR) / (2 * step);
    let nz = (hD - hU) / (2 * step);
    const len = Math.hypot(nx, 1, nz);
    nx /= len;
    const ny = 1 / len;
    nz /= len;

    const degrees = Math.acos(Math.min(1, ny)) * (180 / Math.PI);
    slopes.push(degrees);

    const shade = clamp01(nx * sunX + ny * sunY + nz * sunZ) * 0.85 + 0.15;
    const t = clamp01((heights[idx] - min) / (max - min || 1));

    // Rough biome colouring, matching what the game does.
    let r: number, g: number, b: number;
    const snow = smoothstep(700, 800, heights[idx]);
    const rock = smoothstep(0.35, 0.75, 1 - ny) + smoothstep(560, 780, heights[idx]) * 0.6;
    if (snow > 0.5) { r = 240; g = 244; b = 250; }
    else if (rock > 0.6) { r = 128; g = 122; b = 114; }
    else { r = 78 + t * 60; g = 104 + t * 40; b = 52 + t * 30; }

    if (water[idx] > heights[idx]) { r = 46; g = 88; b = 104; }

    rgb[idx * 3] = Math.min(255, r * shade);
    rgb[idx * 3 + 1] = Math.min(255, g * shade);
    rgb[idx * 3 + 2] = Math.min(255, b * shade);
  }
}

slopes.sort((a, b) => a - b);
const pct = (p: number) => slopes[Math.floor(slopes.length * p)].toFixed(1);
const walkable = slopes.filter((s) => s < 25).length / slopes.length;
const steep = slopes.filter((s) => s > 45).length / slopes.length;
const wet = Array.from(water).filter((w, i) => w > heights[i]).length / water.length;

console.log(`seed ${seed}  ${extent}m across at ${step.toFixed(1)}m/px`);
console.log(`height  min ${min.toFixed(0)}m  max ${max.toFixed(0)}m  relief ${(max - min).toFixed(0)}m`);
console.log(`slope   p10 ${pct(0.1)}°  p50 ${pct(0.5)}°  p90 ${pct(0.9)}°  p99 ${pct(0.99)}°`);
console.log(`walkable (<25°) ${(walkable * 100).toFixed(1)}%   steep (>45°) ${(steep * 100).toFixed(1)}%`);
console.log(`water coverage ${(wet * 100).toFixed(2)}%`);

writeFileSync(out, encodePng(rgb, pixels, pixels));
console.log(`wrote ${out}`);

/** Minimal PNG encoder — no image dependency needed for a debug view. */
function encodePng(data: Uint8Array, width: number, height: number): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0; // filter: none
    Buffer.from(data.buffer, y * width * 3, width * 3).copy(raw, y * (width * 3 + 1) + 1);
  }

  const chunks: Buffer[] = [];
  chunks.push(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour
  chunks.push(pngChunk('IHDR', ihdr));
  chunks.push(pngChunk('IDAT', deflateSync(raw)));
  chunks.push(pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

let crcTable: number[] | null = null;
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
