/**
 * The game.
 *
 * Owns the renderer, the scene graph and the update order, and not much else —
 * the interesting behaviour lives in the systems it drives. Kept as a class so
 * that the whole world can be torn down and rebuilt when you change seed
 * without reloading the page.
 */

import * as THREE from 'three';
import { Input } from './input';
import { AdaptiveQuality, detectTier, settingsForTier, type QualitySettings, type QualityTier } from './quality';
import { PlayerController } from '../player/controller';
import { Sky } from '../render/sky';
import { createTerrainMaterial, type TerrainMaterial } from '../render/terrain-material';
import { createWaterMaterial, type WaterMaterial } from '../render/water-material';
import { createProceduralGround, loadGroundTextures, type GroundTextures } from '../render/textures';
import { Vegetation } from '../render/vegetation';
import { Post, type PostState } from '../render/post';
import { Terrain } from '../world/terrain';
import { Weather } from '../world/weather';
import { clamp01, damp, lerp } from '../world/noise';
import { worldNameFromSeed } from './rng';

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  seed: number;
  startHour?: number;
  tier?: QualityTier;
}

export interface FrameStats {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  chunks: number;
  pending: number;
  plants: number;
  scatterCells: number;
}

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly input: Input;
  readonly player: PlayerController;
  readonly terrain: Terrain;
  readonly vegetation: Vegetation;
  readonly sky: Sky;
  readonly weather: Weather;
  readonly post: Post;
  readonly seed: number;
  readonly worldName: string;

  settings: QualitySettings;
  readonly stats: FrameStats = {
    fps: 0, frameMs: 0, drawCalls: 0, triangles: 0, chunks: 0, pending: 0,
    plants: 0, scatterCells: 0,
  };

  /** Called once per frame after the world has updated, before rendering. */
  onUpdate: ((dt: number, elapsed: number) => void) | null = null;

  private terrainMaterial: TerrainMaterial;
  private waterMaterial: WaterMaterial;
  private groundTextures: GroundTextures;
  private adaptive: AdaptiveQuality;
  private clock = new THREE.Clock();
  private elapsed = 0;
  private running = false;
  private rafHandle = 0;
  private fpsAccumulator = 0;
  private fpsFrames = 0;
  private resizeObserver: ResizeObserver | null = null;
  private fogDensity = 0.00035;
  /** Exposure lives here rather than on the renderer: with post-processing on,
   *  the tonemap happens in the composite and the renderer never sees it. */
  private exposure = 1;
  private worldDrawCalls = 0;
  private worldTriangles = 0;

  /**
   * What the post chain needs from the world each frame. The caller fills in
   * the focus and defocus, which are the player's business rather than the
   * world's — resting and photographing are what soften a frame.
   */
  readonly postState: PostState = {
    sunDirection: new THREE.Vector3(0, 1, 0),
    night: 0,
    haze: 0,
    exposure: 1,
    focusDistance: 0,
    defocus: 0,
    vignette: 0,
  };

  constructor(opts: EngineOptions) {
    this.seed = opts.seed >>> 0;
    this.worldName = worldNameFromSeed(this.seed);

    this.renderer = new THREE.WebGLRenderer({
      canvas: opts.canvas,
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
      // Needed so photo mode can read pixels back after a render.
      preserveDrawingBuffer: true,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // AgX holds saturated colour together far better than ACES in skies, which
    // is exactly where this game spends its dynamic range.
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const tier = opts.tier ?? detectTier(this.renderer);
    this.settings = settingsForTier(tier);

    // three's `fov` is vertical. 50° gives roughly a 78° horizontal view at
    // 16:9 — wide enough to feel like standing somewhere, narrow enough that
    // near slopes don't balloon into the frame the way a 90° lens makes them.
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, this.settings.viewDistance * 1.6);
    this.camera.rotation.order = 'YXZ';

    this.post = new Post(this.renderer, this.settings);

    this.sky = new Sky(this.renderer);
    this.scene.add(this.sky.mesh);
    this.scene.add(this.sky.sunLight);
    this.scene.add(this.sky.sunLight.target);
    this.scene.add(this.sky.moonLight);
    this.scene.add(this.sky.moonLight.target);
    this.scene.add(this.sky.ambient);

    this.scene.fog = new THREE.FogExp2(0x9ab4cc, this.fogDensity);

    this.groundTextures = createProceduralGround(this.seed);
    this.terrainMaterial = createTerrainMaterial({ textures: this.groundTextures });
    this.waterMaterial = createWaterMaterial();

    this.weather = new Weather({ seed: this.seed, startHour: opts.startHour });

    this.terrain = new Terrain({
      seed: this.seed,
      workers: this.settings.workers,
      viewDistance: this.settings.viewDistance,
      groundMaterial: this.terrainMaterial,
      waterMaterial: this.waterMaterial,
    });
    this.scene.add(this.terrain.group);
    this.scene.add(this.terrain.waterGroup);

    this.vegetation = new Vegetation({
      seed: this.seed,
      workers: this.settings.workers,
      basePath: `${import.meta.env.BASE_URL}assets`.replace(/\/{2,}/g, '/'),
    });
    this.scene.add(this.vegetation.group);

    this.player = new PlayerController(this.terrain.field);
    const start = this.player.findStart(0, 0);
    this.player.placeAt(start.x, start.z, start.yaw);

    this.input = new Input(opts.canvas);

    this.adaptive = new AdaptiveQuality(
      () => this.settings.tier,
      (t) => this.applyTier(t)
    );

    this.configureShadows();
    this.handleResize();

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.handleResize());
      this.resizeObserver.observe(opts.canvas.parentElement ?? opts.canvas);
    }
    window.addEventListener('resize', this.handleResize);
    window.addEventListener('orientationchange', this.handleResize);
  }

  /** Swap in the real photoscanned ground once it has downloaded. */
  async loadRealTextures(basePath: string, resolution: number, onProgress?: (a: number, b: number) => void) {
    const textures = await loadGroundTextures(basePath, resolution, onProgress);
    const u = this.terrainMaterial.userData.uniforms;
    u.uAlbedoArray.value = textures.albedo;
    u.uNormalArray.value = textures.normal;
    u.uArmArray.value = textures.arm;
    u.uMacro.value = textures.macro;
    this.terrainMaterial.needsUpdate = true;

    // Release the procedural stand-ins.
    disposeGround(this.groundTextures);
    this.groundTextures = textures;
  }

  applyTier(tier: QualityTier) {
    if (tier === this.settings.tier) return;
    this.settings = settingsForTier(tier);
    this.camera.far = this.settings.viewDistance * 1.6;
    this.camera.updateProjectionMatrix();
    this.terrain.setViewDistance(this.settings.viewDistance);
    this.post.applySettings(this.settings);
    this.renderer.shadowMap.enabled = this.settings.shadows;
    this.configureShadows();
    this.handleResize();
  }

  setAdaptiveEnabled(on: boolean) {
    this.adaptive.setEnabled(on);
  }

  private configureShadows() {
    const light = this.sky.sunLight;
    light.castShadow = this.settings.shadows;
    const size = this.settings.shadowMapSize;
    light.shadow.mapSize.set(size, size);

    // A single tight cascade around the player. Everything that matters
    // visually — the trees you are standing among — is within 120m; beyond
    // that, shadow detail is invisible against aerial perspective anyway.
    const extent = 90;
    const cam = light.shadow.camera;
    cam.left = -extent;
    cam.right = extent;
    cam.top = extent;
    cam.bottom = -extent;
    cam.near = 1;
    cam.far = 1400;
    cam.updateProjectionMatrix();

    light.shadow.bias = -0.0006;
    light.shadow.normalBias = 0.55;
    light.shadow.blurSamples = 12;
    light.shadow.radius = 2.4;
  }

  private handleResize = () => {
    const canvas = this.renderer.domElement;
    const parent = canvas.parentElement;
    const width = parent?.clientWidth || window.innerWidth;
    const height = parent?.clientHeight || window.innerHeight;

    const pixelRatio = Math.min(window.devicePixelRatio || 1, this.settings.maxPixelRatio) * this.settings.renderScale;
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);

    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();

    this.post.setSize(width, height, pixelRatio);
  };

  start() {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    const loop = () => {
      if (!this.running) return;
      this.rafHandle = requestAnimationFrame(loop);
      this.frame();
    };
    this.rafHandle = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.rafHandle);
  }

  private frame() {
    const start = performance.now();
    // Clamp: a backgrounded tab shouldn't teleport the player or fast-forward
    // six hours of daylight the moment it returns.
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.elapsed += dt;

    this.weather.update(dt);

    const input = this.input.sample();
    const look = this.input.takeLook();
    this.player.update(input, look, dt, this.camera);

    this.sky.update(
      {
        hour: this.weather.state.hour,
        season: this.weather.state.season,
        overcast: this.weather.state.overcast,
        haze: this.weather.state.haze,
        wind: this.weather.state.wind,
        windDirection: this.weather.state.windDirection,
      },
      dt,
      this.renderer,
      this.scene
    );

    // The sky dome and the sun rig follow the camera so the world can be
    // walked forever without either drifting away.
    this.sky.mesh.position.copy(this.camera.position);
    const sun = this.sky.sunLight;
    sun.position.copy(this.camera.position).addScaledVector(this.sky.sunDirection, 500);
    sun.target.position.copy(this.camera.position);
    sun.target.updateMatrixWorld();
    const moon = this.sky.moonLight;
    moon.position.copy(this.camera.position).addScaledVector(this.sky.moonDirection, 500);
    moon.target.position.copy(this.camera.position);
    moon.target.updateMatrixWorld();

    this.updateAtmosphere(dt);
    this.terrain.update(this.camera);

    // Bake billboard atlases a couple at a time once the models are in. Doing
    // them all in one frame would stall for the better part of a second.
    if (this.vegetation.impostorsPending) this.vegetation.bakeImpostors(this.renderer, 2);
    this.vegetation.setLighting(
      this.sky.sunDirection,
      this.sky.sunLight.color,
      this.sky.ambient.color,
      this.sky.horizonColor,
      this.fogDensity
    );

    const wind = this.weather.state;
    this.vegetation.update(this.camera, this.settings, dt, this.elapsed, {
      x: Math.cos(wind.windDirection),
      z: Math.sin(wind.windDirection),
      gust: wind.gust * (0.35 + wind.wind),
    });

    const u = this.waterMaterial.userData.uniforms;
    u.uTime.value = this.elapsed;
    u.uSunDir.value.copy(this.sky.sunDirection);
    u.uRainRipples.value = this.weather.state.rain;
    this.terrainMaterial.userData.uniforms.uWetness.value = this.weather.state.wetness;
    this.terrainMaterial.userData.uniforms.uTime.value = this.elapsed;

    this.onUpdate?.(dt, this.elapsed);

    // --- render --------------------------------------------------------------
    // With the post chain on, the world is rendered with tone mapping *off*
    // into a half-float target so that bloom and light shafts see real
    // radiances; AgX is applied once at the end of the composite. Without it,
    // the renderer tone maps as it always did.
    if (this.post.enabled) {
      const state = this.postState;
      state.sunDirection.copy(this.sky.sunDirection);
      state.night = this.sky.night;
      state.haze = this.weather.state.haze;
      state.exposure = this.exposure;

      this.renderer.toneMapping = THREE.NoToneMapping;
      this.renderer.toneMappingExposure = 1;
      this.renderer.setRenderTarget(this.post.renderTarget);
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);
      this.worldDrawCalls = this.renderer.info.render.calls;
      this.worldTriangles = this.renderer.info.render.triangles;
      this.post.render(this.camera, state, dt);
    } else {
      this.renderer.toneMapping = THREE.AgXToneMapping;
      this.renderer.toneMappingExposure = this.exposure;
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
      this.worldDrawCalls = this.renderer.info.render.calls;
      this.worldTriangles = this.renderer.info.render.triangles;
    }

    // --- stats ---------------------------------------------------------------
    // Captured from the world render, not from whatever ran last: with the post
    // chain on, the final call is a fullscreen quad and the readout would say
    // the game draws one triangle.
    this.stats.drawCalls = this.worldDrawCalls;
    this.stats.triangles = this.worldTriangles;
    this.stats.chunks = this.terrain.chunkCount;
    this.stats.pending = this.terrain.pendingCount;
    this.stats.plants = this.vegetation.instanceCount;
    this.stats.scatterCells = this.vegetation.loadedCells;
    this.stats.frameMs = performance.now() - start;

    this.fpsAccumulator += dt;
    this.fpsFrames++;
    if (this.fpsAccumulator >= 0.5) {
      this.stats.fps = this.fpsFrames / this.fpsAccumulator;
      this.fpsAccumulator = 0;
      this.fpsFrames = 0;
    }

    this.adaptive.update(dt, this.elapsed);
  }

  /**
   * Fog and exposure.
   *
   * Fog colour tracks the sky's horizon so distant ridges always sit in air of
   * the right colour, and density rises with mist and rain. Exposure eases
   * rather than jumping, which is what stops walking out of a dark wood into
   * a sunlit meadow from being a white flash.
   */
  private updateAtmosphere(dt: number) {
    const w = this.weather.state;
    const fog = this.scene.fog as THREE.FogExp2 | null;
    if (fog) fog.color.copy(this.sky.horizonColor);
    // Clear air really does let you see thirty kilometres. The old floor of
    // 0.00022 put a 1.5km ridge at 86% fogged on a fine day, which flattened
    // every distant mountain to a pale silhouette and threw away the one view
    // a hiking game exists for.
    const targetDensity = lerp(0.00010, 0.0015, clamp01(w.haze)) + w.rain * 0.0007;
    // Scale with view distance so the horizon fades at the same visual point
    // regardless of quality tier.
    const scaled = targetDensity * (3200 / this.settings.viewDistance);
    this.fogDensity = damp(this.fogDensity, scaled, 0.6, dt);
    if (fog) fog.density = this.fogDensity;

    const night = this.sky.night;
    // Open up at night, but not so far that it stops reading as night.
    // Night opens up a long way. A moonlit wood really is this dark, but the
    // point of the game is to walk in it, and squinting is not restful.
    const targetExposure = lerp(0.22, 1.25, night) * lerp(1, 0.86, w.overcast);
    this.exposure = damp(this.exposure, targetExposure, 1.2, dt);
  }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this.handleResize);
    window.removeEventListener('orientationchange', this.handleResize);
    this.resizeObserver?.disconnect();
    this.input.dispose();
    this.post.dispose();
    this.vegetation.dispose();
    this.terrain.dispose();
    this.sky.dispose();
    this.terrainMaterial.dispose();
    this.waterMaterial.dispose();
    disposeGround(this.groundTextures);
    this.renderer.dispose();
  }
}

function disposeGround(textures: GroundTextures) {
  textures.albedo.dispose();
  textures.normal.dispose();
  textures.arm.dispose();
  textures.macro.dispose();
}
