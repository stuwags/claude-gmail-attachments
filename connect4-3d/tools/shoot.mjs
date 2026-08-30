/**
 * Visual capture harness.
 *
 * Boots the built game in headless Chromium, drives it through `window.__c4`
 * (the debug hook installed by src/main.ts), and writes PNGs to `shots/`.
 * This is how the look of the game gets reviewed: against real frames, at real
 * device resolutions, rather than by imagining what the shader does.
 *
 *   node tools/shoot.mjs                    # every scene, both devices
 *   node tools/shoot.mjs --scene=midgame    # one scene
 *   node tools/shoot.mjs --device=ipad      # one device
 *   node tools/shoot.mjs --url=http://…     # against an already-running server
 *   node tools/shoot.mjs --dpr=1            # iteration pass; 2 is the review pass
 *   node tools/shoot.mjs --reduced=1        # the prefers-reduced-motion build
 *
 * Rendering is SwiftShader here, so frames are slow but pixel-accurate. Timings
 * printed by this tool say nothing about real GPU performance.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'shots');

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

/**
 * Logical sizes and DPR of the two devices this game targets.
 *
 * `viewport` has to be nested: Playwright silently ignores stray top-level
 * `width`/`height` keys on a context, so a flat object would quietly capture
 * every shot at the default 1280x720 while claiming to be a Retina Mac.
 */
const DEVICES = {
  mac: {
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    isMobile: false,
    hasTouch: false,
  },
  ipad: {
    viewport: { width: 1180, height: 820 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
};

/**
 * Each scene drives the game into a state worth looking at. The body runs in
 * the page with `__c4` in scope, and resolves once the scene has settled.
 */
const SCENES = {
  /** Opening menu — first impression, title treatment, material read. */
  menu: async (c4) => {
    await c4.reset({ difficulty: 'medium', showMenu: true });
    await c4.settle();
  },

  /** Empty board, in play. Shows the set, lighting, and board material. */
  empty: async (c4) => {
    await c4.reset({ difficulty: 'medium' });
    await c4.settle();
  },

  /** A believable midgame. The main "is this pretty" reference frame. */
  midgame: async (c4) => {
    await c4.reset({ difficulty: 'medium' });
    await c4.playMoves([3, 3, 4, 2, 4, 4, 2, 5, 1, 2]);
    await c4.settle();
  },

  /** Mid-drop: catches a disc in the air with motion blur and contact shadow. */
  dropping: async (c4) => {
    await c4.reset({ difficulty: 'medium' });
    await c4.playMoves([3, 3, 4, 2, 4, 4]);
    await c4.settle();
    await c4.beginDrop(2);
    await c4.frames(9);
  },

  /**
   * Easy mode teaching overlay, on a position built to exercise it fully.
   *
   * Ember to move, holding a vertical three in column 7 with a playable gap
   * above it (class A1, "you win here"); Petrol holding an OPEN three along the
   * bottom with playable gaps at both ends (class A2, and the loudest thing the
   * coach ever shows). Three urgent ghosts against a budget of two, so the
   * frame also demonstrates the noise cap dropping the lowest-priority one.
   *
   * The previous fixture was simply wrong: it played Ember into four in a row,
   * so every capture of it was a finished game with the result banner up and no
   * coach elements at all.
   */
  teaching: async (c4) => {
    await c4.reset({ difficulty: 'easy', teaching: true });
    await c4.playMoves([6, 1, 6, 2, 6, 3, 5, 5]);
    await c4.settle();
  },

  /** The moment a win resolves — winning line lit, rest of board receding. */
  win: async (c4) => {
    await c4.reset({ difficulty: 'medium' });
    await c4.playMoves([3, 0, 4, 1, 5, 0, 6]);
    await c4.settle();
    await c4.frames(48);
  },

  /**
   * The two parallax extremes. Between them they answer three separate
   * acceptance questions: whether the backdrop still fills the frame at the
   * limits of the camera's travel, whether the acrylic shows refraction at a
   * grazing angle, and whether the corner discs gain and lose their catchlight
   * windows as the reflection geometry swings — which is the payoff for letting
   * an aperture clip a highlight honestly rather than compensating for it.
   */
  'parallax-max': async (c4) => {
    await c4.reset({ difficulty: 'medium' });
    await c4.playMoves([3, 3, 4, 2, 4, 4, 2, 5, 1, 2]);
    await c4.setParallax(1, 1);
  },
  'parallax-min': async (c4) => {
    await c4.reset({ difficulty: 'medium' });
    await c4.playMoves([3, 3, 4, 2, 4, 4, 2, 5, 1, 2]);
    await c4.setParallax(-1, -1);
  },

  /**
   * The bloom A/B pair. Item 9 is graded by differencing these against their
   * normal counterparts: bloom may change specular cores and the win filament
   * and nothing else, so a mid-grey backdrop or a disc body that moves between
   * the two frames fails it outright. Same state, same seed, one pass disabled.
   */
  'midgame-nobloom': async (c4) => {
    await c4.reset({ difficulty: 'medium' });
    await c4.playMoves([3, 3, 4, 2, 4, 4, 2, 5, 1, 2]);
    await c4.settle();
    await c4.setBypass(['bloom']);
  },
  'win-nobloom': async (c4) => {
    await c4.reset({ difficulty: 'medium' });
    await c4.playMoves([3, 0, 4, 1, 5, 0, 6]);
    await c4.settle();
    await c4.frames(48);
    await c4.setBypass(['bloom']);
  },

  /** Long after the win, once the celebration has settled into its resting state. */
  'win-settled': async (c4) => {
    await c4.reset({ difficulty: 'medium' });
    await c4.playMoves([3, 0, 4, 1, 5, 0, 6]);
    await c4.settle();
    await c4.frames(150);
  },
};

function parseArgs(argv) {
  const out = { scene: null, device: null, url: null, dpr: null, reduced: null };
  for (const a of argv.slice(2)) {
    const m = /^--([a-z]+)=(.*)$/.exec(a);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Serve `dist/` with vite preview, resolving once it prints a URL. */
function startServer() {
  return new Promise((resolve, reject) => {
    // No --strictPort: a previous run killed mid-screenshot can leave its
    // server holding the port, and failing the whole capture over that is
    // pointless when the URL is parsed from the output anyway.
    const proc = spawn('npx', ['vite', 'preview', '--port', '4173'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    const onData = (buf) => {
      const s = buf.toString();
      const m = /(http:\/\/localhost:\d+)/.exec(s);
      if (m && !settled) {
        settled = true;
        resolve({ proc, url: m[1] });
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => {
      if (!settled) reject(new Error(`vite preview exited with code ${code}`));
    });
    setTimeout(() => {
      if (!settled) reject(new Error('vite preview did not start within 30s'));
    }, 30_000);
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const sceneNames = args.scene ? args.scene.split(',') : Object.keys(SCENES);
  const deviceNames = args.device ? args.device.split(',') : Object.keys(DEVICES);

  for (const s of sceneNames) {
    if (!SCENES[s]) throw new Error(`unknown scene "${s}" (have: ${Object.keys(SCENES).join(', ')})`);
  }
  for (const d of deviceNames) {
    if (!DEVICES[d]) throw new Error(`unknown device "${d}" (have: ${Object.keys(DEVICES).join(', ')})`);
  }

  // Only the scenes being rendered are replaced. Wiping the directory meant a
  // partial run (one scene, one device) destroyed every other frame, and a
  // reviewer comparing them would find half of them missing mid-review.
  await mkdir(SHOTS, { recursive: true });

  let server = null;
  let url = args.url;
  if (!url) {
    server = await startServer();
    url = server.url;
  }

  const browser = await chromium.launch({ executablePath: CHROME, args: LAUNCH_ARGS });
  const failures = [];

  try {
    for (const deviceName of deviceNames) {
      // DPR is overridable because this renders on SwiftShader, where cost
      // scales with pixel count and a Retina frame of this scene takes tens of
      // seconds. DPR 1 is the iteration pass; DPR 2 is the review pass.
      const device = DEVICES[deviceName];
      const context = await browser.newContext({
        ...device,
        deviceScaleFactor: args.dpr ? Number(args.dpr) : device.deviceScaleFactor,
        colorScheme: 'dark',
        // --reduced=1 captures the prefers-reduced-motion build, where every
        // pulse and drift must freeze at its midpoint while the board stays
        // fully readable. It is a whole second look at the product, not a
        // variant of one scene, so it is a context flag rather than a scene.
        reducedMotion: args.reduced ? 'reduce' : 'no-preference',
      });
      const page = await context.newPage();

      const consoleErrors = [];
      page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(m.text());
      });
      page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__c4?.ready === true, null, { timeout: 180_000 });

      for (const sceneName of sceneNames) {
        const t0 = Date.now();
        await page.evaluate(
          async ([name, body]) => {
            const fn = new Function('c4', `return (${body})(c4)`);
            await fn(window.__c4);
          },
          [sceneName, SCENES[sceneName].toString()],
        );

        const suffix = args.reduced ? '-reduced' : '';
        const file = path.join(SHOTS, `${sceneName}-${deviceName}${suffix}.png`);
        // Generous: a frame of this scene costs tens of seconds on SwiftShader,
        // and Playwright's 30s default expects a compositor keeping up in real
        // time. This is a rendering-cost allowance, not a hang detector.
        await page.screenshot({ path: file, timeout: 180_000 });
        console.log(`  ${path.relative(ROOT, file)}  (${Date.now() - t0}ms)`);
      }

      if (consoleErrors.length) {
        failures.push(`[${deviceName}] ${consoleErrors.length} console error(s):`);
        for (const e of consoleErrors.slice(0, 12)) failures.push(`    ${e}`);
      }
      await context.close();
    }
  } finally {
    await browser.close();
    if (server) server.proc.kill();
  }

  if (failures.length) {
    console.error('\nPage reported errors:');
    for (const f of failures) console.error(f);
    process.exitCode = 1;
  } else {
    console.log('\nAll scenes captured with no console errors.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
