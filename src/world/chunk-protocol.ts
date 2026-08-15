/**
 * The message contract between the main thread and the terrain workers.
 *
 * Kept in its own module so both sides import exactly the same shapes, and so
 * neither side accidentally drags a three.js import into the worker bundle.
 */

/** Vertices along one edge of a chunk mesh. 33 verts = 32 quads. */
export const CHUNK_VERTS = 33;

/** Size in metres of the smallest (highest detail) quadtree leaf. */
export const MIN_LEAF_SIZE = 32;

/** Size in metres of the whole quadtree root. Half of this is the view radius. */
export const ROOT_SIZE = 8192;

/**
 * How far below the surface chunk edges are extended to hide LOD seams.
 *
 * A skirt only has to cover the height disagreement between a chunk and its
 * coarser neighbour, which is roughly the terrain's variation over one of the
 * coarse chunk's steps. Sized as a fraction of the whole chunk it becomes a
 * fifteen-metre wall hanging off a 256m chunk, and on a steep hillside those
 * walls are not buried by the neighbour at all — they stand out of the slope
 * like a staircase of ruins.
 */
export const SKIRT_DEPTH_RATIO = 0.022;

export interface ChunkRequest {
  type: 'chunk';
  /** Stable identity: level + integer grid coordinates at that level. */
  key: string;
  /** World-space coordinates of the chunk's minimum corner. */
  originX: number;
  originZ: number;
  /** Edge length in metres. */
  size: number;
  /** Whether to also build a water surface mesh for this chunk. */
  wantWater: boolean;
}

export interface ChunkReady {
  type: 'chunk';
  key: string;
  originX: number;
  originZ: number;
  size: number;
  /** Interleaved xyz, chunk-local, metres. */
  positions: Float32Array;
  /** Interleaved xyz unit normals. */
  normals: Float32Array;
  /**
   * Per-vertex surface blend weights, normalised bytes:
   * r = bare rock, g = snow, b = moisture, a = streambed wetness.
   */
  surface: Uint8Array;
  indices: Uint32Array;
  /** Lowest and highest ground height, for frustum/occlusion bounds. */
  minY: number;
  maxY: number;
  /** Water surface geometry, present only where there is water. */
  water: {
    positions: Float32Array;
    /** x = flow direction x, y = flow direction z, z = current speed. */
    flow: Float32Array;
    /** x = depth in metres, y = 1 near a bank, z = whitewater amount. */
    params: Float32Array;
    indices: Uint32Array;
  } | null;
}

export interface WorkerInit {
  type: 'init';
  seed: number;
}

export type WorkerRequest = WorkerInit | ChunkRequest;
export type WorkerResponse = ChunkReady;

/** Build the stable key for a quadtree node. */
export function chunkKey(level: number, gx: number, gz: number): string {
  return `${level}:${gx}:${gz}`;
}
