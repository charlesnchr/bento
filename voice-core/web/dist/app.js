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
    /** Incremented on every startMic/stopMic so superseded or cancelled getUserMedia calls never leak tracks. */
    this.micGen = 0;
    this.opening = null;
    this.stateListener = null;
    /** Seconds of speech queued, as the worklet last said. */
    this.queued = 0;
    /** The microphone's level, RMS of the last frame (0 to 1). */
    this.level = 0;
  }
  onAudioStateChange(listener) {
    this.stateListener = listener;
  }
  /** True when an AudioContext exists but the browser suspended it pending a user gesture. */
  get audioSuspended() {
    return this.context != null && this.context.state !== "running";
  }
  async resumeAudio() {
    const ctx = this.context;
    if (!ctx) return false;
    if (ctx.state === "running") return true;
    try {
      await ctx.resume();
    } catch {
    }
    return ctx.state === "running";
  }
  async open() {
    if (this.opening) {
      await this.opening;
      if (this.context?.state === "suspended") await this.context.resume().catch(() => {
      });
      return;
    }
    if (this.context) {
      if (this.context.state === "suspended") await this.context.resume().catch(() => {
      });
      return;
    }
    const init = (async () => {
      const ctx = new AudioContext({ latencyHint: "interactive" });
      ctx.onstatechange = () => this.stateListener?.();
      try {
        const url = URL.createObjectURL(new Blob([WORKLETS], { type: "text/javascript" }));
        await ctx.audioWorklet.addModule(url);
        const playback = new AudioWorkletNode(ctx, "playback", { numberOfInputs: 0, outputChannelCount: [2] });
        playback.port.onmessage = (e) => {
          this.queued = e.data.queued;
        };
        playback.connect(ctx.destination);
        this.context = ctx;
        this.playback = playback;
        this.stateListener?.();
      } catch (err) {
        try {
          await ctx.close?.();
        } catch {
        }
        throw err;
      } finally {
        this.opening = null;
      }
    })();
    this.opening = init;
    await init;
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
    this.stopMic();
    const gen = ++this.micGen;
    await this.open();
    if (gen !== this.micGen) return;
    const context = this.context;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, ...options } });
    if (gen !== this.micGen) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    let source = null;
    let capture = null;
    try {
      source = context.createMediaStreamSource(stream);
      capture = new AudioWorkletNode(context, "capture", { numberOfOutputs: 0 });
      capture.port.onmessage = (e) => {
        const frame = new Int16Array(e.data);
        let sum = 0;
        for (const s of frame) sum += s * s;
        this.level = Math.sqrt(sum / frame.length) / 32768;
        this.onMicFrame?.(frame, this.level);
      };
      source.connect(capture);
    } catch (err) {
      source?.disconnect();
      capture?.port.close();
      stream.getTracks().forEach((t) => t.stop());
      throw err;
    }
    this.stream = stream;
    this.micOpts = { ...options };
    this.onMicFrame = onFrame;
    this.source = source;
    this.capture = capture;
  }
  stopMic() {
    this.micGen++;
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
var RECENT_MAX_BYTES = Math.round(1.5 * 32e3);
var WakeClient = class {
  constructor(callbacks, createWorker = () => new Worker("/wake.worker.js", { type: "module" })) {
    this.worker = null;
    this.loadedModelId = null;
    this.loadingModelId = null;
    this.currentThreshold = 0.7;
    this.gen = 0;
    this.seq = 0;
    this.recent = [];
    this.recentBytes = 0;
    this.ready = false;
    this.callbacks = callbacks;
    this.createWorker = createWorker;
  }
  clearRecent() {
    this.recent = [];
    this.recentBytes = 0;
  }
  ensureWorker() {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    worker.onmessage = (e) => {
      const m = e.data;
      if (typeof m.gen === "number" && m.gen !== this.gen) return;
      if (m.type === "ready") {
        this.loadingModelId = null;
        this.loadedModelId = m.modelId;
        this.ready = true;
        this.callbacks.onReady?.(m.modelId, m.warmupMs);
      } else if (m.type === "detected") {
        const trailing = [];
        const rest = new Uint8Array(m.restBytes);
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
  /** Loads (or switches to) the named model; ignores stale results from earlier loads. */
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
      wasmPaths: "/ort/"
    });
  }
  setThreshold(threshold) {
    this.currentThreshold = threshold;
    this.worker?.postMessage({ type: "config", threshold });
  }
  feed(samples) {
    if (!this.ready || !this.worker) return;
    const seq = ++this.seq;
    const bytes = new Uint8Array(samples.byteLength);
    bytes.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
    this.recent.push({ seq, bytes });
    this.recentBytes += bytes.byteLength;
    while (this.recentBytes > RECENT_MAX_BYTES && this.recent.length > 1) {
      this.recentBytes -= this.recent.shift().bytes.byteLength;
    }
    const copy = new Int16Array(samples.length);
    copy.set(samples);
    this.worker.postMessage({ type: "feed", gen: this.gen, seq, pcm: copy.buffer }, [copy.buffer]);
  }
  reset() {
    this.clearRecent();
    if (!this.worker || !this.ready) return;
    this.gen++;
    this.worker.postMessage({ type: "reset", gen: this.gen });
  }
  dispose() {
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
  web: { platform: "web", device: "browser", standbyAfter: 30, handOff: "named", supervise: true, vocabulary: ["Hermes", "Bento", "Woodhouse", "Pennyworth", "T3"] },
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
var armGen = 0;
var coreWantsWake = false;
var wakeLoading = false;
var wakeStarting = false;
var startingCall = false;
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
  let text = armedIdle ? wakeLoading ? `Loading \u201C${wakeLabel}\u201D\u2026` : audio.audioSuspended ? `Tap anywhere to activate \u201C${wakeLabel}\u201D` : `Waiting for \u201C${wakeLabel}\u201D` : speaking ? "Speaking" : coreStatus === "dormant" ? `Dormant \xB7 say \u201C${wakeLabel}\u201D` : STATUS_TEXT[coreStatus] ?? coreStatus;
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
function developerOverrides() {
  try {
    const given = JSON.parse($("config").value);
    if (!given || typeof given !== "object") {
      return { nonWebPlatform: null, hasAttention: false, hasHangUp: false, hasStandby: false, hasMicWhileSpeaking: false };
    }
    const nonWebPlatform = typeof given.platform === "string" && given.platform !== "web" ? given.platform : null;
    const mic = given.mic && typeof given.mic === "object" ? given.mic : null;
    return {
      nonWebPlatform,
      hasAttention: given.attention !== void 0,
      hasHangUp: given.hangUpAfter !== void 0,
      hasStandby: given.standbyAfter !== void 0,
      hasMicWhileSpeaking: mic != null && mic.whileSpeaking !== void 0
    };
  } catch {
    return { nonWebPlatform: null, hasAttention: false, hasHangUp: false, hasStandby: false, hasMicWhileSpeaking: false };
  }
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
  const nonWeb = typeof given.platform === "string" && given.platform !== "web";
  if (!nonWeb) {
    const signaling = $("signaling").value;
    if (given.attention === void 0 && (signaling === "window" || signaling === "echo")) {
      config.attention = {
        mode: "window",
        afterWake: numberSetting("attn-after-wake", 8, 1, 60),
        window: numberSetting("attn-window", 5, 0, 60),
        afterQuestion: numberSetting("attn-after-question", 10, 0, 60),
        afterHandOff: 3,
        afterAnnouncement: 0
      };
    }
    if (given.hangUpAfter === void 0) {
      config.hangUpAfter = numberSetting("hangup-after", signaling === "echo" ? 15 : 300, 0, 3600);
    }
    if (signaling === "echo" && given.standbyAfter === void 0) {
      config.standbyAfter = 8;
    }
    const givenMic = given.mic && typeof given.mic === "object" ? given.mic : null;
    if ((!givenMic || givenMic.whileSpeaking === void 0) && (checked("wake-barge") || signaling === "echo")) {
      config.mic = { gainDb: 0, ...givenMic ?? {}, whileSpeaking: "wake" };
    }
  }
  return config;
}
async function start(carryOn = false, typed = false) {
  if (startingCall || callId) return false;
  startingCall = true;
  try {
    await ending;
    if (callId) return false;
    let given;
    try {
      given = readConfig();
    } catch (err) {
      toast(`The developer settings aren't valid JSON: ${err.message}`);
      return false;
    }
    if (typed) {
      if (!server.textModel) {
        toast("This server has no text model for a chat: start a call to type to it");
        return false;
      }
      given = { ...given, medium: "text", muted: false };
      delete given.captions;
    }
    $("call").disabled = true;
    $("hero-call").disabled = true;
    if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission().catch(() => {
    });
    let loadedCore;
    try {
      if (!typed) await audio.open();
      loadedCore = await loadCore();
    } finally {
      $("call").disabled = false;
      $("hero-call").disabled = false;
    }
    if (callId) return false;
    core = loadedCore;
    if (typed) {
      wakeStarting = false;
      openingChunks = [];
      openingBytes = 0;
      if (wakeArmed) audio.stopMic();
    }
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
    if (!typed) {
      stopWords.start();
      await acquireWakeLock();
    }
    return true;
  } finally {
    startingCall = false;
  }
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
  if (wakeStarting || startingCall) return false;
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
  if (callId === 0 && audio.audioSuspended) {
    $("heard").textContent = `Audio paused by browser \xB7 tap or press a key to resume \u201C${label}\u201D`;
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
  hero.textContent = wakeArmed ? wakeLoading ? `Loading \u201C${label}\u201D\u2026` : audio.audioSuspended ? `Activate \u201C${label}\u201D` : `Listening for \u201C${label}\u201D` : `Listen for \u201C${label}\u201D`;
  $("wake-enabled").checked = wakeArmed;
  renderWakeTelemetry();
  showStatus();
}
function syncSignalingUi() {
  const ov = developerOverrides();
  const signalingEl = $("signaling");
  const signaling = signalingEl.value;
  const nonWeb = ov.nonWebPlatform != null;
  signalingEl.disabled = nonWeb || ov.hasAttention;
  const windowControls = !nonWeb && !ov.hasAttention && (signaling === "window" || signaling === "echo");
  for (const id of ["attn-after-wake", "attn-window", "attn-after-question"]) {
    $(id).disabled = !windowControls;
  }
  $("hangup-after").disabled = nonWeb || ov.hasHangUp;
  const barge = $("wake-barge");
  if (nonWeb || ov.hasMicWhileSpeaking) {
    barge.disabled = true;
  } else if (signaling === "echo") {
    barge.checked = true;
    barge.disabled = true;
  } else {
    barge.disabled = false;
    barge.checked = localStorage.getItem("voice.wake-barge") === "1";
  }
  const overridden = [];
  if (ov.hasAttention) overridden.push("attention");
  if (ov.hasHangUp) overridden.push("hangUpAfter");
  if (ov.hasMicWhileSpeaking) overridden.push("mic.whileSpeaking");
  const hasModels = (server?.wakeModels?.length ?? 0) > 0;
  $("signaling-help").textContent = nonWeb ? `Developer preset (${ov.nonWebPlatform}) controls signaling.` : overridden.length > 0 ? `Developer config sets ${overridden.join(", ")}.` : !hasModels && signaling !== "open" ? "No wake models on server: use the Wake button when dormant." : "Applied on the next call unless overridden in Developer JSON.";
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
  const gen = ++armGen;
  wakeArmed = on;
  if (persist) localStorage.setItem("voice.wake-enabled", on ? "1" : "0");
  if (on && model) {
    wakeLastTel = null;
    if (!wakeClient.ready || wakeClient.modelId !== model.id) wakeLoading = true;
    wakeClient.load(model.id, wakeThreshold());
    if (!callId) {
      try {
        await audio.ensureMic(onMic, micOptions());
        if (gen !== armGen || !wakeArmed) return;
        wakeClient.reset();
        await acquireWakeLock();
      } catch (err) {
        if (gen !== armGen) return;
        wakeArmed = false;
        wakeLoading = false;
        if (!callId) {
          audio.stopMic();
          releaseWakeLock();
        }
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
    const wasLiveBargeIn = coreStatus !== "dormant" && coreStatus !== "standby";
    push({ type: "wake" });
    if (wasLiveBargeIn && callId !== 0 && hit.trailing.length > 0) {
      for (const chunk of hit.trailing) {
        if (!callId) break;
        if (chunk.byteLength === 0) continue;
        counts.mic++;
        push({ type: "mic", pcm: bytesToBase64(chunk) });
      }
    }
    return;
  }
  wakeStarting = true;
  openingChunks = [];
  openingBytes = 0;
  for (const chunk of hit.trailing) {
    if (chunk.byteLength === 0) continue;
    openingChunks.push(chunk);
    openingBytes += chunk.byteLength;
    while (openingBytes > OPENING_MAX_BYTES && openingChunks.length > 1) {
      openingBytes -= openingChunks.shift().byteLength;
    }
  }
  void start(chat.length > 0).then((started) => {
    if (!started && wakeStarting) {
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
    $(id).addEventListener("change", () => {
      localStorage.setItem(key, $(id).value);
      if (id === "hangup-after") localStorage.setItem("voice.hangup-custom", "1");
    });
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
    if (localStorage.getItem("voice.hangup-custom") !== "1") {
      const def = mode2 === "echo" ? "15" : "300";
      $("hangup-after").value = def;
      localStorage.setItem("voice.hangup-after", def);
    }
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
  audio.onAudioStateChange(() => syncWakeUi());
  const resumeIfSuspended = () => {
    if (audio.audioSuspended && (wakeArmed || callId)) {
      void audio.resumeAudio().then(() => syncWakeUi());
    }
  };
  document.addEventListener("pointerdown", resumeIfSuspended, { passive: true });
  document.addEventListener("pointerup", resumeIfSuspended, { passive: true });
  document.addEventListener("click", resumeIfSuspended, { passive: true });
  document.addEventListener("keydown", resumeIfSuspended, { passive: true });
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
  syncSignalingUi();
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
  $("hero-wake").onclick = () => {
    if (wakeArmed && audio.audioSuspended) {
      void audio.resumeAudio().then(() => syncWakeUi());
      return;
    }
    void armWake(!wakeArmed);
  };
  $("wakebtn").onclick = () => {
    if (wakeArmed && audio.audioSuspended) {
      void audio.resumeAudio().then(() => syncWakeUi());
      return;
    }
    void armWake(!wakeArmed);
  };
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL2NvbW1hbmRzLnRzIiwgIi4uL2F1ZGlvLnRzIiwgIi4uL3JlcGxheS50cyIsICIuLi9zY3JvbGwudHMiLCAiLi4vd2FrZUNsaWVudC50cyIsICIuLi9hcHAudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFNwb2tlbiBjb21tYW5kcyB0aGUgY29yZSBhY3RzIG9uIHdpdGhvdXQgdGhlIG1vZGVsOiBcInN0b3BcIiBhbmQgXCJoYW5nIHVwXCIuIEFuIHV0dGVyYW5jZSBjb3VudHNcbi8vIG9ubHkgd2hlbiBpdCBpcyBvbmUgb2YgdGhlIHBocmFzZXMgYW5kIG5vdGhpbmcgbW9yZSwgb25jZSBuYW1lcyBhbmQgZmlsbGVycyBhcm91bmQgaXQgYXJlIGdvbmUsXG4vLyBzbyBcIldvb2Rob3VzZSwgc3RvcCBwbGVhc2VcIiBzdG9wcyBhbmQgXCJzdG9wIHRoZSBQZW5ueXdvcnRoIHRhc2tcIiBnb2VzIHRvIHRoZSBtb2RlbCBhcyB1c3VhbC5cblxuaW1wb3J0IHR5cGUgeyBWb2ljZUNvbW1hbmRzIH0gZnJvbSBcIi4vdHlwZXMudHNcIjtcblxuZXhwb3J0IHR5cGUgVm9pY2VDb21tYW5kID0gXCJzdG9wXCIgfCBcImhhbmdVcFwiIHwgXCJjYW5jZWxBbGxcIjtcblxuLyoqIFdvcmRzIHRoYXQgbWF5IGNvbWUgYmVmb3JlIG9yIGFmdGVyIGEgY29tbWFuZCB3aXRob3V0IGNoYW5naW5nIGl0LiAqL1xuY29uc3QgRklMTEVSID0gbmV3IFNldChbXG4gIFwiaGV5XCIsIFwib2tcIiwgXCJva2F5XCIsIFwicGxlYXNlXCIsIFwibm93XCIsIFwianVzdFwiLCBcInNvXCIsIFwidW1cIiwgXCJ1aFwiLCBcIm9oXCIsIFwiYWxyaWdodFwiLCBcInJpZ2h0XCIsIFwieWVhaFwiLCBcInllc1wiLCBcInRoYW5rc1wiLCBcInRoYW5rXCIsIFwieW91XCIsXG4gIFwiZ2VtaW5pXCIsXG5dKTtcblxuLyoqIFt0ZXh0XSBhcyBsb3dlci1jYXNlIHdvcmRzLCBhcG9zdHJvcGhlcyBkcm9wcGVkIChcIlRoYXQnc1wiIGlzIFwidGhhdHNcIikuICovXG5leHBvcnQgZnVuY3Rpb24gd29yZHModGV4dDogc3RyaW5nKTogc3RyaW5nW10ge1xuICByZXR1cm4gdGV4dC50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL1snXHUyMDE5YF0vZywgXCJcIikucmVwbGFjZSgvW15cXHB7TH1cXHB7TmR9XSsvZ3UsIFwiIFwiKS50cmltKCkuc3BsaXQoXCIgXCIpLmZpbHRlcigodykgPT4gdy5sZW5ndGggPiAwKTtcbn1cblxuLyoqIFRoZSBjb21tYW5kIFt1dHRlcmFuY2VdIGlzLCBpZiBpdCdzIG9uZSBhbmQgbm90aGluZyBtb3JlOyBbbmFtZXNdICh0aGUgYXNzaXN0YW50J3MsIFwiV29vZGhvdXNlXCIpIGRvbid0IGNvdW50LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbW1hbmRJbih1dHRlcmFuY2U6IHN0cmluZywgY29tbWFuZHM6IFZvaWNlQ29tbWFuZHMsIG5hbWVzOiBzdHJpbmdbXSA9IFtdKTogVm9pY2VDb21tYW5kIHwgbnVsbCB7XG4gIGNvbnN0IGlnbm9yZWQgPSBuZXcgU2V0KFsuLi5GSUxMRVIsIC4uLm5hbWVzLmZsYXRNYXAod29yZHMpXSk7XG4gIGNvbnN0IHNhaWQgPSB3b3Jkcyh1dHRlcmFuY2UpO1xuICBsZXQgZnJvbSA9IDA7XG4gIGxldCB0byA9IHNhaWQubGVuZ3RoO1xuICB3aGlsZSAoZnJvbSA8IHRvICYmIGlnbm9yZWQuaGFzKHNhaWRbZnJvbV0pKSBmcm9tKys7XG4gIHdoaWxlICh0byA+IGZyb20gJiYgaWdub3JlZC5oYXMoc2FpZFt0byAtIDFdKSkgdG8tLTtcbiAgaWYgKGZyb20gPT09IHRvIHx8IHRvIC0gZnJvbSA+IDUpIHJldHVybiBudWxsO1xuICBjb25zdCBjb3JlID0gc2FpZC5zbGljZShmcm9tLCB0bykuam9pbihcIiBcIik7XG4gIGNvbnN0IGlzID0gKHBocmFzZXM6IHN0cmluZ1tdKSA9PiBwaHJhc2VzLnNvbWUoKHApID0+IHdvcmRzKHApLmpvaW4oXCIgXCIpID09PSBjb3JlKTtcbiAgaWYgKGlzKGNvbW1hbmRzLmhhbmdVcCkpIHJldHVybiBcImhhbmdVcFwiO1xuICBpZiAoaXMoY29tbWFuZHMuY2FuY2VsQWxsID8/IFtdKSkgcmV0dXJuIFwiY2FuY2VsQWxsXCI7XG4gIGlmIChpcyhjb21tYW5kcy5zdG9wKSkgcmV0dXJuIFwic3RvcFwiO1xuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqIFdvcmRzIHRoYXQgdGFrZSBhIHJlcXVlc3QgYmFjay4gKi9cbmNvbnN0IENBTkNFTFMgPSAvXFxiKD86Y2FuY2VsXFx3KnxhYm9ydFxcdyp8a2lsbHxzY3JhcHxzY3JhdGNofGRyb3B8Zm9yZ2V0fHVuZG98dGVybWluYXRlfG5ldmVyID9taW5kfGNhbGwgKD86aXR8dGhhdHx0aGlzKSBvZmZ8KD86ZG9udHxkbyBub3QpICg/OmJvdGhlcnxuZWVkfHdhbnR8ZG8pfG5vIG5lZWR8bm8gbG9uZ2VyfG5vdCBhbnltb3JlfGxlYXZlIGl0fHNraXAgKD86aXR8dGhhdCkpXFxiLztcbmNvbnN0IFNUT1BTID0gL1xcYig/OnN0b3BcXHcqfGhhbHR8cXVpdHxlbmQpXFxiLztcblxuLyoqXG4gKiBXaGV0aGVyIFt1dHRlcmFuY2VdIGFza3MgZm9yIGEgdGFzayB0byBiZSBjYW5jZWxsZWQsIGZvciBhIGNhbmNlbF90YXNrIHRoZSBtb2RlbCBjYWxsZWQgb24gaXQuIFwiU3RvcFwiIGFsb25lIGFuZCB0aGVcbiAqIG90aGVyIHN0b3AgYW5kIGhhbmctdXAgcGhyYXNlcyBkb24ndDogdGhleSBtZWFuIHN0b3AgdGFsa2luZy4gT3RoZXJ3aXNlIGl0IGRvZXMgd2hlbiBpdCBzYXlzIHNvIGluIHdvcmRzLCB3aGVuIGl0XG4gKiBuYW1lcyB0aGUgdGFzayAoW25hbWVkXSksIG9yIHdoZW4gaXQgc2F5cyB0byBzdG9wIHNvbWV0aGluZyBtb3JlIHRoYW4gdGhlIHRhbGtpbmcgKFwic3RvcCB3b3JraW5nIG9uIHRoYXRcIikuXG4gKiBXb3JkcyB0aGF0IHNheSBub25lIG9mIHRoaXMgKGEgbWlzaGVhcmluZyBzdWNoIGFzIFwiU3RhYml0XCIpIGRvbid0LiBXaXRoIG5vdGhpbmcgaGVhcmQgdGhlcmUgaXMgbm90aGluZyB0byBqdWRnZSBieS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFza3NUb0NhbmNlbCh1dHRlcmFuY2U6IHN0cmluZywgY29tbWFuZHM6IFZvaWNlQ29tbWFuZHMsIG5hbWVzOiBzdHJpbmdbXSwgbmFtZWQ6IGJvb2xlYW4pOiBib29sZWFuIHtcbiAgY29uc3Qgc2FpZCA9IHdvcmRzKHV0dGVyYW5jZSkuam9pbihcIiBcIik7XG4gIGlmIChzYWlkLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHRydWU7XG4gIGNvbnN0IGNvbW1hbmQgPSBjb21tYW5kSW4odXR0ZXJhbmNlLCBjb21tYW5kcywgbmFtZXMpO1xuICBpZiAoY29tbWFuZCA9PT0gXCJzdG9wXCIgfHwgY29tbWFuZCA9PT0gXCJoYW5nVXBcIikgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gY29tbWFuZCA9PT0gXCJjYW5jZWxBbGxcIiB8fCBuYW1lZCB8fCBDQU5DRUxTLnRlc3Qoc2FpZCkgfHwgU1RPUFMudGVzdChzYWlkKTtcbn1cbiIsICIvLyBUaGUgYnJvd3NlcidzIG1pY3JvcGhvbmUgYW5kIHNwZWFrZXIgZm9yIGEgY2FsbDogMTYga0h6IFBDTTE2IGZyYW1lcyBvdXQgb2YgdGhlIG1pY3JvcGhvbmUsXG4vLyAyNCBrSHogUENNMTYgaW50byB0aGUgc3BlYWtlciwgYW5kIHRvbmVzIGxhaWQgb3ZlciB3aGF0ZXZlciBwbGF5cy4gQm90aCBydW4gaW4gQXVkaW9Xb3JrbGV0cyBvblxuLy8gb25lIEF1ZGlvQ29udGV4dCBhdCB0aGUgZGV2aWNlJ3MgcmF0ZSwgcmVzYW1wbGluZyB0aGVyZS5cblxuY29uc3QgV09SS0xFVFMgPSBgXG5jbGFzcyBDYXB0dXJlIGV4dGVuZHMgQXVkaW9Xb3JrbGV0UHJvY2Vzc29yIHtcbiAgY29uc3RydWN0b3IoKSB7XG4gICAgc3VwZXIoKTtcbiAgICB0aGlzLnN0ZXAgPSBzYW1wbGVSYXRlIC8gMTYwMDA7XG4gICAgdGhpcy5wb3MgPSAwO1xuICAgIHRoaXMuZnJhbWUgPSBuZXcgSW50MTZBcnJheSgzMjApO1xuICAgIHRoaXMubiA9IDA7XG4gICAgLy8gQSB3aW5kb3dlZC1zaW5jIGxvdy1wYXNzIGF0IDcga0h6LCBzbyBub3RoaW5nIGFib3ZlIDE2IGtIeidzIDgga0h6IGxpbWl0IGZvbGRzIGJhY2sgaW50byBzcGVlY2guXG4gICAgY29uc3QgdGFwcyA9IDQ3LCBjdXQgPSA3MDAwIC8gc2FtcGxlUmF0ZTtcbiAgICB0aGlzLnRhcHMgPSBuZXcgRmxvYXQzMkFycmF5KHRhcHMpO1xuICAgIGxldCBzdW0gPSAwO1xuICAgIGZvciAobGV0IGsgPSAwOyBrIDwgdGFwczsgaysrKSB7XG4gICAgICBjb25zdCBtID0gayAtICh0YXBzIC0gMSkgLyAyO1xuICAgICAgY29uc3Qgc2luYyA9IG0gPT09IDAgPyAyICogY3V0IDogTWF0aC5zaW4oMiAqIE1hdGguUEkgKiBjdXQgKiBtKSAvIChNYXRoLlBJICogbSk7XG4gICAgICBjb25zdCB3ID0gMC40MiAtIDAuNSAqIE1hdGguY29zKCgyICogTWF0aC5QSSAqIGspIC8gKHRhcHMgLSAxKSkgKyAwLjA4ICogTWF0aC5jb3MoKDQgKiBNYXRoLlBJICogaykgLyAodGFwcyAtIDEpKTtcbiAgICAgIHRoaXMudGFwc1trXSA9IHNpbmMgKiB3O1xuICAgICAgc3VtICs9IHRoaXMudGFwc1trXTtcbiAgICB9XG4gICAgZm9yIChsZXQgayA9IDA7IGsgPCB0YXBzOyBrKyspIHRoaXMudGFwc1trXSAvPSBzdW07XG4gICAgdGhpcy5oaXN0b3J5ID0gbmV3IEZsb2F0MzJBcnJheSh0YXBzKTtcbiAgICB0aGlzLmF0ID0gMDtcbiAgfVxuICBwcm9jZXNzKGlucHV0cykge1xuICAgIGNvbnN0IGlucHV0ID0gaW5wdXRzWzBdICYmIGlucHV0c1swXVswXTtcbiAgICBpZiAoIWlucHV0KSByZXR1cm4gdHJ1ZTtcbiAgICBjb25zdCB0YXBzID0gdGhpcy50YXBzLCBoID0gdGhpcy5oaXN0b3J5LCBuID0gdGFwcy5sZW5ndGg7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBpbnB1dC5sZW5ndGg7IGkrKykge1xuICAgICAgaFt0aGlzLmF0XSA9IGlucHV0W2ldO1xuICAgICAgdGhpcy5hdCA9ICh0aGlzLmF0ICsgMSkgJSBuO1xuICAgICAgLy8gT25seSB0aGUgc2FtcGxlcyBrZXB0IG5lZWQgZmlsdGVyaW5nOiBhdCBtb3N0IG9uZSBpbiBldmVyeSBzdGVwLlxuICAgICAgaWYgKHRoaXMucG9zID4gMSkgeyB0aGlzLnBvcyAtPSAxOyBjb250aW51ZTsgfVxuICAgICAgbGV0IHggPSAwO1xuICAgICAgZm9yIChsZXQgayA9IDAsIGogPSB0aGlzLmF0OyBrIDwgbjsgaysrLCBqID0gaiArIDEgPT09IG4gPyAwIDogaiArIDEpIHggKz0gdGFwc1trXSAqIGhbal07XG4gICAgICB3aGlsZSAodGhpcy5wb3MgPD0gMSkge1xuICAgICAgICBjb25zdCBzID0gTWF0aC5tYXgoLTEsIE1hdGgubWluKDEsIHgpKTtcbiAgICAgICAgdGhpcy5mcmFtZVt0aGlzLm4rK10gPSBzIDwgMCA/IHMgKiAzMjc2OCA6IHMgKiAzMjc2NztcbiAgICAgICAgaWYgKHRoaXMubiA9PT0gdGhpcy5mcmFtZS5sZW5ndGgpIHtcbiAgICAgICAgICB0aGlzLnBvcnQucG9zdE1lc3NhZ2UodGhpcy5mcmFtZS5idWZmZXIsIFt0aGlzLmZyYW1lLmJ1ZmZlcl0pO1xuICAgICAgICAgIHRoaXMuZnJhbWUgPSBuZXcgSW50MTZBcnJheSgzMjApO1xuICAgICAgICAgIHRoaXMubiA9IDA7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5wb3MgKz0gdGhpcy5zdGVwO1xuICAgICAgfVxuICAgICAgdGhpcy5wb3MgLT0gMTtcbiAgICB9XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbn1cblxuY2xhc3MgUGxheWJhY2sgZXh0ZW5kcyBBdWRpb1dvcmtsZXRQcm9jZXNzb3Ige1xuICBjb25zdHJ1Y3RvcigpIHtcbiAgICBzdXBlcigpO1xuICAgIHRoaXMucXVldWUgPSBbXTsgICAgICAvLyBGbG9hdDMyQXJyYXlzIGF0IHRoZSBjb250ZXh0J3MgcmF0ZVxuICAgIHRoaXMub2Zmc2V0ID0gMDtcbiAgICB0aGlzLmN1ZXMgPSBbXTtcbiAgICB0aGlzLmN1ZU9mZnNldCA9IDA7XG4gICAgdGhpcy5yZXBvcnRlZCA9IDA7XG4gICAgdGhpcy5wb3J0Lm9ubWVzc2FnZSA9IChlKSA9PiB7XG4gICAgICBjb25zdCBtID0gZS5kYXRhO1xuICAgICAgaWYgKG0udHlwZSA9PT0gXCJwbGF5XCIpIHRoaXMucXVldWUucHVzaChtLnNhbXBsZXMpO1xuICAgICAgZWxzZSBpZiAobS50eXBlID09PSBcImN1ZVwiKSB0aGlzLmN1ZXMucHVzaChtLnNhbXBsZXMpO1xuICAgICAgZWxzZSBpZiAobS50eXBlID09PSBcImZsdXNoXCIpIHsgdGhpcy5xdWV1ZSA9IFtdOyB0aGlzLm9mZnNldCA9IDA7IH1cbiAgICAgIGVsc2UgaWYgKG0udHlwZSA9PT0gXCJzdG9wXCIpIHsgdGhpcy5xdWV1ZSA9IFtdOyB0aGlzLm9mZnNldCA9IDA7IHRoaXMuY3VlcyA9IFtdOyB0aGlzLmN1ZU9mZnNldCA9IDA7IH1cbiAgICB9O1xuICB9XG4gIHByb2Nlc3MoXywgb3V0cHV0cykge1xuICAgIGNvbnN0IG91dCA9IG91dHB1dHNbMF1bMF07XG4gICAgb3V0LmZpbGwoMCk7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoICYmIHRoaXMucXVldWUubGVuZ3RoOyBpKyspIHtcbiAgICAgIG91dFtpXSA9IHRoaXMucXVldWVbMF1bdGhpcy5vZmZzZXQrK107XG4gICAgICBpZiAodGhpcy5vZmZzZXQgPj0gdGhpcy5xdWV1ZVswXS5sZW5ndGgpIHsgdGhpcy5xdWV1ZS5zaGlmdCgpOyB0aGlzLm9mZnNldCA9IDA7IH1cbiAgICB9XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoICYmIHRoaXMuY3Vlcy5sZW5ndGg7IGkrKykge1xuICAgICAgb3V0W2ldID0gTWF0aC5tYXgoLTEsIE1hdGgubWluKDEsIG91dFtpXSArIHRoaXMuY3Vlc1swXVt0aGlzLmN1ZU9mZnNldCsrXSkpO1xuICAgICAgaWYgKHRoaXMuY3VlT2Zmc2V0ID49IHRoaXMuY3Vlc1swXS5sZW5ndGgpIHsgdGhpcy5jdWVzLnNoaWZ0KCk7IHRoaXMuY3VlT2Zmc2V0ID0gMDsgfVxuICAgIH1cbiAgICBmb3IgKGxldCBjID0gMTsgYyA8IG91dHB1dHNbMF0ubGVuZ3RoOyBjKyspIG91dHB1dHNbMF1bY10uc2V0KG91dCk7XG4gICAgaWYgKGN1cnJlbnRUaW1lIC0gdGhpcy5yZXBvcnRlZCA+IDAuMSkge1xuICAgICAgdGhpcy5yZXBvcnRlZCA9IGN1cnJlbnRUaW1lO1xuICAgICAgbGV0IHF1ZXVlZCA9IC10aGlzLm9mZnNldDtcbiAgICAgIGZvciAoY29uc3QgcSBvZiB0aGlzLnF1ZXVlKSBxdWV1ZWQgKz0gcS5sZW5ndGg7XG4gICAgICB0aGlzLnBvcnQucG9zdE1lc3NhZ2UoeyBxdWV1ZWQ6IHF1ZXVlZCAvIHNhbXBsZVJhdGUgfSk7XG4gICAgfVxuICAgIHJldHVybiB0cnVlO1xuICB9XG59XG5yZWdpc3RlclByb2Nlc3NvcihcImNhcHR1cmVcIiwgQ2FwdHVyZSk7XG5yZWdpc3RlclByb2Nlc3NvcihcInBsYXliYWNrXCIsIFBsYXliYWNrKTtcbmA7XG5cbmZ1bmN0aW9uIGJhc2U2NFRvQnl0ZXMoYjY0OiBzdHJpbmcpOiBVaW50OEFycmF5IHtcbiAgY29uc3QgYmluID0gYXRvYihiNjQpO1xuICBjb25zdCBvdXQgPSBuZXcgVWludDhBcnJheShiaW4ubGVuZ3RoKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBiaW4ubGVuZ3RoOyBpKyspIG91dFtpXSA9IGJpbi5jaGFyQ29kZUF0KGkpO1xuICByZXR1cm4gb3V0O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYnl0ZXNUb0Jhc2U2NChieXRlczogVWludDhBcnJheSk6IHN0cmluZyB7XG4gIGxldCBiaW4gPSBcIlwiO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGJ5dGVzLmxlbmd0aDsgaSArPSAweDgwMDApIGJpbiArPSBTdHJpbmcuZnJvbUNoYXJDb2RlKC4uLmJ5dGVzLnN1YmFycmF5KGksIGkgKyAweDgwMDApKTtcbiAgcmV0dXJuIGJ0b2EoYmluKTtcbn1cblxuLyoqIFBDTTE2IGxpdHRsZS1lbmRpYW4gYXQgW3JhdGVdLCBhcyBmbG9hdHMgYXQgdGhlIGNvbnRleHQncyByYXRlLiAqL1xuZnVuY3Rpb24gdG9GbG9hdHMocGNtOiBVaW50OEFycmF5LCByYXRlOiBudW1iZXIsIHRhcmdldDogbnVtYmVyKTogRmxvYXQzMkFycmF5IHtcbiAgY29uc3QgdmlldyA9IG5ldyBEYXRhVmlldyhwY20uYnVmZmVyLCBwY20uYnl0ZU9mZnNldCwgcGNtLmJ5dGVMZW5ndGgpO1xuICBjb25zdCBuID0gTWF0aC5mbG9vcihwY20uYnl0ZUxlbmd0aCAvIDIpO1xuICBjb25zdCBvdXQgPSBuZXcgRmxvYXQzMkFycmF5KE1hdGguZmxvb3IoKG4gKiB0YXJnZXQpIC8gcmF0ZSkpO1xuICBjb25zdCBzdGVwID0gcmF0ZSAvIHRhcmdldDtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCB4ID0gaSAqIHN0ZXA7XG4gICAgY29uc3QgaiA9IE1hdGguZmxvb3IoeCk7XG4gICAgY29uc3QgYSA9IHZpZXcuZ2V0SW50MTYoMiAqIE1hdGgubWluKGosIG4gLSAxKSwgdHJ1ZSk7XG4gICAgY29uc3QgYiA9IHZpZXcuZ2V0SW50MTYoMiAqIE1hdGgubWluKGogKyAxLCBuIC0gMSksIHRydWUpO1xuICAgIG91dFtpXSA9IChhICsgKGIgLSBhKSAqICh4IC0gaikpIC8gMzI3Njg7XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBNaWNPcHRpb25zIHsgZWNob0NhbmNlbGxhdGlvbjogYm9vbGVhbjsgbm9pc2VTdXBwcmVzc2lvbjogYm9vbGVhbjsgYXV0b0dhaW5Db250cm9sOiBib29sZWFuIH1cblxuZXhwb3J0IGNsYXNzIENhbGxBdWRpbyB7XG4gIHByaXZhdGUgY29udGV4dDogQXVkaW9Db250ZXh0IHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgcGxheWJhY2s6IEF1ZGlvV29ya2xldE5vZGUgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBjYXB0dXJlOiBBdWRpb1dvcmtsZXROb2RlIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgc3RyZWFtOiBNZWRpYVN0cmVhbSB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIHNvdXJjZTogTWVkaWFTdHJlYW1BdWRpb1NvdXJjZU5vZGUgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBtaWNPcHRzOiBNaWNPcHRpb25zIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgb25NaWNGcmFtZTogKChzYW1wbGVzOiBJbnQxNkFycmF5LCBsZXZlbDogbnVtYmVyKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuICAvKiogSW5jcmVtZW50ZWQgb24gZXZlcnkgc3RhcnRNaWMvc3RvcE1pYyBzbyBzdXBlcnNlZGVkIG9yIGNhbmNlbGxlZCBnZXRVc2VyTWVkaWEgY2FsbHMgbmV2ZXIgbGVhayB0cmFja3MuICovXG4gIHByaXZhdGUgbWljR2VuID0gMDtcbiAgcHJpdmF0ZSBvcGVuaW5nOiBQcm9taXNlPHZvaWQ+IHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgc3RhdGVMaXN0ZW5lcjogKCgpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XG4gIC8qKiBTZWNvbmRzIG9mIHNwZWVjaCBxdWV1ZWQsIGFzIHRoZSB3b3JrbGV0IGxhc3Qgc2FpZC4gKi9cbiAgcXVldWVkID0gMDtcbiAgLyoqIFRoZSBtaWNyb3Bob25lJ3MgbGV2ZWwsIFJNUyBvZiB0aGUgbGFzdCBmcmFtZSAoMCB0byAxKS4gKi9cbiAgbGV2ZWwgPSAwO1xuXG4gIG9uQXVkaW9TdGF0ZUNoYW5nZShsaXN0ZW5lcjogKCgpID0+IHZvaWQpIHwgbnVsbCk6IHZvaWQge1xuICAgIHRoaXMuc3RhdGVMaXN0ZW5lciA9IGxpc3RlbmVyO1xuICB9XG5cbiAgLyoqIFRydWUgd2hlbiBhbiBBdWRpb0NvbnRleHQgZXhpc3RzIGJ1dCB0aGUgYnJvd3NlciBzdXNwZW5kZWQgaXQgcGVuZGluZyBhIHVzZXIgZ2VzdHVyZS4gKi9cbiAgZ2V0IGF1ZGlvU3VzcGVuZGVkKCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLmNvbnRleHQgIT0gbnVsbCAmJiB0aGlzLmNvbnRleHQuc3RhdGUgIT09IFwicnVubmluZ1wiO1xuICB9XG5cbiAgYXN5bmMgcmVzdW1lQXVkaW8oKTogUHJvbWlzZTxib29sZWFuPiB7XG4gICAgY29uc3QgY3R4ID0gdGhpcy5jb250ZXh0O1xuICAgIGlmICghY3R4KSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKGN0eC5zdGF0ZSA9PT0gXCJydW5uaW5nXCIpIHJldHVybiB0cnVlO1xuICAgIHRyeSB7IGF3YWl0IGN0eC5yZXN1bWUoKTsgfSBjYXRjaCB7fVxuICAgIHJldHVybiAoY3R4LnN0YXRlIGFzIEF1ZGlvQ29udGV4dFN0YXRlKSA9PT0gXCJydW5uaW5nXCI7XG4gIH1cblxuICBhc3luYyBvcGVuKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICh0aGlzLm9wZW5pbmcpIHtcbiAgICAgIGF3YWl0IHRoaXMub3BlbmluZztcbiAgICAgIGlmICh0aGlzLmNvbnRleHQ/LnN0YXRlID09PSBcInN1c3BlbmRlZFwiKSBhd2FpdCB0aGlzLmNvbnRleHQucmVzdW1lKCkuY2F0Y2goKCkgPT4ge30pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAodGhpcy5jb250ZXh0KSB7IGlmICh0aGlzLmNvbnRleHQuc3RhdGUgPT09IFwic3VzcGVuZGVkXCIpIGF3YWl0IHRoaXMuY29udGV4dC5yZXN1bWUoKS5jYXRjaCgoKSA9PiB7fSk7IHJldHVybjsgfVxuICAgIGNvbnN0IGluaXQgPSAoYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgY3R4ID0gbmV3IEF1ZGlvQ29udGV4dCh7IGxhdGVuY3lIaW50OiBcImludGVyYWN0aXZlXCIgfSk7XG4gICAgICBjdHgub25zdGF0ZWNoYW5nZSA9ICgpID0+IHRoaXMuc3RhdGVMaXN0ZW5lcj8uKCk7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCB1cmwgPSBVUkwuY3JlYXRlT2JqZWN0VVJMKG5ldyBCbG9iKFtXT1JLTEVUU10sIHsgdHlwZTogXCJ0ZXh0L2phdmFzY3JpcHRcIiB9KSk7XG4gICAgICAgIGF3YWl0IGN0eC5hdWRpb1dvcmtsZXQuYWRkTW9kdWxlKHVybCk7XG4gICAgICAgIGNvbnN0IHBsYXliYWNrID0gbmV3IEF1ZGlvV29ya2xldE5vZGUoY3R4LCBcInBsYXliYWNrXCIsIHsgbnVtYmVyT2ZJbnB1dHM6IDAsIG91dHB1dENoYW5uZWxDb3VudDogWzJdIH0pO1xuICAgICAgICBwbGF5YmFjay5wb3J0Lm9ubWVzc2FnZSA9IChlKSA9PiB7IHRoaXMucXVldWVkID0gZS5kYXRhLnF1ZXVlZDsgfTtcbiAgICAgICAgcGxheWJhY2suY29ubmVjdChjdHguZGVzdGluYXRpb24pO1xuICAgICAgICB0aGlzLmNvbnRleHQgPSBjdHg7XG4gICAgICAgIHRoaXMucGxheWJhY2sgPSBwbGF5YmFjaztcbiAgICAgICAgdGhpcy5zdGF0ZUxpc3RlbmVyPy4oKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICB0cnkgeyBhd2FpdCBjdHguY2xvc2U/LigpOyB9IGNhdGNoIHt9XG4gICAgICAgIHRocm93IGVycjtcbiAgICAgIH0gZmluYWxseSB7XG4gICAgICAgIHRoaXMub3BlbmluZyA9IG51bGw7XG4gICAgICB9XG4gICAgfSkoKTtcbiAgICB0aGlzLm9wZW5pbmcgPSBpbml0O1xuICAgIGF3YWl0IGluaXQ7XG4gIH1cblxuICAvKiogU2Vjb25kcyBmcm9tIGEgc2FtcGxlIGxlYXZpbmcgdGhlIHdvcmtsZXQgdG8gdGhlIHNwZWFrZXIsIGFzIHRoZSBicm93c2VyIHJlY2tvbnMgaXQuICovXG4gIGdldCBvdXRwdXRMYXRlbmN5KCk6IG51bWJlciB8IG51bGwge1xuICAgIGlmICghdGhpcy5jb250ZXh0KSByZXR1cm4gbnVsbDtcbiAgICByZXR1cm4gdGhpcy5jb250ZXh0LmJhc2VMYXRlbmN5ICsgKCh0aGlzLmNvbnRleHQgYXMgQXVkaW9Db250ZXh0ICYgeyBvdXRwdXRMYXRlbmN5PzogbnVtYmVyIH0pLm91dHB1dExhdGVuY3kgPz8gMCk7XG4gIH1cblxuICBnZXQgbWljQWN0aXZlKCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLmNhcHR1cmUgIT0gbnVsbCAmJiB0aGlzLnN0cmVhbSAhPSBudWxsICYmIHRoaXMuc3RyZWFtLmdldFRyYWNrcygpLnNvbWUoKHQpID0+IHQucmVhZHlTdGF0ZSA9PT0gXCJsaXZlXCIpO1xuICB9XG5cbiAgLyoqIFN0YXJ0cyB0aGUgbWljcm9waG9uZSBpZiBpdCBpc24ndCBhbHJlYWR5IHJ1bm5pbmcgd2l0aCB0aGUgc2FtZSBvcHRpb25zOyBvdGhlcndpc2Ugc3dhcHMgdGhlIGZyYW1lIGNhbGxiYWNrIGNsZWFubHkuICovXG4gIGFzeW5jIGVuc3VyZU1pYyhvbkZyYW1lOiAoc2FtcGxlczogSW50MTZBcnJheSwgbGV2ZWw6IG51bWJlcikgPT4gdm9pZCwgb3B0aW9uczogTWljT3B0aW9ucyk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmIChcbiAgICAgIHRoaXMubWljQWN0aXZlICYmXG4gICAgICB0aGlzLm1pY09wdHMgJiZcbiAgICAgIHRoaXMubWljT3B0cy5lY2hvQ2FuY2VsbGF0aW9uID09PSBvcHRpb25zLmVjaG9DYW5jZWxsYXRpb24gJiZcbiAgICAgIHRoaXMubWljT3B0cy5ub2lzZVN1cHByZXNzaW9uID09PSBvcHRpb25zLm5vaXNlU3VwcHJlc3Npb24gJiZcbiAgICAgIHRoaXMubWljT3B0cy5hdXRvR2FpbkNvbnRyb2wgPT09IG9wdGlvbnMuYXV0b0dhaW5Db250cm9sXG4gICAgKSB7XG4gICAgICBhd2FpdCB0aGlzLm9wZW4oKTtcbiAgICAgIHRoaXMub25NaWNGcmFtZSA9IG9uRnJhbWU7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGF3YWl0IHRoaXMuc3RhcnRNaWMob25GcmFtZSwgb3B0aW9ucyk7XG4gIH1cblxuICBhc3luYyBzdGFydE1pYyhvbkZyYW1lOiAoc2FtcGxlczogSW50MTZBcnJheSwgbGV2ZWw6IG51bWJlcikgPT4gdm9pZCwgb3B0aW9uczogTWljT3B0aW9ucyk6IFByb21pc2U8dm9pZD4ge1xuICAgIHRoaXMuc3RvcE1pYygpO1xuICAgIGNvbnN0IGdlbiA9ICsrdGhpcy5taWNHZW47XG4gICAgYXdhaXQgdGhpcy5vcGVuKCk7XG4gICAgaWYgKGdlbiAhPT0gdGhpcy5taWNHZW4pIHJldHVybjtcbiAgICBjb25zdCBjb250ZXh0ID0gdGhpcy5jb250ZXh0ITtcbiAgICBjb25zdCBzdHJlYW0gPSBhd2FpdCBuYXZpZ2F0b3IubWVkaWFEZXZpY2VzLmdldFVzZXJNZWRpYSh7IGF1ZGlvOiB7IGNoYW5uZWxDb3VudDogMSwgLi4ub3B0aW9ucyB9IH0pO1xuICAgIGlmIChnZW4gIT09IHRoaXMubWljR2VuKSB7XG4gICAgICBzdHJlYW0uZ2V0VHJhY2tzKCkuZm9yRWFjaCgodCkgPT4gdC5zdG9wKCkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBsZXQgc291cmNlOiBNZWRpYVN0cmVhbUF1ZGlvU291cmNlTm9kZSB8IG51bGwgPSBudWxsO1xuICAgIGxldCBjYXB0dXJlOiBBdWRpb1dvcmtsZXROb2RlIHwgbnVsbCA9IG51bGw7XG4gICAgdHJ5IHtcbiAgICAgIHNvdXJjZSA9IGNvbnRleHQuY3JlYXRlTWVkaWFTdHJlYW1Tb3VyY2Uoc3RyZWFtKTtcbiAgICAgIGNhcHR1cmUgPSBuZXcgQXVkaW9Xb3JrbGV0Tm9kZShjb250ZXh0LCBcImNhcHR1cmVcIiwgeyBudW1iZXJPZk91dHB1dHM6IDAgfSk7XG4gICAgICBjYXB0dXJlLnBvcnQub25tZXNzYWdlID0gKGUpID0+IHtcbiAgICAgICAgY29uc3QgZnJhbWUgPSBuZXcgSW50MTZBcnJheShlLmRhdGEgYXMgQXJyYXlCdWZmZXIpO1xuICAgICAgICBsZXQgc3VtID0gMDtcbiAgICAgICAgZm9yIChjb25zdCBzIG9mIGZyYW1lKSBzdW0gKz0gcyAqIHM7XG4gICAgICAgIHRoaXMubGV2ZWwgPSBNYXRoLnNxcnQoc3VtIC8gZnJhbWUubGVuZ3RoKSAvIDMyNzY4O1xuICAgICAgICB0aGlzLm9uTWljRnJhbWU/LihmcmFtZSwgdGhpcy5sZXZlbCk7XG4gICAgICB9O1xuICAgICAgc291cmNlLmNvbm5lY3QoY2FwdHVyZSk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBzb3VyY2U/LmRpc2Nvbm5lY3QoKTtcbiAgICAgIGNhcHR1cmU/LnBvcnQuY2xvc2UoKTtcbiAgICAgIHN0cmVhbS5nZXRUcmFja3MoKS5mb3JFYWNoKCh0KSA9PiB0LnN0b3AoKSk7XG4gICAgICB0aHJvdyBlcnI7XG4gICAgfVxuICAgIHRoaXMuc3RyZWFtID0gc3RyZWFtO1xuICAgIHRoaXMubWljT3B0cyA9IHsgLi4ub3B0aW9ucyB9O1xuICAgIHRoaXMub25NaWNGcmFtZSA9IG9uRnJhbWU7XG4gICAgdGhpcy5zb3VyY2UgPSBzb3VyY2U7XG4gICAgdGhpcy5jYXB0dXJlID0gY2FwdHVyZTtcbiAgfVxuXG4gIHN0b3BNaWMoKTogdm9pZCB7XG4gICAgdGhpcy5taWNHZW4rKztcbiAgICB0aGlzLnNvdXJjZT8uZGlzY29ubmVjdCgpO1xuICAgIHRoaXMuY2FwdHVyZT8ucG9ydC5jbG9zZSgpO1xuICAgIHRoaXMuc3RyZWFtPy5nZXRUcmFja3MoKS5mb3JFYWNoKCh0KSA9PiB0LnN0b3AoKSk7XG4gICAgdGhpcy5zb3VyY2UgPSBudWxsO1xuICAgIHRoaXMuY2FwdHVyZSA9IG51bGw7XG4gICAgdGhpcy5zdHJlYW0gPSBudWxsO1xuICAgIHRoaXMubWljT3B0cyA9IG51bGw7XG4gICAgdGhpcy5vbk1pY0ZyYW1lID0gbnVsbDtcbiAgICB0aGlzLmxldmVsID0gMDtcbiAgfVxuXG4gIHBsYXkocGNtNjQ6IHN0cmluZyk6IHZvaWQge1xuICAgIGlmICghdGhpcy5jb250ZXh0IHx8ICF0aGlzLnBsYXliYWNrKSByZXR1cm47XG4gICAgY29uc3Qgc2FtcGxlcyA9IHRvRmxvYXRzKGJhc2U2NFRvQnl0ZXMocGNtNjQpLCAyNDAwMCwgdGhpcy5jb250ZXh0LnNhbXBsZVJhdGUpO1xuICAgIHRoaXMucGxheWJhY2sucG9ydC5wb3N0TWVzc2FnZSh7IHR5cGU6IFwicGxheVwiLCBzYW1wbGVzIH0sIFtzYW1wbGVzLmJ1ZmZlcl0pO1xuICB9XG5cbiAgY3VlKHBjbTY0OiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuY29udGV4dCB8fCAhdGhpcy5wbGF5YmFjaykgcmV0dXJuO1xuICAgIGNvbnN0IHNhbXBsZXMgPSB0b0Zsb2F0cyhiYXNlNjRUb0J5dGVzKHBjbTY0KSwgMjQwMDAsIHRoaXMuY29udGV4dC5zYW1wbGVSYXRlKTtcbiAgICB0aGlzLnBsYXliYWNrLnBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcImN1ZVwiLCBzYW1wbGVzIH0sIFtzYW1wbGVzLmJ1ZmZlcl0pO1xuICB9XG5cbiAgZmx1c2goKTogdm9pZCB7XG4gICAgdGhpcy5wbGF5YmFjaz8ucG9ydC5wb3N0TWVzc2FnZSh7IHR5cGU6IFwiZmx1c2hcIiB9KTtcbiAgfVxuXG4gIHN0b3BQbGF5YmFjaygpOiB2b2lkIHtcbiAgICB0aGlzLnBsYXliYWNrPy5wb3J0LnBvc3RNZXNzYWdlKHsgdHlwZTogXCJzdG9wXCIgfSk7XG4gICAgdGhpcy5xdWV1ZWQgPSAwO1xuICB9XG5cbiAgc3RvcCgpOiB2b2lkIHtcbiAgICB0aGlzLnN0b3BNaWMoKTtcbiAgICB0aGlzLnN0b3BQbGF5YmFjaygpO1xuICB9XG59XG4iLCAiLy8gVGhlIHJlcGxheSB2aWV3OiBhIHJlY29yZGVkIGNhbGwgKGEgdHJhY2UgZnJvbSBhbnkgaG9zdCwgb3IgYSBzY2VuYXJpbykgcnVuIGFnYWluIHRocm91Z2ggdGhlXG4vLyBjb3JlLCBhcyB0aGUgYnVpbGQgdGhhdCByZWNvcmRlZCBpdCBkaWQgYW5kIGFzIHRoZSBsYXRlc3QgZG9lcywgc2lkZSBieSBzaWRlLiBXaGVyZSB0aGV5IHBhcnRcbi8vIGlzIHdoZXJlIGEgY2hhbmdlIGluIHNyYy8gY2hhbmdlZCB3aGF0IHRoZSBjYWxsIGRvZXMgd2l0aCB0aGUgc2FtZSB3b3JkcyBhbmQgdGhlIHNhbWUgbW9kZWwuXG5cbmludGVyZmFjZSBDb3JlIHtcbiAgdmVyc2lvbjogc3RyaW5nO1xuICBjcmVhdGUoY29uZmlnOiBzdHJpbmcsIHQ6IG51bWJlcik6IHN0cmluZztcbiAgcHVzaChpZDogbnVtYmVyLCBldmVudDogc3RyaW5nKTogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgUmVjb3JkaW5nIHsgdmVyc2lvbj86IHN0cmluZzsgY29uZmlnOiB1bmtub3duOyBzdGFydDogbnVtYmVyOyBldmVudHM6IFJlY29yZDxzdHJpbmcsIGFueT5bXSB9XG5cbi8qKiBXaGF0IGEgY29tbWFuZCBvciBldmVudCBsb29rcyBsaWtlIGluIGEgdGltZWxpbmU6IGF1ZGlvIGN1dCBvdXQsIG9uZSBsaW5lLiAqL1xuZnVuY3Rpb24gbGluZShvOiBSZWNvcmQ8c3RyaW5nLCBhbnk+KTogc3RyaW5nIHtcbiAgY29uc3QgdGV4dCA9IEpTT04uc3RyaW5naWZ5KG8pLnJlcGxhY2UoL1wiKGRhdGF8cGNtKVwiOlwiW0EtWmEtejAtOSsvPV17NDAsfVwiL2csICdcIiQxXCI6XCJcdTIwMjZcIicpXG4gICAgLnJlcGxhY2UoL1xcXFxcImRhdGFcXFxcXCI6XFxcXFwiW0EtWmEtejAtOSsvPV17NDAsfVxcXFxcIi9nLCAnXFxcXFwiZGF0YVxcXFxcIjpcXFxcXCJcdTIwMjZcXFxcXCInKTtcbiAgcmV0dXJuIHRleHQubGVuZ3RoID4gNDAwID8gdGV4dC5zbGljZSgwLCA0MDApICsgXCJcdTIwMjZcIiA6IHRleHQ7XG59XG5cbi8qKiBBdWRpbyBhbmQgdGlja3Mgc2F5IG5vdGhpbmcgYSByZWFkZXIgbmVlZHM7IHRoZSByZXN0IGRvZXMuICovXG5mdW5jdGlvbiB0ZWxsaW5nKG86IFJlY29yZDxzdHJpbmcsIGFueT4pOiBib29sZWFuIHtcbiAgaWYgKG8udHlwZSA9PT0gXCJtaWNcIiB8fCBvLnR5cGUgPT09IFwidGlja1wiIHx8IG8udHlwZSA9PT0gXCJwbGF5XCIpIHJldHVybiBmYWxzZTtcbiAgaWYgKG8udHlwZSA9PT0gXCJ3cy5zZW5kXCIgJiYgU3RyaW5nKG8uZGF0YSkuc3RhcnRzV2l0aCgne1wicmVhbHRpbWVJbnB1dFwiOntcImF1ZGlvXCInKSkgcmV0dXJuIGZhbHNlO1xuICBpZiAoby50eXBlID09PSBcIndzLm1lc3NhZ2VcIiAmJiBTdHJpbmcoby5kYXRhKS5pbmNsdWRlcygnXCJpbmxpbmVEYXRhXCInKSAmJiAhU3RyaW5nKG8uZGF0YSkuaW5jbHVkZXMoJ1widHVybkNvbXBsZXRlXCInKSkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuZnVuY3Rpb24gcnVuKGNvcmU6IENvcmUsIHI6IFJlY29yZGluZyk6IHN0cmluZ1tdW10ge1xuICBjb25zdCBjcmVhdGVkID0gSlNPTi5wYXJzZShjb3JlLmNyZWF0ZShKU09OLnN0cmluZ2lmeShyLmNvbmZpZyksIHIuc3RhcnQpKTtcbiAgY29uc3Qgb3V0OiBzdHJpbmdbXVtdID0gW2NyZWF0ZWQuY29tbWFuZHMuZmlsdGVyKHRlbGxpbmcpLm1hcChsaW5lKV07XG4gIGZvciAoY29uc3QgZSBvZiByLmV2ZW50cykgb3V0LnB1c2goKEpTT04ucGFyc2UoY29yZS5wdXNoKGNyZWF0ZWQuaWQsIEpTT04uc3RyaW5naWZ5KGUpKSkgYXMgUmVjb3JkPHN0cmluZywgYW55PltdKS5maWx0ZXIodGVsbGluZykubWFwKGxpbmUpKTtcbiAgcmV0dXJuIG91dDtcbn1cblxuZXhwb3J0IGNsYXNzIFJlcGxheSB7XG4gIHByaXZhdGUgcmVhZG9ubHkgcm9vdDogSFRNTEVsZW1lbnQ7XG4gIHByaXZhdGUgcmVhZG9ubHkgbG9hZDogKHVybD86IHN0cmluZykgPT4gUHJvbWlzZTxDb3JlPjtcblxuICBjb25zdHJ1Y3Rvcihyb290OiBIVE1MRWxlbWVudCwgbG9hZDogKHVybD86IHN0cmluZykgPT4gUHJvbWlzZTxDb3JlPikge1xuICAgIHRoaXMucm9vdCA9IHJvb3Q7XG4gICAgdGhpcy5sb2FkID0gbG9hZDtcbiAgICByb290LmlubmVySFRNTCA9IGBcbiAgICAgIDxoMj5UcmFjZSByZXBsYXk8L2gyPlxuICAgICAgPGRpdiBjbGFzcz1cImJhclwiPjxzZWxlY3QgY2xhc3M9XCJwaWNrXCIgYXJpYS1sYWJlbD1cIlJlY29yZGluZ1wiPjwvc2VsZWN0PjxidXR0b24gdHlwZT1cImJ1dHRvblwiIGNsYXNzPVwicmVmcmVzaFwiIHRpdGxlPVwiUmVmcmVzaCBsaXN0XCIgYXJpYS1sYWJlbD1cIlJlZnJlc2ggbGlzdFwiPlx1MjFCQjwvYnV0dG9uPjxidXR0b24gdHlwZT1cImJ1dHRvblwiIGNsYXNzPVwiZ29cIj5SZXBsYXk8L2J1dHRvbj5cbiAgICAgIDxsYWJlbCBjbGFzcz1cInRvZ2dsZS1hbGxcIj48aW5wdXQgdHlwZT1cImNoZWNrYm94XCIgY2xhc3M9XCJhbGxcIj4gU2hvdyBhdWRpbyBhbmQgdGlja3M8L2xhYmVsPjxzcGFuIGNsYXNzPVwic3VtbWFyeVwiPjwvc3Bhbj48L2Rpdj5cbiAgICAgIDxkaXYgY2xhc3M9XCJ0aW1lbGluZVwiPjwvZGl2PmA7XG4gICAgKHJvb3QucXVlcnlTZWxlY3RvcihcIi5yZWZyZXNoXCIpIGFzIEhUTUxFbGVtZW50KS5vbmNsaWNrID0gKCkgPT4gdm9pZCB0aGlzLmxpc3QoKTtcbiAgICAocm9vdC5xdWVyeVNlbGVjdG9yKFwiLmdvXCIpIGFzIEhUTUxFbGVtZW50KS5vbmNsaWNrID0gKCkgPT4gdm9pZCB0aGlzLnJlcGxheSgpLmNhdGNoKChlcnIpID0+IHRoaXMuc2F5KGBSZXBsYXkgZmFpbGVkOiAke2Vyci5tZXNzYWdlfWApKTtcbiAgICB2b2lkIHRoaXMubGlzdCgpO1xuICB9XG5cbiAgcHJpdmF0ZSBzYXkodGV4dDogc3RyaW5nKSB7XG4gICAgKHRoaXMucm9vdC5xdWVyeVNlbGVjdG9yKFwiLnN1bW1hcnlcIikgYXMgSFRNTEVsZW1lbnQpLnRleHRDb250ZW50ID0gdGV4dDtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgbGlzdCgpIHtcbiAgICBjb25zdCBwaWNrID0gdGhpcy5yb290LnF1ZXJ5U2VsZWN0b3IoXCIucGlja1wiKSBhcyBIVE1MU2VsZWN0RWxlbWVudDtcbiAgICBwaWNrLmlubmVySFRNTCA9IFwiXCI7XG4gICAgY29uc3QgdHJhY2VzOiB7IG5hbWU6IHN0cmluZzsgYnl0ZXM6IG51bWJlciB9W10gPSBhd2FpdCAoYXdhaXQgZmV0Y2goXCIvdHJhY2VzXCIpKS5qc29uKCk7XG4gICAgY29uc3Qgc2NlbmFyaW9zOiBzdHJpbmdbXSA9IGF3YWl0IChhd2FpdCBmZXRjaChcIi9zY2VuYXJpb3NcIikpLmpzb24oKTtcbiAgICBjb25zdCB0cmFjZUdyb3VwID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcIm9wdGdyb3VwXCIpO1xuICAgIHRyYWNlR3JvdXAubGFiZWwgPSBcIlJlY29yZGVkIGNhbGxzXCI7XG4gICAgZm9yIChjb25zdCB0IG9mIHRyYWNlcykgdHJhY2VHcm91cC5hcHBlbmQobmV3IE9wdGlvbihgJHt0Lm5hbWV9ICgke01hdGgucm91bmQodC5ieXRlcyAvIDEwMjQpfSBLQilgLCBgL3RyYWNlcy8ke3QubmFtZX1gKSk7XG4gICAgY29uc3Qgc2NlbmFyaW9Hcm91cCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJvcHRncm91cFwiKTtcbiAgICBzY2VuYXJpb0dyb3VwLmxhYmVsID0gXCJTY2VuYXJpb3NcIjtcbiAgICBmb3IgKGNvbnN0IHMgb2Ygc2NlbmFyaW9zKSBzY2VuYXJpb0dyb3VwLmFwcGVuZChuZXcgT3B0aW9uKHMsIGAvc2NlbmFyaW9zLyR7c30uanNvbmApKTtcbiAgICBwaWNrLmFwcGVuZCh0cmFjZUdyb3VwLCBzY2VuYXJpb0dyb3VwKTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgcmVjb3JkaW5nKHVybDogc3RyaW5nKTogUHJvbWlzZTxSZWNvcmRpbmc+IHtcbiAgICBjb25zdCB0ZXh0ID0gYXdhaXQgKGF3YWl0IGZldGNoKHVybCwgeyBjYWNoZTogXCJuby1zdG9yZVwiIH0pKS50ZXh0KCk7XG4gICAgaWYgKHVybC5lbmRzV2l0aChcIi5qc29uXCIpKSByZXR1cm4gSlNPTi5wYXJzZSh0ZXh0KTtcbiAgICBjb25zdCBbaGVhZGVyLCAuLi5ldmVudHNdID0gdGV4dC50cmltKCkuc3BsaXQoXCJcXG5cIikubWFwKChsKSA9PiBKU09OLnBhcnNlKGwpKTtcbiAgICByZXR1cm4geyAuLi5oZWFkZXIsIGV2ZW50cyB9O1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyByZXBsYXkoKSB7XG4gICAgY29uc3QgdXJsID0gKHRoaXMucm9vdC5xdWVyeVNlbGVjdG9yKFwiLnBpY2tcIikgYXMgSFRNTFNlbGVjdEVsZW1lbnQpLnZhbHVlO1xuICAgIGlmICghdXJsKSByZXR1cm47XG4gICAgY29uc3QgciA9IGF3YWl0IHRoaXMucmVjb3JkaW5nKHVybCk7XG4gICAgY29uc3QgbGF0ZXN0ID0gYXdhaXQgdGhpcy5sb2FkKCk7XG4gICAgbGV0IHJlY29yZGVkOiBDb3JlIHwgbnVsbCA9IG51bGw7XG4gICAgaWYgKHIudmVyc2lvbiAmJiByLnZlcnNpb24gIT09IGxhdGVzdC52ZXJzaW9uKSB7XG4gICAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKGAvdmVyc2lvbnMvJHtyLnZlcnNpb259LmpzYCwgeyBtZXRob2Q6IFwiSEVBRFwiIH0pO1xuICAgICAgaWYgKHJlc3BvbnNlLm9rKSByZWNvcmRlZCA9IGF3YWl0IHRoaXMubG9hZChgL3ZlcnNpb25zLyR7ci52ZXJzaW9ufS5qc2ApO1xuICAgIH1cbiAgICBjb25zdCBub3cgPSBydW4obGF0ZXN0LCByKTtcbiAgICBjb25zdCB0aGVuID0gcmVjb3JkZWQgPyBydW4ocmVjb3JkZWQsIHIpIDogbnVsbDtcbiAgICBjb25zdCBhbGwgPSAodGhpcy5yb290LnF1ZXJ5U2VsZWN0b3IoXCIuYWxsXCIpIGFzIEhUTUxJbnB1dEVsZW1lbnQpLmNoZWNrZWQ7XG4gICAgY29uc3QgdGltZWxpbmUgPSB0aGlzLnJvb3QucXVlcnlTZWxlY3RvcihcIi50aW1lbGluZVwiKSBhcyBIVE1MRWxlbWVudDtcbiAgICB0aW1lbGluZS5pbm5lckhUTUwgPSBcIlwiO1xuICAgIGxldCBmaXJzdCA9IC0xO1xuICAgIGxldCBkaWZmZXIgPSAwO1xuICAgIGNvbnN0IHJvd3M6IEhUTUxFbGVtZW50W10gPSBbXTtcbiAgICBjb25zdCBhZGQgPSAoY2xzOiBzdHJpbmcsIHQ6IHN0cmluZywgdGV4dDogc3RyaW5nKSA9PiB7XG4gICAgICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgICAgcm93LmNsYXNzTmFtZSA9IGByb3cgJHtjbHN9YDtcbiAgICAgIHJvdy5pbm5lckhUTUwgPSBgPHNwYW4gY2xhc3M9XCJ0XCI+JHt0fTwvc3Bhbj5gO1xuICAgICAgY29uc3QgYiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICAgICAgYi5jbGFzc05hbWUgPSBcImJcIjtcbiAgICAgIGIudGV4dENvbnRlbnQgPSB0ZXh0O1xuICAgICAgcm93LmFwcGVuZChiKTtcbiAgICAgIHRpbWVsaW5lLmFwcGVuZChyb3cpO1xuICAgICAgcm93cy5wdXNoKHJvdyk7XG4gICAgICByZXR1cm4gcm93O1xuICAgIH07XG4gICAgY29uc3QgdDAgPSByLnN0YXJ0O1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDw9IHIuZXZlbnRzLmxlbmd0aDsgaSsrKSB7XG4gICAgICBjb25zdCBlID0gaSA9PT0gMCA/IG51bGwgOiByLmV2ZW50c1tpIC0gMV07XG4gICAgICBjb25zdCBub3dPdXQgPSBub3dbaV07XG4gICAgICBjb25zdCB0aGVuT3V0ID0gdGhlbiA/IHRoZW5baV0gOiBub3dPdXQ7XG4gICAgICBjb25zdCBzYW1lID0gbm93T3V0Lmxlbmd0aCA9PT0gdGhlbk91dC5sZW5ndGggJiYgbm93T3V0LmV2ZXJ5KChjLCBqKSA9PiBjID09PSB0aGVuT3V0W2pdKTtcbiAgICAgIGlmICghc2FtZSkgeyBkaWZmZXIrKzsgaWYgKGZpcnN0IDwgMCkgZmlyc3QgPSBpOyB9XG4gICAgICBpZiAoIXNhbWUgfHwgYWxsIHx8IChlICYmIHRlbGxpbmcoZSkpIHx8IG5vd091dC5sZW5ndGggPiAwKSB7XG4gICAgICAgIGlmIChlICYmIChhbGwgfHwgdGVsbGluZyhlKSB8fCAhc2FtZSkpIGFkZChcImluXCIsIChlLnQgLSB0MCkudG9GaXhlZCgyKSwgbGluZShlKSk7XG4gICAgICAgIGNvbnN0IHQgPSBlID8gKGUudCAtIHQwKS50b0ZpeGVkKDIpIDogXCIwLjAwXCI7XG4gICAgICAgIGlmIChzYW1lKSBmb3IgKGNvbnN0IGMgb2Ygbm93T3V0KSBhZGQoXCJvdXRcIiwgdCwgYyk7XG4gICAgICAgIGVsc2Uge1xuICAgICAgICAgIGZvciAoY29uc3QgYyBvZiB0aGVuT3V0KSBhZGQoXCJvdXQgZ29uZVwiLCB0LCBgXHUyMjEyICR7Y31gKTtcbiAgICAgICAgICBmb3IgKGNvbnN0IGMgb2Ygbm93T3V0KSBhZGQoXCJvdXQgbmV3XCIsIHQsIGArICR7Y31gKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgICBjb25zdCB2ZXJzaW9ucyA9IHRoZW4gPyBgcmVjb3JkZWQgYnkgJHtyLnZlcnNpb259LCByZXBsYXllZCBieSBpdCBhbmQgYnkgJHtsYXRlc3QudmVyc2lvbn1gIDogYHJlcGxheWVkIGJ5ICR7bGF0ZXN0LnZlcnNpb259YCArXG4gICAgICAoci52ZXJzaW9uICYmIHIudmVyc2lvbiAhPT0gbGF0ZXN0LnZlcnNpb24gPyBgICh0aGUgcmVjb3JkaW5nJ3MgYnVpbGQgJHtyLnZlcnNpb259IGlzbid0IGtlcHQgaGVyZSlgIDogXCJcIik7XG4gICAgdGhpcy5zYXkoYCR7ci5ldmVudHMubGVuZ3RofSBldmVudHMsICR7dmVyc2lvbnN9LiBgICsgKHRoZW4gPyAoZGlmZmVyID8gYCR7ZGlmZmVyfSBldmVudHMgYW5zd2VyZWQgZGlmZmVyZW50bHksIHRoZSBmaXJzdCBhdCBldmVudCAke2ZpcnN0fS5gIDogXCJCb3RoIGFuc3dlcmVkIGV2ZXJ5IGV2ZW50IHRoZSBzYW1lLlwiKSA6IFwiXCIpKTtcbiAgICBpZiAoZmlyc3QgPj0gMCkgdGltZWxpbmUucXVlcnlTZWxlY3RvcihcIi5nb25lLCAubmV3XCIpPy5zY3JvbGxJbnRvVmlldyh7IGJsb2NrOiBcImNlbnRlclwiIH0pO1xuICB9XG59XG4iLCAiLyoqIE1pbmltYWwgc2Nyb2xsaW5nIHBhbmUgc3VyZmFjZSBzbyBhdXRvLXNjcm9sbCBsb2dpYyBzdGF5cyB0ZXN0YWJsZSB3aXRob3V0IGEgYnJvd3NlciBET00uICovXG5leHBvcnQgaW50ZXJmYWNlIFNjcm9sbFBhbmUge1xuICBzY3JvbGxUb3A6IG51bWJlcjtcbiAgcmVhZG9ubHkgc2Nyb2xsSGVpZ2h0OiBudW1iZXI7XG4gIHJlYWRvbmx5IGNsaWVudEhlaWdodDogbnVtYmVyO1xuICBzY3JvbGxUbz8ob3B0aW9uczogeyB0b3A6IG51bWJlcjsgYmVoYXZpb3I/OiBTY3JvbGxCZWhhdmlvciB9KTogdm9pZDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBBdXRvU2Nyb2xsZXJPcHRpb25zIHtcbiAgLyoqIERpc3RhbmNlIGZyb20gdGhlIGJvdHRvbSAocHgpIHRoYXQgc3RpbGwgY291bnRzIGFzIHBpbm5lZC4gKi9cbiAgcGluVGhyZXNob2xkPzogbnVtYmVyO1xuICAvKiogRGlzdGFuY2UgZnJvbSB0aGUgYm90dG9tIChweCkgcGFzdCB3aGljaCB0aGUganVtcC10by1sYXRlc3QgY29udHJvbCBpcyBzaG93bi4gKi9cbiAganVtcFRocmVzaG9sZD86IG51bWJlcjtcbiAgLyoqIENhbGxlZCB3aGVuZXZlciB0aGUganVtcC10by1sYXRlc3QgY29udHJvbCdzIHZpc2liaWxpdHkgbWF5IGhhdmUgY2hhbmdlZC4gKi9cbiAgb25KdW1wQ2hhbmdlPzogKHNob3c6IGJvb2xlYW4pID0+IHZvaWQ7XG4gIC8qKiBXaGVuIHRydWUgKGZvciBleGFtcGxlIHdoaWxlIHRoZSBlbXB0eSBzdGF0ZSBpcyBzaG93biksIGtlZXAgdGhlIGp1bXAgY29udHJvbCBoaWRkZW4uICovXG4gIGlzRW1wdHk/OiAoKSA9PiBib29sZWFuO1xufVxuXG4vKipcbiAqIEtlZXBzIGEgdHJhbnNjcmlwdCBwYW5lIHBpbm5lZCB0byB0aGUgYm90dG9tIGFzIG1lc3NhZ2VzIHN0cmVhbSBpbiwgd2l0aG91dCBtZWFzdXJpbmdcbiAqIG5lYXItYm90dG9tIGFmdGVyIGFuIGFwcGVuZCBoYXMgYWxyZWFkeSBncm93biBzY3JvbGxIZWlnaHQsIGFuZCB5aWVsZHMgaW1tZWRpYXRlbHkgd2hlblxuICogdGhlIHVzZXIgc2Nyb2xscyB1cCB0byByZWFkIGVhcmxpZXIgbWVzc2FnZXMuXG4gKi9cbmV4cG9ydCBjbGFzcyBBdXRvU2Nyb2xsZXIge1xuICBwcml2YXRlIHJlYWRvbmx5IHBhbmU6IFNjcm9sbFBhbmU7XG4gIHByaXZhdGUgcmVhZG9ubHkgcGluVGhyZXNob2xkOiBudW1iZXI7XG4gIHByaXZhdGUgcmVhZG9ubHkganVtcFRocmVzaG9sZDogbnVtYmVyO1xuICBwcml2YXRlIHJlYWRvbmx5IG9uSnVtcENoYW5nZT86IChzaG93OiBib29sZWFuKSA9PiB2b2lkO1xuICBwcml2YXRlIHJlYWRvbmx5IGlzRW1wdHk/OiAoKSA9PiBib29sZWFuO1xuICBwcml2YXRlIHBpbm5lZCA9IHRydWU7XG4gIHByaXZhdGUganVtcGluZyA9IGZhbHNlO1xuICBwcml2YXRlIGxhc3RTY3JvbGxUb3AgPSAwO1xuXG4gIGNvbnN0cnVjdG9yKHBhbmU6IFNjcm9sbFBhbmUsIG9wdGlvbnM6IEF1dG9TY3JvbGxlck9wdGlvbnMgPSB7fSkge1xuICAgIHRoaXMucGFuZSA9IHBhbmU7XG4gICAgdGhpcy5waW5UaHJlc2hvbGQgPSBvcHRpb25zLnBpblRocmVzaG9sZCA/PyAzMjtcbiAgICB0aGlzLmp1bXBUaHJlc2hvbGQgPSBvcHRpb25zLmp1bXBUaHJlc2hvbGQgPz8gMTIwO1xuICAgIHRoaXMub25KdW1wQ2hhbmdlID0gb3B0aW9ucy5vbkp1bXBDaGFuZ2U7XG4gICAgdGhpcy5pc0VtcHR5ID0gb3B0aW9ucy5pc0VtcHR5O1xuICAgIHRoaXMubGFzdFNjcm9sbFRvcCA9IHBhbmUuc2Nyb2xsVG9wO1xuICB9XG5cbiAgZ2V0IGlzUGlubmVkKCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLnBpbm5lZDtcbiAgfVxuXG4gIHByaXZhdGUgZGlzdGFuY2UoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gTWF0aC5tYXgoMCwgdGhpcy5wYW5lLnNjcm9sbEhlaWdodCAtIHRoaXMucGFuZS5zY3JvbGxUb3AgLSB0aGlzLnBhbmUuY2xpZW50SGVpZ2h0KTtcbiAgfVxuXG4gIHByaXZhdGUgaXNWaXNpYmxlKCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLnBhbmUuY2xpZW50SGVpZ2h0ID4gMDtcbiAgfVxuXG4gIHByaXZhdGUgc25hcFRvQm90dG9tKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5pc1Zpc2libGUoKSkgcmV0dXJuO1xuICAgIHRoaXMucGFuZS5zY3JvbGxUb3AgPSB0aGlzLnBhbmUuc2Nyb2xsSGVpZ2h0O1xuICAgIHRoaXMubGFzdFNjcm9sbFRvcCA9IHRoaXMucGFuZS5zY3JvbGxUb3A7XG4gIH1cblxuICBwcml2YXRlIHVwZGF0ZUp1bXAoKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLm9uSnVtcENoYW5nZSkgcmV0dXJuO1xuICAgIGNvbnN0IGVtcHR5ID0gdGhpcy5pc0VtcHR5Py4oKSA/PyBmYWxzZTtcbiAgICBjb25zdCBzaG93ID0gIWVtcHR5ICYmIHRoaXMuaXNWaXNpYmxlKCkgJiYgIXRoaXMuanVtcGluZyAmJiB0aGlzLmRpc3RhbmNlKCkgPiB0aGlzLmp1bXBUaHJlc2hvbGQ7XG4gICAgdGhpcy5vbkp1bXBDaGFuZ2Uoc2hvdyk7XG4gIH1cblxuICAvKiogQ2FsbCBhZnRlciBjb250ZW50IGlzIGFkZGVkLCB1cGRhdGVkLCBvciByZW1vdmVkIGluIHRoZSBwYW5lLiAqL1xuICBvbkNvbnRlbnQoZm9yY2UgPSBmYWxzZSk6IHZvaWQge1xuICAgIGlmIChmb3JjZSkge1xuICAgICAgdGhpcy5waW5uZWQgPSB0cnVlO1xuICAgICAgdGhpcy5qdW1waW5nID0gZmFsc2U7XG4gICAgfVxuICAgIGlmICh0aGlzLnBpbm5lZCkge1xuICAgICAgaWYgKHRoaXMuanVtcGluZyAmJiB0aGlzLnBhbmUuc2Nyb2xsVG8gJiYgdGhpcy5pc1Zpc2libGUoKSkge1xuICAgICAgICB0aGlzLnBhbmUuc2Nyb2xsVG8oeyB0b3A6IHRoaXMucGFuZS5zY3JvbGxIZWlnaHQsIGJlaGF2aW9yOiBcInNtb290aFwiIH0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy5zbmFwVG9Cb3R0b20oKTtcbiAgICAgIH1cbiAgICB9XG4gICAgdGhpcy51cGRhdGVKdW1wKCk7XG4gIH1cblxuICAvKiogQ2FsbCB3aGVuIHRoZSBwYW5lJ3Mgdmlld3BvcnQgcmVzaXplcyAoYmFycyBhcHBlYXJpbmcsIGtleWJvYXJkLCB0YWIgc3dpdGNoKS4gKi9cbiAgb25SZXNpemUoKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLmlzVmlzaWJsZSgpKSByZXR1cm47XG4gICAgaWYgKHRoaXMucGlubmVkKSB7XG4gICAgICB0aGlzLmp1bXBpbmcgPSBmYWxzZTtcbiAgICAgIHRoaXMuc25hcFRvQm90dG9tKCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMubGFzdFNjcm9sbFRvcCA9IHRoaXMucGFuZS5zY3JvbGxUb3A7XG4gICAgfVxuICAgIHRoaXMudXBkYXRlSnVtcCgpO1xuICB9XG5cbiAgLyoqIENhbGwgZnJvbSB0aGUgcGFuZSdzIHNjcm9sbCBldmVudCBsaXN0ZW5lci4gKi9cbiAgb25TY3JvbGwoKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLmlzVmlzaWJsZSgpKSByZXR1cm47XG4gICAgY29uc3QgdG9wID0gdGhpcy5wYW5lLnNjcm9sbFRvcDtcbiAgICBjb25zdCBkaXN0ID0gdGhpcy5kaXN0YW5jZSgpO1xuICAgIGNvbnN0IG1vdmVkVXAgPSB0b3AgPCB0aGlzLmxhc3RTY3JvbGxUb3A7XG4gICAgdGhpcy5sYXN0U2Nyb2xsVG9wID0gdG9wO1xuXG4gICAgaWYgKGRpc3QgPD0gdGhpcy5waW5UaHJlc2hvbGQpIHtcbiAgICAgIHRoaXMucGlubmVkID0gdHJ1ZTtcbiAgICAgIHRoaXMuanVtcGluZyA9IGZhbHNlO1xuICAgIH0gZWxzZSBpZiAobW92ZWRVcCkge1xuICAgICAgdGhpcy5waW5uZWQgPSBmYWxzZTtcbiAgICAgIHRoaXMuanVtcGluZyA9IGZhbHNlO1xuICAgIH1cbiAgICB0aGlzLnVwZGF0ZUp1bXAoKTtcbiAgfVxuXG4gIC8qKiBDYWxsIGZyb20gdGhlIHBhbmUncyBzY3JvbGxlbmQgZXZlbnQgbGlzdGVuZXIuICovXG4gIG9uU2Nyb2xsRW5kKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5pc1Zpc2libGUoKSB8fCAhdGhpcy5qdW1waW5nKSByZXR1cm47XG4gICAgdGhpcy5qdW1waW5nID0gZmFsc2U7XG4gICAgaWYgKHRoaXMuZGlzdGFuY2UoKSA+IHRoaXMucGluVGhyZXNob2xkKSB0aGlzLnBpbm5lZCA9IGZhbHNlO1xuICAgIHRoaXMudXBkYXRlSnVtcCgpO1xuICB9XG5cbiAgLyoqIENhbGwgb24gdXNlciB3aGVlbC11cCBvciB0b3VjaHN0YXJ0IHNvIGFuIGFjdGl2ZSBzbW9vdGgganVtcCB5aWVsZHMgdG8gdGhlIHVzZXIuICovXG4gIGNhbmNlbEp1bXAoKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLmp1bXBpbmcpIHJldHVybjtcbiAgICB0aGlzLmp1bXBpbmcgPSBmYWxzZTtcbiAgICBpZiAodGhpcy5pc1Zpc2libGUoKSkge1xuICAgICAgY29uc3QgdG9wID0gdGhpcy5wYW5lLnNjcm9sbFRvcDtcbiAgICAgIGlmICh0aGlzLnBhbmUuc2Nyb2xsVG8pIHRoaXMucGFuZS5zY3JvbGxUbyh7IHRvcCwgYmVoYXZpb3I6IFwiaW5zdGFudFwiIH0pO1xuICAgICAgZWxzZSB0aGlzLnBhbmUuc2Nyb2xsVG9wID0gdG9wO1xuICAgICAgdGhpcy5sYXN0U2Nyb2xsVG9wID0gdGhpcy5wYW5lLnNjcm9sbFRvcDtcbiAgICAgIGlmICh0aGlzLmRpc3RhbmNlKCkgPiB0aGlzLnBpblRocmVzaG9sZCkgdGhpcy5waW5uZWQgPSBmYWxzZTtcbiAgICB9XG4gICAgdGhpcy51cGRhdGVKdW1wKCk7XG4gIH1cblxuICAvKiogUmUtcGluIGFuZCBzY3JvbGwgc21vb3RobHkgdG8gdGhlIGJvdHRvbSAodXNlZCBieSB0aGUganVtcC10by1sYXRlc3QgYnV0dG9uKS4gKi9cbiAganVtcFRvQm90dG9tKCk6IHZvaWQge1xuICAgIHRoaXMucGlubmVkID0gdHJ1ZTtcbiAgICBpZiAoIXRoaXMuaXNWaXNpYmxlKCkpIHtcbiAgICAgIHRoaXMudXBkYXRlSnVtcCgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAodGhpcy5kaXN0YW5jZSgpIDw9IHRoaXMucGluVGhyZXNob2xkIHx8ICF0aGlzLnBhbmUuc2Nyb2xsVG8pIHtcbiAgICAgIHRoaXMuanVtcGluZyA9IGZhbHNlO1xuICAgICAgdGhpcy5zbmFwVG9Cb3R0b20oKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5qdW1waW5nID0gdHJ1ZTtcbiAgICAgIHRoaXMubGFzdFNjcm9sbFRvcCA9IHRoaXMucGFuZS5zY3JvbGxUb3A7XG4gICAgICB0aGlzLnBhbmUuc2Nyb2xsVG8oeyB0b3A6IHRoaXMucGFuZS5zY3JvbGxIZWlnaHQsIGJlaGF2aW9yOiBcInNtb290aFwiIH0pO1xuICAgIH1cbiAgICB0aGlzLnVwZGF0ZUp1bXAoKTtcbiAgfVxuXG4gIC8qKiBSZWNvbXB1dGUgcGlubmVkIHN0YXRlIGZyb20gdGhlIGN1cnJlbnQgcG9zaXRpb24gYWZ0ZXIgYSB1c2VyLWRyaXZlbiBsYXlvdXQgY2hhbmdlIChlLmcuIGV4cGFuZGluZyBhIHJlc3VsdCkuICovXG4gIHN5bmNGcm9tUG9zaXRpb24oKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLmlzVmlzaWJsZSgpKSByZXR1cm47XG4gICAgdGhpcy5qdW1waW5nID0gZmFsc2U7XG4gICAgdGhpcy5sYXN0U2Nyb2xsVG9wID0gdGhpcy5wYW5lLnNjcm9sbFRvcDtcbiAgICB0aGlzLnBpbm5lZCA9IHRoaXMuZGlzdGFuY2UoKSA8PSB0aGlzLnBpblRocmVzaG9sZDtcbiAgICB0aGlzLnVwZGF0ZUp1bXAoKTtcbiAgfVxuXG4gIC8qKiBQYXVzZSBhdXRvLXNjcm9sbCBleHBsaWNpdGx5IChlLmcuIHdoZW4gcmV2ZWFsaW5nIGFuIG9sZGVyIHJlc3VsdCBjYXJkKS4gKi9cbiAgdW5waW4oKTogdm9pZCB7XG4gICAgdGhpcy5waW5uZWQgPSBmYWxzZTtcbiAgICB0aGlzLmp1bXBpbmcgPSBmYWxzZTtcbiAgICB0aGlzLnVwZGF0ZUp1bXAoKTtcbiAgfVxufVxuIiwgIi8vIE1haW4tdGhyZWFkIGNvbnRyb2xsZXIgZm9yIHRoZSB3YWtlIHdvcmQgV2ViIFdvcmtlci5cbi8vIFRhZ3MgZXZlcnkgbG9hZCBhbmQgcmVzZXQgd2l0aCBhIG1vbm90b25pYyBnZW5lcmF0aW9uIChgZ2VuYCkgc28gc3RhbGUgZGV0ZWN0aW9ucyBvciByZWFkeSBldmVudHNcbi8vIGFmdGVyIGEgbW9kZWwgc3dpdGNoIG9yIHJlc2V0IGFyZSBpZ25vcmVkLCBhbmQga2VlcHMgYSBzaG9ydCByaW5nIGJ1ZmZlciBvZiByZWNlbnQgZmVkIGNodW5rc1xuLy8gaW5kZXhlZCBieSBgc2VxYCBzbyBhdWRpbyBjYXB0dXJlZCB3aGlsZSB0aGUgd29ya2VyIHdhcyBzY29yaW5nIGlzIHByZXNlcnZlZCBpbiBgaGl0LnRyYWlsaW5nYC5cblxuZXhwb3J0IGludGVyZmFjZSBXYWtlVGVsZW1ldHJ5IHtcbiAgc2NvcmU6IG51bWJlcjtcbiAgcGVhazogbnVtYmVyO1xuICBnYXRlT3BlbjogYm9vbGVhbjtcbiAgZnJhbWVzOiBudW1iZXI7XG4gIHNjb3JlZDogbnVtYmVyO1xuICBpbmZlck1zOiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgV2FrZURldGVjdGlvbkV2ZW50IHtcbiAgc2NvcmU6IG51bWJlcjtcbiAgYXRGcmFtZTogbnVtYmVyO1xuICAvKiogQXVkaW8gY2h1bmtzIHNwb2tlbiBhZnRlciB0aGUgd2FrZSB3b3JkOiB0aGUgdHJpZ2dlcmluZyBjaHVuaydzIHRhaWwgcGx1cyBhbnkgY2h1bmtzIGFscmVhZHkgc2VudCBhZnRlciBpdC4gKi9cbiAgdHJhaWxpbmc6IFVpbnQ4QXJyYXlbXTtcbiAgaW5mZXJNczogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFdha2VDbGllbnRDYWxsYmFja3Mge1xuICBvblJlYWR5PzogKG1vZGVsSWQ6IHN0cmluZywgd2FybXVwTXM6IG51bWJlcikgPT4gdm9pZDtcbiAgb25EZXRlY3RlZDogKGhpdDogV2FrZURldGVjdGlvbkV2ZW50KSA9PiB2b2lkO1xuICBvblRlbGVtZXRyeT86ICh0OiBXYWtlVGVsZW1ldHJ5KSA9PiB2b2lkO1xuICBvbkVycm9yPzogKG1lc3NhZ2U6IHN0cmluZykgPT4gdm9pZDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBXb3JrZXJMaWtlIHtcbiAgb25tZXNzYWdlOiAoKGU6IE1lc3NhZ2VFdmVudDxSZWNvcmQ8c3RyaW5nLCBhbnk+PikgPT4gdm9pZCkgfCBudWxsO1xuICBvbmVycm9yOiAoKGU6IEVycm9yRXZlbnQpID0+IHZvaWQpIHwgbnVsbDtcbiAgcG9zdE1lc3NhZ2UobWVzc2FnZTogdW5rbm93biwgdHJhbnNmZXI/OiBUcmFuc2ZlcmFibGVbXSk6IHZvaWQ7XG4gIHRlcm1pbmF0ZSgpOiB2b2lkO1xufVxuXG4vKiogTWF4IGJ1ZmZlcmVkIHBvc3QtZmVlZCBhdWRpbyAofjEuNSBzIGF0IDIwIG1zIGNodW5rcykgdG8gY292ZXIgd29ya2VyIHNjb3JpbmcgbGF0ZW5jeS4gKi9cbmNvbnN0IFJFQ0VOVF9NQVhfQllURVMgPSBNYXRoLnJvdW5kKDEuNSAqIDMyXzAwMCk7XG5cbmV4cG9ydCBjbGFzcyBXYWtlQ2xpZW50IHtcbiAgcHJpdmF0ZSB3b3JrZXI6IFdvcmtlckxpa2UgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSByZWFkb25seSBjYWxsYmFja3M6IFdha2VDbGllbnRDYWxsYmFja3M7XG4gIHByaXZhdGUgcmVhZG9ubHkgY3JlYXRlV29ya2VyOiAoKSA9PiBXb3JrZXJMaWtlO1xuICBwcml2YXRlIGxvYWRlZE1vZGVsSWQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIGxvYWRpbmdNb2RlbElkOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBjdXJyZW50VGhyZXNob2xkID0gMC43O1xuICBwcml2YXRlIGdlbiA9IDA7XG4gIHByaXZhdGUgc2VxID0gMDtcbiAgcHJpdmF0ZSByZWNlbnQ6IHsgc2VxOiBudW1iZXI7IGJ5dGVzOiBVaW50OEFycmF5IH1bXSA9IFtdO1xuICBwcml2YXRlIHJlY2VudEJ5dGVzID0gMDtcbiAgcmVhZHkgPSBmYWxzZTtcblxuICBjb25zdHJ1Y3RvcihcbiAgICBjYWxsYmFja3M6IFdha2VDbGllbnRDYWxsYmFja3MsXG4gICAgY3JlYXRlV29ya2VyOiAoKSA9PiBXb3JrZXJMaWtlID0gKCkgPT4gbmV3IFdvcmtlcihcIi93YWtlLndvcmtlci5qc1wiLCB7IHR5cGU6IFwibW9kdWxlXCIgfSksXG4gICkge1xuICAgIHRoaXMuY2FsbGJhY2tzID0gY2FsbGJhY2tzO1xuICAgIHRoaXMuY3JlYXRlV29ya2VyID0gY3JlYXRlV29ya2VyO1xuICB9XG5cbiAgcHJpdmF0ZSBjbGVhclJlY2VudCgpOiB2b2lkIHtcbiAgICB0aGlzLnJlY2VudCA9IFtdO1xuICAgIHRoaXMucmVjZW50Qnl0ZXMgPSAwO1xuICB9XG5cbiAgcHJpdmF0ZSBlbnN1cmVXb3JrZXIoKTogV29ya2VyTGlrZSB7XG4gICAgaWYgKHRoaXMud29ya2VyKSByZXR1cm4gdGhpcy53b3JrZXI7XG4gICAgY29uc3Qgd29ya2VyID0gdGhpcy5jcmVhdGVXb3JrZXIoKTtcbiAgICB3b3JrZXIub25tZXNzYWdlID0gKGU6IE1lc3NhZ2VFdmVudDxSZWNvcmQ8c3RyaW5nLCBhbnk+PikgPT4ge1xuICAgICAgY29uc3QgbSA9IGUuZGF0YTtcbiAgICAgIGlmICh0eXBlb2YgbS5nZW4gPT09IFwibnVtYmVyXCIgJiYgbS5nZW4gIT09IHRoaXMuZ2VuKSByZXR1cm47XG4gICAgICBpZiAobS50eXBlID09PSBcInJlYWR5XCIpIHtcbiAgICAgICAgdGhpcy5sb2FkaW5nTW9kZWxJZCA9IG51bGw7XG4gICAgICAgIHRoaXMubG9hZGVkTW9kZWxJZCA9IG0ubW9kZWxJZDtcbiAgICAgICAgdGhpcy5yZWFkeSA9IHRydWU7XG4gICAgICAgIHRoaXMuY2FsbGJhY2tzLm9uUmVhZHk/LihtLm1vZGVsSWQsIG0ud2FybXVwTXMpO1xuICAgICAgfSBlbHNlIGlmIChtLnR5cGUgPT09IFwiZGV0ZWN0ZWRcIikge1xuICAgICAgICBjb25zdCB0cmFpbGluZzogVWludDhBcnJheVtdID0gW107XG4gICAgICAgIGNvbnN0IHJlc3QgPSBuZXcgVWludDhBcnJheShtLnJlc3RCeXRlcyBhcyBBcnJheUJ1ZmZlcik7XG4gICAgICAgIGlmIChyZXN0LmJ5dGVMZW5ndGggPiAwKSB0cmFpbGluZy5wdXNoKHJlc3QpO1xuICAgICAgICBjb25zdCBoaXRTZXEgPSB0eXBlb2YgbS5zZXEgPT09IFwibnVtYmVyXCIgPyBtLnNlcSA6IE51bWJlci5NQVhfU0FGRV9JTlRFR0VSO1xuICAgICAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgdGhpcy5yZWNlbnQpIHtcbiAgICAgICAgICBpZiAoaXRlbS5zZXEgPiBoaXRTZXEpIHRyYWlsaW5nLnB1c2goaXRlbS5ieXRlcyk7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5jbGVhclJlY2VudCgpO1xuICAgICAgICB0aGlzLmNhbGxiYWNrcy5vbkRldGVjdGVkKHtcbiAgICAgICAgICBzY29yZTogbS5zY29yZSxcbiAgICAgICAgICBhdEZyYW1lOiBtLmF0RnJhbWUsXG4gICAgICAgICAgdHJhaWxpbmcsXG4gICAgICAgICAgaW5mZXJNczogbS5pbmZlck1zLFxuICAgICAgICB9KTtcbiAgICAgIH0gZWxzZSBpZiAobS50eXBlID09PSBcInRlbGVtZXRyeVwiKSB7XG4gICAgICAgIHRoaXMuY2FsbGJhY2tzLm9uVGVsZW1ldHJ5Py4oe1xuICAgICAgICAgIHNjb3JlOiBtLnNjb3JlLFxuICAgICAgICAgIHBlYWs6IG0ucGVhayxcbiAgICAgICAgICBnYXRlT3BlbjogbS5nYXRlT3BlbixcbiAgICAgICAgICBmcmFtZXM6IG0uZnJhbWVzLFxuICAgICAgICAgIHNjb3JlZDogbS5zY29yZWQsXG4gICAgICAgICAgaW5mZXJNczogbS5pbmZlck1zLFxuICAgICAgICB9KTtcbiAgICAgIH0gZWxzZSBpZiAobS50eXBlID09PSBcImVycm9yXCIpIHtcbiAgICAgICAgdGhpcy5sb2FkaW5nTW9kZWxJZCA9IG51bGw7XG4gICAgICAgIHRoaXMucmVhZHkgPSBmYWxzZTtcbiAgICAgICAgdGhpcy5jYWxsYmFja3Mub25FcnJvcj8uKFN0cmluZyhtLm1lc3NhZ2UgPz8gXCJ3YWtlIHdvcmtlciBlcnJvclwiKSk7XG4gICAgICB9XG4gICAgfTtcbiAgICB3b3JrZXIub25lcnJvciA9IChlcnIpID0+IHtcbiAgICAgIHRoaXMubG9hZGluZ01vZGVsSWQgPSBudWxsO1xuICAgICAgdGhpcy5yZWFkeSA9IGZhbHNlO1xuICAgICAgdGhpcy5jYWxsYmFja3Mub25FcnJvcj8uKGVyci5tZXNzYWdlIHx8IFwid2FrZSB3b3JrZXIgZmFpbGVkXCIpO1xuICAgIH07XG4gICAgdGhpcy53b3JrZXIgPSB3b3JrZXI7XG4gICAgcmV0dXJuIHdvcmtlcjtcbiAgfVxuXG4gIC8qKiBMb2FkcyAob3Igc3dpdGNoZXMgdG8pIHRoZSBuYW1lZCBtb2RlbDsgaWdub3JlcyBzdGFsZSByZXN1bHRzIGZyb20gZWFybGllciBsb2Fkcy4gKi9cbiAgbG9hZChtb2RlbElkOiBzdHJpbmcsIHRocmVzaG9sZDogbnVtYmVyKTogdm9pZCB7XG4gICAgdGhpcy5jdXJyZW50VGhyZXNob2xkID0gdGhyZXNob2xkO1xuICAgIGNvbnN0IHdvcmtlciA9IHRoaXMuZW5zdXJlV29ya2VyKCk7XG4gICAgaWYgKHRoaXMucmVhZHkgJiYgdGhpcy5sb2FkZWRNb2RlbElkID09PSBtb2RlbElkKSB7XG4gICAgICB3b3JrZXIucG9zdE1lc3NhZ2UoeyB0eXBlOiBcImNvbmZpZ1wiLCB0aHJlc2hvbGQgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICh0aGlzLmxvYWRpbmdNb2RlbElkID09PSBtb2RlbElkKSB7XG4gICAgICB3b3JrZXIucG9zdE1lc3NhZ2UoeyB0eXBlOiBcImNvbmZpZ1wiLCB0aHJlc2hvbGQgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRoaXMuZ2VuKys7XG4gICAgdGhpcy5yZWFkeSA9IGZhbHNlO1xuICAgIHRoaXMubG9hZGluZ01vZGVsSWQgPSBtb2RlbElkO1xuICAgIHRoaXMuY2xlYXJSZWNlbnQoKTtcbiAgICB3b3JrZXIucG9zdE1lc3NhZ2Uoe1xuICAgICAgdHlwZTogXCJsb2FkXCIsXG4gICAgICBnZW46IHRoaXMuZ2VuLFxuICAgICAgbW9kZWxJZCxcbiAgICAgIHVybDogYC93YWtlL21vZGVscy8ke2VuY29kZVVSSUNvbXBvbmVudChtb2RlbElkKX0ub25ueGAsXG4gICAgICB0aHJlc2hvbGQsXG4gICAgICB3YXNtUGF0aHM6IFwiL29ydC9cIixcbiAgICB9KTtcbiAgfVxuXG4gIHNldFRocmVzaG9sZCh0aHJlc2hvbGQ6IG51bWJlcik6IHZvaWQge1xuICAgIHRoaXMuY3VycmVudFRocmVzaG9sZCA9IHRocmVzaG9sZDtcbiAgICB0aGlzLndvcmtlcj8ucG9zdE1lc3NhZ2UoeyB0eXBlOiBcImNvbmZpZ1wiLCB0aHJlc2hvbGQgfSk7XG4gIH1cblxuICBmZWVkKHNhbXBsZXM6IEludDE2QXJyYXkpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMucmVhZHkgfHwgIXRoaXMud29ya2VyKSByZXR1cm47XG4gICAgY29uc3Qgc2VxID0gKyt0aGlzLnNlcTtcbiAgICBjb25zdCBieXRlcyA9IG5ldyBVaW50OEFycmF5KHNhbXBsZXMuYnl0ZUxlbmd0aCk7XG4gICAgYnl0ZXMuc2V0KG5ldyBVaW50OEFycmF5KHNhbXBsZXMuYnVmZmVyLCBzYW1wbGVzLmJ5dGVPZmZzZXQsIHNhbXBsZXMuYnl0ZUxlbmd0aCkpO1xuICAgIHRoaXMucmVjZW50LnB1c2goeyBzZXEsIGJ5dGVzIH0pO1xuICAgIHRoaXMucmVjZW50Qnl0ZXMgKz0gYnl0ZXMuYnl0ZUxlbmd0aDtcbiAgICB3aGlsZSAodGhpcy5yZWNlbnRCeXRlcyA+IFJFQ0VOVF9NQVhfQllURVMgJiYgdGhpcy5yZWNlbnQubGVuZ3RoID4gMSkge1xuICAgICAgdGhpcy5yZWNlbnRCeXRlcyAtPSB0aGlzLnJlY2VudC5zaGlmdCgpIS5ieXRlcy5ieXRlTGVuZ3RoO1xuICAgIH1cbiAgICBjb25zdCBjb3B5ID0gbmV3IEludDE2QXJyYXkoc2FtcGxlcy5sZW5ndGgpO1xuICAgIGNvcHkuc2V0KHNhbXBsZXMpO1xuICAgIHRoaXMud29ya2VyLnBvc3RNZXNzYWdlKHsgdHlwZTogXCJmZWVkXCIsIGdlbjogdGhpcy5nZW4sIHNlcSwgcGNtOiBjb3B5LmJ1ZmZlciB9LCBbY29weS5idWZmZXJdKTtcbiAgfVxuXG4gIHJlc2V0KCk6IHZvaWQge1xuICAgIHRoaXMuY2xlYXJSZWNlbnQoKTtcbiAgICBpZiAoIXRoaXMud29ya2VyIHx8ICF0aGlzLnJlYWR5KSByZXR1cm47XG4gICAgdGhpcy5nZW4rKztcbiAgICB0aGlzLndvcmtlci5wb3N0TWVzc2FnZSh7IHR5cGU6IFwicmVzZXRcIiwgZ2VuOiB0aGlzLmdlbiB9KTtcbiAgfVxuXG4gIGRpc3Bvc2UoKTogdm9pZCB7XG4gICAgdGhpcy5nZW4rKztcbiAgICB0aGlzLnJlYWR5ID0gZmFsc2U7XG4gICAgdGhpcy5sb2FkZWRNb2RlbElkID0gbnVsbDtcbiAgICB0aGlzLmxvYWRpbmdNb2RlbElkID0gbnVsbDtcbiAgICB0aGlzLmNsZWFyUmVjZW50KCk7XG4gICAgaWYgKHRoaXMud29ya2VyKSB7XG4gICAgICB0aGlzLndvcmtlci5wb3N0TWVzc2FnZSh7IHR5cGU6IFwiZGlzcG9zZVwiLCBnZW46IHRoaXMuZ2VuIH0pO1xuICAgICAgdGhpcy53b3JrZXIudGVybWluYXRlKCk7XG4gICAgICB0aGlzLndvcmtlciA9IG51bGw7XG4gICAgfVxuICB9XG5cbiAgZ2V0IG1vZGVsSWQoKTogc3RyaW5nIHwgbnVsbCB7XG4gICAgcmV0dXJuIHRoaXMubG9hZGVkTW9kZWxJZCA/PyB0aGlzLmxvYWRpbmdNb2RlbElkO1xuICB9XG5cbiAgZ2V0IHRocmVzaG9sZCgpOiBudW1iZXIge1xuICAgIHJldHVybiB0aGlzLmN1cnJlbnRUaHJlc2hvbGQ7XG4gIH1cbn1cbiIsICIvLyBUaGUgd2ViIHN1cmZhY2U6IGEgZm91cnRoIGhvc3QgZm9yIHRoZSB2b2ljZSBjb3JlLCBhbmQgYSBwaG9uZS1mcmllbmRseSB3YXkgdG8gdXNlIGl0IGZvciB3b3JrLlxuLy8gSXQgbG9hZHMgdGhlIGRldiBzZXJ2ZXIncyBsYXRlc3QgYnVpbGQgYXQgZWFjaCBjYWxsLCBzbyBhbiBlZGl0IGluIHNyYy8gaXMgbGl2ZSBvbiB0aGUgbmV4dFxuLy8gY2FsbCwgYW5kIGtlZXBzIGV2ZXJ5IGNhbGwgYXMgYSB0cmFjZSB0aGUgcmVwbGF5IHZpZXcgKGFuZCBhbnkgb3RoZXIgaG9zdCkgY2FuIHJ1biBhZ2Fpbi5cbi8vXG4vLyBUaGUgaG9zdCdzIHBhcnQgaXMgc21hbGw6IHRoZSBtaWNyb3Bob25lIGFuZCBzcGVha2VyIChhdWRpby50cyksIHRoZSBtb2RlbCdzIHNvY2tldCB0aHJvdWdoIHRoZVxuLy8gc2VydmVyJ3MgcmVsYXksIEhlcm1lcyBhbmQgVDMgdGhyb3VnaCB0aGUgc2VydmVyLCBhbmQgdGhlIHNjcmVlbi4gVGhlIGNvcmUgZGVjaWRlcyB0aGUgcmVzdC5cbi8vXG4vLyBUeXBpbmcgd2l0aCBubyBjYWxsIG9uIHN0YXJ0cyBhIGNoYXQgaW5zdGVhZDogdGhlIHNhbWUgY29yZSB3aXRoIGBtZWRpdW06IFwidGV4dFwiYCwgd2hvc2UgcmVxdWVzdHNcbi8vIHRvIHRoZSB0ZXh0IG1vZGVsIGdvIHRocm91Z2ggdGhlIHNlcnZlcidzIC9nZW5lcmF0ZS4gVGFza3MsIGZvbGxvdy11cHMgYW5kIHRoZWlyIGNhcmRzIHdvcmsgYXNcbi8vIGluIGEgY2FsbC4gUHJlc3NpbmcgQ2FsbCBlbmRzIHRoZSBjaGF0IGFuZCBjYXJyaWVzIGl0cyBjb252ZXJzYXRpb24gb24gYnkgdm9pY2UuXG5cbmltcG9ydCB7IGNvbW1hbmRJbiB9IGZyb20gXCIuLi9zcmMvY29tbWFuZHMudHNcIjtcbmltcG9ydCB7IENhbGxBdWRpbywgYnl0ZXNUb0Jhc2U2NCB9IGZyb20gXCIuL2F1ZGlvLnRzXCI7XG5pbXBvcnQgeyBSZXBsYXkgfSBmcm9tIFwiLi9yZXBsYXkudHNcIjtcbmltcG9ydCB7IEF1dG9TY3JvbGxlciB9IGZyb20gXCIuL3Njcm9sbC50c1wiO1xuaW1wb3J0IHsgV2FrZUNsaWVudCwgdHlwZSBXYWtlRGV0ZWN0aW9uRXZlbnQsIHR5cGUgV2FrZVRlbGVtZXRyeSB9IGZyb20gXCIuL3dha2VDbGllbnQudHNcIjtcblxuaW50ZXJmYWNlIENvcmUge1xuICB2ZXJzaW9uOiBzdHJpbmc7XG4gIGRlZmF1bHRzKCk6IHN0cmluZztcbiAgY3JlYXRlKGNvbmZpZzogc3RyaW5nLCB0OiBudW1iZXIpOiBzdHJpbmc7XG4gIHB1c2goaWQ6IG51bWJlciwgZXZlbnQ6IHN0cmluZyk6IHN0cmluZztcbiAgdHJhY2UoaWQ6IG51bWJlcik6IHN0cmluZztcbiAgZGlzcG9zZShpZDogbnVtYmVyKTogdm9pZDtcbn1cbnR5cGUgQ29tbWFuZCA9IFJlY29yZDxzdHJpbmcsIGFueT4gJiB7IHR5cGU6IHN0cmluZyB9O1xuaW50ZXJmYWNlIFdha2VNb2RlbEluZm8geyBpZDogc3RyaW5nOyBsYWJlbDogc3RyaW5nIH1cbmludGVyZmFjZSBTZXJ2ZXJDb25maWcgeyByb3V0ZTogc3RyaW5nOyBtb2RlbDogc3RyaW5nOyBjYXB0aW9uc01vZGVsPzogc3RyaW5nOyB0ZXh0TW9kZWw/OiBzdHJpbmc7IHZlcnNpb246IHN0cmluZzsgaGVybWVzOiBib29sZWFuOyB0Mzogc3RyaW5nW10gfCBudWxsOyB3YWtlTW9kZWxzPzogV2FrZU1vZGVsSW5mb1tdIH1cblxuY29uc3QgJCA9IDxUIGV4dGVuZHMgSFRNTEVsZW1lbnQgPSBIVE1MRWxlbWVudD4oaWQ6IHN0cmluZykgPT4gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoaWQpIGFzIFQ7XG5jb25zdCBub3cgPSAoKSA9PiBwZXJmb3JtYW5jZS5ub3coKSAvIDEwMDA7XG5jb25zdCBjaGVja2VkID0gKGlkOiBzdHJpbmcpID0+ICQ8SFRNTElucHV0RWxlbWVudD4oaWQpLmNoZWNrZWQ7XG5cbi8qKiBUaGUgbGF0ZXN0IGJ1aWxkIGZyb20gdGhlIGRldiBzZXJ2ZXIsIGV2YWx1YXRlZCBhZnJlc2g6IGFuIGVkaXQgaW4gc3JjLyBpcyBpbiB0aGUgbmV4dCBjYWxsLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGxvYWRDb3JlKHVybCA9IFwiL3ZvaWNlLWNvcmUuanNcIik6IFByb21pc2U8Q29yZT4ge1xuICBjb25zdCBzb3VyY2UgPSBhd2FpdCAoYXdhaXQgZmV0Y2godXJsLCB7IGNhY2hlOiBcIm5vLXN0b3JlXCIgfSkpLnRleHQoKTtcbiAgY29uc3Qgc2NvcGU6IHsgVm9pY2VDb3JlPzogQ29yZSB9ID0ge307XG4gIG5ldyBGdW5jdGlvbihcImdsb2JhbFRoaXNcIiwgc291cmNlKShzY29wZSk7XG4gIGlmICghc2NvcGUuVm9pY2VDb3JlKSB0aHJvdyBuZXcgRXJyb3IoXCJ0aGUgYnVuZGxlIGRpZG4ndCBkZWZpbmUgVm9pY2VDb3JlXCIpO1xuICByZXR1cm4gc2NvcGUuVm9pY2VDb3JlO1xufVxuXG4vLyBQcmVzZXRzOiBlYWNoIHN1cmZhY2UncyBzZXR0aW5ncyBhcyBpdHMgYXBwIHdvdWxkIHNldCB0aGVtLlxuXG5jb25zdCBGQUtFX1RWID0gW1xuICB7IG5hbWU6IFwidHZfdm9sdW1lXCIsIGRlc2NyaXB0aW9uOiBcIlNldHMgdGhlIGxpdmluZy1yb29tIFRWJ3Mgdm9sdW1lLCAwIHRvIDEwMC5cIiwgcGFyYW1ldGVyczogeyB0eXBlOiBcIk9CSkVDVFwiLCBwcm9wZXJ0aWVzOiB7IGxldmVsOiB7IHR5cGU6IFwiSU5URUdFUlwiIH0gfSwgcmVxdWlyZWQ6IFtcImxldmVsXCJdIH0gfSxcbiAgeyBuYW1lOiBcInR2X3BhdXNlXCIsIGRlc2NyaXB0aW9uOiBcIlBhdXNlcyBvciByZXN1bWVzIHdoYXQncyBwbGF5aW5nIG9uIHRoZSBUVi5cIiwgcGFyYW1ldGVyczogeyB0eXBlOiBcIk9CSkVDVFwiLCBwcm9wZXJ0aWVzOiB7IHBhdXNlOiB7IHR5cGU6IFwiQk9PTEVBTlwiIH0gfSB9IH0sXG5dO1xuXG5jb25zdCBQUkVTRVRTOiBSZWNvcmQ8c3RyaW5nLCBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4gPSB7XG4gIHdlYjogeyBwbGF0Zm9ybTogXCJ3ZWJcIiwgZGV2aWNlOiBcImJyb3dzZXJcIiwgc3RhbmRieUFmdGVyOiAzMCwgaGFuZE9mZjogXCJuYW1lZFwiLCBzdXBlcnZpc2U6IHRydWUsIHZvY2FidWxhcnk6IFtcIkhlcm1lc1wiLCBcIkJlbnRvXCIsIFwiV29vZGhvdXNlXCIsIFwiUGVubnl3b3J0aFwiLCBcIlQzXCJdIH0sXG4gIFwid2ViIHdha2Ugd29yZFwiOiB7XG4gICAgcGxhdGZvcm06IFwid2ViXCIsIGRldmljZTogXCJicm93c2VyXCIsIHN0YW5kYnlBZnRlcjogMjAsIGhhbmdVcEFmdGVyOiAxMjAsIGhhbmRPZmY6IFwibmFtZWRcIiwgc3VwZXJ2aXNlOiB0cnVlLFxuICAgIGF0dGVudGlvbjogeyBtb2RlOiBcIndpbmRvd1wiLCBhZnRlcldha2U6IDgsIHdpbmRvdzogNSwgYWZ0ZXJRdWVzdGlvbjogMTAsIGFmdGVySGFuZE9mZjogMywgYWZ0ZXJBbm5vdW5jZW1lbnQ6IDAgfSxcbiAgICB2b2NhYnVsYXJ5OiBbXCJIZXJtZXNcIiwgXCJCZW50b1wiLCBcIldvb2Rob3VzZVwiLCBcIlBlbm55d29ydGhcIiwgXCJUM1wiXSxcbiAgfSxcbiAgYW5kcm9pZDogeyBwbGF0Zm9ybTogXCJBbmRyb2lkXCIsIGRldmljZTogXCJwaG9uZVwiLCBzdGFuZGJ5QWZ0ZXI6IDIwIH0sXG4gIFwiYW5kcm9pZCB3YWtlIHdvcmRcIjogeyBwbGF0Zm9ybTogXCJBbmRyb2lkXCIsIGRldmljZTogXCJwaG9uZVwiLCBzdGFuZGJ5QWZ0ZXI6IDIwLCBoYW5nVXBBZnRlcjogMTUgfSxcbiAgbWFjb3M6IHsgcGxhdGZvcm06IFwibWFjT1NcIiwgZGV2aWNlOiBcIk1hY1wiLCBzdGFuZGJ5QWZ0ZXI6IDIwIH0sXG4gIGVjaG86IHtcbiAgICBwbGF0Zm9ybTogXCJFY2hvXCIsIGRldmljZTogXCJzcGVha2VyXCIsIGhhbmdVcEFmdGVyOiA2LCBzdGFuZGJ5QWZ0ZXI6IDgsIGVhcmNvbnM6IHRydWUsIHZvY2FidWxhcnk6IFtcIkhlcm1lc1wiLCBcIkJlbnRvXCIsIFwiV29vZGhvdXNlXCJdLFxuICAgIG1pYzogeyB3aGlsZVNwZWFraW5nOiBcIndha2VcIiwgZ2FpbkRiOiAwIH0sIGhvc3RUb29sczogRkFLRV9UVixcbiAgfSxcbn07XG5cbi8vIFN0YXRlLlxuXG5jb25zdCBhdWRpbyA9IG5ldyBDYWxsQXVkaW8oKTtcbmxldCBzZXJ2ZXI6IFNlcnZlckNvbmZpZztcbmxldCBjb3JlOiBDb3JlIHwgbnVsbCA9IG51bGw7XG5sZXQgY2FsbElkID0gMDtcbmxldCBjYWxsTmFtZSA9IFwiXCI7XG5sZXQgdGlja2VyID0gMDtcbmxldCB0cmFjZVRpbWVyID0gMDtcbmxldCBzdGFydGVkQXQgPSBub3coKTtcbmNvbnN0IHNvY2tldHMgPSBuZXcgTWFwPG51bWJlciwgV2ViU29ja2V0PigpO1xuLyoqIFRoZSBzb2NrZXRzIHRvIHRoZSB0cmFuc2NyaXB0aW9uIG1vZGVsOiB0aGVpciBhdWRpbyBpcyB0aGUgbW9kZWwncyBhZ2Fpbiwgc28gaXQgaXNuJ3QgY291bnRlZCBvciBsb2dnZWQgdHdpY2UuICovXG5jb25zdCBjYXB0aW9uU29ja2V0cyA9IG5ldyBTZXQ8bnVtYmVyPigpO1xuY29uc3QgcnVucyA9IG5ldyBNYXA8c3RyaW5nLCB7IGFib3J0OiBBYm9ydENvbnRyb2xsZXI7IGFnZW50OiBzdHJpbmc7IHRhc2tJZDogc3RyaW5nIH0+KCk7XG5pbnRlcmZhY2UgVGFza1ZpZXcgeyBjOiBDb21tYW5kOyBzaW5jZTogbnVtYmVyOyBlbmRlZDogbnVtYmVyIHwgbnVsbDsgdGhyZWFkPzogc3RyaW5nOyByZXN1bHQ/OiBIVE1MRWxlbWVudDsgYXBwcm92YWw/OiB7IGNvbW1hbmQ6IHN0cmluZyB9IH1cbmNvbnN0IHRhc2tzID0gbmV3IE1hcDxzdHJpbmcsIFRhc2tWaWV3PigpO1xubGV0IGVhcmxpZXJBY3RpdmVDb3VudCA9IDA7XG5sZXQgZWFybGllcldhaXRpbmdDb3VudCA9IDA7XG5sZXQgY291bnRzID0geyBtaWM6IDAsIHBsYXk6IDAsIHNlbnQ6IDAgfTtcbmxldCBmYWtlVHZMZXZlbCA9IDE1O1xubGV0IGNvcmVTdGF0dXMgPSBcImlkbGVcIjtcbmxldCBtdXRlZCA9IGZhbHNlO1xubGV0IGhvbGRpbmcgPSBmYWxzZTtcbmxldCB3YWtlTG9jazogeyByZWxlYXNlKCk6IFByb21pc2U8dm9pZD4gfSB8IG51bGwgPSBudWxsO1xuLyoqIFdha2Ugd29yZCBsb29wIHN0YXRlOiBhcm1lZCBiZXR3ZWVuIGNhbGxzLCByZXF1ZXN0ZWQgYnkgY29yZSB3aGlsZSBkb3JtYW50L3NwZWFraW5nLCBvciBtaWQtaGFuZG9mZi4gKi9cbmxldCB3YWtlQXJtZWQgPSBmYWxzZTtcbmxldCBhcm1HZW4gPSAwO1xubGV0IGNvcmVXYW50c1dha2UgPSBmYWxzZTtcbmxldCB3YWtlTG9hZGluZyA9IGZhbHNlO1xubGV0IHdha2VTdGFydGluZyA9IGZhbHNlO1xubGV0IHN0YXJ0aW5nQ2FsbCA9IGZhbHNlO1xubGV0IG9wZW5pbmdDaHVua3M6IFVpbnQ4QXJyYXlbXSA9IFtdO1xubGV0IG9wZW5pbmdCeXRlcyA9IDA7XG5jb25zdCBPUEVOSU5HX01BWF9CWVRFUyA9IDEwICogMzJfMDAwO1xubGV0IHdha2VMYXN0VGVsOiBXYWtlVGVsZW1ldHJ5IHwgbnVsbCA9IG51bGw7XG4vKiogV2hhdCB0aGUgc2Vzc2lvbiBvbiBzY3JlZW4gaXM6IGEgdm9pY2UgY2FsbCwgb3IgYSB0eXBlZCBjaGF0ICh0aGUgY29yZSdzIG1lZGl1bSBcInRleHRcIikuICovXG5sZXQgbWVkaXVtOiBcInZvaWNlXCIgfCBcInRleHRcIiA9IFwidm9pY2VcIjtcbi8qKiBBIGNoYXQncyBtb2RlbCBpcyB3cml0aW5nIGl0cyBhbnN3ZXIuICovXG5sZXQgdGhpbmtpbmcgPSBmYWxzZTtcbi8qKiBBIGNoYXQncyByZXF1ZXN0cyB0byB0aGUgdGV4dCBtb2RlbCB0aGF0IGFyZSB1bmRlciB3YXkuICovXG5jb25zdCByZXF1ZXN0cyA9IG5ldyBNYXA8bnVtYmVyLCBBYm9ydENvbnRyb2xsZXI+KCk7XG4vKiogVGhlIGxhc3Qgc2Vzc2lvbiB3aW5kaW5nIGRvd24gKGl0cyB0cmFjZSBzYXZlZCwgdGhlIGNvcmUncyBjYWxsIGRpc3Bvc2VkKTogdGhlIG5leHQgc3RhcnRzIGFmdGVyIGl0LiAqL1xubGV0IGVuZGluZzogUHJvbWlzZTx2b2lkPiA9IFByb21pc2UucmVzb2x2ZSgpO1xuXG4vLyBUaGUgY29udmVyc2F0aW9uLCBrZXB0IHNvIGEgbmV3IGNhbGwgY2FuIGNhcnJ5IG9uIGZyb20gaXQgKHRoZSBjb3JlJ3MgYGhpc3RvcnlgLCByZWNhcHBlZCB0byB0aGUgbW9kZWwpLlxuaW50ZXJmYWNlIENoYXRMaW5lIHsgcm9sZTogXCJ1c2VyXCIgfCBcImFzc2lzdGFudFwiOyBzcGVha2VyPzogc3RyaW5nOyB0ZXh0OiBzdHJpbmcgfVxuY29uc3QgSElTVE9SWSA9IFwidm9pY2UuaGlzdG9yeVwiO1xuY29uc3QgSElTVE9SWV9NQVhfQUdFID0gMTIgKiAzNjAwICogMTAwMDtcbmxldCBjaGF0OiBDaGF0TGluZVtdID0gW107XG4vKiogVGhlIGNvcmUncyBudW1iZXIgZm9yIHRoZSBsaW5lIHRoZSBsYXN0IHdvcmRzIHdlcmUgcmVtZW1iZXJlZCBvbiwgdW50aWwgc29tZXRoaW5nIGVsc2UgaXMuICovXG5sZXQgbGFzdExpbmU6IG51bWJlciB8IG51bGwgPSBudWxsO1xuXG5mdW5jdGlvbiByZW1lbWJlcihyb2xlOiBcInVzZXJcIiB8IFwiYXNzaXN0YW50XCIsIHRleHQ6IHN0cmluZywgc3BlYWtlcj86IHN0cmluZywgam9pbiA9IGZhbHNlKSB7XG4gIGNvbnN0IGxhc3QgPSBjaGF0LmF0KC0xKTtcbiAgaWYgKGpvaW4gJiYgbGFzdCAmJiBsYXN0LnJvbGUgPT09IHJvbGUgJiYgbGFzdC5zcGVha2VyID09PSBzcGVha2VyKSBsYXN0LnRleHQgKz0gdGV4dDtcbiAgZWxzZSBjaGF0LnB1c2goc3BlYWtlciA/IHsgcm9sZSwgc3BlYWtlciwgdGV4dCB9IDogeyByb2xlLCB0ZXh0IH0pO1xuICBpZiAoY2hhdC5sZW5ndGggPiAyMDApIGNoYXQuc3BsaWNlKDAsIGNoYXQubGVuZ3RoIC0gMjAwKTtcbiAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oSElTVE9SWSwgSlNPTi5zdHJpbmdpZnkoeyBhdDogRGF0ZS5ub3coKSwgY2hhdCB9KSk7XG59XG5cbmZ1bmN0aW9uIHNhdmVkSGlzdG9yeSgpOiBDaGF0TGluZVtdIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBzYXZlZCA9IEpTT04ucGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oSElTVE9SWSkgPz8gXCJudWxsXCIpO1xuICAgIHJldHVybiBzYXZlZCAmJiBEYXRlLm5vdygpIC0gc2F2ZWQuYXQgPCBISVNUT1JZX01BWF9BR0UgJiYgQXJyYXkuaXNBcnJheShzYXZlZC5jaGF0KSA/IHNhdmVkLmNoYXQgOiBbXTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG59XG5cbi8qKiBUd28tbm90ZSBjaGltZSwgUENNMTYgbW9ubyBhdCAyNCBrSHosIGJhc2U2NC4gKi9cbmZ1bmN0aW9uIHR3b05vdGVUb25lKGYxOiBudW1iZXIsIGYyOiBudW1iZXIsIG5vdGVTZWM6IG51bWJlciwgYW1wOiBudW1iZXIpOiBzdHJpbmcge1xuICBjb25zdCByYXRlID0gMjQwMDAsIG4gPSBNYXRoLnJvdW5kKHJhdGUgKiBub3RlU2VjICogMiksIGhhbGYgPSBNYXRoLnJvdW5kKHJhdGUgKiBub3RlU2VjKSwgb3V0ID0gbmV3IEludDE2QXJyYXkobik7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgbjsgaSsrKSB7XG4gICAgY29uc3QgZmlyc3QgPSBpIDwgaGFsZjtcbiAgICBjb25zdCB0ID0gaSAvIHJhdGUsIGYgPSBmaXJzdCA/IGYxIDogZjIsIGxvY2FsID0gZmlyc3QgPyB0IDogdCAtIG5vdGVTZWM7XG4gICAgY29uc3QgZW52ID0gTWF0aC5taW4oMSwgbG9jYWwgKiA2MCwgKG5vdGVTZWMgLSBsb2NhbCkgKiA2MCk7XG4gICAgb3V0W2ldID0gTWF0aC5yb3VuZChNYXRoLnNpbigyICogTWF0aC5QSSAqIGYgKiB0KSAqIE1hdGgubWF4KDAsIGVudikgKiBhbXApO1xuICB9XG4gIHJldHVybiBieXRlc1RvQmFzZTY0KG5ldyBVaW50OEFycmF5KG91dC5idWZmZXIpKTtcbn1cblxuLyoqIFR3byByaXNpbmcgbm90ZXM6IHNvbWV0aGluZyBvbiB0aGUgc2NyZWVuIG5lZWRzIHRoZSB1c2VyLiAqL1xuY29uc3QgQVBQUk9WQUxfVE9ORSA9IHR3b05vdGVUb25lKDY2MCwgODgwLCAwLjE2LCA2MDAwKTtcbi8qKiBDcmlzcCByaXNpbmcgY2hpbWU6IHRoZSB3YWtlIHdvcmQgZmlyZWQgKHN0YXJ0IHNpZ25hbCkuICovXG5jb25zdCBXQUtFX1RPTkUgPSB0d29Ob3RlVG9uZSg1ODcuMzMsIDg4MCwgMC4xMSwgNTUwMCk7XG4vKiogU29mdCBmYWxsaW5nIGNoaW1lOiB0aGUgYXR0ZW50aW9uIHdpbmRvdyBjbG9zZWQgYW5kIHRoZSBjYWxsIHdlbnQgZG9ybWFudCAoZW5kIHNpZ25hbCkuICovXG5jb25zdCBTTEVFUF9UT05FID0gdHdvTm90ZVRvbmUoNjU5LjI1LCA0OTMuODgsIDAuMTEsIDM0MDApO1xuXG4vLyBMYXRlbmN5OiB0aGUgbmV0d29yaydzIHJvdW5kIHRyaXAsIGFuZCBob3cgbG9uZyBhZnRlciB0aGUgdXNlciBzdG9wcyB0YWxraW5nIHRoZSByZXBseSBzdGFydHMuXG5jb25zdCBtZXRyaWNzID0geyBydHQ6IFtdIGFzIG51bWJlcltdLCByZXBseTogW10gYXMgbnVtYmVyW10sIGxhc3RWb2ljZTogMCwgbGFzdFBsYXk6IDAsIHJlcGxpZWQ6IHRydWUgfTtcblxuZnVuY3Rpb24gbWVkaWFuKHhzOiBudW1iZXJbXSk6IG51bWJlciB8IG51bGwge1xuICBpZiAoeHMubGVuZ3RoID09PSAwKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgcyA9IFsuLi54c10uc29ydCgoYSwgYikgPT4gYSAtIGIpO1xuICByZXR1cm4gc1tNYXRoLmZsb29yKHMubGVuZ3RoIC8gMildO1xufVxuXG5mdW5jdGlvbiBzaG93TWV0cmljcygpIHtcbiAgY29uc3QgcGFydHM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IHJ0dCA9IG1lZGlhbihtZXRyaWNzLnJ0dCk7XG4gIGlmIChydHQgIT0gbnVsbCkgcGFydHMucHVzaChgJHtNYXRoLnJvdW5kKHJ0dCAqIDEwMDApfSBtc2ApO1xuICBjb25zdCByZXBseSA9IG1lZGlhbihtZXRyaWNzLnJlcGx5KTtcbiAgaWYgKHJlcGx5ICE9IG51bGwpIHBhcnRzLnB1c2goYHJlcGx5ICR7bWV0cmljcy5yZXBseS5hdCgtMSkhLnRvRml4ZWQoMSl9cyAoJHtyZXBseS50b0ZpeGVkKDEpfXMgbWVkKWApO1xuICBjb25zdCBvdXQgPSBhdWRpby5vdXRwdXRMYXRlbmN5O1xuICBpZiAob3V0ICE9IG51bGwpIHBhcnRzLnB1c2goYGF1ZGlvICR7TWF0aC5yb3VuZChvdXQgKiAxMDAwKX0gbXNgKTtcbiAgbGV0IGJ1ZmZlcmVkID0gMDtcbiAgZm9yIChjb25zdCB3cyBvZiBzb2NrZXRzLnZhbHVlcygpKSBidWZmZXJlZCArPSB3cy5idWZmZXJlZEFtb3VudDtcbiAgaWYgKGJ1ZmZlcmVkID4gMzJfMDAwKSBwYXJ0cy5wdXNoKGB1cGxvYWQgKyR7KGJ1ZmZlcmVkIC8gMzJfMDAwKS50b0ZpeGVkKDEpfXNgKTtcbiAgJChcIm1ldHJpY3NcIikudGV4dENvbnRlbnQgPSBwYXJ0cy5qb2luKFwiIFx1MDBCNyBcIik7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHBpbmcoKSB7XG4gIGNvbnN0IHQgPSBub3coKTtcbiAgdHJ5IHtcbiAgICBhd2FpdCBmZXRjaChcIi9waW5nXCIsIHsgY2FjaGU6IFwibm8tc3RvcmVcIiB9KTtcbiAgICBtZXRyaWNzLnJ0dC5wdXNoKG5vdygpIC0gdCk7XG4gICAgaWYgKG1ldHJpY3MucnR0Lmxlbmd0aCA+IDEyKSBtZXRyaWNzLnJ0dC5zaGlmdCgpO1xuICB9IGNhdGNoIHt9XG4gIHNob3dNZXRyaWNzKCk7XG59XG5cbi8vIFRoZW1lLlxuXG5mdW5jdGlvbiBhcHBseVRoZW1lKGNob2ljZTogc3RyaW5nKSB7XG4gIGNvbnN0IHJvb3QgPSBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQ7XG4gIGlmIChjaG9pY2UgPT09IFwiZGFya1wiIHx8IGNob2ljZSA9PT0gXCJsaWdodFwiKSByb290LmRhdGFzZXQudGhlbWUgPSBjaG9pY2U7XG4gIGVsc2UgZGVsZXRlIHJvb3QuZGF0YXNldC50aGVtZTtcbiAgY29uc3QgZGFyayA9IGNob2ljZSA9PT0gXCJkYXJrXCIgfHwgKGNob2ljZSAhPT0gXCJsaWdodFwiICYmIG1hdGNoTWVkaWEoXCIocHJlZmVycy1jb2xvci1zY2hlbWU6IGRhcmspXCIpLm1hdGNoZXMpO1xuICBjb25zdCBtZXRhID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJ0aGVtZS1jb2xvclwiKTtcbiAgaWYgKG1ldGEpIG1ldGEuc2V0QXR0cmlidXRlKFwiY29udGVudFwiLCBkYXJrID8gXCIjMGUwZjBmXCIgOiBcIiNmNmY1ZjBcIik7XG4gIGZvciAoY29uc3QgYnRuIG9mIEFycmF5LmZyb20oZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MQnV0dG9uRWxlbWVudD4oXCIjdGhlbWUtcGlja2VyIGJ1dHRvblwiKSkpIHtcbiAgICBidG4uY2xhc3NMaXN0LnRvZ2dsZShcIm9uXCIsIGJ0bi5kYXRhc2V0LnRoZW1lID09PSAoY2hvaWNlIHx8IFwic3lzdGVtXCIpKTtcbiAgfVxufVxuXG4vLyBUaGUgc2NyZWVuLlxuXG5mdW5jdGlvbiBzZXRDYWxsQnV0dG9uKGxpdmU6IGJvb2xlYW4pIHtcbiAgY29uc3QgYnRuID0gJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJjYWxsXCIpO1xuICBidG4uY2xhc3NMaXN0LnRvZ2dsZShcImxpdmVcIiwgbGl2ZSk7XG4gIGNvbnN0IGxhYmVsID0gYnRuLnF1ZXJ5U2VsZWN0b3IoXCIuY2FsbC1sYWJlbFwiKTtcbiAgaWYgKGxhYmVsKSBsYWJlbC50ZXh0Q29udGVudCA9IGxpdmUgPyBcIkhhbmcgdXBcIiA6IFwiQ2FsbFwiO1xufVxuXG5mdW5jdGlvbiBzeW5jUmVzdW1lQnV0dG9ucyhzaG93OiBib29sZWFuKSB7XG4gICQoXCJyZXN1bWVcIikuaGlkZGVuID0gIXNob3c7XG4gICQoXCJoZXJvLXJlc3VtZVwiKS5oaWRkZW4gPSAhc2hvdztcbn1cblxuZnVuY3Rpb24gcGFyc2VQcmVmaXgodGV4dDogc3RyaW5nKTogeyBtb2RlOiBcImhlcm1lc1wiIHwgXCJ0M1wiIHwgbnVsbDsgcmVzdDogc3RyaW5nIH0ge1xuICBjb25zdCBtID0gdGV4dC5tYXRjaCgvXlxcLyh0M3xjb2RlfGh8aGVybWVzKVxccysoLiopJC9pcyk7XG4gIGlmICghbSkgcmV0dXJuIHsgbW9kZTogbnVsbCwgcmVzdDogdGV4dCB9O1xuICByZXR1cm4geyBtb2RlOiAvXih0M3xjb2RlKSQvaS50ZXN0KG1bMV0pID8gXCJ0M1wiIDogXCJoZXJtZXNcIiwgcmVzdDogbVsyXS50cmltKCkgfTtcbn1cblxuZnVuY3Rpb24gc3luY0NvbXBvc2VyKCkge1xuICBjb25zdCBpbnB1dCA9ICQ8SFRNTElucHV0RWxlbWVudD4oXCJ0ZXh0XCIpO1xuICBjb25zdCB0cmltbWVkID0gaW5wdXQudmFsdWUudHJpbSgpO1xuICAkKFwic2VuZGJ0blwiKS5jbGFzc0xpc3QudG9nZ2xlKFwicmVhZHlcIiwgdHJpbW1lZC5sZW5ndGggPiAwKTtcbiAgY29uc3QgcGFyc2VkID0gcGFyc2VQcmVmaXgodHJpbW1lZCk7XG4gICQoXCJtb2RlLXdyYXBcIikuZGF0YXNldC5tb2RlID0gcGFyc2VkLm1vZGUgPz8gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJtb2RlXCIpLnZhbHVlO1xufVxuXG5mdW5jdGlvbiBmb3JtYXRDbG9jayhzZWNvbmRzOiBudW1iZXIpOiBzdHJpbmcge1xuICBjb25zdCB0b3RhbCA9IE1hdGgubWF4KDAsIE1hdGguZmxvb3Ioc2Vjb25kcykpO1xuICBjb25zdCBoID0gTWF0aC5mbG9vcih0b3RhbCAvIDM2MDApO1xuICBjb25zdCBtID0gTWF0aC5mbG9vcigodG90YWwgJSAzNjAwKSAvIDYwKTtcbiAgY29uc3QgcyA9IHRvdGFsICUgNjA7XG4gIGNvbnN0IHBhZCA9IChuOiBudW1iZXIpID0+IFN0cmluZyhuKS5wYWRTdGFydCgyLCBcIjBcIik7XG4gIHJldHVybiBoID4gMCA/IGAke2h9OiR7cGFkKG0pfToke3BhZChzKX1gIDogYCR7cGFkKG0pfToke3BhZChzKX1gO1xufVxuXG5jb25zdCBWSVpfV0VJR0hUUyA9IFswLjQ4LCAwLjg2LCAxLjAsIDAuNzgsIDAuNDRdO1xuZnVuY3Rpb24gdXBkYXRlVmlzdWFsaXplcihtb2RlOiBzdHJpbmcsIGxldmVsOiBudW1iZXIpIHtcbiAgY29uc3Qgdml6ID0gJChcInZpelwiKTtcbiAgdml6LmRhdGFzZXQubW9kZSA9IG1vZGU7XG4gIGNvbnN0IGJhcnMgPSB2aXouY2hpbGRyZW47XG4gIGlmIChtb2RlID09PSBcImxpc3RlbmluZ1wiIHx8IG1vZGUgPT09IFwid29ya2luZ1wiKSB7XG4gICAgY29uc3QgZW5lcmd5ID0gTWF0aC5taW4oMSwgbGV2ZWwgKiAxNCk7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBiYXJzLmxlbmd0aDsgaSsrKSB7XG4gICAgICBjb25zdCBoID0gMC4yNCArIGVuZXJneSAqIFZJWl9XRUlHSFRTW2ldICogMC43NjtcbiAgICAgIChiYXJzW2ldIGFzIEhUTUxFbGVtZW50KS5zdHlsZS50cmFuc2Zvcm0gPSBgc2NhbGVZKCR7aC50b0ZpeGVkKDIpfSlgO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGJhcnMubGVuZ3RoOyBpKyspIChiYXJzW2ldIGFzIEhUTUxFbGVtZW50KS5zdHlsZS50cmFuc2Zvcm0gPSBcIlwiO1xuICB9XG59XG5cbi8qKiBBIHN5c3RlbSBub3RpZmljYXRpb24gd2hpbGUgdGhlIHBhZ2UgaXMgaGlkZGVuOiBhIHRhc2sgZmluaXNoZWQsIG9yIG9uZSBuZWVkcyB0aGUgdXNlci4gKi9cbmZ1bmN0aW9uIG5vdGlmeSh0aXRsZTogc3RyaW5nLCBib2R5OiBzdHJpbmcpIHtcbiAgaWYgKCFkb2N1bWVudC5oaWRkZW4gfHwgIShcIk5vdGlmaWNhdGlvblwiIGluIHdpbmRvdykgfHwgTm90aWZpY2F0aW9uLnBlcm1pc3Npb24gIT09IFwiZ3JhbnRlZFwiKSByZXR1cm47XG4gIHRyeSB7XG4gICAgY29uc3QgbiA9IG5ldyBOb3RpZmljYXRpb24odGl0bGUsIHsgYm9keTogYm9keS5zbGljZSgwLCAxODApLCBpY29uOiBcIi93ZWIvaWNvbnMvaWNvbi0xOTIucG5nXCIsIHRhZzogdGl0bGUgfSk7XG4gICAgbi5vbmNsaWNrID0gKCkgPT4geyB3aW5kb3cuZm9jdXMoKTsgbi5jbG9zZSgpOyB9O1xuICB9IGNhdGNoIHtcbiAgICAvLyBQaG9uZXMgd2FudCBub3RpZmljYXRpb25zIGZyb20gYSBzZXJ2aWNlIHdvcmtlcjsgdGhlIHBhZ2UgaGFzIG5vbmUuXG4gIH1cbn1cblxuZnVuY3Rpb24gdG9hc3QodGV4dDogc3RyaW5nKSB7XG4gIGNvbnN0IHQgPSAkKFwidG9hc3RcIik7XG4gIHQudGV4dENvbnRlbnQgPSB0ZXh0O1xuICB0LmNsYXNzTGlzdC5hZGQoXCJvblwiKTtcbiAgY2xlYXJUaW1lb3V0KCh0b2FzdCBhcyBhbnkpLnRpbWVyKTtcbiAgKHRvYXN0IGFzIGFueSkudGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHQuY2xhc3NMaXN0LnJlbW92ZShcIm9uXCIpLCAxODAwKTtcbn1cblxuZnVuY3Rpb24gbG9nKGtpbmQ6IHN0cmluZywgdGV4dDogc3RyaW5nLCBjbHMgPSBcIlwiKSB7XG4gIGNvbnN0IHBhbmUgPSAkKFwibG9nXCIpO1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gYHJvdyAke2Nsc31gO1xuICByb3cuaW5uZXJIVE1MID0gYDxzcGFuIGNsYXNzPVwidFwiPiR7KG5vdygpIC0gc3RhcnRlZEF0KS50b0ZpeGVkKDIpfTwvc3Bhbj48c3BhbiBjbGFzcz1cImtcIj4ke2tpbmR9PC9zcGFuPmA7XG4gIGNvbnN0IGJvZHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgYm9keS5jbGFzc05hbWUgPSBcImJcIjtcbiAgYm9keS50ZXh0Q29udGVudCA9IHRleHQ7XG4gIHJvdy5hcHBlbmQoYm9keSk7XG4gIGNvbnN0IHN0aWNrID0gcGFuZS5zY3JvbGxUb3AgKyBwYW5lLmNsaWVudEhlaWdodCA+PSBwYW5lLnNjcm9sbEhlaWdodCAtIDMwO1xuICBwYW5lLmFwcGVuZChyb3cpO1xuICB3aGlsZSAocGFuZS5jaGlsZEVsZW1lbnRDb3VudCA+IDMwMDApIHBhbmUuZmlyc3RFbGVtZW50Q2hpbGQhLnJlbW92ZSgpO1xuICBpZiAoc3RpY2spIHBhbmUuc2Nyb2xsVG9wID0gcGFuZS5zY3JvbGxIZWlnaHQ7XG59XG5cbi8qKiBBIGZyYW1lIGZyb20gb3IgdG8gR2VtaW5pLCB3aXRoIGF1ZGlvIGN1dCBvdXQsIHNob3J0IGVub3VnaCB0byByZWFkLiAqL1xuZnVuY3Rpb24gYnJpZWYoZGF0YTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGRhdGEucmVwbGFjZSgvXCJkYXRhXCI6XCJbQS1aYS16MC05Ky89XXs0MCx9XCIvZywgKG0pID0+IGBcImRhdGFcIjpcIlx1MjAyNiR7TWF0aC5yb3VuZCgoKG0ubGVuZ3RoIC0gOSkgKiAzKSAvIDQpfSBieXRlc1wiYCkuc2xpY2UoMCwgNjAwKTtcbn1cblxuZnVuY3Rpb24gZXNjYXBlSHRtbCh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdGV4dC5yZXBsYWNlKC9bJjw+XCInXS9nLCAoYykgPT4gKHsgXCImXCI6IFwiJmFtcDtcIiwgXCI8XCI6IFwiJmx0O1wiLCBcIj5cIjogXCImZ3Q7XCIsICdcIic6IFwiJnF1b3Q7XCIsIFwiJ1wiOiBcIiYjMzk7XCIgfSlbY10hKTtcbn1cblxuLyoqIEEgbGl0dGxlIE1hcmtkb3duLCBzYWZlbHk6IGNvZGUsIGJvbGQsIGxpbmtzLCBsaXN0cyBhbmQgaGVhZGluZ3MsIHRoZSByZXN0IGFzIHRleHQuICovXG5mdW5jdGlvbiBtYXJrZG93bih0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBibG9ja3MgPSBlc2NhcGVIdG1sKHRleHQudHJpbSgpKS5zcGxpdCgvYGBgKD86XFx3Kyk/XFxuPy8pO1xuICByZXR1cm4gYmxvY2tzLm1hcCgoYmxvY2ssIGkpID0+IHtcbiAgICBpZiAoaSAlIDIgPT09IDEpIHJldHVybiBgPHByZT48Y29kZT4ke2Jsb2NrLnJlcGxhY2UoL1xcbiQvLCBcIlwiKX08L2NvZGU+PC9wcmU+YDtcbiAgICBjb25zdCBpbmxpbmUgPSAoczogc3RyaW5nKSA9PiBzXG4gICAgICAucmVwbGFjZSgvYChbXmBcXG5dKylgL2csIFwiPGNvZGU+JDE8L2NvZGU+XCIpXG4gICAgICAucmVwbGFjZSgvXFwqXFwqKFteKlxcbl0rKVxcKlxcKi9nLCBcIjxiPiQxPC9iPlwiKVxuICAgICAgLnJlcGxhY2UoL1xcWyhbXlxcXVxcbl0rKVxcXVxcKChodHRwcz86XFwvXFwvW15cXHMpXSspXFwpL2csICc8YSBocmVmPVwiJDJcIiB0YXJnZXQ9XCJfYmxhbmtcIiByZWw9XCJub29wZW5lclwiPiQxPC9hPicpXG4gICAgICAucmVwbGFjZSgvKF58W1xccyhdKShodHRwcz86XFwvXFwvW15cXHM8KV0rKS9nLCAnJDE8YSBocmVmPVwiJDJcIiB0YXJnZXQ9XCJfYmxhbmtcIiByZWw9XCJub29wZW5lclwiPiQyPC9hPicpO1xuICAgIGxldCBodG1sID0gXCJcIjtcbiAgICBsZXQgbGlzdDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gICAgZm9yIChjb25zdCByYXcgb2YgYmxvY2suc3BsaXQoXCJcXG5cIikpIHtcbiAgICAgIGNvbnN0IGl0ZW0gPSByYXcubWF0Y2goL15cXHMqKD86Wy0qXHUyMDIyXXwoXFxkKylbLildKVxccysoLiopJC8pO1xuICAgICAgaWYgKGl0ZW0pIHtcbiAgICAgICAgY29uc3Qga2luZCA9IGl0ZW1bMV0gPyBcIm9sXCIgOiBcInVsXCI7XG4gICAgICAgIGlmIChsaXN0ICE9PSBraW5kKSB7IGlmIChsaXN0KSBodG1sICs9IGA8LyR7bGlzdH0+YDsgaHRtbCArPSBgPCR7a2luZH0+YDsgbGlzdCA9IGtpbmQ7IH1cbiAgICAgICAgaHRtbCArPSBgPGxpPiR7aW5saW5lKGl0ZW1bMl0pfTwvbGk+YDtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBpZiAobGlzdCkgeyBodG1sICs9IGA8LyR7bGlzdH0+YDsgbGlzdCA9IG51bGw7IH1cbiAgICAgIGNvbnN0IGhlYWRpbmcgPSByYXcubWF0Y2goL14jezEsNn1cXHMrKC4qKSQvKTtcbiAgICAgIGh0bWwgKz0gaGVhZGluZyA/IGA8ZGl2IGNsYXNzPVwibWQtaFwiPiR7aW5saW5lKGhlYWRpbmdbMV0pfTwvZGl2PmAgOiByYXcudHJpbSgpID09PSBcIlwiID8gXCI8YnI+XCIgOiBgJHtpbmxpbmUocmF3KX08YnI+YDtcbiAgICB9XG4gICAgaWYgKGxpc3QpIGh0bWwgKz0gYDwvJHtsaXN0fT5gO1xuICAgIHJldHVybiBodG1sLnJlcGxhY2UoLyg8YnI+KSskLywgXCJcIik7XG4gIH0pLmpvaW4oXCJcIik7XG59XG5cbmNvbnN0IHRyYW5zY3JpcHRTY3JvbGwgPSBuZXcgQXV0b1Njcm9sbGVyKCQoXCJ0cmFuc2NyaXB0XCIpLCB7XG4gIG9uSnVtcENoYW5nZTogKHNob3cpID0+IHsgJChcImp1bXBib3R0b21cIikuaGlkZGVuID0gIXNob3c7IH0sXG4gIGlzRW1wdHk6ICgpID0+ICEkKFwiZW1wdHlcIikuaGlkZGVuLFxufSk7XG5cbmZ1bmN0aW9uIHNjcm9sbERvd24oZm9yY2UgPSBmYWxzZSkge1xuICB0cmFuc2NyaXB0U2Nyb2xsLm9uQ29udGVudChmb3JjZSk7XG59XG5cbi8qKiBUaGUgY29yZSdzIG51bWJlciBmb3IgdGhlIGxpbmUgdGhlIGxhc3Qgcm93IHNob3dzLCB1bnRpbCBhbm90aGVyIHJvdyBmb2xsb3dzIGl0LiAqL1xubGV0IG9wZW5MaW5lOiBudW1iZXIgfCBudWxsID0gbnVsbDtcblxuLyoqIFdvcmRzIGdvIG9uIHRoZSByb3cgdGhlIGNvcmUgc2F5cyB0aGV5IGJlbG9uZyB0bzogaXQgc3RhcnRzIGEgbmV3IGxpbmUgZm9yIGVhY2ggdHVybiwgaG93ZXZlciBsb25nIHRoZSBnYXAuICovXG5mdW5jdGlvbiB0cmFuc2NyaXB0KHJvbGU6IFwidXNlclwiIHwgXCJhc3Npc3RhbnRcIiwgdGV4dDogc3RyaW5nLCBsaW5lOiBudW1iZXIpIHtcbiAgJChcImVtcHR5XCIpLmhpZGRlbiA9IHRydWU7XG4gIGNvbnN0IHBhbmUgPSAkKFwidHJhbnNjcmlwdFwiKTtcbiAgY29uc3QgbGFzdCA9IHBhbmUubGFzdEVsZW1lbnRDaGlsZCBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gIGlmIChvcGVuTGluZSA9PT0gbGluZSAmJiBsYXN0ICYmIGxhc3QuZGF0YXNldC5yb2xlID09PSByb2xlKSBsYXN0LnF1ZXJ5U2VsZWN0b3IoXCIudGV4dFwiKSEudGV4dENvbnRlbnQgKz0gdGV4dDtcbiAgZWxzZSB7XG4gICAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICByb3cuY2xhc3NOYW1lID0gYGxpbmUgJHtyb2xlfWA7XG4gICAgcm93LmRhdGFzZXQucm9sZSA9IHJvbGU7XG4gICAgcm93LmlubmVySFRNTCA9IGA8c3BhbiBjbGFzcz1cIndob1wiPiR7cm9sZSA9PT0gXCJ1c2VyXCIgPyBcIllvdVwiIDogXCJHZW1pbmlcIn08L3NwYW4+PHNwYW4gY2xhc3M9XCJ0ZXh0XCI+PC9zcGFuPmA7XG4gICAgcm93LnF1ZXJ5U2VsZWN0b3IoXCIudGV4dFwiKSEudGV4dENvbnRlbnQgPSB0ZXh0LnRyaW1TdGFydCgpO1xuICAgIHBhbmUuYXBwZW5kKHJvdyk7XG4gICAgb3BlbkxpbmUgPSBsaW5lO1xuICB9XG4gIHNjcm9sbERvd24oKTtcbn1cblxuLyoqXG4gKiBUaGUgd29yZHMgdGhlIHVzZXIgaXMgc2F5aW5nLCBiZWZvcmUgdGhlIG1vZGVsIGhhcyB0cmFuc2NyaWJlZCB0aGVtOiBhIGZhaW50IHJvdyB0aGF0IHN0YXlzIGxhc3RcbiAqIG9uIHNjcmVlbiAoaXRzIENTUyBgb3JkZXJgKSBhbmQgZmlyc3QgaW4gdGhlIHBhbmUsIHNvIHRoZSBsaW5lcyBhZnRlciBpdCBqb2luIHVwIGFzIGJlZm9yZS5cbiAqL1xuZnVuY3Rpb24gY2FwdGlvbih0ZXh0OiBzdHJpbmcgfCBudWxsKSB7XG4gIGNvbnN0IHBhbmUgPSAkKFwidHJhbnNjcmlwdFwiKTtcbiAgbGV0IHJvdyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwiY2FwdGlvblwiKTtcbiAgaWYgKHRleHQgPT0gbnVsbCkgeyByb3c/LnJlbW92ZSgpOyBzY3JvbGxEb3duKCk7IHJldHVybjsgfVxuICAkKFwiZW1wdHlcIikuaGlkZGVuID0gdHJ1ZTtcbiAgaWYgKCFyb3cpIHtcbiAgICByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIHJvdy5pZCA9IFwiY2FwdGlvblwiO1xuICAgIHJvdy5jbGFzc05hbWUgPSBcImxpbmUgdXNlciBjYXB0aW9uXCI7XG4gICAgcm93LmlubmVySFRNTCA9IGA8c3BhbiBjbGFzcz1cIndob1wiPllvdTwvc3Bhbj48c3BhbiBjbGFzcz1cInRleHRcIj48L3NwYW4+YDtcbiAgICBwYW5lLnByZXBlbmQocm93KTtcbiAgfVxuICByb3cucXVlcnlTZWxlY3RvcihcIi50ZXh0XCIpIS50ZXh0Q29udGVudCA9IHRleHQ7XG4gIHNjcm9sbERvd24oKTtcbn1cblxuZnVuY3Rpb24gbm90ZSh0ZXh0OiBzdHJpbmcpIHtcbiAgJChcImVtcHR5XCIpLmhpZGRlbiA9IHRydWU7XG4gIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvdy5jbGFzc05hbWUgPSBcImxpbmUgbm90ZVwiO1xuICByb3cudGV4dENvbnRlbnQgPSB0ZXh0O1xuICAkKFwidHJhbnNjcmlwdFwiKS5hcHBlbmQocm93KTtcbiAgb3BlbkxpbmUgPSBudWxsO1xuICBzY3JvbGxEb3duKCk7XG59XG5cbmZ1bmN0aW9uIHJlc3VsdChhZ2VudDogc3RyaW5nLCBsYWJlbDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcsIGZhaWxlZCA9IGZhbHNlKTogSFRNTEVsZW1lbnQge1xuICAkKFwiZW1wdHlcIikuaGlkZGVuID0gdHJ1ZTtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IGBsaW5lIHJlc3VsdCAke2FnZW50ID09PSBcInQzXCIgPyBcInQzXCIgOiBcIlwifSAke2ZhaWxlZCA/IFwiZmFpbGVkXCIgOiBcIlwifWAudHJpbSgpO1xuICBjb25zdCB3aG8gPSBhZ2VudCA9PT0gXCJ0M1wiID8gXCJUM1wiIDogXCJIZXJtZXNcIjtcbiAgcm93LmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPVwid2hvXCI+PHNwYW4gY2xhc3M9XCJyZXMtdGl0bGVcIj48c3BhbiBjbGFzcz1cImJhZGdlICR7YWdlbnQgPT09IFwidDNcIiA/IFwidDNcIiA6IFwiXCJ9XCI+JHt3aG99PC9zcGFuPjxzcGFuIGNsYXNzPVwicmVzLWxhYmVsXCI+JHtlc2NhcGVIdG1sKGxhYmVsKX08L3NwYW4+PC9zcGFuPjxzcGFuIGNsYXNzPVwicmVzLXBpbGxcIj4ke2ZhaWxlZCA/IFwiRmFpbGVkXCIgOiBcIlJlc3VsdFwifTwvc3Bhbj48L2Rpdj48ZGl2IGNsYXNzPVwiYm9keVwiPiR7bWFya2Rvd24odGV4dCl9PC9kaXY+YDtcbiAgJChcInRyYW5zY3JpcHRcIikuYXBwZW5kKHJvdyk7XG4gIG9wZW5MaW5lID0gbnVsbDtcbiAgY29uc3QgYm9keSA9IHJvdy5xdWVyeVNlbGVjdG9yKFwiLmJvZHlcIikgYXMgSFRNTEVsZW1lbnQ7XG4gIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB7XG4gICAgaWYgKGJvZHkuc2Nyb2xsSGVpZ2h0ID4gYm9keS5jbGllbnRIZWlnaHQgKyA0KSB7XG4gICAgICByb3cuY2xhc3NMaXN0LmFkZChcImNsYW1wZWRcIik7XG4gICAgICBjb25zdCBtb3JlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgICAgIG1vcmUuY2xhc3NOYW1lID0gXCJtb3JlXCI7XG4gICAgICBtb3JlLnR5cGUgPSBcImJ1dHRvblwiO1xuICAgICAgbW9yZS50ZXh0Q29udGVudCA9IFwiU2hvdyBmdWxsIHJlc3VsdFwiO1xuICAgICAgbW9yZS5vbmNsaWNrID0gKCkgPT4ge1xuICAgICAgICByb3cuY2xhc3NMaXN0LnRvZ2dsZShcIm9wZW5cIik7XG4gICAgICAgIG1vcmUudGV4dENvbnRlbnQgPSByb3cuY2xhc3NMaXN0LmNvbnRhaW5zKFwib3BlblwiKSA/IFwiU2hvdyBsZXNzXCIgOiBcIlNob3cgZnVsbCByZXN1bHRcIjtcbiAgICAgICAgdHJhbnNjcmlwdFNjcm9sbC5zeW5jRnJvbVBvc2l0aW9uKCk7XG4gICAgICB9O1xuICAgICAgcm93LmFwcGVuZChtb3JlKTtcbiAgICAgIHNjcm9sbERvd24oKTtcbiAgICB9XG4gIH0pO1xuICBzY3JvbGxEb3duKCk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIGVsYXBzZWQoc2Vjb25kczogbnVtYmVyKTogc3RyaW5nIHtcbiAgaWYgKHNlY29uZHMgPCA2MCkgcmV0dXJuIGAke01hdGguZmxvb3Ioc2Vjb25kcyl9c2A7XG4gIGNvbnN0IG0gPSBNYXRoLmZsb29yKHNlY29uZHMgLyA2MCk7XG4gIHJldHVybiBtIDwgNjAgPyBgJHttfW0gJHtNYXRoLmZsb29yKHNlY29uZHMgJSA2MCl9c2AgOiBgJHtNYXRoLmZsb29yKG0gLyA2MCl9aCAke20gJSA2MH1tYDtcbn1cblxuLyoqIFRoZSBlbXB0eSB0YXNrIGxpc3QncyB3b3Jkcywga2VwdCB0byBwdXQgYmFjay4gKi9cbmNvbnN0IG5vVGFza3MgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcIm5vdGFza3NcIikhO1xuXG4vKiogV2hldGhlciBhIHRhc2sgc3RpbGwgd2FudHMgdGhlIHNjcmVlbjogaXQncyB3b3JraW5nLCBvciBpdCB3YWl0cyBmb3IgdGhlIHVzZXIuIFRoZSByZXN0IGZvbGQgYXdheSB1bmRlciBGaW5pc2hlZC4gKi9cbmNvbnN0IGxpdmUgPSAoc3RhdGU6IHN0cmluZykgPT4gc3RhdGUgPT09IFwicnVubmluZ1wiIHx8IHN0YXRlLnN0YXJ0c1dpdGgoXCJ3YWl0aW5nXCIpO1xuXG5mdW5jdGlvbiB1cGRhdGVUYXNrQ2hyb21lKCkge1xuICBjb25zdCBhbGwgPSBbLi4udGFza3MudmFsdWVzKCldO1xuICBjb25zdCBhY3RpdmVDdXJyZW50ID0gYWxsLmZpbHRlcigodCkgPT4gbGl2ZSh0LmMuc3RhdGUpIHx8IEJvb2xlYW4odC5hcHByb3ZhbCkpLmxlbmd0aDtcbiAgY29uc3Qgd2FpdGluZyA9IGFsbC5maWx0ZXIoKHQpID0+IHQuYy5zdGF0ZS5zdGFydHNXaXRoKFwid2FpdGluZ1wiKSB8fCBCb29sZWFuKHQuYXBwcm92YWwpKS5sZW5ndGg7XG4gIGNvbnN0IGFjdGl2ZVRvdGFsID0gYWN0aXZlQ3VycmVudCArIGVhcmxpZXJBY3RpdmVDb3VudDtcbiAgY29uc3QgYXR0ZW50aW9uVG90YWwgPSB3YWl0aW5nICsgZWFybGllcldhaXRpbmdDb3VudDtcblxuICBjb25zdCBiYWRnZSA9ICQoXCJ0YXNrcy1iYWRnZVwiKTtcbiAgYmFkZ2UuaGlkZGVuID0gYWN0aXZlVG90YWwgPT09IDA7XG4gIGJhZGdlLnRleHRDb250ZW50ID0gU3RyaW5nKGFjdGl2ZVRvdGFsKTtcbiAgYmFkZ2UuY2xhc3NMaXN0LnRvZ2dsZShcIndhcm5cIiwgYXR0ZW50aW9uVG90YWwgPiAwKTtcblxuICBjb25zdCBiYXIgPSAkKFwibW9iaWxlLXRhc2tzLWJhclwiKTtcbiAgY29uc3Qgc2hvd0JhciA9IGFjdGl2ZVRvdGFsID4gMDtcbiAgYmFyLmhpZGRlbiA9ICFzaG93QmFyO1xuICBiYXIuY2xhc3NMaXN0LnRvZ2dsZShcInZpc2libGVcIiwgc2hvd0Jhcik7XG4gIGJhci5jbGFzc0xpc3QudG9nZ2xlKFwid2FyblwiLCBhdHRlbnRpb25Ub3RhbCA+IDApO1xuICBpZiAoc2hvd0Jhcikge1xuICAgIGNvbnN0IGFwcHJvdmFsID0gYWxsLmZpbmQoKHQpID0+IHQuYXBwcm92YWwpO1xuICAgIGNvbnN0IGxhYmVsID0gYXBwcm92YWxcbiAgICAgID8gYEFwcHJvdmFsIG5lZWRlZDogJHthcHByb3ZhbC5jLmxhYmVsfWBcbiAgICAgIDogYXR0ZW50aW9uVG90YWwgPiAwXG4gICAgICAgID8gYCR7YXR0ZW50aW9uVG90YWx9IHRhc2ske2F0dGVudGlvblRvdGFsID4gMSA/IFwic1wiIDogXCJcIn0gd2FpdGluZyBmb3IgeW91YFxuICAgICAgICA6IGAke2FjdGl2ZVRvdGFsfSBhY3RpdmUgdGFzayR7YWN0aXZlVG90YWwgPiAxID8gXCJzXCIgOiBcIlwifWA7XG4gICAgJChcIm10Yi10ZXh0XCIpLnRleHRDb250ZW50ID0gbGFiZWw7XG4gIH1cbn1cblxuLyoqIFRoZSBGaW5pc2hlZCBmb2xkJ3MgY291bnQsIGFuZCB0aGUgZm9sZCBpdHNlbGYgb25seSB3aGVuIHNvbWV0aGluZyBpcyBpbiBpdC4gKi9cbmZ1bmN0aW9uIHNob3dEb25lKCkge1xuICBjb25zdCBuID0gJChcImRvbmVub3dcIikuY2hpbGRFbGVtZW50Q291bnQgKyAkKFwiZG9uZWVhcmxpZXJcIikuY2hpbGRFbGVtZW50Q291bnQ7XG4gICQoXCJkb25lYm94XCIpLmhpZGRlbiA9IG4gPT09IDA7XG4gICQoXCJkb25lY291bnRcIikudGV4dENvbnRlbnQgPSBuID4gMCA/IGBcdTAwQjcgJHtufWAgOiBcIlwiO1xufVxuXG5mdW5jdGlvbiBzaG93VGFza3MoZm9yY2UgPSBmYWxzZSkge1xuICBjb25zdCBwYW5lID0gJChcInRhc2tzXCIpO1xuICBjb25zdCBkb25lID0gJChcImRvbmVub3dcIik7XG4gIGNvbnN0IG9wZW4gPSBkb2N1bWVudC5hY3RpdmVFbGVtZW50Py5jbG9zZXN0Py4oXCIudGFza1wiKSBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gIGlmICghZm9yY2UgJiYgb3BlbiAmJiAocGFuZS5jb250YWlucyhvcGVuKSB8fCBkb25lLmNvbnRhaW5zKG9wZW4pKSAmJiBvcGVuLnF1ZXJ5U2VsZWN0b3IoXCJmb3JtXCIpKSByZXR1cm47IC8vIGRvbid0IHJlZHJhdyB1bmRlciBzb21lb25lIHR5cGluZyBhIGZvbGxvdy11cFxuICBwYW5lLmlubmVySFRNTCA9IFwiXCI7XG4gIGRvbmUuaW5uZXJIVE1MID0gXCJcIjtcbiAgY29uc3QgYWxsID0gWy4uLnRhc2tzLnZhbHVlcygpXS5yZXZlcnNlKCk7XG4gIGlmIChhbGwubGVuZ3RoID09PSAwKSB7XG4gICAgcGFuZS5hcHBlbmQobm9UYXNrcyk7XG4gICAgJChcInRhc2tjb3VudFwiKS50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgJChcImNhbmNlbGFsbFwiKS5oaWRkZW4gPSB0cnVlO1xuICAgIHNob3dEb25lKCk7XG4gICAgdXBkYXRlVGFza0Nocm9tZSgpO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBydW5uaW5nID0gYWxsLmZpbHRlcigodCkgPT4gdC5jLnN0YXRlID09PSBcInJ1bm5pbmdcIikubGVuZ3RoO1xuICBjb25zdCBhY3RpdmVDb3VudCA9IGFsbC5maWx0ZXIoKHQpID0+IGxpdmUodC5jLnN0YXRlKSkubGVuZ3RoO1xuICAkKFwidGFza2NvdW50XCIpLnRleHRDb250ZW50ID0gcnVubmluZyA+IDAgPyBgJHtydW5uaW5nfSBydW5uaW5nYCA6IGFjdGl2ZUNvdW50ID4gMCA/IGAke2FjdGl2ZUNvdW50fSB3YWl0aW5nYCA6IFwiXCI7XG4gICQoXCJjYW5jZWxhbGxcIikuaGlkZGVuID0gIWNhbGxJZCB8fCBydW5uaW5nIDwgMjtcbiAgZm9yIChjb25zdCB2aWV3IG9mIGFsbCkge1xuICAgIGNvbnN0IHQgPSB2aWV3LmM7XG4gICAgY29uc3Qgd2FpdGluZyA9IHQuc3RhdGUuc3RhcnRzV2l0aChcIndhaXRpbmdcIik7XG4gICAgY29uc3QgY2FyZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgY2FyZC5jbGFzc05hbWUgPSBgdGFzayAke3dhaXRpbmcgPyBcIndhaXRpbmdcIiA6IHQuc3RhdGV9YDtcbiAgICBjb25zdCBhZ2UgPSAodmlldy5lbmRlZCA/PyBub3coKSkgLSB2aWV3LnNpbmNlO1xuICAgIGNhcmQuaW5uZXJIVE1MID1cbiAgICAgIGA8ZGl2IGNsYXNzPVwibWV0YS1yb3dcIj5gICtcbiAgICAgICAgYDxzcGFuIGNsYXNzPVwiYmFkZ2UgJHt0LmFnZW50ID09PSBcInQzXCIgPyBcInQzXCIgOiBcIlwifVwiPiR7dC5hZ2VudCA9PT0gXCJ0M1wiID8gXCJUM1wiIDogXCJIZXJtZXNcIn08L3NwYW4+YCArXG4gICAgICAgIGA8c3BhbiBjbGFzcz1cInN0YXRlXCI+JHt0LnN0YXRlID09PSBcInJ1bm5pbmdcIiA/ICc8c3BhbiBjbGFzcz1cInNwaW5cIj48L3NwYW4+JyA6IFwiXCJ9JHtlc2NhcGVIdG1sKHQuc3RhdGUpfTwvc3Bhbj5gICtcbiAgICAgICAgYDxzcGFuIGNsYXNzPVwiYWdlXCI+JHtlbGFwc2VkKGFnZSl9PC9zcGFuPmAgK1xuICAgICAgYDwvZGl2PmAgK1xuICAgICAgYDxkaXYgY2xhc3M9XCJsYWJlbFwiPjwvZGl2PmAgK1xuICAgICAgYDxkaXYgY2xhc3M9XCJwXCI+PC9kaXY+YDtcbiAgICBjYXJkLnF1ZXJ5U2VsZWN0b3IoXCIubGFiZWxcIikhLnRleHRDb250ZW50ID0gdC5sYWJlbDtcbiAgICBjYXJkLnF1ZXJ5U2VsZWN0b3IoXCIucFwiKSEudGV4dENvbnRlbnQgPSB0LnByb2dyZXNzID8/IHQucmVxdWVzdDtcbiAgICBpZiAodC5xdWVzdGlvbikge1xuICAgICAgY29uc3QgcSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICBxLmNsYXNzTmFtZSA9IFwicVwiO1xuICAgICAgcS50ZXh0Q29udGVudCA9IGBBc2tzOiAke3QucXVlc3Rpb259YDtcbiAgICAgIGNhcmQuYXBwZW5kKHEpO1xuICAgIH1cbiAgICBpZiAodmlldy5hcHByb3ZhbCAmJiB0LnN0YXRlID09PSBcInJ1bm5pbmdcIikge1xuICAgICAgY29uc3QgYm94ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgIGJveC5jbGFzc05hbWUgPSBcImFwcHJvdmFsXCI7XG4gICAgICBib3guaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9XCJhcHByb3ZhbC1oZWFkXCI+SGVybWVzIGFza3MgdG8gcnVuPC9kaXY+PGNvZGU+PC9jb2RlPjxkaXYgY2xhc3M9XCJhY3RzXCI+PC9kaXY+YDtcbiAgICAgIGJveC5xdWVyeVNlbGVjdG9yKFwiY29kZVwiKSEudGV4dENvbnRlbnQgPSB2aWV3LmFwcHJvdmFsLmNvbW1hbmQ7XG4gICAgICBjb25zdCBhbnN3ZXIgPSAoY2hvaWNlOiBcIm9uY2VcIiB8IFwiZGVueVwiKSA9PiB7XG4gICAgICAgIHZpZXcuYXBwcm92YWwgPSB1bmRlZmluZWQ7XG4gICAgICAgIHNob3dUYXNrcyh0cnVlKTtcbiAgICAgICAgdm9pZCBmZXRjaChcIi9oZXJtZXMvYXBwcm92YWxcIiwgeyBtZXRob2Q6IFwiUE9TVFwiLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGNhbGw6IGNhbGxOYW1lLCB0YXNrSWQ6IHQuaWQsIGNob2ljZSB9KSB9KVxuICAgICAgICAgIC50aGVuKChyKSA9PiB0b2FzdChyLm9rID8gKGNob2ljZSA9PT0gXCJvbmNlXCIgPyBcIkFwcHJvdmVkXCIgOiBcIkRlbmllZFwiKSA6IFwiVGhhdCBhcHByb3ZhbCBoYWQgYWxyZWFkeSBsYXBzZWRcIikpO1xuICAgICAgfTtcbiAgICAgIGZvciAoY29uc3QgW2xhYmVsLCBjaG9pY2VdIG9mIFtbXCJBcHByb3ZlIG9uY2VcIiwgXCJvbmNlXCJdLCBbXCJEZW55XCIsIFwiZGVueVwiXV0gYXMgY29uc3QpIHtcbiAgICAgICAgY29uc3QgYiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gICAgICAgIGIudHlwZSA9IFwiYnV0dG9uXCI7XG4gICAgICAgIGIudGV4dENvbnRlbnQgPSBsYWJlbDtcbiAgICAgICAgaWYgKGNob2ljZSA9PT0gXCJvbmNlXCIpIGIuY2xhc3NOYW1lID0gXCJnb1wiO1xuICAgICAgICBlbHNlIGIuY2xhc3NOYW1lID0gXCJkYW5nZXJcIjtcbiAgICAgICAgYi5vbmNsaWNrID0gKCkgPT4gYW5zd2VyKGNob2ljZSk7XG4gICAgICAgIGJveC5xdWVyeVNlbGVjdG9yKFwiLmFjdHNcIikhLmFwcGVuZChiKTtcbiAgICAgIH1cbiAgICAgIGNhcmQuYXBwZW5kKGJveCk7XG4gICAgfVxuICAgIGlmICh0LnN0YXRlICE9PSBcInJ1bm5pbmdcIikgdmlldy5hcHByb3ZhbCA9IHVuZGVmaW5lZDtcbiAgICBjb25zdCBhY3RzID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBhY3RzLmNsYXNzTmFtZSA9IFwiYWN0c1wiO1xuICAgIGNvbnN0IGJ1dHRvbiA9ICh0ZXh0OiBzdHJpbmcsIGZuOiAoKSA9PiB2b2lkLCBjbHMgPSBcIlwiKSA9PiB7XG4gICAgICBjb25zdCBiID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgICAgIGIudHlwZSA9IFwiYnV0dG9uXCI7XG4gICAgICBiLnRleHRDb250ZW50ID0gdGV4dDtcbiAgICAgIGlmIChjbHMpIGIuY2xhc3NOYW1lID0gY2xzO1xuICAgICAgYi5vbmNsaWNrID0gZm47XG4gICAgICBhY3RzLmFwcGVuZChiKTtcbiAgICAgIHJldHVybiBiO1xuICAgIH07XG4gICAgaWYgKGNhbGxJZCkge1xuICAgICAgYnV0dG9uKHdhaXRpbmcgPyBcIkFuc3dlclwiIDogXCJGb2xsb3cgdXBcIiwgKCkgPT4gZm9sbG93VXBGb3JtKGNhcmQsIHQpKTtcbiAgICAgIGlmICh0LnN0YXRlID09PSBcInJ1bm5pbmdcIikgYnV0dG9uKFwiQ2FuY2VsXCIsICgpID0+IHB1c2goeyB0eXBlOiBcImNhbmNlbFRhc2tcIiwgdGFzazogdC5pZCB9KSwgXCJkYW5nZXJcIik7XG4gICAgfVxuICAgIGlmICh2aWV3LnJlc3VsdCkgYnV0dG9uKFwiUmVzdWx0XCIsICgpID0+IHtcbiAgICAgIHNldFRhc2tzT3BlbihmYWxzZSk7XG4gICAgICB2aWV3LnJlc3VsdCEuY2xhc3NMaXN0LmFkZChcIm9wZW5cIik7XG4gICAgICBpZiAodmlldy5yZXN1bHQgIT09ICQoXCJ0cmFuc2NyaXB0XCIpLmxhc3RFbGVtZW50Q2hpbGQpIHRyYW5zY3JpcHRTY3JvbGwudW5waW4oKTtcbiAgICAgIGVsc2UgdHJhbnNjcmlwdFNjcm9sbC5zeW5jRnJvbVBvc2l0aW9uKCk7XG4gICAgICB2aWV3LnJlc3VsdCEuc2Nyb2xsSW50b1ZpZXcoeyBiZWhhdmlvcjogXCJzbW9vdGhcIiwgYmxvY2s6IFwic3RhcnRcIiB9KTtcbiAgICB9KTtcbiAgICBpZiAodmlldy50aHJlYWQpIGJ1dHRvbihcIkNvcHkgdGhyZWFkIGlkXCIsICgpID0+IHsgdm9pZCBuYXZpZ2F0b3IuY2xpcGJvYXJkPy53cml0ZVRleHQodmlldy50aHJlYWQhKTsgdG9hc3QoXCJUaHJlYWQgaWQgY29waWVkXCIpOyB9KTtcbiAgICBpZiAoYWN0cy5jaGlsZEVsZW1lbnRDb3VudCkgY2FyZC5hcHBlbmQoYWN0cyk7XG4gICAgKGxpdmUodC5zdGF0ZSkgPyBwYW5lIDogZG9uZSkuYXBwZW5kKGNhcmQpO1xuICB9XG4gIGlmIChwYW5lLmNoaWxkRWxlbWVudENvdW50ID09PSAwKSBwYW5lLmFwcGVuZChub1Rhc2tzKTtcbiAgc2hvd0RvbmUoKTtcbiAgdXBkYXRlVGFza0Nocm9tZSgpO1xufVxuXG5mdW5jdGlvbiBmb2xsb3dVcEZvcm0oY2FyZDogSFRNTEVsZW1lbnQsIHQ6IENvbW1hbmQpIHtcbiAgaWYgKGNhcmQucXVlcnlTZWxlY3RvcihcImZvcm1cIikpIHJldHVybjtcbiAgY29uc3QgZm9ybSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJmb3JtXCIpO1xuICBmb3JtLmlubmVySFRNTCA9IGA8aW5wdXQgdHlwZT1cInRleHRcIiBwbGFjZWhvbGRlcj1cIlRlbGwgXHUyMDFDJHtlc2NhcGVIdG1sKHQubGFiZWwpfVx1MjAxRFx1MjAyNlwiIGVudGVya2V5aGludD1cInNlbmRcIj48YnV0dG9uIHR5cGU9XCJzdWJtaXRcIj5TZW5kPC9idXR0b24+YDtcbiAgY29uc3QgaW5wdXQgPSBmb3JtLnF1ZXJ5U2VsZWN0b3IoXCJpbnB1dFwiKSE7XG4gIGZvcm0ub25zdWJtaXQgPSAoZSkgPT4ge1xuICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICBjb25zdCB0ZXh0ID0gaW5wdXQudmFsdWUudHJpbSgpO1xuICAgIGlmICh0ZXh0KSB7IHB1c2goeyB0eXBlOiBcInN0ZWVyXCIsIHRhc2s6IHQuaWQsIHRleHQgfSk7IG5vdGUoYFlvdSBcdTIxOTIgJHt0LmxhYmVsfTogJHt0ZXh0fWApOyBzY3JvbGxEb3duKHRydWUpOyB9XG4gICAgaW5wdXQuYmx1cigpO1xuICAgIGZvcm0ucmVtb3ZlKCk7XG4gICAgc2hvd1Rhc2tzKCk7XG4gIH07XG4gIGlucHV0Lm9ua2V5ZG93biA9IChlKSA9PiB7IGlmIChlLmtleSA9PT0gXCJFc2NhcGVcIikgeyBpbnB1dC5ibHVyKCk7IGZvcm0ucmVtb3ZlKCk7IHNob3dUYXNrcygpOyB9IH07XG4gIGNhcmQuYXBwZW5kKGZvcm0pO1xuICBpbnB1dC5mb2N1cygpO1xufVxuXG4vKiogVDMgdGhyZWFkcyBlYXJsaWVyIGNhbGxzIHN0YXJ0ZWQ6IHRoZXkgY2Fycnkgb24gYWZ0ZXIgYSBjYWxsLCBzbyB0aGUgcGFuZWwgc2F5cyBob3cgdGhleSdyZSBkb2luZy4gKi9cbmFzeW5jIGZ1bmN0aW9uIHNob3dFYXJsaWVyKCkge1xuICBsZXQgbGlzdDogeyB0aHJlYWQ6IHN0cmluZzsgdGl0bGU6IHN0cmluZzsgc3RhdHVzOiBzdHJpbmc7IGJyYW5jaDogc3RyaW5nIHwgbnVsbDsgcHI6IHN0cmluZyB8IG51bGw7IHVwZGF0ZWQ6IHN0cmluZzsgbGFzdDogc3RyaW5nOyB3YWl0aW5nOiBib29sZWFuIH1bXSA9IFtdO1xuICB0cnkgeyBsaXN0ID0gYXdhaXQgKGF3YWl0IGZldGNoKFwiL2FnZW50L3JlY2VudFwiLCB7IGNhY2hlOiBcIm5vLXN0b3JlXCIgfSkpLmpzb24oKTsgfSBjYXRjaCB7fVxuICBjb25zdCBjdXJyZW50ID0gbmV3IFNldChbLi4udGFza3MudmFsdWVzKCldLm1hcCgodikgPT4gdi50aHJlYWQpLmZpbHRlcihCb29sZWFuKSk7XG4gIGxpc3QgPSBsaXN0LmZpbHRlcigodCkgPT4gIWN1cnJlbnQuaGFzKHQudGhyZWFkKSk7XG4gIGNvbnN0IHBhbmUgPSAkKFwiZWFybGllclwiKTtcbiAgY29uc3QgZG9uZSA9ICQoXCJkb25lZWFybGllclwiKTtcbiAgcGFuZS5pbm5lckhUTUwgPSBcIlwiO1xuICBkb25lLmlubmVySFRNTCA9IFwiXCI7XG4gIGVhcmxpZXJBY3RpdmVDb3VudCA9IDA7XG4gIGVhcmxpZXJXYWl0aW5nQ291bnQgPSAwO1xuICBmb3IgKGNvbnN0IHQgb2YgbGlzdCkge1xuICAgIGNvbnN0IGNhcmQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGNvbnN0IHN0YXRlID0gdC53YWl0aW5nID8gXCJ3YWl0aW5nIGZvciBhcHByb3ZhbCBpbiBUM1wiIDogdC5zdGF0dXM7XG4gICAgY2FyZC5jbGFzc05hbWUgPSBgdGFzayAke3Quc3RhdHVzID09PSBcInJ1bm5pbmdcIiA/IFwicnVubmluZ1wiIDogdC53YWl0aW5nID8gXCJ3YWl0aW5nXCIgOiBcImZpbmlzaGVkXCJ9YDtcbiAgICBjb25zdCBhZ28gPSBNYXRoLm1heCgwLCAoRGF0ZS5ub3coKSAtIERhdGUucGFyc2UodC51cGRhdGVkKSkgLyAxMDAwKTtcbiAgICBjYXJkLmlubmVySFRNTCA9XG4gICAgICBgPGRpdiBjbGFzcz1cIm1ldGEtcm93XCI+YCArXG4gICAgICAgIGA8c3BhbiBjbGFzcz1cImJhZGdlIHQzXCI+VDM8L3NwYW4+YCArXG4gICAgICAgIGA8c3BhbiBjbGFzcz1cInN0YXRlXCI+JHt0LnN0YXR1cyA9PT0gXCJydW5uaW5nXCIgPyAnPHNwYW4gY2xhc3M9XCJzcGluXCI+PC9zcGFuPicgOiBcIlwifSR7ZXNjYXBlSHRtbChzdGF0ZSl9PC9zcGFuPmAgK1xuICAgICAgICBgPHNwYW4gY2xhc3M9XCJhZ2VcIj4ke2VsYXBzZWQoYWdvKX0gYWdvPC9zcGFuPmAgK1xuICAgICAgYDwvZGl2PmAgK1xuICAgICAgYDxkaXYgY2xhc3M9XCJsYWJlbFwiPjwvZGl2PmAgK1xuICAgICAgYDxkaXYgY2xhc3M9XCJwXCI+PC9kaXY+YDtcbiAgICBjYXJkLnF1ZXJ5U2VsZWN0b3IoXCIubGFiZWxcIikhLnRleHRDb250ZW50ID0gdC50aXRsZTtcbiAgICBjYXJkLnF1ZXJ5U2VsZWN0b3IoXCIucFwiKSEudGV4dENvbnRlbnQgPSB0Lmxhc3QgfHwgKHQuYnJhbmNoID8gYE9uICR7dC5icmFuY2h9YCA6IFwiXCIpO1xuICAgIGNvbnN0IGFjdHMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGFjdHMuY2xhc3NOYW1lID0gXCJhY3RzXCI7XG4gICAgaWYgKHQucHIpIHsgY29uc3QgYSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJhXCIpOyBhLmhyZWYgPSB0LnByOyBhLnRhcmdldCA9IFwiX2JsYW5rXCI7IGEucmVsID0gXCJub29wZW5lclwiOyBhLnRleHRDb250ZW50ID0gXCJQdWxsIHJlcXVlc3QgXHUyMTk3XCI7IGFjdHMuYXBwZW5kKGEpOyB9XG4gICAgY29uc3QgY29weSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gICAgY29weS50eXBlID0gXCJidXR0b25cIjtcbiAgICBjb3B5LnRleHRDb250ZW50ID0gXCJDb3B5IHRocmVhZCBpZFwiO1xuICAgIGNvcHkub25jbGljayA9ICgpID0+IHsgdm9pZCBuYXZpZ2F0b3IuY2xpcGJvYXJkPy53cml0ZVRleHQodC50aHJlYWQpOyB0b2FzdChcIlRocmVhZCBpZCBjb3BpZWRcIik7IH07XG4gICAgYWN0cy5hcHBlbmQoY29weSk7XG4gICAgY2FyZC5hcHBlbmQoYWN0cyk7XG4gICAgY29uc3QgYWN0aXZlID0gdC5zdGF0dXMgPT09IFwicnVubmluZ1wiIHx8IHQud2FpdGluZztcbiAgICBpZiAoYWN0aXZlKSBlYXJsaWVyQWN0aXZlQ291bnQrKztcbiAgICBpZiAodC53YWl0aW5nKSBlYXJsaWVyV2FpdGluZ0NvdW50Kys7XG4gICAgKGFjdGl2ZSA/IHBhbmUgOiBkb25lKS5hcHBlbmQoY2FyZCk7XG4gIH1cbiAgJChcImVhcmxpZXJib3hcIikuaGlkZGVuID0gcGFuZS5jaGlsZEVsZW1lbnRDb3VudCA9PT0gMDtcbiAgc2hvd0RvbmUoKTtcbiAgdXBkYXRlVGFza0Nocm9tZSgpO1xufVxuXG5jb25zdCBTVEFUVVNfVEVYVDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgaWRsZTogXCJJZGxlXCIsIGNvbm5lY3Rpbmc6IFwiQ29ubmVjdGluZ1x1MjAyNlwiLCBsaXN0ZW5pbmc6IFwiTGlzdGVuaW5nXCIsIHdvcmtpbmc6IFwiTGlzdGVuaW5nIFx1MDBCNyB0YXNrcyBydW5uaW5nXCIsXG4gIGRvcm1hbnQ6IFwiRG9ybWFudCBcdTAwQjcgd2FpdGluZyBmb3Igd2FrZSB3b3JkXCIsXG4gIHN0YW5kYnk6IFwiUGF1c2VkIHdoaWxlIHRhc2tzIHJ1biBcdTAwQjcgc3BlYWsgdG8gcmVzdW1lXCIsIHdha2luZzogXCJSZXN1bWluZ1x1MjAyNlwiLCBlbmRlZDogXCJFbmRlZFwiLFxufTtcblxuZnVuY3Rpb24gc2hvd1N0YXR1cyhtZXNzYWdlPzogc3RyaW5nKSB7XG4gIGNvbnN0IHR5cGVkID0gQm9vbGVhbihjYWxsSWQpICYmIG1lZGl1bSA9PT0gXCJ0ZXh0XCI7XG4gIGNvbnN0IHNwZWFraW5nID0gQm9vbGVhbihjYWxsSWQpICYmICF0eXBlZCAmJiBjb3JlU3RhdHVzICE9PSBcInN0YW5kYnlcIiAmJiBjb3JlU3RhdHVzICE9PSBcImRvcm1hbnRcIiAmJiBhdWRpby5xdWV1ZWQgPiAwLjA1O1xuICBjb25zdCBhcm1lZElkbGUgPSAhY2FsbElkICYmIHdha2VBcm1lZDtcbiAgY29uc3Qgc2hvd24gPSBjYWxsSWRcbiAgICA/IChzcGVha2luZyB8fCAodHlwZWQgJiYgdGhpbmtpbmcpID8gXCJzcGVha2luZ1wiIDogY29yZVN0YXR1cylcbiAgICA6IGFybWVkSWRsZSA/IFwiYXJtZWRcIiA6IGNvcmVTdGF0dXM7XG4gICQoXCJzdGF0dXNcIikuY2xhc3NOYW1lID0gc2hvd247XG4gIGRvY3VtZW50LmJvZHkuZGF0YXNldC5zdGF0ZSA9IGNhbGxJZCA/IHNob3duIDogYXJtZWRJZGxlID8gXCJhcm1lZFwiIDogXCJpZGxlXCI7XG4gIGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LnRvZ2dsZShcImluLXNlc3Npb25cIiwgQm9vbGVhbihjYWxsSWQpKTtcbiAgY29uc3Qgd2FrZUxhYmVsID0gc2VsZWN0ZWRXYWtlTW9kZWwoKT8ubGFiZWwgPz8gXCJ3YWtlIHdvcmRcIjtcbiAgbGV0IHRleHQgPSBhcm1lZElkbGVcbiAgICA/ICh3YWtlTG9hZGluZyA/IGBMb2FkaW5nIFx1MjAxQyR7d2FrZUxhYmVsfVx1MjAxRFx1MjAyNmBcbiAgICAgIDogYXVkaW8uYXVkaW9TdXNwZW5kZWQgPyBgVGFwIGFueXdoZXJlIHRvIGFjdGl2YXRlIFx1MjAxQyR7d2FrZUxhYmVsfVx1MjAxRGBcbiAgICAgIDogYFdhaXRpbmcgZm9yIFx1MjAxQyR7d2FrZUxhYmVsfVx1MjAxRGApXG4gICAgOiBzcGVha2luZyA/IFwiU3BlYWtpbmdcIlxuICAgIDogY29yZVN0YXR1cyA9PT0gXCJkb3JtYW50XCIgPyBgRG9ybWFudCBcdTAwQjcgc2F5IFx1MjAxQyR7d2FrZUxhYmVsfVx1MjAxRGBcbiAgICA6IFNUQVRVU19URVhUW2NvcmVTdGF0dXNdID8/IGNvcmVTdGF0dXM7XG4gIGlmICh0eXBlZCAmJiBjb3JlU3RhdHVzICE9PSBcImVuZGVkXCIpIHRleHQgPSB0aGlua2luZyA/IFwiV3JpdGluZ1x1MjAyNlwiIDogY29yZVN0YXR1cyA9PT0gXCJ3b3JraW5nXCIgPyBcIkNoYXQgXHUwMEI3IHRhc2tzIHJ1bm5pbmdcIiA6IFwiQ2hhdFwiO1xuICBpZiAoY2FsbElkICYmICF0eXBlZCAmJiBtdXRlZCAmJiAhaG9sZGluZyAmJiAhc3BlYWtpbmcpIHRleHQgKz0gXCIgXHUwMEI3IG11dGVkXCI7XG4gIGlmIChob2xkaW5nKSB0ZXh0ID0gXCJUYWxraW5nIChob2xkKVwiO1xuICBpZiAobWVzc2FnZSkgdGV4dCA9IGAke3RleHR9OiAke21lc3NhZ2V9YDtcbiAgaWYgKGNvcmVTdGF0dXMgIT09IFwiZW5kZWRcIiB8fCBtZXNzYWdlIHx8IGFybWVkSWRsZSkgJChcInN0YXR1c3RleHRcIikudGV4dENvbnRlbnQgPSB0ZXh0O1xuICAkPEhUTUxCdXR0b25FbGVtZW50PihcImh1c2hcIikuY2xhc3NMaXN0LnRvZ2dsZShcImxpdmVcIiwgc3BlYWtpbmcgfHwgKHR5cGVkICYmIHRoaW5raW5nKSk7XG5cbiAgY29uc3QgYmFyID0gJChcImNhbGxiYXJcIik7XG4gIGJhci5oaWRkZW4gPSAhY2FsbElkO1xuICAkKFwid2FrZS1ub3dcIikuaGlkZGVuID0gIShjYWxsSWQgJiYgIXR5cGVkICYmIChjb3JlU3RhdHVzID09PSBcImRvcm1hbnRcIiB8fCBjb3JlU3RhdHVzID09PSBcInN0YW5kYnlcIikpO1xuICBpZiAoY2FsbElkKSB7XG4gICAgJChcImNhbGxiYXItc3RhdGVcIikudGV4dENvbnRlbnQgPSB0ZXh0O1xuICAgICQoXCJjYWxsdGltZXJcIikuaGlkZGVuID0gdHlwZWQ7XG4gICAgaWYgKCF0eXBlZCkgJChcImNhbGx0aW1lclwiKS50ZXh0Q29udGVudCA9IGZvcm1hdENsb2NrKG5vdygpIC0gc3RhcnRlZEF0KTtcbiAgICBjb25zdCB2aXpNb2RlID0gdHlwZWQgPyAodGhpbmtpbmcgPyBcInRoaW5raW5nXCIgOiBcImlkbGVcIilcbiAgICAgIDogc3BlYWtpbmcgPyBcInNwZWFraW5nXCJcbiAgICAgIDogbXV0ZWQgJiYgIWhvbGRpbmcgPyBcIm11dGVkXCJcbiAgICAgIDogc2hvd247XG4gICAgdXBkYXRlVmlzdWFsaXplcih2aXpNb2RlLCBtdXRlZCAmJiAhaG9sZGluZyA/IDAgOiBhdWRpby5sZXZlbCk7XG4gIH1cbn1cblxuLy8gVGhlIGNhbGwuXG5cbmZ1bmN0aW9uIHB1c2goZXZlbnQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XG4gIGlmICghY29yZSB8fCAhY2FsbElkKSByZXR1cm47XG4gIGNvbnN0IGU6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0geyAuLi5ldmVudCwgdDogbm93KCkgfTtcbiAgY29uc3QgcXVpZXQgPSBlLnR5cGUgPT09IFwibWljXCIgfHwgZS50eXBlID09PSBcInRpY2tcIjtcbiAgaWYgKCFxdWlldCkgbG9nKFwiaW5cIiwgZS50eXBlID09PSBcIndzLm1lc3NhZ2VcIiA/IGB3cyAke2Uuc2lkfSBcdTIxOTAgJHticmllZihTdHJpbmcoZS5kYXRhKSl9YCA6IEpTT04uc3RyaW5naWZ5KGUpLnNsaWNlKDAsIDQwMCksIFwiaW5cIik7XG4gIHJ1bihKU09OLnBhcnNlKGNvcmUucHVzaChjYWxsSWQsIEpTT04uc3RyaW5naWZ5KGUpKSkpO1xufVxuXG5mdW5jdGlvbiBydW4oY29tbWFuZHM6IENvbW1hbmRbXSkge1xuICBmb3IgKGNvbnN0IGMgb2YgY29tbWFuZHMpIHtcbiAgICBzd2l0Y2ggKGMudHlwZSkge1xuICAgICAgY2FzZSBcIndzLmNvbm5lY3RcIjogY29ubmVjdChjLnNpZCwgYy5wdXJwb3NlID09PSBcImNhcHRpb25zXCIpOyBicmVhaztcbiAgICAgIGNhc2UgXCJ3cy5zZW5kXCI6IHtcbiAgICAgICAgc29ja2V0cy5nZXQoYy5zaWQpPy5zZW5kKGMuZGF0YSk7XG4gICAgICAgIGlmICghYy5kYXRhLnN0YXJ0c1dpdGgoJ3tcInJlYWx0aW1lSW5wdXRcIjp7XCJhdWRpb1wiJykpIGxvZyhcIm91dFwiLCBgd3MgJHtjLnNpZH0gXHUyMTkyICR7YnJpZWYoYy5kYXRhKX1gLCBcIm91dFwiKTtcbiAgICAgICAgZWxzZSBpZiAoIWNhcHRpb25Tb2NrZXRzLmhhcyhjLnNpZCkpIGNvdW50cy5zZW50Kys7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcIndzLmNsb3NlXCI6IHNvY2tldHMuZ2V0KGMuc2lkKT8uY2xvc2UoKTsgc29ja2V0cy5kZWxldGUoYy5zaWQpOyBsb2coXCJvdXRcIiwgYHdzICR7Yy5zaWR9IGNsb3NlYCwgXCJvdXRcIik7IGJyZWFrO1xuICAgICAgY2FzZSBcIm1pYy5zdGFydFwiOiB7XG4gICAgICAgIGxvZyhcIm91dFwiLCBjLnR5cGUsIFwib3V0XCIpO1xuICAgICAgICBjb25zdCBwZW5kaW5nT3BlbmluZyA9IHdha2VTdGFydGluZyA/IG9wZW5pbmdDaHVua3Muc3BsaWNlKDApIDogW107XG4gICAgICAgIG9wZW5pbmdCeXRlcyA9IDA7XG4gICAgICAgIHdha2VTdGFydGluZyA9IGZhbHNlO1xuICAgICAgICB2b2lkIGF1ZGlvLmVuc3VyZU1pYyhvbk1pYywgbWljT3B0aW9ucygpKS5jYXRjaCgoZXJyKSA9PiB7IGxvZyhcImVycm9yXCIsIGBtaWNyb3Bob25lOiAke2Vyci5tZXNzYWdlfWAsIFwiZXJyXCIpOyB0b2FzdChgTWljcm9waG9uZTogJHtlcnIubWVzc2FnZX1gKTsgfSk7XG4gICAgICAgIGlmIChwZW5kaW5nT3BlbmluZy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgY29uc3QgdG90YWxNcyA9IE1hdGgucm91bmQocGVuZGluZ09wZW5pbmcucmVkdWNlKChzLCBiKSA9PiBzICsgYi5ieXRlTGVuZ3RoLCAwKSAvIDMyKTtcbiAgICAgICAgICBsb2coXCJvdXRcIiwgYGZsdXNoaW5nICR7dG90YWxNc30gbXMgc3Bva2VuIGFmdGVyIHdha2Ugd29yZGAsIFwib3V0XCIpO1xuICAgICAgICAgIHF1ZXVlTWljcm90YXNrKCgpID0+IHtcbiAgICAgICAgICAgIGlmICghY2FsbElkKSByZXR1cm47XG4gICAgICAgICAgICBmb3IgKGNvbnN0IGNodW5rIG9mIHBlbmRpbmdPcGVuaW5nKSB7XG4gICAgICAgICAgICAgIGlmICghY2FsbElkKSBicmVhaztcbiAgICAgICAgICAgICAgY291bnRzLm1pYysrO1xuICAgICAgICAgICAgICBwdXNoKHsgdHlwZTogXCJtaWNcIiwgcGNtOiBieXRlc1RvQmFzZTY0KGNodW5rKSB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJtaWMucmVzdGFydFwiOlxuICAgICAgICBsb2coXCJvdXRcIiwgYy50eXBlLCBcIm91dFwiKTtcbiAgICAgICAgdm9pZCBhdWRpby5zdGFydE1pYyhvbk1pYywgbWljT3B0aW9ucygpKS5jYXRjaCgoZXJyKSA9PiB7IGxvZyhcImVycm9yXCIsIGBtaWNyb3Bob25lOiAke2Vyci5tZXNzYWdlfWAsIFwiZXJyXCIpOyB0b2FzdChgTWljcm9waG9uZTogJHtlcnIubWVzc2FnZX1gKTsgfSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcIm1pYy5zdG9wXCI6XG4gICAgICAgIGlmICghd2FrZUFybWVkKSBhdWRpby5zdG9wTWljKCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcInBsYXlcIjoge1xuICAgICAgICBjb25zdCB0ID0gbm93KCk7XG4gICAgICAgIC8vIEEgcmVwbHkgc3RhcnRpbmc6IGZyb20gdGhlIGVuZCBvZiB0aGUgdXNlcidzIHNwZWVjaCB0byBpdHMgZmlyc3Qgc291bmQuXG4gICAgICAgIGlmICghbWV0cmljcy5yZXBsaWVkICYmIGF1ZGlvLnF1ZXVlZCA8IDAuMDUgJiYgdCAtIG1ldHJpY3MubGFzdFBsYXkgPiAwLjYgJiYgbWV0cmljcy5sYXN0Vm9pY2UgPiAwICYmIHQgLSBtZXRyaWNzLmxhc3RWb2ljZSA8IDEwKSB7XG4gICAgICAgICAgbWV0cmljcy5yZXBseS5wdXNoKHQgLSBtZXRyaWNzLmxhc3RWb2ljZSk7XG4gICAgICAgICAgaWYgKG1ldHJpY3MucmVwbHkubGVuZ3RoID4gMjApIG1ldHJpY3MucmVwbHkuc2hpZnQoKTtcbiAgICAgICAgICBtZXRyaWNzLnJlcGxpZWQgPSB0cnVlO1xuICAgICAgICAgIHNob3dNZXRyaWNzKCk7XG4gICAgICAgIH1cbiAgICAgICAgbWV0cmljcy5sYXN0UGxheSA9IHQ7XG4gICAgICAgIGF1ZGlvLnBsYXkoYy5wY20pO1xuICAgICAgICBjb3VudHMucGxheSsrO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJmbHVzaFwiOiBhdWRpby5mbHVzaCgpOyBsb2coXCJvdXRcIiwgXCJmbHVzaFwiLCBcIm91dFwiKTsgYnJlYWs7XG4gICAgICBjYXNlIFwiY3VlXCI6XG4gICAgICAgIGF1ZGlvLmN1ZShjLnBjbSk7XG4gICAgICAgIGxvZyhcIm91dFwiLCBgY3VlICR7Yy5lYXJjb259YCwgXCJvdXRcIik7XG4gICAgICAgIC8vIEEgcmVxdWVzdCB0aGF0IGJlY2FtZSBhIHRhc2sgZ2V0cyBhIHRvbmUsIG5vdCBhIHNwb2tlbiByZXBseTogbm90aGluZyB0byB0aW1lLlxuICAgICAgICBpZiAoYy5lYXJjb24gPT09IFwidGFza1N0YXJ0ZWRcIikgbWV0cmljcy5yZXBsaWVkID0gdHJ1ZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwid2FrZXdvcmRcIjogZW5zdXJlQ29yZVdha2UoQm9vbGVhbihjLm9uKSk7IGJyZWFrO1xuICAgICAgY2FzZSBcInRvb2wuY2FsbFwiOiB2b2lkIHRvb2woYyk7IGJyZWFrO1xuICAgICAgY2FzZSBcInRvb2wuY2FuY2VsXCI6IGNhbmNlbFJ1bihjLnJ1biwgYy5yZWFzb24pOyBicmVhaztcbiAgICAgIGNhc2UgXCJ0b29sLnN0ZWVyXCI6IHZvaWQgc3RlZXJSdW4oYyk7IGJyZWFrO1xuICAgICAgY2FzZSBcInN0YXR1c1wiOiB7XG4gICAgICAgIGNvbnN0IHByZXYgPSBjb3JlU3RhdHVzO1xuICAgICAgICBjb3JlU3RhdHVzID0gYy5zdGF0dXM7XG4gICAgICAgIGlmIChjLnN0YXR1cyA9PT0gXCJkb3JtYW50XCIgJiYgcHJldiAhPT0gXCJkb3JtYW50XCIgJiYgY2hlY2tlZChcIndha2UtY3VlXCIpKSBhdWRpby5jdWUoU0xFRVBfVE9ORSk7XG4gICAgICAgIHNob3dTdGF0dXMoYy5zdGF0dXMgPT09IFwiZW5kZWRcIiA/IGMubWVzc2FnZSA/PyB1bmRlZmluZWQgOiB1bmRlZmluZWQpO1xuICAgICAgICBsb2coXCJzdGF0dXNcIiwgYy5zdGF0dXMgKyAoYy5tZXNzYWdlID8gYDogJHtjLm1lc3NhZ2V9YCA6IFwiXCIpLCBcInN0YXR1c1wiKTtcbiAgICAgICAgaWYgKGMuc3RhdHVzID09PSBcImVuZGVkXCIpIHsgaWYgKGMubWVzc2FnZSkgbm90ZShjLm1lc3NhZ2UpOyBlbmQoKTsgfVxuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJsbG0ucmVxdWVzdFwiOiB2b2lkIGdlbmVyYXRlKGMuaWQsIGMuYm9keSk7IGJyZWFrO1xuICAgICAgY2FzZSBcImxsbS5jYW5jZWxcIjogcmVxdWVzdHMuZ2V0KGMuaWQpPy5hYm9ydCgpOyByZXF1ZXN0cy5kZWxldGUoYy5pZCk7IGxvZyhcIm91dFwiLCBgcmVxdWVzdCAke2MuaWR9IGRyb3BwZWRgLCBcIm91dFwiKTsgYnJlYWs7XG4gICAgICBjYXNlIFwidGhpbmtpbmdcIjogdGhpbmtpbmcgPSBjLm9uOyBzaG93U3RhdHVzKCk7IGJyZWFrO1xuICAgICAgY2FzZSBcImVycm9yXCI6IG5vdGUoYy5tZXNzYWdlKTsgbG9nKFwiZXJyb3JcIiwgYy5tZXNzYWdlLCBcImVyclwiKTsgYnJlYWs7XG4gICAgICBjYXNlIFwiY2FwdGlvblwiOiBjYXB0aW9uKGMudGV4dCk7IGJyZWFrO1xuICAgICAgY2FzZSBcInRyYW5zY3JpcHRcIjpcbiAgICAgICAgdHJhbnNjcmlwdChjLnJvbGUsIGMudGV4dCwgYy5saW5lKTtcbiAgICAgICAgcmVtZW1iZXIoYy5yb2xlLCBjLnRleHQsIGMucm9sZSA9PT0gXCJhc3Npc3RhbnRcIiA/IFwiR2VtaW5pXCIgOiB1bmRlZmluZWQsIGxhc3RMaW5lID09PSBjLmxpbmUpO1xuICAgICAgICBsYXN0TGluZSA9IGMubGluZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwidGFza1wiOiB7XG4gICAgICAgIGNvbnN0IHZpZXcgPSB0YXNrcy5nZXQoYy5pZCkgPz8geyBjLCBzaW5jZTogbm93KCksIGVuZGVkOiBudWxsIH07XG4gICAgICAgIGlmIChjLnN0YXRlID09PSBcInJ1bm5pbmdcIiAmJiB2aWV3LmMuc3RhdGUgIT09IFwicnVubmluZ1wiKSB7IHZpZXcuc2luY2UgPSBub3coKTsgdmlldy5lbmRlZCA9IG51bGw7IH1cbiAgICAgICAgaWYgKGMuc3RhdGUgIT09IFwicnVubmluZ1wiICYmIHZpZXcuZW5kZWQgPT0gbnVsbCkgdmlldy5lbmRlZCA9IG5vdygpO1xuICAgICAgICB2aWV3LmMgPSBjO1xuICAgICAgICB0YXNrcy5zZXQoYy5pZCwgdmlldyk7XG4gICAgICAgIHNob3dUYXNrcygpO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJxdWVzdGlvbnNcIjogYnJlYWs7XG4gICAgICBjYXNlIFwibWljU2lsZW50XCI6ICQoXCJtaWN3YXJuXCIpLmhpZGRlbiA9ICFjLnNpbGVudDsgYnJlYWs7XG4gICAgICBjYXNlIFwidm9pY2VDb21tYW5kXCI6XG4gICAgICAgIHRvYXN0KGBIZWFyZCBcdTIwMUMke2MuaGVhcmR9XHUyMDFEOiAke2MuY29tbWFuZCA9PT0gXCJzdG9wXCIgPyBcInN0b3BwZWRcIiA6IGMuY29tbWFuZCA9PT0gXCJjYW5jZWxBbGxcIiA/IFwiY2FuY2VsbGluZyBldmVyeSB0YXNrXCIgOiBcImhhbmdpbmcgdXBcIn1gKTtcbiAgICAgICAgbG9nKFwib3V0XCIsIGB2b2ljZSBjb21tYW5kICR7Yy5jb21tYW5kfTogJHtjLmhlYXJkfWAsIFwib3V0XCIpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJsb2dcIjogbG9nKGMubGV2ZWwsIGMubWVzc2FnZSwgYy5sZXZlbCA9PT0gXCJ3YXJuXCIgPyBcIndhcm5cIiA6IFwiXCIpOyBicmVhaztcbiAgICAgIGRlZmF1bHQ6IGxvZyhcIm91dFwiLCBKU09OLnN0cmluZ2lmeShjKS5zbGljZSgwLCAzMDApLCBcIm91dFwiKTtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gb25NaWMoc2FtcGxlczogSW50MTZBcnJheSwgbGV2ZWw6IG51bWJlcikge1xuICBpZiAoc2hvdWxkRmVlZFdha2UoKSkgd2FrZUNsaWVudC5mZWVkKHNhbXBsZXMpO1xuICBpZiAod2FrZVN0YXJ0aW5nKSB7XG4gICAgY29uc3QgY29weSA9IG5ldyBVaW50OEFycmF5KHNhbXBsZXMuYnl0ZUxlbmd0aCk7XG4gICAgY29weS5zZXQobmV3IFVpbnQ4QXJyYXkoc2FtcGxlcy5idWZmZXIsIHNhbXBsZXMuYnl0ZU9mZnNldCwgc2FtcGxlcy5ieXRlTGVuZ3RoKSk7XG4gICAgb3BlbmluZ0NodW5rcy5wdXNoKGNvcHkpO1xuICAgIG9wZW5pbmdCeXRlcyArPSBjb3B5LmJ5dGVMZW5ndGg7XG4gICAgd2hpbGUgKG9wZW5pbmdCeXRlcyA+IE9QRU5JTkdfTUFYX0JZVEVTICYmIG9wZW5pbmdDaHVua3MubGVuZ3RoID4gMSkge1xuICAgICAgb3BlbmluZ0J5dGVzIC09IG9wZW5pbmdDaHVua3Muc2hpZnQoKSEuYnl0ZUxlbmd0aDtcbiAgICB9XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmICghY2FsbElkIHx8IG1lZGl1bSAhPT0gXCJ2b2ljZVwiKSByZXR1cm47XG4gIGNvdW50cy5taWMrKztcbiAgaWYgKGxldmVsID4gMC4wMyAmJiAhKG11dGVkICYmICFob2xkaW5nKSkge1xuICAgIG1ldHJpY3MubGFzdFZvaWNlID0gbm93KCk7XG4gICAgaWYgKGF1ZGlvLnF1ZXVlZCA8IDAuMDUpIG1ldHJpY3MucmVwbGllZCA9IGZhbHNlO1xuICB9XG4gIHB1c2goeyB0eXBlOiBcIm1pY1wiLCBwY206IGJ5dGVzVG9CYXNlNjQobmV3IFVpbnQ4QXJyYXkoc2FtcGxlcy5idWZmZXIsIHNhbXBsZXMuYnl0ZU9mZnNldCwgc2FtcGxlcy5ieXRlTGVuZ3RoKSkgfSk7XG59XG5cbmZ1bmN0aW9uIGNvbm5lY3Qoc2lkOiBudW1iZXIsIGNhcHRpb25zOiBib29sZWFuKSB7XG4gIGNvbnN0IHdzID0gbmV3IFdlYlNvY2tldChgJHtsb2NhdGlvbi5wcm90b2NvbCA9PT0gXCJodHRwczpcIiA/IFwid3NzXCIgOiBcIndzXCJ9Oi8vJHtsb2NhdGlvbi5ob3N0fS9saXZlJHtjYXB0aW9ucyA/IFwiP2Zvcj1jYXB0aW9uc1wiIDogXCJcIn1gKTtcbiAgc29ja2V0cy5zZXQoc2lkLCB3cyk7XG4gIGlmIChjYXB0aW9ucykgY2FwdGlvblNvY2tldHMuYWRkKHNpZCk7XG4gIGxvZyhcIm91dFwiLCBgd3MgJHtzaWR9IGNvbm5lY3QgKCR7c2VydmVyLnJvdXRlfSR7Y2FwdGlvbnMgPyBcIiwgY2FwdGlvbnNcIiA6IFwiXCJ9KWAsIFwib3V0XCIpO1xuICB3cy5vbm9wZW4gPSAoKSA9PiBwdXNoKHsgdHlwZTogXCJ3cy5vcGVuXCIsIHNpZCB9KTtcbiAgd3Mub25tZXNzYWdlID0gKG0pID0+IHB1c2goeyB0eXBlOiBcIndzLm1lc3NhZ2VcIiwgc2lkLCBkYXRhOiB0eXBlb2YgbS5kYXRhID09PSBcInN0cmluZ1wiID8gbS5kYXRhIDogXCJcIiB9KTtcbiAgd3Mub25jbG9zZSA9IChlKSA9PiB7XG4gICAgaWYgKHNvY2tldHMuZ2V0KHNpZCkgIT09IHdzICYmIHNvY2tldHMuaGFzKHNpZCkpIHJldHVybjtcbiAgICBjb25zdCBodHRwU3RhdHVzID0gZS5jb2RlID49IDQxMDAgJiYgZS5jb2RlIDwgNDYwMCA/IGUuY29kZSAtIDQwMDAgOiB1bmRlZmluZWQ7XG4gICAgcHVzaCh7IHR5cGU6IFwid3MuY2xvc2VkXCIsIHNpZCwgY29kZTogaHR0cFN0YXR1cyA/IHVuZGVmaW5lZCA6IGUuY29kZSwgcmVhc29uOiBlLnJlYXNvbiwgaHR0cFN0YXR1cyB9KTtcbiAgfTtcbn1cblxuLyoqIEEgY2hhdCdzIHJlcXVlc3QgdG8gdGhlIHRleHQgbW9kZWwsIHRocm91Z2ggdGhlIHNlcnZlcjogZWFjaCBgZGF0YTpgIGxpbmUgb2YgdGhlIG1vZGVsJ3Mgc3RyZWFtIGdvZXMgdG8gdGhlIGNvcmUgYXMgaXQgY29tZXMuICovXG5hc3luYyBmdW5jdGlvbiBnZW5lcmF0ZShpZDogbnVtYmVyLCBib2R5OiBzdHJpbmcpIHtcbiAgY29uc3QgYWJvcnQgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gIHJlcXVlc3RzLnNldChpZCwgYWJvcnQpO1xuICBsb2coXCJvdXRcIiwgYHJlcXVlc3QgJHtpZH0gXHUyMTkyICR7c2VydmVyLnRleHRNb2RlbH0gKCR7TWF0aC5yb3VuZChib2R5Lmxlbmd0aCAvIDEwMjQpfSBLQilgLCBcIm91dFwiKTtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKFwiL2dlbmVyYXRlXCIsIHsgbWV0aG9kOiBcIlBPU1RcIiwgc2lnbmFsOiBhYm9ydC5zaWduYWwsIGhlYWRlcnM6IHsgXCJjb250ZW50LXR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSwgYm9keSB9KTtcbiAgICBpZiAoIXJlc3BvbnNlLm9rIHx8ICFyZXNwb25zZS5ib2R5KSB7XG4gICAgICBjb25zdCB0ZXh0ID0gYXdhaXQgcmVzcG9uc2UudGV4dCgpLmNhdGNoKCgpID0+IFwiXCIpO1xuICAgICAgcHVzaCh7IHR5cGU6IFwibGxtLmVuZFwiLCBpZCwgc3RhdHVzOiByZXNwb25zZS5zdGF0dXMsIGVycm9yOiBgSFRUUCAke3Jlc3BvbnNlLnN0YXR1c30ke3RleHQgPyBcIjogXCIgKyB0ZXh0LnJlcGxhY2UoL1xccysvZywgXCIgXCIpLnNsaWNlKDAsIDIwMCkgOiBcIlwifWAgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IHJlYWRlciA9IHJlc3BvbnNlLmJvZHkucGlwZVRocm91Z2gobmV3IFRleHREZWNvZGVyU3RyZWFtKCkpLmdldFJlYWRlcigpO1xuICAgIGxldCBidWZmZXIgPSBcIlwiO1xuICAgIGZvciAoOzspIHtcbiAgICAgIGNvbnN0IHsgdmFsdWUsIGRvbmUgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICBpZiAoZG9uZSkgYnJlYWs7XG4gICAgICBidWZmZXIgKz0gdmFsdWU7XG4gICAgICBsZXQgY3V0O1xuICAgICAgd2hpbGUgKChjdXQgPSBidWZmZXIuaW5kZXhPZihcIlxcblwiKSkgPj0gMCkge1xuICAgICAgICBjb25zdCBsaW5lID0gYnVmZmVyLnNsaWNlKDAsIGN1dCkucmVwbGFjZSgvXFxyJC8sIFwiXCIpO1xuICAgICAgICBidWZmZXIgPSBidWZmZXIuc2xpY2UoY3V0ICsgMSk7XG4gICAgICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgoXCJkYXRhOlwiKSkgcHVzaCh7IHR5cGU6IFwibGxtLmRhdGFcIiwgaWQsIGRhdGE6IGxpbmUuc2xpY2UoNSkudHJpbSgpIH0pO1xuICAgICAgfVxuICAgIH1cbiAgICBwdXNoKHsgdHlwZTogXCJsbG0uZW5kXCIsIGlkIH0pO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBpZiAoIWFib3J0LnNpZ25hbC5hYm9ydGVkKSBwdXNoKHsgdHlwZTogXCJsbG0uZW5kXCIsIGlkLCBlcnJvcjogKGVyciBhcyBFcnJvcikubWVzc2FnZSB9KTtcbiAgfSBmaW5hbGx5IHtcbiAgICByZXF1ZXN0cy5kZWxldGUoaWQpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGNhbmNlbFJ1bihrZXk6IHN0cmluZywgcmVhc29uOiBzdHJpbmcpIHtcbiAgY29uc3QgciA9IHJ1bnMuZ2V0KGtleSk7XG4gIGxvZyhcIm91dFwiLCBgY2FuY2VsICR7a2V5fSAoJHtyZWFzb259KWAsIFwib3V0XCIpO1xuICBpZiAoIXIpIHJldHVybjtcbiAgcnVucy5kZWxldGUoa2V5KTtcbiAgci5hYm9ydC5hYm9ydCgpO1xuICAvLyBDYW5jZWxsZWQgb24gcHVycG9zZTogdGhlIGFnZW50IHN0b3BzIHRvby4gQSBjYWxsIHRoYXQgZW5kZWQgbGVhdmVzIGEgY29kaW5nIGFnZW50IHdvcmtpbmcgaW4gVDMuXG4gIGlmIChyZWFzb24gPT09IFwiY2FuY2VsbGVkXCIgJiYgIWNoZWNrZWQoXCJmYWtlaGVybWVzXCIpKSB7XG4gICAgdm9pZCBmZXRjaChyLmFnZW50ID09PSBcInQzXCIgPyBcIi9hZ2VudC9jYW5jZWxcIiA6IFwiL2hlcm1lcy9zdG9wXCIsIHsgbWV0aG9kOiBcIlBPU1RcIiwgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBjYWxsOiBjYWxsTmFtZSwgdGFza0lkOiByLnRhc2tJZCB9KSB9KTtcbiAgfVxufVxuXG4vKiogTW9yZSBmb3IgYSBydW5uaW5nIHRhc2ssIGludG8gaXRzIGN1cnJlbnQgcnVuOyBpZiB0aGUgYWdlbnQgd29uJ3QgdGFrZSBpdCwgdGhlIGNvcmUgcXVldWVzIGl0IGluc3RlYWQuICovXG5hc3luYyBmdW5jdGlvbiBzdGVlclJ1bihjOiBDb21tYW5kKSB7XG4gIGNvbnN0IHIgPSBydW5zLmdldChjLnJ1bik7XG4gIGxvZyhcIm91dFwiLCBgc3RlZXIgJHtjLnJ1bn06ICR7Yy50ZXh0fWAsIFwib3V0XCIpO1xuICBpZiAoY2hlY2tlZChcImZha2VoZXJtZXNcIikpIHJldHVybjtcbiAgY29uc3Qgb2sgPSByICE9IG51bGwgJiZcbiAgICAoYXdhaXQgZmV0Y2goYy5hZ2VudCA9PT0gXCJ0M1wiID8gXCIvYWdlbnQvc3RlZXJcIiA6IFwiL2hlcm1lcy9zdGVlclwiLCB7IG1ldGhvZDogXCJQT1NUXCIsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgY2FsbDogY2FsbE5hbWUsIHRhc2tJZDogci50YXNrSWQsIHRleHQ6IGMubWVzc2FnZSB9KSB9KS50aGVuKCh4KSA9PiB4Lm9rLCAoKSA9PiBmYWxzZSkpO1xuICBpZiAoIW9rKSBwdXNoKHsgdHlwZTogXCJ0b29sLnN0ZWVyRmFpbGVkXCIsIHJ1bjogYy5ydW4sIHRleHQ6IGMudGV4dCB9KTtcbiAgZWxzZSB0b2FzdChgJHtjLmFnZW50ID09PSBcInQzXCIgPyBcIlRoZSBjb2RpbmcgYWdlbnRcIiA6IFwiSGVybWVzXCJ9IHRvb2sgdGhlIGZvbGxvdy11cCB3aGlsZSBpdCB3b3Jrc2ApO1xufVxuXG5hc3luYyBmdW5jdGlvbiB0b29sKGM6IENvbW1hbmQpIHtcbiAgaWYgKGMua2luZCA9PT0gXCJob3N0XCIpIHtcbiAgICBsb2coXCJvdXRcIiwgYGhvc3QgdG9vbCAke2MubmFtZX0gJHtKU09OLnN0cmluZ2lmeShjLmFyZ3MpfWAsIFwib3V0XCIpO1xuICAgIGNvbnN0IGFuc3dlciA9IGMubmFtZSA9PT0gXCJ0dl92b2x1bWVcIiA/IGBUaGUgVFYgaXMgYXQgJHsoZmFrZVR2TGV2ZWwgPSBOdW1iZXIoYy5hcmdzPy5sZXZlbCA/PyBmYWtlVHZMZXZlbCkpfS5gXG4gICAgICA6IGMubmFtZSA9PT0gXCJ0dl9wYXVzZVwiID8gKGMuYXJncz8ucGF1c2UgPT09IGZhbHNlID8gXCJQbGF5aW5nLlwiIDogXCJQYXVzZWQuXCIpIDogXCJEb25lLlwiO1xuICAgIHNldFRpbWVvdXQoKCkgPT4gcHVzaCh7IHR5cGU6IFwidG9vbC5yZXN1bHRcIiwgcnVuOiBjLnJ1biwgdGV4dDogYW5zd2VyIH0pLCAzMDApO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBhZ2VudCA9IGMuYWdlbnQgPT09IFwidDNcIiA/IFwidDNcIiA6IFwiaGVybWVzXCI7XG4gIGxvZyhcIm91dFwiLCBgJHthZ2VudH0gJHtjLmZvbGxvd1VwID8gXCJmb2xsb3ctdXBcIiA6IFwidGFza1wifSBcIiR7Yy5sYWJlbH1cIiR7Yy5wcm9qZWN0ID8gYCBpbiAke2MucHJvamVjdH1gIDogXCJcIn06ICR7Yy5yZXF1ZXN0fWAsIFwib3V0XCIpO1xuICBjb25zdCBhYm9ydCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgcnVucy5zZXQoYy5ydW4sIHsgYWJvcnQsIGFnZW50LCB0YXNrSWQ6IGMudGFza0lkIH0pO1xuICBjb25zdCBkb25lID0gKHRleHQ6IHN0cmluZywgZmFpbGVkID0gZmFsc2UpID0+IHtcbiAgICBpZiAoIXJ1bnMuaGFzKGMucnVuKSkgcmV0dXJuO1xuICAgIHJ1bnMuZGVsZXRlKGMucnVuKTtcbiAgICBjb25zdCB2aWV3ID0gdGFza3MuZ2V0KGMudGFza0lkKTtcbiAgICBjb25zdCByb3cgPSByZXN1bHQoYWdlbnQsIGMubGFiZWwsIHRleHQsIGZhaWxlZCk7XG4gICAgbm90aWZ5KGAke2FnZW50ID09PSBcInQzXCIgPyBcIlQzXCIgOiBcIkhlcm1lc1wifSBcdTAwQjcgJHtjLmxhYmVsfWAsIHRleHQpO1xuICAgIGlmICghZmFpbGVkKSB7IHJlbWVtYmVyKFwiYXNzaXN0YW50XCIsIHRleHQsIGAke2FnZW50ID09PSBcInQzXCIgPyBcIlQzXCIgOiBcIkhlcm1lc1wifSBcdTAwQjcgJHtjLmxhYmVsfWApOyBsYXN0TGluZSA9IG51bGw7IH1cbiAgICBpZiAodmlldykgeyB2aWV3LnJlc3VsdCA9IHJvdzsgc2hvd1Rhc2tzKCk7IH1cbiAgICBwdXNoKHsgdHlwZTogXCJ0b29sLnJlc3VsdFwiLCBydW46IGMucnVuLCB0ZXh0LCBmYWlsZWQgfSk7XG4gIH07XG4gIGlmIChjaGVja2VkKFwiZmFrZWhlcm1lc1wiKSkge1xuICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiBkb25lKGAoRmFrZSAke2FnZW50ID09PSBcInQzXCIgPyBcIlQzXCIgOiBcIkhlcm1lc1wifSkgRG9uZTogXHUyMDFDJHtjLnJlcXVlc3R9XHUyMDFELiBOb3RoaW5nIHdhcyBhY3R1YWxseSBydW4uYCksIE51bWJlcigkPEhUTUxJbnB1dEVsZW1lbnQ+KFwiZmFrZWRlbGF5XCIpLnZhbHVlKSAqIDEwMDApO1xuICAgIGFib3J0LnNpZ25hbC5vbmFib3J0ID0gKCkgPT4gY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICByZXR1cm47XG4gIH1cbiAgdHJ5IHtcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKGFnZW50ID09PSBcInQzXCIgPyBcIi9hZ2VudFwiIDogXCIvaGVybWVzXCIsIHtcbiAgICAgIG1ldGhvZDogXCJQT1NUXCIsIHNpZ25hbDogYWJvcnQuc2lnbmFsLCBoZWFkZXJzOiB7IFwiY29udGVudC10eXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGNhbGw6IGNhbGxOYW1lLCB0YXNrSWQ6IGMudGFza0lkLCBmb2xsb3dVcDogYy5mb2xsb3dVcCwgbWVzc2FnZTogYy5tZXNzYWdlLCBsYWJlbDogYy5sYWJlbCwgcmVxdWVzdDogYy5yZXF1ZXN0LCBwcm9qZWN0OiBjLnByb2plY3QsIGFwcHJvdmFsczogXCJzY3JlZW5cIiB9KSxcbiAgICB9KTtcbiAgICBpZiAoIXJlc3BvbnNlLm9rIHx8ICFyZXNwb25zZS5ib2R5KSB0aHJvdyBuZXcgRXJyb3IoYEhUVFAgJHtyZXNwb25zZS5zdGF0dXN9YCk7XG4gICAgY29uc3QgcmVhZGVyID0gcmVzcG9uc2UuYm9keS5waXBlVGhyb3VnaChuZXcgVGV4dERlY29kZXJTdHJlYW0oKSkuZ2V0UmVhZGVyKCk7XG4gICAgbGV0IGJ1ZmZlciA9IFwiXCI7XG4gICAgZm9yICg7Oykge1xuICAgICAgY29uc3QgeyB2YWx1ZSwgZG9uZTogZmluaXNoZWQgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICBpZiAoZmluaXNoZWQpIGJyZWFrO1xuICAgICAgYnVmZmVyICs9IHZhbHVlO1xuICAgICAgbGV0IGN1dDtcbiAgICAgIHdoaWxlICgoY3V0ID0gYnVmZmVyLmluZGV4T2YoXCJcXG5cXG5cIikpID49IDApIHtcbiAgICAgICAgY29uc3QgYmxvY2sgPSBidWZmZXIuc2xpY2UoMCwgY3V0KTtcbiAgICAgICAgYnVmZmVyID0gYnVmZmVyLnNsaWNlKGN1dCArIDIpO1xuICAgICAgICBjb25zdCBldmVudCA9IGJsb2NrLm1hdGNoKC9eZXZlbnQ6ICguKikkL20pPy5bMV07XG4gICAgICAgIGlmICghZXZlbnQpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCBkYXRhID0gSlNPTi5wYXJzZShibG9jay5tYXRjaCgvXmRhdGE6ICguKikkL20pPy5bMV0gPz8gXCJ7fVwiKTtcbiAgICAgICAgaWYgKGV2ZW50ID09PSBcInByb2dyZXNzXCIpIHB1c2goeyB0eXBlOiBcInRhc2sucHJvZ3Jlc3NcIiwgdGFzazogYy50YXNrSWQsIHRleHQ6IGRhdGEudGV4dCB9KTtcbiAgICAgICAgZWxzZSBpZiAoZXZlbnQgPT09IFwidGhyZWFkXCIpIHsgY29uc3QgdmlldyA9IHRhc2tzLmdldChjLnRhc2tJZCk7IGlmICh2aWV3KSB7IHZpZXcudGhyZWFkID0gZGF0YS50aHJlYWQ7IHNob3dUYXNrcygpOyB9IH1cbiAgICAgICAgZWxzZSBpZiAoZXZlbnQgPT09IFwiYXBwcm92YWxcIikge1xuICAgICAgICAgIGNvbnN0IHZpZXcgPSB0YXNrcy5nZXQoYy50YXNrSWQpO1xuICAgICAgICAgIGlmICh2aWV3KSB7IHZpZXcuYXBwcm92YWwgPSB7IGNvbW1hbmQ6IGRhdGEuY29tbWFuZCB9OyBzaG93VGFza3ModHJ1ZSk7IH1cbiAgICAgICAgICB0b2FzdChgSGVybWVzIGFza3MgdG8gcnVuOiAke2RhdGEuY29tbWFuZC5zbGljZSgwLCA4MCl9YCk7XG4gICAgICAgICAgbm90aWZ5KGBIZXJtZXMgXHUwMEI3ICR7Yy5sYWJlbH0gbmVlZHMgeW91ciBhcHByb3ZhbGAsIGRhdGEuY29tbWFuZCk7XG4gICAgICAgICAgYXVkaW8uY3VlKEFQUFJPVkFMX1RPTkUpO1xuICAgICAgICB9XG4gICAgICAgIGVsc2UgaWYgKGV2ZW50ID09PSBcInJlc3VsdFwiKSBkb25lKGRhdGEudGV4dCwgZGF0YS5mYWlsZWQpO1xuICAgICAgICBlbHNlIGlmIChldmVudCA9PT0gXCJlcnJvclwiKSB7IHJ1bnMuZGVsZXRlKGMucnVuKTsgcHVzaCh7IHR5cGU6IFwidG9vbC5lcnJvclwiLCBydW46IGMucnVuLCBtZXNzYWdlOiBkYXRhLm1lc3NhZ2UgfSk7IH1cbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKHJ1bnMuaGFzKGMucnVuKSkgeyBydW5zLmRlbGV0ZShjLnJ1bik7IHB1c2goeyB0eXBlOiBcInRvb2wuZXJyb3JcIiwgcnVuOiBjLnJ1biwgbWVzc2FnZTogXCJ0aGUgc2VydmVyIGNsb3NlZCB0aGUgc3RyZWFtIHdpdGhvdXQgYSByZXN1bHRcIiB9KTsgfVxuICB9IGNhdGNoIChlcnIpIHtcbiAgICBpZiAoIWFib3J0LnNpZ25hbC5hYm9ydGVkICYmIHJ1bnMuaGFzKGMucnVuKSkgeyBydW5zLmRlbGV0ZShjLnJ1bik7IHB1c2goeyB0eXBlOiBcInRvb2wuZXJyb3JcIiwgcnVuOiBjLnJ1biwgbWVzc2FnZTogKGVyciBhcyBFcnJvcikubWVzc2FnZSB9KTsgfVxuICB9XG59XG5cbmZ1bmN0aW9uIG1pY09wdGlvbnMoKSB7XG4gIGNvbnN0IGFlYyA9IGNoZWNrZWQoXCJhZWNcIik7XG4gIHJldHVybiB7IGVjaG9DYW5jZWxsYXRpb246IGFlYywgbm9pc2VTdXBwcmVzc2lvbjogYWVjLCBhdXRvR2FpbkNvbnRyb2w6IGFlYyB9O1xufVxuXG5mdW5jdGlvbiBudW1iZXJTZXR0aW5nKGlkOiBzdHJpbmcsIGZhbGxiYWNrOiBudW1iZXIsIG1pbiA9IDAsIG1heCA9IDM2MDApOiBudW1iZXIge1xuICBjb25zdCBuID0gTnVtYmVyKCQ8SFRNTElucHV0RWxlbWVudD4oaWQpLnZhbHVlKTtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShuKSA/IE1hdGgubWF4KG1pbiwgTWF0aC5taW4obWF4LCBuKSkgOiBmYWxsYmFjaztcbn1cblxuZnVuY3Rpb24gZGV2ZWxvcGVyT3ZlcnJpZGVzKCkge1xuICB0cnkge1xuICAgIGNvbnN0IGdpdmVuID0gSlNPTi5wYXJzZSgkPEhUTUxUZXh0QXJlYUVsZW1lbnQ+KFwiY29uZmlnXCIpLnZhbHVlKTtcbiAgICBpZiAoIWdpdmVuIHx8IHR5cGVvZiBnaXZlbiAhPT0gXCJvYmplY3RcIikge1xuICAgICAgcmV0dXJuIHsgbm9uV2ViUGxhdGZvcm06IG51bGwgYXMgc3RyaW5nIHwgbnVsbCwgaGFzQXR0ZW50aW9uOiBmYWxzZSwgaGFzSGFuZ1VwOiBmYWxzZSwgaGFzU3RhbmRieTogZmFsc2UsIGhhc01pY1doaWxlU3BlYWtpbmc6IGZhbHNlIH07XG4gICAgfVxuICAgIGNvbnN0IG5vbldlYlBsYXRmb3JtID0gdHlwZW9mIGdpdmVuLnBsYXRmb3JtID09PSBcInN0cmluZ1wiICYmIGdpdmVuLnBsYXRmb3JtICE9PSBcIndlYlwiID8gZ2l2ZW4ucGxhdGZvcm0gOiBudWxsO1xuICAgIGNvbnN0IG1pYyA9IGdpdmVuLm1pYyAmJiB0eXBlb2YgZ2l2ZW4ubWljID09PSBcIm9iamVjdFwiID8gZ2l2ZW4ubWljIDogbnVsbDtcbiAgICByZXR1cm4ge1xuICAgICAgbm9uV2ViUGxhdGZvcm0sXG4gICAgICBoYXNBdHRlbnRpb246IGdpdmVuLmF0dGVudGlvbiAhPT0gdW5kZWZpbmVkLFxuICAgICAgaGFzSGFuZ1VwOiBnaXZlbi5oYW5nVXBBZnRlciAhPT0gdW5kZWZpbmVkLFxuICAgICAgaGFzU3RhbmRieTogZ2l2ZW4uc3RhbmRieUFmdGVyICE9PSB1bmRlZmluZWQsXG4gICAgICBoYXNNaWNXaGlsZVNwZWFraW5nOiBtaWMgIT0gbnVsbCAmJiBtaWMud2hpbGVTcGVha2luZyAhPT0gdW5kZWZpbmVkLFxuICAgIH07XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiB7IG5vbldlYlBsYXRmb3JtOiBudWxsIGFzIHN0cmluZyB8IG51bGwsIGhhc0F0dGVudGlvbjogZmFsc2UsIGhhc0hhbmdVcDogZmFsc2UsIGhhc1N0YW5kYnk6IGZhbHNlLCBoYXNNaWNXaGlsZVNwZWFraW5nOiBmYWxzZSB9O1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlYWRDb25maWcoKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICBjb25zdCBnaXZlbiA9IEpTT04ucGFyc2UoJDxIVE1MVGV4dEFyZWFFbGVtZW50PihcImNvbmZpZ1wiKS52YWx1ZSk7XG4gIGNvbnN0IGNvbmZpZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgbW9kZWw6IHNlcnZlci5tb2RlbCwgYXBpOiBzZXJ2ZXIucm91dGUgPT09IFwidmVydGV4XCIgPyBcInZlcnRleFwiIDogXCJnZW1pbmlcIiwgdG9kYXk6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKS5zbGljZSgwLCAxMCksXG4gICAgLi4uZ2l2ZW4sIHRyYWNlOiBjaGVja2VkKFwidHJhY2VcIiksXG4gIH07XG4gIGlmIChjaGVja2VkKFwicHR0XCIpKSBjb25maWcubXV0ZWQgPSB0cnVlO1xuICBpZiAoZ2l2ZW4udm9pY2UgPT09IHVuZGVmaW5lZCkgY29uZmlnLnZvaWNlID0gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJ2b2ljZVwiKS52YWx1ZTtcbiAgaWYgKGNvbmZpZy5zdGVlcmluZyA9PT0gdW5kZWZpbmVkKSBjb25maWcuc3RlZXJpbmcgPSBbXCJoZXJtZXNcIiwgXCJ0M1wiXTtcbiAgLy8gQSB3ZWIgY29uZmlnIHNhdmVkIGJlZm9yZSBoYW5kLW9mZnMgd2VyZSBuYW1lZCBpbiB3b3JkcyBnZXRzIHRoYXQgdG9vLlxuICBpZiAoY29uZmlnLmhhbmRPZmYgPT09IHVuZGVmaW5lZCAmJiBjb25maWcucGxhdGZvcm0gPT09IFwid2ViXCIpIGNvbmZpZy5oYW5kT2ZmID0gXCJuYW1lZFwiO1xuICAvLyBBbmQgb25lIHNhdmVkIGJlZm9yZSB0aGUgcGFnZSBmb2xsb3dlZCB0aGUgdXNlcidzIGxlYWQgKHN1cGVydmlzZSkgZ2V0cyB0aGF0LlxuICBpZiAoY29uZmlnLnN1cGVydmlzZSA9PT0gdW5kZWZpbmVkICYmIGNvbmZpZy5wbGF0Zm9ybSA9PT0gXCJ3ZWJcIikgY29uZmlnLnN1cGVydmlzZSA9IHRydWU7XG4gIGlmIChjaGVja2VkKFwiY29kaW5nXCIpICYmIChzZXJ2ZXIudDMgfHwgY2hlY2tlZChcImZha2VoZXJtZXNcIikpICYmIGNvbmZpZy5jb2RpbmdBZ2VudCA9PT0gdW5kZWZpbmVkKSBjb25maWcuY29kaW5nQWdlbnQgPSB7IHByb2plY3RzOiBzZXJ2ZXIudDMgPz8gW10gfTtcbiAgaWYgKGNoZWNrZWQoXCJjYXB0aW9uc1wiKSAmJiBzZXJ2ZXIuY2FwdGlvbnNNb2RlbCAmJiBjb25maWcuY2FwdGlvbnMgPT09IHVuZGVmaW5lZCkgY29uZmlnLmNhcHRpb25zID0geyBtb2RlbDogc2VydmVyLmNhcHRpb25zTW9kZWwgfTtcbiAgLy8gQXBwbHkgZWFjaCBTZXR0aW5ncyBzaWduYWxpbmcgZmllbGQgaW5kZXBlbmRlbnRseSBmb3Igd2ViIGNvbmZpZ3MgdW5sZXNzIHNldCBpbiBEZXZlbG9wZXIgSlNPTiAvIHByZXNldC5cbiAgY29uc3Qgbm9uV2ViID0gdHlwZW9mIGdpdmVuLnBsYXRmb3JtID09PSBcInN0cmluZ1wiICYmIGdpdmVuLnBsYXRmb3JtICE9PSBcIndlYlwiO1xuICBpZiAoIW5vbldlYikge1xuICAgIGNvbnN0IHNpZ25hbGluZyA9ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwic2lnbmFsaW5nXCIpLnZhbHVlO1xuICAgIGlmIChnaXZlbi5hdHRlbnRpb24gPT09IHVuZGVmaW5lZCAmJiAoc2lnbmFsaW5nID09PSBcIndpbmRvd1wiIHx8IHNpZ25hbGluZyA9PT0gXCJlY2hvXCIpKSB7XG4gICAgICBjb25maWcuYXR0ZW50aW9uID0ge1xuICAgICAgICBtb2RlOiBcIndpbmRvd1wiLFxuICAgICAgICBhZnRlcldha2U6IG51bWJlclNldHRpbmcoXCJhdHRuLWFmdGVyLXdha2VcIiwgOCwgMSwgNjApLFxuICAgICAgICB3aW5kb3c6IG51bWJlclNldHRpbmcoXCJhdHRuLXdpbmRvd1wiLCA1LCAwLCA2MCksXG4gICAgICAgIGFmdGVyUXVlc3Rpb246IG51bWJlclNldHRpbmcoXCJhdHRuLWFmdGVyLXF1ZXN0aW9uXCIsIDEwLCAwLCA2MCksXG4gICAgICAgIGFmdGVySGFuZE9mZjogMyxcbiAgICAgICAgYWZ0ZXJBbm5vdW5jZW1lbnQ6IDAsXG4gICAgICB9O1xuICAgIH1cbiAgICBpZiAoZ2l2ZW4uaGFuZ1VwQWZ0ZXIgPT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uZmlnLmhhbmdVcEFmdGVyID0gbnVtYmVyU2V0dGluZyhcImhhbmd1cC1hZnRlclwiLCBzaWduYWxpbmcgPT09IFwiZWNob1wiID8gMTUgOiAzMDAsIDAsIDM2MDApO1xuICAgIH1cbiAgICBpZiAoc2lnbmFsaW5nID09PSBcImVjaG9cIiAmJiBnaXZlbi5zdGFuZGJ5QWZ0ZXIgPT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uZmlnLnN0YW5kYnlBZnRlciA9IDg7XG4gICAgfVxuICAgIGNvbnN0IGdpdmVuTWljID0gZ2l2ZW4ubWljICYmIHR5cGVvZiBnaXZlbi5taWMgPT09IFwib2JqZWN0XCIgPyAoZ2l2ZW4ubWljIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA6IG51bGw7XG4gICAgaWYgKCghZ2l2ZW5NaWMgfHwgZ2l2ZW5NaWMud2hpbGVTcGVha2luZyA9PT0gdW5kZWZpbmVkKSAmJiAoY2hlY2tlZChcIndha2UtYmFyZ2VcIikgfHwgc2lnbmFsaW5nID09PSBcImVjaG9cIikpIHtcbiAgICAgIGNvbmZpZy5taWMgPSB7IGdhaW5EYjogMCwgLi4uKGdpdmVuTWljID8/IHt9KSwgd2hpbGVTcGVha2luZzogXCJ3YWtlXCIgfTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGNvbmZpZztcbn1cblxuLyoqIFN0YXJ0cyBhIHZvaWNlIGNhbGwsIG9yIHdpdGggW3R5cGVkXSBhIGNoYXQgKHRoZSBjb3JlJ3MgbWVkaXVtIFwidGV4dFwiOiBubyBhdWRpbywgYSB0ZXh0IG1vZGVsKS4gKi9cbmFzeW5jIGZ1bmN0aW9uIHN0YXJ0KGNhcnJ5T24gPSBmYWxzZSwgdHlwZWQgPSBmYWxzZSk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBpZiAoc3RhcnRpbmdDYWxsIHx8IGNhbGxJZCkgcmV0dXJuIGZhbHNlO1xuICBzdGFydGluZ0NhbGwgPSB0cnVlO1xuICB0cnkge1xuICAgIGF3YWl0IGVuZGluZztcbiAgICBpZiAoY2FsbElkKSByZXR1cm4gZmFsc2U7XG4gICAgbGV0IGdpdmVuOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICB0cnkge1xuICAgICAgZ2l2ZW4gPSByZWFkQ29uZmlnKCk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICB0b2FzdChgVGhlIGRldmVsb3BlciBzZXR0aW5ncyBhcmVuJ3QgdmFsaWQgSlNPTjogJHsoZXJyIGFzIEVycm9yKS5tZXNzYWdlfWApO1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICBpZiAodHlwZWQpIHtcbiAgICAgIGlmICghc2VydmVyLnRleHRNb2RlbCkgeyB0b2FzdChcIlRoaXMgc2VydmVyIGhhcyBubyB0ZXh0IG1vZGVsIGZvciBhIGNoYXQ6IHN0YXJ0IGEgY2FsbCB0byB0eXBlIHRvIGl0XCIpOyByZXR1cm4gZmFsc2U7IH1cbiAgICAgIGdpdmVuID0geyAuLi5naXZlbiwgbWVkaXVtOiBcInRleHRcIiwgbXV0ZWQ6IGZhbHNlIH07XG4gICAgICBkZWxldGUgZ2l2ZW4uY2FwdGlvbnM7XG4gICAgfVxuICAgICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiY2FsbFwiKS5kaXNhYmxlZCA9IHRydWU7XG4gICAgJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJoZXJvLWNhbGxcIikuZGlzYWJsZWQgPSB0cnVlO1xuICAgIGlmIChcIk5vdGlmaWNhdGlvblwiIGluIHdpbmRvdyAmJiBOb3RpZmljYXRpb24ucGVybWlzc2lvbiA9PT0gXCJkZWZhdWx0XCIpIHZvaWQgTm90aWZpY2F0aW9uLnJlcXVlc3RQZXJtaXNzaW9uKCkuY2F0Y2goKCkgPT4ge30pO1xuICAgIGxldCBsb2FkZWRDb3JlOiBDb3JlO1xuICAgIHRyeSB7XG4gICAgICBpZiAoIXR5cGVkKSBhd2FpdCBhdWRpby5vcGVuKCk7XG4gICAgICBsb2FkZWRDb3JlID0gYXdhaXQgbG9hZENvcmUoKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJjYWxsXCIpLmRpc2FibGVkID0gZmFsc2U7XG4gICAgICAkPEhUTUxCdXR0b25FbGVtZW50PihcImhlcm8tY2FsbFwiKS5kaXNhYmxlZCA9IGZhbHNlO1xuICAgIH1cbiAgICBpZiAoY2FsbElkKSByZXR1cm4gZmFsc2U7XG4gICAgY29yZSA9IGxvYWRlZENvcmU7XG4gICAgaWYgKHR5cGVkKSB7XG4gICAgICB3YWtlU3RhcnRpbmcgPSBmYWxzZTtcbiAgICAgIG9wZW5pbmdDaHVua3MgPSBbXTtcbiAgICAgIG9wZW5pbmdCeXRlcyA9IDA7XG4gICAgICBpZiAod2FrZUFybWVkKSBhdWRpby5zdG9wTWljKCk7XG4gICAgfVxuICAgIG1lZGl1bSA9IHR5cGVkID8gXCJ0ZXh0XCIgOiBcInZvaWNlXCI7XG4gICAgdGhpbmtpbmcgPSBmYWxzZTtcbiAgICAkKFwidmVyc2lvblwiKS50ZXh0Q29udGVudCA9IGNvcmUudmVyc2lvbjtcbiAgICAkKFwibG9nXCIpLmlubmVySFRNTCA9IFwiXCI7XG4gICAgaWYgKCF0eXBlZCAmJiAodGFza3Muc2l6ZSA+IDAgfHwgJChcInRyYW5zY3JpcHRcIikuY2hpbGRFbGVtZW50Q291bnQgPiAxKSkgbm90ZShgTmV3IGNhbGwgXHUwMEI3ICR7bmV3IERhdGUoKS50b0xvY2FsZVRpbWVTdHJpbmcoKX1gKTtcbiAgICBzY3JvbGxEb3duKHRydWUpO1xuICAgIHRhc2tzLmNsZWFyKCk7XG4gICAgc2hvd1Rhc2tzKCk7XG4gICAgY291bnRzID0geyBtaWM6IDAsIHBsYXk6IDAsIHNlbnQ6IDAgfTtcbiAgICBtZXRyaWNzLnJlcGx5ID0gW107XG4gICAgc3RhcnRlZEF0ID0gbm93KCk7XG4gICAgbXV0ZWQgPSBnaXZlbi5tdXRlZCA9PT0gdHJ1ZTtcbiAgICAvLyBDYXJyeWluZyBvbjogdGhlIG1vZGVsIGdldHMgdGhlIGxhc3QgY29udmVyc2F0aW9uIGFzIGEgcmVjYXAuIFRoZSBjb3JlIGNhcHMgaXQsIGxhdGVzdCBsaW5lcyBmaXJzdC5cbiAgICAvLyBBIGNoYXQgYWx3YXlzIGNhcnJpZXMgb24gZnJvbSB3aGF0J3Mgb24gdGhlIHNjcmVlbiAoYW4gZWFybGllciBjYWxsIG9yIGNoYXQgb24gdGhpcyBwYWdlKS5cbiAgICBpZiAodHlwZWQpIHsgaWYgKGNoYXQubGVuZ3RoID4gMCAmJiBnaXZlbi5oaXN0b3J5ID09PSB1bmRlZmluZWQpIGdpdmVuLmhpc3RvcnkgPSBjaGF0OyB9XG4gICAgZWxzZSBpZiAoY2FycnlPbiAmJiBnaXZlbi5oaXN0b3J5ID09PSB1bmRlZmluZWQpIGdpdmVuLmhpc3RvcnkgPSBzYXZlZEhpc3RvcnkoKTtcbiAgICBlbHNlIGlmICghY2FycnlPbikgY2hhdCA9IFtdO1xuICAgIGlmIChjYXJyeU9uICYmICF0eXBlZCkgY2hhdCA9IHNhdmVkSGlzdG9yeSgpO1xuICAgIGxhc3RMaW5lID0gbnVsbDtcbiAgICBvcGVuTGluZSA9IG51bGw7XG4gICAgc3luY1Jlc3VtZUJ1dHRvbnMoZmFsc2UpO1xuICAgIGNhbGxOYW1lID0gYCR7bmV3IERhdGUoKS50b0lTT1N0cmluZygpLnJlcGxhY2UoL1s6Ll0vZywgXCItXCIpfS0ke3R5cGVkID8gXCJjaGF0XCIgOiBcIndlYlwifS0ke2NvcmUudmVyc2lvbn1gO1xuICAgIGNvbnN0IGNyZWF0ZWQgPSBKU09OLnBhcnNlKGNvcmUuY3JlYXRlKEpTT04uc3RyaW5naWZ5KGdpdmVuKSwgbm93KCkpKTtcbiAgICBjYWxsSWQgPSBjcmVhdGVkLmlkO1xuICAgIGlmICghdHlwZWQpIHtcbiAgICAgIHNldENhbGxCdXR0b24odHJ1ZSk7XG4gICAgICAkPEhUTUxCdXR0b25FbGVtZW50PihcIm1pY1wiKS5kaXNhYmxlZCA9IGZhbHNlO1xuICAgIH1cbiAgICAkPEhUTUxCdXR0b25FbGVtZW50PihcImh1c2hcIikuZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAkKFwibWljXCIpLmNsYXNzTGlzdC50b2dnbGUoXCJtdXRlZFwiLCBtdXRlZCk7XG4gICAgcnVuKGNyZWF0ZWQuY29tbWFuZHMpO1xuICAgIHNob3dTdGF0dXMoKTtcbiAgICB0aWNrZXIgPSB3aW5kb3cuc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgICAgcHVzaCh7IHR5cGU6IFwidGlja1wiIH0pO1xuICAgICAgY29uc3QgbGV2ZWwgPSBtdXRlZCAmJiAhaG9sZGluZyA/IDAgOiBhdWRpby5sZXZlbDtcbiAgICAgIGNvbnN0IHN0cmVuZ3RoID0gTWF0aC5taW4oMSwgbGV2ZWwgKiAxMik7XG4gICAgICAkKFwicmluZ1wiKS5zdHlsZS5vcGFjaXR5ID0gU3RyaW5nKHN0cmVuZ3RoKTtcbiAgICAgICQoXCJyaW5nXCIpLnN0eWxlLnRyYW5zZm9ybSA9IGBzY2FsZSgkeygxICsgc3RyZW5ndGggKiAwLjEyKS50b0ZpeGVkKDMpfSlgO1xuICAgICAgJChcImNvdW50c1wiKS50ZXh0Q29udGVudCA9IGBtaWMgJHtjb3VudHMubWljfSBcdTAwQjcgc2VudCAke2NvdW50cy5zZW50fSBcdTAwQjcgcGxheWVkICR7Y291bnRzLnBsYXl9IFx1MDBCNyBxdWV1ZWQgJHthdWRpby5xdWV1ZWQudG9GaXhlZCgxKX0gc2A7XG4gICAgICBzaG93U3RhdHVzKCk7XG4gICAgfSwgMTAwKTtcbiAgICB0cmFjZVRpbWVyID0gd2luZG93LnNldEludGVydmFsKCgpID0+IHsgdm9pZCBzYXZlVHJhY2UoKTsgdm9pZCBwaW5nKCk7IHNob3dUYXNrcygpOyB9LCA1MDAwKTtcbiAgICB2b2lkIHBpbmcoKTtcbiAgICBpZiAoIXR5cGVkKSB7XG4gICAgICBzdG9wV29yZHMuc3RhcnQoKTtcbiAgICAgIGF3YWl0IGFjcXVpcmVXYWtlTG9jaygpO1xuICAgIH1cbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSBmaW5hbGx5IHtcbiAgICBzdGFydGluZ0NhbGwgPSBmYWxzZTtcbiAgfVxufVxuXG4vKiogVGhlIENhbGwgYnV0dG9uOiBoYW5ncyB1cCBhIGNhbGw7IHN0YXJ0cyBvbmU7IG9yLCB3aXRoIGEgY2hhdCBvbiwgZW5kcyB0aGUgY2hhdCBhbmQgY2FycmllcyBpdHMgY29udmVyc2F0aW9uIG9uIGJ5IHZvaWNlLiAqL1xuYXN5bmMgZnVuY3Rpb24gY2FsbEJ1dHRvbigpIHtcbiAgaWYgKGNhbGxJZCAmJiBtZWRpdW0gPT09IFwidm9pY2VcIikgeyBoYW5nVXAoKTsgcmV0dXJuOyB9XG4gIGlmIChjYWxsSWQpIHtcbiAgICAvLyBBIGNhbGwgY2FuJ3QgdGFrZSBvdmVyIHRoZSBjaGF0J3MgdGFza3MsIGFuZCBlbmRpbmcgdGhlIGNoYXQgd291bGQgc3RvcCB0aGVtLlxuICAgIGlmIChbLi4udGFza3MudmFsdWVzKCldLnNvbWUoKHYpID0+IHYuYy5zdGF0ZSA9PT0gXCJydW5uaW5nXCIpKSB7IHRvYXN0KFwiVGhlIGNoYXQncyB0YXNrcyBhcmUgc3RpbGwgcnVubmluZzogd2FpdCBmb3IgdGhlbSBvciBjYW5jZWwgdGhlbSwgdGhlbiBjYWxsXCIpOyByZXR1cm47IH1cbiAgICBwdXNoKHsgdHlwZTogXCJzdG9wXCIgfSk7XG4gICAgYXdhaXQgc3RhcnQodHJ1ZSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGF3YWl0IHN0YXJ0KCk7XG59XG5cbmZ1bmN0aW9uIGhhbmdVcCgpIHtcbiAgaWYgKGNhbGxJZCkgcHVzaCh7IHR5cGU6IFwic3RvcFwiLCBtZXNzYWdlOiBcIllvdSBodW5nIHVwLlwiIH0pO1xufVxuXG5mdW5jdGlvbiBlbmQoKSB7XG4gIHdpbmRvdy5jbGVhckludGVydmFsKHRpY2tlcik7XG4gIHdpbmRvdy5jbGVhckludGVydmFsKHRyYWNlVGltZXIpO1xuICBzdG9wV29yZHMuc3RvcCgpO1xuICBjb3JlV2FudHNXYWtlID0gZmFsc2U7XG4gIHdha2VTdGFydGluZyA9IGZhbHNlO1xuICBvcGVuaW5nQ2h1bmtzID0gW107XG4gIG9wZW5pbmdCeXRlcyA9IDA7XG4gIGNvbnN0IGZpbmlzaGVkSWQgPSBjYWxsSWQ7XG4gIGNvbnN0IGZpbmlzaGVkQ29yZSA9IGNvcmU7XG4gIGNhbGxJZCA9IDA7XG4gIGVuZGluZyA9IHNhdmVUcmFjZShmaW5pc2hlZElkLCBmaW5pc2hlZENvcmUpLnRoZW4oKCkgPT4geyBpZiAoZmluaXNoZWRDb3JlICYmIGZpbmlzaGVkSWQpIGZpbmlzaGVkQ29yZS5kaXNwb3NlKGZpbmlzaGVkSWQpOyBzaG93VGFza3MoKTsgc3luY1dha2VVaSgpOyB9KTtcbiAgaWYgKHdha2VBcm1lZCkge1xuICAgIGF1ZGlvLnN0b3BQbGF5YmFjaygpO1xuICAgIHdha2VDbGllbnQucmVzZXQoKTtcbiAgICB2b2lkIGF1ZGlvLmVuc3VyZU1pYyhvbk1pYywgbWljT3B0aW9ucygpKS5jYXRjaCgoZXJyKSA9PiB7XG4gICAgICBsb2coXCJlcnJvclwiLCBgd2FrZSBtaWNyb3Bob25lOiAke2Vyci5tZXNzYWdlfWAsIFwiZXJyXCIpO1xuICAgICAgdG9hc3QoYFdha2UgbWljcm9waG9uZTogJHtlcnIubWVzc2FnZX1gKTtcbiAgICAgIHZvaWQgYXJtV2FrZShmYWxzZSk7XG4gICAgfSk7XG4gIH0gZWxzZSB7XG4gICAgYXVkaW8uc3RvcCgpO1xuICAgIHJlbGVhc2VXYWtlTG9jaygpO1xuICB9XG4gIGZvciAoY29uc3Qgd3Mgb2Ygc29ja2V0cy52YWx1ZXMoKSkgd3MuY2xvc2UoKTtcbiAgc29ja2V0cy5jbGVhcigpO1xuICBmb3IgKGNvbnN0IHIgb2YgcnVucy52YWx1ZXMoKSkgci5hYm9ydC5hYm9ydCgpO1xuICBydW5zLmNsZWFyKCk7XG4gIGZvciAoY29uc3QgciBvZiByZXF1ZXN0cy52YWx1ZXMoKSkgci5hYm9ydCgpO1xuICByZXF1ZXN0cy5jbGVhcigpO1xuICB0aGlua2luZyA9IGZhbHNlO1xuICBzZXRDYWxsQnV0dG9uKGZhbHNlKTtcbiAgZm9yIChjb25zdCBpZCBvZiBbXCJtaWNcIiwgXCJodXNoXCJdKSAkPEhUTUxCdXR0b25FbGVtZW50PihpZCkuZGlzYWJsZWQgPSB0cnVlO1xuICAkKFwicmluZ1wiKS5zdHlsZS5vcGFjaXR5ID0gXCIwXCI7XG4gICQoXCJyaW5nXCIpLnN0eWxlLnRyYW5zZm9ybSA9IFwiXCI7XG4gICQoXCJjYWxsYmFyXCIpLmhpZGRlbiA9IHRydWU7XG4gICQoXCJtaWN3YXJuXCIpLmhpZGRlbiA9IHRydWU7XG4gIGRvY3VtZW50LmJvZHkuZGF0YXNldC5zdGF0ZSA9IHdha2VBcm1lZCA/IFwiYXJtZWRcIiA6IFwiaWRsZVwiO1xuICBkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5yZW1vdmUoXCJpbi1zZXNzaW9uXCIpO1xuICBzeW5jUmVzdW1lQnV0dG9ucyhjaGF0Lmxlbmd0aCA+IDApO1xuICB2b2lkIHNob3dFYXJsaWVyKCk7XG4gIHN5bmNXYWtlVWkoKTtcbn1cblxuZnVuY3Rpb24gc2V0TXV0ZWQodmFsdWU6IGJvb2xlYW4pIHtcbiAgaWYgKCFjYWxsSWQgfHwgbXV0ZWQgPT09IHZhbHVlKSByZXR1cm47XG4gIG11dGVkID0gdmFsdWU7XG4gICQoXCJtaWNcIikuY2xhc3NMaXN0LnRvZ2dsZShcIm11dGVkXCIsIG11dGVkKTtcbiAgcHVzaCh7IHR5cGU6IG11dGVkID8gXCJtdXRlXCIgOiBcInVubXV0ZVwiIH0pO1xuICBzaG93U3RhdHVzKCk7XG59XG5cbi8qKiBTZW5kcyB3aGF0IHRoZSB0cmFjZSBrZXB0IHNpbmNlIGxhc3QgdGltZSB0byB0aGUgZGV2IHNlcnZlciwgYXMgSlNPTiBsaW5lczogYSBoZWFkZXIsIHRoZW4gZXZlbnRzLiAqL1xuYXN5bmMgZnVuY3Rpb24gc2F2ZVRyYWNlKGlkID0gY2FsbElkLCB0YXJnZXRDb3JlID0gY29yZSkge1xuICBpZiAoIXRhcmdldENvcmUgfHwgIWlkIHx8ICFjaGVja2VkKFwidHJhY2VcIikpIHJldHVybjtcbiAgY29uc3Qga2VwdCA9IEpTT04ucGFyc2UodGFyZ2V0Q29yZS50cmFjZShpZCkpO1xuICBpZiAoIWtlcHQpIHJldHVybjtcbiAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG4gIGlmIChrZXB0LmNvbmZpZykgbGluZXMucHVzaChKU09OLnN0cmluZ2lmeSh7IHZlcnNpb246IGtlcHQudmVyc2lvbiwgY29uZmlnOiBrZXB0LmNvbmZpZywgc3RhcnQ6IGtlcHQuc3RhcnQgfSkpO1xuICBmb3IgKGNvbnN0IGUgb2Yga2VwdC5ldmVudHMpIGxpbmVzLnB1c2goSlNPTi5zdHJpbmdpZnkoZSkpO1xuICBpZiAobGluZXMubGVuZ3RoID09PSAwKSByZXR1cm47XG4gIGF3YWl0IGZldGNoKGAvdHJhY2VzP25hbWU9JHtlbmNvZGVVUklDb21wb25lbnQoY2FsbE5hbWUpfS5qc29ubGAsIHsgbWV0aG9kOiBcIlBPU1RcIiwgYm9keTogbGluZXMuam9pbihcIlxcblwiKSArIFwiXFxuXCIgfSkuY2F0Y2goKCkgPT4ge30pO1xuICAkKFwidHJhY2VuYW1lXCIpLnRleHRDb250ZW50ID0gYHRyYWNlICR7Y2FsbE5hbWV9Lmpzb25sYDtcbn1cblxuLy8gXCJTdG9wXCIgYW5kIFwiZ29vZGJ5ZVwiIGhlYXJkIGJ5IHRoZSBicm93c2VyJ3Mgb3duIHJlY29nbml6ZXI6IHF1aWNrZXIgdGhhbiB0aGUgbW9kZWwncyB0cmFuc2NyaXB0LFxuLy8gYW5kIGl0IHdvcmtzIHdoaWxlIHRoZSBtb2RlbCdzIHJlcGx5IHBsYXlzIGV2ZW4gd2hlbiB0aGUgbW9kZWwgaXNuJ3QgaGVhcmluZyB0aGUgbWljcm9waG9uZS5cblxuY2xhc3MgU3RvcFdvcmRzIHtcbiAgcHJpdmF0ZSByZWM6IGFueSA9IG51bGw7XG4gIHByaXZhdGUgb24gPSBmYWxzZTtcbiAgcHJpdmF0ZSBjb21tYW5kcyA9IHsgc3RvcDogW10gYXMgc3RyaW5nW10sIGhhbmdVcDogW10gYXMgc3RyaW5nW10sIGNhbmNlbEFsbDogW10gYXMgc3RyaW5nW10gfTtcblxuICBnZXQgc3VwcG9ydGVkKCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiBcIndlYmtpdFNwZWVjaFJlY29nbml0aW9uXCIgaW4gd2luZG93IHx8IFwiU3BlZWNoUmVjb2duaXRpb25cIiBpbiB3aW5kb3c7XG4gIH1cblxuICBzdGFydCgpIHtcbiAgICBpZiAoIWNoZWNrZWQoXCJzdG9wd29yZFwiKSB8fCAhdGhpcy5zdXBwb3J0ZWQgfHwgIWNvcmUpIHJldHVybjtcbiAgICB0aGlzLmNvbW1hbmRzID0gSlNPTi5wYXJzZShjb3JlLmRlZmF1bHRzKCkpLnZvaWNlQ29tbWFuZHM7XG4gICAgY29uc3QgUmVjb2duaXRpb24gPSAod2luZG93IGFzIGFueSkuU3BlZWNoUmVjb2duaXRpb24gPz8gKHdpbmRvdyBhcyBhbnkpLndlYmtpdFNwZWVjaFJlY29nbml0aW9uO1xuICAgIHRoaXMucmVjID0gbmV3IFJlY29nbml0aW9uKCk7XG4gICAgdGhpcy5yZWMuY29udGludW91cyA9IHRydWU7XG4gICAgdGhpcy5yZWMuaW50ZXJpbVJlc3VsdHMgPSB0cnVlO1xuICAgIHRoaXMucmVjLmxhbmcgPSBuYXZpZ2F0b3IubGFuZ3VhZ2UgfHwgXCJlbi1HQlwiO1xuICAgIHRoaXMucmVjLm9ucmVzdWx0ID0gKGU6IGFueSkgPT4ge1xuICAgICAgZm9yIChsZXQgaSA9IGUucmVzdWx0SW5kZXg7IGkgPCBlLnJlc3VsdHMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgY29uc3QgdGV4dCA9IGUucmVzdWx0c1tpXVswXS50cmFuc2NyaXB0IGFzIHN0cmluZztcbiAgICAgICAgY29uc3QgY29tbWFuZCA9IGNvbW1hbmRJbih0ZXh0LCB0aGlzLmNvbW1hbmRzLCBbXCJXb29kaG91c2VcIiwgXCJIZXJtZXNcIiwgXCJCZW50b1wiXSk7XG4gICAgICAgIGlmIChjb21tYW5kID09PSBcInN0b3BcIiAmJiBhdWRpby5xdWV1ZWQgPiAwLjA1KSB7XG4gICAgICAgICAgbG9nKFwib3V0XCIsIGBsb2NhbCBzdG9wIHdvcmQ6ICR7dGV4dH1gLCBcIm91dFwiKTtcbiAgICAgICAgICB0b2FzdChgSGVhcmQgXHUyMDFDJHt0ZXh0LnRyaW0oKX1cdTIwMUQ6IHN0b3BwZWRgKTtcbiAgICAgICAgICBwdXNoKHsgdHlwZTogXCJpbnRlcnJ1cHRcIiB9KTtcbiAgICAgICAgfSBlbHNlIGlmIChjb21tYW5kID09PSBcImNhbmNlbEFsbFwiICYmIGUucmVzdWx0c1tpXS5pc0ZpbmFsKSB7XG4gICAgICAgICAgbG9nKFwib3V0XCIsIGBsb2NhbCBjYW5jZWwtYWxsOiAke3RleHR9YCwgXCJvdXRcIik7XG4gICAgICAgICAgcHVzaCh7IHR5cGU6IFwiY2FuY2VsQWxsXCIgfSk7XG4gICAgICAgICAgcHVzaCh7IHR5cGU6IFwiaW50ZXJydXB0XCIgfSk7XG4gICAgICAgIH0gZWxzZSBpZiAoY29tbWFuZCA9PT0gXCJoYW5nVXBcIiAmJiBlLnJlc3VsdHNbaV0uaXNGaW5hbCkge1xuICAgICAgICAgIGxvZyhcIm91dFwiLCBgbG9jYWwgaGFuZy11cDogJHt0ZXh0fWAsIFwib3V0XCIpO1xuICAgICAgICAgIGhhbmdVcCgpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfTtcbiAgICB0aGlzLnJlYy5vbmVuZCA9ICgpID0+IHsgaWYgKHRoaXMub24pIHNldFRpbWVvdXQoKCkgPT4geyB0cnkgeyB0aGlzLnJlYz8uc3RhcnQoKTsgfSBjYXRjaCB7fSB9LCAyNTApOyB9O1xuICAgIHRoaXMucmVjLm9uZXJyb3IgPSAoZTogYW55KSA9PiB7IGlmIChlLmVycm9yID09PSBcIm5vdC1hbGxvd2VkXCIpIHRoaXMub24gPSBmYWxzZTsgfTtcbiAgICB0aGlzLm9uID0gdHJ1ZTtcbiAgICB0cnkgeyB0aGlzLnJlYy5zdGFydCgpOyB9IGNhdGNoIHt9XG4gIH1cblxuICBzdG9wKCkge1xuICAgIHRoaXMub24gPSBmYWxzZTtcbiAgICB0cnkgeyB0aGlzLnJlYz8uc3RvcCgpOyB9IGNhdGNoIHt9XG4gICAgdGhpcy5yZWMgPSBudWxsO1xuICB9XG59XG5jb25zdCBzdG9wV29yZHMgPSBuZXcgU3RvcFdvcmRzKCk7XG5cbi8vIExvY2FsIHdha2Ugd29yZCBsb29wIChMaXZlS2l0IFdha2VXb3JkIE9OTlggaW4gYSBXZWIgV29ya2VyKTogbGlzdGVucyBiZXR3ZWVuIGNhbGxzIHdoZW4gYXJtZWQsXG4vLyBhbmQgaW5zaWRlIGFuIGFjdGl2ZSBjYWxsIHdoZW5ldmVyIHRoZSBjb3JlIGFza3MgKGB3YWtld29yZDogb25gOiBkb3JtYW50IG9yIHdoaWxlU3BlYWtpbmcgXCJ3YWtlXCIpLlxuXG5hc3luYyBmdW5jdGlvbiBhY3F1aXJlV2FrZUxvY2soKSB7XG4gIGlmICh3YWtlTG9jayB8fCBkb2N1bWVudC5oaWRkZW4pIHJldHVybjtcbiAgdHJ5IHsgd2FrZUxvY2sgPSBhd2FpdCAobmF2aWdhdG9yIGFzIGFueSkud2FrZUxvY2s/LnJlcXVlc3QoXCJzY3JlZW5cIik7IH0gY2F0Y2gge31cbn1cblxuZnVuY3Rpb24gcmVsZWFzZVdha2VMb2NrKCkge1xuICB2b2lkIHdha2VMb2NrPy5yZWxlYXNlKCkuY2F0Y2goKCkgPT4ge30pO1xuICB3YWtlTG9jayA9IG51bGw7XG59XG5cbmZ1bmN0aW9uIHNlbGVjdGVkV2FrZU1vZGVsKCk6IFdha2VNb2RlbEluZm8gfCBudWxsIHtcbiAgY29uc3QgbW9kZWxzID0gc2VydmVyPy53YWtlTW9kZWxzID8/IFtdO1xuICBpZiAobW9kZWxzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHBpY2sgPSAkPEhUTUxTZWxlY3RFbGVtZW50PihcIndha2UtbW9kZWxcIikudmFsdWU7XG4gIHJldHVybiBtb2RlbHMuZmluZCgobSkgPT4gbS5pZCA9PT0gcGljaykgPz8gbW9kZWxzLmZpbmQoKG0pID0+IG0uaWQgPT09IFwicGVubnl3b3J0aFwiKSA/PyBtb2RlbHNbMF07XG59XG5cbmZ1bmN0aW9uIHdha2VUaHJlc2hvbGQoKTogbnVtYmVyIHtcbiAgY29uc3QgbiA9IE51bWJlcigkPEhUTUxJbnB1dEVsZW1lbnQ+KFwid2FrZS10aHJlc2hvbGRcIikudmFsdWUpO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pID8gTWF0aC5tYXgoMC4xLCBNYXRoLm1pbigwLjk5LCBuKSkgOiAwLjc7XG59XG5cbmZ1bmN0aW9uIHNob3VsZEZlZWRXYWtlKCk6IGJvb2xlYW4ge1xuICBpZiAod2FrZVN0YXJ0aW5nIHx8IHN0YXJ0aW5nQ2FsbCkgcmV0dXJuIGZhbHNlO1xuICBpZiAoY2FsbElkID09PSAwKSByZXR1cm4gd2FrZUFybWVkO1xuICByZXR1cm4gbWVkaXVtID09PSBcInZvaWNlXCIgJiYgY29yZVdhbnRzV2FrZSAmJiAhKG11dGVkICYmICFob2xkaW5nKTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyV2FrZVRlbGVtZXRyeSgpIHtcbiAgY29uc3QgYWN0aXZlID0gKGNhbGxJZCA9PT0gMCAmJiB3YWtlQXJtZWQpIHx8IChjYWxsSWQgIT09IDAgJiYgbWVkaXVtID09PSBcInZvaWNlXCIgJiYgY29yZVdhbnRzV2FrZSk7XG4gIGlmICghYWN0aXZlKSB7ICQoXCJoZWFyZFwiKS50ZXh0Q29udGVudCA9IFwiXCI7IHJldHVybjsgfVxuICBjb25zdCBsYWJlbCA9IHNlbGVjdGVkV2FrZU1vZGVsKCk/LmxhYmVsID8/IFwid2FrZSB3b3JkXCI7XG4gIGlmICh3YWtlTG9hZGluZykgeyAkKFwiaGVhcmRcIikudGV4dENvbnRlbnQgPSBgTG9hZGluZyB3YWtlIHdvcmQgXHUyMDFDJHtsYWJlbH1cdTIwMURcdTIwMjZgOyByZXR1cm47IH1cbiAgaWYgKGNhbGxJZCA9PT0gMCAmJiBhdWRpby5hdWRpb1N1c3BlbmRlZCkgeyAkKFwiaGVhcmRcIikudGV4dENvbnRlbnQgPSBgQXVkaW8gcGF1c2VkIGJ5IGJyb3dzZXIgXHUwMEI3IHRhcCBvciBwcmVzcyBhIGtleSB0byByZXN1bWUgXHUyMDFDJHtsYWJlbH1cdTIwMURgOyByZXR1cm47IH1cbiAgaWYgKCF3YWtlTGFzdFRlbCkgeyAkKFwiaGVhcmRcIikudGV4dENvbnRlbnQgPSBgV2FrZSBcdTIwMUMke2xhYmVsfVx1MjAxRCByZWFkeSAodGhyZXNob2xkICR7d2FrZVRocmVzaG9sZCgpLnRvRml4ZWQoMil9KWA7IHJldHVybjsgfVxuICBjb25zdCBzdGF0ZSA9IHdha2VMYXN0VGVsLmdhdGVPcGVuID8gYHNjb3JpbmcgJHt3YWtlTGFzdFRlbC5zY29yZS50b0ZpeGVkKDIpfWAgOiBcInF1aWV0XCI7XG4gIGNvbnN0IHNwZWVkID0gd2FrZUxhc3RUZWwuaW5mZXJNcyA+IDAgPyBgIFx1MDBCNyAke3dha2VMYXN0VGVsLmluZmVyTXMudG9GaXhlZCgxKX0gbXNgIDogXCJcIjtcbiAgJChcImhlYXJkXCIpLnRleHRDb250ZW50ID0gYFdha2UgXHUyMDFDJHtsYWJlbH1cdTIwMUQgXHUwMEI3ICR7c3RhdGV9IFx1MDBCNyBwZWFrICR7d2FrZUxhc3RUZWwucGVhay50b0ZpeGVkKDIpfSR7c3BlZWR9YDtcbn1cblxuZnVuY3Rpb24gc3luY1dha2VVaSgpIHtcbiAgY29uc3QgbW9kZWwgPSBzZWxlY3RlZFdha2VNb2RlbCgpO1xuICBjb25zdCBoYXNNb2RlbHMgPSBtb2RlbCAhPSBudWxsO1xuICBjb25zdCBsYWJlbCA9IG1vZGVsPy5sYWJlbCA/PyBcIndha2Ugd29yZFwiO1xuICBjb25zdCBidG4gPSAkPEhUTUxCdXR0b25FbGVtZW50PihcIndha2VidG5cIik7XG4gIGJ0bi5oaWRkZW4gPSAhaGFzTW9kZWxzO1xuICBidG4uY2xhc3NMaXN0LnRvZ2dsZShcIm9uXCIsIHdha2VBcm1lZCk7XG4gIGJ0bi5jbGFzc0xpc3QudG9nZ2xlKFwibG9hZGluZ1wiLCB3YWtlTG9hZGluZyAmJiAod2FrZUFybWVkIHx8IGNvcmVXYW50c1dha2UpKTtcbiAgYnRuLnNldEF0dHJpYnV0ZShcImFyaWEtcHJlc3NlZFwiLCBTdHJpbmcod2FrZUFybWVkKSk7XG4gIGJ0bi50aXRsZSA9IHdha2VBcm1lZCA/IGBTdG9wIHdha2Ugd29yZCBcdTIwMUMke2xhYmVsfVx1MjAxRCAoVylgIDogYExpc3RlbiBmb3IgXHUyMDFDJHtsYWJlbH1cdTIwMUQgKFcpYDtcbiAgY29uc3QgaGVybyA9ICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiaGVyby13YWtlXCIpO1xuICBoZXJvLmhpZGRlbiA9ICFoYXNNb2RlbHM7XG4gIGhlcm8uY2xhc3NMaXN0LnRvZ2dsZShcIm9uXCIsIHdha2VBcm1lZCk7XG4gIGhlcm8udGV4dENvbnRlbnQgPSB3YWtlQXJtZWRcbiAgICA/ICh3YWtlTG9hZGluZyA/IGBMb2FkaW5nIFx1MjAxQyR7bGFiZWx9XHUyMDFEXHUyMDI2YCA6IGF1ZGlvLmF1ZGlvU3VzcGVuZGVkID8gYEFjdGl2YXRlIFx1MjAxQyR7bGFiZWx9XHUyMDFEYCA6IGBMaXN0ZW5pbmcgZm9yIFx1MjAxQyR7bGFiZWx9XHUyMDFEYClcbiAgICA6IGBMaXN0ZW4gZm9yIFx1MjAxQyR7bGFiZWx9XHUyMDFEYDtcbiAgJDxIVE1MSW5wdXRFbGVtZW50PihcIndha2UtZW5hYmxlZFwiKS5jaGVja2VkID0gd2FrZUFybWVkO1xuICByZW5kZXJXYWtlVGVsZW1ldHJ5KCk7XG4gIHNob3dTdGF0dXMoKTtcbn1cblxuZnVuY3Rpb24gc3luY1NpZ25hbGluZ1VpKCkge1xuICBjb25zdCBvdiA9IGRldmVsb3Blck92ZXJyaWRlcygpO1xuICBjb25zdCBzaWduYWxpbmdFbCA9ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwic2lnbmFsaW5nXCIpO1xuICBjb25zdCBzaWduYWxpbmcgPSBzaWduYWxpbmdFbC52YWx1ZTtcbiAgY29uc3Qgbm9uV2ViID0gb3Yubm9uV2ViUGxhdGZvcm0gIT0gbnVsbDtcbiAgc2lnbmFsaW5nRWwuZGlzYWJsZWQgPSBub25XZWIgfHwgb3YuaGFzQXR0ZW50aW9uO1xuICBjb25zdCB3aW5kb3dDb250cm9scyA9ICFub25XZWIgJiYgIW92Lmhhc0F0dGVudGlvbiAmJiAoc2lnbmFsaW5nID09PSBcIndpbmRvd1wiIHx8IHNpZ25hbGluZyA9PT0gXCJlY2hvXCIpO1xuICBmb3IgKGNvbnN0IGlkIG9mIFtcImF0dG4tYWZ0ZXItd2FrZVwiLCBcImF0dG4td2luZG93XCIsIFwiYXR0bi1hZnRlci1xdWVzdGlvblwiXSkge1xuICAgICQ8SFRNTElucHV0RWxlbWVudD4oaWQpLmRpc2FibGVkID0gIXdpbmRvd0NvbnRyb2xzO1xuICB9XG4gICQ8SFRNTElucHV0RWxlbWVudD4oXCJoYW5ndXAtYWZ0ZXJcIikuZGlzYWJsZWQgPSBub25XZWIgfHwgb3YuaGFzSGFuZ1VwO1xuICBjb25zdCBiYXJnZSA9ICQ8SFRNTElucHV0RWxlbWVudD4oXCJ3YWtlLWJhcmdlXCIpO1xuICBpZiAobm9uV2ViIHx8IG92Lmhhc01pY1doaWxlU3BlYWtpbmcpIHtcbiAgICBiYXJnZS5kaXNhYmxlZCA9IHRydWU7XG4gIH0gZWxzZSBpZiAoc2lnbmFsaW5nID09PSBcImVjaG9cIikge1xuICAgIGJhcmdlLmNoZWNrZWQgPSB0cnVlO1xuICAgIGJhcmdlLmRpc2FibGVkID0gdHJ1ZTtcbiAgfSBlbHNlIHtcbiAgICBiYXJnZS5kaXNhYmxlZCA9IGZhbHNlO1xuICAgIGJhcmdlLmNoZWNrZWQgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLndha2UtYmFyZ2VcIikgPT09IFwiMVwiO1xuICB9XG4gIGNvbnN0IG92ZXJyaWRkZW46IHN0cmluZ1tdID0gW107XG4gIGlmIChvdi5oYXNBdHRlbnRpb24pIG92ZXJyaWRkZW4ucHVzaChcImF0dGVudGlvblwiKTtcbiAgaWYgKG92Lmhhc0hhbmdVcCkgb3ZlcnJpZGRlbi5wdXNoKFwiaGFuZ1VwQWZ0ZXJcIik7XG4gIGlmIChvdi5oYXNNaWNXaGlsZVNwZWFraW5nKSBvdmVycmlkZGVuLnB1c2goXCJtaWMud2hpbGVTcGVha2luZ1wiKTtcbiAgY29uc3QgaGFzTW9kZWxzID0gKHNlcnZlcj8ud2FrZU1vZGVscz8ubGVuZ3RoID8/IDApID4gMDtcbiAgJChcInNpZ25hbGluZy1oZWxwXCIpLnRleHRDb250ZW50ID0gbm9uV2ViXG4gICAgPyBgRGV2ZWxvcGVyIHByZXNldCAoJHtvdi5ub25XZWJQbGF0Zm9ybX0pIGNvbnRyb2xzIHNpZ25hbGluZy5gXG4gICAgOiBvdmVycmlkZGVuLmxlbmd0aCA+IDBcbiAgICAgID8gYERldmVsb3BlciBjb25maWcgc2V0cyAke292ZXJyaWRkZW4uam9pbihcIiwgXCIpfS5gXG4gICAgICA6ICFoYXNNb2RlbHMgJiYgc2lnbmFsaW5nICE9PSBcIm9wZW5cIlxuICAgICAgICA/IFwiTm8gd2FrZSBtb2RlbHMgb24gc2VydmVyOiB1c2UgdGhlIFdha2UgYnV0dG9uIHdoZW4gZG9ybWFudC5cIlxuICAgICAgICA6IFwiQXBwbGllZCBvbiB0aGUgbmV4dCBjYWxsIHVubGVzcyBvdmVycmlkZGVuIGluIERldmVsb3BlciBKU09OLlwiO1xufVxuXG5jb25zdCB3YWtlQ2xpZW50ID0gbmV3IFdha2VDbGllbnQoe1xuICBvblJlYWR5KG1vZGVsSWQsIHdhcm11cE1zKSB7XG4gICAgd2FrZUxvYWRpbmcgPSBmYWxzZTtcbiAgICBsb2coXCJvdXRcIiwgYHdha2Ugd29yZCByZWFkeTogJHttb2RlbElkfSR7d2FybXVwTXMgPiAwID8gYCAoJHt3YXJtdXBNc30gbXMpYCA6IFwiXCJ9YCwgXCJvdXRcIik7XG4gICAgc3luY1dha2VVaSgpO1xuICB9LFxuICBvbkRldGVjdGVkKGhpdCkge1xuICAgIG9uV2FrZURldGVjdGVkKGhpdCk7XG4gIH0sXG4gIG9uVGVsZW1ldHJ5KHRlbCkge1xuICAgIHdha2VMYXN0VGVsID0gdGVsO1xuICAgIHJlbmRlcldha2VUZWxlbWV0cnkoKTtcbiAgfSxcbiAgb25FcnJvcihtZXNzYWdlKSB7XG4gICAgd2FrZUxvYWRpbmcgPSBmYWxzZTtcbiAgICBsb2coXCJlcnJvclwiLCBgd2FrZSB3b3JkOiAke21lc3NhZ2V9YCwgXCJlcnJcIik7XG4gICAgdG9hc3QoYFdha2Ugd29yZCBlcnJvcjogJHttZXNzYWdlfWApO1xuICAgIGlmICh3YWtlQXJtZWQpIHZvaWQgYXJtV2FrZShmYWxzZSk7XG4gICAgZWxzZSBzeW5jV2FrZVVpKCk7XG4gIH0sXG59KTtcblxuYXN5bmMgZnVuY3Rpb24gYXJtV2FrZShvbjogYm9vbGVhbiwgcGVyc2lzdCA9IHRydWUpIHtcbiAgY29uc3QgbW9kZWwgPSBzZWxlY3RlZFdha2VNb2RlbCgpO1xuICBpZiAob24gJiYgIW1vZGVsKSB7XG4gICAgdG9hc3QoXCJObyB3YWtlIHdvcmQgbW9kZWxzIGZvdW5kIG9uIHRoZSBzZXJ2ZXJcIik7XG4gICAgJDxIVE1MSW5wdXRFbGVtZW50PihcIndha2UtZW5hYmxlZFwiKS5jaGVja2VkID0gZmFsc2U7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IGdlbiA9ICsrYXJtR2VuO1xuICB3YWtlQXJtZWQgPSBvbjtcbiAgaWYgKHBlcnNpc3QpIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2Uud2FrZS1lbmFibGVkXCIsIG9uID8gXCIxXCIgOiBcIjBcIik7XG4gIGlmIChvbiAmJiBtb2RlbCkge1xuICAgIHdha2VMYXN0VGVsID0gbnVsbDtcbiAgICBpZiAoIXdha2VDbGllbnQucmVhZHkgfHwgd2FrZUNsaWVudC5tb2RlbElkICE9PSBtb2RlbC5pZCkgd2FrZUxvYWRpbmcgPSB0cnVlO1xuICAgIHdha2VDbGllbnQubG9hZChtb2RlbC5pZCwgd2FrZVRocmVzaG9sZCgpKTtcbiAgICBpZiAoIWNhbGxJZCkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgYXVkaW8uZW5zdXJlTWljKG9uTWljLCBtaWNPcHRpb25zKCkpO1xuICAgICAgICBpZiAoZ2VuICE9PSBhcm1HZW4gfHwgIXdha2VBcm1lZCkgcmV0dXJuO1xuICAgICAgICB3YWtlQ2xpZW50LnJlc2V0KCk7XG4gICAgICAgIGF3YWl0IGFjcXVpcmVXYWtlTG9jaygpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGlmIChnZW4gIT09IGFybUdlbikgcmV0dXJuO1xuICAgICAgICB3YWtlQXJtZWQgPSBmYWxzZTtcbiAgICAgICAgd2FrZUxvYWRpbmcgPSBmYWxzZTtcbiAgICAgICAgaWYgKCFjYWxsSWQpIHtcbiAgICAgICAgICBhdWRpby5zdG9wTWljKCk7XG4gICAgICAgICAgcmVsZWFzZVdha2VMb2NrKCk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHBlcnNpc3QpIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2Uud2FrZS1lbmFibGVkXCIsIFwiMFwiKTtcbiAgICAgICAgdG9hc3QoYE1pY3JvcGhvbmU6ICR7KGVyciBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICAgICAgbG9nKFwiZXJyb3JcIiwgYHdha2UgbWljcm9waG9uZTogJHsoZXJyIGFzIEVycm9yKS5tZXNzYWdlfWAsIFwiZXJyXCIpO1xuICAgICAgfVxuICAgIH1cbiAgfSBlbHNlIHtcbiAgICB3YWtlTG9hZGluZyA9IGZhbHNlO1xuICAgIHdha2VMYXN0VGVsID0gbnVsbDtcbiAgICBpZiAoIWNhbGxJZCkge1xuICAgICAgYXVkaW8uc3RvcE1pYygpO1xuICAgICAgcmVsZWFzZVdha2VMb2NrKCk7XG4gICAgICB3YWtlQ2xpZW50LnJlc2V0KCk7XG4gICAgfVxuICB9XG4gIHN5bmNXYWtlVWkoKTtcbn1cblxuZnVuY3Rpb24gZW5zdXJlQ29yZVdha2Uob246IGJvb2xlYW4pIHtcbiAgY29yZVdhbnRzV2FrZSA9IG9uO1xuICBjb25zdCBtb2RlbCA9IHNlbGVjdGVkV2FrZU1vZGVsKCk7XG4gIGlmIChvbikge1xuICAgIGlmICghbW9kZWwpIHtcbiAgICAgIGxvZyhcIndhcm5cIiwgXCJjb3JlIGFza2VkIGZvciB3YWtlIHdvcmQsIGJ1dCBubyBtb2RlbHMgYXJlIGF2YWlsYWJsZVwiLCBcIndhcm5cIik7XG4gICAgfSBlbHNlIHtcbiAgICAgIHdha2VMYXN0VGVsID0gbnVsbDtcbiAgICAgIGlmICghd2FrZUNsaWVudC5yZWFkeSB8fCB3YWtlQ2xpZW50Lm1vZGVsSWQgIT09IG1vZGVsLmlkKSB3YWtlTG9hZGluZyA9IHRydWU7XG4gICAgICB3YWtlQ2xpZW50LmxvYWQobW9kZWwuaWQsIHdha2VUaHJlc2hvbGQoKSk7XG4gICAgICB3YWtlQ2xpZW50LnJlc2V0KCk7XG4gICAgICBsb2coXCJvdXRcIiwgYHdha2Ugd29yZCBsaXN0ZW5pbmcgKCR7bW9kZWwubGFiZWx9KWAsIFwib3V0XCIpO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICBpZiAoIXdha2VBcm1lZCkgd2FrZUxhc3RUZWwgPSBudWxsO1xuICAgIGxvZyhcIm91dFwiLCBcIndha2Ugd29yZCBvZmZcIiwgXCJvdXRcIik7XG4gIH1cbiAgc3luY1dha2VVaSgpO1xufVxuXG5mdW5jdGlvbiBvbldha2VEZXRlY3RlZChoaXQ6IFdha2VEZXRlY3Rpb25FdmVudCkge1xuICBpZiAoIXNob3VsZEZlZWRXYWtlKCkpIHJldHVybjtcbiAgY29uc3QgbGFiZWwgPSBzZWxlY3RlZFdha2VNb2RlbCgpPy5sYWJlbCA/PyBcIndha2Ugd29yZFwiO1xuICBsb2coXCJvdXRcIiwgYHdha2UgZGV0ZWN0ZWQgXHUyMDFDJHtsYWJlbH1cdTIwMUQgKHNjb3JlICR7aGl0LnNjb3JlLnRvRml4ZWQoMil9LCAke2hpdC5pbmZlck1zLnRvRml4ZWQoMSl9IG1zKWAsIFwib3V0XCIpO1xuICBpZiAoY2hlY2tlZChcIndha2UtY3VlXCIpKSB2b2lkIGF1ZGlvLm9wZW4oKS50aGVuKCgpID0+IGF1ZGlvLmN1ZShXQUtFX1RPTkUpKS5jYXRjaCgoKSA9PiB7fSk7XG4gIHRvYXN0KGBIZWFyZCBcdTIwMUMke2xhYmVsfVx1MjAxRCAoJHtoaXQuc2NvcmUudG9GaXhlZCgyKX0pYCk7XG4gIGlmIChjYWxsSWQgIT09IDApIHtcbiAgICBjb25zdCB3YXNMaXZlQmFyZ2VJbiA9IGNvcmVTdGF0dXMgIT09IFwiZG9ybWFudFwiICYmIGNvcmVTdGF0dXMgIT09IFwic3RhbmRieVwiO1xuICAgIHB1c2goeyB0eXBlOiBcIndha2VcIiB9KTtcbiAgICAvLyBPbiBpbi1jYWxsIGJhcmdlLWluICh3aGlsZVNwZWFraW5nIFwid2FrZVwiKSwgdGhlIGNvcmUgcmVwbGFjZWQgcmVjZW50IGZyYW1lcyB3aXRoIHNpbGVuY2U6XG4gICAgLy8gcmVwbGF5IHRoZSBzcGVlY2ggc3Bva2VuIHJpZ2h0IGFmdGVyIHRoZSB3YWtlIHdvcmQgc28gdGhlIG9wZW5pbmcgc3lsbGFibGVzIGFyZW4ndCBjbGlwcGVkLlxuICAgIC8vIChXaGVuIHdha2luZyBmcm9tIGRvcm1hbnQgb3Igc3RhbmRieSwgdGhlIGNvcmUgYWxyZWFkeSBidWZmZXJlZCBhbmQgcmVwbGF5cyB3YWtlUHJlUm9sbCBpdHNlbGYuKVxuICAgIGlmICh3YXNMaXZlQmFyZ2VJbiAmJiBjYWxsSWQgIT09IDAgJiYgaGl0LnRyYWlsaW5nLmxlbmd0aCA+IDApIHtcbiAgICAgIGZvciAoY29uc3QgY2h1bmsgb2YgaGl0LnRyYWlsaW5nKSB7XG4gICAgICAgIGlmICghY2FsbElkKSBicmVhaztcbiAgICAgICAgaWYgKGNodW5rLmJ5dGVMZW5ndGggPT09IDApIGNvbnRpbnVlO1xuICAgICAgICBjb3VudHMubWljKys7XG4gICAgICAgIHB1c2goeyB0eXBlOiBcIm1pY1wiLCBwY206IGJ5dGVzVG9CYXNlNjQoY2h1bmspIH0pO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm47XG4gIH1cbiAgd2FrZVN0YXJ0aW5nID0gdHJ1ZTtcbiAgb3BlbmluZ0NodW5rcyA9IFtdO1xuICBvcGVuaW5nQnl0ZXMgPSAwO1xuICBmb3IgKGNvbnN0IGNodW5rIG9mIGhpdC50cmFpbGluZykge1xuICAgIGlmIChjaHVuay5ieXRlTGVuZ3RoID09PSAwKSBjb250aW51ZTtcbiAgICBvcGVuaW5nQ2h1bmtzLnB1c2goY2h1bmspO1xuICAgIG9wZW5pbmdCeXRlcyArPSBjaHVuay5ieXRlTGVuZ3RoO1xuICAgIHdoaWxlIChvcGVuaW5nQnl0ZXMgPiBPUEVOSU5HX01BWF9CWVRFUyAmJiBvcGVuaW5nQ2h1bmtzLmxlbmd0aCA+IDEpIHtcbiAgICAgIG9wZW5pbmdCeXRlcyAtPSBvcGVuaW5nQ2h1bmtzLnNoaWZ0KCkhLmJ5dGVMZW5ndGg7XG4gICAgfVxuICB9XG4gIHZvaWQgc3RhcnQoY2hhdC5sZW5ndGggPiAwKS50aGVuKChzdGFydGVkKSA9PiB7XG4gICAgaWYgKCFzdGFydGVkICYmIHdha2VTdGFydGluZykge1xuICAgICAgd2FrZVN0YXJ0aW5nID0gZmFsc2U7XG4gICAgICBvcGVuaW5nQ2h1bmtzID0gW107XG4gICAgICBvcGVuaW5nQnl0ZXMgPSAwO1xuICAgICAgc3luY1dha2VVaSgpO1xuICAgIH1cbiAgfSkuY2F0Y2goKGVycikgPT4ge1xuICAgIHdha2VTdGFydGluZyA9IGZhbHNlO1xuICAgIG9wZW5pbmdDaHVua3MgPSBbXTtcbiAgICBvcGVuaW5nQnl0ZXMgPSAwO1xuICAgIHRvYXN0KChlcnIgYXMgRXJyb3IpLm1lc3NhZ2UpO1xuICAgIGxvZyhcImVycm9yXCIsIChlcnIgYXMgRXJyb3IpLm1lc3NhZ2UsIFwiZXJyXCIpO1xuICAgIHN5bmNXYWtlVWkoKTtcbiAgfSk7XG59XG5cbi8vIFdpcmluZy5cblxuZnVuY3Rpb24gc2V0dGluZ3NGcm9tU3RvcmFnZSgpIHtcbiAgZm9yIChjb25zdCBpZCBvZiBbXCJhZWNcIiwgXCJzdG9wd29yZFwiLCBcInB0dFwiLCBcImNhcHRpb25zXCIsIFwiY29kaW5nXCIsIFwiZmFrZWhlcm1lc1wiLCBcInRyYWNlXCIsIFwid2FrZS1jdWVcIiwgXCJ3YWtlLWJhcmdlXCJdKSB7XG4gICAgY29uc3QgdiA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKGB2b2ljZS4ke2lkfWApO1xuICAgIGlmICh2ICE9IG51bGwpICQ8SFRNTElucHV0RWxlbWVudD4oaWQpLmNoZWNrZWQgPSB2ID09PSBcIjFcIjtcbiAgICAkKGlkKS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHtcbiAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKGB2b2ljZS4ke2lkfWAsIGNoZWNrZWQoaWQpID8gXCIxXCIgOiBcIjBcIik7XG4gICAgICBpZiAoaWQgPT09IFwiYWVjXCIgJiYgd2FrZUFybWVkICYmICFjYWxsSWQpIHtcbiAgICAgICAgdm9pZCBhdWRpby5zdGFydE1pYyhvbk1pYywgbWljT3B0aW9ucygpKS5jYXRjaCgoZXJyKSA9PiB0b2FzdChgTWljcm9waG9uZTogJHtlcnIubWVzc2FnZX1gKSk7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cbiAgZm9yIChjb25zdCBbaWQsIGtleV0gb2YgW1xuICAgIFtcImZha2VkZWxheVwiLCBcInZvaWNlLmZha2VkZWxheVwiXSxcbiAgICBbXCJhdHRuLWFmdGVyLXdha2VcIiwgXCJ2b2ljZS5hdHRuLWFmdGVyLXdha2VcIl0sXG4gICAgW1wiYXR0bi13aW5kb3dcIiwgXCJ2b2ljZS5hdHRuLXdpbmRvd1wiXSxcbiAgICBbXCJhdHRuLWFmdGVyLXF1ZXN0aW9uXCIsIFwidm9pY2UuYXR0bi1hZnRlci1xdWVzdGlvblwiXSxcbiAgICBbXCJoYW5ndXAtYWZ0ZXJcIiwgXCJ2b2ljZS5oYW5ndXAtYWZ0ZXJcIl0sXG4gIF0gYXMgY29uc3QpIHtcbiAgICBjb25zdCBzYXZlZCA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKGtleSk7XG4gICAgaWYgKHNhdmVkICE9IG51bGwpICQ8SFRNTElucHV0RWxlbWVudD4oaWQpLnZhbHVlID0gc2F2ZWQ7XG4gICAgJChpZCkuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiB7XG4gICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShrZXksICQ8SFRNTElucHV0RWxlbWVudD4oaWQpLnZhbHVlKTtcbiAgICAgIGlmIChpZCA9PT0gXCJoYW5ndXAtYWZ0ZXJcIikgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS5oYW5ndXAtY3VzdG9tXCIsIFwiMVwiKTtcbiAgICB9KTtcbiAgfVxuICBjb25zdCB0aHJlc2ggPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLndha2UtdGhyZXNob2xkXCIpO1xuICBpZiAodGhyZXNoICE9IG51bGwpICQ8SFRNTElucHV0RWxlbWVudD4oXCJ3YWtlLXRocmVzaG9sZFwiKS52YWx1ZSA9IHRocmVzaDtcbiAgJChcIndha2UtdGhyZXNob2xkLXZhbFwiKS50ZXh0Q29udGVudCA9IHdha2VUaHJlc2hvbGQoKS50b0ZpeGVkKDIpO1xuICAkKFwid2FrZS10aHJlc2hvbGRcIikuYWRkRXZlbnRMaXN0ZW5lcihcImlucHV0XCIsICgpID0+IHtcbiAgICBjb25zdCB2ID0gd2FrZVRocmVzaG9sZCgpO1xuICAgICQoXCJ3YWtlLXRocmVzaG9sZC12YWxcIikudGV4dENvbnRlbnQgPSB2LnRvRml4ZWQoMik7XG4gICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS53YWtlLXRocmVzaG9sZFwiLCB2LnRvRml4ZWQoMikpO1xuICAgIHdha2VDbGllbnQuc2V0VGhyZXNob2xkKHYpO1xuICAgIHJlbmRlcldha2VUZWxlbWV0cnkoKTtcbiAgfSk7XG4gIGNvbnN0IHNpZ25hbGluZyA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2Uuc2lnbmFsaW5nXCIpO1xuICBpZiAoc2lnbmFsaW5nKSAkPEhUTUxTZWxlY3RFbGVtZW50PihcInNpZ25hbGluZ1wiKS52YWx1ZSA9IHNpZ25hbGluZztcbiAgJChcInNpZ25hbGluZ1wiKS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHtcbiAgICBjb25zdCBtb2RlID0gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJzaWduYWxpbmdcIikudmFsdWU7XG4gICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS5zaWduYWxpbmdcIiwgbW9kZSk7XG4gICAgaWYgKGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UuaGFuZ3VwLWN1c3RvbVwiKSAhPT0gXCIxXCIpIHtcbiAgICAgIGNvbnN0IGRlZiA9IG1vZGUgPT09IFwiZWNob1wiID8gXCIxNVwiIDogXCIzMDBcIjtcbiAgICAgICQ8SFRNTElucHV0RWxlbWVudD4oXCJoYW5ndXAtYWZ0ZXJcIikudmFsdWUgPSBkZWY7XG4gICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLmhhbmd1cC1hZnRlclwiLCBkZWYpO1xuICAgIH1cbiAgICBzeW5jU2lnbmFsaW5nVWkoKTtcbiAgfSk7XG4gICQoXCJ3YWtlLWVuYWJsZWRcIikuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiB2b2lkIGFybVdha2UoY2hlY2tlZChcIndha2UtZW5hYmxlZFwiKSkpO1xuICAkKFwid2FrZS1tb2RlbFwiKS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHtcbiAgICBjb25zdCBpZCA9ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwid2FrZS1tb2RlbFwiKS52YWx1ZTtcbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLndha2UtbW9kZWxcIiwgaWQpO1xuICAgIGlmICh3YWtlQXJtZWQgfHwgY29yZVdhbnRzV2FrZSkge1xuICAgICAgd2FrZUxvYWRpbmcgPSB0cnVlO1xuICAgICAgd2FrZUxhc3RUZWwgPSBudWxsO1xuICAgICAgd2FrZUNsaWVudC5sb2FkKGlkLCB3YWtlVGhyZXNob2xkKCkpO1xuICAgICAgc3luY1dha2VVaSgpO1xuICAgIH0gZWxzZSB7XG4gICAgICBzeW5jV2FrZVVpKCk7XG4gICAgfVxuICB9KTtcbiAgY29uc3Qgdm9pY2UgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLnZvaWNlXCIpO1xuICBpZiAodm9pY2UpICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwidm9pY2VcIikudmFsdWUgPSB2b2ljZTtcbiAgJChcInZvaWNlXCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4gbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS52b2ljZVwiLCAkPEhUTUxTZWxlY3RFbGVtZW50PihcInZvaWNlXCIpLnZhbHVlKSk7XG4gIGNvbnN0IG1vZGUgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLm1vZGVcIik7XG4gIGlmIChtb2RlKSAkPEhUTUxTZWxlY3RFbGVtZW50PihcIm1vZGVcIikudmFsdWUgPSBtb2RlO1xuICAkKFwibW9kZVwiKS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHtcbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLm1vZGVcIiwgJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJtb2RlXCIpLnZhbHVlKTtcbiAgICBzeW5jQ29tcG9zZXIoKTtcbiAgfSk7XG4gIGNvbnN0IHRoZW1lID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS50aGVtZVwiKSA/PyBcInN5c3RlbVwiO1xuICBhcHBseVRoZW1lKHRoZW1lKTtcbiAgZm9yIChjb25zdCBidG4gb2YgQXJyYXkuZnJvbShkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxCdXR0b25FbGVtZW50PihcIiN0aGVtZS1waWNrZXIgYnV0dG9uXCIpKSkge1xuICAgIGJ0bi5vbmNsaWNrID0gKCkgPT4ge1xuICAgICAgY29uc3QgY2hvaWNlID0gYnRuLmRhdGFzZXQudGhlbWUgPz8gXCJzeXN0ZW1cIjtcbiAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2UudGhlbWVcIiwgY2hvaWNlKTtcbiAgICAgIGFwcGx5VGhlbWUoY2hvaWNlKTtcbiAgICB9O1xuICB9XG4gIG1hdGNoTWVkaWEoXCIocHJlZmVycy1jb2xvci1zY2hlbWU6IGRhcmspXCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4ge1xuICAgIGlmICgobG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS50aGVtZVwiKSA/PyBcInN5c3RlbVwiKSA9PT0gXCJzeXN0ZW1cIikgYXBwbHlUaGVtZShcInN5c3RlbVwiKTtcbiAgfSk7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJ2aXNpYmlsaXR5Y2hhbmdlXCIsICgpID0+IHtcbiAgICBpZiAoIWRvY3VtZW50LmhpZGRlbiAmJiAoY2FsbElkIHx8IHdha2VBcm1lZCkpIHZvaWQgYWNxdWlyZVdha2VMb2NrKCk7XG4gIH0pO1xuICBhdWRpby5vbkF1ZGlvU3RhdGVDaGFuZ2UoKCkgPT4gc3luY1dha2VVaSgpKTtcbiAgY29uc3QgcmVzdW1lSWZTdXNwZW5kZWQgPSAoKSA9PiB7XG4gICAgaWYgKGF1ZGlvLmF1ZGlvU3VzcGVuZGVkICYmICh3YWtlQXJtZWQgfHwgY2FsbElkKSkge1xuICAgICAgdm9pZCBhdWRpby5yZXN1bWVBdWRpbygpLnRoZW4oKCkgPT4gc3luY1dha2VVaSgpKTtcbiAgICB9XG4gIH07XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJwb2ludGVyZG93blwiLCByZXN1bWVJZlN1c3BlbmRlZCwgeyBwYXNzaXZlOiB0cnVlIH0pO1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwicG9pbnRlcnVwXCIsIHJlc3VtZUlmU3VzcGVuZGVkLCB7IHBhc3NpdmU6IHRydWUgfSk7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCByZXN1bWVJZlN1c3BlbmRlZCwgeyBwYXNzaXZlOiB0cnVlIH0pO1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCByZXN1bWVJZlN1c3BlbmRlZCwgeyBwYXNzaXZlOiB0cnVlIH0pO1xuICBzeW5jU2lnbmFsaW5nVWkoKTtcbn1cblxuY29uc3QgbW9iaWxlTGF5b3V0ID0gbWF0Y2hNZWRpYShcIihtYXgtd2lkdGg6IDkyMHB4KVwiKTtcbmxldCBkcmF3ZXJPcGVuZXI6IEhUTUxFbGVtZW50IHwgbnVsbCA9IG51bGw7XG5cbmZ1bmN0aW9uIHNldFRhc2tzT3BlbihvcGVuOiBib29sZWFuLCBvcGVuZXI/OiBIVE1MRWxlbWVudCB8IG51bGwpIHtcbiAgY29uc3QgY2FuT3BlbiA9IG1vYmlsZUxheW91dC5tYXRjaGVzICYmICEkKFwidGFsa1wiKS5oaWRkZW47XG4gIGNvbnN0IG5leHQgPSBvcGVuICYmIGNhbk9wZW47XG4gIGNvbnN0IHdhc09wZW4gPSBkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5jb250YWlucyhcInRhc2tzLW9wZW5cIik7XG4gIGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LnRvZ2dsZShcInRhc2tzLW9wZW5cIiwgbmV4dCk7XG4gIGNvbnN0IGhlYWRlciA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoXCJoZWFkZXJcIikgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAoaGVhZGVyKSBoZWFkZXIuaW5lcnQgPSBuZXh0O1xuICAkKFwiY29udm9cIikuaW5lcnQgPSBuZXh0O1xuICAkKFwic2lkZVwiKS5pbmVydCA9IG1vYmlsZUxheW91dC5tYXRjaGVzICYmICFuZXh0O1xuICAkKFwidGFza3MtdG9nZ2xlXCIpLnNldEF0dHJpYnV0ZShcImFyaWEtZXhwYW5kZWRcIiwgU3RyaW5nKG5leHQpKTtcbiAgJChcIm1vYmlsZS10YXNrcy1iYXJcIikuc2V0QXR0cmlidXRlKFwiYXJpYS1leHBhbmRlZFwiLCBTdHJpbmcobmV4dCkpO1xuICBpZiAobmV4dCAmJiAhd2FzT3Blbikge1xuICAgIGRyYXdlck9wZW5lciA9IG9wZW5lciA/PyAoZG9jdW1lbnQuYWN0aXZlRWxlbWVudCBhcyBIVE1MRWxlbWVudCB8IG51bGwpO1xuICAgICQoXCJ0YXNrcy1jbG9zZVwiKS5mb2N1cygpO1xuICB9IGVsc2UgaWYgKCFuZXh0ICYmIHdhc09wZW4pIHtcbiAgICBjb25zdCB0YXJnZXQgPSBkcmF3ZXJPcGVuZXI7XG4gICAgZHJhd2VyT3BlbmVyID0gbnVsbDtcbiAgICBpZiAodGFyZ2V0ICYmIHRhcmdldC5pc0Nvbm5lY3RlZCAmJiAhdGFyZ2V0LmhpZGRlbiAmJiB0YXJnZXQub2Zmc2V0UGFyZW50ICE9PSBudWxsKSB0YXJnZXQuZm9jdXMoKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB0YWJzKCkge1xuICBjb25zdCB2aWV3czogUmVjb3JkPHN0cmluZywgSFRNTEVsZW1lbnQ+ID0geyB0YWxrOiAkKFwidGFsa1wiKSwgZGV2OiAkKFwiZGV2XCIpLCByZXBsYXk6ICQoXCJyZXBsYXltYWluXCIpIH07XG4gIGZvciAoY29uc3QgbmFtZSBvZiBPYmplY3Qua2V5cyh2aWV3cykpIHtcbiAgICAkKGB0YWItJHtuYW1lfWApLm9uY2xpY2sgPSAoKSA9PiB7XG4gICAgICBmb3IgKGNvbnN0IFtvdGhlciwgZWxdIG9mIE9iamVjdC5lbnRyaWVzKHZpZXdzKSkge1xuICAgICAgICBlbC5oaWRkZW4gPSBvdGhlciAhPT0gbmFtZTtcbiAgICAgICAgJChgdGFiLSR7b3RoZXJ9YCkuY2xhc3NMaXN0LnRvZ2dsZShcIm9uXCIsIG90aGVyID09PSBuYW1lKTtcbiAgICAgIH1cbiAgICAgICQoXCJ0YXNrcy10b2dnbGVcIikuaGlkZGVuID0gbmFtZSAhPT0gXCJ0YWxrXCI7XG4gICAgICBzZXRUYXNrc09wZW4oZmFsc2UpO1xuICAgIH07XG4gIH1cbiAgJChcImdlYXJcIikub25jbGljayA9ICgpID0+IHsgJChcInNldHRpbmdzXCIpLmhpZGRlbiA9IGZhbHNlOyB9O1xuICAkKFwiY2xvc2VzZXR0aW5nc1wiKS5vbmNsaWNrID0gKCkgPT4geyAkKFwic2V0dGluZ3NcIikuaGlkZGVuID0gdHJ1ZTsgfTtcbiAgJChcImNsb3Nlc2V0dGluZ3MteFwiKS5vbmNsaWNrID0gKCkgPT4geyAkKFwic2V0dGluZ3NcIikuaGlkZGVuID0gdHJ1ZTsgfTtcbiAgJChcInNldHRpbmdzXCIpLm9uY2xpY2sgPSAoZSkgPT4geyBpZiAoZS50YXJnZXQgPT09ICQoXCJzZXR0aW5nc1wiKSkgJChcInNldHRpbmdzXCIpLmhpZGRlbiA9IHRydWU7IH07XG4gICQoXCJ0YXNrcy10b2dnbGVcIikub25jbGljayA9ICgpID0+IHNldFRhc2tzT3BlbighZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QuY29udGFpbnMoXCJ0YXNrcy1vcGVuXCIpLCAkKFwidGFza3MtdG9nZ2xlXCIpKTtcbiAgJChcIm1vYmlsZS10YXNrcy1iYXJcIikub25jbGljayA9ICgpID0+IHNldFRhc2tzT3Blbih0cnVlLCAkKFwibW9iaWxlLXRhc2tzLWJhclwiKSk7XG4gICQoXCJ0YXNrcy1jbG9zZVwiKS5vbmNsaWNrID0gKCkgPT4gc2V0VGFza3NPcGVuKGZhbHNlKTtcbiAgJChcInNpZGUtYmFja2Ryb3BcIikub25jbGljayA9ICgpID0+IHNldFRhc2tzT3BlbihmYWxzZSk7XG4gIG1vYmlsZUxheW91dC5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHNldFRhc2tzT3BlbihmYWxzZSkpO1xuICBzZXRUYXNrc09wZW4oZmFsc2UpO1xufVxuXG5mdW5jdGlvbiB0eXBpbmcoKTogYm9vbGVhbiB7XG4gIGNvbnN0IGVsID0gZG9jdW1lbnQuYWN0aXZlRWxlbWVudCBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gIHJldHVybiAhIWVsICYmIChlbC50YWdOYW1lID09PSBcIklOUFVUXCIgfHwgZWwudGFnTmFtZSA9PT0gXCJURVhUQVJFQVwiIHx8IGVsLnRhZ05hbWUgPT09IFwiU0VMRUNUXCIgfHwgZWwuaXNDb250ZW50RWRpdGFibGUpO1xufVxuXG5mdW5jdGlvbiBrZXlzKCkge1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCAoZSkgPT4ge1xuICAgIGlmIChlLmtleSA9PT0gXCJFc2NhcGVcIikge1xuICAgICAgaWYgKCEkKFwic2V0dGluZ3NcIikuaGlkZGVuKSB7ICQoXCJzZXR0aW5nc1wiKS5oaWRkZW4gPSB0cnVlOyByZXR1cm47IH1cbiAgICAgIGlmIChkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5jb250YWlucyhcInRhc2tzLW9wZW5cIikgJiYgbW9iaWxlTGF5b3V0Lm1hdGNoZXMgJiYgISQoXCJ0YWxrXCIpLmhpZGRlbikgeyBzZXRUYXNrc09wZW4oZmFsc2UpOyByZXR1cm47IH1cbiAgICAgIGlmIChjYWxsSWQpIHsgcHVzaCh7IHR5cGU6IFwiaW50ZXJydXB0XCIgfSk7IGF1ZGlvLmZsdXNoKCk7IHJldHVybjsgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAodHlwaW5nKCkgfHwgISQoXCJzZXR0aW5nc1wiKS5oaWRkZW4gfHwgZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QuY29udGFpbnMoXCJ0YXNrcy1vcGVuXCIpIHx8IGUubWV0YUtleSB8fCBlLmN0cmxLZXkgfHwgZS5hbHRLZXkpIHJldHVybjtcbiAgICBpZiAoZS5rZXkgPT09IFwibVwiIHx8IGUua2V5ID09PSBcIk1cIikgeyBzZXRNdXRlZCghbXV0ZWQpOyBlLnByZXZlbnREZWZhdWx0KCk7IH1cbiAgICBlbHNlIGlmIChlLmtleSA9PT0gXCJ3XCIgfHwgZS5rZXkgPT09IFwiV1wiKSB7IHZvaWQgYXJtV2FrZSghd2FrZUFybWVkKTsgZS5wcmV2ZW50RGVmYXVsdCgpOyB9XG4gICAgZWxzZSBpZiAoZS5rZXkgPT09IFwiL1wiKSB7ICQoXCJ0ZXh0XCIpLmZvY3VzKCk7IGUucHJldmVudERlZmF1bHQoKTsgfVxuICAgIGVsc2UgaWYgKGUuY29kZSA9PT0gXCJTcGFjZVwiICYmIGNhbGxJZCAmJiBtdXRlZCAmJiAhZS5yZXBlYXQpIHsgaG9sZGluZyA9IHRydWU7IHB1c2goeyB0eXBlOiBcInVubXV0ZVwiIH0pOyBzaG93U3RhdHVzKCk7IGUucHJldmVudERlZmF1bHQoKTsgfVxuICB9KTtcbiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcImtleXVwXCIsIChlKSA9PiB7XG4gICAgaWYgKGUuY29kZSA9PT0gXCJTcGFjZVwiICYmIGhvbGRpbmcpIHsgaG9sZGluZyA9IGZhbHNlOyBwdXNoKHsgdHlwZTogXCJtdXRlXCIgfSk7IHNob3dTdGF0dXMoKTsgfVxuICB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gc3VibWl0VGV4dChlOiBFdmVudCkge1xuICBlLnByZXZlbnREZWZhdWx0KCk7XG4gIGNvbnN0IGlucHV0ID0gJDxIVE1MSW5wdXRFbGVtZW50PihcInRleHRcIik7XG4gIGxldCB0ZXh0ID0gaW5wdXQudmFsdWUudHJpbSgpO1xuICBpZiAoIXRleHQpIHJldHVybjtcbiAgLy8gV2l0aCBubyBjYWxsIG9uLCB0eXBpbmcgc3RhcnRzIGEgY2hhdDogdGhlIHNhbWUgbWFpbiB0aHJlYWQsIGluIHRleHQuXG4gIGlmICghY2FsbElkKSB7XG4gICAgaW5wdXQudmFsdWUgPSBcIlwiO1xuICAgIHN5bmNDb21wb3NlcigpO1xuICAgIHRyeSB7IGF3YWl0IHN0YXJ0KGZhbHNlLCB0cnVlKTsgfSBjYXRjaCAoZXJyKSB7IHRvYXN0KChlcnIgYXMgRXJyb3IpLm1lc3NhZ2UpOyBsb2coXCJlcnJvclwiLCAoZXJyIGFzIEVycm9yKS5tZXNzYWdlLCBcImVyclwiKTsgfVxuICAgIGlmICghY2FsbElkKSB7IGlucHV0LnZhbHVlID0gdGV4dDsgc3luY0NvbXBvc2VyKCk7IHJldHVybjsgfVxuICB9XG4gIC8vIFwiL3QzIFx1MjAyNlwiIGFuZCBcIi9oIFx1MjAyNlwiIHBpY2sgdGhlIGFnZW50IHdoYXRldmVyIHRoZSBzZWxlY3RvciBzYXlzLlxuICBjb25zdCBwYXJzZWQgPSBwYXJzZVByZWZpeCh0ZXh0KTtcbiAgY29uc3QgbW9kZSA9IHBhcnNlZC5tb2RlID8/ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwibW9kZVwiKS52YWx1ZTtcbiAgdGV4dCA9IHBhcnNlZC5yZXN0O1xuICBpZiAoIXRleHQpIHJldHVybjtcbiAgaWYgKG1vZGUgPT09IFwic2F5XCIpIHtcbiAgICBwdXNoKHsgdHlwZTogXCJzYXlcIiwgdGV4dCB9KTtcbiAgICBzY3JvbGxEb3duKHRydWUpO1xuICB9IGVsc2Uge1xuICAgIHB1c2goeyB0eXBlOiBcImFza1wiLCB0ZXh0LCBhZ2VudDogbW9kZSB9KTtcbiAgICBub3RlKGBZb3UgXHUyMTkyIG5ldyAke21vZGUgPT09IFwidDNcIiA/IFwiY29kaW5nXCIgOiBcIkhlcm1lc1wifSB0YXNrOiAke3RleHR9YCk7XG4gICAgc2Nyb2xsRG93bih0cnVlKTtcbiAgfVxuICBpbnB1dC52YWx1ZSA9IFwiXCI7XG4gIHN5bmNDb21wb3NlcigpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBtYWluKCkge1xuICBhcHBseVRoZW1lKGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UudGhlbWVcIikgPz8gXCJzeXN0ZW1cIik7XG4gIHNlcnZlciA9IGF3YWl0IChhd2FpdCBmZXRjaChcIi9jb25maWdcIikpLmpzb24oKTtcbiAgJChcInJvdXRlXCIpLnRleHRDb250ZW50ID0gYCR7c2VydmVyLnJvdXRlID09PSBcInZlcnRleFwiID8gXCJWZXJ0ZXhcIiA6IFwiR2VtaW5pIEFQSVwifSBcdTAwQjcgJHtzZXJ2ZXIubW9kZWwuc3BsaXQoXCIvXCIpLnBvcCgpfWA7XG4gICQoXCJ2ZXJzaW9uXCIpLnRleHRDb250ZW50ID0gc2VydmVyLnZlcnNpb247XG4gICQoXCJidWlsZFwiKS50ZXh0Q29udGVudCA9IGBjb3JlICR7c2VydmVyLnZlcnNpb259YDtcbiAgc2V0dGluZ3NGcm9tU3RvcmFnZSgpO1xuICBjb25zdCB3YWtlU2VsZWN0ID0gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJ3YWtlLW1vZGVsXCIpO1xuICBjb25zdCB3YWtlTGlzdCA9IHNlcnZlci53YWtlTW9kZWxzID8/IFtdO1xuICBmb3IgKGNvbnN0IG0gb2Ygd2FrZUxpc3QpIHdha2VTZWxlY3QuYWRkKG5ldyBPcHRpb24obS5sYWJlbCwgbS5pZCkpO1xuICBjb25zdCBzYXZlZFdha2VNb2RlbCA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2Uud2FrZS1tb2RlbFwiKTtcbiAgaWYgKHNhdmVkV2FrZU1vZGVsICYmIHdha2VMaXN0LnNvbWUoKG0pID0+IG0uaWQgPT09IHNhdmVkV2FrZU1vZGVsKSkgd2FrZVNlbGVjdC52YWx1ZSA9IHNhdmVkV2FrZU1vZGVsO1xuICBlbHNlIGlmICh3YWtlTGlzdC5zb21lKChtKSA9PiBtLmlkID09PSBcInBlbm55d29ydGhcIikpIHdha2VTZWxlY3QudmFsdWUgPSBcInBlbm55d29ydGhcIjtcbiAgaWYgKHdha2VMaXN0Lmxlbmd0aCA9PT0gMCkge1xuICAgICQ8SFRNTElucHV0RWxlbWVudD4oXCJ3YWtlLWVuYWJsZWRcIikuZGlzYWJsZWQgPSB0cnVlO1xuICAgIHdha2VTZWxlY3QuZGlzYWJsZWQgPSB0cnVlO1xuICAgICQoXCJ3YWtlLWhlbHBcIikudGV4dENvbnRlbnQgPSBcIk5vIC5vbm54IHdha2Ugd29yZCBtb2RlbHMgZm91bmQgb24gdGhlIHNlcnZlci5cIjtcbiAgfVxuICBpZiAoIXNlcnZlci5oZXJtZXMpIHsgJDxIVE1MSW5wdXRFbGVtZW50PihcImZha2VoZXJtZXNcIikuY2hlY2tlZCA9IHRydWU7ICQ8SFRNTElucHV0RWxlbWVudD4oXCJmYWtlaGVybWVzXCIpLmRpc2FibGVkID0gdHJ1ZTsgfVxuICBpZiAoIXNlcnZlci50MykgJChcImNvZGluZ2hlbHBcIikudGV4dENvbnRlbnQgPSBcIlQzIGlzbid0IGF2YWlsYWJsZSBvbiB0aGUgc2VydmVyOiBvbmx5IHdpdGggZmFrZSBhbnN3ZXJzLlwiO1xuICBlbHNlICQoXCJjb2RpbmdoZWxwXCIpLnRleHRDb250ZW50ID0gYENvZGUgY2hhbmdlcyBnbyB0byBhIFQzIENvZGUgdGhyZWFkIGluIG9uZSBvZjogJHtzZXJ2ZXIudDMuam9pbihcIiwgXCIpfS5gO1xuICBpZiAoIXN0b3BXb3Jkcy5zdXBwb3J0ZWQpIHsgJDxIVE1MSW5wdXRFbGVtZW50PihcInN0b3B3b3JkXCIpLmNoZWNrZWQgPSBmYWxzZTsgJDxIVE1MSW5wdXRFbGVtZW50PihcInN0b3B3b3JkXCIpLmRpc2FibGVkID0gdHJ1ZTsgfVxuICBjb25zdCBwcmVzZXQgPSAkPEhUTUxTZWxlY3RFbGVtZW50PihcInByZXNldFwiKTtcbiAgZm9yIChjb25zdCBuYW1lIG9mIE9iamVjdC5rZXlzKFBSRVNFVFMpKSBwcmVzZXQuYWRkKG5ldyBPcHRpb24obmFtZSwgbmFtZSkpO1xuICBwcmVzZXQudmFsdWUgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLWNvcmUucHJlc2V0XCIpID8/IFwid2ViXCI7XG4gIGlmICghUFJFU0VUU1twcmVzZXQudmFsdWVdKSBwcmVzZXQudmFsdWUgPSBcIndlYlwiO1xuICAkPEhUTUxUZXh0QXJlYUVsZW1lbnQ+KFwiY29uZmlnXCIpLnZhbHVlID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS1jb3JlLmNvbmZpZ1wiKSA/PyBKU09OLnN0cmluZ2lmeShQUkVTRVRTW3ByZXNldC52YWx1ZV0sIG51bGwsIDIpO1xuICBzeW5jU2lnbmFsaW5nVWkoKTtcbiAgcHJlc2V0Lm9uY2hhbmdlID0gKCkgPT4ge1xuICAgICQ8SFRNTFRleHRBcmVhRWxlbWVudD4oXCJjb25maWdcIikudmFsdWUgPSBKU09OLnN0cmluZ2lmeShQUkVTRVRTW3ByZXNldC52YWx1ZV0sIG51bGwsIDIpO1xuICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2UtY29yZS5wcmVzZXRcIiwgcHJlc2V0LnZhbHVlKTtcbiAgICBsb2NhbFN0b3JhZ2UucmVtb3ZlSXRlbShcInZvaWNlLWNvcmUuY29uZmlnXCIpO1xuICAgIHN5bmNTaWduYWxpbmdVaSgpO1xuICB9O1xuICAkKFwiY29uZmlnXCIpLm9uaW5wdXQgPSAoKSA9PiB7IGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2UtY29yZS5jb25maWdcIiwgJDxIVE1MVGV4dEFyZWFFbGVtZW50PihcImNvbmZpZ1wiKS52YWx1ZSk7IHN5bmNTaWduYWxpbmdVaSgpOyB9O1xuICAkKFwiZGVmYXVsdHNcIikub25jbGljayA9IGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBjID0gY29yZSA/PyAoYXdhaXQgbG9hZENvcmUoKSk7XG4gICAgJChcImRlZmF1bHRzdmlld1wiKS50ZXh0Q29udGVudCA9IEpTT04uc3RyaW5naWZ5KEpTT04ucGFyc2UoYy5kZWZhdWx0cygpKSwgbnVsbCwgMik7XG4gICAgJChcImRlZmF1bHRzdmlld1wiKS5oaWRkZW4gPSAhJChcImRlZmF1bHRzdmlld1wiKS5oaWRkZW47XG4gIH07XG4gIGNvbnN0IG9uQ2FsbENsaWNrID0gKCkgPT4gdm9pZCBjYWxsQnV0dG9uKCkuY2F0Y2goKGVycikgPT4geyB0b2FzdChlcnIubWVzc2FnZSk7IGxvZyhcImVycm9yXCIsIGVyci5tZXNzYWdlLCBcImVyclwiKTsgfSk7XG4gIGNvbnN0IG9uSGVyb0NhbGxDbGljayA9ICgpID0+IHsgaWYgKCFjYWxsSWQpIHZvaWQgc3RhcnQoKS5jYXRjaCgoZXJyKSA9PiB7IHRvYXN0KGVyci5tZXNzYWdlKTsgbG9nKFwiZXJyb3JcIiwgZXJyLm1lc3NhZ2UsIFwiZXJyXCIpOyB9KTsgfTtcbiAgY29uc3Qgb25SZXN1bWVDbGljayA9ICgpID0+IHZvaWQgc3RhcnQodHJ1ZSkuY2F0Y2goKGVycikgPT4geyB0b2FzdChlcnIubWVzc2FnZSk7IGxvZyhcImVycm9yXCIsIGVyci5tZXNzYWdlLCBcImVyclwiKTsgfSk7XG4gICQoXCJjYWxsXCIpLm9uY2xpY2sgPSBvbkNhbGxDbGljaztcbiAgJChcImhlcm8tY2FsbFwiKS5vbmNsaWNrID0gb25IZXJvQ2FsbENsaWNrO1xuICAkKFwiaGVyby13YWtlXCIpLm9uY2xpY2sgPSAoKSA9PiB7XG4gICAgaWYgKHdha2VBcm1lZCAmJiBhdWRpby5hdWRpb1N1c3BlbmRlZCkgeyB2b2lkIGF1ZGlvLnJlc3VtZUF1ZGlvKCkudGhlbigoKSA9PiBzeW5jV2FrZVVpKCkpOyByZXR1cm47IH1cbiAgICB2b2lkIGFybVdha2UoIXdha2VBcm1lZCk7XG4gIH07XG4gICQoXCJ3YWtlYnRuXCIpLm9uY2xpY2sgPSAoKSA9PiB7XG4gICAgaWYgKHdha2VBcm1lZCAmJiBhdWRpby5hdWRpb1N1c3BlbmRlZCkgeyB2b2lkIGF1ZGlvLnJlc3VtZUF1ZGlvKCkudGhlbigoKSA9PiBzeW5jV2FrZVVpKCkpOyByZXR1cm47IH1cbiAgICB2b2lkIGFybVdha2UoIXdha2VBcm1lZCk7XG4gIH07XG4gICQoXCJ3YWtlLW5vd1wiKS5vbmNsaWNrID0gKCkgPT4geyBpZiAoY2FsbElkKSBwdXNoKHsgdHlwZTogXCJyZXN1bWVcIiB9KTsgfTtcbiAgJChcInJlc3VtZVwiKS5vbmNsaWNrID0gb25SZXN1bWVDbGljaztcbiAgJChcImhlcm8tcmVzdW1lXCIpLm9uY2xpY2sgPSBvblJlc3VtZUNsaWNrO1xuICBzeW5jV2FrZVVpKCk7XG4gIGlmIChsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLndha2UtZW5hYmxlZFwiKSA9PT0gXCIxXCIgJiYgd2FrZUxpc3QubGVuZ3RoID4gMCkge1xuICAgIC8vIFJlLWFybSBhdXRvbWF0aWNhbGx5IG9uIHJlbG9hZCBvbmx5IHdoZW4gbWljcm9waG9uZSBwZXJtaXNzaW9uIGlzIGFscmVhZHkgZ3JhbnRlZC5cbiAgICB2b2lkIG5hdmlnYXRvci5wZXJtaXNzaW9ucz8ucXVlcnkoeyBuYW1lOiBcIm1pY3JvcGhvbmVcIiBhcyBQZXJtaXNzaW9uTmFtZSB9KVxuICAgICAgLnRoZW4oKHApID0+IHsgaWYgKHAuc3RhdGUgPT09IFwiZ3JhbnRlZFwiKSB2b2lkIGFybVdha2UodHJ1ZSwgZmFsc2UpOyB9KVxuICAgICAgLmNhdGNoKCgpID0+IHt9KTtcbiAgfVxuICBpZiAoc2F2ZWRIaXN0b3J5KCkubGVuZ3RoID4gMCkge1xuICAgIHN5bmNSZXN1bWVCdXR0b25zKHRydWUpO1xuICAgICQoXCJyZXN1bWVcIikudGl0bGUgPSBcIkNhbGwgYWdhaW4sIGNhcnJ5aW5nIG9uIGZyb20gdGhlIGxhc3QgY29udmVyc2F0aW9uXCI7XG4gIH1cbiAgJChcIm1pY1wiKS5vbmNsaWNrID0gKCkgPT4gc2V0TXV0ZWQoIW11dGVkKTtcbiAgJChcImh1c2hcIikub25jbGljayA9ICgpID0+IHsgcHVzaCh7IHR5cGU6IFwiaW50ZXJydXB0XCIgfSk7IGF1ZGlvLmZsdXNoKCk7IH07XG4gICQoXCJjYW5jZWxhbGxcIikub25jbGljayA9ICgpID0+IHB1c2goeyB0eXBlOiBcImNhbmNlbEFsbFwiIH0pO1xuICAkKFwiZG9uZWJveFwiKS5hZGRFdmVudExpc3RlbmVyKFwidG9nZ2xlXCIsICgpID0+IHsgaWYgKCQ8SFRNTERldGFpbHNFbGVtZW50PihcImRvbmVib3hcIikub3BlbikgJChcImRvbmVib3hcIikuc2Nyb2xsSW50b1ZpZXcoeyBibG9jazogXCJuZWFyZXN0XCIgfSk7IH0pO1xuICAkKFwic2F5XCIpLm9uc3VibWl0ID0gKGUpID0+IHZvaWQgc3VibWl0VGV4dChlKTtcbiAgJChcInRleHRcIikuYWRkRXZlbnRMaXN0ZW5lcihcImlucHV0XCIsIHN5bmNDb21wb3Nlcik7XG4gIGNvbnN0IHRyYW5zY3JpcHRQYW5lID0gJChcInRyYW5zY3JpcHRcIik7XG4gIHRyYW5zY3JpcHRQYW5lLmFkZEV2ZW50TGlzdGVuZXIoXCJzY3JvbGxcIiwgKCkgPT4gdHJhbnNjcmlwdFNjcm9sbC5vblNjcm9sbCgpLCB7IHBhc3NpdmU6IHRydWUgfSk7XG4gIHRyYW5zY3JpcHRQYW5lLmFkZEV2ZW50TGlzdGVuZXIoXCJzY3JvbGxlbmRcIiwgKCkgPT4gdHJhbnNjcmlwdFNjcm9sbC5vblNjcm9sbEVuZCgpLCB7IHBhc3NpdmU6IHRydWUgfSk7XG4gIHRyYW5zY3JpcHRQYW5lLmFkZEV2ZW50TGlzdGVuZXIoXCJ3aGVlbFwiLCAoZSkgPT4geyBpZiAoZS5kZWx0YVkgPCAwKSB0cmFuc2NyaXB0U2Nyb2xsLmNhbmNlbEp1bXAoKTsgfSwgeyBwYXNzaXZlOiB0cnVlIH0pO1xuICB0cmFuc2NyaXB0UGFuZS5hZGRFdmVudExpc3RlbmVyKFwidG91Y2hzdGFydFwiLCAoKSA9PiB0cmFuc2NyaXB0U2Nyb2xsLmNhbmNlbEp1bXAoKSwgeyBwYXNzaXZlOiB0cnVlIH0pO1xuICBpZiAodHlwZW9mIFJlc2l6ZU9ic2VydmVyICE9PSBcInVuZGVmaW5lZFwiKSBuZXcgUmVzaXplT2JzZXJ2ZXIoKCkgPT4gdHJhbnNjcmlwdFNjcm9sbC5vblJlc2l6ZSgpKS5vYnNlcnZlKHRyYW5zY3JpcHRQYW5lKTtcbiAgJChcImp1bXBib3R0b21cIikub25jbGljayA9ICgpID0+IHRyYW5zY3JpcHRTY3JvbGwuanVtcFRvQm90dG9tKCk7XG4gIHN5bmNDb21wb3NlcigpO1xuICB0YWJzKCk7XG4gIGtleXMoKTtcbiAgY29uc3QgZXZlbnRzID0gbmV3IEV2ZW50U291cmNlKFwiL2V2ZW50c1wiKTtcbiAgZXZlbnRzLmFkZEV2ZW50TGlzdGVuZXIoXCJjb3JlXCIsIChlKSA9PiB7XG4gICAgY29uc3QgeyB2ZXJzaW9uIH0gPSBKU09OLnBhcnNlKChlIGFzIE1lc3NhZ2VFdmVudCkuZGF0YSk7XG4gICAgJChcInZlcnNpb25cIikudGV4dENvbnRlbnQgPSB2ZXJzaW9uICsgKGNhbGxJZCAmJiBjb3JlICYmIGNvcmUudmVyc2lvbiAhPT0gdmVyc2lvbiA/IGAgKG5leHQgY2FsbDsgdGhpcyBvbmUgcnVucyAke2NvcmUudmVyc2lvbn0pYCA6IFwiXCIpO1xuICAgICQoXCJidWlsZFwiKS50ZXh0Q29udGVudCA9IGBjb3JlICR7dmVyc2lvbn1gO1xuICB9KTtcbiAgZXZlbnRzLmFkZEV2ZW50TGlzdGVuZXIoXCJhcHBcIiwgKCkgPT4geyBpZiAoIWNhbGxJZCkgbG9jYXRpb24ucmVsb2FkKCk7IGVsc2UgdG9hc3QoXCJUaGUgcGFnZSBjaGFuZ2VkOiByZWxvYWQgYWZ0ZXIgdGhpcyBjYWxsXCIpOyB9KTtcbiAgZXZlbnRzLmFkZEV2ZW50TGlzdGVuZXIoXCJlcnJvclwiLCAoZSkgPT4ge1xuICAgIGNvbnN0IGRhdGEgPSAoZSBhcyBNZXNzYWdlRXZlbnQpLmRhdGE7XG4gICAgaWYgKGRhdGEpIHRvYXN0KGBCdWlsZCBmYWlsZWQ6ICR7SlNPTi5wYXJzZShkYXRhKS5tZXNzYWdlfWApO1xuICB9KTtcbiAgbmV3IFJlcGxheSgkKFwicmVwbGF5XCIpLCBsb2FkQ29yZSk7XG4gIHZvaWQgcGluZygpO1xuICB2b2lkIHNob3dFYXJsaWVyKCk7XG4gIHdpbmRvdy5zZXRJbnRlcnZhbCgoKSA9PiB2b2lkIHNob3dFYXJsaWVyKCksIDMwXzAwMCk7XG59XG5cbnZvaWQgbWFpbigpO1xuIl0sCiAgIm1hcHBpbmdzIjogIjtBQVNBLElBQU0sU0FBUyxvQkFBSSxJQUFJO0FBQUEsRUFDckI7QUFBQSxFQUFPO0FBQUEsRUFBTTtBQUFBLEVBQVE7QUFBQSxFQUFVO0FBQUEsRUFBTztBQUFBLEVBQVE7QUFBQSxFQUFNO0FBQUEsRUFBTTtBQUFBLEVBQU07QUFBQSxFQUFNO0FBQUEsRUFBVztBQUFBLEVBQVM7QUFBQSxFQUFRO0FBQUEsRUFBTztBQUFBLEVBQVU7QUFBQSxFQUFTO0FBQUEsRUFDNUg7QUFDRixDQUFDO0FBR00sU0FBUyxNQUFNLE1BQXdCO0FBQzVDLFNBQU8sS0FBSyxZQUFZLEVBQUUsUUFBUSxVQUFVLEVBQUUsRUFBRSxRQUFRLHFCQUFxQixHQUFHLEVBQUUsS0FBSyxFQUFFLE1BQU0sR0FBRyxFQUFFLE9BQU8sQ0FBQyxNQUFNLEVBQUUsU0FBUyxDQUFDO0FBQ2hJO0FBR08sU0FBUyxVQUFVLFdBQW1CLFVBQXlCLFFBQWtCLENBQUMsR0FBd0I7QUFDL0csUUFBTSxVQUFVLG9CQUFJLElBQUksQ0FBQyxHQUFHLFFBQVEsR0FBRyxNQUFNLFFBQVEsS0FBSyxDQUFDLENBQUM7QUFDNUQsUUFBTSxPQUFPLE1BQU0sU0FBUztBQUM1QixNQUFJLE9BQU87QUFDWCxNQUFJLEtBQUssS0FBSztBQUNkLFNBQU8sT0FBTyxNQUFNLFFBQVEsSUFBSSxLQUFLLElBQUksQ0FBQyxFQUFHO0FBQzdDLFNBQU8sS0FBSyxRQUFRLFFBQVEsSUFBSSxLQUFLLEtBQUssQ0FBQyxDQUFDLEVBQUc7QUFDL0MsTUFBSSxTQUFTLE1BQU0sS0FBSyxPQUFPLEVBQUcsUUFBTztBQUN6QyxRQUFNQSxRQUFPLEtBQUssTUFBTSxNQUFNLEVBQUUsRUFBRSxLQUFLLEdBQUc7QUFDMUMsUUFBTSxLQUFLLENBQUMsWUFBc0IsUUFBUSxLQUFLLENBQUMsTUFBTSxNQUFNLENBQUMsRUFB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QUFjO0FBQ3ZILElBQUUsWUFBWSxFQUFFLFVBQVUsTUFBTSxpQkFBaUIsYUFBYTtBQUM5RCxlQUFhO0FBQ2IsT0FBSztBQUNMLE9BQUs7QUFDTCxRQUFNLFNBQVMsSUFBSSxZQUFZLFNBQVM7QUFDeEMsU0FBTyxpQkFBaUIsUUFBUSxDQUFDLE1BQU07QUFDckMsVUFBTSxFQUFFLFFBQVEsSUFBSSxLQUFLLE1BQU8sRUFBbUIsSUFBSTtBQUN2RCxNQUFFLFNBQVMsRUFBRSxjQUFjLFdBQVcsVUFBVSxRQUFRLEtBQUssWUFBWSxVQUFVLDhCQUE4QixLQUFLLE9BQU8sTUFBTTtBQUNuSSxNQUFFLE9BQU8sRUFBRSxjQUFjLFFBQVEsT0FBTztBQUFBLEVBQzFDLENBQUM7QUFDRCxTQUFPLGlCQUFpQixPQUFPLE1BQU07QUFBRSxRQUFJLENBQUMsT0FBUSxVQUFTLE9BQU87QUFBQSxRQUFRLE9BQU0sMENBQTBDO0FBQUEsRUFBRyxDQUFDO0FBQ2hJLFNBQU8saUJBQWlCLFNBQVMsQ0FBQyxNQUFNO0FBQ3RDLFVBQU0sT0FBUSxFQUFtQjtBQUNqQyxRQUFJLEtBQU0sT0FBTSxpQkFBaUIsS0FBSyxNQUFNLElBQUksRUFBRSxPQUFPLEVBQUU7QUFBQSxFQUM3RCxDQUFDO0FBQ0QsTUFBSSxPQUFPLEVBQUUsUUFBUSxHQUFHLFFBQVE7QUFDaEMsT0FBSyxLQUFLO0FBQ1YsT0FBSyxZQUFZO0FBQ2pCLFNBQU8sWUFBWSxNQUFNLEtBQUssWUFBWSxHQUFHLEdBQU07QUFDckQ7QUFFQSxLQUFLLEtBQUs7IiwKICAibmFtZXMiOiBbImNvcmUiLCAiY29yZSIsICJub3ciLCAibGl2ZSIsICJsaW5lIiwgInJ1biIsICJtb2RlIl0KfQo=
