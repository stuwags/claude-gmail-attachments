/**
 * The seam between game logic and pixels.
 *
 * The controller knows the rules and nothing about Three.js; the renderer knows
 * how to draw and nothing about minimax. Everything they say to each other goes
 * through this interface, which means the renderer can be rebuilt — or stubbed
 * out entirely in a test — without the game logic noticing.
 */

import type { Cell, Coord, Player, ThreatReport } from '../engine/types.ts';

/** Visual quality tier. Chosen automatically, overridable by the player. */
export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';

export interface RendererOptions {
  canvas: HTMLCanvasElement;
  quality?: QualityTier;
  /** Honour `prefers-reduced-motion`: no parallax, shortened celebrations. */
  reducedMotion?: boolean;
}

/** Live performance figures, surfaced in the debug overlay. */
export interface RenderStats {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  quality: QualityTier;
}

export interface BoardView {
  /** Build the scene, compile shaders, warm the pipeline. Resolves when the first frame is safe to show. */
  init(): Promise<void>;
  dispose(): void;

  /** Advance and draw one frame. `dtMs` is wall-clock delta, already clamped. */
  render(dtMs: number): void;

  /** Backing-store resize. Called on window resize and DPR change. */
  resize(cssWidth: number, cssHeight: number, dpr: number): void;

  /* -------------------- position -------------------- */

  /**
   * Set the whole board with no animation. Used on reset, undo, and when the
   * screenshot harness scrubs to a position.
   */
  setPosition(cells: readonly Cell[]): void;

  /**
   * Animate a disc falling into (col,row). Resolves when it has come to rest.
   * The renderer owns the timing; the controller just awaits it.
   */
  dropDisc(col: number, row: number, player: Player): Promise<void>;

  /**
   * Begin a drop without awaiting it. The harness uses this to freeze a frame
   * mid-fall; gameplay should prefer `dropDisc`.
   */
  beginDrop(col: number, row: number, player: Player): void;

  /* -------------------- interaction -------------------- */

  /**
   * Which column a pointer is over, in normalised device coords (-1..1, y up).
   * Returns null when the pointer is not over the board.
   */
  columnAtPointer(ndcX: number, ndcY: number): number | null;

  /**
   * Highlight a column and show the ghost disc that would fall into it.
   * `null` clears. `row` is where the disc would land, or null if the column is full.
   */
  setHover(col: number | null, row: number | null, player: Player): void;

  /** Subtle camera lean toward the pointer / device tilt. Both in -1..1. */
  setParallax(x: number, y: number): void;

  /* -------------------- feedback -------------------- */

  /**
   * Celebrate a win. `line` is the four winning cells in order; every disc not
   * in the line is the "loser" set and should visibly recede.
   */
  showWin(line: readonly Coord[], winner: Player): void;

  /** A drawn board: no winner, all discs settle to neutral. */
  showDraw(): void;

  /** Clear any win/draw presentation and return the board to normal. */
  clearOutcome(): void;

  /**
   * Easy mode's teaching layer: mark every 2- and 3-in-a-row for both players.
   * `null` turns the overlay off.
   */
  setTeachingOverlay(report: ThreatReport | null, viewer: Player): void;

  /** The AI is thinking; show a restrained indicator rather than freezing. */
  setThinking(thinking: boolean): void;

  /** Flash a column to show the move was rejected (column full). */
  rejectColumn(col: number): void;

  /* -------------------- diagnostics -------------------- */

  stats(): RenderStats;
  setQuality(tier: QualityTier): void;

  /**
   * Resolves after `n` rendered frames. The screenshot harness uses this to
   * step animations deterministically.
   */
  waitFrames(n: number): Promise<void>;

  /** Resolves once every in-flight animation has finished. */
  settle(): Promise<void>;
}
