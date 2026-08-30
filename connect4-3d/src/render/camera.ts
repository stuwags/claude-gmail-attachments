/**
 * The camera rig (bible §1.3, §1.4, §5.1).
 *
 * The camera is on a tripod, not a turntable. Everything here is an offset from
 * one fixed rest pose: a ±5° yaw, +3/−2° pitch envelope about the target at a
 * constant 1.24 m. There is no orbit control and there is no code path that
 * could become one.
 *
 * Parallax runs through a real second-order spring rather than the usual
 * `lerp(current, target, 0.1)`. A lerp is frame-rate dependent and, more
 * importantly, has an exponential arrival with no momentum — it reads as a
 * cursor being dragged. A critically damped spring overshoots by nothing and
 * still has weight on the way in, which is the difference between a camera on
 * a head and a camera on a slider.
 */

import { PerspectiveCamera, Vector3 } from 'three';

import { CAMERA_FOV, CAMERA_REST_POSITION, CAMERA_TARGET } from './layout';

const DEG = Math.PI / 180;

/* ------------------------------------------------------------------ *
 * Named curves (bible §5.1)
 * ------------------------------------------------------------------ */

export type Easing = (t: number) => number;

/**
 * CSS-compatible cubic-bezier. Newton-Raphson on x with a bisection fallback,
 * because `gallery`'s (0.33, 0, 0.12, 1) has a near-zero derivative at both
 * ends where Newton alone diverges.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): Easing {
  const A = (a: number, b: number) => 1 - 3 * b + 3 * a;
  const B = (a: number, b: number) => 3 * b - 6 * a;
  const C = (a: number) => 3 * a;
  const calc = (t: number, a: number, b: number) => ((A(a, b) * t + B(a, b)) * t + C(a)) * t;
  const slope = (t: number, a: number, b: number) =>
    3 * A(a, b) * t * t + 2 * B(a, b) * t + C(a);

  return (x: number): number => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const d = slope(t, x1, x2);
      if (Math.abs(d) < 1e-6) break;
      const err = calc(t, x1, x2) - x;
      if (Math.abs(err) < 1e-6) return calc(t, y1, y2);
      t -= err / d;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 24; i++) {
      const err = calc(t, x1, x2) - x;
      if (Math.abs(err) < 1e-6) break;
      if (err > 0) hi = t;
      else lo = t;
      t = (lo + hi) / 2;
    }
    return calc(t, y1, y2);
  };
}

export const EASE = {
  gallery: cubicBezier(0.33, 0, 0.12, 1),
  arrive: cubicBezier(0.16, 1, 0.3, 1),
  uiIn: cubicBezier(0.32, 0.72, 0, 1),
  uiOut: cubicBezier(0.4, 0, 1, 1),
  hover: cubicBezier(0.25, 0.46, 0.45, 0.94),
} as const;

/* ------------------------------------------------------------------ *
 * Springs
 * ------------------------------------------------------------------ */

/**
 * One degree of freedom of a damped harmonic oscillator, integrated
 * semi-implicitly and substepped to 120 Hz.
 *
 * Substepping is not optional: at k = 170 the undamped period is 480 ms, and a
 * single explicit step across a dropped 100 ms frame is unstable enough to fling
 * the camera. Fixing the substep also makes the motion identical at 60 and
 * 120 Hz, which the screenshot harness depends on.
 */
class Spring {
  value = 0;
  velocity = 0;

  constructor(
    private readonly k: number,
    private readonly c: number,
  ) {}

  step(target: number, dt: number): number {
    const steps = Math.min(16, Math.max(1, Math.ceil(dt / (1 / 120))));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const a = -this.k * (this.value - target) - this.c * this.velocity;
      this.velocity += a * h;
      this.value += this.velocity * h;
    }
    return this.value;
  }

  /** True once the spring has stopped meaningfully moving. */
  settled(target: number, epsilon = 1e-4): boolean {
    return Math.abs(this.value - target) < epsilon && Math.abs(this.velocity) < epsilon;
  }

  snap(v: number): void {
    this.value = v;
    this.velocity = 0;
  }
}

interface Pose {
  yaw: number;
  pitch: number;
  radius: number;
}

/* ------------------------------------------------------------------ *
 * The rig
 * ------------------------------------------------------------------ */

/** Below this aspect the board is fitted by horizontal FOV instead (bible §1.3). */
const NARROW_ASPECT = 1.2;

export class CameraRig {
  readonly camera: PerspectiveCamera;

  private readonly target = new Vector3(...CAMERA_TARGET);
  private readonly base: Pose;
  /** Horizontal FOV that 22° vertical yields at the 1.2 aspect threshold. */
  private readonly hFovThreshold: number;

  private readonly yawSpring = new Spring(60, 15.5);
  private readonly pitchSpring = new Spring(60, 15.5);
  /** Landing settle. Stiffer and shorter: 1.2 mm, gone in about 180 ms. */
  private readonly nudgeSpring = new Spring(170, 26);

  private parallaxX = 0;
  private parallaxY = 0;
  private breathT = 0;

  /** Win framing: a radius scale and a yaw offset, applied to the goal pose. */
  private dollyScale = 1;
  private orbitOffset = 0;

  private move: { from: Pose; ease: Easing; holdMs: number; durationMs: number; t: number } | null =
    null;

  /** Last pose actually written to the camera, breath excluded. */
  private placed: Pose;

  constructor(private readonly reducedMotion: boolean) {
    const rest = new Vector3(...CAMERA_REST_POSITION);
    const offset = rest.clone().sub(this.target);
    const radius = offset.length();
    this.base = {
      // Derived from the rest pose rather than hard-coded: layout.ts is the one
      // place a dimension may live, and these come out at the bible's 6.1° and
      // 8.8° to four decimals.
      yaw: Math.atan2(offset.x, offset.z),
      pitch: Math.asin(offset.y / radius),
      radius,
    };

    this.camera = new PerspectiveCamera(CAMERA_FOV, 1.6, 0.05, 30);
    this.hFovThreshold = 2 * Math.atan(Math.tan((CAMERA_FOV * DEG) / 2) * NARROW_ASPECT);
    this.yawSpring.snap(this.base.yaw);
    this.pitchSpring.snap(this.base.pitch);
    this.placed = { ...this.base };
    this.place(this.base, 0);
  }

  /* ---- viewport ---- */

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    // Narrow windows fit by horizontal FOV so the 366 mm board never crops. The
    // two branches agree exactly at aspect 1.2, so a slow resize does not pop.
    this.camera.fov =
      aspect >= NARROW_ASPECT
        ? CAMERA_FOV
        : (2 * Math.atan(Math.tan(this.hFovThreshold / 2) / aspect)) / DEG;
    this.camera.updateProjectionMatrix();
  }

  /* ---- interaction ---- */

  /** Pointer or device tilt, both normalised to -1..1. */
  setParallax(x: number, y: number): void {
    if (this.reducedMotion) return;
    this.parallaxX = Math.max(-1, Math.min(1, x));
    this.parallaxY = Math.max(-1, Math.min(1, y));
  }

  /** The 1.2 mm settle a heavy disc puts through the tripod (bible §5.2). */
  nudge(metres = 0.0012): void {
    if (this.reducedMotion) return;
    this.nudgeSpring.value -= metres;
  }

  /** Intro move: high, wide and far, arriving at rest over 1.4 s (bible §1.4). */
  playIntro(): void {
    if (this.reducedMotion) {
      this.move = null;
      return;
    }
    this.move = {
      from: { yaw: this.base.yaw + 14 * DEG, pitch: this.base.pitch + 6 * DEG, radius: 1.55 },
      ease: EASE.arrive,
      holdMs: 200,
      durationMs: 1400,
      t: 0,
    };
  }

  /**
   * A scripted move requested by the outcome sequence. Radius, yaw and pitch
   * always travel together — animating one axis alone is the tell that a camera
   * is being driven by code rather than by a person on a tripod.
   */
  requestFraming(dollyScale: number, orbitDegrees: number, durationMs: number): void {
    this.dollyScale = dollyScale;
    this.orbitOffset = orbitDegrees * DEG;
    this.move = {
      from: this.currentPose(),
      ease: EASE.gallery,
      holdMs: 0,
      durationMs: this.reducedMotion ? 1 : durationMs,
      t: 0,
    };
  }

  clearFraming(durationMs = 900): void {
    if (this.dollyScale === 1 && this.orbitOffset === 0) return;
    const from = this.currentPose();
    this.dollyScale = 1;
    this.orbitOffset = 0;
    this.move = { from, ease: EASE.gallery, holdMs: 0, durationMs, t: 0 };
  }

  /* ---- frame ---- */

  update(dtSeconds: number): void {
    const goal = this.goalPose();

    const yaw = this.yawSpring.step(goal.yaw, dtSeconds);
    const pitch = this.pitchSpring.step(goal.pitch, dtSeconds);
    const settle = this.nudgeSpring.step(0, dtSeconds);

    let pose: Pose = { yaw, pitch, radius: goal.radius };

    if (this.move) {
      this.move.t += dtSeconds * 1000;
      const local = this.move.t - this.move.holdMs;
      if (local >= this.move.durationMs) {
        this.move = null;
      } else {
        const p = local <= 0 ? 0 : this.move.ease(local / this.move.durationMs);
        pose = {
          yaw: lerp(this.move.from.yaw, yaw, p),
          pitch: lerp(this.move.from.pitch, pitch, p),
          radius: lerp(this.move.from.radius, goal.radius, p),
        };
      }
    }

    this.placed = pose;

    // Idle breathing is added after the spring, not fed into it. It is a slow
    // open-loop drift, not something the camera is chasing, and routing it
    // through the spring would leave a permanent tracking velocity that
    // `settle()` would wait on forever.
    let breath = 0;
    if (!this.reducedMotion) {
      this.breathT = (this.breathT + dtSeconds) % 14;
      breath = Math.sin((this.breathT / 14) * Math.PI * 2) * 0.2 * DEG;
    }

    this.place({ ...pose, yaw: pose.yaw + breath }, settle);
  }

  private goalPose(): Pose {
    return {
      yaw: this.base.yaw + this.parallaxX * 5 * DEG + this.orbitOffset,
      pitch: this.base.pitch + (this.parallaxY >= 0 ? this.parallaxY * 3 : this.parallaxY * 2) * DEG,
      radius: this.base.radius * this.dollyScale,
    };
  }

  private currentPose(): Pose {
    return { ...this.placed };
  }

  private place(pose: Pose, verticalSettle: number): void {
    const cp = Math.cos(pose.pitch);
    this.camera.position.set(
      this.target.x + pose.radius * Math.sin(pose.yaw) * cp,
      this.target.y + pose.radius * Math.sin(pose.pitch) + verticalSettle,
      this.target.z + pose.radius * Math.cos(pose.yaw) * cp,
    );
    this.camera.lookAt(this.target);
  }

  /* ---- queries ---- */

  /** World-space camera-to-target distance; the DoF chain tracks this. */
  focusDistance(): number {
    return this.camera.position.distanceTo(this.target);
  }

  /** True while any camera animation is still running. Drives `settle()`. */
  get busy(): boolean {
    if (this.move) return true;
    const goal = this.goalPose();
    return (
      !this.yawSpring.settled(goal.yaw, 2e-4) ||
      !this.pitchSpring.settled(goal.pitch, 2e-4) ||
      !this.nudgeSpring.settled(0, 2e-5)
    );
  }

  /** Drop every animation and sit exactly at the rest pose. */
  snapToRest(): void {
    this.move = null;
    this.dollyScale = 1;
    this.orbitOffset = 0;
    this.yawSpring.snap(this.base.yaw);
    this.pitchSpring.snap(this.base.pitch);
    this.nudgeSpring.snap(0);
    this.placed = { ...this.base };
    this.place(this.base, 0);
  }
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
