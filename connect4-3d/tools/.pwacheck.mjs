// Throwaway: does the PWA actually install and run with the network cut?
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ARGS = [
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist', '--disable-dev-shm-usage', '--mute-audio',
];

const server = spawn('npx', ['vite', 'preview', '--port', '5233'], { stdio: ['ignore', 'pipe', 'pipe'] });
const url = await new Promise((res, rej) => {
  const f = (b) => { const m = /(http:\/\/localhost:\d+)/.exec(b.toString()); if (m) res(m[1]); };
  server.stdout.on('data', f); server.stderr.on('data', f);
  setTimeout(() => rej(new Error('no server')), 30_000);
});

const browser = await chromium.launch({ executablePath: CHROME, args: ARGS });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const page = await context.newPage();

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__c4?.ready === true, null, { timeout: 300_000 });

  // The manifest the installer reads.
  const manifest = await page.evaluate(async () => {
    const link = document.querySelector('link[rel="manifest"]');
    if (!link) return { error: 'no manifest link' };
    const r = await fetch(link.href);
    if (!r.ok) return { error: `manifest ${r.status}` };
    const m = await r.json();
    return { name: m.name, display: m.display, icons: (m.icons || []).length };
  });
  console.log('manifest:', JSON.stringify(manifest));

  const iconOk = await page.evaluate(async () => {
    const r = await fetch('./icons/icon-512.png');
    return `${r.status} ${r.headers.get('content-type')}`;
  });
  console.log('icon-512:', iconOk);

  // Wait for the service worker to take control and finish precaching.
  const sw = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return 'unsupported';
    const reg = await navigator.serviceWorker.ready.catch(() => null);
    if (!reg) return 'no registration';
    for (let i = 0; i < 60 && !navigator.serviceWorker.controller; i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
    return navigator.serviceWorker.controller ? 'controlling' : 'registered but not controlling';
  });
  console.log('service worker:', sw);

  // Cut the network and reload from cache alone.
  await context.setOffline(true);
  console.log('network: offline');
  let offlineOk = false;
  let offlineErr = '';
  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForFunction(() => window.__c4?.ready === true, null, { timeout: 300_000 });
    offlineOk = true;
  } catch (e) {
    offlineErr = e.message.split('\n')[0];
  }
  console.log(offlineOk ? 'OFFLINE RELOAD: ok — the game boots with no network' : `OFFLINE RELOAD: FAILED — ${offlineErr}`);

  if (offlineOk) {
    const s = await page.evaluate(() => window.__c4.state());
    console.log(`offline state: phase=${s.phase} heights=${JSON.stringify(s.heights)}`);
  }
} finally {
  await browser.close();
  server.kill();
}
