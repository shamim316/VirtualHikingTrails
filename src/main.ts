/**
 * Entry point.
 *
 * Reads a seed from the URL (or makes one), starts the world, and hands the
 * rest to the game.
 */

import './ui/styles.css';
import * as THREE from 'three';
import { Game } from './game/game';
import { seedFromString } from './core/rng';
import type { QualityTier } from './core/quality';

function resolveSeed(params: URLSearchParams): number {
  const raw = params.get('seed');
  if (raw) {
    const numeric = Number(raw);
    return Number.isFinite(numeric) && raw.trim() !== '' ? numeric >>> 0 : seedFromString(raw);
  }
  return (Math.random() * 0xffffffff) >>> 0;
}

function boot() {
  const canvas = document.getElementById('scene') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('missing canvas');

  const params = new URLSearchParams(location.search);
  const hourParam = params.get('hour');
  const tierParam = params.get('tier');

  const game = new Game({
    canvas,
    seed: resolveSeed(params),
    startHour: hourParam ? Number(hourParam) : undefined,
    tier: (tierParam as QualityTier | null) ?? undefined,
    debug: params.has('debug'),
  });

  // Write the walk down before the tab goes away. `pagehide` fires where
  // `beforeunload` does not — notably when a phone backgrounds the browser.
  addEventListener('pagehide', () => game.persist());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') game.persist();
  });

  // Exposed so the automated screenshot pass can drive time, position and
  // quality without a UI to click through, and so shader problems can be
  // bisected from the console rather than by rebuilding.
  Object.assign(window as unknown as Record<string, unknown>, {
    hiking: game.engine,
    game,
    THREE,
  });
}

boot();
