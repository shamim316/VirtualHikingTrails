/**
 * Shrink the birdsong to what the game actually uses.
 *
 * The recordings arrive from Wikimedia Commons as full-quality stereo files,
 * several of them a megabyte each. Nothing in the game plays them that way:
 * `soundscape.ts` takes a window of 1.6 to 4.5 seconds at a random offset,
 * pitch-shifts it slightly, pans it, runs it through a lowpass whose corner
 * falls to 2.6kHz for a distant bird, and mixes it in at a fraction of full
 * scale. Stereo is thrown away outright — every clip is panned as a point
 * source, so the second channel is decoded and then discarded.
 *
 * So: downmix to mono, cut to a workable length, and encode at a bitrate that
 * survives the filtering. This is not a quality compromise anyone can hear
 * through that chain, and it is worth six megabytes of an eighty megabyte
 * budget — a whole tree's worth.
 *
 *   node tools/compress-audio.mjs
 *   node tools/compress-audio.mjs --bitrate 72k --seconds 24
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, stat, rename, unlink, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';

const run = promisify(execFile);

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const DIR = flag('dir', 'public/assets/audio');
const BITRATE = flag('bitrate', '64k');
/** Longest window the soundscape ever asks for is 4.5s; keep enough spare
 *  that the random offset still lands somewhere different each time. */
const SECONDS = Number(flag('seconds', 20));

const entries = (await readdir(DIR)).filter((f) => /\.(mp3|ogg|wav|m4a)$/i.test(f));
if (!entries.length) {
  console.error(`no audio in ${DIR}`);
  process.exit(1);
}

let before = 0;
let after = 0;
const renamed = new Map();

for (const file of entries) {
  const src = path.join(DIR, file);
  const originalBytes = (await stat(src)).size;
  before += originalBytes;

  // Everything lands as mp3 regardless of what it started as: one decoder
  // path, and Safari has never been reliable about Ogg Vorbis.
  const outName = `${path.parse(file).name}.mp3`;
  const tmp = path.join(DIR, `.tmp-${outName}`);

  try {
    await run(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', src,
      '-t', String(SECONDS),
      '-ac', '1',
      '-ar', '32000',
      '-b:a', BITRATE,
      '-map_metadata', '-1',
      tmp,
    ]);
  } catch (err) {
    console.error(`FAILED ${file}: ${err.message.split('\n')[0]}`);
    await unlink(tmp).catch(() => {});
    after += originalBytes;
    continue;
  }

  const newBytes = (await stat(tmp)).size;
  if (newBytes >= originalBytes) {
    // Already small; leave the original alone rather than re-encoding it for
    // nothing.
    await unlink(tmp);
    after += originalBytes;
    console.log(`  ${file.padEnd(22)} kept (${(originalBytes / 1024).toFixed(0)}kB)`);
    continue;
  }

  if (outName !== file) {
    await unlink(src);
    renamed.set(file, outName);
  }
  await rename(tmp, path.join(DIR, outName));
  after += newBytes;
  console.log(
    `  ${file.padEnd(22)} ${(originalBytes / 1024).toFixed(0)}kB -> ${(newBytes / 1024).toFixed(0)}kB` +
      (outName !== file ? `  (${outName})` : '')
  );
}

// Keep the credits manifest pointing at files that exist. The licences are
// attached to the recordings, not to the container they arrived in.
const creditsPath = path.join(DIR, 'credits.json');
try {
  const credits = JSON.parse(await readFile(creditsPath, 'utf8'));
  let touched = false;
  for (const entry of credits) {
    if (renamed.has(entry.file)) {
      entry.file = renamed.get(entry.file);
      touched = true;
    }
  }
  if (touched) {
    await writeFile(creditsPath, `${JSON.stringify(credits, null, 2)}\n`);
    console.log(`\nupdated ${renamed.size} filename(s) in credits.json`);
  }
} catch {
  console.warn('could not update credits.json');
}

console.log(
  `\n${entries.length} clips: ${(before / 1e6).toFixed(2)}MB -> ${(after / 1e6).toFixed(2)}MB` +
    ` (saved ${((before - after) / 1e6).toFixed(2)}MB)`
);
if (renamed.size) {
  console.log('remember: CLIP_MANIFEST in src/audio/soundscape.ts lists filenames');
}
