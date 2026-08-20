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
npm run deploy         # build, then wrangler deploy
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

**Post-processing is hand-rolled** (`src/render/post.ts`) rather than assembled
from `EffectComposer`, because three tone maps inside every material's shader —
so an ordinary render arrives already compressed, and bloom on display-range
values is a different effect from bloom on real radiances. The world renders
with tone mapping off into a half-float target, bloom, light shafts and depth
of field all work in linear, and AgX is applied once at the end. Light shafts
march a depth mask rather than scene colour: the sky dome sits at the far
plane, so one compare is the whole occlusion test, and it is exactly the canopy
you are standing under. FXAA closes the chain, because multisampling and a
depth texture do not coexist and the effects need the depth — and a canopy of
alpha-tested cutouts is the worst possible content to leave unfiltered.

**Spray and wet rock.** Where fast water crosses a steep face — the same test
the journal uses to name a waterfall — a cloud of billboards lives entirely in
the vertex shader: an origin, a seed and a looping lifetime, so there is no
per-frame CPU cost when the nearest fall is four hundred metres behind you.
Wet ground is dilated across the terrain grid rather than sampled per vertex,
because a mountain beck is about a metre wide and a terrain vertex is one to
eight metres from its neighbour: read at the vertex, the water is narrower than
the mesh and the wetness interpolates away to nothing.

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
node tools/model-preview.mjs fir_tree pine_tree --eye   # one asset, on a grid
node tools/perf-census.mjs                              # triangles per species
```

`perf-census.mjs` is the one to run on real hardware. Draw calls and a triangle
total tell you there is a problem; only a per-species breakdown tells you which
asset caused it. Its first run found a 0.4-metre shrub costing seven million
triangles a frame, a third of the whole picture, because its budget was eight
thousand triangles an instance and eight hundred were on screen.

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

## Deploying

The game is static: a bundle plus an asset directory, no server side, no
database, no network calls after load. Anything that can serve files can host
it. `wrangler.toml` is configured for **Cloudflare Workers static assets**,
which is what Cloudflare recommends for new projects.

The custom domain lives in `wrangler.toml`:

```toml
[[routes]]
pattern = "hiking.akhtar.app"
custom_domain = true
```

Cloudflare creates the DNS record and issues the certificate itself. Two things
must be true or the deploy fails with a clear error: the zone must be active on
the same Cloudflare account, and there must be no existing CNAME at that
hostname — a Custom Domain cannot take one over.

### From a connected GitHub repository

The asset directory is committed, so a Git-sourced build needs nothing extra.
In the Cloudflare dashboard: **Workers & Pages → Create → Import a repository**,
pick this repo, and set

| Setting | Value |
| --- | --- |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Build output directory | `dist` |
| Environment variable | `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` = `1` |

That last one is worth setting. `playwright` is a devDependency used only by
the screenshot and walk tests, and its install script otherwise downloads a
couple of hundred megabytes of browser on every build. Nothing breaks without
it; the build is just slower.

Every push to the branch then redeploys. To deploy by hand instead:

```
npx wrangler login
npm run deploy
```

### Against the platform limits

Workers static assets allows 20,000 files on the free plan and 25 MiB per
file. This build is **78 files, largest 11.1 MB** — the biggest tree scan —
so there is a lot of headroom on both. `npm run size` prints the current
numbers, and `public/_headers` (6 rules, against a limit of 100) sets the
cache policy and a content security policy that forbids any outbound request,
so a build that accidentally grew a network dependency would fail loudly
rather than quietly phone home.

`not_found_handling` is deliberately left at its default rather than
single-page-application: there are no client-side routes to preserve, and SPA
handling would answer a missing model file with `index.html` and a 200, hiding
a broken asset path instead of showing a 404.

### Cloudflare Pages instead

Pages also works and the repository is compatible with it — same build command,
same output directory, and `_headers` behaves the same way. Replace the
`[assets]` block in `wrangler.toml` with `pages_build_output_dir = "dist"` and
deploy with `npx wrangler pages deploy dist`. Workers is the better default now;
Pages is there if you already have a Pages project.

## Credits and licence

Every model, texture and recording is somebody else's fieldwork. See
[CREDITS.md](CREDITS.md) — the birdsong in particular is **CC BY-SA**, which
carries obligations on redistribution.

The code in this repository is MIT.
