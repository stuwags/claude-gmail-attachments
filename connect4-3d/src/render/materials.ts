/**
 * Every surface in the set (bible §3), with the exact parameter values from the
 * spec tables and the procedural micro-detail that keeps them off the "CG"
 * side of the line.
 *
 * Two conventions run through this file and are worth stating once.
 *
 * Three.js *multiplies* a roughness or clearcoat-roughness map into the scalar
 * parameter, and map values cannot exceed 1. So a spec of "0.34 ± 0.04" cannot
 * be authored as base 0.34 with a map centred on 1.0 — the map can only ever
 * make it smoother. The base is therefore raised to the top of the intended
 * range and the map centred below unity, so the *effective* roughness is the
 * number the bible asks for. Each site says what it resolves to.
 *
 * And the colour of a disc lives in its instance colour, not in the material,
 * because 42 discs are one draw call. `material.color` is left white so that
 * `diffuse * map * vColor` collapses to exactly the instance colour times the
 * groove AO ring.
 */

import {
  AdditiveBlending,
  Color,
  DoubleSide,
  FrontSide,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  ShaderMaterial,
  Vector2,
  type DataTexture,
  type Texture,
  type WebGLProgramParametersWithUniforms,
} from 'three';

import {
  buildNormalMap,
  buildTexture,
  clamp01,
  lerp,
  mulberry32,
  SimplexNoise,
  smoothstep,
} from './procedural';
import { PALETTE, RIG_SCALE } from './environment';
import type { QualityTier } from './api';

/** Per-instance vec4 the outcome sequence drives: ignition, desat, darken, roughness bias. */
export const DISC_TREATMENT_ATTRIBUTE = 'aTreat';

export const EMBER = PALETTE.ember;
export const PETROL = PALETTE.petrol;

/* ------------------------------------------------------------------ *
 * Disc textures (bible §3.1)
 * ------------------------------------------------------------------ */

/**
 * The disc's UV is polar: u wraps the 132 mm circumference, v runs the 50 mm
 * lathe profile by arc length. Micro-detail repeats are therefore chosen per
 * axis so a texel is roughly square on the surface — get this wrong and the
 * orange peel smears into streaks, which reads as brushed metal, not lacquer.
 */
const DISC_CIRCUMFERENCE = 2 * Math.PI * 0.021;

/**
 * Orange peel: the gentle undulation a lacquer film takes on as it levels, and
 * the single detail that separates piano lacquer from moulded plastic. It is
 * far below the scale of any geometry, so it lives entirely in the clearcoat
 * normal.
 *
 * Built from procedural.ts's simplex rather than by calling `plasticSurface()`,
 * which composes a worley field and is Sobel-sampled eight times per texel by
 * `buildNormalMap`: measured at ~1.0 s for one 512² map, which is seven times
 * the bible's entire generation budget. Baking the height on the texel grid
 * first is bit-identical — the Sobel taps land on grid centres anyway — and
 * costs an eighth as much.
 */
function orangePeelNormal(size = 512): DataTexture {
  const n = new SimplexNoise(7);
  const height = bakeField(size, (u, v) => {
    const peel = n.fbm(u * 13, v * 13, 2) * 0.6;
    const flow = n.noise2D(u * 41, v * 41) * 0.22;
    return peel + flow;
  });
  return buildNormalMap({ size, strength: 0.7 }, height);
}

function discBodyRoughness(size = 256): DataTexture {
  const n = new SimplexNoise(1201);
  // Base 0.38 × map centred on 0.895 = 0.34 effective, ±0.04 as specified.
  return buildTexture({ size }, (u, v, out) => {
    const f = n.fbm(u * 23, v * 23, 2) * 0.5 + 0.5;
    out[0] = out[1] = out[2] = clamp01(0.895 + (f - 0.5) * 0.21);
  });
}

/**
 * The fingerprint note. Three octaves at roughly two features per disc face,
 * lifting clearcoat roughness by up to +0.05 in patches. At rest it is
 * invisible; it only appears as a highlight sweeps across, which is the entire
 * point — a smudge you can see when nothing is moving is a texture, not a
 * smudge.
 */
function discClearcoatRoughness(size = 256): DataTexture {
  const n = new SimplexNoise(4409);
  // Base 0.17 × map in [0.706, 1.0] = 0.12 to 0.17 effective.
  return buildTexture({ size }, (u, v, out) => {
    const patch = smoothstep(0.15, 0.75, n.fbm(u * 3, v * 3, 3) * 0.5 + 0.5);
    out[0] = out[1] = out[2] = lerp(0.706, 1.0, patch);
  });
}

/**
 * Albedo: white everywhere except a 0.85× darkening inside the two lathed
 * grooves. This object is new — no scratches, no edge grime — so the only wear
 * cue permitted is the shadow that collects in a machined recess.
 */
function discAlbedo(bands: { v0: number; v1: number }[], size = 256): DataTexture {
  return buildTexture({ size, srgb: true }, (_u, v, out) => {
    let shade = 1;
    for (const b of bands) {
      // Soft shoulders: a hard-edged ring would alias along the groove lip.
      const t = smoothstep(b.v0, b.v0 + (b.v1 - b.v0) * 0.3, v) *
        (1 - smoothstep(b.v1 - (b.v1 - b.v0) * 0.3, b.v1, v));
      shade = Math.min(shade, lerp(1, 0.85, t));
    }
    out[0] = out[1] = out[2] = shade;
  });
}

/* ------------------------------------------------------------------ *
 * Metal and stone textures (bible §3.2, §3.3)
 * ------------------------------------------------------------------ */

/**
 * Bake a height function to a grid once and read it back by nearest texel.
 *
 * `buildNormalMap` Sobel-samples its height function eight times per texel. At
 * 1024² with a three-octave fBm that is 24 million simplex evaluations for one
 * map — seconds, against a 150 ms budget for the whole boot. Evaluating on the
 * texel grid first and looking up afterwards costs one eighth of that and is
 * bit-identical, because the Sobel taps land exactly on grid centres anyway.
 */
function bakeField(size: number, fn: (u: number, v: number) => number): (u: number, v: number) => number {
  const data = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) data[y * size + x] = fn((x + 0.5) / size, (y + 0.5) / size);
  }
  return (u, v) => {
    const x = ((Math.floor(u * size) % size) + size) % size;
    const y = ((Math.floor(v * size) % size) + size) % size;
    return data[y * size + x];
  };
}

/**
 * Bead-blasted anodise: isotropic, fine, and deliberately *not*
 * `anodisedSurface()` from procedural.ts, which lays in a directional
 * extrusion grain. The bible is explicit that this finish is blasted rather
 * than brushed; a grain direction would put a stretched anisotropic highlight
 * down the rails and lose the continuous chamfer line that §9 item 3 checks.
 */
function beadBlast(size = 512) {
  const n = new SimplexNoise(77);
  // One tile spans ~40 mm of rail, so a 0.2 mm feature is about 2.5 texels.
  const height = bakeField(size, (u, v) => n.noise2D(u * 205, v * 205));

  const normalMap = buildNormalMap({ size, strength: 0.35 }, height);
  // Base 0.39 × map centred on 0.923 = 0.36 effective, ±0.03 as specified.
  const roughnessMap = buildTexture({ size }, (u, v, out) => {
    out[0] = out[1] = out[2] = clamp01(0.923 + height(u, v) * 0.077);
  });
  return { normalMap, roughnessMap };
}

/**
 * Honed basalt. The albedo carries the stone's real colour rather than
 * modulating `material.color`, because the mineral flecks are 2.6× brighter
 * than the matrix and a multiply map cannot go above one.
 */
function basaltSurface(size = 1024) {
  const n = new SimplexNoise(313);
  const rnd = mulberry32(90210);

  // Sparse lighter flecks, splatted once so the albedo and the normal are
  // derived from the same field, as the bible requires.
  const flecks = new Float32Array(size * size);
  for (let i = 0; i < 400; i++) {
    const cx = Math.floor(rnd() * size);
    const cy = Math.floor(rnd() * size);
    const r = 1 + Math.floor(rnd() * 3);
    const strength = 0.5 + rnd() * 0.5;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const d = Math.hypot(dx, dy);
        if (d > r) continue;
        const x = (cx + dx + size) % size;
        const y = (cy + dy + size) % size;
        const f = strength * (1 - d / (r + 0.5));
        if (f > flecks[y * size + x]) flecks[y * size + x] = f;
      }
    }
  }

  // Two octaves, not fBm: the bible asks for "per-pixel brightness variance",
  // which is a near-white field, plus enough long-wavelength cloud that the
  // slab does not read as uniform grey under a raking key.
  const grain = bakeField(
    size,
    (u, v) => n.noise2D(u * 420, v * 420) * 0.65 + n.noise2D(u * 9, v * 9) * 0.35,
  );
  const fleckAt = (u: number, v: number) => {
    const x = Math.min(size - 1, Math.floor(u * size));
    const y = Math.min(size - 1, Math.floor(v * size));
    return flecks[y * size + x];
  };

  // Authored in sRGB and tagged as such: an 8-bit *linear* map of a #23262A
  // stone would quantise its whole tonal range into four code values.
  const base = new Color(PALETTE.basalt).convertLinearToSRGB();
  const fleck = new Color(0x3a3e43).convertLinearToSRGB();

  const map = buildTexture({ size, srgb: true }, (u, v, out) => {
    const f = fleckAt(u, v);
    // ±2 % brightness variance; more than that and honed stone becomes granite.
    const shade = 1 + grain(u, v) * 0.02;
    out[0] = lerp(base.r, fleck.r, f) * shade;
    out[1] = lerp(base.g, fleck.g, f) * shade;
    out[2] = lerp(base.b, fleck.b, f) * shade;
  });

  const normalMap = buildNormalMap({ size, strength: 0.15 }, (u, v) =>
    grain(u, v) * 0.5 + fleckAt(u, v) * 0.6,
  );

  return { map, normalMap };
}

/* ------------------------------------------------------------------ *
 * Ghost / overlay shader (bible §3.4)
 * ------------------------------------------------------------------ */

const GHOST_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vV;
varying vec2 vUvG;
void main() {
  vec4 world = modelMatrix * vec4( position, 1.0 );
  vN = normalize( mat3( modelMatrix ) * normal );
  vV = normalize( cameraPosition - world.xyz );
  vUvG = uv;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const GHOST_FRAG = /* glsl */ `
precision highp float;
uniform vec3  uColour;
uniform float uOpacity;
uniform float uTime;
uniform float uShimmer;
uniform float uRigScale;
varying vec3 vN;
varying vec3 vV;
varying vec2 vUvG;

void main() {
  float facing = clamp( dot( normalize( vN ), normalize( vV ) ), 0.0, 1.0 );
  float fresnel = pow( 1.0 - facing, 2.5 );
  float a = mix( 0.10, 0.45, fresnel );
  // One octave, 3 s period, ±8 %. No scanlines, no hexagons, no sci-fi.
  a *= 1.0 + uShimmer * 0.08 * sin( vUvG.x * 6.2831853 + uTime * 2.0943951 );
  // Additive and scene-referred, so it carries the rig's scale like a light.
  gl_FragColor = vec4( uColour, a * uOpacity * uRigScale );
}
`;

export interface GhostMaterial {
  material: ShaderMaterial;
  setColour(hex: number): void;
  setOpacity(o: number): void;
  advance(dt: number): void;
}

export function createGhostMaterial(reducedMotion: boolean): GhostMaterial {
  const material = new ShaderMaterial({
    uniforms: {
      uColour: { value: new Color(PALETTE.emberGlow) },
      uOpacity: { value: 0 },
      uTime: { value: 0 },
      uShimmer: { value: reducedMotion ? 0 : 1 },
      uRigScale: { value: RIG_SCALE },
    },
    vertexShader: GHOST_VERT,
    fragmentShader: GHOST_FRAG,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    // FrontSide, not DoubleSide: with additive blending a two-sided shell adds
    // its fresnel twice, and the bible's 0.10-to-0.45 figures are final
    // on-screen values, not per-layer ones.
    side: FrontSide,
    toneMapped: true,
  });

  return {
    material,
    setColour(hex) {
      (material.uniforms.uColour.value as Color).setHex(hex);
    },
    setOpacity(o) {
      material.uniforms.uOpacity.value = o;
      material.visible = o > 0.001;
    },
    advance(dt) {
      if (!reducedMotion) material.uniforms.uTime.value += dt;
    },
  };
}

/* ------------------------------------------------------------------ *
 * The library
 * ------------------------------------------------------------------ */

export interface MaterialLibrary {
  disc: MeshPhysicalMaterial;
  acrylic: MeshPhysicalMaterial;
  aluminium: MeshPhysicalMaterial;
  basalt: MeshPhysicalMaterial;
  rimStroke: MeshBasicMaterial;
  /** Tier B trades transmission for sorted alpha on the panels (bible §0). */
  setTier(tier: QualityTier): void;
  dispose(): void;
}

export function createMaterials(
  grooveBands: { v0: number; v1: number }[],
  discProfileLength: number,
): MaterialLibrary {
  const textures: Texture[] = [];
  const keep = <T extends Texture>(t: T): T => {
    textures.push(t);
    return t;
  };

  /* ---- discs ---- */

  const clearcoatNormalMap = keep(orangePeelNormal(512));
  // ~7 mm of surface per tile on both axes, so the 0.5 mm peel cells stay round
  // on a UV that is polar and therefore anisotropic by construction.
  clearcoatNormalMap.repeat.set(DISC_CIRCUMFERENCE / 0.007, discProfileLength / 0.007);

  const discRough = keep(discBodyRoughness());
  discRough.repeat.copy(clearcoatNormalMap.repeat);

  const discCcRough = keep(discClearcoatRoughness());
  discCcRough.repeat.set(2, 1);

  const discMap = keep(discAlbedo(grooveBands));

  const disc = new MeshPhysicalMaterial({
    color: 0xffffff,
    map: discMap,
    roughness: 0.38,
    roughnessMap: discRough,
    metalness: 0.0,
    clearcoat: 1.0,
    clearcoatRoughness: 0.17,
    clearcoatRoughnessMap: discCcRough,
    clearcoatNormalMap,
    ior: 1.5,
    specularIntensity: 1.0,
    sheen: 0,
    iridescence: 0,
    transmission: 0,
    envMapIntensity: 1.0,
    side: FrontSide,
  });
  // The subtle highlight wobble that makes lacquer read as lacquer. At 0.06 it
  // is far below the threshold where a normal map starts to look like texture.
  disc.clearcoatNormalScale = new Vector2(0.06, 0.06);
  injectDiscTreatment(disc);

  /* ---- acrylic ---- */

  const acrylicNormal = keep(acrylicMicroNormal());
  acrylicNormal.repeat.set(3, 3);

  const acrylic = new MeshPhysicalMaterial({
    color: 0xffffff,
    transmission: 1.0,
    thickness: 0.006,
    attenuationColor: new Color(PALETTE.smoke),
    attenuationDistance: 0.02,
    roughness: 0.06,
    metalness: 0.0,
    ior: 1.49,
    clearcoat: 0.0,
    dispersion: 0.0,
    normalMap: acrylicNormal,
    envMapIntensity: 1.0,
    // FrontSide, not DoubleSide: a double-sided transmissive object costs a
    // second full pass of the transmission buffer, and the panels are closed
    // solids, so there is nothing to gain from it.
    side: FrontSide,
  });
  // Cast acrylic is nearly optically flat. Any more than this and the veiling
  // haze the bible wants turns into frosting.
  acrylic.normalScale = new Vector2(0.08, 0.08);

  /* ---- aluminium ---- */

  const blast = beadBlast();
  const alNormal = keep(blast.normalMap);
  const alRough = keep(blast.roughnessMap);
  // Extrude cap UVs are the shape's own coordinates, i.e. *metres*. At repeat 9
  // one tile covered 111 mm of rail, putting the blast texture's 205-cycle
  // field at a 0.54 mm feature — two screen pixels, which reads as speckle
  // rather than as a finish. Repeat 24 gives a 41 mm tile and a 0.20 mm
  // feature, which is both the bible's number and comfortably sub-pixel at
  // this camera distance.
  alNormal.repeat.set(24, 24);
  alRough.repeat.set(24, 24);

  const aluminium = new MeshPhysicalMaterial({
    color: PALETTE.starlight,
    metalness: 1.0,
    roughness: 0.39,
    roughnessMap: alRough,
    normalMap: alNormal,
    anisotropy: 0.0,
    envMapIntensity: 1.0,
    side: FrontSide,
  });
  // A bead-blasted finish scatters; it does not corrugate. At sub-pixel feature
  // size the normal map's job is to take the hard edge off a highlight, not to
  // be seen.
  aluminium.normalScale = new Vector2(0.2, 0.2);

  /* ---- basalt ---- */

  const stone = basaltSurface();
  const stoneMap = keep(stone.map);
  const stoneNormal = keep(stone.normalMap);
  // One tile per 0.6 m of slab: 1024 texels over 600 mm is 0.6 mm per texel,
  // which puts the flecks at the 1–3 px the bible calls for.
  stoneMap.repeat.set(4, 2);
  stoneNormal.repeat.set(4, 2);

  const basalt = new MeshPhysicalMaterial({
    color: 0xffffff,
    map: stoneMap,
    normalMap: stoneNormal,
    roughness: 0.38,
    metalness: 0.0,
    clearcoat: 0.25,
    clearcoatRoughness: 0.35,
    envMapIntensity: 0.5,
    side: FrontSide,
  });
  basalt.normalScale = new Vector2(0.15, 0.15);

  /* ---- hover rim strokes ---- */

  // Instance colour carries "ink at 8 %" / "at 20 %" directly: with additive
  // blending and alpha 1 the shader adds exactly colour × weight, so the
  // strokes need no custom program.
  const rimStroke = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
  });

  return {
    disc,
    acrylic,
    aluminium,
    basalt,
    rimStroke,
    setTier(tier: QualityTier) {
      const tierA = tier === 'high' || tier === 'ultra';
      acrylic.transmission = tierA ? 1.0 : 0.0;
      acrylic.transparent = !tierA;
      acrylic.opacity = tierA ? 1.0 : 0.5;
      acrylic.depthWrite = tierA;
      // Without transmission the smoke has nothing to attenuate, so the tint
      // moves into the albedo to keep the panels the same colour on both tiers.
      acrylic.color.setHex(tierA ? 0xffffff : PALETTE.smoke);
      acrylic.needsUpdate = true;
    },
    dispose() {
      for (const t of textures) t.dispose();
      disc.dispose();
      acrylic.dispose();
      aluminium.dispose();
      basalt.dispose();
      rimStroke.dispose();
    },
  };
}

/** Faint long-wavelength waviness plus polish marks; enough to stop the sheet
 * reflecting like a perfect analytic plane. */
function acrylicMicroNormal(size = 256): DataTexture {
  const n = new SimplexNoise(33);
  const height = bakeField(size, (u, v) => {
    const waviness = n.fbm(u * 3.5, v * 3.5, 2) * 0.6;
    const polish = Math.pow(Math.abs(n.noise2D(u * 60, v * 6)), 6) * 0.35;
    return waviness + polish;
  });
  return buildNormalMap({ size, strength: 0.12 }, height);
}

/* ------------------------------------------------------------------ *
 * Per-instance treatment
 * ------------------------------------------------------------------ */

/**
 * The outcome sequence needs per-disc emissive, desaturation, darkening and a
 * roughness bias — but all 42 discs are one `InstancedMesh`, so those cannot be
 * material uniforms. Four floats per instance, injected into the standard
 * physical shader, keep the whole board at one draw call while still letting
 * four winning discs ignite and thirty-eight recede.
 *
 * `vColor` is the instance colour after `<color_fragment>` has applied it, so
 * the emissive ramps toward the disc's own body colour with no second uniform.
 */
function injectDiscTreatment(material: MeshPhysicalMaterial): void {
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec4 ${DISC_TREATMENT_ATTRIBUTE};
        varying vec4 vTreat;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vTreat = ${DISC_TREATMENT_ATTRIBUTE};`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec4 vTreat;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          float discLuma = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
          diffuseColor.rgb = mix( diffuseColor.rgb, vec3( discLuma ), vTreat.y ) * vTreat.z;
        }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = clamp( roughnessFactor + vTreat.w, 0.02, 1.0 );`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        // Bible §6.1's "body colour times 2.2", expressed in the scene-referred
        // units the rest of the rig uses so an ignited disc sits the same
        // distance above its neighbours whatever the rig scale is.
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += vColor.rgb * vTreat.x * ${(2.2 * RIG_SCALE).toFixed(4)};`,
      );
  };
  // Static injection, so one cache key for every compile of this material.
  material.customProgramCacheKey = () => 'disc-treatment-v1';
}
