// Streaming wake word detector with an adaptive noise-floor energy gate.
// Direct port of Android's WakeDetector.kt: a quiet room runs no model inference at all, and when
// sound opens the gate the model starts from its warm state and hears preRollFrames before it so
// the start of the wake word isn't clipped.

/** 80 ms at 16 kHz. */
export const WAKE_FRAME = 1280;
export const WAKE_RATE = 16_000;

export interface WakeModel {
  /** Scores the next WAKE_FRAME samples (floats in [-1, 1]). */
  step(frame: Float32Array): Promise<number> | number;
  /** Returns the model's streaming state to its post-warmup silence state. */
  reset(): void;
  close?(): Promise<void> | void;
}

export interface WakeLimits {
  /** Score above which a frame counts as the wake word. */
  threshold: number;
  /** Frames after a detection during which further detections are ignored (25 = 2 s). */
  refractoryFrames: number;
  /** How far above the noise floor (dB) a frame must be to open the gate. */
  marginDb: number;
  /** Absolute floor (dBFS) a frame must exceed to open the gate. */
  openDbfs: number;
  /** Frames whose quietest sets the room's noise floor (40 = 3.2 s). */
  floorFrames: number;
  /** Frames kept before the gate opens and fed on opening (25 = 2 s). */
  preRollFrames: number;
  /** Frames the gate stays open after the last loud frame (25 = 2 s). */
  hangFrames: number;
}

export const DEFAULT_WAKE_LIMITS: WakeLimits = {
  threshold: 0.7,
  refractoryFrames: 25,
  marginDb: 6.0,
  openDbfs: -62.0,
  floorFrames: 40,
  preRollFrames: 25,
  hangFrames: 25,
};

export interface WakeDetection {
  score: number;
  atFrame: number;
  /** Sample index in the `feed()` input where unheard audio after the detection begins. */
  rest: number;
}

/** RMS level in dBFS (-120 for digital silence). */
export function dbfs(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  const rms = Math.sqrt(sum / frame.length);
  return rms <= 1e-6 ? -120.0 : 20 * Math.log10(rms);
}

export class WakeDetector {
  private readonly model: WakeModel;
  private readonly limits: WakeLimits;
  private readonly getThreshold: () => number;

  private readonly pending = new Float32Array(WAKE_FRAME);
  private filled = 0;
  private readonly levels: Float64Array;
  private levelCount = 0;
  private readonly preRoll: Float32Array[] = [];
  private open = false;
  private hang = 0;
  private quietUntil = -1;

  /** Total 80 ms frames seen. */
  frames = 0;
  /** Frames actually scored by the model (frames - scored is what the gate saved). */
  scored = 0;
  /** Most recent model score (0 while gate is closed). */
  lastScore = 0;
  /** Highest score since `takePeak()`. */
  private peak = 0;

  constructor(
    model: WakeModel,
    limits: Partial<WakeLimits> = {},
    threshold?: () => number,
  ) {
    this.model = model;
    this.limits = { ...DEFAULT_WAKE_LIMITS, ...limits };
    this.getThreshold = threshold ?? (() => this.limits.threshold);
    this.levels = new Float64Array(this.limits.floorFrames);
  }

  get gateOpen(): boolean {
    return this.open;
  }

  /** Feeds 16 kHz mono PCM16 samples; returns a detection when one completes, leaving trailing samples unheard. */
  async feed(pcm: Int16Array, count = pcm.length): Promise<WakeDetection | null> {
    let i = 0;
    while (i < count) {
      const n = Math.min(count - i, WAKE_FRAME - this.filled);
      for (let k = 0; k < n; k++) this.pending[this.filled + k] = pcm[i + k] / 32768;
      this.filled += n;
      i += n;
      if (this.filled === WAKE_FRAME) {
        this.filled = 0;
        const hit = await this.processFrame(this.pending.slice());
        if (hit) return { ...hit, rest: i };
      }
    }
    return null;
  }

  /** Highest score since the last call, then forgets it. */
  takePeak(): number {
    const p = this.peak;
    this.peak = 0;
    return p;
  }

  /** Forgets buffered audio and gate state so the next sound opens the gate afresh. */
  reset(): void {
    this.filled = 0;
    this.levelCount = 0;
    this.preRoll.length = 0;
    this.open = false;
    this.hang = 0;
    this.lastScore = 0;
  }

  private async processFrame(frame: Float32Array): Promise<WakeDetection | null> {
    const at = this.frames++;
    const level = dbfs(frame);
    this.levels[this.levelCount++ % this.levels.length] = level;
    let floor = level;
    const seen = Math.min(this.levelCount, this.levels.length);
    for (let k = 0; k < seen; k++) {
      if (this.levels[k] < floor) floor = this.levels[k];
    }
    const loud = level >= this.limits.openDbfs && level >= floor + this.limits.marginDb;
    if (loud) this.hang = this.limits.hangFrames;

    if (!this.open) {
      if (!loud) {
        this.preRoll.push(frame);
        if (this.preRoll.length > this.limits.preRollFrames) this.preRoll.shift();
        this.lastScore = 0;
        return null;
      }
      this.open = true;
      this.model.reset();
      let found: WakeDetection | null = null;
      for (const f of this.preRoll) {
        const hit = await this.score(f, at);
        if (hit) found = hit;
      }
      this.preRoll.length = 0;
      const cur = await this.score(frame, at);
      return cur ?? found;
    }

    const found = await this.score(frame, at);
    if (!loud && --this.hang <= 0) {
      this.open = false;
      this.lastScore = 0;
    }
    return found;
  }

  private async score(frame: Float32Array, at: number): Promise<WakeDetection | null> {
    this.scored++;
    const s = await this.model.step(frame);
    this.lastScore = s;
    if (s > this.peak) this.peak = s;
    if (s <= this.getThreshold() || at < this.quietUntil) return null;
    this.quietUntil = at + this.limits.refractoryFrames;
    this.model.reset();
    return { score: s, atFrame: at, rest: 0 };
  }
}
