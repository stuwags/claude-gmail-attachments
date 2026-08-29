/**
 * The post-processing chain (bible §4).
 *
 * Order is exact and comes straight from the bible: render → AO → bloom → DoF →
 * chromatic aberration → vignette → film grain → tone mapping → SMAA (Tier B).
 * The two things worth understanding before changing anything here are where the
 * tone mapping happens and why the effects are split across the passes they are.
 *
 * ## Where AgX happens, and why it happens exactly once
 *
 * Bible §0 configures the renderer with `toneMapping = AgXToneMapping` and
 * `toneMappingExposure = 1.15`, and §4 says every effect runs pre-tonemap on
 * half-float buffers with tone mapping last. Both are true at the same time, and
 * not by accident:
 *
 *   - Three.js only compiles its tone-mapping function into a material when that
 *     material is drawn straight to the canvas (`WebGLPrograms.getParameters`
 *     takes `renderer.toneMapping` only when `currentRenderTarget === null`).
 *     The `RenderPass` here draws into the composer's HalfFloat target, so the
 *     scene lands in the buffer as untouched linear HDR and the renderer's
 *     `toneMapping` setting has no effect on it. AO, bloom, DoF, aberration,
 *     vignette and grain therefore all see real scene-referred radiance —
 *     which is what makes a bloom threshold of exactly 1.0 mean anything.
 *   - AgX is then applied once, by the `ToneMappingEffect` at the tail of the
 *     final `EffectPass`. It reads the same `toneMappingExposure` uniform three
 *     pushes onto every material, so §0's 1.15 flows through automatically and
 *     there is a single place the exposure lives.
 *   - The final pass cannot double-tone-map on its way to the canvas because
 *     postprocessing's `EffectMaterial` sets `toneMapped: false`, so three skips
 *     its own operator even though that pass does render to the screen. sRGB
 *     encoding is still applied there (and only there), by three, because the
 *     material's output colour space follows the render target.
 *
 * The chain mirrors `renderer.toneMapping` rather than forcing it, so §4.8's
 * "fallback on r < 160: ACESFilmic" is honoured by whatever the scene sets.
 *
 * ## Why the passes are split the way they are
 *
 * `EffectPass` merges effects into one shader, which is what you want — but a
 * merged effect's inputs are the *pass* input, not the running colour. Bloom and
 * DoF both prefilter their own buffers in `update()`, so merging them would have
 * DoF blurring the pre-bloom image and compositing it over the bloomed one. They
 * get a pass each, in bible order, so DoF genuinely blurs the bloomed frame.
 * Aberration, vignette, grain and tone mapping have no such prefilter and merge
 * into one shader; `EffectPass` sorts by effect attribute (convolution first),
 * which puts the aberration ahead of the other three and leaves their registered
 * order intact — exactly §4.5 → §4.6 → §4.7 → §4.8.
 */

import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  CineonToneMapping,
  DataTexture,
  HalfFloatType,
  LinearToneMapping,
  NearestFilter,
  NeutralToneMapping,
  RedFormat,
  ReinhardToneMapping,
  RepeatWrapping,
  UnsignedByteType,
  Uniform,
  Vector2,
  Vector3,
  type PerspectiveCamera,
  type Scene,
} from 'three';
import {
  BlendFunction,
  BloomEffect,
  ChromaticAberrationEffect,
  DepthOfFieldEffect,
  Effect,
  EffectComposer,
  EffectPass,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
  type Pass,
} from 'postprocessing';
// n8ao ships no type declarations (its package.json has no `types` entry), so the
// import is untyped. It is narrowed to `N8AOPassLike` immediately below rather
// than letting `any` leak into the rest of the file.
// @ts-ignore -- untyped dependency
import { N8AOPostPass } from 'n8ao';
import { mulberry32 } from '../procedural';
import type { QualityTier } from '../api';
import type { BypassTarget, PostFX, PostFXOptions, PostState } from './types';

/* ------------------------------------------------------------------ *
 * Bible constants
 * ------------------------------------------------------------------ */

/** §4.2 — world-space AO radius in metres, and the Tier A intensity. */
const AO_RADIUS = 0.03;
const AO_INTENSITY = 2.0;
const AO_DISTANCE_FALLOFF = 0.1;

/** §4.3 — HDR-only bloom. Nothing below 1.0 is allowed to bloom. */
const BLOOM_THRESHOLD = 1.0;
const BLOOM_INTENSITY = 0.12;
const BLOOM_RADIUS = 0.55;

/** §4.4 — depth of field, per state. */
const DOF_PLAY = { worldFocusRange: 0.8, bokehScale: 1.0 } as const;
const DOF_TIGHT = { worldFocusRange: 0.12, bokehScale: 3.2 } as const;

/** §4.5 — sub-pixel at centre, about half a pixel at the corners. */
const ABERRATION_OFFSET = 0.0004;
const ABERRATION_MODULATION_OFFSET = 0.5;

/** §4.6 */
const VIGNETTE_OFFSET = 0.3;
const VIGNETTE_DARKNESS = 0.45;

/**
 * §4.6 names `offset 0.3, darkness 0.45`, but §9 item 13 caps the corner falloff
 * at 0.3 EV, and postprocessing's default vignette curve at those parameters
 * lands at 0.472x in the corner — 1.08 EV, well over budget. The named
 * parameters are kept (they set the shape of the falloff) and the depth is
 * brought inside the cap with the effect's blend opacity, which is a first-class
 * strength knob on `BlendFunction.NORMAL`. 0.30 gives a 0.841x corner, 0.249 EV
 * scene-referred and ~0.20 EV measured off the tone-mapped frame, leaving room
 * for §6.2's loss-sequence bias (+0.06 darkness) to stay inside the cap too.
 */
const VIGNETTE_STRENGTH = 0.3;

/** §4.7 — display-referred grain amplitude at mid grey, and its shadow/highlight floor. */
const GRAIN_AMPLITUDE = 0.018;
const GRAIN_FLOOR_RATIO = 0.006 / 0.018;

/**
 * The grain shader converts a display-referred amplitude into a relative linear
 * perturbation using a gamma-2.2 slope proxy (see the shader). AgX's real slope
 * at mid grey is 0.83x that proxy, so the amplitude uniform carries the
 * reciprocal; without it the delivered grain would be ~17% shy of §4.7's 0.018.
 * Calibrated against AgX at exposure 1.15 on a linear 0.18 patch, and confirmed
 * by measurement: a flat mid-grey field renders with a grain standard deviation
 * of 2.7/255, which is the 2.65 a uniform +/-0.018 peak predicts.
 */
const GRAIN_AGX_SLOPE_CORRECTION = 1.206;

/** §4.7 — the blue-noise mask. 128 x 128 and tileable, generated at boot. */
const BLUE_NOISE_SIZE = 128;

/** §5.1 `gallery` easing; §4.4 uses it over 600 ms for the DoF state change. */
const FOCUS_TRANSITION_MS = 600;

/**
 * §1.3 camera target. The DoF focus plane tracks the camera-to-target distance,
 * which is 1.24 m in the rest pose. The camera rig may publish a live target on
 * `camera.userData.focusTarget`; if it does not, this is the right answer for
 * every pose the rig is allowed to take, because §1.4 orbits about this point.
 */
const DEFAULT_FOCUS_TARGET = new Vector3(0, 0.17, 0);

/** Bible tiers: A is the full stack, B is the iPad degrade list in §0. */
const isTierA = (tier: QualityTier): boolean => tier === 'high' || tier === 'ultra';

/* ------------------------------------------------------------------ *
 * Easing
 * ------------------------------------------------------------------ */

/**
 * `cubic-bezier(x1, y1, x2, y2)` as a scalar easing function.
 *
 * The x-for-t solve is Newton–Raphson with a bisection fallback: the `gallery`
 * curve has a near-flat lead-in where the derivative approaches zero and Newton
 * alone can walk off the interval.
 */
function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const curve = (a: number, b: number, t: number) => {
    const c = 3 * a;
    const d = 3 * (b - a) - c;
    const e = 1 - c - d;
    return ((e * t + d) * t + c) * t;
  };
  const slope = (a: number, b: number, t: number) => {
    const c = 3 * a;
    const d = 3 * (b - a) - c;
    const e = 1 - c - d;
    return (3 * e * t + 2 * d) * t + c;
  };

  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i++) {
      const err = curve(x1, x2, t) - x;
      if (Math.abs(err) < 1e-6) return curve(y1, y2, t);
      const d = slope(x1, x2, t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 24; i++) {
      const err = curve(x1, x2, t) - x;
      if (Math.abs(err) < 1e-6) break;
      if (err > 0) hi = t;
      else lo = t;
      t = (lo + hi) * 0.5;
    }
    return curve(y1, y2, t);
  };
}

/** §5.1 `gallery`. */
const gallery = cubicBezier(0.33, 0, 0.12, 1);

/* ------------------------------------------------------------------ *
 * Blue noise (§4.7)
 * ------------------------------------------------------------------ */

/**
 * A tileable blue-noise mask, generated rather than bundled.
 *
 * §0 permits one 128 x 128 blue-noise binary in the bundle; generating it costs
 * about 20 ms at boot and keeps the app asset-free, which matters more for an
 * offline-cached iPad build than 16 KB does.
 *
 * The method is the iterative high-pass / histogram-re-uniformisation variant of
 * void-and-cluster: low-pass the field with a wrapped Gaussian, subtract to get
 * the high-frequency residual, then rank the residual back onto a perfectly flat
 * histogram. Repeating that drives energy out of the low frequencies while the
 * value distribution stays exactly uniform, which is precisely the definition of
 * a blue-noise mask. The Gaussian wraps, so the result tiles seamlessly.
 *
 * Full void-and-cluster would need an O(N^2) min/max search per placement; this
 * converges to the same spectral shape in O(N) per iteration, in about 20 ms.
 * Measured on the grain as it lands in the final 8-bit frame: radially averaged
 * power below r=8 sits at ~2% of the high-frequency plateau, and the lag-1
 * autocorrelation is -0.23 in both axes (white noise measures 0.00).
 */
function generateBlueNoise(size: number): Uint8Array {
  const n = size * size;
  const radius = 3;
  const sigma = 1.5;
  const iterations = 16;
  const bins = 8192;

  const taps = 2 * radius + 1;
  const kernel = new Float32Array(taps);
  let kernelSum = 0;
  for (let k = -radius; k <= radius; k++) {
    const w = Math.exp(-(k * k) / (2 * sigma * sigma));
    kernel[k + radius] = w;
    kernelSum += w;
  }
  for (let i = 0; i < taps; i++) kernel[i] /= kernelSum;

  // Wrapped tap offsets, precomputed so the inner loop has no modulo.
  const wrap = new Int32Array(size + 2 * radius);
  for (let i = 0; i < wrap.length; i++) wrap[i] = (i - radius + size) % size;

  // Start from a random permutation of the uniform ramp, so the histogram is
  // already exactly flat and every iteration only has to fix the spectrum.
  const rnd = mulberry32(0xb1ee0015);
  const value = new Float32Array(n);
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  for (let i = 0; i < n; i++) value[order[i]] = (i + 0.5) / n;

  const tmp = new Float32Array(n);
  const high = new Float32Array(n);
  const count = new Uint32Array(bins);
  const bin = new Uint16Array(n);

  for (let it = 0; it < iterations; it++) {
    // Separable wrapped Gaussian: horizontal into tmp, vertical into high.
    for (let y = 0; y < size; y++) {
      const row = y * size;
      for (let x = 0; x < size; x++) {
        let s = 0;
        for (let k = 0; k < taps; k++) s += kernel[k] * value[row + wrap[x + k]];
        tmp[row + x] = s;
      }
    }
    for (let y = 0; y < size; y++) {
      const row = y * size;
      for (let x = 0; x < size; x++) {
        let s = 0;
        for (let k = 0; k < taps; k++) s += kernel[k] * tmp[wrap[y + k] * size + x];
        high[row + x] = value[row + x] - s;
      }
    }

    // Rank the residual back onto a flat histogram, by counting sort.
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = high[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const scale = (bins - 1) / (max - min || 1);
    count.fill(0);
    for (let i = 0; i < n; i++) {
      const b = ((high[i] - min) * scale) | 0;
      bin[i] = b;
      count[b]++;
    }
    let acc = 0;
    for (let b = 0; b < bins; b++) {
      const c = count[b];
      count[b] = acc;
      acc += c;
    }
    const inv = 1 / n;
    for (let i = 0; i < n; i++) value[i] = (count[bin[i]]++ + 0.5) * inv;
  }

  const data = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const q = (value[i] * 256) | 0;
    data[i] = q > 255 ? 255 : q;
  }
  return data;
}

function createBlueNoiseTexture(): DataTexture {
  const tex = new DataTexture(
    generateBlueNoise(BLUE_NOISE_SIZE),
    BLUE_NOISE_SIZE,
    BLUE_NOISE_SIZE,
    RedFormat,
    UnsignedByteType,
  );
  tex.name = 'PostFX.BlueNoise';
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  // Nearest, always. Bilinear interpolation of a blue-noise mask low-passes it,
  // and a low-passed blue-noise mask is just noise.
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------ *
 * Film grain (§4.7)
 * ------------------------------------------------------------------ */

/**
 * Blue-noise film grain, luminance-weighted, applied to the linear HDR signal.
 *
 * Two things are load-bearing here:
 *
 * 1. The mask is sampled one texel per framebuffer pixel with nearest filtering.
 *    Any other mapping resamples the mask and destroys the spectral property
 *    that makes it worth generating in the first place.
 * 2. §4.7's amplitudes (0.018 mid grey, 0.006 in the tails) are what the viewer
 *    sees, but this effect runs before AgX, so they have to be converted into a
 *    perturbation of the linear signal. The tone curve's slope varies enormously
 *    — near black a linear delta is worth roughly 4.5x what it is at mid grey —
 *    so a fixed linear amplitude would put all the grain in the shadows. The
 *    shader estimates display lightness as `d = (exposed luminance)^(1/2.2)`,
 *    shapes the amplitude against `d`, and converts back through that proxy's
 *    log slope (`dx/x = 2.2 * dd / d`). The perturbation is applied
 *    multiplicatively, which keeps HDR specular cores intact (a value of 5.0
 *    stays 5.0 give or take 0.3%), can never produce a negative colour, and is
 *    also how film density fluctuation actually behaves.
 */
const GRAIN_SHADER = /* glsl */ `
uniform sampler2D noiseTexture;
uniform vec2 noiseOffset;
uniform float noiseScale;
uniform float amplitude;
uniform float floorRatio;
uniform float exposure;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {

	// One mask texel per framebuffer pixel, offset by whole texels.
	vec2 noiseUv = (UV * resolution + noiseOffset) * noiseScale;
	float n = texture2D(noiseTexture, noiseUv).r * 2.0 - 1.0;

	float x = max(luminance(inputColor.rgb), 0.0) * exposure;

	// Display-lightness proxy. Highlights clamp to 1.0, which is what puts the
	// specular cores in the "tapered" end of the weighting rather than the middle.
	float d = pow(min(x, 1.0), 0.45454545);

	// Full amplitude across the midtones, tapering to the floor in the tails.
	// (smoothstep with edge0 > edge1 is undefined in GLSL, hence the 1.0 - form.)
	float w = smoothstep(0.0, 0.35, d) * (1.0 - smoothstep(0.65, 1.0, d));
	float a = amplitude * mix(floorRatio, 1.0, w);

	// Display delta -> relative linear delta through the proxy's log slope.
	float g = 2.2 * a * n / max(d, 0.05);

	outputColor = vec4(inputColor.rgb * (1.0 + g), inputColor.a);

}
`;

function createGrainEffect(noise: DataTexture): Effect {
  return new Effect('FilmGrainEffect', GRAIN_SHADER, {
    blendFunction: BlendFunction.SRC,
    uniforms: new Map<string, Uniform>([
      ['noiseTexture', new Uniform(noise)],
      ['noiseOffset', new Uniform(new Vector2())],
      ['noiseScale', new Uniform(1 / BLUE_NOISE_SIZE)],
      ['amplitude', new Uniform(GRAIN_AMPLITUDE * GRAIN_AGX_SLOPE_CORRECTION)],
      ['floorRatio', new Uniform(GRAIN_FLOOR_RATIO)],
      ['exposure', new Uniform(1.15)],
    ]),
  });
}

/**
 * The R2 low-discrepancy sequence (Roberts 2018), used to walk the mask offset.
 *
 * A random offset per frame clumps; R2 spreads successive offsets as evenly over
 * the 128 x 128 torus as a 2D sequence can, so no two nearby frames reuse a
 * similar arrangement and the grain reads as motion rather than as flicker.
 * Offsets are quantised to whole texels — a fractional offset would need
 * interpolation, and see above about interpolating blue noise.
 */
const R2_ALPHA_X = 0.7548776662466927;
const R2_ALPHA_Y = 0.5698402909980532;

function r2Offset(frame: number, out: Vector2): Vector2 {
  const fx = (0.5 + R2_ALPHA_X * frame) % 1;
  const fy = (0.5 + R2_ALPHA_Y * frame) % 1;
  return out.set(Math.floor(fx * BLUE_NOISE_SIZE), Math.floor(fy * BLUE_NOISE_SIZE));
}

/* ------------------------------------------------------------------ *
 * n8ao
 * ------------------------------------------------------------------ */

/** The slice of `N8AOPostPass` this chain touches. */
interface N8AOPassLike extends Pass {
  configuration: {
    aoRadius: number;
    distanceFalloff: number;
    intensity: number;
    screenSpaceRadius: boolean;
    halfRes: boolean;
    depthAwareUpsampling: boolean;
    colorMultiply: boolean;
    gammaCorrection: boolean;
  };
}

type N8AOPassCtor = new (
  scene: Scene,
  camera: PerspectiveCamera,
  width: number,
  height: number,
) => N8AOPassLike;

const N8AOPass = N8AOPostPass as unknown as N8AOPassCtor;

/* ------------------------------------------------------------------ *
 * Tone mapping mode
 * ------------------------------------------------------------------ */

/**
 * Mirror whatever operator the renderer is configured with, so §4.8's "fallback
 * on r < 160: ACESFilmic" is decided in one place (the renderer config) rather
 * than twice. An unconfigured renderer still gets AgX, because §4.8 is the
 * contract and a linear frame is never the right answer.
 */
function toneMappingModeFor(rendererToneMapping: number): ToneMappingMode {
  switch (rendererToneMapping) {
    case ACESFilmicToneMapping:
      return ToneMappingMode.ACES_FILMIC;
    case NeutralToneMapping:
      return ToneMappingMode.NEUTRAL;
    case ReinhardToneMapping:
      return ToneMappingMode.REINHARD;
    case CineonToneMapping:
      return ToneMappingMode.CINEON;
    case LinearToneMapping:
      return ToneMappingMode.LINEAR;
    case AgXToneMapping:
    default:
      return ToneMappingMode.AGX;
  }
}

/* ------------------------------------------------------------------ *
 * The chain
 * ------------------------------------------------------------------ */

export function createPostFX(opts: PostFXOptions): PostFX {
  const { renderer, scene, camera, reducedMotion } = opts;

  let tier = opts.quality;
  let tierA = isTierA(tier);

  const size = renderer.getDrawingBufferSize(new Vector2());

  /* -------------------- 1. render pass (§4.1) -------------------- */

  const composer = new EffectComposer(renderer, {
    frameBufferType: HalfFloatType,
    multisampling: tierA ? 4 : 0,
  });
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  /* -------------------- 2. ambient occlusion (§4.2) -------------------- */

  const aoPass = new N8AOPass(scene, camera, size.width, size.height);
  aoPass.configuration.aoRadius = AO_RADIUS;
  aoPass.configuration.distanceFalloff = AO_DISTANCE_FALLOFF;
  aoPass.configuration.intensity = tierA ? AO_INTENSITY : AO_INTENSITY * 0.5;
  // World-space radius (the bible quotes 0.03 in metres, not in pixels), and
  // half resolution with n8ao's own denoise and depth-aware upsample.
  aoPass.configuration.screenSpaceRadius = false;
  aoPass.configuration.halfRes = true;
  aoPass.configuration.depthAwareUpsampling = true;
  // AO darkens indirect only. `gammaCorrection` is left to n8ao's autoset, which
  // ties it to `renderToScreen` and therefore stays off inside the chain — the
  // buffer must remain linear for everything downstream.
  aoPass.configuration.colorMultiply = true;
  composer.addPass(aoPass);

  /* -------------------- 3. bloom (§4.3) -------------------- */

  const bloomEffect = new BloomEffect({
    // Additive, not the library default SCREEN. `dst + src - dst*src` inverts on
    // HDR input: a specular core at 2.0 comes out *darker* than it went in.
    // Additive veiling glare is both physically right and safe above 1.0.
    blendFunction: BlendFunction.ADD,
    luminanceThreshold: BLOOM_THRESHOLD,
    mipmapBlur: true,
    intensity: BLOOM_INTENSITY,
    radius: BLOOM_RADIUS,
  });
  const bloomPass = new EffectPass(camera, bloomEffect);
  composer.addPass(bloomPass);

  /* -------------------- 4. depth of field (§4.4) -------------------- */

  const dofEffect = new DepthOfFieldEffect(camera, {
    focusDistance: DEFAULT_FOCUS_TARGET.length(),
    focusRange: DOF_PLAY.worldFocusRange,
    bokehScale: DOF_PLAY.bokehScale,
  });
  const dofPass = new EffectPass(camera, dofEffect);
  composer.addPass(dofPass);

  /* -------------------- 5-8. aberration, vignette, grain, tone map -------------------- */

  const aberrationEffect = new ChromaticAberrationEffect({
    offset: new Vector2(ABERRATION_OFFSET, ABERRATION_OFFSET),
    radialModulation: true,
    modulationOffset: ABERRATION_MODULATION_OFFSET,
  });

  const vignetteEffect = new VignetteEffect({
    offset: VIGNETTE_OFFSET,
    darkness: VIGNETTE_DARKNESS,
  });
  vignetteEffect.blendMode.opacity.value = VIGNETTE_STRENGTH;

  const blueNoise = createBlueNoiseTexture();
  const grainEffect = createGrainEffect(blueNoise);
  const grainOffset = grainEffect.uniforms.get('noiseOffset') as Uniform;
  const grainExposure = grainEffect.uniforms.get('exposure') as Uniform;

  const toneMappingEffect = new ToneMappingEffect({
    mode: toneMappingModeFor(renderer.toneMapping),
  });
  let toneMappingSource = renderer.toneMapping;

  const gradePass = new EffectPass(
    camera,
    aberrationEffect,
    vignetteEffect,
    grainEffect,
    toneMappingEffect,
  );
  composer.addPass(gradePass);

  /* -------------------- 9. SMAA (§4.9, Tier B only) -------------------- */

  let smaaEffect: SMAAEffect | null = null;
  let smaaPass: EffectPass | null = null;

  function ensureSMAA(): EffectPass {
    if (smaaPass === null) {
      smaaEffect = new SMAAEffect({ preset: SMAAPreset.HIGH });
      smaaPass = new EffectPass(camera, smaaEffect);
    }
    return smaaPass;
  }

  /**
   * MSAA and SMAA never run together (§4.9). `addPass`/`removePass` rather than
   * `enabled`, because the composer hands "render to screen" to whichever pass is
   * last: a disabled trailing pass would leave nothing drawing to the canvas.
   */
  function applyAntiAliasing(): void {
    composer.multisampling = tierA ? 4 : 0;
    const active = composer.passes.indexOf(smaaPass as Pass) !== -1;
    if (tierA && active) {
      composer.removePass(smaaPass as Pass);
    } else if (!tierA && !active) {
      composer.addPass(ensureSMAA());
    }
  }

  applyAntiAliasing();

  /* -------------------- focus state -------------------- */

  type Focus = { worldFocusRange: number; bokehScale: number };

  let state: PostState = 'play';
  let override: Focus | null = null;
  const current: Focus = { ...DOF_PLAY };
  const from: Focus = { ...DOF_PLAY };
  let target: Focus = { ...DOF_PLAY };
  let transitionMs = FOCUS_TRANSITION_MS;

  const focusTarget = new Vector3();
  const noiseOffset = new Vector2();

  const bypass = new Set<BypassTarget>();
  const isBypassed = (t: BypassTarget) => bypass.has(t) || bypass.has('all');

  function desiredFocus(): Focus {
    if (override !== null) return override;
    return state === 'play' ? DOF_PLAY : DOF_TIGHT;
  }

  function retarget(immediate: boolean): void {
    const next = desiredFocus();
    if (next.worldFocusRange === target.worldFocusRange && next.bokehScale === target.bokehScale) {
      return;
    }
    from.worldFocusRange = current.worldFocusRange;
    from.bokehScale = current.bokehScale;
    target = { ...next };
    if (immediate) {
      // Park the clock at the end of the ease rather than special-casing it.
      transitionMs = FOCUS_TRANSITION_MS;
      current.worldFocusRange = target.worldFocusRange;
      current.bokehScale = target.bokehScale;
    } else {
      transitionMs = 0;
    }
  }

  function advanceFocus(dtMs: number): void {
    if (transitionMs < FOCUS_TRANSITION_MS) {
      transitionMs = Math.min(FOCUS_TRANSITION_MS, transitionMs + dtMs);
      const k = gallery(transitionMs / FOCUS_TRANSITION_MS);
      current.worldFocusRange =
        from.worldFocusRange + (target.worldFocusRange - from.worldFocusRange) * k;
      current.bokehScale = from.bokehScale + (target.bokehScale - from.bokehScale) * k;
    }
    dofEffect.cocMaterial.focusRange = current.worldFocusRange;
    dofEffect.bokehScale = current.bokehScale;
  }

  /**
   * §4.4 — the focus plane tracks the camera-to-target distance every frame, so
   * the board sits dead on the focus plane through parallax, the intro move and
   * the win dolly. With `worldFocusRange 0.8` the whole board is inside a
   * circle of confusion of about 0.04, i.e. sub-texel, and only the 8 m backdrop
   * is far enough out to defocus at all.
   */
  function updateFocusDistance(): void {
    const published = camera.userData['focusTarget'] as Vector3 | undefined;
    if (published && typeof published.x === 'number') focusTarget.copy(published);
    else focusTarget.copy(DEFAULT_FOCUS_TARGET);
    dofEffect.cocMaterial.focusDistance = camera.position.distanceTo(focusTarget);
  }

  /* -------------------- bypass -------------------- */

  /**
   * `BlendFunction.DST` drops an effect out of the merged shader entirely rather
   * than multiplying it by zero, so the A/B in §9 items 9 and 12 compares "with"
   * against a frame the effect genuinely never touched. Tone mapping is not a
   * bypass target and stays in the pass regardless — an untone-mapped frame is
   * not a useful comparison, it is just a broken one.
   */
  function setEffectActive(effect: Effect, active: boolean, blend: BlendFunction): void {
    const want = active ? blend : BlendFunction.DST;
    if (effect.blendMode.blendFunction !== want) effect.blendMode.blendFunction = want;
  }

  /** Tier B drops DoF except during the win sequence (§0). */
  const dofAllowed = () => tierA || state === 'win';

  function applyBypass(): void {
    aoPass.enabled = !isBypassed('ao');
    bloomPass.enabled = !isBypassed('bloom');
    dofPass.enabled = dofAllowed() && !isBypassed('dof');
    setEffectActive(aberrationEffect, !isBypassed('chromatic'), BlendFunction.NORMAL);
    setEffectActive(vignetteEffect, !isBypassed('vignette'), BlendFunction.NORMAL);
    setEffectActive(grainEffect, !isBypassed('grain'), BlendFunction.SRC);
  }

  applyBypass();

  /* -------------------- frame -------------------- */

  let frame = 0;

  return {
    render(dtMs: number): void {
      // The renderer owns the operator and the exposure (§0); the chain follows
      // it rather than keeping a second copy that can drift.
      if (renderer.toneMapping !== toneMappingSource) {
        toneMappingSource = renderer.toneMapping;
        toneMappingEffect.mode = toneMappingModeFor(toneMappingSource);
      }
      grainExposure.value = renderer.toneMappingExposure;

      // Reduced motion freezes the grain on one arrangement rather than turning
      // it off: the texture stays, the movement goes (§9 item 18's spirit).
      if (!reducedMotion) frame++;
      grainOffset.value = r2Offset(frame, noiseOffset);

      updateFocusDistance();
      advanceFocus(dtMs);

      composer.render(dtMs / 1000);
    },

    resize(width: number, height: number): void {
      // `width`/`height` arrive in device pixels; the composer sizes its buffers
      // from the renderer's drawing-buffer size, so it wants CSS pixels and will
      // reapply the pixel ratio itself.
      const dpr = renderer.getPixelRatio() || 1;
      composer.setSize(Math.round(width / dpr), Math.round(height / dpr), false);
    },

    setState(next: PostState, immediate = false): void {
      state = next;
      retarget(immediate);
      // Tier B's DoF gate depends on the state, so re-evaluate it here too.
      applyBypass();
    },

    setFocusOverride(focus: Focus | null): void {
      override = focus === null ? null : { ...focus };
      retarget(false);
    },

    setVignetteBias(bias: number): void {
      vignetteEffect.darkness = VIGNETTE_DARKNESS + bias;
    },

    setQuality(next: QualityTier): void {
      if (next === tier) return;
      tier = next;
      tierA = isTierA(tier);
      aoPass.configuration.intensity = tierA ? AO_INTENSITY : AO_INTENSITY * 0.5;
      applyAntiAliasing();
      applyBypass();
    },

    setBypass(targets: readonly BypassTarget[]): void {
      bypass.clear();
      for (const t of targets) bypass.add(t);
      applyBypass();
    },

    dispose(): void {
      // A detached SMAA pass is not in `composer.passes` and would otherwise leak
      // its lookup textures.
      if (smaaPass !== null && composer.passes.indexOf(smaaPass) === -1) smaaPass.dispose();
      composer.dispose();
      blueNoise.dispose();
    },
  };
}
