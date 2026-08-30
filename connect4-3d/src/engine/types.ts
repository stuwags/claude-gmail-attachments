/**
 * Shared vocabulary for the rules engine, the search, and everything that
 * draws them. Geometry convention used everywhere in this project:
 *
 *   col 0..6   left to right as the camera sees the board
 *   row 0..5   BOTTOM (0) to TOP (5), because discs fall down and stack up
 *
 * Renderers that need a top-down row index can flip with (ROWS - 1 - row).
 */

export const COLS = 7;
export const ROWS = 6;
export const CELLS = COLS * ROWS;
/** Discs in a row needed to win. */
export const WIN_LENGTH = 4;

/** Whose disc occupies a cell. */
export const enum Player {
  /** Moves first. */
  One = 0,
  Two = 1,
}

export type Cell = Player | null;

/** Index of a cell in a flat board array: `col * ROWS + row`. */
export type CellIndex = number;

export const cellIndex = (col: number, row: number): CellIndex => col * ROWS + row;
export const colOf = (i: CellIndex): number => (i / ROWS) | 0;
export const rowOf = (i: CellIndex): number => i % ROWS;
export const other = (p: Player): Player => (p === Player.One ? Player.Two : Player.One);

/** A cell's coordinates. */
export interface Coord {
  col: number;
  row: number;
}

/** The four directions a win can run along, as (dCol, dRow) steps. */
export const DIRECTIONS = [
  { dc: 1, dr: 0, name: 'horizontal' },
  { dc: 0, dr: 1, name: 'vertical' },
  { dc: 1, dr: 1, name: 'diagonal-up' },
  { dc: 1, dr: -1, name: 'diagonal-down' },
] as const;

export type DirectionName = (typeof DIRECTIONS)[number]['name'];

/** How a finished game ended. */
export type GameOutcome =
  | { kind: 'ongoing' }
  | { kind: 'win'; winner: Player; line: Coord[]; direction: DirectionName }
  | { kind: 'draw' };

/**
 * A partial line that could still become four. This is the raw material for
 * both the AI's evaluation and Easy mode's teaching overlay.
 */
export interface Threat {
  /** Who owns the discs in this window. */
  owner: Player;
  /** How many of the owner's discs are already in the 4-window: 2 or 3. */
  count: 2 | 3;
  /** The cells in the window the owner already holds. */
  filled: Coord[];
  /** The empty cells in the window that would complete or extend it. */
  gaps: Coord[];
  /**
   * Gaps that a disc dropped this turn would actually land in. A count-3
   * threat with an immediate gap is a win-next-turn; the same threat with no
   * immediate gap is merely a shape to watch.
   */
  immediateGaps: Coord[];
  direction: DirectionName;
  /** All four cells of the window, ordered along `direction`. */
  window: Coord[];
}

/** Everything Easy mode needs to teach with. */
export interface ThreatReport {
  /** Every 2- and 3-in-a-row window on the board, both colors. */
  threats: Threat[];
  /** Columns where the player to move wins immediately by dropping. */
  winningMoves: number[];
  /** Columns the player to move must play to stop an immediate loss. */
  blockingMoves: number[];
  /**
   * Columns that hand the opponent a win on their next turn — the classic
   * "don't build them a staircase" mistake children make.
   */
  trapMoves: number[];
}

/**
 * The difficulty ladder, weakest first. Order is meaningful: tests assert that
 * each rung beats the one below it over seeded self-play, so a change that
 * accidentally makes a level weaker than its neighbour fails rather than ships.
 *
 * Five rungs rather than three because three left a cliff. The old `easy`
 * looked one ply ahead and covered a threat only 60% of the time; the old
 * `medium` searched seven plies and never missed a block or walked into a
 * one-move trap. There was nothing in between, so a player who found the first
 * trivial could not win a single game of the second.
 */
export const DIFFICULTIES = ['easy', 'steady', 'medium', 'hard', 'grandmaster'] as const;

export type Difficulty = (typeof DIFFICULTIES)[number];

/** What the AI decided, and enough context to explain it in Easy mode. */
export interface AiDecision {
  column: number;
  /** Positive favours the AI. In mate scores, magnitude encodes distance. */
  score: number;
  /** Plies searched on the deepest completed iteration. */
  depth: number;
  nodes: number;
  elapsedMs: number;
  /** Set when the search proved a forced result. */
  proven?: 'win' | 'loss' | 'draw';
  /** Principal variation as columns, best-first. */
  pv: number[];
}
