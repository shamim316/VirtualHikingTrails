/**
 * The ground shader.
 *
 * Built on three's physical material so shadows, image-based lighting and fog
 * all keep working, with the surface itself replaced: four texture-array layers
 * blended by the per-vertex weights the mesher computed, sampled top-down on
 * gentle ground and triplanar on anything steep enough that a flat projection
 * would smear.
 *
 * Three things do most of the work in making it read as real ground rather than
 * as a repeating texture:
 *
 *  - Macro variation. A very large noise texture modulates brightness and tint,
 *    so the eye stops finding the tile.
 *  - Detail fade. Past a few dozen metres the high-frequency layers converge to
 *    their average colour, which kills the shimmer that fine textures produce
 *    under a moving camera.
 *  - Wetness. Streambeds and rain darken albedo and drop roughness, which is
 *    most of what wet ground actually looks like.
 */

import * as THREE from 'three';
import type { GroundTextures } from './textures';

export interface TerrainMaterialOptions {
  textures: GroundTextures;
  /** Metres per texture repeat, per layer. */
  tiling?: [number, number, number, number];
}

export type TerrainMaterial = THREE.MeshStandardMaterial & {
  userData: {
    uniforms: {
      uAlbedoArray: { value: THREE.Texture };
      uNormalArray: { value: THREE.Texture };
      uArmArray: { value: THREE.Texture };
      uMacro: { value: THREE.Texture };
      uTiling: { value: THREE.Vector4 };
      uDetailFade: { value: THREE.Vector2 };
      uWetness: { value: number };
      uSnowTint: { value: THREE.Color };
      uTime: { value: number };
    };
  };
};

export function createTerrainMaterial(opts: TerrainMaterialOptions): TerrainMaterial {
  const material = new THREE.MeshStandardMaterial({
    roughness: 1,
    metalness: 0,
    dithering: true,
  }) as TerrainMaterial;

  const uniforms = {
    uAlbedoArray: { value: opts.textures.albedo },
    uNormalArray: { value: opts.textures.normal },
    uArmArray: { value: opts.textures.arm },
    uMacro: { value: opts.textures.macro },
    // Metres per repeat: meadow, forest floor, rock, snow.
    uTiling: { value: new THREE.Vector4(...(opts.tiling ?? [2.2, 2.6, 3.4, 3.0])) },
    // Where surface detail starts and finishes fading out, in metres.
    uDetailFade: { value: new THREE.Vector2(45, 260) },
    uWetness: { value: 0 },
    uSnowTint: { value: new THREE.Color(0.86, 0.9, 1.0) },
    uTime: { value: 0 },
  };

  material.userData = { uniforms };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        attribute vec4 surface;
        varying vec4 vSurface;
        varying vec3 vWorldPos;
        varying float vViewDist;
        `
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
        #include <begin_vertex>
        vSurface = surface;
        vec4 terrainWorld = modelMatrix * vec4(transformed, 1.0);
        vWorldPos = terrainWorld.xyz;
        vViewDist = length(cameraPosition - terrainWorld.xyz);
        `
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        precision highp sampler2DArray;

        uniform sampler2DArray uAlbedoArray;
        uniform sampler2DArray uNormalArray;
        uniform sampler2DArray uArmArray;
        uniform sampler2D uMacro;
        uniform vec4 uTiling;
        uniform vec2 uDetailFade;
        uniform float uWetness;
        uniform vec3 uSnowTint;

        varying vec4 vSurface;
        varying vec3 vWorldPos;
        varying float vViewDist;

        struct GroundSample {
          vec3 albedo;
          vec3 normalTS;
          float ao;
          float roughness;
        };

        // One layer, projected straight down. Correct for anything you'd
        // comfortably walk on.
        GroundSample sampleLayerPlanar(float layer, float scale, float fade) {
          vec2 uv = vWorldPos.xz / scale;
          GroundSample s;
          vec4 albedo = texture(uAlbedoArray, vec3(uv, layer));
          vec4 arm = texture(uArmArray, vec3(uv, layer));
          vec4 nor = texture(uNormalArray, vec3(uv, layer));

          // Far away, converge on the layer's average colour. Sampling the
          // smallest mip gives that average for free.
          vec3 distant = textureLod(uAlbedoArray, vec3(uv, layer), 7.0).rgb;
          s.albedo = mix(albedo.rgb, distant, fade);
          s.normalTS = mix(nor.xyz * 2.0 - 1.0, vec3(0.0, 0.0, 1.0), fade);
          s.ao = mix(arm.r, 1.0, fade * 0.6);
          s.roughness = arm.g;
          return s;
        }

        // Rock gets a two-plane projection. Full triplanar costs a third more
        // samples for a difference you cannot see on terrain, where the y-plane
        // is already handled by the planar path.
        GroundSample sampleRockTriplanar(float layer, float scale, float fade, vec3 n) {
          vec3 blend = abs(n);
          blend = pow(blend, vec3(4.0));
          blend /= max(blend.x + blend.y + blend.z, 1e-4);

          vec2 uvX = vWorldPos.zy / scale;
          vec2 uvY = vWorldPos.xz / scale;
          vec2 uvZ = vWorldPos.xy / scale;

          vec4 cx = texture(uAlbedoArray, vec3(uvX, layer));
          vec4 cy = texture(uAlbedoArray, vec3(uvY, layer));
          vec4 cz = texture(uAlbedoArray, vec3(uvZ, layer));

          vec4 ax = texture(uArmArray, vec3(uvX, layer));
          vec4 ay = texture(uArmArray, vec3(uvY, layer));
          vec4 az = texture(uArmArray, vec3(uvZ, layer));

          vec3 nx = texture(uNormalArray, vec3(uvX, layer)).xyz * 2.0 - 1.0;
          vec3 ny = texture(uNormalArray, vec3(uvY, layer)).xyz * 2.0 - 1.0;
          vec3 nz = texture(uNormalArray, vec3(uvZ, layer)).xyz * 2.0 - 1.0;

          GroundSample s;
          vec3 albedo = cx.rgb * blend.x + cy.rgb * blend.y + cz.rgb * blend.z;
          vec3 distant = textureLod(uAlbedoArray, vec3(uvY, layer), 7.0).rgb;
          s.albedo = mix(albedo, distant, fade);
          s.normalTS = mix(normalize(nx * blend.x + ny * blend.y + nz * blend.z), vec3(0.0, 0.0, 1.0), fade);
          vec3 arm = ax.rgb * blend.x + ay.rgb * blend.y + az.rgb * blend.z;
          s.ao = mix(arm.r, 1.0, fade * 0.6);
          s.roughness = arm.g;
          return s;
        }

        GroundSample blendGround(GroundSample a, GroundSample b, float t) {
          GroundSample s;
          s.albedo = mix(a.albedo, b.albedo, t);
          // Whiteout blend keeps detail from both normal maps instead of
          // averaging them into mush.
          s.normalTS = normalize(vec3(a.normalTS.xy * (1.0 - t) + b.normalTS.xy * t,
                                      a.normalTS.z * (1.0 - t) + b.normalTS.z * t));
          s.ao = mix(a.ao, b.ao, t);
          s.roughness = mix(a.roughness, b.roughness, t);
          return s;
        }

        // Ground state shared between the colour, roughness, normal and AO
        // stages below. Computed once in <map_fragment>.
        GroundSample groundSample;
        float groundWet;
        `
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        vec3 geoNormal = normalize(vNormal);

        float detailFade = smoothstep(uDetailFade.x, uDetailFade.y, vViewDist);

        // --- surface weights -------------------------------------------------
        // surface = (bare rock, snow, canopy, streambed wetness)
        float wSnow  = vSurface.g;
        float wRock  = vSurface.r * (1.0 - wSnow);
        float wFloor = vSurface.b * (1.0 - wRock) * (1.0 - wSnow);
        float wGrass = max(0.0, 1.0 - wRock - wSnow - wFloor);

        GroundSample meadow = sampleLayerPlanar(0.0, uTiling.x, detailFade);
        GroundSample floorS = sampleLayerPlanar(1.0, uTiling.y, detailFade);
        GroundSample rock   = sampleRockTriplanar(2.0, uTiling.z, detailFade, geoNormal);

        float grassTotal = wGrass + wFloor;
        GroundSample soft = meadow;
        if (grassTotal > 1e-4) {
          soft = blendGround(meadow, floorS, wFloor / max(grassTotal, 1e-4));
        }

        groundSample = blendGround(soft, rock, wRock / max(wRock + grassTotal, 1e-4));

        if (wSnow > 0.001) {
          GroundSample snow = sampleLayerPlanar(3.0, uTiling.w, detailFade);
          snow.albedo *= uSnowTint;
          groundSample = blendGround(groundSample, snow, wSnow);
        }

        // --- macro variation --------------------------------------------------
        // Two very different scales of large noise. Without this the ground
        // reads as wallpaper the moment you look along a slope.
        vec3 macroA = texture(uMacro, vWorldPos.xz * 0.0055).rgb;
        vec3 macroB = texture(uMacro, vWorldPos.xz * 0.00075 + 0.37).rgb;
        float macro = macroA.r * 0.55 + macroB.g * 0.75;
        groundSample.albedo *= 0.74 + macro * 0.52;
        // Slight tint drift so patches feel like different soil, not just
        // brighter and darker versions of one soil.
        groundSample.albedo *= mix(vec3(1.0), vec3(1.06, 0.99, 0.9), macroB.b * 0.55);
        groundSample.roughness = clamp(groundSample.roughness * (0.9 + macroA.g * 0.24), 0.05, 1.0);

        // --- wetness ----------------------------------------------------------
        // Streambeds are permanently wet; rain wets everything except where the
        // canopy keeps it off and where snow already lies.
        float rainWet = uWetness * (1.0 - vSurface.b * 0.55) * (1.0 - wSnow);
        groundWet = clamp(max(vSurface.a, rainWet), 0.0, 1.0);
        groundSample.albedo *= mix(1.0, 0.52, groundWet);
        groundSample.roughness = mix(groundSample.roughness, 0.12, groundWet * 0.85);

        diffuseColor.rgb *= groundSample.albedo;
        `
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `
        float roughnessFactor = clamp(groundSample.roughness, 0.04, 1.0);
        `
      )
      .replace(
        '#include <metalnessmap_fragment>',
        /* glsl */ `
        float metalnessFactor = 0.0;
        `
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `
        {
          // Tangent frame for a top-down projection: Gram-Schmidt the world X
          // axis against the surface normal. Exact for the planar layers and a
          // good enough approximation for the triplanar rock.
          vec3 nrm = normalize(normal);
          vec3 tangent = normalize(vec3(1.0, 0.0, 0.0) - nrm * nrm.x);
          vec3 bitangent = normalize(cross(nrm, tangent));
          mat3 tbn = mat3(tangent, bitangent, nrm);
          vec3 mapped = groundSample.normalTS;
          // Flatten the perturbation on wet ground; a film of water smooths
          // over the fine relief.
          mapped.xy *= mix(1.0, 0.35, groundWet);
          normal = normalize(tbn * normalize(mapped));
        }
        `
      )
      .replace(
        '#include <aomap_fragment>',
        /* glsl */ `
        {
          float terrainAO = clamp(groundSample.ao, 0.0, 1.0);
          reflectedLight.indirectDiffuse *= terrainAO;
          #if defined( USE_ENVMAP ) && defined( STANDARD )
            reflectedLight.indirectSpecular *= terrainAO;
          #endif
        }
        `
      );
  };

  // Changing defines/injections invalidates any cached program.
  material.customProgramCacheKey = () => 'virtual-hiking-terrain-v1';

  return material;
}
