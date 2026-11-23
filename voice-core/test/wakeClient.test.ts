// Tests for WakeClient generation filtering and sequence-ordered trailing audio capture,
// plus CallAudio cancellation/superseding during pending getUserMedia.

import assert from "node:assert/strict";
import { test } from "node:test";
import { CallAudio } from "../web/audio.ts";
import { WakeClient, type WakeDetectionEvent, type WorkerLike } from "../web/wakeClient.ts";

class MockWorker implements WorkerLike {
  onmessage: ((e: MessageEvent<Record<string, any>>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  sent: Record<string, any>[] = [];
  terminated = false;

  postMessage(message: unknown): void {
    this.sent.push(message as Record<string, any>);
  }
  emit(data: Record<string, any>): void {
    this.onmessage?.({ data } as MessageEvent<Record<string, any>>);
  }
  terminate(): void {
    this.terminated = true;
  }
}

test("WakeClient ignores stale ready, detected, and error events from earlier generations", () => {
  const worker = new MockWorker();
  const readyIds: string[] = [];
  const hits: WakeDetectionEvent[] = [];
  const errors: string[] = [];
  const client = new WakeClient(
    {
      onReady: (id) => readyIds.push(id),
      onDetected: (hit) => hits.push(hit),
      onError: (msg) => errors.push(msg),
    },
    () => worker,
  );

  client.load("pennyworth", 0.7);
  const gen1 = worker.sent.at(-1)!.gen as number;
  // Switch model before first load finishes: gen increments.
  client.load("woodhouse", 0.7);
  const gen2 = worker.sent.at(-1)!.gen as number;
  assert.notEqual(gen1, gen2);

  // Stale ready/error/detected from gen1 must be dropped.
  worker.emit({ type: "ready", gen: gen1, modelId: "pennyworth", warmupMs: 100 });
  worker.emit({ type: "error", gen: gen1, message: "old failure" });
  worker.emit({ type: "detected", gen: gen1, seq: 1, score: 0.95, atFrame: 5, restBytes: new ArrayBuffer(0), inferMs: 2 });
  assert.equal(client.ready, false);
  assert.deepEqual(readyIds, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(hits, []);

  // Matching gen2 ready activates the client.
  worker.emit({ type: "ready", gen: gen2, modelId: "woodhouse", warmupMs: 120 });
  assert.equal(client.ready, true);
  assert.deepEqual(readyIds, ["woodhouse"]);

  // Reset increments generation: a late detection from gen2 must be dropped.
  client.reset();
  const gen3 = worker.sent.at(-1)!.gen as number;
  assert.notEqual(gen2, gen3);
  worker.emit({ type: "detected", gen: gen2, seq: 2, score: 0.91, atFrame: 9, restBytes: new ArrayBuffer(0), inferMs: 2 });
  assert.deepEqual(hits, []);
});

test("WakeClient preserves restBytes plus all chunks sent after the triggering seq", () => {
  const worker = new MockWorker();
  const hits: WakeDetectionEvent[] = [];
  const client = new WakeClient({ onDetected: (hit) => hits.push(hit) }, () => worker);

  client.load("pennyworth", 0.7);
  const gen = worker.sent.at(-1)!.gen as number;
  worker.emit({ type: "ready", gen, modelId: "pennyworth", warmupMs: 50 });

  const c1 = new Int16Array([1, 2, 3, 4]);
  const c2 = new Int16Array([5, 6, 7, 8]);
  const c3 = new Int16Array([9, 10, 11, 12]);
  client.feed(c1);
  const seq1 = worker.sent.at(-1)!.seq as number;
  client.feed(c2);
  client.feed(c3);

  // Worker detects on seq1 with tail [3, 4] while c2 and c3 were already posted.
  const rest = new Int16Array([3, 4]);
  worker.emit({
    type: "detected",
    gen,
    seq: seq1,
    score: 0.93,
    atFrame: 10,
    restBytes: rest.buffer,
    inferMs: 1.8,
  });

  assert.equal(hits.length, 1);
  const combined = new Int16Array(
    hits[0].trailing.reduce((sum, b) => sum + b.byteLength, 0) / 2,
  );
  let off = 0;
  for (const b of hits[0].trailing) {
    const view = new Int16Array(b.buffer, b.byteOffset, b.byteLength / 2);
    combined.set(view, off);
    off += view.length;
  }
  assert.deepEqual([...combined], [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test("CallAudio stops tracks if stopMic or an overlapping startMic supersedes a pending getUserMedia", async () => {
  const g = globalThis as Record<string, any>;
  const prevAudioContext = g.AudioContext;
  const prevWorkletNode = g.AudioWorkletNode;
  const prevNavigator = g.navigator;
  const prevCreateObjectURL = URL.createObjectURL;

  const resolvers: Array<(stream: any) => void> = [];
  const makeTrack = () => ({ readyState: "live", stopped: false, stop() { this.stopped = true; this.readyState = "ended"; } });

  g.AudioContext = class {
    state = "running";
    baseLatency = 0;
    destination = {};
    onstatechange: (() => void) | null = null;
    audioWorklet = { addModule: async () => {} };
    resume = async () => { this.state = "running"; };
    createMediaStreamSource = () => ({ connect() {}, disconnect() {} });
  };
  g.AudioWorkletNode = class {
    port = { onmessage: null as any, postMessage() {}, close() {} };
    connect() {}
  };
  URL.createObjectURL = () => "blob:mock";
  Object.defineProperty(g, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: () => new Promise((resolve) => resolvers.push(resolve)),
      },
    },
  });

  try {
    const audio = new CallAudio();
    const opts = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

    // Case 1: stopMic called while getUserMedia is pending.
    const p1 = audio.startMic(() => {}, opts);
    await new Promise((r) => setTimeout(r, 0));
    audio.stopMic();
    const track1 = makeTrack();
    resolvers.shift()!({ getTracks: () => [track1] });
    await p1;
    assert.equal(track1.stopped, true, "cancelled stream track must be stopped immediately");
    assert.equal(audio.micActive, false);

    // Case 2: overlapping startMic supersedes an earlier pending startMic.
    const p2 = audio.startMic(() => {}, opts);
    await new Promise((r) => setTimeout(r, 0));
    const p3 = audio.startMic(() => {}, opts);
    await new Promise((r) => setTimeout(r, 0));
    const track2 = makeTrack();
    const track3 = makeTrack();
    resolvers.shift()!({ getTracks: () => [track2] });
    resolvers.shift()!({ getTracks: () => [track3] });
    await Promise.all([p2, p3]);
    assert.equal(track2.stopped, true, "superseded stream track must be stopped");
    assert.equal(track3.stopped, false, "winning stream track must stay live");
    assert.equal(audio.micActive, true);
    audio.stopMic();
    assert.equal(track3.stopped, true);
  } finally {
    g.AudioContext = prevAudioContext;
    g.AudioWorkletNode = prevWorkletNode;
    Object.defineProperty(g, "navigator", { configurable: true, value: prevNavigator });
    URL.createObjectURL = prevCreateObjectURL;
  }
});
