/**
 * Fetch the recorded half of the soundscape from Wikimedia Commons.
 *
 * Wind, water and footsteps are synthesised in the browser — they have to
 * react continuously to where you are, and no recording can do that. Birds are
 * the opposite: a chaffinch is a very specific sound and synthesis makes a poor
 * job of it, so those are real recordings, played as spatialised one-shots.
 *
 * Everything downloaded here is CC0, CC BY or CC BY-SA. The licence and author
 * of every single file is written into public/assets/audio/credits.json, which
 * CREDITS.md is generated from — CC BY and BY-SA both require attribution and
 * this is how the game honours that.
 *
 *   node tools/fetch-audio.mjs
 */

import { mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

const API = 'https://commons.wikimedia.org/w/api.php';
const OUT = 'public/assets/audio';

/**
 * What to look for. Each entry becomes one or more clips in the game, tagged
 * with when it should be heard.
 *
 * `search` is a Commons search phrase; `max` caps how many files to take, and
 * `maxBytes` rejects anything too long to be a one-shot — a twenty-minute
 * soundscape recording is not a bird call.
 */
const WANTED = [
  { id: 'chaffinch',   search: 'Fringilla coelebs',        role: 'day',   max: 2, maxBytes: 1_200_000 },
  { id: 'blackbird',   search: 'Turdus merula',            role: 'dawn',  max: 2, maxBytes: 1_600_000 },
  { id: 'robin',       search: 'Erithacus rubecula',       role: 'dawn',  max: 2, maxBytes: 1_400_000 },
  { id: 'wren',        search: 'Troglodytes troglodytes',  role: 'day',   max: 2, maxBytes: 1_200_000 },
  { id: 'greattit',    search: 'Parus major',              role: 'day',   max: 2, maxBytes: 1_200_000 },
  { id: 'blackcap',    search: 'Sylvia atricapilla',       role: 'day',   max: 1, maxBytes: 1_200_000 },
  { id: 'songthrush',  search: 'Turdus philomelos',        role: 'dawn',  max: 1, maxBytes: 1_600_000 },
  { id: 'cuckoo',      search: 'Cuculus canorus',          role: 'day',   max: 1, maxBytes: 1_200_000 },
  { id: 'raven',       search: 'Corvus corax',             role: 'high',  max: 1, maxBytes: 1_000_000 },
  { id: 'buzzard',     search: 'Buteo buteo',              role: 'high',  max: 1, maxBytes: 1_000_000 },
  { id: 'owl',         search: 'Strix aluco',              role: 'night', max: 2, maxBytes: 1_200_000 },
  { id: 'woodpecker',  search: 'Dendrocopos major',        role: 'day',   max: 1, maxBytes: 1_000_000 },
];

/** Licences we will actually ship. Anything else is skipped, loudly. */
const ALLOWED = /^(cc0|cc[ -]by([ -]sa)?([ -][0-9.]+)?|public domain)/i;

await mkdir(OUT, { recursive: true });

const credits = [];
let total = 0;

for (const want of WANTED) {
  // Commons rate-limits, and rightly so.
  await new Promise((r) => setTimeout(r, 1200));
  const files = await search(want.search);
  let taken = 0;

  for (const file of files) {
    if (taken >= want.max) break;

    const info = file.imageinfo?.[0];
    if (!info) continue;

    const licence = info.extmetadata?.LicenseShortName?.value ?? '';
    if (!ALLOWED.test(licence.replace(/\s+/g, ' ').trim())) {
      continue;
    }
    if (!info.size || info.size > want.maxBytes) continue;
    // Commons hands back URLs with a ?utm_source= query string attached, so
    // every extension test has to run against the pathname. Testing the whole
    // URL matches nothing at all, which is a quiet way to download no audio.
    const pathname = new URL(info.url).pathname;
    const extension = path.extname(pathname).toLowerCase();
    // Browsers all handle ogg/mp3; skip anything that would need transcoding.
    if (!/^\.(ogg|oga|mp3|opus)$/.test(extension)) continue;
    const name = `${want.id}_${taken}${extension}`;
    const dest = path.join(OUT, name);

    try {
      const bytes = await download(info.url, dest, info.size);
      total += bytes;
      taken++;
      credits.push({
        file: name,
        id: want.id,
        role: want.role,
        title: stripHtml(info.extmetadata?.ObjectName?.value ?? file.title),
        author: stripHtml(info.extmetadata?.Artist?.value ?? 'Unknown'),
        licence: stripHtml(licence),
        source: `https://commons.wikimedia.org/wiki/${encodeURIComponent(file.title)}`,
        bytes: info.size,
      });
      console.log(`  ${name.padEnd(18)} ${(info.size / 1024).toFixed(0)}KB  ${licence}`);
    } catch (err) {
      console.warn(`  failed ${name}: ${err.message}`);
    }
  }

  if (taken === 0) console.warn(`no usable recording found for ${want.id} (${want.search})`);
}

await writeFile(path.join(OUT, 'credits.json'), JSON.stringify(credits, null, 2));
console.log(`\n${credits.length} clips, ${(total / 1e6).toFixed(1)}MB into ${OUT}/`);

// ---------------------------------------------------------------------------

async function search(phrase) {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    generator: 'search',
    gsrsearch: `filetype:audio ${phrase}`,
    gsrnamespace: '6',
    gsrlimit: '12',
    prop: 'imageinfo',
    iiprop: 'url|size|extmetadata',
    iiextmetadatafilter: 'LicenseShortName|Artist|ObjectName',
  });
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${API}?${params}`, {
      headers: { 'User-Agent': 'VirtualHikingTrails/1.0 (asset fetch; CC attribution recorded)' },
    });
    if (res.ok) {
      const data = await res.json();
      return Object.values(data.query?.pages ?? {});
    }
    if (res.status !== 429) throw new Error(`Commons search failed: ${res.status}`);
    await new Promise((r) => setTimeout(r, 3000 * 2 ** attempt));
  }
  throw new Error('Commons search failed: rate limited');
}

async function download(url, dest, expectedSize) {
  try {
    const existing = await stat(dest);
    if (existing.size === expectedSize) return 0;
  } catch {
    // not yet downloaded
  }
  // upload.wikimedia.org rate-limits harder than the API does, so back off
  // rather than giving up on a file.
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise((r) => setTimeout(r, attempt === 0 ? 900 : 4000 * attempt));
    const res = await fetch(url, {
      headers: { 'User-Agent': 'VirtualHikingTrails/1.0 (asset fetch; CC attribution recorded)' },
    });
    if (res.ok) {
      const buffer = Buffer.from(await res.arrayBuffer());
      await writeFile(dest, buffer);
      return buffer.length;
    }
    if (res.status !== 429) throw new Error(`HTTP ${res.status}`);
  }
  throw new Error('rate limited');
}

function stripHtml(value) {
  return String(value).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}
