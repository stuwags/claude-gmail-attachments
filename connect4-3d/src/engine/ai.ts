/**
 * Search and difficulty tiers.
 *
 * Negamax + alpha-beta, iterative deepening, a bounded replace-by-depth
 * transposition table keyed on the board's exact 49-bit position key (so
 * probes are verified, never hashed-and-hoped), two killer moves per ply, and
 * a per-side history heuristic. Move ordering starts centre-out and is then
 * improved by the TT move and the killers.
 *
 * Three Connect Four specific shortcuts do most of the heavy lifting:
 *   - if the side to move has an immediate four, return the mate at once;
 *   - if the opponent has two *separate* immediate fours, the position is
 *     lost, because only one of them can be covered;
 *   - never consider a drop that lets the opponent complete a four on the
 *     square directly above it. If every move is like that, the position is
 *     lost. (Provably losing moves, so excluding them is sound.)
 *
 * All state below is module scoped and reused between calls: `chooseMove` is
 * synchronous and not reentrant. The transposition table deliberately survives
 * across calls — Connect Four is a pure game, so an entry stays valid for the
 * rest of the match.
 */

import {
  Board,
  COLUMN_BITS,
  SPLIT,
  cellHi,
  cellLo,
  computeWinningSquares,
  popcount,
  shrLo,
} from './board.ts';
import {
  CELLS,
  COLS,
  Player,
  ROWS,
  other,
  type AiDecision,
  type Difficulty,
} from './types.ts';

export interface SearchOptions {
  difficulty: Difficulty;
  /** Wall-clock budget for the search. Defaults per difficulty (grandmaster: 900ms). */
  timeBudgetMs?: number;
  /** Source of randomness. Defaults to `Math.random`; seed it to reproduce games. */
  rng?: () => number;
}

/* -------------------------------------------------------------------------- */
/* constants and scratch state                                                */
/* -------------------------------------------------------------------------- */

const nowMs: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now();

/** Score of a win on the move. A win `n` plies away scores `MATE - n`. */
const MATE = 1_000_000;
/** Any |score| at or above this is a forced result, not an evaluation. */
const MATE_THRESHOLD = MATE - 100;
const INF = 1 << 30;
/** Deepest ply the search can reach, plus headroom for the buffers. */
const MAX_PLY = 48;

const TT_BITS = 18;
const TT_SIZE = 1 << TT_BITS;
const TT_FLAG_EXACT = 0;
const TT_FLAG_LOWER = 1;
const TT_FLAG_UPPER = 2;

const ttKeyLo = new Int32Array(TT_SIZE);
const ttKeyHi = new Int32Array(TT_SIZE);
const ttScore = new Int32Array(TT_SIZE);
/** depth (6 bits) | flag (2 bits) | move+1 (4 bits) | generation (8 bits) */
const ttMeta = new Int32Array(TT_SIZE);
/**
 * Bumped once per search. Replace-by-depth alone would let a long session silt
 * the table up with deep entries that newer, shallower searches can never
 * displace; an entry from an older generation is always fair game.
 */
let generation = 0;

const killers = new Int32Array(MAX_PLY * 2);
const historyHeur = new Int32Array(2 * COLS);
const moveBuf = new Int32Array(MAX_PLY * COLS);
const scoreBuf = new Int32Array(MAX_PLY * COLS);
const pvTable = new Int32Array(MAX_PLY * MAX_PLY);
const pvLen = new Int32Array(MAX_PLY);
const scratchMe = new Int32Array(2);
const scratchOp = new Int32Array(2);

/** Thrown to unwind out of a search that has run out of time. */
const ABORT = { searchAborted: true };

let nodes = 0;
let deadline = Infinity;

/** Columns from the middle outwards — the baseline move order. */
const CENTRE_ORDER: readonly number[] = [3, 2, 4, 1, 5, 0, 6];
/** Ordering bonus per column, mirroring CENTRE_ORDER. */
const ORDER_BONUS: readonly number[] = [0, 20, 40, 60, 40, 20, 0];

const COL_LO = new Int32Array(COLS);
const COL_HI = new Int32Array(COLS);
for (let c = 0; c < COLS; c++) {
  for (let r = 0; r < ROWS; r++) {
    COL_LO[c] |= cellLo(c, r);
    COL_HI[c] |= cellHi(c, r);
  }
}

/* -------------------------------------------------------------------------- */
/* evaluation                                                                 */
/* -------------------------------------------------------------------------- */

/** Value of holding a square, by column: the centre is worth far more. */
const COLUMN_VALUE: readonly number[] = [3, 9, 21, 36, 21, 9, 3];
/** Base worth of one square at which a player would complete a four. */
const W_THREAT = 18;
/** Bonus when a threat sits on the row parity that favours its owner. */
const W_PARITY_GOOD = 22;
/** Penalty when it sits on the parity that favours the other player. */
const W_PARITY_BAD = -6;
/** Bonus for a threat square a disc would land on this very turn. */
const W_PLAYABLE = 46;
/** Penalty per empty row between a threat square and the current stack top. */
const W_BURIED = -4;
const W_PAIR_LINE = 5;
const W_PAIR_VERT = 2;
/** Having the move is worth a little. */
const W_TEMPO = 8;

/** Worth of one square at which `owner` would complete a four. */
function threatSquareValue(board: Board, owner: Player, col: number, row: number): number {
  let v = W_THREAT;
  // Classic Connect Four parity: with 42 squares and Player One moving first,
  // Player One profits from threats on odd-numbered rows (indices 0, 2, 4) and
  // Player Two from threats on even-numbered rows (indices 1, 3, 5). This is
  // the zugzwang that decides most well-played games.
  const favoured = (row & 1) === 0 ? Player.One : Player.Two;
  v += owner === favoured ? W_PARITY_GOOD : W_PARITY_BAD;
  const height = board.heightOf(col);
  // Playable right now beats buried under four empty squares.
  if (row === height) v += W_PLAYABLE;
  else v += W_BURIED * Math.min(row - height, 4);
  return v;
}

function threatTerm(board: Board, owner: Player, lo: number, hi: number): number {
  let total = 0;
  let m = lo;
  while (m !== 0) {
    const bit = m & -m;
    const i = 31 - Math.clz32(bit);
    m ^= bit;
    total += threatSquareValue(board, owner, (i / COLUMN_BITS) | 0, i % COLUMN_BITS);
  }
  m = hi;
  while (m !== 0) {
    const bit = m & -m;
    const i = 31 - Math.clz32(bit) + SPLIT;
    m ^= bit;
    total += threatSquareValue(board, owner, (i / COLUMN_BITS) | 0, i % COLUMN_BITS);
  }
  return total;
}

/** Adjacent same-colour pairs, as a smooth early-game signal. */
function pairTerm(lo: number, hi: number): number {
  let al = lo & shrLo(lo, hi, 1);
  let ah = hi & (hi >>> 1);
  let total = W_PAIR_VERT * (popcount(al) + popcount(ah));
  for (const s of [COLUMN_BITS, COLUMN_BITS + 1, COLUMN_BITS - 1]) {
    al = lo & shrLo(lo, hi, s);
    ah = hi & (hi >>> s);
    total += W_PAIR_LINE * (popcount(al) + popcount(ah));
  }
  return total;
}

function centreTerm(lo: number, hi: number): number {
  let total = 0;
  for (let c = 0; c < COLS; c++) {
    total += COLUMN_VALUE[c] * (popcount(lo & COL_LO[c]) + popcount(hi & COL_HI[c]));
  }
  return total;
}

/**
 * Static evaluation, from the side to move's point of view. Never returns a
 * magnitude that could be mistaken for a mate score.
 */
export function evaluate(board: Board): number {
  const meLo = board.moverLo;
  const meHi = board.moverHi;
  const occLo = board.occupiedLo;
  const occHi = board.occupiedHi;
  const opLo = meLo ^ occLo;
  const opHi = meHi ^ occHi;
  const me = board.toMove;

  computeWinningSquares(meLo, meHi, occLo, occHi, scratchMe);
  computeWinningSquares(opLo, opHi, occLo, occHi, scratchOp);

  let s = W_TEMPO;
  s += threatTerm(board, me, scratchMe[0], scratchMe[1]);
  s -= threatTerm(board, other(me), scratchOp[0], scratchOp[1]);
  s += centreTerm(meLo, meHi) - centreTerm(opLo, opHi);
  s += pairTerm(meLo, meHi) - pairTerm(opLo, opHi);

  const cap = MATE_THRESHOLD - 1;
  return s > cap ? cap : s < -cap ? -cap : s;
}

/* -------------------------------------------------------------------------- */
/* transposition table                                                        */
/* -------------------------------------------------------------------------- */

const ttIndex = (keyLo: number, keyHi: number): number =>
  (Math.imul(keyLo, 0x9e3779b1) ^ Math.imul(keyHi, 0x85ebca6b)) >>> (32 - TT_BITS);

/** Mate scores are stored relative to the node, not the root. */
const toTT = (s: number, ply: number): number =>
  s >= MATE_THRESHOLD ? s + ply : s <= -MATE_THRESHOLD ? s - ply : s;
const fromTT = (s: number, ply: number): number =>
  s >= MATE_THRESHOLD ? s - ply : s <= -MATE_THRESHOLD ? s + ply : s;

/** Forget everything learned so far. Exposed for tests and for a fresh match. */
export function clearTranspositionTable(): void {
  ttKeyLo.fill(0);
  ttKeyHi.fill(0);
  ttScore.fill(0);
  ttMeta.fill(0);
  generation = 0;
}

function bumpHistory(slot: number, depth: number): void {
  historyHeur[slot] += depth * depth;
  if (historyHeur[slot] > 1 << 19) {
    for (let i = 0; i < historyHeur.length; i++) historyHeur[i] >>= 1;
  }
}

/** Lowest column set in a 7-bit column mask. */
function firstColumn(mask: number): number {
  return 31 - Math.clz32(mask & -mask);
}

/** The most central column set in a 7-bit column mask, or -1 if empty. */
function centreMost(mask: number): number {
  for (const c of CENTRE_ORDER) if (((mask >>> c) & 1) === 1) return c;
  return -1;
}

/* -------------------------------------------------------------------------- */
/* negamax                                                                    */
/* -------------------------------------------------------------------------- */

function negamax(board: Board, depth: number, alphaIn: number, beta: number, ply: number): number {
  nodes++;
  if ((nodes & 1023) === 0 && nowMs() >= deadline) throw ABORT;
  pvLen[ply] = 0;

  if (board.moveCount >= CELLS) return 0; // full board, nobody won

  const me = board.toMove;
  const op = other(me);

  // We win on the spot.
  const myWins = board.winningMoveMask(me);
  if (myWins !== 0) {
    const c = firstColumn(myWins);
    pvTable[ply * MAX_PLY] = c;
    pvLen[ply] = 1;
    return MATE - (ply + 1);
  }

  // Two separate threats against us and no win of our own: lost.
  const opWins = board.winningMoveMask(op);
  if ((opWins & (opWins - 1)) !== 0) return -(MATE - (ply + 2));

  if (depth <= 0) return evaluate(board);

  let alpha = alphaIn;
  const keyLo = board.keyLo;
  const keyHi = board.keyHi;
  const idx = ttIndex(keyLo, keyHi);
  let ttMove = -1;
  if (ttKeyLo[idx] === keyLo && ttKeyHi[idx] === keyHi) {
    const meta = ttMeta[idx];
    ttMove = ((meta >>> 8) & 15) - 1;
    if ((meta & 63) >= depth) {
      const s = fromTT(ttScore[idx], ply);
      const flag = (meta >>> 6) & 3;
      if (flag === TT_FLAG_EXACT) return s;
      if (flag === TT_FLAG_LOWER && s >= beta) return s;
      if (flag === TT_FLAG_UPPER && s <= alpha) return s;
    }
  }

  // ---- candidate moves --------------------------------------------------
  let candidates: number;
  if (opWins !== 0) {
    // Exactly one immediate threat (two were handled above): we must cover it.
    candidates = opWins;
  } else {
    computeWinningSquares(
      board.bitsLo(op),
      board.bitsHi(op),
      board.occupiedLo,
      board.occupiedHi,
      scratchOp,
    );
    const threatLo = scratchOp[0];
    const threatHi = scratchOp[1];
    candidates = 0;
    for (let c = 0; c < COLS; c++) {
      const r = board.heightOf(c);
      if (r >= ROWS) continue;
      // Dropping here would let the opponent complete a four straight on top.
      if (
        r + 1 < ROWS &&
        ((threatLo & cellLo(c, r + 1)) | (threatHi & cellHi(c, r + 1))) !== 0
      ) {
        continue;
      }
      candidates |= 1 << c;
    }
    if (candidates === 0) return -(MATE - (ply + 2)); // every move loses
  }

  // ---- ordering ---------------------------------------------------------
  const base = ply * COLS;
  const k0 = killers[ply * 2];
  const k1 = killers[ply * 2 + 1];
  const histBase = me * COLS;
  let n = 0;
  for (let c = 0; c < COLS; c++) {
    if (((candidates >>> c) & 1) === 0) continue;
    let s = ORDER_BONUS[c] + historyHeur[histBase + c];
    if (c === ttMove) s += 1 << 24;
    else if (c === k0) s += 1 << 22;
    else if (c === k1) s += 1 << 21;
    moveBuf[base + n] = c;
    scoreBuf[base + n] = s;
    n++;
  }
  for (let i = 1; i < n; i++) {
    const mv = moveBuf[base + i];
    const sc = scoreBuf[base + i];
    let j = i - 1;
    while (j >= 0 && scoreBuf[base + j] < sc) {
      moveBuf[base + j + 1] = moveBuf[base + j];
      scoreBuf[base + j + 1] = scoreBuf[base + j];
      j--;
    }
    moveBuf[base + j + 1] = mv;
    scoreBuf[base + j + 1] = sc;
  }

  // ---- search -----------------------------------------------------------
  let best = -INF;
  let bestMove = moveBuf[base];
  let flag = TT_FLAG_UPPER;
  for (let i = 0; i < n; i++) {
    const c = moveBuf[base + i];
    board.play(c);
    const v = -negamax(board, depth - 1, -beta, -alpha, ply + 1);
    board.undo();
    if (v > best) {
      best = v;
      bestMove = c;
      if (v > alpha) {
        alpha = v;
        flag = TT_FLAG_EXACT;
        pvTable[ply * MAX_PLY] = c;
        const copyLen = Math.min(pvLen[ply + 1], MAX_PLY - 1);
        const src = (ply + 1) * MAX_PLY;
        const dst = ply * MAX_PLY + 1;
        for (let k = 0; k < copyLen; k++) pvTable[dst + k] = pvTable[src + k];
        pvLen[ply] = copyLen + 1;
        if (alpha >= beta) {
          flag = TT_FLAG_LOWER;
          if (killers[ply * 2] !== c) {
            killers[ply * 2 + 1] = killers[ply * 2];
            killers[ply * 2] = c;
          }
          bumpHistory(histBase + c, depth);
          break;
        }
      }
    }
  }

  const occupied = ttKeyLo[idx];
  if (
    occupied === 0 ||
    (occupied === keyLo && ttKeyHi[idx] === keyHi) ||
    ((ttMeta[idx] >>> 12) & 255) !== generation ||
    (ttMeta[idx] & 63) <= depth
  ) {
    ttKeyLo[idx] = keyLo;
    ttKeyHi[idx] = keyHi;
    ttScore[idx] = toTT(best, ply);
    ttMeta[idx] =
      (depth & 63) | (flag << 6) | (((bestMove + 1) & 15) << 8) | (generation << 12);
  }
  return best;
}

/* -------------------------------------------------------------------------- */
/* root                                                                       */
/* -------------------------------------------------------------------------- */

interface RootResult {
  move: number;
  score: number;
  /** Plies of the deepest iteration that finished. */
  depth: number;
  nodes: number;
  pv: number[];
  /** Score per column; `-INF` for illegal columns. */
  scores: number[];
}

interface Iteration {
  move: number;
  score: number;
  pv: number[];
  scores: number[];
  order: number[];
}

function rootIteration(
  board: Board,
  depth: number,
  order: readonly number[],
  exactScores: boolean,
): Iteration {
  let alpha = -INF;
  let bestMove = order[0];
  let bestScore = -INF;
  const scores: number[] = new Array<number>(COLS).fill(-INF);
  const pv: number[] = [];

  for (const c of order) {
    board.play(c);
    const v = -negamax(board, depth - 1, -INF, exactScores ? INF : -alpha, 1);
    board.undo();
    scores[c] = v;
    if (v > bestScore) {
      bestScore = v;
      bestMove = c;
      pv.length = 0;
      pv.push(c);
      for (let k = 0; k < pvLen[1]; k++) pv.push(pvTable[MAX_PLY + k]);
      if (!exactScores && v > alpha) alpha = v;
    }
  }

  // Best-first for the next, deeper iteration; ties keep the previous
  // (centre-out) order, so the whole thing stays deterministic.
  const next = order.slice().sort((x, y) => scores[y] - scores[x]);
  return { move: bestMove, score: bestScore, pv, scores, order: next };
}

/**
 * Iterative deepening from the root. Depth 1 always completes; every deeper
 * iteration is abandoned wholesale if the clock runs out, so the returned move
 * always comes from a fully searched iteration.
 */
function searchRoot(
  board: Board,
  maxDepth: number,
  budgetMs: number,
  exactScores: boolean,
): RootResult {
  nodes = 0;
  generation = (generation + 1) & 255;
  killers.fill(-1);
  historyHeur.fill(0);
  deadline = Infinity;
  const started = nowMs();
  // Aborting unwinds through negamax's recursion, skipping its `undo()` calls,
  // so the board has to be rewound to where the caller left it.
  const baseline = board.moveCount;

  const limit = Math.min(maxDepth, CELLS - board.moveCount);
  let order = board
    .legalMoves()
    .sort((x, y) => Math.abs(3 - x) - Math.abs(3 - y) || x - y);

  let bestMove = order[0];
  let bestScore = 0;
  let bestPv: number[] = [bestMove];
  let scores: number[] = new Array<number>(COLS).fill(-INF);
  let completed = 0;

  try {
    for (let d = 1; d <= limit; d++) {
      // Depth 1 is unabortable so there is always a completed iteration to use.
      if (d === 2) deadline = started + budgetMs;
      if (d > 1 && nowMs() >= deadline) break;
      try {
        const iter = rootIteration(board, d, order, exactScores);
        completed = d;
        bestMove = iter.move;
        bestScore = iter.score;
        bestPv = iter.pv;
        scores = iter.scores;
        order = iter.order;
      } catch (e) {
        if (e !== ABORT) throw e;
        break; // the whole iteration is discarded, not half-used
      }
      // A forced result cannot improve with more depth.
      if (bestScore >= MATE_THRESHOLD || bestScore <= -MATE_THRESHOLD) break;
    }
  } finally {
    while (board.moveCount > baseline) board.undo();
    deadline = Infinity;
  }

  return { move: bestMove, score: bestScore, depth: completed, nodes, pv: bestPv, scores };
}

/* -------------------------------------------------------------------------- */
/* the difficulty ladder                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One rung's tuning. Every rung runs the same chooser, {@link choose}; only
 * these numbers differ. That is deliberate: when the rungs were separate
 * functions they drifted apart along axes nobody had chosen, and the ladder
 * ended up with a cliff in the middle of it.
 */
interface Tier {
  /**
   * Plies of search. 0 means no search at all: each drop is judged by a single
   * static evaluation of the position it leaves behind, which sees threats
   * already on the board but nothing the opponent might do about them.
   */
  plies: number;
  /**
   * How often an immediate threat actually gets covered. Below 1 the rung
   * sometimes looks somewhere else entirely — the single most visible
   * difference between a beginner and an opponent worth beating. At 1 no
   * special case is needed: a move that leaves a four standing comes back from
   * the search a whole mate score adrift, and `noise` is measured in
   * evaluation points, not in mate scores.
   */
  blockRate: number;
  /**
   * Width, in evaluation points, of the band inside which the rung will
   * cheerfully play the wrong move. A uniform draw from `[0, noise)` is added
   * to every root score before the best is taken, so a move `d` points worse
   * than the best can be chosen exactly when `d < noise`, and only rarely as
   * `d` approaches it. 0 makes the rung deterministic.
   *
   * For scale: one disc's difference in the centre column is 36 points and a
   * playable three-in-a-row is about 86, so `noise` of 62 trades away roughly
   * "one good square", while 4 only breaks near-ties.
   */
  noise: number;
  /**
   * Multiplier on the centre-out ordering bonus, added to every root score.
   * Keeps a rung's mistakes looking human — a weak player crowds the middle,
   * it does not scatter discs at random.
   */
  centrePull: number;
  /**
   * Discard root moves that hand the opponent a win on top of them. A search
   * of one ply or more already scores those as losses, so this is a guard, not
   * a strategy; what it really marks is which rungs are *entitled* to be safe.
   */
  trapFilter: boolean;
  /** Answer the empty board with the centre instead of spending the clock on it. */
  openingBook: boolean;
}

/**
 * The five rungs, weakest first. The numbers encode a design intent that is
 * invisible from the code, so each is spelled out:
 *
 *   easy         A young child. One static look per drop and no search at all,
 *                so it cannot see a reply coming; it misses two immediate
 *                blocks in five. Wide noise keeps it from ever looking robotic.
 *                Deliberately not strengthened — this rung is somebody's first
 *                game of Connect Four.
 *
 *   steady       The rung that was missing. Covers nine threats in ten and
 *                takes every win, but two plies is one move and a reply: it
 *                cannot see a trap being built, only one being sprung. Should
 *                lose to a thoughtful adult reasonably often while punishing
 *                genuine carelessness. No trap filter, because walking into a
 *                two-move trap is exactly the mistake at this level.
 *
 *   medium       A club player who is beatable. Five plies is enough to set a
 *                double threat up and to see most of them coming, but not to
 *                navigate the parity endgame. Noise stays wide enough that a
 *                patient opponent gets openings. Still no trap filter: at this
 *                level the search is what keeps it safe, and when the search
 *                is wrong the rung deserves to be wrong with it.
 *
 *   hard         Strong. Eight plies of exact-window search sees the standard
 *                forcing patterns; the noise only breaks near-ties, so it is
 *                beaten by better play rather than by waiting for a slip. The
 *                depth cap is the whole difference from the rung above.
 *
 *   grandmaster  Uncapped inside the budget, deterministic, opens on the
 *                centre. Nothing here is handicapped; if you beat it, you
 *                out-played a search that read the position to the end of its
 *                clock.
 *
 * The steps are real and measured, not asserted. Seeded self-play from paired
 * random openings, each rung against the one below it, gives the stronger rung
 * roughly 92 / 73 / 75 / 88 percent — see the ladder tests, which fail if any
 * step flattens out. Retune from those numbers, not from taste alone: the
 * axes trade against each other, and buying a wider gap at one rung usually
 * spends one at the next.
 */
const TIERS: Record<Difficulty, Tier> = {
  easy: {
    plies: 0, blockRate: 0.6, noise: 78, centrePull: 0.3, trapFilter: false, openingBook: false,
  },
  steady: {
    plies: 2, blockRate: 0.9, noise: 62, centrePull: 0.16, trapFilter: false, openingBook: false,
  },
  medium: {
    plies: 5, blockRate: 1, noise: 40, centrePull: 0.06, trapFilter: false, openingBook: false,
  },
  hard: {
    plies: 8, blockRate: 1, noise: 4, centrePull: 0, trapFilter: true, openingBook: false,
  },
  grandmaster: {
    plies: CELLS, blockRate: 1, noise: 0, centrePull: 0, trapFilter: true, openingBook: true,
  },
};

/**
 * Default wall-clock budget per rung; `SearchOptions.timeBudgetMs` overrides
 * it. Separate from {@link TIERS} because it is the one tuning number a caller
 * is allowed to argue with — the UI shortens it so the computer answers at a
 * conversational pace. Depth-capped rungs finish well inside these, so the
 * budget only really bites on `grandmaster` and on a crowded midgame.
 */
const DEFAULT_BUDGET: Record<Difficulty, number> = {
  easy: 30,
  steady: 40,
  medium: 150,
  hard: 450,
  grandmaster: 900,
};

function decide(
  column: number,
  score: number,
  depth: number,
  nodeCount: number,
  elapsedMs: number,
  pv: number[],
  proven?: 'win' | 'loss' | 'draw',
): AiDecision {
  const base: AiDecision = { column, score, depth, nodes: nodeCount, elapsedMs, pv };
  return proven === undefined ? base : { ...base, proven };
}

function provenOf(score: number, depth: number, movesLeft: number): 'win' | 'loss' | 'draw' | undefined {
  if (score >= MATE_THRESHOLD) return 'win';
  if (score <= -MATE_THRESHOLD) return 'loss';
  if (score === 0 && depth >= movesLeft) return 'draw';
  return undefined;
}

/** Does playing `col` hand the opponent an immediate win? */
function losesAtOnce(board: Board, col: number): boolean {
  board.play(col);
  const reply = board.winningMoveMask(board.toMove);
  board.undo();
  return reply !== 0;
}

/**
 * Root scores with no search behind them: one static evaluation per drop. This
 * is the whole of `easy`'s thinking, and it is genuinely blind — the position
 * it scores is the one *before* the opponent gets to answer.
 */
function scanOnePly(board: Board, pool: readonly number[]): RootResult {
  const scores: number[] = new Array<number>(COLS).fill(-INF);
  let move = pool[0];
  let best = -INF;
  for (const c of pool) {
    board.play(c);
    const v = -evaluate(board);
    board.undo();
    scores[c] = v;
    if (v > best) {
      best = v;
      move = c;
    }
  }
  // Reported as depth 1: it really did look one move ahead, just not two.
  return { move, score: best, depth: 1, nodes: pool.length, pv: [move], scores };
}

/** Highest scoring column in `cands`; ties go to the earliest, which is leftmost. */
function bestScoring(cands: readonly number[], scores: readonly number[]): number {
  let best = cands[0];
  for (const c of cands) if (scores[c] > scores[best]) best = c;
  return best;
}

/**
 * The one chooser every rung runs. What separates the rungs is entirely in
 * `tier` and `budgetMs`; the shape of the decision — win, block, look, pick —
 * is the same all the way up.
 */
function choose(board: Board, tier: Tier, budgetMs: number, rng: () => number): AiDecision {
  const t0 = nowMs();
  const me = board.toMove;

  if (tier.openingBook && board.moveCount === 0) return decide(3, 0, 0, 0, nowMs() - t0, [3]);

  // Taking a win has to happen before the search, at every rung: negamax spots
  // a four one ply *before* it is played, so it would score a position that is
  // already won as though the game carried on.
  const win = board.winningMoveMask(me);
  if (win !== 0) {
    const c = centreMost(win);
    return decide(c, MATE - 1, 1, 1, nowMs() - t0, [c], 'win');
  }

  let pool = board.legalMoves();
  if (tier.blockRate < 1) {
    const block = board.winningMoveMask(other(me));
    if (block !== 0) {
      if (rng() < tier.blockRate) {
        // With two threats the game is lost anyway; cover the more central one
        // so the position at least stays sane.
        const c = centreMost(block);
        return decide(c, 0, 1, 1, nowMs() - t0, [c]);
      }
      // Not blocking this time: genuinely look elsewhere, so the rate is honest.
      const elsewhere = pool.filter((c) => ((block >>> c) & 1) === 0);
      if (elsewhere.length > 0) pool = elsewhere;
    }
  }

  const res =
    tier.plies === 0
      ? scanOnePly(board, pool)
      : searchRoot(board, tier.plies, budgetMs, tier.noise > 0);

  let cands = pool;
  if (tier.trapFilter) {
    const safe = pool.filter((c) => !losesAtOnce(board, c));
    if (safe.length > 0) cands = safe;
  }

  let column: number;
  if (tier.noise === 0 && tier.centrePull === 0) {
    // Deterministic rung: play the search's own move so that provably equal
    // moves resolve the way searchRoot resolved them (the more central one),
    // not by the order this scan happens to run in.
    column = cands.includes(res.move) ? res.move : bestScoring(cands, res.scores);
  } else {
    column = cands[0];
    let bestNoisy = -Infinity;
    for (const c of cands) {
      // One rng() draw per candidate, in ascending column order: seeded runs
      // have to replay move for move.
      const noisy = res.scores[c] + tier.centrePull * ORDER_BONUS[c] + rng() * tier.noise;
      if (noisy > bestNoisy) {
        bestNoisy = noisy;
        column = c;
      }
    }
  }

  const score = res.scores[column] > -INF ? res.scores[column] : res.score;
  const pv = column === res.move ? res.pv : [column];
  const proven = provenOf(score, res.depth, CELLS - board.moveCount);
  return decide(column, score, res.depth, res.nodes, nowMs() - t0, pv, proven);
}

/**
 * Pick a move. Never returns an illegal column and never throws on a position
 * that is still being played.
 *
 * @throws if the board is full or the game is already decided — that is a
 *   caller bug, not a search result.
 */
export function chooseMove(board: Board, opts: SearchOptions): AiDecision {
  const state = board.outcome();
  if (state.kind !== 'ongoing') {
    throw new Error(
      `chooseMove: the game is already over (${state.kind}) — check board.outcome() first`,
    );
  }
  const legal = board.legalMoves();
  if (legal.length === 0) throw new Error('chooseMove: the board is full');

  // The difficulty arrives from the UI and, in the worker, off a message port,
  // so an unknown one is a real possibility rather than a type-system fiction.
  const tier = TIERS[opts.difficulty] as Tier | undefined;
  if (tier === undefined) {
    throw new Error(`chooseMove: unknown difficulty ${String(opts.difficulty)}`);
  }

  const rng = opts.rng ?? Math.random;
  const budget = opts.timeBudgetMs ?? DEFAULT_BUDGET[opts.difficulty];
  // The search plays and unplays on the caller's board; whatever happens, it
  // must hand it back untouched.
  const baseline = board.moveCount;

  let decision: AiDecision;
  try {
    decision = choose(board, tier, budget, rng);
  } finally {
    while (board.moveCount > baseline) board.undo();
  }

  // Last line of defence: a bug in the search must never crash the game.
  if (!board.canPlay(decision.column)) {
    const fallback = centreMost(legal.reduce((m, c) => m | (1 << c), 0));
    return decide(fallback, 0, 0, decision.nodes, decision.elapsedMs, [fallback]);
  }
  return decision;
}
