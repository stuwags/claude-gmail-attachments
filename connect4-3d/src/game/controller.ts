/**
 * The game's state machine.
 *
 * Owns the rules, the turn order, and the sequencing of everything that has to
 * happen in order: a disc lands, *then* the position is judged, *then* the
 * computer is allowed to think. Nothing else in the app knows the rules.
 *
 * Every asynchronous continuation is guarded by a generation counter. Restart
 * and undo are reachable while a disc is mid-fall or the search is running, and
 * without the guard a stale continuation would happily drop a disc onto a board
 * that no longer exists.
 */

import { Board } from '../engine/board';
import { analyze } from '../engine/threats';
import { Player, other, type Coord, type Difficulty, type GameOutcome } from '../engine/types';
import type { AiDecision, ThreatReport } from '../engine/types';
import type { BoardView, QualityTier } from '../render/api';
import type { CoachMode } from '../render/effects/types';
import type { GamePhase, GameSnapshot, Hud, MatchConfig } from '../ui/types';
import { AiClient } from './ai-client';
import { AudioEngine } from './audio';

/** Display names, from the art direction. */
export const PLAYER_NAMES: Record<Player, string> = {
  [Player.One]: 'Ember',
  [Player.Two]: 'Petrol',
};

/** Per-difficulty search budget and how long the computer pretends to think. */
const AI_TIMING: Record<Difficulty, { budgetMs: number; minThinkMs: number; maxThinkMs: number }> = {
  // Easy answers quickly — a child waiting on a beginner-strength opponent is
  // just dead air — but not instantly, which reads as dismissive.
  easy: { budgetMs: 60, minThinkMs: 420, maxThinkMs: 700 },
  medium: { budgetMs: 220, minThinkMs: 520, maxThinkMs: 950 },
  hard: { budgetMs: 900, minThinkMs: 600, maxThinkMs: 1500 },
};

export interface ControllerDeps {
  view: BoardView;
  hud: Hud;
  audio: AudioEngine;
  ai: AiClient;
}

export class GameController {
  private board = new Board();
  private phase: GamePhase = 'menu';
  private config: MatchConfig = {
    difficulty: 'medium',
    vsAi: true,
    humanPlayer: Player.One,
    coachMode: 'off',
  };
  private lastDecision: AiDecision | null = null;
  private quality: QualityTier = 'high';
  /** Bumped on every reset; stale async work checks it and bails. */
  private generation = 0;
  /** Seeds the AI so a given match replays identically. */
  private matchSeed = (Math.random() * 0x7fffffff) | 0;
  private hoveredColumn: number | null = null;

  constructor(private deps: ControllerDeps) {}

  /* ------------------------------------------------------------------ *
   * Match lifecycle
   * ------------------------------------------------------------------ */

  /** Begin a match. Safe to call at any time; cancels whatever was in flight. */
  async startMatch(config: MatchConfig): Promise<void> {
    this.config = { ...config };
    await this.resetBoard('playing');

    // If the human took second colour, the computer opens.
    if (this.config.vsAi && this.board.toMove !== this.config.humanPlayer) {
      void this.runAiTurn();
    }
  }

  /** Restart the current match with the same settings. */
  async restart(): Promise<void> {
    await this.resetBoard('playing');
    if (this.config.vsAi && this.board.toMove !== this.config.humanPlayer) {
      void this.runAiTurn();
    }
  }

  /** Return to the title screen. */
  async openMenu(): Promise<void> {
    await this.resetBoard('menu');
  }

  private async resetBoard(phase: GamePhase): Promise<void> {
    this.generation++;
    this.deps.ai.cancel();
    this.board = new Board();
    this.lastDecision = null;
    this.hoveredColumn = null;
    this.matchSeed = (Math.random() * 0x7fffffff) | 0;
    this.phase = phase;

    this.deps.view.clearOutcome();
    this.deps.view.setThinking(false);
    this.deps.view.setHover(null, null, this.config.humanPlayer);
    this.deps.view.setPosition(this.board.cells());
    this.deps.hud.hideBanner();
    this.refreshCoach();
    this.publish();
  }

  /* ------------------------------------------------------------------ *
   * Moves
   * ------------------------------------------------------------------ */

  /**
   * A human drops a disc. Returns false when the move was refused, so input
   * can decide whether to give haptic feedback.
   */
  async playColumn(col: number): Promise<boolean> {
    if (this.phase !== 'playing') return false;
    if (this.config.vsAi && this.board.toMove !== this.config.humanPlayer) return false;

    if (!this.board.canPlay(col)) {
      this.deps.view.rejectColumn(col);
      this.deps.audio.reject();
      return false;
    }

    const gen = this.generation;
    await this.commitMove(col);
    if (gen !== this.generation) return true;

    if (this.phase === 'playing' && this.config.vsAi) {
      void this.runAiTurn();
    }
    return true;
  }

  /**
   * Apply one move: mutate the board, animate it, then judge the position.
   * The order matters — judging before the disc lands would spoil the moment.
   */
  private async commitMove(col: number): Promise<void> {
    const gen = this.generation;
    const player = this.board.toMove;
    const row = this.board.play(col);

    this.phase = 'animating';
    this.deps.view.setHover(null, null, this.config.humanPlayer);
    // Hide the coach during the fall; a threat that is about to change is
    // more confusing than no threat at all.
    this.deps.view.setTeachingOverlay(null, this.config.humanPlayer);
    this.publish();

    this.deps.audio.discRelease();
    await this.deps.view.dropDisc(col, row, player);
    if (gen !== this.generation) return;

    const outcome = this.board.outcome();
    if (outcome.kind === 'ongoing') {
      this.phase = 'playing';
      this.refreshCoach();
      this.publish();
      return;
    }
    this.presentOutcome(outcome);
  }

  /** Take back the human's last move, and the computer's reply with it. */
  async undo(): Promise<void> {
    if (!this.canUndo()) return;

    this.generation++;
    const gen = this.generation;
    this.deps.ai.cancel();

    this.deps.view.clearOutcome();
    this.deps.hud.hideBanner();
    this.deps.view.setThinking(false);

    // In a match against the computer, undoing one ply would just hand the
    // position straight back to it. Undo the pair so the human actually gets
    // their decision back.
    const plies = this.config.vsAi && this.board.moveCount >= 2 ? 2 : 1;
    for (let i = 0; i < plies; i++) this.board.undo();

    this.phase = 'playing';
    this.lastDecision = null;
    this.deps.view.setPosition(this.board.cells());
    this.refreshCoach();
    this.publish();

    if (gen !== this.generation) return;
    // If undoing landed on the computer's turn (human plays second), let it move.
    if (this.config.vsAi && this.board.toMove !== this.config.humanPlayer) {
      void this.runAiTurn();
    }
  }

  private canUndo(): boolean {
    if (this.board.moveCount === 0) return false;
    return this.phase === 'playing' || this.phase === 'over';
  }

  /* ------------------------------------------------------------------ *
   * The computer's turn
   * ------------------------------------------------------------------ */

  private async runAiTurn(): Promise<void> {
    const gen = this.generation;
    if (this.phase !== 'playing') return;

    this.phase = 'thinking';
    this.deps.view.setThinking(true);
    this.publish();

    const timing = AI_TIMING[this.config.difficulty];
    const started = performance.now();

    let decision: AiDecision;
    try {
      const search = this.deps.ai.think({
        moves: [...this.board.history],
        difficulty: this.config.difficulty,
        timeBudgetMs: timing.budgetMs,
        // Vary the seed per ply so a repeated position is not answered identically.
        seed: (this.matchSeed + this.board.moveCount * 2654435761) >>> 0,
      });
      decision = await search;
    } catch (err) {
      if (gen !== this.generation) return; // Cancelled by restart/undo; not an error.
      // Losing the search must never strand the game. Fall back to a legal move.
      const legal = this.board.legalMoves();
      if (!legal.length) return;
      decision = {
        column: legal[(Math.random() * legal.length) | 0],
        score: 0,
        depth: 0,
        nodes: 0,
        elapsedMs: 0,
        pv: [],
      };
      if (import.meta.env.DEV) console.warn('AI search failed, playing a legal move:', err);
    }

    if (gen !== this.generation) return;

    // Hold the "thinking" state for a beat so the move does not appear
    // instantaneously, which reads as the computer not having considered it.
    const elapsed = performance.now() - started;
    const hold = Math.min(timing.maxThinkMs, Math.max(timing.minThinkMs - elapsed, 0));
    if (hold > 0) await delay(hold);
    if (gen !== this.generation) return;

    this.lastDecision = decision;
    this.deps.view.setThinking(false);
    this.phase = 'playing';

    // The search is bounded but not infallible; never trust it into `play()`.
    const col = this.board.canPlay(decision.column)
      ? decision.column
      : (this.board.legalMoves()[0] ?? -1);
    if (col < 0) return;

    await this.commitMove(col);
  }

  /* ------------------------------------------------------------------ *
   * Outcome
   * ------------------------------------------------------------------ */

  private presentOutcome(outcome: GameOutcome): void {
    this.phase = 'over';
    this.deps.view.setTeachingOverlay(null, this.config.humanPlayer);

    if (outcome.kind === 'win') {
      const humanLost = this.config.vsAi && outcome.winner !== this.config.humanPlayer;
      this.deps.view.showWin(outcome.line as Coord[], outcome.winner);
      if (humanLost) this.deps.audio.lose();
      else this.deps.audio.win();
      this.deps.hud.showBanner(
        `${PLAYER_NAMES[outcome.winner]} takes it.`,
        humanLost ? 'loss' : 'win',
      );
    } else if (outcome.kind === 'draw') {
      this.deps.view.showDraw();
      this.deps.audio.draw();
      this.deps.hud.showBanner('Nobody yields.', 'draw');
    }
    this.publish();
  }

  /* ------------------------------------------------------------------ *
   * Coach
   * ------------------------------------------------------------------ */

  /**
   * Recompute the teaching overlay. Cheap — 69 windows — so it just runs after
   * every board change rather than being cached and invalidated.
   */
  private refreshCoach(): ThreatReport | null {
    if (this.config.coachMode === 'off' || this.phase === 'menu') {
      this.deps.view.setTeachingOverlay(null, this.config.humanPlayer);
      return null;
    }
    const report = analyze(this.board);
    this.deps.view.setTeachingOverlay(report, this.config.humanPlayer);
    return report;
  }

  setCoachMode(mode: CoachMode): void {
    this.config.coachMode = mode;
    this.refreshCoach();
    this.publish();
  }

  setDifficulty(difficulty: Difficulty): void {
    this.config.difficulty = difficulty;
    // Easy mode exists to teach; turning the coach on with it is the point.
    if (difficulty === 'easy' && this.config.coachMode === 'off') {
      this.config.coachMode = 'full';
      this.refreshCoach();
    }
    this.publish();
  }

  setQuality(tier: QualityTier): void {
    this.quality = tier;
    this.deps.view.setQuality(tier);
    this.publish();
  }

  toggleMute(): void {
    this.deps.audio.setMuted(!this.deps.audio.muted);
    this.publish();
  }

  /* ------------------------------------------------------------------ *
   * Hover
   * ------------------------------------------------------------------ */

  /** Called by input as the pointer moves. `null` clears. */
  setHoveredColumn(col: number | null): void {
    if (col === this.hoveredColumn) return;
    this.hoveredColumn = col;

    const interactive =
      this.phase === 'playing' && (!this.config.vsAi || this.board.toMove === this.config.humanPlayer);

    if (col === null || !interactive) {
      this.deps.view.setHover(null, null, this.board.toMove);
      return;
    }
    const row = this.board.canPlay(col) ? this.board.heightOf(col) : null;
    this.deps.view.setHover(col, row, this.board.toMove);
    if (row !== null) this.deps.audio.uiHover();
  }

  /* ------------------------------------------------------------------ *
   * Snapshot
   * ------------------------------------------------------------------ */

  /** True when the human is allowed to drop a disc right now. */
  get acceptsInput(): boolean {
    return (
      this.phase === 'playing' &&
      (!this.config.vsAi || this.board.toMove === this.config.humanPlayer)
    );
  }

  get currentPhase(): GamePhase {
    return this.phase;
  }

  /** Read-only view of the position, for the debug hook and tests. */
  get position(): Board {
    return this.board;
  }

  snapshot(): GameSnapshot {
    let urgent: number[] = [];
    if (this.config.coachMode !== 'off' && this.phase === 'playing') {
      const report = analyze(this.board);
      // A block the child must find outranks a win they might spot themselves.
      urgent = [...new Set([...report.blockingMoves, ...report.winningMoves])];
    }

    return {
      phase: this.phase,
      difficulty: this.config.difficulty,
      coachMode: this.config.coachMode,
      toMove: this.board.toMove,
      humanPlayer: this.config.humanPlayer,
      vsAi: this.config.vsAi,
      moveCount: this.board.moveCount,
      canUndo: this.canUndo(),
      outcome: this.board.outcome(),
      lastDecision: this.lastDecision,
      muted: this.deps.audio.muted,
      quality: this.quality,
      urgentColumns: urgent,
    };
  }

  private publish(): void {
    this.deps.hud.update(this.snapshot());
  }

  /* ------------------------------------------------------------------ *
   * Test and harness support
   * ------------------------------------------------------------------ */

  /**
   * Apply a list of moves with no animation. Used by the screenshot harness to
   * reach an interesting position without waiting through every drop.
   */
  applyMovesInstantly(cols: number[]): void {
    this.generation++;
    this.deps.ai.cancel();
    this.board = new Board();
    for (const col of cols) {
      if (!this.board.canPlay(col)) continue;
      this.board.play(col);
    }
    const outcome = this.board.outcome();
    this.deps.view.setPosition(this.board.cells());

    if (outcome.kind === 'ongoing') {
      this.phase = 'playing';
      this.refreshCoach();
      this.publish();
    } else {
      this.presentOutcome(outcome);
    }
  }

  setPhase(phase: GamePhase): void {
    this.phase = phase;
    this.publish();
  }

  get matchConfig(): Readonly<MatchConfig> {
    return this.config;
  }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export { other as otherPlayer };
