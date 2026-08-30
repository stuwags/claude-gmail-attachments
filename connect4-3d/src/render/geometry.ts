/**
 * Every mesh in the set, built to the dimensions in `layout.ts` (bible §1.2).
 *
 * Two rules drive everything here.
 *
 * First: no zero-radius edges. A razor edge cannot catch a highlight, and a
 * frame full of them is the fastest way to look like a video game. Every
 * extrude carries a bevel, every box is a chamfered box, and the disc rim is a
 * real lathed fillet rather than a normal map pretending to be one — a fake
 * fillet dies the moment the silhouette crosses a bright background.
 *
 * Second: triangles are spent where they are seen. The 42 discs are one
 * `InstancedMesh`, so every profile segment on the disc costs ~8,000 triangles
 * across the set and gets argued over; the tabletop is a slab and gets sixteen.
 */

import {
  BufferGeometry,
  ExtrudeGeometry,
  Float32BufferAttribute,
  LatheGeometry,
  Path,
  RingGeometry,
  Shape,
  Vector2,
  type ExtrudeGeometryOptions,
} from 'three';
import { mergeGeometries, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';

import { COLS, ROWS } from '../engine/types';
import {
  BOARD_BOTTOM_Y,
  BOARD_DEPTH,
  BOARD_HEIGHT,
  BOARD_TOP_Y,
  BOARD_WIDTH,
  CHAMFER,
  columnX,
  DISC_EDGE_FILLET,
  DISC_GROOVE_DEPTH,
  DISC_GROOVE_RADII,
  DISC_GROOVE_WIDTH,
  DISC_RADIAL_SEGMENTS,
  DISC_RADIUS,
  DISC_THICKNESS,
  FEED_CHAMFER_ANGLE,
  FEED_CHAMFER_DEPTH,
  HOLE_RADIUS,
  PANEL_GAP,
  PANEL_THICKNESS,
  PLINTH_DEPTH,
  PLINTH_HEIGHT,
  PLINTH_WIDTH,
  RAIL_SECTION,
  rowY,
  TABLE_DEPTH,
  TABLE_THICKNESS,
  TABLE_WIDTH,
} from './layout';

/** Y of the board's geometric centre; the panels and side rails hang off it. */
export const BOARD_CENTRE_Y = (BOARD_BOTTOM_Y + BOARD_TOP_Y) / 2;

/** Z of each acrylic sheet's mid-plane. */
export const PANEL_FRONT_Z = PANEL_GAP / 2 + PANEL_THICKNESS / 2;
export const PANEL_BACK_Z = -PANEL_FRONT_Z;
/** Outer face of the front sheet; hover strokes and coach rings live just off it. */
export const PANEL_FRONT_FACE_Z = PANEL_FRONT_Z + PANEL_THICKNESS / 2;

/** Where a ghost disc sits when a column is aimed at (bible §5.3). */
export const FEED_GHOST_Y = BOARD_TOP_Y + DISC_RADIUS * 0.35;

/* ------------------------------------------------------------------ *
 * Contour helpers
 * ------------------------------------------------------------------ */

/**
 * Counter-clockwise rounded rectangle. Winding matters: `ExtrudeGeometry`
 * flips a CCW outer contour and, only then, flips any clockwise holes to match,
 * so authoring outers CCW and holes CW is the one combination that triangulates
 * correctly without relying on luck.
 */
function roundedRect(
  halfW: number,
  halfH: number,
  radius: number,
  segments: number,
  cx = 0,
  cy = 0,
): Vector2[] {
  const r = Math.min(radius, halfW, halfH);
  const ix = halfW - r;
  const iy = halfH - r;
  const corners: [number, number, number][] = [
    [ix, -iy, -Math.PI / 2],
    [ix, iy, 0],
    [-ix, iy, Math.PI / 2],
    [-ix, -iy, Math.PI],
  ];
  const pts: Vector2[] = [];
  for (const [ox, oy, a0] of corners) {
    for (let i = 0; i <= segments; i++) {
      const a = a0 + (i / segments) * (Math.PI / 2);
      pts.push(new Vector2(cx + ox + Math.cos(a) * r, cy + oy + Math.sin(a) * r));
    }
  }
  return pts;
}

/** Clockwise circle, for use as an extrude hole. */
function circle(cx: number, cy: number, r: number, segments: number): Vector2[] {
  const pts: Vector2[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (-i / segments) * Math.PI * 2;
    pts.push(new Vector2(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
  }
  return pts;
}

/**
 * `ExtrudeGeometry` hands back flat normals — correct for a 0.8 mm chamfer,
 * catastrophic for a 44-facet hole wall, which is bible §9 item 2. Creasing
 * fixes exactly that split, but `toCreasedNormals` quantises vertex positions
 * to 0.01 *world units*; at our metre scale that welds everything within a
 * centimetre, which is most of the board. Working in millimetres for the
 * duration of the call puts the quantisation at 0.01 mm, where it belongs.
 */
function crease(geometry: BufferGeometry, creaseAngleDeg = 30): BufferGeometry {
  geometry.scale(1000, 1000, 1000);
  const out = toCreasedNormals(geometry, (creaseAngleDeg * Math.PI) / 180);
  if (out !== geometry) geometry.dispose();
  out.scale(0.001, 0.001, 0.001);
  return out;
}

/**
 * Extrude a shape symmetrically about z = 0 with a chamfer on both cap edges.
 * `bevelSegments = 1` gives a true flat chamfer, which is what a machined or
 * CNC-cut edge actually is, and costs 40 % fewer triangles than a rounded one.
 */
function extrudeCentred(
  shape: Shape,
  thickness: number,
  chamfer: number,
  bevelSegments = 1,
): BufferGeometry {
  const depth = thickness - 2 * chamfer;
  const opts: ExtrudeGeometryOptions = {
    depth,
    steps: 1,
    curveSegments: 1,
    bevelEnabled: true,
    bevelThickness: chamfer,
    bevelSize: chamfer,
    bevelOffset: 0,
    bevelSegments,
  };
  const geo = new ExtrudeGeometry(shape, opts);
  geo.translate(0, 0, -depth / 2);
  return geo;
}

/**
 * A box with every one of its twelve edges broken by the same flat 45° chamfer.
 *
 * The eight cap edges get theirs from the bevel. The four edges parallel to the
 * extrusion get theirs from a *one-segment* rounded corner — a single segment
 * across 90° is a straight chord, which is exactly a chamfer of the same leg
 * length, so all twelve edges are geometrically identical. That matters here:
 * the bible's check is a *continuous bright chamfer line* down the right rail,
 * and a rounded arris smears that line into a soft gradient instead.
 */
function chamferedBox(w: number, h: number, d: number, chamfer: number): BufferGeometry {
  const shape = new Shape(roundedRect(w / 2, h / 2, chamfer, 1));
  // 35°, comfortably clear of the 45° a chamfer makes with either neighbour, so
  // the chamfers stay crisp while curved contours smooth.
  return crease(extrudeCentred(shape, d, chamfer, 1), 35);
}

/** As `chamferedBox`, but the big faces point up and down and carry planar UVs. */
function chamferedSlab(w: number, d: number, h: number, fillet: number): BufferGeometry {
  // The plinth and the slab are *filleted*, not chamfered (bible §1.2), so these
  // corners are real arcs and the crease angle lets them shade smoothly.
  const shape = new Shape(roundedRect(w / 2, d / 2, fillet * 2, 4));
  const geo = extrudeCentred(shape, h, fillet, 3);
  // Extrude runs along +Z; roll it flat so the caps become the top and bottom
  // faces. Cap UVs are the shape's own coordinates, i.e. metres of tabletop,
  // which is exactly the parameterisation the basalt speckle wants.
  geo.rotateX(-Math.PI / 2);
  return crease(geo, 30);
}

/* ------------------------------------------------------------------ *
 * Discs (bible §1.2, §3.1)
 * ------------------------------------------------------------------ */

/** Segments across one lathed groove. Four is the minimum that reaches full depth. */
const GROOVE_SEGMENTS = 4;
/** Segments across the 1.5 mm rim fillet, per side. */
const FILLET_SEGMENTS = 4;

/**
 * The face crown (bible §1.2, as revised): 1.4 mm of sagitta across the 42 mm
 * face.
 *
 * An optically flat face aimed at the camera is a dead mirror pointed at
 * nothing — it reflects the view ray forward past the camera, where the rig has
 * nothing to offer — and worse, the camera pitches down 8.8°, so the six rows
 * do not share a mirror path at all: a flat top-row face sends the view to
 * y ≈ +0.26 at z = 1.05 and a flat bottom-row face to y ≈ −0.17, and no single
 * source position is visible to both. Real premium lacquered pieces are crowned
 * for exactly this reason.
 *
 * 1.4 mm swings the face normal through ±7.6°, so ±15.2° of mirror coverage,
 * which is what brings every row within reach of one small catch card. The
 * ceiling is the slot: 1.4 mm of crown makes the disc 10.4 mm thick at its
 * centre and leaves 0.6 mm of clearance in the 11 mm gap, so 1.5 mm is the
 * absolute limit and this stops just under it.
 */
const CROWN_SAGITTA = 0.0014;
/** Crown sphere radius from the sagitta across the full face: R = (a² + s²) / 2s. */
const CROWN_RADIUS = (DISC_RADIUS * DISC_RADIUS + CROWN_SAGITTA * CROWN_SAGITTA) / (2 * CROWN_SAGITTA);
/** Height of the crown above the rim plane, at radius r. Zero at r = DISC_RADIUS. */
const crownRise = (r: number): number =>
  Math.sqrt(CROWN_RADIUS * CROWN_RADIUS - r * r) -
  Math.sqrt(CROWN_RADIUS * CROWN_RADIUS - DISC_RADIUS * DISC_RADIUS);

/**
 * Profile rows across the crown, stepped by normal swing rather than by radius.
 *
 * What the crown is *for* is a mirror-direction gradient, and the highlight's
 * soft edge is that gradient resolved: 0.8° of normal per row is 1.6° of mirror
 * per row against a catch card that subtends about 5° x 7.5°, so the window's
 * edge is carried by several rows rather than by one.
 */
const CROWN_NORMAL_STEP = (0.8 * Math.PI) / 180;
const crownSegments = (r0: number, r1: number): number =>
  Math.max(
    1,
    Math.ceil(
      (Math.asin(r1 / CROWN_RADIUS) - Math.asin(r0 / CROWN_RADIUS)) / CROWN_NORMAL_STEP,
    ),
  );

export interface DiscGeometry {
  geometry: BufferGeometry;
  /** UV.v spans covered by each lathed groove, for baking the albedo AO ring. */
  grooveBands: { v0: number; v1: number }[];
  /** Arc length of the lathe profile, metres. Sets the micro-detail tiling. */
  profileLength: number;
  /** Triangles in one disc, so the scene can report a real budget. */
  triangles: number;
}

/**
 * The disc profile, revolved.
 *
 * The face is a spherical crown; the grooves are cut into it and follow it. The
 * back face stays flat and the rim keeps its 21 mm radius, so the crown is the
 * only thing that moved.
 *
 * Grooves are cut into the front face only. The camera is on a tripod with a
 * ±5° yaw envelope and never leaves the front of the board, so the back face of
 * a disc is geometrically unreachable; each profile segment spent there would
 * cost 8,064 triangles across 42 instances and appear in zero frames. Both rim
 * fillets are kept, because the rim is on the silhouette from every angle.
 *
 * Groove cross-section is a raised cosine rather than a trapezoid: it has zero
 * slope at the lips and at the floor, so `LatheGeometry`'s averaged normals
 * describe a genuinely round valley instead of ringing at the corners.
 */
function discProfile(): { pts: Vector2[]; grooves: [number, number][] } {
  const R = DISC_RADIUS;
  const H = DISC_THICKNESS / 2;
  const F = DISC_EDGE_FILLET;
  const gw = DISC_GROOVE_WIDTH;
  const gd = DISC_GROOVE_DEPTH;

  // The crown sphere's centre, on the axis, in profile coordinates.
  const crownCentreY = H + CROWN_SAGITTA - CROWN_RADIUS;
  // The front fillet, seated tangent to both the crown and the rim cylinder: F
  // in from the rim, F under the crown. That keeps face, fillet and rim one
  // smooth run instead of leaving a 7° kink where the crown meets a fillet that
  // was authored against a flat face. The rim's radius and its lower edge do not
  // move; its top rises by 0.18 mm, which is just the crown arriving.
  const filletCentreR = R - F;
  const filletCentreY =
    crownCentreY + Math.sqrt((CROWN_RADIUS - F) ** 2 - filletCentreR * filletCentreR);
  const filletStart = Math.asin(filletCentreR / (CROWN_RADIUS - F));
  const faceEdge = filletCentreR + Math.sin(filletStart) * F;

  const pts: Vector2[] = [new Vector2(0, H + CROWN_SAGITTA)];
  const grooves: [number, number][] = [];

  /** Walk the crown out to `r1` from wherever the profile currently ends. */
  const crownOut = (r1: number) => {
    const r0 = pts[pts.length - 1].x;
    const n = crownSegments(r0, r1);
    for (let i = 1; i <= n; i++) {
      const r = r0 + ((r1 - r0) * i) / n;
      pts.push(new Vector2(r, H + crownRise(r)));
    }
  };

  for (const rc of DISC_GROOVE_RADII) {
    crownOut(rc - gw / 2);
    const start = pts.length - 1;
    for (let i = 1; i <= GROOVE_SEGMENTS; i++) {
      const t = i / GROOVE_SEGMENTS;
      const r = rc - gw / 2 + gw * t;
      const y = H + crownRise(r) - gd * 0.5 * (1 - Math.cos(2 * Math.PI * t));
      pts.push(new Vector2(r, y));
    }
    grooves.push([start, pts.length - 1]);
  }

  // Crown out to the fillet's tangent point, then the fillet, the rim, the
  // second fillet, and straight back to the axis.
  crownOut(faceEdge);
  for (let i = 1; i <= FILLET_SEGMENTS; i++) {
    const a = filletStart + (i / FILLET_SEGMENTS) * (Math.PI / 2 - filletStart);
    pts.push(new Vector2(filletCentreR + Math.sin(a) * F, filletCentreY + Math.cos(a) * F));
  }
  pts.push(new Vector2(R, -(H - F)));
  for (let i = 1; i <= FILLET_SEGMENTS; i++) {
    const a = (i / FILLET_SEGMENTS) * (Math.PI / 2);
    pts.push(new Vector2(R - F + Math.cos(a) * F, -(H - F) - Math.sin(a) * F));
  }
  pts.push(new Vector2(0, -H));

  // Re-centre in the slot. The crown is all on the front, so a disc built about
  // its old mid-plane would stand 5.9 mm proud of it and foul the front sheet,
  // which sits at 5.5 mm. Shifting by half the sagitta splits the 0.6 mm of
  // clearance evenly, 0.3 mm a side.
  for (const p of pts) p.y -= CROWN_SAGITTA / 2;

  // Hand the profile to the lathe back-face-first.
  //
  // `LatheGeometry` takes the outward normal to be the profile tangent turned a
  // quarter clockwise — `( dy, -dx )` — and winds its triangles to match. A
  // profile authored front-face-first therefore comes back inside out: the
  // grooved face's normals point away from the camera, its triangles are wound
  // away too, and `side: FrontSide` culls them. Everything still *looks* like a
  // disc, because what the camera then sees is the inside of the flat back face
  // — which is exactly the "42 coplanar faces, one identical highlight" the
  // crown exists to fix. Reversing costs nothing and is the whole fix; it is
  // done here rather than by authoring backwards so the profile still reads in
  // the order the bible describes it.
  pts.reverse();
  const last = pts.length - 1;
  return { pts, grooves: grooves.map(([a, b]) => [last - b, last - a] as [number, number]) };
}

export function createDiscGeometry(radialSegments = DISC_RADIAL_SEGMENTS): DiscGeometry {
  const { pts, grooves } = discProfile();

  // Re-parameterise v by arc length. Lathe's own v is index-based, which would
  // stretch the micro-detail across the flat face and crush it in the grooves —
  // fine for a 0.06-scale clearcoat normal, fatal for the groove AO ring, which
  // has to land on the groove and nowhere else.
  const arc: number[] = [0];
  for (let i = 1; i < pts.length; i++) arc.push(arc[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const total = arc[arc.length - 1];
  const v = arc.map((a) => a / total);

  const geometry = new LatheGeometry(pts, radialSegments);
  const uv = geometry.getAttribute('uv');
  const rows = pts.length;
  for (let i = 0; i <= radialSegments; i++) {
    for (let j = 0; j < rows; j++) uv.setY(i * rows + j, v[j]);
  }
  uv.needsUpdate = true;

  // Axis along +Z: the grooved face ends up looking at the camera, and the
  // drop's roll oscillation becomes a plain rotation about Z.
  geometry.rotateX(Math.PI / 2);
  geometry.computeBoundingSphere();

  return {
    geometry,
    grooveBands: grooves.map(([a, b]) => ({ v0: v[a], v1: v[b] })),
    profileLength: total,
    triangles: (rows - 1) * radialSegments * 2,
  };
}

/**
 * A cheaper disc for the hover ghost: no grooves, no albedo, 64 segments. It is
 * drawn with an additive fresnel that hides everything but the silhouette, so
 * paying full disc price for it would be waste.
 *
 * Reversed for the same reason as the hero profile: inside out, every fragment
 * reads `dot( N, V ) <= 0`, the fresnel saturates at 1 everywhere, and §3.4's
 * 0.10-centre-to-0.45-rim ramp collapses into a flat 0.45 disc.
 */
export function createGhostDiscGeometry(): BufferGeometry {
  const R = DISC_RADIUS;
  const H = DISC_THICKNESS / 2;
  const F = DISC_EDGE_FILLET;
  const pts: Vector2[] = [new Vector2(0, H), new Vector2(R - F, H)];
  for (let i = 1; i <= 3; i++) {
    const a = (i / 3) * (Math.PI / 2);
    pts.push(new Vector2(R - F + Math.sin(a) * F, H - F + Math.cos(a) * F));
  }
  pts.push(new Vector2(R, -(H - F)));
  for (let i = 1; i <= 3; i++) {
    const a = (i / 3) * (Math.PI / 2);
    pts.push(new Vector2(R - F + Math.cos(a) * F, -(H - F) - Math.sin(a) * F));
  }
  pts.push(new Vector2(0, -H));
  pts.reverse();
  const geo = new LatheGeometry(pts, 64);
  geo.rotateX(Math.PI / 2);
  return geo;
}

/* ------------------------------------------------------------------ *
 * Acrylic panels (bible §1.2, §3.2)
 * ------------------------------------------------------------------ */

/**
 * 48 segments per hole. Sagitta on an 18 mm bore is 0.038 mm, which is a third
 * of a pixel at the review zoom of §9 item 2, and creasing keeps the wall
 * smooth-shaded while the chamfer stays crisp.
 */
const HOLE_SEGMENTS = 48;

/** Fit clearance between an acrylic sheet's edge and the frame rail holding it. */
const PANEL_CLEARANCE = 0.0004;

/**
 * One acrylic sheet. `apertures` cuts the 42 windows; the back sheet is solid.
 *
 * The bible's table lists holes in both panels, but a board built that way is a
 * row of through-holes: an empty cell shows the raw backdrop with nothing in
 * between, measured at one code value from the backdrop itself. Two things
 * follow, and both are bugs. The board's upper half dissolves into the void
 * because it has no silhouette, and the lower cells show the lit tabletop
 * through the board and read as a third, grey disc colour — a false disc on a
 * game board is a legibility failure, not a beauty one.
 *
 * A solid back sheet is also the only version that holds a disc in: the sheet
 * is what captures it. It puts §3.2's smoke between the eye and everything
 * behind the board, which is what §9 item 4 is checking for.
 */
export function createPanelGeometry(apertures = true): BufferGeometry {
  // Seated with clearance rather than flush. Authored to the rail's inner face
  // exactly, the sheet's edge and the stile's inner face were coplanar for the
  // full height of the board — two surfaces fighting for the same pixels right
  // where §9 item 3 wants one clean chamfer line, and a real set has a rebate
  // here for the same reason a real set has a fit tolerance.
  const w = (BOARD_WIDTH - 2 * RAIL_SECTION) / 2 - PANEL_CLEARANCE;
  const h = (BOARD_HEIGHT - 2 * RAIL_SECTION) / 2 - PANEL_CLEARANCE;
  const shape = new Shape(roundedRect(w, h, 0.004, 4, 0, BOARD_CENTRE_Y));
  if (apertures) {
    for (let c = 0; c < COLS; c++) {
      for (let r = 0; r < ROWS; r++) {
        shape.holes.push(new Path(circle(columnX(c), rowY(r), HOLE_RADIUS, HOLE_SEGMENTS)));
      }
    }
  }
  return crease(extrudeCentred(shape, PANEL_THICKNESS, CHAMFER, 1), 30);
}

/* ------------------------------------------------------------------ *
 * Frame, feed mouths, plinth, table (bible §1.2, §3.2, §3.3)
 * ------------------------------------------------------------------ */

/** Half-extents of the feed slot bore: 43 mm wide, flared to 16.2 mm front-to-back. */
const SLOT_HALF_X = 0.0215;
const SLOT_HALF_Z = 0.0065;
const SLOT_CORNER = 0.006;
/** 15° over 6 mm. Bible §1.2. */
const FLARE = FEED_CHAMFER_DEPTH * Math.tan(FEED_CHAMFER_ANGLE);

export function createFrameGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];

  // Top rail: an X–Z footprint with seven slots, extruded 8 mm upward. The bore
  // is cut at the flare's widest section so the mouth collar nests inside it,
  // and the rail's own 0.8 mm bevel continues outward from there as the lip
  // chamfer — one chamfer, on one part, with nothing coplanar to fight.
  const railShape = new Shape(roundedRect(BOARD_WIDTH / 2, BOARD_DEPTH / 2, CHAMFER * 2, 3));
  for (let c = 0; c < COLS; c++) {
    railShape.holes.push(
      new Path(
        roundedRect(SLOT_HALF_X, SLOT_HALF_Z + FLARE, SLOT_CORNER + FLARE, 4, columnX(c)).reverse(),
      ),
    );
  }
  const top = extrudeCentred(railShape, RAIL_SECTION, CHAMFER, 1);
  top.rotateX(-Math.PI / 2);
  top.translate(0, BOARD_TOP_Y - RAIL_SECTION / 2, 0);
  parts.push(crease(top, 30));

  const bottom = chamferedBox(BOARD_WIDTH, RAIL_SECTION, BOARD_DEPTH, CHAMFER);
  bottom.translate(0, BOARD_BOTTOM_Y + RAIL_SECTION / 2, 0);
  parts.push(bottom);

  const stileHeight = BOARD_HEIGHT - 2 * RAIL_SECTION;
  for (const sign of [-1, 1]) {
    const stile = chamferedBox(RAIL_SECTION, stileHeight, BOARD_DEPTH, CHAMFER);
    stile.translate(sign * (BOARD_WIDTH / 2 - RAIL_SECTION / 2), BOARD_CENTRE_Y, 0);
    parts.push(stile);
  }

  return mergeAndDispose(parts);
}

/**
 * Seven lofted collars lining the top rail's slots: the 15°, 6 mm-deep flare of
 * bible §1.2.
 *
 * The flare runs front-to-back only. Flaring in X as well would need 47.8 mm at
 * the mouth on a 46 mm pitch, so the webs between columns would vanish, and it
 * buys nothing: a disc entering a column is already aligned in X by the slot
 * and only needs guiding into the 11 mm gap. Real sets are built the same way,
 * for the same reason.
 *
 * The collar is held 0.4 mm inside the rail's bore in X so the two parts share
 * no surface — a shoulder that reads as a machined fit, rather than the shimmer
 * of two coplanar faces.
 */
export function createFeedMouthGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const hx = SLOT_HALF_X - 0.0004;
  const top = BOARD_TOP_Y;

  for (let c = 0; c < COLS; c++) {
    const x = columnX(c);
    const rings = [
      // The collar stops flush with the underside of the rail. Running it on
      // down into the cavity put a lit aluminium tube behind the top row of
      // apertures, which read through the acrylic as a bright bar across the
      // head of the playfield — a real set has nothing there but the gap.
      { y: top - RAIL_SECTION, hz: SLOT_HALF_Z, r: SLOT_CORNER },
      { y: top - FEED_CHAMFER_DEPTH, hz: SLOT_HALF_Z, r: SLOT_CORNER },
      { y: top, hz: SLOT_HALF_Z + FLARE, r: SLOT_CORNER + FLARE },
    ].map((ring) =>
      roundedRect(hx, ring.hz, ring.r, 4, x).map((p) => ({ x: p.x, y: ring.y, z: p.y })),
    );
    parts.push(loft(rings, x));
  }

  return mergeAndDispose(parts);
}

function mergeAndDispose(parts: BufferGeometry[]): BufferGeometry {
  const merged = mergeGeometries(parts, false) as BufferGeometry | null;
  if (!merged) throw new Error('geometry merge failed: incompatible attributes');
  for (const p of parts) p.dispose();
  return merged;
}

/** Loft a stack of equal-length rings into a tube whose normals face the axis. */
function loft(rings: { x: number; y: number; z: number }[][], axisX: number): BufferGeometry {
  const n = rings[0].length;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];

  for (let r = 0; r < rings.length; r++) {
    for (let i = 0; i < n; i++) {
      const p = rings[r][i];
      pos.push(p.x, p.y, p.z);
      uv.push(i / n, r / (rings.length - 1));
    }
  }
  for (let r = 0; r < rings.length - 1; r++) {
    for (let i = 0; i < n; i++) {
      const a = r * n + i;
      const b = r * n + ((i + 1) % n);
      const c = (r + 1) * n + i;
      const d = (r + 1) * n + ((i + 1) % n);
      idx.push(a, c, d, a, d, b);
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();

  // A funnel is seen from the inside, so its normals must point at the axis.
  // Deriving the winding by hand is a coin flip that only shows up as an
  // invisible mouth at review time; checking one vertex and flipping is not.
  const nrm = geo.getAttribute('normal');
  const p0 = rings[0][0];
  const outward = { x: p0.x - axisX, z: p0.z };
  if (nrm.getX(0) * outward.x + nrm.getZ(0) * outward.z > 0) {
    for (let i = 0; i < idx.length; i += 3) {
      const t = idx[i + 1];
      idx[i + 1] = idx[i + 2];
      idx[i + 2] = t;
    }
    geo.setIndex(idx);
    geo.computeVertexNormals();
  }
  return geo;
}

export function createPlinthGeometry(): BufferGeometry {
  const geo = chamferedSlab(PLINTH_WIDTH, PLINTH_DEPTH, PLINTH_HEIGHT, 0.0015);
  geo.translate(0, PLINTH_HEIGHT / 2, 0);
  return geo;
}

export function createTableGeometry(): BufferGeometry {
  const geo = chamferedSlab(TABLE_WIDTH, TABLE_DEPTH, TABLE_THICKNESS, 0.0015);
  geo.translate(0, -TABLE_THICKNESS / 2, 0);
  return geo;
}

/* ------------------------------------------------------------------ *
 * Overlay primitives
 * ------------------------------------------------------------------ */

/**
 * The hairline stroke that lights a hole rim on hover (bible §5.3). It sits
 * just outside the panel's chamfer so it reads as an edge highlight on the
 * aperture rather than a ring floating in front of it.
 */
export function createRimStrokeGeometry(): BufferGeometry {
  const inner = HOLE_RADIUS + CHAMFER;
  return new RingGeometry(inner, inner + 0.0006, 64, 1);
}
