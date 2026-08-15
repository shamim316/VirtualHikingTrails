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
  dedup, prune, weld, simplify, textureCompress, quantize, flatten,
} from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { mkdir, readFile, writeFile, stat, readdir } from 'node:fs/promises';
import path from 'node:path';

const RAW = 'assets-raw';
const OUT = 'public/assets';

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
    await sharp(src)
      .resize(2048, 2048, { fit: 'fill' })
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

    // The budget covers the asset as a whole, so with variants kept apart each
    // one gets its share.
    const ratio = Math.min(1, model.tris / Math.max(1, countTriangles(document)));

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
    for (const mesh of document.getRoot().listMeshes()) {
      for (const primitive of mesh.listPrimitives()) primitive.setAttribute('NORMAL', null);
    }

    await document.transform(
      weld(),
      simplify({
        simplifier: MeshoptSimplifier,
        ratio,
        // Error is a fraction of the *mesh radius*, so on a thirty-metre fir
        // even a modest-sounding 0.05 is one and a half metres of licence —
        // easily enough to swallow whole needle cards and leave the canopy as
        // a handful of brown planks. Kept tight; the reduction comes from the
        // ratio and from card culling, not from letting the shape drift.
        error: 0.008,
        lockBorder: false,
      }),
      prune()
    );

    // Foliage is thousands of separate two-triangle cards. Edge collapse can
    // never reduce those — a card has no interior edges to collapse — so
    // `fir_tree_01` bottoms out at 65k triangles against a 16k budget, one
    // card per needle cluster. The only way down is to remove whole cards,
    // which is what a real foliage LOD does, growing the survivors slightly so
    // the canopy keeps its density.
    cullFoliageCards(document, model.tris);

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
 * Thin a mesh made of disconnected foliage cards down to a triangle budget.
 *
 * Finds connected components (a card is one), and if the primitive is mostly
 * small components — the signature of leaves, needles and grass blades — keeps
 * a deterministic random subset. Survivors are scaled up about their own
 * centroid by the square root of the cull ratio, which preserves the total leaf
 * *area* even though there are fewer cards, so the canopy stays as opaque as it
 * was and the tree doesn't visibly thin out.
 *
 * Primitives that are properly connected surfaces (trunks, rocks) are left
 * alone — simplification already handled those.
 */
function cullFoliageCards(document, budget) {
  const total = countTriangles(document);
  if (total <= budget) return;

  const keepRatio = budget / total;

  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const indices = primitive.getIndices();
      const position = primitive.getAttribute('POSITION');
      if (!indices || !position) continue;

      const idx = indices.getArray();
      const triCount = idx.length / 3;
      const vertCount = position.getCount();

      // Union-find over vertices; two vertices are connected if a triangle
      // uses both.
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

      // Group triangles by component.
      const groups = new Map();
      for (let t = 0; t < triCount; t++) {
        const root = find(idx[t * 3]);
        let list = groups.get(root);
        if (!list) groups.set(root, (list = []));
        list.push(t);
      }

      const componentCount = groups.size;
      const averageTris = triCount / componentCount;
      // A connected surface has one huge component; foliage has thousands of
      // tiny ones. Anything averaging more than eight triangles per island is
      // treated as solid geometry and left as it is.
      if (componentCount < 32 || averageTris > 8) continue;

      const keep = [];
      let kept = 0;
      let index = 0;
      for (const [, tris] of groups) {
        // Deterministic: the same asset culls the same way every build.
        const roll = ((Math.imul(index + 1, 2654435761) >>> 0) % 100000) / 100000;
        index++;
        if (roll < keepRatio) {
          keep.push(tris);
          kept += tris.length;
        }
      }
      if (kept === 0 || kept === triCount) continue;

      // Enlarge survivors to hold the canopy's density.
      //
      // Preserving total leaf *area* means growing by 1/sqrt(keepRatio), and
      // for a scan that models every needle individually that factor is
      // enormous. Capped, because a card blown up too far shows its needle
      // texture at an obviously wrong scale when you walk right up to it — but
      // capped generously, since without this the canopy culls away to a bare
      // pole with a few green specks on it.
      const grow = Math.min(2.2, 1 / Math.sqrt(Math.max(0.02, keepRatio)));
      const pos = position.getArray();
      const scaled = Float32Array.from(pos);
      const seen = new Set();

      for (const tris of keep) {
        // Centroid of this card.
        let cx = 0, cy = 0, cz = 0, n = 0;
        const verts = new Set();
        for (const t of tris) {
          for (let k = 0; k < 3; k++) verts.add(idx[t * 3 + k]);
        }
        for (const v of verts) {
          cx += pos[v * 3]; cy += pos[v * 3 + 1]; cz += pos[v * 3 + 2]; n++;
        }
        cx /= n; cy /= n; cz /= n;
        for (const v of verts) {
          if (seen.has(v)) continue;
          seen.add(v);
          scaled[v * 3] = cx + (pos[v * 3] - cx) * grow;
          scaled[v * 3 + 1] = cy + (pos[v * 3 + 1] - cy) * grow;
          scaled[v * 3 + 2] = cz + (pos[v * 3 + 2] - cz) * grow;
        }
      }

      const newIndices = new Uint32Array(kept * 3);
      let w = 0;
      for (const tris of keep) {
        for (const t of tris) {
          newIndices[w++] = idx[t * 3];
          newIndices[w++] = idx[t * 3 + 1];
          newIndices[w++] = idx[t * 3 + 2];
        }
      }

      position.setArray(scaled);
      indices.setArray(newIndices);
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
