/**
 * Terrain streaming.
 *
 * The visible ground is a quadtree over the infinite world: cells subdivide as
 * they approach the camera, so there is roughly a metre between vertices under
 * your boots and a couple of hundred metres out at the horizon, for a fairly
 * constant triangle cost wherever you stand.
 *
 * Cells live on an absolute grid rather than one that follows the player, which
 * means a cell's identity — and so its cached mesh — survives you walking away
 * and coming back.
 */

import * as THREE from 'three';
import {
  CHUNK_VERTS,
  MIN_LEAF_SIZE,
  chunkKey,
  type ChunkReady,
  type ChunkRequest,
} from './chunk-protocol';
import { Heightfield } from './heightfield';

/**
 * Subdivide a cell when the camera is closer than this many cell-widths.
 *
 * Generous, because the visible cost of a coarse chunk is not its silhouette
 * but the height error at its border with a finer neighbour — and on steep
 * ground that error is what the skirts have to paper over. Pushing the coarse
 * levels further out is much cheaper than making the seams invisible.
 */
const LOD_FACTOR = 3.2;

/** Deepest subdivision: top cells are MIN_LEAF_SIZE << MAX_LEVEL metres across. */
const MAX_LEVEL = 8;

/** Cells at or below this size get a water surface built for them. */
const WATER_MAX_SIZE = 256;

/** Keep this many unused chunk meshes before discarding the oldest. */
const CACHE_LIMIT = 320;

interface Cell {
  key: string;
  level: number;
  originX: number;
  originZ: number;
  size: number;
}

interface ChunkMesh {
  key: string;
  ground: THREE.Mesh;
  water: THREE.Mesh | null;
  size: number;
  originX: number;
  originZ: number;
  /** Frame index when this was last visible, for cache eviction. */
  lastUsed: number;
}

export interface TerrainOptions {
  seed: number;
  workers: number;
  viewDistance: number;
  groundMaterial: THREE.Material;
  waterMaterial: THREE.Material;
}

export class Terrain {
  readonly group = new THREE.Group();
  readonly waterGroup = new THREE.Group();
  /** Main-thread copy of the world function, for collision and scatter. */
  readonly field: Heightfield;

  private workers: Worker[] = [];
  private nextWorker = 0;
  private pending = new Map<string, Cell>();
  private cache = new Map<string, ChunkMesh>();
  private visible = new Set<string>();
  private queue: Cell[] = [];
  private frame = 0;
  private viewDistance: number;
  private groundMaterial: THREE.Material;
  private waterMaterial: THREE.Material;
  private disposed = false;

  /** Fired whenever a chunk's geometry arrives, so vegetation can follow. */
  onChunkReady: ((originX: number, originZ: number, size: number) => void) | null = null;

  constructor(opts: TerrainOptions) {
    this.field = new Heightfield(opts.seed);
    this.viewDistance = opts.viewDistance;
    this.groundMaterial = opts.groundMaterial;
    this.waterMaterial = opts.waterMaterial;

    this.group.name = 'terrain';
    this.waterGroup.name = 'water';
    // Water is drawn after the ground so it can read the depth buffer for
    // shoreline foam without fighting itself.
    this.waterGroup.renderOrder = 10;

    const count = Math.max(1, Math.min(opts.workers, 8));
    for (let i = 0; i < count; i++) {
      const worker = new Worker(new URL('./chunk-worker.ts', import.meta.url), { type: 'module' });
      worker.postMessage({ type: 'init', seed: opts.seed });
      worker.onmessage = (e: MessageEvent<ChunkReady>) => this.onChunkMessage(e.data);
      this.workers.push(worker);
    }
  }

  setViewDistance(distance: number) {
    this.viewDistance = distance;
  }

  /**
   * Walk the quadtree and decide which cells should be on screen.
   *
   * Because each cell is either kept whole or replaced by exactly its four
   * children, the result always tiles the plane with no gaps — the only
   * mismatch is in vertex density across a boundary, which the skirts cover.
   */
  private collectCells(camX: number, camZ: number, out: Cell[]) {
    out.length = 0;
    const topSize = MIN_LEAF_SIZE << MAX_LEVEL;
    const reach = this.viewDistance;

    const minGX = Math.floor((camX - reach) / topSize);
    const maxGX = Math.floor((camX + reach) / topSize);
    const minGZ = Math.floor((camZ - reach) / topSize);
    const maxGZ = Math.floor((camZ + reach) / topSize);

    const stack: Cell[] = [];
    for (let gz = minGZ; gz <= maxGZ; gz++) {
      for (let gx = minGX; gx <= maxGX; gx++) {
        stack.push({
          key: chunkKey(MAX_LEVEL, gx, gz),
          level: MAX_LEVEL,
          originX: gx * topSize,
          originZ: gz * topSize,
          size: topSize,
        });
      }
    }

    while (stack.length) {
      const cell = stack.pop()!;
      const dist = distanceToCell(camX, camZ, cell);
      if (dist > reach) continue;

      if (cell.size > MIN_LEAF_SIZE && dist < cell.size * LOD_FACTOR) {
        const half = cell.size / 2;
        const level = cell.level - 1;
        const gx = Math.round(cell.originX / half);
        const gz = Math.round(cell.originZ / half);
        for (let j = 0; j < 2; j++) {
          for (let i = 0; i < 2; i++) {
            stack.push({
              key: chunkKey(level, gx + i, gz + j),
              level,
              originX: cell.originX + i * half,
              originZ: cell.originZ + j * half,
              size: half,
            });
          }
        }
      } else {
        out.push(cell);
      }
    }
  }

  private scratchCells: Cell[] = [];

  update(camera: THREE.Camera) {
    if (this.disposed) return;
    this.frame++;

    const camX = camera.position.x;
    const camZ = camera.position.z;

    this.collectCells(camX, camZ, this.scratchCells);

    const wanted = new Set<string>();
    this.queue.length = 0;

    for (const cell of this.scratchCells) {
      wanted.add(cell.key);
      const mesh = this.cache.get(cell.key);
      if (mesh) {
        mesh.lastUsed = this.frame;
        if (!this.visible.has(cell.key)) {
          this.group.add(mesh.ground);
          if (mesh.water) this.waterGroup.add(mesh.water);
          this.visible.add(cell.key);
        }
      } else if (!this.pending.has(cell.key)) {
        this.queue.push(cell);
      }
    }

    // Hide what fell out of view, but keep the geometry around: walking back
    // over a ridge you just crossed should be instant.
    for (const key of this.visible) {
      if (wanted.has(key)) continue;
      const mesh = this.cache.get(key);
      if (mesh) {
        this.group.remove(mesh.ground);
        if (mesh.water) this.waterGroup.remove(mesh.water);
      }
      this.visible.delete(key);
    }

    // Build the nearest missing ground first — the hole you're about to walk
    // into matters more than the one on the skyline.
    this.queue.sort((a, b) => distanceToCell(camX, camZ, a) - distanceToCell(camX, camZ, b));
    const budget = Math.max(1, this.workers.length * 3) - this.pending.size;
    for (let i = 0; i < Math.min(budget, this.queue.length); i++) {
      this.request(this.queue[i]);
    }

    this.evict();
  }

  private request(cell: Cell) {
    this.pending.set(cell.key, cell);
    const req: ChunkRequest = {
      type: 'chunk',
      key: cell.key,
      originX: cell.originX,
      originZ: cell.originZ,
      size: cell.size,
      wantWater: cell.size <= WATER_MAX_SIZE,
    };
    this.workers[this.nextWorker].postMessage(req);
    this.nextWorker = (this.nextWorker + 1) % this.workers.length;
  }

  private onChunkMessage(data: ChunkReady) {
    if (this.disposed) return;
    this.pending.delete(data.key);
    if (this.cache.has(data.key)) return;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geometry.setAttribute('surface', new THREE.BufferAttribute(data.surface, 4, true));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    // The mesher already knows the vertical extent, so bounds come for free.
    // Positions carry true world height (the mesh is only offset in x/z), so
    // minY/maxY are already in the geometry's own frame.
    geometry.boundingBox = new THREE.Box3(
      new THREE.Vector3(0, data.minY, 0),
      new THREE.Vector3(data.size, data.maxY, data.size)
    );
    geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(data.size / 2, (data.minY + data.maxY) / 2, data.size / 2),
      0.5 * Math.hypot(data.size * Math.SQRT2, data.maxY - data.minY)
    );

    const ground = new THREE.Mesh(geometry, this.groundMaterial);
    ground.position.set(data.originX, 0, data.originZ);
    ground.matrixAutoUpdate = false;
    ground.updateMatrix();
    ground.castShadow = data.size <= 128;
    ground.receiveShadow = true;
    ground.frustumCulled = true;

    let water: THREE.Mesh | null = null;
    if (data.water) {
      const wg = new THREE.BufferGeometry();
      wg.setAttribute('position', new THREE.BufferAttribute(data.water.positions, 3));
      wg.setAttribute('flow', new THREE.BufferAttribute(data.water.flow, 3));
      wg.setAttribute('waterParams', new THREE.BufferAttribute(data.water.params, 3));
      wg.setIndex(new THREE.BufferAttribute(data.water.indices, 1));
      wg.computeBoundingSphere();
      water = new THREE.Mesh(wg, this.waterMaterial);
      water.position.set(data.originX, 0, data.originZ);
      water.matrixAutoUpdate = false;
      water.updateMatrix();
      water.receiveShadow = false;
      water.castShadow = false;
      water.renderOrder = 10;
    }

    const entry: ChunkMesh = {
      key: data.key,
      ground,
      water,
      size: data.size,
      originX: data.originX,
      originZ: data.originZ,
      lastUsed: this.frame,
    };
    this.cache.set(data.key, entry);

    this.group.add(ground);
    if (water) this.waterGroup.add(water);
    this.visible.add(data.key);

    this.onChunkReady?.(data.originX, data.originZ, data.size);
  }

  private evict() {
    if (this.cache.size <= CACHE_LIMIT) return;
    const entries = [...this.cache.values()]
      .filter((m) => !this.visible.has(m.key))
      .sort((a, b) => a.lastUsed - b.lastUsed);

    let toRemove = this.cache.size - CACHE_LIMIT;
    for (const entry of entries) {
      if (toRemove-- <= 0) break;
      entry.ground.geometry.dispose();
      entry.water?.geometry.dispose();
      this.cache.delete(entry.key);
    }
  }

  /** Ground height, for standing the player on the world. */
  heightAt(x: number, z: number): number {
    return this.field.height(x, z);
  }

  /** Water surface height, or -Infinity on dry land. */
  waterAt(x: number, z: number): number {
    return this.field.waterHeight(x, z);
  }

  get chunkCount(): number {
    return this.visible.size;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  dispose() {
    this.disposed = true;
    for (const worker of this.workers) worker.terminate();
    this.workers.length = 0;
    for (const entry of this.cache.values()) {
      entry.ground.geometry.dispose();
      entry.water?.geometry.dispose();
    }
    this.cache.clear();
    this.visible.clear();
    this.group.clear();
    this.waterGroup.clear();
  }
}

/** Distance from a point to the nearest point of a cell's footprint. */
function distanceToCell(x: number, z: number, cell: Cell): number {
  const dx = Math.max(cell.originX - x, 0, x - (cell.originX + cell.size));
  const dz = Math.max(cell.originZ - z, 0, z - (cell.originZ + cell.size));
  return Math.hypot(dx, dz);
}

export { CHUNK_VERTS, MIN_LEAF_SIZE };
