/**
 * Quality tiers.
 *
 * The game has to look its best on a desktop GPU and still be a pleasant walk
 * on a phone. Rather than one slider, there are four coherent presets, chosen
 * automatically from what the device tells us and then adjusted at runtime if
 * the frame time says we guessed wrong. Everything visible in the settings
 * panel writes into this object.
 */

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';

export interface QualitySettings {
  tier: QualityTier;
  /** Multiplier on device pixel ratio; the single biggest performance lever. */
  renderScale: number;
  maxPixelRatio: number;
  /** How far the terrain is drawn, in metres. */
  viewDistance: number;
  /** Radius within which full-detail vegetation meshes are placed. */
  vegetationDistance: number;
  /** Radius for cheap billboard vegetation beyond that. */
  impostorDistance: number;
  /** Overall multiplier on how much undergrowth is scattered. */
  vegetationDensity: number;
  /** Radius within which grass tufts are drawn. */
  grassDistance: number;
  shadows: boolean;
  shadowMapSize: number;
  /** Number of cascaded shadow splits. */
  shadowCascades: number;
  ambientOcclusion: boolean;
  volumetricClouds: boolean;
  /** Resolution divisor for the cloud raymarch. */
  cloudScale: number;
  godRays: boolean;
  bloom: boolean;
  depthOfField: boolean;
  waterReflections: boolean;
  antialias: 'none' | 'fxaa' | 'smaa';
  /** Terrain chunk worker count. */
  workers: number;
}

const PRESETS: Record<QualityTier, Omit<QualitySettings, 'tier'>> = {
  low: {
    renderScale: 0.72,
    maxPixelRatio: 1.5,
    viewDistance: 1600,
    vegetationDistance: 65,
    impostorDistance: 220,
    vegetationDensity: 0.5,
    grassDistance: 22,
    shadows: false,
    shadowMapSize: 1024,
    shadowCascades: 1,
    ambientOcclusion: false,
    volumetricClouds: false,
    cloudScale: 4,
    // The low tier skips the post chain outright, antialiasing included:
    // FXAA needs the composited frame in a texture, so switching it on here
    // would reinstate the very chain this tier exists to avoid. Even bloom alone costs an
    // extra half-float target the size of the screen plus a five-level blur
    // pyramid, and on the device that needs this tier that is the frame.
    godRays: false,
    bloom: false,
    depthOfField: false,
    waterReflections: false,
    antialias: 'none',
    workers: 1,
  },
  medium: {
    renderScale: 0.85,
    maxPixelRatio: 2,
    viewDistance: 2400,
    vegetationDistance: 95,
    impostorDistance: 340,
    vegetationDensity: 0.75,
    grassDistance: 32,
    shadows: true,
    shadowMapSize: 1536,
    shadowCascades: 2,
    ambientOcclusion: false,
    volumetricClouds: true,
    cloudScale: 4,
    godRays: true,
    bloom: true,
    depthOfField: false,
    waterReflections: false,
    antialias: 'fxaa',
    workers: 2,
  },
  high: {
    renderScale: 1,
    maxPixelRatio: 2,
    viewDistance: 3200,
    vegetationDistance: 135,
    impostorDistance: 460,
    vegetationDensity: 1,
    grassDistance: 42,
    shadows: true,
    shadowMapSize: 2048,
    shadowCascades: 3,
    ambientOcclusion: true,
    volumetricClouds: true,
    cloudScale: 3,
    godRays: true,
    bloom: true,
    depthOfField: true,
    waterReflections: true,
    antialias: 'smaa',
    workers: 3,
  },
  ultra: {
    renderScale: 1,
    maxPixelRatio: 2,
    viewDistance: 4000,
    vegetationDistance: 180,
    impostorDistance: 620,
    vegetationDensity: 1.35,
    grassDistance: 55,
    shadows: true,
    shadowMapSize: 3072,
    shadowCascades: 4,
    ambientOcclusion: true,
    volumetricClouds: true,
    cloudScale: 2,
    godRays: true,
    bloom: true,
    depthOfField: true,
    waterReflections: true,
    antialias: 'smaa',
    workers: 4,
  },
};

export function settingsForTier(tier: QualityTier): QualitySettings {
  return { tier, ...PRESETS[tier] };
}

export function isTouchDevice(): boolean {
  return (
    typeof window !== 'undefined' &&
    (('ontouchstart' in window) || navigator.maxTouchPoints > 0) &&
    !window.matchMedia('(pointer: fine)').matches
  );
}

/**
 * A first guess at what this machine can handle, from the things a browser will
 * actually tell us: the GPU string, core count, memory and whether it's a
 * touch device. Deliberately conservative — it is far nicer to start smooth and
 * be promoted than to start beautiful and stutter.
 */
export function detectTier(renderer?: { getContext(): WebGL2RenderingContext | WebGLRenderingContext }): QualityTier {
  if (typeof navigator === 'undefined') return 'high';

  const cores = navigator.hardwareConcurrency ?? 4;
  const memory = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 4;
  const touch = isTouchDevice();

  let gpu = '';
  try {
    const gl = renderer?.getContext();
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    if (gl && ext) gpu = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '').toLowerCase();
  } catch {
    // Some browsers refuse this for fingerprinting reasons. The other signals
    // are enough.
  }

  // Software rasterisers can't do any of this at a playable rate.
  if (/swiftshader|llvmpipe|software/.test(gpu)) return 'low';

  if (touch) {
    // Recent Apple silicon in an iPad handles a lot; most Android phones do not.
    if (/apple/.test(gpu) && cores >= 6) return 'medium';
    return 'low';
  }

  if (/rtx\s*(30|40|50)|rx\s*(6[89]|7[6-9])|m[1-4]\s*(pro|max|ultra)/.test(gpu)) return 'ultra';
  if (cores >= 8 && memory >= 8) return 'high';
  if (cores >= 4) return 'medium';
  return 'low';
}

const ORDER: QualityTier[] = ['low', 'medium', 'high', 'ultra'];

/**
 * Watches frame time and nudges the tier up or down.
 *
 * The rules are asymmetric on purpose: drop quickly when frames are being
 * missed, but only promote after a long, calm stretch of comfortable frames.
 * A walking simulator that keeps flickering between settings is worse than one
 * that stays a notch too low.
 */
export class AdaptiveQuality {
  private samples: number[] = [];
  private lastChange = 0;
  private enabled = true;

  constructor(
    private getTier: () => QualityTier,
    private setTier: (tier: QualityTier) => void,
    private targetFps = 55
  ) {}

  setEnabled(on: boolean) {
    this.enabled = on;
    this.samples.length = 0;
  }

  update(dt: number, now: number) {
    if (!this.enabled || dt <= 0) return;
    this.samples.push(dt);
    if (this.samples.length < 90) return;

    // Median rather than mean: one long frame from a chunk upload shouldn't
    // trigger a downgrade.
    const sorted = this.samples.slice().sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    this.samples.length = 0;

    const fps = 1 / median;
    const index = ORDER.indexOf(this.getTier());

    if (fps < this.targetFps * 0.72 && index > 0 && now - this.lastChange > 4) {
      this.setTier(ORDER[index - 1]);
      this.lastChange = now;
    } else if (fps > this.targetFps * 1.25 && index < ORDER.length - 1 && now - this.lastChange > 25) {
      this.setTier(ORDER[index + 1]);
      this.lastChange = now;
    }
  }
}
