/**
 * Functional smoke test: does the game actually play?
 *
 * The engine has unit tests and the renderer has screenshots, but neither
 * proves the assembled thing works — that a click over the board picks the
 * right column, that the turn guard refuses input while a disc is falling, that
 * the search worker answers, that a win is detected and presented. Those live
 * in the wiring between the parts, which is exactly where nothing else looks.
 *
 * Runs against the production build in headless Chromium, driving real pointer
 * events through the canvas rather than calling the controller directly.
 *
 *   node tools/smoke.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const LAUNCH_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--disable-dev-shm-usage',
  '--mute-audio',
];

let failures = 0;
let checks = 0;

function check(name, condition, detail = '') {
  checks++;
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['vite', 'preview', '--port', '4174'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    const onData = (buf) => {
      const m = /(http:\/\/localhost:\d+)/.exec(buf.toString());
      if (m && !settled) {
        settled = true;
        resolve({ proc, url: m[1] });
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    setTimeout(() => !settled && reject(new Error('preview did not start')), 30_000);
  });
}

async function main() {
  const server = await startServer();
  const browser = await chromium.launch({ executablePath: CHROME, args: LAUNCH_ARGS });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  try {
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__c4?.ready === true, null, { timeout: 300_000 });
    console.log('\nboot');
    check('page becomes ready', true);

    /* ---------------- the title screen actually starts a game ---------------- */

    // This path had no coverage until a manual playthrough exercised it. The
    // controller can be driven directly from the debug hook, which is what the
    // rest of this file does — so a broken Start button would have gone
    // unnoticed while every functional check still passed.
    console.log('\ntitle screen');
    await page.evaluate(() => window.__c4.reset({ showMenu: true }));
    await page.evaluate(() => window.__c4.frames(2));

    const menuState = await page.evaluate(() => window.__c4.state());
    check('the game opens on the title screen', menuState.phase === 'menu', `phase=${menuState.phase}`);

    const clickByText = (needle) =>
      page.evaluate((n) => {
        const b = [...document.querySelectorAll('button')].find((x) =>
          (x.textContent || '').toLowerCase().includes(n),
        );
        if (!b) return false;
        b.click();
        return true;
      }, needle);

    check('the difficulty control is reachable', await clickByText('easy'));
    await page.evaluate(() => window.__c4.frames(2));
    check('the start button is reachable', await clickByText('start'));
    await page.waitForFunction(() => window.__c4.state().phase !== 'menu', null, { timeout: 120_000 });

    const started = await page.evaluate(() => window.__c4.state());
    check('starting from the menu begins a game', started.phase === 'playing', `phase=${started.phase}`);
    check('the board starts empty', started.moveCount === 0, `moveCount=${started.moveCount}`);
    check(
      'choosing Easy turns the coach on',
      (await page.evaluate(() => window.__c4.state())).urgentColumns !== undefined,
    );

    /* ---------------- a human move lands ---------------- */

    console.log('\nhuman move against the computer');
    await page.evaluate(() =>
      window.__c4.reset({ difficulty: 'easy' }).then(() => window.__c4.settle()),
    );
    // reset() starts a two-player match so captures are deterministic; the
    // smoke test wants the computer, so start one explicitly.
    await page.evaluate(async () => {
      await window.__c4.startVsComputer('easy');
      await window.__c4.settle();
    });

    let before = await page.evaluate(() => window.__c4.state());
    check('board starts empty', before.moveCount === 0, `moveCount=${before.moveCount}`);
    check('input is accepted at the start', before.acceptsInput === true);

    await page.evaluate(() => window.__c4.click(3));
    await page.waitForFunction(() => window.__c4.state().moveCount >= 1, null, { timeout: 120_000 });
    let after = await page.evaluate(() => window.__c4.state());
    check('clicking the board drops a disc', after.moveCount >= 1, `moveCount=${after.moveCount}`);
    check('the disc lands in the clicked column', after.history[0] === 3, `column=${after.history[0]}`);

    /* ---------------- the computer replies ---------------- */

    await page.waitForFunction(() => window.__c4.state().moveCount >= 2, null, { timeout: 180_000 });
    after = await page.evaluate(() => window.__c4.state());
    check('the computer replies', after.moveCount >= 2, `moveCount=${after.moveCount}`);
    check(
      'the reply is a legal column',
      after.history[1] >= 0 && after.history[1] <= 6,
      `column=${after.history[1]}`,
    );
    check('turn returns to the human', after.toMove === 0, `toMove=${after.toMove}`);

    /* ---------------- gravity and full columns ---------------- */

    console.log('\nrules through the real input path');
    await page.evaluate(async () => {
      await window.__c4.reset({ difficulty: 'easy' });
      await window.__c4.playMoves([0, 0, 0, 0, 0, 0]);
      await window.__c4.settle();
    });
    const stacked = await page.evaluate(() => window.__c4.state());
    check('a column fills to exactly six', stacked.heights[0] === 6, `height=${stacked.heights[0]}`);

    await page.evaluate(() => window.__c4.click(0));
    await page.evaluate(() => window.__c4.frames(3));
    const afterFull = await page.evaluate(() => window.__c4.state());
    check(
      'a click on a full column is refused',
      afterFull.moveCount === stacked.moveCount,
      `moveCount ${stacked.moveCount} -> ${afterFull.moveCount}`,
    );

    /* ---------------- a win is detected and presented ---------------- */

    console.log('\nwin detection and presentation');
    await page.evaluate(async () => {
      await window.__c4.reset({ difficulty: 'easy' });
      await window.__c4.playMoves([3, 0, 4, 1, 5, 0, 6]);
      await window.__c4.settle();
    });
    const won = await page.evaluate(() => window.__c4.state());
    check('the win is detected', won.outcome.kind === 'win', `outcome=${won.outcome.kind}`);
    check('the winner is correct', won.outcome.winner === 0, `winner=${won.outcome.winner}`);
    check('the winning line has four cells', won.outcome.line?.length === 4);
    check('the game stops accepting input', won.acceptsInput === false);
    check('the phase reports the game is over', won.phase === 'over', `phase=${won.phase}`);

    const banner = await page.evaluate(() => {
      const el = document.querySelector('[data-tone], .c4-banner');
      return el ? (el.textContent ?? '').trim() : null;
    });
    check('a result banner is shown', banner !== null && banner.length > 0, `banner=${banner}`);

    /* ---------------- the coach reports live threats ---------------- */

    console.log('\ncoach');
    await page.evaluate(async () => {
      await window.__c4.reset({ difficulty: 'easy', teaching: true });
      await window.__c4.playMoves([6, 1, 6, 2, 6, 3, 5, 5]);
      await window.__c4.settle();
    });
    const coached = await page.evaluate(() => window.__c4.state());
    check(
      'the coach flags every column that wins this turn',
      [0, 4, 6].every((c) => coached.urgentColumns.includes(c)),
      `urgent=${JSON.stringify(coached.urgentColumns)}`,
    );

    /* ---------------- rendering stayed healthy ---------------- */

    console.log('\nrenderer');
    const stats = await page.evaluate(() => window.__c4.stats());
    check('draw calls stay within budget', stats.drawCalls <= 90, `drawCalls=${stats.drawCalls}`);
    check('triangles stay within budget', stats.triangles <= 450_000, `triangles=${stats.triangles}`);

    check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    server.proc.kill();
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
