// Threat analysis — the numbers Easy mode puts in front of a child, so every
// one of them is checked against an independent brute-force reference as well
// as against positions reasoned through by hand.
//
// Run with:  node --experimental-transform-types --test tests/threats.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import { Board } from '../src/engine/board.ts';
import { analyze, windows } from '../src/engine/threats.ts';
import { COLS, DIRECTIONS, Player, ROWS, cellIndex, other } from '../src/engine/types.ts';

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

/**
 * Build the pictured position. Rows are given TOP first: `x` = Player One,
 * `o` = Player Two, `.` = empty. Backtracks over move orders (memoised on the
 * height vector) and throws loudly if the picture could never occur in a game.
 */
function build(picture) {
  assert.equal(picture.length, ROWS, 'a picture needs 6 rows');
  const target = Array.from({ length: COLS }, () => new Array(ROWS).fill(null));
  picture.forEach((line, i) => {
    assert.equal(line.length, COLS, `row "${line}" must be 7 wide`);
    const row = ROWS - 1 - i;
    for (let c = 0; c < COLS; c++) {
      const ch = line[c];
      assert.ok(ch === 'x' || ch === 'o' || ch === '.', `unexpected character "${ch}"`);
      target[c][row] = ch === '.' ? null : ch;
    }
  });

  let total = 0;
  for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) if (target[c][r]) total++;

  const heights = new Array(COLS).fill(0);
  const moves = [];
  const dead = new Set();
  const dfs = (placed) => {
    if (placed === total) return true;
    const state = heights.reduce((a, h) => a * (ROWS + 1) + h, 0);
    if (dead.has(state)) return false;
    const want = placed % 2 === 0 ? 'x' : 'o';
    for (let c = 0; c < COLS; c++) {
      const r = heights[c];
      if (r >= ROWS || target[c][r] !== want) continue;
      heights[c]++;
      moves.push(c);
      if (dfs(placed + 1)) return true;
      heights[c]--;
      moves.pop();
    }
    dead.add(state);
    return false;
  };
  assert.ok(dfs(0), 'picture is not reachable by legal play');
  return Board.fromMoves(moves);
}

/** Everything analyze() should report, worked out the slow, obvious way. */
function reference(board) {
  const cells = board.cells();
  const at = (p) => cells[cellIndex(p.col, p.row)];
  const mover = board.toMove;
  const opponent = other(mover);

  const threats = [];
  for (const window of windows()) {
    const owners = new Set(window.map(at).filter((v) => v !== null));
    if (owners.size !== 1) continue; // empty, or dead because both colours are in it
    const owner = [...owners][0];
    const filled = window.filter((p) => at(p) === owner);
    if (filled.length < 2 || filled.length > 3) continue;
    const gaps = window.filter((p) => at(p) === null);
    threats.push({
      owner,
      count: filled.length,
      filled,
      gaps,
      immediateGaps: gaps.filter((p) => p.row === board.heightOf(p.col)),
      window,
    });
  }

  const winsFor = (player) => {
    const out = [];
    for (let c = 0; c < COLS; c++) {
      if (!board.canPlay(c)) continue;
      const probe = cells.slice();
      probe[cellIndex(c, board.heightOf(c))] = player;
      const won = windows().some((w) =>
        w.every((p) => probe[cellIndex(p.col, p.row)] === player),
      );
      const already = windows().some((w) =>
        w.every((p) => cells[cellIndex(p.col, p.row)] === player),
      );
      if (won && !already) out.push(c);
    }
    return out;
  };

  const winningMoves = winsFor(mover);
  const blockingMoves = winsFor(opponent);

  const trapMoves = [];
  for (let c = 0; c < COLS; c++) {
    if (!board.canPlay(c) || winningMoves.includes(c)) continue;
    const after = board.clone();
    after.play(c);
    const afterCells = after.cells();
    let opponentWins = false;
    for (let d = 0; d < COLS && !opponentWins; d++) {
      if (!after.canPlay(d)) continue;
      const probe = afterCells.slice();
      probe[cellIndex(d, after.heightOf(d))] = opponent;
      opponentWins = windows().some((w) =>
        w.every((p) => probe[cellIndex(p.col, p.row)] === opponent),
      );
    }
    if (opponentWins) trapMoves.push(c);
  }

  return { threats, winningMoves, blockingMoves, trapMoves };
}

/** Canonical string for one threat, so two reports can be compared as sets. */
const threatId = (t) =>
  `${t.count}|${t.owner}|${t.window.map((p) => `${p.col}${p.row}`).join('')}|` +
  `${t.filled.map((p) => `${p.col}${p.row}`).join('')}|` +
  `${t.gaps.map((p) => `${p.col}${p.row}`).join('')}|` +
  `${t.immediateGaps.map((p) => `${p.col}${p.row}`).join('')}`;

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

/* -------------------------------------------------------------------------- */
/* the window table                                                           */
/* -------------------------------------------------------------------------- */

test('windows() returns the 69 four-in-a-row windows', () => {
  const w = windows();
  assert.equal(w.length, 69);
  assert.equal(w, windows(), 'the table is shared, not rebuilt per call');
  for (const cells of w) {
    assert.equal(cells.length, 4);
    const dc = cells[1].col - cells[0].col;
    const dr = cells[1].row - cells[0].row;
    assert.ok(
      DIRECTIONS.some((d) => d.dc === dc && d.dr === dr),
      `(${dc},${dr}) is not a legal direction`,
    );
    for (let k = 1; k < 4; k++) {
      assert.equal(cells[k].col - cells[k - 1].col, dc);
      assert.equal(cells[k].row - cells[k - 1].row, dr);
    }
  }
});

/* -------------------------------------------------------------------------- */
/* hand-built positions                                                       */
/* -------------------------------------------------------------------------- */

test('a window holding both colours is dead and is never reported', () => {
  // x o x o along the bottom: [00 10 20 30] holds two of each, so it can never
  // become four and must not appear, even though it is "two in a row" twice.
  const b = build(['.......', '.......', '.......', '.......', '.......', 'xoxo...']);
  const report = analyze(b);
  assert.deepEqual(report.threats, []);
  assert.deepEqual(report.winningMoves, []);
  assert.deepEqual(report.blockingMoves, []);
  assert.deepEqual(report.trapMoves, []);
});

test('no reported threat ever contains an opponent disc', () => {
  const rnd = mulberry32(4242);
  for (let g = 0; g < 1500; g++) {
    const b = randomPosition(rnd, 1 + ((rnd() * 40) | 0));
    for (const t of analyze(b).threats) {
      const foreign = t.window.filter((p) => {
        const v = b.get(p.col, p.row);
        return v !== null && v !== t.owner;
      });
      assert.deepEqual(foreign, [], `dead window reported\n${b.toString()}`);
      assert.equal(t.filled.length, t.count);
      assert.equal(t.filled.length + t.gaps.length, 4);
      assert.ok(t.count === 2 || t.count === 3);
      for (const p of t.filled) assert.equal(b.get(p.col, p.row), t.owner);
      for (const p of t.gaps) assert.equal(b.get(p.col, p.row), null);
    }
  }
});

test('immediateGaps are exactly the gaps a disc would land on now', () => {
  // o holds row 1 columns 0-2, so its only gap is (3,1). Column 3 is empty, so
  // a disc dropped there lands at (3,0) — the gap is buried, not immediate.
  const b = build(['.......', '.......', '.......', '.......', 'ooo....', 'xxx.x..']);
  assert.equal(b.toMove, Player.Two);
  assert.equal(b.heightOf(3), 0);

  const report = analyze(b);
  const buried = report.threats.find(
    (t) => t.owner === Player.Two && t.count === 3 && t.direction === 'horizontal',
  );
  assert.ok(buried, 'expected the o row-1 triple');
  assert.deepEqual(buried.gaps, [{ col: 3, row: 1 }]);
  assert.deepEqual(buried.immediateGaps, [], 'a gap at row 1 over an empty column is buried');

  // x holds (0,0),(1,0),(2,0); its gap at (3,0) sits exactly on the stack top.
  const live = report.threats.find(
    (t) =>
      t.owner === Player.One &&
      t.count === 3 &&
      t.window[0].col === 0 &&
      t.window[0].row === 0,
  );
  assert.ok(live, 'expected the x row-0 triple');
  assert.deepEqual(live.gaps, [{ col: 3, row: 0 }]);
  assert.deepEqual(live.immediateGaps, [{ col: 3, row: 0 }]);

  // and every threat in the report obeys the rule
  for (const t of report.threats) {
    for (const g of t.gaps) {
      const immediate = t.immediateGaps.some((p) => p.col === g.col && p.row === g.row);
      assert.equal(immediate, g.row === b.heightOf(g.col), `(${g.col},${g.row})`);
    }
  }
});

test('a win of your own does not hide the threat you also have to cover', () => {
  //   . . . . . . .
  //   . . . . . . .
  //   . . . . . . .
  //   . . . . o . .     o is one disc from a vertical four at (4,3)
  //   . . . . o . .
  //   x x x . o . .     x is one disc from a horizontal four at (3,0)
  const b = build(['.......', '.......', '.......', '....o..', '....o..', 'xxx.o..']);
  assert.equal(b.toMove, Player.One);
  const report = analyze(b);

  assert.deepEqual(report.winningMoves, [3], 'x completes row 0 by dropping in column 3');
  assert.deepEqual(report.blockingMoves, [4], 'o would complete its column by dropping in 4');
  // Everything except the win and the block hands o the game.
  assert.deepEqual(report.trapMoves, [0, 1, 2, 5, 6]);

  assert.equal(report.threats.length, 3);
  assert.deepEqual(
    report.threats.map((t) => [t.count, t.owner, t.direction]),
    [
      [3, Player.One, 'horizontal'],
      [3, Player.Two, 'vertical'],
      [2, Player.Two, 'vertical'],
    ],
  );
});

test('a forced block: every other column is a trap', () => {
  //   . . . . . . .
  //   . . . . . . .
  //   . . . . . . .
  //   . . . . . . .
  //   x x . . . . .
  //   x o o o . . .     o completes row 0 by dropping in column 4
  const b = build(['.......', '.......', '.......', '.......', 'xx.....', 'xooo...']);
  assert.equal(b.toMove, Player.One);
  const report = analyze(b);

  assert.deepEqual(report.winningMoves, []);
  assert.deepEqual(report.blockingMoves, [4]);
  assert.deepEqual(report.trapMoves, [0, 1, 2, 3, 5, 6], 'only column 4 saves the game');

  // 3-o horizontal first, then the x pairs, then the o pair: count, owner,
  // direction, first cell.
  assert.deepEqual(
    report.threats.map((t) => [t.count, t.owner, t.direction]),
    [
      [3, Player.Two, 'horizontal'],
      [2, Player.One, 'horizontal'],
      [2, Player.One, 'vertical'],
      [2, Player.One, 'diagonal-up'],
      [2, Player.Two, 'horizontal'],
    ],
  );
  const forced = report.threats[0];
  assert.deepEqual(forced.filled, [
    { col: 1, row: 0 },
    { col: 2, row: 0 },
    { col: 3, row: 0 },
  ]);
  assert.deepEqual(forced.immediateGaps, [{ col: 4, row: 0 }]);
});

test('a winning move is never also reported as a trap', () => {
  //   o can finish its column at (3,3); every other column is quiet.
  const b = build(['.......', '.......', '.......', '...o...', '..xox..', '.xxoox.']);
  assert.equal(b.toMove, Player.Two);
  const report = analyze(b);
  assert.deepEqual(report.winningMoves, [3]);
  assert.deepEqual(report.blockingMoves, []);
  assert.deepEqual(report.trapMoves, []);
  for (const c of report.winningMoves) assert.equal(report.trapMoves.includes(c), false);
});

/* -------------------------------------------------------------------------- */
/* cross-checks against a brute-force reference                               */
/* -------------------------------------------------------------------------- */

test('analyze() matches a brute-force reference on thousands of positions', () => {
  const rnd = mulberry32(31337);
  let sawWin = 0;
  let sawBlock = 0;
  let sawTrap = 0;
  for (let g = 0; g < 2000; g++) {
    const b = randomPosition(rnd, 1 + ((rnd() * 40) | 0));
    const got = analyze(b);
    const want = reference(b);

    assert.deepEqual(got.winningMoves, want.winningMoves, `winning\n${b.toString()}`);
    assert.deepEqual(got.blockingMoves, want.blockingMoves, `blocking\n${b.toString()}`);
    assert.deepEqual(got.trapMoves, want.trapMoves, `traps\n${b.toString()}`);

    const gotIds = got.threats.map(threatId).sort();
    const wantIds = want.threats.map(threatId).sort();
    assert.deepEqual(gotIds, wantIds, `threats\n${b.toString()}`);

    if (got.winningMoves.length) sawWin++;
    if (got.blockingMoves.length) sawBlock++;
    if (got.trapMoves.length) sawTrap++;
  }
  assert.ok(sawWin > 100, `sample should contain wins, saw ${sawWin}`);
  assert.ok(sawBlock > 100, `sample should contain blocks, saw ${sawBlock}`);
  assert.ok(sawTrap > 100, `sample should contain traps, saw ${sawTrap}`);
});

test('winningMoves and blockingMoves are consistent with the board', () => {
  const rnd = mulberry32(2718);
  for (let g = 0; g < 1500; g++) {
    const b = randomPosition(rnd, 1 + ((rnd() * 40) | 0));
    const report = analyze(b);
    const mover = b.toMove;
    for (const c of report.winningMoves) {
      assert.ok(b.canPlay(c));
      assert.equal(b.isWinningMove(c, mover), true);
      const after = b.clone();
      after.play(c);
      const out = after.outcome();
      assert.equal(out.kind, 'win');
      assert.equal(out.winner, mover);
    }
    for (const c of report.blockingMoves) {
      assert.ok(b.canPlay(c));
      assert.equal(b.isWinningMove(c, other(mover)), true);
    }
    for (const c of report.trapMoves) {
      assert.ok(b.canPlay(c));
      assert.equal(report.winningMoves.includes(c), false, 'a win is never a trap');
      const after = b.clone();
      after.play(c);
      assert.notEqual(after.winningMoveMask(after.toMove), 0);
    }
    // every legal column is exactly one of: winning, trap, or safe-for-now
    for (let c = 0; c < COLS; c++) {
      if (!b.canPlay(c)) {
        assert.equal(report.winningMoves.includes(c), false);
        assert.equal(report.trapMoves.includes(c), false);
        assert.equal(report.blockingMoves.includes(c), false);
      }
    }
  }
});

test('threats are sorted deterministically so the overlay cannot flicker', () => {
  const rank = Object.fromEntries(DIRECTIONS.map((d, i) => [d.name, i]));
  const rnd = mulberry32(6060);
  for (let g = 0; g < 800; g++) {
    const b = randomPosition(rnd, 1 + ((rnd() * 40) | 0));
    const first = analyze(b);
    const second = analyze(b.clone());
    assert.deepEqual(first.threats.map(threatId), second.threats.map(threatId));

    for (let i = 1; i < first.threats.length; i++) {
      const a = first.threats[i - 1];
      const z = first.threats[i];
      const keyOf = (t) => [
        -t.count,
        t.owner,
        rank[t.direction],
        cellIndex(t.window[0].col, t.window[0].row),
      ];
      const ka = keyOf(a);
      const kz = keyOf(z);
      let ordered = false;
      for (let k = 0; k < ka.length; k++) {
        if (ka[k] !== kz[k]) {
          ordered = ka[k] < kz[k];
          break;
        }
      }
      assert.ok(ordered, `threats ${i - 1} and ${i} are out of order\n${b.toString()}`);
    }
  }
});

test('analyze() leaves the board exactly as it found it', () => {
  const rnd = mulberry32(1618);
  for (let g = 0; g < 500; g++) {
    const b = randomPosition(rnd, 1 + ((rnd() * 40) | 0));
    const before = b.toKey();
    const history = b.history;
    analyze(b);
    assert.equal(b.toKey(), before);
    assert.deepEqual(b.history, history);
  }
});

test('an empty board has nothing to teach', () => {
  const report = analyze(new Board());
  assert.deepEqual(report, {
    threats: [],
    winningMoves: [],
    blockingMoves: [],
    trapMoves: [],
  });
});
