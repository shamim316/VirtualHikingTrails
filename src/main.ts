/**
 * Entry point.
 *
 * Reads a seed from the URL (or makes one), starts the world, and hands the
 * rest to the engine.
 */

import './ui/styles.css';
import * as THREE from 'three';
import { Engine } from './core/engine';
import { seedFromString } from './core/rng';

function resolveSeed(): number {
  const params = new URLSearchParams(location.search);
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

  const engine = new Engine({
    canvas,
    seed: resolveSeed(),
    startHour: hourParam ? Number(hourParam) : undefined,
  });

  engine.start();

  // Exposed so the automated screenshot pass can drive time, position and
  // quality without a UI to click through, and so shader problems can be
  // bisected from the console rather than by rebuilding.
  Object.assign(window as unknown as Record<string, unknown>, { hiking: engine, THREE });
}

boot();
