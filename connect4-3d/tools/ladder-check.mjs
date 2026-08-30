/**
 * Does every rung of the difficulty ladder actually play through the real UI?
 *
 * The unit tests prove `chooseMove` handles all five. What they cannot prove is
 * that the names survive the trip from the title screen, through the
 * controller, across the worker boundary and back — which is exactly where a
 * widened union falls through a stale branch. Exhaustive `Record<Difficulty,…>`
 * types catch most of that at compile time; this catches the rest.
 *
 * Deliberately tiny viewport: this is a wiring check, not a beauty pass, and a
 * frame at 360x260 costs a fraction of one at retina size on a software
 * rasteriser. Progress is appended to `ladder-result.txt` as it happens, because
 * Node buffers stdout to a pipe and a killed run otherwise reports nothing at
 * all — which is the least useful possible outcome for a slow test.
 *
 *   npm run ladder
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';

const LOG = 'ladder-result.txt';
writeFileSync(LOG, '');
const say = (m) => { console.log(m); appendFileSync(LOG, m + '\n'); };

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ARGS = [
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist', '--disable-dev-shm-usage', '--mute-audio',
];

const server = spawn('npx', ['vite', 'preview', '--port', '4188'], { stdio: ['ignore', 'pipe', 'pipe'] });
const url = await new Promise((res, rej) => {
  const f = (b) => { const m = /(http:\/\/localhost:\d+)/.exec(b.toString()); if (m) res(m[1]); };
  server.stdout.on('data', f); server.stderr.on('data', f);
  setTimeout(() => rej(new Error('no server')), 30_000);
});

const browser = await chromium.launch({ executablePath: CHROME, args: ARGS });
const page = await browser.newPage({ viewport: { width: 360, height: 260 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

let failures = 0;
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__c4?.ready === true, null, { timeout: 300_000 });
  say('booted');

  for (const rung of ['easy', 'steady', 'medium', 'hard', 'grandmaster']) {
    const t0 = Date.now();
    await page.evaluate((d) => window.__c4.startVsComputer(d), rung);
    await page.evaluate(() => window.__c4.click(3));
    let state = null;
    try {
      await page.waitForFunction(() => window.__c4.state().moveCount >= 2, null, { timeout: 90_000 });
      state = await page.evaluate(() => window.__c4.state());
    } catch {
      // fall through to the failure branch below
    }
    const ok = state && state.moveCount >= 2 && state.history[1] >= 0 && state.history[1] <= 6;
    if (!ok) failures++;
    say(
      `  ${ok ? 'ok  ' : 'FAIL'} ${rung.padEnd(12)} ` +
        (state ? `reply=col ${state.history[1] + 1}  moves=${state.moveCount}` : 'no reply') +
        `  (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
    );
  }

  const real = errors.filter((e) => !/404|Failed to load resource/.test(e));
  say(`console: ${real.length} real error(s)`);
  for (const e of real.slice(0, 4)) console.log('   ', e);
  if (real.length) failures++;
} finally {
  await browser.close();
  server.kill();
}

say(failures ? `${failures} FAILURE(S)` : 'every rung replied with a legal move');
process.exitCode = failures ? 1 : 0;
