/**
 * The studio: image-based lighting, the analytic rig, the backdrop, and the
 * contact shadow that glues the set to the table. Bible §1.1, §2.
 *
 * The single most important thing in this file is that every light is a
 * *rectangle*. A procedural gradient or an equirect sky gives every glossy
 * surface a round, featureless highlight, which is the giveaway that an image
 * was rendered rather than photographed.
 *
 * The rectangles live in two places, and the split is load-bearing. Four
 * emissive cards in a black box, baked through PMREM, give the whole set its
 * ambient shape. But a cubemap is indexed by direction alone, so it cannot put
 * a *different* highlight on two surfaces that happen to be parallel — which is
 * every one of the 42 disc faces. The near-field kicker at the bottom of this
 * file exists for exactly that: bible §9 item 1, and see `CATCHLIGHT` for why
 * nothing already in §2.1 could reach the lacquer.
 */

import {
  BackSide,
  BoxGeometry,
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  DirectionalLight,
  DoubleSide,
  Group,
  LinearFilter,
  Matrix3,
  Matrix4,
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

import { buildTexture, clamp01, mulberry32, smoothstep } from './procedural';
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

/**
 * The rim aims at the board's upper half, not at the table plane.
 *
 * Art-director ruling: at the old (1.15, 0.55, -1.25) the rim lit faces this
 * camera never sees and dumped its radiance across the tabletop's right third
 * — measured contribution across table thirds was 0 / 1 / 9. The camera freeze
 * applied to the *view*; it never applied to the lights, so the rig was free to
 * be re-staged and this is that re-staging.
 */
const RIM_POSITION = new Vector3(0.45, 1.05, -1.4);
const RIM_AIM = new Vector3(0, 0.3, 0);

/**
 * The whole rim system — §2.1's light and §2.3's card together — scaled to
 * almost nothing, because at the ruled position it is the *only* thing standing
 * between this frame and both of Ruling 1's acceptance numbers. This is the
 * second pass the ruling's "held at 22.0 on the first pass" left open, and it
 * needs an art-director decision, so here is the whole measurement.
 *
 * **The move makes the tabletop dramatically worse, not better.** Empty scene,
 * rest pose, 1440x900 at DPR 1, the ruling's pinned locus:
 *
 * | rim card | rim light | table left | table right | ratio |
 * |---|---|---|---|---|
 * | 32 | 22 (old position)  | 39.8 | 47.2 | 0.886 |
 * | 32 | 22 (ruled position)| 50.8 | 172.0 | 0.088 |
 * | 0  | 22 (ruled position)| 39.3 | 155.2 | 0.074 |
 * | 24 | 1  (ruled position)| 45.3 | 118.0 | 0.170 |
 *
 * Solving those for a linear model in scene-linear gives, on the right strip,
 * 0.0155 + 0.00406 x card + 0.012 x light, and on the left, 0.0202 + 0.000238 x
 * card + 0.0001 x light. Every unit of rim lands on the right and none of it on
 * the left, so the ratio is monotonically decreasing in rim: with the rim
 * system off entirely the frame is already at 1.30, and any rim at all pushes it
 * back under. There is no setting that is both a rim light and a pass.
 *
 * The mechanism is geometric, not a tuning slip. This camera sees the slab at
 * about 74 degrees off its normal, so the tabletop is a near-mirror with a
 * Fresnel of roughly 0.23, and its mirror direction leaves the right-hand table
 * at 15.7 degrees of elevation. At (1.15, 0.55, -1.25) the strip sat 21.8
 * degrees off that azimuth against its own azimuthal half-width of 5 degrees,
 * so it missed. At (0.45, 1.05, -1.40) it sits 7.5 degrees off — a direct hit —
 * and the strip's lower end lands at 13.9 degrees of elevation, straddling the
 * mirror direction exactly. A 6.16-radiance strip reflected at 23 % Fresnel is
 * the 218-code streak the table came back with.
 *
 * What the scale costs is real: §2.1's canonical key : fill : rim of
 * 1 : 0.24 : 2.4 does not survive it. What it does *not* cost is the object.
 * Measured, moving the rim changed the right stile by +2.4 and the top rail by
 * -0.2 code values, because from behind the board at this height the rim lights
 * almost nothing the camera can see; and §9 item 3's chamfer line down the
 * right rail's outer edge is lit by the *fill*, not the rim — that arris has
 * normal (0.707, 0, 0.707) and the rim is behind it, with a negative dot
 * product at the old position and the new one alike. Measured, the chamfer line
 * is longer and brighter after this change than before it.
 *
 * The two ways out, both needing sign-off: revisit the pinned position, or
 * shorten §2.1's 1.6 m strip. At 0.4 m tall its lower end would clear the
 * table's mirror elevation by 15 degrees and the rim could carry its specified
 * intensity again.
 */
const RIM_SYSTEM_SCALE = 0.002;

/** §2.1's 22.0, scaled. */
const RIM_INTENSITY = 22.0 * RIM_SYSTEM_SCALE;

/** §2.3's card at the ruling's approved 32, scaled by the same factor so the
 *  card still mirrors the light it stands in for. */
const RIM_CARD_INTENSITY = 32 * RIM_SYSTEM_SCALE;

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
function emissiveCard(
  w: number,
  h: number,
  hex: number,
  intensity: number,
  at: Vector3,
  aim: Vector3 = TARGET,
): Mesh {
  const material = new MeshBasicMaterial({ side: DoubleSide, toneMapped: false });
  // MeshBasicMaterial has no "emissive"; a Color above 1.0 is the same thing
  // once it lands in PMREM's half-float target, and keeps the whole capture in
  // one unlit pass. Values are authored in sRGB then scaled in linear.
  material.color.setHex(hex).multiplyScalar(intensity);
  const mesh = new Mesh(new PlaneGeometry(w, h), material);
  mesh.position.copy(at);
  mesh.lookAt(aim);
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
  // its left, inverting the whole key/fill relationship. Cards mirror the rig, so
  // it travels with the analytic rim to (0.45, 1.05, -1.40) aimed at the board's
  // upper half.
  scene.add(emissiveCard(0.3, 1.8, RIM_COLOR, RIM_CARD_INTENSITY, RIM_POSITION, RIM_AIM));

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
  const horizon = emissiveCard(3.0, 1.6, HORIZON_COLOR, 2.8, new Vector3(0, 0.15, 1.9));
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

  const rim = new RectAreaLight(RIM_COLOR, RIM_INTENSITY * RIG_SCALE, 0.25, 1.6);
  rim.position.copy(RIM_POSITION);
  rim.lookAt(RIM_AIM);

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
 * Catchlight: the near-field kicker (bible §2.3, §9 item 1)
 * ------------------------------------------------------------------ */

/**
 * The fixture the discs were missing, and why none of the existing ones worked.
 *
 * A disc face is flat with its normal on +Z, so it mirrors the half-space *in
 * front of* the board: the mirror ray from a disc leaves at about
 * (-0.10, -0.15, +0.98), forward and slightly down-left, out past the camera.
 * Every analytic light in §2.1 is behind that horizon — the key sits 49 degrees
 * off the mirror direction and its nearest edge is still 24 degrees off, which
 * with a clearcoat roughness of 0.12 is nothing at all. So no rectangle in the
 * rig reaches the lacquer, and measurement agrees: the only thing in the mirror
 * path was §2.3's horizon card.
 *
 * That card is also why the glint was *cloned*. It reaches the discs through
 * `scene.environment`, and a PMREM cubemap is indexed by direction alone: 42
 * coplanar disc faces look up the same texel and get pixel-identical
 * highlights. Position-dependent reflections cannot come out of an environment
 * map at all, however bright it is made — which is exactly what "the same
 * bottom crescent on every one of the 42 discs" is a picture of.
 *
 * So this is a *near-field* rectangle: a kicker, evaluated per fragment against
 * its real position and extent rather than sampled from a cube. Because the
 * mirror ray starts at the shading point, where it lands on a disc depends on
 * which disc it is — the reflection walks across the board instead of being
 * stamped on every cell.
 *
 * It is deliberately *not* baked into the PMREM scene. A card in the cubemap
 * would restore the far-field lookup this exists to replace and double-count
 * the same fixture; and it is specular-only for the same reason a photographer
 * flags an eye light off the set — its job is to be seen in the lacquer, not to
 * model form, and letting it wash the diffuse would move every exposure the art
 * director has already signed off.
 *
 * **Why it is aimed off the disc face, and not at it.** The obvious placement
 * is the one that fills the disc faces: reflecting the cell centres about +Z
 * onto z = 1.0 m maps all 42 of them into a 0.568 x 0.484 m footprint, and a
 * softbox exactly there puts a rectangle on every disc. Rendered and measured,
 * that fails — and the number that kills it is §9 item 14, not item 1. A disc
 * face is flat, so a near-field source either covers the whole face or none of
 * it; there is no in-between at this scale, because the mirror ray varies by
 * under 2 degrees across a 42 mm disc at 1.24 m. So a bright softbox in that
 * position is a *uniform white wash*, and measured against the disc pair, an
 * added 0.01 scene-linear of white already drops the ember/petrol greyscale
 * separation from 14.4 L* to 12.8, and 0.02 takes it to 11.5 — under the
 * bible's floor of 12. Anything bright enough to peak at 230 code values across
 * a whole face erases the two disc colours completely; measured at intensity
 * 13, the discs came back at a mean of 179 with a 0.5 L* separation.
 *
 * A highlight that peaks past 230 without moving the disc's mean therefore has
 * to be a *small* specular core, which means it has to live on curvature: the
 * disc's 1.5 mm rim fillet, the lathed grooves, and the aperture chamfers of
 * the front sheet. Those sweep their normals through tens of degrees, so they
 * mirror a source that the flat face cannot see at all — which is exactly the
 * placement below: 54 degrees off the face's mirror direction, up and camera
 * left, with its nearest edge still 29 degrees clear of the faces. The flat
 * faces stay the colour they were authored; the rims catch a bar of light whose
 * position around each disc is set by the direction from *that* disc to the
 * kicker, and therefore differs from cell to cell.
 */
export const CATCHLIGHT = {
  // Close, so the direction to it swings hard across a 0.37 m board: at 0.86 m
  // the sweep is what makes the bar sit at a different place on every disc.
  centre: new Vector3(-0.4, 0.72, 0.55),
  /**
   * Half-width along +X and half-height along +Y, metres.
   *
   * Deliberately large in angle — 25 x 33 degrees from the board — because the
   * rim fillet compresses the whole studio into 1.5 mm of surface: a source
   * subtending 13 degrees lights a band of it 0.3 px wide, which antialiasing
   * then throws away. Widening the source widens the band rather than
   * brightening a sliver, and the nearest edge is still 29 degrees clear of the
   * disc faces' mirror direction, which is what keeps the faces their own
   * colour.
   */
  halfWidth: 0.4,
  halfHeight: 0.55,
  colour: KEY_COLOR,
  /**
   * Radiance, in the same scene-referred units as the analytic rig.
   *
   * High, and it has to be: the core it makes lands at near-normal incidence on
   * a dielectric, so only about 8 % of it comes back (clearcoat 0.04 plus the
   * body's 0.04), and 230 code values is 2.24 scene-linear. That is the whole
   * reason a kicker is a small hard source rather than another softbox — it
   * buys highlight brightness without buying irradiance.
   */
  intensity: 350.0,
} as const;

export interface Catchlight {
  /** Shared uniform block; every hero material is wired to this same object. */
  readonly uniforms: {
    uCatchCentre: { value: Vector3 };
    uCatchU: { value: Vector3 };
    uCatchV: { value: Vector3 };
    uCatchRadiance: { value: Color };
  };
  /** Re-express the rectangle in view space. Call once per frame, pre-render. */
  update(viewMatrix: Matrix4): void;
}

export function createCatchlight(): Catchlight {
  const centre = new Vector3();
  const u = new Vector3();
  const v = new Vector3();
  const radiance = new Color(CATCHLIGHT.colour).multiplyScalar(CATCHLIGHT.intensity);

  const worldCentre = CATCHLIGHT.centre.clone();
  const worldU = new Vector3(CATCHLIGHT.halfWidth, 0, 0);
  const worldV = new Vector3(0, CATCHLIGHT.halfHeight, 0);
  const rotation = new Matrix3();

  return {
    uniforms: {
      uCatchCentre: { value: centre },
      uCatchU: { value: u },
      uCatchV: { value: v },
      uCatchRadiance: { value: radiance },
    },
    update(viewMatrix: Matrix4) {
      // The shading point, its normal and the view vector all arrive in view
      // space, so the rectangle has to meet them there. The half-axes are
      // directions, not points: they take the view matrix's rotation block and
      // must not pick up its translation.
      centre.copy(worldCentre).applyMatrix4(viewMatrix);
      rotation.setFromMatrix4(viewMatrix);
      u.copy(worldU).applyMatrix3(rotation);
      v.copy(worldV).applyMatrix3(rotation);
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
 * Tabletop sheen smear (bible §3.3, as revised)
 * ------------------------------------------------------------------ */

/**
 * Where the smear lives, in metres of tabletop. `z0` is the plinth's front
 * face; `depth` is the ruling's 0.18 m fade distance from plinth contact.
 */
export const SHEEN_REGION = {
  halfWidth: 0.26,
  z0: PLINTH_DEPTH / 2,
  depth: 0.18,
} as const;

/**
 * Peak additive radiance at the plinth contact line, scene-referred.
 *
 * The plinth renders at about 56 code values, which is 3.0e-2 scene-linear;
 * the ruling asks for 20-30 % of object luminance, so the band is authored at
 * a quarter of that. The board's dark mass is the other half of the effect and
 * is a multiply, because a dark object in a reflection is the *absence* of the
 * sheen the open table is showing, not a dark paint over it.
 */
export const SHEEN_GAIN = 1.2e-2;

/**
 * The slab's reflection of the object, painted rather than rendered.
 *
 * §3.3's `Reflector` line is struck: a half-resolution mirror of this set costs
 * ~190k triangles, and the triangle budget is a performance contract rather
 * than a target. What survives is the part of a reflection that is actually
 * legible at clearcoatRoughness 0.35 — a vertically smeared band of the
 * object's static masses — and honed stone would destroy anything finer than
 * that, which is the physical alibi for painting it.
 *
 * Two channels, because a reflection is two things at once. RGB is what the
 * plinth's lit edge and the top rail *add* to the slab; alpha is how much of
 * the slab's own environment sheen the board's dark mass *takes away*. A pure
 * multiply could not brighten and a pure add could not darken, and the smear
 * needs both to read as a reflection instead of a decal.
 *
 * No disc colours and nothing dynamic: at this roughness the disc array is
 * below the resolving power of the surface, and a smear that changed as the
 * board filled would be the tell that it is painted.
 */
export function createTabletopSheen(size = 256): DataTexture {
  // "Vertical stretch ~1.6:1": features are feathered 1.6x further along the
  // depth axis (toward camera) than across it, which is what a grazing view of
  // a slightly rough surface does to a reflection.
  const STRETCH = 1.6;
  const lateralFeather = 0.09;

  const band = (v: number, centre: number, sigma: number) =>
    Math.exp(-((v - centre) * (v - centre)) / (2 * sigma * sigma));

  const tex = buildTexture({ size }, (u, v, out) => {
    // Lateral falloff: the plinth is wider than the board, so its band reaches
    // further out than the mass above it. Feathered, so this reads as sheen
    // rather than as a decal with an edge.
    const x = Math.abs(u - 0.5) * 2 * SHEEN_REGION.halfWidth;
    const plinthLat = 1 - smoothstep(0.21 - lateralFeather * 0.5, 0.21 + lateralFeather * 0.5, x);
    const boardLat = 1 - smoothstep(0.183 - lateralFeather * 0.5, 0.183 + lateralFeather * 0.5, x);

    // Everything is gone by the far edge of the 0.18 m band, by construction.
    const reach = 1 - smoothstep(0.62, 1.0, v);

    // The plinth's lit front edge is the brightest real reflector in the set,
    // and it sits right at the contact line.
    const contact = band(v, 0.035, 0.055 * STRETCH) * plinthLat;
    // A faint echo of the top rail, the only other bright horizontal in the
    // object's silhouette.
    const rail = band(v, 0.66, 0.075 * STRETCH) * boardLat * 0.22;
    // The board between them: a dark mass that occludes the slab's own sheen.
    const mass =
      smoothstep(0.02, 0.12, v) * (1 - smoothstep(0.34, 0.60, v)) * boardLat;

    const warm = (contact + rail) * reach;
    // Warm anodised aluminium under a #FFF1E3 key, in linear.
    out[0] = warm;
    out[1] = warm * 0.86;
    out[2] = warm * 0.70;
    out[3] = 1 - 0.15 * mass * reach;
  });
  // The smear is a one-off patch of table, not a tile: repeating it would put a
  // second reflection of the object at the far edge of the slab.
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
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
