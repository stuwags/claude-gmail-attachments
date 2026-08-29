import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ARGS = [
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist', '--disable-dev-shm-usage', '--hide-scrollbars', '--mute-audio',
];

const url = process.argv[2];
await mkdir('shots-budget', { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, args: ARGS });
const context = await browser.newContext({
  width: 1440, height: 900, deviceScaleFactor: 2, colorScheme: 'dark', reducedMotion: 'no-preference',
});
const page = await context.newPage();
const msgs = [];
page.on('console', (m) => { if (m.type() !== 'log') msgs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => msgs.push(`[pageerror] ${e.message}\n${e.stack}`));

await page.goto(url + '/tools/.tmp/budget.html', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__probe?.ready === true, null, { timeout: 600000 });

async function measure(nDiscs) {
  return page.evaluate(async (n) => {
    const view = window.__probe.view;
    const cells = new Array(42).fill(null);
    let placed = 0;
    outer: for (let c = 0; c < 7; c++) {
      for (let r = 0; r < 6; r++) {
        if (placed >= n) break outer;
        cells[c * 6 + r] = placed % 2;
        placed++;
      }
    }
    view.setPosition(cells);
    await view.waitFrames(3);
    return view.stats();
  }, nDiscs);
}

const out = {};
out.discs0 = await measure(0);
out.discs21 = await measure(21);
out.discs42 = await measure(42);
await page.screenshot({ path: 'shots-budget/probe-full.png' });

// Hover state: ghost + rim strokes lit.
out.hover42 = await page.evaluate(async () => {
  const view = window.__probe.view;
  view.setHover(3, 5, 0);
  await view.waitFrames(20);
  return view.stats();
});
await page.screenshot({ path: 'shots-budget/probe-hover.png' });

// Win presentation.
out.win = await page.evaluate(async () => {
  const view = window.__probe.view;
  view.setHover(null, null, 0);
  view.showWin([{col:0,row:0},{col:1,row:0},{col:2,row:0},{col:3,row:0}], 0);
  await view.waitFrames(90);
  return view.stats();
});
await page.screenshot({ path: 'shots-budget/probe-win.png' });

// A pointer pick sanity check and a live drop.
out.pick = await page.evaluate(() => {
  const view = window.__probe.view;
  const samples = {};
  for (const x of [-0.9, -0.4, 0, 0.4, 0.9]) samples[x] = view.columnAtPointer(x, 0);
  samples.offBoard = view.columnAtPointer(0, 0.95);
  return samples;
});

out.dropImpacts = await page.evaluate(async () => {
  const view = window.__probe.view;
  const impacts = [];
  const off = view.onImpact((i) => impacts.push({ index: i.index, speed: +i.speed.toFixed(3), lead: +i.lead.toFixed(4) }));
  view.clearOutcome();
  view.setPosition(new Array(42).fill(null));
  await view.waitFrames(2);
  const t0 = performance.now();
  await view.dropDisc(0, 0, 0);
  const ms = performance.now() - t0;
  off();
  return { impacts, wallMs: Math.round(ms) };
});

console.log(JSON.stringify(out, null, 2));
if (msgs.length) console.log('MESSAGES:\n' + msgs.slice(0, 25).join('\n'));
await browser.close();
