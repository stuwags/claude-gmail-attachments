// Search behaviour and the five difficulty tiers.
//
// Run with:  node --experimental-transform-types --test tests/ai.test.mjs
//
// Time budgets here are deliberately small so the suite stays quick, and that
// costs less than it looks: every rung but grandmaster has a depth cap it
// reaches in a few milliseconds, so a shorter clock does not weaken it. Only
// grandmaster spends whatever it is given.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Board } from '../src/engine/board.ts';
import { analyze } from '../src/engine/threats.ts';
import { chooseMove, clearTranspositionTable } from '../src/engine/ai.ts';
import { CELLS, COLS, DIFFICULTIES, Player, other } from '../src/engine/types.ts';

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

/** Test budgets. Generous for the capped rungs so a slow machine still hits the cap. */
const BUDGET = { easy: 30, steady: 20, medium: 50, hard: 60, grandmaster: 60 };

const opts = (difficulty, seed) => ({
  difficulty,
  timeBudgetMs: BUDGET[difficulty],
  rng: mulberry32(seed),
});

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

/** A position where the side to move must play column 4 or lose at once. */
const mustBlock = () => Board.fromMoves([0, 1, 0, 2, 1, 3]);

/* -------------------------------------------------------------------------- */
/* contract                                                                   */
/* -------------------------------------------------------------------------- */

test('the ladder is exactly the five rungs the engine tunes', () => {
  assert.deepEqual(
    [...DIFFICULTIES],
    ['easy', 'steady', 'medium', 'hard', 'grandmaster'],
    'weakest first: the self-play test below reads this order',
  );
});

test('chooseMove refuses a game that is already over', () => {
  const won = Board.fromMoves([0, 6, 1, 6, 2, 6, 3]);
  assert.equal(won.outcome().kind, 'win');
  for (const difficulty of DIFFICULTIES) {
    assert.throws(() => chooseMove(won, { difficulty }), /already over/);
  }
});

test('chooseMove refuses a full board', () => {
  const full = Board.fromMoves([
    4, 3, 4, 0, 4, 5, 3, 6, 2, 6, 2, 2, 2, 4, 0, 3, 3, 5, 2, 3, 6, 4, 3, 2, 0, 1, 5, 6, 6, 1, 6,
    5, 1, 1, 5, 5, 4, 0, 0, 0, 1, 1,
  ]);
  assert.equal(full.moveCount, CELLS);
  assert.throws(() => chooseMove(full, { difficulty: 'grandmaster' }), /already over|full/);
});

test('chooseMove refuses a difficulty that is not on the ladder', () => {
  // The difficulty arrives from the UI and, in the worker, off a message port.
  const b = Board.fromMoves([3, 3]);
  assert.throws(() => chooseMove(b, { difficulty: 'impossible' }), /unknown difficulty/);
});

test('every rung returns a legal move and leaves the board alone', () => {
  const rnd = mulberry32(0x5eed);
  for (let g = 0; g < 40; g++) {
    const b = randomPosition(rnd, 1 + ((rnd() * 38) | 0));
    if (b.outcome().kind !== 'ongoing') continue;
    const before = b.toKey();
    const history = b.history;
    for (const difficulty of DIFFICULTIES) {
      const d = chooseMove(b, { ...opts(difficulty, g), timeBudgetMs: 15 });
      assertDecisionShape(d, b);
      assert.equal(b.toKey(), before, `${difficulty} mutated the board`);
      assert.deepEqual(b.history, history);
    }
  }
});

test('a tiny time budget still produces a legal, sensible move', () => {
  const b = Board.fromMoves([3, 3, 4, 2, 4, 5]);
  for (const difficulty of ['medium', 'hard', 'grandmaster']) {
    for (const timeBudgetMs of [0, 1, 2]) {
      const d = chooseMove(b, { difficulty, timeBudgetMs });
      assertDecisionShape(d, b);
      assert.ok(d.depth >= 1, 'depth 1 always completes, whatever the clock says');
    }
  }
});

/* -------------------------------------------------------------------------- */
/* what every rung promises                                                   */
/* -------------------------------------------------------------------------- */

test('every rung takes an available win in one, in every direction', () => {
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
    for (const difficulty of DIFFICULTIES) {
      // Seeded many times over: no rung may gamble a win it can already see.
      for (let seed = 0; seed < 40; seed++) {
        const d = chooseMove(b, opts(difficulty, seed * 7919 + 13));
        assert.equal(d.column, column, `${label}: ${difficulty} passed up the win\n${b}`);
        assert.equal(d.proven, 'win');
        assert.ok(d.score > 900000, `${label}: expected a mate score, got ${d.score}`);
      }
    }
  }
});

test('each rung covers an immediate threat at the rate its tuning promises', (t) => {
  // The whole ladder in one number. Easy is a child who has not learned to
  // look at the other player's discs yet; steady is learning and mostly
  // remembers; everything from medium up simply never misses.
  //
  // Ranges, not points: these are seeded frequencies, and a rung whose rate
  // drifted out of its band is a rung that changed character.
  const expected = [
    { difficulty: 'easy', trials: 1500, lo: 0.5, hi: 0.7 },
    { difficulty: 'steady', trials: 600, lo: 0.84, hi: 0.96 },
    { difficulty: 'medium', trials: 40, lo: 1, hi: 1 },
    { difficulty: 'hard', trials: 20, lo: 1, hi: 1 },
    { difficulty: 'grandmaster', trials: 20, lo: 1, hi: 1 },
  ];

  const b = mustBlock();
  assert.deepEqual(analyze(b).blockingMoves, [4]);
  assert.deepEqual(analyze(b).winningMoves, [], 'no rung may have a win to prefer instead');

  for (const { difficulty, trials, lo, hi } of expected) {
    let blocked = 0;
    for (let seed = 0; seed < trials; seed++) {
      const d = chooseMove(b, opts(difficulty, seed));
      assert.ok(b.canPlay(d.column));
      if (d.column === 4) blocked++;
    }
    const rate = blocked / trials;
    t.diagnostic(`${difficulty} blocks ${(rate * 100).toFixed(1)}% of ${trials}`);
    assert.ok(
      rate >= lo && rate <= hi,
      `${difficulty} blocked ${(rate * 100).toFixed(1)}%, wanted ${lo * 100}-${hi * 100}%`,
    );
  }
});

test('a seeded rung replays a whole game move for move', () => {
  // The transposition table survives between calls on purpose, so a replay is
  // only meaningful with it cleared: otherwise the second run starts from what
  // the first one learned. Cleared, every capped rung is a pure function of
  // (position, seed).
  const play = (difficulty, seed) => {
    const b = new Board();
    const rng = mulberry32(seed);
    while (b.outcome().kind === 'ongoing') {
      clearTranspositionTable();
      b.play(chooseMove(b, { difficulty, timeBudgetMs: BUDGET[difficulty], rng }).column);
    }
    return b.history;
  };

  for (const difficulty of ['easy', 'steady', 'medium', 'hard']) {
    assert.deepEqual(play(difficulty, 77), play(difficulty, 77), `${difficulty} is not seeded`);
  }
  // And the seed genuinely moves the needle on the rungs that carry noise.
  for (const difficulty of ['easy', 'steady', 'medium']) {
    assert.notDeepEqual(play(difficulty, 77), play(difficulty, 78), `${difficulty} ignores its rng`);
  }
});

/* -------------------------------------------------------------------------- */
/* easy: the bottom rung, deliberately left alone                             */
/* -------------------------------------------------------------------------- */

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

test('easy really does look elsewhere on the turns it fails to block', () => {
  // The 40% is honest: when easy skips the block it plays somewhere else
  // entirely, rather than stumbling onto the blocking column by accident.
  const b = mustBlock();
  let missed = 0;
  for (let seed = 0; seed < 400; seed++) {
    const d = chooseMove(b, opts('easy', seed));
    if (d.column !== 4) {
      missed++;
      assert.ok(b.canPlay(d.column));
    }
  }
  assert.ok(missed > 100, `expected easy to miss plenty of blocks, missed ${missed}`);
});

/* -------------------------------------------------------------------------- */
/* the upper rungs: safety the lower ones are not promised                    */
/* -------------------------------------------------------------------------- */

for (const difficulty of ['hard', 'grandmaster']) {
  test(`${difficulty} never walks into a one-move trap when it has an alternative`, () => {
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
      const d = chooseMove(b, { difficulty, timeBudgetMs: 40, rng: mulberry32(g) });
      assert.equal(
        report.trapMoves.includes(d.column),
        false,
        `${difficulty} played the trap ${d.column} with ${safe} available\n${b}`,
      );
    }
    assert.ok(checked > 15, `expected plenty of trap positions, tested ${checked}`);
  });
}

test('grandmaster finds a forced win through a double threat', () => {
  //   o . x x . . o    playing column 4 gives x threats at (1,0) and (5,0)
  const b = Board.fromMoves([2, 0, 3, 6]);
  assert.equal(b.toMove, Player.One);
  assert.deepEqual(analyze(b).winningMoves, [], 'nothing wins immediately');
  const d = chooseMove(b, { difficulty: 'grandmaster', timeBudgetMs: 200 });
  assert.equal(d.column, 4, `expected the double-threat move\n${b}`);
  assert.equal(d.proven, 'win');
  // and the win really is forced: whatever the opponent does, x mates next
  const after = b.clone();
  after.play(4);
  for (const reply of after.legalMoves()) {
    const line = after.clone();
    line.play(reply);
    assert.notEqual(
      line.winningMoveMask(line.toMove),
      0,
      `after the reply ${reply} x should still have a winning drop`,
    );
  }
});

test('grandmaster opens in the centre as first player', () => {
  const d = chooseMove(new Board(), { difficulty: 'grandmaster', timeBudgetMs: 900 });
  assert.equal(d.column, 3);
  assert.deepEqual(d.pv, [3]);
  assert.ok(d.elapsedMs < 50, 'the opening move should not burn the clock');
});

test('grandmaster uses no randomness', () => {
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
    const a = chooseMove(b, { difficulty: 'grandmaster', timeBudgetMs: 2000 });
    clearTranspositionTable();
    const z = chooseMove(b, {
      difficulty: 'grandmaster',
      timeBudgetMs: 2000,
      rng: mulberry32(g + 1),
    });

    assert.ok(a.proven !== undefined, `endgame should be solved\n${b}`);
    assert.equal(a.proven, z.proven);
    assert.equal(a.score, z.score, `score changed\n${b}`);
    assert.equal(a.column, z.column, `grandmaster flip-flopped\n${b}`);
    checked++;
  }
  assert.ok(checked >= 8, `only solved ${checked} endgames`);
});

test('grandmaster reports a proven loss when the position is already gone', () => {
  // x threatens row 0 at both column 2 and column 6; o cannot cover both.
  const b = Board.fromMoves([3, 0, 4, 0, 5]);
  assert.equal(b.toMove, Player.Two);
  assert.deepEqual(analyze(b).blockingMoves, [2, 6]);
  const d = chooseMove(b, { difficulty: 'grandmaster', timeBudgetMs: 100 });
  assert.equal(d.proven, 'loss');
  assert.ok(d.score < -900000);
  assert.ok(b.canPlay(d.column));
});

test('grandmaster uses roughly the budget it is given and searches deep', () => {
  clearTranspositionTable();
  const b = Board.fromMoves([3, 3, 4, 2, 4, 5, 2, 1]);
  const d = chooseMove(b, { difficulty: 'grandmaster', timeBudgetMs: 400 });
  // Generous bounds on purpose: this asserts that iterative deepening runs and
  // that the clock is respected, not the speed of whatever machine is running.
  assert.ok(d.elapsedMs <= 2000, `overran the budget badly: ${d.elapsedMs}ms`);
  assert.ok(d.depth >= 7, `expected a decent depth in 400ms, reached ${d.depth}`);
  assert.ok(d.nodes > 20000, `expected real work, only ${d.nodes} nodes`);
});

test('the depth cap, not the clock, is what holds the middle rungs back', () => {
  // If a rung ever stopped short of its cap here, every strength number in
  // this file would be measuring the machine instead of the tuning.
  const b = Board.fromMoves([3, 3, 4, 2, 4, 5, 2, 1]);
  const reached = {};
  for (const difficulty of ['steady', 'medium', 'hard']) {
    clearTranspositionTable();
    const d = chooseMove(b, opts(difficulty, 1));
    reached[difficulty] = d.depth;
  }
  assert.ok(reached.steady >= 2, `steady reached only ${reached.steady}`);
  assert.ok(reached.medium >= 5, `medium reached only ${reached.medium}`);
  assert.ok(reached.hard >= 8, `hard reached only ${reached.hard}`);
  assert.ok(reached.steady < reached.medium && reached.medium < reached.hard);
});

/* -------------------------------------------------------------------------- */
/* the ladder itself                                                          */
/* -------------------------------------------------------------------------- */

/** Two random plies, so a series explores the board instead of one pet line. */
function openingFrom(seed) {
  const rnd = mulberry32(seed);
  const b = new Board();
  for (let i = 0; i < 2; i++) {
    const legal = b.legalMoves();
    b.play(legal[(rnd() * legal.length) | 0]);
  }
  return b;
}

/**
 * Play one game from `start`; returns 'A', 'B' or 'draw'. `aFirst` decides who
 * moves next, and `start` is always an even number of plies in, so that is also
 * who plays Player One's discs.
 *
 * The transposition table is cleared before every move on purpose. It normally
 * survives between calls — Connect Four is a pure game, so an entry stays valid
 * — but in self-play that means the *weaker* rung is handed the stronger one's
 * deep entries and reads them back as its own, which flatters the ladder in
 * exactly the place it is being measured.
 */
function match(start, seed, aOpts, bOpts, aFirst) {
  const rngA = mulberry32(seed * 2 + 1);
  const rngB = mulberry32(seed * 2 + 2);
  const b = start.clone();
  let aToMove = aFirst;
  while (b.outcome().kind === 'ongoing') {
    clearTranspositionTable();
    const d = chooseMove(b, aToMove ? { ...aOpts, rng: rngA } : { ...bOpts, rng: rngB });
    assert.ok(b.canPlay(d.column), 'self-play produced an illegal move');
    b.play(d.column);
    aToMove = !aToMove;
  }
  const out = b.outcome();
  if (out.kind === 'draw') return 'draw';
  return (out.winner === Player.One) === aFirst ? 'A' : 'B';
}

/**
 * A seeded series. Every opening is played twice, once with each rung moving
 * first, so a start that happens to favour whoever moves cannot flatter either
 * side — without that pairing the result swings on which openings came up.
 */
function series(strong, weak, games) {
  const tally = { won: 0, lost: 0, drawn: 0 };
  for (let i = 0; i < games; i++) {
    const seed = ((i / 2) | 0) * 101 + 7;
    const r = match(
      openingFrom(seed),
      seed,
      { difficulty: strong, timeBudgetMs: BUDGET[strong] },
      { difficulty: weak, timeBudgetMs: BUDGET[weak] },
      i % 2 === 0,
    );
    if (r === 'A') tally.won++;
    else if (r === 'B') tally.lost++;
    else tally.drawn++;
  }
  return tally;
}

// The point of the whole change: a player who outgrows one rung has somewhere
// to go. Each pair is asserted separately so a failure names the step that
// collapsed. Two conditions, because either alone is weak: a rung must win
// well over half of all games *and* at least twice as often as it loses. Two
// rungs of equal strength land near 45/45/10 and clear neither.
const LADDER_PAIRS = [
  ['easy', 'steady', 60],
  ['steady', 'medium', 60],
  ['medium', 'hard', 40],
  ['hard', 'grandmaster', 24],
];

for (const [weak, strong, games] of LADDER_PAIRS) {
  test(`${strong} beats ${weak} over ${games} seeded games`, (t) => {
    const r = series(strong, weak, games);
    const pct = (n) => ((100 * n) / games).toFixed(0);
    t.diagnostic(
      `${strong} vs ${weak}: won ${pct(r.won)}% lost ${pct(r.lost)}% drew ${pct(r.drawn)}% ` +
        `(${r.won}/${r.lost}/${r.drawn})`,
    );
    assert.ok(
      r.won >= Math.ceil(games * 0.58),
      `${strong} won only ${r.won} of ${games} against ${weak} — the rungs are too close`,
    );
    assert.ok(
      r.won >= 2 * r.lost,
      `${strong} won ${r.won} to ${r.lost}: not the clear majority the ladder promises`,
    );
  });
}

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

test('every rung can finish a game against itself', () => {
  // A mirror match is where a rung's own blind spots meet: it must still
  // terminate, stay legal, and produce a real outcome.
  for (const difficulty of DIFFICULTIES) {
    const b = new Board();
    const rng = mulberry32(2024);
    while (b.outcome().kind === 'ongoing') {
      const d = chooseMove(b, { difficulty, timeBudgetMs: 15, rng });
      assertDecisionShape(d, b);
      b.play(d.column);
    }
    assert.ok(['win', 'draw'].includes(b.outcome().kind), `${difficulty} mirror match hung`);
  }
});
