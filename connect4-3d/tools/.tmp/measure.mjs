import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--disable-dev-shm-usage',
  '--hide-scrollbars',
  '--mute-audio',
];

const url = process.argv[2] ?? 'http://localhost:4188';
await mkdir('shots-budget', { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, args: ARGS });
const context = await browser.newContext({
  width: 1440, height: 900, deviceScaleFactor: 2, colorScheme: 'dark', reducedMotion: 'no-preference',
});
const page = await context.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__c4?.ready === true, null, { timeout: 400000 });

const report = {};

// Empty board.
await page.evaluate(async () => { await window.__c4.reset({ difficulty: 'medium' }); await window.__c4.settle(); });
report.empty = await page.evaluate(() => window.__c4.stats());
await page.screenshot({ path: 'shots-budget/empty.png' });

// Midgame.
await page.evaluate(async () => {
  await window.__c4.reset({ difficulty: 'medium' });
  await window.__c4.playMoves([3, 3, 4, 2, 4, 4, 2, 5, 1, 2]);
  await window.__c4.settle();
});
report.midgame = await page.evaluate(() => window.__c4.stats());
await page.screenshot({ path: 'shots-budget/midgame.png' });

// Worst case: fill the board with setPosition, all 42 cells.
report.full = await page.evaluate(async () => {
  const view = window.__c4.__view;
  if (!view) return 'no view handle';
  const cells = new Array(42);
  for (let c = 0; c < 7; c++) for (let r = 0; r < 6; r++) cells[c * 6 + r] = (c + r) % 2;
  view.setPosition(cells);
  await view.waitFrames(4);
  return view.stats();
});
await page.screenshot({ path: 'shots-budget/full.png' });

console.log(JSON.stringify(report, null, 2));
if (errors.length) console.log('MESSAGES:\n' + errors.slice(0, 20).join('\n'));
await browser.close();
