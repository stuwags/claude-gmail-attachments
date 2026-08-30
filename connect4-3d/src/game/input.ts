/**
 * Pointer and touch input over the 3D board.
 *
 * The DOM chrome handles its own controls and the keyboard; this handles the
 * board itself, which is not a DOM element and so has no hit testing of its own.
 *
 * The interaction model comes from bible §5.3: drag to aim and release to drop,
 * with a plain tap doing both at once. That works identically for a mouse (where
 * hover aims continuously) and a finger (where nothing is hovered until it is
 * touching), so there is one code path rather than a mouse one and a touch one.
 */

import type { BoardView } from '../render/api.ts';
import type { GameController } from './controller.ts';
import type { AudioEngine } from './audio.ts';

export interface InputOptions {
  canvas: HTMLCanvasElement;
  view: BoardView;
  controller: GameController;
  audio: AudioEngine;
  /** Suppress parallax when the player has asked for reduced motion. */
  reducedMotion: boolean;
}

export class InputController {
  private readonly canvas: HTMLCanvasElement;
  private readonly view: BoardView;
  private readonly controller: GameController;
  private readonly audio: AudioEngine;
  private readonly reducedMotion: boolean;

  /** True between pointerdown and pointerup on the board. */
  private aiming = false;
  private activePointerId: number | null = null;
  private disposed = false;

  constructor(opts: InputOptions) {
    this.canvas = opts.canvas;
    this.view = opts.view;
    this.controller = opts.controller;
    this.audio = opts.audio;
    this.reducedMotion = opts.reducedMotion;

    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerCancel);
    this.canvas.addEventListener('pointerleave', this.onPointerLeave);
    // Safari still fires a synthetic double-tap zoom on a fast double tap
    // even with touch-action: none, and it is jarring mid-game.
    this.canvas.addEventListener('dblclick', preventDefault);
    this.canvas.addEventListener('contextmenu', preventDefault);
    window.addEventListener('blur', this.onBlur);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerCancel);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('dblclick', preventDefault);
    this.canvas.removeEventListener('contextmenu', preventDefault);
    window.removeEventListener('blur', this.onBlur);
  }

  /* ------------------------------------------------------------------ *
   * Pointer
   * ------------------------------------------------------------------ */

  private toNdc(event: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
      y: -(((event.clientY - rect.top) / rect.height) * 2 - 1),
    };
  }

  private onPointerDown = (event: PointerEvent): void => {
    // Unlocking audio requires a real gesture; this is the first one available.
    void this.audio.unlock();

    if (!this.controller.acceptsInput) return;
    const ndc = this.toNdc(event);
    const col = this.view.columnAtPointer(ndc.x, ndc.y);
    if (col === null) return;

    event.preventDefault();
    this.aiming = true;
    this.activePointerId = event.pointerId;
    this.canvas.setPointerCapture(event.pointerId);
    this.controller.setHoveredColumn(col);
  };

  private onPointerMove = (event: PointerEvent): void => {
    const ndc = this.toNdc(event);

    if (!this.reducedMotion) this.view.setParallax(ndc.x, ndc.y);

    // A mouse aims by hovering; a finger only aims while it is down.
    const hovering = event.pointerType === 'mouse' || this.aiming;
    if (!hovering) return;
    if (this.aiming && event.pointerId !== this.activePointerId) return;

    if (!this.controller.acceptsInput) {
      this.controller.setHoveredColumn(null);
      return;
    }
    const col = this.view.columnAtPointer(ndc.x, ndc.y);
    this.controller.setHoveredColumn(col);
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (!this.aiming || event.pointerId !== this.activePointerId) return;
    this.releasePointer(event.pointerId);

    const ndc = this.toNdc(event);
    const col = this.view.columnAtPointer(ndc.x, ndc.y);
    if (col !== null) void this.drop(col);

    // A finger leaves no hover behind; a cursor still has a position.
    if (event.pointerType !== 'mouse') this.controller.setHoveredColumn(null);
  };

  private onPointerCancel = (event: PointerEvent): void => {
    this.releasePointer(event.pointerId);
    this.controller.setHoveredColumn(null);
  };

  private onPointerLeave = (event: PointerEvent): void => {
    if (event.pointerType !== 'mouse') return;
    this.controller.setHoveredColumn(null);
    if (!this.reducedMotion) this.view.setParallax(0, 0);
  };

  private releasePointer(pointerId: number): void {
    this.aiming = false;
    this.activePointerId = null;
    if (this.canvas.hasPointerCapture(pointerId)) this.canvas.releasePointerCapture(pointerId);
  }

  private onBlur = (): void => {
    this.aiming = false;
    this.activePointerId = null;
    this.controller.setHoveredColumn(null);
    this.view.setParallax(0, 0);
  };

  /* ------------------------------------------------------------------ *
   * Keyboard
   * ------------------------------------------------------------------ */

  /**
   * Keyboard board input arrives from the HUD, not from here.
   *
   * The HUD owns the keyboard because it owns the things a keyboard needs: a
   * visible selected column, focus management, and the live region that
   * announces the aim to a screen reader. Duplicating 1-7 on `window` would
   * simply drop two discs per press. It reports the player's intent as
   * `c4:column-select` and `c4:column-drop`, which `main.ts` routes into the
   * same controller calls a pointer gesture makes; undo, restart and escape it
   * serves directly through `HudCallbacks`.
   */
  private async drop(col: number): Promise<void> {
    void this.audio.unlock();
    const played = await this.controller.playColumn(col);
    if (played) this.audio.uiTap();
  }
}

const preventDefault = (event: Event) => event.preventDefault();
