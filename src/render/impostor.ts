/**
 * Tree impostors.
 *
 * A silver fir is sixteen thousand triangles. A forest is several thousand
 * trees. Drawn honestly that is a hundred million triangles a frame, which no
 * browser is going to manage, so past a certain distance each tree becomes a
 * single camera-facing quad showing a picture of itself.
 *
 * The pictures are baked at load time rather than shipped: the model is
 * rendered into an atlas from eight directions around its vertical axis, and
 * the shader picks whichever tile is closest to how you are actually looking at
 * it. Baking at runtime costs a few milliseconds once, avoids adding megabytes
 * of atlas to the download, and means an impostor always matches the model it
 * stands in for.
 *
 * Two things make them hold up:
 *
 *  - Cylindrical billboarding. The quad turns about Y only, never pitching to
 *    face the camera, so a distant tree stays rooted in the ground instead of
 *    tipping backward as you look up.
 *  - Lighting at runtime, not baked. The atlas stores albedo and alpha only,
 *    and the shader relights it from the current sun with a spherical normal.
 *    Bake the light in and every distant tree keeps its noon shading through
 *    sunset, which is exactly the sort of thing that quietly ruins a view.
 */

import * as THREE from 'three';

/** Views baked around the vertical axis. */
const ANGLES = 8;

export interface Impostor {
  texture: THREE.Texture;
  /** Width / height of the model, so the quad gets the right proportions. */
  aspect: number;
  /** Fraction of the quad height that sits below the model's origin. */
  pivot: number;
  dispose(): void;
}

/**
 * Render a model into an angular atlas.
 *
 * The camera orbits the model horizontally at a slight downward tilt — matching
 * roughly how you see a tree a hundred metres away on a hillside — and each
 * view is written into one tile of a single wide texture.
 */
export function bakeImpostor(
  renderer: THREE.WebGLRenderer,
  meshes: THREE.Mesh[],
  tileSize = 256
): Impostor | null {
  if (!meshes.length) return null;

  const scene = new THREE.Scene();
  // Flat, even light: the atlas is an albedo sheet, and any directionality
  // baked in here would fight the runtime lighting.
  scene.add(new THREE.AmbientLight(0xffffff, Math.PI));

  const group = new THREE.Group();
  const clones: THREE.Mesh[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  for (const source of meshes) {
    // Bake from plain geometry. The live geometry carries the instancing
    // attribute the forest uses, and drawing that as a single mesh makes three
    // treat it as instanced — which is how the atlas ends up holding a flat
    // smear instead of a tree.
    const geometry = source.geometry.clone();
    geometry.deleteAttribute('aVariation');
    // Fresh bounds: never trust an inherited box when the framing of the whole
    // bake depends on it.
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    geometries.push(geometry);

    const material = (source.material as THREE.MeshStandardMaterial).clone();
    // Strip anything view- or light-dependent so the tile is pure albedo.
    material.roughness = 1;
    material.metalness = 0;
    material.envMapIntensity = 0;
    material.emissive = new THREE.Color(0, 0, 0);
    material.onBeforeCompile = () => {};
    material.customProgramCacheKey = () => 'impostor-bake';
    material.side = THREE.DoubleSide;

    const mesh = new THREE.Mesh(geometry, material);
    clones.push(mesh);
    group.add(mesh);
  }
  scene.add(group);

  const bounds = new THREE.Box3().setFromObject(group);
  const size = bounds.getSize(new THREE.Vector3());
  const centre = bounds.getCenter(new THREE.Vector3());

  const height = Math.max(1e-4, size.y);
  const radius = Math.max(1e-4, Math.max(size.x, size.z) * 0.5);
  // Square tiles keep the atlas simple; the quad is stretched to the real
  // aspect ratio at draw time instead.
  const halfExtent = Math.max(height * 0.5, radius) * 1.02;

  // No mipmaps, deliberately.
  //
  // An alpha-cutout atlas and mipmapping are fundamentally at odds: each mip
  // level averages alpha over a wider area, so by a few levels down a tile of
  // half-transparent foliage has an alpha near 0.5 everywhere and the cutout
  // test passes across the entire quad. Every distant tree then renders as a
  // solid rectangle with a picture of a tree inside it. Losing mips costs a
  // little shimmer at range; keeping them costs the whole effect.
  const target = new THREE.WebGLRenderTarget(tileSize * ANGLES, tileSize, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.SRGBColorSpace,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
    depthBuffer: true,
    stencilBuffer: false,
  });

  const camera = new THREE.OrthographicCamera(
    -halfExtent, halfExtent, halfExtent, -halfExtent, 0.01, radius * 8 + height * 8
  );

  // Save renderer state — this runs mid-session, and stomping the clear colour,
  // the render target or the viewport would take the main view with it. The
  // viewport in particular has to be read back rather than reconstructed from
  // the canvas size: three stores it in CSS pixels and scales by the pixel
  // ratio, so rebuilding it from `domElement.width` silently shrinks the
  // rendered area by the render scale and leaves most of the screen black.
  const previousTarget = renderer.getRenderTarget();
  const previousClear = renderer.getClearColor(new THREE.Color());
  const previousAlpha = renderer.getClearAlpha();
  const previousToneMapping = renderer.toneMapping;
  const previousViewport = renderer.getViewport(new THREE.Vector4());
  const previousScissor = renderer.getScissor(new THREE.Vector4());
  const previousScissorTest = renderer.getScissorTest();

  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 0);
  // No tonemapping: the atlas must hold plain albedo, and the main pipeline
  // will tonemap it again when the impostor is finally drawn.
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.clear(true, true, false);

  const distance = radius * 4 + height * 2;
  for (let i = 0; i < ANGLES; i++) {
    const theta = (i / ANGLES) * Math.PI * 2;
    // A few degrees above the horizontal: most distant trees are seen slightly
    // from above across a valley, and a dead-level bake looks oddly flat.
    const elevation = 0.14;
    camera.position.set(
      centre.x + Math.sin(theta) * Math.cos(elevation) * distance,
      centre.y + Math.sin(elevation) * distance,
      centre.z + Math.cos(theta) * Math.cos(elevation) * distance
    );
    camera.lookAt(centre);
    camera.updateProjectionMatrix();

    renderer.setViewport(i * tileSize, 0, tileSize, tileSize);
    renderer.setScissor(i * tileSize, 0, tileSize, tileSize);
    renderer.setScissorTest(true);
    renderer.render(scene, camera);
  }

  renderer.setRenderTarget(previousTarget);
  renderer.setViewport(previousViewport);
  renderer.setScissor(previousScissor);
  renderer.setScissorTest(previousScissorTest);
  renderer.setClearColor(previousClear, previousAlpha);
  renderer.toneMapping = previousToneMapping;

  for (const mesh of clones) (mesh.material as THREE.Material).dispose();
  for (const geometry of geometries) geometry.dispose();

  const texture = target.texture;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = 4;

  return {
    texture,
    aspect: (halfExtent * 2) / (halfExtent * 2),
    // Where the model's origin (its base) sits within the square tile.
    pivot: 0.5 - (centre.y - bounds.min.y) / (halfExtent * 2),
    dispose() {
      target.dispose();
    },
  };
}

/** A unit quad standing on its base, used for every impostor. */
export function createImpostorGeometry(halfExtent = 0.5, pivot = 0): THREE.PlaneGeometry {
  const geometry = new THREE.PlaneGeometry(halfExtent * 2, halfExtent * 2);
  // Raise it so the quad's centre sits where the model's centre did, given the
  // instance is positioned at the base of the trunk.
  geometry.translate(0, halfExtent - pivot * halfExtent * 2, 0);
  return geometry;
}

export interface ImpostorMaterialOptions {
  impostor: Impostor;
  /** Metres over which the impostor fades in as the mesh fades out. */
  fade: [number, number];
}

/**
 * The impostor shader.
 *
 * Billboards about Y, selects an atlas tile from the viewing angle, and relights
 * the albedo with the current sun. Instances carry the same matrix buffer the
 * real meshes use, so the two representations agree exactly on where a tree is.
 */
export function createImpostorMaterial(opts: ImpostorMaterialOptions): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: false,
    depthWrite: true,
    side: THREE.DoubleSide,
    uniforms: {
      uAtlas: { value: opts.impostor.texture },
      uAngles: { value: ANGLES },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uAmbient: { value: new THREE.Color(0.2, 0.24, 0.3) },
      uFogColor: { value: new THREE.Color(0.7, 0.8, 0.9) },
      uFogDensity: { value: 0.0004 },
      uFadeNear: { value: opts.fade[0] },
      uFadeFar: { value: opts.fade[1] },
      uTime: { value: 0 },
      uWind: { value: new THREE.Vector2(1, 0) },
      uGust: { value: 0.3 },
    },
    vertexShader: /* glsl */ `
      attribute vec2 aVariation;

      uniform float uTime;
      uniform vec2 uWind;
      uniform float uGust;

      varying vec2 vUv;
      varying float vAngle;
      varying float vViewDist;
      varying float vVariation;
      varying vec3 vWorldPos;

      void main() {
        vUv = uv;
        vVariation = aVariation.x;

        // Instance placement: column 3 is the translation, and the length of
        // column 0 recovers the uniform scale the scatterer applied.
        vec3 instancePos = instanceMatrix[3].xyz;
        float instanceScale = length(instanceMatrix[0].xyz);

        vec3 toCamera = cameraPosition - instancePos;

        // Cylindrical billboard: rotate about Y only. Pitching the quad to face
        // the camera would make distant trees lean back as you look up at a
        // ridge, which reads immediately as fake.
        vec3 right = normalize(vec3(toCamera.z, 0.0, -toCamera.x));
        vec3 up = vec3(0.0, 1.0, 0.0);

        vec3 local = position * instanceScale;
        vec3 world = instancePos + right * local.x + up * local.y;

        // The same wind that moves the real meshes, applied to the top of the
        // quad so a distant canopy still stirs.
        float lever = max(0.0, local.y) / max(0.001, instanceScale);
        float phase = dot(instancePos.xz, uWind) * 0.06 - uTime * 1.7;
        world.xz += uWind * sin(phase + vVariation * 6.28318) * (0.05 + uGust * 0.12) * lever * instanceScale * 0.08;

        vWorldPos = world;
        vViewDist = length(cameraPosition - world);

        // Which baked view are we looking at? Measured from the instance's own
        // heading so that rotated instances show a different face.
        float instanceYaw = atan(instanceMatrix[0].z, instanceMatrix[0].x);
        vAngle = atan(toCamera.x, toCamera.z) - instanceYaw;

        gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;

      uniform sampler2D uAtlas;
      uniform float uAngles;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform vec3 uAmbient;
      uniform vec3 uFogColor;
      uniform float uFogDensity;
      uniform float uFadeNear;
      uniform float uFadeFar;

      varying vec2 vUv;
      varying float vAngle;
      varying float vViewDist;
      varying float vVariation;
      varying vec3 vWorldPos;

      void main() {
        // Pick the nearest baked view and read its tile out of the atlas.
        float turns = vAngle / 6.2831853 + 1.0;
        float slot = floor(fract(turns) * uAngles + 0.5);
        slot = mod(slot, uAngles);

        vec2 uv = vec2((slot + vUv.x) / uAngles, vUv.y);
        vec4 texel = texture2D(uAtlas, uv);

        // Hard cutout. Blending would need per-instance sorting across a whole
        // forest, which is not affordable and not necessary.
        if (texel.a < 0.35) discard;

        // Fade the impostor in as the real mesh fades out. Dithering the
        // cutoff rather than blending keeps it order-independent — the swap
        // dissolves rather than popping.
        float fade = smoothstep(uFadeNear, uFadeFar, vViewDist);
        float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
        if (fade < dither * 0.999) discard;

        // Relight. The normal is approximated as a hemisphere bulging out of
        // the quad, which is a decent stand-in for a roughly spherical canopy
        // and makes the sun rake across a hillside of trees convincingly.
        vec2 centred = vUv * 2.0 - 1.0;
        vec3 normal = normalize(vec3(centred.x * 0.75, centred.y * 0.35, 0.9));
        vec3 viewDir = normalize(cameraPosition - vWorldPos);
        vec3 right = normalize(vec3(viewDir.z, 0.0, -viewDir.x));
        vec3 worldNormal = normalize(right * normal.x + vec3(0.0, 1.0, 0.0) * normal.y + viewDir * normal.z);

        // Wrapped diffuse: foliage transmits a good deal of light, so the
        // shaded side of a tree is never as dark as a solid object's would be.
        float ndl = dot(worldNormal, uSunDir);
        float wrapped = clamp((ndl + 0.55) / 1.55, 0.0, 1.0);

        vec3 albedo = texel.rgb;
        albedo *= mix(0.84, 1.14, vVariation);

        vec3 color = albedo * (uAmbient + uSunColor * wrapped);

        // Match the scene's exponential-squared fog so impostors sit in the
        // same air as everything else.
        float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * vViewDist * vViewDist);
        color = mix(color, uFogColor, clamp(fogFactor, 0.0, 1.0));

        gl_FragColor = vec4(color, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
}

export { ANGLES as IMPOSTOR_ANGLES };
