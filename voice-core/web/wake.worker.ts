// Dedicated Web Worker for local wake word detection.
// Runs ONNX Runtime Web (WASM) off the main thread so inference never stalls audio or UI.

import { OnnxWakeModel } from "./onnxWakeModel.ts";
import { WakeDetector } from "./wakeDetector.ts";

type InMessage =
  | { type: "load"; url: string; modelId: string; threshold: number; wasmPaths?: string }
  | { type: "config"; threshold: number }
  | { type: "feed"; pcm: ArrayBuffer }
  | { type: "reset" }
  | { type: "dispose" };

let model: OnnxWakeModel | null = null;
let detector: WakeDetector | null = null;
let threshold = 0.7;
let loadedUrl = "";
let queue: Promise<void> = Promise.resolve();
let loadGeneration = 0;
let lastTelemetryAt = 0;
let lastGateOpen = false;
let lastInferMs = 0;

function post(msg: Record<string, unknown>, transfer: Transferable[] = []): void {
  (self as unknown as { postMessage(m: unknown, t?: Transferable[]): void }).postMessage(msg, transfer);
}

function enqueue(fn: () => Promise<void>): void {
  queue = queue.then(fn, fn);
}

self.onmessage = (event: MessageEvent<InMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case "config":
      threshold = msg.threshold;
      break;
    case "reset":
      enqueue(async () => {
        detector?.reset();
        lastGateOpen = false;
      });
      break;
    case "dispose":
      loadGeneration++;
      enqueue(async () => {
        detector = null;
        loadedUrl = "";
        if (model) {
          const old = model;
          model = null;
          await old.close();
        }
      });
      break;
    case "load": {
      const gen = ++loadGeneration;
      threshold = msg.threshold;
      enqueue(async () => {
        if (gen !== loadGeneration) return;
        if (model && loadedUrl === msg.url) {
          detector?.reset();
          post({ type: "ready", modelId: msg.modelId, warmupMs: 0 });
          return;
        }
        try {
          const t0 = performance.now();
          const res = await fetch(msg.url);
          if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${msg.url}`);
          const buf = await res.arrayBuffer();
          if (gen !== loadGeneration) return;
          const next = await OnnxWakeModel.load(buf, msg.wasmPaths ?? "/ort/");
          if (gen !== loadGeneration) {
            await next.close();
            return;
          }
          if (model) await model.close();
          model = next;
          loadedUrl = msg.url;
          detector = new WakeDetector(model, { threshold }, () => threshold);
          lastGateOpen = false;
          post({ type: "ready", modelId: msg.modelId, warmupMs: Math.round(performance.now() - t0) });
        } catch (err) {
          if (gen !== loadGeneration) return;
          post({ type: "error", message: err instanceof Error ? err.message : String(err) });
        }
      });
      break;
    }
    case "feed":
      enqueue(async () => {
        if (!detector) return;
        const pcm = new Int16Array(msg.pcm);
        const scoredBefore = detector.scored;
        const t0 = performance.now();
        try {
          const hit = await detector.feed(pcm);
          const scoredNow = detector.scored - scoredBefore;
          if (scoredNow > 0) lastInferMs = (performance.now() - t0) / scoredNow;
          if (hit) {
            const tail = pcm.subarray(hit.rest);
            const restCopy = new Int16Array(tail.length);
            restCopy.set(tail);
            post(
              {
                type: "detected",
                score: hit.score,
                atFrame: hit.atFrame,
                restBytes: restCopy.buffer,
                inferMs: Number(lastInferMs.toFixed(2)),
              },
              [restCopy.buffer],
            );
            lastGateOpen = detector.gateOpen;
            return;
          }
          const now = performance.now();
          if (detector.gateOpen !== lastGateOpen || (detector.gateOpen && now - lastTelemetryAt >= 200)) {
            lastTelemetryAt = now;
            lastGateOpen = detector.gateOpen;
            post({
              type: "telemetry",
              score: detector.lastScore,
              peak: detector.takePeak(),
              gateOpen: detector.gateOpen,
              frames: detector.frames,
              scored: detector.scored,
              inferMs: Number(lastInferMs.toFixed(2)),
            });
          }
        } catch (err) {
          post({ type: "error", message: err instanceof Error ? err.message : String(err) });
        }
      });
      break;
  }
};
