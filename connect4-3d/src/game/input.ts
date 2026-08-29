/**
 * Pointer, touch and keyboard input over the 3D board.
 *
 * The DOM chrome handles its own controls; this handles the board itself,
 * which is not a DOM element and so has no hit testing of its own.
 *
 * The interaction model comes from bible §5.3: drag to aim and release to drop,
 * with a plain tap doing both at once. That works identically for a mouse (where
 * hover aims continuously) and a finger (where nothing is hovered until it is
 * touching), so there is one code path rather than a mouse one and a touch one.
 */

import type { BoardView } from '../render/api';
import type { GameController } from './controller';
import type { AudioEngine } from './audio';
import { COLS } from '../engine/types';

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
  /** Column the keyboard selection sits on, for arrow-key play. */
  private keyboardColumn = 3;
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
    window.addEventListener('keydown', this.onKeyDown);
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
    window.removeEventListener('keydown', this.onKeyDown);
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
    this.keyboardColumn = col;
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
    if (col !== null) this.keyboardColumn = col;
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

  private onKeyDown = (event: KeyboardEvent): void => {
    // Never steal keys from the chrome's own controls, or Space on a focused
    // button would both activate it and drop a disc.
    if (isEditableTarget(event.target)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    const key = event.key;

    if (key >= '1' && key <= '7') {
      event.preventDefault();
      const col = Number(key) - 1;
      this.keyboardColumn = col;
      void this.drop(col);
      return;
    }

    switch (key) {
      case 'ArrowLeft':
        event.preventDefault();
        this.moveSelection(-1);
        break;
      case 'ArrowRight':
        event.preventDefault();
        this.moveSelection(1);
        break;
      case 'ArrowDown':
      case 'Enter':
      case ' ':
        event.preventDefault();
        void this.drop(this.keyboardColumn);
        break;
      case 'u':
      case 'U':
        event.preventDefault();
        void this.controller.undo();
        break;
      case 'r':
      case 'R':
        event.preventDefault();
        void this.controller.restart();
        break;
      default:
        break;
    }
  };

  private moveSelection(delta: number): void {
    if (!this.controller.acceptsInput) return;
    this.keyboardColumn = Math.min(COLS - 1, Math.max(0, this.keyboardColumn + delta));
    this.controller.setHoveredColumn(this.keyboardColumn);
  }

  private async drop(col: number): Promise<void> {
    void this.audio.unlock();
    const played = await this.controller.playColumn(col);
    if (played) this.audio.uiTap();
  }
}

const preventDefault = (event: Event) => event.preventDefault();

/** True for form controls and anything focusable that consumes typing. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON';
}
