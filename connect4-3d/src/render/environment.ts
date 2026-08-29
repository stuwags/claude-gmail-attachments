/**
 * The studio: image-based lighting, the analytic rig, the backdrop, and the
 * contact shadow that glues the set to the table. Bible §1.1, §2.
 *
 * The single most important thing in this file is that the environment map is
 * built from *rectangles*. A procedural gradient or an equirect sky gives every
 * glossy surface a round, featureless highlight, which is the giveaway that an
 * image was rendered rather than photographed. Four emissive cards in a black
 * box, baked through PMREM, put window-shaped reflections on the disc lacquer —
 * bible §9 item 1, and the reason this file exists at all.
 */

import {
  BackSide,
  BoxGeometry,
  Color,
  DataTexture,
  DirectionalLight,
  DoubleSide,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  MultiplyBlending,
  NearestFilter,
  PlaneGeometry,
  PMREMGenerator,
  RectAreaLight,
  RepeatWrapping,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  UnsignedByteType,
  Vector3,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';

import { clamp01, mulberry32 } from './procedural';
import { CAMERA_TARGET, PLINTH_DEPTH, PLINTH_WIDTH } from './layout';

/* ------------------------------------------------------------------ *
 * Palette (bible §0). The only hues permitted in the product.
 * ------------------------------------------------------------------ */

export const PALETTE = {
  ember: 0xce5a32,
  petrol: 0x0f6068,
  emberGlow: 0xff9666,
  petrolGlow: 0x53d7db,
  gold: 0xffd9a8,
  pewter: 0xadb9c6,
  starlight: 0xd6cfc4,
  smoke: 0x6e7a82,
  basalt: 0x23262a,
  voidLow: 0x101114,
  voidHigh: 0x1d2024,
  pool: 0x2a2521,
  ink: 0xf2f1ee,
  inkDim: 0x9ba0a6,
} as const;

/**
 * Scene-referred scale for everything that emits light.
 *
 * The bible's rig (§2.1) and its exposure (§0) are internally inconsistent with
 * its bloom threshold (§4.3, `luminanceThreshold 1.0`, "HDR-only, nothing below
 * 1.0 ever blooms"). Measured, the rig as written puts ~11 irradiance on the
 * board, and an ember disc — a 0.59-albedo surface — comes back at a radiance of
 * about 1.8. That is a mid-tone, not a highlight, and bloom was picking up every
 * disc body: §9 item 9 fails on sight, and the halo desaturated the discs into
 * pale salmon and washed the lathed grooves out of them entirely.
 *
 * Tone mapping happens *after* bloom, so exposure cannot fix this — and §0's
 * exposure is frozen in any case. The rig is the right place: the same factor
 * also brings the frame down from two stops hot to the art director's screen
 * targets (tabletop 33-45 code values, top rail 95-125), because irradiance and
 * displayed brightness are the same lever once exposure is fixed.
 *
 * The canonical key : fill : rim ratio of 1 : 0.24 : 2.4 is untouched — this is
 * a uniform scale on all four emitters and on the environment, not a rebalance.
 * Everything in this codebase that authors an absolute radiance — the backdrop,
 * the ghost, the hover strokes, the disc ignition emissive — carries it too.
 *
 * Integrators: values authored in scene-referred units elsewhere (the coach's
 * additive filaments, the win filament's emissive 3.0) are not scaled, so they
 * now sit further above the scene than before. That is deliberate for the
 * filament, which §4.3 wants to tickle bloom; the coach's opacities are worth
 * re-measuring against §7.2's on-screen values.
 */
export const RIG_SCALE = 0.28;

/** Bible §0's exposure, unchanged. Brightness is corrected in the rig, not here. */
export const TONE_EXPOSURE = 1.15;

const KEY_COLOR = 0xfff1e3;
const FILL_COLOR = 0xd8e3ee;
const RIM_COLOR = 0xeaf1ff;
const HORIZON_COLOR = 0x35302a;

const TARGET = new Vector3(CAMERA_TARGET[0], CAMERA_TARGET[1], CAMERA_TARGET[2]);

/* ------------------------------------------------------------------ *
 * Blue noise
 * ------------------------------------------------------------------ */

/**
 * A 64×64 tileable blue-noise mask, generated rather than bundled.
 *
 * Method: white noise, high-pass filtered by subtracting a wrapped Gaussian
 * blur of itself, then rank-ordered back to a perfectly uniform histogram. That
 * last step is what matters — dithering needs a flat distribution or it biases
 * the mean, and the rank sort gives it exactly while the high-pass leaves the
 * energy in the high frequencies where the eye integrates it away. It is not
 * void-and-cluster, but at 64² the spectra are close enough that no banding
 * survives and it costs under a millisecond instead of seconds.
 */
export function createBlueNoiseTexture(size = 64, seed = 0x5eed): DataTexture {
  const n = size * size;
  const rnd = mulberry32(seed);
  const white = new Float32Array(n);
  for (let i = 0; i < n; i++) white[i] = rnd();

  // Wrapped separable Gaussian, sigma ~1.5, radius 4.
  const kernel = [0.0088, 0.0796, 0.2443, 0.3346, 0.2443, 0.0796, 0.0088];
  const tmp = new Float32Array(n);
  const blurred = new Float32Array(n);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let s = 0;
      for (let k = -3; k <= 3; k++) s += kernel[k + 3] * white[y * size + ((x + k + size) % size)];
      tmp[y * size + x] = s;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let s = 0;
      for (let k = -3; k <= 3; k++) s += kernel[k + 3] * tmp[((y + k + size) % size) * size + x];
      blurred[y * size + x] = s;
    }
  }

  const highpass = new Float32Array(n);
  for (let i = 0; i < n; i++) highpass[i] = white[i] - blurred[i];

  const order = new Uint16Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const asArray = Array.from(order).sort((a, b) => highpass[a] - highpass[b]);

  const data = new Uint8Array(n * 4);
  for (let rank = 0; rank < n; rank++) {
    const i = asArray[rank] * 4;
    const v = Math.round((rank / (n - 1)) * 255);
    data[i] = data[i + 1] = data[i + 2] = v;
    data[i + 3] = 255;
  }

  const tex = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  // Point sampling: the mask must land one texel per device pixel, and any
  // filtering at all would low-pass exactly the frequencies that make it blue.
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------ *
 * Image-based lighting (bible §2.3)
 * ------------------------------------------------------------------ */

/** Emissive card, positioned at a light and aimed where the light aims. */
function emissiveCard(w: number, h: number, hex: number, intensity: number, at: Vector3): Mesh {
  const material = new MeshBasicMaterial({ side: DoubleSide, toneMapped: false });
  // MeshBasicMaterial has no "emissive"; a Color above 1.0 is the same thing
  // once it lands in PMREM's half-float target, and keeps the whole capture in
  // one unlit pass. Values are authored in sRGB then scaled in linear.
  material.color.setHex(hex).multiplyScalar(intensity);
  const mesh = new Mesh(new PlaneGeometry(w, h), material);
  mesh.position.copy(at);
  mesh.lookAt(TARGET);
  return mesh;
}

/**
 * Bake the studio into a PMREM cubemap. The source scene is thrown away
 * immediately: it exists only to be photographed once, at boot.
 */
export function buildEnvironmentMap(renderer: WebGLRenderer): Texture {
  const scene = new Scene();

  // Interior of a small dark room. Everything the environment shows that is not
  // a card is this, which is what keeps reflections dark and the highlights
  // readable as separate light sources.
  const room = new Mesh(
    new BoxGeometry(4, 3, 4),
    new MeshBasicMaterial({ color: 0x0c0d0f, side: BackSide, toneMapped: false }),
  );
  room.position.set(0, 0.6, 0);
  scene.add(room);

  scene.add(emissiveCard(1.2, 1.8, KEY_COLOR, 20, new Vector3(-0.85, 1.35, 0.95)));
  // 4.5 -> 1.5. §2.3's fill card is 6.25 m2 hanging 1.1 m off the subject, on
  // the same side as the rim: measured, the environment alone lit the tabletop's
  // right third 2.4x harder than its left, which is what inverted the key/fill
  // relationship. The analytic fill keeps its specified 2.2 and its canonical
  // 0.24 ratio; this is the card that was double-counting it.
  scene.add(emissiveCard(2.5, 2.5, FILL_COLOR, 1.5, new Vector3(1.6, 0.9, 0.6)));
  // 45 -> 32 (art-director revision): at 45 this card was the brightest thing
  // in the environment and lit the tabletop's right third harder than the key lit
  // its left, inverting the whole key/fill relationship.
  scene.add(emissiveCard(0.3, 1.8, RIM_COLOR, 32, new Vector3(1.15, 0.55, -1.25)));

  // Behind the camera: the long warm streak in the tabletop sheen, and the only
  // thing in the studio that a *front-facing* surface can reflect at all.
  //
  // Enlarged and dropped from §2.3's 3.0 x 0.6 at y = 0.4. Measured, the rails
  // were rendering at 28-44 code values against a 70-125 target, and the reason
  // is geometric: a vertical front face at board height mirrors the view ray
  // forward and *down*, crossing z = 1.9 at y = -0.09. The card as specified sat
  // entirely above that path, so the aluminium had nothing to reflect but the
  // black room. A taller card centred near the table plane lands in the mirror
  // path of both the rails and the slab, which is what the frame was missing.
  const horizon = emissiveCard(3.0, 1.6, HORIZON_COLOR, 1.2, new Vector3(0, 0.15, 1.9));
  scene.add(horizon);

  const pmrem = new PMREMGenerator(renderer);
  const target = pmrem.fromScene(scene, 0, 0.1, 20, { size: 256 });
  pmrem.dispose();

  scene.traverse((o) => {
    const mesh = o as Mesh;
    if (mesh.isMesh) {
      mesh.geometry.dispose();
      (mesh.material as MeshBasicMaterial).dispose();
    }
  });

  return target.texture;
}

/* ------------------------------------------------------------------ *
 * Analytic rig (bible §2.1, §2.2)
 * ------------------------------------------------------------------ */

export interface LightRig {
  group: Group;
  key: RectAreaLight;
  fill: RectAreaLight;
  rim: RectAreaLight;
  /** RectAreaLight cannot cast shadows, so a directional proxy runs the key axis. */
  shadow: DirectionalLight;
  /** Re-tint the key for the loss sequence. `kelvinDelta` negative is cooler. */
  setKeyTemperature(kelvinDelta: number): void;
  dispose(): void;
}

/**
 * Approximate Planckian locus, normalised so 6500 K is unity. Only the *ratio*
 * between two temperatures is used, so the absolute accuracy of the fit does
 * not matter; the smoothness of it does.
 */
function kelvinRGB(kelvin: number, out: Color): Color {
  const t = Math.min(40000, Math.max(1000, kelvin)) / 100;
  let r: number;
  let g: number;
  let b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  out.setRGB(
    Math.min(1, Math.max(0, r / 255)),
    Math.min(1, Math.max(0, g / 255)),
    Math.min(1, Math.max(0, b / 255)),
    'srgb-linear',
  );
  return out;
}

export function createLightRig(): LightRig {
  // Without this the LTC lookup textures are undefined and every RectAreaLight
  // renders pure black. It is idempotent, so calling it per rig is harmless.
  RectAreaLightUniformsLib.init();

  const group = new Group();
  group.name = 'light-rig';

  const key = new RectAreaLight(KEY_COLOR, 9.0 * RIG_SCALE, 1.2, 1.8);
  key.position.set(-0.85, 1.35, 0.95);
  key.lookAt(TARGET);

  const fill = new RectAreaLight(FILL_COLOR, 2.2 * RIG_SCALE, 2.5, 2.5);
  fill.position.set(1.6, 0.9, 0.6);
  fill.lookAt(TARGET);

  const rim = new RectAreaLight(RIM_COLOR, 22.0 * RIG_SCALE, 0.25, 1.6);
  rim.position.set(1.15, 0.55, -1.25);
  rim.lookAt(TARGET);

  const shadow = new DirectionalLight(KEY_COLOR, 1.6 * RIG_SCALE);
  shadow.position.copy(key.position);
  shadow.target.position.copy(TARGET);
  shadow.castShadow = true;
  shadow.shadow.mapSize.set(2048, 2048);
  // VSM is the only three.js shadow type whose penumbra widens with occluder
  // distance, which is bible §9 item 5. PCF-soft gives a constant blur radius
  // and fails that check no matter how it is tuned.
  shadow.shadow.radius = 8;
  shadow.shadow.blurSamples = 16;
  shadow.shadow.bias = -0.0002;
  shadow.shadow.normalBias = 0.02;
  const cam = shadow.shadow.camera;
  cam.left = -0.45;
  cam.right = 0.45;
  cam.top = 0.45;
  cam.bottom = -0.45;
  cam.near = 0.6;
  cam.far = 3.0;
  cam.updateProjectionMatrix();

  group.add(key, fill, rim, shadow, shadow.target);

  const keyBase = new Color(KEY_COLOR);
  const refWhite = kelvinRGB(5200, new Color());
  const shifted = new Color();
  const scratch = new Color();

  return {
    group,
    key,
    fill,
    rim,
    shadow,
    setKeyTemperature(kelvinDelta: number) {
      kelvinRGB(5200 + kelvinDelta, shifted);
      scratch.setRGB(
        (shifted.r / Math.max(1e-4, refWhite.r)) * keyBase.r,
        (shifted.g / Math.max(1e-4, refWhite.g)) * keyBase.g,
        (shifted.b / Math.max(1e-4, refWhite.b)) * keyBase.b,
        'srgb-linear',
      );
      key.color.copy(scratch);
      shadow.color.copy(scratch);
    },
    dispose() {
      key.dispose();
      fill.dispose();
      rim.dispose();
      shadow.dispose();
    },
  };
}

/* ------------------------------------------------------------------ *
 * Backdrop (bible §1.1)
 * ------------------------------------------------------------------ */

export interface Backdrop {
  mesh: Mesh;
  /** House grade from the outcome sequence: desaturate + darken the void. */
  setGrade(desaturation: number, darken: number): void;
  dispose(): void;
}

const BACKDROP_RADIUS = 8;

/**
 * Invert AgX so a display-referred colour can be authored directly.
 *
 * The dark-end palette hexes are *screen targets*, not shader inputs: authored
 * literally, `#101114` renders at (9,10,14) because AgX's toe crushes exactly
 * the range the void lives in. This solves the tone curve backwards — given the
 * linear value the frame should end up with, it returns the linear value the
 * shader has to emit for AgX at `exposure` to produce it.
 *
 * Three's AgX is `pow(contrast(normalise(log2(x))), 2.2)` around a pair of
 * colour matrices. The matrices are near-identity for the neutral, very dark
 * colours this is used on, so they are skipped and the contrast polynomial —
 * monotonic on [0,1] — is inverted by bisection. Twenty-eight iterations puts
 * the answer well inside a code value.
 */
function inverseAgX(displayLinear: number, exposure: number): number {
  const MIN_EV = -12.47393;
  const MAX_EV = 4.026069;
  // three's agxDefaultContrastApprox.
  const contrast = (t: number) =>
    ((((15.5 * t - 40.14) * t + 31.96) * t - 6.868) * t + 0.4298) * t * t + 0.1191 * t - 0.00232;

  const y = Math.pow(Math.max(displayLinear, 1e-8), 1 / 2.2);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2;
    if (contrast(mid) < y) lo = mid;
    else hi = mid;
  }
  const t = (lo + hi) / 2;
  return Math.pow(2, t * (MAX_EV - MIN_EV) + MIN_EV) / exposure;
}

/** A palette hex, pre-compensated so the *rendered* frame lands on that hex. */
function screenReferred(hex: number): Color {
  const c = new Color(hex);
  return c.setRGB(
    inverseAgX(c.r, TONE_EXPOSURE),
    inverseAgX(c.g, TONE_EXPOSURE),
    inverseAgX(c.b, TONE_EXPOSURE),
    'srgb-linear',
  );
}

const BACKDROP_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 world = modelMatrix * vec4( position, 1.0 );
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const BACKDROP_FRAG = /* glsl */ `
precision highp float;

uniform vec3  uLow;
uniform vec3  uHigh;
uniform vec3  uPool;
uniform vec3  uPoolCentre;
uniform float uPoolRadius;
uniform float uDesaturate;
uniform float uDarken;
uniform sampler2D uNoise;
uniform float uNoiseSize;

varying vec3 vWorld;

void main() {
  vec3 dir = normalize( vWorld );

  // Elevation ramp, spanning the band this lens can actually see. A 22 degree
  // lens looking 8.8 degrees down sees roughly -1 to +6 degrees of elevation on
  // an 8 m backdrop, so the bible's literal "horizon to 60 degrees" ramp is a
  // no-op: every pixel in frame lands on void-low and the gradient does not
  // exist. Running void-low to void-high across the visible band instead puts
  // the specified two-value spread where the viewer is looking, which is what
  // the spec is for.
  float elevation = asin( clamp( dir.y, -1.0, 1.0 ) );
  float t = smoothstep( -0.0349, 0.1222, elevation );
  vec3 colour = mix( uLow, uHigh, t );

  // Warm pool. Measured as a distance across the backdrop surface rather than
  // an angle, so it stays a fixed physical size as the camera parallaxes and
  // never slides against the board it is meant to separate.
  // §1.1's warm pool, at the revised 16 % peak. At 10 % of a correctly dark
  // backdrop it landed under one code value once AgX had it.
  float d = distance( vWorld, uPoolCentre ) / uPoolRadius;
  colour += uPool * ( 1.0 - smoothstep( 0.0, 1.0, d ) ) * 0.16;

  float luma = dot( colour, vec3( 0.2126, 0.7152, 0.0722 ) );
  colour = mix( colour, vec3( luma ), uDesaturate ) * uDarken;

  // Dither. The whole point of the backdrop is a two-stop gradient across most
  // of the frame, which is precisely the case 8-bit output bands on. One
  // output LSB is not a constant in this buffer — everything downstream applies
  // a transfer curve — so differentiate the sRGB curve at the local level and
  // scale the mask by that. A flat 1/255 here would be roughly ten times too
  // coarse in the shadows, which is where this gradient actually lives.
  vec3 lsb = ( 1.0 / 255.0 ) * 2.2749 * pow( max( colour, vec3( 1e-5 ) ), vec3( 0.5833 ) );
  float mask = texture2D( uNoise, gl_FragCoord.xy / uNoiseSize ).r - 0.5;
  colour += lsb * mask;

  gl_FragColor = vec4( colour, 1.0 );
}
`;

export function createBackdrop(blueNoise: Texture): Backdrop {
  // The pool sits on the sphere directly behind the board, lifted to the
  // board's own height so the silhouette separates where it matters.
  const poolCentre = new Vector3(0, 0.4, -BACKDROP_RADIUS)
    .normalize()
    .multiplyScalar(BACKDROP_RADIUS);

  const material = new ShaderMaterial({
    uniforms: {
      uLow: { value: screenReferred(PALETTE.voidLow) },
      uHigh: { value: screenReferred(PALETTE.voidHigh) },
      uPool: { value: screenReferred(PALETTE.pool) },
      uPoolCentre: { value: poolCentre },
      uPoolRadius: { value: 1.6 },
      uDesaturate: { value: 0 },
      uDarken: { value: 1 },
      uNoise: { value: blueNoise },
      uNoiseSize: { value: blueNoise.image ? (blueNoise.image as { width: number }).width : 64 },
    },
    vertexShader: BACKDROP_VERT,
    fragmentShader: BACKDROP_FRAG,
    side: BackSide,
    depthWrite: false,
    // The sphere is 8 m across and the camera never leaves the middle of it, so
    // it is always the far plane of the frame; drawing it first and unwritten
    // saves the depth traffic and guarantees §9 item 18's "fills the frame".
    fog: false,
  });

  const mesh = new Mesh(new SphereGeometry(BACKDROP_RADIUS, 48, 24), material);
  mesh.name = 'backdrop';
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();

  return {
    mesh,
    setGrade(desaturation: number, darken: number) {
      material.uniforms.uDesaturate.value = desaturation;
      material.uniforms.uDarken.value = darken;
    },
    dispose() {
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}

/* ------------------------------------------------------------------ *
 * Contact shadow (bible §2.2)
 * ------------------------------------------------------------------ */

/**
 * The soft pool under the plinth. A shadow map alone leaves a bright hairline
 * where object meets table — the classic "floating object" tell — because the
 * penumbra of a 1.2 × 1.8 m softbox is wider than the gap it needs to darken.
 * This decal fills that gap and nothing else.
 */
export function createContactShadow(): Mesh {
  const size = 512;
  const data = new Uint8Array(size * size * 4);
  // The decal is the plinth footprint at 1.15x, so the plinth's own edge sits
  // at 1/1.15 of the half-extent and the penumbra has the remaining margin to
  // fade across.
  const edge = 0.5 / 1.15;
  const margin = 0.5 - edge;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = Math.abs((x + 0.5) / size - 0.5);
      const v = Math.abs((y + 0.5) / size - 0.5);
      // Signed distance to the *rectangle*, not a radial gradient. The plinth
      // is 420 x 140 — a 3:1 footprint — and a radial falloff on that inscribes
      // an ellipse: it reaches zero long before the ends of the plinth, so the
      // shadow disappears exactly where the object still touches the table.
      // That is why the set read as floating.
      const qx = u - edge;
      const qy = v - edge;
      const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
      const inside = Math.min(Math.max(qx, qy), 0);
      const d = clamp01((outside + inside) / margin);
      // Gamma 1.6 on the falloff keeps the shoulder long and the core solid.
      const occ = Math.pow(1 - d, 1.6);
      const shade = Math.round((1 - 0.5 * occ) * 255);
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = shade;
      data[i + 3] = 255;
    }
  }
  const tex = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;

  const mesh = new Mesh(
    new PlaneGeometry(PLINTH_WIDTH * 1.15, PLINTH_DEPTH * 1.15),
    new MeshBasicMaterial({
      map: tex,
      // Multiply, not alpha: the decal must darken whatever the tabletop
      // material is currently reflecting rather than paint grey over it. The
      // 0.5 opacity from the bible is baked into the texture's floor, because
      // three's MultiplyBlending ignores `opacity`.
      blending: MultiplyBlending,
      transparent: true,
      // three's MultiplyBlending sets src = ZERO, dst = SRC_COLOR, which is only
      // a correct multiply if the source is already premultiplied; without this
      // flag the renderer warns and the decal's alpha is applied twice.
      premultipliedAlpha: true,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  mesh.name = 'contact-shadow';
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.0004;
  mesh.renderOrder = 1;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}
