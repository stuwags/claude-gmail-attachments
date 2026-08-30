// Board rules, win detection, gravity, undo and serialization.
//
// Run with:  node --experimental-transform-types --test tests/board.test.mjs
// (types.ts uses a `const enum`, which plain type-stripping cannot erase.)

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Board,
  WINDOWS,
  cellHi,
  cellLo,
  computeWinningSquares,
  winsIn,
} from '../src/engine/board.ts';
import { CELLS, COLS, DIRECTIONS, Player, ROWS, cellIndex, other } from '../src/engine/types.ts';

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Deterministic PRNG so every random test is reproducible. */
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Brute-force winner: scan all 69 windows of a flat cell snapshot. */
function refWinner(cells) {
  for (const spec of WINDOWS) {
    const first = cells[cellIndex(spec.cells[0].col, spec.cells[0].row)];
    if (first === null) continue;
    if (spec.cells.every((p) => cells[cellIndex(p.col, p.row)] === first)) return first;
  }
  return null;
}

/** Brute-force: every empty square at which `player` would complete a four. */
function refWinningSquares(cells, player) {
  const out = new Set();
  for (const spec of WINDOWS) {
    for (const gap of spec.cells) {
      const gi = cellIndex(gap.col, gap.row);
      if (cells[gi] !== null) continue;
      if (spec.cells.every((p) => p === gap || cells[cellIndex(p.col, p.row)] === player)) {
        out.add(gi);
      }
    }
  }
  return out;
}

/** Play random legal moves, stopping as soon as somebody wins or it fills up. */
function randomBoard(rnd, maxMoves = 42) {
  const b = new Board();
  for (let i = 0; i < maxMoves; i++) {
    const legal = b.legalMoves();
    if (legal.length === 0) break;
    b.play(legal[(rnd() * legal.length) | 0]);
    if (b.outcome().kind !== 'ongoing') break;
  }
  return b;
}

/* -------------------------------------------------------------------------- */
/* construction and basics                                                    */
/* -------------------------------------------------------------------------- */

test('a fresh board is empty and Player One is to move', () => {
  const b = new Board();
  assert.equal(b.toMove, Player.One);
  assert.equal(b.moveCount, 0);
  assert.deepEqual(b.history, []);
  assert.deepEqual(b.legalMoves(), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(b.outcome(), { kind: 'ongoing' });
  assert.equal(b.cells().length, CELLS);
  assert.ok(b.cells().every((c) => c === null));
  for (let c = 0; c < COLS; c++) assert.equal(b.heightOf(c), 0);
});

test('discs fall to the lowest empty row', () => {
  const b = new Board();
  for (let r = 0; r < ROWS; r++) {
    assert.equal(b.play(2), r, `disc ${r} should land in row ${r}`);
    assert.equal(b.heightOf(2), r + 1);
    assert.equal(b.get(2, r), r % 2 === 0 ? Player.One : Player.Two);
  }
});

test('a full column is rejected', () => {
  const b = new Board();
  for (let r = 0; r < ROWS; r++) b.play(0);
  assert.equal(b.canPlay(0), false);
  assert.equal(b.heightOf(0), ROWS);
  assert.deepEqual(b.legalMoves(), [1, 2, 3, 4, 5, 6]);
  assert.throws(() => b.play(0), /full/);
});

test('off-board columns are rejected', () => {
  const b = new Board();
  for (const bad of [-1, 7, 100, 1.5, NaN]) {
    assert.throws(() => b.play(bad), RangeError, `play(${bad}) should throw`);
  }
  assert.equal(b.canPlay(-1), false);
  assert.equal(b.canPlay(7), false);
  assert.equal(b.get(-1, 0), null);
  assert.equal(b.get(0, ROWS), null);
});

test('undo on an empty board throws', () => {
  assert.throws(() => new Board().undo(), /no moves to undo/);
});

test('toMove alternates and history records the columns played', () => {
  const cols = [3, 3, 4, 2, 0, 6];
  const b = Board.fromMoves(cols);
  assert.deepEqual(b.history, cols);
  assert.equal(b.moveCount, cols.length);
  assert.equal(b.toMove, Player.One);
  b.play(1);
  assert.equal(b.toMove, Player.Two);
});

test('history is a copy, not the live array', () => {
  const b = Board.fromMoves([3, 4]);
  b.history.push(99);
  assert.deepEqual(b.history, [3, 4]);
});

test('cells() is indexed by cellIndex()', () => {
  const b = Board.fromMoves([0, 0, 6]);
  const cells = b.cells();
  assert.equal(cells[cellIndex(0, 0)], Player.One);
  assert.equal(cells[cellIndex(0, 1)], Player.Two);
  assert.equal(cells[cellIndex(6, 0)], Player.One);
  assert.equal(cells[cellIndex(3, 3)], null);
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) assert.equal(cells[cellIndex(c, r)], b.get(c, r));
  }
});

test('clone() is independent', () => {
  const a = Board.fromMoves([3, 3, 4]);
  const b = a.clone();
  b.play(5);
  b.play(5);
  assert.equal(a.moveCount, 3);
  assert.equal(a.heightOf(5), 0);
  assert.equal(b.moveCount, 5);
  assert.notEqual(a.toKey(), b.toKey());
  b.undo();
  b.undo();
  assert.equal(a.toKey(), b.toKey());
});

test('fromMoves rejects an illegal sequence', () => {
  assert.throws(() => Board.fromMoves([0, 0, 0, 0, 0, 0, 0]), /full/);
  assert.throws(() => Board.fromMoves([9]), RangeError);
});

/* -------------------------------------------------------------------------- */
/* win detection                                                              */
/* -------------------------------------------------------------------------- */

test('horizontal win, reported left to right', () => {
  // x builds row 0 across columns 0-3; o stacks harmlessly in column 6.
  const b = Board.fromMoves([0, 6, 1, 6, 2, 6, 3]);
  const out = b.outcome();
  assert.equal(out.kind, 'win');
  assert.equal(out.winner, Player.One);
  assert.equal(out.direction, 'horizontal');
  assert.deepEqual(out.line, [
    { col: 0, row: 0 },
    { col: 1, row: 0 },
    { col: 2, row: 0 },
    { col: 3, row: 0 },
  ]);
});

test('vertical win, reported bottom to top', () => {
  const b = Board.fromMoves([2, 3, 2, 3, 2, 3, 2]);
  const out = b.outcome();
  assert.equal(out.kind, 'win');
  assert.equal(out.winner, Player.One);
  assert.equal(out.direction, 'vertical');
  assert.deepEqual(out.line, [
    { col: 2, row: 0 },
    { col: 2, row: 1 },
    { col: 2, row: 2 },
    { col: 2, row: 3 },
  ]);
});

test('diagonal-up win, reported bottom-left to top-right', () => {
  const b = Board.fromMoves([6, 3, 5, 1, 2, 0, 6, 5, 2, 1, 0, 3, 3, 6, 4, 4, 0, 3, 5]);
  assert.equal(b.outcome().kind, 'ongoing');
  b.play(2);
  const out = b.outcome();
  assert.equal(out.kind, 'win');
  assert.equal(out.winner, Player.Two);
  assert.equal(out.direction, 'diagonal-up');
  assert.deepEqual(out.line, [
    { col: 0, row: 0 },
    { col: 1, row: 1 },
    { col: 2, row: 2 },
    { col: 3, row: 3 },
  ]);
});

test('diagonal-down win, reported top-left to bottom-right', () => {
  const b = Board.fromMoves([4, 0, 2, 1, 6, 1, 3, 3, 4, 5, 2, 2, 1, 0, 5, 6, 4, 4, 6, 4, 2, 3]);
  assert.equal(b.outcome().kind, 'ongoing');
  b.play(3);
  const out = b.outcome();
  assert.equal(out.kind, 'win');
  assert.equal(out.winner, Player.One);
  assert.equal(out.direction, 'diagonal-down');
  assert.deepEqual(out.line, [
    { col: 3, row: 3 },
    { col: 4, row: 2 },
    { col: 5, row: 1 },
    { col: 6, row: 0 },
  ]);
});

// Real games (found by replaying random legal play until the wanted line came
// up), so every fixture below is a position that can actually occur.
const CORNER_AND_EDGE_WINS = [
  {
    name: 'bottom-left corner, horizontal',
    moves: [5, 2, 5, 0, 4, 2, 0, 2, 5, 3, 6, 1],
    winner: Player.Two,
    direction: 'horizontal',
    line: [
      { col: 0, row: 0 },
      { col: 1, row: 0 },
      { col: 2, row: 0 },
      { col: 3, row: 0 },
    ],
  },
  {
    name: 'bottom-left corner, vertical',
    moves: [5, 6, 4, 3, 6, 1, 0, 5, 1, 6, 1, 4, 6, 5, 0, 2, 5, 5, 3, 5, 0, 1, 3, 6, 1, 3, 0],
    winner: Player.One,
    direction: 'vertical',
    line: [
      { col: 0, row: 0 },
      { col: 0, row: 1 },
      { col: 0, row: 2 },
      { col: 0, row: 3 },
    ],
  },
  {
    name: 'bottom-right corner, horizontal',
    moves: [
      1, 6, 6, 5, 6, 6, 0, 3, 2, 1, 5, 6, 2, 6, 0, 1, 0, 3, 2, 0, 3, 2, 5, 5, 1, 1, 2, 2, 1, 0,
      0, 3, 3, 4,
    ],
    winner: Player.Two,
    direction: 'horizontal',
    line: [
      { col: 3, row: 0 },
      { col: 4, row: 0 },
      { col: 5, row: 0 },
      { col: 6, row: 0 },
    ],
  },
  {
    name: 'bottom-right corner, vertical',
    moves: [2, 2, 5, 3, 0, 0, 5, 2, 2, 6, 1, 6, 2, 4, 3, 6, 4, 5, 0, 6],
    winner: Player.Two,
    direction: 'vertical',
    line: [
      { col: 6, row: 0 },
      { col: 6, row: 1 },
      { col: 6, row: 2 },
      { col: 6, row: 3 },
    ],
  },
  {
    name: 'top-left corner, vertical',
    moves: [0, 5, 5, 6, 0, 1, 4, 3, 4, 0, 1, 1, 6, 3, 3, 0, 2, 0, 4, 6, 2, 0],
    winner: Player.Two,
    direction: 'vertical',
    line: [
      { col: 0, row: 2 },
      { col: 0, row: 3 },
      { col: 0, row: 4 },
      { col: 0, row: 5 },
    ],
  },
  {
    name: 'top-right corner, vertical',
    moves: [1, 2, 4, 6, 0, 2, 5, 4, 6, 6, 4, 6, 0, 3, 3, 5, 1, 6, 2, 1, 5, 6],
    winner: Player.Two,
    direction: 'vertical',
    line: [
      { col: 6, row: 2 },
      { col: 6, row: 3 },
      { col: 6, row: 4 },
      { col: 6, row: 5 },
    ],
  },
  {
    name: 'top edge, horizontal from the left corner',
    moves: [
      5, 3, 0, 0, 6, 4, 3, 6, 1, 6, 0, 1, 1, 6, 1, 5, 2, 3, 4, 1, 6, 3, 0, 5, 4, 2, 2, 2, 3, 2,
      2, 6, 4, 0, 0, 5, 5, 5, 3, 4, 1,
    ],
    winner: Player.One,
    direction: 'horizontal',
    line: [
      { col: 0, row: 5 },
      { col: 1, row: 5 },
      { col: 2, row: 5 },
      { col: 3, row: 5 },
    ],
  },
  {
    name: 'top edge, horizontal into the right corner',
    moves: [
      3, 0, 1, 4, 5, 6, 4, 5, 6, 6, 4, 2, 0, 4, 5, 5, 1, 3, 3, 0, 1, 5, 5, 0, 3, 1, 0, 6, 4, 1,
      4, 3, 3, 1, 0, 6, 6,
    ],
    winner: Player.One,
    direction: 'horizontal',
    line: [
      { col: 3, row: 5 },
      { col: 4, row: 5 },
      { col: 5, row: 5 },
      { col: 6, row: 5 },
    ],
  },
  {
    name: 'bottom-right corner, diagonal-down',
    moves: [4, 0, 2, 1, 6, 1, 3, 3, 4, 5, 2, 2, 1, 0, 5, 6, 4, 4, 6, 4, 2, 3, 3],
    winner: Player.One,
    direction: 'diagonal-down',
    line: [
      { col: 3, row: 3 },
      { col: 4, row: 2 },
      { col: 5, row: 1 },
      { col: 6, row: 0 },
    ],
  },
  {
    name: 'top-right corner, diagonal-up',
    moves: [
      2, 6, 6, 4, 5, 6, 4, 3, 2, 4, 6, 5, 0, 4, 0, 3, 4, 1, 4, 2, 2, 0, 1, 0, 2, 6, 5, 6, 2, 3,
      5, 5,
    ],
    winner: Player.Two,
    direction: 'diagonal-up',
    line: [
      { col: 3, row: 2 },
      { col: 4, row: 3 },
      { col: 5, row: 4 },
      { col: 6, row: 5 },
    ],
  },
  {
    name: 'top-left corner, diagonal-down',
    moves: [
      2, 5, 1, 4, 1, 6, 5, 1, 1, 0, 6, 1, 3, 3, 4, 1, 6, 5, 6, 3, 4, 3, 5, 0, 0, 6, 0, 0, 5, 0,
      3, 2, 6, 4, 2, 2,
    ],
    winner: Player.Two,
    direction: 'diagonal-down',
    line: [
      { col: 0, row: 5 },
      { col: 1, row: 4 },
      { col: 2, row: 3 },
      { col: 3, row: 2 },
    ],
  },
];

test('wins are found in all four corners and along both edges', () => {
  for (const c of CORNER_AND_EDGE_WINS) {
    const b = Board.fromMoves(c.moves.slice(0, -1));
    assert.equal(b.outcome().kind, 'ongoing', `${c.name}: should not be won yet`);
    const last = c.moves[c.moves.length - 1];
    b.play(last);
    const out = b.outcome();
    assert.equal(out.kind, 'win', `${c.name}: expected a win\n${b.toString()}`);
    assert.equal(out.winner, c.winner, c.name);
    assert.equal(out.direction, c.direction, c.name);
    assert.deepEqual(out.line, c.line, `${c.name}\n${b.toString()}`);
    // The winning line must touch the column that was just played.
    assert.ok(out.line.some((p) => p.col === last), `${c.name}: line misses the last move`);
  }
});

test('a full board with no four is a draw', () => {
  const b = Board.fromMoves([
    4, 3, 4, 0, 4, 5, 3, 6, 2, 6, 2, 2, 2, 4, 0, 3, 3, 5, 2, 3, 6, 4, 3, 2, 0, 1, 5, 6, 6, 1, 6,
    5, 1, 1, 5, 5, 4, 0, 0, 0, 1, 1,
  ]);
  assert.equal(b.moveCount, CELLS);
  assert.equal(refWinner(b.cells()), null, 'the fixture must genuinely have no four');
  assert.deepEqual(b.outcome(), { kind: 'draw' });
  assert.deepEqual(b.legalMoves(), []);
  for (let c = 0; c < COLS; c++) {
    assert.equal(b.canPlay(c), false);
    assert.throws(() => b.play(c), /full/);
  }
  // one move short of full is still ongoing
  const almost = b.clone();
  almost.undo();
  assert.deepEqual(almost.outcome(), { kind: 'ongoing' });
});

test('outcome() agrees with a brute-force window scan over random games', () => {
  const rnd = mulberry32(0xc0ffee);
  let wins = 0;
  let draws = 0;
  for (let g = 0; g < 4000; g++) {
    const b = randomBoard(rnd);
    const expected = refWinner(b.cells());
    const out = b.outcome();
    if (expected !== null) {
      wins++;
      assert.equal(out.kind, 'win');
      assert.equal(out.winner, expected);
      assert.equal(out.line.length, 4);
      // the reported line must really be four of the winner's discs, in order
      const dir = DIRECTIONS.find((d) => d.name === out.direction);
      for (let k = 0; k < 4; k++) {
        assert.equal(b.get(out.line[k].col, out.line[k].row), expected);
        if (k > 0) {
          assert.equal(out.line[k].col - out.line[k - 1].col, dir.dc);
          assert.equal(out.line[k].row - out.line[k - 1].row, dir.dr);
        }
      }
    } else if (b.moveCount === CELLS) {
      draws++;
      assert.deepEqual(out, { kind: 'draw' });
    } else {
      assert.deepEqual(out, { kind: 'ongoing' });
    }
  }
  assert.ok(wins > 3000, `expected plenty of wins in the sample, got ${wins}`);
  assert.ok(draws >= 0);
});

test('winsIn() agrees with brute force on both colours', () => {
  const rnd = mulberry32(7);
  for (let g = 0; g < 3000; g++) {
    const b = randomBoard(rnd);
    const cells = b.cells();
    for (const p of [Player.One, Player.Two]) {
      const expected = (() => {
        for (const spec of WINDOWS) {
          if (spec.cells.every((q) => cells[cellIndex(q.col, q.row)] === p)) return true;
        }
        return false;
      })();
      assert.equal(winsIn(b.bitsLo(p), b.bitsHi(p)), expected);
    }
  }
});

test('winningMoveMask and isWinningMove agree with brute force', () => {
  const rnd = mulberry32(1234);
  for (let g = 0; g < 3000; g++) {
    // stop before anybody wins so the query is meaningful
    const b = new Board();
    for (let i = 0; i < 42; i++) {
      const legal = b.legalMoves().filter((c) => !b.isWinningMove(c, b.toMove));
      if (legal.length === 0) break;
      b.play(legal[(rnd() * legal.length) | 0]);
    }
    const cells = b.cells();
    for (const p of [Player.One, Player.Two]) {
      const truth = new Set();
      for (let c = 0; c < COLS; c++) {
        if (!b.canPlay(c)) continue;
        const probe = cells.slice();
        probe[cellIndex(c, b.heightOf(c))] = p;
        if (refWinner(probe) === p) truth.add(c);
      }
      const mask = b.winningMoveMask(p);
      for (let c = 0; c < COLS; c++) {
        assert.equal(((mask >>> c) & 1) === 1, truth.has(c), `col ${c}\n${b.toString()}`);
        assert.equal(b.isWinningMove(c, p), truth.has(c));
      }
    }
  }
});

test('isWinningMove is false for full columns', () => {
  const b = new Board();
  for (let i = 0; i < ROWS; i++) b.play(0);
  assert.equal(b.isWinningMove(0, Player.One), false);
  assert.equal(b.isWinningMove(0, Player.Two), false);
  assert.equal(b.isWinningMove(9, Player.One), false);
});

test('computeWinningSquares matches brute force, buried squares included', () => {
  const rnd = mulberry32(99);
  const out = new Int32Array(2);
  for (let g = 0; g < 2500; g++) {
    const b = randomBoard(rnd);
    const cells = b.cells();
    for (const p of [Player.One, Player.Two]) {
      const truth = refWinningSquares(cells, p);
      computeWinningSquares(b.bitsLo(p), b.bitsHi(p), b.occupiedLo, b.occupiedHi, out);
      for (let c = 0; c < COLS; c++) {
        for (let r = 0; r < ROWS; r++) {
          const got = ((out[0] & cellLo(c, r)) | (out[1] & cellHi(c, r))) !== 0;
          assert.equal(got, truth.has(cellIndex(c, r)), `(${c},${r})\n${b.toString()}`);
        }
      }
    }
  }
});

/* -------------------------------------------------------------------------- */
/* undo and serialization                                                     */
/* -------------------------------------------------------------------------- */

test('undo restores the board exactly across thousands of random games', () => {
  const fresh = new Board().toKey();
  const rnd = mulberry32(0xbeef);
  for (let g = 0; g < 3000; g++) {
    const b = new Board();
    const played = [];
    const keys = [fresh];
    const len = 1 + ((rnd() * 42) | 0);
    for (let i = 0; i < len; i++) {
      const legal = b.legalMoves();
      if (legal.length === 0) break;
      const c = legal[(rnd() * legal.length) | 0];
      b.play(c);
      played.push(c);
      keys.push(b.toKey());
    }
    assert.deepEqual(b.history, played);
    // unwind one move at a time, checking against a freshly replayed board
    for (let i = played.length; i > 0; i--) {
      assert.equal(b.toKey(), keys[i]);
      assert.equal(b.toKey(), Board.fromMoves(played.slice(0, i)).toKey());
      b.undo();
    }
    assert.equal(b.moveCount, 0);
    assert.deepEqual(b.history, []);
    assert.equal(b.toKey(), fresh, 'a fully unwound board must match a fresh one');
    assert.equal(b.toMove, Player.One);
    assert.ok(b.cells().every((v) => v === null));
    for (let c = 0; c < COLS; c++) assert.equal(b.heightOf(c), 0);
    assert.deepEqual(b.outcome(), { kind: 'ongoing' });
  }
});

test('toKey distinguishes positions and ignores move order', () => {
  const a = Board.fromMoves([3, 4, 2]);
  const b = Board.fromMoves([2, 4, 3]);
  assert.equal(a.toKey(), b.toKey(), 'same discs, same side to move => same key');
  const c = Board.fromMoves([3, 4, 5]);
  assert.notEqual(a.toKey(), c.toKey());
  // The key encodes whose turn it is, via the disc that is missing.
  assert.notEqual(Board.fromMoves([3]).toKey(), Board.fromMoves([3, 3]).toKey());
});

test('toKey is unique across a large sample of positions', () => {
  const rnd = mulberry32(555);
  const seen = new Map();
  for (let g = 0; g < 4000; g++) {
    const b = randomBoard(rnd, 1 + ((rnd() * 30) | 0));
    const key = b.toKey();
    const fingerprint = `${b.toMove}|${b.cells().map((v) => (v === null ? '.' : v)).join('')}`;
    const prev = seen.get(key);
    if (prev === undefined) seen.set(key, fingerprint);
    else assert.equal(prev, fingerprint, `key collision on ${key}`);
  }
  assert.ok(seen.size > 500);
});

/* -------------------------------------------------------------------------- */
/* window table                                                               */
/* -------------------------------------------------------------------------- */

test('there are exactly 69 windows, each four in-line cells', () => {
  assert.equal(WINDOWS.length, 69);
  const byDirection = {};
  const seen = new Set();
  for (const spec of WINDOWS) {
    byDirection[spec.direction] = (byDirection[spec.direction] ?? 0) + 1;
    assert.equal(spec.cells.length, 4);
    const dir = DIRECTIONS.find((d) => d.name === spec.direction);
    for (let k = 0; k < 4; k++) {
      const { col, row } = spec.cells[k];
      assert.ok(col >= 0 && col < COLS && row >= 0 && row < ROWS, `(${col},${row}) off board`);
      if (k > 0) {
        assert.equal(col - spec.cells[k - 1].col, dir.dc);
        assert.equal(row - spec.cells[k - 1].row, dir.dr);
      }
    }
    const id = spec.cells.map((p) => cellIndex(p.col, p.row)).join(',');
    assert.equal(seen.has(id), false, `duplicate window ${id}`);
    seen.add(id);
  }
  assert.deepEqual(byDirection, {
    horizontal: 24,
    vertical: 21,
    'diagonal-up': 12,
    'diagonal-down': 12,
  });
});

test('other() flips the player', () => {
  assert.equal(other(Player.One), Player.Two);
  assert.equal(other(Player.Two), Player.One);
});
