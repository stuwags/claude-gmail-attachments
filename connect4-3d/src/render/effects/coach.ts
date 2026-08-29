/**
 * The Easy-mode coach (bible §7).
 *
 * The whole point is that a child can see, without being told, that three of
 * someone's discs are lined up and where the fourth would go. The hard part is
 * not finding the threats — `analyze()` does that — it is showing several of
 * them at once without the board turning into a light show, because an overlay
 * that marks everything teaches nothing.
 *
 * Three devices, two colours, and a hard budget do the work:
 *   - a filament threads the discs that already exist, so a line reads as a line;
 *   - a ghost disc sits where the fourth would land, so "where do I play" is
 *     answered in the board's own vocabulary rather than an arrow;
 *   - a ring on the front panel marks that landing cell from head-on.
 * Urgency is encoded three ways at once — brightness, motion, and a doubled
 * ring stroke — so it survives colour-blindness and a greyscale screenshot.
 *
 * Deviation from §7.4, deliberate and worth knowing: the bible specifies a
 * dedicated overlay pass that depth-tests against the scene and multiplies by
 * 0.45 where it lies behind the panels. Because the panels are real
 * transmissive material, objects placed inside the board are already captured
 * in the transmission buffer and physically attenuated by the smoked acrylic.
 * Putting the overlay inside the slot gap therefore gets the same dimming from
 * the actual material rather than a magic constant, and costs no extra pass.
 * The bible sanctions the sorted-transparent approach for Tier B; this uses it
 * for both tiers for that reason.
 */

import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  RingGeometry,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { Coord, Player, Threat, ThreatReport } from '../../engine/types';
import { Player as P } from '../../engine/types';
import {
  DISC_RADIUS,
  DISC_THICKNESS,
  PANEL_SANDWICH_DEPTH,
  cellPosition,
} from '../layout';
import type { CoachMode, CoachOverlay, EffectContext } from './types';

/* -------------------- palette (bible §0) -------------------- */

const GLOW: Record<Player, Color> = {
  [P.One]: new Color(0xff9666), // ember-glow
  [P.Two]: new Color(0x53d7db), // petrol-glow
};

/* -------------------- classification (bible §7.1) -------------------- */

type ThreatClass = 'A1' | 'A2' | 'A3' | 'B1' | 'B2';

/** Lower is more urgent. Used to drop elements when over the noise budget. */
const PRIORITY: Record<ThreatClass, number> = { A1: 1, A2: 2, A3: 3, B1: 4, B2: 5 };

interface Classified {
  threat: Threat;
  cls: ThreatClass;
  /** A three with two live completion cells: the loudest thing the coach shows. */
  openThree: boolean;
}

function classify(threat: Threat, toMove: Player): ThreatClass | null {
  const mine = threat.owner === toMove;
  const live = threat.immediateGaps.length > 0;

  if (threat.count === 3) {
    if (!live) return 'A3';
    return mine ? 'A1' : 'A2';
  }
  // A two with no playable growth cell teaches nothing yet; stay dark.
  if (!live) return null;
  return mine ? 'B1' : 'B2';
}

/* -------------------- budget (bible §7.3) -------------------- */

const MAX_FILAMENTS = 3;
const MAX_GHOSTS = 2;
const MAX_CLASS_B_FILAMENTS = 2;
const PULSE_PERIOD = 1.2;

/* -------------------- shaders -------------------- */

/**
 * Additive fresnel. The rim-bright falloff is what keeps a ghost reading as a
 * volume of light sitting in the slot rather than a flat sticker pasted on the
 * board; a uniformly lit translucent disc looks like a UI element, not an object.
 */
const GHOST_VERTEX = /* glsl */ `
  varying vec3 vNormalView;
  varying vec3 vPositionView;
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vNormalView = normalize(normalMatrix * normal);
    vPositionView = mvPosition.xyz;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const GHOST_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uTime;
  uniform float uPhase;
  uniform float uShimmer;
  varying vec3 vNormalView;
  varying vec3 vPositionView;

  // Cheap value noise; the shimmer only needs to break up flatness.
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }

  void main() {
    vec3 viewDir = normalize(-vPositionView);
    float facing = abs(dot(normalize(vNormalView), viewDir));
    // 0.10 at centre to 0.45 at the rim, power 2.5 (bible §3.4).
    float fresnel = mix(0.10, 0.45, pow(1.0 - facing, 2.5));

    float shimmer = 1.0 + (noise(vPositionView.xy * 90.0 + uTime * 0.33) - 0.5) * 0.16 * uShimmer;
    float pulse = 0.22 + 0.18 * (0.5 + 0.5 * sin((uTime / 1.2 + uPhase) * 6.2831853));

    gl_FragColor = vec4(uColor * fresnel * pulse * shimmer * uOpacity, 1.0);
  }
`;

/**
 * Filament. `uFlow` scrolls a luminance band along the tube's length so an
 * urgent line reads as active at a glance; class B lines are static, which is
 * the cheapest possible way to separate "watch this" from "look at this now".
 */
const FILAMENT_VERTEX = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalView;
  varying vec3 vPositionView;
  void main() {
    vUv = uv;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vNormalView = normalize(normalMatrix * normal);
    vPositionView = mvPosition.xyz;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const FILAMENT_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uTime;
  uniform float uFlow;
  varying vec2 vUv;
  varying vec3 vNormalView;
  varying vec3 vPositionView;

  void main() {
    vec3 viewDir = normalize(-vPositionView);
    float facing = abs(dot(normalize(vNormalView), viewDir));
    // Brighten the silhouette so a thin tube still reads at distance.
    float rim = mix(0.55, 1.0, pow(1.0 - facing, 1.6));

    float band = 1.0;
    if (uFlow > 0.0) {
      float t = fract(vUv.y - uTime * uFlow);
      band = 0.72 + 0.55 * smoothstep(0.0, 0.22, t) * smoothstep(0.45, 0.23, t);
    }
    gl_FragColor = vec4(uColor * rim * band * uOpacity, 1.0);
  }
`;

const RING_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const RING_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uTime;
  uniform float uPhase;
  uniform float uPulse;
  void main() {
    float pulse = uPulse > 0.5
      ? 0.62 + 0.38 * (0.5 + 0.5 * sin((uTime / 1.2 + uPhase) * 6.2831853))
      : 1.0;
    gl_FragColor = vec4(uColor * uOpacity * pulse, 1.0);
  }
`;

/* -------------------- pooled objects -------------------- */

interface PooledMesh {
  mesh: Mesh;
  material: ShaderMaterial;
}

/** The front face of the front acrylic panel, where landing rings sit. */
const PANEL_FRONT_Z = PANEL_SANDWICH_DEPTH / 2;

class CoachOverlayImpl implements CoachOverlay {
  private readonly root = new Group();
  private readonly ctx: EffectContext;

  private filaments: PooledMesh[] = [];
  private ghosts: PooledMesh[] = [];
  private rings: PooledMesh[] = [];

  private ghostGeometry: BufferGeometry;
  private filamentGeometry: BufferGeometry;
  private ringGeometryA: BufferGeometry;
  private ringGeometryB: BufferGeometry;

  private mode: CoachMode = 'off';
  private report: ThreatReport | null = null;
  private toMove: Player = P.One;
  private inspected: number | null = null;
  private time = 0;
  private lit = 0;
  private dirty = true;

  constructor(ctx: EffectContext) {
    this.ctx = ctx;
    this.root.name = 'coach-overlay';
    // Inside the slot gap, so the acrylic attenuates it physically.
    ctx.boardRoot.add(this.root);

    // A slightly inset disc, so a ghost never z-fights the real disc geometry
    // it may share a cell with during the frame a move lands.
    this.ghostGeometry = new CylinderGeometry(
      DISC_RADIUS * 0.94,
      DISC_RADIUS * 0.94,
      DISC_THICKNESS * 0.9,
      48,
      1,
      false,
    );
    this.ghostGeometry.rotateX(Math.PI / 2);

    // Unit-length tube; each filament scales it to span its line.
    this.filamentGeometry = new CylinderGeometry(0.001, 0.001, 1, 12, 1, true);

    this.ringGeometryA = new RingGeometry(0.019, 0.0215, 64);
    this.ringGeometryB = new RingGeometry(0.02, 0.0208, 64);
  }

  /* -------------------- state -------------------- */

  setReport(report: ThreatReport | null, _viewer: Player, toMove: Player): void {
    this.report = report;
    this.toMove = toMove;
    this.dirty = true;
  }

  setMode(mode: CoachMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.dirty = true;
  }

  setInspectedColumn(col: number | null): void {
    if (this.inspected === col) return;
    this.inspected = col;
    this.dirty = true;
  }

  update(dt: number): void {
    // Frozen mid-pulse under reduced motion (bible §7.3), so the hierarchy
    // still reads from brightness and stroke weight alone.
    if (!this.ctx.reducedMotion) this.time += dt;
    if (this.dirty) {
      this.rebuild();
      this.dirty = false;
    }
    for (const p of [...this.filaments, ...this.ghosts, ...this.rings]) {
      if (p.mesh.visible) p.material.uniforms.uTime.value = this.time;
    }
  }

  render(): void {
    // Nothing to do: the overlay lives in the scene graph and is drawn by the
    // main render, which is what lets the acrylic dim it for free.
  }

  litElementCount(): number {
    return this.lit;
  }

  /* -------------------- assembly -------------------- */

  private rebuild(): void {
    this.hideAll();
    this.lit = 0;

    if (this.mode === 'off' || !this.report) {
      this.root.visible = false;
      return;
    }
    this.root.visible = true;

    const classified: Classified[] = [];
    for (const threat of this.report.threats) {
      const cls = classify(threat, this.toMove);
      if (!cls) continue;
      classified.push({
        threat,
        cls,
        openThree: threat.count === 3 && threat.immediateGaps.length >= 2,
      });
    }

    // Sort most urgent first so the budget always keeps what matters.
    classified.sort((a, b) => {
      const p = PRIORITY[a.cls] - PRIORITY[b.cls];
      if (p !== 0) return p;
      if (a.openThree !== b.openThree) return a.openThree ? -1 : 1;
      return b.threat.immediateGaps.length - a.threat.immediateGaps.length;
    });

    const inspectedCell = this.inspectedLandingCell();
    const chosen = this.selectWithinBudget(classified, inspectedCell);

    let filamentIndex = 0;
    const ghostCells = new Map<string, { colour: Color; classes: ThreatClass[] }>();

    for (const item of chosen) {
      const classA = item.cls === 'A1' || item.cls === 'A2' || item.cls === 'A3';
      const revealed = inspectedCell !== null && touches(item.threat, inspectedCell);

      // Hover promotes a line to class-A brightness: "what does playing here
      // touch" is the coach's single best teaching moment (bible §7.3).
      const opacity = revealed || classA ? (item.openThree ? 0.6 : 0.45) : 0.14;
      const flow = revealed || classA ? (item.openThree ? 0.8 : 0.4) : 0;

      this.placeFilament(item.threat, opacity, flow, filamentIndex++);
      this.lit++;

      if (item.cls === 'A1' || item.cls === 'A2') {
        for (const gap of item.threat.immediateGaps) {
          const key = `${gap.col},${gap.row}`;
          const entry = ghostCells.get(key);
          if (entry) entry.classes.push(item.cls);
          else ghostCells.set(key, { colour: GLOW[item.threat.owner], classes: [item.cls] });
        }
      }
    }

    let ghostIndex = 0;
    for (const [key, entry] of ghostCells) {
      if (ghostIndex >= MAX_GHOSTS) break;
      const [col, row] = key.split(',').map(Number);
      this.placeGhost(col, row, entry.colour, ghostIndex);
      this.placeRing(col, row, entry.colour, true, ghostIndex);
      ghostIndex++;
      this.lit++;
    }
  }

  /**
   * Apply the §7.3 noise budget: every class A line, then at most two class B
   * lines belonging to the player to move, then the hover reveal on top.
   */
  private selectWithinBudget(items: Classified[], inspected: Coord | null): Classified[] {
    const out: Classified[] = [];
    let classB = 0;

    for (const item of items) {
      if (out.length >= MAX_FILAMENTS) break;
      const classA = item.cls === 'A1' || item.cls === 'A2' || item.cls === 'A3';

      if (classA) {
        out.push(item);
        continue;
      }
      if (this.mode === 'hints') continue; // Hints shows class A only.
      // A line the pointer is inspecting is worth showing whoever owns it.
      if (inspected && touches(item.threat, inspected)) {
        out.push(item);
        continue;
      }
      // Otherwise class B is limited to the mover's own opportunities.
      if (item.cls !== 'B1') continue;
      if (classB >= MAX_CLASS_B_FILAMENTS) continue;
      classB++;
      out.push(item);
    }
    return out;
  }

  /** Where a disc dropped in the inspected column would land. */
  private inspectedLandingCell(): Coord | null {
    if (this.inspected === null || !this.report) return null;
    // Derive the landing row from any threat gap in that column, falling back
    // to scanning the reported immediate gaps.
    for (const t of this.report.threats) {
      for (const gap of t.immediateGaps) {
        if (gap.col === this.inspected) return gap;
      }
    }
    return null;
  }

  /* -------------------- placement -------------------- */

  private placeFilament(threat: Threat, opacity: number, flow: number, index: number): void {
    const pooled = this.take(this.filaments, this.filamentGeometry, FILAMENT_VERTEX, FILAMENT_FRAGMENT, {
      uFlow: { value: 0 },
    });

    const cells = threat.filled;
    if (cells.length < 2) return;
    const first = cells[0];
    const last = cells[cells.length - 1];

    const a = new Vector3(...cellPosition(first.col, first.row));
    const b = new Vector3(...cellPosition(last.col, last.row));

    // Overlapping lines are separated in depth rather than blended into a
    // muddy third colour (bible §7.3).
    const zOffset = (index - (MAX_FILAMENTS - 1) / 2) * 0.003;
    a.z += zOffset;
    b.z += zOffset;

    const mid = a.clone().add(b).multiplyScalar(0.5);
    const length = a.distanceTo(b);

    pooled.mesh.position.copy(mid);
    pooled.mesh.scale.set(1, length, 1);
    // The cylinder's axis is +Y; aim it down the line.
    pooled.mesh.quaternion.setFromUnitVectors(
      new Vector3(0, 1, 0),
      b.clone().sub(a).normalize(),
    );
    pooled.mesh.visible = true;

    pooled.material.uniforms.uColor.value = GLOW[threat.owner];
    pooled.material.uniforms.uOpacity.value = opacity;
    pooled.material.uniforms.uFlow.value = this.ctx.reducedMotion ? 0 : flow;
  }

  private placeGhost(col: number, row: number, colour: Color, index: number): void {
    const pooled = this.take(this.ghosts, this.ghostGeometry, GHOST_VERTEX, GHOST_FRAGMENT, {
      uPhase: { value: 0 },
      uShimmer: { value: 1 },
    });
    pooled.mesh.position.set(...cellPosition(col, row));
    pooled.mesh.visible = true;
    pooled.material.uniforms.uColor.value = colour;
    pooled.material.uniforms.uOpacity.value = 1;
    // Hashed phase, so several ghosts shimmer rather than throbbing in unison.
    pooled.material.uniforms.uPhase.value = hashPhase(col, row);
    pooled.material.uniforms.uShimmer.value = this.ctx.reducedMotion ? 0 : 1;
    void index;
  }

  private placeRing(col: number, row: number, colour: Color, classA: boolean, index: number): void {
    const pooled = this.take(
      this.rings,
      classA ? this.ringGeometryA : this.ringGeometryB,
      RING_VERTEX,
      RING_FRAGMENT,
      { uPhase: { value: 0 }, uPulse: { value: 1 } },
    );
    pooled.mesh.geometry = classA ? this.ringGeometryA : this.ringGeometryB;
    const [x, y] = cellPosition(col, row);
    pooled.mesh.position.set(x, y, PANEL_FRONT_Z + 0.0002);
    pooled.mesh.visible = true;
    pooled.material.uniforms.uColor.value = colour;
    pooled.material.uniforms.uOpacity.value = classA ? 0.5 : 0.18;
    pooled.material.uniforms.uPhase.value = hashPhase(col, row);
    pooled.material.uniforms.uPulse.value = classA && !this.ctx.reducedMotion ? 1 : 0;
    void index;
  }

  /* -------------------- pooling -------------------- */

  private take(
    pool: PooledMesh[],
    geometry: BufferGeometry,
    vertexShader: string,
    fragmentShader: string,
    extraUniforms: Record<string, { value: unknown }>,
  ): PooledMesh {
    const free = pool.find((p) => !p.mesh.visible);
    if (free) return free;

    const material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uColor: { value: new Color(0xffffff) },
        uOpacity: { value: 1 },
        uTime: { value: 0 },
        ...extraUniforms,
      },
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
      toneMapped: true,
    });
    const mesh = new Mesh(geometry, material);
    mesh.visible = false;
    // Draw after the opaque board so additive blending has something to add to.
    mesh.renderOrder = 5;
    this.root.add(mesh);
    const pooled = { mesh, material };
    pool.push(pooled);
    return pooled;
  }

  private hideAll(): void {
    for (const p of this.filaments) p.mesh.visible = false;
    for (const p of this.ghosts) p.mesh.visible = false;
    for (const p of this.rings) p.mesh.visible = false;
  }

  dispose(): void {
    for (const p of [...this.filaments, ...this.ghosts, ...this.rings]) {
      p.material.dispose();
      this.root.remove(p.mesh);
    }
    this.filaments = [];
    this.ghosts = [];
    this.rings = [];
    this.ghostGeometry.dispose();
    this.filamentGeometry.dispose();
    this.ringGeometryA.dispose();
    this.ringGeometryB.dispose();
    this.root.removeFromParent();
  }
}

/* -------------------- helpers -------------------- */

function touches(threat: Threat, cell: Coord): boolean {
  return threat.window.some((c) => c.col === cell.col && c.row === cell.row);
}

/** Stable per-cell phase offset in 0..1. */
function hashPhase(col: number, row: number): number {
  const h = Math.sin(col * 127.1 + row * 311.7) * 43758.5453;
  return h - Math.floor(h);
}

export function createCoachOverlay(ctx: EffectContext): CoachOverlay {
  return new CoachOverlayImpl(ctx);
}

export { PULSE_PERIOD };
