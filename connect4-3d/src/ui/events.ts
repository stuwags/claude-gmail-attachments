/**
 * Column intent, which `HudCallbacks` has no seam for.
 *
 * `src/ui/types.ts` is frozen and carries no column entry point — dropping a
 * disc is a pointer gesture over the canvas, and the game controller owns that.
 * But the Mac keyboard model needs one anyway: 1-7 drop, left/right move an
 * aim, Enter drops. Rather than widen the frozen contract, the HUD reports
 * those two intents as bubbling `CustomEvent`s from its mount root, so the
 * controller can listen on `document` and route them through exactly the same
 * code path as a pointer drop.
 *
 *   document.addEventListener('c4:column-select', (e) => view.setHover(e.detail.column, ...));
 *   document.addEventListener('c4:column-drop',   (e) => controller.play(e.detail.column));
 *
 * Both carry 0-based column indices, matching the engine's `col 0..6`.
 */

export const COLUMN_SELECT_EVENT = 'c4:column-select';
export const COLUMN_DROP_EVENT = 'c4:column-drop';

export interface ColumnSelectDetail {
  /** 0-based column, or null when the aim is cleared. */
  column: number | null;
}

export interface ColumnDropDetail {
  /** 0-based column. */
  column: number;
  source: 'keyboard';
}

export type ColumnSelectEvent = CustomEvent<ColumnSelectDetail>;
export type ColumnDropEvent = CustomEvent<ColumnDropDetail>;

declare global {
  interface DocumentEventMap {
    'c4:column-select': ColumnSelectEvent;
    'c4:column-drop': ColumnDropEvent;
  }
  interface WindowEventMap {
    'c4:column-select': ColumnSelectEvent;
    'c4:column-drop': ColumnDropEvent;
  }
}
