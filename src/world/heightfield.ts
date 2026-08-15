/**
 * The terrain itself.
 *
 * This module is a *pure function of position*. Give it an (x, z) and a seed
 * and it tells you the ground height, the surface normal, how wet the soil is,
 * whether there's water and how high its surface sits. Nothing here touches
 * three.js, the DOM, or any mutable world state, which is the whole point: the
 * chunk worker imports it to build meshes, and the main thread imports it to
 * stand the player on the ground and to decide where a fern grows. One source
 * of truth means the ground you see is always the ground you walk on.
 *
 * Layers, coarse to fine:
 *   1. continent  — very low frequency, decides lowland vs. high country
 *   2. ridges     — domain-warped ridged multifractal, the mountains
 *   3. hills      — mid-frequency rolling ground
 *   4. detail     — the bumps you actually walk over
 *   5. strata     — bench-like layering on steep rock
 *   6. lakes      — deterministic basins carved into the above
 *   7. rivers     — channels carved along a branching network
 */

import { Noise, clamp01, lerp, smoothstep, remap01 } from './noise';
import { hash2f } from '../core/rng';

// --- World scale -----------------------------------------------------------
// One world unit is one metre. Valley floors sit around 190m, the highest
// peaks reach a little over 900m, and snow starts to hold around 700m.

export const BASE_ELEVATION = 190;
export const SNOW_LINE = 700;
export const TREE_LINE = 620;

/** Lake basins are placed one-per-cell on this grid. */
const LAKE_CELL = 1400;

export const enum Biome {
  Meadow = 0,
  Forest = 1,
  Conifer = 2,
  Riverbank = 3,
  Scree = 4,
  Snow = 5,
  Lakeshore = 6,
}

export interface TerrainSample {
  /** Final ground height in metres. */
  height: number;
  /** Unit surface normal. */
  nx: number;
  ny: number;
  nz: number;
  /** 0 = flat ground, 1 = vertical rock. */
  slope: number;
  /** 0 = arid scree, 1 = saturated streambank. */
  moisture: number;
  /** How much bare rock shows through, 0..1. */
  rockiness: number;
  /** Snow coverage, 0..1. */
  snow: number;
  /** How exposed the spot is to wind, 0..1 — drives the wind audio layer. */
  exposure: number;
  /** Forest canopy density overhead, 0..1. */
  canopy: number;
  /** 1 at a stream's centreline, falling to 0 at its bank. */
  riverT: number;
  /** Water surface height, or -Infinity if this spot is dry. */
  waterHeight: number;
  /** Dominant biome, used to pick which species may grow here. */
  biome: Biome;
}

export function createSample(): TerrainSample {
  return {
    height: 0, nx: 0, ny: 1, nz: 0, slope: 0, moisture: 0, rockiness: 0,
    snow: 0, exposure: 0, canopy: 0, riverT: 0, waterHeight: -Infinity,
    biome: Biome.Meadow,
  };
}

export interface RiverInfo {
  /** 0 on dry ground, 1 at the centreline. */
  t: number;
  /** How far the channel is cut below the surrounding ground, in metres. */
  depth: number;
  /** Depth of the water standing in that channel, in metres. */
  waterDepth: number;
  /** 0 = headwater trickle, 1 = the main stream of the valley. */
  size: number;
}

/** One vertical column of the world, as the mesher needs it. */
export interface Column {
  height: number;
  /** Water surface height, or -Infinity where dry. */
  water: number;
  riverT: number;
  riverSize: number;
}

export function createColumn(): Column {
  return { height: 0, water: -Infinity, riverT: 0, riverSize: 0 };
}

/** Ground blend weights, matching the terrain shader's `surface` attribute. */
export interface SurfaceWeights {
  /** Bare rock showing through. */
  rock: number;
  snow: number;
  /** Canopy overhead, which decides needle litter vs. open meadow underfoot. */
  canopy: number;
  /** Streambed wetness. */
  wet: number;
}

export interface Lake {
  x: number;
  z: number;
  radius: number;
  depth: number;
  /** Terrain height at the basin rim, before carving. */
  rim: number;
  /** Height of the still water surface. */
  surface: number;
}

export class Heightfield {
  readonly seed: number;

  private nContinent: Noise;
  private nRidge: Noise;
  private nHills: Noise;
  private nDetail: Noise;
  private nWarp: Noise;
  private nWarpB: Noise;
  private nRiver: Noise;
  private nRiverSize: Noise;
  private nMoisture: Noise;
  private nRock: Noise;
  private nForest: Noise;
  private nSnow: Noise;

  /** Lake basins are re-derived constantly; cache the last cell block. */
  private lakeCache = new Map<number, Lake | null>();

  constructor(seed: number) {
    this.seed = seed >>> 0;
    // Each layer gets its own decorrelated permutation table.
    this.nContinent = new Noise(seed ^ 0x1000);
    this.nRidge = new Noise(seed ^ 0x2000);
    this.nHills = new Noise(seed ^ 0x3000);
    this.nDetail = new Noise(seed ^ 0x4000);
    this.nWarp = new Noise(seed ^ 0x5000);
    this.nWarpB = new Noise(seed ^ 0x6000);
    this.nRiver = new Noise(seed ^ 0x7000);
    this.nRiverSize = new Noise(seed ^ 0x8000);
    this.nMoisture = new Noise(seed ^ 0x9000);
    this.nRock = new Noise(seed ^ 0xa000);
    this.nForest = new Noise(seed ^ 0xb000);
    this.nSnow = new Noise(seed ^ 0xc000);
  }

  // -------------------------------------------------------------------------
  // Base terrain, before any water is carved into it.
  // -------------------------------------------------------------------------

  /**
   * The landscape as it would be with no rivers and no lakes. River water
   * surfaces are derived from this, which is what keeps a stream's surface
   * level across its own width while still falling downhill.
   */
  baseHeight(x: number, z: number): number {
    // Domain warp: push the sample point around with low-frequency noise so
    // ridges bend and fold instead of running in straight noise-aligned bands.
    const wx = this.nWarp.fbm2(x * 0.00042, z * 0.00042, 3) * 260;
    const wz = this.nWarpB.fbm2(x * 0.00042, z * 0.00042, 3) * 260;
    const px = x + wx;
    const pz = z + wz;

    // 1. Continent — where the high country is at all. The transition is
    //    deliberately wide: mountains that begin at a line look like a wall,
    //    and real ranges rise out of their foothills over kilometres.
    const continent = this.nContinent.fbm2(x * 0.000085, z * 0.000085, 4);
    const mountainMask = smoothstep(-0.5, 0.74, continent);

    // 2. Ridges — the mountains proper.
    //
    //    The gain matters enormously here. Each octave contributes slope in
    //    proportion to amplitude × frequency, so with the textbook gain of 0.5
    //    against a lacunarity of ~2 every octave adds *as much* slope as the
    //    one before and six of them stack into 60° faces nobody could walk.
    //    Dropping the gain makes each octave contribute less than the last,
    //    which is both more walkable and closer to how eroded rock behaves.
    const ridge = this.nRidge.ridged2(px * 0.00042, pz * 0.00042, 6, 2.07, 0.36);

    // 3. Hills — rolling mid-scale ground. Present everywhere, so the lowlands
    //    are gentle country rather than a plain.
    const hills = this.nHills.fbm2(px * 0.0014, pz * 0.0014, 4) * 0.5 + 0.5;
    const swells = this.nHills.fbm2(px * 0.0052 + 91.3, pz * 0.0052 - 47.1, 3);

    // 4. Detail — metre-scale undulation underfoot.
    const detail = this.nDetail.fbm2(x * 0.011, z * 0.011, 3);

    let h = BASE_ELEVATION;
    h += continent * 150;
    h += mountainMask * ridge * 620;
    h += hills * (44 + 26 * mountainMask);
    h += swells * (6.5 + 4 * mountainMask);
    h += detail * (2.6 + 3.4 * mountainMask);

    // 5. Strata — steep rock gets bench-like layering, the way bedded rock
    //    weathers into steps. Only applied high up, where rock is exposed.
    const rockExposure = clamp01((h - 380) / 260);
    if (rockExposure > 0) {
      const strata = Math.sin(h * 0.42 + this.nRock.noise2(px * 0.002, pz * 0.002) * 2.2);
      h += strata * 1.9 * rockExposure * ridge;
    }

    return h;
  }

  /**
   * How ridge-like this spot is, 0..1. Used to keep streams out of the places
   * water would never actually collect — you don't find a brook on a knife
   * edge.
   */
  private ridgeness(x: number, z: number): number {
    const wx = this.nWarp.fbm2(x * 0.00042, z * 0.00042, 3) * 260;
    const wz = this.nWarpB.fbm2(x * 0.00042, z * 0.00042, 3) * 260;
    return this.nRidge.ridged2((x + wx) * 0.00058, (z + wz) * 0.00058, 4, 2.07, 0.5);
  }

  // -------------------------------------------------------------------------
  // Lakes
  // -------------------------------------------------------------------------

  /** The lake owned by a given grid cell, or null if that cell has none. */
  private lakeForCell(cx: number, cz: number): Lake | null {
    const key = (cx & 0xffff) * 65536 + (cz & 0xffff);
    const cached = this.lakeCache.get(key);
    if (cached !== undefined) return cached;

    let lake: Lake | null = null;
    const r0 = hash2f(cx ^ this.seed, cz * 3 + 11);
    // Only about a third of cells hold water — lakes should feel found, not
    // scheduled.
    if (r0 < 0.34) {
      const jx = hash2f(cx * 7 + 3, cz ^ this.seed);
      const jz = hash2f(cx ^ 0x5f3a, cz * 13 + 5);
      const rs = hash2f(cx * 31 + 17, cz * 29 + 7);

      const lx = (cx + 0.18 + jx * 0.64) * LAKE_CELL;
      const lz = (cz + 0.18 + jz * 0.64) * LAKE_CELL;
      const radius = lerp(26, 155, rs * rs);

      const rim = this.baseHeight(lx, lz);
      // No lakes clinging to the sides of peaks — water needs somewhere to sit.
      const flat = 1 - this.ridgeness(lx, lz);
      if (flat > 0.45 && rim < 780) {
        const depth = lerp(3.5, 16, rs) * (0.6 + 0.4 * flat);
        lake = { x: lx, z: lz, radius, depth, rim, surface: rim - 0.4 };
      }
    }

    // The cache is unbounded in principle but bounded in practice: the player
    // only ever occupies a handful of cells. Trim it if it drifts.
    if (this.lakeCache.size > 512) this.lakeCache.clear();
    this.lakeCache.set(key, lake);
    return lake;
  }

  /** Every lake whose influence could reach this point (at most a 3×3 block). */
  lakesNear(x: number, z: number, out: Lake[]): Lake[] {
    out.length = 0;
    const cx = Math.floor(x / LAKE_CELL);
    const cz = Math.floor(z / LAKE_CELL);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const lake = this.lakeForCell(cx + dx, cz + dz);
        if (lake) out.push(lake);
      }
    }
    return out;
  }

  private scratchLakes: Lake[] = [];
  private scratchNormal = { x: 0, y: 1, z: 0 };
  private scratchRiver: RiverInfo = { t: 0, depth: 0, waterDepth: 0, size: 0 };
  private scratchRiverB: RiverInfo = { t: 0, depth: 0, waterDepth: 0, size: 0 };

  /**
   * Blend lake basins into the terrain. Returns the modified height and, if the
   * point is inside a lake, records that lake's water surface.
   */
  private applyLakes(x: number, z: number, h: number): { h: number; water: number } {
    const lakes = this.lakesNear(x, z, this.scratchLakes);
    let water = -Infinity;

    for (let i = 0; i < lakes.length; i++) {
      const lake = lakes[i];
      const dx = x - lake.x;
      const dz = z - lake.z;
      const d = Math.sqrt(dx * dx + dz * dz) / lake.radius;
      if (d > 1.75) continue;

      // Blend the natural terrain into a bowl. The 1.0–1.75 band is the
      // shoulder, where the surrounding ground eases down to the rim, so
      // basins never sit in the landscape like stamped-out craters.
      const influence = 1 - smoothstep(1.0, 1.75, d);
      const inner = clamp01(d);
      const bowl = lake.rim - lake.depth * (1 - inner * inner) * (1 - inner * 0.35);
      h = lerp(h, bowl, influence);

      if (d < 1.0) water = Math.max(water, lake.surface);
    }

    return { h, water };
  }

  // -------------------------------------------------------------------------
  // Rivers
  // -------------------------------------------------------------------------

  /** The raw signed stream field. Its zero set is the network of channels. */
  private riverSigned(x: number, z: number): number {
    const wx = this.nWarp.fbm2(x * 0.0003, z * 0.0003, 2) * 420;
    const wz = this.nWarpB.fbm2(x * 0.0003, z * 0.0003, 2) * 420;
    return this.nRiver.fbm2((x + wx) * 0.00042, (z + wz) * 0.00042, 4);
  }

  /**
   * The stream network. Taking |noise| gives a branching set of zero-crossing
   * lines that wander for kilometres and join naturally — a much better match
   * for how a catchment actually looks than anything drawn by hand.
   *
   * The subtlety is width. A raw threshold on the field gives channels whose
   * real-world width swings wildly with the local gradient of the noise. So we
   * measure that gradient and convert a width *in metres* into the equivalent
   * field threshold — a 3m brook stays a 3m brook wherever it runs.
   *
   * `t` is 0 on dry ground, rising to 1 at the centreline.
   */
  riverField(x: number, z: number, out: RiverInfo = { t: 0, depth: 0, waterDepth: 0, size: 0 }): RiverInfo {
    out.t = 0;
    out.depth = 0;
    out.waterDepth = 0;
    out.size = 0;

    const v = Math.abs(this.riverSigned(x, z));

    // Cheap rejection first: nothing within reach of a channel can have a
    // field value this large, and the vast majority of the world is dry.
    if (v > 0.06) return out;

    // Streams avoid ridge crests — water doesn't collect on a knife edge.
    const valley = 1 - clamp01(this.ridgeness(x, z) * 1.5);
    if (valley <= 0.05) return out;

    // A slower field decides how big the watercourse is: a trickle near the
    // headwaters, a proper stream further down.
    const size = this.nRiverSize.fbm2(x * 0.00011, z * 0.00011, 3) * 0.5 + 0.5;

    // Local gradient of the field, so widths can be expressed in metres.
    const e = 2;
    const gx = (this.riverSigned(x + e, z) - this.riverSigned(x - e, z)) / (2 * e);
    const gz = (this.riverSigned(x, z + e) - this.riverSigned(x, z - e)) / (2 * e);
    const grad = Math.hypot(gx, gz);
    if (grad < 1e-9) return out;

    const halfWidthMeters = lerp(1.1, 9.5, size * size) * valley;
    const halfField = halfWidthMeters * grad;
    if (v > halfField) return out;

    out.t = 1 - smoothstep(0, halfField, v);
    out.size = size;
    out.depth = lerp(0.9, 3.4, size) * valley;
    out.waterDepth = lerp(0.18, 0.7, size);
    return out;
  }

  /**
   * Cross-channel bed profile. Flat-bottomed rather than a V-notch, so the
   * water actually covers a bed you can see into instead of a hairline crack
   * at the base of a gully.
   */
  private channelProfile(t: number): number {
    return smoothstep(0, 0.55, t);
  }

  // -------------------------------------------------------------------------
  // Public sampling
  // -------------------------------------------------------------------------

  /** Ground height at a point, with lakes and rivers carved in. */
  height(x: number, z: number): number {
    const h = this.applyLakes(x, z, this.baseHeight(x, z)).h;
    const river = this.riverField(x, z, this.scratchRiver);
    return river.t > 0 ? h - river.depth * this.channelProfile(river.t) : h;
  }

  /**
   * Water surface height at a point, or -Infinity if dry.
   *
   * For rivers the surface is derived from the *uncarved* terrain: it then
   * stays level across the channel's width while still falling with the
   * valley, which is exactly what water does. Where the underlying ground
   * drops away sharply the surface drops with it — that's a waterfall, and it
   * falls out of the maths rather than being placed by hand.
   *
   * A point only counts as wet if the surface genuinely sits above the bed, so
   * water can never be reported hanging below the ground you're standing on.
   */
  waterHeight(x: number, z: number): number {
    const lake = this.applyLakes(x, z, this.baseHeight(x, z));
    const river = this.riverField(x, z, this.scratchRiver);
    const bed = river.t > 0 ? lake.h - river.depth * this.channelProfile(river.t) : lake.h;

    let water = lake.water > bed ? lake.water : -Infinity;
    if (river.t > 0) {
      const surface = lake.h - river.depth + river.waterDepth;
      if (surface > bed) water = Math.max(water, surface);
    }
    return water;
  }

  /**
   * Ground height, water height and channel position in a single pass.
   *
   * The mesher calls this once per grid vertex, so it exists purely to avoid
   * recomputing the base terrain three times over (`height`, `waterHeight` and
   * `riverField` each redo the same expensive noise otherwise). Normals and
   * slope are derived from the finished grid rather than by re-sampling, which
   * is both cheaper and exactly consistent with the triangles drawn.
   */
  columnSample(x: number, z: number, out: Column): Column {
    const lake = this.applyLakes(x, z, this.baseHeight(x, z));
    const river = this.riverField(x, z, this.scratchRiver);

    const h = river.t > 0 ? lake.h - river.depth * this.channelProfile(river.t) : lake.h;
    out.height = h;
    out.riverT = river.t;
    out.riverSize = river.size;

    let water = lake.water > h ? lake.water : -Infinity;
    if (river.t > 0) {
      const surface = lake.h - river.depth + river.waterDepth;
      if (surface > h) water = Math.max(water, surface);
    }
    out.water = water;
    return out;
  }

  /**
   * Surface blend weights for the ground shader. Takes the height and slope
   * the mesher already computed rather than deriving them again.
   */
  surfaceWeights(x: number, z: number, h: number, slope: number, riverT: number, out: SurfaceWeights): SurfaceWeights {
    const rockNoise = this.nRock.fbm2(x * 0.004, z * 0.004, 3) * 0.5 + 0.5;
    out.rock = clamp01(
      smoothstep(0.28, 0.72, slope) * 0.85 +
        smoothstep(560, 820, h) * 0.5 +
        (rockNoise - 0.5) * 0.4
    );

    const snowJitter = this.nSnow.fbm2(x * 0.0009, z * 0.0009, 3) * 70;
    out.snow = clamp01(
      smoothstep(SNOW_LINE + snowJitter, SNOW_LINE + snowJitter + 130, h) *
        (1 - smoothstep(0.45, 0.8, slope))
    );

    // Needle and leaf litter follows the canopy: the ground under trees is a
    // different surface from open meadow, and it should change as the wood
    // thins rather than at a hard edge.
    out.canopy = this.forestDensity(x, z, h, slope);

    // Streambed: wet stone and gravel, widened a little past the waterline so
    // the bank reads as damp rather than switching abruptly to dry meadow.
    out.wet = clamp01(riverT * 1.6);
    return out;
  }

  /** Surface normal by central differences. */
  normal(x: number, z: number, eps = 0.9, out = { x: 0, y: 1, z: 0 }) {
    const hL = this.height(x - eps, z);
    const hR = this.height(x + eps, z);
    const hD = this.height(x, z - eps);
    const hU = this.height(x, z + eps);
    const nx = hL - hR;
    const nz = hD - hU;
    const ny = 2 * eps;
    const len = Math.hypot(nx, ny, nz) || 1;
    out.x = nx / len;
    out.y = ny / len;
    out.z = nz / len;
    return out;
  }

  /**
   * Everything about a spot in one pass. Used by the scatterer (which needs to
   * know whether a fern would be happy here) and by the audio system (which
   * needs to know how exposed you are and how close the water is).
   */
  sample(x: number, z: number, out: TerrainSample = createSample()): TerrainSample {
    const lake = this.applyLakes(x, z, this.baseHeight(x, z));
    let h = lake.h;

    const river = this.riverField(x, z, this.scratchRiverB);
    if (river.t > 0) h -= river.depth * this.channelProfile(river.t);

    out.height = h;
    out.riverT = river.t;

    out.waterHeight = lake.water > h ? lake.water : -Infinity;
    if (river.t > 0) {
      const surface = lake.h - river.depth + river.waterDepth;
      if (surface > h) out.waterHeight = Math.max(out.waterHeight, surface);
    }

    const n = this.normal(x, z, 0.9, this.scratchNormal);
    out.nx = n.x;
    out.ny = n.y;
    out.nz = n.z;
    out.slope = clamp01(1 - n.y);

    const altitude01 = remap01(h, BASE_ELEVATION - 40, 950);

    // Moisture: high beside water, in hollows, and at low altitude; low on
    // exposed high ground.
    const moistNoise = this.nMoisture.fbm2(x * 0.00085, z * 0.00085, 3) * 0.5 + 0.5;
    let moisture = moistNoise * 0.55 + (1 - altitude01) * 0.35;
    moisture += river.t * 0.5;
    if (lake.water > -Infinity) moisture += 0.35;
    // Steep ground sheds water fast.
    moisture -= out.slope * 0.45;
    out.moisture = clamp01(moisture);

    // Rock shows through on steep faces and high ground.
    const rockNoise = this.nRock.fbm2(x * 0.004, z * 0.004, 3) * 0.5 + 0.5;
    out.rockiness = clamp01(
      smoothstep(0.28, 0.72, out.slope) * 0.85 +
        smoothstep(560, 820, h) * 0.5 +
        (rockNoise - 0.5) * 0.4
    );

    // Snow holds above the snow line, on flatter ground, and the line itself
    // wanders so the world never shows a ruler-straight edge of white.
    const snowJitter = this.nSnow.fbm2(x * 0.0009, z * 0.0009, 3) * 70;
    out.snow = clamp01(
      smoothstep(SNOW_LINE + snowJitter, SNOW_LINE + snowJitter + 130, h) *
        (1 - smoothstep(0.45, 0.8, out.slope))
    );

    // Exposure: high, steep and treeless ground catches the wind.
    out.exposure = clamp01(altitude01 * 0.7 + out.slope * 0.3);

    out.canopy = this.forestDensity(x, z, h, out.slope);
    out.biome = this.biomeAt(out, h, altitude01);
    return out;
  }

  private biomeAt(s: TerrainSample, h: number, altitude01: number): Biome {
    if (s.snow > 0.45) return Biome.Snow;
    if (s.rockiness > 0.66 || h > TREE_LINE + 90) return Biome.Scree;
    if (s.riverT > 0.25) return Biome.Riverbank;
    if (s.waterHeight > -Infinity) return Biome.Lakeshore;
    if (s.canopy > 0.3) return altitude01 > 0.4 ? Biome.Conifer : Biome.Forest;
    return Biome.Meadow;
  }

  /**
   * Forest canopy density 0..1 — drives tree scatter, the shade underfoot and
   * the leaf-rustle audio layer. Thinned by altitude and steepness so the
   * treeline breaks into scattered stands rather than stopping dead along a
   * contour.
   */
  forestDensity(x: number, z: number, h: number, slope: number): number {
    const field = this.nForest.fbm2(x * 0.00055, z * 0.00055, 3) * 0.5 + 0.5;
    return clamp01(
      smoothstep(0.24, 0.72, field) *
        (1 - smoothstep(TREE_LINE - 150, TREE_LINE + 60, h)) *
        (1 - smoothstep(0.42, 0.78, slope))
    );
  }
}
