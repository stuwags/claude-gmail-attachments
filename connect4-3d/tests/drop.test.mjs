// Drop physics: the closed-form ballistics the renderer animates discs with.
//
// These assert the timing budget from docs/ART_BIBLE.md §5.2 against the board's
// real geometry, because "feels weighty" is only reproducible if the numbers
// behind it are pinned.
//
// Run with:  node --experimental-transform-types --test tests/drop.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import { DropTrack, DEFAULT_TUNING, estimateDropDuration } from '../src/physics/drop.ts';
import { RELEASE_Y, rowY } from '../src/render/layout.ts';

const FULL_DROP_START = RELEASE_Y;
const FULL_DROP_REST = rowY(0);

/** Sample a track at `n` evenly spaced times through its duration. */
function samples(track, n = 200) {
  const out = [];
  for (let i = 0; i <= n; i++) out.push(track.sample((track.duration * i) / n));
  return out;
}

test('a full-height drop lands and settles inside the bible budget', () => {
  const track = new DropTrack(FULL_DROP_START, FULL_DROP_REST);

  // Real gravity at real scale: a third of a metre takes about a fifth of a
  // second. Anything much slower reads as floating rather than falling.
  assert.ok(
    track.landingTime > 0.19 && track.landingTime < 0.24,
    `landing at ${(track.landingTime * 1000).toFixed(0)}ms, expected 190-240ms`,
  );

  // Bible §5.2: "Everything settled inside 480 ms."
  assert.ok(
    track.duration <= 0.48,
    `settles at ${(track.duration * 1000).toFixed(0)}ms, budget is 480ms`,
  );
});

test('impact speed and rebound follow the stated restitution', () => {
  const track = new DropTrack(FULL_DROP_START, FULL_DROP_REST);
  const [landing, ...bounces] = track.impacts;

  const fall = FULL_DROP_START - FULL_DROP_REST;
  const expected = Math.sqrt(
    DEFAULT_TUNING.releaseVelocity ** 2 + 2 * DEFAULT_TUNING.gravity * fall,
  );
  assert.ok(
    Math.abs(landing.speed - expected) < 1e-6,
    `impact ${landing.speed} != energy-derived ${expected}`,
  );

  // 0.18 restitution on a 2.5 m/s impact is roughly a centimetre of rebound —
  // a real disc barely bounces, and a bouncy one reads as plastic, not ceramic.
  assert.ok(bounces.length >= 1, 'expected at least one visible bounce');
  const rebound = bounces[0].speed;
  assert.ok(
    Math.abs(rebound - landing.speed * DEFAULT_TUNING.restitution) < 1e-9,
    'first rebound should be exactly restitution x impact speed',
  );

  // Every later bounce must be slower, and the sequence must terminate.
  for (let i = 1; i < bounces.length; i++) {
    assert.ok(bounces[i].speed < bounces[i - 1].speed, 'bounces must decay');
  }
  assert.ok(bounces.length <= DEFAULT_TUNING.maxBounces, 'bounce count is capped');
});

test('the disc never passes through the floor of its cell', () => {
  const track = new DropTrack(FULL_DROP_START, FULL_DROP_REST);
  for (const s of samples(track, 500)) {
    assert.ok(
      s.y >= FULL_DROP_REST - 1e-9,
      `disc reached ${s.y}, below rest height ${FULL_DROP_REST}`,
    );
    assert.ok(s.y <= FULL_DROP_START + 1e-9, 'disc rose above its release height');
  }
});

test('free fall is monotonic before first contact', () => {
  const track = new DropTrack(FULL_DROP_START, FULL_DROP_REST);
  let previous = Infinity;
  for (let i = 0; i <= 60; i++) {
    const t = (track.landingTime * i) / 60;
    const { y } = track.sample(t);
    assert.ok(y <= previous + 1e-9, 'disc must not rise while falling');
    previous = y;
  }
});

test('the disc is at rest, level, and settled at the end', () => {
  const track = new DropTrack(FULL_DROP_START, FULL_DROP_REST);
  const end = track.sample(track.duration);
  assert.ok(end.settled, 'should report settled at duration');
  assert.ok(Math.abs(end.y - FULL_DROP_REST) < 1e-9, 'should rest exactly in its cell');
  // The roll must be visually gone, or discs appear to twitch forever.
  assert.ok(Math.abs(end.roll) < 0.002, `roll ${end.roll} still visible at rest`);
});

test('a drop into a full column is instantaneous rather than degenerate', () => {
  // Landing height equals release height: no fall, no NaN, no negative time.
  const track = new DropTrack(FULL_DROP_REST, FULL_DROP_REST);
  assert.ok(Number.isFinite(track.duration), 'duration must be finite');
  assert.equal(track.landingTime, 0);
  const s = track.sample(0.01);
  assert.ok(Number.isFinite(s.y) && Number.isFinite(s.roll), 'state must be finite');
});

test('shorter drops settle sooner than tall ones', () => {
  const tall = estimateDropDuration(FULL_DROP_START, rowY(0));
  const short = estimateDropDuration(FULL_DROP_START, rowY(5));
  assert.ok(short < tall, 'a disc landing on a tall stack should settle first');
});

test('sampling is deterministic for a given seed', () => {
  const a = new DropTrack(FULL_DROP_START, FULL_DROP_REST, DEFAULT_TUNING, 3);
  const b = new DropTrack(FULL_DROP_START, FULL_DROP_REST, DEFAULT_TUNING, 3);
  for (let i = 0; i <= 50; i++) {
    const t = (a.duration * i) / 50;
    assert.deepEqual(a.sample(t), b.sample(t), 'same seed must give identical motion');
  }
});

test('different seeds rattle differently', () => {
  const a = new DropTrack(FULL_DROP_START, FULL_DROP_REST, DEFAULT_TUNING, 1);
  const b = new DropTrack(FULL_DROP_START, FULL_DROP_REST, DEFAULT_TUNING, 2);
  const t = a.landingTime + 0.05;
  assert.notEqual(a.sample(t).roll, b.sample(t).roll, 'seeds should vary the roll phase');
});

test('roll amplitude never exceeds the specified 1.2 degrees', () => {
  const track = new DropTrack(FULL_DROP_START, FULL_DROP_REST);
  for (const s of samples(track, 800)) {
    assert.ok(
      Math.abs(s.roll) <= DEFAULT_TUNING.rollAmplitude + 1e-9,
      `roll ${s.roll} exceeds the ${DEFAULT_TUNING.rollAmplitude} rad limit`,
    );
  }
});
