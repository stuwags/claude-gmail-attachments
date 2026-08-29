import { chromium } from 'playwright';

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const LAUNCH_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--disable-dev-shm-usage',
  '--hide-scrollbars',
  '--mute-audio',
];

const url = process.argv[2] ?? 'http://localhost:4188';
const waitMs = Number(process.argv[3] ?? 300000);

const browser = await chromium.launch({ executablePath: CHROME, args: LAUNCH_ARGS });
const context = await browser.newContext({
  width: 1440, height: 900, deviceScaleFactor: 2, colorScheme: 'dark', reducedMotion: 'no-preference',
});
const page = await context.newPage();
page.on('console', (m) => console.log(`[console.${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}\n${e.stack}`));

const t0 = Date.now();
await page.goto(url, { waitUntil: 'domcontentloaded' });
try {
  await page.waitForFunction(() => window.__c4?.ready === true, null, { timeout: waitMs });
  console.log(`ready in ${Date.now() - t0}ms`);
} catch (e) {
  console.log(`NOT READY after ${Date.now() - t0}ms: ${e.message}`);
}
console.log(await page.evaluate(() => ({
  hasHook: !!window.__c4,
  ready: window.__c4?.ready,
  stats: window.__c4?.stats?.(),
})));
await browser.close();
