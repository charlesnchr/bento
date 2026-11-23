// Main-thread controller for the wake word Web Worker.

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
  rest: Uint8Array;
  inferMs: number;
}

export interface WakeClientCallbacks {
  onReady?: (modelId: string, warmupMs: number) => void;
  onDetected: (hit: WakeDetectionEvent) => void;
  onTelemetry?: (t: WakeTelemetry) => void;
  onError?: (message: string) => void;
}

export class WakeClient {
  private worker: Worker | null = null;
  private callbacks: WakeClientCallbacks;
  private loadedModelId: string | null = null;
  private loadingModelId: string | null = null;
  private currentThreshold = 0.7;
  ready = false;

  constructor(callbacks: WakeClientCallbacks) {
    this.callbacks = callbacks;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker("/wake.worker.js", { type: "module" });
    worker.onmessage = (e: MessageEvent<Record<string, any>>) => {
      const m = e.data;
      if (m.type === "ready") {
        this.loadingModelId = null;
        this.loadedModelId = m.modelId;
        this.ready = true;
        this.callbacks.onReady?.(m.modelId, m.warmupMs);
      } else if (m.type === "detected") {
        this.callbacks.onDetected({
          score: m.score,
          atFrame: m.atFrame,
          rest: new Uint8Array(m.restBytes as ArrayBuffer),
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

  /** Loads (or switches to) the named model; resolves immediately when already loaded. */
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
    this.ready = false;
    this.loadingModelId = modelId;
    worker.postMessage({
      type: "load",
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
    const copy = new Int16Array(samples.length);
    copy.set(samples);
    this.worker.postMessage({ type: "feed", pcm: copy.buffer }, [copy.buffer]);
  }

  reset(): void {
    this.worker?.postMessage({ type: "reset" });
  }

  dispose(): void {
    this.ready = false;
    this.loadedModelId = null;
    this.loadingModelId = null;
    if (this.worker) {
      this.worker.postMessage({ type: "dispose" });
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
