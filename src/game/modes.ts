/**
 * Rest and photo mode.
 *
 * Two ways of stopping. Both take the controls away from you, which is the
 * point of each: resting is about not going anywhere, and framing a photograph
 * is about looking rather than moving.
 *
 * Rest is the more important of the two. The camera settles, the interface
 * fades out entirely, depth of field deepens, the soundscape comes forward,
 * and an optional breathing guide appears. Nothing is unlocked by it and
 * nothing is earned; it exists because the whole game is meant to be a place
 * to sit down in.
 */

import * as THREE from 'three';
import { damp, lerp, smoothstep } from '../world/noise';

export type Mode = 'walking' | 'resting' | 'photo';

export interface ModeVisuals {
  /** 0..1, how much the interface should be hidden. */
  uiFade: number;
  /** Extra vignette while resting. */
  vignette: number;
  /** Field of view multiplier — resting narrows very slightly. */
  fovScale: number;
  /** 0..1, breathing cycle position for the guide ring. */
  breath: number;
  /** Text under the breathing ring. */
  breathPhase: string;
}

/**
 * A 4-7-8 breath, slowed a little.
 *
 * The proportions matter more than the absolute length: a longer exhale than
 * inhale is the part that actually settles you, and holding briefly between
 * them stops it turning into hyperventilation.
 */
const BREATH_IN = 4.5;
const BREATH_HOLD = 2.5;
const BREATH_OUT = 6.5;
const BREATH_CYCLE = BREATH_IN + BREATH_HOLD + BREATH_OUT;

export class Modes {
  mode: Mode = 'walking';
  /** Whether the breathing guide is shown while resting. */
  breathingGuide = true;

  readonly visuals: ModeVisuals = {
    uiFade: 0,
    vignette: 0,
    fovScale: 1,
    breath: 0,
    breathPhase: '',
  };

  /** Photo mode camera offsets, relative to where the player stands. */
  readonly photoOffset = new THREE.Vector3();
  photoPitch = 0;
  photoYaw = 0;
  /** 35mm-equivalent focal length the photo UI shows. */
  photoFocal = 50;

  private breathTime = 0;
  private restedFor = 0;

  /** Fired when the mode changes, so audio and input can follow. */
  onChange: ((mode: Mode) => void) | null = null;

  toggleRest() {
    this.set(this.mode === 'resting' ? 'walking' : 'resting');
  }

  togglePhoto() {
    this.set(this.mode === 'photo' ? 'walking' : 'photo');
  }

  set(mode: Mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    if (mode === 'resting') {
      this.breathTime = 0;
      this.restedFor = 0;
    }
    if (mode === 'photo') {
      this.photoOffset.set(0, 0, 0);
      this.photoPitch = 0;
      this.photoYaw = 0;
    }
    this.onChange?.(mode);
  }

  get isResting(): boolean {
    return this.mode === 'resting';
  }

  get isPhoto(): boolean {
    return this.mode === 'photo';
  }

  /** How long the player has been sitting, in seconds. */
  get restDuration(): number {
    return this.restedFor;
  }

  update(dt: number) {
    const v = this.visuals;

    if (this.mode === 'resting') {
      this.restedFor += dt;
      this.breathTime = (this.breathTime + dt) % BREATH_CYCLE;

      // The interface fades out over a couple of seconds rather than snapping,
      // so sitting down feels like the world quieting rather than a menu.
      v.uiFade = damp(v.uiFade, 1, 1.1, dt);
      v.vignette = damp(v.vignette, 0.42, 0.8, dt);
      v.fovScale = damp(v.fovScale, 0.94, 0.7, dt);

      const t = this.breathTime;
      if (t < BREATH_IN) {
        v.breath = smoothstep(0, BREATH_IN, t);
        v.breathPhase = 'Breathe in';
      } else if (t < BREATH_IN + BREATH_HOLD) {
        v.breath = 1;
        v.breathPhase = 'Hold';
      } else {
        v.breath = 1 - smoothstep(BREATH_IN + BREATH_HOLD, BREATH_CYCLE, t);
        v.breathPhase = 'Breathe out';
      }
    } else if (this.mode === 'photo') {
      v.uiFade = damp(v.uiFade, 0, 3, dt);
      v.vignette = damp(v.vignette, 0.12, 2, dt);
      v.fovScale = damp(v.fovScale, 50 / this.photoFocal, 3, dt);
      v.breath = damp(v.breath, 0, 3, dt);
      v.breathPhase = '';
    } else {
      this.restedFor = 0;
      v.uiFade = damp(v.uiFade, 0, 3.5, dt);
      v.vignette = damp(v.vignette, 0, 2.5, dt);
      v.fovScale = damp(v.fovScale, 1, 2.5, dt);
      v.breath = damp(v.breath, 0, 3, dt);
      v.breathPhase = '';
    }
  }

  /**
   * Nudge the photo camera. Kept on a short leash so a photograph is always
   * taken from roughly where you are standing — this is a camera, not a drone.
   */
  movePhotoCamera(forward: number, right: number, up: number) {
    this.photoOffset.x = THREE.MathUtils.clamp(this.photoOffset.x + right, -2.5, 2.5);
    this.photoOffset.y = THREE.MathUtils.clamp(this.photoOffset.y + up, -1.2, 2.2);
    this.photoOffset.z = THREE.MathUtils.clamp(this.photoOffset.z + forward, -2.5, 2.5);
  }

  setFocal(mm: number) {
    this.photoFocal = THREE.MathUtils.clamp(mm, 24, 135);
  }

  /** Rest deepens gradually; used to ease depth of field and audio. */
  restDepth(): number {
    return smoothstep(0, 6, this.restedFor);
  }
}

/** Photo filters. Applied as a simple tone curve over the captured pixels. */
export interface PhotoFilter {
  id: string;
  name: string;
  /** Multiplied into the image. */
  tint: [number, number, number];
  /** Lift the blacks for a faded, printed look. */
  lift: number;
  contrast: number;
  saturation: number;
}

export const PHOTO_FILTERS: PhotoFilter[] = [
  { id: 'plain', name: 'As seen', tint: [1, 1, 1], lift: 0, contrast: 1, saturation: 1 },
  { id: 'warm', name: 'Late light', tint: [1.07, 1.0, 0.9], lift: 0.02, contrast: 1.06, saturation: 1.08 },
  { id: 'cool', name: 'Cold morning', tint: [0.93, 0.99, 1.08], lift: 0.03, contrast: 1.02, saturation: 0.92 },
  { id: 'faded', name: 'Old print', tint: [1.04, 1.0, 0.95], lift: 0.07, contrast: 0.9, saturation: 0.75 },
  { id: 'mono', name: 'Monochrome', tint: [1, 1, 1], lift: 0.02, contrast: 1.12, saturation: 0 },
];

/**
 * Apply a filter to captured pixels, in place.
 *
 * Done on the CPU over the read-back image rather than as a post-process, so
 * the filter only ever affects the photograph and never what you are looking
 * at while framing it.
 */
export function applyFilter(data: Uint8ClampedArray, filter: PhotoFilter): void {
  const [tr, tg, tb] = filter.tint;
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i] / 255;
    let g = data[i + 1] / 255;
    let b = data[i + 2] / 255;

    r *= tr; g *= tg; b *= tb;

    // Rec. 709 luma, so desaturation keeps the tonal relationships right.
    const luma = r * 0.2126 + g * 0.7152 + b * 0.0722;
    r = lerp(luma, r, filter.saturation);
    g = lerp(luma, g, filter.saturation);
    b = lerp(luma, b, filter.saturation);

    r = (r - 0.5) * filter.contrast + 0.5;
    g = (g - 0.5) * filter.contrast + 0.5;
    b = (b - 0.5) * filter.contrast + 0.5;

    r = filter.lift + r * (1 - filter.lift);
    g = filter.lift + g * (1 - filter.lift);
    b = filter.lift + b * (1 - filter.lift);

    data[i] = Math.max(0, Math.min(255, r * 255));
    data[i + 1] = Math.max(0, Math.min(255, g * 255));
    data[i + 2] = Math.max(0, Math.min(255, b * 255));
  }
}
