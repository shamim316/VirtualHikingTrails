/**
 * One asset, on its own, at a known scale.
 *
 * A deliberately dumb viewer: no terrain, no weather, no impostors, no
 * instancing. Whatever is wrong with a model is the only thing in the frame,
 * and a one-metre grid plus a two-metre pole make it obvious whether the thing
 * is the size it claims to be.
 *
 *   /preview.html?model=fir_tree&angle=0.6&variant=0
 *
 * `dequantize` is duplicated from the vegetation renderer rather than shared,
 * because the point of this page is to be independent of it: if the two ever
 * disagree, that disagreement is the bug worth seeing.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const params = new URLSearchParams(location.search);
const MODEL = params.get('model') ?? 'fir_tree';
const ANGLE = Number(params.get('angle') ?? 0.6);
const VARIANT = params.get('variant') === null ? null : Number(params.get('variant'));
/** Frame the whole model, or stand at eye height a few metres away. */
const EYE = params.has('eye');

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const label = document.getElementById('label')!;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x6a7a86);

const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 500);

// Plain three-point-ish lighting. Nothing here should flatter the asset.
scene.add(new THREE.HemisphereLight(0xbdd3e6, 0x53483a, 1.6));
const key = new THREE.DirectionalLight(0xfff2e0, 2.6);
key.position.set(4, 7, 5);
scene.add(key);

// A one-metre grid and a two-metre pole: scale errors are the failure mode
// that reads as "the model is fine, the game is wrong".
const grid = new THREE.GridHelper(40, 40, 0x2f3a42, 0x46535c);
scene.add(grid);
const pole = new THREE.Mesh(
  new THREE.CylinderGeometry(0.03, 0.03, 2, 8),
  new THREE.MeshBasicMaterial({ color: 0xff5a3c })
);
pole.position.set(1.2, 1, 1.2);
scene.add(pole);

function dequantize(geometry: THREE.BufferGeometry): void {
  for (const name of Object.keys(geometry.attributes)) {
    const attribute = geometry.attributes[name] as THREE.BufferAttribute;
    if (attribute.array instanceof Float32Array && !attribute.normalized) continue;
    const widened = new Float32Array(attribute.count * attribute.itemSize);
    for (let i = 0; i < attribute.count; i++) {
      for (let c = 0; c < attribute.itemSize; c++) {
        widened[i * attribute.itemSize + c] = attribute.getComponent(i, c);
      }
    }
    geometry.setAttribute(name, new THREE.BufferAttribute(widened, attribute.itemSize, false));
  }
}

const state = { ready: false, triangles: 0, height: 0, variants: 0, note: '' };
Object.assign(window as unknown as Record<string, unknown>, { preview: state, THREE });

const loader = new GLTFLoader();
const url = `${import.meta.env.BASE_URL}assets/models/${MODEL}.glb`.replace(/\/{2,}/g, '/');

loader.load(
  url,
  (gltf) => {
    const roots = gltf.scene.children.slice();
    state.variants = roots.length;

    const group = new THREE.Group();
    for (let i = 0; i < roots.length; i++) {
      if (VARIANT !== null && i !== VARIANT) continue;
      const root = roots[i];
      root.updateMatrixWorld(true);
      root.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        dequantize(mesh.geometry);
        const material = mesh.material as THREE.MeshStandardMaterial;
        // Poly Haven marks some card soups OPAQUE, so the cutout has to be
        // applied here exactly as the game applies it.
        material.alphaTest = 0.18;
        material.transparent = false;
        material.side = THREE.DoubleSide;
        const index = mesh.geometry.index;
        state.triangles += (index ? index.count : mesh.geometry.attributes.position.count) / 3;
      });
      group.add(root);
    }
    scene.add(group);

    // Lay the variants out along X so they don't overlap.
    const box = new THREE.Box3().setFromObject(group);
    const size = new THREE.Vector3();
    box.getSize(size);
    state.height = size.y;

    if (VARIANT === null && roots.length > 1) {
      let x = 0;
      for (const root of group.children) {
        const rootBox = new THREE.Box3().setFromObject(root);
        const rootSize = new THREE.Vector3();
        rootBox.getSize(rootSize);
        root.position.x += x - rootBox.min.x;
        x += rootSize.x * 1.15;
      }
    }

    const framed = new THREE.Box3().setFromObject(group);
    const centre = new THREE.Vector3();
    framed.getCenter(centre);
    const extent = framed.getSize(new THREE.Vector3());
    const radius = Math.max(extent.x, extent.y, extent.z) * 0.62;

    if (EYE) {
      // Standing next to it, which is the view that actually matters in play.
      // Framed on the group's centre rather than the origin: with the variants
      // laid out along X, the origin is off to one side of them.
      const distance = Math.max(7, extent.x * 0.35 + 7);
      camera.position.set(
        centre.x + Math.sin(ANGLE) * distance,
        1.7,
        centre.z + Math.cos(ANGLE) * distance
      );
      camera.lookAt(centre.x, Math.min(extent.y * 0.42, 8), centre.z);
    } else {
      const distance = radius / Math.tan((camera.fov * Math.PI) / 360);
      camera.position.set(
        centre.x + Math.sin(ANGLE) * distance,
        centre.y + radius * 0.25,
        centre.z + Math.cos(ANGLE) * distance
      );
      camera.lookAt(centre);
    }

    state.ready = true;
    label.textContent =
      `${MODEL}\n${Math.round(state.triangles).toLocaleString()} tris  ` +
      `${state.variants} variant(s)\nheight ${size.y.toFixed(2)}m  ` +
      `width ${size.x.toFixed(2)}m\ngrid 1m, pole 2m`;
  },
  undefined,
  (err) => {
    state.note = String(err);
    label.textContent = `failed to load ${url}\n${err}`;
    state.ready = true;
  }
);

function resize() {
  const width = canvas.clientWidth || innerWidth;
  const height = canvas.clientHeight || innerHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / Math.max(1, height);
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

renderer.setAnimationLoop(() => renderer.render(scene, camera));
