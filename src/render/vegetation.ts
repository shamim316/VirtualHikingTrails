/**
 * Everything that grows, drawn.
 *
 * The scatterer decides where plants are; this decides how to get tens of
 * thousands of them on screen at a playable frame rate. Three ideas carry it:
 *
 *  - **One instanced mesh per species variant, covering every visible cell.**
 *    Per-cell meshes would be easier to keep in sync but would cost well over a
 *    thousand draw calls; this costs a couple of hundred. The price is that the
 *    instance buffers must be repacked when the visible set changes, which is
 *    why that happens every few metres of walking rather than every frame.
 *
 *  - **Variants.** Poly Haven publishes each plant as a set — three whole firs,
 *    four ferns, seventeen grass tufts — and the pipeline keeps them apart. Each
 *    plant picks one deterministically, so a stand of trees is a stand of
 *    different trees rather than one tree pasted three hundred times.
 *
 *  - **Impostors past the middle distance.** A fir is sixteen thousand
 *    triangles; a forest is thousands of firs. Beyond about fifty metres each
 *    becomes a billboard of itself. See `impostor.ts`.
 *
 * Wind is a vertex effect driven by the same gust value the audio uses, so when
 * you hear the wind rise in the canopy, the canopy is moving with it.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  SCATTER_CELL,
  INSTANCE_STRIDE,
  scatterKey,
  type ScatterReady,
  type ScatterRequest,
  type ScatterSpecies,
} from '../world/scatter-protocol';
import { SPECIES, type Species } from '../game/species';
import { bakeImpostor, createImpostorGeometry, createImpostorMaterial, type Impostor } from './impostor';
import type { QualitySettings } from '../core/quality';

/** How far the player must move before the instance buffers are repacked. */
const REBUILD_DISTANCE = 6;

/**
 * Convert quantized vertex attributes to plain floats.
 *
 * The asset pipeline packs positions with `KHR_mesh_quantization`, so they
 * arrive as *normalized Int16Array* — a 16-bit lattice plus a decode transform
 * on the node. That is exactly what you want on the wire, and a trap the moment
 * you transform the geometry: `applyMatrix4`, `translate` and `scale` all write
 * their results straight back into the same integer array. Normalising a
 * nineteen-metre fir to unit height multiplies every coordinate by 1/19, and on
 * a 16-bit grid the whole tree collapses onto a handful of integer steps — which
 * is why the forest was drawing as hollow cages of axis-aligned bars while the
 * very same file rendered perfectly when loaded and left untransformed.
 *
 * Widening to Float32 first costs a few hundred kilobytes per model in memory
 * and makes every later transform exact.
 */
function dequantize(geometry: THREE.BufferGeometry): void {
  for (const name of Object.keys(geometry.attributes)) {
    const attribute = geometry.attributes[name] as THREE.BufferAttribute;
    if (attribute.array instanceof Float32Array && !attribute.normalized) continue;

    const widened = new Float32Array(attribute.count * attribute.itemSize);
    for (let i = 0; i < attribute.count; i++) {
      for (let c = 0; c < attribute.itemSize; c++) {
        // getComponent applies the normalized decode for us.
        widened[i * attribute.itemSize + c] = attribute.getComponent(i, c);
      }
    }
    geometry.setAttribute(name, new THREE.BufferAttribute(widened, attribute.itemSize, false));
  }
}

const IMPOSTORS_ENABLED = true;

/** Per-group draw radius as a multiple of the tier's vegetation distance. */
const GROUP_RANGE: Record<string, number> = {
  canopy: 3.4,     // trees have to be visible across a valley
  deadwood: 1.0,
  understory: 1.0,
  rock: 1.6,
  flower: 0.75,
  ground: 0.55,    // grass, only underfoot
};

interface VariantRender {
  /** One instanced mesh per material in this variant. */
  meshes: THREE.InstancedMesh[];
  matrix: THREE.InstancedBufferAttribute;
  variation: THREE.InstancedBufferAttribute;
  capacity: number;
}

interface SpeciesRender {
  species: Species;
  variants: VariantRender[];
  /** Metres; beyond this the species isn't drawn at all. */
  range: number;
  /** Real geometry within this radius, billboards beyond it. */
  meshRange: number;

  impostor: Impostor | null;
  impostorMesh: THREE.InstancedMesh | null;
  impostorMatrix: THREE.InstancedBufferAttribute | null;
  impostorVariation: THREE.InstancedBufferAttribute | null;
  impostorCapacity: number;
  /** Kept until the atlas is baked, then released. */
  bakeSources: THREE.Mesh[] | null;
}

interface ScatterCell {
  key: string;
  centreX: number;
  centreZ: number;
  instances: Record<number, Float32Array>;
}

export interface VegetationOptions {
  seed: number;
  workers: number;
  basePath: string;
}

export class Vegetation {
  readonly group = new THREE.Group();
  /** Resolves once every model has loaded. */
  readonly ready: Promise<void>;

  private renderers = new Map<number, SpeciesRender>();
  private cells = new Map<string, ScatterCell>();
  private pending = new Set<string>();
  private workers: Worker[] = [];
  private nextWorker = 0;
  private lastRebuildAt = new THREE.Vector3(Infinity, 0, Infinity);
  private dirty = true;
  private settings: QualitySettings | null = null;
  private disposed = false;
  private windUniforms: Array<{
    uTime: { value: number };
    uWind: { value: THREE.Vector2 };
    uGust: { value: number };
  }> = [];

  constructor(private opts: VegetationOptions) {
    this.group.name = 'vegetation';

    const table: ScatterSpecies[] = SPECIES.map((s, index) => ({
      id: s.id,
      index,
      biomes: s.habitat.biomes as unknown as number[],
      altitudeMin: s.habitat.altitude[0],
      altitudeMax: s.habitat.altitude[1],
      maxSlope: s.habitat.maxSlope,
      moisture: s.habitat.moisture,
      canopy: s.habitat.canopy,
      density: s.habitat.density,
      clumping: s.habitat.clumping,
      heightMin: s.height[0],
      heightMax: s.height[1],
      group: s.group,
    }));

    const count = Math.max(1, Math.min(opts.workers, 4));
    for (let i = 0; i < count; i++) {
      const worker = new Worker(new URL('../world/scatter-worker.ts', import.meta.url), { type: 'module' });
      worker.postMessage({ type: 'init', seed: opts.seed, species: table });
      worker.onmessage = (e: MessageEvent<ScatterReady>) => this.onCell(e.data);
      this.workers.push(worker);
    }

    this.ready = this.loadModels();
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  private async loadModels(): Promise<void> {
    const loader = new GLTFLoader();

    await Promise.all(
      SPECIES.map(async (species, index) => {
        const url = `${this.opts.basePath}/models/${species.id}.glb`;
        let gltf;
        try {
          gltf = await loader.loadAsync(url);
        } catch {
          // A missing model must not take the world down with it; the species
          // simply doesn't appear.
          console.warn(`vegetation: no model for ${species.id}, skipping`);
          return;
        }
        if (this.disposed) return;

        gltf.scene.updateMatrixWorld(true);

        // Each top-level child of the file is one variant of the plant. Within
        // a variant there may be several meshes, one per material.
        const variantSources: THREE.Mesh[][] = [];
        for (const child of gltf.scene.children) {
          const meshes: THREE.Mesh[] = [];
          child.traverse((node) => {
            if ((node as THREE.Mesh).isMesh) meshes.push(node as THREE.Mesh);
          });
          if (meshes.length) variantSources.push(meshes);
        }
        if (!variantSources.length) return;

        const totalCapacity = this.capacityFor(species);
        // Instances spread unevenly across variants, so each gets headroom
        // rather than an exact share.
        const perVariant = Math.ceil((totalCapacity / variantSources.length) * 1.8);

        const variants: VariantRender[] = [];
        for (const sources of variantSources) {
          // Normalise the variant to unit height, standing on its own base and
          // centred in x/z, so the scatterer's scale means "metres tall".
          const bounds = new THREE.Box3();
          for (const source of sources) {
            const position = source.geometry.getAttribute('position') as THREE.BufferAttribute;
            bounds.union(
              new THREE.Box3().setFromBufferAttribute(position).applyMatrix4(source.matrixWorld)
            );
          }
          const naturalHeight = bounds.max.y - bounds.min.y;
          const naturalWidth = Math.max(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z);

          // Normalise by height so the scatterer can ask for a plant "one metre
          // tall" — but not by height *alone*. A moss mat is a metre across and
          // two centimetres deep; scaling that to a tenth of a metre tall makes
          // it five metres wide, and the hillside fills with flat slabs. Taking
          // the width into account leaves anything upright untouched and keeps
          // ground cover the size ground cover should be.
          const height = Math.max(0.02, naturalHeight, naturalWidth * 0.35);
          const cx = (bounds.min.x + bounds.max.x) / 2;
          const cz = (bounds.min.z + bounds.max.z) / 2;

          const matrix = new THREE.InstancedBufferAttribute(new Float32Array(perVariant * 16), 16);
          matrix.setUsage(THREE.DynamicDrawUsage);
          const variation = new THREE.InstancedBufferAttribute(new Float32Array(perVariant * 2), 2);
          variation.setUsage(THREE.DynamicDrawUsage);

          const meshes: THREE.InstancedMesh[] = [];
          for (const source of sources) {
            const geometry = source.geometry.clone();
            dequantize(geometry);
            geometry.applyMatrix4(source.matrixWorld);
            geometry.translate(-cx, -bounds.min.y, -cz);
            geometry.scale(1 / height, 1 / height, 1 / height);
            // Recompute both bounds after the transforms — anything reading a
            // stale box (Box3.setFromObject, and so the impostor bake) would
            // otherwise frame geometry at a size it no longer has.
            geometry.computeBoundingBox();
            geometry.computeBoundingSphere();

            const material = this.prepareMaterial(source.material as THREE.Material, species);

            const mesh = new THREE.InstancedMesh(geometry, material, perVariant);
            mesh.instanceMatrix = matrix;
            mesh.geometry.setAttribute('aVariation', variation);
            mesh.count = 0;
            mesh.visible = false;
            mesh.castShadow = species.group === 'canopy' || species.group === 'rock';
            mesh.receiveShadow = true;
            // Instances span the whole visible area, so there is no meaningful
            // bounding volume to cull against.
            mesh.frustumCulled = false;
            mesh.name = `veg:${species.id}:${variants.length}`;
            meshes.push(mesh);
            this.group.add(mesh);
          }

          variants.push({ meshes, matrix, variation, capacity: perVariant });
        }

        // Only tall things earn an impostor: for anything you can step over,
        // drawing the real mesh within a small radius is simply cheaper than
        // the machinery to avoid it. One atlas is baked from the first variant
        // and shared — at fifty metres nobody can tell the variants apart.
        const wantsImpostor = IMPOSTORS_ENABLED && species.group === 'canopy' && species.height[1] >= 4;

        this.renderers.set(index, {
          species,
          variants,
          range: 0,
          meshRange: Infinity,
          impostor: null,
          impostorMesh: null,
          impostorMatrix: null,
          impostorVariation: null,
          impostorCapacity: totalCapacity,
          bakeSources: wantsImpostor
            ? variants[0].meshes.map((m) => new THREE.Mesh(m.geometry, m.material as THREE.Material))
            : null,
        });
      })
    );

    this.dirty = true;
  }

  /**
   * How many instances of a species can ever be on screen.
   *
   * Derived from its density and draw radius rather than guessed, with generous
   * headroom — overflowing drops plants, which looks like bald patches
   * appearing as you turn around.
   */
  private capacityFor(species: Species): number {
    const range = 150 * (GROUP_RANGE[species.group] ?? 1);
    const hectares = (Math.PI * range * range) / 10000;
    return Math.ceil(Math.min(40000, Math.max(64, hectares * species.habitat.density * 0.5)));
  }

  /**
   * Prepare a model's material for instancing: alpha cutout, two-sided leaves,
   * wind, and per-instance colour variation.
   */
  private prepareMaterial(source: THREE.Material, species: Species): THREE.Material {
    const material = (source as THREE.MeshStandardMaterial).clone() as THREE.MeshStandardMaterial;

    // Scanned foliage relies on alpha cutout. Blending would need per-instance
    // sorting across a whole forest, which is unaffordable and unnecessary.
    const leafy = species.group === 'canopy' || species.group === 'understory'
      || species.group === 'flower' || species.group === 'ground';
    if (leafy || material.transparent || material.alphaTest > 0 || material.alphaMap) {
      material.transparent = false;
      material.alphaTest = 0.42;
      material.side = THREE.DoubleSide;
      material.depthWrite = true;
    }

    material.shadowSide = THREE.DoubleSide;
    material.roughness = Math.max(0.55, material.roughness);

    const isPlant = species.group !== 'rock' && species.group !== 'deadwood';
    // Grass and flowers bend a long way; a fir trunk barely moves.
    const sway = isPlant ? (species.group === 'canopy' ? 0.22 : 0.62) : 0;

    const uniforms = {
      uTime: { value: 0 },
      uWind: { value: new THREE.Vector2(1, 0) },
      uGust: { value: 0.3 },
    };
    this.windUniforms.push(uniforms);

    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          /* glsl */ `
          #include <common>
          attribute vec2 aVariation;
          uniform float uTime;
          uniform vec2 uWind;
          uniform float uGust;
          varying float vTint;
          `
        )
        .replace(
          '#include <begin_vertex>',
          /* glsl */ `
          #include <begin_vertex>
          vTint = aVariation.x;

          #ifdef USE_INSTANCING
          {
            // Where this plant is rooted, in world space.
            vec3 rootWorld = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;

            // Bend grows with height up the plant, squared, so the base stays
            // put and the tip travels — which is how a stem actually behaves,
            // and reads far better than translating the whole model.
            float heightUp = max(0.0, transformed.y);
            float lever = heightUp * heightUp * ${sway.toFixed(3)};

            if (lever > 0.0001) {
              // One travelling wave across the world, so a gust crosses a
              // hillside as a wave rather than everything swaying in unison.
              float phase = dot(rootWorld.xz, uWind) * 0.06 - uTime * 1.7;
              float swayAmount = sin(phase + aVariation.x * 6.28318);
              float flutter = sin(phase * 3.3 + aVariation.y * 6.28318) * 0.35;

              float strength = (0.35 + uGust * 0.9) * lever;
              transformed.xz += uWind * (swayAmount + flutter) * strength;
              // Plants shorten slightly as they bend rather than stretching.
              transformed.y -= abs(swayAmount) * strength * 0.25;
            }
          }
          #endif
          `
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          /* glsl */ `
          #include <common>
          varying float vTint;
          `
        )
        .replace(
          '#include <color_fragment>',
          /* glsl */ `
          #include <color_fragment>
          {
            // Per-instance colour drift. A stand of identical clones is the
            // clearest possible signal that something was copy-pasted; a few
            // percent of variation in brightness and warmth removes it.
            float t = vTint;
            diffuseColor.rgb *= mix(0.82, 1.16, t);
            diffuseColor.rgb *= mix(vec3(0.94, 1.0, 0.92), vec3(1.08, 0.98, 0.86), fract(t * 3.17));
          }
          `
        );
    };

    material.customProgramCacheKey = () => `veg-${species.group}-${sway.toFixed(2)}`;
    return material;
  }

  // -------------------------------------------------------------------------
  // Impostors
  // -------------------------------------------------------------------------

  /**
   * Bake the billboard atlases, a couple per call.
   *
   * Deferred until a renderer exists and the models have loaded, and spread
   * across frames so a dozen render-to-texture passes don't land in the same
   * frame as everything else that happens at startup.
   */
  bakeImpostors(renderer: THREE.WebGLRenderer, budget = 2) {
    if (this.disposed) return;
    let baked = 0;

    for (const entry of this.renderers.values()) {
      if (baked >= budget) return;
      if (!entry.bakeSources || entry.impostor) continue;

      const impostor = bakeImpostor(renderer, entry.bakeSources, 256);
      entry.bakeSources = null;
      if (!impostor) continue;
      entry.impostor = impostor;

      const capacity = entry.impostorCapacity;
      const matrix = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 16), 16);
      matrix.setUsage(THREE.DynamicDrawUsage);
      const variation = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
      variation.setUsage(THREE.DynamicDrawUsage);

      const geometry = createImpostorGeometry(0.5, impostor.pivot);
      const material = createImpostorMaterial({ impostor, fade: [0, 1] });

      const mesh = new THREE.InstancedMesh(geometry, material, capacity);
      mesh.instanceMatrix = matrix;
      mesh.geometry.setAttribute('aVariation', variation);
      mesh.count = 0;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.name = `impostor:${entry.species.id}`;

      entry.impostorMesh = mesh;
      entry.impostorMatrix = matrix;
      entry.impostorVariation = variation;
      this.group.add(mesh);

      baked++;
      this.dirty = true;
    }
  }

  get impostorsPending(): boolean {
    for (const entry of this.renderers.values()) {
      if (entry.bakeSources) return true;
    }
    return false;
  }

  /** Keep the impostor shaders in step with the sun, sky and fog. */
  setLighting(
    sunDir: THREE.Vector3,
    sunColor: THREE.Color,
    ambient: THREE.Color,
    fogColor: THREE.Color,
    fogDensity: number
  ) {
    for (const entry of this.renderers.values()) {
      const material = entry.impostorMesh?.material as THREE.ShaderMaterial | undefined;
      if (!material) continue;
      material.uniforms.uSunDir.value.copy(sunDir);
      material.uniforms.uSunColor.value.copy(sunColor);
      material.uniforms.uAmbient.value.copy(ambient);
      material.uniforms.uFogColor.value.copy(fogColor);
      material.uniforms.uFogDensity.value = fogDensity;
    }
  }

  // -------------------------------------------------------------------------
  // Streaming
  // -------------------------------------------------------------------------

  update(
    camera: THREE.Camera,
    settings: QualitySettings,
    dt: number,
    elapsed: number,
    wind: { x: number; z: number; gust: number }
  ) {
    if (this.disposed) return;
    this.settings = settings;
    void dt;

    for (const uniforms of this.windUniforms) {
      uniforms.uTime.value = elapsed;
      uniforms.uWind.value.set(wind.x, wind.z);
      uniforms.uGust.value = wind.gust;
    }
    for (const entry of this.renderers.values()) {
      const material = entry.impostorMesh?.material as THREE.ShaderMaterial | undefined;
      if (!material) continue;
      material.uniforms.uTime.value = elapsed;
      material.uniforms.uWind.value.set(wind.x, wind.z);
      material.uniforms.uGust.value = wind.gust;
    }

    const camX = camera.position.x;
    const camZ = camera.position.z;

    const maxRange = settings.vegetationDistance * Math.max(...Object.values(GROUP_RANGE));
    const cellRadius = Math.ceil(maxRange / SCATTER_CELL) + 1;
    const centreX = Math.floor(camX / SCATTER_CELL);
    const centreZ = Math.floor(camZ / SCATTER_CELL);

    // Request missing cells, nearest first.
    const missing: Array<{ x: number; z: number; d: number }> = [];
    for (let dz = -cellRadius; dz <= cellRadius; dz++) {
      for (let dx = -cellRadius; dx <= cellRadius; dx++) {
        const cx = centreX + dx;
        const cz = centreZ + dz;
        const key = scatterKey(cx, cz);
        if (this.cells.has(key) || this.pending.has(key)) continue;

        const cellCentreX = (cx + 0.5) * SCATTER_CELL;
        const cellCentreZ = (cz + 0.5) * SCATTER_CELL;
        const distance = Math.hypot(cellCentreX - camX, cellCentreZ - camZ);
        if (distance > maxRange + SCATTER_CELL) continue;
        missing.push({ x: cx, z: cz, d: distance });
      }
    }
    missing.sort((a, b) => a.d - b.d);
    const budget = Math.max(2, this.workers.length * 4) - this.pending.size;
    for (let i = 0; i < Math.min(budget, missing.length); i++) {
      this.request(missing[i].x, missing[i].z);
    }

    // Drop cells well outside the radius. The hysteresis stops them thrashing
    // when you pace back and forth over a boundary.
    const dropDistance = maxRange + SCATTER_CELL * 3;
    for (const [key, cell] of this.cells) {
      if (Math.hypot(cell.centreX - camX, cell.centreZ - camZ) > dropDistance) {
        this.cells.delete(key);
        this.dirty = true;
      }
    }

    if (this.dirty || this.lastRebuildAt.distanceTo(camera.position) > REBUILD_DISTANCE) {
      this.rebuild(camX, camZ, settings);
      this.lastRebuildAt.copy(camera.position);
      this.dirty = false;
    }
  }

  private request(cellX: number, cellZ: number) {
    const key = scatterKey(cellX, cellZ);
    this.pending.add(key);
    const req: ScatterRequest = {
      type: 'cell',
      key,
      cellX,
      cellZ,
      density: this.settings?.vegetationDensity ?? 1,
    };
    this.workers[this.nextWorker].postMessage(req);
    this.nextWorker = (this.nextWorker + 1) % this.workers.length;
  }

  private onCell(data: ScatterReady) {
    if (this.disposed) return;
    this.pending.delete(data.key);
    this.cells.set(data.key, {
      key: data.key,
      centreX: (data.cellX + 0.5) * SCATTER_CELL,
      centreZ: (data.cellZ + 0.5) * SCATTER_CELL,
      instances: data.instances,
    });
    this.dirty = true;
  }

  // -------------------------------------------------------------------------
  // Instance buffers
  // -------------------------------------------------------------------------

  private scratchMatrix = new THREE.Matrix4();
  private scratchQuat = new THREE.Quaternion();
  private scratchEuler = new THREE.Euler();
  private scratchPos = new THREE.Vector3();
  private scratchScale = new THREE.Vector3();
  private variantCounts: number[] = [];

  /**
   * Repack every species' instance buffers from the loaded cells.
   *
   * Runs only when the visible set changes, which in practice is every six
   * metres of walking. Deliberately allocation-free inside.
   */
  private rebuild(camX: number, camZ: number, settings: QualitySettings) {
    for (const renderer of this.renderers.values()) {
      const groupRange = GROUP_RANGE[renderer.species.group] ?? 1;
      const range = renderer.species.group === 'ground'
        ? settings.grassDistance
        : settings.vegetationDistance * groupRange;
      renderer.range = range;

      // Where real geometry gives way to billboards. Trees stay solid for the
      // distance you would actually walk among them; anything without an
      // impostor is drawn as a mesh all the way out.
      const meshRange = renderer.impostorMesh
        ? Math.min(range, settings.vegetationDistance * 0.85)
        : range;
      renderer.meshRange = meshRange;

      const impostorMaterial = renderer.impostorMesh?.material as THREE.ShaderMaterial | undefined;
      if (impostorMaterial) {
        // Overlap the bands so the swap dissolves instead of popping.
        impostorMaterial.uniforms.uFadeNear.value = meshRange * 0.8;
        impostorMaterial.uniforms.uFadeFar.value = meshRange;
      }

      const rangeSq = range * range;
      const meshRangeSq = meshRange * meshRange;
      const variants = renderer.variants;
      const variantCount = variants.length;
      const speciesIndex = SPECIES.indexOf(renderer.species);

      this.variantCounts.length = variantCount;
      this.variantCounts.fill(0);

      const impostorMatrices = renderer.impostorMatrix?.array as Float32Array | undefined;
      const impostorVariations = renderer.impostorVariation?.array as Float32Array | undefined;
      let impostorsWritten = 0;

      for (const cell of this.cells.values()) {
        // Whole-cell rejection first: most cells hold nothing for most species.
        if (Math.hypot(cell.centreX - camX, cell.centreZ - camZ) - SCATTER_CELL > range) continue;

        const packed = cell.instances[speciesIndex];
        if (!packed) continue;

        for (let i = 0; i + INSTANCE_STRIDE <= packed.length; i += INSTANCE_STRIDE) {
          const x = packed[i];
          const y = packed[i + 1];
          const z = packed[i + 2];

          const dx = x - camX;
          const dz = z - camZ;
          const distSq = dx * dx + dz * dz;
          if (distSq > rangeSq) continue;

          const rotY = packed[i + 3];
          const scale = packed[i + 4];
          const tilt = packed[i + 5];
          const variation = packed[i + 6];

          // Which variant this plant is. Derived from its own hash, so it never
          // changes as you walk toward it.
          const variantIndex = Math.min(variantCount - 1, (variation * variantCount) | 0);
          const variant = variants[variantIndex];

          this.scratchPos.set(x, y, z);
          this.scratchScale.setScalar(scale);

          if (distSq <= meshRangeSq && this.variantCounts[variantIndex] < variant.capacity) {
            // Lean with the slope, the lean direction tied to the instance's
            // own rotation so it doesn't read as a systematic bias.
            this.scratchEuler.set(
              Math.cos(rotY) * tilt * 0.5,
              rotY,
              Math.sin(rotY) * tilt * 0.5,
              'YXZ'
            );
            this.scratchQuat.setFromEuler(this.scratchEuler);
            this.scratchMatrix.compose(this.scratchPos, this.scratchQuat, this.scratchScale);

            const slot = this.variantCounts[variantIndex]++;
            this.scratchMatrix.toArray(variant.matrix.array as Float32Array, slot * 16);
            const variations = variant.variation.array as Float32Array;
            variations[slot * 2] = variation;
            variations[slot * 2 + 1] = (variation * 7.31) % 1;
          }

          if (
            impostorMatrices && impostorVariations &&
            distSq > meshRangeSq * 0.62 &&
            impostorsWritten < renderer.impostorCapacity
          ) {
            // Billboards ignore tilt: a leaning quad reads as a mistake.
            this.scratchEuler.set(0, rotY, 0, 'YXZ');
            this.scratchQuat.setFromEuler(this.scratchEuler);
            this.scratchMatrix.compose(this.scratchPos, this.scratchQuat, this.scratchScale);
            this.scratchMatrix.toArray(impostorMatrices, impostorsWritten * 16);
            impostorVariations[impostorsWritten * 2] = variation;
            impostorVariations[impostorsWritten * 2 + 1] = (variation * 7.31) % 1;
            impostorsWritten++;
          }
        }
      }

      for (let v = 0; v < variantCount; v++) {
        const variant = variants[v];
        const count = this.variantCounts[v];
        variant.matrix.needsUpdate = true;
        variant.variation.needsUpdate = true;
        for (const mesh of variant.meshes) {
          mesh.count = count;
          // Hiding empties keeps them out of the render list entirely rather
          // than issuing a zero-instance draw.
          mesh.visible = count > 0;
        }
      }

      if (renderer.impostorMesh && renderer.impostorMatrix && renderer.impostorVariation) {
        renderer.impostorMatrix.needsUpdate = true;
        renderer.impostorVariation.needsUpdate = true;
        renderer.impostorMesh.count = impostorsWritten;
        renderer.impostorMesh.visible = impostorsWritten > 0;
      }
    }
  }

  /** Total plants currently drawn, for the debug readout. */
  get instanceCount(): number {
    let total = 0;
    for (const renderer of this.renderers.values()) {
      for (const variant of renderer.variants) total += variant.meshes[0]?.count ?? 0;
      total += renderer.impostorMesh?.count ?? 0;
    }
    return total;
  }

  get loadedCells(): number {
    return this.cells.size;
  }

  dispose() {
    this.disposed = true;
    for (const worker of this.workers) worker.terminate();
    this.workers.length = 0;
    for (const renderer of this.renderers.values()) {
      for (const variant of renderer.variants) {
        for (const mesh of variant.meshes) {
          mesh.geometry.dispose();
          (mesh.material as THREE.Material).dispose();
        }
      }
      renderer.impostorMesh?.geometry.dispose();
      (renderer.impostorMesh?.material as THREE.Material | undefined)?.dispose();
      renderer.impostor?.dispose();
    }
    this.renderers.clear();
    this.cells.clear();
    this.group.clear();
  }
}
