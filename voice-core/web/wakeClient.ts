// Main-thread controller for the wake word Web Worker.
// Tags every load and reset with a monotonic generation (`gen`) so stale detections or ready events
// after a model switch or reset are ignored, and keeps a short ring buffer of recent fed chunks
// indexed by `seq` so audio captured while the worker was scoring is preserved in `hit.trailing`.

export interface WakeTelemetry {
  score: number;
  peak: number;
  gateOpen: boolean;
  frames: number;
  scored: number;
  inferMs: number;
}

export interface WakeDetectionEvent {
  score: number;
  atFrame: number;
  /** Audio chunks spoken after the wake word: the triggering chunk's tail plus any chunks already sent after it. */
  trailing: Uint8Array[];
  inferMs: number;
}

export interface WakeClientCallbacks {
  onReady?: (modelId: string, warmupMs: number) => void;
  onDetected: (hit: WakeDetectionEvent) => void;
  onTelemetry?: (t: WakeTelemetry) => void;
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
  private recent: { seq: number; bytes: Uint8Array }[] = [];
  private recentBytes = 0;
  ready = false;

  constructor(
    callbacks: WakeClientCallbacks,
    createWorker: () => WorkerLike = () => new Worker("/wake.worker.js", { type: "module" }),
  ) {
    this.callbacks = callbacks;
    this.createWorker = createWorker;
  }

  private clearRecent(): void {
    this.recent = [];
    this.recentBytes = 0;
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
      } else if (m.type === "detected") {
        const trailing: Uint8Array[] = [];
        const rest = new Uint8Array(m.restBytes as ArrayBuffer);
        if (rest.byteLength > 0) trailing.push(rest);
        const hitSeq = typeof m.seq === "number" ? m.seq : Number.MAX_SAFE_INTEGER;
        for (const item of this.recent) {
          if (item.seq > hitSeq) trailing.push(item.bytes);
        }
        this.clearRecent();
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
        this.callbacks.onError?.(String(m.message ?? "wake worker error"));
      }
    };
    worker.onerror = (err) => {
      this.loadingModelId = null;
      this.ready = false;
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

  feed(samples: Int16Array): void {
    if (!this.ready || !this.worker) return;
    const seq = ++this.seq;
    const bytes = new Uint8Array(samples.byteLength);
    bytes.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
    this.recent.push({ seq, bytes });
    this.recentBytes += bytes.byteLength;
    while (this.recentBytes > RECENT_MAX_BYTES && this.recent.length > 1) {
      this.recentBytes -= this.recent.shift()!.bytes.byteLength;
    }
    const copy = new Int16Array(samples.length);
    copy.set(samples);
    this.worker.postMessage({ type: "feed", gen: this.gen, seq, pcm: copy.buffer }, [copy.buffer]);
  }

  reset(): void {
    this.clearRecent();
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
