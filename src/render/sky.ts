/**
 * Sky, sun, moon and the light they cast.
 *
 * The sky is a single-scattering atmosphere (Rayleigh + Mie, in the Preetham
 * form) evaluated per pixel on an inward-facing dome, extended with a night
 * hemisphere carrying stars and a moon. It is rendered in linear HDR and left
 * for the tonemapper, which is what lets dawn actually blow out along the
 * horizon instead of clipping to a flat orange band.
 *
 * The same dome is periodically captured into a prefiltered environment map,
 * so the ambient light on every surface in the world comes from the sky
 * overhead rather than from a constant. That single detail is most of why the
 * world changes character through the day: blue and directionless before
 * sunrise, warm and raking at golden hour, silver and dim under moonlight.
 */

import * as THREE from 'three';
import { clamp01, lerp, smoothstep } from '../world/noise';

const SKY_VERT = /* glsl */ `
varying vec3 vRayDir;

void main() {
  // The dome is drawn at unit scale and pushed to the far plane in the
  // fragment stage, so the ray direction is just the vertex position.
  vRayDir = position;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_Position.z = gl_Position.w;
}
`;

const SKY_FRAG = /* glsl */ `
precision highp float;

varying vec3 vRayDir;

uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform float uTurbidity;
uniform float uRayleigh;
uniform float uMieCoefficient;
uniform float uMieG;
uniform float uExposure;
uniform float uNight;        // 0 = full day, 1 = full night
uniform float uMoonPhase;    // 0 = new, 1 = full
uniform float uStarFade;
uniform vec3 uGroundColor;
uniform float uHaze;

const float PI = 3.141592653589793;
const vec3 UP = vec3(0.0, 1.0, 0.0);

// Rayleigh scattering at sea level for 680/550/450nm.
const vec3 TOTAL_RAYLEIGH = vec3(5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5);
const vec3 MIE_CONST = vec3(1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14);

const float RAYLEIGH_ZENITH = 8.4e3;
const float MIE_ZENITH = 1.25e3;
const float SUN_ANGULAR_DIAMETER_COS = 0.999956676946448;
const float MOON_ANGULAR_DIAMETER_COS = 0.99995;

float rayleighPhase(float cosTheta) {
  return (3.0 / (16.0 * PI)) * (1.0 + cosTheta * cosTheta);
}

float henyeyGreenstein(float cosTheta, float g) {
  float g2 = g * g;
  float denom = max(1.0 - 2.0 * g * cosTheta + g2, 1e-4);
  return (1.0 / (4.0 * PI)) * ((1.0 - g2) / pow(denom, 1.5));
}

vec3 totalMie(float turbidity) {
  float c = 0.2 * turbidity * 1.0e-18;
  return 0.434 * c * MIE_CONST;
}

// Cheap value-noise hash, used only for stars.
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

// Stars are point samples on a coarse direction grid: one candidate per cell,
// most of them too dim to see, which gives a believable magnitude spread
// without a texture.
float starField(vec3 dir) {
  vec3 grid = dir * 260.0;
  vec3 cell = floor(grid);
  vec3 local = fract(grid) - 0.5;

  float r = hash13(cell);
  if (r < 0.972) return 0.0;

  vec2 offset = vec2(hash13(cell + 11.0), hash13(cell + 23.0)) - 0.5;
  float d = length(local.xy - offset * 0.6);
  float brightness = pow(fract(r * 91.7), 6.0);
  float star = smoothstep(0.09, 0.0, d) * brightness;

  // A slight colour spread between hot blue and cool orange stars.
  return star;
}

vec3 starColor(vec3 dir) {
  float t = hash13(floor(dir * 260.0) + 7.0);
  return mix(vec3(1.0, 0.86, 0.72), vec3(0.76, 0.85, 1.0), t);
}

void main() {
  vec3 dir = normalize(vRayDir);
  float up = dir.y;

  // --- daytime atmosphere ---------------------------------------------------
  float sunE = max(0.0, dot(UP, uSunDir));
  float sunfade = 1.0 - clamp(1.0 - exp(uSunDir.y * 4.0), 0.0, 1.0);

  vec3 betaR = TOTAL_RAYLEIGH * (uRayleigh * (1.0 - sunfade * 0.35));
  vec3 betaM = totalMie(uTurbidity) * uMieCoefficient;

  // Optical depth along the view ray, with the standard grazing-angle fit so
  // the horizon doesn't go singular.
  float zenithAngle = acos(max(0.0, up));
  float denom = cos(zenithAngle) + 0.15 * pow(max(93.885 - (zenithAngle * 180.0 / PI), 1e-3), -1.253);
  float inverseDenom = 1.0 / max(denom, 1e-4);
  float sR = RAYLEIGH_ZENITH * inverseDenom;
  float sM = MIE_ZENITH * inverseDenom * (1.0 + uHaze * 2.5);

  vec3 extinction = exp(-(betaR * sR + betaM * sM));

  float cosTheta = dot(dir, uSunDir);
  vec3 betaRTheta = betaR * rayleighPhase(cosTheta);
  vec3 betaMTheta = betaM * henyeyGreenstein(cosTheta, uMieG);

  float sunIntensity = 1000.0 * max(0.0, 1.0 - exp(-((1.6110731556870734 - acos(clamp(uSunDir.y, -1.0, 1.0))) / 1.5)));

  vec3 scatter = (betaRTheta + betaMTheta) / max(betaR + betaM, vec3(1e-9));
  // The exponent is the classic Preetham 1.5. Softened here, because at 1.5
  // the horizon runs about eight times the zenith and blows out to a white
  // band across a third of the sky once you expose for the land.
  vec3 inscatter = pow(sunIntensity * scatter * (1.0 - extinction), vec3(1.18));
  inscatter *= mix(
    vec3(1.0),
    pow(sunIntensity * scatter * extinction, vec3(0.5)),
    clamp(pow(1.0 - dot(UP, uSunDir), 5.0), 0.0, 1.0)
  );

  // Sun disc, with a soft limb so it doesn't alias into a hard dot.
  //
  // The magnitude here matters more than it looks. This dome is captured into
  // a half-float environment map, and the classic Preetham disc value (~19000
  // scaled by the solar constant) overflows half-float range; the prefilter
  // blur then smears that infinity into NaN across the entire map and every
  // lit surface in the world renders black. Kept well inside range, the disc
  // is still far brighter than the sky around it and clips to white through
  // the tonemapper exactly as it should.
  float sunDisc = smoothstep(SUN_ANGULAR_DIAMETER_COS, SUN_ANGULAR_DIAMETER_COS + 2.0e-5, cosTheta);
  vec3 direct = sunIntensity * 260.0 * extinction * sunDisc;

  vec3 day = (inscatter + direct) * 0.04;

  // --- night ----------------------------------------------------------------
  float moonCos = dot(dir, uMoonDir);
  float moonDisc = smoothstep(MOON_ANGULAR_DIAMETER_COS, MOON_ANGULAR_DIAMETER_COS + 3.0e-5, moonCos);
  float moonGlow = pow(max(0.0, moonCos), 900.0) * 0.35 + pow(max(0.0, moonCos), 12.0) * 0.02;

  vec3 nightZenith = vec3(0.0035, 0.0062, 0.0155);
  vec3 nightHorizon = vec3(0.011, 0.016, 0.030);
  vec3 night = mix(nightHorizon, nightZenith, clamp(up * 1.4, 0.0, 1.0));

  float stars = starField(dir) * uStarFade * smoothstep(-0.02, 0.18, up);
  night += starColor(dir) * stars * 1.4;
  night += vec3(0.85, 0.87, 0.95) * (moonDisc * 3.2 + moonGlow) * (0.25 + uMoonPhase * 0.75);
  // Airglow near the horizon; even a dark sky is never truly black down low.
  night += nightHorizon * 0.7 * pow(clamp(1.0 - abs(up) * 3.0, 0.0, 1.0), 2.0);

  vec3 color = mix(day, night, uNight);

  // --- below the horizon ----------------------------------------------------
  // Past the last loaded terrain you are looking at the underside of the dome,
  // so this has to read as distant hazy land rather than as a hole. Start from
  // the sky's own colour at the horizon, tint it earthward, and let it fall off
  // slowly — the same thing aerial perspective does to a far-off valley floor.
  float groundBlend = smoothstep(0.0, -0.16, up);
  vec3 horizonHaze = color;
  vec3 ground = mix(horizonHaze, horizonHaze * uGroundColor * 3.0, 0.7) * mix(0.5, 0.28, uNight);
  color = mix(color, ground, groundBlend);

  // Single-scattering Preetham has no way to lose light on the way to the eye,
  // so the horizon accumulates roughly eight times the zenith's radiance and
  // clips to a flat white band across a third of the sky. A gentle Reinhard
  // shoulder compresses the top end without touching the blue overhead, which
  // is much closer to what multiple scattering does in the real atmosphere.
  // Applied before the environment capture so the light on the land agrees
  // with the sky you can see.
  color = color / (1.0 + color * 0.12);

  // Belt and braces for the environment capture: no negatives, no infinities,
  // and a ceiling comfortably inside half-float range.
  color = clamp(color * uExposure, vec3(0.0), vec3(3000.0));

  gl_FragColor = vec4(color, 1.0);
}
`;

export interface SkyState {
  /** Hours since midnight, 0..24. */
  hour: number;
  /** 0..1 through the year; shifts the sun's arc and the day's length. */
  season: number;
  /** 0 = clear, 1 = fully overcast. */
  overcast: number;
  /** Extra atmospheric haze, raised by mist and rain. */
  haze: number;
}

export class Sky {
  readonly mesh: THREE.Mesh;
  readonly sunLight: THREE.DirectionalLight;
  readonly moonLight: THREE.DirectionalLight;
  readonly ambient: THREE.HemisphereLight;

  readonly sunDirection = new THREE.Vector3(0, 1, 0);
  readonly moonDirection = new THREE.Vector3(0, -1, 0);
  /** 0 in full daylight, 1 in full night. */
  night = 0;
  /** Colour of the light at the horizon, used for fog. */
  readonly horizonColor = new THREE.Color();
  readonly zenithColor = new THREE.Color();

  private material: THREE.ShaderMaterial;
  private pmrem: THREE.PMREMGenerator;
  private envRenderTarget: THREE.WebGLRenderTarget | null = null;
  private envScene = new THREE.Scene();
  private envAccumulator = 0;
  private lastEnvNight = -1;

  constructor(renderer: THREE.WebGLRenderer) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      fog: false,
      toneMapped: false,
      uniforms: {
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
        uTurbidity: { value: 2.6 },
        uRayleigh: { value: 1.8 },
        uMieCoefficient: { value: 0.005 },
        uMieG: { value: 0.8 },
        uExposure: { value: 1.0 },
        uNight: { value: 0 },
        uMoonPhase: { value: 0.85 },
        uStarFade: { value: 0 },
        uGroundColor: { value: new THREE.Color(0.16, 0.15, 0.12) },
        uHaze: { value: 0 },
      },
    });

    // A modest icosphere is plenty: all the structure is in the shader.
    this.mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 4), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.name = 'sky';

    this.sunLight = new THREE.DirectionalLight(0xffffff, 3);
    this.sunLight.name = 'sun';
    this.sunLight.castShadow = true;

    this.moonLight = new THREE.DirectionalLight(0xaec4ff, 0);
    this.moonLight.name = 'moon';
    this.moonLight.castShadow = false;

    this.ambient = new THREE.HemisphereLight(0x9fb8d8, 0x4a4030, 0.35);

    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();
    this.envScene.add(new THREE.Mesh(this.mesh.geometry, this.material));
  }

  /**
   * Solar position.
   *
   * A deliberately simple model — a tilted circular arc rather than real
   * ephemerides. What matters here is that the sun rises in the east, crosses
   * at a believable height for the season, sets in the west, and spends a
   * plausible amount of time near the horizon, since that's where all the good
   * light is.
   */
  update(state: SkyState, dt: number, renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
    const dayAngle = ((state.hour - 12) / 24) * Math.PI * 2;
    // Axial tilt: high summer sun, low winter sun.
    const declination = Math.sin(state.season * Math.PI * 2) * 0.41;
    const latitude = 0.82; // ~47°N, good mountain light

    const sinAlt =
      Math.sin(latitude) * Math.sin(declination) +
      Math.cos(latitude) * Math.cos(declination) * Math.cos(dayAngle);
    const altitude = Math.asin(clamp01(sinAlt * 0.5 + 0.5) * 2 - 1);

    const cosAz =
      (Math.sin(declination) - Math.sin(altitude) * Math.sin(latitude)) /
      (Math.cos(altitude) * Math.cos(latitude) || 1e-4);
    let azimuth = Math.acos(Math.max(-1, Math.min(1, cosAz)));
    if (Math.sin(dayAngle) > 0) azimuth = Math.PI * 2 - azimuth;

    this.sunDirection.set(
      Math.sin(azimuth) * Math.cos(altitude),
      Math.sin(altitude),
      Math.cos(azimuth) * Math.cos(altitude)
    ).normalize();

    // The moon rides opposite the sun, offset so it isn't a perfect mirror.
    this.moonDirection.copy(this.sunDirection).multiplyScalar(-1);
    this.moonDirection.applyAxisAngle(new THREE.Vector3(0, 0, 1), 0.35).normalize();

    // Night ramps across civil twilight rather than snapping at the horizon.
    this.night = 1 - smoothstep(-0.13, 0.06, this.sunDirection.y);

    const u = this.material.uniforms;
    u.uSunDir.value.copy(this.sunDirection);
    u.uMoonDir.value.copy(this.moonDirection);
    u.uNight.value = this.night;
    u.uStarFade.value = smoothstep(0.25, 0.9, this.night);
    u.uHaze.value = state.haze;
    // Overcast: more particles, less directional structure, flatter light.
    u.uTurbidity.value = lerp(2.2, 9.0, state.overcast) + state.haze * 3;
    u.uRayleigh.value = lerp(1.45, 0.5, state.overcast);
    u.uMieCoefficient.value = lerp(0.004, 0.021, state.overcast);
    u.uMieG.value = lerp(0.81, 0.72, state.overcast);

    this.updateLights(state);
    this.updateEnvironment(dt, renderer, scene, state);
  }

  private updateLights(state: SkyState) {
    const elevation = this.sunDirection.y;

    // Sunlight reddens and weakens as it grazes more atmosphere. These are
    // hand-tuned rather than derived, chosen so that golden hour is genuinely
    // golden without the midday sun turning yellow.
    const horizonMix = clamp01(1 - smoothstep(-0.02, 0.35, elevation));
    const sunColor = new THREE.Color(1, 1, 1).lerp(new THREE.Color(1.0, 0.42, 0.16), horizonMix * 0.92);

    const daylight = clamp01(smoothstep(-0.09, 0.12, elevation));
    const cloudDim = lerp(1, 0.42, state.overcast);

    this.sunLight.color.copy(sunColor);
    this.sunLight.intensity = daylight * 5.0 * cloudDim;
    this.sunLight.position.copy(this.sunDirection).multiplyScalar(600);

    const moonUp = clamp01(smoothstep(-0.05, 0.2, this.moonDirection.y));
    this.moonLight.intensity = moonUp * this.night * 0.8 * cloudDim;
    this.moonLight.position.copy(this.moonDirection).multiplyScalar(600);

    // Ambient sky/ground bounce. Kept deliberately low: the environment map
    // carries nearly all of the indirect light, and this only exists as a floor
    // so that deep shade never goes flat black.
    const ambientStrength = lerp(0.11, 0.2, daylight) * lerp(1, 1.5, state.overcast);
    this.ambient.intensity = ambientStrength;
    this.ambient.color.setRGB(
      lerp(0.10, 0.62, daylight),
      lerp(0.13, 0.72, daylight),
      lerp(0.24, 0.95, daylight)
    );
    this.ambient.groundColor.setRGB(
      lerp(0.03, 0.30, daylight),
      lerp(0.03, 0.26, daylight),
      lerp(0.05, 0.18, daylight)
    );

    // Fog and horizon tint follow the sky itself so distant ridges always sit
    // in air of the right colour.
    this.horizonColor.setRGB(
      lerp(0.035, 0.62, daylight) + horizonMix * daylight * 0.30,
      lerp(0.045, 0.70, daylight) + horizonMix * daylight * 0.10,
      lerp(0.075, 0.86, daylight)
    );
    this.zenithColor.setRGB(
      lerp(0.012, 0.24, daylight),
      lerp(0.018, 0.42, daylight),
      lerp(0.040, 0.78, daylight)
    );
    if (state.overcast > 0) {
      const grey = new THREE.Color(0.52, 0.55, 0.60).multiplyScalar(lerp(0.12, 1, daylight));
      this.horizonColor.lerp(grey, state.overcast * 0.8);
      this.zenithColor.lerp(grey, state.overcast * 0.85);
    }
  }

  /**
   * Re-capture the sky into a prefiltered environment map.
   *
   * This is the expensive part of the sky, so it runs on a timer rather than
   * every frame, and only when the light has actually moved enough to matter.
   */
  private updateEnvironment(dt: number, renderer: THREE.WebGLRenderer, scene: THREE.Scene, state: SkyState) {
    this.envAccumulator += dt;
    const changed = Math.abs(this.night - this.lastEnvNight) > 0.004;
    if (this.envRenderTarget && this.envAccumulator < 0.75 && !changed) return;

    this.envAccumulator = 0;
    this.lastEnvNight = this.night;

    const previous = this.envRenderTarget;
    // fromScene renders the dome into a cube and prefilters it. The near/far
    // just need to bracket the unit sphere.
    this.envRenderTarget = this.pmrem.fromScene(this.envScene, 0, 0.1, 100);
    scene.environment = this.envRenderTarget.texture;
    // The dome is genuinely bright in linear terms, so this multiplier is the
    // main calibration knob for how strongly the sky lights the land.
    scene.environmentIntensity = lerp(0.34, 0.75, clamp01(1 - this.night)) * lerp(1, 1.3, state.overcast);
    previous?.dispose();

    void renderer;
  }

  dispose() {
    this.material.dispose();
    this.mesh.geometry.dispose();
    this.envRenderTarget?.dispose();
    this.pmrem.dispose();
  }
}
