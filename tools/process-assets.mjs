/**
 * Turn raw Poly Haven downloads into assets the game can actually ship.
 *
 * Poly Haven publishes photoscans at scan density: `fir_tree_01` alone is a
 * 478MB vertex buffer of several million triangles. Beautiful, and completely
 * unusable in a browser. This script does the work a studio's art pipeline
 * would:
 *
 *   weld + dedup + prune  strip duplicate vertices, materials and unused data
 *   simplify              collapse to a triangle budget with meshoptimizer,
 *                         preserving the silhouette and the UV seams
 *   textureCompress       resize and re-encode to WebP
 *   quantize + meshopt    pack vertex attributes and compress the buffers
 *
 * The result is a .glb of a few hundred kilobytes that still looks scanned,
 * because the thing that carries photorealism in foliage is the texture and
 * the alpha cutout, not the triangle count.
 *
 *   node tools/process-assets.mjs
 *   node tools/process-assets.mjs --only fern,boulder --force
 */

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  dedup, prune, weld, textureCompress, quantize, flatten,
} from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { mkdir, readFile, writeFile, stat, readdir } from 'node:fs/promises';
import path from 'node:path';

const RAW = 'assets-raw';
const OUT = 'public/assets';

/**
 * The largest a grown foliage island may get, in metres.
 *
 * These islands are not single cards: measured, a conifer's are five triangles
 * and 4.4cm across — a needle cluster. Grown to this radius one becomes a
 * sprig about seventy centimetres long, which is what a fir branch actually
 * carries, and the twig atlas patch each island samples is big enough to hold
 * up at that size.
 *
 * It is the binding constraint on a conifer, deliberately. Preserving the
 * original leaf area alone wants 7x, and at 7x a five-triangle needle cluster
 * becomes a forty-centimetre blade: from across a clearing the tree looks
 * right, but standing under a branch you are looking at green planks. Twenty
 * centimetres across is about what one fir sprig is, and the twig atlas holds
 * five whole sprigs, so a card at that size shows a real branchlet.
 *
 * The density that growth is no longer buying has to be paid for in cards,
 * which is why the conifer budgets are the largest in the manifest.
 */
const MAX_CARD_RADIUS = 0.10;

const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const ONLY = (() => {
  const i = argv.indexOf('--only');
  return i >= 0 && argv[i + 1] ? new Set(argv[i + 1].split(',')) : null;
})();

const manifest = JSON.parse(await readFile(new URL('./assets.json', import.meta.url), 'utf8'));

await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

await mkdir(path.join(OUT, 'models'), { recursive: true });
await mkdir(path.join(OUT, 'textures'), { recursive: true });

const report = [];

// ---------------------------------------------------------------------------
// Ground textures -> WebP
// ---------------------------------------------------------------------------

for (const tex of manifest.textures) {
  if (ONLY && !ONLY.has(tex.id)) continue;

  for (const [suffix, quality] of [['diff', 82], ['nor', 90], ['arm', 85]]) {
    const src = path.join(RAW, 'textures', `${tex.id}_${suffix}.jpg`);
    const dest = path.join(OUT, 'textures', `${tex.id}_${suffix}.webp`);
    if (!FORCE && (await exists(dest))) continue;
    if (!(await exists(src))) {
      console.warn(`missing ${src} — run fetch-assets first`);
      continue;
    }

    // Normal maps are the one place lossy compression really shows: banding in
    // a normal map becomes visible faceting under a moving light, so they get
    // a much higher quality setting than colour does.
    // 1024, not 2048. The engine packs these into a texture array at 1024 and
    // downsamples anything larger on load, so shipping 2048 spent ten
    // megabytes — an eighth of the whole budget — on pixels that were thrown
    // away in the browser before the first frame.
    await sharp(src)
      .resize(1024, 1024, { fit: 'fill' })
      .webp({ quality, effort: 5 })
      .toFile(dest);

    const before = (await stat(src)).size;
    const after = (await stat(dest)).size;
    report.push({ id: `${tex.id}_${suffix}`, kind: 'texture', before, after });
    console.log(`texture ${tex.id}_${suffix}: ${(before / 1e6).toFixed(1)}MB -> ${(after / 1e6).toFixed(2)}MB`);
  }
}

// ---------------------------------------------------------------------------
// Models -> simplified, compressed .glb
// ---------------------------------------------------------------------------

for (const model of manifest.models) {
  if (ONLY && !ONLY.has(model.id)) continue;

  const srcDir = path.join(RAW, 'models', model.id);
  const srcPath = path.join(srcDir, 'model.gltf');
  const dest = path.join(OUT, 'models', `${model.id}.glb`);

  if (!(await exists(srcPath))) {
    console.warn(`missing ${srcPath} — skipping ${model.id}`);
    continue;
  }
  if (!FORCE && (await exists(dest))) {
    console.log(`skip ${model.id} (already built)`);
    continue;
  }

  const rawBytes = await dirSize(srcDir);
  const started = Date.now();

  let document;
  try {
    document = await io.read(srcPath);
  } catch (err) {
    console.error(`FAILED to read ${model.id}: ${err.message}`);
    continue;
  }

  const before = countTriangles(document);

  try {
    // Flatten bakes node transforms into the meshes. Note what we deliberately
    // do *not* do: join().
    //
    // Almost every Poly Haven plant is published as a set of variants in one
    // file — `fir_tree_01` holds three whole trees, `grass_medium_01` holds
    // seventeen tufts — all sharing one material set. Joining them welds every
    // variant into a single overlapping blob, which is how the fir impostor
    // came out as a jumble of planks. Kept apart, they are exactly the natural
    // variety a forest needs, so each root node survives as its own mesh and
    // the game picks between them per plant.
    await document.transform(flatten(), dedup());

    const scene = document.getRoot().listScenes()[0];
    const roots = scene ? scene.listChildren() : [];

    // Cap the variant count: past a handful the extra draw calls cost more
    // than the extra variety is worth.
    const MAX_VARIANTS = 4;
    if (roots.length > MAX_VARIANTS) {
      for (const node of roots.slice(MAX_VARIANTS)) node.dispose();
    }
    void Math.max(1, Math.min(roots.length, MAX_VARIANTS));

    // Throw away the scanner's normals before welding.
    //
    // This one line is the difference between the pipeline working and not.
    // Poly Haven scans ship flat-shaded, so almost every triangle carries its
    // own normal; welding on all attributes therefore merges almost nothing,
    // and the mesh stays a soup of tiny patches whose edges are all borders.
    // meshoptimizer will not collapse across a border, so simplification
    // stalls — `boulder_01` refused to go below 56k triangles against a 1.2k
    // budget. Dropping normals first takes it from 114,778 border edges to
    // 8,454 and the same call lands on budget exactly. Smooth normals are
    // recomputed below, which is what an organic scan wants anyway.
    //
    // Vertex colours go too. Poly Haven bakes two sets into every scan and no
    // shader in the game reads either, but quantisation happily keeps them and
    // they cost eight bytes a vertex — two megabytes on a tree that is mostly
    // vertices.
    for (const mesh of document.getRoot().listMeshes()) {
      for (const primitive of mesh.listPrimitives()) {
        primitive.setAttribute('NORMAL', null);
        primitive.setAttribute('COLOR_0', null);
        primitive.setAttribute('COLOR_1', null);
      }
    }

    // Split the budget between the two kinds of geometry, because they want
    // opposite treatment and lumping them together is what wrecked the
    // conifers.
    //
    // A fir's trunk and branches are a connected surface: edge collapse is
    // exactly right for them, and the normal map carries the detail that goes.
    // Its needles are 4.07 *million* two-triangle alpha cards with a median
    // edge of three millimetres, and edge collapse does not thin those, it
    // deletes them. Run together under one global ratio, 98% of the deletion
    // landed on the canopy and the tree came out as a pole holding 2% of its
    // original leaf area.
    // Weld before anything else looks at the geometry. A raw scan is
    // flat-shaded, so every triangle owns its three vertices and *everything*
    // has three vertices per triangle; only after welding does the ratio
    // become the honest signal that tells a card soup from a surface.
    await document.transform(weld(), prune());

    const split = budgetSplit(document, model.tris);
    cullFoliageCards(document, split.foliage);

    // Solid surfaces only, per primitive, so a trunk's ratio is computed from
    // the trunk rather than from the canopy that dwarfs it.
    simplifySolids(document, split.solid);

    await document.transform(
      prune(),
      textureCompress({
        encoder: sharp,
        targetFormat: 'webp',
        resize: [1024, 1024],
        quality: 84,
      })
    );

    computeSmoothNormals(document);

    // Quantisation goes last, after normals exist, so they get packed too.
    await document.transform(
      quantize({
        quantizePosition: 14,
        quantizeNormal: 10,
        quantizeTexcoord: 12,
      })
    );
  } catch (err) {
    console.error(`FAILED to process ${model.id}: ${err.message}`);
    continue;
  }

  const after = countTriangles(document);
  const variants = document.getRoot().listScenes()[0]?.listChildren().length ?? 1;
  const glb = await io.writeBinary(document);
  await writeFile(dest, glb);

  const seconds = (Date.now() - started) / 1000;
  report.push({
    id: model.id, kind: 'model', group: model.group,
    rawBytes, before, after, after_bytes: glb.byteLength, variants,
  });
  console.log(
    `model ${model.id.padEnd(16)} ${(rawBytes / 1e6).toFixed(0)}MB/${(before / 1000).toFixed(0)}k tris` +
      ` -> ${(glb.byteLength / 1024).toFixed(0)}KB/${after} tris, ${variants} variant(s)  (${seconds.toFixed(1)}s)`
  );
}

await writeFile(path.join(OUT, 'build-report.json'), JSON.stringify(report, null, 2));

const shipped = report.reduce((sum, r) => sum + (r.after ?? 0) * 0 + (r.after_bytes ?? r.after ?? 0), 0);
console.log(`\nprocessed ${report.length} assets, ${(shipped / 1e6).toFixed(1)}MB shipped`);

// ---------------------------------------------------------------------------

/**
 * True for the card soups: leaves, needles, grass blades.
 *
 * Decided from the geometry rather than from the declared alpha mode, because
 * the declared mode lies. `fir_tree_01` marks its twigs BLEND and `pine_tree_01`
 * marks the identical kind of geometry OPAQUE, cutting it out with an alpha
 * test the game applies itself — so trusting the material left seventeen
 * million pine triangles untouched and shipped a 475MB tree.
 *
 * After welding, a soup of two-triangle quads has about two vertices per
 * triangle; a connected surface has about half of one. Nothing else in these
 * scans sits anywhere near the middle.
 */
function isFoliage(primitive) {
  const triangles = trianglesOf(primitive);
  if (!triangles) return false;
  return primitive.getAttribute('POSITION').getCount() / triangles > 1.2;
}

function trianglesOf(primitive) {
  const indices = primitive.getIndices();
  const position = primitive.getAttribute('POSITION');
  if (!position) return 0;
  return (indices ? indices.getCount() : position.getCount()) / 3;
}

/**
 * Divide a model's triangle budget between foliage and solid geometry.
 *
 * Solid gets a tenth, floored so a trunk is never reduced to a stick, and
 * capped at whatever it actually has so a rock does not "spend" a foliage
 * allowance it has no use for. Everything left goes to the canopy, which is
 * the right bias: on a tree, the leaves are the thing you are looking at.
 */
function budgetSplit(document, budget) {
  let foliage = 0;
  let solid = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const count = trianglesOf(primitive);
      if (isFoliage(primitive)) foliage += count;
      else solid += count;
    }
  }
  if (foliage === 0) return { foliage: 0, solid: budget };
  // The floor must never exceed the model's own budget, or a small asset can
  // be handed more triangles than it was allotted: `stone` asked for 500 and
  // the flat 2500 floor gave it 2500, which is how a pebble ended up costing
  // more than a fir.
  const solidBudget = Math.min(solid, Math.max(Math.min(2500, budget), Math.round(budget * 0.1)));
  return { foliage: Math.max(1000, budget - solidBudget), solid: solidBudget };
}

/**
 * Edge-collapse the connected surfaces, one primitive at a time.
 *
 * gltf-transform's `simplify()` takes a single ratio for the whole document,
 * which is wrong the moment a document holds both a 240k-triangle trunk and a
 * 6.7M-triangle needle soup: the ratio that fits the total annihilates the
 * trunk. Driving meshoptimizer per primitive lets each surface be reduced
 * against its own size, and lets the foliage be skipped entirely.
 */
function simplifySolids(document, budget) {
  const solids = [];
  let total = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      if (isFoliage(primitive)) continue;
      const count = trianglesOf(primitive);
      if (!count || !primitive.getIndices()) continue;
      solids.push(primitive);
      total += count;
    }
  }
  if (!total || total <= budget) return;

  const ratio = budget / total;
  for (const primitive of solids) {
    const indices = primitive.getIndices();
    const position = primitive.getAttribute('POSITION');
    const source = indices.getArray();
    const idx = source instanceof Uint32Array ? source : new Uint32Array(source);
    const positions = Float32Array.from(position.getArray());

    const target = Math.max(24, Math.floor((idx.length / 3) * ratio)) * 3;
    if (target >= idx.length) continue;

    // Error is a fraction of the *mesh radius*, so on a thirty-metre fir even
    // a modest-sounding 0.05 is one and a half metres of licence. Kept tight:
    // the reduction should come from the target count, not from letting the
    // silhouette drift.
    // No LockBorder. These are photoscans: even after welding, a good fraction
    // of the edges are borders, and refusing to collapse across them is what
    // made `boulder_01` bottom out at 56k triangles against a 1.2k budget.
    const [simplified] = MeshoptSimplifier.simplify(idx, positions, 3, target, 0.008);
    if (simplified.length && simplified.length < idx.length) {
      indices.setArray(simplified);
    }
  }
}

/**
 * Thin a soup of disconnected foliage cards down to a triangle budget.
 *
 * Finds connected components — one per card — and keeps a deterministic random
 * subset, then grows each survivor about its own centroid so the canopy keeps
 * the leaf *area* it had. That growth is the whole point and it is not a
 * cosmetic touch: a fir scan models every needle individually, at a median
 * card edge of three millimetres, so keeping 2% of the cards at their original
 * size leaves 2% of the canopy. The survivors have to become sprigs.
 *
 * Growth is capped per card by an absolute size rather than by a multiplier.
 * A needle can safely become a twig; a card that was already a hand's breadth
 * across should not become a bedsheet, and the same constant expresses both.
 * Card UVs span about a sixth of the twig atlas each, so a grown card shows a
 * real twig rather than one blurred needle.
 *
 * Primitives that are properly connected surfaces are left alone —
 * `simplifySolids` has already handled those.
 */
function cullFoliageCards(document, budget) {
  if (budget <= 0) return;

  let total = 0;
  const targets = [];
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      if (!isFoliage(primitive) || !primitive.getIndices()) continue;
      const count = trianglesOf(primitive);
      if (!count) continue;
      targets.push(primitive);
      total += count;
    }
  }
  if (!targets.length || total <= budget) return;

  const keepRatio = budget / total;
  // Preserving total leaf area means growing by 1/sqrt(keepRatio).
  const globalGrow = 1 / Math.sqrt(Math.max(1e-5, keepRatio));

  for (const primitive of targets) {
    const indices = primitive.getIndices();
    const position = primitive.getAttribute('POSITION');
    const idx = indices.getArray();
    const pos = position.getArray();
    const triCount = idx.length / 3;
    const vertCount = position.getCount();

    // Union-find over vertices; two are connected if a triangle uses both.
    // Kept as flat typed arrays throughout: a hero conifer variant is four
    // million triangles, and one JS array per component would be gigabytes.
    const parent = new Uint32Array(vertCount);
    for (let i = 0; i < vertCount; i++) parent[i] = i;
    const find = (a) => {
      while (parent[a] !== a) {
        parent[a] = parent[parent[a]];
        a = parent[a];
      }
      return a;
    };
    const union = (a, b) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    };
    for (let i = 0; i < idx.length; i += 3) {
      union(idx[i], idx[i + 1]);
      union(idx[i + 1], idx[i + 2]);
    }

    // Only bail if there is nothing to cull *by*. The primitives that reach
    // here are already alpha-cut foliage, so the old "average island is small"
    // test was both redundant and wrong: a pine's needle clusters average
    // dozens of triangles per island, which tripped the guard and left the
    // whole 17-million-triangle canopy untouched.
    let components = 0;
    for (let v = 0; v < vertCount; v++) if (parent[v] === v) components++;
    if (components < 32) continue;

    // Keep or drop per component, so a card is never half kept.
    // 0 = undecided, 1 = keep, 2 = drop. A typed array rather than a Map:
    // there are two million cards in a hero conifer and a Map of that many
    // boxed entries costs more than every other buffer here put together.
    const keepTri = new Uint8Array(triCount);
    const verdicts = new Uint8Array(vertCount);
    let kept = 0;
    for (let t = 0; t < triCount; t++) {
      const root = find(idx[t * 3]);
      if (verdicts[root] === 0) {
        // Deterministic: the same asset culls the same way every build.
        const roll = ((Math.imul(root + 1, 2654435761) >>> 0) % 100000) / 100000;
        verdicts[root] = roll < keepRatio ? 1 : 2;
      }
      if (verdicts[root] === 1) {
        keepTri[t] = 1;
        kept++;
      }
    }
    if (!kept || kept === triCount) continue;

    // Centroid and radius of each surviving card, accumulated by root vertex.
    const sum = new Float64Array(vertCount * 3);
    const count = new Uint32Array(vertCount);
    const seen = new Uint8Array(vertCount);
    for (let t = 0; t < triCount; t++) {
      if (!keepTri[t]) continue;
      for (let k = 0; k < 3; k++) {
        const v = idx[t * 3 + k];
        if (seen[v]) continue;
        seen[v] = 1;
        const root = find(v);
        sum[root * 3] += pos[v * 3];
        sum[root * 3 + 1] += pos[v * 3 + 1];
        sum[root * 3 + 2] += pos[v * 3 + 2];
        count[root]++;
      }
    }
    for (let v = 0; v < vertCount; v++) {
      if (!count[v]) continue;
      sum[v * 3] /= count[v];
      sum[v * 3 + 1] /= count[v];
      sum[v * 3 + 2] /= count[v];
    }

    const radius = new Float32Array(vertCount);
    for (let v = 0; v < vertCount; v++) {
      if (!seen[v]) continue;
      const root = find(v);
      const d = Math.hypot(
        pos[v * 3] - sum[root * 3],
        pos[v * 3 + 1] - sum[root * 3 + 1],
        pos[v * 3 + 2] - sum[root * 3 + 2]
      );
      if (d > radius[root]) radius[root] = d;
    }

    // Scale in place. Every surviving vertex belongs to exactly one card and
    // the centroids are already computed, so there is no need for a copy.
    for (let v = 0; v < vertCount; v++) {
      if (!seen[v]) continue;
      const root = find(v);
      const r = radius[root];
      const grow = r > 1e-6 ? Math.min(globalGrow, MAX_CARD_RADIUS / r) : globalGrow;
      if (grow <= 1) continue;
      pos[v * 3] = sum[root * 3] + (pos[v * 3] - sum[root * 3]) * grow;
      pos[v * 3 + 1] = sum[root * 3 + 1] + (pos[v * 3 + 1] - sum[root * 3 + 1]) * grow;
      pos[v * 3 + 2] = sum[root * 3 + 2] + (pos[v * 3 + 2] - sum[root * 3 + 2]) * grow;
    }

    const newIndices = new Uint32Array(kept * 3);
    let w = 0;
    for (let t = 0; t < triCount; t++) {
      if (!keepTri[t]) continue;
      newIndices[w++] = idx[t * 3];
      newIndices[w++] = idx[t * 3 + 1];
      newIndices[w++] = idx[t * 3 + 2];
    }

    position.setArray(pos);
    indices.setArray(newIndices);

    if (process.env.CARD_STATS) {
      const radii = [];
      for (let v = 0; v < vertCount; v++) if (radius[v] > 0) radii.push(radius[v]);
      radii.sort((a, b) => a - b);
      const median = radii[Math.floor(radii.length / 2)] ?? 0;
      const applied = median > 1e-6 ? Math.min(globalGrow, MAX_CARD_RADIUS / median) : globalGrow;
      console.log(
        `    cards: ${components.toLocaleString()} islands, ${(triCount / components).toFixed(1)} tris each, ` +
          `keep ${(keepRatio * 100).toFixed(1)}%, median radius ${(median * 100).toFixed(1)}cm, ` +
          `grow wanted ${globalGrow.toFixed(1)}x applied ~${applied.toFixed(1)}x`
      );
    }
  }
}

/**
 * Area-weighted smooth normals, replacing the ones we discarded before welding.
 *
 * Weighting each face's contribution by its area (which is what the uncorrected
 * cross product gives you for free) means large flat faces dominate over the
 * slivers that simplification tends to leave behind, so the shading stays
 * smooth rather than picking up the seams of the decimation.
 */
function computeSmoothNormals(document) {
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute('POSITION');
      const indices = primitive.getIndices();
      if (!position || !indices) continue;

      const count = position.getCount();
      const normals = new Float32Array(count * 3);
      const idx = indices.getArray();
      const pos = position.getArray();

      for (let i = 0; i < idx.length; i += 3) {
        const a = idx[i] * 3;
        const b = idx[i + 1] * 3;
        const c = idx[i + 2] * 3;

        const abx = pos[b] - pos[a], aby = pos[b + 1] - pos[a + 1], abz = pos[b + 2] - pos[a + 2];
        const acx = pos[c] - pos[a], acy = pos[c + 1] - pos[a + 1], acz = pos[c + 2] - pos[a + 2];

        const nx = aby * acz - abz * acy;
        const ny = abz * acx - abx * acz;
        const nz = abx * acy - aby * acx;

        normals[a] += nx; normals[a + 1] += ny; normals[a + 2] += nz;
        normals[b] += nx; normals[b + 1] += ny; normals[b + 2] += nz;
        normals[c] += nx; normals[c + 1] += ny; normals[c + 2] += nz;
      }

      for (let v = 0; v < count; v++) {
        const o = v * 3;
        const len = Math.hypot(normals[o], normals[o + 1], normals[o + 2]);
        if (len > 1e-12) {
          normals[o] /= len; normals[o + 1] /= len; normals[o + 2] /= len;
        } else {
          normals[o] = 0; normals[o + 1] = 1; normals[o + 2] = 0;
        }
      }

      const accessor = document.createAccessor()
        .setType('VEC3')
        .setArray(normals)
        .setBuffer(document.getRoot().listBuffers()[0]);
      primitive.setAttribute('NORMAL', accessor);
    }
  }
}

function countTriangles(document) {
  let total = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const indices = prim.getIndices();
      const count = indices ? indices.getCount() : (prim.getAttribute('POSITION')?.getCount() ?? 0);
      total += count / 3;
    }
  }
  return Math.round(total);
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function dirSize(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? await dirSize(full) : (await stat(full)).size;
  }
  return total;
}
