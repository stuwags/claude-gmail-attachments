/**
 * Application bootstrap.
 *
 * Builds the renderer, the chrome, the audio engine and the search worker,
 * wires them to the controller, and owns the frame loop. Also installs the
 * `window.__c4` hook the screenshot harness drives — see `tools/shoot.mjs`.
 */

import { createBoardView } from './render/scene';
import { createHud } from './ui/hud';
import { AudioEngine } from './game/audio';
import { AiClient } from './game/ai-client';
import { GameController } from './game/controller';
import { InputController } from './game/input';
import { Player } from './engine/types';
import type { QualityTier } from './render/api';
import type { CoachMode } from './render/effects/types';
import type { Difficulty } from './engine/types';

/** What `tools/shoot.mjs` calls to drive the game into a reviewable state. */
interface DebugHook {
  ready: boolean;
  reset(opts?: {
    difficulty?: Difficulty;
    teaching?: boolean;
    showMenu?: boolean;
    quality?: QualityTier;
  }): Promise<void>;
  playMoves(cols: number[]): Promise<void>;
  beginDrop(col: number): Promise<void>;
  settle(): Promise<void>;
  frames(n: number): Promise<void>;
  stats(): unknown;
}

declare global {
  interface Window {
    __c4?: DebugHook;
  }
}

async function boot(): Promise<void> {
  const canvas = document.getElementById('stage') as HTMLCanvasElement | null;
  const uiRoot = document.getElementById('ui-root');
  if (!canvas || !uiRoot) throw new Error('missing #stage or #ui-root');

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const view = createBoardView({ canvas, reducedMotion });
  await view.init();

  const audio = new AudioEngine();
  const ai = new AiClient();
  const hud = createHud();
  const controller = new GameController({ view, hud, audio, ai });

  hud.mount(uiRoot, {
    onStartMatch: (config) => void controller.startMatch(config),
    onRestart: () => void controller.restart(),
    onUndo: () => void controller.undo(),
    onSetDifficulty: (d) => controller.setDifficulty(d),
    onSetCoachMode: (m) => controller.setCoachMode(m),
    onToggleMute: () => controller.toggleMute(),
    onSetQuality: (q) => controller.setQuality(q),
    onOpenMenu: () => void controller.openMenu(),
  });

  const input = new InputController({ canvas, view, controller, audio, reducedMotion });

  await controller.openMenu();

  /* -------------------- sizing -------------------- */

  const applySize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    view.resize(window.innerWidth, window.innerHeight, dpr);
  };
  applySize();
  window.addEventListener('resize', applySize);
  // devicePixelRatio changes when a window moves between displays; the media
  // query is the only reliable notification of it.
  const watchDpr = () => {
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    mq.addEventListener('change', () => {
      applySize();
      watchDpr();
    }, { once: true });
  };
  watchDpr();

  /* -------------------- frame loop -------------------- */

  let last = performance.now();
  let frameResolvers: (() => void)[] = [];

  const tick = (now: number) => {
    // Clamp so a backgrounded tab does not teleport every animation on return.
    const dt = Math.min(now - last, 100);
    last = now;

    view.render(dt);

    if (frameResolvers.length) {
      const pending = frameResolvers;
      frameResolvers = [];
      for (const resolve of pending) resolve();
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  const nextFrame = () => new Promise<void>((resolve) => frameResolvers.push(resolve));

  /* -------------------- harness hook -------------------- */

  window.__c4 = {
    ready: true,
    async reset(opts = {}) {
      if (opts.quality) controller.setQuality(opts.quality);
      const difficulty = opts.difficulty ?? 'medium';
      const coachMode: CoachMode = opts.teaching ? 'full' : 'off';
      if (opts.showMenu) {
        controller.setDifficulty(difficulty);
        controller.setCoachMode(coachMode);
        await controller.openMenu();
      } else {
        await controller.startMatch({
          difficulty,
          vsAi: false, // The harness drives both sides; no search mid-capture.
          humanPlayer: Player.One,
          coachMode,
        });
      }
      await view.settle();
    },
    async playMoves(cols) {
      controller.applyMovesInstantly(cols);
      await view.settle();
    },
    async beginDrop(col) {
      const board = controller.position;
      if (!board.canPlay(col)) return;
      view.beginDrop(col, board.heightOf(col), board.toMove);
    },
    settle: () => view.settle(),
    async frames(n) {
      for (let i = 0; i < n; i++) await nextFrame();
    },
    stats: () => view.stats(),
  };

  window.addEventListener('pagehide', () => {
    input.dispose();
    ai.dispose();
    audio.dispose();
    view.dispose();
  });
}

boot().catch((err) => {
  console.error(err);
  const root = document.getElementById('ui-root');
  if (root) {
    root.innerHTML =
      '<div class="fatal" role="alert"><h1>This game needs WebGL 2.</h1>' +
      '<p>Try a current version of Safari, Chrome or Edge.</p></div>';
  }
});
