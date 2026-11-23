// Tests for WakeClient generation filtering and sequence-ordered trailing audio capture,
// plus CallAudio cancellation/superseding during pending getUserMedia.

import assert from "node:assert/strict";
import { test } from "node:test";
import { Call } from "../src/call.ts";
import { configFrom } from "../src/index.ts";
import type { CallConfig, Command, Event } from "../src/types.ts";
import { CallAudio, bytesToBase64 } from "../web/audio.ts";
import { ScreenWakeLock, WakeAudioGate, WakeClient, type WakeDetectionEvent, type WakeLockSentinelLike, type WorkerLike } from "../web/wakeClient.ts";

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

/** Helper mirroring web/app.ts's Call + WakeClient + WakeAudioGate integration against the real Call core. */
function createCoreHarness(configOverrides: Record<string, unknown> = {}) {
  const worker = new MockWorker();
  const gate = new WakeAudioGate();
  let t = 0;
  let sid = 0;
  let coreWantsWake = false;
  let wakePeriodActive = false;
  const commands: Command[] = [];
  const sentAudioTags: number[] = [];

  const config = configFrom({
    today: "2026-11-08",
    mic: { whileSpeaking: "wake" },
    limits: { settleQuiet: 0.1, settleMax: 1.5, tick: 0.05, wakePreRoll: 1.0 },
    ...configOverrides,
  } as Partial<CallConfig> & Record<string, unknown>);
  const call = new Call(config);
  gate.reset(config.mic.whileSpeaking, 0, {
    deliverMax: config.limits.deliverMax,
    briefWait: config.announce.briefWait,
    muted: config.muted,
  });

  const client = new WakeClient(
    {
      onDetected(hit) {
        if (!wakePeriodActive) return;
        const deferred = gate.takeDeferred();
        push({ type: "wake" });
        for (const item of gate.planWakeReplay(hit, deferred, bytesToBase64)) {
          push({ type: "mic", pcm: item.pcm }, item.t ?? t);
        }
      },
      onSuppressedSettled() {
        for (const item of gate.flushDeferred()) {
          push({ type: "mic", pcm: item.pcm }, item.t);
        }
      },
    },
    () => worker,
  );
  client.load("pennyworth", 0.7);
  const gen = () => worker.sent.at(-1)!.gen as number;
  worker.emit({ type: "ready", gen: gen(), modelId: "pennyworth", warmupMs: 10 });

  function run(out: Command[], eventTime: number, eventType?: string) {
    gate.observeCommands(out, eventTime, eventType);
    for (const c of out) {
      commands.push(c);
      if (c.type === "ws.connect" && c.purpose !== "captions") {
        sid = c.sid;
        push({ type: "ws.open", sid });
        push({ type: "ws.message", sid, data: JSON.stringify({ setupComplete: {} }) });
      } else if (c.type === "ws.send" && c.data.startsWith('{"realtimeInput":{"audio"')) {
        const parsed = JSON.parse(c.data);
        const raw = Buffer.from(parsed.realtimeInput.audio.data, "base64");
        const firstSample = raw.length >= 2 ? raw.readInt16LE(0) : 0;
        sentAudioTags.push(firstSample);
      } else if (c.type === "wakeword") {
        coreWantsWake = c.on;
        if (c.on) {
          const preserveInFlight = wakePeriodActive && client.suppressedInFlight;
          wakePeriodActive = true;
          if (!preserveInFlight) client.reset();
        }
      }
    }
  }

  function push(event: Record<string, unknown>, at = t): Command[] {
    for (const item of gate.beforePush(event, at)) {
      push({ type: "mic", pcm: item.pcm }, item.t);
    }
    const out = call.push({ ...event, t: at } as Event);
    run(out, at, typeof event.type === "string" ? event.type : undefined);
    return out;
  }

  function start() {
    run(call.start(0), 0);
  }

  function advanceTo(nextT: number) {
    t = nextT;
    push({ type: "tick" }, t);
  }

  function micFrame(tag: number, at = t): number {
    t = at;
    const samples = new Int16Array(320).fill(tag);
    const suppressed = gate.isSuppressed(t);
    const seq = coreWantsWake ? client.feed(samples, suppressed) : 0;
    const pcm = bytesToBase64(new Uint8Array(samples.buffer));
    for (const item of gate.onMicFrame({
      pcm,
      t,
      seq,
      lastSeq: client.lastSeq,
      inFlightSuppressedSeq: client.inFlightSuppressedSeq,
      suppressed,
    })) {
      push({ type: "mic", pcm: item.pcm }, item.t);
    }
    return seq;
  }

  function modelAudio(seconds: number, at = t) {
    t = at;
    const pcm = Buffer.alloc(Math.round(seconds * 24_000) * 2, 1).toString("base64");
    const data = JSON.stringify({
      serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm } }] } },
    });
    return push({ type: "ws.message", sid, data }, t);
  }

  function emitDetected(seq: number, restTag?: number) {
    const feedMsg = worker.sent.find((m) => m.type === "feed" && m.seq === seq);
    assert.ok(feedMsg, `expected feed message for seq ${seq}`);
    const rest = restTag != null ? new Int16Array(320).fill(restTag).buffer : new ArrayBuffer(0);
    worker.emit({ type: "detected", gen: feedMsg.gen, seq, score: 0.95, atFrame: 4, restBytes: rest, inferMs: 2 });
  }

  function emitAck(seq: number) {
    const feedMsg = worker.sent.find((m) => m.type === "feed" && m.seq === seq);
    assert.ok(feedMsg, `expected feed message for seq ${seq}`);
    worker.emit({ type: "ack", gen: feedMsg.gen, seq });
  }

  return { worker, gate, client, call, commands, sentAudioTags, start, push, advanceTo, micFrame, modelAudio, emitDetected, emitAck, getSid: () => sid, setT: (v: number) => { t = v; } };
}

test("WakeAudioGate: resuming playback during a gap keeps wake interruption working without reversing audio", () => {
  const h = createCoreHarness({
    attention: { mode: "window", afterWake: 1.0, window: 1.0, afterQuestion: 2.0, afterHandOff: 0, afterAnnouncement: 0 },
  });
  h.start();
  // Let the initial attention window expire so the call goes dormant.
  for (let step = 0.2; step <= 1.4; step += 0.2) h.advanceTo(step);
  assert.ok(h.commands.some((c) => c.type === "status" && c.status === "dormant"));
  h.sentAudioTags.length = 0;

  // Model speaks for 0.2 s (from t = 2.0 to 2.2).
  h.modelAudio(0.2, 2.0);
  // Suppressed mic frame 1 arrives during playback (t = 2.1).
  const seq1 = h.micFrame(1001, 2.1);
  assert.ok(seq1 > 0);
  // Playback ends at t = 2.2; 25 ms gap frame 2 arrives at t = 2.225 while frame 1 is still scoring.
  const seq2 = h.micFrame(2002, 2.225);
  assert.ok(seq2 > seq1);
  assert.equal(h.gate.hasDeferred, true);

  // Another audio packet arrives at t = 2.25 before the wake worker answers.
  // Gap frame 2 is flushed unsuppressed before playback B starts, without resetting the wake worker.
  const flushesBefore = h.commands.filter((c) => c.type === "flush").length;
  h.modelAudio(0.4, 2.25);
  assert.equal(h.gate.hasDeferred, false);
  // Suppressed frame 3 arrives during playback B at t = 2.30.
  const seq3 = h.micFrame(3003, 2.30);
  assert.ok(seq3 > seq2);

  // Late wake hit for frame 1 arrives at t = 2.32: must still interrupt playback B (emit flush),
  // preserve gap frame 2 unsuppressed, replay newer suppressed frame 3, and NEVER append frame 1 after frame 2.
  h.setT(2.32);
  h.emitDetected(seq1, 1001);

  const flushesAfter = h.commands.filter((c) => c.type === "flush").length;
  assert.ok(flushesAfter > flushesBefore, "wake hit must still interrupt resumed playback with flush");
  const nonzero = h.sentAudioTags.filter((tag) => tag !== 0);
  assert.deepEqual(nonzero, [2002, 3003], "gap frame 2 must arrive unsuppressed followed by frame 3, never reversed as [2002, 1001]");
});

test("WakeAudioGate: queued brief.ready flushes gap audio without allowing a late wake hit to reverse audio", () => {
  const h = createCoreHarness({
    attention: { mode: "window", afterWake: 1.0, window: 1.0, afterQuestion: 2.0, afterHandOff: 0, afterAnnouncement: 0 },
    announce: { by: "host", engaged: 6, lull: 3, attach: 0.4, briefWait: 5, maxWait: 8, maxWords: 28 },
  });
  h.start();
  // Start a task before going dormant so a real host brief can be requested and delivered.
  h.push({ type: "ws.message", sid: h.getSid(), data: JSON.stringify({ voiceActivity: { type: "ACTIVITY_START" } }) }, 0.1);
  h.push({ type: "ws.message", sid: h.getSid(), data: JSON.stringify({ serverContent: { inputTranscription: { text: "Check mail" } } }) }, 0.12);
  h.push({ type: "ws.message", sid: h.getSid(), data: JSON.stringify({ voiceActivity: { type: "ACTIVITY_END" } }) }, 0.14);
  h.push({
    type: "ws.message",
    sid: h.getSid(),
    data: JSON.stringify({ toolCall: { functionCalls: [{ id: "tc_q", name: "ask_hermes", args: {} }] } }),
  }, 0.2);
  h.advanceTo(0.4);
  h.advanceTo(0.6);
  const tc = h.commands.find((c): c is Extract<Command, { type: "tool.call" }> => c.type === "tool.call")!;
  for (let step = 0.8; step <= 2.2; step += 0.2) h.advanceTo(step);
  assert.ok(h.commands.some((c) => c.type === "status" && c.status === "dormant"));
  h.sentAudioTags.length = 0;

  h.modelAudio(0.2, 2.4); // plays until 2.6
  const seq1 = h.micFrame(1001, 2.5);
  // Task finishes at 2.55 (toneAt = 2.55, so brief.ready at 2.64 waits for tone < 0.6 s and queues without playing yet).
  h.push({ type: "tool.result", run: tc.run, text: "No new mail." }, 2.55);
  const briefReq = h.commands.find((c): c is Extract<Command, { type: "brief" }> => c.type === "brief")!;
  h.micFrame(2002, 2.62);
  assert.equal(h.gate.hasDeferred, true);

  // A valid requested brief.ready arrives at t = 2.64 (queued while waiting out the result tone):
  // flushes frame 2 into dormant pre-roll without playing yet.
  const briefPcm = Buffer.alloc(48_000, 1).toString("base64");
  h.push({ type: "brief.ready", id: briefReq.id, text: "No new mail.", pcm: briefPcm }, 2.64);
  assert.equal(h.gate.hasDeferred, false);

  // Late wake hit arrives at t = 2.66: wakes the dormant call, drains unsuppressed frame 2 from pre-roll,
  // and skips older suppressed frame 1 instead of appending it after frame 2.
  h.setT(2.66);
  h.emitDetected(seq1, 1001);

  const nonzero = h.sentAudioTags.filter((tag) => tag !== 0);
  assert.deepEqual(nonzero, [2002], "frame 2 must not be followed by older frame 1");
});

test("WakeAudioGate: queued host brief flushes before tick, and after it plays a tick does not drop normal playback-end wake", () => {
  const h = createCoreHarness({
    announce: { by: "host", engaged: 6, lull: 0.3, attach: 0.3, briefWait: 5, maxWait: 8, maxWords: 28 },
  });
  h.start();
  h.advanceTo(0.2);

  // Start a Hermes task and complete it while model playback is active so its host brief waits for a tick.
  h.push({ type: "ws.message", sid: h.getSid(), data: JSON.stringify({ voiceActivity: { type: "ACTIVITY_START" } }) }, 0.22);
  h.push({ type: "ws.message", sid: h.getSid(), data: JSON.stringify({ serverContent: { inputTranscription: { text: "Check the build" } } }) }, 0.24);
  h.push({ type: "ws.message", sid: h.getSid(), data: JSON.stringify({ voiceActivity: { type: "ACTIVITY_END" } }) }, 0.26);
  h.push({
    type: "ws.message",
    sid: h.getSid(),
    data: JSON.stringify({
      toolCall: { functionCalls: [{ id: "tc1", name: "ask_hermes", args: {} }] },
    }),
  }, 0.3);
  h.advanceTo(0.45);
  h.advanceTo(0.65);
  const tc = h.commands.find((c): c is Extract<Command, { type: "tool.call" }> => c.type === "tool.call");
  assert.ok(tc, "tool.call should be emitted for ask_hermes");
  h.modelAudio(0.5, 0.7); // plays until t = 1.2
  h.push({ type: "tool.result", run: tc.run, text: "Build passed." }, 0.8);
  const briefReq = h.commands.find((c): c is Extract<Command, { type: "brief" }> => c.type === "brief");
  assert.ok(briefReq, "host brief should be requested for completed task");
  // Deliver brief.ready while model audio is still playing (until 1.2), so the brief is queued.
  const briefPcm = Buffer.alloc(Math.round(0.4 * 24_000) * 2, 1).toString("base64");
  h.push({ type: "brief.ready", id: briefReq.id, text: "Build passed.", pcm: briefPcm }, 0.9);
  // End model turn so attach window opens after speechUntil (1.2).
  h.push({ type: "ws.message", sid: h.getSid(), data: JSON.stringify({ serverContent: { generationComplete: true, turnComplete: true } }) }, 1.0);

  // Suppressed frame during model audio, then quiet nonzero gap frame after playback ends (t = 1.55)
  // so it does not trigger the loud-mic brief holdback while still distinguishing nonzero PCM from silence.
  const seq1 = h.micFrame(1001, 1.1);
  h.sentAudioTags.length = 0;
  h.micFrame(200, 1.55);
  assert.equal(h.gate.hasDeferred, true);

  // Tick at t = 1.60 starts the queued announcer brief: gap frame 200 must flush BEFORE tick,
  // reaching the model as nonzero audio (not silenced by the announcer brief's speechUntil).
  h.advanceTo(1.60);
  assert.ok(h.commands.some((c) => c.type === "play" && c.source === "announcer"), "tick should start queued announcer brief");
  assert.ok(h.sentAudioTags.includes(200), "gap frame 200 must reach the model unsuppressed before tick announcement");
  h.emitAck(seq1);

  // Let the 0.4 s announcer brief finish naturally (1.60 + 0.40 = 2.00 -> done by 2.3).
  h.advanceTo(2.3);

  // Now model plays another reply (2.4 -> 2.6) with NO host brief pending.
  h.sentAudioTags.length = 0;
  h.modelAudio(0.2, 2.4);
  const seq4 = h.micFrame(4004, 2.5);
  const seq5 = h.micFrame(5005, 2.62);
  assert.equal(h.gate.hasDeferred, true);

  // A 100 ms tick arrives while seq4 is still scoring and no host brief is pending:
  // must NOT flush deferred audio or drop the wake detection.
  h.advanceTo(2.65);
  assert.equal(h.gate.hasDeferred, true, "tick with no pending host brief must leave deferred audio intact");
  h.emitDetected(seq4, 4004);

  const nonzeroAfter = h.sentAudioTags.filter((tag) => tag !== 0);
  assert.deepEqual(nonzeroAfter, [4004, 5005], "both suppressed frame 4 and gap frame 5 must arrive in exact order");
});

test("WakeAudioGate: playback-end wake replays [1, 2] in order, and seq=0 gap flush still blocks [2, 1] reversal", () => {
  // Part 1: normal playback-end gap in dormant call replays [1001, 2002] chronologically.
  const dormantHarness = createCoreHarness({
    attention: { mode: "window", afterWake: 1.0, window: 1.0, afterQuestion: 2.0, afterHandOff: 0, afterAnnouncement: 0 },
  });
  dormantHarness.start();
  for (let step = 0.2; step <= 1.4; step += 0.2) dormantHarness.advanceTo(step);
  dormantHarness.sentAudioTags.length = 0;

  dormantHarness.modelAudio(0.2, 2.0);
  const seq1 = dormantHarness.micFrame(1001, 2.1);
  dormantHarness.micFrame(2002, 2.22);
  dormantHarness.setT(2.24);
  dormantHarness.emitDetected(seq1, 1001);
  assert.deepEqual(dormantHarness.sentAudioTags.filter((tag) => tag !== 0), [1001, 2002]);

  // Part 2: open call where core turns wakeword off right as playback ends, so gap frame 2 gets seq=0.
  const openHarness = createCoreHarness();
  openHarness.start();
  openHarness.advanceTo(0.2);
  openHarness.modelAudio(0.2, 1.0); // speechUntil = 1.2, wakeword: true
  const openSeq1 = openHarness.micFrame(1001, 1.1);
  assert.ok(openSeq1 > 0);
  openHarness.sentAudioTags.length = 0;

  // Tick at 1.25 turns wakeword off in the open call before gap frame 2 arrives.
  openHarness.advanceTo(1.25);
  const openSeq2 = openHarness.micFrame(2002, 1.26);
  assert.equal(openSeq2, 0, "gap frame after wakeword:false has seq=0");
  assert.equal(openHarness.gate.hasDeferred, true);

  // Playback resumes at 1.28, flushing seq=0 gap frame 2 unsuppressed.
  const flushesBefore = openHarness.commands.filter((c) => c.type === "flush").length;
  openHarness.modelAudio(0.3, 1.28);
  assert.equal(openHarness.gate.hasDeferred, false);

  // Late wake hit for openSeq1 (echoing openSeq1's original feed generation!) still interrupts
  // resumed playback without appending 1001 after 2002.
  openHarness.setT(1.30);
  openHarness.emitDetected(openSeq1, 1001);
  assert.ok(openHarness.commands.filter((c) => c.type === "flush").length > flushesBefore);
  assert.deepEqual(openHarness.sentAudioTags.filter((tag) => tag !== 0), [2002]);
});

test("WakeAudioGate: cutting a host brief at >= 80% played does not leave pendingHostBriefs stuck", () => {
  const h = createCoreHarness({
    announce: { by: "host", engaged: 6, lull: 0.3, attach: 0.3, briefWait: 5, maxWait: 8, maxWords: 28 },
  });
  h.start();
  h.advanceTo(0.2);

  // Trigger a host brief (0.4 s) and cut it via wake at 87.5% played (0.35 s into 0.40 s).
  h.push({ type: "ws.message", sid: h.getSid(), data: JSON.stringify({ voiceActivity: { type: "ACTIVITY_START" } }) }, 0.22);
  h.push({ type: "ws.message", sid: h.getSid(), data: JSON.stringify({ serverContent: { inputTranscription: { text: "Check tests" } } }) }, 0.24);
  h.push({ type: "ws.message", sid: h.getSid(), data: JSON.stringify({ voiceActivity: { type: "ACTIVITY_END" } }) }, 0.26);
  h.push({
    type: "ws.message",
    sid: h.getSid(),
    data: JSON.stringify({ toolCall: { functionCalls: [{ id: "tc2", name: "ask_hermes", args: {} }] } }),
  }, 0.3);
  h.advanceTo(0.45);
  h.advanceTo(0.65);
  const tc = h.commands.find((c): c is Extract<Command, { type: "tool.call" }> => c.type === "tool.call")!;
  h.push({ type: "ws.message", sid: h.getSid(), data: JSON.stringify({ serverContent: { generationComplete: true, turnComplete: true } }) }, 0.68);
  h.push({ type: "tool.result", run: tc.run, text: "Tests passed." }, 0.7);
  const briefReq = h.commands.find((c): c is Extract<Command, { type: "brief" }> => c.type === "brief")!;
  const briefPcm = Buffer.alloc(Math.round(0.4 * 24_000) * 2, 1).toString("base64");
  h.push({ type: "brief.ready", id: briefReq.id, text: "Tests passed.", pcm: briefPcm }, 1.5);
  assert.ok(h.commands.some((c) => c.type === "play" && c.source === "announcer"), "brief should play at 1.5");

  // Cut at 1.85 (0.35 / 0.40 = 87.5% >= 80%): core marks brief heard and does NOT re-queue it.
  h.push({ type: "wake" }, 1.85);

  // Subsequent model reply (2.1 -> 2.3): tick during playback-end gap must NOT flush deferred audio early.
  h.sentAudioTags.length = 0;
  h.modelAudio(0.2, 2.1);
  const seq1 = h.micFrame(4004, 2.2);
  h.micFrame(5005, 2.32);
  assert.equal(h.gate.hasDeferred, true);
  h.advanceTo(2.35);
  assert.equal(h.gate.hasDeferred, true, "87.5% cut brief must not leave tick flushing deferred audio");
  h.emitDetected(seq1, 4004);
  assert.deepEqual(h.sentAudioTags.filter((tag) => tag !== 0), [4004, 5005]);
});

test("WakeAudioGate: rejected 1-byte PCM, deliverMax drop, and voice 'stop' over brief never leave tick flushing deferred audio", () => {
  const triggerBrief = (h: ReturnType<typeof createCoreHarness>, id: string) => {
    h.push({ type: "ws.message", sid: h.getSid(), data: JSON.stringify({ voiceActivity: { type: "ACTIVITY_START" } }) }, 0.22);
    h.push({ type: "ws.message", sid: h.getSid(), data: JSON.stringify({ serverContent: { inputTranscription: { text: "Check status" } } }) }, 0.24);
    h.push({ type: "ws.message", sid: h.getSid(), data: JSON.stringify({ voiceActivity: { type: "ACTIVITY_END" } }) }, 0.26);
    h.push({
      type: "ws.message",
      sid: h.getSid(),
      data: JSON.stringify({ toolCall: { functionCalls: [{ id, name: "ask_hermes", args: {} }] } }),
    }, 0.3);
    h.advanceTo(0.45);
    h.advanceTo(0.65);
    const tc = h.commands.find((c): c is Extract<Command, { type: "tool.call" }> => c.type === "tool.call")!;
    h.push({ type: "ws.message", sid: h.getSid(), data: JSON.stringify({ serverContent: { generationComplete: true, turnComplete: true } }) }, 0.68);
    h.push({ type: "tool.result", run: tc.run, text: "All green." }, 0.7);
    return h.commands.find((c): c is Extract<Command, { type: "brief" }> => c.type === "brief")!;
  };

  const assertCleanPlaybackEndWake = (h: ReturnType<typeof createCoreHarness>, startAt: number, label: string) => {
    h.sentAudioTags.length = 0;
    h.modelAudio(0.2, startAt);
    const seq1 = h.micFrame(4004, startAt + 0.1);
    h.micFrame(5005, startAt + 0.22);
    assert.equal(h.gate.hasDeferred, true, `${label}: gap frame should defer`);
    h.advanceTo(startAt + 0.25);
    assert.equal(h.gate.hasDeferred, true, `${label}: tick must not flush deferred audio`);
    h.emitDetected(seq1, 4004);
    assert.deepEqual(h.sentAudioTags.filter((tag) => tag !== 0), [4004, 5005], `${label}: full wake tail must replay`);
  };

  // Case 1: 1-byte PCM rejected by call.ts (odd byte length).
  const badPcm = createCoreHarness({
    announce: { by: "host", engaged: 6, lull: 0.3, attach: 0.3, briefWait: 5, maxWait: 8, maxWords: 28 },
  });
  badPcm.start();
  badPcm.advanceTo(0.2);
  const badReq = triggerBrief(badPcm, "tc_bad");
  badPcm.push({ type: "brief.ready", id: badReq.id, text: "All green.", pcm: Buffer.alloc(1, 1).toString("base64") }, 1.5);
  assertCleanPlaybackEndWake(badPcm, 2.1, "1-byte PCM");

  // Case 2: brief cut below 80% after deliverMax has elapsed (call.ts drops it instead of re-queueing).
  const expired = createCoreHarness({
    limits: { settleQuiet: 0.1, settleMax: 1.5, tick: 0.05, wakePreRoll: 1.0, deliverMax: 0.5 },
    announce: { by: "host", engaged: 6, lull: 0.3, attach: 0.3, briefWait: 5, maxWait: 8, maxWords: 28 },
  });
  expired.start();
  expired.advanceTo(0.2);
  const expReq = triggerBrief(expired, "tc_exp");
  // Hold the brief during a model reply (0.8 -> 1.6), delivering brief.ready at 0.9.
  expired.modelAudio(0.8, 0.8);
  const briefPcm = Buffer.alloc(Math.round(0.4 * 24_000) * 2, 1).toString("base64");
  expired.push({ type: "brief.ready", id: expReq.id, text: "All green.", pcm: briefPcm }, 0.9);
  expired.push({ type: "ws.message", sid: expired.getSid(), data: JSON.stringify({ serverContent: { generationComplete: true, turnComplete: true } }) }, 1.0);
  // Brief starts on tick at 2.0 (2.0 - 0.9 = 1.1 >= deliverMax 0.5), then is cut below 80% at 2.1.
  expired.advanceTo(2.0);
  assert.ok(expired.commands.some((c) => c.type === "play" && c.source === "announcer"), "expired brief should start");
  expired.push({ type: "wake" }, 2.1);
  assertCleanPlaybackEndWake(expired, 2.5, "deliverMax cut");

  // Case 3: user says "stop" over a host brief (ACTIVITY_START cuts < 80%, then "stop" hushes lastCut within 6 s).
  const stopped = createCoreHarness({
    announce: { by: "host", engaged: 6, lull: 0.3, attach: 0.3, briefWait: 5, maxWait: 8, maxWords: 28 },
  });
  stopped.start();
  stopped.advanceTo(0.2);
  const stopReq = triggerBrief(stopped, "tc_stop");
  stopped.push({ type: "brief.ready", id: stopReq.id, text: "All green.", pcm: briefPcm }, 1.5);
  assert.ok(stopped.commands.some((c) => c.type === "play" && c.source === "announcer"), "brief should play before stop");
  stopped.push({ type: "ws.message", sid: stopped.getSid(), data: JSON.stringify({ voiceActivity: { type: "ACTIVITY_START" } }) }, 1.6);
  stopped.push({ type: "ws.message", sid: stopped.getSid(), data: JSON.stringify({ serverContent: { inputTranscription: { text: "stop" } } }) }, 1.7);
  stopped.push({ type: "ws.message", sid: stopped.getSid(), data: JSON.stringify({ voiceActivity: { type: "ACTIVITY_END" } }) }, 1.8);
  stopped.push({ type: "ws.message", sid: stopped.getSid(), data: JSON.stringify({ serverContent: { turnComplete: true } }) }, 1.9);
  assertCleanPlaybackEndWake(stopped, 2.4, "voice stop");
});

test("WakeAudioGate: late brief before tick expiry and 'not a stop after all' both flush gap audio before tick announcement", () => {
  const briefPcm = Buffer.alloc(Math.round(0.4 * 24_000) * 2, 1).toString("base64");

  const triggerBrief = (h: ReturnType<typeof createCoreHarness>, id: string) => {
    h.push({ type: "ws.message", sid: h.getSid(), data: JSON.stringify({ voiceActivity: { type: "ACTIVITY_START" } }) }, 0.22);
    h.push({ type: "ws.message", sid: h.getSid(), data: JSON.stringify({ serverContent: { inputTranscription: { text: "Check status" } } }) }, 0.24);
    h.push({ type: "ws.message", sid: h.getSid(), data: JSON.stringify({ voiceActivity: { type: "ACTIVITY_END" } }) }, 0.26);
    h.push({
      type: "ws.message",
      sid: h.getSid(),
      data: JSON.stringify({ toolCall: { functionCalls: [{ id, name: "ask_hermes", args: {} }] } }),
    }, 0.3);
    h.advanceTo(0.45);
    h.advanceTo(0.65);
    const tc = h.commands.find((c): c is Extract<Command, { type: "tool.call" }> => c.type === "tool.call")!;
    h.push({ type: "ws.message", sid: h.getSid(), data: JSON.stringify({ serverContent: { generationComplete: true, turnComplete: true } }) }, 0.68);
    h.push({ type: "tool.result", run: tc.run, text: "All green." }, 0.7);
    return h.commands.find((c): c is Extract<Command, { type: "brief" }> => c.type === "brief")!;
  };

  // Case 1: brief.ready arrives past briefWait without an intervening tick; an ignored unknown-ID
  // brief.ready ahead of it must NOT expire the real request, so call.ts accepts and queues it.
  const late = createCoreHarness({
    announce: { by: "host", engaged: 6, lull: 0.3, attach: 0.3, briefWait: 0.5, maxWait: 8, maxWords: 28 },
  });
  late.start();
  late.advanceTo(0.2);
  const lateReq = triggerBrief(late, "tc_late"); // briefAsked = 0.7, briefWait = 0.5 -> deadline 1.2
  // Model playback runs 1.0 -> 2.0 with NO tick in between.
  // An ignored unknown-ID brief.ready at 1.35 does not run announce() in call.ts and must not expire lateReq.
  late.modelAudio(1.0, 1.0);
  late.push({ type: "brief.ready", id: "unknown-id", text: "Ignored.", pcm: briefPcm }, 1.35);
  late.push({ type: "brief.ready", id: lateReq.id, text: "All green.", pcm: briefPcm }, 1.4);
  late.push({ type: "ws.message", sid: late.getSid(), data: JSON.stringify({ serverContent: { generationComplete: true, turnComplete: true } }) }, 1.5);
  const lateSeq1 = late.micFrame(1001, 1.8);
  late.sentAudioTags.length = 0;
  late.micFrame(200, 2.35);
  assert.equal(late.gate.hasDeferred, true);
  // Tick at 2.40 starts the queued late brief: gap frame 200 must flush unsuppressed before tick.
  late.advanceTo(2.40);
  assert.ok(late.commands.some((c) => c.type === "play" && c.source === "announcer"), "late brief should start on tick");
  assert.ok(late.sentAudioTags.includes(200), "gap frame 200 must reach model unsuppressed before late brief starts");
  late.emitAck(lateSeq1);

  // Case 2: user says "stop" then " by the office" ("not a stop after all: the model may answer");
  // the core restores the brief, and the gate must flush deferred gap audio before the tick that replays it.
  const notStop = createCoreHarness({
    announce: { by: "host", engaged: 6, lull: 0.3, attach: 0.3, briefWait: 5, maxWait: 8, maxWords: 28 },
  });
  notStop.start();
  notStop.advanceTo(0.2);
  const nsReq = triggerBrief(notStop, "tc_ns");
  notStop.push({ type: "brief.ready", id: nsReq.id, text: "All green.", pcm: briefPcm }, 1.5);
  assert.equal(notStop.commands.filter((c) => c.type === "play" && c.source === "announcer").length, 1);
  // Cut at 1.6 (< 80%), say "stop" at 1.7, then continue with " by the office" at 1.75.
  notStop.push({ type: "ws.message", sid: notStop.getSid(), data: JSON.stringify({ voiceActivity: { type: "ACTIVITY_START" } }) }, 1.6);
  notStop.push({ type: "ws.message", sid: notStop.getSid(), data: JSON.stringify({ serverContent: { inputTranscription: { text: "stop" } } }) }, 1.7);
  notStop.push({ type: "ws.message", sid: notStop.getSid(), data: JSON.stringify({ serverContent: { inputTranscription: { text: " by the office" } } }) }, 1.75);
  notStop.push({ type: "ws.message", sid: notStop.getSid(), data: JSON.stringify({ voiceActivity: { type: "ACTIVITY_END" } }) }, 1.8);
  // Model replies 2.0 -> 2.4 and finishes its turn; restored brief is still queued for attach after 2.4.
  notStop.modelAudio(0.4, 2.0);
  notStop.push({ type: "ws.message", sid: notStop.getSid(), data: JSON.stringify({ serverContent: { generationComplete: true, turnComplete: true } }) }, 2.1);
  const nsSeq1 = notStop.micFrame(1001, 2.2);
  notStop.sentAudioTags.length = 0;
  notStop.micFrame(200, 2.75);
  assert.equal(notStop.gate.hasDeferred, true);
  // Tick at 2.80 replays the restored brief: gap frame 200 must flush unsuppressed BEFORE tick.
  notStop.advanceTo(2.80);
  assert.equal(notStop.commands.filter((c) => c.type === "play" && c.source === "announcer").length, 2, "restored brief should replay on tick");
  assert.ok(notStop.sentAudioTags.includes(200), "gap frame 200 must reach model unsuppressed before restored brief plays");
  notStop.emitAck(nsSeq1);
});

test("WakeAudioGate: push-to-talk release/re-press never leaks audio captured while muted", () => {
  // Part 1: Space release mirrors app.ts (flush + reset + mute), plus mute guard in WakeAudioGate.
  const ptt = createCoreHarness({ muted: true });
  ptt.start();
  ptt.advanceTo(0.2);
  // Press Space (unmute), model plays 1.0 -> 1.2, suppressed frame 1001 is still in flight in the worker.
  ptt.push({ type: "unmute" }, 0.9);
  ptt.modelAudio(0.2, 1.0);
  const seq1 = ptt.micFrame(1001, 1.1);
  assert.ok(seq1 > 0);
  ptt.sentAudioTags.length = 0;

  // Release Space right as playback ends: mute (even WITHOUT resetting wakeClient, to test gate's own mute guard!).
  ptt.push({ type: "mute" }, 1.21);
  // Frame 2345 captured while muted must NEVER be deferred and must be dropped by the muted core.
  ptt.micFrame(2345, 1.23);
  assert.equal(ptt.gate.hasDeferred, false, "muted PCM must never enter deferred queue");

  // Re-press Space (unmute) and receive the worker's ack for seq1: frame 2345 must NOT leak to the model.
  ptt.push({ type: "unmute" }, 1.25);
  ptt.emitAck(seq1);
  assert.equal(ptt.sentAudioTags.includes(2345), false, "audio captured while muted must never reach the model after re-press");

  // Unmuted audio after re-press still flows normally.
  ptt.micFrame(6006, 1.27);
  assert.ok(ptt.sentAudioTags.includes(6006));

  // Redundant unmute while mic is already open (e.g. pressing M while holding Space)
  // must preserve deferred unmuted gap audio instead of dropping it.
  ptt.modelAudio(0.2, 2.0);
  const seq2 = ptt.micFrame(1002, 2.1);
  ptt.sentAudioTags.length = 0;
  ptt.micFrame(7007, 2.22);
  assert.equal(ptt.gate.hasDeferred, true);
  ptt.push({ type: "unmute" }, 2.23);
  assert.equal(ptt.gate.hasDeferred, true, "redundant unmute must not drop queued unmuted audio");
  ptt.emitAck(seq2);
  assert.ok(ptt.sentAudioTags.includes(7007), "queued unmuted audio must reach model after redundant unmute");
});
