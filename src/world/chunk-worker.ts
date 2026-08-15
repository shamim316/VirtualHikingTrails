/// <reference lib="webworker" />
/**
 * Terrain mesher.
 *
 * Runs off the main thread so that walking never stutters while new ground is
 * built ahead of you. Given a square of world, it produces the ground mesh, a
 * matching water surface, and per-vertex blend weights for the ground shader.
 *
 * Two details worth knowing:
 *
 *  - Normals come from the height *grid*, not from re-sampling the heightfield.
 *    A one-vertex border is sampled beyond each edge so border normals are as
 *    correct as interior ones, and neighbouring chunks at the same level agree
 *    exactly along their shared edge.
 *
 *  - Every chunk carries a skirt: a ring of vertices dropped straight down from
 *    the border. Where a detailed chunk meets a coarse one the heights don't
 *    quite line up, and the skirt quietly fills the crack instead of letting
 *    you see through the world.
 */

import { Heightfield, createColumn, type Column, type SurfaceWeights } from './heightfield';
import {
  CHUNK_VERTS,
  SKIRT_DEPTH_RATIO,
  type ChunkReady,
  type ChunkRequest,
  type WorkerRequest,
} from './chunk-protocol';

let field: Heightfield | null = null;

const N = CHUNK_VERTS;          // vertices per edge of the visible mesh
const NB = CHUNK_VERTS + 2;     // with the sampling border

// Reused scratch buffers — one chunk is built at a time, and re-allocating
// these per request is a reliable way to cause garbage-collection hitches.
const gridH = new Float32Array(NB * NB);
const gridW = new Float32Array(NB * NB);
const gridRiverT = new Float32Array(NB * NB);
const column: Column = createColumn();
const weights: SurfaceWeights = { rock: 0, snow: 0, canopy: 0, wet: 0 };

function buildChunk(req: ChunkRequest): { msg: ChunkReady; transfer: Transferable[] } {
  const hf = field!;
  const { originX, originZ, size } = req;
  const step = size / (N - 1);

  // --- 1. Sample the height grid, including a one-vertex border. ------------
  let minY = Infinity;
  let maxY = -Infinity;
  let wetCount = 0;

  for (let j = 0; j < NB; j++) {
    const wz = originZ + (j - 1) * step;
    for (let i = 0; i < NB; i++) {
      const wx = originX + (i - 1) * step;
      hf.columnSample(wx, wz, column);
      const idx = j * NB + i;
      gridH[idx] = column.height;
      gridW[idx] = column.water;
      gridRiverT[idx] = column.riverT;
      if (column.water > -Infinity) wetCount++;
      if (column.height < minY) minY = column.height;
      if (column.height > maxY) maxY = column.height;
    }
  }

  // --- 2. Ground mesh ------------------------------------------------------
  const skirtCount = 4 * N;
  const vertCount = N * N + skirtCount;
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const surface = new Uint8Array(vertCount * 4);

  const skirtDepth = Math.max(1.5, size * SKIRT_DEPTH_RATIO);

  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const gi = (j + 1) * NB + (i + 1);
      const h = gridH[gi];
      const v = j * N + i;

      positions[v * 3] = i * step;
      positions[v * 3 + 1] = h;
      positions[v * 3 + 2] = j * step;

      // Central differences on the grid. The border ring means this is valid
      // right up to the chunk edge.
      const hL = gridH[gi - 1];
      const hR = gridH[gi + 1];
      const hD = gridH[gi - NB];
      const hU = gridH[gi + NB];
      let nx = hL - hR;
      let ny = 2 * step;
      let nz = hD - hU;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      normals[v * 3] = nx;
      normals[v * 3 + 1] = ny;
      normals[v * 3 + 2] = nz;

      const slope = Math.max(0, Math.min(1, 1 - ny));
      hf.surfaceWeights(originX + i * step, originZ + j * step, h, slope, gridRiverT[gi], weights);
      surface[v * 4] = (weights.rock * 255) | 0;
      surface[v * 4 + 1] = (weights.snow * 255) | 0;
      surface[v * 4 + 2] = (weights.canopy * 255) | 0;
      surface[v * 4 + 3] = (weights.wet * 255) | 0;
    }
  }

  // Skirt vertices: copies of the border ring, pushed straight down.
  let sv = N * N;
  const addSkirt = (i: number, j: number) => {
    const src = j * N + i;
    positions[sv * 3] = positions[src * 3];
    positions[sv * 3 + 1] = positions[src * 3 + 1] - skirtDepth;
    positions[sv * 3 + 2] = positions[src * 3 + 2];
    // Point the skirt outward-ish so it shades like the wall it stands in for
    // rather than catching light as if it faced the sky.
    normals[sv * 3] = normals[src * 3];
    normals[sv * 3 + 1] = 0;
    normals[sv * 3 + 2] = normals[src * 3 + 2];
    surface[sv * 4] = surface[src * 4];
    surface[sv * 4 + 1] = surface[src * 4 + 1];
    surface[sv * 4 + 2] = surface[src * 4 + 2];
    surface[sv * 4 + 3] = surface[src * 4 + 3];
    return sv++;
  };

  const skirtSouth = new Int32Array(N);
  const skirtNorth = new Int32Array(N);
  const skirtWest = new Int32Array(N);
  const skirtEast = new Int32Array(N);
  for (let i = 0; i < N; i++) skirtSouth[i] = addSkirt(i, 0);
  for (let i = 0; i < N; i++) skirtNorth[i] = addSkirt(i, N - 1);
  for (let j = 0; j < N; j++) skirtWest[j] = addSkirt(0, j);
  for (let j = 0; j < N; j++) skirtEast[j] = addSkirt(N - 1, j);

  // --- 3. Ground indices ---------------------------------------------------
  const quadCount = (N - 1) * (N - 1);
  const indices = new Uint32Array(quadCount * 6 + (N - 1) * 6 * 4);
  let t = 0;
  for (let j = 0; j < N - 1; j++) {
    for (let i = 0; i < N - 1; i++) {
      const a = j * N + i;
      const b = a + 1;
      const c = a + N;
      const d = c + 1;
      // Split each quad along its shorter diagonal so ridgelines stay sharp
      // instead of being sliced flat by an arbitrary triangulation.
      if (Math.abs(gridH[(j + 1) * NB + i + 1] - gridH[(j + 2) * NB + i + 2]) <
          Math.abs(gridH[(j + 1) * NB + i + 2] - gridH[(j + 2) * NB + i + 1])) {
        indices[t++] = a; indices[t++] = c; indices[t++] = d;
        indices[t++] = a; indices[t++] = d; indices[t++] = b;
      } else {
        indices[t++] = a; indices[t++] = c; indices[t++] = b;
        indices[t++] = b; indices[t++] = c; indices[t++] = d;
      }
    }
  }

  // Skirt triangles, wound so they face outward from the chunk.
  for (let i = 0; i < N - 1; i++) {
    const a = 0 * N + i, b = 0 * N + i + 1;
    indices[t++] = a; indices[t++] = b; indices[t++] = skirtSouth[i];
    indices[t++] = b; indices[t++] = skirtSouth[i + 1]; indices[t++] = skirtSouth[i];
  }
  for (let i = 0; i < N - 1; i++) {
    const a = (N - 1) * N + i, b = (N - 1) * N + i + 1;
    indices[t++] = a; indices[t++] = skirtNorth[i]; indices[t++] = b;
    indices[t++] = b; indices[t++] = skirtNorth[i]; indices[t++] = skirtNorth[i + 1];
  }
  for (let j = 0; j < N - 1; j++) {
    const a = j * N, b = (j + 1) * N;
    indices[t++] = a; indices[t++] = skirtWest[j]; indices[t++] = b;
    indices[t++] = b; indices[t++] = skirtWest[j]; indices[t++] = skirtWest[j + 1];
  }
  for (let j = 0; j < N - 1; j++) {
    const a = j * N + N - 1, b = (j + 1) * N + N - 1;
    indices[t++] = a; indices[t++] = b; indices[t++] = skirtEast[j];
    indices[t++] = b; indices[t++] = skirtEast[j + 1]; indices[t++] = skirtEast[j];
  }

  // --- 4. Water surface ----------------------------------------------------
  const water = req.wantWater && wetCount > 0 ? buildWater(step) : null;

  const msg: ChunkReady = {
    type: 'chunk',
    key: req.key,
    originX,
    originZ,
    size,
    positions,
    normals,
    surface,
    indices,
    minY: minY - skirtDepth,
    maxY,
    water,
  };

  const transfer: Transferable[] = [
    positions.buffer, normals.buffer, surface.buffer, indices.buffer,
  ];
  if (water) {
    transfer.push(water.positions.buffer, water.flow.buffer, water.params.buffer, water.indices.buffer);
  }
  return { msg, transfer };
}

/**
 * Build the water surface for the chunk currently held in the grid buffers.
 *
 * A vertex is "wet" if the water surface stands above the bed there. Dry
 * vertices are pinned to the ground height, so the water sheet meets the bank
 * exactly at the waterline and there is never a floating edge. Flow direction
 * is simply the downhill gradient of the water surface — which means a stream
 * running over a cliff automatically gets a fast, near-vertical current, and a
 * lake gets none at all.
 */
function buildWater(step: number) {
  const positions: number[] = [];
  const flow: number[] = [];
  const params: number[] = [];
  const indices: number[] = [];
  const vertexIndex = new Int32Array(N * N).fill(-1);

  const surfaceAt = (i: number, j: number) => {
    const gi = (j + 1) * NB + (i + 1);
    const w = gridW[gi];
    return w > -Infinity ? w : gridH[gi];
  };

  const isWet = (i: number, j: number) => gridW[(j + 1) * NB + (i + 1)] > -Infinity;

  const emit = (i: number, j: number) => {
    const at = j * N + i;
    if (vertexIndex[at] >= 0) return vertexIndex[at];

    const gi = (j + 1) * NB + (i + 1);
    const h = surfaceAt(i, j);
    const ground = gridH[gi];

    // Gradient of the water surface, clamped to the chunk.
    const iL = Math.max(0, i - 1), iR = Math.min(N - 1, i + 1);
    const jD = Math.max(0, j - 1), jU = Math.min(N - 1, j + 1);
    const dx = (surfaceAt(iR, j) - surfaceAt(iL, j)) / ((iR - iL) * step || 1);
    const dz = (surfaceAt(i, jU) - surfaceAt(i, jD)) / ((jU - jD) * step || 1);

    const gradient = Math.hypot(dx, dz);
    // Water accelerates downhill; the constant just maps a plausible slope to
    // a plausible surface speed rather than modelling anything properly.
    const speed = Math.min(6, gradient * 9);
    const len = gradient || 1;

    const depth = Math.max(0, h - ground);
    // Foam where it's shallow, and whitewater where it's steep.
    const shore = 1 - Math.min(1, depth / 0.5);
    // Whitewater needs a threshold and a gentler ramp. At `gradient * 3.2`
    // anything past a 17 degree fall was 100% white, so every hill stream in
    // the world was a flat paper ribbon rather than water with fast reaches
    // and slack ones.
    const white = Math.min(1, Math.max(0, gradient - 0.07) * 1.9);

    positions.push(i * step, h, j * step);
    flow.push(-dx / len, -dz / len, speed);
    params.push(depth, shore, white);

    vertexIndex[at] = positions.length / 3 - 1;
    return vertexIndex[at];
  };

  for (let j = 0; j < N - 1; j++) {
    for (let i = 0; i < N - 1; i++) {
      // Emit a quad if any corner is genuinely under water.
      if (!isWet(i, j) && !isWet(i + 1, j) && !isWet(i, j + 1) && !isWet(i + 1, j + 1)) continue;
      const a = emit(i, j);
      const b = emit(i + 1, j);
      const c = emit(i, j + 1);
      const d = emit(i + 1, j + 1);
      indices.push(a, c, d, a, d, b);
    }
  }

  if (indices.length === 0) return null;

  return {
    positions: new Float32Array(positions),
    flow: new Float32Array(flow),
    params: new Float32Array(params),
    indices: new Uint32Array(indices),
  };
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    field = new Heightfield(msg.seed);
    return;
  }
  if (msg.type === 'chunk') {
    if (!field) throw new Error('chunk worker received work before init');
    const { msg: response, transfer } = buildChunk(msg);
    (self as unknown as Worker).postMessage(response, transfer);
  }
};
