/**
 * Deterministic randomness.
 *
 * Everything in the world — where a fern grows, which way a boulder is turned,
 * where a waterfall hides — comes from these functions. Given the same seed,
 * the same world appears, on any machine, forever. That matters: a place you
 * found once should still be there when you come back to it.
 */

/** Mix a 32-bit integer until its bits are well scattered. */
export function hashInt(x: number): number {
  let h = x | 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  h = h ^ (h >>> 15);
  return h >>> 0;
}

/** Hash two integers (grid coordinates) into one. */
export function hash2(x: number, y: number): number {
  return hashInt((x | 0) ^ Math.imul(y | 0, 0x9e3779b9));
}

/** Hash three integers. */
export function hash3(x: number, y: number, z: number): number {
  return hashInt(hash2(x, y) ^ Math.imul(z | 0, 0x85ebca6b));
}

/** Deterministic float in [0,1) from a 2D integer coordinate. */
export function hash2f(x: number, y: number): number {
  return hash2(x, y) / 4294967296;
}

/** Deterministic float in [0,1) from a 3D integer coordinate. */
export function hash3f(x: number, y: number, z: number): number {
  return hash3(x, y, z) / 4294967296;
}

/** Turn an arbitrary string into a 32-bit seed. */
export function seedFromString(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Turn a seed back into a short, pronounceable name for the world. */
const NAME_A = [
  'Alder', 'Amber', 'Ash', 'Aspen', 'Birch', 'Bracken', 'Briar', 'Cedar',
  'Cinder', 'Clover', 'Dawn', 'Dusk', 'Elder', 'Ember', 'Fern', 'Frost',
  'Gale', 'Glimmer', 'Granite', 'Green', 'Hazel', 'Heather', 'Hollow', 'Juniper',
  'Larch', 'Laurel', 'Linden', 'Marsh', 'Mist', 'Moss', 'Needle', 'North',
  'Otter', 'Pale', 'Pine', 'Quiet', 'Rain', 'Raven', 'Rowan', 'Rush',
  'Sable', 'Silver', 'Slate', 'Snow', 'Sorrel', 'Spruce', 'Still', 'Stone',
  'Sun', 'Thistle', 'Thorn', 'Tumble', 'Vale', 'Wander', 'Willow', 'Wind',
];
const NAME_B = [
  'basin', 'beck', 'bluff', 'bourne', 'brook', 'burn', 'cairn', 'clough',
  'combe', 'corrie', 'crag', 'dale', 'dell', 'fell', 'fold', 'ford',
  'gill', 'glade', 'glen', 'gorge', 'grove', 'hollow', 'howe', 'knoll',
  'lea', 'mere', 'moor', 'pass', 'pike', 'reach', 'ridge', 'scar',
  'shaw', 'spring', 'stand', 'tarn', 'thicket', 'vale', 'wood', 'wold',
];

export function worldNameFromSeed(seed: number): string {
  const a = NAME_A[hashInt(seed) % NAME_A.length];
  const b = NAME_B[hashInt(seed ^ 0x5bf03635) % NAME_B.length];
  return `${a}${b}`;
}

/**
 * A small, fast, seedable PRNG (mulberry32). Not cryptographic — but it has a
 * long period, good distribution, and identical behaviour everywhere.
 */
export class Rng {
  private state: number;

  constructor(seed: number | string) {
    this.state = (typeof seed === 'string' ? seedFromString(seed) : seed) >>> 0;
  }

  /** Float in [0,1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Float in [min,max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Integer in [min,max]. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** True with the given probability. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Pick one element. */
  pick<T>(items: readonly T[]): T {
    return items[Math.min(items.length - 1, Math.floor(this.next() * items.length))];
  }

  /**
   * Pick an index from a list of weights. Used constantly by the scatterer to
   * choose which species grows at a given spot.
   */
  weightedIndex(weights: readonly number[]): number {
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += weights[i];
    if (total <= 0) return 0;
    let r = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) return i;
    }
    return weights.length - 1;
  }

  /** Normally distributed value (Box–Muller), mean 0, standard deviation 1. */
  gaussian(): number {
    const u = Math.max(1e-9, this.next());
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}
