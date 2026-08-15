# Virtual Hiking Trails

An open-world hiking game with no timers, no threats and nowhere you have to
be. You walk into an endless wilderness and the only thing to gain is what you
notice: a species of tree you haven't met, a waterfall, a tarn, the top of a
hill. It is meant for anyone who wants a walk in the woods and can't have one.

Arrow keys walk and turn. On a phone, a pad in the corner does the same. That
is the whole control scheme, and everything else — resting, photographing,
the journal — is optional.

```
npm install
npm run dev            # http://localhost:5173
npm run build          # typecheck + bundle to dist/
npm run size           # transferred bytes against the 80MB budget
npm run deploy         # build, then wrangler pages deploy dist
```

The repository ships without the raw scans. To rebuild the asset directory from
scratch (about 2GB of downloads, an hour of processing):

```
npm run assets:all     # fetch Poly Haven scans, process them, fetch birdsong
```

## How it works

**The world is a function, not a file.** `src/world/heightfield.ts` is a pure
seeded function of (x, z): a domain-warped continent, ridged mountains, hills,
rock strata, lake basins and a branching stream network, layered and then
carved. Nothing is stored, so the world is infinite and a save file is a few
hundred bytes. `tools/map-preview.mjs` renders it to a hillshaded PNG with slope
statistics, which is how it was tuned — the ridge octaves originally stacked
into 60° faces nobody could walk up.

**Terrain streams as a quadtree.** 32m leaves near you out to 8km, meshed in a
worker pool, with skirts hiding the LOD seams. The mesher samples a bordered
grid so normals are right at the edges and splits each quad along its shorter
diagonal. Water is a separate mesh carrying baked depth, flow direction and
whitewater attributes.

**Plants are instanced photoscans.** 39 CC0 Poly Haven models, scattered per
cell by biome, slope, altitude, moisture and canopy, drawn as one instanced
mesh per species variant and swapped for runtime-baked octahedral impostors
past about forty metres. A fir is 150,000 triangles; a forest of real firs is
not affordable, and a forest of billboards is two triangles each.

**Half the audio is synthesised and half is recorded**, split on whether it has
to react. Wind, leaf rustle, running water, rain and footsteps are filtered
noise shaped in real time by the same terrain sample the renderer uses — the
wind rises as you climb onto an exposed ridge, a stream swells as you approach
and falls away behind you. Birds are real Wikimedia Commons recordings fired as
spatialised one-shots, with a dawn chorus, a quiet afternoon, owls after dark
and corvids above the treeline.

**Discovery is about looking, not walking.** Something counts when it is near
enough to make out, inside the cone you are actually facing, and not hidden
behind a hill. Because a fir six metres away is thirty metres of tree, the test
aims at whichever part of the plant is closest to where the camera points.

**Nothing leaves the device.** No accounts, no server, no analytics, no network
calls after load. Progress and photographs live in `localStorage`.

## Layout

```
src/
  core/       renderer host, input, quality tiers, storage, RNG
  world/      heightfield, noise, chunk + scatter workers, terrain, weather
  render/     sky, terrain/water materials, vegetation, impostors, textures
  player/     first-person controller
  audio/      soundscape
  game/       species table, discovery + XP, rest/photo modes, orchestration
  ui/         DOM interface and styles
tools/        asset pipeline, screenshot harness, map preview, size report
```

## Verification

The game is checked by driving a real Chromium at it rather than by reasoning
about what the shaders ought to produce:

```
node tools/shoot.mjs --forest --hours 6.4,9.5,13,18.6,22
node tools/shoot.mjs --mobile --hours 8
node tools/shoot.mjs --forest --rest        # also --photo, --journal, --settings
node tools/map-preview.mjs --seed 12345
```

Under SwiftShader the frame rate in those reports is meaningless; the draw
call, triangle and chunk counts are not.

## Controls

| | |
| --- | --- |
| <kbd>↑</kbd> <kbd>↓</kbd> | walk |
| <kbd>←</kbd> <kbd>→</kbd> | turn |
| <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> + mouse | if you prefer |
| <kbd>Shift</kbd> | walk briskly |
| <kbd>R</kbd> | sit and rest |
| <kbd>P</kbd> | photo mode (<kbd>Space</kbd> to take it) |
| <kbd>J</kbd> | field journal |
| <kbd>,</kbd> | settings |
| <kbd>Esc</kbd> | back to the walk |
| <kbd>/</kbd> | frame statistics |

URL parameters: `?seed=`, `?hour=`, `?tier=low|medium|high|ultra`, `?debug`.

## Credits and licence

Every model, texture and recording is somebody else's fieldwork. See
[CREDITS.md](CREDITS.md) — the birdsong in particular is **CC BY-SA**, which
carries obligations on redistribution.

The code in this repository is MIT.
