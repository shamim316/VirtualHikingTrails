/**
 * The hiker.
 *
 * Deliberately gentle physics. There is no jumping, no falling damage, no
 * stamina bar and nothing to run from. What the controller does care about is
 * that walking *feels* like walking: you slow down going uphill, you can't
 * scramble up a cliff face, your head rises and falls with your stride, and
 * when you stop, you keep breathing.
 *
 * The camera is placed by sampling the heightfield directly rather than by
 * raycasting the terrain mesh — the mesh is an approximation of the field, and
 * sampling the field means the ground never disagrees with itself at a chunk
 * boundary or while a distant chunk is still loading.
 */

import * as THREE from 'three';
import type { Heightfield } from '../world/heightfield';
import type { InputState } from '../core/input';
import { clamp, clamp01, damp, lerp, smoothstep } from '../world/noise';

const EYE_HEIGHT = 1.68;
const WALK_SPEED = 1.85;
const BRISK_SPEED = 3.1;
const TURN_SPEED = 1.75;
/** Steeper than this and you can't make upward progress. */
const MAX_CLIMB_SLOPE = 0.72;
/** Radius used to keep the camera out of the inside of a hill. */
const BODY_RADIUS = 0.42;

export interface PlayerState {
  position: THREE.Vector3;
  /** Heading in radians; 0 looks down -Z. */
  yaw: number;
  pitch: number;
  /** Ground height under the player. */
  groundHeight: number;
  /** Current speed over the ground, m/s. */
  speed: number;
  /** How deep in water the player is standing, in metres. */
  waterDepth: number;
  /** Terrain slope underfoot, 0..1. */
  slope: number;
  /** Distance walked in total, in metres. */
  distanceWalked: number;
}

export class PlayerController {
  readonly state: PlayerState = {
    position: new THREE.Vector3(),
    yaw: 0,
    pitch: 0,
    groundHeight: 0,
    speed: 0,
    waterDepth: 0,
    slope: 0,
    distanceWalked: 0,
  };

  /** Set while resting or in photo mode: input still arrives but is ignored. */
  frozen = false;
  /** Scales all movement; the rest mode eases this to zero rather than snapping. */
  mobility = 1;

  private velocity = new THREE.Vector2();
  private bobPhase = 0;
  private breathPhase = Math.random() * Math.PI * 2;
  private currentEye = EYE_HEIGHT;
  private smoothedGround = 0;
  private headOffset = new THREE.Vector3();
  private initialised = false;
  private forward = new THREE.Vector3();
  private right = new THREE.Vector3();

  constructor(private field: Heightfield) {}

  /** Drop the player onto the ground at a position, facing a direction. */
  placeAt(x: number, z: number, yaw = 0) {
    const h = this.field.height(x, z);
    this.state.position.set(x, h + EYE_HEIGHT, z);
    this.state.groundHeight = h;
    this.smoothedGround = h;
    this.state.yaw = yaw;
    this.state.pitch = 0;
    this.velocity.set(0, 0);
    this.initialised = true;
  }

  /**
   * Find somewhere pleasant to begin.
   *
   * Spiralling out from the requested point, looking for open, walkable ground
   * that isn't underwater and isn't a scree slope. Starting inside a boulder
   * field or waist-deep in a tarn is a poor first impression.
   */
  findStart(x: number, z: number): { x: number; z: number; yaw: number } {
    let best = { x, z, yaw: 0, score: -Infinity };

    for (let i = 0; i < 260; i++) {
      // Golden-angle spiral: even coverage without clumping.
      const angle = i * 2.39996;
      const radius = Math.sqrt(i) * 24;
      const px = x + Math.cos(angle) * radius;
      const pz = z + Math.sin(angle) * radius;

      const sample = this.field.sample(px, pz);
      if (sample.waterHeight > sample.height) continue;
      if (sample.slope > 0.3) continue;

      const eye = sample.height + EYE_HEIGHT;

      // How much sky can you see from here, and which way is the best view?
      // Standing at the foot of a slope with a wall filling two thirds of the
      // frame is a poor way to begin a walk, and slope alone doesn't catch it —
      // the ground underfoot can be perfectly flat.
      let openness = 0;
      let bestBearing = 0;
      let bestBearingScore = -Infinity;

      for (let b = 0; b < 12; b++) {
        const bearing = (b / 12) * Math.PI * 2;
        const dx = -Math.sin(bearing);
        const dz = -Math.cos(bearing);

        let horizon = -Math.PI / 2;
        let trees = 0;
        for (const d of [30, 70, 140, 260, 460]) {
          const tx = px + dx * d;
          const tz = pz + dz * d;
          const h = this.field.height(tx, tz);
          const a = Math.atan2(h - eye, d);
          if (a > horizon) horizon = a;
          if (d <= 260) {
            const n = this.field.normal(tx, tz, 2);
            trees += this.field.forestDensity(tx, tz, h, clamp01(1 - n.y)) / 4;
          }
        }

        // A horizon at or below eye level is open; anything above is blocked.
        const open = 1 - clamp01(horizon / 0.5);
        openness += open / 12;

        // The best direction to be facing is not the emptiest one. A horizon
        // that drops away to nothing fills the screen with sky; what you want
        // on the first frame is somewhere with depth to it — ground falling
        // away, trees in the middle distance, a ridge beyond.
        const framing = 1 - clamp01(Math.abs(horizon + 0.04) / 0.28);
        const score = framing * 2 + trees * 1.6 + open * 0.5;
        if (score > bestBearingScore) {
          bestBearingScore = score;
          bestBearing = bearing;
        }
      }

      let score = 0;
      score += openness * 5;
      score += (1 - sample.slope) * 2;
      // A little tree cover nearby is welcome; standing in the open middle of
      // nowhere is not.
      score += Math.min(sample.canopy, 0.6) * 2;
      score += smoothstep(230, 400, sample.height) * 1.5;
      score -= smoothstep(540, 720, sample.height) * 3;
      score -= sample.rockiness * 2;
      score -= radius * 0.003;

      if (score > best.score) best = { x: px, z: pz, yaw: bestBearing, score };
    }

    return { x: best.x, z: best.z, yaw: best.yaw };
  }

  update(input: InputState, look: { x: number; y: number }, dt: number, camera: THREE.PerspectiveCamera) {
    if (!this.initialised) this.placeAt(0, 0);
    const s = this.state;
    // Looking and walking are separable. Photo mode takes the walking away and
    // leaves the looking, because framing a picture is entirely about where you
    // point the camera; rest takes both.
    const canLook = !this.frozen;
    const active = canLook && this.mobility > 0.001;

    // --- looking -------------------------------------------------------------
    if (canLook) {
      s.yaw += look.x;
      s.pitch = clamp(s.pitch + look.y, -1.35, 1.35);
      s.yaw -= input.turn * TURN_SPEED * dt;
    }

    // --- walking -------------------------------------------------------------
    this.forward.set(-Math.sin(s.yaw), 0, -Math.cos(s.yaw));
    this.right.set(Math.cos(s.yaw), 0, -Math.sin(s.yaw));

    const target = new THREE.Vector2(0, 0);
    if (active) {
      const base = input.brisk ? BRISK_SPEED : WALK_SPEED;
      target.x = (this.forward.x * input.forward + this.right.x * input.strafe) * base;
      target.y = (this.forward.z * input.forward + this.right.z * input.strafe) * base;
      const mag = target.length();
      if (mag > base) target.multiplyScalar(base / mag);
      target.multiplyScalar(this.mobility);
    }

    // Terrain resistance: uphill is slow, downhill is barely faster, and wading
    // is slower than either.
    const groundNormal = this.field.normal(s.position.x, s.position.z, 1.1);
    const slope = clamp01(1 - groundNormal.y);
    s.slope = slope;

    if (target.lengthSq() > 1e-6) {
      const uphill = -(groundNormal.x * target.x + groundNormal.z * target.y) / (target.length() || 1);
      // uphill > 0 means we're heading up the gradient.
      const gradePenalty = 1 - clamp01(uphill * slope * 2.4) * 0.72;
      target.multiplyScalar(gradePenalty);

      // Cliffs simply refuse: the component of motion heading up a too-steep
      // face is removed, so you slide along the base instead of sticking.
      if (slope > MAX_CLIMB_SLOPE && uphill > 0) {
        const horizontal = new THREE.Vector2(groundNormal.x, groundNormal.z);
        if (horizontal.lengthSq() > 1e-8) {
          horizontal.normalize();
          const into = target.dot(horizontal);
          if (into < 0) target.addScaledVector(horizontal, -into);
        }
      }
    }

    const wade = clamp01(s.waterDepth / 0.85);
    target.multiplyScalar(lerp(1, 0.42, wade));

    // Ease into and out of motion. Starting instantly at full speed is the
    // single most game-like thing a walking simulator can do.
    const responsiveness = target.lengthSq() > 1e-6 ? 7.5 : 9.5;
    this.velocity.x = damp(this.velocity.x, target.x, responsiveness, dt);
    this.velocity.y = damp(this.velocity.y, target.y, responsiveness, dt);

    const step = this.velocity.length() * dt;
    if (step > 1e-5) {
      const nextX = s.position.x + this.velocity.x * dt;
      const nextZ = s.position.z + this.velocity.y * dt;
      this.resolveMove(nextX, nextZ);
      s.distanceWalked += step;
    }

    s.speed = this.velocity.length();

    // --- standing on the ground ---------------------------------------------
    const ground = this.field.height(s.position.x, s.position.z);
    s.groundHeight = ground;

    const water = this.field.waterHeight(s.position.x, s.position.z);
    s.waterDepth = water > ground ? clamp(water - ground, 0, 3) : 0;

    // Smooth the ground the eye rides on, but only a little: too much and you
    // float over rocks, too little and every pebble is an earthquake.
    this.smoothedGround = damp(this.smoothedGround, ground, 16, dt);

    // --- head motion ---------------------------------------------------------
    const strideRate = clamp(s.speed * 1.55, 0, 6.5);
    this.bobPhase += strideRate * dt;
    this.breathPhase += dt * (0.34 + s.speed * 0.09);

    const bobAmount = clamp01(s.speed / WALK_SPEED) * 0.055;
    const bobY = Math.sin(this.bobPhase * 2) * bobAmount;
    const bobX = Math.sin(this.bobPhase) * bobAmount * 0.75;
    // Breathing continues when you stop, which is most of why standing still
    // doesn't feel like the game has paused.
    const breathY = Math.sin(this.breathPhase) * 0.014;
    const breathRoll = Math.sin(this.breathPhase * 0.85 + 1.1) * 0.0045;

    this.headOffset.set(bobX, bobY + breathY, 0);
    this.currentEye = damp(this.currentEye, EYE_HEIGHT - wade * 0.45, 6, dt);

    s.position.y = this.smoothedGround + this.currentEye;

    // --- camera --------------------------------------------------------------
    camera.position.copy(s.position);
    camera.position.x += this.right.x * this.headOffset.x;
    camera.position.z += this.right.z * this.headOffset.x;
    camera.position.y += this.headOffset.y;

    camera.rotation.set(0, 0, 0);
    camera.rotateY(s.yaw);
    camera.rotateX(s.pitch);
    // A trace of roll from the stride and the breath. Small enough that nobody
    // notices it, large enough that its absence feels mechanical.
    camera.rotateZ(Math.sin(this.bobPhase) * bobAmount * 0.28 + breathRoll);
  }

  /**
   * Move to a new position, refusing to walk into ground that rises faster than
   * a person could climb. Tries the full move, then each axis alone, so sliding
   * along a slope works instead of sticking.
   */
  private resolveMove(nextX: number, nextZ: number) {
    const s = this.state;
    if (this.canStand(nextX, nextZ)) {
      s.position.x = nextX;
      s.position.z = nextZ;
      return;
    }
    if (this.canStand(nextX, s.position.z)) {
      s.position.x = nextX;
      return;
    }
    if (this.canStand(s.position.x, nextZ)) {
      s.position.z = nextZ;
    }
  }

  private canStand(x: number, z: number): boolean {
    const here = this.field.height(this.state.position.x, this.state.position.z);
    const there = this.field.height(x, z);
    const dist = Math.hypot(x - this.state.position.x, z - this.state.position.z) || 1e-4;
    // A step up steeper than roughly 40° is a scramble, not a walk.
    const grade = (there - here) / dist;
    if (grade > 0.85) return false;

    // Keep the body out of walls that are steep in the direction of travel.
    const ahead = this.field.height(
      x + ((x - this.state.position.x) / dist) * BODY_RADIUS,
      z + ((z - this.state.position.z) / dist) * BODY_RADIUS
    );
    return (ahead - here) / (dist + BODY_RADIUS) <= 1.1;
  }
}
