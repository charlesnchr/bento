// Tests for WakeClient generation filtering and sequence-ordered trailing audio capture,
// plus CallAudio cancellation/superseding during pending getUserMedia.

import assert from "node:assert/strict";
import { test } from "node:test";
import { CallAudio } from "../web/audio.ts";
import { ScreenWakeLock, WakeClient, type WakeDetectionEvent, type WakeLockSentinelLike, type WorkerLike } from "../web/wakeClient.ts";

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

test("WakeClient preserves restBytes plus per-frame suppressed flags across playback boundaries", () => {
  const worker = new MockWorker();
  const hits: WakeDetectionEvent[] = [];
  const client = new WakeClient({ onDetected: (hit) => hits.push(hit) }, () => worker);

  client.load("pennyworth", 0.7);
  const gen = worker.sent.at(-1)!.gen as number;
  worker.emit({ type: "ready", gen, modelId: "pennyworth", warmupMs: 50 });

  const c1 = new Int16Array([1, 2, 3, 4]);
  const c2 = new Int16Array([5, 6, 7, 8]);
  const c3 = new Int16Array([9, 10, 11, 12]);
  // c1 and c2 were suppressed during playback; c3 arrived after playback ended (not suppressed).
  client.feed(c1, true);
  const seq1 = worker.sent.at(-1)!.seq as number;
  client.feed(c2, true);
  client.feed(c3, false);

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
  assert.deepEqual(
    hits[0].trailing.map((t) => ({
      seq: t.seq,
      samples: [...new Int16Array(t.bytes.buffer, t.bytes.byteOffset, t.bytes.byteLength / 2)],
      suppressed: t.suppressed,
    })),
    [
      { seq: seq1, samples: [3, 4], suppressed: true },
      { seq: seq1 + 1, samples: [5, 6, 7, 8], suppressed: true },
      { seq: seq1 + 2, samples: [9, 10, 11, 12], suppressed: false },
    ],
  );
  assert.equal(client.suppressedInFlight, false);
});

test("WakeClient tracks suppressedInFlight via worker acks and fires onSuppressedSettled", () => {
  const worker = new MockWorker();
  let settled = 0;
  const client = new WakeClient(
    {
      onDetected: () => {},
      onSuppressedSettled: () => { settled++; },
    },
    () => worker,
  );

  client.load("pennyworth", 0.7);
  const gen = worker.sent.at(-1)!.gen as number;
  worker.emit({ type: "ready", gen, modelId: "pennyworth", warmupMs: 50 });

  assert.equal(client.suppressedInFlight, false);
  const seq1 = client.feed(new Int16Array([1, 2]), true);
  assert.equal(worker.sent.at(-1)!.ack, true);
  assert.equal(client.suppressedInFlight, true);

  const seq2 = client.feed(new Int16Array([3, 4]), false);
  assert.equal(worker.sent.at(-1)!.ack, false);
  assert.equal(seq2, seq1 + 1);
  assert.equal(client.suppressedInFlight, true);

  // Worker clears seq1 without detecting: suppressedInFlight becomes false and triggers flush callback.
  worker.emit({ type: "ack", gen, seq: seq1 });
  assert.equal(client.suppressedInFlight, false);
  assert.equal(settled, 1);
});

test("ScreenWakeLock clears sentinel on browser release and reacquires on visibility return", async () => {
  let requests = 0;
  let hidden = false;
  const listeners: Array<() => void> = [];
  const sentinels: Array<{ released: boolean; releaseCalls: number }> = [];

  const lock = new ScreenWakeLock(async () => {
    requests++;
    const state = { released: false, releaseCalls: 0 };
    sentinels.push(state);
    const sentinel: WakeLockSentinelLike = {
      get released() { return state.released; },
      async release() { state.released = true; state.releaseCalls++; },
      addEventListener(type, fn) { if (type === "release") listeners.push(fn); },
    };
    return sentinel;
  });

  await lock.acquire(() => !hidden);
  assert.equal(requests, 1);
  assert.equal(lock.held, true);

  // Browser hides tab and releases sentinel.
  hidden = true;
  sentinels[0].released = true;
  listeners.shift()!();
  assert.equal(lock.held, false);

  // Tab becomes visible again: acquire() must request a new sentinel.
  hidden = false;
  await lock.acquire(() => !hidden);
  assert.equal(requests, 2);
  assert.equal(lock.held, true);

  lock.release();
  assert.equal(sentinels[1].releaseCalls, 1);
  assert.equal(lock.held, false);
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

test("CallAudio shares open() initialization and stops tracks if capture setup throws", async () => {
  const g = globalThis as Record<string, any>;
  const prevAudioContext = g.AudioContext;
  const prevWorkletNode = g.AudioWorkletNode;
  const prevNavigator = g.navigator;
  const prevCreateObjectURL = URL.createObjectURL;

  let resolveModule!: () => void;
  let addModuleCalls = 0;
  let throwCapture = false;
  const makeTrack = () => ({ readyState: "live", stopped: false, stop() { this.stopped = true; this.readyState = "ended"; } });

  g.AudioContext = class {
    state = "running";
    baseLatency = 0;
    destination = {};
    onstatechange: (() => void) | null = null;
    audioWorklet = {
      addModule: () => {
        addModuleCalls++;
        return new Promise<void>((r) => { resolveModule = r; });
      },
    };
    resume = async () => { this.state = "running"; };
    close = async () => {};
    createMediaStreamSource = () => ({ connect() {}, disconnect() {} });
  };
  g.AudioWorkletNode = class {
    port = { onmessage: null as any, postMessage() {}, close() {} };
    constructor(_ctx: unknown, name: string) {
      if (name === "capture" && throwCapture) throw new Error("capture worklet failed");
    }
    connect() {}
  };
  URL.createObjectURL = () => "blob:mock";
  const tracks: ReturnType<typeof makeTrack>[] = [];
  Object.defineProperty(g, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => {
          const t = makeTrack();
          tracks.push(t);
          return { getTracks: () => [t] };
        },
      },
    },
  });

  try {
    const audio = new CallAudio();
    const opts = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

    // Two overlapping open()/startMic() calls share a single AudioWorklet registration.
    const o1 = audio.open();
    const o2 = audio.open();
    resolveModule();
    await Promise.all([o1, o2]);
    assert.equal(addModuleCalls, 1, "concurrent open() must share one AudioWorklet initialization");

    // If AudioWorkletNode('capture') throws after getUserMedia, the acquired track is stopped.
    throwCapture = true;
    await assert.rejects(() => audio.startMic(() => {}, opts), /capture worklet failed/);
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0].stopped, true, "track must be stopped when capture setup fails");
    assert.equal(audio.micActive, false);
  } finally {
    g.AudioContext = prevAudioContext;
    g.AudioWorkletNode = prevWorkletNode;
    Object.defineProperty(g, "navigator", { configurable: true, value: prevNavigator });
    URL.createObjectURL = prevCreateObjectURL;
  }
});

test("CallAudio retries open() cleanly after an AudioContext constructor failure", async () => {
  const g = globalThis as Record<string, any>;
  const prevAudioContext = g.AudioContext;
  const prevWorkletNode = g.AudioWorkletNode;
  const prevCreateObjectURL = URL.createObjectURL;

  let attempts = 0;
  g.AudioContext = class {
    state = "running";
    baseLatency = 0;
    destination = {};
    onstatechange: (() => void) | null = null;
    audioWorklet = { addModule: async () => {} };
    resume = async () => { this.state = "running"; };
    close = async () => {};
    constructor() {
      attempts++;
      if (attempts === 1) throw new Error("AudioContext blocked");
    }
  };
  g.AudioWorkletNode = class {
    port = { onmessage: null as any, postMessage() {}, close() {} };
    connect() {}
  };
  URL.createObjectURL = () => "blob:mock";

  try {
    const audio = new CallAudio();
    await assert.rejects(() => audio.open(), /AudioContext blocked/);
    await audio.open();
    assert.equal(attempts, 2, "second open() must construct a fresh AudioContext");
  } finally {
    g.AudioContext = prevAudioContext;
    g.AudioWorkletNode = prevWorkletNode;
    URL.createObjectURL = prevCreateObjectURL;
  }
});
