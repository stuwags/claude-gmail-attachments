/**
 * The `BoardView` implementation: renderer configuration, scene assembly, the
 * frame loop, and the seams to post-processing and the effect systems.
 *
 * Three structural decisions are worth stating up front.
 *
 * All 42 discs are a single `InstancedMesh`. The win sequence needs per-disc
 * emissive, desaturation, darkening and a roughness bias, which would normally
 * force 42 materials and 42 draw calls; instead four floats per instance are
 * injected into the standard physical shader (see materials.ts). The board is
 * one draw call whatever is happening on it.
 *
 * Post-processing and the effect systems are optional at runtime. The bible is
 * explicit that the lighting rig must be signed off before post exists, so
 * "no post" is a supported, finished mode rather than a broken one — the scene
 * tone-maps and renders straight to the canvas when no chain is present, and
 * degrades to a restrained built-in outcome sequence when `effects/outcome.ts`
 * is not there yet.
 *
 * The frame loop is driven entirely by `render(dtMs)`. Nothing here owns a
 * `requestAnimationFrame`; `waitFrames` and `settle` count real rendered frames
 * so the screenshot harness can step animations deterministically.
 */

import {
  AgXToneMapping,
  Color,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  Plane,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  VSMShadowMap,
  WebGLRenderer,
  type Texture,
} from 'three';

import { cellIndex, COLS, Player, ROWS, type Cell, type Coord, type ThreatReport } from '../engine/types';
import { DropTrack } from '../physics/drop';
import type { BoardView, QualityTier, RendererOptions, RenderStats } from './api';
import { CameraRig, EASE } from './camera';
import {
  buildEnvironmentMap,
  createBackdrop,
  createBlueNoiseTexture,
  createCatchlight,
  createContactShadow,
  createLightRig,
  PALETTE,
  RIG_SCALE,
  TONE_EXPOSURE,
  type Backdrop,
  type Catchlight,
  type LightRig,
} from './environment';
import type {
  CoachMode,
  CoachOverlay,
  DiscTreatment,
  EffectContext,
  HouseTreatment,
  OutcomeEffects,
} from './effects/types';
import {
  createDiscGeometry,
  createFeedMouthGeometry,
  createFrameGeometry,
  createGhostDiscGeometry,
  createPanelGeometry,
  createPlinthGeometry,
  createRimStrokeGeometry,
  createTableGeometry,
  FEED_GHOST_Y,
  PANEL_BACK_Z,
  PANEL_FRONT_FACE_Z,
  PANEL_FRONT_Z,
} from './geometry';
import {
  BOARD_BOTTOM_Y,
  BOARD_TOP_Y,
  CELL_PITCH,
  columnFromX,
  columnX,
  isOverGrid,
  RELEASE_Y,
  rowY,
} from './layout';
import {
  createGhostMaterial,
  createMaterials,
  DISC_TREATMENT_ATTRIBUTE,
  EMBER,
  PETROL,
  type GhostMaterial,
  type MaterialLibrary,
} from './materials';
import type { PostFX, PostState } from './post/types';
import { createPostFX } from './post/chain';
import { createCoachOverlay } from './effects/coach';
import { createOutcomeEffects } from './effects/outcome';

/* ------------------------------------------------------------------ *
 * Public surface beyond BoardView
 * ------------------------------------------------------------------ */

/** One disc contact, delivered a frame ahead so audio can be scheduled on it. */
export interface DiscImpact {
  col: number;
  row: number;
  player: Player;
  /** 0 is the landing, then 1, 2, … for successive bounces. */
  index: number;
  /** Closing speed at contact, m/s. Drives impact loudness. */
  speed: number;
  /**
   * Seconds from the moment this fires until the physics contact. Always ≥ 0
   * and under one frame; schedule the transient at `ctx.currentTime + lead` and
   * it lands on the exact contact frame rather than one frame late.
   */
  lead: number;
}

export interface SceneBoardView extends BoardView {
  /**
   * Subscribe to disc contacts. Returns an unsubscribe function.
   *
   * This is the seam the audio pass wants: `view.onImpact(i =>
   * audio.discImpact(i.speed, row))` schedules the transient on the exact
   * physics-contact frame, because `lead` says how far ahead of the contact the
   * callback fired.
   */
  onImpact(listener: (impact: DiscImpact) => void): () => void;

  /**
   * Coach verbosity (bible §7.3). `setTeachingOverlay` cannot carry it —
   * `BoardView` only has "report or null" — so the chip's Off / Hints / Full
   * state comes through here.
   */
  setCoachMode(mode: CoachMode): void;

  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
}

export function createBoardView(options: RendererOptions): SceneBoardView {
  return new BoardScene(options);
}

/* ------------------------------------------------------------------ *
 * Optional modules
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Fallback outcome sequence
 * ------------------------------------------------------------------ */

const NEUTRAL_HOUSE: HouseTreatment = {
  desaturation: 0,
  darken: 1,
  keyTemperatureShift: 0,
  vignetteBias: 0,
};

/**
 * A deliberately small stand-in for `effects/outcome.ts`: the house dims, the
 * winning discs ignite in cascade, the camera dollies in. No filament, no
 * motes, no gold — those belong to the real sequence, and inventing a cheaper
 * version of them would be worse than not having them.
 *
 * Implementing the full `OutcomeEffects` interface rather than special-casing
 * "no module" keeps exactly one code path through the frame loop.
 */
class FallbackOutcome implements OutcomeEffects {
  private t = 0;
  private mode: 'idle' | 'win' | 'draw' = 'idle';
  private line: Coord[] = [];
  private cooler = false;

  playWin(line: readonly Coord[], _winner: Player, humanLost: boolean): void {
    this.mode = 'win';
    this.t = 0;
    this.line = [...line];
    this.cooler = humanLost;
  }

  playDraw(): void {
    this.mode = 'draw';
    this.t = 0;
    this.line = [];
  }

  clear(): void {
    this.mode = 'idle';
    this.t = 0;
    this.line = [];
  }

  update(dt: number): void {
    if (this.mode !== 'idle') this.t += dt;
  }

  treatmentFor(col: number, row: number): DiscTreatment | null {
    if (this.mode !== 'win') return null;
    const index = this.line.findIndex((c) => c.col === col && c.row === row);
    if (index < 0) return null;
    // 250 ms hold, then a 90 ms stagger along the line, 350 ms to full.
    const local = this.t - 0.25 - index * 0.09;
    const ramp = clamp01(local / 0.35);
    // Breathe 0.85–1.0 at a 1.8 s period once lit, as the real sequence does.
    const breath = ramp >= 1 ? 0.925 + 0.075 * Math.sin((this.t / 1.8) * Math.PI * 2) : 1;
    // ×2.2 here, matching `effects/outcome.ts`: `ignition` is a multiplier on
    // body colour, and the sequence owns §6.1's factor so the scene applies it
    // exactly once.
    return { ignition: ramp * breath * 2.2, desaturation: 0, darken: 1, roughnessBias: 0 };
  }

  house(): HouseTreatment {
    if (this.mode === 'idle') return NEUTRAL_HOUSE;
    if (this.mode === 'draw') {
      const p = clamp01(this.t / 0.6);
      return { desaturation: 0.2 * p, darken: 1, keyTemperatureShift: 0, vignetteBias: 0 };
    }
    const p = EASE.gallery(clamp01((this.t - 0.12) / 0.4));
    return {
      desaturation: 0.15 * p,
      darken: 1 - 0.18 * p,
      keyTemperatureShift: this.cooler ? -300 * p : 0,
      vignetteBias: this.cooler ? 0.06 * p : 0,
    };
  }

  cameraRequest(): { dollyScale: number; orbitDegrees: number; durationMs: number } | null {
    if (this.mode === 'win' && this.t >= 0.7) {
      return { dollyScale: 0.93, orbitDegrees: 0, durationMs: 1200 };
    }
    if (this.mode === 'draw') return { dollyScale: 1.04, orbitDegrees: 0, durationMs: 900 };
    return null;
  }

  focusRequest(): { worldFocusRange: number; bokehScale: number } | null {
    return this.mode === 'win' && this.t >= 0.7
      ? { worldFocusRange: 0.12, bokehScale: 3.2 }
      : null;
  }

  get active(): boolean {
    // The win holds forever once choreographed; "active" means still animating.
    return this.mode !== 'idle' && this.t < 2.5;
  }

  dispose(): void {
    this.clear();
  }
}

/* ------------------------------------------------------------------ *
 * Drops
 * ------------------------------------------------------------------ */

interface ActiveDrop {
  col: number;
  row: number;
  player: Player;
  track: DropTrack;
  t: number;
  nextImpact: number;
  resolve: (() => void) | null;
}

/* ------------------------------------------------------------------ *
 * The view
 * ------------------------------------------------------------------ */

const DEFAULT_TREATMENT: DiscTreatment = {
  ignition: 0,
  desaturation: 0,
  darken: 1,
  roughnessBias: 0,
};

class BoardScene implements SceneBoardView {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;

  private readonly rig: CameraRig;
  private readonly reducedMotion: boolean;
  private quality: QualityTier;
  private readonly qualityLocked: boolean;

  private materials!: MaterialLibrary;
  private ghostMat!: GhostMaterial;
  private lights!: LightRig;
  /**
   * The near-field front softbox (environment.ts). It has no scene node — it is
   * a rectangle the hero shaders intersect — so the frame loop is what keeps it
   * in view space.
   */
  private readonly catchlight: Catchlight = createCatchlight();
  private backdrop!: Backdrop;
  private envMap: Texture | null = null;
  private blueNoise = createBlueNoiseTexture();

  private readonly boardRoot = new Group();
  private discMesh!: InstancedMesh;
  private treat!: InstancedBufferAttribute;
  private rimStrokes!: InstancedMesh;
  private ghost!: Mesh;
  private table!: Mesh;
  private panels: Mesh[] = [];
  private disposables: { dispose(): void }[] = [];

  /** Cell -> instance slot, and back. Discs are packed so `count` is truthful. */
  private readonly cellSlot = new Int16Array(COLS * ROWS).fill(-1);
  private readonly slotCell = new Int16Array(COLS * ROWS).fill(-1);
  private discCount = 0;
  private treatDirty = true;
  /** Empty stand-ins the effect systems address discs through. */
  private readonly discProxies: Object3D[] = [];

  private readonly drops: ActiveDrop[] = [];
  private readonly impactListeners = new Set<(i: DiscImpact) => void>();

  private post: PostFX | null = null;
  private coach: CoachOverlay | null = null;
  private outcome: OutcomeEffects = new FallbackOutcome();
  private lastCameraRequest = '';

  /* hover / thinking */
  private hoverCol: number | null = null;
  private hoverRow: number | null = null;
  private hoverPlayer: Player = Player.One;
  private hoverAlpha = 0;
  private hoverPhase = 0;
  private ghostX = 0;
  private ghostSlide: { from: number; to: number; t: number } | null = null;
  private thinking = false;
  private thinkingPhase = 0;
  private thinkingFade = 0;
  private lastMover: Player = Player.Two;
  private reject: { col: number; t: number } | null = null;

  /* bookkeeping */
  private frameIndex = 0;
  private elapsed = 0;
  private fps = 60;
  private frameMs = 16.7;
  private drawCalls = 0;
  private triangles = 0;
  private probeFrames = 0;
  private probeTotal = 0;
  private readonly frameWaiters: { at: number; resolve: () => void }[] = [];
  private readonly settleWaiters: { deadline: number; resolve: () => void }[] = [];
  private disposed = false;
  private viewer: Player = Player.One;
  /** Verbosity the coach returns to whenever a report is present. */
  private coachMode: Exclude<CoachMode, 'off'> = 'full';

  private readonly raycaster = new Raycaster();
  private readonly pickPlane = new Plane(new Vector3(0, 0, 1), 0);
  private readonly scratchV3 = new Vector3();
  private readonly scratchV2 = new Vector2();
  private readonly dummy = new Object3D();
  private readonly scratchColor = new Color();

  constructor(private readonly options: RendererOptions) {
    this.reducedMotion = options.reducedMotion ?? false;
    this.quality = options.quality ?? 'high';
    this.qualityLocked = options.quality !== undefined;

    this.renderer = new WebGLRenderer({
      canvas: options.canvas,
      // AA comes from the composer's MSAA (bible §4.1). Enabling it here as
      // well would cost a second resolve for nothing, and does not apply to
      // the render targets post actually draws into.
      antialias: false,
      powerPreference: 'high-performance',
      alpha: false,
      stencil: false,
      depth: true,
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = AgXToneMapping;
    // Bible §0's 1.15, frozen. The frame was two stops hot, but the fix belongs
    // in the rig (RIG_SCALE, environment.ts) rather than here: exposure is applied
    // after bloom, so it cannot move a diffuse surface back under the bloom
    // threshold, and it would drag the authored backdrop values with it.
    this.renderer.toneMappingExposure = TONE_EXPOSURE;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = VSMShadowMap;
    // Set per tier in `applyTransmissionScale`, not here. Bible §0 asks for 0.5,
    // but every disc in the game is seen *through* the front acrylic, so the
    // transmission buffer is not a background — it is the hero object's only
    // rasterisation. At 0.5 the clearcoat highlight, both lathed grooves and the
    // 1.5 mm rim fillet are resolved at half resolution and upscaled, which is
    // the soft halo around every disc and an outright failure of §9 items 1, 2
    // and 3. Tier B keeps 0.5, where the panels fall back to sorted alpha and
    // the trade is the whole point.
    this.applyTransmissionScale();
    this.renderer.setClearColor(PALETTE.voidLow, 1);
    // Manual reset. `autoReset` clears the counters at the top of every
    // `renderer.render()` — including the fullscreen quad each post effect
    // draws — so `info` would report the last blit (one call, one triangle)
    // rather than the frame. Resetting once per `render(dtMs)` makes the
    // numbers the whole frame: scene pass, shadow pass, transmission pass and
    // every composer blit.
    this.renderer.info.autoReset = false;

    this.rig = new CameraRig(this.reducedMotion);
    this.camera = this.rig.camera;
  }

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */

  async init(): Promise<void> {
    // The environment is baked before anything else exists so the source scene
    // can be thrown away immediately; it is only ever photographed once.
    this.envMap = buildEnvironmentMap(this.renderer);
    this.scene.environment = this.envMap;
    // Bible §2.3's 0.55, in the same scene-referred units as the analytic rig.
    this.scene.environmentIntensity = 0.55 * RIG_SCALE;

    const disc = createDiscGeometry();
    this.materials = createMaterials(
      disc.grooveBands,
      disc.profileLength,
      this.catchlight.uniforms,
    );
    this.materials.setTier(this.quality);
    this.ghostMat = createGhostMaterial(this.reducedMotion);

    /* ---- static set ---- */

    this.table = new Mesh(createTableGeometry(), this.materials.basalt);
    this.table.name = 'tabletop';
    this.table.receiveShadow = true;
    const contact = createContactShadow();
    const contactMaterial = contact.material as MeshBasicMaterial;
    this.scene.add(this.table, contact);
    this.disposables.push(this.table.geometry, contact.geometry, contactMaterial, {
      dispose: () => contactMaterial.map?.dispose(),
    });

    this.backdrop = createBackdrop(this.blueNoise);
    this.scene.add(this.backdrop.mesh);

    this.lights = createLightRig();
    this.scene.add(this.lights.group);

    /* ---- board ---- */

    this.boardRoot.name = 'board';
    this.scene.add(this.boardRoot);

    const plinth = new Mesh(createPlinthGeometry(), this.materials.aluminium);
    plinth.castShadow = true;
    plinth.receiveShadow = true;

    const frame = new Mesh(createFrameGeometry(), this.materials.aluminium);
    frame.castShadow = true;
    frame.receiveShadow = true;

    const mouths = new Mesh(createFeedMouthGeometry(), this.materials.aluminium);
    mouths.receiveShadow = true;

    for (const z of [PANEL_BACK_Z, PANEL_FRONT_Z]) {
      // z > 0 is the front sheet, drilled through so the discs can be seen;
      // the back sheet is solid and uses the opaque smoked material.
      const isFront = z > 0;
      const panel = new Mesh(
        createPanelGeometry(isFront),
        isFront ? this.materials.acrylic : this.materials.acrylicBack,
      );
      panel.position.z = z;
      // Neither casts nor receives. Casting is obviously wrong for a sheet the
      // light passes through — but so is receiving, because three renders VSM
      // *receivers* into the shadow map as well as casters, and a solid acrylic
      // occluder in that map throws a hard shadow across every disc behind it.
      // It is also 33k triangles a frame for a shadow nobody could see on glass.
      panel.castShadow = false;
      panel.receiveShadow = false;
      this.panels.push(panel);
    }

    this.buildDiscs(disc);
    this.buildRimStrokes();
    this.buildGhost();

    this.boardRoot.add(
      plinth,
      frame,
      mouths,
      this.panels[0],
      this.discMesh,
      this.panels[1],
      this.rimStrokes,
      this.ghost,
    );
    this.disposables.push(
      plinth.geometry,
      frame.geometry,
      mouths.geometry,
      this.panels[0].geometry,
      this.panels[1].geometry,
    );

    /* ---- optional systems ---- */

    this.buildEffects();

    this.rig.setAspect(this.camera.aspect);
    await this.renderer.compileAsync(this.scene, this.camera);
    this.discMesh.count = 0;
    this.rig.playIntro();
  }

  private buildDiscs(disc: ReturnType<typeof createDiscGeometry>): void {
    const cells = COLS * ROWS;
    const geometry = disc.geometry;

    const data = new Float32Array(cells * 4);
    for (let i = 0; i < cells; i++) data[i * 4 + 2] = 1; // darken = 1
    this.treat = new InstancedBufferAttribute(data, 4);
    this.treat.setUsage(DynamicDrawUsage);
    geometry.setAttribute(DISC_TREATMENT_ATTRIBUTE, this.treat);

    this.discMesh = new InstancedMesh(geometry, this.materials.disc, cells);
    this.discMesh.name = 'discs';
    this.discMesh.instanceMatrix.setUsage(DynamicDrawUsage);
    // Neither, and both are deliberate. Casting: the discs live between two
    // acrylic sheets, so their shadow lands on the back panel where no camera
    // in this product can see it. Receiving: three renders VSM receivers into
    // the shadow map as well as casters, which would put the whole 169k-triangle
    // instanced set through a third full pass every frame — 45 % of the bible's
    // entire triangle budget — to catch a shadow the front panel no longer
    // casts anyway. Bible §2.2 assigns contact darkening inside the board to
    // N8AO, and that is where it belongs.
    this.discMesh.castShadow = false;
    this.discMesh.receiveShadow = false;
    // `InstancedMesh` computes its bounding sphere lazily and then caches it
    // forever — it is never invalidated when instance matrices change. On an
    // empty board that first computation runs over zero instances and yields an
    // empty sphere (radius -1), which culls the mesh permanently: the board
    // renders and no disc ever appears again. Culling is worthless here anyway,
    // since the board is the subject of every frame this camera can compose.
    this.discMesh.frustumCulled = false;
    // Every slot gets a colour up front. `instanceColor` decides at compile
    // time whether the shader declares `vColor`, which the treatment injection
    // reads for the ignition tint — creating it lazily would leave the first
    // compiled program without it.
    for (let i = 0; i < cells; i++) this.discMesh.setColorAt(i, this.scratchColor.setHex(EMBER));
    this.discMesh.count = cells;
    this.disposables.push(geometry);

    for (let i = 0; i < cells; i++) {
      const proxy = new Object3D();
      proxy.matrixAutoUpdate = false;
      this.discProxies.push(proxy);
      this.boardRoot.add(proxy);
    }
    this.syncProxies();
  }

  private buildRimStrokes(): void {
    const geometry = createRimStrokeGeometry();
    this.rimStrokes = new InstancedMesh(geometry, this.materials.rimStroke, COLS * ROWS);
    this.rimStrokes.name = 'rim-strokes';
    this.rimStrokes.instanceMatrix.setUsage(DynamicDrawUsage);
    this.rimStrokes.frustumCulled = false;
    this.rimStrokes.renderOrder = 5;
    this.rimStrokes.count = 0;
    for (let i = 0; i < COLS * ROWS; i++) {
      this.rimStrokes.setColorAt(i, this.scratchColor.setHex(0x000000));
    }
    this.disposables.push(geometry);
  }

  private buildGhost(): void {
    const geometry = createGhostDiscGeometry();
    this.ghost = new Mesh(geometry, this.ghostMat.material);
    this.ghost.name = 'ghost';
    this.ghost.renderOrder = 6;
    this.ghost.visible = false;
    this.ghost.position.set(0, FEED_GHOST_Y, 0);
    this.disposables.push(geometry);
  }

  /**
   * Build the coach overlay, the outcome sequence and the post chain.
   *
   * These were once loaded dynamically, back when they were being written in
   * parallel with this file and might not have existed. They all exist now, so
   * they are plain imports: a static graph is one fewer failure mode.
   *
   * Each is still constructed independently and defensively. The bible's order
   * of operations is that the lighting rig is signed off *before* post exists,
   * so "no post" has to stay a good-looking mode rather than a broken one — and
   * a chain that throws on a device without float render targets must cost the
   * frame its grain, not its board. `FallbackOutcome` covers the same ground
   * for the win sequence: house dim plus an ignition cascade, no filament.
   */
  private buildEffects(): void {
    const ctx: EffectContext = {
      scene: this.scene,
      camera: this.camera,
      renderer: this.renderer,
      boardRoot: this.boardRoot,
      quality: this.quality,
      reducedMotion: this.reducedMotion,
      discAt: (col, row) => this.discAt(col, row),
    };

    try {
      this.outcome = createOutcomeEffects(ctx);
    } catch (err) {
      console.warn('outcome effects unavailable; using the built-in sequence', err);
    }
    try {
      this.coach = createCoachOverlay(ctx);
    } catch (err) {
      console.warn('coach overlay unavailable', err);
    }
    try {
      this.post = createPostFX({
        renderer: this.renderer,
        scene: this.scene,
        camera: this.camera,
        quality: this.quality,
        reducedMotion: this.reducedMotion,
      });
    } catch (err) {
      console.warn('post chain unavailable; rendering direct to canvas', err);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.post?.dispose();
    this.coach?.dispose();
    this.outcome.dispose();
    this.backdrop.dispose();
    this.lights.dispose();
    this.materials.dispose();
    this.ghostMat.material.dispose();
    for (const d of this.disposables) d.dispose();
    this.blueNoise.dispose();
    this.envMap?.dispose();
    this.renderer.dispose();
    for (const w of this.frameWaiters) w.resolve();
    for (const w of this.settleWaiters) w.resolve();
    this.frameWaiters.length = 0;
    this.settleWaiters.length = 0;
  }

  /* ---------------------------------------------------------------- *
   * Frame
   * ---------------------------------------------------------------- */

  render(dtMs: number): void {
    if (this.disposed) return;
    // Clamped hard: a tab that has been in the background hands back a delta of
    // several seconds, and a physics step that large teleports a falling disc
    // through the board.
    const dt = Math.min(0.05, Math.max(0, dtMs / 1000));
    this.elapsed += dt;
    this.renderer.info.reset();

    this.rig.update(dt);
    this.updateDrops(dt);
    this.updateHover(dt);
    this.ghostMat.advance(dt);
    this.outcome.update(dt);
    this.coach?.update(dt);
    this.applyOutcome();

    // The catchlight is expressed in view space, so it has to be refreshed after
    // the rig has placed the camera and before anything draws. `updateMatrixWorld`
    // on a camera is what refreshes `matrixWorldInverse`; the renderer would do
    // it too, but not until after the shaders had already read stale uniforms.
    this.camera.updateMatrixWorld();
    this.catchlight.update(this.camera.matrixWorldInverse);

    if (this.post) this.post.render(dtMs);
    else this.renderer.render(this.scene, this.camera);

    // The coach draws after the main image with scene depth bound (bible §7.4),
    // so overlay elements behind the acrylic dim rather than disappear.
    this.coach?.render();

    // Bookkeeping gets the *unclamped* delta. Feeding it the animation clamp
    // would cap the reported frame time at 50 ms, so a machine running at 3 fps
    // would report 20 and the tier probe would never see how slow it really is.
    // A separate, much looser cap keeps one backgrounded tab from poisoning the
    // average.
    this.bookkeep(Math.min(1000, Math.max(0, dtMs)));
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const cap = this.isTierA ? 2 : 1.5;
    const ratio = Math.min(dpr, cap);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(cssWidth, cssHeight, false);
    this.rig.setAspect(cssWidth / Math.max(1, cssHeight));
    this.post?.resize(Math.round(cssWidth * ratio), Math.round(cssHeight * ratio));
  }

  private bookkeep(dtMs: number): void {
    this.frameIndex++;
    // Exponential average: a single hitch should not make the readout jump.
    this.frameMs = this.frameMs * 0.9 + dtMs * 0.1;
    this.fps = this.frameMs > 0 ? 1000 / this.frameMs : 0;
    // Snapshot before anything else can render and disturb the counters.
    this.drawCalls = this.renderer.info.render.calls;
    this.triangles = this.renderer.info.render.triangles;

    if (!this.qualityLocked && this.probeFrames < 120) {
      // Skip the first ten frames: shader compilation and the first upload of
      // every buffer land there and say nothing about sustained performance.
      if (this.frameIndex > 10) {
        this.probeTotal += dtMs;
        this.probeFrames++;
        if (this.probeFrames === 120 && this.probeTotal / 120 > 12) this.setQuality('medium');
      }
    }

    for (let i = this.frameWaiters.length - 1; i >= 0; i--) {
      if (this.frameIndex >= this.frameWaiters[i].at) {
        this.frameWaiters[i].resolve();
        this.frameWaiters.splice(i, 1);
      }
    }
    if (this.settleWaiters.length) {
      const quiet = !this.busy();
      for (let i = this.settleWaiters.length - 1; i >= 0; i--) {
        if (quiet || this.frameIndex >= this.settleWaiters[i].deadline) {
          this.settleWaiters[i].resolve();
          this.settleWaiters.splice(i, 1);
        }
      }
    }
  }

  private busy(): boolean {
    return (
      this.drops.length > 0 ||
      this.rig.busy ||
      this.outcome.active ||
      this.ghostSlide !== null ||
      this.reject !== null ||
      // Mid-fade in *either* direction. Testing the alpha alone would let the
      // harness screenshot a half-faded ghost on the way out.
      (this.hoverPhase > 0 && this.hoverPhase < 1)
    );
  }

  /* ---------------------------------------------------------------- *
   * Position and drops
   * ---------------------------------------------------------------- */

  setPosition(cells: readonly Cell[]): void {
    for (const d of this.drops) d.resolve?.();
    this.drops.length = 0;

    this.cellSlot.fill(-1);
    this.slotCell.fill(-1);
    this.discCount = 0;

    for (let col = 0; col < COLS; col++) {
      for (let row = 0; row < ROWS; row++) {
        const owner = cells[cellIndex(col, row)];
        if (owner === null || owner === undefined) continue;
        this.place(col, row, owner, rowY(row), 0);
      }
    }
    this.discMesh.count = this.discCount;
    this.discMesh.instanceMatrix.needsUpdate = true;
    if (this.discMesh.instanceColor) this.discMesh.instanceColor.needsUpdate = true;
    this.syncProxies();
  }

  /** Claim an instance slot for a cell and write its transform and colour. */
  private place(col: number, row: number, player: Player, y: number, roll: number): number {
    const idx = cellIndex(col, row);
    let slot = this.cellSlot[idx];
    if (slot < 0) {
      slot = this.discCount++;
      this.cellSlot[idx] = slot;
      this.slotCell[slot] = idx;
      this.discMesh.setColorAt(slot, this.scratchColor.setHex(player === Player.One ? EMBER : PETROL));
      if (this.discMesh.instanceColor) this.discMesh.instanceColor.needsUpdate = true;
      this.writeTreatment(slot, DEFAULT_TREATMENT);
    }
    this.dummy.position.set(columnX(col), y, 0);
    this.dummy.rotation.set(0, 0, roll);
    this.dummy.updateMatrix();
    this.discMesh.setMatrixAt(slot, this.dummy.matrix);
    this.discMesh.instanceMatrix.needsUpdate = true;
    return slot;
  }

  dropDisc(col: number, row: number, player: Player): Promise<void> {
    return new Promise<void>((resolve) => this.startDrop(col, row, player, resolve));
  }

  beginDrop(col: number, row: number, player: Player): void {
    this.startDrop(col, row, player, null);
  }

  private startDrop(
    col: number,
    row: number,
    player: Player,
    resolve: (() => void) | null,
  ): void {
    const idx = cellIndex(col, row);
    this.lastMover = player;
    const restY = rowY(row);
    this.place(col, row, player, RELEASE_Y, 0);
    this.discMesh.count = this.discCount;

    // Seeded per cell so two drops into the same column never rattle
    // identically, but the same move always replays the same way — the
    // screenshot harness depends on that.
    const track = new DropTrack(RELEASE_Y, restY, undefined, idx);
    this.drops.push({ col, row, player, track, t: 0, nextImpact: 0, resolve });
    this.syncProxies();
  }

  private updateDrops(dt: number): void {
    if (!this.drops.length) return;

    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];

      // Impacts are fired for the window the *next* frame will cover, with the
      // remaining time to contact, so a scheduled transient lands on the exact
      // physics-contact frame instead of one frame after it.
      const horizon = d.t + dt;
      while (d.nextImpact < d.track.impacts.length) {
        const impact = d.track.impacts[d.nextImpact];
        if (impact.time > horizon) break;
        this.emitImpact({
          col: d.col,
          row: d.row,
          player: d.player,
          index: impact.index,
          speed: impact.speed,
          lead: Math.max(0, impact.time - d.t),
        });
        if (impact.index === 0 && RELEASE_Y - d.track.restY >= 4 * CELL_PITCH) this.rig.nudge();
        d.nextImpact++;
      }

      d.t += dt;
      const state = d.track.sample(d.t);
      this.place(d.col, d.row, d.player, state.y, state.roll);

      if (d.t >= d.track.duration) {
        this.place(d.col, d.row, d.player, d.track.restY, 0);
        d.resolve?.();
        this.drops.splice(i, 1);
      }
    }
    this.syncProxies();
  }

  private emitImpact(impact: DiscImpact): void {
    for (const listener of this.impactListeners) listener(impact);
  }

  onImpact(listener: (impact: DiscImpact) => void): () => void {
    this.impactListeners.add(listener);
    return () => this.impactListeners.delete(listener);
  }

  /** Keep the effect systems' addressable stand-ins on the discs they name. */
  private syncProxies(): void {
    for (let i = 0; i < this.discProxies.length; i++) {
      const cell = this.slotCell[i];
      const proxy = this.discProxies[i];
      if (cell < 0) {
        proxy.visible = false;
        continue;
      }
      proxy.visible = true;
      this.discMesh.getMatrixAt(i, proxy.matrix);
      proxy.matrixWorldNeedsUpdate = true;
    }
  }

  private discAt(col: number, row: number): Object3D | null {
    const slot = this.cellSlot[cellIndex(col, row)];
    return slot < 0 ? null : this.discProxies[slot];
  }

  /* ---------------------------------------------------------------- *
   * Interaction
   * ---------------------------------------------------------------- */

  columnAtPointer(ndcX: number, ndcY: number): number | null {
    this.raycaster.setFromCamera(this.scratchV2.set(ndcX, ndcY), this.camera);
    const hit = this.raycaster.ray.intersectPlane(this.pickPlane, this.scratchV3);
    if (!hit) return null;
    if (!isOverGrid(hit.x)) return null;
    // Generous above the board so aiming from the feed mouths still reads, and
    // a little below it so the bottom row is not a dead strip.
    if (hit.y < BOARD_BOTTOM_Y - 0.03 || hit.y > BOARD_TOP_Y + CELL_PITCH * 2.5) return null;
    return columnFromX(hit.x);
  }

  setHover(col: number | null, row: number | null, player: Player): void {
    if (col !== null && this.hoverCol !== null && col !== this.hoverCol && this.hoverAlpha > 0) {
      // Slide, do not cut: 90 ms between column centres (bible §5.3).
      this.ghostSlide = { from: this.ghostX, to: columnX(col), t: 0 };
    } else if (col !== null && this.hoverAlpha <= 0) {
      this.ghostX = columnX(col);
      this.ghostSlide = null;
    }
    this.hoverCol = col;
    this.hoverRow = row;
    this.hoverPlayer = player;
    this.coach?.setInspectedColumn(col);
  }

  private updateHover(dt: number): void {
    /* ghost position */
    if (this.ghostSlide) {
      this.ghostSlide.t += dt * 1000;
      const p = EASE.hover(clamp01(this.ghostSlide.t / 90));
      this.ghostX = this.ghostSlide.from + (this.ghostSlide.to - this.ghostSlide.from) * p;
      if (p >= 1) this.ghostSlide = null;
    } else if (this.hoverCol !== null) {
      this.ghostX = columnX(this.hoverCol);
    }

    /* fade: 120 ms in, 200 ms out, on the hover curve */
    const wantsGhost = this.hoverCol !== null;
    const rate = wantsGhost ? dt * 1000 / 120 : -(dt * 1000) / 200;
    this.hoverPhase = clamp01(this.hoverPhase + rate);
    this.hoverAlpha = EASE.hover(this.hoverPhase);

    if (wantsGhost) {
      this.ghost.position.set(this.ghostX, FEED_GHOST_Y, 0);
      this.ghostMat.setColour(this.hoverPlayer === Player.One ? PALETTE.emberGlow : PALETTE.petrolGlow);
      // Perfectly still. The stillness is the weight cue; a bobbing ghost is
      // the toy version of this object.
      this.ghostMat.setOpacity(this.hoverAlpha);
    } else if (this.thinking || this.thinkingFade > 0) {
      // The AI is choosing: the same ghost, centred over the board, dimmer, and
      // equally still. The only life it has is the 1.8 s breath the win sequence
      // also uses — the bible's rule is that nothing wiggles for attention, and
      // an indicator that jitters would be exactly that.
      this.thinkingFade = clamp01(
        this.thinkingFade + ((this.thinking ? 1 : -1) * dt * 1000) / 240,
      );
      this.thinkingPhase = this.reducedMotion ? 0.25 : (this.thinkingPhase + dt / 1.8) % 1;
      const breath = 0.35 + (this.reducedMotion ? 0 : 0.05 * Math.sin(this.thinkingPhase * Math.PI * 2));
      this.ghost.position.set(0, FEED_GHOST_Y, 0);
      // No player is named by `setThinking`, so the colour is inferred: the side
      // that did not just move is the side about to.
      this.ghostMat.setColour(
        this.lastMover === Player.One ? PALETTE.petrolGlow : PALETTE.emberGlow,
      );
      this.ghostMat.setOpacity(breath * EASE.hover(this.thinkingFade));
    } else {
      this.ghostMat.setOpacity(this.hoverAlpha);
    }
    this.ghost.visible = this.ghostMat.material.visible;

    /* reject flash */
    if (this.reject) {
      this.reject.t += dt * 1000;
      if (this.reject.t >= 260) this.reject = null;
    }

    this.updateRimStrokes();
  }

  /**
   * Hairline strokes on hole rims (bible §5.3): the hovered column at 8 % ink,
   * the landing cell at 20 %, a rejected column flashing to 35 %. One instanced
   * mesh, `count` set to whatever is actually lit, so an idle board costs
   * nothing at all.
   */
  private updateRimStrokes(): void {
    let n = 0;
    const push = (col: number, row: number, weight: number) => {
      if (weight <= 0.001) return;
      this.dummy.position.set(columnX(col), rowY(row), PANEL_FRONT_FACE_Z + 0.0003);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.updateMatrix();
      this.rimStrokes.setMatrixAt(n, this.dummy.matrix);
      // Additive and scene-referred: the strokes carry the rig's scale so their
      // on-screen weight is the bible's 8 % / 20 % after exposure.
      this.rimStrokes.setColorAt(
        n,
        this.scratchColor.setHex(PALETTE.ink).multiplyScalar(weight * RIG_SCALE),
      );
      n++;
    };

    if (this.hoverCol !== null && this.hoverAlpha > 0.001) {
      for (let row = 0; row < ROWS; row++) {
        push(this.hoverCol, row, (row === this.hoverRow ? 0.2 : 0.08) * this.hoverAlpha);
      }
    }
    if (this.reject) {
      const fade = 1 - EASE.uiOut(clamp01(this.reject.t / 260));
      for (let row = 0; row < ROWS; row++) push(this.reject.col, row, 0.35 * fade);
    }

    this.rimStrokes.count = n;
    if (n > 0) {
      this.rimStrokes.instanceMatrix.needsUpdate = true;
      if (this.rimStrokes.instanceColor) this.rimStrokes.instanceColor.needsUpdate = true;
    }
  }

  setParallax(x: number, y: number): void {
    this.rig.setParallax(x, y);
  }

  setThinking(thinking: boolean): void {
    this.thinking = thinking;
  }

  rejectColumn(col: number): void {
    // A flash on the rims, and nothing else. The bible allows screen shake for
    // a heavy landing and for nothing else in the product.
    this.reject = { col, t: 0 };
  }

  /* ---------------------------------------------------------------- *
   * Outcome and coach
   * ---------------------------------------------------------------- */

  showWin(line: readonly Coord[], winner: Player): void {
    this.outcome.playWin(line, winner, winner !== this.viewer);
    this.post?.setState('win');
  }

  showDraw(): void {
    this.outcome.playDraw();
  }

  clearOutcome(): void {
    this.outcome.clear();
    this.lastCameraRequest = '';
    this.rig.clearFraming();
    this.post?.setState('play');
    this.post?.setFocusOverride(null);
    this.post?.setVignetteBias(0);
    this.lights.setKeyTemperature(0);
    this.backdrop.setGrade(0, 1);
    this.applyOutcome();
  }

  /**
   * Push the sequence's current grade into the things that own it: per-disc
   * attributes, the backdrop uniforms, the key light, and the post chain. The
   * effect systems only ever *describe* what they want; the scene applies it,
   * which is what keeps them from needing to know about instancing.
   */
  private applyOutcome(): void {
    const house = this.outcome.house();

    for (let slot = 0; slot < this.discCount; slot++) {
      const cell = this.slotCell[slot];
      if (cell < 0) continue;
      const col = (cell / ROWS) | 0;
      const row = cell % ROWS;
      const explicit = this.outcome.treatmentFor(col, row);
      this.writeTreatment(
        slot,
        explicit ?? {
          ignition: 0,
          desaturation: house.desaturation,
          darken: house.darken,
          roughnessBias: 0,
        },
      );
    }
    // Only re-upload when something actually moved. An idle board would
    // otherwise push the attribute buffer to the GPU on every frame for the
    // rest of the game.
    if (this.treatDirty) {
      this.treat.needsUpdate = true;
      this.treatDirty = false;
    }

    this.backdrop.setGrade(house.desaturation, house.darken);
    // The tabletop is graded through its albedo tint rather than a uniform:
    // it shares the basalt material with nothing else, so there is nothing to
    // corrupt, and it keeps the house dim to one code path.
    this.materials.basalt.color.setScalar(house.darken);
    this.lights.setKeyTemperature(house.keyTemperatureShift);
    this.post?.setVignetteBias(house.vignetteBias);

    const focus = this.outcome.focusRequest();
    this.post?.setFocusOverride(focus);

    const request = this.outcome.cameraRequest();
    const key = request
      ? `${request.dollyScale}|${request.orbitDegrees}|${request.durationMs}`
      : '';
    if (key !== this.lastCameraRequest) {
      this.lastCameraRequest = key;
      if (request) {
        this.rig.requestFraming(request.dollyScale, request.orbitDegrees, request.durationMs);
      } else {
        this.rig.clearFraming();
      }
    }
  }

  private writeTreatment(slot: number, t: DiscTreatment): void {
    const a = this.treat.array as Float32Array;
    const i = slot * 4;
    if (
      a[i] !== t.ignition ||
      a[i + 1] !== t.desaturation ||
      a[i + 2] !== t.darken ||
      a[i + 3] !== t.roughnessBias
    ) {
      this.treatDirty = true;
    }
    a[i] = t.ignition;
    a[i + 1] = t.desaturation;
    a[i + 2] = t.darken;
    a[i + 3] = t.roughnessBias;
  }

  setTeachingOverlay(report: ThreatReport | null, viewer: Player): void {
    this.viewer = viewer;
    // The interface does not carry side-to-move, but it is unambiguous from the
    // board: player one moves first, so an even disc count means it is theirs.
    const toMove = this.discCount % 2 === 0 ? Player.One : Player.Two;
    this.coach?.setReport(report, viewer, toMove);
    // A null report is the controller's way of saying "off"; anything else
    // leaves the verbosity where `setCoachMode` last put it.
    this.coach?.setMode(report ? this.coachMode : 'off');
  }

  setCoachMode(mode: CoachMode): void {
    this.coachMode = mode === 'off' ? 'full' : mode;
    this.coach?.setMode(mode);
  }

  /* ---------------------------------------------------------------- *
   * Diagnostics
   * ---------------------------------------------------------------- */

  stats(): RenderStats {
    return {
      fps: Math.round(this.fps * 10) / 10,
      frameMs: Math.round(this.frameMs * 100) / 100,
      drawCalls: this.drawCalls,
      triangles: this.triangles,
      quality: this.quality,
    };
  }

  private get isTierA(): boolean {
    return this.quality === 'high' || this.quality === 'ultra';
  }

  private applyTransmissionScale(): void {
    this.renderer.transmissionResolutionScale = this.isTierA ? 1.0 : 0.5;
  }

  setQuality(tier: QualityTier): void {
    if (tier === this.quality) return;
    this.quality = tier;
    this.materials.setTier(tier);
    this.applyTransmissionScale();
    this.post?.setQuality(tier);
    const size = this.renderer.getSize(this.scratchV2);
    this.resize(size.x, size.y, this.options.canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1);
  }

  waitFrames(n: number): Promise<void> {
    if (n <= 0) return Promise.resolve();
    return new Promise<void>((resolve) =>
      this.frameWaiters.push({ at: this.frameIndex + n, resolve }),
    );
  }

  /**
   * Jump every animation to its resting state (see `BoardView.snapAnimations`).
   *
   * Drops are finished by sampling each track past its end rather than by
   * cancelling it, so a snapped disc lands exactly where a watched one would —
   * the harness must never photograph a position the game could not reach.
   */
  snapAnimations(): void {
    this.rig.snapToRest();
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      // Place the disc where its own track says it ends, rather than
      // cancelling the drop — the harness must never photograph a resting
      // position the simulation would not actually have produced.
      this.place(d.col, d.row, d.player, d.track.restY, 0);
      d.resolve?.();
      this.drops.splice(i, 1);
    }
    this.syncProxies();
  }

  settle(): Promise<void> {
    return new Promise<void>((resolve) =>
      // Hard frame cap. Nothing in the product animates for longer than 2.5 s,
      // so a settle that has not resolved in 240 frames is a stuck animation,
      // and hanging the screenshot harness on it helps nobody.
      this.settleWaiters.push({ deadline: this.frameIndex + 240, resolve }),
    );
  }
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Re-exported so callers can name the post states without a second import. */
export type { PostState };
