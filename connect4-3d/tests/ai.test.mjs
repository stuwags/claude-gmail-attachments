// Search behaviour and the three difficulty tiers.
//
// Run with:  node --experimental-transform-types --test tests/ai.test.mjs
//
// Time budgets here are deliberately small so the suite stays quick; hard is
// far stronger than easy or medium even with 40ms to think.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Board } from '../src/engine/board.ts';
import { analyze } from '../src/engine/threats.ts';
import { chooseMove, clearTranspositionTable } from '../src/engine/ai.ts';
import { CELLS, COLS, Player, other } from '../src/engine/types.ts';

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HARD = { difficulty: 'hard', timeBudgetMs: 40 };

function randomPosition(rnd, plies) {
  const b = new Board();
  for (let i = 0; i < plies; i++) {
    const legal = b.legalMoves();
    if (legal.length === 0) break;
    b.play(legal[(rnd() * legal.length) | 0]);
    if (b.outcome().kind !== 'ongoing') {
      b.undo();
      break;
    }
  }
  return b;
}

function assertDecisionShape(d, board) {
  assert.ok(Number.isInteger(d.column), 'column must be an integer');
  assert.ok(board.canPlay(d.column), `column ${d.column} is not legal`);
  assert.ok(Number.isFinite(d.score));
  assert.ok(Number.isInteger(d.depth) && d.depth >= 0);
  assert.ok(Number.isInteger(d.nodes) && d.nodes >= 0);
  assert.ok(Number.isFinite(d.elapsedMs) && d.elapsedMs >= 0);
  assert.ok(Array.isArray(d.pv) && d.pv.length >= 1, 'pv must name at least the move');
  assert.equal(d.pv[0], d.column, 'the pv must start with the chosen move');
  if (d.proven !== undefined) assert.ok(['win', 'loss', 'draw'].includes(d.proven));
  // the whole pv must be playable from here
  const probe = board.clone();
  for (const c of d.pv) {
    if (probe.outcome().kind !== 'ongoing') break;
    assert.ok(probe.canPlay(c), `pv column ${c} is not legal`);
    probe.play(c);
  }
}

/* -------------------------------------------------------------------------- */
/* contract                                                                   */
/* -------------------------------------------------------------------------- */

test('chooseMove refuses a game that is already over', () => {
  const won = Board.fromMoves([0, 6, 1, 6, 2, 6, 3]);
  assert.equal(won.outcome().kind, 'win');
  for (const difficulty of ['easy', 'medium', 'hard']) {
    assert.throws(() => chooseMove(won, { difficulty }), /already over/);
  }
});

test('chooseMove refuses a full board', () => {
  const full = Board.fromMoves([
    4, 3, 4, 0, 4, 5, 3, 6, 2, 6, 2, 2, 2, 4, 0, 3, 3, 5, 2, 3, 6, 4, 3, 2, 0, 1, 5, 6, 6, 1, 6,
    5, 1, 1, 5, 5, 4, 0, 0, 0, 1, 1,
  ]);
  assert.equal(full.moveCount, CELLS);
  assert.throws(() => chooseMove(full, { difficulty: 'hard' }), /already over|full/);
});

test('every difficulty returns a legal move and leaves the board alone', () => {
  const rnd = mulberry32(0x5eed);
  for (let g = 0; g < 60; g++) {
    const b = randomPosition(rnd, 1 + ((rnd() * 38) | 0));
    if (b.outcome().kind !== 'ongoing') continue;
    const before = b.toKey();
    const history = b.history;
    for (const opts of [
      { difficulty: 'easy', rng: mulberry32(g) },
      { difficulty: 'medium', timeBudgetMs: 15, rng: mulberry32(g) },
      { difficulty: 'hard', timeBudgetMs: 15 },
    ]) {
      const d = chooseMove(b, opts);
      assertDecisionShape(d, b);
      assert.equal(b.toKey(), before, `${opts.difficulty} mutated the board`);
      assert.deepEqual(b.history, history);
    }
  }
});

test('a tiny time budget still produces a legal, sensible move', () => {
  const b = Board.fromMoves([3, 3, 4, 2, 4, 5]);
  for (const timeBudgetMs of [0, 1, 2]) {
    const d = chooseMove(b, { difficulty: 'hard', timeBudgetMs });
    assertDecisionShape(d, b);
    assert.ok(d.depth >= 1, 'depth 1 always completes, whatever the clock says');
  }
});

/* -------------------------------------------------------------------------- */
/* hard                                                                       */
/* -------------------------------------------------------------------------- */

test('hard takes an available win in one, in every direction', () => {
  const cases = [
    // [moves, winning column, what the win is]
    [[0, 6, 1, 6, 2, 5], 3, 'horizontal'],
    [[2, 3, 2, 3, 2, 4], 2, 'vertical'],
    [[6, 3, 5, 1, 2, 0, 6, 5, 2, 1, 0, 3, 3, 6, 4, 4, 0, 3, 5], 2, 'diagonal-up'],
    [[4, 0, 2, 1, 6, 1, 3, 3, 4, 5, 2, 2, 1, 0, 5, 6, 4, 4, 6, 4, 2, 3], 3, 'diagonal-down'],
  ];
  for (const [moves, column, label] of cases) {
    const b = Board.fromMoves(moves);
    assert.equal(b.outcome().kind, 'ongoing', label);
    assert.equal(b.isWinningMove(column, b.toMove), true, `${label}: fixture is wrong`);
    const d = chooseMove(b, HARD);
    assert.equal(d.column, column, `${label}: hard missed the win\n${b.toString()}`);
    assert.equal(d.proven, 'win');
    assert.ok(d.score > 900000, `${label}: expected a mate score, got ${d.score}`);
  }
});

test('hard blocks an immediate loss', () => {
  //   x x . . . . .
  //   x o o o . . .    o completes row 0 at column 4; x has no win of its own
  const b = Board.fromMoves([0, 1, 0, 2, 1, 3]);
  assert.equal(b.toMove, Player.One);
  assert.deepEqual(analyze(b).blockingMoves, [4]);
  assert.deepEqual(analyze(b).winningMoves, []);
  const d = chooseMove(b, HARD);
  assert.equal(d.column, 4, `hard failed to block\n${b.toString()}`);
});

test('hard finds a forced win through a double threat', () => {
  //   o . x x . . o    playing column 4 gives x threats at (1,0) and (5,0)
  const b = Board.fromMoves([2, 0, 3, 6]);
  assert.equal(b.toMove, Player.One);
  assert.deepEqual(analyze(b).winningMoves, [], 'nothing wins immediately');
  const d = chooseMove(b, { difficulty: 'hard', timeBudgetMs: 200 });
  assert.equal(d.column, 4, `expected the double-threat move\n${b.toString()}`);
  assert.equal(d.proven, 'win');
  // and the win really is forced: whatever the opponent does, x mates next
  const after = b.clone();
  after.play(4);
  const replies = after.legalMoves();
  for (const reply of replies) {
    const line = after.clone();
    line.play(reply);
    assert.notEqual(
      line.winningMoveMask(line.toMove),
      0,
      `after the reply ${reply} x should still have a winning drop`,
    );
  }
});

test('hard never walks into a one-move trap when it has an alternative', () => {
  const rnd = mulberry32(90210);
  let checked = 0;
  for (let g = 0; g < 120; g++) {
    const b = randomPosition(rnd, 1 + ((rnd() * 34) | 0));
    if (b.outcome().kind !== 'ongoing') continue;
    const report = analyze(b);
    const legal = b.legalMoves();
    const safe = legal.filter((c) => !report.trapMoves.includes(c));
    if (safe.length === 0 || report.trapMoves.length === 0) continue;
    checked++;
    const d = chooseMove(b, HARD);
    assert.equal(
      report.trapMoves.includes(d.column),
      false,
      `hard played the trap ${d.column} with ${safe} available\n${b.toString()}`,
    );
  }
  assert.ok(checked > 15, `expected plenty of trap positions, tested ${checked}`);
});

test('hard opens in the centre as first player', () => {
  const d = chooseMove(new Board(), { difficulty: 'hard', timeBudgetMs: 900 });
  assert.equal(d.column, 3);
  assert.deepEqual(d.pv, [3]);
  assert.ok(d.elapsedMs < 50, 'the opening move should not burn the clock');
});

test('hard uses no randomness', () => {
  // A time-budgeted search reaches whatever depth the clock allows, so
  // determinism is asserted where it is actually meaningful: on endgames the
  // search solves outright, from an identically empty table. Those verdicts do
  // not depend on how many plies were reached, only on the position.
  const rnd = mulberry32(4004);
  let checked = 0;
  for (let g = 0; g < 200 && checked < 10; g++) {
    const b = randomPosition(rnd, 32 + ((rnd() * 6) | 0));
    if (b.outcome().kind !== 'ongoing' || b.moveCount < 30) continue;

    clearTranspositionTable();
    const a = chooseMove(b, { difficulty: 'hard', timeBudgetMs: 2000 });
    clearTranspositionTable();
    const z = chooseMove(b, { difficulty: 'hard', timeBudgetMs: 2000, rng: mulberry32(g + 1) });

    assert.ok(a.proven !== undefined, `endgame should be solved\n${b.toString()}`);
    assert.equal(a.proven, z.proven);
    assert.equal(a.score, z.score, `score changed\n${b.toString()}`);
    assert.equal(a.column, z.column, `hard flip-flopped\n${b.toString()}`);
    checked++;
  }
  assert.ok(checked >= 8, `only solved ${checked} endgames`);
});

test('hard reports a proven loss when the position is already gone', () => {
  // x threatens row 0 at both column 2 and column 6; o cannot cover both.
  const b = Board.fromMoves([3, 0, 4, 0, 5]);
  assert.equal(b.toMove, Player.Two);
  assert.deepEqual(analyze(b).blockingMoves, [2, 6]);
  const d = chooseMove(b, { difficulty: 'hard', timeBudgetMs: 100 });
  assert.equal(d.proven, 'loss');
  assert.ok(d.score < -900000);
  assert.ok(b.canPlay(d.column));
});

test('hard uses roughly the budget it is given and searches deep', () => {
  clearTranspositionTable();
  const b = Board.fromMoves([3, 3, 4, 2, 4, 5, 2, 1]);
  const d = chooseMove(b, { difficulty: 'hard', timeBudgetMs: 400 });
  // Generous bounds on purpose: this asserts that iterative deepening runs and
  // that the clock is respected, not the speed of whatever machine is running.
  assert.ok(d.elapsedMs <= 2000, `overran the budget badly: ${d.elapsedMs}ms`);
  assert.ok(d.depth >= 7, `expected a decent depth in 400ms, reached ${d.depth}`);
  assert.ok(d.nodes > 20000, `expected real work, only ${d.nodes} nodes`);
});

/* -------------------------------------------------------------------------- */
/* easy                                                                       */
/* -------------------------------------------------------------------------- */

test('easy always takes an immediate win', () => {
  const positions = [
    [0, 6, 1, 6, 2, 5],
    [2, 3, 2, 3, 2, 4],
    [6, 3, 5, 1, 2, 0, 6, 5, 2, 1, 0, 3, 3, 6, 4, 4, 0, 3, 5],
  ];
  for (const moves of positions) {
    const b = Board.fromMoves(moves);
    const wins = analyze(b).winningMoves;
    assert.ok(wins.length > 0, 'fixture must offer a win');
    for (let seed = 0; seed < 300; seed++) {
      const d = chooseMove(b, { difficulty: 'easy', rng: mulberry32(seed * 7919 + 13) });
      assert.ok(wins.includes(d.column), `easy passed up a win with seed ${seed}`);
      assert.equal(d.proven, 'win');
    }
  }
});

test('easy blocks an immediate loss about 60% of the time', () => {
  const b = Board.fromMoves([0, 1, 0, 2, 1, 3]);
  assert.deepEqual(analyze(b).blockingMoves, [4]);
  assert.deepEqual(analyze(b).winningMoves, [], 'easy must not have a win to prefer');

  const n = 1500;
  let blocked = 0;
  for (let seed = 0; seed < n; seed++) {
    const d = chooseMove(b, { difficulty: 'easy', rng: mulberry32(seed) });
    assert.ok(b.canPlay(d.column));
    if (d.column === 4) blocked++;
  }
  const rate = blocked / n;
  assert.ok(rate > 0.5 && rate < 0.7, `block rate ${(rate * 100).toFixed(1)}% is off target`);
});

test('seeded easy is reproducible', () => {
  const rnd = mulberry32(5150);
  for (let g = 0; g < 25; g++) {
    const b = randomPosition(rnd, 1 + ((rnd() * 30) | 0));
    if (b.outcome().kind !== 'ongoing') continue;
    const first = chooseMove(b, { difficulty: 'easy', rng: mulberry32(g) });
    const second = chooseMove(b, { difficulty: 'easy', rng: mulberry32(g) });
    assert.equal(first.column, second.column);
    assert.equal(first.score, second.score);
  }
  // a whole game replays identically from the same seed
  const play = (seed) => {
    const b = new Board();
    const rng = mulberry32(seed);
    while (b.outcome().kind === 'ongoing') b.play(chooseMove(b, { difficulty: 'easy', rng }).column);
    return b.history;
  };
  assert.deepEqual(play(77), play(77));
  assert.notDeepEqual(play(77), play(78));
});

test('easy spreads its opening moves without ever looking absurd', () => {
  const counts = new Array(COLS).fill(0);
  const n = 1200;
  for (let seed = 0; seed < n; seed++) {
    counts[chooseMove(new Board(), { difficulty: 'easy', rng: mulberry32(seed) }).column]++;
  }
  assert.ok(counts[3] / n > 0.35, 'a beginner still likes the middle');
  assert.ok(counts[3] / n < 0.85, 'but should not be robotic about it');
  const used = counts.filter((c) => c > 0).length;
  assert.ok(used >= 4, `only ${used} different opening columns ever played`);
});

/* -------------------------------------------------------------------------- */
/* medium                                                                     */
/* -------------------------------------------------------------------------- */

test('medium always takes a win and always blocks', () => {
  const winPositions = [
    [0, 6, 1, 6, 2, 5],
    [2, 3, 2, 3, 2, 4],
  ];
  for (const moves of winPositions) {
    const b = Board.fromMoves(moves);
    const wins = analyze(b).winningMoves;
    for (let seed = 0; seed < 60; seed++) {
      const d = chooseMove(b, { difficulty: 'medium', timeBudgetMs: 20, rng: mulberry32(seed) });
      assert.ok(wins.includes(d.column), 'medium passed up a win');
    }
  }

  const threatened = Board.fromMoves([0, 1, 0, 2, 1, 3]);
  assert.deepEqual(analyze(threatened).blockingMoves, [4]);
  for (let seed = 0; seed < 60; seed++) {
    const d = chooseMove(threatened, {
      difficulty: 'medium',
      timeBudgetMs: 20,
      rng: mulberry32(seed),
    });
    assert.equal(d.column, 4, 'medium failed to block');
  }
});

test('medium avoids one-move traps', () => {
  const rnd = mulberry32(31415);
  let checked = 0;
  for (let g = 0; g < 120; g++) {
    const b = randomPosition(rnd, 1 + ((rnd() * 34) | 0));
    if (b.outcome().kind !== 'ongoing') continue;
    const report = analyze(b);
    if (report.trapMoves.length === 0) continue;
    if (b.legalMoves().every((c) => report.trapMoves.includes(c))) continue;
    checked++;
    const d = chooseMove(b, { difficulty: 'medium', timeBudgetMs: 20, rng: mulberry32(g) });
    assert.equal(
      report.trapMoves.includes(d.column),
      false,
      `medium played the trap ${d.column}\n${b.toString()}`,
    );
  }
  assert.ok(checked > 15, `expected plenty of trap positions, tested ${checked}`);
});

/* -------------------------------------------------------------------------- */
/* self play                                                                  */
/* -------------------------------------------------------------------------- */

/** Play one game; returns 'A', 'B' or 'draw'. `aFirst` decides who is Player One. */
function match(seed, aOpts, bOpts, aFirst) {
  const rngA = mulberry32(seed * 2 + 1);
  const rngB = mulberry32(seed * 2 + 2);
  const b = new Board();
  let aToMove = aFirst;
  while (b.outcome().kind === 'ongoing') {
    const opts = aToMove ? { ...aOpts, rng: rngA } : { ...bOpts, rng: rngB };
    const d = chooseMove(b, opts);
    assert.ok(b.canPlay(d.column), 'self-play produced an illegal move');
    b.play(d.column);
    aToMove = !aToMove;
  }
  const out = b.outcome();
  if (out.kind === 'draw') return 'draw';
  return (out.winner === Player.One) === aFirst ? 'A' : 'B';
}

test('hard beats easy over several seeded games', () => {
  const games = 8;
  const tally = { A: 0, B: 0, draw: 0 };
  for (let i = 0; i < games; i++) {
    tally[match(i, { difficulty: 'hard', timeBudgetMs: 40 }, { difficulty: 'easy' }, i % 2 === 0)]++;
  }
  assert.ok(
    tally.A >= 6,
    `hard should win the clear majority of ${games}, got ${JSON.stringify(tally)}`,
  );
  assert.ok(tally.B <= 2, `easy should rarely win, got ${JSON.stringify(tally)}`);
});

test('hard beats medium over several seeded games', () => {
  const games = 6;
  const tally = { A: 0, B: 0, draw: 0 };
  for (let i = 0; i < games; i++) {
    tally[
      match(
        i,
        { difficulty: 'hard', timeBudgetMs: 120 },
        { difficulty: 'medium', timeBudgetMs: 25 },
        i % 2 === 0,
      )
    ]++;
  }
  assert.ok(tally.A > tally.B, `hard should out-score medium, got ${JSON.stringify(tally)}`);
});

test('a full easy-vs-easy game always finishes legally', () => {
  for (let seed = 0; seed < 20; seed++) {
    const b = new Board();
    const rng = mulberry32(seed);
    let plies = 0;
    while (b.outcome().kind === 'ongoing') {
      const d = chooseMove(b, { difficulty: 'easy', rng });
      assertDecisionShape(d, b);
      b.play(d.column);
      assert.ok(++plies <= CELLS, 'game ran past a full board');
    }
    const out = b.outcome();
    assert.ok(out.kind === 'win' || out.kind === 'draw');
    if (out.kind === 'win') assert.equal(other(other(out.winner)), out.winner);
  }
});
