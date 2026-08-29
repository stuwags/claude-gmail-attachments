/**
 * Win, loss and draw presentation (bible §6).
 *
 * One idea, executed slowly: the winning line becomes the only light in the
 * room. The house dims, the four discs ignite in sequence along the direction
 * they were won in, a filament draws itself through their centres, and the
 * camera leans in while the focus tightens. No confetti — the restraint is what
 * makes it read as a finished product rather than a toy.
 *
 * The sequence owns no state it can mutate directly. It publishes per-disc and
 * house-wide *treatments*, and the scene applies them; the camera and depth of
 * field are likewise requested, not commanded. That keeps the choreography here
 * and the rendering there, and means a change to the timeline cannot
 * accidentally desynchronise the camera rig's spring.
 */

import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  Points,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { Coord, Player } from '../../engine/types';
import { Player as P } from '../../engine/types';
import { cellPosition } from '../layout';
import type {
  DiscTreatment,
  EffectContext,
  HouseTreatment,
  OutcomeEffects,
} from './types';

/* -------------------- palette -------------------- */

const GOLD = new Color(0xffd9a8);
const PEWTER = new Color(0xadb9c6);
const GLOW: Record<Player, Color> = {
  [P.One]: new Color(0xff9666),
  [P.Two]: new Color(0x53d7db),
};

/* -------------------- timeline, seconds (bible §6.1) -------------------- */

const T_HOUSE_DIM = 0.12;
const HOUSE_DIM_DURATION = 0.4;
const T_IGNITE = 0.25;
const IGNITE_STAGGER = 0.09;
const IGNITE_DURATION = 0.35;
const T_FILAMENT = 0.4;
const FILAMENT_DURATION = 0.45;
const T_CAMERA = 0.7;
const CAMERA_DURATION = 1.2;
const T_MOTES = 0.9;
const MOTE_LIFETIME = 1.2;
const BREATHE_PERIOD = 1.8;

/** Loss-specific fades (§6.2) and draw fades (§6.3). */
const LOSS_FADE_DURATION = 0.8;
const DRAW_FADE_DURATION = 0.6;

type Mode = 'idle' | 'win' | 'draw';

/* -------------------- easing -------------------- */

/**
 * `gallery`: cubic-bezier(0.33, 0, 0.12, 1). Solved by Newton with a bisection
 * fallback — the curve is steep enough near t=0 that Newton alone can overshoot
 * out of the unit interval.
 */
function gallery(t: number): number {
  return cubicBezier(0.33, 0, 0.12, 1, clamp01(t));
}

function cubicBezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;

  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleDerivX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;

  let t = x;
  for (let i = 0; i < 8; i++) {
    const xAtT = sampleX(t) - x;
    if (Math.abs(xAtT) < 1e-6) break;
    const d = sampleDerivX(t);
    if (Math.abs(d) < 1e-6) break;
    t -= xAtT / d;
  }
  if (t < 0 || t > 1) {
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 24; i++) {
      const xAtT = sampleX(t);
      if (Math.abs(xAtT - x) < 1e-6) break;
      if (xAtT < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
  }
  return ((ay * t + by) * t + cy) * t;
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
/** Progress through a window that starts at `start` and lasts `duration`. */
const phase = (t: number, start: number, duration: number) => clamp01((t - start) / duration);

/* -------------------- shaders -------------------- */

/**
 * The core filament draws itself along its own length. Clipping in the shader
 * rather than scaling the mesh keeps the rounded caps the right size while the
 * line grows, which a scale animation cannot do.
 */
const LINE_VERTEX = /* glsl */ `
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

const LINE_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uProgress;
  uniform float uIntensity;
  varying vec2 vUv;
  varying vec3 vNormalView;
  varying vec3 vPositionView;

  void main() {
    if (vUv.y > uProgress) discard;

    vec3 viewDir = normalize(-vPositionView);
    float facing = abs(dot(normalize(vNormalView), viewDir));
    float rim = mix(0.6, 1.0, pow(1.0 - facing, 1.5));

    // A brighter head at the drawing edge, so the line reads as being drawn
    // rather than simply revealed.
    float head = smoothstep(0.14, 0.0, uProgress - vUv.y) * 0.8;

    gl_FragColor = vec4(uColor * uIntensity * (rim + head), 1.0);
  }
`;

const MOTE_VERTEX = /* glsl */ `
  attribute float aSeed;
  attribute vec3 aVelocity;
  uniform float uTime;
  uniform float uLifetime;
  uniform float uPixelRatio;
  varying float vAlpha;

  void main() {
    float age = uTime - aSeed * 0.35;
    if (age < 0.0 || age > uLifetime) {
      vAlpha = 0.0;
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // Off-screen; cheaper than a discard.
      gl_PointSize = 0.0;
      return;
    }

    float t = age / uLifetime;
    // Gentle curl, so the motes drift rather than marching in parallel.
    vec3 curl = vec3(
      sin(aSeed * 12.9 + age * 1.7) * 0.006,
      0.0,
      cos(aSeed * 7.3 + age * 1.3) * 0.006
    );
    vec3 pos = position + aVelocity * age + curl * t;

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    // Fade in fast, out slow: a spark, not a blink.
    vAlpha = smoothstep(0.0, 0.12, t) * (1.0 - smoothstep(0.45, 1.0, t));
    gl_PointSize = (1.4 + aSeed * 0.9) * uPixelRatio * (12.0 / -mvPosition.z);
  }
`;

const MOTE_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = length(d);
    if (r > 0.5) discard;
    float falloff = 1.0 - smoothstep(0.0, 0.5, r);
    gl_FragColor = vec4(uColor * falloff * vAlpha * 0.6, 1.0);
  }
`;

/* -------------------- implementation -------------------- */

class OutcomeEffectsImpl implements OutcomeEffects {
  private readonly ctx: EffectContext;
  private readonly root = new Group();

  private mode: Mode = 'idle';
  private t = 0;
  private line: Coord[] = [];
  private winner: Player = P.One;
  private humanLost = false;
  /** Cell key -> index along the winning line, for the ignition cascade. */
  private lineIndex = new Map<string, number>();

  private filament: Mesh | null = null;
  private filamentMaterial: ShaderMaterial | null = null;
  private motes: Points | null = null;
  private moteMaterial: ShaderMaterial | null = null;

  constructor(ctx: EffectContext) {
    this.ctx = ctx;
    this.root.name = 'outcome-effects';
    ctx.boardRoot.add(this.root);
  }

  get active(): boolean {
    if (this.mode === 'idle') return false;
    // The sequence keeps breathing after it settles; "active" means still
    // choreographing, which is what the harness waits on.
    return this.t < T_MOTES + MOTE_LIFETIME + 0.2;
  }

  /* -------------------- entry points -------------------- */

  playWin(line: readonly Coord[], winner: Player, humanLost: boolean): void {
    this.clear();
    this.mode = 'win';
    this.t = 0;
    this.line = [...line];
    this.winner = winner;
    this.humanLost = humanLost;

    this.lineIndex.clear();
    this.line.forEach((c, i) => this.lineIndex.set(key(c.col, c.row), i));

    this.buildFilament();
    this.buildMotes();
  }

  playDraw(): void {
    this.clear();
    this.mode = 'draw';
    this.t = 0;
  }

  clear(): void {
    this.mode = 'idle';
    this.t = 0;
    this.line = [];
    this.lineIndex.clear();
    this.teardownMeshes();
  }

  update(dt: number): void {
    if (this.mode === 'idle') return;
    this.t += dt;

    if (this.filamentMaterial) {
      const p = this.ctx.reducedMotion
        ? 1
        : gallery(phase(this.t, T_FILAMENT, FILAMENT_DURATION));
      this.filamentMaterial.uniforms.uProgress.value = p;
    }
    if (this.moteMaterial) {
      this.moteMaterial.uniforms.uTime.value = Math.max(0, this.t - T_MOTES);
    }
  }

  /* -------------------- published treatments -------------------- */

  treatmentFor(col: number, row: number): DiscTreatment | null {
    if (this.mode === 'idle') return null;

    if (this.mode === 'draw') {
      const d = gallery(phase(this.t, 0, DRAW_FADE_DURATION)) * 0.2;
      return { ignition: 0, desaturation: d, darken: 1, roughnessBias: 0 };
    }

    const idx = this.lineIndex.get(key(col, row));
    if (idx !== undefined) {
      // Winning disc: ignite on its stagger, then breathe.
      const start = T_IGNITE + idx * IGNITE_STAGGER;
      const ramp = gallery(phase(this.t, start, IGNITE_DURATION));
      const sinceLit = Math.max(0, this.t - (start + IGNITE_DURATION));
      const breathe = this.ctx.reducedMotion
        ? 0.925
        : 0.85 + 0.15 * (0.5 + 0.5 * Math.sin((sinceLit / BREATHE_PERIOD) * Math.PI * 2));
      return {
        ignition: ramp * breathe * 2.2,
        desaturation: 0,
        darken: 1,
        roughnessBias: 0,
      };
    }

    // Everything else recedes with the house.
    const houseP = gallery(phase(this.t, T_HOUSE_DIM, HOUSE_DIM_DURATION));
    let desaturation = houseP * 0.15;
    let roughnessBias = 0;

    // In a loss the human's own discs go further: cold clay (§6.2).
    if (this.humanLost) {
      const owner = this.ownerAt(col, row);
      if (owner !== null && owner !== this.winner) {
        const lossP = gallery(phase(this.t, T_HOUSE_DIM, LOSS_FADE_DURATION));
        desaturation = Math.max(desaturation, lossP * 0.3);
        roughnessBias = lossP * 0.15;
      }
    }

    return { ignition: 0, desaturation, darken: 1 - houseP * 0.18, roughnessBias };
  }

  house(): HouseTreatment {
    if (this.mode === 'idle') {
      return { desaturation: 0, darken: 1, keyTemperatureShift: 0, vignetteBias: 0 };
    }
    if (this.mode === 'draw') {
      const p = gallery(phase(this.t, 0, DRAW_FADE_DURATION));
      return { desaturation: p * 0.2, darken: 1, keyTemperatureShift: 0, vignetteBias: 0 };
    }

    const p = gallery(phase(this.t, T_HOUSE_DIM, HOUSE_DIM_DURATION));
    return {
      desaturation: p * 0.15,
      darken: 1 - p * 0.18,
      keyTemperatureShift: this.humanLost ? -300 * p : 0,
      vignetteBias: this.humanLost ? 0.06 * p : 0,
    };
  }

  cameraRequest(): { dollyScale: number; orbitDegrees: number; durationMs: number } | null {
    if (this.mode === 'idle') return null;
    if (this.mode === 'draw') {
      return { dollyScale: 1.04, orbitDegrees: 0, durationMs: 900 };
    }
    if (this.t < T_CAMERA) return null;
    // Toward the winning line's normal, capped at the bible's 3 degrees.
    const orbit = this.line.length >= 2 ? this.orbitTowardLine() : 0;
    return { dollyScale: 0.93, orbitDegrees: orbit, durationMs: CAMERA_DURATION * 1000 };
  }

  focusRequest(): { worldFocusRange: number; bokehScale: number } | null {
    if (this.mode !== 'win') return null;
    if (this.t < T_CAMERA) return null;
    return { worldFocusRange: 0.12, bokehScale: 3.2 };
  }

  dispose(): void {
    this.teardownMeshes();
    this.root.removeFromParent();
  }

  /* -------------------- internals -------------------- */

  private ownerAt(col: number, row: number): Player | null {
    const mesh = this.ctx.discAt(col, row);
    if (!mesh) return null;
    // The scene tags each disc with its owner; fall back to "not the winner"
    // rather than guessing if the tag is missing.
    const owner = (mesh.userData as { player?: Player }).player;
    return owner === undefined ? null : owner;
  }

  /** Lean toward the side the line runs, so the win reads three-dimensionally. */
  private orbitTowardLine(): number {
    const a = this.line[0];
    const b = this.line[this.line.length - 1];
    const dx = b.col - a.col;
    const dy = b.row - a.row;
    if (dx === 0) return 0; // Vertical line: no horizontal lean to make.
    const lean = Math.sign(dx) * (Math.abs(dy) > 0 ? 3 : 2);
    return lean;
  }

  private buildFilament(): void {
    if (this.line.length < 2) return;
    const a = new Vector3(...cellPosition(this.line[0].col, this.line[0].row));
    const b = new Vector3(
      ...cellPosition(this.line[this.line.length - 1].col, this.line[this.line.length - 1].row),
    );

    const length = a.distanceTo(b);
    // 3 mm diameter with rounded caps; the cap segments are what stop the line
    // ending in a visible flat disc when it is drawn head-on.
    const geometry: BufferGeometry = new CylinderGeometry(0.0015, 0.0015, length, 16, 1, false);

    const material = new ShaderMaterial({
      vertexShader: LINE_VERTEX,
      fragmentShader: LINE_FRAGMENT,
      uniforms: {
        uColor: { value: this.humanLost ? PEWTER : GOLD },
        uProgress: { value: 0 },
        uIntensity: { value: 3.0 },
      },
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      toneMapped: true,
    });

    const mesh = new Mesh(geometry, material);
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), b.clone().sub(a).normalize());
    mesh.renderOrder = 6;
    this.root.add(mesh);

    this.filament = mesh;
    this.filamentMaterial = material;
  }

  private buildMotes(): void {
    if (this.ctx.reducedMotion) return; // Static under reduced motion (§9.18).
    if (this.ctx.quality === 'low') return;

    const perDisc = 13;
    const count = this.line.length * perDisc;
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);
    const seeds = new Float32Array(count);

    let i = 0;
    for (const cell of this.line) {
      const [x, y, z] = cellPosition(cell.col, cell.row);
      for (let k = 0; k < perDisc; k++) {
        const angle = Math.random() * Math.PI * 2;
        const radius = Math.random() * 0.016;
        positions[i * 3] = x + Math.cos(angle) * radius;
        positions[i * 3 + 1] = y + Math.sin(angle) * radius * 0.6;
        positions[i * 3 + 2] = z + (Math.random() - 0.5) * 0.006;

        velocities[i * 3] = (Math.random() - 0.5) * 0.012;
        velocities[i * 3 + 1] = 0.05 + Math.random() * 0.02; // 0.05 m/s upward
        velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.008;

        seeds[i] = Math.random();
        i++;
      }
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setAttribute('aVelocity', new Float32BufferAttribute(velocities, 3));
    geometry.setAttribute('aSeed', new Float32BufferAttribute(seeds, 1));

    const material = new ShaderMaterial({
      vertexShader: MOTE_VERTEX,
      fragmentShader: MOTE_FRAGMENT,
      uniforms: {
        uColor: { value: GLOW[this.winner] },
        uTime: { value: 0 },
        uLifetime: { value: MOTE_LIFETIME },
        uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
      },
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      toneMapped: true,
    });

    const points = new Points(geometry, material);
    points.renderOrder = 7;
    // Motes leave the board volume; frustum culling on a static bounding box
    // would pop them out as they rise.
    points.frustumCulled = false;
    this.root.add(points);

    this.motes = points;
    this.moteMaterial = material;
  }

  private teardownMeshes(): void {
    if (this.filament) {
      this.filament.geometry.dispose();
      this.filamentMaterial?.dispose();
      this.root.remove(this.filament);
      this.filament = null;
      this.filamentMaterial = null;
    }
    if (this.motes) {
      this.motes.geometry.dispose();
      this.moteMaterial?.dispose();
      this.root.remove(this.motes);
      this.motes = null;
      this.moteMaterial = null;
    }
  }
}

const key = (col: number, row: number) => `${col},${row}`;

export function createOutcomeEffects(ctx: EffectContext): OutcomeEffects {
  return new OutcomeEffectsImpl(ctx);
}
