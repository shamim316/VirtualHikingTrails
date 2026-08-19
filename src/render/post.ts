/**
 * Post-processing: bloom, god rays, depth of field, vignette and the tonemap.
 *
 * Hand-rolled rather than assembled from `EffectComposer`, for one structural
 * reason. three applies tone mapping inside every material's fragment shader,
 * so a scene rendered the ordinary way arrives already compressed to display
 * range — and bloom and light shafts on display-range values are a different,
 * much worse effect than bloom on the real radiances. The sun disc in this
 * world leaves the sky shader at a few hundred; after AgX it is 1.0, the same
 * as a white rock. Bloom it there and the rock glows.
 *
 * So the scene is rendered with tone mapping *off* into a half-float target,
 * every effect works on linear radiance, and AgX is applied once at the very
 * end of the composite. That is also why exposure moves here from the renderer.
 *
 * The chain, in order:
 *
 *   scene -> HDR target (+ depth)
 *   bright pass -> downsample chain -> upsample with tent filter  = bloom
 *   sun-masked radial blur at quarter res                          = god rays
 *   circle-of-confusion blur at half res                           = depth of field
 *   composite: add, mix by CoC, vignette, AgX, sRGB
 *
 * Everything is gated per quality tier, and the whole stack can be switched
 * off, in which case the caller renders straight to the canvas as before.
 */

import * as THREE from 'three';
import type { QualitySettings } from '../core/quality';
import { clamp01, damp, lerp } from '../world/noise';

/** How many halvings the bloom chain does. Five reaches a very wide glow. */
const BLOOM_LEVELS = 5;

export interface PostState {
  /** Unit vector toward the sun, world space. */
  sunDirection: THREE.Vector3;
  /** 0 in full daylight, 1 at night — shafts and bloom ease off after dark. */
  night: number;
  /** 0..1, how much haze is in the air; shafts need something to scatter in. */
  haze: number;
  /** Linear exposure, applied at the tonemap. */
  exposure: number;
  /** Metres to the plane in focus. Zero means "focus on whatever is centred". */
  focusDistance: number;
  /** 0 = everything sharp, 1 = full defocus. */
  defocus: number;
  /** Extra darkening at the frame's edge, 0..1. */
  vignette: number;
}

// RawShaderMaterial gets no automatic prologue, so the attributes the quad
// needs have to be declared here by hand.
const FULLSCREEN_VERT = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Bright pass with a soft knee.
 *
 * A hard threshold makes bloom flicker: a pixel crossing the line pops its
 * whole contribution in at once, and on a moving canopy that reads as sparkle.
 * The knee ramps the contribution in over a stop or so instead.
 */
const BRIGHT_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSource;
uniform float uThreshold;
uniform float uKnee;

void main() {
  vec3 color = texture2D(tSource, vUv).rgb;
  float brightness = max(color.r, max(color.g, color.b));
  float soft = clamp(brightness - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-5);
  float contribution = max(soft, brightness - uThreshold) / max(brightness, 1e-5);
  gl_FragColor = vec4(color * contribution, 1.0);
}
`;

/** Thirteen-tap downsample — the filter Call of Duty's presentation made
 *  standard, chosen because it does not alias a single bright pixel into a
 *  flickering blob the way a box filter does. */
const DOWNSAMPLE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSource;
uniform vec2 uTexel;

void main() {
  vec2 t = uTexel;
  vec3 a = texture2D(tSource, vUv + vec2(-2.0, 2.0) * t).rgb;
  vec3 b = texture2D(tSource, vUv + vec2( 0.0, 2.0) * t).rgb;
  vec3 c = texture2D(tSource, vUv + vec2( 2.0, 2.0) * t).rgb;
  vec3 d = texture2D(tSource, vUv + vec2(-2.0, 0.0) * t).rgb;
  vec3 e = texture2D(tSource, vUv).rgb;
  vec3 f = texture2D(tSource, vUv + vec2( 2.0, 0.0) * t).rgb;
  vec3 g = texture2D(tSource, vUv + vec2(-2.0,-2.0) * t).rgb;
  vec3 h = texture2D(tSource, vUv + vec2( 0.0,-2.0) * t).rgb;
  vec3 i = texture2D(tSource, vUv + vec2( 2.0,-2.0) * t).rgb;
  vec3 j = texture2D(tSource, vUv + vec2(-1.0, 1.0) * t).rgb;
  vec3 k = texture2D(tSource, vUv + vec2( 1.0, 1.0) * t).rgb;
  vec3 l = texture2D(tSource, vUv + vec2(-1.0,-1.0) * t).rgb;
  vec3 m = texture2D(tSource, vUv + vec2( 1.0,-1.0) * t).rgb;

  vec3 result = e * 0.125;
  result += (a + c + g + i) * 0.03125;
  result += (b + d + f + h) * 0.0625;
  result += (j + k + l + m) * 0.125;
  gl_FragColor = vec4(result, 1.0);
}
`;

/** Tent-filter upsample, additively blended onto the level above. */
const UPSAMPLE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSource;
uniform vec2 uTexel;
uniform float uRadius;

void main() {
  vec2 t = uTexel * uRadius;
  vec3 result = texture2D(tSource, vUv + vec2(-1.0,  1.0) * t).rgb * 1.0;
  result += texture2D(tSource, vUv + vec2( 0.0,  1.0) * t).rgb * 2.0;
  result += texture2D(tSource, vUv + vec2( 1.0,  1.0) * t).rgb * 1.0;
  result += texture2D(tSource, vUv + vec2(-1.0,  0.0) * t).rgb * 2.0;
  result += texture2D(tSource, vUv).rgb * 4.0;
  result += texture2D(tSource, vUv + vec2( 1.0,  0.0) * t).rgb * 2.0;
  result += texture2D(tSource, vUv + vec2(-1.0, -1.0) * t).rgb * 1.0;
  result += texture2D(tSource, vUv + vec2( 0.0, -1.0) * t).rgb * 2.0;
  result += texture2D(tSource, vUv + vec2( 1.0, -1.0) * t).rgb * 1.0;
  gl_FragColor = vec4(result / 16.0, 1.0);
}
`;

/**
 * God rays.
 *
 * The cheap screen-space version: march from each pixel toward the sun's
 * screen position, accumulating whatever bright stuff lies along the way, with
 * the contribution decaying as you go. Where a trunk or a branch blocks the
 * sky, the samples along that line are dark and no shaft forms — which means
 * the occlusion is free and, more importantly, is exactly the canopy the
 * player is standing under.
 *
 * The mask keeps only genuinely bright pixels, so shafts come from sky seen
 * through leaves rather than from every pale rock in the frame.
 */
const GODRAY_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSource;
uniform sampler2D tDepth;
uniform vec2 uSun;
uniform float uDensity;
uniform float uDecay;
uniform float uWeight;
uniform float uThreshold;

const int SAMPLES = 24;

void main() {
  vec2 toSun = (uSun - vUv) * uDensity / float(SAMPLES);
  vec2 uv = vUv;
  float illumination = 1.0;
  vec3 total = vec3(0.0);

  for (int i = 0; i < SAMPLES; i++) {
    uv += toSun;
    // Outside the frame there is nothing to sample and no shaft to build.
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;

    // Sky only. Marching through scene colour instead — as a first attempt
    // here did — means every sunlit leaf feeds the accumulation too, and the
    // result is a uniform haze over the frame rather than shafts: the thing
    // that makes a shaft is the *hard* edge between sky and canopy. The sky
    // dome is drawn at the far plane, so one depth compare is the whole mask.
    float depth = texture2D(tDepth, uv).x;
    if (depth < 0.9995) {
      illumination *= uDecay;
      continue;
    }

    vec3 sampled = texture2D(tSource, uv).rgb;
    float brightness = max(sampled.r, max(sampled.g, sampled.b));
    sampled *= smoothstep(uThreshold, uThreshold * 2.0, brightness);
    total += sampled * illumination;
    illumination *= uDecay;
  }

  // Fall off with distance from the sun. Without this every pixel in the
  // frame marches its own 24 samples and accumulates something, so the whole
  // picture gets a milky veil instead of shafts near the light. The x axis is
  // weighted more heavily because the frame is wider than it is tall and the
  // falloff should be circular on screen, not elliptical.
  float radial = exp(-length((vUv - uSun) * vec2(1.7, 1.0)) * 2.6);

  gl_FragColor = vec4(total * uWeight * radial / float(SAMPLES), 1.0);
}
`;

/**
 * Depth of field.
 *
 * A single-pass disc blur at half resolution rather than a proper separable
 * bokeh: this is a walking simulator, the effect is barely on while you walk,
 * and the one place it matters — sitting down and letting the far hillside go
 * soft — is a static shot where a cheap blur is indistinguishable from an
 * expensive one.
 *
 * The circle of confusion comes from real optics: it grows with the distance
 * from the focal plane and shrinks with the square of the f-number, which is
 * why the far field goes soft long before the near field does.
 */
const DOF_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSource;
uniform sampler2D tDepth;
uniform vec2 uTexel;
uniform float uNear;
uniform float uFar;
uniform float uFocus;
uniform float uRange;
uniform float uMaxRadius;

// Sixteen points on a golden-angle spiral: no visible ring structure and no
// texture lookup for the kernel.
const int TAPS = 16;

float linearDepth(vec2 uv) {
  float z = texture2D(tDepth, uv).x;
  float ndc = z * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
}

float circleOfConfusion(float depth) {
  float signedBlur = (depth - uFocus) / max(uRange, 0.01);
  // Behind the focal plane blurs faster than in front of it, as it does in a
  // real lens.
  return clamp(signedBlur > 0.0 ? signedBlur : signedBlur * 0.6, -1.0, 1.0);
}

void main() {
  float centreDepth = linearDepth(vUv);
  float coc = circleOfConfusion(centreDepth);
  float radius = abs(coc) * uMaxRadius;

  vec3 total = texture2D(tSource, vUv).rgb;
  float weight = 1.0;

  for (int i = 1; i <= TAPS; i++) {
    float t = float(i) / float(TAPS);
    float angle = float(i) * 2.39996323;
    vec2 offset = vec2(cos(angle), sin(angle)) * sqrt(t) * radius * uTexel;
    vec2 uv = vUv + offset;
    vec3 sampled = texture2D(tSource, uv).rgb;
    // Reject sharp foreground pixels bleeding onto a blurred background: the
    // classic halo. A sample only contributes if it is at least as defocused
    // as the pixel being written.
    float sampleCoc = circleOfConfusion(linearDepth(uv));
    float accept = smoothstep(0.0, 0.25, abs(sampleCoc) - abs(coc) + 0.25);
    total += sampled * accept;
    weight += accept;
  }

  gl_FragColor = vec4(total / weight, abs(coc));
}
`;

/**
 * The composite, and the only place tone mapping happens.
 *
 * AgX is written out here rather than borrowed from three's material chunks,
 * because this pass is a RawShader with no chunk injection — and because
 * having the curve visible is worth something in a file whose whole job is
 * deciding what the picture looks like.
 */
const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform sampler2D tRays;
uniform sampler2D tBlur;
uniform float uBloomStrength;
uniform float uRayStrength;
uniform vec3 uRayTint;
uniform float uExposure;
uniform float uVignette;
uniform float uDefocus;
uniform float uGrain;
uniform float uTime;

// --- AgX ---------------------------------------------------------------------
// Troy Sobotka's curve, in the form three uses, and it has to be *all* of that
// form. Dropping the Rec.2020 round trip and the closing 2.2 gamma — as a
// first attempt here did — still produces a picture, just a flat, milky one
// with lifted blacks, which is a very easy thing to mistake for "the bloom is
// too strong".
const mat3 SRGB_TO_REC2020 = mat3(
  vec3(0.6274, 0.0691, 0.0164),
  vec3(0.3293, 0.9195, 0.0880),
  vec3(0.0433, 0.0113, 0.8956)
);
const mat3 REC2020_TO_SRGB = mat3(
  vec3( 1.6605, -0.1246, -0.0182),
  vec3(-0.5876,  1.1329, -0.1006),
  vec3(-0.0728, -0.0083,  1.1187)
);
const mat3 AGX_IN = mat3(
  vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
  vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
  vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859)
);
const mat3 AGX_OUT = mat3(
  vec3( 1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
  vec3(-0.11060664309660323,  1.157823702216272, -0.11060664309660294),
  vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405)
);
const float AGX_MIN_EV = -12.47393;
const float AGX_MAX_EV = 4.026069;

vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return + 15.5 * x4 * x2
         - 40.14 * x4 * x
         + 31.96 * x4
         - 6.868 * x2 * x
         + 0.4298 * x2
         + 0.1191 * x
         - 0.00232;
}

vec3 agx(vec3 color) {
  color = SRGB_TO_REC2020 * max(color, vec3(0.0));
  color = AGX_IN * color;
  color = log2(max(color, 1e-10));
  color = (color - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV);
  color = clamp(color, 0.0, 1.0);
  color = agxContrast(color);
  color = AGX_OUT * color;
  color = pow(max(color, vec3(0.0)), vec3(2.2));
  color = REC2020_TO_SRGB * color;
  return clamp(color, 0.0, 1.0);
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

void main() {
  vec4 blurred = texture2D(tBlur, vUv);
  vec3 sharp = texture2D(tScene, vUv).rgb;

  // The alpha of the blur target carries the circle of confusion the blur pass
  // computed, so the mix does not have to read depth a third time.
  float coc = blurred.a * uDefocus;
  vec3 color = mix(sharp, blurred.rgb, clamp(coc * 1.6, 0.0, 1.0));

  color += texture2D(tBloom, vUv).rgb * uBloomStrength;
  color += texture2D(tRays, vUv).rgb * uRayStrength * uRayTint;

  color *= uExposure;
  color = agx(color);

  // Vignette, applied after the tonemap so it darkens the picture rather than
  // the radiance — which is what a lens actually does to a photograph.
  vec2 centred = (vUv - 0.5) * vec2(1.0, 0.92);
  float falloff = smoothstep(0.78, 0.28, length(centred));
  color *= mix(1.0, falloff, uVignette);

  // A whisper of grain. Digital images with none of it read as plastic, and
  // it also breaks up the banding a large smooth sky would otherwise show.
  float grain = hash(vUv * 1024.0 + fract(uTime) * 91.7) - 0.5;
  color += grain * uGrain;

  // Linear -> sRGB. The target is a plain RGBA8 canvas, so this is the last
  // thing that happens.
  color = clamp(color, 0.0, 1.0);
  vec3 encoded = mix(color * 12.92, 1.055 * pow(color, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, color));

  gl_FragColor = vec4(encoded, 1.0);
}
`;

function makeTarget(width: number, height: number, type: THREE.TextureDataType, depth = false) {
  const target = new THREE.WebGLRenderTarget(Math.max(1, width), Math.max(1, height), {
    type,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
    depthBuffer: depth,
    stencilBuffer: false,
  });
  target.texture.colorSpace = THREE.NoColorSpace;
  if (depth) {
    target.depthTexture = new THREE.DepthTexture(Math.max(1, width), Math.max(1, height));
    target.depthTexture.type = THREE.UnsignedIntType;
    target.depthTexture.minFilter = THREE.NearestFilter;
    target.depthTexture.magFilter = THREE.NearestFilter;
  }
  return target;
}

export class Post {
  /** False on the low tier, where the stack is skipped entirely. */
  enabled = true;

  private quad: THREE.Mesh;
  private quadScene = new THREE.Scene();
  private quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  private scene: THREE.WebGLRenderTarget;
  private bloomChain: THREE.WebGLRenderTarget[] = [];
  private rays: THREE.WebGLRenderTarget;
  private blur: THREE.WebGLRenderTarget;

  private bright: THREE.RawShaderMaterial;
  private down: THREE.RawShaderMaterial;
  private up: THREE.RawShaderMaterial;
  private godray: THREE.RawShaderMaterial;
  private dof: THREE.RawShaderMaterial;
  private composite: THREE.RawShaderMaterial;

  private width = 1;
  private height = 1;
  private elapsed = 0;
  /** Eased so shafts fade rather than snapping when the sun goes behind a tree. */
  private raysVisible = 0;
  private focus = 30;
  private sunNdc = new THREE.Vector3();

  constructor(private renderer: THREE.WebGLRenderer, settings: QualitySettings) {
    const half = THREE.HalfFloatType;

    this.scene = makeTarget(1, 1, half, true);
    this.rays = makeTarget(1, 1, half);
    this.blur = makeTarget(1, 1, half);
    for (let i = 0; i < BLOOM_LEVELS; i++) this.bloomChain.push(makeTarget(1, 1, half));

    const make = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) =>
      new THREE.RawShaderMaterial({
        vertexShader: FULLSCREEN_VERT,
        fragmentShader,
        uniforms,
        depthTest: false,
        depthWrite: false,
        glslVersion: null,
      });

    this.bright = make(BRIGHT_FRAG, {
      tSource: { value: null },
      // Measured, not guessed. The sky in this world leaves the shader at
      // 0.6-0.9 of linear radiance and the sun disc at about eleven, because
      // the atmosphere is scaled down and Reinhard-compressed before it ever
      // reaches here. Thresholds of 1.4 excluded the entire sky and produced,
      // correctly, nothing at all.
      uThreshold: { value: 0.88 },
      uKnee: { value: 0.35 },
    });
    this.down = make(DOWNSAMPLE_FRAG, { tSource: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.up = make(UPSAMPLE_FRAG, {
      tSource: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uRadius: { value: 1.0 },
    });
    this.up.blending = THREE.AdditiveBlending;
    this.up.transparent = true;

    this.godray = make(GODRAY_FRAG, {
      tSource: { value: null },
      tDepth: { value: null },
      uSun: { value: new THREE.Vector2(0.5, 0.5) },
      uDensity: { value: 0.62 },
      uDecay: { value: 0.94 },
      uWeight: { value: 13.0 },
      uThreshold: { value: 0.55 },
    });

    this.dof = make(DOF_FRAG, {
      tSource: { value: null },
      tDepth: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uNear: { value: 0.1 },
      uFar: { value: 1000 },
      uFocus: { value: 30 },
      uRange: { value: 60 },
      uMaxRadius: { value: 14 },
    });

    this.composite = make(COMPOSITE_FRAG, {
      tScene: { value: null },
      tBloom: { value: null },
      tRays: { value: null },
      tBlur: { value: null },
      uBloomStrength: { value: 0.09 },
      uRayStrength: { value: 0.0 },
      uRayTint: { value: new THREE.Color(1, 0.93, 0.78) },
      uExposure: { value: 1 },
      uVignette: { value: 0.18 },
      uDefocus: { value: 0 },
      uGrain: { value: 0.006 },
      uTime: { value: 0 },
    });

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.bright);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);

    this.applySettings(settings);
  }

  applySettings(settings: QualitySettings) {
    this.enabled = settings.bloom || settings.godRays || settings.depthOfField;
    this.composite.uniforms.uBloomStrength.value = settings.bloom ? 0.09 : 0;
    this.rayBudget = settings.godRays;
    this.dofBudget = settings.depthOfField;
  }

  private rayBudget = true;
  private dofBudget = true;

  setSize(width: number, height: number, pixelRatio: number) {
    this.width = Math.max(1, Math.floor(width * pixelRatio));
    this.height = Math.max(1, Math.floor(height * pixelRatio));

    this.scene.setSize(this.width, this.height);
    // Shafts are enormous and soft; a quarter of the resolution is free and
    // nobody has ever noticed. Depth of field is half, where the softness of
    // the source would otherwise start to show at the focus boundary.
    this.rays.setSize(Math.ceil(this.width / 4), Math.ceil(this.height / 4));
    this.blur.setSize(Math.ceil(this.width / 2), Math.ceil(this.height / 2));

    for (let i = 0; i < this.bloomChain.length; i++) {
      const divisor = 2 << i;
      this.bloomChain[i].setSize(
        Math.max(1, Math.ceil(this.width / divisor)),
        Math.max(1, Math.ceil(this.height / divisor))
      );
    }
  }

  /** Where the caller should render the world. */
  get renderTarget(): THREE.WebGLRenderTarget {
    return this.scene;
  }

  private blit(material: THREE.Material, target: THREE.WebGLRenderTarget | null, clear = true) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    if (clear) this.renderer.clear(true, false, false);
    this.renderer.render(this.quadScene, this.quadCamera);
  }

  /**
   * Run the chain. The world must already have been rendered into
   * `renderTarget` with tone mapping off.
   */
  render(camera: THREE.PerspectiveCamera, state: PostState, dt: number) {
    this.elapsed += dt;
    const renderer = this.renderer;
    const previousAutoClear = renderer.autoClear;
    renderer.autoClear = false;

    // --- bloom --------------------------------------------------------------
    if (this.composite.uniforms.uBloomStrength.value > 0) {
      this.bright.uniforms.tSource.value = this.scene.texture;
      this.blit(this.bright, this.bloomChain[0]);

      for (let i = 1; i < this.bloomChain.length; i++) {
        const source = this.bloomChain[i - 1];
        this.down.uniforms.tSource.value = source.texture;
        (this.down.uniforms.uTexel.value as THREE.Vector2).set(
          1 / source.width,
          1 / source.height
        );
        this.blit(this.down, this.bloomChain[i]);
      }

      // Back up the chain, adding each level into the one above it. The result
      // is a glow with a wide, soft skirt rather than a single gaussian blob.
      for (let i = this.bloomChain.length - 1; i > 0; i--) {
        const source = this.bloomChain[i];
        this.up.uniforms.tSource.value = source.texture;
        (this.up.uniforms.uTexel.value as THREE.Vector2).set(1 / source.width, 1 / source.height);
        this.blit(this.up, this.bloomChain[i - 1], false);
      }
    }

    // --- god rays -----------------------------------------------------------
    // Only when the sun is genuinely in front of the camera and above the
    // horizon; shafts from a sun behind your head are a well-known giveaway
    // that an effect is screen-space.
    let rayTarget = 0;
    if (this.rayBudget) {
      this.sunNdc.copy(state.sunDirection).multiplyScalar(1000).add(camera.position);
      this.sunNdc.project(camera);
      const onScreen =
        this.sunNdc.z < 1 &&
        Math.abs(this.sunNdc.x) < 1.6 &&
        Math.abs(this.sunNdc.y) < 1.6;

      if (onScreen && state.sunDirection.y > 0.02) {
        // Strongest when the sun is low and the air is thick, which is exactly
        // when you see shafts through trees in the morning.
        const lowSun = 1 - clamp01(state.sunDirection.y / 0.55);
        const edge = 1 - clamp01((Math.max(Math.abs(this.sunNdc.x), Math.abs(this.sunNdc.y)) - 0.7) / 0.9);
        rayTarget = (0.35 + lowSun * 0.65) * edge * (0.55 + state.haze * 0.45) * (1 - state.night);
      }
    }
    this.raysVisible = damp(this.raysVisible, rayTarget, 2.5, dt);

    if (this.raysVisible > 0.002) {
      (this.godray.uniforms.uSun.value as THREE.Vector2).set(
        this.sunNdc.x * 0.5 + 0.5,
        this.sunNdc.y * 0.5 + 0.5
      );
      this.godray.uniforms.tSource.value = this.scene.texture;
      this.godray.uniforms.tDepth.value = this.scene.depthTexture;
      this.blit(this.godray, this.rays);
    } else {
      this.renderer.setRenderTarget(this.rays);
      this.renderer.clear(true, false, false);
    }
    this.composite.uniforms.uRayStrength.value = this.raysVisible * 0.5;

    // --- depth of field -----------------------------------------------------
    const wantDof = this.dofBudget && state.defocus > 0.002;
    if (wantDof) {
      // Focus on what the player is looking at unless told otherwise, and ease
      // it, because a focus that snaps between depths is seasick-making.
      const target = state.focusDistance > 0 ? state.focusDistance : 30;
      this.focus = damp(this.focus, target, 1.6, dt);

      this.dof.uniforms.tSource.value = this.scene.texture;
      this.dof.uniforms.tDepth.value = this.scene.depthTexture;
      (this.dof.uniforms.uTexel.value as THREE.Vector2).set(1 / this.blur.width, 1 / this.blur.height);
      this.dof.uniforms.uNear.value = camera.near;
      this.dof.uniforms.uFar.value = camera.far;
      this.dof.uniforms.uFocus.value = this.focus;
      this.dof.uniforms.uRange.value = lerp(140, 26, state.defocus);
      this.blit(this.dof, this.blur);
    }
    this.composite.uniforms.uDefocus.value = wantDof ? state.defocus : 0;

    // --- composite ----------------------------------------------------------
    const u = this.composite.uniforms;
    u.tScene.value = this.scene.texture;
    u.tBloom.value = this.bloomChain[0].texture;
    u.tRays.value = this.rays.texture;
    u.tBlur.value = wantDof ? this.blur.texture : this.scene.texture;
    u.uExposure.value = state.exposure;
    u.uVignette.value = 0.18 + state.vignette * 0.55;
    u.uTime.value = this.elapsed;

    this.blit(this.composite, null);

    renderer.autoClear = previousAutoClear;
    renderer.setRenderTarget(null);
  }

  dispose() {
    this.scene.dispose();
    this.scene.depthTexture?.dispose();
    this.rays.dispose();
    this.blur.dispose();
    for (const target of this.bloomChain) target.dispose();
    this.quad.geometry.dispose();
    for (const material of [this.bright, this.down, this.up, this.godray, this.dof, this.composite]) {
      material.dispose();
    }
  }
}
