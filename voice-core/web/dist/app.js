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
      let ctx = null;
      try {
        ctx = new AudioContext({ latencyHint: "interactive" });
        ctx.onstatechange = () => this.stateListener?.();
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
          await ctx?.close?.();
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

// web/ui.ts
function normalizeDensity(value) {
  return value === "comfortable" ? "comfortable" : "compact";
}
function normalizeSideFilter(value) {
  if (value === "active" || value === "results") return value;
  return "all";
}
function parsePrefix(text) {
  const m = text.match(/^\/(t3|code|h|hermes)\s+(.*)$/is);
  if (!m) return { mode: null, rest: text };
  return { mode: /^(t3|code)$/i.test(m[1]) ? "t3" : "hermes", rest: m[2].trim() };
}
function canFollowUpResult(resultSession, activeSession2, hasTask) {
  return activeSession2 > 0 && resultSession === activeSession2 && hasTask;
}
function shouldClearUnreadResults(isMobile, drawerOpen, filter) {
  return !isMobile || drawerOpen && filter !== "active";
}
function resolveMobileBannerFilter(current, activeTotal, unreadResults) {
  if (activeTotal > 0) return current === "results" ? "all" : current;
  if (unreadResults > 0) return "results";
  return current;
}
function plainPreview(text, maxLen = 150) {
  const cleaned = text.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code) => ` ${code.trim()} `).replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1").replace(/^#{1,6}\s+/gm, "").replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, "").replace(/`([^`\n]+)`/g, "$1").replace(/\*\*([^*\n]+)\*\*/g, "$1").replace(/__([^_\n]+)__/g, "$1").replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLen) return cleaned;
  const cut = cleaned.slice(0, maxLen);
  const space = cut.lastIndexOf(" ");
  const base = space > Math.floor(maxLen * 0.6) ? cut.slice(0, space) : cut;
  return `${base.replace(/[.,;:\s-]+$/, "")}\u2026`;
}
function formatShortTime(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function resolveSideSections(filter, counts2) {
  if (filter === "results") {
    return {
      showTasksSection: false,
      showEmptyTasks: false,
      showResultsSection: true,
      showEmptyResults: counts2.results === 0,
      showEarlierSection: false,
      showDoneSection: false
    };
  }
  if (filter === "active") {
    return {
      showTasksSection: true,
      showEmptyTasks: counts2.active === 0 && counts2.earlier === 0,
      showResultsSection: false,
      showEmptyResults: false,
      showEarlierSection: counts2.earlier > 0,
      showDoneSection: counts2.done > 0
    };
  }
  const hasAnythingAboveDone = counts2.active > 0 || counts2.results > 0 || counts2.earlier > 0;
  return {
    showTasksSection: counts2.active > 0 || !hasAnythingAboveDone,
    showEmptyTasks: !hasAnythingAboveDone,
    showResultsSection: counts2.results > 0,
    showEmptyResults: false,
    showEarlierSection: counts2.earlier > 0,
    showDoneSection: counts2.done > 0
  };
}

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
var sessionSeq = 0;
var activeSession = 0;
var callName = "";
var ticker = 0;
var traceTimer = 0;
var startedAt = now();
var sockets = /* @__PURE__ */ new Map();
var captionSockets = /* @__PURE__ */ new Set();
var runs = /* @__PURE__ */ new Map();
var tasks = /* @__PURE__ */ new Map();
var results = /* @__PURE__ */ new Map();
var nextResultSeq = 0;
var sideFilter = "all";
var unreadMobileResults = 0;
var flashTimer = 0;
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
var callWhileSpeaking = "send";
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
function applyDensity(choice) {
  const density = normalizeDensity(choice);
  const root = document.documentElement;
  if (density === "comfortable") root.dataset.density = "comfortable";
  else delete root.dataset.density;
  for (const btn of Array.from(document.querySelectorAll("#density-picker button"))) {
    btn.classList.toggle("on", btn.dataset.density === density);
  }
  requestAnimationFrame(() => updateAllResultClamping());
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
function resultClampPx(el) {
  const raw = getComputedStyle(el).getPropertyValue("--res-clamp-max").trim();
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 64;
}
function syncExpandAllButton() {
  const clamped = [...results.values()].filter((r) => r.card.classList.contains("clamped"));
  const btn = $("toggle-all-results");
  btn.hidden = clamped.length === 0;
  if (clamped.length === 0) return;
  const anyCollapsed = clamped.some((r) => !r.card.classList.contains("open"));
  btn.textContent = anyCollapsed ? "Expand all" : "Collapse all";
}
function setResultOpen(entry, open) {
  const clamped = entry.card.classList.contains("clamped");
  const next = clamped && open;
  entry.card.classList.toggle("open", next);
  entry.head.setAttribute("aria-expanded", String(!clamped || next));
  entry.moreBtn.textContent = next ? "Show less" : "Show more";
  syncExpandAllButton();
}
function updateResultClamping(entry) {
  if (entry.body.offsetParent === null) return;
  const overflows = entry.body.scrollHeight > resultClampPx(entry.card) + 4;
  entry.card.classList.toggle("clamped", overflows);
  if (!overflows) entry.card.classList.remove("open");
  entry.moreBtn.hidden = !overflows;
  const isOpen = entry.card.classList.contains("open");
  entry.moreBtn.textContent = isOpen ? "Show less" : "Show more";
  entry.head.setAttribute("aria-expanded", String(!overflows || isOpen));
}
function updateAllResultClamping() {
  for (const entry of results.values()) updateResultClamping(entry);
  syncExpandAllButton();
}
function syncResultFollowUpButtons() {
  for (const entry of results.values()) {
    if (!entry.followBtn) continue;
    const canFollow = canFollowUpResult(entry.sessionId, activeSession, Boolean(entry.taskId && tasks.has(entry.taskId)));
    entry.followBtn.hidden = !canFollow;
    if (!canFollow) entry.card.querySelector("form")?.remove();
  }
}
function clearUnreadIfResultsVisible() {
  if (unreadMobileResults === 0) return;
  const drawerOpen = document.body.classList.contains("tasks-open");
  if (shouldClearUnreadResults(mobileLayout.matches, drawerOpen, sideFilter)) {
    unreadMobileResults = 0;
    updateTaskChrome();
  }
}
function focusResult(id) {
  const entry = results.get(id);
  if (!entry) return;
  if (sideFilter === "active") setSideFilter("all");
  if (mobileLayout.matches) setTasksOpen(true);
  requestAnimationFrame(() => {
    updateResultClamping(entry);
    if (entry.card.classList.contains("clamped")) setResultOpen(entry, true);
    for (const r of results.values()) r.card.classList.remove("flash");
    void entry.card.offsetWidth;
    entry.card.classList.add("flash");
    clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => entry.card.classList.remove("flash"), 1400);
    entry.card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
}
function result(agent, label, text, failed = false, taskId, sessionId = activeSession) {
  $("empty").hidden = true;
  const id = `res-${++nextResultSeq}`;
  const who = agent === "t3" ? "T3" : "Hermes";
  const agentCls = agent === "t3" ? "t3" : "";
  const snippet = plainPreview(text, 160) || "(empty response)";
  const refRow = document.createElement("button");
  refRow.type = "button";
  refRow.className = `line handoff ${agentCls} ${failed ? "failed" : ""}`.trim();
  refRow.dataset.resultId = id;
  refRow.innerHTML = `<span class="badge ${agentCls}">${who}</span><span class="handoff-label">${escapeHtml(label)}</span><span class="handoff-snippet">${escapeHtml(snippet)}</span><span class="handoff-cue">${failed ? "Failed" : "Open \u2197"}</span>`;
  refRow.onclick = () => focusResult(id);
  $("transcript").append(refRow);
  openLine = null;
  scrollDown();
  const card = document.createElement("article");
  card.className = `res-card ${agentCls} ${failed ? "failed" : ""}`.trim();
  card.dataset.resultId = id;
  const head = document.createElement("button");
  head.type = "button";
  head.className = "res-head";
  head.setAttribute("aria-expanded", "true");
  head.innerHTML = `<span class="badge ${agentCls}">${who}</span><span class="res-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span>` + (failed ? `<span class="res-pill">Failed</span>` : "") + `<span class="res-time">${formatShortTime(/* @__PURE__ */ new Date())}</span><span class="res-chev" aria-hidden="true"></span>`;
  const body = document.createElement("div");
  body.className = "res-body";
  body.innerHTML = markdown(text);
  const foot = document.createElement("div");
  foot.className = "res-foot";
  const moreBtn = document.createElement("button");
  moreBtn.type = "button";
  moreBtn.className = "res-act primary";
  moreBtn.textContent = "Show more";
  moreBtn.hidden = true;
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "res-act";
  copyBtn.textContent = "Copy";
  copyBtn.onclick = () => {
    void navigator.clipboard?.writeText(text);
    toast("Result copied");
  };
  foot.append(moreBtn, copyBtn);
  let followBtn;
  if (taskId) {
    followBtn = document.createElement("button");
    followBtn.type = "button";
    followBtn.className = "res-act";
    followBtn.textContent = "Follow up";
    followBtn.onclick = () => {
      if (!canFollowUpResult(sessionId, activeSession, tasks.has(taskId))) {
        syncResultFollowUpButtons();
        return;
      }
      const view = tasks.get(taskId);
      if (view) followUpForm(card, view.c, sessionId);
    };
    foot.append(followBtn);
  }
  card.append(head, body, foot);
  const entry = { id, agent, label, text, failed, taskId, sessionId, card, head, body, moreBtn, followBtn, refRow };
  const toggle = () => {
    if (!entry.card.classList.contains("clamped")) return;
    setResultOpen(entry, !entry.card.classList.contains("open"));
  };
  head.onclick = toggle;
  moreBtn.onclick = toggle;
  results.set(id, entry);
  $("results").prepend(card);
  const drawerOpen = document.body.classList.contains("tasks-open");
  if (!shouldClearUnreadResults(mobileLayout.matches, drawerOpen, sideFilter)) unreadMobileResults++;
  syncSideLayout();
  updateTaskChrome();
  requestAnimationFrame(() => {
    updateResultClamping(entry);
    syncExpandAllButton();
  });
  return id;
}
function elapsed(seconds) {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const m = Math.floor(seconds / 60);
  return m < 60 ? `${m}m ${Math.floor(seconds % 60)}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
var noTasks = document.getElementById("notasks");
var live = (state) => state === "running" || state.startsWith("waiting");
var isActiveTask = (view) => live(view.c.state) || Boolean(view.approval);
function setSideFilter(filter) {
  sideFilter = normalizeSideFilter(filter);
  for (const btn of Array.from(document.querySelectorAll("#side-tabs button"))) {
    const on = btn.dataset.filter === sideFilter;
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", String(on));
  }
  syncSideLayout();
  clearUnreadIfResultsVisible();
  requestAnimationFrame(() => updateAllResultClamping());
}
function syncSideLayout() {
  const all = [...tasks.values()];
  const activeCurrent = all.filter(isActiveTask).length;
  const activeTotal = activeCurrent + earlierActiveCount;
  const resultsTotal = results.size;
  const earlierShown = $("earlier").childElementCount;
  const doneTotal = $("donenow").childElementCount + $("doneearlier").childElementCount;
  const vis = resolveSideSections(sideFilter, {
    active: activeCurrent,
    results: resultsTotal,
    earlier: earlierShown,
    done: doneTotal
  });
  $("tasks-section").hidden = !vis.showTasksSection;
  noTasks.hidden = !vis.showEmptyTasks;
  $("results-section").hidden = !vis.showResultsSection;
  $("noresults").hidden = !vis.showEmptyResults;
  $("earlierbox").hidden = !vis.showEarlierSection;
  $("donebox").hidden = !vis.showDoneSection;
  $("side-active-n").textContent = activeTotal > 0 ? String(activeTotal) : "";
  $("side-results-n").textContent = resultsTotal > 0 ? String(resultsTotal) : "";
  $("resultscount").textContent = resultsTotal > 0 ? `\xB7 ${resultsTotal}` : "";
  $("donecount").textContent = doneTotal > 0 ? `\xB7 ${doneTotal}` : "";
  syncResultFollowUpButtons();
}
function updateTaskChrome() {
  const all = [...tasks.values()];
  const activeCurrent = all.filter(isActiveTask).length;
  const waiting = all.filter((t) => t.c.state.startsWith("waiting") || Boolean(t.approval)).length;
  const activeTotal = activeCurrent + earlierActiveCount;
  const attentionTotal = waiting + earlierWaitingCount;
  const badgeCount = activeTotal > 0 ? activeTotal : unreadMobileResults;
  const badge = $("tasks-badge");
  badge.hidden = badgeCount === 0;
  badge.textContent = String(badgeCount);
  badge.classList.toggle("warn", attentionTotal > 0);
  const bar = $("mobile-tasks-bar");
  const showBar = activeTotal > 0 || unreadMobileResults > 0;
  bar.hidden = !showBar;
  bar.classList.toggle("visible", showBar);
  bar.classList.toggle("warn", attentionTotal > 0);
  if (showBar) {
    const approval = all.find((t) => t.approval);
    const label = approval ? `Approval needed: ${approval.c.label}` : attentionTotal > 0 ? `${attentionTotal} task${attentionTotal > 1 ? "s" : ""} waiting for you` : activeTotal > 0 ? `${activeTotal} active task${activeTotal > 1 ? "s" : ""}` : `${unreadMobileResults} new agent result${unreadMobileResults > 1 ? "s" : ""}`;
    $("mtb-text").textContent = label;
  }
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
    syncSideLayout();
    updateTaskChrome();
    return;
  }
  const running = all.filter((t) => t.c.state === "running").length;
  const activeCount = all.filter(isActiveTask).length;
  $("taskcount").textContent = running > 0 ? `${running} running` : activeCount > 0 ? `${activeCount} waiting` : "";
  $("cancelall").hidden = !callId || running < 2;
  for (const view of all) {
    const t = view.c;
    const waiting = t.state.startsWith("waiting");
    const card = document.createElement("div");
    card.className = `task ${waiting ? "waiting" : t.state}`;
    const age = (view.ended ?? now()) - view.since;
    card.innerHTML = `<div class="meta-row"><span class="badge ${t.agent === "t3" ? "t3" : ""}">${t.agent === "t3" ? "T3" : "Hermes"}</span><span class="label"></span><span class="state">${t.state === "running" ? '<span class="spin"></span>' : ""}${escapeHtml(t.state)}</span><span class="age">${elapsed(age)}</span></div><div class="p"></div>`;
    const labelEl = card.querySelector(".label");
    labelEl.textContent = t.label;
    labelEl.title = t.label;
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
    if (callId && activeSession > 0) {
      const originSession = activeSession;
      button(waiting ? "Answer" : "Follow up", () => followUpForm(card, t, originSession));
      if (t.state === "running") button("Cancel", () => push({ type: "cancelTask", task: t.id }), "danger");
    }
    if (view.resultId) button("Result", () => focusResult(view.resultId));
    if (view.thread) button("Copy id", () => {
      void navigator.clipboard?.writeText(view.thread);
      toast("Thread id copied");
    });
    if (acts.childElementCount) card.append(acts);
    (isActiveTask(view) ? pane : done).append(card);
  }
  if (pane.childElementCount === 0) pane.append(noTasks);
  syncSideLayout();
  updateTaskChrome();
}
function followUpForm(card, t, originSession) {
  const existing = card.querySelector("form");
  if (existing) {
    existing.querySelector("input")?.focus();
    return;
  }
  const form = document.createElement("form");
  form.className = "followup-form";
  form.innerHTML = `<input type="text" placeholder="Tell \u201C${escapeHtml(t.label)}\u201D\u2026" enterkeyhint="send"><button type="submit">Send</button>`;
  const input = form.querySelector("input");
  form.onsubmit = (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (text) {
      if (!canFollowUpResult(originSession, activeSession, tasks.has(t.id))) {
        toast("That task's call has ended");
      } else {
        push({ type: "steer", task: t.id, text });
        note(`You \u2192 ${t.label}: ${text}`);
        scrollDown(true);
      }
    }
    input.blur();
    form.remove();
    showTasks();
  };
  input.onkeydown = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
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
    card.innerHTML = `<div class="meta-row"><span class="badge t3">T3</span><span class="label"></span><span class="state">${t.status === "running" ? '<span class="spin"></span>' : ""}${escapeHtml(state)}</span><span class="age">${elapsed(ago)} ago</span></div><div class="p"></div>`;
    const labelEl = card.querySelector(".label");
    labelEl.textContent = t.title;
    labelEl.title = t.title;
    card.querySelector(".p").textContent = t.last || (t.branch ? `On ${t.branch}` : "");
    const acts = document.createElement("div");
    acts.className = "acts";
    if (t.pr) {
      const a = document.createElement("a");
      a.href = t.pr;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "PR \u2197";
      acts.append(a);
    }
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copy id";
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
  syncSideLayout();
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
  if (!core || !callId) return [];
  const e = { ...event, t: now() };
  const quiet = e.type === "mic" || e.type === "tick";
  if (!quiet) log("in", e.type === "ws.message" ? `ws ${e.sid} \u2190 ${brief(String(e.data))}` : JSON.stringify(e).slice(0, 400), "in");
  const commands = JSON.parse(core.push(callId, JSON.stringify(e)));
  run2(commands);
  return commands;
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
  const originSession = activeSession;
  log("out", `${agent} ${c.followUp ? "follow-up" : "task"} "${c.label}"${c.project ? ` in ${c.project}` : ""}: ${c.request}`, "out");
  const abort = new AbortController();
  runs.set(c.run, { abort, agent, taskId: c.taskId });
  const done = (text, failed = false) => {
    if (!runs.has(c.run)) return;
    runs.delete(c.run);
    const view = tasks.get(c.taskId);
    const resId = result(agent, c.label, text, failed, c.taskId, originSession);
    notify(`${agent === "t3" ? "T3" : "Hermes"} \xB7 ${c.label}`, text);
    if (!failed) {
      remember("assistant", text, `${agent === "t3" ? "T3" : "Hermes"} \xB7 ${c.label}`);
      lastLine = null;
    }
    if (view) {
      view.resultId = resId;
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
    activeSession = ++sessionSeq;
    showTasks();
    counts = { mic: 0, play: 0, sent: 0 };
    metrics.reply = [];
    startedAt = now();
    muted = given.muted === true;
    const micCfg = given.mic && typeof given.mic === "object" ? given.mic : null;
    callWhileSpeaking = typeof micCfg?.whileSpeaking === "string" ? micCfg.whileSpeaking : "send";
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
  activeSession = 0;
  syncResultFollowUpButtons();
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
    const commands = push({ type: "wake" });
    const cutReply = commands.some((c) => c.type === "flush");
    if (cutReply && callWhileSpeaking !== "send" && callId !== 0 && hit.trailing.length > 0) {
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
  const density = localStorage.getItem("voice.density");
  applyDensity(density);
  for (const btn of Array.from(document.querySelectorAll("#density-picker button"))) {
    btn.onclick = () => {
      const choice = normalizeDensity(btn.dataset.density);
      localStorage.setItem("voice.density", choice);
      applyDensity(choice);
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
    clearUnreadIfResultsVisible();
    $("tasks-close").focus();
    requestAnimationFrame(() => updateAllResultClamping());
  } else if (!next && wasOpen) {
    const target = drawerOpener;
    drawerOpener = null;
    if (target && target.isConnected && !target.hidden && target.offsetParent !== null) {
      target.focus();
    } else if (target === $("mobile-tasks-bar")) {
      const fallback = $("tasks-toggle");
      if (!fallback.hidden && fallback.offsetParent !== null) fallback.focus();
    }
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
      if (name === "talk") requestAnimationFrame(() => updateAllResultClamping());
    };
  }
  for (const btn of Array.from(document.querySelectorAll("#side-tabs button"))) {
    btn.onclick = () => setSideFilter(normalizeSideFilter(btn.dataset.filter));
  }
  $("toggle-all-results").onclick = () => {
    const clamped = [...results.values()].filter((r) => r.card.classList.contains("clamped"));
    const openAll = clamped.some((r) => !r.card.classList.contains("open"));
    for (const entry of clamped) setResultOpen(entry, openAll);
  };
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
  const openMobileTasksDrawer = (opener) => {
    const activeTotal = [...tasks.values()].filter(isActiveTask).length + earlierActiveCount;
    const nextFilter = resolveMobileBannerFilter(sideFilter, activeTotal, unreadMobileResults);
    if (nextFilter !== sideFilter) setSideFilter(nextFilter);
    setTasksOpen(true, opener);
  };
  $("tasks-toggle").onclick = () => {
    if (document.body.classList.contains("tasks-open")) setTasksOpen(false);
    else openMobileTasksDrawer($("tasks-toggle"));
  };
  $("mobile-tasks-bar").onclick = () => openMobileTasksDrawer($("mobile-tasks-bar"));
  $("tasks-close").onclick = () => setTasksOpen(false);
  $("side-backdrop").onclick = () => setTasksOpen(false);
  mobileLayout.addEventListener("change", () => {
    setTasksOpen(false);
    clearUnreadIfResultsVisible();
    requestAnimationFrame(() => updateAllResultClamping());
  });
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
  applyDensity(localStorage.getItem("voice.density"));
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
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => transcriptScroll.onResize()).observe(transcriptPane);
    new ResizeObserver(() => updateAllResultClamping()).observe($("results"));
  }
  $("jumpbottom").onclick = () => transcriptScroll.jumpToBottom();
  syncComposer();
  syncSideLayout();
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL2NvbW1hbmRzLnRzIiwgIi4uL2F1ZGlvLnRzIiwgIi4uL3JlcGxheS50cyIsICIuLi9zY3JvbGwudHMiLCAiLi4vdWkudHMiLCAiLi4vd2FrZUNsaWVudC50cyIsICIuLi9hcHAudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFNwb2tlbiBjb21tYW5kcyB0aGUgY29yZSBhY3RzIG9uIHdpdGhvdXQgdGhlIG1vZGVsOiBcInN0b3BcIiBhbmQgXCJoYW5nIHVwXCIuIEFuIHV0dGVyYW5jZSBjb3VudHNcbi8vIG9ubHkgd2hlbiBpdCBpcyBvbmUgb2YgdGhlIHBocmFzZXMgYW5kIG5vdGhpbmcgbW9yZSwgb25jZSBuYW1lcyBhbmQgZmlsbGVycyBhcm91bmQgaXQgYXJlIGdvbmUsXG4vLyBzbyBcIldvb2Rob3VzZSwgc3RvcCBwbGVhc2VcIiBzdG9wcyBhbmQgXCJzdG9wIHRoZSBQZW5ueXdvcnRoIHRhc2tcIiBnb2VzIHRvIHRoZSBtb2RlbCBhcyB1c3VhbC5cblxuaW1wb3J0IHR5cGUgeyBWb2ljZUNvbW1hbmRzIH0gZnJvbSBcIi4vdHlwZXMudHNcIjtcblxuZXhwb3J0IHR5cGUgVm9pY2VDb21tYW5kID0gXCJzdG9wXCIgfCBcImhhbmdVcFwiIHwgXCJjYW5jZWxBbGxcIjtcblxuLyoqIFdvcmRzIHRoYXQgbWF5IGNvbWUgYmVmb3JlIG9yIGFmdGVyIGEgY29tbWFuZCB3aXRob3V0IGNoYW5naW5nIGl0LiAqL1xuY29uc3QgRklMTEVSID0gbmV3IFNldChbXG4gIFwiaGV5XCIsIFwib2tcIiwgXCJva2F5XCIsIFwicGxlYXNlXCIsIFwibm93XCIsIFwianVzdFwiLCBcInNvXCIsIFwidW1cIiwgXCJ1aFwiLCBcIm9oXCIsIFwiYWxyaWdodFwiLCBcInJpZ2h0XCIsIFwieWVhaFwiLCBcInllc1wiLCBcInRoYW5rc1wiLCBcInRoYW5rXCIsIFwieW91XCIsXG4gIFwiZ2VtaW5pXCIsXG5dKTtcblxuLyoqIFt0ZXh0XSBhcyBsb3dlci1jYXNlIHdvcmRzLCBhcG9zdHJvcGhlcyBkcm9wcGVkIChcIlRoYXQnc1wiIGlzIFwidGhhdHNcIikuICovXG5leHBvcnQgZnVuY3Rpb24gd29yZHModGV4dDogc3RyaW5nKTogc3RyaW5nW10ge1xuICByZXR1cm4gdGV4dC50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL1snXHUyMDE5YF0vZywgXCJcIikucmVwbGFjZSgvW15cXHB7TH1cXHB7TmR9XSsvZ3UsIFwiIFwiKS50cmltKCkuc3BsaXQoXCIgXCIpLmZpbHRlcigodykgPT4gdy5sZW5ndGggPiAwKTtcbn1cblxuLyoqIFRoZSBjb21tYW5kIFt1dHRlcmFuY2VdIGlzLCBpZiBpdCdzIG9uZSBhbmQgbm90aGluZyBtb3JlOyBbbmFtZXNdICh0aGUgYXNzaXN0YW50J3MsIFwiV29vZGhvdXNlXCIpIGRvbid0IGNvdW50LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbW1hbmRJbih1dHRlcmFuY2U6IHN0cmluZywgY29tbWFuZHM6IFZvaWNlQ29tbWFuZHMsIG5hbWVzOiBzdHJpbmdbXSA9IFtdKTogVm9pY2VDb21tYW5kIHwgbnVsbCB7XG4gIGNvbnN0IGlnbm9yZWQgPSBuZXcgU2V0KFsuLi5GSUxMRVIsIC4uLm5hbWVzLmZsYXRNYXAod29yZHMpXSk7XG4gIGNvbnN0IHNhaWQgPSB3b3Jkcyh1dHRlcmFuY2UpO1xuICBsZXQgZnJvbSA9IDA7XG4gIGxldCB0byA9IHNhaWQubGVuZ3RoO1xuICB3aGlsZSAoZnJvbSA8IHRvICYmIGlnbm9yZWQuaGFzKHNhaWRbZnJvbV0pKSBmcm9tKys7XG4gIHdoaWxlICh0byA+IGZyb20gJiYgaWdub3JlZC5oYXMoc2FpZFt0byAtIDFdKSkgdG8tLTtcbiAgaWYgKGZyb20gPT09IHRvIHx8IHRvIC0gZnJvbSA+IDUpIHJldHVybiBudWxsO1xuICBjb25zdCBjb3JlID0gc2FpZC5zbGljZShmcm9tLCB0bykuam9pbihcIiBcIik7XG4gIGNvbnN0IGlzID0gKHBocmFzZXM6IHN0cmluZ1tdKSA9PiBwaHJhc2VzLnNvbWUoKHApID0+IHdvcmRzKHApLmpvaW4oXCIgXCIpID09PSBjb3JlKTtcbiAgaWYgKGlzKGNvbW1hbmRzLmhhbmdVcCkpIHJldHVybiBcImhhbmdVcFwiO1xuICBpZiAoaXMoY29tbWFuZHMuY2FuY2VsQWxsID8/IFtdKSkgcmV0dXJuIFwiY2FuY2VsQWxsXCI7XG4gIGlmIChpcyhjb21tYW5kcy5zdG9wKSkgcmV0dXJuIFwic3RvcFwiO1xuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqIFdvcmRzIHRoYXQgdGFrZSBhIHJlcXVlc3QgYmFjay4gKi9cbmNvbnN0IENBTkNFTFMgPSAvXFxiKD86Y2FuY2VsXFx3KnxhYm9ydFxcdyp8a2lsbHxzY3JhcHxzY3JhdGNofGRyb3B8Zm9yZ2V0fHVuZG98dGVybWluYXRlfG5ldmVyID9taW5kfGNhbGwgKD86aXR8dGhhdHx0aGlzKSBvZmZ8KD86ZG9udHxkbyBub3QpICg/OmJvdGhlcnxuZWVkfHdhbnR8ZG8pfG5vIG5lZWR8bm8gbG9uZ2VyfG5vdCBhbnltb3JlfGxlYXZlIGl0fHNraXAgKD86aXR8dGhhdCkpXFxiLztcbmNvbnN0IFNUT1BTID0gL1xcYig/OnN0b3BcXHcqfGhhbHR8cXVpdHxlbmQpXFxiLztcblxuLyoqXG4gKiBXaGV0aGVyIFt1dHRlcmFuY2VdIGFza3MgZm9yIGEgdGFzayB0byBiZSBjYW5jZWxsZWQsIGZvciBhIGNhbmNlbF90YXNrIHRoZSBtb2RlbCBjYWxsZWQgb24gaXQuIFwiU3RvcFwiIGFsb25lIGFuZCB0aGVcbiAqIG90aGVyIHN0b3AgYW5kIGhhbmctdXAgcGhyYXNlcyBkb24ndDogdGhleSBtZWFuIHN0b3AgdGFsa2luZy4gT3RoZXJ3aXNlIGl0IGRvZXMgd2hlbiBpdCBzYXlzIHNvIGluIHdvcmRzLCB3aGVuIGl0XG4gKiBuYW1lcyB0aGUgdGFzayAoW25hbWVkXSksIG9yIHdoZW4gaXQgc2F5cyB0byBzdG9wIHNvbWV0aGluZyBtb3JlIHRoYW4gdGhlIHRhbGtpbmcgKFwic3RvcCB3b3JraW5nIG9uIHRoYXRcIikuXG4gKiBXb3JkcyB0aGF0IHNheSBub25lIG9mIHRoaXMgKGEgbWlzaGVhcmluZyBzdWNoIGFzIFwiU3RhYml0XCIpIGRvbid0LiBXaXRoIG5vdGhpbmcgaGVhcmQgdGhlcmUgaXMgbm90aGluZyB0byBqdWRnZSBieS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFza3NUb0NhbmNlbCh1dHRlcmFuY2U6IHN0cmluZywgY29tbWFuZHM6IFZvaWNlQ29tbWFuZHMsIG5hbWVzOiBzdHJpbmdbXSwgbmFtZWQ6IGJvb2xlYW4pOiBib29sZWFuIHtcbiAgY29uc3Qgc2FpZCA9IHdvcmRzKHV0dGVyYW5jZSkuam9pbihcIiBcIik7XG4gIGlmIChzYWlkLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHRydWU7XG4gIGNvbnN0IGNvbW1hbmQgPSBjb21tYW5kSW4odXR0ZXJhbmNlLCBjb21tYW5kcywgbmFtZXMpO1xuICBpZiAoY29tbWFuZCA9PT0gXCJzdG9wXCIgfHwgY29tbWFuZCA9PT0gXCJoYW5nVXBcIikgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gY29tbWFuZCA9PT0gXCJjYW5jZWxBbGxcIiB8fCBuYW1lZCB8fCBDQU5DRUxTLnRlc3Qoc2FpZCkgfHwgU1RPUFMudGVzdChzYWlkKTtcbn1cbiIsICIvLyBUaGUgYnJvd3NlcidzIG1pY3JvcGhvbmUgYW5kIHNwZWFrZXIgZm9yIGEgY2FsbDogMTYga0h6IFBDTTE2IGZyYW1lcyBvdXQgb2YgdGhlIG1pY3JvcGhvbmUsXG4vLyAyNCBrSHogUENNMTYgaW50byB0aGUgc3BlYWtlciwgYW5kIHRvbmVzIGxhaWQgb3ZlciB3aGF0ZXZlciBwbGF5cy4gQm90aCBydW4gaW4gQXVkaW9Xb3JrbGV0cyBvblxuLy8gb25lIEF1ZGlvQ29udGV4dCBhdCB0aGUgZGV2aWNlJ3MgcmF0ZSwgcmVzYW1wbGluZyB0aGVyZS5cblxuY29uc3QgV09SS0xFVFMgPSBgXG5jbGFzcyBDYXB0dXJlIGV4dGVuZHMgQXVkaW9Xb3JrbGV0UHJvY2Vzc29yIHtcbiAgY29uc3RydWN0b3IoKSB7XG4gICAgc3VwZXIoKTtcbiAgICB0aGlzLnN0ZXAgPSBzYW1wbGVSYXRlIC8gMTYwMDA7XG4gICAgdGhpcy5wb3MgPSAwO1xuICAgIHRoaXMuZnJhbWUgPSBuZXcgSW50MTZBcnJheSgzMjApO1xuICAgIHRoaXMubiA9IDA7XG4gICAgLy8gQSB3aW5kb3dlZC1zaW5jIGxvdy1wYXNzIGF0IDcga0h6LCBzbyBub3RoaW5nIGFib3ZlIDE2IGtIeidzIDgga0h6IGxpbWl0IGZvbGRzIGJhY2sgaW50byBzcGVlY2guXG4gICAgY29uc3QgdGFwcyA9IDQ3LCBjdXQgPSA3MDAwIC8gc2FtcGxlUmF0ZTtcbiAgICB0aGlzLnRhcHMgPSBuZXcgRmxvYXQzMkFycmF5KHRhcHMpO1xuICAgIGxldCBzdW0gPSAwO1xuICAgIGZvciAobGV0IGsgPSAwOyBrIDwgdGFwczsgaysrKSB7XG4gICAgICBjb25zdCBtID0gayAtICh0YXBzIC0gMSkgLyAyO1xuICAgICAgY29uc3Qgc2luYyA9IG0gPT09IDAgPyAyICogY3V0IDogTWF0aC5zaW4oMiAqIE1hdGguUEkgKiBjdXQgKiBtKSAvIChNYXRoLlBJICogbSk7XG4gICAgICBjb25zdCB3ID0gMC40MiAtIDAuNSAqIE1hdGguY29zKCgyICogTWF0aC5QSSAqIGspIC8gKHRhcHMgLSAxKSkgKyAwLjA4ICogTWF0aC5jb3MoKDQgKiBNYXRoLlBJICogaykgLyAodGFwcyAtIDEpKTtcbiAgICAgIHRoaXMudGFwc1trXSA9IHNpbmMgKiB3O1xuICAgICAgc3VtICs9IHRoaXMudGFwc1trXTtcbiAgICB9XG4gICAgZm9yIChsZXQgayA9IDA7IGsgPCB0YXBzOyBrKyspIHRoaXMudGFwc1trXSAvPSBzdW07XG4gICAgdGhpcy5oaXN0b3J5ID0gbmV3IEZsb2F0MzJBcnJheSh0YXBzKTtcbiAgICB0aGlzLmF0ID0gMDtcbiAgfVxuICBwcm9jZXNzKGlucHV0cykge1xuICAgIGNvbnN0IGlucHV0ID0gaW5wdXRzWzBdICYmIGlucHV0c1swXVswXTtcbiAgICBpZiAoIWlucHV0KSByZXR1cm4gdHJ1ZTtcbiAgICBjb25zdCB0YXBzID0gdGhpcy50YXBzLCBoID0gdGhpcy5oaXN0b3J5LCBuID0gdGFwcy5sZW5ndGg7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBpbnB1dC5sZW5ndGg7IGkrKykge1xuICAgICAgaFt0aGlzLmF0XSA9IGlucHV0W2ldO1xuICAgICAgdGhpcy5hdCA9ICh0aGlzLmF0ICsgMSkgJSBuO1xuICAgICAgLy8gT25seSB0aGUgc2FtcGxlcyBrZXB0IG5lZWQgZmlsdGVyaW5nOiBhdCBtb3N0IG9uZSBpbiBldmVyeSBzdGVwLlxuICAgICAgaWYgKHRoaXMucG9zID4gMSkgeyB0aGlzLnBvcyAtPSAxOyBjb250aW51ZTsgfVxuICAgICAgbGV0IHggPSAwO1xuICAgICAgZm9yIChsZXQgayA9IDAsIGogPSB0aGlzLmF0OyBrIDwgbjsgaysrLCBqID0gaiArIDEgPT09IG4gPyAwIDogaiArIDEpIHggKz0gdGFwc1trXSAqIGhbal07XG4gICAgICB3aGlsZSAodGhpcy5wb3MgPD0gMSkge1xuICAgICAgICBjb25zdCBzID0gTWF0aC5tYXgoLTEsIE1hdGgubWluKDEsIHgpKTtcbiAgICAgICAgdGhpcy5mcmFtZVt0aGlzLm4rK10gPSBzIDwgMCA/IHMgKiAzMjc2OCA6IHMgKiAzMjc2NztcbiAgICAgICAgaWYgKHRoaXMubiA9PT0gdGhpcy5mcmFtZS5sZW5ndGgpIHtcbiAgICAgICAgICB0aGlzLnBvcnQucG9zdE1lc3NhZ2UodGhpcy5mcmFtZS5idWZmZXIsIFt0aGlzLmZyYW1lLmJ1ZmZlcl0pO1xuICAgICAgICAgIHRoaXMuZnJhbWUgPSBuZXcgSW50MTZBcnJheSgzMjApO1xuICAgICAgICAgIHRoaXMubiA9IDA7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5wb3MgKz0gdGhpcy5zdGVwO1xuICAgICAgfVxuICAgICAgdGhpcy5wb3MgLT0gMTtcbiAgICB9XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbn1cblxuY2xhc3MgUGxheWJhY2sgZXh0ZW5kcyBBdWRpb1dvcmtsZXRQcm9jZXNzb3Ige1xuICBjb25zdHJ1Y3RvcigpIHtcbiAgICBzdXBlcigpO1xuICAgIHRoaXMucXVldWUgPSBbXTsgICAgICAvLyBGbG9hdDMyQXJyYXlzIGF0IHRoZSBjb250ZXh0J3MgcmF0ZVxuICAgIHRoaXMub2Zmc2V0ID0gMDtcbiAgICB0aGlzLmN1ZXMgPSBbXTtcbiAgICB0aGlzLmN1ZU9mZnNldCA9IDA7XG4gICAgdGhpcy5yZXBvcnRlZCA9IDA7XG4gICAgdGhpcy5wb3J0Lm9ubWVzc2FnZSA9IChlKSA9PiB7XG4gICAgICBjb25zdCBtID0gZS5kYXRhO1xuICAgICAgaWYgKG0udHlwZSA9PT0gXCJwbGF5XCIpIHRoaXMucXVldWUucHVzaChtLnNhbXBsZXMpO1xuICAgICAgZWxzZSBpZiAobS50eXBlID09PSBcImN1ZVwiKSB0aGlzLmN1ZXMucHVzaChtLnNhbXBsZXMpO1xuICAgICAgZWxzZSBpZiAobS50eXBlID09PSBcImZsdXNoXCIpIHsgdGhpcy5xdWV1ZSA9IFtdOyB0aGlzLm9mZnNldCA9IDA7IH1cbiAgICAgIGVsc2UgaWYgKG0udHlwZSA9PT0gXCJzdG9wXCIpIHsgdGhpcy5xdWV1ZSA9IFtdOyB0aGlzLm9mZnNldCA9IDA7IHRoaXMuY3VlcyA9IFtdOyB0aGlzLmN1ZU9mZnNldCA9IDA7IH1cbiAgICB9O1xuICB9XG4gIHByb2Nlc3MoXywgb3V0cHV0cykge1xuICAgIGNvbnN0IG91dCA9IG91dHB1dHNbMF1bMF07XG4gICAgb3V0LmZpbGwoMCk7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoICYmIHRoaXMucXVldWUubGVuZ3RoOyBpKyspIHtcbiAgICAgIG91dFtpXSA9IHRoaXMucXVldWVbMF1bdGhpcy5vZmZzZXQrK107XG4gICAgICBpZiAodGhpcy5vZmZzZXQgPj0gdGhpcy5xdWV1ZVswXS5sZW5ndGgpIHsgdGhpcy5xdWV1ZS5zaGlmdCgpOyB0aGlzLm9mZnNldCA9IDA7IH1cbiAgICB9XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoICYmIHRoaXMuY3Vlcy5sZW5ndGg7IGkrKykge1xuICAgICAgb3V0W2ldID0gTWF0aC5tYXgoLTEsIE1hdGgubWluKDEsIG91dFtpXSArIHRoaXMuY3Vlc1swXVt0aGlzLmN1ZU9mZnNldCsrXSkpO1xuICAgICAgaWYgKHRoaXMuY3VlT2Zmc2V0ID49IHRoaXMuY3Vlc1swXS5sZW5ndGgpIHsgdGhpcy5jdWVzLnNoaWZ0KCk7IHRoaXMuY3VlT2Zmc2V0ID0gMDsgfVxuICAgIH1cbiAgICBmb3IgKGxldCBjID0gMTsgYyA8IG91dHB1dHNbMF0ubGVuZ3RoOyBjKyspIG91dHB1dHNbMF1bY10uc2V0KG91dCk7XG4gICAgaWYgKGN1cnJlbnRUaW1lIC0gdGhpcy5yZXBvcnRlZCA+IDAuMSkge1xuICAgICAgdGhpcy5yZXBvcnRlZCA9IGN1cnJlbnRUaW1lO1xuICAgICAgbGV0IHF1ZXVlZCA9IC10aGlzLm9mZnNldDtcbiAgICAgIGZvciAoY29uc3QgcSBvZiB0aGlzLnF1ZXVlKSBxdWV1ZWQgKz0gcS5sZW5ndGg7XG4gICAgICB0aGlzLnBvcnQucG9zdE1lc3NhZ2UoeyBxdWV1ZWQ6IHF1ZXVlZCAvIHNhbXBsZVJhdGUgfSk7XG4gICAgfVxuICAgIHJldHVybiB0cnVlO1xuICB9XG59XG5yZWdpc3RlclByb2Nlc3NvcihcImNhcHR1cmVcIiwgQ2FwdHVyZSk7XG5yZWdpc3RlclByb2Nlc3NvcihcInBsYXliYWNrXCIsIFBsYXliYWNrKTtcbmA7XG5cbmZ1bmN0aW9uIGJhc2U2NFRvQnl0ZXMoYjY0OiBzdHJpbmcpOiBVaW50OEFycmF5IHtcbiAgY29uc3QgYmluID0gYXRvYihiNjQpO1xuICBjb25zdCBvdXQgPSBuZXcgVWludDhBcnJheShiaW4ubGVuZ3RoKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBiaW4ubGVuZ3RoOyBpKyspIG91dFtpXSA9IGJpbi5jaGFyQ29kZUF0KGkpO1xuICByZXR1cm4gb3V0O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYnl0ZXNUb0Jhc2U2NChieXRlczogVWludDhBcnJheSk6IHN0cmluZyB7XG4gIGxldCBiaW4gPSBcIlwiO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGJ5dGVzLmxlbmd0aDsgaSArPSAweDgwMDApIGJpbiArPSBTdHJpbmcuZnJvbUNoYXJDb2RlKC4uLmJ5dGVzLnN1YmFycmF5KGksIGkgKyAweDgwMDApKTtcbiAgcmV0dXJuIGJ0b2EoYmluKTtcbn1cblxuLyoqIFBDTTE2IGxpdHRsZS1lbmRpYW4gYXQgW3JhdGVdLCBhcyBmbG9hdHMgYXQgdGhlIGNvbnRleHQncyByYXRlLiAqL1xuZnVuY3Rpb24gdG9GbG9hdHMocGNtOiBVaW50OEFycmF5LCByYXRlOiBudW1iZXIsIHRhcmdldDogbnVtYmVyKTogRmxvYXQzMkFycmF5IHtcbiAgY29uc3QgdmlldyA9IG5ldyBEYXRhVmlldyhwY20uYnVmZmVyLCBwY20uYnl0ZU9mZnNldCwgcGNtLmJ5dGVMZW5ndGgpO1xuICBjb25zdCBuID0gTWF0aC5mbG9vcihwY20uYnl0ZUxlbmd0aCAvIDIpO1xuICBjb25zdCBvdXQgPSBuZXcgRmxvYXQzMkFycmF5KE1hdGguZmxvb3IoKG4gKiB0YXJnZXQpIC8gcmF0ZSkpO1xuICBjb25zdCBzdGVwID0gcmF0ZSAvIHRhcmdldDtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCB4ID0gaSAqIHN0ZXA7XG4gICAgY29uc3QgaiA9IE1hdGguZmxvb3IoeCk7XG4gICAgY29uc3QgYSA9IHZpZXcuZ2V0SW50MTYoMiAqIE1hdGgubWluKGosIG4gLSAxKSwgdHJ1ZSk7XG4gICAgY29uc3QgYiA9IHZpZXcuZ2V0SW50MTYoMiAqIE1hdGgubWluKGogKyAxLCBuIC0gMSksIHRydWUpO1xuICAgIG91dFtpXSA9IChhICsgKGIgLSBhKSAqICh4IC0gaikpIC8gMzI3Njg7XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBNaWNPcHRpb25zIHsgZWNob0NhbmNlbGxhdGlvbjogYm9vbGVhbjsgbm9pc2VTdXBwcmVzc2lvbjogYm9vbGVhbjsgYXV0b0dhaW5Db250cm9sOiBib29sZWFuIH1cblxuZXhwb3J0IGNsYXNzIENhbGxBdWRpbyB7XG4gIHByaXZhdGUgY29udGV4dDogQXVkaW9Db250ZXh0IHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgcGxheWJhY2s6IEF1ZGlvV29ya2xldE5vZGUgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBjYXB0dXJlOiBBdWRpb1dvcmtsZXROb2RlIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgc3RyZWFtOiBNZWRpYVN0cmVhbSB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIHNvdXJjZTogTWVkaWFTdHJlYW1BdWRpb1NvdXJjZU5vZGUgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBtaWNPcHRzOiBNaWNPcHRpb25zIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgb25NaWNGcmFtZTogKChzYW1wbGVzOiBJbnQxNkFycmF5LCBsZXZlbDogbnVtYmVyKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuICAvKiogSW5jcmVtZW50ZWQgb24gZXZlcnkgc3RhcnRNaWMvc3RvcE1pYyBzbyBzdXBlcnNlZGVkIG9yIGNhbmNlbGxlZCBnZXRVc2VyTWVkaWEgY2FsbHMgbmV2ZXIgbGVhayB0cmFja3MuICovXG4gIHByaXZhdGUgbWljR2VuID0gMDtcbiAgcHJpdmF0ZSBvcGVuaW5nOiBQcm9taXNlPHZvaWQ+IHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgc3RhdGVMaXN0ZW5lcjogKCgpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XG4gIC8qKiBTZWNvbmRzIG9mIHNwZWVjaCBxdWV1ZWQsIGFzIHRoZSB3b3JrbGV0IGxhc3Qgc2FpZC4gKi9cbiAgcXVldWVkID0gMDtcbiAgLyoqIFRoZSBtaWNyb3Bob25lJ3MgbGV2ZWwsIFJNUyBvZiB0aGUgbGFzdCBmcmFtZSAoMCB0byAxKS4gKi9cbiAgbGV2ZWwgPSAwO1xuXG4gIG9uQXVkaW9TdGF0ZUNoYW5nZShsaXN0ZW5lcjogKCgpID0+IHZvaWQpIHwgbnVsbCk6IHZvaWQge1xuICAgIHRoaXMuc3RhdGVMaXN0ZW5lciA9IGxpc3RlbmVyO1xuICB9XG5cbiAgLyoqIFRydWUgd2hlbiBhbiBBdWRpb0NvbnRleHQgZXhpc3RzIGJ1dCB0aGUgYnJvd3NlciBzdXNwZW5kZWQgaXQgcGVuZGluZyBhIHVzZXIgZ2VzdHVyZS4gKi9cbiAgZ2V0IGF1ZGlvU3VzcGVuZGVkKCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLmNvbnRleHQgIT0gbnVsbCAmJiB0aGlzLmNvbnRleHQuc3RhdGUgIT09IFwicnVubmluZ1wiO1xuICB9XG5cbiAgYXN5bmMgcmVzdW1lQXVkaW8oKTogUHJvbWlzZTxib29sZWFuPiB7XG4gICAgY29uc3QgY3R4ID0gdGhpcy5jb250ZXh0O1xuICAgIGlmICghY3R4KSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKGN0eC5zdGF0ZSA9PT0gXCJydW5uaW5nXCIpIHJldHVybiB0cnVlO1xuICAgIHRyeSB7IGF3YWl0IGN0eC5yZXN1bWUoKTsgfSBjYXRjaCB7fVxuICAgIHJldHVybiAoY3R4LnN0YXRlIGFzIEF1ZGlvQ29udGV4dFN0YXRlKSA9PT0gXCJydW5uaW5nXCI7XG4gIH1cblxuICBhc3luYyBvcGVuKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICh0aGlzLm9wZW5pbmcpIHtcbiAgICAgIGF3YWl0IHRoaXMub3BlbmluZztcbiAgICAgIGlmICh0aGlzLmNvbnRleHQ/LnN0YXRlID09PSBcInN1c3BlbmRlZFwiKSBhd2FpdCB0aGlzLmNvbnRleHQucmVzdW1lKCkuY2F0Y2goKCkgPT4ge30pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAodGhpcy5jb250ZXh0KSB7IGlmICh0aGlzLmNvbnRleHQuc3RhdGUgPT09IFwic3VzcGVuZGVkXCIpIGF3YWl0IHRoaXMuY29udGV4dC5yZXN1bWUoKS5jYXRjaCgoKSA9PiB7fSk7IHJldHVybjsgfVxuICAgIGNvbnN0IGluaXQgPSAoYXN5bmMgKCkgPT4ge1xuICAgICAgbGV0IGN0eDogQXVkaW9Db250ZXh0IHwgbnVsbCA9IG51bGw7XG4gICAgICB0cnkge1xuICAgICAgICBjdHggPSBuZXcgQXVkaW9Db250ZXh0KHsgbGF0ZW5jeUhpbnQ6IFwiaW50ZXJhY3RpdmVcIiB9KTtcbiAgICAgICAgY3R4Lm9uc3RhdGVjaGFuZ2UgPSAoKSA9PiB0aGlzLnN0YXRlTGlzdGVuZXI/LigpO1xuICAgICAgICBjb25zdCB1cmwgPSBVUkwuY3JlYXRlT2JqZWN0VVJMKG5ldyBCbG9iKFtXT1JLTEVUU10sIHsgdHlwZTogXCJ0ZXh0L2phdmFzY3JpcHRcIiB9KSk7XG4gICAgICAgIGF3YWl0IGN0eC5hdWRpb1dvcmtsZXQuYWRkTW9kdWxlKHVybCk7XG4gICAgICAgIGNvbnN0IHBsYXliYWNrID0gbmV3IEF1ZGlvV29ya2xldE5vZGUoY3R4LCBcInBsYXliYWNrXCIsIHsgbnVtYmVyT2ZJbnB1dHM6IDAsIG91dHB1dENoYW5uZWxDb3VudDogWzJdIH0pO1xuICAgICAgICBwbGF5YmFjay5wb3J0Lm9ubWVzc2FnZSA9IChlKSA9PiB7IHRoaXMucXVldWVkID0gZS5kYXRhLnF1ZXVlZDsgfTtcbiAgICAgICAgcGxheWJhY2suY29ubmVjdChjdHguZGVzdGluYXRpb24pO1xuICAgICAgICB0aGlzLmNvbnRleHQgPSBjdHg7XG4gICAgICAgIHRoaXMucGxheWJhY2sgPSBwbGF5YmFjaztcbiAgICAgICAgdGhpcy5zdGF0ZUxpc3RlbmVyPy4oKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICB0cnkgeyBhd2FpdCBjdHg/LmNsb3NlPy4oKTsgfSBjYXRjaCB7fVxuICAgICAgICB0aHJvdyBlcnI7XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICB0aGlzLm9wZW5pbmcgPSBudWxsO1xuICAgICAgfVxuICAgIH0pKCk7XG4gICAgdGhpcy5vcGVuaW5nID0gaW5pdDtcbiAgICBhd2FpdCBpbml0O1xuICB9XG5cbiAgLyoqIFNlY29uZHMgZnJvbSBhIHNhbXBsZSBsZWF2aW5nIHRoZSB3b3JrbGV0IHRvIHRoZSBzcGVha2VyLCBhcyB0aGUgYnJvd3NlciByZWNrb25zIGl0LiAqL1xuICBnZXQgb3V0cHV0TGF0ZW5jeSgpOiBudW1iZXIgfCBudWxsIHtcbiAgICBpZiAoIXRoaXMuY29udGV4dCkgcmV0dXJuIG51bGw7XG4gICAgcmV0dXJuIHRoaXMuY29udGV4dC5iYXNlTGF0ZW5jeSArICgodGhpcy5jb250ZXh0IGFzIEF1ZGlvQ29udGV4dCAmIHsgb3V0cHV0TGF0ZW5jeT86IG51bWJlciB9KS5vdXRwdXRMYXRlbmN5ID8/IDApO1xuICB9XG5cbiAgZ2V0IG1pY0FjdGl2ZSgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5jYXB0dXJlICE9IG51bGwgJiYgdGhpcy5zdHJlYW0gIT0gbnVsbCAmJiB0aGlzLnN0cmVhbS5nZXRUcmFja3MoKS5zb21lKCh0KSA9PiB0LnJlYWR5U3RhdGUgPT09IFwibGl2ZVwiKTtcbiAgfVxuXG4gIC8qKiBTdGFydHMgdGhlIG1pY3JvcGhvbmUgaWYgaXQgaXNuJ3QgYWxyZWFkeSBydW5uaW5nIHdpdGggdGhlIHNhbWUgb3B0aW9uczsgb3RoZXJ3aXNlIHN3YXBzIHRoZSBmcmFtZSBjYWxsYmFjayBjbGVhbmx5LiAqL1xuICBhc3luYyBlbnN1cmVNaWMob25GcmFtZTogKHNhbXBsZXM6IEludDE2QXJyYXksIGxldmVsOiBudW1iZXIpID0+IHZvaWQsIG9wdGlvbnM6IE1pY09wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAoXG4gICAgICB0aGlzLm1pY0FjdGl2ZSAmJlxuICAgICAgdGhpcy5taWNPcHRzICYmXG4gICAgICB0aGlzLm1pY09wdHMuZWNob0NhbmNlbGxhdGlvbiA9PT0gb3B0aW9ucy5lY2hvQ2FuY2VsbGF0aW9uICYmXG4gICAgICB0aGlzLm1pY09wdHMubm9pc2VTdXBwcmVzc2lvbiA9PT0gb3B0aW9ucy5ub2lzZVN1cHByZXNzaW9uICYmXG4gICAgICB0aGlzLm1pY09wdHMuYXV0b0dhaW5Db250cm9sID09PSBvcHRpb25zLmF1dG9HYWluQ29udHJvbFxuICAgICkge1xuICAgICAgYXdhaXQgdGhpcy5vcGVuKCk7XG4gICAgICB0aGlzLm9uTWljRnJhbWUgPSBvbkZyYW1lO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBhd2FpdCB0aGlzLnN0YXJ0TWljKG9uRnJhbWUsIG9wdGlvbnMpO1xuICB9XG5cbiAgYXN5bmMgc3RhcnRNaWMob25GcmFtZTogKHNhbXBsZXM6IEludDE2QXJyYXksIGxldmVsOiBudW1iZXIpID0+IHZvaWQsIG9wdGlvbnM6IE1pY09wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICB0aGlzLnN0b3BNaWMoKTtcbiAgICBjb25zdCBnZW4gPSArK3RoaXMubWljR2VuO1xuICAgIGF3YWl0IHRoaXMub3BlbigpO1xuICAgIGlmIChnZW4gIT09IHRoaXMubWljR2VuKSByZXR1cm47XG4gICAgY29uc3QgY29udGV4dCA9IHRoaXMuY29udGV4dCE7XG4gICAgY29uc3Qgc3RyZWFtID0gYXdhaXQgbmF2aWdhdG9yLm1lZGlhRGV2aWNlcy5nZXRVc2VyTWVkaWEoeyBhdWRpbzogeyBjaGFubmVsQ291bnQ6IDEsIC4uLm9wdGlvbnMgfSB9KTtcbiAgICBpZiAoZ2VuICE9PSB0aGlzLm1pY0dlbikge1xuICAgICAgc3RyZWFtLmdldFRyYWNrcygpLmZvckVhY2goKHQpID0+IHQuc3RvcCgpKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgbGV0IHNvdXJjZTogTWVkaWFTdHJlYW1BdWRpb1NvdXJjZU5vZGUgfCBudWxsID0gbnVsbDtcbiAgICBsZXQgY2FwdHVyZTogQXVkaW9Xb3JrbGV0Tm9kZSB8IG51bGwgPSBudWxsO1xuICAgIHRyeSB7XG4gICAgICBzb3VyY2UgPSBjb250ZXh0LmNyZWF0ZU1lZGlhU3RyZWFtU291cmNlKHN0cmVhbSk7XG4gICAgICBjYXB0dXJlID0gbmV3IEF1ZGlvV29ya2xldE5vZGUoY29udGV4dCwgXCJjYXB0dXJlXCIsIHsgbnVtYmVyT2ZPdXRwdXRzOiAwIH0pO1xuICAgICAgY2FwdHVyZS5wb3J0Lm9ubWVzc2FnZSA9IChlKSA9PiB7XG4gICAgICAgIGNvbnN0IGZyYW1lID0gbmV3IEludDE2QXJyYXkoZS5kYXRhIGFzIEFycmF5QnVmZmVyKTtcbiAgICAgICAgbGV0IHN1bSA9IDA7XG4gICAgICAgIGZvciAoY29uc3QgcyBvZiBmcmFtZSkgc3VtICs9IHMgKiBzO1xuICAgICAgICB0aGlzLmxldmVsID0gTWF0aC5zcXJ0KHN1bSAvIGZyYW1lLmxlbmd0aCkgLyAzMjc2ODtcbiAgICAgICAgdGhpcy5vbk1pY0ZyYW1lPy4oZnJhbWUsIHRoaXMubGV2ZWwpO1xuICAgICAgfTtcbiAgICAgIHNvdXJjZS5jb25uZWN0KGNhcHR1cmUpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgc291cmNlPy5kaXNjb25uZWN0KCk7XG4gICAgICBjYXB0dXJlPy5wb3J0LmNsb3NlKCk7XG4gICAgICBzdHJlYW0uZ2V0VHJhY2tzKCkuZm9yRWFjaCgodCkgPT4gdC5zdG9wKCkpO1xuICAgICAgdGhyb3cgZXJyO1xuICAgIH1cbiAgICB0aGlzLnN0cmVhbSA9IHN0cmVhbTtcbiAgICB0aGlzLm1pY09wdHMgPSB7IC4uLm9wdGlvbnMgfTtcbiAgICB0aGlzLm9uTWljRnJhbWUgPSBvbkZyYW1lO1xuICAgIHRoaXMuc291cmNlID0gc291cmNlO1xuICAgIHRoaXMuY2FwdHVyZSA9IGNhcHR1cmU7XG4gIH1cblxuICBzdG9wTWljKCk6IHZvaWQge1xuICAgIHRoaXMubWljR2VuKys7XG4gICAgdGhpcy5zb3VyY2U/LmRpc2Nvbm5lY3QoKTtcbiAgICB0aGlzLmNhcHR1cmU/LnBvcnQuY2xvc2UoKTtcbiAgICB0aGlzLnN0cmVhbT8uZ2V0VHJhY2tzKCkuZm9yRWFjaCgodCkgPT4gdC5zdG9wKCkpO1xuICAgIHRoaXMuc291cmNlID0gbnVsbDtcbiAgICB0aGlzLmNhcHR1cmUgPSBudWxsO1xuICAgIHRoaXMuc3RyZWFtID0gbnVsbDtcbiAgICB0aGlzLm1pY09wdHMgPSBudWxsO1xuICAgIHRoaXMub25NaWNGcmFtZSA9IG51bGw7XG4gICAgdGhpcy5sZXZlbCA9IDA7XG4gIH1cblxuICBwbGF5KHBjbTY0OiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuY29udGV4dCB8fCAhdGhpcy5wbGF5YmFjaykgcmV0dXJuO1xuICAgIGNvbnN0IHNhbXBsZXMgPSB0b0Zsb2F0cyhiYXNlNjRUb0J5dGVzKHBjbTY0KSwgMjQwMDAsIHRoaXMuY29udGV4dC5zYW1wbGVSYXRlKTtcbiAgICB0aGlzLnBsYXliYWNrLnBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcInBsYXlcIiwgc2FtcGxlcyB9LCBbc2FtcGxlcy5idWZmZXJdKTtcbiAgfVxuXG4gIGN1ZShwY202NDogc3RyaW5nKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLmNvbnRleHQgfHwgIXRoaXMucGxheWJhY2spIHJldHVybjtcbiAgICBjb25zdCBzYW1wbGVzID0gdG9GbG9hdHMoYmFzZTY0VG9CeXRlcyhwY202NCksIDI0MDAwLCB0aGlzLmNvbnRleHQuc2FtcGxlUmF0ZSk7XG4gICAgdGhpcy5wbGF5YmFjay5wb3J0LnBvc3RNZXNzYWdlKHsgdHlwZTogXCJjdWVcIiwgc2FtcGxlcyB9LCBbc2FtcGxlcy5idWZmZXJdKTtcbiAgfVxuXG4gIGZsdXNoKCk6IHZvaWQge1xuICAgIHRoaXMucGxheWJhY2s/LnBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcImZsdXNoXCIgfSk7XG4gIH1cblxuICBzdG9wUGxheWJhY2soKTogdm9pZCB7XG4gICAgdGhpcy5wbGF5YmFjaz8ucG9ydC5wb3N0TWVzc2FnZSh7IHR5cGU6IFwic3RvcFwiIH0pO1xuICAgIHRoaXMucXVldWVkID0gMDtcbiAgfVxuXG4gIHN0b3AoKTogdm9pZCB7XG4gICAgdGhpcy5zdG9wTWljKCk7XG4gICAgdGhpcy5zdG9wUGxheWJhY2soKTtcbiAgfVxufVxuIiwgIi8vIFRoZSByZXBsYXkgdmlldzogYSByZWNvcmRlZCBjYWxsIChhIHRyYWNlIGZyb20gYW55IGhvc3QsIG9yIGEgc2NlbmFyaW8pIHJ1biBhZ2FpbiB0aHJvdWdoIHRoZVxuLy8gY29yZSwgYXMgdGhlIGJ1aWxkIHRoYXQgcmVjb3JkZWQgaXQgZGlkIGFuZCBhcyB0aGUgbGF0ZXN0IGRvZXMsIHNpZGUgYnkgc2lkZS4gV2hlcmUgdGhleSBwYXJ0XG4vLyBpcyB3aGVyZSBhIGNoYW5nZSBpbiBzcmMvIGNoYW5nZWQgd2hhdCB0aGUgY2FsbCBkb2VzIHdpdGggdGhlIHNhbWUgd29yZHMgYW5kIHRoZSBzYW1lIG1vZGVsLlxuXG5pbnRlcmZhY2UgQ29yZSB7XG4gIHZlcnNpb246IHN0cmluZztcbiAgY3JlYXRlKGNvbmZpZzogc3RyaW5nLCB0OiBudW1iZXIpOiBzdHJpbmc7XG4gIHB1c2goaWQ6IG51bWJlciwgZXZlbnQ6IHN0cmluZyk6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFJlY29yZGluZyB7IHZlcnNpb24/OiBzdHJpbmc7IGNvbmZpZzogdW5rbm93bjsgc3RhcnQ6IG51bWJlcjsgZXZlbnRzOiBSZWNvcmQ8c3RyaW5nLCBhbnk+W10gfVxuXG4vKiogV2hhdCBhIGNvbW1hbmQgb3IgZXZlbnQgbG9va3MgbGlrZSBpbiBhIHRpbWVsaW5lOiBhdWRpbyBjdXQgb3V0LCBvbmUgbGluZS4gKi9cbmZ1bmN0aW9uIGxpbmUobzogUmVjb3JkPHN0cmluZywgYW55Pik6IHN0cmluZyB7XG4gIGNvbnN0IHRleHQgPSBKU09OLnN0cmluZ2lmeShvKS5yZXBsYWNlKC9cIihkYXRhfHBjbSlcIjpcIltBLVphLXowLTkrLz1dezQwLH1cIi9nLCAnXCIkMVwiOlwiXHUyMDI2XCInKVxuICAgIC5yZXBsYWNlKC9cXFxcXCJkYXRhXFxcXFwiOlxcXFxcIltBLVphLXowLTkrLz1dezQwLH1cXFxcXCIvZywgJ1xcXFxcImRhdGFcXFxcXCI6XFxcXFwiXHUyMDI2XFxcXFwiJyk7XG4gIHJldHVybiB0ZXh0Lmxlbmd0aCA+IDQwMCA/IHRleHQuc2xpY2UoMCwgNDAwKSArIFwiXHUyMDI2XCIgOiB0ZXh0O1xufVxuXG4vKiogQXVkaW8gYW5kIHRpY2tzIHNheSBub3RoaW5nIGEgcmVhZGVyIG5lZWRzOyB0aGUgcmVzdCBkb2VzLiAqL1xuZnVuY3Rpb24gdGVsbGluZyhvOiBSZWNvcmQ8c3RyaW5nLCBhbnk+KTogYm9vbGVhbiB7XG4gIGlmIChvLnR5cGUgPT09IFwibWljXCIgfHwgby50eXBlID09PSBcInRpY2tcIiB8fCBvLnR5cGUgPT09IFwicGxheVwiKSByZXR1cm4gZmFsc2U7XG4gIGlmIChvLnR5cGUgPT09IFwid3Muc2VuZFwiICYmIFN0cmluZyhvLmRhdGEpLnN0YXJ0c1dpdGgoJ3tcInJlYWx0aW1lSW5wdXRcIjp7XCJhdWRpb1wiJykpIHJldHVybiBmYWxzZTtcbiAgaWYgKG8udHlwZSA9PT0gXCJ3cy5tZXNzYWdlXCIgJiYgU3RyaW5nKG8uZGF0YSkuaW5jbHVkZXMoJ1wiaW5saW5lRGF0YVwiJykgJiYgIVN0cmluZyhvLmRhdGEpLmluY2x1ZGVzKCdcInR1cm5Db21wbGV0ZVwiJykpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmZ1bmN0aW9uIHJ1bihjb3JlOiBDb3JlLCByOiBSZWNvcmRpbmcpOiBzdHJpbmdbXVtdIHtcbiAgY29uc3QgY3JlYXRlZCA9IEpTT04ucGFyc2UoY29yZS5jcmVhdGUoSlNPTi5zdHJpbmdpZnkoci5jb25maWcpLCByLnN0YXJ0KSk7XG4gIGNvbnN0IG91dDogc3RyaW5nW11bXSA9IFtjcmVhdGVkLmNvbW1hbmRzLmZpbHRlcih0ZWxsaW5nKS5tYXAobGluZSldO1xuICBmb3IgKGNvbnN0IGUgb2Ygci5ldmVudHMpIG91dC5wdXNoKChKU09OLnBhcnNlKGNvcmUucHVzaChjcmVhdGVkLmlkLCBKU09OLnN0cmluZ2lmeShlKSkpIGFzIFJlY29yZDxzdHJpbmcsIGFueT5bXSkuZmlsdGVyKHRlbGxpbmcpLm1hcChsaW5lKSk7XG4gIHJldHVybiBvdXQ7XG59XG5cbmV4cG9ydCBjbGFzcyBSZXBsYXkge1xuICBwcml2YXRlIHJlYWRvbmx5IHJvb3Q6IEhUTUxFbGVtZW50O1xuICBwcml2YXRlIHJlYWRvbmx5IGxvYWQ6ICh1cmw/OiBzdHJpbmcpID0+IFByb21pc2U8Q29yZT47XG5cbiAgY29uc3RydWN0b3Iocm9vdDogSFRNTEVsZW1lbnQsIGxvYWQ6ICh1cmw/OiBzdHJpbmcpID0+IFByb21pc2U8Q29yZT4pIHtcbiAgICB0aGlzLnJvb3QgPSByb290O1xuICAgIHRoaXMubG9hZCA9IGxvYWQ7XG4gICAgcm9vdC5pbm5lckhUTUwgPSBgXG4gICAgICA8aDI+VHJhY2UgcmVwbGF5PC9oMj5cbiAgICAgIDxkaXYgY2xhc3M9XCJiYXJcIj48c2VsZWN0IGNsYXNzPVwicGlja1wiIGFyaWEtbGFiZWw9XCJSZWNvcmRpbmdcIj48L3NlbGVjdD48YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cInJlZnJlc2hcIiB0aXRsZT1cIlJlZnJlc2ggbGlzdFwiIGFyaWEtbGFiZWw9XCJSZWZyZXNoIGxpc3RcIj5cdTIxQkI8L2J1dHRvbj48YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cImdvXCI+UmVwbGF5PC9idXR0b24+XG4gICAgICA8bGFiZWwgY2xhc3M9XCJ0b2dnbGUtYWxsXCI+PGlucHV0IHR5cGU9XCJjaGVja2JveFwiIGNsYXNzPVwiYWxsXCI+IFNob3cgYXVkaW8gYW5kIHRpY2tzPC9sYWJlbD48c3BhbiBjbGFzcz1cInN1bW1hcnlcIj48L3NwYW4+PC9kaXY+XG4gICAgICA8ZGl2IGNsYXNzPVwidGltZWxpbmVcIj48L2Rpdj5gO1xuICAgIChyb290LnF1ZXJ5U2VsZWN0b3IoXCIucmVmcmVzaFwiKSBhcyBIVE1MRWxlbWVudCkub25jbGljayA9ICgpID0+IHZvaWQgdGhpcy5saXN0KCk7XG4gICAgKHJvb3QucXVlcnlTZWxlY3RvcihcIi5nb1wiKSBhcyBIVE1MRWxlbWVudCkub25jbGljayA9ICgpID0+IHZvaWQgdGhpcy5yZXBsYXkoKS5jYXRjaCgoZXJyKSA9PiB0aGlzLnNheShgUmVwbGF5IGZhaWxlZDogJHtlcnIubWVzc2FnZX1gKSk7XG4gICAgdm9pZCB0aGlzLmxpc3QoKTtcbiAgfVxuXG4gIHByaXZhdGUgc2F5KHRleHQ6IHN0cmluZykge1xuICAgICh0aGlzLnJvb3QucXVlcnlTZWxlY3RvcihcIi5zdW1tYXJ5XCIpIGFzIEhUTUxFbGVtZW50KS50ZXh0Q29udGVudCA9IHRleHQ7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGxpc3QoKSB7XG4gICAgY29uc3QgcGljayA9IHRoaXMucm9vdC5xdWVyeVNlbGVjdG9yKFwiLnBpY2tcIikgYXMgSFRNTFNlbGVjdEVsZW1lbnQ7XG4gICAgcGljay5pbm5lckhUTUwgPSBcIlwiO1xuICAgIGNvbnN0IHRyYWNlczogeyBuYW1lOiBzdHJpbmc7IGJ5dGVzOiBudW1iZXIgfVtdID0gYXdhaXQgKGF3YWl0IGZldGNoKFwiL3RyYWNlc1wiKSkuanNvbigpO1xuICAgIGNvbnN0IHNjZW5hcmlvczogc3RyaW5nW10gPSBhd2FpdCAoYXdhaXQgZmV0Y2goXCIvc2NlbmFyaW9zXCIpKS5qc29uKCk7XG4gICAgY29uc3QgdHJhY2VHcm91cCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJvcHRncm91cFwiKTtcbiAgICB0cmFjZUdyb3VwLmxhYmVsID0gXCJSZWNvcmRlZCBjYWxsc1wiO1xuICAgIGZvciAoY29uc3QgdCBvZiB0cmFjZXMpIHRyYWNlR3JvdXAuYXBwZW5kKG5ldyBPcHRpb24oYCR7dC5uYW1lfSAoJHtNYXRoLnJvdW5kKHQuYnl0ZXMgLyAxMDI0KX0gS0IpYCwgYC90cmFjZXMvJHt0Lm5hbWV9YCkpO1xuICAgIGNvbnN0IHNjZW5hcmlvR3JvdXAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwib3B0Z3JvdXBcIik7XG4gICAgc2NlbmFyaW9Hcm91cC5sYWJlbCA9IFwiU2NlbmFyaW9zXCI7XG4gICAgZm9yIChjb25zdCBzIG9mIHNjZW5hcmlvcykgc2NlbmFyaW9Hcm91cC5hcHBlbmQobmV3IE9wdGlvbihzLCBgL3NjZW5hcmlvcy8ke3N9Lmpzb25gKSk7XG4gICAgcGljay5hcHBlbmQodHJhY2VHcm91cCwgc2NlbmFyaW9Hcm91cCk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHJlY29yZGluZyh1cmw6IHN0cmluZyk6IFByb21pc2U8UmVjb3JkaW5nPiB7XG4gICAgY29uc3QgdGV4dCA9IGF3YWl0IChhd2FpdCBmZXRjaCh1cmwsIHsgY2FjaGU6IFwibm8tc3RvcmVcIiB9KSkudGV4dCgpO1xuICAgIGlmICh1cmwuZW5kc1dpdGgoXCIuanNvblwiKSkgcmV0dXJuIEpTT04ucGFyc2UodGV4dCk7XG4gICAgY29uc3QgW2hlYWRlciwgLi4uZXZlbnRzXSA9IHRleHQudHJpbSgpLnNwbGl0KFwiXFxuXCIpLm1hcCgobCkgPT4gSlNPTi5wYXJzZShsKSk7XG4gICAgcmV0dXJuIHsgLi4uaGVhZGVyLCBldmVudHMgfTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgcmVwbGF5KCkge1xuICAgIGNvbnN0IHVybCA9ICh0aGlzLnJvb3QucXVlcnlTZWxlY3RvcihcIi5waWNrXCIpIGFzIEhUTUxTZWxlY3RFbGVtZW50KS52YWx1ZTtcbiAgICBpZiAoIXVybCkgcmV0dXJuO1xuICAgIGNvbnN0IHIgPSBhd2FpdCB0aGlzLnJlY29yZGluZyh1cmwpO1xuICAgIGNvbnN0IGxhdGVzdCA9IGF3YWl0IHRoaXMubG9hZCgpO1xuICAgIGxldCByZWNvcmRlZDogQ29yZSB8IG51bGwgPSBudWxsO1xuICAgIGlmIChyLnZlcnNpb24gJiYgci52ZXJzaW9uICE9PSBsYXRlc3QudmVyc2lvbikge1xuICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChgL3ZlcnNpb25zLyR7ci52ZXJzaW9ufS5qc2AsIHsgbWV0aG9kOiBcIkhFQURcIiB9KTtcbiAgICAgIGlmIChyZXNwb25zZS5vaykgcmVjb3JkZWQgPSBhd2FpdCB0aGlzLmxvYWQoYC92ZXJzaW9ucy8ke3IudmVyc2lvbn0uanNgKTtcbiAgICB9XG4gICAgY29uc3Qgbm93ID0gcnVuKGxhdGVzdCwgcik7XG4gICAgY29uc3QgdGhlbiA9IHJlY29yZGVkID8gcnVuKHJlY29yZGVkLCByKSA6IG51bGw7XG4gICAgY29uc3QgYWxsID0gKHRoaXMucm9vdC5xdWVyeVNlbGVjdG9yKFwiLmFsbFwiKSBhcyBIVE1MSW5wdXRFbGVtZW50KS5jaGVja2VkO1xuICAgIGNvbnN0IHRpbWVsaW5lID0gdGhpcy5yb290LnF1ZXJ5U2VsZWN0b3IoXCIudGltZWxpbmVcIikgYXMgSFRNTEVsZW1lbnQ7XG4gICAgdGltZWxpbmUuaW5uZXJIVE1MID0gXCJcIjtcbiAgICBsZXQgZmlyc3QgPSAtMTtcbiAgICBsZXQgZGlmZmVyID0gMDtcbiAgICBjb25zdCByb3dzOiBIVE1MRWxlbWVudFtdID0gW107XG4gICAgY29uc3QgYWRkID0gKGNsczogc3RyaW5nLCB0OiBzdHJpbmcsIHRleHQ6IHN0cmluZykgPT4ge1xuICAgICAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgIHJvdy5jbGFzc05hbWUgPSBgcm93ICR7Y2xzfWA7XG4gICAgICByb3cuaW5uZXJIVE1MID0gYDxzcGFuIGNsYXNzPVwidFwiPiR7dH08L3NwYW4+YDtcbiAgICAgIGNvbnN0IGIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgICAgIGIuY2xhc3NOYW1lID0gXCJiXCI7XG4gICAgICBiLnRleHRDb250ZW50ID0gdGV4dDtcbiAgICAgIHJvdy5hcHBlbmQoYik7XG4gICAgICB0aW1lbGluZS5hcHBlbmQocm93KTtcbiAgICAgIHJvd3MucHVzaChyb3cpO1xuICAgICAgcmV0dXJuIHJvdztcbiAgICB9O1xuICAgIGNvbnN0IHQwID0gci5zdGFydDtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8PSByLmV2ZW50cy5sZW5ndGg7IGkrKykge1xuICAgICAgY29uc3QgZSA9IGkgPT09IDAgPyBudWxsIDogci5ldmVudHNbaSAtIDFdO1xuICAgICAgY29uc3Qgbm93T3V0ID0gbm93W2ldO1xuICAgICAgY29uc3QgdGhlbk91dCA9IHRoZW4gPyB0aGVuW2ldIDogbm93T3V0O1xuICAgICAgY29uc3Qgc2FtZSA9IG5vd091dC5sZW5ndGggPT09IHRoZW5PdXQubGVuZ3RoICYmIG5vd091dC5ldmVyeSgoYywgaikgPT4gYyA9PT0gdGhlbk91dFtqXSk7XG4gICAgICBpZiAoIXNhbWUpIHsgZGlmZmVyKys7IGlmIChmaXJzdCA8IDApIGZpcnN0ID0gaTsgfVxuICAgICAgaWYgKCFzYW1lIHx8IGFsbCB8fCAoZSAmJiB0ZWxsaW5nKGUpKSB8fCBub3dPdXQubGVuZ3RoID4gMCkge1xuICAgICAgICBpZiAoZSAmJiAoYWxsIHx8IHRlbGxpbmcoZSkgfHwgIXNhbWUpKSBhZGQoXCJpblwiLCAoZS50IC0gdDApLnRvRml4ZWQoMiksIGxpbmUoZSkpO1xuICAgICAgICBjb25zdCB0ID0gZSA/IChlLnQgLSB0MCkudG9GaXhlZCgyKSA6IFwiMC4wMFwiO1xuICAgICAgICBpZiAoc2FtZSkgZm9yIChjb25zdCBjIG9mIG5vd091dCkgYWRkKFwib3V0XCIsIHQsIGMpO1xuICAgICAgICBlbHNlIHtcbiAgICAgICAgICBmb3IgKGNvbnN0IGMgb2YgdGhlbk91dCkgYWRkKFwib3V0IGdvbmVcIiwgdCwgYFx1MjIxMiAke2N9YCk7XG4gICAgICAgICAgZm9yIChjb25zdCBjIG9mIG5vd091dCkgYWRkKFwib3V0IG5ld1wiLCB0LCBgKyAke2N9YCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgY29uc3QgdmVyc2lvbnMgPSB0aGVuID8gYHJlY29yZGVkIGJ5ICR7ci52ZXJzaW9ufSwgcmVwbGF5ZWQgYnkgaXQgYW5kIGJ5ICR7bGF0ZXN0LnZlcnNpb259YCA6IGByZXBsYXllZCBieSAke2xhdGVzdC52ZXJzaW9ufWAgK1xuICAgICAgKHIudmVyc2lvbiAmJiByLnZlcnNpb24gIT09IGxhdGVzdC52ZXJzaW9uID8gYCAodGhlIHJlY29yZGluZydzIGJ1aWxkICR7ci52ZXJzaW9ufSBpc24ndCBrZXB0IGhlcmUpYCA6IFwiXCIpO1xuICAgIHRoaXMuc2F5KGAke3IuZXZlbnRzLmxlbmd0aH0gZXZlbnRzLCAke3ZlcnNpb25zfS4gYCArICh0aGVuID8gKGRpZmZlciA/IGAke2RpZmZlcn0gZXZlbnRzIGFuc3dlcmVkIGRpZmZlcmVudGx5LCB0aGUgZmlyc3QgYXQgZXZlbnQgJHtmaXJzdH0uYCA6IFwiQm90aCBhbnN3ZXJlZCBldmVyeSBldmVudCB0aGUgc2FtZS5cIikgOiBcIlwiKSk7XG4gICAgaWYgKGZpcnN0ID49IDApIHRpbWVsaW5lLnF1ZXJ5U2VsZWN0b3IoXCIuZ29uZSwgLm5ld1wiKT8uc2Nyb2xsSW50b1ZpZXcoeyBibG9jazogXCJjZW50ZXJcIiB9KTtcbiAgfVxufVxuIiwgIi8qKiBNaW5pbWFsIHNjcm9sbGluZyBwYW5lIHN1cmZhY2Ugc28gYXV0by1zY3JvbGwgbG9naWMgc3RheXMgdGVzdGFibGUgd2l0aG91dCBhIGJyb3dzZXIgRE9NLiAqL1xuZXhwb3J0IGludGVyZmFjZSBTY3JvbGxQYW5lIHtcbiAgc2Nyb2xsVG9wOiBudW1iZXI7XG4gIHJlYWRvbmx5IHNjcm9sbEhlaWdodDogbnVtYmVyO1xuICByZWFkb25seSBjbGllbnRIZWlnaHQ6IG51bWJlcjtcbiAgc2Nyb2xsVG8/KG9wdGlvbnM6IHsgdG9wOiBudW1iZXI7IGJlaGF2aW9yPzogU2Nyb2xsQmVoYXZpb3IgfSk6IHZvaWQ7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXV0b1Njcm9sbGVyT3B0aW9ucyB7XG4gIC8qKiBEaXN0YW5jZSBmcm9tIHRoZSBib3R0b20gKHB4KSB0aGF0IHN0aWxsIGNvdW50cyBhcyBwaW5uZWQuICovXG4gIHBpblRocmVzaG9sZD86IG51bWJlcjtcbiAgLyoqIERpc3RhbmNlIGZyb20gdGhlIGJvdHRvbSAocHgpIHBhc3Qgd2hpY2ggdGhlIGp1bXAtdG8tbGF0ZXN0IGNvbnRyb2wgaXMgc2hvd24uICovXG4gIGp1bXBUaHJlc2hvbGQ/OiBudW1iZXI7XG4gIC8qKiBDYWxsZWQgd2hlbmV2ZXIgdGhlIGp1bXAtdG8tbGF0ZXN0IGNvbnRyb2wncyB2aXNpYmlsaXR5IG1heSBoYXZlIGNoYW5nZWQuICovXG4gIG9uSnVtcENoYW5nZT86IChzaG93OiBib29sZWFuKSA9PiB2b2lkO1xuICAvKiogV2hlbiB0cnVlIChmb3IgZXhhbXBsZSB3aGlsZSB0aGUgZW1wdHkgc3RhdGUgaXMgc2hvd24pLCBrZWVwIHRoZSBqdW1wIGNvbnRyb2wgaGlkZGVuLiAqL1xuICBpc0VtcHR5PzogKCkgPT4gYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBLZWVwcyBhIHRyYW5zY3JpcHQgcGFuZSBwaW5uZWQgdG8gdGhlIGJvdHRvbSBhcyBtZXNzYWdlcyBzdHJlYW0gaW4sIHdpdGhvdXQgbWVhc3VyaW5nXG4gKiBuZWFyLWJvdHRvbSBhZnRlciBhbiBhcHBlbmQgaGFzIGFscmVhZHkgZ3Jvd24gc2Nyb2xsSGVpZ2h0LCBhbmQgeWllbGRzIGltbWVkaWF0ZWx5IHdoZW5cbiAqIHRoZSB1c2VyIHNjcm9sbHMgdXAgdG8gcmVhZCBlYXJsaWVyIG1lc3NhZ2VzLlxuICovXG5leHBvcnQgY2xhc3MgQXV0b1Njcm9sbGVyIHtcbiAgcHJpdmF0ZSByZWFkb25seSBwYW5lOiBTY3JvbGxQYW5lO1xuICBwcml2YXRlIHJlYWRvbmx5IHBpblRocmVzaG9sZDogbnVtYmVyO1xuICBwcml2YXRlIHJlYWRvbmx5IGp1bXBUaHJlc2hvbGQ6IG51bWJlcjtcbiAgcHJpdmF0ZSByZWFkb25seSBvbkp1bXBDaGFuZ2U/OiAoc2hvdzogYm9vbGVhbikgPT4gdm9pZDtcbiAgcHJpdmF0ZSByZWFkb25seSBpc0VtcHR5PzogKCkgPT4gYm9vbGVhbjtcbiAgcHJpdmF0ZSBwaW5uZWQgPSB0cnVlO1xuICBwcml2YXRlIGp1bXBpbmcgPSBmYWxzZTtcbiAgcHJpdmF0ZSBsYXN0U2Nyb2xsVG9wID0gMDtcblxuICBjb25zdHJ1Y3RvcihwYW5lOiBTY3JvbGxQYW5lLCBvcHRpb25zOiBBdXRvU2Nyb2xsZXJPcHRpb25zID0ge30pIHtcbiAgICB0aGlzLnBhbmUgPSBwYW5lO1xuICAgIHRoaXMucGluVGhyZXNob2xkID0gb3B0aW9ucy5waW5UaHJlc2hvbGQgPz8gMzI7XG4gICAgdGhpcy5qdW1wVGhyZXNob2xkID0gb3B0aW9ucy5qdW1wVGhyZXNob2xkID8/IDEyMDtcbiAgICB0aGlzLm9uSnVtcENoYW5nZSA9IG9wdGlvbnMub25KdW1wQ2hhbmdlO1xuICAgIHRoaXMuaXNFbXB0eSA9IG9wdGlvbnMuaXNFbXB0eTtcbiAgICB0aGlzLmxhc3RTY3JvbGxUb3AgPSBwYW5lLnNjcm9sbFRvcDtcbiAgfVxuXG4gIGdldCBpc1Bpbm5lZCgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5waW5uZWQ7XG4gIH1cblxuICBwcml2YXRlIGRpc3RhbmNlKCk6IG51bWJlciB7XG4gICAgcmV0dXJuIE1hdGgubWF4KDAsIHRoaXMucGFuZS5zY3JvbGxIZWlnaHQgLSB0aGlzLnBhbmUuc2Nyb2xsVG9wIC0gdGhpcy5wYW5lLmNsaWVudEhlaWdodCk7XG4gIH1cblxuICBwcml2YXRlIGlzVmlzaWJsZSgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5wYW5lLmNsaWVudEhlaWdodCA+IDA7XG4gIH1cblxuICBwcml2YXRlIHNuYXBUb0JvdHRvbSgpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuaXNWaXNpYmxlKCkpIHJldHVybjtcbiAgICB0aGlzLnBhbmUuc2Nyb2xsVG9wID0gdGhpcy5wYW5lLnNjcm9sbEhlaWdodDtcbiAgICB0aGlzLmxhc3RTY3JvbGxUb3AgPSB0aGlzLnBhbmUuc2Nyb2xsVG9wO1xuICB9XG5cbiAgcHJpdmF0ZSB1cGRhdGVKdW1wKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5vbkp1bXBDaGFuZ2UpIHJldHVybjtcbiAgICBjb25zdCBlbXB0eSA9IHRoaXMuaXNFbXB0eT8uKCkgPz8gZmFsc2U7XG4gICAgY29uc3Qgc2hvdyA9ICFlbXB0eSAmJiB0aGlzLmlzVmlzaWJsZSgpICYmICF0aGlzLmp1bXBpbmcgJiYgdGhpcy5kaXN0YW5jZSgpID4gdGhpcy5qdW1wVGhyZXNob2xkO1xuICAgIHRoaXMub25KdW1wQ2hhbmdlKHNob3cpO1xuICB9XG5cbiAgLyoqIENhbGwgYWZ0ZXIgY29udGVudCBpcyBhZGRlZCwgdXBkYXRlZCwgb3IgcmVtb3ZlZCBpbiB0aGUgcGFuZS4gKi9cbiAgb25Db250ZW50KGZvcmNlID0gZmFsc2UpOiB2b2lkIHtcbiAgICBpZiAoZm9yY2UpIHtcbiAgICAgIHRoaXMucGlubmVkID0gdHJ1ZTtcbiAgICAgIHRoaXMuanVtcGluZyA9IGZhbHNlO1xuICAgIH1cbiAgICBpZiAodGhpcy5waW5uZWQpIHtcbiAgICAgIGlmICh0aGlzLmp1bXBpbmcgJiYgdGhpcy5wYW5lLnNjcm9sbFRvICYmIHRoaXMuaXNWaXNpYmxlKCkpIHtcbiAgICAgICAgdGhpcy5wYW5lLnNjcm9sbFRvKHsgdG9wOiB0aGlzLnBhbmUuc2Nyb2xsSGVpZ2h0LCBiZWhhdmlvcjogXCJzbW9vdGhcIiB9KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMuc25hcFRvQm90dG9tKCk7XG4gICAgICB9XG4gICAgfVxuICAgIHRoaXMudXBkYXRlSnVtcCgpO1xuICB9XG5cbiAgLyoqIENhbGwgd2hlbiB0aGUgcGFuZSdzIHZpZXdwb3J0IHJlc2l6ZXMgKGJhcnMgYXBwZWFyaW5nLCBrZXlib2FyZCwgdGFiIHN3aXRjaCkuICovXG4gIG9uUmVzaXplKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5pc1Zpc2libGUoKSkgcmV0dXJuO1xuICAgIGlmICh0aGlzLnBpbm5lZCkge1xuICAgICAgdGhpcy5qdW1waW5nID0gZmFsc2U7XG4gICAgICB0aGlzLnNuYXBUb0JvdHRvbSgpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLmxhc3RTY3JvbGxUb3AgPSB0aGlzLnBhbmUuc2Nyb2xsVG9wO1xuICAgIH1cbiAgICB0aGlzLnVwZGF0ZUp1bXAoKTtcbiAgfVxuXG4gIC8qKiBDYWxsIGZyb20gdGhlIHBhbmUncyBzY3JvbGwgZXZlbnQgbGlzdGVuZXIuICovXG4gIG9uU2Nyb2xsKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5pc1Zpc2libGUoKSkgcmV0dXJuO1xuICAgIGNvbnN0IHRvcCA9IHRoaXMucGFuZS5zY3JvbGxUb3A7XG4gICAgY29uc3QgZGlzdCA9IHRoaXMuZGlzdGFuY2UoKTtcbiAgICBjb25zdCBtb3ZlZFVwID0gdG9wIDwgdGhpcy5sYXN0U2Nyb2xsVG9wO1xuICAgIHRoaXMubGFzdFNjcm9sbFRvcCA9IHRvcDtcblxuICAgIGlmIChkaXN0IDw9IHRoaXMucGluVGhyZXNob2xkKSB7XG4gICAgICB0aGlzLnBpbm5lZCA9IHRydWU7XG4gICAgICB0aGlzLmp1bXBpbmcgPSBmYWxzZTtcbiAgICB9IGVsc2UgaWYgKG1vdmVkVXApIHtcbiAgICAgIHRoaXMucGlubmVkID0gZmFsc2U7XG4gICAgICB0aGlzLmp1bXBpbmcgPSBmYWxzZTtcbiAgICB9XG4gICAgdGhpcy51cGRhdGVKdW1wKCk7XG4gIH1cblxuICAvKiogQ2FsbCBmcm9tIHRoZSBwYW5lJ3Mgc2Nyb2xsZW5kIGV2ZW50IGxpc3RlbmVyLiAqL1xuICBvblNjcm9sbEVuZCgpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuaXNWaXNpYmxlKCkgfHwgIXRoaXMuanVtcGluZykgcmV0dXJuO1xuICAgIHRoaXMuanVtcGluZyA9IGZhbHNlO1xuICAgIGlmICh0aGlzLmRpc3RhbmNlKCkgPiB0aGlzLnBpblRocmVzaG9sZCkgdGhpcy5waW5uZWQgPSBmYWxzZTtcbiAgICB0aGlzLnVwZGF0ZUp1bXAoKTtcbiAgfVxuXG4gIC8qKiBDYWxsIG9uIHVzZXIgd2hlZWwtdXAgb3IgdG91Y2hzdGFydCBzbyBhbiBhY3RpdmUgc21vb3RoIGp1bXAgeWllbGRzIHRvIHRoZSB1c2VyLiAqL1xuICBjYW5jZWxKdW1wKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5qdW1waW5nKSByZXR1cm47XG4gICAgdGhpcy5qdW1waW5nID0gZmFsc2U7XG4gICAgaWYgKHRoaXMuaXNWaXNpYmxlKCkpIHtcbiAgICAgIGNvbnN0IHRvcCA9IHRoaXMucGFuZS5zY3JvbGxUb3A7XG4gICAgICBpZiAodGhpcy5wYW5lLnNjcm9sbFRvKSB0aGlzLnBhbmUuc2Nyb2xsVG8oeyB0b3AsIGJlaGF2aW9yOiBcImluc3RhbnRcIiB9KTtcbiAgICAgIGVsc2UgdGhpcy5wYW5lLnNjcm9sbFRvcCA9IHRvcDtcbiAgICAgIHRoaXMubGFzdFNjcm9sbFRvcCA9IHRoaXMucGFuZS5zY3JvbGxUb3A7XG4gICAgICBpZiAodGhpcy5kaXN0YW5jZSgpID4gdGhpcy5waW5UaHJlc2hvbGQpIHRoaXMucGlubmVkID0gZmFsc2U7XG4gICAgfVxuICAgIHRoaXMudXBkYXRlSnVtcCgpO1xuICB9XG5cbiAgLyoqIFJlLXBpbiBhbmQgc2Nyb2xsIHNtb290aGx5IHRvIHRoZSBib3R0b20gKHVzZWQgYnkgdGhlIGp1bXAtdG8tbGF0ZXN0IGJ1dHRvbikuICovXG4gIGp1bXBUb0JvdHRvbSgpOiB2b2lkIHtcbiAgICB0aGlzLnBpbm5lZCA9IHRydWU7XG4gICAgaWYgKCF0aGlzLmlzVmlzaWJsZSgpKSB7XG4gICAgICB0aGlzLnVwZGF0ZUp1bXAoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHRoaXMuZGlzdGFuY2UoKSA8PSB0aGlzLnBpblRocmVzaG9sZCB8fCAhdGhpcy5wYW5lLnNjcm9sbFRvKSB7XG4gICAgICB0aGlzLmp1bXBpbmcgPSBmYWxzZTtcbiAgICAgIHRoaXMuc25hcFRvQm90dG9tKCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuanVtcGluZyA9IHRydWU7XG4gICAgICB0aGlzLmxhc3RTY3JvbGxUb3AgPSB0aGlzLnBhbmUuc2Nyb2xsVG9wO1xuICAgICAgdGhpcy5wYW5lLnNjcm9sbFRvKHsgdG9wOiB0aGlzLnBhbmUuc2Nyb2xsSGVpZ2h0LCBiZWhhdmlvcjogXCJzbW9vdGhcIiB9KTtcbiAgICB9XG4gICAgdGhpcy51cGRhdGVKdW1wKCk7XG4gIH1cblxuICAvKiogUmVjb21wdXRlIHBpbm5lZCBzdGF0ZSBmcm9tIHRoZSBjdXJyZW50IHBvc2l0aW9uIGFmdGVyIGEgdXNlci1kcml2ZW4gbGF5b3V0IGNoYW5nZSAoZS5nLiBleHBhbmRpbmcgYSByZXN1bHQpLiAqL1xuICBzeW5jRnJvbVBvc2l0aW9uKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5pc1Zpc2libGUoKSkgcmV0dXJuO1xuICAgIHRoaXMuanVtcGluZyA9IGZhbHNlO1xuICAgIHRoaXMubGFzdFNjcm9sbFRvcCA9IHRoaXMucGFuZS5zY3JvbGxUb3A7XG4gICAgdGhpcy5waW5uZWQgPSB0aGlzLmRpc3RhbmNlKCkgPD0gdGhpcy5waW5UaHJlc2hvbGQ7XG4gICAgdGhpcy51cGRhdGVKdW1wKCk7XG4gIH1cblxuICAvKiogUGF1c2UgYXV0by1zY3JvbGwgZXhwbGljaXRseSAoZS5nLiB3aGVuIHJldmVhbGluZyBhbiBvbGRlciByZXN1bHQgY2FyZCkuICovXG4gIHVucGluKCk6IHZvaWQge1xuICAgIHRoaXMucGlubmVkID0gZmFsc2U7XG4gICAgdGhpcy5qdW1waW5nID0gZmFsc2U7XG4gICAgdGhpcy51cGRhdGVKdW1wKCk7XG4gIH1cbn1cbiIsICIvLyBQdXJlIFVJIGhlbHBlcnMgZm9yIHRoZSBWb2ljZSB3ZWIgc3VyZmFjZSAoZGVuc2l0eSwgYWdlbnQtcGFuZSBmaWx0ZXJpbmcsIGNvbXBhY3QgcHJldmlld3MpLlxuXG5leHBvcnQgdHlwZSBTaWRlRmlsdGVyID0gXCJhbGxcIiB8IFwiYWN0aXZlXCIgfCBcInJlc3VsdHNcIjtcbmV4cG9ydCB0eXBlIERlbnNpdHkgPSBcImNvbXBhY3RcIiB8IFwiY29tZm9ydGFibGVcIjtcblxuZXhwb3J0IGludGVyZmFjZSBTaWRlQ291bnRzIHtcbiAgYWN0aXZlOiBudW1iZXI7XG4gIHJlc3VsdHM6IG51bWJlcjtcbiAgZWFybGllcjogbnVtYmVyO1xuICBkb25lOiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2lkZVZpc2liaWxpdHkge1xuICBzaG93VGFza3NTZWN0aW9uOiBib29sZWFuO1xuICBzaG93RW1wdHlUYXNrczogYm9vbGVhbjtcbiAgc2hvd1Jlc3VsdHNTZWN0aW9uOiBib29sZWFuO1xuICBzaG93RW1wdHlSZXN1bHRzOiBib29sZWFuO1xuICBzaG93RWFybGllclNlY3Rpb246IGJvb2xlYW47XG4gIHNob3dEb25lU2VjdGlvbjogYm9vbGVhbjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZURlbnNpdHkodmFsdWU6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQpOiBEZW5zaXR5IHtcbiAgcmV0dXJuIHZhbHVlID09PSBcImNvbWZvcnRhYmxlXCIgPyBcImNvbWZvcnRhYmxlXCIgOiBcImNvbXBhY3RcIjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZVNpZGVGaWx0ZXIodmFsdWU6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQpOiBTaWRlRmlsdGVyIHtcbiAgaWYgKHZhbHVlID09PSBcImFjdGl2ZVwiIHx8IHZhbHVlID09PSBcInJlc3VsdHNcIikgcmV0dXJuIHZhbHVlO1xuICByZXR1cm4gXCJhbGxcIjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlUHJlZml4KHRleHQ6IHN0cmluZyk6IHsgbW9kZTogXCJoZXJtZXNcIiB8IFwidDNcIiB8IG51bGw7IHJlc3Q6IHN0cmluZyB9IHtcbiAgY29uc3QgbSA9IHRleHQubWF0Y2goL15cXC8odDN8Y29kZXxofGhlcm1lcylcXHMrKC4qKSQvaXMpO1xuICBpZiAoIW0pIHJldHVybiB7IG1vZGU6IG51bGwsIHJlc3Q6IHRleHQgfTtcbiAgcmV0dXJuIHsgbW9kZTogL14odDN8Y29kZSkkL2kudGVzdChtWzFdKSA/IFwidDNcIiA6IFwiaGVybWVzXCIsIHJlc3Q6IG1bMl0udHJpbSgpIH07XG59XG5cbi8qKiBBIHJlc3VsdCBjYXJkIG1heSBvbmx5IHN0ZWVyIGEgdGFzayB0aGF0IGJlbG9uZ3MgdG8gdGhlIHNhbWUgYWN0aXZlIHNlc3Npb24gKHRhc2sgSURzIHJlc3RhcnQgcGVyIGNhbGwpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNhbkZvbGxvd1VwUmVzdWx0KHJlc3VsdFNlc3Npb246IG51bWJlciwgYWN0aXZlU2Vzc2lvbjogbnVtYmVyLCBoYXNUYXNrOiBib29sZWFuKTogYm9vbGVhbiB7XG4gIHJldHVybiBhY3RpdmVTZXNzaW9uID4gMCAmJiByZXN1bHRTZXNzaW9uID09PSBhY3RpdmVTZXNzaW9uICYmIGhhc1Rhc2s7XG59XG5cbi8qKiBVbnJlYWQgbW9iaWxlIHJlc3VsdCBhbGVydHMgb25seSBjbGVhciBvbmNlIHRoZSBSZXN1bHRzIHNlY3Rpb24gaXMgYWN0dWFsbHkgdmlzaWJsZSB0byB0aGUgdXNlci4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzaG91bGRDbGVhclVucmVhZFJlc3VsdHMoaXNNb2JpbGU6IGJvb2xlYW4sIGRyYXdlck9wZW46IGJvb2xlYW4sIGZpbHRlcjogU2lkZUZpbHRlcik6IGJvb2xlYW4ge1xuICByZXR1cm4gIWlzTW9iaWxlIHx8IChkcmF3ZXJPcGVuICYmIGZpbHRlciAhPT0gXCJhY3RpdmVcIik7XG59XG5cbi8qKiBQaWNrIHRoZSBmaWx0ZXIgdG8gc2hvdyB3aGVuIHRhcHBpbmcgdGhlIG1vYmlsZSBsaXZlLXN0YXR1cyBiYW5uZXIgc28gdGhlIGFkdmVydGlzZWQgaXRlbSBpcyB2aXNpYmxlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVNb2JpbGVCYW5uZXJGaWx0ZXIoY3VycmVudDogU2lkZUZpbHRlciwgYWN0aXZlVG90YWw6IG51bWJlciwgdW5yZWFkUmVzdWx0czogbnVtYmVyKTogU2lkZUZpbHRlciB7XG4gIGlmIChhY3RpdmVUb3RhbCA+IDApIHJldHVybiBjdXJyZW50ID09PSBcInJlc3VsdHNcIiA/IFwiYWxsXCIgOiBjdXJyZW50O1xuICBpZiAodW5yZWFkUmVzdWx0cyA+IDApIHJldHVybiBcInJlc3VsdHNcIjtcbiAgcmV0dXJuIGN1cnJlbnQ7XG59XG5cbi8qKiBGbGF0dGVuIGEgTWFya2Rvd24gYWdlbnQgcmVwbHkgaW50byBhIHNpbmdsZS1saW5lIHBsYWluLXRleHQgcHJldmlldyBmb3IgaW5saW5lIGhhbmRvZmYgY2hpcHMuICovXG5leHBvcnQgZnVuY3Rpb24gcGxhaW5QcmV2aWV3KHRleHQ6IHN0cmluZywgbWF4TGVuID0gMTUwKTogc3RyaW5nIHtcbiAgY29uc3QgY2xlYW5lZCA9IHRleHRcbiAgICAucmVwbGFjZSgvYGBgW15cXG5dKlxcbj8oW1xcc1xcU10qPylgYGAvZywgKF8sIGNvZGU6IHN0cmluZykgPT4gYCAke2NvZGUudHJpbSgpfSBgKVxuICAgIC5yZXBsYWNlKC9cXFsoW15cXF1cXG5dKylcXF1cXCgoaHR0cHM/OlxcL1xcL1teXFxzKV0rKVxcKS9nLCBcIiQxXCIpXG4gICAgLnJlcGxhY2UoL14jezEsNn1cXHMrL2dtLCBcIlwiKVxuICAgIC5yZXBsYWNlKC9eXFxzKig/OlstKlx1MjAyMl18XFxkK1suKV0pXFxzKy9nbSwgXCJcIilcbiAgICAucmVwbGFjZSgvYChbXmBcXG5dKylgL2csIFwiJDFcIilcbiAgICAucmVwbGFjZSgvXFwqXFwqKFteKlxcbl0rKVxcKlxcKi9nLCBcIiQxXCIpXG4gICAgLnJlcGxhY2UoL19fKFteX1xcbl0rKV9fL2csIFwiJDFcIilcbiAgICAucmVwbGFjZSgvXFxzKy9nLCBcIiBcIilcbiAgICAudHJpbSgpO1xuICBpZiAoY2xlYW5lZC5sZW5ndGggPD0gbWF4TGVuKSByZXR1cm4gY2xlYW5lZDtcbiAgY29uc3QgY3V0ID0gY2xlYW5lZC5zbGljZSgwLCBtYXhMZW4pO1xuICBjb25zdCBzcGFjZSA9IGN1dC5sYXN0SW5kZXhPZihcIiBcIik7XG4gIGNvbnN0IGJhc2UgPSBzcGFjZSA+IE1hdGguZmxvb3IobWF4TGVuICogMC42KSA/IGN1dC5zbGljZSgwLCBzcGFjZSkgOiBjdXQ7XG4gIHJldHVybiBgJHtiYXNlLnJlcGxhY2UoL1suLDs6XFxzLV0rJC8sIFwiXCIpfVx1MjAyNmA7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXRTaG9ydFRpbWUoZGF0ZTogRGF0ZSk6IHN0cmluZyB7XG4gIGNvbnN0IHBhZCA9IChuOiBudW1iZXIpID0+IFN0cmluZyhuKS5wYWRTdGFydCgyLCBcIjBcIik7XG4gIHJldHVybiBgJHtwYWQoZGF0ZS5nZXRIb3VycygpKX06JHtwYWQoZGF0ZS5nZXRNaW51dGVzKCkpfWA7XG59XG5cbi8qKiBEZWNpZGUgd2hpY2ggc2VjdGlvbnMgb2YgdGhlIHJpZ2h0LWhhbmQgQWdlbnQgV29ya3NwYWNlIGFyZSB2aXNpYmxlIGZvciBhIGdpdmVuIGZpbHRlciBhbmQgY291bnRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVTaWRlU2VjdGlvbnMoZmlsdGVyOiBTaWRlRmlsdGVyLCBjb3VudHM6IFNpZGVDb3VudHMpOiBTaWRlVmlzaWJpbGl0eSB7XG4gIGlmIChmaWx0ZXIgPT09IFwicmVzdWx0c1wiKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHNob3dUYXNrc1NlY3Rpb246IGZhbHNlLFxuICAgICAgc2hvd0VtcHR5VGFza3M6IGZhbHNlLFxuICAgICAgc2hvd1Jlc3VsdHNTZWN0aW9uOiB0cnVlLFxuICAgICAgc2hvd0VtcHR5UmVzdWx0czogY291bnRzLnJlc3VsdHMgPT09IDAsXG4gICAgICBzaG93RWFybGllclNlY3Rpb246IGZhbHNlLFxuICAgICAgc2hvd0RvbmVTZWN0aW9uOiBmYWxzZSxcbiAgICB9O1xuICB9XG4gIGlmIChmaWx0ZXIgPT09IFwiYWN0aXZlXCIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc2hvd1Rhc2tzU2VjdGlvbjogdHJ1ZSxcbiAgICAgIHNob3dFbXB0eVRhc2tzOiBjb3VudHMuYWN0aXZlID09PSAwICYmIGNvdW50cy5lYXJsaWVyID09PSAwLFxuICAgICAgc2hvd1Jlc3VsdHNTZWN0aW9uOiBmYWxzZSxcbiAgICAgIHNob3dFbXB0eVJlc3VsdHM6IGZhbHNlLFxuICAgICAgc2hvd0VhcmxpZXJTZWN0aW9uOiBjb3VudHMuZWFybGllciA+IDAsXG4gICAgICBzaG93RG9uZVNlY3Rpb246IGNvdW50cy5kb25lID4gMCxcbiAgICB9O1xuICB9XG4gIC8vIFwiYWxsXCI6IGhpZGUgdGhlIGVtcHR5IGFjdGl2ZS10YXNrcyBwbGFjZWhvbGRlciBhcyBzb29uIGFzIHJlc3VsdHMgb3IgZWFybGllciBhZ2VudHMgZXhpc3RcbiAgLy8gc28gZmluaXNoZWQgcmVzcG9uc2VzIHRha2UgdGhlIHRvcCBvZiB0aGUgcGFuZSB3aXRob3V0IHdhc3RlZCBzcGFjZS5cbiAgY29uc3QgaGFzQW55dGhpbmdBYm92ZURvbmUgPSBjb3VudHMuYWN0aXZlID4gMCB8fCBjb3VudHMucmVzdWx0cyA+IDAgfHwgY291bnRzLmVhcmxpZXIgPiAwO1xuICByZXR1cm4ge1xuICAgIHNob3dUYXNrc1NlY3Rpb246IGNvdW50cy5hY3RpdmUgPiAwIHx8ICFoYXNBbnl0aGluZ0Fib3ZlRG9uZSxcbiAgICBzaG93RW1wdHlUYXNrczogIWhhc0FueXRoaW5nQWJvdmVEb25lLFxuICAgIHNob3dSZXN1bHRzU2VjdGlvbjogY291bnRzLnJlc3VsdHMgPiAwLFxuICAgIHNob3dFbXB0eVJlc3VsdHM6IGZhbHNlLFxuICAgIHNob3dFYXJsaWVyU2VjdGlvbjogY291bnRzLmVhcmxpZXIgPiAwLFxuICAgIHNob3dEb25lU2VjdGlvbjogY291bnRzLmRvbmUgPiAwLFxuICB9O1xufVxuIiwgIi8vIE1haW4tdGhyZWFkIGNvbnRyb2xsZXIgZm9yIHRoZSB3YWtlIHdvcmQgV2ViIFdvcmtlci5cbi8vIFRhZ3MgZXZlcnkgbG9hZCBhbmQgcmVzZXQgd2l0aCBhIG1vbm90b25pYyBnZW5lcmF0aW9uIChgZ2VuYCkgc28gc3RhbGUgZGV0ZWN0aW9ucyBvciByZWFkeSBldmVudHNcbi8vIGFmdGVyIGEgbW9kZWwgc3dpdGNoIG9yIHJlc2V0IGFyZSBpZ25vcmVkLCBhbmQga2VlcHMgYSBzaG9ydCByaW5nIGJ1ZmZlciBvZiByZWNlbnQgZmVkIGNodW5rc1xuLy8gaW5kZXhlZCBieSBgc2VxYCBzbyBhdWRpbyBjYXB0dXJlZCB3aGlsZSB0aGUgd29ya2VyIHdhcyBzY29yaW5nIGlzIHByZXNlcnZlZCBpbiBgaGl0LnRyYWlsaW5nYC5cblxuZXhwb3J0IGludGVyZmFjZSBXYWtlVGVsZW1ldHJ5IHtcbiAgc2NvcmU6IG51bWJlcjtcbiAgcGVhazogbnVtYmVyO1xuICBnYXRlT3BlbjogYm9vbGVhbjtcbiAgZnJhbWVzOiBudW1iZXI7XG4gIHNjb3JlZDogbnVtYmVyO1xuICBpbmZlck1zOiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgV2FrZURldGVjdGlvbkV2ZW50IHtcbiAgc2NvcmU6IG51bWJlcjtcbiAgYXRGcmFtZTogbnVtYmVyO1xuICAvKiogQXVkaW8gY2h1bmtzIHNwb2tlbiBhZnRlciB0aGUgd2FrZSB3b3JkOiB0aGUgdHJpZ2dlcmluZyBjaHVuaydzIHRhaWwgcGx1cyBhbnkgY2h1bmtzIGFscmVhZHkgc2VudCBhZnRlciBpdC4gKi9cbiAgdHJhaWxpbmc6IFVpbnQ4QXJyYXlbXTtcbiAgaW5mZXJNczogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFdha2VDbGllbnRDYWxsYmFja3Mge1xuICBvblJlYWR5PzogKG1vZGVsSWQ6IHN0cmluZywgd2FybXVwTXM6IG51bWJlcikgPT4gdm9pZDtcbiAgb25EZXRlY3RlZDogKGhpdDogV2FrZURldGVjdGlvbkV2ZW50KSA9PiB2b2lkO1xuICBvblRlbGVtZXRyeT86ICh0OiBXYWtlVGVsZW1ldHJ5KSA9PiB2b2lkO1xuICBvbkVycm9yPzogKG1lc3NhZ2U6IHN0cmluZykgPT4gdm9pZDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBXb3JrZXJMaWtlIHtcbiAgb25tZXNzYWdlOiAoKGU6IE1lc3NhZ2VFdmVudDxSZWNvcmQ8c3RyaW5nLCBhbnk+PikgPT4gdm9pZCkgfCBudWxsO1xuICBvbmVycm9yOiAoKGU6IEVycm9yRXZlbnQpID0+IHZvaWQpIHwgbnVsbDtcbiAgcG9zdE1lc3NhZ2UobWVzc2FnZTogdW5rbm93biwgdHJhbnNmZXI/OiBUcmFuc2ZlcmFibGVbXSk6IHZvaWQ7XG4gIHRlcm1pbmF0ZSgpOiB2b2lkO1xufVxuXG4vKiogTWF4IGJ1ZmZlcmVkIHBvc3QtZmVlZCBhdWRpbyAofjEuNSBzIGF0IDIwIG1zIGNodW5rcykgdG8gY292ZXIgd29ya2VyIHNjb3JpbmcgbGF0ZW5jeS4gKi9cbmNvbnN0IFJFQ0VOVF9NQVhfQllURVMgPSBNYXRoLnJvdW5kKDEuNSAqIDMyXzAwMCk7XG5cbmV4cG9ydCBjbGFzcyBXYWtlQ2xpZW50IHtcbiAgcHJpdmF0ZSB3b3JrZXI6IFdvcmtlckxpa2UgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSByZWFkb25seSBjYWxsYmFja3M6IFdha2VDbGllbnRDYWxsYmFja3M7XG4gIHByaXZhdGUgcmVhZG9ubHkgY3JlYXRlV29ya2VyOiAoKSA9PiBXb3JrZXJMaWtlO1xuICBwcml2YXRlIGxvYWRlZE1vZGVsSWQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIGxvYWRpbmdNb2RlbElkOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBjdXJyZW50VGhyZXNob2xkID0gMC43O1xuICBwcml2YXRlIGdlbiA9IDA7XG4gIHByaXZhdGUgc2VxID0gMDtcbiAgcHJpdmF0ZSByZWNlbnQ6IHsgc2VxOiBudW1iZXI7IGJ5dGVzOiBVaW50OEFycmF5IH1bXSA9IFtdO1xuICBwcml2YXRlIHJlY2VudEJ5dGVzID0gMDtcbiAgcmVhZHkgPSBmYWxzZTtcblxuICBjb25zdHJ1Y3RvcihcbiAgICBjYWxsYmFja3M6IFdha2VDbGllbnRDYWxsYmFja3MsXG4gICAgY3JlYXRlV29ya2VyOiAoKSA9PiBXb3JrZXJMaWtlID0gKCkgPT4gbmV3IFdvcmtlcihcIi93YWtlLndvcmtlci5qc1wiLCB7IHR5cGU6IFwibW9kdWxlXCIgfSksXG4gICkge1xuICAgIHRoaXMuY2FsbGJhY2tzID0gY2FsbGJhY2tzO1xuICAgIHRoaXMuY3JlYXRlV29ya2VyID0gY3JlYXRlV29ya2VyO1xuICB9XG5cbiAgcHJpdmF0ZSBjbGVhclJlY2VudCgpOiB2b2lkIHtcbiAgICB0aGlzLnJlY2VudCA9IFtdO1xuICAgIHRoaXMucmVjZW50Qnl0ZXMgPSAwO1xuICB9XG5cbiAgcHJpdmF0ZSBlbnN1cmVXb3JrZXIoKTogV29ya2VyTGlrZSB7XG4gICAgaWYgKHRoaXMud29ya2VyKSByZXR1cm4gdGhpcy53b3JrZXI7XG4gICAgY29uc3Qgd29ya2VyID0gdGhpcy5jcmVhdGVXb3JrZXIoKTtcbiAgICB3b3JrZXIub25tZXNzYWdlID0gKGU6IE1lc3NhZ2VFdmVudDxSZWNvcmQ8c3RyaW5nLCBhbnk+PikgPT4ge1xuICAgICAgY29uc3QgbSA9IGUuZGF0YTtcbiAgICAgIGlmICh0eXBlb2YgbS5nZW4gPT09IFwibnVtYmVyXCIgJiYgbS5nZW4gIT09IHRoaXMuZ2VuKSByZXR1cm47XG4gICAgICBpZiAobS50eXBlID09PSBcInJlYWR5XCIpIHtcbiAgICAgICAgdGhpcy5sb2FkaW5nTW9kZWxJZCA9IG51bGw7XG4gICAgICAgIHRoaXMubG9hZGVkTW9kZWxJZCA9IG0ubW9kZWxJZDtcbiAgICAgICAgdGhpcy5yZWFkeSA9IHRydWU7XG4gICAgICAgIHRoaXMuY2FsbGJhY2tzLm9uUmVhZHk/LihtLm1vZGVsSWQsIG0ud2FybXVwTXMpO1xuICAgICAgfSBlbHNlIGlmIChtLnR5cGUgPT09IFwiZGV0ZWN0ZWRcIikge1xuICAgICAgICBjb25zdCB0cmFpbGluZzogVWludDhBcnJheVtdID0gW107XG4gICAgICAgIGNvbnN0IHJlc3QgPSBuZXcgVWludDhBcnJheShtLnJlc3RCeXRlcyBhcyBBcnJheUJ1ZmZlcik7XG4gICAgICAgIGlmIChyZXN0LmJ5dGVMZW5ndGggPiAwKSB0cmFpbGluZy5wdXNoKHJlc3QpO1xuICAgICAgICBjb25zdCBoaXRTZXEgPSB0eXBlb2YgbS5zZXEgPT09IFwibnVtYmVyXCIgPyBtLnNlcSA6IE51bWJlci5NQVhfU0FGRV9JTlRFR0VSO1xuICAgICAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgdGhpcy5yZWNlbnQpIHtcbiAgICAgICAgICBpZiAoaXRlbS5zZXEgPiBoaXRTZXEpIHRyYWlsaW5nLnB1c2goaXRlbS5ieXRlcyk7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5jbGVhclJlY2VudCgpO1xuICAgICAgICB0aGlzLmNhbGxiYWNrcy5vbkRldGVjdGVkKHtcbiAgICAgICAgICBzY29yZTogbS5zY29yZSxcbiAgICAgICAgICBhdEZyYW1lOiBtLmF0RnJhbWUsXG4gICAgICAgICAgdHJhaWxpbmcsXG4gICAgICAgICAgaW5mZXJNczogbS5pbmZlck1zLFxuICAgICAgICB9KTtcbiAgICAgIH0gZWxzZSBpZiAobS50eXBlID09PSBcInRlbGVtZXRyeVwiKSB7XG4gICAgICAgIHRoaXMuY2FsbGJhY2tzLm9uVGVsZW1ldHJ5Py4oe1xuICAgICAgICAgIHNjb3JlOiBtLnNjb3JlLFxuICAgICAgICAgIHBlYWs6IG0ucGVhayxcbiAgICAgICAgICBnYXRlT3BlbjogbS5nYXRlT3BlbixcbiAgICAgICAgICBmcmFtZXM6IG0uZnJhbWVzLFxuICAgICAgICAgIHNjb3JlZDogbS5zY29yZWQsXG4gICAgICAgICAgaW5mZXJNczogbS5pbmZlck1zLFxuICAgICAgICB9KTtcbiAgICAgIH0gZWxzZSBpZiAobS50eXBlID09PSBcImVycm9yXCIpIHtcbiAgICAgICAgdGhpcy5sb2FkaW5nTW9kZWxJZCA9IG51bGw7XG4gICAgICAgIHRoaXMucmVhZHkgPSBmYWxzZTtcbiAgICAgICAgdGhpcy5jYWxsYmFja3Mub25FcnJvcj8uKFN0cmluZyhtLm1lc3NhZ2UgPz8gXCJ3YWtlIHdvcmtlciBlcnJvclwiKSk7XG4gICAgICB9XG4gICAgfTtcbiAgICB3b3JrZXIub25lcnJvciA9IChlcnIpID0+IHtcbiAgICAgIHRoaXMubG9hZGluZ01vZGVsSWQgPSBudWxsO1xuICAgICAgdGhpcy5yZWFkeSA9IGZhbHNlO1xuICAgICAgdGhpcy5jYWxsYmFja3Mub25FcnJvcj8uKGVyci5tZXNzYWdlIHx8IFwid2FrZSB3b3JrZXIgZmFpbGVkXCIpO1xuICAgIH07XG4gICAgdGhpcy53b3JrZXIgPSB3b3JrZXI7XG4gICAgcmV0dXJuIHdvcmtlcjtcbiAgfVxuXG4gIC8qKiBMb2FkcyAob3Igc3dpdGNoZXMgdG8pIHRoZSBuYW1lZCBtb2RlbDsgaWdub3JlcyBzdGFsZSByZXN1bHRzIGZyb20gZWFybGllciBsb2Fkcy4gKi9cbiAgbG9hZChtb2RlbElkOiBzdHJpbmcsIHRocmVzaG9sZDogbnVtYmVyKTogdm9pZCB7XG4gICAgdGhpcy5jdXJyZW50VGhyZXNob2xkID0gdGhyZXNob2xkO1xuICAgIGNvbnN0IHdvcmtlciA9IHRoaXMuZW5zdXJlV29ya2VyKCk7XG4gICAgaWYgKHRoaXMucmVhZHkgJiYgdGhpcy5sb2FkZWRNb2RlbElkID09PSBtb2RlbElkKSB7XG4gICAgICB3b3JrZXIucG9zdE1lc3NhZ2UoeyB0eXBlOiBcImNvbmZpZ1wiLCB0aHJlc2hvbGQgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICh0aGlzLmxvYWRpbmdNb2RlbElkID09PSBtb2RlbElkKSB7XG4gICAgICB3b3JrZXIucG9zdE1lc3NhZ2UoeyB0eXBlOiBcImNvbmZpZ1wiLCB0aHJlc2hvbGQgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRoaXMuZ2VuKys7XG4gICAgdGhpcy5yZWFkeSA9IGZhbHNlO1xuICAgIHRoaXMubG9hZGluZ01vZGVsSWQgPSBtb2RlbElkO1xuICAgIHRoaXMuY2xlYXJSZWNlbnQoKTtcbiAgICB3b3JrZXIucG9zdE1lc3NhZ2Uoe1xuICAgICAgdHlwZTogXCJsb2FkXCIsXG4gICAgICBnZW46IHRoaXMuZ2VuLFxuICAgICAgbW9kZWxJZCxcbiAgICAgIHVybDogYC93YWtlL21vZGVscy8ke2VuY29kZVVSSUNvbXBvbmVudChtb2RlbElkKX0ub25ueGAsXG4gICAgICB0aHJlc2hvbGQsXG4gICAgICB3YXNtUGF0aHM6IFwiL29ydC9cIixcbiAgICB9KTtcbiAgfVxuXG4gIHNldFRocmVzaG9sZCh0aHJlc2hvbGQ6IG51bWJlcik6IHZvaWQge1xuICAgIHRoaXMuY3VycmVudFRocmVzaG9sZCA9IHRocmVzaG9sZDtcbiAgICB0aGlzLndvcmtlcj8ucG9zdE1lc3NhZ2UoeyB0eXBlOiBcImNvbmZpZ1wiLCB0aHJlc2hvbGQgfSk7XG4gIH1cblxuICBmZWVkKHNhbXBsZXM6IEludDE2QXJyYXkpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMucmVhZHkgfHwgIXRoaXMud29ya2VyKSByZXR1cm47XG4gICAgY29uc3Qgc2VxID0gKyt0aGlzLnNlcTtcbiAgICBjb25zdCBieXRlcyA9IG5ldyBVaW50OEFycmF5KHNhbXBsZXMuYnl0ZUxlbmd0aCk7XG4gICAgYnl0ZXMuc2V0KG5ldyBVaW50OEFycmF5KHNhbXBsZXMuYnVmZmVyLCBzYW1wbGVzLmJ5dGVPZmZzZXQsIHNhbXBsZXMuYnl0ZUxlbmd0aCkpO1xuICAgIHRoaXMucmVjZW50LnB1c2goeyBzZXEsIGJ5dGVzIH0pO1xuICAgIHRoaXMucmVjZW50Qnl0ZXMgKz0gYnl0ZXMuYnl0ZUxlbmd0aDtcbiAgICB3aGlsZSAodGhpcy5yZWNlbnRCeXRlcyA+IFJFQ0VOVF9NQVhfQllURVMgJiYgdGhpcy5yZWNlbnQubGVuZ3RoID4gMSkge1xuICAgICAgdGhpcy5yZWNlbnRCeXRlcyAtPSB0aGlzLnJlY2VudC5zaGlmdCgpIS5ieXRlcy5ieXRlTGVuZ3RoO1xuICAgIH1cbiAgICBjb25zdCBjb3B5ID0gbmV3IEludDE2QXJyYXkoc2FtcGxlcy5sZW5ndGgpO1xuICAgIGNvcHkuc2V0KHNhbXBsZXMpO1xuICAgIHRoaXMud29ya2VyLnBvc3RNZXNzYWdlKHsgdHlwZTogXCJmZWVkXCIsIGdlbjogdGhpcy5nZW4sIHNlcSwgcGNtOiBjb3B5LmJ1ZmZlciB9LCBbY29weS5idWZmZXJdKTtcbiAgfVxuXG4gIHJlc2V0KCk6IHZvaWQge1xuICAgIHRoaXMuY2xlYXJSZWNlbnQoKTtcbiAgICBpZiAoIXRoaXMud29ya2VyIHx8ICF0aGlzLnJlYWR5KSByZXR1cm47XG4gICAgdGhpcy5nZW4rKztcbiAgICB0aGlzLndvcmtlci5wb3N0TWVzc2FnZSh7IHR5cGU6IFwicmVzZXRcIiwgZ2VuOiB0aGlzLmdlbiB9KTtcbiAgfVxuXG4gIGRpc3Bvc2UoKTogdm9pZCB7XG4gICAgdGhpcy5nZW4rKztcbiAgICB0aGlzLnJlYWR5ID0gZmFsc2U7XG4gICAgdGhpcy5sb2FkZWRNb2RlbElkID0gbnVsbDtcbiAgICB0aGlzLmxvYWRpbmdNb2RlbElkID0gbnVsbDtcbiAgICB0aGlzLmNsZWFyUmVjZW50KCk7XG4gICAgaWYgKHRoaXMud29ya2VyKSB7XG4gICAgICB0aGlzLndvcmtlci5wb3N0TWVzc2FnZSh7IHR5cGU6IFwiZGlzcG9zZVwiLCBnZW46IHRoaXMuZ2VuIH0pO1xuICAgICAgdGhpcy53b3JrZXIudGVybWluYXRlKCk7XG4gICAgICB0aGlzLndvcmtlciA9IG51bGw7XG4gICAgfVxuICB9XG5cbiAgZ2V0IG1vZGVsSWQoKTogc3RyaW5nIHwgbnVsbCB7XG4gICAgcmV0dXJuIHRoaXMubG9hZGVkTW9kZWxJZCA/PyB0aGlzLmxvYWRpbmdNb2RlbElkO1xuICB9XG5cbiAgZ2V0IHRocmVzaG9sZCgpOiBudW1iZXIge1xuICAgIHJldHVybiB0aGlzLmN1cnJlbnRUaHJlc2hvbGQ7XG4gIH1cbn1cbiIsICIvLyBUaGUgd2ViIHN1cmZhY2U6IGEgZm91cnRoIGhvc3QgZm9yIHRoZSB2b2ljZSBjb3JlLCBhbmQgYSBwaG9uZS1mcmllbmRseSB3YXkgdG8gdXNlIGl0IGZvciB3b3JrLlxuLy8gSXQgbG9hZHMgdGhlIGRldiBzZXJ2ZXIncyBsYXRlc3QgYnVpbGQgYXQgZWFjaCBjYWxsLCBzbyBhbiBlZGl0IGluIHNyYy8gaXMgbGl2ZSBvbiB0aGUgbmV4dFxuLy8gY2FsbCwgYW5kIGtlZXBzIGV2ZXJ5IGNhbGwgYXMgYSB0cmFjZSB0aGUgcmVwbGF5IHZpZXcgKGFuZCBhbnkgb3RoZXIgaG9zdCkgY2FuIHJ1biBhZ2Fpbi5cbi8vXG4vLyBUaGUgaG9zdCdzIHBhcnQgaXMgc21hbGw6IHRoZSBtaWNyb3Bob25lIGFuZCBzcGVha2VyIChhdWRpby50cyksIHRoZSBtb2RlbCdzIHNvY2tldCB0aHJvdWdoIHRoZVxuLy8gc2VydmVyJ3MgcmVsYXksIEhlcm1lcyBhbmQgVDMgdGhyb3VnaCB0aGUgc2VydmVyLCBhbmQgdGhlIHNjcmVlbi4gVGhlIGNvcmUgZGVjaWRlcyB0aGUgcmVzdC5cbi8vXG4vLyBUeXBpbmcgd2l0aCBubyBjYWxsIG9uIHN0YXJ0cyBhIGNoYXQgaW5zdGVhZDogdGhlIHNhbWUgY29yZSB3aXRoIGBtZWRpdW06IFwidGV4dFwiYCwgd2hvc2UgcmVxdWVzdHNcbi8vIHRvIHRoZSB0ZXh0IG1vZGVsIGdvIHRocm91Z2ggdGhlIHNlcnZlcidzIC9nZW5lcmF0ZS4gVGFza3MsIGZvbGxvdy11cHMgYW5kIHRoZWlyIGNhcmRzIHdvcmsgYXNcbi8vIGluIGEgY2FsbC4gUHJlc3NpbmcgQ2FsbCBlbmRzIHRoZSBjaGF0IGFuZCBjYXJyaWVzIGl0cyBjb252ZXJzYXRpb24gb24gYnkgdm9pY2UuXG5cbmltcG9ydCB7IGNvbW1hbmRJbiB9IGZyb20gXCIuLi9zcmMvY29tbWFuZHMudHNcIjtcbmltcG9ydCB7IENhbGxBdWRpbywgYnl0ZXNUb0Jhc2U2NCB9IGZyb20gXCIuL2F1ZGlvLnRzXCI7XG5pbXBvcnQgeyBSZXBsYXkgfSBmcm9tIFwiLi9yZXBsYXkudHNcIjtcbmltcG9ydCB7IEF1dG9TY3JvbGxlciB9IGZyb20gXCIuL3Njcm9sbC50c1wiO1xuaW1wb3J0IHtcbiAgY2FuRm9sbG93VXBSZXN1bHQsXG4gIGZvcm1hdFNob3J0VGltZSxcbiAgbm9ybWFsaXplRGVuc2l0eSxcbiAgbm9ybWFsaXplU2lkZUZpbHRlcixcbiAgcGFyc2VQcmVmaXgsXG4gIHBsYWluUHJldmlldyxcbiAgcmVzb2x2ZU1vYmlsZUJhbm5lckZpbHRlcixcbiAgcmVzb2x2ZVNpZGVTZWN0aW9ucyxcbiAgc2hvdWxkQ2xlYXJVbnJlYWRSZXN1bHRzLFxuICB0eXBlIFNpZGVGaWx0ZXIsXG59IGZyb20gXCIuL3VpLnRzXCI7XG5pbXBvcnQgeyBXYWtlQ2xpZW50LCB0eXBlIFdha2VEZXRlY3Rpb25FdmVudCwgdHlwZSBXYWtlVGVsZW1ldHJ5IH0gZnJvbSBcIi4vd2FrZUNsaWVudC50c1wiO1xuXG5pbnRlcmZhY2UgQ29yZSB7XG4gIHZlcnNpb246IHN0cmluZztcbiAgZGVmYXVsdHMoKTogc3RyaW5nO1xuICBjcmVhdGUoY29uZmlnOiBzdHJpbmcsIHQ6IG51bWJlcik6IHN0cmluZztcbiAgcHVzaChpZDogbnVtYmVyLCBldmVudDogc3RyaW5nKTogc3RyaW5nO1xuICB0cmFjZShpZDogbnVtYmVyKTogc3RyaW5nO1xuICBkaXNwb3NlKGlkOiBudW1iZXIpOiB2b2lkO1xufVxudHlwZSBDb21tYW5kID0gUmVjb3JkPHN0cmluZywgYW55PiAmIHsgdHlwZTogc3RyaW5nIH07XG5pbnRlcmZhY2UgV2FrZU1vZGVsSW5mbyB7IGlkOiBzdHJpbmc7IGxhYmVsOiBzdHJpbmcgfVxuaW50ZXJmYWNlIFNlcnZlckNvbmZpZyB7IHJvdXRlOiBzdHJpbmc7IG1vZGVsOiBzdHJpbmc7IGNhcHRpb25zTW9kZWw/OiBzdHJpbmc7IHRleHRNb2RlbD86IHN0cmluZzsgdmVyc2lvbjogc3RyaW5nOyBoZXJtZXM6IGJvb2xlYW47IHQzOiBzdHJpbmdbXSB8IG51bGw7IHdha2VNb2RlbHM/OiBXYWtlTW9kZWxJbmZvW10gfVxuXG5jb25zdCAkID0gPFQgZXh0ZW5kcyBIVE1MRWxlbWVudCA9IEhUTUxFbGVtZW50PihpZDogc3RyaW5nKSA9PiBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChpZCkgYXMgVDtcbmNvbnN0IG5vdyA9ICgpID0+IHBlcmZvcm1hbmNlLm5vdygpIC8gMTAwMDtcbmNvbnN0IGNoZWNrZWQgPSAoaWQ6IHN0cmluZykgPT4gJDxIVE1MSW5wdXRFbGVtZW50PihpZCkuY2hlY2tlZDtcblxuLyoqIFRoZSBsYXRlc3QgYnVpbGQgZnJvbSB0aGUgZGV2IHNlcnZlciwgZXZhbHVhdGVkIGFmcmVzaDogYW4gZWRpdCBpbiBzcmMvIGlzIGluIHRoZSBuZXh0IGNhbGwuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbG9hZENvcmUodXJsID0gXCIvdm9pY2UtY29yZS5qc1wiKTogUHJvbWlzZTxDb3JlPiB7XG4gIGNvbnN0IHNvdXJjZSA9IGF3YWl0IChhd2FpdCBmZXRjaCh1cmwsIHsgY2FjaGU6IFwibm8tc3RvcmVcIiB9KSkudGV4dCgpO1xuICBjb25zdCBzY29wZTogeyBWb2ljZUNvcmU/OiBDb3JlIH0gPSB7fTtcbiAgbmV3IEZ1bmN0aW9uKFwiZ2xvYmFsVGhpc1wiLCBzb3VyY2UpKHNjb3BlKTtcbiAgaWYgKCFzY29wZS5Wb2ljZUNvcmUpIHRocm93IG5ldyBFcnJvcihcInRoZSBidW5kbGUgZGlkbid0IGRlZmluZSBWb2ljZUNvcmVcIik7XG4gIHJldHVybiBzY29wZS5Wb2ljZUNvcmU7XG59XG5cbi8vIFByZXNldHM6IGVhY2ggc3VyZmFjZSdzIHNldHRpbmdzIGFzIGl0cyBhcHAgd291bGQgc2V0IHRoZW0uXG5cbmNvbnN0IEZBS0VfVFYgPSBbXG4gIHsgbmFtZTogXCJ0dl92b2x1bWVcIiwgZGVzY3JpcHRpb246IFwiU2V0cyB0aGUgbGl2aW5nLXJvb20gVFYncyB2b2x1bWUsIDAgdG8gMTAwLlwiLCBwYXJhbWV0ZXJzOiB7IHR5cGU6IFwiT0JKRUNUXCIsIHByb3BlcnRpZXM6IHsgbGV2ZWw6IHsgdHlwZTogXCJJTlRFR0VSXCIgfSB9LCByZXF1aXJlZDogW1wibGV2ZWxcIl0gfSB9LFxuICB7IG5hbWU6IFwidHZfcGF1c2VcIiwgZGVzY3JpcHRpb246IFwiUGF1c2VzIG9yIHJlc3VtZXMgd2hhdCdzIHBsYXlpbmcgb24gdGhlIFRWLlwiLCBwYXJhbWV0ZXJzOiB7IHR5cGU6IFwiT0JKRUNUXCIsIHByb3BlcnRpZXM6IHsgcGF1c2U6IHsgdHlwZTogXCJCT09MRUFOXCIgfSB9IH0gfSxcbl07XG5cbmNvbnN0IFBSRVNFVFM6IFJlY29yZDxzdHJpbmcsIFJlY29yZDxzdHJpbmcsIHVua25vd24+PiA9IHtcbiAgd2ViOiB7IHBsYXRmb3JtOiBcIndlYlwiLCBkZXZpY2U6IFwiYnJvd3NlclwiLCBzdGFuZGJ5QWZ0ZXI6IDMwLCBoYW5kT2ZmOiBcIm5hbWVkXCIsIHN1cGVydmlzZTogdHJ1ZSwgdm9jYWJ1bGFyeTogW1wiSGVybWVzXCIsIFwiQmVudG9cIiwgXCJXb29kaG91c2VcIiwgXCJQZW5ueXdvcnRoXCIsIFwiVDNcIl0gfSxcbiAgXCJ3ZWIgd2FrZSB3b3JkXCI6IHtcbiAgICBwbGF0Zm9ybTogXCJ3ZWJcIiwgZGV2aWNlOiBcImJyb3dzZXJcIiwgc3RhbmRieUFmdGVyOiAyMCwgaGFuZ1VwQWZ0ZXI6IDEyMCwgaGFuZE9mZjogXCJuYW1lZFwiLCBzdXBlcnZpc2U6IHRydWUsXG4gICAgYXR0ZW50aW9uOiB7IG1vZGU6IFwid2luZG93XCIsIGFmdGVyV2FrZTogOCwgd2luZG93OiA1LCBhZnRlclF1ZXN0aW9uOiAxMCwgYWZ0ZXJIYW5kT2ZmOiAzLCBhZnRlckFubm91bmNlbWVudDogMCB9LFxuICAgIHZvY2FidWxhcnk6IFtcIkhlcm1lc1wiLCBcIkJlbnRvXCIsIFwiV29vZGhvdXNlXCIsIFwiUGVubnl3b3J0aFwiLCBcIlQzXCJdLFxuICB9LFxuICBhbmRyb2lkOiB7IHBsYXRmb3JtOiBcIkFuZHJvaWRcIiwgZGV2aWNlOiBcInBob25lXCIsIHN0YW5kYnlBZnRlcjogMjAgfSxcbiAgXCJhbmRyb2lkIHdha2Ugd29yZFwiOiB7IHBsYXRmb3JtOiBcIkFuZHJvaWRcIiwgZGV2aWNlOiBcInBob25lXCIsIHN0YW5kYnlBZnRlcjogMjAsIGhhbmdVcEFmdGVyOiAxNSB9LFxuICBtYWNvczogeyBwbGF0Zm9ybTogXCJtYWNPU1wiLCBkZXZpY2U6IFwiTWFjXCIsIHN0YW5kYnlBZnRlcjogMjAgfSxcbiAgZWNobzoge1xuICAgIHBsYXRmb3JtOiBcIkVjaG9cIiwgZGV2aWNlOiBcInNwZWFrZXJcIiwgaGFuZ1VwQWZ0ZXI6IDYsIHN0YW5kYnlBZnRlcjogOCwgZWFyY29uczogdHJ1ZSwgdm9jYWJ1bGFyeTogW1wiSGVybWVzXCIsIFwiQmVudG9cIiwgXCJXb29kaG91c2VcIl0sXG4gICAgbWljOiB7IHdoaWxlU3BlYWtpbmc6IFwid2FrZVwiLCBnYWluRGI6IDAgfSwgaG9zdFRvb2xzOiBGQUtFX1RWLFxuICB9LFxufTtcblxuLy8gU3RhdGUuXG5cbmNvbnN0IGF1ZGlvID0gbmV3IENhbGxBdWRpbygpO1xubGV0IHNlcnZlcjogU2VydmVyQ29uZmlnO1xubGV0IGNvcmU6IENvcmUgfCBudWxsID0gbnVsbDtcbmxldCBjYWxsSWQgPSAwO1xuLyoqIE1vbm90b25pYyBwZXItcGFnZSBzZXNzaW9uIGlkICh1bmxpa2UgY29yZSdzIGNhbGxJZC90YXNrSWQsIHdoaWNoIHJlc3RhcnQgYWZ0ZXIgbG9hZENvcmUoKSkuICovXG5sZXQgc2Vzc2lvblNlcSA9IDA7XG5sZXQgYWN0aXZlU2Vzc2lvbiA9IDA7XG5sZXQgY2FsbE5hbWUgPSBcIlwiO1xubGV0IHRpY2tlciA9IDA7XG5sZXQgdHJhY2VUaW1lciA9IDA7XG5sZXQgc3RhcnRlZEF0ID0gbm93KCk7XG5jb25zdCBzb2NrZXRzID0gbmV3IE1hcDxudW1iZXIsIFdlYlNvY2tldD4oKTtcbi8qKiBUaGUgc29ja2V0cyB0byB0aGUgdHJhbnNjcmlwdGlvbiBtb2RlbDogdGhlaXIgYXVkaW8gaXMgdGhlIG1vZGVsJ3MgYWdhaW4sIHNvIGl0IGlzbid0IGNvdW50ZWQgb3IgbG9nZ2VkIHR3aWNlLiAqL1xuY29uc3QgY2FwdGlvblNvY2tldHMgPSBuZXcgU2V0PG51bWJlcj4oKTtcbmNvbnN0IHJ1bnMgPSBuZXcgTWFwPHN0cmluZywgeyBhYm9ydDogQWJvcnRDb250cm9sbGVyOyBhZ2VudDogc3RyaW5nOyB0YXNrSWQ6IHN0cmluZyB9PigpO1xuaW50ZXJmYWNlIFRhc2tWaWV3IHsgYzogQ29tbWFuZDsgc2luY2U6IG51bWJlcjsgZW5kZWQ6IG51bWJlciB8IG51bGw7IHRocmVhZD86IHN0cmluZzsgcmVzdWx0SWQ/OiBzdHJpbmc7IGFwcHJvdmFsPzogeyBjb21tYW5kOiBzdHJpbmcgfSB9XG5jb25zdCB0YXNrcyA9IG5ldyBNYXA8c3RyaW5nLCBUYXNrVmlldz4oKTtcbmludGVyZmFjZSBSZXN1bHRFbnRyeSB7XG4gIGlkOiBzdHJpbmc7XG4gIGFnZW50OiBzdHJpbmc7XG4gIGxhYmVsOiBzdHJpbmc7XG4gIHRleHQ6IHN0cmluZztcbiAgZmFpbGVkOiBib29sZWFuO1xuICB0YXNrSWQ/OiBzdHJpbmc7XG4gIHNlc3Npb25JZDogbnVtYmVyO1xuICBjYXJkOiBIVE1MRWxlbWVudDtcbiAgaGVhZDogSFRNTEJ1dHRvbkVsZW1lbnQ7XG4gIGJvZHk6IEhUTUxFbGVtZW50O1xuICBtb3JlQnRuOiBIVE1MQnV0dG9uRWxlbWVudDtcbiAgZm9sbG93QnRuPzogSFRNTEJ1dHRvbkVsZW1lbnQ7XG4gIHJlZlJvdzogSFRNTEJ1dHRvbkVsZW1lbnQ7XG59XG5jb25zdCByZXN1bHRzID0gbmV3IE1hcDxzdHJpbmcsIFJlc3VsdEVudHJ5PigpO1xubGV0IG5leHRSZXN1bHRTZXEgPSAwO1xubGV0IHNpZGVGaWx0ZXI6IFNpZGVGaWx0ZXIgPSBcImFsbFwiO1xubGV0IHVucmVhZE1vYmlsZVJlc3VsdHMgPSAwO1xubGV0IGZsYXNoVGltZXIgPSAwO1xubGV0IGVhcmxpZXJBY3RpdmVDb3VudCA9IDA7XG5sZXQgZWFybGllcldhaXRpbmdDb3VudCA9IDA7XG5sZXQgY291bnRzID0geyBtaWM6IDAsIHBsYXk6IDAsIHNlbnQ6IDAgfTtcbmxldCBmYWtlVHZMZXZlbCA9IDE1O1xubGV0IGNvcmVTdGF0dXMgPSBcImlkbGVcIjtcbmxldCBtdXRlZCA9IGZhbHNlO1xubGV0IGhvbGRpbmcgPSBmYWxzZTtcbmxldCB3YWtlTG9jazogeyByZWxlYXNlKCk6IFByb21pc2U8dm9pZD4gfSB8IG51bGwgPSBudWxsO1xuLyoqIFdha2Ugd29yZCBsb29wIHN0YXRlOiBhcm1lZCBiZXR3ZWVuIGNhbGxzLCByZXF1ZXN0ZWQgYnkgY29yZSB3aGlsZSBkb3JtYW50L3NwZWFraW5nLCBvciBtaWQtaGFuZG9mZi4gKi9cbmxldCB3YWtlQXJtZWQgPSBmYWxzZTtcbmxldCBhcm1HZW4gPSAwO1xubGV0IGNvcmVXYW50c1dha2UgPSBmYWxzZTtcbmxldCBjYWxsV2hpbGVTcGVha2luZyA9IFwic2VuZFwiO1xubGV0IHdha2VMb2FkaW5nID0gZmFsc2U7XG5sZXQgd2FrZVN0YXJ0aW5nID0gZmFsc2U7XG5sZXQgc3RhcnRpbmdDYWxsID0gZmFsc2U7XG5sZXQgb3BlbmluZ0NodW5rczogVWludDhBcnJheVtdID0gW107XG5sZXQgb3BlbmluZ0J5dGVzID0gMDtcbmNvbnN0IE9QRU5JTkdfTUFYX0JZVEVTID0gMTAgKiAzMl8wMDA7XG5sZXQgd2FrZUxhc3RUZWw6IFdha2VUZWxlbWV0cnkgfCBudWxsID0gbnVsbDtcbi8qKiBXaGF0IHRoZSBzZXNzaW9uIG9uIHNjcmVlbiBpczogYSB2b2ljZSBjYWxsLCBvciBhIHR5cGVkIGNoYXQgKHRoZSBjb3JlJ3MgbWVkaXVtIFwidGV4dFwiKS4gKi9cbmxldCBtZWRpdW06IFwidm9pY2VcIiB8IFwidGV4dFwiID0gXCJ2b2ljZVwiO1xuLyoqIEEgY2hhdCdzIG1vZGVsIGlzIHdyaXRpbmcgaXRzIGFuc3dlci4gKi9cbmxldCB0aGlua2luZyA9IGZhbHNlO1xuLyoqIEEgY2hhdCdzIHJlcXVlc3RzIHRvIHRoZSB0ZXh0IG1vZGVsIHRoYXQgYXJlIHVuZGVyIHdheS4gKi9cbmNvbnN0IHJlcXVlc3RzID0gbmV3IE1hcDxudW1iZXIsIEFib3J0Q29udHJvbGxlcj4oKTtcbi8qKiBUaGUgbGFzdCBzZXNzaW9uIHdpbmRpbmcgZG93biAoaXRzIHRyYWNlIHNhdmVkLCB0aGUgY29yZSdzIGNhbGwgZGlzcG9zZWQpOiB0aGUgbmV4dCBzdGFydHMgYWZ0ZXIgaXQuICovXG5sZXQgZW5kaW5nOiBQcm9taXNlPHZvaWQ+ID0gUHJvbWlzZS5yZXNvbHZlKCk7XG5cbi8vIFRoZSBjb252ZXJzYXRpb24sIGtlcHQgc28gYSBuZXcgY2FsbCBjYW4gY2Fycnkgb24gZnJvbSBpdCAodGhlIGNvcmUncyBgaGlzdG9yeWAsIHJlY2FwcGVkIHRvIHRoZSBtb2RlbCkuXG5pbnRlcmZhY2UgQ2hhdExpbmUgeyByb2xlOiBcInVzZXJcIiB8IFwiYXNzaXN0YW50XCI7IHNwZWFrZXI/OiBzdHJpbmc7IHRleHQ6IHN0cmluZyB9XG5jb25zdCBISVNUT1JZID0gXCJ2b2ljZS5oaXN0b3J5XCI7XG5jb25zdCBISVNUT1JZX01BWF9BR0UgPSAxMiAqIDM2MDAgKiAxMDAwO1xubGV0IGNoYXQ6IENoYXRMaW5lW10gPSBbXTtcbi8qKiBUaGUgY29yZSdzIG51bWJlciBmb3IgdGhlIGxpbmUgdGhlIGxhc3Qgd29yZHMgd2VyZSByZW1lbWJlcmVkIG9uLCB1bnRpbCBzb21ldGhpbmcgZWxzZSBpcy4gKi9cbmxldCBsYXN0TGluZTogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5cbmZ1bmN0aW9uIHJlbWVtYmVyKHJvbGU6IFwidXNlclwiIHwgXCJhc3Npc3RhbnRcIiwgdGV4dDogc3RyaW5nLCBzcGVha2VyPzogc3RyaW5nLCBqb2luID0gZmFsc2UpIHtcbiAgY29uc3QgbGFzdCA9IGNoYXQuYXQoLTEpO1xuICBpZiAoam9pbiAmJiBsYXN0ICYmIGxhc3Qucm9sZSA9PT0gcm9sZSAmJiBsYXN0LnNwZWFrZXIgPT09IHNwZWFrZXIpIGxhc3QudGV4dCArPSB0ZXh0O1xuICBlbHNlIGNoYXQucHVzaChzcGVha2VyID8geyByb2xlLCBzcGVha2VyLCB0ZXh0IH0gOiB7IHJvbGUsIHRleHQgfSk7XG4gIGlmIChjaGF0Lmxlbmd0aCA+IDIwMCkgY2hhdC5zcGxpY2UoMCwgY2hhdC5sZW5ndGggLSAyMDApO1xuICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShISVNUT1JZLCBKU09OLnN0cmluZ2lmeSh7IGF0OiBEYXRlLm5vdygpLCBjaGF0IH0pKTtcbn1cblxuZnVuY3Rpb24gc2F2ZWRIaXN0b3J5KCk6IENoYXRMaW5lW10ge1xuICB0cnkge1xuICAgIGNvbnN0IHNhdmVkID0gSlNPTi5wYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShISVNUT1JZKSA/PyBcIm51bGxcIik7XG4gICAgcmV0dXJuIHNhdmVkICYmIERhdGUubm93KCkgLSBzYXZlZC5hdCA8IEhJU1RPUllfTUFYX0FHRSAmJiBBcnJheS5pc0FycmF5KHNhdmVkLmNoYXQpID8gc2F2ZWQuY2hhdCA6IFtdO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gW107XG4gIH1cbn1cblxuLyoqIFR3by1ub3RlIGNoaW1lLCBQQ00xNiBtb25vIGF0IDI0IGtIeiwgYmFzZTY0LiAqL1xuZnVuY3Rpb24gdHdvTm90ZVRvbmUoZjE6IG51bWJlciwgZjI6IG51bWJlciwgbm90ZVNlYzogbnVtYmVyLCBhbXA6IG51bWJlcik6IHN0cmluZyB7XG4gIGNvbnN0IHJhdGUgPSAyNDAwMCwgbiA9IE1hdGgucm91bmQocmF0ZSAqIG5vdGVTZWMgKiAyKSwgaGFsZiA9IE1hdGgucm91bmQocmF0ZSAqIG5vdGVTZWMpLCBvdXQgPSBuZXcgSW50MTZBcnJheShuKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBuOyBpKyspIHtcbiAgICBjb25zdCBmaXJzdCA9IGkgPCBoYWxmO1xuICAgIGNvbnN0IHQgPSBpIC8gcmF0ZSwgZiA9IGZpcnN0ID8gZjEgOiBmMiwgbG9jYWwgPSBmaXJzdCA/IHQgOiB0IC0gbm90ZVNlYztcbiAgICBjb25zdCBlbnYgPSBNYXRoLm1pbigxLCBsb2NhbCAqIDYwLCAobm90ZVNlYyAtIGxvY2FsKSAqIDYwKTtcbiAgICBvdXRbaV0gPSBNYXRoLnJvdW5kKE1hdGguc2luKDIgKiBNYXRoLlBJICogZiAqIHQpICogTWF0aC5tYXgoMCwgZW52KSAqIGFtcCk7XG4gIH1cbiAgcmV0dXJuIGJ5dGVzVG9CYXNlNjQobmV3IFVpbnQ4QXJyYXkob3V0LmJ1ZmZlcikpO1xufVxuXG4vKiogVHdvIHJpc2luZyBub3Rlczogc29tZXRoaW5nIG9uIHRoZSBzY3JlZW4gbmVlZHMgdGhlIHVzZXIuICovXG5jb25zdCBBUFBST1ZBTF9UT05FID0gdHdvTm90ZVRvbmUoNjYwLCA4ODAsIDAuMTYsIDYwMDApO1xuLyoqIENyaXNwIHJpc2luZyBjaGltZTogdGhlIHdha2Ugd29yZCBmaXJlZCAoc3RhcnQgc2lnbmFsKS4gKi9cbmNvbnN0IFdBS0VfVE9ORSA9IHR3b05vdGVUb25lKDU4Ny4zMywgODgwLCAwLjExLCA1NTAwKTtcbi8qKiBTb2Z0IGZhbGxpbmcgY2hpbWU6IHRoZSBhdHRlbnRpb24gd2luZG93IGNsb3NlZCBhbmQgdGhlIGNhbGwgd2VudCBkb3JtYW50IChlbmQgc2lnbmFsKS4gKi9cbmNvbnN0IFNMRUVQX1RPTkUgPSB0d29Ob3RlVG9uZSg2NTkuMjUsIDQ5My44OCwgMC4xMSwgMzQwMCk7XG5cbi8vIExhdGVuY3k6IHRoZSBuZXR3b3JrJ3Mgcm91bmQgdHJpcCwgYW5kIGhvdyBsb25nIGFmdGVyIHRoZSB1c2VyIHN0b3BzIHRhbGtpbmcgdGhlIHJlcGx5IHN0YXJ0cy5cbmNvbnN0IG1ldHJpY3MgPSB7IHJ0dDogW10gYXMgbnVtYmVyW10sIHJlcGx5OiBbXSBhcyBudW1iZXJbXSwgbGFzdFZvaWNlOiAwLCBsYXN0UGxheTogMCwgcmVwbGllZDogdHJ1ZSB9O1xuXG5mdW5jdGlvbiBtZWRpYW4oeHM6IG51bWJlcltdKTogbnVtYmVyIHwgbnVsbCB7XG4gIGlmICh4cy5sZW5ndGggPT09IDApIHJldHVybiBudWxsO1xuICBjb25zdCBzID0gWy4uLnhzXS5zb3J0KChhLCBiKSA9PiBhIC0gYik7XG4gIHJldHVybiBzW01hdGguZmxvb3Iocy5sZW5ndGggLyAyKV07XG59XG5cbmZ1bmN0aW9uIHNob3dNZXRyaWNzKCkge1xuICBjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgcnR0ID0gbWVkaWFuKG1ldHJpY3MucnR0KTtcbiAgaWYgKHJ0dCAhPSBudWxsKSBwYXJ0cy5wdXNoKGAke01hdGgucm91bmQocnR0ICogMTAwMCl9IG1zYCk7XG4gIGNvbnN0IHJlcGx5ID0gbWVkaWFuKG1ldHJpY3MucmVwbHkpO1xuICBpZiAocmVwbHkgIT0gbnVsbCkgcGFydHMucHVzaChgcmVwbHkgJHttZXRyaWNzLnJlcGx5LmF0KC0xKSEudG9GaXhlZCgxKX1zICgke3JlcGx5LnRvRml4ZWQoMSl9cyBtZWQpYCk7XG4gIGNvbnN0IG91dCA9IGF1ZGlvLm91dHB1dExhdGVuY3k7XG4gIGlmIChvdXQgIT0gbnVsbCkgcGFydHMucHVzaChgYXVkaW8gJHtNYXRoLnJvdW5kKG91dCAqIDEwMDApfSBtc2ApO1xuICBsZXQgYnVmZmVyZWQgPSAwO1xuICBmb3IgKGNvbnN0IHdzIG9mIHNvY2tldHMudmFsdWVzKCkpIGJ1ZmZlcmVkICs9IHdzLmJ1ZmZlcmVkQW1vdW50O1xuICBpZiAoYnVmZmVyZWQgPiAzMl8wMDApIHBhcnRzLnB1c2goYHVwbG9hZCArJHsoYnVmZmVyZWQgLyAzMl8wMDApLnRvRml4ZWQoMSl9c2ApO1xuICAkKFwibWV0cmljc1wiKS50ZXh0Q29udGVudCA9IHBhcnRzLmpvaW4oXCIgXHUwMEI3IFwiKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcGluZygpIHtcbiAgY29uc3QgdCA9IG5vdygpO1xuICB0cnkge1xuICAgIGF3YWl0IGZldGNoKFwiL3BpbmdcIiwgeyBjYWNoZTogXCJuby1zdG9yZVwiIH0pO1xuICAgIG1ldHJpY3MucnR0LnB1c2gobm93KCkgLSB0KTtcbiAgICBpZiAobWV0cmljcy5ydHQubGVuZ3RoID4gMTIpIG1ldHJpY3MucnR0LnNoaWZ0KCk7XG4gIH0gY2F0Y2gge31cbiAgc2hvd01ldHJpY3MoKTtcbn1cblxuLy8gVGhlbWUgJiBkZW5zaXR5LlxuXG5mdW5jdGlvbiBhcHBseVRoZW1lKGNob2ljZTogc3RyaW5nKSB7XG4gIGNvbnN0IHJvb3QgPSBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQ7XG4gIGlmIChjaG9pY2UgPT09IFwiZGFya1wiIHx8IGNob2ljZSA9PT0gXCJsaWdodFwiKSByb290LmRhdGFzZXQudGhlbWUgPSBjaG9pY2U7XG4gIGVsc2UgZGVsZXRlIHJvb3QuZGF0YXNldC50aGVtZTtcbiAgY29uc3QgZGFyayA9IGNob2ljZSA9PT0gXCJkYXJrXCIgfHwgKGNob2ljZSAhPT0gXCJsaWdodFwiICYmIG1hdGNoTWVkaWEoXCIocHJlZmVycy1jb2xvci1zY2hlbWU6IGRhcmspXCIpLm1hdGNoZXMpO1xuICBjb25zdCBtZXRhID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJ0aGVtZS1jb2xvclwiKTtcbiAgaWYgKG1ldGEpIG1ldGEuc2V0QXR0cmlidXRlKFwiY29udGVudFwiLCBkYXJrID8gXCIjMGUwZjBmXCIgOiBcIiNmNmY1ZjBcIik7XG4gIGZvciAoY29uc3QgYnRuIG9mIEFycmF5LmZyb20oZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MQnV0dG9uRWxlbWVudD4oXCIjdGhlbWUtcGlja2VyIGJ1dHRvblwiKSkpIHtcbiAgICBidG4uY2xhc3NMaXN0LnRvZ2dsZShcIm9uXCIsIGJ0bi5kYXRhc2V0LnRoZW1lID09PSAoY2hvaWNlIHx8IFwic3lzdGVtXCIpKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBhcHBseURlbnNpdHkoY2hvaWNlOiBzdHJpbmcgfCBudWxsKSB7XG4gIGNvbnN0IGRlbnNpdHkgPSBub3JtYWxpemVEZW5zaXR5KGNob2ljZSk7XG4gIGNvbnN0IHJvb3QgPSBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQ7XG4gIGlmIChkZW5zaXR5ID09PSBcImNvbWZvcnRhYmxlXCIpIHJvb3QuZGF0YXNldC5kZW5zaXR5ID0gXCJjb21mb3J0YWJsZVwiO1xuICBlbHNlIGRlbGV0ZSByb290LmRhdGFzZXQuZGVuc2l0eTtcbiAgZm9yIChjb25zdCBidG4gb2YgQXJyYXkuZnJvbShkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxCdXR0b25FbGVtZW50PihcIiNkZW5zaXR5LXBpY2tlciBidXR0b25cIikpKSB7XG4gICAgYnRuLmNsYXNzTGlzdC50b2dnbGUoXCJvblwiLCBidG4uZGF0YXNldC5kZW5zaXR5ID09PSBkZW5zaXR5KTtcbiAgfVxuICByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKCkgPT4gdXBkYXRlQWxsUmVzdWx0Q2xhbXBpbmcoKSk7XG59XG5cbi8vIFRoZSBzY3JlZW4uXG5cbmZ1bmN0aW9uIHNldENhbGxCdXR0b24obGl2ZTogYm9vbGVhbikge1xuICBjb25zdCBidG4gPSAkPEhUTUxCdXR0b25FbGVtZW50PihcImNhbGxcIik7XG4gIGJ0bi5jbGFzc0xpc3QudG9nZ2xlKFwibGl2ZVwiLCBsaXZlKTtcbiAgY29uc3QgbGFiZWwgPSBidG4ucXVlcnlTZWxlY3RvcihcIi5jYWxsLWxhYmVsXCIpO1xuICBpZiAobGFiZWwpIGxhYmVsLnRleHRDb250ZW50ID0gbGl2ZSA/IFwiSGFuZyB1cFwiIDogXCJDYWxsXCI7XG59XG5cbmZ1bmN0aW9uIHN5bmNSZXN1bWVCdXR0b25zKHNob3c6IGJvb2xlYW4pIHtcbiAgJChcInJlc3VtZVwiKS5oaWRkZW4gPSAhc2hvdztcbiAgJChcImhlcm8tcmVzdW1lXCIpLmhpZGRlbiA9ICFzaG93O1xufVxuXG5mdW5jdGlvbiBzeW5jQ29tcG9zZXIoKSB7XG4gIGNvbnN0IGlucHV0ID0gJDxIVE1MSW5wdXRFbGVtZW50PihcInRleHRcIik7XG4gIGNvbnN0IHRyaW1tZWQgPSBpbnB1dC52YWx1ZS50cmltKCk7XG4gICQoXCJzZW5kYnRuXCIpLmNsYXNzTGlzdC50b2dnbGUoXCJyZWFkeVwiLCB0cmltbWVkLmxlbmd0aCA+IDApO1xuICBjb25zdCBwYXJzZWQgPSBwYXJzZVByZWZpeCh0cmltbWVkKTtcbiAgJChcIm1vZGUtd3JhcFwiKS5kYXRhc2V0Lm1vZGUgPSBwYXJzZWQubW9kZSA/PyAkPEhUTUxTZWxlY3RFbGVtZW50PihcIm1vZGVcIikudmFsdWU7XG59XG5cbmZ1bmN0aW9uIGZvcm1hdENsb2NrKHNlY29uZHM6IG51bWJlcik6IHN0cmluZyB7XG4gIGNvbnN0IHRvdGFsID0gTWF0aC5tYXgoMCwgTWF0aC5mbG9vcihzZWNvbmRzKSk7XG4gIGNvbnN0IGggPSBNYXRoLmZsb29yKHRvdGFsIC8gMzYwMCk7XG4gIGNvbnN0IG0gPSBNYXRoLmZsb29yKCh0b3RhbCAlIDM2MDApIC8gNjApO1xuICBjb25zdCBzID0gdG90YWwgJSA2MDtcbiAgY29uc3QgcGFkID0gKG46IG51bWJlcikgPT4gU3RyaW5nKG4pLnBhZFN0YXJ0KDIsIFwiMFwiKTtcbiAgcmV0dXJuIGggPiAwID8gYCR7aH06JHtwYWQobSl9OiR7cGFkKHMpfWAgOiBgJHtwYWQobSl9OiR7cGFkKHMpfWA7XG59XG5cbmNvbnN0IFZJWl9XRUlHSFRTID0gWzAuNDgsIDAuODYsIDEuMCwgMC43OCwgMC40NF07XG5mdW5jdGlvbiB1cGRhdGVWaXN1YWxpemVyKG1vZGU6IHN0cmluZywgbGV2ZWw6IG51bWJlcikge1xuICBjb25zdCB2aXogPSAkKFwidml6XCIpO1xuICB2aXouZGF0YXNldC5tb2RlID0gbW9kZTtcbiAgY29uc3QgYmFycyA9IHZpei5jaGlsZHJlbjtcbiAgaWYgKG1vZGUgPT09IFwibGlzdGVuaW5nXCIgfHwgbW9kZSA9PT0gXCJ3b3JraW5nXCIpIHtcbiAgICBjb25zdCBlbmVyZ3kgPSBNYXRoLm1pbigxLCBsZXZlbCAqIDE0KTtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGJhcnMubGVuZ3RoOyBpKyspIHtcbiAgICAgIGNvbnN0IGggPSAwLjI0ICsgZW5lcmd5ICogVklaX1dFSUdIVFNbaV0gKiAwLjc2O1xuICAgICAgKGJhcnNbaV0gYXMgSFRNTEVsZW1lbnQpLnN0eWxlLnRyYW5zZm9ybSA9IGBzY2FsZVkoJHtoLnRvRml4ZWQoMil9KWA7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYmFycy5sZW5ndGg7IGkrKykgKGJhcnNbaV0gYXMgSFRNTEVsZW1lbnQpLnN0eWxlLnRyYW5zZm9ybSA9IFwiXCI7XG4gIH1cbn1cblxuLyoqIEEgc3lzdGVtIG5vdGlmaWNhdGlvbiB3aGlsZSB0aGUgcGFnZSBpcyBoaWRkZW46IGEgdGFzayBmaW5pc2hlZCwgb3Igb25lIG5lZWRzIHRoZSB1c2VyLiAqL1xuZnVuY3Rpb24gbm90aWZ5KHRpdGxlOiBzdHJpbmcsIGJvZHk6IHN0cmluZykge1xuICBpZiAoIWRvY3VtZW50LmhpZGRlbiB8fCAhKFwiTm90aWZpY2F0aW9uXCIgaW4gd2luZG93KSB8fCBOb3RpZmljYXRpb24ucGVybWlzc2lvbiAhPT0gXCJncmFudGVkXCIpIHJldHVybjtcbiAgdHJ5IHtcbiAgICBjb25zdCBuID0gbmV3IE5vdGlmaWNhdGlvbih0aXRsZSwgeyBib2R5OiBib2R5LnNsaWNlKDAsIDE4MCksIGljb246IFwiL3dlYi9pY29ucy9pY29uLTE5Mi5wbmdcIiwgdGFnOiB0aXRsZSB9KTtcbiAgICBuLm9uY2xpY2sgPSAoKSA9PiB7IHdpbmRvdy5mb2N1cygpOyBuLmNsb3NlKCk7IH07XG4gIH0gY2F0Y2gge1xuICAgIC8vIFBob25lcyB3YW50IG5vdGlmaWNhdGlvbnMgZnJvbSBhIHNlcnZpY2Ugd29ya2VyOyB0aGUgcGFnZSBoYXMgbm9uZS5cbiAgfVxufVxuXG5mdW5jdGlvbiB0b2FzdCh0ZXh0OiBzdHJpbmcpIHtcbiAgY29uc3QgdCA9ICQoXCJ0b2FzdFwiKTtcbiAgdC50ZXh0Q29udGVudCA9IHRleHQ7XG4gIHQuY2xhc3NMaXN0LmFkZChcIm9uXCIpO1xuICBjbGVhclRpbWVvdXQoKHRvYXN0IGFzIGFueSkudGltZXIpO1xuICAodG9hc3QgYXMgYW55KS50aW1lciA9IHNldFRpbWVvdXQoKCkgPT4gdC5jbGFzc0xpc3QucmVtb3ZlKFwib25cIiksIDE4MDApO1xufVxuXG5mdW5jdGlvbiBsb2coa2luZDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcsIGNscyA9IFwiXCIpIHtcbiAgY29uc3QgcGFuZSA9ICQoXCJsb2dcIik7XG4gIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvdy5jbGFzc05hbWUgPSBgcm93ICR7Y2xzfWA7XG4gIHJvdy5pbm5lckhUTUwgPSBgPHNwYW4gY2xhc3M9XCJ0XCI+JHsobm93KCkgLSBzdGFydGVkQXQpLnRvRml4ZWQoMil9PC9zcGFuPjxzcGFuIGNsYXNzPVwia1wiPiR7a2luZH08L3NwYW4+YDtcbiAgY29uc3QgYm9keSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBib2R5LmNsYXNzTmFtZSA9IFwiYlwiO1xuICBib2R5LnRleHRDb250ZW50ID0gdGV4dDtcbiAgcm93LmFwcGVuZChib2R5KTtcbiAgY29uc3Qgc3RpY2sgPSBwYW5lLnNjcm9sbFRvcCArIHBhbmUuY2xpZW50SGVpZ2h0ID49IHBhbmUuc2Nyb2xsSGVpZ2h0IC0gMzA7XG4gIHBhbmUuYXBwZW5kKHJvdyk7XG4gIHdoaWxlIChwYW5lLmNoaWxkRWxlbWVudENvdW50ID4gMzAwMCkgcGFuZS5maXJzdEVsZW1lbnRDaGlsZCEucmVtb3ZlKCk7XG4gIGlmIChzdGljaykgcGFuZS5zY3JvbGxUb3AgPSBwYW5lLnNjcm9sbEhlaWdodDtcbn1cblxuLyoqIEEgZnJhbWUgZnJvbSBvciB0byBHZW1pbmksIHdpdGggYXVkaW8gY3V0IG91dCwgc2hvcnQgZW5vdWdoIHRvIHJlYWQuICovXG5mdW5jdGlvbiBicmllZihkYXRhOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gZGF0YS5yZXBsYWNlKC9cImRhdGFcIjpcIltBLVphLXowLTkrLz1dezQwLH1cIi9nLCAobSkgPT4gYFwiZGF0YVwiOlwiXHUyMDI2JHtNYXRoLnJvdW5kKCgobS5sZW5ndGggLSA5KSAqIDMpIC8gNCl9IGJ5dGVzXCJgKS5zbGljZSgwLCA2MDApO1xufVxuXG5mdW5jdGlvbiBlc2NhcGVIdG1sKHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiB0ZXh0LnJlcGxhY2UoL1smPD5cIiddL2csIChjKSA9PiAoeyBcIiZcIjogXCImYW1wO1wiLCBcIjxcIjogXCImbHQ7XCIsIFwiPlwiOiBcIiZndDtcIiwgJ1wiJzogXCImcXVvdDtcIiwgXCInXCI6IFwiJiMzOTtcIiB9KVtjXSEpO1xufVxuXG4vKiogQSBsaXR0bGUgTWFya2Rvd24sIHNhZmVseTogY29kZSwgYm9sZCwgbGlua3MsIGxpc3RzIGFuZCBoZWFkaW5ncywgdGhlIHJlc3QgYXMgdGV4dC4gKi9cbmZ1bmN0aW9uIG1hcmtkb3duKHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGJsb2NrcyA9IGVzY2FwZUh0bWwodGV4dC50cmltKCkpLnNwbGl0KC9gYGAoPzpcXHcrKT9cXG4/Lyk7XG4gIHJldHVybiBibG9ja3MubWFwKChibG9jaywgaSkgPT4ge1xuICAgIGlmIChpICUgMiA9PT0gMSkgcmV0dXJuIGA8cHJlPjxjb2RlPiR7YmxvY2sucmVwbGFjZSgvXFxuJC8sIFwiXCIpfTwvY29kZT48L3ByZT5gO1xuICAgIGNvbnN0IGlubGluZSA9IChzOiBzdHJpbmcpID0+IHNcbiAgICAgIC5yZXBsYWNlKC9gKFteYFxcbl0rKWAvZywgXCI8Y29kZT4kMTwvY29kZT5cIilcbiAgICAgIC5yZXBsYWNlKC9cXCpcXCooW14qXFxuXSspXFwqXFwqL2csIFwiPGI+JDE8L2I+XCIpXG4gICAgICAucmVwbGFjZSgvXFxbKFteXFxdXFxuXSspXFxdXFwoKGh0dHBzPzpcXC9cXC9bXlxccyldKylcXCkvZywgJzxhIGhyZWY9XCIkMlwiIHRhcmdldD1cIl9ibGFua1wiIHJlbD1cIm5vb3BlbmVyXCI+JDE8L2E+JylcbiAgICAgIC5yZXBsYWNlKC8oXnxbXFxzKF0pKGh0dHBzPzpcXC9cXC9bXlxcczwpXSspL2csICckMTxhIGhyZWY9XCIkMlwiIHRhcmdldD1cIl9ibGFua1wiIHJlbD1cIm5vb3BlbmVyXCI+JDI8L2E+Jyk7XG4gICAgbGV0IGh0bWwgPSBcIlwiO1xuICAgIGxldCBsaXN0OiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICBmb3IgKGNvbnN0IHJhdyBvZiBibG9jay5zcGxpdChcIlxcblwiKSkge1xuICAgICAgY29uc3QgaXRlbSA9IHJhdy5tYXRjaCgvXlxccyooPzpbLSpcdTIwMjJdfChcXGQrKVsuKV0pXFxzKyguKikkLyk7XG4gICAgICBpZiAoaXRlbSkge1xuICAgICAgICBjb25zdCBraW5kID0gaXRlbVsxXSA/IFwib2xcIiA6IFwidWxcIjtcbiAgICAgICAgaWYgKGxpc3QgIT09IGtpbmQpIHsgaWYgKGxpc3QpIGh0bWwgKz0gYDwvJHtsaXN0fT5gOyBodG1sICs9IGA8JHtraW5kfT5gOyBsaXN0ID0ga2luZDsgfVxuICAgICAgICBodG1sICs9IGA8bGk+JHtpbmxpbmUoaXRlbVsyXSl9PC9saT5gO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGlmIChsaXN0KSB7IGh0bWwgKz0gYDwvJHtsaXN0fT5gOyBsaXN0ID0gbnVsbDsgfVxuICAgICAgY29uc3QgaGVhZGluZyA9IHJhdy5tYXRjaCgvXiN7MSw2fVxccysoLiopJC8pO1xuICAgICAgaHRtbCArPSBoZWFkaW5nID8gYDxkaXYgY2xhc3M9XCJtZC1oXCI+JHtpbmxpbmUoaGVhZGluZ1sxXSl9PC9kaXY+YCA6IHJhdy50cmltKCkgPT09IFwiXCIgPyBcIjxicj5cIiA6IGAke2lubGluZShyYXcpfTxicj5gO1xuICAgIH1cbiAgICBpZiAobGlzdCkgaHRtbCArPSBgPC8ke2xpc3R9PmA7XG4gICAgcmV0dXJuIGh0bWwucmVwbGFjZSgvKDxicj4pKyQvLCBcIlwiKTtcbiAgfSkuam9pbihcIlwiKTtcbn1cblxuY29uc3QgdHJhbnNjcmlwdFNjcm9sbCA9IG5ldyBBdXRvU2Nyb2xsZXIoJChcInRyYW5zY3JpcHRcIiksIHtcbiAgb25KdW1wQ2hhbmdlOiAoc2hvdykgPT4geyAkKFwianVtcGJvdHRvbVwiKS5oaWRkZW4gPSAhc2hvdzsgfSxcbiAgaXNFbXB0eTogKCkgPT4gISQoXCJlbXB0eVwiKS5oaWRkZW4sXG59KTtcblxuZnVuY3Rpb24gc2Nyb2xsRG93bihmb3JjZSA9IGZhbHNlKSB7XG4gIHRyYW5zY3JpcHRTY3JvbGwub25Db250ZW50KGZvcmNlKTtcbn1cblxuLyoqIFRoZSBjb3JlJ3MgbnVtYmVyIGZvciB0aGUgbGluZSB0aGUgbGFzdCByb3cgc2hvd3MsIHVudGlsIGFub3RoZXIgcm93IGZvbGxvd3MgaXQuICovXG5sZXQgb3BlbkxpbmU6IG51bWJlciB8IG51bGwgPSBudWxsO1xuXG4vKiogV29yZHMgZ28gb24gdGhlIHJvdyB0aGUgY29yZSBzYXlzIHRoZXkgYmVsb25nIHRvOiBpdCBzdGFydHMgYSBuZXcgbGluZSBmb3IgZWFjaCB0dXJuLCBob3dldmVyIGxvbmcgdGhlIGdhcC4gKi9cbmZ1bmN0aW9uIHRyYW5zY3JpcHQocm9sZTogXCJ1c2VyXCIgfCBcImFzc2lzdGFudFwiLCB0ZXh0OiBzdHJpbmcsIGxpbmU6IG51bWJlcikge1xuICAkKFwiZW1wdHlcIikuaGlkZGVuID0gdHJ1ZTtcbiAgY29uc3QgcGFuZSA9ICQoXCJ0cmFuc2NyaXB0XCIpO1xuICBjb25zdCBsYXN0ID0gcGFuZS5sYXN0RWxlbWVudENoaWxkIGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgaWYgKG9wZW5MaW5lID09PSBsaW5lICYmIGxhc3QgJiYgbGFzdC5kYXRhc2V0LnJvbGUgPT09IHJvbGUpIGxhc3QucXVlcnlTZWxlY3RvcihcIi50ZXh0XCIpIS50ZXh0Q29udGVudCArPSB0ZXh0O1xuICBlbHNlIHtcbiAgICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIHJvdy5jbGFzc05hbWUgPSBgbGluZSAke3JvbGV9YDtcbiAgICByb3cuZGF0YXNldC5yb2xlID0gcm9sZTtcbiAgICByb3cuaW5uZXJIVE1MID0gYDxzcGFuIGNsYXNzPVwid2hvXCI+JHtyb2xlID09PSBcInVzZXJcIiA/IFwiWW91XCIgOiBcIkdlbWluaVwifTwvc3Bhbj48c3BhbiBjbGFzcz1cInRleHRcIj48L3NwYW4+YDtcbiAgICByb3cucXVlcnlTZWxlY3RvcihcIi50ZXh0XCIpIS50ZXh0Q29udGVudCA9IHRleHQudHJpbVN0YXJ0KCk7XG4gICAgcGFuZS5hcHBlbmQocm93KTtcbiAgICBvcGVuTGluZSA9IGxpbmU7XG4gIH1cbiAgc2Nyb2xsRG93bigpO1xufVxuXG4vKipcbiAqIFRoZSB3b3JkcyB0aGUgdXNlciBpcyBzYXlpbmcsIGJlZm9yZSB0aGUgbW9kZWwgaGFzIHRyYW5zY3JpYmVkIHRoZW06IGEgZmFpbnQgcm93IHRoYXQgc3RheXMgbGFzdFxuICogb24gc2NyZWVuIChpdHMgQ1NTIGBvcmRlcmApIGFuZCBmaXJzdCBpbiB0aGUgcGFuZSwgc28gdGhlIGxpbmVzIGFmdGVyIGl0IGpvaW4gdXAgYXMgYmVmb3JlLlxuICovXG5mdW5jdGlvbiBjYXB0aW9uKHRleHQ6IHN0cmluZyB8IG51bGwpIHtcbiAgY29uc3QgcGFuZSA9ICQoXCJ0cmFuc2NyaXB0XCIpO1xuICBsZXQgcm93ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJjYXB0aW9uXCIpO1xuICBpZiAodGV4dCA9PSBudWxsKSB7IHJvdz8ucmVtb3ZlKCk7IHNjcm9sbERvd24oKTsgcmV0dXJuOyB9XG4gICQoXCJlbXB0eVwiKS5oaWRkZW4gPSB0cnVlO1xuICBpZiAoIXJvdykge1xuICAgIHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgcm93LmlkID0gXCJjYXB0aW9uXCI7XG4gICAgcm93LmNsYXNzTmFtZSA9IFwibGluZSB1c2VyIGNhcHRpb25cIjtcbiAgICByb3cuaW5uZXJIVE1MID0gYDxzcGFuIGNsYXNzPVwid2hvXCI+WW91PC9zcGFuPjxzcGFuIGNsYXNzPVwidGV4dFwiPjwvc3Bhbj5gO1xuICAgIHBhbmUucHJlcGVuZChyb3cpO1xuICB9XG4gIHJvdy5xdWVyeVNlbGVjdG9yKFwiLnRleHRcIikhLnRleHRDb250ZW50ID0gdGV4dDtcbiAgc2Nyb2xsRG93bigpO1xufVxuXG5mdW5jdGlvbiBub3RlKHRleHQ6IHN0cmluZykge1xuICAkKFwiZW1wdHlcIikuaGlkZGVuID0gdHJ1ZTtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IFwibGluZSBub3RlXCI7XG4gIHJvdy50ZXh0Q29udGVudCA9IHRleHQ7XG4gICQoXCJ0cmFuc2NyaXB0XCIpLmFwcGVuZChyb3cpO1xuICBvcGVuTGluZSA9IG51bGw7XG4gIHNjcm9sbERvd24oKTtcbn1cblxuLy8gQWdlbnQgaGFuZG9mZiByZXN1bHRzOiBjb21wYWN0IDEtbGluZSByZWZlcmVuY2UgaW4gdGhlIHZvaWNlIHN0cmVhbSArIGZ1bGwgY29sbGFwc2libGUgY2FyZCBpbiB0aGUgcmlnaHQgcGFuZS5cblxuZnVuY3Rpb24gcmVzdWx0Q2xhbXBQeChlbDogSFRNTEVsZW1lbnQpOiBudW1iZXIge1xuICBjb25zdCByYXcgPSBnZXRDb21wdXRlZFN0eWxlKGVsKS5nZXRQcm9wZXJ0eVZhbHVlKFwiLS1yZXMtY2xhbXAtbWF4XCIpLnRyaW0oKTtcbiAgY29uc3QgbiA9IE51bWJlci5wYXJzZUZsb2F0KHJhdyk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobikgJiYgbiA+IDAgPyBuIDogNjQ7XG59XG5cbmZ1bmN0aW9uIHN5bmNFeHBhbmRBbGxCdXR0b24oKSB7XG4gIGNvbnN0IGNsYW1wZWQgPSBbLi4ucmVzdWx0cy52YWx1ZXMoKV0uZmlsdGVyKChyKSA9PiByLmNhcmQuY2xhc3NMaXN0LmNvbnRhaW5zKFwiY2xhbXBlZFwiKSk7XG4gIGNvbnN0IGJ0biA9ICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwidG9nZ2xlLWFsbC1yZXN1bHRzXCIpO1xuICBidG4uaGlkZGVuID0gY2xhbXBlZC5sZW5ndGggPT09IDA7XG4gIGlmIChjbGFtcGVkLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuICBjb25zdCBhbnlDb2xsYXBzZWQgPSBjbGFtcGVkLnNvbWUoKHIpID0+ICFyLmNhcmQuY2xhc3NMaXN0LmNvbnRhaW5zKFwib3BlblwiKSk7XG4gIGJ0bi50ZXh0Q29udGVudCA9IGFueUNvbGxhcHNlZCA/IFwiRXhwYW5kIGFsbFwiIDogXCJDb2xsYXBzZSBhbGxcIjtcbn1cblxuZnVuY3Rpb24gc2V0UmVzdWx0T3BlbihlbnRyeTogUmVzdWx0RW50cnksIG9wZW46IGJvb2xlYW4pIHtcbiAgY29uc3QgY2xhbXBlZCA9IGVudHJ5LmNhcmQuY2xhc3NMaXN0LmNvbnRhaW5zKFwiY2xhbXBlZFwiKTtcbiAgY29uc3QgbmV4dCA9IGNsYW1wZWQgJiYgb3BlbjtcbiAgZW50cnkuY2FyZC5jbGFzc0xpc3QudG9nZ2xlKFwib3BlblwiLCBuZXh0KTtcbiAgZW50cnkuaGVhZC5zZXRBdHRyaWJ1dGUoXCJhcmlhLWV4cGFuZGVkXCIsIFN0cmluZyghY2xhbXBlZCB8fCBuZXh0KSk7XG4gIGVudHJ5Lm1vcmVCdG4udGV4dENvbnRlbnQgPSBuZXh0ID8gXCJTaG93IGxlc3NcIiA6IFwiU2hvdyBtb3JlXCI7XG4gIHN5bmNFeHBhbmRBbGxCdXR0b24oKTtcbn1cblxuZnVuY3Rpb24gdXBkYXRlUmVzdWx0Q2xhbXBpbmcoZW50cnk6IFJlc3VsdEVudHJ5KSB7XG4gIGlmIChlbnRyeS5ib2R5Lm9mZnNldFBhcmVudCA9PT0gbnVsbCkgcmV0dXJuO1xuICAvLyBVbmNsYW1wZWQgY2FyZHMgaGF2ZSBubyBtYXgtaGVpZ2h0LCBzbyBzY3JvbGxIZWlnaHQgaXMgYWx3YXlzIHRoZSBmdWxsIG5hdHVyYWwgaGVpZ2h0LlxuICBjb25zdCBvdmVyZmxvd3MgPSBlbnRyeS5ib2R5LnNjcm9sbEhlaWdodCA+IHJlc3VsdENsYW1wUHgoZW50cnkuY2FyZCkgKyA0O1xuICBlbnRyeS5jYXJkLmNsYXNzTGlzdC50b2dnbGUoXCJjbGFtcGVkXCIsIG92ZXJmbG93cyk7XG4gIGlmICghb3ZlcmZsb3dzKSBlbnRyeS5jYXJkLmNsYXNzTGlzdC5yZW1vdmUoXCJvcGVuXCIpO1xuICBlbnRyeS5tb3JlQnRuLmhpZGRlbiA9ICFvdmVyZmxvd3M7XG4gIGNvbnN0IGlzT3BlbiA9IGVudHJ5LmNhcmQuY2xhc3NMaXN0LmNvbnRhaW5zKFwib3BlblwiKTtcbiAgZW50cnkubW9yZUJ0bi50ZXh0Q29udGVudCA9IGlzT3BlbiA/IFwiU2hvdyBsZXNzXCIgOiBcIlNob3cgbW9yZVwiO1xuICBlbnRyeS5oZWFkLnNldEF0dHJpYnV0ZShcImFyaWEtZXhwYW5kZWRcIiwgU3RyaW5nKCFvdmVyZmxvd3MgfHwgaXNPcGVuKSk7XG59XG5cbmZ1bmN0aW9uIHVwZGF0ZUFsbFJlc3VsdENsYW1waW5nKCkge1xuICBmb3IgKGNvbnN0IGVudHJ5IG9mIHJlc3VsdHMudmFsdWVzKCkpIHVwZGF0ZVJlc3VsdENsYW1waW5nKGVudHJ5KTtcbiAgc3luY0V4cGFuZEFsbEJ1dHRvbigpO1xufVxuXG5mdW5jdGlvbiBzeW5jUmVzdWx0Rm9sbG93VXBCdXR0b25zKCkge1xuICBmb3IgKGNvbnN0IGVudHJ5IG9mIHJlc3VsdHMudmFsdWVzKCkpIHtcbiAgICBpZiAoIWVudHJ5LmZvbGxvd0J0bikgY29udGludWU7XG4gICAgY29uc3QgY2FuRm9sbG93ID0gY2FuRm9sbG93VXBSZXN1bHQoZW50cnkuc2Vzc2lvbklkLCBhY3RpdmVTZXNzaW9uLCBCb29sZWFuKGVudHJ5LnRhc2tJZCAmJiB0YXNrcy5oYXMoZW50cnkudGFza0lkKSkpO1xuICAgIGVudHJ5LmZvbGxvd0J0bi5oaWRkZW4gPSAhY2FuRm9sbG93O1xuICAgIGlmICghY2FuRm9sbG93KSBlbnRyeS5jYXJkLnF1ZXJ5U2VsZWN0b3IoXCJmb3JtXCIpPy5yZW1vdmUoKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBjbGVhclVucmVhZElmUmVzdWx0c1Zpc2libGUoKSB7XG4gIGlmICh1bnJlYWRNb2JpbGVSZXN1bHRzID09PSAwKSByZXR1cm47XG4gIGNvbnN0IGRyYXdlck9wZW4gPSBkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5jb250YWlucyhcInRhc2tzLW9wZW5cIik7XG4gIGlmIChzaG91bGRDbGVhclVucmVhZFJlc3VsdHMobW9iaWxlTGF5b3V0Lm1hdGNoZXMsIGRyYXdlck9wZW4sIHNpZGVGaWx0ZXIpKSB7XG4gICAgdW5yZWFkTW9iaWxlUmVzdWx0cyA9IDA7XG4gICAgdXBkYXRlVGFza0Nocm9tZSgpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGZvY3VzUmVzdWx0KGlkOiBzdHJpbmcpIHtcbiAgY29uc3QgZW50cnkgPSByZXN1bHRzLmdldChpZCk7XG4gIGlmICghZW50cnkpIHJldHVybjtcbiAgaWYgKHNpZGVGaWx0ZXIgPT09IFwiYWN0aXZlXCIpIHNldFNpZGVGaWx0ZXIoXCJhbGxcIik7XG4gIGlmIChtb2JpbGVMYXlvdXQubWF0Y2hlcykgc2V0VGFza3NPcGVuKHRydWUpO1xuICByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKCkgPT4ge1xuICAgIHVwZGF0ZVJlc3VsdENsYW1waW5nKGVudHJ5KTtcbiAgICBpZiAoZW50cnkuY2FyZC5jbGFzc0xpc3QuY29udGFpbnMoXCJjbGFtcGVkXCIpKSBzZXRSZXN1bHRPcGVuKGVudHJ5LCB0cnVlKTtcbiAgICBmb3IgKGNvbnN0IHIgb2YgcmVzdWx0cy52YWx1ZXMoKSkgci5jYXJkLmNsYXNzTGlzdC5yZW1vdmUoXCJmbGFzaFwiKTtcbiAgICB2b2lkIGVudHJ5LmNhcmQub2Zmc2V0V2lkdGg7XG4gICAgZW50cnkuY2FyZC5jbGFzc0xpc3QuYWRkKFwiZmxhc2hcIik7XG4gICAgY2xlYXJUaW1lb3V0KGZsYXNoVGltZXIpO1xuICAgIGZsYXNoVGltZXIgPSB3aW5kb3cuc2V0VGltZW91dCgoKSA9PiBlbnRyeS5jYXJkLmNsYXNzTGlzdC5yZW1vdmUoXCJmbGFzaFwiKSwgMTQwMCk7XG4gICAgZW50cnkuY2FyZC5zY3JvbGxJbnRvVmlldyh7IGJlaGF2aW9yOiBcInNtb290aFwiLCBibG9jazogXCJuZWFyZXN0XCIgfSk7XG4gIH0pO1xufVxuXG5mdW5jdGlvbiByZXN1bHQoYWdlbnQ6IHN0cmluZywgbGFiZWw6IHN0cmluZywgdGV4dDogc3RyaW5nLCBmYWlsZWQgPSBmYWxzZSwgdGFza0lkPzogc3RyaW5nLCBzZXNzaW9uSWQgPSBhY3RpdmVTZXNzaW9uKTogc3RyaW5nIHtcbiAgJChcImVtcHR5XCIpLmhpZGRlbiA9IHRydWU7XG4gIGNvbnN0IGlkID0gYHJlcy0keysrbmV4dFJlc3VsdFNlcX1gO1xuICBjb25zdCB3aG8gPSBhZ2VudCA9PT0gXCJ0M1wiID8gXCJUM1wiIDogXCJIZXJtZXNcIjtcbiAgY29uc3QgYWdlbnRDbHMgPSBhZ2VudCA9PT0gXCJ0M1wiID8gXCJ0M1wiIDogXCJcIjtcbiAgY29uc3Qgc25pcHBldCA9IHBsYWluUHJldmlldyh0ZXh0LCAxNjApIHx8IFwiKGVtcHR5IHJlc3BvbnNlKVwiO1xuXG4gIC8vIDEuIENvbXBhY3QgaW5saW5lIGhhbmRvZmYgbWFya2VyIGluIHRoZSB2b2ljZSB0cmFuc2NyaXB0IHNvIGNocm9ub2xvZ2ljYWwgY29udGV4dCBzdGF5cyBpbnRhY3RcbiAgLy8gd2l0aG91dCBtdWx0aS1wYXJhZ3JhcGggcmVzcG9uc2VzIHB1c2hpbmcgdm9pY2UgdHVybnMgb2ZmIHNjcmVlbi5cbiAgY29uc3QgcmVmUm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgcmVmUm93LnR5cGUgPSBcImJ1dHRvblwiO1xuICByZWZSb3cuY2xhc3NOYW1lID0gYGxpbmUgaGFuZG9mZiAke2FnZW50Q2xzfSAke2ZhaWxlZCA/IFwiZmFpbGVkXCIgOiBcIlwifWAudHJpbSgpO1xuICByZWZSb3cuZGF0YXNldC5yZXN1bHRJZCA9IGlkO1xuICByZWZSb3cuaW5uZXJIVE1MID1cbiAgICBgPHNwYW4gY2xhc3M9XCJiYWRnZSAke2FnZW50Q2xzfVwiPiR7d2hvfTwvc3Bhbj5gICtcbiAgICBgPHNwYW4gY2xhc3M9XCJoYW5kb2ZmLWxhYmVsXCI+JHtlc2NhcGVIdG1sKGxhYmVsKX08L3NwYW4+YCArXG4gICAgYDxzcGFuIGNsYXNzPVwiaGFuZG9mZi1zbmlwcGV0XCI+JHtlc2NhcGVIdG1sKHNuaXBwZXQpfTwvc3Bhbj5gICtcbiAgICBgPHNwYW4gY2xhc3M9XCJoYW5kb2ZmLWN1ZVwiPiR7ZmFpbGVkID8gXCJGYWlsZWRcIiA6IFwiT3BlbiBcdTIxOTdcIn08L3NwYW4+YDtcbiAgcmVmUm93Lm9uY2xpY2sgPSAoKSA9PiBmb2N1c1Jlc3VsdChpZCk7XG4gICQoXCJ0cmFuc2NyaXB0XCIpLmFwcGVuZChyZWZSb3cpO1xuICBvcGVuTGluZSA9IG51bGw7XG4gIHNjcm9sbERvd24oKTtcblxuICAvLyAyLiBUcnVuY2F0ZWQsIGV4cGFuZGFibGUgcmVzdWx0IGNhcmQgaW4gdGhlIHJpZ2h0LWhhbmQgQWdlbnQgV29ya3NwYWNlIChuZXdlc3QgZmlyc3QpLlxuICBjb25zdCBjYXJkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImFydGljbGVcIik7XG4gIGNhcmQuY2xhc3NOYW1lID0gYHJlcy1jYXJkICR7YWdlbnRDbHN9ICR7ZmFpbGVkID8gXCJmYWlsZWRcIiA6IFwiXCJ9YC50cmltKCk7XG4gIGNhcmQuZGF0YXNldC5yZXN1bHRJZCA9IGlkO1xuXG4gIGNvbnN0IGhlYWQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBoZWFkLnR5cGUgPSBcImJ1dHRvblwiO1xuICBoZWFkLmNsYXNzTmFtZSA9IFwicmVzLWhlYWRcIjtcbiAgaGVhZC5zZXRBdHRyaWJ1dGUoXCJhcmlhLWV4cGFuZGVkXCIsIFwidHJ1ZVwiKTtcbiAgaGVhZC5pbm5lckhUTUwgPVxuICAgIGA8c3BhbiBjbGFzcz1cImJhZGdlICR7YWdlbnRDbHN9XCI+JHt3aG99PC9zcGFuPmAgK1xuICAgIGA8c3BhbiBjbGFzcz1cInJlcy1sYWJlbFwiIHRpdGxlPVwiJHtlc2NhcGVIdG1sKGxhYmVsKX1cIj4ke2VzY2FwZUh0bWwobGFiZWwpfTwvc3Bhbj5gICtcbiAgICAoZmFpbGVkID8gYDxzcGFuIGNsYXNzPVwicmVzLXBpbGxcIj5GYWlsZWQ8L3NwYW4+YCA6IFwiXCIpICtcbiAgICBgPHNwYW4gY2xhc3M9XCJyZXMtdGltZVwiPiR7Zm9ybWF0U2hvcnRUaW1lKG5ldyBEYXRlKCkpfTwvc3Bhbj5gICtcbiAgICBgPHNwYW4gY2xhc3M9XCJyZXMtY2hldlwiIGFyaWEtaGlkZGVuPVwidHJ1ZVwiPjwvc3Bhbj5gO1xuXG4gIGNvbnN0IGJvZHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBib2R5LmNsYXNzTmFtZSA9IFwicmVzLWJvZHlcIjtcbiAgYm9keS5pbm5lckhUTUwgPSBtYXJrZG93bih0ZXh0KTtcblxuICBjb25zdCBmb290ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgZm9vdC5jbGFzc05hbWUgPSBcInJlcy1mb290XCI7XG5cbiAgY29uc3QgbW9yZUJ0biA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIG1vcmVCdG4udHlwZSA9IFwiYnV0dG9uXCI7XG4gIG1vcmVCdG4uY2xhc3NOYW1lID0gXCJyZXMtYWN0IHByaW1hcnlcIjtcbiAgbW9yZUJ0bi50ZXh0Q29udGVudCA9IFwiU2hvdyBtb3JlXCI7XG4gIG1vcmVCdG4uaGlkZGVuID0gdHJ1ZTtcblxuICBjb25zdCBjb3B5QnRuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgY29weUJ0bi50eXBlID0gXCJidXR0b25cIjtcbiAgY29weUJ0bi5jbGFzc05hbWUgPSBcInJlcy1hY3RcIjtcbiAgY29weUJ0bi50ZXh0Q29udGVudCA9IFwiQ29weVwiO1xuICBjb3B5QnRuLm9uY2xpY2sgPSAoKSA9PiB7XG4gICAgdm9pZCBuYXZpZ2F0b3IuY2xpcGJvYXJkPy53cml0ZVRleHQodGV4dCk7XG4gICAgdG9hc3QoXCJSZXN1bHQgY29waWVkXCIpO1xuICB9O1xuXG4gIGZvb3QuYXBwZW5kKG1vcmVCdG4sIGNvcHlCdG4pO1xuXG4gIGxldCBmb2xsb3dCdG46IEhUTUxCdXR0b25FbGVtZW50IHwgdW5kZWZpbmVkO1xuICBpZiAodGFza0lkKSB7XG4gICAgZm9sbG93QnRuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgICBmb2xsb3dCdG4udHlwZSA9IFwiYnV0dG9uXCI7XG4gICAgZm9sbG93QnRuLmNsYXNzTmFtZSA9IFwicmVzLWFjdFwiO1xuICAgIGZvbGxvd0J0bi50ZXh0Q29udGVudCA9IFwiRm9sbG93IHVwXCI7XG4gICAgZm9sbG93QnRuLm9uY2xpY2sgPSAoKSA9PiB7XG4gICAgICBpZiAoIWNhbkZvbGxvd1VwUmVzdWx0KHNlc3Npb25JZCwgYWN0aXZlU2Vzc2lvbiwgdGFza3MuaGFzKHRhc2tJZCkpKSB7XG4gICAgICAgIHN5bmNSZXN1bHRGb2xsb3dVcEJ1dHRvbnMoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY29uc3QgdmlldyA9IHRhc2tzLmdldCh0YXNrSWQpO1xuICAgICAgaWYgKHZpZXcpIGZvbGxvd1VwRm9ybShjYXJkLCB2aWV3LmMsIHNlc3Npb25JZCk7XG4gICAgfTtcbiAgICBmb290LmFwcGVuZChmb2xsb3dCdG4pO1xuICB9XG5cbiAgY2FyZC5hcHBlbmQoaGVhZCwgYm9keSwgZm9vdCk7XG5cbiAgY29uc3QgZW50cnk6IFJlc3VsdEVudHJ5ID0geyBpZCwgYWdlbnQsIGxhYmVsLCB0ZXh0LCBmYWlsZWQsIHRhc2tJZCwgc2Vzc2lvbklkLCBjYXJkLCBoZWFkLCBib2R5LCBtb3JlQnRuLCBmb2xsb3dCdG4sIHJlZlJvdyB9O1xuICBjb25zdCB0b2dnbGUgPSAoKSA9PiB7XG4gICAgaWYgKCFlbnRyeS5jYXJkLmNsYXNzTGlzdC5jb250YWlucyhcImNsYW1wZWRcIikpIHJldHVybjtcbiAgICBzZXRSZXN1bHRPcGVuKGVudHJ5LCAhZW50cnkuY2FyZC5jbGFzc0xpc3QuY29udGFpbnMoXCJvcGVuXCIpKTtcbiAgfTtcbiAgaGVhZC5vbmNsaWNrID0gdG9nZ2xlO1xuICBtb3JlQnRuLm9uY2xpY2sgPSB0b2dnbGU7XG5cbiAgcmVzdWx0cy5zZXQoaWQsIGVudHJ5KTtcbiAgJChcInJlc3VsdHNcIikucHJlcGVuZChjYXJkKTtcbiAgY29uc3QgZHJhd2VyT3BlbiA9IGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LmNvbnRhaW5zKFwidGFza3Mtb3BlblwiKTtcbiAgaWYgKCFzaG91bGRDbGVhclVucmVhZFJlc3VsdHMobW9iaWxlTGF5b3V0Lm1hdGNoZXMsIGRyYXdlck9wZW4sIHNpZGVGaWx0ZXIpKSB1bnJlYWRNb2JpbGVSZXN1bHRzKys7XG5cbiAgc3luY1NpZGVMYXlvdXQoKTtcbiAgdXBkYXRlVGFza0Nocm9tZSgpO1xuICByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKCkgPT4ge1xuICAgIHVwZGF0ZVJlc3VsdENsYW1waW5nKGVudHJ5KTtcbiAgICBzeW5jRXhwYW5kQWxsQnV0dG9uKCk7XG4gIH0pO1xuICByZXR1cm4gaWQ7XG59XG5cbmZ1bmN0aW9uIGVsYXBzZWQoc2Vjb25kczogbnVtYmVyKTogc3RyaW5nIHtcbiAgaWYgKHNlY29uZHMgPCA2MCkgcmV0dXJuIGAke01hdGguZmxvb3Ioc2Vjb25kcyl9c2A7XG4gIGNvbnN0IG0gPSBNYXRoLmZsb29yKHNlY29uZHMgLyA2MCk7XG4gIHJldHVybiBtIDwgNjAgPyBgJHttfW0gJHtNYXRoLmZsb29yKHNlY29uZHMgJSA2MCl9c2AgOiBgJHtNYXRoLmZsb29yKG0gLyA2MCl9aCAke20gJSA2MH1tYDtcbn1cblxuLyoqIFRoZSBlbXB0eSB0YXNrIGxpc3QncyB3b3Jkcywga2VwdCB0byBwdXQgYmFjay4gKi9cbmNvbnN0IG5vVGFza3MgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcIm5vdGFza3NcIikhO1xuXG4vKiogV2hldGhlciBhIHRhc2sgc3RpbGwgd2FudHMgdGhlIHNjcmVlbjogaXQncyB3b3JraW5nLCB3YWl0aW5nLCBvciBuZWVkcyBhcHByb3ZhbC4gVGhlIHJlc3QgZm9sZCBhd2F5IHVuZGVyIEZpbmlzaGVkLiAqL1xuY29uc3QgbGl2ZSA9IChzdGF0ZTogc3RyaW5nKSA9PiBzdGF0ZSA9PT0gXCJydW5uaW5nXCIgfHwgc3RhdGUuc3RhcnRzV2l0aChcIndhaXRpbmdcIik7XG5jb25zdCBpc0FjdGl2ZVRhc2sgPSAodmlldzogVGFza1ZpZXcpID0+IGxpdmUodmlldy5jLnN0YXRlKSB8fCBCb29sZWFuKHZpZXcuYXBwcm92YWwpO1xuXG5mdW5jdGlvbiBzZXRTaWRlRmlsdGVyKGZpbHRlcjogU2lkZUZpbHRlcikge1xuICBzaWRlRmlsdGVyID0gbm9ybWFsaXplU2lkZUZpbHRlcihmaWx0ZXIpO1xuICBmb3IgKGNvbnN0IGJ0biBvZiBBcnJheS5mcm9tKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiI3NpZGUtdGFicyBidXR0b25cIikpKSB7XG4gICAgY29uc3Qgb24gPSBidG4uZGF0YXNldC5maWx0ZXIgPT09IHNpZGVGaWx0ZXI7XG4gICAgYnRuLmNsYXNzTGlzdC50b2dnbGUoXCJvblwiLCBvbik7XG4gICAgYnRuLnNldEF0dHJpYnV0ZShcImFyaWEtcHJlc3NlZFwiLCBTdHJpbmcob24pKTtcbiAgfVxuICBzeW5jU2lkZUxheW91dCgpO1xuICBjbGVhclVucmVhZElmUmVzdWx0c1Zpc2libGUoKTtcbiAgcmVxdWVzdEFuaW1hdGlvbkZyYW1lKCgpID0+IHVwZGF0ZUFsbFJlc3VsdENsYW1waW5nKCkpO1xufVxuXG5mdW5jdGlvbiBzeW5jU2lkZUxheW91dCgpIHtcbiAgY29uc3QgYWxsID0gWy4uLnRhc2tzLnZhbHVlcygpXTtcbiAgY29uc3QgYWN0aXZlQ3VycmVudCA9IGFsbC5maWx0ZXIoaXNBY3RpdmVUYXNrKS5sZW5ndGg7XG4gIGNvbnN0IGFjdGl2ZVRvdGFsID0gYWN0aXZlQ3VycmVudCArIGVhcmxpZXJBY3RpdmVDb3VudDtcbiAgY29uc3QgcmVzdWx0c1RvdGFsID0gcmVzdWx0cy5zaXplO1xuICBjb25zdCBlYXJsaWVyU2hvd24gPSAkKFwiZWFybGllclwiKS5jaGlsZEVsZW1lbnRDb3VudDtcbiAgY29uc3QgZG9uZVRvdGFsID0gJChcImRvbmVub3dcIikuY2hpbGRFbGVtZW50Q291bnQgKyAkKFwiZG9uZWVhcmxpZXJcIikuY2hpbGRFbGVtZW50Q291bnQ7XG5cbiAgY29uc3QgdmlzID0gcmVzb2x2ZVNpZGVTZWN0aW9ucyhzaWRlRmlsdGVyLCB7XG4gICAgYWN0aXZlOiBhY3RpdmVDdXJyZW50LFxuICAgIHJlc3VsdHM6IHJlc3VsdHNUb3RhbCxcbiAgICBlYXJsaWVyOiBlYXJsaWVyU2hvd24sXG4gICAgZG9uZTogZG9uZVRvdGFsLFxuICB9KTtcblxuICAkKFwidGFza3Mtc2VjdGlvblwiKS5oaWRkZW4gPSAhdmlzLnNob3dUYXNrc1NlY3Rpb247XG4gIG5vVGFza3MuaGlkZGVuID0gIXZpcy5zaG93RW1wdHlUYXNrcztcbiAgJChcInJlc3VsdHMtc2VjdGlvblwiKS5oaWRkZW4gPSAhdmlzLnNob3dSZXN1bHRzU2VjdGlvbjtcbiAgJChcIm5vcmVzdWx0c1wiKS5oaWRkZW4gPSAhdmlzLnNob3dFbXB0eVJlc3VsdHM7XG4gICQoXCJlYXJsaWVyYm94XCIpLmhpZGRlbiA9ICF2aXMuc2hvd0VhcmxpZXJTZWN0aW9uO1xuICAkKFwiZG9uZWJveFwiKS5oaWRkZW4gPSAhdmlzLnNob3dEb25lU2VjdGlvbjtcblxuICAkKFwic2lkZS1hY3RpdmUtblwiKS50ZXh0Q29udGVudCA9IGFjdGl2ZVRvdGFsID4gMCA/IFN0cmluZyhhY3RpdmVUb3RhbCkgOiBcIlwiO1xuICAkKFwic2lkZS1yZXN1bHRzLW5cIikudGV4dENvbnRlbnQgPSByZXN1bHRzVG90YWwgPiAwID8gU3RyaW5nKHJlc3VsdHNUb3RhbCkgOiBcIlwiO1xuICAkKFwicmVzdWx0c2NvdW50XCIpLnRleHRDb250ZW50ID0gcmVzdWx0c1RvdGFsID4gMCA/IGBcdTAwQjcgJHtyZXN1bHRzVG90YWx9YCA6IFwiXCI7XG4gICQoXCJkb25lY291bnRcIikudGV4dENvbnRlbnQgPSBkb25lVG90YWwgPiAwID8gYFx1MDBCNyAke2RvbmVUb3RhbH1gIDogXCJcIjtcbiAgc3luY1Jlc3VsdEZvbGxvd1VwQnV0dG9ucygpO1xufVxuXG5mdW5jdGlvbiB1cGRhdGVUYXNrQ2hyb21lKCkge1xuICBjb25zdCBhbGwgPSBbLi4udGFza3MudmFsdWVzKCldO1xuICBjb25zdCBhY3RpdmVDdXJyZW50ID0gYWxsLmZpbHRlcihpc0FjdGl2ZVRhc2spLmxlbmd0aDtcbiAgY29uc3Qgd2FpdGluZyA9IGFsbC5maWx0ZXIoKHQpID0+IHQuYy5zdGF0ZS5zdGFydHNXaXRoKFwid2FpdGluZ1wiKSB8fCBCb29sZWFuKHQuYXBwcm92YWwpKS5sZW5ndGg7XG4gIGNvbnN0IGFjdGl2ZVRvdGFsID0gYWN0aXZlQ3VycmVudCArIGVhcmxpZXJBY3RpdmVDb3VudDtcbiAgY29uc3QgYXR0ZW50aW9uVG90YWwgPSB3YWl0aW5nICsgZWFybGllcldhaXRpbmdDb3VudDtcbiAgY29uc3QgYmFkZ2VDb3VudCA9IGFjdGl2ZVRvdGFsID4gMCA/IGFjdGl2ZVRvdGFsIDogdW5yZWFkTW9iaWxlUmVzdWx0cztcblxuICBjb25zdCBiYWRnZSA9ICQoXCJ0YXNrcy1iYWRnZVwiKTtcbiAgYmFkZ2UuaGlkZGVuID0gYmFkZ2VDb3VudCA9PT0gMDtcbiAgYmFkZ2UudGV4dENvbnRlbnQgPSBTdHJpbmcoYmFkZ2VDb3VudCk7XG4gIGJhZGdlLmNsYXNzTGlzdC50b2dnbGUoXCJ3YXJuXCIsIGF0dGVudGlvblRvdGFsID4gMCk7XG5cbiAgY29uc3QgYmFyID0gJChcIm1vYmlsZS10YXNrcy1iYXJcIik7XG4gIGNvbnN0IHNob3dCYXIgPSBhY3RpdmVUb3RhbCA+IDAgfHwgdW5yZWFkTW9iaWxlUmVzdWx0cyA+IDA7XG4gIGJhci5oaWRkZW4gPSAhc2hvd0JhcjtcbiAgYmFyLmNsYXNzTGlzdC50b2dnbGUoXCJ2aXNpYmxlXCIsIHNob3dCYXIpO1xuICBiYXIuY2xhc3NMaXN0LnRvZ2dsZShcIndhcm5cIiwgYXR0ZW50aW9uVG90YWwgPiAwKTtcbiAgaWYgKHNob3dCYXIpIHtcbiAgICBjb25zdCBhcHByb3ZhbCA9IGFsbC5maW5kKCh0KSA9PiB0LmFwcHJvdmFsKTtcbiAgICBjb25zdCBsYWJlbCA9IGFwcHJvdmFsXG4gICAgICA/IGBBcHByb3ZhbCBuZWVkZWQ6ICR7YXBwcm92YWwuYy5sYWJlbH1gXG4gICAgICA6IGF0dGVudGlvblRvdGFsID4gMFxuICAgICAgICA/IGAke2F0dGVudGlvblRvdGFsfSB0YXNrJHthdHRlbnRpb25Ub3RhbCA+IDEgPyBcInNcIiA6IFwiXCJ9IHdhaXRpbmcgZm9yIHlvdWBcbiAgICAgICAgOiBhY3RpdmVUb3RhbCA+IDBcbiAgICAgICAgICA/IGAke2FjdGl2ZVRvdGFsfSBhY3RpdmUgdGFzayR7YWN0aXZlVG90YWwgPiAxID8gXCJzXCIgOiBcIlwifWBcbiAgICAgICAgICA6IGAke3VucmVhZE1vYmlsZVJlc3VsdHN9IG5ldyBhZ2VudCByZXN1bHQke3VucmVhZE1vYmlsZVJlc3VsdHMgPiAxID8gXCJzXCIgOiBcIlwifWA7XG4gICAgJChcIm10Yi10ZXh0XCIpLnRleHRDb250ZW50ID0gbGFiZWw7XG4gIH1cbn1cblxuZnVuY3Rpb24gc2hvd1Rhc2tzKGZvcmNlID0gZmFsc2UpIHtcbiAgY29uc3QgcGFuZSA9ICQoXCJ0YXNrc1wiKTtcbiAgY29uc3QgZG9uZSA9ICQoXCJkb25lbm93XCIpO1xuICBjb25zdCBvcGVuID0gZG9jdW1lbnQuYWN0aXZlRWxlbWVudD8uY2xvc2VzdD8uKFwiLnRhc2tcIikgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAoIWZvcmNlICYmIG9wZW4gJiYgKHBhbmUuY29udGFpbnMob3BlbikgfHwgZG9uZS5jb250YWlucyhvcGVuKSkgJiYgb3Blbi5xdWVyeVNlbGVjdG9yKFwiZm9ybVwiKSkgcmV0dXJuOyAvLyBkb24ndCByZWRyYXcgdW5kZXIgc29tZW9uZSB0eXBpbmcgYSBmb2xsb3ctdXBcbiAgcGFuZS5pbm5lckhUTUwgPSBcIlwiO1xuICBkb25lLmlubmVySFRNTCA9IFwiXCI7XG4gIGNvbnN0IGFsbCA9IFsuLi50YXNrcy52YWx1ZXMoKV0ucmV2ZXJzZSgpO1xuICBpZiAoYWxsLmxlbmd0aCA9PT0gMCkge1xuICAgIHBhbmUuYXBwZW5kKG5vVGFza3MpO1xuICAgICQoXCJ0YXNrY291bnRcIikudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICQoXCJjYW5jZWxhbGxcIikuaGlkZGVuID0gdHJ1ZTtcbiAgICBzeW5jU2lkZUxheW91dCgpO1xuICAgIHVwZGF0ZVRhc2tDaHJvbWUoKTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgcnVubmluZyA9IGFsbC5maWx0ZXIoKHQpID0+IHQuYy5zdGF0ZSA9PT0gXCJydW5uaW5nXCIpLmxlbmd0aDtcbiAgY29uc3QgYWN0aXZlQ291bnQgPSBhbGwuZmlsdGVyKGlzQWN0aXZlVGFzaykubGVuZ3RoO1xuICAkKFwidGFza2NvdW50XCIpLnRleHRDb250ZW50ID0gcnVubmluZyA+IDAgPyBgJHtydW5uaW5nfSBydW5uaW5nYCA6IGFjdGl2ZUNvdW50ID4gMCA/IGAke2FjdGl2ZUNvdW50fSB3YWl0aW5nYCA6IFwiXCI7XG4gICQoXCJjYW5jZWxhbGxcIikuaGlkZGVuID0gIWNhbGxJZCB8fCBydW5uaW5nIDwgMjtcbiAgZm9yIChjb25zdCB2aWV3IG9mIGFsbCkge1xuICAgIGNvbnN0IHQgPSB2aWV3LmM7XG4gICAgY29uc3Qgd2FpdGluZyA9IHQuc3RhdGUuc3RhcnRzV2l0aChcIndhaXRpbmdcIik7XG4gICAgY29uc3QgY2FyZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgY2FyZC5jbGFzc05hbWUgPSBgdGFzayAke3dhaXRpbmcgPyBcIndhaXRpbmdcIiA6IHQuc3RhdGV9YDtcbiAgICBjb25zdCBhZ2UgPSAodmlldy5lbmRlZCA/PyBub3coKSkgLSB2aWV3LnNpbmNlO1xuICAgIGNhcmQuaW5uZXJIVE1MID1cbiAgICAgIGA8ZGl2IGNsYXNzPVwibWV0YS1yb3dcIj5gICtcbiAgICAgICAgYDxzcGFuIGNsYXNzPVwiYmFkZ2UgJHt0LmFnZW50ID09PSBcInQzXCIgPyBcInQzXCIgOiBcIlwifVwiPiR7dC5hZ2VudCA9PT0gXCJ0M1wiID8gXCJUM1wiIDogXCJIZXJtZXNcIn08L3NwYW4+YCArXG4gICAgICAgIGA8c3BhbiBjbGFzcz1cImxhYmVsXCI+PC9zcGFuPmAgK1xuICAgICAgICBgPHNwYW4gY2xhc3M9XCJzdGF0ZVwiPiR7dC5zdGF0ZSA9PT0gXCJydW5uaW5nXCIgPyAnPHNwYW4gY2xhc3M9XCJzcGluXCI+PC9zcGFuPicgOiBcIlwifSR7ZXNjYXBlSHRtbCh0LnN0YXRlKX08L3NwYW4+YCArXG4gICAgICAgIGA8c3BhbiBjbGFzcz1cImFnZVwiPiR7ZWxhcHNlZChhZ2UpfTwvc3Bhbj5gICtcbiAgICAgIGA8L2Rpdj5gICtcbiAgICAgIGA8ZGl2IGNsYXNzPVwicFwiPjwvZGl2PmA7XG4gICAgY29uc3QgbGFiZWxFbCA9IGNhcmQucXVlcnlTZWxlY3RvcihcIi5sYWJlbFwiKSBhcyBIVE1MRWxlbWVudDtcbiAgICBsYWJlbEVsLnRleHRDb250ZW50ID0gdC5sYWJlbDtcbiAgICBsYWJlbEVsLnRpdGxlID0gdC5sYWJlbDtcbiAgICBjYXJkLnF1ZXJ5U2VsZWN0b3IoXCIucFwiKSEudGV4dENvbnRlbnQgPSB0LnByb2dyZXNzID8/IHQucmVxdWVzdDtcbiAgICBpZiAodC5xdWVzdGlvbikge1xuICAgICAgY29uc3QgcSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICBxLmNsYXNzTmFtZSA9IFwicVwiO1xuICAgICAgcS50ZXh0Q29udGVudCA9IGBBc2tzOiAke3QucXVlc3Rpb259YDtcbiAgICAgIGNhcmQuYXBwZW5kKHEpO1xuICAgIH1cbiAgICBpZiAodmlldy5hcHByb3ZhbCAmJiB0LnN0YXRlID09PSBcInJ1bm5pbmdcIikge1xuICAgICAgY29uc3QgYm94ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgIGJveC5jbGFzc05hbWUgPSBcImFwcHJvdmFsXCI7XG4gICAgICBib3guaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9XCJhcHByb3ZhbC1oZWFkXCI+SGVybWVzIGFza3MgdG8gcnVuPC9kaXY+PGNvZGU+PC9jb2RlPjxkaXYgY2xhc3M9XCJhY3RzXCI+PC9kaXY+YDtcbiAgICAgIGJveC5xdWVyeVNlbGVjdG9yKFwiY29kZVwiKSEudGV4dENvbnRlbnQgPSB2aWV3LmFwcHJvdmFsLmNvbW1hbmQ7XG4gICAgICBjb25zdCBhbnN3ZXIgPSAoY2hvaWNlOiBcIm9uY2VcIiB8IFwiZGVueVwiKSA9PiB7XG4gICAgICAgIHZpZXcuYXBwcm92YWwgPSB1bmRlZmluZWQ7XG4gICAgICAgIHNob3dUYXNrcyh0cnVlKTtcbiAgICAgICAgdm9pZCBmZXRjaChcIi9oZXJtZXMvYXBwcm92YWxcIiwgeyBtZXRob2Q6IFwiUE9TVFwiLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGNhbGw6IGNhbGxOYW1lLCB0YXNrSWQ6IHQuaWQsIGNob2ljZSB9KSB9KVxuICAgICAgICAgIC50aGVuKChyKSA9PiB0b2FzdChyLm9rID8gKGNob2ljZSA9PT0gXCJvbmNlXCIgPyBcIkFwcHJvdmVkXCIgOiBcIkRlbmllZFwiKSA6IFwiVGhhdCBhcHByb3ZhbCBoYWQgYWxyZWFkeSBsYXBzZWRcIikpO1xuICAgICAgfTtcbiAgICAgIGZvciAoY29uc3QgW2xhYmVsLCBjaG9pY2VdIG9mIFtbXCJBcHByb3ZlIG9uY2VcIiwgXCJvbmNlXCJdLCBbXCJEZW55XCIsIFwiZGVueVwiXV0gYXMgY29uc3QpIHtcbiAgICAgICAgY29uc3QgYiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gICAgICAgIGIudHlwZSA9IFwiYnV0dG9uXCI7XG4gICAgICAgIGIudGV4dENvbnRlbnQgPSBsYWJlbDtcbiAgICAgICAgaWYgKGNob2ljZSA9PT0gXCJvbmNlXCIpIGIuY2xhc3NOYW1lID0gXCJnb1wiO1xuICAgICAgICBlbHNlIGIuY2xhc3NOYW1lID0gXCJkYW5nZXJcIjtcbiAgICAgICAgYi5vbmNsaWNrID0gKCkgPT4gYW5zd2VyKGNob2ljZSk7XG4gICAgICAgIGJveC5xdWVyeVNlbGVjdG9yKFwiLmFjdHNcIikhLmFwcGVuZChiKTtcbiAgICAgIH1cbiAgICAgIGNhcmQuYXBwZW5kKGJveCk7XG4gICAgfVxuICAgIGlmICh0LnN0YXRlICE9PSBcInJ1bm5pbmdcIikgdmlldy5hcHByb3ZhbCA9IHVuZGVmaW5lZDtcbiAgICBjb25zdCBhY3RzID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBhY3RzLmNsYXNzTmFtZSA9IFwiYWN0c1wiO1xuICAgIGNvbnN0IGJ1dHRvbiA9ICh0ZXh0OiBzdHJpbmcsIGZuOiAoKSA9PiB2b2lkLCBjbHMgPSBcIlwiKSA9PiB7XG4gICAgICBjb25zdCBiID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgICAgIGIudHlwZSA9IFwiYnV0dG9uXCI7XG4gICAgICBiLnRleHRDb250ZW50ID0gdGV4dDtcbiAgICAgIGlmIChjbHMpIGIuY2xhc3NOYW1lID0gY2xzO1xuICAgICAgYi5vbmNsaWNrID0gZm47XG4gICAgICBhY3RzLmFwcGVuZChiKTtcbiAgICAgIHJldHVybiBiO1xuICAgIH07XG4gICAgaWYgKGNhbGxJZCAmJiBhY3RpdmVTZXNzaW9uID4gMCkge1xuICAgICAgY29uc3Qgb3JpZ2luU2Vzc2lvbiA9IGFjdGl2ZVNlc3Npb247XG4gICAgICBidXR0b24od2FpdGluZyA/IFwiQW5zd2VyXCIgOiBcIkZvbGxvdyB1cFwiLCAoKSA9PiBmb2xsb3dVcEZvcm0oY2FyZCwgdCwgb3JpZ2luU2Vzc2lvbikpO1xuICAgICAgaWYgKHQuc3RhdGUgPT09IFwicnVubmluZ1wiKSBidXR0b24oXCJDYW5jZWxcIiwgKCkgPT4gcHVzaCh7IHR5cGU6IFwiY2FuY2VsVGFza1wiLCB0YXNrOiB0LmlkIH0pLCBcImRhbmdlclwiKTtcbiAgICB9XG4gICAgaWYgKHZpZXcucmVzdWx0SWQpIGJ1dHRvbihcIlJlc3VsdFwiLCAoKSA9PiBmb2N1c1Jlc3VsdCh2aWV3LnJlc3VsdElkISkpO1xuICAgIGlmICh2aWV3LnRocmVhZCkgYnV0dG9uKFwiQ29weSBpZFwiLCAoKSA9PiB7IHZvaWQgbmF2aWdhdG9yLmNsaXBib2FyZD8ud3JpdGVUZXh0KHZpZXcudGhyZWFkISk7IHRvYXN0KFwiVGhyZWFkIGlkIGNvcGllZFwiKTsgfSk7XG4gICAgaWYgKGFjdHMuY2hpbGRFbGVtZW50Q291bnQpIGNhcmQuYXBwZW5kKGFjdHMpO1xuICAgIChpc0FjdGl2ZVRhc2sodmlldykgPyBwYW5lIDogZG9uZSkuYXBwZW5kKGNhcmQpO1xuICB9XG4gIGlmIChwYW5lLmNoaWxkRWxlbWVudENvdW50ID09PSAwKSBwYW5lLmFwcGVuZChub1Rhc2tzKTtcbiAgc3luY1NpZGVMYXlvdXQoKTtcbiAgdXBkYXRlVGFza0Nocm9tZSgpO1xufVxuXG5mdW5jdGlvbiBmb2xsb3dVcEZvcm0oY2FyZDogSFRNTEVsZW1lbnQsIHQ6IENvbW1hbmQsIG9yaWdpblNlc3Npb246IG51bWJlcikge1xuICBjb25zdCBleGlzdGluZyA9IGNhcmQucXVlcnlTZWxlY3RvcihcImZvcm1cIik7XG4gIGlmIChleGlzdGluZykgeyBleGlzdGluZy5xdWVyeVNlbGVjdG9yKFwiaW5wdXRcIik/LmZvY3VzKCk7IHJldHVybjsgfVxuICBjb25zdCBmb3JtID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImZvcm1cIik7XG4gIGZvcm0uY2xhc3NOYW1lID0gXCJmb2xsb3d1cC1mb3JtXCI7XG4gIGZvcm0uaW5uZXJIVE1MID0gYDxpbnB1dCB0eXBlPVwidGV4dFwiIHBsYWNlaG9sZGVyPVwiVGVsbCBcdTIwMUMke2VzY2FwZUh0bWwodC5sYWJlbCl9XHUyMDFEXHUyMDI2XCIgZW50ZXJrZXloaW50PVwic2VuZFwiPjxidXR0b24gdHlwZT1cInN1Ym1pdFwiPlNlbmQ8L2J1dHRvbj5gO1xuICBjb25zdCBpbnB1dCA9IGZvcm0ucXVlcnlTZWxlY3RvcihcImlucHV0XCIpITtcbiAgZm9ybS5vbnN1Ym1pdCA9IChlKSA9PiB7XG4gICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGNvbnN0IHRleHQgPSBpbnB1dC52YWx1ZS50cmltKCk7XG4gICAgaWYgKHRleHQpIHtcbiAgICAgIGlmICghY2FuRm9sbG93VXBSZXN1bHQob3JpZ2luU2Vzc2lvbiwgYWN0aXZlU2Vzc2lvbiwgdGFza3MuaGFzKHQuaWQpKSkge1xuICAgICAgICB0b2FzdChcIlRoYXQgdGFzaydzIGNhbGwgaGFzIGVuZGVkXCIpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcHVzaCh7IHR5cGU6IFwic3RlZXJcIiwgdGFzazogdC5pZCwgdGV4dCB9KTtcbiAgICAgICAgbm90ZShgWW91IFx1MjE5MiAke3QubGFiZWx9OiAke3RleHR9YCk7XG4gICAgICAgIHNjcm9sbERvd24odHJ1ZSk7XG4gICAgICB9XG4gICAgfVxuICAgIGlucHV0LmJsdXIoKTtcbiAgICBmb3JtLnJlbW92ZSgpO1xuICAgIHNob3dUYXNrcygpO1xuICB9O1xuICBpbnB1dC5vbmtleWRvd24gPSAoZSkgPT4geyBpZiAoZS5rZXkgPT09IFwiRXNjYXBlXCIpIHsgZS5zdG9wUHJvcGFnYXRpb24oKTsgaW5wdXQuYmx1cigpOyBmb3JtLnJlbW92ZSgpOyBzaG93VGFza3MoKTsgfSB9O1xuICBjYXJkLmFwcGVuZChmb3JtKTtcbiAgaW5wdXQuZm9jdXMoKTtcbn1cblxuLyoqIFQzIHRocmVhZHMgZWFybGllciBjYWxscyBzdGFydGVkOiB0aGV5IGNhcnJ5IG9uIGFmdGVyIGEgY2FsbCwgc28gdGhlIHBhbmVsIHNheXMgaG93IHRoZXkncmUgZG9pbmcuICovXG5hc3luYyBmdW5jdGlvbiBzaG93RWFybGllcigpIHtcbiAgbGV0IGxpc3Q6IHsgdGhyZWFkOiBzdHJpbmc7IHRpdGxlOiBzdHJpbmc7IHN0YXR1czogc3RyaW5nOyBicmFuY2g6IHN0cmluZyB8IG51bGw7IHByOiBzdHJpbmcgfCBudWxsOyB1cGRhdGVkOiBzdHJpbmc7IGxhc3Q6IHN0cmluZzsgd2FpdGluZzogYm9vbGVhbiB9W10gPSBbXTtcbiAgdHJ5IHsgbGlzdCA9IGF3YWl0IChhd2FpdCBmZXRjaChcIi9hZ2VudC9yZWNlbnRcIiwgeyBjYWNoZTogXCJuby1zdG9yZVwiIH0pKS5qc29uKCk7IH0gY2F0Y2gge31cbiAgY29uc3QgY3VycmVudCA9IG5ldyBTZXQoWy4uLnRhc2tzLnZhbHVlcygpXS5tYXAoKHYpID0+IHYudGhyZWFkKS5maWx0ZXIoQm9vbGVhbikpO1xuICBsaXN0ID0gbGlzdC5maWx0ZXIoKHQpID0+ICFjdXJyZW50Lmhhcyh0LnRocmVhZCkpO1xuICBjb25zdCBwYW5lID0gJChcImVhcmxpZXJcIik7XG4gIGNvbnN0IGRvbmUgPSAkKFwiZG9uZWVhcmxpZXJcIik7XG4gIHBhbmUuaW5uZXJIVE1MID0gXCJcIjtcbiAgZG9uZS5pbm5lckhUTUwgPSBcIlwiO1xuICBlYXJsaWVyQWN0aXZlQ291bnQgPSAwO1xuICBlYXJsaWVyV2FpdGluZ0NvdW50ID0gMDtcbiAgZm9yIChjb25zdCB0IG9mIGxpc3QpIHtcbiAgICBjb25zdCBjYXJkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBjb25zdCBzdGF0ZSA9IHQud2FpdGluZyA/IFwid2FpdGluZyBmb3IgYXBwcm92YWwgaW4gVDNcIiA6IHQuc3RhdHVzO1xuICAgIGNhcmQuY2xhc3NOYW1lID0gYHRhc2sgJHt0LnN0YXR1cyA9PT0gXCJydW5uaW5nXCIgPyBcInJ1bm5pbmdcIiA6IHQud2FpdGluZyA/IFwid2FpdGluZ1wiIDogXCJmaW5pc2hlZFwifWA7XG4gICAgY29uc3QgYWdvID0gTWF0aC5tYXgoMCwgKERhdGUubm93KCkgLSBEYXRlLnBhcnNlKHQudXBkYXRlZCkpIC8gMTAwMCk7XG4gICAgY2FyZC5pbm5lckhUTUwgPVxuICAgICAgYDxkaXYgY2xhc3M9XCJtZXRhLXJvd1wiPmAgK1xuICAgICAgICBgPHNwYW4gY2xhc3M9XCJiYWRnZSB0M1wiPlQzPC9zcGFuPmAgK1xuICAgICAgICBgPHNwYW4gY2xhc3M9XCJsYWJlbFwiPjwvc3Bhbj5gICtcbiAgICAgICAgYDxzcGFuIGNsYXNzPVwic3RhdGVcIj4ke3Quc3RhdHVzID09PSBcInJ1bm5pbmdcIiA/ICc8c3BhbiBjbGFzcz1cInNwaW5cIj48L3NwYW4+JyA6IFwiXCJ9JHtlc2NhcGVIdG1sKHN0YXRlKX08L3NwYW4+YCArXG4gICAgICAgIGA8c3BhbiBjbGFzcz1cImFnZVwiPiR7ZWxhcHNlZChhZ28pfSBhZ288L3NwYW4+YCArXG4gICAgICBgPC9kaXY+YCArXG4gICAgICBgPGRpdiBjbGFzcz1cInBcIj48L2Rpdj5gO1xuICAgIGNvbnN0IGxhYmVsRWwgPSBjYXJkLnF1ZXJ5U2VsZWN0b3IoXCIubGFiZWxcIikgYXMgSFRNTEVsZW1lbnQ7XG4gICAgbGFiZWxFbC50ZXh0Q29udGVudCA9IHQudGl0bGU7XG4gICAgbGFiZWxFbC50aXRsZSA9IHQudGl0bGU7XG4gICAgY2FyZC5xdWVyeVNlbGVjdG9yKFwiLnBcIikhLnRleHRDb250ZW50ID0gdC5sYXN0IHx8ICh0LmJyYW5jaCA/IGBPbiAke3QuYnJhbmNofWAgOiBcIlwiKTtcbiAgICBjb25zdCBhY3RzID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBhY3RzLmNsYXNzTmFtZSA9IFwiYWN0c1wiO1xuICAgIGlmICh0LnByKSB7IGNvbnN0IGEgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYVwiKTsgYS5ocmVmID0gdC5wcjsgYS50YXJnZXQgPSBcIl9ibGFua1wiOyBhLnJlbCA9IFwibm9vcGVuZXJcIjsgYS50ZXh0Q29udGVudCA9IFwiUFIgXHUyMTk3XCI7IGFjdHMuYXBwZW5kKGEpOyB9XG4gICAgY29uc3QgY29weSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gICAgY29weS50eXBlID0gXCJidXR0b25cIjtcbiAgICBjb3B5LnRleHRDb250ZW50ID0gXCJDb3B5IGlkXCI7XG4gICAgY29weS5vbmNsaWNrID0gKCkgPT4geyB2b2lkIG5hdmlnYXRvci5jbGlwYm9hcmQ/LndyaXRlVGV4dCh0LnRocmVhZCk7IHRvYXN0KFwiVGhyZWFkIGlkIGNvcGllZFwiKTsgfTtcbiAgICBhY3RzLmFwcGVuZChjb3B5KTtcbiAgICBjYXJkLmFwcGVuZChhY3RzKTtcbiAgICBjb25zdCBhY3RpdmUgPSB0LnN0YXR1cyA9PT0gXCJydW5uaW5nXCIgfHwgdC53YWl0aW5nO1xuICAgIGlmIChhY3RpdmUpIGVhcmxpZXJBY3RpdmVDb3VudCsrO1xuICAgIGlmICh0LndhaXRpbmcpIGVhcmxpZXJXYWl0aW5nQ291bnQrKztcbiAgICAoYWN0aXZlID8gcGFuZSA6IGRvbmUpLmFwcGVuZChjYXJkKTtcbiAgfVxuICBzeW5jU2lkZUxheW91dCgpO1xuICB1cGRhdGVUYXNrQ2hyb21lKCk7XG59XG5cbmNvbnN0IFNUQVRVU19URVhUOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICBpZGxlOiBcIklkbGVcIiwgY29ubmVjdGluZzogXCJDb25uZWN0aW5nXHUyMDI2XCIsIGxpc3RlbmluZzogXCJMaXN0ZW5pbmdcIiwgd29ya2luZzogXCJMaXN0ZW5pbmcgXHUwMEI3IHRhc2tzIHJ1bm5pbmdcIixcbiAgZG9ybWFudDogXCJEb3JtYW50IFx1MDBCNyB3YWl0aW5nIGZvciB3YWtlIHdvcmRcIixcbiAgc3RhbmRieTogXCJQYXVzZWQgd2hpbGUgdGFza3MgcnVuIFx1MDBCNyBzcGVhayB0byByZXN1bWVcIiwgd2FraW5nOiBcIlJlc3VtaW5nXHUyMDI2XCIsIGVuZGVkOiBcIkVuZGVkXCIsXG59O1xuXG5mdW5jdGlvbiBzaG93U3RhdHVzKG1lc3NhZ2U/OiBzdHJpbmcpIHtcbiAgY29uc3QgdHlwZWQgPSBCb29sZWFuKGNhbGxJZCkgJiYgbWVkaXVtID09PSBcInRleHRcIjtcbiAgY29uc3Qgc3BlYWtpbmcgPSBCb29sZWFuKGNhbGxJZCkgJiYgIXR5cGVkICYmIGNvcmVTdGF0dXMgIT09IFwic3RhbmRieVwiICYmIGNvcmVTdGF0dXMgIT09IFwiZG9ybWFudFwiICYmIGF1ZGlvLnF1ZXVlZCA+IDAuMDU7XG4gIGNvbnN0IGFybWVkSWRsZSA9ICFjYWxsSWQgJiYgd2FrZUFybWVkO1xuICBjb25zdCBzaG93biA9IGNhbGxJZFxuICAgID8gKHNwZWFraW5nIHx8ICh0eXBlZCAmJiB0aGlua2luZykgPyBcInNwZWFraW5nXCIgOiBjb3JlU3RhdHVzKVxuICAgIDogYXJtZWRJZGxlID8gXCJhcm1lZFwiIDogY29yZVN0YXR1cztcbiAgJChcInN0YXR1c1wiKS5jbGFzc05hbWUgPSBzaG93bjtcbiAgZG9jdW1lbnQuYm9keS5kYXRhc2V0LnN0YXRlID0gY2FsbElkID8gc2hvd24gOiBhcm1lZElkbGUgPyBcImFybWVkXCIgOiBcImlkbGVcIjtcbiAgZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QudG9nZ2xlKFwiaW4tc2Vzc2lvblwiLCBCb29sZWFuKGNhbGxJZCkpO1xuICBjb25zdCB3YWtlTGFiZWwgPSBzZWxlY3RlZFdha2VNb2RlbCgpPy5sYWJlbCA/PyBcIndha2Ugd29yZFwiO1xuICBsZXQgdGV4dCA9IGFybWVkSWRsZVxuICAgID8gKHdha2VMb2FkaW5nID8gYExvYWRpbmcgXHUyMDFDJHt3YWtlTGFiZWx9XHUyMDFEXHUyMDI2YFxuICAgICAgOiBhdWRpby5hdWRpb1N1c3BlbmRlZCA/IGBUYXAgYW55d2hlcmUgdG8gYWN0aXZhdGUgXHUyMDFDJHt3YWtlTGFiZWx9XHUyMDFEYFxuICAgICAgOiBgV2FpdGluZyBmb3IgXHUyMDFDJHt3YWtlTGFiZWx9XHUyMDFEYClcbiAgICA6IHNwZWFraW5nID8gXCJTcGVha2luZ1wiXG4gICAgOiBjb3JlU3RhdHVzID09PSBcImRvcm1hbnRcIiA/IGBEb3JtYW50IFx1MDBCNyBzYXkgXHUyMDFDJHt3YWtlTGFiZWx9XHUyMDFEYFxuICAgIDogU1RBVFVTX1RFWFRbY29yZVN0YXR1c10gPz8gY29yZVN0YXR1cztcbiAgaWYgKHR5cGVkICYmIGNvcmVTdGF0dXMgIT09IFwiZW5kZWRcIikgdGV4dCA9IHRoaW5raW5nID8gXCJXcml0aW5nXHUyMDI2XCIgOiBjb3JlU3RhdHVzID09PSBcIndvcmtpbmdcIiA/IFwiQ2hhdCBcdTAwQjcgdGFza3MgcnVubmluZ1wiIDogXCJDaGF0XCI7XG4gIGlmIChjYWxsSWQgJiYgIXR5cGVkICYmIG11dGVkICYmICFob2xkaW5nICYmICFzcGVha2luZykgdGV4dCArPSBcIiBcdTAwQjcgbXV0ZWRcIjtcbiAgaWYgKGhvbGRpbmcpIHRleHQgPSBcIlRhbGtpbmcgKGhvbGQpXCI7XG4gIGlmIChtZXNzYWdlKSB0ZXh0ID0gYCR7dGV4dH06ICR7bWVzc2FnZX1gO1xuICBpZiAoY29yZVN0YXR1cyAhPT0gXCJlbmRlZFwiIHx8IG1lc3NhZ2UgfHwgYXJtZWRJZGxlKSAkKFwic3RhdHVzdGV4dFwiKS50ZXh0Q29udGVudCA9IHRleHQ7XG4gICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiaHVzaFwiKS5jbGFzc0xpc3QudG9nZ2xlKFwibGl2ZVwiLCBzcGVha2luZyB8fCAodHlwZWQgJiYgdGhpbmtpbmcpKTtcblxuICBjb25zdCBiYXIgPSAkKFwiY2FsbGJhclwiKTtcbiAgYmFyLmhpZGRlbiA9ICFjYWxsSWQ7XG4gICQoXCJ3YWtlLW5vd1wiKS5oaWRkZW4gPSAhKGNhbGxJZCAmJiAhdHlwZWQgJiYgKGNvcmVTdGF0dXMgPT09IFwiZG9ybWFudFwiIHx8IGNvcmVTdGF0dXMgPT09IFwic3RhbmRieVwiKSk7XG4gIGlmIChjYWxsSWQpIHtcbiAgICAkKFwiY2FsbGJhci1zdGF0ZVwiKS50ZXh0Q29udGVudCA9IHRleHQ7XG4gICAgJChcImNhbGx0aW1lclwiKS5oaWRkZW4gPSB0eXBlZDtcbiAgICBpZiAoIXR5cGVkKSAkKFwiY2FsbHRpbWVyXCIpLnRleHRDb250ZW50ID0gZm9ybWF0Q2xvY2sobm93KCkgLSBzdGFydGVkQXQpO1xuICAgIGNvbnN0IHZpek1vZGUgPSB0eXBlZCA/ICh0aGlua2luZyA/IFwidGhpbmtpbmdcIiA6IFwiaWRsZVwiKVxuICAgICAgOiBzcGVha2luZyA/IFwic3BlYWtpbmdcIlxuICAgICAgOiBtdXRlZCAmJiAhaG9sZGluZyA/IFwibXV0ZWRcIlxuICAgICAgOiBzaG93bjtcbiAgICB1cGRhdGVWaXN1YWxpemVyKHZpek1vZGUsIG11dGVkICYmICFob2xkaW5nID8gMCA6IGF1ZGlvLmxldmVsKTtcbiAgfVxufVxuXG4vLyBUaGUgY2FsbC5cblxuZnVuY3Rpb24gcHVzaChldmVudDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBDb21tYW5kW10ge1xuICBpZiAoIWNvcmUgfHwgIWNhbGxJZCkgcmV0dXJuIFtdO1xuICBjb25zdCBlOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgLi4uZXZlbnQsIHQ6IG5vdygpIH07XG4gIGNvbnN0IHF1aWV0ID0gZS50eXBlID09PSBcIm1pY1wiIHx8IGUudHlwZSA9PT0gXCJ0aWNrXCI7XG4gIGlmICghcXVpZXQpIGxvZyhcImluXCIsIGUudHlwZSA9PT0gXCJ3cy5tZXNzYWdlXCIgPyBgd3MgJHtlLnNpZH0gXHUyMTkwICR7YnJpZWYoU3RyaW5nKGUuZGF0YSkpfWAgOiBKU09OLnN0cmluZ2lmeShlKS5zbGljZSgwLCA0MDApLCBcImluXCIpO1xuICBjb25zdCBjb21tYW5kcyA9IEpTT04ucGFyc2UoY29yZS5wdXNoKGNhbGxJZCwgSlNPTi5zdHJpbmdpZnkoZSkpKSBhcyBDb21tYW5kW107XG4gIHJ1bihjb21tYW5kcyk7XG4gIHJldHVybiBjb21tYW5kcztcbn1cblxuZnVuY3Rpb24gcnVuKGNvbW1hbmRzOiBDb21tYW5kW10pIHtcbiAgZm9yIChjb25zdCBjIG9mIGNvbW1hbmRzKSB7XG4gICAgc3dpdGNoIChjLnR5cGUpIHtcbiAgICAgIGNhc2UgXCJ3cy5jb25uZWN0XCI6IGNvbm5lY3QoYy5zaWQsIGMucHVycG9zZSA9PT0gXCJjYXB0aW9uc1wiKTsgYnJlYWs7XG4gICAgICBjYXNlIFwid3Muc2VuZFwiOiB7XG4gICAgICAgIHNvY2tldHMuZ2V0KGMuc2lkKT8uc2VuZChjLmRhdGEpO1xuICAgICAgICBpZiAoIWMuZGF0YS5zdGFydHNXaXRoKCd7XCJyZWFsdGltZUlucHV0XCI6e1wiYXVkaW9cIicpKSBsb2coXCJvdXRcIiwgYHdzICR7Yy5zaWR9IFx1MjE5MiAke2JyaWVmKGMuZGF0YSl9YCwgXCJvdXRcIik7XG4gICAgICAgIGVsc2UgaWYgKCFjYXB0aW9uU29ja2V0cy5oYXMoYy5zaWQpKSBjb3VudHMuc2VudCsrO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ3cy5jbG9zZVwiOiBzb2NrZXRzLmdldChjLnNpZCk/LmNsb3NlKCk7IHNvY2tldHMuZGVsZXRlKGMuc2lkKTsgbG9nKFwib3V0XCIsIGB3cyAke2Muc2lkfSBjbG9zZWAsIFwib3V0XCIpOyBicmVhaztcbiAgICAgIGNhc2UgXCJtaWMuc3RhcnRcIjoge1xuICAgICAgICBsb2coXCJvdXRcIiwgYy50eXBlLCBcIm91dFwiKTtcbiAgICAgICAgY29uc3QgcGVuZGluZ09wZW5pbmcgPSB3YWtlU3RhcnRpbmcgPyBvcGVuaW5nQ2h1bmtzLnNwbGljZSgwKSA6IFtdO1xuICAgICAgICBvcGVuaW5nQnl0ZXMgPSAwO1xuICAgICAgICB3YWtlU3RhcnRpbmcgPSBmYWxzZTtcbiAgICAgICAgdm9pZCBhdWRpby5lbnN1cmVNaWMob25NaWMsIG1pY09wdGlvbnMoKSkuY2F0Y2goKGVycikgPT4geyBsb2coXCJlcnJvclwiLCBgbWljcm9waG9uZTogJHtlcnIubWVzc2FnZX1gLCBcImVyclwiKTsgdG9hc3QoYE1pY3JvcGhvbmU6ICR7ZXJyLm1lc3NhZ2V9YCk7IH0pO1xuICAgICAgICBpZiAocGVuZGluZ09wZW5pbmcubGVuZ3RoID4gMCkge1xuICAgICAgICAgIGNvbnN0IHRvdGFsTXMgPSBNYXRoLnJvdW5kKHBlbmRpbmdPcGVuaW5nLnJlZHVjZSgocywgYikgPT4gcyArIGIuYnl0ZUxlbmd0aCwgMCkgLyAzMik7XG4gICAgICAgICAgbG9nKFwib3V0XCIsIGBmbHVzaGluZyAke3RvdGFsTXN9IG1zIHNwb2tlbiBhZnRlciB3YWtlIHdvcmRgLCBcIm91dFwiKTtcbiAgICAgICAgICBxdWV1ZU1pY3JvdGFzaygoKSA9PiB7XG4gICAgICAgICAgICBpZiAoIWNhbGxJZCkgcmV0dXJuO1xuICAgICAgICAgICAgZm9yIChjb25zdCBjaHVuayBvZiBwZW5kaW5nT3BlbmluZykge1xuICAgICAgICAgICAgICBpZiAoIWNhbGxJZCkgYnJlYWs7XG4gICAgICAgICAgICAgIGNvdW50cy5taWMrKztcbiAgICAgICAgICAgICAgcHVzaCh7IHR5cGU6IFwibWljXCIsIHBjbTogYnl0ZXNUb0Jhc2U2NChjaHVuaykgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwibWljLnJlc3RhcnRcIjpcbiAgICAgICAgbG9nKFwib3V0XCIsIGMudHlwZSwgXCJvdXRcIik7XG4gICAgICAgIHZvaWQgYXVkaW8uc3RhcnRNaWMob25NaWMsIG1pY09wdGlvbnMoKSkuY2F0Y2goKGVycikgPT4geyBsb2coXCJlcnJvclwiLCBgbWljcm9waG9uZTogJHtlcnIubWVzc2FnZX1gLCBcImVyclwiKTsgdG9hc3QoYE1pY3JvcGhvbmU6ICR7ZXJyLm1lc3NhZ2V9YCk7IH0pO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJtaWMuc3RvcFwiOlxuICAgICAgICBpZiAoIXdha2VBcm1lZCkgYXVkaW8uc3RvcE1pYygpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJwbGF5XCI6IHtcbiAgICAgICAgY29uc3QgdCA9IG5vdygpO1xuICAgICAgICAvLyBBIHJlcGx5IHN0YXJ0aW5nOiBmcm9tIHRoZSBlbmQgb2YgdGhlIHVzZXIncyBzcGVlY2ggdG8gaXRzIGZpcnN0IHNvdW5kLlxuICAgICAgICBpZiAoIW1ldHJpY3MucmVwbGllZCAmJiBhdWRpby5xdWV1ZWQgPCAwLjA1ICYmIHQgLSBtZXRyaWNzLmxhc3RQbGF5ID4gMC42ICYmIG1ldHJpY3MubGFzdFZvaWNlID4gMCAmJiB0IC0gbWV0cmljcy5sYXN0Vm9pY2UgPCAxMCkge1xuICAgICAgICAgIG1ldHJpY3MucmVwbHkucHVzaCh0IC0gbWV0cmljcy5sYXN0Vm9pY2UpO1xuICAgICAgICAgIGlmIChtZXRyaWNzLnJlcGx5Lmxlbmd0aCA+IDIwKSBtZXRyaWNzLnJlcGx5LnNoaWZ0KCk7XG4gICAgICAgICAgbWV0cmljcy5yZXBsaWVkID0gdHJ1ZTtcbiAgICAgICAgICBzaG93TWV0cmljcygpO1xuICAgICAgICB9XG4gICAgICAgIG1ldHJpY3MubGFzdFBsYXkgPSB0O1xuICAgICAgICBhdWRpby5wbGF5KGMucGNtKTtcbiAgICAgICAgY291bnRzLnBsYXkrKztcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwiZmx1c2hcIjogYXVkaW8uZmx1c2goKTsgbG9nKFwib3V0XCIsIFwiZmx1c2hcIiwgXCJvdXRcIik7IGJyZWFrO1xuICAgICAgY2FzZSBcImN1ZVwiOlxuICAgICAgICBhdWRpby5jdWUoYy5wY20pO1xuICAgICAgICBsb2coXCJvdXRcIiwgYGN1ZSAke2MuZWFyY29ufWAsIFwib3V0XCIpO1xuICAgICAgICAvLyBBIHJlcXVlc3QgdGhhdCBiZWNhbWUgYSB0YXNrIGdldHMgYSB0b25lLCBub3QgYSBzcG9rZW4gcmVwbHk6IG5vdGhpbmcgdG8gdGltZS5cbiAgICAgICAgaWYgKGMuZWFyY29uID09PSBcInRhc2tTdGFydGVkXCIpIG1ldHJpY3MucmVwbGllZCA9IHRydWU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcIndha2V3b3JkXCI6IGVuc3VyZUNvcmVXYWtlKEJvb2xlYW4oYy5vbikpOyBicmVhaztcbiAgICAgIGNhc2UgXCJ0b29sLmNhbGxcIjogdm9pZCB0b29sKGMpOyBicmVhaztcbiAgICAgIGNhc2UgXCJ0b29sLmNhbmNlbFwiOiBjYW5jZWxSdW4oYy5ydW4sIGMucmVhc29uKTsgYnJlYWs7XG4gICAgICBjYXNlIFwidG9vbC5zdGVlclwiOiB2b2lkIHN0ZWVyUnVuKGMpOyBicmVhaztcbiAgICAgIGNhc2UgXCJzdGF0dXNcIjoge1xuICAgICAgICBjb25zdCBwcmV2ID0gY29yZVN0YXR1cztcbiAgICAgICAgY29yZVN0YXR1cyA9IGMuc3RhdHVzO1xuICAgICAgICBpZiAoYy5zdGF0dXMgPT09IFwiZG9ybWFudFwiICYmIHByZXYgIT09IFwiZG9ybWFudFwiICYmIGNoZWNrZWQoXCJ3YWtlLWN1ZVwiKSkgYXVkaW8uY3VlKFNMRUVQX1RPTkUpO1xuICAgICAgICBzaG93U3RhdHVzKGMuc3RhdHVzID09PSBcImVuZGVkXCIgPyBjLm1lc3NhZ2UgPz8gdW5kZWZpbmVkIDogdW5kZWZpbmVkKTtcbiAgICAgICAgbG9nKFwic3RhdHVzXCIsIGMuc3RhdHVzICsgKGMubWVzc2FnZSA/IGA6ICR7Yy5tZXNzYWdlfWAgOiBcIlwiKSwgXCJzdGF0dXNcIik7XG4gICAgICAgIGlmIChjLnN0YXR1cyA9PT0gXCJlbmRlZFwiKSB7IGlmIChjLm1lc3NhZ2UpIG5vdGUoYy5tZXNzYWdlKTsgZW5kKCk7IH1cbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwibGxtLnJlcXVlc3RcIjogdm9pZCBnZW5lcmF0ZShjLmlkLCBjLmJvZHkpOyBicmVhaztcbiAgICAgIGNhc2UgXCJsbG0uY2FuY2VsXCI6IHJlcXVlc3RzLmdldChjLmlkKT8uYWJvcnQoKTsgcmVxdWVzdHMuZGVsZXRlKGMuaWQpOyBsb2coXCJvdXRcIiwgYHJlcXVlc3QgJHtjLmlkfSBkcm9wcGVkYCwgXCJvdXRcIik7IGJyZWFrO1xuICAgICAgY2FzZSBcInRoaW5raW5nXCI6IHRoaW5raW5nID0gYy5vbjsgc2hvd1N0YXR1cygpOyBicmVhaztcbiAgICAgIGNhc2UgXCJlcnJvclwiOiBub3RlKGMubWVzc2FnZSk7IGxvZyhcImVycm9yXCIsIGMubWVzc2FnZSwgXCJlcnJcIik7IGJyZWFrO1xuICAgICAgY2FzZSBcImNhcHRpb25cIjogY2FwdGlvbihjLnRleHQpOyBicmVhaztcbiAgICAgIGNhc2UgXCJ0cmFuc2NyaXB0XCI6XG4gICAgICAgIHRyYW5zY3JpcHQoYy5yb2xlLCBjLnRleHQsIGMubGluZSk7XG4gICAgICAgIHJlbWVtYmVyKGMucm9sZSwgYy50ZXh0LCBjLnJvbGUgPT09IFwiYXNzaXN0YW50XCIgPyBcIkdlbWluaVwiIDogdW5kZWZpbmVkLCBsYXN0TGluZSA9PT0gYy5saW5lKTtcbiAgICAgICAgbGFzdExpbmUgPSBjLmxpbmU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcInRhc2tcIjoge1xuICAgICAgICBjb25zdCB2aWV3ID0gdGFza3MuZ2V0KGMuaWQpID8/IHsgYywgc2luY2U6IG5vdygpLCBlbmRlZDogbnVsbCB9O1xuICAgICAgICBpZiAoYy5zdGF0ZSA9PT0gXCJydW5uaW5nXCIgJiYgdmlldy5jLnN0YXRlICE9PSBcInJ1bm5pbmdcIikgeyB2aWV3LnNpbmNlID0gbm93KCk7IHZpZXcuZW5kZWQgPSBudWxsOyB9XG4gICAgICAgIGlmIChjLnN0YXRlICE9PSBcInJ1bm5pbmdcIiAmJiB2aWV3LmVuZGVkID09IG51bGwpIHZpZXcuZW5kZWQgPSBub3coKTtcbiAgICAgICAgdmlldy5jID0gYztcbiAgICAgICAgdGFza3Muc2V0KGMuaWQsIHZpZXcpO1xuICAgICAgICBzaG93VGFza3MoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwicXVlc3Rpb25zXCI6IGJyZWFrO1xuICAgICAgY2FzZSBcIm1pY1NpbGVudFwiOiAkKFwibWljd2FyblwiKS5oaWRkZW4gPSAhYy5zaWxlbnQ7IGJyZWFrO1xuICAgICAgY2FzZSBcInZvaWNlQ29tbWFuZFwiOlxuICAgICAgICB0b2FzdChgSGVhcmQgXHUyMDFDJHtjLmhlYXJkfVx1MjAxRDogJHtjLmNvbW1hbmQgPT09IFwic3RvcFwiID8gXCJzdG9wcGVkXCIgOiBjLmNvbW1hbmQgPT09IFwiY2FuY2VsQWxsXCIgPyBcImNhbmNlbGxpbmcgZXZlcnkgdGFza1wiIDogXCJoYW5naW5nIHVwXCJ9YCk7XG4gICAgICAgIGxvZyhcIm91dFwiLCBgdm9pY2UgY29tbWFuZCAke2MuY29tbWFuZH06ICR7Yy5oZWFyZH1gLCBcIm91dFwiKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwibG9nXCI6IGxvZyhjLmxldmVsLCBjLm1lc3NhZ2UsIGMubGV2ZWwgPT09IFwid2FyblwiID8gXCJ3YXJuXCIgOiBcIlwiKTsgYnJlYWs7XG4gICAgICBkZWZhdWx0OiBsb2coXCJvdXRcIiwgSlNPTi5zdHJpbmdpZnkoYykuc2xpY2UoMCwgMzAwKSwgXCJvdXRcIik7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIG9uTWljKHNhbXBsZXM6IEludDE2QXJyYXksIGxldmVsOiBudW1iZXIpIHtcbiAgaWYgKHNob3VsZEZlZWRXYWtlKCkpIHdha2VDbGllbnQuZmVlZChzYW1wbGVzKTtcbiAgaWYgKHdha2VTdGFydGluZykge1xuICAgIGNvbnN0IGNvcHkgPSBuZXcgVWludDhBcnJheShzYW1wbGVzLmJ5dGVMZW5ndGgpO1xuICAgIGNvcHkuc2V0KG5ldyBVaW50OEFycmF5KHNhbXBsZXMuYnVmZmVyLCBzYW1wbGVzLmJ5dGVPZmZzZXQsIHNhbXBsZXMuYnl0ZUxlbmd0aCkpO1xuICAgIG9wZW5pbmdDaHVua3MucHVzaChjb3B5KTtcbiAgICBvcGVuaW5nQnl0ZXMgKz0gY29weS5ieXRlTGVuZ3RoO1xuICAgIHdoaWxlIChvcGVuaW5nQnl0ZXMgPiBPUEVOSU5HX01BWF9CWVRFUyAmJiBvcGVuaW5nQ2h1bmtzLmxlbmd0aCA+IDEpIHtcbiAgICAgIG9wZW5pbmdCeXRlcyAtPSBvcGVuaW5nQ2h1bmtzLnNoaWZ0KCkhLmJ5dGVMZW5ndGg7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuICBpZiAoIWNhbGxJZCB8fCBtZWRpdW0gIT09IFwidm9pY2VcIikgcmV0dXJuO1xuICBjb3VudHMubWljKys7XG4gIGlmIChsZXZlbCA+IDAuMDMgJiYgIShtdXRlZCAmJiAhaG9sZGluZykpIHtcbiAgICBtZXRyaWNzLmxhc3RWb2ljZSA9IG5vdygpO1xuICAgIGlmIChhdWRpby5xdWV1ZWQgPCAwLjA1KSBtZXRyaWNzLnJlcGxpZWQgPSBmYWxzZTtcbiAgfVxuICBwdXNoKHsgdHlwZTogXCJtaWNcIiwgcGNtOiBieXRlc1RvQmFzZTY0KG5ldyBVaW50OEFycmF5KHNhbXBsZXMuYnVmZmVyLCBzYW1wbGVzLmJ5dGVPZmZzZXQsIHNhbXBsZXMuYnl0ZUxlbmd0aCkpIH0pO1xufVxuXG5mdW5jdGlvbiBjb25uZWN0KHNpZDogbnVtYmVyLCBjYXB0aW9uczogYm9vbGVhbikge1xuICBjb25zdCB3cyA9IG5ldyBXZWJTb2NrZXQoYCR7bG9jYXRpb24ucHJvdG9jb2wgPT09IFwiaHR0cHM6XCIgPyBcIndzc1wiIDogXCJ3c1wifTovLyR7bG9jYXRpb24uaG9zdH0vbGl2ZSR7Y2FwdGlvbnMgPyBcIj9mb3I9Y2FwdGlvbnNcIiA6IFwiXCJ9YCk7XG4gIHNvY2tldHMuc2V0KHNpZCwgd3MpO1xuICBpZiAoY2FwdGlvbnMpIGNhcHRpb25Tb2NrZXRzLmFkZChzaWQpO1xuICBsb2coXCJvdXRcIiwgYHdzICR7c2lkfSBjb25uZWN0ICgke3NlcnZlci5yb3V0ZX0ke2NhcHRpb25zID8gXCIsIGNhcHRpb25zXCIgOiBcIlwifSlgLCBcIm91dFwiKTtcbiAgd3Mub25vcGVuID0gKCkgPT4gcHVzaCh7IHR5cGU6IFwid3Mub3BlblwiLCBzaWQgfSk7XG4gIHdzLm9ubWVzc2FnZSA9IChtKSA9PiBwdXNoKHsgdHlwZTogXCJ3cy5tZXNzYWdlXCIsIHNpZCwgZGF0YTogdHlwZW9mIG0uZGF0YSA9PT0gXCJzdHJpbmdcIiA/IG0uZGF0YSA6IFwiXCIgfSk7XG4gIHdzLm9uY2xvc2UgPSAoZSkgPT4ge1xuICAgIGlmIChzb2NrZXRzLmdldChzaWQpICE9PSB3cyAmJiBzb2NrZXRzLmhhcyhzaWQpKSByZXR1cm47XG4gICAgY29uc3QgaHR0cFN0YXR1cyA9IGUuY29kZSA+PSA0MTAwICYmIGUuY29kZSA8IDQ2MDAgPyBlLmNvZGUgLSA0MDAwIDogdW5kZWZpbmVkO1xuICAgIHB1c2goeyB0eXBlOiBcIndzLmNsb3NlZFwiLCBzaWQsIGNvZGU6IGh0dHBTdGF0dXMgPyB1bmRlZmluZWQgOiBlLmNvZGUsIHJlYXNvbjogZS5yZWFzb24sIGh0dHBTdGF0dXMgfSk7XG4gIH07XG59XG5cbi8qKiBBIGNoYXQncyByZXF1ZXN0IHRvIHRoZSB0ZXh0IG1vZGVsLCB0aHJvdWdoIHRoZSBzZXJ2ZXI6IGVhY2ggYGRhdGE6YCBsaW5lIG9mIHRoZSBtb2RlbCdzIHN0cmVhbSBnb2VzIHRvIHRoZSBjb3JlIGFzIGl0IGNvbWVzLiAqL1xuYXN5bmMgZnVuY3Rpb24gZ2VuZXJhdGUoaWQ6IG51bWJlciwgYm9keTogc3RyaW5nKSB7XG4gIGNvbnN0IGFib3J0ID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICByZXF1ZXN0cy5zZXQoaWQsIGFib3J0KTtcbiAgbG9nKFwib3V0XCIsIGByZXF1ZXN0ICR7aWR9IFx1MjE5MiAke3NlcnZlci50ZXh0TW9kZWx9ICgke01hdGgucm91bmQoYm9keS5sZW5ndGggLyAxMDI0KX0gS0IpYCwgXCJvdXRcIik7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChcIi9nZW5lcmF0ZVwiLCB7IG1ldGhvZDogXCJQT1NUXCIsIHNpZ25hbDogYWJvcnQuc2lnbmFsLCBoZWFkZXJzOiB7IFwiY29udGVudC10eXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sIGJvZHkgfSk7XG4gICAgaWYgKCFyZXNwb25zZS5vayB8fCAhcmVzcG9uc2UuYm9keSkge1xuICAgICAgY29uc3QgdGV4dCA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKS5jYXRjaCgoKSA9PiBcIlwiKTtcbiAgICAgIHB1c2goeyB0eXBlOiBcImxsbS5lbmRcIiwgaWQsIHN0YXR1czogcmVzcG9uc2Uuc3RhdHVzLCBlcnJvcjogYEhUVFAgJHtyZXNwb25zZS5zdGF0dXN9JHt0ZXh0ID8gXCI6IFwiICsgdGV4dC5yZXBsYWNlKC9cXHMrL2csIFwiIFwiKS5zbGljZSgwLCAyMDApIDogXCJcIn1gIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCByZWFkZXIgPSByZXNwb25zZS5ib2R5LnBpcGVUaHJvdWdoKG5ldyBUZXh0RGVjb2RlclN0cmVhbSgpKS5nZXRSZWFkZXIoKTtcbiAgICBsZXQgYnVmZmVyID0gXCJcIjtcbiAgICBmb3IgKDs7KSB7XG4gICAgICBjb25zdCB7IHZhbHVlLCBkb25lIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpO1xuICAgICAgaWYgKGRvbmUpIGJyZWFrO1xuICAgICAgYnVmZmVyICs9IHZhbHVlO1xuICAgICAgbGV0IGN1dDtcbiAgICAgIHdoaWxlICgoY3V0ID0gYnVmZmVyLmluZGV4T2YoXCJcXG5cIikpID49IDApIHtcbiAgICAgICAgY29uc3QgbGluZSA9IGJ1ZmZlci5zbGljZSgwLCBjdXQpLnJlcGxhY2UoL1xcciQvLCBcIlwiKTtcbiAgICAgICAgYnVmZmVyID0gYnVmZmVyLnNsaWNlKGN1dCArIDEpO1xuICAgICAgICBpZiAobGluZS5zdGFydHNXaXRoKFwiZGF0YTpcIikpIHB1c2goeyB0eXBlOiBcImxsbS5kYXRhXCIsIGlkLCBkYXRhOiBsaW5lLnNsaWNlKDUpLnRyaW0oKSB9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgcHVzaCh7IHR5cGU6IFwibGxtLmVuZFwiLCBpZCB9KTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgaWYgKCFhYm9ydC5zaWduYWwuYWJvcnRlZCkgcHVzaCh7IHR5cGU6IFwibGxtLmVuZFwiLCBpZCwgZXJyb3I6IChlcnIgYXMgRXJyb3IpLm1lc3NhZ2UgfSk7XG4gIH0gZmluYWxseSB7XG4gICAgcmVxdWVzdHMuZGVsZXRlKGlkKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBjYW5jZWxSdW4oa2V5OiBzdHJpbmcsIHJlYXNvbjogc3RyaW5nKSB7XG4gIGNvbnN0IHIgPSBydW5zLmdldChrZXkpO1xuICBsb2coXCJvdXRcIiwgYGNhbmNlbCAke2tleX0gKCR7cmVhc29ufSlgLCBcIm91dFwiKTtcbiAgaWYgKCFyKSByZXR1cm47XG4gIHJ1bnMuZGVsZXRlKGtleSk7XG4gIHIuYWJvcnQuYWJvcnQoKTtcbiAgLy8gQ2FuY2VsbGVkIG9uIHB1cnBvc2U6IHRoZSBhZ2VudCBzdG9wcyB0b28uIEEgY2FsbCB0aGF0IGVuZGVkIGxlYXZlcyBhIGNvZGluZyBhZ2VudCB3b3JraW5nIGluIFQzLlxuICBpZiAocmVhc29uID09PSBcImNhbmNlbGxlZFwiICYmICFjaGVja2VkKFwiZmFrZWhlcm1lc1wiKSkge1xuICAgIHZvaWQgZmV0Y2goci5hZ2VudCA9PT0gXCJ0M1wiID8gXCIvYWdlbnQvY2FuY2VsXCIgOiBcIi9oZXJtZXMvc3RvcFwiLCB7IG1ldGhvZDogXCJQT1NUXCIsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgY2FsbDogY2FsbE5hbWUsIHRhc2tJZDogci50YXNrSWQgfSkgfSk7XG4gIH1cbn1cblxuLyoqIE1vcmUgZm9yIGEgcnVubmluZyB0YXNrLCBpbnRvIGl0cyBjdXJyZW50IHJ1bjsgaWYgdGhlIGFnZW50IHdvbid0IHRha2UgaXQsIHRoZSBjb3JlIHF1ZXVlcyBpdCBpbnN0ZWFkLiAqL1xuYXN5bmMgZnVuY3Rpb24gc3RlZXJSdW4oYzogQ29tbWFuZCkge1xuICBjb25zdCByID0gcnVucy5nZXQoYy5ydW4pO1xuICBsb2coXCJvdXRcIiwgYHN0ZWVyICR7Yy5ydW59OiAke2MudGV4dH1gLCBcIm91dFwiKTtcbiAgaWYgKGNoZWNrZWQoXCJmYWtlaGVybWVzXCIpKSByZXR1cm47XG4gIGNvbnN0IG9rID0gciAhPSBudWxsICYmXG4gICAgKGF3YWl0IGZldGNoKGMuYWdlbnQgPT09IFwidDNcIiA/IFwiL2FnZW50L3N0ZWVyXCIgOiBcIi9oZXJtZXMvc3RlZXJcIiwgeyBtZXRob2Q6IFwiUE9TVFwiLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGNhbGw6IGNhbGxOYW1lLCB0YXNrSWQ6IHIudGFza0lkLCB0ZXh0OiBjLm1lc3NhZ2UgfSkgfSkudGhlbigoeCkgPT4geC5vaywgKCkgPT4gZmFsc2UpKTtcbiAgaWYgKCFvaykgcHVzaCh7IHR5cGU6IFwidG9vbC5zdGVlckZhaWxlZFwiLCBydW46IGMucnVuLCB0ZXh0OiBjLnRleHQgfSk7XG4gIGVsc2UgdG9hc3QoYCR7Yy5hZ2VudCA9PT0gXCJ0M1wiID8gXCJUaGUgY29kaW5nIGFnZW50XCIgOiBcIkhlcm1lc1wifSB0b29rIHRoZSBmb2xsb3ctdXAgd2hpbGUgaXQgd29ya3NgKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gdG9vbChjOiBDb21tYW5kKSB7XG4gIGlmIChjLmtpbmQgPT09IFwiaG9zdFwiKSB7XG4gICAgbG9nKFwib3V0XCIsIGBob3N0IHRvb2wgJHtjLm5hbWV9ICR7SlNPTi5zdHJpbmdpZnkoYy5hcmdzKX1gLCBcIm91dFwiKTtcbiAgICBjb25zdCBhbnN3ZXIgPSBjLm5hbWUgPT09IFwidHZfdm9sdW1lXCIgPyBgVGhlIFRWIGlzIGF0ICR7KGZha2VUdkxldmVsID0gTnVtYmVyKGMuYXJncz8ubGV2ZWwgPz8gZmFrZVR2TGV2ZWwpKX0uYFxuICAgICAgOiBjLm5hbWUgPT09IFwidHZfcGF1c2VcIiA/IChjLmFyZ3M/LnBhdXNlID09PSBmYWxzZSA/IFwiUGxheWluZy5cIiA6IFwiUGF1c2VkLlwiKSA6IFwiRG9uZS5cIjtcbiAgICBzZXRUaW1lb3V0KCgpID0+IHB1c2goeyB0eXBlOiBcInRvb2wucmVzdWx0XCIsIHJ1bjogYy5ydW4sIHRleHQ6IGFuc3dlciB9KSwgMzAwKTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgYWdlbnQgPSBjLmFnZW50ID09PSBcInQzXCIgPyBcInQzXCIgOiBcImhlcm1lc1wiO1xuICBjb25zdCBvcmlnaW5TZXNzaW9uID0gYWN0aXZlU2Vzc2lvbjtcbiAgbG9nKFwib3V0XCIsIGAke2FnZW50fSAke2MuZm9sbG93VXAgPyBcImZvbGxvdy11cFwiIDogXCJ0YXNrXCJ9IFwiJHtjLmxhYmVsfVwiJHtjLnByb2plY3QgPyBgIGluICR7Yy5wcm9qZWN0fWAgOiBcIlwifTogJHtjLnJlcXVlc3R9YCwgXCJvdXRcIik7XG4gIGNvbnN0IGFib3J0ID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICBydW5zLnNldChjLnJ1biwgeyBhYm9ydCwgYWdlbnQsIHRhc2tJZDogYy50YXNrSWQgfSk7XG4gIGNvbnN0IGRvbmUgPSAodGV4dDogc3RyaW5nLCBmYWlsZWQgPSBmYWxzZSkgPT4ge1xuICAgIGlmICghcnVucy5oYXMoYy5ydW4pKSByZXR1cm47XG4gICAgcnVucy5kZWxldGUoYy5ydW4pO1xuICAgIGNvbnN0IHZpZXcgPSB0YXNrcy5nZXQoYy50YXNrSWQpO1xuICAgIGNvbnN0IHJlc0lkID0gcmVzdWx0KGFnZW50LCBjLmxhYmVsLCB0ZXh0LCBmYWlsZWQsIGMudGFza0lkLCBvcmlnaW5TZXNzaW9uKTtcbiAgICBub3RpZnkoYCR7YWdlbnQgPT09IFwidDNcIiA/IFwiVDNcIiA6IFwiSGVybWVzXCJ9IFx1MDBCNyAke2MubGFiZWx9YCwgdGV4dCk7XG4gICAgaWYgKCFmYWlsZWQpIHsgcmVtZW1iZXIoXCJhc3Npc3RhbnRcIiwgdGV4dCwgYCR7YWdlbnQgPT09IFwidDNcIiA/IFwiVDNcIiA6IFwiSGVybWVzXCJ9IFx1MDBCNyAke2MubGFiZWx9YCk7IGxhc3RMaW5lID0gbnVsbDsgfVxuICAgIGlmICh2aWV3KSB7IHZpZXcucmVzdWx0SWQgPSByZXNJZDsgc2hvd1Rhc2tzKCk7IH1cbiAgICBwdXNoKHsgdHlwZTogXCJ0b29sLnJlc3VsdFwiLCBydW46IGMucnVuLCB0ZXh0LCBmYWlsZWQgfSk7XG4gIH07XG4gIGlmIChjaGVja2VkKFwiZmFrZWhlcm1lc1wiKSkge1xuICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiBkb25lKGAoRmFrZSAke2FnZW50ID09PSBcInQzXCIgPyBcIlQzXCIgOiBcIkhlcm1lc1wifSkgRG9uZTogXHUyMDFDJHtjLnJlcXVlc3R9XHUyMDFELiBOb3RoaW5nIHdhcyBhY3R1YWxseSBydW4uYCksIE51bWJlcigkPEhUTUxJbnB1dEVsZW1lbnQ+KFwiZmFrZWRlbGF5XCIpLnZhbHVlKSAqIDEwMDApO1xuICAgIGFib3J0LnNpZ25hbC5vbmFib3J0ID0gKCkgPT4gY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICByZXR1cm47XG4gIH1cbiAgdHJ5IHtcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKGFnZW50ID09PSBcInQzXCIgPyBcIi9hZ2VudFwiIDogXCIvaGVybWVzXCIsIHtcbiAgICAgIG1ldGhvZDogXCJQT1NUXCIsIHNpZ25hbDogYWJvcnQuc2lnbmFsLCBoZWFkZXJzOiB7IFwiY29udGVudC10eXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGNhbGw6IGNhbGxOYW1lLCB0YXNrSWQ6IGMudGFza0lkLCBmb2xsb3dVcDogYy5mb2xsb3dVcCwgbWVzc2FnZTogYy5tZXNzYWdlLCBsYWJlbDogYy5sYWJlbCwgcmVxdWVzdDogYy5yZXF1ZXN0LCBwcm9qZWN0OiBjLnByb2plY3QsIGFwcHJvdmFsczogXCJzY3JlZW5cIiB9KSxcbiAgICB9KTtcbiAgICBpZiAoIXJlc3BvbnNlLm9rIHx8ICFyZXNwb25zZS5ib2R5KSB0aHJvdyBuZXcgRXJyb3IoYEhUVFAgJHtyZXNwb25zZS5zdGF0dXN9YCk7XG4gICAgY29uc3QgcmVhZGVyID0gcmVzcG9uc2UuYm9keS5waXBlVGhyb3VnaChuZXcgVGV4dERlY29kZXJTdHJlYW0oKSkuZ2V0UmVhZGVyKCk7XG4gICAgbGV0IGJ1ZmZlciA9IFwiXCI7XG4gICAgZm9yICg7Oykge1xuICAgICAgY29uc3QgeyB2YWx1ZSwgZG9uZTogZmluaXNoZWQgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICBpZiAoZmluaXNoZWQpIGJyZWFrO1xuICAgICAgYnVmZmVyICs9IHZhbHVlO1xuICAgICAgbGV0IGN1dDtcbiAgICAgIHdoaWxlICgoY3V0ID0gYnVmZmVyLmluZGV4T2YoXCJcXG5cXG5cIikpID49IDApIHtcbiAgICAgICAgY29uc3QgYmxvY2sgPSBidWZmZXIuc2xpY2UoMCwgY3V0KTtcbiAgICAgICAgYnVmZmVyID0gYnVmZmVyLnNsaWNlKGN1dCArIDIpO1xuICAgICAgICBjb25zdCBldmVudCA9IGJsb2NrLm1hdGNoKC9eZXZlbnQ6ICguKikkL20pPy5bMV07XG4gICAgICAgIGlmICghZXZlbnQpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCBkYXRhID0gSlNPTi5wYXJzZShibG9jay5tYXRjaCgvXmRhdGE6ICguKikkL20pPy5bMV0gPz8gXCJ7fVwiKTtcbiAgICAgICAgaWYgKGV2ZW50ID09PSBcInByb2dyZXNzXCIpIHB1c2goeyB0eXBlOiBcInRhc2sucHJvZ3Jlc3NcIiwgdGFzazogYy50YXNrSWQsIHRleHQ6IGRhdGEudGV4dCB9KTtcbiAgICAgICAgZWxzZSBpZiAoZXZlbnQgPT09IFwidGhyZWFkXCIpIHsgY29uc3QgdmlldyA9IHRhc2tzLmdldChjLnRhc2tJZCk7IGlmICh2aWV3KSB7IHZpZXcudGhyZWFkID0gZGF0YS50aHJlYWQ7IHNob3dUYXNrcygpOyB9IH1cbiAgICAgICAgZWxzZSBpZiAoZXZlbnQgPT09IFwiYXBwcm92YWxcIikge1xuICAgICAgICAgIGNvbnN0IHZpZXcgPSB0YXNrcy5nZXQoYy50YXNrSWQpO1xuICAgICAgICAgIGlmICh2aWV3KSB7IHZpZXcuYXBwcm92YWwgPSB7IGNvbW1hbmQ6IGRhdGEuY29tbWFuZCB9OyBzaG93VGFza3ModHJ1ZSk7IH1cbiAgICAgICAgICB0b2FzdChgSGVybWVzIGFza3MgdG8gcnVuOiAke2RhdGEuY29tbWFuZC5zbGljZSgwLCA4MCl9YCk7XG4gICAgICAgICAgbm90aWZ5KGBIZXJtZXMgXHUwMEI3ICR7Yy5sYWJlbH0gbmVlZHMgeW91ciBhcHByb3ZhbGAsIGRhdGEuY29tbWFuZCk7XG4gICAgICAgICAgYXVkaW8uY3VlKEFQUFJPVkFMX1RPTkUpO1xuICAgICAgICB9XG4gICAgICAgIGVsc2UgaWYgKGV2ZW50ID09PSBcInJlc3VsdFwiKSBkb25lKGRhdGEudGV4dCwgZGF0YS5mYWlsZWQpO1xuICAgICAgICBlbHNlIGlmIChldmVudCA9PT0gXCJlcnJvclwiKSB7IHJ1bnMuZGVsZXRlKGMucnVuKTsgcHVzaCh7IHR5cGU6IFwidG9vbC5lcnJvclwiLCBydW46IGMucnVuLCBtZXNzYWdlOiBkYXRhLm1lc3NhZ2UgfSk7IH1cbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKHJ1bnMuaGFzKGMucnVuKSkgeyBydW5zLmRlbGV0ZShjLnJ1bik7IHB1c2goeyB0eXBlOiBcInRvb2wuZXJyb3JcIiwgcnVuOiBjLnJ1biwgbWVzc2FnZTogXCJ0aGUgc2VydmVyIGNsb3NlZCB0aGUgc3RyZWFtIHdpdGhvdXQgYSByZXN1bHRcIiB9KTsgfVxuICB9IGNhdGNoIChlcnIpIHtcbiAgICBpZiAoIWFib3J0LnNpZ25hbC5hYm9ydGVkICYmIHJ1bnMuaGFzKGMucnVuKSkgeyBydW5zLmRlbGV0ZShjLnJ1bik7IHB1c2goeyB0eXBlOiBcInRvb2wuZXJyb3JcIiwgcnVuOiBjLnJ1biwgbWVzc2FnZTogKGVyciBhcyBFcnJvcikubWVzc2FnZSB9KTsgfVxuICB9XG59XG5cbmZ1bmN0aW9uIG1pY09wdGlvbnMoKSB7XG4gIGNvbnN0IGFlYyA9IGNoZWNrZWQoXCJhZWNcIik7XG4gIHJldHVybiB7IGVjaG9DYW5jZWxsYXRpb246IGFlYywgbm9pc2VTdXBwcmVzc2lvbjogYWVjLCBhdXRvR2FpbkNvbnRyb2w6IGFlYyB9O1xufVxuXG5mdW5jdGlvbiBudW1iZXJTZXR0aW5nKGlkOiBzdHJpbmcsIGZhbGxiYWNrOiBudW1iZXIsIG1pbiA9IDAsIG1heCA9IDM2MDApOiBudW1iZXIge1xuICBjb25zdCBuID0gTnVtYmVyKCQ8SFRNTElucHV0RWxlbWVudD4oaWQpLnZhbHVlKTtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShuKSA/IE1hdGgubWF4KG1pbiwgTWF0aC5taW4obWF4LCBuKSkgOiBmYWxsYmFjaztcbn1cblxuZnVuY3Rpb24gZGV2ZWxvcGVyT3ZlcnJpZGVzKCkge1xuICB0cnkge1xuICAgIGNvbnN0IGdpdmVuID0gSlNPTi5wYXJzZSgkPEhUTUxUZXh0QXJlYUVsZW1lbnQ+KFwiY29uZmlnXCIpLnZhbHVlKTtcbiAgICBpZiAoIWdpdmVuIHx8IHR5cGVvZiBnaXZlbiAhPT0gXCJvYmplY3RcIikge1xuICAgICAgcmV0dXJuIHsgbm9uV2ViUGxhdGZvcm06IG51bGwgYXMgc3RyaW5nIHwgbnVsbCwgaGFzQXR0ZW50aW9uOiBmYWxzZSwgaGFzSGFuZ1VwOiBmYWxzZSwgaGFzU3RhbmRieTogZmFsc2UsIGhhc01pY1doaWxlU3BlYWtpbmc6IGZhbHNlIH07XG4gICAgfVxuICAgIGNvbnN0IG5vbldlYlBsYXRmb3JtID0gdHlwZW9mIGdpdmVuLnBsYXRmb3JtID09PSBcInN0cmluZ1wiICYmIGdpdmVuLnBsYXRmb3JtICE9PSBcIndlYlwiID8gZ2l2ZW4ucGxhdGZvcm0gOiBudWxsO1xuICAgIGNvbnN0IG1pYyA9IGdpdmVuLm1pYyAmJiB0eXBlb2YgZ2l2ZW4ubWljID09PSBcIm9iamVjdFwiID8gZ2l2ZW4ubWljIDogbnVsbDtcbiAgICByZXR1cm4ge1xuICAgICAgbm9uV2ViUGxhdGZvcm0sXG4gICAgICBoYXNBdHRlbnRpb246IGdpdmVuLmF0dGVudGlvbiAhPT0gdW5kZWZpbmVkLFxuICAgICAgaGFzSGFuZ1VwOiBnaXZlbi5oYW5nVXBBZnRlciAhPT0gdW5kZWZpbmVkLFxuICAgICAgaGFzU3RhbmRieTogZ2l2ZW4uc3RhbmRieUFmdGVyICE9PSB1bmRlZmluZWQsXG4gICAgICBoYXNNaWNXaGlsZVNwZWFraW5nOiBtaWMgIT0gbnVsbCAmJiBtaWMud2hpbGVTcGVha2luZyAhPT0gdW5kZWZpbmVkLFxuICAgIH07XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiB7IG5vbldlYlBsYXRmb3JtOiBudWxsIGFzIHN0cmluZyB8IG51bGwsIGhhc0F0dGVudGlvbjogZmFsc2UsIGhhc0hhbmdVcDogZmFsc2UsIGhhc1N0YW5kYnk6IGZhbHNlLCBoYXNNaWNXaGlsZVNwZWFraW5nOiBmYWxzZSB9O1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlYWRDb25maWcoKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICBjb25zdCBnaXZlbiA9IEpTT04ucGFyc2UoJDxIVE1MVGV4dEFyZWFFbGVtZW50PihcImNvbmZpZ1wiKS52YWx1ZSk7XG4gIGNvbnN0IGNvbmZpZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgbW9kZWw6IHNlcnZlci5tb2RlbCwgYXBpOiBzZXJ2ZXIucm91dGUgPT09IFwidmVydGV4XCIgPyBcInZlcnRleFwiIDogXCJnZW1pbmlcIiwgdG9kYXk6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKS5zbGljZSgwLCAxMCksXG4gICAgLi4uZ2l2ZW4sIHRyYWNlOiBjaGVja2VkKFwidHJhY2VcIiksXG4gIH07XG4gIGlmIChjaGVja2VkKFwicHR0XCIpKSBjb25maWcubXV0ZWQgPSB0cnVlO1xuICBpZiAoZ2l2ZW4udm9pY2UgPT09IHVuZGVmaW5lZCkgY29uZmlnLnZvaWNlID0gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJ2b2ljZVwiKS52YWx1ZTtcbiAgaWYgKGNvbmZpZy5zdGVlcmluZyA9PT0gdW5kZWZpbmVkKSBjb25maWcuc3RlZXJpbmcgPSBbXCJoZXJtZXNcIiwgXCJ0M1wiXTtcbiAgLy8gQSB3ZWIgY29uZmlnIHNhdmVkIGJlZm9yZSBoYW5kLW9mZnMgd2VyZSBuYW1lZCBpbiB3b3JkcyBnZXRzIHRoYXQgdG9vLlxuICBpZiAoY29uZmlnLmhhbmRPZmYgPT09IHVuZGVmaW5lZCAmJiBjb25maWcucGxhdGZvcm0gPT09IFwid2ViXCIpIGNvbmZpZy5oYW5kT2ZmID0gXCJuYW1lZFwiO1xuICAvLyBBbmQgb25lIHNhdmVkIGJlZm9yZSB0aGUgcGFnZSBmb2xsb3dlZCB0aGUgdXNlcidzIGxlYWQgKHN1cGVydmlzZSkgZ2V0cyB0aGF0LlxuICBpZiAoY29uZmlnLnN1cGVydmlzZSA9PT0gdW5kZWZpbmVkICYmIGNvbmZpZy5wbGF0Zm9ybSA9PT0gXCJ3ZWJcIikgY29uZmlnLnN1cGVydmlzZSA9IHRydWU7XG4gIGlmIChjaGVja2VkKFwiY29kaW5nXCIpICYmIChzZXJ2ZXIudDMgfHwgY2hlY2tlZChcImZha2VoZXJtZXNcIikpICYmIGNvbmZpZy5jb2RpbmdBZ2VudCA9PT0gdW5kZWZpbmVkKSBjb25maWcuY29kaW5nQWdlbnQgPSB7IHByb2plY3RzOiBzZXJ2ZXIudDMgPz8gW10gfTtcbiAgaWYgKGNoZWNrZWQoXCJjYXB0aW9uc1wiKSAmJiBzZXJ2ZXIuY2FwdGlvbnNNb2RlbCAmJiBjb25maWcuY2FwdGlvbnMgPT09IHVuZGVmaW5lZCkgY29uZmlnLmNhcHRpb25zID0geyBtb2RlbDogc2VydmVyLmNhcHRpb25zTW9kZWwgfTtcbiAgLy8gQXBwbHkgZWFjaCBTZXR0aW5ncyBzaWduYWxpbmcgZmllbGQgaW5kZXBlbmRlbnRseSBmb3Igd2ViIGNvbmZpZ3MgdW5sZXNzIHNldCBpbiBEZXZlbG9wZXIgSlNPTiAvIHByZXNldC5cbiAgY29uc3Qgbm9uV2ViID0gdHlwZW9mIGdpdmVuLnBsYXRmb3JtID09PSBcInN0cmluZ1wiICYmIGdpdmVuLnBsYXRmb3JtICE9PSBcIndlYlwiO1xuICBpZiAoIW5vbldlYikge1xuICAgIGNvbnN0IHNpZ25hbGluZyA9ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwic2lnbmFsaW5nXCIpLnZhbHVlO1xuICAgIGlmIChnaXZlbi5hdHRlbnRpb24gPT09IHVuZGVmaW5lZCAmJiAoc2lnbmFsaW5nID09PSBcIndpbmRvd1wiIHx8IHNpZ25hbGluZyA9PT0gXCJlY2hvXCIpKSB7XG4gICAgICBjb25maWcuYXR0ZW50aW9uID0ge1xuICAgICAgICBtb2RlOiBcIndpbmRvd1wiLFxuICAgICAgICBhZnRlcldha2U6IG51bWJlclNldHRpbmcoXCJhdHRuLWFmdGVyLXdha2VcIiwgOCwgMSwgNjApLFxuICAgICAgICB3aW5kb3c6IG51bWJlclNldHRpbmcoXCJhdHRuLXdpbmRvd1wiLCA1LCAwLCA2MCksXG4gICAgICAgIGFmdGVyUXVlc3Rpb246IG51bWJlclNldHRpbmcoXCJhdHRuLWFmdGVyLXF1ZXN0aW9uXCIsIDEwLCAwLCA2MCksXG4gICAgICAgIGFmdGVySGFuZE9mZjogMyxcbiAgICAgICAgYWZ0ZXJBbm5vdW5jZW1lbnQ6IDAsXG4gICAgICB9O1xuICAgIH1cbiAgICBpZiAoZ2l2ZW4uaGFuZ1VwQWZ0ZXIgPT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uZmlnLmhhbmdVcEFmdGVyID0gbnVtYmVyU2V0dGluZyhcImhhbmd1cC1hZnRlclwiLCBzaWduYWxpbmcgPT09IFwiZWNob1wiID8gMTUgOiAzMDAsIDAsIDM2MDApO1xuICAgIH1cbiAgICBpZiAoc2lnbmFsaW5nID09PSBcImVjaG9cIiAmJiBnaXZlbi5zdGFuZGJ5QWZ0ZXIgPT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uZmlnLnN0YW5kYnlBZnRlciA9IDg7XG4gICAgfVxuICAgIGNvbnN0IGdpdmVuTWljID0gZ2l2ZW4ubWljICYmIHR5cGVvZiBnaXZlbi5taWMgPT09IFwib2JqZWN0XCIgPyAoZ2l2ZW4ubWljIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA6IG51bGw7XG4gICAgaWYgKCghZ2l2ZW5NaWMgfHwgZ2l2ZW5NaWMud2hpbGVTcGVha2luZyA9PT0gdW5kZWZpbmVkKSAmJiAoY2hlY2tlZChcIndha2UtYmFyZ2VcIikgfHwgc2lnbmFsaW5nID09PSBcImVjaG9cIikpIHtcbiAgICAgIGNvbmZpZy5taWMgPSB7IGdhaW5EYjogMCwgLi4uKGdpdmVuTWljID8/IHt9KSwgd2hpbGVTcGVha2luZzogXCJ3YWtlXCIgfTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGNvbmZpZztcbn1cblxuLyoqIFN0YXJ0cyBhIHZvaWNlIGNhbGwsIG9yIHdpdGggW3R5cGVkXSBhIGNoYXQgKHRoZSBjb3JlJ3MgbWVkaXVtIFwidGV4dFwiOiBubyBhdWRpbywgYSB0ZXh0IG1vZGVsKS4gKi9cbmFzeW5jIGZ1bmN0aW9uIHN0YXJ0KGNhcnJ5T24gPSBmYWxzZSwgdHlwZWQgPSBmYWxzZSk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBpZiAoc3RhcnRpbmdDYWxsIHx8IGNhbGxJZCkgcmV0dXJuIGZhbHNlO1xuICBzdGFydGluZ0NhbGwgPSB0cnVlO1xuICB0cnkge1xuICAgIGF3YWl0IGVuZGluZztcbiAgICBpZiAoY2FsbElkKSByZXR1cm4gZmFsc2U7XG4gICAgbGV0IGdpdmVuOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICB0cnkge1xuICAgICAgZ2l2ZW4gPSByZWFkQ29uZmlnKCk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICB0b2FzdChgVGhlIGRldmVsb3BlciBzZXR0aW5ncyBhcmVuJ3QgdmFsaWQgSlNPTjogJHsoZXJyIGFzIEVycm9yKS5tZXNzYWdlfWApO1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICBpZiAodHlwZWQpIHtcbiAgICAgIGlmICghc2VydmVyLnRleHRNb2RlbCkgeyB0b2FzdChcIlRoaXMgc2VydmVyIGhhcyBubyB0ZXh0IG1vZGVsIGZvciBhIGNoYXQ6IHN0YXJ0IGEgY2FsbCB0byB0eXBlIHRvIGl0XCIpOyByZXR1cm4gZmFsc2U7IH1cbiAgICAgIGdpdmVuID0geyAuLi5naXZlbiwgbWVkaXVtOiBcInRleHRcIiwgbXV0ZWQ6IGZhbHNlIH07XG4gICAgICBkZWxldGUgZ2l2ZW4uY2FwdGlvbnM7XG4gICAgfVxuICAgICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiY2FsbFwiKS5kaXNhYmxlZCA9IHRydWU7XG4gICAgJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJoZXJvLWNhbGxcIikuZGlzYWJsZWQgPSB0cnVlO1xuICAgIGlmIChcIk5vdGlmaWNhdGlvblwiIGluIHdpbmRvdyAmJiBOb3RpZmljYXRpb24ucGVybWlzc2lvbiA9PT0gXCJkZWZhdWx0XCIpIHZvaWQgTm90aWZpY2F0aW9uLnJlcXVlc3RQZXJtaXNzaW9uKCkuY2F0Y2goKCkgPT4ge30pO1xuICAgIGxldCBsb2FkZWRDb3JlOiBDb3JlO1xuICAgIHRyeSB7XG4gICAgICBpZiAoIXR5cGVkKSBhd2FpdCBhdWRpby5vcGVuKCk7XG4gICAgICBsb2FkZWRDb3JlID0gYXdhaXQgbG9hZENvcmUoKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJjYWxsXCIpLmRpc2FibGVkID0gZmFsc2U7XG4gICAgICAkPEhUTUxCdXR0b25FbGVtZW50PihcImhlcm8tY2FsbFwiKS5kaXNhYmxlZCA9IGZhbHNlO1xuICAgIH1cbiAgICBpZiAoY2FsbElkKSByZXR1cm4gZmFsc2U7XG4gICAgY29yZSA9IGxvYWRlZENvcmU7XG4gICAgaWYgKHR5cGVkKSB7XG4gICAgICB3YWtlU3RhcnRpbmcgPSBmYWxzZTtcbiAgICAgIG9wZW5pbmdDaHVua3MgPSBbXTtcbiAgICAgIG9wZW5pbmdCeXRlcyA9IDA7XG4gICAgICBpZiAod2FrZUFybWVkKSBhdWRpby5zdG9wTWljKCk7XG4gICAgfVxuICAgIG1lZGl1bSA9IHR5cGVkID8gXCJ0ZXh0XCIgOiBcInZvaWNlXCI7XG4gICAgdGhpbmtpbmcgPSBmYWxzZTtcbiAgICAkKFwidmVyc2lvblwiKS50ZXh0Q29udGVudCA9IGNvcmUudmVyc2lvbjtcbiAgICAkKFwibG9nXCIpLmlubmVySFRNTCA9IFwiXCI7XG4gICAgaWYgKCF0eXBlZCAmJiAodGFza3Muc2l6ZSA+IDAgfHwgJChcInRyYW5zY3JpcHRcIikuY2hpbGRFbGVtZW50Q291bnQgPiAxKSkgbm90ZShgTmV3IGNhbGwgXHUwMEI3ICR7bmV3IERhdGUoKS50b0xvY2FsZVRpbWVTdHJpbmcoKX1gKTtcbiAgICBzY3JvbGxEb3duKHRydWUpO1xuICAgIHRhc2tzLmNsZWFyKCk7XG4gICAgYWN0aXZlU2Vzc2lvbiA9ICsrc2Vzc2lvblNlcTtcbiAgICBzaG93VGFza3MoKTtcbiAgICBjb3VudHMgPSB7IG1pYzogMCwgcGxheTogMCwgc2VudDogMCB9O1xuICAgIG1ldHJpY3MucmVwbHkgPSBbXTtcbiAgICBzdGFydGVkQXQgPSBub3coKTtcbiAgICBtdXRlZCA9IGdpdmVuLm11dGVkID09PSB0cnVlO1xuICAgIGNvbnN0IG1pY0NmZyA9IGdpdmVuLm1pYyAmJiB0eXBlb2YgZ2l2ZW4ubWljID09PSBcIm9iamVjdFwiID8gKGdpdmVuLm1pYyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgOiBudWxsO1xuICAgIGNhbGxXaGlsZVNwZWFraW5nID0gdHlwZW9mIG1pY0NmZz8ud2hpbGVTcGVha2luZyA9PT0gXCJzdHJpbmdcIiA/IG1pY0NmZy53aGlsZVNwZWFraW5nIDogXCJzZW5kXCI7XG4gICAgLy8gQ2Fycnlpbmcgb246IHRoZSBtb2RlbCBnZXRzIHRoZSBsYXN0IGNvbnZlcnNhdGlvbiBhcyBhIHJlY2FwLiBUaGUgY29yZSBjYXBzIGl0LCBsYXRlc3QgbGluZXMgZmlyc3QuXG4gICAgLy8gQSBjaGF0IGFsd2F5cyBjYXJyaWVzIG9uIGZyb20gd2hhdCdzIG9uIHRoZSBzY3JlZW4gKGFuIGVhcmxpZXIgY2FsbCBvciBjaGF0IG9uIHRoaXMgcGFnZSkuXG4gICAgaWYgKHR5cGVkKSB7IGlmIChjaGF0Lmxlbmd0aCA+IDAgJiYgZ2l2ZW4uaGlzdG9yeSA9PT0gdW5kZWZpbmVkKSBnaXZlbi5oaXN0b3J5ID0gY2hhdDsgfVxuICAgIGVsc2UgaWYgKGNhcnJ5T24gJiYgZ2l2ZW4uaGlzdG9yeSA9PT0gdW5kZWZpbmVkKSBnaXZlbi5oaXN0b3J5ID0gc2F2ZWRIaXN0b3J5KCk7XG4gICAgZWxzZSBpZiAoIWNhcnJ5T24pIGNoYXQgPSBbXTtcbiAgICBpZiAoY2FycnlPbiAmJiAhdHlwZWQpIGNoYXQgPSBzYXZlZEhpc3RvcnkoKTtcbiAgICBsYXN0TGluZSA9IG51bGw7XG4gICAgb3BlbkxpbmUgPSBudWxsO1xuICAgIHN5bmNSZXN1bWVCdXR0b25zKGZhbHNlKTtcbiAgICBjYWxsTmFtZSA9IGAke25ldyBEYXRlKCkudG9JU09TdHJpbmcoKS5yZXBsYWNlKC9bOi5dL2csIFwiLVwiKX0tJHt0eXBlZCA/IFwiY2hhdFwiIDogXCJ3ZWJcIn0tJHtjb3JlLnZlcnNpb259YDtcbiAgICBjb25zdCBjcmVhdGVkID0gSlNPTi5wYXJzZShjb3JlLmNyZWF0ZShKU09OLnN0cmluZ2lmeShnaXZlbiksIG5vdygpKSk7XG4gICAgY2FsbElkID0gY3JlYXRlZC5pZDtcbiAgICBpZiAoIXR5cGVkKSB7XG4gICAgICBzZXRDYWxsQnV0dG9uKHRydWUpO1xuICAgICAgJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJtaWNcIikuZGlzYWJsZWQgPSBmYWxzZTtcbiAgICB9XG4gICAgJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJodXNoXCIpLmRpc2FibGVkID0gZmFsc2U7XG4gICAgJChcIm1pY1wiKS5jbGFzc0xpc3QudG9nZ2xlKFwibXV0ZWRcIiwgbXV0ZWQpO1xuICAgIHJ1bihjcmVhdGVkLmNvbW1hbmRzKTtcbiAgICBzaG93U3RhdHVzKCk7XG4gICAgdGlja2VyID0gd2luZG93LnNldEludGVydmFsKCgpID0+IHtcbiAgICAgIHB1c2goeyB0eXBlOiBcInRpY2tcIiB9KTtcbiAgICAgIGNvbnN0IGxldmVsID0gbXV0ZWQgJiYgIWhvbGRpbmcgPyAwIDogYXVkaW8ubGV2ZWw7XG4gICAgICBjb25zdCBzdHJlbmd0aCA9IE1hdGgubWluKDEsIGxldmVsICogMTIpO1xuICAgICAgJChcInJpbmdcIikuc3R5bGUub3BhY2l0eSA9IFN0cmluZyhzdHJlbmd0aCk7XG4gICAgICAkKFwicmluZ1wiKS5zdHlsZS50cmFuc2Zvcm0gPSBgc2NhbGUoJHsoMSArIHN0cmVuZ3RoICogMC4xMikudG9GaXhlZCgzKX0pYDtcbiAgICAgICQoXCJjb3VudHNcIikudGV4dENvbnRlbnQgPSBgbWljICR7Y291bnRzLm1pY30gXHUwMEI3IHNlbnQgJHtjb3VudHMuc2VudH0gXHUwMEI3IHBsYXllZCAke2NvdW50cy5wbGF5fSBcdTAwQjcgcXVldWVkICR7YXVkaW8ucXVldWVkLnRvRml4ZWQoMSl9IHNgO1xuICAgICAgc2hvd1N0YXR1cygpO1xuICAgIH0sIDEwMCk7XG4gICAgdHJhY2VUaW1lciA9IHdpbmRvdy5zZXRJbnRlcnZhbCgoKSA9PiB7IHZvaWQgc2F2ZVRyYWNlKCk7IHZvaWQgcGluZygpOyBzaG93VGFza3MoKTsgfSwgNTAwMCk7XG4gICAgdm9pZCBwaW5nKCk7XG4gICAgaWYgKCF0eXBlZCkge1xuICAgICAgc3RvcFdvcmRzLnN0YXJ0KCk7XG4gICAgICBhd2FpdCBhY3F1aXJlV2FrZUxvY2soKTtcbiAgICB9XG4gICAgcmV0dXJuIHRydWU7XG4gIH0gZmluYWxseSB7XG4gICAgc3RhcnRpbmdDYWxsID0gZmFsc2U7XG4gIH1cbn1cblxuLyoqIFRoZSBDYWxsIGJ1dHRvbjogaGFuZ3MgdXAgYSBjYWxsOyBzdGFydHMgb25lOyBvciwgd2l0aCBhIGNoYXQgb24sIGVuZHMgdGhlIGNoYXQgYW5kIGNhcnJpZXMgaXRzIGNvbnZlcnNhdGlvbiBvbiBieSB2b2ljZS4gKi9cbmFzeW5jIGZ1bmN0aW9uIGNhbGxCdXR0b24oKSB7XG4gIGlmIChjYWxsSWQgJiYgbWVkaXVtID09PSBcInZvaWNlXCIpIHsgaGFuZ1VwKCk7IHJldHVybjsgfVxuICBpZiAoY2FsbElkKSB7XG4gICAgLy8gQSBjYWxsIGNhbid0IHRha2Ugb3ZlciB0aGUgY2hhdCdzIHRhc2tzLCBhbmQgZW5kaW5nIHRoZSBjaGF0IHdvdWxkIHN0b3AgdGhlbS5cbiAgICBpZiAoWy4uLnRhc2tzLnZhbHVlcygpXS5zb21lKCh2KSA9PiB2LmMuc3RhdGUgPT09IFwicnVubmluZ1wiKSkgeyB0b2FzdChcIlRoZSBjaGF0J3MgdGFza3MgYXJlIHN0aWxsIHJ1bm5pbmc6IHdhaXQgZm9yIHRoZW0gb3IgY2FuY2VsIHRoZW0sIHRoZW4gY2FsbFwiKTsgcmV0dXJuOyB9XG4gICAgcHVzaCh7IHR5cGU6IFwic3RvcFwiIH0pO1xuICAgIGF3YWl0IHN0YXJ0KHRydWUpO1xuICAgIHJldHVybjtcbiAgfVxuICBhd2FpdCBzdGFydCgpO1xufVxuXG5mdW5jdGlvbiBoYW5nVXAoKSB7XG4gIGlmIChjYWxsSWQpIHB1c2goeyB0eXBlOiBcInN0b3BcIiwgbWVzc2FnZTogXCJZb3UgaHVuZyB1cC5cIiB9KTtcbn1cblxuZnVuY3Rpb24gZW5kKCkge1xuICB3aW5kb3cuY2xlYXJJbnRlcnZhbCh0aWNrZXIpO1xuICB3aW5kb3cuY2xlYXJJbnRlcnZhbCh0cmFjZVRpbWVyKTtcbiAgc3RvcFdvcmRzLnN0b3AoKTtcbiAgYWN0aXZlU2Vzc2lvbiA9IDA7XG4gIHN5bmNSZXN1bHRGb2xsb3dVcEJ1dHRvbnMoKTtcbiAgY29yZVdhbnRzV2FrZSA9IGZhbHNlO1xuICB3YWtlU3RhcnRpbmcgPSBmYWxzZTtcbiAgb3BlbmluZ0NodW5rcyA9IFtdO1xuICBvcGVuaW5nQnl0ZXMgPSAwO1xuICBjb25zdCBmaW5pc2hlZElkID0gY2FsbElkO1xuICBjb25zdCBmaW5pc2hlZENvcmUgPSBjb3JlO1xuICBjYWxsSWQgPSAwO1xuICBlbmRpbmcgPSBzYXZlVHJhY2UoZmluaXNoZWRJZCwgZmluaXNoZWRDb3JlKS50aGVuKCgpID0+IHsgaWYgKGZpbmlzaGVkQ29yZSAmJiBmaW5pc2hlZElkKSBmaW5pc2hlZENvcmUuZGlzcG9zZShmaW5pc2hlZElkKTsgc2hvd1Rhc2tzKCk7IHN5bmNXYWtlVWkoKTsgfSk7XG4gIGlmICh3YWtlQXJtZWQpIHtcbiAgICBhdWRpby5zdG9wUGxheWJhY2soKTtcbiAgICB3YWtlQ2xpZW50LnJlc2V0KCk7XG4gICAgdm9pZCBhdWRpby5lbnN1cmVNaWMob25NaWMsIG1pY09wdGlvbnMoKSkuY2F0Y2goKGVycikgPT4ge1xuICAgICAgbG9nKFwiZXJyb3JcIiwgYHdha2UgbWljcm9waG9uZTogJHtlcnIubWVzc2FnZX1gLCBcImVyclwiKTtcbiAgICAgIHRvYXN0KGBXYWtlIG1pY3JvcGhvbmU6ICR7ZXJyLm1lc3NhZ2V9YCk7XG4gICAgICB2b2lkIGFybVdha2UoZmFsc2UpO1xuICAgIH0pO1xuICB9IGVsc2Uge1xuICAgIGF1ZGlvLnN0b3AoKTtcbiAgICByZWxlYXNlV2FrZUxvY2soKTtcbiAgfVxuICBmb3IgKGNvbnN0IHdzIG9mIHNvY2tldHMudmFsdWVzKCkpIHdzLmNsb3NlKCk7XG4gIHNvY2tldHMuY2xlYXIoKTtcbiAgZm9yIChjb25zdCByIG9mIHJ1bnMudmFsdWVzKCkpIHIuYWJvcnQuYWJvcnQoKTtcbiAgcnVucy5jbGVhcigpO1xuICBmb3IgKGNvbnN0IHIgb2YgcmVxdWVzdHMudmFsdWVzKCkpIHIuYWJvcnQoKTtcbiAgcmVxdWVzdHMuY2xlYXIoKTtcbiAgdGhpbmtpbmcgPSBmYWxzZTtcbiAgc2V0Q2FsbEJ1dHRvbihmYWxzZSk7XG4gIGZvciAoY29uc3QgaWQgb2YgW1wibWljXCIsIFwiaHVzaFwiXSkgJDxIVE1MQnV0dG9uRWxlbWVudD4oaWQpLmRpc2FibGVkID0gdHJ1ZTtcbiAgJChcInJpbmdcIikuc3R5bGUub3BhY2l0eSA9IFwiMFwiO1xuICAkKFwicmluZ1wiKS5zdHlsZS50cmFuc2Zvcm0gPSBcIlwiO1xuICAkKFwiY2FsbGJhclwiKS5oaWRkZW4gPSB0cnVlO1xuICAkKFwibWljd2FyblwiKS5oaWRkZW4gPSB0cnVlO1xuICBkb2N1bWVudC5ib2R5LmRhdGFzZXQuc3RhdGUgPSB3YWtlQXJtZWQgPyBcImFybWVkXCIgOiBcImlkbGVcIjtcbiAgZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QucmVtb3ZlKFwiaW4tc2Vzc2lvblwiKTtcbiAgc3luY1Jlc3VtZUJ1dHRvbnMoY2hhdC5sZW5ndGggPiAwKTtcbiAgdm9pZCBzaG93RWFybGllcigpO1xuICBzeW5jV2FrZVVpKCk7XG59XG5cbmZ1bmN0aW9uIHNldE11dGVkKHZhbHVlOiBib29sZWFuKSB7XG4gIGlmICghY2FsbElkIHx8IG11dGVkID09PSB2YWx1ZSkgcmV0dXJuO1xuICBtdXRlZCA9IHZhbHVlO1xuICAkKFwibWljXCIpLmNsYXNzTGlzdC50b2dnbGUoXCJtdXRlZFwiLCBtdXRlZCk7XG4gIHB1c2goeyB0eXBlOiBtdXRlZCA/IFwibXV0ZVwiIDogXCJ1bm11dGVcIiB9KTtcbiAgc2hvd1N0YXR1cygpO1xufVxuXG4vKiogU2VuZHMgd2hhdCB0aGUgdHJhY2Uga2VwdCBzaW5jZSBsYXN0IHRpbWUgdG8gdGhlIGRldiBzZXJ2ZXIsIGFzIEpTT04gbGluZXM6IGEgaGVhZGVyLCB0aGVuIGV2ZW50cy4gKi9cbmFzeW5jIGZ1bmN0aW9uIHNhdmVUcmFjZShpZCA9IGNhbGxJZCwgdGFyZ2V0Q29yZSA9IGNvcmUpIHtcbiAgaWYgKCF0YXJnZXRDb3JlIHx8ICFpZCB8fCAhY2hlY2tlZChcInRyYWNlXCIpKSByZXR1cm47XG4gIGNvbnN0IGtlcHQgPSBKU09OLnBhcnNlKHRhcmdldENvcmUudHJhY2UoaWQpKTtcbiAgaWYgKCFrZXB0KSByZXR1cm47XG4gIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICBpZiAoa2VwdC5jb25maWcpIGxpbmVzLnB1c2goSlNPTi5zdHJpbmdpZnkoeyB2ZXJzaW9uOiBrZXB0LnZlcnNpb24sIGNvbmZpZzoga2VwdC5jb25maWcsIHN0YXJ0OiBrZXB0LnN0YXJ0IH0pKTtcbiAgZm9yIChjb25zdCBlIG9mIGtlcHQuZXZlbnRzKSBsaW5lcy5wdXNoKEpTT04uc3RyaW5naWZ5KGUpKTtcbiAgaWYgKGxpbmVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuICBhd2FpdCBmZXRjaChgL3RyYWNlcz9uYW1lPSR7ZW5jb2RlVVJJQ29tcG9uZW50KGNhbGxOYW1lKX0uanNvbmxgLCB7IG1ldGhvZDogXCJQT1NUXCIsIGJvZHk6IGxpbmVzLmpvaW4oXCJcXG5cIikgKyBcIlxcblwiIH0pLmNhdGNoKCgpID0+IHt9KTtcbiAgJChcInRyYWNlbmFtZVwiKS50ZXh0Q29udGVudCA9IGB0cmFjZSAke2NhbGxOYW1lfS5qc29ubGA7XG59XG5cbi8vIFwiU3RvcFwiIGFuZCBcImdvb2RieWVcIiBoZWFyZCBieSB0aGUgYnJvd3NlcidzIG93biByZWNvZ25pemVyOiBxdWlja2VyIHRoYW4gdGhlIG1vZGVsJ3MgdHJhbnNjcmlwdCxcbi8vIGFuZCBpdCB3b3JrcyB3aGlsZSB0aGUgbW9kZWwncyByZXBseSBwbGF5cyBldmVuIHdoZW4gdGhlIG1vZGVsIGlzbid0IGhlYXJpbmcgdGhlIG1pY3JvcGhvbmUuXG5cbmNsYXNzIFN0b3BXb3JkcyB7XG4gIHByaXZhdGUgcmVjOiBhbnkgPSBudWxsO1xuICBwcml2YXRlIG9uID0gZmFsc2U7XG4gIHByaXZhdGUgY29tbWFuZHMgPSB7IHN0b3A6IFtdIGFzIHN0cmluZ1tdLCBoYW5nVXA6IFtdIGFzIHN0cmluZ1tdLCBjYW5jZWxBbGw6IFtdIGFzIHN0cmluZ1tdIH07XG5cbiAgZ2V0IHN1cHBvcnRlZCgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gXCJ3ZWJraXRTcGVlY2hSZWNvZ25pdGlvblwiIGluIHdpbmRvdyB8fCBcIlNwZWVjaFJlY29nbml0aW9uXCIgaW4gd2luZG93O1xuICB9XG5cbiAgc3RhcnQoKSB7XG4gICAgaWYgKCFjaGVja2VkKFwic3RvcHdvcmRcIikgfHwgIXRoaXMuc3VwcG9ydGVkIHx8ICFjb3JlKSByZXR1cm47XG4gICAgdGhpcy5jb21tYW5kcyA9IEpTT04ucGFyc2UoY29yZS5kZWZhdWx0cygpKS52b2ljZUNvbW1hbmRzO1xuICAgIGNvbnN0IFJlY29nbml0aW9uID0gKHdpbmRvdyBhcyBhbnkpLlNwZWVjaFJlY29nbml0aW9uID8/ICh3aW5kb3cgYXMgYW55KS53ZWJraXRTcGVlY2hSZWNvZ25pdGlvbjtcbiAgICB0aGlzLnJlYyA9IG5ldyBSZWNvZ25pdGlvbigpO1xuICAgIHRoaXMucmVjLmNvbnRpbnVvdXMgPSB0cnVlO1xuICAgIHRoaXMucmVjLmludGVyaW1SZXN1bHRzID0gdHJ1ZTtcbiAgICB0aGlzLnJlYy5sYW5nID0gbmF2aWdhdG9yLmxhbmd1YWdlIHx8IFwiZW4tR0JcIjtcbiAgICB0aGlzLnJlYy5vbnJlc3VsdCA9IChlOiBhbnkpID0+IHtcbiAgICAgIGZvciAobGV0IGkgPSBlLnJlc3VsdEluZGV4OyBpIDwgZS5yZXN1bHRzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIGNvbnN0IHRleHQgPSBlLnJlc3VsdHNbaV1bMF0udHJhbnNjcmlwdCBhcyBzdHJpbmc7XG4gICAgICAgIGNvbnN0IGNvbW1hbmQgPSBjb21tYW5kSW4odGV4dCwgdGhpcy5jb21tYW5kcywgW1wiV29vZGhvdXNlXCIsIFwiSGVybWVzXCIsIFwiQmVudG9cIl0pO1xuICAgICAgICBpZiAoY29tbWFuZCA9PT0gXCJzdG9wXCIgJiYgYXVkaW8ucXVldWVkID4gMC4wNSkge1xuICAgICAgICAgIGxvZyhcIm91dFwiLCBgbG9jYWwgc3RvcCB3b3JkOiAke3RleHR9YCwgXCJvdXRcIik7XG4gICAgICAgICAgdG9hc3QoYEhlYXJkIFx1MjAxQyR7dGV4dC50cmltKCl9XHUyMDFEOiBzdG9wcGVkYCk7XG4gICAgICAgICAgcHVzaCh7IHR5cGU6IFwiaW50ZXJydXB0XCIgfSk7XG4gICAgICAgIH0gZWxzZSBpZiAoY29tbWFuZCA9PT0gXCJjYW5jZWxBbGxcIiAmJiBlLnJlc3VsdHNbaV0uaXNGaW5hbCkge1xuICAgICAgICAgIGxvZyhcIm91dFwiLCBgbG9jYWwgY2FuY2VsLWFsbDogJHt0ZXh0fWAsIFwib3V0XCIpO1xuICAgICAgICAgIHB1c2goeyB0eXBlOiBcImNhbmNlbEFsbFwiIH0pO1xuICAgICAgICAgIHB1c2goeyB0eXBlOiBcImludGVycnVwdFwiIH0pO1xuICAgICAgICB9IGVsc2UgaWYgKGNvbW1hbmQgPT09IFwiaGFuZ1VwXCIgJiYgZS5yZXN1bHRzW2ldLmlzRmluYWwpIHtcbiAgICAgICAgICBsb2coXCJvdXRcIiwgYGxvY2FsIGhhbmctdXA6ICR7dGV4dH1gLCBcIm91dFwiKTtcbiAgICAgICAgICBoYW5nVXAoKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH07XG4gICAgdGhpcy5yZWMub25lbmQgPSAoKSA9PiB7IGlmICh0aGlzLm9uKSBzZXRUaW1lb3V0KCgpID0+IHsgdHJ5IHsgdGhpcy5yZWM/LnN0YXJ0KCk7IH0gY2F0Y2gge30gfSwgMjUwKTsgfTtcbiAgICB0aGlzLnJlYy5vbmVycm9yID0gKGU6IGFueSkgPT4geyBpZiAoZS5lcnJvciA9PT0gXCJub3QtYWxsb3dlZFwiKSB0aGlzLm9uID0gZmFsc2U7IH07XG4gICAgdGhpcy5vbiA9IHRydWU7XG4gICAgdHJ5IHsgdGhpcy5yZWMuc3RhcnQoKTsgfSBjYXRjaCB7fVxuICB9XG5cbiAgc3RvcCgpIHtcbiAgICB0aGlzLm9uID0gZmFsc2U7XG4gICAgdHJ5IHsgdGhpcy5yZWM/LnN0b3AoKTsgfSBjYXRjaCB7fVxuICAgIHRoaXMucmVjID0gbnVsbDtcbiAgfVxufVxuY29uc3Qgc3RvcFdvcmRzID0gbmV3IFN0b3BXb3JkcygpO1xuXG4vLyBMb2NhbCB3YWtlIHdvcmQgbG9vcCAoTGl2ZUtpdCBXYWtlV29yZCBPTk5YIGluIGEgV2ViIFdvcmtlcik6IGxpc3RlbnMgYmV0d2VlbiBjYWxscyB3aGVuIGFybWVkLFxuLy8gYW5kIGluc2lkZSBhbiBhY3RpdmUgY2FsbCB3aGVuZXZlciB0aGUgY29yZSBhc2tzIChgd2FrZXdvcmQ6IG9uYDogZG9ybWFudCBvciB3aGlsZVNwZWFraW5nIFwid2FrZVwiKS5cblxuYXN5bmMgZnVuY3Rpb24gYWNxdWlyZVdha2VMb2NrKCkge1xuICBpZiAod2FrZUxvY2sgfHwgZG9jdW1lbnQuaGlkZGVuKSByZXR1cm47XG4gIHRyeSB7IHdha2VMb2NrID0gYXdhaXQgKG5hdmlnYXRvciBhcyBhbnkpLndha2VMb2NrPy5yZXF1ZXN0KFwic2NyZWVuXCIpOyB9IGNhdGNoIHt9XG59XG5cbmZ1bmN0aW9uIHJlbGVhc2VXYWtlTG9jaygpIHtcbiAgdm9pZCB3YWtlTG9jaz8ucmVsZWFzZSgpLmNhdGNoKCgpID0+IHt9KTtcbiAgd2FrZUxvY2sgPSBudWxsO1xufVxuXG5mdW5jdGlvbiBzZWxlY3RlZFdha2VNb2RlbCgpOiBXYWtlTW9kZWxJbmZvIHwgbnVsbCB7XG4gIGNvbnN0IG1vZGVscyA9IHNlcnZlcj8ud2FrZU1vZGVscyA/PyBbXTtcbiAgaWYgKG1vZGVscy5sZW5ndGggPT09IDApIHJldHVybiBudWxsO1xuICBjb25zdCBwaWNrID0gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJ3YWtlLW1vZGVsXCIpLnZhbHVlO1xuICByZXR1cm4gbW9kZWxzLmZpbmQoKG0pID0+IG0uaWQgPT09IHBpY2spID8/IG1vZGVscy5maW5kKChtKSA9PiBtLmlkID09PSBcInBlbm55d29ydGhcIikgPz8gbW9kZWxzWzBdO1xufVxuXG5mdW5jdGlvbiB3YWtlVGhyZXNob2xkKCk6IG51bWJlciB7XG4gIGNvbnN0IG4gPSBOdW1iZXIoJDxIVE1MSW5wdXRFbGVtZW50PihcIndha2UtdGhyZXNob2xkXCIpLnZhbHVlKTtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShuKSA/IE1hdGgubWF4KDAuMSwgTWF0aC5taW4oMC45OSwgbikpIDogMC43O1xufVxuXG5mdW5jdGlvbiBzaG91bGRGZWVkV2FrZSgpOiBib29sZWFuIHtcbiAgaWYgKHdha2VTdGFydGluZyB8fCBzdGFydGluZ0NhbGwpIHJldHVybiBmYWxzZTtcbiAgaWYgKGNhbGxJZCA9PT0gMCkgcmV0dXJuIHdha2VBcm1lZDtcbiAgcmV0dXJuIG1lZGl1bSA9PT0gXCJ2b2ljZVwiICYmIGNvcmVXYW50c1dha2UgJiYgIShtdXRlZCAmJiAhaG9sZGluZyk7XG59XG5cbmZ1bmN0aW9uIHJlbmRlcldha2VUZWxlbWV0cnkoKSB7XG4gIGNvbnN0IGFjdGl2ZSA9IChjYWxsSWQgPT09IDAgJiYgd2FrZUFybWVkKSB8fCAoY2FsbElkICE9PSAwICYmIG1lZGl1bSA9PT0gXCJ2b2ljZVwiICYmIGNvcmVXYW50c1dha2UpO1xuICBpZiAoIWFjdGl2ZSkgeyAkKFwiaGVhcmRcIikudGV4dENvbnRlbnQgPSBcIlwiOyByZXR1cm47IH1cbiAgY29uc3QgbGFiZWwgPSBzZWxlY3RlZFdha2VNb2RlbCgpPy5sYWJlbCA/PyBcIndha2Ugd29yZFwiO1xuICBpZiAod2FrZUxvYWRpbmcpIHsgJChcImhlYXJkXCIpLnRleHRDb250ZW50ID0gYExvYWRpbmcgd2FrZSB3b3JkIFx1MjAxQyR7bGFiZWx9XHUyMDFEXHUyMDI2YDsgcmV0dXJuOyB9XG4gIGlmIChjYWxsSWQgPT09IDAgJiYgYXVkaW8uYXVkaW9TdXNwZW5kZWQpIHsgJChcImhlYXJkXCIpLnRleHRDb250ZW50ID0gYEF1ZGlvIHBhdXNlZCBieSBicm93c2VyIFx1MDBCNyB0YXAgb3IgcHJlc3MgYSBrZXkgdG8gcmVzdW1lIFx1MjAxQyR7bGFiZWx9XHUyMDFEYDsgcmV0dXJuOyB9XG4gIGlmICghd2FrZUxhc3RUZWwpIHsgJChcImhlYXJkXCIpLnRleHRDb250ZW50ID0gYFdha2UgXHUyMDFDJHtsYWJlbH1cdTIwMUQgcmVhZHkgKHRocmVzaG9sZCAke3dha2VUaHJlc2hvbGQoKS50b0ZpeGVkKDIpfSlgOyByZXR1cm47IH1cbiAgY29uc3Qgc3RhdGUgPSB3YWtlTGFzdFRlbC5nYXRlT3BlbiA/IGBzY29yaW5nICR7d2FrZUxhc3RUZWwuc2NvcmUudG9GaXhlZCgyKX1gIDogXCJxdWlldFwiO1xuICBjb25zdCBzcGVlZCA9IHdha2VMYXN0VGVsLmluZmVyTXMgPiAwID8gYCBcdTAwQjcgJHt3YWtlTGFzdFRlbC5pbmZlck1zLnRvRml4ZWQoMSl9IG1zYCA6IFwiXCI7XG4gICQoXCJoZWFyZFwiKS50ZXh0Q29udGVudCA9IGBXYWtlIFx1MjAxQyR7bGFiZWx9XHUyMDFEIFx1MDBCNyAke3N0YXRlfSBcdTAwQjcgcGVhayAke3dha2VMYXN0VGVsLnBlYWsudG9GaXhlZCgyKX0ke3NwZWVkfWA7XG59XG5cbmZ1bmN0aW9uIHN5bmNXYWtlVWkoKSB7XG4gIGNvbnN0IG1vZGVsID0gc2VsZWN0ZWRXYWtlTW9kZWwoKTtcbiAgY29uc3QgaGFzTW9kZWxzID0gbW9kZWwgIT0gbnVsbDtcbiAgY29uc3QgbGFiZWwgPSBtb2RlbD8ubGFiZWwgPz8gXCJ3YWtlIHdvcmRcIjtcbiAgY29uc3QgYnRuID0gJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJ3YWtlYnRuXCIpO1xuICBidG4uaGlkZGVuID0gIWhhc01vZGVscztcbiAgYnRuLmNsYXNzTGlzdC50b2dnbGUoXCJvblwiLCB3YWtlQXJtZWQpO1xuICBidG4uY2xhc3NMaXN0LnRvZ2dsZShcImxvYWRpbmdcIiwgd2FrZUxvYWRpbmcgJiYgKHdha2VBcm1lZCB8fCBjb3JlV2FudHNXYWtlKSk7XG4gIGJ0bi5zZXRBdHRyaWJ1dGUoXCJhcmlhLXByZXNzZWRcIiwgU3RyaW5nKHdha2VBcm1lZCkpO1xuICBidG4udGl0bGUgPSB3YWtlQXJtZWQgPyBgU3RvcCB3YWtlIHdvcmQgXHUyMDFDJHtsYWJlbH1cdTIwMUQgKFcpYCA6IGBMaXN0ZW4gZm9yIFx1MjAxQyR7bGFiZWx9XHUyMDFEIChXKWA7XG4gIGNvbnN0IGhlcm8gPSAkPEhUTUxCdXR0b25FbGVtZW50PihcImhlcm8td2FrZVwiKTtcbiAgaGVyby5oaWRkZW4gPSAhaGFzTW9kZWxzO1xuICBoZXJvLmNsYXNzTGlzdC50b2dnbGUoXCJvblwiLCB3YWtlQXJtZWQpO1xuICBoZXJvLnRleHRDb250ZW50ID0gd2FrZUFybWVkXG4gICAgPyAod2FrZUxvYWRpbmcgPyBgTG9hZGluZyBcdTIwMUMke2xhYmVsfVx1MjAxRFx1MjAyNmAgOiBhdWRpby5hdWRpb1N1c3BlbmRlZCA/IGBBY3RpdmF0ZSBcdTIwMUMke2xhYmVsfVx1MjAxRGAgOiBgTGlzdGVuaW5nIGZvciBcdTIwMUMke2xhYmVsfVx1MjAxRGApXG4gICAgOiBgTGlzdGVuIGZvciBcdTIwMUMke2xhYmVsfVx1MjAxRGA7XG4gICQ8SFRNTElucHV0RWxlbWVudD4oXCJ3YWtlLWVuYWJsZWRcIikuY2hlY2tlZCA9IHdha2VBcm1lZDtcbiAgcmVuZGVyV2FrZVRlbGVtZXRyeSgpO1xuICBzaG93U3RhdHVzKCk7XG59XG5cbmZ1bmN0aW9uIHN5bmNTaWduYWxpbmdVaSgpIHtcbiAgY29uc3Qgb3YgPSBkZXZlbG9wZXJPdmVycmlkZXMoKTtcbiAgY29uc3Qgc2lnbmFsaW5nRWwgPSAkPEhUTUxTZWxlY3RFbGVtZW50PihcInNpZ25hbGluZ1wiKTtcbiAgY29uc3Qgc2lnbmFsaW5nID0gc2lnbmFsaW5nRWwudmFsdWU7XG4gIGNvbnN0IG5vbldlYiA9IG92Lm5vbldlYlBsYXRmb3JtICE9IG51bGw7XG4gIHNpZ25hbGluZ0VsLmRpc2FibGVkID0gbm9uV2ViIHx8IG92Lmhhc0F0dGVudGlvbjtcbiAgY29uc3Qgd2luZG93Q29udHJvbHMgPSAhbm9uV2ViICYmICFvdi5oYXNBdHRlbnRpb24gJiYgKHNpZ25hbGluZyA9PT0gXCJ3aW5kb3dcIiB8fCBzaWduYWxpbmcgPT09IFwiZWNob1wiKTtcbiAgZm9yIChjb25zdCBpZCBvZiBbXCJhdHRuLWFmdGVyLXdha2VcIiwgXCJhdHRuLXdpbmRvd1wiLCBcImF0dG4tYWZ0ZXItcXVlc3Rpb25cIl0pIHtcbiAgICAkPEhUTUxJbnB1dEVsZW1lbnQ+KGlkKS5kaXNhYmxlZCA9ICF3aW5kb3dDb250cm9scztcbiAgfVxuICAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwiaGFuZ3VwLWFmdGVyXCIpLmRpc2FibGVkID0gbm9uV2ViIHx8IG92Lmhhc0hhbmdVcDtcbiAgY29uc3QgYmFyZ2UgPSAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwid2FrZS1iYXJnZVwiKTtcbiAgaWYgKG5vbldlYiB8fCBvdi5oYXNNaWNXaGlsZVNwZWFraW5nKSB7XG4gICAgYmFyZ2UuZGlzYWJsZWQgPSB0cnVlO1xuICB9IGVsc2UgaWYgKHNpZ25hbGluZyA9PT0gXCJlY2hvXCIpIHtcbiAgICBiYXJnZS5jaGVja2VkID0gdHJ1ZTtcbiAgICBiYXJnZS5kaXNhYmxlZCA9IHRydWU7XG4gIH0gZWxzZSB7XG4gICAgYmFyZ2UuZGlzYWJsZWQgPSBmYWxzZTtcbiAgICBiYXJnZS5jaGVja2VkID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS53YWtlLWJhcmdlXCIpID09PSBcIjFcIjtcbiAgfVxuICBjb25zdCBvdmVycmlkZGVuOiBzdHJpbmdbXSA9IFtdO1xuICBpZiAob3YuaGFzQXR0ZW50aW9uKSBvdmVycmlkZGVuLnB1c2goXCJhdHRlbnRpb25cIik7XG4gIGlmIChvdi5oYXNIYW5nVXApIG92ZXJyaWRkZW4ucHVzaChcImhhbmdVcEFmdGVyXCIpO1xuICBpZiAob3YuaGFzTWljV2hpbGVTcGVha2luZykgb3ZlcnJpZGRlbi5wdXNoKFwibWljLndoaWxlU3BlYWtpbmdcIik7XG4gIGNvbnN0IGhhc01vZGVscyA9IChzZXJ2ZXI/Lndha2VNb2RlbHM/Lmxlbmd0aCA/PyAwKSA+IDA7XG4gICQoXCJzaWduYWxpbmctaGVscFwiKS50ZXh0Q29udGVudCA9IG5vbldlYlxuICAgID8gYERldmVsb3BlciBwcmVzZXQgKCR7b3Yubm9uV2ViUGxhdGZvcm19KSBjb250cm9scyBzaWduYWxpbmcuYFxuICAgIDogb3ZlcnJpZGRlbi5sZW5ndGggPiAwXG4gICAgICA/IGBEZXZlbG9wZXIgY29uZmlnIHNldHMgJHtvdmVycmlkZGVuLmpvaW4oXCIsIFwiKX0uYFxuICAgICAgOiAhaGFzTW9kZWxzICYmIHNpZ25hbGluZyAhPT0gXCJvcGVuXCJcbiAgICAgICAgPyBcIk5vIHdha2UgbW9kZWxzIG9uIHNlcnZlcjogdXNlIHRoZSBXYWtlIGJ1dHRvbiB3aGVuIGRvcm1hbnQuXCJcbiAgICAgICAgOiBcIkFwcGxpZWQgb24gdGhlIG5leHQgY2FsbCB1bmxlc3Mgb3ZlcnJpZGRlbiBpbiBEZXZlbG9wZXIgSlNPTi5cIjtcbn1cblxuY29uc3Qgd2FrZUNsaWVudCA9IG5ldyBXYWtlQ2xpZW50KHtcbiAgb25SZWFkeShtb2RlbElkLCB3YXJtdXBNcykge1xuICAgIHdha2VMb2FkaW5nID0gZmFsc2U7XG4gICAgbG9nKFwib3V0XCIsIGB3YWtlIHdvcmQgcmVhZHk6ICR7bW9kZWxJZH0ke3dhcm11cE1zID4gMCA/IGAgKCR7d2FybXVwTXN9IG1zKWAgOiBcIlwifWAsIFwib3V0XCIpO1xuICAgIHN5bmNXYWtlVWkoKTtcbiAgfSxcbiAgb25EZXRlY3RlZChoaXQpIHtcbiAgICBvbldha2VEZXRlY3RlZChoaXQpO1xuICB9LFxuICBvblRlbGVtZXRyeSh0ZWwpIHtcbiAgICB3YWtlTGFzdFRlbCA9IHRlbDtcbiAgICByZW5kZXJXYWtlVGVsZW1ldHJ5KCk7XG4gIH0sXG4gIG9uRXJyb3IobWVzc2FnZSkge1xuICAgIHdha2VMb2FkaW5nID0gZmFsc2U7XG4gICAgbG9nKFwiZXJyb3JcIiwgYHdha2Ugd29yZDogJHttZXNzYWdlfWAsIFwiZXJyXCIpO1xuICAgIHRvYXN0KGBXYWtlIHdvcmQgZXJyb3I6ICR7bWVzc2FnZX1gKTtcbiAgICBpZiAod2FrZUFybWVkKSB2b2lkIGFybVdha2UoZmFsc2UpO1xuICAgIGVsc2Ugc3luY1dha2VVaSgpO1xuICB9LFxufSk7XG5cbmFzeW5jIGZ1bmN0aW9uIGFybVdha2Uob246IGJvb2xlYW4sIHBlcnNpc3QgPSB0cnVlKSB7XG4gIGNvbnN0IG1vZGVsID0gc2VsZWN0ZWRXYWtlTW9kZWwoKTtcbiAgaWYgKG9uICYmICFtb2RlbCkge1xuICAgIHRvYXN0KFwiTm8gd2FrZSB3b3JkIG1vZGVscyBmb3VuZCBvbiB0aGUgc2VydmVyXCIpO1xuICAgICQ8SFRNTElucHV0RWxlbWVudD4oXCJ3YWtlLWVuYWJsZWRcIikuY2hlY2tlZCA9IGZhbHNlO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBnZW4gPSArK2FybUdlbjtcbiAgd2FrZUFybWVkID0gb247XG4gIGlmIChwZXJzaXN0KSBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLndha2UtZW5hYmxlZFwiLCBvbiA/IFwiMVwiIDogXCIwXCIpO1xuICBpZiAob24gJiYgbW9kZWwpIHtcbiAgICB3YWtlTGFzdFRlbCA9IG51bGw7XG4gICAgaWYgKCF3YWtlQ2xpZW50LnJlYWR5IHx8IHdha2VDbGllbnQubW9kZWxJZCAhPT0gbW9kZWwuaWQpIHdha2VMb2FkaW5nID0gdHJ1ZTtcbiAgICB3YWtlQ2xpZW50LmxvYWQobW9kZWwuaWQsIHdha2VUaHJlc2hvbGQoKSk7XG4gICAgaWYgKCFjYWxsSWQpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IGF1ZGlvLmVuc3VyZU1pYyhvbk1pYywgbWljT3B0aW9ucygpKTtcbiAgICAgICAgaWYgKGdlbiAhPT0gYXJtR2VuIHx8ICF3YWtlQXJtZWQpIHJldHVybjtcbiAgICAgICAgd2FrZUNsaWVudC5yZXNldCgpO1xuICAgICAgICBhd2FpdCBhY3F1aXJlV2FrZUxvY2soKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBpZiAoZ2VuICE9PSBhcm1HZW4pIHJldHVybjtcbiAgICAgICAgd2FrZUFybWVkID0gZmFsc2U7XG4gICAgICAgIHdha2VMb2FkaW5nID0gZmFsc2U7XG4gICAgICAgIGlmICghY2FsbElkKSB7XG4gICAgICAgICAgYXVkaW8uc3RvcE1pYygpO1xuICAgICAgICAgIHJlbGVhc2VXYWtlTG9jaygpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChwZXJzaXN0KSBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLndha2UtZW5hYmxlZFwiLCBcIjBcIik7XG4gICAgICAgIHRvYXN0KGBNaWNyb3Bob25lOiAkeyhlcnIgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgICAgIGxvZyhcImVycm9yXCIsIGB3YWtlIG1pY3JvcGhvbmU6ICR7KGVyciBhcyBFcnJvcikubWVzc2FnZX1gLCBcImVyclwiKTtcbiAgICAgIH1cbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgd2FrZUxvYWRpbmcgPSBmYWxzZTtcbiAgICB3YWtlTGFzdFRlbCA9IG51bGw7XG4gICAgaWYgKCFjYWxsSWQpIHtcbiAgICAgIGF1ZGlvLnN0b3BNaWMoKTtcbiAgICAgIHJlbGVhc2VXYWtlTG9jaygpO1xuICAgICAgd2FrZUNsaWVudC5yZXNldCgpO1xuICAgIH1cbiAgfVxuICBzeW5jV2FrZVVpKCk7XG59XG5cbmZ1bmN0aW9uIGVuc3VyZUNvcmVXYWtlKG9uOiBib29sZWFuKSB7XG4gIGNvcmVXYW50c1dha2UgPSBvbjtcbiAgY29uc3QgbW9kZWwgPSBzZWxlY3RlZFdha2VNb2RlbCgpO1xuICBpZiAob24pIHtcbiAgICBpZiAoIW1vZGVsKSB7XG4gICAgICBsb2coXCJ3YXJuXCIsIFwiY29yZSBhc2tlZCBmb3Igd2FrZSB3b3JkLCBidXQgbm8gbW9kZWxzIGFyZSBhdmFpbGFibGVcIiwgXCJ3YXJuXCIpO1xuICAgIH0gZWxzZSB7XG4gICAgICB3YWtlTGFzdFRlbCA9IG51bGw7XG4gICAgICBpZiAoIXdha2VDbGllbnQucmVhZHkgfHwgd2FrZUNsaWVudC5tb2RlbElkICE9PSBtb2RlbC5pZCkgd2FrZUxvYWRpbmcgPSB0cnVlO1xuICAgICAgd2FrZUNsaWVudC5sb2FkKG1vZGVsLmlkLCB3YWtlVGhyZXNob2xkKCkpO1xuICAgICAgd2FrZUNsaWVudC5yZXNldCgpO1xuICAgICAgbG9nKFwib3V0XCIsIGB3YWtlIHdvcmQgbGlzdGVuaW5nICgke21vZGVsLmxhYmVsfSlgLCBcIm91dFwiKTtcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgaWYgKCF3YWtlQXJtZWQpIHdha2VMYXN0VGVsID0gbnVsbDtcbiAgICBsb2coXCJvdXRcIiwgXCJ3YWtlIHdvcmQgb2ZmXCIsIFwib3V0XCIpO1xuICB9XG4gIHN5bmNXYWtlVWkoKTtcbn1cblxuZnVuY3Rpb24gb25XYWtlRGV0ZWN0ZWQoaGl0OiBXYWtlRGV0ZWN0aW9uRXZlbnQpIHtcbiAgaWYgKCFzaG91bGRGZWVkV2FrZSgpKSByZXR1cm47XG4gIGNvbnN0IGxhYmVsID0gc2VsZWN0ZWRXYWtlTW9kZWwoKT8ubGFiZWwgPz8gXCJ3YWtlIHdvcmRcIjtcbiAgbG9nKFwib3V0XCIsIGB3YWtlIGRldGVjdGVkIFx1MjAxQyR7bGFiZWx9XHUyMDFEIChzY29yZSAke2hpdC5zY29yZS50b0ZpeGVkKDIpfSwgJHtoaXQuaW5mZXJNcy50b0ZpeGVkKDEpfSBtcylgLCBcIm91dFwiKTtcbiAgaWYgKGNoZWNrZWQoXCJ3YWtlLWN1ZVwiKSkgdm9pZCBhdWRpby5vcGVuKCkudGhlbigoKSA9PiBhdWRpby5jdWUoV0FLRV9UT05FKSkuY2F0Y2goKCkgPT4ge30pO1xuICB0b2FzdChgSGVhcmQgXHUyMDFDJHtsYWJlbH1cdTIwMUQgKCR7aGl0LnNjb3JlLnRvRml4ZWQoMil9KWApO1xuICBpZiAoY2FsbElkICE9PSAwKSB7XG4gICAgY29uc3QgY29tbWFuZHMgPSBwdXNoKHsgdHlwZTogXCJ3YWtlXCIgfSk7XG4gICAgLy8gV2hlbmV2ZXIgdGhlIGNvcmUgY3V0IGF1ZGlibGUgcGxheWJhY2sgKGZsdXNoKSB1bmRlciBhIG1pYy1zdXBwcmVzc2luZyBwb2xpY3kgKHdoaWxlU3BlYWtpbmcgIT09IFwic2VuZFwiKSxcbiAgICAvLyBmcmFtZXMgZHVyaW5nIHBsYXliYWNrIHdlcmUgcmVwbGFjZWQgd2l0aCBzaWxlbmNlIChib3RoIGxpdmUgYW5kIGluIGRvcm1hbnQvc3RhbmRieSBwcmUtcm9sbCk6XG4gICAgLy8gcmVwbGF5IHRoZSBzcGVlY2ggY2FwdHVyZWQgcmlnaHQgYWZ0ZXIgdGhlIHdha2Ugd29yZCBzbyB0aGUgb3BlbmluZyBzeWxsYWJsZXMgYXJlbid0IGNsaXBwZWQuXG4gICAgY29uc3QgY3V0UmVwbHkgPSBjb21tYW5kcy5zb21lKChjKSA9PiBjLnR5cGUgPT09IFwiZmx1c2hcIik7XG4gICAgaWYgKGN1dFJlcGx5ICYmIGNhbGxXaGlsZVNwZWFraW5nICE9PSBcInNlbmRcIiAmJiBjYWxsSWQgIT09IDAgJiYgaGl0LnRyYWlsaW5nLmxlbmd0aCA+IDApIHtcbiAgICAgIGZvciAoY29uc3QgY2h1bmsgb2YgaGl0LnRyYWlsaW5nKSB7XG4gICAgICAgIGlmICghY2FsbElkKSBicmVhaztcbiAgICAgICAgaWYgKGNodW5rLmJ5dGVMZW5ndGggPT09IDApIGNvbnRpbnVlO1xuICAgICAgICBjb3VudHMubWljKys7XG4gICAgICAgIHB1c2goeyB0eXBlOiBcIm1pY1wiLCBwY206IGJ5dGVzVG9CYXNlNjQoY2h1bmspIH0pO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm47XG4gIH1cbiAgd2FrZVN0YXJ0aW5nID0gdHJ1ZTtcbiAgb3BlbmluZ0NodW5rcyA9IFtdO1xuICBvcGVuaW5nQnl0ZXMgPSAwO1xuICBmb3IgKGNvbnN0IGNodW5rIG9mIGhpdC50cmFpbGluZykge1xuICAgIGlmIChjaHVuay5ieXRlTGVuZ3RoID09PSAwKSBjb250aW51ZTtcbiAgICBvcGVuaW5nQ2h1bmtzLnB1c2goY2h1bmspO1xuICAgIG9wZW5pbmdCeXRlcyArPSBjaHVuay5ieXRlTGVuZ3RoO1xuICAgIHdoaWxlIChvcGVuaW5nQnl0ZXMgPiBPUEVOSU5HX01BWF9CWVRFUyAmJiBvcGVuaW5nQ2h1bmtzLmxlbmd0aCA+IDEpIHtcbiAgICAgIG9wZW5pbmdCeXRlcyAtPSBvcGVuaW5nQ2h1bmtzLnNoaWZ0KCkhLmJ5dGVMZW5ndGg7XG4gICAgfVxuICB9XG4gIHZvaWQgc3RhcnQoY2hhdC5sZW5ndGggPiAwKS50aGVuKChzdGFydGVkKSA9PiB7XG4gICAgaWYgKCFzdGFydGVkICYmIHdha2VTdGFydGluZykge1xuICAgICAgd2FrZVN0YXJ0aW5nID0gZmFsc2U7XG4gICAgICBvcGVuaW5nQ2h1bmtzID0gW107XG4gICAgICBvcGVuaW5nQnl0ZXMgPSAwO1xuICAgICAgc3luY1dha2VVaSgpO1xuICAgIH1cbiAgfSkuY2F0Y2goKGVycikgPT4ge1xuICAgIHdha2VTdGFydGluZyA9IGZhbHNlO1xuICAgIG9wZW5pbmdDaHVua3MgPSBbXTtcbiAgICBvcGVuaW5nQnl0ZXMgPSAwO1xuICAgIHRvYXN0KChlcnIgYXMgRXJyb3IpLm1lc3NhZ2UpO1xuICAgIGxvZyhcImVycm9yXCIsIChlcnIgYXMgRXJyb3IpLm1lc3NhZ2UsIFwiZXJyXCIpO1xuICAgIHN5bmNXYWtlVWkoKTtcbiAgfSk7XG59XG5cbi8vIFdpcmluZy5cblxuZnVuY3Rpb24gc2V0dGluZ3NGcm9tU3RvcmFnZSgpIHtcbiAgZm9yIChjb25zdCBpZCBvZiBbXCJhZWNcIiwgXCJzdG9wd29yZFwiLCBcInB0dFwiLCBcImNhcHRpb25zXCIsIFwiY29kaW5nXCIsIFwiZmFrZWhlcm1lc1wiLCBcInRyYWNlXCIsIFwid2FrZS1jdWVcIiwgXCJ3YWtlLWJhcmdlXCJdKSB7XG4gICAgY29uc3QgdiA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKGB2b2ljZS4ke2lkfWApO1xuICAgIGlmICh2ICE9IG51bGwpICQ8SFRNTElucHV0RWxlbWVudD4oaWQpLmNoZWNrZWQgPSB2ID09PSBcIjFcIjtcbiAgICAkKGlkKS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHtcbiAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKGB2b2ljZS4ke2lkfWAsIGNoZWNrZWQoaWQpID8gXCIxXCIgOiBcIjBcIik7XG4gICAgICBpZiAoaWQgPT09IFwiYWVjXCIgJiYgd2FrZUFybWVkICYmICFjYWxsSWQpIHtcbiAgICAgICAgdm9pZCBhdWRpby5zdGFydE1pYyhvbk1pYywgbWljT3B0aW9ucygpKS5jYXRjaCgoZXJyKSA9PiB0b2FzdChgTWljcm9waG9uZTogJHtlcnIubWVzc2FnZX1gKSk7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cbiAgZm9yIChjb25zdCBbaWQsIGtleV0gb2YgW1xuICAgIFtcImZha2VkZWxheVwiLCBcInZvaWNlLmZha2VkZWxheVwiXSxcbiAgICBbXCJhdHRuLWFmdGVyLXdha2VcIiwgXCJ2b2ljZS5hdHRuLWFmdGVyLXdha2VcIl0sXG4gICAgW1wiYXR0bi13aW5kb3dcIiwgXCJ2b2ljZS5hdHRuLXdpbmRvd1wiXSxcbiAgICBbXCJhdHRuLWFmdGVyLXF1ZXN0aW9uXCIsIFwidm9pY2UuYXR0bi1hZnRlci1xdWVzdGlvblwiXSxcbiAgICBbXCJoYW5ndXAtYWZ0ZXJcIiwgXCJ2b2ljZS5oYW5ndXAtYWZ0ZXJcIl0sXG4gIF0gYXMgY29uc3QpIHtcbiAgICBjb25zdCBzYXZlZCA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKGtleSk7XG4gICAgaWYgKHNhdmVkICE9IG51bGwpICQ8SFRNTElucHV0RWxlbWVudD4oaWQpLnZhbHVlID0gc2F2ZWQ7XG4gICAgJChpZCkuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiB7XG4gICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShrZXksICQ8SFRNTElucHV0RWxlbWVudD4oaWQpLnZhbHVlKTtcbiAgICAgIGlmIChpZCA9PT0gXCJoYW5ndXAtYWZ0ZXJcIikgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS5oYW5ndXAtY3VzdG9tXCIsIFwiMVwiKTtcbiAgICB9KTtcbiAgfVxuICBjb25zdCB0aHJlc2ggPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLndha2UtdGhyZXNob2xkXCIpO1xuICBpZiAodGhyZXNoICE9IG51bGwpICQ8SFRNTElucHV0RWxlbWVudD4oXCJ3YWtlLXRocmVzaG9sZFwiKS52YWx1ZSA9IHRocmVzaDtcbiAgJChcIndha2UtdGhyZXNob2xkLXZhbFwiKS50ZXh0Q29udGVudCA9IHdha2VUaHJlc2hvbGQoKS50b0ZpeGVkKDIpO1xuICAkKFwid2FrZS10aHJlc2hvbGRcIikuYWRkRXZlbnRMaXN0ZW5lcihcImlucHV0XCIsICgpID0+IHtcbiAgICBjb25zdCB2ID0gd2FrZVRocmVzaG9sZCgpO1xuICAgICQoXCJ3YWtlLXRocmVzaG9sZC12YWxcIikudGV4dENvbnRlbnQgPSB2LnRvRml4ZWQoMik7XG4gICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS53YWtlLXRocmVzaG9sZFwiLCB2LnRvRml4ZWQoMikpO1xuICAgIHdha2VDbGllbnQuc2V0VGhyZXNob2xkKHYpO1xuICAgIHJlbmRlcldha2VUZWxlbWV0cnkoKTtcbiAgfSk7XG4gIGNvbnN0IHNpZ25hbGluZyA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2Uuc2lnbmFsaW5nXCIpO1xuICBpZiAoc2lnbmFsaW5nKSAkPEhUTUxTZWxlY3RFbGVtZW50PihcInNpZ25hbGluZ1wiKS52YWx1ZSA9IHNpZ25hbGluZztcbiAgJChcInNpZ25hbGluZ1wiKS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHtcbiAgICBjb25zdCBtb2RlID0gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJzaWduYWxpbmdcIikudmFsdWU7XG4gICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS5zaWduYWxpbmdcIiwgbW9kZSk7XG4gICAgaWYgKGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UuaGFuZ3VwLWN1c3RvbVwiKSAhPT0gXCIxXCIpIHtcbiAgICAgIGNvbnN0IGRlZiA9IG1vZGUgPT09IFwiZWNob1wiID8gXCIxNVwiIDogXCIzMDBcIjtcbiAgICAgICQ8SFRNTElucHV0RWxlbWVudD4oXCJoYW5ndXAtYWZ0ZXJcIikudmFsdWUgPSBkZWY7XG4gICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLmhhbmd1cC1hZnRlclwiLCBkZWYpO1xuICAgIH1cbiAgICBzeW5jU2lnbmFsaW5nVWkoKTtcbiAgfSk7XG4gICQoXCJ3YWtlLWVuYWJsZWRcIikuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiB2b2lkIGFybVdha2UoY2hlY2tlZChcIndha2UtZW5hYmxlZFwiKSkpO1xuICAkKFwid2FrZS1tb2RlbFwiKS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHtcbiAgICBjb25zdCBpZCA9ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwid2FrZS1tb2RlbFwiKS52YWx1ZTtcbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLndha2UtbW9kZWxcIiwgaWQpO1xuICAgIGlmICh3YWtlQXJtZWQgfHwgY29yZVdhbnRzV2FrZSkge1xuICAgICAgd2FrZUxvYWRpbmcgPSB0cnVlO1xuICAgICAgd2FrZUxhc3RUZWwgPSBudWxsO1xuICAgICAgd2FrZUNsaWVudC5sb2FkKGlkLCB3YWtlVGhyZXNob2xkKCkpO1xuICAgICAgc3luY1dha2VVaSgpO1xuICAgIH0gZWxzZSB7XG4gICAgICBzeW5jV2FrZVVpKCk7XG4gICAgfVxuICB9KTtcbiAgY29uc3Qgdm9pY2UgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLnZvaWNlXCIpO1xuICBpZiAodm9pY2UpICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwidm9pY2VcIikudmFsdWUgPSB2b2ljZTtcbiAgJChcInZvaWNlXCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4gbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS52b2ljZVwiLCAkPEhUTUxTZWxlY3RFbGVtZW50PihcInZvaWNlXCIpLnZhbHVlKSk7XG4gIGNvbnN0IG1vZGUgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLm1vZGVcIik7XG4gIGlmIChtb2RlKSAkPEhUTUxTZWxlY3RFbGVtZW50PihcIm1vZGVcIikudmFsdWUgPSBtb2RlO1xuICAkKFwibW9kZVwiKS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHtcbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLm1vZGVcIiwgJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJtb2RlXCIpLnZhbHVlKTtcbiAgICBzeW5jQ29tcG9zZXIoKTtcbiAgfSk7XG4gIGNvbnN0IHRoZW1lID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS50aGVtZVwiKSA/PyBcInN5c3RlbVwiO1xuICBhcHBseVRoZW1lKHRoZW1lKTtcbiAgZm9yIChjb25zdCBidG4gb2YgQXJyYXkuZnJvbShkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxCdXR0b25FbGVtZW50PihcIiN0aGVtZS1waWNrZXIgYnV0dG9uXCIpKSkge1xuICAgIGJ0bi5vbmNsaWNrID0gKCkgPT4ge1xuICAgICAgY29uc3QgY2hvaWNlID0gYnRuLmRhdGFzZXQudGhlbWUgPz8gXCJzeXN0ZW1cIjtcbiAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2UudGhlbWVcIiwgY2hvaWNlKTtcbiAgICAgIGFwcGx5VGhlbWUoY2hvaWNlKTtcbiAgICB9O1xuICB9XG4gIGNvbnN0IGRlbnNpdHkgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLmRlbnNpdHlcIik7XG4gIGFwcGx5RGVuc2l0eShkZW5zaXR5KTtcbiAgZm9yIChjb25zdCBidG4gb2YgQXJyYXkuZnJvbShkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxCdXR0b25FbGVtZW50PihcIiNkZW5zaXR5LXBpY2tlciBidXR0b25cIikpKSB7XG4gICAgYnRuLm9uY2xpY2sgPSAoKSA9PiB7XG4gICAgICBjb25zdCBjaG9pY2UgPSBub3JtYWxpemVEZW5zaXR5KGJ0bi5kYXRhc2V0LmRlbnNpdHkpO1xuICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS5kZW5zaXR5XCIsIGNob2ljZSk7XG4gICAgICBhcHBseURlbnNpdHkoY2hvaWNlKTtcbiAgICB9O1xuICB9XG4gIG1hdGNoTWVkaWEoXCIocHJlZmVycy1jb2xvci1zY2hlbWU6IGRhcmspXCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4ge1xuICAgIGlmICgobG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS50aGVtZVwiKSA/PyBcInN5c3RlbVwiKSA9PT0gXCJzeXN0ZW1cIikgYXBwbHlUaGVtZShcInN5c3RlbVwiKTtcbiAgfSk7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJ2aXNpYmlsaXR5Y2hhbmdlXCIsICgpID0+IHtcbiAgICBpZiAoIWRvY3VtZW50LmhpZGRlbiAmJiAoY2FsbElkIHx8IHdha2VBcm1lZCkpIHZvaWQgYWNxdWlyZVdha2VMb2NrKCk7XG4gIH0pO1xuICBhdWRpby5vbkF1ZGlvU3RhdGVDaGFuZ2UoKCkgPT4gc3luY1dha2VVaSgpKTtcbiAgY29uc3QgcmVzdW1lSWZTdXNwZW5kZWQgPSAoKSA9PiB7XG4gICAgaWYgKGF1ZGlvLmF1ZGlvU3VzcGVuZGVkICYmICh3YWtlQXJtZWQgfHwgY2FsbElkKSkge1xuICAgICAgdm9pZCBhdWRpby5yZXN1bWVBdWRpbygpLnRoZW4oKCkgPT4gc3luY1dha2VVaSgpKTtcbiAgICB9XG4gIH07XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJwb2ludGVyZG93blwiLCByZXN1bWVJZlN1c3BlbmRlZCwgeyBwYXNzaXZlOiB0cnVlIH0pO1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwicG9pbnRlcnVwXCIsIHJlc3VtZUlmU3VzcGVuZGVkLCB7IHBhc3NpdmU6IHRydWUgfSk7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCByZXN1bWVJZlN1c3BlbmRlZCwgeyBwYXNzaXZlOiB0cnVlIH0pO1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCByZXN1bWVJZlN1c3BlbmRlZCwgeyBwYXNzaXZlOiB0cnVlIH0pO1xuICBzeW5jU2lnbmFsaW5nVWkoKTtcbn1cblxuY29uc3QgbW9iaWxlTGF5b3V0ID0gbWF0Y2hNZWRpYShcIihtYXgtd2lkdGg6IDkyMHB4KVwiKTtcbmxldCBkcmF3ZXJPcGVuZXI6IEhUTUxFbGVtZW50IHwgbnVsbCA9IG51bGw7XG5cbmZ1bmN0aW9uIHNldFRhc2tzT3BlbihvcGVuOiBib29sZWFuLCBvcGVuZXI/OiBIVE1MRWxlbWVudCB8IG51bGwpIHtcbiAgY29uc3QgY2FuT3BlbiA9IG1vYmlsZUxheW91dC5tYXRjaGVzICYmICEkKFwidGFsa1wiKS5oaWRkZW47XG4gIGNvbnN0IG5leHQgPSBvcGVuICYmIGNhbk9wZW47XG4gIGNvbnN0IHdhc09wZW4gPSBkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5jb250YWlucyhcInRhc2tzLW9wZW5cIik7XG4gIGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LnRvZ2dsZShcInRhc2tzLW9wZW5cIiwgbmV4dCk7XG4gIGNvbnN0IGhlYWRlciA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoXCJoZWFkZXJcIikgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAoaGVhZGVyKSBoZWFkZXIuaW5lcnQgPSBuZXh0O1xuICAkKFwiY29udm9cIikuaW5lcnQgPSBuZXh0O1xuICAkKFwic2lkZVwiKS5pbmVydCA9IG1vYmlsZUxheW91dC5tYXRjaGVzICYmICFuZXh0O1xuICAkKFwidGFza3MtdG9nZ2xlXCIpLnNldEF0dHJpYnV0ZShcImFyaWEtZXhwYW5kZWRcIiwgU3RyaW5nKG5leHQpKTtcbiAgJChcIm1vYmlsZS10YXNrcy1iYXJcIikuc2V0QXR0cmlidXRlKFwiYXJpYS1leHBhbmRlZFwiLCBTdHJpbmcobmV4dCkpO1xuICBpZiAobmV4dCAmJiAhd2FzT3Blbikge1xuICAgIGRyYXdlck9wZW5lciA9IG9wZW5lciA/PyAoZG9jdW1lbnQuYWN0aXZlRWxlbWVudCBhcyBIVE1MRWxlbWVudCB8IG51bGwpO1xuICAgIGNsZWFyVW5yZWFkSWZSZXN1bHRzVmlzaWJsZSgpO1xuICAgICQoXCJ0YXNrcy1jbG9zZVwiKS5mb2N1cygpO1xuICAgIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB1cGRhdGVBbGxSZXN1bHRDbGFtcGluZygpKTtcbiAgfSBlbHNlIGlmICghbmV4dCAmJiB3YXNPcGVuKSB7XG4gICAgY29uc3QgdGFyZ2V0ID0gZHJhd2VyT3BlbmVyO1xuICAgIGRyYXdlck9wZW5lciA9IG51bGw7XG4gICAgaWYgKHRhcmdldCAmJiB0YXJnZXQuaXNDb25uZWN0ZWQgJiYgIXRhcmdldC5oaWRkZW4gJiYgdGFyZ2V0Lm9mZnNldFBhcmVudCAhPT0gbnVsbCkge1xuICAgICAgdGFyZ2V0LmZvY3VzKCk7XG4gICAgfSBlbHNlIGlmICh0YXJnZXQgPT09ICQoXCJtb2JpbGUtdGFza3MtYmFyXCIpKSB7XG4gICAgICBjb25zdCBmYWxsYmFjayA9ICQoXCJ0YXNrcy10b2dnbGVcIik7XG4gICAgICBpZiAoIWZhbGxiYWNrLmhpZGRlbiAmJiBmYWxsYmFjay5vZmZzZXRQYXJlbnQgIT09IG51bGwpIGZhbGxiYWNrLmZvY3VzKCk7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIHRhYnMoKSB7XG4gIGNvbnN0IHZpZXdzOiBSZWNvcmQ8c3RyaW5nLCBIVE1MRWxlbWVudD4gPSB7IHRhbGs6ICQoXCJ0YWxrXCIpLCBkZXY6ICQoXCJkZXZcIiksIHJlcGxheTogJChcInJlcGxheW1haW5cIikgfTtcbiAgZm9yIChjb25zdCBuYW1lIG9mIE9iamVjdC5rZXlzKHZpZXdzKSkge1xuICAgICQoYHRhYi0ke25hbWV9YCkub25jbGljayA9ICgpID0+IHtcbiAgICAgIGZvciAoY29uc3QgW290aGVyLCBlbF0gb2YgT2JqZWN0LmVudHJpZXModmlld3MpKSB7XG4gICAgICAgIGVsLmhpZGRlbiA9IG90aGVyICE9PSBuYW1lO1xuICAgICAgICAkKGB0YWItJHtvdGhlcn1gKS5jbGFzc0xpc3QudG9nZ2xlKFwib25cIiwgb3RoZXIgPT09IG5hbWUpO1xuICAgICAgfVxuICAgICAgJChcInRhc2tzLXRvZ2dsZVwiKS5oaWRkZW4gPSBuYW1lICE9PSBcInRhbGtcIjtcbiAgICAgIHNldFRhc2tzT3BlbihmYWxzZSk7XG4gICAgICBpZiAobmFtZSA9PT0gXCJ0YWxrXCIpIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB1cGRhdGVBbGxSZXN1bHRDbGFtcGluZygpKTtcbiAgICB9O1xuICB9XG4gIGZvciAoY29uc3QgYnRuIG9mIEFycmF5LmZyb20oZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MQnV0dG9uRWxlbWVudD4oXCIjc2lkZS10YWJzIGJ1dHRvblwiKSkpIHtcbiAgICBidG4ub25jbGljayA9ICgpID0+IHNldFNpZGVGaWx0ZXIobm9ybWFsaXplU2lkZUZpbHRlcihidG4uZGF0YXNldC5maWx0ZXIpKTtcbiAgfVxuICAkKFwidG9nZ2xlLWFsbC1yZXN1bHRzXCIpLm9uY2xpY2sgPSAoKSA9PiB7XG4gICAgY29uc3QgY2xhbXBlZCA9IFsuLi5yZXN1bHRzLnZhbHVlcygpXS5maWx0ZXIoKHIpID0+IHIuY2FyZC5jbGFzc0xpc3QuY29udGFpbnMoXCJjbGFtcGVkXCIpKTtcbiAgICBjb25zdCBvcGVuQWxsID0gY2xhbXBlZC5zb21lKChyKSA9PiAhci5jYXJkLmNsYXNzTGlzdC5jb250YWlucyhcIm9wZW5cIikpO1xuICAgIGZvciAoY29uc3QgZW50cnkgb2YgY2xhbXBlZCkgc2V0UmVzdWx0T3BlbihlbnRyeSwgb3BlbkFsbCk7XG4gIH07XG4gICQoXCJnZWFyXCIpLm9uY2xpY2sgPSAoKSA9PiB7ICQoXCJzZXR0aW5nc1wiKS5oaWRkZW4gPSBmYWxzZTsgfTtcbiAgJChcImNsb3Nlc2V0dGluZ3NcIikub25jbGljayA9ICgpID0+IHsgJChcInNldHRpbmdzXCIpLmhpZGRlbiA9IHRydWU7IH07XG4gICQoXCJjbG9zZXNldHRpbmdzLXhcIikub25jbGljayA9ICgpID0+IHsgJChcInNldHRpbmdzXCIpLmhpZGRlbiA9IHRydWU7IH07XG4gICQoXCJzZXR0aW5nc1wiKS5vbmNsaWNrID0gKGUpID0+IHsgaWYgKGUudGFyZ2V0ID09PSAkKFwic2V0dGluZ3NcIikpICQoXCJzZXR0aW5nc1wiKS5oaWRkZW4gPSB0cnVlOyB9O1xuICBjb25zdCBvcGVuTW9iaWxlVGFza3NEcmF3ZXIgPSAob3BlbmVyOiBIVE1MRWxlbWVudCkgPT4ge1xuICAgIGNvbnN0IGFjdGl2ZVRvdGFsID0gWy4uLnRhc2tzLnZhbHVlcygpXS5maWx0ZXIoaXNBY3RpdmVUYXNrKS5sZW5ndGggKyBlYXJsaWVyQWN0aXZlQ291bnQ7XG4gICAgY29uc3QgbmV4dEZpbHRlciA9IHJlc29sdmVNb2JpbGVCYW5uZXJGaWx0ZXIoc2lkZUZpbHRlciwgYWN0aXZlVG90YWwsIHVucmVhZE1vYmlsZVJlc3VsdHMpO1xuICAgIGlmIChuZXh0RmlsdGVyICE9PSBzaWRlRmlsdGVyKSBzZXRTaWRlRmlsdGVyKG5leHRGaWx0ZXIpO1xuICAgIHNldFRhc2tzT3Blbih0cnVlLCBvcGVuZXIpO1xuICB9O1xuICAkKFwidGFza3MtdG9nZ2xlXCIpLm9uY2xpY2sgPSAoKSA9PiB7XG4gICAgaWYgKGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LmNvbnRhaW5zKFwidGFza3Mtb3BlblwiKSkgc2V0VGFza3NPcGVuKGZhbHNlKTtcbiAgICBlbHNlIG9wZW5Nb2JpbGVUYXNrc0RyYXdlcigkKFwidGFza3MtdG9nZ2xlXCIpKTtcbiAgfTtcbiAgJChcIm1vYmlsZS10YXNrcy1iYXJcIikub25jbGljayA9ICgpID0+IG9wZW5Nb2JpbGVUYXNrc0RyYXdlcigkKFwibW9iaWxlLXRhc2tzLWJhclwiKSk7XG4gICQoXCJ0YXNrcy1jbG9zZVwiKS5vbmNsaWNrID0gKCkgPT4gc2V0VGFza3NPcGVuKGZhbHNlKTtcbiAgJChcInNpZGUtYmFja2Ryb3BcIikub25jbGljayA9ICgpID0+IHNldFRhc2tzT3BlbihmYWxzZSk7XG4gIG1vYmlsZUxheW91dC5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHtcbiAgICBzZXRUYXNrc09wZW4oZmFsc2UpO1xuICAgIGNsZWFyVW5yZWFkSWZSZXN1bHRzVmlzaWJsZSgpO1xuICAgIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB1cGRhdGVBbGxSZXN1bHRDbGFtcGluZygpKTtcbiAgfSk7XG4gIHNldFRhc2tzT3BlbihmYWxzZSk7XG59XG5cbmZ1bmN0aW9uIHR5cGluZygpOiBib29sZWFuIHtcbiAgY29uc3QgZWwgPSBkb2N1bWVudC5hY3RpdmVFbGVtZW50IGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgcmV0dXJuICEhZWwgJiYgKGVsLnRhZ05hbWUgPT09IFwiSU5QVVRcIiB8fCBlbC50YWdOYW1lID09PSBcIlRFWFRBUkVBXCIgfHwgZWwudGFnTmFtZSA9PT0gXCJTRUxFQ1RcIiB8fCBlbC5pc0NvbnRlbnRFZGl0YWJsZSk7XG59XG5cbmZ1bmN0aW9uIGtleXMoKSB7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJrZXlkb3duXCIsIChlKSA9PiB7XG4gICAgaWYgKGUua2V5ID09PSBcIkVzY2FwZVwiKSB7XG4gICAgICBpZiAoISQoXCJzZXR0aW5nc1wiKS5oaWRkZW4pIHsgJChcInNldHRpbmdzXCIpLmhpZGRlbiA9IHRydWU7IHJldHVybjsgfVxuICAgICAgaWYgKGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LmNvbnRhaW5zKFwidGFza3Mtb3BlblwiKSAmJiBtb2JpbGVMYXlvdXQubWF0Y2hlcyAmJiAhJChcInRhbGtcIikuaGlkZGVuKSB7IHNldFRhc2tzT3BlbihmYWxzZSk7IHJldHVybjsgfVxuICAgICAgaWYgKGNhbGxJZCkgeyBwdXNoKHsgdHlwZTogXCJpbnRlcnJ1cHRcIiB9KTsgYXVkaW8uZmx1c2goKTsgcmV0dXJuOyB9XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICh0eXBpbmcoKSB8fCAhJChcInNldHRpbmdzXCIpLmhpZGRlbiB8fCBkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5jb250YWlucyhcInRhc2tzLW9wZW5cIikgfHwgZS5tZXRhS2V5IHx8IGUuY3RybEtleSB8fCBlLmFsdEtleSkgcmV0dXJuO1xuICAgIGlmIChlLmtleSA9PT0gXCJtXCIgfHwgZS5rZXkgPT09IFwiTVwiKSB7IHNldE11dGVkKCFtdXRlZCk7IGUucHJldmVudERlZmF1bHQoKTsgfVxuICAgIGVsc2UgaWYgKGUua2V5ID09PSBcIndcIiB8fCBlLmtleSA9PT0gXCJXXCIpIHsgdm9pZCBhcm1XYWtlKCF3YWtlQXJtZWQpOyBlLnByZXZlbnREZWZhdWx0KCk7IH1cbiAgICBlbHNlIGlmIChlLmtleSA9PT0gXCIvXCIpIHsgJChcInRleHRcIikuZm9jdXMoKTsgZS5wcmV2ZW50RGVmYXVsdCgpOyB9XG4gICAgZWxzZSBpZiAoZS5jb2RlID09PSBcIlNwYWNlXCIgJiYgY2FsbElkICYmIG11dGVkICYmICFlLnJlcGVhdCkgeyBob2xkaW5nID0gdHJ1ZTsgcHVzaCh7IHR5cGU6IFwidW5tdXRlXCIgfSk7IHNob3dTdGF0dXMoKTsgZS5wcmV2ZW50RGVmYXVsdCgpOyB9XG4gIH0pO1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5dXBcIiwgKGUpID0+IHtcbiAgICBpZiAoZS5jb2RlID09PSBcIlNwYWNlXCIgJiYgaG9sZGluZykgeyBob2xkaW5nID0gZmFsc2U7IHB1c2goeyB0eXBlOiBcIm11dGVcIiB9KTsgc2hvd1N0YXR1cygpOyB9XG4gIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBzdWJtaXRUZXh0KGU6IEV2ZW50KSB7XG4gIGUucHJldmVudERlZmF1bHQoKTtcbiAgY29uc3QgaW5wdXQgPSAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwidGV4dFwiKTtcbiAgbGV0IHRleHQgPSBpbnB1dC52YWx1ZS50cmltKCk7XG4gIGlmICghdGV4dCkgcmV0dXJuO1xuICAvLyBXaXRoIG5vIGNhbGwgb24sIHR5cGluZyBzdGFydHMgYSBjaGF0OiB0aGUgc2FtZSBtYWluIHRocmVhZCwgaW4gdGV4dC5cbiAgaWYgKCFjYWxsSWQpIHtcbiAgICBpbnB1dC52YWx1ZSA9IFwiXCI7XG4gICAgc3luY0NvbXBvc2VyKCk7XG4gICAgdHJ5IHsgYXdhaXQgc3RhcnQoZmFsc2UsIHRydWUpOyB9IGNhdGNoIChlcnIpIHsgdG9hc3QoKGVyciBhcyBFcnJvcikubWVzc2FnZSk7IGxvZyhcImVycm9yXCIsIChlcnIgYXMgRXJyb3IpLm1lc3NhZ2UsIFwiZXJyXCIpOyB9XG4gICAgaWYgKCFjYWxsSWQpIHsgaW5wdXQudmFsdWUgPSB0ZXh0OyBzeW5jQ29tcG9zZXIoKTsgcmV0dXJuOyB9XG4gIH1cbiAgLy8gXCIvdDMgXHUyMDI2XCIgYW5kIFwiL2ggXHUyMDI2XCIgcGljayB0aGUgYWdlbnQgd2hhdGV2ZXIgdGhlIHNlbGVjdG9yIHNheXMuXG4gIGNvbnN0IHBhcnNlZCA9IHBhcnNlUHJlZml4KHRleHQpO1xuICBjb25zdCBtb2RlID0gcGFyc2VkLm1vZGUgPz8gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJtb2RlXCIpLnZhbHVlO1xuICB0ZXh0ID0gcGFyc2VkLnJlc3Q7XG4gIGlmICghdGV4dCkgcmV0dXJuO1xuICBpZiAobW9kZSA9PT0gXCJzYXlcIikge1xuICAgIHB1c2goeyB0eXBlOiBcInNheVwiLCB0ZXh0IH0pO1xuICAgIHNjcm9sbERvd24odHJ1ZSk7XG4gIH0gZWxzZSB7XG4gICAgcHVzaCh7IHR5cGU6IFwiYXNrXCIsIHRleHQsIGFnZW50OiBtb2RlIH0pO1xuICAgIG5vdGUoYFlvdSBcdTIxOTIgbmV3ICR7bW9kZSA9PT0gXCJ0M1wiID8gXCJjb2RpbmdcIiA6IFwiSGVybWVzXCJ9IHRhc2s6ICR7dGV4dH1gKTtcbiAgICBzY3JvbGxEb3duKHRydWUpO1xuICB9XG4gIGlucHV0LnZhbHVlID0gXCJcIjtcbiAgc3luY0NvbXBvc2VyKCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIG1haW4oKSB7XG4gIGFwcGx5VGhlbWUobG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS50aGVtZVwiKSA/PyBcInN5c3RlbVwiKTtcbiAgYXBwbHlEZW5zaXR5KGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UuZGVuc2l0eVwiKSk7XG4gIHNlcnZlciA9IGF3YWl0IChhd2FpdCBmZXRjaChcIi9jb25maWdcIikpLmpzb24oKTtcbiAgJChcInJvdXRlXCIpLnRleHRDb250ZW50ID0gYCR7c2VydmVyLnJvdXRlID09PSBcInZlcnRleFwiID8gXCJWZXJ0ZXhcIiA6IFwiR2VtaW5pIEFQSVwifSBcdTAwQjcgJHtzZXJ2ZXIubW9kZWwuc3BsaXQoXCIvXCIpLnBvcCgpfWA7XG4gICQoXCJ2ZXJzaW9uXCIpLnRleHRDb250ZW50ID0gc2VydmVyLnZlcnNpb247XG4gICQoXCJidWlsZFwiKS50ZXh0Q29udGVudCA9IGBjb3JlICR7c2VydmVyLnZlcnNpb259YDtcbiAgc2V0dGluZ3NGcm9tU3RvcmFnZSgpO1xuICBjb25zdCB3YWtlU2VsZWN0ID0gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJ3YWtlLW1vZGVsXCIpO1xuICBjb25zdCB3YWtlTGlzdCA9IHNlcnZlci53YWtlTW9kZWxzID8/IFtdO1xuICBmb3IgKGNvbnN0IG0gb2Ygd2FrZUxpc3QpIHdha2VTZWxlY3QuYWRkKG5ldyBPcHRpb24obS5sYWJlbCwgbS5pZCkpO1xuICBjb25zdCBzYXZlZFdha2VNb2RlbCA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2Uud2FrZS1tb2RlbFwiKTtcbiAgaWYgKHNhdmVkV2FrZU1vZGVsICYmIHdha2VMaXN0LnNvbWUoKG0pID0+IG0uaWQgPT09IHNhdmVkV2FrZU1vZGVsKSkgd2FrZVNlbGVjdC52YWx1ZSA9IHNhdmVkV2FrZU1vZGVsO1xuICBlbHNlIGlmICh3YWtlTGlzdC5zb21lKChtKSA9PiBtLmlkID09PSBcInBlbm55d29ydGhcIikpIHdha2VTZWxlY3QudmFsdWUgPSBcInBlbm55d29ydGhcIjtcbiAgaWYgKHdha2VMaXN0Lmxlbmd0aCA9PT0gMCkge1xuICAgICQ8SFRNTElucHV0RWxlbWVudD4oXCJ3YWtlLWVuYWJsZWRcIikuZGlzYWJsZWQgPSB0cnVlO1xuICAgIHdha2VTZWxlY3QuZGlzYWJsZWQgPSB0cnVlO1xuICAgICQoXCJ3YWtlLWhlbHBcIikudGV4dENvbnRlbnQgPSBcIk5vIC5vbm54IHdha2Ugd29yZCBtb2RlbHMgZm91bmQgb24gdGhlIHNlcnZlci5cIjtcbiAgfVxuICBpZiAoIXNlcnZlci5oZXJtZXMpIHsgJDxIVE1MSW5wdXRFbGVtZW50PihcImZha2VoZXJtZXNcIikuY2hlY2tlZCA9IHRydWU7ICQ8SFRNTElucHV0RWxlbWVudD4oXCJmYWtlaGVybWVzXCIpLmRpc2FibGVkID0gdHJ1ZTsgfVxuICBpZiAoIXNlcnZlci50MykgJChcImNvZGluZ2hlbHBcIikudGV4dENvbnRlbnQgPSBcIlQzIGlzbid0IGF2YWlsYWJsZSBvbiB0aGUgc2VydmVyOiBvbmx5IHdpdGggZmFrZSBhbnN3ZXJzLlwiO1xuICBlbHNlICQoXCJjb2RpbmdoZWxwXCIpLnRleHRDb250ZW50ID0gYENvZGUgY2hhbmdlcyBnbyB0byBhIFQzIENvZGUgdGhyZWFkIGluIG9uZSBvZjogJHtzZXJ2ZXIudDMuam9pbihcIiwgXCIpfS5gO1xuICBpZiAoIXN0b3BXb3Jkcy5zdXBwb3J0ZWQpIHsgJDxIVE1MSW5wdXRFbGVtZW50PihcInN0b3B3b3JkXCIpLmNoZWNrZWQgPSBmYWxzZTsgJDxIVE1MSW5wdXRFbGVtZW50PihcInN0b3B3b3JkXCIpLmRpc2FibGVkID0gdHJ1ZTsgfVxuICBjb25zdCBwcmVzZXQgPSAkPEhUTUxTZWxlY3RFbGVtZW50PihcInByZXNldFwiKTtcbiAgZm9yIChjb25zdCBuYW1lIG9mIE9iamVjdC5rZXlzKFBSRVNFVFMpKSBwcmVzZXQuYWRkKG5ldyBPcHRpb24obmFtZSwgbmFtZSkpO1xuICBwcmVzZXQudmFsdWUgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLWNvcmUucHJlc2V0XCIpID8/IFwid2ViXCI7XG4gIGlmICghUFJFU0VUU1twcmVzZXQudmFsdWVdKSBwcmVzZXQudmFsdWUgPSBcIndlYlwiO1xuICAkPEhUTUxUZXh0QXJlYUVsZW1lbnQ+KFwiY29uZmlnXCIpLnZhbHVlID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS1jb3JlLmNvbmZpZ1wiKSA/PyBKU09OLnN0cmluZ2lmeShQUkVTRVRTW3ByZXNldC52YWx1ZV0sIG51bGwsIDIpO1xuICBzeW5jU2lnbmFsaW5nVWkoKTtcbiAgcHJlc2V0Lm9uY2hhbmdlID0gKCkgPT4ge1xuICAgICQ8SFRNTFRleHRBcmVhRWxlbWVudD4oXCJjb25maWdcIikudmFsdWUgPSBKU09OLnN0cmluZ2lmeShQUkVTRVRTW3ByZXNldC52YWx1ZV0sIG51bGwsIDIpO1xuICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2UtY29yZS5wcmVzZXRcIiwgcHJlc2V0LnZhbHVlKTtcbiAgICBsb2NhbFN0b3JhZ2UucmVtb3ZlSXRlbShcInZvaWNlLWNvcmUuY29uZmlnXCIpO1xuICAgIHN5bmNTaWduYWxpbmdVaSgpO1xuICB9O1xuICAkKFwiY29uZmlnXCIpLm9uaW5wdXQgPSAoKSA9PiB7IGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2UtY29yZS5jb25maWdcIiwgJDxIVE1MVGV4dEFyZWFFbGVtZW50PihcImNvbmZpZ1wiKS52YWx1ZSk7IHN5bmNTaWduYWxpbmdVaSgpOyB9O1xuICAkKFwiZGVmYXVsdHNcIikub25jbGljayA9IGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBjID0gY29yZSA/PyAoYXdhaXQgbG9hZENvcmUoKSk7XG4gICAgJChcImRlZmF1bHRzdmlld1wiKS50ZXh0Q29udGVudCA9IEpTT04uc3RyaW5naWZ5KEpTT04ucGFyc2UoYy5kZWZhdWx0cygpKSwgbnVsbCwgMik7XG4gICAgJChcImRlZmF1bHRzdmlld1wiKS5oaWRkZW4gPSAhJChcImRlZmF1bHRzdmlld1wiKS5oaWRkZW47XG4gIH07XG4gIGNvbnN0IG9uQ2FsbENsaWNrID0gKCkgPT4gdm9pZCBjYWxsQnV0dG9uKCkuY2F0Y2goKGVycikgPT4geyB0b2FzdChlcnIubWVzc2FnZSk7IGxvZyhcImVycm9yXCIsIGVyci5tZXNzYWdlLCBcImVyclwiKTsgfSk7XG4gIGNvbnN0IG9uSGVyb0NhbGxDbGljayA9ICgpID0+IHsgaWYgKCFjYWxsSWQpIHZvaWQgc3RhcnQoKS5jYXRjaCgoZXJyKSA9PiB7IHRvYXN0KGVyci5tZXNzYWdlKTsgbG9nKFwiZXJyb3JcIiwgZXJyLm1lc3NhZ2UsIFwiZXJyXCIpOyB9KTsgfTtcbiAgY29uc3Qgb25SZXN1bWVDbGljayA9ICgpID0+IHZvaWQgc3RhcnQodHJ1ZSkuY2F0Y2goKGVycikgPT4geyB0b2FzdChlcnIubWVzc2FnZSk7IGxvZyhcImVycm9yXCIsIGVyci5tZXNzYWdlLCBcImVyclwiKTsgfSk7XG4gICQoXCJjYWxsXCIpLm9uY2xpY2sgPSBvbkNhbGxDbGljaztcbiAgJChcImhlcm8tY2FsbFwiKS5vbmNsaWNrID0gb25IZXJvQ2FsbENsaWNrO1xuICAkKFwiaGVyby13YWtlXCIpLm9uY2xpY2sgPSAoKSA9PiB7XG4gICAgaWYgKHdha2VBcm1lZCAmJiBhdWRpby5hdWRpb1N1c3BlbmRlZCkgeyB2b2lkIGF1ZGlvLnJlc3VtZUF1ZGlvKCkudGhlbigoKSA9PiBzeW5jV2FrZVVpKCkpOyByZXR1cm47IH1cbiAgICB2b2lkIGFybVdha2UoIXdha2VBcm1lZCk7XG4gIH07XG4gICQoXCJ3YWtlYnRuXCIpLm9uY2xpY2sgPSAoKSA9PiB7XG4gICAgaWYgKHdha2VBcm1lZCAmJiBhdWRpby5hdWRpb1N1c3BlbmRlZCkgeyB2b2lkIGF1ZGlvLnJlc3VtZUF1ZGlvKCkudGhlbigoKSA9PiBzeW5jV2FrZVVpKCkpOyByZXR1cm47IH1cbiAgICB2b2lkIGFybVdha2UoIXdha2VBcm1lZCk7XG4gIH07XG4gICQoXCJ3YWtlLW5vd1wiKS5vbmNsaWNrID0gKCkgPT4geyBpZiAoY2FsbElkKSBwdXNoKHsgdHlwZTogXCJyZXN1bWVcIiB9KTsgfTtcbiAgJChcInJlc3VtZVwiKS5vbmNsaWNrID0gb25SZXN1bWVDbGljaztcbiAgJChcImhlcm8tcmVzdW1lXCIpLm9uY2xpY2sgPSBvblJlc3VtZUNsaWNrO1xuICBzeW5jV2FrZVVpKCk7XG4gIGlmIChsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLndha2UtZW5hYmxlZFwiKSA9PT0gXCIxXCIgJiYgd2FrZUxpc3QubGVuZ3RoID4gMCkge1xuICAgIC8vIFJlLWFybSBhdXRvbWF0aWNhbGx5IG9uIHJlbG9hZCBvbmx5IHdoZW4gbWljcm9waG9uZSBwZXJtaXNzaW9uIGlzIGFscmVhZHkgZ3JhbnRlZC5cbiAgICB2b2lkIG5hdmlnYXRvci5wZXJtaXNzaW9ucz8ucXVlcnkoeyBuYW1lOiBcIm1pY3JvcGhvbmVcIiBhcyBQZXJtaXNzaW9uTmFtZSB9KVxuICAgICAgLnRoZW4oKHApID0+IHsgaWYgKHAuc3RhdGUgPT09IFwiZ3JhbnRlZFwiKSB2b2lkIGFybVdha2UodHJ1ZSwgZmFsc2UpOyB9KVxuICAgICAgLmNhdGNoKCgpID0+IHt9KTtcbiAgfVxuICBpZiAoc2F2ZWRIaXN0b3J5KCkubGVuZ3RoID4gMCkge1xuICAgIHN5bmNSZXN1bWVCdXR0b25zKHRydWUpO1xuICAgICQoXCJyZXN1bWVcIikudGl0bGUgPSBcIkNhbGwgYWdhaW4sIGNhcnJ5aW5nIG9uIGZyb20gdGhlIGxhc3QgY29udmVyc2F0aW9uXCI7XG4gIH1cbiAgJChcIm1pY1wiKS5vbmNsaWNrID0gKCkgPT4gc2V0TXV0ZWQoIW11dGVkKTtcbiAgJChcImh1c2hcIikub25jbGljayA9ICgpID0+IHsgcHVzaCh7IHR5cGU6IFwiaW50ZXJydXB0XCIgfSk7IGF1ZGlvLmZsdXNoKCk7IH07XG4gICQoXCJjYW5jZWxhbGxcIikub25jbGljayA9ICgpID0+IHB1c2goeyB0eXBlOiBcImNhbmNlbEFsbFwiIH0pO1xuICAkKFwiZG9uZWJveFwiKS5hZGRFdmVudExpc3RlbmVyKFwidG9nZ2xlXCIsICgpID0+IHsgaWYgKCQ8SFRNTERldGFpbHNFbGVtZW50PihcImRvbmVib3hcIikub3BlbikgJChcImRvbmVib3hcIikuc2Nyb2xsSW50b1ZpZXcoeyBibG9jazogXCJuZWFyZXN0XCIgfSk7IH0pO1xuICAkKFwic2F5XCIpLm9uc3VibWl0ID0gKGUpID0+IHZvaWQgc3VibWl0VGV4dChlKTtcbiAgJChcInRleHRcIikuYWRkRXZlbnRMaXN0ZW5lcihcImlucHV0XCIsIHN5bmNDb21wb3Nlcik7XG4gIGNvbnN0IHRyYW5zY3JpcHRQYW5lID0gJChcInRyYW5zY3JpcHRcIik7XG4gIHRyYW5zY3JpcHRQYW5lLmFkZEV2ZW50TGlzdGVuZXIoXCJzY3JvbGxcIiwgKCkgPT4gdHJhbnNjcmlwdFNjcm9sbC5vblNjcm9sbCgpLCB7IHBhc3NpdmU6IHRydWUgfSk7XG4gIHRyYW5zY3JpcHRQYW5lLmFkZEV2ZW50TGlzdGVuZXIoXCJzY3JvbGxlbmRcIiwgKCkgPT4gdHJhbnNjcmlwdFNjcm9sbC5vblNjcm9sbEVuZCgpLCB7IHBhc3NpdmU6IHRydWUgfSk7XG4gIHRyYW5zY3JpcHRQYW5lLmFkZEV2ZW50TGlzdGVuZXIoXCJ3aGVlbFwiLCAoZSkgPT4geyBpZiAoZS5kZWx0YVkgPCAwKSB0cmFuc2NyaXB0U2Nyb2xsLmNhbmNlbEp1bXAoKTsgfSwgeyBwYXNzaXZlOiB0cnVlIH0pO1xuICB0cmFuc2NyaXB0UGFuZS5hZGRFdmVudExpc3RlbmVyKFwidG91Y2hzdGFydFwiLCAoKSA9PiB0cmFuc2NyaXB0U2Nyb2xsLmNhbmNlbEp1bXAoKSwgeyBwYXNzaXZlOiB0cnVlIH0pO1xuICBpZiAodHlwZW9mIFJlc2l6ZU9ic2VydmVyICE9PSBcInVuZGVmaW5lZFwiKSB7XG4gICAgbmV3IFJlc2l6ZU9ic2VydmVyKCgpID0+IHRyYW5zY3JpcHRTY3JvbGwub25SZXNpemUoKSkub2JzZXJ2ZSh0cmFuc2NyaXB0UGFuZSk7XG4gICAgbmV3IFJlc2l6ZU9ic2VydmVyKCgpID0+IHVwZGF0ZUFsbFJlc3VsdENsYW1waW5nKCkpLm9ic2VydmUoJChcInJlc3VsdHNcIikpO1xuICB9XG4gICQoXCJqdW1wYm90dG9tXCIpLm9uY2xpY2sgPSAoKSA9PiB0cmFuc2NyaXB0U2Nyb2xsLmp1bXBUb0JvdHRvbSgpO1xuICBzeW5jQ29tcG9zZXIoKTtcbiAgc3luY1NpZGVMYXlvdXQoKTtcbiAgdGFicygpO1xuICBrZXlzKCk7XG4gIGNvbnN0IGV2ZW50cyA9IG5ldyBFdmVudFNvdXJjZShcIi9ldmVudHNcIik7XG4gIGV2ZW50cy5hZGRFdmVudExpc3RlbmVyKFwiY29yZVwiLCAoZSkgPT4ge1xuICAgIGNvbnN0IHsgdmVyc2lvbiB9ID0gSlNPTi5wYXJzZSgoZSBhcyBNZXNzYWdlRXZlbnQpLmRhdGEpO1xuICAgICQoXCJ2ZXJzaW9uXCIpLnRleHRDb250ZW50ID0gdmVyc2lvbiArIChjYWxsSWQgJiYgY29yZSAmJiBjb3JlLnZlcnNpb24gIT09IHZlcnNpb24gPyBgIChuZXh0IGNhbGw7IHRoaXMgb25lIHJ1bnMgJHtjb3JlLnZlcnNpb259KWAgOiBcIlwiKTtcbiAgICAkKFwiYnVpbGRcIikudGV4dENvbnRlbnQgPSBgY29yZSAke3ZlcnNpb259YDtcbiAgfSk7XG4gIGV2ZW50cy5hZGRFdmVudExpc3RlbmVyKFwiYXBwXCIsICgpID0+IHsgaWYgKCFjYWxsSWQpIGxvY2F0aW9uLnJlbG9hZCgpOyBlbHNlIHRvYXN0KFwiVGhlIHBhZ2UgY2hhbmdlZDogcmVsb2FkIGFmdGVyIHRoaXMgY2FsbFwiKTsgfSk7XG4gIGV2ZW50cy5hZGRFdmVudExpc3RlbmVyKFwiZXJyb3JcIiwgKGUpID0+IHtcbiAgICBjb25zdCBkYXRhID0gKGUgYXMgTWVzc2FnZUV2ZW50KS5kYXRhO1xuICAgIGlmIChkYXRhKSB0b2FzdChgQnVpbGQgZmFpbGVkOiAke0pTT04ucGFyc2UoZGF0YSkubWVzc2FnZX1gKTtcbiAgfSk7XG4gIG5ldyBSZXBsYXkoJChcInJlcGxheVwiKSwgbG9hZENvcmUpO1xuICB2b2lkIHBpbmcoKTtcbiAgdm9pZCBzaG93RWFybGllcigpO1xuICB3aW5kb3cuc2V0SW50ZXJ2YWwoKCkgPT4gdm9pZCBzaG93RWFybGllcigpLCAzMF8wMDApO1xufVxuXG52b2lkIG1haW4oKTtcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFTQSxJQUFNLFNBQVMsb0JBQUksSUFBSTtBQUFBLEVBQ3JCO0FBQUEsRUFBTztBQUFBLEVBQU07QUFB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QUFXLFVBQVUsUUFBUSxLQUFLLFlBQVksVUFBVSw4QkFBOEIsS0FBSyxPQUFPLE1BQU07QUFDbkksTUFBRSxPQUFPLEVBQUUsY0FBYyxRQUFRLE9BQU87QUFBQSxFQUMxQyxDQUFDO0FBQ0QsU0FBTyxpQkFBaUIsT0FBTyxNQUFNO0FBQUUsUUFBSSxDQUFDLE9BQVEsVUFBUyxPQUFPO0FBQUEsUUFBUSxPQUFNLDBDQUEwQztBQUFBLEVBQUcsQ0FBQztBQUNoSSxTQUFPLGlCQUFpQixTQUFTLENBQUMsTUFBTTtBQUN0QyxVQUFNLE9BQVEsRUFBbUI7QUFDakMsUUFBSSxLQUFNLE9BQU0saUJBQWlCLEtBQUssTUFBTSxJQUFJLEVBQUUsT0FBTyxFQUFFO0FBQUEsRUFDN0QsQ0FBQztBQUNELE1BQUksT0FBTyxFQUFFLFFBQVEsR0FBRyxRQUFRO0FBQ2hDLE9BQUssS0FBSztBQUNWLE9BQUssWUFBWTtBQUNqQixTQUFPLFlBQVksTUFBTSxLQUFLLFlBQVksR0FBRyxHQUFNO0FBQ3JEO0FBRUEsS0FBSyxLQUFLOyIsCiAgIm5hbWVzIjogWyJjb3JlIiwgImNvcmUiLCAibm93IiwgImFjdGl2ZVNlc3Npb24iLCAiY291bnRzIiwgImxpdmUiLCAibGluZSIsICJydW4iLCAibW9kZSJdCn0K
