/**
 * Threat analysis — the data behind Easy mode's teaching overlay.
 *
 * Everything here is deliberately written for clarity over speed: `analyze()`
 * runs once per move, not once per search node, and the numbers it produces
 * end up on screen in front of a child. The search has its own bitboard fast
 * paths in `ai.ts`.
 *
 * A window (one of the 69 places four discs can sit) counts as a threat only
 * when it holds exactly 2 or exactly 3 discs of ONE player and none of the
 * other's. A window containing both colours is dead — nobody can ever fill it
 * — and is never reported.
 */

import { Board, WINDOWS } from './board.ts';
import {
  COLS,
  DIRECTIONS,
  Player,
  cellIndex,
  other,
  type Coord,
  type Threat,
  type ThreatReport,
} from './types.ts';

/** Rank of each direction name, used to keep `threats` ordering stable. */
const DIRECTION_RANK: Record<string, number> = (() => {
  const rank: Record<string, number> = {};
  DIRECTIONS.forEach((d, i) => {
    rank[d.name] = i;
  });
  return rank;
})();

const WINDOW_CELLS: readonly Coord[][] = WINDOWS.map((w) => w.cells);

/**
 * The 69 four-in-a-row windows on a 7x6 grid: 24 horizontal, 21 vertical,
 * 12 up-diagonal, 12 down-diagonal. Each window's cells are ordered along its
 * direction. The arrays are shared and frozen — do not mutate them.
 */
export function windows(): readonly Coord[][] {
  return WINDOW_CELLS;
}

/** Columns encoded in a 7-bit mask, ascending. */
function columnsOf(mask: number): number[] {
  const out: number[] = [];
  for (let c = 0; c < COLS; c++) if (((mask >>> c) & 1) === 1) out.push(c);
  return out;
}

const copy = (p: Coord): Coord => ({ col: p.col, row: p.row });

/**
 * Read every teachable fact out of a position: the live 2- and 3-in-a-row
 * shapes for both colours, the immediate wins, the immediate blocks, and the
 * moves that hand the opponent a win.
 *
 * `threats` is sorted deterministically — count descending, then owner, then
 * direction (in `DIRECTIONS` order), then first cell — so an overlay drawn
 * from it does not flicker between frames.
 */
export function analyze(board: Board): ThreatReport {
  const mover = board.toMove;
  const opponent = other(mover);

  /* --- 2- and 3-in-a-row windows ----------------------------------------- */

  const threats: Threat[] = [];
  for (const spec of WINDOWS) {
    let ownerCount = 0;
    let owner: Player | null = null;
    let mixed = false;
    for (const cell of spec.cells) {
      const v = board.get(cell.col, cell.row);
      if (v === null) continue;
      if (owner === null) owner = v;
      else if (owner !== v) {
        mixed = true;
        break;
      }
      ownerCount++;
    }
    // Dead (both colours), empty, or already four: not a threat.
    if (mixed || owner === null || ownerCount < 2 || ownerCount > 3) continue;

    const filled: Coord[] = [];
    const gaps: Coord[] = [];
    const immediateGaps: Coord[] = [];
    for (const cell of spec.cells) {
      if (board.get(cell.col, cell.row) === owner) {
        filled.push(copy(cell));
      } else {
        gaps.push(copy(cell));
        // A disc dropped now lands exactly on the current height of its column.
        if (cell.row === board.heightOf(cell.col)) immediateGaps.push(copy(cell));
      }
    }

    threats.push({
      owner,
      count: ownerCount as 2 | 3,
      filled,
      gaps,
      immediateGaps,
      direction: spec.direction,
      window: spec.cells.map(copy),
    });
  }

  threats.sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count; // 3s before 2s
    if (a.owner !== b.owner) return a.owner - b.owner; // Player One first
    const da = DIRECTION_RANK[a.direction];
    const db = DIRECTION_RANK[b.direction];
    if (da !== db) return da - db;
    return (
      cellIndex(a.window[0].col, a.window[0].row) - cellIndex(b.window[0].col, b.window[0].row)
    );
  });

  /* --- immediate wins and blocks ----------------------------------------- */

  const winningMoves = columnsOf(board.winningMoveMask(mover));
  // Columns the opponent would win in if it were their turn: the mover has to
  // cover them. Reported accurately even when the mover has a win of their own
  // — the UI decides which to emphasise.
  const blockingMoves = columnsOf(board.winningMoveMask(opponent));

  /* --- traps -------------------------------------------------------------- */

  // A trap is a legal move that lets the opponent win on the very next turn.
  // Computed honestly: make the move, ask whether the opponent now has an
  // immediate win, take it back. Own winning moves are never traps. Worked on
  // a clone so the caller's board is never touched, even transiently.
  const trapMoves: number[] = [];
  const winSet = new Set(winningMoves);
  const probe = board.clone();
  for (let c = 0; c < COLS; c++) {
    if (!probe.canPlay(c) || winSet.has(c)) continue;
    probe.play(c);
    const opponentReplies = probe.winningMoveMask(probe.toMove);
    probe.undo();
    if (opponentReplies !== 0) trapMoves.push(c);
  }

  return { threats, winningMoves, blockingMoves, trapMoves };
}
