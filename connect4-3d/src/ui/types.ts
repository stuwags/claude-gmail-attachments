/**
 * Contract between the game controller and the DOM chrome.
 *
 * The HUD is a pure function of a snapshot: the controller hands it the whole
 * state each time anything changes, and the HUD renders it. It never reads game
 * state directly and never decides anything — it only reports what the player
 * pressed. That keeps every rule in one place and makes the interface
 * replaceable without touching game logic.
 */

import type { AiDecision, Difficulty, GameOutcome, Player } from '../engine/types.ts';
import type { CoachMode } from '../render/effects/types.ts';
import type { QualityTier } from '../render/api.ts';

export type GamePhase =
  /** Title screen, board present but idle. */
  | 'menu'
  /** Waiting for the human. */
  | 'playing'
  /** The AI is searching. */
  | 'thinking'
  /** A disc is falling; input is refused. */
  | 'animating'
  /** Win, loss or draw is being presented. */
  | 'over';

/** Everything the chrome needs. Rebuilt and pushed on every state change. */
export interface GameSnapshot {
  phase: GamePhase;
  difficulty: Difficulty;
  coachMode: CoachMode;
  /** Whose turn it is. */
  toMove: Player;
  /** Which colour the human is playing. */
  humanPlayer: Player;
  /** False for local two-player. */
  vsAi: boolean;
  moveCount: number;
  canUndo: boolean;
  outcome: GameOutcome;
  /** The AI's last decision, for the (optional) analysis readout. */
  lastDecision: AiDecision | null;
  muted: boolean;
  quality: QualityTier;
  /**
   * Columns the coach wants called out in the chrome as urgent — used for the
   * turn capsule's advisory line in Easy mode. Empty when the coach is off.
   */
  urgentColumns: number[];
}

/** Configuration chosen on the title screen. */
export interface MatchConfig {
  difficulty: Difficulty;
  vsAi: boolean;
  /** Which colour the human takes. Player.One always moves first. */
  humanPlayer: Player;
  coachMode: CoachMode;
}

/** What the chrome reports back. Every one is a player intent, not a state change. */
export interface HudCallbacks {
  onStartMatch(config: MatchConfig): void;
  onRestart(): void;
  onUndo(): void;
  onSetDifficulty(difficulty: Difficulty): void;
  onSetCoachMode(mode: CoachMode): void;
  onToggleMute(): void;
  onSetQuality(tier: QualityTier): void;
  /** Player asked to go back to the title screen. */
  onOpenMenu(): void;
}

export interface Hud {
  mount(root: HTMLElement, callbacks: HudCallbacks): void;
  /** Re-render from a snapshot. Called on every state change; must be cheap and idempotent. */
  update(snapshot: GameSnapshot): void;
  /**
   * Present the outcome banner. Copy comes from the controller so the wording
   * stays with the game rules ("Ember takes it.", "Nobody yields.").
   */
  showBanner(text: string, tone: 'win' | 'loss' | 'draw'): void;
  hideBanner(): void;
  dispose(): void;
}
