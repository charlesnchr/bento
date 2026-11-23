// Main-thread controller for the wake word Web Worker and Screen Wake Lock helper.
// Tags every load and reset with a monotonic generation (`gen`) so stale detections or ready events
// after a model switch or reset are ignored, and keeps a short ring buffer of recent fed chunks
// indexed by `seq` (with per-frame `suppressed` flags) so audio captured while the worker was
// scoring is preserved in `hit.trailing` without duplicating unsuppressed frames.

export interface WakeTelemetry {
  score: number;
  peak: number;
  gateOpen: boolean;
  frames: number;
  scored: number;
  inferMs: number;
}

export interface WakeTrailingChunk {
  /** Sequence number from `feed()`, matching the fed chunk. */
  seq: number;
  bytes: Uint8Array;
  /** True when the core suppressed (silenced) this frame during audible playback (`whileSpeaking !== "send"`). */
  suppressed: boolean;
}

export interface WakeDetectionEvent {
  score: number;
  atFrame: number;
  /** Audio chunks spoken after the wake word: the triggering chunk's tail plus any chunks already sent after it. */
  trailing: WakeTrailingChunk[];
  inferMs: number;
}

export interface WakeClientCallbacks {
  onReady?: (modelId: string, warmupMs: number) => void;
  onDetected: (hit: WakeDetectionEvent) => void;
  onTelemetry?: (t: WakeTelemetry) => void;
  /** Called once all in-flight suppressed frames have been scored without firing a detection. */
  onSuppressedSettled?: () => void;
  onError?: (message: string) => void;
}

export interface WorkerLike {
  onmessage: ((e: MessageEvent<Record<string, any>>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

/** Max buffered post-feed audio (~1.5 s at 20 ms chunks) to cover worker scoring latency. */
const RECENT_MAX_BYTES = Math.round(1.5 * 32_000);

export class WakeClient {
  private worker: WorkerLike | null = null;
  private readonly callbacks: WakeClientCallbacks;
  private readonly createWorker: () => WorkerLike;
  private loadedModelId: string | null = null;
  private loadingModelId: string | null = null;
  private currentThreshold = 0.7;
  private gen = 0;
  private seq = 0;
  private lastSuppressedSeq = 0;
  private lastAckedSeq = 0;
  private recent: { seq: number; bytes: Uint8Array; suppressed: boolean }[] = [];
  private recentBytes = 0;
  ready = false;

  constructor(
    callbacks: WakeClientCallbacks,
    createWorker: () => WorkerLike = () => new Worker("/wake.worker.js", { type: "module" }),
  ) {
    this.callbacks = callbacks;
    this.createWorker = createWorker;
  }

  /** Latest monotonic sequence number assigned by `feed()`. */
  get lastSeq(): number {
    return this.seq;
  }

  /** Highest sequence number of an in-flight suppressed frame, or 0 if none are scoring. */
  get inFlightSuppressedSeq(): number {
    return this.lastSuppressedSeq > this.lastAckedSeq ? this.lastSuppressedSeq : 0;
  }

  /** True while at least one suppressed frame is still queued or scoring in the worker. */
  get suppressedInFlight(): boolean {
    return this.inFlightSuppressedSeq > 0;
  }

  private clearRecent(): void {
    this.recent = [];
    this.recentBytes = 0;
  }

  private clearSuppressedTracking(): void {
    const hadInFlight = this.suppressedInFlight;
    this.lastSuppressedSeq = 0;
    this.lastAckedSeq = 0;
    if (hadInFlight) this.callbacks.onSuppressedSettled?.();
  }

  private ensureWorker(): WorkerLike {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    worker.onmessage = (e: MessageEvent<Record<string, any>>) => {
      const m = e.data;
      if (typeof m.gen === "number" && m.gen !== this.gen) return;
      if (m.type === "ready") {
        this.loadingModelId = null;
        this.loadedModelId = m.modelId;
        this.ready = true;
        this.callbacks.onReady?.(m.modelId, m.warmupMs);
      } else if (m.type === "ack") {
        const wasInFlight = this.suppressedInFlight;
        if (typeof m.seq === "number" && m.seq > this.lastAckedSeq) this.lastAckedSeq = m.seq;
        if (wasInFlight && !this.suppressedInFlight) this.callbacks.onSuppressedSettled?.();
      } else if (m.type === "detected") {
        const trailing: WakeTrailingChunk[] = [];
        const rest = new Uint8Array(m.restBytes as ArrayBuffer);
        const hitSeq = typeof m.seq === "number" ? m.seq : Number.MAX_SAFE_INTEGER;
        const hitItem = this.recent.find((item) => item.seq === hitSeq);
        if (rest.byteLength > 0) {
          trailing.push({ seq: hitSeq, bytes: rest, suppressed: hitItem?.suppressed ?? false });
        }
        for (const item of this.recent) {
          if (item.seq > hitSeq) trailing.push({ seq: item.seq, bytes: item.bytes, suppressed: item.suppressed });
        }
        this.clearRecent();
        this.lastSuppressedSeq = 0;
        this.lastAckedSeq = 0;
        this.callbacks.onDetected({
          score: m.score,
          atFrame: m.atFrame,
          trailing,
          inferMs: m.inferMs,
        });
      } else if (m.type === "telemetry") {
        this.callbacks.onTelemetry?.({
          score: m.score,
          peak: m.peak,
          gateOpen: m.gateOpen,
          frames: m.frames,
          scored: m.scored,
          inferMs: m.inferMs,
        });
      } else if (m.type === "error") {
        this.loadingModelId = null;
        this.ready = false;
        this.clearSuppressedTracking();
        this.callbacks.onError?.(String(m.message ?? "wake worker error"));
      }
    };
    worker.onerror = (err) => {
      this.loadingModelId = null;
      this.ready = false;
      this.clearSuppressedTracking();
      this.callbacks.onError?.(err.message || "wake worker failed");
    };
    this.worker = worker;
    return worker;
  }

  /** Loads (or switches to) the named model; ignores stale results from earlier loads. */
  load(modelId: string, threshold: number): void {
    this.currentThreshold = threshold;
    const worker = this.ensureWorker();
    if (this.ready && this.loadedModelId === modelId) {
      worker.postMessage({ type: "config", threshold });
      return;
    }
    if (this.loadingModelId === modelId) {
      worker.postMessage({ type: "config", threshold });
      return;
    }
    this.gen++;
    this.ready = false;
    this.loadingModelId = modelId;
    this.clearRecent();
    this.clearSuppressedTracking();
    worker.postMessage({
      type: "load",
      gen: this.gen,
      modelId,
      url: `/wake/models/${encodeURIComponent(modelId)}.onnx`,
      threshold,
      wasmPaths: "/ort/",
    });
  }

  setThreshold(threshold: number): void {
    this.currentThreshold = threshold;
    this.worker?.postMessage({ type: "config", threshold });
  }

  /** Feeds a 16 kHz PCM16 chunk to the worker; returns its sequence number (or 0 if not ready). */
  feed(samples: Int16Array, suppressed = false): number {
    if (!this.ready || !this.worker) return 0;
    const seq = ++this.seq;
    if (suppressed) this.lastSuppressedSeq = seq;
    const bytes = new Uint8Array(samples.byteLength);
    bytes.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
    this.recent.push({ seq, bytes, suppressed });
    this.recentBytes += bytes.byteLength;
    while (this.recentBytes > RECENT_MAX_BYTES && this.recent.length > 1) {
      this.recentBytes -= this.recent.shift()!.bytes.byteLength;
    }
    const copy = new Int16Array(samples.length);
    copy.set(samples);
    this.worker.postMessage({ type: "feed", gen: this.gen, seq, ack: suppressed, pcm: copy.buffer }, [copy.buffer]);
    return seq;
  }

  reset(): void {
    this.clearRecent();
    this.clearSuppressedTracking();
    if (!this.worker || !this.ready) return;
    this.gen++;
    this.worker.postMessage({ type: "reset", gen: this.gen });
  }

  dispose(): void {
    this.gen++;
    this.ready = false;
    this.loadedModelId = null;
    this.loadingModelId = null;
    this.clearRecent();
    this.clearSuppressedTracking();
    if (this.worker) {
      this.worker.postMessage({ type: "dispose", gen: this.gen });
      this.worker.terminate();
      this.worker = null;
    }
  }

  get modelId(): string | null {
    return this.loadedModelId ?? this.loadingModelId;
  }

  get threshold(): number {
    return this.currentThreshold;
  }
}

export interface WakeLockSentinelLike {
  readonly released?: boolean;
  release(): Promise<void>;
  addEventListener?(type: string, listener: () => void): void;
}

/**
 * Wraps the Screen Wake Lock API so browser-initiated releases (such as hiding a tab) clear the
 * stored sentinel and allow reacquiring on visibility restore, while cancelling in-flight requests.
 */
export class ScreenWakeLock {
  private sentinel: WakeLockSentinelLike | null = null;
  private gen = 0;
  private readonly requestLock: () => Promise<WakeLockSentinelLike | undefined>;

  constructor(
    requestLock: () => Promise<WakeLockSentinelLike | undefined> = () =>
      (navigator as any).wakeLock?.request("screen") ?? Promise.resolve(undefined),
  ) {
    this.requestLock = requestLock;
  }

  get held(): boolean {
    return this.sentinel != null && !this.sentinel.released;
  }

  async acquire(stillWanted: () => boolean): Promise<void> {
    if (this.held || !stillWanted()) return;
    const gen = ++this.gen;
    try {
      const lock = await this.requestLock();
      if (!lock) return;
      if (gen !== this.gen || !stillWanted()) {
        void lock.release().catch(() => {});
        return;
      }
      this.sentinel = lock;
      lock.addEventListener?.("release", () => {
        if (this.sentinel === lock) this.sentinel = null;
      });
    } catch {}
  }

  release(): void {
    this.gen++;
    const lock = this.sentinel;
    this.sentinel = null;
    void lock?.release().catch(() => {});
  }
}

export interface DeferredMicFrame {
  seq: number;
  floorSeq: number;
  pcm: string;
  t: number;
}

/**
 * Mirrors the voice core's playback suppression clock and coordinates deferred post-playback
 * microphone frames with asynchronous wake-word tail replay.
 *
 * Separating wake acceptance from replay eligibility (`replayFloorSeq`) ensures that forwarding
 * a gap frame before new playback never silences gap audio, never discards a valid wake hit,
 * and never replays older suppressed audio after newer audio already sent to the core.
 */
function validBriefPcmBytes(pcm: unknown): number {
  if (typeof pcm !== "string" || pcm.length === 0 || pcm.length % 4 !== 0) return -1;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(pcm)) return -1;
  const pad = pcm.endsWith("==") ? 2 : pcm.endsWith("=") ? 1 : 0;
  const size = Math.floor((pcm.length * 3) / 4) - pad;
  return size > 0 && size % 2 === 0 && size <= 2_880_000 ? size : -1;
}

export interface WakeAudioGateLimits {
  deliverMax?: number;
  briefWait?: number;
}

export class WakeAudioGate {
  private whileSpeaking = "send";
  private speechUntil = 0;
  private deliverMax = 30;
  private briefWait = 3;
  private activeBrief: { from: number; until: number; briefAt: number } | null = null;
  private readyBriefs: number[] = [];
  private requestedBriefs = new Map<string, number>();
  private lastCut: { at: number; briefAt: number } | null = null;
  private lastStoppedBriefAt: number | null = null;
  private replayFloorSeq = 0;
  private deferred: DeferredMicFrame[] = [];
  private readonly maxDeferred: number;

  constructor(maxDeferred = 60) {
    this.maxDeferred = maxDeferred;
  }

  reset(whileSpeaking = "send", floorSeq = 0, limits: WakeAudioGateLimits = {}): void {
    this.whileSpeaking = whileSpeaking;
    this.speechUntil = 0;
    this.deliverMax = typeof limits.deliverMax === "number" ? limits.deliverMax : 30;
    this.briefWait = typeof limits.briefWait === "number" ? limits.briefWait : 3;
    this.activeBrief = null;
    this.readyBriefs = [];
    this.requestedBriefs.clear();
    this.lastCut = null;
    this.lastStoppedBriefAt = null;
    this.replayFloorSeq = floorSeq;
    this.deferred = [];
  }

  get hasDeferred(): boolean {
    return this.deferred.length > 0;
  }

  isSuppressed(t: number): boolean {
    return this.whileSpeaking !== "send" && t < this.speechUntil;
  }

  onBriefRequest(id: string, eventTime: number): void {
    if (id) this.requestedBriefs.set(id, eventTime);
  }

  onPlay(pcmBase64: string, eventTime: number, source?: string): void {
    const pad = pcmBase64.endsWith("==") ? 2 : pcmBase64.endsWith("=") ? 1 : 0;
    const pcmBytes = Math.max(0, Math.floor((pcmBase64.length * 3) / 4) - pad);
    this.speechUntil = Math.max(this.speechUntil, eventTime) + pcmBytes / 48_000;
    if (source === "announcer") {
      const briefAt = this.readyBriefs.shift() ?? eventTime;
      this.activeBrief = { from: eventTime, until: this.speechUntil, briefAt };
      this.lastCut = null;
      this.lastStoppedBriefAt = null;
    }
  }

  onFlush(eventTime: number, hushed = false): void {
    this.speechUntil = Math.min(this.speechUntil, eventTime);
    if (this.activeBrief && eventTime >= this.activeBrief.until) {
      this.activeBrief = null;
    }
    if (this.activeBrief) {
      const a = this.activeBrief;
      this.activeBrief = null;
      // Match call.ts cutAnnouncement() and hushReply(): a brief hushed, >= 80% played,
      // or past deliverMax is not re-queued.
      const played = (eventTime - a.from) / Math.max(0.1, a.until - a.from);
      if (!hushed && played < 0.8 && eventTime - a.briefAt < this.deliverMax) {
        this.readyBriefs.push(a.briefAt);
        this.lastCut = { at: eventTime, briefAt: a.briefAt };
      } else {
        this.lastCut = null;
      }
      return;
    }
    // Saying "stop" over a brief cuts it on ACTIVITY_START and then hushes lastCut within 6 s.
    if (hushed && this.lastCut && eventTime - this.lastCut.at < 6) {
      const idx = this.readyBriefs.lastIndexOf(this.lastCut.briefAt);
      if (idx >= 0) {
        this.readyBriefs.splice(idx, 1);
        this.lastStoppedBriefAt = this.lastCut.briefAt;
      }
      this.lastCut = null;
    }
  }

  /** Mirrors core command side effects for playback, flushes, briefs, and voice stop commands. */
  observeCommands(
    commands: readonly { type: string; pcm?: unknown; source?: unknown; id?: unknown; command?: unknown; message?: unknown }[],
    eventTime: number,
    eventType?: string,
  ): void {
    const hushed =
      eventType === "interrupt" ||
      eventType === "stop" ||
      commands.some((c) => c.type === "voiceCommand" && (c.command === "stop" || c.command === "cancelAll"));
    for (const c of commands) {
      if (c.type === "play" && typeof c.pcm === "string") {
        this.onPlay(c.pcm, eventTime, typeof c.source === "string" ? c.source : undefined);
      } else if (c.type === "flush") {
        this.onFlush(eventTime, hushed);
      } else if (c.type === "brief" && typeof c.id === "string") {
        this.onBriefRequest(c.id, eventTime);
      } else if (c.type === "log" && c.message === "not a stop after all" && this.lastStoppedBriefAt != null) {
        this.readyBriefs.push(this.lastStoppedBriefAt);
        this.lastStoppedBriefAt = null;
      }
    }
  }

  /**
   * Called immediately before pushing an event to the core. Returns any deferred unsuppressed
   * gap frames that must reach the core first so new playback cannot silence them.
   */
  beforePush(
    event: { type?: unknown; id?: unknown; pcm?: unknown; text?: unknown; data?: unknown },
    eventTime = 0,
  ): { pcm: string; t: number }[] {
    let acceptedBrief = false;
    if (event.type === "brief.ready" && typeof event.id === "string") {
      const askedAt = this.requestedBriefs.get(event.id);
      if (askedAt !== undefined) {
        this.requestedBriefs.delete(event.id);
        const valid =
          eventTime - askedAt < this.briefWait &&
          validBriefPcmBytes(event.pcm) > 0 &&
          typeof event.text === "string" &&
          event.text.trim().length > 0;
        if (valid) {
          this.readyBriefs.push(eventTime);
          acceptedBrief = true;
        }
      }
    }
    if (this.deferred.length === 0) return [];
    const canStartPlayback =
      acceptedBrief ||
      (this.readyBriefs.length > 0 && event.type === "tick") ||
      (event.type === "ws.message" && String(event.data ?? "").includes('"inlineData"'));
    return canStartPlayback ? this.flushDeferred() : [];
  }

  flushDeferred(): { pcm: string; t: number }[] {
    if (this.deferred.length === 0) return [];
    const items = this.deferred.splice(0);
    for (const item of items) {
      if (item.floorSeq > this.replayFloorSeq) this.replayFloorSeq = item.floorSeq;
    }
    return items.map(({ pcm, t }) => ({ pcm, t }));
  }

  /** Detaches deferred frames before `push({ type: "wake" })` without bumping `replayFloorSeq` yet. */
  takeDeferred(): DeferredMicFrame[] {
    return this.deferred.splice(0);
  }

  onMicFrame(params: {
    pcm: string;
    t: number;
    seq: number;
    lastSeq: number;
    inFlightSuppressedSeq: number;
    suppressed: boolean;
  }): { pcm: string; t: number }[] {
    const floorSeq = params.seq > 0 ? params.seq : params.lastSeq;
    if (!params.suppressed && this.whileSpeaking !== "send" && params.inFlightSuppressedSeq > this.replayFloorSeq) {
      this.deferred.push({ seq: params.seq, floorSeq, pcm: params.pcm, t: params.t });
      if (this.deferred.length > this.maxDeferred) return this.flushDeferred();
      return [];
    }
    const out = this.flushDeferred();
    if (!params.suppressed && floorSeq > this.replayFloorSeq) {
      this.replayFloorSeq = floorSeq;
    }
    out.push({ pcm: params.pcm, t: params.t });
    return out;
  }

  /**
   * Computes the ordered mic frames to replay after `push({ type: "wake" })`, skipping any chunk
   * at or below `replayFloorSeq` so already-forwarded gap frames are never followed by older audio.
   */
  planWakeReplay(
    hit: WakeDetectionEvent,
    deferred: DeferredMicFrame[],
    bytesToBase64: (bytes: Uint8Array) => string,
  ): { pcm: string; t?: number }[] {
    const deferredSeqs = new Set(deferred.map((d) => d.seq).filter((s) => s > 0));
    const out: { pcm: string; t?: number }[] = [];
    const replayedSeqs = new Set<number>();
    let maxFloor = this.replayFloorSeq;
    for (const chunk of hit.trailing) {
      if (chunk.bytes.byteLength === 0) continue;
      if (chunk.seq <= this.replayFloorSeq) continue;
      if (!chunk.suppressed && !deferredSeqs.has(chunk.seq)) continue;
      if (chunk.seq > 0) {
        replayedSeqs.add(chunk.seq);
        if (chunk.seq > maxFloor) maxFloor = chunk.seq;
      }
      out.push({ pcm: bytesToBase64(chunk.bytes) });
    }
    for (const item of deferred) {
      if (item.floorSeq > maxFloor) maxFloor = item.floorSeq;
      if (item.seq > 0 && replayedSeqs.has(item.seq)) continue;
      out.push({ pcm: item.pcm, t: item.t });
    }
    this.replayFloorSeq = maxFloor;
    return out;
  }
}
