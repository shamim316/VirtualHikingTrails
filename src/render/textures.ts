/**
 * Texture arrays for the ground.
 *
 * The terrain blends four surfaces — meadow, forest floor, rock and snow — and
 * doing that with twelve separate samplers would run straight into the texture
 * unit limit once shadow cascades and the environment map are bound too. So
 * each map type is packed into one `sampler2DArray`: three bindings total, and
 * layers can be added later without touching the shader.
 *
 * If the real photoscanned textures haven't loaded (or fail to), a procedural
 * set is generated on the fly. It is not as good, but it is honest ground with
 * plausible colour and roughness rather than flat grey, so the world is always
 * playable.
 */

import * as THREE from 'three';
import { Noise } from '../world/noise';

export const GROUND_LAYERS = ['meadow', 'forest_floor', 'rock', 'snow'] as const;
export type GroundLayer = (typeof GROUND_LAYERS)[number];

export interface GroundTextures {
  albedo: THREE.DataArrayTexture | THREE.Texture;
  normal: THREE.DataArrayTexture | THREE.Texture;
  /** Ambient occlusion / roughness / metalness, packed into RGB. */
  arm: THREE.DataArrayTexture | THREE.Texture;
  /** Large-scale variation, used to break up obvious tiling. */
  macro: THREE.Texture;
}

const PROCEDURAL_SIZE = 256;

/** Per-layer look for the procedural fallback. */
const FALLBACK_LOOK: Record<GroundLayer, {
  base: [number, number, number];
  alt: [number, number, number];
  grain: number;
  roughness: [number, number];
  bump: number;
}> = {
  meadow: {
    base: [0.24, 0.35, 0.15],
    alt: [0.38, 0.45, 0.19],
    grain: 26,
    roughness: [0.72, 0.95],
    bump: 1.4,
  },
  forest_floor: {
    base: [0.16, 0.12, 0.08],
    alt: [0.31, 0.24, 0.14],
    grain: 34,
    roughness: [0.78, 0.98],
    bump: 1.8,
  },
  rock: {
    base: [0.30, 0.29, 0.28],
    alt: [0.47, 0.45, 0.42],
    grain: 12,
    roughness: [0.55, 0.88],
    bump: 3.2,
  },
  snow: {
    base: [0.78, 0.82, 0.90],
    alt: [0.95, 0.96, 1.0],
    grain: 40,
    roughness: [0.28, 0.55],
    bump: 0.9,
  },
};

/**
 * Build a procedural stand-in set. Two octaves of value noise give the colour
 * break-up, a third drives roughness, and the normal map is derived from the
 * height field by central differences so the lighting at least agrees with the
 * bumps you can see.
 */
export function createProceduralGround(seed = 1337): GroundTextures {
  const size = PROCEDURAL_SIZE;
  const layers = GROUND_LAYERS.length;
  const pixels = size * size;

  const albedoData = new Uint8Array(new ArrayBuffer(pixels * 4 * layers));
  const normalData = new Uint8Array(new ArrayBuffer(pixels * 4 * layers));
  const armData = new Uint8Array(new ArrayBuffer(pixels * 4 * layers));

  const height = new Float32Array(pixels);

  for (let layer = 0; layer < layers; layer++) {
    const look = FALLBACK_LOOK[GROUND_LAYERS[layer]];
    const n1 = new Noise(seed + layer * 977);
    const n2 = new Noise(seed + layer * 977 + 31);
    const n3 = new Noise(seed + layer * 977 + 67);

    // Height first, so the normal map can be differentiated from it.
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        // Sample on a torus so the texture tiles seamlessly.
        const a = (x / size) * Math.PI * 2;
        const b = (y / size) * Math.PI * 2;
        const f = look.grain * 0.16;
        const h =
          n1.noise3(Math.cos(a) * f, Math.sin(a) * f, Math.cos(b) * f) * 0.6 +
          n2.noise3(Math.cos(b) * f * 2.3, Math.sin(b) * f * 2.3, Math.sin(a) * f * 2.3) * 0.4;
        height[y * size + x] = h;
      }
    }

    const base = layer * pixels * 4;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const o = base + i * 4;
        const h = height[i];
        const t = h * 0.5 + 0.5;

        const varyA = (x / size) * Math.PI * 2;
        const varyB = (y / size) * Math.PI * 2;
        const patch =
          n3.noise3(Math.cos(varyA) * 1.7, Math.sin(varyA) * 1.7, Math.cos(varyB) * 1.7) * 0.5 + 0.5;

        const mix = Math.min(1, Math.max(0, t * 0.65 + patch * 0.5));
        albedoData[o] = clamp255((look.base[0] + (look.alt[0] - look.base[0]) * mix) * 255);
        albedoData[o + 1] = clamp255((look.base[1] + (look.alt[1] - look.base[1]) * mix) * 255);
        albedoData[o + 2] = clamp255((look.base[2] + (look.alt[2] - look.base[2]) * mix) * 255);
        albedoData[o + 3] = 255;

        // Normals from the height field, wrapping at the edges.
        const hL = height[y * size + ((x - 1 + size) % size)];
        const hR = height[y * size + ((x + 1) % size)];
        const hD = height[((y - 1 + size) % size) * size + x];
        const hU = height[((y + 1) % size) * size + x];
        let nx = (hL - hR) * look.bump;
        let nz = (hD - hU) * look.bump;
        const ny = 1;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len; nz /= len;
        normalData[o] = clamp255((nx * 0.5 + 0.5) * 255);
        normalData[o + 1] = clamp255((nz * 0.5 + 0.5) * 255);
        normalData[o + 2] = clamp255((ny / len * 0.5 + 0.5) * 255);
        normalData[o + 3] = 255;

        // Crevices are darker and rougher, as they are in the real thing.
        const ao = 0.6 + 0.4 * Math.min(1, Math.max(0, t));
        const rough = look.roughness[0] + (look.roughness[1] - look.roughness[0]) * (1 - t);
        armData[o] = clamp255(ao * 255);
        armData[o + 1] = clamp255(rough * 255);
        armData[o + 2] = 0;
        armData[o + 3] = 255;
      }
    }
  }

  return {
    albedo: makeArray(albedoData, size, layers, THREE.SRGBColorSpace),
    normal: makeArray(normalData, size, layers, THREE.NoColorSpace),
    arm: makeArray(armData, size, layers, THREE.NoColorSpace),
    macro: createMacroTexture(seed),
  };
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

function makeArray(
  data: Uint8Array<ArrayBuffer>,
  size: number,
  layers: number,
  colorSpace: THREE.ColorSpace
): THREE.DataArrayTexture {
  const tex = new THREE.DataArrayTexture(data, size, size, layers);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.colorSpace = colorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/**
 * A large, soft, seamless noise texture sampled at hundreds of metres. Every
 * tiling ground texture betrays itself at distance; modulating brightness and
 * tint with something an order of magnitude larger hides the repeat far better
 * than adding more detail does.
 */
export function createMacroTexture(seed: number, size = 256): THREE.DataTexture {
  const noise = new Noise(seed ^ 0x51ed);
  const data = new Uint8Array(new ArrayBuffer(size * size * 4));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = (x / size) * Math.PI * 2;
      const b = (y / size) * Math.PI * 2;
      const n = (f: number) =>
        noise.noise3(Math.cos(a) * f, Math.sin(a) * f, Math.cos(b) * f) * 0.5 + 0.5;
      const o = (y * size + x) * 4;
      data[o] = clamp255(n(1.1) * 255);
      data[o + 1] = clamp255(n(2.7) * 255);
      data[o + 2] = clamp255(n(5.3) * 255);
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Load the real photoscanned ground set and pack it into texture arrays.
 *
 * Each layer contributes three images. They are drawn to a canvas and read back
 * so they can be concatenated into one array buffer, which is the only way to
 * get arbitrary compressed formats into a `DataArrayTexture`.
 */
export async function loadGroundTextures(
  basePath: string,
  resolution = 1024,
  onProgress?: (loaded: number, total: number) => void
): Promise<GroundTextures> {
  const kinds = ['diff', 'nor', 'arm'] as const;
  const total = GROUND_LAYERS.length * kinds.length;
  let loaded = 0;

  const canvas = document.createElement('canvas');
  canvas.width = resolution;
  canvas.height = resolution;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas unavailable; cannot pack ground textures');

  const buffers: Record<string, Uint8Array<ArrayBuffer>> = {};
  for (const kind of kinds) {
    buffers[kind] = new Uint8Array(new ArrayBuffer(resolution * resolution * 4 * GROUND_LAYERS.length));
  }

  for (let layer = 0; layer < GROUND_LAYERS.length; layer++) {
    for (const kind of kinds) {
      const url = `${basePath}/${GROUND_LAYERS[layer]}_${kind}.webp`;
      const image = await loadImage(url);
      ctx.clearRect(0, 0, resolution, resolution);
      ctx.drawImage(image, 0, 0, resolution, resolution);
      const pixels = ctx.getImageData(0, 0, resolution, resolution).data;
      buffers[kind].set(pixels, layer * resolution * resolution * 4);
      if (typeof (image as ImageBitmap).close === 'function') (image as ImageBitmap).close();
      onProgress?.(++loaded, total);
    }
  }

  return {
    albedo: makeArray(buffers.diff, resolution, GROUND_LAYERS.length, THREE.SRGBColorSpace),
    normal: makeArray(buffers.nor, resolution, GROUND_LAYERS.length, THREE.NoColorSpace),
    arm: makeArray(buffers.arm, resolution, GROUND_LAYERS.length, THREE.NoColorSpace),
    macro: createMacroTexture(1337),
  };
}

async function loadImage(url: string): Promise<ImageBitmap | HTMLImageElement> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const blob = await response.blob();
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(blob);
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to decode ${url}`));
    img.src = URL.createObjectURL(blob);
  });
}
