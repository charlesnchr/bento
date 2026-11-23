// LiveKit WakeWord v2 streaming model on ONNX Runtime Web (WASM, single-threaded).
// Mirrors Android's OnnxWakeModel.kt: input `chunk` (1, 1280) and its streaming state tensors,
// outputs `score` and `<name>_out`, warmed up on 2 s (25 frames) of silence.

import * as ort from "onnxruntime-web/wasm";
import { WAKE_FRAME, type WakeModel } from "./wakeDetector.ts";

/** 2 s of silence: the state every stream starts from, as in training. */
export const WARMUP_STEPS = 25;

interface TensorMeta {
  name: string;
  type: "float32" | "int64" | "int32" | "float64";
  shape: number[];
}

type StateBuffer = Float32Array | BigInt64Array | Int32Array | Float64Array;

function makeBuffer(type: TensorMeta["type"], size: number): StateBuffer {
  switch (type) {
    case "int64": return new BigInt64Array(size);
    case "int32": return new Int32Array(size);
    case "float64": return new Float64Array(size);
    default: return new Float32Array(size);
  }
}

export class OnnxWakeModel implements WakeModel {
  private readonly session: ort.InferenceSession;
  private readonly stateMeta: TensorMeta[];
  private readonly warm = new Map<string, StateBuffer>();
  private states = new Map<string, ort.Tensor>();
  private closed = false;

  private constructor(session: ort.InferenceSession, stateMeta: TensorMeta[]) {
    this.session = session;
    this.stateMeta = stateMeta;
  }

  /**
   * Loads a LiveKit WakeWord v2 `.onnx` buffer on single-threaded WASM and warms it up on 2 s of
   * silence. `wasmPaths` points to the directory serving `ort-wasm-simd-threaded.{mjs,wasm}`.
   */
  static async load(modelBytes: ArrayBuffer | Uint8Array, wasmPaths = "/ort/"): Promise<OnnxWakeModel> {
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = wasmPaths;
    const bytes = modelBytes instanceof Uint8Array ? modelBytes : new Uint8Array(modelBytes);
    const session = await ort.InferenceSession.create(bytes, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });

    if (!session.inputNames.includes("chunk")) {
      await session.release();
      throw new Error("not a streaming wake word model (no chunk input)");
    }
    if (!session.outputNames.includes("score")) {
      await session.release();
      throw new Error("not a streaming wake word model (no score output)");
    }

    const metaList = (session.inputMetadata ?? []) as unknown as Array<{
      name: string;
      isTensor?: boolean;
      type?: string;
      shape?: number[];
    }>;
    const stateMeta: TensorMeta[] = [];
    for (const name of session.inputNames) {
      if (name === "chunk") continue;
      if (!session.outputNames.includes(`${name}_out`)) {
        await session.release();
        throw new Error(`wake word model missing ${name}_out output`);
      }
      const m = metaList.find((x) => x.name === name);
      if (!m || !Array.isArray(m.shape)) {
        await session.release();
        throw new Error(`wake word model missing tensor metadata for ${name}`);
      }
      const shape = m.shape.map((d) => (typeof d === "number" && d > 0 ? d : 1));
      const type = (m.type === "int64" || m.type === "int32" || m.type === "float64") ? m.type : "float32";
      stateMeta.push({ name, type, shape });
    }

    const model = new OnnxWakeModel(session, stateMeta);
    model.initZeroStates();
    const silence = new Float32Array(WAKE_FRAME);
    for (let i = 0; i < WARMUP_STEPS; i++) {
      await model.step(silence);
    }
    for (const m of stateMeta) {
      const t = model.states.get(m.name)!;
      model.warm.set(m.name, (t.data as StateBuffer).slice());
    }
    return model;
  }

  private initZeroStates(): void {
    this.disposeStates();
    for (const m of this.stateMeta) {
      const size = m.shape.reduce((a, b) => a * b, 1);
      const data = makeBuffer(m.type, size);
      this.states.set(m.name, new ort.Tensor(m.type, data, m.shape));
    }
  }

  private disposeStates(): void {
    for (const t of this.states.values()) {
      try { t.dispose(); } catch {}
    }
    this.states.clear();
  }

  async step(frame: Float32Array): Promise<number> {
    if (this.closed) throw new Error("wake word model is closed");
    if (frame.length !== WAKE_FRAME) throw new Error(`expected ${WAKE_FRAME} samples, got ${frame.length}`);
    const chunk = new ort.Tensor("float32", frame, [1, WAKE_FRAME]);
    const feeds: Record<string, ort.Tensor> = { chunk };
    for (const [name, tensor] of this.states) feeds[name] = tensor;
    let outputs: ort.InferenceSession.OnnxValueMapType;
    try {
      outputs = await this.session.run(feeds);
    } finally {
      try { chunk.dispose(); } catch {}
    }
    const scoreTensor = outputs.score;
    const score = Number((scoreTensor.data as Float32Array)[0] ?? 0);
    try { scoreTensor.dispose(); } catch {}

    const prev = this.states;
    const next = new Map<string, ort.Tensor>();
    for (const m of this.stateMeta) {
      const out = outputs[`${m.name}_out`];
      next.set(m.name, out);
    }
    this.states = next;
    for (const t of prev.values()) {
      try { t.dispose(); } catch {}
    }
    return score;
  }

  reset(): void {
    if (this.closed) return;
    this.disposeStates();
    for (const m of this.stateMeta) {
      const saved = this.warm.get(m.name);
      if (saved) {
        this.states.set(m.name, new ort.Tensor(m.type, saved.slice(), m.shape));
      } else {
        const size = m.shape.reduce((a, b) => a * b, 1);
        this.states.set(m.name, new ort.Tensor(m.type, makeBuffer(m.type, size), m.shape));
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.disposeStates();
    await this.session.release();
  }
}
