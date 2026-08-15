/**
 * Noticing things.
 *
 * The only progression in the game. You gain nothing by walking and nothing by
 * arriving; you gain something by *seeing* — a species you haven't met, a
 * waterfall, a summit, a tarn.
 *
 * A sighting requires three things, in cheapening order so the expensive test
 * runs least often: the thing must be near enough to make out, it must be
 * within the cone you are actually looking at, and it must not be hidden behind
 * a hill. Nothing counts if it is behind you, which means discoveries happen
 * because you looked, not because you walked past.
 *
 * Nothing here is ever lost or taken away, and there is no timer on any of it.
 */

import * as THREE from 'three';
import { SPECIES, SPECIES_BY_ID, type Species } from './species';
import { Heightfield } from '../world/heightfield';
import { hash2f, hash3f } from '../core/rng';
import { clamp01, smoothstep } from '../world/noise';

/** Landmarks live on their own coarse grid, one candidate per cell. */
const LANDMARK_CELL = 640;

export type LandmarkKind = 'waterfall' | 'tarn' | 'summit' | 'grove' | 'outcrop' | 'spring';

export interface Landmark {
  id: string;
  kind: LandmarkKind;
  name: string;
  note: string;
  x: number;
  z: number;
  y: number;
  xp: number;
  /** How far away it can be recognised. */
  radius: number;
}

export interface Discovery {
  kind: 'species' | 'landmark';
  id: string;
  name: string;
  subtitle: string;
  note: string;
  xp: number;
  /** In-game hour it was first seen. */
  hour: number;
  /** Real timestamp, for ordering the journal. */
  at: number;
}

export interface Progress {
  xp: number;
  level: number;
  /** Fraction of the way to the next level, 0..1. */
  levelProgress: number;
  discovered: Discovery[];
  distanceWalked: number;
}

/**
 * Level thresholds.
 *
 * Deliberately shallow and unbounded. Levels unlock nothing — they are a way
 * of noticing that you've noticed a lot, and they carry names rather than
 * numbers because "Level 7" is the language of a different kind of game.
 */
const LEVEL_NAMES = [
  'Setting Out', 'Wanderer', 'Rambler', 'Walker', 'Pathfinder',
  'Naturalist', 'Field Botanist', 'Old Hand', 'Kindred', 'At Home Here',
];

export function levelForXp(xp: number): { level: number; progress: number; name: string } {
  // Each level costs a little more than the last, but never steeply.
  let level = 0;
  let remaining = xp;
  let cost = 60;
  while (remaining >= cost && level < 40) {
    remaining -= cost;
    level++;
    cost = Math.round(cost * 1.25);
  }
  return {
    level: level + 1,
    progress: clamp01(remaining / cost),
    name: LEVEL_NAMES[Math.min(level, LEVEL_NAMES.length - 1)],
  };
}

const LANDMARK_COPY: Record<LandmarkKind, { names: string[]; note: string; xp: number; radius: number }> = {
  waterfall: {
    names: ['Force', 'Fall', 'Spout', 'Linn'],
    note: 'Where the stream meets a band of harder rock it has failed to cut through, and goes over instead. The plunge pool below is being dug deeper every year.',
    xp: 60,
    radius: 90,
  },
  tarn: {
    names: ['Tarn', 'Mere', 'Pool', 'Lochan'],
    note: 'A hollow scooped by ice and never drained. Mountain tarns are often nearly sterile — cold, acid and very clear, with the bottom visible far out.',
    xp: 45,
    radius: 110,
  },
  summit: {
    names: ['Pike', 'Fell', 'Crag', 'Beacon'],
    note: 'From a high point you can read the whole catchment at once: which way the water goes, where the wood gives out, and how far you have come.',
    xp: 70,
    radius: 140,
  },
  grove: {
    names: ['Grove', 'Stand', 'Holt', 'Shaw'],
    note: 'A dense knot of old trees. Little light reaches the floor, so the undergrowth thins out and the ground goes quiet underfoot.',
    xp: 35,
    radius: 55,
  },
  outcrop: {
    names: ['Scar', 'Edge', 'Rake', 'Buttress'],
    note: 'Bedrock breaking through the soil. You can usually read a good deal of the hillside’s history in a few metres of exposed strata.',
    xp: 30,
    radius: 80,
  },
  spring: {
    names: ['Spring', 'Well', 'Head', 'Seep'],
    note: 'Where the water table meets the surface and a stream begins. Springs hold a steady temperature year-round, so they rarely freeze and often stay green around the edges.',
    xp: 40,
    radius: 45,
  },
};

const PLACE_PREFIX = [
  'Alder', 'Ash', 'Birk', 'Black', 'Cold', 'Dark', 'Fern', 'Grey', 'Hawk',
  'High', 'Long', 'Low', 'Mere', 'Moss', 'Otter', 'Raven', 'Red', 'Rowan',
  'Rush', 'Stone', 'Thorn', 'White', 'Wind', 'Yew',
];

export class DiscoveryTracker {
  readonly progress: Progress = {
    xp: 0,
    level: 1,
    levelProgress: 0,
    discovered: [],
    distanceWalked: 0,
  };

  /** Fired when something is seen for the first time. */
  onDiscovery: ((discovery: Discovery) => void) | null = null;

  private seen = new Set<string>();
  private landmarkCache = new Map<string, Landmark | null>();
  private scratchLandmarks: Landmark[] = [];
  private forward = new THREE.Vector3();
  private toTarget = new THREE.Vector3();
  private checkTimer = 0;

  constructor(private field: Heightfield, private seed: number) {}

  has(id: string): boolean {
    return this.seen.has(id);
  }

  get seenCount(): number {
    return this.seen.size;
  }

  // -------------------------------------------------------------------------
  // Landmarks
  // -------------------------------------------------------------------------

  /**
   * The landmark owned by a grid cell, if any.
   *
   * Landmarks are found rather than placed: the cell proposes a spot, and the
   * terrain decides what — if anything — is actually there. A waterfall only
   * exists where a stream really does cross steep ground, so walking to one
   * always shows you the thing the map promised.
   */
  private landmarkForCell(cx: number, cz: number): Landmark | null {
    const key = `${cx}:${cz}`;
    const cached = this.landmarkCache.get(key);
    if (cached !== undefined) return cached;

    let landmark: Landmark | null = null;

    const jitterX = hash2f(cx * 31 + 7, cz ^ this.seed);
    const jitterZ = hash2f(cx ^ 0x9e37, cz * 17 + 3);
    const x = (cx + 0.2 + jitterX * 0.6) * LANDMARK_CELL;
    const z = (cz + 0.2 + jitterZ * 0.6) * LANDMARK_CELL;

    const sample = this.field.sample(x, z);
    const slope = sample.slope;

    let kind: LandmarkKind | null = null;

    if (sample.riverT > 0.4 && slope > 0.5) {
      kind = 'waterfall';
    } else if (sample.waterHeight > sample.height && slope < 0.12) {
      kind = 'tarn';
    } else if (sample.riverT > 0.5 && slope < 0.3 && sample.moisture > 0.7) {
      kind = 'spring';
    } else if (slope < 0.16 && this.isLocalSummit(x, z, sample.height)) {
      kind = 'summit';
    } else if (sample.rockiness > 0.62 && slope > 0.42) {
      kind = 'outcrop';
    } else if (sample.canopy > 0.85 && slope < 0.28) {
      kind = 'grove';
    }

    if (kind) {
      const copy = LANDMARK_COPY[kind];
      const prefix = PLACE_PREFIX[Math.floor(hash3f(cx, cz, 11) * PLACE_PREFIX.length) % PLACE_PREFIX.length];
      const suffix = copy.names[Math.floor(hash3f(cx, cz, 23) * copy.names.length) % copy.names.length];
      landmark = {
        id: `landmark:${cx}:${cz}`,
        kind,
        name: `${prefix} ${suffix}`,
        note: copy.note,
        x,
        z,
        y: sample.height,
        xp: copy.xp,
        radius: copy.radius,
      };
    }

    if (this.landmarkCache.size > 400) this.landmarkCache.clear();
    this.landmarkCache.set(key, landmark);
    return landmark;
  }

  /** True if nothing within a few hundred metres is meaningfully higher. */
  private isLocalSummit(x: number, z: number, height: number): boolean {
    for (let i = 0; i < 10; i++) {
      const angle = (i / 10) * Math.PI * 2;
      for (const d of [90, 220]) {
        const h = this.field.height(x + Math.cos(angle) * d, z + Math.sin(angle) * d);
        if (h > height + 6) return false;
      }
    }
    return height > 430;
  }

  /** Every landmark whose influence could reach a point. */
  landmarksNear(x: number, z: number, out: Landmark[] = []): Landmark[] {
    out.length = 0;
    const cx = Math.floor(x / LANDMARK_CELL);
    const cz = Math.floor(z / LANDMARK_CELL);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const landmark = this.landmarkForCell(cx + dx, cz + dz);
        if (landmark) out.push(landmark);
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Sighting
  // -------------------------------------------------------------------------

  /**
   * Test what the player can currently see.
   *
   * Runs a few times a second rather than every frame — a sighting is not a
   * reflex test, and the cost of the line-of-sight walk is worth paying only
   * occasionally.
   */
  update(
    camera: THREE.Camera,
    dt: number,
    hour: number,
    nearbySpecies: Iterable<{ id: string; x: number; y: number; top: number; z: number }>
  ) {
    this.checkTimer -= dt;
    if (this.checkTimer > 0) return;
    this.checkTimer = 0.35;

    camera.getWorldDirection(this.forward);
    const eye = camera.position;

    // --- species ------------------------------------------------------------
    for (const candidate of nearbySpecies) {
      if (this.seen.has(`species:${candidate.id}`)) continue;
      const species = SPECIES_BY_ID.get(candidate.id);
      if (!species) continue;

      // Big things can be recognised further off than small ones.
      const recogniseAt = lerpRecognition(species);
      const dx = candidate.x - eye.x;
      const dz = candidate.z - eye.z;
      const horizontal = Math.hypot(dx, dz);
      if (horizontal > recogniseAt) continue;

      // A plant is a vertical span, not a point. Aim at whichever part of it
      // sits closest to where the camera is actually pointed, because a fir six
      // metres away is thirty metres of tree and only a slice is in frame —
      // aiming at its middle would put the target sixty degrees above the eye
      // line and the tree you are standing under would never be noticed.
      const axisY = eye.y + (horizontal * this.forward.y) / Math.max(0.001, Math.hypot(this.forward.x, this.forward.z));
      const targetY = Math.min(candidate.top, Math.max(candidate.y, axisY));

      this.toTarget.set(dx, targetY - eye.y, dz);
      const distance = this.toTarget.length();
      if (distance > recogniseAt) continue;

      this.toTarget.divideScalar(distance || 1);
      // Within roughly the middle of the view — not the far corners.
      if (this.toTarget.dot(this.forward) < 0.78) continue;
      if (!this.hasLineOfSight(eye, candidate.x, targetY, candidate.z)) continue;

      this.record({
        kind: 'species',
        id: `species:${candidate.id}`,
        name: species.name,
        subtitle: species.latin,
        note: species.note,
        xp: species.xp,
        hour,
        at: Date.now(),
      });
    }

    // --- landmarks ----------------------------------------------------------
    for (const landmark of this.landmarksNear(eye.x, eye.z, this.scratchLandmarks)) {
      if (this.seen.has(landmark.id)) continue;
      this.toTarget.set(landmark.x - eye.x, landmark.y - eye.y, landmark.z - eye.z);
      const distance = this.toTarget.length();
      if (distance > landmark.radius) continue;

      this.toTarget.divideScalar(distance || 1);
      if (this.toTarget.dot(this.forward) < 0.6) continue;
      if (!this.hasLineOfSight(eye, landmark.x, landmark.y, landmark.z)) continue;

      this.record({
        kind: 'landmark',
        id: landmark.id,
        name: landmark.name,
        subtitle: landmark.kind[0].toUpperCase() + landmark.kind.slice(1),
        note: landmark.note,
        xp: landmark.xp,
        hour,
        at: Date.now(),
      });
    }
  }

  /**
   * March along the ray and check the terrain never rises above it.
   *
   * Coarse on purpose — eight samples is enough to catch a hill in the way,
   * and being fooled by a boulder you could see over would be worse than
   * missing one you couldn't.
   */
  private hasLineOfSight(eye: THREE.Vector3, x: number, y: number, z: number): boolean {
    const steps = 8;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const px = eye.x + (x - eye.x) * t;
      const pz = eye.z + (z - eye.z) * t;
      const rayY = eye.y + (y - eye.y) * t;
      // A little slack so grazing a ridge doesn't block the view.
      if (this.field.height(px, pz) > rayY + 1.2) return false;
    }
    return true;
  }

  private record(discovery: Discovery) {
    this.seen.add(discovery.id);
    this.progress.discovered.push(discovery);
    this.progress.xp += discovery.xp;
    const level = levelForXp(this.progress.xp);
    this.progress.level = level.level;
    this.progress.levelProgress = level.progress;
    this.onDiscovery?.(discovery);
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  serialise() {
    return {
      xp: this.progress.xp,
      distanceWalked: this.progress.distanceWalked,
      discovered: this.progress.discovered,
    };
  }

  restore(data: { xp?: number; distanceWalked?: number; discovered?: Discovery[] } | null) {
    if (!data) return;
    this.progress.xp = data.xp ?? 0;
    this.progress.distanceWalked = data.distanceWalked ?? 0;
    this.progress.discovered = Array.isArray(data.discovered) ? data.discovered : [];
    this.seen = new Set(this.progress.discovered.map((d) => d.id));
    const level = levelForXp(this.progress.xp);
    this.progress.level = level.level;
    this.progress.levelProgress = level.progress;
  }

  /** Every species, with whether it has been found — the journal's backbone. */
  speciesIndex(): Array<{ species: Species; found: Discovery | undefined }> {
    return SPECIES.map((species) => ({
      species,
      found: this.progress.discovered.find((d) => d.id === `species:${species.id}`),
    }));
  }
}

/**
 * How far away a species can be told apart from its neighbours.
 *
 * A birch is recognisable across a clearing; wood sorrel has to be at your
 * feet. Scaling with height gets this about right without a table.
 */
function lerpRecognition(species: Species): number {
  const height = species.height[1];
  return 4 + smoothstep(0.1, 25, height) * 46;
}
