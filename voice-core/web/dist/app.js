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
        const hitSeq = typeof m.seq === "number" ? m.seq : Number.MAX_SAFE_INTEGER;
        const hitItem = this.recent.find((item) => item.seq === hitSeq);
        if (rest.byteLength > 0) {
          trailing.push({ bytes: rest, suppressed: hitItem?.suppressed ?? false });
        }
        for (const item of this.recent) {
          if (item.seq > hitSeq) trailing.push({ bytes: item.bytes, suppressed: item.suppressed });
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
  feed(samples, suppressed = false) {
    if (!this.ready || !this.worker) return;
    const seq = ++this.seq;
    const bytes = new Uint8Array(samples.byteLength);
    bytes.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
    this.recent.push({ seq, bytes, suppressed });
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
var ScreenWakeLock = class {
  constructor(requestLock = () => navigator.wakeLock?.request("screen") ?? Promise.resolve(void 0)) {
    this.sentinel = null;
    this.gen = 0;
    this.requestLock = requestLock;
  }
  get held() {
    return this.sentinel != null && !this.sentinel.released;
  }
  async acquire(stillWanted) {
    if (this.held || !stillWanted()) return;
    const gen = ++this.gen;
    try {
      const lock = await this.requestLock();
      if (!lock) return;
      if (gen !== this.gen || !stillWanted()) {
        void lock.release().catch(() => {
        });
        return;
      }
      this.sentinel = lock;
      lock.addEventListener?.("release", () => {
        if (this.sentinel === lock) this.sentinel = null;
      });
    } catch {
    }
  }
  release() {
    this.gen++;
    const lock = this.sentinel;
    this.sentinel = null;
    void lock?.release().catch(() => {
    });
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
var screenWakeLock = new ScreenWakeLock();
var wakeArmed = false;
var armGen = 0;
var coreWantsWake = false;
var callWhileSpeaking = "send";
var coreSpeechUntil = 0;
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
function push(event, t = now()) {
  if (!core || !callId) return [];
  const e = { ...event, t };
  const quiet = e.type === "mic" || e.type === "tick";
  if (!quiet) log("in", e.type === "ws.message" ? `ws ${e.sid} \u2190 ${brief(String(e.data))}` : JSON.stringify(e).slice(0, 400), "in");
  const commands = JSON.parse(core.push(callId, JSON.stringify(e)));
  run2(commands, t);
  return commands;
}
function run2(commands, eventTime = now()) {
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
        const pad = c.pcm.endsWith("==") ? 2 : c.pcm.endsWith("=") ? 1 : 0;
        const pcmBytes = Math.max(0, Math.floor(c.pcm.length * 3 / 4) - pad);
        coreSpeechUntil = Math.max(coreSpeechUntil, eventTime) + pcmBytes / 48e3;
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
        coreSpeechUntil = Math.min(coreSpeechUntil, eventTime);
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
  const t = now();
  const suppressed = callId !== 0 && medium === "voice" && callWhileSpeaking !== "send" && t < coreSpeechUntil;
  if (shouldFeedWake()) wakeClient.feed(samples, suppressed);
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
    metrics.lastVoice = t;
    if (audio.queued < 0.05) metrics.replied = false;
  }
  push({ type: "mic", pcm: bytesToBase64(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)) }, t);
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
    coreSpeechUntil = 0;
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
  coreSpeechUntil = 0;
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
  await screenWakeLock.acquire(() => !document.hidden && (callId !== 0 || wakeArmed));
}
function releaseWakeLock() {
  screenWakeLock.release();
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
    push({ type: "wake" });
    for (const chunk of hit.trailing) {
      if (!callId) break;
      if (!chunk.suppressed || chunk.bytes.byteLength === 0) continue;
      counts.mic++;
      push({ type: "mic", pcm: bytesToBase64(chunk.bytes) });
    }
    return;
  }
  wakeStarting = true;
  openingChunks = [];
  openingBytes = 0;
  for (const chunk of hit.trailing) {
    if (chunk.bytes.byteLength === 0) continue;
    openingChunks.push(chunk.bytes);
    openingBytes += chunk.bytes.byteLength;
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL2NvbW1hbmRzLnRzIiwgIi4uL2F1ZGlvLnRzIiwgIi4uL3JlcGxheS50cyIsICIuLi9zY3JvbGwudHMiLCAiLi4vdWkudHMiLCAiLi4vd2FrZUNsaWVudC50cyIsICIuLi9hcHAudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFNwb2tlbiBjb21tYW5kcyB0aGUgY29yZSBhY3RzIG9uIHdpdGhvdXQgdGhlIG1vZGVsOiBcInN0b3BcIiBhbmQgXCJoYW5nIHVwXCIuIEFuIHV0dGVyYW5jZSBjb3VudHNcbi8vIG9ubHkgd2hlbiBpdCBpcyBvbmUgb2YgdGhlIHBocmFzZXMgYW5kIG5vdGhpbmcgbW9yZSwgb25jZSBuYW1lcyBhbmQgZmlsbGVycyBhcm91bmQgaXQgYXJlIGdvbmUsXG4vLyBzbyBcIldvb2Rob3VzZSwgc3RvcCBwbGVhc2VcIiBzdG9wcyBhbmQgXCJzdG9wIHRoZSBQZW5ueXdvcnRoIHRhc2tcIiBnb2VzIHRvIHRoZSBtb2RlbCBhcyB1c3VhbC5cblxuaW1wb3J0IHR5cGUgeyBWb2ljZUNvbW1hbmRzIH0gZnJvbSBcIi4vdHlwZXMudHNcIjtcblxuZXhwb3J0IHR5cGUgVm9pY2VDb21tYW5kID0gXCJzdG9wXCIgfCBcImhhbmdVcFwiIHwgXCJjYW5jZWxBbGxcIjtcblxuLyoqIFdvcmRzIHRoYXQgbWF5IGNvbWUgYmVmb3JlIG9yIGFmdGVyIGEgY29tbWFuZCB3aXRob3V0IGNoYW5naW5nIGl0LiAqL1xuY29uc3QgRklMTEVSID0gbmV3IFNldChbXG4gIFwiaGV5XCIsIFwib2tcIiwgXCJva2F5XCIsIFwicGxlYXNlXCIsIFwibm93XCIsIFwianVzdFwiLCBcInNvXCIsIFwidW1cIiwgXCJ1aFwiLCBcIm9oXCIsIFwiYWxyaWdodFwiLCBcInJpZ2h0XCIsIFwieWVhaFwiLCBcInllc1wiLCBcInRoYW5rc1wiLCBcInRoYW5rXCIsIFwieW91XCIsXG4gIFwiZ2VtaW5pXCIsXG5dKTtcblxuLyoqIFt0ZXh0XSBhcyBsb3dlci1jYXNlIHdvcmRzLCBhcG9zdHJvcGhlcyBkcm9wcGVkIChcIlRoYXQnc1wiIGlzIFwidGhhdHNcIikuICovXG5leHBvcnQgZnVuY3Rpb24gd29yZHModGV4dDogc3RyaW5nKTogc3RyaW5nW10ge1xuICByZXR1cm4gdGV4dC50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL1snXHUyMDE5YF0vZywgXCJcIikucmVwbGFjZSgvW15cXHB7TH1cXHB7TmR9XSsvZ3UsIFwiIFwiKS50cmltKCkuc3BsaXQoXCIgXCIpLmZpbHRlcigodykgPT4gdy5sZW5ndGggPiAwKTtcbn1cblxuLyoqIFRoZSBjb21tYW5kIFt1dHRlcmFuY2VdIGlzLCBpZiBpdCdzIG9uZSBhbmQgbm90aGluZyBtb3JlOyBbbmFtZXNdICh0aGUgYXNzaXN0YW50J3MsIFwiV29vZGhvdXNlXCIpIGRvbid0IGNvdW50LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbW1hbmRJbih1dHRlcmFuY2U6IHN0cmluZywgY29tbWFuZHM6IFZvaWNlQ29tbWFuZHMsIG5hbWVzOiBzdHJpbmdbXSA9IFtdKTogVm9pY2VDb21tYW5kIHwgbnVsbCB7XG4gIGNvbnN0IGlnbm9yZWQgPSBuZXcgU2V0KFsuLi5GSUxMRVIsIC4uLm5hbWVzLmZsYXRNYXAod29yZHMpXSk7XG4gIGNvbnN0IHNhaWQgPSB3b3Jkcyh1dHRlcmFuY2UpO1xuICBsZXQgZnJvbSA9IDA7XG4gIGxldCB0byA9IHNhaWQubGVuZ3RoO1xuICB3aGlsZSAoZnJvbSA8IHRvICYmIGlnbm9yZWQuaGFzKHNhaWRbZnJvbV0pKSBmcm9tKys7XG4gIHdoaWxlICh0byA+IGZyb20gJiYgaWdub3JlZC5oYXMoc2FpZFt0byAtIDFdKSkgdG8tLTtcbiAgaWYgKGZyb20gPT09IHRvIHx8IHRvIC0gZnJvbSA+IDUpIHJldHVybiBudWxsO1xuICBjb25zdCBjb3JlID0gc2FpZC5zbGljZShmcm9tLCB0bykuam9pbihcIiBcIik7XG4gIGNvbnN0IGlzID0gKHBocmFzZXM6IHN0cmluZ1tdKSA9PiBwaHJhc2VzLnNvbWUoKHApID0+IHdvcmRzKHApLmpvaW4oXCIgXCIpID09PSBjb3JlKTtcbiAgaWYgKGlzKGNvbW1hbmRzLmhhbmdVcCkpIHJldHVybiBcImhhbmdVcFwiO1xuICBpZiAoaXMoY29tbWFuZHMuY2FuY2VsQWxsID8/IFtdKSkgcmV0dXJuIFwiY2FuY2VsQWxsXCI7XG4gIGlmIChpcyhjb21tYW5kcy5zdG9wKSkgcmV0dXJuIFwic3RvcFwiO1xuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqIFdvcmRzIHRoYXQgdGFrZSBhIHJlcXVlc3QgYmFjay4gKi9cbmNvbnN0IENBTkNFTFMgPSAvXFxiKD86Y2FuY2VsXFx3KnxhYm9ydFxcdyp8a2lsbHxzY3JhcHxzY3JhdGNofGRyb3B8Zm9yZ2V0fHVuZG98dGVybWluYXRlfG5ldmVyID9taW5kfGNhbGwgKD86aXR8dGhhdHx0aGlzKSBvZmZ8KD86ZG9udHxkbyBub3QpICg/OmJvdGhlcnxuZWVkfHdhbnR8ZG8pfG5vIG5lZWR8bm8gbG9uZ2VyfG5vdCBhbnltb3JlfGxlYXZlIGl0fHNraXAgKD86aXR8dGhhdCkpXFxiLztcbmNvbnN0IFNUT1BTID0gL1xcYig/OnN0b3BcXHcqfGhhbHR8cXVpdHxlbmQpXFxiLztcblxuLyoqXG4gKiBXaGV0aGVyIFt1dHRlcmFuY2VdIGFza3MgZm9yIGEgdGFzayB0byBiZSBjYW5jZWxsZWQsIGZvciBhIGNhbmNlbF90YXNrIHRoZSBtb2RlbCBjYWxsZWQgb24gaXQuIFwiU3RvcFwiIGFsb25lIGFuZCB0aGVcbiAqIG90aGVyIHN0b3AgYW5kIGhhbmctdXAgcGhyYXNlcyBkb24ndDogdGhleSBtZWFuIHN0b3AgdGFsa2luZy4gT3RoZXJ3aXNlIGl0IGRvZXMgd2hlbiBpdCBzYXlzIHNvIGluIHdvcmRzLCB3aGVuIGl0XG4gKiBuYW1lcyB0aGUgdGFzayAoW25hbWVkXSksIG9yIHdoZW4gaXQgc2F5cyB0byBzdG9wIHNvbWV0aGluZyBtb3JlIHRoYW4gdGhlIHRhbGtpbmcgKFwic3RvcCB3b3JraW5nIG9uIHRoYXRcIikuXG4gKiBXb3JkcyB0aGF0IHNheSBub25lIG9mIHRoaXMgKGEgbWlzaGVhcmluZyBzdWNoIGFzIFwiU3RhYml0XCIpIGRvbid0LiBXaXRoIG5vdGhpbmcgaGVhcmQgdGhlcmUgaXMgbm90aGluZyB0byBqdWRnZSBieS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFza3NUb0NhbmNlbCh1dHRlcmFuY2U6IHN0cmluZywgY29tbWFuZHM6IFZvaWNlQ29tbWFuZHMsIG5hbWVzOiBzdHJpbmdbXSwgbmFtZWQ6IGJvb2xlYW4pOiBib29sZWFuIHtcbiAgY29uc3Qgc2FpZCA9IHdvcmRzKHV0dGVyYW5jZSkuam9pbihcIiBcIik7XG4gIGlmIChzYWlkLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHRydWU7XG4gIGNvbnN0IGNvbW1hbmQgPSBjb21tYW5kSW4odXR0ZXJhbmNlLCBjb21tYW5kcywgbmFtZXMpO1xuICBpZiAoY29tbWFuZCA9PT0gXCJzdG9wXCIgfHwgY29tbWFuZCA9PT0gXCJoYW5nVXBcIikgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gY29tbWFuZCA9PT0gXCJjYW5jZWxBbGxcIiB8fCBuYW1lZCB8fCBDQU5DRUxTLnRlc3Qoc2FpZCkgfHwgU1RPUFMudGVzdChzYWlkKTtcbn1cbiIsICIvLyBUaGUgYnJvd3NlcidzIG1pY3JvcGhvbmUgYW5kIHNwZWFrZXIgZm9yIGEgY2FsbDogMTYga0h6IFBDTTE2IGZyYW1lcyBvdXQgb2YgdGhlIG1pY3JvcGhvbmUsXG4vLyAyNCBrSHogUENNMTYgaW50byB0aGUgc3BlYWtlciwgYW5kIHRvbmVzIGxhaWQgb3ZlciB3aGF0ZXZlciBwbGF5cy4gQm90aCBydW4gaW4gQXVkaW9Xb3JrbGV0cyBvblxuLy8gb25lIEF1ZGlvQ29udGV4dCBhdCB0aGUgZGV2aWNlJ3MgcmF0ZSwgcmVzYW1wbGluZyB0aGVyZS5cblxuY29uc3QgV09SS0xFVFMgPSBgXG5jbGFzcyBDYXB0dXJlIGV4dGVuZHMgQXVkaW9Xb3JrbGV0UHJvY2Vzc29yIHtcbiAgY29uc3RydWN0b3IoKSB7XG4gICAgc3VwZXIoKTtcbiAgICB0aGlzLnN0ZXAgPSBzYW1wbGVSYXRlIC8gMTYwMDA7XG4gICAgdGhpcy5wb3MgPSAwO1xuICAgIHRoaXMuZnJhbWUgPSBuZXcgSW50MTZBcnJheSgzMjApO1xuICAgIHRoaXMubiA9IDA7XG4gICAgLy8gQSB3aW5kb3dlZC1zaW5jIGxvdy1wYXNzIGF0IDcga0h6LCBzbyBub3RoaW5nIGFib3ZlIDE2IGtIeidzIDgga0h6IGxpbWl0IGZvbGRzIGJhY2sgaW50byBzcGVlY2guXG4gICAgY29uc3QgdGFwcyA9IDQ3LCBjdXQgPSA3MDAwIC8gc2FtcGxlUmF0ZTtcbiAgICB0aGlzLnRhcHMgPSBuZXcgRmxvYXQzMkFycmF5KHRhcHMpO1xuICAgIGxldCBzdW0gPSAwO1xuICAgIGZvciAobGV0IGsgPSAwOyBrIDwgdGFwczsgaysrKSB7XG4gICAgICBjb25zdCBtID0gayAtICh0YXBzIC0gMSkgLyAyO1xuICAgICAgY29uc3Qgc2luYyA9IG0gPT09IDAgPyAyICogY3V0IDogTWF0aC5zaW4oMiAqIE1hdGguUEkgKiBjdXQgKiBtKSAvIChNYXRoLlBJICogbSk7XG4gICAgICBjb25zdCB3ID0gMC40MiAtIDAuNSAqIE1hdGguY29zKCgyICogTWF0aC5QSSAqIGspIC8gKHRhcHMgLSAxKSkgKyAwLjA4ICogTWF0aC5jb3MoKDQgKiBNYXRoLlBJICogaykgLyAodGFwcyAtIDEpKTtcbiAgICAgIHRoaXMudGFwc1trXSA9IHNpbmMgKiB3O1xuICAgICAgc3VtICs9IHRoaXMudGFwc1trXTtcbiAgICB9XG4gICAgZm9yIChsZXQgayA9IDA7IGsgPCB0YXBzOyBrKyspIHRoaXMudGFwc1trXSAvPSBzdW07XG4gICAgdGhpcy5oaXN0b3J5ID0gbmV3IEZsb2F0MzJBcnJheSh0YXBzKTtcbiAgICB0aGlzLmF0ID0gMDtcbiAgfVxuICBwcm9jZXNzKGlucHV0cykge1xuICAgIGNvbnN0IGlucHV0ID0gaW5wdXRzWzBdICYmIGlucHV0c1swXVswXTtcbiAgICBpZiAoIWlucHV0KSByZXR1cm4gdHJ1ZTtcbiAgICBjb25zdCB0YXBzID0gdGhpcy50YXBzLCBoID0gdGhpcy5oaXN0b3J5LCBuID0gdGFwcy5sZW5ndGg7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBpbnB1dC5sZW5ndGg7IGkrKykge1xuICAgICAgaFt0aGlzLmF0XSA9IGlucHV0W2ldO1xuICAgICAgdGhpcy5hdCA9ICh0aGlzLmF0ICsgMSkgJSBuO1xuICAgICAgLy8gT25seSB0aGUgc2FtcGxlcyBrZXB0IG5lZWQgZmlsdGVyaW5nOiBhdCBtb3N0IG9uZSBpbiBldmVyeSBzdGVwLlxuICAgICAgaWYgKHRoaXMucG9zID4gMSkgeyB0aGlzLnBvcyAtPSAxOyBjb250aW51ZTsgfVxuICAgICAgbGV0IHggPSAwO1xuICAgICAgZm9yIChsZXQgayA9IDAsIGogPSB0aGlzLmF0OyBrIDwgbjsgaysrLCBqID0gaiArIDEgPT09IG4gPyAwIDogaiArIDEpIHggKz0gdGFwc1trXSAqIGhbal07XG4gICAgICB3aGlsZSAodGhpcy5wb3MgPD0gMSkge1xuICAgICAgICBjb25zdCBzID0gTWF0aC5tYXgoLTEsIE1hdGgubWluKDEsIHgpKTtcbiAgICAgICAgdGhpcy5mcmFtZVt0aGlzLm4rK10gPSBzIDwgMCA/IHMgKiAzMjc2OCA6IHMgKiAzMjc2NztcbiAgICAgICAgaWYgKHRoaXMubiA9PT0gdGhpcy5mcmFtZS5sZW5ndGgpIHtcbiAgICAgICAgICB0aGlzLnBvcnQucG9zdE1lc3NhZ2UodGhpcy5mcmFtZS5idWZmZXIsIFt0aGlzLmZyYW1lLmJ1ZmZlcl0pO1xuICAgICAgICAgIHRoaXMuZnJhbWUgPSBuZXcgSW50MTZBcnJheSgzMjApO1xuICAgICAgICAgIHRoaXMubiA9IDA7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5wb3MgKz0gdGhpcy5zdGVwO1xuICAgICAgfVxuICAgICAgdGhpcy5wb3MgLT0gMTtcbiAgICB9XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbn1cblxuY2xhc3MgUGxheWJhY2sgZXh0ZW5kcyBBdWRpb1dvcmtsZXRQcm9jZXNzb3Ige1xuICBjb25zdHJ1Y3RvcigpIHtcbiAgICBzdXBlcigpO1xuICAgIHRoaXMucXVldWUgPSBbXTsgICAgICAvLyBGbG9hdDMyQXJyYXlzIGF0IHRoZSBjb250ZXh0J3MgcmF0ZVxuICAgIHRoaXMub2Zmc2V0ID0gMDtcbiAgICB0aGlzLmN1ZXMgPSBbXTtcbiAgICB0aGlzLmN1ZU9mZnNldCA9IDA7XG4gICAgdGhpcy5yZXBvcnRlZCA9IDA7XG4gICAgdGhpcy5wb3J0Lm9ubWVzc2FnZSA9IChlKSA9PiB7XG4gICAgICBjb25zdCBtID0gZS5kYXRhO1xuICAgICAgaWYgKG0udHlwZSA9PT0gXCJwbGF5XCIpIHRoaXMucXVldWUucHVzaChtLnNhbXBsZXMpO1xuICAgICAgZWxzZSBpZiAobS50eXBlID09PSBcImN1ZVwiKSB0aGlzLmN1ZXMucHVzaChtLnNhbXBsZXMpO1xuICAgICAgZWxzZSBpZiAobS50eXBlID09PSBcImZsdXNoXCIpIHsgdGhpcy5xdWV1ZSA9IFtdOyB0aGlzLm9mZnNldCA9IDA7IH1cbiAgICAgIGVsc2UgaWYgKG0udHlwZSA9PT0gXCJzdG9wXCIpIHsgdGhpcy5xdWV1ZSA9IFtdOyB0aGlzLm9mZnNldCA9IDA7IHRoaXMuY3VlcyA9IFtdOyB0aGlzLmN1ZU9mZnNldCA9IDA7IH1cbiAgICB9O1xuICB9XG4gIHByb2Nlc3MoXywgb3V0cHV0cykge1xuICAgIGNvbnN0IG91dCA9IG91dHB1dHNbMF1bMF07XG4gICAgb3V0LmZpbGwoMCk7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoICYmIHRoaXMucXVldWUubGVuZ3RoOyBpKyspIHtcbiAgICAgIG91dFtpXSA9IHRoaXMucXVldWVbMF1bdGhpcy5vZmZzZXQrK107XG4gICAgICBpZiAodGhpcy5vZmZzZXQgPj0gdGhpcy5xdWV1ZVswXS5sZW5ndGgpIHsgdGhpcy5xdWV1ZS5zaGlmdCgpOyB0aGlzLm9mZnNldCA9IDA7IH1cbiAgICB9XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoICYmIHRoaXMuY3Vlcy5sZW5ndGg7IGkrKykge1xuICAgICAgb3V0W2ldID0gTWF0aC5tYXgoLTEsIE1hdGgubWluKDEsIG91dFtpXSArIHRoaXMuY3Vlc1swXVt0aGlzLmN1ZU9mZnNldCsrXSkpO1xuICAgICAgaWYgKHRoaXMuY3VlT2Zmc2V0ID49IHRoaXMuY3Vlc1swXS5sZW5ndGgpIHsgdGhpcy5jdWVzLnNoaWZ0KCk7IHRoaXMuY3VlT2Zmc2V0ID0gMDsgfVxuICAgIH1cbiAgICBmb3IgKGxldCBjID0gMTsgYyA8IG91dHB1dHNbMF0ubGVuZ3RoOyBjKyspIG91dHB1dHNbMF1bY10uc2V0KG91dCk7XG4gICAgaWYgKGN1cnJlbnRUaW1lIC0gdGhpcy5yZXBvcnRlZCA+IDAuMSkge1xuICAgICAgdGhpcy5yZXBvcnRlZCA9IGN1cnJlbnRUaW1lO1xuICAgICAgbGV0IHF1ZXVlZCA9IC10aGlzLm9mZnNldDtcbiAgICAgIGZvciAoY29uc3QgcSBvZiB0aGlzLnF1ZXVlKSBxdWV1ZWQgKz0gcS5sZW5ndGg7XG4gICAgICB0aGlzLnBvcnQucG9zdE1lc3NhZ2UoeyBxdWV1ZWQ6IHF1ZXVlZCAvIHNhbXBsZVJhdGUgfSk7XG4gICAgfVxuICAgIHJldHVybiB0cnVlO1xuICB9XG59XG5yZWdpc3RlclByb2Nlc3NvcihcImNhcHR1cmVcIiwgQ2FwdHVyZSk7XG5yZWdpc3RlclByb2Nlc3NvcihcInBsYXliYWNrXCIsIFBsYXliYWNrKTtcbmA7XG5cbmZ1bmN0aW9uIGJhc2U2NFRvQnl0ZXMoYjY0OiBzdHJpbmcpOiBVaW50OEFycmF5IHtcbiAgY29uc3QgYmluID0gYXRvYihiNjQpO1xuICBjb25zdCBvdXQgPSBuZXcgVWludDhBcnJheShiaW4ubGVuZ3RoKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBiaW4ubGVuZ3RoOyBpKyspIG91dFtpXSA9IGJpbi5jaGFyQ29kZUF0KGkpO1xuICByZXR1cm4gb3V0O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYnl0ZXNUb0Jhc2U2NChieXRlczogVWludDhBcnJheSk6IHN0cmluZyB7XG4gIGxldCBiaW4gPSBcIlwiO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGJ5dGVzLmxlbmd0aDsgaSArPSAweDgwMDApIGJpbiArPSBTdHJpbmcuZnJvbUNoYXJDb2RlKC4uLmJ5dGVzLnN1YmFycmF5KGksIGkgKyAweDgwMDApKTtcbiAgcmV0dXJuIGJ0b2EoYmluKTtcbn1cblxuLyoqIFBDTTE2IGxpdHRsZS1lbmRpYW4gYXQgW3JhdGVdLCBhcyBmbG9hdHMgYXQgdGhlIGNvbnRleHQncyByYXRlLiAqL1xuZnVuY3Rpb24gdG9GbG9hdHMocGNtOiBVaW50OEFycmF5LCByYXRlOiBudW1iZXIsIHRhcmdldDogbnVtYmVyKTogRmxvYXQzMkFycmF5IHtcbiAgY29uc3QgdmlldyA9IG5ldyBEYXRhVmlldyhwY20uYnVmZmVyLCBwY20uYnl0ZU9mZnNldCwgcGNtLmJ5dGVMZW5ndGgpO1xuICBjb25zdCBuID0gTWF0aC5mbG9vcihwY20uYnl0ZUxlbmd0aCAvIDIpO1xuICBjb25zdCBvdXQgPSBuZXcgRmxvYXQzMkFycmF5KE1hdGguZmxvb3IoKG4gKiB0YXJnZXQpIC8gcmF0ZSkpO1xuICBjb25zdCBzdGVwID0gcmF0ZSAvIHRhcmdldDtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCB4ID0gaSAqIHN0ZXA7XG4gICAgY29uc3QgaiA9IE1hdGguZmxvb3IoeCk7XG4gICAgY29uc3QgYSA9IHZpZXcuZ2V0SW50MTYoMiAqIE1hdGgubWluKGosIG4gLSAxKSwgdHJ1ZSk7XG4gICAgY29uc3QgYiA9IHZpZXcuZ2V0SW50MTYoMiAqIE1hdGgubWluKGogKyAxLCBuIC0gMSksIHRydWUpO1xuICAgIG91dFtpXSA9IChhICsgKGIgLSBhKSAqICh4IC0gaikpIC8gMzI3Njg7XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBNaWNPcHRpb25zIHsgZWNob0NhbmNlbGxhdGlvbjogYm9vbGVhbjsgbm9pc2VTdXBwcmVzc2lvbjogYm9vbGVhbjsgYXV0b0dhaW5Db250cm9sOiBib29sZWFuIH1cblxuZXhwb3J0IGNsYXNzIENhbGxBdWRpbyB7XG4gIHByaXZhdGUgY29udGV4dDogQXVkaW9Db250ZXh0IHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgcGxheWJhY2s6IEF1ZGlvV29ya2xldE5vZGUgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBjYXB0dXJlOiBBdWRpb1dvcmtsZXROb2RlIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgc3RyZWFtOiBNZWRpYVN0cmVhbSB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIHNvdXJjZTogTWVkaWFTdHJlYW1BdWRpb1NvdXJjZU5vZGUgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBtaWNPcHRzOiBNaWNPcHRpb25zIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgb25NaWNGcmFtZTogKChzYW1wbGVzOiBJbnQxNkFycmF5LCBsZXZlbDogbnVtYmVyKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuICAvKiogSW5jcmVtZW50ZWQgb24gZXZlcnkgc3RhcnRNaWMvc3RvcE1pYyBzbyBzdXBlcnNlZGVkIG9yIGNhbmNlbGxlZCBnZXRVc2VyTWVkaWEgY2FsbHMgbmV2ZXIgbGVhayB0cmFja3MuICovXG4gIHByaXZhdGUgbWljR2VuID0gMDtcbiAgcHJpdmF0ZSBvcGVuaW5nOiBQcm9taXNlPHZvaWQ+IHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgc3RhdGVMaXN0ZW5lcjogKCgpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XG4gIC8qKiBTZWNvbmRzIG9mIHNwZWVjaCBxdWV1ZWQsIGFzIHRoZSB3b3JrbGV0IGxhc3Qgc2FpZC4gKi9cbiAgcXVldWVkID0gMDtcbiAgLyoqIFRoZSBtaWNyb3Bob25lJ3MgbGV2ZWwsIFJNUyBvZiB0aGUgbGFzdCBmcmFtZSAoMCB0byAxKS4gKi9cbiAgbGV2ZWwgPSAwO1xuXG4gIG9uQXVkaW9TdGF0ZUNoYW5nZShsaXN0ZW5lcjogKCgpID0+IHZvaWQpIHwgbnVsbCk6IHZvaWQge1xuICAgIHRoaXMuc3RhdGVMaXN0ZW5lciA9IGxpc3RlbmVyO1xuICB9XG5cbiAgLyoqIFRydWUgd2hlbiBhbiBBdWRpb0NvbnRleHQgZXhpc3RzIGJ1dCB0aGUgYnJvd3NlciBzdXNwZW5kZWQgaXQgcGVuZGluZyBhIHVzZXIgZ2VzdHVyZS4gKi9cbiAgZ2V0IGF1ZGlvU3VzcGVuZGVkKCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLmNvbnRleHQgIT0gbnVsbCAmJiB0aGlzLmNvbnRleHQuc3RhdGUgIT09IFwicnVubmluZ1wiO1xuICB9XG5cbiAgYXN5bmMgcmVzdW1lQXVkaW8oKTogUHJvbWlzZTxib29sZWFuPiB7XG4gICAgY29uc3QgY3R4ID0gdGhpcy5jb250ZXh0O1xuICAgIGlmICghY3R4KSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKGN0eC5zdGF0ZSA9PT0gXCJydW5uaW5nXCIpIHJldHVybiB0cnVlO1xuICAgIHRyeSB7IGF3YWl0IGN0eC5yZXN1bWUoKTsgfSBjYXRjaCB7fVxuICAgIHJldHVybiAoY3R4LnN0YXRlIGFzIEF1ZGlvQ29udGV4dFN0YXRlKSA9PT0gXCJydW5uaW5nXCI7XG4gIH1cblxuICBhc3luYyBvcGVuKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICh0aGlzLm9wZW5pbmcpIHtcbiAgICAgIGF3YWl0IHRoaXMub3BlbmluZztcbiAgICAgIGlmICh0aGlzLmNvbnRleHQ/LnN0YXRlID09PSBcInN1c3BlbmRlZFwiKSBhd2FpdCB0aGlzLmNvbnRleHQucmVzdW1lKCkuY2F0Y2goKCkgPT4ge30pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAodGhpcy5jb250ZXh0KSB7IGlmICh0aGlzLmNvbnRleHQuc3RhdGUgPT09IFwic3VzcGVuZGVkXCIpIGF3YWl0IHRoaXMuY29udGV4dC5yZXN1bWUoKS5jYXRjaCgoKSA9PiB7fSk7IHJldHVybjsgfVxuICAgIGNvbnN0IGluaXQgPSAoYXN5bmMgKCkgPT4ge1xuICAgICAgbGV0IGN0eDogQXVkaW9Db250ZXh0IHwgbnVsbCA9IG51bGw7XG4gICAgICB0cnkge1xuICAgICAgICBjdHggPSBuZXcgQXVkaW9Db250ZXh0KHsgbGF0ZW5jeUhpbnQ6IFwiaW50ZXJhY3RpdmVcIiB9KTtcbiAgICAgICAgY3R4Lm9uc3RhdGVjaGFuZ2UgPSAoKSA9PiB0aGlzLnN0YXRlTGlzdGVuZXI/LigpO1xuICAgICAgICBjb25zdCB1cmwgPSBVUkwuY3JlYXRlT2JqZWN0VVJMKG5ldyBCbG9iKFtXT1JLTEVUU10sIHsgdHlwZTogXCJ0ZXh0L2phdmFzY3JpcHRcIiB9KSk7XG4gICAgICAgIGF3YWl0IGN0eC5hdWRpb1dvcmtsZXQuYWRkTW9kdWxlKHVybCk7XG4gICAgICAgIGNvbnN0IHBsYXliYWNrID0gbmV3IEF1ZGlvV29ya2xldE5vZGUoY3R4LCBcInBsYXliYWNrXCIsIHsgbnVtYmVyT2ZJbnB1dHM6IDAsIG91dHB1dENoYW5uZWxDb3VudDogWzJdIH0pO1xuICAgICAgICBwbGF5YmFjay5wb3J0Lm9ubWVzc2FnZSA9IChlKSA9PiB7IHRoaXMucXVldWVkID0gZS5kYXRhLnF1ZXVlZDsgfTtcbiAgICAgICAgcGxheWJhY2suY29ubmVjdChjdHguZGVzdGluYXRpb24pO1xuICAgICAgICB0aGlzLmNvbnRleHQgPSBjdHg7XG4gICAgICAgIHRoaXMucGxheWJhY2sgPSBwbGF5YmFjaztcbiAgICAgICAgdGhpcy5zdGF0ZUxpc3RlbmVyPy4oKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICB0cnkgeyBhd2FpdCBjdHg/LmNsb3NlPy4oKTsgfSBjYXRjaCB7fVxuICAgICAgICB0aHJvdyBlcnI7XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICB0aGlzLm9wZW5pbmcgPSBudWxsO1xuICAgICAgfVxuICAgIH0pKCk7XG4gICAgdGhpcy5vcGVuaW5nID0gaW5pdDtcbiAgICBhd2FpdCBpbml0O1xuICB9XG5cbiAgLyoqIFNlY29uZHMgZnJvbSBhIHNhbXBsZSBsZWF2aW5nIHRoZSB3b3JrbGV0IHRvIHRoZSBzcGVha2VyLCBhcyB0aGUgYnJvd3NlciByZWNrb25zIGl0LiAqL1xuICBnZXQgb3V0cHV0TGF0ZW5jeSgpOiBudW1iZXIgfCBudWxsIHtcbiAgICBpZiAoIXRoaXMuY29udGV4dCkgcmV0dXJuIG51bGw7XG4gICAgcmV0dXJuIHRoaXMuY29udGV4dC5iYXNlTGF0ZW5jeSArICgodGhpcy5jb250ZXh0IGFzIEF1ZGlvQ29udGV4dCAmIHsgb3V0cHV0TGF0ZW5jeT86IG51bWJlciB9KS5vdXRwdXRMYXRlbmN5ID8/IDApO1xuICB9XG5cbiAgZ2V0IG1pY0FjdGl2ZSgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5jYXB0dXJlICE9IG51bGwgJiYgdGhpcy5zdHJlYW0gIT0gbnVsbCAmJiB0aGlzLnN0cmVhbS5nZXRUcmFja3MoKS5zb21lKCh0KSA9PiB0LnJlYWR5U3RhdGUgPT09IFwibGl2ZVwiKTtcbiAgfVxuXG4gIC8qKiBTdGFydHMgdGhlIG1pY3JvcGhvbmUgaWYgaXQgaXNuJ3QgYWxyZWFkeSBydW5uaW5nIHdpdGggdGhlIHNhbWUgb3B0aW9uczsgb3RoZXJ3aXNlIHN3YXBzIHRoZSBmcmFtZSBjYWxsYmFjayBjbGVhbmx5LiAqL1xuICBhc3luYyBlbnN1cmVNaWMob25GcmFtZTogKHNhbXBsZXM6IEludDE2QXJyYXksIGxldmVsOiBudW1iZXIpID0+IHZvaWQsIG9wdGlvbnM6IE1pY09wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAoXG4gICAgICB0aGlzLm1pY0FjdGl2ZSAmJlxuICAgICAgdGhpcy5taWNPcHRzICYmXG4gICAgICB0aGlzLm1pY09wdHMuZWNob0NhbmNlbGxhdGlvbiA9PT0gb3B0aW9ucy5lY2hvQ2FuY2VsbGF0aW9uICYmXG4gICAgICB0aGlzLm1pY09wdHMubm9pc2VTdXBwcmVzc2lvbiA9PT0gb3B0aW9ucy5ub2lzZVN1cHByZXNzaW9uICYmXG4gICAgICB0aGlzLm1pY09wdHMuYXV0b0dhaW5Db250cm9sID09PSBvcHRpb25zLmF1dG9HYWluQ29udHJvbFxuICAgICkge1xuICAgICAgYXdhaXQgdGhpcy5vcGVuKCk7XG4gICAgICB0aGlzLm9uTWljRnJhbWUgPSBvbkZyYW1lO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBhd2FpdCB0aGlzLnN0YXJ0TWljKG9uRnJhbWUsIG9wdGlvbnMpO1xuICB9XG5cbiAgYXN5bmMgc3RhcnRNaWMob25GcmFtZTogKHNhbXBsZXM6IEludDE2QXJyYXksIGxldmVsOiBudW1iZXIpID0+IHZvaWQsIG9wdGlvbnM6IE1pY09wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICB0aGlzLnN0b3BNaWMoKTtcbiAgICBjb25zdCBnZW4gPSArK3RoaXMubWljR2VuO1xuICAgIGF3YWl0IHRoaXMub3BlbigpO1xuICAgIGlmIChnZW4gIT09IHRoaXMubWljR2VuKSByZXR1cm47XG4gICAgY29uc3QgY29udGV4dCA9IHRoaXMuY29udGV4dCE7XG4gICAgY29uc3Qgc3RyZWFtID0gYXdhaXQgbmF2aWdhdG9yLm1lZGlhRGV2aWNlcy5nZXRVc2VyTWVkaWEoeyBhdWRpbzogeyBjaGFubmVsQ291bnQ6IDEsIC4uLm9wdGlvbnMgfSB9KTtcbiAgICBpZiAoZ2VuICE9PSB0aGlzLm1pY0dlbikge1xuICAgICAgc3RyZWFtLmdldFRyYWNrcygpLmZvckVhY2goKHQpID0+IHQuc3RvcCgpKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgbGV0IHNvdXJjZTogTWVkaWFTdHJlYW1BdWRpb1NvdXJjZU5vZGUgfCBudWxsID0gbnVsbDtcbiAgICBsZXQgY2FwdHVyZTogQXVkaW9Xb3JrbGV0Tm9kZSB8IG51bGwgPSBudWxsO1xuICAgIHRyeSB7XG4gICAgICBzb3VyY2UgPSBjb250ZXh0LmNyZWF0ZU1lZGlhU3RyZWFtU291cmNlKHN0cmVhbSk7XG4gICAgICBjYXB0dXJlID0gbmV3IEF1ZGlvV29ya2xldE5vZGUoY29udGV4dCwgXCJjYXB0dXJlXCIsIHsgbnVtYmVyT2ZPdXRwdXRzOiAwIH0pO1xuICAgICAgY2FwdHVyZS5wb3J0Lm9ubWVzc2FnZSA9IChlKSA9PiB7XG4gICAgICAgIGNvbnN0IGZyYW1lID0gbmV3IEludDE2QXJyYXkoZS5kYXRhIGFzIEFycmF5QnVmZmVyKTtcbiAgICAgICAgbGV0IHN1bSA9IDA7XG4gICAgICAgIGZvciAoY29uc3QgcyBvZiBmcmFtZSkgc3VtICs9IHMgKiBzO1xuICAgICAgICB0aGlzLmxldmVsID0gTWF0aC5zcXJ0KHN1bSAvIGZyYW1lLmxlbmd0aCkgLyAzMjc2ODtcbiAgICAgICAgdGhpcy5vbk1pY0ZyYW1lPy4oZnJhbWUsIHRoaXMubGV2ZWwpO1xuICAgICAgfTtcbiAgICAgIHNvdXJjZS5jb25uZWN0KGNhcHR1cmUpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgc291cmNlPy5kaXNjb25uZWN0KCk7XG4gICAgICBjYXB0dXJlPy5wb3J0LmNsb3NlKCk7XG4gICAgICBzdHJlYW0uZ2V0VHJhY2tzKCkuZm9yRWFjaCgodCkgPT4gdC5zdG9wKCkpO1xuICAgICAgdGhyb3cgZXJyO1xuICAgIH1cbiAgICB0aGlzLnN0cmVhbSA9IHN0cmVhbTtcbiAgICB0aGlzLm1pY09wdHMgPSB7IC4uLm9wdGlvbnMgfTtcbiAgICB0aGlzLm9uTWljRnJhbWUgPSBvbkZyYW1lO1xuICAgIHRoaXMuc291cmNlID0gc291cmNlO1xuICAgIHRoaXMuY2FwdHVyZSA9IGNhcHR1cmU7XG4gIH1cblxuICBzdG9wTWljKCk6IHZvaWQge1xuICAgIHRoaXMubWljR2VuKys7XG4gICAgdGhpcy5zb3VyY2U/LmRpc2Nvbm5lY3QoKTtcbiAgICB0aGlzLmNhcHR1cmU/LnBvcnQuY2xvc2UoKTtcbiAgICB0aGlzLnN0cmVhbT8uZ2V0VHJhY2tzKCkuZm9yRWFjaCgodCkgPT4gdC5zdG9wKCkpO1xuICAgIHRoaXMuc291cmNlID0gbnVsbDtcbiAgICB0aGlzLmNhcHR1cmUgPSBudWxsO1xuICAgIHRoaXMuc3RyZWFtID0gbnVsbDtcbiAgICB0aGlzLm1pY09wdHMgPSBudWxsO1xuICAgIHRoaXMub25NaWNGcmFtZSA9IG51bGw7XG4gICAgdGhpcy5sZXZlbCA9IDA7XG4gIH1cblxuICBwbGF5KHBjbTY0OiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuY29udGV4dCB8fCAhdGhpcy5wbGF5YmFjaykgcmV0dXJuO1xuICAgIGNvbnN0IHNhbXBsZXMgPSB0b0Zsb2F0cyhiYXNlNjRUb0J5dGVzKHBjbTY0KSwgMjQwMDAsIHRoaXMuY29udGV4dC5zYW1wbGVSYXRlKTtcbiAgICB0aGlzLnBsYXliYWNrLnBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcInBsYXlcIiwgc2FtcGxlcyB9LCBbc2FtcGxlcy5idWZmZXJdKTtcbiAgfVxuXG4gIGN1ZShwY202NDogc3RyaW5nKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLmNvbnRleHQgfHwgIXRoaXMucGxheWJhY2spIHJldHVybjtcbiAgICBjb25zdCBzYW1wbGVzID0gdG9GbG9hdHMoYmFzZTY0VG9CeXRlcyhwY202NCksIDI0MDAwLCB0aGlzLmNvbnRleHQuc2FtcGxlUmF0ZSk7XG4gICAgdGhpcy5wbGF5YmFjay5wb3J0LnBvc3RNZXNzYWdlKHsgdHlwZTogXCJjdWVcIiwgc2FtcGxlcyB9LCBbc2FtcGxlcy5idWZmZXJdKTtcbiAgfVxuXG4gIGZsdXNoKCk6IHZvaWQge1xuICAgIHRoaXMucGxheWJhY2s/LnBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcImZsdXNoXCIgfSk7XG4gIH1cblxuICBzdG9wUGxheWJhY2soKTogdm9pZCB7XG4gICAgdGhpcy5wbGF5YmFjaz8ucG9ydC5wb3N0TWVzc2FnZSh7IHR5cGU6IFwic3RvcFwiIH0pO1xuICAgIHRoaXMucXVldWVkID0gMDtcbiAgfVxuXG4gIHN0b3AoKTogdm9pZCB7XG4gICAgdGhpcy5zdG9wTWljKCk7XG4gICAgdGhpcy5zdG9wUGxheWJhY2soKTtcbiAgfVxufVxuIiwgIi8vIFRoZSByZXBsYXkgdmlldzogYSByZWNvcmRlZCBjYWxsIChhIHRyYWNlIGZyb20gYW55IGhvc3QsIG9yIGEgc2NlbmFyaW8pIHJ1biBhZ2FpbiB0aHJvdWdoIHRoZVxuLy8gY29yZSwgYXMgdGhlIGJ1aWxkIHRoYXQgcmVjb3JkZWQgaXQgZGlkIGFuZCBhcyB0aGUgbGF0ZXN0IGRvZXMsIHNpZGUgYnkgc2lkZS4gV2hlcmUgdGhleSBwYXJ0XG4vLyBpcyB3aGVyZSBhIGNoYW5nZSBpbiBzcmMvIGNoYW5nZWQgd2hhdCB0aGUgY2FsbCBkb2VzIHdpdGggdGhlIHNhbWUgd29yZHMgYW5kIHRoZSBzYW1lIG1vZGVsLlxuXG5pbnRlcmZhY2UgQ29yZSB7XG4gIHZlcnNpb246IHN0cmluZztcbiAgY3JlYXRlKGNvbmZpZzogc3RyaW5nLCB0OiBudW1iZXIpOiBzdHJpbmc7XG4gIHB1c2goaWQ6IG51bWJlciwgZXZlbnQ6IHN0cmluZyk6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFJlY29yZGluZyB7IHZlcnNpb24/OiBzdHJpbmc7IGNvbmZpZzogdW5rbm93bjsgc3RhcnQ6IG51bWJlcjsgZXZlbnRzOiBSZWNvcmQ8c3RyaW5nLCBhbnk+W10gfVxuXG4vKiogV2hhdCBhIGNvbW1hbmQgb3IgZXZlbnQgbG9va3MgbGlrZSBpbiBhIHRpbWVsaW5lOiBhdWRpbyBjdXQgb3V0LCBvbmUgbGluZS4gKi9cbmZ1bmN0aW9uIGxpbmUobzogUmVjb3JkPHN0cmluZywgYW55Pik6IHN0cmluZyB7XG4gIGNvbnN0IHRleHQgPSBKU09OLnN0cmluZ2lmeShvKS5yZXBsYWNlKC9cIihkYXRhfHBjbSlcIjpcIltBLVphLXowLTkrLz1dezQwLH1cIi9nLCAnXCIkMVwiOlwiXHUyMDI2XCInKVxuICAgIC5yZXBsYWNlKC9cXFxcXCJkYXRhXFxcXFwiOlxcXFxcIltBLVphLXowLTkrLz1dezQwLH1cXFxcXCIvZywgJ1xcXFxcImRhdGFcXFxcXCI6XFxcXFwiXHUyMDI2XFxcXFwiJyk7XG4gIHJldHVybiB0ZXh0Lmxlbmd0aCA+IDQwMCA/IHRleHQuc2xpY2UoMCwgNDAwKSArIFwiXHUyMDI2XCIgOiB0ZXh0O1xufVxuXG4vKiogQXVkaW8gYW5kIHRpY2tzIHNheSBub3RoaW5nIGEgcmVhZGVyIG5lZWRzOyB0aGUgcmVzdCBkb2VzLiAqL1xuZnVuY3Rpb24gdGVsbGluZyhvOiBSZWNvcmQ8c3RyaW5nLCBhbnk+KTogYm9vbGVhbiB7XG4gIGlmIChvLnR5cGUgPT09IFwibWljXCIgfHwgby50eXBlID09PSBcInRpY2tcIiB8fCBvLnR5cGUgPT09IFwicGxheVwiKSByZXR1cm4gZmFsc2U7XG4gIGlmIChvLnR5cGUgPT09IFwid3Muc2VuZFwiICYmIFN0cmluZyhvLmRhdGEpLnN0YXJ0c1dpdGgoJ3tcInJlYWx0aW1lSW5wdXRcIjp7XCJhdWRpb1wiJykpIHJldHVybiBmYWxzZTtcbiAgaWYgKG8udHlwZSA9PT0gXCJ3cy5tZXNzYWdlXCIgJiYgU3RyaW5nKG8uZGF0YSkuaW5jbHVkZXMoJ1wiaW5saW5lRGF0YVwiJykgJiYgIVN0cmluZyhvLmRhdGEpLmluY2x1ZGVzKCdcInR1cm5Db21wbGV0ZVwiJykpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmZ1bmN0aW9uIHJ1bihjb3JlOiBDb3JlLCByOiBSZWNvcmRpbmcpOiBzdHJpbmdbXVtdIHtcbiAgY29uc3QgY3JlYXRlZCA9IEpTT04ucGFyc2UoY29yZS5jcmVhdGUoSlNPTi5zdHJpbmdpZnkoci5jb25maWcpLCByLnN0YXJ0KSk7XG4gIGNvbnN0IG91dDogc3RyaW5nW11bXSA9IFtjcmVhdGVkLmNvbW1hbmRzLmZpbHRlcih0ZWxsaW5nKS5tYXAobGluZSldO1xuICBmb3IgKGNvbnN0IGUgb2Ygci5ldmVudHMpIG91dC5wdXNoKChKU09OLnBhcnNlKGNvcmUucHVzaChjcmVhdGVkLmlkLCBKU09OLnN0cmluZ2lmeShlKSkpIGFzIFJlY29yZDxzdHJpbmcsIGFueT5bXSkuZmlsdGVyKHRlbGxpbmcpLm1hcChsaW5lKSk7XG4gIHJldHVybiBvdXQ7XG59XG5cbmV4cG9ydCBjbGFzcyBSZXBsYXkge1xuICBwcml2YXRlIHJlYWRvbmx5IHJvb3Q6IEhUTUxFbGVtZW50O1xuICBwcml2YXRlIHJlYWRvbmx5IGxvYWQ6ICh1cmw/OiBzdHJpbmcpID0+IFByb21pc2U8Q29yZT47XG5cbiAgY29uc3RydWN0b3Iocm9vdDogSFRNTEVsZW1lbnQsIGxvYWQ6ICh1cmw/OiBzdHJpbmcpID0+IFByb21pc2U8Q29yZT4pIHtcbiAgICB0aGlzLnJvb3QgPSByb290O1xuICAgIHRoaXMubG9hZCA9IGxvYWQ7XG4gICAgcm9vdC5pbm5lckhUTUwgPSBgXG4gICAgICA8aDI+VHJhY2UgcmVwbGF5PC9oMj5cbiAgICAgIDxkaXYgY2xhc3M9XCJiYXJcIj48c2VsZWN0IGNsYXNzPVwicGlja1wiIGFyaWEtbGFiZWw9XCJSZWNvcmRpbmdcIj48L3NlbGVjdD48YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cInJlZnJlc2hcIiB0aXRsZT1cIlJlZnJlc2ggbGlzdFwiIGFyaWEtbGFiZWw9XCJSZWZyZXNoIGxpc3RcIj5cdTIxQkI8L2J1dHRvbj48YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cImdvXCI+UmVwbGF5PC9idXR0b24+XG4gICAgICA8bGFiZWwgY2xhc3M9XCJ0b2dnbGUtYWxsXCI+PGlucHV0IHR5cGU9XCJjaGVja2JveFwiIGNsYXNzPVwiYWxsXCI+IFNob3cgYXVkaW8gYW5kIHRpY2tzPC9sYWJlbD48c3BhbiBjbGFzcz1cInN1bW1hcnlcIj48L3NwYW4+PC9kaXY+XG4gICAgICA8ZGl2IGNsYXNzPVwidGltZWxpbmVcIj48L2Rpdj5gO1xuICAgIChyb290LnF1ZXJ5U2VsZWN0b3IoXCIucmVmcmVzaFwiKSBhcyBIVE1MRWxlbWVudCkub25jbGljayA9ICgpID0+IHZvaWQgdGhpcy5saXN0KCk7XG4gICAgKHJvb3QucXVlcnlTZWxlY3RvcihcIi5nb1wiKSBhcyBIVE1MRWxlbWVudCkub25jbGljayA9ICgpID0+IHZvaWQgdGhpcy5yZXBsYXkoKS5jYXRjaCgoZXJyKSA9PiB0aGlzLnNheShgUmVwbGF5IGZhaWxlZDogJHtlcnIubWVzc2FnZX1gKSk7XG4gICAgdm9pZCB0aGlzLmxpc3QoKTtcbiAgfVxuXG4gIHByaXZhdGUgc2F5KHRleHQ6IHN0cmluZykge1xuICAgICh0aGlzLnJvb3QucXVlcnlTZWxlY3RvcihcIi5zdW1tYXJ5XCIpIGFzIEhUTUxFbGVtZW50KS50ZXh0Q29udGVudCA9IHRleHQ7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGxpc3QoKSB7XG4gICAgY29uc3QgcGljayA9IHRoaXMucm9vdC5xdWVyeVNlbGVjdG9yKFwiLnBpY2tcIikgYXMgSFRNTFNlbGVjdEVsZW1lbnQ7XG4gICAgcGljay5pbm5lckhUTUwgPSBcIlwiO1xuICAgIGNvbnN0IHRyYWNlczogeyBuYW1lOiBzdHJpbmc7IGJ5dGVzOiBudW1iZXIgfVtdID0gYXdhaXQgKGF3YWl0IGZldGNoKFwiL3RyYWNlc1wiKSkuanNvbigpO1xuICAgIGNvbnN0IHNjZW5hcmlvczogc3RyaW5nW10gPSBhd2FpdCAoYXdhaXQgZmV0Y2goXCIvc2NlbmFyaW9zXCIpKS5qc29uKCk7XG4gICAgY29uc3QgdHJhY2VHcm91cCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJvcHRncm91cFwiKTtcbiAgICB0cmFjZUdyb3VwLmxhYmVsID0gXCJSZWNvcmRlZCBjYWxsc1wiO1xuICAgIGZvciAoY29uc3QgdCBvZiB0cmFjZXMpIHRyYWNlR3JvdXAuYXBwZW5kKG5ldyBPcHRpb24oYCR7dC5uYW1lfSAoJHtNYXRoLnJvdW5kKHQuYnl0ZXMgLyAxMDI0KX0gS0IpYCwgYC90cmFjZXMvJHt0Lm5hbWV9YCkpO1xuICAgIGNvbnN0IHNjZW5hcmlvR3JvdXAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwib3B0Z3JvdXBcIik7XG4gICAgc2NlbmFyaW9Hcm91cC5sYWJlbCA9IFwiU2NlbmFyaW9zXCI7XG4gICAgZm9yIChjb25zdCBzIG9mIHNjZW5hcmlvcykgc2NlbmFyaW9Hcm91cC5hcHBlbmQobmV3IE9wdGlvbihzLCBgL3NjZW5hcmlvcy8ke3N9Lmpzb25gKSk7XG4gICAgcGljay5hcHBlbmQodHJhY2VHcm91cCwgc2NlbmFyaW9Hcm91cCk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHJlY29yZGluZyh1cmw6IHN0cmluZyk6IFByb21pc2U8UmVjb3JkaW5nPiB7XG4gICAgY29uc3QgdGV4dCA9IGF3YWl0IChhd2FpdCBmZXRjaCh1cmwsIHsgY2FjaGU6IFwibm8tc3RvcmVcIiB9KSkudGV4dCgpO1xuICAgIGlmICh1cmwuZW5kc1dpdGgoXCIuanNvblwiKSkgcmV0dXJuIEpTT04ucGFyc2UodGV4dCk7XG4gICAgY29uc3QgW2hlYWRlciwgLi4uZXZlbnRzXSA9IHRleHQudHJpbSgpLnNwbGl0KFwiXFxuXCIpLm1hcCgobCkgPT4gSlNPTi5wYXJzZShsKSk7XG4gICAgcmV0dXJuIHsgLi4uaGVhZGVyLCBldmVudHMgfTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgcmVwbGF5KCkge1xuICAgIGNvbnN0IHVybCA9ICh0aGlzLnJvb3QucXVlcnlTZWxlY3RvcihcIi5waWNrXCIpIGFzIEhUTUxTZWxlY3RFbGVtZW50KS52YWx1ZTtcbiAgICBpZiAoIXVybCkgcmV0dXJuO1xuICAgIGNvbnN0IHIgPSBhd2FpdCB0aGlzLnJlY29yZGluZyh1cmwpO1xuICAgIGNvbnN0IGxhdGVzdCA9IGF3YWl0IHRoaXMubG9hZCgpO1xuICAgIGxldCByZWNvcmRlZDogQ29yZSB8IG51bGwgPSBudWxsO1xuICAgIGlmIChyLnZlcnNpb24gJiYgci52ZXJzaW9uICE9PSBsYXRlc3QudmVyc2lvbikge1xuICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChgL3ZlcnNpb25zLyR7ci52ZXJzaW9ufS5qc2AsIHsgbWV0aG9kOiBcIkhFQURcIiB9KTtcbiAgICAgIGlmIChyZXNwb25zZS5vaykgcmVjb3JkZWQgPSBhd2FpdCB0aGlzLmxvYWQoYC92ZXJzaW9ucy8ke3IudmVyc2lvbn0uanNgKTtcbiAgICB9XG4gICAgY29uc3Qgbm93ID0gcnVuKGxhdGVzdCwgcik7XG4gICAgY29uc3QgdGhlbiA9IHJlY29yZGVkID8gcnVuKHJlY29yZGVkLCByKSA6IG51bGw7XG4gICAgY29uc3QgYWxsID0gKHRoaXMucm9vdC5xdWVyeVNlbGVjdG9yKFwiLmFsbFwiKSBhcyBIVE1MSW5wdXRFbGVtZW50KS5jaGVja2VkO1xuICAgIGNvbnN0IHRpbWVsaW5lID0gdGhpcy5yb290LnF1ZXJ5U2VsZWN0b3IoXCIudGltZWxpbmVcIikgYXMgSFRNTEVsZW1lbnQ7XG4gICAgdGltZWxpbmUuaW5uZXJIVE1MID0gXCJcIjtcbiAgICBsZXQgZmlyc3QgPSAtMTtcbiAgICBsZXQgZGlmZmVyID0gMDtcbiAgICBjb25zdCByb3dzOiBIVE1MRWxlbWVudFtdID0gW107XG4gICAgY29uc3QgYWRkID0gKGNsczogc3RyaW5nLCB0OiBzdHJpbmcsIHRleHQ6IHN0cmluZykgPT4ge1xuICAgICAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgIHJvdy5jbGFzc05hbWUgPSBgcm93ICR7Y2xzfWA7XG4gICAgICByb3cuaW5uZXJIVE1MID0gYDxzcGFuIGNsYXNzPVwidFwiPiR7dH08L3NwYW4+YDtcbiAgICAgIGNvbnN0IGIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgICAgIGIuY2xhc3NOYW1lID0gXCJiXCI7XG4gICAgICBiLnRleHRDb250ZW50ID0gdGV4dDtcbiAgICAgIHJvdy5hcHBlbmQoYik7XG4gICAgICB0aW1lbGluZS5hcHBlbmQocm93KTtcbiAgICAgIHJvd3MucHVzaChyb3cpO1xuICAgICAgcmV0dXJuIHJvdztcbiAgICB9O1xuICAgIGNvbnN0IHQwID0gci5zdGFydDtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8PSByLmV2ZW50cy5sZW5ndGg7IGkrKykge1xuICAgICAgY29uc3QgZSA9IGkgPT09IDAgPyBudWxsIDogci5ldmVudHNbaSAtIDFdO1xuICAgICAgY29uc3Qgbm93T3V0ID0gbm93W2ldO1xuICAgICAgY29uc3QgdGhlbk91dCA9IHRoZW4gPyB0aGVuW2ldIDogbm93T3V0O1xuICAgICAgY29uc3Qgc2FtZSA9IG5vd091dC5sZW5ndGggPT09IHRoZW5PdXQubGVuZ3RoICYmIG5vd091dC5ldmVyeSgoYywgaikgPT4gYyA9PT0gdGhlbk91dFtqXSk7XG4gICAgICBpZiAoIXNhbWUpIHsgZGlmZmVyKys7IGlmIChmaXJzdCA8IDApIGZpcnN0ID0gaTsgfVxuICAgICAgaWYgKCFzYW1lIHx8IGFsbCB8fCAoZSAmJiB0ZWxsaW5nKGUpKSB8fCBub3dPdXQubGVuZ3RoID4gMCkge1xuICAgICAgICBpZiAoZSAmJiAoYWxsIHx8IHRlbGxpbmcoZSkgfHwgIXNhbWUpKSBhZGQoXCJpblwiLCAoZS50IC0gdDApLnRvRml4ZWQoMiksIGxpbmUoZSkpO1xuICAgICAgICBjb25zdCB0ID0gZSA/IChlLnQgLSB0MCkudG9GaXhlZCgyKSA6IFwiMC4wMFwiO1xuICAgICAgICBpZiAoc2FtZSkgZm9yIChjb25zdCBjIG9mIG5vd091dCkgYWRkKFwib3V0XCIsIHQsIGMpO1xuICAgICAgICBlbHNlIHtcbiAgICAgICAgICBmb3IgKGNvbnN0IGMgb2YgdGhlbk91dCkgYWRkKFwib3V0IGdvbmVcIiwgdCwgYFx1MjIxMiAke2N9YCk7XG4gICAgICAgICAgZm9yIChjb25zdCBjIG9mIG5vd091dCkgYWRkKFwib3V0IG5ld1wiLCB0LCBgKyAke2N9YCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgY29uc3QgdmVyc2lvbnMgPSB0aGVuID8gYHJlY29yZGVkIGJ5ICR7ci52ZXJzaW9ufSwgcmVwbGF5ZWQgYnkgaXQgYW5kIGJ5ICR7bGF0ZXN0LnZlcnNpb259YCA6IGByZXBsYXllZCBieSAke2xhdGVzdC52ZXJzaW9ufWAgK1xuICAgICAgKHIudmVyc2lvbiAmJiByLnZlcnNpb24gIT09IGxhdGVzdC52ZXJzaW9uID8gYCAodGhlIHJlY29yZGluZydzIGJ1aWxkICR7ci52ZXJzaW9ufSBpc24ndCBrZXB0IGhlcmUpYCA6IFwiXCIpO1xuICAgIHRoaXMuc2F5KGAke3IuZXZlbnRzLmxlbmd0aH0gZXZlbnRzLCAke3ZlcnNpb25zfS4gYCArICh0aGVuID8gKGRpZmZlciA/IGAke2RpZmZlcn0gZXZlbnRzIGFuc3dlcmVkIGRpZmZlcmVudGx5LCB0aGUgZmlyc3QgYXQgZXZlbnQgJHtmaXJzdH0uYCA6IFwiQm90aCBhbnN3ZXJlZCBldmVyeSBldmVudCB0aGUgc2FtZS5cIikgOiBcIlwiKSk7XG4gICAgaWYgKGZpcnN0ID49IDApIHRpbWVsaW5lLnF1ZXJ5U2VsZWN0b3IoXCIuZ29uZSwgLm5ld1wiKT8uc2Nyb2xsSW50b1ZpZXcoeyBibG9jazogXCJjZW50ZXJcIiB9KTtcbiAgfVxufVxuIiwgIi8qKiBNaW5pbWFsIHNjcm9sbGluZyBwYW5lIHN1cmZhY2Ugc28gYXV0by1zY3JvbGwgbG9naWMgc3RheXMgdGVzdGFibGUgd2l0aG91dCBhIGJyb3dzZXIgRE9NLiAqL1xuZXhwb3J0IGludGVyZmFjZSBTY3JvbGxQYW5lIHtcbiAgc2Nyb2xsVG9wOiBudW1iZXI7XG4gIHJlYWRvbmx5IHNjcm9sbEhlaWdodDogbnVtYmVyO1xuICByZWFkb25seSBjbGllbnRIZWlnaHQ6IG51bWJlcjtcbiAgc2Nyb2xsVG8/KG9wdGlvbnM6IHsgdG9wOiBudW1iZXI7IGJlaGF2aW9yPzogU2Nyb2xsQmVoYXZpb3IgfSk6IHZvaWQ7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXV0b1Njcm9sbGVyT3B0aW9ucyB7XG4gIC8qKiBEaXN0YW5jZSBmcm9tIHRoZSBib3R0b20gKHB4KSB0aGF0IHN0aWxsIGNvdW50cyBhcyBwaW5uZWQuICovXG4gIHBpblRocmVzaG9sZD86IG51bWJlcjtcbiAgLyoqIERpc3RhbmNlIGZyb20gdGhlIGJvdHRvbSAocHgpIHBhc3Qgd2hpY2ggdGhlIGp1bXAtdG8tbGF0ZXN0IGNvbnRyb2wgaXMgc2hvd24uICovXG4gIGp1bXBUaHJlc2hvbGQ/OiBudW1iZXI7XG4gIC8qKiBDYWxsZWQgd2hlbmV2ZXIgdGhlIGp1bXAtdG8tbGF0ZXN0IGNvbnRyb2wncyB2aXNpYmlsaXR5IG1heSBoYXZlIGNoYW5nZWQuICovXG4gIG9uSnVtcENoYW5nZT86IChzaG93OiBib29sZWFuKSA9PiB2b2lkO1xuICAvKiogV2hlbiB0cnVlIChmb3IgZXhhbXBsZSB3aGlsZSB0aGUgZW1wdHkgc3RhdGUgaXMgc2hvd24pLCBrZWVwIHRoZSBqdW1wIGNvbnRyb2wgaGlkZGVuLiAqL1xuICBpc0VtcHR5PzogKCkgPT4gYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBLZWVwcyBhIHRyYW5zY3JpcHQgcGFuZSBwaW5uZWQgdG8gdGhlIGJvdHRvbSBhcyBtZXNzYWdlcyBzdHJlYW0gaW4sIHdpdGhvdXQgbWVhc3VyaW5nXG4gKiBuZWFyLWJvdHRvbSBhZnRlciBhbiBhcHBlbmQgaGFzIGFscmVhZHkgZ3Jvd24gc2Nyb2xsSGVpZ2h0LCBhbmQgeWllbGRzIGltbWVkaWF0ZWx5IHdoZW5cbiAqIHRoZSB1c2VyIHNjcm9sbHMgdXAgdG8gcmVhZCBlYXJsaWVyIG1lc3NhZ2VzLlxuICovXG5leHBvcnQgY2xhc3MgQXV0b1Njcm9sbGVyIHtcbiAgcHJpdmF0ZSByZWFkb25seSBwYW5lOiBTY3JvbGxQYW5lO1xuICBwcml2YXRlIHJlYWRvbmx5IHBpblRocmVzaG9sZDogbnVtYmVyO1xuICBwcml2YXRlIHJlYWRvbmx5IGp1bXBUaHJlc2hvbGQ6IG51bWJlcjtcbiAgcHJpdmF0ZSByZWFkb25seSBvbkp1bXBDaGFuZ2U/OiAoc2hvdzogYm9vbGVhbikgPT4gdm9pZDtcbiAgcHJpdmF0ZSByZWFkb25seSBpc0VtcHR5PzogKCkgPT4gYm9vbGVhbjtcbiAgcHJpdmF0ZSBwaW5uZWQgPSB0cnVlO1xuICBwcml2YXRlIGp1bXBpbmcgPSBmYWxzZTtcbiAgcHJpdmF0ZSBsYXN0U2Nyb2xsVG9wID0gMDtcblxuICBjb25zdHJ1Y3RvcihwYW5lOiBTY3JvbGxQYW5lLCBvcHRpb25zOiBBdXRvU2Nyb2xsZXJPcHRpb25zID0ge30pIHtcbiAgICB0aGlzLnBhbmUgPSBwYW5lO1xuICAgIHRoaXMucGluVGhyZXNob2xkID0gb3B0aW9ucy5waW5UaHJlc2hvbGQgPz8gMzI7XG4gICAgdGhpcy5qdW1wVGhyZXNob2xkID0gb3B0aW9ucy5qdW1wVGhyZXNob2xkID8/IDEyMDtcbiAgICB0aGlzLm9uSnVtcENoYW5nZSA9IG9wdGlvbnMub25KdW1wQ2hhbmdlO1xuICAgIHRoaXMuaXNFbXB0eSA9IG9wdGlvbnMuaXNFbXB0eTtcbiAgICB0aGlzLmxhc3RTY3JvbGxUb3AgPSBwYW5lLnNjcm9sbFRvcDtcbiAgfVxuXG4gIGdldCBpc1Bpbm5lZCgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5waW5uZWQ7XG4gIH1cblxuICBwcml2YXRlIGRpc3RhbmNlKCk6IG51bWJlciB7XG4gICAgcmV0dXJuIE1hdGgubWF4KDAsIHRoaXMucGFuZS5zY3JvbGxIZWlnaHQgLSB0aGlzLnBhbmUuc2Nyb2xsVG9wIC0gdGhpcy5wYW5lLmNsaWVudEhlaWdodCk7XG4gIH1cblxuICBwcml2YXRlIGlzVmlzaWJsZSgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5wYW5lLmNsaWVudEhlaWdodCA+IDA7XG4gIH1cblxuICBwcml2YXRlIHNuYXBUb0JvdHRvbSgpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuaXNWaXNpYmxlKCkpIHJldHVybjtcbiAgICB0aGlzLnBhbmUuc2Nyb2xsVG9wID0gdGhpcy5wYW5lLnNjcm9sbEhlaWdodDtcbiAgICB0aGlzLmxhc3RTY3JvbGxUb3AgPSB0aGlzLnBhbmUuc2Nyb2xsVG9wO1xuICB9XG5cbiAgcHJpdmF0ZSB1cGRhdGVKdW1wKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5vbkp1bXBDaGFuZ2UpIHJldHVybjtcbiAgICBjb25zdCBlbXB0eSA9IHRoaXMuaXNFbXB0eT8uKCkgPz8gZmFsc2U7XG4gICAgY29uc3Qgc2hvdyA9ICFlbXB0eSAmJiB0aGlzLmlzVmlzaWJsZSgpICYmICF0aGlzLmp1bXBpbmcgJiYgdGhpcy5kaXN0YW5jZSgpID4gdGhpcy5qdW1wVGhyZXNob2xkO1xuICAgIHRoaXMub25KdW1wQ2hhbmdlKHNob3cpO1xuICB9XG5cbiAgLyoqIENhbGwgYWZ0ZXIgY29udGVudCBpcyBhZGRlZCwgdXBkYXRlZCwgb3IgcmVtb3ZlZCBpbiB0aGUgcGFuZS4gKi9cbiAgb25Db250ZW50KGZvcmNlID0gZmFsc2UpOiB2b2lkIHtcbiAgICBpZiAoZm9yY2UpIHtcbiAgICAgIHRoaXMucGlubmVkID0gdHJ1ZTtcbiAgICAgIHRoaXMuanVtcGluZyA9IGZhbHNlO1xuICAgIH1cbiAgICBpZiAodGhpcy5waW5uZWQpIHtcbiAgICAgIGlmICh0aGlzLmp1bXBpbmcgJiYgdGhpcy5wYW5lLnNjcm9sbFRvICYmIHRoaXMuaXNWaXNpYmxlKCkpIHtcbiAgICAgICAgdGhpcy5wYW5lLnNjcm9sbFRvKHsgdG9wOiB0aGlzLnBhbmUuc2Nyb2xsSGVpZ2h0LCBiZWhhdmlvcjogXCJzbW9vdGhcIiB9KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMuc25hcFRvQm90dG9tKCk7XG4gICAgICB9XG4gICAgfVxuICAgIHRoaXMudXBkYXRlSnVtcCgpO1xuICB9XG5cbiAgLyoqIENhbGwgd2hlbiB0aGUgcGFuZSdzIHZpZXdwb3J0IHJlc2l6ZXMgKGJhcnMgYXBwZWFyaW5nLCBrZXlib2FyZCwgdGFiIHN3aXRjaCkuICovXG4gIG9uUmVzaXplKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5pc1Zpc2libGUoKSkgcmV0dXJuO1xuICAgIGlmICh0aGlzLnBpbm5lZCkge1xuICAgICAgdGhpcy5qdW1waW5nID0gZmFsc2U7XG4gICAgICB0aGlzLnNuYXBUb0JvdHRvbSgpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLmxhc3RTY3JvbGxUb3AgPSB0aGlzLnBhbmUuc2Nyb2xsVG9wO1xuICAgIH1cbiAgICB0aGlzLnVwZGF0ZUp1bXAoKTtcbiAgfVxuXG4gIC8qKiBDYWxsIGZyb20gdGhlIHBhbmUncyBzY3JvbGwgZXZlbnQgbGlzdGVuZXIuICovXG4gIG9uU2Nyb2xsKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5pc1Zpc2libGUoKSkgcmV0dXJuO1xuICAgIGNvbnN0IHRvcCA9IHRoaXMucGFuZS5zY3JvbGxUb3A7XG4gICAgY29uc3QgZGlzdCA9IHRoaXMuZGlzdGFuY2UoKTtcbiAgICBjb25zdCBtb3ZlZFVwID0gdG9wIDwgdGhpcy5sYXN0U2Nyb2xsVG9wO1xuICAgIHRoaXMubGFzdFNjcm9sbFRvcCA9IHRvcDtcblxuICAgIGlmIChkaXN0IDw9IHRoaXMucGluVGhyZXNob2xkKSB7XG4gICAgICB0aGlzLnBpbm5lZCA9IHRydWU7XG4gICAgICB0aGlzLmp1bXBpbmcgPSBmYWxzZTtcbiAgICB9IGVsc2UgaWYgKG1vdmVkVXApIHtcbiAgICAgIHRoaXMucGlubmVkID0gZmFsc2U7XG4gICAgICB0aGlzLmp1bXBpbmcgPSBmYWxzZTtcbiAgICB9XG4gICAgdGhpcy51cGRhdGVKdW1wKCk7XG4gIH1cblxuICAvKiogQ2FsbCBmcm9tIHRoZSBwYW5lJ3Mgc2Nyb2xsZW5kIGV2ZW50IGxpc3RlbmVyLiAqL1xuICBvblNjcm9sbEVuZCgpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuaXNWaXNpYmxlKCkgfHwgIXRoaXMuanVtcGluZykgcmV0dXJuO1xuICAgIHRoaXMuanVtcGluZyA9IGZhbHNlO1xuICAgIGlmICh0aGlzLmRpc3RhbmNlKCkgPiB0aGlzLnBpblRocmVzaG9sZCkgdGhpcy5waW5uZWQgPSBmYWxzZTtcbiAgICB0aGlzLnVwZGF0ZUp1bXAoKTtcbiAgfVxuXG4gIC8qKiBDYWxsIG9uIHVzZXIgd2hlZWwtdXAgb3IgdG91Y2hzdGFydCBzbyBhbiBhY3RpdmUgc21vb3RoIGp1bXAgeWllbGRzIHRvIHRoZSB1c2VyLiAqL1xuICBjYW5jZWxKdW1wKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5qdW1waW5nKSByZXR1cm47XG4gICAgdGhpcy5qdW1waW5nID0gZmFsc2U7XG4gICAgaWYgKHRoaXMuaXNWaXNpYmxlKCkpIHtcbiAgICAgIGNvbnN0IHRvcCA9IHRoaXMucGFuZS5zY3JvbGxUb3A7XG4gICAgICBpZiAodGhpcy5wYW5lLnNjcm9sbFRvKSB0aGlzLnBhbmUuc2Nyb2xsVG8oeyB0b3AsIGJlaGF2aW9yOiBcImluc3RhbnRcIiB9KTtcbiAgICAgIGVsc2UgdGhpcy5wYW5lLnNjcm9sbFRvcCA9IHRvcDtcbiAgICAgIHRoaXMubGFzdFNjcm9sbFRvcCA9IHRoaXMucGFuZS5zY3JvbGxUb3A7XG4gICAgICBpZiAodGhpcy5kaXN0YW5jZSgpID4gdGhpcy5waW5UaHJlc2hvbGQpIHRoaXMucGlubmVkID0gZmFsc2U7XG4gICAgfVxuICAgIHRoaXMudXBkYXRlSnVtcCgpO1xuICB9XG5cbiAgLyoqIFJlLXBpbiBhbmQgc2Nyb2xsIHNtb290aGx5IHRvIHRoZSBib3R0b20gKHVzZWQgYnkgdGhlIGp1bXAtdG8tbGF0ZXN0IGJ1dHRvbikuICovXG4gIGp1bXBUb0JvdHRvbSgpOiB2b2lkIHtcbiAgICB0aGlzLnBpbm5lZCA9IHRydWU7XG4gICAgaWYgKCF0aGlzLmlzVmlzaWJsZSgpKSB7XG4gICAgICB0aGlzLnVwZGF0ZUp1bXAoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHRoaXMuZGlzdGFuY2UoKSA8PSB0aGlzLnBpblRocmVzaG9sZCB8fCAhdGhpcy5wYW5lLnNjcm9sbFRvKSB7XG4gICAgICB0aGlzLmp1bXBpbmcgPSBmYWxzZTtcbiAgICAgIHRoaXMuc25hcFRvQm90dG9tKCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuanVtcGluZyA9IHRydWU7XG4gICAgICB0aGlzLmxhc3RTY3JvbGxUb3AgPSB0aGlzLnBhbmUuc2Nyb2xsVG9wO1xuICAgICAgdGhpcy5wYW5lLnNjcm9sbFRvKHsgdG9wOiB0aGlzLnBhbmUuc2Nyb2xsSGVpZ2h0LCBiZWhhdmlvcjogXCJzbW9vdGhcIiB9KTtcbiAgICB9XG4gICAgdGhpcy51cGRhdGVKdW1wKCk7XG4gIH1cblxuICAvKiogUmVjb21wdXRlIHBpbm5lZCBzdGF0ZSBmcm9tIHRoZSBjdXJyZW50IHBvc2l0aW9uIGFmdGVyIGEgdXNlci1kcml2ZW4gbGF5b3V0IGNoYW5nZSAoZS5nLiBleHBhbmRpbmcgYSByZXN1bHQpLiAqL1xuICBzeW5jRnJvbVBvc2l0aW9uKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5pc1Zpc2libGUoKSkgcmV0dXJuO1xuICAgIHRoaXMuanVtcGluZyA9IGZhbHNlO1xuICAgIHRoaXMubGFzdFNjcm9sbFRvcCA9IHRoaXMucGFuZS5zY3JvbGxUb3A7XG4gICAgdGhpcy5waW5uZWQgPSB0aGlzLmRpc3RhbmNlKCkgPD0gdGhpcy5waW5UaHJlc2hvbGQ7XG4gICAgdGhpcy51cGRhdGVKdW1wKCk7XG4gIH1cblxuICAvKiogUGF1c2UgYXV0by1zY3JvbGwgZXhwbGljaXRseSAoZS5nLiB3aGVuIHJldmVhbGluZyBhbiBvbGRlciByZXN1bHQgY2FyZCkuICovXG4gIHVucGluKCk6IHZvaWQge1xuICAgIHRoaXMucGlubmVkID0gZmFsc2U7XG4gICAgdGhpcy5qdW1waW5nID0gZmFsc2U7XG4gICAgdGhpcy51cGRhdGVKdW1wKCk7XG4gIH1cbn1cbiIsICIvLyBQdXJlIFVJIGhlbHBlcnMgZm9yIHRoZSBWb2ljZSB3ZWIgc3VyZmFjZSAoZGVuc2l0eSwgYWdlbnQtcGFuZSBmaWx0ZXJpbmcsIGNvbXBhY3QgcHJldmlld3MpLlxuXG5leHBvcnQgdHlwZSBTaWRlRmlsdGVyID0gXCJhbGxcIiB8IFwiYWN0aXZlXCIgfCBcInJlc3VsdHNcIjtcbmV4cG9ydCB0eXBlIERlbnNpdHkgPSBcImNvbXBhY3RcIiB8IFwiY29tZm9ydGFibGVcIjtcblxuZXhwb3J0IGludGVyZmFjZSBTaWRlQ291bnRzIHtcbiAgYWN0aXZlOiBudW1iZXI7XG4gIHJlc3VsdHM6IG51bWJlcjtcbiAgZWFybGllcjogbnVtYmVyO1xuICBkb25lOiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2lkZVZpc2liaWxpdHkge1xuICBzaG93VGFza3NTZWN0aW9uOiBib29sZWFuO1xuICBzaG93RW1wdHlUYXNrczogYm9vbGVhbjtcbiAgc2hvd1Jlc3VsdHNTZWN0aW9uOiBib29sZWFuO1xuICBzaG93RW1wdHlSZXN1bHRzOiBib29sZWFuO1xuICBzaG93RWFybGllclNlY3Rpb246IGJvb2xlYW47XG4gIHNob3dEb25lU2VjdGlvbjogYm9vbGVhbjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZURlbnNpdHkodmFsdWU6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQpOiBEZW5zaXR5IHtcbiAgcmV0dXJuIHZhbHVlID09PSBcImNvbWZvcnRhYmxlXCIgPyBcImNvbWZvcnRhYmxlXCIgOiBcImNvbXBhY3RcIjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZVNpZGVGaWx0ZXIodmFsdWU6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQpOiBTaWRlRmlsdGVyIHtcbiAgaWYgKHZhbHVlID09PSBcImFjdGl2ZVwiIHx8IHZhbHVlID09PSBcInJlc3VsdHNcIikgcmV0dXJuIHZhbHVlO1xuICByZXR1cm4gXCJhbGxcIjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlUHJlZml4KHRleHQ6IHN0cmluZyk6IHsgbW9kZTogXCJoZXJtZXNcIiB8IFwidDNcIiB8IG51bGw7IHJlc3Q6IHN0cmluZyB9IHtcbiAgY29uc3QgbSA9IHRleHQubWF0Y2goL15cXC8odDN8Y29kZXxofGhlcm1lcylcXHMrKC4qKSQvaXMpO1xuICBpZiAoIW0pIHJldHVybiB7IG1vZGU6IG51bGwsIHJlc3Q6IHRleHQgfTtcbiAgcmV0dXJuIHsgbW9kZTogL14odDN8Y29kZSkkL2kudGVzdChtWzFdKSA/IFwidDNcIiA6IFwiaGVybWVzXCIsIHJlc3Q6IG1bMl0udHJpbSgpIH07XG59XG5cbi8qKiBBIHJlc3VsdCBjYXJkIG1heSBvbmx5IHN0ZWVyIGEgdGFzayB0aGF0IGJlbG9uZ3MgdG8gdGhlIHNhbWUgYWN0aXZlIHNlc3Npb24gKHRhc2sgSURzIHJlc3RhcnQgcGVyIGNhbGwpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNhbkZvbGxvd1VwUmVzdWx0KHJlc3VsdFNlc3Npb246IG51bWJlciwgYWN0aXZlU2Vzc2lvbjogbnVtYmVyLCBoYXNUYXNrOiBib29sZWFuKTogYm9vbGVhbiB7XG4gIHJldHVybiBhY3RpdmVTZXNzaW9uID4gMCAmJiByZXN1bHRTZXNzaW9uID09PSBhY3RpdmVTZXNzaW9uICYmIGhhc1Rhc2s7XG59XG5cbi8qKiBVbnJlYWQgbW9iaWxlIHJlc3VsdCBhbGVydHMgb25seSBjbGVhciBvbmNlIHRoZSBSZXN1bHRzIHNlY3Rpb24gaXMgYWN0dWFsbHkgdmlzaWJsZSB0byB0aGUgdXNlci4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzaG91bGRDbGVhclVucmVhZFJlc3VsdHMoaXNNb2JpbGU6IGJvb2xlYW4sIGRyYXdlck9wZW46IGJvb2xlYW4sIGZpbHRlcjogU2lkZUZpbHRlcik6IGJvb2xlYW4ge1xuICByZXR1cm4gIWlzTW9iaWxlIHx8IChkcmF3ZXJPcGVuICYmIGZpbHRlciAhPT0gXCJhY3RpdmVcIik7XG59XG5cbi8qKiBQaWNrIHRoZSBmaWx0ZXIgdG8gc2hvdyB3aGVuIHRhcHBpbmcgdGhlIG1vYmlsZSBsaXZlLXN0YXR1cyBiYW5uZXIgc28gdGhlIGFkdmVydGlzZWQgaXRlbSBpcyB2aXNpYmxlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVNb2JpbGVCYW5uZXJGaWx0ZXIoY3VycmVudDogU2lkZUZpbHRlciwgYWN0aXZlVG90YWw6IG51bWJlciwgdW5yZWFkUmVzdWx0czogbnVtYmVyKTogU2lkZUZpbHRlciB7XG4gIGlmIChhY3RpdmVUb3RhbCA+IDApIHJldHVybiBjdXJyZW50ID09PSBcInJlc3VsdHNcIiA/IFwiYWxsXCIgOiBjdXJyZW50O1xuICBpZiAodW5yZWFkUmVzdWx0cyA+IDApIHJldHVybiBcInJlc3VsdHNcIjtcbiAgcmV0dXJuIGN1cnJlbnQ7XG59XG5cbi8qKiBGbGF0dGVuIGEgTWFya2Rvd24gYWdlbnQgcmVwbHkgaW50byBhIHNpbmdsZS1saW5lIHBsYWluLXRleHQgcHJldmlldyBmb3IgaW5saW5lIGhhbmRvZmYgY2hpcHMuICovXG5leHBvcnQgZnVuY3Rpb24gcGxhaW5QcmV2aWV3KHRleHQ6IHN0cmluZywgbWF4TGVuID0gMTUwKTogc3RyaW5nIHtcbiAgY29uc3QgY2xlYW5lZCA9IHRleHRcbiAgICAucmVwbGFjZSgvYGBgW15cXG5dKlxcbj8oW1xcc1xcU10qPylgYGAvZywgKF8sIGNvZGU6IHN0cmluZykgPT4gYCAke2NvZGUudHJpbSgpfSBgKVxuICAgIC5yZXBsYWNlKC9cXFsoW15cXF1cXG5dKylcXF1cXCgoaHR0cHM/OlxcL1xcL1teXFxzKV0rKVxcKS9nLCBcIiQxXCIpXG4gICAgLnJlcGxhY2UoL14jezEsNn1cXHMrL2dtLCBcIlwiKVxuICAgIC5yZXBsYWNlKC9eXFxzKig/OlstKlx1MjAyMl18XFxkK1suKV0pXFxzKy9nbSwgXCJcIilcbiAgICAucmVwbGFjZSgvYChbXmBcXG5dKylgL2csIFwiJDFcIilcbiAgICAucmVwbGFjZSgvXFwqXFwqKFteKlxcbl0rKVxcKlxcKi9nLCBcIiQxXCIpXG4gICAgLnJlcGxhY2UoL19fKFteX1xcbl0rKV9fL2csIFwiJDFcIilcbiAgICAucmVwbGFjZSgvXFxzKy9nLCBcIiBcIilcbiAgICAudHJpbSgpO1xuICBpZiAoY2xlYW5lZC5sZW5ndGggPD0gbWF4TGVuKSByZXR1cm4gY2xlYW5lZDtcbiAgY29uc3QgY3V0ID0gY2xlYW5lZC5zbGljZSgwLCBtYXhMZW4pO1xuICBjb25zdCBzcGFjZSA9IGN1dC5sYXN0SW5kZXhPZihcIiBcIik7XG4gIGNvbnN0IGJhc2UgPSBzcGFjZSA+IE1hdGguZmxvb3IobWF4TGVuICogMC42KSA/IGN1dC5zbGljZSgwLCBzcGFjZSkgOiBjdXQ7XG4gIHJldHVybiBgJHtiYXNlLnJlcGxhY2UoL1suLDs6XFxzLV0rJC8sIFwiXCIpfVx1MjAyNmA7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXRTaG9ydFRpbWUoZGF0ZTogRGF0ZSk6IHN0cmluZyB7XG4gIGNvbnN0IHBhZCA9IChuOiBudW1iZXIpID0+IFN0cmluZyhuKS5wYWRTdGFydCgyLCBcIjBcIik7XG4gIHJldHVybiBgJHtwYWQoZGF0ZS5nZXRIb3VycygpKX06JHtwYWQoZGF0ZS5nZXRNaW51dGVzKCkpfWA7XG59XG5cbi8qKiBEZWNpZGUgd2hpY2ggc2VjdGlvbnMgb2YgdGhlIHJpZ2h0LWhhbmQgQWdlbnQgV29ya3NwYWNlIGFyZSB2aXNpYmxlIGZvciBhIGdpdmVuIGZpbHRlciBhbmQgY291bnRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVTaWRlU2VjdGlvbnMoZmlsdGVyOiBTaWRlRmlsdGVyLCBjb3VudHM6IFNpZGVDb3VudHMpOiBTaWRlVmlzaWJpbGl0eSB7XG4gIGlmIChmaWx0ZXIgPT09IFwicmVzdWx0c1wiKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHNob3dUYXNrc1NlY3Rpb246IGZhbHNlLFxuICAgICAgc2hvd0VtcHR5VGFza3M6IGZhbHNlLFxuICAgICAgc2hvd1Jlc3VsdHNTZWN0aW9uOiB0cnVlLFxuICAgICAgc2hvd0VtcHR5UmVzdWx0czogY291bnRzLnJlc3VsdHMgPT09IDAsXG4gICAgICBzaG93RWFybGllclNlY3Rpb246IGZhbHNlLFxuICAgICAgc2hvd0RvbmVTZWN0aW9uOiBmYWxzZSxcbiAgICB9O1xuICB9XG4gIGlmIChmaWx0ZXIgPT09IFwiYWN0aXZlXCIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc2hvd1Rhc2tzU2VjdGlvbjogdHJ1ZSxcbiAgICAgIHNob3dFbXB0eVRhc2tzOiBjb3VudHMuYWN0aXZlID09PSAwICYmIGNvdW50cy5lYXJsaWVyID09PSAwLFxuICAgICAgc2hvd1Jlc3VsdHNTZWN0aW9uOiBmYWxzZSxcbiAgICAgIHNob3dFbXB0eVJlc3VsdHM6IGZhbHNlLFxuICAgICAgc2hvd0VhcmxpZXJTZWN0aW9uOiBjb3VudHMuZWFybGllciA+IDAsXG4gICAgICBzaG93RG9uZVNlY3Rpb246IGNvdW50cy5kb25lID4gMCxcbiAgICB9O1xuICB9XG4gIC8vIFwiYWxsXCI6IGhpZGUgdGhlIGVtcHR5IGFjdGl2ZS10YXNrcyBwbGFjZWhvbGRlciBhcyBzb29uIGFzIHJlc3VsdHMgb3IgZWFybGllciBhZ2VudHMgZXhpc3RcbiAgLy8gc28gZmluaXNoZWQgcmVzcG9uc2VzIHRha2UgdGhlIHRvcCBvZiB0aGUgcGFuZSB3aXRob3V0IHdhc3RlZCBzcGFjZS5cbiAgY29uc3QgaGFzQW55dGhpbmdBYm92ZURvbmUgPSBjb3VudHMuYWN0aXZlID4gMCB8fCBjb3VudHMucmVzdWx0cyA+IDAgfHwgY291bnRzLmVhcmxpZXIgPiAwO1xuICByZXR1cm4ge1xuICAgIHNob3dUYXNrc1NlY3Rpb246IGNvdW50cy5hY3RpdmUgPiAwIHx8ICFoYXNBbnl0aGluZ0Fib3ZlRG9uZSxcbiAgICBzaG93RW1wdHlUYXNrczogIWhhc0FueXRoaW5nQWJvdmVEb25lLFxuICAgIHNob3dSZXN1bHRzU2VjdGlvbjogY291bnRzLnJlc3VsdHMgPiAwLFxuICAgIHNob3dFbXB0eVJlc3VsdHM6IGZhbHNlLFxuICAgIHNob3dFYXJsaWVyU2VjdGlvbjogY291bnRzLmVhcmxpZXIgPiAwLFxuICAgIHNob3dEb25lU2VjdGlvbjogY291bnRzLmRvbmUgPiAwLFxuICB9O1xufVxuIiwgIi8vIE1haW4tdGhyZWFkIGNvbnRyb2xsZXIgZm9yIHRoZSB3YWtlIHdvcmQgV2ViIFdvcmtlciBhbmQgU2NyZWVuIFdha2UgTG9jayBoZWxwZXIuXG4vLyBUYWdzIGV2ZXJ5IGxvYWQgYW5kIHJlc2V0IHdpdGggYSBtb25vdG9uaWMgZ2VuZXJhdGlvbiAoYGdlbmApIHNvIHN0YWxlIGRldGVjdGlvbnMgb3IgcmVhZHkgZXZlbnRzXG4vLyBhZnRlciBhIG1vZGVsIHN3aXRjaCBvciByZXNldCBhcmUgaWdub3JlZCwgYW5kIGtlZXBzIGEgc2hvcnQgcmluZyBidWZmZXIgb2YgcmVjZW50IGZlZCBjaHVua3Ncbi8vIGluZGV4ZWQgYnkgYHNlcWAgKHdpdGggcGVyLWZyYW1lIGBzdXBwcmVzc2VkYCBmbGFncykgc28gYXVkaW8gY2FwdHVyZWQgd2hpbGUgdGhlIHdvcmtlciB3YXNcbi8vIHNjb3JpbmcgaXMgcHJlc2VydmVkIGluIGBoaXQudHJhaWxpbmdgIHdpdGhvdXQgZHVwbGljYXRpbmcgdW5zdXBwcmVzc2VkIGZyYW1lcy5cblxuZXhwb3J0IGludGVyZmFjZSBXYWtlVGVsZW1ldHJ5IHtcbiAgc2NvcmU6IG51bWJlcjtcbiAgcGVhazogbnVtYmVyO1xuICBnYXRlT3BlbjogYm9vbGVhbjtcbiAgZnJhbWVzOiBudW1iZXI7XG4gIHNjb3JlZDogbnVtYmVyO1xuICBpbmZlck1zOiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgV2FrZVRyYWlsaW5nQ2h1bmsge1xuICBieXRlczogVWludDhBcnJheTtcbiAgLyoqIFRydWUgd2hlbiB0aGUgY29yZSBzdXBwcmVzc2VkIChzaWxlbmNlZCkgdGhpcyBmcmFtZSBkdXJpbmcgYXVkaWJsZSBwbGF5YmFjayAoYHdoaWxlU3BlYWtpbmcgIT09IFwic2VuZFwiYCkuICovXG4gIHN1cHByZXNzZWQ6IGJvb2xlYW47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgV2FrZURldGVjdGlvbkV2ZW50IHtcbiAgc2NvcmU6IG51bWJlcjtcbiAgYXRGcmFtZTogbnVtYmVyO1xuICAvKiogQXVkaW8gY2h1bmtzIHNwb2tlbiBhZnRlciB0aGUgd2FrZSB3b3JkOiB0aGUgdHJpZ2dlcmluZyBjaHVuaydzIHRhaWwgcGx1cyBhbnkgY2h1bmtzIGFscmVhZHkgc2VudCBhZnRlciBpdC4gKi9cbiAgdHJhaWxpbmc6IFdha2VUcmFpbGluZ0NodW5rW107XG4gIGluZmVyTXM6IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBXYWtlQ2xpZW50Q2FsbGJhY2tzIHtcbiAgb25SZWFkeT86IChtb2RlbElkOiBzdHJpbmcsIHdhcm11cE1zOiBudW1iZXIpID0+IHZvaWQ7XG4gIG9uRGV0ZWN0ZWQ6IChoaXQ6IFdha2VEZXRlY3Rpb25FdmVudCkgPT4gdm9pZDtcbiAgb25UZWxlbWV0cnk/OiAodDogV2FrZVRlbGVtZXRyeSkgPT4gdm9pZDtcbiAgb25FcnJvcj86IChtZXNzYWdlOiBzdHJpbmcpID0+IHZvaWQ7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgV29ya2VyTGlrZSB7XG4gIG9ubWVzc2FnZTogKChlOiBNZXNzYWdlRXZlbnQ8UmVjb3JkPHN0cmluZywgYW55Pj4pID0+IHZvaWQpIHwgbnVsbDtcbiAgb25lcnJvcjogKChlOiBFcnJvckV2ZW50KSA9PiB2b2lkKSB8IG51bGw7XG4gIHBvc3RNZXNzYWdlKG1lc3NhZ2U6IHVua25vd24sIHRyYW5zZmVyPzogVHJhbnNmZXJhYmxlW10pOiB2b2lkO1xuICB0ZXJtaW5hdGUoKTogdm9pZDtcbn1cblxuLyoqIE1heCBidWZmZXJlZCBwb3N0LWZlZWQgYXVkaW8gKH4xLjUgcyBhdCAyMCBtcyBjaHVua3MpIHRvIGNvdmVyIHdvcmtlciBzY29yaW5nIGxhdGVuY3kuICovXG5jb25zdCBSRUNFTlRfTUFYX0JZVEVTID0gTWF0aC5yb3VuZCgxLjUgKiAzMl8wMDApO1xuXG5leHBvcnQgY2xhc3MgV2FrZUNsaWVudCB7XG4gIHByaXZhdGUgd29ya2VyOiBXb3JrZXJMaWtlIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgcmVhZG9ubHkgY2FsbGJhY2tzOiBXYWtlQ2xpZW50Q2FsbGJhY2tzO1xuICBwcml2YXRlIHJlYWRvbmx5IGNyZWF0ZVdvcmtlcjogKCkgPT4gV29ya2VyTGlrZTtcbiAgcHJpdmF0ZSBsb2FkZWRNb2RlbElkOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBsb2FkaW5nTW9kZWxJZDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgY3VycmVudFRocmVzaG9sZCA9IDAuNztcbiAgcHJpdmF0ZSBnZW4gPSAwO1xuICBwcml2YXRlIHNlcSA9IDA7XG4gIHByaXZhdGUgcmVjZW50OiB7IHNlcTogbnVtYmVyOyBieXRlczogVWludDhBcnJheTsgc3VwcHJlc3NlZDogYm9vbGVhbiB9W10gPSBbXTtcbiAgcHJpdmF0ZSByZWNlbnRCeXRlcyA9IDA7XG4gIHJlYWR5ID0gZmFsc2U7XG5cbiAgY29uc3RydWN0b3IoXG4gICAgY2FsbGJhY2tzOiBXYWtlQ2xpZW50Q2FsbGJhY2tzLFxuICAgIGNyZWF0ZVdvcmtlcjogKCkgPT4gV29ya2VyTGlrZSA9ICgpID0+IG5ldyBXb3JrZXIoXCIvd2FrZS53b3JrZXIuanNcIiwgeyB0eXBlOiBcIm1vZHVsZVwiIH0pLFxuICApIHtcbiAgICB0aGlzLmNhbGxiYWNrcyA9IGNhbGxiYWNrcztcbiAgICB0aGlzLmNyZWF0ZVdvcmtlciA9IGNyZWF0ZVdvcmtlcjtcbiAgfVxuXG4gIHByaXZhdGUgY2xlYXJSZWNlbnQoKTogdm9pZCB7XG4gICAgdGhpcy5yZWNlbnQgPSBbXTtcbiAgICB0aGlzLnJlY2VudEJ5dGVzID0gMDtcbiAgfVxuXG4gIHByaXZhdGUgZW5zdXJlV29ya2VyKCk6IFdvcmtlckxpa2Uge1xuICAgIGlmICh0aGlzLndvcmtlcikgcmV0dXJuIHRoaXMud29ya2VyO1xuICAgIGNvbnN0IHdvcmtlciA9IHRoaXMuY3JlYXRlV29ya2VyKCk7XG4gICAgd29ya2VyLm9ubWVzc2FnZSA9IChlOiBNZXNzYWdlRXZlbnQ8UmVjb3JkPHN0cmluZywgYW55Pj4pID0+IHtcbiAgICAgIGNvbnN0IG0gPSBlLmRhdGE7XG4gICAgICBpZiAodHlwZW9mIG0uZ2VuID09PSBcIm51bWJlclwiICYmIG0uZ2VuICE9PSB0aGlzLmdlbikgcmV0dXJuO1xuICAgICAgaWYgKG0udHlwZSA9PT0gXCJyZWFkeVwiKSB7XG4gICAgICAgIHRoaXMubG9hZGluZ01vZGVsSWQgPSBudWxsO1xuICAgICAgICB0aGlzLmxvYWRlZE1vZGVsSWQgPSBtLm1vZGVsSWQ7XG4gICAgICAgIHRoaXMucmVhZHkgPSB0cnVlO1xuICAgICAgICB0aGlzLmNhbGxiYWNrcy5vblJlYWR5Py4obS5tb2RlbElkLCBtLndhcm11cE1zKTtcbiAgICAgIH0gZWxzZSBpZiAobS50eXBlID09PSBcImRldGVjdGVkXCIpIHtcbiAgICAgICAgY29uc3QgdHJhaWxpbmc6IFdha2VUcmFpbGluZ0NodW5rW10gPSBbXTtcbiAgICAgICAgY29uc3QgcmVzdCA9IG5ldyBVaW50OEFycmF5KG0ucmVzdEJ5dGVzIGFzIEFycmF5QnVmZmVyKTtcbiAgICAgICAgY29uc3QgaGl0U2VxID0gdHlwZW9mIG0uc2VxID09PSBcIm51bWJlclwiID8gbS5zZXEgOiBOdW1iZXIuTUFYX1NBRkVfSU5URUdFUjtcbiAgICAgICAgY29uc3QgaGl0SXRlbSA9IHRoaXMucmVjZW50LmZpbmQoKGl0ZW0pID0+IGl0ZW0uc2VxID09PSBoaXRTZXEpO1xuICAgICAgICBpZiAocmVzdC5ieXRlTGVuZ3RoID4gMCkge1xuICAgICAgICAgIHRyYWlsaW5nLnB1c2goeyBieXRlczogcmVzdCwgc3VwcHJlc3NlZDogaGl0SXRlbT8uc3VwcHJlc3NlZCA/PyBmYWxzZSB9KTtcbiAgICAgICAgfVxuICAgICAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgdGhpcy5yZWNlbnQpIHtcbiAgICAgICAgICBpZiAoaXRlbS5zZXEgPiBoaXRTZXEpIHRyYWlsaW5nLnB1c2goeyBieXRlczogaXRlbS5ieXRlcywgc3VwcHJlc3NlZDogaXRlbS5zdXBwcmVzc2VkIH0pO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMuY2xlYXJSZWNlbnQoKTtcbiAgICAgICAgdGhpcy5jYWxsYmFja3Mub25EZXRlY3RlZCh7XG4gICAgICAgICAgc2NvcmU6IG0uc2NvcmUsXG4gICAgICAgICAgYXRGcmFtZTogbS5hdEZyYW1lLFxuICAgICAgICAgIHRyYWlsaW5nLFxuICAgICAgICAgIGluZmVyTXM6IG0uaW5mZXJNcyxcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2UgaWYgKG0udHlwZSA9PT0gXCJ0ZWxlbWV0cnlcIikge1xuICAgICAgICB0aGlzLmNhbGxiYWNrcy5vblRlbGVtZXRyeT8uKHtcbiAgICAgICAgICBzY29yZTogbS5zY29yZSxcbiAgICAgICAgICBwZWFrOiBtLnBlYWssXG4gICAgICAgICAgZ2F0ZU9wZW46IG0uZ2F0ZU9wZW4sXG4gICAgICAgICAgZnJhbWVzOiBtLmZyYW1lcyxcbiAgICAgICAgICBzY29yZWQ6IG0uc2NvcmVkLFxuICAgICAgICAgIGluZmVyTXM6IG0uaW5mZXJNcyxcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2UgaWYgKG0udHlwZSA9PT0gXCJlcnJvclwiKSB7XG4gICAgICAgIHRoaXMubG9hZGluZ01vZGVsSWQgPSBudWxsO1xuICAgICAgICB0aGlzLnJlYWR5ID0gZmFsc2U7XG4gICAgICAgIHRoaXMuY2FsbGJhY2tzLm9uRXJyb3I/LihTdHJpbmcobS5tZXNzYWdlID8/IFwid2FrZSB3b3JrZXIgZXJyb3JcIikpO1xuICAgICAgfVxuICAgIH07XG4gICAgd29ya2VyLm9uZXJyb3IgPSAoZXJyKSA9PiB7XG4gICAgICB0aGlzLmxvYWRpbmdNb2RlbElkID0gbnVsbDtcbiAgICAgIHRoaXMucmVhZHkgPSBmYWxzZTtcbiAgICAgIHRoaXMuY2FsbGJhY2tzLm9uRXJyb3I/LihlcnIubWVzc2FnZSB8fCBcIndha2Ugd29ya2VyIGZhaWxlZFwiKTtcbiAgICB9O1xuICAgIHRoaXMud29ya2VyID0gd29ya2VyO1xuICAgIHJldHVybiB3b3JrZXI7XG4gIH1cblxuICAvKiogTG9hZHMgKG9yIHN3aXRjaGVzIHRvKSB0aGUgbmFtZWQgbW9kZWw7IGlnbm9yZXMgc3RhbGUgcmVzdWx0cyBmcm9tIGVhcmxpZXIgbG9hZHMuICovXG4gIGxvYWQobW9kZWxJZDogc3RyaW5nLCB0aHJlc2hvbGQ6IG51bWJlcik6IHZvaWQge1xuICAgIHRoaXMuY3VycmVudFRocmVzaG9sZCA9IHRocmVzaG9sZDtcbiAgICBjb25zdCB3b3JrZXIgPSB0aGlzLmVuc3VyZVdvcmtlcigpO1xuICAgIGlmICh0aGlzLnJlYWR5ICYmIHRoaXMubG9hZGVkTW9kZWxJZCA9PT0gbW9kZWxJZCkge1xuICAgICAgd29ya2VyLnBvc3RNZXNzYWdlKHsgdHlwZTogXCJjb25maWdcIiwgdGhyZXNob2xkIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAodGhpcy5sb2FkaW5nTW9kZWxJZCA9PT0gbW9kZWxJZCkge1xuICAgICAgd29ya2VyLnBvc3RNZXNzYWdlKHsgdHlwZTogXCJjb25maWdcIiwgdGhyZXNob2xkIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB0aGlzLmdlbisrO1xuICAgIHRoaXMucmVhZHkgPSBmYWxzZTtcbiAgICB0aGlzLmxvYWRpbmdNb2RlbElkID0gbW9kZWxJZDtcbiAgICB0aGlzLmNsZWFyUmVjZW50KCk7XG4gICAgd29ya2VyLnBvc3RNZXNzYWdlKHtcbiAgICAgIHR5cGU6IFwibG9hZFwiLFxuICAgICAgZ2VuOiB0aGlzLmdlbixcbiAgICAgIG1vZGVsSWQsXG4gICAgICB1cmw6IGAvd2FrZS9tb2RlbHMvJHtlbmNvZGVVUklDb21wb25lbnQobW9kZWxJZCl9Lm9ubnhgLFxuICAgICAgdGhyZXNob2xkLFxuICAgICAgd2FzbVBhdGhzOiBcIi9vcnQvXCIsXG4gICAgfSk7XG4gIH1cblxuICBzZXRUaHJlc2hvbGQodGhyZXNob2xkOiBudW1iZXIpOiB2b2lkIHtcbiAgICB0aGlzLmN1cnJlbnRUaHJlc2hvbGQgPSB0aHJlc2hvbGQ7XG4gICAgdGhpcy53b3JrZXI/LnBvc3RNZXNzYWdlKHsgdHlwZTogXCJjb25maWdcIiwgdGhyZXNob2xkIH0pO1xuICB9XG5cbiAgZmVlZChzYW1wbGVzOiBJbnQxNkFycmF5LCBzdXBwcmVzc2VkID0gZmFsc2UpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMucmVhZHkgfHwgIXRoaXMud29ya2VyKSByZXR1cm47XG4gICAgY29uc3Qgc2VxID0gKyt0aGlzLnNlcTtcbiAgICBjb25zdCBieXRlcyA9IG5ldyBVaW50OEFycmF5KHNhbXBsZXMuYnl0ZUxlbmd0aCk7XG4gICAgYnl0ZXMuc2V0KG5ldyBVaW50OEFycmF5KHNhbXBsZXMuYnVmZmVyLCBzYW1wbGVzLmJ5dGVPZmZzZXQsIHNhbXBsZXMuYnl0ZUxlbmd0aCkpO1xuICAgIHRoaXMucmVjZW50LnB1c2goeyBzZXEsIGJ5dGVzLCBzdXBwcmVzc2VkIH0pO1xuICAgIHRoaXMucmVjZW50Qnl0ZXMgKz0gYnl0ZXMuYnl0ZUxlbmd0aDtcbiAgICB3aGlsZSAodGhpcy5yZWNlbnRCeXRlcyA+IFJFQ0VOVF9NQVhfQllURVMgJiYgdGhpcy5yZWNlbnQubGVuZ3RoID4gMSkge1xuICAgICAgdGhpcy5yZWNlbnRCeXRlcyAtPSB0aGlzLnJlY2VudC5zaGlmdCgpIS5ieXRlcy5ieXRlTGVuZ3RoO1xuICAgIH1cbiAgICBjb25zdCBjb3B5ID0gbmV3IEludDE2QXJyYXkoc2FtcGxlcy5sZW5ndGgpO1xuICAgIGNvcHkuc2V0KHNhbXBsZXMpO1xuICAgIHRoaXMud29ya2VyLnBvc3RNZXNzYWdlKHsgdHlwZTogXCJmZWVkXCIsIGdlbjogdGhpcy5nZW4sIHNlcSwgcGNtOiBjb3B5LmJ1ZmZlciB9LCBbY29weS5idWZmZXJdKTtcbiAgfVxuXG4gIHJlc2V0KCk6IHZvaWQge1xuICAgIHRoaXMuY2xlYXJSZWNlbnQoKTtcbiAgICBpZiAoIXRoaXMud29ya2VyIHx8ICF0aGlzLnJlYWR5KSByZXR1cm47XG4gICAgdGhpcy5nZW4rKztcbiAgICB0aGlzLndvcmtlci5wb3N0TWVzc2FnZSh7IHR5cGU6IFwicmVzZXRcIiwgZ2VuOiB0aGlzLmdlbiB9KTtcbiAgfVxuXG4gIGRpc3Bvc2UoKTogdm9pZCB7XG4gICAgdGhpcy5nZW4rKztcbiAgICB0aGlzLnJlYWR5ID0gZmFsc2U7XG4gICAgdGhpcy5sb2FkZWRNb2RlbElkID0gbnVsbDtcbiAgICB0aGlzLmxvYWRpbmdNb2RlbElkID0gbnVsbDtcbiAgICB0aGlzLmNsZWFyUmVjZW50KCk7XG4gICAgaWYgKHRoaXMud29ya2VyKSB7XG4gICAgICB0aGlzLndvcmtlci5wb3N0TWVzc2FnZSh7IHR5cGU6IFwiZGlzcG9zZVwiLCBnZW46IHRoaXMuZ2VuIH0pO1xuICAgICAgdGhpcy53b3JrZXIudGVybWluYXRlKCk7XG4gICAgICB0aGlzLndvcmtlciA9IG51bGw7XG4gICAgfVxuICB9XG5cbiAgZ2V0IG1vZGVsSWQoKTogc3RyaW5nIHwgbnVsbCB7XG4gICAgcmV0dXJuIHRoaXMubG9hZGVkTW9kZWxJZCA/PyB0aGlzLmxvYWRpbmdNb2RlbElkO1xuICB9XG5cbiAgZ2V0IHRocmVzaG9sZCgpOiBudW1iZXIge1xuICAgIHJldHVybiB0aGlzLmN1cnJlbnRUaHJlc2hvbGQ7XG4gIH1cbn1cblxuZXhwb3J0IGludGVyZmFjZSBXYWtlTG9ja1NlbnRpbmVsTGlrZSB7XG4gIHJlYWRvbmx5IHJlbGVhc2VkPzogYm9vbGVhbjtcbiAgcmVsZWFzZSgpOiBQcm9taXNlPHZvaWQ+O1xuICBhZGRFdmVudExpc3RlbmVyPyh0eXBlOiBzdHJpbmcsIGxpc3RlbmVyOiAoKSA9PiB2b2lkKTogdm9pZDtcbn1cblxuLyoqXG4gKiBXcmFwcyB0aGUgU2NyZWVuIFdha2UgTG9jayBBUEkgc28gYnJvd3Nlci1pbml0aWF0ZWQgcmVsZWFzZXMgKHN1Y2ggYXMgaGlkaW5nIGEgdGFiKSBjbGVhciB0aGVcbiAqIHN0b3JlZCBzZW50aW5lbCBhbmQgYWxsb3cgcmVhY3F1aXJpbmcgb24gdmlzaWJpbGl0eSByZXN0b3JlLCB3aGlsZSBjYW5jZWxsaW5nIGluLWZsaWdodCByZXF1ZXN0cy5cbiAqL1xuZXhwb3J0IGNsYXNzIFNjcmVlbldha2VMb2NrIHtcbiAgcHJpdmF0ZSBzZW50aW5lbDogV2FrZUxvY2tTZW50aW5lbExpa2UgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBnZW4gPSAwO1xuICBwcml2YXRlIHJlYWRvbmx5IHJlcXVlc3RMb2NrOiAoKSA9PiBQcm9taXNlPFdha2VMb2NrU2VudGluZWxMaWtlIHwgdW5kZWZpbmVkPjtcblxuICBjb25zdHJ1Y3RvcihcbiAgICByZXF1ZXN0TG9jazogKCkgPT4gUHJvbWlzZTxXYWtlTG9ja1NlbnRpbmVsTGlrZSB8IHVuZGVmaW5lZD4gPSAoKSA9PlxuICAgICAgKG5hdmlnYXRvciBhcyBhbnkpLndha2VMb2NrPy5yZXF1ZXN0KFwic2NyZWVuXCIpID8/IFByb21pc2UucmVzb2x2ZSh1bmRlZmluZWQpLFxuICApIHtcbiAgICB0aGlzLnJlcXVlc3RMb2NrID0gcmVxdWVzdExvY2s7XG4gIH1cblxuICBnZXQgaGVsZCgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5zZW50aW5lbCAhPSBudWxsICYmICF0aGlzLnNlbnRpbmVsLnJlbGVhc2VkO1xuICB9XG5cbiAgYXN5bmMgYWNxdWlyZShzdGlsbFdhbnRlZDogKCkgPT4gYm9vbGVhbik6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICh0aGlzLmhlbGQgfHwgIXN0aWxsV2FudGVkKCkpIHJldHVybjtcbiAgICBjb25zdCBnZW4gPSArK3RoaXMuZ2VuO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBsb2NrID0gYXdhaXQgdGhpcy5yZXF1ZXN0TG9jaygpO1xuICAgICAgaWYgKCFsb2NrKSByZXR1cm47XG4gICAgICBpZiAoZ2VuICE9PSB0aGlzLmdlbiB8fCAhc3RpbGxXYW50ZWQoKSkge1xuICAgICAgICB2b2lkIGxvY2sucmVsZWFzZSgpLmNhdGNoKCgpID0+IHt9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgdGhpcy5zZW50aW5lbCA9IGxvY2s7XG4gICAgICBsb2NrLmFkZEV2ZW50TGlzdGVuZXI/LihcInJlbGVhc2VcIiwgKCkgPT4ge1xuICAgICAgICBpZiAodGhpcy5zZW50aW5lbCA9PT0gbG9jaykgdGhpcy5zZW50aW5lbCA9IG51bGw7XG4gICAgICB9KTtcbiAgICB9IGNhdGNoIHt9XG4gIH1cblxuICByZWxlYXNlKCk6IHZvaWQge1xuICAgIHRoaXMuZ2VuKys7XG4gICAgY29uc3QgbG9jayA9IHRoaXMuc2VudGluZWw7XG4gICAgdGhpcy5zZW50aW5lbCA9IG51bGw7XG4gICAgdm9pZCBsb2NrPy5yZWxlYXNlKCkuY2F0Y2goKCkgPT4ge30pO1xuICB9XG59XG4iLCAiLy8gVGhlIHdlYiBzdXJmYWNlOiBhIGZvdXJ0aCBob3N0IGZvciB0aGUgdm9pY2UgY29yZSwgYW5kIGEgcGhvbmUtZnJpZW5kbHkgd2F5IHRvIHVzZSBpdCBmb3Igd29yay5cbi8vIEl0IGxvYWRzIHRoZSBkZXYgc2VydmVyJ3MgbGF0ZXN0IGJ1aWxkIGF0IGVhY2ggY2FsbCwgc28gYW4gZWRpdCBpbiBzcmMvIGlzIGxpdmUgb24gdGhlIG5leHRcbi8vIGNhbGwsIGFuZCBrZWVwcyBldmVyeSBjYWxsIGFzIGEgdHJhY2UgdGhlIHJlcGxheSB2aWV3IChhbmQgYW55IG90aGVyIGhvc3QpIGNhbiBydW4gYWdhaW4uXG4vL1xuLy8gVGhlIGhvc3QncyBwYXJ0IGlzIHNtYWxsOiB0aGUgbWljcm9waG9uZSBhbmQgc3BlYWtlciAoYXVkaW8udHMpLCB0aGUgbW9kZWwncyBzb2NrZXQgdGhyb3VnaCB0aGVcbi8vIHNlcnZlcidzIHJlbGF5LCBIZXJtZXMgYW5kIFQzIHRocm91Z2ggdGhlIHNlcnZlciwgYW5kIHRoZSBzY3JlZW4uIFRoZSBjb3JlIGRlY2lkZXMgdGhlIHJlc3QuXG4vL1xuLy8gVHlwaW5nIHdpdGggbm8gY2FsbCBvbiBzdGFydHMgYSBjaGF0IGluc3RlYWQ6IHRoZSBzYW1lIGNvcmUgd2l0aCBgbWVkaXVtOiBcInRleHRcImAsIHdob3NlIHJlcXVlc3RzXG4vLyB0byB0aGUgdGV4dCBtb2RlbCBnbyB0aHJvdWdoIHRoZSBzZXJ2ZXIncyAvZ2VuZXJhdGUuIFRhc2tzLCBmb2xsb3ctdXBzIGFuZCB0aGVpciBjYXJkcyB3b3JrIGFzXG4vLyBpbiBhIGNhbGwuIFByZXNzaW5nIENhbGwgZW5kcyB0aGUgY2hhdCBhbmQgY2FycmllcyBpdHMgY29udmVyc2F0aW9uIG9uIGJ5IHZvaWNlLlxuXG5pbXBvcnQgeyBjb21tYW5kSW4gfSBmcm9tIFwiLi4vc3JjL2NvbW1hbmRzLnRzXCI7XG5pbXBvcnQgeyBDYWxsQXVkaW8sIGJ5dGVzVG9CYXNlNjQgfSBmcm9tIFwiLi9hdWRpby50c1wiO1xuaW1wb3J0IHsgUmVwbGF5IH0gZnJvbSBcIi4vcmVwbGF5LnRzXCI7XG5pbXBvcnQgeyBBdXRvU2Nyb2xsZXIgfSBmcm9tIFwiLi9zY3JvbGwudHNcIjtcbmltcG9ydCB7XG4gIGNhbkZvbGxvd1VwUmVzdWx0LFxuICBmb3JtYXRTaG9ydFRpbWUsXG4gIG5vcm1hbGl6ZURlbnNpdHksXG4gIG5vcm1hbGl6ZVNpZGVGaWx0ZXIsXG4gIHBhcnNlUHJlZml4LFxuICBwbGFpblByZXZpZXcsXG4gIHJlc29sdmVNb2JpbGVCYW5uZXJGaWx0ZXIsXG4gIHJlc29sdmVTaWRlU2VjdGlvbnMsXG4gIHNob3VsZENsZWFyVW5yZWFkUmVzdWx0cyxcbiAgdHlwZSBTaWRlRmlsdGVyLFxufSBmcm9tIFwiLi91aS50c1wiO1xuaW1wb3J0IHsgU2NyZWVuV2FrZUxvY2ssIFdha2VDbGllbnQsIHR5cGUgV2FrZURldGVjdGlvbkV2ZW50LCB0eXBlIFdha2VUZWxlbWV0cnkgfSBmcm9tIFwiLi93YWtlQ2xpZW50LnRzXCI7XG5cbmludGVyZmFjZSBDb3JlIHtcbiAgdmVyc2lvbjogc3RyaW5nO1xuICBkZWZhdWx0cygpOiBzdHJpbmc7XG4gIGNyZWF0ZShjb25maWc6IHN0cmluZywgdDogbnVtYmVyKTogc3RyaW5nO1xuICBwdXNoKGlkOiBudW1iZXIsIGV2ZW50OiBzdHJpbmcpOiBzdHJpbmc7XG4gIHRyYWNlKGlkOiBudW1iZXIpOiBzdHJpbmc7XG4gIGRpc3Bvc2UoaWQ6IG51bWJlcik6IHZvaWQ7XG59XG50eXBlIENvbW1hbmQgPSBSZWNvcmQ8c3RyaW5nLCBhbnk+ICYgeyB0eXBlOiBzdHJpbmcgfTtcbmludGVyZmFjZSBXYWtlTW9kZWxJbmZvIHsgaWQ6IHN0cmluZzsgbGFiZWw6IHN0cmluZyB9XG5pbnRlcmZhY2UgU2VydmVyQ29uZmlnIHsgcm91dGU6IHN0cmluZzsgbW9kZWw6IHN0cmluZzsgY2FwdGlvbnNNb2RlbD86IHN0cmluZzsgdGV4dE1vZGVsPzogc3RyaW5nOyB2ZXJzaW9uOiBzdHJpbmc7IGhlcm1lczogYm9vbGVhbjsgdDM6IHN0cmluZ1tdIHwgbnVsbDsgd2FrZU1vZGVscz86IFdha2VNb2RlbEluZm9bXSB9XG5cbmNvbnN0ICQgPSA8VCBleHRlbmRzIEhUTUxFbGVtZW50ID0gSFRNTEVsZW1lbnQ+KGlkOiBzdHJpbmcpID0+IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGlkKSBhcyBUO1xuY29uc3Qgbm93ID0gKCkgPT4gcGVyZm9ybWFuY2Uubm93KCkgLyAxMDAwO1xuY29uc3QgY2hlY2tlZCA9IChpZDogc3RyaW5nKSA9PiAkPEhUTUxJbnB1dEVsZW1lbnQ+KGlkKS5jaGVja2VkO1xuXG4vKiogVGhlIGxhdGVzdCBidWlsZCBmcm9tIHRoZSBkZXYgc2VydmVyLCBldmFsdWF0ZWQgYWZyZXNoOiBhbiBlZGl0IGluIHNyYy8gaXMgaW4gdGhlIG5leHQgY2FsbC4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBsb2FkQ29yZSh1cmwgPSBcIi92b2ljZS1jb3JlLmpzXCIpOiBQcm9taXNlPENvcmU+IHtcbiAgY29uc3Qgc291cmNlID0gYXdhaXQgKGF3YWl0IGZldGNoKHVybCwgeyBjYWNoZTogXCJuby1zdG9yZVwiIH0pKS50ZXh0KCk7XG4gIGNvbnN0IHNjb3BlOiB7IFZvaWNlQ29yZT86IENvcmUgfSA9IHt9O1xuICBuZXcgRnVuY3Rpb24oXCJnbG9iYWxUaGlzXCIsIHNvdXJjZSkoc2NvcGUpO1xuICBpZiAoIXNjb3BlLlZvaWNlQ29yZSkgdGhyb3cgbmV3IEVycm9yKFwidGhlIGJ1bmRsZSBkaWRuJ3QgZGVmaW5lIFZvaWNlQ29yZVwiKTtcbiAgcmV0dXJuIHNjb3BlLlZvaWNlQ29yZTtcbn1cblxuLy8gUHJlc2V0czogZWFjaCBzdXJmYWNlJ3Mgc2V0dGluZ3MgYXMgaXRzIGFwcCB3b3VsZCBzZXQgdGhlbS5cblxuY29uc3QgRkFLRV9UViA9IFtcbiAgeyBuYW1lOiBcInR2X3ZvbHVtZVwiLCBkZXNjcmlwdGlvbjogXCJTZXRzIHRoZSBsaXZpbmctcm9vbSBUVidzIHZvbHVtZSwgMCB0byAxMDAuXCIsIHBhcmFtZXRlcnM6IHsgdHlwZTogXCJPQkpFQ1RcIiwgcHJvcGVydGllczogeyBsZXZlbDogeyB0eXBlOiBcIklOVEVHRVJcIiB9IH0sIHJlcXVpcmVkOiBbXCJsZXZlbFwiXSB9IH0sXG4gIHsgbmFtZTogXCJ0dl9wYXVzZVwiLCBkZXNjcmlwdGlvbjogXCJQYXVzZXMgb3IgcmVzdW1lcyB3aGF0J3MgcGxheWluZyBvbiB0aGUgVFYuXCIsIHBhcmFtZXRlcnM6IHsgdHlwZTogXCJPQkpFQ1RcIiwgcHJvcGVydGllczogeyBwYXVzZTogeyB0eXBlOiBcIkJPT0xFQU5cIiB9IH0gfSB9LFxuXTtcblxuY29uc3QgUFJFU0VUUzogUmVjb3JkPHN0cmluZywgUmVjb3JkPHN0cmluZywgdW5rbm93bj4+ID0ge1xuICB3ZWI6IHsgcGxhdGZvcm06IFwid2ViXCIsIGRldmljZTogXCJicm93c2VyXCIsIHN0YW5kYnlBZnRlcjogMzAsIGhhbmRPZmY6IFwibmFtZWRcIiwgc3VwZXJ2aXNlOiB0cnVlLCB2b2NhYnVsYXJ5OiBbXCJIZXJtZXNcIiwgXCJCZW50b1wiLCBcIldvb2Rob3VzZVwiLCBcIlBlbm55d29ydGhcIiwgXCJUM1wiXSB9LFxuICBcIndlYiB3YWtlIHdvcmRcIjoge1xuICAgIHBsYXRmb3JtOiBcIndlYlwiLCBkZXZpY2U6IFwiYnJvd3NlclwiLCBzdGFuZGJ5QWZ0ZXI6IDIwLCBoYW5nVXBBZnRlcjogMTIwLCBoYW5kT2ZmOiBcIm5hbWVkXCIsIHN1cGVydmlzZTogdHJ1ZSxcbiAgICBhdHRlbnRpb246IHsgbW9kZTogXCJ3aW5kb3dcIiwgYWZ0ZXJXYWtlOiA4LCB3aW5kb3c6IDUsIGFmdGVyUXVlc3Rpb246IDEwLCBhZnRlckhhbmRPZmY6IDMsIGFmdGVyQW5ub3VuY2VtZW50OiAwIH0sXG4gICAgdm9jYWJ1bGFyeTogW1wiSGVybWVzXCIsIFwiQmVudG9cIiwgXCJXb29kaG91c2VcIiwgXCJQZW5ueXdvcnRoXCIsIFwiVDNcIl0sXG4gIH0sXG4gIGFuZHJvaWQ6IHsgcGxhdGZvcm06IFwiQW5kcm9pZFwiLCBkZXZpY2U6IFwicGhvbmVcIiwgc3RhbmRieUFmdGVyOiAyMCB9LFxuICBcImFuZHJvaWQgd2FrZSB3b3JkXCI6IHsgcGxhdGZvcm06IFwiQW5kcm9pZFwiLCBkZXZpY2U6IFwicGhvbmVcIiwgc3RhbmRieUFmdGVyOiAyMCwgaGFuZ1VwQWZ0ZXI6IDE1IH0sXG4gIG1hY29zOiB7IHBsYXRmb3JtOiBcIm1hY09TXCIsIGRldmljZTogXCJNYWNcIiwgc3RhbmRieUFmdGVyOiAyMCB9LFxuICBlY2hvOiB7XG4gICAgcGxhdGZvcm06IFwiRWNob1wiLCBkZXZpY2U6IFwic3BlYWtlclwiLCBoYW5nVXBBZnRlcjogNiwgc3RhbmRieUFmdGVyOiA4LCBlYXJjb25zOiB0cnVlLCB2b2NhYnVsYXJ5OiBbXCJIZXJtZXNcIiwgXCJCZW50b1wiLCBcIldvb2Rob3VzZVwiXSxcbiAgICBtaWM6IHsgd2hpbGVTcGVha2luZzogXCJ3YWtlXCIsIGdhaW5EYjogMCB9LCBob3N0VG9vbHM6IEZBS0VfVFYsXG4gIH0sXG59O1xuXG4vLyBTdGF0ZS5cblxuY29uc3QgYXVkaW8gPSBuZXcgQ2FsbEF1ZGlvKCk7XG5sZXQgc2VydmVyOiBTZXJ2ZXJDb25maWc7XG5sZXQgY29yZTogQ29yZSB8IG51bGwgPSBudWxsO1xubGV0IGNhbGxJZCA9IDA7XG4vKiogTW9ub3RvbmljIHBlci1wYWdlIHNlc3Npb24gaWQgKHVubGlrZSBjb3JlJ3MgY2FsbElkL3Rhc2tJZCwgd2hpY2ggcmVzdGFydCBhZnRlciBsb2FkQ29yZSgpKS4gKi9cbmxldCBzZXNzaW9uU2VxID0gMDtcbmxldCBhY3RpdmVTZXNzaW9uID0gMDtcbmxldCBjYWxsTmFtZSA9IFwiXCI7XG5sZXQgdGlja2VyID0gMDtcbmxldCB0cmFjZVRpbWVyID0gMDtcbmxldCBzdGFydGVkQXQgPSBub3coKTtcbmNvbnN0IHNvY2tldHMgPSBuZXcgTWFwPG51bWJlciwgV2ViU29ja2V0PigpO1xuLyoqIFRoZSBzb2NrZXRzIHRvIHRoZSB0cmFuc2NyaXB0aW9uIG1vZGVsOiB0aGVpciBhdWRpbyBpcyB0aGUgbW9kZWwncyBhZ2Fpbiwgc28gaXQgaXNuJ3QgY291bnRlZCBvciBsb2dnZWQgdHdpY2UuICovXG5jb25zdCBjYXB0aW9uU29ja2V0cyA9IG5ldyBTZXQ8bnVtYmVyPigpO1xuY29uc3QgcnVucyA9IG5ldyBNYXA8c3RyaW5nLCB7IGFib3J0OiBBYm9ydENvbnRyb2xsZXI7IGFnZW50OiBzdHJpbmc7IHRhc2tJZDogc3RyaW5nIH0+KCk7XG5pbnRlcmZhY2UgVGFza1ZpZXcgeyBjOiBDb21tYW5kOyBzaW5jZTogbnVtYmVyOyBlbmRlZDogbnVtYmVyIHwgbnVsbDsgdGhyZWFkPzogc3RyaW5nOyByZXN1bHRJZD86IHN0cmluZzsgYXBwcm92YWw/OiB7IGNvbW1hbmQ6IHN0cmluZyB9IH1cbmNvbnN0IHRhc2tzID0gbmV3IE1hcDxzdHJpbmcsIFRhc2tWaWV3PigpO1xuaW50ZXJmYWNlIFJlc3VsdEVudHJ5IHtcbiAgaWQ6IHN0cmluZztcbiAgYWdlbnQ6IHN0cmluZztcbiAgbGFiZWw6IHN0cmluZztcbiAgdGV4dDogc3RyaW5nO1xuICBmYWlsZWQ6IGJvb2xlYW47XG4gIHRhc2tJZD86IHN0cmluZztcbiAgc2Vzc2lvbklkOiBudW1iZXI7XG4gIGNhcmQ6IEhUTUxFbGVtZW50O1xuICBoZWFkOiBIVE1MQnV0dG9uRWxlbWVudDtcbiAgYm9keTogSFRNTEVsZW1lbnQ7XG4gIG1vcmVCdG46IEhUTUxCdXR0b25FbGVtZW50O1xuICBmb2xsb3dCdG4/OiBIVE1MQnV0dG9uRWxlbWVudDtcbiAgcmVmUm93OiBIVE1MQnV0dG9uRWxlbWVudDtcbn1cbmNvbnN0IHJlc3VsdHMgPSBuZXcgTWFwPHN0cmluZywgUmVzdWx0RW50cnk+KCk7XG5sZXQgbmV4dFJlc3VsdFNlcSA9IDA7XG5sZXQgc2lkZUZpbHRlcjogU2lkZUZpbHRlciA9IFwiYWxsXCI7XG5sZXQgdW5yZWFkTW9iaWxlUmVzdWx0cyA9IDA7XG5sZXQgZmxhc2hUaW1lciA9IDA7XG5sZXQgZWFybGllckFjdGl2ZUNvdW50ID0gMDtcbmxldCBlYXJsaWVyV2FpdGluZ0NvdW50ID0gMDtcbmxldCBjb3VudHMgPSB7IG1pYzogMCwgcGxheTogMCwgc2VudDogMCB9O1xubGV0IGZha2VUdkxldmVsID0gMTU7XG5sZXQgY29yZVN0YXR1cyA9IFwiaWRsZVwiO1xubGV0IG11dGVkID0gZmFsc2U7XG5sZXQgaG9sZGluZyA9IGZhbHNlO1xuY29uc3Qgc2NyZWVuV2FrZUxvY2sgPSBuZXcgU2NyZWVuV2FrZUxvY2soKTtcbi8qKiBXYWtlIHdvcmQgbG9vcCBzdGF0ZTogYXJtZWQgYmV0d2VlbiBjYWxscywgcmVxdWVzdGVkIGJ5IGNvcmUgd2hpbGUgZG9ybWFudC9zcGVha2luZywgb3IgbWlkLWhhbmRvZmYuICovXG5sZXQgd2FrZUFybWVkID0gZmFsc2U7XG5sZXQgYXJtR2VuID0gMDtcbmxldCBjb3JlV2FudHNXYWtlID0gZmFsc2U7XG5sZXQgY2FsbFdoaWxlU3BlYWtpbmcgPSBcInNlbmRcIjtcbi8qKiBNaXJyb3JzIHRoZSBjb3JlJ3MgYHNwZWVjaFVudGlsYCBjbG9jayBzbyBlYWNoIG1pYyBmcmFtZSByZWNvcmRzIHdoZXRoZXIgYGNhbGwudHNgIHN1cHByZXNzZWQgaXQuICovXG5sZXQgY29yZVNwZWVjaFVudGlsID0gMDtcbmxldCB3YWtlTG9hZGluZyA9IGZhbHNlO1xubGV0IHdha2VTdGFydGluZyA9IGZhbHNlO1xubGV0IHN0YXJ0aW5nQ2FsbCA9IGZhbHNlO1xubGV0IG9wZW5pbmdDaHVua3M6IFVpbnQ4QXJyYXlbXSA9IFtdO1xubGV0IG9wZW5pbmdCeXRlcyA9IDA7XG5jb25zdCBPUEVOSU5HX01BWF9CWVRFUyA9IDEwICogMzJfMDAwO1xubGV0IHdha2VMYXN0VGVsOiBXYWtlVGVsZW1ldHJ5IHwgbnVsbCA9IG51bGw7XG4vKiogV2hhdCB0aGUgc2Vzc2lvbiBvbiBzY3JlZW4gaXM6IGEgdm9pY2UgY2FsbCwgb3IgYSB0eXBlZCBjaGF0ICh0aGUgY29yZSdzIG1lZGl1bSBcInRleHRcIikuICovXG5sZXQgbWVkaXVtOiBcInZvaWNlXCIgfCBcInRleHRcIiA9IFwidm9pY2VcIjtcbi8qKiBBIGNoYXQncyBtb2RlbCBpcyB3cml0aW5nIGl0cyBhbnN3ZXIuICovXG5sZXQgdGhpbmtpbmcgPSBmYWxzZTtcbi8qKiBBIGNoYXQncyByZXF1ZXN0cyB0byB0aGUgdGV4dCBtb2RlbCB0aGF0IGFyZSB1bmRlciB3YXkuICovXG5jb25zdCByZXF1ZXN0cyA9IG5ldyBNYXA8bnVtYmVyLCBBYm9ydENvbnRyb2xsZXI+KCk7XG4vKiogVGhlIGxhc3Qgc2Vzc2lvbiB3aW5kaW5nIGRvd24gKGl0cyB0cmFjZSBzYXZlZCwgdGhlIGNvcmUncyBjYWxsIGRpc3Bvc2VkKTogdGhlIG5leHQgc3RhcnRzIGFmdGVyIGl0LiAqL1xubGV0IGVuZGluZzogUHJvbWlzZTx2b2lkPiA9IFByb21pc2UucmVzb2x2ZSgpO1xuXG4vLyBUaGUgY29udmVyc2F0aW9uLCBrZXB0IHNvIGEgbmV3IGNhbGwgY2FuIGNhcnJ5IG9uIGZyb20gaXQgKHRoZSBjb3JlJ3MgYGhpc3RvcnlgLCByZWNhcHBlZCB0byB0aGUgbW9kZWwpLlxuaW50ZXJmYWNlIENoYXRMaW5lIHsgcm9sZTogXCJ1c2VyXCIgfCBcImFzc2lzdGFudFwiOyBzcGVha2VyPzogc3RyaW5nOyB0ZXh0OiBzdHJpbmcgfVxuY29uc3QgSElTVE9SWSA9IFwidm9pY2UuaGlzdG9yeVwiO1xuY29uc3QgSElTVE9SWV9NQVhfQUdFID0gMTIgKiAzNjAwICogMTAwMDtcbmxldCBjaGF0OiBDaGF0TGluZVtdID0gW107XG4vKiogVGhlIGNvcmUncyBudW1iZXIgZm9yIHRoZSBsaW5lIHRoZSBsYXN0IHdvcmRzIHdlcmUgcmVtZW1iZXJlZCBvbiwgdW50aWwgc29tZXRoaW5nIGVsc2UgaXMuICovXG5sZXQgbGFzdExpbmU6IG51bWJlciB8IG51bGwgPSBudWxsO1xuXG5mdW5jdGlvbiByZW1lbWJlcihyb2xlOiBcInVzZXJcIiB8IFwiYXNzaXN0YW50XCIsIHRleHQ6IHN0cmluZywgc3BlYWtlcj86IHN0cmluZywgam9pbiA9IGZhbHNlKSB7XG4gIGNvbnN0IGxhc3QgPSBjaGF0LmF0KC0xKTtcbiAgaWYgKGpvaW4gJiYgbGFzdCAmJiBsYXN0LnJvbGUgPT09IHJvbGUgJiYgbGFzdC5zcGVha2VyID09PSBzcGVha2VyKSBsYXN0LnRleHQgKz0gdGV4dDtcbiAgZWxzZSBjaGF0LnB1c2goc3BlYWtlciA/IHsgcm9sZSwgc3BlYWtlciwgdGV4dCB9IDogeyByb2xlLCB0ZXh0IH0pO1xuICBpZiAoY2hhdC5sZW5ndGggPiAyMDApIGNoYXQuc3BsaWNlKDAsIGNoYXQubGVuZ3RoIC0gMjAwKTtcbiAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oSElTVE9SWSwgSlNPTi5zdHJpbmdpZnkoeyBhdDogRGF0ZS5ub3coKSwgY2hhdCB9KSk7XG59XG5cbmZ1bmN0aW9uIHNhdmVkSGlzdG9yeSgpOiBDaGF0TGluZVtdIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBzYXZlZCA9IEpTT04ucGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oSElTVE9SWSkgPz8gXCJudWxsXCIpO1xuICAgIHJldHVybiBzYXZlZCAmJiBEYXRlLm5vdygpIC0gc2F2ZWQuYXQgPCBISVNUT1JZX01BWF9BR0UgJiYgQXJyYXkuaXNBcnJheShzYXZlZC5jaGF0KSA/IHNhdmVkLmNoYXQgOiBbXTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG59XG5cbi8qKiBUd28tbm90ZSBjaGltZSwgUENNMTYgbW9ubyBhdCAyNCBrSHosIGJhc2U2NC4gKi9cbmZ1bmN0aW9uIHR3b05vdGVUb25lKGYxOiBudW1iZXIsIGYyOiBudW1iZXIsIG5vdGVTZWM6IG51bWJlciwgYW1wOiBudW1iZXIpOiBzdHJpbmcge1xuICBjb25zdCByYXRlID0gMjQwMDAsIG4gPSBNYXRoLnJvdW5kKHJhdGUgKiBub3RlU2VjICogMiksIGhhbGYgPSBNYXRoLnJvdW5kKHJhdGUgKiBub3RlU2VjKSwgb3V0ID0gbmV3IEludDE2QXJyYXkobik7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgbjsgaSsrKSB7XG4gICAgY29uc3QgZmlyc3QgPSBpIDwgaGFsZjtcbiAgICBjb25zdCB0ID0gaSAvIHJhdGUsIGYgPSBmaXJzdCA/IGYxIDogZjIsIGxvY2FsID0gZmlyc3QgPyB0IDogdCAtIG5vdGVTZWM7XG4gICAgY29uc3QgZW52ID0gTWF0aC5taW4oMSwgbG9jYWwgKiA2MCwgKG5vdGVTZWMgLSBsb2NhbCkgKiA2MCk7XG4gICAgb3V0W2ldID0gTWF0aC5yb3VuZChNYXRoLnNpbigyICogTWF0aC5QSSAqIGYgKiB0KSAqIE1hdGgubWF4KDAsIGVudikgKiBhbXApO1xuICB9XG4gIHJldHVybiBieXRlc1RvQmFzZTY0KG5ldyBVaW50OEFycmF5KG91dC5idWZmZXIpKTtcbn1cblxuLyoqIFR3byByaXNpbmcgbm90ZXM6IHNvbWV0aGluZyBvbiB0aGUgc2NyZWVuIG5lZWRzIHRoZSB1c2VyLiAqL1xuY29uc3QgQVBQUk9WQUxfVE9ORSA9IHR3b05vdGVUb25lKDY2MCwgODgwLCAwLjE2LCA2MDAwKTtcbi8qKiBDcmlzcCByaXNpbmcgY2hpbWU6IHRoZSB3YWtlIHdvcmQgZmlyZWQgKHN0YXJ0IHNpZ25hbCkuICovXG5jb25zdCBXQUtFX1RPTkUgPSB0d29Ob3RlVG9uZSg1ODcuMzMsIDg4MCwgMC4xMSwgNTUwMCk7XG4vKiogU29mdCBmYWxsaW5nIGNoaW1lOiB0aGUgYXR0ZW50aW9uIHdpbmRvdyBjbG9zZWQgYW5kIHRoZSBjYWxsIHdlbnQgZG9ybWFudCAoZW5kIHNpZ25hbCkuICovXG5jb25zdCBTTEVFUF9UT05FID0gdHdvTm90ZVRvbmUoNjU5LjI1LCA0OTMuODgsIDAuMTEsIDM0MDApO1xuXG4vLyBMYXRlbmN5OiB0aGUgbmV0d29yaydzIHJvdW5kIHRyaXAsIGFuZCBob3cgbG9uZyBhZnRlciB0aGUgdXNlciBzdG9wcyB0YWxraW5nIHRoZSByZXBseSBzdGFydHMuXG5jb25zdCBtZXRyaWNzID0geyBydHQ6IFtdIGFzIG51bWJlcltdLCByZXBseTogW10gYXMgbnVtYmVyW10sIGxhc3RWb2ljZTogMCwgbGFzdFBsYXk6IDAsIHJlcGxpZWQ6IHRydWUgfTtcblxuZnVuY3Rpb24gbWVkaWFuKHhzOiBudW1iZXJbXSk6IG51bWJlciB8IG51bGwge1xuICBpZiAoeHMubGVuZ3RoID09PSAwKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgcyA9IFsuLi54c10uc29ydCgoYSwgYikgPT4gYSAtIGIpO1xuICByZXR1cm4gc1tNYXRoLmZsb29yKHMubGVuZ3RoIC8gMildO1xufVxuXG5mdW5jdGlvbiBzaG93TWV0cmljcygpIHtcbiAgY29uc3QgcGFydHM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IHJ0dCA9IG1lZGlhbihtZXRyaWNzLnJ0dCk7XG4gIGlmIChydHQgIT0gbnVsbCkgcGFydHMucHVzaChgJHtNYXRoLnJvdW5kKHJ0dCAqIDEwMDApfSBtc2ApO1xuICBjb25zdCByZXBseSA9IG1lZGlhbihtZXRyaWNzLnJlcGx5KTtcbiAgaWYgKHJlcGx5ICE9IG51bGwpIHBhcnRzLnB1c2goYHJlcGx5ICR7bWV0cmljcy5yZXBseS5hdCgtMSkhLnRvRml4ZWQoMSl9cyAoJHtyZXBseS50b0ZpeGVkKDEpfXMgbWVkKWApO1xuICBjb25zdCBvdXQgPSBhdWRpby5vdXRwdXRMYXRlbmN5O1xuICBpZiAob3V0ICE9IG51bGwpIHBhcnRzLnB1c2goYGF1ZGlvICR7TWF0aC5yb3VuZChvdXQgKiAxMDAwKX0gbXNgKTtcbiAgbGV0IGJ1ZmZlcmVkID0gMDtcbiAgZm9yIChjb25zdCB3cyBvZiBzb2NrZXRzLnZhbHVlcygpKSBidWZmZXJlZCArPSB3cy5idWZmZXJlZEFtb3VudDtcbiAgaWYgKGJ1ZmZlcmVkID4gMzJfMDAwKSBwYXJ0cy5wdXNoKGB1cGxvYWQgKyR7KGJ1ZmZlcmVkIC8gMzJfMDAwKS50b0ZpeGVkKDEpfXNgKTtcbiAgJChcIm1ldHJpY3NcIikudGV4dENvbnRlbnQgPSBwYXJ0cy5qb2luKFwiIFx1MDBCNyBcIik7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHBpbmcoKSB7XG4gIGNvbnN0IHQgPSBub3coKTtcbiAgdHJ5IHtcbiAgICBhd2FpdCBmZXRjaChcIi9waW5nXCIsIHsgY2FjaGU6IFwibm8tc3RvcmVcIiB9KTtcbiAgICBtZXRyaWNzLnJ0dC5wdXNoKG5vdygpIC0gdCk7XG4gICAgaWYgKG1ldHJpY3MucnR0Lmxlbmd0aCA+IDEyKSBtZXRyaWNzLnJ0dC5zaGlmdCgpO1xuICB9IGNhdGNoIHt9XG4gIHNob3dNZXRyaWNzKCk7XG59XG5cbi8vIFRoZW1lICYgZGVuc2l0eS5cblxuZnVuY3Rpb24gYXBwbHlUaGVtZShjaG9pY2U6IHN0cmluZykge1xuICBjb25zdCByb290ID0gZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50O1xuICBpZiAoY2hvaWNlID09PSBcImRhcmtcIiB8fCBjaG9pY2UgPT09IFwibGlnaHRcIikgcm9vdC5kYXRhc2V0LnRoZW1lID0gY2hvaWNlO1xuICBlbHNlIGRlbGV0ZSByb290LmRhdGFzZXQudGhlbWU7XG4gIGNvbnN0IGRhcmsgPSBjaG9pY2UgPT09IFwiZGFya1wiIHx8IChjaG9pY2UgIT09IFwibGlnaHRcIiAmJiBtYXRjaE1lZGlhKFwiKHByZWZlcnMtY29sb3Itc2NoZW1lOiBkYXJrKVwiKS5tYXRjaGVzKTtcbiAgY29uc3QgbWV0YSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwidGhlbWUtY29sb3JcIik7XG4gIGlmIChtZXRhKSBtZXRhLnNldEF0dHJpYnV0ZShcImNvbnRlbnRcIiwgZGFyayA/IFwiIzBlMGYwZlwiIDogXCIjZjZmNWYwXCIpO1xuICBmb3IgKGNvbnN0IGJ0biBvZiBBcnJheS5mcm9tKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiI3RoZW1lLXBpY2tlciBidXR0b25cIikpKSB7XG4gICAgYnRuLmNsYXNzTGlzdC50b2dnbGUoXCJvblwiLCBidG4uZGF0YXNldC50aGVtZSA9PT0gKGNob2ljZSB8fCBcInN5c3RlbVwiKSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gYXBwbHlEZW5zaXR5KGNob2ljZTogc3RyaW5nIHwgbnVsbCkge1xuICBjb25zdCBkZW5zaXR5ID0gbm9ybWFsaXplRGVuc2l0eShjaG9pY2UpO1xuICBjb25zdCByb290ID0gZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50O1xuICBpZiAoZGVuc2l0eSA9PT0gXCJjb21mb3J0YWJsZVwiKSByb290LmRhdGFzZXQuZGVuc2l0eSA9IFwiY29tZm9ydGFibGVcIjtcbiAgZWxzZSBkZWxldGUgcm9vdC5kYXRhc2V0LmRlbnNpdHk7XG4gIGZvciAoY29uc3QgYnRuIG9mIEFycmF5LmZyb20oZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MQnV0dG9uRWxlbWVudD4oXCIjZGVuc2l0eS1waWNrZXIgYnV0dG9uXCIpKSkge1xuICAgIGJ0bi5jbGFzc0xpc3QudG9nZ2xlKFwib25cIiwgYnRuLmRhdGFzZXQuZGVuc2l0eSA9PT0gZGVuc2l0eSk7XG4gIH1cbiAgcmVxdWVzdEFuaW1hdGlvbkZyYW1lKCgpID0+IHVwZGF0ZUFsbFJlc3VsdENsYW1waW5nKCkpO1xufVxuXG4vLyBUaGUgc2NyZWVuLlxuXG5mdW5jdGlvbiBzZXRDYWxsQnV0dG9uKGxpdmU6IGJvb2xlYW4pIHtcbiAgY29uc3QgYnRuID0gJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJjYWxsXCIpO1xuICBidG4uY2xhc3NMaXN0LnRvZ2dsZShcImxpdmVcIiwgbGl2ZSk7XG4gIGNvbnN0IGxhYmVsID0gYnRuLnF1ZXJ5U2VsZWN0b3IoXCIuY2FsbC1sYWJlbFwiKTtcbiAgaWYgKGxhYmVsKSBsYWJlbC50ZXh0Q29udGVudCA9IGxpdmUgPyBcIkhhbmcgdXBcIiA6IFwiQ2FsbFwiO1xufVxuXG5mdW5jdGlvbiBzeW5jUmVzdW1lQnV0dG9ucyhzaG93OiBib29sZWFuKSB7XG4gICQoXCJyZXN1bWVcIikuaGlkZGVuID0gIXNob3c7XG4gICQoXCJoZXJvLXJlc3VtZVwiKS5oaWRkZW4gPSAhc2hvdztcbn1cblxuZnVuY3Rpb24gc3luY0NvbXBvc2VyKCkge1xuICBjb25zdCBpbnB1dCA9ICQ8SFRNTElucHV0RWxlbWVudD4oXCJ0ZXh0XCIpO1xuICBjb25zdCB0cmltbWVkID0gaW5wdXQudmFsdWUudHJpbSgpO1xuICAkKFwic2VuZGJ0blwiKS5jbGFzc0xpc3QudG9nZ2xlKFwicmVhZHlcIiwgdHJpbW1lZC5sZW5ndGggPiAwKTtcbiAgY29uc3QgcGFyc2VkID0gcGFyc2VQcmVmaXgodHJpbW1lZCk7XG4gICQoXCJtb2RlLXdyYXBcIikuZGF0YXNldC5tb2RlID0gcGFyc2VkLm1vZGUgPz8gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJtb2RlXCIpLnZhbHVlO1xufVxuXG5mdW5jdGlvbiBmb3JtYXRDbG9jayhzZWNvbmRzOiBudW1iZXIpOiBzdHJpbmcge1xuICBjb25zdCB0b3RhbCA9IE1hdGgubWF4KDAsIE1hdGguZmxvb3Ioc2Vjb25kcykpO1xuICBjb25zdCBoID0gTWF0aC5mbG9vcih0b3RhbCAvIDM2MDApO1xuICBjb25zdCBtID0gTWF0aC5mbG9vcigodG90YWwgJSAzNjAwKSAvIDYwKTtcbiAgY29uc3QgcyA9IHRvdGFsICUgNjA7XG4gIGNvbnN0IHBhZCA9IChuOiBudW1iZXIpID0+IFN0cmluZyhuKS5wYWRTdGFydCgyLCBcIjBcIik7XG4gIHJldHVybiBoID4gMCA/IGAke2h9OiR7cGFkKG0pfToke3BhZChzKX1gIDogYCR7cGFkKG0pfToke3BhZChzKX1gO1xufVxuXG5jb25zdCBWSVpfV0VJR0hUUyA9IFswLjQ4LCAwLjg2LCAxLjAsIDAuNzgsIDAuNDRdO1xuZnVuY3Rpb24gdXBkYXRlVmlzdWFsaXplcihtb2RlOiBzdHJpbmcsIGxldmVsOiBudW1iZXIpIHtcbiAgY29uc3Qgdml6ID0gJChcInZpelwiKTtcbiAgdml6LmRhdGFzZXQubW9kZSA9IG1vZGU7XG4gIGNvbnN0IGJhcnMgPSB2aXouY2hpbGRyZW47XG4gIGlmIChtb2RlID09PSBcImxpc3RlbmluZ1wiIHx8IG1vZGUgPT09IFwid29ya2luZ1wiKSB7XG4gICAgY29uc3QgZW5lcmd5ID0gTWF0aC5taW4oMSwgbGV2ZWwgKiAxNCk7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBiYXJzLmxlbmd0aDsgaSsrKSB7XG4gICAgICBjb25zdCBoID0gMC4yNCArIGVuZXJneSAqIFZJWl9XRUlHSFRTW2ldICogMC43NjtcbiAgICAgIChiYXJzW2ldIGFzIEhUTUxFbGVtZW50KS5zdHlsZS50cmFuc2Zvcm0gPSBgc2NhbGVZKCR7aC50b0ZpeGVkKDIpfSlgO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGJhcnMubGVuZ3RoOyBpKyspIChiYXJzW2ldIGFzIEhUTUxFbGVtZW50KS5zdHlsZS50cmFuc2Zvcm0gPSBcIlwiO1xuICB9XG59XG5cbi8qKiBBIHN5c3RlbSBub3RpZmljYXRpb24gd2hpbGUgdGhlIHBhZ2UgaXMgaGlkZGVuOiBhIHRhc2sgZmluaXNoZWQsIG9yIG9uZSBuZWVkcyB0aGUgdXNlci4gKi9cbmZ1bmN0aW9uIG5vdGlmeSh0aXRsZTogc3RyaW5nLCBib2R5OiBzdHJpbmcpIHtcbiAgaWYgKCFkb2N1bWVudC5oaWRkZW4gfHwgIShcIk5vdGlmaWNhdGlvblwiIGluIHdpbmRvdykgfHwgTm90aWZpY2F0aW9uLnBlcm1pc3Npb24gIT09IFwiZ3JhbnRlZFwiKSByZXR1cm47XG4gIHRyeSB7XG4gICAgY29uc3QgbiA9IG5ldyBOb3RpZmljYXRpb24odGl0bGUsIHsgYm9keTogYm9keS5zbGljZSgwLCAxODApLCBpY29uOiBcIi93ZWIvaWNvbnMvaWNvbi0xOTIucG5nXCIsIHRhZzogdGl0bGUgfSk7XG4gICAgbi5vbmNsaWNrID0gKCkgPT4geyB3aW5kb3cuZm9jdXMoKTsgbi5jbG9zZSgpOyB9O1xuICB9IGNhdGNoIHtcbiAgICAvLyBQaG9uZXMgd2FudCBub3RpZmljYXRpb25zIGZyb20gYSBzZXJ2aWNlIHdvcmtlcjsgdGhlIHBhZ2UgaGFzIG5vbmUuXG4gIH1cbn1cblxuZnVuY3Rpb24gdG9hc3QodGV4dDogc3RyaW5nKSB7XG4gIGNvbnN0IHQgPSAkKFwidG9hc3RcIik7XG4gIHQudGV4dENvbnRlbnQgPSB0ZXh0O1xuICB0LmNsYXNzTGlzdC5hZGQoXCJvblwiKTtcbiAgY2xlYXJUaW1lb3V0KCh0b2FzdCBhcyBhbnkpLnRpbWVyKTtcbiAgKHRvYXN0IGFzIGFueSkudGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHQuY2xhc3NMaXN0LnJlbW92ZShcIm9uXCIpLCAxODAwKTtcbn1cblxuZnVuY3Rpb24gbG9nKGtpbmQ6IHN0cmluZywgdGV4dDogc3RyaW5nLCBjbHMgPSBcIlwiKSB7XG4gIGNvbnN0IHBhbmUgPSAkKFwibG9nXCIpO1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gYHJvdyAke2Nsc31gO1xuICByb3cuaW5uZXJIVE1MID0gYDxzcGFuIGNsYXNzPVwidFwiPiR7KG5vdygpIC0gc3RhcnRlZEF0KS50b0ZpeGVkKDIpfTwvc3Bhbj48c3BhbiBjbGFzcz1cImtcIj4ke2tpbmR9PC9zcGFuPmA7XG4gIGNvbnN0IGJvZHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgYm9keS5jbGFzc05hbWUgPSBcImJcIjtcbiAgYm9keS50ZXh0Q29udGVudCA9IHRleHQ7XG4gIHJvdy5hcHBlbmQoYm9keSk7XG4gIGNvbnN0IHN0aWNrID0gcGFuZS5zY3JvbGxUb3AgKyBwYW5lLmNsaWVudEhlaWdodCA+PSBwYW5lLnNjcm9sbEhlaWdodCAtIDMwO1xuICBwYW5lLmFwcGVuZChyb3cpO1xuICB3aGlsZSAocGFuZS5jaGlsZEVsZW1lbnRDb3VudCA+IDMwMDApIHBhbmUuZmlyc3RFbGVtZW50Q2hpbGQhLnJlbW92ZSgpO1xuICBpZiAoc3RpY2spIHBhbmUuc2Nyb2xsVG9wID0gcGFuZS5zY3JvbGxIZWlnaHQ7XG59XG5cbi8qKiBBIGZyYW1lIGZyb20gb3IgdG8gR2VtaW5pLCB3aXRoIGF1ZGlvIGN1dCBvdXQsIHNob3J0IGVub3VnaCB0byByZWFkLiAqL1xuZnVuY3Rpb24gYnJpZWYoZGF0YTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGRhdGEucmVwbGFjZSgvXCJkYXRhXCI6XCJbQS1aYS16MC05Ky89XXs0MCx9XCIvZywgKG0pID0+IGBcImRhdGFcIjpcIlx1MjAyNiR7TWF0aC5yb3VuZCgoKG0ubGVuZ3RoIC0gOSkgKiAzKSAvIDQpfSBieXRlc1wiYCkuc2xpY2UoMCwgNjAwKTtcbn1cblxuZnVuY3Rpb24gZXNjYXBlSHRtbCh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdGV4dC5yZXBsYWNlKC9bJjw+XCInXS9nLCAoYykgPT4gKHsgXCImXCI6IFwiJmFtcDtcIiwgXCI8XCI6IFwiJmx0O1wiLCBcIj5cIjogXCImZ3Q7XCIsICdcIic6IFwiJnF1b3Q7XCIsIFwiJ1wiOiBcIiYjMzk7XCIgfSlbY10hKTtcbn1cblxuLyoqIEEgbGl0dGxlIE1hcmtkb3duLCBzYWZlbHk6IGNvZGUsIGJvbGQsIGxpbmtzLCBsaXN0cyBhbmQgaGVhZGluZ3MsIHRoZSByZXN0IGFzIHRleHQuICovXG5mdW5jdGlvbiBtYXJrZG93bih0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBibG9ja3MgPSBlc2NhcGVIdG1sKHRleHQudHJpbSgpKS5zcGxpdCgvYGBgKD86XFx3Kyk/XFxuPy8pO1xuICByZXR1cm4gYmxvY2tzLm1hcCgoYmxvY2ssIGkpID0+IHtcbiAgICBpZiAoaSAlIDIgPT09IDEpIHJldHVybiBgPHByZT48Y29kZT4ke2Jsb2NrLnJlcGxhY2UoL1xcbiQvLCBcIlwiKX08L2NvZGU+PC9wcmU+YDtcbiAgICBjb25zdCBpbmxpbmUgPSAoczogc3RyaW5nKSA9PiBzXG4gICAgICAucmVwbGFjZSgvYChbXmBcXG5dKylgL2csIFwiPGNvZGU+JDE8L2NvZGU+XCIpXG4gICAgICAucmVwbGFjZSgvXFwqXFwqKFteKlxcbl0rKVxcKlxcKi9nLCBcIjxiPiQxPC9iPlwiKVxuICAgICAgLnJlcGxhY2UoL1xcWyhbXlxcXVxcbl0rKVxcXVxcKChodHRwcz86XFwvXFwvW15cXHMpXSspXFwpL2csICc8YSBocmVmPVwiJDJcIiB0YXJnZXQ9XCJfYmxhbmtcIiByZWw9XCJub29wZW5lclwiPiQxPC9hPicpXG4gICAgICAucmVwbGFjZSgvKF58W1xccyhdKShodHRwcz86XFwvXFwvW15cXHM8KV0rKS9nLCAnJDE8YSBocmVmPVwiJDJcIiB0YXJnZXQ9XCJfYmxhbmtcIiByZWw9XCJub29wZW5lclwiPiQyPC9hPicpO1xuICAgIGxldCBodG1sID0gXCJcIjtcbiAgICBsZXQgbGlzdDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gICAgZm9yIChjb25zdCByYXcgb2YgYmxvY2suc3BsaXQoXCJcXG5cIikpIHtcbiAgICAgIGNvbnN0IGl0ZW0gPSByYXcubWF0Y2goL15cXHMqKD86Wy0qXHUyMDIyXXwoXFxkKylbLildKVxccysoLiopJC8pO1xuICAgICAgaWYgKGl0ZW0pIHtcbiAgICAgICAgY29uc3Qga2luZCA9IGl0ZW1bMV0gPyBcIm9sXCIgOiBcInVsXCI7XG4gICAgICAgIGlmIChsaXN0ICE9PSBraW5kKSB7IGlmIChsaXN0KSBodG1sICs9IGA8LyR7bGlzdH0+YDsgaHRtbCArPSBgPCR7a2luZH0+YDsgbGlzdCA9IGtpbmQ7IH1cbiAgICAgICAgaHRtbCArPSBgPGxpPiR7aW5saW5lKGl0ZW1bMl0pfTwvbGk+YDtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBpZiAobGlzdCkgeyBodG1sICs9IGA8LyR7bGlzdH0+YDsgbGlzdCA9IG51bGw7IH1cbiAgICAgIGNvbnN0IGhlYWRpbmcgPSByYXcubWF0Y2goL14jezEsNn1cXHMrKC4qKSQvKTtcbiAgICAgIGh0bWwgKz0gaGVhZGluZyA/IGA8ZGl2IGNsYXNzPVwibWQtaFwiPiR7aW5saW5lKGhlYWRpbmdbMV0pfTwvZGl2PmAgOiByYXcudHJpbSgpID09PSBcIlwiID8gXCI8YnI+XCIgOiBgJHtpbmxpbmUocmF3KX08YnI+YDtcbiAgICB9XG4gICAgaWYgKGxpc3QpIGh0bWwgKz0gYDwvJHtsaXN0fT5gO1xuICAgIHJldHVybiBodG1sLnJlcGxhY2UoLyg8YnI+KSskLywgXCJcIik7XG4gIH0pLmpvaW4oXCJcIik7XG59XG5cbmNvbnN0IHRyYW5zY3JpcHRTY3JvbGwgPSBuZXcgQXV0b1Njcm9sbGVyKCQoXCJ0cmFuc2NyaXB0XCIpLCB7XG4gIG9uSnVtcENoYW5nZTogKHNob3cpID0+IHsgJChcImp1bXBib3R0b21cIikuaGlkZGVuID0gIXNob3c7IH0sXG4gIGlzRW1wdHk6ICgpID0+ICEkKFwiZW1wdHlcIikuaGlkZGVuLFxufSk7XG5cbmZ1bmN0aW9uIHNjcm9sbERvd24oZm9yY2UgPSBmYWxzZSkge1xuICB0cmFuc2NyaXB0U2Nyb2xsLm9uQ29udGVudChmb3JjZSk7XG59XG5cbi8qKiBUaGUgY29yZSdzIG51bWJlciBmb3IgdGhlIGxpbmUgdGhlIGxhc3Qgcm93IHNob3dzLCB1bnRpbCBhbm90aGVyIHJvdyBmb2xsb3dzIGl0LiAqL1xubGV0IG9wZW5MaW5lOiBudW1iZXIgfCBudWxsID0gbnVsbDtcblxuLyoqIFdvcmRzIGdvIG9uIHRoZSByb3cgdGhlIGNvcmUgc2F5cyB0aGV5IGJlbG9uZyB0bzogaXQgc3RhcnRzIGEgbmV3IGxpbmUgZm9yIGVhY2ggdHVybiwgaG93ZXZlciBsb25nIHRoZSBnYXAuICovXG5mdW5jdGlvbiB0cmFuc2NyaXB0KHJvbGU6IFwidXNlclwiIHwgXCJhc3Npc3RhbnRcIiwgdGV4dDogc3RyaW5nLCBsaW5lOiBudW1iZXIpIHtcbiAgJChcImVtcHR5XCIpLmhpZGRlbiA9IHRydWU7XG4gIGNvbnN0IHBhbmUgPSAkKFwidHJhbnNjcmlwdFwiKTtcbiAgY29uc3QgbGFzdCA9IHBhbmUubGFzdEVsZW1lbnRDaGlsZCBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gIGlmIChvcGVuTGluZSA9PT0gbGluZSAmJiBsYXN0ICYmIGxhc3QuZGF0YXNldC5yb2xlID09PSByb2xlKSBsYXN0LnF1ZXJ5U2VsZWN0b3IoXCIudGV4dFwiKSEudGV4dENvbnRlbnQgKz0gdGV4dDtcbiAgZWxzZSB7XG4gICAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICByb3cuY2xhc3NOYW1lID0gYGxpbmUgJHtyb2xlfWA7XG4gICAgcm93LmRhdGFzZXQucm9sZSA9IHJvbGU7XG4gICAgcm93LmlubmVySFRNTCA9IGA8c3BhbiBjbGFzcz1cIndob1wiPiR7cm9sZSA9PT0gXCJ1c2VyXCIgPyBcIllvdVwiIDogXCJHZW1pbmlcIn08L3NwYW4+PHNwYW4gY2xhc3M9XCJ0ZXh0XCI+PC9zcGFuPmA7XG4gICAgcm93LnF1ZXJ5U2VsZWN0b3IoXCIudGV4dFwiKSEudGV4dENvbnRlbnQgPSB0ZXh0LnRyaW1TdGFydCgpO1xuICAgIHBhbmUuYXBwZW5kKHJvdyk7XG4gICAgb3BlbkxpbmUgPSBsaW5lO1xuICB9XG4gIHNjcm9sbERvd24oKTtcbn1cblxuLyoqXG4gKiBUaGUgd29yZHMgdGhlIHVzZXIgaXMgc2F5aW5nLCBiZWZvcmUgdGhlIG1vZGVsIGhhcyB0cmFuc2NyaWJlZCB0aGVtOiBhIGZhaW50IHJvdyB0aGF0IHN0YXlzIGxhc3RcbiAqIG9uIHNjcmVlbiAoaXRzIENTUyBgb3JkZXJgKSBhbmQgZmlyc3QgaW4gdGhlIHBhbmUsIHNvIHRoZSBsaW5lcyBhZnRlciBpdCBqb2luIHVwIGFzIGJlZm9yZS5cbiAqL1xuZnVuY3Rpb24gY2FwdGlvbih0ZXh0OiBzdHJpbmcgfCBudWxsKSB7XG4gIGNvbnN0IHBhbmUgPSAkKFwidHJhbnNjcmlwdFwiKTtcbiAgbGV0IHJvdyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwiY2FwdGlvblwiKTtcbiAgaWYgKHRleHQgPT0gbnVsbCkgeyByb3c/LnJlbW92ZSgpOyBzY3JvbGxEb3duKCk7IHJldHVybjsgfVxuICAkKFwiZW1wdHlcIikuaGlkZGVuID0gdHJ1ZTtcbiAgaWYgKCFyb3cpIHtcbiAgICByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIHJvdy5pZCA9IFwiY2FwdGlvblwiO1xuICAgIHJvdy5jbGFzc05hbWUgPSBcImxpbmUgdXNlciBjYXB0aW9uXCI7XG4gICAgcm93LmlubmVySFRNTCA9IGA8c3BhbiBjbGFzcz1cIndob1wiPllvdTwvc3Bhbj48c3BhbiBjbGFzcz1cInRleHRcIj48L3NwYW4+YDtcbiAgICBwYW5lLnByZXBlbmQocm93KTtcbiAgfVxuICByb3cucXVlcnlTZWxlY3RvcihcIi50ZXh0XCIpIS50ZXh0Q29udGVudCA9IHRleHQ7XG4gIHNjcm9sbERvd24oKTtcbn1cblxuZnVuY3Rpb24gbm90ZSh0ZXh0OiBzdHJpbmcpIHtcbiAgJChcImVtcHR5XCIpLmhpZGRlbiA9IHRydWU7XG4gIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvdy5jbGFzc05hbWUgPSBcImxpbmUgbm90ZVwiO1xuICByb3cudGV4dENvbnRlbnQgPSB0ZXh0O1xuICAkKFwidHJhbnNjcmlwdFwiKS5hcHBlbmQocm93KTtcbiAgb3BlbkxpbmUgPSBudWxsO1xuICBzY3JvbGxEb3duKCk7XG59XG5cbi8vIEFnZW50IGhhbmRvZmYgcmVzdWx0czogY29tcGFjdCAxLWxpbmUgcmVmZXJlbmNlIGluIHRoZSB2b2ljZSBzdHJlYW0gKyBmdWxsIGNvbGxhcHNpYmxlIGNhcmQgaW4gdGhlIHJpZ2h0IHBhbmUuXG5cbmZ1bmN0aW9uIHJlc3VsdENsYW1wUHgoZWw6IEhUTUxFbGVtZW50KTogbnVtYmVyIHtcbiAgY29uc3QgcmF3ID0gZ2V0Q29tcHV0ZWRTdHlsZShlbCkuZ2V0UHJvcGVydHlWYWx1ZShcIi0tcmVzLWNsYW1wLW1heFwiKS50cmltKCk7XG4gIGNvbnN0IG4gPSBOdW1iZXIucGFyc2VGbG9hdChyYXcpO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pICYmIG4gPiAwID8gbiA6IDY0O1xufVxuXG5mdW5jdGlvbiBzeW5jRXhwYW5kQWxsQnV0dG9uKCkge1xuICBjb25zdCBjbGFtcGVkID0gWy4uLnJlc3VsdHMudmFsdWVzKCldLmZpbHRlcigocikgPT4gci5jYXJkLmNsYXNzTGlzdC5jb250YWlucyhcImNsYW1wZWRcIikpO1xuICBjb25zdCBidG4gPSAkPEhUTUxCdXR0b25FbGVtZW50PihcInRvZ2dsZS1hbGwtcmVzdWx0c1wiKTtcbiAgYnRuLmhpZGRlbiA9IGNsYW1wZWQubGVuZ3RoID09PSAwO1xuICBpZiAoY2xhbXBlZC5sZW5ndGggPT09IDApIHJldHVybjtcbiAgY29uc3QgYW55Q29sbGFwc2VkID0gY2xhbXBlZC5zb21lKChyKSA9PiAhci5jYXJkLmNsYXNzTGlzdC5jb250YWlucyhcIm9wZW5cIikpO1xuICBidG4udGV4dENvbnRlbnQgPSBhbnlDb2xsYXBzZWQgPyBcIkV4cGFuZCBhbGxcIiA6IFwiQ29sbGFwc2UgYWxsXCI7XG59XG5cbmZ1bmN0aW9uIHNldFJlc3VsdE9wZW4oZW50cnk6IFJlc3VsdEVudHJ5LCBvcGVuOiBib29sZWFuKSB7XG4gIGNvbnN0IGNsYW1wZWQgPSBlbnRyeS5jYXJkLmNsYXNzTGlzdC5jb250YWlucyhcImNsYW1wZWRcIik7XG4gIGNvbnN0IG5leHQgPSBjbGFtcGVkICYmIG9wZW47XG4gIGVudHJ5LmNhcmQuY2xhc3NMaXN0LnRvZ2dsZShcIm9wZW5cIiwgbmV4dCk7XG4gIGVudHJ5LmhlYWQuc2V0QXR0cmlidXRlKFwiYXJpYS1leHBhbmRlZFwiLCBTdHJpbmcoIWNsYW1wZWQgfHwgbmV4dCkpO1xuICBlbnRyeS5tb3JlQnRuLnRleHRDb250ZW50ID0gbmV4dCA/IFwiU2hvdyBsZXNzXCIgOiBcIlNob3cgbW9yZVwiO1xuICBzeW5jRXhwYW5kQWxsQnV0dG9uKCk7XG59XG5cbmZ1bmN0aW9uIHVwZGF0ZVJlc3VsdENsYW1waW5nKGVudHJ5OiBSZXN1bHRFbnRyeSkge1xuICBpZiAoZW50cnkuYm9keS5vZmZzZXRQYXJlbnQgPT09IG51bGwpIHJldHVybjtcbiAgLy8gVW5jbGFtcGVkIGNhcmRzIGhhdmUgbm8gbWF4LWhlaWdodCwgc28gc2Nyb2xsSGVpZ2h0IGlzIGFsd2F5cyB0aGUgZnVsbCBuYXR1cmFsIGhlaWdodC5cbiAgY29uc3Qgb3ZlcmZsb3dzID0gZW50cnkuYm9keS5zY3JvbGxIZWlnaHQgPiByZXN1bHRDbGFtcFB4KGVudHJ5LmNhcmQpICsgNDtcbiAgZW50cnkuY2FyZC5jbGFzc0xpc3QudG9nZ2xlKFwiY2xhbXBlZFwiLCBvdmVyZmxvd3MpO1xuICBpZiAoIW92ZXJmbG93cykgZW50cnkuY2FyZC5jbGFzc0xpc3QucmVtb3ZlKFwib3BlblwiKTtcbiAgZW50cnkubW9yZUJ0bi5oaWRkZW4gPSAhb3ZlcmZsb3dzO1xuICBjb25zdCBpc09wZW4gPSBlbnRyeS5jYXJkLmNsYXNzTGlzdC5jb250YWlucyhcIm9wZW5cIik7XG4gIGVudHJ5Lm1vcmVCdG4udGV4dENvbnRlbnQgPSBpc09wZW4gPyBcIlNob3cgbGVzc1wiIDogXCJTaG93IG1vcmVcIjtcbiAgZW50cnkuaGVhZC5zZXRBdHRyaWJ1dGUoXCJhcmlhLWV4cGFuZGVkXCIsIFN0cmluZyghb3ZlcmZsb3dzIHx8IGlzT3BlbikpO1xufVxuXG5mdW5jdGlvbiB1cGRhdGVBbGxSZXN1bHRDbGFtcGluZygpIHtcbiAgZm9yIChjb25zdCBlbnRyeSBvZiByZXN1bHRzLnZhbHVlcygpKSB1cGRhdGVSZXN1bHRDbGFtcGluZyhlbnRyeSk7XG4gIHN5bmNFeHBhbmRBbGxCdXR0b24oKTtcbn1cblxuZnVuY3Rpb24gc3luY1Jlc3VsdEZvbGxvd1VwQnV0dG9ucygpIHtcbiAgZm9yIChjb25zdCBlbnRyeSBvZiByZXN1bHRzLnZhbHVlcygpKSB7XG4gICAgaWYgKCFlbnRyeS5mb2xsb3dCdG4pIGNvbnRpbnVlO1xuICAgIGNvbnN0IGNhbkZvbGxvdyA9IGNhbkZvbGxvd1VwUmVzdWx0KGVudHJ5LnNlc3Npb25JZCwgYWN0aXZlU2Vzc2lvbiwgQm9vbGVhbihlbnRyeS50YXNrSWQgJiYgdGFza3MuaGFzKGVudHJ5LnRhc2tJZCkpKTtcbiAgICBlbnRyeS5mb2xsb3dCdG4uaGlkZGVuID0gIWNhbkZvbGxvdztcbiAgICBpZiAoIWNhbkZvbGxvdykgZW50cnkuY2FyZC5xdWVyeVNlbGVjdG9yKFwiZm9ybVwiKT8ucmVtb3ZlKCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gY2xlYXJVbnJlYWRJZlJlc3VsdHNWaXNpYmxlKCkge1xuICBpZiAodW5yZWFkTW9iaWxlUmVzdWx0cyA9PT0gMCkgcmV0dXJuO1xuICBjb25zdCBkcmF3ZXJPcGVuID0gZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QuY29udGFpbnMoXCJ0YXNrcy1vcGVuXCIpO1xuICBpZiAoc2hvdWxkQ2xlYXJVbnJlYWRSZXN1bHRzKG1vYmlsZUxheW91dC5tYXRjaGVzLCBkcmF3ZXJPcGVuLCBzaWRlRmlsdGVyKSkge1xuICAgIHVucmVhZE1vYmlsZVJlc3VsdHMgPSAwO1xuICAgIHVwZGF0ZVRhc2tDaHJvbWUoKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBmb2N1c1Jlc3VsdChpZDogc3RyaW5nKSB7XG4gIGNvbnN0IGVudHJ5ID0gcmVzdWx0cy5nZXQoaWQpO1xuICBpZiAoIWVudHJ5KSByZXR1cm47XG4gIGlmIChzaWRlRmlsdGVyID09PSBcImFjdGl2ZVwiKSBzZXRTaWRlRmlsdGVyKFwiYWxsXCIpO1xuICBpZiAobW9iaWxlTGF5b3V0Lm1hdGNoZXMpIHNldFRhc2tzT3Blbih0cnVlKTtcbiAgcmVxdWVzdEFuaW1hdGlvbkZyYW1lKCgpID0+IHtcbiAgICB1cGRhdGVSZXN1bHRDbGFtcGluZyhlbnRyeSk7XG4gICAgaWYgKGVudHJ5LmNhcmQuY2xhc3NMaXN0LmNvbnRhaW5zKFwiY2xhbXBlZFwiKSkgc2V0UmVzdWx0T3BlbihlbnRyeSwgdHJ1ZSk7XG4gICAgZm9yIChjb25zdCByIG9mIHJlc3VsdHMudmFsdWVzKCkpIHIuY2FyZC5jbGFzc0xpc3QucmVtb3ZlKFwiZmxhc2hcIik7XG4gICAgdm9pZCBlbnRyeS5jYXJkLm9mZnNldFdpZHRoO1xuICAgIGVudHJ5LmNhcmQuY2xhc3NMaXN0LmFkZChcImZsYXNoXCIpO1xuICAgIGNsZWFyVGltZW91dChmbGFzaFRpbWVyKTtcbiAgICBmbGFzaFRpbWVyID0gd2luZG93LnNldFRpbWVvdXQoKCkgPT4gZW50cnkuY2FyZC5jbGFzc0xpc3QucmVtb3ZlKFwiZmxhc2hcIiksIDE0MDApO1xuICAgIGVudHJ5LmNhcmQuc2Nyb2xsSW50b1ZpZXcoeyBiZWhhdmlvcjogXCJzbW9vdGhcIiwgYmxvY2s6IFwibmVhcmVzdFwiIH0pO1xuICB9KTtcbn1cblxuZnVuY3Rpb24gcmVzdWx0KGFnZW50OiBzdHJpbmcsIGxhYmVsOiBzdHJpbmcsIHRleHQ6IHN0cmluZywgZmFpbGVkID0gZmFsc2UsIHRhc2tJZD86IHN0cmluZywgc2Vzc2lvbklkID0gYWN0aXZlU2Vzc2lvbik6IHN0cmluZyB7XG4gICQoXCJlbXB0eVwiKS5oaWRkZW4gPSB0cnVlO1xuICBjb25zdCBpZCA9IGByZXMtJHsrK25leHRSZXN1bHRTZXF9YDtcbiAgY29uc3Qgd2hvID0gYWdlbnQgPT09IFwidDNcIiA/IFwiVDNcIiA6IFwiSGVybWVzXCI7XG4gIGNvbnN0IGFnZW50Q2xzID0gYWdlbnQgPT09IFwidDNcIiA/IFwidDNcIiA6IFwiXCI7XG4gIGNvbnN0IHNuaXBwZXQgPSBwbGFpblByZXZpZXcodGV4dCwgMTYwKSB8fCBcIihlbXB0eSByZXNwb25zZSlcIjtcblxuICAvLyAxLiBDb21wYWN0IGlubGluZSBoYW5kb2ZmIG1hcmtlciBpbiB0aGUgdm9pY2UgdHJhbnNjcmlwdCBzbyBjaHJvbm9sb2dpY2FsIGNvbnRleHQgc3RheXMgaW50YWN0XG4gIC8vIHdpdGhvdXQgbXVsdGktcGFyYWdyYXBoIHJlc3BvbnNlcyBwdXNoaW5nIHZvaWNlIHR1cm5zIG9mZiBzY3JlZW4uXG4gIGNvbnN0IHJlZlJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIHJlZlJvdy50eXBlID0gXCJidXR0b25cIjtcbiAgcmVmUm93LmNsYXNzTmFtZSA9IGBsaW5lIGhhbmRvZmYgJHthZ2VudENsc30gJHtmYWlsZWQgPyBcImZhaWxlZFwiIDogXCJcIn1gLnRyaW0oKTtcbiAgcmVmUm93LmRhdGFzZXQucmVzdWx0SWQgPSBpZDtcbiAgcmVmUm93LmlubmVySFRNTCA9XG4gICAgYDxzcGFuIGNsYXNzPVwiYmFkZ2UgJHthZ2VudENsc31cIj4ke3dob308L3NwYW4+YCArXG4gICAgYDxzcGFuIGNsYXNzPVwiaGFuZG9mZi1sYWJlbFwiPiR7ZXNjYXBlSHRtbChsYWJlbCl9PC9zcGFuPmAgK1xuICAgIGA8c3BhbiBjbGFzcz1cImhhbmRvZmYtc25pcHBldFwiPiR7ZXNjYXBlSHRtbChzbmlwcGV0KX08L3NwYW4+YCArXG4gICAgYDxzcGFuIGNsYXNzPVwiaGFuZG9mZi1jdWVcIj4ke2ZhaWxlZCA/IFwiRmFpbGVkXCIgOiBcIk9wZW4gXHUyMTk3XCJ9PC9zcGFuPmA7XG4gIHJlZlJvdy5vbmNsaWNrID0gKCkgPT4gZm9jdXNSZXN1bHQoaWQpO1xuICAkKFwidHJhbnNjcmlwdFwiKS5hcHBlbmQocmVmUm93KTtcbiAgb3BlbkxpbmUgPSBudWxsO1xuICBzY3JvbGxEb3duKCk7XG5cbiAgLy8gMi4gVHJ1bmNhdGVkLCBleHBhbmRhYmxlIHJlc3VsdCBjYXJkIGluIHRoZSByaWdodC1oYW5kIEFnZW50IFdvcmtzcGFjZSAobmV3ZXN0IGZpcnN0KS5cbiAgY29uc3QgY2FyZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJhcnRpY2xlXCIpO1xuICBjYXJkLmNsYXNzTmFtZSA9IGByZXMtY2FyZCAke2FnZW50Q2xzfSAke2ZhaWxlZCA/IFwiZmFpbGVkXCIgOiBcIlwifWAudHJpbSgpO1xuICBjYXJkLmRhdGFzZXQucmVzdWx0SWQgPSBpZDtcblxuICBjb25zdCBoZWFkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgaGVhZC50eXBlID0gXCJidXR0b25cIjtcbiAgaGVhZC5jbGFzc05hbWUgPSBcInJlcy1oZWFkXCI7XG4gIGhlYWQuc2V0QXR0cmlidXRlKFwiYXJpYS1leHBhbmRlZFwiLCBcInRydWVcIik7XG4gIGhlYWQuaW5uZXJIVE1MID1cbiAgICBgPHNwYW4gY2xhc3M9XCJiYWRnZSAke2FnZW50Q2xzfVwiPiR7d2hvfTwvc3Bhbj5gICtcbiAgICBgPHNwYW4gY2xhc3M9XCJyZXMtbGFiZWxcIiB0aXRsZT1cIiR7ZXNjYXBlSHRtbChsYWJlbCl9XCI+JHtlc2NhcGVIdG1sKGxhYmVsKX08L3NwYW4+YCArXG4gICAgKGZhaWxlZCA/IGA8c3BhbiBjbGFzcz1cInJlcy1waWxsXCI+RmFpbGVkPC9zcGFuPmAgOiBcIlwiKSArXG4gICAgYDxzcGFuIGNsYXNzPVwicmVzLXRpbWVcIj4ke2Zvcm1hdFNob3J0VGltZShuZXcgRGF0ZSgpKX08L3NwYW4+YCArXG4gICAgYDxzcGFuIGNsYXNzPVwicmVzLWNoZXZcIiBhcmlhLWhpZGRlbj1cInRydWVcIj48L3NwYW4+YDtcblxuICBjb25zdCBib2R5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYm9keS5jbGFzc05hbWUgPSBcInJlcy1ib2R5XCI7XG4gIGJvZHkuaW5uZXJIVE1MID0gbWFya2Rvd24odGV4dCk7XG5cbiAgY29uc3QgZm9vdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGZvb3QuY2xhc3NOYW1lID0gXCJyZXMtZm9vdFwiO1xuXG4gIGNvbnN0IG1vcmVCdG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBtb3JlQnRuLnR5cGUgPSBcImJ1dHRvblwiO1xuICBtb3JlQnRuLmNsYXNzTmFtZSA9IFwicmVzLWFjdCBwcmltYXJ5XCI7XG4gIG1vcmVCdG4udGV4dENvbnRlbnQgPSBcIlNob3cgbW9yZVwiO1xuICBtb3JlQnRuLmhpZGRlbiA9IHRydWU7XG5cbiAgY29uc3QgY29weUJ0biA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIGNvcHlCdG4udHlwZSA9IFwiYnV0dG9uXCI7XG4gIGNvcHlCdG4uY2xhc3NOYW1lID0gXCJyZXMtYWN0XCI7XG4gIGNvcHlCdG4udGV4dENvbnRlbnQgPSBcIkNvcHlcIjtcbiAgY29weUJ0bi5vbmNsaWNrID0gKCkgPT4ge1xuICAgIHZvaWQgbmF2aWdhdG9yLmNsaXBib2FyZD8ud3JpdGVUZXh0KHRleHQpO1xuICAgIHRvYXN0KFwiUmVzdWx0IGNvcGllZFwiKTtcbiAgfTtcblxuICBmb290LmFwcGVuZChtb3JlQnRuLCBjb3B5QnRuKTtcblxuICBsZXQgZm9sbG93QnRuOiBIVE1MQnV0dG9uRWxlbWVudCB8IHVuZGVmaW5lZDtcbiAgaWYgKHRhc2tJZCkge1xuICAgIGZvbGxvd0J0biA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gICAgZm9sbG93QnRuLnR5cGUgPSBcImJ1dHRvblwiO1xuICAgIGZvbGxvd0J0bi5jbGFzc05hbWUgPSBcInJlcy1hY3RcIjtcbiAgICBmb2xsb3dCdG4udGV4dENvbnRlbnQgPSBcIkZvbGxvdyB1cFwiO1xuICAgIGZvbGxvd0J0bi5vbmNsaWNrID0gKCkgPT4ge1xuICAgICAgaWYgKCFjYW5Gb2xsb3dVcFJlc3VsdChzZXNzaW9uSWQsIGFjdGl2ZVNlc3Npb24sIHRhc2tzLmhhcyh0YXNrSWQpKSkge1xuICAgICAgICBzeW5jUmVzdWx0Rm9sbG93VXBCdXR0b25zKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHZpZXcgPSB0YXNrcy5nZXQodGFza0lkKTtcbiAgICAgIGlmICh2aWV3KSBmb2xsb3dVcEZvcm0oY2FyZCwgdmlldy5jLCBzZXNzaW9uSWQpO1xuICAgIH07XG4gICAgZm9vdC5hcHBlbmQoZm9sbG93QnRuKTtcbiAgfVxuXG4gIGNhcmQuYXBwZW5kKGhlYWQsIGJvZHksIGZvb3QpO1xuXG4gIGNvbnN0IGVudHJ5OiBSZXN1bHRFbnRyeSA9IHsgaWQsIGFnZW50LCBsYWJlbCwgdGV4dCwgZmFpbGVkLCB0YXNrSWQsIHNlc3Npb25JZCwgY2FyZCwgaGVhZCwgYm9keSwgbW9yZUJ0biwgZm9sbG93QnRuLCByZWZSb3cgfTtcbiAgY29uc3QgdG9nZ2xlID0gKCkgPT4ge1xuICAgIGlmICghZW50cnkuY2FyZC5jbGFzc0xpc3QuY29udGFpbnMoXCJjbGFtcGVkXCIpKSByZXR1cm47XG4gICAgc2V0UmVzdWx0T3BlbihlbnRyeSwgIWVudHJ5LmNhcmQuY2xhc3NMaXN0LmNvbnRhaW5zKFwib3BlblwiKSk7XG4gIH07XG4gIGhlYWQub25jbGljayA9IHRvZ2dsZTtcbiAgbW9yZUJ0bi5vbmNsaWNrID0gdG9nZ2xlO1xuXG4gIHJlc3VsdHMuc2V0KGlkLCBlbnRyeSk7XG4gICQoXCJyZXN1bHRzXCIpLnByZXBlbmQoY2FyZCk7XG4gIGNvbnN0IGRyYXdlck9wZW4gPSBkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5jb250YWlucyhcInRhc2tzLW9wZW5cIik7XG4gIGlmICghc2hvdWxkQ2xlYXJVbnJlYWRSZXN1bHRzKG1vYmlsZUxheW91dC5tYXRjaGVzLCBkcmF3ZXJPcGVuLCBzaWRlRmlsdGVyKSkgdW5yZWFkTW9iaWxlUmVzdWx0cysrO1xuXG4gIHN5bmNTaWRlTGF5b3V0KCk7XG4gIHVwZGF0ZVRhc2tDaHJvbWUoKTtcbiAgcmVxdWVzdEFuaW1hdGlvbkZyYW1lKCgpID0+IHtcbiAgICB1cGRhdGVSZXN1bHRDbGFtcGluZyhlbnRyeSk7XG4gICAgc3luY0V4cGFuZEFsbEJ1dHRvbigpO1xuICB9KTtcbiAgcmV0dXJuIGlkO1xufVxuXG5mdW5jdGlvbiBlbGFwc2VkKHNlY29uZHM6IG51bWJlcik6IHN0cmluZyB7XG4gIGlmIChzZWNvbmRzIDwgNjApIHJldHVybiBgJHtNYXRoLmZsb29yKHNlY29uZHMpfXNgO1xuICBjb25zdCBtID0gTWF0aC5mbG9vcihzZWNvbmRzIC8gNjApO1xuICByZXR1cm4gbSA8IDYwID8gYCR7bX1tICR7TWF0aC5mbG9vcihzZWNvbmRzICUgNjApfXNgIDogYCR7TWF0aC5mbG9vcihtIC8gNjApfWggJHttICUgNjB9bWA7XG59XG5cbi8qKiBUaGUgZW1wdHkgdGFzayBsaXN0J3Mgd29yZHMsIGtlcHQgdG8gcHV0IGJhY2suICovXG5jb25zdCBub1Rhc2tzID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJub3Rhc2tzXCIpITtcblxuLyoqIFdoZXRoZXIgYSB0YXNrIHN0aWxsIHdhbnRzIHRoZSBzY3JlZW46IGl0J3Mgd29ya2luZywgd2FpdGluZywgb3IgbmVlZHMgYXBwcm92YWwuIFRoZSByZXN0IGZvbGQgYXdheSB1bmRlciBGaW5pc2hlZC4gKi9cbmNvbnN0IGxpdmUgPSAoc3RhdGU6IHN0cmluZykgPT4gc3RhdGUgPT09IFwicnVubmluZ1wiIHx8IHN0YXRlLnN0YXJ0c1dpdGgoXCJ3YWl0aW5nXCIpO1xuY29uc3QgaXNBY3RpdmVUYXNrID0gKHZpZXc6IFRhc2tWaWV3KSA9PiBsaXZlKHZpZXcuYy5zdGF0ZSkgfHwgQm9vbGVhbih2aWV3LmFwcHJvdmFsKTtcblxuZnVuY3Rpb24gc2V0U2lkZUZpbHRlcihmaWx0ZXI6IFNpZGVGaWx0ZXIpIHtcbiAgc2lkZUZpbHRlciA9IG5vcm1hbGl6ZVNpZGVGaWx0ZXIoZmlsdGVyKTtcbiAgZm9yIChjb25zdCBidG4gb2YgQXJyYXkuZnJvbShkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxCdXR0b25FbGVtZW50PihcIiNzaWRlLXRhYnMgYnV0dG9uXCIpKSkge1xuICAgIGNvbnN0IG9uID0gYnRuLmRhdGFzZXQuZmlsdGVyID09PSBzaWRlRmlsdGVyO1xuICAgIGJ0bi5jbGFzc0xpc3QudG9nZ2xlKFwib25cIiwgb24pO1xuICAgIGJ0bi5zZXRBdHRyaWJ1dGUoXCJhcmlhLXByZXNzZWRcIiwgU3RyaW5nKG9uKSk7XG4gIH1cbiAgc3luY1NpZGVMYXlvdXQoKTtcbiAgY2xlYXJVbnJlYWRJZlJlc3VsdHNWaXNpYmxlKCk7XG4gIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB1cGRhdGVBbGxSZXN1bHRDbGFtcGluZygpKTtcbn1cblxuZnVuY3Rpb24gc3luY1NpZGVMYXlvdXQoKSB7XG4gIGNvbnN0IGFsbCA9IFsuLi50YXNrcy52YWx1ZXMoKV07XG4gIGNvbnN0IGFjdGl2ZUN1cnJlbnQgPSBhbGwuZmlsdGVyKGlzQWN0aXZlVGFzaykubGVuZ3RoO1xuICBjb25zdCBhY3RpdmVUb3RhbCA9IGFjdGl2ZUN1cnJlbnQgKyBlYXJsaWVyQWN0aXZlQ291bnQ7XG4gIGNvbnN0IHJlc3VsdHNUb3RhbCA9IHJlc3VsdHMuc2l6ZTtcbiAgY29uc3QgZWFybGllclNob3duID0gJChcImVhcmxpZXJcIikuY2hpbGRFbGVtZW50Q291bnQ7XG4gIGNvbnN0IGRvbmVUb3RhbCA9ICQoXCJkb25lbm93XCIpLmNoaWxkRWxlbWVudENvdW50ICsgJChcImRvbmVlYXJsaWVyXCIpLmNoaWxkRWxlbWVudENvdW50O1xuXG4gIGNvbnN0IHZpcyA9IHJlc29sdmVTaWRlU2VjdGlvbnMoc2lkZUZpbHRlciwge1xuICAgIGFjdGl2ZTogYWN0aXZlQ3VycmVudCxcbiAgICByZXN1bHRzOiByZXN1bHRzVG90YWwsXG4gICAgZWFybGllcjogZWFybGllclNob3duLFxuICAgIGRvbmU6IGRvbmVUb3RhbCxcbiAgfSk7XG5cbiAgJChcInRhc2tzLXNlY3Rpb25cIikuaGlkZGVuID0gIXZpcy5zaG93VGFza3NTZWN0aW9uO1xuICBub1Rhc2tzLmhpZGRlbiA9ICF2aXMuc2hvd0VtcHR5VGFza3M7XG4gICQoXCJyZXN1bHRzLXNlY3Rpb25cIikuaGlkZGVuID0gIXZpcy5zaG93UmVzdWx0c1NlY3Rpb247XG4gICQoXCJub3Jlc3VsdHNcIikuaGlkZGVuID0gIXZpcy5zaG93RW1wdHlSZXN1bHRzO1xuICAkKFwiZWFybGllcmJveFwiKS5oaWRkZW4gPSAhdmlzLnNob3dFYXJsaWVyU2VjdGlvbjtcbiAgJChcImRvbmVib3hcIikuaGlkZGVuID0gIXZpcy5zaG93RG9uZVNlY3Rpb247XG5cbiAgJChcInNpZGUtYWN0aXZlLW5cIikudGV4dENvbnRlbnQgPSBhY3RpdmVUb3RhbCA+IDAgPyBTdHJpbmcoYWN0aXZlVG90YWwpIDogXCJcIjtcbiAgJChcInNpZGUtcmVzdWx0cy1uXCIpLnRleHRDb250ZW50ID0gcmVzdWx0c1RvdGFsID4gMCA/IFN0cmluZyhyZXN1bHRzVG90YWwpIDogXCJcIjtcbiAgJChcInJlc3VsdHNjb3VudFwiKS50ZXh0Q29udGVudCA9IHJlc3VsdHNUb3RhbCA+IDAgPyBgXHUwMEI3ICR7cmVzdWx0c1RvdGFsfWAgOiBcIlwiO1xuICAkKFwiZG9uZWNvdW50XCIpLnRleHRDb250ZW50ID0gZG9uZVRvdGFsID4gMCA/IGBcdTAwQjcgJHtkb25lVG90YWx9YCA6IFwiXCI7XG4gIHN5bmNSZXN1bHRGb2xsb3dVcEJ1dHRvbnMoKTtcbn1cblxuZnVuY3Rpb24gdXBkYXRlVGFza0Nocm9tZSgpIHtcbiAgY29uc3QgYWxsID0gWy4uLnRhc2tzLnZhbHVlcygpXTtcbiAgY29uc3QgYWN0aXZlQ3VycmVudCA9IGFsbC5maWx0ZXIoaXNBY3RpdmVUYXNrKS5sZW5ndGg7XG4gIGNvbnN0IHdhaXRpbmcgPSBhbGwuZmlsdGVyKCh0KSA9PiB0LmMuc3RhdGUuc3RhcnRzV2l0aChcIndhaXRpbmdcIikgfHwgQm9vbGVhbih0LmFwcHJvdmFsKSkubGVuZ3RoO1xuICBjb25zdCBhY3RpdmVUb3RhbCA9IGFjdGl2ZUN1cnJlbnQgKyBlYXJsaWVyQWN0aXZlQ291bnQ7XG4gIGNvbnN0IGF0dGVudGlvblRvdGFsID0gd2FpdGluZyArIGVhcmxpZXJXYWl0aW5nQ291bnQ7XG4gIGNvbnN0IGJhZGdlQ291bnQgPSBhY3RpdmVUb3RhbCA+IDAgPyBhY3RpdmVUb3RhbCA6IHVucmVhZE1vYmlsZVJlc3VsdHM7XG5cbiAgY29uc3QgYmFkZ2UgPSAkKFwidGFza3MtYmFkZ2VcIik7XG4gIGJhZGdlLmhpZGRlbiA9IGJhZGdlQ291bnQgPT09IDA7XG4gIGJhZGdlLnRleHRDb250ZW50ID0gU3RyaW5nKGJhZGdlQ291bnQpO1xuICBiYWRnZS5jbGFzc0xpc3QudG9nZ2xlKFwid2FyblwiLCBhdHRlbnRpb25Ub3RhbCA+IDApO1xuXG4gIGNvbnN0IGJhciA9ICQoXCJtb2JpbGUtdGFza3MtYmFyXCIpO1xuICBjb25zdCBzaG93QmFyID0gYWN0aXZlVG90YWwgPiAwIHx8IHVucmVhZE1vYmlsZVJlc3VsdHMgPiAwO1xuICBiYXIuaGlkZGVuID0gIXNob3dCYXI7XG4gIGJhci5jbGFzc0xpc3QudG9nZ2xlKFwidmlzaWJsZVwiLCBzaG93QmFyKTtcbiAgYmFyLmNsYXNzTGlzdC50b2dnbGUoXCJ3YXJuXCIsIGF0dGVudGlvblRvdGFsID4gMCk7XG4gIGlmIChzaG93QmFyKSB7XG4gICAgY29uc3QgYXBwcm92YWwgPSBhbGwuZmluZCgodCkgPT4gdC5hcHByb3ZhbCk7XG4gICAgY29uc3QgbGFiZWwgPSBhcHByb3ZhbFxuICAgICAgPyBgQXBwcm92YWwgbmVlZGVkOiAke2FwcHJvdmFsLmMubGFiZWx9YFxuICAgICAgOiBhdHRlbnRpb25Ub3RhbCA+IDBcbiAgICAgICAgPyBgJHthdHRlbnRpb25Ub3RhbH0gdGFzayR7YXR0ZW50aW9uVG90YWwgPiAxID8gXCJzXCIgOiBcIlwifSB3YWl0aW5nIGZvciB5b3VgXG4gICAgICAgIDogYWN0aXZlVG90YWwgPiAwXG4gICAgICAgICAgPyBgJHthY3RpdmVUb3RhbH0gYWN0aXZlIHRhc2ske2FjdGl2ZVRvdGFsID4gMSA/IFwic1wiIDogXCJcIn1gXG4gICAgICAgICAgOiBgJHt1bnJlYWRNb2JpbGVSZXN1bHRzfSBuZXcgYWdlbnQgcmVzdWx0JHt1bnJlYWRNb2JpbGVSZXN1bHRzID4gMSA/IFwic1wiIDogXCJcIn1gO1xuICAgICQoXCJtdGItdGV4dFwiKS50ZXh0Q29udGVudCA9IGxhYmVsO1xuICB9XG59XG5cbmZ1bmN0aW9uIHNob3dUYXNrcyhmb3JjZSA9IGZhbHNlKSB7XG4gIGNvbnN0IHBhbmUgPSAkKFwidGFza3NcIik7XG4gIGNvbnN0IGRvbmUgPSAkKFwiZG9uZW5vd1wiKTtcbiAgY29uc3Qgb3BlbiA9IGRvY3VtZW50LmFjdGl2ZUVsZW1lbnQ/LmNsb3Nlc3Q/LihcIi50YXNrXCIpIGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgaWYgKCFmb3JjZSAmJiBvcGVuICYmIChwYW5lLmNvbnRhaW5zKG9wZW4pIHx8IGRvbmUuY29udGFpbnMob3BlbikpICYmIG9wZW4ucXVlcnlTZWxlY3RvcihcImZvcm1cIikpIHJldHVybjsgLy8gZG9uJ3QgcmVkcmF3IHVuZGVyIHNvbWVvbmUgdHlwaW5nIGEgZm9sbG93LXVwXG4gIHBhbmUuaW5uZXJIVE1MID0gXCJcIjtcbiAgZG9uZS5pbm5lckhUTUwgPSBcIlwiO1xuICBjb25zdCBhbGwgPSBbLi4udGFza3MudmFsdWVzKCldLnJldmVyc2UoKTtcbiAgaWYgKGFsbC5sZW5ndGggPT09IDApIHtcbiAgICBwYW5lLmFwcGVuZChub1Rhc2tzKTtcbiAgICAkKFwidGFza2NvdW50XCIpLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAkKFwiY2FuY2VsYWxsXCIpLmhpZGRlbiA9IHRydWU7XG4gICAgc3luY1NpZGVMYXlvdXQoKTtcbiAgICB1cGRhdGVUYXNrQ2hyb21lKCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHJ1bm5pbmcgPSBhbGwuZmlsdGVyKCh0KSA9PiB0LmMuc3RhdGUgPT09IFwicnVubmluZ1wiKS5sZW5ndGg7XG4gIGNvbnN0IGFjdGl2ZUNvdW50ID0gYWxsLmZpbHRlcihpc0FjdGl2ZVRhc2spLmxlbmd0aDtcbiAgJChcInRhc2tjb3VudFwiKS50ZXh0Q29udGVudCA9IHJ1bm5pbmcgPiAwID8gYCR7cnVubmluZ30gcnVubmluZ2AgOiBhY3RpdmVDb3VudCA+IDAgPyBgJHthY3RpdmVDb3VudH0gd2FpdGluZ2AgOiBcIlwiO1xuICAkKFwiY2FuY2VsYWxsXCIpLmhpZGRlbiA9ICFjYWxsSWQgfHwgcnVubmluZyA8IDI7XG4gIGZvciAoY29uc3QgdmlldyBvZiBhbGwpIHtcbiAgICBjb25zdCB0ID0gdmlldy5jO1xuICAgIGNvbnN0IHdhaXRpbmcgPSB0LnN0YXRlLnN0YXJ0c1dpdGgoXCJ3YWl0aW5nXCIpO1xuICAgIGNvbnN0IGNhcmQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGNhcmQuY2xhc3NOYW1lID0gYHRhc2sgJHt3YWl0aW5nID8gXCJ3YWl0aW5nXCIgOiB0LnN0YXRlfWA7XG4gICAgY29uc3QgYWdlID0gKHZpZXcuZW5kZWQgPz8gbm93KCkpIC0gdmlldy5zaW5jZTtcbiAgICBjYXJkLmlubmVySFRNTCA9XG4gICAgICBgPGRpdiBjbGFzcz1cIm1ldGEtcm93XCI+YCArXG4gICAgICAgIGA8c3BhbiBjbGFzcz1cImJhZGdlICR7dC5hZ2VudCA9PT0gXCJ0M1wiID8gXCJ0M1wiIDogXCJcIn1cIj4ke3QuYWdlbnQgPT09IFwidDNcIiA/IFwiVDNcIiA6IFwiSGVybWVzXCJ9PC9zcGFuPmAgK1xuICAgICAgICBgPHNwYW4gY2xhc3M9XCJsYWJlbFwiPjwvc3Bhbj5gICtcbiAgICAgICAgYDxzcGFuIGNsYXNzPVwic3RhdGVcIj4ke3Quc3RhdGUgPT09IFwicnVubmluZ1wiID8gJzxzcGFuIGNsYXNzPVwic3BpblwiPjwvc3Bhbj4nIDogXCJcIn0ke2VzY2FwZUh0bWwodC5zdGF0ZSl9PC9zcGFuPmAgK1xuICAgICAgICBgPHNwYW4gY2xhc3M9XCJhZ2VcIj4ke2VsYXBzZWQoYWdlKX08L3NwYW4+YCArXG4gICAgICBgPC9kaXY+YCArXG4gICAgICBgPGRpdiBjbGFzcz1cInBcIj48L2Rpdj5gO1xuICAgIGNvbnN0IGxhYmVsRWwgPSBjYXJkLnF1ZXJ5U2VsZWN0b3IoXCIubGFiZWxcIikgYXMgSFRNTEVsZW1lbnQ7XG4gICAgbGFiZWxFbC50ZXh0Q29udGVudCA9IHQubGFiZWw7XG4gICAgbGFiZWxFbC50aXRsZSA9IHQubGFiZWw7XG4gICAgY2FyZC5xdWVyeVNlbGVjdG9yKFwiLnBcIikhLnRleHRDb250ZW50ID0gdC5wcm9ncmVzcyA/PyB0LnJlcXVlc3Q7XG4gICAgaWYgKHQucXVlc3Rpb24pIHtcbiAgICAgIGNvbnN0IHEgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgICAgcS5jbGFzc05hbWUgPSBcInFcIjtcbiAgICAgIHEudGV4dENvbnRlbnQgPSBgQXNrczogJHt0LnF1ZXN0aW9ufWA7XG4gICAgICBjYXJkLmFwcGVuZChxKTtcbiAgICB9XG4gICAgaWYgKHZpZXcuYXBwcm92YWwgJiYgdC5zdGF0ZSA9PT0gXCJydW5uaW5nXCIpIHtcbiAgICAgIGNvbnN0IGJveCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICBib3guY2xhc3NOYW1lID0gXCJhcHByb3ZhbFwiO1xuICAgICAgYm94LmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPVwiYXBwcm92YWwtaGVhZFwiPkhlcm1lcyBhc2tzIHRvIHJ1bjwvZGl2Pjxjb2RlPjwvY29kZT48ZGl2IGNsYXNzPVwiYWN0c1wiPjwvZGl2PmA7XG4gICAgICBib3gucXVlcnlTZWxlY3RvcihcImNvZGVcIikhLnRleHRDb250ZW50ID0gdmlldy5hcHByb3ZhbC5jb21tYW5kO1xuICAgICAgY29uc3QgYW5zd2VyID0gKGNob2ljZTogXCJvbmNlXCIgfCBcImRlbnlcIikgPT4ge1xuICAgICAgICB2aWV3LmFwcHJvdmFsID0gdW5kZWZpbmVkO1xuICAgICAgICBzaG93VGFza3ModHJ1ZSk7XG4gICAgICAgIHZvaWQgZmV0Y2goXCIvaGVybWVzL2FwcHJvdmFsXCIsIHsgbWV0aG9kOiBcIlBPU1RcIiwgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBjYWxsOiBjYWxsTmFtZSwgdGFza0lkOiB0LmlkLCBjaG9pY2UgfSkgfSlcbiAgICAgICAgICAudGhlbigocikgPT4gdG9hc3Qoci5vayA/IChjaG9pY2UgPT09IFwib25jZVwiID8gXCJBcHByb3ZlZFwiIDogXCJEZW5pZWRcIikgOiBcIlRoYXQgYXBwcm92YWwgaGFkIGFscmVhZHkgbGFwc2VkXCIpKTtcbiAgICAgIH07XG4gICAgICBmb3IgKGNvbnN0IFtsYWJlbCwgY2hvaWNlXSBvZiBbW1wiQXBwcm92ZSBvbmNlXCIsIFwib25jZVwiXSwgW1wiRGVueVwiLCBcImRlbnlcIl1dIGFzIGNvbnN0KSB7XG4gICAgICAgIGNvbnN0IGIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICAgICAgICBiLnR5cGUgPSBcImJ1dHRvblwiO1xuICAgICAgICBiLnRleHRDb250ZW50ID0gbGFiZWw7XG4gICAgICAgIGlmIChjaG9pY2UgPT09IFwib25jZVwiKSBiLmNsYXNzTmFtZSA9IFwiZ29cIjtcbiAgICAgICAgZWxzZSBiLmNsYXNzTmFtZSA9IFwiZGFuZ2VyXCI7XG4gICAgICAgIGIub25jbGljayA9ICgpID0+IGFuc3dlcihjaG9pY2UpO1xuICAgICAgICBib3gucXVlcnlTZWxlY3RvcihcIi5hY3RzXCIpIS5hcHBlbmQoYik7XG4gICAgICB9XG4gICAgICBjYXJkLmFwcGVuZChib3gpO1xuICAgIH1cbiAgICBpZiAodC5zdGF0ZSAhPT0gXCJydW5uaW5nXCIpIHZpZXcuYXBwcm92YWwgPSB1bmRlZmluZWQ7XG4gICAgY29uc3QgYWN0cyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgYWN0cy5jbGFzc05hbWUgPSBcImFjdHNcIjtcbiAgICBjb25zdCBidXR0b24gPSAodGV4dDogc3RyaW5nLCBmbjogKCkgPT4gdm9pZCwgY2xzID0gXCJcIikgPT4ge1xuICAgICAgY29uc3QgYiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gICAgICBiLnR5cGUgPSBcImJ1dHRvblwiO1xuICAgICAgYi50ZXh0Q29udGVudCA9IHRleHQ7XG4gICAgICBpZiAoY2xzKSBiLmNsYXNzTmFtZSA9IGNscztcbiAgICAgIGIub25jbGljayA9IGZuO1xuICAgICAgYWN0cy5hcHBlbmQoYik7XG4gICAgICByZXR1cm4gYjtcbiAgICB9O1xuICAgIGlmIChjYWxsSWQgJiYgYWN0aXZlU2Vzc2lvbiA+IDApIHtcbiAgICAgIGNvbnN0IG9yaWdpblNlc3Npb24gPSBhY3RpdmVTZXNzaW9uO1xuICAgICAgYnV0dG9uKHdhaXRpbmcgPyBcIkFuc3dlclwiIDogXCJGb2xsb3cgdXBcIiwgKCkgPT4gZm9sbG93VXBGb3JtKGNhcmQsIHQsIG9yaWdpblNlc3Npb24pKTtcbiAgICAgIGlmICh0LnN0YXRlID09PSBcInJ1bm5pbmdcIikgYnV0dG9uKFwiQ2FuY2VsXCIsICgpID0+IHB1c2goeyB0eXBlOiBcImNhbmNlbFRhc2tcIiwgdGFzazogdC5pZCB9KSwgXCJkYW5nZXJcIik7XG4gICAgfVxuICAgIGlmICh2aWV3LnJlc3VsdElkKSBidXR0b24oXCJSZXN1bHRcIiwgKCkgPT4gZm9jdXNSZXN1bHQodmlldy5yZXN1bHRJZCEpKTtcbiAgICBpZiAodmlldy50aHJlYWQpIGJ1dHRvbihcIkNvcHkgaWRcIiwgKCkgPT4geyB2b2lkIG5hdmlnYXRvci5jbGlwYm9hcmQ/LndyaXRlVGV4dCh2aWV3LnRocmVhZCEpOyB0b2FzdChcIlRocmVhZCBpZCBjb3BpZWRcIik7IH0pO1xuICAgIGlmIChhY3RzLmNoaWxkRWxlbWVudENvdW50KSBjYXJkLmFwcGVuZChhY3RzKTtcbiAgICAoaXNBY3RpdmVUYXNrKHZpZXcpID8gcGFuZSA6IGRvbmUpLmFwcGVuZChjYXJkKTtcbiAgfVxuICBpZiAocGFuZS5jaGlsZEVsZW1lbnRDb3VudCA9PT0gMCkgcGFuZS5hcHBlbmQobm9UYXNrcyk7XG4gIHN5bmNTaWRlTGF5b3V0KCk7XG4gIHVwZGF0ZVRhc2tDaHJvbWUoKTtcbn1cblxuZnVuY3Rpb24gZm9sbG93VXBGb3JtKGNhcmQ6IEhUTUxFbGVtZW50LCB0OiBDb21tYW5kLCBvcmlnaW5TZXNzaW9uOiBudW1iZXIpIHtcbiAgY29uc3QgZXhpc3RpbmcgPSBjYXJkLnF1ZXJ5U2VsZWN0b3IoXCJmb3JtXCIpO1xuICBpZiAoZXhpc3RpbmcpIHsgZXhpc3RpbmcucXVlcnlTZWxlY3RvcihcImlucHV0XCIpPy5mb2N1cygpOyByZXR1cm47IH1cbiAgY29uc3QgZm9ybSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJmb3JtXCIpO1xuICBmb3JtLmNsYXNzTmFtZSA9IFwiZm9sbG93dXAtZm9ybVwiO1xuICBmb3JtLmlubmVySFRNTCA9IGA8aW5wdXQgdHlwZT1cInRleHRcIiBwbGFjZWhvbGRlcj1cIlRlbGwgXHUyMDFDJHtlc2NhcGVIdG1sKHQubGFiZWwpfVx1MjAxRFx1MjAyNlwiIGVudGVya2V5aGludD1cInNlbmRcIj48YnV0dG9uIHR5cGU9XCJzdWJtaXRcIj5TZW5kPC9idXR0b24+YDtcbiAgY29uc3QgaW5wdXQgPSBmb3JtLnF1ZXJ5U2VsZWN0b3IoXCJpbnB1dFwiKSE7XG4gIGZvcm0ub25zdWJtaXQgPSAoZSkgPT4ge1xuICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICBjb25zdCB0ZXh0ID0gaW5wdXQudmFsdWUudHJpbSgpO1xuICAgIGlmICh0ZXh0KSB7XG4gICAgICBpZiAoIWNhbkZvbGxvd1VwUmVzdWx0KG9yaWdpblNlc3Npb24sIGFjdGl2ZVNlc3Npb24sIHRhc2tzLmhhcyh0LmlkKSkpIHtcbiAgICAgICAgdG9hc3QoXCJUaGF0IHRhc2sncyBjYWxsIGhhcyBlbmRlZFwiKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHB1c2goeyB0eXBlOiBcInN0ZWVyXCIsIHRhc2s6IHQuaWQsIHRleHQgfSk7XG4gICAgICAgIG5vdGUoYFlvdSBcdTIxOTIgJHt0LmxhYmVsfTogJHt0ZXh0fWApO1xuICAgICAgICBzY3JvbGxEb3duKHRydWUpO1xuICAgICAgfVxuICAgIH1cbiAgICBpbnB1dC5ibHVyKCk7XG4gICAgZm9ybS5yZW1vdmUoKTtcbiAgICBzaG93VGFza3MoKTtcbiAgfTtcbiAgaW5wdXQub25rZXlkb3duID0gKGUpID0+IHsgaWYgKGUua2V5ID09PSBcIkVzY2FwZVwiKSB7IGUuc3RvcFByb3BhZ2F0aW9uKCk7IGlucHV0LmJsdXIoKTsgZm9ybS5yZW1vdmUoKTsgc2hvd1Rhc2tzKCk7IH0gfTtcbiAgY2FyZC5hcHBlbmQoZm9ybSk7XG4gIGlucHV0LmZvY3VzKCk7XG59XG5cbi8qKiBUMyB0aHJlYWRzIGVhcmxpZXIgY2FsbHMgc3RhcnRlZDogdGhleSBjYXJyeSBvbiBhZnRlciBhIGNhbGwsIHNvIHRoZSBwYW5lbCBzYXlzIGhvdyB0aGV5J3JlIGRvaW5nLiAqL1xuYXN5bmMgZnVuY3Rpb24gc2hvd0VhcmxpZXIoKSB7XG4gIGxldCBsaXN0OiB7IHRocmVhZDogc3RyaW5nOyB0aXRsZTogc3RyaW5nOyBzdGF0dXM6IHN0cmluZzsgYnJhbmNoOiBzdHJpbmcgfCBudWxsOyBwcjogc3RyaW5nIHwgbnVsbDsgdXBkYXRlZDogc3RyaW5nOyBsYXN0OiBzdHJpbmc7IHdhaXRpbmc6IGJvb2xlYW4gfVtdID0gW107XG4gIHRyeSB7IGxpc3QgPSBhd2FpdCAoYXdhaXQgZmV0Y2goXCIvYWdlbnQvcmVjZW50XCIsIHsgY2FjaGU6IFwibm8tc3RvcmVcIiB9KSkuanNvbigpOyB9IGNhdGNoIHt9XG4gIGNvbnN0IGN1cnJlbnQgPSBuZXcgU2V0KFsuLi50YXNrcy52YWx1ZXMoKV0ubWFwKCh2KSA9PiB2LnRocmVhZCkuZmlsdGVyKEJvb2xlYW4pKTtcbiAgbGlzdCA9IGxpc3QuZmlsdGVyKCh0KSA9PiAhY3VycmVudC5oYXModC50aHJlYWQpKTtcbiAgY29uc3QgcGFuZSA9ICQoXCJlYXJsaWVyXCIpO1xuICBjb25zdCBkb25lID0gJChcImRvbmVlYXJsaWVyXCIpO1xuICBwYW5lLmlubmVySFRNTCA9IFwiXCI7XG4gIGRvbmUuaW5uZXJIVE1MID0gXCJcIjtcbiAgZWFybGllckFjdGl2ZUNvdW50ID0gMDtcbiAgZWFybGllcldhaXRpbmdDb3VudCA9IDA7XG4gIGZvciAoY29uc3QgdCBvZiBsaXN0KSB7XG4gICAgY29uc3QgY2FyZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgY29uc3Qgc3RhdGUgPSB0LndhaXRpbmcgPyBcIndhaXRpbmcgZm9yIGFwcHJvdmFsIGluIFQzXCIgOiB0LnN0YXR1cztcbiAgICBjYXJkLmNsYXNzTmFtZSA9IGB0YXNrICR7dC5zdGF0dXMgPT09IFwicnVubmluZ1wiID8gXCJydW5uaW5nXCIgOiB0LndhaXRpbmcgPyBcIndhaXRpbmdcIiA6IFwiZmluaXNoZWRcIn1gO1xuICAgIGNvbnN0IGFnbyA9IE1hdGgubWF4KDAsIChEYXRlLm5vdygpIC0gRGF0ZS5wYXJzZSh0LnVwZGF0ZWQpKSAvIDEwMDApO1xuICAgIGNhcmQuaW5uZXJIVE1MID1cbiAgICAgIGA8ZGl2IGNsYXNzPVwibWV0YS1yb3dcIj5gICtcbiAgICAgICAgYDxzcGFuIGNsYXNzPVwiYmFkZ2UgdDNcIj5UMzwvc3Bhbj5gICtcbiAgICAgICAgYDxzcGFuIGNsYXNzPVwibGFiZWxcIj48L3NwYW4+YCArXG4gICAgICAgIGA8c3BhbiBjbGFzcz1cInN0YXRlXCI+JHt0LnN0YXR1cyA9PT0gXCJydW5uaW5nXCIgPyAnPHNwYW4gY2xhc3M9XCJzcGluXCI+PC9zcGFuPicgOiBcIlwifSR7ZXNjYXBlSHRtbChzdGF0ZSl9PC9zcGFuPmAgK1xuICAgICAgICBgPHNwYW4gY2xhc3M9XCJhZ2VcIj4ke2VsYXBzZWQoYWdvKX0gYWdvPC9zcGFuPmAgK1xuICAgICAgYDwvZGl2PmAgK1xuICAgICAgYDxkaXYgY2xhc3M9XCJwXCI+PC9kaXY+YDtcbiAgICBjb25zdCBsYWJlbEVsID0gY2FyZC5xdWVyeVNlbGVjdG9yKFwiLmxhYmVsXCIpIGFzIEhUTUxFbGVtZW50O1xuICAgIGxhYmVsRWwudGV4dENvbnRlbnQgPSB0LnRpdGxlO1xuICAgIGxhYmVsRWwudGl0bGUgPSB0LnRpdGxlO1xuICAgIGNhcmQucXVlcnlTZWxlY3RvcihcIi5wXCIpIS50ZXh0Q29udGVudCA9IHQubGFzdCB8fCAodC5icmFuY2ggPyBgT24gJHt0LmJyYW5jaH1gIDogXCJcIik7XG4gICAgY29uc3QgYWN0cyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgYWN0cy5jbGFzc05hbWUgPSBcImFjdHNcIjtcbiAgICBpZiAodC5wcikgeyBjb25zdCBhID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImFcIik7IGEuaHJlZiA9IHQucHI7IGEudGFyZ2V0ID0gXCJfYmxhbmtcIjsgYS5yZWwgPSBcIm5vb3BlbmVyXCI7IGEudGV4dENvbnRlbnQgPSBcIlBSIFx1MjE5N1wiOyBhY3RzLmFwcGVuZChhKTsgfVxuICAgIGNvbnN0IGNvcHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICAgIGNvcHkudHlwZSA9IFwiYnV0dG9uXCI7XG4gICAgY29weS50ZXh0Q29udGVudCA9IFwiQ29weSBpZFwiO1xuICAgIGNvcHkub25jbGljayA9ICgpID0+IHsgdm9pZCBuYXZpZ2F0b3IuY2xpcGJvYXJkPy53cml0ZVRleHQodC50aHJlYWQpOyB0b2FzdChcIlRocmVhZCBpZCBjb3BpZWRcIik7IH07XG4gICAgYWN0cy5hcHBlbmQoY29weSk7XG4gICAgY2FyZC5hcHBlbmQoYWN0cyk7XG4gICAgY29uc3QgYWN0aXZlID0gdC5zdGF0dXMgPT09IFwicnVubmluZ1wiIHx8IHQud2FpdGluZztcbiAgICBpZiAoYWN0aXZlKSBlYXJsaWVyQWN0aXZlQ291bnQrKztcbiAgICBpZiAodC53YWl0aW5nKSBlYXJsaWVyV2FpdGluZ0NvdW50Kys7XG4gICAgKGFjdGl2ZSA/IHBhbmUgOiBkb25lKS5hcHBlbmQoY2FyZCk7XG4gIH1cbiAgc3luY1NpZGVMYXlvdXQoKTtcbiAgdXBkYXRlVGFza0Nocm9tZSgpO1xufVxuXG5jb25zdCBTVEFUVVNfVEVYVDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgaWRsZTogXCJJZGxlXCIsIGNvbm5lY3Rpbmc6IFwiQ29ubmVjdGluZ1x1MjAyNlwiLCBsaXN0ZW5pbmc6IFwiTGlzdGVuaW5nXCIsIHdvcmtpbmc6IFwiTGlzdGVuaW5nIFx1MDBCNyB0YXNrcyBydW5uaW5nXCIsXG4gIGRvcm1hbnQ6IFwiRG9ybWFudCBcdTAwQjcgd2FpdGluZyBmb3Igd2FrZSB3b3JkXCIsXG4gIHN0YW5kYnk6IFwiUGF1c2VkIHdoaWxlIHRhc2tzIHJ1biBcdTAwQjcgc3BlYWsgdG8gcmVzdW1lXCIsIHdha2luZzogXCJSZXN1bWluZ1x1MjAyNlwiLCBlbmRlZDogXCJFbmRlZFwiLFxufTtcblxuZnVuY3Rpb24gc2hvd1N0YXR1cyhtZXNzYWdlPzogc3RyaW5nKSB7XG4gIGNvbnN0IHR5cGVkID0gQm9vbGVhbihjYWxsSWQpICYmIG1lZGl1bSA9PT0gXCJ0ZXh0XCI7XG4gIGNvbnN0IHNwZWFraW5nID0gQm9vbGVhbihjYWxsSWQpICYmICF0eXBlZCAmJiBjb3JlU3RhdHVzICE9PSBcInN0YW5kYnlcIiAmJiBjb3JlU3RhdHVzICE9PSBcImRvcm1hbnRcIiAmJiBhdWRpby5xdWV1ZWQgPiAwLjA1O1xuICBjb25zdCBhcm1lZElkbGUgPSAhY2FsbElkICYmIHdha2VBcm1lZDtcbiAgY29uc3Qgc2hvd24gPSBjYWxsSWRcbiAgICA/IChzcGVha2luZyB8fCAodHlwZWQgJiYgdGhpbmtpbmcpID8gXCJzcGVha2luZ1wiIDogY29yZVN0YXR1cylcbiAgICA6IGFybWVkSWRsZSA/IFwiYXJtZWRcIiA6IGNvcmVTdGF0dXM7XG4gICQoXCJzdGF0dXNcIikuY2xhc3NOYW1lID0gc2hvd247XG4gIGRvY3VtZW50LmJvZHkuZGF0YXNldC5zdGF0ZSA9IGNhbGxJZCA/IHNob3duIDogYXJtZWRJZGxlID8gXCJhcm1lZFwiIDogXCJpZGxlXCI7XG4gIGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LnRvZ2dsZShcImluLXNlc3Npb25cIiwgQm9vbGVhbihjYWxsSWQpKTtcbiAgY29uc3Qgd2FrZUxhYmVsID0gc2VsZWN0ZWRXYWtlTW9kZWwoKT8ubGFiZWwgPz8gXCJ3YWtlIHdvcmRcIjtcbiAgbGV0IHRleHQgPSBhcm1lZElkbGVcbiAgICA/ICh3YWtlTG9hZGluZyA/IGBMb2FkaW5nIFx1MjAxQyR7d2FrZUxhYmVsfVx1MjAxRFx1MjAyNmBcbiAgICAgIDogYXVkaW8uYXVkaW9TdXNwZW5kZWQgPyBgVGFwIGFueXdoZXJlIHRvIGFjdGl2YXRlIFx1MjAxQyR7d2FrZUxhYmVsfVx1MjAxRGBcbiAgICAgIDogYFdhaXRpbmcgZm9yIFx1MjAxQyR7d2FrZUxhYmVsfVx1MjAxRGApXG4gICAgOiBzcGVha2luZyA/IFwiU3BlYWtpbmdcIlxuICAgIDogY29yZVN0YXR1cyA9PT0gXCJkb3JtYW50XCIgPyBgRG9ybWFudCBcdTAwQjcgc2F5IFx1MjAxQyR7d2FrZUxhYmVsfVx1MjAxRGBcbiAgICA6IFNUQVRVU19URVhUW2NvcmVTdGF0dXNdID8/IGNvcmVTdGF0dXM7XG4gIGlmICh0eXBlZCAmJiBjb3JlU3RhdHVzICE9PSBcImVuZGVkXCIpIHRleHQgPSB0aGlua2luZyA/IFwiV3JpdGluZ1x1MjAyNlwiIDogY29yZVN0YXR1cyA9PT0gXCJ3b3JraW5nXCIgPyBcIkNoYXQgXHUwMEI3IHRhc2tzIHJ1bm5pbmdcIiA6IFwiQ2hhdFwiO1xuICBpZiAoY2FsbElkICYmICF0eXBlZCAmJiBtdXRlZCAmJiAhaG9sZGluZyAmJiAhc3BlYWtpbmcpIHRleHQgKz0gXCIgXHUwMEI3IG11dGVkXCI7XG4gIGlmIChob2xkaW5nKSB0ZXh0ID0gXCJUYWxraW5nIChob2xkKVwiO1xuICBpZiAobWVzc2FnZSkgdGV4dCA9IGAke3RleHR9OiAke21lc3NhZ2V9YDtcbiAgaWYgKGNvcmVTdGF0dXMgIT09IFwiZW5kZWRcIiB8fCBtZXNzYWdlIHx8IGFybWVkSWRsZSkgJChcInN0YXR1c3RleHRcIikudGV4dENvbnRlbnQgPSB0ZXh0O1xuICAkPEhUTUxCdXR0b25FbGVtZW50PihcImh1c2hcIikuY2xhc3NMaXN0LnRvZ2dsZShcImxpdmVcIiwgc3BlYWtpbmcgfHwgKHR5cGVkICYmIHRoaW5raW5nKSk7XG5cbiAgY29uc3QgYmFyID0gJChcImNhbGxiYXJcIik7XG4gIGJhci5oaWRkZW4gPSAhY2FsbElkO1xuICAkKFwid2FrZS1ub3dcIikuaGlkZGVuID0gIShjYWxsSWQgJiYgIXR5cGVkICYmIChjb3JlU3RhdHVzID09PSBcImRvcm1hbnRcIiB8fCBjb3JlU3RhdHVzID09PSBcInN0YW5kYnlcIikpO1xuICBpZiAoY2FsbElkKSB7XG4gICAgJChcImNhbGxiYXItc3RhdGVcIikudGV4dENvbnRlbnQgPSB0ZXh0O1xuICAgICQoXCJjYWxsdGltZXJcIikuaGlkZGVuID0gdHlwZWQ7XG4gICAgaWYgKCF0eXBlZCkgJChcImNhbGx0aW1lclwiKS50ZXh0Q29udGVudCA9IGZvcm1hdENsb2NrKG5vdygpIC0gc3RhcnRlZEF0KTtcbiAgICBjb25zdCB2aXpNb2RlID0gdHlwZWQgPyAodGhpbmtpbmcgPyBcInRoaW5raW5nXCIgOiBcImlkbGVcIilcbiAgICAgIDogc3BlYWtpbmcgPyBcInNwZWFraW5nXCJcbiAgICAgIDogbXV0ZWQgJiYgIWhvbGRpbmcgPyBcIm11dGVkXCJcbiAgICAgIDogc2hvd247XG4gICAgdXBkYXRlVmlzdWFsaXplcih2aXpNb2RlLCBtdXRlZCAmJiAhaG9sZGluZyA/IDAgOiBhdWRpby5sZXZlbCk7XG4gIH1cbn1cblxuLy8gVGhlIGNhbGwuXG5cbmZ1bmN0aW9uIHB1c2goZXZlbnQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LCB0ID0gbm93KCkpOiBDb21tYW5kW10ge1xuICBpZiAoIWNvcmUgfHwgIWNhbGxJZCkgcmV0dXJuIFtdO1xuICBjb25zdCBlOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgLi4uZXZlbnQsIHQgfTtcbiAgY29uc3QgcXVpZXQgPSBlLnR5cGUgPT09IFwibWljXCIgfHwgZS50eXBlID09PSBcInRpY2tcIjtcbiAgaWYgKCFxdWlldCkgbG9nKFwiaW5cIiwgZS50eXBlID09PSBcIndzLm1lc3NhZ2VcIiA/IGB3cyAke2Uuc2lkfSBcdTIxOTAgJHticmllZihTdHJpbmcoZS5kYXRhKSl9YCA6IEpTT04uc3RyaW5naWZ5KGUpLnNsaWNlKDAsIDQwMCksIFwiaW5cIik7XG4gIGNvbnN0IGNvbW1hbmRzID0gSlNPTi5wYXJzZShjb3JlLnB1c2goY2FsbElkLCBKU09OLnN0cmluZ2lmeShlKSkpIGFzIENvbW1hbmRbXTtcbiAgcnVuKGNvbW1hbmRzLCB0KTtcbiAgcmV0dXJuIGNvbW1hbmRzO1xufVxuXG5mdW5jdGlvbiBydW4oY29tbWFuZHM6IENvbW1hbmRbXSwgZXZlbnRUaW1lID0gbm93KCkpIHtcbiAgZm9yIChjb25zdCBjIG9mIGNvbW1hbmRzKSB7XG4gICAgc3dpdGNoIChjLnR5cGUpIHtcbiAgICAgIGNhc2UgXCJ3cy5jb25uZWN0XCI6IGNvbm5lY3QoYy5zaWQsIGMucHVycG9zZSA9PT0gXCJjYXB0aW9uc1wiKTsgYnJlYWs7XG4gICAgICBjYXNlIFwid3Muc2VuZFwiOiB7XG4gICAgICAgIHNvY2tldHMuZ2V0KGMuc2lkKT8uc2VuZChjLmRhdGEpO1xuICAgICAgICBpZiAoIWMuZGF0YS5zdGFydHNXaXRoKCd7XCJyZWFsdGltZUlucHV0XCI6e1wiYXVkaW9cIicpKSBsb2coXCJvdXRcIiwgYHdzICR7Yy5zaWR9IFx1MjE5MiAke2JyaWVmKGMuZGF0YSl9YCwgXCJvdXRcIik7XG4gICAgICAgIGVsc2UgaWYgKCFjYXB0aW9uU29ja2V0cy5oYXMoYy5zaWQpKSBjb3VudHMuc2VudCsrO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ3cy5jbG9zZVwiOiBzb2NrZXRzLmdldChjLnNpZCk/LmNsb3NlKCk7IHNvY2tldHMuZGVsZXRlKGMuc2lkKTsgbG9nKFwib3V0XCIsIGB3cyAke2Muc2lkfSBjbG9zZWAsIFwib3V0XCIpOyBicmVhaztcbiAgICAgIGNhc2UgXCJtaWMuc3RhcnRcIjoge1xuICAgICAgICBsb2coXCJvdXRcIiwgYy50eXBlLCBcIm91dFwiKTtcbiAgICAgICAgY29uc3QgcGVuZGluZ09wZW5pbmcgPSB3YWtlU3RhcnRpbmcgPyBvcGVuaW5nQ2h1bmtzLnNwbGljZSgwKSA6IFtdO1xuICAgICAgICBvcGVuaW5nQnl0ZXMgPSAwO1xuICAgICAgICB3YWtlU3RhcnRpbmcgPSBmYWxzZTtcbiAgICAgICAgdm9pZCBhdWRpby5lbnN1cmVNaWMob25NaWMsIG1pY09wdGlvbnMoKSkuY2F0Y2goKGVycikgPT4geyBsb2coXCJlcnJvclwiLCBgbWljcm9waG9uZTogJHtlcnIubWVzc2FnZX1gLCBcImVyclwiKTsgdG9hc3QoYE1pY3JvcGhvbmU6ICR7ZXJyLm1lc3NhZ2V9YCk7IH0pO1xuICAgICAgICBpZiAocGVuZGluZ09wZW5pbmcubGVuZ3RoID4gMCkge1xuICAgICAgICAgIGNvbnN0IHRvdGFsTXMgPSBNYXRoLnJvdW5kKHBlbmRpbmdPcGVuaW5nLnJlZHVjZSgocywgYikgPT4gcyArIGIuYnl0ZUxlbmd0aCwgMCkgLyAzMik7XG4gICAgICAgICAgbG9nKFwib3V0XCIsIGBmbHVzaGluZyAke3RvdGFsTXN9IG1zIHNwb2tlbiBhZnRlciB3YWtlIHdvcmRgLCBcIm91dFwiKTtcbiAgICAgICAgICBxdWV1ZU1pY3JvdGFzaygoKSA9PiB7XG4gICAgICAgICAgICBpZiAoIWNhbGxJZCkgcmV0dXJuO1xuICAgICAgICAgICAgZm9yIChjb25zdCBjaHVuayBvZiBwZW5kaW5nT3BlbmluZykge1xuICAgICAgICAgICAgICBpZiAoIWNhbGxJZCkgYnJlYWs7XG4gICAgICAgICAgICAgIGNvdW50cy5taWMrKztcbiAgICAgICAgICAgICAgcHVzaCh7IHR5cGU6IFwibWljXCIsIHBjbTogYnl0ZXNUb0Jhc2U2NChjaHVuaykgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwibWljLnJlc3RhcnRcIjpcbiAgICAgICAgbG9nKFwib3V0XCIsIGMudHlwZSwgXCJvdXRcIik7XG4gICAgICAgIHZvaWQgYXVkaW8uc3RhcnRNaWMob25NaWMsIG1pY09wdGlvbnMoKSkuY2F0Y2goKGVycikgPT4geyBsb2coXCJlcnJvclwiLCBgbWljcm9waG9uZTogJHtlcnIubWVzc2FnZX1gLCBcImVyclwiKTsgdG9hc3QoYE1pY3JvcGhvbmU6ICR7ZXJyLm1lc3NhZ2V9YCk7IH0pO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJtaWMuc3RvcFwiOlxuICAgICAgICBpZiAoIXdha2VBcm1lZCkgYXVkaW8uc3RvcE1pYygpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJwbGF5XCI6IHtcbiAgICAgICAgY29uc3QgdCA9IG5vdygpO1xuICAgICAgICBjb25zdCBwYWQgPSBjLnBjbS5lbmRzV2l0aChcIj09XCIpID8gMiA6IGMucGNtLmVuZHNXaXRoKFwiPVwiKSA/IDEgOiAwO1xuICAgICAgICBjb25zdCBwY21CeXRlcyA9IE1hdGgubWF4KDAsIE1hdGguZmxvb3IoKGMucGNtLmxlbmd0aCAqIDMpIC8gNCkgLSBwYWQpO1xuICAgICAgICBjb3JlU3BlZWNoVW50aWwgPSBNYXRoLm1heChjb3JlU3BlZWNoVW50aWwsIGV2ZW50VGltZSkgKyBwY21CeXRlcyAvIDQ4XzAwMDtcbiAgICAgICAgLy8gQSByZXBseSBzdGFydGluZzogZnJvbSB0aGUgZW5kIG9mIHRoZSB1c2VyJ3Mgc3BlZWNoIHRvIGl0cyBmaXJzdCBzb3VuZC5cbiAgICAgICAgaWYgKCFtZXRyaWNzLnJlcGxpZWQgJiYgYXVkaW8ucXVldWVkIDwgMC4wNSAmJiB0IC0gbWV0cmljcy5sYXN0UGxheSA+IDAuNiAmJiBtZXRyaWNzLmxhc3RWb2ljZSA+IDAgJiYgdCAtIG1ldHJpY3MubGFzdFZvaWNlIDwgMTApIHtcbiAgICAgICAgICBtZXRyaWNzLnJlcGx5LnB1c2godCAtIG1ldHJpY3MubGFzdFZvaWNlKTtcbiAgICAgICAgICBpZiAobWV0cmljcy5yZXBseS5sZW5ndGggPiAyMCkgbWV0cmljcy5yZXBseS5zaGlmdCgpO1xuICAgICAgICAgIG1ldHJpY3MucmVwbGllZCA9IHRydWU7XG4gICAgICAgICAgc2hvd01ldHJpY3MoKTtcbiAgICAgICAgfVxuICAgICAgICBtZXRyaWNzLmxhc3RQbGF5ID0gdDtcbiAgICAgICAgYXVkaW8ucGxheShjLnBjbSk7XG4gICAgICAgIGNvdW50cy5wbGF5Kys7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcImZsdXNoXCI6XG4gICAgICAgIGNvcmVTcGVlY2hVbnRpbCA9IE1hdGgubWluKGNvcmVTcGVlY2hVbnRpbCwgZXZlbnRUaW1lKTtcbiAgICAgICAgYXVkaW8uZmx1c2goKTtcbiAgICAgICAgbG9nKFwib3V0XCIsIFwiZmx1c2hcIiwgXCJvdXRcIik7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcImN1ZVwiOlxuICAgICAgICBhdWRpby5jdWUoYy5wY20pO1xuICAgICAgICBsb2coXCJvdXRcIiwgYGN1ZSAke2MuZWFyY29ufWAsIFwib3V0XCIpO1xuICAgICAgICAvLyBBIHJlcXVlc3QgdGhhdCBiZWNhbWUgYSB0YXNrIGdldHMgYSB0b25lLCBub3QgYSBzcG9rZW4gcmVwbHk6IG5vdGhpbmcgdG8gdGltZS5cbiAgICAgICAgaWYgKGMuZWFyY29uID09PSBcInRhc2tTdGFydGVkXCIpIG1ldHJpY3MucmVwbGllZCA9IHRydWU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcIndha2V3b3JkXCI6IGVuc3VyZUNvcmVXYWtlKEJvb2xlYW4oYy5vbikpOyBicmVhaztcbiAgICAgIGNhc2UgXCJ0b29sLmNhbGxcIjogdm9pZCB0b29sKGMpOyBicmVhaztcbiAgICAgIGNhc2UgXCJ0b29sLmNhbmNlbFwiOiBjYW5jZWxSdW4oYy5ydW4sIGMucmVhc29uKTsgYnJlYWs7XG4gICAgICBjYXNlIFwidG9vbC5zdGVlclwiOiB2b2lkIHN0ZWVyUnVuKGMpOyBicmVhaztcbiAgICAgIGNhc2UgXCJzdGF0dXNcIjoge1xuICAgICAgICBjb25zdCBwcmV2ID0gY29yZVN0YXR1cztcbiAgICAgICAgY29yZVN0YXR1cyA9IGMuc3RhdHVzO1xuICAgICAgICBpZiAoYy5zdGF0dXMgPT09IFwiZG9ybWFudFwiICYmIHByZXYgIT09IFwiZG9ybWFudFwiICYmIGNoZWNrZWQoXCJ3YWtlLWN1ZVwiKSkgYXVkaW8uY3VlKFNMRUVQX1RPTkUpO1xuICAgICAgICBzaG93U3RhdHVzKGMuc3RhdHVzID09PSBcImVuZGVkXCIgPyBjLm1lc3NhZ2UgPz8gdW5kZWZpbmVkIDogdW5kZWZpbmVkKTtcbiAgICAgICAgbG9nKFwic3RhdHVzXCIsIGMuc3RhdHVzICsgKGMubWVzc2FnZSA/IGA6ICR7Yy5tZXNzYWdlfWAgOiBcIlwiKSwgXCJzdGF0dXNcIik7XG4gICAgICAgIGlmIChjLnN0YXR1cyA9PT0gXCJlbmRlZFwiKSB7IGlmIChjLm1lc3NhZ2UpIG5vdGUoYy5tZXNzYWdlKTsgZW5kKCk7IH1cbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwibGxtLnJlcXVlc3RcIjogdm9pZCBnZW5lcmF0ZShjLmlkLCBjLmJvZHkpOyBicmVhaztcbiAgICAgIGNhc2UgXCJsbG0uY2FuY2VsXCI6IHJlcXVlc3RzLmdldChjLmlkKT8uYWJvcnQoKTsgcmVxdWVzdHMuZGVsZXRlKGMuaWQpOyBsb2coXCJvdXRcIiwgYHJlcXVlc3QgJHtjLmlkfSBkcm9wcGVkYCwgXCJvdXRcIik7IGJyZWFrO1xuICAgICAgY2FzZSBcInRoaW5raW5nXCI6IHRoaW5raW5nID0gYy5vbjsgc2hvd1N0YXR1cygpOyBicmVhaztcbiAgICAgIGNhc2UgXCJlcnJvclwiOiBub3RlKGMubWVzc2FnZSk7IGxvZyhcImVycm9yXCIsIGMubWVzc2FnZSwgXCJlcnJcIik7IGJyZWFrO1xuICAgICAgY2FzZSBcImNhcHRpb25cIjogY2FwdGlvbihjLnRleHQpOyBicmVhaztcbiAgICAgIGNhc2UgXCJ0cmFuc2NyaXB0XCI6XG4gICAgICAgIHRyYW5zY3JpcHQoYy5yb2xlLCBjLnRleHQsIGMubGluZSk7XG4gICAgICAgIHJlbWVtYmVyKGMucm9sZSwgYy50ZXh0LCBjLnJvbGUgPT09IFwiYXNzaXN0YW50XCIgPyBcIkdlbWluaVwiIDogdW5kZWZpbmVkLCBsYXN0TGluZSA9PT0gYy5saW5lKTtcbiAgICAgICAgbGFzdExpbmUgPSBjLmxpbmU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcInRhc2tcIjoge1xuICAgICAgICBjb25zdCB2aWV3ID0gdGFza3MuZ2V0KGMuaWQpID8/IHsgYywgc2luY2U6IG5vdygpLCBlbmRlZDogbnVsbCB9O1xuICAgICAgICBpZiAoYy5zdGF0ZSA9PT0gXCJydW5uaW5nXCIgJiYgdmlldy5jLnN0YXRlICE9PSBcInJ1bm5pbmdcIikgeyB2aWV3LnNpbmNlID0gbm93KCk7IHZpZXcuZW5kZWQgPSBudWxsOyB9XG4gICAgICAgIGlmIChjLnN0YXRlICE9PSBcInJ1bm5pbmdcIiAmJiB2aWV3LmVuZGVkID09IG51bGwpIHZpZXcuZW5kZWQgPSBub3coKTtcbiAgICAgICAgdmlldy5jID0gYztcbiAgICAgICAgdGFza3Muc2V0KGMuaWQsIHZpZXcpO1xuICAgICAgICBzaG93VGFza3MoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwicXVlc3Rpb25zXCI6IGJyZWFrO1xuICAgICAgY2FzZSBcIm1pY1NpbGVudFwiOiAkKFwibWljd2FyblwiKS5oaWRkZW4gPSAhYy5zaWxlbnQ7IGJyZWFrO1xuICAgICAgY2FzZSBcInZvaWNlQ29tbWFuZFwiOlxuICAgICAgICB0b2FzdChgSGVhcmQgXHUyMDFDJHtjLmhlYXJkfVx1MjAxRDogJHtjLmNvbW1hbmQgPT09IFwic3RvcFwiID8gXCJzdG9wcGVkXCIgOiBjLmNvbW1hbmQgPT09IFwiY2FuY2VsQWxsXCIgPyBcImNhbmNlbGxpbmcgZXZlcnkgdGFza1wiIDogXCJoYW5naW5nIHVwXCJ9YCk7XG4gICAgICAgIGxvZyhcIm91dFwiLCBgdm9pY2UgY29tbWFuZCAke2MuY29tbWFuZH06ICR7Yy5oZWFyZH1gLCBcIm91dFwiKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwibG9nXCI6IGxvZyhjLmxldmVsLCBjLm1lc3NhZ2UsIGMubGV2ZWwgPT09IFwid2FyblwiID8gXCJ3YXJuXCIgOiBcIlwiKTsgYnJlYWs7XG4gICAgICBkZWZhdWx0OiBsb2coXCJvdXRcIiwgSlNPTi5zdHJpbmdpZnkoYykuc2xpY2UoMCwgMzAwKSwgXCJvdXRcIik7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIG9uTWljKHNhbXBsZXM6IEludDE2QXJyYXksIGxldmVsOiBudW1iZXIpIHtcbiAgY29uc3QgdCA9IG5vdygpO1xuICBjb25zdCBzdXBwcmVzc2VkID0gY2FsbElkICE9PSAwICYmIG1lZGl1bSA9PT0gXCJ2b2ljZVwiICYmIGNhbGxXaGlsZVNwZWFraW5nICE9PSBcInNlbmRcIiAmJiB0IDwgY29yZVNwZWVjaFVudGlsO1xuICBpZiAoc2hvdWxkRmVlZFdha2UoKSkgd2FrZUNsaWVudC5mZWVkKHNhbXBsZXMsIHN1cHByZXNzZWQpO1xuICBpZiAod2FrZVN0YXJ0aW5nKSB7XG4gICAgY29uc3QgY29weSA9IG5ldyBVaW50OEFycmF5KHNhbXBsZXMuYnl0ZUxlbmd0aCk7XG4gICAgY29weS5zZXQobmV3IFVpbnQ4QXJyYXkoc2FtcGxlcy5idWZmZXIsIHNhbXBsZXMuYnl0ZU9mZnNldCwgc2FtcGxlcy5ieXRlTGVuZ3RoKSk7XG4gICAgb3BlbmluZ0NodW5rcy5wdXNoKGNvcHkpO1xuICAgIG9wZW5pbmdCeXRlcyArPSBjb3B5LmJ5dGVMZW5ndGg7XG4gICAgd2hpbGUgKG9wZW5pbmdCeXRlcyA+IE9QRU5JTkdfTUFYX0JZVEVTICYmIG9wZW5pbmdDaHVua3MubGVuZ3RoID4gMSkge1xuICAgICAgb3BlbmluZ0J5dGVzIC09IG9wZW5pbmdDaHVua3Muc2hpZnQoKSEuYnl0ZUxlbmd0aDtcbiAgICB9XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmICghY2FsbElkIHx8IG1lZGl1bSAhPT0gXCJ2b2ljZVwiKSByZXR1cm47XG4gIGNvdW50cy5taWMrKztcbiAgaWYgKGxldmVsID4gMC4wMyAmJiAhKG11dGVkICYmICFob2xkaW5nKSkge1xuICAgIG1ldHJpY3MubGFzdFZvaWNlID0gdDtcbiAgICBpZiAoYXVkaW8ucXVldWVkIDwgMC4wNSkgbWV0cmljcy5yZXBsaWVkID0gZmFsc2U7XG4gIH1cbiAgcHVzaCh7IHR5cGU6IFwibWljXCIsIHBjbTogYnl0ZXNUb0Jhc2U2NChuZXcgVWludDhBcnJheShzYW1wbGVzLmJ1ZmZlciwgc2FtcGxlcy5ieXRlT2Zmc2V0LCBzYW1wbGVzLmJ5dGVMZW5ndGgpKSB9LCB0KTtcbn1cblxuZnVuY3Rpb24gY29ubmVjdChzaWQ6IG51bWJlciwgY2FwdGlvbnM6IGJvb2xlYW4pIHtcbiAgY29uc3Qgd3MgPSBuZXcgV2ViU29ja2V0KGAke2xvY2F0aW9uLnByb3RvY29sID09PSBcImh0dHBzOlwiID8gXCJ3c3NcIiA6IFwid3NcIn06Ly8ke2xvY2F0aW9uLmhvc3R9L2xpdmUke2NhcHRpb25zID8gXCI/Zm9yPWNhcHRpb25zXCIgOiBcIlwifWApO1xuICBzb2NrZXRzLnNldChzaWQsIHdzKTtcbiAgaWYgKGNhcHRpb25zKSBjYXB0aW9uU29ja2V0cy5hZGQoc2lkKTtcbiAgbG9nKFwib3V0XCIsIGB3cyAke3NpZH0gY29ubmVjdCAoJHtzZXJ2ZXIucm91dGV9JHtjYXB0aW9ucyA/IFwiLCBjYXB0aW9uc1wiIDogXCJcIn0pYCwgXCJvdXRcIik7XG4gIHdzLm9ub3BlbiA9ICgpID0+IHB1c2goeyB0eXBlOiBcIndzLm9wZW5cIiwgc2lkIH0pO1xuICB3cy5vbm1lc3NhZ2UgPSAobSkgPT4gcHVzaCh7IHR5cGU6IFwid3MubWVzc2FnZVwiLCBzaWQsIGRhdGE6IHR5cGVvZiBtLmRhdGEgPT09IFwic3RyaW5nXCIgPyBtLmRhdGEgOiBcIlwiIH0pO1xuICB3cy5vbmNsb3NlID0gKGUpID0+IHtcbiAgICBpZiAoc29ja2V0cy5nZXQoc2lkKSAhPT0gd3MgJiYgc29ja2V0cy5oYXMoc2lkKSkgcmV0dXJuO1xuICAgIGNvbnN0IGh0dHBTdGF0dXMgPSBlLmNvZGUgPj0gNDEwMCAmJiBlLmNvZGUgPCA0NjAwID8gZS5jb2RlIC0gNDAwMCA6IHVuZGVmaW5lZDtcbiAgICBwdXNoKHsgdHlwZTogXCJ3cy5jbG9zZWRcIiwgc2lkLCBjb2RlOiBodHRwU3RhdHVzID8gdW5kZWZpbmVkIDogZS5jb2RlLCByZWFzb246IGUucmVhc29uLCBodHRwU3RhdHVzIH0pO1xuICB9O1xufVxuXG4vKiogQSBjaGF0J3MgcmVxdWVzdCB0byB0aGUgdGV4dCBtb2RlbCwgdGhyb3VnaCB0aGUgc2VydmVyOiBlYWNoIGBkYXRhOmAgbGluZSBvZiB0aGUgbW9kZWwncyBzdHJlYW0gZ29lcyB0byB0aGUgY29yZSBhcyBpdCBjb21lcy4gKi9cbmFzeW5jIGZ1bmN0aW9uIGdlbmVyYXRlKGlkOiBudW1iZXIsIGJvZHk6IHN0cmluZykge1xuICBjb25zdCBhYm9ydCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgcmVxdWVzdHMuc2V0KGlkLCBhYm9ydCk7XG4gIGxvZyhcIm91dFwiLCBgcmVxdWVzdCAke2lkfSBcdTIxOTIgJHtzZXJ2ZXIudGV4dE1vZGVsfSAoJHtNYXRoLnJvdW5kKGJvZHkubGVuZ3RoIC8gMTAyNCl9IEtCKWAsIFwib3V0XCIpO1xuICB0cnkge1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goXCIvZ2VuZXJhdGVcIiwgeyBtZXRob2Q6IFwiUE9TVFwiLCBzaWduYWw6IGFib3J0LnNpZ25hbCwgaGVhZGVyczogeyBcImNvbnRlbnQtdHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LCBib2R5IH0pO1xuICAgIGlmICghcmVzcG9uc2Uub2sgfHwgIXJlc3BvbnNlLmJvZHkpIHtcbiAgICAgIGNvbnN0IHRleHQgPSBhd2FpdCByZXNwb25zZS50ZXh0KCkuY2F0Y2goKCkgPT4gXCJcIik7XG4gICAgICBwdXNoKHsgdHlwZTogXCJsbG0uZW5kXCIsIGlkLCBzdGF0dXM6IHJlc3BvbnNlLnN0YXR1cywgZXJyb3I6IGBIVFRQICR7cmVzcG9uc2Uuc3RhdHVzfSR7dGV4dCA/IFwiOiBcIiArIHRleHQucmVwbGFjZSgvXFxzKy9nLCBcIiBcIikuc2xpY2UoMCwgMjAwKSA6IFwiXCJ9YCB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgcmVhZGVyID0gcmVzcG9uc2UuYm9keS5waXBlVGhyb3VnaChuZXcgVGV4dERlY29kZXJTdHJlYW0oKSkuZ2V0UmVhZGVyKCk7XG4gICAgbGV0IGJ1ZmZlciA9IFwiXCI7XG4gICAgZm9yICg7Oykge1xuICAgICAgY29uc3QgeyB2YWx1ZSwgZG9uZSB9ID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcbiAgICAgIGlmIChkb25lKSBicmVhaztcbiAgICAgIGJ1ZmZlciArPSB2YWx1ZTtcbiAgICAgIGxldCBjdXQ7XG4gICAgICB3aGlsZSAoKGN1dCA9IGJ1ZmZlci5pbmRleE9mKFwiXFxuXCIpKSA+PSAwKSB7XG4gICAgICAgIGNvbnN0IGxpbmUgPSBidWZmZXIuc2xpY2UoMCwgY3V0KS5yZXBsYWNlKC9cXHIkLywgXCJcIik7XG4gICAgICAgIGJ1ZmZlciA9IGJ1ZmZlci5zbGljZShjdXQgKyAxKTtcbiAgICAgICAgaWYgKGxpbmUuc3RhcnRzV2l0aChcImRhdGE6XCIpKSBwdXNoKHsgdHlwZTogXCJsbG0uZGF0YVwiLCBpZCwgZGF0YTogbGluZS5zbGljZSg1KS50cmltKCkgfSk7XG4gICAgICB9XG4gICAgfVxuICAgIHB1c2goeyB0eXBlOiBcImxsbS5lbmRcIiwgaWQgfSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGlmICghYWJvcnQuc2lnbmFsLmFib3J0ZWQpIHB1c2goeyB0eXBlOiBcImxsbS5lbmRcIiwgaWQsIGVycm9yOiAoZXJyIGFzIEVycm9yKS5tZXNzYWdlIH0pO1xuICB9IGZpbmFsbHkge1xuICAgIHJlcXVlc3RzLmRlbGV0ZShpZCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gY2FuY2VsUnVuKGtleTogc3RyaW5nLCByZWFzb246IHN0cmluZykge1xuICBjb25zdCByID0gcnVucy5nZXQoa2V5KTtcbiAgbG9nKFwib3V0XCIsIGBjYW5jZWwgJHtrZXl9ICgke3JlYXNvbn0pYCwgXCJvdXRcIik7XG4gIGlmICghcikgcmV0dXJuO1xuICBydW5zLmRlbGV0ZShrZXkpO1xuICByLmFib3J0LmFib3J0KCk7XG4gIC8vIENhbmNlbGxlZCBvbiBwdXJwb3NlOiB0aGUgYWdlbnQgc3RvcHMgdG9vLiBBIGNhbGwgdGhhdCBlbmRlZCBsZWF2ZXMgYSBjb2RpbmcgYWdlbnQgd29ya2luZyBpbiBUMy5cbiAgaWYgKHJlYXNvbiA9PT0gXCJjYW5jZWxsZWRcIiAmJiAhY2hlY2tlZChcImZha2VoZXJtZXNcIikpIHtcbiAgICB2b2lkIGZldGNoKHIuYWdlbnQgPT09IFwidDNcIiA/IFwiL2FnZW50L2NhbmNlbFwiIDogXCIvaGVybWVzL3N0b3BcIiwgeyBtZXRob2Q6IFwiUE9TVFwiLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGNhbGw6IGNhbGxOYW1lLCB0YXNrSWQ6IHIudGFza0lkIH0pIH0pO1xuICB9XG59XG5cbi8qKiBNb3JlIGZvciBhIHJ1bm5pbmcgdGFzaywgaW50byBpdHMgY3VycmVudCBydW47IGlmIHRoZSBhZ2VudCB3b24ndCB0YWtlIGl0LCB0aGUgY29yZSBxdWV1ZXMgaXQgaW5zdGVhZC4gKi9cbmFzeW5jIGZ1bmN0aW9uIHN0ZWVyUnVuKGM6IENvbW1hbmQpIHtcbiAgY29uc3QgciA9IHJ1bnMuZ2V0KGMucnVuKTtcbiAgbG9nKFwib3V0XCIsIGBzdGVlciAke2MucnVufTogJHtjLnRleHR9YCwgXCJvdXRcIik7XG4gIGlmIChjaGVja2VkKFwiZmFrZWhlcm1lc1wiKSkgcmV0dXJuO1xuICBjb25zdCBvayA9IHIgIT0gbnVsbCAmJlxuICAgIChhd2FpdCBmZXRjaChjLmFnZW50ID09PSBcInQzXCIgPyBcIi9hZ2VudC9zdGVlclwiIDogXCIvaGVybWVzL3N0ZWVyXCIsIHsgbWV0aG9kOiBcIlBPU1RcIiwgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBjYWxsOiBjYWxsTmFtZSwgdGFza0lkOiByLnRhc2tJZCwgdGV4dDogYy5tZXNzYWdlIH0pIH0pLnRoZW4oKHgpID0+IHgub2ssICgpID0+IGZhbHNlKSk7XG4gIGlmICghb2spIHB1c2goeyB0eXBlOiBcInRvb2wuc3RlZXJGYWlsZWRcIiwgcnVuOiBjLnJ1biwgdGV4dDogYy50ZXh0IH0pO1xuICBlbHNlIHRvYXN0KGAke2MuYWdlbnQgPT09IFwidDNcIiA/IFwiVGhlIGNvZGluZyBhZ2VudFwiIDogXCJIZXJtZXNcIn0gdG9vayB0aGUgZm9sbG93LXVwIHdoaWxlIGl0IHdvcmtzYCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHRvb2woYzogQ29tbWFuZCkge1xuICBpZiAoYy5raW5kID09PSBcImhvc3RcIikge1xuICAgIGxvZyhcIm91dFwiLCBgaG9zdCB0b29sICR7Yy5uYW1lfSAke0pTT04uc3RyaW5naWZ5KGMuYXJncyl9YCwgXCJvdXRcIik7XG4gICAgY29uc3QgYW5zd2VyID0gYy5uYW1lID09PSBcInR2X3ZvbHVtZVwiID8gYFRoZSBUViBpcyBhdCAkeyhmYWtlVHZMZXZlbCA9IE51bWJlcihjLmFyZ3M/LmxldmVsID8/IGZha2VUdkxldmVsKSl9LmBcbiAgICAgIDogYy5uYW1lID09PSBcInR2X3BhdXNlXCIgPyAoYy5hcmdzPy5wYXVzZSA9PT0gZmFsc2UgPyBcIlBsYXlpbmcuXCIgOiBcIlBhdXNlZC5cIikgOiBcIkRvbmUuXCI7XG4gICAgc2V0VGltZW91dCgoKSA9PiBwdXNoKHsgdHlwZTogXCJ0b29sLnJlc3VsdFwiLCBydW46IGMucnVuLCB0ZXh0OiBhbnN3ZXIgfSksIDMwMCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IGFnZW50ID0gYy5hZ2VudCA9PT0gXCJ0M1wiID8gXCJ0M1wiIDogXCJoZXJtZXNcIjtcbiAgY29uc3Qgb3JpZ2luU2Vzc2lvbiA9IGFjdGl2ZVNlc3Npb247XG4gIGxvZyhcIm91dFwiLCBgJHthZ2VudH0gJHtjLmZvbGxvd1VwID8gXCJmb2xsb3ctdXBcIiA6IFwidGFza1wifSBcIiR7Yy5sYWJlbH1cIiR7Yy5wcm9qZWN0ID8gYCBpbiAke2MucHJvamVjdH1gIDogXCJcIn06ICR7Yy5yZXF1ZXN0fWAsIFwib3V0XCIpO1xuICBjb25zdCBhYm9ydCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgcnVucy5zZXQoYy5ydW4sIHsgYWJvcnQsIGFnZW50LCB0YXNrSWQ6IGMudGFza0lkIH0pO1xuICBjb25zdCBkb25lID0gKHRleHQ6IHN0cmluZywgZmFpbGVkID0gZmFsc2UpID0+IHtcbiAgICBpZiAoIXJ1bnMuaGFzKGMucnVuKSkgcmV0dXJuO1xuICAgIHJ1bnMuZGVsZXRlKGMucnVuKTtcbiAgICBjb25zdCB2aWV3ID0gdGFza3MuZ2V0KGMudGFza0lkKTtcbiAgICBjb25zdCByZXNJZCA9IHJlc3VsdChhZ2VudCwgYy5sYWJlbCwgdGV4dCwgZmFpbGVkLCBjLnRhc2tJZCwgb3JpZ2luU2Vzc2lvbik7XG4gICAgbm90aWZ5KGAke2FnZW50ID09PSBcInQzXCIgPyBcIlQzXCIgOiBcIkhlcm1lc1wifSBcdTAwQjcgJHtjLmxhYmVsfWAsIHRleHQpO1xuICAgIGlmICghZmFpbGVkKSB7IHJlbWVtYmVyKFwiYXNzaXN0YW50XCIsIHRleHQsIGAke2FnZW50ID09PSBcInQzXCIgPyBcIlQzXCIgOiBcIkhlcm1lc1wifSBcdTAwQjcgJHtjLmxhYmVsfWApOyBsYXN0TGluZSA9IG51bGw7IH1cbiAgICBpZiAodmlldykgeyB2aWV3LnJlc3VsdElkID0gcmVzSWQ7IHNob3dUYXNrcygpOyB9XG4gICAgcHVzaCh7IHR5cGU6IFwidG9vbC5yZXN1bHRcIiwgcnVuOiBjLnJ1biwgdGV4dCwgZmFpbGVkIH0pO1xuICB9O1xuICBpZiAoY2hlY2tlZChcImZha2VoZXJtZXNcIikpIHtcbiAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4gZG9uZShgKEZha2UgJHthZ2VudCA9PT0gXCJ0M1wiID8gXCJUM1wiIDogXCJIZXJtZXNcIn0pIERvbmU6IFx1MjAxQyR7Yy5yZXF1ZXN0fVx1MjAxRC4gTm90aGluZyB3YXMgYWN0dWFsbHkgcnVuLmApLCBOdW1iZXIoJDxIVE1MSW5wdXRFbGVtZW50PihcImZha2VkZWxheVwiKS52YWx1ZSkgKiAxMDAwKTtcbiAgICBhYm9ydC5zaWduYWwub25hYm9ydCA9ICgpID0+IGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgcmV0dXJuO1xuICB9XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChhZ2VudCA9PT0gXCJ0M1wiID8gXCIvYWdlbnRcIiA6IFwiL2hlcm1lc1wiLCB7XG4gICAgICBtZXRob2Q6IFwiUE9TVFwiLCBzaWduYWw6IGFib3J0LnNpZ25hbCwgaGVhZGVyczogeyBcImNvbnRlbnQtdHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBjYWxsOiBjYWxsTmFtZSwgdGFza0lkOiBjLnRhc2tJZCwgZm9sbG93VXA6IGMuZm9sbG93VXAsIG1lc3NhZ2U6IGMubWVzc2FnZSwgbGFiZWw6IGMubGFiZWwsIHJlcXVlc3Q6IGMucmVxdWVzdCwgcHJvamVjdDogYy5wcm9qZWN0LCBhcHByb3ZhbHM6IFwic2NyZWVuXCIgfSksXG4gICAgfSk7XG4gICAgaWYgKCFyZXNwb25zZS5vayB8fCAhcmVzcG9uc2UuYm9keSkgdGhyb3cgbmV3IEVycm9yKGBIVFRQICR7cmVzcG9uc2Uuc3RhdHVzfWApO1xuICAgIGNvbnN0IHJlYWRlciA9IHJlc3BvbnNlLmJvZHkucGlwZVRocm91Z2gobmV3IFRleHREZWNvZGVyU3RyZWFtKCkpLmdldFJlYWRlcigpO1xuICAgIGxldCBidWZmZXIgPSBcIlwiO1xuICAgIGZvciAoOzspIHtcbiAgICAgIGNvbnN0IHsgdmFsdWUsIGRvbmU6IGZpbmlzaGVkIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpO1xuICAgICAgaWYgKGZpbmlzaGVkKSBicmVhaztcbiAgICAgIGJ1ZmZlciArPSB2YWx1ZTtcbiAgICAgIGxldCBjdXQ7XG4gICAgICB3aGlsZSAoKGN1dCA9IGJ1ZmZlci5pbmRleE9mKFwiXFxuXFxuXCIpKSA+PSAwKSB7XG4gICAgICAgIGNvbnN0IGJsb2NrID0gYnVmZmVyLnNsaWNlKDAsIGN1dCk7XG4gICAgICAgIGJ1ZmZlciA9IGJ1ZmZlci5zbGljZShjdXQgKyAyKTtcbiAgICAgICAgY29uc3QgZXZlbnQgPSBibG9jay5tYXRjaCgvXmV2ZW50OiAoLiopJC9tKT8uWzFdO1xuICAgICAgICBpZiAoIWV2ZW50KSBjb250aW51ZTtcbiAgICAgICAgY29uc3QgZGF0YSA9IEpTT04ucGFyc2UoYmxvY2subWF0Y2goL15kYXRhOiAoLiopJC9tKT8uWzFdID8/IFwie31cIik7XG4gICAgICAgIGlmIChldmVudCA9PT0gXCJwcm9ncmVzc1wiKSBwdXNoKHsgdHlwZTogXCJ0YXNrLnByb2dyZXNzXCIsIHRhc2s6IGMudGFza0lkLCB0ZXh0OiBkYXRhLnRleHQgfSk7XG4gICAgICAgIGVsc2UgaWYgKGV2ZW50ID09PSBcInRocmVhZFwiKSB7IGNvbnN0IHZpZXcgPSB0YXNrcy5nZXQoYy50YXNrSWQpOyBpZiAodmlldykgeyB2aWV3LnRocmVhZCA9IGRhdGEudGhyZWFkOyBzaG93VGFza3MoKTsgfSB9XG4gICAgICAgIGVsc2UgaWYgKGV2ZW50ID09PSBcImFwcHJvdmFsXCIpIHtcbiAgICAgICAgICBjb25zdCB2aWV3ID0gdGFza3MuZ2V0KGMudGFza0lkKTtcbiAgICAgICAgICBpZiAodmlldykgeyB2aWV3LmFwcHJvdmFsID0geyBjb21tYW5kOiBkYXRhLmNvbW1hbmQgfTsgc2hvd1Rhc2tzKHRydWUpOyB9XG4gICAgICAgICAgdG9hc3QoYEhlcm1lcyBhc2tzIHRvIHJ1bjogJHtkYXRhLmNvbW1hbmQuc2xpY2UoMCwgODApfWApO1xuICAgICAgICAgIG5vdGlmeShgSGVybWVzIFx1MDBCNyAke2MubGFiZWx9IG5lZWRzIHlvdXIgYXBwcm92YWxgLCBkYXRhLmNvbW1hbmQpO1xuICAgICAgICAgIGF1ZGlvLmN1ZShBUFBST1ZBTF9UT05FKTtcbiAgICAgICAgfVxuICAgICAgICBlbHNlIGlmIChldmVudCA9PT0gXCJyZXN1bHRcIikgZG9uZShkYXRhLnRleHQsIGRhdGEuZmFpbGVkKTtcbiAgICAgICAgZWxzZSBpZiAoZXZlbnQgPT09IFwiZXJyb3JcIikgeyBydW5zLmRlbGV0ZShjLnJ1bik7IHB1c2goeyB0eXBlOiBcInRvb2wuZXJyb3JcIiwgcnVuOiBjLnJ1biwgbWVzc2FnZTogZGF0YS5tZXNzYWdlIH0pOyB9XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChydW5zLmhhcyhjLnJ1bikpIHsgcnVucy5kZWxldGUoYy5ydW4pOyBwdXNoKHsgdHlwZTogXCJ0b29sLmVycm9yXCIsIHJ1bjogYy5ydW4sIG1lc3NhZ2U6IFwidGhlIHNlcnZlciBjbG9zZWQgdGhlIHN0cmVhbSB3aXRob3V0IGEgcmVzdWx0XCIgfSk7IH1cbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgaWYgKCFhYm9ydC5zaWduYWwuYWJvcnRlZCAmJiBydW5zLmhhcyhjLnJ1bikpIHsgcnVucy5kZWxldGUoYy5ydW4pOyBwdXNoKHsgdHlwZTogXCJ0b29sLmVycm9yXCIsIHJ1bjogYy5ydW4sIG1lc3NhZ2U6IChlcnIgYXMgRXJyb3IpLm1lc3NhZ2UgfSk7IH1cbiAgfVxufVxuXG5mdW5jdGlvbiBtaWNPcHRpb25zKCkge1xuICBjb25zdCBhZWMgPSBjaGVja2VkKFwiYWVjXCIpO1xuICByZXR1cm4geyBlY2hvQ2FuY2VsbGF0aW9uOiBhZWMsIG5vaXNlU3VwcHJlc3Npb246IGFlYywgYXV0b0dhaW5Db250cm9sOiBhZWMgfTtcbn1cblxuZnVuY3Rpb24gbnVtYmVyU2V0dGluZyhpZDogc3RyaW5nLCBmYWxsYmFjazogbnVtYmVyLCBtaW4gPSAwLCBtYXggPSAzNjAwKTogbnVtYmVyIHtcbiAgY29uc3QgbiA9IE51bWJlcigkPEhUTUxJbnB1dEVsZW1lbnQ+KGlkKS52YWx1ZSk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobikgPyBNYXRoLm1heChtaW4sIE1hdGgubWluKG1heCwgbikpIDogZmFsbGJhY2s7XG59XG5cbmZ1bmN0aW9uIGRldmVsb3Blck92ZXJyaWRlcygpIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBnaXZlbiA9IEpTT04ucGFyc2UoJDxIVE1MVGV4dEFyZWFFbGVtZW50PihcImNvbmZpZ1wiKS52YWx1ZSk7XG4gICAgaWYgKCFnaXZlbiB8fCB0eXBlb2YgZ2l2ZW4gIT09IFwib2JqZWN0XCIpIHtcbiAgICAgIHJldHVybiB7IG5vbldlYlBsYXRmb3JtOiBudWxsIGFzIHN0cmluZyB8IG51bGwsIGhhc0F0dGVudGlvbjogZmFsc2UsIGhhc0hhbmdVcDogZmFsc2UsIGhhc1N0YW5kYnk6IGZhbHNlLCBoYXNNaWNXaGlsZVNwZWFraW5nOiBmYWxzZSB9O1xuICAgIH1cbiAgICBjb25zdCBub25XZWJQbGF0Zm9ybSA9IHR5cGVvZiBnaXZlbi5wbGF0Zm9ybSA9PT0gXCJzdHJpbmdcIiAmJiBnaXZlbi5wbGF0Zm9ybSAhPT0gXCJ3ZWJcIiA/IGdpdmVuLnBsYXRmb3JtIDogbnVsbDtcbiAgICBjb25zdCBtaWMgPSBnaXZlbi5taWMgJiYgdHlwZW9mIGdpdmVuLm1pYyA9PT0gXCJvYmplY3RcIiA/IGdpdmVuLm1pYyA6IG51bGw7XG4gICAgcmV0dXJuIHtcbiAgICAgIG5vbldlYlBsYXRmb3JtLFxuICAgICAgaGFzQXR0ZW50aW9uOiBnaXZlbi5hdHRlbnRpb24gIT09IHVuZGVmaW5lZCxcbiAgICAgIGhhc0hhbmdVcDogZ2l2ZW4uaGFuZ1VwQWZ0ZXIgIT09IHVuZGVmaW5lZCxcbiAgICAgIGhhc1N0YW5kYnk6IGdpdmVuLnN0YW5kYnlBZnRlciAhPT0gdW5kZWZpbmVkLFxuICAgICAgaGFzTWljV2hpbGVTcGVha2luZzogbWljICE9IG51bGwgJiYgbWljLndoaWxlU3BlYWtpbmcgIT09IHVuZGVmaW5lZCxcbiAgICB9O1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4geyBub25XZWJQbGF0Zm9ybTogbnVsbCBhcyBzdHJpbmcgfCBudWxsLCBoYXNBdHRlbnRpb246IGZhbHNlLCBoYXNIYW5nVXA6IGZhbHNlLCBoYXNTdGFuZGJ5OiBmYWxzZSwgaGFzTWljV2hpbGVTcGVha2luZzogZmFsc2UgfTtcbiAgfVxufVxuXG5mdW5jdGlvbiByZWFkQ29uZmlnKCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgY29uc3QgZ2l2ZW4gPSBKU09OLnBhcnNlKCQ8SFRNTFRleHRBcmVhRWxlbWVudD4oXCJjb25maWdcIikudmFsdWUpO1xuICBjb25zdCBjb25maWc6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgIG1vZGVsOiBzZXJ2ZXIubW9kZWwsIGFwaTogc2VydmVyLnJvdXRlID09PSBcInZlcnRleFwiID8gXCJ2ZXJ0ZXhcIiA6IFwiZ2VtaW5pXCIsIHRvZGF5OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkuc2xpY2UoMCwgMTApLFxuICAgIC4uLmdpdmVuLCB0cmFjZTogY2hlY2tlZChcInRyYWNlXCIpLFxuICB9O1xuICBpZiAoY2hlY2tlZChcInB0dFwiKSkgY29uZmlnLm11dGVkID0gdHJ1ZTtcbiAgaWYgKGdpdmVuLnZvaWNlID09PSB1bmRlZmluZWQpIGNvbmZpZy52b2ljZSA9ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwidm9pY2VcIikudmFsdWU7XG4gIGlmIChjb25maWcuc3RlZXJpbmcgPT09IHVuZGVmaW5lZCkgY29uZmlnLnN0ZWVyaW5nID0gW1wiaGVybWVzXCIsIFwidDNcIl07XG4gIC8vIEEgd2ViIGNvbmZpZyBzYXZlZCBiZWZvcmUgaGFuZC1vZmZzIHdlcmUgbmFtZWQgaW4gd29yZHMgZ2V0cyB0aGF0IHRvby5cbiAgaWYgKGNvbmZpZy5oYW5kT2ZmID09PSB1bmRlZmluZWQgJiYgY29uZmlnLnBsYXRmb3JtID09PSBcIndlYlwiKSBjb25maWcuaGFuZE9mZiA9IFwibmFtZWRcIjtcbiAgLy8gQW5kIG9uZSBzYXZlZCBiZWZvcmUgdGhlIHBhZ2UgZm9sbG93ZWQgdGhlIHVzZXIncyBsZWFkIChzdXBlcnZpc2UpIGdldHMgdGhhdC5cbiAgaWYgKGNvbmZpZy5zdXBlcnZpc2UgPT09IHVuZGVmaW5lZCAmJiBjb25maWcucGxhdGZvcm0gPT09IFwid2ViXCIpIGNvbmZpZy5zdXBlcnZpc2UgPSB0cnVlO1xuICBpZiAoY2hlY2tlZChcImNvZGluZ1wiKSAmJiAoc2VydmVyLnQzIHx8IGNoZWNrZWQoXCJmYWtlaGVybWVzXCIpKSAmJiBjb25maWcuY29kaW5nQWdlbnQgPT09IHVuZGVmaW5lZCkgY29uZmlnLmNvZGluZ0FnZW50ID0geyBwcm9qZWN0czogc2VydmVyLnQzID8/IFtdIH07XG4gIGlmIChjaGVja2VkKFwiY2FwdGlvbnNcIikgJiYgc2VydmVyLmNhcHRpb25zTW9kZWwgJiYgY29uZmlnLmNhcHRpb25zID09PSB1bmRlZmluZWQpIGNvbmZpZy5jYXB0aW9ucyA9IHsgbW9kZWw6IHNlcnZlci5jYXB0aW9uc01vZGVsIH07XG4gIC8vIEFwcGx5IGVhY2ggU2V0dGluZ3Mgc2lnbmFsaW5nIGZpZWxkIGluZGVwZW5kZW50bHkgZm9yIHdlYiBjb25maWdzIHVubGVzcyBzZXQgaW4gRGV2ZWxvcGVyIEpTT04gLyBwcmVzZXQuXG4gIGNvbnN0IG5vbldlYiA9IHR5cGVvZiBnaXZlbi5wbGF0Zm9ybSA9PT0gXCJzdHJpbmdcIiAmJiBnaXZlbi5wbGF0Zm9ybSAhPT0gXCJ3ZWJcIjtcbiAgaWYgKCFub25XZWIpIHtcbiAgICBjb25zdCBzaWduYWxpbmcgPSAkPEhUTUxTZWxlY3RFbGVtZW50PihcInNpZ25hbGluZ1wiKS52YWx1ZTtcbiAgICBpZiAoZ2l2ZW4uYXR0ZW50aW9uID09PSB1bmRlZmluZWQgJiYgKHNpZ25hbGluZyA9PT0gXCJ3aW5kb3dcIiB8fCBzaWduYWxpbmcgPT09IFwiZWNob1wiKSkge1xuICAgICAgY29uZmlnLmF0dGVudGlvbiA9IHtcbiAgICAgICAgbW9kZTogXCJ3aW5kb3dcIixcbiAgICAgICAgYWZ0ZXJXYWtlOiBudW1iZXJTZXR0aW5nKFwiYXR0bi1hZnRlci13YWtlXCIsIDgsIDEsIDYwKSxcbiAgICAgICAgd2luZG93OiBudW1iZXJTZXR0aW5nKFwiYXR0bi13aW5kb3dcIiwgNSwgMCwgNjApLFxuICAgICAgICBhZnRlclF1ZXN0aW9uOiBudW1iZXJTZXR0aW5nKFwiYXR0bi1hZnRlci1xdWVzdGlvblwiLCAxMCwgMCwgNjApLFxuICAgICAgICBhZnRlckhhbmRPZmY6IDMsXG4gICAgICAgIGFmdGVyQW5ub3VuY2VtZW50OiAwLFxuICAgICAgfTtcbiAgICB9XG4gICAgaWYgKGdpdmVuLmhhbmdVcEFmdGVyID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbmZpZy5oYW5nVXBBZnRlciA9IG51bWJlclNldHRpbmcoXCJoYW5ndXAtYWZ0ZXJcIiwgc2lnbmFsaW5nID09PSBcImVjaG9cIiA/IDE1IDogMzAwLCAwLCAzNjAwKTtcbiAgICB9XG4gICAgaWYgKHNpZ25hbGluZyA9PT0gXCJlY2hvXCIgJiYgZ2l2ZW4uc3RhbmRieUFmdGVyID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbmZpZy5zdGFuZGJ5QWZ0ZXIgPSA4O1xuICAgIH1cbiAgICBjb25zdCBnaXZlbk1pYyA9IGdpdmVuLm1pYyAmJiB0eXBlb2YgZ2l2ZW4ubWljID09PSBcIm9iamVjdFwiID8gKGdpdmVuLm1pYyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgOiBudWxsO1xuICAgIGlmICgoIWdpdmVuTWljIHx8IGdpdmVuTWljLndoaWxlU3BlYWtpbmcgPT09IHVuZGVmaW5lZCkgJiYgKGNoZWNrZWQoXCJ3YWtlLWJhcmdlXCIpIHx8IHNpZ25hbGluZyA9PT0gXCJlY2hvXCIpKSB7XG4gICAgICBjb25maWcubWljID0geyBnYWluRGI6IDAsIC4uLihnaXZlbk1pYyA/PyB7fSksIHdoaWxlU3BlYWtpbmc6IFwid2FrZVwiIH07XG4gICAgfVxuICB9XG4gIHJldHVybiBjb25maWc7XG59XG5cbi8qKiBTdGFydHMgYSB2b2ljZSBjYWxsLCBvciB3aXRoIFt0eXBlZF0gYSBjaGF0ICh0aGUgY29yZSdzIG1lZGl1bSBcInRleHRcIjogbm8gYXVkaW8sIGEgdGV4dCBtb2RlbCkuICovXG5hc3luYyBmdW5jdGlvbiBzdGFydChjYXJyeU9uID0gZmFsc2UsIHR5cGVkID0gZmFsc2UpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgaWYgKHN0YXJ0aW5nQ2FsbCB8fCBjYWxsSWQpIHJldHVybiBmYWxzZTtcbiAgc3RhcnRpbmdDYWxsID0gdHJ1ZTtcbiAgdHJ5IHtcbiAgICBhd2FpdCBlbmRpbmc7XG4gICAgaWYgKGNhbGxJZCkgcmV0dXJuIGZhbHNlO1xuICAgIGxldCBnaXZlbjogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgdHJ5IHtcbiAgICAgIGdpdmVuID0gcmVhZENvbmZpZygpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgdG9hc3QoYFRoZSBkZXZlbG9wZXIgc2V0dGluZ3MgYXJlbid0IHZhbGlkIEpTT046ICR7KGVyciBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgaWYgKHR5cGVkKSB7XG4gICAgICBpZiAoIXNlcnZlci50ZXh0TW9kZWwpIHsgdG9hc3QoXCJUaGlzIHNlcnZlciBoYXMgbm8gdGV4dCBtb2RlbCBmb3IgYSBjaGF0OiBzdGFydCBhIGNhbGwgdG8gdHlwZSB0byBpdFwiKTsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICBnaXZlbiA9IHsgLi4uZ2l2ZW4sIG1lZGl1bTogXCJ0ZXh0XCIsIG11dGVkOiBmYWxzZSB9O1xuICAgICAgZGVsZXRlIGdpdmVuLmNhcHRpb25zO1xuICAgIH1cbiAgICAkPEhUTUxCdXR0b25FbGVtZW50PihcImNhbGxcIikuZGlzYWJsZWQgPSB0cnVlO1xuICAgICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiaGVyby1jYWxsXCIpLmRpc2FibGVkID0gdHJ1ZTtcbiAgICBpZiAoXCJOb3RpZmljYXRpb25cIiBpbiB3aW5kb3cgJiYgTm90aWZpY2F0aW9uLnBlcm1pc3Npb24gPT09IFwiZGVmYXVsdFwiKSB2b2lkIE5vdGlmaWNhdGlvbi5yZXF1ZXN0UGVybWlzc2lvbigpLmNhdGNoKCgpID0+IHt9KTtcbiAgICBsZXQgbG9hZGVkQ29yZTogQ29yZTtcbiAgICB0cnkge1xuICAgICAgaWYgKCF0eXBlZCkgYXdhaXQgYXVkaW8ub3BlbigpO1xuICAgICAgbG9hZGVkQ29yZSA9IGF3YWl0IGxvYWRDb3JlKCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiY2FsbFwiKS5kaXNhYmxlZCA9IGZhbHNlO1xuICAgICAgJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJoZXJvLWNhbGxcIikuZGlzYWJsZWQgPSBmYWxzZTtcbiAgICB9XG4gICAgaWYgKGNhbGxJZCkgcmV0dXJuIGZhbHNlO1xuICAgIGNvcmUgPSBsb2FkZWRDb3JlO1xuICAgIGlmICh0eXBlZCkge1xuICAgICAgd2FrZVN0YXJ0aW5nID0gZmFsc2U7XG4gICAgICBvcGVuaW5nQ2h1bmtzID0gW107XG4gICAgICBvcGVuaW5nQnl0ZXMgPSAwO1xuICAgICAgaWYgKHdha2VBcm1lZCkgYXVkaW8uc3RvcE1pYygpO1xuICAgIH1cbiAgICBtZWRpdW0gPSB0eXBlZCA/IFwidGV4dFwiIDogXCJ2b2ljZVwiO1xuICAgIHRoaW5raW5nID0gZmFsc2U7XG4gICAgJChcInZlcnNpb25cIikudGV4dENvbnRlbnQgPSBjb3JlLnZlcnNpb247XG4gICAgJChcImxvZ1wiKS5pbm5lckhUTUwgPSBcIlwiO1xuICAgIGlmICghdHlwZWQgJiYgKHRhc2tzLnNpemUgPiAwIHx8ICQoXCJ0cmFuc2NyaXB0XCIpLmNoaWxkRWxlbWVudENvdW50ID4gMSkpIG5vdGUoYE5ldyBjYWxsIFx1MDBCNyAke25ldyBEYXRlKCkudG9Mb2NhbGVUaW1lU3RyaW5nKCl9YCk7XG4gICAgc2Nyb2xsRG93bih0cnVlKTtcbiAgICB0YXNrcy5jbGVhcigpO1xuICAgIGFjdGl2ZVNlc3Npb24gPSArK3Nlc3Npb25TZXE7XG4gICAgc2hvd1Rhc2tzKCk7XG4gICAgY291bnRzID0geyBtaWM6IDAsIHBsYXk6IDAsIHNlbnQ6IDAgfTtcbiAgICBtZXRyaWNzLnJlcGx5ID0gW107XG4gICAgc3RhcnRlZEF0ID0gbm93KCk7XG4gICAgbXV0ZWQgPSBnaXZlbi5tdXRlZCA9PT0gdHJ1ZTtcbiAgICBjb25zdCBtaWNDZmcgPSBnaXZlbi5taWMgJiYgdHlwZW9mIGdpdmVuLm1pYyA9PT0gXCJvYmplY3RcIiA/IChnaXZlbi5taWMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIDogbnVsbDtcbiAgICBjYWxsV2hpbGVTcGVha2luZyA9IHR5cGVvZiBtaWNDZmc/LndoaWxlU3BlYWtpbmcgPT09IFwic3RyaW5nXCIgPyBtaWNDZmcud2hpbGVTcGVha2luZyA6IFwic2VuZFwiO1xuICAgIGNvcmVTcGVlY2hVbnRpbCA9IDA7XG4gICAgLy8gQ2Fycnlpbmcgb246IHRoZSBtb2RlbCBnZXRzIHRoZSBsYXN0IGNvbnZlcnNhdGlvbiBhcyBhIHJlY2FwLiBUaGUgY29yZSBjYXBzIGl0LCBsYXRlc3QgbGluZXMgZmlyc3QuXG4gICAgLy8gQSBjaGF0IGFsd2F5cyBjYXJyaWVzIG9uIGZyb20gd2hhdCdzIG9uIHRoZSBzY3JlZW4gKGFuIGVhcmxpZXIgY2FsbCBvciBjaGF0IG9uIHRoaXMgcGFnZSkuXG4gICAgaWYgKHR5cGVkKSB7IGlmIChjaGF0Lmxlbmd0aCA+IDAgJiYgZ2l2ZW4uaGlzdG9yeSA9PT0gdW5kZWZpbmVkKSBnaXZlbi5oaXN0b3J5ID0gY2hhdDsgfVxuICAgIGVsc2UgaWYgKGNhcnJ5T24gJiYgZ2l2ZW4uaGlzdG9yeSA9PT0gdW5kZWZpbmVkKSBnaXZlbi5oaXN0b3J5ID0gc2F2ZWRIaXN0b3J5KCk7XG4gICAgZWxzZSBpZiAoIWNhcnJ5T24pIGNoYXQgPSBbXTtcbiAgICBpZiAoY2FycnlPbiAmJiAhdHlwZWQpIGNoYXQgPSBzYXZlZEhpc3RvcnkoKTtcbiAgICBsYXN0TGluZSA9IG51bGw7XG4gICAgb3BlbkxpbmUgPSBudWxsO1xuICAgIHN5bmNSZXN1bWVCdXR0b25zKGZhbHNlKTtcbiAgICBjYWxsTmFtZSA9IGAke25ldyBEYXRlKCkudG9JU09TdHJpbmcoKS5yZXBsYWNlKC9bOi5dL2csIFwiLVwiKX0tJHt0eXBlZCA/IFwiY2hhdFwiIDogXCJ3ZWJcIn0tJHtjb3JlLnZlcnNpb259YDtcbiAgICBjb25zdCBjcmVhdGVkID0gSlNPTi5wYXJzZShjb3JlLmNyZWF0ZShKU09OLnN0cmluZ2lmeShnaXZlbiksIG5vdygpKSk7XG4gICAgY2FsbElkID0gY3JlYXRlZC5pZDtcbiAgICBpZiAoIXR5cGVkKSB7XG4gICAgICBzZXRDYWxsQnV0dG9uKHRydWUpO1xuICAgICAgJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJtaWNcIikuZGlzYWJsZWQgPSBmYWxzZTtcbiAgICB9XG4gICAgJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJodXNoXCIpLmRpc2FibGVkID0gZmFsc2U7XG4gICAgJChcIm1pY1wiKS5jbGFzc0xpc3QudG9nZ2xlKFwibXV0ZWRcIiwgbXV0ZWQpO1xuICAgIHJ1bihjcmVhdGVkLmNvbW1hbmRzKTtcbiAgICBzaG93U3RhdHVzKCk7XG4gICAgdGlja2VyID0gd2luZG93LnNldEludGVydmFsKCgpID0+IHtcbiAgICAgIHB1c2goeyB0eXBlOiBcInRpY2tcIiB9KTtcbiAgICAgIGNvbnN0IGxldmVsID0gbXV0ZWQgJiYgIWhvbGRpbmcgPyAwIDogYXVkaW8ubGV2ZWw7XG4gICAgICBjb25zdCBzdHJlbmd0aCA9IE1hdGgubWluKDEsIGxldmVsICogMTIpO1xuICAgICAgJChcInJpbmdcIikuc3R5bGUub3BhY2l0eSA9IFN0cmluZyhzdHJlbmd0aCk7XG4gICAgICAkKFwicmluZ1wiKS5zdHlsZS50cmFuc2Zvcm0gPSBgc2NhbGUoJHsoMSArIHN0cmVuZ3RoICogMC4xMikudG9GaXhlZCgzKX0pYDtcbiAgICAgICQoXCJjb3VudHNcIikudGV4dENvbnRlbnQgPSBgbWljICR7Y291bnRzLm1pY30gXHUwMEI3IHNlbnQgJHtjb3VudHMuc2VudH0gXHUwMEI3IHBsYXllZCAke2NvdW50cy5wbGF5fSBcdTAwQjcgcXVldWVkICR7YXVkaW8ucXVldWVkLnRvRml4ZWQoMSl9IHNgO1xuICAgICAgc2hvd1N0YXR1cygpO1xuICAgIH0sIDEwMCk7XG4gICAgdHJhY2VUaW1lciA9IHdpbmRvdy5zZXRJbnRlcnZhbCgoKSA9PiB7IHZvaWQgc2F2ZVRyYWNlKCk7IHZvaWQgcGluZygpOyBzaG93VGFza3MoKTsgfSwgNTAwMCk7XG4gICAgdm9pZCBwaW5nKCk7XG4gICAgaWYgKCF0eXBlZCkge1xuICAgICAgc3RvcFdvcmRzLnN0YXJ0KCk7XG4gICAgICBhd2FpdCBhY3F1aXJlV2FrZUxvY2soKTtcbiAgICB9XG4gICAgcmV0dXJuIHRydWU7XG4gIH0gZmluYWxseSB7XG4gICAgc3RhcnRpbmdDYWxsID0gZmFsc2U7XG4gIH1cbn1cblxuLyoqIFRoZSBDYWxsIGJ1dHRvbjogaGFuZ3MgdXAgYSBjYWxsOyBzdGFydHMgb25lOyBvciwgd2l0aCBhIGNoYXQgb24sIGVuZHMgdGhlIGNoYXQgYW5kIGNhcnJpZXMgaXRzIGNvbnZlcnNhdGlvbiBvbiBieSB2b2ljZS4gKi9cbmFzeW5jIGZ1bmN0aW9uIGNhbGxCdXR0b24oKSB7XG4gIGlmIChjYWxsSWQgJiYgbWVkaXVtID09PSBcInZvaWNlXCIpIHsgaGFuZ1VwKCk7IHJldHVybjsgfVxuICBpZiAoY2FsbElkKSB7XG4gICAgLy8gQSBjYWxsIGNhbid0IHRha2Ugb3ZlciB0aGUgY2hhdCdzIHRhc2tzLCBhbmQgZW5kaW5nIHRoZSBjaGF0IHdvdWxkIHN0b3AgdGhlbS5cbiAgICBpZiAoWy4uLnRhc2tzLnZhbHVlcygpXS5zb21lKCh2KSA9PiB2LmMuc3RhdGUgPT09IFwicnVubmluZ1wiKSkgeyB0b2FzdChcIlRoZSBjaGF0J3MgdGFza3MgYXJlIHN0aWxsIHJ1bm5pbmc6IHdhaXQgZm9yIHRoZW0gb3IgY2FuY2VsIHRoZW0sIHRoZW4gY2FsbFwiKTsgcmV0dXJuOyB9XG4gICAgcHVzaCh7IHR5cGU6IFwic3RvcFwiIH0pO1xuICAgIGF3YWl0IHN0YXJ0KHRydWUpO1xuICAgIHJldHVybjtcbiAgfVxuICBhd2FpdCBzdGFydCgpO1xufVxuXG5mdW5jdGlvbiBoYW5nVXAoKSB7XG4gIGlmIChjYWxsSWQpIHB1c2goeyB0eXBlOiBcInN0b3BcIiwgbWVzc2FnZTogXCJZb3UgaHVuZyB1cC5cIiB9KTtcbn1cblxuZnVuY3Rpb24gZW5kKCkge1xuICB3aW5kb3cuY2xlYXJJbnRlcnZhbCh0aWNrZXIpO1xuICB3aW5kb3cuY2xlYXJJbnRlcnZhbCh0cmFjZVRpbWVyKTtcbiAgc3RvcFdvcmRzLnN0b3AoKTtcbiAgYWN0aXZlU2Vzc2lvbiA9IDA7XG4gIHN5bmNSZXN1bHRGb2xsb3dVcEJ1dHRvbnMoKTtcbiAgY29yZVdhbnRzV2FrZSA9IGZhbHNlO1xuICBjb3JlU3BlZWNoVW50aWwgPSAwO1xuICB3YWtlU3RhcnRpbmcgPSBmYWxzZTtcbiAgb3BlbmluZ0NodW5rcyA9IFtdO1xuICBvcGVuaW5nQnl0ZXMgPSAwO1xuICBjb25zdCBmaW5pc2hlZElkID0gY2FsbElkO1xuICBjb25zdCBmaW5pc2hlZENvcmUgPSBjb3JlO1xuICBjYWxsSWQgPSAwO1xuICBlbmRpbmcgPSBzYXZlVHJhY2UoZmluaXNoZWRJZCwgZmluaXNoZWRDb3JlKS50aGVuKCgpID0+IHsgaWYgKGZpbmlzaGVkQ29yZSAmJiBmaW5pc2hlZElkKSBmaW5pc2hlZENvcmUuZGlzcG9zZShmaW5pc2hlZElkKTsgc2hvd1Rhc2tzKCk7IHN5bmNXYWtlVWkoKTsgfSk7XG4gIGlmICh3YWtlQXJtZWQpIHtcbiAgICBhdWRpby5zdG9wUGxheWJhY2soKTtcbiAgICB3YWtlQ2xpZW50LnJlc2V0KCk7XG4gICAgdm9pZCBhdWRpby5lbnN1cmVNaWMob25NaWMsIG1pY09wdGlvbnMoKSkuY2F0Y2goKGVycikgPT4ge1xuICAgICAgbG9nKFwiZXJyb3JcIiwgYHdha2UgbWljcm9waG9uZTogJHtlcnIubWVzc2FnZX1gLCBcImVyclwiKTtcbiAgICAgIHRvYXN0KGBXYWtlIG1pY3JvcGhvbmU6ICR7ZXJyLm1lc3NhZ2V9YCk7XG4gICAgICB2b2lkIGFybVdha2UoZmFsc2UpO1xuICAgIH0pO1xuICB9IGVsc2Uge1xuICAgIGF1ZGlvLnN0b3AoKTtcbiAgICByZWxlYXNlV2FrZUxvY2soKTtcbiAgfVxuICBmb3IgKGNvbnN0IHdzIG9mIHNvY2tldHMudmFsdWVzKCkpIHdzLmNsb3NlKCk7XG4gIHNvY2tldHMuY2xlYXIoKTtcbiAgZm9yIChjb25zdCByIG9mIHJ1bnMudmFsdWVzKCkpIHIuYWJvcnQuYWJvcnQoKTtcbiAgcnVucy5jbGVhcigpO1xuICBmb3IgKGNvbnN0IHIgb2YgcmVxdWVzdHMudmFsdWVzKCkpIHIuYWJvcnQoKTtcbiAgcmVxdWVzdHMuY2xlYXIoKTtcbiAgdGhpbmtpbmcgPSBmYWxzZTtcbiAgc2V0Q2FsbEJ1dHRvbihmYWxzZSk7XG4gIGZvciAoY29uc3QgaWQgb2YgW1wibWljXCIsIFwiaHVzaFwiXSkgJDxIVE1MQnV0dG9uRWxlbWVudD4oaWQpLmRpc2FibGVkID0gdHJ1ZTtcbiAgJChcInJpbmdcIikuc3R5bGUub3BhY2l0eSA9IFwiMFwiO1xuICAkKFwicmluZ1wiKS5zdHlsZS50cmFuc2Zvcm0gPSBcIlwiO1xuICAkKFwiY2FsbGJhclwiKS5oaWRkZW4gPSB0cnVlO1xuICAkKFwibWljd2FyblwiKS5oaWRkZW4gPSB0cnVlO1xuICBkb2N1bWVudC5ib2R5LmRhdGFzZXQuc3RhdGUgPSB3YWtlQXJtZWQgPyBcImFybWVkXCIgOiBcImlkbGVcIjtcbiAgZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QucmVtb3ZlKFwiaW4tc2Vzc2lvblwiKTtcbiAgc3luY1Jlc3VtZUJ1dHRvbnMoY2hhdC5sZW5ndGggPiAwKTtcbiAgdm9pZCBzaG93RWFybGllcigpO1xuICBzeW5jV2FrZVVpKCk7XG59XG5cbmZ1bmN0aW9uIHNldE11dGVkKHZhbHVlOiBib29sZWFuKSB7XG4gIGlmICghY2FsbElkIHx8IG11dGVkID09PSB2YWx1ZSkgcmV0dXJuO1xuICBtdXRlZCA9IHZhbHVlO1xuICAkKFwibWljXCIpLmNsYXNzTGlzdC50b2dnbGUoXCJtdXRlZFwiLCBtdXRlZCk7XG4gIHB1c2goeyB0eXBlOiBtdXRlZCA/IFwibXV0ZVwiIDogXCJ1bm11dGVcIiB9KTtcbiAgc2hvd1N0YXR1cygpO1xufVxuXG4vKiogU2VuZHMgd2hhdCB0aGUgdHJhY2Uga2VwdCBzaW5jZSBsYXN0IHRpbWUgdG8gdGhlIGRldiBzZXJ2ZXIsIGFzIEpTT04gbGluZXM6IGEgaGVhZGVyLCB0aGVuIGV2ZW50cy4gKi9cbmFzeW5jIGZ1bmN0aW9uIHNhdmVUcmFjZShpZCA9IGNhbGxJZCwgdGFyZ2V0Q29yZSA9IGNvcmUpIHtcbiAgaWYgKCF0YXJnZXRDb3JlIHx8ICFpZCB8fCAhY2hlY2tlZChcInRyYWNlXCIpKSByZXR1cm47XG4gIGNvbnN0IGtlcHQgPSBKU09OLnBhcnNlKHRhcmdldENvcmUudHJhY2UoaWQpKTtcbiAgaWYgKCFrZXB0KSByZXR1cm47XG4gIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICBpZiAoa2VwdC5jb25maWcpIGxpbmVzLnB1c2goSlNPTi5zdHJpbmdpZnkoeyB2ZXJzaW9uOiBrZXB0LnZlcnNpb24sIGNvbmZpZzoga2VwdC5jb25maWcsIHN0YXJ0OiBrZXB0LnN0YXJ0IH0pKTtcbiAgZm9yIChjb25zdCBlIG9mIGtlcHQuZXZlbnRzKSBsaW5lcy5wdXNoKEpTT04uc3RyaW5naWZ5KGUpKTtcbiAgaWYgKGxpbmVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuICBhd2FpdCBmZXRjaChgL3RyYWNlcz9uYW1lPSR7ZW5jb2RlVVJJQ29tcG9uZW50KGNhbGxOYW1lKX0uanNvbmxgLCB7IG1ldGhvZDogXCJQT1NUXCIsIGJvZHk6IGxpbmVzLmpvaW4oXCJcXG5cIikgKyBcIlxcblwiIH0pLmNhdGNoKCgpID0+IHt9KTtcbiAgJChcInRyYWNlbmFtZVwiKS50ZXh0Q29udGVudCA9IGB0cmFjZSAke2NhbGxOYW1lfS5qc29ubGA7XG59XG5cbi8vIFwiU3RvcFwiIGFuZCBcImdvb2RieWVcIiBoZWFyZCBieSB0aGUgYnJvd3NlcidzIG93biByZWNvZ25pemVyOiBxdWlja2VyIHRoYW4gdGhlIG1vZGVsJ3MgdHJhbnNjcmlwdCxcbi8vIGFuZCBpdCB3b3JrcyB3aGlsZSB0aGUgbW9kZWwncyByZXBseSBwbGF5cyBldmVuIHdoZW4gdGhlIG1vZGVsIGlzbid0IGhlYXJpbmcgdGhlIG1pY3JvcGhvbmUuXG5cbmNsYXNzIFN0b3BXb3JkcyB7XG4gIHByaXZhdGUgcmVjOiBhbnkgPSBudWxsO1xuICBwcml2YXRlIG9uID0gZmFsc2U7XG4gIHByaXZhdGUgY29tbWFuZHMgPSB7IHN0b3A6IFtdIGFzIHN0cmluZ1tdLCBoYW5nVXA6IFtdIGFzIHN0cmluZ1tdLCBjYW5jZWxBbGw6IFtdIGFzIHN0cmluZ1tdIH07XG5cbiAgZ2V0IHN1cHBvcnRlZCgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gXCJ3ZWJraXRTcGVlY2hSZWNvZ25pdGlvblwiIGluIHdpbmRvdyB8fCBcIlNwZWVjaFJlY29nbml0aW9uXCIgaW4gd2luZG93O1xuICB9XG5cbiAgc3RhcnQoKSB7XG4gICAgaWYgKCFjaGVja2VkKFwic3RvcHdvcmRcIikgfHwgIXRoaXMuc3VwcG9ydGVkIHx8ICFjb3JlKSByZXR1cm47XG4gICAgdGhpcy5jb21tYW5kcyA9IEpTT04ucGFyc2UoY29yZS5kZWZhdWx0cygpKS52b2ljZUNvbW1hbmRzO1xuICAgIGNvbnN0IFJlY29nbml0aW9uID0gKHdpbmRvdyBhcyBhbnkpLlNwZWVjaFJlY29nbml0aW9uID8/ICh3aW5kb3cgYXMgYW55KS53ZWJraXRTcGVlY2hSZWNvZ25pdGlvbjtcbiAgICB0aGlzLnJlYyA9IG5ldyBSZWNvZ25pdGlvbigpO1xuICAgIHRoaXMucmVjLmNvbnRpbnVvdXMgPSB0cnVlO1xuICAgIHRoaXMucmVjLmludGVyaW1SZXN1bHRzID0gdHJ1ZTtcbiAgICB0aGlzLnJlYy5sYW5nID0gbmF2aWdhdG9yLmxhbmd1YWdlIHx8IFwiZW4tR0JcIjtcbiAgICB0aGlzLnJlYy5vbnJlc3VsdCA9IChlOiBhbnkpID0+IHtcbiAgICAgIGZvciAobGV0IGkgPSBlLnJlc3VsdEluZGV4OyBpIDwgZS5yZXN1bHRzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIGNvbnN0IHRleHQgPSBlLnJlc3VsdHNbaV1bMF0udHJhbnNjcmlwdCBhcyBzdHJpbmc7XG4gICAgICAgIGNvbnN0IGNvbW1hbmQgPSBjb21tYW5kSW4odGV4dCwgdGhpcy5jb21tYW5kcywgW1wiV29vZGhvdXNlXCIsIFwiSGVybWVzXCIsIFwiQmVudG9cIl0pO1xuICAgICAgICBpZiAoY29tbWFuZCA9PT0gXCJzdG9wXCIgJiYgYXVkaW8ucXVldWVkID4gMC4wNSkge1xuICAgICAgICAgIGxvZyhcIm91dFwiLCBgbG9jYWwgc3RvcCB3b3JkOiAke3RleHR9YCwgXCJvdXRcIik7XG4gICAgICAgICAgdG9hc3QoYEhlYXJkIFx1MjAxQyR7dGV4dC50cmltKCl9XHUyMDFEOiBzdG9wcGVkYCk7XG4gICAgICAgICAgcHVzaCh7IHR5cGU6IFwiaW50ZXJydXB0XCIgfSk7XG4gICAgICAgIH0gZWxzZSBpZiAoY29tbWFuZCA9PT0gXCJjYW5jZWxBbGxcIiAmJiBlLnJlc3VsdHNbaV0uaXNGaW5hbCkge1xuICAgICAgICAgIGxvZyhcIm91dFwiLCBgbG9jYWwgY2FuY2VsLWFsbDogJHt0ZXh0fWAsIFwib3V0XCIpO1xuICAgICAgICAgIHB1c2goeyB0eXBlOiBcImNhbmNlbEFsbFwiIH0pO1xuICAgICAgICAgIHB1c2goeyB0eXBlOiBcImludGVycnVwdFwiIH0pO1xuICAgICAgICB9IGVsc2UgaWYgKGNvbW1hbmQgPT09IFwiaGFuZ1VwXCIgJiYgZS5yZXN1bHRzW2ldLmlzRmluYWwpIHtcbiAgICAgICAgICBsb2coXCJvdXRcIiwgYGxvY2FsIGhhbmctdXA6ICR7dGV4dH1gLCBcIm91dFwiKTtcbiAgICAgICAgICBoYW5nVXAoKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH07XG4gICAgdGhpcy5yZWMub25lbmQgPSAoKSA9PiB7IGlmICh0aGlzLm9uKSBzZXRUaW1lb3V0KCgpID0+IHsgdHJ5IHsgdGhpcy5yZWM/LnN0YXJ0KCk7IH0gY2F0Y2gge30gfSwgMjUwKTsgfTtcbiAgICB0aGlzLnJlYy5vbmVycm9yID0gKGU6IGFueSkgPT4geyBpZiAoZS5lcnJvciA9PT0gXCJub3QtYWxsb3dlZFwiKSB0aGlzLm9uID0gZmFsc2U7IH07XG4gICAgdGhpcy5vbiA9IHRydWU7XG4gICAgdHJ5IHsgdGhpcy5yZWMuc3RhcnQoKTsgfSBjYXRjaCB7fVxuICB9XG5cbiAgc3RvcCgpIHtcbiAgICB0aGlzLm9uID0gZmFsc2U7XG4gICAgdHJ5IHsgdGhpcy5yZWM/LnN0b3AoKTsgfSBjYXRjaCB7fVxuICAgIHRoaXMucmVjID0gbnVsbDtcbiAgfVxufVxuY29uc3Qgc3RvcFdvcmRzID0gbmV3IFN0b3BXb3JkcygpO1xuXG4vLyBMb2NhbCB3YWtlIHdvcmQgbG9vcCAoTGl2ZUtpdCBXYWtlV29yZCBPTk5YIGluIGEgV2ViIFdvcmtlcik6IGxpc3RlbnMgYmV0d2VlbiBjYWxscyB3aGVuIGFybWVkLFxuLy8gYW5kIGluc2lkZSBhbiBhY3RpdmUgY2FsbCB3aGVuZXZlciB0aGUgY29yZSBhc2tzIChgd2FrZXdvcmQ6IG9uYDogZG9ybWFudCBvciB3aGlsZVNwZWFraW5nIFwid2FrZVwiKS5cblxuYXN5bmMgZnVuY3Rpb24gYWNxdWlyZVdha2VMb2NrKCkge1xuICBhd2FpdCBzY3JlZW5XYWtlTG9jay5hY3F1aXJlKCgpID0+ICFkb2N1bWVudC5oaWRkZW4gJiYgKGNhbGxJZCAhPT0gMCB8fCB3YWtlQXJtZWQpKTtcbn1cblxuZnVuY3Rpb24gcmVsZWFzZVdha2VMb2NrKCkge1xuICBzY3JlZW5XYWtlTG9jay5yZWxlYXNlKCk7XG59XG5cbmZ1bmN0aW9uIHNlbGVjdGVkV2FrZU1vZGVsKCk6IFdha2VNb2RlbEluZm8gfCBudWxsIHtcbiAgY29uc3QgbW9kZWxzID0gc2VydmVyPy53YWtlTW9kZWxzID8/IFtdO1xuICBpZiAobW9kZWxzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHBpY2sgPSAkPEhUTUxTZWxlY3RFbGVtZW50PihcIndha2UtbW9kZWxcIikudmFsdWU7XG4gIHJldHVybiBtb2RlbHMuZmluZCgobSkgPT4gbS5pZCA9PT0gcGljaykgPz8gbW9kZWxzLmZpbmQoKG0pID0+IG0uaWQgPT09IFwicGVubnl3b3J0aFwiKSA/PyBtb2RlbHNbMF07XG59XG5cbmZ1bmN0aW9uIHdha2VUaHJlc2hvbGQoKTogbnVtYmVyIHtcbiAgY29uc3QgbiA9IE51bWJlcigkPEhUTUxJbnB1dEVsZW1lbnQ+KFwid2FrZS10aHJlc2hvbGRcIikudmFsdWUpO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pID8gTWF0aC5tYXgoMC4xLCBNYXRoLm1pbigwLjk5LCBuKSkgOiAwLjc7XG59XG5cbmZ1bmN0aW9uIHNob3VsZEZlZWRXYWtlKCk6IGJvb2xlYW4ge1xuICBpZiAod2FrZVN0YXJ0aW5nIHx8IHN0YXJ0aW5nQ2FsbCkgcmV0dXJuIGZhbHNlO1xuICBpZiAoY2FsbElkID09PSAwKSByZXR1cm4gd2FrZUFybWVkO1xuICByZXR1cm4gbWVkaXVtID09PSBcInZvaWNlXCIgJiYgY29yZVdhbnRzV2FrZSAmJiAhKG11dGVkICYmICFob2xkaW5nKTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyV2FrZVRlbGVtZXRyeSgpIHtcbiAgY29uc3QgYWN0aXZlID0gKGNhbGxJZCA9PT0gMCAmJiB3YWtlQXJtZWQpIHx8IChjYWxsSWQgIT09IDAgJiYgbWVkaXVtID09PSBcInZvaWNlXCIgJiYgY29yZVdhbnRzV2FrZSk7XG4gIGlmICghYWN0aXZlKSB7ICQoXCJoZWFyZFwiKS50ZXh0Q29udGVudCA9IFwiXCI7IHJldHVybjsgfVxuICBjb25zdCBsYWJlbCA9IHNlbGVjdGVkV2FrZU1vZGVsKCk/LmxhYmVsID8/IFwid2FrZSB3b3JkXCI7XG4gIGlmICh3YWtlTG9hZGluZykgeyAkKFwiaGVhcmRcIikudGV4dENvbnRlbnQgPSBgTG9hZGluZyB3YWtlIHdvcmQgXHUyMDFDJHtsYWJlbH1cdTIwMURcdTIwMjZgOyByZXR1cm47IH1cbiAgaWYgKGNhbGxJZCA9PT0gMCAmJiBhdWRpby5hdWRpb1N1c3BlbmRlZCkgeyAkKFwiaGVhcmRcIikudGV4dENvbnRlbnQgPSBgQXVkaW8gcGF1c2VkIGJ5IGJyb3dzZXIgXHUwMEI3IHRhcCBvciBwcmVzcyBhIGtleSB0byByZXN1bWUgXHUyMDFDJHtsYWJlbH1cdTIwMURgOyByZXR1cm47IH1cbiAgaWYgKCF3YWtlTGFzdFRlbCkgeyAkKFwiaGVhcmRcIikudGV4dENvbnRlbnQgPSBgV2FrZSBcdTIwMUMke2xhYmVsfVx1MjAxRCByZWFkeSAodGhyZXNob2xkICR7d2FrZVRocmVzaG9sZCgpLnRvRml4ZWQoMil9KWA7IHJldHVybjsgfVxuICBjb25zdCBzdGF0ZSA9IHdha2VMYXN0VGVsLmdhdGVPcGVuID8gYHNjb3JpbmcgJHt3YWtlTGFzdFRlbC5zY29yZS50b0ZpeGVkKDIpfWAgOiBcInF1aWV0XCI7XG4gIGNvbnN0IHNwZWVkID0gd2FrZUxhc3RUZWwuaW5mZXJNcyA+IDAgPyBgIFx1MDBCNyAke3dha2VMYXN0VGVsLmluZmVyTXMudG9GaXhlZCgxKX0gbXNgIDogXCJcIjtcbiAgJChcImhlYXJkXCIpLnRleHRDb250ZW50ID0gYFdha2UgXHUyMDFDJHtsYWJlbH1cdTIwMUQgXHUwMEI3ICR7c3RhdGV9IFx1MDBCNyBwZWFrICR7d2FrZUxhc3RUZWwucGVhay50b0ZpeGVkKDIpfSR7c3BlZWR9YDtcbn1cblxuZnVuY3Rpb24gc3luY1dha2VVaSgpIHtcbiAgY29uc3QgbW9kZWwgPSBzZWxlY3RlZFdha2VNb2RlbCgpO1xuICBjb25zdCBoYXNNb2RlbHMgPSBtb2RlbCAhPSBudWxsO1xuICBjb25zdCBsYWJlbCA9IG1vZGVsPy5sYWJlbCA/PyBcIndha2Ugd29yZFwiO1xuICBjb25zdCBidG4gPSAkPEhUTUxCdXR0b25FbGVtZW50PihcIndha2VidG5cIik7XG4gIGJ0bi5oaWRkZW4gPSAhaGFzTW9kZWxzO1xuICBidG4uY2xhc3NMaXN0LnRvZ2dsZShcIm9uXCIsIHdha2VBcm1lZCk7XG4gIGJ0bi5jbGFzc0xpc3QudG9nZ2xlKFwibG9hZGluZ1wiLCB3YWtlTG9hZGluZyAmJiAod2FrZUFybWVkIHx8IGNvcmVXYW50c1dha2UpKTtcbiAgYnRuLnNldEF0dHJpYnV0ZShcImFyaWEtcHJlc3NlZFwiLCBTdHJpbmcod2FrZUFybWVkKSk7XG4gIGJ0bi50aXRsZSA9IHdha2VBcm1lZCA/IGBTdG9wIHdha2Ugd29yZCBcdTIwMUMke2xhYmVsfVx1MjAxRCAoVylgIDogYExpc3RlbiBmb3IgXHUyMDFDJHtsYWJlbH1cdTIwMUQgKFcpYDtcbiAgY29uc3QgaGVybyA9ICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiaGVyby13YWtlXCIpO1xuICBoZXJvLmhpZGRlbiA9ICFoYXNNb2RlbHM7XG4gIGhlcm8uY2xhc3NMaXN0LnRvZ2dsZShcIm9uXCIsIHdha2VBcm1lZCk7XG4gIGhlcm8udGV4dENvbnRlbnQgPSB3YWtlQXJtZWRcbiAgICA/ICh3YWtlTG9hZGluZyA/IGBMb2FkaW5nIFx1MjAxQyR7bGFiZWx9XHUyMDFEXHUyMDI2YCA6IGF1ZGlvLmF1ZGlvU3VzcGVuZGVkID8gYEFjdGl2YXRlIFx1MjAxQyR7bGFiZWx9XHUyMDFEYCA6IGBMaXN0ZW5pbmcgZm9yIFx1MjAxQyR7bGFiZWx9XHUyMDFEYClcbiAgICA6IGBMaXN0ZW4gZm9yIFx1MjAxQyR7bGFiZWx9XHUyMDFEYDtcbiAgJDxIVE1MSW5wdXRFbGVtZW50PihcIndha2UtZW5hYmxlZFwiKS5jaGVja2VkID0gd2FrZUFybWVkO1xuICByZW5kZXJXYWtlVGVsZW1ldHJ5KCk7XG4gIHNob3dTdGF0dXMoKTtcbn1cblxuZnVuY3Rpb24gc3luY1NpZ25hbGluZ1VpKCkge1xuICBjb25zdCBvdiA9IGRldmVsb3Blck92ZXJyaWRlcygpO1xuICBjb25zdCBzaWduYWxpbmdFbCA9ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwic2lnbmFsaW5nXCIpO1xuICBjb25zdCBzaWduYWxpbmcgPSBzaWduYWxpbmdFbC52YWx1ZTtcbiAgY29uc3Qgbm9uV2ViID0gb3Yubm9uV2ViUGxhdGZvcm0gIT0gbnVsbDtcbiAgc2lnbmFsaW5nRWwuZGlzYWJsZWQgPSBub25XZWIgfHwgb3YuaGFzQXR0ZW50aW9uO1xuICBjb25zdCB3aW5kb3dDb250cm9scyA9ICFub25XZWIgJiYgIW92Lmhhc0F0dGVudGlvbiAmJiAoc2lnbmFsaW5nID09PSBcIndpbmRvd1wiIHx8IHNpZ25hbGluZyA9PT0gXCJlY2hvXCIpO1xuICBmb3IgKGNvbnN0IGlkIG9mIFtcImF0dG4tYWZ0ZXItd2FrZVwiLCBcImF0dG4td2luZG93XCIsIFwiYXR0bi1hZnRlci1xdWVzdGlvblwiXSkge1xuICAgICQ8SFRNTElucHV0RWxlbWVudD4oaWQpLmRpc2FibGVkID0gIXdpbmRvd0NvbnRyb2xzO1xuICB9XG4gICQ8SFRNTElucHV0RWxlbWVudD4oXCJoYW5ndXAtYWZ0ZXJcIikuZGlzYWJsZWQgPSBub25XZWIgfHwgb3YuaGFzSGFuZ1VwO1xuICBjb25zdCBiYXJnZSA9ICQ8SFRNTElucHV0RWxlbWVudD4oXCJ3YWtlLWJhcmdlXCIpO1xuICBpZiAobm9uV2ViIHx8IG92Lmhhc01pY1doaWxlU3BlYWtpbmcpIHtcbiAgICBiYXJnZS5kaXNhYmxlZCA9IHRydWU7XG4gIH0gZWxzZSBpZiAoc2lnbmFsaW5nID09PSBcImVjaG9cIikge1xuICAgIGJhcmdlLmNoZWNrZWQgPSB0cnVlO1xuICAgIGJhcmdlLmRpc2FibGVkID0gdHJ1ZTtcbiAgfSBlbHNlIHtcbiAgICBiYXJnZS5kaXNhYmxlZCA9IGZhbHNlO1xuICAgIGJhcmdlLmNoZWNrZWQgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLndha2UtYmFyZ2VcIikgPT09IFwiMVwiO1xuICB9XG4gIGNvbnN0IG92ZXJyaWRkZW46IHN0cmluZ1tdID0gW107XG4gIGlmIChvdi5oYXNBdHRlbnRpb24pIG92ZXJyaWRkZW4ucHVzaChcImF0dGVudGlvblwiKTtcbiAgaWYgKG92Lmhhc0hhbmdVcCkgb3ZlcnJpZGRlbi5wdXNoKFwiaGFuZ1VwQWZ0ZXJcIik7XG4gIGlmIChvdi5oYXNNaWNXaGlsZVNwZWFraW5nKSBvdmVycmlkZGVuLnB1c2goXCJtaWMud2hpbGVTcGVha2luZ1wiKTtcbiAgY29uc3QgaGFzTW9kZWxzID0gKHNlcnZlcj8ud2FrZU1vZGVscz8ubGVuZ3RoID8/IDApID4gMDtcbiAgJChcInNpZ25hbGluZy1oZWxwXCIpLnRleHRDb250ZW50ID0gbm9uV2ViXG4gICAgPyBgRGV2ZWxvcGVyIHByZXNldCAoJHtvdi5ub25XZWJQbGF0Zm9ybX0pIGNvbnRyb2xzIHNpZ25hbGluZy5gXG4gICAgOiBvdmVycmlkZGVuLmxlbmd0aCA+IDBcbiAgICAgID8gYERldmVsb3BlciBjb25maWcgc2V0cyAke292ZXJyaWRkZW4uam9pbihcIiwgXCIpfS5gXG4gICAgICA6ICFoYXNNb2RlbHMgJiYgc2lnbmFsaW5nICE9PSBcIm9wZW5cIlxuICAgICAgICA/IFwiTm8gd2FrZSBtb2RlbHMgb24gc2VydmVyOiB1c2UgdGhlIFdha2UgYnV0dG9uIHdoZW4gZG9ybWFudC5cIlxuICAgICAgICA6IFwiQXBwbGllZCBvbiB0aGUgbmV4dCBjYWxsIHVubGVzcyBvdmVycmlkZGVuIGluIERldmVsb3BlciBKU09OLlwiO1xufVxuXG5jb25zdCB3YWtlQ2xpZW50ID0gbmV3IFdha2VDbGllbnQoe1xuICBvblJlYWR5KG1vZGVsSWQsIHdhcm11cE1zKSB7XG4gICAgd2FrZUxvYWRpbmcgPSBmYWxzZTtcbiAgICBsb2coXCJvdXRcIiwgYHdha2Ugd29yZCByZWFkeTogJHttb2RlbElkfSR7d2FybXVwTXMgPiAwID8gYCAoJHt3YXJtdXBNc30gbXMpYCA6IFwiXCJ9YCwgXCJvdXRcIik7XG4gICAgc3luY1dha2VVaSgpO1xuICB9LFxuICBvbkRldGVjdGVkKGhpdCkge1xuICAgIG9uV2FrZURldGVjdGVkKGhpdCk7XG4gIH0sXG4gIG9uVGVsZW1ldHJ5KHRlbCkge1xuICAgIHdha2VMYXN0VGVsID0gdGVsO1xuICAgIHJlbmRlcldha2VUZWxlbWV0cnkoKTtcbiAgfSxcbiAgb25FcnJvcihtZXNzYWdlKSB7XG4gICAgd2FrZUxvYWRpbmcgPSBmYWxzZTtcbiAgICBsb2coXCJlcnJvclwiLCBgd2FrZSB3b3JkOiAke21lc3NhZ2V9YCwgXCJlcnJcIik7XG4gICAgdG9hc3QoYFdha2Ugd29yZCBlcnJvcjogJHttZXNzYWdlfWApO1xuICAgIGlmICh3YWtlQXJtZWQpIHZvaWQgYXJtV2FrZShmYWxzZSk7XG4gICAgZWxzZSBzeW5jV2FrZVVpKCk7XG4gIH0sXG59KTtcblxuYXN5bmMgZnVuY3Rpb24gYXJtV2FrZShvbjogYm9vbGVhbiwgcGVyc2lzdCA9IHRydWUpIHtcbiAgY29uc3QgbW9kZWwgPSBzZWxlY3RlZFdha2VNb2RlbCgpO1xuICBpZiAob24gJiYgIW1vZGVsKSB7XG4gICAgdG9hc3QoXCJObyB3YWtlIHdvcmQgbW9kZWxzIGZvdW5kIG9uIHRoZSBzZXJ2ZXJcIik7XG4gICAgJDxIVE1MSW5wdXRFbGVtZW50PihcIndha2UtZW5hYmxlZFwiKS5jaGVja2VkID0gZmFsc2U7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IGdlbiA9ICsrYXJtR2VuO1xuICB3YWtlQXJtZWQgPSBvbjtcbiAgaWYgKHBlcnNpc3QpIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2Uud2FrZS1lbmFibGVkXCIsIG9uID8gXCIxXCIgOiBcIjBcIik7XG4gIGlmIChvbiAmJiBtb2RlbCkge1xuICAgIHdha2VMYXN0VGVsID0gbnVsbDtcbiAgICBpZiAoIXdha2VDbGllbnQucmVhZHkgfHwgd2FrZUNsaWVudC5tb2RlbElkICE9PSBtb2RlbC5pZCkgd2FrZUxvYWRpbmcgPSB0cnVlO1xuICAgIHdha2VDbGllbnQubG9hZChtb2RlbC5pZCwgd2FrZVRocmVzaG9sZCgpKTtcbiAgICBpZiAoIWNhbGxJZCkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgYXVkaW8uZW5zdXJlTWljKG9uTWljLCBtaWNPcHRpb25zKCkpO1xuICAgICAgICBpZiAoZ2VuICE9PSBhcm1HZW4gfHwgIXdha2VBcm1lZCkgcmV0dXJuO1xuICAgICAgICB3YWtlQ2xpZW50LnJlc2V0KCk7XG4gICAgICAgIGF3YWl0IGFjcXVpcmVXYWtlTG9jaygpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGlmIChnZW4gIT09IGFybUdlbikgcmV0dXJuO1xuICAgICAgICB3YWtlQXJtZWQgPSBmYWxzZTtcbiAgICAgICAgd2FrZUxvYWRpbmcgPSBmYWxzZTtcbiAgICAgICAgaWYgKCFjYWxsSWQpIHtcbiAgICAgICAgICBhdWRpby5zdG9wTWljKCk7XG4gICAgICAgICAgcmVsZWFzZVdha2VMb2NrKCk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHBlcnNpc3QpIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2Uud2FrZS1lbmFibGVkXCIsIFwiMFwiKTtcbiAgICAgICAgdG9hc3QoYE1pY3JvcGhvbmU6ICR7KGVyciBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICAgICAgbG9nKFwiZXJyb3JcIiwgYHdha2UgbWljcm9waG9uZTogJHsoZXJyIGFzIEVycm9yKS5tZXNzYWdlfWAsIFwiZXJyXCIpO1xuICAgICAgfVxuICAgIH1cbiAgfSBlbHNlIHtcbiAgICB3YWtlTG9hZGluZyA9IGZhbHNlO1xuICAgIHdha2VMYXN0VGVsID0gbnVsbDtcbiAgICBpZiAoIWNhbGxJZCkge1xuICAgICAgYXVkaW8uc3RvcE1pYygpO1xuICAgICAgcmVsZWFzZVdha2VMb2NrKCk7XG4gICAgICB3YWtlQ2xpZW50LnJlc2V0KCk7XG4gICAgfVxuICB9XG4gIHN5bmNXYWtlVWkoKTtcbn1cblxuZnVuY3Rpb24gZW5zdXJlQ29yZVdha2Uob246IGJvb2xlYW4pIHtcbiAgY29yZVdhbnRzV2FrZSA9IG9uO1xuICBjb25zdCBtb2RlbCA9IHNlbGVjdGVkV2FrZU1vZGVsKCk7XG4gIGlmIChvbikge1xuICAgIGlmICghbW9kZWwpIHtcbiAgICAgIGxvZyhcIndhcm5cIiwgXCJjb3JlIGFza2VkIGZvciB3YWtlIHdvcmQsIGJ1dCBubyBtb2RlbHMgYXJlIGF2YWlsYWJsZVwiLCBcIndhcm5cIik7XG4gICAgfSBlbHNlIHtcbiAgICAgIHdha2VMYXN0VGVsID0gbnVsbDtcbiAgICAgIGlmICghd2FrZUNsaWVudC5yZWFkeSB8fCB3YWtlQ2xpZW50Lm1vZGVsSWQgIT09IG1vZGVsLmlkKSB3YWtlTG9hZGluZyA9IHRydWU7XG4gICAgICB3YWtlQ2xpZW50LmxvYWQobW9kZWwuaWQsIHdha2VUaHJlc2hvbGQoKSk7XG4gICAgICB3YWtlQ2xpZW50LnJlc2V0KCk7XG4gICAgICBsb2coXCJvdXRcIiwgYHdha2Ugd29yZCBsaXN0ZW5pbmcgKCR7bW9kZWwubGFiZWx9KWAsIFwib3V0XCIpO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICBpZiAoIXdha2VBcm1lZCkgd2FrZUxhc3RUZWwgPSBudWxsO1xuICAgIGxvZyhcIm91dFwiLCBcIndha2Ugd29yZCBvZmZcIiwgXCJvdXRcIik7XG4gIH1cbiAgc3luY1dha2VVaSgpO1xufVxuXG5mdW5jdGlvbiBvbldha2VEZXRlY3RlZChoaXQ6IFdha2VEZXRlY3Rpb25FdmVudCkge1xuICBpZiAoIXNob3VsZEZlZWRXYWtlKCkpIHJldHVybjtcbiAgY29uc3QgbGFiZWwgPSBzZWxlY3RlZFdha2VNb2RlbCgpPy5sYWJlbCA/PyBcIndha2Ugd29yZFwiO1xuICBsb2coXCJvdXRcIiwgYHdha2UgZGV0ZWN0ZWQgXHUyMDFDJHtsYWJlbH1cdTIwMUQgKHNjb3JlICR7aGl0LnNjb3JlLnRvRml4ZWQoMil9LCAke2hpdC5pbmZlck1zLnRvRml4ZWQoMSl9IG1zKWAsIFwib3V0XCIpO1xuICBpZiAoY2hlY2tlZChcIndha2UtY3VlXCIpKSB2b2lkIGF1ZGlvLm9wZW4oKS50aGVuKCgpID0+IGF1ZGlvLmN1ZShXQUtFX1RPTkUpKS5jYXRjaCgoKSA9PiB7fSk7XG4gIHRvYXN0KGBIZWFyZCBcdTIwMUMke2xhYmVsfVx1MjAxRCAoJHtoaXQuc2NvcmUudG9GaXhlZCgyKX0pYCk7XG4gIGlmIChjYWxsSWQgIT09IDApIHtcbiAgICBwdXNoKHsgdHlwZTogXCJ3YWtlXCIgfSk7XG4gICAgLy8gUmVwbGF5IG9ubHkgdGhlIHRyYWlsaW5nIGNodW5rcyB0aGF0IHRoZSBjb3JlIHN1cHByZXNzZWQgdG8gc2lsZW5jZSBkdXJpbmcgYXVkaWJsZSBwbGF5YmFjayxcbiAgICAvLyBhdm9pZGluZyBib3RoIGxvc3Qgc3lsbGFibGVzIGFmdGVyIHBsYXliYWNrIGVuZHMgYW5kIGR1cGxpY2F0ZSByZXBsYXkgb2YgdW5zdXBwcmVzc2VkIGF1ZGlvLlxuICAgIGZvciAoY29uc3QgY2h1bmsgb2YgaGl0LnRyYWlsaW5nKSB7XG4gICAgICBpZiAoIWNhbGxJZCkgYnJlYWs7XG4gICAgICBpZiAoIWNodW5rLnN1cHByZXNzZWQgfHwgY2h1bmsuYnl0ZXMuYnl0ZUxlbmd0aCA9PT0gMCkgY29udGludWU7XG4gICAgICBjb3VudHMubWljKys7XG4gICAgICBwdXNoKHsgdHlwZTogXCJtaWNcIiwgcGNtOiBieXRlc1RvQmFzZTY0KGNodW5rLmJ5dGVzKSB9KTtcbiAgICB9XG4gICAgcmV0dXJuO1xuICB9XG4gIHdha2VTdGFydGluZyA9IHRydWU7XG4gIG9wZW5pbmdDaHVua3MgPSBbXTtcbiAgb3BlbmluZ0J5dGVzID0gMDtcbiAgZm9yIChjb25zdCBjaHVuayBvZiBoaXQudHJhaWxpbmcpIHtcbiAgICBpZiAoY2h1bmsuYnl0ZXMuYnl0ZUxlbmd0aCA9PT0gMCkgY29udGludWU7XG4gICAgb3BlbmluZ0NodW5rcy5wdXNoKGNodW5rLmJ5dGVzKTtcbiAgICBvcGVuaW5nQnl0ZXMgKz0gY2h1bmsuYnl0ZXMuYnl0ZUxlbmd0aDtcbiAgICB3aGlsZSAob3BlbmluZ0J5dGVzID4gT1BFTklOR19NQVhfQllURVMgJiYgb3BlbmluZ0NodW5rcy5sZW5ndGggPiAxKSB7XG4gICAgICBvcGVuaW5nQnl0ZXMgLT0gb3BlbmluZ0NodW5rcy5zaGlmdCgpIS5ieXRlTGVuZ3RoO1xuICAgIH1cbiAgfVxuICB2b2lkIHN0YXJ0KGNoYXQubGVuZ3RoID4gMCkudGhlbigoc3RhcnRlZCkgPT4ge1xuICAgIGlmICghc3RhcnRlZCAmJiB3YWtlU3RhcnRpbmcpIHtcbiAgICAgIHdha2VTdGFydGluZyA9IGZhbHNlO1xuICAgICAgb3BlbmluZ0NodW5rcyA9IFtdO1xuICAgICAgb3BlbmluZ0J5dGVzID0gMDtcbiAgICAgIHN5bmNXYWtlVWkoKTtcbiAgICB9XG4gIH0pLmNhdGNoKChlcnIpID0+IHtcbiAgICB3YWtlU3RhcnRpbmcgPSBmYWxzZTtcbiAgICBvcGVuaW5nQ2h1bmtzID0gW107XG4gICAgb3BlbmluZ0J5dGVzID0gMDtcbiAgICB0b2FzdCgoZXJyIGFzIEVycm9yKS5tZXNzYWdlKTtcbiAgICBsb2coXCJlcnJvclwiLCAoZXJyIGFzIEVycm9yKS5tZXNzYWdlLCBcImVyclwiKTtcbiAgICBzeW5jV2FrZVVpKCk7XG4gIH0pO1xufVxuXG4vLyBXaXJpbmcuXG5cbmZ1bmN0aW9uIHNldHRpbmdzRnJvbVN0b3JhZ2UoKSB7XG4gIGZvciAoY29uc3QgaWQgb2YgW1wiYWVjXCIsIFwic3RvcHdvcmRcIiwgXCJwdHRcIiwgXCJjYXB0aW9uc1wiLCBcImNvZGluZ1wiLCBcImZha2VoZXJtZXNcIiwgXCJ0cmFjZVwiLCBcIndha2UtY3VlXCIsIFwid2FrZS1iYXJnZVwiXSkge1xuICAgIGNvbnN0IHYgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShgdm9pY2UuJHtpZH1gKTtcbiAgICBpZiAodiAhPSBudWxsKSAkPEhUTUxJbnB1dEVsZW1lbnQ+KGlkKS5jaGVja2VkID0gdiA9PT0gXCIxXCI7XG4gICAgJChpZCkuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiB7XG4gICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShgdm9pY2UuJHtpZH1gLCBjaGVja2VkKGlkKSA/IFwiMVwiIDogXCIwXCIpO1xuICAgICAgaWYgKGlkID09PSBcImFlY1wiICYmIHdha2VBcm1lZCAmJiAhY2FsbElkKSB7XG4gICAgICAgIHZvaWQgYXVkaW8uc3RhcnRNaWMob25NaWMsIG1pY09wdGlvbnMoKSkuY2F0Y2goKGVycikgPT4gdG9hc3QoYE1pY3JvcGhvbmU6ICR7ZXJyLm1lc3NhZ2V9YCkpO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG4gIGZvciAoY29uc3QgW2lkLCBrZXldIG9mIFtcbiAgICBbXCJmYWtlZGVsYXlcIiwgXCJ2b2ljZS5mYWtlZGVsYXlcIl0sXG4gICAgW1wiYXR0bi1hZnRlci13YWtlXCIsIFwidm9pY2UuYXR0bi1hZnRlci13YWtlXCJdLFxuICAgIFtcImF0dG4td2luZG93XCIsIFwidm9pY2UuYXR0bi13aW5kb3dcIl0sXG4gICAgW1wiYXR0bi1hZnRlci1xdWVzdGlvblwiLCBcInZvaWNlLmF0dG4tYWZ0ZXItcXVlc3Rpb25cIl0sXG4gICAgW1wiaGFuZ3VwLWFmdGVyXCIsIFwidm9pY2UuaGFuZ3VwLWFmdGVyXCJdLFxuICBdIGFzIGNvbnN0KSB7XG4gICAgY29uc3Qgc2F2ZWQgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShrZXkpO1xuICAgIGlmIChzYXZlZCAhPSBudWxsKSAkPEhUTUxJbnB1dEVsZW1lbnQ+KGlkKS52YWx1ZSA9IHNhdmVkO1xuICAgICQoaWQpLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4ge1xuICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oa2V5LCAkPEhUTUxJbnB1dEVsZW1lbnQ+KGlkKS52YWx1ZSk7XG4gICAgICBpZiAoaWQgPT09IFwiaGFuZ3VwLWFmdGVyXCIpIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2UuaGFuZ3VwLWN1c3RvbVwiLCBcIjFcIik7XG4gICAgfSk7XG4gIH1cbiAgY29uc3QgdGhyZXNoID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS53YWtlLXRocmVzaG9sZFwiKTtcbiAgaWYgKHRocmVzaCAhPSBudWxsKSAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwid2FrZS10aHJlc2hvbGRcIikudmFsdWUgPSB0aHJlc2g7XG4gICQoXCJ3YWtlLXRocmVzaG9sZC12YWxcIikudGV4dENvbnRlbnQgPSB3YWtlVGhyZXNob2xkKCkudG9GaXhlZCgyKTtcbiAgJChcIndha2UtdGhyZXNob2xkXCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJpbnB1dFwiLCAoKSA9PiB7XG4gICAgY29uc3QgdiA9IHdha2VUaHJlc2hvbGQoKTtcbiAgICAkKFwid2FrZS10aHJlc2hvbGQtdmFsXCIpLnRleHRDb250ZW50ID0gdi50b0ZpeGVkKDIpO1xuICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2Uud2FrZS10aHJlc2hvbGRcIiwgdi50b0ZpeGVkKDIpKTtcbiAgICB3YWtlQ2xpZW50LnNldFRocmVzaG9sZCh2KTtcbiAgICByZW5kZXJXYWtlVGVsZW1ldHJ5KCk7XG4gIH0pO1xuICBjb25zdCBzaWduYWxpbmcgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLnNpZ25hbGluZ1wiKTtcbiAgaWYgKHNpZ25hbGluZykgJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJzaWduYWxpbmdcIikudmFsdWUgPSBzaWduYWxpbmc7XG4gICQoXCJzaWduYWxpbmdcIikuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiB7XG4gICAgY29uc3QgbW9kZSA9ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwic2lnbmFsaW5nXCIpLnZhbHVlO1xuICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2Uuc2lnbmFsaW5nXCIsIG1vZGUpO1xuICAgIGlmIChsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLmhhbmd1cC1jdXN0b21cIikgIT09IFwiMVwiKSB7XG4gICAgICBjb25zdCBkZWYgPSBtb2RlID09PSBcImVjaG9cIiA/IFwiMTVcIiA6IFwiMzAwXCI7XG4gICAgICAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwiaGFuZ3VwLWFmdGVyXCIpLnZhbHVlID0gZGVmO1xuICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS5oYW5ndXAtYWZ0ZXJcIiwgZGVmKTtcbiAgICB9XG4gICAgc3luY1NpZ25hbGluZ1VpKCk7XG4gIH0pO1xuICAkKFwid2FrZS1lbmFibGVkXCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4gdm9pZCBhcm1XYWtlKGNoZWNrZWQoXCJ3YWtlLWVuYWJsZWRcIikpKTtcbiAgJChcIndha2UtbW9kZWxcIikuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiB7XG4gICAgY29uc3QgaWQgPSAkPEhUTUxTZWxlY3RFbGVtZW50PihcIndha2UtbW9kZWxcIikudmFsdWU7XG4gICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS53YWtlLW1vZGVsXCIsIGlkKTtcbiAgICBpZiAod2FrZUFybWVkIHx8IGNvcmVXYW50c1dha2UpIHtcbiAgICAgIHdha2VMb2FkaW5nID0gdHJ1ZTtcbiAgICAgIHdha2VMYXN0VGVsID0gbnVsbDtcbiAgICAgIHdha2VDbGllbnQubG9hZChpZCwgd2FrZVRocmVzaG9sZCgpKTtcbiAgICAgIHN5bmNXYWtlVWkoKTtcbiAgICB9IGVsc2Uge1xuICAgICAgc3luY1dha2VVaSgpO1xuICAgIH1cbiAgfSk7XG4gIGNvbnN0IHZvaWNlID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS52b2ljZVwiKTtcbiAgaWYgKHZvaWNlKSAkPEhUTUxTZWxlY3RFbGVtZW50PihcInZvaWNlXCIpLnZhbHVlID0gdm9pY2U7XG4gICQoXCJ2b2ljZVwiKS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2Uudm9pY2VcIiwgJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJ2b2ljZVwiKS52YWx1ZSkpO1xuICBjb25zdCBtb2RlID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS5tb2RlXCIpO1xuICBpZiAobW9kZSkgJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJtb2RlXCIpLnZhbHVlID0gbW9kZTtcbiAgJChcIm1vZGVcIikuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiB7XG4gICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS5tb2RlXCIsICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwibW9kZVwiKS52YWx1ZSk7XG4gICAgc3luY0NvbXBvc2VyKCk7XG4gIH0pO1xuICBjb25zdCB0aGVtZSA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UudGhlbWVcIikgPz8gXCJzeXN0ZW1cIjtcbiAgYXBwbHlUaGVtZSh0aGVtZSk7XG4gIGZvciAoY29uc3QgYnRuIG9mIEFycmF5LmZyb20oZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MQnV0dG9uRWxlbWVudD4oXCIjdGhlbWUtcGlja2VyIGJ1dHRvblwiKSkpIHtcbiAgICBidG4ub25jbGljayA9ICgpID0+IHtcbiAgICAgIGNvbnN0IGNob2ljZSA9IGJ0bi5kYXRhc2V0LnRoZW1lID8/IFwic3lzdGVtXCI7XG4gICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLnRoZW1lXCIsIGNob2ljZSk7XG4gICAgICBhcHBseVRoZW1lKGNob2ljZSk7XG4gICAgfTtcbiAgfVxuICBjb25zdCBkZW5zaXR5ID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS5kZW5zaXR5XCIpO1xuICBhcHBseURlbnNpdHkoZGVuc2l0eSk7XG4gIGZvciAoY29uc3QgYnRuIG9mIEFycmF5LmZyb20oZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MQnV0dG9uRWxlbWVudD4oXCIjZGVuc2l0eS1waWNrZXIgYnV0dG9uXCIpKSkge1xuICAgIGJ0bi5vbmNsaWNrID0gKCkgPT4ge1xuICAgICAgY29uc3QgY2hvaWNlID0gbm9ybWFsaXplRGVuc2l0eShidG4uZGF0YXNldC5kZW5zaXR5KTtcbiAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2UuZGVuc2l0eVwiLCBjaG9pY2UpO1xuICAgICAgYXBwbHlEZW5zaXR5KGNob2ljZSk7XG4gICAgfTtcbiAgfVxuICBtYXRjaE1lZGlhKFwiKHByZWZlcnMtY29sb3Itc2NoZW1lOiBkYXJrKVwiKS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHtcbiAgICBpZiAoKGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UudGhlbWVcIikgPz8gXCJzeXN0ZW1cIikgPT09IFwic3lzdGVtXCIpIGFwcGx5VGhlbWUoXCJzeXN0ZW1cIik7XG4gIH0pO1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwidmlzaWJpbGl0eWNoYW5nZVwiLCAoKSA9PiB7XG4gICAgaWYgKCFkb2N1bWVudC5oaWRkZW4gJiYgKGNhbGxJZCB8fCB3YWtlQXJtZWQpKSB2b2lkIGFjcXVpcmVXYWtlTG9jaygpO1xuICB9KTtcbiAgYXVkaW8ub25BdWRpb1N0YXRlQ2hhbmdlKCgpID0+IHN5bmNXYWtlVWkoKSk7XG4gIGNvbnN0IHJlc3VtZUlmU3VzcGVuZGVkID0gKCkgPT4ge1xuICAgIGlmIChhdWRpby5hdWRpb1N1c3BlbmRlZCAmJiAod2FrZUFybWVkIHx8IGNhbGxJZCkpIHtcbiAgICAgIHZvaWQgYXVkaW8ucmVzdW1lQXVkaW8oKS50aGVuKCgpID0+IHN5bmNXYWtlVWkoKSk7XG4gICAgfVxuICB9O1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwicG9pbnRlcmRvd25cIiwgcmVzdW1lSWZTdXNwZW5kZWQsIHsgcGFzc2l2ZTogdHJ1ZSB9KTtcbiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcInBvaW50ZXJ1cFwiLCByZXN1bWVJZlN1c3BlbmRlZCwgeyBwYXNzaXZlOiB0cnVlIH0pO1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgcmVzdW1lSWZTdXNwZW5kZWQsIHsgcGFzc2l2ZTogdHJ1ZSB9KTtcbiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcImtleWRvd25cIiwgcmVzdW1lSWZTdXNwZW5kZWQsIHsgcGFzc2l2ZTogdHJ1ZSB9KTtcbiAgc3luY1NpZ25hbGluZ1VpKCk7XG59XG5cbmNvbnN0IG1vYmlsZUxheW91dCA9IG1hdGNoTWVkaWEoXCIobWF4LXdpZHRoOiA5MjBweClcIik7XG5sZXQgZHJhd2VyT3BlbmVyOiBIVE1MRWxlbWVudCB8IG51bGwgPSBudWxsO1xuXG5mdW5jdGlvbiBzZXRUYXNrc09wZW4ob3BlbjogYm9vbGVhbiwgb3BlbmVyPzogSFRNTEVsZW1lbnQgfCBudWxsKSB7XG4gIGNvbnN0IGNhbk9wZW4gPSBtb2JpbGVMYXlvdXQubWF0Y2hlcyAmJiAhJChcInRhbGtcIikuaGlkZGVuO1xuICBjb25zdCBuZXh0ID0gb3BlbiAmJiBjYW5PcGVuO1xuICBjb25zdCB3YXNPcGVuID0gZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QuY29udGFpbnMoXCJ0YXNrcy1vcGVuXCIpO1xuICBkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC50b2dnbGUoXCJ0YXNrcy1vcGVuXCIsIG5leHQpO1xuICBjb25zdCBoZWFkZXIgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKFwiaGVhZGVyXCIpIGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgaWYgKGhlYWRlcikgaGVhZGVyLmluZXJ0ID0gbmV4dDtcbiAgJChcImNvbnZvXCIpLmluZXJ0ID0gbmV4dDtcbiAgJChcInNpZGVcIikuaW5lcnQgPSBtb2JpbGVMYXlvdXQubWF0Y2hlcyAmJiAhbmV4dDtcbiAgJChcInRhc2tzLXRvZ2dsZVwiKS5zZXRBdHRyaWJ1dGUoXCJhcmlhLWV4cGFuZGVkXCIsIFN0cmluZyhuZXh0KSk7XG4gICQoXCJtb2JpbGUtdGFza3MtYmFyXCIpLnNldEF0dHJpYnV0ZShcImFyaWEtZXhwYW5kZWRcIiwgU3RyaW5nKG5leHQpKTtcbiAgaWYgKG5leHQgJiYgIXdhc09wZW4pIHtcbiAgICBkcmF3ZXJPcGVuZXIgPSBvcGVuZXIgPz8gKGRvY3VtZW50LmFjdGl2ZUVsZW1lbnQgYXMgSFRNTEVsZW1lbnQgfCBudWxsKTtcbiAgICBjbGVhclVucmVhZElmUmVzdWx0c1Zpc2libGUoKTtcbiAgICAkKFwidGFza3MtY2xvc2VcIikuZm9jdXMoKTtcbiAgICByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKCkgPT4gdXBkYXRlQWxsUmVzdWx0Q2xhbXBpbmcoKSk7XG4gIH0gZWxzZSBpZiAoIW5leHQgJiYgd2FzT3Blbikge1xuICAgIGNvbnN0IHRhcmdldCA9IGRyYXdlck9wZW5lcjtcbiAgICBkcmF3ZXJPcGVuZXIgPSBudWxsO1xuICAgIGlmICh0YXJnZXQgJiYgdGFyZ2V0LmlzQ29ubmVjdGVkICYmICF0YXJnZXQuaGlkZGVuICYmIHRhcmdldC5vZmZzZXRQYXJlbnQgIT09IG51bGwpIHtcbiAgICAgIHRhcmdldC5mb2N1cygpO1xuICAgIH0gZWxzZSBpZiAodGFyZ2V0ID09PSAkKFwibW9iaWxlLXRhc2tzLWJhclwiKSkge1xuICAgICAgY29uc3QgZmFsbGJhY2sgPSAkKFwidGFza3MtdG9nZ2xlXCIpO1xuICAgICAgaWYgKCFmYWxsYmFjay5oaWRkZW4gJiYgZmFsbGJhY2sub2Zmc2V0UGFyZW50ICE9PSBudWxsKSBmYWxsYmFjay5mb2N1cygpO1xuICAgIH1cbiAgfVxufVxuXG5mdW5jdGlvbiB0YWJzKCkge1xuICBjb25zdCB2aWV3czogUmVjb3JkPHN0cmluZywgSFRNTEVsZW1lbnQ+ID0geyB0YWxrOiAkKFwidGFsa1wiKSwgZGV2OiAkKFwiZGV2XCIpLCByZXBsYXk6ICQoXCJyZXBsYXltYWluXCIpIH07XG4gIGZvciAoY29uc3QgbmFtZSBvZiBPYmplY3Qua2V5cyh2aWV3cykpIHtcbiAgICAkKGB0YWItJHtuYW1lfWApLm9uY2xpY2sgPSAoKSA9PiB7XG4gICAgICBmb3IgKGNvbnN0IFtvdGhlciwgZWxdIG9mIE9iamVjdC5lbnRyaWVzKHZpZXdzKSkge1xuICAgICAgICBlbC5oaWRkZW4gPSBvdGhlciAhPT0gbmFtZTtcbiAgICAgICAgJChgdGFiLSR7b3RoZXJ9YCkuY2xhc3NMaXN0LnRvZ2dsZShcIm9uXCIsIG90aGVyID09PSBuYW1lKTtcbiAgICAgIH1cbiAgICAgICQoXCJ0YXNrcy10b2dnbGVcIikuaGlkZGVuID0gbmFtZSAhPT0gXCJ0YWxrXCI7XG4gICAgICBzZXRUYXNrc09wZW4oZmFsc2UpO1xuICAgICAgaWYgKG5hbWUgPT09IFwidGFsa1wiKSByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKCkgPT4gdXBkYXRlQWxsUmVzdWx0Q2xhbXBpbmcoKSk7XG4gICAgfTtcbiAgfVxuICBmb3IgKGNvbnN0IGJ0biBvZiBBcnJheS5mcm9tKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiI3NpZGUtdGFicyBidXR0b25cIikpKSB7XG4gICAgYnRuLm9uY2xpY2sgPSAoKSA9PiBzZXRTaWRlRmlsdGVyKG5vcm1hbGl6ZVNpZGVGaWx0ZXIoYnRuLmRhdGFzZXQuZmlsdGVyKSk7XG4gIH1cbiAgJChcInRvZ2dsZS1hbGwtcmVzdWx0c1wiKS5vbmNsaWNrID0gKCkgPT4ge1xuICAgIGNvbnN0IGNsYW1wZWQgPSBbLi4ucmVzdWx0cy52YWx1ZXMoKV0uZmlsdGVyKChyKSA9PiByLmNhcmQuY2xhc3NMaXN0LmNvbnRhaW5zKFwiY2xhbXBlZFwiKSk7XG4gICAgY29uc3Qgb3BlbkFsbCA9IGNsYW1wZWQuc29tZSgocikgPT4gIXIuY2FyZC5jbGFzc0xpc3QuY29udGFpbnMoXCJvcGVuXCIpKTtcbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGNsYW1wZWQpIHNldFJlc3VsdE9wZW4oZW50cnksIG9wZW5BbGwpO1xuICB9O1xuICAkKFwiZ2VhclwiKS5vbmNsaWNrID0gKCkgPT4geyAkKFwic2V0dGluZ3NcIikuaGlkZGVuID0gZmFsc2U7IH07XG4gICQoXCJjbG9zZXNldHRpbmdzXCIpLm9uY2xpY2sgPSAoKSA9PiB7ICQoXCJzZXR0aW5nc1wiKS5oaWRkZW4gPSB0cnVlOyB9O1xuICAkKFwiY2xvc2VzZXR0aW5ncy14XCIpLm9uY2xpY2sgPSAoKSA9PiB7ICQoXCJzZXR0aW5nc1wiKS5oaWRkZW4gPSB0cnVlOyB9O1xuICAkKFwic2V0dGluZ3NcIikub25jbGljayA9IChlKSA9PiB7IGlmIChlLnRhcmdldCA9PT0gJChcInNldHRpbmdzXCIpKSAkKFwic2V0dGluZ3NcIikuaGlkZGVuID0gdHJ1ZTsgfTtcbiAgY29uc3Qgb3Blbk1vYmlsZVRhc2tzRHJhd2VyID0gKG9wZW5lcjogSFRNTEVsZW1lbnQpID0+IHtcbiAgICBjb25zdCBhY3RpdmVUb3RhbCA9IFsuLi50YXNrcy52YWx1ZXMoKV0uZmlsdGVyKGlzQWN0aXZlVGFzaykubGVuZ3RoICsgZWFybGllckFjdGl2ZUNvdW50O1xuICAgIGNvbnN0IG5leHRGaWx0ZXIgPSByZXNvbHZlTW9iaWxlQmFubmVyRmlsdGVyKHNpZGVGaWx0ZXIsIGFjdGl2ZVRvdGFsLCB1bnJlYWRNb2JpbGVSZXN1bHRzKTtcbiAgICBpZiAobmV4dEZpbHRlciAhPT0gc2lkZUZpbHRlcikgc2V0U2lkZUZpbHRlcihuZXh0RmlsdGVyKTtcbiAgICBzZXRUYXNrc09wZW4odHJ1ZSwgb3BlbmVyKTtcbiAgfTtcbiAgJChcInRhc2tzLXRvZ2dsZVwiKS5vbmNsaWNrID0gKCkgPT4ge1xuICAgIGlmIChkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5jb250YWlucyhcInRhc2tzLW9wZW5cIikpIHNldFRhc2tzT3BlbihmYWxzZSk7XG4gICAgZWxzZSBvcGVuTW9iaWxlVGFza3NEcmF3ZXIoJChcInRhc2tzLXRvZ2dsZVwiKSk7XG4gIH07XG4gICQoXCJtb2JpbGUtdGFza3MtYmFyXCIpLm9uY2xpY2sgPSAoKSA9PiBvcGVuTW9iaWxlVGFza3NEcmF3ZXIoJChcIm1vYmlsZS10YXNrcy1iYXJcIikpO1xuICAkKFwidGFza3MtY2xvc2VcIikub25jbGljayA9ICgpID0+IHNldFRhc2tzT3BlbihmYWxzZSk7XG4gICQoXCJzaWRlLWJhY2tkcm9wXCIpLm9uY2xpY2sgPSAoKSA9PiBzZXRUYXNrc09wZW4oZmFsc2UpO1xuICBtb2JpbGVMYXlvdXQuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiB7XG4gICAgc2V0VGFza3NPcGVuKGZhbHNlKTtcbiAgICBjbGVhclVucmVhZElmUmVzdWx0c1Zpc2libGUoKTtcbiAgICByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKCkgPT4gdXBkYXRlQWxsUmVzdWx0Q2xhbXBpbmcoKSk7XG4gIH0pO1xuICBzZXRUYXNrc09wZW4oZmFsc2UpO1xufVxuXG5mdW5jdGlvbiB0eXBpbmcoKTogYm9vbGVhbiB7XG4gIGNvbnN0IGVsID0gZG9jdW1lbnQuYWN0aXZlRWxlbWVudCBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gIHJldHVybiAhIWVsICYmIChlbC50YWdOYW1lID09PSBcIklOUFVUXCIgfHwgZWwudGFnTmFtZSA9PT0gXCJURVhUQVJFQVwiIHx8IGVsLnRhZ05hbWUgPT09IFwiU0VMRUNUXCIgfHwgZWwuaXNDb250ZW50RWRpdGFibGUpO1xufVxuXG5mdW5jdGlvbiBrZXlzKCkge1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCAoZSkgPT4ge1xuICAgIGlmIChlLmtleSA9PT0gXCJFc2NhcGVcIikge1xuICAgICAgaWYgKCEkKFwic2V0dGluZ3NcIikuaGlkZGVuKSB7ICQoXCJzZXR0aW5nc1wiKS5oaWRkZW4gPSB0cnVlOyByZXR1cm47IH1cbiAgICAgIGlmIChkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5jb250YWlucyhcInRhc2tzLW9wZW5cIikgJiYgbW9iaWxlTGF5b3V0Lm1hdGNoZXMgJiYgISQoXCJ0YWxrXCIpLmhpZGRlbikgeyBzZXRUYXNrc09wZW4oZmFsc2UpOyByZXR1cm47IH1cbiAgICAgIGlmIChjYWxsSWQpIHsgcHVzaCh7IHR5cGU6IFwiaW50ZXJydXB0XCIgfSk7IGF1ZGlvLmZsdXNoKCk7IHJldHVybjsgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAodHlwaW5nKCkgfHwgISQoXCJzZXR0aW5nc1wiKS5oaWRkZW4gfHwgZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QuY29udGFpbnMoXCJ0YXNrcy1vcGVuXCIpIHx8IGUubWV0YUtleSB8fCBlLmN0cmxLZXkgfHwgZS5hbHRLZXkpIHJldHVybjtcbiAgICBpZiAoZS5rZXkgPT09IFwibVwiIHx8IGUua2V5ID09PSBcIk1cIikgeyBzZXRNdXRlZCghbXV0ZWQpOyBlLnByZXZlbnREZWZhdWx0KCk7IH1cbiAgICBlbHNlIGlmIChlLmtleSA9PT0gXCJ3XCIgfHwgZS5rZXkgPT09IFwiV1wiKSB7IHZvaWQgYXJtV2FrZSghd2FrZUFybWVkKTsgZS5wcmV2ZW50RGVmYXVsdCgpOyB9XG4gICAgZWxzZSBpZiAoZS5rZXkgPT09IFwiL1wiKSB7ICQoXCJ0ZXh0XCIpLmZvY3VzKCk7IGUucHJldmVudERlZmF1bHQoKTsgfVxuICAgIGVsc2UgaWYgKGUuY29kZSA9PT0gXCJTcGFjZVwiICYmIGNhbGxJZCAmJiBtdXRlZCAmJiAhZS5yZXBlYXQpIHsgaG9sZGluZyA9IHRydWU7IHB1c2goeyB0eXBlOiBcInVubXV0ZVwiIH0pOyBzaG93U3RhdHVzKCk7IGUucHJldmVudERlZmF1bHQoKTsgfVxuICB9KTtcbiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcImtleXVwXCIsIChlKSA9PiB7XG4gICAgaWYgKGUuY29kZSA9PT0gXCJTcGFjZVwiICYmIGhvbGRpbmcpIHsgaG9sZGluZyA9IGZhbHNlOyBwdXNoKHsgdHlwZTogXCJtdXRlXCIgfSk7IHNob3dTdGF0dXMoKTsgfVxuICB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gc3VibWl0VGV4dChlOiBFdmVudCkge1xuICBlLnByZXZlbnREZWZhdWx0KCk7XG4gIGNvbnN0IGlucHV0ID0gJDxIVE1MSW5wdXRFbGVtZW50PihcInRleHRcIik7XG4gIGxldCB0ZXh0ID0gaW5wdXQudmFsdWUudHJpbSgpO1xuICBpZiAoIXRleHQpIHJldHVybjtcbiAgLy8gV2l0aCBubyBjYWxsIG9uLCB0eXBpbmcgc3RhcnRzIGEgY2hhdDogdGhlIHNhbWUgbWFpbiB0aHJlYWQsIGluIHRleHQuXG4gIGlmICghY2FsbElkKSB7XG4gICAgaW5wdXQudmFsdWUgPSBcIlwiO1xuICAgIHN5bmNDb21wb3NlcigpO1xuICAgIHRyeSB7IGF3YWl0IHN0YXJ0KGZhbHNlLCB0cnVlKTsgfSBjYXRjaCAoZXJyKSB7IHRvYXN0KChlcnIgYXMgRXJyb3IpLm1lc3NhZ2UpOyBsb2coXCJlcnJvclwiLCAoZXJyIGFzIEVycm9yKS5tZXNzYWdlLCBcImVyclwiKTsgfVxuICAgIGlmICghY2FsbElkKSB7IGlucHV0LnZhbHVlID0gdGV4dDsgc3luY0NvbXBvc2VyKCk7IHJldHVybjsgfVxuICB9XG4gIC8vIFwiL3QzIFx1MjAyNlwiIGFuZCBcIi9oIFx1MjAyNlwiIHBpY2sgdGhlIGFnZW50IHdoYXRldmVyIHRoZSBzZWxlY3RvciBzYXlzLlxuICBjb25zdCBwYXJzZWQgPSBwYXJzZVByZWZpeCh0ZXh0KTtcbiAgY29uc3QgbW9kZSA9IHBhcnNlZC5tb2RlID8/ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwibW9kZVwiKS52YWx1ZTtcbiAgdGV4dCA9IHBhcnNlZC5yZXN0O1xuICBpZiAoIXRleHQpIHJldHVybjtcbiAgaWYgKG1vZGUgPT09IFwic2F5XCIpIHtcbiAgICBwdXNoKHsgdHlwZTogXCJzYXlcIiwgdGV4dCB9KTtcbiAgICBzY3JvbGxEb3duKHRydWUpO1xuICB9IGVsc2Uge1xuICAgIHB1c2goeyB0eXBlOiBcImFza1wiLCB0ZXh0LCBhZ2VudDogbW9kZSB9KTtcbiAgICBub3RlKGBZb3UgXHUyMTkyIG5ldyAke21vZGUgPT09IFwidDNcIiA/IFwiY29kaW5nXCIgOiBcIkhlcm1lc1wifSB0YXNrOiAke3RleHR9YCk7XG4gICAgc2Nyb2xsRG93bih0cnVlKTtcbiAgfVxuICBpbnB1dC52YWx1ZSA9IFwiXCI7XG4gIHN5bmNDb21wb3NlcigpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBtYWluKCkge1xuICBhcHBseVRoZW1lKGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UudGhlbWVcIikgPz8gXCJzeXN0ZW1cIik7XG4gIGFwcGx5RGVuc2l0eShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLmRlbnNpdHlcIikpO1xuICBzZXJ2ZXIgPSBhd2FpdCAoYXdhaXQgZmV0Y2goXCIvY29uZmlnXCIpKS5qc29uKCk7XG4gICQoXCJyb3V0ZVwiKS50ZXh0Q29udGVudCA9IGAke3NlcnZlci5yb3V0ZSA9PT0gXCJ2ZXJ0ZXhcIiA/IFwiVmVydGV4XCIgOiBcIkdlbWluaSBBUElcIn0gXHUwMEI3ICR7c2VydmVyLm1vZGVsLnNwbGl0KFwiL1wiKS5wb3AoKX1gO1xuICAkKFwidmVyc2lvblwiKS50ZXh0Q29udGVudCA9IHNlcnZlci52ZXJzaW9uO1xuICAkKFwiYnVpbGRcIikudGV4dENvbnRlbnQgPSBgY29yZSAke3NlcnZlci52ZXJzaW9ufWA7XG4gIHNldHRpbmdzRnJvbVN0b3JhZ2UoKTtcbiAgY29uc3Qgd2FrZVNlbGVjdCA9ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwid2FrZS1tb2RlbFwiKTtcbiAgY29uc3Qgd2FrZUxpc3QgPSBzZXJ2ZXIud2FrZU1vZGVscyA/PyBbXTtcbiAgZm9yIChjb25zdCBtIG9mIHdha2VMaXN0KSB3YWtlU2VsZWN0LmFkZChuZXcgT3B0aW9uKG0ubGFiZWwsIG0uaWQpKTtcbiAgY29uc3Qgc2F2ZWRXYWtlTW9kZWwgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLndha2UtbW9kZWxcIik7XG4gIGlmIChzYXZlZFdha2VNb2RlbCAmJiB3YWtlTGlzdC5zb21lKChtKSA9PiBtLmlkID09PSBzYXZlZFdha2VNb2RlbCkpIHdha2VTZWxlY3QudmFsdWUgPSBzYXZlZFdha2VNb2RlbDtcbiAgZWxzZSBpZiAod2FrZUxpc3Quc29tZSgobSkgPT4gbS5pZCA9PT0gXCJwZW5ueXdvcnRoXCIpKSB3YWtlU2VsZWN0LnZhbHVlID0gXCJwZW5ueXdvcnRoXCI7XG4gIGlmICh3YWtlTGlzdC5sZW5ndGggPT09IDApIHtcbiAgICAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwid2FrZS1lbmFibGVkXCIpLmRpc2FibGVkID0gdHJ1ZTtcbiAgICB3YWtlU2VsZWN0LmRpc2FibGVkID0gdHJ1ZTtcbiAgICAkKFwid2FrZS1oZWxwXCIpLnRleHRDb250ZW50ID0gXCJObyAub25ueCB3YWtlIHdvcmQgbW9kZWxzIGZvdW5kIG9uIHRoZSBzZXJ2ZXIuXCI7XG4gIH1cbiAgaWYgKCFzZXJ2ZXIuaGVybWVzKSB7ICQ8SFRNTElucHV0RWxlbWVudD4oXCJmYWtlaGVybWVzXCIpLmNoZWNrZWQgPSB0cnVlOyAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwiZmFrZWhlcm1lc1wiKS5kaXNhYmxlZCA9IHRydWU7IH1cbiAgaWYgKCFzZXJ2ZXIudDMpICQoXCJjb2RpbmdoZWxwXCIpLnRleHRDb250ZW50ID0gXCJUMyBpc24ndCBhdmFpbGFibGUgb24gdGhlIHNlcnZlcjogb25seSB3aXRoIGZha2UgYW5zd2Vycy5cIjtcbiAgZWxzZSAkKFwiY29kaW5naGVscFwiKS50ZXh0Q29udGVudCA9IGBDb2RlIGNoYW5nZXMgZ28gdG8gYSBUMyBDb2RlIHRocmVhZCBpbiBvbmUgb2Y6ICR7c2VydmVyLnQzLmpvaW4oXCIsIFwiKX0uYDtcbiAgaWYgKCFzdG9wV29yZHMuc3VwcG9ydGVkKSB7ICQ8SFRNTElucHV0RWxlbWVudD4oXCJzdG9wd29yZFwiKS5jaGVja2VkID0gZmFsc2U7ICQ8SFRNTElucHV0RWxlbWVudD4oXCJzdG9wd29yZFwiKS5kaXNhYmxlZCA9IHRydWU7IH1cbiAgY29uc3QgcHJlc2V0ID0gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJwcmVzZXRcIik7XG4gIGZvciAoY29uc3QgbmFtZSBvZiBPYmplY3Qua2V5cyhQUkVTRVRTKSkgcHJlc2V0LmFkZChuZXcgT3B0aW9uKG5hbWUsIG5hbWUpKTtcbiAgcHJlc2V0LnZhbHVlID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS1jb3JlLnByZXNldFwiKSA/PyBcIndlYlwiO1xuICBpZiAoIVBSRVNFVFNbcHJlc2V0LnZhbHVlXSkgcHJlc2V0LnZhbHVlID0gXCJ3ZWJcIjtcbiAgJDxIVE1MVGV4dEFyZWFFbGVtZW50PihcImNvbmZpZ1wiKS52YWx1ZSA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UtY29yZS5jb25maWdcIikgPz8gSlNPTi5zdHJpbmdpZnkoUFJFU0VUU1twcmVzZXQudmFsdWVdLCBudWxsLCAyKTtcbiAgc3luY1NpZ25hbGluZ1VpKCk7XG4gIHByZXNldC5vbmNoYW5nZSA9ICgpID0+IHtcbiAgICAkPEhUTUxUZXh0QXJlYUVsZW1lbnQ+KFwiY29uZmlnXCIpLnZhbHVlID0gSlNPTi5zdHJpbmdpZnkoUFJFU0VUU1twcmVzZXQudmFsdWVdLCBudWxsLCAyKTtcbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLWNvcmUucHJlc2V0XCIsIHByZXNldC52YWx1ZSk7XG4gICAgbG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oXCJ2b2ljZS1jb3JlLmNvbmZpZ1wiKTtcbiAgICBzeW5jU2lnbmFsaW5nVWkoKTtcbiAgfTtcbiAgJChcImNvbmZpZ1wiKS5vbmlucHV0ID0gKCkgPT4geyBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLWNvcmUuY29uZmlnXCIsICQ8SFRNTFRleHRBcmVhRWxlbWVudD4oXCJjb25maWdcIikudmFsdWUpOyBzeW5jU2lnbmFsaW5nVWkoKTsgfTtcbiAgJChcImRlZmF1bHRzXCIpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYyA9IGNvcmUgPz8gKGF3YWl0IGxvYWRDb3JlKCkpO1xuICAgICQoXCJkZWZhdWx0c3ZpZXdcIikudGV4dENvbnRlbnQgPSBKU09OLnN0cmluZ2lmeShKU09OLnBhcnNlKGMuZGVmYXVsdHMoKSksIG51bGwsIDIpO1xuICAgICQoXCJkZWZhdWx0c3ZpZXdcIikuaGlkZGVuID0gISQoXCJkZWZhdWx0c3ZpZXdcIikuaGlkZGVuO1xuICB9O1xuICBjb25zdCBvbkNhbGxDbGljayA9ICgpID0+IHZvaWQgY2FsbEJ1dHRvbigpLmNhdGNoKChlcnIpID0+IHsgdG9hc3QoZXJyLm1lc3NhZ2UpOyBsb2coXCJlcnJvclwiLCBlcnIubWVzc2FnZSwgXCJlcnJcIik7IH0pO1xuICBjb25zdCBvbkhlcm9DYWxsQ2xpY2sgPSAoKSA9PiB7IGlmICghY2FsbElkKSB2b2lkIHN0YXJ0KCkuY2F0Y2goKGVycikgPT4geyB0b2FzdChlcnIubWVzc2FnZSk7IGxvZyhcImVycm9yXCIsIGVyci5tZXNzYWdlLCBcImVyclwiKTsgfSk7IH07XG4gIGNvbnN0IG9uUmVzdW1lQ2xpY2sgPSAoKSA9PiB2b2lkIHN0YXJ0KHRydWUpLmNhdGNoKChlcnIpID0+IHsgdG9hc3QoZXJyLm1lc3NhZ2UpOyBsb2coXCJlcnJvclwiLCBlcnIubWVzc2FnZSwgXCJlcnJcIik7IH0pO1xuICAkKFwiY2FsbFwiKS5vbmNsaWNrID0gb25DYWxsQ2xpY2s7XG4gICQoXCJoZXJvLWNhbGxcIikub25jbGljayA9IG9uSGVyb0NhbGxDbGljaztcbiAgJChcImhlcm8td2FrZVwiKS5vbmNsaWNrID0gKCkgPT4ge1xuICAgIGlmICh3YWtlQXJtZWQgJiYgYXVkaW8uYXVkaW9TdXNwZW5kZWQpIHsgdm9pZCBhdWRpby5yZXN1bWVBdWRpbygpLnRoZW4oKCkgPT4gc3luY1dha2VVaSgpKTsgcmV0dXJuOyB9XG4gICAgdm9pZCBhcm1XYWtlKCF3YWtlQXJtZWQpO1xuICB9O1xuICAkKFwid2FrZWJ0blwiKS5vbmNsaWNrID0gKCkgPT4ge1xuICAgIGlmICh3YWtlQXJtZWQgJiYgYXVkaW8uYXVkaW9TdXNwZW5kZWQpIHsgdm9pZCBhdWRpby5yZXN1bWVBdWRpbygpLnRoZW4oKCkgPT4gc3luY1dha2VVaSgpKTsgcmV0dXJuOyB9XG4gICAgdm9pZCBhcm1XYWtlKCF3YWtlQXJtZWQpO1xuICB9O1xuICAkKFwid2FrZS1ub3dcIikub25jbGljayA9ICgpID0+IHsgaWYgKGNhbGxJZCkgcHVzaCh7IHR5cGU6IFwicmVzdW1lXCIgfSk7IH07XG4gICQoXCJyZXN1bWVcIikub25jbGljayA9IG9uUmVzdW1lQ2xpY2s7XG4gICQoXCJoZXJvLXJlc3VtZVwiKS5vbmNsaWNrID0gb25SZXN1bWVDbGljaztcbiAgc3luY1dha2VVaSgpO1xuICBpZiAobG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS53YWtlLWVuYWJsZWRcIikgPT09IFwiMVwiICYmIHdha2VMaXN0Lmxlbmd0aCA+IDApIHtcbiAgICAvLyBSZS1hcm0gYXV0b21hdGljYWxseSBvbiByZWxvYWQgb25seSB3aGVuIG1pY3JvcGhvbmUgcGVybWlzc2lvbiBpcyBhbHJlYWR5IGdyYW50ZWQuXG4gICAgdm9pZCBuYXZpZ2F0b3IucGVybWlzc2lvbnM/LnF1ZXJ5KHsgbmFtZTogXCJtaWNyb3Bob25lXCIgYXMgUGVybWlzc2lvbk5hbWUgfSlcbiAgICAgIC50aGVuKChwKSA9PiB7IGlmIChwLnN0YXRlID09PSBcImdyYW50ZWRcIikgdm9pZCBhcm1XYWtlKHRydWUsIGZhbHNlKTsgfSlcbiAgICAgIC5jYXRjaCgoKSA9PiB7fSk7XG4gIH1cbiAgaWYgKHNhdmVkSGlzdG9yeSgpLmxlbmd0aCA+IDApIHtcbiAgICBzeW5jUmVzdW1lQnV0dG9ucyh0cnVlKTtcbiAgICAkKFwicmVzdW1lXCIpLnRpdGxlID0gXCJDYWxsIGFnYWluLCBjYXJyeWluZyBvbiBmcm9tIHRoZSBsYXN0IGNvbnZlcnNhdGlvblwiO1xuICB9XG4gICQoXCJtaWNcIikub25jbGljayA9ICgpID0+IHNldE11dGVkKCFtdXRlZCk7XG4gICQoXCJodXNoXCIpLm9uY2xpY2sgPSAoKSA9PiB7IHB1c2goeyB0eXBlOiBcImludGVycnVwdFwiIH0pOyBhdWRpby5mbHVzaCgpOyB9O1xuICAkKFwiY2FuY2VsYWxsXCIpLm9uY2xpY2sgPSAoKSA9PiBwdXNoKHsgdHlwZTogXCJjYW5jZWxBbGxcIiB9KTtcbiAgJChcImRvbmVib3hcIikuYWRkRXZlbnRMaXN0ZW5lcihcInRvZ2dsZVwiLCAoKSA9PiB7IGlmICgkPEhUTUxEZXRhaWxzRWxlbWVudD4oXCJkb25lYm94XCIpLm9wZW4pICQoXCJkb25lYm94XCIpLnNjcm9sbEludG9WaWV3KHsgYmxvY2s6IFwibmVhcmVzdFwiIH0pOyB9KTtcbiAgJChcInNheVwiKS5vbnN1Ym1pdCA9IChlKSA9PiB2b2lkIHN1Ym1pdFRleHQoZSk7XG4gICQoXCJ0ZXh0XCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJpbnB1dFwiLCBzeW5jQ29tcG9zZXIpO1xuICBjb25zdCB0cmFuc2NyaXB0UGFuZSA9ICQoXCJ0cmFuc2NyaXB0XCIpO1xuICB0cmFuc2NyaXB0UGFuZS5hZGRFdmVudExpc3RlbmVyKFwic2Nyb2xsXCIsICgpID0+IHRyYW5zY3JpcHRTY3JvbGwub25TY3JvbGwoKSwgeyBwYXNzaXZlOiB0cnVlIH0pO1xuICB0cmFuc2NyaXB0UGFuZS5hZGRFdmVudExpc3RlbmVyKFwic2Nyb2xsZW5kXCIsICgpID0+IHRyYW5zY3JpcHRTY3JvbGwub25TY3JvbGxFbmQoKSwgeyBwYXNzaXZlOiB0cnVlIH0pO1xuICB0cmFuc2NyaXB0UGFuZS5hZGRFdmVudExpc3RlbmVyKFwid2hlZWxcIiwgKGUpID0+IHsgaWYgKGUuZGVsdGFZIDwgMCkgdHJhbnNjcmlwdFNjcm9sbC5jYW5jZWxKdW1wKCk7IH0sIHsgcGFzc2l2ZTogdHJ1ZSB9KTtcbiAgdHJhbnNjcmlwdFBhbmUuYWRkRXZlbnRMaXN0ZW5lcihcInRvdWNoc3RhcnRcIiwgKCkgPT4gdHJhbnNjcmlwdFNjcm9sbC5jYW5jZWxKdW1wKCksIHsgcGFzc2l2ZTogdHJ1ZSB9KTtcbiAgaWYgKHR5cGVvZiBSZXNpemVPYnNlcnZlciAhPT0gXCJ1bmRlZmluZWRcIikge1xuICAgIG5ldyBSZXNpemVPYnNlcnZlcigoKSA9PiB0cmFuc2NyaXB0U2Nyb2xsLm9uUmVzaXplKCkpLm9ic2VydmUodHJhbnNjcmlwdFBhbmUpO1xuICAgIG5ldyBSZXNpemVPYnNlcnZlcigoKSA9PiB1cGRhdGVBbGxSZXN1bHRDbGFtcGluZygpKS5vYnNlcnZlKCQoXCJyZXN1bHRzXCIpKTtcbiAgfVxuICAkKFwianVtcGJvdHRvbVwiKS5vbmNsaWNrID0gKCkgPT4gdHJhbnNjcmlwdFNjcm9sbC5qdW1wVG9Cb3R0b20oKTtcbiAgc3luY0NvbXBvc2VyKCk7XG4gIHN5bmNTaWRlTGF5b3V0KCk7XG4gIHRhYnMoKTtcbiAga2V5cygpO1xuICBjb25zdCBldmVudHMgPSBuZXcgRXZlbnRTb3VyY2UoXCIvZXZlbnRzXCIpO1xuICBldmVudHMuYWRkRXZlbnRMaXN0ZW5lcihcImNvcmVcIiwgKGUpID0+IHtcbiAgICBjb25zdCB7IHZlcnNpb24gfSA9IEpTT04ucGFyc2UoKGUgYXMgTWVzc2FnZUV2ZW50KS5kYXRhKTtcbiAgICAkKFwidmVyc2lvblwiKS50ZXh0Q29udGVudCA9IHZlcnNpb24gKyAoY2FsbElkICYmIGNvcmUgJiYgY29yZS52ZXJzaW9uICE9PSB2ZXJzaW9uID8gYCAobmV4dCBjYWxsOyB0aGlzIG9uZSBydW5zICR7Y29yZS52ZXJzaW9ufSlgIDogXCJcIik7XG4gICAgJChcImJ1aWxkXCIpLnRleHRDb250ZW50ID0gYGNvcmUgJHt2ZXJzaW9ufWA7XG4gIH0pO1xuICBldmVudHMuYWRkRXZlbnRMaXN0ZW5lcihcImFwcFwiLCAoKSA9PiB7IGlmICghY2FsbElkKSBsb2NhdGlvbi5yZWxvYWQoKTsgZWxzZSB0b2FzdChcIlRoZSBwYWdlIGNoYW5nZWQ6IHJlbG9hZCBhZnRlciB0aGlzIGNhbGxcIik7IH0pO1xuICBldmVudHMuYWRkRXZlbnRMaXN0ZW5lcihcImVycm9yXCIsIChlKSA9PiB7XG4gICAgY29uc3QgZGF0YSA9IChlIGFzIE1lc3NhZ2VFdmVudCkuZGF0YTtcbiAgICBpZiAoZGF0YSkgdG9hc3QoYEJ1aWxkIGZhaWxlZDogJHtKU09OLnBhcnNlKGRhdGEpLm1lc3NhZ2V9YCk7XG4gIH0pO1xuICBuZXcgUmVwbGF5KCQoXCJyZXBsYXlcIiksIGxvYWRDb3JlKTtcbiAgdm9pZCBwaW5nKCk7XG4gIHZvaWQgc2hvd0VhcmxpZXIoKTtcbiAgd2luZG93LnNldEludGVydmFsKCgpID0+IHZvaWQgc2hvd0VhcmxpZXIoKSwgMzBfMDAwKTtcbn1cblxudm9pZCBtYWluKCk7XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBU0EsSUFBTSxTQUFTLG9CQUFJLElBQUk7QUFBQSxFQUNyQjtBQUFBLEVBQU87QUFBQSxFQUFNO0FBQUEsRUFBUTtBQUFBLEVBQVU7QUFBQSxFQUFPO0FBQUEsRUFBUTtBQUFBLEVBQU07QUFBQSxFQUFNO0FBQUEsRUFBTTtBQUFBLEVBQU07QUFBQSxFQUFXO0FBQUEsRUFBUztBQUFBLEVBQVE7QUFBQSxFQUFPO0FBQUEsRUFBVTtBQUFBLEVBQVM7QUFBQSxFQUM1SDtBQUNGLENBQUM7QUFHTSxTQUFTLE1BQU0sTUFBd0I7QUFDNUMsU0FBTyxLQUFLLFlBQVksRUFBRSxRQUFRLFVBQVUsRUFBRSxFQUFFLFFBQVEscUJBQXFCLEdBQUcsRUFBRSxLQUFLLEVBQUUsTUFBTSxHQUFHLEVBQUUsT0FBTyxDQUFDLE1BQU0sRUFBRSxTQUFTLENBQUM7QUFDaEk7QUFHTyxTQUFTLFVBQVUsV0FBbUIsVUFBeUIsUUFBa0IsQ0FBQyxHQUF3QjtBQUMvRyxRQUFNLFVBQVUsb0JBQUksSUFBSSxDQUFDLEdBQUcsUUFBUSxHQUFHLE1BQU0sUUFBUSxLQUFLLENBQUMsQ0FBQztBQUM1RCxRQUFNLE9BQU8sTUFBTSxTQUFTO0FBQzVCLE1BQUksT0FBTztBQUNYLE1BQUksS0FBSyxLQUFLO0FBQ2QsU0FBTyxPQUFPLE1BQU0sUUFBUSxJQUFJLEtBQUssSUFBSSxDQUFDLEVBQUc7QUFDN0MsU0FBTyxLQUFLLFFBQVEsUUFBUSxJQUFJLEtBQUssS0FBSyxDQUFDLENBQUMsRUFBRztBQUMvQyxNQUFJLFNBQVMsTUFBTSxLQUFLLE9BQU8sRUFBRyxRQUFPO0FBQ3pDLFFBQU1BLFFBQU8sS0FBSyxNQUFNLE1BQU0sRUFBRSxFQUFFLEtBQUssR0FBRztBQUMxQyxRQUFNLEtBQUssQ0FBQyxZQUFzQixRQUFRLEtBQUssQ0FBQyxNQUFNLE1BQU0sQ0FBQyxFQUFFLEtBQUssR0FBRyxNQUFNQSxLQUFJO0FBQ2pGLE1BQUksR0FBRyxTQUFTLE1BQU0sRUFBRyxRQUFPO0FBQ2hDLE1BQUksR0FBRyxTQUFTLGFBQWEsQ0FBQyxDQUFDLEVBQUcsUUFBTztBQUN6QyxNQUFJLEdBQUcsU0FBUyxJQUFJLEVBQUcsUUFBTztBQUM5QixTQUFPO0FBQ1Q7OztBQzlCQSxJQUFNLFdBQVc7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBMkZqQixTQUFTLGNBQWMsS0FBeUI7QUFDOUMsUUFBTSxNQUFNLEtBQUssR0FBRztBQUNwQixRQUFNLE1BQU0sSUFBSSxXQUFXLElBQUksTUFBTTtBQUNyQyxXQUFTLElBQUksR0FBRyxJQUFJLElBQUksUUFBUSxJQUFLLEtBQUksQ0FBQyxJQUFJLElBQUksV0FBVyxDQUFDO0FBQzlELFNBQU87QUFDVDtBQUVPLFNBQVMsY0FBYyxPQUEyQjtBQUN2RCxNQUFJLE1BQU07QUFDVixXQUFTLElBQUksR0FBRyxJQUFJLE1BQU0sUUFBUSxLQUFLLE1BQVEsUUFBTyxPQUFPLGFBQWEsR0FBRyxNQUFNLFNBQVMsR0FBRyxJQUFJLEtBQU0sQ0FBQztBQUMxRyxTQUFPLEtBQUssR0FBRztBQUNqQjtBQUdBLFNBQVMsU0FBUyxLQUFpQixNQUFjLFFBQThCO0FBQzdFLFFBQU0sT0FBTyxJQUFJLFNBQVMsSUFBSSxRQUFRLElBQUksWUFBWSxJQUFJLFVBQVU7QUFDcEUsUUFBTSxJQUFJLEtBQUssTUFBTSxJQUFJLGFBQWEsQ0FBQztBQUN2QyxRQUFNLE1BQU0sSUFBSSxhQUFhLEtBQUssTUFBTyxJQUFJLFNBQVUsSUFBSSxDQUFDO0FBQzVELFFBQU0sT0FBTyxPQUFPO0FBQ3BCLFdBQVMsSUFBSSxHQUFHLElBQUksSUFBSSxRQUFRLEtBQUs7QUFDbkMsVUFBTSxJQUFJLElBQUk7QUFDZCxVQUFNLElBQUksS0FBSyxNQUFNLENBQUM7QUFDdEIsVUFBTSxJQUFJLEtBQUssU0FBUyxJQUFJLEtBQUssSUFBSSxHQUFHLElBQUksQ0FBQyxHQUFHLElBQUk7QUFDcEQsVUFBTSxJQUFJLEtBQUssU0FBUyxJQUFJLEtBQUssSUFBSSxJQUFJLEdBQUcsSUFBSSxDQUFDLEdBQUcsSUFBSTtBQUN4RCxRQUFJLENBQUMsS0FBSyxLQUFLLElBQUksTUFBTSxJQUFJLE1BQU07QUFBQSxFQUNyQztBQUNBLFNBQU87QUFDVDtBQUlPLElBQU0sWUFBTixNQUFnQjtBQUFBLEVBQWhCO0FBQ0wsU0FBUSxVQUErQjtBQUN2QyxTQUFRLFdBQW9DO0FBQzVDLFNBQVEsVUFBbUM7QUFDM0MsU0FBUSxTQUE2QjtBQUNyQyxTQUFRLFNBQTRDO0FBQ3BELFNBQVEsVUFBNkI7QUFDckMsU0FBUSxhQUFvRTtBQUU1RTtBQUFBLFNBQVEsU0FBUztBQUNqQixTQUFRLFVBQWdDO0FBQ3hDLFNBQVEsZ0JBQXFDO0FBRTdDO0FBQUEsa0JBQVM7QUFFVDtBQUFBLGlCQUFRO0FBQUE7QUFBQSxFQUVSLG1CQUFtQixVQUFxQztBQUN0RCxTQUFLLGdCQUFnQjtBQUFBLEVBQ3ZCO0FBQUE7QUFBQSxFQUdBLElBQUksaUJBQTBCO0FBQzVCLFdBQU8sS0FBSyxXQUFXLFFBQVEsS0FBSyxRQUFRLFVBQVU7QUFBQSxFQUN4RDtBQUFBLEVBRUEsTUFBTSxjQUFnQztBQUNwQyxVQUFNLE1BQU0sS0FBSztBQUNqQixRQUFJLENBQUMsSUFBSyxRQUFPO0FBQ2pCLFFBQUksSUFBSSxVQUFVLFVBQVcsUUFBTztBQUNwQyxRQUFJO0FBQUUsWUFBTSxJQUFJLE9BQU87QUFBQSxJQUFHLFFBQVE7QUFBQSxJQUFDO0FBQ25DLFdBQVEsSUFBSSxVQUFnQztBQUFBLEVBQzlDO0FBQUEsRUFFQSxNQUFNLE9BQXNCO0FBQzFCLFFBQUksS0FBSyxTQUFTO0FBQ2hCLFlBQU0sS0FBSztBQUNYLFVBQUksS0FBSyxTQUFTLFVBQVUsWUFBYSxPQUFNLEtBQUssUUFBUSxPQUFPLEVBQUUsTUFBTSxNQUFNO0FBQUEsTUFBQyxDQUFDO0FBQ25GO0FBQUEsSUFDRjtBQUNBLFFBQUksS0FBSyxTQUFTO0FBQUUsVUFBSSxLQUFLLFFBQVEsVUFBVSxZQUFhLE9BQU0sS0FBSyxRQUFRLE9BQU8sRUFBRSxNQUFNLE1BQU07QUFBQSxNQUFDLENBQUM7QUFBRztBQUFBLElBQVE7QUFDakgsVUFBTSxRQUFRLFlBQVk7QUFDeEIsVUFBSSxNQUEyQjtBQUMvQixVQUFJO0FBQ0YsY0FBTSxJQUFJLGFBQWEsRUFBRSxhQUFhLGNBQWMsQ0FBQztBQUNyRCxZQUFJLGdCQUFnQixNQUFNLEtBQUssZ0JBQWdCO0FBQy9DLGNBQU0sTUFBTSxJQUFJLGdCQUFnQixJQUFJLEtBQUssQ0FBQyxRQUFRLEdBQUcsRUFBRSxNQUFNLGtCQUFrQixDQUFDLENBQUM7QUFDakYsY0FBTSxJQUFJLGFBQWEsVUFBVSxHQUFHO0FBQ3BDLGNBQU0sV0FBVyxJQUFJLGlCQUFpQixLQUFLLFlBQVksRUFBRSxnQkFBZ0IsR0FBRyxvQkFBb0IsQ0FBQyxDQUFDLEVBQUUsQ0FBQztBQUNyRyxpQkFBUyxLQUFLLFlBQVksQ0FBQyxNQUFNO0FBQUUsZUFBSyxTQUFTLEVBQUUsS0FBSztBQUFBLFFBQVE7QUFDaEUsaUJBQVMsUUFBUSxJQUFJLFdBQVc7QUFDaEMsYUFBSyxVQUFVO0FBQ2YsYUFBSyxXQUFXO0FBQ2hCLGFBQUssZ0JBQWdCO0FBQUEsTUFDdkIsU0FBUyxLQUFLO0FBQ1osWUFBSTtBQUFFLGdCQUFNLEtBQUssUUFBUTtBQUFBLFFBQUcsUUFBUTtBQUFBLFFBQUM7QUFDckMsY0FBTTtBQUFBLE1BQ1IsVUFBRTtBQUNBLGFBQUssVUFBVTtBQUFBLE1BQ2pCO0FBQUEsSUFDRixHQUFHO0FBQ0gsU0FBSyxVQUFVO0FBQ2YsVUFBTTtBQUFBLEVBQ1I7QUFBQTtBQUFBLEVBR0EsSUFBSSxnQkFBK0I7QUFDakMsUUFBSSxDQUFDLEtBQUssUUFBUyxRQUFPO0FBQzFCLFdBQU8sS0FBSyxRQUFRLGVBQWdCLEtBQUssUUFBc0QsaUJBQWlCO0FBQUEsRUFDbEg7QUFBQSxFQUVBLElBQUksWUFBcUI7QUFDdkIsV0FBTyxLQUFLLFdBQVcsUUFBUSxLQUFLLFVBQVUsUUFBUSxLQUFLLE9BQU8sVUFBVSxFQUFFLEtBQUssQ0FBQyxNQUFNLEVBQUUsZUFBZSxNQUFNO0FBQUEsRUFDbkg7QUFBQTtBQUFBLEVBR0EsTUFBTSxVQUFVLFNBQXVELFNBQW9DO0FBQ3pHLFFBQ0UsS0FBSyxhQUNMLEtBQUssV0FDTCxLQUFLLFFBQVEscUJBQXFCLFFBQVEsb0JBQzFDLEtBQUssUUFBUSxxQkFBcUIsUUFBUSxvQkFDMUMsS0FBSyxRQUFRLG9CQUFvQixRQUFRLGlCQUN6QztBQUNBLFlBQU0sS0FBSyxLQUFLO0FBQ2hCLFdBQUssYUFBYTtBQUNsQjtBQUFBLElBQ0Y7QUFDQSxVQUFNLEtBQUssU0FBUyxTQUFTLE9BQU87QUFBQSxFQUN0QztBQUFBLEVBRUEsTUFBTSxTQUFTLFNBQXVELFNBQW9DO0FBQ3hHLFNBQUssUUFBUTtBQUNiLFVBQU0sTUFBTSxFQUFFLEtBQUs7QUFDbkIsVUFBTSxLQUFLLEtBQUs7QUFDaEIsUUFBSSxRQUFRLEtBQUssT0FBUTtBQUN6QixVQUFNLFVBQVUsS0FBSztBQUNyQixVQUFNLFNBQVMsTUFBTSxVQUFVLGFBQWEsYUFBYSxFQUFFLE9BQU8sRUFBRSxjQUFjLEdBQUcsR0FBRyxRQUFRLEVBQUUsQ0FBQztBQUNuRyxRQUFJLFFBQVEsS0FBSyxRQUFRO0FBQ3ZCLGFBQU8sVUFBVSxFQUFFLFFBQVEsQ0FBQyxNQUFNLEVBQUUsS0FBSyxDQUFDO0FBQzFDO0FBQUEsSUFDRjtBQUNBLFFBQUksU0FBNEM7QUFDaEQsUUFBSSxVQUFtQztBQUN2QyxRQUFJO0FBQ0YsZUFBUyxRQUFRLHdCQUF3QixNQUFNO0FBQy9DLGdCQUFVLElBQUksaUJBQWlCLFNBQVMsV0FBVyxFQUFFLGlCQUFpQixFQUFFLENBQUM7QUFDekUsY0FBUSxLQUFLLFlBQVksQ0FBQyxNQUFNO0FBQzlCLGNBQU0sUUFBUSxJQUFJLFdBQVcsRUFBRSxJQUFtQjtBQUNsRCxZQUFJLE1BQU07QUFDVixtQkFBVyxLQUFLLE1BQU8sUUFBTyxJQUFJO0FBQ2xDLGFBQUssUUFBUSxLQUFLLEtBQUssTUFBTSxNQUFNLE1BQU0sSUFBSTtBQUM3QyxhQUFLLGFBQWEsT0FBTyxLQUFLLEtBQUs7QUFBQSxNQUNyQztBQUNBLGFBQU8sUUFBUSxPQUFPO0FBQUEsSUFDeEIsU0FBUyxLQUFLO0FBQ1osY0FBUSxXQUFXO0FBQ25CLGVBQVMsS0FBSyxNQUFNO0FBQ3BCLGFBQU8sVUFBVSxFQUFFLFFBQVEsQ0FBQyxNQUFNLEVBQUUsS0FBSyxDQUFDO0FBQzFDLFlBQU07QUFBQSxJQUNSO0FBQ0EsU0FBSyxTQUFTO0FBQ2QsU0FBSyxVQUFVLEVBQUUsR0FBRyxRQUFRO0FBQzVCLFNBQUssYUFBYTtBQUNsQixTQUFLLFNBQVM7QUFDZCxTQUFLLFVBQVU7QUFBQSxFQUNqQjtBQUFBLEVBRUEsVUFBZ0I7QUFDZCxTQUFLO0FBQ0wsU0FBSyxRQUFRLFdBQVc7QUFDeEIsU0FBSyxTQUFTLEtBQUssTUFBTTtBQUN6QixTQUFLLFFBQVEsVUFBVSxFQUFFLFFBQVEsQ0FBQyxNQUFNLEVBQUUsS0FBSyxDQUFDO0FBQ2hELFNBQUssU0FBUztBQUNkLFNBQUssVUFBVTtBQUNmLFNBQUssU0FBUztBQUNkLFNBQUssVUFBVTtBQUNmLFNBQUssYUFBYTtBQUNsQixTQUFLLFFBQVE7QUFBQSxFQUNmO0FBQUEsRUFFQSxLQUFLLE9BQXFCO0FBQ3hCLFFBQUksQ0FBQyxLQUFLLFdBQVcsQ0FBQyxLQUFLLFNBQVU7QUFDckMsVUFBTSxVQUFVLFNBQVMsY0FBYyxLQUFLLEdBQUcsTUFBTyxLQUFLLFFBQVEsVUFBVTtBQUM3RSxTQUFLLFNBQVMsS0FBSyxZQUFZLEVBQUUsTUFBTSxRQUFRLFFBQVEsR0FBRyxDQUFDLFFBQVEsTUFBTSxDQUFDO0FBQUEsRUFDNUU7QUFBQSxFQUVBLElBQUksT0FBcUI7QUFDdkIsUUFBSSxDQUFDLEtBQUssV0FBVyxDQUFDLEtBQUssU0FBVTtBQUNyQyxVQUFNLFVBQVUsU0FBUyxjQUFjLEtBQUssR0FBRyxNQUFPLEtBQUssUUFBUSxVQUFVO0FBQzdFLFNBQUssU0FBUyxLQUFLLFlBQVksRUFBRSxNQUFNLE9BQU8sUUFBUSxHQUFHLENBQUMsUUFBUSxNQUFNLENBQUM7QUFBQSxFQUMzRTtBQUFBLEVBRUEsUUFBYztBQUNaLFNBQUssVUFBVSxLQUFLLFlBQVksRUFBRSxNQUFNLFFBQVEsQ0FBQztBQUFBLEVBQ25EO0FBQUEsRUFFQSxlQUFxQjtBQUNuQixTQUFLLFVBQVUsS0FBSyxZQUFZLEVBQUUsTUFBTSxPQUFPLENBQUM7QUFDaEQsU0FBSyxTQUFTO0FBQUEsRUFDaEI7QUFBQSxFQUVBLE9BQWE7QUFDWCxTQUFLLFFBQVE7QUFDYixTQUFLLGFBQWE7QUFBQSxFQUNwQjtBQUNGOzs7QUN2UkEsU0FBUyxLQUFLLEdBQWdDO0FBQzVDLFFBQU0sT0FBTyxLQUFLLFVBQVUsQ0FBQyxFQUFFLFFBQVEsdUNBQXVDLGVBQVUsRUFDckYsUUFBUSx5Q0FBeUMseUJBQW9CO0FBQ3hFLFNBQU8sS0FBSyxTQUFTLE1BQU0sS0FBSyxNQUFNLEdBQUcsR0FBRyxJQUFJLFdBQU07QUFDeEQ7QUFHQSxTQUFTLFFBQVEsR0FBaUM7QUFDaEQsTUFBSSxFQUFFLFNBQVMsU0FBUyxFQUFFLFNBQVMsVUFBVSxFQUFFLFNBQVMsT0FBUSxRQUFPO0FBQ3ZFLE1BQUksRUFBRSxTQUFTLGFBQWEsT0FBTyxFQUFFLElBQUksRUFBRSxXQUFXLDJCQUEyQixFQUFHLFFBQU87QUFDM0YsTUFBSSxFQUFFLFNBQVMsZ0JBQWdCLE9BQU8sRUFBRSxJQUFJLEVBQUUsU0FBUyxjQUFjLEtBQUssQ0FBQyxPQUFPLEVBQUUsSUFBSSxFQUFFLFNBQVMsZ0JBQWdCLEVBQUcsUUFBTztBQUM3SCxTQUFPO0FBQ1Q7QUFFQSxTQUFTLElBQUlDLE9BQVksR0FBMEI7QUFDakQsUUFBTSxVQUFVLEtBQUssTUFBTUEsTUFBSyxPQUFPLEtBQUssVUFBVSxFQUFFLE1BQU0sR0FBRyxFQUFFLEtBQUssQ0FBQztBQUN6RSxRQUFNLE1BQWtCLENBQUMsUUFBUSxTQUFTLE9BQU8sT0FBTyxFQUFFLElBQUksSUFBSSxDQUFDO0FBQ25FLGFBQVcsS0FBSyxFQUFFLE9BQVEsS0FBSSxLQUFNLEtBQUssTUFBTUEsTUFBSyxLQUFLLFFBQVEsSUFBSSxLQUFLLFVBQVUsQ0FBQyxDQUFDLENBQUMsRUFBNEIsT0FBTyxPQUFPLEVBQUUsSUFBSSxJQUFJLENBQUM7QUFDNUksU0FBTztBQUNUO0FBRU8sSUFBTSxTQUFOLE1BQWE7QUFBQSxFQUlsQixZQUFZLE1BQW1CLE1BQXVDO0FBQ3BFLFNBQUssT0FBTztBQUNaLFNBQUssT0FBTztBQUNaLFNBQUssWUFBWTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBS2pCLElBQUMsS0FBSyxjQUFjLFVBQVUsRUFBa0IsVUFBVSxNQUFNLEtBQUssS0FBSyxLQUFLO0FBQy9FLElBQUMsS0FBSyxjQUFjLEtBQUssRUFBa0IsVUFBVSxNQUFNLEtBQUssS0FBSyxPQUFPLEVBQUUsTUFBTSxDQUFDLFFBQVEsS0FBSyxJQUFJLGtCQUFrQixJQUFJLE9BQU8sRUFBRSxDQUFDO0FBQ3RJLFNBQUssS0FBSyxLQUFLO0FBQUEsRUFDakI7QUFBQSxFQUVRLElBQUksTUFBYztBQUN4QixJQUFDLEtBQUssS0FBSyxjQUFjLFVBQVUsRUFBa0IsY0FBYztBQUFBLEVBQ3JFO0FBQUEsRUFFQSxNQUFjLE9BQU87QUFDbkIsVUFBTSxPQUFPLEtBQUssS0FBSyxjQUFjLE9BQU87QUFDNUMsU0FBSyxZQUFZO0FBQ2pCLFVBQU0sU0FBNEMsT0FBTyxNQUFNLE1BQU0sU0FBUyxHQUFHLEtBQUs7QUFDdEYsVUFBTSxZQUFzQixPQUFPLE1BQU0sTUFBTSxZQUFZLEdBQUcsS0FBSztBQUNuRSxVQUFNLGFBQWEsU0FBUyxjQUFjLFVBQVU7QUFDcEQsZUFBVyxRQUFRO0FBQ25CLGVBQVcsS0FBSyxPQUFRLFlBQVcsT0FBTyxJQUFJLE9BQU8sR0FBRyxFQUFFLElBQUksS0FBSyxLQUFLLE1BQU0sRUFBRSxRQUFRLElBQUksQ0FBQyxRQUFRLFdBQVcsRUFBRSxJQUFJLEVBQUUsQ0FBQztBQUN6SCxVQUFNLGdCQUFnQixTQUFTLGNBQWMsVUFBVTtBQUN2RCxrQkFBYyxRQUFRO0FBQ3RCLGVBQVcsS0FBSyxVQUFXLGVBQWMsT0FBTyxJQUFJLE9BQU8sR0FBRyxjQUFjLENBQUMsT0FBTyxDQUFDO0FBQ3JGLFNBQUssT0FBTyxZQUFZLGFBQWE7QUFBQSxFQUN2QztBQUFBLEVBRUEsTUFBYyxVQUFVLEtBQWlDO0FBQ3ZELFVBQU0sT0FBTyxPQUFPLE1BQU0sTUFBTSxLQUFLLEVBQUUsT0FBTyxXQUFXLENBQUMsR0FBRyxLQUFLO0FBQ2xFLFFBQUksSUFBSSxTQUFTLE9BQU8sRUFBRyxRQUFPLEtBQUssTUFBTSxJQUFJO0FBQ2pELFVBQU0sQ0FBQyxRQUFRLEdBQUcsTUFBTSxJQUFJLEtBQUssS0FBSyxFQUFFLE1BQU0sSUFBSSxFQUFFLElBQUksQ0FBQyxNQUFNLEtBQUssTUFBTSxDQUFDLENBQUM7QUFDNUUsV0FBTyxFQUFFLEdBQUcsUUFBUSxPQUFPO0FBQUEsRUFDN0I7QUFBQSxFQUVBLE1BQWMsU0FBUztBQUNyQixVQUFNLE1BQU8sS0FBSyxLQUFLLGNBQWMsT0FBTyxFQUF3QjtBQUNwRSxRQUFJLENBQUMsSUFBSztBQUNWLFVBQU0sSUFBSSxNQUFNLEtBQUssVUFBVSxHQUFHO0FBQ2xDLFVBQU0sU0FBUyxNQUFNLEtBQUssS0FBSztBQUMvQixRQUFJLFdBQXdCO0FBQzVCLFFBQUksRUFBRSxXQUFXLEVBQUUsWUFBWSxPQUFPLFNBQVM7QUFDN0MsWUFBTSxXQUFXLE1BQU0sTUFBTSxhQUFhLEVBQUUsT0FBTyxPQUFPLEVBQUUsUUFBUSxPQUFPLENBQUM7QUFDNUUsVUFBSSxTQUFTLEdBQUksWUFBVyxNQUFNLEtBQUssS0FBSyxhQUFhLEVBQUUsT0FBTyxLQUFLO0FBQUEsSUFDekU7QUFDQSxVQUFNQyxPQUFNLElBQUksUUFBUSxDQUFDO0FBQ3pCLFVBQU0sT0FBTyxXQUFXLElBQUksVUFBVSxDQUFDLElBQUk7QUFDM0MsVUFBTSxNQUFPLEtBQUssS0FBSyxjQUFjLE1BQU0sRUFBdUI7QUFDbEUsVUFBTSxXQUFXLEtBQUssS0FBSyxjQUFjLFdBQVc7QUFDcEQsYUFBUyxZQUFZO0FBQ3JCLFFBQUksUUFBUTtBQUNaLFFBQUksU0FBUztBQUNiLFVBQU0sT0FBc0IsQ0FBQztBQUM3QixVQUFNLE1BQU0sQ0FBQyxLQUFhLEdBQVcsU0FBaUI7QUFDcEQsWUFBTSxNQUFNLFNBQVMsY0FBYyxLQUFLO0FBQ3hDLFVBQUksWUFBWSxPQUFPLEdBQUc7QUFDMUIsVUFBSSxZQUFZLG1CQUFtQixDQUFDO0FBQ3BDLFlBQU0sSUFBSSxTQUFTLGNBQWMsTUFBTTtBQUN2QyxRQUFFLFlBQVk7QUFDZCxRQUFFLGNBQWM7QUFDaEIsVUFBSSxPQUFPLENBQUM7QUFDWixlQUFTLE9BQU8sR0FBRztBQUNuQixXQUFLLEtBQUssR0FBRztBQUNiLGFBQU87QUFBQSxJQUNUO0FBQ0EsVUFBTSxLQUFLLEVBQUU7QUFDYixhQUFTLElBQUksR0FBRyxLQUFLLEVBQUUsT0FBTyxRQUFRLEtBQUs7QUFDekMsWUFBTSxJQUFJLE1BQU0sSUFBSSxPQUFPLEVBQUUsT0FBTyxJQUFJLENBQUM7QUFDekMsWUFBTSxTQUFTQSxLQUFJLENBQUM7QUFDcEIsWUFBTSxVQUFVLE9BQU8sS0FBSyxDQUFDLElBQUk7QUFDakMsWUFBTSxPQUFPLE9BQU8sV0FBVyxRQUFRLFVBQVUsT0FBTyxNQUFNLENBQUMsR0FBRyxNQUFNLE1BQU0sUUFBUSxDQUFDLENBQUM7QUFDeEYsVUFBSSxDQUFDLE1BQU07QUFBRTtBQUFVLFlBQUksUUFBUSxFQUFHLFNBQVE7QUFBQSxNQUFHO0FBQ2pELFVBQUksQ0FBQyxRQUFRLE9BQVEsS0FBSyxRQUFRLENBQUMsS0FBTSxPQUFPLFNBQVMsR0FBRztBQUMxRCxZQUFJLE1BQU0sT0FBTyxRQUFRLENBQUMsS0FBSyxDQUFDLE1BQU8sS0FBSSxPQUFPLEVBQUUsSUFBSSxJQUFJLFFBQVEsQ0FBQyxHQUFHLEtBQUssQ0FBQyxDQUFDO0FBQy9FLGNBQU0sSUFBSSxLQUFLLEVBQUUsSUFBSSxJQUFJLFFBQVEsQ0FBQyxJQUFJO0FBQ3RDLFlBQUksS0FBTSxZQUFXLEtBQUssT0FBUSxLQUFJLE9BQU8sR0FBRyxDQUFDO0FBQUEsYUFDNUM7QUFDSCxxQkFBVyxLQUFLLFFBQVMsS0FBSSxZQUFZLEdBQUcsVUFBSyxDQUFDLEVBQUU7QUFDcEQscUJBQVcsS0FBSyxPQUFRLEtBQUksV0FBVyxHQUFHLEtBQUssQ0FBQyxFQUFFO0FBQUEsUUFDcEQ7QUFBQSxNQUNGO0FBQUEsSUFDRjtBQUNBLFVBQU0sV0FBVyxPQUFPLGVBQWUsRUFBRSxPQUFPLDJCQUEyQixPQUFPLE9BQU8sS0FBSyxlQUFlLE9BQU8sT0FBTyxNQUN4SCxFQUFFLFdBQVcsRUFBRSxZQUFZLE9BQU8sVUFBVSwyQkFBMkIsRUFBRSxPQUFPLHNCQUFzQjtBQUN6RyxTQUFLLElBQUksR0FBRyxFQUFFLE9BQU8sTUFBTSxZQUFZLFFBQVEsUUFBUSxPQUFRLFNBQVMsR0FBRyxNQUFNLG9EQUFvRCxLQUFLLE1BQU0sd0NBQXlDLEdBQUc7QUFDNUwsUUFBSSxTQUFTLEVBQUcsVUFBUyxjQUFjLGFBQWEsR0FBRyxlQUFlLEVBQUUsT0FBTyxTQUFTLENBQUM7QUFBQSxFQUMzRjtBQUNGOzs7QUN4R08sSUFBTSxlQUFOLE1BQW1CO0FBQUEsRUFVeEIsWUFBWSxNQUFrQixVQUErQixDQUFDLEdBQUc7QUFKakUsU0FBUSxTQUFTO0FBQ2pCLFNBQVEsVUFBVTtBQUNsQixTQUFRLGdCQUFnQjtBQUd0QixTQUFLLE9BQU87QUFDWixTQUFLLGVBQWUsUUFBUSxnQkFBZ0I7QUFDNUMsU0FBSyxnQkFBZ0IsUUFBUSxpQkFBaUI7QUFDOUMsU0FBSyxlQUFlLFFBQVE7QUFDNUIsU0FBSyxVQUFVLFFBQVE7QUFDdkIsU0FBSyxnQkFBZ0IsS0FBSztBQUFBLEVBQzVCO0FBQUEsRUFFQSxJQUFJLFdBQW9CO0FBQ3RCLFdBQU8sS0FBSztBQUFBLEVBQ2Q7QUFBQSxFQUVRLFdBQW1CO0FBQ3pCLFdBQU8sS0FBSyxJQUFJLEdBQUcsS0FBSyxLQUFLLGVBQWUsS0FBSyxLQUFLLFlBQVksS0FBSyxLQUFLLFlBQVk7QUFBQSxFQUMxRjtBQUFBLEVBRVEsWUFBcUI7QUFDM0IsV0FBTyxLQUFLLEtBQUssZUFBZTtBQUFBLEVBQ2xDO0FBQUEsRUFFUSxlQUFxQjtBQUMzQixRQUFJLENBQUMsS0FBSyxVQUFVLEVBQUc7QUFDdkIsU0FBSyxLQUFLLFlBQVksS0FBSyxLQUFLO0FBQ2hDLFNBQUssZ0JBQWdCLEtBQUssS0FBSztBQUFBLEVBQ2pDO0FBQUEsRUFFUSxhQUFtQjtBQUN6QixRQUFJLENBQUMsS0FBSyxhQUFjO0FBQ3hCLFVBQU0sUUFBUSxLQUFLLFVBQVUsS0FBSztBQUNsQyxVQUFNLE9BQU8sQ0FBQyxTQUFTLEtBQUssVUFBVSxLQUFLLENBQUMsS0FBSyxXQUFXLEtBQUssU0FBUyxJQUFJLEtBQUs7QUFDbkYsU0FBSyxhQUFhLElBQUk7QUFBQSxFQUN4QjtBQUFBO0FBQUEsRUFHQSxVQUFVLFFBQVEsT0FBYTtBQUM3QixRQUFJLE9BQU87QUFDVCxXQUFLLFNBQVM7QUFDZCxXQUFLLFVBQVU7QUFBQSxJQUNqQjtBQUNBLFFBQUksS0FBSyxRQUFRO0FBQ2YsVUFBSSxLQUFLLFdBQVcsS0FBSyxLQUFLLFlBQVksS0FBSyxVQUFVLEdBQUc7QUFDMUQsYUFBSyxLQUFLLFNBQVMsRUFBRSxLQUFLLEtBQUssS0FBSyxjQUFjLFVBQVUsU0FBUyxDQUFDO0FBQUEsTUFDeEUsT0FBTztBQUNMLGFBQUssYUFBYTtBQUFBLE1BQ3BCO0FBQUEsSUFDRjtBQUNBLFNBQUssV0FBVztBQUFBLEVBQ2xCO0FBQUE7QUFBQSxFQUdBLFdBQWlCO0FBQ2YsUUFBSSxDQUFDLEtBQUssVUFBVSxFQUFHO0FBQ3ZCLFFBQUksS0FBSyxRQUFRO0FBQ2YsV0FBSyxVQUFVO0FBQ2YsV0FBSyxhQUFhO0FBQUEsSUFDcEIsT0FBTztBQUNMLFdBQUssZ0JBQWdCLEtBQUssS0FBSztBQUFBLElBQ2pDO0FBQ0EsU0FBSyxXQUFXO0FBQUEsRUFDbEI7QUFBQTtBQUFBLEVBR0EsV0FBaUI7QUFDZixRQUFJLENBQUMsS0FBSyxVQUFVLEVBQUc7QUFDdkIsVUFBTSxNQUFNLEtBQUssS0FBSztBQUN0QixVQUFNLE9BQU8sS0FBSyxTQUFTO0FBQzNCLFVBQU0sVUFBVSxNQUFNLEtBQUs7QUFDM0IsU0FBSyxnQkFBZ0I7QUFFckIsUUFBSSxRQUFRLEtBQUssY0FBYztBQUM3QixXQUFLLFNBQVM7QUFDZCxXQUFLLFVBQVU7QUFBQSxJQUNqQixXQUFXLFNBQVM7QUFDbEIsV0FBSyxTQUFTO0FBQ2QsV0FBSyxVQUFVO0FBQUEsSUFDakI7QUFDQSxTQUFLLFdBQVc7QUFBQSxFQUNsQjtBQUFBO0FBQUEsRUFHQSxjQUFvQjtBQUNsQixRQUFJLENBQUMsS0FBSyxVQUFVLEtBQUssQ0FBQyxLQUFLLFFBQVM7QUFDeEMsU0FBSyxVQUFVO0FBQ2YsUUFBSSxLQUFLLFNBQVMsSUFBSSxLQUFLLGFBQWMsTUFBSyxTQUFTO0FBQ3ZELFNBQUssV0FBVztBQUFBLEVBQ2xCO0FBQUE7QUFBQSxFQUdBLGFBQW1CO0FBQ2pCLFFBQUksQ0FBQyxLQUFLLFFBQVM7QUFDbkIsU0FBSyxVQUFVO0FBQ2YsUUFBSSxLQUFLLFVBQVUsR0FBRztBQUNwQixZQUFNLE1BQU0sS0FBSyxLQUFLO0FBQ3RCLFVBQUksS0FBSyxLQUFLLFNBQVUsTUFBSyxLQUFLLFNBQVMsRUFBRSxLQUFLLFVBQVUsVUFBVSxDQUFDO0FBQUEsVUFDbEUsTUFBSyxLQUFLLFlBQVk7QUFDM0IsV0FBSyxnQkFBZ0IsS0FBSyxLQUFLO0FBQy9CLFVBQUksS0FBSyxTQUFTLElBQUksS0FBSyxhQUFjLE1BQUssU0FBUztBQUFBLElBQ3pEO0FBQ0EsU0FBSyxXQUFXO0FBQUEsRUFDbEI7QUFBQTtBQUFBLEVBR0EsZUFBcUI7QUFDbkIsU0FBSyxTQUFTO0FBQ2QsUUFBSSxDQUFDLEtBQUssVUFBVSxHQUFHO0FBQ3JCLFdBQUssV0FBVztBQUNoQjtBQUFBLElBQ0Y7QUFDQSxRQUFJLEtBQUssU0FBUyxLQUFLLEtBQUssZ0JBQWdCLENBQUMsS0FBSyxLQUFLLFVBQVU7QUFDL0QsV0FBSyxVQUFVO0FBQ2YsV0FBSyxhQUFhO0FBQUEsSUFDcEIsT0FBTztBQUNMLFdBQUssVUFBVTtBQUNmLFdBQUssZ0JBQWdCLEtBQUssS0FBSztBQUMvQixXQUFLLEtBQUssU0FBUyxFQUFFLEtBQUssS0FBSyxLQUFLLGNBQWMsVUFBVSxTQUFTLENBQUM7QUFBQSxJQUN4RTtBQUNBLFNBQUssV0FBVztBQUFBLEVBQ2xCO0FBQUE7QUFBQSxFQUdBLG1CQUF5QjtBQUN2QixRQUFJLENBQUMsS0FBSyxVQUFVLEVBQUc7QUFDdkIsU0FBSyxVQUFVO0FBQ2YsU0FBSyxnQkFBZ0IsS0FBSyxLQUFLO0FBQy9CLFNBQUssU0FBUyxLQUFLLFNBQVMsS0FBSyxLQUFLO0FBQ3RDLFNBQUssV0FBVztBQUFBLEVBQ2xCO0FBQUE7QUFBQSxFQUdBLFFBQWM7QUFDWixTQUFLLFNBQVM7QUFDZCxTQUFLLFVBQVU7QUFDZixTQUFLLFdBQVc7QUFBQSxFQUNsQjtBQUNGOzs7QUNwSk8sU0FBUyxpQkFBaUIsT0FBMkM7QUFDMUUsU0FBTyxVQUFVLGdCQUFnQixnQkFBZ0I7QUFDbkQ7QUFFTyxTQUFTLG9CQUFvQixPQUE4QztBQUNoRixNQUFJLFVBQVUsWUFBWSxVQUFVLFVBQVcsUUFBTztBQUN0RCxTQUFPO0FBQ1Q7QUFFTyxTQUFTLFlBQVksTUFBOEQ7QUFDeEYsUUFBTSxJQUFJLEtBQUssTUFBTSxpQ0FBaUM7QUFDdEQsTUFBSSxDQUFDLEVBQUcsUUFBTyxFQUFFLE1BQU0sTUFBTSxNQUFNLEtBQUs7QUFDeEMsU0FBTyxFQUFFLE1BQU0sZUFBZSxLQUFLLEVBQUUsQ0FBQyxDQUFDLElBQUksT0FBTyxVQUFVLE1BQU0sRUFBRSxDQUFDLEVBQUUsS0FBSyxFQUFFO0FBQ2hGO0FBR08sU0FBUyxrQkFBa0IsZUFBdUJDLGdCQUF1QixTQUEyQjtBQUN6RyxTQUFPQSxpQkFBZ0IsS0FBSyxrQkFBa0JBLGtCQUFpQjtBQUNqRTtBQUdPLFNBQVMseUJBQXlCLFVBQW1CLFlBQXFCLFFBQTZCO0FBQzVHLFNBQU8sQ0FBQyxZQUFhLGNBQWMsV0FBVztBQUNoRDtBQUdPLFNBQVMsMEJBQTBCLFNBQXFCLGFBQXFCLGVBQW1DO0FBQ3JILE1BQUksY0FBYyxFQUFHLFFBQU8sWUFBWSxZQUFZLFFBQVE7QUFDNUQsTUFBSSxnQkFBZ0IsRUFBRyxRQUFPO0FBQzlCLFNBQU87QUFDVDtBQUdPLFNBQVMsYUFBYSxNQUFjLFNBQVMsS0FBYTtBQUMvRCxRQUFNLFVBQVUsS0FDYixRQUFRLDhCQUE4QixDQUFDLEdBQUcsU0FBaUIsSUFBSSxLQUFLLEtBQUssQ0FBQyxHQUFHLEVBQzdFLFFBQVEsMkNBQTJDLElBQUksRUFDdkQsUUFBUSxnQkFBZ0IsRUFBRSxFQUMxQixRQUFRLDhCQUE4QixFQUFFLEVBQ3hDLFFBQVEsZ0JBQWdCLElBQUksRUFDNUIsUUFBUSxzQkFBc0IsSUFBSSxFQUNsQyxRQUFRLGtCQUFrQixJQUFJLEVBQzlCLFFBQVEsUUFBUSxHQUFHLEVBQ25CLEtBQUs7QUFDUixNQUFJLFFBQVEsVUFBVSxPQUFRLFFBQU87QUFDckMsUUFBTSxNQUFNLFFBQVEsTUFBTSxHQUFHLE1BQU07QUFDbkMsUUFBTSxRQUFRLElBQUksWUFBWSxHQUFHO0FBQ2pDLFFBQU0sT0FBTyxRQUFRLEtBQUssTUFBTSxTQUFTLEdBQUcsSUFBSSxJQUFJLE1BQU0sR0FBRyxLQUFLLElBQUk7QUFDdEUsU0FBTyxHQUFHLEtBQUssUUFBUSxlQUFlLEVBQUUsQ0FBQztBQUMzQztBQUVPLFNBQVMsZ0JBQWdCLE1BQW9CO0FBQ2xELFFBQU0sTUFBTSxDQUFDLE1BQWMsT0FBTyxDQUFDLEVBQUUsU0FBUyxHQUFHLEdBQUc7QUFDcEQsU0FBTyxHQUFHLElBQUksS0FBSyxTQUFTLENBQUMsQ0FBQyxJQUFJLElBQUksS0FBSyxXQUFXLENBQUMsQ0FBQztBQUMxRDtBQUdPLFNBQVMsb0JBQW9CLFFBQW9CQyxTQUFvQztBQUMxRixNQUFJLFdBQVcsV0FBVztBQUN4QixXQUFPO0FBQUEsTUFDTCxrQkFBa0I7QUFBQSxNQUNsQixnQkFBZ0I7QUFBQSxNQUNoQixvQkFBb0I7QUFBQSxNQUNwQixrQkFBa0JBLFFBQU8sWUFBWTtBQUFBLE1BQ3JDLG9CQUFvQjtBQUFBLE1BQ3BCLGlCQUFpQjtBQUFBLElBQ25CO0FBQUEsRUFDRjtBQUNBLE1BQUksV0FBVyxVQUFVO0FBQ3ZCLFdBQU87QUFBQSxNQUNMLGtCQUFrQjtBQUFBLE1BQ2xCLGdCQUFnQkEsUUFBTyxXQUFXLEtBQUtBLFFBQU8sWUFBWTtBQUFBLE1BQzFELG9CQUFvQjtBQUFBLE1BQ3BCLGtCQUFrQjtBQUFBLE1BQ2xCLG9CQUFvQkEsUUFBTyxVQUFVO0FBQUEsTUFDckMsaUJBQWlCQSxRQUFPLE9BQU87QUFBQSxJQUNqQztBQUFBLEVBQ0Y7QUFHQSxRQUFNLHVCQUF1QkEsUUFBTyxTQUFTLEtBQUtBLFFBQU8sVUFBVSxLQUFLQSxRQUFPLFVBQVU7QUFDekYsU0FBTztBQUFBLElBQ0wsa0JBQWtCQSxRQUFPLFNBQVMsS0FBSyxDQUFDO0FBQUEsSUFDeEMsZ0JBQWdCLENBQUM7QUFBQSxJQUNqQixvQkFBb0JBLFFBQU8sVUFBVTtBQUFBLElBQ3JDLGtCQUFrQjtBQUFBLElBQ2xCLG9CQUFvQkEsUUFBTyxVQUFVO0FBQUEsSUFDckMsaUJBQWlCQSxRQUFPLE9BQU87QUFBQSxFQUNqQztBQUNGOzs7QUNsRUEsSUFBTSxtQkFBbUIsS0FBSyxNQUFNLE1BQU0sSUFBTTtBQUV6QyxJQUFNLGFBQU4sTUFBaUI7QUFBQSxFQWF0QixZQUNFLFdBQ0EsZUFBaUMsTUFBTSxJQUFJLE9BQU8sbUJBQW1CLEVBQUUsTUFBTSxTQUFTLENBQUMsR0FDdkY7QUFmRixTQUFRLFNBQTRCO0FBR3BDLFNBQVEsZ0JBQStCO0FBQ3ZDLFNBQVEsaUJBQWdDO0FBQ3hDLFNBQVEsbUJBQW1CO0FBQzNCLFNBQVEsTUFBTTtBQUNkLFNBQVEsTUFBTTtBQUNkLFNBQVEsU0FBb0UsQ0FBQztBQUM3RSxTQUFRLGNBQWM7QUFDdEIsaUJBQVE7QUFNTixTQUFLLFlBQVk7QUFDakIsU0FBSyxlQUFlO0FBQUEsRUFDdEI7QUFBQSxFQUVRLGNBQW9CO0FBQzFCLFNBQUssU0FBUyxDQUFDO0FBQ2YsU0FBSyxjQUFjO0FBQUEsRUFDckI7QUFBQSxFQUVRLGVBQTJCO0FBQ2pDLFFBQUksS0FBSyxPQUFRLFFBQU8sS0FBSztBQUM3QixVQUFNLFNBQVMsS0FBSyxhQUFhO0FBQ2pDLFdBQU8sWUFBWSxDQUFDLE1BQXlDO0FBQzNELFlBQU0sSUFBSSxFQUFFO0FBQ1osVUFBSSxPQUFPLEVBQUUsUUFBUSxZQUFZLEVBQUUsUUFBUSxLQUFLLElBQUs7QUFDckQsVUFBSSxFQUFFLFNBQVMsU0FBUztBQUN0QixhQUFLLGlCQUFpQjtBQUN0QixhQUFLLGdCQUFnQixFQUFFO0FBQ3ZCLGFBQUssUUFBUTtBQUNiLGFBQUssVUFBVSxVQUFVLEVBQUUsU0FBUyxFQUFFLFFBQVE7QUFBQSxNQUNoRCxXQUFXLEVBQUUsU0FBUyxZQUFZO0FBQ2hDLGNBQU0sV0FBZ0MsQ0FBQztBQUN2QyxjQUFNLE9BQU8sSUFBSSxXQUFXLEVBQUUsU0FBd0I7QUFDdEQsY0FBTSxTQUFTLE9BQU8sRUFBRSxRQUFRLFdBQVcsRUFBRSxNQUFNLE9BQU87QUFDMUQsY0FBTSxVQUFVLEtBQUssT0FBTyxLQUFLLENBQUMsU0FBUyxLQUFLLFFBQVEsTUFBTTtBQUM5RCxZQUFJLEtBQUssYUFBYSxHQUFHO0FBQ3ZCLG1CQUFTLEtBQUssRUFBRSxPQUFPLE1BQU0sWUFBWSxTQUFTLGNBQWMsTUFBTSxDQUFDO0FBQUEsUUFDekU7QUFDQSxtQkFBVyxRQUFRLEtBQUssUUFBUTtBQUM5QixjQUFJLEtBQUssTUFBTSxPQUFRLFVBQVMsS0FBSyxFQUFFLE9BQU8sS0FBSyxPQUFPLFlBQVksS0FBSyxXQUFXLENBQUM7QUFBQSxRQUN6RjtBQUNBLGFBQUssWUFBWTtBQUNqQixhQUFLLFVBQVUsV0FBVztBQUFBLFVBQ3hCLE9BQU8sRUFBRTtBQUFBLFVBQ1QsU0FBUyxFQUFFO0FBQUEsVUFDWDtBQUFBLFVBQ0EsU0FBUyxFQUFFO0FBQUEsUUFDYixDQUFDO0FBQUEsTUFDSCxXQUFXLEVBQUUsU0FBUyxhQUFhO0FBQ2pDLGFBQUssVUFBVSxjQUFjO0FBQUEsVUFDM0IsT0FBTyxFQUFFO0FBQUEsVUFDVCxNQUFNLEVBQUU7QUFBQSxVQUNSLFVBQVUsRUFBRTtBQUFBLFVBQ1osUUFBUSxFQUFFO0FBQUEsVUFDVixRQUFRLEVBQUU7QUFBQSxVQUNWLFNBQVMsRUFBRTtBQUFBLFFBQ2IsQ0FBQztBQUFBLE1BQ0gsV0FBVyxFQUFFLFNBQVMsU0FBUztBQUM3QixhQUFLLGlCQUFpQjtBQUN0QixhQUFLLFFBQVE7QUFDYixhQUFLLFVBQVUsVUFBVSxPQUFPLEVBQUUsV0FBVyxtQkFBbUIsQ0FBQztBQUFBLE1BQ25FO0FBQUEsSUFDRjtBQUNBLFdBQU8sVUFBVSxDQUFDLFFBQVE7QUFDeEIsV0FBSyxpQkFBaUI7QUFDdEIsV0FBSyxRQUFRO0FBQ2IsV0FBSyxVQUFVLFVBQVUsSUFBSSxXQUFXLG9CQUFvQjtBQUFBLElBQzlEO0FBQ0EsU0FBSyxTQUFTO0FBQ2QsV0FBTztBQUFBLEVBQ1Q7QUFBQTtBQUFBLEVBR0EsS0FBSyxTQUFpQixXQUF5QjtBQUM3QyxTQUFLLG1CQUFtQjtBQUN4QixVQUFNLFNBQVMsS0FBSyxhQUFhO0FBQ2pDLFFBQUksS0FBSyxTQUFTLEtBQUssa0JBQWtCLFNBQVM7QUFDaEQsYUFBTyxZQUFZLEVBQUUsTUFBTSxVQUFVLFVBQVUsQ0FBQztBQUNoRDtBQUFBLElBQ0Y7QUFDQSxRQUFJLEtBQUssbUJBQW1CLFNBQVM7QUFDbkMsYUFBTyxZQUFZLEVBQUUsTUFBTSxVQUFVLFVBQVUsQ0FBQztBQUNoRDtBQUFBLElBQ0Y7QUFDQSxTQUFLO0FBQ0wsU0FBSyxRQUFRO0FBQ2IsU0FBSyxpQkFBaUI7QUFDdEIsU0FBSyxZQUFZO0FBQ2pCLFdBQU8sWUFBWTtBQUFBLE1BQ2pCLE1BQU07QUFBQSxNQUNOLEtBQUssS0FBSztBQUFBLE1BQ1Y7QUFBQSxNQUNBLEtBQUssZ0JBQWdCLG1CQUFtQixPQUFPLENBQUM7QUFBQSxNQUNoRDtBQUFBLE1BQ0EsV0FBVztBQUFBLElBQ2IsQ0FBQztBQUFBLEVBQ0g7QUFBQSxFQUVBLGFBQWEsV0FBeUI7QUFDcEMsU0FBSyxtQkFBbUI7QUFDeEIsU0FBSyxRQUFRLFlBQVksRUFBRSxNQUFNLFVBQVUsVUFBVSxDQUFDO0FBQUEsRUFDeEQ7QUFBQSxFQUVBLEtBQUssU0FBcUIsYUFBYSxPQUFhO0FBQ2xELFFBQUksQ0FBQyxLQUFLLFNBQVMsQ0FBQyxLQUFLLE9BQVE7QUFDakMsVUFBTSxNQUFNLEVBQUUsS0FBSztBQUNuQixVQUFNLFFBQVEsSUFBSSxXQUFXLFFBQVEsVUFBVTtBQUMvQyxVQUFNLElBQUksSUFBSSxXQUFXLFFBQVEsUUFBUSxRQUFRLFlBQVksUUFBUSxVQUFVLENBQUM7QUFDaEYsU0FBSyxPQUFPLEtBQUssRUFBRSxLQUFLLE9BQU8sV0FBVyxDQUFDO0FBQzNDLFNBQUssZUFBZSxNQUFNO0FBQzFCLFdBQU8sS0FBSyxjQUFjLG9CQUFvQixLQUFLLE9BQU8sU0FBUyxHQUFHO0FBQ3BFLFdBQUssZUFBZSxLQUFLLE9BQU8sTUFBTSxFQUFHLE1BQU07QUFBQSxJQUNqRDtBQUNBLFVBQU0sT0FBTyxJQUFJLFdBQVcsUUFBUSxNQUFNO0FBQzFDLFNBQUssSUFBSSxPQUFPO0FBQ2hCLFNBQUssT0FBTyxZQUFZLEVBQUUsTUFBTSxRQUFRLEtBQUssS0FBSyxLQUFLLEtBQUssS0FBSyxLQUFLLE9BQU8sR0FBRyxDQUFDLEtBQUssTUFBTSxDQUFDO0FBQUEsRUFDL0Y7QUFBQSxFQUVBLFFBQWM7QUFDWixTQUFLLFlBQVk7QUFDakIsUUFBSSxDQUFDLEtBQUssVUFBVSxDQUFDLEtBQUssTUFBTztBQUNqQyxTQUFLO0FBQ0wsU0FBSyxPQUFPLFlBQVksRUFBRSxNQUFNLFNBQVMsS0FBSyxLQUFLLElBQUksQ0FBQztBQUFBLEVBQzFEO0FBQUEsRUFFQSxVQUFnQjtBQUNkLFNBQUs7QUFDTCxTQUFLLFFBQVE7QUFDYixTQUFLLGdCQUFnQjtBQUNyQixTQUFLLGlCQUFpQjtBQUN0QixTQUFLLFlBQVk7QUFDakIsUUFBSSxLQUFLLFFBQVE7QUFDZixXQUFLLE9BQU8sWUFBWSxFQUFFLE1BQU0sV0FBVyxLQUFLLEtBQUssSUFBSSxDQUFDO0FBQzFELFdBQUssT0FBTyxVQUFVO0FBQ3RCLFdBQUssU0FBUztBQUFBLElBQ2hCO0FBQUEsRUFDRjtBQUFBLEVBRUEsSUFBSSxVQUF5QjtBQUMzQixXQUFPLEtBQUssaUJBQWlCLEtBQUs7QUFBQSxFQUNwQztBQUFBLEVBRUEsSUFBSSxZQUFvQjtBQUN0QixXQUFPLEtBQUs7QUFBQSxFQUNkO0FBQ0Y7QUFZTyxJQUFNLGlCQUFOLE1BQXFCO0FBQUEsRUFLMUIsWUFDRSxjQUErRCxNQUM1RCxVQUFrQixVQUFVLFFBQVEsUUFBUSxLQUFLLFFBQVEsUUFBUSxNQUFTLEdBQzdFO0FBUEYsU0FBUSxXQUF3QztBQUNoRCxTQUFRLE1BQU07QUFPWixTQUFLLGNBQWM7QUFBQSxFQUNyQjtBQUFBLEVBRUEsSUFBSSxPQUFnQjtBQUNsQixXQUFPLEtBQUssWUFBWSxRQUFRLENBQUMsS0FBSyxTQUFTO0FBQUEsRUFDakQ7QUFBQSxFQUVBLE1BQU0sUUFBUSxhQUEyQztBQUN2RCxRQUFJLEtBQUssUUFBUSxDQUFDLFlBQVksRUFBRztBQUNqQyxVQUFNLE1BQU0sRUFBRSxLQUFLO0FBQ25CLFFBQUk7QUFDRixZQUFNLE9BQU8sTUFBTSxLQUFLLFlBQVk7QUFDcEMsVUFBSSxDQUFDLEtBQU07QUFDWCxVQUFJLFFBQVEsS0FBSyxPQUFPLENBQUMsWUFBWSxHQUFHO0FBQ3RDLGFBQUssS0FBSyxRQUFRLEVBQUUsTUFBTSxNQUFNO0FBQUEsUUFBQyxDQUFDO0FBQ2xDO0FBQUEsTUFDRjtBQUNBLFdBQUssV0FBVztBQUNoQixXQUFLLG1CQUFtQixXQUFXLE1BQU07QUFDdkMsWUFBSSxLQUFLLGFBQWEsS0FBTSxNQUFLLFdBQVc7QUFBQSxNQUM5QyxDQUFDO0FBQUEsSUFDSCxRQUFRO0FBQUEsSUFBQztBQUFBLEVBQ1g7QUFBQSxFQUVBLFVBQWdCO0FBQ2QsU0FBSztBQUNMLFVBQU0sT0FBTyxLQUFLO0FBQ2xCLFNBQUssV0FBVztBQUNoQixTQUFLLE1BQU0sUUFBUSxFQUFFLE1BQU0sTUFBTTtBQUFBLElBQUMsQ0FBQztBQUFBLEVBQ3JDO0FBQ0Y7OztBQ2hOQSxJQUFNLElBQUksQ0FBc0MsT0FBZSxTQUFTLGVBQWUsRUFBRTtBQUN6RixJQUFNLE1BQU0sTUFBTSxZQUFZLElBQUksSUFBSTtBQUN0QyxJQUFNLFVBQVUsQ0FBQyxPQUFlLEVBQW9CLEVBQUUsRUFBRTtBQUd4RCxlQUFzQixTQUFTLE1BQU0sa0JBQWlDO0FBQ3BFLFFBQU0sU0FBUyxPQUFPLE1BQU0sTUFBTSxLQUFLLEVBQUUsT0FBTyxXQUFXLENBQUMsR0FBRyxLQUFLO0FBQ3BFLFFBQU0sUUFBOEIsQ0FBQztBQUNyQyxNQUFJLFNBQVMsY0FBYyxNQUFNLEVBQUUsS0FBSztBQUN4QyxNQUFJLENBQUMsTUFBTSxVQUFXLE9BQU0sSUFBSSxNQUFNLG9DQUFvQztBQUMxRSxTQUFPLE1BQU07QUFDZjtBQUlBLElBQU0sVUFBVTtBQUFBLEVBQ2QsRUFBRSxNQUFNLGFBQWEsYUFBYSwrQ0FBK0MsWUFBWSxFQUFFLE1BQU0sVUFBVSxZQUFZLEVBQUUsT0FBTyxFQUFFLE1BQU0sVUFBVSxFQUFFLEdBQUcsVUFBVSxDQUFDLE9BQU8sRUFBRSxFQUFFO0FBQUEsRUFDakwsRUFBRSxNQUFNLFlBQVksYUFBYSwrQ0FBK0MsWUFBWSxFQUFFLE1BQU0sVUFBVSxZQUFZLEVBQUUsT0FBTyxFQUFFLE1BQU0sVUFBVSxFQUFFLEVBQUUsRUFBRTtBQUM3SjtBQUVBLElBQU0sVUFBbUQ7QUFBQSxFQUN2RCxLQUFLLEVBQUUsVUFBVSxPQUFPLFFBQVEsV0FBVyxjQUFjLElBQUksU0FBUyxTQUFTLFdBQVcsTUFBTSxZQUFZLENBQUMsVUFBVSxTQUFTLGFBQWEsY0FBYyxJQUFJLEVBQUU7QUFBQSxFQUNqSyxpQkFBaUI7QUFBQSxJQUNmLFVBQVU7QUFBQSxJQUFPLFFBQVE7QUFBQSxJQUFXLGNBQWM7QUFBQSxJQUFJLGFBQWE7QUFBQSxJQUFLLFNBQVM7QUFBQSxJQUFTLFdBQVc7QUFBQSxJQUNyRyxXQUFXLEVBQUUsTUFBTSxVQUFVLFdBQVcsR0FBRyxRQUFRLEdBQUcsZUFBZSxJQUFJLGNBQWMsR0FBRyxtQkFBbUIsRUFBRTtBQUFBLElBQy9HLFlBQVksQ0FBQyxVQUFVLFNBQVMsYUFBYSxjQUFjLElBQUk7QUFBQSxFQUNqRTtBQUFBLEVBQ0EsU0FBUyxFQUFFLFVBQVUsV0FBVyxRQUFRLFNBQVMsY0FBYyxHQUFHO0FBQUEsRUFDbEUscUJBQXFCLEVBQUUsVUFBVSxXQUFXLFFBQVEsU0FBUyxjQUFjLElBQUksYUFBYSxHQUFHO0FBQUEsRUFDL0YsT0FBTyxFQUFFLFVBQVUsU0FBUyxRQUFRLE9BQU8sY0FBYyxHQUFHO0FBQUEsRUFDNUQsTUFBTTtBQUFBLElBQ0osVUFBVTtBQUFBLElBQVEsUUFBUTtBQUFBLElBQVcsYUFBYTtBQUFBLElBQUcsY0FBYztBQUFBLElBQUcsU0FBUztBQUFBLElBQU0sWUFBWSxDQUFDLFVBQVUsU0FBUyxXQUFXO0FBQUEsSUFDaEksS0FBSyxFQUFFLGVBQWUsUUFBUSxRQUFRLEVBQUU7QUFBQSxJQUFHLFdBQVc7QUFBQSxFQUN4RDtBQUNGO0FBSUEsSUFBTSxRQUFRLElBQUksVUFBVTtBQUM1QixJQUFJO0FBQ0osSUFBSSxPQUFvQjtBQUN4QixJQUFJLFNBQVM7QUFFYixJQUFJLGFBQWE7QUFDakIsSUFBSSxnQkFBZ0I7QUFDcEIsSUFBSSxXQUFXO0FBQ2YsSUFBSSxTQUFTO0FBQ2IsSUFBSSxhQUFhO0FBQ2pCLElBQUksWUFBWSxJQUFJO0FBQ3BCLElBQU0sVUFBVSxvQkFBSSxJQUF1QjtBQUUzQyxJQUFNLGlCQUFpQixvQkFBSSxJQUFZO0FBQ3ZDLElBQU0sT0FBTyxvQkFBSSxJQUF1RTtBQUV4RixJQUFNLFFBQVEsb0JBQUksSUFBc0I7QUFnQnhDLElBQU0sVUFBVSxvQkFBSSxJQUF5QjtBQUM3QyxJQUFJLGdCQUFnQjtBQUNwQixJQUFJLGFBQXlCO0FBQzdCLElBQUksc0JBQXNCO0FBQzFCLElBQUksYUFBYTtBQUNqQixJQUFJLHFCQUFxQjtBQUN6QixJQUFJLHNCQUFzQjtBQUMxQixJQUFJLFNBQVMsRUFBRSxLQUFLLEdBQUcsTUFBTSxHQUFHLE1BQU0sRUFBRTtBQUN4QyxJQUFJLGNBQWM7QUFDbEIsSUFBSSxhQUFhO0FBQ2pCLElBQUksUUFBUTtBQUNaLElBQUksVUFBVTtBQUNkLElBQU0saUJBQWlCLElBQUksZUFBZTtBQUUxQyxJQUFJLFlBQVk7QUFDaEIsSUFBSSxTQUFTO0FBQ2IsSUFBSSxnQkFBZ0I7QUFDcEIsSUFBSSxvQkFBb0I7QUFFeEIsSUFBSSxrQkFBa0I7QUFDdEIsSUFBSSxjQUFjO0FBQ2xCLElBQUksZUFBZTtBQUNuQixJQUFJLGVBQWU7QUFDbkIsSUFBSSxnQkFBOEIsQ0FBQztBQUNuQyxJQUFJLGVBQWU7QUFDbkIsSUFBTSxvQkFBb0IsS0FBSztBQUMvQixJQUFJLGNBQW9DO0FBRXhDLElBQUksU0FBMkI7QUFFL0IsSUFBSSxXQUFXO0FBRWYsSUFBTSxXQUFXLG9CQUFJLElBQTZCO0FBRWxELElBQUksU0FBd0IsUUFBUSxRQUFRO0FBSTVDLElBQU0sVUFBVTtBQUNoQixJQUFNLGtCQUFrQixLQUFLLE9BQU87QUFDcEMsSUFBSSxPQUFtQixDQUFDO0FBRXhCLElBQUksV0FBMEI7QUFFOUIsU0FBUyxTQUFTLE1BQTRCLE1BQWMsU0FBa0IsT0FBTyxPQUFPO0FBQzFGLFFBQU0sT0FBTyxLQUFLLEdBQUcsRUFBRTtBQUN2QixNQUFJLFFBQVEsUUFBUSxLQUFLLFNBQVMsUUFBUSxLQUFLLFlBQVksUUFBUyxNQUFLLFFBQVE7QUFBQSxNQUM1RSxNQUFLLEtBQUssVUFBVSxFQUFFLE1BQU0sU0FBUyxLQUFLLElBQUksRUFBRSxNQUFNLEtBQUssQ0FBQztBQUNqRSxNQUFJLEtBQUssU0FBUyxJQUFLLE1BQUssT0FBTyxHQUFHLEtBQUssU0FBUyxHQUFHO0FBQ3ZELGVBQWEsUUFBUSxTQUFTLEtBQUssVUFBVSxFQUFFLElBQUksS0FBSyxJQUFJLEdBQUcsS0FBSyxDQUFDLENBQUM7QUFDeEU7QUFFQSxTQUFTLGVBQTJCO0FBQ2xDLE1BQUk7QUFDRixVQUFNLFFBQVEsS0FBSyxNQUFNLGFBQWEsUUFBUSxPQUFPLEtBQUssTUFBTTtBQUNoRSxXQUFPLFNBQVMsS0FBSyxJQUFJLElBQUksTUFBTSxLQUFLLG1CQUFtQixNQUFNLFFBQVEsTUFBTSxJQUFJLElBQUksTUFBTSxPQUFPLENBQUM7QUFBQSxFQUN2RyxRQUFRO0FBQ04sV0FBTyxDQUFDO0FBQUEsRUFDVjtBQUNGO0FBR0EsU0FBUyxZQUFZLElBQVksSUFBWSxTQUFpQixLQUFxQjtBQUNqRixRQUFNLE9BQU8sTUFBTyxJQUFJLEtBQUssTUFBTSxPQUFPLFVBQVUsQ0FBQyxHQUFHLE9BQU8sS0FBSyxNQUFNLE9BQU8sT0FBTyxHQUFHLE1BQU0sSUFBSSxXQUFXLENBQUM7QUFDakgsV0FBUyxJQUFJLEdBQUcsSUFBSSxHQUFHLEtBQUs7QUFDMUIsVUFBTSxRQUFRLElBQUk7QUFDbEIsVUFBTSxJQUFJLElBQUksTUFBTSxJQUFJLFFBQVEsS0FBSyxJQUFJLFFBQVEsUUFBUSxJQUFJLElBQUk7QUFDakUsVUFBTSxNQUFNLEtBQUssSUFBSSxHQUFHLFFBQVEsS0FBSyxVQUFVLFNBQVMsRUFBRTtBQUMxRCxRQUFJLENBQUMsSUFBSSxLQUFLLE1BQU0sS0FBSyxJQUFJLElBQUksS0FBSyxLQUFLLElBQUksQ0FBQyxJQUFJLEtBQUssSUFBSSxHQUFHLEdBQUcsSUFBSSxHQUFHO0FBQUEsRUFDNUU7QUFDQSxTQUFPLGNBQWMsSUFBSSxXQUFXLElBQUksTUFBTSxDQUFDO0FBQ2pEO0FBR0EsSUFBTSxnQkFBZ0IsWUFBWSxLQUFLLEtBQUssTUFBTSxHQUFJO0FBRXRELElBQU0sWUFBWSxZQUFZLFFBQVEsS0FBSyxNQUFNLElBQUk7QUFFckQsSUFBTSxhQUFhLFlBQVksUUFBUSxRQUFRLE1BQU0sSUFBSTtBQUd6RCxJQUFNLFVBQVUsRUFBRSxLQUFLLENBQUMsR0FBZSxPQUFPLENBQUMsR0FBZSxXQUFXLEdBQUcsVUFBVSxHQUFHLFNBQVMsS0FBSztBQUV2RyxTQUFTLE9BQU8sSUFBNkI7QUFDM0MsTUFBSSxHQUFHLFdBQVcsRUFBRyxRQUFPO0FBQzVCLFFBQU0sSUFBSSxDQUFDLEdBQUcsRUFBRSxFQUFFLEtBQUssQ0FBQyxHQUFHLE1BQU0sSUFBSSxDQUFDO0FBQ3RDLFNBQU8sRUFBRSxLQUFLLE1BQU0sRUFBRSxTQUFTLENBQUMsQ0FBQztBQUNuQztBQUVBLFNBQVMsY0FBYztBQUNyQixRQUFNLFFBQWtCLENBQUM7QUFDekIsUUFBTSxNQUFNLE9BQU8sUUFBUSxHQUFHO0FBQzlCLE1BQUksT0FBTyxLQUFNLE9BQU0sS0FBSyxHQUFHLEtBQUssTUFBTSxNQUFNLEdBQUksQ0FBQyxLQUFLO0FBQzFELFFBQU0sUUFBUSxPQUFPLFFBQVEsS0FBSztBQUNsQyxNQUFJLFNBQVMsS0FBTSxPQUFNLEtBQUssU0FBUyxRQUFRLE1BQU0sR0FBRyxFQUFFLEVBQUcsUUFBUSxDQUFDLENBQUMsTUFBTSxNQUFNLFFBQVEsQ0FBQyxDQUFDLFFBQVE7QUFDckcsUUFBTSxNQUFNLE1BQU07QUFDbEIsTUFBSSxPQUFPLEtBQU0sT0FBTSxLQUFLLFNBQVMsS0FBSyxNQUFNLE1BQU0sR0FBSSxDQUFDLEtBQUs7QUFDaEUsTUFBSSxXQUFXO0FBQ2YsYUFBVyxNQUFNLFFBQVEsT0FBTyxFQUFHLGFBQVksR0FBRztBQUNsRCxNQUFJLFdBQVcsS0FBUSxPQUFNLEtBQUssWUFBWSxXQUFXLE1BQVEsUUFBUSxDQUFDLENBQUMsR0FBRztBQUM5RSxJQUFFLFNBQVMsRUFBRSxjQUFjLE1BQU0sS0FBSyxRQUFLO0FBQzdDO0FBRUEsZUFBZSxPQUFPO0FBQ3BCLFFBQU0sSUFBSSxJQUFJO0FBQ2QsTUFBSTtBQUNGLFVBQU0sTUFBTSxTQUFTLEVBQUUsT0FBTyxXQUFXLENBQUM7QUFDMUMsWUFBUSxJQUFJLEtBQUssSUFBSSxJQUFJLENBQUM7QUFDMUIsUUFBSSxRQUFRLElBQUksU0FBUyxHQUFJLFNBQVEsSUFBSSxNQUFNO0FBQUEsRUFDakQsUUFBUTtBQUFBLEVBQUM7QUFDVCxjQUFZO0FBQ2Q7QUFJQSxTQUFTLFdBQVcsUUFBZ0I7QUFDbEMsUUFBTSxPQUFPLFNBQVM7QUFDdEIsTUFBSSxXQUFXLFVBQVUsV0FBVyxRQUFTLE1BQUssUUFBUSxRQUFRO0FBQUEsTUFDN0QsUUFBTyxLQUFLLFFBQVE7QUFDekIsUUFBTSxPQUFPLFdBQVcsVUFBVyxXQUFXLFdBQVcsV0FBVyw4QkFBOEIsRUFBRTtBQUNwRyxRQUFNLE9BQU8sU0FBUyxlQUFlLGFBQWE7QUFDbEQsTUFBSSxLQUFNLE1BQUssYUFBYSxXQUFXLE9BQU8sWUFBWSxTQUFTO0FBQ25FLGFBQVcsT0FBTyxNQUFNLEtBQUssU0FBUyxpQkFBb0Msc0JBQXNCLENBQUMsR0FBRztBQUNsRyxRQUFJLFVBQVUsT0FBTyxNQUFNLElBQUksUUFBUSxXQUFXLFVBQVUsU0FBUztBQUFBLEVBQ3ZFO0FBQ0Y7QUFFQSxTQUFTLGFBQWEsUUFBdUI7QUFDM0MsUUFBTSxVQUFVLGlCQUFpQixNQUFNO0FBQ3ZDLFFBQU0sT0FBTyxTQUFTO0FBQ3RCLE1BQUksWUFBWSxjQUFlLE1BQUssUUFBUSxVQUFVO0FBQUEsTUFDakQsUUFBTyxLQUFLLFFBQVE7QUFDekIsYUFBVyxPQUFPLE1BQU0sS0FBSyxTQUFTLGlCQUFvQyx3QkFBd0IsQ0FBQyxHQUFHO0FBQ3BHLFFBQUksVUFBVSxPQUFPLE1BQU0sSUFBSSxRQUFRLFlBQVksT0FBTztBQUFBLEVBQzVEO0FBQ0Esd0JBQXNCLE1BQU0sd0JBQXdCLENBQUM7QUFDdkQ7QUFJQSxTQUFTLGNBQWNDLE9BQWU7QUFDcEMsUUFBTSxNQUFNLEVBQXFCLE1BQU07QUFDdkMsTUFBSSxVQUFVLE9BQU8sUUFBUUEsS0FBSTtBQUNqQyxRQUFNLFFBQVEsSUFBSSxjQUFjLGFBQWE7QUFDN0MsTUFBSSxNQUFPLE9BQU0sY0FBY0EsUUFBTyxZQUFZO0FBQ3BEO0FBRUEsU0FBUyxrQkFBa0IsTUFBZTtBQUN4QyxJQUFFLFFBQVEsRUFBRSxTQUFTLENBQUM7QUFDdEIsSUFBRSxhQUFhLEVBQUUsU0FBUyxDQUFDO0FBQzdCO0FBRUEsU0FBUyxlQUFlO0FBQ3RCLFFBQU0sUUFBUSxFQUFvQixNQUFNO0FBQ3hDLFFBQU0sVUFBVSxNQUFNLE1BQU0sS0FBSztBQUNqQyxJQUFFLFNBQVMsRUFBRSxVQUFVLE9BQU8sU0FBUyxRQUFRLFNBQVMsQ0FBQztBQUN6RCxRQUFNLFNBQVMsWUFBWSxPQUFPO0FBQ2xDLElBQUUsV0FBVyxFQUFFLFFBQVEsT0FBTyxPQUFPLFFBQVEsRUFBcUIsTUFBTSxFQUFFO0FBQzVFO0FBRUEsU0FBUyxZQUFZLFNBQXlCO0FBQzVDLFFBQU0sUUFBUSxLQUFLLElBQUksR0FBRyxLQUFLLE1BQU0sT0FBTyxDQUFDO0FBQzdDLFFBQU0sSUFBSSxLQUFLLE1BQU0sUUFBUSxJQUFJO0FBQ2pDLFFBQU0sSUFBSSxLQUFLLE1BQU8sUUFBUSxPQUFRLEVBQUU7QUFDeEMsUUFBTSxJQUFJLFFBQVE7QUFDbEIsUUFBTSxNQUFNLENBQUMsTUFBYyxPQUFPLENBQUMsRUFBRSxTQUFTLEdBQUcsR0FBRztBQUNwRCxTQUFPLElBQUksSUFBSSxHQUFHLENBQUMsSUFBSSxJQUFJLENBQUMsQ0FBQyxJQUFJLElBQUksQ0FBQyxDQUFDLEtBQUssR0FBRyxJQUFJLENBQUMsQ0FBQyxJQUFJLElBQUksQ0FBQyxDQUFDO0FBQ2pFO0FBRUEsSUFBTSxjQUFjLENBQUMsTUFBTSxNQUFNLEdBQUssTUFBTSxJQUFJO0FBQ2hELFNBQVMsaUJBQWlCLE1BQWMsT0FBZTtBQUNyRCxRQUFNLE1BQU0sRUFBRSxLQUFLO0FBQ25CLE1BQUksUUFBUSxPQUFPO0FBQ25CLFFBQU0sT0FBTyxJQUFJO0FBQ2pCLE1BQUksU0FBUyxlQUFlLFNBQVMsV0FBVztBQUM5QyxVQUFNLFNBQVMsS0FBSyxJQUFJLEdBQUcsUUFBUSxFQUFFO0FBQ3JDLGFBQVMsSUFBSSxHQUFHLElBQUksS0FBSyxRQUFRLEtBQUs7QUFDcEMsWUFBTSxJQUFJLE9BQU8sU0FBUyxZQUFZLENBQUMsSUFBSTtBQUMzQyxNQUFDLEtBQUssQ0FBQyxFQUFrQixNQUFNLFlBQVksVUFBVSxFQUFFLFFBQVEsQ0FBQyxDQUFDO0FBQUEsSUFDbkU7QUFBQSxFQUNGLE9BQU87QUFDTCxhQUFTLElBQUksR0FBRyxJQUFJLEtBQUssUUFBUSxJQUFLLENBQUMsS0FBSyxDQUFDLEVBQWtCLE1BQU0sWUFBWTtBQUFBLEVBQ25GO0FBQ0Y7QUFHQSxTQUFTLE9BQU8sT0FBZSxNQUFjO0FBQzNDLE1BQUksQ0FBQyxTQUFTLFVBQVUsRUFBRSxrQkFBa0IsV0FBVyxhQUFhLGVBQWUsVUFBVztBQUM5RixNQUFJO0FBQ0YsVUFBTSxJQUFJLElBQUksYUFBYSxPQUFPLEVBQUUsTUFBTSxLQUFLLE1BQU0sR0FBRyxHQUFHLEdBQUcsTUFBTSwyQkFBMkIsS0FBSyxNQUFNLENBQUM7QUFDM0csTUFBRSxVQUFVLE1BQU07QUFBRSxhQUFPLE1BQU07QUFBRyxRQUFFLE1BQU07QUFBQSxJQUFHO0FBQUEsRUFDakQsUUFBUTtBQUFBLEVBRVI7QUFDRjtBQUVBLFNBQVMsTUFBTSxNQUFjO0FBQzNCLFFBQU0sSUFBSSxFQUFFLE9BQU87QUFDbkIsSUFBRSxjQUFjO0FBQ2hCLElBQUUsVUFBVSxJQUFJLElBQUk7QUFDcEIsZUFBYyxNQUFjLEtBQUs7QUFDakMsRUFBQyxNQUFjLFFBQVEsV0FBVyxNQUFNLEVBQUUsVUFBVSxPQUFPLElBQUksR0FBRyxJQUFJO0FBQ3hFO0FBRUEsU0FBUyxJQUFJLE1BQWMsTUFBYyxNQUFNLElBQUk7QUFDakQsUUFBTSxPQUFPLEVBQUUsS0FBSztBQUNwQixRQUFNLE1BQU0sU0FBUyxjQUFjLEtBQUs7QUFDeEMsTUFBSSxZQUFZLE9BQU8sR0FBRztBQUMxQixNQUFJLFlBQVksb0JBQW9CLElBQUksSUFBSSxXQUFXLFFBQVEsQ0FBQyxDQUFDLDBCQUEwQixJQUFJO0FBQy9GLFFBQU0sT0FBTyxTQUFTLGNBQWMsTUFBTTtBQUMxQyxPQUFLLFlBQVk7QUFDakIsT0FBSyxjQUFjO0FBQ25CLE1BQUksT0FBTyxJQUFJO0FBQ2YsUUFBTSxRQUFRLEtBQUssWUFBWSxLQUFLLGdCQUFnQixLQUFLLGVBQWU7QUFDeEUsT0FBSyxPQUFPLEdBQUc7QUFDZixTQUFPLEtBQUssb0JBQW9CLElBQU0sTUFBSyxrQkFBbUIsT0FBTztBQUNyRSxNQUFJLE1BQU8sTUFBSyxZQUFZLEtBQUs7QUFDbkM7QUFHQSxTQUFTLE1BQU0sTUFBc0I7QUFDbkMsU0FBTyxLQUFLLFFBQVEsaUNBQWlDLENBQUMsTUFBTSxpQkFBWSxLQUFLLE9BQVEsRUFBRSxTQUFTLEtBQUssSUFBSyxDQUFDLENBQUMsU0FBUyxFQUFFLE1BQU0sR0FBRyxHQUFHO0FBQ3JJO0FBRUEsU0FBUyxXQUFXLE1BQXNCO0FBQ3hDLFNBQU8sS0FBSyxRQUFRLFlBQVksQ0FBQyxPQUFPLEVBQUUsS0FBSyxTQUFTLEtBQUssUUFBUSxLQUFLLFFBQVEsS0FBSyxVQUFVLEtBQUssUUFBUSxHQUFHLENBQUMsQ0FBRTtBQUN0SDtBQUdBLFNBQVMsU0FBUyxNQUFzQjtBQUN0QyxRQUFNLFNBQVMsV0FBVyxLQUFLLEtBQUssQ0FBQyxFQUFFLE1BQU0sZ0JBQWdCO0FBQzdELFNBQU8sT0FBTyxJQUFJLENBQUMsT0FBTyxNQUFNO0FBQzlCLFFBQUksSUFBSSxNQUFNLEVBQUcsUUFBTyxjQUFjLE1BQU0sUUFBUSxPQUFPLEVBQUUsQ0FBQztBQUM5RCxVQUFNLFNBQVMsQ0FBQyxNQUFjLEVBQzNCLFFBQVEsZ0JBQWdCLGlCQUFpQixFQUN6QyxRQUFRLHNCQUFzQixXQUFXLEVBQ3pDLFFBQVEsMkNBQTJDLG9EQUFvRCxFQUN2RyxRQUFRLG1DQUFtQyxzREFBc0Q7QUFDcEcsUUFBSSxPQUFPO0FBQ1gsUUFBSSxPQUFzQjtBQUMxQixlQUFXLE9BQU8sTUFBTSxNQUFNLElBQUksR0FBRztBQUNuQyxZQUFNLE9BQU8sSUFBSSxNQUFNLGlDQUFpQztBQUN4RCxVQUFJLE1BQU07QUFDUixjQUFNLE9BQU8sS0FBSyxDQUFDLElBQUksT0FBTztBQUM5QixZQUFJLFNBQVMsTUFBTTtBQUFFLGNBQUksS0FBTSxTQUFRLEtBQUssSUFBSTtBQUFLLGtCQUFRLElBQUksSUFBSTtBQUFLLGlCQUFPO0FBQUEsUUFBTTtBQUN2RixnQkFBUSxPQUFPLE9BQU8sS0FBSyxDQUFDLENBQUMsQ0FBQztBQUM5QjtBQUFBLE1BQ0Y7QUFDQSxVQUFJLE1BQU07QUFBRSxnQkFBUSxLQUFLLElBQUk7QUFBSyxlQUFPO0FBQUEsTUFBTTtBQUMvQyxZQUFNLFVBQVUsSUFBSSxNQUFNLGlCQUFpQjtBQUMzQyxjQUFRLFVBQVUscUJBQXFCLE9BQU8sUUFBUSxDQUFDLENBQUMsQ0FBQyxXQUFXLElBQUksS0FBSyxNQUFNLEtBQUssU0FBUyxHQUFHLE9BQU8sR0FBRyxDQUFDO0FBQUEsSUFDakg7QUFDQSxRQUFJLEtBQU0sU0FBUSxLQUFLLElBQUk7QUFDM0IsV0FBTyxLQUFLLFFBQVEsWUFBWSxFQUFFO0FBQUEsRUFDcEMsQ0FBQyxFQUFFLEtBQUssRUFBRTtBQUNaO0FBRUEsSUFBTSxtQkFBbUIsSUFBSSxhQUFhLEVBQUUsWUFBWSxHQUFHO0FBQUEsRUFDekQsY0FBYyxDQUFDLFNBQVM7QUFBRSxNQUFFLFlBQVksRUFBRSxTQUFTLENBQUM7QUFBQSxFQUFNO0FBQUEsRUFDMUQsU0FBUyxNQUFNLENBQUMsRUFBRSxPQUFPLEVBQUU7QUFDN0IsQ0FBQztBQUVELFNBQVMsV0FBVyxRQUFRLE9BQU87QUFDakMsbUJBQWlCLFVBQVUsS0FBSztBQUNsQztBQUdBLElBQUksV0FBMEI7QUFHOUIsU0FBUyxXQUFXLE1BQTRCLE1BQWNDLE9BQWM7QUFDMUUsSUFBRSxPQUFPLEVBQUUsU0FBUztBQUNwQixRQUFNLE9BQU8sRUFBRSxZQUFZO0FBQzNCLFFBQU0sT0FBTyxLQUFLO0FBQ2xCLE1BQUksYUFBYUEsU0FBUSxRQUFRLEtBQUssUUFBUSxTQUFTLEtBQU0sTUFBSyxjQUFjLE9BQU8sRUFBRyxlQUFlO0FBQUEsT0FDcEc7QUFDSCxVQUFNLE1BQU0sU0FBUyxjQUFjLEtBQUs7QUFDeEMsUUFBSSxZQUFZLFFBQVEsSUFBSTtBQUM1QixRQUFJLFFBQVEsT0FBTztBQUNuQixRQUFJLFlBQVkscUJBQXFCLFNBQVMsU0FBUyxRQUFRLFFBQVE7QUFDdkUsUUFBSSxjQUFjLE9BQU8sRUFBRyxjQUFjLEtBQUssVUFBVTtBQUN6RCxTQUFLLE9BQU8sR0FBRztBQUNmLGVBQVdBO0FBQUEsRUFDYjtBQUNBLGFBQVc7QUFDYjtBQU1BLFNBQVMsUUFBUSxNQUFxQjtBQUNwQyxRQUFNLE9BQU8sRUFBRSxZQUFZO0FBQzNCLE1BQUksTUFBTSxTQUFTLGVBQWUsU0FBUztBQUMzQyxNQUFJLFFBQVEsTUFBTTtBQUFFLFNBQUssT0FBTztBQUFHLGVBQVc7QUFBRztBQUFBLEVBQVE7QUFDekQsSUFBRSxPQUFPLEVBQUUsU0FBUztBQUNwQixNQUFJLENBQUMsS0FBSztBQUNSLFVBQU0sU0FBUyxjQUFjLEtBQUs7QUFDbEMsUUFBSSxLQUFLO0FBQ1QsUUFBSSxZQUFZO0FBQ2hCLFFBQUksWUFBWTtBQUNoQixTQUFLLFFBQVEsR0FBRztBQUFBLEVBQ2xCO0FBQ0EsTUFBSSxjQUFjLE9BQU8sRUFBRyxjQUFjO0FBQzFDLGFBQVc7QUFDYjtBQUVBLFNBQVMsS0FBSyxNQUFjO0FBQzFCLElBQUUsT0FBTyxFQUFFLFNBQVM7QUFDcEIsUUFBTSxNQUFNLFNBQVMsY0FBYyxLQUFLO0FBQ3hDLE1BQUksWUFBWTtBQUNoQixNQUFJLGNBQWM7QUFDbEIsSUFBRSxZQUFZLEVBQUUsT0FBTyxHQUFHO0FBQzFCLGFBQVc7QUFDWCxhQUFXO0FBQ2I7QUFJQSxTQUFTLGNBQWMsSUFBeUI7QUFDOUMsUUFBTSxNQUFNLGlCQUFpQixFQUFFLEVBQUUsaUJBQWlCLGlCQUFpQixFQUFFLEtBQUs7QUFDMUUsUUFBTSxJQUFJLE9BQU8sV0FBVyxHQUFHO0FBQy9CLFNBQU8sT0FBTyxTQUFTLENBQUMsS0FBSyxJQUFJLElBQUksSUFBSTtBQUMzQztBQUVBLFNBQVMsc0JBQXNCO0FBQzdCLFFBQU0sVUFBVSxDQUFDLEdBQUcsUUFBUSxPQUFPLENBQUMsRUFBRSxPQUFPLENBQUMsTUFBTSxFQUFFLEtBQUssVUFBVSxTQUFTLFNBQVMsQ0FBQztBQUN4RixRQUFNLE1BQU0sRUFBcUIsb0JBQW9CO0FBQ3JELE1BQUksU0FBUyxRQUFRLFdBQVc7QUFDaEMsTUFBSSxRQUFRLFdBQVcsRUFBRztBQUMxQixRQUFNLGVBQWUsUUFBUSxLQUFLLENBQUMsTUFBTSxDQUFDLEVBQUUsS0FBSyxVQUFVLFNBQVMsTUFBTSxDQUFDO0FBQzNFLE1BQUksY0FBYyxlQUFlLGVBQWU7QUFDbEQ7QUFFQSxTQUFTLGNBQWMsT0FBb0IsTUFBZTtBQUN4RCxRQUFNLFVBQVUsTUFBTSxLQUFLLFVBQVUsU0FBUyxTQUFTO0FBQ3ZELFFBQU0sT0FBTyxXQUFXO0FBQ3hCLFFBQU0sS0FBSyxVQUFVLE9BQU8sUUFBUSxJQUFJO0FBQ3hDLFFBQU0sS0FBSyxhQUFhLGlCQUFpQixPQUFPLENBQUMsV0FBVyxJQUFJLENBQUM7QUFDakUsUUFBTSxRQUFRLGNBQWMsT0FBTyxjQUFjO0FBQ2pELHNCQUFvQjtBQUN0QjtBQUVBLFNBQVMscUJBQXFCLE9BQW9CO0FBQ2hELE1BQUksTUFBTSxLQUFLLGlCQUFpQixLQUFNO0FBRXRDLFFBQU0sWUFBWSxNQUFNLEtBQUssZUFBZSxjQUFjLE1BQU0sSUFBSSxJQUFJO0FBQ3hFLFFBQU0sS0FBSyxVQUFVLE9BQU8sV0FBVyxTQUFTO0FBQ2hELE1BQUksQ0FBQyxVQUFXLE9BQU0sS0FBSyxVQUFVLE9BQU8sTUFBTTtBQUNsRCxRQUFNLFFBQVEsU0FBUyxDQUFDO0FBQ3hCLFFBQU0sU0FBUyxNQUFNLEtBQUssVUFBVSxTQUFTLE1BQU07QUFDbkQsUUFBTSxRQUFRLGNBQWMsU0FBUyxjQUFjO0FBQ25ELFFBQU0sS0FBSyxhQUFhLGlCQUFpQixPQUFPLENBQUMsYUFBYSxNQUFNLENBQUM7QUFDdkU7QUFFQSxTQUFTLDBCQUEwQjtBQUNqQyxhQUFXLFNBQVMsUUFBUSxPQUFPLEVBQUcsc0JBQXFCLEtBQUs7QUFDaEUsc0JBQW9CO0FBQ3RCO0FBRUEsU0FBUyw0QkFBNEI7QUFDbkMsYUFBVyxTQUFTLFFBQVEsT0FBTyxHQUFHO0FBQ3BDLFFBQUksQ0FBQyxNQUFNLFVBQVc7QUFDdEIsVUFBTSxZQUFZLGtCQUFrQixNQUFNLFdBQVcsZUFBZSxRQUFRLE1BQU0sVUFBVSxNQUFNLElBQUksTUFBTSxNQUFNLENBQUMsQ0FBQztBQUNwSCxVQUFNLFVBQVUsU0FBUyxDQUFDO0FBQzFCLFFBQUksQ0FBQyxVQUFXLE9BQU0sS0FBSyxjQUFjLE1BQU0sR0FBRyxPQUFPO0FBQUEsRUFDM0Q7QUFDRjtBQUVBLFNBQVMsOEJBQThCO0FBQ3JDLE1BQUksd0JBQXdCLEVBQUc7QUFDL0IsUUFBTSxhQUFhLFNBQVMsS0FBSyxVQUFVLFNBQVMsWUFBWTtBQUNoRSxNQUFJLHlCQUF5QixhQUFhLFNBQVMsWUFBWSxVQUFVLEdBQUc7QUFDMUUsMEJBQXNCO0FBQ3RCLHFCQUFpQjtBQUFBLEVBQ25CO0FBQ0Y7QUFFQSxTQUFTLFlBQVksSUFBWTtBQUMvQixRQUFNLFFBQVEsUUFBUSxJQUFJLEVBQUU7QUFDNUIsTUFBSSxDQUFDLE1BQU87QUFDWixNQUFJLGVBQWUsU0FBVSxlQUFjLEtBQUs7QUFDaEQsTUFBSSxhQUFhLFFBQVMsY0FBYSxJQUFJO0FBQzNDLHdCQUFzQixNQUFNO0FBQzFCLHlCQUFxQixLQUFLO0FBQzFCLFFBQUksTUFBTSxLQUFLLFVBQVUsU0FBUyxTQUFTLEVBQUcsZUFBYyxPQUFPLElBQUk7QUFDdkUsZUFBVyxLQUFLLFFBQVEsT0FBTyxFQUFHLEdBQUUsS0FBSyxVQUFVLE9BQU8sT0FBTztBQUNqRSxTQUFLLE1BQU0sS0FBSztBQUNoQixVQUFNLEtBQUssVUFBVSxJQUFJLE9BQU87QUFDaEMsaUJBQWEsVUFBVTtBQUN2QixpQkFBYSxPQUFPLFdBQVcsTUFBTSxNQUFNLEtBQUssVUFBVSxPQUFPLE9BQU8sR0FBRyxJQUFJO0FBQy9FLFVBQU0sS0FBSyxlQUFlLEVBQUUsVUFBVSxVQUFVLE9BQU8sVUFBVSxDQUFDO0FBQUEsRUFDcEUsQ0FBQztBQUNIO0FBRUEsU0FBUyxPQUFPLE9BQWUsT0FBZSxNQUFjLFNBQVMsT0FBTyxRQUFpQixZQUFZLGVBQXVCO0FBQzlILElBQUUsT0FBTyxFQUFFLFNBQVM7QUFDcEIsUUFBTSxLQUFLLE9BQU8sRUFBRSxhQUFhO0FBQ2pDLFFBQU0sTUFBTSxVQUFVLE9BQU8sT0FBTztBQUNwQyxRQUFNLFdBQVcsVUFBVSxPQUFPLE9BQU87QUFDekMsUUFBTSxVQUFVLGFBQWEsTUFBTSxHQUFHLEtBQUs7QUFJM0MsUUFBTSxTQUFTLFNBQVMsY0FBYyxRQUFRO0FBQzlDLFNBQU8sT0FBTztBQUNkLFNBQU8sWUFBWSxnQkFBZ0IsUUFBUSxJQUFJLFNBQVMsV0FBVyxFQUFFLEdBQUcsS0FBSztBQUM3RSxTQUFPLFFBQVEsV0FBVztBQUMxQixTQUFPLFlBQ0wsc0JBQXNCLFFBQVEsS0FBSyxHQUFHLHNDQUNQLFdBQVcsS0FBSyxDQUFDLHdDQUNmLFdBQVcsT0FBTyxDQUFDLG9DQUN2QixTQUFTLFdBQVcsYUFBUTtBQUMzRCxTQUFPLFVBQVUsTUFBTSxZQUFZLEVBQUU7QUFDckMsSUFBRSxZQUFZLEVBQUUsT0FBTyxNQUFNO0FBQzdCLGFBQVc7QUFDWCxhQUFXO0FBR1gsUUFBTSxPQUFPLFNBQVMsY0FBYyxTQUFTO0FBQzdDLE9BQUssWUFBWSxZQUFZLFFBQVEsSUFBSSxTQUFTLFdBQVcsRUFBRSxHQUFHLEtBQUs7QUFDdkUsT0FBSyxRQUFRLFdBQVc7QUFFeEIsUUFBTSxPQUFPLFNBQVMsY0FBYyxRQUFRO0FBQzVDLE9BQUssT0FBTztBQUNaLE9BQUssWUFBWTtBQUNqQixPQUFLLGFBQWEsaUJBQWlCLE1BQU07QUFDekMsT0FBSyxZQUNILHNCQUFzQixRQUFRLEtBQUssR0FBRyx5Q0FDSixXQUFXLEtBQUssQ0FBQyxLQUFLLFdBQVcsS0FBSyxDQUFDLGFBQ3hFLFNBQVMseUNBQXlDLE1BQ25ELDBCQUEwQixnQkFBZ0Isb0JBQUksS0FBSyxDQUFDLENBQUM7QUFHdkQsUUFBTSxPQUFPLFNBQVMsY0FBYyxLQUFLO0FBQ3pDLE9BQUssWUFBWTtBQUNqQixPQUFLLFlBQVksU0FBUyxJQUFJO0FBRTlCLFFBQU0sT0FBTyxTQUFTLGNBQWMsS0FBSztBQUN6QyxPQUFLLFlBQVk7QUFFakIsUUFBTSxVQUFVLFNBQVMsY0FBYyxRQUFRO0FBQy9DLFVBQVEsT0FBTztBQUNmLFVBQVEsWUFBWTtBQUNwQixVQUFRLGNBQWM7QUFDdEIsVUFBUSxTQUFTO0FBRWpCLFFBQU0sVUFBVSxTQUFTLGNBQWMsUUFBUTtBQUMvQyxVQUFRLE9BQU87QUFDZixVQUFRLFlBQVk7QUFDcEIsVUFBUSxjQUFjO0FBQ3RCLFVBQVEsVUFBVSxNQUFNO0FBQ3RCLFNBQUssVUFBVSxXQUFXLFVBQVUsSUFBSTtBQUN4QyxVQUFNLGVBQWU7QUFBQSxFQUN2QjtBQUVBLE9BQUssT0FBTyxTQUFTLE9BQU87QUFFNUIsTUFBSTtBQUNKLE1BQUksUUFBUTtBQUNWLGdCQUFZLFNBQVMsY0FBYyxRQUFRO0FBQzNDLGNBQVUsT0FBTztBQUNqQixjQUFVLFlBQVk7QUFDdEIsY0FBVSxjQUFjO0FBQ3hCLGNBQVUsVUFBVSxNQUFNO0FBQ3hCLFVBQUksQ0FBQyxrQkFBa0IsV0FBVyxlQUFlLE1BQU0sSUFBSSxNQUFNLENBQUMsR0FBRztBQUNuRSxrQ0FBMEI7QUFDMUI7QUFBQSxNQUNGO0FBQ0EsWUFBTSxPQUFPLE1BQU0sSUFBSSxNQUFNO0FBQzdCLFVBQUksS0FBTSxjQUFhLE1BQU0sS0FBSyxHQUFHLFNBQVM7QUFBQSxJQUNoRDtBQUNBLFNBQUssT0FBTyxTQUFTO0FBQUEsRUFDdkI7QUFFQSxPQUFLLE9BQU8sTUFBTSxNQUFNLElBQUk7QUFFNUIsUUFBTSxRQUFxQixFQUFFLElBQUksT0FBTyxPQUFPLE1BQU0sUUFBUSxRQUFRLFdBQVcsTUFBTSxNQUFNLE1BQU0sU0FBUyxXQUFXLE9BQU87QUFDN0gsUUFBTSxTQUFTLE1BQU07QUFDbkIsUUFBSSxDQUFDLE1BQU0sS0FBSyxVQUFVLFNBQVMsU0FBUyxFQUFHO0FBQy9DLGtCQUFjLE9BQU8sQ0FBQyxNQUFNLEtBQUssVUFBVSxTQUFTLE1BQU0sQ0FBQztBQUFBLEVBQzdEO0FBQ0EsT0FBSyxVQUFVO0FBQ2YsVUFBUSxVQUFVO0FBRWxCLFVBQVEsSUFBSSxJQUFJLEtBQUs7QUFDckIsSUFBRSxTQUFTLEVBQUUsUUFBUSxJQUFJO0FBQ3pCLFFBQU0sYUFBYSxTQUFTLEtBQUssVUFBVSxTQUFTLFlBQVk7QUFDaEUsTUFBSSxDQUFDLHlCQUF5QixhQUFhLFNBQVMsWUFBWSxVQUFVLEVBQUc7QUFFN0UsaUJBQWU7QUFDZixtQkFBaUI7QUFDakIsd0JBQXNCLE1BQU07QUFDMUIseUJBQXFCLEtBQUs7QUFDMUIsd0JBQW9CO0FBQUEsRUFDdEIsQ0FBQztBQUNELFNBQU87QUFDVDtBQUVBLFNBQVMsUUFBUSxTQUF5QjtBQUN4QyxNQUFJLFVBQVUsR0FBSSxRQUFPLEdBQUcsS0FBSyxNQUFNLE9BQU8sQ0FBQztBQUMvQyxRQUFNLElBQUksS0FBSyxNQUFNLFVBQVUsRUFBRTtBQUNqQyxTQUFPLElBQUksS0FBSyxHQUFHLENBQUMsS0FBSyxLQUFLLE1BQU0sVUFBVSxFQUFFLENBQUMsTUFBTSxHQUFHLEtBQUssTUFBTSxJQUFJLEVBQUUsQ0FBQyxLQUFLLElBQUksRUFBRTtBQUN6RjtBQUdBLElBQU0sVUFBVSxTQUFTLGVBQWUsU0FBUztBQUdqRCxJQUFNLE9BQU8sQ0FBQyxVQUFrQixVQUFVLGFBQWEsTUFBTSxXQUFXLFNBQVM7QUFDakYsSUFBTSxlQUFlLENBQUMsU0FBbUIsS0FBSyxLQUFLLEVBQUUsS0FBSyxLQUFLLFFBQVEsS0FBSyxRQUFRO0FBRXBGLFNBQVMsY0FBYyxRQUFvQjtBQUN6QyxlQUFhLG9CQUFvQixNQUFNO0FBQ3ZDLGFBQVcsT0FBTyxNQUFNLEtBQUssU0FBUyxpQkFBb0MsbUJBQW1CLENBQUMsR0FBRztBQUMvRixVQUFNLEtBQUssSUFBSSxRQUFRLFdBQVc7QUFDbEMsUUFBSSxVQUFVLE9BQU8sTUFBTSxFQUFFO0FBQzdCLFFBQUksYUFBYSxnQkFBZ0IsT0FBTyxFQUFFLENBQUM7QUFBQSxFQUM3QztBQUNBLGlCQUFlO0FBQ2YsOEJBQTRCO0FBQzVCLHdCQUFzQixNQUFNLHdCQUF3QixDQUFDO0FBQ3ZEO0FBRUEsU0FBUyxpQkFBaUI7QUFDeEIsUUFBTSxNQUFNLENBQUMsR0FBRyxNQUFNLE9BQU8sQ0FBQztBQUM5QixRQUFNLGdCQUFnQixJQUFJLE9BQU8sWUFBWSxFQUFFO0FBQy9DLFFBQU0sY0FBYyxnQkFBZ0I7QUFDcEMsUUFBTSxlQUFlLFFBQVE7QUFDN0IsUUFBTSxlQUFlLEVBQUUsU0FBUyxFQUFFO0FBQ2xDLFFBQU0sWUFBWSxFQUFFLFNBQVMsRUFBRSxvQkFBb0IsRUFBRSxhQUFhLEVBQUU7QUFFcEUsUUFBTSxNQUFNLG9CQUFvQixZQUFZO0FBQUEsSUFDMUMsUUFBUTtBQUFBLElBQ1IsU0FBUztBQUFBLElBQ1QsU0FBUztBQUFBLElBQ1QsTUFBTTtBQUFBLEVBQ1IsQ0FBQztBQUVELElBQUUsZUFBZSxFQUFFLFNBQVMsQ0FBQyxJQUFJO0FBQ2pDLFVBQVEsU0FBUyxDQUFDLElBQUk7QUFDdEIsSUFBRSxpQkFBaUIsRUFBRSxTQUFTLENBQUMsSUFBSTtBQUNuQyxJQUFFLFdBQVcsRUFBRSxTQUFTLENBQUMsSUFBSTtBQUM3QixJQUFFLFlBQVksRUFBRSxTQUFTLENBQUMsSUFBSTtBQUM5QixJQUFFLFNBQVMsRUFBRSxTQUFTLENBQUMsSUFBSTtBQUUzQixJQUFFLGVBQWUsRUFBRSxjQUFjLGNBQWMsSUFBSSxPQUFPLFdBQVcsSUFBSTtBQUN6RSxJQUFFLGdCQUFnQixFQUFFLGNBQWMsZUFBZSxJQUFJLE9BQU8sWUFBWSxJQUFJO0FBQzVFLElBQUUsY0FBYyxFQUFFLGNBQWMsZUFBZSxJQUFJLFFBQUssWUFBWSxLQUFLO0FBQ3pFLElBQUUsV0FBVyxFQUFFLGNBQWMsWUFBWSxJQUFJLFFBQUssU0FBUyxLQUFLO0FBQ2hFLDRCQUEwQjtBQUM1QjtBQUVBLFNBQVMsbUJBQW1CO0FBQzFCLFFBQU0sTUFBTSxDQUFDLEdBQUcsTUFBTSxPQUFPLENBQUM7QUFDOUIsUUFBTSxnQkFBZ0IsSUFBSSxPQUFPLFlBQVksRUFBRTtBQUMvQyxRQUFNLFVBQVUsSUFBSSxPQUFPLENBQUMsTUFBTSxFQUFFLEVBQUUsTUFBTSxXQUFXLFNBQVMsS0FBSyxRQUFRLEVBQUUsUUFBUSxDQUFDLEVBQUU7QUFDMUYsUUFBTSxjQUFjLGdCQUFnQjtBQUNwQyxRQUFNLGlCQUFpQixVQUFVO0FBQ2pDLFFBQU0sYUFBYSxjQUFjLElBQUksY0FBYztBQUVuRCxRQUFNLFFBQVEsRUFBRSxhQUFhO0FBQzdCLFFBQU0sU0FBUyxlQUFlO0FBQzlCLFFBQU0sY0FBYyxPQUFPLFVBQVU7QUFDckMsUUFBTSxVQUFVLE9BQU8sUUFBUSxpQkFBaUIsQ0FBQztBQUVqRCxRQUFNLE1BQU0sRUFBRSxrQkFBa0I7QUFDaEMsUUFBTSxVQUFVLGNBQWMsS0FBSyxzQkFBc0I7QUFDekQsTUFBSSxTQUFTLENBQUM7QUFDZCxNQUFJLFVBQVUsT0FBTyxXQUFXLE9BQU87QUFDdkMsTUFBSSxVQUFVLE9BQU8sUUFBUSxpQkFBaUIsQ0FBQztBQUMvQyxNQUFJLFNBQVM7QUFDWCxVQUFNLFdBQVcsSUFBSSxLQUFLLENBQUMsTUFBTSxFQUFFLFFBQVE7QUFDM0MsVUFBTSxRQUFRLFdBQ1Ysb0JBQW9CLFNBQVMsRUFBRSxLQUFLLEtBQ3BDLGlCQUFpQixJQUNmLEdBQUcsY0FBYyxRQUFRLGlCQUFpQixJQUFJLE1BQU0sRUFBRSxxQkFDdEQsY0FBYyxJQUNaLEdBQUcsV0FBVyxlQUFlLGNBQWMsSUFBSSxNQUFNLEVBQUUsS0FDdkQsR0FBRyxtQkFBbUIsb0JBQW9CLHNCQUFzQixJQUFJLE1BQU0sRUFBRTtBQUNwRixNQUFFLFVBQVUsRUFBRSxjQUFjO0FBQUEsRUFDOUI7QUFDRjtBQUVBLFNBQVMsVUFBVSxRQUFRLE9BQU87QUFDaEMsUUFBTSxPQUFPLEVBQUUsT0FBTztBQUN0QixRQUFNLE9BQU8sRUFBRSxTQUFTO0FBQ3hCLFFBQU0sT0FBTyxTQUFTLGVBQWUsVUFBVSxPQUFPO0FBQ3RELE1BQUksQ0FBQyxTQUFTLFNBQVMsS0FBSyxTQUFTLElBQUksS0FBSyxLQUFLLFNBQVMsSUFBSSxNQUFNLEtBQUssY0FBYyxNQUFNLEVBQUc7QUFDbEcsT0FBSyxZQUFZO0FBQ2pCLE9BQUssWUFBWTtBQUNqQixRQUFNLE1BQU0sQ0FBQyxHQUFHLE1BQU0sT0FBTyxDQUFDLEVBQUUsUUFBUTtBQUN4QyxNQUFJLElBQUksV0FBVyxHQUFHO0FBQ3BCLFNBQUssT0FBTyxPQUFPO0FBQ25CLE1BQUUsV0FBVyxFQUFFLGNBQWM7QUFDN0IsTUFBRSxXQUFXLEVBQUUsU0FBUztBQUN4QixtQkFBZTtBQUNmLHFCQUFpQjtBQUNqQjtBQUFBLEVBQ0Y7QUFDQSxRQUFNLFVBQVUsSUFBSSxPQUFPLENBQUMsTUFBTSxFQUFFLEVBQUUsVUFBVSxTQUFTLEVBQUU7QUFDM0QsUUFBTSxjQUFjLElBQUksT0FBTyxZQUFZLEVBQUU7QUFDN0MsSUFBRSxXQUFXLEVBQUUsY0FBYyxVQUFVLElBQUksR0FBRyxPQUFPLGFBQWEsY0FBYyxJQUFJLEdBQUcsV0FBVyxhQUFhO0FBQy9HLElBQUUsV0FBVyxFQUFFLFNBQVMsQ0FBQyxVQUFVLFVBQVU7QUFDN0MsYUFBVyxRQUFRLEtBQUs7QUFDdEIsVUFBTSxJQUFJLEtBQUs7QUFDZixVQUFNLFVBQVUsRUFBRSxNQUFNLFdBQVcsU0FBUztBQUM1QyxVQUFNLE9BQU8sU0FBUyxjQUFjLEtBQUs7QUFDekMsU0FBSyxZQUFZLFFBQVEsVUFBVSxZQUFZLEVBQUUsS0FBSztBQUN0RCxVQUFNLE9BQU8sS0FBSyxTQUFTLElBQUksS0FBSyxLQUFLO0FBQ3pDLFNBQUssWUFDSCw0Q0FDd0IsRUFBRSxVQUFVLE9BQU8sT0FBTyxFQUFFLEtBQUssRUFBRSxVQUFVLE9BQU8sT0FBTyxRQUFRLHlEQUVsRSxFQUFFLFVBQVUsWUFBWSwrQkFBK0IsRUFBRSxHQUFHLFdBQVcsRUFBRSxLQUFLLENBQUMsNEJBQ2pGLFFBQVEsR0FBRyxDQUFDO0FBR3JDLFVBQU0sVUFBVSxLQUFLLGNBQWMsUUFBUTtBQUMzQyxZQUFRLGNBQWMsRUFBRTtBQUN4QixZQUFRLFFBQVEsRUFBRTtBQUNsQixTQUFLLGNBQWMsSUFBSSxFQUFHLGNBQWMsRUFBRSxZQUFZLEVBQUU7QUFDeEQsUUFBSSxFQUFFLFVBQVU7QUFDZCxZQUFNLElBQUksU0FBUyxjQUFjLEtBQUs7QUFDdEMsUUFBRSxZQUFZO0FBQ2QsUUFBRSxjQUFjLFNBQVMsRUFBRSxRQUFRO0FBQ25DLFdBQUssT0FBTyxDQUFDO0FBQUEsSUFDZjtBQUNBLFFBQUksS0FBSyxZQUFZLEVBQUUsVUFBVSxXQUFXO0FBQzFDLFlBQU0sTUFBTSxTQUFTLGNBQWMsS0FBSztBQUN4QyxVQUFJLFlBQVk7QUFDaEIsVUFBSSxZQUFZO0FBQ2hCLFVBQUksY0FBYyxNQUFNLEVBQUcsY0FBYyxLQUFLLFNBQVM7QUFDdkQsWUFBTSxTQUFTLENBQUMsV0FBNEI7QUFDMUMsYUFBSyxXQUFXO0FBQ2hCLGtCQUFVLElBQUk7QUFDZCxhQUFLLE1BQU0sb0JBQW9CLEVBQUUsUUFBUSxRQUFRLE1BQU0sS0FBSyxVQUFVLEVBQUUsTUFBTSxVQUFVLFFBQVEsRUFBRSxJQUFJLE9BQU8sQ0FBQyxFQUFFLENBQUMsRUFDOUcsS0FBSyxDQUFDLE1BQU0sTUFBTSxFQUFFLEtBQU0sV0FBVyxTQUFTLGFBQWEsV0FBWSxrQ0FBa0MsQ0FBQztBQUFBLE1BQy9HO0FBQ0EsaUJBQVcsQ0FBQyxPQUFPLE1BQU0sS0FBSyxDQUFDLENBQUMsZ0JBQWdCLE1BQU0sR0FBRyxDQUFDLFFBQVEsTUFBTSxDQUFDLEdBQVk7QUFDbkYsY0FBTSxJQUFJLFNBQVMsY0FBYyxRQUFRO0FBQ3pDLFVBQUUsT0FBTztBQUNULFVBQUUsY0FBYztBQUNoQixZQUFJLFdBQVcsT0FBUSxHQUFFLFlBQVk7QUFBQSxZQUNoQyxHQUFFLFlBQVk7QUFDbkIsVUFBRSxVQUFVLE1BQU0sT0FBTyxNQUFNO0FBQy9CLFlBQUksY0FBYyxPQUFPLEVBQUcsT0FBTyxDQUFDO0FBQUEsTUFDdEM7QUFDQSxXQUFLLE9BQU8sR0FBRztBQUFBLElBQ2pCO0FBQ0EsUUFBSSxFQUFFLFVBQVUsVUFBVyxNQUFLLFdBQVc7QUFDM0MsVUFBTSxPQUFPLFNBQVMsY0FBYyxLQUFLO0FBQ3pDLFNBQUssWUFBWTtBQUNqQixVQUFNLFNBQVMsQ0FBQyxNQUFjLElBQWdCLE1BQU0sT0FBTztBQUN6RCxZQUFNLElBQUksU0FBUyxjQUFjLFFBQVE7QUFDekMsUUFBRSxPQUFPO0FBQ1QsUUFBRSxjQUFjO0FBQ2hCLFVBQUksSUFBSyxHQUFFLFlBQVk7QUFDdkIsUUFBRSxVQUFVO0FBQ1osV0FBSyxPQUFPLENBQUM7QUFDYixhQUFPO0FBQUEsSUFDVDtBQUNBLFFBQUksVUFBVSxnQkFBZ0IsR0FBRztBQUMvQixZQUFNLGdCQUFnQjtBQUN0QixhQUFPLFVBQVUsV0FBVyxhQUFhLE1BQU0sYUFBYSxNQUFNLEdBQUcsYUFBYSxDQUFDO0FBQ25GLFVBQUksRUFBRSxVQUFVLFVBQVcsUUFBTyxVQUFVLE1BQU0sS0FBSyxFQUFFLE1BQU0sY0FBYyxNQUFNLEVBQUUsR0FBRyxDQUFDLEdBQUcsUUFBUTtBQUFBLElBQ3RHO0FBQ0EsUUFBSSxLQUFLLFNBQVUsUUFBTyxVQUFVLE1BQU0sWUFBWSxLQUFLLFFBQVMsQ0FBQztBQUNyRSxRQUFJLEtBQUssT0FBUSxRQUFPLFdBQVcsTUFBTTtBQUFFLFdBQUssVUFBVSxXQUFXLFVBQVUsS0FBSyxNQUFPO0FBQUcsWUFBTSxrQkFBa0I7QUFBQSxJQUFHLENBQUM7QUFDMUgsUUFBSSxLQUFLLGtCQUFtQixNQUFLLE9BQU8sSUFBSTtBQUM1QyxLQUFDLGFBQWEsSUFBSSxJQUFJLE9BQU8sTUFBTSxPQUFPLElBQUk7QUFBQSxFQUNoRDtBQUNBLE1BQUksS0FBSyxzQkFBc0IsRUFBRyxNQUFLLE9BQU8sT0FBTztBQUNyRCxpQkFBZTtBQUNmLG1CQUFpQjtBQUNuQjtBQUVBLFNBQVMsYUFBYSxNQUFtQixHQUFZLGVBQXVCO0FBQzFFLFFBQU0sV0FBVyxLQUFLLGNBQWMsTUFBTTtBQUMxQyxNQUFJLFVBQVU7QUFBRSxhQUFTLGNBQWMsT0FBTyxHQUFHLE1BQU07QUFBRztBQUFBLEVBQVE7QUFDbEUsUUFBTSxPQUFPLFNBQVMsY0FBYyxNQUFNO0FBQzFDLE9BQUssWUFBWTtBQUNqQixPQUFLLFlBQVksOENBQXlDLFdBQVcsRUFBRSxLQUFLLENBQUM7QUFDN0UsUUFBTSxRQUFRLEtBQUssY0FBYyxPQUFPO0FBQ3hDLE9BQUssV0FBVyxDQUFDLE1BQU07QUFDckIsTUFBRSxlQUFlO0FBQ2pCLFVBQU0sT0FBTyxNQUFNLE1BQU0sS0FBSztBQUM5QixRQUFJLE1BQU07QUFDUixVQUFJLENBQUMsa0JBQWtCLGVBQWUsZUFBZSxNQUFNLElBQUksRUFBRSxFQUFFLENBQUMsR0FBRztBQUNyRSxjQUFNLDRCQUE0QjtBQUFBLE1BQ3BDLE9BQU87QUFDTCxhQUFLLEVBQUUsTUFBTSxTQUFTLE1BQU0sRUFBRSxJQUFJLEtBQUssQ0FBQztBQUN4QyxhQUFLLGNBQVMsRUFBRSxLQUFLLEtBQUssSUFBSSxFQUFFO0FBQ2hDLG1CQUFXLElBQUk7QUFBQSxNQUNqQjtBQUFBLElBQ0Y7QUFDQSxVQUFNLEtBQUs7QUFDWCxTQUFLLE9BQU87QUFDWixjQUFVO0FBQUEsRUFDWjtBQUNBLFFBQU0sWUFBWSxDQUFDLE1BQU07QUFBRSxRQUFJLEVBQUUsUUFBUSxVQUFVO0FBQUUsUUFBRSxnQkFBZ0I7QUFBRyxZQUFNLEtBQUs7QUFBRyxXQUFLLE9BQU87QUFBRyxnQkFBVTtBQUFBLElBQUc7QUFBQSxFQUFFO0FBQ3RILE9BQUssT0FBTyxJQUFJO0FBQ2hCLFFBQU0sTUFBTTtBQUNkO0FBR0EsZUFBZSxjQUFjO0FBQzNCLE1BQUksT0FBdUosQ0FBQztBQUM1SixNQUFJO0FBQUUsV0FBTyxPQUFPLE1BQU0sTUFBTSxpQkFBaUIsRUFBRSxPQUFPLFdBQVcsQ0FBQyxHQUFHLEtBQUs7QUFBQSxFQUFHLFFBQVE7QUFBQSxFQUFDO0FBQzFGLFFBQU0sVUFBVSxJQUFJLElBQUksQ0FBQyxHQUFHLE1BQU0sT0FBTyxDQUFDLEVBQUUsSUFBSSxDQUFDLE1BQU0sRUFBRSxNQUFNLEVBQUUsT0FBTyxPQUFPLENBQUM7QUFDaEYsU0FBTyxLQUFLLE9BQU8sQ0FBQyxNQUFNLENBQUMsUUFBUSxJQUFJLEVBQUUsTUFBTSxDQUFDO0FBQ2hELFFBQU0sT0FBTyxFQUFFLFNBQVM7QUFDeEIsUUFBTSxPQUFPLEVBQUUsYUFBYTtBQUM1QixPQUFLLFlBQVk7QUFDakIsT0FBSyxZQUFZO0FBQ2pCLHVCQUFxQjtBQUNyQix3QkFBc0I7QUFDdEIsYUFBVyxLQUFLLE1BQU07QUFDcEIsVUFBTSxPQUFPLFNBQVMsY0FBYyxLQUFLO0FBQ3pDLFVBQU0sUUFBUSxFQUFFLFVBQVUsK0JBQStCLEVBQUU7QUFDM0QsU0FBSyxZQUFZLFFBQVEsRUFBRSxXQUFXLFlBQVksWUFBWSxFQUFFLFVBQVUsWUFBWSxVQUFVO0FBQ2hHLFVBQU0sTUFBTSxLQUFLLElBQUksSUFBSSxLQUFLLElBQUksSUFBSSxLQUFLLE1BQU0sRUFBRSxPQUFPLEtBQUssR0FBSTtBQUNuRSxTQUFLLFlBQ0gsd0dBR3lCLEVBQUUsV0FBVyxZQUFZLCtCQUErQixFQUFFLEdBQUcsV0FBVyxLQUFLLENBQUMsNEJBQ2hGLFFBQVEsR0FBRyxDQUFDO0FBR3JDLFVBQU0sVUFBVSxLQUFLLGNBQWMsUUFBUTtBQUMzQyxZQUFRLGNBQWMsRUFBRTtBQUN4QixZQUFRLFFBQVEsRUFBRTtBQUNsQixTQUFLLGNBQWMsSUFBSSxFQUFHLGNBQWMsRUFBRSxTQUFTLEVBQUUsU0FBUyxNQUFNLEVBQUUsTUFBTSxLQUFLO0FBQ2pGLFVBQU0sT0FBTyxTQUFTLGNBQWMsS0FBSztBQUN6QyxTQUFLLFlBQVk7QUFDakIsUUFBSSxFQUFFLElBQUk7QUFBRSxZQUFNLElBQUksU0FBUyxjQUFjLEdBQUc7QUFBRyxRQUFFLE9BQU8sRUFBRTtBQUFJLFFBQUUsU0FBUztBQUFVLFFBQUUsTUFBTTtBQUFZLFFBQUUsY0FBYztBQUFRLFdBQUssT0FBTyxDQUFDO0FBQUEsSUFBRztBQUNuSixVQUFNLE9BQU8sU0FBUyxjQUFjLFFBQVE7QUFDNUMsU0FBSyxPQUFPO0FBQ1osU0FBSyxjQUFjO0FBQ25CLFNBQUssVUFBVSxNQUFNO0FBQUUsV0FBSyxVQUFVLFdBQVcsVUFBVSxFQUFFLE1BQU07QUFBRyxZQUFNLGtCQUFrQjtBQUFBLElBQUc7QUFDakcsU0FBSyxPQUFPLElBQUk7QUFDaEIsU0FBSyxPQUFPLElBQUk7QUFDaEIsVUFBTSxTQUFTLEVBQUUsV0FBVyxhQUFhLEVBQUU7QUFDM0MsUUFBSSxPQUFRO0FBQ1osUUFBSSxFQUFFLFFBQVM7QUFDZixLQUFDLFNBQVMsT0FBTyxNQUFNLE9BQU8sSUFBSTtBQUFBLEVBQ3BDO0FBQ0EsaUJBQWU7QUFDZixtQkFBaUI7QUFDbkI7QUFFQSxJQUFNLGNBQXNDO0FBQUEsRUFDMUMsTUFBTTtBQUFBLEVBQVEsWUFBWTtBQUFBLEVBQWUsV0FBVztBQUFBLEVBQWEsU0FBUztBQUFBLEVBQzFFLFNBQVM7QUFBQSxFQUNULFNBQVM7QUFBQSxFQUE0QyxRQUFRO0FBQUEsRUFBYSxPQUFPO0FBQ25GO0FBRUEsU0FBUyxXQUFXLFNBQWtCO0FBQ3BDLFFBQU0sUUFBUSxRQUFRLE1BQU0sS0FBSyxXQUFXO0FBQzVDLFFBQU0sV0FBVyxRQUFRLE1BQU0sS0FBSyxDQUFDLFNBQVMsZUFBZSxhQUFhLGVBQWUsYUFBYSxNQUFNLFNBQVM7QUFDckgsUUFBTSxZQUFZLENBQUMsVUFBVTtBQUM3QixRQUFNLFFBQVEsU0FDVCxZQUFhLFNBQVMsV0FBWSxhQUFhLGFBQ2hELFlBQVksVUFBVTtBQUMxQixJQUFFLFFBQVEsRUFBRSxZQUFZO0FBQ3hCLFdBQVMsS0FBSyxRQUFRLFFBQVEsU0FBUyxRQUFRLFlBQVksVUFBVTtBQUNyRSxXQUFTLEtBQUssVUFBVSxPQUFPLGNBQWMsUUFBUSxNQUFNLENBQUM7QUFDNUQsUUFBTSxZQUFZLGtCQUFrQixHQUFHLFNBQVM7QUFDaEQsTUFBSSxPQUFPLFlBQ04sY0FBYyxpQkFBWSxTQUFTLGlCQUNsQyxNQUFNLGlCQUFpQixrQ0FBNkIsU0FBUyxXQUM3RCxxQkFBZ0IsU0FBUyxXQUMzQixXQUFXLGFBQ1gsZUFBZSxZQUFZLDBCQUFrQixTQUFTLFdBQ3RELFlBQVksVUFBVSxLQUFLO0FBQy9CLE1BQUksU0FBUyxlQUFlLFFBQVMsUUFBTyxXQUFXLGtCQUFhLGVBQWUsWUFBWSw0QkFBeUI7QUFDeEgsTUFBSSxVQUFVLENBQUMsU0FBUyxTQUFTLENBQUMsV0FBVyxDQUFDLFNBQVUsU0FBUTtBQUNoRSxNQUFJLFFBQVMsUUFBTztBQUNwQixNQUFJLFFBQVMsUUFBTyxHQUFHLElBQUksS0FBSyxPQUFPO0FBQ3ZDLE1BQUksZUFBZSxXQUFXLFdBQVcsVUFBVyxHQUFFLFlBQVksRUFBRSxjQUFjO0FBQ2xGLElBQXFCLE1BQU0sRUFBRSxVQUFVLE9BQU8sUUFBUSxZQUFhLFNBQVMsUUFBUztBQUVyRixRQUFNLE1BQU0sRUFBRSxTQUFTO0FBQ3ZCLE1BQUksU0FBUyxDQUFDO0FBQ2QsSUFBRSxVQUFVLEVBQUUsU0FBUyxFQUFFLFVBQVUsQ0FBQyxVQUFVLGVBQWUsYUFBYSxlQUFlO0FBQ3pGLE1BQUksUUFBUTtBQUNWLE1BQUUsZUFBZSxFQUFFLGNBQWM7QUFDakMsTUFBRSxXQUFXLEVBQUUsU0FBUztBQUN4QixRQUFJLENBQUMsTUFBTyxHQUFFLFdBQVcsRUFBRSxjQUFjLFlBQVksSUFBSSxJQUFJLFNBQVM7QUFDdEUsVUFBTSxVQUFVLFFBQVMsV0FBVyxhQUFhLFNBQzdDLFdBQVcsYUFDWCxTQUFTLENBQUMsVUFBVSxVQUNwQjtBQUNKLHFCQUFpQixTQUFTLFNBQVMsQ0FBQyxVQUFVLElBQUksTUFBTSxLQUFLO0FBQUEsRUFDL0Q7QUFDRjtBQUlBLFNBQVMsS0FBSyxPQUFnQyxJQUFJLElBQUksR0FBYztBQUNsRSxNQUFJLENBQUMsUUFBUSxDQUFDLE9BQVEsUUFBTyxDQUFDO0FBQzlCLFFBQU0sSUFBNkIsRUFBRSxHQUFHLE9BQU8sRUFBRTtBQUNqRCxRQUFNLFFBQVEsRUFBRSxTQUFTLFNBQVMsRUFBRSxTQUFTO0FBQzdDLE1BQUksQ0FBQyxNQUFPLEtBQUksTUFBTSxFQUFFLFNBQVMsZUFBZSxNQUFNLEVBQUUsR0FBRyxXQUFNLE1BQU0sT0FBTyxFQUFFLElBQUksQ0FBQyxDQUFDLEtBQUssS0FBSyxVQUFVLENBQUMsRUFBRSxNQUFNLEdBQUcsR0FBRyxHQUFHLElBQUk7QUFDaEksUUFBTSxXQUFXLEtBQUssTUFBTSxLQUFLLEtBQUssUUFBUSxLQUFLLFVBQVUsQ0FBQyxDQUFDLENBQUM7QUFDaEUsRUFBQUMsS0FBSSxVQUFVLENBQUM7QUFDZixTQUFPO0FBQ1Q7QUFFQSxTQUFTQSxLQUFJLFVBQXFCLFlBQVksSUFBSSxHQUFHO0FBQ25ELGFBQVcsS0FBSyxVQUFVO0FBQ3hCLFlBQVEsRUFBRSxNQUFNO0FBQUEsTUFDZCxLQUFLO0FBQWMsZ0JBQVEsRUFBRSxLQUFLLEVBQUUsWUFBWSxVQUFVO0FBQUc7QUFBQSxNQUM3RCxLQUFLLFdBQVc7QUFDZCxnQkFBUSxJQUFJLEVBQUUsR0FBRyxHQUFHLEtBQUssRUFBRSxJQUFJO0FBQy9CLFlBQUksQ0FBQyxFQUFFLEtBQUssV0FBVywyQkFBMkIsRUFBRyxLQUFJLE9BQU8sTUFBTSxFQUFFLEdBQUcsV0FBTSxNQUFNLEVBQUUsSUFBSSxDQUFDLElBQUksS0FBSztBQUFBLGlCQUM5RixDQUFDLGVBQWUsSUFBSSxFQUFFLEdBQUcsRUFBRyxRQUFPO0FBQzVDO0FBQUEsTUFDRjtBQUFBLE1BQ0EsS0FBSztBQUFZLGdCQUFRLElBQUksRUFBRSxHQUFHLEdBQUcsTUFBTTtBQUFHLGdCQUFRLE9BQU8sRUFBRSxHQUFHO0FBQUcsWUFBSSxPQUFPLE1BQU0sRUFBRSxHQUFHLFVBQVUsS0FBSztBQUFHO0FBQUEsTUFDN0csS0FBSyxhQUFhO0FBQ2hCLFlBQUksT0FBTyxFQUFFLE1BQU0sS0FBSztBQUN4QixjQUFNLGlCQUFpQixlQUFlLGNBQWMsT0FBTyxDQUFDLElBQUksQ0FBQztBQUNqRSx1QkFBZTtBQUNmLHVCQUFlO0FBQ2YsYUFBSyxNQUFNLFVBQVUsT0FBTyxXQUFXLENBQUMsRUFBRSxNQUFNLENBQUMsUUFBUTtBQUFFLGNBQUksU0FBUyxlQUFlLElBQUksT0FBTyxJQUFJLEtBQUs7QUFBRyxnQkFBTSxlQUFlLElBQUksT0FBTyxFQUFFO0FBQUEsUUFBRyxDQUFDO0FBQ3BKLFlBQUksZUFBZSxTQUFTLEdBQUc7QUFDN0IsZ0JBQU0sVUFBVSxLQUFLLE1BQU0sZUFBZSxPQUFPLENBQUMsR0FBRyxNQUFNLElBQUksRUFBRSxZQUFZLENBQUMsSUFBSSxFQUFFO0FBQ3BGLGNBQUksT0FBTyxZQUFZLE9BQU8sOEJBQThCLEtBQUs7QUFDakUseUJBQWUsTUFBTTtBQUNuQixnQkFBSSxDQUFDLE9BQVE7QUFDYix1QkFBVyxTQUFTLGdCQUFnQjtBQUNsQyxrQkFBSSxDQUFDLE9BQVE7QUFDYixxQkFBTztBQUNQLG1CQUFLLEVBQUUsTUFBTSxPQUFPLEtBQUssY0FBYyxLQUFLLEVBQUUsQ0FBQztBQUFBLFlBQ2pEO0FBQUEsVUFDRixDQUFDO0FBQUEsUUFDSDtBQUNBO0FBQUEsTUFDRjtBQUFBLE1BQ0EsS0FBSztBQUNILFlBQUksT0FBTyxFQUFFLE1BQU0sS0FBSztBQUN4QixhQUFLLE1BQU0sU0FBUyxPQUFPLFdBQVcsQ0FBQyxFQUFFLE1BQU0sQ0FBQyxRQUFRO0FBQUUsY0FBSSxTQUFTLGVBQWUsSUFBSSxPQUFPLElBQUksS0FBSztBQUFHLGdCQUFNLGVBQWUsSUFBSSxPQUFPLEVBQUU7QUFBQSxRQUFHLENBQUM7QUFDbko7QUFBQSxNQUNGLEtBQUs7QUFDSCxZQUFJLENBQUMsVUFBVyxPQUFNLFFBQVE7QUFDOUI7QUFBQSxNQUNGLEtBQUssUUFBUTtBQUNYLGNBQU0sSUFBSSxJQUFJO0FBQ2QsY0FBTSxNQUFNLEVBQUUsSUFBSSxTQUFTLElBQUksSUFBSSxJQUFJLEVBQUUsSUFBSSxTQUFTLEdBQUcsSUFBSSxJQUFJO0FBQ2pFLGNBQU0sV0FBVyxLQUFLLElBQUksR0FBRyxLQUFLLE1BQU8sRUFBRSxJQUFJLFNBQVMsSUFBSyxDQUFDLElBQUksR0FBRztBQUNyRSwwQkFBa0IsS0FBSyxJQUFJLGlCQUFpQixTQUFTLElBQUksV0FBVztBQUVwRSxZQUFJLENBQUMsUUFBUSxXQUFXLE1BQU0sU0FBUyxRQUFRLElBQUksUUFBUSxXQUFXLE9BQU8sUUFBUSxZQUFZLEtBQUssSUFBSSxRQUFRLFlBQVksSUFBSTtBQUNoSSxrQkFBUSxNQUFNLEtBQUssSUFBSSxRQUFRLFNBQVM7QUFDeEMsY0FBSSxRQUFRLE1BQU0sU0FBUyxHQUFJLFNBQVEsTUFBTSxNQUFNO0FBQ25ELGtCQUFRLFVBQVU7QUFDbEIsc0JBQVk7QUFBQSxRQUNkO0FBQ0EsZ0JBQVEsV0FBVztBQUNuQixjQUFNLEtBQUssRUFBRSxHQUFHO0FBQ2hCLGVBQU87QUFDUDtBQUFBLE1BQ0Y7QUFBQSxNQUNBLEtBQUs7QUFDSCwwQkFBa0IsS0FBSyxJQUFJLGlCQUFpQixTQUFTO0FBQ3JELGNBQU0sTUFBTTtBQUNaLFlBQUksT0FBTyxTQUFTLEtBQUs7QUFDekI7QUFBQSxNQUNGLEtBQUs7QUFDSCxjQUFNLElBQUksRUFBRSxHQUFHO0FBQ2YsWUFBSSxPQUFPLE9BQU8sRUFBRSxNQUFNLElBQUksS0FBSztBQUVuQyxZQUFJLEVBQUUsV0FBVyxjQUFlLFNBQVEsVUFBVTtBQUNsRDtBQUFBLE1BQ0YsS0FBSztBQUFZLHVCQUFlLFFBQVEsRUFBRSxFQUFFLENBQUM7QUFBRztBQUFBLE1BQ2hELEtBQUs7QUFBYSxhQUFLLEtBQUssQ0FBQztBQUFHO0FBQUEsTUFDaEMsS0FBSztBQUFlLGtCQUFVLEVBQUUsS0FBSyxFQUFFLE1BQU07QUFBRztBQUFBLE1BQ2hELEtBQUs7QUFBYyxhQUFLLFNBQVMsQ0FBQztBQUFHO0FBQUEsTUFDckMsS0FBSyxVQUFVO0FBQ2IsY0FBTSxPQUFPO0FBQ2IscUJBQWEsRUFBRTtBQUNmLFlBQUksRUFBRSxXQUFXLGFBQWEsU0FBUyxhQUFhLFFBQVEsVUFBVSxFQUFHLE9BQU0sSUFBSSxVQUFVO0FBQzdGLG1CQUFXLEVBQUUsV0FBVyxVQUFVLEVBQUUsV0FBVyxTQUFZLE1BQVM7QUFDcEUsWUFBSSxVQUFVLEVBQUUsVUFBVSxFQUFFLFVBQVUsS0FBSyxFQUFFLE9BQU8sS0FBSyxLQUFLLFFBQVE7QUFDdEUsWUFBSSxFQUFFLFdBQVcsU0FBUztBQUFFLGNBQUksRUFBRSxRQUFTLE1BQUssRUFBRSxPQUFPO0FBQUcsY0FBSTtBQUFBLFFBQUc7QUFDbkU7QUFBQSxNQUNGO0FBQUEsTUFDQSxLQUFLO0FBQWUsYUFBSyxTQUFTLEVBQUUsSUFBSSxFQUFFLElBQUk7QUFBRztBQUFBLE1BQ2pELEtBQUs7QUFBYyxpQkFBUyxJQUFJLEVBQUUsRUFBRSxHQUFHLE1BQU07QUFBRyxpQkFBUyxPQUFPLEVBQUUsRUFBRTtBQUFHLFlBQUksT0FBTyxXQUFXLEVBQUUsRUFBRSxZQUFZLEtBQUs7QUFBRztBQUFBLE1BQ3JILEtBQUs7QUFBWSxtQkFBVyxFQUFFO0FBQUksbUJBQVc7QUFBRztBQUFBLE1BQ2hELEtBQUs7QUFBUyxhQUFLLEVBQUUsT0FBTztBQUFHLFlBQUksU0FBUyxFQUFFLFNBQVMsS0FBSztBQUFHO0FBQUEsTUFDL0QsS0FBSztBQUFXLGdCQUFRLEVBQUUsSUFBSTtBQUFHO0FBQUEsTUFDakMsS0FBSztBQUNILG1CQUFXLEVBQUUsTUFBTSxFQUFFLE1BQU0sRUFBRSxJQUFJO0FBQ2pDLGlCQUFTLEVBQUUsTUFBTSxFQUFFLE1BQU0sRUFBRSxTQUFTLGNBQWMsV0FBVyxRQUFXLGFBQWEsRUFBRSxJQUFJO0FBQzNGLG1CQUFXLEVBQUU7QUFDYjtBQUFBLE1BQ0YsS0FBSyxRQUFRO0FBQ1gsY0FBTSxPQUFPLE1BQU0sSUFBSSxFQUFFLEVBQUUsS0FBSyxFQUFFLEdBQUcsT0FBTyxJQUFJLEdBQUcsT0FBTyxLQUFLO0FBQy9ELFlBQUksRUFBRSxVQUFVLGFBQWEsS0FBSyxFQUFFLFVBQVUsV0FBVztBQUFFLGVBQUssUUFBUSxJQUFJO0FBQUcsZUFBSyxRQUFRO0FBQUEsUUFBTTtBQUNsRyxZQUFJLEVBQUUsVUFBVSxhQUFhLEtBQUssU0FBUyxLQUFNLE1BQUssUUFBUSxJQUFJO0FBQ2xFLGFBQUssSUFBSTtBQUNULGNBQU0sSUFBSSxFQUFFLElBQUksSUFBSTtBQUNwQixrQkFBVTtBQUNWO0FBQUEsTUFDRjtBQUFBLE1BQ0EsS0FBSztBQUFhO0FBQUEsTUFDbEIsS0FBSztBQUFhLFVBQUUsU0FBUyxFQUFFLFNBQVMsQ0FBQyxFQUFFO0FBQVE7QUFBQSxNQUNuRCxLQUFLO0FBQ0gsY0FBTSxlQUFVLEVBQUUsS0FBSyxXQUFNLEVBQUUsWUFBWSxTQUFTLFlBQVksRUFBRSxZQUFZLGNBQWMsMEJBQTBCLFlBQVksRUFBRTtBQUNwSSxZQUFJLE9BQU8saUJBQWlCLEVBQUUsT0FBTyxLQUFLLEVBQUUsS0FBSyxJQUFJLEtBQUs7QUFDMUQ7QUFBQSxNQUNGLEtBQUs7QUFBTyxZQUFJLEVBQUUsT0FBTyxFQUFFLFNBQVMsRUFBRSxVQUFVLFNBQVMsU0FBUyxFQUFFO0FBQUc7QUFBQSxNQUN2RTtBQUFTLFlBQUksT0FBTyxLQUFLLFVBQVUsQ0FBQyxFQUFFLE1BQU0sR0FBRyxHQUFHLEdBQUcsS0FBSztBQUFBLElBQzVEO0FBQUEsRUFDRjtBQUNGO0FBRUEsU0FBUyxNQUFNLFNBQXFCLE9BQWU7QUFDakQsUUFBTSxJQUFJLElBQUk7QUFDZCxRQUFNLGFBQWEsV0FBVyxLQUFLLFdBQVcsV0FBVyxzQkFBc0IsVUFBVSxJQUFJO0FBQzdGLE1BQUksZUFBZSxFQUFHLFlBQVcsS0FBSyxTQUFTLFVBQVU7QUFDekQsTUFBSSxjQUFjO0FBQ2hCLFVBQU0sT0FBTyxJQUFJLFdBQVcsUUFBUSxVQUFVO0FBQzlDLFNBQUssSUFBSSxJQUFJLFdBQVcsUUFBUSxRQUFRLFFBQVEsWUFBWSxRQUFRLFVBQVUsQ0FBQztBQUMvRSxrQkFBYyxLQUFLLElBQUk7QUFDdkIsb0JBQWdCLEtBQUs7QUFDckIsV0FBTyxlQUFlLHFCQUFxQixjQUFjLFNBQVMsR0FBRztBQUNuRSxzQkFBZ0IsY0FBYyxNQUFNLEVBQUc7QUFBQSxJQUN6QztBQUNBO0FBQUEsRUFDRjtBQUNBLE1BQUksQ0FBQyxVQUFVLFdBQVcsUUFBUztBQUNuQyxTQUFPO0FBQ1AsTUFBSSxRQUFRLFFBQVEsRUFBRSxTQUFTLENBQUMsVUFBVTtBQUN4QyxZQUFRLFlBQVk7QUFDcEIsUUFBSSxNQUFNLFNBQVMsS0FBTSxTQUFRLFVBQVU7QUFBQSxFQUM3QztBQUNBLE9BQUssRUFBRSxNQUFNLE9BQU8sS0FBSyxjQUFjLElBQUksV0FBVyxRQUFRLFFBQVEsUUFBUSxZQUFZLFFBQVEsVUFBVSxDQUFDLEVBQUUsR0FBRyxDQUFDO0FBQ3JIO0FBRUEsU0FBUyxRQUFRLEtBQWEsVUFBbUI7QUFDL0MsUUFBTSxLQUFLLElBQUksVUFBVSxHQUFHLFNBQVMsYUFBYSxXQUFXLFFBQVEsSUFBSSxNQUFNLFNBQVMsSUFBSSxRQUFRLFdBQVcsa0JBQWtCLEVBQUUsRUFBRTtBQUNySSxVQUFRLElBQUksS0FBSyxFQUFFO0FBQ25CLE1BQUksU0FBVSxnQkFBZSxJQUFJLEdBQUc7QUFDcEMsTUFBSSxPQUFPLE1BQU0sR0FBRyxhQUFhLE9BQU8sS0FBSyxHQUFHLFdBQVcsZUFBZSxFQUFFLEtBQUssS0FBSztBQUN0RixLQUFHLFNBQVMsTUFBTSxLQUFLLEVBQUUsTUFBTSxXQUFXLElBQUksQ0FBQztBQUMvQyxLQUFHLFlBQVksQ0FBQyxNQUFNLEtBQUssRUFBRSxNQUFNLGNBQWMsS0FBSyxNQUFNLE9BQU8sRUFBRSxTQUFTLFdBQVcsRUFBRSxPQUFPLEdBQUcsQ0FBQztBQUN0RyxLQUFHLFVBQVUsQ0FBQyxNQUFNO0FBQ2xCLFFBQUksUUFBUSxJQUFJLEdBQUcsTUFBTSxNQUFNLFFBQVEsSUFBSSxHQUFHLEVBQUc7QUFDakQsVUFBTSxhQUFhLEVBQUUsUUFBUSxRQUFRLEVBQUUsT0FBTyxPQUFPLEVBQUUsT0FBTyxNQUFPO0FBQ3JFLFNBQUssRUFBRSxNQUFNLGFBQWEsS0FBSyxNQUFNLGFBQWEsU0FBWSxFQUFFLE1BQU0sUUFBUSxFQUFFLFFBQVEsV0FBVyxDQUFDO0FBQUEsRUFDdEc7QUFDRjtBQUdBLGVBQWUsU0FBUyxJQUFZLE1BQWM7QUFDaEQsUUFBTSxRQUFRLElBQUksZ0JBQWdCO0FBQ2xDLFdBQVMsSUFBSSxJQUFJLEtBQUs7QUFDdEIsTUFBSSxPQUFPLFdBQVcsRUFBRSxXQUFNLE9BQU8sU0FBUyxLQUFLLEtBQUssTUFBTSxLQUFLLFNBQVMsSUFBSSxDQUFDLFFBQVEsS0FBSztBQUM5RixNQUFJO0FBQ0YsVUFBTSxXQUFXLE1BQU0sTUFBTSxhQUFhLEVBQUUsUUFBUSxRQUFRLFFBQVEsTUFBTSxRQUFRLFNBQVMsRUFBRSxnQkFBZ0IsbUJBQW1CLEdBQUcsS0FBSyxDQUFDO0FBQ3pJLFFBQUksQ0FBQyxTQUFTLE1BQU0sQ0FBQyxTQUFTLE1BQU07QUFDbEMsWUFBTSxPQUFPLE1BQU0sU0FBUyxLQUFLLEVBQUUsTUFBTSxNQUFNLEVBQUU7QUFDakQsV0FBSyxFQUFFLE1BQU0sV0FBVyxJQUFJLFFBQVEsU0FBUyxRQUFRLE9BQU8sUUFBUSxTQUFTLE1BQU0sR0FBRyxPQUFPLE9BQU8sS0FBSyxRQUFRLFFBQVEsR0FBRyxFQUFFLE1BQU0sR0FBRyxHQUFHLElBQUksRUFBRSxHQUFHLENBQUM7QUFDcEo7QUFBQSxJQUNGO0FBQ0EsVUFBTSxTQUFTLFNBQVMsS0FBSyxZQUFZLElBQUksa0JBQWtCLENBQUMsRUFBRSxVQUFVO0FBQzVFLFFBQUksU0FBUztBQUNiLGVBQVM7QUFDUCxZQUFNLEVBQUUsT0FBTyxLQUFLLElBQUksTUFBTSxPQUFPLEtBQUs7QUFDMUMsVUFBSSxLQUFNO0FBQ1YsZ0JBQVU7QUFDVixVQUFJO0FBQ0osY0FBUSxNQUFNLE9BQU8sUUFBUSxJQUFJLE1BQU0sR0FBRztBQUN4QyxjQUFNRCxRQUFPLE9BQU8sTUFBTSxHQUFHLEdBQUcsRUFBRSxRQUFRLE9BQU8sRUFBRTtBQUNuRCxpQkFBUyxPQUFPLE1BQU0sTUFBTSxDQUFDO0FBQzdCLFlBQUlBLE1BQUssV0FBVyxPQUFPLEVBQUcsTUFBSyxFQUFFLE1BQU0sWUFBWSxJQUFJLE1BQU1BLE1BQUssTUFBTSxDQUFDLEVBQUUsS0FBSyxFQUFFLENBQUM7QUFBQSxNQUN6RjtBQUFBLElBQ0Y7QUFDQSxTQUFLLEVBQUUsTUFBTSxXQUFXLEdBQUcsQ0FBQztBQUFBLEVBQzlCLFNBQVMsS0FBSztBQUNaLFFBQUksQ0FBQyxNQUFNLE9BQU8sUUFBUyxNQUFLLEVBQUUsTUFBTSxXQUFXLElBQUksT0FBUSxJQUFjLFFBQVEsQ0FBQztBQUFBLEVBQ3hGLFVBQUU7QUFDQSxhQUFTLE9BQU8sRUFBRTtBQUFBLEVBQ3BCO0FBQ0Y7QUFFQSxTQUFTLFVBQVUsS0FBYSxRQUFnQjtBQUM5QyxRQUFNLElBQUksS0FBSyxJQUFJLEdBQUc7QUFDdEIsTUFBSSxPQUFPLFVBQVUsR0FBRyxLQUFLLE1BQU0sS0FBSyxLQUFLO0FBQzdDLE1BQUksQ0FBQyxFQUFHO0FBQ1IsT0FBSyxPQUFPLEdBQUc7QUFDZixJQUFFLE1BQU0sTUFBTTtBQUVkLE1BQUksV0FBVyxlQUFlLENBQUMsUUFBUSxZQUFZLEdBQUc7QUFDcEQsU0FBSyxNQUFNLEVBQUUsVUFBVSxPQUFPLGtCQUFrQixnQkFBZ0IsRUFBRSxRQUFRLFFBQVEsTUFBTSxLQUFLLFVBQVUsRUFBRSxNQUFNLFVBQVUsUUFBUSxFQUFFLE9BQU8sQ0FBQyxFQUFFLENBQUM7QUFBQSxFQUNoSjtBQUNGO0FBR0EsZUFBZSxTQUFTLEdBQVk7QUFDbEMsUUFBTSxJQUFJLEtBQUssSUFBSSxFQUFFLEdBQUc7QUFDeEIsTUFBSSxPQUFPLFNBQVMsRUFBRSxHQUFHLEtBQUssRUFBRSxJQUFJLElBQUksS0FBSztBQUM3QyxNQUFJLFFBQVEsWUFBWSxFQUFHO0FBQzNCLFFBQU0sS0FBSyxLQUFLLFFBQ2IsTUFBTSxNQUFNLEVBQUUsVUFBVSxPQUFPLGlCQUFpQixpQkFBaUIsRUFBRSxRQUFRLFFBQVEsTUFBTSxLQUFLLFVBQVUsRUFBRSxNQUFNLFVBQVUsUUFBUSxFQUFFLFFBQVEsTUFBTSxFQUFFLFFBQVEsQ0FBQyxFQUFFLENBQUMsRUFBRSxLQUFLLENBQUMsTUFBTSxFQUFFLElBQUksTUFBTSxLQUFLO0FBQ2xNLE1BQUksQ0FBQyxHQUFJLE1BQUssRUFBRSxNQUFNLG9CQUFvQixLQUFLLEVBQUUsS0FBSyxNQUFNLEVBQUUsS0FBSyxDQUFDO0FBQUEsTUFDL0QsT0FBTSxHQUFHLEVBQUUsVUFBVSxPQUFPLHFCQUFxQixRQUFRLG9DQUFvQztBQUNwRztBQUVBLGVBQWUsS0FBSyxHQUFZO0FBQzlCLE1BQUksRUFBRSxTQUFTLFFBQVE7QUFDckIsUUFBSSxPQUFPLGFBQWEsRUFBRSxJQUFJLElBQUksS0FBSyxVQUFVLEVBQUUsSUFBSSxDQUFDLElBQUksS0FBSztBQUNqRSxVQUFNLFNBQVMsRUFBRSxTQUFTLGNBQWMsZ0JBQWlCLGNBQWMsT0FBTyxFQUFFLE1BQU0sU0FBUyxXQUFXLENBQUUsTUFDeEcsRUFBRSxTQUFTLGFBQWMsRUFBRSxNQUFNLFVBQVUsUUFBUSxhQUFhLFlBQWE7QUFDakYsZUFBVyxNQUFNLEtBQUssRUFBRSxNQUFNLGVBQWUsS0FBSyxFQUFFLEtBQUssTUFBTSxPQUFPLENBQUMsR0FBRyxHQUFHO0FBQzdFO0FBQUEsRUFDRjtBQUNBLFFBQU0sUUFBUSxFQUFFLFVBQVUsT0FBTyxPQUFPO0FBQ3hDLFFBQU0sZ0JBQWdCO0FBQ3RCLE1BQUksT0FBTyxHQUFHLEtBQUssSUFBSSxFQUFFLFdBQVcsY0FBYyxNQUFNLEtBQUssRUFBRSxLQUFLLElBQUksRUFBRSxVQUFVLE9BQU8sRUFBRSxPQUFPLEtBQUssRUFBRSxLQUFLLEVBQUUsT0FBTyxJQUFJLEtBQUs7QUFDbEksUUFBTSxRQUFRLElBQUksZ0JBQWdCO0FBQ2xDLE9BQUssSUFBSSxFQUFFLEtBQUssRUFBRSxPQUFPLE9BQU8sUUFBUSxFQUFFLE9BQU8sQ0FBQztBQUNsRCxRQUFNLE9BQU8sQ0FBQyxNQUFjLFNBQVMsVUFBVTtBQUM3QyxRQUFJLENBQUMsS0FBSyxJQUFJLEVBQUUsR0FBRyxFQUFHO0FBQ3RCLFNBQUssT0FBTyxFQUFFLEdBQUc7QUFDakIsVUFBTSxPQUFPLE1BQU0sSUFBSSxFQUFFLE1BQU07QUFDL0IsVUFBTSxRQUFRLE9BQU8sT0FBTyxFQUFFLE9BQU8sTUFBTSxRQUFRLEVBQUUsUUFBUSxhQUFhO0FBQzFFLFdBQU8sR0FBRyxVQUFVLE9BQU8sT0FBTyxRQUFRLFNBQU0sRUFBRSxLQUFLLElBQUksSUFBSTtBQUMvRCxRQUFJLENBQUMsUUFBUTtBQUFFLGVBQVMsYUFBYSxNQUFNLEdBQUcsVUFBVSxPQUFPLE9BQU8sUUFBUSxTQUFNLEVBQUUsS0FBSyxFQUFFO0FBQUcsaUJBQVc7QUFBQSxJQUFNO0FBQ2pILFFBQUksTUFBTTtBQUFFLFdBQUssV0FBVztBQUFPLGdCQUFVO0FBQUEsSUFBRztBQUNoRCxTQUFLLEVBQUUsTUFBTSxlQUFlLEtBQUssRUFBRSxLQUFLLE1BQU0sT0FBTyxDQUFDO0FBQUEsRUFDeEQ7QUFDQSxNQUFJLFFBQVEsWUFBWSxHQUFHO0FBQ3pCLFVBQU0sUUFBUSxXQUFXLE1BQU0sS0FBSyxTQUFTLFVBQVUsT0FBTyxPQUFPLFFBQVEsaUJBQVksRUFBRSxPQUFPLG1DQUE4QixHQUFHLE9BQU8sRUFBb0IsV0FBVyxFQUFFLEtBQUssSUFBSSxHQUFJO0FBQ3hMLFVBQU0sT0FBTyxVQUFVLE1BQU0sYUFBYSxLQUFLO0FBQy9DO0FBQUEsRUFDRjtBQUNBLE1BQUk7QUFDRixVQUFNLFdBQVcsTUFBTSxNQUFNLFVBQVUsT0FBTyxXQUFXLFdBQVc7QUFBQSxNQUNsRSxRQUFRO0FBQUEsTUFBUSxRQUFRLE1BQU07QUFBQSxNQUFRLFNBQVMsRUFBRSxnQkFBZ0IsbUJBQW1CO0FBQUEsTUFDcEYsTUFBTSxLQUFLLFVBQVUsRUFBRSxNQUFNLFVBQVUsUUFBUSxFQUFFLFFBQVEsVUFBVSxFQUFFLFVBQVUsU0FBUyxFQUFFLFNBQVMsT0FBTyxFQUFFLE9BQU8sU0FBUyxFQUFFLFNBQVMsU0FBUyxFQUFFLFNBQVMsV0FBVyxTQUFTLENBQUM7QUFBQSxJQUNsTCxDQUFDO0FBQ0QsUUFBSSxDQUFDLFNBQVMsTUFBTSxDQUFDLFNBQVMsS0FBTSxPQUFNLElBQUksTUFBTSxRQUFRLFNBQVMsTUFBTSxFQUFFO0FBQzdFLFVBQU0sU0FBUyxTQUFTLEtBQUssWUFBWSxJQUFJLGtCQUFrQixDQUFDLEVBQUUsVUFBVTtBQUM1RSxRQUFJLFNBQVM7QUFDYixlQUFTO0FBQ1AsWUFBTSxFQUFFLE9BQU8sTUFBTSxTQUFTLElBQUksTUFBTSxPQUFPLEtBQUs7QUFDcEQsVUFBSSxTQUFVO0FBQ2QsZ0JBQVU7QUFDVixVQUFJO0FBQ0osY0FBUSxNQUFNLE9BQU8sUUFBUSxNQUFNLE1BQU0sR0FBRztBQUMxQyxjQUFNLFFBQVEsT0FBTyxNQUFNLEdBQUcsR0FBRztBQUNqQyxpQkFBUyxPQUFPLE1BQU0sTUFBTSxDQUFDO0FBQzdCLGNBQU0sUUFBUSxNQUFNLE1BQU0sZ0JBQWdCLElBQUksQ0FBQztBQUMvQyxZQUFJLENBQUMsTUFBTztBQUNaLGNBQU0sT0FBTyxLQUFLLE1BQU0sTUFBTSxNQUFNLGVBQWUsSUFBSSxDQUFDLEtBQUssSUFBSTtBQUNqRSxZQUFJLFVBQVUsV0FBWSxNQUFLLEVBQUUsTUFBTSxpQkFBaUIsTUFBTSxFQUFFLFFBQVEsTUFBTSxLQUFLLEtBQUssQ0FBQztBQUFBLGlCQUNoRixVQUFVLFVBQVU7QUFBRSxnQkFBTSxPQUFPLE1BQU0sSUFBSSxFQUFFLE1BQU07QUFBRyxjQUFJLE1BQU07QUFBRSxpQkFBSyxTQUFTLEtBQUs7QUFBUSxzQkFBVTtBQUFBLFVBQUc7QUFBQSxRQUFFLFdBQzlHLFVBQVUsWUFBWTtBQUM3QixnQkFBTSxPQUFPLE1BQU0sSUFBSSxFQUFFLE1BQU07QUFDL0IsY0FBSSxNQUFNO0FBQUUsaUJBQUssV0FBVyxFQUFFLFNBQVMsS0FBSyxRQUFRO0FBQUcsc0JBQVUsSUFBSTtBQUFBLFVBQUc7QUFDeEUsZ0JBQU0sdUJBQXVCLEtBQUssUUFBUSxNQUFNLEdBQUcsRUFBRSxDQUFDLEVBQUU7QUFDeEQsaUJBQU8sZUFBWSxFQUFFLEtBQUssd0JBQXdCLEtBQUssT0FBTztBQUM5RCxnQkFBTSxJQUFJLGFBQWE7QUFBQSxRQUN6QixXQUNTLFVBQVUsU0FBVSxNQUFLLEtBQUssTUFBTSxLQUFLLE1BQU07QUFBQSxpQkFDL0MsVUFBVSxTQUFTO0FBQUUsZUFBSyxPQUFPLEVBQUUsR0FBRztBQUFHLGVBQUssRUFBRSxNQUFNLGNBQWMsS0FBSyxFQUFFLEtBQUssU0FBUyxLQUFLLFFBQVEsQ0FBQztBQUFBLFFBQUc7QUFBQSxNQUNySDtBQUFBLElBQ0Y7QUFDQSxRQUFJLEtBQUssSUFBSSxFQUFFLEdBQUcsR0FBRztBQUFFLFdBQUssT0FBTyxFQUFFLEdBQUc7QUFBRyxXQUFLLEVBQUUsTUFBTSxjQUFjLEtBQUssRUFBRSxLQUFLLFNBQVMsZ0RBQWdELENBQUM7QUFBQSxJQUFHO0FBQUEsRUFDakosU0FBUyxLQUFLO0FBQ1osUUFBSSxDQUFDLE1BQU0sT0FBTyxXQUFXLEtBQUssSUFBSSxFQUFFLEdBQUcsR0FBRztBQUFFLFdBQUssT0FBTyxFQUFFLEdBQUc7QUFBRyxXQUFLLEVBQUUsTUFBTSxjQUFjLEtBQUssRUFBRSxLQUFLLFNBQVUsSUFBYyxRQUFRLENBQUM7QUFBQSxJQUFHO0FBQUEsRUFDako7QUFDRjtBQUVBLFNBQVMsYUFBYTtBQUNwQixRQUFNLE1BQU0sUUFBUSxLQUFLO0FBQ3pCLFNBQU8sRUFBRSxrQkFBa0IsS0FBSyxrQkFBa0IsS0FBSyxpQkFBaUIsSUFBSTtBQUM5RTtBQUVBLFNBQVMsY0FBYyxJQUFZLFVBQWtCLE1BQU0sR0FBRyxNQUFNLE1BQWM7QUFDaEYsUUFBTSxJQUFJLE9BQU8sRUFBb0IsRUFBRSxFQUFFLEtBQUs7QUFDOUMsU0FBTyxPQUFPLFNBQVMsQ0FBQyxJQUFJLEtBQUssSUFBSSxLQUFLLEtBQUssSUFBSSxLQUFLLENBQUMsQ0FBQyxJQUFJO0FBQ2hFO0FBRUEsU0FBUyxxQkFBcUI7QUFDNUIsTUFBSTtBQUNGLFVBQU0sUUFBUSxLQUFLLE1BQU0sRUFBdUIsUUFBUSxFQUFFLEtBQUs7QUFDL0QsUUFBSSxDQUFDLFNBQVMsT0FBTyxVQUFVLFVBQVU7QUFDdkMsYUFBTyxFQUFFLGdCQUFnQixNQUF1QixjQUFjLE9BQU8sV0FBVyxPQUFPLFlBQVksT0FBTyxxQkFBcUIsTUFBTTtBQUFBLElBQ3ZJO0FBQ0EsVUFBTSxpQkFBaUIsT0FBTyxNQUFNLGFBQWEsWUFBWSxNQUFNLGFBQWEsUUFBUSxNQUFNLFdBQVc7QUFDekcsVUFBTSxNQUFNLE1BQU0sT0FBTyxPQUFPLE1BQU0sUUFBUSxXQUFXLE1BQU0sTUFBTTtBQUNyRSxXQUFPO0FBQUEsTUFDTDtBQUFBLE1BQ0EsY0FBYyxNQUFNLGNBQWM7QUFBQSxNQUNsQyxXQUFXLE1BQU0sZ0JBQWdCO0FBQUEsTUFDakMsWUFBWSxNQUFNLGlCQUFpQjtBQUFBLE1BQ25DLHFCQUFxQixPQUFPLFFBQVEsSUFBSSxrQkFBa0I7QUFBQSxJQUM1RDtBQUFBLEVBQ0YsUUFBUTtBQUNOLFdBQU8sRUFBRSxnQkFBZ0IsTUFBdUIsY0FBYyxPQUFPLFdBQVcsT0FBTyxZQUFZLE9BQU8scUJBQXFCLE1BQU07QUFBQSxFQUN2STtBQUNGO0FBRUEsU0FBUyxhQUFzQztBQUM3QyxRQUFNLFFBQVEsS0FBSyxNQUFNLEVBQXVCLFFBQVEsRUFBRSxLQUFLO0FBQy9ELFFBQU0sU0FBa0M7QUFBQSxJQUN0QyxPQUFPLE9BQU87QUFBQSxJQUFPLEtBQUssT0FBTyxVQUFVLFdBQVcsV0FBVztBQUFBLElBQVUsUUFBTyxvQkFBSSxLQUFLLEdBQUUsWUFBWSxFQUFFLE1BQU0sR0FBRyxFQUFFO0FBQUEsSUFDdEgsR0FBRztBQUFBLElBQU8sT0FBTyxRQUFRLE9BQU87QUFBQSxFQUNsQztBQUNBLE1BQUksUUFBUSxLQUFLLEVBQUcsUUFBTyxRQUFRO0FBQ25DLE1BQUksTUFBTSxVQUFVLE9BQVcsUUFBTyxRQUFRLEVBQXFCLE9BQU8sRUFBRTtBQUM1RSxNQUFJLE9BQU8sYUFBYSxPQUFXLFFBQU8sV0FBVyxDQUFDLFVBQVUsSUFBSTtBQUVwRSxNQUFJLE9BQU8sWUFBWSxVQUFhLE9BQU8sYUFBYSxNQUFPLFFBQU8sVUFBVTtBQUVoRixNQUFJLE9BQU8sY0FBYyxVQUFhLE9BQU8sYUFBYSxNQUFPLFFBQU8sWUFBWTtBQUNwRixNQUFJLFFBQVEsUUFBUSxNQUFNLE9BQU8sTUFBTSxRQUFRLFlBQVksTUFBTSxPQUFPLGdCQUFnQixPQUFXLFFBQU8sY0FBYyxFQUFFLFVBQVUsT0FBTyxNQUFNLENBQUMsRUFBRTtBQUNwSixNQUFJLFFBQVEsVUFBVSxLQUFLLE9BQU8saUJBQWlCLE9BQU8sYUFBYSxPQUFXLFFBQU8sV0FBVyxFQUFFLE9BQU8sT0FBTyxjQUFjO0FBRWxJLFFBQU0sU0FBUyxPQUFPLE1BQU0sYUFBYSxZQUFZLE1BQU0sYUFBYTtBQUN4RSxNQUFJLENBQUMsUUFBUTtBQUNYLFVBQU0sWUFBWSxFQUFxQixXQUFXLEVBQUU7QUFDcEQsUUFBSSxNQUFNLGNBQWMsV0FBYyxjQUFjLFlBQVksY0FBYyxTQUFTO0FBQ3JGLGFBQU8sWUFBWTtBQUFBLFFBQ2pCLE1BQU07QUFBQSxRQUNOLFdBQVcsY0FBYyxtQkFBbUIsR0FBRyxHQUFHLEVBQUU7QUFBQSxRQUNwRCxRQUFRLGNBQWMsZUFBZSxHQUFHLEdBQUcsRUFBRTtBQUFBLFFBQzdDLGVBQWUsY0FBYyx1QkFBdUIsSUFBSSxHQUFHLEVBQUU7QUFBQSxRQUM3RCxjQUFjO0FBQUEsUUFDZCxtQkFBbUI7QUFBQSxNQUNyQjtBQUFBLElBQ0Y7QUFDQSxRQUFJLE1BQU0sZ0JBQWdCLFFBQVc7QUFDbkMsYUFBTyxjQUFjLGNBQWMsZ0JBQWdCLGNBQWMsU0FBUyxLQUFLLEtBQUssR0FBRyxJQUFJO0FBQUEsSUFDN0Y7QUFDQSxRQUFJLGNBQWMsVUFBVSxNQUFNLGlCQUFpQixRQUFXO0FBQzVELGFBQU8sZUFBZTtBQUFBLElBQ3hCO0FBQ0EsVUFBTSxXQUFXLE1BQU0sT0FBTyxPQUFPLE1BQU0sUUFBUSxXQUFZLE1BQU0sTUFBa0M7QUFDdkcsU0FBSyxDQUFDLFlBQVksU0FBUyxrQkFBa0IsWUFBZSxRQUFRLFlBQVksS0FBSyxjQUFjLFNBQVM7QUFDMUcsYUFBTyxNQUFNLEVBQUUsUUFBUSxHQUFHLEdBQUksWUFBWSxDQUFDLEdBQUksZUFBZSxPQUFPO0FBQUEsSUFDdkU7QUFBQSxFQUNGO0FBQ0EsU0FBTztBQUNUO0FBR0EsZUFBZSxNQUFNLFVBQVUsT0FBTyxRQUFRLE9BQXlCO0FBQ3JFLE1BQUksZ0JBQWdCLE9BQVEsUUFBTztBQUNuQyxpQkFBZTtBQUNmLE1BQUk7QUFDRixVQUFNO0FBQ04sUUFBSSxPQUFRLFFBQU87QUFDbkIsUUFBSTtBQUNKLFFBQUk7QUFDRixjQUFRLFdBQVc7QUFBQSxJQUNyQixTQUFTLEtBQUs7QUFDWixZQUFNLDZDQUE4QyxJQUFjLE9BQU8sRUFBRTtBQUMzRSxhQUFPO0FBQUEsSUFDVDtBQUNBLFFBQUksT0FBTztBQUNULFVBQUksQ0FBQyxPQUFPLFdBQVc7QUFBRSxjQUFNLHNFQUFzRTtBQUFHLGVBQU87QUFBQSxNQUFPO0FBQ3RILGNBQVEsRUFBRSxHQUFHLE9BQU8sUUFBUSxRQUFRLE9BQU8sTUFBTTtBQUNqRCxhQUFPLE1BQU07QUFBQSxJQUNmO0FBQ0EsTUFBcUIsTUFBTSxFQUFFLFdBQVc7QUFDeEMsTUFBcUIsV0FBVyxFQUFFLFdBQVc7QUFDN0MsUUFBSSxrQkFBa0IsVUFBVSxhQUFhLGVBQWUsVUFBVyxNQUFLLGFBQWEsa0JBQWtCLEVBQUUsTUFBTSxNQUFNO0FBQUEsSUFBQyxDQUFDO0FBQzNILFFBQUk7QUFDSixRQUFJO0FBQ0YsVUFBSSxDQUFDLE1BQU8sT0FBTSxNQUFNLEtBQUs7QUFDN0IsbUJBQWEsTUFBTSxTQUFTO0FBQUEsSUFDOUIsVUFBRTtBQUNBLFFBQXFCLE1BQU0sRUFBRSxXQUFXO0FBQ3hDLFFBQXFCLFdBQVcsRUFBRSxXQUFXO0FBQUEsSUFDL0M7QUFDQSxRQUFJLE9BQVEsUUFBTztBQUNuQixXQUFPO0FBQ1AsUUFBSSxPQUFPO0FBQ1QscUJBQWU7QUFDZixzQkFBZ0IsQ0FBQztBQUNqQixxQkFBZTtBQUNmLFVBQUksVUFBVyxPQUFNLFFBQVE7QUFBQSxJQUMvQjtBQUNBLGFBQVMsUUFBUSxTQUFTO0FBQzFCLGVBQVc7QUFDWCxNQUFFLFNBQVMsRUFBRSxjQUFjLEtBQUs7QUFDaEMsTUFBRSxLQUFLLEVBQUUsWUFBWTtBQUNyQixRQUFJLENBQUMsVUFBVSxNQUFNLE9BQU8sS0FBSyxFQUFFLFlBQVksRUFBRSxvQkFBb0IsR0FBSSxNQUFLLGtCQUFjLG9CQUFJLEtBQUssR0FBRSxtQkFBbUIsQ0FBQyxFQUFFO0FBQzdILGVBQVcsSUFBSTtBQUNmLFVBQU0sTUFBTTtBQUNaLG9CQUFnQixFQUFFO0FBQ2xCLGNBQVU7QUFDVixhQUFTLEVBQUUsS0FBSyxHQUFHLE1BQU0sR0FBRyxNQUFNLEVBQUU7QUFDcEMsWUFBUSxRQUFRLENBQUM7QUFDakIsZ0JBQVksSUFBSTtBQUNoQixZQUFRLE1BQU0sVUFBVTtBQUN4QixVQUFNLFNBQVMsTUFBTSxPQUFPLE9BQU8sTUFBTSxRQUFRLFdBQVksTUFBTSxNQUFrQztBQUNyRyx3QkFBb0IsT0FBTyxRQUFRLGtCQUFrQixXQUFXLE9BQU8sZ0JBQWdCO0FBQ3ZGLHNCQUFrQjtBQUdsQixRQUFJLE9BQU87QUFBRSxVQUFJLEtBQUssU0FBUyxLQUFLLE1BQU0sWUFBWSxPQUFXLE9BQU0sVUFBVTtBQUFBLElBQU0sV0FDOUUsV0FBVyxNQUFNLFlBQVksT0FBVyxPQUFNLFVBQVUsYUFBYTtBQUFBLGFBQ3JFLENBQUMsUUFBUyxRQUFPLENBQUM7QUFDM0IsUUFBSSxXQUFXLENBQUMsTUFBTyxRQUFPLGFBQWE7QUFDM0MsZUFBVztBQUNYLGVBQVc7QUFDWCxzQkFBa0IsS0FBSztBQUN2QixlQUFXLElBQUcsb0JBQUksS0FBSyxHQUFFLFlBQVksRUFBRSxRQUFRLFNBQVMsR0FBRyxDQUFDLElBQUksUUFBUSxTQUFTLEtBQUssSUFBSSxLQUFLLE9BQU87QUFDdEcsVUFBTSxVQUFVLEtBQUssTUFBTSxLQUFLLE9BQU8sS0FBSyxVQUFVLEtBQUssR0FBRyxJQUFJLENBQUMsQ0FBQztBQUNwRSxhQUFTLFFBQVE7QUFDakIsUUFBSSxDQUFDLE9BQU87QUFDVixvQkFBYyxJQUFJO0FBQ2xCLFFBQXFCLEtBQUssRUFBRSxXQUFXO0FBQUEsSUFDekM7QUFDQSxNQUFxQixNQUFNLEVBQUUsV0FBVztBQUN4QyxNQUFFLEtBQUssRUFBRSxVQUFVLE9BQU8sU0FBUyxLQUFLO0FBQ3hDLElBQUFDLEtBQUksUUFBUSxRQUFRO0FBQ3BCLGVBQVc7QUFDWCxhQUFTLE9BQU8sWUFBWSxNQUFNO0FBQ2hDLFdBQUssRUFBRSxNQUFNLE9BQU8sQ0FBQztBQUNyQixZQUFNLFFBQVEsU0FBUyxDQUFDLFVBQVUsSUFBSSxNQUFNO0FBQzVDLFlBQU0sV0FBVyxLQUFLLElBQUksR0FBRyxRQUFRLEVBQUU7QUFDdkMsUUFBRSxNQUFNLEVBQUUsTUFBTSxVQUFVLE9BQU8sUUFBUTtBQUN6QyxRQUFFLE1BQU0sRUFBRSxNQUFNLFlBQVksVUFBVSxJQUFJLFdBQVcsTUFBTSxRQUFRLENBQUMsQ0FBQztBQUNyRSxRQUFFLFFBQVEsRUFBRSxjQUFjLE9BQU8sT0FBTyxHQUFHLGNBQVcsT0FBTyxJQUFJLGdCQUFhLE9BQU8sSUFBSSxnQkFBYSxNQUFNLE9BQU8sUUFBUSxDQUFDLENBQUM7QUFDN0gsaUJBQVc7QUFBQSxJQUNiLEdBQUcsR0FBRztBQUNOLGlCQUFhLE9BQU8sWUFBWSxNQUFNO0FBQUUsV0FBSyxVQUFVO0FBQUcsV0FBSyxLQUFLO0FBQUcsZ0JBQVU7QUFBQSxJQUFHLEdBQUcsR0FBSTtBQUMzRixTQUFLLEtBQUs7QUFDVixRQUFJLENBQUMsT0FBTztBQUNWLGdCQUFVLE1BQU07QUFDaEIsWUFBTSxnQkFBZ0I7QUFBQSxJQUN4QjtBQUNBLFdBQU87QUFBQSxFQUNULFVBQUU7QUFDQSxtQkFBZTtBQUFBLEVBQ2pCO0FBQ0Y7QUFHQSxlQUFlLGFBQWE7QUFDMUIsTUFBSSxVQUFVLFdBQVcsU0FBUztBQUFFLFdBQU87QUFBRztBQUFBLEVBQVE7QUFDdEQsTUFBSSxRQUFRO0FBRVYsUUFBSSxDQUFDLEdBQUcsTUFBTSxPQUFPLENBQUMsRUFBRSxLQUFLLENBQUMsTUFBTSxFQUFFLEVBQUUsVUFBVSxTQUFTLEdBQUc7QUFBRSxZQUFNLDZFQUE2RTtBQUFHO0FBQUEsSUFBUTtBQUM5SixTQUFLLEVBQUUsTUFBTSxPQUFPLENBQUM7QUFDckIsVUFBTSxNQUFNLElBQUk7QUFDaEI7QUFBQSxFQUNGO0FBQ0EsUUFBTSxNQUFNO0FBQ2Q7QUFFQSxTQUFTLFNBQVM7QUFDaEIsTUFBSSxPQUFRLE1BQUssRUFBRSxNQUFNLFFBQVEsU0FBUyxlQUFlLENBQUM7QUFDNUQ7QUFFQSxTQUFTLE1BQU07QUFDYixTQUFPLGNBQWMsTUFBTTtBQUMzQixTQUFPLGNBQWMsVUFBVTtBQUMvQixZQUFVLEtBQUs7QUFDZixrQkFBZ0I7QUFDaEIsNEJBQTBCO0FBQzFCLGtCQUFnQjtBQUNoQixvQkFBa0I7QUFDbEIsaUJBQWU7QUFDZixrQkFBZ0IsQ0FBQztBQUNqQixpQkFBZTtBQUNmLFFBQU0sYUFBYTtBQUNuQixRQUFNLGVBQWU7QUFDckIsV0FBUztBQUNULFdBQVMsVUFBVSxZQUFZLFlBQVksRUFBRSxLQUFLLE1BQU07QUFBRSxRQUFJLGdCQUFnQixXQUFZLGNBQWEsUUFBUSxVQUFVO0FBQUcsY0FBVTtBQUFHLGVBQVc7QUFBQSxFQUFHLENBQUM7QUFDeEosTUFBSSxXQUFXO0FBQ2IsVUFBTSxhQUFhO0FBQ25CLGVBQVcsTUFBTTtBQUNqQixTQUFLLE1BQU0sVUFBVSxPQUFPLFdBQVcsQ0FBQyxFQUFFLE1BQU0sQ0FBQyxRQUFRO0FBQ3ZELFVBQUksU0FBUyxvQkFBb0IsSUFBSSxPQUFPLElBQUksS0FBSztBQUNyRCxZQUFNLG9CQUFvQixJQUFJLE9BQU8sRUFBRTtBQUN2QyxXQUFLLFFBQVEsS0FBSztBQUFBLElBQ3BCLENBQUM7QUFBQSxFQUNILE9BQU87QUFDTCxVQUFNLEtBQUs7QUFDWCxvQkFBZ0I7QUFBQSxFQUNsQjtBQUNBLGFBQVcsTUFBTSxRQUFRLE9BQU8sRUFBRyxJQUFHLE1BQU07QUFDNUMsVUFBUSxNQUFNO0FBQ2QsYUFBVyxLQUFLLEtBQUssT0FBTyxFQUFHLEdBQUUsTUFBTSxNQUFNO0FBQzdDLE9BQUssTUFBTTtBQUNYLGFBQVcsS0FBSyxTQUFTLE9BQU8sRUFBRyxHQUFFLE1BQU07QUFDM0MsV0FBUyxNQUFNO0FBQ2YsYUFBVztBQUNYLGdCQUFjLEtBQUs7QUFDbkIsYUFBVyxNQUFNLENBQUMsT0FBTyxNQUFNLEVBQUcsR0FBcUIsRUFBRSxFQUFFLFdBQVc7QUFDdEUsSUFBRSxNQUFNLEVBQUUsTUFBTSxVQUFVO0FBQzFCLElBQUUsTUFBTSxFQUFFLE1BQU0sWUFBWTtBQUM1QixJQUFFLFNBQVMsRUFBRSxTQUFTO0FBQ3RCLElBQUUsU0FBUyxFQUFFLFNBQVM7QUFDdEIsV0FBUyxLQUFLLFFBQVEsUUFBUSxZQUFZLFVBQVU7QUFDcEQsV0FBUyxLQUFLLFVBQVUsT0FBTyxZQUFZO0FBQzNDLG9CQUFrQixLQUFLLFNBQVMsQ0FBQztBQUNqQyxPQUFLLFlBQVk7QUFDakIsYUFBVztBQUNiO0FBRUEsU0FBUyxTQUFTLE9BQWdCO0FBQ2hDLE1BQUksQ0FBQyxVQUFVLFVBQVUsTUFBTztBQUNoQyxVQUFRO0FBQ1IsSUFBRSxLQUFLLEVBQUUsVUFBVSxPQUFPLFNBQVMsS0FBSztBQUN4QyxPQUFLLEVBQUUsTUFBTSxRQUFRLFNBQVMsU0FBUyxDQUFDO0FBQ3hDLGFBQVc7QUFDYjtBQUdBLGVBQWUsVUFBVSxLQUFLLFFBQVEsYUFBYSxNQUFNO0FBQ3ZELE1BQUksQ0FBQyxjQUFjLENBQUMsTUFBTSxDQUFDLFFBQVEsT0FBTyxFQUFHO0FBQzdDLFFBQU0sT0FBTyxLQUFLLE1BQU0sV0FBVyxNQUFNLEVBQUUsQ0FBQztBQUM1QyxNQUFJLENBQUMsS0FBTTtBQUNYLFFBQU0sUUFBa0IsQ0FBQztBQUN6QixNQUFJLEtBQUssT0FBUSxPQUFNLEtBQUssS0FBSyxVQUFVLEVBQUUsU0FBUyxLQUFLLFNBQVMsUUFBUSxLQUFLLFFBQVEsT0FBTyxLQUFLLE1BQU0sQ0FBQyxDQUFDO0FBQzdHLGFBQVcsS0FBSyxLQUFLLE9BQVEsT0FBTSxLQUFLLEtBQUssVUFBVSxDQUFDLENBQUM7QUFDekQsTUFBSSxNQUFNLFdBQVcsRUFBRztBQUN4QixRQUFNLE1BQU0sZ0JBQWdCLG1CQUFtQixRQUFRLENBQUMsVUFBVSxFQUFFLFFBQVEsUUFBUSxNQUFNLE1BQU0sS0FBSyxJQUFJLElBQUksS0FBSyxDQUFDLEVBQUUsTUFBTSxNQUFNO0FBQUEsRUFBQyxDQUFDO0FBQ25JLElBQUUsV0FBVyxFQUFFLGNBQWMsU0FBUyxRQUFRO0FBQ2hEO0FBS0EsSUFBTSxZQUFOLE1BQWdCO0FBQUEsRUFBaEI7QUFDRSxTQUFRLE1BQVc7QUFDbkIsU0FBUSxLQUFLO0FBQ2IsU0FBUSxXQUFXLEVBQUUsTUFBTSxDQUFDLEdBQWUsUUFBUSxDQUFDLEdBQWUsV0FBVyxDQUFDLEVBQWM7QUFBQTtBQUFBLEVBRTdGLElBQUksWUFBcUI7QUFDdkIsV0FBTyw2QkFBNkIsVUFBVSx1QkFBdUI7QUFBQSxFQUN2RTtBQUFBLEVBRUEsUUFBUTtBQUNOLFFBQUksQ0FBQyxRQUFRLFVBQVUsS0FBSyxDQUFDLEtBQUssYUFBYSxDQUFDLEtBQU07QUFDdEQsU0FBSyxXQUFXLEtBQUssTUFBTSxLQUFLLFNBQVMsQ0FBQyxFQUFFO0FBQzVDLFVBQU0sY0FBZSxPQUFlLHFCQUFzQixPQUFlO0FBQ3pFLFNBQUssTUFBTSxJQUFJLFlBQVk7QUFDM0IsU0FBSyxJQUFJLGFBQWE7QUFDdEIsU0FBSyxJQUFJLGlCQUFpQjtBQUMxQixTQUFLLElBQUksT0FBTyxVQUFVLFlBQVk7QUFDdEMsU0FBSyxJQUFJLFdBQVcsQ0FBQyxNQUFXO0FBQzlCLGVBQVMsSUFBSSxFQUFFLGFBQWEsSUFBSSxFQUFFLFFBQVEsUUFBUSxLQUFLO0FBQ3JELGNBQU0sT0FBTyxFQUFFLFFBQVEsQ0FBQyxFQUFFLENBQUMsRUFBRTtBQUM3QixjQUFNLFVBQVUsVUFBVSxNQUFNLEtBQUssVUFBVSxDQUFDLGFBQWEsVUFBVSxPQUFPLENBQUM7QUFDL0UsWUFBSSxZQUFZLFVBQVUsTUFBTSxTQUFTLE1BQU07QUFDN0MsY0FBSSxPQUFPLG9CQUFvQixJQUFJLElBQUksS0FBSztBQUM1QyxnQkFBTSxlQUFVLEtBQUssS0FBSyxDQUFDLGlCQUFZO0FBQ3ZDLGVBQUssRUFBRSxNQUFNLFlBQVksQ0FBQztBQUFBLFFBQzVCLFdBQVcsWUFBWSxlQUFlLEVBQUUsUUFBUSxDQUFDLEVBQUUsU0FBUztBQUMxRCxjQUFJLE9BQU8scUJBQXFCLElBQUksSUFBSSxLQUFLO0FBQzdDLGVBQUssRUFBRSxNQUFNLFlBQVksQ0FBQztBQUMxQixlQUFLLEVBQUUsTUFBTSxZQUFZLENBQUM7QUFBQSxRQUM1QixXQUFXLFlBQVksWUFBWSxFQUFFLFFBQVEsQ0FBQyxFQUFFLFNBQVM7QUFDdkQsY0FBSSxPQUFPLGtCQUFrQixJQUFJLElBQUksS0FBSztBQUMxQyxpQkFBTztBQUFBLFFBQ1Q7QUFBQSxNQUNGO0FBQUEsSUFDRjtBQUNBLFNBQUssSUFBSSxRQUFRLE1BQU07QUFBRSxVQUFJLEtBQUssR0FBSSxZQUFXLE1BQU07QUFBRSxZQUFJO0FBQUUsZUFBSyxLQUFLLE1BQU07QUFBQSxRQUFHLFFBQVE7QUFBQSxRQUFDO0FBQUEsTUFBRSxHQUFHLEdBQUc7QUFBQSxJQUFHO0FBQ3RHLFNBQUssSUFBSSxVQUFVLENBQUMsTUFBVztBQUFFLFVBQUksRUFBRSxVQUFVLGNBQWUsTUFBSyxLQUFLO0FBQUEsSUFBTztBQUNqRixTQUFLLEtBQUs7QUFDVixRQUFJO0FBQUUsV0FBSyxJQUFJLE1BQU07QUFBQSxJQUFHLFFBQVE7QUFBQSxJQUFDO0FBQUEsRUFDbkM7QUFBQSxFQUVBLE9BQU87QUFDTCxTQUFLLEtBQUs7QUFDVixRQUFJO0FBQUUsV0FBSyxLQUFLLEtBQUs7QUFBQSxJQUFHLFFBQVE7QUFBQSxJQUFDO0FBQ2pDLFNBQUssTUFBTTtBQUFBLEVBQ2I7QUFDRjtBQUNBLElBQU0sWUFBWSxJQUFJLFVBQVU7QUFLaEMsZUFBZSxrQkFBa0I7QUFDL0IsUUFBTSxlQUFlLFFBQVEsTUFBTSxDQUFDLFNBQVMsV0FBVyxXQUFXLEtBQUssVUFBVTtBQUNwRjtBQUVBLFNBQVMsa0JBQWtCO0FBQ3pCLGlCQUFlLFFBQVE7QUFDekI7QUFFQSxTQUFTLG9CQUEwQztBQUNqRCxRQUFNLFNBQVMsUUFBUSxjQUFjLENBQUM7QUFDdEMsTUFBSSxPQUFPLFdBQVcsRUFBRyxRQUFPO0FBQ2hDLFFBQU0sT0FBTyxFQUFxQixZQUFZLEVBQUU7QUFDaEQsU0FBTyxPQUFPLEtBQUssQ0FBQyxNQUFNLEVBQUUsT0FBTyxJQUFJLEtBQUssT0FBTyxLQUFLLENBQUMsTUFBTSxFQUFFLE9BQU8sWUFBWSxLQUFLLE9BQU8sQ0FBQztBQUNuRztBQUVBLFNBQVMsZ0JBQXdCO0FBQy9CLFFBQU0sSUFBSSxPQUFPLEVBQW9CLGdCQUFnQixFQUFFLEtBQUs7QUFDNUQsU0FBTyxPQUFPLFNBQVMsQ0FBQyxJQUFJLEtBQUssSUFBSSxLQUFLLEtBQUssSUFBSSxNQUFNLENBQUMsQ0FBQyxJQUFJO0FBQ2pFO0FBRUEsU0FBUyxpQkFBMEI7QUFDakMsTUFBSSxnQkFBZ0IsYUFBYyxRQUFPO0FBQ3pDLE1BQUksV0FBVyxFQUFHLFFBQU87QUFDekIsU0FBTyxXQUFXLFdBQVcsaUJBQWlCLEVBQUUsU0FBUyxDQUFDO0FBQzVEO0FBRUEsU0FBUyxzQkFBc0I7QUFDN0IsUUFBTSxTQUFVLFdBQVcsS0FBSyxhQUFlLFdBQVcsS0FBSyxXQUFXLFdBQVc7QUFDckYsTUFBSSxDQUFDLFFBQVE7QUFBRSxNQUFFLE9BQU8sRUFBRSxjQUFjO0FBQUk7QUFBQSxFQUFRO0FBQ3BELFFBQU0sUUFBUSxrQkFBa0IsR0FBRyxTQUFTO0FBQzVDLE1BQUksYUFBYTtBQUFFLE1BQUUsT0FBTyxFQUFFLGNBQWMsMkJBQXNCLEtBQUs7QUFBTTtBQUFBLEVBQVE7QUFDckYsTUFBSSxXQUFXLEtBQUssTUFBTSxnQkFBZ0I7QUFBRSxNQUFFLE9BQU8sRUFBRSxjQUFjLG1FQUEyRCxLQUFLO0FBQUs7QUFBQSxFQUFRO0FBQ2xKLE1BQUksQ0FBQyxhQUFhO0FBQUUsTUFBRSxPQUFPLEVBQUUsY0FBYyxjQUFTLEtBQUssMkJBQXNCLGNBQWMsRUFBRSxRQUFRLENBQUMsQ0FBQztBQUFLO0FBQUEsRUFBUTtBQUN4SCxRQUFNLFFBQVEsWUFBWSxXQUFXLFdBQVcsWUFBWSxNQUFNLFFBQVEsQ0FBQyxDQUFDLEtBQUs7QUFDakYsUUFBTSxRQUFRLFlBQVksVUFBVSxJQUFJLFNBQU0sWUFBWSxRQUFRLFFBQVEsQ0FBQyxDQUFDLFFBQVE7QUFDcEYsSUFBRSxPQUFPLEVBQUUsY0FBYyxjQUFTLEtBQUssZUFBTyxLQUFLLGNBQVcsWUFBWSxLQUFLLFFBQVEsQ0FBQyxDQUFDLEdBQUcsS0FBSztBQUNuRztBQUVBLFNBQVMsYUFBYTtBQUNwQixRQUFNLFFBQVEsa0JBQWtCO0FBQ2hDLFFBQU0sWUFBWSxTQUFTO0FBQzNCLFFBQU0sUUFBUSxPQUFPLFNBQVM7QUFDOUIsUUFBTSxNQUFNLEVBQXFCLFNBQVM7QUFDMUMsTUFBSSxTQUFTLENBQUM7QUFDZCxNQUFJLFVBQVUsT0FBTyxNQUFNLFNBQVM7QUFDcEMsTUFBSSxVQUFVLE9BQU8sV0FBVyxnQkFBZ0IsYUFBYSxjQUFjO0FBQzNFLE1BQUksYUFBYSxnQkFBZ0IsT0FBTyxTQUFTLENBQUM7QUFDbEQsTUFBSSxRQUFRLFlBQVksd0JBQW1CLEtBQUssZUFBVSxvQkFBZSxLQUFLO0FBQzlFLFFBQU0sT0FBTyxFQUFxQixXQUFXO0FBQzdDLE9BQUssU0FBUyxDQUFDO0FBQ2YsT0FBSyxVQUFVLE9BQU8sTUFBTSxTQUFTO0FBQ3JDLE9BQUssY0FBYyxZQUNkLGNBQWMsaUJBQVksS0FBSyxpQkFBTyxNQUFNLGlCQUFpQixrQkFBYSxLQUFLLFdBQU0sdUJBQWtCLEtBQUssV0FDN0csb0JBQWUsS0FBSztBQUN4QixJQUFvQixjQUFjLEVBQUUsVUFBVTtBQUM5QyxzQkFBb0I7QUFDcEIsYUFBVztBQUNiO0FBRUEsU0FBUyxrQkFBa0I7QUFDekIsUUFBTSxLQUFLLG1CQUFtQjtBQUM5QixRQUFNLGNBQWMsRUFBcUIsV0FBVztBQUNwRCxRQUFNLFlBQVksWUFBWTtBQUM5QixRQUFNLFNBQVMsR0FBRyxrQkFBa0I7QUFDcEMsY0FBWSxXQUFXLFVBQVUsR0FBRztBQUNwQyxRQUFNLGlCQUFpQixDQUFDLFVBQVUsQ0FBQyxHQUFHLGlCQUFpQixjQUFjLFlBQVksY0FBYztBQUMvRixhQUFXLE1BQU0sQ0FBQyxtQkFBbUIsZUFBZSxxQkFBcUIsR0FBRztBQUMxRSxNQUFvQixFQUFFLEVBQUUsV0FBVyxDQUFDO0FBQUEsRUFDdEM7QUFDQSxJQUFvQixjQUFjLEVBQUUsV0FBVyxVQUFVLEdBQUc7QUFDNUQsUUFBTSxRQUFRLEVBQW9CLFlBQVk7QUFDOUMsTUFBSSxVQUFVLEdBQUcscUJBQXFCO0FBQ3BDLFVBQU0sV0FBVztBQUFBLEVBQ25CLFdBQVcsY0FBYyxRQUFRO0FBQy9CLFVBQU0sVUFBVTtBQUNoQixVQUFNLFdBQVc7QUFBQSxFQUNuQixPQUFPO0FBQ0wsVUFBTSxXQUFXO0FBQ2pCLFVBQU0sVUFBVSxhQUFhLFFBQVEsa0JBQWtCLE1BQU07QUFBQSxFQUMvRDtBQUNBLFFBQU0sYUFBdUIsQ0FBQztBQUM5QixNQUFJLEdBQUcsYUFBYyxZQUFXLEtBQUssV0FBVztBQUNoRCxNQUFJLEdBQUcsVUFBVyxZQUFXLEtBQUssYUFBYTtBQUMvQyxNQUFJLEdBQUcsb0JBQXFCLFlBQVcsS0FBSyxtQkFBbUI7QUFDL0QsUUFBTSxhQUFhLFFBQVEsWUFBWSxVQUFVLEtBQUs7QUFDdEQsSUFBRSxnQkFBZ0IsRUFBRSxjQUFjLFNBQzlCLHFCQUFxQixHQUFHLGNBQWMsMEJBQ3RDLFdBQVcsU0FBUyxJQUNsQix5QkFBeUIsV0FBVyxLQUFLLElBQUksQ0FBQyxNQUM5QyxDQUFDLGFBQWEsY0FBYyxTQUMxQixnRUFDQTtBQUNWO0FBRUEsSUFBTSxhQUFhLElBQUksV0FBVztBQUFBLEVBQ2hDLFFBQVEsU0FBUyxVQUFVO0FBQ3pCLGtCQUFjO0FBQ2QsUUFBSSxPQUFPLG9CQUFvQixPQUFPLEdBQUcsV0FBVyxJQUFJLEtBQUssUUFBUSxTQUFTLEVBQUUsSUFBSSxLQUFLO0FBQ3pGLGVBQVc7QUFBQSxFQUNiO0FBQUEsRUFDQSxXQUFXLEtBQUs7QUFDZCxtQkFBZSxHQUFHO0FBQUEsRUFDcEI7QUFBQSxFQUNBLFlBQVksS0FBSztBQUNmLGtCQUFjO0FBQ2Qsd0JBQW9CO0FBQUEsRUFDdEI7QUFBQSxFQUNBLFFBQVEsU0FBUztBQUNmLGtCQUFjO0FBQ2QsUUFBSSxTQUFTLGNBQWMsT0FBTyxJQUFJLEtBQUs7QUFDM0MsVUFBTSxvQkFBb0IsT0FBTyxFQUFFO0FBQ25DLFFBQUksVUFBVyxNQUFLLFFBQVEsS0FBSztBQUFBLFFBQzVCLFlBQVc7QUFBQSxFQUNsQjtBQUNGLENBQUM7QUFFRCxlQUFlLFFBQVEsSUFBYSxVQUFVLE1BQU07QUFDbEQsUUFBTSxRQUFRLGtCQUFrQjtBQUNoQyxNQUFJLE1BQU0sQ0FBQyxPQUFPO0FBQ2hCLFVBQU0seUNBQXlDO0FBQy9DLE1BQW9CLGNBQWMsRUFBRSxVQUFVO0FBQzlDO0FBQUEsRUFDRjtBQUNBLFFBQU0sTUFBTSxFQUFFO0FBQ2QsY0FBWTtBQUNaLE1BQUksUUFBUyxjQUFhLFFBQVEsc0JBQXNCLEtBQUssTUFBTSxHQUFHO0FBQ3RFLE1BQUksTUFBTSxPQUFPO0FBQ2Ysa0JBQWM7QUFDZCxRQUFJLENBQUMsV0FBVyxTQUFTLFdBQVcsWUFBWSxNQUFNLEdBQUksZUFBYztBQUN4RSxlQUFXLEtBQUssTUFBTSxJQUFJLGNBQWMsQ0FBQztBQUN6QyxRQUFJLENBQUMsUUFBUTtBQUNYLFVBQUk7QUFDRixjQUFNLE1BQU0sVUFBVSxPQUFPLFdBQVcsQ0FBQztBQUN6QyxZQUFJLFFBQVEsVUFBVSxDQUFDLFVBQVc7QUFDbEMsbUJBQVcsTUFBTTtBQUNqQixjQUFNLGdCQUFnQjtBQUFBLE1BQ3hCLFNBQVMsS0FBSztBQUNaLFlBQUksUUFBUSxPQUFRO0FBQ3BCLG9CQUFZO0FBQ1osc0JBQWM7QUFDZCxZQUFJLENBQUMsUUFBUTtBQUNYLGdCQUFNLFFBQVE7QUFDZCwwQkFBZ0I7QUFBQSxRQUNsQjtBQUNBLFlBQUksUUFBUyxjQUFhLFFBQVEsc0JBQXNCLEdBQUc7QUFDM0QsY0FBTSxlQUFnQixJQUFjLE9BQU8sRUFBRTtBQUM3QyxZQUFJLFNBQVMsb0JBQXFCLElBQWMsT0FBTyxJQUFJLEtBQUs7QUFBQSxNQUNsRTtBQUFBLElBQ0Y7QUFBQSxFQUNGLE9BQU87QUFDTCxrQkFBYztBQUNkLGtCQUFjO0FBQ2QsUUFBSSxDQUFDLFFBQVE7QUFDWCxZQUFNLFFBQVE7QUFDZCxzQkFBZ0I7QUFDaEIsaUJBQVcsTUFBTTtBQUFBLElBQ25CO0FBQUEsRUFDRjtBQUNBLGFBQVc7QUFDYjtBQUVBLFNBQVMsZUFBZSxJQUFhO0FBQ25DLGtCQUFnQjtBQUNoQixRQUFNLFFBQVEsa0JBQWtCO0FBQ2hDLE1BQUksSUFBSTtBQUNOLFFBQUksQ0FBQyxPQUFPO0FBQ1YsVUFBSSxRQUFRLHlEQUF5RCxNQUFNO0FBQUEsSUFDN0UsT0FBTztBQUNMLG9CQUFjO0FBQ2QsVUFBSSxDQUFDLFdBQVcsU0FBUyxXQUFXLFlBQVksTUFBTSxHQUFJLGVBQWM7QUFDeEUsaUJBQVcsS0FBSyxNQUFNLElBQUksY0FBYyxDQUFDO0FBQ3pDLGlCQUFXLE1BQU07QUFDakIsVUFBSSxPQUFPLHdCQUF3QixNQUFNLEtBQUssS0FBSyxLQUFLO0FBQUEsSUFDMUQ7QUFBQSxFQUNGLE9BQU87QUFDTCxRQUFJLENBQUMsVUFBVyxlQUFjO0FBQzlCLFFBQUksT0FBTyxpQkFBaUIsS0FBSztBQUFBLEVBQ25DO0FBQ0EsYUFBVztBQUNiO0FBRUEsU0FBUyxlQUFlLEtBQXlCO0FBQy9DLE1BQUksQ0FBQyxlQUFlLEVBQUc7QUFDdkIsUUFBTSxRQUFRLGtCQUFrQixHQUFHLFNBQVM7QUFDNUMsTUFBSSxPQUFPLHVCQUFrQixLQUFLLGlCQUFZLElBQUksTUFBTSxRQUFRLENBQUMsQ0FBQyxLQUFLLElBQUksUUFBUSxRQUFRLENBQUMsQ0FBQyxRQUFRLEtBQUs7QUFDMUcsTUFBSSxRQUFRLFVBQVUsRUFBRyxNQUFLLE1BQU0sS0FBSyxFQUFFLEtBQUssTUFBTSxNQUFNLElBQUksU0FBUyxDQUFDLEVBQUUsTUFBTSxNQUFNO0FBQUEsRUFBQyxDQUFDO0FBQzFGLFFBQU0sZUFBVSxLQUFLLFdBQU0sSUFBSSxNQUFNLFFBQVEsQ0FBQyxDQUFDLEdBQUc7QUFDbEQsTUFBSSxXQUFXLEdBQUc7QUFDaEIsU0FBSyxFQUFFLE1BQU0sT0FBTyxDQUFDO0FBR3JCLGVBQVcsU0FBUyxJQUFJLFVBQVU7QUFDaEMsVUFBSSxDQUFDLE9BQVE7QUFDYixVQUFJLENBQUMsTUFBTSxjQUFjLE1BQU0sTUFBTSxlQUFlLEVBQUc7QUFDdkQsYUFBTztBQUNQLFdBQUssRUFBRSxNQUFNLE9BQU8sS0FBSyxjQUFjLE1BQU0sS0FBSyxFQUFFLENBQUM7QUFBQSxJQUN2RDtBQUNBO0FBQUEsRUFDRjtBQUNBLGlCQUFlO0FBQ2Ysa0JBQWdCLENBQUM7QUFDakIsaUJBQWU7QUFDZixhQUFXLFNBQVMsSUFBSSxVQUFVO0FBQ2hDLFFBQUksTUFBTSxNQUFNLGVBQWUsRUFBRztBQUNsQyxrQkFBYyxLQUFLLE1BQU0sS0FBSztBQUM5QixvQkFBZ0IsTUFBTSxNQUFNO0FBQzVCLFdBQU8sZUFBZSxxQkFBcUIsY0FBYyxTQUFTLEdBQUc7QUFDbkUsc0JBQWdCLGNBQWMsTUFBTSxFQUFHO0FBQUEsSUFDekM7QUFBQSxFQUNGO0FBQ0EsT0FBSyxNQUFNLEtBQUssU0FBUyxDQUFDLEVBQUUsS0FBSyxDQUFDLFlBQVk7QUFDNUMsUUFBSSxDQUFDLFdBQVcsY0FBYztBQUM1QixxQkFBZTtBQUNmLHNCQUFnQixDQUFDO0FBQ2pCLHFCQUFlO0FBQ2YsaUJBQVc7QUFBQSxJQUNiO0FBQUEsRUFDRixDQUFDLEVBQUUsTUFBTSxDQUFDLFFBQVE7QUFDaEIsbUJBQWU7QUFDZixvQkFBZ0IsQ0FBQztBQUNqQixtQkFBZTtBQUNmLFVBQU8sSUFBYyxPQUFPO0FBQzVCLFFBQUksU0FBVSxJQUFjLFNBQVMsS0FBSztBQUMxQyxlQUFXO0FBQUEsRUFDYixDQUFDO0FBQ0g7QUFJQSxTQUFTLHNCQUFzQjtBQUM3QixhQUFXLE1BQU0sQ0FBQyxPQUFPLFlBQVksT0FBTyxZQUFZLFVBQVUsY0FBYyxTQUFTLFlBQVksWUFBWSxHQUFHO0FBQ2xILFVBQU0sSUFBSSxhQUFhLFFBQVEsU0FBUyxFQUFFLEVBQUU7QUFDNUMsUUFBSSxLQUFLLEtBQU0sR0FBb0IsRUFBRSxFQUFFLFVBQVUsTUFBTTtBQUN2RCxNQUFFLEVBQUUsRUFBRSxpQkFBaUIsVUFBVSxNQUFNO0FBQ3JDLG1CQUFhLFFBQVEsU0FBUyxFQUFFLElBQUksUUFBUSxFQUFFLElBQUksTUFBTSxHQUFHO0FBQzNELFVBQUksT0FBTyxTQUFTLGFBQWEsQ0FBQyxRQUFRO0FBQ3hDLGFBQUssTUFBTSxTQUFTLE9BQU8sV0FBVyxDQUFDLEVBQUUsTUFBTSxDQUFDLFFBQVEsTUFBTSxlQUFlLElBQUksT0FBTyxFQUFFLENBQUM7QUFBQSxNQUM3RjtBQUFBLElBQ0YsQ0FBQztBQUFBLEVBQ0g7QUFDQSxhQUFXLENBQUMsSUFBSSxHQUFHLEtBQUs7QUFBQSxJQUN0QixDQUFDLGFBQWEsaUJBQWlCO0FBQUEsSUFDL0IsQ0FBQyxtQkFBbUIsdUJBQXVCO0FBQUEsSUFDM0MsQ0FBQyxlQUFlLG1CQUFtQjtBQUFBLElBQ25DLENBQUMsdUJBQXVCLDJCQUEyQjtBQUFBLElBQ25ELENBQUMsZ0JBQWdCLG9CQUFvQjtBQUFBLEVBQ3ZDLEdBQVk7QUFDVixVQUFNLFFBQVEsYUFBYSxRQUFRLEdBQUc7QUFDdEMsUUFBSSxTQUFTLEtBQU0sR0FBb0IsRUFBRSxFQUFFLFFBQVE7QUFDbkQsTUFBRSxFQUFFLEVBQUUsaUJBQWlCLFVBQVUsTUFBTTtBQUNyQyxtQkFBYSxRQUFRLEtBQUssRUFBb0IsRUFBRSxFQUFFLEtBQUs7QUFDdkQsVUFBSSxPQUFPLGVBQWdCLGNBQWEsUUFBUSx1QkFBdUIsR0FBRztBQUFBLElBQzVFLENBQUM7QUFBQSxFQUNIO0FBQ0EsUUFBTSxTQUFTLGFBQWEsUUFBUSxzQkFBc0I7QUFDMUQsTUFBSSxVQUFVLEtBQU0sR0FBb0IsZ0JBQWdCLEVBQUUsUUFBUTtBQUNsRSxJQUFFLG9CQUFvQixFQUFFLGNBQWMsY0FBYyxFQUFFLFFBQVEsQ0FBQztBQUMvRCxJQUFFLGdCQUFnQixFQUFFLGlCQUFpQixTQUFTLE1BQU07QUFDbEQsVUFBTSxJQUFJLGNBQWM7QUFDeEIsTUFBRSxvQkFBb0IsRUFBRSxjQUFjLEVBQUUsUUFBUSxDQUFDO0FBQ2pELGlCQUFhLFFBQVEsd0JBQXdCLEVBQUUsUUFBUSxDQUFDLENBQUM7QUFDekQsZUFBVyxhQUFhLENBQUM7QUFDekIsd0JBQW9CO0FBQUEsRUFDdEIsQ0FBQztBQUNELFFBQU0sWUFBWSxhQUFhLFFBQVEsaUJBQWlCO0FBQ3hELE1BQUksVUFBVyxHQUFxQixXQUFXLEVBQUUsUUFBUTtBQUN6RCxJQUFFLFdBQVcsRUFBRSxpQkFBaUIsVUFBVSxNQUFNO0FBQzlDLFVBQU1DLFFBQU8sRUFBcUIsV0FBVyxFQUFFO0FBQy9DLGlCQUFhLFFBQVEsbUJBQW1CQSxLQUFJO0FBQzVDLFFBQUksYUFBYSxRQUFRLHFCQUFxQixNQUFNLEtBQUs7QUFDdkQsWUFBTSxNQUFNQSxVQUFTLFNBQVMsT0FBTztBQUNyQyxRQUFvQixjQUFjLEVBQUUsUUFBUTtBQUM1QyxtQkFBYSxRQUFRLHNCQUFzQixHQUFHO0FBQUEsSUFDaEQ7QUFDQSxvQkFBZ0I7QUFBQSxFQUNsQixDQUFDO0FBQ0QsSUFBRSxjQUFjLEVBQUUsaUJBQWlCLFVBQVUsTUFBTSxLQUFLLFFBQVEsUUFBUSxjQUFjLENBQUMsQ0FBQztBQUN4RixJQUFFLFlBQVksRUFBRSxpQkFBaUIsVUFBVSxNQUFNO0FBQy9DLFVBQU0sS0FBSyxFQUFxQixZQUFZLEVBQUU7QUFDOUMsaUJBQWEsUUFBUSxvQkFBb0IsRUFBRTtBQUMzQyxRQUFJLGFBQWEsZUFBZTtBQUM5QixvQkFBYztBQUNkLG9CQUFjO0FBQ2QsaUJBQVcsS0FBSyxJQUFJLGNBQWMsQ0FBQztBQUNuQyxpQkFBVztBQUFBLElBQ2IsT0FBTztBQUNMLGlCQUFXO0FBQUEsSUFDYjtBQUFBLEVBQ0YsQ0FBQztBQUNELFFBQU0sUUFBUSxhQUFhLFFBQVEsYUFBYTtBQUNoRCxNQUFJLE1BQU8sR0FBcUIsT0FBTyxFQUFFLFFBQVE7QUFDakQsSUFBRSxPQUFPLEVBQUUsaUJBQWlCLFVBQVUsTUFBTSxhQUFhLFFBQVEsZUFBZSxFQUFxQixPQUFPLEVBQUUsS0FBSyxDQUFDO0FBQ3BILFFBQU0sT0FBTyxhQUFhLFFBQVEsWUFBWTtBQUM5QyxNQUFJLEtBQU0sR0FBcUIsTUFBTSxFQUFFLFFBQVE7QUFDL0MsSUFBRSxNQUFNLEVBQUUsaUJBQWlCLFVBQVUsTUFBTTtBQUN6QyxpQkFBYSxRQUFRLGNBQWMsRUFBcUIsTUFBTSxFQUFFLEtBQUs7QUFDckUsaUJBQWE7QUFBQSxFQUNmLENBQUM7QUFDRCxRQUFNLFFBQVEsYUFBYSxRQUFRLGFBQWEsS0FBSztBQUNyRCxhQUFXLEtBQUs7QUFDaEIsYUFBVyxPQUFPLE1BQU0sS0FBSyxTQUFTLGlCQUFvQyxzQkFBc0IsQ0FBQyxHQUFHO0FBQ2xHLFFBQUksVUFBVSxNQUFNO0FBQ2xCLFlBQU0sU0FBUyxJQUFJLFFBQVEsU0FBUztBQUNwQyxtQkFBYSxRQUFRLGVBQWUsTUFBTTtBQUMxQyxpQkFBVyxNQUFNO0FBQUEsSUFDbkI7QUFBQSxFQUNGO0FBQ0EsUUFBTSxVQUFVLGFBQWEsUUFBUSxlQUFlO0FBQ3BELGVBQWEsT0FBTztBQUNwQixhQUFXLE9BQU8sTUFBTSxLQUFLLFNBQVMsaUJBQW9DLHdCQUF3QixDQUFDLEdBQUc7QUFDcEcsUUFBSSxVQUFVLE1BQU07QUFDbEIsWUFBTSxTQUFTLGlCQUFpQixJQUFJLFFBQVEsT0FBTztBQUNuRCxtQkFBYSxRQUFRLGlCQUFpQixNQUFNO0FBQzVDLG1CQUFhLE1BQU07QUFBQSxJQUNyQjtBQUFBLEVBQ0Y7QUFDQSxhQUFXLDhCQUE4QixFQUFFLGlCQUFpQixVQUFVLE1BQU07QUFDMUUsU0FBSyxhQUFhLFFBQVEsYUFBYSxLQUFLLGNBQWMsU0FBVSxZQUFXLFFBQVE7QUFBQSxFQUN6RixDQUFDO0FBQ0QsV0FBUyxpQkFBaUIsb0JBQW9CLE1BQU07QUFDbEQsUUFBSSxDQUFDLFNBQVMsV0FBVyxVQUFVLFdBQVksTUFBSyxnQkFBZ0I7QUFBQSxFQUN0RSxDQUFDO0FBQ0QsUUFBTSxtQkFBbUIsTUFBTSxXQUFXLENBQUM7QUFDM0MsUUFBTSxvQkFBb0IsTUFBTTtBQUM5QixRQUFJLE1BQU0sbUJBQW1CLGFBQWEsU0FBUztBQUNqRCxXQUFLLE1BQU0sWUFBWSxFQUFFLEtBQUssTUFBTSxXQUFXLENBQUM7QUFBQSxJQUNsRDtBQUFBLEVBQ0Y7QUFDQSxXQUFTLGlCQUFpQixlQUFlLG1CQUFtQixFQUFFLFNBQVMsS0FBSyxDQUFDO0FBQzdFLFdBQVMsaUJBQWlCLGFBQWEsbUJBQW1CLEVBQUUsU0FBUyxLQUFLLENBQUM7QUFDM0UsV0FBUyxpQkFBaUIsU0FBUyxtQkFBbUIsRUFBRSxTQUFTLEtBQUssQ0FBQztBQUN2RSxXQUFTLGlCQUFpQixXQUFXLG1CQUFtQixFQUFFLFNBQVMsS0FBSyxDQUFDO0FBQ3pFLGtCQUFnQjtBQUNsQjtBQUVBLElBQU0sZUFBZSxXQUFXLG9CQUFvQjtBQUNwRCxJQUFJLGVBQW1DO0FBRXZDLFNBQVMsYUFBYSxNQUFlLFFBQTZCO0FBQ2hFLFFBQU0sVUFBVSxhQUFhLFdBQVcsQ0FBQyxFQUFFLE1BQU0sRUFBRTtBQUNuRCxRQUFNLE9BQU8sUUFBUTtBQUNyQixRQUFNLFVBQVUsU0FBUyxLQUFLLFVBQVUsU0FBUyxZQUFZO0FBQzdELFdBQVMsS0FBSyxVQUFVLE9BQU8sY0FBYyxJQUFJO0FBQ2pELFFBQU0sU0FBUyxTQUFTLGNBQWMsUUFBUTtBQUM5QyxNQUFJLE9BQVEsUUFBTyxRQUFRO0FBQzNCLElBQUUsT0FBTyxFQUFFLFFBQVE7QUFDbkIsSUFBRSxNQUFNLEVBQUUsUUFBUSxhQUFhLFdBQVcsQ0FBQztBQUMzQyxJQUFFLGNBQWMsRUFBRSxhQUFhLGlCQUFpQixPQUFPLElBQUksQ0FBQztBQUM1RCxJQUFFLGtCQUFrQixFQUFFLGFBQWEsaUJBQWlCLE9BQU8sSUFBSSxDQUFDO0FBQ2hFLE1BQUksUUFBUSxDQUFDLFNBQVM7QUFDcEIsbUJBQWUsVUFBVyxTQUFTO0FBQ25DLGdDQUE0QjtBQUM1QixNQUFFLGFBQWEsRUFBRSxNQUFNO0FBQ3ZCLDBCQUFzQixNQUFNLHdCQUF3QixDQUFDO0FBQUEsRUFDdkQsV0FBVyxDQUFDLFFBQVEsU0FBUztBQUMzQixVQUFNLFNBQVM7QUFDZixtQkFBZTtBQUNmLFFBQUksVUFBVSxPQUFPLGVBQWUsQ0FBQyxPQUFPLFVBQVUsT0FBTyxpQkFBaUIsTUFBTTtBQUNsRixhQUFPLE1BQU07QUFBQSxJQUNmLFdBQVcsV0FBVyxFQUFFLGtCQUFrQixHQUFHO0FBQzNDLFlBQU0sV0FBVyxFQUFFLGNBQWM7QUFDakMsVUFBSSxDQUFDLFNBQVMsVUFBVSxTQUFTLGlCQUFpQixLQUFNLFVBQVMsTUFBTTtBQUFBLElBQ3pFO0FBQUEsRUFDRjtBQUNGO0FBRUEsU0FBUyxPQUFPO0FBQ2QsUUFBTSxRQUFxQyxFQUFFLE1BQU0sRUFBRSxNQUFNLEdBQUcsS0FBSyxFQUFFLEtBQUssR0FBRyxRQUFRLEVBQUUsWUFBWSxFQUFFO0FBQ3JHLGFBQVcsUUFBUSxPQUFPLEtBQUssS0FBSyxHQUFHO0FBQ3JDLE1BQUUsT0FBTyxJQUFJLEVBQUUsRUFBRSxVQUFVLE1BQU07QUFDL0IsaUJBQVcsQ0FBQyxPQUFPLEVBQUUsS0FBSyxPQUFPLFFBQVEsS0FBSyxHQUFHO0FBQy9DLFdBQUcsU0FBUyxVQUFVO0FBQ3RCLFVBQUUsT0FBTyxLQUFLLEVBQUUsRUFBRSxVQUFVLE9BQU8sTUFBTSxVQUFVLElBQUk7QUFBQSxNQUN6RDtBQUNBLFFBQUUsY0FBYyxFQUFFLFNBQVMsU0FBUztBQUNwQyxtQkFBYSxLQUFLO0FBQ2xCLFVBQUksU0FBUyxPQUFRLHVCQUFzQixNQUFNLHdCQUF3QixDQUFDO0FBQUEsSUFDNUU7QUFBQSxFQUNGO0FBQ0EsYUFBVyxPQUFPLE1BQU0sS0FBSyxTQUFTLGlCQUFvQyxtQkFBbUIsQ0FBQyxHQUFHO0FBQy9GLFFBQUksVUFBVSxNQUFNLGNBQWMsb0JBQW9CLElBQUksUUFBUSxNQUFNLENBQUM7QUFBQSxFQUMzRTtBQUNBLElBQUUsb0JBQW9CLEVBQUUsVUFBVSxNQUFNO0FBQ3RDLFVBQU0sVUFBVSxDQUFDLEdBQUcsUUFBUSxPQUFPLENBQUMsRUFBRSxPQUFPLENBQUMsTUFBTSxFQUFFLEtBQUssVUFBVSxTQUFTLFNBQVMsQ0FBQztBQUN4RixVQUFNLFVBQVUsUUFBUSxLQUFLLENBQUMsTUFBTSxDQUFDLEVBQUUsS0FBSyxVQUFVLFNBQVMsTUFBTSxDQUFDO0FBQ3RFLGVBQVcsU0FBUyxRQUFTLGVBQWMsT0FBTyxPQUFPO0FBQUEsRUFDM0Q7QUFDQSxJQUFFLE1BQU0sRUFBRSxVQUFVLE1BQU07QUFBRSxNQUFFLFVBQVUsRUFBRSxTQUFTO0FBQUEsRUFBTztBQUMxRCxJQUFFLGVBQWUsRUFBRSxVQUFVLE1BQU07QUFBRSxNQUFFLFVBQVUsRUFBRSxTQUFTO0FBQUEsRUFBTTtBQUNsRSxJQUFFLGlCQUFpQixFQUFFLFVBQVUsTUFBTTtBQUFFLE1BQUUsVUFBVSxFQUFFLFNBQVM7QUFBQSxFQUFNO0FBQ3BFLElBQUUsVUFBVSxFQUFFLFVBQVUsQ0FBQyxNQUFNO0FBQUUsUUFBSSxFQUFFLFdBQVcsRUFBRSxVQUFVLEVBQUcsR0FBRSxVQUFVLEVBQUUsU0FBUztBQUFBLEVBQU07QUFDOUYsUUFBTSx3QkFBd0IsQ0FBQyxXQUF3QjtBQUNyRCxVQUFNLGNBQWMsQ0FBQyxHQUFHLE1BQU0sT0FBTyxDQUFDLEVBQUUsT0FBTyxZQUFZLEVBQUUsU0FBUztBQUN0RSxVQUFNLGFBQWEsMEJBQTBCLFlBQVksYUFBYSxtQkFBbUI7QUFDekYsUUFBSSxlQUFlLFdBQVksZUFBYyxVQUFVO0FBQ3ZELGlCQUFhLE1BQU0sTUFBTTtBQUFBLEVBQzNCO0FBQ0EsSUFBRSxjQUFjLEVBQUUsVUFBVSxNQUFNO0FBQ2hDLFFBQUksU0FBUyxLQUFLLFVBQVUsU0FBUyxZQUFZLEVBQUcsY0FBYSxLQUFLO0FBQUEsUUFDakUsdUJBQXNCLEVBQUUsY0FBYyxDQUFDO0FBQUEsRUFDOUM7QUFDQSxJQUFFLGtCQUFrQixFQUFFLFVBQVUsTUFBTSxzQkFBc0IsRUFBRSxrQkFBa0IsQ0FBQztBQUNqRixJQUFFLGFBQWEsRUFBRSxVQUFVLE1BQU0sYUFBYSxLQUFLO0FBQ25ELElBQUUsZUFBZSxFQUFFLFVBQVUsTUFBTSxhQUFhLEtBQUs7QUFDckQsZUFBYSxpQkFBaUIsVUFBVSxNQUFNO0FBQzVDLGlCQUFhLEtBQUs7QUFDbEIsZ0NBQTRCO0FBQzVCLDBCQUFzQixNQUFNLHdCQUF3QixDQUFDO0FBQUEsRUFDdkQsQ0FBQztBQUNELGVBQWEsS0FBSztBQUNwQjtBQUVBLFNBQVMsU0FBa0I7QUFDekIsUUFBTSxLQUFLLFNBQVM7QUFDcEIsU0FBTyxDQUFDLENBQUMsT0FBTyxHQUFHLFlBQVksV0FBVyxHQUFHLFlBQVksY0FBYyxHQUFHLFlBQVksWUFBWSxHQUFHO0FBQ3ZHO0FBRUEsU0FBUyxPQUFPO0FBQ2QsV0FBUyxpQkFBaUIsV0FBVyxDQUFDLE1BQU07QUFDMUMsUUFBSSxFQUFFLFFBQVEsVUFBVTtBQUN0QixVQUFJLENBQUMsRUFBRSxVQUFVLEVBQUUsUUFBUTtBQUFFLFVBQUUsVUFBVSxFQUFFLFNBQVM7QUFBTTtBQUFBLE1BQVE7QUFDbEUsVUFBSSxTQUFTLEtBQUssVUFBVSxTQUFTLFlBQVksS0FBSyxhQUFhLFdBQVcsQ0FBQyxFQUFFLE1BQU0sRUFBRSxRQUFRO0FBQUUscUJBQWEsS0FBSztBQUFHO0FBQUEsTUFBUTtBQUNoSSxVQUFJLFFBQVE7QUFBRSxhQUFLLEVBQUUsTUFBTSxZQUFZLENBQUM7QUFBRyxjQUFNLE1BQU07QUFBRztBQUFBLE1BQVE7QUFDbEU7QUFBQSxJQUNGO0FBQ0EsUUFBSSxPQUFPLEtBQUssQ0FBQyxFQUFFLFVBQVUsRUFBRSxVQUFVLFNBQVMsS0FBSyxVQUFVLFNBQVMsWUFBWSxLQUFLLEVBQUUsV0FBVyxFQUFFLFdBQVcsRUFBRSxPQUFRO0FBQy9ILFFBQUksRUFBRSxRQUFRLE9BQU8sRUFBRSxRQUFRLEtBQUs7QUFBRSxlQUFTLENBQUMsS0FBSztBQUFHLFFBQUUsZUFBZTtBQUFBLElBQUcsV0FDbkUsRUFBRSxRQUFRLE9BQU8sRUFBRSxRQUFRLEtBQUs7QUFBRSxXQUFLLFFBQVEsQ0FBQyxTQUFTO0FBQUcsUUFBRSxlQUFlO0FBQUEsSUFBRyxXQUNoRixFQUFFLFFBQVEsS0FBSztBQUFFLFFBQUUsTUFBTSxFQUFFLE1BQU07QUFBRyxRQUFFLGVBQWU7QUFBQSxJQUFHLFdBQ3hELEVBQUUsU0FBUyxXQUFXLFVBQVUsU0FBUyxDQUFDLEVBQUUsUUFBUTtBQUFFLGdCQUFVO0FBQU0sV0FBSyxFQUFFLE1BQU0sU0FBUyxDQUFDO0FBQUcsaUJBQVc7QUFBRyxRQUFFLGVBQWU7QUFBQSxJQUFHO0FBQUEsRUFDN0ksQ0FBQztBQUNELFdBQVMsaUJBQWlCLFNBQVMsQ0FBQyxNQUFNO0FBQ3hDLFFBQUksRUFBRSxTQUFTLFdBQVcsU0FBUztBQUFFLGdCQUFVO0FBQU8sV0FBSyxFQUFFLE1BQU0sT0FBTyxDQUFDO0FBQUcsaUJBQVc7QUFBQSxJQUFHO0FBQUEsRUFDOUYsQ0FBQztBQUNIO0FBRUEsZUFBZSxXQUFXLEdBQVU7QUFDbEMsSUFBRSxlQUFlO0FBQ2pCLFFBQU0sUUFBUSxFQUFvQixNQUFNO0FBQ3hDLE1BQUksT0FBTyxNQUFNLE1BQU0sS0FBSztBQUM1QixNQUFJLENBQUMsS0FBTTtBQUVYLE1BQUksQ0FBQyxRQUFRO0FBQ1gsVUFBTSxRQUFRO0FBQ2QsaUJBQWE7QUFDYixRQUFJO0FBQUUsWUFBTSxNQUFNLE9BQU8sSUFBSTtBQUFBLElBQUcsU0FBUyxLQUFLO0FBQUUsWUFBTyxJQUFjLE9BQU87QUFBRyxVQUFJLFNBQVUsSUFBYyxTQUFTLEtBQUs7QUFBQSxJQUFHO0FBQzVILFFBQUksQ0FBQyxRQUFRO0FBQUUsWUFBTSxRQUFRO0FBQU0sbUJBQWE7QUFBRztBQUFBLElBQVE7QUFBQSxFQUM3RDtBQUVBLFFBQU0sU0FBUyxZQUFZLElBQUk7QUFDL0IsUUFBTSxPQUFPLE9BQU8sUUFBUSxFQUFxQixNQUFNLEVBQUU7QUFDekQsU0FBTyxPQUFPO0FBQ2QsTUFBSSxDQUFDLEtBQU07QUFDWCxNQUFJLFNBQVMsT0FBTztBQUNsQixTQUFLLEVBQUUsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUMxQixlQUFXLElBQUk7QUFBQSxFQUNqQixPQUFPO0FBQ0wsU0FBSyxFQUFFLE1BQU0sT0FBTyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQ3ZDLFNBQUssa0JBQWEsU0FBUyxPQUFPLFdBQVcsUUFBUSxVQUFVLElBQUksRUFBRTtBQUNyRSxlQUFXLElBQUk7QUFBQSxFQUNqQjtBQUNBLFFBQU0sUUFBUTtBQUNkLGVBQWE7QUFDZjtBQUVBLGVBQWUsT0FBTztBQUNwQixhQUFXLGFBQWEsUUFBUSxhQUFhLEtBQUssUUFBUTtBQUMxRCxlQUFhLGFBQWEsUUFBUSxlQUFlLENBQUM7QUFDbEQsV0FBUyxPQUFPLE1BQU0sTUFBTSxTQUFTLEdBQUcsS0FBSztBQUM3QyxJQUFFLE9BQU8sRUFBRSxjQUFjLEdBQUcsT0FBTyxVQUFVLFdBQVcsV0FBVyxZQUFZLFNBQU0sT0FBTyxNQUFNLE1BQU0sR0FBRyxFQUFFLElBQUksQ0FBQztBQUNsSCxJQUFFLFNBQVMsRUFBRSxjQUFjLE9BQU87QUFDbEMsSUFBRSxPQUFPLEVBQUUsY0FBYyxRQUFRLE9BQU8sT0FBTztBQUMvQyxzQkFBb0I7QUFDcEIsUUFBTSxhQUFhLEVBQXFCLFlBQVk7QUFDcEQsUUFBTSxXQUFXLE9BQU8sY0FBYyxDQUFDO0FBQ3ZDLGFBQVcsS0FBSyxTQUFVLFlBQVcsSUFBSSxJQUFJLE9BQU8sRUFBRSxPQUFPLEVBQUUsRUFBRSxDQUFDO0FBQ2xFLFFBQU0saUJBQWlCLGFBQWEsUUFBUSxrQkFBa0I7QUFDOUQsTUFBSSxrQkFBa0IsU0FBUyxLQUFLLENBQUMsTUFBTSxFQUFFLE9BQU8sY0FBYyxFQUFHLFlBQVcsUUFBUTtBQUFBLFdBQy9FLFNBQVMsS0FBSyxDQUFDLE1BQU0sRUFBRSxPQUFPLFlBQVksRUFBRyxZQUFXLFFBQVE7QUFDekUsTUFBSSxTQUFTLFdBQVcsR0FBRztBQUN6QixNQUFvQixjQUFjLEVBQUUsV0FBVztBQUMvQyxlQUFXLFdBQVc7QUFDdEIsTUFBRSxXQUFXLEVBQUUsY0FBYztBQUFBLEVBQy9CO0FBQ0EsTUFBSSxDQUFDLE9BQU8sUUFBUTtBQUFFLE1BQW9CLFlBQVksRUFBRSxVQUFVO0FBQU0sTUFBb0IsWUFBWSxFQUFFLFdBQVc7QUFBQSxFQUFNO0FBQzNILE1BQUksQ0FBQyxPQUFPLEdBQUksR0FBRSxZQUFZLEVBQUUsY0FBYztBQUFBLE1BQ3pDLEdBQUUsWUFBWSxFQUFFLGNBQWMsa0RBQWtELE9BQU8sR0FBRyxLQUFLLElBQUksQ0FBQztBQUN6RyxNQUFJLENBQUMsVUFBVSxXQUFXO0FBQUUsTUFBb0IsVUFBVSxFQUFFLFVBQVU7QUFBTyxNQUFvQixVQUFVLEVBQUUsV0FBVztBQUFBLEVBQU07QUFDOUgsUUFBTSxTQUFTLEVBQXFCLFFBQVE7QUFDNUMsYUFBVyxRQUFRLE9BQU8sS0FBSyxPQUFPLEVBQUcsUUFBTyxJQUFJLElBQUksT0FBTyxNQUFNLElBQUksQ0FBQztBQUMxRSxTQUFPLFFBQVEsYUFBYSxRQUFRLG1CQUFtQixLQUFLO0FBQzVELE1BQUksQ0FBQyxRQUFRLE9BQU8sS0FBSyxFQUFHLFFBQU8sUUFBUTtBQUMzQyxJQUF1QixRQUFRLEVBQUUsUUFBUSxhQUFhLFFBQVEsbUJBQW1CLEtBQUssS0FBSyxVQUFVLFFBQVEsT0FBTyxLQUFLLEdBQUcsTUFBTSxDQUFDO0FBQ25JLGtCQUFnQjtBQUNoQixTQUFPLFdBQVcsTUFBTTtBQUN0QixNQUF1QixRQUFRLEVBQUUsUUFBUSxLQUFLLFVBQVUsUUFBUSxPQUFPLEtBQUssR0FBRyxNQUFNLENBQUM7QUFDdEYsaUJBQWEsUUFBUSxxQkFBcUIsT0FBTyxLQUFLO0FBQ3RELGlCQUFhLFdBQVcsbUJBQW1CO0FBQzNDLG9CQUFnQjtBQUFBLEVBQ2xCO0FBQ0EsSUFBRSxRQUFRLEVBQUUsVUFBVSxNQUFNO0FBQUUsaUJBQWEsUUFBUSxxQkFBcUIsRUFBdUIsUUFBUSxFQUFFLEtBQUs7QUFBRyxvQkFBZ0I7QUFBQSxFQUFHO0FBQ3BJLElBQUUsVUFBVSxFQUFFLFVBQVUsWUFBWTtBQUNsQyxVQUFNLElBQUksUUFBUyxNQUFNLFNBQVM7QUFDbEMsTUFBRSxjQUFjLEVBQUUsY0FBYyxLQUFLLFVBQVUsS0FBSyxNQUFNLEVBQUUsU0FBUyxDQUFDLEdBQUcsTUFBTSxDQUFDO0FBQ2hGLE1BQUUsY0FBYyxFQUFFLFNBQVMsQ0FBQyxFQUFFLGNBQWMsRUFBRTtBQUFBLEVBQ2hEO0FBQ0EsUUFBTSxjQUFjLE1BQU0sS0FBSyxXQUFXLEVBQUUsTUFBTSxDQUFDLFFBQVE7QUFBRSxVQUFNLElBQUksT0FBTztBQUFHLFFBQUksU0FBUyxJQUFJLFNBQVMsS0FBSztBQUFBLEVBQUcsQ0FBQztBQUNwSCxRQUFNLGtCQUFrQixNQUFNO0FBQUUsUUFBSSxDQUFDLE9BQVEsTUFBSyxNQUFNLEVBQUUsTUFBTSxDQUFDLFFBQVE7QUFBRSxZQUFNLElBQUksT0FBTztBQUFHLFVBQUksU0FBUyxJQUFJLFNBQVMsS0FBSztBQUFBLElBQUcsQ0FBQztBQUFBLEVBQUc7QUFDckksUUFBTSxnQkFBZ0IsTUFBTSxLQUFLLE1BQU0sSUFBSSxFQUFFLE1BQU0sQ0FBQyxRQUFRO0FBQUUsVUFBTSxJQUFJLE9BQU87QUFBRyxRQUFJLFNBQVMsSUFBSSxTQUFTLEtBQUs7QUFBQSxFQUFHLENBQUM7QUFDckgsSUFBRSxNQUFNLEVBQUUsVUFBVTtBQUNwQixJQUFFLFdBQVcsRUFBRSxVQUFVO0FBQ3pCLElBQUUsV0FBVyxFQUFFLFVBQVUsTUFBTTtBQUM3QixRQUFJLGFBQWEsTUFBTSxnQkFBZ0I7QUFBRSxXQUFLLE1BQU0sWUFBWSxFQUFFLEtBQUssTUFBTSxXQUFXLENBQUM7QUFBRztBQUFBLElBQVE7QUFDcEcsU0FBSyxRQUFRLENBQUMsU0FBUztBQUFBLEVBQ3pCO0FBQ0EsSUFBRSxTQUFTLEVBQUUsVUFBVSxNQUFNO0FBQzNCLFFBQUksYUFBYSxNQUFNLGdCQUFnQjtBQUFFLFdBQUssTUFBTSxZQUFZLEVBQUUsS0FBSyxNQUFNLFdBQVcsQ0FBQztBQUFHO0FBQUEsSUFBUTtBQUNwRyxTQUFLLFFBQVEsQ0FBQyxTQUFTO0FBQUEsRUFDekI7QUFDQSxJQUFFLFVBQVUsRUFBRSxVQUFVLE1BQU07QUFBRSxRQUFJLE9BQVEsTUFBSyxFQUFFLE1BQU0sU0FBUyxDQUFDO0FBQUEsRUFBRztBQUN0RSxJQUFFLFFBQVEsRUFBRSxVQUFVO0FBQ3RCLElBQUUsYUFBYSxFQUFFLFVBQVU7QUFDM0IsYUFBVztBQUNYLE1BQUksYUFBYSxRQUFRLG9CQUFvQixNQUFNLE9BQU8sU0FBUyxTQUFTLEdBQUc7QUFFN0UsU0FBSyxVQUFVLGFBQWEsTUFBTSxFQUFFLE1BQU0sYUFBK0IsQ0FBQyxFQUN2RSxLQUFLLENBQUMsTUFBTTtBQUFFLFVBQUksRUFBRSxVQUFVLFVBQVcsTUFBSyxRQUFRLE1BQU0sS0FBSztBQUFBLElBQUcsQ0FBQyxFQUNyRSxNQUFNLE1BQU07QUFBQSxJQUFDLENBQUM7QUFBQSxFQUNuQjtBQUNBLE1BQUksYUFBYSxFQUFFLFNBQVMsR0FBRztBQUM3QixzQkFBa0IsSUFBSTtBQUN0QixNQUFFLFFBQVEsRUFBRSxRQUFRO0FBQUEsRUFDdEI7QUFDQSxJQUFFLEtBQUssRUFBRSxVQUFVLE1BQU0sU0FBUyxDQUFDLEtBQUs7QUFDeEMsSUFBRSxNQUFNLEVBQUUsVUFBVSxNQUFNO0FBQUUsU0FBSyxFQUFFLE1BQU0sWUFBWSxDQUFDO0FBQUcsVUFBTSxNQUFNO0FBQUEsRUFBRztBQUN4RSxJQUFFLFdBQVcsRUFBRSxVQUFVLE1BQU0sS0FBSyxFQUFFLE1BQU0sWUFBWSxDQUFDO0FBQ3pELElBQUUsU0FBUyxFQUFFLGlCQUFpQixVQUFVLE1BQU07QUFBRSxRQUFJLEVBQXNCLFNBQVMsRUFBRSxLQUFNLEdBQUUsU0FBUyxFQUFFLGVBQWUsRUFBRSxPQUFPLFVBQVUsQ0FBQztBQUFBLEVBQUcsQ0FBQztBQUMvSSxJQUFFLEtBQUssRUFBRSxXQUFXLENBQUMsTUFBTSxLQUFLLFdBQVcsQ0FBQztBQUM1QyxJQUFFLE1BQU0sRUFBRSxpQkFBaUIsU0FBUyxZQUFZO0FBQ2hELFFBQU0saUJBQWlCLEVBQUUsWUFBWTtBQUNyQyxpQkFBZSxpQkFBaUIsVUFBVSxNQUFNLGlCQUFpQixTQUFTLEdBQUcsRUFBRSxTQUFTLEtBQUssQ0FBQztBQUM5RixpQkFBZSxpQkFBaUIsYUFBYSxNQUFNLGlCQUFpQixZQUFZLEdBQUcsRUFBRSxTQUFTLEtBQUssQ0FBQztBQUNwRyxpQkFBZSxpQkFBaUIsU0FBUyxDQUFDLE1BQU07QUFBRSxRQUFJLEVBQUUsU0FBUyxFQUFHLGtCQUFpQixXQUFXO0FBQUEsRUFBRyxHQUFHLEVBQUUsU0FBUyxLQUFLLENBQUM7QUFDdkgsaUJBQWUsaUJBQWlCLGNBQWMsTUFBTSxpQkFBaUIsV0FBVyxHQUFHLEVBQUUsU0FBUyxLQUFLLENBQUM7QUFDcEcsTUFBSSxPQUFPLG1CQUFtQixhQUFhO0FBQ3pDLFFBQUksZUFBZSxNQUFNLGlCQUFpQixTQUFTLENBQUMsRUFBRSxRQUFRLGNBQWM7QUFDNUUsUUFBSSxlQUFlLE1BQU0sd0JBQXdCLENBQUMsRUFBRSxRQUFRLEVBQUUsU0FBUyxDQUFDO0FBQUEsRUFDMUU7QUFDQSxJQUFFLFlBQVksRUFBRSxVQUFVLE1BQU0saUJBQWlCLGFBQWE7QUFDOUQsZUFBYTtBQUNiLGlCQUFlO0FBQ2YsT0FBSztBQUNMLE9BQUs7QUFDTCxRQUFNLFNBQVMsSUFBSSxZQUFZLFNBQVM7QUFDeEMsU0FBTyxpQkFBaUIsUUFBUSxDQUFDLE1BQU07QUFDckMsVUFBTSxFQUFFLFFBQVEsSUFBSSxLQUFLLE1BQU8sRUFBbUIsSUFBSTtBQUN2RCxNQUFFLFNBQVMsRUFBRSxjQUFjLFdBQVcsVUFBVSxRQUFRLEtBQUssWUFBWSxVQUFVLDhCQUE4QixLQUFLLE9BQU8sTUFBTTtBQUNuSSxNQUFFLE9BQU8sRUFBRSxjQUFjLFFBQVEsT0FBTztBQUFBLEVBQzFDLENBQUM7QUFDRCxTQUFPLGlCQUFpQixPQUFPLE1BQU07QUFBRSxRQUFJLENBQUMsT0FBUSxVQUFTLE9BQU87QUFBQSxRQUFRLE9BQU0sMENBQTBDO0FBQUEsRUFBRyxDQUFDO0FBQ2hJLFNBQU8saUJBQWlCLFNBQVMsQ0FBQyxNQUFNO0FBQ3RDLFVBQU0sT0FBUSxFQUFtQjtBQUNqQyxRQUFJLEtBQU0sT0FBTSxpQkFBaUIsS0FBSyxNQUFNLElBQUksRUFBRSxPQUFPLEVBQUU7QUFBQSxFQUM3RCxDQUFDO0FBQ0QsTUFBSSxPQUFPLEVBQUUsUUFBUSxHQUFHLFFBQVE7QUFDaEMsT0FBSyxLQUFLO0FBQ1YsT0FBSyxZQUFZO0FBQ2pCLFNBQU8sWUFBWSxNQUFNLEtBQUssWUFBWSxHQUFHLEdBQU07QUFDckQ7QUFFQSxLQUFLLEtBQUs7IiwKICAibmFtZXMiOiBbImNvcmUiLCAiY29yZSIsICJub3ciLCAiYWN0aXZlU2Vzc2lvbiIsICJjb3VudHMiLCAibGl2ZSIsICJsaW5lIiwgInJ1biIsICJtb2RlIl0KfQo=
