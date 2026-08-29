/**
 * Application bootstrap.
 *
 * Builds the renderer, the chrome, the audio engine and the search worker,
 * wires them to the controller, and owns the frame loop. Also installs the
 * `window.__c4` hook the screenshot harness drives — see `tools/shoot.mjs`.
 */

import { createBoardView } from './render/scene.ts';
import { createHud } from './ui/hud.ts';
import { AudioEngine } from './game/audio.ts';
import { AiClient } from './game/ai-client.ts';
import { GameController } from './game/controller.ts';
import { InputController } from './game/input.ts';
import { Player } from './engine/types.ts';
import {
  COLUMN_DROP_EVENT,
  COLUMN_SELECT_EVENT,
  type ColumnDropEvent,
  type ColumnSelectEvent,
} from './ui/events.ts';
import type { QualityTier } from './render/api.ts';
import type { CoachMode } from './render/effects/types.ts';
import type { Difficulty } from './engine/types.ts';

/** What `tools/shoot.mjs` calls to drive the game into a reviewable state. */
interface DebugHook {
  ready: boolean;
  reset(opts?: {
    difficulty?: Difficulty;
    teaching?: boolean;
    showMenu?: boolean;
    quality?: QualityTier;
  }): Promise<void>;
  /** Start a real match against the search, which `reset` deliberately does not. */
  startVsComputer(difficulty?: Difficulty): Promise<void>;
  playMoves(cols: number[]): Promise<void>;
  beginDrop(col: number): Promise<void>;
  settle(): Promise<void>;
  frames(n: number): Promise<void>;
  stats(): unknown;
  /** Current game state, for functional smoke tests. */
  state(): unknown;
  /** Synthesise a real pointer click over a column, exercising the input path. */
  click(col: number): Promise<void>;
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

  // Disc contacts. The renderer knows each impact a frame ahead and reports how
  // long until the physical contact, so the transient is scheduled on that
  // exact moment instead of firing when the frame that already drew the
  // collision happens to run. A click a frame late is audible.
  //
  // Impact speed is normalised against a full-height drop (~2.53 m/s), so a
  // disc landing on a tall stack is quieter than one hitting the empty floor,
  // and each bounce is quieter than the landing before it.
  const FULL_DROP_SPEED = 2.53;
  view.onImpact((impact) => {
    audio.discImpact(impact.speed / FULL_DROP_SPEED, impact.row, impact.lead);
  });

  // Keyboard play is reported by the HUD, which owns the visible selection and
  // the screen-reader announcements, and routed here into the same controller
  // calls a pointer gesture makes. See `src/ui/events.ts`.
  const onColumnSelect = (event: ColumnSelectEvent) =>
    controller.setHoveredColumn(event.detail.column);
  const onColumnDrop = (event: ColumnDropEvent) => {
    void audio.unlock();
    void controller.playColumn(event.detail.column);
  };
  document.addEventListener(COLUMN_SELECT_EVENT, onColumnSelect);
  document.addEventListener(COLUMN_DROP_EVENT, onColumnDrop);

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
      // Snap rather than wait: under the harness's software rasteriser a frame
      // costs seconds, so waiting out the intro camera move in real time takes
      // minutes and photographs nothing different at the end of it.
      view.snapAnimations();
      await view.waitFrames(1);
    },
    async startVsComputer(difficulty = 'easy') {
      await controller.startMatch({
        difficulty,
        vsAi: true,
        humanPlayer: Player.One,
        coachMode: difficulty === 'easy' ? 'full' : 'off',
      });
      view.snapAnimations();
      await view.waitFrames(1);
    },
    async playMoves(cols) {
      controller.applyMovesInstantly(cols);
      view.snapAnimations();
      await view.waitFrames(1);
    },
    async beginDrop(col) {
      const board = controller.position;
      if (!board.canPlay(col)) return;
      view.beginDrop(col, board.heightOf(col), board.toMove);
    },
    settle: () => view.settle(),
    state: () => {
      const board = controller.position;
      const snapshot = controller.snapshot();
      return {
        phase: snapshot.phase,
        toMove: board.toMove,
        moveCount: board.moveCount,
        history: [...board.history],
        outcome: board.outcome(),
        heights: Array.from({ length: 7 }, (_, c) => board.heightOf(c)),
        acceptsInput: controller.acceptsInput,
        urgentColumns: snapshot.urgentColumns,
      };
    },
    async click(col) {
      // Drives the real input path rather than the controller directly, so a
      // smoke test exercises picking, the turn guard, and the drop animation.
      const rect = canvas.getBoundingClientRect();
      const ndcX = ((col - 3) / 3.5) * 0.42;
      const point = {
        clientX: rect.left + ((ndcX + 1) / 2) * rect.width,
        clientY: rect.top + rect.height * 0.55,
      };
      for (const type of ['pointerdown', 'pointerup'] as const) {
        canvas.dispatchEvent(
          new PointerEvent(type, {
            ...point,
            pointerId: 1,
            pointerType: 'mouse',
            bubbles: true,
            cancelable: true,
          }),
        );
      }
    },
    async frames(n) {
      for (let i = 0; i < n; i++) await nextFrame();
    },
    stats: () => view.stats(),
  };

  window.addEventListener('pagehide', () => {
    document.removeEventListener(COLUMN_SELECT_EVENT, onColumnSelect);
    document.removeEventListener(COLUMN_DROP_EVENT, onColumnDrop);
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
