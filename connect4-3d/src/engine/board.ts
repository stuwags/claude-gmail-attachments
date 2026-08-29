/**
 * Connect Four board with cheap make/unmake, built on a split two-word bitboard.
 *
 * ---------------------------------------------------------------------------
 * REPRESENTATION CHOICE — measured, not guessed
 * ---------------------------------------------------------------------------
 * The standard Connect Four bitboard needs 7 columns x 7 bits (6 rows + one
 * sentinel row) = 49 bits. JavaScript's bitwise operators are int32, so the
 * three realistic options were benchmarked head to head under an *identical*
 * fixed-depth alpha-beta (same move ordering, same evaluation, verified to
 * visit exactly the same node counts and return the same scores):
 *
 *   Node 22.22.2, depth 14, four positions (empty + three random midgames)
 *
 *     representation                    nodes/sec        relative
 *     (a) BigInt bitboard             0.31 - 0.64 M        8-11x slower
 *     (b) split two-word Uint32       3.43 - 5.22 M        1.00x  <-- chosen
 *     (c) Int8Array + incremental     2.11 - 3.53 M        1.5-1.6x slower
 *
 *   e.g. the empty-board depth-14 run (959,054 nodes for all three):
 *     BigInt 3110.1 ms | Split32 279.3 ms | Int8Arr 455.6 ms
 *
 * (a) loses because every shift/and allocates a heap BigInt. (c) loses because
 * win detection walks up to 24 array slots per probe and cannot answer "which
 * empty squares complete a four?" in O(1) — an operation the evaluation leans
 * on heavily. So: (b), a split two-word Uint32 bitboard.
 *
 * ---------------------------------------------------------------------------
 * BIT LAYOUT
 * ---------------------------------------------------------------------------
 * Bit index of (col,row) is `col * 7 + row`, row 0 at the bottom, row 6 an
 * always-empty sentinel that stops vertical/diagonal shifts from wrapping
 * between columns. The 49 bits are split across two int32 words:
 *
 *     lo = global bits  0..27  (columns 0-3 in full: 4 * 7 = 28)
 *     hi = global bits 28..48  (columns 4-6, stored at hi bits 0..20)
 *
 * The split lands exactly on a column boundary, so a column never straddles
 * the two words. Right/left shifts across the boundary cost one extra shift
 * and one or two of `|` / `&` — see {@link shrLo} / {@link shlHi}.
 *
 * Following the usual Connect Four trick, the board stores the *side to move's*
 * discs (`#pLo/#pHi`) plus every occupied square (`#mLo/#mHi`); the opponent's
 * discs are `p ^ m`. Playing a move is `p ^= m; m |= bit`, undoing is
 * `m ^= bit; p ^= m`. Both are O(1) with no allocation.
 */

import {
  CELLS,
  COLS,
  DIRECTIONS,
  Player,
  ROWS,
  WIN_LENGTH,
  cellIndex,
  other,
  type Cell,
  type Coord,
  type DirectionName,
  type GameOutcome,
} from './types.ts';

/* -------------------------------------------------------------------------- */
/* bit plumbing                                                               */
/* -------------------------------------------------------------------------- */

/** Bits per column: the six playable rows plus one sentinel row. */
export const COLUMN_BITS = ROWS + 1; // 7
/** Global bit index at which the high word starts (a column boundary). */
export const SPLIT = 4 * COLUMN_BITS; // 28
/** Every bit the low word may hold. */
export const LO_MASK = (1 << SPLIT) - 1; // 0x0fffffff
/** Every bit the high word may hold. */
export const HI_MASK = (1 << (COLS * COLUMN_BITS - SPLIT)) - 1; // 0x001fffff

/** Low word of the 49-bit value `(lo,hi)` shifted right by `k` (1 <= k <= 27). */
export const shrLo = (lo: number, hi: number, k: number): number =>
  ((lo >>> k) | (hi << (SPLIT - k))) & LO_MASK;

/** Low word of `(lo,hi)` shifted left by `k` (1 <= k <= 27). */
export const shlLo = (lo: number, k: number): number => (lo << k) & LO_MASK;

/** High word of `(lo,hi)` shifted left by `k` (1 <= k <= 27). */
export const shlHi = (lo: number, hi: number, k: number): number =>
  ((hi << k) | (lo >>> (SPLIT - k))) & HI_MASK;

/** Low-word bit for `(col,row)`, or 0 when the cell lives in the high word. */
export const cellLo = (col: number, row: number): number => {
  const i = col * COLUMN_BITS + row;
  return i < SPLIT ? 1 << i : 0;
};

/** High-word bit for `(col,row)`, or 0 when the cell lives in the low word. */
export const cellHi = (col: number, row: number): number => {
  const i = col * COLUMN_BITS + row;
  return i >= SPLIT ? 1 << (i - SPLIT) : 0;
};

/** Population count of a non-negative int32. */
export const popcount = (x: number): number => {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

const buildMask = (pick: (col: number, row: number) => boolean): readonly [number, number] => {
  let lo = 0;
  let hi = 0;
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      if (!pick(c, r)) continue;
      lo |= cellLo(c, r);
      hi |= cellHi(c, r);
    }
  }
  return [lo, hi];
};

const [BOARD_LO_, BOARD_HI_] = buildMask(() => true);
/** Every playable square (sentinels excluded), low word. */
export const BOARD_LO = BOARD_LO_;
/** Every playable square (sentinels excluded), high word. */
export const BOARD_HI = BOARD_HI_;

const [BOTTOM_LO_, BOTTOM_HI_] = buildMask((_c, r) => r === 0);
/** The bottom cell of every column, low word. */
export const BOTTOM_LO = BOTTOM_LO_;
/** The bottom cell of every column, high word. */
export const BOTTOM_HI = BOTTOM_HI_;

/** Shift distances for horizontal / vertical / both diagonals. */
const S_VERT = 1;
const S_HORIZ = COLUMN_BITS; // 7
const S_DIAG_DOWN = COLUMN_BITS - 1; // 6  -> (col+1, row-1)
const S_DIAG_UP = COLUMN_BITS + 1; // 8  -> (col+1, row+1)

/**
 * Does the disc set `(lo,hi)` contain four in a row anywhere?
 *
 * Four in a row along shift `s` exists iff `x & (x>>s) & (x>>2s) & (x>>3s)`,
 * computed here as two paired shifts. The sentinel row guarantees a run can
 * never wrap from the top of one column into the bottom of the next.
 */
export function winsIn(lo: number, hi: number): boolean {
  let al = lo & shrLo(lo, hi, S_VERT);
  let ah = hi & (hi >>> S_VERT);
  if (((al & shrLo(al, ah, 2 * S_VERT)) | (ah & (ah >>> (2 * S_VERT)))) !== 0) return true;

  al = lo & shrLo(lo, hi, S_HORIZ);
  ah = hi & (hi >>> S_HORIZ);
  if (((al & shrLo(al, ah, 2 * S_HORIZ)) | (ah & (ah >>> (2 * S_HORIZ)))) !== 0) return true;

  al = lo & shrLo(lo, hi, S_DIAG_UP);
  ah = hi & (hi >>> S_DIAG_UP);
  if (((al & shrLo(al, ah, 2 * S_DIAG_UP)) | (ah & (ah >>> (2 * S_DIAG_UP)))) !== 0) return true;

  al = lo & shrLo(lo, hi, S_DIAG_DOWN);
  ah = hi & (hi >>> S_DIAG_DOWN);
  if (((al & shrLo(al, ah, 2 * S_DIAG_DOWN)) | (ah & (ah >>> (2 * S_DIAG_DOWN)))) !== 0) return true;

  return false;
}

/** Accumulate, into `out`, the squares that complete a four along one shift. */
function winningAlong(lo: number, hi: number, s: number, out: Int32Array): void {
  // xxx_  (three below/left of the square)
  let rLo = shlLo(lo, s) & shlLo(lo, 2 * s) & shlLo(lo, 3 * s);
  let rHi = shlHi(lo, hi, s) & shlHi(lo, hi, 2 * s) & shlHi(lo, hi, 3 * s);

  // xx_x and x_xx  (gap in the middle)
  let pLo = shlLo(lo, s) & shlLo(lo, 2 * s);
  let pHi = shlHi(lo, hi, s) & shlHi(lo, hi, 2 * s);
  rLo |= pLo & shrLo(lo, hi, s);
  rHi |= pHi & (hi >>> s);

  pLo = shrLo(lo, hi, s) & shrLo(lo, hi, 2 * s);
  pHi = (hi >>> s) & (hi >>> (2 * s));
  rLo |= pLo & shlLo(lo, s);
  rHi |= pHi & shlHi(lo, hi, s);

  // _xxx  (three above/right of the square)
  rLo |= pLo & shrLo(lo, hi, 3 * s);
  rHi |= pHi & (hi >>> (3 * s));

  out[0] |= rLo;
  out[1] |= rHi;
}

/**
 * Every EMPTY square at which `(lo,hi)` would complete a four, written into
 * `out` as `[lo, hi]`. Includes buried squares that are not playable yet —
 * that is exactly what the odd/even parity evaluation needs.
 *
 * `out` must be an `Int32Array` of length >= 2; it is overwritten, never read.
 */
export function computeWinningSquares(
  lo: number,
  hi: number,
  occLo: number,
  occHi: number,
  out: Int32Array,
): void {
  out[0] = 0;
  out[1] = 0;
  winningAlong(lo, hi, S_VERT, out);
  winningAlong(lo, hi, S_HORIZ, out);
  winningAlong(lo, hi, S_DIAG_UP, out);
  winningAlong(lo, hi, S_DIAG_DOWN, out);
  out[0] &= BOARD_LO & ~occLo;
  out[1] &= BOARD_HI & ~occHi;
}

/* -------------------------------------------------------------------------- */
/* the 69 four-in-a-row windows                                               */
/* -------------------------------------------------------------------------- */

/** One of the 69 places a four can sit, with its cells ordered along `direction`. */
export interface WindowSpec {
  readonly cells: Coord[];
  readonly direction: DirectionName;
}

/**
 * All 69 windows: 24 horizontal, 21 vertical, 12 up-diagonal, 12 down-diagonal.
 * Generated in `DIRECTIONS` order, then column ascending, then row ascending.
 * Shared and frozen — treat the coordinates as read-only constants.
 */
export const WINDOWS: readonly WindowSpec[] = (() => {
  const all: WindowSpec[] = [];
  for (const dir of DIRECTIONS) {
    for (let c = 0; c < COLS; c++) {
      for (let r = 0; r < ROWS; r++) {
        const endC = c + dir.dc * (WIN_LENGTH - 1);
        const endR = r + dir.dr * (WIN_LENGTH - 1);
        if (endC < 0 || endC >= COLS || endR < 0 || endR >= ROWS) continue;
        const cells: Coord[] = [];
        for (let k = 0; k < WIN_LENGTH; k++) {
          cells.push(Object.freeze({ col: c + dir.dc * k, row: r + dir.dr * k }));
        }
        all.push(Object.freeze({ cells: Object.freeze(cells) as Coord[], direction: dir.name }));
      }
    }
  }
  return Object.freeze(all);
})();

/* -------------------------------------------------------------------------- */
/* Board                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A Connect Four position.
 *
 * Mutable by design: `play` / `undo` are the search's inner loop and allocate
 * nothing. `undo()` restores every field exactly, so `toKey()` round-trips.
 */
export class Board {
  /** Discs belonging to the side to move. */
  #pLo = 0;
  #pHi = 0;
  /** Every occupied square. */
  #mLo = 0;
  #mHi = 0;
  readonly #heights = new Int8Array(COLS);
  #hist: number[] = [];

  /** Replay a list of columns, throwing on the first illegal one. */
  static fromMoves(cols: number[]): Board {
    const b = new Board();
    for (const c of cols) b.play(c);
    return b;
  }

  /** An independent copy; mutating either board leaves the other alone. */
  clone(): Board {
    const b = new Board();
    b.#pLo = this.#pLo;
    b.#pHi = this.#pHi;
    b.#mLo = this.#mLo;
    b.#mHi = this.#mHi;
    b.#heights.set(this.#heights);
    b.#hist = this.#hist.slice();
    return b;
  }

  /** Whose turn it is. Player One always moves first. */
  get toMove(): Player {
    return (this.#hist.length & 1) === 0 ? Player.One : Player.Two;
  }

  /** How many discs are on the board. */
  get moveCount(): number {
    return this.#hist.length;
  }

  /** The columns played so far, in order. A fresh copy on every read. */
  get history(): number[] {
    return this.#hist.slice();
  }

  /** How many discs are stacked in `col` (0..ROWS). Off-board reads as full. */
  heightOf(col: number): number {
    return col >= 0 && col < COLS ? this.#heights[col] : ROWS;
  }

  /** Is `col` a legal move right now? */
  canPlay(col: number): boolean {
    return col >= 0 && col < COLS && this.#heights[col] < ROWS;
  }

  /** Every legal column, ascending. */
  legalMoves(): number[] {
    const out: number[] = [];
    for (let c = 0; c < COLS; c++) if (this.#heights[c] < ROWS) out.push(c);
    return out;
  }

  /** Who occupies `(col,row)`, or `null` when it is empty or off-board. */
  get(col: number, row: number): Cell {
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return null;
    const lo = cellLo(col, row);
    const hi = cellHi(col, row);
    if (((this.#mLo & lo) | (this.#mHi & hi)) === 0) return null;
    return ((this.#pLo & lo) | (this.#pHi & hi)) !== 0 ? this.toMove : other(this.toMove);
  }

  /** Flat snapshot indexed by `cellIndex(col,row)`. */
  cells(): Cell[] {
    const out: Cell[] = new Array<Cell>(CELLS);
    for (let c = 0; c < COLS; c++) {
      for (let r = 0; r < ROWS; r++) out[cellIndex(c, r)] = this.get(c, r);
    }
    return out;
  }

  /** Drop a disc into `col`. Returns the row it landed in. Throws if illegal. */
  play(col: number): number {
    if (!Number.isInteger(col) || col < 0 || col >= COLS) {
      throw new RangeError(`Board.play: column ${String(col)} is outside 0..${COLS - 1}`);
    }
    const row = this.#heights[col];
    if (row >= ROWS) throw new Error(`Board.play: column ${col} is full`);

    // Hand the position over to the opponent, then add the new disc.
    const nextLo = this.#pLo ^ this.#mLo;
    const nextHi = this.#pHi ^ this.#mHi;
    this.#mLo |= cellLo(col, row);
    this.#mHi |= cellHi(col, row);
    this.#pLo = nextLo;
    this.#pHi = nextHi;

    this.#heights[col] = row + 1;
    this.#hist.push(col);
    return row;
  }

  /** Take back the last move, restoring every field exactly. */
  undo(): void {
    const col = this.#hist.pop();
    if (col === undefined) throw new Error('Board.undo: no moves to undo');
    const row = this.#heights[col] - 1;
    this.#heights[col] = row;
    this.#mLo &= ~cellLo(col, row);
    this.#mHi &= ~cellHi(col, row);
    this.#pLo ^= this.#mLo;
    this.#pHi ^= this.#mHi;
  }

  /* --- win / outcome ------------------------------------------------------ */

  /** Low word of `player`'s discs. Search plumbing; prefer {@link get}. */
  bitsLo(player: Player): number {
    return player === this.toMove ? this.#pLo : this.#pLo ^ this.#mLo;
  }

  /** High word of `player`'s discs. Search plumbing; prefer {@link get}. */
  bitsHi(player: Player): number {
    return player === this.toMove ? this.#pHi : this.#pHi ^ this.#mHi;
  }

  /** Low word of the side-to-move's discs. Search plumbing. */
  get moverLo(): number {
    return this.#pLo;
  }

  /** High word of the side-to-move's discs. Search plumbing. */
  get moverHi(): number {
    return this.#pHi;
  }

  /** Low word of every occupied square. Search plumbing. */
  get occupiedLo(): number {
    return this.#mLo;
  }

  /** High word of every occupied square. Search plumbing. */
  get occupiedHi(): number {
    return this.#mHi;
  }

  /**
   * Low word of the canonical position key (`discs + occupied + bottom`). The
   * pair `(keyLo, keyHi)` identifies a position and its side to move uniquely,
   * which is what the transposition table verifies against. Never zero.
   */
  get keyLo(): number {
    return this.#pLo + this.#mLo + BOTTOM_LO;
  }

  /** High word of the canonical position key. Never zero. */
  get keyHi(): number {
    return this.#pHi + this.#mHi + BOTTOM_HI;
  }

  /**
   * Bit `c` is set iff `player` dropping into column `c` completes a four
   * *right now*. Columns that are full, or that would only extend a four the
   * player already had, are never reported.
   */
  winningMoveMask(player: Player): number {
    const lo = this.bitsLo(player);
    const hi = this.bitsHi(player);
    if (winsIn(lo, hi)) return 0; // already won: no move "wins now"
    let mask = 0;
    for (let c = 0; c < COLS; c++) {
      const r = this.#heights[c];
      if (r >= ROWS) continue;
      if (winsIn(lo | cellLo(c, r), hi | cellHi(c, r))) mask |= 1 << c;
    }
    return mask;
  }

  /** Would dropping a `player` disc into `col` win immediately? */
  isWinningMove(col: number, player: Player): boolean {
    if (!this.canPlay(col)) return false;
    return ((this.winningMoveMask(player) >>> col) & 1) === 1;
  }

  /**
   * How the game stands. On a win the returned `line` holds the four winning
   * cells ordered along `direction`; when a move completes more than one four
   * the first window found (in `DIRECTIONS` order) is reported.
   */
  outcome(): GameOutcome {
    // A legal game has at most one winner, but check the player who just moved
    // first so a hand-built oddity still reports the sensible one.
    const justMoved = other(this.toMove);
    for (const winner of [justMoved, this.toMove] as const) {
      if (!winsIn(this.bitsLo(winner), this.bitsHi(winner))) continue;
      for (const spec of WINDOWS) {
        const cells = spec.cells;
        if (
          this.get(cells[0].col, cells[0].row) === winner &&
          this.get(cells[1].col, cells[1].row) === winner &&
          this.get(cells[2].col, cells[2].row) === winner &&
          this.get(cells[3].col, cells[3].row) === winner
        ) {
          return {
            kind: 'win',
            winner,
            line: cells.map((p) => ({ col: p.col, row: p.row })),
            direction: spec.direction,
          };
        }
      }
    }
    if (this.#hist.length >= CELLS) return { kind: 'draw' };
    return { kind: 'ongoing' };
  }

  /* --- serialization ------------------------------------------------------ */

  /**
   * A short canonical string for this exact position *and* side to move.
   * Two boards share a key iff they are the same position; a board that has
   * been played and fully undone matches a fresh `new Board()`.
   */
  toKey(): string {
    return `${this.keyLo.toString(36)}.${this.keyHi.toString(36)}`;
  }

  /** Human-readable grid, top row first. Debugging aid, not a format. */
  toString(): string {
    const lines: string[] = [];
    for (let r = ROWS - 1; r >= 0; r--) {
      let line = '';
      for (let c = 0; c < COLS; c++) {
        const v = this.get(c, r);
        line += v === null ? '.' : v === Player.One ? 'x' : 'o';
      }
      lines.push(line);
    }
    lines.push('0123456');
    return lines.join('\n');
  }
}
