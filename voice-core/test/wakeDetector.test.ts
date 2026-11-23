// Tests for the TypeScript WakeDetector (noise-floor gate, refractory window, trailing audio)
// and OnnxWakeModel on ONNX Runtime Web (WASM) verified against Android's reference_scores.json.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { OnnxWakeModel } from "../web/onnxWakeModel.ts";
import { DEFAULT_WAKE_LIMITS, WAKE_FRAME, WakeDetector, dbfs, type WakeModel } from "../web/wakeDetector.ts";

class FakeModel implements WakeModel {
  steps = 0;
  resets = 0;
  heard: Float32Array[] = [];
  private readonly scoreOf: (frame: Float32Array) => number;
  constructor(scoreOf: (frame: Float32Array) => number = () => 0) {
    this.scoreOf = scoreOf;
  }
  step(frame: Float32Array): number {
    this.steps++;
    this.heard.push(frame);
    return this.scoreOf(frame);
  }
  reset(): void {
    this.resets++;
  }
}

/** Deterministic Box-Muller Gaussian noise at ~ -64 dBFS (matches WakeDetectorTest.kt). */
function noise(seconds: number, sigma = 20.0, seed = 1): Int16Array {
  let s = seed >>> 0;
  const rand = () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return (s + 1) / 4294967297;
  };
  const out = new Int16Array(Math.floor(seconds * 16_000));
  for (let i = 0; i < out.length; i += 2) {
    const u1 = rand();
    const u2 = rand();
    const mag = Math.sqrt(-2 * Math.log(u1)) * sigma;
    out[i] = Math.max(-32768, Math.min(32767, Math.trunc(mag * Math.cos(2 * Math.PI * u2))));
    if (i + 1 < out.length) {
      out[i + 1] = Math.max(-32768, Math.min(32767, Math.trunc(mag * Math.sin(2 * Math.PI * u2))));
    }
  }
  return out;
}

function silence(seconds: number): Int16Array {
  return new Int16Array(Math.floor(seconds * 16_000));
}

function tone(seconds: number, amplitude = 3000.0, hz = 440): Int16Array {
  const out = new Int16Array(Math.floor(seconds * 16_000));
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / 16_000) * amplitude);
  }
  return out;
}

function wav(path: string): Int16Array {
  const buf = readFileSync(path);
  const data = buf.subarray(44);
  const out = new Int16Array(Math.floor(data.byteLength / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = data.readInt16LE(i * 2);
  }
  return out;
}

test("a quiet room runs no inference", async () => {
  const model = new FakeModel();
  const d = new WakeDetector(model);
  await d.feed(noise(30.0));
  await d.feed(silence(10.0));
  assert.equal(model.steps, 0);
  assert.equal(d.frames, 500);
  assert.equal(d.scored, 0);
});

test("sound opens the gate with the pre-roll before it", async () => {
  const model = new FakeModel();
  const d = new WakeDetector(model);
  await d.feed(noise(5.0));
  const speech = tone(0.8, 3000.0);
  await d.feed(speech);
  assert.equal(model.resets, 1);
  assert.ok(model.steps >= DEFAULT_WAKE_LIMITS.preRollFrames + Math.floor(speech.length / WAKE_FRAME));
  assert.ok(dbfs(model.heard[0]) < -55);
});

test("the gate closes after the hangover", async () => {
  const model = new FakeModel();
  const d = new WakeDetector(model);
  await d.feed(noise(5.0));
  await d.feed(tone(1.0, 3000.0));
  const during = model.steps;
  await d.feed(noise(10.0, 20.0, 2));
  const after = model.steps - during;
  assert.ok(after >= 20 && after <= 30, `scored ${after} frames after the sound`);
  assert.equal(d.gateOpen, false);
});

test("steady noise stops opening the gate", async () => {
  const model = new FakeModel();
  const d = new WakeDetector(model);
  await d.feed(noise(20.0, 600.0, 1));
  const first = model.steps;
  await d.feed(noise(20.0, 600.0, 3));
  assert.ok(model.steps - first < 100, `steady noise scored ${model.steps - first} of 250 frames`);
});

test("a detection resets and stays quiet for the refractory window", async () => {
  const model = new FakeModel(() => 0.9);
  const d = new WakeDetector(model);
  await d.feed(noise(3.0));
  let detections = 0;
  const loud = tone(4.0, 3000.0);
  for (let i = 0; i < loud.length; i += WAKE_FRAME) {
    if (await d.feed(loud.subarray(i, Math.min(i + WAKE_FRAME, loud.length)))) detections++;
  }
  assert.equal(detections, 2);
});

test("audio after a detection is left unheard via rest index", async () => {
  const model = new FakeModel((f) => (dbfs(f) > -40 ? 0.9 : 0));
  const d = new WakeDetector(model);
  await d.feed(noise(2.4)); // 30 whole frames
  const read = tone(0.32, 3000.0); // 4 frames
  const hit = await d.feed(read);
  assert.ok(hit != null);
  assert.equal(hit.rest, WAKE_FRAME);
  assert.equal(d.frames - 1 - hit.atFrame, 0);
});

test("partial chunks accumulate across calls", async () => {
  const model = new FakeModel();
  const d = new WakeDetector(model);
  const pcm = noise(1.0);
  for (let i = 0; i < pcm.length; i += 333) {
    await d.feed(pcm.subarray(i, Math.min(pcm.length, i + 333)));
  }
  assert.equal(d.frames, 12);
});

test("dynamic threshold callback updates live", async () => {
  let thresh = 0.9;
  const model = new FakeModel(() => 0.75);
  const d = new WakeDetector(model, {}, () => thresh);
  await d.feed(noise(3.0));
  assert.equal(await d.feed(tone(0.24, 3000.0)), null);
  thresh = 0.6;
  const hit = await d.feed(tone(0.24, 3000.0));
  assert.ok(hit != null && hit.score === 0.75);
});

const modelPath = fileURLToPath(new URL("../../android/app/src/main/assets/wakeword/pennyworth.onnx", import.meta.url));
const wakeFixturesDir = fileURLToPath(new URL("../../android/core/src/test/resources/wake", import.meta.url));
const ortDistUrl = new URL("../node_modules/onnxruntime-web/dist/", import.meta.url).href;

test("OnnxWakeModel matches reference scores and WakeDetector detects Pennyworth only", { skip: !existsSync(modelPath) }, async () => {
  const reference = JSON.parse(readFileSync(`${wakeFixturesDir}/reference_scores.json`, "utf8")) as Record<string, number[]>;
  const model = await OnnxWakeModel.load(readFileSync(modelPath), ortDistUrl);
  try {
    // 1. Exact streaming score parity against the Python reference.
    for (const [name, want] of Object.entries(reference)) {
      model.reset();
      const pcm = wav(`${wakeFixturesDir}/${name}.wav`);
      const scores: number[] = [];
      for (let f = 0; f < Math.floor(pcm.length / WAKE_FRAME); f++) {
        const frame = new Float32Array(WAKE_FRAME);
        for (let k = 0; k < WAKE_FRAME; k++) frame[k] = pcm[f * WAKE_FRAME + k] / 32768;
        scores.push(await model.step(frame));
      }
      assert.equal(scores.length, want.length, name);
      const worst = Math.max(...scores.map((s, i) => Math.abs(s - want[i])));
      assert.ok(worst < 1e-3, `${name}: largest difference ${worst}`);
    }

    // 2. End-to-end gated WakeDetector: Pennyworth fires, Woodhouse & negative do not.
    for (const name of Object.keys(reference)) {
      const d = new WakeDetector(model);
      await d.feed(noise(4.0));
      const hit = await d.feed(wav(`${wakeFixturesDir}/${name}.wav`));
      if (name.startsWith("pennyworth")) {
        assert.ok(hit != null, `expected detection for ${name}`);
        assert.ok(hit.score > DEFAULT_WAKE_LIMITS.threshold, `${name} score ${hit.score}`);
      } else {
        assert.equal(hit, null, `unexpected detection for ${name}`);
      }
      assert.ok(d.scored < d.frames, `${name}: gate should skip quiet room frames`);
    }
  } finally {
    await model.close();
  }
});
