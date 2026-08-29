/**
 * Procedural audio.
 *
 * Every sound is synthesised at startup into short `AudioBuffer`s — nothing is
 * downloaded. A disc hitting a plastic slot is a struck object, so the impacts
 * use modal synthesis: a noise exciter plus a handful of exponentially decaying
 * inharmonic partials. That gives an impact that changes character with how far
 * the disc fell and how deep the stack is, which a single recorded sample never
 * could, and it costs a few kilobytes of code instead of a megabyte of audio.
 *
 * Safari will not start an AudioContext without a user gesture, so the context
 * stays suspended until `unlock()` is called from a real pointer or key event.
 */

/** A single decaying partial in a struck-object model. */
interface Mode {
  /** Hz. */
  freq: number;
  /** Seconds to decay by 60 dB. */
  decay: number;
  /** Relative amplitude. */
  gain: number;
}

export interface AudioSettings {
  muted: boolean;
  /** 0..1 master trim. */
  volume: number;
}

const STORAGE_KEY = 'c4.audio';

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private reverbSend: GainNode | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private unlocked = false;
  private settings: AudioSettings = { muted: false, volume: 0.8 };

  constructor() {
    this.settings = this.load();
  }

  /* -------------------- lifecycle -------------------- */

  /**
   * Create and resume the context. Safe to call repeatedly; must be called
   * from inside a user gesture the first time or iOS keeps it suspended.
   */
  async unlock(): Promise<void> {
    if (this.unlocked) {
      if (this.ctx?.state === 'suspended') await this.ctx.resume();
      return;
    }

    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;

    const ctx = new Ctor({ latencyHint: 'interactive' });
    this.ctx = ctx;

    const master = ctx.createGain();
    master.gain.value = this.settings.muted ? 0 : this.settings.volume;
    master.connect(ctx.destination);
    this.master = master;

    // A small, fairly dead room. Enough to place the board on a table in a
    // space, not enough to sound like a cathedral.
    const convolver = ctx.createConvolver();
    convolver.buffer = this.makeImpulseResponse(ctx, 0.55, 3.4);
    const wet = ctx.createGain();
    wet.gain.value = 0.32;
    convolver.connect(wet).connect(master);
    const send = ctx.createGain();
    send.gain.value = 1;
    send.connect(convolver);
    this.reverbSend = send;

    this.buildBuffers(ctx);
    await ctx.resume();
    this.unlocked = true;
  }

  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
    this.buffers.clear();
    this.unlocked = false;
  }

  /* -------------------- settings -------------------- */

  get muted(): boolean {
    return this.settings.muted;
  }

  setMuted(muted: boolean): void {
    this.settings.muted = muted;
    this.applyGain();
    this.save();
  }

  setVolume(volume: number): void {
    this.settings.volume = Math.max(0, Math.min(1, volume));
    this.applyGain();
    this.save();
  }

  private applyGain(): void {
    if (!this.master || !this.ctx) return;
    const target = this.settings.muted ? 0 : this.settings.volume;
    // Ramp rather than jump, or muting mid-sound produces a click.
    this.master.gain.setTargetAtTime(target, this.ctx.currentTime, 0.02);
  }

  private load(): AudioSettings {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<AudioSettings>;
        return {
          muted: parsed.muted ?? false,
          volume: typeof parsed.volume === 'number' ? parsed.volume : 0.8,
        };
      }
    } catch {
      // Private browsing, or storage disabled. Defaults are fine.
    }
    return { muted: false, volume: 0.8 };
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch {
      // Not worth surfacing; the game plays fine without persisted volume.
    }
  }

  /* -------------------- playback -------------------- */

  /**
   * A disc striking the stack or the floor of the board.
   *
   * @param strength 0..1, from the impact speed.
   * @param stackHeight How many discs are already below it. A taller stack has
   *   less air column under the disc, which raises and shortens the click.
   */
  discImpact(strength: number, stackHeight: number): void {
    const s = Math.max(0, Math.min(1, strength));
    // Roughly a musical fifth of variation across a full column.
    const rate = 0.86 + stackHeight * 0.055 + (Math.random() - 0.5) * 0.05;
    this.play('impact', {
      gain: 0.22 + s * 0.5,
      rate,
      reverb: 0.18 + s * 0.12,
      pan: 0,
    });
    // A heavy landing also thumps the wooden base.
    if (s > 0.45) {
      this.play('body', { gain: (s - 0.45) * 0.5, rate: 0.95 + Math.random() * 0.1, reverb: 0.3 });
    }
  }

  /** The disc leaving the player's hand at the top of the column. */
  discRelease(): void {
    this.play('release', { gain: 0.16, rate: 0.95 + Math.random() * 0.12, reverb: 0.1 });
  }

  /** Disc sliding against the slot walls on the way down. */
  discSlide(): void {
    this.play('slide', { gain: 0.09, rate: 0.9 + Math.random() * 0.25, reverb: 0.12 });
  }

  uiTap(): void {
    this.play('tap', { gain: 0.25, rate: 1 + (Math.random() - 0.5) * 0.04, reverb: 0.05 });
  }

  uiHover(): void {
    this.play('tap', { gain: 0.07, rate: 1.45, reverb: 0.03 });
  }

  /** A teaching-overlay hint appearing. Deliberately soft — it fires often. */
  hint(): void {
    this.play('hint', { gain: 0.13, rate: 1, reverb: 0.25 });
  }

  /** Rising major arpeggio. */
  win(): void {
    this.play('win', { gain: 0.4, rate: 1, reverb: 0.5 });
  }

  /** Falling minor figure. Disappointed, not punishing — children play this. */
  lose(): void {
    this.play('lose', { gain: 0.34, rate: 1, reverb: 0.45 });
  }

  draw(): void {
    this.play('draw', { gain: 0.32, rate: 1, reverb: 0.4 });
  }

  /** Illegal move: a short, dry, unmusical thud. */
  reject(): void {
    this.play('reject', { gain: 0.3, rate: 1, reverb: 0.05 });
  }

  private play(
    name: string,
    opts: { gain: number; rate?: number; reverb?: number; pan?: number },
  ): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || this.settings.muted) return;
    const buffer = this.buffers.get(name);
    if (!buffer) return;

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = opts.rate ?? 1;

    const gain = ctx.createGain();
    gain.gain.value = opts.gain;

    let node: AudioNode = gain;
    if (opts.pan !== undefined && typeof ctx.createStereoPanner === 'function') {
      const panner = ctx.createStereoPanner();
      panner.pan.value = opts.pan;
      gain.connect(panner);
      node = panner;
    }

    src.connect(gain);
    node.connect(master);

    if (this.reverbSend && opts.reverb) {
      const send = ctx.createGain();
      send.gain.value = opts.reverb * opts.gain;
      node.connect(send).connect(this.reverbSend);
    }

    src.start();
  }

  /* -------------------- synthesis -------------------- */

  private buildBuffers(ctx: AudioContext): void {
    this.buffers.set('impact', this.modal(ctx, 0.24, [
      // Inharmonic partials: a disc is a plate, not a string.
      { freq: 1180, decay: 0.055, gain: 1.0 },
      { freq: 2390, decay: 0.038, gain: 0.62 },
      { freq: 3710, decay: 0.026, gain: 0.34 },
      { freq: 5320, decay: 0.017, gain: 0.16 },
    ], 0.0035, 0.55));

    this.buffers.set('body', this.modal(ctx, 0.34, [
      { freq: 132, decay: 0.16, gain: 1.0 },
      { freq: 218, decay: 0.11, gain: 0.5 },
      { freq: 397, decay: 0.07, gain: 0.22 },
    ], 0.006, 0.3));

    this.buffers.set('tap', this.modal(ctx, 0.11, [
      { freq: 2100, decay: 0.02, gain: 1.0 },
      { freq: 3600, decay: 0.012, gain: 0.4 },
    ], 0.002, 0.35));

    this.buffers.set('reject', this.modal(ctx, 0.2, [
      { freq: 148, decay: 0.06, gain: 1.0 },
      { freq: 205, decay: 0.045, gain: 0.7 },
    ], 0.005, 0.6));

    this.buffers.set('release', this.noiseSweep(ctx, 0.16, 900, 320, 0.7));
    this.buffers.set('slide', this.noiseSweep(ctx, 0.13, 2600, 1500, 0.35));

    this.buffers.set('hint', this.tones(ctx, 0.45, [
      { freq: 1174.66, at: 0, dur: 0.3, gain: 0.5 }, // D6
      { freq: 1567.98, at: 0.055, dur: 0.34, gain: 0.35 }, // G6
    ]));

    // A major triad walking up to the octave.
    this.buffers.set('win', this.tones(ctx, 1.5, [
      { freq: 523.25, at: 0.0, dur: 0.62, gain: 0.55 }, // C5
      { freq: 659.25, at: 0.1, dur: 0.62, gain: 0.5 }, // E5
      { freq: 783.99, at: 0.2, dur: 0.66, gain: 0.5 }, // G5
      { freq: 1046.5, at: 0.3, dur: 0.85, gain: 0.6 }, // C6
      { freq: 1567.98, at: 0.42, dur: 0.72, gain: 0.28 }, // G6 shimmer
    ]));

    // Minor thirds settling downward. Gentle: losing should not sting.
    this.buffers.set('lose', this.tones(ctx, 1.3, [
      { freq: 440.0, at: 0.0, dur: 0.5, gain: 0.5 }, // A4
      { freq: 392.0, at: 0.13, dur: 0.52, gain: 0.45 }, // G4
      { freq: 349.23, at: 0.26, dur: 0.58, gain: 0.42 }, // F4
      { freq: 261.63, at: 0.4, dur: 0.8, gain: 0.5 }, // C4
    ]));

    // Two notes a fourth apart, unresolved — nobody won.
    this.buffers.set('draw', this.tones(ctx, 1.0, [
      { freq: 392.0, at: 0.0, dur: 0.6, gain: 0.45 },
      { freq: 523.25, at: 0.12, dur: 0.7, gain: 0.45 },
    ]));
  }

  /**
   * Modal synthesis: a burst of noise exciting a set of decaying resonances.
   * `exciterLen` is the contact time in seconds; `noiseMix` how much of the raw
   * strike survives into the output.
   */
  private modal(
    ctx: AudioContext,
    duration: number,
    modes: Mode[],
    exciterLen: number,
    noiseMix: number,
  ): AudioBuffer {
    const sr = ctx.sampleRate;
    const n = Math.ceil(duration * sr);
    const buf = ctx.createBuffer(1, n, sr);
    const out = buf.getChannelData(0);

    const exciterSamples = Math.max(1, Math.ceil(exciterLen * sr));
    // Deterministic-ish noise; the variation between plays comes from playbackRate.
    let seed = 0x9e3779b9;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296 - 0.5;
    };

    for (let i = 0; i < n; i++) {
      const t = i / sr;
      let sample = 0;

      for (const m of modes) {
        // -60 dB over `decay` seconds.
        const env = Math.exp((-6.9078 * t) / m.decay);
        sample += m.gain * env * Math.sin(2 * Math.PI * m.freq * t);
      }
      sample /= modes.reduce((a, m) => a + m.gain, 0);

      if (i < exciterSamples) {
        const e = 1 - i / exciterSamples;
        sample += rnd() * 2 * noiseMix * e * e;
      }

      out[i] = sample;
    }

    this.fadeOut(out, sr, 0.008);
    return buf;
  }

  /** Filtered noise sweeping in pitch — air moving, or a surface scraping. */
  private noiseSweep(
    ctx: AudioContext,
    duration: number,
    fromHz: number,
    toHz: number,
    resonance: number,
  ): AudioBuffer {
    const sr = ctx.sampleRate;
    const n = Math.ceil(duration * sr);
    const buf = ctx.createBuffer(1, n, sr);
    const out = buf.getChannelData(0);

    let seed = 0x1234567;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296 - 0.5;
    };

    // One-pole state-variable bandpass, swept across the buffer.
    let low = 0;
    let band = 0;
    for (let i = 0; i < n; i++) {
      const p = i / n;
      const f = fromHz + (toHz - fromHz) * p;
      const fc = 2 * Math.sin((Math.PI * Math.min(f, sr / 2.5)) / sr);
      const q = 1 - resonance;

      const input = rnd() * 2;
      low += fc * band;
      const high = input - low - q * band;
      band += fc * high;

      // Bell-shaped envelope: fades in and out, no click at either end.
      const env = Math.sin(Math.PI * p) ** 1.5;
      out[i] = band * env * 0.5;
    }

    this.fadeOut(out, sr, 0.01);
    return buf;
  }

  /** A short melodic figure of soft, slightly detuned bell tones. */
  private tones(
    ctx: AudioContext,
    duration: number,
    notes: { freq: number; at: number; dur: number; gain: number }[],
  ): AudioBuffer {
    const sr = ctx.sampleRate;
    const n = Math.ceil(duration * sr);
    const buf = ctx.createBuffer(2, n, sr);
    const left = buf.getChannelData(0);
    const right = buf.getChannelData(1);

    for (const note of notes) {
      const start = Math.floor(note.at * sr);
      const len = Math.min(n - start, Math.ceil(note.dur * sr));
      // Slight stereo spread: high notes drift right, low notes left.
      const pan = Math.max(-0.4, Math.min(0.4, (Math.log2(note.freq / 523.25) * 0.22)));
      const lg = Math.cos(((pan + 1) * Math.PI) / 4);
      const rg = Math.sin(((pan + 1) * Math.PI) / 4);

      for (let i = 0; i < len; i++) {
        const t = i / sr;
        const env = Math.exp(-3.2 * (t / note.dur)) * (1 - Math.exp(-t * 260));
        // Fundamental plus a soft octave and a stretched partial: bell-like
        // without the metallic clang of pure inharmonicity.
        const s =
          Math.sin(2 * Math.PI * note.freq * t) +
          0.28 * Math.sin(2 * Math.PI * note.freq * 2.01 * t) +
          0.1 * Math.sin(2 * Math.PI * note.freq * 3.02 * t);
        const v = s * env * note.gain * 0.33;
        left[start + i] += v * lg;
        right[start + i] += v * rg;
      }
    }

    this.fadeOut(left, sr, 0.02);
    this.fadeOut(right, sr, 0.02);
    return buf;
  }

  /** Exponentially decaying noise: a serviceable small-room impulse response. */
  private makeImpulseResponse(ctx: AudioContext, duration: number, decay: number): AudioBuffer {
    const sr = ctx.sampleRate;
    const n = Math.ceil(duration * sr);
    const buf = ctx.createBuffer(2, n, sr);
    let seed = 0xabcdef;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296 - 0.5;
    };
    for (let c = 0; c < 2; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < n; i++) {
        const p = i / n;
        // A few milliseconds of pre-delay keeps the direct sound distinct.
        const gate = i < sr * 0.004 ? 0 : 1;
        ch[i] = rnd() * 2 * Math.pow(1 - p, decay) * gate;
      }
    }
    return buf;
  }

  /** Taper the tail so a buffer never ends on a discontinuity. */
  private fadeOut(data: Float32Array, sampleRate: number, seconds: number): void {
    const fade = Math.min(data.length, Math.ceil(seconds * sampleRate));
    for (let i = 0; i < fade; i++) {
      const idx = data.length - fade + i;
      data[idx] *= 1 - i / fade;
    }
  }
}
