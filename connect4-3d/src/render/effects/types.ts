/**
 * Seams for the two effect systems that live inside the board: the win/loss
 * presentation and the Easy-mode coach overlay.
 *
 * Both need the scene graph, the disc meshes and the depth buffer, so they
 * cannot be standalone — but they are also the two most art-directed parts of
 * the product, and they change independently of the lighting and materials.
 * Keeping them behind these interfaces lets the scene and the effects be built
 * and revised without either one waiting on the other.
 */

import type { Object3D, PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import type { Coord, Player, ThreatReport } from '../../engine/types.ts';
import type { QualityTier } from '../api.ts';

/** What an effect system is handed when the scene builds it. */
export interface EffectContext {
  scene: Scene;
  camera: PerspectiveCamera;
  renderer: WebGLRenderer;
  /** Parent for anything drawn inside the board; already positioned. */
  boardRoot: Object3D;
  quality: QualityTier;
  reducedMotion: boolean;
  /**
   * The resting mesh for an occupied cell, or null if empty. Effects use this
   * to drive per-disc emissive and desaturation without owning the discs.
   */
  discAt(col: number, row: number): Object3D | null;
}

/** Per-disc visual state the outcome sequence drives. Applied by the scene. */
export interface DiscTreatment {
  /** 0 = body colour, 1 = fully lit. Ramps the disc's own emissive. */
  ignition: number;
  /** 0..1, pulls the disc toward grey. */
  desaturation: number;
  /** Multiplies base albedo. Below 1 the disc recedes. */
  darken: number;
  /** Added to base roughness. Positive reads as clay going cold. */
  roughnessBias: number;
}

/** House-level grade the outcome sequence drives. Applied by the scene. */
export interface HouseTreatment {
  /** Applied to backdrop, table and every non-winning disc. */
  desaturation: number;
  darken: number;
  /** Kelvin offset on the key light. Negative is cooler. */
  keyTemperatureShift: number;
  /** Added to the post chain's vignette darkness. */
  vignetteBias: number;
}

/**
 * The win / loss / draw presentation (bible §6). Owns the ignition cascade, the
 * core filament, the motes, and the camera and focus requests that go with them.
 */
export interface OutcomeEffects {
  /**
   * Begin the win sequence. `line` is the four winning cells in order along the
   * win direction. `humanLost` picks the cooler loss temperament over the win
   * one; it does not change who is celebrated.
   */
  playWin(line: readonly Coord[], winner: Player, humanLost: boolean): void;
  playDraw(): void;
  /** Return to the neutral resting state, cancelling any sequence in flight. */
  clear(): void;

  /** Advance the sequence. Called once per frame with seconds elapsed. */
  update(dt: number): void;

  /** How this disc should currently look, or null for "untouched". */
  treatmentFor(col: number, row: number): DiscTreatment | null;
  /** The current house grade. */
  house(): HouseTreatment;

  /**
   * A camera move the sequence wants, in the rig's own terms, or null. The
   * camera rig owns the spring; the sequence only asks.
   */
  cameraRequest(): { dollyScale: number; orbitDegrees: number; durationMs: number } | null;
  /** Requested depth-of-field state, or null to leave it in play state. */
  focusRequest(): { worldFocusRange: number; bokehScale: number } | null;

  /** True while a sequence is still animating. */
  get active(): boolean;

  dispose(): void;
}

/**
 * The Easy-mode coach (bible §7). Renders threat filaments, ghost discs and
 * landing rings, subject to the noise budget in §7.3.
 */
export interface CoachOverlay {
  /**
   * Set what the coach should show. `null` turns it off entirely.
   * `viewer` is the human's colour, which decides "yours" versus "theirs".
   */
  setReport(report: ThreatReport | null, viewer: Player, toMove: Player): void;

  /** Off shows nothing; hints shows class A only; full applies all of §7.3. */
  setMode(mode: CoachMode): void;

  /**
   * The column being hovered, which reveals every line through that column's
   * landing cell (§7.3). `null` clears the reveal.
   *
   * `landingRow` is the row a disc dropped now would come to rest in. The
   * overlay cannot derive it from the threat report alone — a column with no
   * threats in it yet has no reported cells — and that column is exactly the
   * one a child most needs answered, so the caller must supply it. The scene
   * already computes it for the hover ghost; pass the same value through.
   */
  setInspectedColumn(col: number | null, landingRow?: number | null): void;

  /** Advance pulses and flow. Called once per frame with seconds elapsed. */
  update(dt: number): void;

  /**
   * Draw the overlay. Called after the main scene render with the scene depth
   * bound, so elements behind the acrylic dim rather than disappear (§7.4).
   */
  render(): void;

  /** Count of currently lit elements, for the §9 item 15 budget check. */
  litElementCount(): number;

  dispose(): void;
}

export type CoachMode = 'off' | 'hints' | 'full';
