/**
 * Procedural texture generation.
 *
 * Everything the materials need is synthesised here at load time: no texture
 * downloads, no binary assets in the bundle. That keeps the app small enough to
 * cache offline on an iPad while still giving surfaces the micro-detail that
 * separates a photograph from a CG render — nothing in the real world has
 * uniform roughness, and a perfectly even surface is the single most reliable
 * tell that an image was rendered.
 *
 * Textures are built into `Uint8Array`s and handed to `THREE.DataTexture`, which
 * avoids a canvas round-trip and keeps generation deterministic across devices.
 */

import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  RGBAFormat,
  UnsignedByteType,
  type Texture,
} from 'three';

/* ------------------------------------------------------------------ *
 * Deterministic randomness
 * ------------------------------------------------------------------ */

/** Small fast PRNG. Same seed, same texture, on every device. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ *
 * Noise
 * ------------------------------------------------------------------ */

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

const GRAD2 = new Float32Array([
  1, 1, -1, 1, 1, -1, -1, -1, 1, 0, -1, 0, 1, 0, -1, 0, 0, 1, 0, -1, 0, 1, 0, -1,
]);

/**
 * Tileable 2D simplex noise over a period-`P` lattice.
 *
 * Tiling matters: these textures wrap around a cylindrical disc edge and repeat
 * across a table top, and a visible seam is worse than no texture at all.
 * Perfect simplex tiling is not analytic, so this uses the standard trick of
 * hashing lattice coordinates modulo the period.
 */
export class SimplexNoise {
  private perm = new Uint8Array(512);
  private permMod12 = new Uint8Array(512);

  constructor(seed = 1) {
    const rnd = mulberry32(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod12[i] = this.perm[i] % 12;
    }
  }

  noise2D(xin: number, yin: number): number {
    const { perm, permMod12 } = this;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);

    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;

    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;

    const ii = i & 255;
    const jj = j & 255;

    let n0 = 0;
    let n1 = 0;
    let n2 = 0;

    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 >= 0) {
      const gi0 = permMod12[ii + perm[jj]] * 2;
      t0 *= t0;
      n0 = t0 * t0 * (GRAD2[gi0] * x0 + GRAD2[gi0 + 1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 >= 0) {
      const gi1 = permMod12[ii + i1 + perm[jj + j1]] * 2;
      t1 *= t1;
      n1 = t1 * t1 * (GRAD2[gi1] * x1 + GRAD2[gi1 + 1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 >= 0) {
      const gi2 = permMod12[ii + 1 + perm[jj + 1]] * 2;
      t2 *= t2;
      n2 = t2 * t2 * (GRAD2[gi2] * x2 + GRAD2[gi2 + 1] * y2);
    }
    return 70 * (n0 + n1 + n2);
  }

  /** Fractal Brownian motion. Returns roughly [-1,1]. */
  fbm(x: number, y: number, octaves = 5, lacunarity = 2, gain = 0.5): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise2D(x * freq, y * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  /** Sharp-crested noise. Good for scratches and fibre. */
  ridged(x: number, y: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      const n = 1 - Math.abs(this.noise2D(x * freq, y * freq));
      sum += amp * n * n;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }
}

/**
 * Tiling cellular (Worley) noise. Returns distance to the nearest feature
 * point, normalised to roughly [0,1]. Used for orange-peel and dust clumping.
 */
export function worley(x: number, y: number, cells: number, seed: number): number {
  const cx = Math.floor(x * cells);
  const cy = Math.floor(y * cells);
  let best = 1e9;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      // Wrap the cell coordinate so the field tiles.
      const gx = ((cx + ox) % cells + cells) % cells;
      const gy = ((cy + oy) % cells + cells) % cells;
      const h = hash2(gx, gy, seed);
      const px = (cx + ox + (h & 0xffff) / 65536) / cells;
      const py = (cy + oy + ((h >>> 16) & 0xffff) / 65536) / cells;
      const dx = x - px;
      const dy = y - py;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
  }
  return Math.min(1, Math.sqrt(best) * cells);
}

function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(seed, 0x9e3779b9);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return h >>> 0;
}

/* ------------------------------------------------------------------ *
 * Texture assembly
 * ------------------------------------------------------------------ */

export interface TextureOptions {
  /** Texture is square, `size` x `size`. Powers of two only. */
  size: number;
  /** sRGB for colour maps; leave false for data maps (roughness, normal). */
  srgb?: boolean;
  repeat?: number;
  anisotropy?: number;
}

/**
 * Build an RGBA texture by evaluating `fn` per texel. `fn` writes into `out`
 * as four floats in 0..1; u and v are pixel centres in 0..1.
 */
export function buildTexture(
  opts: TextureOptions,
  fn: (u: number, v: number, out: Float32Array) => void,
): DataTexture {
  const { size } = opts;
  const data = new Uint8Array(size * size * 4);
  const out = new Float32Array(4);
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      out[0] = out[1] = out[2] = 0;
      out[3] = 1;
      fn(u, v, out);
      const i = (y * size + x) * 4;
      data[i] = clamp255(out[0] * 255);
      data[i + 1] = clamp255(out[1] * 255);
      data[i + 2] = clamp255(out[2] * 255);
      data[i + 3] = clamp255(out[3] * 255);
    }
  }
  return finishTexture(data, opts);
}

/**
 * Build a tangent-space normal map from a height function via Sobel.
 *
 * Sampling the height field rather than differencing a quantised 8-bit height
 * texture avoids the stair-stepping that makes procedural normal maps look
 * faceted under a sharp highlight.
 */
export function buildNormalMap(
  opts: TextureOptions & { strength?: number },
  height: (u: number, v: number) => number,
): DataTexture {
  const { size } = opts;
  const strength = opts.strength ?? 1;
  const data = new Uint8Array(size * size * 4);
  const d = 1 / size;

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;

      // Sobel over the wrapped height field.
      const h = (du: number, dv: number) => height(wrap01(u + du * d), wrap01(v + dv * d));
      const tl = h(-1, -1);
      const t = h(0, -1);
      const tr = h(1, -1);
      const l = h(-1, 0);
      const r = h(1, 0);
      const bl = h(-1, 1);
      const b = h(0, 1);
      const br = h(1, 1);

      const dx = tl + 2 * l + bl - (tr + 2 * r + br);
      const dy = tl + 2 * t + tr - (bl + 2 * b + br);

      let nx = dx * strength;
      let ny = dy * strength;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;

      const i = (y * size + x) * 4;
      data[i] = clamp255((nx * 0.5 + 0.5) * 255);
      data[i + 1] = clamp255((ny * 0.5 + 0.5) * 255);
      data[i + 2] = clamp255((nz * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  return finishTexture(data, { ...opts, srgb: false });
}

function finishTexture(data: Uint8Array, opts: TextureOptions): DataTexture {
  const tex = new DataTexture(data, opts.size, opts.size, RGBAFormat, UnsignedByteType);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = opts.anisotropy ?? 8;
  if (opts.srgb) tex.colorSpace = 'srgb';
  if (opts.repeat && opts.repeat !== 1) tex.repeat.setScalar(opts.repeat);
  tex.needsUpdate = true;
  return tex;
}

const clamp255 = (n: number) => (n < 0 ? 0 : n > 255 ? 255 : n | 0);
const wrap01 = (n: number) => n - Math.floor(n);
export const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/* ------------------------------------------------------------------ *
 * Material-specific generators
 * ------------------------------------------------------------------ */

/**
 * Injection-moulded plastic. Real moulded parts have "orange peel" — a gentle
 * cellular undulation from the mould surface — plus fine flow texture. Both are
 * far below the scale of the geometry, so they live entirely in the normal and
 * roughness maps.
 */
export function plasticSurface(seed = 7, size = 512) {
  const n = new SimplexNoise(seed);

  const height = (u: number, v: number) => {
    const peel = (1 - worley(u, v, 14, seed)) * 0.55;
    const flow = n.fbm(u * 26, v * 26, 4) * 0.28;
    const micro = n.noise2D(u * 190, v * 190) * 0.06;
    return peel + flow + micro;
  };

  const normalMap = buildNormalMap({ size, strength: 0.75 }, height);

  // Roughness follows the peel: the raised crests polish smoother than the
  // valleys, which is what gives moulded plastic its slightly mottled sheen.
  const roughnessMap = buildTexture({ size }, (u, v, out) => {
    const peel = 1 - worley(u, v, 14, seed);
    const grain = n.fbm(u * 40, v * 40, 4) * 0.5 + 0.5;
    const r = clamp01(0.5 + (grain - 0.5) * 0.35 - peel * 0.16);
    out[0] = out[1] = out[2] = r;
  });

  return { normalMap, roughnessMap };
}

/**
 * Anodised aluminium: a fine directional grain from the extrusion, sparse
 * deeper scratches, and a faint cloudy variation in the anodising itself.
 */
export function anodisedSurface(seed = 21, size = 512) {
  const n = new SimplexNoise(seed);
  const s2 = new SimplexNoise(seed + 991);

  // The grain runs along u, so it is stretched heavily in that axis.
  const height = (u: number, v: number) => {
    const grain = n.fbm(u * 3, v * 340, 3) * 0.5;
    const scratch = Math.pow(s2.ridged(u * 2, v * 90, 2), 9) * 1.6;
    const cloud = n.fbm(u * 5, v * 5, 4) * 0.12;
    return grain + scratch + cloud;
  };

  const normalMap = buildNormalMap({ size, strength: 0.5 }, height);

  const roughnessMap = buildTexture({ size }, (u, v, out) => {
    const grain = n.fbm(u * 3, v * 300, 3) * 0.5 + 0.5;
    const cloud = n.fbm(u * 6, v * 6, 4) * 0.5 + 0.5;
    const r = clamp01(0.28 + grain * 0.16 + (cloud - 0.5) * 0.1);
    out[0] = out[1] = out[2] = r;
  });

  return { normalMap, roughnessMap };
}

/**
 * Cast acrylic. Nearly optically flat, with only the faintest long-wavelength
 * waviness plus a few polish marks — enough to break up a mirror reflection so
 * it reads as a real sheet rather than a perfect analytic plane.
 */
export function acrylicSurface(seed = 33, size = 512) {
  const n = new SimplexNoise(seed);

  const height = (u: number, v: number) => {
    const waviness = n.fbm(u * 3.5, v * 3.5, 3) * 0.6;
    const polish = Math.pow(n.ridged(u * 60, v * 6, 2), 6) * 0.35;
    return waviness + polish;
  };

  const normalMap = buildNormalMap({ size, strength: 0.12 }, height);

  const roughnessMap = buildTexture({ size }, (u, v, out) => {
    const cloud = n.fbm(u * 4, v * 4, 4) * 0.5 + 0.5;
    const polish = Math.pow(n.ridged(u * 60, v * 6, 2), 6);
    out[0] = out[1] = out[2] = clamp01(0.045 + (cloud - 0.5) * 0.03 + polish * 0.09);
  });

  return { normalMap, roughnessMap };
}

/**
 * Fine-grain hardwood for the base. Growth rings are concentric-ish bands
 * distorted by noise, with darker latewood and scattered pore detail.
 */
export function woodSurface(seed = 5, size = 1024) {
  const n = new SimplexNoise(seed);
  const pores = new SimplexNoise(seed + 17);

  const rings = (u: number, v: number) => {
    // Distort the coordinate so the grain wanders like real timber.
    const warp = n.fbm(u * 2.2, v * 0.7, 4) * 0.35;
    const t = (v + warp) * 22;
    const ring = t - Math.floor(t);
    // Sharp latewood band, soft earlywood.
    return Math.pow(1 - Math.abs(ring * 2 - 1), 2.4);
  };

  const map = buildTexture({ size, srgb: true }, (u, v, out) => {
    const r = rings(u, v);
    const fibre = n.fbm(u * 14, v * 220, 3) * 0.5 + 0.5;
    const pore = smoothstep(0.62, 0.9, pores.noise2D(u * 300, v * 90) * 0.5 + 0.5);

    // Warm walnut: dark chocolate latewood into a lighter tan earlywood.
    const t = clamp01(r * 0.85 + (fibre - 0.5) * 0.3);
    out[0] = lerp(0.2, 0.075, t) - pore * 0.03;
    out[1] = lerp(0.125, 0.042, t) - pore * 0.02;
    out[2] = lerp(0.078, 0.028, t) - pore * 0.014;
  });

  const normalMap = buildNormalMap({ size, strength: 0.35 }, (u, v) => {
    const r = rings(u, v);
    const pore = smoothstep(0.7, 0.95, pores.noise2D(u * 300, v * 90) * 0.5 + 0.5);
    return r * 0.4 + n.fbm(u * 14, v * 200, 3) * 0.2 - pore * 0.9;
  });

  const roughnessMap = buildTexture({ size }, (u, v, out) => {
    const r = rings(u, v);
    const pore = smoothstep(0.65, 0.92, pores.noise2D(u * 300, v * 90) * 0.5 + 0.5);
    // Open pores scatter light; the satin finish sits around 0.38.
    out[0] = out[1] = out[2] = clamp01(0.34 + r * 0.08 + pore * 0.22);
  });

  return { map, normalMap, roughnessMap };
}

/**
 * The film of dust, skin oil and micro-scratching that accumulates on anything
 * sitting in a room. Multiplied into roughness, it is the single cheapest
 * upgrade from "CG render" to "photograph of an object".
 */
export function grimeMap(seed = 51, size = 512) {
  const n = new SimplexNoise(seed);
  const s2 = new SimplexNoise(seed + 313);

  return buildTexture({ size }, (u, v, out) => {
    const dust = clamp01(n.fbm(u * 7, v * 7, 5) * 0.5 + 0.5);
    const clump = 1 - worley(u, v, 9, seed + 4);
    const smudge = clamp01(s2.fbm(u * 3, v * 3, 3) * 0.5 + 0.5);
    const scratches = Math.pow(s2.ridged(u * 30, v * 34, 3), 7);

    const amount = clamp01(dust * 0.5 + clump * 0.22 + smudge * 0.3 + scratches * 0.5);
    out[0] = out[1] = out[2] = amount;
  });
}

/** Release a generated texture's GPU memory and its backing array. */
export function disposeTexture(tex: Texture | null | undefined): void {
  if (!tex) return;
  tex.dispose();
}
