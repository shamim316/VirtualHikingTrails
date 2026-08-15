/**
 * Time of day and weather.
 *
 * Weather is a slow random walk between a handful of states rather than a
 * simulation. What matters for a walk in the woods is that the light keeps
 * changing and that change is never abrupt: cloud thickens over minutes, rain
 * arrives before it commits, mist gathers at dawn and burns off. Nothing here
 * is ever unpleasant enough to want to escape from — there is no storm.
 */

import { Rng } from '../core/rng';
import { clamp01, damp, lerp, smoothstep } from './noise';

export type WeatherKind = 'clear' | 'fair' | 'cloudy' | 'overcast' | 'rain' | 'mist';

interface WeatherProfile {
  overcast: number;
  rain: number;
  haze: number;
  windBase: number;
  /** Relative likelihood of moving to each other state. */
  transitions: Partial<Record<WeatherKind, number>>;
}

const PROFILES: Record<WeatherKind, WeatherProfile> = {
  clear:    { overcast: 0.00, rain: 0, haze: 0.05, windBase: 0.25, transitions: { fair: 3, mist: 0.6 } },
  fair:     { overcast: 0.22, rain: 0, haze: 0.12, windBase: 0.35, transitions: { clear: 2.2, cloudy: 1.8, mist: 0.5 } },
  cloudy:   { overcast: 0.58, rain: 0, haze: 0.22, windBase: 0.5, transitions: { fair: 2, overcast: 1.2, rain: 0.7 } },
  overcast: { overcast: 0.92, rain: 0, haze: 0.34, windBase: 0.42, transitions: { cloudy: 2.2, rain: 1.6, mist: 0.8 } },
  rain:     { overcast: 0.96, rain: 1, haze: 0.55, windBase: 0.6, transitions: { overcast: 2.4, cloudy: 1.0, mist: 1.0 } },
  mist:     { overcast: 0.45, rain: 0, haze: 1.0, windBase: 0.12, transitions: { fair: 1.6, clear: 1.2, overcast: 0.9 } },
};

export interface WeatherState {
  /** Hours since midnight, 0..24. */
  hour: number;
  /** 0..1 through the year. */
  season: number;
  /** Days elapsed since the walk began. */
  day: number;
  kind: WeatherKind;
  /** Smoothed values the renderer actually consumes. */
  overcast: number;
  rain: number;
  haze: number;
  /** Ground wetness, which lags rain by a long way in both directions. */
  wetness: number;
  /** Overall wind strength, 0..1. */
  wind: number;
  /** Slow gust envelope, 0..1. */
  gust: number;
  /** Wind bearing in radians. */
  windDirection: number;
}

export interface WeatherOptions {
  seed: number;
  startHour?: number;
  /** Real seconds per in-game hour. */
  secondsPerHour?: number;
}

export class Weather {
  readonly state: WeatherState;
  /** When false the clock holds still — used by photo mode and the settings. */
  timeRunning = true;
  /** Real seconds per in-game hour. */
  secondsPerHour: number;

  private rng: Rng;
  private target: WeatherKind;
  private nextChangeIn: number;
  private gustPhase = 0;
  private windTargetDirection: number;

  constructor(opts: WeatherOptions) {
    this.rng = new Rng(opts.seed ^ 0x7a1e);
    this.secondsPerHour = opts.secondsPerHour ?? 150;

    const kind: WeatherKind = 'fair';
    this.target = kind;
    this.nextChangeIn = this.rng.range(240, 620);
    this.windTargetDirection = this.rng.range(0, Math.PI * 2);

    this.state = {
      hour: opts.startHour ?? 7.4,
      season: this.rng.range(0.28, 0.52),
      day: 0,
      kind,
      overcast: PROFILES[kind].overcast,
      rain: 0,
      haze: PROFILES[kind].haze,
      wetness: 0,
      wind: PROFILES[kind].windBase,
      gust: 0.3,
      windDirection: this.windTargetDirection,
    };
  }

  /** Jump straight to a time of day, for the settings panel. */
  setHour(hour: number) {
    this.state.hour = ((hour % 24) + 24) % 24;
  }

  /** Force a weather state, easing into it rather than snapping. */
  setKind(kind: WeatherKind) {
    this.target = kind;
    this.state.kind = kind;
    this.nextChangeIn = this.rng.range(300, 700);
  }

  update(dt: number) {
    const s = this.state;

    if (this.timeRunning) {
      s.hour += dt / this.secondsPerHour;
      while (s.hour >= 24) {
        s.hour -= 24;
        s.day += 1;
        // The year turns slowly: a season takes a good many in-game days.
        s.season = (s.season + 1 / 90) % 1;
      }
    }

    // --- weather state machine ---------------------------------------------
    this.nextChangeIn -= dt;
    if (this.nextChangeIn <= 0) {
      this.target = this.pickNext(this.target);
      this.state.kind = this.target;
      this.nextChangeIn = this.rng.range(260, 700);
    }

    const profile = PROFILES[this.target];

    // Mist is a dawn phenomenon: it thickens in the cold hours and burns off
    // through the morning.
    const dawnMist = smoothstep(8.5, 5.0, s.hour) * smoothstep(2.5, 4.5, s.hour);
    const hazeTarget = clamp01(profile.haze + dawnMist * 0.5);

    s.overcast = damp(s.overcast, profile.overcast, 0.09, dt);
    s.rain = damp(s.rain, profile.rain, 0.13, dt);
    s.haze = damp(s.haze, hazeTarget, 0.11, dt);

    // Ground stays wet long after the rain stops, and takes a while to soak.
    const dryingRate = lerp(0.006, 0.02, clamp01(1 - s.overcast));
    s.wetness = s.rain > 0.05
      ? damp(s.wetness, 1, 0.05, dt)
      : Math.max(0, s.wetness - dryingRate * dt);

    // --- wind ---------------------------------------------------------------
    this.gustPhase += dt * 0.21;
    // Two slow sines beating against each other: gusts that arrive in waves
    // and never settle into a rhythm you can predict.
    const gust =
      (Math.sin(this.gustPhase) * 0.5 + 0.5) * 0.6 +
      (Math.sin(this.gustPhase * 2.37 + 1.7) * 0.5 + 0.5) * 0.4;
    s.gust = damp(s.gust, gust, 1.6, dt);

    // Wind picks up through the afternoon and drops overnight.
    const diurnal = 0.65 + 0.35 * Math.sin(((s.hour - 9) / 24) * Math.PI * 2);
    s.wind = damp(s.wind, clamp01(profile.windBase * diurnal + s.gust * 0.3), 0.35, dt);

    if (this.rng.chance(dt * 0.01)) {
      this.windTargetDirection += this.rng.range(-0.9, 0.9);
    }
    s.windDirection = damp(s.windDirection, this.windTargetDirection, 0.12, dt);
  }

  private pickNext(from: WeatherKind): WeatherKind {
    const options = PROFILES[from].transitions;
    const kinds = Object.keys(options) as WeatherKind[];
    const weights = kinds.map((k) => options[k] ?? 0);
    return kinds[this.rng.weightedIndex(weights)] ?? from;
  }

  /** Human-readable description for the HUD. */
  describe(): string {
    const s = this.state;
    if (s.rain > 0.3) return 'Light rain';
    if (s.haze > 0.6) return 'Mist';
    if (s.overcast > 0.8) return 'Overcast';
    if (s.overcast > 0.45) return 'Cloudy';
    if (s.overcast > 0.15) return 'Fair';
    return 'Clear';
  }

  /** Clock reading for the HUD. */
  clockString(): string {
    const s = this.state;
    const hours = Math.floor(s.hour);
    const minutes = Math.floor((s.hour - hours) * 60);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }
}
