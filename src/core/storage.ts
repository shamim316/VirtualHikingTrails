/**
 * Saving your walk.
 *
 * Everything lives in localStorage: there are no accounts, no server and
 * nothing leaves the machine. The world itself is a pure function of the seed,
 * so a save is tiny — where you were standing, what you have noticed, and how
 * far you have come.
 *
 * Photos are the exception and are kept in their own record, capped, because a
 * handful of data-URL images will fill a localStorage quota faster than
 * anything else here.
 */

import type { Discovery } from '../game/discovery';

const KEY = 'virtual-hiking-trails/v1';
const PHOTO_KEY = 'virtual-hiking-trails/photos/v1';
const MAX_PHOTOS = 24;

export interface SavedPhoto {
  /** JPEG data URL, downscaled for storage. */
  thumbnail: string;
  caption: string;
  hour: number;
  at: number;
  seed: number;
}

export interface SaveData {
  seed: number;
  position: { x: number; z: number; yaw: number };
  hour: number;
  season: number;
  xp: number;
  distanceWalked: number;
  discovered: Discovery[];
  settings: {
    volume: number;
    muted: boolean;
    tier?: string;
    adaptive: boolean;
    timeRunning: boolean;
  };
}

export function load(): SaveData | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as SaveData;
    if (typeof data?.seed !== 'number') return null;
    return data;
  } catch {
    // Corrupt or unavailable storage should never stop the game starting.
    return null;
  }
}

export function save(data: SaveData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    // Quota exceeded or storage disabled — the walk simply isn't remembered.
  }
}

export function clear(): void {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(PHOTO_KEY);
  } catch {
    // nothing to do
  }
}

export function loadPhotos(): SavedPhoto[] {
  try {
    const raw = localStorage.getItem(PHOTO_KEY);
    if (!raw) return [];
    const photos = JSON.parse(raw);
    return Array.isArray(photos) ? photos : [];
  } catch {
    return [];
  }
}

/**
 * Keep the newest photos and drop the rest.
 *
 * If the quota is hit anyway, halve the collection and try again rather than
 * losing the shot the player just took.
 */
export function savePhotos(photos: SavedPhoto[]): SavedPhoto[] {
  let kept = photos.slice(-MAX_PHOTOS);
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      localStorage.setItem(PHOTO_KEY, JSON.stringify(kept));
      return kept;
    } catch {
      kept = kept.slice(Math.ceil(kept.length / 2));
      if (!kept.length) return [];
    }
  }
  return kept;
}
