import * as THREE from 'three';
import { MATERIALS } from '../data/textureManifest.js';

/**
 * Splatted terrain material.
 *
 * Vertex colours alone gave a smooth, featureless surface — a beach that read
 * as a beige gradient. This extends MeshStandardMaterial so the fragment
 * shader blends three real PBR sets (sand / grass / rock) by world height and
 * slope, then modulates the result with the baked vertex colour that already
 * carries the biome palette. One material, one draw call, no splat texture.
 */
export function createTerrainMaterial(assets, opts = {}) {
  const rep = [1, 1];
  const sand = {
    map: assets.texture(MATERIALS.sand.color, { repeat: rep, srgb: true, fallback: 'flat' }),
    nrm: assets.texture(MATERIALS.sand.normal, { repeat: rep, linear: true, fallback: 'normal' }),
  };
  const grass = {
    map: assets.texture(MATERIALS.grass.color, { repeat: rep, srgb: true, fallback: 'flat' }),
    nrm: assets.texture(MATERIALS.grass.normal, { repeat: rep, linear: true, fallback: 'normal' }),
  };
  const rock = {
    map: assets.texture(MATERIALS.rock_cliff.color, { repeat: rep, srgb: true, fallback: 'flat' }),
    nrm: assets.texture(MATERIALS.rock_cliff.normal, { repeat: rep, linear: true, fallback: 'normal' }),
  };
  const wet = {
    map: assets.texture(MATERIALS.sand_seafloor?.color || MATERIALS.sand.color, { repeat: rep, srgb: true, fallback: 'flat' }),
  };
  for (const t of [sand.map, sand.nrm, grass.map, grass.nrm, rock.map, rock.nrm, wet.map]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
  }

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.97,
    metalness: 0.0,
    color: 0xffffff,
  });

  mat.userData.uniforms = {
    uSandMap: { value: sand.map },
    uSandNrm: { value: sand.nrm },
    uGrassMap: { value: grass.map },
    uGrassNrm: { value: grass.nrm },
    uRockMap: { value: rock.map },
    uRockNrm: { value: rock.nrm },
    uWetMap: { value: wet.map },
    uScale: { value: opts.scale ?? 0.34 },       // texture repeats per metre
    uMacroScale: { value: 0.012 },
    uDetailStrength: { value: opts.detail ?? 0.85 },
    uNormalStrength: { value: opts.normalStrength ?? 0.75 },
    uGrassStart: { value: 1.9 },
    uGrassEnd: { value: 5.5 },
    uRockSlope: { value: 0.42 },
    uFarFade: { value: 220 },
  };

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, mat.userData.uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 vTerrWorld;
        varying vec3 vTerrNormal;
      `)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vTerrWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vTerrNormal = normalize(mat3(modelMatrix) * objectNormal);
      `);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uSandMap, uSandNrm, uGrassMap, uGrassNrm, uRockMap, uRockNrm, uWetMap;
        uniform float uScale, uMacroScale, uDetailStrength, uNormalStrength;
        uniform float uGrassStart, uGrassEnd, uRockSlope, uFarFade;
        varying vec3 vTerrWorld;
        varying vec3 vTerrNormal;

        // Two scales: a fine grain you can read from a metre away, plus a
        // much larger copy for macro variation. Mixing them also hides the
        // tiling of the fine layer.
        vec3 dualSample(sampler2D t, vec2 uv) {
          vec3 fine = texture2D(t, uv).rgb;
          vec3 macro = texture2D(t, uv * 0.16 + 0.37).rgb;
          return mix(fine, macro, 0.38);
        }
        // Skip a layer entirely when its weight is negligible. Fragments in a
        // given area share a biome, so this branch is coherent and cheap.
        vec3 layer(sampler2D t, vec2 uv, float w) {
          return w > 0.012 ? dualSample(t, uv) * w : vec3(0.0);
        }
      `)
      .replace('#include <map_fragment>', `
        {
          vec2 uvT = vTerrWorld.xz * uScale;
          float slope = 1.0 - clamp(vTerrNormal.y, 0.0, 1.0);
          float h = vTerrWorld.y;

          float wGrass = smoothstep(uGrassStart, uGrassEnd, h) * (1.0 - smoothstep(uRockSlope, uRockSlope + 0.22, slope));
          float wRock  = smoothstep(uRockSlope, uRockSlope + 0.26, slope);
          float wWet   = 1.0 - smoothstep(-1.2, 0.35, h);
          float wSand  = max(0.0, 1.0 - wGrass - wRock - wWet);
          float sum = max(0.0001, wGrass + wRock + wSand + wWet);
          wGrass /= sum; wRock /= sum; wSand /= sum; wWet /= sum;

          // Wet sand is the dry set darkened, which saves a texture unit.
          vec3 det = layer(uSandMap, uvT, wSand + wWet)
                   + layer(uGrassMap, uvT * 1.35, wGrass)
                   + layer(uRockMap, uvT * 0.75, wRock);
          det *= 1.0 - wWet * 0.32;

          // Normalise the detail around mid-grey so it modulates the vertex
          // colour rather than replacing it.
          float lum = dot(det, vec3(0.299, 0.587, 0.114));
          vec3 tinted = mix(vec3(1.0), det / max(0.08, lum), 0.55);

          // Fade the detail out with distance to kill shimmer on far terrain.
          float fade = 1.0 - smoothstep(uFarFade * 0.45, uFarFade, length(vViewPosition));
          float k = uDetailStrength * fade;
          diffuseColor.rgb *= mix(vec3(1.0), tinted * (0.72 + lum * 0.62), k);
        }
      `)
      .replace('#include <normal_fragment_maps>', `
        {
          vec2 uvT = vTerrWorld.xz * uScale;
          float slope = 1.0 - clamp(vTerrNormal.y, 0.0, 1.0);
          float h = vTerrWorld.y;
          float wGrass = smoothstep(uGrassStart, uGrassEnd, h) * (1.0 - smoothstep(uRockSlope, uRockSlope + 0.22, slope));
          float wRock  = smoothstep(uRockSlope, uRockSlope + 0.26, slope);
          float wSand  = max(0.0, 1.0 - wGrass - wRock);
          // One normal fetch: pick the dominant layer rather than blending
          // three, which is visually indistinguishable at this scale.
          vec3 n = (wRock > wGrass && wRock > wSand) ? texture2D(uRockNrm, uvT * 0.75).xyz
                 : (wGrass > wSand) ? texture2D(uGrassNrm, uvT * 1.35).xyz
                 : texture2D(uSandNrm, uvT).xyz;
          n = n * 2.0 - 1.0;
          float fade = 1.0 - smoothstep(uFarFade * 0.4, uFarFade, length(vViewPosition));
          if (fade < 0.02) { /* far terrain keeps the geometric normal */ } else {
          // Perturb the geometric normal in world space; terrain has no tangents.
          vec3 up = abs(normal.y) > 0.99 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
          vec3 t = normalize(cross(up, normal));
          vec3 b = cross(normal, t);
          normal = normalize(normal + (t * n.x + b * n.y) * uNormalStrength * fade);
          }
        }
      `);

    mat.userData.shader = shader;
  };
  // Force a distinct program from other MeshStandardMaterials.
  mat.customProgramCacheKey = () => 'terrain-splat-v1';
  return mat;
}
