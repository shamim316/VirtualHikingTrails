/**
 * The thing that ties the world to the person walking in it.
 *
 * The engine knows how to draw a wilderness and nothing else. This knows there
 * is somebody in it: what they can hear from where they are standing, what
 * they have noticed, whether they have sat down, and where all of that is
 * written when they close the tab.
 *
 * Update order matters and is deliberate. The world moves first, then we read
 * the ground under the player and hand it to the audio, then we ask what is
 * visible, and only then does the interface get told anything. Doing it the
 * other way round would show a discovery card for something you saw last frame.
 */

import { Engine } from '../core/engine';
import { Interface, type HudState } from '../ui/interface';
import { Soundscape, type SoundscapeState } from '../audio/soundscape';
import { DiscoveryTracker } from './discovery';
import { Modes, PHOTO_FILTERS, applyFilter } from './modes';
import { SPECIES } from './species';
import * as storage from '../core/storage';
import { createSample, type TerrainSample } from '../world/heightfield';
import type { QualityTier } from '../core/quality';
import { clamp01, damp, lerp } from '../world/noise';

/** How often the audio re-measures the ground and the water, in seconds. */
const TERRAIN_POLL = 0.25;
/** How often the walk is written to localStorage. */
const SAVE_INTERVAL = 8;

/** Photographs are kept small: two dozen of them share one localStorage quota. */
const PHOTO_WIDTH = 640;

export interface GameOptions {
  canvas: HTMLCanvasElement;
  seed: number;
  startHour?: number;
  tier?: QualityTier;
  debug?: boolean;
}

export class Game {
  readonly engine: Engine;
  readonly ui: Interface;
  readonly sound: Soundscape;
  readonly discovery: DiscoveryTracker;
  readonly modes = new Modes();

  private photos: storage.SavedPhoto[] = [];
  private photoFilter = 'plain';
  private baseDistance = 0;
  private sinceSave = 0;
  private sincePoll = TERRAIN_POLL;
  private sample: TerrainSample = createSample();
  private tierChoice: QualityTier | 'auto' = 'auto';
  private showDebug: boolean;
  private started = false;

  /** Metres to the nearest water and how lively it is; refreshed on a timer. */
  private waterDistance = Infinity;
  private waterEnergy = 0;

  private audioState: SoundscapeState = {
    exposure: 0, canopy: 0, waterDistance: Infinity, waterEnergy: 0, speed: 0,
    waterDepth: 0, surface: 'grass', hour: 8, wind: 0, gust: 0, rain: 0, altitude: 0,
  };

  private hud: HudState = {
    clock: '', weather: '', altitude: 0, distanceWalked: 0, worldName: '',
    xp: 0, discovered: 0, totalSpecies: SPECIES.length, compass: 0, fps: 0,
    showDebug: false, debug: '',
  };

  private scratchNormal = { x: 0, y: 1, z: 0 };

  constructor(opts: GameOptions) {
    this.showDebug = Boolean(opts.debug);

    const saved = storage.load();
    // A save from a different world keeps what you know but not where you were:
    // the species are the same everywhere, the places are not.
    const sameWorld = saved?.seed === (opts.seed >>> 0);

    this.engine = new Engine({
      canvas: opts.canvas,
      seed: opts.seed,
      startHour: opts.startHour ?? (sameWorld ? saved?.hour : undefined),
      tier: opts.tier,
    });

    this.discovery = new DiscoveryTracker(this.engine.terrain.field, this.engine.seed);
    this.sound = new Soundscape(`${import.meta.env.BASE_URL}assets`.replace(/\/{2,}/g, '/'));

    const isTouch = matchMedia('(hover: none) and (pointer: coarse)').matches;
    this.ui = new Interface(this.callbacks(), isTouch);

    this.restore(saved, sameWorld);
    this.bindInput();

    this.modes.onChange = (mode) => this.onModeChange(mode);
    this.discovery.onDiscovery = (d) => this.ui.showDiscovery(d);
    this.engine.onUpdate = (dt) => this.update(dt);

    // The procedural stand-in ground is already on screen; the real photoscans
    // replace it silently a second or two later.
    void this.engine
      .loadRealTextures(`${import.meta.env.BASE_URL}assets/textures`.replace(/\/{2,}/g, '/'), 1024)
      .catch(() => {
        // Keep walking on the procedural ground rather than failing to start.
      });

    this.engine.start();
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  private callbacks() {
    return {
      onStart: () => this.begin(),
      onToggleRest: () => this.modes.toggleRest(),
      onTogglePhoto: () => this.modes.togglePhoto(),
      onToggleJournal: () => this.toggleJournal(),
      onCapture: () => this.capture(),
      onFilterChange: (id: string) => { this.photoFilter = id; },
      onFocalChange: (mm: number) => this.modes.setFocal(mm),
      onVolumeChange: (v: number) => this.sound.setVolume(v),
      onMuteToggle: () => this.sound.setMuted(!this.sound.isMuted()),
      onTimeChange: (hour: number) => this.engine.weather.setHour(hour),
      onTimeRunningChange: (running: boolean) => { this.engine.weather.timeRunning = running; },
      onQualityChange: (tier: string) => this.setQuality(tier),
      onNewSeed: () => this.newSeed(),
      onPad: (x: number, y: number, active: boolean) => this.engine.input.setPad(x, y, active),
    };
  }

  private bindInput() {
    const input = this.engine.input;
    input.on('rest', () => this.modes.toggleRest());
    input.on('photo', () => this.modes.togglePhoto());
    input.on('journal', () => this.toggleJournal());
    input.on('capture', () => { if (this.modes.isPhoto) this.capture(); });
    input.on('help', () => { this.showDebug = !this.showDebug; });
    input.on('settings', () => this.ui.openSettings());
    input.on('escape', () => {
      if (this.ui.anyPanelOpen) {
        this.ui.closeAll();
        this.engine.input.enabled = true;
      } else if (this.modes.mode !== 'walking') {
        this.modes.set('walking');
      }
    });
  }

  /** The one gesture the browser needs before any of this can make a sound. */
  private begin() {
    if (this.started) return;
    this.started = true;
    void this.sound.start();
  }

  private restore(saved: storage.SaveData | null, sameWorld: boolean) {
    if (!saved) return;

    const discovered = sameWorld
      ? saved.discovered
      // Landmarks belong to a particular set of hills; species do not.
      : (saved.discovered ?? []).filter((d) => d.kind === 'species');

    this.discovery.restore({
      xp: saved.xp,
      distanceWalked: saved.distanceWalked,
      discovered,
    });
    this.baseDistance = saved.distanceWalked ?? 0;

    if (sameWorld && saved.position) {
      this.engine.player.placeAt(saved.position.x, saved.position.z, saved.position.yaw);
    }

    const settings = saved.settings;
    if (settings) {
      this.sound.setVolume(settings.volume ?? 0.8);
      this.sound.setMuted(Boolean(settings.muted));
      this.engine.weather.timeRunning = settings.timeRunning !== false;
      if (settings.tier) this.setQuality(settings.tier);
    }

    this.ui.syncSettings({
      volume: this.sound.getVolume(),
      muted: this.sound.isMuted(),
      tier: this.tierChoice,
    });

    this.photos = storage.loadPhotos();
  }

  // -------------------------------------------------------------------------
  // Modes
  // -------------------------------------------------------------------------

  private onModeChange(mode: 'walking' | 'resting' | 'photo') {
    const player = this.engine.player;
    // Resting takes both walking and looking; photo mode takes only the
    // walking, because framing a picture is all in where you point the camera.
    player.frozen = mode === 'resting';
    player.mobility = mode === 'walking' ? 1 : 0;
    this.sound.setRestMode(mode === 'resting');
    if (mode !== 'walking') {
      this.ui.closeAll();
      this.engine.input.enabled = true;
      this.engine.input.releasePointerLock();
    }
  }

  private toggleJournal() {
    this.ui.toggleJournal(this.discovery, this.photos);
    // Walking must not continue underneath an open panel — you would come back
    // to the world a hundred metres from where you left it.
    this.engine.input.enabled = !this.ui.anyPanelOpen;
    if (this.ui.anyPanelOpen) this.engine.input.releasePointerLock();
  }

  private setQuality(tier: string) {
    this.tierChoice = tier as QualityTier | 'auto';
    if (tier === 'auto') {
      this.engine.setAdaptiveEnabled(true);
    } else {
      this.engine.setAdaptiveEnabled(false);
      this.engine.applyTier(tier as QualityTier);
    }
  }

  private newSeed() {
    // A reload rather than a rebuild: every worker, cache and texture array in
    // the engine is keyed to the seed, and the browser tears all of that down
    // far more reliably than we can.
    this.persist();
    const seed = (Math.random() * 0xffffffff) >>> 0;
    location.search = `?seed=${seed}`;
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------

  private update(dt: number) {
    const engine = this.engine;
    const player = engine.player;
    const weather = engine.weather;

    this.modes.update(dt);
    const visuals = this.modes.visuals;

    // Field of view. Resting narrows very slightly — the visual equivalent of
    // your shoulders dropping — and photo mode maps the focal-length slider.
    const targetFov = 50 * visuals.fovScale;
    if (Math.abs(engine.camera.fov - targetFov) > 0.01) {
      engine.camera.fov = damp(engine.camera.fov, targetFov, 6, dt);
      engine.camera.updateProjectionMatrix();
    }

    // --- what is underfoot ---------------------------------------------------
    this.sincePoll -= dt;
    if (this.sincePoll <= 0) {
      this.sincePoll = TERRAIN_POLL;
      engine.terrain.field.sample(player.state.position.x, player.state.position.z, this.sample);
      this.findWater(player.state.position.x, player.state.position.z);
    }

    // --- audio ---------------------------------------------------------------
    const a = this.audioState;
    a.exposure = this.sample.exposure;
    a.canopy = this.sample.canopy;
    a.waterDistance = this.waterDistance;
    a.waterEnergy = this.waterEnergy;
    a.speed = player.state.speed;
    a.waterDepth = player.state.waterDepth;
    a.surface = this.surfaceUnderfoot();
    a.hour = weather.state.hour;
    a.wind = weather.state.wind;
    a.gust = weather.state.gust;
    a.rain = weather.state.rain;
    a.altitude = player.state.groundHeight;
    this.sound.update(a, dt);

    // --- what is visible -----------------------------------------------------
    if (!this.ui.anyPanelOpen) {
      this.discovery.update(
        engine.camera,
        dt,
        weather.state.hour,
        engine.vegetation.nearbyInstances(player.state.position.x, player.state.position.z, 55)
      );
    }

    this.discovery.progress.distanceWalked = this.baseDistance + player.state.distanceWalked;

    // --- interface -----------------------------------------------------------
    const hud = this.hud;
    hud.clock = weather.clockString();
    hud.weather = weather.describe();
    hud.worldName = engine.worldName;
    hud.altitude = player.state.groundHeight;
    hud.distanceWalked = this.discovery.progress.distanceWalked;
    hud.xp = this.discovery.progress.xp;
    hud.discovered = this.discovery.progress.discovered.filter((d) => d.kind === 'species').length;
    hud.compass = player.state.yaw;
    hud.fps = engine.stats.fps;
    hud.showDebug = this.showDebug;
    if (this.showDebug) hud.debug = this.debugText();

    this.ui.update(
      hud,
      this.modes.mode,
      visuals.uiFade,
      this.modes.breathingGuide ? visuals.breath : 0,
      this.modes.breathingGuide ? visuals.breathPhase : '',
      visuals.vignette
    );
    this.ui.syncClock(weather.state.hour);

    // --- saving --------------------------------------------------------------
    this.sinceSave += dt;
    if (this.sinceSave > SAVE_INTERVAL) {
      this.sinceSave = 0;
      this.persist();
    }
  }

  /**
   * Find the nearest water by sampling rings outward.
   *
   * Cheaper and more robust than tracking the stream network: the height field
   * already knows where the water is, and a few dozen samples four times a
   * second is nothing next to a frame of terrain. The rings are coarse on
   * purpose — a stream you can hear is one within earshot, not one whose exact
   * distance matters to a metre.
   */
  private findWater(x: number, z: number) {
    const field = this.engine.terrain.field;
    let nearest = Infinity;
    let energy = 0;

    for (const radius of [0, 7, 16, 28, 42, 58]) {
      const count = radius === 0 ? 1 : 8;
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2;
        const px = x + Math.cos(angle) * radius;
        const pz = z + Math.sin(angle) * radius;
        const ground = field.height(px, pz);
        if (field.waterHeight(px, pz) <= ground) continue;
        const distance = Math.hypot(px - x, pz - z);
        if (distance >= nearest) continue;
        nearest = distance;
        // Steep water is loud water: a tarn is nearly silent, a cascade is not.
        const normal = field.normal(px, pz, 1.4, this.scratchNormal);
        energy = clamp01((1 - normal.y) * 2.6);
      }
      // The rings go outward, so the first hit is already the nearest.
      if (nearest < Infinity) break;
    }

    this.waterDistance = nearest;
    this.waterEnergy = lerp(this.waterEnergy, energy, 0.4);
  }

  private surfaceUnderfoot(): SoundscapeState['surface'] {
    if (this.engine.player.state.waterDepth > 0.06) return 'water';
    const s = this.sample;
    if (s.snow > 0.5) return 'snow';
    if (s.rockiness > 0.55) return 'rock';
    if (s.canopy > 0.45) return 'litter';
    return 'grass';
  }

  private debugText(): string {
    const s = this.engine.stats;
    const p = this.engine.player.state;
    return [
      `${s.fps.toFixed(0)} fps  ${s.frameMs.toFixed(1)} ms  ${this.engine.settings.tier}`,
      `${s.drawCalls} calls  ${(s.triangles / 1e6).toFixed(2)}M tris`,
      `chunks ${s.chunks} (+${s.pending})  plants ${s.plants}  cells ${s.scatterCells}`,
      `x ${p.position.x.toFixed(0)} z ${p.position.z.toFixed(0)} y ${p.groundHeight.toFixed(0)}`,
      `water ${this.waterDistance === Infinity ? '—' : `${this.waterDistance.toFixed(0)}m`} ` +
        `energy ${this.waterEnergy.toFixed(2)}  clips ${this.sound.clipCount}`,
    ].join('\n');
  }

  // -------------------------------------------------------------------------
  // Photographs
  // -------------------------------------------------------------------------

  /**
   * Take the picture.
   *
   * The renderer keeps its drawing buffer, so the frame just drawn is still on
   * the canvas and can be read straight back — no second render, no flicker of
   * a different exposure. The filter is applied to the read-back pixels rather
   * than to the viewport, so what you framed is what you get.
   */
  capture() {
    const source = this.engine.renderer.domElement;
    const width = Math.min(PHOTO_WIDTH, source.width);
    const height = Math.round((width / source.width) * source.height);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(source, 0, 0, width, height);

    const filter = PHOTO_FILTERS.find((f) => f.id === this.photoFilter);
    if (filter && filter.id !== 'plain') {
      const image = ctx.getImageData(0, 0, width, height);
      applyFilter(image.data, filter);
      ctx.putImageData(image, 0, 0);
    }

    const photo: storage.SavedPhoto = {
      thumbnail: canvas.toDataURL('image/jpeg', 0.72),
      caption: `${this.engine.worldName} · ${this.engine.weather.clockString()} · ` +
        `${Math.round(this.engine.player.state.groundHeight)} m`,
      hour: this.engine.weather.state.hour,
      at: Date.now(),
      seed: this.engine.seed,
    };

    this.photos.push(photo);
    this.photos = storage.savePhotos(this.photos);

    this.ui.flash();
    this.ui.toast('Kept in the journal');
  }

  // -------------------------------------------------------------------------

  persist() {
    const player = this.engine.player.state;
    storage.save({
      seed: this.engine.seed,
      position: { x: player.position.x, z: player.position.z, yaw: player.yaw },
      hour: this.engine.weather.state.hour,
      season: this.engine.weather.state.season,
      xp: this.discovery.progress.xp,
      distanceWalked: this.discovery.progress.distanceWalked,
      discovered: this.discovery.progress.discovered,
      settings: {
        volume: this.sound.getVolume(),
        muted: this.sound.isMuted(),
        tier: this.tierChoice,
        adaptive: this.tierChoice === 'auto',
        timeRunning: this.engine.weather.timeRunning,
      },
    });
  }

  dispose() {
    this.persist();
    this.sound.dispose();
    this.engine.dispose();
  }
}
