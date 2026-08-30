/**
 * Disc drop simulation. Metres and seconds, real gravity, per `ART_BIBLE` §5.2.
 *
 * Solved analytically rather than integrated per-frame. A dropped disc is a
 * ballistic body with a sequence of inelastic bounces, and every one of those
 * segments has a closed form, so the whole motion can be sampled at an
 * arbitrary time. Three things fall out of that:
 *
 *   - identical motion at 60Hz, at 120Hz on an iPad Pro, and in the screenshot
 *     harness, with no accumulated integration drift;
 *   - the harness can scrub to an exact moment mid-drop to review a frame;
 *   - the exact contact time is known up front, so the impact transient can be
 *     scheduled on the physics-contact frame rather than chased by a polling
 *     check that lands a frame or two late.
 *
 * Timing check, full-height drop (0.30 m): contact at 210 ms, one 90 ms bounce,
 * roll ringing out by 480 ms — the settle budget the bible allows.
 */

/** Tuning for how a disc feels when it falls. Defaults are the bible's numbers. */
export interface DropTuning {
  /** m/s². Real gravity at real scale is what reads as weight. */
  gravity: number;
  /** Downward push as the disc leaves the fingers, m/s. */
  releaseVelocity: number;
  /** Speed kept on the first bounce. */
  restitution: number;
  /** Each subsequent bounce multiplies the restitution by this. */
  restitutionDecay: number;
  /** Bounces slower than this are dropped, m/s. */
  killVelocity: number;
  /** Hard cap on bounce count. */
  maxBounces: number;
  /** Peak roll oscillation on impact, radians. */
  rollAmplitude: number;
  /** Seconds for the roll to become imperceptible. */
  rollDecayTime: number;
  /** Roll oscillation frequency, Hz. */
  rollFrequency: number;
}

export const DEFAULT_TUNING: DropTuning = {
  gravity: 9.81,
  releaseVelocity: 0.4,
  restitution: 0.18,
  restitutionDecay: 0.45,
  killVelocity: 0.05,
  maxBounces: 4,
  rollAmplitude: (1.2 * Math.PI) / 180,
  // Trimmed from the bible's nominal 300 ms so a full-height drop on this
  // board's actual geometry (0.318 m, not the bible's rounded 0.30 m) still
  // finishes inside the 480 ms settle budget.
  rollDecayTime: 0.26,
  rollFrequency: 11,
};

/** One contact during a drop, for scheduling sound and contact effects. */
export interface Impact {
  /** Seconds from release. */
  time: number;
  /** Closing speed at contact, m/s. Drives impact loudness. */
  speed: number;
  /** 0 for the landing, then 1, 2, … for successive bounces. */
  index: number;
}

/** The sampled state of a falling disc. */
export interface DropState {
  /** Height of the disc centre, metres. */
  y: number;
  /** Roll about the board's forward axis, radians. */
  roll: number;
  /** True once the disc has come fully to rest. */
  settled: boolean;
}

/** A precomputed drop. Cheap to sample; build one per dropped disc. */
export class DropTrack {
  /** Release to fully at rest, seconds. */
  readonly duration: number;
  /** Contacts in time order. The first is the landing. */
  readonly impacts: readonly Impact[];
  readonly startY: number;
  readonly restY: number;

  private readonly tuning: DropTuning;
  /** Segments: start time, upward launch speed (0 for the opening fall), duration. */
  private readonly segments: { t0: number; v0: number; dt: number }[] = [];
  /** Deterministic per-disc phase so no two drops rattle identically. */
  private readonly phase: number;

  constructor(startY: number, restY: number, tuning: DropTuning = DEFAULT_TUNING, seed = 0) {
    this.tuning = tuning;
    this.startY = startY;
    this.restY = restY;
    this.phase = (Math.sin(seed * 127.1 + 0.7) * 43758.5453) % (Math.PI * 2);

    const { gravity: g, releaseVelocity: v0 } = tuning;
    const fall = Math.max(0, startY - restY);
    const impacts: Impact[] = [];

    // Opening fall, launched downward at v0: fall = v0·t + ½g·t².
    const tFall = (-v0 + Math.sqrt(v0 * v0 + 2 * g * fall)) / g;
    let speed = v0 + g * tFall;
    this.segments.push({ t0: 0, v0: 0, dt: tFall });
    let t = tFall;
    impacts.push({ time: t, speed, index: 0 });

    // Bounces. Each is a symmetric hop; restitution fades with every contact.
    let restitution = tuning.restitution;
    for (let i = 0; i < tuning.maxBounces; i++) {
      const rebound = speed * restitution;
      if (rebound < tuning.killVelocity) break;
      const dt = (2 * rebound) / g;
      this.segments.push({ t0: t, v0: rebound, dt });
      t += dt;
      speed = rebound;
      restitution *= tuning.restitutionDecay;
      impacts.push({ time: t, speed, index: i + 1 });
    }

    this.impacts = impacts;
    // The disc is mechanically at rest at `t`; the roll keeps ringing after it.
    this.duration = Math.max(t, this.landingTimeOf(impacts) + tuning.rollDecayTime);
  }

  private landingTimeOf(impacts: Impact[]): number {
    return impacts.length ? impacts[0].time : 0;
  }

  /** Time of first contact — when the disc visually "lands". */
  get landingTime(): number {
    return this.landingTimeOf(this.impacts as Impact[]);
  }

  /** Sample the disc's state `t` seconds after release. */
  sample(t: number): DropState {
    const { gravity: g, releaseVelocity: v0, rollAmplitude, rollDecayTime, rollFrequency } =
      this.tuning;

    if (t <= 0) return { y: this.startY, roll: 0, settled: false };

    let y = this.restY;
    let inFlight = false;

    // At most maxBounces+1 segments, so a linear scan beats any cleverness.
    for (let i = 0; i < this.segments.length; i++) {
      const s = this.segments[i];
      if (t >= s.t0 && t < s.t0 + s.dt) {
        const lt = t - s.t0;
        y =
          i === 0
            ? this.startY - v0 * lt - 0.5 * g * lt * lt // opening fall
            : this.restY + s.v0 * lt - 0.5 * g * lt * lt; // hop
        inFlight = true;
        break;
      }
    }
    if (y < this.restY) y = this.restY;

    // Roll: the disc rocks between the slot walls, ringing down after contact.
    const sinceLanding = t - this.landingTime;
    let roll: number;
    if (sinceLanding > 0) {
      // Reach ~2% of amplitude at rollDecayTime, so it reads as fully stopped.
      const decay = Math.exp((-3.9 * sinceLanding) / rollDecayTime);
      roll = rollAmplitude * decay * Math.sin(sinceLanding * rollFrequency * Math.PI * 2 + this.phase);
    } else {
      // Falling: a slight constant lean, as if it left the fingers imperfectly.
      roll = rollAmplitude * 0.3 * Math.sin(this.phase);
    }

    const lastImpact = this.impacts.length ? this.impacts[this.impacts.length - 1].time : 0;
    return { y, roll, settled: !inFlight && t >= lastImpact };
  }
}

/**
 * How long a drop takes end to end, without keeping the track. Used by the
 * controller to schedule the AI's reply so the two never overlap.
 */
export function estimateDropDuration(
  startY: number,
  restY: number,
  tuning: DropTuning = DEFAULT_TUNING,
): number {
  return new DropTrack(startY, restY, tuning).duration;
}
