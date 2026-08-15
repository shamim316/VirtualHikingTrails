/// <reference lib="webworker" />
/**
 * Where everything grows.
 *
 * For each 24m cell of the world this decides, deterministically, which plants
 * stand where. Nothing is authored; a fern ends up in a damp hollow because
 * ferns want damp hollows and that spot is one.
 *
 * Two things make it fast enough to run while you walk:
 *
 *  - The terrain is evaluated on a coarse grid across the cell and interpolated
 *    for individual plants. Sampling the heightfield properly costs about 8µs,
 *    and a cell holds hundreds of candidates; sampling a 9×9 grid instead and
 *    interpolating is roughly twenty times cheaper for a difference no one can
 *    see at the scale of a single plant.
 *
 *  - Clumping comes from a low-frequency noise field rather than from any
 *    neighbour search. Species with high clumping only accept positions where
 *    their own field is high, which produces drifts and stands — bilberry in
 *    patches, moss in sheets — with no clustering algorithm at all.
 */

import { Heightfield, createColumn, type Column } from './heightfield';
import { Noise, clamp01, lerp, smoothstep } from './noise';
import { hash2f, hash3f, Rng } from '../core/rng';
import {
  SCATTER_CELL,
  INSTANCE_STRIDE,
  type ScatterReady,
  type ScatterRequest,
  type ScatterSpecies,
  type ScatterWorkerRequest,
} from './scatter-protocol';

let field: Heightfield | null = null;
let species: ScatterSpecies[] = [];
let clumpNoise: Noise[] = [];

/** Terrain samples across the cell, plus a one-cell margin for interpolation. */
const GRID = 9;
const gridHeight = new Float32Array(GRID * GRID);
const gridSlope = new Float32Array(GRID * GRID);
const gridMoisture = new Float32Array(GRID * GRID);
const gridCanopy = new Float32Array(GRID * GRID);
const gridWater = new Float32Array(GRID * GRID);
const gridBiome = new Int8Array(GRID * GRID);
const column: Column = createColumn();

function buildCell(req: ScatterRequest): { msg: ScatterReady; transfer: Transferable[] } {
  const hf = field!;
  const originX = req.cellX * SCATTER_CELL;
  const originZ = req.cellZ * SCATTER_CELL;
  const step = SCATTER_CELL / (GRID - 1);

  // --- 1. Coarse terrain grid ----------------------------------------------
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const x = originX + i * step;
      const z = originZ + j * step;
      const idx = j * GRID + i;

      const sample = hf.sample(x, z);
      gridHeight[idx] = sample.height;
      gridSlope[idx] = sample.slope;
      gridMoisture[idx] = sample.moisture;
      gridCanopy[idx] = sample.canopy;
      gridWater[idx] = sample.waterHeight > sample.height ? 1 : 0;
      gridBiome[idx] = sample.biome;

      void hf.columnSample(x, z, column);
    }
  }

  // --- 2. Candidates -------------------------------------------------------
  const instances: Record<number, Float32Array> = {};
  const buffers: number[][] = [];

  for (let s = 0; s < species.length; s++) {
    const spec = species[s];

    // Density is per hectare; a cell is SCATTER_CELL² square metres.
    const area = SCATTER_CELL * SCATTER_CELL;
    const expected = (spec.density / 10000) * area * req.density;
    if (expected <= 0) continue;

    // Oversample and reject: candidates that land somewhere the species would
    // not grow are simply dropped, which is what produces the natural falloff
    // at the edge of a habitat rather than a hard boundary.
    const candidates = Math.ceil(expected * 2.2);
    if (candidates <= 0) continue;

    const rng = new Rng(hash3f(req.cellX, req.cellZ, spec.index * 7919) * 0xffffffff);
    const clump = clumpNoise[spec.index % clumpNoise.length];
    const out: number[] = [];

    for (let c = 0; c < candidates; c++) {
      const fx = rng.next();
      const fz = rng.next();
      const x = originX + fx * SCATTER_CELL;
      const z = originZ + fz * SCATTER_CELL;

      // Bilinear interpolation of the coarse grid.
      const gx = fx * (GRID - 1);
      const gz = fz * (GRID - 1);
      const i0 = Math.min(GRID - 2, Math.floor(gx));
      const j0 = Math.min(GRID - 2, Math.floor(gz));
      const tx = gx - i0;
      const tz = gz - j0;

      const a = j0 * GRID + i0;
      const b = a + 1;
      const cc = a + GRID;
      const d = cc + 1;

      const bilinear = (arr: Float32Array) =>
        lerp(lerp(arr[a], arr[b], tx), lerp(arr[cc], arr[d], tx), tz);

      // Anything touching water is out — no plants standing in the stream.
      if (gridWater[a] || gridWater[b] || gridWater[cc] || gridWater[d]) continue;

      const biome = gridBiome[a];
      if (!spec.biomes.includes(biome)) continue;

      const slope = bilinear(gridSlope);
      if (slope > spec.maxSlope) continue;

      const height = bilinear(gridHeight);
      const moisture = bilinear(gridMoisture);
      const canopy = bilinear(gridCanopy);

      // --- suitability -----------------------------------------------------
      let fitness = 1;

      // Altitude band, with soft shoulders.
      const band = spec.altitudeMax - spec.altitudeMin;
      const shoulder = Math.max(30, band * 0.22);
      fitness *= smoothstep(spec.altitudeMin - shoulder, spec.altitudeMin + shoulder * 0.5, height);
      fitness *= 1 - smoothstep(spec.altitudeMax - shoulder * 0.5, spec.altitudeMax + shoulder, height);

      // Steepness: fine until close to the limit, then falls away fast.
      fitness *= 1 - smoothstep(spec.maxSlope * 0.6, spec.maxSlope, slope);

      // Moisture and shade preferences. A species with affinity 0 ignores the
      // axis entirely; the sign says which end it wants.
      fitness *= preferenceFit(moisture, spec.moisture);
      fitness *= preferenceFit(canopy, spec.canopy);

      if (fitness <= 0.02) continue;

      // Clumping: accept only where this species' own drift field is high.
      if (spec.clumping > 0.01) {
        const drift = clump.fbm2(x * 0.035, z * 0.035, 2) * 0.5 + 0.5;
        const threshold = spec.clumping * 0.75;
        if (drift < threshold) continue;
        // Denser toward the middle of a stand.
        fitness *= lerp(1, smoothstep(threshold, 1, drift), spec.clumping);
      }

      // Final acceptance, so `density` means what it says once everything
      // above has had its say.
      if (rng.next() > fitness / 2.2) continue;

      // --- placement -------------------------------------------------------
      const ground = hf.height(x, z);
      const variation = hash3f(Math.round(x * 4), Math.round(z * 4), spec.index);

      // Size varies lognormally-ish: many small, a few large, which reads far
      // more naturally than a uniform spread.
      const sizeRoll = rng.next() * rng.next();
      const scale = lerp(spec.heightMin, spec.heightMax, 1 - sizeRoll);

      // Plants lean away from the slope a little, and rocks sit into it.
      const tilt = spec.group === 'rock' ? slope * 0.9 : slope * 0.35;

      out.push(
        x,
        // Sink slightly so nothing appears to hover over uneven ground.
        ground - scale * 0.02,
        z,
        rng.next() * Math.PI * 2,
        scale,
        tilt,
        variation
      );
    }

    if (out.length) {
      buffers.push(out);
      instances[spec.index] = new Float32Array(out);
    }
  }

  const msg: ScatterReady = {
    type: 'cell',
    key: req.key,
    cellX: req.cellX,
    cellZ: req.cellZ,
    instances,
  };
  const transfer = Object.values(instances).map((a) => a.buffer);
  return { msg, transfer };
}

/**
 * How well a value on a 0..1 environmental axis matches a -1..1 preference.
 *
 * Affinity 0 means indifferent, so the axis contributes nothing. Positive
 * affinity wants a high value, negative wants a low one, and the strength of
 * the preference decides how sharply the species is excluded from the wrong
 * end rather than merely thinned out.
 */
function preferenceFit(value: number, affinity: number): number {
  if (Math.abs(affinity) < 0.02) return 1;
  const want = affinity > 0 ? value : 1 - value;
  const strength = Math.abs(affinity);
  return clamp01(lerp(1, smoothstep(0.1, 0.75, want), strength));
}

self.onmessage = (e: MessageEvent<ScatterWorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    field = new Heightfield(msg.seed);
    species = msg.species;
    // One decorrelated drift field per species, so bilberry and heather clump
    // in different places instead of sharing a pattern.
    clumpNoise = species.map((_, i) => new Noise((msg.seed ^ 0xd1f7) + i * 3571));
    return;
  }
  if (msg.type === 'cell') {
    if (!field) throw new Error('scatter worker received work before init');
    const { msg: response, transfer } = buildCell(msg);
    (self as unknown as Worker).postMessage(response, transfer);
  }
};

// Referenced so the bundler keeps the import; the stride is part of the
// contract with the main thread.
void INSTANCE_STRIDE;
void hash2f;
