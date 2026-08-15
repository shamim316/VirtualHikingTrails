/**
 * Message contract for the vegetation scatterer.
 *
 * Instances are packed into flat Float32Arrays rather than objects, so a cell
 * carrying a few thousand plants transfers as one buffer with no per-instance
 * allocation on either side.
 */

/** Edge length in metres of one scatter cell. */
export const SCATTER_CELL = 24;

/** Floats per instance: x, y, z, rotY, scale, tilt, variation. */
export const INSTANCE_STRIDE = 7;

export interface ScatterSpecies {
  id: string;
  /** Index into the shared species table, used as the array key. */
  index: number;
  biomes: number[];
  altitudeMin: number;
  altitudeMax: number;
  maxSlope: number;
  moisture: number;
  canopy: number;
  density: number;
  clumping: number;
  heightMin: number;
  heightMax: number;
  /** Groups are scattered at different radii, so they're kept separate. */
  group: string;
}

export interface ScatterInit {
  type: 'init';
  seed: number;
  species: ScatterSpecies[];
}

export interface ScatterRequest {
  type: 'cell';
  key: string;
  cellX: number;
  cellZ: number;
  /** Global multiplier from the quality tier. */
  density: number;
}

export interface ScatterReady {
  type: 'cell';
  key: string;
  cellX: number;
  cellZ: number;
  /** Species index -> packed instances. Only species with instances appear. */
  instances: Record<number, Float32Array>;
}

export type ScatterWorkerRequest = ScatterInit | ScatterRequest;

export function scatterKey(cellX: number, cellZ: number): string {
  return `${cellX}:${cellZ}`;
}
