/**
 * Waterfall spray.
 *
 * Where a stream crosses steep ground it throws mist, and that mist is most of
 * what makes a fall read as *falling* rather than as a bright ribbon painted
 * on a hillside. It is also the one place in this world where you can see the
 * air.
 *
 * Sites are found, not placed. The heightfield already knows where fast water
 * meets a steep face — the same test the landmark finder uses — so a scan of
 * the ground around the player produces the falls, and they are the same falls
 * every time because the terrain is a pure function of the seed.
 *
 * Every particle lives entirely in the vertex shader. One instanced quad per
 * particle carries an origin, a seed and a size; the shader derives a looping
 * lifetime from the seed and the clock, and there is no per-frame CPU work at
 * all beyond uploading a time uniform. That matters because the alternative —
 * a particle pool updated on the CPU — would be a per-frame cost paid even
 * when the nearest waterfall is four hundred metres behind you.
 */

import * as THREE from 'three';
import type { Heightfield } from '../world/heightfield';
import { createSample, type TerrainSample } from '../world/heightfield';
import { hash2f } from '../core/rng';

/** Particles per site. Enough to read as a cloud, few enough to be free. */
const PER_SITE = 90;
/** Total instance capacity; sites beyond this are simply not drawn. */
const CAPACITY = 900;
/** How far the player moves before the site list is rebuilt. */
const REBUILD_DISTANCE = 20;
/** How far a fall is visible as spray. Past this it is just water. */
const RANGE = 170;
/**
 * Scan steps, in metres, near and far.
 *
 * The near step has to be smaller than a stream is wide or the scan walks
 * straight over it: a first attempt at fourteen metres found one wet cell in a
 * grid of six hundred and no falls at all, in a valley with a waterfall in it.
 * A mountain beck is three to five metres across, so three metres it is.
 */
const NEAR_STEP = 3;
const NEAR_RANGE = 62;
const FAR_STEP = 9;
/** Falls closer together than this are one fall. */
const MERGE_DISTANCE = 9;

const VERT = /* glsl */ `
precision highp float;

attribute vec3 position;
attribute vec2 uv;
attribute vec3 aOrigin;
attribute vec3 aParams;   // seed, size, strength

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uTime;
uniform vec2 uWind;

varying vec2 vUv;
varying float vFade;
varying float vLife;

void main() {
  vUv = uv;
  float seed = aParams.x;
  float size = aParams.y;
  float strength = aParams.z;

  // A looping lifetime, offset per particle so the cloud never pulses.
  float rate = 0.22 + fract(seed * 7.31) * 0.16;
  float life = fract(uTime * rate + seed);
  vLife = life;

  // Spray leaves the fall fast and slows: it is thrown, not emitted. The
  // square root is what stops the cloud looking like a fountain.
  float rise = sqrt(life) * 2.6 + life * 1.4;
  float spread = sqrt(life) * 1.9;

  float angle = seed * 6.2831853 + life * 0.6;
  vec3 offset = vec3(
    cos(angle) * spread + uWind.x * life * 3.2,
    rise,
    sin(angle) * spread + uWind.y * life * 3.2
  );

  // Grow as it dissipates, which is what a cloud of droplets does as it turns
  // into vapour and spreads.
  float scale = size * (0.35 + life * 1.5);

  // Fade in fast, out slowly, and never quite reach full opacity: spray you
  // can't see through is steam.
  vFade = smoothstep(0.0, 0.12, life) * (1.0 - smoothstep(0.35, 1.0, life)) * strength;

  vec3 centre = aOrigin + offset;

  // Billboard in view space, so the quad always faces the camera without a
  // per-particle matrix.
  vec4 view = modelViewMatrix * vec4(centre, 1.0);
  view.xy += position.xy * scale;
  gl_Position = projectionMatrix * view;
}
`;

const FRAG = /* glsl */ `
precision highp float;

uniform vec3 uColor;
uniform vec3 uSunColor;
uniform float uOpacity;

varying vec2 vUv;
varying float vFade;
varying float vLife;

void main() {
  // A soft round droplet cloud. No texture: a smoothstep on the radius is
  // indistinguishable at this size and costs nothing to download.
  vec2 d = vUv * 2.0 - 1.0;
  float r = dot(d, d);
  if (r > 1.0) discard;
  float alpha = (1.0 - r) * (1.0 - r) * vFade * uOpacity;
  if (alpha < 0.004) discard;

  // Mist is lit almost entirely by the sky, with a little sun through it. The
  // young end of the cloud is denser and darker than the old.
  vec3 color = mix(uColor * 0.82, uColor + uSunColor * 0.35, vLife);
  gl_FragColor = vec4(color, alpha);
}
`;

interface Site {
  x: number;
  y: number;
  z: number;
  strength: number;
}

export class Spray {
  readonly group = new THREE.Group();
  /** Set false by the quality tier on machines that cannot spare the fill. */
  enabled = true;

  private mesh: THREE.Mesh;
  private material: THREE.RawShaderMaterial;
  private origins: THREE.InstancedBufferAttribute;
  private params: THREE.InstancedBufferAttribute;
  private lastBuild = new THREE.Vector3(Infinity, 0, Infinity);
  private sites: Site[] = [];
  private sample: TerrainSample = createSample();
  private drawn = 0;

  constructor(private field: Heightfield) {
    this.group.name = 'spray';

    const geometry = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    geometry.setAttribute('position', quad.getAttribute('position'));
    geometry.setAttribute('uv', quad.getAttribute('uv'));
    geometry.setIndex(quad.getIndex());
    quad.dispose();

    this.origins = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 3), 3);
    this.params = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 3), 3);
    this.origins.setUsage(THREE.DynamicDrawUsage);
    this.params.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aOrigin', this.origins);
    geometry.setAttribute('aParams', this.params);
    geometry.instanceCount = 0;

    this.material = new THREE.RawShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uWind: { value: new THREE.Vector2(1, 0) },
        uColor: { value: new THREE.Color(0.72, 0.78, 0.82) },
        uSunColor: { value: new THREE.Color(1, 1, 1) },
        uOpacity: { value: 0.5 },
      },
      transparent: true,
      depthWrite: false,
      // Not additive: mist over a dark rock face has to lighten it, but mist
      // over bright sky must not blow out to white.
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
    });

    // A plain Mesh over an InstancedBufferGeometry, not an InstancedMesh:
    // InstancedMesh brings its own instanceMatrix and its own idea of the
    // instance count, and this shader places particles from an origin
    // attribute instead. Two mechanisms for the same thing is one too many.
    this.mesh = new THREE.Mesh(geometry, this.material);
    // Instances are placed by the shader from an origin attribute, so there is
    // no object-space bound that means anything.
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.group.add(this.mesh);
  }

  /**
   * Find the falls near a point.
   *
   * Deliberately coarse: fourteen metres between samples over a three hundred
   * metre square is about five hundred heightfield lookups, half a millisecond,
   * and it only runs when the player has moved twenty metres. A finer scan
   * would find the same falls twice.
   */
  private findSites(camX: number, camZ: number) {
    this.sites.length = 0;
    const maxSites = Math.floor(CAPACITY / PER_SITE);

    const consider = (x: number, z: number) => {
      const s = this.field.sample(x, z, this.sample);
      // Fast water on a steep face: the same test the landmark finder uses for
      // a waterfall, so the spray and the journal always agree about where the
      // falls are.
      if (s.waterHeight <= s.height) return;
      if (s.riverT < 0.45 || s.slope < 0.42) return;

      const strength = Math.min(1, (s.slope - 0.42) * 2.4 + (s.riverT - 0.45) * 1.2);

      // A fall is metres across and the near scan steps every three, so the
      // same fall is found many times over. Merge into whichever existing site
      // is close enough, keeping the strongest reading rather than the first.
      for (const site of this.sites) {
        if (Math.hypot(site.x - x, site.z - z) < MERGE_DISTANCE) {
          if (strength > site.strength) {
            site.x = x;
            site.z = z;
            site.y = s.waterHeight;
            site.strength = strength;
          }
          return;
        }
      }
      if (this.sites.length < maxSites) {
        this.sites.push({ x, y: s.waterHeight, z, strength });
      }
    };

    // Fine near the player, coarse further out: a fall you are standing beside
    // has to be found exactly, one on the far hillside only has to be found.
    const nearHalf = Math.ceil(NEAR_RANGE / NEAR_STEP);
    for (let j = -nearHalf; j <= nearHalf; j++) {
      for (let i = -nearHalf; i <= nearHalf; i++) {
        const dx = i * NEAR_STEP;
        const dz = j * NEAR_STEP;
        if (dx * dx + dz * dz > NEAR_RANGE * NEAR_RANGE) continue;
        consider(camX + dx, camZ + dz);
      }
    }

    const farHalf = Math.ceil(RANGE / FAR_STEP);
    for (let j = -farHalf; j <= farHalf; j++) {
      for (let i = -farHalf; i <= farHalf; i++) {
        const dx = i * FAR_STEP;
        const dz = j * FAR_STEP;
        const d2 = dx * dx + dz * dz;
        if (d2 > RANGE * RANGE || d2 < NEAR_RANGE * NEAR_RANGE) continue;
        consider(camX + dx, camZ + dz);
      }
    }
  }

  private rebuild(camX: number, camZ: number) {
    this.findSites(camX, camZ);

    const origins = this.origins.array as Float32Array;
    const params = this.params.array as Float32Array;
    let written = 0;

    for (let siteIndex = 0; siteIndex < this.sites.length; siteIndex++) {
      const site = this.sites[siteIndex];
      for (let p = 0; p < PER_SITE && written < CAPACITY; p++) {
        // Deterministic per site and index, so a fall looks the same every
        // time you walk back to it.
        const a = hash2f(siteIndex * 131 + p, p * 17 + 3);
        const b = hash2f(p * 71 + siteIndex, siteIndex * 29 + 11);
        const c = hash2f(p + siteIndex * 7, p * 5 + 1);

        // Scatter the emitters over the plunge rather than a single point.
        origins[written * 3] = site.x + (a - 0.5) * 5.5;
        origins[written * 3 + 1] = site.y - 1.2 + b * 2.2;
        origins[written * 3 + 2] = site.z + (b - 0.5) * 5.5;

        params[written * 3] = c;
        params[written * 3 + 1] = 0.7 + a * 1.5;
        params[written * 3 + 2] = site.strength;
        written++;
      }
    }

    (this.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = written;
    this.drawn = written;
    this.origins.needsUpdate = true;
    this.params.needsUpdate = true;
  }

  update(
    camera: THREE.Camera,
    elapsed: number,
    wind: { x: number; z: number; gust: number },
    light: { sky: THREE.Color; sun: THREE.Color; daylight: number }
  ) {
    this.group.visible = this.enabled;
    if (!this.enabled) return;

    const p = camera.position;
    if (Math.hypot(p.x - this.lastBuild.x, p.z - this.lastBuild.z) > REBUILD_DISTANCE) {
      this.lastBuild.copy(p);
      this.rebuild(p.x, p.z);
    }

    const u = this.material.uniforms;
    u.uTime.value = elapsed;
    (u.uWind.value as THREE.Vector2).set(wind.x, wind.z).multiplyScalar(0.35 + wind.gust * 0.5);
    (u.uColor.value as THREE.Color).copy(light.sky);
    (u.uSunColor.value as THREE.Color).copy(light.sun);
    // Spray is invisible at night for the same reason it is obvious at noon:
    // it has no colour of its own, only whatever light passes through it.
    u.uOpacity.value = 0.16 + light.daylight * 0.4;
  }

  get particleCount(): number {
    return this.drawn;
  }

  get siteCount(): number {
    return this.sites.length;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.group.clear();
  }
}
