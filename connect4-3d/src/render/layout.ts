/**
 * Physical layout of the set, in metres.
 *
 * These are the dimensions from `docs/ART_BIBLE.md` §1.2, converted from mm.
 * Real dimensions matter more than they look like they should: physically based
 * shading, depth of field and area lights all reason in world units, so a board
 * built at "about 10 units wide" lights and blurs like a billboard rather than
 * like a desk object. Change nothing here without changing the bible first.
 *
 * Axes: +X right, +Y up, +Z toward the camera. The tabletop's top surface is
 * Y = 0 and the grid is centred on X = 0; the board's mid-plane is Z = 0.
 */

import { COLS, ROWS } from '../engine/types';

const mm = (v: number) => v / 1000;

/* -------------------- discs -------------------- */

export const DISC_DIAMETER = mm(42);
export const DISC_RADIUS = DISC_DIAMETER / 2;
export const DISC_THICKNESS = mm(9);
/** Rim fillet. No zero-radius edges anywhere in the scene (bible §1.2). */
export const DISC_EDGE_FILLET = mm(1.5);
/** Two concentric lathed grooves in each disc face. */
export const DISC_GROOVE_RADII = [mm(12), mm(17)] as const;
export const DISC_GROOVE_DEPTH = mm(0.6);
export const DISC_GROOVE_WIDTH = mm(1.4);
/** Minimum radial segments on a disc silhouette (bible §1.2, DoD item 2). */
export const DISC_RADIAL_SEGMENTS = 96;

/* -------------------- grid -------------------- */

export const CELL_PITCH = mm(46);
export const GRID_WIDTH = COLS * CELL_PITCH;
export const GRID_HEIGHT = ROWS * CELL_PITCH;

/** Panel apertures. Smaller than the disc, so discs are captured behind them. */
export const HOLE_DIAMETER = mm(36);
export const HOLE_RADIUS = HOLE_DIAMETER / 2;

/* -------------------- board -------------------- */

export const PANEL_THICKNESS = mm(6);
/** Interior gap between the two acrylic sheets. */
export const PANEL_GAP = mm(11);
/** Front face of the front panel to back face of the back panel. */
export const PANEL_SANDWICH_DEPTH = PANEL_THICKNESS * 2 + PANEL_GAP;

export const BOARD_WIDTH = mm(366);
export const BOARD_HEIGHT = mm(330);
/** Frame rail section depth; the frame is deeper than the panel sandwich. */
export const BOARD_DEPTH = mm(38);

export const RAIL_SECTION = mm(8);
export const CHAMFER = mm(0.8);

/** Column feed mouths flare open at the top of the board. */
export const FEED_CHAMFER_ANGLE = (15 * Math.PI) / 180;
export const FEED_CHAMFER_DEPTH = mm(6);

/**
 * Frame margins around the grid. Horizontal is symmetric; vertical is
 * bottom-heavy, as moulded sets are, and the two must sum to the envelope.
 */
export const FRAME_SIDE = (BOARD_WIDTH - GRID_WIDTH) / 2; // 22 mm
export const FRAME_BOTTOM = mm(30);
export const FRAME_TOP = BOARD_HEIGHT - GRID_HEIGHT - FRAME_BOTTOM; // 24 mm

/* -------------------- plinth and table -------------------- */

export const PLINTH_WIDTH = mm(420);
export const PLINTH_DEPTH = mm(140);
export const PLINTH_HEIGHT = mm(22);

export const TABLE_WIDTH = 2.4;
export const TABLE_DEPTH = 1.2;
export const TABLE_THICKNESS = 0.06;

/** The board's bottom edge rests on top of the plinth. */
export const BOARD_BOTTOM_Y = PLINTH_HEIGHT;
export const BOARD_TOP_Y = BOARD_BOTTOM_Y + BOARD_HEIGHT;

/* -------------------- cell addressing -------------------- */

/** Y of the centre of the bottom row of cells. */
export const ROW0_Y = BOARD_BOTTOM_Y + FRAME_BOTTOM + CELL_PITCH / 2;

/** Y a disc is released from: clear of the feed mouth, out of frame. */
export const RELEASE_Y = BOARD_TOP_Y + CELL_PITCH * 0.9;

/** World X of a column's centreline. */
export function columnX(col: number): number {
  return (col - (COLS - 1) / 2) * CELL_PITCH;
}

/** World Y of a row's centre. Row 0 is the bottom. */
export function rowY(row: number): number {
  return ROW0_Y + row * CELL_PITCH;
}

/** World position of a cell centre, on the board's mid-plane. */
export function cellPosition(col: number, row: number): [number, number, number] {
  return [columnX(col), rowY(row), 0];
}

/** Nearest column to a world X, clamped to the board. Used for pointer picking. */
export function columnFromX(x: number): number {
  const raw = Math.round(x / CELL_PITCH + (COLS - 1) / 2);
  return Math.min(COLS - 1, Math.max(0, raw));
}

/** True when a world X is over the grid at all, rather than out past the rails. */
export function isOverGrid(x: number): boolean {
  return Math.abs(x) <= GRID_WIDTH / 2 + FRAME_SIDE;
}

/* -------------------- camera (bible §1.3) -------------------- */

export const CAMERA_FOV = 22;
export const CAMERA_REST_POSITION: readonly [number, number, number] = [0.13, 0.36, 1.22];
export const CAMERA_TARGET: readonly [number, number, number] = [0, 0.17, 0];
/** Parallax orbits at this fixed radius about the target. */
export const CAMERA_RADIUS = 1.24;
