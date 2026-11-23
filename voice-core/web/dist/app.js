// src/commands.ts
var FILLER = /* @__PURE__ */ new Set([
  "hey",
  "ok",
  "okay",
  "please",
  "now",
  "just",
  "so",
  "um",
  "uh",
  "oh",
  "alright",
  "right",
  "yeah",
  "yes",
  "thanks",
  "thank",
  "you",
  "gemini"
]);
function words(text) {
  return text.toLowerCase().replace(/['’`]/g, "").replace(/[^\p{L}\p{Nd}]+/gu, " ").trim().split(" ").filter((w) => w.length > 0);
}
function commandIn(utterance, commands, names = []) {
  const ignored = /* @__PURE__ */ new Set([...FILLER, ...names.flatMap(words)]);
  const said = words(utterance);
  let from = 0;
  let to = said.length;
  while (from < to && ignored.has(said[from])) from++;
  while (to > from && ignored.has(said[to - 1])) to--;
  if (from === to || to - from > 5) return null;
  const core2 = said.slice(from, to).join(" ");
  const is = (phrases) => phrases.some((p) => words(p).join(" ") === core2);
  if (is(commands.hangUp)) return "hangUp";
  if (is(commands.cancelAll ?? [])) return "cancelAll";
  if (is(commands.stop)) return "stop";
  return null;
}

// web/audio.ts
var WORKLETS = `
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / 16000;
    this.pos = 0;
    this.frame = new Int16Array(320);
    this.n = 0;
    // A windowed-sinc low-pass at 7 kHz, so nothing above 16 kHz's 8 kHz limit folds back into speech.
    const taps = 47, cut = 7000 / sampleRate;
    this.taps = new Float32Array(taps);
    let sum = 0;
    for (let k = 0; k < taps; k++) {
      const m = k - (taps - 1) / 2;
      const sinc = m === 0 ? 2 * cut : Math.sin(2 * Math.PI * cut * m) / (Math.PI * m);
      const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * k) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * k) / (taps - 1));
      this.taps[k] = sinc * w;
      sum += this.taps[k];
    }
    for (let k = 0; k < taps; k++) this.taps[k] /= sum;
    this.history = new Float32Array(taps);
    this.at = 0;
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    const taps = this.taps, h = this.history, n = taps.length;
    for (let i = 0; i < input.length; i++) {
      h[this.at] = input[i];
      this.at = (this.at + 1) % n;
      // Only the samples kept need filtering: at most one in every step.
      if (this.pos > 1) { this.pos -= 1; continue; }
      let x = 0;
      for (let k = 0, j = this.at; k < n; k++, j = j + 1 === n ? 0 : j + 1) x += taps[k] * h[j];
      while (this.pos <= 1) {
        const s = Math.max(-1, Math.min(1, x));
        this.frame[this.n++] = s < 0 ? s * 32768 : s * 32767;
        if (this.n === this.frame.length) {
          this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
          this.frame = new Int16Array(320);
          this.n = 0;
        }
        this.pos += this.step;
      }
      this.pos -= 1;
    }
    return true;
  }
}

class Playback extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];      // Float32Arrays at the context's rate
    this.offset = 0;
    this.cues = [];
    this.cueOffset = 0;
    this.reported = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === "play") this.queue.push(m.samples);
      else if (m.type === "cue") this.cues.push(m.samples);
      else if (m.type === "flush") { this.queue = []; this.offset = 0; }
      else if (m.type === "stop") { this.queue = []; this.offset = 0; this.cues = []; this.cueOffset = 0; }
    };
  }
  process(_, outputs) {
    const out = outputs[0][0];
    out.fill(0);
    for (let i = 0; i < out.length && this.queue.length; i++) {
      out[i] = this.queue[0][this.offset++];
      if (this.offset >= this.queue[0].length) { this.queue.shift(); this.offset = 0; }
    }
    for (let i = 0; i < out.length && this.cues.length; i++) {
      out[i] = Math.max(-1, Math.min(1, out[i] + this.cues[0][this.cueOffset++]));
      if (this.cueOffset >= this.cues[0].length) { this.cues.shift(); this.cueOffset = 0; }
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    if (currentTime - this.reported > 0.1) {
      this.reported = currentTime;
      let queued = -this.offset;
      for (const q of this.queue) queued += q.length;
      this.port.postMessage({ queued: queued / sampleRate });
    }
    return true;
  }
}
registerProcessor("capture", Capture);
registerProcessor("playback", Playback);
`;
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(bin);
}
function toFloats(pcm, rate, target) {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const n = Math.floor(pcm.byteLength / 2);
  const out = new Float32Array(Math.floor(n * target / rate));
  const step = rate / target;
  for (let i = 0; i < out.length; i++) {
    const x = i * step;
    const j = Math.floor(x);
    const a = view.getInt16(2 * Math.min(j, n - 1), true);
    const b = view.getInt16(2 * Math.min(j + 1, n - 1), true);
    out[i] = (a + (b - a) * (x - j)) / 32768;
  }
  return out;
}
var CallAudio = class {
  constructor() {
    this.context = null;
    this.playback = null;
    this.capture = null;
    this.stream = null;
    this.source = null;
    this.micOpts = null;
    this.onMicFrame = null;
    /** Seconds of speech queued, as the worklet last said. */
    this.queued = 0;
    /** The microphone's level, RMS of the last frame (0 to 1). */
    this.level = 0;
  }
  async open() {
    if (this.context) {
      if (this.context.state === "suspended") await this.context.resume();
      return;
    }
    this.context = new AudioContext({ latencyHint: "interactive" });
    const url = URL.createObjectURL(new Blob([WORKLETS], { type: "text/javascript" }));
    await this.context.audioWorklet.addModule(url);
    this.playback = new AudioWorkletNode(this.context, "playback", { numberOfInputs: 0, outputChannelCount: [2] });
    this.playback.port.onmessage = (e) => {
      this.queued = e.data.queued;
    };
    this.playback.connect(this.context.destination);
  }
  /** Seconds from a sample leaving the worklet to the speaker, as the browser reckons it. */
  get outputLatency() {
    if (!this.context) return null;
    return this.context.baseLatency + (this.context.outputLatency ?? 0);
  }
  get micActive() {
    return this.capture != null && this.stream != null && this.stream.getTracks().some((t) => t.readyState === "live");
  }
  /** Starts the microphone if it isn't already running with the same options; otherwise swaps the frame callback cleanly. */
  async ensureMic(onFrame, options) {
    if (this.micActive && this.micOpts && this.micOpts.echoCancellation === options.echoCancellation && this.micOpts.noiseSuppression === options.noiseSuppression && this.micOpts.autoGainControl === options.autoGainControl) {
      await this.open();
      this.onMicFrame = onFrame;
      return;
    }
    await this.startMic(onFrame, options);
  }
  async startMic(onFrame, options) {
    await this.open();
    this.stopMic();
    const context = this.context;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, ...options } });
    this.micOpts = { ...options };
    this.onMicFrame = onFrame;
    this.source = context.createMediaStreamSource(this.stream);
    this.capture = new AudioWorkletNode(context, "capture", { numberOfOutputs: 0 });
    this.capture.port.onmessage = (e) => {
      const frame = new Int16Array(e.data);
      let sum = 0;
      for (const s of frame) sum += s * s;
      this.level = Math.sqrt(sum / frame.length) / 32768;
      this.onMicFrame?.(frame, this.level);
    };
    this.source.connect(this.capture);
  }
  stopMic() {
    this.source?.disconnect();
    this.capture?.port.close();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.source = null;
    this.capture = null;
    this.stream = null;
    this.micOpts = null;
    this.onMicFrame = null;
    this.level = 0;
  }
  play(pcm64) {
    if (!this.context || !this.playback) return;
    const samples = toFloats(base64ToBytes(pcm64), 24e3, this.context.sampleRate);
    this.playback.port.postMessage({ type: "play", samples }, [samples.buffer]);
  }
  cue(pcm64) {
    if (!this.context || !this.playback) return;
    const samples = toFloats(base64ToBytes(pcm64), 24e3, this.context.sampleRate);
    this.playback.port.postMessage({ type: "cue", samples }, [samples.buffer]);
  }
  flush() {
    this.playback?.port.postMessage({ type: "flush" });
  }
  stopPlayback() {
    this.playback?.port.postMessage({ type: "stop" });
    this.queued = 0;
  }
  stop() {
    this.stopMic();
    this.stopPlayback();
  }
};

// web/replay.ts
function line(o) {
  const text = JSON.stringify(o).replace(/"(data|pcm)":"[A-Za-z0-9+/=]{40,}"/g, '"$1":"\u2026"').replace(/\\"data\\":\\"[A-Za-z0-9+/=]{40,}\\"/g, '\\"data\\":\\"\u2026\\"');
  return text.length > 400 ? text.slice(0, 400) + "\u2026" : text;
}
function telling(o) {
  if (o.type === "mic" || o.type === "tick" || o.type === "play") return false;
  if (o.type === "ws.send" && String(o.data).startsWith('{"realtimeInput":{"audio"')) return false;
  if (o.type === "ws.message" && String(o.data).includes('"inlineData"') && !String(o.data).includes('"turnComplete"')) return false;
  return true;
}
function run(core2, r) {
  const created = JSON.parse(core2.create(JSON.stringify(r.config), r.start));
  const out = [created.commands.filter(telling).map(line)];
  for (const e of r.events) out.push(JSON.parse(core2.push(created.id, JSON.stringify(e))).filter(telling).map(line));
  return out;
}
var Replay = class {
  constructor(root, load) {
    this.root = root;
    this.load = load;
    root.innerHTML = `
      <h2>Trace replay</h2>
      <div class="bar"><select class="pick" aria-label="Recording"></select><button type="button" class="refresh" title="Refresh list" aria-label="Refresh list">\u21BB</button><button type="button" class="go">Replay</button>
      <label class="toggle-all"><input type="checkbox" class="all"> Show audio and ticks</label><span class="summary"></span></div>
      <div class="timeline"></div>`;
    root.querySelector(".refresh").onclick = () => void this.list();
    root.querySelector(".go").onclick = () => void this.replay().catch((err) => this.say(`Replay failed: ${err.message}`));
    void this.list();
  }
  say(text) {
    this.root.querySelector(".summary").textContent = text;
  }
  async list() {
    const pick = this.root.querySelector(".pick");
    pick.innerHTML = "";
    const traces = await (await fetch("/traces")).json();
    const scenarios = await (await fetch("/scenarios")).json();
    const traceGroup = document.createElement("optgroup");
    traceGroup.label = "Recorded calls";
    for (const t of traces) traceGroup.append(new Option(`${t.name} (${Math.round(t.bytes / 1024)} KB)`, `/traces/${t.name}`));
    const scenarioGroup = document.createElement("optgroup");
    scenarioGroup.label = "Scenarios";
    for (const s of scenarios) scenarioGroup.append(new Option(s, `/scenarios/${s}.json`));
    pick.append(traceGroup, scenarioGroup);
  }
  async recording(url) {
    const text = await (await fetch(url, { cache: "no-store" })).text();
    if (url.endsWith(".json")) return JSON.parse(text);
    const [header, ...events] = text.trim().split("\n").map((l) => JSON.parse(l));
    return { ...header, events };
  }
  async replay() {
    const url = this.root.querySelector(".pick").value;
    if (!url) return;
    const r = await this.recording(url);
    const latest = await this.load();
    let recorded = null;
    if (r.version && r.version !== latest.version) {
      const response = await fetch(`/versions/${r.version}.js`, { method: "HEAD" });
      if (response.ok) recorded = await this.load(`/versions/${r.version}.js`);
    }
    const now2 = run(latest, r);
    const then = recorded ? run(recorded, r) : null;
    const all = this.root.querySelector(".all").checked;
    const timeline = this.root.querySelector(".timeline");
    timeline.innerHTML = "";
    let first = -1;
    let differ = 0;
    const rows = [];
    const add = (cls, t, text) => {
      const row = document.createElement("div");
      row.className = `row ${cls}`;
      row.innerHTML = `<span class="t">${t}</span>`;
      const b = document.createElement("span");
      b.className = "b";
      b.textContent = text;
      row.append(b);
      timeline.append(row);
      rows.push(row);
      return row;
    };
    const t0 = r.start;
    for (let i = 0; i <= r.events.length; i++) {
      const e = i === 0 ? null : r.events[i - 1];
      const nowOut = now2[i];
      const thenOut = then ? then[i] : nowOut;
      const same = nowOut.length === thenOut.length && nowOut.every((c, j) => c === thenOut[j]);
      if (!same) {
        differ++;
        if (first < 0) first = i;
      }
      if (!same || all || e && telling(e) || nowOut.length > 0) {
        if (e && (all || telling(e) || !same)) add("in", (e.t - t0).toFixed(2), line(e));
        const t = e ? (e.t - t0).toFixed(2) : "0.00";
        if (same) for (const c of nowOut) add("out", t, c);
        else {
          for (const c of thenOut) add("out gone", t, `\u2212 ${c}`);
          for (const c of nowOut) add("out new", t, `+ ${c}`);
        }
      }
    }
    const versions = then ? `recorded by ${r.version}, replayed by it and by ${latest.version}` : `replayed by ${latest.version}` + (r.version && r.version !== latest.version ? ` (the recording's build ${r.version} isn't kept here)` : "");
    this.say(`${r.events.length} events, ${versions}. ` + (then ? differ ? `${differ} events answered differently, the first at event ${first}.` : "Both answered every event the same." : ""));
    if (first >= 0) timeline.querySelector(".gone, .new")?.scrollIntoView({ block: "center" });
  }
};

// web/scroll.ts
var AutoScroller = class {
  constructor(pane, options = {}) {
    this.pinned = true;
    this.jumping = false;
    this.lastScrollTop = 0;
    this.pane = pane;
    this.pinThreshold = options.pinThreshold ?? 32;
    this.jumpThreshold = options.jumpThreshold ?? 120;
    this.onJumpChange = options.onJumpChange;
    this.isEmpty = options.isEmpty;
    this.lastScrollTop = pane.scrollTop;
  }
  get isPinned() {
    return this.pinned;
  }
  distance() {
    return Math.max(0, this.pane.scrollHeight - this.pane.scrollTop - this.pane.clientHeight);
  }
  isVisible() {
    return this.pane.clientHeight > 0;
  }
  snapToBottom() {
    if (!this.isVisible()) return;
    this.pane.scrollTop = this.pane.scrollHeight;
    this.lastScrollTop = this.pane.scrollTop;
  }
  updateJump() {
    if (!this.onJumpChange) return;
    const empty = this.isEmpty?.() ?? false;
    const show = !empty && this.isVisible() && !this.jumping && this.distance() > this.jumpThreshold;
    this.onJumpChange(show);
  }
  /** Call after content is added, updated, or removed in the pane. */
  onContent(force = false) {
    if (force) {
      this.pinned = true;
      this.jumping = false;
    }
    if (this.pinned) {
      if (this.jumping && this.pane.scrollTo && this.isVisible()) {
        this.pane.scrollTo({ top: this.pane.scrollHeight, behavior: "smooth" });
      } else {
        this.snapToBottom();
      }
    }
    this.updateJump();
  }
  /** Call when the pane's viewport resizes (bars appearing, keyboard, tab switch). */
  onResize() {
    if (!this.isVisible()) return;
    if (this.pinned) {
      this.jumping = false;
      this.snapToBottom();
    } else {
      this.lastScrollTop = this.pane.scrollTop;
    }
    this.updateJump();
  }
  /** Call from the pane's scroll event listener. */
  onScroll() {
    if (!this.isVisible()) return;
    const top = this.pane.scrollTop;
    const dist = this.distance();
    const movedUp = top < this.lastScrollTop;
    this.lastScrollTop = top;
    if (dist <= this.pinThreshold) {
      this.pinned = true;
      this.jumping = false;
    } else if (movedUp) {
      this.pinned = false;
      this.jumping = false;
    }
    this.updateJump();
  }
  /** Call from the pane's scrollend event listener. */
  onScrollEnd() {
    if (!this.isVisible() || !this.jumping) return;
    this.jumping = false;
    if (this.distance() > this.pinThreshold) this.pinned = false;
    this.updateJump();
  }
  /** Call on user wheel-up or touchstart so an active smooth jump yields to the user. */
  cancelJump() {
    if (!this.jumping) return;
    this.jumping = false;
    if (this.isVisible()) {
      const top = this.pane.scrollTop;
      if (this.pane.scrollTo) this.pane.scrollTo({ top, behavior: "instant" });
      else this.pane.scrollTop = top;
      this.lastScrollTop = this.pane.scrollTop;
      if (this.distance() > this.pinThreshold) this.pinned = false;
    }
    this.updateJump();
  }
  /** Re-pin and scroll smoothly to the bottom (used by the jump-to-latest button). */
  jumpToBottom() {
    this.pinned = true;
    if (!this.isVisible()) {
      this.updateJump();
      return;
    }
    if (this.distance() <= this.pinThreshold || !this.pane.scrollTo) {
      this.jumping = false;
      this.snapToBottom();
    } else {
      this.jumping = true;
      this.lastScrollTop = this.pane.scrollTop;
      this.pane.scrollTo({ top: this.pane.scrollHeight, behavior: "smooth" });
    }
    this.updateJump();
  }
  /** Recompute pinned state from the current position after a user-driven layout change (e.g. expanding a result). */
  syncFromPosition() {
    if (!this.isVisible()) return;
    this.jumping = false;
    this.lastScrollTop = this.pane.scrollTop;
    this.pinned = this.distance() <= this.pinThreshold;
    this.updateJump();
  }
  /** Pause auto-scroll explicitly (e.g. when revealing an older result card). */
  unpin() {
    this.pinned = false;
    this.jumping = false;
    this.updateJump();
  }
};

// web/wakeClient.ts
var WakeClient = class {
  constructor(callbacks) {
    this.worker = null;
    this.loadedModelId = null;
    this.loadingModelId = null;
    this.currentThreshold = 0.7;
    this.ready = false;
    this.callbacks = callbacks;
  }
  ensureWorker() {
    if (this.worker) return this.worker;
    const worker = new Worker("/wake.worker.js", { type: "module" });
    worker.onmessage = (e) => {
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
          rest: new Uint8Array(m.restBytes),
          inferMs: m.inferMs
        });
      } else if (m.type === "telemetry") {
        this.callbacks.onTelemetry?.({
          score: m.score,
          peak: m.peak,
          gateOpen: m.gateOpen,
          frames: m.frames,
          scored: m.scored,
          inferMs: m.inferMs
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
  load(modelId, threshold) {
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
      wasmPaths: "/ort/"
    });
  }
  setThreshold(threshold) {
    this.currentThreshold = threshold;
    this.worker?.postMessage({ type: "config", threshold });
  }
  feed(samples) {
    if (!this.ready || !this.worker) return;
    const copy = new Int16Array(samples.length);
    copy.set(samples);
    this.worker.postMessage({ type: "feed", pcm: copy.buffer }, [copy.buffer]);
  }
  reset() {
    this.worker?.postMessage({ type: "reset" });
  }
  dispose() {
    this.ready = false;
    this.loadedModelId = null;
    this.loadingModelId = null;
    if (this.worker) {
      this.worker.postMessage({ type: "dispose" });
      this.worker.terminate();
      this.worker = null;
    }
  }
  get modelId() {
    return this.loadedModelId ?? this.loadingModelId;
  }
  get threshold() {
    return this.currentThreshold;
  }
};

// web/app.ts
var $ = (id) => document.getElementById(id);
var now = () => performance.now() / 1e3;
var checked = (id) => $(id).checked;
async function loadCore(url = "/voice-core.js") {
  const source = await (await fetch(url, { cache: "no-store" })).text();
  const scope = {};
  new Function("globalThis", source)(scope);
  if (!scope.VoiceCore) throw new Error("the bundle didn't define VoiceCore");
  return scope.VoiceCore;
}
var FAKE_TV = [
  { name: "tv_volume", description: "Sets the living-room TV's volume, 0 to 100.", parameters: { type: "OBJECT", properties: { level: { type: "INTEGER" } }, required: ["level"] } },
  { name: "tv_pause", description: "Pauses or resumes what's playing on the TV.", parameters: { type: "OBJECT", properties: { pause: { type: "BOOLEAN" } } } }
];
var PRESETS = {
  web: { platform: "web", device: "browser", standbyAfter: 30, hangUpAfter: 300, handOff: "named", supervise: true, vocabulary: ["Hermes", "Bento", "Woodhouse", "Pennyworth", "T3"] },
  "web wake word": {
    platform: "web",
    device: "browser",
    standbyAfter: 20,
    hangUpAfter: 120,
    handOff: "named",
    supervise: true,
    attention: { mode: "window", afterWake: 8, window: 5, afterQuestion: 10, afterHandOff: 3, afterAnnouncement: 0 },
    vocabulary: ["Hermes", "Bento", "Woodhouse", "Pennyworth", "T3"]
  },
  android: { platform: "Android", device: "phone", standbyAfter: 20 },
  "android wake word": { platform: "Android", device: "phone", standbyAfter: 20, hangUpAfter: 15 },
  macos: { platform: "macOS", device: "Mac", standbyAfter: 20 },
  echo: {
    platform: "Echo",
    device: "speaker",
    hangUpAfter: 6,
    standbyAfter: 8,
    earcons: true,
    vocabulary: ["Hermes", "Bento", "Woodhouse"],
    mic: { whileSpeaking: "wake", gainDb: 0 },
    hostTools: FAKE_TV
  }
};
var audio = new CallAudio();
var server;
var core = null;
var callId = 0;
var callName = "";
var ticker = 0;
var traceTimer = 0;
var startedAt = now();
var sockets = /* @__PURE__ */ new Map();
var captionSockets = /* @__PURE__ */ new Set();
var runs = /* @__PURE__ */ new Map();
var tasks = /* @__PURE__ */ new Map();
var earlierActiveCount = 0;
var earlierWaitingCount = 0;
var counts = { mic: 0, play: 0, sent: 0 };
var fakeTvLevel = 15;
var coreStatus = "idle";
var muted = false;
var holding = false;
var wakeLock = null;
var wakeArmed = false;
var coreWantsWake = false;
var wakeLoading = false;
var wakeStarting = false;
var openingChunks = [];
var openingBytes = 0;
var OPENING_MAX_BYTES = 10 * 32e3;
var wakeLastTel = null;
var medium = "voice";
var thinking = false;
var requests = /* @__PURE__ */ new Map();
var ending = Promise.resolve();
var HISTORY = "voice.history";
var HISTORY_MAX_AGE = 12 * 3600 * 1e3;
var chat = [];
var lastLine = null;
function remember(role, text, speaker, join = false) {
  const last = chat.at(-1);
  if (join && last && last.role === role && last.speaker === speaker) last.text += text;
  else chat.push(speaker ? { role, speaker, text } : { role, text });
  if (chat.length > 200) chat.splice(0, chat.length - 200);
  localStorage.setItem(HISTORY, JSON.stringify({ at: Date.now(), chat }));
}
function savedHistory() {
  try {
    const saved = JSON.parse(localStorage.getItem(HISTORY) ?? "null");
    return saved && Date.now() - saved.at < HISTORY_MAX_AGE && Array.isArray(saved.chat) ? saved.chat : [];
  } catch {
    return [];
  }
}
function twoNoteTone(f1, f2, noteSec, amp) {
  const rate = 24e3, n = Math.round(rate * noteSec * 2), half = Math.round(rate * noteSec), out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const first = i < half;
    const t = i / rate, f = first ? f1 : f2, local = first ? t : t - noteSec;
    const env = Math.min(1, local * 60, (noteSec - local) * 60);
    out[i] = Math.round(Math.sin(2 * Math.PI * f * t) * Math.max(0, env) * amp);
  }
  return bytesToBase64(new Uint8Array(out.buffer));
}
var APPROVAL_TONE = twoNoteTone(660, 880, 0.16, 6e3);
var WAKE_TONE = twoNoteTone(587.33, 880, 0.11, 5500);
var SLEEP_TONE = twoNoteTone(659.25, 493.88, 0.11, 3400);
var metrics = { rtt: [], reply: [], lastVoice: 0, lastPlay: 0, replied: true };
function median(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function showMetrics() {
  const parts = [];
  const rtt = median(metrics.rtt);
  if (rtt != null) parts.push(`${Math.round(rtt * 1e3)} ms`);
  const reply = median(metrics.reply);
  if (reply != null) parts.push(`reply ${metrics.reply.at(-1).toFixed(1)}s (${reply.toFixed(1)}s med)`);
  const out = audio.outputLatency;
  if (out != null) parts.push(`audio ${Math.round(out * 1e3)} ms`);
  let buffered = 0;
  for (const ws of sockets.values()) buffered += ws.bufferedAmount;
  if (buffered > 32e3) parts.push(`upload +${(buffered / 32e3).toFixed(1)}s`);
  $("metrics").textContent = parts.join(" \xB7 ");
}
async function ping() {
  const t = now();
  try {
    await fetch("/ping", { cache: "no-store" });
    metrics.rtt.push(now() - t);
    if (metrics.rtt.length > 12) metrics.rtt.shift();
  } catch {
  }
  showMetrics();
}
function applyTheme(choice) {
  const root = document.documentElement;
  if (choice === "dark" || choice === "light") root.dataset.theme = choice;
  else delete root.dataset.theme;
  const dark = choice === "dark" || choice !== "light" && matchMedia("(prefers-color-scheme: dark)").matches;
  const meta = document.getElementById("theme-color");
  if (meta) meta.setAttribute("content", dark ? "#0e0f0f" : "#f6f5f0");
  for (const btn of Array.from(document.querySelectorAll("#theme-picker button"))) {
    btn.classList.toggle("on", btn.dataset.theme === (choice || "system"));
  }
}
function setCallButton(live2) {
  const btn = $("call");
  btn.classList.toggle("live", live2);
  const label = btn.querySelector(".call-label");
  if (label) label.textContent = live2 ? "Hang up" : "Call";
}
function syncResumeButtons(show) {
  $("resume").hidden = !show;
  $("hero-resume").hidden = !show;
}
function parsePrefix(text) {
  const m = text.match(/^\/(t3|code|h|hermes)\s+(.*)$/is);
  if (!m) return { mode: null, rest: text };
  return { mode: /^(t3|code)$/i.test(m[1]) ? "t3" : "hermes", rest: m[2].trim() };
}
function syncComposer() {
  const input = $("text");
  const trimmed = input.value.trim();
  $("sendbtn").classList.toggle("ready", trimmed.length > 0);
  const parsed = parsePrefix(trimmed);
  $("mode-wrap").dataset.mode = parsed.mode ?? $("mode").value;
}
function formatClock(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor(total % 3600 / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
var VIZ_WEIGHTS = [0.48, 0.86, 1, 0.78, 0.44];
function updateVisualizer(mode, level) {
  const viz = $("viz");
  viz.dataset.mode = mode;
  const bars = viz.children;
  if (mode === "listening" || mode === "working") {
    const energy = Math.min(1, level * 14);
    for (let i = 0; i < bars.length; i++) {
      const h = 0.24 + energy * VIZ_WEIGHTS[i] * 0.76;
      bars[i].style.transform = `scaleY(${h.toFixed(2)})`;
    }
  } else {
    for (let i = 0; i < bars.length; i++) bars[i].style.transform = "";
  }
}
function notify(title, body) {
  if (!document.hidden || !("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, { body: body.slice(0, 180), icon: "/web/icons/icon-192.png", tag: title });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
  }
}
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("on");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("on"), 1800);
}
function log(kind, text, cls = "") {
  const pane = $("log");
  const row = document.createElement("div");
  row.className = `row ${cls}`;
  row.innerHTML = `<span class="t">${(now() - startedAt).toFixed(2)}</span><span class="k">${kind}</span>`;
  const body = document.createElement("span");
  body.className = "b";
  body.textContent = text;
  row.append(body);
  const stick = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 30;
  pane.append(row);
  while (pane.childElementCount > 3e3) pane.firstElementChild.remove();
  if (stick) pane.scrollTop = pane.scrollHeight;
}
function brief(data) {
  return data.replace(/"data":"[A-Za-z0-9+/=]{40,}"/g, (m) => `"data":"\u2026${Math.round((m.length - 9) * 3 / 4)} bytes"`).slice(0, 600);
}
function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function markdown(text) {
  const blocks = escapeHtml(text.trim()).split(/```(?:\w+)?\n?/);
  return blocks.map((block, i) => {
    if (i % 2 === 1) return `<pre><code>${block.replace(/\n$/, "")}</code></pre>`;
    const inline = (s) => s.replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>").replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>').replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    let html = "";
    let list = null;
    for (const raw of block.split("\n")) {
      const item = raw.match(/^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/);
      if (item) {
        const kind = item[1] ? "ol" : "ul";
        if (list !== kind) {
          if (list) html += `</${list}>`;
          html += `<${kind}>`;
          list = kind;
        }
        html += `<li>${inline(item[2])}</li>`;
        continue;
      }
      if (list) {
        html += `</${list}>`;
        list = null;
      }
      const heading = raw.match(/^#{1,6}\s+(.*)$/);
      html += heading ? `<div class="md-h">${inline(heading[1])}</div>` : raw.trim() === "" ? "<br>" : `${inline(raw)}<br>`;
    }
    if (list) html += `</${list}>`;
    return html.replace(/(<br>)+$/, "");
  }).join("");
}
var transcriptScroll = new AutoScroller($("transcript"), {
  onJumpChange: (show) => {
    $("jumpbottom").hidden = !show;
  },
  isEmpty: () => !$("empty").hidden
});
function scrollDown(force = false) {
  transcriptScroll.onContent(force);
}
var openLine = null;
function transcript(role, text, line2) {
  $("empty").hidden = true;
  const pane = $("transcript");
  const last = pane.lastElementChild;
  if (openLine === line2 && last && last.dataset.role === role) last.querySelector(".text").textContent += text;
  else {
    const row = document.createElement("div");
    row.className = `line ${role}`;
    row.dataset.role = role;
    row.innerHTML = `<span class="who">${role === "user" ? "You" : "Gemini"}</span><span class="text"></span>`;
    row.querySelector(".text").textContent = text.trimStart();
    pane.append(row);
    openLine = line2;
  }
  scrollDown();
}
function caption(text) {
  const pane = $("transcript");
  let row = document.getElementById("caption");
  if (text == null) {
    row?.remove();
    scrollDown();
    return;
  }
  $("empty").hidden = true;
  if (!row) {
    row = document.createElement("div");
    row.id = "caption";
    row.className = "line user caption";
    row.innerHTML = `<span class="who">You</span><span class="text"></span>`;
    pane.prepend(row);
  }
  row.querySelector(".text").textContent = text;
  scrollDown();
}
function note(text) {
  $("empty").hidden = true;
  const row = document.createElement("div");
  row.className = "line note";
  row.textContent = text;
  $("transcript").append(row);
  openLine = null;
  scrollDown();
}
function result(agent, label, text, failed = false) {
  $("empty").hidden = true;
  const row = document.createElement("div");
  row.className = `line result ${agent === "t3" ? "t3" : ""} ${failed ? "failed" : ""}`.trim();
  const who = agent === "t3" ? "T3" : "Hermes";
  row.innerHTML = `<div class="who"><span class="res-title"><span class="badge ${agent === "t3" ? "t3" : ""}">${who}</span><span class="res-label">${escapeHtml(label)}</span></span><span class="res-pill">${failed ? "Failed" : "Result"}</span></div><div class="body">${markdown(text)}</div>`;
  $("transcript").append(row);
  openLine = null;
  const body = row.querySelector(".body");
  requestAnimationFrame(() => {
    if (body.scrollHeight > body.clientHeight + 4) {
      row.classList.add("clamped");
      const more = document.createElement("button");
      more.className = "more";
      more.type = "button";
      more.textContent = "Show full result";
      more.onclick = () => {
        row.classList.toggle("open");
        more.textContent = row.classList.contains("open") ? "Show less" : "Show full result";
        transcriptScroll.syncFromPosition();
      };
      row.append(more);
      scrollDown();
    }
  });
  scrollDown();
  return row;
}
function elapsed(seconds) {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const m = Math.floor(seconds / 60);
  return m < 60 ? `${m}m ${Math.floor(seconds % 60)}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
var noTasks = document.getElementById("notasks");
var live = (state) => state === "running" || state.startsWith("waiting");
function updateTaskChrome() {
  const all = [...tasks.values()];
  const activeCurrent = all.filter((t) => live(t.c.state) || Boolean(t.approval)).length;
  const waiting = all.filter((t) => t.c.state.startsWith("waiting") || Boolean(t.approval)).length;
  const activeTotal = activeCurrent + earlierActiveCount;
  const attentionTotal = waiting + earlierWaitingCount;
  const badge = $("tasks-badge");
  badge.hidden = activeTotal === 0;
  badge.textContent = String(activeTotal);
  badge.classList.toggle("warn", attentionTotal > 0);
  const bar = $("mobile-tasks-bar");
  const showBar = activeTotal > 0;
  bar.hidden = !showBar;
  bar.classList.toggle("visible", showBar);
  bar.classList.toggle("warn", attentionTotal > 0);
  if (showBar) {
    const approval = all.find((t) => t.approval);
    const label = approval ? `Approval needed: ${approval.c.label}` : attentionTotal > 0 ? `${attentionTotal} task${attentionTotal > 1 ? "s" : ""} waiting for you` : `${activeTotal} active task${activeTotal > 1 ? "s" : ""}`;
    $("mtb-text").textContent = label;
  }
}
function showDone() {
  const n = $("donenow").childElementCount + $("doneearlier").childElementCount;
  $("donebox").hidden = n === 0;
  $("donecount").textContent = n > 0 ? `\xB7 ${n}` : "";
}
function showTasks(force = false) {
  const pane = $("tasks");
  const done = $("donenow");
  const open = document.activeElement?.closest?.(".task");
  if (!force && open && (pane.contains(open) || done.contains(open)) && open.querySelector("form")) return;
  pane.innerHTML = "";
  done.innerHTML = "";
  const all = [...tasks.values()].reverse();
  if (all.length === 0) {
    pane.append(noTasks);
    $("taskcount").textContent = "";
    $("cancelall").hidden = true;
    showDone();
    updateTaskChrome();
    return;
  }
  const running = all.filter((t) => t.c.state === "running").length;
  const activeCount = all.filter((t) => live(t.c.state)).length;
  $("taskcount").textContent = running > 0 ? `${running} running` : activeCount > 0 ? `${activeCount} waiting` : "";
  $("cancelall").hidden = !callId || running < 2;
  for (const view of all) {
    const t = view.c;
    const waiting = t.state.startsWith("waiting");
    const card = document.createElement("div");
    card.className = `task ${waiting ? "waiting" : t.state}`;
    const age = (view.ended ?? now()) - view.since;
    card.innerHTML = `<div class="meta-row"><span class="badge ${t.agent === "t3" ? "t3" : ""}">${t.agent === "t3" ? "T3" : "Hermes"}</span><span class="state">${t.state === "running" ? '<span class="spin"></span>' : ""}${escapeHtml(t.state)}</span><span class="age">${elapsed(age)}</span></div><div class="label"></div><div class="p"></div>`;
    card.querySelector(".label").textContent = t.label;
    card.querySelector(".p").textContent = t.progress ?? t.request;
    if (t.question) {
      const q = document.createElement("div");
      q.className = "q";
      q.textContent = `Asks: ${t.question}`;
      card.append(q);
    }
    if (view.approval && t.state === "running") {
      const box = document.createElement("div");
      box.className = "approval";
      box.innerHTML = `<div class="approval-head">Hermes asks to run</div><code></code><div class="acts"></div>`;
      box.querySelector("code").textContent = view.approval.command;
      const answer = (choice) => {
        view.approval = void 0;
        showTasks(true);
        void fetch("/hermes/approval", { method: "POST", body: JSON.stringify({ call: callName, taskId: t.id, choice }) }).then((r) => toast(r.ok ? choice === "once" ? "Approved" : "Denied" : "That approval had already lapsed"));
      };
      for (const [label, choice] of [["Approve once", "once"], ["Deny", "deny"]]) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        if (choice === "once") b.className = "go";
        else b.className = "danger";
        b.onclick = () => answer(choice);
        box.querySelector(".acts").append(b);
      }
      card.append(box);
    }
    if (t.state !== "running") view.approval = void 0;
    const acts = document.createElement("div");
    acts.className = "acts";
    const button = (text, fn, cls = "") => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      if (cls) b.className = cls;
      b.onclick = fn;
      acts.append(b);
      return b;
    };
    if (callId) {
      button(waiting ? "Answer" : "Follow up", () => followUpForm(card, t));
      if (t.state === "running") button("Cancel", () => push({ type: "cancelTask", task: t.id }), "danger");
    }
    if (view.result) button("Result", () => {
      setTasksOpen(false);
      view.result.classList.add("open");
      if (view.result !== $("transcript").lastElementChild) transcriptScroll.unpin();
      else transcriptScroll.syncFromPosition();
      view.result.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    if (view.thread) button("Copy thread id", () => {
      void navigator.clipboard?.writeText(view.thread);
      toast("Thread id copied");
    });
    if (acts.childElementCount) card.append(acts);
    (live(t.state) ? pane : done).append(card);
  }
  if (pane.childElementCount === 0) pane.append(noTasks);
  showDone();
  updateTaskChrome();
}
function followUpForm(card, t) {
  if (card.querySelector("form")) return;
  const form = document.createElement("form");
  form.innerHTML = `<input type="text" placeholder="Tell \u201C${escapeHtml(t.label)}\u201D\u2026" enterkeyhint="send"><button type="submit">Send</button>`;
  const input = form.querySelector("input");
  form.onsubmit = (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (text) {
      push({ type: "steer", task: t.id, text });
      note(`You \u2192 ${t.label}: ${text}`);
      scrollDown(true);
    }
    input.blur();
    form.remove();
    showTasks();
  };
  input.onkeydown = (e) => {
    if (e.key === "Escape") {
      input.blur();
      form.remove();
      showTasks();
    }
  };
  card.append(form);
  input.focus();
}
async function showEarlier() {
  let list = [];
  try {
    list = await (await fetch("/agent/recent", { cache: "no-store" })).json();
  } catch {
  }
  const current = new Set([...tasks.values()].map((v) => v.thread).filter(Boolean));
  list = list.filter((t) => !current.has(t.thread));
  const pane = $("earlier");
  const done = $("doneearlier");
  pane.innerHTML = "";
  done.innerHTML = "";
  earlierActiveCount = 0;
  earlierWaitingCount = 0;
  for (const t of list) {
    const card = document.createElement("div");
    const state = t.waiting ? "waiting for approval in T3" : t.status;
    card.className = `task ${t.status === "running" ? "running" : t.waiting ? "waiting" : "finished"}`;
    const ago = Math.max(0, (Date.now() - Date.parse(t.updated)) / 1e3);
    card.innerHTML = `<div class="meta-row"><span class="badge t3">T3</span><span class="state">${t.status === "running" ? '<span class="spin"></span>' : ""}${escapeHtml(state)}</span><span class="age">${elapsed(ago)} ago</span></div><div class="label"></div><div class="p"></div>`;
    card.querySelector(".label").textContent = t.title;
    card.querySelector(".p").textContent = t.last || (t.branch ? `On ${t.branch}` : "");
    const acts = document.createElement("div");
    acts.className = "acts";
    if (t.pr) {
      const a = document.createElement("a");
      a.href = t.pr;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "Pull request \u2197";
      acts.append(a);
    }
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copy thread id";
    copy.onclick = () => {
      void navigator.clipboard?.writeText(t.thread);
      toast("Thread id copied");
    };
    acts.append(copy);
    card.append(acts);
    const active = t.status === "running" || t.waiting;
    if (active) earlierActiveCount++;
    if (t.waiting) earlierWaitingCount++;
    (active ? pane : done).append(card);
  }
  $("earlierbox").hidden = pane.childElementCount === 0;
  showDone();
  updateTaskChrome();
}
var STATUS_TEXT = {
  idle: "Idle",
  connecting: "Connecting\u2026",
  listening: "Listening",
  working: "Listening \xB7 tasks running",
  dormant: "Dormant \xB7 waiting for wake word",
  standby: "Paused while tasks run \xB7 speak to resume",
  waking: "Resuming\u2026",
  ended: "Ended"
};
function showStatus(message) {
  const typed = Boolean(callId) && medium === "text";
  const speaking = Boolean(callId) && !typed && coreStatus !== "standby" && coreStatus !== "dormant" && audio.queued > 0.05;
  const armedIdle = !callId && wakeArmed;
  const shown = callId ? speaking || typed && thinking ? "speaking" : coreStatus : armedIdle ? "armed" : coreStatus;
  $("status").className = shown;
  document.body.dataset.state = callId ? shown : armedIdle ? "armed" : "idle";
  document.body.classList.toggle("in-session", Boolean(callId));
  const wakeLabel = selectedWakeModel()?.label ?? "wake word";
  let text = armedIdle ? wakeLoading ? `Loading \u201C${wakeLabel}\u201D\u2026` : `Waiting for \u201C${wakeLabel}\u201D` : speaking ? "Speaking" : coreStatus === "dormant" ? `Dormant \xB7 say \u201C${wakeLabel}\u201D` : STATUS_TEXT[coreStatus] ?? coreStatus;
  if (typed && coreStatus !== "ended") text = thinking ? "Writing\u2026" : coreStatus === "working" ? "Chat \xB7 tasks running" : "Chat";
  if (callId && !typed && muted && !holding && !speaking) text += " \xB7 muted";
  if (holding) text = "Talking (hold)";
  if (message) text = `${text}: ${message}`;
  if (coreStatus !== "ended" || message || armedIdle) $("statustext").textContent = text;
  $("hush").classList.toggle("live", speaking || typed && thinking);
  const bar = $("callbar");
  bar.hidden = !callId;
  $("wake-now").hidden = !(callId && !typed && (coreStatus === "dormant" || coreStatus === "standby"));
  if (callId) {
    $("callbar-state").textContent = text;
    $("calltimer").hidden = typed;
    if (!typed) $("calltimer").textContent = formatClock(now() - startedAt);
    const vizMode = typed ? thinking ? "thinking" : "idle" : speaking ? "speaking" : muted && !holding ? "muted" : shown;
    updateVisualizer(vizMode, muted && !holding ? 0 : audio.level);
  }
}
function push(event) {
  if (!core || !callId) return;
  const e = { ...event, t: now() };
  const quiet = e.type === "mic" || e.type === "tick";
  if (!quiet) log("in", e.type === "ws.message" ? `ws ${e.sid} \u2190 ${brief(String(e.data))}` : JSON.stringify(e).slice(0, 400), "in");
  run2(JSON.parse(core.push(callId, JSON.stringify(e))));
}
function run2(commands) {
  for (const c of commands) {
    switch (c.type) {
      case "ws.connect":
        connect(c.sid, c.purpose === "captions");
        break;
      case "ws.send": {
        sockets.get(c.sid)?.send(c.data);
        if (!c.data.startsWith('{"realtimeInput":{"audio"')) log("out", `ws ${c.sid} \u2192 ${brief(c.data)}`, "out");
        else if (!captionSockets.has(c.sid)) counts.sent++;
        break;
      }
      case "ws.close":
        sockets.get(c.sid)?.close();
        sockets.delete(c.sid);
        log("out", `ws ${c.sid} close`, "out");
        break;
      case "mic.start": {
        log("out", c.type, "out");
        const pendingOpening = wakeStarting ? openingChunks.splice(0) : [];
        openingBytes = 0;
        wakeStarting = false;
        void audio.ensureMic(onMic, micOptions()).catch((err) => {
          log("error", `microphone: ${err.message}`, "err");
          toast(`Microphone: ${err.message}`);
        });
        if (pendingOpening.length > 0) {
          const totalMs = Math.round(pendingOpening.reduce((s, b) => s + b.byteLength, 0) / 32);
          log("out", `flushing ${totalMs} ms spoken after wake word`, "out");
          queueMicrotask(() => {
            if (!callId) return;
            for (const chunk of pendingOpening) {
              if (!callId) break;
              counts.mic++;
              push({ type: "mic", pcm: bytesToBase64(chunk) });
            }
          });
        }
        break;
      }
      case "mic.restart":
        log("out", c.type, "out");
        void audio.startMic(onMic, micOptions()).catch((err) => {
          log("error", `microphone: ${err.message}`, "err");
          toast(`Microphone: ${err.message}`);
        });
        break;
      case "mic.stop":
        if (!wakeArmed) audio.stopMic();
        break;
      case "play": {
        const t = now();
        if (!metrics.replied && audio.queued < 0.05 && t - metrics.lastPlay > 0.6 && metrics.lastVoice > 0 && t - metrics.lastVoice < 10) {
          metrics.reply.push(t - metrics.lastVoice);
          if (metrics.reply.length > 20) metrics.reply.shift();
          metrics.replied = true;
          showMetrics();
        }
        metrics.lastPlay = t;
        audio.play(c.pcm);
        counts.play++;
        break;
      }
      case "flush":
        audio.flush();
        log("out", "flush", "out");
        break;
      case "cue":
        audio.cue(c.pcm);
        log("out", `cue ${c.earcon}`, "out");
        if (c.earcon === "taskStarted") metrics.replied = true;
        break;
      case "wakeword":
        ensureCoreWake(Boolean(c.on));
        break;
      case "tool.call":
        void tool(c);
        break;
      case "tool.cancel":
        cancelRun(c.run, c.reason);
        break;
      case "tool.steer":
        void steerRun(c);
        break;
      case "status": {
        const prev = coreStatus;
        coreStatus = c.status;
        if (c.status === "dormant" && prev !== "dormant" && checked("wake-cue")) audio.cue(SLEEP_TONE);
        showStatus(c.status === "ended" ? c.message ?? void 0 : void 0);
        log("status", c.status + (c.message ? `: ${c.message}` : ""), "status");
        if (c.status === "ended") {
          if (c.message) note(c.message);
          end();
        }
        break;
      }
      case "llm.request":
        void generate(c.id, c.body);
        break;
      case "llm.cancel":
        requests.get(c.id)?.abort();
        requests.delete(c.id);
        log("out", `request ${c.id} dropped`, "out");
        break;
      case "thinking":
        thinking = c.on;
        showStatus();
        break;
      case "error":
        note(c.message);
        log("error", c.message, "err");
        break;
      case "caption":
        caption(c.text);
        break;
      case "transcript":
        transcript(c.role, c.text, c.line);
        remember(c.role, c.text, c.role === "assistant" ? "Gemini" : void 0, lastLine === c.line);
        lastLine = c.line;
        break;
      case "task": {
        const view = tasks.get(c.id) ?? { c, since: now(), ended: null };
        if (c.state === "running" && view.c.state !== "running") {
          view.since = now();
          view.ended = null;
        }
        if (c.state !== "running" && view.ended == null) view.ended = now();
        view.c = c;
        tasks.set(c.id, view);
        showTasks();
        break;
      }
      case "questions":
        break;
      case "micSilent":
        $("micwarn").hidden = !c.silent;
        break;
      case "voiceCommand":
        toast(`Heard \u201C${c.heard}\u201D: ${c.command === "stop" ? "stopped" : c.command === "cancelAll" ? "cancelling every task" : "hanging up"}`);
        log("out", `voice command ${c.command}: ${c.heard}`, "out");
        break;
      case "log":
        log(c.level, c.message, c.level === "warn" ? "warn" : "");
        break;
      default:
        log("out", JSON.stringify(c).slice(0, 300), "out");
    }
  }
}
function onMic(samples, level) {
  if (shouldFeedWake()) wakeClient.feed(samples);
  if (wakeStarting) {
    const copy = new Uint8Array(samples.byteLength);
    copy.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
    openingChunks.push(copy);
    openingBytes += copy.byteLength;
    while (openingBytes > OPENING_MAX_BYTES && openingChunks.length > 1) {
      openingBytes -= openingChunks.shift().byteLength;
    }
    return;
  }
  if (!callId || medium !== "voice") return;
  counts.mic++;
  if (level > 0.03 && !(muted && !holding)) {
    metrics.lastVoice = now();
    if (audio.queued < 0.05) metrics.replied = false;
  }
  push({ type: "mic", pcm: bytesToBase64(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)) });
}
function connect(sid, captions) {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/live${captions ? "?for=captions" : ""}`);
  sockets.set(sid, ws);
  if (captions) captionSockets.add(sid);
  log("out", `ws ${sid} connect (${server.route}${captions ? ", captions" : ""})`, "out");
  ws.onopen = () => push({ type: "ws.open", sid });
  ws.onmessage = (m) => push({ type: "ws.message", sid, data: typeof m.data === "string" ? m.data : "" });
  ws.onclose = (e) => {
    if (sockets.get(sid) !== ws && sockets.has(sid)) return;
    const httpStatus = e.code >= 4100 && e.code < 4600 ? e.code - 4e3 : void 0;
    push({ type: "ws.closed", sid, code: httpStatus ? void 0 : e.code, reason: e.reason, httpStatus });
  };
}
async function generate(id, body) {
  const abort = new AbortController();
  requests.set(id, abort);
  log("out", `request ${id} \u2192 ${server.textModel} (${Math.round(body.length / 1024)} KB)`, "out");
  try {
    const response = await fetch("/generate", { method: "POST", signal: abort.signal, headers: { "content-type": "application/json" }, body });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      push({ type: "llm.end", id, status: response.status, error: `HTTP ${response.status}${text ? ": " + text.replace(/\s+/g, " ").slice(0, 200) : ""}` });
      return;
    }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (; ; ) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let cut;
      while ((cut = buffer.indexOf("\n")) >= 0) {
        const line2 = buffer.slice(0, cut).replace(/\r$/, "");
        buffer = buffer.slice(cut + 1);
        if (line2.startsWith("data:")) push({ type: "llm.data", id, data: line2.slice(5).trim() });
      }
    }
    push({ type: "llm.end", id });
  } catch (err) {
    if (!abort.signal.aborted) push({ type: "llm.end", id, error: err.message });
  } finally {
    requests.delete(id);
  }
}
function cancelRun(key, reason) {
  const r = runs.get(key);
  log("out", `cancel ${key} (${reason})`, "out");
  if (!r) return;
  runs.delete(key);
  r.abort.abort();
  if (reason === "cancelled" && !checked("fakehermes")) {
    void fetch(r.agent === "t3" ? "/agent/cancel" : "/hermes/stop", { method: "POST", body: JSON.stringify({ call: callName, taskId: r.taskId }) });
  }
}
async function steerRun(c) {
  const r = runs.get(c.run);
  log("out", `steer ${c.run}: ${c.text}`, "out");
  if (checked("fakehermes")) return;
  const ok = r != null && await fetch(c.agent === "t3" ? "/agent/steer" : "/hermes/steer", { method: "POST", body: JSON.stringify({ call: callName, taskId: r.taskId, text: c.message }) }).then((x) => x.ok, () => false);
  if (!ok) push({ type: "tool.steerFailed", run: c.run, text: c.text });
  else toast(`${c.agent === "t3" ? "The coding agent" : "Hermes"} took the follow-up while it works`);
}
async function tool(c) {
  if (c.kind === "host") {
    log("out", `host tool ${c.name} ${JSON.stringify(c.args)}`, "out");
    const answer = c.name === "tv_volume" ? `The TV is at ${fakeTvLevel = Number(c.args?.level ?? fakeTvLevel)}.` : c.name === "tv_pause" ? c.args?.pause === false ? "Playing." : "Paused." : "Done.";
    setTimeout(() => push({ type: "tool.result", run: c.run, text: answer }), 300);
    return;
  }
  const agent = c.agent === "t3" ? "t3" : "hermes";
  log("out", `${agent} ${c.followUp ? "follow-up" : "task"} "${c.label}"${c.project ? ` in ${c.project}` : ""}: ${c.request}`, "out");
  const abort = new AbortController();
  runs.set(c.run, { abort, agent, taskId: c.taskId });
  const done = (text, failed = false) => {
    if (!runs.has(c.run)) return;
    runs.delete(c.run);
    const view = tasks.get(c.taskId);
    const row = result(agent, c.label, text, failed);
    notify(`${agent === "t3" ? "T3" : "Hermes"} \xB7 ${c.label}`, text);
    if (!failed) {
      remember("assistant", text, `${agent === "t3" ? "T3" : "Hermes"} \xB7 ${c.label}`);
      lastLine = null;
    }
    if (view) {
      view.result = row;
      showTasks();
    }
    push({ type: "tool.result", run: c.run, text, failed });
  };
  if (checked("fakehermes")) {
    const timer = setTimeout(() => done(`(Fake ${agent === "t3" ? "T3" : "Hermes"}) Done: \u201C${c.request}\u201D. Nothing was actually run.`), Number($("fakedelay").value) * 1e3);
    abort.signal.onabort = () => clearTimeout(timer);
    return;
  }
  try {
    const response = await fetch(agent === "t3" ? "/agent" : "/hermes", {
      method: "POST",
      signal: abort.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ call: callName, taskId: c.taskId, followUp: c.followUp, message: c.message, label: c.label, request: c.request, project: c.project, approvals: "screen" })
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (; ; ) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      buffer += value;
      let cut;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const event = block.match(/^event: (.*)$/m)?.[1];
        if (!event) continue;
        const data = JSON.parse(block.match(/^data: (.*)$/m)?.[1] ?? "{}");
        if (event === "progress") push({ type: "task.progress", task: c.taskId, text: data.text });
        else if (event === "thread") {
          const view = tasks.get(c.taskId);
          if (view) {
            view.thread = data.thread;
            showTasks();
          }
        } else if (event === "approval") {
          const view = tasks.get(c.taskId);
          if (view) {
            view.approval = { command: data.command };
            showTasks(true);
          }
          toast(`Hermes asks to run: ${data.command.slice(0, 80)}`);
          notify(`Hermes \xB7 ${c.label} needs your approval`, data.command);
          audio.cue(APPROVAL_TONE);
        } else if (event === "result") done(data.text, data.failed);
        else if (event === "error") {
          runs.delete(c.run);
          push({ type: "tool.error", run: c.run, message: data.message });
        }
      }
    }
    if (runs.has(c.run)) {
      runs.delete(c.run);
      push({ type: "tool.error", run: c.run, message: "the server closed the stream without a result" });
    }
  } catch (err) {
    if (!abort.signal.aborted && runs.has(c.run)) {
      runs.delete(c.run);
      push({ type: "tool.error", run: c.run, message: err.message });
    }
  }
}
function micOptions() {
  const aec = checked("aec");
  return { echoCancellation: aec, noiseSuppression: aec, autoGainControl: aec };
}
function numberSetting(id, fallback, min = 0, max = 3600) {
  const n = Number($(id).value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function readConfig() {
  const given = JSON.parse($("config").value);
  const config = {
    model: server.model,
    api: server.route === "vertex" ? "vertex" : "gemini",
    today: (/* @__PURE__ */ new Date()).toISOString().slice(0, 10),
    ...given,
    trace: checked("trace")
  };
  if (checked("ptt")) config.muted = true;
  if (given.voice === void 0) config.voice = $("voice").value;
  if (config.steering === void 0) config.steering = ["hermes", "t3"];
  if (config.handOff === void 0 && config.platform === "web") config.handOff = "named";
  if (config.supervise === void 0 && config.platform === "web") config.supervise = true;
  if (checked("coding") && (server.t3 || checked("fakehermes")) && config.codingAgent === void 0) config.codingAgent = { projects: server.t3 ?? [] };
  if (checked("captions") && server.captionsModel && config.captions === void 0) config.captions = { model: server.captionsModel };
  const customJson = localStorage.getItem("voice-core.config") != null;
  const presetName = $("preset").value;
  const signaling = $("signaling").value;
  if (!customJson && presetName === "web") {
    config.hangUpAfter = numberSetting("hangup-after", signaling === "echo" ? 15 : 300, 0, 3600);
    if (signaling === "window" || signaling === "echo") {
      config.attention = {
        mode: "window",
        afterWake: numberSetting("attn-after-wake", 8, 1, 60),
        window: numberSetting("attn-window", 5, 0, 60),
        afterQuestion: numberSetting("attn-after-question", 10, 0, 60),
        afterHandOff: 3,
        afterAnnouncement: 0
      };
      if (signaling === "echo") config.standbyAfter = 8;
    }
    if (checked("wake-barge") || signaling === "echo") {
      const mic = config.mic && typeof config.mic === "object" ? config.mic : {};
      config.mic = { gainDb: 0, ...mic, whileSpeaking: "wake" };
    }
  } else if (given.attention === void 0 && (signaling === "window" || signaling === "echo")) {
    config.attention = {
      mode: "window",
      afterWake: numberSetting("attn-after-wake", 8, 1, 60),
      window: numberSetting("attn-window", 5, 0, 60),
      afterQuestion: numberSetting("attn-after-question", 10, 0, 60),
      afterHandOff: 3,
      afterAnnouncement: 0
    };
  }
  return config;
}
async function start(carryOn = false, typed = false) {
  await ending;
  if (callId) return;
  let given;
  try {
    given = readConfig();
  } catch (err) {
    toast(`The developer settings aren't valid JSON: ${err.message}`);
    return;
  }
  if (typed) {
    if (!server.textModel) {
      toast("This server has no text model for a chat: start a call to type to it");
      return;
    }
    given = { ...given, medium: "text", muted: false };
    delete given.captions;
    if (wakeArmed) audio.stopMic();
  }
  $("call").disabled = true;
  $("hero-call").disabled = true;
  if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission().catch(() => {
  });
  try {
    if (!typed) await audio.open();
    core = await loadCore();
  } finally {
    $("call").disabled = false;
    $("hero-call").disabled = false;
  }
  if (callId) return;
  medium = typed ? "text" : "voice";
  thinking = false;
  $("version").textContent = core.version;
  $("log").innerHTML = "";
  if (!typed && (tasks.size > 0 || $("transcript").childElementCount > 1)) note(`New call \xB7 ${(/* @__PURE__ */ new Date()).toLocaleTimeString()}`);
  scrollDown(true);
  tasks.clear();
  showTasks();
  counts = { mic: 0, play: 0, sent: 0 };
  metrics.reply = [];
  startedAt = now();
  muted = given.muted === true;
  if (typed) {
    if (chat.length > 0 && given.history === void 0) given.history = chat;
  } else if (carryOn && given.history === void 0) given.history = savedHistory();
  else if (!carryOn) chat = [];
  if (carryOn && !typed) chat = savedHistory();
  lastLine = null;
  openLine = null;
  syncResumeButtons(false);
  callName = `${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}-${typed ? "chat" : "web"}-${core.version}`;
  const created = JSON.parse(core.create(JSON.stringify(given), now()));
  callId = created.id;
  if (!typed) {
    setCallButton(true);
    $("mic").disabled = false;
  }
  $("hush").disabled = false;
  $("mic").classList.toggle("muted", muted);
  run2(created.commands);
  showStatus();
  ticker = window.setInterval(() => {
    push({ type: "tick" });
    const level = muted && !holding ? 0 : audio.level;
    const strength = Math.min(1, level * 12);
    $("ring").style.opacity = String(strength);
    $("ring").style.transform = `scale(${(1 + strength * 0.12).toFixed(3)})`;
    $("counts").textContent = `mic ${counts.mic} \xB7 sent ${counts.sent} \xB7 played ${counts.play} \xB7 queued ${audio.queued.toFixed(1)} s`;
    showStatus();
  }, 100);
  traceTimer = window.setInterval(() => {
    void saveTrace();
    void ping();
    showTasks();
  }, 5e3);
  void ping();
  if (typed) return;
  stopWords.start();
  await acquireWakeLock();
}
async function callButton() {
  if (callId && medium === "voice") {
    hangUp();
    return;
  }
  if (callId) {
    if ([...tasks.values()].some((v) => v.c.state === "running")) {
      toast("The chat's tasks are still running: wait for them or cancel them, then call");
      return;
    }
    push({ type: "stop" });
    await start(true);
    return;
  }
  await start();
}
function hangUp() {
  if (callId) push({ type: "stop", message: "You hung up." });
}
function end() {
  window.clearInterval(ticker);
  window.clearInterval(traceTimer);
  stopWords.stop();
  coreWantsWake = false;
  wakeStarting = false;
  openingChunks = [];
  openingBytes = 0;
  const finishedId = callId;
  const finishedCore = core;
  callId = 0;
  ending = saveTrace(finishedId, finishedCore).then(() => {
    if (finishedCore && finishedId) finishedCore.dispose(finishedId);
    showTasks();
    syncWakeUi();
  });
  if (wakeArmed) {
    audio.stopPlayback();
    wakeClient.reset();
    void audio.ensureMic(onMic, micOptions()).catch((err) => {
      log("error", `wake microphone: ${err.message}`, "err");
      toast(`Wake microphone: ${err.message}`);
      void armWake(false);
    });
  } else {
    audio.stop();
    releaseWakeLock();
  }
  for (const ws of sockets.values()) ws.close();
  sockets.clear();
  for (const r of runs.values()) r.abort.abort();
  runs.clear();
  for (const r of requests.values()) r.abort();
  requests.clear();
  thinking = false;
  setCallButton(false);
  for (const id of ["mic", "hush"]) $(id).disabled = true;
  $("ring").style.opacity = "0";
  $("ring").style.transform = "";
  $("callbar").hidden = true;
  $("micwarn").hidden = true;
  document.body.dataset.state = wakeArmed ? "armed" : "idle";
  document.body.classList.remove("in-session");
  syncResumeButtons(chat.length > 0);
  void showEarlier();
  syncWakeUi();
}
function setMuted(value) {
  if (!callId || muted === value) return;
  muted = value;
  $("mic").classList.toggle("muted", muted);
  push({ type: muted ? "mute" : "unmute" });
  showStatus();
}
async function saveTrace(id = callId, targetCore = core) {
  if (!targetCore || !id || !checked("trace")) return;
  const kept = JSON.parse(targetCore.trace(id));
  if (!kept) return;
  const lines = [];
  if (kept.config) lines.push(JSON.stringify({ version: kept.version, config: kept.config, start: kept.start }));
  for (const e of kept.events) lines.push(JSON.stringify(e));
  if (lines.length === 0) return;
  await fetch(`/traces?name=${encodeURIComponent(callName)}.jsonl`, { method: "POST", body: lines.join("\n") + "\n" }).catch(() => {
  });
  $("tracename").textContent = `trace ${callName}.jsonl`;
}
var StopWords = class {
  constructor() {
    this.rec = null;
    this.on = false;
    this.commands = { stop: [], hangUp: [], cancelAll: [] };
  }
  get supported() {
    return "webkitSpeechRecognition" in window || "SpeechRecognition" in window;
  }
  start() {
    if (!checked("stopword") || !this.supported || !core) return;
    this.commands = JSON.parse(core.defaults()).voiceCommands;
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    this.rec = new Recognition();
    this.rec.continuous = true;
    this.rec.interimResults = true;
    this.rec.lang = navigator.language || "en-GB";
    this.rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const text = e.results[i][0].transcript;
        const command = commandIn(text, this.commands, ["Woodhouse", "Hermes", "Bento"]);
        if (command === "stop" && audio.queued > 0.05) {
          log("out", `local stop word: ${text}`, "out");
          toast(`Heard \u201C${text.trim()}\u201D: stopped`);
          push({ type: "interrupt" });
        } else if (command === "cancelAll" && e.results[i].isFinal) {
          log("out", `local cancel-all: ${text}`, "out");
          push({ type: "cancelAll" });
          push({ type: "interrupt" });
        } else if (command === "hangUp" && e.results[i].isFinal) {
          log("out", `local hang-up: ${text}`, "out");
          hangUp();
        }
      }
    };
    this.rec.onend = () => {
      if (this.on) setTimeout(() => {
        try {
          this.rec?.start();
        } catch {
        }
      }, 250);
    };
    this.rec.onerror = (e) => {
      if (e.error === "not-allowed") this.on = false;
    };
    this.on = true;
    try {
      this.rec.start();
    } catch {
    }
  }
  stop() {
    this.on = false;
    try {
      this.rec?.stop();
    } catch {
    }
    this.rec = null;
  }
};
var stopWords = new StopWords();
async function acquireWakeLock() {
  if (wakeLock || document.hidden) return;
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
  } catch {
  }
}
function releaseWakeLock() {
  void wakeLock?.release().catch(() => {
  });
  wakeLock = null;
}
function selectedWakeModel() {
  const models = server?.wakeModels ?? [];
  if (models.length === 0) return null;
  const pick = $("wake-model").value;
  return models.find((m) => m.id === pick) ?? models.find((m) => m.id === "pennyworth") ?? models[0];
}
function wakeThreshold() {
  const n = Number($("wake-threshold").value);
  return Number.isFinite(n) ? Math.max(0.1, Math.min(0.99, n)) : 0.7;
}
function shouldFeedWake() {
  if (wakeStarting) return false;
  if (callId === 0) return wakeArmed;
  return medium === "voice" && coreWantsWake && !(muted && !holding);
}
function renderWakeTelemetry() {
  const active = callId === 0 && wakeArmed || callId !== 0 && medium === "voice" && coreWantsWake;
  if (!active) {
    $("heard").textContent = "";
    return;
  }
  const label = selectedWakeModel()?.label ?? "wake word";
  if (wakeLoading) {
    $("heard").textContent = `Loading wake word \u201C${label}\u201D\u2026`;
    return;
  }
  if (!wakeLastTel) {
    $("heard").textContent = `Wake \u201C${label}\u201D ready (threshold ${wakeThreshold().toFixed(2)})`;
    return;
  }
  const state = wakeLastTel.gateOpen ? `scoring ${wakeLastTel.score.toFixed(2)}` : "quiet";
  const speed = wakeLastTel.inferMs > 0 ? ` \xB7 ${wakeLastTel.inferMs.toFixed(1)} ms` : "";
  $("heard").textContent = `Wake \u201C${label}\u201D \xB7 ${state} \xB7 peak ${wakeLastTel.peak.toFixed(2)}${speed}`;
}
function syncWakeUi() {
  const model = selectedWakeModel();
  const hasModels = model != null;
  const label = model?.label ?? "wake word";
  const btn = $("wakebtn");
  btn.hidden = !hasModels;
  btn.classList.toggle("on", wakeArmed);
  btn.classList.toggle("loading", wakeLoading && (wakeArmed || coreWantsWake));
  btn.setAttribute("aria-pressed", String(wakeArmed));
  btn.title = wakeArmed ? `Stop wake word \u201C${label}\u201D (W)` : `Listen for \u201C${label}\u201D (W)`;
  const hero = $("hero-wake");
  hero.hidden = !hasModels;
  hero.classList.toggle("on", wakeArmed);
  hero.textContent = wakeArmed ? wakeLoading ? `Loading \u201C${label}\u201D\u2026` : `Listening for \u201C${label}\u201D` : `Listen for \u201C${label}\u201D`;
  $("wake-enabled").checked = wakeArmed;
  renderWakeTelemetry();
  showStatus();
}
function syncSignalingUi() {
  const signaling = $("signaling").value;
  const customJson = localStorage.getItem("voice-core.config") != null;
  const isWeb = $("preset").value === "web";
  const windowControls = signaling === "window" || signaling === "echo";
  for (const id of ["attn-after-wake", "attn-window", "attn-after-question"]) {
    $(id).disabled = !windowControls;
  }
  const barge = $("wake-barge");
  if (signaling === "echo" && !customJson && isWeb) {
    barge.checked = true;
    barge.disabled = true;
  } else {
    barge.disabled = false;
    barge.checked = localStorage.getItem("voice.wake-barge") === "1";
  }
}
var wakeClient = new WakeClient({
  onReady(modelId, warmupMs) {
    wakeLoading = false;
    log("out", `wake word ready: ${modelId}${warmupMs > 0 ? ` (${warmupMs} ms)` : ""}`, "out");
    syncWakeUi();
  },
  onDetected(hit) {
    onWakeDetected(hit);
  },
  onTelemetry(tel) {
    wakeLastTel = tel;
    renderWakeTelemetry();
  },
  onError(message) {
    wakeLoading = false;
    log("error", `wake word: ${message}`, "err");
    toast(`Wake word error: ${message}`);
    if (wakeArmed) void armWake(false);
    else syncWakeUi();
  }
});
async function armWake(on, persist = true) {
  const model = selectedWakeModel();
  if (on && !model) {
    toast("No wake word models found on the server");
    $("wake-enabled").checked = false;
    return;
  }
  wakeArmed = on;
  if (persist) localStorage.setItem("voice.wake-enabled", on ? "1" : "0");
  if (on && model) {
    wakeLastTel = null;
    if (!wakeClient.ready || wakeClient.modelId !== model.id) wakeLoading = true;
    wakeClient.load(model.id, wakeThreshold());
    if (!callId) {
      try {
        await audio.ensureMic(onMic, micOptions());
        wakeClient.reset();
        await acquireWakeLock();
      } catch (err) {
        wakeArmed = false;
        wakeLoading = false;
        if (persist) localStorage.setItem("voice.wake-enabled", "0");
        toast(`Microphone: ${err.message}`);
        log("error", `wake microphone: ${err.message}`, "err");
      }
    }
  } else {
    wakeLoading = false;
    wakeLastTel = null;
    if (!callId) {
      audio.stopMic();
      releaseWakeLock();
      wakeClient.reset();
    }
  }
  syncWakeUi();
}
function ensureCoreWake(on) {
  coreWantsWake = on;
  const model = selectedWakeModel();
  if (on) {
    if (!model) {
      log("warn", "core asked for wake word, but no models are available", "warn");
    } else {
      wakeLastTel = null;
      if (!wakeClient.ready || wakeClient.modelId !== model.id) wakeLoading = true;
      wakeClient.load(model.id, wakeThreshold());
      wakeClient.reset();
      log("out", `wake word listening (${model.label})`, "out");
    }
  } else {
    if (!wakeArmed) wakeLastTel = null;
    log("out", "wake word off", "out");
  }
  syncWakeUi();
}
function onWakeDetected(hit) {
  if (!shouldFeedWake()) return;
  const label = selectedWakeModel()?.label ?? "wake word";
  log("out", `wake detected \u201C${label}\u201D (score ${hit.score.toFixed(2)}, ${hit.inferMs.toFixed(1)} ms)`, "out");
  if (checked("wake-cue")) void audio.open().then(() => audio.cue(WAKE_TONE)).catch(() => {
  });
  toast(`Heard \u201C${label}\u201D (${hit.score.toFixed(2)})`);
  if (callId !== 0) {
    push({ type: "wake" });
    return;
  }
  wakeStarting = true;
  openingChunks = [];
  openingBytes = 0;
  if (hit.rest.byteLength > 0) {
    openingChunks.push(hit.rest);
    openingBytes = hit.rest.byteLength;
  }
  void start(chat.length > 0).then(() => {
    if (!callId && wakeStarting) {
      wakeStarting = false;
      openingChunks = [];
      openingBytes = 0;
      syncWakeUi();
    }
  }).catch((err) => {
    wakeStarting = false;
    openingChunks = [];
    openingBytes = 0;
    toast(err.message);
    log("error", err.message, "err");
    syncWakeUi();
  });
}
function settingsFromStorage() {
  for (const id of ["aec", "stopword", "ptt", "captions", "coding", "fakehermes", "trace", "wake-cue", "wake-barge"]) {
    const v = localStorage.getItem(`voice.${id}`);
    if (v != null) $(id).checked = v === "1";
    $(id).addEventListener("change", () => {
      localStorage.setItem(`voice.${id}`, checked(id) ? "1" : "0");
      if (id === "aec" && wakeArmed && !callId) {
        void audio.startMic(onMic, micOptions()).catch((err) => toast(`Microphone: ${err.message}`));
      }
    });
  }
  for (const [id, key] of [
    ["fakedelay", "voice.fakedelay"],
    ["attn-after-wake", "voice.attn-after-wake"],
    ["attn-window", "voice.attn-window"],
    ["attn-after-question", "voice.attn-after-question"],
    ["hangup-after", "voice.hangup-after"]
  ]) {
    const saved = localStorage.getItem(key);
    if (saved != null) $(id).value = saved;
    $(id).addEventListener("change", () => localStorage.setItem(key, $(id).value));
  }
  const thresh = localStorage.getItem("voice.wake-threshold");
  if (thresh != null) $("wake-threshold").value = thresh;
  $("wake-threshold-val").textContent = wakeThreshold().toFixed(2);
  $("wake-threshold").addEventListener("input", () => {
    const v = wakeThreshold();
    $("wake-threshold-val").textContent = v.toFixed(2);
    localStorage.setItem("voice.wake-threshold", v.toFixed(2));
    wakeClient.setThreshold(v);
    renderWakeTelemetry();
  });
  const signaling = localStorage.getItem("voice.signaling");
  if (signaling) $("signaling").value = signaling;
  $("signaling").addEventListener("change", () => {
    const mode2 = $("signaling").value;
    localStorage.setItem("voice.signaling", mode2);
    const def = mode2 === "echo" ? "15" : "300";
    $("hangup-after").value = def;
    localStorage.setItem("voice.hangup-after", def);
    syncSignalingUi();
  });
  $("wake-enabled").addEventListener("change", () => void armWake(checked("wake-enabled")));
  $("wake-model").addEventListener("change", () => {
    const id = $("wake-model").value;
    localStorage.setItem("voice.wake-model", id);
    if (wakeArmed || coreWantsWake) {
      wakeLoading = true;
      wakeLastTel = null;
      wakeClient.load(id, wakeThreshold());
      syncWakeUi();
    } else {
      syncWakeUi();
    }
  });
  const voice = localStorage.getItem("voice.voice");
  if (voice) $("voice").value = voice;
  $("voice").addEventListener("change", () => localStorage.setItem("voice.voice", $("voice").value));
  const mode = localStorage.getItem("voice.mode");
  if (mode) $("mode").value = mode;
  $("mode").addEventListener("change", () => {
    localStorage.setItem("voice.mode", $("mode").value);
    syncComposer();
  });
  const theme = localStorage.getItem("voice.theme") ?? "system";
  applyTheme(theme);
  for (const btn of Array.from(document.querySelectorAll("#theme-picker button"))) {
    btn.onclick = () => {
      const choice = btn.dataset.theme ?? "system";
      localStorage.setItem("voice.theme", choice);
      applyTheme(choice);
    };
  }
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if ((localStorage.getItem("voice.theme") ?? "system") === "system") applyTheme("system");
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && (callId || wakeArmed)) void acquireWakeLock();
  });
  syncSignalingUi();
}
var mobileLayout = matchMedia("(max-width: 920px)");
var drawerOpener = null;
function setTasksOpen(open, opener) {
  const canOpen = mobileLayout.matches && !$("talk").hidden;
  const next = open && canOpen;
  const wasOpen = document.body.classList.contains("tasks-open");
  document.body.classList.toggle("tasks-open", next);
  const header = document.querySelector("header");
  if (header) header.inert = next;
  $("convo").inert = next;
  $("side").inert = mobileLayout.matches && !next;
  $("tasks-toggle").setAttribute("aria-expanded", String(next));
  $("mobile-tasks-bar").setAttribute("aria-expanded", String(next));
  if (next && !wasOpen) {
    drawerOpener = opener ?? document.activeElement;
    $("tasks-close").focus();
  } else if (!next && wasOpen) {
    const target = drawerOpener;
    drawerOpener = null;
    if (target && target.isConnected && !target.hidden && target.offsetParent !== null) target.focus();
  }
}
function tabs() {
  const views = { talk: $("talk"), dev: $("dev"), replay: $("replaymain") };
  for (const name of Object.keys(views)) {
    $(`tab-${name}`).onclick = () => {
      for (const [other, el] of Object.entries(views)) {
        el.hidden = other !== name;
        $(`tab-${other}`).classList.toggle("on", other === name);
      }
      $("tasks-toggle").hidden = name !== "talk";
      setTasksOpen(false);
    };
  }
  $("gear").onclick = () => {
    $("settings").hidden = false;
  };
  $("closesettings").onclick = () => {
    $("settings").hidden = true;
  };
  $("closesettings-x").onclick = () => {
    $("settings").hidden = true;
  };
  $("settings").onclick = (e) => {
    if (e.target === $("settings")) $("settings").hidden = true;
  };
  $("tasks-toggle").onclick = () => setTasksOpen(!document.body.classList.contains("tasks-open"), $("tasks-toggle"));
  $("mobile-tasks-bar").onclick = () => setTasksOpen(true, $("mobile-tasks-bar"));
  $("tasks-close").onclick = () => setTasksOpen(false);
  $("side-backdrop").onclick = () => setTasksOpen(false);
  mobileLayout.addEventListener("change", () => setTasksOpen(false));
  setTasksOpen(false);
}
function typing() {
  const el = document.activeElement;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}
function keys() {
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("settings").hidden) {
        $("settings").hidden = true;
        return;
      }
      if (document.body.classList.contains("tasks-open") && mobileLayout.matches && !$("talk").hidden) {
        setTasksOpen(false);
        return;
      }
      if (callId) {
        push({ type: "interrupt" });
        audio.flush();
        return;
      }
      return;
    }
    if (typing() || !$("settings").hidden || document.body.classList.contains("tasks-open") || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "m" || e.key === "M") {
      setMuted(!muted);
      e.preventDefault();
    } else if (e.key === "w" || e.key === "W") {
      void armWake(!wakeArmed);
      e.preventDefault();
    } else if (e.key === "/") {
      $("text").focus();
      e.preventDefault();
    } else if (e.code === "Space" && callId && muted && !e.repeat) {
      holding = true;
      push({ type: "unmute" });
      showStatus();
      e.preventDefault();
    }
  });
  document.addEventListener("keyup", (e) => {
    if (e.code === "Space" && holding) {
      holding = false;
      push({ type: "mute" });
      showStatus();
    }
  });
}
async function submitText(e) {
  e.preventDefault();
  const input = $("text");
  let text = input.value.trim();
  if (!text) return;
  if (!callId) {
    input.value = "";
    syncComposer();
    try {
      await start(false, true);
    } catch (err) {
      toast(err.message);
      log("error", err.message, "err");
    }
    if (!callId) {
      input.value = text;
      syncComposer();
      return;
    }
  }
  const parsed = parsePrefix(text);
  const mode = parsed.mode ?? $("mode").value;
  text = parsed.rest;
  if (!text) return;
  if (mode === "say") {
    push({ type: "say", text });
    scrollDown(true);
  } else {
    push({ type: "ask", text, agent: mode });
    note(`You \u2192 new ${mode === "t3" ? "coding" : "Hermes"} task: ${text}`);
    scrollDown(true);
  }
  input.value = "";
  syncComposer();
}
async function main() {
  applyTheme(localStorage.getItem("voice.theme") ?? "system");
  server = await (await fetch("/config")).json();
  $("route").textContent = `${server.route === "vertex" ? "Vertex" : "Gemini API"} \xB7 ${server.model.split("/").pop()}`;
  $("version").textContent = server.version;
  $("build").textContent = `core ${server.version}`;
  settingsFromStorage();
  const wakeSelect = $("wake-model");
  const wakeList = server.wakeModels ?? [];
  for (const m of wakeList) wakeSelect.add(new Option(m.label, m.id));
  const savedWakeModel = localStorage.getItem("voice.wake-model");
  if (savedWakeModel && wakeList.some((m) => m.id === savedWakeModel)) wakeSelect.value = savedWakeModel;
  else if (wakeList.some((m) => m.id === "pennyworth")) wakeSelect.value = "pennyworth";
  if (wakeList.length === 0) {
    $("wake-enabled").disabled = true;
    wakeSelect.disabled = true;
    $("wake-help").textContent = "No .onnx wake word models found on the server.";
  }
  if (!server.hermes) {
    $("fakehermes").checked = true;
    $("fakehermes").disabled = true;
  }
  if (!server.t3) $("codinghelp").textContent = "T3 isn't available on the server: only with fake answers.";
  else $("codinghelp").textContent = `Code changes go to a T3 Code thread in one of: ${server.t3.join(", ")}.`;
  if (!stopWords.supported) {
    $("stopword").checked = false;
    $("stopword").disabled = true;
  }
  const preset = $("preset");
  for (const name of Object.keys(PRESETS)) preset.add(new Option(name, name));
  preset.value = localStorage.getItem("voice-core.preset") ?? "web";
  if (!PRESETS[preset.value]) preset.value = "web";
  $("config").value = localStorage.getItem("voice-core.config") ?? JSON.stringify(PRESETS[preset.value], null, 2);
  preset.onchange = () => {
    $("config").value = JSON.stringify(PRESETS[preset.value], null, 2);
    localStorage.setItem("voice-core.preset", preset.value);
    localStorage.removeItem("voice-core.config");
    syncSignalingUi();
  };
  $("config").oninput = () => {
    localStorage.setItem("voice-core.config", $("config").value);
    syncSignalingUi();
  };
  $("defaults").onclick = async () => {
    const c = core ?? await loadCore();
    $("defaultsview").textContent = JSON.stringify(JSON.parse(c.defaults()), null, 2);
    $("defaultsview").hidden = !$("defaultsview").hidden;
  };
  const onCallClick = () => void callButton().catch((err) => {
    toast(err.message);
    log("error", err.message, "err");
  });
  const onHeroCallClick = () => {
    if (!callId) void start().catch((err) => {
      toast(err.message);
      log("error", err.message, "err");
    });
  };
  const onResumeClick = () => void start(true).catch((err) => {
    toast(err.message);
    log("error", err.message, "err");
  });
  $("call").onclick = onCallClick;
  $("hero-call").onclick = onHeroCallClick;
  $("hero-wake").onclick = () => void armWake(!wakeArmed);
  $("wakebtn").onclick = () => void armWake(!wakeArmed);
  $("wake-now").onclick = () => {
    if (callId) push({ type: "resume" });
  };
  $("resume").onclick = onResumeClick;
  $("hero-resume").onclick = onResumeClick;
  syncWakeUi();
  if (localStorage.getItem("voice.wake-enabled") === "1" && wakeList.length > 0) {
    void navigator.permissions?.query({ name: "microphone" }).then((p) => {
      if (p.state === "granted") void armWake(true, false);
    }).catch(() => {
    });
  }
  if (savedHistory().length > 0) {
    syncResumeButtons(true);
    $("resume").title = "Call again, carrying on from the last conversation";
  }
  $("mic").onclick = () => setMuted(!muted);
  $("hush").onclick = () => {
    push({ type: "interrupt" });
    audio.flush();
  };
  $("cancelall").onclick = () => push({ type: "cancelAll" });
  $("donebox").addEventListener("toggle", () => {
    if ($("donebox").open) $("donebox").scrollIntoView({ block: "nearest" });
  });
  $("say").onsubmit = (e) => void submitText(e);
  $("text").addEventListener("input", syncComposer);
  const transcriptPane = $("transcript");
  transcriptPane.addEventListener("scroll", () => transcriptScroll.onScroll(), { passive: true });
  transcriptPane.addEventListener("scrollend", () => transcriptScroll.onScrollEnd(), { passive: true });
  transcriptPane.addEventListener("wheel", (e) => {
    if (e.deltaY < 0) transcriptScroll.cancelJump();
  }, { passive: true });
  transcriptPane.addEventListener("touchstart", () => transcriptScroll.cancelJump(), { passive: true });
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => transcriptScroll.onResize()).observe(transcriptPane);
  $("jumpbottom").onclick = () => transcriptScroll.jumpToBottom();
  syncComposer();
  tabs();
  keys();
  const events = new EventSource("/events");
  events.addEventListener("core", (e) => {
    const { version } = JSON.parse(e.data);
    $("version").textContent = version + (callId && core && core.version !== version ? ` (next call; this one runs ${core.version})` : "");
    $("build").textContent = `core ${version}`;
  });
  events.addEventListener("app", () => {
    if (!callId) location.reload();
    else toast("The page changed: reload after this call");
  });
  events.addEventListener("error", (e) => {
    const data = e.data;
    if (data) toast(`Build failed: ${JSON.parse(data).message}`);
  });
  new Replay($("replay"), loadCore);
  void ping();
  void showEarlier();
  window.setInterval(() => void showEarlier(), 3e4);
}
void main();
export {
  loadCore
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL2NvbW1hbmRzLnRzIiwgIi4uL2F1ZGlvLnRzIiwgIi4uL3JlcGxheS50cyIsICIuLi9zY3JvbGwudHMiLCAiLi4vd2FrZUNsaWVudC50cyIsICIuLi9hcHAudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFNwb2tlbiBjb21tYW5kcyB0aGUgY29yZSBhY3RzIG9uIHdpdGhvdXQgdGhlIG1vZGVsOiBcInN0b3BcIiBhbmQgXCJoYW5nIHVwXCIuIEFuIHV0dGVyYW5jZSBjb3VudHNcbi8vIG9ubHkgd2hlbiBpdCBpcyBvbmUgb2YgdGhlIHBocmFzZXMgYW5kIG5vdGhpbmcgbW9yZSwgb25jZSBuYW1lcyBhbmQgZmlsbGVycyBhcm91bmQgaXQgYXJlIGdvbmUsXG4vLyBzbyBcIldvb2Rob3VzZSwgc3RvcCBwbGVhc2VcIiBzdG9wcyBhbmQgXCJzdG9wIHRoZSBQZW5ueXdvcnRoIHRhc2tcIiBnb2VzIHRvIHRoZSBtb2RlbCBhcyB1c3VhbC5cblxuaW1wb3J0IHR5cGUgeyBWb2ljZUNvbW1hbmRzIH0gZnJvbSBcIi4vdHlwZXMudHNcIjtcblxuZXhwb3J0IHR5cGUgVm9pY2VDb21tYW5kID0gXCJzdG9wXCIgfCBcImhhbmdVcFwiIHwgXCJjYW5jZWxBbGxcIjtcblxuLyoqIFdvcmRzIHRoYXQgbWF5IGNvbWUgYmVmb3JlIG9yIGFmdGVyIGEgY29tbWFuZCB3aXRob3V0IGNoYW5naW5nIGl0LiAqL1xuY29uc3QgRklMTEVSID0gbmV3IFNldChbXG4gIFwiaGV5XCIsIFwib2tcIiwgXCJva2F5XCIsIFwicGxlYXNlXCIsIFwibm93XCIsIFwianVzdFwiLCBcInNvXCIsIFwidW1cIiwgXCJ1aFwiLCBcIm9oXCIsIFwiYWxyaWdodFwiLCBcInJpZ2h0XCIsIFwieWVhaFwiLCBcInllc1wiLCBcInRoYW5rc1wiLCBcInRoYW5rXCIsIFwieW91XCIsXG4gIFwiZ2VtaW5pXCIsXG5dKTtcblxuLyoqIFt0ZXh0XSBhcyBsb3dlci1jYXNlIHdvcmRzLCBhcG9zdHJvcGhlcyBkcm9wcGVkIChcIlRoYXQnc1wiIGlzIFwidGhhdHNcIikuICovXG5leHBvcnQgZnVuY3Rpb24gd29yZHModGV4dDogc3RyaW5nKTogc3RyaW5nW10ge1xuICByZXR1cm4gdGV4dC50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL1snXHUyMDE5YF0vZywgXCJcIikucmVwbGFjZSgvW15cXHB7TH1cXHB7TmR9XSsvZ3UsIFwiIFwiKS50cmltKCkuc3BsaXQoXCIgXCIpLmZpbHRlcigodykgPT4gdy5sZW5ndGggPiAwKTtcbn1cblxuLyoqIFRoZSBjb21tYW5kIFt1dHRlcmFuY2VdIGlzLCBpZiBpdCdzIG9uZSBhbmQgbm90aGluZyBtb3JlOyBbbmFtZXNdICh0aGUgYXNzaXN0YW50J3MsIFwiV29vZGhvdXNlXCIpIGRvbid0IGNvdW50LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbW1hbmRJbih1dHRlcmFuY2U6IHN0cmluZywgY29tbWFuZHM6IFZvaWNlQ29tbWFuZHMsIG5hbWVzOiBzdHJpbmdbXSA9IFtdKTogVm9pY2VDb21tYW5kIHwgbnVsbCB7XG4gIGNvbnN0IGlnbm9yZWQgPSBuZXcgU2V0KFsuLi5GSUxMRVIsIC4uLm5hbWVzLmZsYXRNYXAod29yZHMpXSk7XG4gIGNvbnN0IHNhaWQgPSB3b3Jkcyh1dHRlcmFuY2UpO1xuICBsZXQgZnJvbSA9IDA7XG4gIGxldCB0byA9IHNhaWQubGVuZ3RoO1xuICB3aGlsZSAoZnJvbSA8IHRvICYmIGlnbm9yZWQuaGFzKHNhaWRbZnJvbV0pKSBmcm9tKys7XG4gIHdoaWxlICh0byA+IGZyb20gJiYgaWdub3JlZC5oYXMoc2FpZFt0byAtIDFdKSkgdG8tLTtcbiAgaWYgKGZyb20gPT09IHRvIHx8IHRvIC0gZnJvbSA+IDUpIHJldHVybiBudWxsO1xuICBjb25zdCBjb3JlID0gc2FpZC5zbGljZShmcm9tLCB0bykuam9pbihcIiBcIik7XG4gIGNvbnN0IGlzID0gKHBocmFzZXM6IHN0cmluZ1tdKSA9PiBwaHJhc2VzLnNvbWUoKHApID0+IHdvcmRzKHApLmpvaW4oXCIgXCIpID09PSBjb3JlKTtcbiAgaWYgKGlzKGNvbW1hbmRzLmhhbmdVcCkpIHJldHVybiBcImhhbmdVcFwiO1xuICBpZiAoaXMoY29tbWFuZHMuY2FuY2VsQWxsID8/IFtdKSkgcmV0dXJuIFwiY2FuY2VsQWxsXCI7XG4gIGlmIChpcyhjb21tYW5kcy5zdG9wKSkgcmV0dXJuIFwic3RvcFwiO1xuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqIFdvcmRzIHRoYXQgdGFrZSBhIHJlcXVlc3QgYmFjay4gKi9cbmNvbnN0IENBTkNFTFMgPSAvXFxiKD86Y2FuY2VsXFx3KnxhYm9ydFxcdyp8a2lsbHxzY3JhcHxzY3JhdGNofGRyb3B8Zm9yZ2V0fHVuZG98dGVybWluYXRlfG5ldmVyID9taW5kfGNhbGwgKD86aXR8dGhhdHx0aGlzKSBvZmZ8KD86ZG9udHxkbyBub3QpICg/OmJvdGhlcnxuZWVkfHdhbnR8ZG8pfG5vIG5lZWR8bm8gbG9uZ2VyfG5vdCBhbnltb3JlfGxlYXZlIGl0fHNraXAgKD86aXR8dGhhdCkpXFxiLztcbmNvbnN0IFNUT1BTID0gL1xcYig/OnN0b3BcXHcqfGhhbHR8cXVpdHxlbmQpXFxiLztcblxuLyoqXG4gKiBXaGV0aGVyIFt1dHRlcmFuY2VdIGFza3MgZm9yIGEgdGFzayB0byBiZSBjYW5jZWxsZWQsIGZvciBhIGNhbmNlbF90YXNrIHRoZSBtb2RlbCBjYWxsZWQgb24gaXQuIFwiU3RvcFwiIGFsb25lIGFuZCB0aGVcbiAqIG90aGVyIHN0b3AgYW5kIGhhbmctdXAgcGhyYXNlcyBkb24ndDogdGhleSBtZWFuIHN0b3AgdGFsa2luZy4gT3RoZXJ3aXNlIGl0IGRvZXMgd2hlbiBpdCBzYXlzIHNvIGluIHdvcmRzLCB3aGVuIGl0XG4gKiBuYW1lcyB0aGUgdGFzayAoW25hbWVkXSksIG9yIHdoZW4gaXQgc2F5cyB0byBzdG9wIHNvbWV0aGluZyBtb3JlIHRoYW4gdGhlIHRhbGtpbmcgKFwic3RvcCB3b3JraW5nIG9uIHRoYXRcIikuXG4gKiBXb3JkcyB0aGF0IHNheSBub25lIG9mIHRoaXMgKGEgbWlzaGVhcmluZyBzdWNoIGFzIFwiU3RhYml0XCIpIGRvbid0LiBXaXRoIG5vdGhpbmcgaGVhcmQgdGhlcmUgaXMgbm90aGluZyB0byBqdWRnZSBieS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFza3NUb0NhbmNlbCh1dHRlcmFuY2U6IHN0cmluZywgY29tbWFuZHM6IFZvaWNlQ29tbWFuZHMsIG5hbWVzOiBzdHJpbmdbXSwgbmFtZWQ6IGJvb2xlYW4pOiBib29sZWFuIHtcbiAgY29uc3Qgc2FpZCA9IHdvcmRzKHV0dGVyYW5jZSkuam9pbihcIiBcIik7XG4gIGlmIChzYWlkLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHRydWU7XG4gIGNvbnN0IGNvbW1hbmQgPSBjb21tYW5kSW4odXR0ZXJhbmNlLCBjb21tYW5kcywgbmFtZXMpO1xuICBpZiAoY29tbWFuZCA9PT0gXCJzdG9wXCIgfHwgY29tbWFuZCA9PT0gXCJoYW5nVXBcIikgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gY29tbWFuZCA9PT0gXCJjYW5jZWxBbGxcIiB8fCBuYW1lZCB8fCBDQU5DRUxTLnRlc3Qoc2FpZCkgfHwgU1RPUFMudGVzdChzYWlkKTtcbn1cbiIsICIvLyBUaGUgYnJvd3NlcidzIG1pY3JvcGhvbmUgYW5kIHNwZWFrZXIgZm9yIGEgY2FsbDogMTYga0h6IFBDTTE2IGZyYW1lcyBvdXQgb2YgdGhlIG1pY3JvcGhvbmUsXG4vLyAyNCBrSHogUENNMTYgaW50byB0aGUgc3BlYWtlciwgYW5kIHRvbmVzIGxhaWQgb3ZlciB3aGF0ZXZlciBwbGF5cy4gQm90aCBydW4gaW4gQXVkaW9Xb3JrbGV0cyBvblxuLy8gb25lIEF1ZGlvQ29udGV4dCBhdCB0aGUgZGV2aWNlJ3MgcmF0ZSwgcmVzYW1wbGluZyB0aGVyZS5cblxuY29uc3QgV09SS0xFVFMgPSBgXG5jbGFzcyBDYXB0dXJlIGV4dGVuZHMgQXVkaW9Xb3JrbGV0UHJvY2Vzc29yIHtcbiAgY29uc3RydWN0b3IoKSB7XG4gICAgc3VwZXIoKTtcbiAgICB0aGlzLnN0ZXAgPSBzYW1wbGVSYXRlIC8gMTYwMDA7XG4gICAgdGhpcy5wb3MgPSAwO1xuICAgIHRoaXMuZnJhbWUgPSBuZXcgSW50MTZBcnJheSgzMjApO1xuICAgIHRoaXMubiA9IDA7XG4gICAgLy8gQSB3aW5kb3dlZC1zaW5jIGxvdy1wYXNzIGF0IDcga0h6LCBzbyBub3RoaW5nIGFib3ZlIDE2IGtIeidzIDgga0h6IGxpbWl0IGZvbGRzIGJhY2sgaW50byBzcGVlY2guXG4gICAgY29uc3QgdGFwcyA9IDQ3LCBjdXQgPSA3MDAwIC8gc2FtcGxlUmF0ZTtcbiAgICB0aGlzLnRhcHMgPSBuZXcgRmxvYXQzMkFycmF5KHRhcHMpO1xuICAgIGxldCBzdW0gPSAwO1xuICAgIGZvciAobGV0IGsgPSAwOyBrIDwgdGFwczsgaysrKSB7XG4gICAgICBjb25zdCBtID0gayAtICh0YXBzIC0gMSkgLyAyO1xuICAgICAgY29uc3Qgc2luYyA9IG0gPT09IDAgPyAyICogY3V0IDogTWF0aC5zaW4oMiAqIE1hdGguUEkgKiBjdXQgKiBtKSAvIChNYXRoLlBJICogbSk7XG4gICAgICBjb25zdCB3ID0gMC40MiAtIDAuNSAqIE1hdGguY29zKCgyICogTWF0aC5QSSAqIGspIC8gKHRhcHMgLSAxKSkgKyAwLjA4ICogTWF0aC5jb3MoKDQgKiBNYXRoLlBJICogaykgLyAodGFwcyAtIDEpKTtcbiAgICAgIHRoaXMudGFwc1trXSA9IHNpbmMgKiB3O1xuICAgICAgc3VtICs9IHRoaXMudGFwc1trXTtcbiAgICB9XG4gICAgZm9yIChsZXQgayA9IDA7IGsgPCB0YXBzOyBrKyspIHRoaXMudGFwc1trXSAvPSBzdW07XG4gICAgdGhpcy5oaXN0b3J5ID0gbmV3IEZsb2F0MzJBcnJheSh0YXBzKTtcbiAgICB0aGlzLmF0ID0gMDtcbiAgfVxuICBwcm9jZXNzKGlucHV0cykge1xuICAgIGNvbnN0IGlucHV0ID0gaW5wdXRzWzBdICYmIGlucHV0c1swXVswXTtcbiAgICBpZiAoIWlucHV0KSByZXR1cm4gdHJ1ZTtcbiAgICBjb25zdCB0YXBzID0gdGhpcy50YXBzLCBoID0gdGhpcy5oaXN0b3J5LCBuID0gdGFwcy5sZW5ndGg7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBpbnB1dC5sZW5ndGg7IGkrKykge1xuICAgICAgaFt0aGlzLmF0XSA9IGlucHV0W2ldO1xuICAgICAgdGhpcy5hdCA9ICh0aGlzLmF0ICsgMSkgJSBuO1xuICAgICAgLy8gT25seSB0aGUgc2FtcGxlcyBrZXB0IG5lZWQgZmlsdGVyaW5nOiBhdCBtb3N0IG9uZSBpbiBldmVyeSBzdGVwLlxuICAgICAgaWYgKHRoaXMucG9zID4gMSkgeyB0aGlzLnBvcyAtPSAxOyBjb250aW51ZTsgfVxuICAgICAgbGV0IHggPSAwO1xuICAgICAgZm9yIChsZXQgayA9IDAsIGogPSB0aGlzLmF0OyBrIDwgbjsgaysrLCBqID0gaiArIDEgPT09IG4gPyAwIDogaiArIDEpIHggKz0gdGFwc1trXSAqIGhbal07XG4gICAgICB3aGlsZSAodGhpcy5wb3MgPD0gMSkge1xuICAgICAgICBjb25zdCBzID0gTWF0aC5tYXgoLTEsIE1hdGgubWluKDEsIHgpKTtcbiAgICAgICAgdGhpcy5mcmFtZVt0aGlzLm4rK10gPSBzIDwgMCA/IHMgKiAzMjc2OCA6IHMgKiAzMjc2NztcbiAgICAgICAgaWYgKHRoaXMubiA9PT0gdGhpcy5mcmFtZS5sZW5ndGgpIHtcbiAgICAgICAgICB0aGlzLnBvcnQucG9zdE1lc3NhZ2UodGhpcy5mcmFtZS5idWZmZXIsIFt0aGlzLmZyYW1lLmJ1ZmZlcl0pO1xuICAgICAgICAgIHRoaXMuZnJhbWUgPSBuZXcgSW50MTZBcnJheSgzMjApO1xuICAgICAgICAgIHRoaXMubiA9IDA7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5wb3MgKz0gdGhpcy5zdGVwO1xuICAgICAgfVxuICAgICAgdGhpcy5wb3MgLT0gMTtcbiAgICB9XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbn1cblxuY2xhc3MgUGxheWJhY2sgZXh0ZW5kcyBBdWRpb1dvcmtsZXRQcm9jZXNzb3Ige1xuICBjb25zdHJ1Y3RvcigpIHtcbiAgICBzdXBlcigpO1xuICAgIHRoaXMucXVldWUgPSBbXTsgICAgICAvLyBGbG9hdDMyQXJyYXlzIGF0IHRoZSBjb250ZXh0J3MgcmF0ZVxuICAgIHRoaXMub2Zmc2V0ID0gMDtcbiAgICB0aGlzLmN1ZXMgPSBbXTtcbiAgICB0aGlzLmN1ZU9mZnNldCA9IDA7XG4gICAgdGhpcy5yZXBvcnRlZCA9IDA7XG4gICAgdGhpcy5wb3J0Lm9ubWVzc2FnZSA9IChlKSA9PiB7XG4gICAgICBjb25zdCBtID0gZS5kYXRhO1xuICAgICAgaWYgKG0udHlwZSA9PT0gXCJwbGF5XCIpIHRoaXMucXVldWUucHVzaChtLnNhbXBsZXMpO1xuICAgICAgZWxzZSBpZiAobS50eXBlID09PSBcImN1ZVwiKSB0aGlzLmN1ZXMucHVzaChtLnNhbXBsZXMpO1xuICAgICAgZWxzZSBpZiAobS50eXBlID09PSBcImZsdXNoXCIpIHsgdGhpcy5xdWV1ZSA9IFtdOyB0aGlzLm9mZnNldCA9IDA7IH1cbiAgICAgIGVsc2UgaWYgKG0udHlwZSA9PT0gXCJzdG9wXCIpIHsgdGhpcy5xdWV1ZSA9IFtdOyB0aGlzLm9mZnNldCA9IDA7IHRoaXMuY3VlcyA9IFtdOyB0aGlzLmN1ZU9mZnNldCA9IDA7IH1cbiAgICB9O1xuICB9XG4gIHByb2Nlc3MoXywgb3V0cHV0cykge1xuICAgIGNvbnN0IG91dCA9IG91dHB1dHNbMF1bMF07XG4gICAgb3V0LmZpbGwoMCk7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoICYmIHRoaXMucXVldWUubGVuZ3RoOyBpKyspIHtcbiAgICAgIG91dFtpXSA9IHRoaXMucXVldWVbMF1bdGhpcy5vZmZzZXQrK107XG4gICAgICBpZiAodGhpcy5vZmZzZXQgPj0gdGhpcy5xdWV1ZVswXS5sZW5ndGgpIHsgdGhpcy5xdWV1ZS5zaGlmdCgpOyB0aGlzLm9mZnNldCA9IDA7IH1cbiAgICB9XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoICYmIHRoaXMuY3Vlcy5sZW5ndGg7IGkrKykge1xuICAgICAgb3V0W2ldID0gTWF0aC5tYXgoLTEsIE1hdGgubWluKDEsIG91dFtpXSArIHRoaXMuY3Vlc1swXVt0aGlzLmN1ZU9mZnNldCsrXSkpO1xuICAgICAgaWYgKHRoaXMuY3VlT2Zmc2V0ID49IHRoaXMuY3Vlc1swXS5sZW5ndGgpIHsgdGhpcy5jdWVzLnNoaWZ0KCk7IHRoaXMuY3VlT2Zmc2V0ID0gMDsgfVxuICAgIH1cbiAgICBmb3IgKGxldCBjID0gMTsgYyA8IG91dHB1dHNbMF0ubGVuZ3RoOyBjKyspIG91dHB1dHNbMF1bY10uc2V0KG91dCk7XG4gICAgaWYgKGN1cnJlbnRUaW1lIC0gdGhpcy5yZXBvcnRlZCA+IDAuMSkge1xuICAgICAgdGhpcy5yZXBvcnRlZCA9IGN1cnJlbnRUaW1lO1xuICAgICAgbGV0IHF1ZXVlZCA9IC10aGlzLm9mZnNldDtcbiAgICAgIGZvciAoY29uc3QgcSBvZiB0aGlzLnF1ZXVlKSBxdWV1ZWQgKz0gcS5sZW5ndGg7XG4gICAgICB0aGlzLnBvcnQucG9zdE1lc3NhZ2UoeyBxdWV1ZWQ6IHF1ZXVlZCAvIHNhbXBsZVJhdGUgfSk7XG4gICAgfVxuICAgIHJldHVybiB0cnVlO1xuICB9XG59XG5yZWdpc3RlclByb2Nlc3NvcihcImNhcHR1cmVcIiwgQ2FwdHVyZSk7XG5yZWdpc3RlclByb2Nlc3NvcihcInBsYXliYWNrXCIsIFBsYXliYWNrKTtcbmA7XG5cbmZ1bmN0aW9uIGJhc2U2NFRvQnl0ZXMoYjY0OiBzdHJpbmcpOiBVaW50OEFycmF5IHtcbiAgY29uc3QgYmluID0gYXRvYihiNjQpO1xuICBjb25zdCBvdXQgPSBuZXcgVWludDhBcnJheShiaW4ubGVuZ3RoKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBiaW4ubGVuZ3RoOyBpKyspIG91dFtpXSA9IGJpbi5jaGFyQ29kZUF0KGkpO1xuICByZXR1cm4gb3V0O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYnl0ZXNUb0Jhc2U2NChieXRlczogVWludDhBcnJheSk6IHN0cmluZyB7XG4gIGxldCBiaW4gPSBcIlwiO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGJ5dGVzLmxlbmd0aDsgaSArPSAweDgwMDApIGJpbiArPSBTdHJpbmcuZnJvbUNoYXJDb2RlKC4uLmJ5dGVzLnN1YmFycmF5KGksIGkgKyAweDgwMDApKTtcbiAgcmV0dXJuIGJ0b2EoYmluKTtcbn1cblxuLyoqIFBDTTE2IGxpdHRsZS1lbmRpYW4gYXQgW3JhdGVdLCBhcyBmbG9hdHMgYXQgdGhlIGNvbnRleHQncyByYXRlLiAqL1xuZnVuY3Rpb24gdG9GbG9hdHMocGNtOiBVaW50OEFycmF5LCByYXRlOiBudW1iZXIsIHRhcmdldDogbnVtYmVyKTogRmxvYXQzMkFycmF5IHtcbiAgY29uc3QgdmlldyA9IG5ldyBEYXRhVmlldyhwY20uYnVmZmVyLCBwY20uYnl0ZU9mZnNldCwgcGNtLmJ5dGVMZW5ndGgpO1xuICBjb25zdCBuID0gTWF0aC5mbG9vcihwY20uYnl0ZUxlbmd0aCAvIDIpO1xuICBjb25zdCBvdXQgPSBuZXcgRmxvYXQzMkFycmF5KE1hdGguZmxvb3IoKG4gKiB0YXJnZXQpIC8gcmF0ZSkpO1xuICBjb25zdCBzdGVwID0gcmF0ZSAvIHRhcmdldDtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCB4ID0gaSAqIHN0ZXA7XG4gICAgY29uc3QgaiA9IE1hdGguZmxvb3IoeCk7XG4gICAgY29uc3QgYSA9IHZpZXcuZ2V0SW50MTYoMiAqIE1hdGgubWluKGosIG4gLSAxKSwgdHJ1ZSk7XG4gICAgY29uc3QgYiA9IHZpZXcuZ2V0SW50MTYoMiAqIE1hdGgubWluKGogKyAxLCBuIC0gMSksIHRydWUpO1xuICAgIG91dFtpXSA9IChhICsgKGIgLSBhKSAqICh4IC0gaikpIC8gMzI3Njg7XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBNaWNPcHRpb25zIHsgZWNob0NhbmNlbGxhdGlvbjogYm9vbGVhbjsgbm9pc2VTdXBwcmVzc2lvbjogYm9vbGVhbjsgYXV0b0dhaW5Db250cm9sOiBib29sZWFuIH1cblxuZXhwb3J0IGNsYXNzIENhbGxBdWRpbyB7XG4gIHByaXZhdGUgY29udGV4dDogQXVkaW9Db250ZXh0IHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgcGxheWJhY2s6IEF1ZGlvV29ya2xldE5vZGUgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBjYXB0dXJlOiBBdWRpb1dvcmtsZXROb2RlIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgc3RyZWFtOiBNZWRpYVN0cmVhbSB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIHNvdXJjZTogTWVkaWFTdHJlYW1BdWRpb1NvdXJjZU5vZGUgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBtaWNPcHRzOiBNaWNPcHRpb25zIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgb25NaWNGcmFtZTogKChzYW1wbGVzOiBJbnQxNkFycmF5LCBsZXZlbDogbnVtYmVyKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuICAvKiogU2Vjb25kcyBvZiBzcGVlY2ggcXVldWVkLCBhcyB0aGUgd29ya2xldCBsYXN0IHNhaWQuICovXG4gIHF1ZXVlZCA9IDA7XG4gIC8qKiBUaGUgbWljcm9waG9uZSdzIGxldmVsLCBSTVMgb2YgdGhlIGxhc3QgZnJhbWUgKDAgdG8gMSkuICovXG4gIGxldmVsID0gMDtcblxuICBhc3luYyBvcGVuKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICh0aGlzLmNvbnRleHQpIHsgaWYgKHRoaXMuY29udGV4dC5zdGF0ZSA9PT0gXCJzdXNwZW5kZWRcIikgYXdhaXQgdGhpcy5jb250ZXh0LnJlc3VtZSgpOyByZXR1cm47IH1cbiAgICB0aGlzLmNvbnRleHQgPSBuZXcgQXVkaW9Db250ZXh0KHsgbGF0ZW5jeUhpbnQ6IFwiaW50ZXJhY3RpdmVcIiB9KTtcbiAgICBjb25zdCB1cmwgPSBVUkwuY3JlYXRlT2JqZWN0VVJMKG5ldyBCbG9iKFtXT1JLTEVUU10sIHsgdHlwZTogXCJ0ZXh0L2phdmFzY3JpcHRcIiB9KSk7XG4gICAgYXdhaXQgdGhpcy5jb250ZXh0LmF1ZGlvV29ya2xldC5hZGRNb2R1bGUodXJsKTtcbiAgICB0aGlzLnBsYXliYWNrID0gbmV3IEF1ZGlvV29ya2xldE5vZGUodGhpcy5jb250ZXh0LCBcInBsYXliYWNrXCIsIHsgbnVtYmVyT2ZJbnB1dHM6IDAsIG91dHB1dENoYW5uZWxDb3VudDogWzJdIH0pO1xuICAgIHRoaXMucGxheWJhY2sucG9ydC5vbm1lc3NhZ2UgPSAoZSkgPT4geyB0aGlzLnF1ZXVlZCA9IGUuZGF0YS5xdWV1ZWQ7IH07XG4gICAgdGhpcy5wbGF5YmFjay5jb25uZWN0KHRoaXMuY29udGV4dC5kZXN0aW5hdGlvbik7XG4gIH1cblxuICAvKiogU2Vjb25kcyBmcm9tIGEgc2FtcGxlIGxlYXZpbmcgdGhlIHdvcmtsZXQgdG8gdGhlIHNwZWFrZXIsIGFzIHRoZSBicm93c2VyIHJlY2tvbnMgaXQuICovXG4gIGdldCBvdXRwdXRMYXRlbmN5KCk6IG51bWJlciB8IG51bGwge1xuICAgIGlmICghdGhpcy5jb250ZXh0KSByZXR1cm4gbnVsbDtcbiAgICByZXR1cm4gdGhpcy5jb250ZXh0LmJhc2VMYXRlbmN5ICsgKCh0aGlzLmNvbnRleHQgYXMgQXVkaW9Db250ZXh0ICYgeyBvdXRwdXRMYXRlbmN5PzogbnVtYmVyIH0pLm91dHB1dExhdGVuY3kgPz8gMCk7XG4gIH1cblxuICBnZXQgbWljQWN0aXZlKCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLmNhcHR1cmUgIT0gbnVsbCAmJiB0aGlzLnN0cmVhbSAhPSBudWxsICYmIHRoaXMuc3RyZWFtLmdldFRyYWNrcygpLnNvbWUoKHQpID0+IHQucmVhZHlTdGF0ZSA9PT0gXCJsaXZlXCIpO1xuICB9XG5cbiAgLyoqIFN0YXJ0cyB0aGUgbWljcm9waG9uZSBpZiBpdCBpc24ndCBhbHJlYWR5IHJ1bm5pbmcgd2l0aCB0aGUgc2FtZSBvcHRpb25zOyBvdGhlcndpc2Ugc3dhcHMgdGhlIGZyYW1lIGNhbGxiYWNrIGNsZWFubHkuICovXG4gIGFzeW5jIGVuc3VyZU1pYyhvbkZyYW1lOiAoc2FtcGxlczogSW50MTZBcnJheSwgbGV2ZWw6IG51bWJlcikgPT4gdm9pZCwgb3B0aW9uczogTWljT3B0aW9ucyk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmIChcbiAgICAgIHRoaXMubWljQWN0aXZlICYmXG4gICAgICB0aGlzLm1pY09wdHMgJiZcbiAgICAgIHRoaXMubWljT3B0cy5lY2hvQ2FuY2VsbGF0aW9uID09PSBvcHRpb25zLmVjaG9DYW5jZWxsYXRpb24gJiZcbiAgICAgIHRoaXMubWljT3B0cy5ub2lzZVN1cHByZXNzaW9uID09PSBvcHRpb25zLm5vaXNlU3VwcHJlc3Npb24gJiZcbiAgICAgIHRoaXMubWljT3B0cy5hdXRvR2FpbkNvbnRyb2wgPT09IG9wdGlvbnMuYXV0b0dhaW5Db250cm9sXG4gICAgKSB7XG4gICAgICBhd2FpdCB0aGlzLm9wZW4oKTtcbiAgICAgIHRoaXMub25NaWNGcmFtZSA9IG9uRnJhbWU7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGF3YWl0IHRoaXMuc3RhcnRNaWMob25GcmFtZSwgb3B0aW9ucyk7XG4gIH1cblxuICBhc3luYyBzdGFydE1pYyhvbkZyYW1lOiAoc2FtcGxlczogSW50MTZBcnJheSwgbGV2ZWw6IG51bWJlcikgPT4gdm9pZCwgb3B0aW9uczogTWljT3B0aW9ucyk6IFByb21pc2U8dm9pZD4ge1xuICAgIGF3YWl0IHRoaXMub3BlbigpO1xuICAgIHRoaXMuc3RvcE1pYygpO1xuICAgIGNvbnN0IGNvbnRleHQgPSB0aGlzLmNvbnRleHQhO1xuICAgIHRoaXMuc3RyZWFtID0gYXdhaXQgbmF2aWdhdG9yLm1lZGlhRGV2aWNlcy5nZXRVc2VyTWVkaWEoeyBhdWRpbzogeyBjaGFubmVsQ291bnQ6IDEsIC4uLm9wdGlvbnMgfSB9KTtcbiAgICB0aGlzLm1pY09wdHMgPSB7IC4uLm9wdGlvbnMgfTtcbiAgICB0aGlzLm9uTWljRnJhbWUgPSBvbkZyYW1lO1xuICAgIHRoaXMuc291cmNlID0gY29udGV4dC5jcmVhdGVNZWRpYVN0cmVhbVNvdXJjZSh0aGlzLnN0cmVhbSk7XG4gICAgdGhpcy5jYXB0dXJlID0gbmV3IEF1ZGlvV29ya2xldE5vZGUoY29udGV4dCwgXCJjYXB0dXJlXCIsIHsgbnVtYmVyT2ZPdXRwdXRzOiAwIH0pO1xuICAgIHRoaXMuY2FwdHVyZS5wb3J0Lm9ubWVzc2FnZSA9IChlKSA9PiB7XG4gICAgICBjb25zdCBmcmFtZSA9IG5ldyBJbnQxNkFycmF5KGUuZGF0YSBhcyBBcnJheUJ1ZmZlcik7XG4gICAgICBsZXQgc3VtID0gMDtcbiAgICAgIGZvciAoY29uc3QgcyBvZiBmcmFtZSkgc3VtICs9IHMgKiBzO1xuICAgICAgdGhpcy5sZXZlbCA9IE1hdGguc3FydChzdW0gLyBmcmFtZS5sZW5ndGgpIC8gMzI3Njg7XG4gICAgICB0aGlzLm9uTWljRnJhbWU/LihmcmFtZSwgdGhpcy5sZXZlbCk7XG4gICAgfTtcbiAgICB0aGlzLnNvdXJjZS5jb25uZWN0KHRoaXMuY2FwdHVyZSk7XG4gIH1cblxuICBzdG9wTWljKCk6IHZvaWQge1xuICAgIHRoaXMuc291cmNlPy5kaXNjb25uZWN0KCk7XG4gICAgdGhpcy5jYXB0dXJlPy5wb3J0LmNsb3NlKCk7XG4gICAgdGhpcy5zdHJlYW0/LmdldFRyYWNrcygpLmZvckVhY2goKHQpID0+IHQuc3RvcCgpKTtcbiAgICB0aGlzLnNvdXJjZSA9IG51bGw7XG4gICAgdGhpcy5jYXB0dXJlID0gbnVsbDtcbiAgICB0aGlzLnN0cmVhbSA9IG51bGw7XG4gICAgdGhpcy5taWNPcHRzID0gbnVsbDtcbiAgICB0aGlzLm9uTWljRnJhbWUgPSBudWxsO1xuICAgIHRoaXMubGV2ZWwgPSAwO1xuICB9XG5cbiAgcGxheShwY202NDogc3RyaW5nKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLmNvbnRleHQgfHwgIXRoaXMucGxheWJhY2spIHJldHVybjtcbiAgICBjb25zdCBzYW1wbGVzID0gdG9GbG9hdHMoYmFzZTY0VG9CeXRlcyhwY202NCksIDI0MDAwLCB0aGlzLmNvbnRleHQuc2FtcGxlUmF0ZSk7XG4gICAgdGhpcy5wbGF5YmFjay5wb3J0LnBvc3RNZXNzYWdlKHsgdHlwZTogXCJwbGF5XCIsIHNhbXBsZXMgfSwgW3NhbXBsZXMuYnVmZmVyXSk7XG4gIH1cblxuICBjdWUocGNtNjQ6IHN0cmluZyk6IHZvaWQge1xuICAgIGlmICghdGhpcy5jb250ZXh0IHx8ICF0aGlzLnBsYXliYWNrKSByZXR1cm47XG4gICAgY29uc3Qgc2FtcGxlcyA9IHRvRmxvYXRzKGJhc2U2NFRvQnl0ZXMocGNtNjQpLCAyNDAwMCwgdGhpcy5jb250ZXh0LnNhbXBsZVJhdGUpO1xuICAgIHRoaXMucGxheWJhY2sucG9ydC5wb3N0TWVzc2FnZSh7IHR5cGU6IFwiY3VlXCIsIHNhbXBsZXMgfSwgW3NhbXBsZXMuYnVmZmVyXSk7XG4gIH1cblxuICBmbHVzaCgpOiB2b2lkIHtcbiAgICB0aGlzLnBsYXliYWNrPy5wb3J0LnBvc3RNZXNzYWdlKHsgdHlwZTogXCJmbHVzaFwiIH0pO1xuICB9XG5cbiAgc3RvcFBsYXliYWNrKCk6IHZvaWQge1xuICAgIHRoaXMucGxheWJhY2s/LnBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcInN0b3BcIiB9KTtcbiAgICB0aGlzLnF1ZXVlZCA9IDA7XG4gIH1cblxuICBzdG9wKCk6IHZvaWQge1xuICAgIHRoaXMuc3RvcE1pYygpO1xuICAgIHRoaXMuc3RvcFBsYXliYWNrKCk7XG4gIH1cbn1cbiIsICIvLyBUaGUgcmVwbGF5IHZpZXc6IGEgcmVjb3JkZWQgY2FsbCAoYSB0cmFjZSBmcm9tIGFueSBob3N0LCBvciBhIHNjZW5hcmlvKSBydW4gYWdhaW4gdGhyb3VnaCB0aGVcbi8vIGNvcmUsIGFzIHRoZSBidWlsZCB0aGF0IHJlY29yZGVkIGl0IGRpZCBhbmQgYXMgdGhlIGxhdGVzdCBkb2VzLCBzaWRlIGJ5IHNpZGUuIFdoZXJlIHRoZXkgcGFydFxuLy8gaXMgd2hlcmUgYSBjaGFuZ2UgaW4gc3JjLyBjaGFuZ2VkIHdoYXQgdGhlIGNhbGwgZG9lcyB3aXRoIHRoZSBzYW1lIHdvcmRzIGFuZCB0aGUgc2FtZSBtb2RlbC5cblxuaW50ZXJmYWNlIENvcmUge1xuICB2ZXJzaW9uOiBzdHJpbmc7XG4gIGNyZWF0ZShjb25maWc6IHN0cmluZywgdDogbnVtYmVyKTogc3RyaW5nO1xuICBwdXNoKGlkOiBudW1iZXIsIGV2ZW50OiBzdHJpbmcpOiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBSZWNvcmRpbmcgeyB2ZXJzaW9uPzogc3RyaW5nOyBjb25maWc6IHVua25vd247IHN0YXJ0OiBudW1iZXI7IGV2ZW50czogUmVjb3JkPHN0cmluZywgYW55PltdIH1cblxuLyoqIFdoYXQgYSBjb21tYW5kIG9yIGV2ZW50IGxvb2tzIGxpa2UgaW4gYSB0aW1lbGluZTogYXVkaW8gY3V0IG91dCwgb25lIGxpbmUuICovXG5mdW5jdGlvbiBsaW5lKG86IFJlY29yZDxzdHJpbmcsIGFueT4pOiBzdHJpbmcge1xuICBjb25zdCB0ZXh0ID0gSlNPTi5zdHJpbmdpZnkobykucmVwbGFjZSgvXCIoZGF0YXxwY20pXCI6XCJbQS1aYS16MC05Ky89XXs0MCx9XCIvZywgJ1wiJDFcIjpcIlx1MjAyNlwiJylcbiAgICAucmVwbGFjZSgvXFxcXFwiZGF0YVxcXFxcIjpcXFxcXCJbQS1aYS16MC05Ky89XXs0MCx9XFxcXFwiL2csICdcXFxcXCJkYXRhXFxcXFwiOlxcXFxcIlx1MjAyNlxcXFxcIicpO1xuICByZXR1cm4gdGV4dC5sZW5ndGggPiA0MDAgPyB0ZXh0LnNsaWNlKDAsIDQwMCkgKyBcIlx1MjAyNlwiIDogdGV4dDtcbn1cblxuLyoqIEF1ZGlvIGFuZCB0aWNrcyBzYXkgbm90aGluZyBhIHJlYWRlciBuZWVkczsgdGhlIHJlc3QgZG9lcy4gKi9cbmZ1bmN0aW9uIHRlbGxpbmcobzogUmVjb3JkPHN0cmluZywgYW55Pik6IGJvb2xlYW4ge1xuICBpZiAoby50eXBlID09PSBcIm1pY1wiIHx8IG8udHlwZSA9PT0gXCJ0aWNrXCIgfHwgby50eXBlID09PSBcInBsYXlcIikgcmV0dXJuIGZhbHNlO1xuICBpZiAoby50eXBlID09PSBcIndzLnNlbmRcIiAmJiBTdHJpbmcoby5kYXRhKS5zdGFydHNXaXRoKCd7XCJyZWFsdGltZUlucHV0XCI6e1wiYXVkaW9cIicpKSByZXR1cm4gZmFsc2U7XG4gIGlmIChvLnR5cGUgPT09IFwid3MubWVzc2FnZVwiICYmIFN0cmluZyhvLmRhdGEpLmluY2x1ZGVzKCdcImlubGluZURhdGFcIicpICYmICFTdHJpbmcoby5kYXRhKS5pbmNsdWRlcygnXCJ0dXJuQ29tcGxldGVcIicpKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiB0cnVlO1xufVxuXG5mdW5jdGlvbiBydW4oY29yZTogQ29yZSwgcjogUmVjb3JkaW5nKTogc3RyaW5nW11bXSB7XG4gIGNvbnN0IGNyZWF0ZWQgPSBKU09OLnBhcnNlKGNvcmUuY3JlYXRlKEpTT04uc3RyaW5naWZ5KHIuY29uZmlnKSwgci5zdGFydCkpO1xuICBjb25zdCBvdXQ6IHN0cmluZ1tdW10gPSBbY3JlYXRlZC5jb21tYW5kcy5maWx0ZXIodGVsbGluZykubWFwKGxpbmUpXTtcbiAgZm9yIChjb25zdCBlIG9mIHIuZXZlbnRzKSBvdXQucHVzaCgoSlNPTi5wYXJzZShjb3JlLnB1c2goY3JlYXRlZC5pZCwgSlNPTi5zdHJpbmdpZnkoZSkpKSBhcyBSZWNvcmQ8c3RyaW5nLCBhbnk+W10pLmZpbHRlcih0ZWxsaW5nKS5tYXAobGluZSkpO1xuICByZXR1cm4gb3V0O1xufVxuXG5leHBvcnQgY2xhc3MgUmVwbGF5IHtcbiAgcHJpdmF0ZSByZWFkb25seSByb290OiBIVE1MRWxlbWVudDtcbiAgcHJpdmF0ZSByZWFkb25seSBsb2FkOiAodXJsPzogc3RyaW5nKSA9PiBQcm9taXNlPENvcmU+O1xuXG4gIGNvbnN0cnVjdG9yKHJvb3Q6IEhUTUxFbGVtZW50LCBsb2FkOiAodXJsPzogc3RyaW5nKSA9PiBQcm9taXNlPENvcmU+KSB7XG4gICAgdGhpcy5yb290ID0gcm9vdDtcbiAgICB0aGlzLmxvYWQgPSBsb2FkO1xuICAgIHJvb3QuaW5uZXJIVE1MID0gYFxuICAgICAgPGgyPlRyYWNlIHJlcGxheTwvaDI+XG4gICAgICA8ZGl2IGNsYXNzPVwiYmFyXCI+PHNlbGVjdCBjbGFzcz1cInBpY2tcIiBhcmlhLWxhYmVsPVwiUmVjb3JkaW5nXCI+PC9zZWxlY3Q+PGJ1dHRvbiB0eXBlPVwiYnV0dG9uXCIgY2xhc3M9XCJyZWZyZXNoXCIgdGl0bGU9XCJSZWZyZXNoIGxpc3RcIiBhcmlhLWxhYmVsPVwiUmVmcmVzaCBsaXN0XCI+XHUyMUJCPC9idXR0b24+PGJ1dHRvbiB0eXBlPVwiYnV0dG9uXCIgY2xhc3M9XCJnb1wiPlJlcGxheTwvYnV0dG9uPlxuICAgICAgPGxhYmVsIGNsYXNzPVwidG9nZ2xlLWFsbFwiPjxpbnB1dCB0eXBlPVwiY2hlY2tib3hcIiBjbGFzcz1cImFsbFwiPiBTaG93IGF1ZGlvIGFuZCB0aWNrczwvbGFiZWw+PHNwYW4gY2xhc3M9XCJzdW1tYXJ5XCI+PC9zcGFuPjwvZGl2PlxuICAgICAgPGRpdiBjbGFzcz1cInRpbWVsaW5lXCI+PC9kaXY+YDtcbiAgICAocm9vdC5xdWVyeVNlbGVjdG9yKFwiLnJlZnJlc2hcIikgYXMgSFRNTEVsZW1lbnQpLm9uY2xpY2sgPSAoKSA9PiB2b2lkIHRoaXMubGlzdCgpO1xuICAgIChyb290LnF1ZXJ5U2VsZWN0b3IoXCIuZ29cIikgYXMgSFRNTEVsZW1lbnQpLm9uY2xpY2sgPSAoKSA9PiB2b2lkIHRoaXMucmVwbGF5KCkuY2F0Y2goKGVycikgPT4gdGhpcy5zYXkoYFJlcGxheSBmYWlsZWQ6ICR7ZXJyLm1lc3NhZ2V9YCkpO1xuICAgIHZvaWQgdGhpcy5saXN0KCk7XG4gIH1cblxuICBwcml2YXRlIHNheSh0ZXh0OiBzdHJpbmcpIHtcbiAgICAodGhpcy5yb290LnF1ZXJ5U2VsZWN0b3IoXCIuc3VtbWFyeVwiKSBhcyBIVE1MRWxlbWVudCkudGV4dENvbnRlbnQgPSB0ZXh0O1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBsaXN0KCkge1xuICAgIGNvbnN0IHBpY2sgPSB0aGlzLnJvb3QucXVlcnlTZWxlY3RvcihcIi5waWNrXCIpIGFzIEhUTUxTZWxlY3RFbGVtZW50O1xuICAgIHBpY2suaW5uZXJIVE1MID0gXCJcIjtcbiAgICBjb25zdCB0cmFjZXM6IHsgbmFtZTogc3RyaW5nOyBieXRlczogbnVtYmVyIH1bXSA9IGF3YWl0IChhd2FpdCBmZXRjaChcIi90cmFjZXNcIikpLmpzb24oKTtcbiAgICBjb25zdCBzY2VuYXJpb3M6IHN0cmluZ1tdID0gYXdhaXQgKGF3YWl0IGZldGNoKFwiL3NjZW5hcmlvc1wiKSkuanNvbigpO1xuICAgIGNvbnN0IHRyYWNlR3JvdXAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwib3B0Z3JvdXBcIik7XG4gICAgdHJhY2VHcm91cC5sYWJlbCA9IFwiUmVjb3JkZWQgY2FsbHNcIjtcbiAgICBmb3IgKGNvbnN0IHQgb2YgdHJhY2VzKSB0cmFjZUdyb3VwLmFwcGVuZChuZXcgT3B0aW9uKGAke3QubmFtZX0gKCR7TWF0aC5yb3VuZCh0LmJ5dGVzIC8gMTAyNCl9IEtCKWAsIGAvdHJhY2VzLyR7dC5uYW1lfWApKTtcbiAgICBjb25zdCBzY2VuYXJpb0dyb3VwID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcIm9wdGdyb3VwXCIpO1xuICAgIHNjZW5hcmlvR3JvdXAubGFiZWwgPSBcIlNjZW5hcmlvc1wiO1xuICAgIGZvciAoY29uc3QgcyBvZiBzY2VuYXJpb3MpIHNjZW5hcmlvR3JvdXAuYXBwZW5kKG5ldyBPcHRpb24ocywgYC9zY2VuYXJpb3MvJHtzfS5qc29uYCkpO1xuICAgIHBpY2suYXBwZW5kKHRyYWNlR3JvdXAsIHNjZW5hcmlvR3JvdXApO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyByZWNvcmRpbmcodXJsOiBzdHJpbmcpOiBQcm9taXNlPFJlY29yZGluZz4ge1xuICAgIGNvbnN0IHRleHQgPSBhd2FpdCAoYXdhaXQgZmV0Y2godXJsLCB7IGNhY2hlOiBcIm5vLXN0b3JlXCIgfSkpLnRleHQoKTtcbiAgICBpZiAodXJsLmVuZHNXaXRoKFwiLmpzb25cIikpIHJldHVybiBKU09OLnBhcnNlKHRleHQpO1xuICAgIGNvbnN0IFtoZWFkZXIsIC4uLmV2ZW50c10gPSB0ZXh0LnRyaW0oKS5zcGxpdChcIlxcblwiKS5tYXAoKGwpID0+IEpTT04ucGFyc2UobCkpO1xuICAgIHJldHVybiB7IC4uLmhlYWRlciwgZXZlbnRzIH07XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHJlcGxheSgpIHtcbiAgICBjb25zdCB1cmwgPSAodGhpcy5yb290LnF1ZXJ5U2VsZWN0b3IoXCIucGlja1wiKSBhcyBIVE1MU2VsZWN0RWxlbWVudCkudmFsdWU7XG4gICAgaWYgKCF1cmwpIHJldHVybjtcbiAgICBjb25zdCByID0gYXdhaXQgdGhpcy5yZWNvcmRpbmcodXJsKTtcbiAgICBjb25zdCBsYXRlc3QgPSBhd2FpdCB0aGlzLmxvYWQoKTtcbiAgICBsZXQgcmVjb3JkZWQ6IENvcmUgfCBudWxsID0gbnVsbDtcbiAgICBpZiAoci52ZXJzaW9uICYmIHIudmVyc2lvbiAhPT0gbGF0ZXN0LnZlcnNpb24pIHtcbiAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goYC92ZXJzaW9ucy8ke3IudmVyc2lvbn0uanNgLCB7IG1ldGhvZDogXCJIRUFEXCIgfSk7XG4gICAgICBpZiAocmVzcG9uc2Uub2spIHJlY29yZGVkID0gYXdhaXQgdGhpcy5sb2FkKGAvdmVyc2lvbnMvJHtyLnZlcnNpb259LmpzYCk7XG4gICAgfVxuICAgIGNvbnN0IG5vdyA9IHJ1bihsYXRlc3QsIHIpO1xuICAgIGNvbnN0IHRoZW4gPSByZWNvcmRlZCA/IHJ1bihyZWNvcmRlZCwgcikgOiBudWxsO1xuICAgIGNvbnN0IGFsbCA9ICh0aGlzLnJvb3QucXVlcnlTZWxlY3RvcihcIi5hbGxcIikgYXMgSFRNTElucHV0RWxlbWVudCkuY2hlY2tlZDtcbiAgICBjb25zdCB0aW1lbGluZSA9IHRoaXMucm9vdC5xdWVyeVNlbGVjdG9yKFwiLnRpbWVsaW5lXCIpIGFzIEhUTUxFbGVtZW50O1xuICAgIHRpbWVsaW5lLmlubmVySFRNTCA9IFwiXCI7XG4gICAgbGV0IGZpcnN0ID0gLTE7XG4gICAgbGV0IGRpZmZlciA9IDA7XG4gICAgY29uc3Qgcm93czogSFRNTEVsZW1lbnRbXSA9IFtdO1xuICAgIGNvbnN0IGFkZCA9IChjbHM6IHN0cmluZywgdDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpID0+IHtcbiAgICAgIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICByb3cuY2xhc3NOYW1lID0gYHJvdyAke2Nsc31gO1xuICAgICAgcm93LmlubmVySFRNTCA9IGA8c3BhbiBjbGFzcz1cInRcIj4ke3R9PC9zcGFuPmA7XG4gICAgICBjb25zdCBiID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gICAgICBiLmNsYXNzTmFtZSA9IFwiYlwiO1xuICAgICAgYi50ZXh0Q29udGVudCA9IHRleHQ7XG4gICAgICByb3cuYXBwZW5kKGIpO1xuICAgICAgdGltZWxpbmUuYXBwZW5kKHJvdyk7XG4gICAgICByb3dzLnB1c2gocm93KTtcbiAgICAgIHJldHVybiByb3c7XG4gICAgfTtcbiAgICBjb25zdCB0MCA9IHIuc3RhcnQ7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPD0gci5ldmVudHMubGVuZ3RoOyBpKyspIHtcbiAgICAgIGNvbnN0IGUgPSBpID09PSAwID8gbnVsbCA6IHIuZXZlbnRzW2kgLSAxXTtcbiAgICAgIGNvbnN0IG5vd091dCA9IG5vd1tpXTtcbiAgICAgIGNvbnN0IHRoZW5PdXQgPSB0aGVuID8gdGhlbltpXSA6IG5vd091dDtcbiAgICAgIGNvbnN0IHNhbWUgPSBub3dPdXQubGVuZ3RoID09PSB0aGVuT3V0Lmxlbmd0aCAmJiBub3dPdXQuZXZlcnkoKGMsIGopID0+IGMgPT09IHRoZW5PdXRbal0pO1xuICAgICAgaWYgKCFzYW1lKSB7IGRpZmZlcisrOyBpZiAoZmlyc3QgPCAwKSBmaXJzdCA9IGk7IH1cbiAgICAgIGlmICghc2FtZSB8fCBhbGwgfHwgKGUgJiYgdGVsbGluZyhlKSkgfHwgbm93T3V0Lmxlbmd0aCA+IDApIHtcbiAgICAgICAgaWYgKGUgJiYgKGFsbCB8fCB0ZWxsaW5nKGUpIHx8ICFzYW1lKSkgYWRkKFwiaW5cIiwgKGUudCAtIHQwKS50b0ZpeGVkKDIpLCBsaW5lKGUpKTtcbiAgICAgICAgY29uc3QgdCA9IGUgPyAoZS50IC0gdDApLnRvRml4ZWQoMikgOiBcIjAuMDBcIjtcbiAgICAgICAgaWYgKHNhbWUpIGZvciAoY29uc3QgYyBvZiBub3dPdXQpIGFkZChcIm91dFwiLCB0LCBjKTtcbiAgICAgICAgZWxzZSB7XG4gICAgICAgICAgZm9yIChjb25zdCBjIG9mIHRoZW5PdXQpIGFkZChcIm91dCBnb25lXCIsIHQsIGBcdTIyMTIgJHtjfWApO1xuICAgICAgICAgIGZvciAoY29uc3QgYyBvZiBub3dPdXQpIGFkZChcIm91dCBuZXdcIiwgdCwgYCsgJHtjfWApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IHZlcnNpb25zID0gdGhlbiA/IGByZWNvcmRlZCBieSAke3IudmVyc2lvbn0sIHJlcGxheWVkIGJ5IGl0IGFuZCBieSAke2xhdGVzdC52ZXJzaW9ufWAgOiBgcmVwbGF5ZWQgYnkgJHtsYXRlc3QudmVyc2lvbn1gICtcbiAgICAgIChyLnZlcnNpb24gJiYgci52ZXJzaW9uICE9PSBsYXRlc3QudmVyc2lvbiA/IGAgKHRoZSByZWNvcmRpbmcncyBidWlsZCAke3IudmVyc2lvbn0gaXNuJ3Qga2VwdCBoZXJlKWAgOiBcIlwiKTtcbiAgICB0aGlzLnNheShgJHtyLmV2ZW50cy5sZW5ndGh9IGV2ZW50cywgJHt2ZXJzaW9uc30uIGAgKyAodGhlbiA/IChkaWZmZXIgPyBgJHtkaWZmZXJ9IGV2ZW50cyBhbnN3ZXJlZCBkaWZmZXJlbnRseSwgdGhlIGZpcnN0IGF0IGV2ZW50ICR7Zmlyc3R9LmAgOiBcIkJvdGggYW5zd2VyZWQgZXZlcnkgZXZlbnQgdGhlIHNhbWUuXCIpIDogXCJcIikpO1xuICAgIGlmIChmaXJzdCA+PSAwKSB0aW1lbGluZS5xdWVyeVNlbGVjdG9yKFwiLmdvbmUsIC5uZXdcIik/LnNjcm9sbEludG9WaWV3KHsgYmxvY2s6IFwiY2VudGVyXCIgfSk7XG4gIH1cbn1cbiIsICIvKiogTWluaW1hbCBzY3JvbGxpbmcgcGFuZSBzdXJmYWNlIHNvIGF1dG8tc2Nyb2xsIGxvZ2ljIHN0YXlzIHRlc3RhYmxlIHdpdGhvdXQgYSBicm93c2VyIERPTS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgU2Nyb2xsUGFuZSB7XG4gIHNjcm9sbFRvcDogbnVtYmVyO1xuICByZWFkb25seSBzY3JvbGxIZWlnaHQ6IG51bWJlcjtcbiAgcmVhZG9ubHkgY2xpZW50SGVpZ2h0OiBudW1iZXI7XG4gIHNjcm9sbFRvPyhvcHRpb25zOiB7IHRvcDogbnVtYmVyOyBiZWhhdmlvcj86IFNjcm9sbEJlaGF2aW9yIH0pOiB2b2lkO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEF1dG9TY3JvbGxlck9wdGlvbnMge1xuICAvKiogRGlzdGFuY2UgZnJvbSB0aGUgYm90dG9tIChweCkgdGhhdCBzdGlsbCBjb3VudHMgYXMgcGlubmVkLiAqL1xuICBwaW5UaHJlc2hvbGQ/OiBudW1iZXI7XG4gIC8qKiBEaXN0YW5jZSBmcm9tIHRoZSBib3R0b20gKHB4KSBwYXN0IHdoaWNoIHRoZSBqdW1wLXRvLWxhdGVzdCBjb250cm9sIGlzIHNob3duLiAqL1xuICBqdW1wVGhyZXNob2xkPzogbnVtYmVyO1xuICAvKiogQ2FsbGVkIHdoZW5ldmVyIHRoZSBqdW1wLXRvLWxhdGVzdCBjb250cm9sJ3MgdmlzaWJpbGl0eSBtYXkgaGF2ZSBjaGFuZ2VkLiAqL1xuICBvbkp1bXBDaGFuZ2U/OiAoc2hvdzogYm9vbGVhbikgPT4gdm9pZDtcbiAgLyoqIFdoZW4gdHJ1ZSAoZm9yIGV4YW1wbGUgd2hpbGUgdGhlIGVtcHR5IHN0YXRlIGlzIHNob3duKSwga2VlcCB0aGUganVtcCBjb250cm9sIGhpZGRlbi4gKi9cbiAgaXNFbXB0eT86ICgpID0+IGJvb2xlYW47XG59XG5cbi8qKlxuICogS2VlcHMgYSB0cmFuc2NyaXB0IHBhbmUgcGlubmVkIHRvIHRoZSBib3R0b20gYXMgbWVzc2FnZXMgc3RyZWFtIGluLCB3aXRob3V0IG1lYXN1cmluZ1xuICogbmVhci1ib3R0b20gYWZ0ZXIgYW4gYXBwZW5kIGhhcyBhbHJlYWR5IGdyb3duIHNjcm9sbEhlaWdodCwgYW5kIHlpZWxkcyBpbW1lZGlhdGVseSB3aGVuXG4gKiB0aGUgdXNlciBzY3JvbGxzIHVwIHRvIHJlYWQgZWFybGllciBtZXNzYWdlcy5cbiAqL1xuZXhwb3J0IGNsYXNzIEF1dG9TY3JvbGxlciB7XG4gIHByaXZhdGUgcmVhZG9ubHkgcGFuZTogU2Nyb2xsUGFuZTtcbiAgcHJpdmF0ZSByZWFkb25seSBwaW5UaHJlc2hvbGQ6IG51bWJlcjtcbiAgcHJpdmF0ZSByZWFkb25seSBqdW1wVGhyZXNob2xkOiBudW1iZXI7XG4gIHByaXZhdGUgcmVhZG9ubHkgb25KdW1wQ2hhbmdlPzogKHNob3c6IGJvb2xlYW4pID0+IHZvaWQ7XG4gIHByaXZhdGUgcmVhZG9ubHkgaXNFbXB0eT86ICgpID0+IGJvb2xlYW47XG4gIHByaXZhdGUgcGlubmVkID0gdHJ1ZTtcbiAgcHJpdmF0ZSBqdW1waW5nID0gZmFsc2U7XG4gIHByaXZhdGUgbGFzdFNjcm9sbFRvcCA9IDA7XG5cbiAgY29uc3RydWN0b3IocGFuZTogU2Nyb2xsUGFuZSwgb3B0aW9uczogQXV0b1Njcm9sbGVyT3B0aW9ucyA9IHt9KSB7XG4gICAgdGhpcy5wYW5lID0gcGFuZTtcbiAgICB0aGlzLnBpblRocmVzaG9sZCA9IG9wdGlvbnMucGluVGhyZXNob2xkID8/IDMyO1xuICAgIHRoaXMuanVtcFRocmVzaG9sZCA9IG9wdGlvbnMuanVtcFRocmVzaG9sZCA/PyAxMjA7XG4gICAgdGhpcy5vbkp1bXBDaGFuZ2UgPSBvcHRpb25zLm9uSnVtcENoYW5nZTtcbiAgICB0aGlzLmlzRW1wdHkgPSBvcHRpb25zLmlzRW1wdHk7XG4gICAgdGhpcy5sYXN0U2Nyb2xsVG9wID0gcGFuZS5zY3JvbGxUb3A7XG4gIH1cblxuICBnZXQgaXNQaW5uZWQoKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMucGlubmVkO1xuICB9XG5cbiAgcHJpdmF0ZSBkaXN0YW5jZSgpOiBudW1iZXIge1xuICAgIHJldHVybiBNYXRoLm1heCgwLCB0aGlzLnBhbmUuc2Nyb2xsSGVpZ2h0IC0gdGhpcy5wYW5lLnNjcm9sbFRvcCAtIHRoaXMucGFuZS5jbGllbnRIZWlnaHQpO1xuICB9XG5cbiAgcHJpdmF0ZSBpc1Zpc2libGUoKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMucGFuZS5jbGllbnRIZWlnaHQgPiAwO1xuICB9XG5cbiAgcHJpdmF0ZSBzbmFwVG9Cb3R0b20oKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLmlzVmlzaWJsZSgpKSByZXR1cm47XG4gICAgdGhpcy5wYW5lLnNjcm9sbFRvcCA9IHRoaXMucGFuZS5zY3JvbGxIZWlnaHQ7XG4gICAgdGhpcy5sYXN0U2Nyb2xsVG9wID0gdGhpcy5wYW5lLnNjcm9sbFRvcDtcbiAgfVxuXG4gIHByaXZhdGUgdXBkYXRlSnVtcCgpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMub25KdW1wQ2hhbmdlKSByZXR1cm47XG4gICAgY29uc3QgZW1wdHkgPSB0aGlzLmlzRW1wdHk/LigpID8/IGZhbHNlO1xuICAgIGNvbnN0IHNob3cgPSAhZW1wdHkgJiYgdGhpcy5pc1Zpc2libGUoKSAmJiAhdGhpcy5qdW1waW5nICYmIHRoaXMuZGlzdGFuY2UoKSA+IHRoaXMuanVtcFRocmVzaG9sZDtcbiAgICB0aGlzLm9uSnVtcENoYW5nZShzaG93KTtcbiAgfVxuXG4gIC8qKiBDYWxsIGFmdGVyIGNvbnRlbnQgaXMgYWRkZWQsIHVwZGF0ZWQsIG9yIHJlbW92ZWQgaW4gdGhlIHBhbmUuICovXG4gIG9uQ29udGVudChmb3JjZSA9IGZhbHNlKTogdm9pZCB7XG4gICAgaWYgKGZvcmNlKSB7XG4gICAgICB0aGlzLnBpbm5lZCA9IHRydWU7XG4gICAgICB0aGlzLmp1bXBpbmcgPSBmYWxzZTtcbiAgICB9XG4gICAgaWYgKHRoaXMucGlubmVkKSB7XG4gICAgICBpZiAodGhpcy5qdW1waW5nICYmIHRoaXMucGFuZS5zY3JvbGxUbyAmJiB0aGlzLmlzVmlzaWJsZSgpKSB7XG4gICAgICAgIHRoaXMucGFuZS5zY3JvbGxUbyh7IHRvcDogdGhpcy5wYW5lLnNjcm9sbEhlaWdodCwgYmVoYXZpb3I6IFwic21vb3RoXCIgfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aGlzLnNuYXBUb0JvdHRvbSgpO1xuICAgICAgfVxuICAgIH1cbiAgICB0aGlzLnVwZGF0ZUp1bXAoKTtcbiAgfVxuXG4gIC8qKiBDYWxsIHdoZW4gdGhlIHBhbmUncyB2aWV3cG9ydCByZXNpemVzIChiYXJzIGFwcGVhcmluZywga2V5Ym9hcmQsIHRhYiBzd2l0Y2gpLiAqL1xuICBvblJlc2l6ZSgpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuaXNWaXNpYmxlKCkpIHJldHVybjtcbiAgICBpZiAodGhpcy5waW5uZWQpIHtcbiAgICAgIHRoaXMuanVtcGluZyA9IGZhbHNlO1xuICAgICAgdGhpcy5zbmFwVG9Cb3R0b20oKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5sYXN0U2Nyb2xsVG9wID0gdGhpcy5wYW5lLnNjcm9sbFRvcDtcbiAgICB9XG4gICAgdGhpcy51cGRhdGVKdW1wKCk7XG4gIH1cblxuICAvKiogQ2FsbCBmcm9tIHRoZSBwYW5lJ3Mgc2Nyb2xsIGV2ZW50IGxpc3RlbmVyLiAqL1xuICBvblNjcm9sbCgpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuaXNWaXNpYmxlKCkpIHJldHVybjtcbiAgICBjb25zdCB0b3AgPSB0aGlzLnBhbmUuc2Nyb2xsVG9wO1xuICAgIGNvbnN0IGRpc3QgPSB0aGlzLmRpc3RhbmNlKCk7XG4gICAgY29uc3QgbW92ZWRVcCA9IHRvcCA8IHRoaXMubGFzdFNjcm9sbFRvcDtcbiAgICB0aGlzLmxhc3RTY3JvbGxUb3AgPSB0b3A7XG5cbiAgICBpZiAoZGlzdCA8PSB0aGlzLnBpblRocmVzaG9sZCkge1xuICAgICAgdGhpcy5waW5uZWQgPSB0cnVlO1xuICAgICAgdGhpcy5qdW1waW5nID0gZmFsc2U7XG4gICAgfSBlbHNlIGlmIChtb3ZlZFVwKSB7XG4gICAgICB0aGlzLnBpbm5lZCA9IGZhbHNlO1xuICAgICAgdGhpcy5qdW1waW5nID0gZmFsc2U7XG4gICAgfVxuICAgIHRoaXMudXBkYXRlSnVtcCgpO1xuICB9XG5cbiAgLyoqIENhbGwgZnJvbSB0aGUgcGFuZSdzIHNjcm9sbGVuZCBldmVudCBsaXN0ZW5lci4gKi9cbiAgb25TY3JvbGxFbmQoKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLmlzVmlzaWJsZSgpIHx8ICF0aGlzLmp1bXBpbmcpIHJldHVybjtcbiAgICB0aGlzLmp1bXBpbmcgPSBmYWxzZTtcbiAgICBpZiAodGhpcy5kaXN0YW5jZSgpID4gdGhpcy5waW5UaHJlc2hvbGQpIHRoaXMucGlubmVkID0gZmFsc2U7XG4gICAgdGhpcy51cGRhdGVKdW1wKCk7XG4gIH1cblxuICAvKiogQ2FsbCBvbiB1c2VyIHdoZWVsLXVwIG9yIHRvdWNoc3RhcnQgc28gYW4gYWN0aXZlIHNtb290aCBqdW1wIHlpZWxkcyB0byB0aGUgdXNlci4gKi9cbiAgY2FuY2VsSnVtcCgpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuanVtcGluZykgcmV0dXJuO1xuICAgIHRoaXMuanVtcGluZyA9IGZhbHNlO1xuICAgIGlmICh0aGlzLmlzVmlzaWJsZSgpKSB7XG4gICAgICBjb25zdCB0b3AgPSB0aGlzLnBhbmUuc2Nyb2xsVG9wO1xuICAgICAgaWYgKHRoaXMucGFuZS5zY3JvbGxUbykgdGhpcy5wYW5lLnNjcm9sbFRvKHsgdG9wLCBiZWhhdmlvcjogXCJpbnN0YW50XCIgfSk7XG4gICAgICBlbHNlIHRoaXMucGFuZS5zY3JvbGxUb3AgPSB0b3A7XG4gICAgICB0aGlzLmxhc3RTY3JvbGxUb3AgPSB0aGlzLnBhbmUuc2Nyb2xsVG9wO1xuICAgICAgaWYgKHRoaXMuZGlzdGFuY2UoKSA+IHRoaXMucGluVGhyZXNob2xkKSB0aGlzLnBpbm5lZCA9IGZhbHNlO1xuICAgIH1cbiAgICB0aGlzLnVwZGF0ZUp1bXAoKTtcbiAgfVxuXG4gIC8qKiBSZS1waW4gYW5kIHNjcm9sbCBzbW9vdGhseSB0byB0aGUgYm90dG9tICh1c2VkIGJ5IHRoZSBqdW1wLXRvLWxhdGVzdCBidXR0b24pLiAqL1xuICBqdW1wVG9Cb3R0b20oKTogdm9pZCB7XG4gICAgdGhpcy5waW5uZWQgPSB0cnVlO1xuICAgIGlmICghdGhpcy5pc1Zpc2libGUoKSkge1xuICAgICAgdGhpcy51cGRhdGVKdW1wKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICh0aGlzLmRpc3RhbmNlKCkgPD0gdGhpcy5waW5UaHJlc2hvbGQgfHwgIXRoaXMucGFuZS5zY3JvbGxUbykge1xuICAgICAgdGhpcy5qdW1waW5nID0gZmFsc2U7XG4gICAgICB0aGlzLnNuYXBUb0JvdHRvbSgpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLmp1bXBpbmcgPSB0cnVlO1xuICAgICAgdGhpcy5sYXN0U2Nyb2xsVG9wID0gdGhpcy5wYW5lLnNjcm9sbFRvcDtcbiAgICAgIHRoaXMucGFuZS5zY3JvbGxUbyh7IHRvcDogdGhpcy5wYW5lLnNjcm9sbEhlaWdodCwgYmVoYXZpb3I6IFwic21vb3RoXCIgfSk7XG4gICAgfVxuICAgIHRoaXMudXBkYXRlSnVtcCgpO1xuICB9XG5cbiAgLyoqIFJlY29tcHV0ZSBwaW5uZWQgc3RhdGUgZnJvbSB0aGUgY3VycmVudCBwb3NpdGlvbiBhZnRlciBhIHVzZXItZHJpdmVuIGxheW91dCBjaGFuZ2UgKGUuZy4gZXhwYW5kaW5nIGEgcmVzdWx0KS4gKi9cbiAgc3luY0Zyb21Qb3NpdGlvbigpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuaXNWaXNpYmxlKCkpIHJldHVybjtcbiAgICB0aGlzLmp1bXBpbmcgPSBmYWxzZTtcbiAgICB0aGlzLmxhc3RTY3JvbGxUb3AgPSB0aGlzLnBhbmUuc2Nyb2xsVG9wO1xuICAgIHRoaXMucGlubmVkID0gdGhpcy5kaXN0YW5jZSgpIDw9IHRoaXMucGluVGhyZXNob2xkO1xuICAgIHRoaXMudXBkYXRlSnVtcCgpO1xuICB9XG5cbiAgLyoqIFBhdXNlIGF1dG8tc2Nyb2xsIGV4cGxpY2l0bHkgKGUuZy4gd2hlbiByZXZlYWxpbmcgYW4gb2xkZXIgcmVzdWx0IGNhcmQpLiAqL1xuICB1bnBpbigpOiB2b2lkIHtcbiAgICB0aGlzLnBpbm5lZCA9IGZhbHNlO1xuICAgIHRoaXMuanVtcGluZyA9IGZhbHNlO1xuICAgIHRoaXMudXBkYXRlSnVtcCgpO1xuICB9XG59XG4iLCAiLy8gTWFpbi10aHJlYWQgY29udHJvbGxlciBmb3IgdGhlIHdha2Ugd29yZCBXZWIgV29ya2VyLlxuXG5leHBvcnQgaW50ZXJmYWNlIFdha2VUZWxlbWV0cnkge1xuICBzY29yZTogbnVtYmVyO1xuICBwZWFrOiBudW1iZXI7XG4gIGdhdGVPcGVuOiBib29sZWFuO1xuICBmcmFtZXM6IG51bWJlcjtcbiAgc2NvcmVkOiBudW1iZXI7XG4gIGluZmVyTXM6IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBXYWtlRGV0ZWN0aW9uRXZlbnQge1xuICBzY29yZTogbnVtYmVyO1xuICBhdEZyYW1lOiBudW1iZXI7XG4gIHJlc3Q6IFVpbnQ4QXJyYXk7XG4gIGluZmVyTXM6IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBXYWtlQ2xpZW50Q2FsbGJhY2tzIHtcbiAgb25SZWFkeT86IChtb2RlbElkOiBzdHJpbmcsIHdhcm11cE1zOiBudW1iZXIpID0+IHZvaWQ7XG4gIG9uRGV0ZWN0ZWQ6IChoaXQ6IFdha2VEZXRlY3Rpb25FdmVudCkgPT4gdm9pZDtcbiAgb25UZWxlbWV0cnk/OiAodDogV2FrZVRlbGVtZXRyeSkgPT4gdm9pZDtcbiAgb25FcnJvcj86IChtZXNzYWdlOiBzdHJpbmcpID0+IHZvaWQ7XG59XG5cbmV4cG9ydCBjbGFzcyBXYWtlQ2xpZW50IHtcbiAgcHJpdmF0ZSB3b3JrZXI6IFdvcmtlciB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIGNhbGxiYWNrczogV2FrZUNsaWVudENhbGxiYWNrcztcbiAgcHJpdmF0ZSBsb2FkZWRNb2RlbElkOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBsb2FkaW5nTW9kZWxJZDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgY3VycmVudFRocmVzaG9sZCA9IDAuNztcbiAgcmVhZHkgPSBmYWxzZTtcblxuICBjb25zdHJ1Y3RvcihjYWxsYmFja3M6IFdha2VDbGllbnRDYWxsYmFja3MpIHtcbiAgICB0aGlzLmNhbGxiYWNrcyA9IGNhbGxiYWNrcztcbiAgfVxuXG4gIHByaXZhdGUgZW5zdXJlV29ya2VyKCk6IFdvcmtlciB7XG4gICAgaWYgKHRoaXMud29ya2VyKSByZXR1cm4gdGhpcy53b3JrZXI7XG4gICAgY29uc3Qgd29ya2VyID0gbmV3IFdvcmtlcihcIi93YWtlLndvcmtlci5qc1wiLCB7IHR5cGU6IFwibW9kdWxlXCIgfSk7XG4gICAgd29ya2VyLm9ubWVzc2FnZSA9IChlOiBNZXNzYWdlRXZlbnQ8UmVjb3JkPHN0cmluZywgYW55Pj4pID0+IHtcbiAgICAgIGNvbnN0IG0gPSBlLmRhdGE7XG4gICAgICBpZiAobS50eXBlID09PSBcInJlYWR5XCIpIHtcbiAgICAgICAgdGhpcy5sb2FkaW5nTW9kZWxJZCA9IG51bGw7XG4gICAgICAgIHRoaXMubG9hZGVkTW9kZWxJZCA9IG0ubW9kZWxJZDtcbiAgICAgICAgdGhpcy5yZWFkeSA9IHRydWU7XG4gICAgICAgIHRoaXMuY2FsbGJhY2tzLm9uUmVhZHk/LihtLm1vZGVsSWQsIG0ud2FybXVwTXMpO1xuICAgICAgfSBlbHNlIGlmIChtLnR5cGUgPT09IFwiZGV0ZWN0ZWRcIikge1xuICAgICAgICB0aGlzLmNhbGxiYWNrcy5vbkRldGVjdGVkKHtcbiAgICAgICAgICBzY29yZTogbS5zY29yZSxcbiAgICAgICAgICBhdEZyYW1lOiBtLmF0RnJhbWUsXG4gICAgICAgICAgcmVzdDogbmV3IFVpbnQ4QXJyYXkobS5yZXN0Qnl0ZXMgYXMgQXJyYXlCdWZmZXIpLFxuICAgICAgICAgIGluZmVyTXM6IG0uaW5mZXJNcyxcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2UgaWYgKG0udHlwZSA9PT0gXCJ0ZWxlbWV0cnlcIikge1xuICAgICAgICB0aGlzLmNhbGxiYWNrcy5vblRlbGVtZXRyeT8uKHtcbiAgICAgICAgICBzY29yZTogbS5zY29yZSxcbiAgICAgICAgICBwZWFrOiBtLnBlYWssXG4gICAgICAgICAgZ2F0ZU9wZW46IG0uZ2F0ZU9wZW4sXG4gICAgICAgICAgZnJhbWVzOiBtLmZyYW1lcyxcbiAgICAgICAgICBzY29yZWQ6IG0uc2NvcmVkLFxuICAgICAgICAgIGluZmVyTXM6IG0uaW5mZXJNcyxcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2UgaWYgKG0udHlwZSA9PT0gXCJlcnJvclwiKSB7XG4gICAgICAgIHRoaXMubG9hZGluZ01vZGVsSWQgPSBudWxsO1xuICAgICAgICB0aGlzLnJlYWR5ID0gZmFsc2U7XG4gICAgICAgIHRoaXMuY2FsbGJhY2tzLm9uRXJyb3I/LihTdHJpbmcobS5tZXNzYWdlID8/IFwid2FrZSB3b3JrZXIgZXJyb3JcIikpO1xuICAgICAgfVxuICAgIH07XG4gICAgd29ya2VyLm9uZXJyb3IgPSAoZXJyKSA9PiB7XG4gICAgICB0aGlzLmxvYWRpbmdNb2RlbElkID0gbnVsbDtcbiAgICAgIHRoaXMucmVhZHkgPSBmYWxzZTtcbiAgICAgIHRoaXMuY2FsbGJhY2tzLm9uRXJyb3I/LihlcnIubWVzc2FnZSB8fCBcIndha2Ugd29ya2VyIGZhaWxlZFwiKTtcbiAgICB9O1xuICAgIHRoaXMud29ya2VyID0gd29ya2VyO1xuICAgIHJldHVybiB3b3JrZXI7XG4gIH1cblxuICAvKiogTG9hZHMgKG9yIHN3aXRjaGVzIHRvKSB0aGUgbmFtZWQgbW9kZWw7IHJlc29sdmVzIGltbWVkaWF0ZWx5IHdoZW4gYWxyZWFkeSBsb2FkZWQuICovXG4gIGxvYWQobW9kZWxJZDogc3RyaW5nLCB0aHJlc2hvbGQ6IG51bWJlcik6IHZvaWQge1xuICAgIHRoaXMuY3VycmVudFRocmVzaG9sZCA9IHRocmVzaG9sZDtcbiAgICBjb25zdCB3b3JrZXIgPSB0aGlzLmVuc3VyZVdvcmtlcigpO1xuICAgIGlmICh0aGlzLnJlYWR5ICYmIHRoaXMubG9hZGVkTW9kZWxJZCA9PT0gbW9kZWxJZCkge1xuICAgICAgd29ya2VyLnBvc3RNZXNzYWdlKHsgdHlwZTogXCJjb25maWdcIiwgdGhyZXNob2xkIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAodGhpcy5sb2FkaW5nTW9kZWxJZCA9PT0gbW9kZWxJZCkge1xuICAgICAgd29ya2VyLnBvc3RNZXNzYWdlKHsgdHlwZTogXCJjb25maWdcIiwgdGhyZXNob2xkIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB0aGlzLnJlYWR5ID0gZmFsc2U7XG4gICAgdGhpcy5sb2FkaW5nTW9kZWxJZCA9IG1vZGVsSWQ7XG4gICAgd29ya2VyLnBvc3RNZXNzYWdlKHtcbiAgICAgIHR5cGU6IFwibG9hZFwiLFxuICAgICAgbW9kZWxJZCxcbiAgICAgIHVybDogYC93YWtlL21vZGVscy8ke2VuY29kZVVSSUNvbXBvbmVudChtb2RlbElkKX0ub25ueGAsXG4gICAgICB0aHJlc2hvbGQsXG4gICAgICB3YXNtUGF0aHM6IFwiL29ydC9cIixcbiAgICB9KTtcbiAgfVxuXG4gIHNldFRocmVzaG9sZCh0aHJlc2hvbGQ6IG51bWJlcik6IHZvaWQge1xuICAgIHRoaXMuY3VycmVudFRocmVzaG9sZCA9IHRocmVzaG9sZDtcbiAgICB0aGlzLndvcmtlcj8ucG9zdE1lc3NhZ2UoeyB0eXBlOiBcImNvbmZpZ1wiLCB0aHJlc2hvbGQgfSk7XG4gIH1cblxuICBmZWVkKHNhbXBsZXM6IEludDE2QXJyYXkpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMucmVhZHkgfHwgIXRoaXMud29ya2VyKSByZXR1cm47XG4gICAgY29uc3QgY29weSA9IG5ldyBJbnQxNkFycmF5KHNhbXBsZXMubGVuZ3RoKTtcbiAgICBjb3B5LnNldChzYW1wbGVzKTtcbiAgICB0aGlzLndvcmtlci5wb3N0TWVzc2FnZSh7IHR5cGU6IFwiZmVlZFwiLCBwY206IGNvcHkuYnVmZmVyIH0sIFtjb3B5LmJ1ZmZlcl0pO1xuICB9XG5cbiAgcmVzZXQoKTogdm9pZCB7XG4gICAgdGhpcy53b3JrZXI/LnBvc3RNZXNzYWdlKHsgdHlwZTogXCJyZXNldFwiIH0pO1xuICB9XG5cbiAgZGlzcG9zZSgpOiB2b2lkIHtcbiAgICB0aGlzLnJlYWR5ID0gZmFsc2U7XG4gICAgdGhpcy5sb2FkZWRNb2RlbElkID0gbnVsbDtcbiAgICB0aGlzLmxvYWRpbmdNb2RlbElkID0gbnVsbDtcbiAgICBpZiAodGhpcy53b3JrZXIpIHtcbiAgICAgIHRoaXMud29ya2VyLnBvc3RNZXNzYWdlKHsgdHlwZTogXCJkaXNwb3NlXCIgfSk7XG4gICAgICB0aGlzLndvcmtlci50ZXJtaW5hdGUoKTtcbiAgICAgIHRoaXMud29ya2VyID0gbnVsbDtcbiAgICB9XG4gIH1cblxuICBnZXQgbW9kZWxJZCgpOiBzdHJpbmcgfCBudWxsIHtcbiAgICByZXR1cm4gdGhpcy5sb2FkZWRNb2RlbElkID8/IHRoaXMubG9hZGluZ01vZGVsSWQ7XG4gIH1cblxuICBnZXQgdGhyZXNob2xkKCk6IG51bWJlciB7XG4gICAgcmV0dXJuIHRoaXMuY3VycmVudFRocmVzaG9sZDtcbiAgfVxufVxuIiwgIi8vIFRoZSB3ZWIgc3VyZmFjZTogYSBmb3VydGggaG9zdCBmb3IgdGhlIHZvaWNlIGNvcmUsIGFuZCBhIHBob25lLWZyaWVuZGx5IHdheSB0byB1c2UgaXQgZm9yIHdvcmsuXG4vLyBJdCBsb2FkcyB0aGUgZGV2IHNlcnZlcidzIGxhdGVzdCBidWlsZCBhdCBlYWNoIGNhbGwsIHNvIGFuIGVkaXQgaW4gc3JjLyBpcyBsaXZlIG9uIHRoZSBuZXh0XG4vLyBjYWxsLCBhbmQga2VlcHMgZXZlcnkgY2FsbCBhcyBhIHRyYWNlIHRoZSByZXBsYXkgdmlldyAoYW5kIGFueSBvdGhlciBob3N0KSBjYW4gcnVuIGFnYWluLlxuLy9cbi8vIFRoZSBob3N0J3MgcGFydCBpcyBzbWFsbDogdGhlIG1pY3JvcGhvbmUgYW5kIHNwZWFrZXIgKGF1ZGlvLnRzKSwgdGhlIG1vZGVsJ3Mgc29ja2V0IHRocm91Z2ggdGhlXG4vLyBzZXJ2ZXIncyByZWxheSwgSGVybWVzIGFuZCBUMyB0aHJvdWdoIHRoZSBzZXJ2ZXIsIGFuZCB0aGUgc2NyZWVuLiBUaGUgY29yZSBkZWNpZGVzIHRoZSByZXN0LlxuLy9cbi8vIFR5cGluZyB3aXRoIG5vIGNhbGwgb24gc3RhcnRzIGEgY2hhdCBpbnN0ZWFkOiB0aGUgc2FtZSBjb3JlIHdpdGggYG1lZGl1bTogXCJ0ZXh0XCJgLCB3aG9zZSByZXF1ZXN0c1xuLy8gdG8gdGhlIHRleHQgbW9kZWwgZ28gdGhyb3VnaCB0aGUgc2VydmVyJ3MgL2dlbmVyYXRlLiBUYXNrcywgZm9sbG93LXVwcyBhbmQgdGhlaXIgY2FyZHMgd29yayBhc1xuLy8gaW4gYSBjYWxsLiBQcmVzc2luZyBDYWxsIGVuZHMgdGhlIGNoYXQgYW5kIGNhcnJpZXMgaXRzIGNvbnZlcnNhdGlvbiBvbiBieSB2b2ljZS5cblxuaW1wb3J0IHsgY29tbWFuZEluIH0gZnJvbSBcIi4uL3NyYy9jb21tYW5kcy50c1wiO1xuaW1wb3J0IHsgQ2FsbEF1ZGlvLCBieXRlc1RvQmFzZTY0IH0gZnJvbSBcIi4vYXVkaW8udHNcIjtcbmltcG9ydCB7IFJlcGxheSB9IGZyb20gXCIuL3JlcGxheS50c1wiO1xuaW1wb3J0IHsgQXV0b1Njcm9sbGVyIH0gZnJvbSBcIi4vc2Nyb2xsLnRzXCI7XG5pbXBvcnQgeyBXYWtlQ2xpZW50LCB0eXBlIFdha2VEZXRlY3Rpb25FdmVudCwgdHlwZSBXYWtlVGVsZW1ldHJ5IH0gZnJvbSBcIi4vd2FrZUNsaWVudC50c1wiO1xuXG5pbnRlcmZhY2UgQ29yZSB7XG4gIHZlcnNpb246IHN0cmluZztcbiAgZGVmYXVsdHMoKTogc3RyaW5nO1xuICBjcmVhdGUoY29uZmlnOiBzdHJpbmcsIHQ6IG51bWJlcik6IHN0cmluZztcbiAgcHVzaChpZDogbnVtYmVyLCBldmVudDogc3RyaW5nKTogc3RyaW5nO1xuICB0cmFjZShpZDogbnVtYmVyKTogc3RyaW5nO1xuICBkaXNwb3NlKGlkOiBudW1iZXIpOiB2b2lkO1xufVxudHlwZSBDb21tYW5kID0gUmVjb3JkPHN0cmluZywgYW55PiAmIHsgdHlwZTogc3RyaW5nIH07XG5pbnRlcmZhY2UgV2FrZU1vZGVsSW5mbyB7IGlkOiBzdHJpbmc7IGxhYmVsOiBzdHJpbmcgfVxuaW50ZXJmYWNlIFNlcnZlckNvbmZpZyB7IHJvdXRlOiBzdHJpbmc7IG1vZGVsOiBzdHJpbmc7IGNhcHRpb25zTW9kZWw/OiBzdHJpbmc7IHRleHRNb2RlbD86IHN0cmluZzsgdmVyc2lvbjogc3RyaW5nOyBoZXJtZXM6IGJvb2xlYW47IHQzOiBzdHJpbmdbXSB8IG51bGw7IHdha2VNb2RlbHM/OiBXYWtlTW9kZWxJbmZvW10gfVxuXG5jb25zdCAkID0gPFQgZXh0ZW5kcyBIVE1MRWxlbWVudCA9IEhUTUxFbGVtZW50PihpZDogc3RyaW5nKSA9PiBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChpZCkgYXMgVDtcbmNvbnN0IG5vdyA9ICgpID0+IHBlcmZvcm1hbmNlLm5vdygpIC8gMTAwMDtcbmNvbnN0IGNoZWNrZWQgPSAoaWQ6IHN0cmluZykgPT4gJDxIVE1MSW5wdXRFbGVtZW50PihpZCkuY2hlY2tlZDtcblxuLyoqIFRoZSBsYXRlc3QgYnVpbGQgZnJvbSB0aGUgZGV2IHNlcnZlciwgZXZhbHVhdGVkIGFmcmVzaDogYW4gZWRpdCBpbiBzcmMvIGlzIGluIHRoZSBuZXh0IGNhbGwuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbG9hZENvcmUodXJsID0gXCIvdm9pY2UtY29yZS5qc1wiKTogUHJvbWlzZTxDb3JlPiB7XG4gIGNvbnN0IHNvdXJjZSA9IGF3YWl0IChhd2FpdCBmZXRjaCh1cmwsIHsgY2FjaGU6IFwibm8tc3RvcmVcIiB9KSkudGV4dCgpO1xuICBjb25zdCBzY29wZTogeyBWb2ljZUNvcmU/OiBDb3JlIH0gPSB7fTtcbiAgbmV3IEZ1bmN0aW9uKFwiZ2xvYmFsVGhpc1wiLCBzb3VyY2UpKHNjb3BlKTtcbiAgaWYgKCFzY29wZS5Wb2ljZUNvcmUpIHRocm93IG5ldyBFcnJvcihcInRoZSBidW5kbGUgZGlkbid0IGRlZmluZSBWb2ljZUNvcmVcIik7XG4gIHJldHVybiBzY29wZS5Wb2ljZUNvcmU7XG59XG5cbi8vIFByZXNldHM6IGVhY2ggc3VyZmFjZSdzIHNldHRpbmdzIGFzIGl0cyBhcHAgd291bGQgc2V0IHRoZW0uXG5cbmNvbnN0IEZBS0VfVFYgPSBbXG4gIHsgbmFtZTogXCJ0dl92b2x1bWVcIiwgZGVzY3JpcHRpb246IFwiU2V0cyB0aGUgbGl2aW5nLXJvb20gVFYncyB2b2x1bWUsIDAgdG8gMTAwLlwiLCBwYXJhbWV0ZXJzOiB7IHR5cGU6IFwiT0JKRUNUXCIsIHByb3BlcnRpZXM6IHsgbGV2ZWw6IHsgdHlwZTogXCJJTlRFR0VSXCIgfSB9LCByZXF1aXJlZDogW1wibGV2ZWxcIl0gfSB9LFxuICB7IG5hbWU6IFwidHZfcGF1c2VcIiwgZGVzY3JpcHRpb246IFwiUGF1c2VzIG9yIHJlc3VtZXMgd2hhdCdzIHBsYXlpbmcgb24gdGhlIFRWLlwiLCBwYXJhbWV0ZXJzOiB7IHR5cGU6IFwiT0JKRUNUXCIsIHByb3BlcnRpZXM6IHsgcGF1c2U6IHsgdHlwZTogXCJCT09MRUFOXCIgfSB9IH0gfSxcbl07XG5cbmNvbnN0IFBSRVNFVFM6IFJlY29yZDxzdHJpbmcsIFJlY29yZDxzdHJpbmcsIHVua25vd24+PiA9IHtcbiAgd2ViOiB7IHBsYXRmb3JtOiBcIndlYlwiLCBkZXZpY2U6IFwiYnJvd3NlclwiLCBzdGFuZGJ5QWZ0ZXI6IDMwLCBoYW5nVXBBZnRlcjogMzAwLCBoYW5kT2ZmOiBcIm5hbWVkXCIsIHN1cGVydmlzZTogdHJ1ZSwgdm9jYWJ1bGFyeTogW1wiSGVybWVzXCIsIFwiQmVudG9cIiwgXCJXb29kaG91c2VcIiwgXCJQZW5ueXdvcnRoXCIsIFwiVDNcIl0gfSxcbiAgXCJ3ZWIgd2FrZSB3b3JkXCI6IHtcbiAgICBwbGF0Zm9ybTogXCJ3ZWJcIiwgZGV2aWNlOiBcImJyb3dzZXJcIiwgc3RhbmRieUFmdGVyOiAyMCwgaGFuZ1VwQWZ0ZXI6IDEyMCwgaGFuZE9mZjogXCJuYW1lZFwiLCBzdXBlcnZpc2U6IHRydWUsXG4gICAgYXR0ZW50aW9uOiB7IG1vZGU6IFwid2luZG93XCIsIGFmdGVyV2FrZTogOCwgd2luZG93OiA1LCBhZnRlclF1ZXN0aW9uOiAxMCwgYWZ0ZXJIYW5kT2ZmOiAzLCBhZnRlckFubm91bmNlbWVudDogMCB9LFxuICAgIHZvY2FidWxhcnk6IFtcIkhlcm1lc1wiLCBcIkJlbnRvXCIsIFwiV29vZGhvdXNlXCIsIFwiUGVubnl3b3J0aFwiLCBcIlQzXCJdLFxuICB9LFxuICBhbmRyb2lkOiB7IHBsYXRmb3JtOiBcIkFuZHJvaWRcIiwgZGV2aWNlOiBcInBob25lXCIsIHN0YW5kYnlBZnRlcjogMjAgfSxcbiAgXCJhbmRyb2lkIHdha2Ugd29yZFwiOiB7IHBsYXRmb3JtOiBcIkFuZHJvaWRcIiwgZGV2aWNlOiBcInBob25lXCIsIHN0YW5kYnlBZnRlcjogMjAsIGhhbmdVcEFmdGVyOiAxNSB9LFxuICBtYWNvczogeyBwbGF0Zm9ybTogXCJtYWNPU1wiLCBkZXZpY2U6IFwiTWFjXCIsIHN0YW5kYnlBZnRlcjogMjAgfSxcbiAgZWNobzoge1xuICAgIHBsYXRmb3JtOiBcIkVjaG9cIiwgZGV2aWNlOiBcInNwZWFrZXJcIiwgaGFuZ1VwQWZ0ZXI6IDYsIHN0YW5kYnlBZnRlcjogOCwgZWFyY29uczogdHJ1ZSwgdm9jYWJ1bGFyeTogW1wiSGVybWVzXCIsIFwiQmVudG9cIiwgXCJXb29kaG91c2VcIl0sXG4gICAgbWljOiB7IHdoaWxlU3BlYWtpbmc6IFwid2FrZVwiLCBnYWluRGI6IDAgfSwgaG9zdFRvb2xzOiBGQUtFX1RWLFxuICB9LFxufTtcblxuLy8gU3RhdGUuXG5cbmNvbnN0IGF1ZGlvID0gbmV3IENhbGxBdWRpbygpO1xubGV0IHNlcnZlcjogU2VydmVyQ29uZmlnO1xubGV0IGNvcmU6IENvcmUgfCBudWxsID0gbnVsbDtcbmxldCBjYWxsSWQgPSAwO1xubGV0IGNhbGxOYW1lID0gXCJcIjtcbmxldCB0aWNrZXIgPSAwO1xubGV0IHRyYWNlVGltZXIgPSAwO1xubGV0IHN0YXJ0ZWRBdCA9IG5vdygpO1xuY29uc3Qgc29ja2V0cyA9IG5ldyBNYXA8bnVtYmVyLCBXZWJTb2NrZXQ+KCk7XG4vKiogVGhlIHNvY2tldHMgdG8gdGhlIHRyYW5zY3JpcHRpb24gbW9kZWw6IHRoZWlyIGF1ZGlvIGlzIHRoZSBtb2RlbCdzIGFnYWluLCBzbyBpdCBpc24ndCBjb3VudGVkIG9yIGxvZ2dlZCB0d2ljZS4gKi9cbmNvbnN0IGNhcHRpb25Tb2NrZXRzID0gbmV3IFNldDxudW1iZXI+KCk7XG5jb25zdCBydW5zID0gbmV3IE1hcDxzdHJpbmcsIHsgYWJvcnQ6IEFib3J0Q29udHJvbGxlcjsgYWdlbnQ6IHN0cmluZzsgdGFza0lkOiBzdHJpbmcgfT4oKTtcbmludGVyZmFjZSBUYXNrVmlldyB7IGM6IENvbW1hbmQ7IHNpbmNlOiBudW1iZXI7IGVuZGVkOiBudW1iZXIgfCBudWxsOyB0aHJlYWQ/OiBzdHJpbmc7IHJlc3VsdD86IEhUTUxFbGVtZW50OyBhcHByb3ZhbD86IHsgY29tbWFuZDogc3RyaW5nIH0gfVxuY29uc3QgdGFza3MgPSBuZXcgTWFwPHN0cmluZywgVGFza1ZpZXc+KCk7XG5sZXQgZWFybGllckFjdGl2ZUNvdW50ID0gMDtcbmxldCBlYXJsaWVyV2FpdGluZ0NvdW50ID0gMDtcbmxldCBjb3VudHMgPSB7IG1pYzogMCwgcGxheTogMCwgc2VudDogMCB9O1xubGV0IGZha2VUdkxldmVsID0gMTU7XG5sZXQgY29yZVN0YXR1cyA9IFwiaWRsZVwiO1xubGV0IG11dGVkID0gZmFsc2U7XG5sZXQgaG9sZGluZyA9IGZhbHNlO1xubGV0IHdha2VMb2NrOiB7IHJlbGVhc2UoKTogUHJvbWlzZTx2b2lkPiB9IHwgbnVsbCA9IG51bGw7XG4vKiogV2FrZSB3b3JkIGxvb3Agc3RhdGU6IGFybWVkIGJldHdlZW4gY2FsbHMsIHJlcXVlc3RlZCBieSBjb3JlIHdoaWxlIGRvcm1hbnQvc3BlYWtpbmcsIG9yIG1pZC1oYW5kb2ZmLiAqL1xubGV0IHdha2VBcm1lZCA9IGZhbHNlO1xubGV0IGNvcmVXYW50c1dha2UgPSBmYWxzZTtcbmxldCB3YWtlTG9hZGluZyA9IGZhbHNlO1xubGV0IHdha2VTdGFydGluZyA9IGZhbHNlO1xubGV0IG9wZW5pbmdDaHVua3M6IFVpbnQ4QXJyYXlbXSA9IFtdO1xubGV0IG9wZW5pbmdCeXRlcyA9IDA7XG5jb25zdCBPUEVOSU5HX01BWF9CWVRFUyA9IDEwICogMzJfMDAwO1xubGV0IHdha2VMYXN0VGVsOiBXYWtlVGVsZW1ldHJ5IHwgbnVsbCA9IG51bGw7XG4vKiogV2hhdCB0aGUgc2Vzc2lvbiBvbiBzY3JlZW4gaXM6IGEgdm9pY2UgY2FsbCwgb3IgYSB0eXBlZCBjaGF0ICh0aGUgY29yZSdzIG1lZGl1bSBcInRleHRcIikuICovXG5sZXQgbWVkaXVtOiBcInZvaWNlXCIgfCBcInRleHRcIiA9IFwidm9pY2VcIjtcbi8qKiBBIGNoYXQncyBtb2RlbCBpcyB3cml0aW5nIGl0cyBhbnN3ZXIuICovXG5sZXQgdGhpbmtpbmcgPSBmYWxzZTtcbi8qKiBBIGNoYXQncyByZXF1ZXN0cyB0byB0aGUgdGV4dCBtb2RlbCB0aGF0IGFyZSB1bmRlciB3YXkuICovXG5jb25zdCByZXF1ZXN0cyA9IG5ldyBNYXA8bnVtYmVyLCBBYm9ydENvbnRyb2xsZXI+KCk7XG4vKiogVGhlIGxhc3Qgc2Vzc2lvbiB3aW5kaW5nIGRvd24gKGl0cyB0cmFjZSBzYXZlZCwgdGhlIGNvcmUncyBjYWxsIGRpc3Bvc2VkKTogdGhlIG5leHQgc3RhcnRzIGFmdGVyIGl0LiAqL1xubGV0IGVuZGluZzogUHJvbWlzZTx2b2lkPiA9IFByb21pc2UucmVzb2x2ZSgpO1xuXG4vLyBUaGUgY29udmVyc2F0aW9uLCBrZXB0IHNvIGEgbmV3IGNhbGwgY2FuIGNhcnJ5IG9uIGZyb20gaXQgKHRoZSBjb3JlJ3MgYGhpc3RvcnlgLCByZWNhcHBlZCB0byB0aGUgbW9kZWwpLlxuaW50ZXJmYWNlIENoYXRMaW5lIHsgcm9sZTogXCJ1c2VyXCIgfCBcImFzc2lzdGFudFwiOyBzcGVha2VyPzogc3RyaW5nOyB0ZXh0OiBzdHJpbmcgfVxuY29uc3QgSElTVE9SWSA9IFwidm9pY2UuaGlzdG9yeVwiO1xuY29uc3QgSElTVE9SWV9NQVhfQUdFID0gMTIgKiAzNjAwICogMTAwMDtcbmxldCBjaGF0OiBDaGF0TGluZVtdID0gW107XG4vKiogVGhlIGNvcmUncyBudW1iZXIgZm9yIHRoZSBsaW5lIHRoZSBsYXN0IHdvcmRzIHdlcmUgcmVtZW1iZXJlZCBvbiwgdW50aWwgc29tZXRoaW5nIGVsc2UgaXMuICovXG5sZXQgbGFzdExpbmU6IG51bWJlciB8IG51bGwgPSBudWxsO1xuXG5mdW5jdGlvbiByZW1lbWJlcihyb2xlOiBcInVzZXJcIiB8IFwiYXNzaXN0YW50XCIsIHRleHQ6IHN0cmluZywgc3BlYWtlcj86IHN0cmluZywgam9pbiA9IGZhbHNlKSB7XG4gIGNvbnN0IGxhc3QgPSBjaGF0LmF0KC0xKTtcbiAgaWYgKGpvaW4gJiYgbGFzdCAmJiBsYXN0LnJvbGUgPT09IHJvbGUgJiYgbGFzdC5zcGVha2VyID09PSBzcGVha2VyKSBsYXN0LnRleHQgKz0gdGV4dDtcbiAgZWxzZSBjaGF0LnB1c2goc3BlYWtlciA/IHsgcm9sZSwgc3BlYWtlciwgdGV4dCB9IDogeyByb2xlLCB0ZXh0IH0pO1xuICBpZiAoY2hhdC5sZW5ndGggPiAyMDApIGNoYXQuc3BsaWNlKDAsIGNoYXQubGVuZ3RoIC0gMjAwKTtcbiAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oSElTVE9SWSwgSlNPTi5zdHJpbmdpZnkoeyBhdDogRGF0ZS5ub3coKSwgY2hhdCB9KSk7XG59XG5cbmZ1bmN0aW9uIHNhdmVkSGlzdG9yeSgpOiBDaGF0TGluZVtdIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBzYXZlZCA9IEpTT04ucGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oSElTVE9SWSkgPz8gXCJudWxsXCIpO1xuICAgIHJldHVybiBzYXZlZCAmJiBEYXRlLm5vdygpIC0gc2F2ZWQuYXQgPCBISVNUT1JZX01BWF9BR0UgJiYgQXJyYXkuaXNBcnJheShzYXZlZC5jaGF0KSA/IHNhdmVkLmNoYXQgOiBbXTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG59XG5cbi8qKiBUd28tbm90ZSBjaGltZSwgUENNMTYgbW9ubyBhdCAyNCBrSHosIGJhc2U2NC4gKi9cbmZ1bmN0aW9uIHR3b05vdGVUb25lKGYxOiBudW1iZXIsIGYyOiBudW1iZXIsIG5vdGVTZWM6IG51bWJlciwgYW1wOiBudW1iZXIpOiBzdHJpbmcge1xuICBjb25zdCByYXRlID0gMjQwMDAsIG4gPSBNYXRoLnJvdW5kKHJhdGUgKiBub3RlU2VjICogMiksIGhhbGYgPSBNYXRoLnJvdW5kKHJhdGUgKiBub3RlU2VjKSwgb3V0ID0gbmV3IEludDE2QXJyYXkobik7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgbjsgaSsrKSB7XG4gICAgY29uc3QgZmlyc3QgPSBpIDwgaGFsZjtcbiAgICBjb25zdCB0ID0gaSAvIHJhdGUsIGYgPSBmaXJzdCA/IGYxIDogZjIsIGxvY2FsID0gZmlyc3QgPyB0IDogdCAtIG5vdGVTZWM7XG4gICAgY29uc3QgZW52ID0gTWF0aC5taW4oMSwgbG9jYWwgKiA2MCwgKG5vdGVTZWMgLSBsb2NhbCkgKiA2MCk7XG4gICAgb3V0W2ldID0gTWF0aC5yb3VuZChNYXRoLnNpbigyICogTWF0aC5QSSAqIGYgKiB0KSAqIE1hdGgubWF4KDAsIGVudikgKiBhbXApO1xuICB9XG4gIHJldHVybiBieXRlc1RvQmFzZTY0KG5ldyBVaW50OEFycmF5KG91dC5idWZmZXIpKTtcbn1cblxuLyoqIFR3byByaXNpbmcgbm90ZXM6IHNvbWV0aGluZyBvbiB0aGUgc2NyZWVuIG5lZWRzIHRoZSB1c2VyLiAqL1xuY29uc3QgQVBQUk9WQUxfVE9ORSA9IHR3b05vdGVUb25lKDY2MCwgODgwLCAwLjE2LCA2MDAwKTtcbi8qKiBDcmlzcCByaXNpbmcgY2hpbWU6IHRoZSB3YWtlIHdvcmQgZmlyZWQgKHN0YXJ0IHNpZ25hbCkuICovXG5jb25zdCBXQUtFX1RPTkUgPSB0d29Ob3RlVG9uZSg1ODcuMzMsIDg4MCwgMC4xMSwgNTUwMCk7XG4vKiogU29mdCBmYWxsaW5nIGNoaW1lOiB0aGUgYXR0ZW50aW9uIHdpbmRvdyBjbG9zZWQgYW5kIHRoZSBjYWxsIHdlbnQgZG9ybWFudCAoZW5kIHNpZ25hbCkuICovXG5jb25zdCBTTEVFUF9UT05FID0gdHdvTm90ZVRvbmUoNjU5LjI1LCA0OTMuODgsIDAuMTEsIDM0MDApO1xuXG4vLyBMYXRlbmN5OiB0aGUgbmV0d29yaydzIHJvdW5kIHRyaXAsIGFuZCBob3cgbG9uZyBhZnRlciB0aGUgdXNlciBzdG9wcyB0YWxraW5nIHRoZSByZXBseSBzdGFydHMuXG5jb25zdCBtZXRyaWNzID0geyBydHQ6IFtdIGFzIG51bWJlcltdLCByZXBseTogW10gYXMgbnVtYmVyW10sIGxhc3RWb2ljZTogMCwgbGFzdFBsYXk6IDAsIHJlcGxpZWQ6IHRydWUgfTtcblxuZnVuY3Rpb24gbWVkaWFuKHhzOiBudW1iZXJbXSk6IG51bWJlciB8IG51bGwge1xuICBpZiAoeHMubGVuZ3RoID09PSAwKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgcyA9IFsuLi54c10uc29ydCgoYSwgYikgPT4gYSAtIGIpO1xuICByZXR1cm4gc1tNYXRoLmZsb29yKHMubGVuZ3RoIC8gMildO1xufVxuXG5mdW5jdGlvbiBzaG93TWV0cmljcygpIHtcbiAgY29uc3QgcGFydHM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IHJ0dCA9IG1lZGlhbihtZXRyaWNzLnJ0dCk7XG4gIGlmIChydHQgIT0gbnVsbCkgcGFydHMucHVzaChgJHtNYXRoLnJvdW5kKHJ0dCAqIDEwMDApfSBtc2ApO1xuICBjb25zdCByZXBseSA9IG1lZGlhbihtZXRyaWNzLnJlcGx5KTtcbiAgaWYgKHJlcGx5ICE9IG51bGwpIHBhcnRzLnB1c2goYHJlcGx5ICR7bWV0cmljcy5yZXBseS5hdCgtMSkhLnRvRml4ZWQoMSl9cyAoJHtyZXBseS50b0ZpeGVkKDEpfXMgbWVkKWApO1xuICBjb25zdCBvdXQgPSBhdWRpby5vdXRwdXRMYXRlbmN5O1xuICBpZiAob3V0ICE9IG51bGwpIHBhcnRzLnB1c2goYGF1ZGlvICR7TWF0aC5yb3VuZChvdXQgKiAxMDAwKX0gbXNgKTtcbiAgbGV0IGJ1ZmZlcmVkID0gMDtcbiAgZm9yIChjb25zdCB3cyBvZiBzb2NrZXRzLnZhbHVlcygpKSBidWZmZXJlZCArPSB3cy5idWZmZXJlZEFtb3VudDtcbiAgaWYgKGJ1ZmZlcmVkID4gMzJfMDAwKSBwYXJ0cy5wdXNoKGB1cGxvYWQgKyR7KGJ1ZmZlcmVkIC8gMzJfMDAwKS50b0ZpeGVkKDEpfXNgKTtcbiAgJChcIm1ldHJpY3NcIikudGV4dENvbnRlbnQgPSBwYXJ0cy5qb2luKFwiIFx1MDBCNyBcIik7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHBpbmcoKSB7XG4gIGNvbnN0IHQgPSBub3coKTtcbiAgdHJ5IHtcbiAgICBhd2FpdCBmZXRjaChcIi9waW5nXCIsIHsgY2FjaGU6IFwibm8tc3RvcmVcIiB9KTtcbiAgICBtZXRyaWNzLnJ0dC5wdXNoKG5vdygpIC0gdCk7XG4gICAgaWYgKG1ldHJpY3MucnR0Lmxlbmd0aCA+IDEyKSBtZXRyaWNzLnJ0dC5zaGlmdCgpO1xuICB9IGNhdGNoIHt9XG4gIHNob3dNZXRyaWNzKCk7XG59XG5cbi8vIFRoZW1lLlxuXG5mdW5jdGlvbiBhcHBseVRoZW1lKGNob2ljZTogc3RyaW5nKSB7XG4gIGNvbnN0IHJvb3QgPSBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQ7XG4gIGlmIChjaG9pY2UgPT09IFwiZGFya1wiIHx8IGNob2ljZSA9PT0gXCJsaWdodFwiKSByb290LmRhdGFzZXQudGhlbWUgPSBjaG9pY2U7XG4gIGVsc2UgZGVsZXRlIHJvb3QuZGF0YXNldC50aGVtZTtcbiAgY29uc3QgZGFyayA9IGNob2ljZSA9PT0gXCJkYXJrXCIgfHwgKGNob2ljZSAhPT0gXCJsaWdodFwiICYmIG1hdGNoTWVkaWEoXCIocHJlZmVycy1jb2xvci1zY2hlbWU6IGRhcmspXCIpLm1hdGNoZXMpO1xuICBjb25zdCBtZXRhID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJ0aGVtZS1jb2xvclwiKTtcbiAgaWYgKG1ldGEpIG1ldGEuc2V0QXR0cmlidXRlKFwiY29udGVudFwiLCBkYXJrID8gXCIjMGUwZjBmXCIgOiBcIiNmNmY1ZjBcIik7XG4gIGZvciAoY29uc3QgYnRuIG9mIEFycmF5LmZyb20oZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MQnV0dG9uRWxlbWVudD4oXCIjdGhlbWUtcGlja2VyIGJ1dHRvblwiKSkpIHtcbiAgICBidG4uY2xhc3NMaXN0LnRvZ2dsZShcIm9uXCIsIGJ0bi5kYXRhc2V0LnRoZW1lID09PSAoY2hvaWNlIHx8IFwic3lzdGVtXCIpKTtcbiAgfVxufVxuXG4vLyBUaGUgc2NyZWVuLlxuXG5mdW5jdGlvbiBzZXRDYWxsQnV0dG9uKGxpdmU6IGJvb2xlYW4pIHtcbiAgY29uc3QgYnRuID0gJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJjYWxsXCIpO1xuICBidG4uY2xhc3NMaXN0LnRvZ2dsZShcImxpdmVcIiwgbGl2ZSk7XG4gIGNvbnN0IGxhYmVsID0gYnRuLnF1ZXJ5U2VsZWN0b3IoXCIuY2FsbC1sYWJlbFwiKTtcbiAgaWYgKGxhYmVsKSBsYWJlbC50ZXh0Q29udGVudCA9IGxpdmUgPyBcIkhhbmcgdXBcIiA6IFwiQ2FsbFwiO1xufVxuXG5mdW5jdGlvbiBzeW5jUmVzdW1lQnV0dG9ucyhzaG93OiBib29sZWFuKSB7XG4gICQoXCJyZXN1bWVcIikuaGlkZGVuID0gIXNob3c7XG4gICQoXCJoZXJvLXJlc3VtZVwiKS5oaWRkZW4gPSAhc2hvdztcbn1cblxuZnVuY3Rpb24gcGFyc2VQcmVmaXgodGV4dDogc3RyaW5nKTogeyBtb2RlOiBcImhlcm1lc1wiIHwgXCJ0M1wiIHwgbnVsbDsgcmVzdDogc3RyaW5nIH0ge1xuICBjb25zdCBtID0gdGV4dC5tYXRjaCgvXlxcLyh0M3xjb2RlfGh8aGVybWVzKVxccysoLiopJC9pcyk7XG4gIGlmICghbSkgcmV0dXJuIHsgbW9kZTogbnVsbCwgcmVzdDogdGV4dCB9O1xuICByZXR1cm4geyBtb2RlOiAvXih0M3xjb2RlKSQvaS50ZXN0KG1bMV0pID8gXCJ0M1wiIDogXCJoZXJtZXNcIiwgcmVzdDogbVsyXS50cmltKCkgfTtcbn1cblxuZnVuY3Rpb24gc3luY0NvbXBvc2VyKCkge1xuICBjb25zdCBpbnB1dCA9ICQ8SFRNTElucHV0RWxlbWVudD4oXCJ0ZXh0XCIpO1xuICBjb25zdCB0cmltbWVkID0gaW5wdXQudmFsdWUudHJpbSgpO1xuICAkKFwic2VuZGJ0blwiKS5jbGFzc0xpc3QudG9nZ2xlKFwicmVhZHlcIiwgdHJpbW1lZC5sZW5ndGggPiAwKTtcbiAgY29uc3QgcGFyc2VkID0gcGFyc2VQcmVmaXgodHJpbW1lZCk7XG4gICQoXCJtb2RlLXdyYXBcIikuZGF0YXNldC5tb2RlID0gcGFyc2VkLm1vZGUgPz8gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJtb2RlXCIpLnZhbHVlO1xufVxuXG5mdW5jdGlvbiBmb3JtYXRDbG9jayhzZWNvbmRzOiBudW1iZXIpOiBzdHJpbmcge1xuICBjb25zdCB0b3RhbCA9IE1hdGgubWF4KDAsIE1hdGguZmxvb3Ioc2Vjb25kcykpO1xuICBjb25zdCBoID0gTWF0aC5mbG9vcih0b3RhbCAvIDM2MDApO1xuICBjb25zdCBtID0gTWF0aC5mbG9vcigodG90YWwgJSAzNjAwKSAvIDYwKTtcbiAgY29uc3QgcyA9IHRvdGFsICUgNjA7XG4gIGNvbnN0IHBhZCA9IChuOiBudW1iZXIpID0+IFN0cmluZyhuKS5wYWRTdGFydCgyLCBcIjBcIik7XG4gIHJldHVybiBoID4gMCA/IGAke2h9OiR7cGFkKG0pfToke3BhZChzKX1gIDogYCR7cGFkKG0pfToke3BhZChzKX1gO1xufVxuXG5jb25zdCBWSVpfV0VJR0hUUyA9IFswLjQ4LCAwLjg2LCAxLjAsIDAuNzgsIDAuNDRdO1xuZnVuY3Rpb24gdXBkYXRlVmlzdWFsaXplcihtb2RlOiBzdHJpbmcsIGxldmVsOiBudW1iZXIpIHtcbiAgY29uc3Qgdml6ID0gJChcInZpelwiKTtcbiAgdml6LmRhdGFzZXQubW9kZSA9IG1vZGU7XG4gIGNvbnN0IGJhcnMgPSB2aXouY2hpbGRyZW47XG4gIGlmIChtb2RlID09PSBcImxpc3RlbmluZ1wiIHx8IG1vZGUgPT09IFwid29ya2luZ1wiKSB7XG4gICAgY29uc3QgZW5lcmd5ID0gTWF0aC5taW4oMSwgbGV2ZWwgKiAxNCk7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBiYXJzLmxlbmd0aDsgaSsrKSB7XG4gICAgICBjb25zdCBoID0gMC4yNCArIGVuZXJneSAqIFZJWl9XRUlHSFRTW2ldICogMC43NjtcbiAgICAgIChiYXJzW2ldIGFzIEhUTUxFbGVtZW50KS5zdHlsZS50cmFuc2Zvcm0gPSBgc2NhbGVZKCR7aC50b0ZpeGVkKDIpfSlgO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGJhcnMubGVuZ3RoOyBpKyspIChiYXJzW2ldIGFzIEhUTUxFbGVtZW50KS5zdHlsZS50cmFuc2Zvcm0gPSBcIlwiO1xuICB9XG59XG5cbi8qKiBBIHN5c3RlbSBub3RpZmljYXRpb24gd2hpbGUgdGhlIHBhZ2UgaXMgaGlkZGVuOiBhIHRhc2sgZmluaXNoZWQsIG9yIG9uZSBuZWVkcyB0aGUgdXNlci4gKi9cbmZ1bmN0aW9uIG5vdGlmeSh0aXRsZTogc3RyaW5nLCBib2R5OiBzdHJpbmcpIHtcbiAgaWYgKCFkb2N1bWVudC5oaWRkZW4gfHwgIShcIk5vdGlmaWNhdGlvblwiIGluIHdpbmRvdykgfHwgTm90aWZpY2F0aW9uLnBlcm1pc3Npb24gIT09IFwiZ3JhbnRlZFwiKSByZXR1cm47XG4gIHRyeSB7XG4gICAgY29uc3QgbiA9IG5ldyBOb3RpZmljYXRpb24odGl0bGUsIHsgYm9keTogYm9keS5zbGljZSgwLCAxODApLCBpY29uOiBcIi93ZWIvaWNvbnMvaWNvbi0xOTIucG5nXCIsIHRhZzogdGl0bGUgfSk7XG4gICAgbi5vbmNsaWNrID0gKCkgPT4geyB3aW5kb3cuZm9jdXMoKTsgbi5jbG9zZSgpOyB9O1xuICB9IGNhdGNoIHtcbiAgICAvLyBQaG9uZXMgd2FudCBub3RpZmljYXRpb25zIGZyb20gYSBzZXJ2aWNlIHdvcmtlcjsgdGhlIHBhZ2UgaGFzIG5vbmUuXG4gIH1cbn1cblxuZnVuY3Rpb24gdG9hc3QodGV4dDogc3RyaW5nKSB7XG4gIGNvbnN0IHQgPSAkKFwidG9hc3RcIik7XG4gIHQudGV4dENvbnRlbnQgPSB0ZXh0O1xuICB0LmNsYXNzTGlzdC5hZGQoXCJvblwiKTtcbiAgY2xlYXJUaW1lb3V0KCh0b2FzdCBhcyBhbnkpLnRpbWVyKTtcbiAgKHRvYXN0IGFzIGFueSkudGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHQuY2xhc3NMaXN0LnJlbW92ZShcIm9uXCIpLCAxODAwKTtcbn1cblxuZnVuY3Rpb24gbG9nKGtpbmQ6IHN0cmluZywgdGV4dDogc3RyaW5nLCBjbHMgPSBcIlwiKSB7XG4gIGNvbnN0IHBhbmUgPSAkKFwibG9nXCIpO1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gYHJvdyAke2Nsc31gO1xuICByb3cuaW5uZXJIVE1MID0gYDxzcGFuIGNsYXNzPVwidFwiPiR7KG5vdygpIC0gc3RhcnRlZEF0KS50b0ZpeGVkKDIpfTwvc3Bhbj48c3BhbiBjbGFzcz1cImtcIj4ke2tpbmR9PC9zcGFuPmA7XG4gIGNvbnN0IGJvZHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgYm9keS5jbGFzc05hbWUgPSBcImJcIjtcbiAgYm9keS50ZXh0Q29udGVudCA9IHRleHQ7XG4gIHJvdy5hcHBlbmQoYm9keSk7XG4gIGNvbnN0IHN0aWNrID0gcGFuZS5zY3JvbGxUb3AgKyBwYW5lLmNsaWVudEhlaWdodCA+PSBwYW5lLnNjcm9sbEhlaWdodCAtIDMwO1xuICBwYW5lLmFwcGVuZChyb3cpO1xuICB3aGlsZSAocGFuZS5jaGlsZEVsZW1lbnRDb3VudCA+IDMwMDApIHBhbmUuZmlyc3RFbGVtZW50Q2hpbGQhLnJlbW92ZSgpO1xuICBpZiAoc3RpY2spIHBhbmUuc2Nyb2xsVG9wID0gcGFuZS5zY3JvbGxIZWlnaHQ7XG59XG5cbi8qKiBBIGZyYW1lIGZyb20gb3IgdG8gR2VtaW5pLCB3aXRoIGF1ZGlvIGN1dCBvdXQsIHNob3J0IGVub3VnaCB0byByZWFkLiAqL1xuZnVuY3Rpb24gYnJpZWYoZGF0YTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGRhdGEucmVwbGFjZSgvXCJkYXRhXCI6XCJbQS1aYS16MC05Ky89XXs0MCx9XCIvZywgKG0pID0+IGBcImRhdGFcIjpcIlx1MjAyNiR7TWF0aC5yb3VuZCgoKG0ubGVuZ3RoIC0gOSkgKiAzKSAvIDQpfSBieXRlc1wiYCkuc2xpY2UoMCwgNjAwKTtcbn1cblxuZnVuY3Rpb24gZXNjYXBlSHRtbCh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdGV4dC5yZXBsYWNlKC9bJjw+XCInXS9nLCAoYykgPT4gKHsgXCImXCI6IFwiJmFtcDtcIiwgXCI8XCI6IFwiJmx0O1wiLCBcIj5cIjogXCImZ3Q7XCIsICdcIic6IFwiJnF1b3Q7XCIsIFwiJ1wiOiBcIiYjMzk7XCIgfSlbY10hKTtcbn1cblxuLyoqIEEgbGl0dGxlIE1hcmtkb3duLCBzYWZlbHk6IGNvZGUsIGJvbGQsIGxpbmtzLCBsaXN0cyBhbmQgaGVhZGluZ3MsIHRoZSByZXN0IGFzIHRleHQuICovXG5mdW5jdGlvbiBtYXJrZG93bih0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBibG9ja3MgPSBlc2NhcGVIdG1sKHRleHQudHJpbSgpKS5zcGxpdCgvYGBgKD86XFx3Kyk/XFxuPy8pO1xuICByZXR1cm4gYmxvY2tzLm1hcCgoYmxvY2ssIGkpID0+IHtcbiAgICBpZiAoaSAlIDIgPT09IDEpIHJldHVybiBgPHByZT48Y29kZT4ke2Jsb2NrLnJlcGxhY2UoL1xcbiQvLCBcIlwiKX08L2NvZGU+PC9wcmU+YDtcbiAgICBjb25zdCBpbmxpbmUgPSAoczogc3RyaW5nKSA9PiBzXG4gICAgICAucmVwbGFjZSgvYChbXmBcXG5dKylgL2csIFwiPGNvZGU+JDE8L2NvZGU+XCIpXG4gICAgICAucmVwbGFjZSgvXFwqXFwqKFteKlxcbl0rKVxcKlxcKi9nLCBcIjxiPiQxPC9iPlwiKVxuICAgICAgLnJlcGxhY2UoL1xcWyhbXlxcXVxcbl0rKVxcXVxcKChodHRwcz86XFwvXFwvW15cXHMpXSspXFwpL2csICc8YSBocmVmPVwiJDJcIiB0YXJnZXQ9XCJfYmxhbmtcIiByZWw9XCJub29wZW5lclwiPiQxPC9hPicpXG4gICAgICAucmVwbGFjZSgvKF58W1xccyhdKShodHRwcz86XFwvXFwvW15cXHM8KV0rKS9nLCAnJDE8YSBocmVmPVwiJDJcIiB0YXJnZXQ9XCJfYmxhbmtcIiByZWw9XCJub29wZW5lclwiPiQyPC9hPicpO1xuICAgIGxldCBodG1sID0gXCJcIjtcbiAgICBsZXQgbGlzdDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gICAgZm9yIChjb25zdCByYXcgb2YgYmxvY2suc3BsaXQoXCJcXG5cIikpIHtcbiAgICAgIGNvbnN0IGl0ZW0gPSByYXcubWF0Y2goL15cXHMqKD86Wy0qXHUyMDIyXXwoXFxkKylbLildKVxccysoLiopJC8pO1xuICAgICAgaWYgKGl0ZW0pIHtcbiAgICAgICAgY29uc3Qga2luZCA9IGl0ZW1bMV0gPyBcIm9sXCIgOiBcInVsXCI7XG4gICAgICAgIGlmIChsaXN0ICE9PSBraW5kKSB7IGlmIChsaXN0KSBodG1sICs9IGA8LyR7bGlzdH0+YDsgaHRtbCArPSBgPCR7a2luZH0+YDsgbGlzdCA9IGtpbmQ7IH1cbiAgICAgICAgaHRtbCArPSBgPGxpPiR7aW5saW5lKGl0ZW1bMl0pfTwvbGk+YDtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBpZiAobGlzdCkgeyBodG1sICs9IGA8LyR7bGlzdH0+YDsgbGlzdCA9IG51bGw7IH1cbiAgICAgIGNvbnN0IGhlYWRpbmcgPSByYXcubWF0Y2goL14jezEsNn1cXHMrKC4qKSQvKTtcbiAgICAgIGh0bWwgKz0gaGVhZGluZyA/IGA8ZGl2IGNsYXNzPVwibWQtaFwiPiR7aW5saW5lKGhlYWRpbmdbMV0pfTwvZGl2PmAgOiByYXcudHJpbSgpID09PSBcIlwiID8gXCI8YnI+XCIgOiBgJHtpbmxpbmUocmF3KX08YnI+YDtcbiAgICB9XG4gICAgaWYgKGxpc3QpIGh0bWwgKz0gYDwvJHtsaXN0fT5gO1xuICAgIHJldHVybiBodG1sLnJlcGxhY2UoLyg8YnI+KSskLywgXCJcIik7XG4gIH0pLmpvaW4oXCJcIik7XG59XG5cbmNvbnN0IHRyYW5zY3JpcHRTY3JvbGwgPSBuZXcgQXV0b1Njcm9sbGVyKCQoXCJ0cmFuc2NyaXB0XCIpLCB7XG4gIG9uSnVtcENoYW5nZTogKHNob3cpID0+IHsgJChcImp1bXBib3R0b21cIikuaGlkZGVuID0gIXNob3c7IH0sXG4gIGlzRW1wdHk6ICgpID0+ICEkKFwiZW1wdHlcIikuaGlkZGVuLFxufSk7XG5cbmZ1bmN0aW9uIHNjcm9sbERvd24oZm9yY2UgPSBmYWxzZSkge1xuICB0cmFuc2NyaXB0U2Nyb2xsLm9uQ29udGVudChmb3JjZSk7XG59XG5cbi8qKiBUaGUgY29yZSdzIG51bWJlciBmb3IgdGhlIGxpbmUgdGhlIGxhc3Qgcm93IHNob3dzLCB1bnRpbCBhbm90aGVyIHJvdyBmb2xsb3dzIGl0LiAqL1xubGV0IG9wZW5MaW5lOiBudW1iZXIgfCBudWxsID0gbnVsbDtcblxuLyoqIFdvcmRzIGdvIG9uIHRoZSByb3cgdGhlIGNvcmUgc2F5cyB0aGV5IGJlbG9uZyB0bzogaXQgc3RhcnRzIGEgbmV3IGxpbmUgZm9yIGVhY2ggdHVybiwgaG93ZXZlciBsb25nIHRoZSBnYXAuICovXG5mdW5jdGlvbiB0cmFuc2NyaXB0KHJvbGU6IFwidXNlclwiIHwgXCJhc3Npc3RhbnRcIiwgdGV4dDogc3RyaW5nLCBsaW5lOiBudW1iZXIpIHtcbiAgJChcImVtcHR5XCIpLmhpZGRlbiA9IHRydWU7XG4gIGNvbnN0IHBhbmUgPSAkKFwidHJhbnNjcmlwdFwiKTtcbiAgY29uc3QgbGFzdCA9IHBhbmUubGFzdEVsZW1lbnRDaGlsZCBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gIGlmIChvcGVuTGluZSA9PT0gbGluZSAmJiBsYXN0ICYmIGxhc3QuZGF0YXNldC5yb2xlID09PSByb2xlKSBsYXN0LnF1ZXJ5U2VsZWN0b3IoXCIudGV4dFwiKSEudGV4dENvbnRlbnQgKz0gdGV4dDtcbiAgZWxzZSB7XG4gICAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICByb3cuY2xhc3NOYW1lID0gYGxpbmUgJHtyb2xlfWA7XG4gICAgcm93LmRhdGFzZXQucm9sZSA9IHJvbGU7XG4gICAgcm93LmlubmVySFRNTCA9IGA8c3BhbiBjbGFzcz1cIndob1wiPiR7cm9sZSA9PT0gXCJ1c2VyXCIgPyBcIllvdVwiIDogXCJHZW1pbmlcIn08L3NwYW4+PHNwYW4gY2xhc3M9XCJ0ZXh0XCI+PC9zcGFuPmA7XG4gICAgcm93LnF1ZXJ5U2VsZWN0b3IoXCIudGV4dFwiKSEudGV4dENvbnRlbnQgPSB0ZXh0LnRyaW1TdGFydCgpO1xuICAgIHBhbmUuYXBwZW5kKHJvdyk7XG4gICAgb3BlbkxpbmUgPSBsaW5lO1xuICB9XG4gIHNjcm9sbERvd24oKTtcbn1cblxuLyoqXG4gKiBUaGUgd29yZHMgdGhlIHVzZXIgaXMgc2F5aW5nLCBiZWZvcmUgdGhlIG1vZGVsIGhhcyB0cmFuc2NyaWJlZCB0aGVtOiBhIGZhaW50IHJvdyB0aGF0IHN0YXlzIGxhc3RcbiAqIG9uIHNjcmVlbiAoaXRzIENTUyBgb3JkZXJgKSBhbmQgZmlyc3QgaW4gdGhlIHBhbmUsIHNvIHRoZSBsaW5lcyBhZnRlciBpdCBqb2luIHVwIGFzIGJlZm9yZS5cbiAqL1xuZnVuY3Rpb24gY2FwdGlvbih0ZXh0OiBzdHJpbmcgfCBudWxsKSB7XG4gIGNvbnN0IHBhbmUgPSAkKFwidHJhbnNjcmlwdFwiKTtcbiAgbGV0IHJvdyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwiY2FwdGlvblwiKTtcbiAgaWYgKHRleHQgPT0gbnVsbCkgeyByb3c/LnJlbW92ZSgpOyBzY3JvbGxEb3duKCk7IHJldHVybjsgfVxuICAkKFwiZW1wdHlcIikuaGlkZGVuID0gdHJ1ZTtcbiAgaWYgKCFyb3cpIHtcbiAgICByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIHJvdy5pZCA9IFwiY2FwdGlvblwiO1xuICAgIHJvdy5jbGFzc05hbWUgPSBcImxpbmUgdXNlciBjYXB0aW9uXCI7XG4gICAgcm93LmlubmVySFRNTCA9IGA8c3BhbiBjbGFzcz1cIndob1wiPllvdTwvc3Bhbj48c3BhbiBjbGFzcz1cInRleHRcIj48L3NwYW4+YDtcbiAgICBwYW5lLnByZXBlbmQocm93KTtcbiAgfVxuICByb3cucXVlcnlTZWxlY3RvcihcIi50ZXh0XCIpIS50ZXh0Q29udGVudCA9IHRleHQ7XG4gIHNjcm9sbERvd24oKTtcbn1cblxuZnVuY3Rpb24gbm90ZSh0ZXh0OiBzdHJpbmcpIHtcbiAgJChcImVtcHR5XCIpLmhpZGRlbiA9IHRydWU7XG4gIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvdy5jbGFzc05hbWUgPSBcImxpbmUgbm90ZVwiO1xuICByb3cudGV4dENvbnRlbnQgPSB0ZXh0O1xuICAkKFwidHJhbnNjcmlwdFwiKS5hcHBlbmQocm93KTtcbiAgb3BlbkxpbmUgPSBudWxsO1xuICBzY3JvbGxEb3duKCk7XG59XG5cbmZ1bmN0aW9uIHJlc3VsdChhZ2VudDogc3RyaW5nLCBsYWJlbDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcsIGZhaWxlZCA9IGZhbHNlKTogSFRNTEVsZW1lbnQge1xuICAkKFwiZW1wdHlcIikuaGlkZGVuID0gdHJ1ZTtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IGBsaW5lIHJlc3VsdCAke2FnZW50ID09PSBcInQzXCIgPyBcInQzXCIgOiBcIlwifSAke2ZhaWxlZCA/IFwiZmFpbGVkXCIgOiBcIlwifWAudHJpbSgpO1xuICBjb25zdCB3aG8gPSBhZ2VudCA9PT0gXCJ0M1wiID8gXCJUM1wiIDogXCJIZXJtZXNcIjtcbiAgcm93LmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPVwid2hvXCI+PHNwYW4gY2xhc3M9XCJyZXMtdGl0bGVcIj48c3BhbiBjbGFzcz1cImJhZGdlICR7YWdlbnQgPT09IFwidDNcIiA/IFwidDNcIiA6IFwiXCJ9XCI+JHt3aG99PC9zcGFuPjxzcGFuIGNsYXNzPVwicmVzLWxhYmVsXCI+JHtlc2NhcGVIdG1sKGxhYmVsKX08L3NwYW4+PC9zcGFuPjxzcGFuIGNsYXNzPVwicmVzLXBpbGxcIj4ke2ZhaWxlZCA/IFwiRmFpbGVkXCIgOiBcIlJlc3VsdFwifTwvc3Bhbj48L2Rpdj48ZGl2IGNsYXNzPVwiYm9keVwiPiR7bWFya2Rvd24odGV4dCl9PC9kaXY+YDtcbiAgJChcInRyYW5zY3JpcHRcIikuYXBwZW5kKHJvdyk7XG4gIG9wZW5MaW5lID0gbnVsbDtcbiAgY29uc3QgYm9keSA9IHJvdy5xdWVyeVNlbGVjdG9yKFwiLmJvZHlcIikgYXMgSFRNTEVsZW1lbnQ7XG4gIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB7XG4gICAgaWYgKGJvZHkuc2Nyb2xsSGVpZ2h0ID4gYm9keS5jbGllbnRIZWlnaHQgKyA0KSB7XG4gICAgICByb3cuY2xhc3NMaXN0LmFkZChcImNsYW1wZWRcIik7XG4gICAgICBjb25zdCBtb3JlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgICAgIG1vcmUuY2xhc3NOYW1lID0gXCJtb3JlXCI7XG4gICAgICBtb3JlLnR5cGUgPSBcImJ1dHRvblwiO1xuICAgICAgbW9yZS50ZXh0Q29udGVudCA9IFwiU2hvdyBmdWxsIHJlc3VsdFwiO1xuICAgICAgbW9yZS5vbmNsaWNrID0gKCkgPT4ge1xuICAgICAgICByb3cuY2xhc3NMaXN0LnRvZ2dsZShcIm9wZW5cIik7XG4gICAgICAgIG1vcmUudGV4dENvbnRlbnQgPSByb3cuY2xhc3NMaXN0LmNvbnRhaW5zKFwib3BlblwiKSA/IFwiU2hvdyBsZXNzXCIgOiBcIlNob3cgZnVsbCByZXN1bHRcIjtcbiAgICAgICAgdHJhbnNjcmlwdFNjcm9sbC5zeW5jRnJvbVBvc2l0aW9uKCk7XG4gICAgICB9O1xuICAgICAgcm93LmFwcGVuZChtb3JlKTtcbiAgICAgIHNjcm9sbERvd24oKTtcbiAgICB9XG4gIH0pO1xuICBzY3JvbGxEb3duKCk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIGVsYXBzZWQoc2Vjb25kczogbnVtYmVyKTogc3RyaW5nIHtcbiAgaWYgKHNlY29uZHMgPCA2MCkgcmV0dXJuIGAke01hdGguZmxvb3Ioc2Vjb25kcyl9c2A7XG4gIGNvbnN0IG0gPSBNYXRoLmZsb29yKHNlY29uZHMgLyA2MCk7XG4gIHJldHVybiBtIDwgNjAgPyBgJHttfW0gJHtNYXRoLmZsb29yKHNlY29uZHMgJSA2MCl9c2AgOiBgJHtNYXRoLmZsb29yKG0gLyA2MCl9aCAke20gJSA2MH1tYDtcbn1cblxuLyoqIFRoZSBlbXB0eSB0YXNrIGxpc3QncyB3b3Jkcywga2VwdCB0byBwdXQgYmFjay4gKi9cbmNvbnN0IG5vVGFza3MgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcIm5vdGFza3NcIikhO1xuXG4vKiogV2hldGhlciBhIHRhc2sgc3RpbGwgd2FudHMgdGhlIHNjcmVlbjogaXQncyB3b3JraW5nLCBvciBpdCB3YWl0cyBmb3IgdGhlIHVzZXIuIFRoZSByZXN0IGZvbGQgYXdheSB1bmRlciBGaW5pc2hlZC4gKi9cbmNvbnN0IGxpdmUgPSAoc3RhdGU6IHN0cmluZykgPT4gc3RhdGUgPT09IFwicnVubmluZ1wiIHx8IHN0YXRlLnN0YXJ0c1dpdGgoXCJ3YWl0aW5nXCIpO1xuXG5mdW5jdGlvbiB1cGRhdGVUYXNrQ2hyb21lKCkge1xuICBjb25zdCBhbGwgPSBbLi4udGFza3MudmFsdWVzKCldO1xuICBjb25zdCBhY3RpdmVDdXJyZW50ID0gYWxsLmZpbHRlcigodCkgPT4gbGl2ZSh0LmMuc3RhdGUpIHx8IEJvb2xlYW4odC5hcHByb3ZhbCkpLmxlbmd0aDtcbiAgY29uc3Qgd2FpdGluZyA9IGFsbC5maWx0ZXIoKHQpID0+IHQuYy5zdGF0ZS5zdGFydHNXaXRoKFwid2FpdGluZ1wiKSB8fCBCb29sZWFuKHQuYXBwcm92YWwpKS5sZW5ndGg7XG4gIGNvbnN0IGFjdGl2ZVRvdGFsID0gYWN0aXZlQ3VycmVudCArIGVhcmxpZXJBY3RpdmVDb3VudDtcbiAgY29uc3QgYXR0ZW50aW9uVG90YWwgPSB3YWl0aW5nICsgZWFybGllcldhaXRpbmdDb3VudDtcblxuICBjb25zdCBiYWRnZSA9ICQoXCJ0YXNrcy1iYWRnZVwiKTtcbiAgYmFkZ2UuaGlkZGVuID0gYWN0aXZlVG90YWwgPT09IDA7XG4gIGJhZGdlLnRleHRDb250ZW50ID0gU3RyaW5nKGFjdGl2ZVRvdGFsKTtcbiAgYmFkZ2UuY2xhc3NMaXN0LnRvZ2dsZShcIndhcm5cIiwgYXR0ZW50aW9uVG90YWwgPiAwKTtcblxuICBjb25zdCBiYXIgPSAkKFwibW9iaWxlLXRhc2tzLWJhclwiKTtcbiAgY29uc3Qgc2hvd0JhciA9IGFjdGl2ZVRvdGFsID4gMDtcbiAgYmFyLmhpZGRlbiA9ICFzaG93QmFyO1xuICBiYXIuY2xhc3NMaXN0LnRvZ2dsZShcInZpc2libGVcIiwgc2hvd0Jhcik7XG4gIGJhci5jbGFzc0xpc3QudG9nZ2xlKFwid2FyblwiLCBhdHRlbnRpb25Ub3RhbCA+IDApO1xuICBpZiAoc2hvd0Jhcikge1xuICAgIGNvbnN0IGFwcHJvdmFsID0gYWxsLmZpbmQoKHQpID0+IHQuYXBwcm92YWwpO1xuICAgIGNvbnN0IGxhYmVsID0gYXBwcm92YWxcbiAgICAgID8gYEFwcHJvdmFsIG5lZWRlZDogJHthcHByb3ZhbC5jLmxhYmVsfWBcbiAgICAgIDogYXR0ZW50aW9uVG90YWwgPiAwXG4gICAgICAgID8gYCR7YXR0ZW50aW9uVG90YWx9IHRhc2ske2F0dGVudGlvblRvdGFsID4gMSA/IFwic1wiIDogXCJcIn0gd2FpdGluZyBmb3IgeW91YFxuICAgICAgICA6IGAke2FjdGl2ZVRvdGFsfSBhY3RpdmUgdGFzayR7YWN0aXZlVG90YWwgPiAxID8gXCJzXCIgOiBcIlwifWA7XG4gICAgJChcIm10Yi10ZXh0XCIpLnRleHRDb250ZW50ID0gbGFiZWw7XG4gIH1cbn1cblxuLyoqIFRoZSBGaW5pc2hlZCBmb2xkJ3MgY291bnQsIGFuZCB0aGUgZm9sZCBpdHNlbGYgb25seSB3aGVuIHNvbWV0aGluZyBpcyBpbiBpdC4gKi9cbmZ1bmN0aW9uIHNob3dEb25lKCkge1xuICBjb25zdCBuID0gJChcImRvbmVub3dcIikuY2hpbGRFbGVtZW50Q291bnQgKyAkKFwiZG9uZWVhcmxpZXJcIikuY2hpbGRFbGVtZW50Q291bnQ7XG4gICQoXCJkb25lYm94XCIpLmhpZGRlbiA9IG4gPT09IDA7XG4gICQoXCJkb25lY291bnRcIikudGV4dENvbnRlbnQgPSBuID4gMCA/IGBcdTAwQjcgJHtufWAgOiBcIlwiO1xufVxuXG5mdW5jdGlvbiBzaG93VGFza3MoZm9yY2UgPSBmYWxzZSkge1xuICBjb25zdCBwYW5lID0gJChcInRhc2tzXCIpO1xuICBjb25zdCBkb25lID0gJChcImRvbmVub3dcIik7XG4gIGNvbnN0IG9wZW4gPSBkb2N1bWVudC5hY3RpdmVFbGVtZW50Py5jbG9zZXN0Py4oXCIudGFza1wiKSBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gIGlmICghZm9yY2UgJiYgb3BlbiAmJiAocGFuZS5jb250YWlucyhvcGVuKSB8fCBkb25lLmNvbnRhaW5zKG9wZW4pKSAmJiBvcGVuLnF1ZXJ5U2VsZWN0b3IoXCJmb3JtXCIpKSByZXR1cm47IC8vIGRvbid0IHJlZHJhdyB1bmRlciBzb21lb25lIHR5cGluZyBhIGZvbGxvdy11cFxuICBwYW5lLmlubmVySFRNTCA9IFwiXCI7XG4gIGRvbmUuaW5uZXJIVE1MID0gXCJcIjtcbiAgY29uc3QgYWxsID0gWy4uLnRhc2tzLnZhbHVlcygpXS5yZXZlcnNlKCk7XG4gIGlmIChhbGwubGVuZ3RoID09PSAwKSB7XG4gICAgcGFuZS5hcHBlbmQobm9UYXNrcyk7XG4gICAgJChcInRhc2tjb3VudFwiKS50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgJChcImNhbmNlbGFsbFwiKS5oaWRkZW4gPSB0cnVlO1xuICAgIHNob3dEb25lKCk7XG4gICAgdXBkYXRlVGFza0Nocm9tZSgpO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBydW5uaW5nID0gYWxsLmZpbHRlcigodCkgPT4gdC5jLnN0YXRlID09PSBcInJ1bm5pbmdcIikubGVuZ3RoO1xuICBjb25zdCBhY3RpdmVDb3VudCA9IGFsbC5maWx0ZXIoKHQpID0+IGxpdmUodC5jLnN0YXRlKSkubGVuZ3RoO1xuICAkKFwidGFza2NvdW50XCIpLnRleHRDb250ZW50ID0gcnVubmluZyA+IDAgPyBgJHtydW5uaW5nfSBydW5uaW5nYCA6IGFjdGl2ZUNvdW50ID4gMCA/IGAke2FjdGl2ZUNvdW50fSB3YWl0aW5nYCA6IFwiXCI7XG4gICQoXCJjYW5jZWxhbGxcIikuaGlkZGVuID0gIWNhbGxJZCB8fCBydW5uaW5nIDwgMjtcbiAgZm9yIChjb25zdCB2aWV3IG9mIGFsbCkge1xuICAgIGNvbnN0IHQgPSB2aWV3LmM7XG4gICAgY29uc3Qgd2FpdGluZyA9IHQuc3RhdGUuc3RhcnRzV2l0aChcIndhaXRpbmdcIik7XG4gICAgY29uc3QgY2FyZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgY2FyZC5jbGFzc05hbWUgPSBgdGFzayAke3dhaXRpbmcgPyBcIndhaXRpbmdcIiA6IHQuc3RhdGV9YDtcbiAgICBjb25zdCBhZ2UgPSAodmlldy5lbmRlZCA/PyBub3coKSkgLSB2aWV3LnNpbmNlO1xuICAgIGNhcmQuaW5uZXJIVE1MID1cbiAgICAgIGA8ZGl2IGNsYXNzPVwibWV0YS1yb3dcIj5gICtcbiAgICAgICAgYDxzcGFuIGNsYXNzPVwiYmFkZ2UgJHt0LmFnZW50ID09PSBcInQzXCIgPyBcInQzXCIgOiBcIlwifVwiPiR7dC5hZ2VudCA9PT0gXCJ0M1wiID8gXCJUM1wiIDogXCJIZXJtZXNcIn08L3NwYW4+YCArXG4gICAgICAgIGA8c3BhbiBjbGFzcz1cInN0YXRlXCI+JHt0LnN0YXRlID09PSBcInJ1bm5pbmdcIiA/ICc8c3BhbiBjbGFzcz1cInNwaW5cIj48L3NwYW4+JyA6IFwiXCJ9JHtlc2NhcGVIdG1sKHQuc3RhdGUpfTwvc3Bhbj5gICtcbiAgICAgICAgYDxzcGFuIGNsYXNzPVwiYWdlXCI+JHtlbGFwc2VkKGFnZSl9PC9zcGFuPmAgK1xuICAgICAgYDwvZGl2PmAgK1xuICAgICAgYDxkaXYgY2xhc3M9XCJsYWJlbFwiPjwvZGl2PmAgK1xuICAgICAgYDxkaXYgY2xhc3M9XCJwXCI+PC9kaXY+YDtcbiAgICBjYXJkLnF1ZXJ5U2VsZWN0b3IoXCIubGFiZWxcIikhLnRleHRDb250ZW50ID0gdC5sYWJlbDtcbiAgICBjYXJkLnF1ZXJ5U2VsZWN0b3IoXCIucFwiKSEudGV4dENvbnRlbnQgPSB0LnByb2dyZXNzID8/IHQucmVxdWVzdDtcbiAgICBpZiAodC5xdWVzdGlvbikge1xuICAgICAgY29uc3QgcSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICBxLmNsYXNzTmFtZSA9IFwicVwiO1xuICAgICAgcS50ZXh0Q29udGVudCA9IGBBc2tzOiAke3QucXVlc3Rpb259YDtcbiAgICAgIGNhcmQuYXBwZW5kKHEpO1xuICAgIH1cbiAgICBpZiAodmlldy5hcHByb3ZhbCAmJiB0LnN0YXRlID09PSBcInJ1bm5pbmdcIikge1xuICAgICAgY29uc3QgYm94ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgIGJveC5jbGFzc05hbWUgPSBcImFwcHJvdmFsXCI7XG4gICAgICBib3guaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9XCJhcHByb3ZhbC1oZWFkXCI+SGVybWVzIGFza3MgdG8gcnVuPC9kaXY+PGNvZGU+PC9jb2RlPjxkaXYgY2xhc3M9XCJhY3RzXCI+PC9kaXY+YDtcbiAgICAgIGJveC5xdWVyeVNlbGVjdG9yKFwiY29kZVwiKSEudGV4dENvbnRlbnQgPSB2aWV3LmFwcHJvdmFsLmNvbW1hbmQ7XG4gICAgICBjb25zdCBhbnN3ZXIgPSAoY2hvaWNlOiBcIm9uY2VcIiB8IFwiZGVueVwiKSA9PiB7XG4gICAgICAgIHZpZXcuYXBwcm92YWwgPSB1bmRlZmluZWQ7XG4gICAgICAgIHNob3dUYXNrcyh0cnVlKTtcbiAgICAgICAgdm9pZCBmZXRjaChcIi9oZXJtZXMvYXBwcm92YWxcIiwgeyBtZXRob2Q6IFwiUE9TVFwiLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGNhbGw6IGNhbGxOYW1lLCB0YXNrSWQ6IHQuaWQsIGNob2ljZSB9KSB9KVxuICAgICAgICAgIC50aGVuKChyKSA9PiB0b2FzdChyLm9rID8gKGNob2ljZSA9PT0gXCJvbmNlXCIgPyBcIkFwcHJvdmVkXCIgOiBcIkRlbmllZFwiKSA6IFwiVGhhdCBhcHByb3ZhbCBoYWQgYWxyZWFkeSBsYXBzZWRcIikpO1xuICAgICAgfTtcbiAgICAgIGZvciAoY29uc3QgW2xhYmVsLCBjaG9pY2VdIG9mIFtbXCJBcHByb3ZlIG9uY2VcIiwgXCJvbmNlXCJdLCBbXCJEZW55XCIsIFwiZGVueVwiXV0gYXMgY29uc3QpIHtcbiAgICAgICAgY29uc3QgYiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gICAgICAgIGIudHlwZSA9IFwiYnV0dG9uXCI7XG4gICAgICAgIGIudGV4dENvbnRlbnQgPSBsYWJlbDtcbiAgICAgICAgaWYgKGNob2ljZSA9PT0gXCJvbmNlXCIpIGIuY2xhc3NOYW1lID0gXCJnb1wiO1xuICAgICAgICBlbHNlIGIuY2xhc3NOYW1lID0gXCJkYW5nZXJcIjtcbiAgICAgICAgYi5vbmNsaWNrID0gKCkgPT4gYW5zd2VyKGNob2ljZSk7XG4gICAgICAgIGJveC5xdWVyeVNlbGVjdG9yKFwiLmFjdHNcIikhLmFwcGVuZChiKTtcbiAgICAgIH1cbiAgICAgIGNhcmQuYXBwZW5kKGJveCk7XG4gICAgfVxuICAgIGlmICh0LnN0YXRlICE9PSBcInJ1bm5pbmdcIikgdmlldy5hcHByb3ZhbCA9IHVuZGVmaW5lZDtcbiAgICBjb25zdCBhY3RzID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBhY3RzLmNsYXNzTmFtZSA9IFwiYWN0c1wiO1xuICAgIGNvbnN0IGJ1dHRvbiA9ICh0ZXh0OiBzdHJpbmcsIGZuOiAoKSA9PiB2b2lkLCBjbHMgPSBcIlwiKSA9PiB7XG4gICAgICBjb25zdCBiID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgICAgIGIudHlwZSA9IFwiYnV0dG9uXCI7XG4gICAgICBiLnRleHRDb250ZW50ID0gdGV4dDtcbiAgICAgIGlmIChjbHMpIGIuY2xhc3NOYW1lID0gY2xzO1xuICAgICAgYi5vbmNsaWNrID0gZm47XG4gICAgICBhY3RzLmFwcGVuZChiKTtcbiAgICAgIHJldHVybiBiO1xuICAgIH07XG4gICAgaWYgKGNhbGxJZCkge1xuICAgICAgYnV0dG9uKHdhaXRpbmcgPyBcIkFuc3dlclwiIDogXCJGb2xsb3cgdXBcIiwgKCkgPT4gZm9sbG93VXBGb3JtKGNhcmQsIHQpKTtcbiAgICAgIGlmICh0LnN0YXRlID09PSBcInJ1bm5pbmdcIikgYnV0dG9uKFwiQ2FuY2VsXCIsICgpID0+IHB1c2goeyB0eXBlOiBcImNhbmNlbFRhc2tcIiwgdGFzazogdC5pZCB9KSwgXCJkYW5nZXJcIik7XG4gICAgfVxuICAgIGlmICh2aWV3LnJlc3VsdCkgYnV0dG9uKFwiUmVzdWx0XCIsICgpID0+IHtcbiAgICAgIHNldFRhc2tzT3BlbihmYWxzZSk7XG4gICAgICB2aWV3LnJlc3VsdCEuY2xhc3NMaXN0LmFkZChcIm9wZW5cIik7XG4gICAgICBpZiAodmlldy5yZXN1bHQgIT09ICQoXCJ0cmFuc2NyaXB0XCIpLmxhc3RFbGVtZW50Q2hpbGQpIHRyYW5zY3JpcHRTY3JvbGwudW5waW4oKTtcbiAgICAgIGVsc2UgdHJhbnNjcmlwdFNjcm9sbC5zeW5jRnJvbVBvc2l0aW9uKCk7XG4gICAgICB2aWV3LnJlc3VsdCEuc2Nyb2xsSW50b1ZpZXcoeyBiZWhhdmlvcjogXCJzbW9vdGhcIiwgYmxvY2s6IFwic3RhcnRcIiB9KTtcbiAgICB9KTtcbiAgICBpZiAodmlldy50aHJlYWQpIGJ1dHRvbihcIkNvcHkgdGhyZWFkIGlkXCIsICgpID0+IHsgdm9pZCBuYXZpZ2F0b3IuY2xpcGJvYXJkPy53cml0ZVRleHQodmlldy50aHJlYWQhKTsgdG9hc3QoXCJUaHJlYWQgaWQgY29waWVkXCIpOyB9KTtcbiAgICBpZiAoYWN0cy5jaGlsZEVsZW1lbnRDb3VudCkgY2FyZC5hcHBlbmQoYWN0cyk7XG4gICAgKGxpdmUodC5zdGF0ZSkgPyBwYW5lIDogZG9uZSkuYXBwZW5kKGNhcmQpO1xuICB9XG4gIGlmIChwYW5lLmNoaWxkRWxlbWVudENvdW50ID09PSAwKSBwYW5lLmFwcGVuZChub1Rhc2tzKTtcbiAgc2hvd0RvbmUoKTtcbiAgdXBkYXRlVGFza0Nocm9tZSgpO1xufVxuXG5mdW5jdGlvbiBmb2xsb3dVcEZvcm0oY2FyZDogSFRNTEVsZW1lbnQsIHQ6IENvbW1hbmQpIHtcbiAgaWYgKGNhcmQucXVlcnlTZWxlY3RvcihcImZvcm1cIikpIHJldHVybjtcbiAgY29uc3QgZm9ybSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJmb3JtXCIpO1xuICBmb3JtLmlubmVySFRNTCA9IGA8aW5wdXQgdHlwZT1cInRleHRcIiBwbGFjZWhvbGRlcj1cIlRlbGwgXHUyMDFDJHtlc2NhcGVIdG1sKHQubGFiZWwpfVx1MjAxRFx1MjAyNlwiIGVudGVya2V5aGludD1cInNlbmRcIj48YnV0dG9uIHR5cGU9XCJzdWJtaXRcIj5TZW5kPC9idXR0b24+YDtcbiAgY29uc3QgaW5wdXQgPSBmb3JtLnF1ZXJ5U2VsZWN0b3IoXCJpbnB1dFwiKSE7XG4gIGZvcm0ub25zdWJtaXQgPSAoZSkgPT4ge1xuICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICBjb25zdCB0ZXh0ID0gaW5wdXQudmFsdWUudHJpbSgpO1xuICAgIGlmICh0ZXh0KSB7IHB1c2goeyB0eXBlOiBcInN0ZWVyXCIsIHRhc2s6IHQuaWQsIHRleHQgfSk7IG5vdGUoYFlvdSBcdTIxOTIgJHt0LmxhYmVsfTogJHt0ZXh0fWApOyBzY3JvbGxEb3duKHRydWUpOyB9XG4gICAgaW5wdXQuYmx1cigpO1xuICAgIGZvcm0ucmVtb3ZlKCk7XG4gICAgc2hvd1Rhc2tzKCk7XG4gIH07XG4gIGlucHV0Lm9ua2V5ZG93biA9IChlKSA9PiB7IGlmIChlLmtleSA9PT0gXCJFc2NhcGVcIikgeyBpbnB1dC5ibHVyKCk7IGZvcm0ucmVtb3ZlKCk7IHNob3dUYXNrcygpOyB9IH07XG4gIGNhcmQuYXBwZW5kKGZvcm0pO1xuICBpbnB1dC5mb2N1cygpO1xufVxuXG4vKiogVDMgdGhyZWFkcyBlYXJsaWVyIGNhbGxzIHN0YXJ0ZWQ6IHRoZXkgY2Fycnkgb24gYWZ0ZXIgYSBjYWxsLCBzbyB0aGUgcGFuZWwgc2F5cyBob3cgdGhleSdyZSBkb2luZy4gKi9cbmFzeW5jIGZ1bmN0aW9uIHNob3dFYXJsaWVyKCkge1xuICBsZXQgbGlzdDogeyB0aHJlYWQ6IHN0cmluZzsgdGl0bGU6IHN0cmluZzsgc3RhdHVzOiBzdHJpbmc7IGJyYW5jaDogc3RyaW5nIHwgbnVsbDsgcHI6IHN0cmluZyB8IG51bGw7IHVwZGF0ZWQ6IHN0cmluZzsgbGFzdDogc3RyaW5nOyB3YWl0aW5nOiBib29sZWFuIH1bXSA9IFtdO1xuICB0cnkgeyBsaXN0ID0gYXdhaXQgKGF3YWl0IGZldGNoKFwiL2FnZW50L3JlY2VudFwiLCB7IGNhY2hlOiBcIm5vLXN0b3JlXCIgfSkpLmpzb24oKTsgfSBjYXRjaCB7fVxuICBjb25zdCBjdXJyZW50ID0gbmV3IFNldChbLi4udGFza3MudmFsdWVzKCldLm1hcCgodikgPT4gdi50aHJlYWQpLmZpbHRlcihCb29sZWFuKSk7XG4gIGxpc3QgPSBsaXN0LmZpbHRlcigodCkgPT4gIWN1cnJlbnQuaGFzKHQudGhyZWFkKSk7XG4gIGNvbnN0IHBhbmUgPSAkKFwiZWFybGllclwiKTtcbiAgY29uc3QgZG9uZSA9ICQoXCJkb25lZWFybGllclwiKTtcbiAgcGFuZS5pbm5lckhUTUwgPSBcIlwiO1xuICBkb25lLmlubmVySFRNTCA9IFwiXCI7XG4gIGVhcmxpZXJBY3RpdmVDb3VudCA9IDA7XG4gIGVhcmxpZXJXYWl0aW5nQ291bnQgPSAwO1xuICBmb3IgKGNvbnN0IHQgb2YgbGlzdCkge1xuICAgIGNvbnN0IGNhcmQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGNvbnN0IHN0YXRlID0gdC53YWl0aW5nID8gXCJ3YWl0aW5nIGZvciBhcHByb3ZhbCBpbiBUM1wiIDogdC5zdGF0dXM7XG4gICAgY2FyZC5jbGFzc05hbWUgPSBgdGFzayAke3Quc3RhdHVzID09PSBcInJ1bm5pbmdcIiA/IFwicnVubmluZ1wiIDogdC53YWl0aW5nID8gXCJ3YWl0aW5nXCIgOiBcImZpbmlzaGVkXCJ9YDtcbiAgICBjb25zdCBhZ28gPSBNYXRoLm1heCgwLCAoRGF0ZS5ub3coKSAtIERhdGUucGFyc2UodC51cGRhdGVkKSkgLyAxMDAwKTtcbiAgICBjYXJkLmlubmVySFRNTCA9XG4gICAgICBgPGRpdiBjbGFzcz1cIm1ldGEtcm93XCI+YCArXG4gICAgICAgIGA8c3BhbiBjbGFzcz1cImJhZGdlIHQzXCI+VDM8L3NwYW4+YCArXG4gICAgICAgIGA8c3BhbiBjbGFzcz1cInN0YXRlXCI+JHt0LnN0YXR1cyA9PT0gXCJydW5uaW5nXCIgPyAnPHNwYW4gY2xhc3M9XCJzcGluXCI+PC9zcGFuPicgOiBcIlwifSR7ZXNjYXBlSHRtbChzdGF0ZSl9PC9zcGFuPmAgK1xuICAgICAgICBgPHNwYW4gY2xhc3M9XCJhZ2VcIj4ke2VsYXBzZWQoYWdvKX0gYWdvPC9zcGFuPmAgK1xuICAgICAgYDwvZGl2PmAgK1xuICAgICAgYDxkaXYgY2xhc3M9XCJsYWJlbFwiPjwvZGl2PmAgK1xuICAgICAgYDxkaXYgY2xhc3M9XCJwXCI+PC9kaXY+YDtcbiAgICBjYXJkLnF1ZXJ5U2VsZWN0b3IoXCIubGFiZWxcIikhLnRleHRDb250ZW50ID0gdC50aXRsZTtcbiAgICBjYXJkLnF1ZXJ5U2VsZWN0b3IoXCIucFwiKSEudGV4dENvbnRlbnQgPSB0Lmxhc3QgfHwgKHQuYnJhbmNoID8gYE9uICR7dC5icmFuY2h9YCA6IFwiXCIpO1xuICAgIGNvbnN0IGFjdHMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGFjdHMuY2xhc3NOYW1lID0gXCJhY3RzXCI7XG4gICAgaWYgKHQucHIpIHsgY29uc3QgYSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJhXCIpOyBhLmhyZWYgPSB0LnByOyBhLnRhcmdldCA9IFwiX2JsYW5rXCI7IGEucmVsID0gXCJub29wZW5lclwiOyBhLnRleHRDb250ZW50ID0gXCJQdWxsIHJlcXVlc3QgXHUyMTk3XCI7IGFjdHMuYXBwZW5kKGEpOyB9XG4gICAgY29uc3QgY29weSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gICAgY29weS50eXBlID0gXCJidXR0b25cIjtcbiAgICBjb3B5LnRleHRDb250ZW50ID0gXCJDb3B5IHRocmVhZCBpZFwiO1xuICAgIGNvcHkub25jbGljayA9ICgpID0+IHsgdm9pZCBuYXZpZ2F0b3IuY2xpcGJvYXJkPy53cml0ZVRleHQodC50aHJlYWQpOyB0b2FzdChcIlRocmVhZCBpZCBjb3BpZWRcIik7IH07XG4gICAgYWN0cy5hcHBlbmQoY29weSk7XG4gICAgY2FyZC5hcHBlbmQoYWN0cyk7XG4gICAgY29uc3QgYWN0aXZlID0gdC5zdGF0dXMgPT09IFwicnVubmluZ1wiIHx8IHQud2FpdGluZztcbiAgICBpZiAoYWN0aXZlKSBlYXJsaWVyQWN0aXZlQ291bnQrKztcbiAgICBpZiAodC53YWl0aW5nKSBlYXJsaWVyV2FpdGluZ0NvdW50Kys7XG4gICAgKGFjdGl2ZSA/IHBhbmUgOiBkb25lKS5hcHBlbmQoY2FyZCk7XG4gIH1cbiAgJChcImVhcmxpZXJib3hcIikuaGlkZGVuID0gcGFuZS5jaGlsZEVsZW1lbnRDb3VudCA9PT0gMDtcbiAgc2hvd0RvbmUoKTtcbiAgdXBkYXRlVGFza0Nocm9tZSgpO1xufVxuXG5jb25zdCBTVEFUVVNfVEVYVDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgaWRsZTogXCJJZGxlXCIsIGNvbm5lY3Rpbmc6IFwiQ29ubmVjdGluZ1x1MjAyNlwiLCBsaXN0ZW5pbmc6IFwiTGlzdGVuaW5nXCIsIHdvcmtpbmc6IFwiTGlzdGVuaW5nIFx1MDBCNyB0YXNrcyBydW5uaW5nXCIsXG4gIGRvcm1hbnQ6IFwiRG9ybWFudCBcdTAwQjcgd2FpdGluZyBmb3Igd2FrZSB3b3JkXCIsXG4gIHN0YW5kYnk6IFwiUGF1c2VkIHdoaWxlIHRhc2tzIHJ1biBcdTAwQjcgc3BlYWsgdG8gcmVzdW1lXCIsIHdha2luZzogXCJSZXN1bWluZ1x1MjAyNlwiLCBlbmRlZDogXCJFbmRlZFwiLFxufTtcblxuZnVuY3Rpb24gc2hvd1N0YXR1cyhtZXNzYWdlPzogc3RyaW5nKSB7XG4gIGNvbnN0IHR5cGVkID0gQm9vbGVhbihjYWxsSWQpICYmIG1lZGl1bSA9PT0gXCJ0ZXh0XCI7XG4gIGNvbnN0IHNwZWFraW5nID0gQm9vbGVhbihjYWxsSWQpICYmICF0eXBlZCAmJiBjb3JlU3RhdHVzICE9PSBcInN0YW5kYnlcIiAmJiBjb3JlU3RhdHVzICE9PSBcImRvcm1hbnRcIiAmJiBhdWRpby5xdWV1ZWQgPiAwLjA1O1xuICBjb25zdCBhcm1lZElkbGUgPSAhY2FsbElkICYmIHdha2VBcm1lZDtcbiAgY29uc3Qgc2hvd24gPSBjYWxsSWRcbiAgICA/IChzcGVha2luZyB8fCAodHlwZWQgJiYgdGhpbmtpbmcpID8gXCJzcGVha2luZ1wiIDogY29yZVN0YXR1cylcbiAgICA6IGFybWVkSWRsZSA/IFwiYXJtZWRcIiA6IGNvcmVTdGF0dXM7XG4gICQoXCJzdGF0dXNcIikuY2xhc3NOYW1lID0gc2hvd247XG4gIGRvY3VtZW50LmJvZHkuZGF0YXNldC5zdGF0ZSA9IGNhbGxJZCA/IHNob3duIDogYXJtZWRJZGxlID8gXCJhcm1lZFwiIDogXCJpZGxlXCI7XG4gIGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LnRvZ2dsZShcImluLXNlc3Npb25cIiwgQm9vbGVhbihjYWxsSWQpKTtcbiAgY29uc3Qgd2FrZUxhYmVsID0gc2VsZWN0ZWRXYWtlTW9kZWwoKT8ubGFiZWwgPz8gXCJ3YWtlIHdvcmRcIjtcbiAgbGV0IHRleHQgPSBhcm1lZElkbGVcbiAgICA/ICh3YWtlTG9hZGluZyA/IGBMb2FkaW5nIFx1MjAxQyR7d2FrZUxhYmVsfVx1MjAxRFx1MjAyNmAgOiBgV2FpdGluZyBmb3IgXHUyMDFDJHt3YWtlTGFiZWx9XHUyMDFEYClcbiAgICA6IHNwZWFraW5nID8gXCJTcGVha2luZ1wiXG4gICAgOiBjb3JlU3RhdHVzID09PSBcImRvcm1hbnRcIiA/IGBEb3JtYW50IFx1MDBCNyBzYXkgXHUyMDFDJHt3YWtlTGFiZWx9XHUyMDFEYFxuICAgIDogU1RBVFVTX1RFWFRbY29yZVN0YXR1c10gPz8gY29yZVN0YXR1cztcbiAgaWYgKHR5cGVkICYmIGNvcmVTdGF0dXMgIT09IFwiZW5kZWRcIikgdGV4dCA9IHRoaW5raW5nID8gXCJXcml0aW5nXHUyMDI2XCIgOiBjb3JlU3RhdHVzID09PSBcIndvcmtpbmdcIiA/IFwiQ2hhdCBcdTAwQjcgdGFza3MgcnVubmluZ1wiIDogXCJDaGF0XCI7XG4gIGlmIChjYWxsSWQgJiYgIXR5cGVkICYmIG11dGVkICYmICFob2xkaW5nICYmICFzcGVha2luZykgdGV4dCArPSBcIiBcdTAwQjcgbXV0ZWRcIjtcbiAgaWYgKGhvbGRpbmcpIHRleHQgPSBcIlRhbGtpbmcgKGhvbGQpXCI7XG4gIGlmIChtZXNzYWdlKSB0ZXh0ID0gYCR7dGV4dH06ICR7bWVzc2FnZX1gO1xuICBpZiAoY29yZVN0YXR1cyAhPT0gXCJlbmRlZFwiIHx8IG1lc3NhZ2UgfHwgYXJtZWRJZGxlKSAkKFwic3RhdHVzdGV4dFwiKS50ZXh0Q29udGVudCA9IHRleHQ7XG4gICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiaHVzaFwiKS5jbGFzc0xpc3QudG9nZ2xlKFwibGl2ZVwiLCBzcGVha2luZyB8fCAodHlwZWQgJiYgdGhpbmtpbmcpKTtcblxuICBjb25zdCBiYXIgPSAkKFwiY2FsbGJhclwiKTtcbiAgYmFyLmhpZGRlbiA9ICFjYWxsSWQ7XG4gICQoXCJ3YWtlLW5vd1wiKS5oaWRkZW4gPSAhKGNhbGxJZCAmJiAhdHlwZWQgJiYgKGNvcmVTdGF0dXMgPT09IFwiZG9ybWFudFwiIHx8IGNvcmVTdGF0dXMgPT09IFwic3RhbmRieVwiKSk7XG4gIGlmIChjYWxsSWQpIHtcbiAgICAkKFwiY2FsbGJhci1zdGF0ZVwiKS50ZXh0Q29udGVudCA9IHRleHQ7XG4gICAgJChcImNhbGx0aW1lclwiKS5oaWRkZW4gPSB0eXBlZDtcbiAgICBpZiAoIXR5cGVkKSAkKFwiY2FsbHRpbWVyXCIpLnRleHRDb250ZW50ID0gZm9ybWF0Q2xvY2sobm93KCkgLSBzdGFydGVkQXQpO1xuICAgIGNvbnN0IHZpek1vZGUgPSB0eXBlZCA/ICh0aGlua2luZyA/IFwidGhpbmtpbmdcIiA6IFwiaWRsZVwiKVxuICAgICAgOiBzcGVha2luZyA/IFwic3BlYWtpbmdcIlxuICAgICAgOiBtdXRlZCAmJiAhaG9sZGluZyA/IFwibXV0ZWRcIlxuICAgICAgOiBzaG93bjtcbiAgICB1cGRhdGVWaXN1YWxpemVyKHZpek1vZGUsIG11dGVkICYmICFob2xkaW5nID8gMCA6IGF1ZGlvLmxldmVsKTtcbiAgfVxufVxuXG4vLyBUaGUgY2FsbC5cblxuZnVuY3Rpb24gcHVzaChldmVudDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIHtcbiAgaWYgKCFjb3JlIHx8ICFjYWxsSWQpIHJldHVybjtcbiAgY29uc3QgZTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7IC4uLmV2ZW50LCB0OiBub3coKSB9O1xuICBjb25zdCBxdWlldCA9IGUudHlwZSA9PT0gXCJtaWNcIiB8fCBlLnR5cGUgPT09IFwidGlja1wiO1xuICBpZiAoIXF1aWV0KSBsb2coXCJpblwiLCBlLnR5cGUgPT09IFwid3MubWVzc2FnZVwiID8gYHdzICR7ZS5zaWR9IFx1MjE5MCAke2JyaWVmKFN0cmluZyhlLmRhdGEpKX1gIDogSlNPTi5zdHJpbmdpZnkoZSkuc2xpY2UoMCwgNDAwKSwgXCJpblwiKTtcbiAgcnVuKEpTT04ucGFyc2UoY29yZS5wdXNoKGNhbGxJZCwgSlNPTi5zdHJpbmdpZnkoZSkpKSk7XG59XG5cbmZ1bmN0aW9uIHJ1bihjb21tYW5kczogQ29tbWFuZFtdKSB7XG4gIGZvciAoY29uc3QgYyBvZiBjb21tYW5kcykge1xuICAgIHN3aXRjaCAoYy50eXBlKSB7XG4gICAgICBjYXNlIFwid3MuY29ubmVjdFwiOiBjb25uZWN0KGMuc2lkLCBjLnB1cnBvc2UgPT09IFwiY2FwdGlvbnNcIik7IGJyZWFrO1xuICAgICAgY2FzZSBcIndzLnNlbmRcIjoge1xuICAgICAgICBzb2NrZXRzLmdldChjLnNpZCk/LnNlbmQoYy5kYXRhKTtcbiAgICAgICAgaWYgKCFjLmRhdGEuc3RhcnRzV2l0aCgne1wicmVhbHRpbWVJbnB1dFwiOntcImF1ZGlvXCInKSkgbG9nKFwib3V0XCIsIGB3cyAke2Muc2lkfSBcdTIxOTIgJHticmllZihjLmRhdGEpfWAsIFwib3V0XCIpO1xuICAgICAgICBlbHNlIGlmICghY2FwdGlvblNvY2tldHMuaGFzKGMuc2lkKSkgY291bnRzLnNlbnQrKztcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwid3MuY2xvc2VcIjogc29ja2V0cy5nZXQoYy5zaWQpPy5jbG9zZSgpOyBzb2NrZXRzLmRlbGV0ZShjLnNpZCk7IGxvZyhcIm91dFwiLCBgd3MgJHtjLnNpZH0gY2xvc2VgLCBcIm91dFwiKTsgYnJlYWs7XG4gICAgICBjYXNlIFwibWljLnN0YXJ0XCI6IHtcbiAgICAgICAgbG9nKFwib3V0XCIsIGMudHlwZSwgXCJvdXRcIik7XG4gICAgICAgIGNvbnN0IHBlbmRpbmdPcGVuaW5nID0gd2FrZVN0YXJ0aW5nID8gb3BlbmluZ0NodW5rcy5zcGxpY2UoMCkgOiBbXTtcbiAgICAgICAgb3BlbmluZ0J5dGVzID0gMDtcbiAgICAgICAgd2FrZVN0YXJ0aW5nID0gZmFsc2U7XG4gICAgICAgIHZvaWQgYXVkaW8uZW5zdXJlTWljKG9uTWljLCBtaWNPcHRpb25zKCkpLmNhdGNoKChlcnIpID0+IHsgbG9nKFwiZXJyb3JcIiwgYG1pY3JvcGhvbmU6ICR7ZXJyLm1lc3NhZ2V9YCwgXCJlcnJcIik7IHRvYXN0KGBNaWNyb3Bob25lOiAke2Vyci5tZXNzYWdlfWApOyB9KTtcbiAgICAgICAgaWYgKHBlbmRpbmdPcGVuaW5nLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICBjb25zdCB0b3RhbE1zID0gTWF0aC5yb3VuZChwZW5kaW5nT3BlbmluZy5yZWR1Y2UoKHMsIGIpID0+IHMgKyBiLmJ5dGVMZW5ndGgsIDApIC8gMzIpO1xuICAgICAgICAgIGxvZyhcIm91dFwiLCBgZmx1c2hpbmcgJHt0b3RhbE1zfSBtcyBzcG9rZW4gYWZ0ZXIgd2FrZSB3b3JkYCwgXCJvdXRcIik7XG4gICAgICAgICAgcXVldWVNaWNyb3Rhc2soKCkgPT4ge1xuICAgICAgICAgICAgaWYgKCFjYWxsSWQpIHJldHVybjtcbiAgICAgICAgICAgIGZvciAoY29uc3QgY2h1bmsgb2YgcGVuZGluZ09wZW5pbmcpIHtcbiAgICAgICAgICAgICAgaWYgKCFjYWxsSWQpIGJyZWFrO1xuICAgICAgICAgICAgICBjb3VudHMubWljKys7XG4gICAgICAgICAgICAgIHB1c2goeyB0eXBlOiBcIm1pY1wiLCBwY206IGJ5dGVzVG9CYXNlNjQoY2h1bmspIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcIm1pYy5yZXN0YXJ0XCI6XG4gICAgICAgIGxvZyhcIm91dFwiLCBjLnR5cGUsIFwib3V0XCIpO1xuICAgICAgICB2b2lkIGF1ZGlvLnN0YXJ0TWljKG9uTWljLCBtaWNPcHRpb25zKCkpLmNhdGNoKChlcnIpID0+IHsgbG9nKFwiZXJyb3JcIiwgYG1pY3JvcGhvbmU6ICR7ZXJyLm1lc3NhZ2V9YCwgXCJlcnJcIik7IHRvYXN0KGBNaWNyb3Bob25lOiAke2Vyci5tZXNzYWdlfWApOyB9KTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwibWljLnN0b3BcIjpcbiAgICAgICAgaWYgKCF3YWtlQXJtZWQpIGF1ZGlvLnN0b3BNaWMoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwicGxheVwiOiB7XG4gICAgICAgIGNvbnN0IHQgPSBub3coKTtcbiAgICAgICAgLy8gQSByZXBseSBzdGFydGluZzogZnJvbSB0aGUgZW5kIG9mIHRoZSB1c2VyJ3Mgc3BlZWNoIHRvIGl0cyBmaXJzdCBzb3VuZC5cbiAgICAgICAgaWYgKCFtZXRyaWNzLnJlcGxpZWQgJiYgYXVkaW8ucXVldWVkIDwgMC4wNSAmJiB0IC0gbWV0cmljcy5sYXN0UGxheSA+IDAuNiAmJiBtZXRyaWNzLmxhc3RWb2ljZSA+IDAgJiYgdCAtIG1ldHJpY3MubGFzdFZvaWNlIDwgMTApIHtcbiAgICAgICAgICBtZXRyaWNzLnJlcGx5LnB1c2godCAtIG1ldHJpY3MubGFzdFZvaWNlKTtcbiAgICAgICAgICBpZiAobWV0cmljcy5yZXBseS5sZW5ndGggPiAyMCkgbWV0cmljcy5yZXBseS5zaGlmdCgpO1xuICAgICAgICAgIG1ldHJpY3MucmVwbGllZCA9IHRydWU7XG4gICAgICAgICAgc2hvd01ldHJpY3MoKTtcbiAgICAgICAgfVxuICAgICAgICBtZXRyaWNzLmxhc3RQbGF5ID0gdDtcbiAgICAgICAgYXVkaW8ucGxheShjLnBjbSk7XG4gICAgICAgIGNvdW50cy5wbGF5Kys7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcImZsdXNoXCI6IGF1ZGlvLmZsdXNoKCk7IGxvZyhcIm91dFwiLCBcImZsdXNoXCIsIFwib3V0XCIpOyBicmVhaztcbiAgICAgIGNhc2UgXCJjdWVcIjpcbiAgICAgICAgYXVkaW8uY3VlKGMucGNtKTtcbiAgICAgICAgbG9nKFwib3V0XCIsIGBjdWUgJHtjLmVhcmNvbn1gLCBcIm91dFwiKTtcbiAgICAgICAgLy8gQSByZXF1ZXN0IHRoYXQgYmVjYW1lIGEgdGFzayBnZXRzIGEgdG9uZSwgbm90IGEgc3Bva2VuIHJlcGx5OiBub3RoaW5nIHRvIHRpbWUuXG4gICAgICAgIGlmIChjLmVhcmNvbiA9PT0gXCJ0YXNrU3RhcnRlZFwiKSBtZXRyaWNzLnJlcGxpZWQgPSB0cnVlO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJ3YWtld29yZFwiOiBlbnN1cmVDb3JlV2FrZShCb29sZWFuKGMub24pKTsgYnJlYWs7XG4gICAgICBjYXNlIFwidG9vbC5jYWxsXCI6IHZvaWQgdG9vbChjKTsgYnJlYWs7XG4gICAgICBjYXNlIFwidG9vbC5jYW5jZWxcIjogY2FuY2VsUnVuKGMucnVuLCBjLnJlYXNvbik7IGJyZWFrO1xuICAgICAgY2FzZSBcInRvb2wuc3RlZXJcIjogdm9pZCBzdGVlclJ1bihjKTsgYnJlYWs7XG4gICAgICBjYXNlIFwic3RhdHVzXCI6IHtcbiAgICAgICAgY29uc3QgcHJldiA9IGNvcmVTdGF0dXM7XG4gICAgICAgIGNvcmVTdGF0dXMgPSBjLnN0YXR1cztcbiAgICAgICAgaWYgKGMuc3RhdHVzID09PSBcImRvcm1hbnRcIiAmJiBwcmV2ICE9PSBcImRvcm1hbnRcIiAmJiBjaGVja2VkKFwid2FrZS1jdWVcIikpIGF1ZGlvLmN1ZShTTEVFUF9UT05FKTtcbiAgICAgICAgc2hvd1N0YXR1cyhjLnN0YXR1cyA9PT0gXCJlbmRlZFwiID8gYy5tZXNzYWdlID8/IHVuZGVmaW5lZCA6IHVuZGVmaW5lZCk7XG4gICAgICAgIGxvZyhcInN0YXR1c1wiLCBjLnN0YXR1cyArIChjLm1lc3NhZ2UgPyBgOiAke2MubWVzc2FnZX1gIDogXCJcIiksIFwic3RhdHVzXCIpO1xuICAgICAgICBpZiAoYy5zdGF0dXMgPT09IFwiZW5kZWRcIikgeyBpZiAoYy5tZXNzYWdlKSBub3RlKGMubWVzc2FnZSk7IGVuZCgpOyB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcImxsbS5yZXF1ZXN0XCI6IHZvaWQgZ2VuZXJhdGUoYy5pZCwgYy5ib2R5KTsgYnJlYWs7XG4gICAgICBjYXNlIFwibGxtLmNhbmNlbFwiOiByZXF1ZXN0cy5nZXQoYy5pZCk/LmFib3J0KCk7IHJlcXVlc3RzLmRlbGV0ZShjLmlkKTsgbG9nKFwib3V0XCIsIGByZXF1ZXN0ICR7Yy5pZH0gZHJvcHBlZGAsIFwib3V0XCIpOyBicmVhaztcbiAgICAgIGNhc2UgXCJ0aGlua2luZ1wiOiB0aGlua2luZyA9IGMub247IHNob3dTdGF0dXMoKTsgYnJlYWs7XG4gICAgICBjYXNlIFwiZXJyb3JcIjogbm90ZShjLm1lc3NhZ2UpOyBsb2coXCJlcnJvclwiLCBjLm1lc3NhZ2UsIFwiZXJyXCIpOyBicmVhaztcbiAgICAgIGNhc2UgXCJjYXB0aW9uXCI6IGNhcHRpb24oYy50ZXh0KTsgYnJlYWs7XG4gICAgICBjYXNlIFwidHJhbnNjcmlwdFwiOlxuICAgICAgICB0cmFuc2NyaXB0KGMucm9sZSwgYy50ZXh0LCBjLmxpbmUpO1xuICAgICAgICByZW1lbWJlcihjLnJvbGUsIGMudGV4dCwgYy5yb2xlID09PSBcImFzc2lzdGFudFwiID8gXCJHZW1pbmlcIiA6IHVuZGVmaW5lZCwgbGFzdExpbmUgPT09IGMubGluZSk7XG4gICAgICAgIGxhc3RMaW5lID0gYy5saW5lO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJ0YXNrXCI6IHtcbiAgICAgICAgY29uc3QgdmlldyA9IHRhc2tzLmdldChjLmlkKSA/PyB7IGMsIHNpbmNlOiBub3coKSwgZW5kZWQ6IG51bGwgfTtcbiAgICAgICAgaWYgKGMuc3RhdGUgPT09IFwicnVubmluZ1wiICYmIHZpZXcuYy5zdGF0ZSAhPT0gXCJydW5uaW5nXCIpIHsgdmlldy5zaW5jZSA9IG5vdygpOyB2aWV3LmVuZGVkID0gbnVsbDsgfVxuICAgICAgICBpZiAoYy5zdGF0ZSAhPT0gXCJydW5uaW5nXCIgJiYgdmlldy5lbmRlZCA9PSBudWxsKSB2aWV3LmVuZGVkID0gbm93KCk7XG4gICAgICAgIHZpZXcuYyA9IGM7XG4gICAgICAgIHRhc2tzLnNldChjLmlkLCB2aWV3KTtcbiAgICAgICAgc2hvd1Rhc2tzKCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcInF1ZXN0aW9uc1wiOiBicmVhaztcbiAgICAgIGNhc2UgXCJtaWNTaWxlbnRcIjogJChcIm1pY3dhcm5cIikuaGlkZGVuID0gIWMuc2lsZW50OyBicmVhaztcbiAgICAgIGNhc2UgXCJ2b2ljZUNvbW1hbmRcIjpcbiAgICAgICAgdG9hc3QoYEhlYXJkIFx1MjAxQyR7Yy5oZWFyZH1cdTIwMUQ6ICR7Yy5jb21tYW5kID09PSBcInN0b3BcIiA/IFwic3RvcHBlZFwiIDogYy5jb21tYW5kID09PSBcImNhbmNlbEFsbFwiID8gXCJjYW5jZWxsaW5nIGV2ZXJ5IHRhc2tcIiA6IFwiaGFuZ2luZyB1cFwifWApO1xuICAgICAgICBsb2coXCJvdXRcIiwgYHZvaWNlIGNvbW1hbmQgJHtjLmNvbW1hbmR9OiAke2MuaGVhcmR9YCwgXCJvdXRcIik7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcImxvZ1wiOiBsb2coYy5sZXZlbCwgYy5tZXNzYWdlLCBjLmxldmVsID09PSBcIndhcm5cIiA/IFwid2FyblwiIDogXCJcIik7IGJyZWFrO1xuICAgICAgZGVmYXVsdDogbG9nKFwib3V0XCIsIEpTT04uc3RyaW5naWZ5KGMpLnNsaWNlKDAsIDMwMCksIFwib3V0XCIpO1xuICAgIH1cbiAgfVxufVxuXG5mdW5jdGlvbiBvbk1pYyhzYW1wbGVzOiBJbnQxNkFycmF5LCBsZXZlbDogbnVtYmVyKSB7XG4gIGlmIChzaG91bGRGZWVkV2FrZSgpKSB3YWtlQ2xpZW50LmZlZWQoc2FtcGxlcyk7XG4gIGlmICh3YWtlU3RhcnRpbmcpIHtcbiAgICBjb25zdCBjb3B5ID0gbmV3IFVpbnQ4QXJyYXkoc2FtcGxlcy5ieXRlTGVuZ3RoKTtcbiAgICBjb3B5LnNldChuZXcgVWludDhBcnJheShzYW1wbGVzLmJ1ZmZlciwgc2FtcGxlcy5ieXRlT2Zmc2V0LCBzYW1wbGVzLmJ5dGVMZW5ndGgpKTtcbiAgICBvcGVuaW5nQ2h1bmtzLnB1c2goY29weSk7XG4gICAgb3BlbmluZ0J5dGVzICs9IGNvcHkuYnl0ZUxlbmd0aDtcbiAgICB3aGlsZSAob3BlbmluZ0J5dGVzID4gT1BFTklOR19NQVhfQllURVMgJiYgb3BlbmluZ0NodW5rcy5sZW5ndGggPiAxKSB7XG4gICAgICBvcGVuaW5nQnl0ZXMgLT0gb3BlbmluZ0NodW5rcy5zaGlmdCgpIS5ieXRlTGVuZ3RoO1xuICAgIH1cbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKCFjYWxsSWQgfHwgbWVkaXVtICE9PSBcInZvaWNlXCIpIHJldHVybjtcbiAgY291bnRzLm1pYysrO1xuICBpZiAobGV2ZWwgPiAwLjAzICYmICEobXV0ZWQgJiYgIWhvbGRpbmcpKSB7XG4gICAgbWV0cmljcy5sYXN0Vm9pY2UgPSBub3coKTtcbiAgICBpZiAoYXVkaW8ucXVldWVkIDwgMC4wNSkgbWV0cmljcy5yZXBsaWVkID0gZmFsc2U7XG4gIH1cbiAgcHVzaCh7IHR5cGU6IFwibWljXCIsIHBjbTogYnl0ZXNUb0Jhc2U2NChuZXcgVWludDhBcnJheShzYW1wbGVzLmJ1ZmZlciwgc2FtcGxlcy5ieXRlT2Zmc2V0LCBzYW1wbGVzLmJ5dGVMZW5ndGgpKSB9KTtcbn1cblxuZnVuY3Rpb24gY29ubmVjdChzaWQ6IG51bWJlciwgY2FwdGlvbnM6IGJvb2xlYW4pIHtcbiAgY29uc3Qgd3MgPSBuZXcgV2ViU29ja2V0KGAke2xvY2F0aW9uLnByb3RvY29sID09PSBcImh0dHBzOlwiID8gXCJ3c3NcIiA6IFwid3NcIn06Ly8ke2xvY2F0aW9uLmhvc3R9L2xpdmUke2NhcHRpb25zID8gXCI/Zm9yPWNhcHRpb25zXCIgOiBcIlwifWApO1xuICBzb2NrZXRzLnNldChzaWQsIHdzKTtcbiAgaWYgKGNhcHRpb25zKSBjYXB0aW9uU29ja2V0cy5hZGQoc2lkKTtcbiAgbG9nKFwib3V0XCIsIGB3cyAke3NpZH0gY29ubmVjdCAoJHtzZXJ2ZXIucm91dGV9JHtjYXB0aW9ucyA/IFwiLCBjYXB0aW9uc1wiIDogXCJcIn0pYCwgXCJvdXRcIik7XG4gIHdzLm9ub3BlbiA9ICgpID0+IHB1c2goeyB0eXBlOiBcIndzLm9wZW5cIiwgc2lkIH0pO1xuICB3cy5vbm1lc3NhZ2UgPSAobSkgPT4gcHVzaCh7IHR5cGU6IFwid3MubWVzc2FnZVwiLCBzaWQsIGRhdGE6IHR5cGVvZiBtLmRhdGEgPT09IFwic3RyaW5nXCIgPyBtLmRhdGEgOiBcIlwiIH0pO1xuICB3cy5vbmNsb3NlID0gKGUpID0+IHtcbiAgICBpZiAoc29ja2V0cy5nZXQoc2lkKSAhPT0gd3MgJiYgc29ja2V0cy5oYXMoc2lkKSkgcmV0dXJuO1xuICAgIGNvbnN0IGh0dHBTdGF0dXMgPSBlLmNvZGUgPj0gNDEwMCAmJiBlLmNvZGUgPCA0NjAwID8gZS5jb2RlIC0gNDAwMCA6IHVuZGVmaW5lZDtcbiAgICBwdXNoKHsgdHlwZTogXCJ3cy5jbG9zZWRcIiwgc2lkLCBjb2RlOiBodHRwU3RhdHVzID8gdW5kZWZpbmVkIDogZS5jb2RlLCByZWFzb246IGUucmVhc29uLCBodHRwU3RhdHVzIH0pO1xuICB9O1xufVxuXG4vKiogQSBjaGF0J3MgcmVxdWVzdCB0byB0aGUgdGV4dCBtb2RlbCwgdGhyb3VnaCB0aGUgc2VydmVyOiBlYWNoIGBkYXRhOmAgbGluZSBvZiB0aGUgbW9kZWwncyBzdHJlYW0gZ29lcyB0byB0aGUgY29yZSBhcyBpdCBjb21lcy4gKi9cbmFzeW5jIGZ1bmN0aW9uIGdlbmVyYXRlKGlkOiBudW1iZXIsIGJvZHk6IHN0cmluZykge1xuICBjb25zdCBhYm9ydCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgcmVxdWVzdHMuc2V0KGlkLCBhYm9ydCk7XG4gIGxvZyhcIm91dFwiLCBgcmVxdWVzdCAke2lkfSBcdTIxOTIgJHtzZXJ2ZXIudGV4dE1vZGVsfSAoJHtNYXRoLnJvdW5kKGJvZHkubGVuZ3RoIC8gMTAyNCl9IEtCKWAsIFwib3V0XCIpO1xuICB0cnkge1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goXCIvZ2VuZXJhdGVcIiwgeyBtZXRob2Q6IFwiUE9TVFwiLCBzaWduYWw6IGFib3J0LnNpZ25hbCwgaGVhZGVyczogeyBcImNvbnRlbnQtdHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LCBib2R5IH0pO1xuICAgIGlmICghcmVzcG9uc2Uub2sgfHwgIXJlc3BvbnNlLmJvZHkpIHtcbiAgICAgIGNvbnN0IHRleHQgPSBhd2FpdCByZXNwb25zZS50ZXh0KCkuY2F0Y2goKCkgPT4gXCJcIik7XG4gICAgICBwdXNoKHsgdHlwZTogXCJsbG0uZW5kXCIsIGlkLCBzdGF0dXM6IHJlc3BvbnNlLnN0YXR1cywgZXJyb3I6IGBIVFRQICR7cmVzcG9uc2Uuc3RhdHVzfSR7dGV4dCA/IFwiOiBcIiArIHRleHQucmVwbGFjZSgvXFxzKy9nLCBcIiBcIikuc2xpY2UoMCwgMjAwKSA6IFwiXCJ9YCB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgcmVhZGVyID0gcmVzcG9uc2UuYm9keS5waXBlVGhyb3VnaChuZXcgVGV4dERlY29kZXJTdHJlYW0oKSkuZ2V0UmVhZGVyKCk7XG4gICAgbGV0IGJ1ZmZlciA9IFwiXCI7XG4gICAgZm9yICg7Oykge1xuICAgICAgY29uc3QgeyB2YWx1ZSwgZG9uZSB9ID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcbiAgICAgIGlmIChkb25lKSBicmVhaztcbiAgICAgIGJ1ZmZlciArPSB2YWx1ZTtcbiAgICAgIGxldCBjdXQ7XG4gICAgICB3aGlsZSAoKGN1dCA9IGJ1ZmZlci5pbmRleE9mKFwiXFxuXCIpKSA+PSAwKSB7XG4gICAgICAgIGNvbnN0IGxpbmUgPSBidWZmZXIuc2xpY2UoMCwgY3V0KS5yZXBsYWNlKC9cXHIkLywgXCJcIik7XG4gICAgICAgIGJ1ZmZlciA9IGJ1ZmZlci5zbGljZShjdXQgKyAxKTtcbiAgICAgICAgaWYgKGxpbmUuc3RhcnRzV2l0aChcImRhdGE6XCIpKSBwdXNoKHsgdHlwZTogXCJsbG0uZGF0YVwiLCBpZCwgZGF0YTogbGluZS5zbGljZSg1KS50cmltKCkgfSk7XG4gICAgICB9XG4gICAgfVxuICAgIHB1c2goeyB0eXBlOiBcImxsbS5lbmRcIiwgaWQgfSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGlmICghYWJvcnQuc2lnbmFsLmFib3J0ZWQpIHB1c2goeyB0eXBlOiBcImxsbS5lbmRcIiwgaWQsIGVycm9yOiAoZXJyIGFzIEVycm9yKS5tZXNzYWdlIH0pO1xuICB9IGZpbmFsbHkge1xuICAgIHJlcXVlc3RzLmRlbGV0ZShpZCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gY2FuY2VsUnVuKGtleTogc3RyaW5nLCByZWFzb246IHN0cmluZykge1xuICBjb25zdCByID0gcnVucy5nZXQoa2V5KTtcbiAgbG9nKFwib3V0XCIsIGBjYW5jZWwgJHtrZXl9ICgke3JlYXNvbn0pYCwgXCJvdXRcIik7XG4gIGlmICghcikgcmV0dXJuO1xuICBydW5zLmRlbGV0ZShrZXkpO1xuICByLmFib3J0LmFib3J0KCk7XG4gIC8vIENhbmNlbGxlZCBvbiBwdXJwb3NlOiB0aGUgYWdlbnQgc3RvcHMgdG9vLiBBIGNhbGwgdGhhdCBlbmRlZCBsZWF2ZXMgYSBjb2RpbmcgYWdlbnQgd29ya2luZyBpbiBUMy5cbiAgaWYgKHJlYXNvbiA9PT0gXCJjYW5jZWxsZWRcIiAmJiAhY2hlY2tlZChcImZha2VoZXJtZXNcIikpIHtcbiAgICB2b2lkIGZldGNoKHIuYWdlbnQgPT09IFwidDNcIiA/IFwiL2FnZW50L2NhbmNlbFwiIDogXCIvaGVybWVzL3N0b3BcIiwgeyBtZXRob2Q6IFwiUE9TVFwiLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGNhbGw6IGNhbGxOYW1lLCB0YXNrSWQ6IHIudGFza0lkIH0pIH0pO1xuICB9XG59XG5cbi8qKiBNb3JlIGZvciBhIHJ1bm5pbmcgdGFzaywgaW50byBpdHMgY3VycmVudCBydW47IGlmIHRoZSBhZ2VudCB3b24ndCB0YWtlIGl0LCB0aGUgY29yZSBxdWV1ZXMgaXQgaW5zdGVhZC4gKi9cbmFzeW5jIGZ1bmN0aW9uIHN0ZWVyUnVuKGM6IENvbW1hbmQpIHtcbiAgY29uc3QgciA9IHJ1bnMuZ2V0KGMucnVuKTtcbiAgbG9nKFwib3V0XCIsIGBzdGVlciAke2MucnVufTogJHtjLnRleHR9YCwgXCJvdXRcIik7XG4gIGlmIChjaGVja2VkKFwiZmFrZWhlcm1lc1wiKSkgcmV0dXJuO1xuICBjb25zdCBvayA9IHIgIT0gbnVsbCAmJlxuICAgIChhd2FpdCBmZXRjaChjLmFnZW50ID09PSBcInQzXCIgPyBcIi9hZ2VudC9zdGVlclwiIDogXCIvaGVybWVzL3N0ZWVyXCIsIHsgbWV0aG9kOiBcIlBPU1RcIiwgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBjYWxsOiBjYWxsTmFtZSwgdGFza0lkOiByLnRhc2tJZCwgdGV4dDogYy5tZXNzYWdlIH0pIH0pLnRoZW4oKHgpID0+IHgub2ssICgpID0+IGZhbHNlKSk7XG4gIGlmICghb2spIHB1c2goeyB0eXBlOiBcInRvb2wuc3RlZXJGYWlsZWRcIiwgcnVuOiBjLnJ1biwgdGV4dDogYy50ZXh0IH0pO1xuICBlbHNlIHRvYXN0KGAke2MuYWdlbnQgPT09IFwidDNcIiA/IFwiVGhlIGNvZGluZyBhZ2VudFwiIDogXCJIZXJtZXNcIn0gdG9vayB0aGUgZm9sbG93LXVwIHdoaWxlIGl0IHdvcmtzYCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHRvb2woYzogQ29tbWFuZCkge1xuICBpZiAoYy5raW5kID09PSBcImhvc3RcIikge1xuICAgIGxvZyhcIm91dFwiLCBgaG9zdCB0b29sICR7Yy5uYW1lfSAke0pTT04uc3RyaW5naWZ5KGMuYXJncyl9YCwgXCJvdXRcIik7XG4gICAgY29uc3QgYW5zd2VyID0gYy5uYW1lID09PSBcInR2X3ZvbHVtZVwiID8gYFRoZSBUViBpcyBhdCAkeyhmYWtlVHZMZXZlbCA9IE51bWJlcihjLmFyZ3M/LmxldmVsID8/IGZha2VUdkxldmVsKSl9LmBcbiAgICAgIDogYy5uYW1lID09PSBcInR2X3BhdXNlXCIgPyAoYy5hcmdzPy5wYXVzZSA9PT0gZmFsc2UgPyBcIlBsYXlpbmcuXCIgOiBcIlBhdXNlZC5cIikgOiBcIkRvbmUuXCI7XG4gICAgc2V0VGltZW91dCgoKSA9PiBwdXNoKHsgdHlwZTogXCJ0b29sLnJlc3VsdFwiLCBydW46IGMucnVuLCB0ZXh0OiBhbnN3ZXIgfSksIDMwMCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IGFnZW50ID0gYy5hZ2VudCA9PT0gXCJ0M1wiID8gXCJ0M1wiIDogXCJoZXJtZXNcIjtcbiAgbG9nKFwib3V0XCIsIGAke2FnZW50fSAke2MuZm9sbG93VXAgPyBcImZvbGxvdy11cFwiIDogXCJ0YXNrXCJ9IFwiJHtjLmxhYmVsfVwiJHtjLnByb2plY3QgPyBgIGluICR7Yy5wcm9qZWN0fWAgOiBcIlwifTogJHtjLnJlcXVlc3R9YCwgXCJvdXRcIik7XG4gIGNvbnN0IGFib3J0ID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICBydW5zLnNldChjLnJ1biwgeyBhYm9ydCwgYWdlbnQsIHRhc2tJZDogYy50YXNrSWQgfSk7XG4gIGNvbnN0IGRvbmUgPSAodGV4dDogc3RyaW5nLCBmYWlsZWQgPSBmYWxzZSkgPT4ge1xuICAgIGlmICghcnVucy5oYXMoYy5ydW4pKSByZXR1cm47XG4gICAgcnVucy5kZWxldGUoYy5ydW4pO1xuICAgIGNvbnN0IHZpZXcgPSB0YXNrcy5nZXQoYy50YXNrSWQpO1xuICAgIGNvbnN0IHJvdyA9IHJlc3VsdChhZ2VudCwgYy5sYWJlbCwgdGV4dCwgZmFpbGVkKTtcbiAgICBub3RpZnkoYCR7YWdlbnQgPT09IFwidDNcIiA/IFwiVDNcIiA6IFwiSGVybWVzXCJ9IFx1MDBCNyAke2MubGFiZWx9YCwgdGV4dCk7XG4gICAgaWYgKCFmYWlsZWQpIHsgcmVtZW1iZXIoXCJhc3Npc3RhbnRcIiwgdGV4dCwgYCR7YWdlbnQgPT09IFwidDNcIiA/IFwiVDNcIiA6IFwiSGVybWVzXCJ9IFx1MDBCNyAke2MubGFiZWx9YCk7IGxhc3RMaW5lID0gbnVsbDsgfVxuICAgIGlmICh2aWV3KSB7IHZpZXcucmVzdWx0ID0gcm93OyBzaG93VGFza3MoKTsgfVxuICAgIHB1c2goeyB0eXBlOiBcInRvb2wucmVzdWx0XCIsIHJ1bjogYy5ydW4sIHRleHQsIGZhaWxlZCB9KTtcbiAgfTtcbiAgaWYgKGNoZWNrZWQoXCJmYWtlaGVybWVzXCIpKSB7XG4gICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IGRvbmUoYChGYWtlICR7YWdlbnQgPT09IFwidDNcIiA/IFwiVDNcIiA6IFwiSGVybWVzXCJ9KSBEb25lOiBcdTIwMUMke2MucmVxdWVzdH1cdTIwMUQuIE5vdGhpbmcgd2FzIGFjdHVhbGx5IHJ1bi5gKSwgTnVtYmVyKCQ8SFRNTElucHV0RWxlbWVudD4oXCJmYWtlZGVsYXlcIikudmFsdWUpICogMTAwMCk7XG4gICAgYWJvcnQuc2lnbmFsLm9uYWJvcnQgPSAoKSA9PiBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgIHJldHVybjtcbiAgfVxuICB0cnkge1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goYWdlbnQgPT09IFwidDNcIiA/IFwiL2FnZW50XCIgOiBcIi9oZXJtZXNcIiwge1xuICAgICAgbWV0aG9kOiBcIlBPU1RcIiwgc2lnbmFsOiBhYm9ydC5zaWduYWwsIGhlYWRlcnM6IHsgXCJjb250ZW50LXR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgY2FsbDogY2FsbE5hbWUsIHRhc2tJZDogYy50YXNrSWQsIGZvbGxvd1VwOiBjLmZvbGxvd1VwLCBtZXNzYWdlOiBjLm1lc3NhZ2UsIGxhYmVsOiBjLmxhYmVsLCByZXF1ZXN0OiBjLnJlcXVlc3QsIHByb2plY3Q6IGMucHJvamVjdCwgYXBwcm92YWxzOiBcInNjcmVlblwiIH0pLFxuICAgIH0pO1xuICAgIGlmICghcmVzcG9uc2Uub2sgfHwgIXJlc3BvbnNlLmJvZHkpIHRocm93IG5ldyBFcnJvcihgSFRUUCAke3Jlc3BvbnNlLnN0YXR1c31gKTtcbiAgICBjb25zdCByZWFkZXIgPSByZXNwb25zZS5ib2R5LnBpcGVUaHJvdWdoKG5ldyBUZXh0RGVjb2RlclN0cmVhbSgpKS5nZXRSZWFkZXIoKTtcbiAgICBsZXQgYnVmZmVyID0gXCJcIjtcbiAgICBmb3IgKDs7KSB7XG4gICAgICBjb25zdCB7IHZhbHVlLCBkb25lOiBmaW5pc2hlZCB9ID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcbiAgICAgIGlmIChmaW5pc2hlZCkgYnJlYWs7XG4gICAgICBidWZmZXIgKz0gdmFsdWU7XG4gICAgICBsZXQgY3V0O1xuICAgICAgd2hpbGUgKChjdXQgPSBidWZmZXIuaW5kZXhPZihcIlxcblxcblwiKSkgPj0gMCkge1xuICAgICAgICBjb25zdCBibG9jayA9IGJ1ZmZlci5zbGljZSgwLCBjdXQpO1xuICAgICAgICBidWZmZXIgPSBidWZmZXIuc2xpY2UoY3V0ICsgMik7XG4gICAgICAgIGNvbnN0IGV2ZW50ID0gYmxvY2subWF0Y2goL15ldmVudDogKC4qKSQvbSk/LlsxXTtcbiAgICAgICAgaWYgKCFldmVudCkgY29udGludWU7XG4gICAgICAgIGNvbnN0IGRhdGEgPSBKU09OLnBhcnNlKGJsb2NrLm1hdGNoKC9eZGF0YTogKC4qKSQvbSk/LlsxXSA/PyBcInt9XCIpO1xuICAgICAgICBpZiAoZXZlbnQgPT09IFwicHJvZ3Jlc3NcIikgcHVzaCh7IHR5cGU6IFwidGFzay5wcm9ncmVzc1wiLCB0YXNrOiBjLnRhc2tJZCwgdGV4dDogZGF0YS50ZXh0IH0pO1xuICAgICAgICBlbHNlIGlmIChldmVudCA9PT0gXCJ0aHJlYWRcIikgeyBjb25zdCB2aWV3ID0gdGFza3MuZ2V0KGMudGFza0lkKTsgaWYgKHZpZXcpIHsgdmlldy50aHJlYWQgPSBkYXRhLnRocmVhZDsgc2hvd1Rhc2tzKCk7IH0gfVxuICAgICAgICBlbHNlIGlmIChldmVudCA9PT0gXCJhcHByb3ZhbFwiKSB7XG4gICAgICAgICAgY29uc3QgdmlldyA9IHRhc2tzLmdldChjLnRhc2tJZCk7XG4gICAgICAgICAgaWYgKHZpZXcpIHsgdmlldy5hcHByb3ZhbCA9IHsgY29tbWFuZDogZGF0YS5jb21tYW5kIH07IHNob3dUYXNrcyh0cnVlKTsgfVxuICAgICAgICAgIHRvYXN0KGBIZXJtZXMgYXNrcyB0byBydW46ICR7ZGF0YS5jb21tYW5kLnNsaWNlKDAsIDgwKX1gKTtcbiAgICAgICAgICBub3RpZnkoYEhlcm1lcyBcdTAwQjcgJHtjLmxhYmVsfSBuZWVkcyB5b3VyIGFwcHJvdmFsYCwgZGF0YS5jb21tYW5kKTtcbiAgICAgICAgICBhdWRpby5jdWUoQVBQUk9WQUxfVE9ORSk7XG4gICAgICAgIH1cbiAgICAgICAgZWxzZSBpZiAoZXZlbnQgPT09IFwicmVzdWx0XCIpIGRvbmUoZGF0YS50ZXh0LCBkYXRhLmZhaWxlZCk7XG4gICAgICAgIGVsc2UgaWYgKGV2ZW50ID09PSBcImVycm9yXCIpIHsgcnVucy5kZWxldGUoYy5ydW4pOyBwdXNoKHsgdHlwZTogXCJ0b29sLmVycm9yXCIsIHJ1bjogYy5ydW4sIG1lc3NhZ2U6IGRhdGEubWVzc2FnZSB9KTsgfVxuICAgICAgfVxuICAgIH1cbiAgICBpZiAocnVucy5oYXMoYy5ydW4pKSB7IHJ1bnMuZGVsZXRlKGMucnVuKTsgcHVzaCh7IHR5cGU6IFwidG9vbC5lcnJvclwiLCBydW46IGMucnVuLCBtZXNzYWdlOiBcInRoZSBzZXJ2ZXIgY2xvc2VkIHRoZSBzdHJlYW0gd2l0aG91dCBhIHJlc3VsdFwiIH0pOyB9XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGlmICghYWJvcnQuc2lnbmFsLmFib3J0ZWQgJiYgcnVucy5oYXMoYy5ydW4pKSB7IHJ1bnMuZGVsZXRlKGMucnVuKTsgcHVzaCh7IHR5cGU6IFwidG9vbC5lcnJvclwiLCBydW46IGMucnVuLCBtZXNzYWdlOiAoZXJyIGFzIEVycm9yKS5tZXNzYWdlIH0pOyB9XG4gIH1cbn1cblxuZnVuY3Rpb24gbWljT3B0aW9ucygpIHtcbiAgY29uc3QgYWVjID0gY2hlY2tlZChcImFlY1wiKTtcbiAgcmV0dXJuIHsgZWNob0NhbmNlbGxhdGlvbjogYWVjLCBub2lzZVN1cHByZXNzaW9uOiBhZWMsIGF1dG9HYWluQ29udHJvbDogYWVjIH07XG59XG5cbmZ1bmN0aW9uIG51bWJlclNldHRpbmcoaWQ6IHN0cmluZywgZmFsbGJhY2s6IG51bWJlciwgbWluID0gMCwgbWF4ID0gMzYwMCk6IG51bWJlciB7XG4gIGNvbnN0IG4gPSBOdW1iZXIoJDxIVE1MSW5wdXRFbGVtZW50PihpZCkudmFsdWUpO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pID8gTWF0aC5tYXgobWluLCBNYXRoLm1pbihtYXgsIG4pKSA6IGZhbGxiYWNrO1xufVxuXG5mdW5jdGlvbiByZWFkQ29uZmlnKCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgY29uc3QgZ2l2ZW4gPSBKU09OLnBhcnNlKCQ8SFRNTFRleHRBcmVhRWxlbWVudD4oXCJjb25maWdcIikudmFsdWUpO1xuICBjb25zdCBjb25maWc6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgIG1vZGVsOiBzZXJ2ZXIubW9kZWwsIGFwaTogc2VydmVyLnJvdXRlID09PSBcInZlcnRleFwiID8gXCJ2ZXJ0ZXhcIiA6IFwiZ2VtaW5pXCIsIHRvZGF5OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkuc2xpY2UoMCwgMTApLFxuICAgIC4uLmdpdmVuLCB0cmFjZTogY2hlY2tlZChcInRyYWNlXCIpLFxuICB9O1xuICBpZiAoY2hlY2tlZChcInB0dFwiKSkgY29uZmlnLm11dGVkID0gdHJ1ZTtcbiAgaWYgKGdpdmVuLnZvaWNlID09PSB1bmRlZmluZWQpIGNvbmZpZy52b2ljZSA9ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwidm9pY2VcIikudmFsdWU7XG4gIGlmIChjb25maWcuc3RlZXJpbmcgPT09IHVuZGVmaW5lZCkgY29uZmlnLnN0ZWVyaW5nID0gW1wiaGVybWVzXCIsIFwidDNcIl07XG4gIC8vIEEgd2ViIGNvbmZpZyBzYXZlZCBiZWZvcmUgaGFuZC1vZmZzIHdlcmUgbmFtZWQgaW4gd29yZHMgZ2V0cyB0aGF0IHRvby5cbiAgaWYgKGNvbmZpZy5oYW5kT2ZmID09PSB1bmRlZmluZWQgJiYgY29uZmlnLnBsYXRmb3JtID09PSBcIndlYlwiKSBjb25maWcuaGFuZE9mZiA9IFwibmFtZWRcIjtcbiAgLy8gQW5kIG9uZSBzYXZlZCBiZWZvcmUgdGhlIHBhZ2UgZm9sbG93ZWQgdGhlIHVzZXIncyBsZWFkIChzdXBlcnZpc2UpIGdldHMgdGhhdC5cbiAgaWYgKGNvbmZpZy5zdXBlcnZpc2UgPT09IHVuZGVmaW5lZCAmJiBjb25maWcucGxhdGZvcm0gPT09IFwid2ViXCIpIGNvbmZpZy5zdXBlcnZpc2UgPSB0cnVlO1xuICBpZiAoY2hlY2tlZChcImNvZGluZ1wiKSAmJiAoc2VydmVyLnQzIHx8IGNoZWNrZWQoXCJmYWtlaGVybWVzXCIpKSAmJiBjb25maWcuY29kaW5nQWdlbnQgPT09IHVuZGVmaW5lZCkgY29uZmlnLmNvZGluZ0FnZW50ID0geyBwcm9qZWN0czogc2VydmVyLnQzID8/IFtdIH07XG4gIGlmIChjaGVja2VkKFwiY2FwdGlvbnNcIikgJiYgc2VydmVyLmNhcHRpb25zTW9kZWwgJiYgY29uZmlnLmNhcHRpb25zID09PSB1bmRlZmluZWQpIGNvbmZpZy5jYXB0aW9ucyA9IHsgbW9kZWw6IHNlcnZlci5jYXB0aW9uc01vZGVsIH07XG4gIC8vIEFwcGx5IFNldHRpbmdzIHNpZ25hbGluZyBjb250cm9scyB3aGVuIHVzaW5nIHRoZSBkZWZhdWx0IHdlYiBwcmVzZXQgd2l0aG91dCByYXcgRGV2ZWxvcGVyIEpTT04gb3ZlcnJpZGVzLlxuICBjb25zdCBjdXN0b21Kc29uID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS1jb3JlLmNvbmZpZ1wiKSAhPSBudWxsO1xuICBjb25zdCBwcmVzZXROYW1lID0gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJwcmVzZXRcIikudmFsdWU7XG4gIGNvbnN0IHNpZ25hbGluZyA9ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwic2lnbmFsaW5nXCIpLnZhbHVlO1xuICBpZiAoIWN1c3RvbUpzb24gJiYgcHJlc2V0TmFtZSA9PT0gXCJ3ZWJcIikge1xuICAgIGNvbmZpZy5oYW5nVXBBZnRlciA9IG51bWJlclNldHRpbmcoXCJoYW5ndXAtYWZ0ZXJcIiwgc2lnbmFsaW5nID09PSBcImVjaG9cIiA/IDE1IDogMzAwLCAwLCAzNjAwKTtcbiAgICBpZiAoc2lnbmFsaW5nID09PSBcIndpbmRvd1wiIHx8IHNpZ25hbGluZyA9PT0gXCJlY2hvXCIpIHtcbiAgICAgIGNvbmZpZy5hdHRlbnRpb24gPSB7XG4gICAgICAgIG1vZGU6IFwid2luZG93XCIsXG4gICAgICAgIGFmdGVyV2FrZTogbnVtYmVyU2V0dGluZyhcImF0dG4tYWZ0ZXItd2FrZVwiLCA4LCAxLCA2MCksXG4gICAgICAgIHdpbmRvdzogbnVtYmVyU2V0dGluZyhcImF0dG4td2luZG93XCIsIDUsIDAsIDYwKSxcbiAgICAgICAgYWZ0ZXJRdWVzdGlvbjogbnVtYmVyU2V0dGluZyhcImF0dG4tYWZ0ZXItcXVlc3Rpb25cIiwgMTAsIDAsIDYwKSxcbiAgICAgICAgYWZ0ZXJIYW5kT2ZmOiAzLFxuICAgICAgICBhZnRlckFubm91bmNlbWVudDogMCxcbiAgICAgIH07XG4gICAgICBpZiAoc2lnbmFsaW5nID09PSBcImVjaG9cIikgY29uZmlnLnN0YW5kYnlBZnRlciA9IDg7XG4gICAgfVxuICAgIGlmIChjaGVja2VkKFwid2FrZS1iYXJnZVwiKSB8fCBzaWduYWxpbmcgPT09IFwiZWNob1wiKSB7XG4gICAgICBjb25zdCBtaWMgPSAoY29uZmlnLm1pYyAmJiB0eXBlb2YgY29uZmlnLm1pYyA9PT0gXCJvYmplY3RcIiA/IGNvbmZpZy5taWMgOiB7fSkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICBjb25maWcubWljID0geyBnYWluRGI6IDAsIC4uLm1pYywgd2hpbGVTcGVha2luZzogXCJ3YWtlXCIgfTtcbiAgICB9XG4gIH0gZWxzZSBpZiAoZ2l2ZW4uYXR0ZW50aW9uID09PSB1bmRlZmluZWQgJiYgKHNpZ25hbGluZyA9PT0gXCJ3aW5kb3dcIiB8fCBzaWduYWxpbmcgPT09IFwiZWNob1wiKSkge1xuICAgIGNvbmZpZy5hdHRlbnRpb24gPSB7XG4gICAgICBtb2RlOiBcIndpbmRvd1wiLFxuICAgICAgYWZ0ZXJXYWtlOiBudW1iZXJTZXR0aW5nKFwiYXR0bi1hZnRlci13YWtlXCIsIDgsIDEsIDYwKSxcbiAgICAgIHdpbmRvdzogbnVtYmVyU2V0dGluZyhcImF0dG4td2luZG93XCIsIDUsIDAsIDYwKSxcbiAgICAgIGFmdGVyUXVlc3Rpb246IG51bWJlclNldHRpbmcoXCJhdHRuLWFmdGVyLXF1ZXN0aW9uXCIsIDEwLCAwLCA2MCksXG4gICAgICBhZnRlckhhbmRPZmY6IDMsXG4gICAgICBhZnRlckFubm91bmNlbWVudDogMCxcbiAgICB9O1xuICB9XG4gIHJldHVybiBjb25maWc7XG59XG5cbi8qKiBTdGFydHMgYSB2b2ljZSBjYWxsLCBvciB3aXRoIFt0eXBlZF0gYSBjaGF0ICh0aGUgY29yZSdzIG1lZGl1bSBcInRleHRcIjogbm8gYXVkaW8sIGEgdGV4dCBtb2RlbCkuICovXG5hc3luYyBmdW5jdGlvbiBzdGFydChjYXJyeU9uID0gZmFsc2UsIHR5cGVkID0gZmFsc2UpIHtcbiAgYXdhaXQgZW5kaW5nO1xuICBpZiAoY2FsbElkKSByZXR1cm47XG4gIGxldCBnaXZlbjogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIHRyeSB7XG4gICAgZ2l2ZW4gPSByZWFkQ29uZmlnKCk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHRvYXN0KGBUaGUgZGV2ZWxvcGVyIHNldHRpbmdzIGFyZW4ndCB2YWxpZCBKU09OOiAkeyhlcnIgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmICh0eXBlZCkge1xuICAgIGlmICghc2VydmVyLnRleHRNb2RlbCkgeyB0b2FzdChcIlRoaXMgc2VydmVyIGhhcyBubyB0ZXh0IG1vZGVsIGZvciBhIGNoYXQ6IHN0YXJ0IGEgY2FsbCB0byB0eXBlIHRvIGl0XCIpOyByZXR1cm47IH1cbiAgICBnaXZlbiA9IHsgLi4uZ2l2ZW4sIG1lZGl1bTogXCJ0ZXh0XCIsIG11dGVkOiBmYWxzZSB9O1xuICAgIGRlbGV0ZSBnaXZlbi5jYXB0aW9ucztcbiAgICBpZiAod2FrZUFybWVkKSBhdWRpby5zdG9wTWljKCk7XG4gIH1cbiAgJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJjYWxsXCIpLmRpc2FibGVkID0gdHJ1ZTtcbiAgJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJoZXJvLWNhbGxcIikuZGlzYWJsZWQgPSB0cnVlO1xuICBpZiAoXCJOb3RpZmljYXRpb25cIiBpbiB3aW5kb3cgJiYgTm90aWZpY2F0aW9uLnBlcm1pc3Npb24gPT09IFwiZGVmYXVsdFwiKSB2b2lkIE5vdGlmaWNhdGlvbi5yZXF1ZXN0UGVybWlzc2lvbigpLmNhdGNoKCgpID0+IHt9KTtcbiAgdHJ5IHtcbiAgICBpZiAoIXR5cGVkKSBhd2FpdCBhdWRpby5vcGVuKCk7XG4gICAgY29yZSA9IGF3YWl0IGxvYWRDb3JlKCk7XG4gIH0gZmluYWxseSB7XG4gICAgJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJjYWxsXCIpLmRpc2FibGVkID0gZmFsc2U7XG4gICAgJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJoZXJvLWNhbGxcIikuZGlzYWJsZWQgPSBmYWxzZTtcbiAgfVxuICBpZiAoY2FsbElkKSByZXR1cm47IC8vIGFub3RoZXIgc3RhcnQgZ290IHRoZXJlIGZpcnN0XG4gIG1lZGl1bSA9IHR5cGVkID8gXCJ0ZXh0XCIgOiBcInZvaWNlXCI7XG4gIHRoaW5raW5nID0gZmFsc2U7XG4gICQoXCJ2ZXJzaW9uXCIpLnRleHRDb250ZW50ID0gY29yZS52ZXJzaW9uO1xuICAkKFwibG9nXCIpLmlubmVySFRNTCA9IFwiXCI7XG4gIGlmICghdHlwZWQgJiYgKHRhc2tzLnNpemUgPiAwIHx8ICQoXCJ0cmFuc2NyaXB0XCIpLmNoaWxkRWxlbWVudENvdW50ID4gMSkpIG5vdGUoYE5ldyBjYWxsIFx1MDBCNyAke25ldyBEYXRlKCkudG9Mb2NhbGVUaW1lU3RyaW5nKCl9YCk7XG4gIHNjcm9sbERvd24odHJ1ZSk7XG4gIHRhc2tzLmNsZWFyKCk7XG4gIHNob3dUYXNrcygpO1xuICBjb3VudHMgPSB7IG1pYzogMCwgcGxheTogMCwgc2VudDogMCB9O1xuICBtZXRyaWNzLnJlcGx5ID0gW107XG4gIHN0YXJ0ZWRBdCA9IG5vdygpO1xuICBtdXRlZCA9IGdpdmVuLm11dGVkID09PSB0cnVlO1xuICAvLyBDYXJyeWluZyBvbjogdGhlIG1vZGVsIGdldHMgdGhlIGxhc3QgY29udmVyc2F0aW9uIGFzIGEgcmVjYXAuIFRoZSBjb3JlIGNhcHMgaXQsIGxhdGVzdCBsaW5lcyBmaXJzdC5cbiAgLy8gQSBjaGF0IGFsd2F5cyBjYXJyaWVzIG9uIGZyb20gd2hhdCdzIG9uIHRoZSBzY3JlZW4gKGFuIGVhcmxpZXIgY2FsbCBvciBjaGF0IG9uIHRoaXMgcGFnZSkuXG4gIGlmICh0eXBlZCkgeyBpZiAoY2hhdC5sZW5ndGggPiAwICYmIGdpdmVuLmhpc3RvcnkgPT09IHVuZGVmaW5lZCkgZ2l2ZW4uaGlzdG9yeSA9IGNoYXQ7IH1cbiAgZWxzZSBpZiAoY2FycnlPbiAmJiBnaXZlbi5oaXN0b3J5ID09PSB1bmRlZmluZWQpIGdpdmVuLmhpc3RvcnkgPSBzYXZlZEhpc3RvcnkoKTtcbiAgZWxzZSBpZiAoIWNhcnJ5T24pIGNoYXQgPSBbXTtcbiAgaWYgKGNhcnJ5T24gJiYgIXR5cGVkKSBjaGF0ID0gc2F2ZWRIaXN0b3J5KCk7XG4gIGxhc3RMaW5lID0gbnVsbDtcbiAgb3BlbkxpbmUgPSBudWxsO1xuICBzeW5jUmVzdW1lQnV0dG9ucyhmYWxzZSk7XG4gIGNhbGxOYW1lID0gYCR7bmV3IERhdGUoKS50b0lTT1N0cmluZygpLnJlcGxhY2UoL1s6Ll0vZywgXCItXCIpfS0ke3R5cGVkID8gXCJjaGF0XCIgOiBcIndlYlwifS0ke2NvcmUudmVyc2lvbn1gO1xuICBjb25zdCBjcmVhdGVkID0gSlNPTi5wYXJzZShjb3JlLmNyZWF0ZShKU09OLnN0cmluZ2lmeShnaXZlbiksIG5vdygpKSk7XG4gIGNhbGxJZCA9IGNyZWF0ZWQuaWQ7XG4gIGlmICghdHlwZWQpIHtcbiAgICBzZXRDYWxsQnV0dG9uKHRydWUpO1xuICAgICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwibWljXCIpLmRpc2FibGVkID0gZmFsc2U7XG4gIH1cbiAgJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJodXNoXCIpLmRpc2FibGVkID0gZmFsc2U7XG4gICQoXCJtaWNcIikuY2xhc3NMaXN0LnRvZ2dsZShcIm11dGVkXCIsIG11dGVkKTtcbiAgcnVuKGNyZWF0ZWQuY29tbWFuZHMpO1xuICBzaG93U3RhdHVzKCk7XG4gIHRpY2tlciA9IHdpbmRvdy5zZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgcHVzaCh7IHR5cGU6IFwidGlja1wiIH0pO1xuICAgIGNvbnN0IGxldmVsID0gbXV0ZWQgJiYgIWhvbGRpbmcgPyAwIDogYXVkaW8ubGV2ZWw7XG4gICAgY29uc3Qgc3RyZW5ndGggPSBNYXRoLm1pbigxLCBsZXZlbCAqIDEyKTtcbiAgICAkKFwicmluZ1wiKS5zdHlsZS5vcGFjaXR5ID0gU3RyaW5nKHN0cmVuZ3RoKTtcbiAgICAkKFwicmluZ1wiKS5zdHlsZS50cmFuc2Zvcm0gPSBgc2NhbGUoJHsoMSArIHN0cmVuZ3RoICogMC4xMikudG9GaXhlZCgzKX0pYDtcbiAgICAkKFwiY291bnRzXCIpLnRleHRDb250ZW50ID0gYG1pYyAke2NvdW50cy5taWN9IFx1MDBCNyBzZW50ICR7Y291bnRzLnNlbnR9IFx1MDBCNyBwbGF5ZWQgJHtjb3VudHMucGxheX0gXHUwMEI3IHF1ZXVlZCAke2F1ZGlvLnF1ZXVlZC50b0ZpeGVkKDEpfSBzYDtcbiAgICBzaG93U3RhdHVzKCk7XG4gIH0sIDEwMCk7XG4gIHRyYWNlVGltZXIgPSB3aW5kb3cuc2V0SW50ZXJ2YWwoKCkgPT4geyB2b2lkIHNhdmVUcmFjZSgpOyB2b2lkIHBpbmcoKTsgc2hvd1Rhc2tzKCk7IH0sIDUwMDApO1xuICB2b2lkIHBpbmcoKTtcbiAgaWYgKHR5cGVkKSByZXR1cm47XG4gIHN0b3BXb3Jkcy5zdGFydCgpO1xuICBhd2FpdCBhY3F1aXJlV2FrZUxvY2soKTtcbn1cblxuLyoqIFRoZSBDYWxsIGJ1dHRvbjogaGFuZ3MgdXAgYSBjYWxsOyBzdGFydHMgb25lOyBvciwgd2l0aCBhIGNoYXQgb24sIGVuZHMgdGhlIGNoYXQgYW5kIGNhcnJpZXMgaXRzIGNvbnZlcnNhdGlvbiBvbiBieSB2b2ljZS4gKi9cbmFzeW5jIGZ1bmN0aW9uIGNhbGxCdXR0b24oKSB7XG4gIGlmIChjYWxsSWQgJiYgbWVkaXVtID09PSBcInZvaWNlXCIpIHsgaGFuZ1VwKCk7IHJldHVybjsgfVxuICBpZiAoY2FsbElkKSB7XG4gICAgLy8gQSBjYWxsIGNhbid0IHRha2Ugb3ZlciB0aGUgY2hhdCdzIHRhc2tzLCBhbmQgZW5kaW5nIHRoZSBjaGF0IHdvdWxkIHN0b3AgdGhlbS5cbiAgICBpZiAoWy4uLnRhc2tzLnZhbHVlcygpXS5zb21lKCh2KSA9PiB2LmMuc3RhdGUgPT09IFwicnVubmluZ1wiKSkgeyB0b2FzdChcIlRoZSBjaGF0J3MgdGFza3MgYXJlIHN0aWxsIHJ1bm5pbmc6IHdhaXQgZm9yIHRoZW0gb3IgY2FuY2VsIHRoZW0sIHRoZW4gY2FsbFwiKTsgcmV0dXJuOyB9XG4gICAgcHVzaCh7IHR5cGU6IFwic3RvcFwiIH0pO1xuICAgIGF3YWl0IHN0YXJ0KHRydWUpO1xuICAgIHJldHVybjtcbiAgfVxuICBhd2FpdCBzdGFydCgpO1xufVxuXG5mdW5jdGlvbiBoYW5nVXAoKSB7XG4gIGlmIChjYWxsSWQpIHB1c2goeyB0eXBlOiBcInN0b3BcIiwgbWVzc2FnZTogXCJZb3UgaHVuZyB1cC5cIiB9KTtcbn1cblxuZnVuY3Rpb24gZW5kKCkge1xuICB3aW5kb3cuY2xlYXJJbnRlcnZhbCh0aWNrZXIpO1xuICB3aW5kb3cuY2xlYXJJbnRlcnZhbCh0cmFjZVRpbWVyKTtcbiAgc3RvcFdvcmRzLnN0b3AoKTtcbiAgY29yZVdhbnRzV2FrZSA9IGZhbHNlO1xuICB3YWtlU3RhcnRpbmcgPSBmYWxzZTtcbiAgb3BlbmluZ0NodW5rcyA9IFtdO1xuICBvcGVuaW5nQnl0ZXMgPSAwO1xuICBjb25zdCBmaW5pc2hlZElkID0gY2FsbElkO1xuICBjb25zdCBmaW5pc2hlZENvcmUgPSBjb3JlO1xuICBjYWxsSWQgPSAwO1xuICBlbmRpbmcgPSBzYXZlVHJhY2UoZmluaXNoZWRJZCwgZmluaXNoZWRDb3JlKS50aGVuKCgpID0+IHsgaWYgKGZpbmlzaGVkQ29yZSAmJiBmaW5pc2hlZElkKSBmaW5pc2hlZENvcmUuZGlzcG9zZShmaW5pc2hlZElkKTsgc2hvd1Rhc2tzKCk7IHN5bmNXYWtlVWkoKTsgfSk7XG4gIGlmICh3YWtlQXJtZWQpIHtcbiAgICBhdWRpby5zdG9wUGxheWJhY2soKTtcbiAgICB3YWtlQ2xpZW50LnJlc2V0KCk7XG4gICAgdm9pZCBhdWRpby5lbnN1cmVNaWMob25NaWMsIG1pY09wdGlvbnMoKSkuY2F0Y2goKGVycikgPT4ge1xuICAgICAgbG9nKFwiZXJyb3JcIiwgYHdha2UgbWljcm9waG9uZTogJHtlcnIubWVzc2FnZX1gLCBcImVyclwiKTtcbiAgICAgIHRvYXN0KGBXYWtlIG1pY3JvcGhvbmU6ICR7ZXJyLm1lc3NhZ2V9YCk7XG4gICAgICB2b2lkIGFybVdha2UoZmFsc2UpO1xuICAgIH0pO1xuICB9IGVsc2Uge1xuICAgIGF1ZGlvLnN0b3AoKTtcbiAgICByZWxlYXNlV2FrZUxvY2soKTtcbiAgfVxuICBmb3IgKGNvbnN0IHdzIG9mIHNvY2tldHMudmFsdWVzKCkpIHdzLmNsb3NlKCk7XG4gIHNvY2tldHMuY2xlYXIoKTtcbiAgZm9yIChjb25zdCByIG9mIHJ1bnMudmFsdWVzKCkpIHIuYWJvcnQuYWJvcnQoKTtcbiAgcnVucy5jbGVhcigpO1xuICBmb3IgKGNvbnN0IHIgb2YgcmVxdWVzdHMudmFsdWVzKCkpIHIuYWJvcnQoKTtcbiAgcmVxdWVzdHMuY2xlYXIoKTtcbiAgdGhpbmtpbmcgPSBmYWxzZTtcbiAgc2V0Q2FsbEJ1dHRvbihmYWxzZSk7XG4gIGZvciAoY29uc3QgaWQgb2YgW1wibWljXCIsIFwiaHVzaFwiXSkgJDxIVE1MQnV0dG9uRWxlbWVudD4oaWQpLmRpc2FibGVkID0gdHJ1ZTtcbiAgJChcInJpbmdcIikuc3R5bGUub3BhY2l0eSA9IFwiMFwiO1xuICAkKFwicmluZ1wiKS5zdHlsZS50cmFuc2Zvcm0gPSBcIlwiO1xuICAkKFwiY2FsbGJhclwiKS5oaWRkZW4gPSB0cnVlO1xuICAkKFwibWljd2FyblwiKS5oaWRkZW4gPSB0cnVlO1xuICBkb2N1bWVudC5ib2R5LmRhdGFzZXQuc3RhdGUgPSB3YWtlQXJtZWQgPyBcImFybWVkXCIgOiBcImlkbGVcIjtcbiAgZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QucmVtb3ZlKFwiaW4tc2Vzc2lvblwiKTtcbiAgc3luY1Jlc3VtZUJ1dHRvbnMoY2hhdC5sZW5ndGggPiAwKTtcbiAgdm9pZCBzaG93RWFybGllcigpO1xuICBzeW5jV2FrZVVpKCk7XG59XG5cbmZ1bmN0aW9uIHNldE11dGVkKHZhbHVlOiBib29sZWFuKSB7XG4gIGlmICghY2FsbElkIHx8IG11dGVkID09PSB2YWx1ZSkgcmV0dXJuO1xuICBtdXRlZCA9IHZhbHVlO1xuICAkKFwibWljXCIpLmNsYXNzTGlzdC50b2dnbGUoXCJtdXRlZFwiLCBtdXRlZCk7XG4gIHB1c2goeyB0eXBlOiBtdXRlZCA/IFwibXV0ZVwiIDogXCJ1bm11dGVcIiB9KTtcbiAgc2hvd1N0YXR1cygpO1xufVxuXG4vKiogU2VuZHMgd2hhdCB0aGUgdHJhY2Uga2VwdCBzaW5jZSBsYXN0IHRpbWUgdG8gdGhlIGRldiBzZXJ2ZXIsIGFzIEpTT04gbGluZXM6IGEgaGVhZGVyLCB0aGVuIGV2ZW50cy4gKi9cbmFzeW5jIGZ1bmN0aW9uIHNhdmVUcmFjZShpZCA9IGNhbGxJZCwgdGFyZ2V0Q29yZSA9IGNvcmUpIHtcbiAgaWYgKCF0YXJnZXRDb3JlIHx8ICFpZCB8fCAhY2hlY2tlZChcInRyYWNlXCIpKSByZXR1cm47XG4gIGNvbnN0IGtlcHQgPSBKU09OLnBhcnNlKHRhcmdldENvcmUudHJhY2UoaWQpKTtcbiAgaWYgKCFrZXB0KSByZXR1cm47XG4gIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICBpZiAoa2VwdC5jb25maWcpIGxpbmVzLnB1c2goSlNPTi5zdHJpbmdpZnkoeyB2ZXJzaW9uOiBrZXB0LnZlcnNpb24sIGNvbmZpZzoga2VwdC5jb25maWcsIHN0YXJ0OiBrZXB0LnN0YXJ0IH0pKTtcbiAgZm9yIChjb25zdCBlIG9mIGtlcHQuZXZlbnRzKSBsaW5lcy5wdXNoKEpTT04uc3RyaW5naWZ5KGUpKTtcbiAgaWYgKGxpbmVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuICBhd2FpdCBmZXRjaChgL3RyYWNlcz9uYW1lPSR7ZW5jb2RlVVJJQ29tcG9uZW50KGNhbGxOYW1lKX0uanNvbmxgLCB7IG1ldGhvZDogXCJQT1NUXCIsIGJvZHk6IGxpbmVzLmpvaW4oXCJcXG5cIikgKyBcIlxcblwiIH0pLmNhdGNoKCgpID0+IHt9KTtcbiAgJChcInRyYWNlbmFtZVwiKS50ZXh0Q29udGVudCA9IGB0cmFjZSAke2NhbGxOYW1lfS5qc29ubGA7XG59XG5cbi8vIFwiU3RvcFwiIGFuZCBcImdvb2RieWVcIiBoZWFyZCBieSB0aGUgYnJvd3NlcidzIG93biByZWNvZ25pemVyOiBxdWlja2VyIHRoYW4gdGhlIG1vZGVsJ3MgdHJhbnNjcmlwdCxcbi8vIGFuZCBpdCB3b3JrcyB3aGlsZSB0aGUgbW9kZWwncyByZXBseSBwbGF5cyBldmVuIHdoZW4gdGhlIG1vZGVsIGlzbid0IGhlYXJpbmcgdGhlIG1pY3JvcGhvbmUuXG5cbmNsYXNzIFN0b3BXb3JkcyB7XG4gIHByaXZhdGUgcmVjOiBhbnkgPSBudWxsO1xuICBwcml2YXRlIG9uID0gZmFsc2U7XG4gIHByaXZhdGUgY29tbWFuZHMgPSB7IHN0b3A6IFtdIGFzIHN0cmluZ1tdLCBoYW5nVXA6IFtdIGFzIHN0cmluZ1tdLCBjYW5jZWxBbGw6IFtdIGFzIHN0cmluZ1tdIH07XG5cbiAgZ2V0IHN1cHBvcnRlZCgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gXCJ3ZWJraXRTcGVlY2hSZWNvZ25pdGlvblwiIGluIHdpbmRvdyB8fCBcIlNwZWVjaFJlY29nbml0aW9uXCIgaW4gd2luZG93O1xuICB9XG5cbiAgc3RhcnQoKSB7XG4gICAgaWYgKCFjaGVja2VkKFwic3RvcHdvcmRcIikgfHwgIXRoaXMuc3VwcG9ydGVkIHx8ICFjb3JlKSByZXR1cm47XG4gICAgdGhpcy5jb21tYW5kcyA9IEpTT04ucGFyc2UoY29yZS5kZWZhdWx0cygpKS52b2ljZUNvbW1hbmRzO1xuICAgIGNvbnN0IFJlY29nbml0aW9uID0gKHdpbmRvdyBhcyBhbnkpLlNwZWVjaFJlY29nbml0aW9uID8/ICh3aW5kb3cgYXMgYW55KS53ZWJraXRTcGVlY2hSZWNvZ25pdGlvbjtcbiAgICB0aGlzLnJlYyA9IG5ldyBSZWNvZ25pdGlvbigpO1xuICAgIHRoaXMucmVjLmNvbnRpbnVvdXMgPSB0cnVlO1xuICAgIHRoaXMucmVjLmludGVyaW1SZXN1bHRzID0gdHJ1ZTtcbiAgICB0aGlzLnJlYy5sYW5nID0gbmF2aWdhdG9yLmxhbmd1YWdlIHx8IFwiZW4tR0JcIjtcbiAgICB0aGlzLnJlYy5vbnJlc3VsdCA9IChlOiBhbnkpID0+IHtcbiAgICAgIGZvciAobGV0IGkgPSBlLnJlc3VsdEluZGV4OyBpIDwgZS5yZXN1bHRzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIGNvbnN0IHRleHQgPSBlLnJlc3VsdHNbaV1bMF0udHJhbnNjcmlwdCBhcyBzdHJpbmc7XG4gICAgICAgIGNvbnN0IGNvbW1hbmQgPSBjb21tYW5kSW4odGV4dCwgdGhpcy5jb21tYW5kcywgW1wiV29vZGhvdXNlXCIsIFwiSGVybWVzXCIsIFwiQmVudG9cIl0pO1xuICAgICAgICBpZiAoY29tbWFuZCA9PT0gXCJzdG9wXCIgJiYgYXVkaW8ucXVldWVkID4gMC4wNSkge1xuICAgICAgICAgIGxvZyhcIm91dFwiLCBgbG9jYWwgc3RvcCB3b3JkOiAke3RleHR9YCwgXCJvdXRcIik7XG4gICAgICAgICAgdG9hc3QoYEhlYXJkIFx1MjAxQyR7dGV4dC50cmltKCl9XHUyMDFEOiBzdG9wcGVkYCk7XG4gICAgICAgICAgcHVzaCh7IHR5cGU6IFwiaW50ZXJydXB0XCIgfSk7XG4gICAgICAgIH0gZWxzZSBpZiAoY29tbWFuZCA9PT0gXCJjYW5jZWxBbGxcIiAmJiBlLnJlc3VsdHNbaV0uaXNGaW5hbCkge1xuICAgICAgICAgIGxvZyhcIm91dFwiLCBgbG9jYWwgY2FuY2VsLWFsbDogJHt0ZXh0fWAsIFwib3V0XCIpO1xuICAgICAgICAgIHB1c2goeyB0eXBlOiBcImNhbmNlbEFsbFwiIH0pO1xuICAgICAgICAgIHB1c2goeyB0eXBlOiBcImludGVycnVwdFwiIH0pO1xuICAgICAgICB9IGVsc2UgaWYgKGNvbW1hbmQgPT09IFwiaGFuZ1VwXCIgJiYgZS5yZXN1bHRzW2ldLmlzRmluYWwpIHtcbiAgICAgICAgICBsb2coXCJvdXRcIiwgYGxvY2FsIGhhbmctdXA6ICR7dGV4dH1gLCBcIm91dFwiKTtcbiAgICAgICAgICBoYW5nVXAoKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH07XG4gICAgdGhpcy5yZWMub25lbmQgPSAoKSA9PiB7IGlmICh0aGlzLm9uKSBzZXRUaW1lb3V0KCgpID0+IHsgdHJ5IHsgdGhpcy5yZWM/LnN0YXJ0KCk7IH0gY2F0Y2gge30gfSwgMjUwKTsgfTtcbiAgICB0aGlzLnJlYy5vbmVycm9yID0gKGU6IGFueSkgPT4geyBpZiAoZS5lcnJvciA9PT0gXCJub3QtYWxsb3dlZFwiKSB0aGlzLm9uID0gZmFsc2U7IH07XG4gICAgdGhpcy5vbiA9IHRydWU7XG4gICAgdHJ5IHsgdGhpcy5yZWMuc3RhcnQoKTsgfSBjYXRjaCB7fVxuICB9XG5cbiAgc3RvcCgpIHtcbiAgICB0aGlzLm9uID0gZmFsc2U7XG4gICAgdHJ5IHsgdGhpcy5yZWM/LnN0b3AoKTsgfSBjYXRjaCB7fVxuICAgIHRoaXMucmVjID0gbnVsbDtcbiAgfVxufVxuY29uc3Qgc3RvcFdvcmRzID0gbmV3IFN0b3BXb3JkcygpO1xuXG4vLyBMb2NhbCB3YWtlIHdvcmQgbG9vcCAoTGl2ZUtpdCBXYWtlV29yZCBPTk5YIGluIGEgV2ViIFdvcmtlcik6IGxpc3RlbnMgYmV0d2VlbiBjYWxscyB3aGVuIGFybWVkLFxuLy8gYW5kIGluc2lkZSBhbiBhY3RpdmUgY2FsbCB3aGVuZXZlciB0aGUgY29yZSBhc2tzIChgd2FrZXdvcmQ6IG9uYDogZG9ybWFudCBvciB3aGlsZVNwZWFraW5nIFwid2FrZVwiKS5cblxuYXN5bmMgZnVuY3Rpb24gYWNxdWlyZVdha2VMb2NrKCkge1xuICBpZiAod2FrZUxvY2sgfHwgZG9jdW1lbnQuaGlkZGVuKSByZXR1cm47XG4gIHRyeSB7IHdha2VMb2NrID0gYXdhaXQgKG5hdmlnYXRvciBhcyBhbnkpLndha2VMb2NrPy5yZXF1ZXN0KFwic2NyZWVuXCIpOyB9IGNhdGNoIHt9XG59XG5cbmZ1bmN0aW9uIHJlbGVhc2VXYWtlTG9jaygpIHtcbiAgdm9pZCB3YWtlTG9jaz8ucmVsZWFzZSgpLmNhdGNoKCgpID0+IHt9KTtcbiAgd2FrZUxvY2sgPSBudWxsO1xufVxuXG5mdW5jdGlvbiBzZWxlY3RlZFdha2VNb2RlbCgpOiBXYWtlTW9kZWxJbmZvIHwgbnVsbCB7XG4gIGNvbnN0IG1vZGVscyA9IHNlcnZlcj8ud2FrZU1vZGVscyA/PyBbXTtcbiAgaWYgKG1vZGVscy5sZW5ndGggPT09IDApIHJldHVybiBudWxsO1xuICBjb25zdCBwaWNrID0gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJ3YWtlLW1vZGVsXCIpLnZhbHVlO1xuICByZXR1cm4gbW9kZWxzLmZpbmQoKG0pID0+IG0uaWQgPT09IHBpY2spID8/IG1vZGVscy5maW5kKChtKSA9PiBtLmlkID09PSBcInBlbm55d29ydGhcIikgPz8gbW9kZWxzWzBdO1xufVxuXG5mdW5jdGlvbiB3YWtlVGhyZXNob2xkKCk6IG51bWJlciB7XG4gIGNvbnN0IG4gPSBOdW1iZXIoJDxIVE1MSW5wdXRFbGVtZW50PihcIndha2UtdGhyZXNob2xkXCIpLnZhbHVlKTtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShuKSA/IE1hdGgubWF4KDAuMSwgTWF0aC5taW4oMC45OSwgbikpIDogMC43O1xufVxuXG5mdW5jdGlvbiBzaG91bGRGZWVkV2FrZSgpOiBib29sZWFuIHtcbiAgaWYgKHdha2VTdGFydGluZykgcmV0dXJuIGZhbHNlO1xuICBpZiAoY2FsbElkID09PSAwKSByZXR1cm4gd2FrZUFybWVkO1xuICByZXR1cm4gbWVkaXVtID09PSBcInZvaWNlXCIgJiYgY29yZVdhbnRzV2FrZSAmJiAhKG11dGVkICYmICFob2xkaW5nKTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyV2FrZVRlbGVtZXRyeSgpIHtcbiAgY29uc3QgYWN0aXZlID0gKGNhbGxJZCA9PT0gMCAmJiB3YWtlQXJtZWQpIHx8IChjYWxsSWQgIT09IDAgJiYgbWVkaXVtID09PSBcInZvaWNlXCIgJiYgY29yZVdhbnRzV2FrZSk7XG4gIGlmICghYWN0aXZlKSB7ICQoXCJoZWFyZFwiKS50ZXh0Q29udGVudCA9IFwiXCI7IHJldHVybjsgfVxuICBjb25zdCBsYWJlbCA9IHNlbGVjdGVkV2FrZU1vZGVsKCk/LmxhYmVsID8/IFwid2FrZSB3b3JkXCI7XG4gIGlmICh3YWtlTG9hZGluZykgeyAkKFwiaGVhcmRcIikudGV4dENvbnRlbnQgPSBgTG9hZGluZyB3YWtlIHdvcmQgXHUyMDFDJHtsYWJlbH1cdTIwMURcdTIwMjZgOyByZXR1cm47IH1cbiAgaWYgKCF3YWtlTGFzdFRlbCkgeyAkKFwiaGVhcmRcIikudGV4dENvbnRlbnQgPSBgV2FrZSBcdTIwMUMke2xhYmVsfVx1MjAxRCByZWFkeSAodGhyZXNob2xkICR7d2FrZVRocmVzaG9sZCgpLnRvRml4ZWQoMil9KWA7IHJldHVybjsgfVxuICBjb25zdCBzdGF0ZSA9IHdha2VMYXN0VGVsLmdhdGVPcGVuID8gYHNjb3JpbmcgJHt3YWtlTGFzdFRlbC5zY29yZS50b0ZpeGVkKDIpfWAgOiBcInF1aWV0XCI7XG4gIGNvbnN0IHNwZWVkID0gd2FrZUxhc3RUZWwuaW5mZXJNcyA+IDAgPyBgIFx1MDBCNyAke3dha2VMYXN0VGVsLmluZmVyTXMudG9GaXhlZCgxKX0gbXNgIDogXCJcIjtcbiAgJChcImhlYXJkXCIpLnRleHRDb250ZW50ID0gYFdha2UgXHUyMDFDJHtsYWJlbH1cdTIwMUQgXHUwMEI3ICR7c3RhdGV9IFx1MDBCNyBwZWFrICR7d2FrZUxhc3RUZWwucGVhay50b0ZpeGVkKDIpfSR7c3BlZWR9YDtcbn1cblxuZnVuY3Rpb24gc3luY1dha2VVaSgpIHtcbiAgY29uc3QgbW9kZWwgPSBzZWxlY3RlZFdha2VNb2RlbCgpO1xuICBjb25zdCBoYXNNb2RlbHMgPSBtb2RlbCAhPSBudWxsO1xuICBjb25zdCBsYWJlbCA9IG1vZGVsPy5sYWJlbCA/PyBcIndha2Ugd29yZFwiO1xuICBjb25zdCBidG4gPSAkPEhUTUxCdXR0b25FbGVtZW50PihcIndha2VidG5cIik7XG4gIGJ0bi5oaWRkZW4gPSAhaGFzTW9kZWxzO1xuICBidG4uY2xhc3NMaXN0LnRvZ2dsZShcIm9uXCIsIHdha2VBcm1lZCk7XG4gIGJ0bi5jbGFzc0xpc3QudG9nZ2xlKFwibG9hZGluZ1wiLCB3YWtlTG9hZGluZyAmJiAod2FrZUFybWVkIHx8IGNvcmVXYW50c1dha2UpKTtcbiAgYnRuLnNldEF0dHJpYnV0ZShcImFyaWEtcHJlc3NlZFwiLCBTdHJpbmcod2FrZUFybWVkKSk7XG4gIGJ0bi50aXRsZSA9IHdha2VBcm1lZCA/IGBTdG9wIHdha2Ugd29yZCBcdTIwMUMke2xhYmVsfVx1MjAxRCAoVylgIDogYExpc3RlbiBmb3IgXHUyMDFDJHtsYWJlbH1cdTIwMUQgKFcpYDtcbiAgY29uc3QgaGVybyA9ICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiaGVyby13YWtlXCIpO1xuICBoZXJvLmhpZGRlbiA9ICFoYXNNb2RlbHM7XG4gIGhlcm8uY2xhc3NMaXN0LnRvZ2dsZShcIm9uXCIsIHdha2VBcm1lZCk7XG4gIGhlcm8udGV4dENvbnRlbnQgPSB3YWtlQXJtZWRcbiAgICA/ICh3YWtlTG9hZGluZyA/IGBMb2FkaW5nIFx1MjAxQyR7bGFiZWx9XHUyMDFEXHUyMDI2YCA6IGBMaXN0ZW5pbmcgZm9yIFx1MjAxQyR7bGFiZWx9XHUyMDFEYClcbiAgICA6IGBMaXN0ZW4gZm9yIFx1MjAxQyR7bGFiZWx9XHUyMDFEYDtcbiAgJDxIVE1MSW5wdXRFbGVtZW50PihcIndha2UtZW5hYmxlZFwiKS5jaGVja2VkID0gd2FrZUFybWVkO1xuICByZW5kZXJXYWtlVGVsZW1ldHJ5KCk7XG4gIHNob3dTdGF0dXMoKTtcbn1cblxuZnVuY3Rpb24gc3luY1NpZ25hbGluZ1VpKCkge1xuICBjb25zdCBzaWduYWxpbmcgPSAkPEhUTUxTZWxlY3RFbGVtZW50PihcInNpZ25hbGluZ1wiKS52YWx1ZTtcbiAgY29uc3QgY3VzdG9tSnNvbiA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UtY29yZS5jb25maWdcIikgIT0gbnVsbDtcbiAgY29uc3QgaXNXZWIgPSAkPEhUTUxTZWxlY3RFbGVtZW50PihcInByZXNldFwiKS52YWx1ZSA9PT0gXCJ3ZWJcIjtcbiAgY29uc3Qgd2luZG93Q29udHJvbHMgPSBzaWduYWxpbmcgPT09IFwid2luZG93XCIgfHwgc2lnbmFsaW5nID09PSBcImVjaG9cIjtcbiAgZm9yIChjb25zdCBpZCBvZiBbXCJhdHRuLWFmdGVyLXdha2VcIiwgXCJhdHRuLXdpbmRvd1wiLCBcImF0dG4tYWZ0ZXItcXVlc3Rpb25cIl0pIHtcbiAgICAkPEhUTUxJbnB1dEVsZW1lbnQ+KGlkKS5kaXNhYmxlZCA9ICF3aW5kb3dDb250cm9scztcbiAgfVxuICBjb25zdCBiYXJnZSA9ICQ8SFRNTElucHV0RWxlbWVudD4oXCJ3YWtlLWJhcmdlXCIpO1xuICBpZiAoc2lnbmFsaW5nID09PSBcImVjaG9cIiAmJiAhY3VzdG9tSnNvbiAmJiBpc1dlYikge1xuICAgIGJhcmdlLmNoZWNrZWQgPSB0cnVlO1xuICAgIGJhcmdlLmRpc2FibGVkID0gdHJ1ZTtcbiAgfSBlbHNlIHtcbiAgICBiYXJnZS5kaXNhYmxlZCA9IGZhbHNlO1xuICAgIGJhcmdlLmNoZWNrZWQgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLndha2UtYmFyZ2VcIikgPT09IFwiMVwiO1xuICB9XG59XG5cbmNvbnN0IHdha2VDbGllbnQgPSBuZXcgV2FrZUNsaWVudCh7XG4gIG9uUmVhZHkobW9kZWxJZCwgd2FybXVwTXMpIHtcbiAgICB3YWtlTG9hZGluZyA9IGZhbHNlO1xuICAgIGxvZyhcIm91dFwiLCBgd2FrZSB3b3JkIHJlYWR5OiAke21vZGVsSWR9JHt3YXJtdXBNcyA+IDAgPyBgICgke3dhcm11cE1zfSBtcylgIDogXCJcIn1gLCBcIm91dFwiKTtcbiAgICBzeW5jV2FrZVVpKCk7XG4gIH0sXG4gIG9uRGV0ZWN0ZWQoaGl0KSB7XG4gICAgb25XYWtlRGV0ZWN0ZWQoaGl0KTtcbiAgfSxcbiAgb25UZWxlbWV0cnkodGVsKSB7XG4gICAgd2FrZUxhc3RUZWwgPSB0ZWw7XG4gICAgcmVuZGVyV2FrZVRlbGVtZXRyeSgpO1xuICB9LFxuICBvbkVycm9yKG1lc3NhZ2UpIHtcbiAgICB3YWtlTG9hZGluZyA9IGZhbHNlO1xuICAgIGxvZyhcImVycm9yXCIsIGB3YWtlIHdvcmQ6ICR7bWVzc2FnZX1gLCBcImVyclwiKTtcbiAgICB0b2FzdChgV2FrZSB3b3JkIGVycm9yOiAke21lc3NhZ2V9YCk7XG4gICAgaWYgKHdha2VBcm1lZCkgdm9pZCBhcm1XYWtlKGZhbHNlKTtcbiAgICBlbHNlIHN5bmNXYWtlVWkoKTtcbiAgfSxcbn0pO1xuXG5hc3luYyBmdW5jdGlvbiBhcm1XYWtlKG9uOiBib29sZWFuLCBwZXJzaXN0ID0gdHJ1ZSkge1xuICBjb25zdCBtb2RlbCA9IHNlbGVjdGVkV2FrZU1vZGVsKCk7XG4gIGlmIChvbiAmJiAhbW9kZWwpIHtcbiAgICB0b2FzdChcIk5vIHdha2Ugd29yZCBtb2RlbHMgZm91bmQgb24gdGhlIHNlcnZlclwiKTtcbiAgICAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwid2FrZS1lbmFibGVkXCIpLmNoZWNrZWQgPSBmYWxzZTtcbiAgICByZXR1cm47XG4gIH1cbiAgd2FrZUFybWVkID0gb247XG4gIGlmIChwZXJzaXN0KSBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLndha2UtZW5hYmxlZFwiLCBvbiA/IFwiMVwiIDogXCIwXCIpO1xuICBpZiAob24gJiYgbW9kZWwpIHtcbiAgICB3YWtlTGFzdFRlbCA9IG51bGw7XG4gICAgaWYgKCF3YWtlQ2xpZW50LnJlYWR5IHx8IHdha2VDbGllbnQubW9kZWxJZCAhPT0gbW9kZWwuaWQpIHdha2VMb2FkaW5nID0gdHJ1ZTtcbiAgICB3YWtlQ2xpZW50LmxvYWQobW9kZWwuaWQsIHdha2VUaHJlc2hvbGQoKSk7XG4gICAgaWYgKCFjYWxsSWQpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IGF1ZGlvLmVuc3VyZU1pYyhvbk1pYywgbWljT3B0aW9ucygpKTtcbiAgICAgICAgd2FrZUNsaWVudC5yZXNldCgpO1xuICAgICAgICBhd2FpdCBhY3F1aXJlV2FrZUxvY2soKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICB3YWtlQXJtZWQgPSBmYWxzZTtcbiAgICAgICAgd2FrZUxvYWRpbmcgPSBmYWxzZTtcbiAgICAgICAgaWYgKHBlcnNpc3QpIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2Uud2FrZS1lbmFibGVkXCIsIFwiMFwiKTtcbiAgICAgICAgdG9hc3QoYE1pY3JvcGhvbmU6ICR7KGVyciBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICAgICAgbG9nKFwiZXJyb3JcIiwgYHdha2UgbWljcm9waG9uZTogJHsoZXJyIGFzIEVycm9yKS5tZXNzYWdlfWAsIFwiZXJyXCIpO1xuICAgICAgfVxuICAgIH1cbiAgfSBlbHNlIHtcbiAgICB3YWtlTG9hZGluZyA9IGZhbHNlO1xuICAgIHdha2VMYXN0VGVsID0gbnVsbDtcbiAgICBpZiAoIWNhbGxJZCkge1xuICAgICAgYXVkaW8uc3RvcE1pYygpO1xuICAgICAgcmVsZWFzZVdha2VMb2NrKCk7XG4gICAgICB3YWtlQ2xpZW50LnJlc2V0KCk7XG4gICAgfVxuICB9XG4gIHN5bmNXYWtlVWkoKTtcbn1cblxuZnVuY3Rpb24gZW5zdXJlQ29yZVdha2Uob246IGJvb2xlYW4pIHtcbiAgY29yZVdhbnRzV2FrZSA9IG9uO1xuICBjb25zdCBtb2RlbCA9IHNlbGVjdGVkV2FrZU1vZGVsKCk7XG4gIGlmIChvbikge1xuICAgIGlmICghbW9kZWwpIHtcbiAgICAgIGxvZyhcIndhcm5cIiwgXCJjb3JlIGFza2VkIGZvciB3YWtlIHdvcmQsIGJ1dCBubyBtb2RlbHMgYXJlIGF2YWlsYWJsZVwiLCBcIndhcm5cIik7XG4gICAgfSBlbHNlIHtcbiAgICAgIHdha2VMYXN0VGVsID0gbnVsbDtcbiAgICAgIGlmICghd2FrZUNsaWVudC5yZWFkeSB8fCB3YWtlQ2xpZW50Lm1vZGVsSWQgIT09IG1vZGVsLmlkKSB3YWtlTG9hZGluZyA9IHRydWU7XG4gICAgICB3YWtlQ2xpZW50LmxvYWQobW9kZWwuaWQsIHdha2VUaHJlc2hvbGQoKSk7XG4gICAgICB3YWtlQ2xpZW50LnJlc2V0KCk7XG4gICAgICBsb2coXCJvdXRcIiwgYHdha2Ugd29yZCBsaXN0ZW5pbmcgKCR7bW9kZWwubGFiZWx9KWAsIFwib3V0XCIpO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICBpZiAoIXdha2VBcm1lZCkgd2FrZUxhc3RUZWwgPSBudWxsO1xuICAgIGxvZyhcIm91dFwiLCBcIndha2Ugd29yZCBvZmZcIiwgXCJvdXRcIik7XG4gIH1cbiAgc3luY1dha2VVaSgpO1xufVxuXG5mdW5jdGlvbiBvbldha2VEZXRlY3RlZChoaXQ6IFdha2VEZXRlY3Rpb25FdmVudCkge1xuICBpZiAoIXNob3VsZEZlZWRXYWtlKCkpIHJldHVybjtcbiAgY29uc3QgbGFiZWwgPSBzZWxlY3RlZFdha2VNb2RlbCgpPy5sYWJlbCA/PyBcIndha2Ugd29yZFwiO1xuICBsb2coXCJvdXRcIiwgYHdha2UgZGV0ZWN0ZWQgXHUyMDFDJHtsYWJlbH1cdTIwMUQgKHNjb3JlICR7aGl0LnNjb3JlLnRvRml4ZWQoMil9LCAke2hpdC5pbmZlck1zLnRvRml4ZWQoMSl9IG1zKWAsIFwib3V0XCIpO1xuICBpZiAoY2hlY2tlZChcIndha2UtY3VlXCIpKSB2b2lkIGF1ZGlvLm9wZW4oKS50aGVuKCgpID0+IGF1ZGlvLmN1ZShXQUtFX1RPTkUpKS5jYXRjaCgoKSA9PiB7fSk7XG4gIHRvYXN0KGBIZWFyZCBcdTIwMUMke2xhYmVsfVx1MjAxRCAoJHtoaXQuc2NvcmUudG9GaXhlZCgyKX0pYCk7XG4gIGlmIChjYWxsSWQgIT09IDApIHtcbiAgICBwdXNoKHsgdHlwZTogXCJ3YWtlXCIgfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIHdha2VTdGFydGluZyA9IHRydWU7XG4gIG9wZW5pbmdDaHVua3MgPSBbXTtcbiAgb3BlbmluZ0J5dGVzID0gMDtcbiAgaWYgKGhpdC5yZXN0LmJ5dGVMZW5ndGggPiAwKSB7XG4gICAgb3BlbmluZ0NodW5rcy5wdXNoKGhpdC5yZXN0KTtcbiAgICBvcGVuaW5nQnl0ZXMgPSBoaXQucmVzdC5ieXRlTGVuZ3RoO1xuICB9XG4gIHZvaWQgc3RhcnQoY2hhdC5sZW5ndGggPiAwKS50aGVuKCgpID0+IHtcbiAgICBpZiAoIWNhbGxJZCAmJiB3YWtlU3RhcnRpbmcpIHtcbiAgICAgIHdha2VTdGFydGluZyA9IGZhbHNlO1xuICAgICAgb3BlbmluZ0NodW5rcyA9IFtdO1xuICAgICAgb3BlbmluZ0J5dGVzID0gMDtcbiAgICAgIHN5bmNXYWtlVWkoKTtcbiAgICB9XG4gIH0pLmNhdGNoKChlcnIpID0+IHtcbiAgICB3YWtlU3RhcnRpbmcgPSBmYWxzZTtcbiAgICBvcGVuaW5nQ2h1bmtzID0gW107XG4gICAgb3BlbmluZ0J5dGVzID0gMDtcbiAgICB0b2FzdCgoZXJyIGFzIEVycm9yKS5tZXNzYWdlKTtcbiAgICBsb2coXCJlcnJvclwiLCAoZXJyIGFzIEVycm9yKS5tZXNzYWdlLCBcImVyclwiKTtcbiAgICBzeW5jV2FrZVVpKCk7XG4gIH0pO1xufVxuXG4vLyBXaXJpbmcuXG5cbmZ1bmN0aW9uIHNldHRpbmdzRnJvbVN0b3JhZ2UoKSB7XG4gIGZvciAoY29uc3QgaWQgb2YgW1wiYWVjXCIsIFwic3RvcHdvcmRcIiwgXCJwdHRcIiwgXCJjYXB0aW9uc1wiLCBcImNvZGluZ1wiLCBcImZha2VoZXJtZXNcIiwgXCJ0cmFjZVwiLCBcIndha2UtY3VlXCIsIFwid2FrZS1iYXJnZVwiXSkge1xuICAgIGNvbnN0IHYgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShgdm9pY2UuJHtpZH1gKTtcbiAgICBpZiAodiAhPSBudWxsKSAkPEhUTUxJbnB1dEVsZW1lbnQ+KGlkKS5jaGVja2VkID0gdiA9PT0gXCIxXCI7XG4gICAgJChpZCkuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiB7XG4gICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShgdm9pY2UuJHtpZH1gLCBjaGVja2VkKGlkKSA/IFwiMVwiIDogXCIwXCIpO1xuICAgICAgaWYgKGlkID09PSBcImFlY1wiICYmIHdha2VBcm1lZCAmJiAhY2FsbElkKSB7XG4gICAgICAgIHZvaWQgYXVkaW8uc3RhcnRNaWMob25NaWMsIG1pY09wdGlvbnMoKSkuY2F0Y2goKGVycikgPT4gdG9hc3QoYE1pY3JvcGhvbmU6ICR7ZXJyLm1lc3NhZ2V9YCkpO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG4gIGZvciAoY29uc3QgW2lkLCBrZXldIG9mIFtcbiAgICBbXCJmYWtlZGVsYXlcIiwgXCJ2b2ljZS5mYWtlZGVsYXlcIl0sXG4gICAgW1wiYXR0bi1hZnRlci13YWtlXCIsIFwidm9pY2UuYXR0bi1hZnRlci13YWtlXCJdLFxuICAgIFtcImF0dG4td2luZG93XCIsIFwidm9pY2UuYXR0bi13aW5kb3dcIl0sXG4gICAgW1wiYXR0bi1hZnRlci1xdWVzdGlvblwiLCBcInZvaWNlLmF0dG4tYWZ0ZXItcXVlc3Rpb25cIl0sXG4gICAgW1wiaGFuZ3VwLWFmdGVyXCIsIFwidm9pY2UuaGFuZ3VwLWFmdGVyXCJdLFxuICBdIGFzIGNvbnN0KSB7XG4gICAgY29uc3Qgc2F2ZWQgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShrZXkpO1xuICAgIGlmIChzYXZlZCAhPSBudWxsKSAkPEhUTUxJbnB1dEVsZW1lbnQ+KGlkKS52YWx1ZSA9IHNhdmVkO1xuICAgICQoaWQpLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4gbG9jYWxTdG9yYWdlLnNldEl0ZW0oa2V5LCAkPEhUTUxJbnB1dEVsZW1lbnQ+KGlkKS52YWx1ZSkpO1xuICB9XG4gIGNvbnN0IHRocmVzaCA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2Uud2FrZS10aHJlc2hvbGRcIik7XG4gIGlmICh0aHJlc2ggIT0gbnVsbCkgJDxIVE1MSW5wdXRFbGVtZW50PihcIndha2UtdGhyZXNob2xkXCIpLnZhbHVlID0gdGhyZXNoO1xuICAkKFwid2FrZS10aHJlc2hvbGQtdmFsXCIpLnRleHRDb250ZW50ID0gd2FrZVRocmVzaG9sZCgpLnRvRml4ZWQoMik7XG4gICQoXCJ3YWtlLXRocmVzaG9sZFwiKS5hZGRFdmVudExpc3RlbmVyKFwiaW5wdXRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHYgPSB3YWtlVGhyZXNob2xkKCk7XG4gICAgJChcIndha2UtdGhyZXNob2xkLXZhbFwiKS50ZXh0Q29udGVudCA9IHYudG9GaXhlZCgyKTtcbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLndha2UtdGhyZXNob2xkXCIsIHYudG9GaXhlZCgyKSk7XG4gICAgd2FrZUNsaWVudC5zZXRUaHJlc2hvbGQodik7XG4gICAgcmVuZGVyV2FrZVRlbGVtZXRyeSgpO1xuICB9KTtcbiAgY29uc3Qgc2lnbmFsaW5nID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS5zaWduYWxpbmdcIik7XG4gIGlmIChzaWduYWxpbmcpICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwic2lnbmFsaW5nXCIpLnZhbHVlID0gc2lnbmFsaW5nO1xuICAkKFwic2lnbmFsaW5nXCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4ge1xuICAgIGNvbnN0IG1vZGUgPSAkPEhUTUxTZWxlY3RFbGVtZW50PihcInNpZ25hbGluZ1wiKS52YWx1ZTtcbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLnNpZ25hbGluZ1wiLCBtb2RlKTtcbiAgICBjb25zdCBkZWYgPSBtb2RlID09PSBcImVjaG9cIiA/IFwiMTVcIiA6IFwiMzAwXCI7XG4gICAgJDxIVE1MSW5wdXRFbGVtZW50PihcImhhbmd1cC1hZnRlclwiKS52YWx1ZSA9IGRlZjtcbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLmhhbmd1cC1hZnRlclwiLCBkZWYpO1xuICAgIHN5bmNTaWduYWxpbmdVaSgpO1xuICB9KTtcbiAgJChcIndha2UtZW5hYmxlZFwiKS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHZvaWQgYXJtV2FrZShjaGVja2VkKFwid2FrZS1lbmFibGVkXCIpKSk7XG4gICQoXCJ3YWtlLW1vZGVsXCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGlkID0gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJ3YWtlLW1vZGVsXCIpLnZhbHVlO1xuICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2Uud2FrZS1tb2RlbFwiLCBpZCk7XG4gICAgaWYgKHdha2VBcm1lZCB8fCBjb3JlV2FudHNXYWtlKSB7XG4gICAgICB3YWtlTG9hZGluZyA9IHRydWU7XG4gICAgICB3YWtlTGFzdFRlbCA9IG51bGw7XG4gICAgICB3YWtlQ2xpZW50LmxvYWQoaWQsIHdha2VUaHJlc2hvbGQoKSk7XG4gICAgICBzeW5jV2FrZVVpKCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHN5bmNXYWtlVWkoKTtcbiAgICB9XG4gIH0pO1xuICBjb25zdCB2b2ljZSA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2Uudm9pY2VcIik7XG4gIGlmICh2b2ljZSkgJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJ2b2ljZVwiKS52YWx1ZSA9IHZvaWNlO1xuICAkKFwidm9pY2VcIikuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLnZvaWNlXCIsICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwidm9pY2VcIikudmFsdWUpKTtcbiAgY29uc3QgbW9kZSA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UubW9kZVwiKTtcbiAgaWYgKG1vZGUpICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwibW9kZVwiKS52YWx1ZSA9IG1vZGU7XG4gICQoXCJtb2RlXCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4ge1xuICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2UubW9kZVwiLCAkPEhUTUxTZWxlY3RFbGVtZW50PihcIm1vZGVcIikudmFsdWUpO1xuICAgIHN5bmNDb21wb3NlcigpO1xuICB9KTtcbiAgY29uc3QgdGhlbWUgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLnRoZW1lXCIpID8/IFwic3lzdGVtXCI7XG4gIGFwcGx5VGhlbWUodGhlbWUpO1xuICBmb3IgKGNvbnN0IGJ0biBvZiBBcnJheS5mcm9tKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiI3RoZW1lLXBpY2tlciBidXR0b25cIikpKSB7XG4gICAgYnRuLm9uY2xpY2sgPSAoKSA9PiB7XG4gICAgICBjb25zdCBjaG9pY2UgPSBidG4uZGF0YXNldC50aGVtZSA/PyBcInN5c3RlbVwiO1xuICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS50aGVtZVwiLCBjaG9pY2UpO1xuICAgICAgYXBwbHlUaGVtZShjaG9pY2UpO1xuICAgIH07XG4gIH1cbiAgbWF0Y2hNZWRpYShcIihwcmVmZXJzLWNvbG9yLXNjaGVtZTogZGFyaylcIikuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiB7XG4gICAgaWYgKChsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLnRoZW1lXCIpID8/IFwic3lzdGVtXCIpID09PSBcInN5c3RlbVwiKSBhcHBseVRoZW1lKFwic3lzdGVtXCIpO1xuICB9KTtcbiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcInZpc2liaWxpdHljaGFuZ2VcIiwgKCkgPT4ge1xuICAgIGlmICghZG9jdW1lbnQuaGlkZGVuICYmIChjYWxsSWQgfHwgd2FrZUFybWVkKSkgdm9pZCBhY3F1aXJlV2FrZUxvY2soKTtcbiAgfSk7XG4gIHN5bmNTaWduYWxpbmdVaSgpO1xufVxuXG5jb25zdCBtb2JpbGVMYXlvdXQgPSBtYXRjaE1lZGlhKFwiKG1heC13aWR0aDogOTIwcHgpXCIpO1xubGV0IGRyYXdlck9wZW5lcjogSFRNTEVsZW1lbnQgfCBudWxsID0gbnVsbDtcblxuZnVuY3Rpb24gc2V0VGFza3NPcGVuKG9wZW46IGJvb2xlYW4sIG9wZW5lcj86IEhUTUxFbGVtZW50IHwgbnVsbCkge1xuICBjb25zdCBjYW5PcGVuID0gbW9iaWxlTGF5b3V0Lm1hdGNoZXMgJiYgISQoXCJ0YWxrXCIpLmhpZGRlbjtcbiAgY29uc3QgbmV4dCA9IG9wZW4gJiYgY2FuT3BlbjtcbiAgY29uc3Qgd2FzT3BlbiA9IGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LmNvbnRhaW5zKFwidGFza3Mtb3BlblwiKTtcbiAgZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QudG9nZ2xlKFwidGFza3Mtb3BlblwiLCBuZXh0KTtcbiAgY29uc3QgaGVhZGVyID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihcImhlYWRlclwiKSBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gIGlmIChoZWFkZXIpIGhlYWRlci5pbmVydCA9IG5leHQ7XG4gICQoXCJjb252b1wiKS5pbmVydCA9IG5leHQ7XG4gICQoXCJzaWRlXCIpLmluZXJ0ID0gbW9iaWxlTGF5b3V0Lm1hdGNoZXMgJiYgIW5leHQ7XG4gICQoXCJ0YXNrcy10b2dnbGVcIikuc2V0QXR0cmlidXRlKFwiYXJpYS1leHBhbmRlZFwiLCBTdHJpbmcobmV4dCkpO1xuICAkKFwibW9iaWxlLXRhc2tzLWJhclwiKS5zZXRBdHRyaWJ1dGUoXCJhcmlhLWV4cGFuZGVkXCIsIFN0cmluZyhuZXh0KSk7XG4gIGlmIChuZXh0ICYmICF3YXNPcGVuKSB7XG4gICAgZHJhd2VyT3BlbmVyID0gb3BlbmVyID8/IChkb2N1bWVudC5hY3RpdmVFbGVtZW50IGFzIEhUTUxFbGVtZW50IHwgbnVsbCk7XG4gICAgJChcInRhc2tzLWNsb3NlXCIpLmZvY3VzKCk7XG4gIH0gZWxzZSBpZiAoIW5leHQgJiYgd2FzT3Blbikge1xuICAgIGNvbnN0IHRhcmdldCA9IGRyYXdlck9wZW5lcjtcbiAgICBkcmF3ZXJPcGVuZXIgPSBudWxsO1xuICAgIGlmICh0YXJnZXQgJiYgdGFyZ2V0LmlzQ29ubmVjdGVkICYmICF0YXJnZXQuaGlkZGVuICYmIHRhcmdldC5vZmZzZXRQYXJlbnQgIT09IG51bGwpIHRhcmdldC5mb2N1cygpO1xuICB9XG59XG5cbmZ1bmN0aW9uIHRhYnMoKSB7XG4gIGNvbnN0IHZpZXdzOiBSZWNvcmQ8c3RyaW5nLCBIVE1MRWxlbWVudD4gPSB7IHRhbGs6ICQoXCJ0YWxrXCIpLCBkZXY6ICQoXCJkZXZcIiksIHJlcGxheTogJChcInJlcGxheW1haW5cIikgfTtcbiAgZm9yIChjb25zdCBuYW1lIG9mIE9iamVjdC5rZXlzKHZpZXdzKSkge1xuICAgICQoYHRhYi0ke25hbWV9YCkub25jbGljayA9ICgpID0+IHtcbiAgICAgIGZvciAoY29uc3QgW290aGVyLCBlbF0gb2YgT2JqZWN0LmVudHJpZXModmlld3MpKSB7XG4gICAgICAgIGVsLmhpZGRlbiA9IG90aGVyICE9PSBuYW1lO1xuICAgICAgICAkKGB0YWItJHtvdGhlcn1gKS5jbGFzc0xpc3QudG9nZ2xlKFwib25cIiwgb3RoZXIgPT09IG5hbWUpO1xuICAgICAgfVxuICAgICAgJChcInRhc2tzLXRvZ2dsZVwiKS5oaWRkZW4gPSBuYW1lICE9PSBcInRhbGtcIjtcbiAgICAgIHNldFRhc2tzT3BlbihmYWxzZSk7XG4gICAgfTtcbiAgfVxuICAkKFwiZ2VhclwiKS5vbmNsaWNrID0gKCkgPT4geyAkKFwic2V0dGluZ3NcIikuaGlkZGVuID0gZmFsc2U7IH07XG4gICQoXCJjbG9zZXNldHRpbmdzXCIpLm9uY2xpY2sgPSAoKSA9PiB7ICQoXCJzZXR0aW5nc1wiKS5oaWRkZW4gPSB0cnVlOyB9O1xuICAkKFwiY2xvc2VzZXR0aW5ncy14XCIpLm9uY2xpY2sgPSAoKSA9PiB7ICQoXCJzZXR0aW5nc1wiKS5oaWRkZW4gPSB0cnVlOyB9O1xuICAkKFwic2V0dGluZ3NcIikub25jbGljayA9IChlKSA9PiB7IGlmIChlLnRhcmdldCA9PT0gJChcInNldHRpbmdzXCIpKSAkKFwic2V0dGluZ3NcIikuaGlkZGVuID0gdHJ1ZTsgfTtcbiAgJChcInRhc2tzLXRvZ2dsZVwiKS5vbmNsaWNrID0gKCkgPT4gc2V0VGFza3NPcGVuKCFkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5jb250YWlucyhcInRhc2tzLW9wZW5cIiksICQoXCJ0YXNrcy10b2dnbGVcIikpO1xuICAkKFwibW9iaWxlLXRhc2tzLWJhclwiKS5vbmNsaWNrID0gKCkgPT4gc2V0VGFza3NPcGVuKHRydWUsICQoXCJtb2JpbGUtdGFza3MtYmFyXCIpKTtcbiAgJChcInRhc2tzLWNsb3NlXCIpLm9uY2xpY2sgPSAoKSA9PiBzZXRUYXNrc09wZW4oZmFsc2UpO1xuICAkKFwic2lkZS1iYWNrZHJvcFwiKS5vbmNsaWNrID0gKCkgPT4gc2V0VGFza3NPcGVuKGZhbHNlKTtcbiAgbW9iaWxlTGF5b3V0LmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4gc2V0VGFza3NPcGVuKGZhbHNlKSk7XG4gIHNldFRhc2tzT3BlbihmYWxzZSk7XG59XG5cbmZ1bmN0aW9uIHR5cGluZygpOiBib29sZWFuIHtcbiAgY29uc3QgZWwgPSBkb2N1bWVudC5hY3RpdmVFbGVtZW50IGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgcmV0dXJuICEhZWwgJiYgKGVsLnRhZ05hbWUgPT09IFwiSU5QVVRcIiB8fCBlbC50YWdOYW1lID09PSBcIlRFWFRBUkVBXCIgfHwgZWwudGFnTmFtZSA9PT0gXCJTRUxFQ1RcIiB8fCBlbC5pc0NvbnRlbnRFZGl0YWJsZSk7XG59XG5cbmZ1bmN0aW9uIGtleXMoKSB7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJrZXlkb3duXCIsIChlKSA9PiB7XG4gICAgaWYgKGUua2V5ID09PSBcIkVzY2FwZVwiKSB7XG4gICAgICBpZiAoISQoXCJzZXR0aW5nc1wiKS5oaWRkZW4pIHsgJChcInNldHRpbmdzXCIpLmhpZGRlbiA9IHRydWU7IHJldHVybjsgfVxuICAgICAgaWYgKGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LmNvbnRhaW5zKFwidGFza3Mtb3BlblwiKSAmJiBtb2JpbGVMYXlvdXQubWF0Y2hlcyAmJiAhJChcInRhbGtcIikuaGlkZGVuKSB7IHNldFRhc2tzT3BlbihmYWxzZSk7IHJldHVybjsgfVxuICAgICAgaWYgKGNhbGxJZCkgeyBwdXNoKHsgdHlwZTogXCJpbnRlcnJ1cHRcIiB9KTsgYXVkaW8uZmx1c2goKTsgcmV0dXJuOyB9XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICh0eXBpbmcoKSB8fCAhJChcInNldHRpbmdzXCIpLmhpZGRlbiB8fCBkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5jb250YWlucyhcInRhc2tzLW9wZW5cIikgfHwgZS5tZXRhS2V5IHx8IGUuY3RybEtleSB8fCBlLmFsdEtleSkgcmV0dXJuO1xuICAgIGlmIChlLmtleSA9PT0gXCJtXCIgfHwgZS5rZXkgPT09IFwiTVwiKSB7IHNldE11dGVkKCFtdXRlZCk7IGUucHJldmVudERlZmF1bHQoKTsgfVxuICAgIGVsc2UgaWYgKGUua2V5ID09PSBcIndcIiB8fCBlLmtleSA9PT0gXCJXXCIpIHsgdm9pZCBhcm1XYWtlKCF3YWtlQXJtZWQpOyBlLnByZXZlbnREZWZhdWx0KCk7IH1cbiAgICBlbHNlIGlmIChlLmtleSA9PT0gXCIvXCIpIHsgJChcInRleHRcIikuZm9jdXMoKTsgZS5wcmV2ZW50RGVmYXVsdCgpOyB9XG4gICAgZWxzZSBpZiAoZS5jb2RlID09PSBcIlNwYWNlXCIgJiYgY2FsbElkICYmIG11dGVkICYmICFlLnJlcGVhdCkgeyBob2xkaW5nID0gdHJ1ZTsgcHVzaCh7IHR5cGU6IFwidW5tdXRlXCIgfSk7IHNob3dTdGF0dXMoKTsgZS5wcmV2ZW50RGVmYXVsdCgpOyB9XG4gIH0pO1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5dXBcIiwgKGUpID0+IHtcbiAgICBpZiAoZS5jb2RlID09PSBcIlNwYWNlXCIgJiYgaG9sZGluZykgeyBob2xkaW5nID0gZmFsc2U7IHB1c2goeyB0eXBlOiBcIm11dGVcIiB9KTsgc2hvd1N0YXR1cygpOyB9XG4gIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBzdWJtaXRUZXh0KGU6IEV2ZW50KSB7XG4gIGUucHJldmVudERlZmF1bHQoKTtcbiAgY29uc3QgaW5wdXQgPSAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwidGV4dFwiKTtcbiAgbGV0IHRleHQgPSBpbnB1dC52YWx1ZS50cmltKCk7XG4gIGlmICghdGV4dCkgcmV0dXJuO1xuICAvLyBXaXRoIG5vIGNhbGwgb24sIHR5cGluZyBzdGFydHMgYSBjaGF0OiB0aGUgc2FtZSBtYWluIHRocmVhZCwgaW4gdGV4dC5cbiAgaWYgKCFjYWxsSWQpIHtcbiAgICBpbnB1dC52YWx1ZSA9IFwiXCI7XG4gICAgc3luY0NvbXBvc2VyKCk7XG4gICAgdHJ5IHsgYXdhaXQgc3RhcnQoZmFsc2UsIHRydWUpOyB9IGNhdGNoIChlcnIpIHsgdG9hc3QoKGVyciBhcyBFcnJvcikubWVzc2FnZSk7IGxvZyhcImVycm9yXCIsIChlcnIgYXMgRXJyb3IpLm1lc3NhZ2UsIFwiZXJyXCIpOyB9XG4gICAgaWYgKCFjYWxsSWQpIHsgaW5wdXQudmFsdWUgPSB0ZXh0OyBzeW5jQ29tcG9zZXIoKTsgcmV0dXJuOyB9XG4gIH1cbiAgLy8gXCIvdDMgXHUyMDI2XCIgYW5kIFwiL2ggXHUyMDI2XCIgcGljayB0aGUgYWdlbnQgd2hhdGV2ZXIgdGhlIHNlbGVjdG9yIHNheXMuXG4gIGNvbnN0IHBhcnNlZCA9IHBhcnNlUHJlZml4KHRleHQpO1xuICBjb25zdCBtb2RlID0gcGFyc2VkLm1vZGUgPz8gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJtb2RlXCIpLnZhbHVlO1xuICB0ZXh0ID0gcGFyc2VkLnJlc3Q7XG4gIGlmICghdGV4dCkgcmV0dXJuO1xuICBpZiAobW9kZSA9PT0gXCJzYXlcIikge1xuICAgIHB1c2goeyB0eXBlOiBcInNheVwiLCB0ZXh0IH0pO1xuICAgIHNjcm9sbERvd24odHJ1ZSk7XG4gIH0gZWxzZSB7XG4gICAgcHVzaCh7IHR5cGU6IFwiYXNrXCIsIHRleHQsIGFnZW50OiBtb2RlIH0pO1xuICAgIG5vdGUoYFlvdSBcdTIxOTIgbmV3ICR7bW9kZSA9PT0gXCJ0M1wiID8gXCJjb2RpbmdcIiA6IFwiSGVybWVzXCJ9IHRhc2s6ICR7dGV4dH1gKTtcbiAgICBzY3JvbGxEb3duKHRydWUpO1xuICB9XG4gIGlucHV0LnZhbHVlID0gXCJcIjtcbiAgc3luY0NvbXBvc2VyKCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIG1haW4oKSB7XG4gIGFwcGx5VGhlbWUobG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS50aGVtZVwiKSA/PyBcInN5c3RlbVwiKTtcbiAgc2VydmVyID0gYXdhaXQgKGF3YWl0IGZldGNoKFwiL2NvbmZpZ1wiKSkuanNvbigpO1xuICAkKFwicm91dGVcIikudGV4dENvbnRlbnQgPSBgJHtzZXJ2ZXIucm91dGUgPT09IFwidmVydGV4XCIgPyBcIlZlcnRleFwiIDogXCJHZW1pbmkgQVBJXCJ9IFx1MDBCNyAke3NlcnZlci5tb2RlbC5zcGxpdChcIi9cIikucG9wKCl9YDtcbiAgJChcInZlcnNpb25cIikudGV4dENvbnRlbnQgPSBzZXJ2ZXIudmVyc2lvbjtcbiAgJChcImJ1aWxkXCIpLnRleHRDb250ZW50ID0gYGNvcmUgJHtzZXJ2ZXIudmVyc2lvbn1gO1xuICBzZXR0aW5nc0Zyb21TdG9yYWdlKCk7XG4gIGNvbnN0IHdha2VTZWxlY3QgPSAkPEhUTUxTZWxlY3RFbGVtZW50PihcIndha2UtbW9kZWxcIik7XG4gIGNvbnN0IHdha2VMaXN0ID0gc2VydmVyLndha2VNb2RlbHMgPz8gW107XG4gIGZvciAoY29uc3QgbSBvZiB3YWtlTGlzdCkgd2FrZVNlbGVjdC5hZGQobmV3IE9wdGlvbihtLmxhYmVsLCBtLmlkKSk7XG4gIGNvbnN0IHNhdmVkV2FrZU1vZGVsID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS53YWtlLW1vZGVsXCIpO1xuICBpZiAoc2F2ZWRXYWtlTW9kZWwgJiYgd2FrZUxpc3Quc29tZSgobSkgPT4gbS5pZCA9PT0gc2F2ZWRXYWtlTW9kZWwpKSB3YWtlU2VsZWN0LnZhbHVlID0gc2F2ZWRXYWtlTW9kZWw7XG4gIGVsc2UgaWYgKHdha2VMaXN0LnNvbWUoKG0pID0+IG0uaWQgPT09IFwicGVubnl3b3J0aFwiKSkgd2FrZVNlbGVjdC52YWx1ZSA9IFwicGVubnl3b3J0aFwiO1xuICBpZiAod2FrZUxpc3QubGVuZ3RoID09PSAwKSB7XG4gICAgJDxIVE1MSW5wdXRFbGVtZW50PihcIndha2UtZW5hYmxlZFwiKS5kaXNhYmxlZCA9IHRydWU7XG4gICAgd2FrZVNlbGVjdC5kaXNhYmxlZCA9IHRydWU7XG4gICAgJChcIndha2UtaGVscFwiKS50ZXh0Q29udGVudCA9IFwiTm8gLm9ubnggd2FrZSB3b3JkIG1vZGVscyBmb3VuZCBvbiB0aGUgc2VydmVyLlwiO1xuICB9XG4gIGlmICghc2VydmVyLmhlcm1lcykgeyAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwiZmFrZWhlcm1lc1wiKS5jaGVja2VkID0gdHJ1ZTsgJDxIVE1MSW5wdXRFbGVtZW50PihcImZha2VoZXJtZXNcIikuZGlzYWJsZWQgPSB0cnVlOyB9XG4gIGlmICghc2VydmVyLnQzKSAkKFwiY29kaW5naGVscFwiKS50ZXh0Q29udGVudCA9IFwiVDMgaXNuJ3QgYXZhaWxhYmxlIG9uIHRoZSBzZXJ2ZXI6IG9ubHkgd2l0aCBmYWtlIGFuc3dlcnMuXCI7XG4gIGVsc2UgJChcImNvZGluZ2hlbHBcIikudGV4dENvbnRlbnQgPSBgQ29kZSBjaGFuZ2VzIGdvIHRvIGEgVDMgQ29kZSB0aHJlYWQgaW4gb25lIG9mOiAke3NlcnZlci50My5qb2luKFwiLCBcIil9LmA7XG4gIGlmICghc3RvcFdvcmRzLnN1cHBvcnRlZCkgeyAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwic3RvcHdvcmRcIikuY2hlY2tlZCA9IGZhbHNlOyAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwic3RvcHdvcmRcIikuZGlzYWJsZWQgPSB0cnVlOyB9XG4gIGNvbnN0IHByZXNldCA9ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwicHJlc2V0XCIpO1xuICBmb3IgKGNvbnN0IG5hbWUgb2YgT2JqZWN0LmtleXMoUFJFU0VUUykpIHByZXNldC5hZGQobmV3IE9wdGlvbihuYW1lLCBuYW1lKSk7XG4gIHByZXNldC52YWx1ZSA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UtY29yZS5wcmVzZXRcIikgPz8gXCJ3ZWJcIjtcbiAgaWYgKCFQUkVTRVRTW3ByZXNldC52YWx1ZV0pIHByZXNldC52YWx1ZSA9IFwid2ViXCI7XG4gICQ8SFRNTFRleHRBcmVhRWxlbWVudD4oXCJjb25maWdcIikudmFsdWUgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLWNvcmUuY29uZmlnXCIpID8/IEpTT04uc3RyaW5naWZ5KFBSRVNFVFNbcHJlc2V0LnZhbHVlXSwgbnVsbCwgMik7XG4gIHByZXNldC5vbmNoYW5nZSA9ICgpID0+IHtcbiAgICAkPEhUTUxUZXh0QXJlYUVsZW1lbnQ+KFwiY29uZmlnXCIpLnZhbHVlID0gSlNPTi5zdHJpbmdpZnkoUFJFU0VUU1twcmVzZXQudmFsdWVdLCBudWxsLCAyKTtcbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLWNvcmUucHJlc2V0XCIsIHByZXNldC52YWx1ZSk7XG4gICAgbG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oXCJ2b2ljZS1jb3JlLmNvbmZpZ1wiKTtcbiAgICBzeW5jU2lnbmFsaW5nVWkoKTtcbiAgfTtcbiAgJChcImNvbmZpZ1wiKS5vbmlucHV0ID0gKCkgPT4geyBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLWNvcmUuY29uZmlnXCIsICQ8SFRNTFRleHRBcmVhRWxlbWVudD4oXCJjb25maWdcIikudmFsdWUpOyBzeW5jU2lnbmFsaW5nVWkoKTsgfTtcbiAgJChcImRlZmF1bHRzXCIpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYyA9IGNvcmUgPz8gKGF3YWl0IGxvYWRDb3JlKCkpO1xuICAgICQoXCJkZWZhdWx0c3ZpZXdcIikudGV4dENvbnRlbnQgPSBKU09OLnN0cmluZ2lmeShKU09OLnBhcnNlKGMuZGVmYXVsdHMoKSksIG51bGwsIDIpO1xuICAgICQoXCJkZWZhdWx0c3ZpZXdcIikuaGlkZGVuID0gISQoXCJkZWZhdWx0c3ZpZXdcIikuaGlkZGVuO1xuICB9O1xuICBjb25zdCBvbkNhbGxDbGljayA9ICgpID0+IHZvaWQgY2FsbEJ1dHRvbigpLmNhdGNoKChlcnIpID0+IHsgdG9hc3QoZXJyLm1lc3NhZ2UpOyBsb2coXCJlcnJvclwiLCBlcnIubWVzc2FnZSwgXCJlcnJcIik7IH0pO1xuICBjb25zdCBvbkhlcm9DYWxsQ2xpY2sgPSAoKSA9PiB7IGlmICghY2FsbElkKSB2b2lkIHN0YXJ0KCkuY2F0Y2goKGVycikgPT4geyB0b2FzdChlcnIubWVzc2FnZSk7IGxvZyhcImVycm9yXCIsIGVyci5tZXNzYWdlLCBcImVyclwiKTsgfSk7IH07XG4gIGNvbnN0IG9uUmVzdW1lQ2xpY2sgPSAoKSA9PiB2b2lkIHN0YXJ0KHRydWUpLmNhdGNoKChlcnIpID0+IHsgdG9hc3QoZXJyLm1lc3NhZ2UpOyBsb2coXCJlcnJvclwiLCBlcnIubWVzc2FnZSwgXCJlcnJcIik7IH0pO1xuICAkKFwiY2FsbFwiKS5vbmNsaWNrID0gb25DYWxsQ2xpY2s7XG4gICQoXCJoZXJvLWNhbGxcIikub25jbGljayA9IG9uSGVyb0NhbGxDbGljaztcbiAgJChcImhlcm8td2FrZVwiKS5vbmNsaWNrID0gKCkgPT4gdm9pZCBhcm1XYWtlKCF3YWtlQXJtZWQpO1xuICAkKFwid2FrZWJ0blwiKS5vbmNsaWNrID0gKCkgPT4gdm9pZCBhcm1XYWtlKCF3YWtlQXJtZWQpO1xuICAkKFwid2FrZS1ub3dcIikub25jbGljayA9ICgpID0+IHsgaWYgKGNhbGxJZCkgcHVzaCh7IHR5cGU6IFwicmVzdW1lXCIgfSk7IH07XG4gICQoXCJyZXN1bWVcIikub25jbGljayA9IG9uUmVzdW1lQ2xpY2s7XG4gICQoXCJoZXJvLXJlc3VtZVwiKS5vbmNsaWNrID0gb25SZXN1bWVDbGljaztcbiAgc3luY1dha2VVaSgpO1xuICBpZiAobG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS53YWtlLWVuYWJsZWRcIikgPT09IFwiMVwiICYmIHdha2VMaXN0Lmxlbmd0aCA+IDApIHtcbiAgICAvLyBSZS1hcm0gYXV0b21hdGljYWxseSBvbiByZWxvYWQgb25seSB3aGVuIG1pY3JvcGhvbmUgcGVybWlzc2lvbiBpcyBhbHJlYWR5IGdyYW50ZWQuXG4gICAgdm9pZCBuYXZpZ2F0b3IucGVybWlzc2lvbnM/LnF1ZXJ5KHsgbmFtZTogXCJtaWNyb3Bob25lXCIgYXMgUGVybWlzc2lvbk5hbWUgfSlcbiAgICAgIC50aGVuKChwKSA9PiB7IGlmIChwLnN0YXRlID09PSBcImdyYW50ZWRcIikgdm9pZCBhcm1XYWtlKHRydWUsIGZhbHNlKTsgfSlcbiAgICAgIC5jYXRjaCgoKSA9PiB7fSk7XG4gIH1cbiAgaWYgKHNhdmVkSGlzdG9yeSgpLmxlbmd0aCA+IDApIHtcbiAgICBzeW5jUmVzdW1lQnV0dG9ucyh0cnVlKTtcbiAgICAkKFwicmVzdW1lXCIpLnRpdGxlID0gXCJDYWxsIGFnYWluLCBjYXJyeWluZyBvbiBmcm9tIHRoZSBsYXN0IGNvbnZlcnNhdGlvblwiO1xuICB9XG4gICQoXCJtaWNcIikub25jbGljayA9ICgpID0+IHNldE11dGVkKCFtdXRlZCk7XG4gICQoXCJodXNoXCIpLm9uY2xpY2sgPSAoKSA9PiB7IHB1c2goeyB0eXBlOiBcImludGVycnVwdFwiIH0pOyBhdWRpby5mbHVzaCgpOyB9O1xuICAkKFwiY2FuY2VsYWxsXCIpLm9uY2xpY2sgPSAoKSA9PiBwdXNoKHsgdHlwZTogXCJjYW5jZWxBbGxcIiB9KTtcbiAgJChcImRvbmVib3hcIikuYWRkRXZlbnRMaXN0ZW5lcihcInRvZ2dsZVwiLCAoKSA9PiB7IGlmICgkPEhUTUxEZXRhaWxzRWxlbWVudD4oXCJkb25lYm94XCIpLm9wZW4pICQoXCJkb25lYm94XCIpLnNjcm9sbEludG9WaWV3KHsgYmxvY2s6IFwibmVhcmVzdFwiIH0pOyB9KTtcbiAgJChcInNheVwiKS5vbnN1Ym1pdCA9IChlKSA9PiB2b2lkIHN1Ym1pdFRleHQoZSk7XG4gICQoXCJ0ZXh0XCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJpbnB1dFwiLCBzeW5jQ29tcG9zZXIpO1xuICBjb25zdCB0cmFuc2NyaXB0UGFuZSA9ICQoXCJ0cmFuc2NyaXB0XCIpO1xuICB0cmFuc2NyaXB0UGFuZS5hZGRFdmVudExpc3RlbmVyKFwic2Nyb2xsXCIsICgpID0+IHRyYW5zY3JpcHRTY3JvbGwub25TY3JvbGwoKSwgeyBwYXNzaXZlOiB0cnVlIH0pO1xuICB0cmFuc2NyaXB0UGFuZS5hZGRFdmVudExpc3RlbmVyKFwic2Nyb2xsZW5kXCIsICgpID0+IHRyYW5zY3JpcHRTY3JvbGwub25TY3JvbGxFbmQoKSwgeyBwYXNzaXZlOiB0cnVlIH0pO1xuICB0cmFuc2NyaXB0UGFuZS5hZGRFdmVudExpc3RlbmVyKFwid2hlZWxcIiwgKGUpID0+IHsgaWYgKGUuZGVsdGFZIDwgMCkgdHJhbnNjcmlwdFNjcm9sbC5jYW5jZWxKdW1wKCk7IH0sIHsgcGFzc2l2ZTogdHJ1ZSB9KTtcbiAgdHJhbnNjcmlwdFBhbmUuYWRkRXZlbnRMaXN0ZW5lcihcInRvdWNoc3RhcnRcIiwgKCkgPT4gdHJhbnNjcmlwdFNjcm9sbC5jYW5jZWxKdW1wKCksIHsgcGFzc2l2ZTogdHJ1ZSB9KTtcbiAgaWYgKHR5cGVvZiBSZXNpemVPYnNlcnZlciAhPT0gXCJ1bmRlZmluZWRcIikgbmV3IFJlc2l6ZU9ic2VydmVyKCgpID0+IHRyYW5zY3JpcHRTY3JvbGwub25SZXNpemUoKSkub2JzZXJ2ZSh0cmFuc2NyaXB0UGFuZSk7XG4gICQoXCJqdW1wYm90dG9tXCIpLm9uY2xpY2sgPSAoKSA9PiB0cmFuc2NyaXB0U2Nyb2xsLmp1bXBUb0JvdHRvbSgpO1xuICBzeW5jQ29tcG9zZXIoKTtcbiAgdGFicygpO1xuICBrZXlzKCk7XG4gIGNvbnN0IGV2ZW50cyA9IG5ldyBFdmVudFNvdXJjZShcIi9ldmVudHNcIik7XG4gIGV2ZW50cy5hZGRFdmVudExpc3RlbmVyKFwiY29yZVwiLCAoZSkgPT4ge1xuICAgIGNvbnN0IHsgdmVyc2lvbiB9ID0gSlNPTi5wYXJzZSgoZSBhcyBNZXNzYWdlRXZlbnQpLmRhdGEpO1xuICAgICQoXCJ2ZXJzaW9uXCIpLnRleHRDb250ZW50ID0gdmVyc2lvbiArIChjYWxsSWQgJiYgY29yZSAmJiBjb3JlLnZlcnNpb24gIT09IHZlcnNpb24gPyBgIChuZXh0IGNhbGw7IHRoaXMgb25lIHJ1bnMgJHtjb3JlLnZlcnNpb259KWAgOiBcIlwiKTtcbiAgICAkKFwiYnVpbGRcIikudGV4dENvbnRlbnQgPSBgY29yZSAke3ZlcnNpb259YDtcbiAgfSk7XG4gIGV2ZW50cy5hZGRFdmVudExpc3RlbmVyKFwiYXBwXCIsICgpID0+IHsgaWYgKCFjYWxsSWQpIGxvY2F0aW9uLnJlbG9hZCgpOyBlbHNlIHRvYXN0KFwiVGhlIHBhZ2UgY2hhbmdlZDogcmVsb2FkIGFmdGVyIHRoaXMgY2FsbFwiKTsgfSk7XG4gIGV2ZW50cy5hZGRFdmVudExpc3RlbmVyKFwiZXJyb3JcIiwgKGUpID0+IHtcbiAgICBjb25zdCBkYXRhID0gKGUgYXMgTWVzc2FnZUV2ZW50KS5kYXRhO1xuICAgIGlmIChkYXRhKSB0b2FzdChgQnVpbGQgZmFpbGVkOiAke0pTT04ucGFyc2UoZGF0YSkubWVzc2FnZX1gKTtcbiAgfSk7XG4gIG5ldyBSZXBsYXkoJChcInJlcGxheVwiKSwgbG9hZENvcmUpO1xuICB2b2lkIHBpbmcoKTtcbiAgdm9pZCBzaG93RWFybGllcigpO1xuICB3aW5kb3cuc2V0SW50ZXJ2YWwoKCkgPT4gdm9pZCBzaG93RWFybGllcigpLCAzMF8wMDApO1xufVxuXG52b2lkIG1haW4oKTtcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFTQSxJQUFNLFNBQVMsb0JBQUksSUFBSTtBQUFBLEVBQ3JCO0FBQUEsRUFBTztBQUFBLEVBQU07QUFBQSxFQUFRO0FBQUEsRUFBVTtBQUFBLEVBQU87QUFBQSxFQUFRO0FBQUEsRUFBTTtBQUFBLEVBQU07QUFBQSxFQUFNO0FBQUEsRUFBTTtBQUFBLEVBQVc7QUFBQSxFQUFTO0FBQUEsRUFBUTtBQUFBLEVBQU87QUFBQSxFQUFVO0FBQUEsRUFBUztBQUFBLEVBQzVIO0FBQ0YsQ0FBQztBQUdNLFNBQVMsTUFBTSxNQUF3QjtBQUM1QyxTQUFPLEtBQUssWUFBWSxFQUFFLFFBQVEsVUFBVSxFQUFFLEVBQUUsUUFBUSxxQkFBcUIsR0FBRyxFQUFFLEtBQUssRUFBRSxNQUFNLEdBQUcsRUFBRSxPQUFPLENBQUMsTUFBTSxFQUFFLFNBQVMsQ0FBQztBQUNoSTtBQUdPLFNBQVMsVUFBVSxXQUFtQixVQUF5QixRQUFrQixDQUFDLEdBQXdCO0FBQy9HLFFBQU0sVUFBVSxvQkFBSSxJQUFJLENBQUMsR0FBRyxRQUFRLEdBQUcsTUFBTSxRQUFRLEtBQUssQ0FBQyxDQUFDO0FBQzVELFFBQU0sT0FBTyxNQUFNLFNBQVM7QUFDNUIsTUFBSSxPQUFPO0FBQ1gsTUFBSSxLQUFLLEtBQUs7QUFDZCxTQUFPLE9BQU8sTUFBTSxRQUFRLElBQUksS0FBSyxJQUFJLENBQUMsRUFBRztBQUM3QyxTQUFPLEtBQUssUUFBUSxRQUFRLElBQUksS0FBSyxLQUFLLENBQUMsQ0FBQyxFQUFHO0FBQy9DLE1BQUksU0FBUyxNQUFNLEtBQUssT0FBTyxFQUFHLFFBQU87QUFDekMsUUFBTUEsUUFBTyxLQUFLLE1BQU0sTUFBTSxFQUFFLEVBQUUsS0FBSyxHQUFHO0FBQzFDLFFBQU0sS0FBSyxDQUFDLFlBQXNCLFFBQVEsS0FBSyxDQUFDLE1BQU0sTUFBTSxDQUFDLEVBQUUsS0FBSyxHQUFHLE1BQU1BLEtBQUk7QUFDakYsTUFBSSxHQUFHLFNBQVMsTUFBTSxFQUFHLFFBQU87QUFDaEMsTUFBSSxHQUFHLFNBQVMsYUFBYSxDQUFDLENBQUMsRUFBRyxRQUFPO0FBQ3pDLE1BQUksR0FBRyxTQUFTLElBQUksRUFBRyxRQUFPO0FBQzlCLFNBQU87QUFDVDs7O0FDOUJBLElBQU0sV0FBVztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFB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QVk7QUFDckMsaUJBQWUsaUJBQWlCLFVBQVUsTUFBTSxpQkFBaUIsU0FBUyxHQUFHLEVBQUUsU0FBUyxLQUFLLENBQUM7QUFDOUYsaUJBQWUsaUJBQWlCLGFBQWEsTUFBTSxpQkFBaUIsWUFBWSxHQUFHLEVBQUUsU0FBUyxLQUFLLENBQUM7QUFDcEcsaUJBQWUsaUJBQWlCLFNBQVMsQ0FBQyxNQUFNO0FBQUUsUUFBSSxFQUFFLFNBQVMsRUFBRyxrQkFBaUIsV0FBVztBQUFBLEVBQUcsR0FBRyxFQUFFLFNBQVMsS0FBSyxDQUFDO0FBQ3ZILGlCQUFlLGlCQUFpQixjQUFjLE1BQU0saUJBQWlCLFdBQVcsR0FBRyxFQUFFLFNBQVMsS0FBSyxDQUFDO0FBQ3BHLE1BQUksT0FBTyxtQkFBbUIsWUFBYSxLQUFJLGVBQWUsTUFBTSxpQkFBaUIsU0FBUyxDQUFDLEVBQUUsUUFBUSxjQUFjO0FBQ3ZILElBQUUsWUFBWSxFQUFFLFVBQVUsTUFBTSxpQkFBaUIsYUFBYTtBQUM5RCxlQUFhO0FBQ2IsT0FBSztBQUNMLE9BQUs7QUFDTCxRQUFNLFNBQVMsSUFBSSxZQUFZLFNBQVM7QUFDeEMsU0FBTyxpQkFBaUIsUUFBUSxDQUFDLE1BQU07QUFDckMsVUFBTSxFQUFFLFFBQVEsSUFBSSxLQUFLLE1BQU8sRUFBbUIsSUFBSTtBQUN2RCxNQUFFLFNBQVMsRUFBRSxjQUFjLFdBQVcsVUFBVSxRQUFRLEtBQUssWUFBWSxVQUFVLDhCQUE4QixLQUFLLE9BQU8sTUFBTTtBQUNuSSxNQUFFLE9BQU8sRUFBRSxjQUFjLFFBQVEsT0FBTztBQUFBLEVBQzFDLENBQUM7QUFDRCxTQUFPLGlCQUFpQixPQUFPLE1BQU07QUFBRSxRQUFJLENBQUMsT0FBUSxVQUFTLE9BQU87QUFBQSxRQUFRLE9BQU0sMENBQTBDO0FBQUEsRUFBRyxDQUFDO0FBQ2hJLFNBQU8saUJBQWlCLFNBQVMsQ0FBQyxNQUFNO0FBQ3RDLFVBQU0sT0FBUSxFQUFtQjtBQUNqQyxRQUFJLEtBQU0sT0FBTSxpQkFBaUIsS0FBSyxNQUFNLElBQUksRUFBRSxPQUFPLEVBQUU7QUFBQSxFQUM3RCxDQUFDO0FBQ0QsTUFBSSxPQUFPLEVBQUUsUUFBUSxHQUFHLFFBQVE7QUFDaEMsT0FBSyxLQUFLO0FBQ1YsT0FBSyxZQUFZO0FBQ2pCLFNBQU8sWUFBWSxNQUFNLEtBQUssWUFBWSxHQUFHLEdBQU07QUFDckQ7QUFFQSxLQUFLLEtBQUs7IiwKICAibmFtZXMiOiBbImNvcmUiLCAiY29yZSIsICJub3ciLCAibGl2ZSIsICJsaW5lIiwgInJ1biIsICJtb2RlIl0KfQo=
