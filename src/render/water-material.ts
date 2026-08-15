/**
 * Water.
 *
 * Streams, lakes and waterfalls all share this one material. Everything it
 * needs is baked into the mesh by the terrain worker:
 *
 *   flow        = downhill direction of the water surface, plus current speed
 *   waterParams = (depth in metres, closeness to a bank, whitewater amount)
 *
 * Depth drives both colour and transparency, which is why a shallow brook
 * shows its gravel bed while a tarn goes green-black at the middle. Because
 * flow comes from the gradient of the surface, a stream that runs over a cliff
 * gets a fast, near-vertical current and turns white on its own — no separate
 * waterfall system, no placement by hand.
 *
 * Surface ripples are analytic: a handful of directional waves whose normals
 * are derived rather than sampled, so there's no scrolling texture to betray
 * a repeat and no extra texture unit spent.
 */

import * as THREE from 'three';

export type WaterMaterial = THREE.MeshStandardMaterial & {
  userData: {
    uniforms: {
      uTime: { value: number };
      uShallowColor: { value: THREE.Color };
      uDeepColor: { value: THREE.Color };
      uFoamColor: { value: THREE.Color };
      uWaveStrength: { value: number };
      uSunDir: { value: THREE.Vector3 };
      uRainRipples: { value: number };
    };
  };
};

export function createWaterMaterial(): WaterMaterial {
  const material = new THREE.MeshStandardMaterial({
    transparent: true,
    roughness: 0.06,
    metalness: 0.0,
    side: THREE.DoubleSide,
    depthWrite: false,
  }) as WaterMaterial;

  const uniforms = {
    uTime: { value: 0 },
    // Peat-tinted shallows over a green-black deep. Mountain water is rarely
    // the postcard blue people expect; it takes its colour from the bed.
    uShallowColor: { value: new THREE.Color(0.16, 0.30, 0.28) },
    uDeepColor: { value: new THREE.Color(0.020, 0.075, 0.085) },
    uFoamColor: { value: new THREE.Color(0.92, 0.95, 0.96) },
    uWaveStrength: { value: 1 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uRainRipples: { value: 0 },
  };
  material.userData = { uniforms };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        attribute vec3 flow;
        attribute vec3 waterParams;
        varying vec3 vFlow;
        varying vec3 vWaterParams;
        varying vec3 vWorldPos;
        varying float vViewDist;
        `
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
        #include <begin_vertex>
        vFlow = flow;
        vWaterParams = waterParams;
        vec4 waterWorld = modelMatrix * vec4(transformed, 1.0);
        vWorldPos = waterWorld.xyz;
        vViewDist = length(cameraPosition - waterWorld.xyz);
        `
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        uniform float uTime;
        uniform vec3 uShallowColor;
        uniform vec3 uDeepColor;
        uniform vec3 uFoamColor;
        uniform float uWaveStrength;
        uniform vec3 uSunDir;
        uniform float uRainRipples;

        varying vec3 vFlow;
        varying vec3 vWaterParams;
        varying vec3 vWorldPos;
        varying float vViewDist;

        float waterHash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
        }

        float waterNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(waterHash(i), waterHash(i + vec2(1.0, 0.0)), f.x),
            mix(waterHash(i + vec2(0.0, 1.0)), waterHash(i + vec2(1.0, 1.0)), f.x),
            f.y
          );
        }

        // Ripple height field. Advected along the flow direction, so the
        // pattern travels downstream on a river and merely bobs on a lake.
        float rippleHeight(vec2 p, vec2 drift, float speed, float t) {
          vec2 q = p - drift * speed * t;
          float h = 0.0;
          h += sin(dot(q, vec2(1.0, 0.6)) * 2.7 + t * 1.9) * 0.5;
          h += sin(dot(q, vec2(-0.7, 1.0)) * 3.9 - t * 2.4) * 0.35;
          h += sin(dot(q, vec2(0.4, -1.1)) * 6.1 + t * 3.3) * 0.2;
          h += waterNoise(q * 3.4 + t * 0.35) * 0.55;
          h += waterNoise(q * 9.0 - t * 0.8) * 0.22;
          return h;
        }
        `
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        float depth = vWaterParams.x;
        float shoreT = vWaterParams.y;
        float white = vWaterParams.z;
        vec2 drift = vFlow.xy;
        float speed = vFlow.z;

        // Detail fades with distance to stop the ripples aliasing into noise.
        float rippleFade = 1.0 - smoothstep(30.0, 190.0, vViewDist);

        // Turbulence grows with the current, so a cascade is visibly more
        // agitated than the pool it lands in.
        float agitation = (0.35 + speed * 0.55) * uWaveStrength * rippleFade;

        // Depth-driven colour. Clear at the edge, saturating into the deep
        // colour over the first couple of metres.
        float depthT = 1.0 - exp(-depth * 0.85);
        vec3 waterColor = mix(uShallowColor, uDeepColor, depthT);

        // Foam: along banks, and wherever the water is being thrown about.
        float foamNoise = waterNoise(vWorldPos.xz * 3.2 - drift * uTime * max(speed, 0.4) * 1.4);
        float bankFoam = smoothstep(0.55, 1.0, shoreT) * (0.35 + foamNoise * 0.75);
        float rapidFoam = smoothstep(0.25, 0.95, white) * (0.4 + foamNoise * 0.9);
        float foam = clamp(max(bankFoam * 0.75, rapidFoam), 0.0, 1.0);

        diffuseColor.rgb *= mix(waterColor, uFoamColor, foam);

        // Transparency: shallow water reads as glass over gravel, deep water
        // hides its bed, and foam is opaque.
        float alpha = clamp(0.30 + depthT * 0.62, 0.0, 1.0);
        alpha = mix(alpha, 0.97, foam);
        // Never a hard edge at the waterline.
        alpha *= smoothstep(0.0, 0.09, depth);
        diffuseColor.a *= alpha;
        `
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `
        float roughnessFactor = roughness;
        {
          float white2 = vWaterParams.z;
          float foamRough = smoothstep(0.2, 0.9, white2);
          // Still water is a mirror; whitewater is not.
          roughnessFactor = mix(0.045, 0.62, foamRough);
          roughnessFactor = mix(roughnessFactor, 0.5, uRainRipples * 0.5);
        }
        `
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `
        {
          vec3 nrm = normalize(normal);
          vec2 p = vWorldPos.xz;

          float scale = 1.0;
          float eps = 0.06;
          float t = uTime;
          vec2 d = normalize(drift + vec2(1e-4));

          float h  = rippleHeight(p * scale, d, speed, t);
          float hx = rippleHeight((p + vec2(eps, 0.0)) * scale, d, speed, t);
          float hz = rippleHeight((p + vec2(0.0, eps)) * scale, d, speed, t);

          // Rain stipples the surface with fast, tiny, non-directional ripples.
          if (uRainRipples > 0.001) {
            float rp = waterNoise(p * 26.0 + floor(t * 9.0) * 3.1) ;
            float rain = sin(rp * 40.0 - t * 22.0) * uRainRipples * 0.25;
            h += rain; hx += rain * 0.7; hz += rain * 0.7;
          }

          float strength = 0.06 * agitation;
          vec3 tangentNormal = normalize(vec3(-(hx - h) / eps * strength, 1.0, -(hz - h) / eps * strength));

          // The surface is close to horizontal, so bending the geometric
          // normal toward the ripple normal is accurate enough and avoids
          // needing a tangent frame. On a waterfall the geometric normal is
          // near-vertical and the ripples correctly contribute much less.
          normal = normalize(mix(nrm, normalize(tangentNormal), 0.85));
        }
        `
      );
  };

  material.customProgramCacheKey = () => 'virtual-hiking-water-v1';
  return material;
}
