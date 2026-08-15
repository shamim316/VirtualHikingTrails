/**
 * The soundscape.
 *
 * Half of this is synthesised and half is recorded, split along a simple line:
 * anything that has to *react* is synthesised, anything that has to be a
 * specific creature is a recording.
 *
 * Wind, leaves and water are continuous and must respond to where you are —
 * the wind rises as you climb onto an exposed ridge, the canopy hiss comes up
 * as you walk into trees, a stream swells as you approach it and falls away
 * behind you. No recording can do that; a loop would give itself away in
 * seconds. So they are filtered noise, shaped in real time by the same terrain
 * sample the renderer uses.
 *
 * Birds are the opposite. A blackbird is a very specific sound and synthesis
 * makes a poor job of it, so those are real recordings from Wikimedia Commons,
 * fired as spatialised one-shots from points around you, with the dawn chorus
 * thickening at first light and owls taking over after dark.
 *
 * Everything hangs off a gentle compressor and a convolution reverb whose
 * impulse response is generated rather than recorded — a short, dark, diffuse
 * tail that makes the woods feel enclosed without sounding like a room.
 */

import { Rng } from '../core/rng';
import { clamp01, damp, lerp, smoothstep } from '../world/noise';

/** What the world tells the soundscape each frame. */
export interface SoundscapeState {
  /** 0..1, how exposed to wind this spot is. */
  exposure: number;
  /** 0..1, canopy overhead. */
  canopy: number;
  /** Metres to the nearest water, or Infinity. */
  waterDistance: number;
  /** 0..1, how fast that water is moving — a cascade versus a still tarn. */
  waterEnergy: number;
  /** Player speed over the ground, m/s. */
  speed: number;
  /** How deep the player is wading. */
  waterDepth: number;
  /** Surface underfoot, for footstep colour. */
  surface: 'litter' | 'grass' | 'rock' | 'snow' | 'water';
  /** Hours since midnight. */
  hour: number;
  /** 0..1 overall wind strength, and its gust envelope. */
  wind: number;
  gust: number;
  /** 0..1 rain. */
  rain: number;
  /** Height above sea level, for thinning the bird life high up. */
  altitude: number;
}

interface BirdClip {
  id: string;
  role: 'dawn' | 'day' | 'high' | 'night';
  buffer: AudioBuffer;
}

const CLIP_MANIFEST: Array<{ file: string; id: string; role: BirdClip['role'] }> = [
  { file: 'chaffinch_0.mp3', id: 'chaffinch', role: 'day' },
  { file: 'chaffinch_1.mp3', id: 'chaffinch', role: 'day' },
  { file: 'blackbird_0.ogg', id: 'blackbird', role: 'dawn' },
  { file: 'blackbird_1.mp3', id: 'blackbird', role: 'dawn' },
  { file: 'robin_0.mp3', id: 'robin', role: 'dawn' },
  { file: 'robin_1.mp3', id: 'robin', role: 'dawn' },
  { file: 'wren_0.ogg', id: 'wren', role: 'day' },
  { file: 'wren_1.mp3', id: 'wren', role: 'day' },
  { file: 'greattit_0.mp3', id: 'greattit', role: 'day' },
  { file: 'greattit_1.mp3', id: 'greattit', role: 'day' },
  { file: 'blackcap_0.mp3', id: 'blackcap', role: 'day' },
  { file: 'songthrush_0.mp3', id: 'songthrush', role: 'dawn' },
  { file: 'cuckoo_0.ogg', id: 'cuckoo', role: 'day' },
  { file: 'raven_0.ogg', id: 'raven', role: 'high' },
  { file: 'buzzard_0.ogg', id: 'buzzard', role: 'high' },
  { file: 'owl_0.mp3', id: 'owl', role: 'night' },
  { file: 'owl_1.mp3', id: 'owl', role: 'night' },
  { file: 'woodpecker_0.ogg', id: 'woodpecker', role: 'day' },
];

export class Soundscape {
  /** Nothing can start until the browser has seen a gesture. */
  started = false;
  /** Master volume, 0..1. */
  private volume = 0.8;
  private muted = false;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private wetBus: GainNode | null = null;
  private dryBus: GainNode | null = null;

  // --- synthesised layers ---------------------------------------------------
  private windLow: BiquadFilterNode | null = null;
  private windHigh: BiquadFilterNode | null = null;
  private windGain: GainNode | null = null;
  private leafFilter: BiquadFilterNode | null = null;
  private leafGain: GainNode | null = null;
  private waterFilter: BiquadFilterNode | null = null;
  private waterGain: GainNode | null = null;
  private waterResonance: BiquadFilterNode | null = null;
  private rainGain: GainNode | null = null;
  private rainFilter: BiquadFilterNode | null = null;

  private noiseBuffer: AudioBuffer | null = null;

  // --- birds ----------------------------------------------------------------
  private clips: BirdClip[] = [];
  private birdBus: GainNode | null = null;
  private nextBirdIn = 3;
  private rng = new Rng(0x5eed);

  // --- footsteps ------------------------------------------------------------
  private strideProgress = 0;
  private footBus: GainNode | null = null;

  private smoothed = {
    wind: 0, leaves: 0, water: 0, waterTone: 0, rain: 0,
  };

  constructor(private basePath: string) {}

  /**
   * Build the graph. Must be called from a user gesture — every browser
   * refuses to start audio otherwise, and rightly so.
   */
  async start(): Promise<void> {
    if (this.started) return;

    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;

    const ctx = new Ctor();
    this.ctx = ctx;
    if (ctx.state === 'suspended') await ctx.resume();

    // --- master chain -------------------------------------------------------
    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : this.volume;
    // A gentle limiter. Nothing here should ever be loud, but a waterfall and
    // a gust and a close bird can stack up.
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 24;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.02;
    compressor.release.value = 0.3;
    master.connect(compressor).connect(ctx.destination);
    this.master = master;

    const reverb = ctx.createConvolver();
    reverb.buffer = this.makeForestImpulse(ctx);
    const wet = ctx.createGain();
    wet.gain.value = 0.22;
    const dry = ctx.createGain();
    dry.gain.value = 1;
    dry.connect(master);
    wet.connect(reverb).connect(master);
    this.dryBus = dry;
    this.wetBus = wet;

    this.noiseBuffer = this.makeNoise(ctx, 4);

    this.buildWind(ctx);
    this.buildWater(ctx);
    this.buildRain(ctx);

    this.birdBus = ctx.createGain();
    this.birdBus.gain.value = 0.9;
    this.birdBus.connect(dry);
    this.birdBus.connect(wet);

    this.footBus = ctx.createGain();
    this.footBus.gain.value = 0.5;
    this.footBus.connect(dry);

    this.started = true;

    // Recordings load in the background; the synthesised world is already
    // audible, so there is nothing to wait for.
    void this.loadClips();
  }

  /** A short, dark, diffuse tail — woodland, not a concert hall. */
  private makeForestImpulse(ctx: AudioContext): AudioBuffer {
    const seconds = 1.8;
    const length = Math.floor(ctx.sampleRate * seconds);
    const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = impulse.getChannelData(channel);
      let lowpass = 0;
      for (let i = 0; i < length; i++) {
        const t = i / length;
        // Exponential decay, plus an early build so it doesn't sound like a
        // gunshot in a pipe.
        const envelope = Math.pow(1 - t, 3.2) * smoothstep(0, 0.02, t);
        const white = Math.random() * 2 - 1;
        // One-pole lowpass: foliage absorbs the top end fast, which is most of
        // why a wood sounds like a wood.
        lowpass += (white - lowpass) * 0.22;
        data[i] = lowpass * envelope;
      }
    }
    return impulse;
  }

  /** A few seconds of looping white noise, the source for every synth layer. */
  private makeNoise(ctx: AudioContext, seconds: number): AudioBuffer {
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    // Taper the ends into each other so the loop point is inaudible.
    const fade = Math.floor(ctx.sampleRate * 0.05);
    for (let i = 0; i < fade; i++) {
      const k = i / fade;
      data[i] *= k;
      data[length - 1 - i] *= k;
    }
    return buffer;
  }

  private loopNoise(ctx: AudioContext): AudioBufferSourceNode {
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;
    source.start();
    return source;
  }

  /**
   * Wind is two bands: a low body that you feel more than hear, and a bright
   * hiss that only really appears when there are leaves to make it.
   */
  private buildWind(ctx: AudioContext) {
    const gain = ctx.createGain();
    gain.gain.value = 0;

    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 320;
    low.Q.value = 0.7;

    const high = ctx.createBiquadFilter();
    high.type = 'bandpass';
    high.frequency.value = 900;
    high.Q.value = 0.5;

    this.loopNoise(ctx).connect(low).connect(gain);
    this.loopNoise(ctx).connect(high).connect(gain);
    gain.connect(this.dryBus!);
    gain.connect(this.wetBus!);

    this.windLow = low;
    this.windHigh = high;
    this.windGain = gain;

    // Leaf rustle: a separate, brighter band gated by canopy density, so the
    // hiss follows the trees rather than the weather.
    const leafGain = ctx.createGain();
    leafGain.gain.value = 0;
    const leaf = ctx.createBiquadFilter();
    leaf.type = 'bandpass';
    leaf.frequency.value = 3200;
    leaf.Q.value = 0.6;
    this.loopNoise(ctx).connect(leaf).connect(leafGain);
    leafGain.connect(this.dryBus!);
    leafGain.connect(this.wetBus!);
    this.leafFilter = leaf;
    this.leafGain = leafGain;
  }

  /**
   * Water: broadband noise through a lowpass whose corner rises with how
   * agitated the water is. A still tarn is almost nothing; a cascade is bright
   * and busy. A resonant peak around 500Hz gives the hollow note that running
   * water has over stones.
   */
  private buildWater(ctx: AudioContext) {
    const gain = ctx.createGain();
    gain.gain.value = 0;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    filter.Q.value = 0.6;

    const resonance = ctx.createBiquadFilter();
    resonance.type = 'peaking';
    resonance.frequency.value = 520;
    resonance.Q.value = 1.6;
    resonance.gain.value = 5;

    this.loopNoise(ctx).connect(filter).connect(resonance).connect(gain);
    gain.connect(this.dryBus!);
    gain.connect(this.wetBus!);

    this.waterFilter = filter;
    this.waterResonance = resonance;
    this.waterGain = gain;
  }

  private buildRain(ctx: AudioContext) {
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 2600;
    filter.Q.value = 0.4;
    this.loopNoise(ctx).connect(filter).connect(gain);
    gain.connect(this.dryBus!);
    gain.connect(this.wetBus!);
    this.rainFilter = filter;
    this.rainGain = gain;
  }

  private async loadClips() {
    const ctx = this.ctx;
    if (!ctx) return;

    await Promise.all(
      CLIP_MANIFEST.map(async (entry) => {
        try {
          const response = await fetch(`${this.basePath}/audio/${entry.file}`);
          if (!response.ok) return;
          const bytes = await response.arrayBuffer();
          const buffer = await ctx.decodeAudioData(bytes);
          this.clips.push({ id: entry.id, role: entry.role, buffer });
        } catch {
          // A missing or undecodable clip just means one fewer bird.
        }
      })
    );
  }

  // -------------------------------------------------------------------------
  // Per-frame update
  // -------------------------------------------------------------------------

  update(state: SoundscapeState, dt: number) {
    if (!this.started || !this.ctx) return;
    const now = this.ctx.currentTime;

    // --- wind ---------------------------------------------------------------
    // Exposure is the dominant term: the same weather is a different sound in
    // a sheltered hollow and on an open ridge.
    const shelter = lerp(1, 0.45, state.canopy);
    const windTarget = clamp01(state.wind * (0.3 + state.exposure * 0.9)) * shelter;
    this.smoothed.wind = damp(this.smoothed.wind, windTarget, 1.4, dt);

    const gustLift = 0.75 + state.gust * 0.55;
    this.windGain!.gain.setTargetAtTime(this.smoothed.wind * 0.16 * gustLift, now, 0.25);
    // Wind gets brighter as it strengthens — the same reason a gale whistles.
    this.windHigh!.frequency.setTargetAtTime(700 + this.smoothed.wind * 900 * gustLift, now, 0.4);
    this.windLow!.frequency.setTargetAtTime(240 + this.smoothed.wind * 220, now, 0.4);

    // --- leaves -------------------------------------------------------------
    const leafTarget = clamp01(state.canopy * 1.2) * clamp01(state.wind * 0.7 + state.gust * 0.5);
    this.smoothed.leaves = damp(this.smoothed.leaves, leafTarget, 1.8, dt);
    this.leafGain!.gain.setTargetAtTime(this.smoothed.leaves * 0.085, now, 0.2);
    this.leafFilter!.frequency.setTargetAtTime(2400 + state.gust * 2200, now, 0.3);

    // --- water --------------------------------------------------------------
    // Inverse-square-ish falloff, which is what makes walking toward a stream
    // feel like walking toward a stream.
    const proximity = state.waterDistance === Infinity
      ? 0
      : clamp01(1 - state.waterDistance / 55) ** 1.6;
    const waterTarget = proximity * lerp(0.35, 1, state.waterEnergy);
    this.smoothed.water = damp(this.smoothed.water, waterTarget, 1.1, dt);
    this.smoothed.waterTone = damp(this.smoothed.waterTone, state.waterEnergy, 0.8, dt);

    this.waterGain!.gain.setTargetAtTime(this.smoothed.water * 0.3, now, 0.3);
    this.waterFilter!.frequency.setTargetAtTime(
      lerp(700, 5200, this.smoothed.waterTone), now, 0.5
    );
    this.waterResonance!.gain.setTargetAtTime(lerp(6, 2, this.smoothed.waterTone), now, 0.5);

    // --- rain ---------------------------------------------------------------
    this.smoothed.rain = damp(this.smoothed.rain, state.rain, 0.7, dt);
    this.rainGain!.gain.setTargetAtTime(this.smoothed.rain * 0.11, now, 0.6);
    // Rain on leaves is duller and busier than rain on open ground.
    this.rainFilter!.frequency.setTargetAtTime(lerp(3200, 1900, state.canopy), now, 0.6);

    this.updateFootsteps(state, dt);
    this.updateBirds(state, dt);
  }

  /**
   * Footsteps are synthesised per step: a short filtered noise burst whose
   * colour comes from the surface. Cheap, and it never repeats the way a small
   * set of samples does.
   */
  private updateFootsteps(state: SoundscapeState, dt: number) {
    if (state.speed < 0.15) {
      this.strideProgress = 0.5;
      return;
    }
    // Stride length grows a little with speed, as it does when you walk faster.
    const stridesPerSecond = state.speed / lerp(0.68, 0.95, clamp01(state.speed / 3));
    this.strideProgress += stridesPerSecond * dt;
    if (this.strideProgress < 1) return;
    this.strideProgress -= 1;

    const ctx = this.ctx!;
    const now = ctx.currentTime;

    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;
    // Start at a random point so no two steps are the same noise.
    const offset = this.rng.range(0, this.noiseBuffer!.duration - 0.3);

    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();

    // Surface decides brightness, resonance and how long the step rings.
    let frequency = 900;
    let q = 0.8;
    let decay = 0.13;
    let level = 0.22;
    switch (state.surface) {
      case 'litter': frequency = 1500; q = 0.6; decay = 0.16; level = 0.2; break;
      case 'grass':  frequency = 2400; q = 0.5; decay = 0.12; level = 0.15; break;
      case 'rock':   frequency = 3200; q = 1.6; decay = 0.09; level = 0.26; break;
      case 'snow':   frequency = 700;  q = 0.7; decay = 0.2;  level = 0.18; break;
      case 'water':  frequency = 1100; q = 0.9; decay = 0.28; level = 0.32; break;
    }

    filter.type = 'bandpass';
    filter.frequency.value = frequency * this.rng.range(0.88, 1.14);
    filter.Q.value = q;

    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(level * this.rng.range(0.8, 1.15), now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + decay);

    source.connect(filter).connect(gain);
    gain.connect(this.footBus!);
    source.start(now, offset);
    source.stop(now + decay + 0.05);
  }

  /**
   * Birds.
   *
   * Which birds can be heard, and how often, follows the clock: a thick dawn
   * chorus that thins through the morning, a quiet afternoon, owls after dark,
   * and ravens and buzzards instead of songbirds once you climb above the
   * treeline. Each call is placed at a random point around you and panned, so
   * the wood sounds occupied rather than decorated.
   */
  private updateBirds(state: SoundscapeState, dt: number) {
    if (!this.clips.length) return;

    const hour = state.hour;
    // Dawn chorus: sharp onset before sunrise, tailing off through the morning.
    const dawn = smoothstep(3.6, 5.2, hour) * (1 - smoothstep(8.5, 11, hour));
    const day = smoothstep(5.5, 7, hour) * (1 - smoothstep(18.5, 20.5, hour));
    const night = 1 - smoothstep(3.4, 5, hour) + smoothstep(19.5, 21.5, hour);

    // Songbirds need trees; above the treeline you get corvids and raptors.
    const wooded = clamp01(state.canopy * 1.4);
    const high = smoothstep(560, 720, state.altitude);

    const weights: Record<BirdClip['role'], number> = {
      dawn: dawn * 2.4 * wooded,
      day: day * 1.0 * wooded,
      night: clamp01(night) * 0.5,
      high: high * 0.45 + day * 0.06,
    };

    // Rain and hard wind quiet everything down; birds shelter too.
    const activity = (weights.dawn + weights.day + weights.night + weights.high)
      * lerp(1, 0.25, state.rain)
      * lerp(1, 0.45, clamp01(state.wind - 0.5) * 2);

    if (activity <= 0.001) return;

    this.nextBirdIn -= dt * activity;
    if (this.nextBirdIn > 0) return;
    // Long, irregular gaps. A bird every two seconds is a pet shop.
    this.nextBirdIn = this.rng.range(1.6, 7.5);

    const roles = Object.keys(weights) as BirdClip['role'][];
    const role = roles[this.rng.weightedIndex(roles.map((r) => weights[r]))];
    const candidates = this.clips.filter((c) => c.role === role);
    if (!candidates.length) return;
    const clip = this.rng.pick(candidates);

    const ctx = this.ctx!;
    const now = ctx.currentTime;

    const source = ctx.createBufferSource();
    source.buffer = clip.buffer;
    // Small pitch variation so the same clip doesn't announce itself.
    source.playbackRate.value = this.rng.range(0.94, 1.07);

    // Many Commons recordings are long; take a window rather than the lot.
    const maxLength = Math.min(clip.buffer.duration, this.rng.range(1.6, 4.5));
    const offset = this.rng.range(0, Math.max(0, clip.buffer.duration - maxLength));

    const panner = ctx.createStereoPanner();
    panner.pan.value = this.rng.range(-0.85, 0.85);

    const gain = ctx.createGain();
    // Distance: mostly middle-distance birds, occasionally one close by.
    const distance = this.rng.range(0.25, 1);
    const level = 0.4 * (1 - distance * 0.8);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(level, now + 0.05);
    gain.gain.setValueAtTime(level, now + maxLength - 0.25);
    gain.gain.linearRampToValueAtTime(0, now + maxLength);

    // Distant birds are duller — air absorbs the top end.
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = lerp(9000, 2600, distance);

    source.connect(tone).connect(gain).connect(panner);
    panner.connect(this.dryBus!);
    // Farther birds sit further back in the reverb, which is most of what
    // makes them read as distant.
    const send = ctx.createGain();
    send.gain.value = 0.25 + distance * 0.5;
    panner.connect(send).connect(this.wetBus!);

    source.start(now, offset, maxLength);
    source.stop(now + maxLength + 0.1);
  }

  // -------------------------------------------------------------------------

  setVolume(value: number) {
    this.volume = clamp01(value);
    if (this.master && !this.muted) {
      this.master.gain.setTargetAtTime(this.volume, this.ctx!.currentTime, 0.1);
    }
  }

  getVolume(): number {
    return this.volume;
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (this.master) {
      this.master.gain.setTargetAtTime(muted ? 0 : this.volume, this.ctx!.currentTime, 0.1);
    }
  }

  isMuted(): boolean {
    return this.muted;
  }

  /** Rest mode brings the world forward and pushes everything else back. */
  setRestMode(resting: boolean) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.wetBus?.gain.setTargetAtTime(resting ? 0.34 : 0.22, now, 1.2);
    this.footBus?.gain.setTargetAtTime(resting ? 0 : 0.5, now, 0.6);
    this.birdBus?.gain.setTargetAtTime(resting ? 1.25 : 0.9, now, 1.5);
  }

  get clipCount(): number {
    return this.clips.length;
  }

  dispose() {
    void this.ctx?.close();
    this.ctx = null;
    this.started = false;
  }
}
