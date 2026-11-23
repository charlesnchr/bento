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
    this.lastSuppressedSeq = 0;
    this.lastAckedSeq = 0;
    this.recent = [];
    this.recentBytes = 0;
    this.ready = false;
    this.callbacks = callbacks;
    this.createWorker = createWorker;
  }
  /** True while at least one suppressed frame is still queued or scoring in the worker. */
  get suppressedInFlight() {
    return this.lastSuppressedSeq > this.lastAckedSeq;
  }
  clearRecent() {
    this.recent = [];
    this.recentBytes = 0;
  }
  clearSuppressedTracking() {
    const hadInFlight = this.suppressedInFlight;
    this.lastSuppressedSeq = 0;
    this.lastAckedSeq = 0;
    if (hadInFlight) this.callbacks.onSuppressedSettled?.();
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
      } else if (m.type === "ack") {
        const wasInFlight = this.suppressedInFlight;
        if (typeof m.seq === "number" && m.seq > this.lastAckedSeq) this.lastAckedSeq = m.seq;
        if (wasInFlight && !this.suppressedInFlight) this.callbacks.onSuppressedSettled?.();
      } else if (m.type === "detected") {
        const trailing = [];
        const rest = new Uint8Array(m.restBytes);
        const hitSeq = typeof m.seq === "number" ? m.seq : Number.MAX_SAFE_INTEGER;
        const hitItem = this.recent.find((item) => item.seq === hitSeq);
        if (rest.byteLength > 0) {
          trailing.push({ seq: hitSeq, bytes: rest, suppressed: hitItem?.suppressed ?? false });
        }
        for (const item of this.recent) {
          if (item.seq > hitSeq) trailing.push({ seq: item.seq, bytes: item.bytes, suppressed: item.suppressed });
        }
        this.clearRecent();
        this.lastSuppressedSeq = 0;
        this.lastAckedSeq = 0;
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
        this.clearSuppressedTracking();
        this.callbacks.onError?.(String(m.message ?? "wake worker error"));
      }
    };
    worker.onerror = (err) => {
      this.loadingModelId = null;
      this.ready = false;
      this.clearSuppressedTracking();
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
    this.clearSuppressedTracking();
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
  /** Feeds a 16 kHz PCM16 chunk to the worker; returns its sequence number (or 0 if not ready). */
  feed(samples, suppressed = false) {
    if (!this.ready || !this.worker) return 0;
    const seq = ++this.seq;
    if (suppressed) this.lastSuppressedSeq = seq;
    const bytes = new Uint8Array(samples.byteLength);
    bytes.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
    this.recent.push({ seq, bytes, suppressed });
    this.recentBytes += bytes.byteLength;
    while (this.recentBytes > RECENT_MAX_BYTES && this.recent.length > 1) {
      this.recentBytes -= this.recent.shift().bytes.byteLength;
    }
    const copy = new Int16Array(samples.length);
    copy.set(samples);
    this.worker.postMessage({ type: "feed", gen: this.gen, seq, ack: suppressed, pcm: copy.buffer }, [copy.buffer]);
    return seq;
  }
  reset() {
    this.clearRecent();
    this.clearSuppressedTracking();
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
    this.clearSuppressedTracking();
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
var wakePeriodCallId = null;
var callWhileSpeaking = "send";
var coreSpeechUntil = 0;
var deferredMic = [];
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
function flushDeferredMic() {
  if (deferredMic.length === 0) return;
  const items = deferredMic.splice(0);
  if (!callId || medium !== "voice") return;
  for (const item of items) {
    if (!callId) break;
    counts.mic++;
    push({ type: "mic", pcm: item.pcm }, item.t);
  }
}
function onMic(samples, level) {
  const t = now();
  const suppressed = callId !== 0 && medium === "voice" && callWhileSpeaking !== "send" && t < coreSpeechUntil;
  const seq = shouldFeedWake() ? wakeClient.feed(samples, suppressed) : 0;
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
  if (level > 0.03 && !(muted && !holding)) {
    metrics.lastVoice = t;
    if (audio.queued < 0.05) metrics.replied = false;
  }
  const pcm = bytesToBase64(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
  if (!suppressed && wakeClient.suppressedInFlight && callWhileSpeaking !== "send") {
    deferredMic.push({ seq, pcm, t });
    if (deferredMic.length > 75) flushDeferredMic();
    return;
  }
  if (deferredMic.length > 0) flushDeferredMic();
  counts.mic++;
  push({ type: "mic", pcm }, t);
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
    deferredMic = [];
    wakePeriodCallId = null;
    wakeClient.reset();
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
  deferredMic = [];
  wakePeriodCallId = wakeArmed ? 0 : null;
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
  if (muted) {
    flushDeferredMic();
    wakeClient.reset();
  }
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
function canAcceptWakeHit() {
  if (wakeStarting || startingCall) return false;
  if (callId === 0) return wakeArmed && wakePeriodCallId === 0;
  return medium === "voice" && !(muted && !holding) && wakePeriodCallId === callId;
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
  onSuppressedSettled() {
    flushDeferredMic();
  },
  onError(message) {
    wakeLoading = false;
    flushDeferredMic();
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
        wakePeriodCallId = 0;
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
      wakePeriodCallId = null;
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
      wakePeriodCallId = callId;
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
  if (!canAcceptWakeHit()) return;
  const label = selectedWakeModel()?.label ?? "wake word";
  log("out", `wake detected \u201C${label}\u201D (score ${hit.score.toFixed(2)}, ${hit.inferMs.toFixed(1)} ms)`, "out");
  if (checked("wake-cue")) void audio.open().then(() => audio.cue(WAKE_TONE)).catch(() => {
  });
  toast(`Heard \u201C${label}\u201D (${hit.score.toFixed(2)})`);
  if (callId !== 0) {
    const deferred = deferredMic.splice(0);
    const deferredSeqs = new Set(deferred.map((d) => d.seq).filter((s) => s > 0));
    push({ type: "wake" });
    const replayedSeqs = /* @__PURE__ */ new Set();
    for (const chunk of hit.trailing) {
      if (!callId) break;
      if (chunk.bytes.byteLength === 0) continue;
      if (!chunk.suppressed && !deferredSeqs.has(chunk.seq)) continue;
      if (chunk.seq > 0) replayedSeqs.add(chunk.seq);
      counts.mic++;
      push({ type: "mic", pcm: bytesToBase64(chunk.bytes) });
    }
    for (const item of deferred) {
      if (!callId) break;
      if (item.seq > 0 && replayedSeqs.has(item.seq)) continue;
      counts.mic++;
      push({ type: "mic", pcm: item.pcm }, item.t);
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
    if (callId) {
      flushDeferredMic();
      push({ type: "resume" });
    }
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL2NvbW1hbmRzLnRzIiwgIi4uL2F1ZGlvLnRzIiwgIi4uL3JlcGxheS50cyIsICIuLi9zY3JvbGwudHMiLCAiLi4vdWkudHMiLCAiLi4vd2FrZUNsaWVudC50cyIsICIuLi9hcHAudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFNwb2tlbiBjb21tYW5kcyB0aGUgY29yZSBhY3RzIG9uIHdpdGhvdXQgdGhlIG1vZGVsOiBcInN0b3BcIiBhbmQgXCJoYW5nIHVwXCIuIEFuIHV0dGVyYW5jZSBjb3VudHNcbi8vIG9ubHkgd2hlbiBpdCBpcyBvbmUgb2YgdGhlIHBocmFzZXMgYW5kIG5vdGhpbmcgbW9yZSwgb25jZSBuYW1lcyBhbmQgZmlsbGVycyBhcm91bmQgaXQgYXJlIGdvbmUsXG4vLyBzbyBcIldvb2Rob3VzZSwgc3RvcCBwbGVhc2VcIiBzdG9wcyBhbmQgXCJzdG9wIHRoZSBQZW5ueXdvcnRoIHRhc2tcIiBnb2VzIHRvIHRoZSBtb2RlbCBhcyB1c3VhbC5cblxuaW1wb3J0IHR5cGUgeyBWb2ljZUNvbW1hbmRzIH0gZnJvbSBcIi4vdHlwZXMudHNcIjtcblxuZXhwb3J0IHR5cGUgVm9pY2VDb21tYW5kID0gXCJzdG9wXCIgfCBcImhhbmdVcFwiIHwgXCJjYW5jZWxBbGxcIjtcblxuLyoqIFdvcmRzIHRoYXQgbWF5IGNvbWUgYmVmb3JlIG9yIGFmdGVyIGEgY29tbWFuZCB3aXRob3V0IGNoYW5naW5nIGl0LiAqL1xuY29uc3QgRklMTEVSID0gbmV3IFNldChbXG4gIFwiaGV5XCIsIFwib2tcIiwgXCJva2F5XCIsIFwicGxlYXNlXCIsIFwibm93XCIsIFwianVzdFwiLCBcInNvXCIsIFwidW1cIiwgXCJ1aFwiLCBcIm9oXCIsIFwiYWxyaWdodFwiLCBcInJpZ2h0XCIsIFwieWVhaFwiLCBcInllc1wiLCBcInRoYW5rc1wiLCBcInRoYW5rXCIsIFwieW91XCIsXG4gIFwiZ2VtaW5pXCIsXG5dKTtcblxuLyoqIFt0ZXh0XSBhcyBsb3dlci1jYXNlIHdvcmRzLCBhcG9zdHJvcGhlcyBkcm9wcGVkIChcIlRoYXQnc1wiIGlzIFwidGhhdHNcIikuICovXG5leHBvcnQgZnVuY3Rpb24gd29yZHModGV4dDogc3RyaW5nKTogc3RyaW5nW10ge1xuICByZXR1cm4gdGV4dC50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL1snXHUyMDE5YF0vZywgXCJcIikucmVwbGFjZSgvW15cXHB7TH1cXHB7TmR9XSsvZ3UsIFwiIFwiKS50cmltKCkuc3BsaXQoXCIgXCIpLmZpbHRlcigodykgPT4gdy5sZW5ndGggPiAwKTtcbn1cblxuLyoqIFRoZSBjb21tYW5kIFt1dHRlcmFuY2VdIGlzLCBpZiBpdCdzIG9uZSBhbmQgbm90aGluZyBtb3JlOyBbbmFtZXNdICh0aGUgYXNzaXN0YW50J3MsIFwiV29vZGhvdXNlXCIpIGRvbid0IGNvdW50LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbW1hbmRJbih1dHRlcmFuY2U6IHN0cmluZywgY29tbWFuZHM6IFZvaWNlQ29tbWFuZHMsIG5hbWVzOiBzdHJpbmdbXSA9IFtdKTogVm9pY2VDb21tYW5kIHwgbnVsbCB7XG4gIGNvbnN0IGlnbm9yZWQgPSBuZXcgU2V0KFsuLi5GSUxMRVIsIC4uLm5hbWVzLmZsYXRNYXAod29yZHMpXSk7XG4gIGNvbnN0IHNhaWQgPSB3b3Jkcyh1dHRlcmFuY2UpO1xuICBsZXQgZnJvbSA9IDA7XG4gIGxldCB0byA9IHNhaWQubGVuZ3RoO1xuICB3aGlsZSAoZnJvbSA8IHRvICYmIGlnbm9yZWQuaGFzKHNhaWRbZnJvbV0pKSBmcm9tKys7XG4gIHdoaWxlICh0byA+IGZyb20gJiYgaWdub3JlZC5oYXMoc2FpZFt0byAtIDFdKSkgdG8tLTtcbiAgaWYgKGZyb20gPT09IHRvIHx8IHRvIC0gZnJvbSA+IDUpIHJldHVybiBudWxsO1xuICBjb25zdCBjb3JlID0gc2FpZC5zbGljZShmcm9tLCB0bykuam9pbihcIiBcIik7XG4gIGNvbnN0IGlzID0gKHBocmFzZXM6IHN0cmluZ1tdKSA9PiBwaHJhc2VzLnNvbWUoKHApID0+IHdvcmRzKHApLmpvaW4oXCIgXCIpID09PSBjb3JlKTtcbiAgaWYgKGlzKGNvbW1hbmRzLmhhbmdVcCkpIHJldHVybiBcImhhbmdVcFwiO1xuICBpZiAoaXMoY29tbWFuZHMuY2FuY2VsQWxsID8/IFtdKSkgcmV0dXJuIFwiY2FuY2VsQWxsXCI7XG4gIGlmIChpcyhjb21tYW5kcy5zdG9wKSkgcmV0dXJuIFwic3RvcFwiO1xuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqIFdvcmRzIHRoYXQgdGFrZSBhIHJlcXVlc3QgYmFjay4gKi9cbmNvbnN0IENBTkNFTFMgPSAvXFxiKD86Y2FuY2VsXFx3KnxhYm9ydFxcdyp8a2lsbHxzY3JhcHxzY3JhdGNofGRyb3B8Zm9yZ2V0fHVuZG98dGVybWluYXRlfG5ldmVyID9taW5kfGNhbGwgKD86aXR8dGhhdHx0aGlzKSBvZmZ8KD86ZG9udHxkbyBub3QpICg/OmJvdGhlcnxuZWVkfHdhbnR8ZG8pfG5vIG5lZWR8bm8gbG9uZ2VyfG5vdCBhbnltb3JlfGxlYXZlIGl0fHNraXAgKD86aXR8dGhhdCkpXFxiLztcbmNvbnN0IFNUT1BTID0gL1xcYig/OnN0b3BcXHcqfGhhbHR8cXVpdHxlbmQpXFxiLztcblxuLyoqXG4gKiBXaGV0aGVyIFt1dHRlcmFuY2VdIGFza3MgZm9yIGEgdGFzayB0byBiZSBjYW5jZWxsZWQsIGZvciBhIGNhbmNlbF90YXNrIHRoZSBtb2RlbCBjYWxsZWQgb24gaXQuIFwiU3RvcFwiIGFsb25lIGFuZCB0aGVcbiAqIG90aGVyIHN0b3AgYW5kIGhhbmctdXAgcGhyYXNlcyBkb24ndDogdGhleSBtZWFuIHN0b3AgdGFsa2luZy4gT3RoZXJ3aXNlIGl0IGRvZXMgd2hlbiBpdCBzYXlzIHNvIGluIHdvcmRzLCB3aGVuIGl0XG4gKiBuYW1lcyB0aGUgdGFzayAoW25hbWVkXSksIG9yIHdoZW4gaXQgc2F5cyB0byBzdG9wIHNvbWV0aGluZyBtb3JlIHRoYW4gdGhlIHRhbGtpbmcgKFwic3RvcCB3b3JraW5nIG9uIHRoYXRcIikuXG4gKiBXb3JkcyB0aGF0IHNheSBub25lIG9mIHRoaXMgKGEgbWlzaGVhcmluZyBzdWNoIGFzIFwiU3RhYml0XCIpIGRvbid0LiBXaXRoIG5vdGhpbmcgaGVhcmQgdGhlcmUgaXMgbm90aGluZyB0byBqdWRnZSBieS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFza3NUb0NhbmNlbCh1dHRlcmFuY2U6IHN0cmluZywgY29tbWFuZHM6IFZvaWNlQ29tbWFuZHMsIG5hbWVzOiBzdHJpbmdbXSwgbmFtZWQ6IGJvb2xlYW4pOiBib29sZWFuIHtcbiAgY29uc3Qgc2FpZCA9IHdvcmRzKHV0dGVyYW5jZSkuam9pbihcIiBcIik7XG4gIGlmIChzYWlkLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHRydWU7XG4gIGNvbnN0IGNvbW1hbmQgPSBjb21tYW5kSW4odXR0ZXJhbmNlLCBjb21tYW5kcywgbmFtZXMpO1xuICBpZiAoY29tbWFuZCA9PT0gXCJzdG9wXCIgfHwgY29tbWFuZCA9PT0gXCJoYW5nVXBcIikgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gY29tbWFuZCA9PT0gXCJjYW5jZWxBbGxcIiB8fCBuYW1lZCB8fCBDQU5DRUxTLnRlc3Qoc2FpZCkgfHwgU1RPUFMudGVzdChzYWlkKTtcbn1cbiIsICIvLyBUaGUgYnJvd3NlcidzIG1pY3JvcGhvbmUgYW5kIHNwZWFrZXIgZm9yIGEgY2FsbDogMTYga0h6IFBDTTE2IGZyYW1lcyBvdXQgb2YgdGhlIG1pY3JvcGhvbmUsXG4vLyAyNCBrSHogUENNMTYgaW50byB0aGUgc3BlYWtlciwgYW5kIHRvbmVzIGxhaWQgb3ZlciB3aGF0ZXZlciBwbGF5cy4gQm90aCBydW4gaW4gQXVkaW9Xb3JrbGV0cyBvblxuLy8gb25lIEF1ZGlvQ29udGV4dCBhdCB0aGUgZGV2aWNlJ3MgcmF0ZSwgcmVzYW1wbGluZyB0aGVyZS5cblxuY29uc3QgV09SS0xFVFMgPSBgXG5jbGFzcyBDYXB0dXJlIGV4dGVuZHMgQXVkaW9Xb3JrbGV0UHJvY2Vzc29yIHtcbiAgY29uc3RydWN0b3IoKSB7XG4gICAgc3VwZXIoKTtcbiAgICB0aGlzLnN0ZXAgPSBzYW1wbGVSYXRlIC8gMTYwMDA7XG4gICAgdGhpcy5wb3MgPSAwO1xuICAgIHRoaXMuZnJhbWUgPSBuZXcgSW50MTZBcnJheSgzMjApO1xuICAgIHRoaXMubiA9IDA7XG4gICAgLy8gQSB3aW5kb3dlZC1zaW5jIGxvdy1wYXNzIGF0IDcga0h6LCBzbyBub3RoaW5nIGFib3ZlIDE2IGtIeidzIDgga0h6IGxpbWl0IGZvbGRzIGJhY2sgaW50byBzcGVlY2guXG4gICAgY29uc3QgdGFwcyA9IDQ3LCBjdXQgPSA3MDAwIC8gc2FtcGxlUmF0ZTtcbiAgICB0aGlzLnRhcHMgPSBuZXcgRmxvYXQzMkFycmF5KHRhcHMpO1xuICAgIGxldCBzdW0gPSAwO1xuICAgIGZvciAobGV0IGsgPSAwOyBrIDwgdGFwczsgaysrKSB7XG4gICAgICBjb25zdCBtID0gayAtICh0YXBzIC0gMSkgLyAyO1xuICAgICAgY29uc3Qgc2luYyA9IG0gPT09IDAgPyAyICogY3V0IDogTWF0aC5zaW4oMiAqIE1hdGguUEkgKiBjdXQgKiBtKSAvIChNYXRoLlBJICogbSk7XG4gICAgICBjb25zdCB3ID0gMC40MiAtIDAuNSAqIE1hdGguY29zKCgyICogTWF0aC5QSSAqIGspIC8gKHRhcHMgLSAxKSkgKyAwLjA4ICogTWF0aC5jb3MoKDQgKiBNYXRoLlBJICogaykgLyAodGFwcyAtIDEpKTtcbiAgICAgIHRoaXMudGFwc1trXSA9IHNpbmMgKiB3O1xuICAgICAgc3VtICs9IHRoaXMudGFwc1trXTtcbiAgICB9XG4gICAgZm9yIChsZXQgayA9IDA7IGsgPCB0YXBzOyBrKyspIHRoaXMudGFwc1trXSAvPSBzdW07XG4gICAgdGhpcy5oaXN0b3J5ID0gbmV3IEZsb2F0MzJBcnJheSh0YXBzKTtcbiAgICB0aGlzLmF0ID0gMDtcbiAgfVxuICBwcm9jZXNzKGlucHV0cykge1xuICAgIGNvbnN0IGlucHV0ID0gaW5wdXRzWzBdICYmIGlucHV0c1swXVswXTtcbiAgICBpZiAoIWlucHV0KSByZXR1cm4gdHJ1ZTtcbiAgICBjb25zdCB0YXBzID0gdGhpcy50YXBzLCBoID0gdGhpcy5oaXN0b3J5LCBuID0gdGFwcy5sZW5ndGg7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBpbnB1dC5sZW5ndGg7IGkrKykge1xuICAgICAgaFt0aGlzLmF0XSA9IGlucHV0W2ldO1xuICAgICAgdGhpcy5hdCA9ICh0aGlzLmF0ICsgMSkgJSBuO1xuICAgICAgLy8gT25seSB0aGUgc2FtcGxlcyBrZXB0IG5lZWQgZmlsdGVyaW5nOiBhdCBtb3N0IG9uZSBpbiBldmVyeSBzdGVwLlxuICAgICAgaWYgKHRoaXMucG9zID4gMSkgeyB0aGlzLnBvcyAtPSAxOyBjb250aW51ZTsgfVxuICAgICAgbGV0IHggPSAwO1xuICAgICAgZm9yIChsZXQgayA9IDAsIGogPSB0aGlzLmF0OyBrIDwgbjsgaysrLCBqID0gaiArIDEgPT09IG4gPyAwIDogaiArIDEpIHggKz0gdGFwc1trXSAqIGhbal07XG4gICAgICB3aGlsZSAodGhpcy5wb3MgPD0gMSkge1xuICAgICAgICBjb25zdCBzID0gTWF0aC5tYXgoLTEsIE1hdGgubWluKDEsIHgpKTtcbiAgICAgICAgdGhpcy5mcmFtZVt0aGlzLm4rK10gPSBzIDwgMCA/IHMgKiAzMjc2OCA6IHMgKiAzMjc2NztcbiAgICAgICAgaWYgKHRoaXMubiA9PT0gdGhpcy5mcmFtZS5sZW5ndGgpIHtcbiAgICAgICAgICB0aGlzLnBvcnQucG9zdE1lc3NhZ2UodGhpcy5mcmFtZS5idWZmZXIsIFt0aGlzLmZyYW1lLmJ1ZmZlcl0pO1xuICAgICAgICAgIHRoaXMuZnJhbWUgPSBuZXcgSW50MTZBcnJheSgzMjApO1xuICAgICAgICAgIHRoaXMubiA9IDA7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5wb3MgKz0gdGhpcy5zdGVwO1xuICAgICAgfVxuICAgICAgdGhpcy5wb3MgLT0gMTtcbiAgICB9XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbn1cblxuY2xhc3MgUGxheWJhY2sgZXh0ZW5kcyBBdWRpb1dvcmtsZXRQcm9jZXNzb3Ige1xuICBjb25zdHJ1Y3RvcigpIHtcbiAgICBzdXBlcigpO1xuICAgIHRoaXMucXVldWUgPSBbXTsgICAgICAvLyBGbG9hdDMyQXJyYXlzIGF0IHRoZSBjb250ZXh0J3MgcmF0ZVxuICAgIHRoaXMub2Zmc2V0ID0gMDtcbiAgICB0aGlzLmN1ZXMgPSBbXTtcbiAgICB0aGlzLmN1ZU9mZnNldCA9IDA7XG4gICAgdGhpcy5yZXBvcnRlZCA9IDA7XG4gICAgdGhpcy5wb3J0Lm9ubWVzc2FnZSA9IChlKSA9PiB7XG4gICAgICBjb25zdCBtID0gZS5kYXRhO1xuICAgICAgaWYgKG0udHlwZSA9PT0gXCJwbGF5XCIpIHRoaXMucXVldWUucHVzaChtLnNhbXBsZXMpO1xuICAgICAgZWxzZSBpZiAobS50eXBlID09PSBcImN1ZVwiKSB0aGlzLmN1ZXMucHVzaChtLnNhbXBsZXMpO1xuICAgICAgZWxzZSBpZiAobS50eXBlID09PSBcImZsdXNoXCIpIHsgdGhpcy5xdWV1ZSA9IFtdOyB0aGlzLm9mZnNldCA9IDA7IH1cbiAgICAgIGVsc2UgaWYgKG0udHlwZSA9PT0gXCJzdG9wXCIpIHsgdGhpcy5xdWV1ZSA9IFtdOyB0aGlzLm9mZnNldCA9IDA7IHRoaXMuY3VlcyA9IFtdOyB0aGlzLmN1ZU9mZnNldCA9IDA7IH1cbiAgICB9O1xuICB9XG4gIHByb2Nlc3MoXywgb3V0cHV0cykge1xuICAgIGNvbnN0IG91dCA9IG91dHB1dHNbMF1bMF07XG4gICAgb3V0LmZpbGwoMCk7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoICYmIHRoaXMucXVldWUubGVuZ3RoOyBpKyspIHtcbiAgICAgIG91dFtpXSA9IHRoaXMucXVldWVbMF1bdGhpcy5vZmZzZXQrK107XG4gICAgICBpZiAodGhpcy5vZmZzZXQgPj0gdGhpcy5xdWV1ZVswXS5sZW5ndGgpIHsgdGhpcy5xdWV1ZS5zaGlmdCgpOyB0aGlzLm9mZnNldCA9IDA7IH1cbiAgICB9XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoICYmIHRoaXMuY3Vlcy5sZW5ndGg7IGkrKykge1xuICAgICAgb3V0W2ldID0gTWF0aC5tYXgoLTEsIE1hdGgubWluKDEsIG91dFtpXSArIHRoaXMuY3Vlc1swXVt0aGlzLmN1ZU9mZnNldCsrXSkpO1xuICAgICAgaWYgKHRoaXMuY3VlT2Zmc2V0ID49IHRoaXMuY3Vlc1swXS5sZW5ndGgpIHsgdGhpcy5jdWVzLnNoaWZ0KCk7IHRoaXMuY3VlT2Zmc2V0ID0gMDsgfVxuICAgIH1cbiAgICBmb3IgKGxldCBjID0gMTsgYyA8IG91dHB1dHNbMF0ubGVuZ3RoOyBjKyspIG91dHB1dHNbMF1bY10uc2V0KG91dCk7XG4gICAgaWYgKGN1cnJlbnRUaW1lIC0gdGhpcy5yZXBvcnRlZCA+IDAuMSkge1xuICAgICAgdGhpcy5yZXBvcnRlZCA9IGN1cnJlbnRUaW1lO1xuICAgICAgbGV0IHF1ZXVlZCA9IC10aGlzLm9mZnNldDtcbiAgICAgIGZvciAoY29uc3QgcSBvZiB0aGlzLnF1ZXVlKSBxdWV1ZWQgKz0gcS5sZW5ndGg7XG4gICAgICB0aGlzLnBvcnQucG9zdE1lc3NhZ2UoeyBxdWV1ZWQ6IHF1ZXVlZCAvIHNhbXBsZVJhdGUgfSk7XG4gICAgfVxuICAgIHJldHVybiB0cnVlO1xuICB9XG59XG5yZWdpc3RlclByb2Nlc3NvcihcImNhcHR1cmVcIiwgQ2FwdHVyZSk7XG5yZWdpc3RlclByb2Nlc3NvcihcInBsYXliYWNrXCIsIFBsYXliYWNrKTtcbmA7XG5cbmZ1bmN0aW9uIGJhc2U2NFRvQnl0ZXMoYjY0OiBzdHJpbmcpOiBVaW50OEFycmF5IHtcbiAgY29uc3QgYmluID0gYXRvYihiNjQpO1xuICBjb25zdCBvdXQgPSBuZXcgVWludDhBcnJheShiaW4ubGVuZ3RoKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBiaW4ubGVuZ3RoOyBpKyspIG91dFtpXSA9IGJpbi5jaGFyQ29kZUF0KGkpO1xuICByZXR1cm4gb3V0O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYnl0ZXNUb0Jhc2U2NChieXRlczogVWludDhBcnJheSk6IHN0cmluZyB7XG4gIGxldCBiaW4gPSBcIlwiO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGJ5dGVzLmxlbmd0aDsgaSArPSAweDgwMDApIGJpbiArPSBTdHJpbmcuZnJvbUNoYXJDb2RlKC4uLmJ5dGVzLnN1YmFycmF5KGksIGkgKyAweDgwMDApKTtcbiAgcmV0dXJuIGJ0b2EoYmluKTtcbn1cblxuLyoqIFBDTTE2IGxpdHRsZS1lbmRpYW4gYXQgW3JhdGVdLCBhcyBmbG9hdHMgYXQgdGhlIGNvbnRleHQncyByYXRlLiAqL1xuZnVuY3Rpb24gdG9GbG9hdHMocGNtOiBVaW50OEFycmF5LCByYXRlOiBudW1iZXIsIHRhcmdldDogbnVtYmVyKTogRmxvYXQzMkFycmF5IHtcbiAgY29uc3QgdmlldyA9IG5ldyBEYXRhVmlldyhwY20uYnVmZmVyLCBwY20uYnl0ZU9mZnNldCwgcGNtLmJ5dGVMZW5ndGgpO1xuICBjb25zdCBuID0gTWF0aC5mbG9vcihwY20uYnl0ZUxlbmd0aCAvIDIpO1xuICBjb25zdCBvdXQgPSBuZXcgRmxvYXQzMkFycmF5KE1hdGguZmxvb3IoKG4gKiB0YXJnZXQpIC8gcmF0ZSkpO1xuICBjb25zdCBzdGVwID0gcmF0ZSAvIHRhcmdldDtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCB4ID0gaSAqIHN0ZXA7XG4gICAgY29uc3QgaiA9IE1hdGguZmxvb3IoeCk7XG4gICAgY29uc3QgYSA9IHZpZXcuZ2V0SW50MTYoMiAqIE1hdGgubWluKGosIG4gLSAxKSwgdHJ1ZSk7XG4gICAgY29uc3QgYiA9IHZpZXcuZ2V0SW50MTYoMiAqIE1hdGgubWluKGogKyAxLCBuIC0gMSksIHRydWUpO1xuICAgIG91dFtpXSA9IChhICsgKGIgLSBhKSAqICh4IC0gaikpIC8gMzI3Njg7XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBNaWNPcHRpb25zIHsgZWNob0NhbmNlbGxhdGlvbjogYm9vbGVhbjsgbm9pc2VTdXBwcmVzc2lvbjogYm9vbGVhbjsgYXV0b0dhaW5Db250cm9sOiBib29sZWFuIH1cblxuZXhwb3J0IGNsYXNzIENhbGxBdWRpbyB7XG4gIHByaXZhdGUgY29udGV4dDogQXVkaW9Db250ZXh0IHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgcGxheWJhY2s6IEF1ZGlvV29ya2xldE5vZGUgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBjYXB0dXJlOiBBdWRpb1dvcmtsZXROb2RlIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgc3RyZWFtOiBNZWRpYVN0cmVhbSB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIHNvdXJjZTogTWVkaWFTdHJlYW1BdWRpb1NvdXJjZU5vZGUgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBtaWNPcHRzOiBNaWNPcHRpb25zIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgb25NaWNGcmFtZTogKChzYW1wbGVzOiBJbnQxNkFycmF5LCBsZXZlbDogbnVtYmVyKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuICAvKiogSW5jcmVtZW50ZWQgb24gZXZlcnkgc3RhcnRNaWMvc3RvcE1pYyBzbyBzdXBlcnNlZGVkIG9yIGNhbmNlbGxlZCBnZXRVc2VyTWVkaWEgY2FsbHMgbmV2ZXIgbGVhayB0cmFja3MuICovXG4gIHByaXZhdGUgbWljR2VuID0gMDtcbiAgcHJpdmF0ZSBvcGVuaW5nOiBQcm9taXNlPHZvaWQ+IHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgc3RhdGVMaXN0ZW5lcjogKCgpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XG4gIC8qKiBTZWNvbmRzIG9mIHNwZWVjaCBxdWV1ZWQsIGFzIHRoZSB3b3JrbGV0IGxhc3Qgc2FpZC4gKi9cbiAgcXVldWVkID0gMDtcbiAgLyoqIFRoZSBtaWNyb3Bob25lJ3MgbGV2ZWwsIFJNUyBvZiB0aGUgbGFzdCBmcmFtZSAoMCB0byAxKS4gKi9cbiAgbGV2ZWwgPSAwO1xuXG4gIG9uQXVkaW9TdGF0ZUNoYW5nZShsaXN0ZW5lcjogKCgpID0+IHZvaWQpIHwgbnVsbCk6IHZvaWQge1xuICAgIHRoaXMuc3RhdGVMaXN0ZW5lciA9IGxpc3RlbmVyO1xuICB9XG5cbiAgLyoqIFRydWUgd2hlbiBhbiBBdWRpb0NvbnRleHQgZXhpc3RzIGJ1dCB0aGUgYnJvd3NlciBzdXNwZW5kZWQgaXQgcGVuZGluZyBhIHVzZXIgZ2VzdHVyZS4gKi9cbiAgZ2V0IGF1ZGlvU3VzcGVuZGVkKCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLmNvbnRleHQgIT0gbnVsbCAmJiB0aGlzLmNvbnRleHQuc3RhdGUgIT09IFwicnVubmluZ1wiO1xuICB9XG5cbiAgYXN5bmMgcmVzdW1lQXVkaW8oKTogUHJvbWlzZTxib29sZWFuPiB7XG4gICAgY29uc3QgY3R4ID0gdGhpcy5jb250ZXh0O1xuICAgIGlmICghY3R4KSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKGN0eC5zdGF0ZSA9PT0gXCJydW5uaW5nXCIpIHJldHVybiB0cnVlO1xuICAgIHRyeSB7IGF3YWl0IGN0eC5yZXN1bWUoKTsgfSBjYXRjaCB7fVxuICAgIHJldHVybiAoY3R4LnN0YXRlIGFzIEF1ZGlvQ29udGV4dFN0YXRlKSA9PT0gXCJydW5uaW5nXCI7XG4gIH1cblxuICBhc3luYyBvcGVuKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICh0aGlzLm9wZW5pbmcpIHtcbiAgICAgIGF3YWl0IHRoaXMub3BlbmluZztcbiAgICAgIGlmICh0aGlzLmNvbnRleHQ/LnN0YXRlID09PSBcInN1c3BlbmRlZFwiKSBhd2FpdCB0aGlzLmNvbnRleHQucmVzdW1lKCkuY2F0Y2goKCkgPT4ge30pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAodGhpcy5jb250ZXh0KSB7IGlmICh0aGlzLmNvbnRleHQuc3RhdGUgPT09IFwic3VzcGVuZGVkXCIpIGF3YWl0IHRoaXMuY29udGV4dC5yZXN1bWUoKS5jYXRjaCgoKSA9PiB7fSk7IHJldHVybjsgfVxuICAgIGNvbnN0IGluaXQgPSAoYXN5bmMgKCkgPT4ge1xuICAgICAgbGV0IGN0eDogQXVkaW9Db250ZXh0IHwgbnVsbCA9IG51bGw7XG4gICAgICB0cnkge1xuICAgICAgICBjdHggPSBuZXcgQXVkaW9Db250ZXh0KHsgbGF0ZW5jeUhpbnQ6IFwiaW50ZXJhY3RpdmVcIiB9KTtcbiAgICAgICAgY3R4Lm9uc3RhdGVjaGFuZ2UgPSAoKSA9PiB0aGlzLnN0YXRlTGlzdGVuZXI/LigpO1xuICAgICAgICBjb25zdCB1cmwgPSBVUkwuY3JlYXRlT2JqZWN0VVJMKG5ldyBCbG9iKFtXT1JLTEVUU10sIHsgdHlwZTogXCJ0ZXh0L2phdmFzY3JpcHRcIiB9KSk7XG4gICAgICAgIGF3YWl0IGN0eC5hdWRpb1dvcmtsZXQuYWRkTW9kdWxlKHVybCk7XG4gICAgICAgIGNvbnN0IHBsYXliYWNrID0gbmV3IEF1ZGlvV29ya2xldE5vZGUoY3R4LCBcInBsYXliYWNrXCIsIHsgbnVtYmVyT2ZJbnB1dHM6IDAsIG91dHB1dENoYW5uZWxDb3VudDogWzJdIH0pO1xuICAgICAgICBwbGF5YmFjay5wb3J0Lm9ubWVzc2FnZSA9IChlKSA9PiB7IHRoaXMucXVldWVkID0gZS5kYXRhLnF1ZXVlZDsgfTtcbiAgICAgICAgcGxheWJhY2suY29ubmVjdChjdHguZGVzdGluYXRpb24pO1xuICAgICAgICB0aGlzLmNvbnRleHQgPSBjdHg7XG4gICAgICAgIHRoaXMucGxheWJhY2sgPSBwbGF5YmFjaztcbiAgICAgICAgdGhpcy5zdGF0ZUxpc3RlbmVyPy4oKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICB0cnkgeyBhd2FpdCBjdHg/LmNsb3NlPy4oKTsgfSBjYXRjaCB7fVxuICAgICAgICB0aHJvdyBlcnI7XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICB0aGlzLm9wZW5pbmcgPSBudWxsO1xuICAgICAgfVxuICAgIH0pKCk7XG4gICAgdGhpcy5vcGVuaW5nID0gaW5pdDtcbiAgICBhd2FpdCBpbml0O1xuICB9XG5cbiAgLyoqIFNlY29uZHMgZnJvbSBhIHNhbXBsZSBsZWF2aW5nIHRoZSB3b3JrbGV0IHRvIHRoZSBzcGVha2VyLCBhcyB0aGUgYnJvd3NlciByZWNrb25zIGl0LiAqL1xuICBnZXQgb3V0cHV0TGF0ZW5jeSgpOiBudW1iZXIgfCBudWxsIHtcbiAgICBpZiAoIXRoaXMuY29udGV4dCkgcmV0dXJuIG51bGw7XG4gICAgcmV0dXJuIHRoaXMuY29udGV4dC5iYXNlTGF0ZW5jeSArICgodGhpcy5jb250ZXh0IGFzIEF1ZGlvQ29udGV4dCAmIHsgb3V0cHV0TGF0ZW5jeT86IG51bWJlciB9KS5vdXRwdXRMYXRlbmN5ID8/IDApO1xuICB9XG5cbiAgZ2V0IG1pY0FjdGl2ZSgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5jYXB0dXJlICE9IG51bGwgJiYgdGhpcy5zdHJlYW0gIT0gbnVsbCAmJiB0aGlzLnN0cmVhbS5nZXRUcmFja3MoKS5zb21lKCh0KSA9PiB0LnJlYWR5U3RhdGUgPT09IFwibGl2ZVwiKTtcbiAgfVxuXG4gIC8qKiBTdGFydHMgdGhlIG1pY3JvcGhvbmUgaWYgaXQgaXNuJ3QgYWxyZWFkeSBydW5uaW5nIHdpdGggdGhlIHNhbWUgb3B0aW9uczsgb3RoZXJ3aXNlIHN3YXBzIHRoZSBmcmFtZSBjYWxsYmFjayBjbGVhbmx5LiAqL1xuICBhc3luYyBlbnN1cmVNaWMob25GcmFtZTogKHNhbXBsZXM6IEludDE2QXJyYXksIGxldmVsOiBudW1iZXIpID0+IHZvaWQsIG9wdGlvbnM6IE1pY09wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAoXG4gICAgICB0aGlzLm1pY0FjdGl2ZSAmJlxuICAgICAgdGhpcy5taWNPcHRzICYmXG4gICAgICB0aGlzLm1pY09wdHMuZWNob0NhbmNlbGxhdGlvbiA9PT0gb3B0aW9ucy5lY2hvQ2FuY2VsbGF0aW9uICYmXG4gICAgICB0aGlzLm1pY09wdHMubm9pc2VTdXBwcmVzc2lvbiA9PT0gb3B0aW9ucy5ub2lzZVN1cHByZXNzaW9uICYmXG4gICAgICB0aGlzLm1pY09wdHMuYXV0b0dhaW5Db250cm9sID09PSBvcHRpb25zLmF1dG9HYWluQ29udHJvbFxuICAgICkge1xuICAgICAgYXdhaXQgdGhpcy5vcGVuKCk7XG4gICAgICB0aGlzLm9uTWljRnJhbWUgPSBvbkZyYW1lO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBhd2FpdCB0aGlzLnN0YXJ0TWljKG9uRnJhbWUsIG9wdGlvbnMpO1xuICB9XG5cbiAgYXN5bmMgc3RhcnRNaWMob25GcmFtZTogKHNhbXBsZXM6IEludDE2QXJyYXksIGxldmVsOiBudW1iZXIpID0+IHZvaWQsIG9wdGlvbnM6IE1pY09wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICB0aGlzLnN0b3BNaWMoKTtcbiAgICBjb25zdCBnZW4gPSArK3RoaXMubWljR2VuO1xuICAgIGF3YWl0IHRoaXMub3BlbigpO1xuICAgIGlmIChnZW4gIT09IHRoaXMubWljR2VuKSByZXR1cm47XG4gICAgY29uc3QgY29udGV4dCA9IHRoaXMuY29udGV4dCE7XG4gICAgY29uc3Qgc3RyZWFtID0gYXdhaXQgbmF2aWdhdG9yLm1lZGlhRGV2aWNlcy5nZXRVc2VyTWVkaWEoeyBhdWRpbzogeyBjaGFubmVsQ291bnQ6IDEsIC4uLm9wdGlvbnMgfSB9KTtcbiAgICBpZiAoZ2VuICE9PSB0aGlzLm1pY0dlbikge1xuICAgICAgc3RyZWFtLmdldFRyYWNrcygpLmZvckVhY2goKHQpID0+IHQuc3RvcCgpKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgbGV0IHNvdXJjZTogTWVkaWFTdHJlYW1BdWRpb1NvdXJjZU5vZGUgfCBudWxsID0gbnVsbDtcbiAgICBsZXQgY2FwdHVyZTogQXVkaW9Xb3JrbGV0Tm9kZSB8IG51bGwgPSBudWxsO1xuICAgIHRyeSB7XG4gICAgICBzb3VyY2UgPSBjb250ZXh0LmNyZWF0ZU1lZGlhU3RyZWFtU291cmNlKHN0cmVhbSk7XG4gICAgICBjYXB0dXJlID0gbmV3IEF1ZGlvV29ya2xldE5vZGUoY29udGV4dCwgXCJjYXB0dXJlXCIsIHsgbnVtYmVyT2ZPdXRwdXRzOiAwIH0pO1xuICAgICAgY2FwdHVyZS5wb3J0Lm9ubWVzc2FnZSA9IChlKSA9PiB7XG4gICAgICAgIGNvbnN0IGZyYW1lID0gbmV3IEludDE2QXJyYXkoZS5kYXRhIGFzIEFycmF5QnVmZmVyKTtcbiAgICAgICAgbGV0IHN1bSA9IDA7XG4gICAgICAgIGZvciAoY29uc3QgcyBvZiBmcmFtZSkgc3VtICs9IHMgKiBzO1xuICAgICAgICB0aGlzLmxldmVsID0gTWF0aC5zcXJ0KHN1bSAvIGZyYW1lLmxlbmd0aCkgLyAzMjc2ODtcbiAgICAgICAgdGhpcy5vbk1pY0ZyYW1lPy4oZnJhbWUsIHRoaXMubGV2ZWwpO1xuICAgICAgfTtcbiAgICAgIHNvdXJjZS5jb25uZWN0KGNhcHR1cmUpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgc291cmNlPy5kaXNjb25uZWN0KCk7XG4gICAgICBjYXB0dXJlPy5wb3J0LmNsb3NlKCk7XG4gICAgICBzdHJlYW0uZ2V0VHJhY2tzKCkuZm9yRWFjaCgodCkgPT4gdC5zdG9wKCkpO1xuICAgICAgdGhyb3cgZXJyO1xuICAgIH1cbiAgICB0aGlzLnN0cmVhbSA9IHN0cmVhbTtcbiAgICB0aGlzLm1pY09wdHMgPSB7IC4uLm9wdGlvbnMgfTtcbiAgICB0aGlzLm9uTWljRnJhbWUgPSBvbkZyYW1lO1xuICAgIHRoaXMuc291cmNlID0gc291cmNlO1xuICAgIHRoaXMuY2FwdHVyZSA9IGNhcHR1cmU7XG4gIH1cblxuICBzdG9wTWljKCk6IHZvaWQge1xuICAgIHRoaXMubWljR2VuKys7XG4gICAgdGhpcy5zb3VyY2U/LmRpc2Nvbm5lY3QoKTtcbiAgICB0aGlzLmNhcHR1cmU/LnBvcnQuY2xvc2UoKTtcbiAgICB0aGlzLnN0cmVhbT8uZ2V0VHJhY2tzKCkuZm9yRWFjaCgodCkgPT4gdC5zdG9wKCkpO1xuICAgIHRoaXMuc291cmNlID0gbnVsbDtcbiAgICB0aGlzLmNhcHR1cmUgPSBudWxsO1xuICAgIHRoaXMuc3RyZWFtID0gbnVsbDtcbiAgICB0aGlzLm1pY09wdHMgPSBudWxsO1xuICAgIHRoaXMub25NaWNGcmFtZSA9IG51bGw7XG4gICAgdGhpcy5sZXZlbCA9IDA7XG4gIH1cblxuICBwbGF5KHBjbTY0OiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuY29udGV4dCB8fCAhdGhpcy5wbGF5YmFjaykgcmV0dXJuO1xuICAgIGNvbnN0IHNhbXBsZXMgPSB0b0Zsb2F0cyhiYXNlNjRUb0J5dGVzKHBjbTY0KSwgMjQwMDAsIHRoaXMuY29udGV4dC5zYW1wbGVSYXRlKTtcbiAgICB0aGlzLnBsYXliYWNrLnBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcInBsYXlcIiwgc2FtcGxlcyB9LCBbc2FtcGxlcy5idWZmZXJdKTtcbiAgfVxuXG4gIGN1ZShwY202NDogc3RyaW5nKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLmNvbnRleHQgfHwgIXRoaXMucGxheWJhY2spIHJldHVybjtcbiAgICBjb25zdCBzYW1wbGVzID0gdG9GbG9hdHMoYmFzZTY0VG9CeXRlcyhwY202NCksIDI0MDAwLCB0aGlzLmNvbnRleHQuc2FtcGxlUmF0ZSk7XG4gICAgdGhpcy5wbGF5YmFjay5wb3J0LnBvc3RNZXNzYWdlKHsgdHlwZTogXCJjdWVcIiwgc2FtcGxlcyB9LCBbc2FtcGxlcy5idWZmZXJdKTtcbiAgfVxuXG4gIGZsdXNoKCk6IHZvaWQge1xuICAgIHRoaXMucGxheWJhY2s/LnBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcImZsdXNoXCIgfSk7XG4gIH1cblxuICBzdG9wUGxheWJhY2soKTogdm9pZCB7XG4gICAgdGhpcy5wbGF5YmFjaz8ucG9ydC5wb3N0TWVzc2FnZSh7IHR5cGU6IFwic3RvcFwiIH0pO1xuICAgIHRoaXMucXVldWVkID0gMDtcbiAgfVxuXG4gIHN0b3AoKTogdm9pZCB7XG4gICAgdGhpcy5zdG9wTWljKCk7XG4gICAgdGhpcy5zdG9wUGxheWJhY2soKTtcbiAgfVxufVxuIiwgIi8vIFRoZSByZXBsYXkgdmlldzogYSByZWNvcmRlZCBjYWxsIChhIHRyYWNlIGZyb20gYW55IGhvc3QsIG9yIGEgc2NlbmFyaW8pIHJ1biBhZ2FpbiB0aHJvdWdoIHRoZVxuLy8gY29yZSwgYXMgdGhlIGJ1aWxkIHRoYXQgcmVjb3JkZWQgaXQgZGlkIGFuZCBhcyB0aGUgbGF0ZXN0IGRvZXMsIHNpZGUgYnkgc2lkZS4gV2hlcmUgdGhleSBwYXJ0XG4vLyBpcyB3aGVyZSBhIGNoYW5nZSBpbiBzcmMvIGNoYW5nZWQgd2hhdCB0aGUgY2FsbCBkb2VzIHdpdGggdGhlIHNhbWUgd29yZHMgYW5kIHRoZSBzYW1lIG1vZGVsLlxuXG5pbnRlcmZhY2UgQ29yZSB7XG4gIHZlcnNpb246IHN0cmluZztcbiAgY3JlYXRlKGNvbmZpZzogc3RyaW5nLCB0OiBudW1iZXIpOiBzdHJpbmc7XG4gIHB1c2goaWQ6IG51bWJlciwgZXZlbnQ6IHN0cmluZyk6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFJlY29yZGluZyB7IHZlcnNpb24/OiBzdHJpbmc7IGNvbmZpZzogdW5rbm93bjsgc3RhcnQ6IG51bWJlcjsgZXZlbnRzOiBSZWNvcmQ8c3RyaW5nLCBhbnk+W10gfVxuXG4vKiogV2hhdCBhIGNvbW1hbmQgb3IgZXZlbnQgbG9va3MgbGlrZSBpbiBhIHRpbWVsaW5lOiBhdWRpbyBjdXQgb3V0LCBvbmUgbGluZS4gKi9cbmZ1bmN0aW9uIGxpbmUobzogUmVjb3JkPHN0cmluZywgYW55Pik6IHN0cmluZyB7XG4gIGNvbnN0IHRleHQgPSBKU09OLnN0cmluZ2lmeShvKS5yZXBsYWNlKC9cIihkYXRhfHBjbSlcIjpcIltBLVphLXowLTkrLz1dezQwLH1cIi9nLCAnXCIkMVwiOlwiXHUyMDI2XCInKVxuICAgIC5yZXBsYWNlKC9cXFxcXCJkYXRhXFxcXFwiOlxcXFxcIltBLVphLXowLTkrLz1dezQwLH1cXFxcXCIvZywgJ1xcXFxcImRhdGFcXFxcXCI6XFxcXFwiXHUyMDI2XFxcXFwiJyk7XG4gIHJldHVybiB0ZXh0Lmxlbmd0aCA+IDQwMCA/IHRleHQuc2xpY2UoMCwgNDAwKSArIFwiXHUyMDI2XCIgOiB0ZXh0O1xufVxuXG4vKiogQXVkaW8gYW5kIHRpY2tzIHNheSBub3RoaW5nIGEgcmVhZGVyIG5lZWRzOyB0aGUgcmVzdCBkb2VzLiAqL1xuZnVuY3Rpb24gdGVsbGluZyhvOiBSZWNvcmQ8c3RyaW5nLCBhbnk+KTogYm9vbGVhbiB7XG4gIGlmIChvLnR5cGUgPT09IFwibWljXCIgfHwgby50eXBlID09PSBcInRpY2tcIiB8fCBvLnR5cGUgPT09IFwicGxheVwiKSByZXR1cm4gZmFsc2U7XG4gIGlmIChvLnR5cGUgPT09IFwid3Muc2VuZFwiICYmIFN0cmluZyhvLmRhdGEpLnN0YXJ0c1dpdGgoJ3tcInJlYWx0aW1lSW5wdXRcIjp7XCJhdWRpb1wiJykpIHJldHVybiBmYWxzZTtcbiAgaWYgKG8udHlwZSA9PT0gXCJ3cy5tZXNzYWdlXCIgJiYgU3RyaW5nKG8uZGF0YSkuaW5jbHVkZXMoJ1wiaW5saW5lRGF0YVwiJykgJiYgIVN0cmluZyhvLmRhdGEpLmluY2x1ZGVzKCdcInR1cm5Db21wbGV0ZVwiJykpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmZ1bmN0aW9uIHJ1bihjb3JlOiBDb3JlLCByOiBSZWNvcmRpbmcpOiBzdHJpbmdbXVtdIHtcbiAgY29uc3QgY3JlYXRlZCA9IEpTT04ucGFyc2UoY29yZS5jcmVhdGUoSlNPTi5zdHJpbmdpZnkoci5jb25maWcpLCByLnN0YXJ0KSk7XG4gIGNvbnN0IG91dDogc3RyaW5nW11bXSA9IFtjcmVhdGVkLmNvbW1hbmRzLmZpbHRlcih0ZWxsaW5nKS5tYXAobGluZSldO1xuICBmb3IgKGNvbnN0IGUgb2Ygci5ldmVudHMpIG91dC5wdXNoKChKU09OLnBhcnNlKGNvcmUucHVzaChjcmVhdGVkLmlkLCBKU09OLnN0cmluZ2lmeShlKSkpIGFzIFJlY29yZDxzdHJpbmcsIGFueT5bXSkuZmlsdGVyKHRlbGxpbmcpLm1hcChsaW5lKSk7XG4gIHJldHVybiBvdXQ7XG59XG5cbmV4cG9ydCBjbGFzcyBSZXBsYXkge1xuICBwcml2YXRlIHJlYWRvbmx5IHJvb3Q6IEhUTUxFbGVtZW50O1xuICBwcml2YXRlIHJlYWRvbmx5IGxvYWQ6ICh1cmw/OiBzdHJpbmcpID0+IFByb21pc2U8Q29yZT47XG5cbiAgY29uc3RydWN0b3Iocm9vdDogSFRNTEVsZW1lbnQsIGxvYWQ6ICh1cmw/OiBzdHJpbmcpID0+IFByb21pc2U8Q29yZT4pIHtcbiAgICB0aGlzLnJvb3QgPSByb290O1xuICAgIHRoaXMubG9hZCA9IGxvYWQ7XG4gICAgcm9vdC5pbm5lckhUTUwgPSBgXG4gICAgICA8aDI+VHJhY2UgcmVwbGF5PC9oMj5cbiAgICAgIDxkaXYgY2xhc3M9XCJiYXJcIj48c2VsZWN0IGNsYXNzPVwicGlja1wiIGFyaWEtbGFiZWw9XCJSZWNvcmRpbmdcIj48L3NlbGVjdD48YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cInJlZnJlc2hcIiB0aXRsZT1cIlJlZnJlc2ggbGlzdFwiIGFyaWEtbGFiZWw9XCJSZWZyZXNoIGxpc3RcIj5cdTIxQkI8L2J1dHRvbj48YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cImdvXCI+UmVwbGF5PC9idXR0b24+XG4gICAgICA8bGFiZWwgY2xhc3M9XCJ0b2dnbGUtYWxsXCI+PGlucHV0IHR5cGU9XCJjaGVja2JveFwiIGNsYXNzPVwiYWxsXCI+IFNob3cgYXVkaW8gYW5kIHRpY2tzPC9sYWJlbD48c3BhbiBjbGFzcz1cInN1bW1hcnlcIj48L3NwYW4+PC9kaXY+XG4gICAgICA8ZGl2IGNsYXNzPVwidGltZWxpbmVcIj48L2Rpdj5gO1xuICAgIChyb290LnF1ZXJ5U2VsZWN0b3IoXCIucmVmcmVzaFwiKSBhcyBIVE1MRWxlbWVudCkub25jbGljayA9ICgpID0+IHZvaWQgdGhpcy5saXN0KCk7XG4gICAgKHJvb3QucXVlcnlTZWxlY3RvcihcIi5nb1wiKSBhcyBIVE1MRWxlbWVudCkub25jbGljayA9ICgpID0+IHZvaWQgdGhpcy5yZXBsYXkoKS5jYXRjaCgoZXJyKSA9PiB0aGlzLnNheShgUmVwbGF5IGZhaWxlZDogJHtlcnIubWVzc2FnZX1gKSk7XG4gICAgdm9pZCB0aGlzLmxpc3QoKTtcbiAgfVxuXG4gIHByaXZhdGUgc2F5KHRleHQ6IHN0cmluZykge1xuICAgICh0aGlzLnJvb3QucXVlcnlTZWxlY3RvcihcIi5zdW1tYXJ5XCIpIGFzIEhUTUxFbGVtZW50KS50ZXh0Q29udGVudCA9IHRleHQ7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGxpc3QoKSB7XG4gICAgY29uc3QgcGljayA9IHRoaXMucm9vdC5xdWVyeVNlbGVjdG9yKFwiLnBpY2tcIikgYXMgSFRNTFNlbGVjdEVsZW1lbnQ7XG4gICAgcGljay5pbm5lckhUTUwgPSBcIlwiO1xuICAgIGNvbnN0IHRyYWNlczogeyBuYW1lOiBzdHJpbmc7IGJ5dGVzOiBudW1iZXIgfVtdID0gYXdhaXQgKGF3YWl0IGZldGNoKFwiL3RyYWNlc1wiKSkuanNvbigpO1xuICAgIGNvbnN0IHNjZW5hcmlvczogc3RyaW5nW10gPSBhd2FpdCAoYXdhaXQgZmV0Y2goXCIvc2NlbmFyaW9zXCIpKS5qc29uKCk7XG4gICAgY29uc3QgdHJhY2VHcm91cCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJvcHRncm91cFwiKTtcbiAgICB0cmFjZUdyb3VwLmxhYmVsID0gXCJSZWNvcmRlZCBjYWxsc1wiO1xuICAgIGZvciAoY29uc3QgdCBvZiB0cmFjZXMpIHRyYWNlR3JvdXAuYXBwZW5kKG5ldyBPcHRpb24oYCR7dC5uYW1lfSAoJHtNYXRoLnJvdW5kKHQuYnl0ZXMgLyAxMDI0KX0gS0IpYCwgYC90cmFjZXMvJHt0Lm5hbWV9YCkpO1xuICAgIGNvbnN0IHNjZW5hcmlvR3JvdXAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwib3B0Z3JvdXBcIik7XG4gICAgc2NlbmFyaW9Hcm91cC5sYWJlbCA9IFwiU2NlbmFyaW9zXCI7XG4gICAgZm9yIChjb25zdCBzIG9mIHNjZW5hcmlvcykgc2NlbmFyaW9Hcm91cC5hcHBlbmQobmV3IE9wdGlvbihzLCBgL3NjZW5hcmlvcy8ke3N9Lmpzb25gKSk7XG4gICAgcGljay5hcHBlbmQodHJhY2VHcm91cCwgc2NlbmFyaW9Hcm91cCk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHJlY29yZGluZyh1cmw6IHN0cmluZyk6IFByb21pc2U8UmVjb3JkaW5nPiB7XG4gICAgY29uc3QgdGV4dCA9IGF3YWl0IChhd2FpdCBmZXRjaCh1cmwsIHsgY2FjaGU6IFwibm8tc3RvcmVcIiB9KSkudGV4dCgpO1xuICAgIGlmICh1cmwuZW5kc1dpdGgoXCIuanNvblwiKSkgcmV0dXJuIEpTT04ucGFyc2UodGV4dCk7XG4gICAgY29uc3QgW2hlYWRlciwgLi4uZXZlbnRzXSA9IHRleHQudHJpbSgpLnNwbGl0KFwiXFxuXCIpLm1hcCgobCkgPT4gSlNPTi5wYXJzZShsKSk7XG4gICAgcmV0dXJuIHsgLi4uaGVhZGVyLCBldmVudHMgfTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgcmVwbGF5KCkge1xuICAgIGNvbnN0IHVybCA9ICh0aGlzLnJvb3QucXVlcnlTZWxlY3RvcihcIi5waWNrXCIpIGFzIEhUTUxTZWxlY3RFbGVtZW50KS52YWx1ZTtcbiAgICBpZiAoIXVybCkgcmV0dXJuO1xuICAgIGNvbnN0IHIgPSBhd2FpdCB0aGlzLnJlY29yZGluZyh1cmwpO1xuICAgIGNvbnN0IGxhdGVzdCA9IGF3YWl0IHRoaXMubG9hZCgpO1xuICAgIGxldCByZWNvcmRlZDogQ29yZSB8IG51bGwgPSBudWxsO1xuICAgIGlmIChyLnZlcnNpb24gJiYgci52ZXJzaW9uICE9PSBsYXRlc3QudmVyc2lvbikge1xuICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChgL3ZlcnNpb25zLyR7ci52ZXJzaW9ufS5qc2AsIHsgbWV0aG9kOiBcIkhFQURcIiB9KTtcbiAgICAgIGlmIChyZXNwb25zZS5vaykgcmVjb3JkZWQgPSBhd2FpdCB0aGlzLmxvYWQoYC92ZXJzaW9ucy8ke3IudmVyc2lvbn0uanNgKTtcbiAgICB9XG4gICAgY29uc3Qgbm93ID0gcnVuKGxhdGVzdCwgcik7XG4gICAgY29uc3QgdGhlbiA9IHJlY29yZGVkID8gcnVuKHJlY29yZGVkLCByKSA6IG51bGw7XG4gICAgY29uc3QgYWxsID0gKHRoaXMucm9vdC5xdWVyeVNlbGVjdG9yKFwiLmFsbFwiKSBhcyBIVE1MSW5wdXRFbGVtZW50KS5jaGVja2VkO1xuICAgIGNvbnN0IHRpbWVsaW5lID0gdGhpcy5yb290LnF1ZXJ5U2VsZWN0b3IoXCIudGltZWxpbmVcIikgYXMgSFRNTEVsZW1lbnQ7XG4gICAgdGltZWxpbmUuaW5uZXJIVE1MID0gXCJcIjtcbiAgICBsZXQgZmlyc3QgPSAtMTtcbiAgICBsZXQgZGlmZmVyID0gMDtcbiAgICBjb25zdCByb3dzOiBIVE1MRWxlbWVudFtdID0gW107XG4gICAgY29uc3QgYWRkID0gKGNsczogc3RyaW5nLCB0OiBzdHJpbmcsIHRleHQ6IHN0cmluZykgPT4ge1xuICAgICAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgIHJvdy5jbGFzc05hbWUgPSBgcm93ICR7Y2xzfWA7XG4gICAgICByb3cuaW5uZXJIVE1MID0gYDxzcGFuIGNsYXNzPVwidFwiPiR7dH08L3NwYW4+YDtcbiAgICAgIGNvbnN0IGIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgICAgIGIuY2xhc3NOYW1lID0gXCJiXCI7XG4gICAgICBiLnRleHRDb250ZW50ID0gdGV4dDtcbiAgICAgIHJvdy5hcHBlbmQoYik7XG4gICAgICB0aW1lbGluZS5hcHBlbmQocm93KTtcbiAgICAgIHJvd3MucHVzaChyb3cpO1xuICAgICAgcmV0dXJuIHJvdztcbiAgICB9O1xuICAgIGNvbnN0IHQwID0gci5zdGFydDtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8PSByLmV2ZW50cy5sZW5ndGg7IGkrKykge1xuICAgICAgY29uc3QgZSA9IGkgPT09IDAgPyBudWxsIDogci5ldmVudHNbaSAtIDFdO1xuICAgICAgY29uc3Qgbm93T3V0ID0gbm93W2ldO1xuICAgICAgY29uc3QgdGhlbk91dCA9IHRoZW4gPyB0aGVuW2ldIDogbm93T3V0O1xuICAgICAgY29uc3Qgc2FtZSA9IG5vd091dC5sZW5ndGggPT09IHRoZW5PdXQubGVuZ3RoICYmIG5vd091dC5ldmVyeSgoYywgaikgPT4gYyA9PT0gdGhlbk91dFtqXSk7XG4gICAgICBpZiAoIXNhbWUpIHsgZGlmZmVyKys7IGlmIChmaXJzdCA8IDApIGZpcnN0ID0gaTsgfVxuICAgICAgaWYgKCFzYW1lIHx8IGFsbCB8fCAoZSAmJiB0ZWxsaW5nKGUpKSB8fCBub3dPdXQubGVuZ3RoID4gMCkge1xuICAgICAgICBpZiAoZSAmJiAoYWxsIHx8IHRlbGxpbmcoZSkgfHwgIXNhbWUpKSBhZGQoXCJpblwiLCAoZS50IC0gdDApLnRvRml4ZWQoMiksIGxpbmUoZSkpO1xuICAgICAgICBjb25zdCB0ID0gZSA/IChlLnQgLSB0MCkudG9GaXhlZCgyKSA6IFwiMC4wMFwiO1xuICAgICAgICBpZiAoc2FtZSkgZm9yIChjb25zdCBjIG9mIG5vd091dCkgYWRkKFwib3V0XCIsIHQsIGMpO1xuICAgICAgICBlbHNlIHtcbiAgICAgICAgICBmb3IgKGNvbnN0IGMgb2YgdGhlbk91dCkgYWRkKFwib3V0IGdvbmVcIiwgdCwgYFx1MjIxMiAke2N9YCk7XG4gICAgICAgICAgZm9yIChjb25zdCBjIG9mIG5vd091dCkgYWRkKFwib3V0IG5ld1wiLCB0LCBgKyAke2N9YCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgY29uc3QgdmVyc2lvbnMgPSB0aGVuID8gYHJlY29yZGVkIGJ5ICR7ci52ZXJzaW9ufSwgcmVwbGF5ZWQgYnkgaXQgYW5kIGJ5ICR7bGF0ZXN0LnZlcnNpb259YCA6IGByZXBsYXllZCBieSAke2xhdGVzdC52ZXJzaW9ufWAgK1xuICAgICAgKHIudmVyc2lvbiAmJiByLnZlcnNpb24gIT09IGxhdGVzdC52ZXJzaW9uID8gYCAodGhlIHJlY29yZGluZydzIGJ1aWxkICR7ci52ZXJzaW9ufSBpc24ndCBrZXB0IGhlcmUpYCA6IFwiXCIpO1xuICAgIHRoaXMuc2F5KGAke3IuZXZlbnRzLmxlbmd0aH0gZXZlbnRzLCAke3ZlcnNpb25zfS4gYCArICh0aGVuID8gKGRpZmZlciA/IGAke2RpZmZlcn0gZXZlbnRzIGFuc3dlcmVkIGRpZmZlcmVudGx5LCB0aGUgZmlyc3QgYXQgZXZlbnQgJHtmaXJzdH0uYCA6IFwiQm90aCBhbnN3ZXJlZCBldmVyeSBldmVudCB0aGUgc2FtZS5cIikgOiBcIlwiKSk7XG4gICAgaWYgKGZpcnN0ID49IDApIHRpbWVsaW5lLnF1ZXJ5U2VsZWN0b3IoXCIuZ29uZSwgLm5ld1wiKT8uc2Nyb2xsSW50b1ZpZXcoeyBibG9jazogXCJjZW50ZXJcIiB9KTtcbiAgfVxufVxuIiwgIi8qKiBNaW5pbWFsIHNjcm9sbGluZyBwYW5lIHN1cmZhY2Ugc28gYXV0by1zY3JvbGwgbG9naWMgc3RheXMgdGVzdGFibGUgd2l0aG91dCBhIGJyb3dzZXIgRE9NLiAqL1xuZXhwb3J0IGludGVyZmFjZSBTY3JvbGxQYW5lIHtcbiAgc2Nyb2xsVG9wOiBudW1iZXI7XG4gIHJlYWRvbmx5IHNjcm9sbEhlaWdodDogbnVtYmVyO1xuICByZWFkb25seSBjbGllbnRIZWlnaHQ6IG51bWJlcjtcbiAgc2Nyb2xsVG8/KG9wdGlvbnM6IHsgdG9wOiBudW1iZXI7IGJlaGF2aW9yPzogU2Nyb2xsQmVoYXZpb3IgfSk6IHZvaWQ7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXV0b1Njcm9sbGVyT3B0aW9ucyB7XG4gIC8qKiBEaXN0YW5jZSBmcm9tIHRoZSBib3R0b20gKHB4KSB0aGF0IHN0aWxsIGNvdW50cyBhcyBwaW5uZWQuICovXG4gIHBpblRocmVzaG9sZD86IG51bWJlcjtcbiAgLyoqIERpc3RhbmNlIGZyb20gdGhlIGJvdHRvbSAocHgpIHBhc3Qgd2hpY2ggdGhlIGp1bXAtdG8tbGF0ZXN0IGNvbnRyb2wgaXMgc2hvd24uICovXG4gIGp1bXBUaHJlc2hvbGQ/OiBudW1iZXI7XG4gIC8qKiBDYWxsZWQgd2hlbmV2ZXIgdGhlIGp1bXAtdG8tbGF0ZXN0IGNvbnRyb2wncyB2aXNpYmlsaXR5IG1heSBoYXZlIGNoYW5nZWQuICovXG4gIG9uSnVtcENoYW5nZT86IChzaG93OiBib29sZWFuKSA9PiB2b2lkO1xuICAvKiogV2hlbiB0cnVlIChmb3IgZXhhbXBsZSB3aGlsZSB0aGUgZW1wdHkgc3RhdGUgaXMgc2hvd24pLCBrZWVwIHRoZSBqdW1wIGNvbnRyb2wgaGlkZGVuLiAqL1xuICBpc0VtcHR5PzogKCkgPT4gYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBLZWVwcyBhIHRyYW5zY3JpcHQgcGFuZSBwaW5uZWQgdG8gdGhlIGJvdHRvbSBhcyBtZXNzYWdlcyBzdHJlYW0gaW4sIHdpdGhvdXQgbWVhc3VyaW5nXG4gKiBuZWFyLWJvdHRvbSBhZnRlciBhbiBhcHBlbmQgaGFzIGFscmVhZHkgZ3Jvd24gc2Nyb2xsSGVpZ2h0LCBhbmQgeWllbGRzIGltbWVkaWF0ZWx5IHdoZW5cbiAqIHRoZSB1c2VyIHNjcm9sbHMgdXAgdG8gcmVhZCBlYXJsaWVyIG1lc3NhZ2VzLlxuICovXG5leHBvcnQgY2xhc3MgQXV0b1Njcm9sbGVyIHtcbiAgcHJpdmF0ZSByZWFkb25seSBwYW5lOiBTY3JvbGxQYW5lO1xuICBwcml2YXRlIHJlYWRvbmx5IHBpblRocmVzaG9sZDogbnVtYmVyO1xuICBwcml2YXRlIHJlYWRvbmx5IGp1bXBUaHJlc2hvbGQ6IG51bWJlcjtcbiAgcHJpdmF0ZSByZWFkb25seSBvbkp1bXBDaGFuZ2U/OiAoc2hvdzogYm9vbGVhbikgPT4gdm9pZDtcbiAgcHJpdmF0ZSByZWFkb25seSBpc0VtcHR5PzogKCkgPT4gYm9vbGVhbjtcbiAgcHJpdmF0ZSBwaW5uZWQgPSB0cnVlO1xuICBwcml2YXRlIGp1bXBpbmcgPSBmYWxzZTtcbiAgcHJpdmF0ZSBsYXN0U2Nyb2xsVG9wID0gMDtcblxuICBjb25zdHJ1Y3RvcihwYW5lOiBTY3JvbGxQYW5lLCBvcHRpb25zOiBBdXRvU2Nyb2xsZXJPcHRpb25zID0ge30pIHtcbiAgICB0aGlzLnBhbmUgPSBwYW5lO1xuICAgIHRoaXMucGluVGhyZXNob2xkID0gb3B0aW9ucy5waW5UaHJlc2hvbGQgPz8gMzI7XG4gICAgdGhpcy5qdW1wVGhyZXNob2xkID0gb3B0aW9ucy5qdW1wVGhyZXNob2xkID8/IDEyMDtcbiAgICB0aGlzLm9uSnVtcENoYW5nZSA9IG9wdGlvbnMub25KdW1wQ2hhbmdlO1xuICAgIHRoaXMuaXNFbXB0eSA9IG9wdGlvbnMuaXNFbXB0eTtcbiAgICB0aGlzLmxhc3RTY3JvbGxUb3AgPSBwYW5lLnNjcm9sbFRvcDtcbiAgfVxuXG4gIGdldCBpc1Bpbm5lZCgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5waW5uZWQ7XG4gIH1cblxuICBwcml2YXRlIGRpc3RhbmNlKCk6IG51bWJlciB7XG4gICAgcmV0dXJuIE1hdGgubWF4KDAsIHRoaXMucGFuZS5zY3JvbGxIZWlnaHQgLSB0aGlzLnBhbmUuc2Nyb2xsVG9wIC0gdGhpcy5wYW5lLmNsaWVudEhlaWdodCk7XG4gIH1cblxuICBwcml2YXRlIGlzVmlzaWJsZSgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5wYW5lLmNsaWVudEhlaWdodCA+IDA7XG4gIH1cblxuICBwcml2YXRlIHNuYXBUb0JvdHRvbSgpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuaXNWaXNpYmxlKCkpIHJldHVybjtcbiAgICB0aGlzLnBhbmUuc2Nyb2xsVG9wID0gdGhpcy5wYW5lLnNjcm9sbEhlaWdodDtcbiAgICB0aGlzLmxhc3RTY3JvbGxUb3AgPSB0aGlzLnBhbmUuc2Nyb2xsVG9wO1xuICB9XG5cbiAgcHJpdmF0ZSB1cGRhdGVKdW1wKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5vbkp1bXBDaGFuZ2UpIHJldHVybjtcbiAgICBjb25zdCBlbXB0eSA9IHRoaXMuaXNFbXB0eT8uKCkgPz8gZmFsc2U7XG4gICAgY29uc3Qgc2hvdyA9ICFlbXB0eSAmJiB0aGlzLmlzVmlzaWJsZSgpICYmICF0aGlzLmp1bXBpbmcgJiYgdGhpcy5kaXN0YW5jZSgpID4gdGhpcy5qdW1wVGhyZXNob2xkO1xuICAgIHRoaXMub25KdW1wQ2hhbmdlKHNob3cpO1xuICB9XG5cbiAgLyoqIENhbGwgYWZ0ZXIgY29udGVudCBpcyBhZGRlZCwgdXBkYXRlZCwgb3IgcmVtb3ZlZCBpbiB0aGUgcGFuZS4gKi9cbiAgb25Db250ZW50KGZvcmNlID0gZmFsc2UpOiB2b2lkIHtcbiAgICBpZiAoZm9yY2UpIHtcbiAgICAgIHRoaXMucGlubmVkID0gdHJ1ZTtcbiAgICAgIHRoaXMuanVtcGluZyA9IGZhbHNlO1xuICAgIH1cbiAgICBpZiAodGhpcy5waW5uZWQpIHtcbiAgICAgIGlmICh0aGlzLmp1bXBpbmcgJiYgdGhpcy5wYW5lLnNjcm9sbFRvICYmIHRoaXMuaXNWaXNpYmxlKCkpIHtcbiAgICAgICAgdGhpcy5wYW5lLnNjcm9sbFRvKHsgdG9wOiB0aGlzLnBhbmUuc2Nyb2xsSGVpZ2h0LCBiZWhhdmlvcjogXCJzbW9vdGhcIiB9KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMuc25hcFRvQm90dG9tKCk7XG4gICAgICB9XG4gICAgfVxuICAgIHRoaXMudXBkYXRlSnVtcCgpO1xuICB9XG5cbiAgLyoqIENhbGwgd2hlbiB0aGUgcGFuZSdzIHZpZXdwb3J0IHJlc2l6ZXMgKGJhcnMgYXBwZWFyaW5nLCBrZXlib2FyZCwgdGFiIHN3aXRjaCkuICovXG4gIG9uUmVzaXplKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5pc1Zpc2libGUoKSkgcmV0dXJuO1xuICAgIGlmICh0aGlzLnBpbm5lZCkge1xuICAgICAgdGhpcy5qdW1waW5nID0gZmFsc2U7XG4gICAgICB0aGlzLnNuYXBUb0JvdHRvbSgpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLmxhc3RTY3JvbGxUb3AgPSB0aGlzLnBhbmUuc2Nyb2xsVG9wO1xuICAgIH1cbiAgICB0aGlzLnVwZGF0ZUp1bXAoKTtcbiAgfVxuXG4gIC8qKiBDYWxsIGZyb20gdGhlIHBhbmUncyBzY3JvbGwgZXZlbnQgbGlzdGVuZXIuICovXG4gIG9uU2Nyb2xsKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5pc1Zpc2libGUoKSkgcmV0dXJuO1xuICAgIGNvbnN0IHRvcCA9IHRoaXMucGFuZS5zY3JvbGxUb3A7XG4gICAgY29uc3QgZGlzdCA9IHRoaXMuZGlzdGFuY2UoKTtcbiAgICBjb25zdCBtb3ZlZFVwID0gdG9wIDwgdGhpcy5sYXN0U2Nyb2xsVG9wO1xuICAgIHRoaXMubGFzdFNjcm9sbFRvcCA9IHRvcDtcblxuICAgIGlmIChkaXN0IDw9IHRoaXMucGluVGhyZXNob2xkKSB7XG4gICAgICB0aGlzLnBpbm5lZCA9IHRydWU7XG4gICAgICB0aGlzLmp1bXBpbmcgPSBmYWxzZTtcbiAgICB9IGVsc2UgaWYgKG1vdmVkVXApIHtcbiAgICAgIHRoaXMucGlubmVkID0gZmFsc2U7XG4gICAgICB0aGlzLmp1bXBpbmcgPSBmYWxzZTtcbiAgICB9XG4gICAgdGhpcy51cGRhdGVKdW1wKCk7XG4gIH1cblxuICAvKiogQ2FsbCBmcm9tIHRoZSBwYW5lJ3Mgc2Nyb2xsZW5kIGV2ZW50IGxpc3RlbmVyLiAqL1xuICBvblNjcm9sbEVuZCgpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuaXNWaXNpYmxlKCkgfHwgIXRoaXMuanVtcGluZykgcmV0dXJuO1xuICAgIHRoaXMuanVtcGluZyA9IGZhbHNlO1xuICAgIGlmICh0aGlzLmRpc3RhbmNlKCkgPiB0aGlzLnBpblRocmVzaG9sZCkgdGhpcy5waW5uZWQgPSBmYWxzZTtcbiAgICB0aGlzLnVwZGF0ZUp1bXAoKTtcbiAgfVxuXG4gIC8qKiBDYWxsIG9uIHVzZXIgd2hlZWwtdXAgb3IgdG91Y2hzdGFydCBzbyBhbiBhY3RpdmUgc21vb3RoIGp1bXAgeWllbGRzIHRvIHRoZSB1c2VyLiAqL1xuICBjYW5jZWxKdW1wKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5qdW1waW5nKSByZXR1cm47XG4gICAgdGhpcy5qdW1waW5nID0gZmFsc2U7XG4gICAgaWYgKHRoaXMuaXNWaXNpYmxlKCkpIHtcbiAgICAgIGNvbnN0IHRvcCA9IHRoaXMucGFuZS5zY3JvbGxUb3A7XG4gICAgICBpZiAodGhpcy5wYW5lLnNjcm9sbFRvKSB0aGlzLnBhbmUuc2Nyb2xsVG8oeyB0b3AsIGJlaGF2aW9yOiBcImluc3RhbnRcIiB9KTtcbiAgICAgIGVsc2UgdGhpcy5wYW5lLnNjcm9sbFRvcCA9IHRvcDtcbiAgICAgIHRoaXMubGFzdFNjcm9sbFRvcCA9IHRoaXMucGFuZS5zY3JvbGxUb3A7XG4gICAgICBpZiAodGhpcy5kaXN0YW5jZSgpID4gdGhpcy5waW5UaHJlc2hvbGQpIHRoaXMucGlubmVkID0gZmFsc2U7XG4gICAgfVxuICAgIHRoaXMudXBkYXRlSnVtcCgpO1xuICB9XG5cbiAgLyoqIFJlLXBpbiBhbmQgc2Nyb2xsIHNtb290aGx5IHRvIHRoZSBib3R0b20gKHVzZWQgYnkgdGhlIGp1bXAtdG8tbGF0ZXN0IGJ1dHRvbikuICovXG4gIGp1bXBUb0JvdHRvbSgpOiB2b2lkIHtcbiAgICB0aGlzLnBpbm5lZCA9IHRydWU7XG4gICAgaWYgKCF0aGlzLmlzVmlzaWJsZSgpKSB7XG4gICAgICB0aGlzLnVwZGF0ZUp1bXAoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHRoaXMuZGlzdGFuY2UoKSA8PSB0aGlzLnBpblRocmVzaG9sZCB8fCAhdGhpcy5wYW5lLnNjcm9sbFRvKSB7XG4gICAgICB0aGlzLmp1bXBpbmcgPSBmYWxzZTtcbiAgICAgIHRoaXMuc25hcFRvQm90dG9tKCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuanVtcGluZyA9IHRydWU7XG4gICAgICB0aGlzLmxhc3RTY3JvbGxUb3AgPSB0aGlzLnBhbmUuc2Nyb2xsVG9wO1xuICAgICAgdGhpcy5wYW5lLnNjcm9sbFRvKHsgdG9wOiB0aGlzLnBhbmUuc2Nyb2xsSGVpZ2h0LCBiZWhhdmlvcjogXCJzbW9vdGhcIiB9KTtcbiAgICB9XG4gICAgdGhpcy51cGRhdGVKdW1wKCk7XG4gIH1cblxuICAvKiogUmVjb21wdXRlIHBpbm5lZCBzdGF0ZSBmcm9tIHRoZSBjdXJyZW50IHBvc2l0aW9uIGFmdGVyIGEgdXNlci1kcml2ZW4gbGF5b3V0IGNoYW5nZSAoZS5nLiBleHBhbmRpbmcgYSByZXN1bHQpLiAqL1xuICBzeW5jRnJvbVBvc2l0aW9uKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5pc1Zpc2libGUoKSkgcmV0dXJuO1xuICAgIHRoaXMuanVtcGluZyA9IGZhbHNlO1xuICAgIHRoaXMubGFzdFNjcm9sbFRvcCA9IHRoaXMucGFuZS5zY3JvbGxUb3A7XG4gICAgdGhpcy5waW5uZWQgPSB0aGlzLmRpc3RhbmNlKCkgPD0gdGhpcy5waW5UaHJlc2hvbGQ7XG4gICAgdGhpcy51cGRhdGVKdW1wKCk7XG4gIH1cblxuICAvKiogUGF1c2UgYXV0by1zY3JvbGwgZXhwbGljaXRseSAoZS5nLiB3aGVuIHJldmVhbGluZyBhbiBvbGRlciByZXN1bHQgY2FyZCkuICovXG4gIHVucGluKCk6IHZvaWQge1xuICAgIHRoaXMucGlubmVkID0gZmFsc2U7XG4gICAgdGhpcy5qdW1waW5nID0gZmFsc2U7XG4gICAgdGhpcy51cGRhdGVKdW1wKCk7XG4gIH1cbn1cbiIsICIvLyBQdXJlIFVJIGhlbHBlcnMgZm9yIHRoZSBWb2ljZSB3ZWIgc3VyZmFjZSAoZGVuc2l0eSwgYWdlbnQtcGFuZSBmaWx0ZXJpbmcsIGNvbXBhY3QgcHJldmlld3MpLlxuXG5leHBvcnQgdHlwZSBTaWRlRmlsdGVyID0gXCJhbGxcIiB8IFwiYWN0aXZlXCIgfCBcInJlc3VsdHNcIjtcbmV4cG9ydCB0eXBlIERlbnNpdHkgPSBcImNvbXBhY3RcIiB8IFwiY29tZm9ydGFibGVcIjtcblxuZXhwb3J0IGludGVyZmFjZSBTaWRlQ291bnRzIHtcbiAgYWN0aXZlOiBudW1iZXI7XG4gIHJlc3VsdHM6IG51bWJlcjtcbiAgZWFybGllcjogbnVtYmVyO1xuICBkb25lOiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2lkZVZpc2liaWxpdHkge1xuICBzaG93VGFza3NTZWN0aW9uOiBib29sZWFuO1xuICBzaG93RW1wdHlUYXNrczogYm9vbGVhbjtcbiAgc2hvd1Jlc3VsdHNTZWN0aW9uOiBib29sZWFuO1xuICBzaG93RW1wdHlSZXN1bHRzOiBib29sZWFuO1xuICBzaG93RWFybGllclNlY3Rpb246IGJvb2xlYW47XG4gIHNob3dEb25lU2VjdGlvbjogYm9vbGVhbjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZURlbnNpdHkodmFsdWU6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQpOiBEZW5zaXR5IHtcbiAgcmV0dXJuIHZhbHVlID09PSBcImNvbWZvcnRhYmxlXCIgPyBcImNvbWZvcnRhYmxlXCIgOiBcImNvbXBhY3RcIjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZVNpZGVGaWx0ZXIodmFsdWU6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQpOiBTaWRlRmlsdGVyIHtcbiAgaWYgKHZhbHVlID09PSBcImFjdGl2ZVwiIHx8IHZhbHVlID09PSBcInJlc3VsdHNcIikgcmV0dXJuIHZhbHVlO1xuICByZXR1cm4gXCJhbGxcIjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlUHJlZml4KHRleHQ6IHN0cmluZyk6IHsgbW9kZTogXCJoZXJtZXNcIiB8IFwidDNcIiB8IG51bGw7IHJlc3Q6IHN0cmluZyB9IHtcbiAgY29uc3QgbSA9IHRleHQubWF0Y2goL15cXC8odDN8Y29kZXxofGhlcm1lcylcXHMrKC4qKSQvaXMpO1xuICBpZiAoIW0pIHJldHVybiB7IG1vZGU6IG51bGwsIHJlc3Q6IHRleHQgfTtcbiAgcmV0dXJuIHsgbW9kZTogL14odDN8Y29kZSkkL2kudGVzdChtWzFdKSA/IFwidDNcIiA6IFwiaGVybWVzXCIsIHJlc3Q6IG1bMl0udHJpbSgpIH07XG59XG5cbi8qKiBBIHJlc3VsdCBjYXJkIG1heSBvbmx5IHN0ZWVyIGEgdGFzayB0aGF0IGJlbG9uZ3MgdG8gdGhlIHNhbWUgYWN0aXZlIHNlc3Npb24gKHRhc2sgSURzIHJlc3RhcnQgcGVyIGNhbGwpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNhbkZvbGxvd1VwUmVzdWx0KHJlc3VsdFNlc3Npb246IG51bWJlciwgYWN0aXZlU2Vzc2lvbjogbnVtYmVyLCBoYXNUYXNrOiBib29sZWFuKTogYm9vbGVhbiB7XG4gIHJldHVybiBhY3RpdmVTZXNzaW9uID4gMCAmJiByZXN1bHRTZXNzaW9uID09PSBhY3RpdmVTZXNzaW9uICYmIGhhc1Rhc2s7XG59XG5cbi8qKiBVbnJlYWQgbW9iaWxlIHJlc3VsdCBhbGVydHMgb25seSBjbGVhciBvbmNlIHRoZSBSZXN1bHRzIHNlY3Rpb24gaXMgYWN0dWFsbHkgdmlzaWJsZSB0byB0aGUgdXNlci4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzaG91bGRDbGVhclVucmVhZFJlc3VsdHMoaXNNb2JpbGU6IGJvb2xlYW4sIGRyYXdlck9wZW46IGJvb2xlYW4sIGZpbHRlcjogU2lkZUZpbHRlcik6IGJvb2xlYW4ge1xuICByZXR1cm4gIWlzTW9iaWxlIHx8IChkcmF3ZXJPcGVuICYmIGZpbHRlciAhPT0gXCJhY3RpdmVcIik7XG59XG5cbi8qKiBQaWNrIHRoZSBmaWx0ZXIgdG8gc2hvdyB3aGVuIHRhcHBpbmcgdGhlIG1vYmlsZSBsaXZlLXN0YXR1cyBiYW5uZXIgc28gdGhlIGFkdmVydGlzZWQgaXRlbSBpcyB2aXNpYmxlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVNb2JpbGVCYW5uZXJGaWx0ZXIoY3VycmVudDogU2lkZUZpbHRlciwgYWN0aXZlVG90YWw6IG51bWJlciwgdW5yZWFkUmVzdWx0czogbnVtYmVyKTogU2lkZUZpbHRlciB7XG4gIGlmIChhY3RpdmVUb3RhbCA+IDApIHJldHVybiBjdXJyZW50ID09PSBcInJlc3VsdHNcIiA/IFwiYWxsXCIgOiBjdXJyZW50O1xuICBpZiAodW5yZWFkUmVzdWx0cyA+IDApIHJldHVybiBcInJlc3VsdHNcIjtcbiAgcmV0dXJuIGN1cnJlbnQ7XG59XG5cbi8qKiBGbGF0dGVuIGEgTWFya2Rvd24gYWdlbnQgcmVwbHkgaW50byBhIHNpbmdsZS1saW5lIHBsYWluLXRleHQgcHJldmlldyBmb3IgaW5saW5lIGhhbmRvZmYgY2hpcHMuICovXG5leHBvcnQgZnVuY3Rpb24gcGxhaW5QcmV2aWV3KHRleHQ6IHN0cmluZywgbWF4TGVuID0gMTUwKTogc3RyaW5nIHtcbiAgY29uc3QgY2xlYW5lZCA9IHRleHRcbiAgICAucmVwbGFjZSgvYGBgW15cXG5dKlxcbj8oW1xcc1xcU10qPylgYGAvZywgKF8sIGNvZGU6IHN0cmluZykgPT4gYCAke2NvZGUudHJpbSgpfSBgKVxuICAgIC5yZXBsYWNlKC9cXFsoW15cXF1cXG5dKylcXF1cXCgoaHR0cHM/OlxcL1xcL1teXFxzKV0rKVxcKS9nLCBcIiQxXCIpXG4gICAgLnJlcGxhY2UoL14jezEsNn1cXHMrL2dtLCBcIlwiKVxuICAgIC5yZXBsYWNlKC9eXFxzKig/OlstKlx1MjAyMl18XFxkK1suKV0pXFxzKy9nbSwgXCJcIilcbiAgICAucmVwbGFjZSgvYChbXmBcXG5dKylgL2csIFwiJDFcIilcbiAgICAucmVwbGFjZSgvXFwqXFwqKFteKlxcbl0rKVxcKlxcKi9nLCBcIiQxXCIpXG4gICAgLnJlcGxhY2UoL19fKFteX1xcbl0rKV9fL2csIFwiJDFcIilcbiAgICAucmVwbGFjZSgvXFxzKy9nLCBcIiBcIilcbiAgICAudHJpbSgpO1xuICBpZiAoY2xlYW5lZC5sZW5ndGggPD0gbWF4TGVuKSByZXR1cm4gY2xlYW5lZDtcbiAgY29uc3QgY3V0ID0gY2xlYW5lZC5zbGljZSgwLCBtYXhMZW4pO1xuICBjb25zdCBzcGFjZSA9IGN1dC5sYXN0SW5kZXhPZihcIiBcIik7XG4gIGNvbnN0IGJhc2UgPSBzcGFjZSA+IE1hdGguZmxvb3IobWF4TGVuICogMC42KSA/IGN1dC5zbGljZSgwLCBzcGFjZSkgOiBjdXQ7XG4gIHJldHVybiBgJHtiYXNlLnJlcGxhY2UoL1suLDs6XFxzLV0rJC8sIFwiXCIpfVx1MjAyNmA7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXRTaG9ydFRpbWUoZGF0ZTogRGF0ZSk6IHN0cmluZyB7XG4gIGNvbnN0IHBhZCA9IChuOiBudW1iZXIpID0+IFN0cmluZyhuKS5wYWRTdGFydCgyLCBcIjBcIik7XG4gIHJldHVybiBgJHtwYWQoZGF0ZS5nZXRIb3VycygpKX06JHtwYWQoZGF0ZS5nZXRNaW51dGVzKCkpfWA7XG59XG5cbi8qKiBEZWNpZGUgd2hpY2ggc2VjdGlvbnMgb2YgdGhlIHJpZ2h0LWhhbmQgQWdlbnQgV29ya3NwYWNlIGFyZSB2aXNpYmxlIGZvciBhIGdpdmVuIGZpbHRlciBhbmQgY291bnRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVTaWRlU2VjdGlvbnMoZmlsdGVyOiBTaWRlRmlsdGVyLCBjb3VudHM6IFNpZGVDb3VudHMpOiBTaWRlVmlzaWJpbGl0eSB7XG4gIGlmIChmaWx0ZXIgPT09IFwicmVzdWx0c1wiKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHNob3dUYXNrc1NlY3Rpb246IGZhbHNlLFxuICAgICAgc2hvd0VtcHR5VGFza3M6IGZhbHNlLFxuICAgICAgc2hvd1Jlc3VsdHNTZWN0aW9uOiB0cnVlLFxuICAgICAgc2hvd0VtcHR5UmVzdWx0czogY291bnRzLnJlc3VsdHMgPT09IDAsXG4gICAgICBzaG93RWFybGllclNlY3Rpb246IGZhbHNlLFxuICAgICAgc2hvd0RvbmVTZWN0aW9uOiBmYWxzZSxcbiAgICB9O1xuICB9XG4gIGlmIChmaWx0ZXIgPT09IFwiYWN0aXZlXCIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc2hvd1Rhc2tzU2VjdGlvbjogdHJ1ZSxcbiAgICAgIHNob3dFbXB0eVRhc2tzOiBjb3VudHMuYWN0aXZlID09PSAwICYmIGNvdW50cy5lYXJsaWVyID09PSAwLFxuICAgICAgc2hvd1Jlc3VsdHNTZWN0aW9uOiBmYWxzZSxcbiAgICAgIHNob3dFbXB0eVJlc3VsdHM6IGZhbHNlLFxuICAgICAgc2hvd0VhcmxpZXJTZWN0aW9uOiBjb3VudHMuZWFybGllciA+IDAsXG4gICAgICBzaG93RG9uZVNlY3Rpb246IGNvdW50cy5kb25lID4gMCxcbiAgICB9O1xuICB9XG4gIC8vIFwiYWxsXCI6IGhpZGUgdGhlIGVtcHR5IGFjdGl2ZS10YXNrcyBwbGFjZWhvbGRlciBhcyBzb29uIGFzIHJlc3VsdHMgb3IgZWFybGllciBhZ2VudHMgZXhpc3RcbiAgLy8gc28gZmluaXNoZWQgcmVzcG9uc2VzIHRha2UgdGhlIHRvcCBvZiB0aGUgcGFuZSB3aXRob3V0IHdhc3RlZCBzcGFjZS5cbiAgY29uc3QgaGFzQW55dGhpbmdBYm92ZURvbmUgPSBjb3VudHMuYWN0aXZlID4gMCB8fCBjb3VudHMucmVzdWx0cyA+IDAgfHwgY291bnRzLmVhcmxpZXIgPiAwO1xuICByZXR1cm4ge1xuICAgIHNob3dUYXNrc1NlY3Rpb246IGNvdW50cy5hY3RpdmUgPiAwIHx8ICFoYXNBbnl0aGluZ0Fib3ZlRG9uZSxcbiAgICBzaG93RW1wdHlUYXNrczogIWhhc0FueXRoaW5nQWJvdmVEb25lLFxuICAgIHNob3dSZXN1bHRzU2VjdGlvbjogY291bnRzLnJlc3VsdHMgPiAwLFxuICAgIHNob3dFbXB0eVJlc3VsdHM6IGZhbHNlLFxuICAgIHNob3dFYXJsaWVyU2VjdGlvbjogY291bnRzLmVhcmxpZXIgPiAwLFxuICAgIHNob3dEb25lU2VjdGlvbjogY291bnRzLmRvbmUgPiAwLFxuICB9O1xufVxuIiwgIi8vIE1haW4tdGhyZWFkIGNvbnRyb2xsZXIgZm9yIHRoZSB3YWtlIHdvcmQgV2ViIFdvcmtlciBhbmQgU2NyZWVuIFdha2UgTG9jayBoZWxwZXIuXG4vLyBUYWdzIGV2ZXJ5IGxvYWQgYW5kIHJlc2V0IHdpdGggYSBtb25vdG9uaWMgZ2VuZXJhdGlvbiAoYGdlbmApIHNvIHN0YWxlIGRldGVjdGlvbnMgb3IgcmVhZHkgZXZlbnRzXG4vLyBhZnRlciBhIG1vZGVsIHN3aXRjaCBvciByZXNldCBhcmUgaWdub3JlZCwgYW5kIGtlZXBzIGEgc2hvcnQgcmluZyBidWZmZXIgb2YgcmVjZW50IGZlZCBjaHVua3Ncbi8vIGluZGV4ZWQgYnkgYHNlcWAgKHdpdGggcGVyLWZyYW1lIGBzdXBwcmVzc2VkYCBmbGFncykgc28gYXVkaW8gY2FwdHVyZWQgd2hpbGUgdGhlIHdvcmtlciB3YXNcbi8vIHNjb3JpbmcgaXMgcHJlc2VydmVkIGluIGBoaXQudHJhaWxpbmdgIHdpdGhvdXQgZHVwbGljYXRpbmcgdW5zdXBwcmVzc2VkIGZyYW1lcy5cblxuZXhwb3J0IGludGVyZmFjZSBXYWtlVGVsZW1ldHJ5IHtcbiAgc2NvcmU6IG51bWJlcjtcbiAgcGVhazogbnVtYmVyO1xuICBnYXRlT3BlbjogYm9vbGVhbjtcbiAgZnJhbWVzOiBudW1iZXI7XG4gIHNjb3JlZDogbnVtYmVyO1xuICBpbmZlck1zOiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgV2FrZVRyYWlsaW5nQ2h1bmsge1xuICAvKiogU2VxdWVuY2UgbnVtYmVyIGZyb20gYGZlZWQoKWAsIG1hdGNoaW5nIHRoZSBmZWQgY2h1bmsuICovXG4gIHNlcTogbnVtYmVyO1xuICBieXRlczogVWludDhBcnJheTtcbiAgLyoqIFRydWUgd2hlbiB0aGUgY29yZSBzdXBwcmVzc2VkIChzaWxlbmNlZCkgdGhpcyBmcmFtZSBkdXJpbmcgYXVkaWJsZSBwbGF5YmFjayAoYHdoaWxlU3BlYWtpbmcgIT09IFwic2VuZFwiYCkuICovXG4gIHN1cHByZXNzZWQ6IGJvb2xlYW47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgV2FrZURldGVjdGlvbkV2ZW50IHtcbiAgc2NvcmU6IG51bWJlcjtcbiAgYXRGcmFtZTogbnVtYmVyO1xuICAvKiogQXVkaW8gY2h1bmtzIHNwb2tlbiBhZnRlciB0aGUgd2FrZSB3b3JkOiB0aGUgdHJpZ2dlcmluZyBjaHVuaydzIHRhaWwgcGx1cyBhbnkgY2h1bmtzIGFscmVhZHkgc2VudCBhZnRlciBpdC4gKi9cbiAgdHJhaWxpbmc6IFdha2VUcmFpbGluZ0NodW5rW107XG4gIGluZmVyTXM6IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBXYWtlQ2xpZW50Q2FsbGJhY2tzIHtcbiAgb25SZWFkeT86IChtb2RlbElkOiBzdHJpbmcsIHdhcm11cE1zOiBudW1iZXIpID0+IHZvaWQ7XG4gIG9uRGV0ZWN0ZWQ6IChoaXQ6IFdha2VEZXRlY3Rpb25FdmVudCkgPT4gdm9pZDtcbiAgb25UZWxlbWV0cnk/OiAodDogV2FrZVRlbGVtZXRyeSkgPT4gdm9pZDtcbiAgLyoqIENhbGxlZCBvbmNlIGFsbCBpbi1mbGlnaHQgc3VwcHJlc3NlZCBmcmFtZXMgaGF2ZSBiZWVuIHNjb3JlZCB3aXRob3V0IGZpcmluZyBhIGRldGVjdGlvbi4gKi9cbiAgb25TdXBwcmVzc2VkU2V0dGxlZD86ICgpID0+IHZvaWQ7XG4gIG9uRXJyb3I/OiAobWVzc2FnZTogc3RyaW5nKSA9PiB2b2lkO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFdvcmtlckxpa2Uge1xuICBvbm1lc3NhZ2U6ICgoZTogTWVzc2FnZUV2ZW50PFJlY29yZDxzdHJpbmcsIGFueT4+KSA9PiB2b2lkKSB8IG51bGw7XG4gIG9uZXJyb3I6ICgoZTogRXJyb3JFdmVudCkgPT4gdm9pZCkgfCBudWxsO1xuICBwb3N0TWVzc2FnZShtZXNzYWdlOiB1bmtub3duLCB0cmFuc2Zlcj86IFRyYW5zZmVyYWJsZVtdKTogdm9pZDtcbiAgdGVybWluYXRlKCk6IHZvaWQ7XG59XG5cbi8qKiBNYXggYnVmZmVyZWQgcG9zdC1mZWVkIGF1ZGlvICh+MS41IHMgYXQgMjAgbXMgY2h1bmtzKSB0byBjb3ZlciB3b3JrZXIgc2NvcmluZyBsYXRlbmN5LiAqL1xuY29uc3QgUkVDRU5UX01BWF9CWVRFUyA9IE1hdGgucm91bmQoMS41ICogMzJfMDAwKTtcblxuZXhwb3J0IGNsYXNzIFdha2VDbGllbnQge1xuICBwcml2YXRlIHdvcmtlcjogV29ya2VyTGlrZSB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIHJlYWRvbmx5IGNhbGxiYWNrczogV2FrZUNsaWVudENhbGxiYWNrcztcbiAgcHJpdmF0ZSByZWFkb25seSBjcmVhdGVXb3JrZXI6ICgpID0+IFdvcmtlckxpa2U7XG4gIHByaXZhdGUgbG9hZGVkTW9kZWxJZDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgbG9hZGluZ01vZGVsSWQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIGN1cnJlbnRUaHJlc2hvbGQgPSAwLjc7XG4gIHByaXZhdGUgZ2VuID0gMDtcbiAgcHJpdmF0ZSBzZXEgPSAwO1xuICBwcml2YXRlIGxhc3RTdXBwcmVzc2VkU2VxID0gMDtcbiAgcHJpdmF0ZSBsYXN0QWNrZWRTZXEgPSAwO1xuICBwcml2YXRlIHJlY2VudDogeyBzZXE6IG51bWJlcjsgYnl0ZXM6IFVpbnQ4QXJyYXk7IHN1cHByZXNzZWQ6IGJvb2xlYW4gfVtdID0gW107XG4gIHByaXZhdGUgcmVjZW50Qnl0ZXMgPSAwO1xuICByZWFkeSA9IGZhbHNlO1xuXG4gIGNvbnN0cnVjdG9yKFxuICAgIGNhbGxiYWNrczogV2FrZUNsaWVudENhbGxiYWNrcyxcbiAgICBjcmVhdGVXb3JrZXI6ICgpID0+IFdvcmtlckxpa2UgPSAoKSA9PiBuZXcgV29ya2VyKFwiL3dha2Uud29ya2VyLmpzXCIsIHsgdHlwZTogXCJtb2R1bGVcIiB9KSxcbiAgKSB7XG4gICAgdGhpcy5jYWxsYmFja3MgPSBjYWxsYmFja3M7XG4gICAgdGhpcy5jcmVhdGVXb3JrZXIgPSBjcmVhdGVXb3JrZXI7XG4gIH1cblxuICAvKiogVHJ1ZSB3aGlsZSBhdCBsZWFzdCBvbmUgc3VwcHJlc3NlZCBmcmFtZSBpcyBzdGlsbCBxdWV1ZWQgb3Igc2NvcmluZyBpbiB0aGUgd29ya2VyLiAqL1xuICBnZXQgc3VwcHJlc3NlZEluRmxpZ2h0KCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLmxhc3RTdXBwcmVzc2VkU2VxID4gdGhpcy5sYXN0QWNrZWRTZXE7XG4gIH1cblxuICBwcml2YXRlIGNsZWFyUmVjZW50KCk6IHZvaWQge1xuICAgIHRoaXMucmVjZW50ID0gW107XG4gICAgdGhpcy5yZWNlbnRCeXRlcyA9IDA7XG4gIH1cblxuICBwcml2YXRlIGNsZWFyU3VwcHJlc3NlZFRyYWNraW5nKCk6IHZvaWQge1xuICAgIGNvbnN0IGhhZEluRmxpZ2h0ID0gdGhpcy5zdXBwcmVzc2VkSW5GbGlnaHQ7XG4gICAgdGhpcy5sYXN0U3VwcHJlc3NlZFNlcSA9IDA7XG4gICAgdGhpcy5sYXN0QWNrZWRTZXEgPSAwO1xuICAgIGlmIChoYWRJbkZsaWdodCkgdGhpcy5jYWxsYmFja3Mub25TdXBwcmVzc2VkU2V0dGxlZD8uKCk7XG4gIH1cblxuICBwcml2YXRlIGVuc3VyZVdvcmtlcigpOiBXb3JrZXJMaWtlIHtcbiAgICBpZiAodGhpcy53b3JrZXIpIHJldHVybiB0aGlzLndvcmtlcjtcbiAgICBjb25zdCB3b3JrZXIgPSB0aGlzLmNyZWF0ZVdvcmtlcigpO1xuICAgIHdvcmtlci5vbm1lc3NhZ2UgPSAoZTogTWVzc2FnZUV2ZW50PFJlY29yZDxzdHJpbmcsIGFueT4+KSA9PiB7XG4gICAgICBjb25zdCBtID0gZS5kYXRhO1xuICAgICAgaWYgKHR5cGVvZiBtLmdlbiA9PT0gXCJudW1iZXJcIiAmJiBtLmdlbiAhPT0gdGhpcy5nZW4pIHJldHVybjtcbiAgICAgIGlmIChtLnR5cGUgPT09IFwicmVhZHlcIikge1xuICAgICAgICB0aGlzLmxvYWRpbmdNb2RlbElkID0gbnVsbDtcbiAgICAgICAgdGhpcy5sb2FkZWRNb2RlbElkID0gbS5tb2RlbElkO1xuICAgICAgICB0aGlzLnJlYWR5ID0gdHJ1ZTtcbiAgICAgICAgdGhpcy5jYWxsYmFja3Mub25SZWFkeT8uKG0ubW9kZWxJZCwgbS53YXJtdXBNcyk7XG4gICAgICB9IGVsc2UgaWYgKG0udHlwZSA9PT0gXCJhY2tcIikge1xuICAgICAgICBjb25zdCB3YXNJbkZsaWdodCA9IHRoaXMuc3VwcHJlc3NlZEluRmxpZ2h0O1xuICAgICAgICBpZiAodHlwZW9mIG0uc2VxID09PSBcIm51bWJlclwiICYmIG0uc2VxID4gdGhpcy5sYXN0QWNrZWRTZXEpIHRoaXMubGFzdEFja2VkU2VxID0gbS5zZXE7XG4gICAgICAgIGlmICh3YXNJbkZsaWdodCAmJiAhdGhpcy5zdXBwcmVzc2VkSW5GbGlnaHQpIHRoaXMuY2FsbGJhY2tzLm9uU3VwcHJlc3NlZFNldHRsZWQ/LigpO1xuICAgICAgfSBlbHNlIGlmIChtLnR5cGUgPT09IFwiZGV0ZWN0ZWRcIikge1xuICAgICAgICBjb25zdCB0cmFpbGluZzogV2FrZVRyYWlsaW5nQ2h1bmtbXSA9IFtdO1xuICAgICAgICBjb25zdCByZXN0ID0gbmV3IFVpbnQ4QXJyYXkobS5yZXN0Qnl0ZXMgYXMgQXJyYXlCdWZmZXIpO1xuICAgICAgICBjb25zdCBoaXRTZXEgPSB0eXBlb2YgbS5zZXEgPT09IFwibnVtYmVyXCIgPyBtLnNlcSA6IE51bWJlci5NQVhfU0FGRV9JTlRFR0VSO1xuICAgICAgICBjb25zdCBoaXRJdGVtID0gdGhpcy5yZWNlbnQuZmluZCgoaXRlbSkgPT4gaXRlbS5zZXEgPT09IGhpdFNlcSk7XG4gICAgICAgIGlmIChyZXN0LmJ5dGVMZW5ndGggPiAwKSB7XG4gICAgICAgICAgdHJhaWxpbmcucHVzaCh7IHNlcTogaGl0U2VxLCBieXRlczogcmVzdCwgc3VwcHJlc3NlZDogaGl0SXRlbT8uc3VwcHJlc3NlZCA/PyBmYWxzZSB9KTtcbiAgICAgICAgfVxuICAgICAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgdGhpcy5yZWNlbnQpIHtcbiAgICAgICAgICBpZiAoaXRlbS5zZXEgPiBoaXRTZXEpIHRyYWlsaW5nLnB1c2goeyBzZXE6IGl0ZW0uc2VxLCBieXRlczogaXRlbS5ieXRlcywgc3VwcHJlc3NlZDogaXRlbS5zdXBwcmVzc2VkIH0pO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMuY2xlYXJSZWNlbnQoKTtcbiAgICAgICAgdGhpcy5sYXN0U3VwcHJlc3NlZFNlcSA9IDA7XG4gICAgICAgIHRoaXMubGFzdEFja2VkU2VxID0gMDtcbiAgICAgICAgdGhpcy5jYWxsYmFja3Mub25EZXRlY3RlZCh7XG4gICAgICAgICAgc2NvcmU6IG0uc2NvcmUsXG4gICAgICAgICAgYXRGcmFtZTogbS5hdEZyYW1lLFxuICAgICAgICAgIHRyYWlsaW5nLFxuICAgICAgICAgIGluZmVyTXM6IG0uaW5mZXJNcyxcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2UgaWYgKG0udHlwZSA9PT0gXCJ0ZWxlbWV0cnlcIikge1xuICAgICAgICB0aGlzLmNhbGxiYWNrcy5vblRlbGVtZXRyeT8uKHtcbiAgICAgICAgICBzY29yZTogbS5zY29yZSxcbiAgICAgICAgICBwZWFrOiBtLnBlYWssXG4gICAgICAgICAgZ2F0ZU9wZW46IG0uZ2F0ZU9wZW4sXG4gICAgICAgICAgZnJhbWVzOiBtLmZyYW1lcyxcbiAgICAgICAgICBzY29yZWQ6IG0uc2NvcmVkLFxuICAgICAgICAgIGluZmVyTXM6IG0uaW5mZXJNcyxcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2UgaWYgKG0udHlwZSA9PT0gXCJlcnJvclwiKSB7XG4gICAgICAgIHRoaXMubG9hZGluZ01vZGVsSWQgPSBudWxsO1xuICAgICAgICB0aGlzLnJlYWR5ID0gZmFsc2U7XG4gICAgICAgIHRoaXMuY2xlYXJTdXBwcmVzc2VkVHJhY2tpbmcoKTtcbiAgICAgICAgdGhpcy5jYWxsYmFja3Mub25FcnJvcj8uKFN0cmluZyhtLm1lc3NhZ2UgPz8gXCJ3YWtlIHdvcmtlciBlcnJvclwiKSk7XG4gICAgICB9XG4gICAgfTtcbiAgICB3b3JrZXIub25lcnJvciA9IChlcnIpID0+IHtcbiAgICAgIHRoaXMubG9hZGluZ01vZGVsSWQgPSBudWxsO1xuICAgICAgdGhpcy5yZWFkeSA9IGZhbHNlO1xuICAgICAgdGhpcy5jbGVhclN1cHByZXNzZWRUcmFja2luZygpO1xuICAgICAgdGhpcy5jYWxsYmFja3Mub25FcnJvcj8uKGVyci5tZXNzYWdlIHx8IFwid2FrZSB3b3JrZXIgZmFpbGVkXCIpO1xuICAgIH07XG4gICAgdGhpcy53b3JrZXIgPSB3b3JrZXI7XG4gICAgcmV0dXJuIHdvcmtlcjtcbiAgfVxuXG4gIC8qKiBMb2FkcyAob3Igc3dpdGNoZXMgdG8pIHRoZSBuYW1lZCBtb2RlbDsgaWdub3JlcyBzdGFsZSByZXN1bHRzIGZyb20gZWFybGllciBsb2Fkcy4gKi9cbiAgbG9hZChtb2RlbElkOiBzdHJpbmcsIHRocmVzaG9sZDogbnVtYmVyKTogdm9pZCB7XG4gICAgdGhpcy5jdXJyZW50VGhyZXNob2xkID0gdGhyZXNob2xkO1xuICAgIGNvbnN0IHdvcmtlciA9IHRoaXMuZW5zdXJlV29ya2VyKCk7XG4gICAgaWYgKHRoaXMucmVhZHkgJiYgdGhpcy5sb2FkZWRNb2RlbElkID09PSBtb2RlbElkKSB7XG4gICAgICB3b3JrZXIucG9zdE1lc3NhZ2UoeyB0eXBlOiBcImNvbmZpZ1wiLCB0aHJlc2hvbGQgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICh0aGlzLmxvYWRpbmdNb2RlbElkID09PSBtb2RlbElkKSB7XG4gICAgICB3b3JrZXIucG9zdE1lc3NhZ2UoeyB0eXBlOiBcImNvbmZpZ1wiLCB0aHJlc2hvbGQgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRoaXMuZ2VuKys7XG4gICAgdGhpcy5yZWFkeSA9IGZhbHNlO1xuICAgIHRoaXMubG9hZGluZ01vZGVsSWQgPSBtb2RlbElkO1xuICAgIHRoaXMuY2xlYXJSZWNlbnQoKTtcbiAgICB0aGlzLmNsZWFyU3VwcHJlc3NlZFRyYWNraW5nKCk7XG4gICAgd29ya2VyLnBvc3RNZXNzYWdlKHtcbiAgICAgIHR5cGU6IFwibG9hZFwiLFxuICAgICAgZ2VuOiB0aGlzLmdlbixcbiAgICAgIG1vZGVsSWQsXG4gICAgICB1cmw6IGAvd2FrZS9tb2RlbHMvJHtlbmNvZGVVUklDb21wb25lbnQobW9kZWxJZCl9Lm9ubnhgLFxuICAgICAgdGhyZXNob2xkLFxuICAgICAgd2FzbVBhdGhzOiBcIi9vcnQvXCIsXG4gICAgfSk7XG4gIH1cblxuICBzZXRUaHJlc2hvbGQodGhyZXNob2xkOiBudW1iZXIpOiB2b2lkIHtcbiAgICB0aGlzLmN1cnJlbnRUaHJlc2hvbGQgPSB0aHJlc2hvbGQ7XG4gICAgdGhpcy53b3JrZXI/LnBvc3RNZXNzYWdlKHsgdHlwZTogXCJjb25maWdcIiwgdGhyZXNob2xkIH0pO1xuICB9XG5cbiAgLyoqIEZlZWRzIGEgMTYga0h6IFBDTTE2IGNodW5rIHRvIHRoZSB3b3JrZXI7IHJldHVybnMgaXRzIHNlcXVlbmNlIG51bWJlciAob3IgMCBpZiBub3QgcmVhZHkpLiAqL1xuICBmZWVkKHNhbXBsZXM6IEludDE2QXJyYXksIHN1cHByZXNzZWQgPSBmYWxzZSk6IG51bWJlciB7XG4gICAgaWYgKCF0aGlzLnJlYWR5IHx8ICF0aGlzLndvcmtlcikgcmV0dXJuIDA7XG4gICAgY29uc3Qgc2VxID0gKyt0aGlzLnNlcTtcbiAgICBpZiAoc3VwcHJlc3NlZCkgdGhpcy5sYXN0U3VwcHJlc3NlZFNlcSA9IHNlcTtcbiAgICBjb25zdCBieXRlcyA9IG5ldyBVaW50OEFycmF5KHNhbXBsZXMuYnl0ZUxlbmd0aCk7XG4gICAgYnl0ZXMuc2V0KG5ldyBVaW50OEFycmF5KHNhbXBsZXMuYnVmZmVyLCBzYW1wbGVzLmJ5dGVPZmZzZXQsIHNhbXBsZXMuYnl0ZUxlbmd0aCkpO1xuICAgIHRoaXMucmVjZW50LnB1c2goeyBzZXEsIGJ5dGVzLCBzdXBwcmVzc2VkIH0pO1xuICAgIHRoaXMucmVjZW50Qnl0ZXMgKz0gYnl0ZXMuYnl0ZUxlbmd0aDtcbiAgICB3aGlsZSAodGhpcy5yZWNlbnRCeXRlcyA+IFJFQ0VOVF9NQVhfQllURVMgJiYgdGhpcy5yZWNlbnQubGVuZ3RoID4gMSkge1xuICAgICAgdGhpcy5yZWNlbnRCeXRlcyAtPSB0aGlzLnJlY2VudC5zaGlmdCgpIS5ieXRlcy5ieXRlTGVuZ3RoO1xuICAgIH1cbiAgICBjb25zdCBjb3B5ID0gbmV3IEludDE2QXJyYXkoc2FtcGxlcy5sZW5ndGgpO1xuICAgIGNvcHkuc2V0KHNhbXBsZXMpO1xuICAgIHRoaXMud29ya2VyLnBvc3RNZXNzYWdlKHsgdHlwZTogXCJmZWVkXCIsIGdlbjogdGhpcy5nZW4sIHNlcSwgYWNrOiBzdXBwcmVzc2VkLCBwY206IGNvcHkuYnVmZmVyIH0sIFtjb3B5LmJ1ZmZlcl0pO1xuICAgIHJldHVybiBzZXE7XG4gIH1cblxuICByZXNldCgpOiB2b2lkIHtcbiAgICB0aGlzLmNsZWFyUmVjZW50KCk7XG4gICAgdGhpcy5jbGVhclN1cHByZXNzZWRUcmFja2luZygpO1xuICAgIGlmICghdGhpcy53b3JrZXIgfHwgIXRoaXMucmVhZHkpIHJldHVybjtcbiAgICB0aGlzLmdlbisrO1xuICAgIHRoaXMud29ya2VyLnBvc3RNZXNzYWdlKHsgdHlwZTogXCJyZXNldFwiLCBnZW46IHRoaXMuZ2VuIH0pO1xuICB9XG5cbiAgZGlzcG9zZSgpOiB2b2lkIHtcbiAgICB0aGlzLmdlbisrO1xuICAgIHRoaXMucmVhZHkgPSBmYWxzZTtcbiAgICB0aGlzLmxvYWRlZE1vZGVsSWQgPSBudWxsO1xuICAgIHRoaXMubG9hZGluZ01vZGVsSWQgPSBudWxsO1xuICAgIHRoaXMuY2xlYXJSZWNlbnQoKTtcbiAgICB0aGlzLmNsZWFyU3VwcHJlc3NlZFRyYWNraW5nKCk7XG4gICAgaWYgKHRoaXMud29ya2VyKSB7XG4gICAgICB0aGlzLndvcmtlci5wb3N0TWVzc2FnZSh7IHR5cGU6IFwiZGlzcG9zZVwiLCBnZW46IHRoaXMuZ2VuIH0pO1xuICAgICAgdGhpcy53b3JrZXIudGVybWluYXRlKCk7XG4gICAgICB0aGlzLndvcmtlciA9IG51bGw7XG4gICAgfVxuICB9XG5cbiAgZ2V0IG1vZGVsSWQoKTogc3RyaW5nIHwgbnVsbCB7XG4gICAgcmV0dXJuIHRoaXMubG9hZGVkTW9kZWxJZCA/PyB0aGlzLmxvYWRpbmdNb2RlbElkO1xuICB9XG5cbiAgZ2V0IHRocmVzaG9sZCgpOiBudW1iZXIge1xuICAgIHJldHVybiB0aGlzLmN1cnJlbnRUaHJlc2hvbGQ7XG4gIH1cbn1cblxuZXhwb3J0IGludGVyZmFjZSBXYWtlTG9ja1NlbnRpbmVsTGlrZSB7XG4gIHJlYWRvbmx5IHJlbGVhc2VkPzogYm9vbGVhbjtcbiAgcmVsZWFzZSgpOiBQcm9taXNlPHZvaWQ+O1xuICBhZGRFdmVudExpc3RlbmVyPyh0eXBlOiBzdHJpbmcsIGxpc3RlbmVyOiAoKSA9PiB2b2lkKTogdm9pZDtcbn1cblxuLyoqXG4gKiBXcmFwcyB0aGUgU2NyZWVuIFdha2UgTG9jayBBUEkgc28gYnJvd3Nlci1pbml0aWF0ZWQgcmVsZWFzZXMgKHN1Y2ggYXMgaGlkaW5nIGEgdGFiKSBjbGVhciB0aGVcbiAqIHN0b3JlZCBzZW50aW5lbCBhbmQgYWxsb3cgcmVhY3F1aXJpbmcgb24gdmlzaWJpbGl0eSByZXN0b3JlLCB3aGlsZSBjYW5jZWxsaW5nIGluLWZsaWdodCByZXF1ZXN0cy5cbiAqL1xuZXhwb3J0IGNsYXNzIFNjcmVlbldha2VMb2NrIHtcbiAgcHJpdmF0ZSBzZW50aW5lbDogV2FrZUxvY2tTZW50aW5lbExpa2UgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBnZW4gPSAwO1xuICBwcml2YXRlIHJlYWRvbmx5IHJlcXVlc3RMb2NrOiAoKSA9PiBQcm9taXNlPFdha2VMb2NrU2VudGluZWxMaWtlIHwgdW5kZWZpbmVkPjtcblxuICBjb25zdHJ1Y3RvcihcbiAgICByZXF1ZXN0TG9jazogKCkgPT4gUHJvbWlzZTxXYWtlTG9ja1NlbnRpbmVsTGlrZSB8IHVuZGVmaW5lZD4gPSAoKSA9PlxuICAgICAgKG5hdmlnYXRvciBhcyBhbnkpLndha2VMb2NrPy5yZXF1ZXN0KFwic2NyZWVuXCIpID8/IFByb21pc2UucmVzb2x2ZSh1bmRlZmluZWQpLFxuICApIHtcbiAgICB0aGlzLnJlcXVlc3RMb2NrID0gcmVxdWVzdExvY2s7XG4gIH1cblxuICBnZXQgaGVsZCgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5zZW50aW5lbCAhPSBudWxsICYmICF0aGlzLnNlbnRpbmVsLnJlbGVhc2VkO1xuICB9XG5cbiAgYXN5bmMgYWNxdWlyZShzdGlsbFdhbnRlZDogKCkgPT4gYm9vbGVhbik6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICh0aGlzLmhlbGQgfHwgIXN0aWxsV2FudGVkKCkpIHJldHVybjtcbiAgICBjb25zdCBnZW4gPSArK3RoaXMuZ2VuO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBsb2NrID0gYXdhaXQgdGhpcy5yZXF1ZXN0TG9jaygpO1xuICAgICAgaWYgKCFsb2NrKSByZXR1cm47XG4gICAgICBpZiAoZ2VuICE9PSB0aGlzLmdlbiB8fCAhc3RpbGxXYW50ZWQoKSkge1xuICAgICAgICB2b2lkIGxvY2sucmVsZWFzZSgpLmNhdGNoKCgpID0+IHt9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgdGhpcy5zZW50aW5lbCA9IGxvY2s7XG4gICAgICBsb2NrLmFkZEV2ZW50TGlzdGVuZXI/LihcInJlbGVhc2VcIiwgKCkgPT4ge1xuICAgICAgICBpZiAodGhpcy5zZW50aW5lbCA9PT0gbG9jaykgdGhpcy5zZW50aW5lbCA9IG51bGw7XG4gICAgICB9KTtcbiAgICB9IGNhdGNoIHt9XG4gIH1cblxuICByZWxlYXNlKCk6IHZvaWQge1xuICAgIHRoaXMuZ2VuKys7XG4gICAgY29uc3QgbG9jayA9IHRoaXMuc2VudGluZWw7XG4gICAgdGhpcy5zZW50aW5lbCA9IG51bGw7XG4gICAgdm9pZCBsb2NrPy5yZWxlYXNlKCkuY2F0Y2goKCkgPT4ge30pO1xuICB9XG59XG4iLCAiLy8gVGhlIHdlYiBzdXJmYWNlOiBhIGZvdXJ0aCBob3N0IGZvciB0aGUgdm9pY2UgY29yZSwgYW5kIGEgcGhvbmUtZnJpZW5kbHkgd2F5IHRvIHVzZSBpdCBmb3Igd29yay5cbi8vIEl0IGxvYWRzIHRoZSBkZXYgc2VydmVyJ3MgbGF0ZXN0IGJ1aWxkIGF0IGVhY2ggY2FsbCwgc28gYW4gZWRpdCBpbiBzcmMvIGlzIGxpdmUgb24gdGhlIG5leHRcbi8vIGNhbGwsIGFuZCBrZWVwcyBldmVyeSBjYWxsIGFzIGEgdHJhY2UgdGhlIHJlcGxheSB2aWV3IChhbmQgYW55IG90aGVyIGhvc3QpIGNhbiBydW4gYWdhaW4uXG4vL1xuLy8gVGhlIGhvc3QncyBwYXJ0IGlzIHNtYWxsOiB0aGUgbWljcm9waG9uZSBhbmQgc3BlYWtlciAoYXVkaW8udHMpLCB0aGUgbW9kZWwncyBzb2NrZXQgdGhyb3VnaCB0aGVcbi8vIHNlcnZlcidzIHJlbGF5LCBIZXJtZXMgYW5kIFQzIHRocm91Z2ggdGhlIHNlcnZlciwgYW5kIHRoZSBzY3JlZW4uIFRoZSBjb3JlIGRlY2lkZXMgdGhlIHJlc3QuXG4vL1xuLy8gVHlwaW5nIHdpdGggbm8gY2FsbCBvbiBzdGFydHMgYSBjaGF0IGluc3RlYWQ6IHRoZSBzYW1lIGNvcmUgd2l0aCBgbWVkaXVtOiBcInRleHRcImAsIHdob3NlIHJlcXVlc3RzXG4vLyB0byB0aGUgdGV4dCBtb2RlbCBnbyB0aHJvdWdoIHRoZSBzZXJ2ZXIncyAvZ2VuZXJhdGUuIFRhc2tzLCBmb2xsb3ctdXBzIGFuZCB0aGVpciBjYXJkcyB3b3JrIGFzXG4vLyBpbiBhIGNhbGwuIFByZXNzaW5nIENhbGwgZW5kcyB0aGUgY2hhdCBhbmQgY2FycmllcyBpdHMgY29udmVyc2F0aW9uIG9uIGJ5IHZvaWNlLlxuXG5pbXBvcnQgeyBjb21tYW5kSW4gfSBmcm9tIFwiLi4vc3JjL2NvbW1hbmRzLnRzXCI7XG5pbXBvcnQgeyBDYWxsQXVkaW8sIGJ5dGVzVG9CYXNlNjQgfSBmcm9tIFwiLi9hdWRpby50c1wiO1xuaW1wb3J0IHsgUmVwbGF5IH0gZnJvbSBcIi4vcmVwbGF5LnRzXCI7XG5pbXBvcnQgeyBBdXRvU2Nyb2xsZXIgfSBmcm9tIFwiLi9zY3JvbGwudHNcIjtcbmltcG9ydCB7XG4gIGNhbkZvbGxvd1VwUmVzdWx0LFxuICBmb3JtYXRTaG9ydFRpbWUsXG4gIG5vcm1hbGl6ZURlbnNpdHksXG4gIG5vcm1hbGl6ZVNpZGVGaWx0ZXIsXG4gIHBhcnNlUHJlZml4LFxuICBwbGFpblByZXZpZXcsXG4gIHJlc29sdmVNb2JpbGVCYW5uZXJGaWx0ZXIsXG4gIHJlc29sdmVTaWRlU2VjdGlvbnMsXG4gIHNob3VsZENsZWFyVW5yZWFkUmVzdWx0cyxcbiAgdHlwZSBTaWRlRmlsdGVyLFxufSBmcm9tIFwiLi91aS50c1wiO1xuaW1wb3J0IHsgU2NyZWVuV2FrZUxvY2ssIFdha2VDbGllbnQsIHR5cGUgV2FrZURldGVjdGlvbkV2ZW50LCB0eXBlIFdha2VUZWxlbWV0cnkgfSBmcm9tIFwiLi93YWtlQ2xpZW50LnRzXCI7XG5cbmludGVyZmFjZSBDb3JlIHtcbiAgdmVyc2lvbjogc3RyaW5nO1xuICBkZWZhdWx0cygpOiBzdHJpbmc7XG4gIGNyZWF0ZShjb25maWc6IHN0cmluZywgdDogbnVtYmVyKTogc3RyaW5nO1xuICBwdXNoKGlkOiBudW1iZXIsIGV2ZW50OiBzdHJpbmcpOiBzdHJpbmc7XG4gIHRyYWNlKGlkOiBudW1iZXIpOiBzdHJpbmc7XG4gIGRpc3Bvc2UoaWQ6IG51bWJlcik6IHZvaWQ7XG59XG50eXBlIENvbW1hbmQgPSBSZWNvcmQ8c3RyaW5nLCBhbnk+ICYgeyB0eXBlOiBzdHJpbmcgfTtcbmludGVyZmFjZSBXYWtlTW9kZWxJbmZvIHsgaWQ6IHN0cmluZzsgbGFiZWw6IHN0cmluZyB9XG5pbnRlcmZhY2UgU2VydmVyQ29uZmlnIHsgcm91dGU6IHN0cmluZzsgbW9kZWw6IHN0cmluZzsgY2FwdGlvbnNNb2RlbD86IHN0cmluZzsgdGV4dE1vZGVsPzogc3RyaW5nOyB2ZXJzaW9uOiBzdHJpbmc7IGhlcm1lczogYm9vbGVhbjsgdDM6IHN0cmluZ1tdIHwgbnVsbDsgd2FrZU1vZGVscz86IFdha2VNb2RlbEluZm9bXSB9XG5cbmNvbnN0ICQgPSA8VCBleHRlbmRzIEhUTUxFbGVtZW50ID0gSFRNTEVsZW1lbnQ+KGlkOiBzdHJpbmcpID0+IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGlkKSBhcyBUO1xuY29uc3Qgbm93ID0gKCkgPT4gcGVyZm9ybWFuY2Uubm93KCkgLyAxMDAwO1xuY29uc3QgY2hlY2tlZCA9IChpZDogc3RyaW5nKSA9PiAkPEhUTUxJbnB1dEVsZW1lbnQ+KGlkKS5jaGVja2VkO1xuXG4vKiogVGhlIGxhdGVzdCBidWlsZCBmcm9tIHRoZSBkZXYgc2VydmVyLCBldmFsdWF0ZWQgYWZyZXNoOiBhbiBlZGl0IGluIHNyYy8gaXMgaW4gdGhlIG5leHQgY2FsbC4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBsb2FkQ29yZSh1cmwgPSBcIi92b2ljZS1jb3JlLmpzXCIpOiBQcm9taXNlPENvcmU+IHtcbiAgY29uc3Qgc291cmNlID0gYXdhaXQgKGF3YWl0IGZldGNoKHVybCwgeyBjYWNoZTogXCJuby1zdG9yZVwiIH0pKS50ZXh0KCk7XG4gIGNvbnN0IHNjb3BlOiB7IFZvaWNlQ29yZT86IENvcmUgfSA9IHt9O1xuICBuZXcgRnVuY3Rpb24oXCJnbG9iYWxUaGlzXCIsIHNvdXJjZSkoc2NvcGUpO1xuICBpZiAoIXNjb3BlLlZvaWNlQ29yZSkgdGhyb3cgbmV3IEVycm9yKFwidGhlIGJ1bmRsZSBkaWRuJ3QgZGVmaW5lIFZvaWNlQ29yZVwiKTtcbiAgcmV0dXJuIHNjb3BlLlZvaWNlQ29yZTtcbn1cblxuLy8gUHJlc2V0czogZWFjaCBzdXJmYWNlJ3Mgc2V0dGluZ3MgYXMgaXRzIGFwcCB3b3VsZCBzZXQgdGhlbS5cblxuY29uc3QgRkFLRV9UViA9IFtcbiAgeyBuYW1lOiBcInR2X3ZvbHVtZVwiLCBkZXNjcmlwdGlvbjogXCJTZXRzIHRoZSBsaXZpbmctcm9vbSBUVidzIHZvbHVtZSwgMCB0byAxMDAuXCIsIHBhcmFtZXRlcnM6IHsgdHlwZTogXCJPQkpFQ1RcIiwgcHJvcGVydGllczogeyBsZXZlbDogeyB0eXBlOiBcIklOVEVHRVJcIiB9IH0sIHJlcXVpcmVkOiBbXCJsZXZlbFwiXSB9IH0sXG4gIHsgbmFtZTogXCJ0dl9wYXVzZVwiLCBkZXNjcmlwdGlvbjogXCJQYXVzZXMgb3IgcmVzdW1lcyB3aGF0J3MgcGxheWluZyBvbiB0aGUgVFYuXCIsIHBhcmFtZXRlcnM6IHsgdHlwZTogXCJPQkpFQ1RcIiwgcHJvcGVydGllczogeyBwYXVzZTogeyB0eXBlOiBcIkJPT0xFQU5cIiB9IH0gfSB9LFxuXTtcblxuY29uc3QgUFJFU0VUUzogUmVjb3JkPHN0cmluZywgUmVjb3JkPHN0cmluZywgdW5rbm93bj4+ID0ge1xuICB3ZWI6IHsgcGxhdGZvcm06IFwid2ViXCIsIGRldmljZTogXCJicm93c2VyXCIsIHN0YW5kYnlBZnRlcjogMzAsIGhhbmRPZmY6IFwibmFtZWRcIiwgc3VwZXJ2aXNlOiB0cnVlLCB2b2NhYnVsYXJ5OiBbXCJIZXJtZXNcIiwgXCJCZW50b1wiLCBcIldvb2Rob3VzZVwiLCBcIlBlbm55d29ydGhcIiwgXCJUM1wiXSB9LFxuICBcIndlYiB3YWtlIHdvcmRcIjoge1xuICAgIHBsYXRmb3JtOiBcIndlYlwiLCBkZXZpY2U6IFwiYnJvd3NlclwiLCBzdGFuZGJ5QWZ0ZXI6IDIwLCBoYW5nVXBBZnRlcjogMTIwLCBoYW5kT2ZmOiBcIm5hbWVkXCIsIHN1cGVydmlzZTogdHJ1ZSxcbiAgICBhdHRlbnRpb246IHsgbW9kZTogXCJ3aW5kb3dcIiwgYWZ0ZXJXYWtlOiA4LCB3aW5kb3c6IDUsIGFmdGVyUXVlc3Rpb246IDEwLCBhZnRlckhhbmRPZmY6IDMsIGFmdGVyQW5ub3VuY2VtZW50OiAwIH0sXG4gICAgdm9jYWJ1bGFyeTogW1wiSGVybWVzXCIsIFwiQmVudG9cIiwgXCJXb29kaG91c2VcIiwgXCJQZW5ueXdvcnRoXCIsIFwiVDNcIl0sXG4gIH0sXG4gIGFuZHJvaWQ6IHsgcGxhdGZvcm06IFwiQW5kcm9pZFwiLCBkZXZpY2U6IFwicGhvbmVcIiwgc3RhbmRieUFmdGVyOiAyMCB9LFxuICBcImFuZHJvaWQgd2FrZSB3b3JkXCI6IHsgcGxhdGZvcm06IFwiQW5kcm9pZFwiLCBkZXZpY2U6IFwicGhvbmVcIiwgc3RhbmRieUFmdGVyOiAyMCwgaGFuZ1VwQWZ0ZXI6IDE1IH0sXG4gIG1hY29zOiB7IHBsYXRmb3JtOiBcIm1hY09TXCIsIGRldmljZTogXCJNYWNcIiwgc3RhbmRieUFmdGVyOiAyMCB9LFxuICBlY2hvOiB7XG4gICAgcGxhdGZvcm06IFwiRWNob1wiLCBkZXZpY2U6IFwic3BlYWtlclwiLCBoYW5nVXBBZnRlcjogNiwgc3RhbmRieUFmdGVyOiA4LCBlYXJjb25zOiB0cnVlLCB2b2NhYnVsYXJ5OiBbXCJIZXJtZXNcIiwgXCJCZW50b1wiLCBcIldvb2Rob3VzZVwiXSxcbiAgICBtaWM6IHsgd2hpbGVTcGVha2luZzogXCJ3YWtlXCIsIGdhaW5EYjogMCB9LCBob3N0VG9vbHM6IEZBS0VfVFYsXG4gIH0sXG59O1xuXG4vLyBTdGF0ZS5cblxuY29uc3QgYXVkaW8gPSBuZXcgQ2FsbEF1ZGlvKCk7XG5sZXQgc2VydmVyOiBTZXJ2ZXJDb25maWc7XG5sZXQgY29yZTogQ29yZSB8IG51bGwgPSBudWxsO1xubGV0IGNhbGxJZCA9IDA7XG4vKiogTW9ub3RvbmljIHBlci1wYWdlIHNlc3Npb24gaWQgKHVubGlrZSBjb3JlJ3MgY2FsbElkL3Rhc2tJZCwgd2hpY2ggcmVzdGFydCBhZnRlciBsb2FkQ29yZSgpKS4gKi9cbmxldCBzZXNzaW9uU2VxID0gMDtcbmxldCBhY3RpdmVTZXNzaW9uID0gMDtcbmxldCBjYWxsTmFtZSA9IFwiXCI7XG5sZXQgdGlja2VyID0gMDtcbmxldCB0cmFjZVRpbWVyID0gMDtcbmxldCBzdGFydGVkQXQgPSBub3coKTtcbmNvbnN0IHNvY2tldHMgPSBuZXcgTWFwPG51bWJlciwgV2ViU29ja2V0PigpO1xuLyoqIFRoZSBzb2NrZXRzIHRvIHRoZSB0cmFuc2NyaXB0aW9uIG1vZGVsOiB0aGVpciBhdWRpbyBpcyB0aGUgbW9kZWwncyBhZ2Fpbiwgc28gaXQgaXNuJ3QgY291bnRlZCBvciBsb2dnZWQgdHdpY2UuICovXG5jb25zdCBjYXB0aW9uU29ja2V0cyA9IG5ldyBTZXQ8bnVtYmVyPigpO1xuY29uc3QgcnVucyA9IG5ldyBNYXA8c3RyaW5nLCB7IGFib3J0OiBBYm9ydENvbnRyb2xsZXI7IGFnZW50OiBzdHJpbmc7IHRhc2tJZDogc3RyaW5nIH0+KCk7XG5pbnRlcmZhY2UgVGFza1ZpZXcgeyBjOiBDb21tYW5kOyBzaW5jZTogbnVtYmVyOyBlbmRlZDogbnVtYmVyIHwgbnVsbDsgdGhyZWFkPzogc3RyaW5nOyByZXN1bHRJZD86IHN0cmluZzsgYXBwcm92YWw/OiB7IGNvbW1hbmQ6IHN0cmluZyB9IH1cbmNvbnN0IHRhc2tzID0gbmV3IE1hcDxzdHJpbmcsIFRhc2tWaWV3PigpO1xuaW50ZXJmYWNlIFJlc3VsdEVudHJ5IHtcbiAgaWQ6IHN0cmluZztcbiAgYWdlbnQ6IHN0cmluZztcbiAgbGFiZWw6IHN0cmluZztcbiAgdGV4dDogc3RyaW5nO1xuICBmYWlsZWQ6IGJvb2xlYW47XG4gIHRhc2tJZD86IHN0cmluZztcbiAgc2Vzc2lvbklkOiBudW1iZXI7XG4gIGNhcmQ6IEhUTUxFbGVtZW50O1xuICBoZWFkOiBIVE1MQnV0dG9uRWxlbWVudDtcbiAgYm9keTogSFRNTEVsZW1lbnQ7XG4gIG1vcmVCdG46IEhUTUxCdXR0b25FbGVtZW50O1xuICBmb2xsb3dCdG4/OiBIVE1MQnV0dG9uRWxlbWVudDtcbiAgcmVmUm93OiBIVE1MQnV0dG9uRWxlbWVudDtcbn1cbmNvbnN0IHJlc3VsdHMgPSBuZXcgTWFwPHN0cmluZywgUmVzdWx0RW50cnk+KCk7XG5sZXQgbmV4dFJlc3VsdFNlcSA9IDA7XG5sZXQgc2lkZUZpbHRlcjogU2lkZUZpbHRlciA9IFwiYWxsXCI7XG5sZXQgdW5yZWFkTW9iaWxlUmVzdWx0cyA9IDA7XG5sZXQgZmxhc2hUaW1lciA9IDA7XG5sZXQgZWFybGllckFjdGl2ZUNvdW50ID0gMDtcbmxldCBlYXJsaWVyV2FpdGluZ0NvdW50ID0gMDtcbmxldCBjb3VudHMgPSB7IG1pYzogMCwgcGxheTogMCwgc2VudDogMCB9O1xubGV0IGZha2VUdkxldmVsID0gMTU7XG5sZXQgY29yZVN0YXR1cyA9IFwiaWRsZVwiO1xubGV0IG11dGVkID0gZmFsc2U7XG5sZXQgaG9sZGluZyA9IGZhbHNlO1xuY29uc3Qgc2NyZWVuV2FrZUxvY2sgPSBuZXcgU2NyZWVuV2FrZUxvY2soKTtcbi8qKiBXYWtlIHdvcmQgbG9vcCBzdGF0ZTogYXJtZWQgYmV0d2VlbiBjYWxscywgcmVxdWVzdGVkIGJ5IGNvcmUgd2hpbGUgZG9ybWFudC9zcGVha2luZywgb3IgbWlkLWhhbmRvZmYuICovXG5sZXQgd2FrZUFybWVkID0gZmFsc2U7XG5sZXQgYXJtR2VuID0gMDtcbmxldCBjb3JlV2FudHNXYWtlID0gZmFsc2U7XG4vKiogV2hpY2ggY2FsbCAob3IgMCBmb3IgaWRsZSkgb3ducyB0aGUgd2FrZSB3b3JrZXIncyBjdXJyZW50IGxpc3RlbmluZyBwZXJpb2QuICovXG5sZXQgd2FrZVBlcmlvZENhbGxJZDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5sZXQgY2FsbFdoaWxlU3BlYWtpbmcgPSBcInNlbmRcIjtcbi8qKiBNaXJyb3JzIHRoZSBjb3JlJ3MgYHNwZWVjaFVudGlsYCBjbG9jayBzbyBlYWNoIG1pYyBmcmFtZSByZWNvcmRzIHdoZXRoZXIgYGNhbGwudHNgIHN1cHByZXNzZWQgaXQuICovXG5sZXQgY29yZVNwZWVjaFVudGlsID0gMDtcbi8qKiBQb3N0LXBsYXliYWNrIHVuc3VwcHJlc3NlZCBtaWMgZnJhbWVzIGhlbGQgYnJpZWZseSB3aGlsZSBhIHN1cHByZXNzZWQgZnJhbWUgaXMgc3RpbGwgc2NvcmluZyBpbiB0aGUgd2FrZSB3b3JrZXIuICovXG5sZXQgZGVmZXJyZWRNaWM6IHsgc2VxOiBudW1iZXI7IHBjbTogc3RyaW5nOyB0OiBudW1iZXIgfVtdID0gW107XG5sZXQgd2FrZUxvYWRpbmcgPSBmYWxzZTtcbmxldCB3YWtlU3RhcnRpbmcgPSBmYWxzZTtcbmxldCBzdGFydGluZ0NhbGwgPSBmYWxzZTtcbmxldCBvcGVuaW5nQ2h1bmtzOiBVaW50OEFycmF5W10gPSBbXTtcbmxldCBvcGVuaW5nQnl0ZXMgPSAwO1xuY29uc3QgT1BFTklOR19NQVhfQllURVMgPSAxMCAqIDMyXzAwMDtcbmxldCB3YWtlTGFzdFRlbDogV2FrZVRlbGVtZXRyeSB8IG51bGwgPSBudWxsO1xuLyoqIFdoYXQgdGhlIHNlc3Npb24gb24gc2NyZWVuIGlzOiBhIHZvaWNlIGNhbGwsIG9yIGEgdHlwZWQgY2hhdCAodGhlIGNvcmUncyBtZWRpdW0gXCJ0ZXh0XCIpLiAqL1xubGV0IG1lZGl1bTogXCJ2b2ljZVwiIHwgXCJ0ZXh0XCIgPSBcInZvaWNlXCI7XG4vKiogQSBjaGF0J3MgbW9kZWwgaXMgd3JpdGluZyBpdHMgYW5zd2VyLiAqL1xubGV0IHRoaW5raW5nID0gZmFsc2U7XG4vKiogQSBjaGF0J3MgcmVxdWVzdHMgdG8gdGhlIHRleHQgbW9kZWwgdGhhdCBhcmUgdW5kZXIgd2F5LiAqL1xuY29uc3QgcmVxdWVzdHMgPSBuZXcgTWFwPG51bWJlciwgQWJvcnRDb250cm9sbGVyPigpO1xuLyoqIFRoZSBsYXN0IHNlc3Npb24gd2luZGluZyBkb3duIChpdHMgdHJhY2Ugc2F2ZWQsIHRoZSBjb3JlJ3MgY2FsbCBkaXNwb3NlZCk6IHRoZSBuZXh0IHN0YXJ0cyBhZnRlciBpdC4gKi9cbmxldCBlbmRpbmc6IFByb21pc2U8dm9pZD4gPSBQcm9taXNlLnJlc29sdmUoKTtcblxuLy8gVGhlIGNvbnZlcnNhdGlvbiwga2VwdCBzbyBhIG5ldyBjYWxsIGNhbiBjYXJyeSBvbiBmcm9tIGl0ICh0aGUgY29yZSdzIGBoaXN0b3J5YCwgcmVjYXBwZWQgdG8gdGhlIG1vZGVsKS5cbmludGVyZmFjZSBDaGF0TGluZSB7IHJvbGU6IFwidXNlclwiIHwgXCJhc3Npc3RhbnRcIjsgc3BlYWtlcj86IHN0cmluZzsgdGV4dDogc3RyaW5nIH1cbmNvbnN0IEhJU1RPUlkgPSBcInZvaWNlLmhpc3RvcnlcIjtcbmNvbnN0IEhJU1RPUllfTUFYX0FHRSA9IDEyICogMzYwMCAqIDEwMDA7XG5sZXQgY2hhdDogQ2hhdExpbmVbXSA9IFtdO1xuLyoqIFRoZSBjb3JlJ3MgbnVtYmVyIGZvciB0aGUgbGluZSB0aGUgbGFzdCB3b3JkcyB3ZXJlIHJlbWVtYmVyZWQgb24sIHVudGlsIHNvbWV0aGluZyBlbHNlIGlzLiAqL1xubGV0IGxhc3RMaW5lOiBudW1iZXIgfCBudWxsID0gbnVsbDtcblxuZnVuY3Rpb24gcmVtZW1iZXIocm9sZTogXCJ1c2VyXCIgfCBcImFzc2lzdGFudFwiLCB0ZXh0OiBzdHJpbmcsIHNwZWFrZXI/OiBzdHJpbmcsIGpvaW4gPSBmYWxzZSkge1xuICBjb25zdCBsYXN0ID0gY2hhdC5hdCgtMSk7XG4gIGlmIChqb2luICYmIGxhc3QgJiYgbGFzdC5yb2xlID09PSByb2xlICYmIGxhc3Quc3BlYWtlciA9PT0gc3BlYWtlcikgbGFzdC50ZXh0ICs9IHRleHQ7XG4gIGVsc2UgY2hhdC5wdXNoKHNwZWFrZXIgPyB7IHJvbGUsIHNwZWFrZXIsIHRleHQgfSA6IHsgcm9sZSwgdGV4dCB9KTtcbiAgaWYgKGNoYXQubGVuZ3RoID4gMjAwKSBjaGF0LnNwbGljZSgwLCBjaGF0Lmxlbmd0aCAtIDIwMCk7XG4gIGxvY2FsU3RvcmFnZS5zZXRJdGVtKEhJU1RPUlksIEpTT04uc3RyaW5naWZ5KHsgYXQ6IERhdGUubm93KCksIGNoYXQgfSkpO1xufVxuXG5mdW5jdGlvbiBzYXZlZEhpc3RvcnkoKTogQ2hhdExpbmVbXSB7XG4gIHRyeSB7XG4gICAgY29uc3Qgc2F2ZWQgPSBKU09OLnBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKEhJU1RPUlkpID8/IFwibnVsbFwiKTtcbiAgICByZXR1cm4gc2F2ZWQgJiYgRGF0ZS5ub3coKSAtIHNhdmVkLmF0IDwgSElTVE9SWV9NQVhfQUdFICYmIEFycmF5LmlzQXJyYXkoc2F2ZWQuY2hhdCkgPyBzYXZlZC5jaGF0IDogW107XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBbXTtcbiAgfVxufVxuXG4vKiogVHdvLW5vdGUgY2hpbWUsIFBDTTE2IG1vbm8gYXQgMjQga0h6LCBiYXNlNjQuICovXG5mdW5jdGlvbiB0d29Ob3RlVG9uZShmMTogbnVtYmVyLCBmMjogbnVtYmVyLCBub3RlU2VjOiBudW1iZXIsIGFtcDogbnVtYmVyKTogc3RyaW5nIHtcbiAgY29uc3QgcmF0ZSA9IDI0MDAwLCBuID0gTWF0aC5yb3VuZChyYXRlICogbm90ZVNlYyAqIDIpLCBoYWxmID0gTWF0aC5yb3VuZChyYXRlICogbm90ZVNlYyksIG91dCA9IG5ldyBJbnQxNkFycmF5KG4pO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IG47IGkrKykge1xuICAgIGNvbnN0IGZpcnN0ID0gaSA8IGhhbGY7XG4gICAgY29uc3QgdCA9IGkgLyByYXRlLCBmID0gZmlyc3QgPyBmMSA6IGYyLCBsb2NhbCA9IGZpcnN0ID8gdCA6IHQgLSBub3RlU2VjO1xuICAgIGNvbnN0IGVudiA9IE1hdGgubWluKDEsIGxvY2FsICogNjAsIChub3RlU2VjIC0gbG9jYWwpICogNjApO1xuICAgIG91dFtpXSA9IE1hdGgucm91bmQoTWF0aC5zaW4oMiAqIE1hdGguUEkgKiBmICogdCkgKiBNYXRoLm1heCgwLCBlbnYpICogYW1wKTtcbiAgfVxuICByZXR1cm4gYnl0ZXNUb0Jhc2U2NChuZXcgVWludDhBcnJheShvdXQuYnVmZmVyKSk7XG59XG5cbi8qKiBUd28gcmlzaW5nIG5vdGVzOiBzb21ldGhpbmcgb24gdGhlIHNjcmVlbiBuZWVkcyB0aGUgdXNlci4gKi9cbmNvbnN0IEFQUFJPVkFMX1RPTkUgPSB0d29Ob3RlVG9uZSg2NjAsIDg4MCwgMC4xNiwgNjAwMCk7XG4vKiogQ3Jpc3AgcmlzaW5nIGNoaW1lOiB0aGUgd2FrZSB3b3JkIGZpcmVkIChzdGFydCBzaWduYWwpLiAqL1xuY29uc3QgV0FLRV9UT05FID0gdHdvTm90ZVRvbmUoNTg3LjMzLCA4ODAsIDAuMTEsIDU1MDApO1xuLyoqIFNvZnQgZmFsbGluZyBjaGltZTogdGhlIGF0dGVudGlvbiB3aW5kb3cgY2xvc2VkIGFuZCB0aGUgY2FsbCB3ZW50IGRvcm1hbnQgKGVuZCBzaWduYWwpLiAqL1xuY29uc3QgU0xFRVBfVE9ORSA9IHR3b05vdGVUb25lKDY1OS4yNSwgNDkzLjg4LCAwLjExLCAzNDAwKTtcblxuLy8gTGF0ZW5jeTogdGhlIG5ldHdvcmsncyByb3VuZCB0cmlwLCBhbmQgaG93IGxvbmcgYWZ0ZXIgdGhlIHVzZXIgc3RvcHMgdGFsa2luZyB0aGUgcmVwbHkgc3RhcnRzLlxuY29uc3QgbWV0cmljcyA9IHsgcnR0OiBbXSBhcyBudW1iZXJbXSwgcmVwbHk6IFtdIGFzIG51bWJlcltdLCBsYXN0Vm9pY2U6IDAsIGxhc3RQbGF5OiAwLCByZXBsaWVkOiB0cnVlIH07XG5cbmZ1bmN0aW9uIG1lZGlhbih4czogbnVtYmVyW10pOiBudW1iZXIgfCBudWxsIHtcbiAgaWYgKHhzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHMgPSBbLi4ueHNdLnNvcnQoKGEsIGIpID0+IGEgLSBiKTtcbiAgcmV0dXJuIHNbTWF0aC5mbG9vcihzLmxlbmd0aCAvIDIpXTtcbn1cblxuZnVuY3Rpb24gc2hvd01ldHJpY3MoKSB7XG4gIGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBydHQgPSBtZWRpYW4obWV0cmljcy5ydHQpO1xuICBpZiAocnR0ICE9IG51bGwpIHBhcnRzLnB1c2goYCR7TWF0aC5yb3VuZChydHQgKiAxMDAwKX0gbXNgKTtcbiAgY29uc3QgcmVwbHkgPSBtZWRpYW4obWV0cmljcy5yZXBseSk7XG4gIGlmIChyZXBseSAhPSBudWxsKSBwYXJ0cy5wdXNoKGByZXBseSAke21ldHJpY3MucmVwbHkuYXQoLTEpIS50b0ZpeGVkKDEpfXMgKCR7cmVwbHkudG9GaXhlZCgxKX1zIG1lZClgKTtcbiAgY29uc3Qgb3V0ID0gYXVkaW8ub3V0cHV0TGF0ZW5jeTtcbiAgaWYgKG91dCAhPSBudWxsKSBwYXJ0cy5wdXNoKGBhdWRpbyAke01hdGgucm91bmQob3V0ICogMTAwMCl9IG1zYCk7XG4gIGxldCBidWZmZXJlZCA9IDA7XG4gIGZvciAoY29uc3Qgd3Mgb2Ygc29ja2V0cy52YWx1ZXMoKSkgYnVmZmVyZWQgKz0gd3MuYnVmZmVyZWRBbW91bnQ7XG4gIGlmIChidWZmZXJlZCA+IDMyXzAwMCkgcGFydHMucHVzaChgdXBsb2FkICskeyhidWZmZXJlZCAvIDMyXzAwMCkudG9GaXhlZCgxKX1zYCk7XG4gICQoXCJtZXRyaWNzXCIpLnRleHRDb250ZW50ID0gcGFydHMuam9pbihcIiBcdTAwQjcgXCIpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBwaW5nKCkge1xuICBjb25zdCB0ID0gbm93KCk7XG4gIHRyeSB7XG4gICAgYXdhaXQgZmV0Y2goXCIvcGluZ1wiLCB7IGNhY2hlOiBcIm5vLXN0b3JlXCIgfSk7XG4gICAgbWV0cmljcy5ydHQucHVzaChub3coKSAtIHQpO1xuICAgIGlmIChtZXRyaWNzLnJ0dC5sZW5ndGggPiAxMikgbWV0cmljcy5ydHQuc2hpZnQoKTtcbiAgfSBjYXRjaCB7fVxuICBzaG93TWV0cmljcygpO1xufVxuXG4vLyBUaGVtZSAmIGRlbnNpdHkuXG5cbmZ1bmN0aW9uIGFwcGx5VGhlbWUoY2hvaWNlOiBzdHJpbmcpIHtcbiAgY29uc3Qgcm9vdCA9IGRvY3VtZW50LmRvY3VtZW50RWxlbWVudDtcbiAgaWYgKGNob2ljZSA9PT0gXCJkYXJrXCIgfHwgY2hvaWNlID09PSBcImxpZ2h0XCIpIHJvb3QuZGF0YXNldC50aGVtZSA9IGNob2ljZTtcbiAgZWxzZSBkZWxldGUgcm9vdC5kYXRhc2V0LnRoZW1lO1xuICBjb25zdCBkYXJrID0gY2hvaWNlID09PSBcImRhcmtcIiB8fCAoY2hvaWNlICE9PSBcImxpZ2h0XCIgJiYgbWF0Y2hNZWRpYShcIihwcmVmZXJzLWNvbG9yLXNjaGVtZTogZGFyaylcIikubWF0Y2hlcyk7XG4gIGNvbnN0IG1ldGEgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInRoZW1lLWNvbG9yXCIpO1xuICBpZiAobWV0YSkgbWV0YS5zZXRBdHRyaWJ1dGUoXCJjb250ZW50XCIsIGRhcmsgPyBcIiMwZTBmMGZcIiA6IFwiI2Y2ZjVmMFwiKTtcbiAgZm9yIChjb25zdCBidG4gb2YgQXJyYXkuZnJvbShkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxCdXR0b25FbGVtZW50PihcIiN0aGVtZS1waWNrZXIgYnV0dG9uXCIpKSkge1xuICAgIGJ0bi5jbGFzc0xpc3QudG9nZ2xlKFwib25cIiwgYnRuLmRhdGFzZXQudGhlbWUgPT09IChjaG9pY2UgfHwgXCJzeXN0ZW1cIikpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGFwcGx5RGVuc2l0eShjaG9pY2U6IHN0cmluZyB8IG51bGwpIHtcbiAgY29uc3QgZGVuc2l0eSA9IG5vcm1hbGl6ZURlbnNpdHkoY2hvaWNlKTtcbiAgY29uc3Qgcm9vdCA9IGRvY3VtZW50LmRvY3VtZW50RWxlbWVudDtcbiAgaWYgKGRlbnNpdHkgPT09IFwiY29tZm9ydGFibGVcIikgcm9vdC5kYXRhc2V0LmRlbnNpdHkgPSBcImNvbWZvcnRhYmxlXCI7XG4gIGVsc2UgZGVsZXRlIHJvb3QuZGF0YXNldC5kZW5zaXR5O1xuICBmb3IgKGNvbnN0IGJ0biBvZiBBcnJheS5mcm9tKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiI2RlbnNpdHktcGlja2VyIGJ1dHRvblwiKSkpIHtcbiAgICBidG4uY2xhc3NMaXN0LnRvZ2dsZShcIm9uXCIsIGJ0bi5kYXRhc2V0LmRlbnNpdHkgPT09IGRlbnNpdHkpO1xuICB9XG4gIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB1cGRhdGVBbGxSZXN1bHRDbGFtcGluZygpKTtcbn1cblxuLy8gVGhlIHNjcmVlbi5cblxuZnVuY3Rpb24gc2V0Q2FsbEJ1dHRvbihsaXZlOiBib29sZWFuKSB7XG4gIGNvbnN0IGJ0biA9ICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiY2FsbFwiKTtcbiAgYnRuLmNsYXNzTGlzdC50b2dnbGUoXCJsaXZlXCIsIGxpdmUpO1xuICBjb25zdCBsYWJlbCA9IGJ0bi5xdWVyeVNlbGVjdG9yKFwiLmNhbGwtbGFiZWxcIik7XG4gIGlmIChsYWJlbCkgbGFiZWwudGV4dENvbnRlbnQgPSBsaXZlID8gXCJIYW5nIHVwXCIgOiBcIkNhbGxcIjtcbn1cblxuZnVuY3Rpb24gc3luY1Jlc3VtZUJ1dHRvbnMoc2hvdzogYm9vbGVhbikge1xuICAkKFwicmVzdW1lXCIpLmhpZGRlbiA9ICFzaG93O1xuICAkKFwiaGVyby1yZXN1bWVcIikuaGlkZGVuID0gIXNob3c7XG59XG5cbmZ1bmN0aW9uIHN5bmNDb21wb3NlcigpIHtcbiAgY29uc3QgaW5wdXQgPSAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwidGV4dFwiKTtcbiAgY29uc3QgdHJpbW1lZCA9IGlucHV0LnZhbHVlLnRyaW0oKTtcbiAgJChcInNlbmRidG5cIikuY2xhc3NMaXN0LnRvZ2dsZShcInJlYWR5XCIsIHRyaW1tZWQubGVuZ3RoID4gMCk7XG4gIGNvbnN0IHBhcnNlZCA9IHBhcnNlUHJlZml4KHRyaW1tZWQpO1xuICAkKFwibW9kZS13cmFwXCIpLmRhdGFzZXQubW9kZSA9IHBhcnNlZC5tb2RlID8/ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwibW9kZVwiKS52YWx1ZTtcbn1cblxuZnVuY3Rpb24gZm9ybWF0Q2xvY2soc2Vjb25kczogbnVtYmVyKTogc3RyaW5nIHtcbiAgY29uc3QgdG90YWwgPSBNYXRoLm1heCgwLCBNYXRoLmZsb29yKHNlY29uZHMpKTtcbiAgY29uc3QgaCA9IE1hdGguZmxvb3IodG90YWwgLyAzNjAwKTtcbiAgY29uc3QgbSA9IE1hdGguZmxvb3IoKHRvdGFsICUgMzYwMCkgLyA2MCk7XG4gIGNvbnN0IHMgPSB0b3RhbCAlIDYwO1xuICBjb25zdCBwYWQgPSAobjogbnVtYmVyKSA9PiBTdHJpbmcobikucGFkU3RhcnQoMiwgXCIwXCIpO1xuICByZXR1cm4gaCA+IDAgPyBgJHtofToke3BhZChtKX06JHtwYWQocyl9YCA6IGAke3BhZChtKX06JHtwYWQocyl9YDtcbn1cblxuY29uc3QgVklaX1dFSUdIVFMgPSBbMC40OCwgMC44NiwgMS4wLCAwLjc4LCAwLjQ0XTtcbmZ1bmN0aW9uIHVwZGF0ZVZpc3VhbGl6ZXIobW9kZTogc3RyaW5nLCBsZXZlbDogbnVtYmVyKSB7XG4gIGNvbnN0IHZpeiA9ICQoXCJ2aXpcIik7XG4gIHZpei5kYXRhc2V0Lm1vZGUgPSBtb2RlO1xuICBjb25zdCBiYXJzID0gdml6LmNoaWxkcmVuO1xuICBpZiAobW9kZSA9PT0gXCJsaXN0ZW5pbmdcIiB8fCBtb2RlID09PSBcIndvcmtpbmdcIikge1xuICAgIGNvbnN0IGVuZXJneSA9IE1hdGgubWluKDEsIGxldmVsICogMTQpO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYmFycy5sZW5ndGg7IGkrKykge1xuICAgICAgY29uc3QgaCA9IDAuMjQgKyBlbmVyZ3kgKiBWSVpfV0VJR0hUU1tpXSAqIDAuNzY7XG4gICAgICAoYmFyc1tpXSBhcyBIVE1MRWxlbWVudCkuc3R5bGUudHJhbnNmb3JtID0gYHNjYWxlWSgke2gudG9GaXhlZCgyKX0pYDtcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBiYXJzLmxlbmd0aDsgaSsrKSAoYmFyc1tpXSBhcyBIVE1MRWxlbWVudCkuc3R5bGUudHJhbnNmb3JtID0gXCJcIjtcbiAgfVxufVxuXG4vKiogQSBzeXN0ZW0gbm90aWZpY2F0aW9uIHdoaWxlIHRoZSBwYWdlIGlzIGhpZGRlbjogYSB0YXNrIGZpbmlzaGVkLCBvciBvbmUgbmVlZHMgdGhlIHVzZXIuICovXG5mdW5jdGlvbiBub3RpZnkodGl0bGU6IHN0cmluZywgYm9keTogc3RyaW5nKSB7XG4gIGlmICghZG9jdW1lbnQuaGlkZGVuIHx8ICEoXCJOb3RpZmljYXRpb25cIiBpbiB3aW5kb3cpIHx8IE5vdGlmaWNhdGlvbi5wZXJtaXNzaW9uICE9PSBcImdyYW50ZWRcIikgcmV0dXJuO1xuICB0cnkge1xuICAgIGNvbnN0IG4gPSBuZXcgTm90aWZpY2F0aW9uKHRpdGxlLCB7IGJvZHk6IGJvZHkuc2xpY2UoMCwgMTgwKSwgaWNvbjogXCIvd2ViL2ljb25zL2ljb24tMTkyLnBuZ1wiLCB0YWc6IHRpdGxlIH0pO1xuICAgIG4ub25jbGljayA9ICgpID0+IHsgd2luZG93LmZvY3VzKCk7IG4uY2xvc2UoKTsgfTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gUGhvbmVzIHdhbnQgbm90aWZpY2F0aW9ucyBmcm9tIGEgc2VydmljZSB3b3JrZXI7IHRoZSBwYWdlIGhhcyBub25lLlxuICB9XG59XG5cbmZ1bmN0aW9uIHRvYXN0KHRleHQ6IHN0cmluZykge1xuICBjb25zdCB0ID0gJChcInRvYXN0XCIpO1xuICB0LnRleHRDb250ZW50ID0gdGV4dDtcbiAgdC5jbGFzc0xpc3QuYWRkKFwib25cIik7XG4gIGNsZWFyVGltZW91dCgodG9hc3QgYXMgYW55KS50aW1lcik7XG4gICh0b2FzdCBhcyBhbnkpLnRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB0LmNsYXNzTGlzdC5yZW1vdmUoXCJvblwiKSwgMTgwMCk7XG59XG5cbmZ1bmN0aW9uIGxvZyhraW5kOiBzdHJpbmcsIHRleHQ6IHN0cmluZywgY2xzID0gXCJcIikge1xuICBjb25zdCBwYW5lID0gJChcImxvZ1wiKTtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IGByb3cgJHtjbHN9YDtcbiAgcm93LmlubmVySFRNTCA9IGA8c3BhbiBjbGFzcz1cInRcIj4keyhub3coKSAtIHN0YXJ0ZWRBdCkudG9GaXhlZCgyKX08L3NwYW4+PHNwYW4gY2xhc3M9XCJrXCI+JHtraW5kfTwvc3Bhbj5gO1xuICBjb25zdCBib2R5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGJvZHkuY2xhc3NOYW1lID0gXCJiXCI7XG4gIGJvZHkudGV4dENvbnRlbnQgPSB0ZXh0O1xuICByb3cuYXBwZW5kKGJvZHkpO1xuICBjb25zdCBzdGljayA9IHBhbmUuc2Nyb2xsVG9wICsgcGFuZS5jbGllbnRIZWlnaHQgPj0gcGFuZS5zY3JvbGxIZWlnaHQgLSAzMDtcbiAgcGFuZS5hcHBlbmQocm93KTtcbiAgd2hpbGUgKHBhbmUuY2hpbGRFbGVtZW50Q291bnQgPiAzMDAwKSBwYW5lLmZpcnN0RWxlbWVudENoaWxkIS5yZW1vdmUoKTtcbiAgaWYgKHN0aWNrKSBwYW5lLnNjcm9sbFRvcCA9IHBhbmUuc2Nyb2xsSGVpZ2h0O1xufVxuXG4vKiogQSBmcmFtZSBmcm9tIG9yIHRvIEdlbWluaSwgd2l0aCBhdWRpbyBjdXQgb3V0LCBzaG9ydCBlbm91Z2ggdG8gcmVhZC4gKi9cbmZ1bmN0aW9uIGJyaWVmKGRhdGE6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBkYXRhLnJlcGxhY2UoL1wiZGF0YVwiOlwiW0EtWmEtejAtOSsvPV17NDAsfVwiL2csIChtKSA9PiBgXCJkYXRhXCI6XCJcdTIwMjYke01hdGgucm91bmQoKChtLmxlbmd0aCAtIDkpICogMykgLyA0KX0gYnl0ZXNcImApLnNsaWNlKDAsIDYwMCk7XG59XG5cbmZ1bmN0aW9uIGVzY2FwZUh0bWwodGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHRleHQucmVwbGFjZSgvWyY8PlwiJ10vZywgKGMpID0+ICh7IFwiJlwiOiBcIiZhbXA7XCIsIFwiPFwiOiBcIiZsdDtcIiwgXCI+XCI6IFwiJmd0O1wiLCAnXCInOiBcIiZxdW90O1wiLCBcIidcIjogXCImIzM5O1wiIH0pW2NdISk7XG59XG5cbi8qKiBBIGxpdHRsZSBNYXJrZG93biwgc2FmZWx5OiBjb2RlLCBib2xkLCBsaW5rcywgbGlzdHMgYW5kIGhlYWRpbmdzLCB0aGUgcmVzdCBhcyB0ZXh0LiAqL1xuZnVuY3Rpb24gbWFya2Rvd24odGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgYmxvY2tzID0gZXNjYXBlSHRtbCh0ZXh0LnRyaW0oKSkuc3BsaXQoL2BgYCg/OlxcdyspP1xcbj8vKTtcbiAgcmV0dXJuIGJsb2Nrcy5tYXAoKGJsb2NrLCBpKSA9PiB7XG4gICAgaWYgKGkgJSAyID09PSAxKSByZXR1cm4gYDxwcmU+PGNvZGU+JHtibG9jay5yZXBsYWNlKC9cXG4kLywgXCJcIil9PC9jb2RlPjwvcHJlPmA7XG4gICAgY29uc3QgaW5saW5lID0gKHM6IHN0cmluZykgPT4gc1xuICAgICAgLnJlcGxhY2UoL2AoW15gXFxuXSspYC9nLCBcIjxjb2RlPiQxPC9jb2RlPlwiKVxuICAgICAgLnJlcGxhY2UoL1xcKlxcKihbXipcXG5dKylcXCpcXCovZywgXCI8Yj4kMTwvYj5cIilcbiAgICAgIC5yZXBsYWNlKC9cXFsoW15cXF1cXG5dKylcXF1cXCgoaHR0cHM/OlxcL1xcL1teXFxzKV0rKVxcKS9nLCAnPGEgaHJlZj1cIiQyXCIgdGFyZ2V0PVwiX2JsYW5rXCIgcmVsPVwibm9vcGVuZXJcIj4kMTwvYT4nKVxuICAgICAgLnJlcGxhY2UoLyhefFtcXHMoXSkoaHR0cHM/OlxcL1xcL1teXFxzPCldKykvZywgJyQxPGEgaHJlZj1cIiQyXCIgdGFyZ2V0PVwiX2JsYW5rXCIgcmVsPVwibm9vcGVuZXJcIj4kMjwvYT4nKTtcbiAgICBsZXQgaHRtbCA9IFwiXCI7XG4gICAgbGV0IGxpc3Q6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgIGZvciAoY29uc3QgcmF3IG9mIGJsb2NrLnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgICBjb25zdCBpdGVtID0gcmF3Lm1hdGNoKC9eXFxzKig/OlstKlx1MjAyMl18KFxcZCspWy4pXSlcXHMrKC4qKSQvKTtcbiAgICAgIGlmIChpdGVtKSB7XG4gICAgICAgIGNvbnN0IGtpbmQgPSBpdGVtWzFdID8gXCJvbFwiIDogXCJ1bFwiO1xuICAgICAgICBpZiAobGlzdCAhPT0ga2luZCkgeyBpZiAobGlzdCkgaHRtbCArPSBgPC8ke2xpc3R9PmA7IGh0bWwgKz0gYDwke2tpbmR9PmA7IGxpc3QgPSBraW5kOyB9XG4gICAgICAgIGh0bWwgKz0gYDxsaT4ke2lubGluZShpdGVtWzJdKX08L2xpPmA7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgaWYgKGxpc3QpIHsgaHRtbCArPSBgPC8ke2xpc3R9PmA7IGxpc3QgPSBudWxsOyB9XG4gICAgICBjb25zdCBoZWFkaW5nID0gcmF3Lm1hdGNoKC9eI3sxLDZ9XFxzKyguKikkLyk7XG4gICAgICBodG1sICs9IGhlYWRpbmcgPyBgPGRpdiBjbGFzcz1cIm1kLWhcIj4ke2lubGluZShoZWFkaW5nWzFdKX08L2Rpdj5gIDogcmF3LnRyaW0oKSA9PT0gXCJcIiA/IFwiPGJyPlwiIDogYCR7aW5saW5lKHJhdyl9PGJyPmA7XG4gICAgfVxuICAgIGlmIChsaXN0KSBodG1sICs9IGA8LyR7bGlzdH0+YDtcbiAgICByZXR1cm4gaHRtbC5yZXBsYWNlKC8oPGJyPikrJC8sIFwiXCIpO1xuICB9KS5qb2luKFwiXCIpO1xufVxuXG5jb25zdCB0cmFuc2NyaXB0U2Nyb2xsID0gbmV3IEF1dG9TY3JvbGxlcigkKFwidHJhbnNjcmlwdFwiKSwge1xuICBvbkp1bXBDaGFuZ2U6IChzaG93KSA9PiB7ICQoXCJqdW1wYm90dG9tXCIpLmhpZGRlbiA9ICFzaG93OyB9LFxuICBpc0VtcHR5OiAoKSA9PiAhJChcImVtcHR5XCIpLmhpZGRlbixcbn0pO1xuXG5mdW5jdGlvbiBzY3JvbGxEb3duKGZvcmNlID0gZmFsc2UpIHtcbiAgdHJhbnNjcmlwdFNjcm9sbC5vbkNvbnRlbnQoZm9yY2UpO1xufVxuXG4vKiogVGhlIGNvcmUncyBudW1iZXIgZm9yIHRoZSBsaW5lIHRoZSBsYXN0IHJvdyBzaG93cywgdW50aWwgYW5vdGhlciByb3cgZm9sbG93cyBpdC4gKi9cbmxldCBvcGVuTGluZTogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5cbi8qKiBXb3JkcyBnbyBvbiB0aGUgcm93IHRoZSBjb3JlIHNheXMgdGhleSBiZWxvbmcgdG86IGl0IHN0YXJ0cyBhIG5ldyBsaW5lIGZvciBlYWNoIHR1cm4sIGhvd2V2ZXIgbG9uZyB0aGUgZ2FwLiAqL1xuZnVuY3Rpb24gdHJhbnNjcmlwdChyb2xlOiBcInVzZXJcIiB8IFwiYXNzaXN0YW50XCIsIHRleHQ6IHN0cmluZywgbGluZTogbnVtYmVyKSB7XG4gICQoXCJlbXB0eVwiKS5oaWRkZW4gPSB0cnVlO1xuICBjb25zdCBwYW5lID0gJChcInRyYW5zY3JpcHRcIik7XG4gIGNvbnN0IGxhc3QgPSBwYW5lLmxhc3RFbGVtZW50Q2hpbGQgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAob3BlbkxpbmUgPT09IGxpbmUgJiYgbGFzdCAmJiBsYXN0LmRhdGFzZXQucm9sZSA9PT0gcm9sZSkgbGFzdC5xdWVyeVNlbGVjdG9yKFwiLnRleHRcIikhLnRleHRDb250ZW50ICs9IHRleHQ7XG4gIGVsc2Uge1xuICAgIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgcm93LmNsYXNzTmFtZSA9IGBsaW5lICR7cm9sZX1gO1xuICAgIHJvdy5kYXRhc2V0LnJvbGUgPSByb2xlO1xuICAgIHJvdy5pbm5lckhUTUwgPSBgPHNwYW4gY2xhc3M9XCJ3aG9cIj4ke3JvbGUgPT09IFwidXNlclwiID8gXCJZb3VcIiA6IFwiR2VtaW5pXCJ9PC9zcGFuPjxzcGFuIGNsYXNzPVwidGV4dFwiPjwvc3Bhbj5gO1xuICAgIHJvdy5xdWVyeVNlbGVjdG9yKFwiLnRleHRcIikhLnRleHRDb250ZW50ID0gdGV4dC50cmltU3RhcnQoKTtcbiAgICBwYW5lLmFwcGVuZChyb3cpO1xuICAgIG9wZW5MaW5lID0gbGluZTtcbiAgfVxuICBzY3JvbGxEb3duKCk7XG59XG5cbi8qKlxuICogVGhlIHdvcmRzIHRoZSB1c2VyIGlzIHNheWluZywgYmVmb3JlIHRoZSBtb2RlbCBoYXMgdHJhbnNjcmliZWQgdGhlbTogYSBmYWludCByb3cgdGhhdCBzdGF5cyBsYXN0XG4gKiBvbiBzY3JlZW4gKGl0cyBDU1MgYG9yZGVyYCkgYW5kIGZpcnN0IGluIHRoZSBwYW5lLCBzbyB0aGUgbGluZXMgYWZ0ZXIgaXQgam9pbiB1cCBhcyBiZWZvcmUuXG4gKi9cbmZ1bmN0aW9uIGNhcHRpb24odGV4dDogc3RyaW5nIHwgbnVsbCkge1xuICBjb25zdCBwYW5lID0gJChcInRyYW5zY3JpcHRcIik7XG4gIGxldCByb3cgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImNhcHRpb25cIik7XG4gIGlmICh0ZXh0ID09IG51bGwpIHsgcm93Py5yZW1vdmUoKTsgc2Nyb2xsRG93bigpOyByZXR1cm47IH1cbiAgJChcImVtcHR5XCIpLmhpZGRlbiA9IHRydWU7XG4gIGlmICghcm93KSB7XG4gICAgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICByb3cuaWQgPSBcImNhcHRpb25cIjtcbiAgICByb3cuY2xhc3NOYW1lID0gXCJsaW5lIHVzZXIgY2FwdGlvblwiO1xuICAgIHJvdy5pbm5lckhUTUwgPSBgPHNwYW4gY2xhc3M9XCJ3aG9cIj5Zb3U8L3NwYW4+PHNwYW4gY2xhc3M9XCJ0ZXh0XCI+PC9zcGFuPmA7XG4gICAgcGFuZS5wcmVwZW5kKHJvdyk7XG4gIH1cbiAgcm93LnF1ZXJ5U2VsZWN0b3IoXCIudGV4dFwiKSEudGV4dENvbnRlbnQgPSB0ZXh0O1xuICBzY3JvbGxEb3duKCk7XG59XG5cbmZ1bmN0aW9uIG5vdGUodGV4dDogc3RyaW5nKSB7XG4gICQoXCJlbXB0eVwiKS5oaWRkZW4gPSB0cnVlO1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gXCJsaW5lIG5vdGVcIjtcbiAgcm93LnRleHRDb250ZW50ID0gdGV4dDtcbiAgJChcInRyYW5zY3JpcHRcIikuYXBwZW5kKHJvdyk7XG4gIG9wZW5MaW5lID0gbnVsbDtcbiAgc2Nyb2xsRG93bigpO1xufVxuXG4vLyBBZ2VudCBoYW5kb2ZmIHJlc3VsdHM6IGNvbXBhY3QgMS1saW5lIHJlZmVyZW5jZSBpbiB0aGUgdm9pY2Ugc3RyZWFtICsgZnVsbCBjb2xsYXBzaWJsZSBjYXJkIGluIHRoZSByaWdodCBwYW5lLlxuXG5mdW5jdGlvbiByZXN1bHRDbGFtcFB4KGVsOiBIVE1MRWxlbWVudCk6IG51bWJlciB7XG4gIGNvbnN0IHJhdyA9IGdldENvbXB1dGVkU3R5bGUoZWwpLmdldFByb3BlcnR5VmFsdWUoXCItLXJlcy1jbGFtcC1tYXhcIikudHJpbSgpO1xuICBjb25zdCBuID0gTnVtYmVyLnBhcnNlRmxvYXQocmF3KTtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShuKSAmJiBuID4gMCA/IG4gOiA2NDtcbn1cblxuZnVuY3Rpb24gc3luY0V4cGFuZEFsbEJ1dHRvbigpIHtcbiAgY29uc3QgY2xhbXBlZCA9IFsuLi5yZXN1bHRzLnZhbHVlcygpXS5maWx0ZXIoKHIpID0+IHIuY2FyZC5jbGFzc0xpc3QuY29udGFpbnMoXCJjbGFtcGVkXCIpKTtcbiAgY29uc3QgYnRuID0gJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJ0b2dnbGUtYWxsLXJlc3VsdHNcIik7XG4gIGJ0bi5oaWRkZW4gPSBjbGFtcGVkLmxlbmd0aCA9PT0gMDtcbiAgaWYgKGNsYW1wZWQubGVuZ3RoID09PSAwKSByZXR1cm47XG4gIGNvbnN0IGFueUNvbGxhcHNlZCA9IGNsYW1wZWQuc29tZSgocikgPT4gIXIuY2FyZC5jbGFzc0xpc3QuY29udGFpbnMoXCJvcGVuXCIpKTtcbiAgYnRuLnRleHRDb250ZW50ID0gYW55Q29sbGFwc2VkID8gXCJFeHBhbmQgYWxsXCIgOiBcIkNvbGxhcHNlIGFsbFwiO1xufVxuXG5mdW5jdGlvbiBzZXRSZXN1bHRPcGVuKGVudHJ5OiBSZXN1bHRFbnRyeSwgb3BlbjogYm9vbGVhbikge1xuICBjb25zdCBjbGFtcGVkID0gZW50cnkuY2FyZC5jbGFzc0xpc3QuY29udGFpbnMoXCJjbGFtcGVkXCIpO1xuICBjb25zdCBuZXh0ID0gY2xhbXBlZCAmJiBvcGVuO1xuICBlbnRyeS5jYXJkLmNsYXNzTGlzdC50b2dnbGUoXCJvcGVuXCIsIG5leHQpO1xuICBlbnRyeS5oZWFkLnNldEF0dHJpYnV0ZShcImFyaWEtZXhwYW5kZWRcIiwgU3RyaW5nKCFjbGFtcGVkIHx8IG5leHQpKTtcbiAgZW50cnkubW9yZUJ0bi50ZXh0Q29udGVudCA9IG5leHQgPyBcIlNob3cgbGVzc1wiIDogXCJTaG93IG1vcmVcIjtcbiAgc3luY0V4cGFuZEFsbEJ1dHRvbigpO1xufVxuXG5mdW5jdGlvbiB1cGRhdGVSZXN1bHRDbGFtcGluZyhlbnRyeTogUmVzdWx0RW50cnkpIHtcbiAgaWYgKGVudHJ5LmJvZHkub2Zmc2V0UGFyZW50ID09PSBudWxsKSByZXR1cm47XG4gIC8vIFVuY2xhbXBlZCBjYXJkcyBoYXZlIG5vIG1heC1oZWlnaHQsIHNvIHNjcm9sbEhlaWdodCBpcyBhbHdheXMgdGhlIGZ1bGwgbmF0dXJhbCBoZWlnaHQuXG4gIGNvbnN0IG92ZXJmbG93cyA9IGVudHJ5LmJvZHkuc2Nyb2xsSGVpZ2h0ID4gcmVzdWx0Q2xhbXBQeChlbnRyeS5jYXJkKSArIDQ7XG4gIGVudHJ5LmNhcmQuY2xhc3NMaXN0LnRvZ2dsZShcImNsYW1wZWRcIiwgb3ZlcmZsb3dzKTtcbiAgaWYgKCFvdmVyZmxvd3MpIGVudHJ5LmNhcmQuY2xhc3NMaXN0LnJlbW92ZShcIm9wZW5cIik7XG4gIGVudHJ5Lm1vcmVCdG4uaGlkZGVuID0gIW92ZXJmbG93cztcbiAgY29uc3QgaXNPcGVuID0gZW50cnkuY2FyZC5jbGFzc0xpc3QuY29udGFpbnMoXCJvcGVuXCIpO1xuICBlbnRyeS5tb3JlQnRuLnRleHRDb250ZW50ID0gaXNPcGVuID8gXCJTaG93IGxlc3NcIiA6IFwiU2hvdyBtb3JlXCI7XG4gIGVudHJ5LmhlYWQuc2V0QXR0cmlidXRlKFwiYXJpYS1leHBhbmRlZFwiLCBTdHJpbmcoIW92ZXJmbG93cyB8fCBpc09wZW4pKTtcbn1cblxuZnVuY3Rpb24gdXBkYXRlQWxsUmVzdWx0Q2xhbXBpbmcoKSB7XG4gIGZvciAoY29uc3QgZW50cnkgb2YgcmVzdWx0cy52YWx1ZXMoKSkgdXBkYXRlUmVzdWx0Q2xhbXBpbmcoZW50cnkpO1xuICBzeW5jRXhwYW5kQWxsQnV0dG9uKCk7XG59XG5cbmZ1bmN0aW9uIHN5bmNSZXN1bHRGb2xsb3dVcEJ1dHRvbnMoKSB7XG4gIGZvciAoY29uc3QgZW50cnkgb2YgcmVzdWx0cy52YWx1ZXMoKSkge1xuICAgIGlmICghZW50cnkuZm9sbG93QnRuKSBjb250aW51ZTtcbiAgICBjb25zdCBjYW5Gb2xsb3cgPSBjYW5Gb2xsb3dVcFJlc3VsdChlbnRyeS5zZXNzaW9uSWQsIGFjdGl2ZVNlc3Npb24sIEJvb2xlYW4oZW50cnkudGFza0lkICYmIHRhc2tzLmhhcyhlbnRyeS50YXNrSWQpKSk7XG4gICAgZW50cnkuZm9sbG93QnRuLmhpZGRlbiA9ICFjYW5Gb2xsb3c7XG4gICAgaWYgKCFjYW5Gb2xsb3cpIGVudHJ5LmNhcmQucXVlcnlTZWxlY3RvcihcImZvcm1cIik/LnJlbW92ZSgpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGNsZWFyVW5yZWFkSWZSZXN1bHRzVmlzaWJsZSgpIHtcbiAgaWYgKHVucmVhZE1vYmlsZVJlc3VsdHMgPT09IDApIHJldHVybjtcbiAgY29uc3QgZHJhd2VyT3BlbiA9IGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LmNvbnRhaW5zKFwidGFza3Mtb3BlblwiKTtcbiAgaWYgKHNob3VsZENsZWFyVW5yZWFkUmVzdWx0cyhtb2JpbGVMYXlvdXQubWF0Y2hlcywgZHJhd2VyT3Blbiwgc2lkZUZpbHRlcikpIHtcbiAgICB1bnJlYWRNb2JpbGVSZXN1bHRzID0gMDtcbiAgICB1cGRhdGVUYXNrQ2hyb21lKCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gZm9jdXNSZXN1bHQoaWQ6IHN0cmluZykge1xuICBjb25zdCBlbnRyeSA9IHJlc3VsdHMuZ2V0KGlkKTtcbiAgaWYgKCFlbnRyeSkgcmV0dXJuO1xuICBpZiAoc2lkZUZpbHRlciA9PT0gXCJhY3RpdmVcIikgc2V0U2lkZUZpbHRlcihcImFsbFwiKTtcbiAgaWYgKG1vYmlsZUxheW91dC5tYXRjaGVzKSBzZXRUYXNrc09wZW4odHJ1ZSk7XG4gIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB7XG4gICAgdXBkYXRlUmVzdWx0Q2xhbXBpbmcoZW50cnkpO1xuICAgIGlmIChlbnRyeS5jYXJkLmNsYXNzTGlzdC5jb250YWlucyhcImNsYW1wZWRcIikpIHNldFJlc3VsdE9wZW4oZW50cnksIHRydWUpO1xuICAgIGZvciAoY29uc3QgciBvZiByZXN1bHRzLnZhbHVlcygpKSByLmNhcmQuY2xhc3NMaXN0LnJlbW92ZShcImZsYXNoXCIpO1xuICAgIHZvaWQgZW50cnkuY2FyZC5vZmZzZXRXaWR0aDtcbiAgICBlbnRyeS5jYXJkLmNsYXNzTGlzdC5hZGQoXCJmbGFzaFwiKTtcbiAgICBjbGVhclRpbWVvdXQoZmxhc2hUaW1lcik7XG4gICAgZmxhc2hUaW1lciA9IHdpbmRvdy5zZXRUaW1lb3V0KCgpID0+IGVudHJ5LmNhcmQuY2xhc3NMaXN0LnJlbW92ZShcImZsYXNoXCIpLCAxNDAwKTtcbiAgICBlbnRyeS5jYXJkLnNjcm9sbEludG9WaWV3KHsgYmVoYXZpb3I6IFwic21vb3RoXCIsIGJsb2NrOiBcIm5lYXJlc3RcIiB9KTtcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHJlc3VsdChhZ2VudDogc3RyaW5nLCBsYWJlbDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcsIGZhaWxlZCA9IGZhbHNlLCB0YXNrSWQ/OiBzdHJpbmcsIHNlc3Npb25JZCA9IGFjdGl2ZVNlc3Npb24pOiBzdHJpbmcge1xuICAkKFwiZW1wdHlcIikuaGlkZGVuID0gdHJ1ZTtcbiAgY29uc3QgaWQgPSBgcmVzLSR7KytuZXh0UmVzdWx0U2VxfWA7XG4gIGNvbnN0IHdobyA9IGFnZW50ID09PSBcInQzXCIgPyBcIlQzXCIgOiBcIkhlcm1lc1wiO1xuICBjb25zdCBhZ2VudENscyA9IGFnZW50ID09PSBcInQzXCIgPyBcInQzXCIgOiBcIlwiO1xuICBjb25zdCBzbmlwcGV0ID0gcGxhaW5QcmV2aWV3KHRleHQsIDE2MCkgfHwgXCIoZW1wdHkgcmVzcG9uc2UpXCI7XG5cbiAgLy8gMS4gQ29tcGFjdCBpbmxpbmUgaGFuZG9mZiBtYXJrZXIgaW4gdGhlIHZvaWNlIHRyYW5zY3JpcHQgc28gY2hyb25vbG9naWNhbCBjb250ZXh0IHN0YXlzIGludGFjdFxuICAvLyB3aXRob3V0IG11bHRpLXBhcmFncmFwaCByZXNwb25zZXMgcHVzaGluZyB2b2ljZSB0dXJucyBvZmYgc2NyZWVuLlxuICBjb25zdCByZWZSb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICByZWZSb3cudHlwZSA9IFwiYnV0dG9uXCI7XG4gIHJlZlJvdy5jbGFzc05hbWUgPSBgbGluZSBoYW5kb2ZmICR7YWdlbnRDbHN9ICR7ZmFpbGVkID8gXCJmYWlsZWRcIiA6IFwiXCJ9YC50cmltKCk7XG4gIHJlZlJvdy5kYXRhc2V0LnJlc3VsdElkID0gaWQ7XG4gIHJlZlJvdy5pbm5lckhUTUwgPVxuICAgIGA8c3BhbiBjbGFzcz1cImJhZGdlICR7YWdlbnRDbHN9XCI+JHt3aG99PC9zcGFuPmAgK1xuICAgIGA8c3BhbiBjbGFzcz1cImhhbmRvZmYtbGFiZWxcIj4ke2VzY2FwZUh0bWwobGFiZWwpfTwvc3Bhbj5gICtcbiAgICBgPHNwYW4gY2xhc3M9XCJoYW5kb2ZmLXNuaXBwZXRcIj4ke2VzY2FwZUh0bWwoc25pcHBldCl9PC9zcGFuPmAgK1xuICAgIGA8c3BhbiBjbGFzcz1cImhhbmRvZmYtY3VlXCI+JHtmYWlsZWQgPyBcIkZhaWxlZFwiIDogXCJPcGVuIFx1MjE5N1wifTwvc3Bhbj5gO1xuICByZWZSb3cub25jbGljayA9ICgpID0+IGZvY3VzUmVzdWx0KGlkKTtcbiAgJChcInRyYW5zY3JpcHRcIikuYXBwZW5kKHJlZlJvdyk7XG4gIG9wZW5MaW5lID0gbnVsbDtcbiAgc2Nyb2xsRG93bigpO1xuXG4gIC8vIDIuIFRydW5jYXRlZCwgZXhwYW5kYWJsZSByZXN1bHQgY2FyZCBpbiB0aGUgcmlnaHQtaGFuZCBBZ2VudCBXb3Jrc3BhY2UgKG5ld2VzdCBmaXJzdCkuXG4gIGNvbnN0IGNhcmQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYXJ0aWNsZVwiKTtcbiAgY2FyZC5jbGFzc05hbWUgPSBgcmVzLWNhcmQgJHthZ2VudENsc30gJHtmYWlsZWQgPyBcImZhaWxlZFwiIDogXCJcIn1gLnRyaW0oKTtcbiAgY2FyZC5kYXRhc2V0LnJlc3VsdElkID0gaWQ7XG5cbiAgY29uc3QgaGVhZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIGhlYWQudHlwZSA9IFwiYnV0dG9uXCI7XG4gIGhlYWQuY2xhc3NOYW1lID0gXCJyZXMtaGVhZFwiO1xuICBoZWFkLnNldEF0dHJpYnV0ZShcImFyaWEtZXhwYW5kZWRcIiwgXCJ0cnVlXCIpO1xuICBoZWFkLmlubmVySFRNTCA9XG4gICAgYDxzcGFuIGNsYXNzPVwiYmFkZ2UgJHthZ2VudENsc31cIj4ke3dob308L3NwYW4+YCArXG4gICAgYDxzcGFuIGNsYXNzPVwicmVzLWxhYmVsXCIgdGl0bGU9XCIke2VzY2FwZUh0bWwobGFiZWwpfVwiPiR7ZXNjYXBlSHRtbChsYWJlbCl9PC9zcGFuPmAgK1xuICAgIChmYWlsZWQgPyBgPHNwYW4gY2xhc3M9XCJyZXMtcGlsbFwiPkZhaWxlZDwvc3Bhbj5gIDogXCJcIikgK1xuICAgIGA8c3BhbiBjbGFzcz1cInJlcy10aW1lXCI+JHtmb3JtYXRTaG9ydFRpbWUobmV3IERhdGUoKSl9PC9zcGFuPmAgK1xuICAgIGA8c3BhbiBjbGFzcz1cInJlcy1jaGV2XCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+PC9zcGFuPmA7XG5cbiAgY29uc3QgYm9keSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGJvZHkuY2xhc3NOYW1lID0gXCJyZXMtYm9keVwiO1xuICBib2R5LmlubmVySFRNTCA9IG1hcmtkb3duKHRleHQpO1xuXG4gIGNvbnN0IGZvb3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBmb290LmNsYXNzTmFtZSA9IFwicmVzLWZvb3RcIjtcblxuICBjb25zdCBtb3JlQnRuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgbW9yZUJ0bi50eXBlID0gXCJidXR0b25cIjtcbiAgbW9yZUJ0bi5jbGFzc05hbWUgPSBcInJlcy1hY3QgcHJpbWFyeVwiO1xuICBtb3JlQnRuLnRleHRDb250ZW50ID0gXCJTaG93IG1vcmVcIjtcbiAgbW9yZUJ0bi5oaWRkZW4gPSB0cnVlO1xuXG4gIGNvbnN0IGNvcHlCdG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBjb3B5QnRuLnR5cGUgPSBcImJ1dHRvblwiO1xuICBjb3B5QnRuLmNsYXNzTmFtZSA9IFwicmVzLWFjdFwiO1xuICBjb3B5QnRuLnRleHRDb250ZW50ID0gXCJDb3B5XCI7XG4gIGNvcHlCdG4ub25jbGljayA9ICgpID0+IHtcbiAgICB2b2lkIG5hdmlnYXRvci5jbGlwYm9hcmQ/LndyaXRlVGV4dCh0ZXh0KTtcbiAgICB0b2FzdChcIlJlc3VsdCBjb3BpZWRcIik7XG4gIH07XG5cbiAgZm9vdC5hcHBlbmQobW9yZUJ0biwgY29weUJ0bik7XG5cbiAgbGV0IGZvbGxvd0J0bjogSFRNTEJ1dHRvbkVsZW1lbnQgfCB1bmRlZmluZWQ7XG4gIGlmICh0YXNrSWQpIHtcbiAgICBmb2xsb3dCdG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICAgIGZvbGxvd0J0bi50eXBlID0gXCJidXR0b25cIjtcbiAgICBmb2xsb3dCdG4uY2xhc3NOYW1lID0gXCJyZXMtYWN0XCI7XG4gICAgZm9sbG93QnRuLnRleHRDb250ZW50ID0gXCJGb2xsb3cgdXBcIjtcbiAgICBmb2xsb3dCdG4ub25jbGljayA9ICgpID0+IHtcbiAgICAgIGlmICghY2FuRm9sbG93VXBSZXN1bHQoc2Vzc2lvbklkLCBhY3RpdmVTZXNzaW9uLCB0YXNrcy5oYXModGFza0lkKSkpIHtcbiAgICAgICAgc3luY1Jlc3VsdEZvbGxvd1VwQnV0dG9ucygpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjb25zdCB2aWV3ID0gdGFza3MuZ2V0KHRhc2tJZCk7XG4gICAgICBpZiAodmlldykgZm9sbG93VXBGb3JtKGNhcmQsIHZpZXcuYywgc2Vzc2lvbklkKTtcbiAgICB9O1xuICAgIGZvb3QuYXBwZW5kKGZvbGxvd0J0bik7XG4gIH1cblxuICBjYXJkLmFwcGVuZChoZWFkLCBib2R5LCBmb290KTtcblxuICBjb25zdCBlbnRyeTogUmVzdWx0RW50cnkgPSB7IGlkLCBhZ2VudCwgbGFiZWwsIHRleHQsIGZhaWxlZCwgdGFza0lkLCBzZXNzaW9uSWQsIGNhcmQsIGhlYWQsIGJvZHksIG1vcmVCdG4sIGZvbGxvd0J0biwgcmVmUm93IH07XG4gIGNvbnN0IHRvZ2dsZSA9ICgpID0+IHtcbiAgICBpZiAoIWVudHJ5LmNhcmQuY2xhc3NMaXN0LmNvbnRhaW5zKFwiY2xhbXBlZFwiKSkgcmV0dXJuO1xuICAgIHNldFJlc3VsdE9wZW4oZW50cnksICFlbnRyeS5jYXJkLmNsYXNzTGlzdC5jb250YWlucyhcIm9wZW5cIikpO1xuICB9O1xuICBoZWFkLm9uY2xpY2sgPSB0b2dnbGU7XG4gIG1vcmVCdG4ub25jbGljayA9IHRvZ2dsZTtcblxuICByZXN1bHRzLnNldChpZCwgZW50cnkpO1xuICAkKFwicmVzdWx0c1wiKS5wcmVwZW5kKGNhcmQpO1xuICBjb25zdCBkcmF3ZXJPcGVuID0gZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QuY29udGFpbnMoXCJ0YXNrcy1vcGVuXCIpO1xuICBpZiAoIXNob3VsZENsZWFyVW5yZWFkUmVzdWx0cyhtb2JpbGVMYXlvdXQubWF0Y2hlcywgZHJhd2VyT3Blbiwgc2lkZUZpbHRlcikpIHVucmVhZE1vYmlsZVJlc3VsdHMrKztcblxuICBzeW5jU2lkZUxheW91dCgpO1xuICB1cGRhdGVUYXNrQ2hyb21lKCk7XG4gIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB7XG4gICAgdXBkYXRlUmVzdWx0Q2xhbXBpbmcoZW50cnkpO1xuICAgIHN5bmNFeHBhbmRBbGxCdXR0b24oKTtcbiAgfSk7XG4gIHJldHVybiBpZDtcbn1cblxuZnVuY3Rpb24gZWxhcHNlZChzZWNvbmRzOiBudW1iZXIpOiBzdHJpbmcge1xuICBpZiAoc2Vjb25kcyA8IDYwKSByZXR1cm4gYCR7TWF0aC5mbG9vcihzZWNvbmRzKX1zYDtcbiAgY29uc3QgbSA9IE1hdGguZmxvb3Ioc2Vjb25kcyAvIDYwKTtcbiAgcmV0dXJuIG0gPCA2MCA/IGAke219bSAke01hdGguZmxvb3Ioc2Vjb25kcyAlIDYwKX1zYCA6IGAke01hdGguZmxvb3IobSAvIDYwKX1oICR7bSAlIDYwfW1gO1xufVxuXG4vKiogVGhlIGVtcHR5IHRhc2sgbGlzdCdzIHdvcmRzLCBrZXB0IHRvIHB1dCBiYWNrLiAqL1xuY29uc3Qgbm9UYXNrcyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwibm90YXNrc1wiKSE7XG5cbi8qKiBXaGV0aGVyIGEgdGFzayBzdGlsbCB3YW50cyB0aGUgc2NyZWVuOiBpdCdzIHdvcmtpbmcsIHdhaXRpbmcsIG9yIG5lZWRzIGFwcHJvdmFsLiBUaGUgcmVzdCBmb2xkIGF3YXkgdW5kZXIgRmluaXNoZWQuICovXG5jb25zdCBsaXZlID0gKHN0YXRlOiBzdHJpbmcpID0+IHN0YXRlID09PSBcInJ1bm5pbmdcIiB8fCBzdGF0ZS5zdGFydHNXaXRoKFwid2FpdGluZ1wiKTtcbmNvbnN0IGlzQWN0aXZlVGFzayA9ICh2aWV3OiBUYXNrVmlldykgPT4gbGl2ZSh2aWV3LmMuc3RhdGUpIHx8IEJvb2xlYW4odmlldy5hcHByb3ZhbCk7XG5cbmZ1bmN0aW9uIHNldFNpZGVGaWx0ZXIoZmlsdGVyOiBTaWRlRmlsdGVyKSB7XG4gIHNpZGVGaWx0ZXIgPSBub3JtYWxpemVTaWRlRmlsdGVyKGZpbHRlcik7XG4gIGZvciAoY29uc3QgYnRuIG9mIEFycmF5LmZyb20oZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MQnV0dG9uRWxlbWVudD4oXCIjc2lkZS10YWJzIGJ1dHRvblwiKSkpIHtcbiAgICBjb25zdCBvbiA9IGJ0bi5kYXRhc2V0LmZpbHRlciA9PT0gc2lkZUZpbHRlcjtcbiAgICBidG4uY2xhc3NMaXN0LnRvZ2dsZShcIm9uXCIsIG9uKTtcbiAgICBidG4uc2V0QXR0cmlidXRlKFwiYXJpYS1wcmVzc2VkXCIsIFN0cmluZyhvbikpO1xuICB9XG4gIHN5bmNTaWRlTGF5b3V0KCk7XG4gIGNsZWFyVW5yZWFkSWZSZXN1bHRzVmlzaWJsZSgpO1xuICByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKCkgPT4gdXBkYXRlQWxsUmVzdWx0Q2xhbXBpbmcoKSk7XG59XG5cbmZ1bmN0aW9uIHN5bmNTaWRlTGF5b3V0KCkge1xuICBjb25zdCBhbGwgPSBbLi4udGFza3MudmFsdWVzKCldO1xuICBjb25zdCBhY3RpdmVDdXJyZW50ID0gYWxsLmZpbHRlcihpc0FjdGl2ZVRhc2spLmxlbmd0aDtcbiAgY29uc3QgYWN0aXZlVG90YWwgPSBhY3RpdmVDdXJyZW50ICsgZWFybGllckFjdGl2ZUNvdW50O1xuICBjb25zdCByZXN1bHRzVG90YWwgPSByZXN1bHRzLnNpemU7XG4gIGNvbnN0IGVhcmxpZXJTaG93biA9ICQoXCJlYXJsaWVyXCIpLmNoaWxkRWxlbWVudENvdW50O1xuICBjb25zdCBkb25lVG90YWwgPSAkKFwiZG9uZW5vd1wiKS5jaGlsZEVsZW1lbnRDb3VudCArICQoXCJkb25lZWFybGllclwiKS5jaGlsZEVsZW1lbnRDb3VudDtcblxuICBjb25zdCB2aXMgPSByZXNvbHZlU2lkZVNlY3Rpb25zKHNpZGVGaWx0ZXIsIHtcbiAgICBhY3RpdmU6IGFjdGl2ZUN1cnJlbnQsXG4gICAgcmVzdWx0czogcmVzdWx0c1RvdGFsLFxuICAgIGVhcmxpZXI6IGVhcmxpZXJTaG93bixcbiAgICBkb25lOiBkb25lVG90YWwsXG4gIH0pO1xuXG4gICQoXCJ0YXNrcy1zZWN0aW9uXCIpLmhpZGRlbiA9ICF2aXMuc2hvd1Rhc2tzU2VjdGlvbjtcbiAgbm9UYXNrcy5oaWRkZW4gPSAhdmlzLnNob3dFbXB0eVRhc2tzO1xuICAkKFwicmVzdWx0cy1zZWN0aW9uXCIpLmhpZGRlbiA9ICF2aXMuc2hvd1Jlc3VsdHNTZWN0aW9uO1xuICAkKFwibm9yZXN1bHRzXCIpLmhpZGRlbiA9ICF2aXMuc2hvd0VtcHR5UmVzdWx0cztcbiAgJChcImVhcmxpZXJib3hcIikuaGlkZGVuID0gIXZpcy5zaG93RWFybGllclNlY3Rpb247XG4gICQoXCJkb25lYm94XCIpLmhpZGRlbiA9ICF2aXMuc2hvd0RvbmVTZWN0aW9uO1xuXG4gICQoXCJzaWRlLWFjdGl2ZS1uXCIpLnRleHRDb250ZW50ID0gYWN0aXZlVG90YWwgPiAwID8gU3RyaW5nKGFjdGl2ZVRvdGFsKSA6IFwiXCI7XG4gICQoXCJzaWRlLXJlc3VsdHMtblwiKS50ZXh0Q29udGVudCA9IHJlc3VsdHNUb3RhbCA+IDAgPyBTdHJpbmcocmVzdWx0c1RvdGFsKSA6IFwiXCI7XG4gICQoXCJyZXN1bHRzY291bnRcIikudGV4dENvbnRlbnQgPSByZXN1bHRzVG90YWwgPiAwID8gYFx1MDBCNyAke3Jlc3VsdHNUb3RhbH1gIDogXCJcIjtcbiAgJChcImRvbmVjb3VudFwiKS50ZXh0Q29udGVudCA9IGRvbmVUb3RhbCA+IDAgPyBgXHUwMEI3ICR7ZG9uZVRvdGFsfWAgOiBcIlwiO1xuICBzeW5jUmVzdWx0Rm9sbG93VXBCdXR0b25zKCk7XG59XG5cbmZ1bmN0aW9uIHVwZGF0ZVRhc2tDaHJvbWUoKSB7XG4gIGNvbnN0IGFsbCA9IFsuLi50YXNrcy52YWx1ZXMoKV07XG4gIGNvbnN0IGFjdGl2ZUN1cnJlbnQgPSBhbGwuZmlsdGVyKGlzQWN0aXZlVGFzaykubGVuZ3RoO1xuICBjb25zdCB3YWl0aW5nID0gYWxsLmZpbHRlcigodCkgPT4gdC5jLnN0YXRlLnN0YXJ0c1dpdGgoXCJ3YWl0aW5nXCIpIHx8IEJvb2xlYW4odC5hcHByb3ZhbCkpLmxlbmd0aDtcbiAgY29uc3QgYWN0aXZlVG90YWwgPSBhY3RpdmVDdXJyZW50ICsgZWFybGllckFjdGl2ZUNvdW50O1xuICBjb25zdCBhdHRlbnRpb25Ub3RhbCA9IHdhaXRpbmcgKyBlYXJsaWVyV2FpdGluZ0NvdW50O1xuICBjb25zdCBiYWRnZUNvdW50ID0gYWN0aXZlVG90YWwgPiAwID8gYWN0aXZlVG90YWwgOiB1bnJlYWRNb2JpbGVSZXN1bHRzO1xuXG4gIGNvbnN0IGJhZGdlID0gJChcInRhc2tzLWJhZGdlXCIpO1xuICBiYWRnZS5oaWRkZW4gPSBiYWRnZUNvdW50ID09PSAwO1xuICBiYWRnZS50ZXh0Q29udGVudCA9IFN0cmluZyhiYWRnZUNvdW50KTtcbiAgYmFkZ2UuY2xhc3NMaXN0LnRvZ2dsZShcIndhcm5cIiwgYXR0ZW50aW9uVG90YWwgPiAwKTtcblxuICBjb25zdCBiYXIgPSAkKFwibW9iaWxlLXRhc2tzLWJhclwiKTtcbiAgY29uc3Qgc2hvd0JhciA9IGFjdGl2ZVRvdGFsID4gMCB8fCB1bnJlYWRNb2JpbGVSZXN1bHRzID4gMDtcbiAgYmFyLmhpZGRlbiA9ICFzaG93QmFyO1xuICBiYXIuY2xhc3NMaXN0LnRvZ2dsZShcInZpc2libGVcIiwgc2hvd0Jhcik7XG4gIGJhci5jbGFzc0xpc3QudG9nZ2xlKFwid2FyblwiLCBhdHRlbnRpb25Ub3RhbCA+IDApO1xuICBpZiAoc2hvd0Jhcikge1xuICAgIGNvbnN0IGFwcHJvdmFsID0gYWxsLmZpbmQoKHQpID0+IHQuYXBwcm92YWwpO1xuICAgIGNvbnN0IGxhYmVsID0gYXBwcm92YWxcbiAgICAgID8gYEFwcHJvdmFsIG5lZWRlZDogJHthcHByb3ZhbC5jLmxhYmVsfWBcbiAgICAgIDogYXR0ZW50aW9uVG90YWwgPiAwXG4gICAgICAgID8gYCR7YXR0ZW50aW9uVG90YWx9IHRhc2ske2F0dGVudGlvblRvdGFsID4gMSA/IFwic1wiIDogXCJcIn0gd2FpdGluZyBmb3IgeW91YFxuICAgICAgICA6IGFjdGl2ZVRvdGFsID4gMFxuICAgICAgICAgID8gYCR7YWN0aXZlVG90YWx9IGFjdGl2ZSB0YXNrJHthY3RpdmVUb3RhbCA+IDEgPyBcInNcIiA6IFwiXCJ9YFxuICAgICAgICAgIDogYCR7dW5yZWFkTW9iaWxlUmVzdWx0c30gbmV3IGFnZW50IHJlc3VsdCR7dW5yZWFkTW9iaWxlUmVzdWx0cyA+IDEgPyBcInNcIiA6IFwiXCJ9YDtcbiAgICAkKFwibXRiLXRleHRcIikudGV4dENvbnRlbnQgPSBsYWJlbDtcbiAgfVxufVxuXG5mdW5jdGlvbiBzaG93VGFza3MoZm9yY2UgPSBmYWxzZSkge1xuICBjb25zdCBwYW5lID0gJChcInRhc2tzXCIpO1xuICBjb25zdCBkb25lID0gJChcImRvbmVub3dcIik7XG4gIGNvbnN0IG9wZW4gPSBkb2N1bWVudC5hY3RpdmVFbGVtZW50Py5jbG9zZXN0Py4oXCIudGFza1wiKSBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gIGlmICghZm9yY2UgJiYgb3BlbiAmJiAocGFuZS5jb250YWlucyhvcGVuKSB8fCBkb25lLmNvbnRhaW5zKG9wZW4pKSAmJiBvcGVuLnF1ZXJ5U2VsZWN0b3IoXCJmb3JtXCIpKSByZXR1cm47IC8vIGRvbid0IHJlZHJhdyB1bmRlciBzb21lb25lIHR5cGluZyBhIGZvbGxvdy11cFxuICBwYW5lLmlubmVySFRNTCA9IFwiXCI7XG4gIGRvbmUuaW5uZXJIVE1MID0gXCJcIjtcbiAgY29uc3QgYWxsID0gWy4uLnRhc2tzLnZhbHVlcygpXS5yZXZlcnNlKCk7XG4gIGlmIChhbGwubGVuZ3RoID09PSAwKSB7XG4gICAgcGFuZS5hcHBlbmQobm9UYXNrcyk7XG4gICAgJChcInRhc2tjb3VudFwiKS50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgJChcImNhbmNlbGFsbFwiKS5oaWRkZW4gPSB0cnVlO1xuICAgIHN5bmNTaWRlTGF5b3V0KCk7XG4gICAgdXBkYXRlVGFza0Nocm9tZSgpO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBydW5uaW5nID0gYWxsLmZpbHRlcigodCkgPT4gdC5jLnN0YXRlID09PSBcInJ1bm5pbmdcIikubGVuZ3RoO1xuICBjb25zdCBhY3RpdmVDb3VudCA9IGFsbC5maWx0ZXIoaXNBY3RpdmVUYXNrKS5sZW5ndGg7XG4gICQoXCJ0YXNrY291bnRcIikudGV4dENvbnRlbnQgPSBydW5uaW5nID4gMCA/IGAke3J1bm5pbmd9IHJ1bm5pbmdgIDogYWN0aXZlQ291bnQgPiAwID8gYCR7YWN0aXZlQ291bnR9IHdhaXRpbmdgIDogXCJcIjtcbiAgJChcImNhbmNlbGFsbFwiKS5oaWRkZW4gPSAhY2FsbElkIHx8IHJ1bm5pbmcgPCAyO1xuICBmb3IgKGNvbnN0IHZpZXcgb2YgYWxsKSB7XG4gICAgY29uc3QgdCA9IHZpZXcuYztcbiAgICBjb25zdCB3YWl0aW5nID0gdC5zdGF0ZS5zdGFydHNXaXRoKFwid2FpdGluZ1wiKTtcbiAgICBjb25zdCBjYXJkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBjYXJkLmNsYXNzTmFtZSA9IGB0YXNrICR7d2FpdGluZyA/IFwid2FpdGluZ1wiIDogdC5zdGF0ZX1gO1xuICAgIGNvbnN0IGFnZSA9ICh2aWV3LmVuZGVkID8/IG5vdygpKSAtIHZpZXcuc2luY2U7XG4gICAgY2FyZC5pbm5lckhUTUwgPVxuICAgICAgYDxkaXYgY2xhc3M9XCJtZXRhLXJvd1wiPmAgK1xuICAgICAgICBgPHNwYW4gY2xhc3M9XCJiYWRnZSAke3QuYWdlbnQgPT09IFwidDNcIiA/IFwidDNcIiA6IFwiXCJ9XCI+JHt0LmFnZW50ID09PSBcInQzXCIgPyBcIlQzXCIgOiBcIkhlcm1lc1wifTwvc3Bhbj5gICtcbiAgICAgICAgYDxzcGFuIGNsYXNzPVwibGFiZWxcIj48L3NwYW4+YCArXG4gICAgICAgIGA8c3BhbiBjbGFzcz1cInN0YXRlXCI+JHt0LnN0YXRlID09PSBcInJ1bm5pbmdcIiA/ICc8c3BhbiBjbGFzcz1cInNwaW5cIj48L3NwYW4+JyA6IFwiXCJ9JHtlc2NhcGVIdG1sKHQuc3RhdGUpfTwvc3Bhbj5gICtcbiAgICAgICAgYDxzcGFuIGNsYXNzPVwiYWdlXCI+JHtlbGFwc2VkKGFnZSl9PC9zcGFuPmAgK1xuICAgICAgYDwvZGl2PmAgK1xuICAgICAgYDxkaXYgY2xhc3M9XCJwXCI+PC9kaXY+YDtcbiAgICBjb25zdCBsYWJlbEVsID0gY2FyZC5xdWVyeVNlbGVjdG9yKFwiLmxhYmVsXCIpIGFzIEhUTUxFbGVtZW50O1xuICAgIGxhYmVsRWwudGV4dENvbnRlbnQgPSB0LmxhYmVsO1xuICAgIGxhYmVsRWwudGl0bGUgPSB0LmxhYmVsO1xuICAgIGNhcmQucXVlcnlTZWxlY3RvcihcIi5wXCIpIS50ZXh0Q29udGVudCA9IHQucHJvZ3Jlc3MgPz8gdC5yZXF1ZXN0O1xuICAgIGlmICh0LnF1ZXN0aW9uKSB7XG4gICAgICBjb25zdCBxID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgIHEuY2xhc3NOYW1lID0gXCJxXCI7XG4gICAgICBxLnRleHRDb250ZW50ID0gYEFza3M6ICR7dC5xdWVzdGlvbn1gO1xuICAgICAgY2FyZC5hcHBlbmQocSk7XG4gICAgfVxuICAgIGlmICh2aWV3LmFwcHJvdmFsICYmIHQuc3RhdGUgPT09IFwicnVubmluZ1wiKSB7XG4gICAgICBjb25zdCBib3ggPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgICAgYm94LmNsYXNzTmFtZSA9IFwiYXBwcm92YWxcIjtcbiAgICAgIGJveC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz1cImFwcHJvdmFsLWhlYWRcIj5IZXJtZXMgYXNrcyB0byBydW48L2Rpdj48Y29kZT48L2NvZGU+PGRpdiBjbGFzcz1cImFjdHNcIj48L2Rpdj5gO1xuICAgICAgYm94LnF1ZXJ5U2VsZWN0b3IoXCJjb2RlXCIpIS50ZXh0Q29udGVudCA9IHZpZXcuYXBwcm92YWwuY29tbWFuZDtcbiAgICAgIGNvbnN0IGFuc3dlciA9IChjaG9pY2U6IFwib25jZVwiIHwgXCJkZW55XCIpID0+IHtcbiAgICAgICAgdmlldy5hcHByb3ZhbCA9IHVuZGVmaW5lZDtcbiAgICAgICAgc2hvd1Rhc2tzKHRydWUpO1xuICAgICAgICB2b2lkIGZldGNoKFwiL2hlcm1lcy9hcHByb3ZhbFwiLCB7IG1ldGhvZDogXCJQT1NUXCIsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgY2FsbDogY2FsbE5hbWUsIHRhc2tJZDogdC5pZCwgY2hvaWNlIH0pIH0pXG4gICAgICAgICAgLnRoZW4oKHIpID0+IHRvYXN0KHIub2sgPyAoY2hvaWNlID09PSBcIm9uY2VcIiA/IFwiQXBwcm92ZWRcIiA6IFwiRGVuaWVkXCIpIDogXCJUaGF0IGFwcHJvdmFsIGhhZCBhbHJlYWR5IGxhcHNlZFwiKSk7XG4gICAgICB9O1xuICAgICAgZm9yIChjb25zdCBbbGFiZWwsIGNob2ljZV0gb2YgW1tcIkFwcHJvdmUgb25jZVwiLCBcIm9uY2VcIl0sIFtcIkRlbnlcIiwgXCJkZW55XCJdXSBhcyBjb25zdCkge1xuICAgICAgICBjb25zdCBiID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgICAgICAgYi50eXBlID0gXCJidXR0b25cIjtcbiAgICAgICAgYi50ZXh0Q29udGVudCA9IGxhYmVsO1xuICAgICAgICBpZiAoY2hvaWNlID09PSBcIm9uY2VcIikgYi5jbGFzc05hbWUgPSBcImdvXCI7XG4gICAgICAgIGVsc2UgYi5jbGFzc05hbWUgPSBcImRhbmdlclwiO1xuICAgICAgICBiLm9uY2xpY2sgPSAoKSA9PiBhbnN3ZXIoY2hvaWNlKTtcbiAgICAgICAgYm94LnF1ZXJ5U2VsZWN0b3IoXCIuYWN0c1wiKSEuYXBwZW5kKGIpO1xuICAgICAgfVxuICAgICAgY2FyZC5hcHBlbmQoYm94KTtcbiAgICB9XG4gICAgaWYgKHQuc3RhdGUgIT09IFwicnVubmluZ1wiKSB2aWV3LmFwcHJvdmFsID0gdW5kZWZpbmVkO1xuICAgIGNvbnN0IGFjdHMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGFjdHMuY2xhc3NOYW1lID0gXCJhY3RzXCI7XG4gICAgY29uc3QgYnV0dG9uID0gKHRleHQ6IHN0cmluZywgZm46ICgpID0+IHZvaWQsIGNscyA9IFwiXCIpID0+IHtcbiAgICAgIGNvbnN0IGIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICAgICAgYi50eXBlID0gXCJidXR0b25cIjtcbiAgICAgIGIudGV4dENvbnRlbnQgPSB0ZXh0O1xuICAgICAgaWYgKGNscykgYi5jbGFzc05hbWUgPSBjbHM7XG4gICAgICBiLm9uY2xpY2sgPSBmbjtcbiAgICAgIGFjdHMuYXBwZW5kKGIpO1xuICAgICAgcmV0dXJuIGI7XG4gICAgfTtcbiAgICBpZiAoY2FsbElkICYmIGFjdGl2ZVNlc3Npb24gPiAwKSB7XG4gICAgICBjb25zdCBvcmlnaW5TZXNzaW9uID0gYWN0aXZlU2Vzc2lvbjtcbiAgICAgIGJ1dHRvbih3YWl0aW5nID8gXCJBbnN3ZXJcIiA6IFwiRm9sbG93IHVwXCIsICgpID0+IGZvbGxvd1VwRm9ybShjYXJkLCB0LCBvcmlnaW5TZXNzaW9uKSk7XG4gICAgICBpZiAodC5zdGF0ZSA9PT0gXCJydW5uaW5nXCIpIGJ1dHRvbihcIkNhbmNlbFwiLCAoKSA9PiBwdXNoKHsgdHlwZTogXCJjYW5jZWxUYXNrXCIsIHRhc2s6IHQuaWQgfSksIFwiZGFuZ2VyXCIpO1xuICAgIH1cbiAgICBpZiAodmlldy5yZXN1bHRJZCkgYnV0dG9uKFwiUmVzdWx0XCIsICgpID0+IGZvY3VzUmVzdWx0KHZpZXcucmVzdWx0SWQhKSk7XG4gICAgaWYgKHZpZXcudGhyZWFkKSBidXR0b24oXCJDb3B5IGlkXCIsICgpID0+IHsgdm9pZCBuYXZpZ2F0b3IuY2xpcGJvYXJkPy53cml0ZVRleHQodmlldy50aHJlYWQhKTsgdG9hc3QoXCJUaHJlYWQgaWQgY29waWVkXCIpOyB9KTtcbiAgICBpZiAoYWN0cy5jaGlsZEVsZW1lbnRDb3VudCkgY2FyZC5hcHBlbmQoYWN0cyk7XG4gICAgKGlzQWN0aXZlVGFzayh2aWV3KSA/IHBhbmUgOiBkb25lKS5hcHBlbmQoY2FyZCk7XG4gIH1cbiAgaWYgKHBhbmUuY2hpbGRFbGVtZW50Q291bnQgPT09IDApIHBhbmUuYXBwZW5kKG5vVGFza3MpO1xuICBzeW5jU2lkZUxheW91dCgpO1xuICB1cGRhdGVUYXNrQ2hyb21lKCk7XG59XG5cbmZ1bmN0aW9uIGZvbGxvd1VwRm9ybShjYXJkOiBIVE1MRWxlbWVudCwgdDogQ29tbWFuZCwgb3JpZ2luU2Vzc2lvbjogbnVtYmVyKSB7XG4gIGNvbnN0IGV4aXN0aW5nID0gY2FyZC5xdWVyeVNlbGVjdG9yKFwiZm9ybVwiKTtcbiAgaWYgKGV4aXN0aW5nKSB7IGV4aXN0aW5nLnF1ZXJ5U2VsZWN0b3IoXCJpbnB1dFwiKT8uZm9jdXMoKTsgcmV0dXJuOyB9XG4gIGNvbnN0IGZvcm0gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZm9ybVwiKTtcbiAgZm9ybS5jbGFzc05hbWUgPSBcImZvbGxvd3VwLWZvcm1cIjtcbiAgZm9ybS5pbm5lckhUTUwgPSBgPGlucHV0IHR5cGU9XCJ0ZXh0XCIgcGxhY2Vob2xkZXI9XCJUZWxsIFx1MjAxQyR7ZXNjYXBlSHRtbCh0LmxhYmVsKX1cdTIwMURcdTIwMjZcIiBlbnRlcmtleWhpbnQ9XCJzZW5kXCI+PGJ1dHRvbiB0eXBlPVwic3VibWl0XCI+U2VuZDwvYnV0dG9uPmA7XG4gIGNvbnN0IGlucHV0ID0gZm9ybS5xdWVyeVNlbGVjdG9yKFwiaW5wdXRcIikhO1xuICBmb3JtLm9uc3VibWl0ID0gKGUpID0+IHtcbiAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgY29uc3QgdGV4dCA9IGlucHV0LnZhbHVlLnRyaW0oKTtcbiAgICBpZiAodGV4dCkge1xuICAgICAgaWYgKCFjYW5Gb2xsb3dVcFJlc3VsdChvcmlnaW5TZXNzaW9uLCBhY3RpdmVTZXNzaW9uLCB0YXNrcy5oYXModC5pZCkpKSB7XG4gICAgICAgIHRvYXN0KFwiVGhhdCB0YXNrJ3MgY2FsbCBoYXMgZW5kZWRcIik7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBwdXNoKHsgdHlwZTogXCJzdGVlclwiLCB0YXNrOiB0LmlkLCB0ZXh0IH0pO1xuICAgICAgICBub3RlKGBZb3UgXHUyMTkyICR7dC5sYWJlbH06ICR7dGV4dH1gKTtcbiAgICAgICAgc2Nyb2xsRG93bih0cnVlKTtcbiAgICAgIH1cbiAgICB9XG4gICAgaW5wdXQuYmx1cigpO1xuICAgIGZvcm0ucmVtb3ZlKCk7XG4gICAgc2hvd1Rhc2tzKCk7XG4gIH07XG4gIGlucHV0Lm9ua2V5ZG93biA9IChlKSA9PiB7IGlmIChlLmtleSA9PT0gXCJFc2NhcGVcIikgeyBlLnN0b3BQcm9wYWdhdGlvbigpOyBpbnB1dC5ibHVyKCk7IGZvcm0ucmVtb3ZlKCk7IHNob3dUYXNrcygpOyB9IH07XG4gIGNhcmQuYXBwZW5kKGZvcm0pO1xuICBpbnB1dC5mb2N1cygpO1xufVxuXG4vKiogVDMgdGhyZWFkcyBlYXJsaWVyIGNhbGxzIHN0YXJ0ZWQ6IHRoZXkgY2Fycnkgb24gYWZ0ZXIgYSBjYWxsLCBzbyB0aGUgcGFuZWwgc2F5cyBob3cgdGhleSdyZSBkb2luZy4gKi9cbmFzeW5jIGZ1bmN0aW9uIHNob3dFYXJsaWVyKCkge1xuICBsZXQgbGlzdDogeyB0aHJlYWQ6IHN0cmluZzsgdGl0bGU6IHN0cmluZzsgc3RhdHVzOiBzdHJpbmc7IGJyYW5jaDogc3RyaW5nIHwgbnVsbDsgcHI6IHN0cmluZyB8IG51bGw7IHVwZGF0ZWQ6IHN0cmluZzsgbGFzdDogc3RyaW5nOyB3YWl0aW5nOiBib29sZWFuIH1bXSA9IFtdO1xuICB0cnkgeyBsaXN0ID0gYXdhaXQgKGF3YWl0IGZldGNoKFwiL2FnZW50L3JlY2VudFwiLCB7IGNhY2hlOiBcIm5vLXN0b3JlXCIgfSkpLmpzb24oKTsgfSBjYXRjaCB7fVxuICBjb25zdCBjdXJyZW50ID0gbmV3IFNldChbLi4udGFza3MudmFsdWVzKCldLm1hcCgodikgPT4gdi50aHJlYWQpLmZpbHRlcihCb29sZWFuKSk7XG4gIGxpc3QgPSBsaXN0LmZpbHRlcigodCkgPT4gIWN1cnJlbnQuaGFzKHQudGhyZWFkKSk7XG4gIGNvbnN0IHBhbmUgPSAkKFwiZWFybGllclwiKTtcbiAgY29uc3QgZG9uZSA9ICQoXCJkb25lZWFybGllclwiKTtcbiAgcGFuZS5pbm5lckhUTUwgPSBcIlwiO1xuICBkb25lLmlubmVySFRNTCA9IFwiXCI7XG4gIGVhcmxpZXJBY3RpdmVDb3VudCA9IDA7XG4gIGVhcmxpZXJXYWl0aW5nQ291bnQgPSAwO1xuICBmb3IgKGNvbnN0IHQgb2YgbGlzdCkge1xuICAgIGNvbnN0IGNhcmQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGNvbnN0IHN0YXRlID0gdC53YWl0aW5nID8gXCJ3YWl0aW5nIGZvciBhcHByb3ZhbCBpbiBUM1wiIDogdC5zdGF0dXM7XG4gICAgY2FyZC5jbGFzc05hbWUgPSBgdGFzayAke3Quc3RhdHVzID09PSBcInJ1bm5pbmdcIiA/IFwicnVubmluZ1wiIDogdC53YWl0aW5nID8gXCJ3YWl0aW5nXCIgOiBcImZpbmlzaGVkXCJ9YDtcbiAgICBjb25zdCBhZ28gPSBNYXRoLm1heCgwLCAoRGF0ZS5ub3coKSAtIERhdGUucGFyc2UodC51cGRhdGVkKSkgLyAxMDAwKTtcbiAgICBjYXJkLmlubmVySFRNTCA9XG4gICAgICBgPGRpdiBjbGFzcz1cIm1ldGEtcm93XCI+YCArXG4gICAgICAgIGA8c3BhbiBjbGFzcz1cImJhZGdlIHQzXCI+VDM8L3NwYW4+YCArXG4gICAgICAgIGA8c3BhbiBjbGFzcz1cImxhYmVsXCI+PC9zcGFuPmAgK1xuICAgICAgICBgPHNwYW4gY2xhc3M9XCJzdGF0ZVwiPiR7dC5zdGF0dXMgPT09IFwicnVubmluZ1wiID8gJzxzcGFuIGNsYXNzPVwic3BpblwiPjwvc3Bhbj4nIDogXCJcIn0ke2VzY2FwZUh0bWwoc3RhdGUpfTwvc3Bhbj5gICtcbiAgICAgICAgYDxzcGFuIGNsYXNzPVwiYWdlXCI+JHtlbGFwc2VkKGFnbyl9IGFnbzwvc3Bhbj5gICtcbiAgICAgIGA8L2Rpdj5gICtcbiAgICAgIGA8ZGl2IGNsYXNzPVwicFwiPjwvZGl2PmA7XG4gICAgY29uc3QgbGFiZWxFbCA9IGNhcmQucXVlcnlTZWxlY3RvcihcIi5sYWJlbFwiKSBhcyBIVE1MRWxlbWVudDtcbiAgICBsYWJlbEVsLnRleHRDb250ZW50ID0gdC50aXRsZTtcbiAgICBsYWJlbEVsLnRpdGxlID0gdC50aXRsZTtcbiAgICBjYXJkLnF1ZXJ5U2VsZWN0b3IoXCIucFwiKSEudGV4dENvbnRlbnQgPSB0Lmxhc3QgfHwgKHQuYnJhbmNoID8gYE9uICR7dC5icmFuY2h9YCA6IFwiXCIpO1xuICAgIGNvbnN0IGFjdHMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGFjdHMuY2xhc3NOYW1lID0gXCJhY3RzXCI7XG4gICAgaWYgKHQucHIpIHsgY29uc3QgYSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJhXCIpOyBhLmhyZWYgPSB0LnByOyBhLnRhcmdldCA9IFwiX2JsYW5rXCI7IGEucmVsID0gXCJub29wZW5lclwiOyBhLnRleHRDb250ZW50ID0gXCJQUiBcdTIxOTdcIjsgYWN0cy5hcHBlbmQoYSk7IH1cbiAgICBjb25zdCBjb3B5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgICBjb3B5LnR5cGUgPSBcImJ1dHRvblwiO1xuICAgIGNvcHkudGV4dENvbnRlbnQgPSBcIkNvcHkgaWRcIjtcbiAgICBjb3B5Lm9uY2xpY2sgPSAoKSA9PiB7IHZvaWQgbmF2aWdhdG9yLmNsaXBib2FyZD8ud3JpdGVUZXh0KHQudGhyZWFkKTsgdG9hc3QoXCJUaHJlYWQgaWQgY29waWVkXCIpOyB9O1xuICAgIGFjdHMuYXBwZW5kKGNvcHkpO1xuICAgIGNhcmQuYXBwZW5kKGFjdHMpO1xuICAgIGNvbnN0IGFjdGl2ZSA9IHQuc3RhdHVzID09PSBcInJ1bm5pbmdcIiB8fCB0LndhaXRpbmc7XG4gICAgaWYgKGFjdGl2ZSkgZWFybGllckFjdGl2ZUNvdW50Kys7XG4gICAgaWYgKHQud2FpdGluZykgZWFybGllcldhaXRpbmdDb3VudCsrO1xuICAgIChhY3RpdmUgPyBwYW5lIDogZG9uZSkuYXBwZW5kKGNhcmQpO1xuICB9XG4gIHN5bmNTaWRlTGF5b3V0KCk7XG4gIHVwZGF0ZVRhc2tDaHJvbWUoKTtcbn1cblxuY29uc3QgU1RBVFVTX1RFWFQ6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gIGlkbGU6IFwiSWRsZVwiLCBjb25uZWN0aW5nOiBcIkNvbm5lY3RpbmdcdTIwMjZcIiwgbGlzdGVuaW5nOiBcIkxpc3RlbmluZ1wiLCB3b3JraW5nOiBcIkxpc3RlbmluZyBcdTAwQjcgdGFza3MgcnVubmluZ1wiLFxuICBkb3JtYW50OiBcIkRvcm1hbnQgXHUwMEI3IHdhaXRpbmcgZm9yIHdha2Ugd29yZFwiLFxuICBzdGFuZGJ5OiBcIlBhdXNlZCB3aGlsZSB0YXNrcyBydW4gXHUwMEI3IHNwZWFrIHRvIHJlc3VtZVwiLCB3YWtpbmc6IFwiUmVzdW1pbmdcdTIwMjZcIiwgZW5kZWQ6IFwiRW5kZWRcIixcbn07XG5cbmZ1bmN0aW9uIHNob3dTdGF0dXMobWVzc2FnZT86IHN0cmluZykge1xuICBjb25zdCB0eXBlZCA9IEJvb2xlYW4oY2FsbElkKSAmJiBtZWRpdW0gPT09IFwidGV4dFwiO1xuICBjb25zdCBzcGVha2luZyA9IEJvb2xlYW4oY2FsbElkKSAmJiAhdHlwZWQgJiYgY29yZVN0YXR1cyAhPT0gXCJzdGFuZGJ5XCIgJiYgY29yZVN0YXR1cyAhPT0gXCJkb3JtYW50XCIgJiYgYXVkaW8ucXVldWVkID4gMC4wNTtcbiAgY29uc3QgYXJtZWRJZGxlID0gIWNhbGxJZCAmJiB3YWtlQXJtZWQ7XG4gIGNvbnN0IHNob3duID0gY2FsbElkXG4gICAgPyAoc3BlYWtpbmcgfHwgKHR5cGVkICYmIHRoaW5raW5nKSA/IFwic3BlYWtpbmdcIiA6IGNvcmVTdGF0dXMpXG4gICAgOiBhcm1lZElkbGUgPyBcImFybWVkXCIgOiBjb3JlU3RhdHVzO1xuICAkKFwic3RhdHVzXCIpLmNsYXNzTmFtZSA9IHNob3duO1xuICBkb2N1bWVudC5ib2R5LmRhdGFzZXQuc3RhdGUgPSBjYWxsSWQgPyBzaG93biA6IGFybWVkSWRsZSA/IFwiYXJtZWRcIiA6IFwiaWRsZVwiO1xuICBkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC50b2dnbGUoXCJpbi1zZXNzaW9uXCIsIEJvb2xlYW4oY2FsbElkKSk7XG4gIGNvbnN0IHdha2VMYWJlbCA9IHNlbGVjdGVkV2FrZU1vZGVsKCk/LmxhYmVsID8/IFwid2FrZSB3b3JkXCI7XG4gIGxldCB0ZXh0ID0gYXJtZWRJZGxlXG4gICAgPyAod2FrZUxvYWRpbmcgPyBgTG9hZGluZyBcdTIwMUMke3dha2VMYWJlbH1cdTIwMURcdTIwMjZgXG4gICAgICA6IGF1ZGlvLmF1ZGlvU3VzcGVuZGVkID8gYFRhcCBhbnl3aGVyZSB0byBhY3RpdmF0ZSBcdTIwMUMke3dha2VMYWJlbH1cdTIwMURgXG4gICAgICA6IGBXYWl0aW5nIGZvciBcdTIwMUMke3dha2VMYWJlbH1cdTIwMURgKVxuICAgIDogc3BlYWtpbmcgPyBcIlNwZWFraW5nXCJcbiAgICA6IGNvcmVTdGF0dXMgPT09IFwiZG9ybWFudFwiID8gYERvcm1hbnQgXHUwMEI3IHNheSBcdTIwMUMke3dha2VMYWJlbH1cdTIwMURgXG4gICAgOiBTVEFUVVNfVEVYVFtjb3JlU3RhdHVzXSA/PyBjb3JlU3RhdHVzO1xuICBpZiAodHlwZWQgJiYgY29yZVN0YXR1cyAhPT0gXCJlbmRlZFwiKSB0ZXh0ID0gdGhpbmtpbmcgPyBcIldyaXRpbmdcdTIwMjZcIiA6IGNvcmVTdGF0dXMgPT09IFwid29ya2luZ1wiID8gXCJDaGF0IFx1MDBCNyB0YXNrcyBydW5uaW5nXCIgOiBcIkNoYXRcIjtcbiAgaWYgKGNhbGxJZCAmJiAhdHlwZWQgJiYgbXV0ZWQgJiYgIWhvbGRpbmcgJiYgIXNwZWFraW5nKSB0ZXh0ICs9IFwiIFx1MDBCNyBtdXRlZFwiO1xuICBpZiAoaG9sZGluZykgdGV4dCA9IFwiVGFsa2luZyAoaG9sZClcIjtcbiAgaWYgKG1lc3NhZ2UpIHRleHQgPSBgJHt0ZXh0fTogJHttZXNzYWdlfWA7XG4gIGlmIChjb3JlU3RhdHVzICE9PSBcImVuZGVkXCIgfHwgbWVzc2FnZSB8fCBhcm1lZElkbGUpICQoXCJzdGF0dXN0ZXh0XCIpLnRleHRDb250ZW50ID0gdGV4dDtcbiAgJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJodXNoXCIpLmNsYXNzTGlzdC50b2dnbGUoXCJsaXZlXCIsIHNwZWFraW5nIHx8ICh0eXBlZCAmJiB0aGlua2luZykpO1xuXG4gIGNvbnN0IGJhciA9ICQoXCJjYWxsYmFyXCIpO1xuICBiYXIuaGlkZGVuID0gIWNhbGxJZDtcbiAgJChcIndha2Utbm93XCIpLmhpZGRlbiA9ICEoY2FsbElkICYmICF0eXBlZCAmJiAoY29yZVN0YXR1cyA9PT0gXCJkb3JtYW50XCIgfHwgY29yZVN0YXR1cyA9PT0gXCJzdGFuZGJ5XCIpKTtcbiAgaWYgKGNhbGxJZCkge1xuICAgICQoXCJjYWxsYmFyLXN0YXRlXCIpLnRleHRDb250ZW50ID0gdGV4dDtcbiAgICAkKFwiY2FsbHRpbWVyXCIpLmhpZGRlbiA9IHR5cGVkO1xuICAgIGlmICghdHlwZWQpICQoXCJjYWxsdGltZXJcIikudGV4dENvbnRlbnQgPSBmb3JtYXRDbG9jayhub3coKSAtIHN0YXJ0ZWRBdCk7XG4gICAgY29uc3Qgdml6TW9kZSA9IHR5cGVkID8gKHRoaW5raW5nID8gXCJ0aGlua2luZ1wiIDogXCJpZGxlXCIpXG4gICAgICA6IHNwZWFraW5nID8gXCJzcGVha2luZ1wiXG4gICAgICA6IG11dGVkICYmICFob2xkaW5nID8gXCJtdXRlZFwiXG4gICAgICA6IHNob3duO1xuICAgIHVwZGF0ZVZpc3VhbGl6ZXIodml6TW9kZSwgbXV0ZWQgJiYgIWhvbGRpbmcgPyAwIDogYXVkaW8ubGV2ZWwpO1xuICB9XG59XG5cbi8vIFRoZSBjYWxsLlxuXG5mdW5jdGlvbiBwdXNoKGV2ZW50OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiwgdCA9IG5vdygpKTogQ29tbWFuZFtdIHtcbiAgaWYgKCFjb3JlIHx8ICFjYWxsSWQpIHJldHVybiBbXTtcbiAgY29uc3QgZTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7IC4uLmV2ZW50LCB0IH07XG4gIGNvbnN0IHF1aWV0ID0gZS50eXBlID09PSBcIm1pY1wiIHx8IGUudHlwZSA9PT0gXCJ0aWNrXCI7XG4gIGlmICghcXVpZXQpIGxvZyhcImluXCIsIGUudHlwZSA9PT0gXCJ3cy5tZXNzYWdlXCIgPyBgd3MgJHtlLnNpZH0gXHUyMTkwICR7YnJpZWYoU3RyaW5nKGUuZGF0YSkpfWAgOiBKU09OLnN0cmluZ2lmeShlKS5zbGljZSgwLCA0MDApLCBcImluXCIpO1xuICBjb25zdCBjb21tYW5kcyA9IEpTT04ucGFyc2UoY29yZS5wdXNoKGNhbGxJZCwgSlNPTi5zdHJpbmdpZnkoZSkpKSBhcyBDb21tYW5kW107XG4gIHJ1bihjb21tYW5kcywgdCk7XG4gIHJldHVybiBjb21tYW5kcztcbn1cblxuZnVuY3Rpb24gcnVuKGNvbW1hbmRzOiBDb21tYW5kW10sIGV2ZW50VGltZSA9IG5vdygpKSB7XG4gIGZvciAoY29uc3QgYyBvZiBjb21tYW5kcykge1xuICAgIHN3aXRjaCAoYy50eXBlKSB7XG4gICAgICBjYXNlIFwid3MuY29ubmVjdFwiOiBjb25uZWN0KGMuc2lkLCBjLnB1cnBvc2UgPT09IFwiY2FwdGlvbnNcIik7IGJyZWFrO1xuICAgICAgY2FzZSBcIndzLnNlbmRcIjoge1xuICAgICAgICBzb2NrZXRzLmdldChjLnNpZCk/LnNlbmQoYy5kYXRhKTtcbiAgICAgICAgaWYgKCFjLmRhdGEuc3RhcnRzV2l0aCgne1wicmVhbHRpbWVJbnB1dFwiOntcImF1ZGlvXCInKSkgbG9nKFwib3V0XCIsIGB3cyAke2Muc2lkfSBcdTIxOTIgJHticmllZihjLmRhdGEpfWAsIFwib3V0XCIpO1xuICAgICAgICBlbHNlIGlmICghY2FwdGlvblNvY2tldHMuaGFzKGMuc2lkKSkgY291bnRzLnNlbnQrKztcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwid3MuY2xvc2VcIjogc29ja2V0cy5nZXQoYy5zaWQpPy5jbG9zZSgpOyBzb2NrZXRzLmRlbGV0ZShjLnNpZCk7IGxvZyhcIm91dFwiLCBgd3MgJHtjLnNpZH0gY2xvc2VgLCBcIm91dFwiKTsgYnJlYWs7XG4gICAgICBjYXNlIFwibWljLnN0YXJ0XCI6IHtcbiAgICAgICAgbG9nKFwib3V0XCIsIGMudHlwZSwgXCJvdXRcIik7XG4gICAgICAgIGNvbnN0IHBlbmRpbmdPcGVuaW5nID0gd2FrZVN0YXJ0aW5nID8gb3BlbmluZ0NodW5rcy5zcGxpY2UoMCkgOiBbXTtcbiAgICAgICAgb3BlbmluZ0J5dGVzID0gMDtcbiAgICAgICAgd2FrZVN0YXJ0aW5nID0gZmFsc2U7XG4gICAgICAgIHZvaWQgYXVkaW8uZW5zdXJlTWljKG9uTWljLCBtaWNPcHRpb25zKCkpLmNhdGNoKChlcnIpID0+IHsgbG9nKFwiZXJyb3JcIiwgYG1pY3JvcGhvbmU6ICR7ZXJyLm1lc3NhZ2V9YCwgXCJlcnJcIik7IHRvYXN0KGBNaWNyb3Bob25lOiAke2Vyci5tZXNzYWdlfWApOyB9KTtcbiAgICAgICAgaWYgKHBlbmRpbmdPcGVuaW5nLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICBjb25zdCB0b3RhbE1zID0gTWF0aC5yb3VuZChwZW5kaW5nT3BlbmluZy5yZWR1Y2UoKHMsIGIpID0+IHMgKyBiLmJ5dGVMZW5ndGgsIDApIC8gMzIpO1xuICAgICAgICAgIGxvZyhcIm91dFwiLCBgZmx1c2hpbmcgJHt0b3RhbE1zfSBtcyBzcG9rZW4gYWZ0ZXIgd2FrZSB3b3JkYCwgXCJvdXRcIik7XG4gICAgICAgICAgcXVldWVNaWNyb3Rhc2soKCkgPT4ge1xuICAgICAgICAgICAgaWYgKCFjYWxsSWQpIHJldHVybjtcbiAgICAgICAgICAgIGZvciAoY29uc3QgY2h1bmsgb2YgcGVuZGluZ09wZW5pbmcpIHtcbiAgICAgICAgICAgICAgaWYgKCFjYWxsSWQpIGJyZWFrO1xuICAgICAgICAgICAgICBjb3VudHMubWljKys7XG4gICAgICAgICAgICAgIHB1c2goeyB0eXBlOiBcIm1pY1wiLCBwY206IGJ5dGVzVG9CYXNlNjQoY2h1bmspIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcIm1pYy5yZXN0YXJ0XCI6XG4gICAgICAgIGxvZyhcIm91dFwiLCBjLnR5cGUsIFwib3V0XCIpO1xuICAgICAgICB2b2lkIGF1ZGlvLnN0YXJ0TWljKG9uTWljLCBtaWNPcHRpb25zKCkpLmNhdGNoKChlcnIpID0+IHsgbG9nKFwiZXJyb3JcIiwgYG1pY3JvcGhvbmU6ICR7ZXJyLm1lc3NhZ2V9YCwgXCJlcnJcIik7IHRvYXN0KGBNaWNyb3Bob25lOiAke2Vyci5tZXNzYWdlfWApOyB9KTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwibWljLnN0b3BcIjpcbiAgICAgICAgaWYgKCF3YWtlQXJtZWQpIGF1ZGlvLnN0b3BNaWMoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwicGxheVwiOiB7XG4gICAgICAgIGNvbnN0IHQgPSBub3coKTtcbiAgICAgICAgY29uc3QgcGFkID0gYy5wY20uZW5kc1dpdGgoXCI9PVwiKSA/IDIgOiBjLnBjbS5lbmRzV2l0aChcIj1cIikgPyAxIDogMDtcbiAgICAgICAgY29uc3QgcGNtQnl0ZXMgPSBNYXRoLm1heCgwLCBNYXRoLmZsb29yKChjLnBjbS5sZW5ndGggKiAzKSAvIDQpIC0gcGFkKTtcbiAgICAgICAgY29yZVNwZWVjaFVudGlsID0gTWF0aC5tYXgoY29yZVNwZWVjaFVudGlsLCBldmVudFRpbWUpICsgcGNtQnl0ZXMgLyA0OF8wMDA7XG4gICAgICAgIC8vIEEgcmVwbHkgc3RhcnRpbmc6IGZyb20gdGhlIGVuZCBvZiB0aGUgdXNlcidzIHNwZWVjaCB0byBpdHMgZmlyc3Qgc291bmQuXG4gICAgICAgIGlmICghbWV0cmljcy5yZXBsaWVkICYmIGF1ZGlvLnF1ZXVlZCA8IDAuMDUgJiYgdCAtIG1ldHJpY3MubGFzdFBsYXkgPiAwLjYgJiYgbWV0cmljcy5sYXN0Vm9pY2UgPiAwICYmIHQgLSBtZXRyaWNzLmxhc3RWb2ljZSA8IDEwKSB7XG4gICAgICAgICAgbWV0cmljcy5yZXBseS5wdXNoKHQgLSBtZXRyaWNzLmxhc3RWb2ljZSk7XG4gICAgICAgICAgaWYgKG1ldHJpY3MucmVwbHkubGVuZ3RoID4gMjApIG1ldHJpY3MucmVwbHkuc2hpZnQoKTtcbiAgICAgICAgICBtZXRyaWNzLnJlcGxpZWQgPSB0cnVlO1xuICAgICAgICAgIHNob3dNZXRyaWNzKCk7XG4gICAgICAgIH1cbiAgICAgICAgbWV0cmljcy5sYXN0UGxheSA9IHQ7XG4gICAgICAgIGF1ZGlvLnBsYXkoYy5wY20pO1xuICAgICAgICBjb3VudHMucGxheSsrO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJmbHVzaFwiOlxuICAgICAgICBjb3JlU3BlZWNoVW50aWwgPSBNYXRoLm1pbihjb3JlU3BlZWNoVW50aWwsIGV2ZW50VGltZSk7XG4gICAgICAgIGF1ZGlvLmZsdXNoKCk7XG4gICAgICAgIGxvZyhcIm91dFwiLCBcImZsdXNoXCIsIFwib3V0XCIpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJjdWVcIjpcbiAgICAgICAgYXVkaW8uY3VlKGMucGNtKTtcbiAgICAgICAgbG9nKFwib3V0XCIsIGBjdWUgJHtjLmVhcmNvbn1gLCBcIm91dFwiKTtcbiAgICAgICAgLy8gQSByZXF1ZXN0IHRoYXQgYmVjYW1lIGEgdGFzayBnZXRzIGEgdG9uZSwgbm90IGEgc3Bva2VuIHJlcGx5OiBub3RoaW5nIHRvIHRpbWUuXG4gICAgICAgIGlmIChjLmVhcmNvbiA9PT0gXCJ0YXNrU3RhcnRlZFwiKSBtZXRyaWNzLnJlcGxpZWQgPSB0cnVlO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJ3YWtld29yZFwiOiBlbnN1cmVDb3JlV2FrZShCb29sZWFuKGMub24pKTsgYnJlYWs7XG4gICAgICBjYXNlIFwidG9vbC5jYWxsXCI6IHZvaWQgdG9vbChjKTsgYnJlYWs7XG4gICAgICBjYXNlIFwidG9vbC5jYW5jZWxcIjogY2FuY2VsUnVuKGMucnVuLCBjLnJlYXNvbik7IGJyZWFrO1xuICAgICAgY2FzZSBcInRvb2wuc3RlZXJcIjogdm9pZCBzdGVlclJ1bihjKTsgYnJlYWs7XG4gICAgICBjYXNlIFwic3RhdHVzXCI6IHtcbiAgICAgICAgY29uc3QgcHJldiA9IGNvcmVTdGF0dXM7XG4gICAgICAgIGNvcmVTdGF0dXMgPSBjLnN0YXR1cztcbiAgICAgICAgaWYgKGMuc3RhdHVzID09PSBcImRvcm1hbnRcIiAmJiBwcmV2ICE9PSBcImRvcm1hbnRcIiAmJiBjaGVja2VkKFwid2FrZS1jdWVcIikpIGF1ZGlvLmN1ZShTTEVFUF9UT05FKTtcbiAgICAgICAgc2hvd1N0YXR1cyhjLnN0YXR1cyA9PT0gXCJlbmRlZFwiID8gYy5tZXNzYWdlID8/IHVuZGVmaW5lZCA6IHVuZGVmaW5lZCk7XG4gICAgICAgIGxvZyhcInN0YXR1c1wiLCBjLnN0YXR1cyArIChjLm1lc3NhZ2UgPyBgOiAke2MubWVzc2FnZX1gIDogXCJcIiksIFwic3RhdHVzXCIpO1xuICAgICAgICBpZiAoYy5zdGF0dXMgPT09IFwiZW5kZWRcIikgeyBpZiAoYy5tZXNzYWdlKSBub3RlKGMubWVzc2FnZSk7IGVuZCgpOyB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcImxsbS5yZXF1ZXN0XCI6IHZvaWQgZ2VuZXJhdGUoYy5pZCwgYy5ib2R5KTsgYnJlYWs7XG4gICAgICBjYXNlIFwibGxtLmNhbmNlbFwiOiByZXF1ZXN0cy5nZXQoYy5pZCk/LmFib3J0KCk7IHJlcXVlc3RzLmRlbGV0ZShjLmlkKTsgbG9nKFwib3V0XCIsIGByZXF1ZXN0ICR7Yy5pZH0gZHJvcHBlZGAsIFwib3V0XCIpOyBicmVhaztcbiAgICAgIGNhc2UgXCJ0aGlua2luZ1wiOiB0aGlua2luZyA9IGMub247IHNob3dTdGF0dXMoKTsgYnJlYWs7XG4gICAgICBjYXNlIFwiZXJyb3JcIjogbm90ZShjLm1lc3NhZ2UpOyBsb2coXCJlcnJvclwiLCBjLm1lc3NhZ2UsIFwiZXJyXCIpOyBicmVhaztcbiAgICAgIGNhc2UgXCJjYXB0aW9uXCI6IGNhcHRpb24oYy50ZXh0KTsgYnJlYWs7XG4gICAgICBjYXNlIFwidHJhbnNjcmlwdFwiOlxuICAgICAgICB0cmFuc2NyaXB0KGMucm9sZSwgYy50ZXh0LCBjLmxpbmUpO1xuICAgICAgICByZW1lbWJlcihjLnJvbGUsIGMudGV4dCwgYy5yb2xlID09PSBcImFzc2lzdGFudFwiID8gXCJHZW1pbmlcIiA6IHVuZGVmaW5lZCwgbGFzdExpbmUgPT09IGMubGluZSk7XG4gICAgICAgIGxhc3RMaW5lID0gYy5saW5lO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJ0YXNrXCI6IHtcbiAgICAgICAgY29uc3QgdmlldyA9IHRhc2tzLmdldChjLmlkKSA/PyB7IGMsIHNpbmNlOiBub3coKSwgZW5kZWQ6IG51bGwgfTtcbiAgICAgICAgaWYgKGMuc3RhdGUgPT09IFwicnVubmluZ1wiICYmIHZpZXcuYy5zdGF0ZSAhPT0gXCJydW5uaW5nXCIpIHsgdmlldy5zaW5jZSA9IG5vdygpOyB2aWV3LmVuZGVkID0gbnVsbDsgfVxuICAgICAgICBpZiAoYy5zdGF0ZSAhPT0gXCJydW5uaW5nXCIgJiYgdmlldy5lbmRlZCA9PSBudWxsKSB2aWV3LmVuZGVkID0gbm93KCk7XG4gICAgICAgIHZpZXcuYyA9IGM7XG4gICAgICAgIHRhc2tzLnNldChjLmlkLCB2aWV3KTtcbiAgICAgICAgc2hvd1Rhc2tzKCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcInF1ZXN0aW9uc1wiOiBicmVhaztcbiAgICAgIGNhc2UgXCJtaWNTaWxlbnRcIjogJChcIm1pY3dhcm5cIikuaGlkZGVuID0gIWMuc2lsZW50OyBicmVhaztcbiAgICAgIGNhc2UgXCJ2b2ljZUNvbW1hbmRcIjpcbiAgICAgICAgdG9hc3QoYEhlYXJkIFx1MjAxQyR7Yy5oZWFyZH1cdTIwMUQ6ICR7Yy5jb21tYW5kID09PSBcInN0b3BcIiA/IFwic3RvcHBlZFwiIDogYy5jb21tYW5kID09PSBcImNhbmNlbEFsbFwiID8gXCJjYW5jZWxsaW5nIGV2ZXJ5IHRhc2tcIiA6IFwiaGFuZ2luZyB1cFwifWApO1xuICAgICAgICBsb2coXCJvdXRcIiwgYHZvaWNlIGNvbW1hbmQgJHtjLmNvbW1hbmR9OiAke2MuaGVhcmR9YCwgXCJvdXRcIik7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcImxvZ1wiOiBsb2coYy5sZXZlbCwgYy5tZXNzYWdlLCBjLmxldmVsID09PSBcIndhcm5cIiA/IFwid2FyblwiIDogXCJcIik7IGJyZWFrO1xuICAgICAgZGVmYXVsdDogbG9nKFwib3V0XCIsIEpTT04uc3RyaW5naWZ5KGMpLnNsaWNlKDAsIDMwMCksIFwib3V0XCIpO1xuICAgIH1cbiAgfVxufVxuXG5mdW5jdGlvbiBmbHVzaERlZmVycmVkTWljKCkge1xuICBpZiAoZGVmZXJyZWRNaWMubGVuZ3RoID09PSAwKSByZXR1cm47XG4gIGNvbnN0IGl0ZW1zID0gZGVmZXJyZWRNaWMuc3BsaWNlKDApO1xuICBpZiAoIWNhbGxJZCB8fCBtZWRpdW0gIT09IFwidm9pY2VcIikgcmV0dXJuO1xuICBmb3IgKGNvbnN0IGl0ZW0gb2YgaXRlbXMpIHtcbiAgICBpZiAoIWNhbGxJZCkgYnJlYWs7XG4gICAgY291bnRzLm1pYysrO1xuICAgIHB1c2goeyB0eXBlOiBcIm1pY1wiLCBwY206IGl0ZW0ucGNtIH0sIGl0ZW0udCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gb25NaWMoc2FtcGxlczogSW50MTZBcnJheSwgbGV2ZWw6IG51bWJlcikge1xuICBjb25zdCB0ID0gbm93KCk7XG4gIGNvbnN0IHN1cHByZXNzZWQgPSBjYWxsSWQgIT09IDAgJiYgbWVkaXVtID09PSBcInZvaWNlXCIgJiYgY2FsbFdoaWxlU3BlYWtpbmcgIT09IFwic2VuZFwiICYmIHQgPCBjb3JlU3BlZWNoVW50aWw7XG4gIGNvbnN0IHNlcSA9IHNob3VsZEZlZWRXYWtlKCkgPyB3YWtlQ2xpZW50LmZlZWQoc2FtcGxlcywgc3VwcHJlc3NlZCkgOiAwO1xuICBpZiAod2FrZVN0YXJ0aW5nKSB7XG4gICAgY29uc3QgY29weSA9IG5ldyBVaW50OEFycmF5KHNhbXBsZXMuYnl0ZUxlbmd0aCk7XG4gICAgY29weS5zZXQobmV3IFVpbnQ4QXJyYXkoc2FtcGxlcy5idWZmZXIsIHNhbXBsZXMuYnl0ZU9mZnNldCwgc2FtcGxlcy5ieXRlTGVuZ3RoKSk7XG4gICAgb3BlbmluZ0NodW5rcy5wdXNoKGNvcHkpO1xuICAgIG9wZW5pbmdCeXRlcyArPSBjb3B5LmJ5dGVMZW5ndGg7XG4gICAgd2hpbGUgKG9wZW5pbmdCeXRlcyA+IE9QRU5JTkdfTUFYX0JZVEVTICYmIG9wZW5pbmdDaHVua3MubGVuZ3RoID4gMSkge1xuICAgICAgb3BlbmluZ0J5dGVzIC09IG9wZW5pbmdDaHVua3Muc2hpZnQoKSEuYnl0ZUxlbmd0aDtcbiAgICB9XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmICghY2FsbElkIHx8IG1lZGl1bSAhPT0gXCJ2b2ljZVwiKSByZXR1cm47XG4gIGlmIChsZXZlbCA+IDAuMDMgJiYgIShtdXRlZCAmJiAhaG9sZGluZykpIHtcbiAgICBtZXRyaWNzLmxhc3RWb2ljZSA9IHQ7XG4gICAgaWYgKGF1ZGlvLnF1ZXVlZCA8IDAuMDUpIG1ldHJpY3MucmVwbGllZCA9IGZhbHNlO1xuICB9XG4gIGNvbnN0IHBjbSA9IGJ5dGVzVG9CYXNlNjQobmV3IFVpbnQ4QXJyYXkoc2FtcGxlcy5idWZmZXIsIHNhbXBsZXMuYnl0ZU9mZnNldCwgc2FtcGxlcy5ieXRlTGVuZ3RoKSk7XG4gIC8vIElmIHBsYXliYWNrIGp1c3QgZW5kZWQgd2hpbGUgYSBzdXBwcmVzc2VkIGZyYW1lIGlzIHN0aWxsIHNjb3JpbmcgaW4gdGhlIHdha2Ugd29ya2VyLCBob2xkXG4gIC8vIHVuc3VwcHJlc3NlZCBmcmFtZXMgYnJpZWZseSBzbyB0aGV5IG5ldmVyIGxhbmQgYWhlYWQgb2YgYSBzdXBwcmVzc2VkIHdha2UgdGFpbCBpbiBwcmUtcm9sbC5cbiAgaWYgKCFzdXBwcmVzc2VkICYmIHdha2VDbGllbnQuc3VwcHJlc3NlZEluRmxpZ2h0ICYmIGNhbGxXaGlsZVNwZWFraW5nICE9PSBcInNlbmRcIikge1xuICAgIGRlZmVycmVkTWljLnB1c2goeyBzZXEsIHBjbSwgdCB9KTtcbiAgICBpZiAoZGVmZXJyZWRNaWMubGVuZ3RoID4gNzUpIGZsdXNoRGVmZXJyZWRNaWMoKTtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKGRlZmVycmVkTWljLmxlbmd0aCA+IDApIGZsdXNoRGVmZXJyZWRNaWMoKTtcbiAgY291bnRzLm1pYysrO1xuICBwdXNoKHsgdHlwZTogXCJtaWNcIiwgcGNtIH0sIHQpO1xufVxuXG5mdW5jdGlvbiBjb25uZWN0KHNpZDogbnVtYmVyLCBjYXB0aW9uczogYm9vbGVhbikge1xuICBjb25zdCB3cyA9IG5ldyBXZWJTb2NrZXQoYCR7bG9jYXRpb24ucHJvdG9jb2wgPT09IFwiaHR0cHM6XCIgPyBcIndzc1wiIDogXCJ3c1wifTovLyR7bG9jYXRpb24uaG9zdH0vbGl2ZSR7Y2FwdGlvbnMgPyBcIj9mb3I9Y2FwdGlvbnNcIiA6IFwiXCJ9YCk7XG4gIHNvY2tldHMuc2V0KHNpZCwgd3MpO1xuICBpZiAoY2FwdGlvbnMpIGNhcHRpb25Tb2NrZXRzLmFkZChzaWQpO1xuICBsb2coXCJvdXRcIiwgYHdzICR7c2lkfSBjb25uZWN0ICgke3NlcnZlci5yb3V0ZX0ke2NhcHRpb25zID8gXCIsIGNhcHRpb25zXCIgOiBcIlwifSlgLCBcIm91dFwiKTtcbiAgd3Mub25vcGVuID0gKCkgPT4gcHVzaCh7IHR5cGU6IFwid3Mub3BlblwiLCBzaWQgfSk7XG4gIHdzLm9ubWVzc2FnZSA9IChtKSA9PiBwdXNoKHsgdHlwZTogXCJ3cy5tZXNzYWdlXCIsIHNpZCwgZGF0YTogdHlwZW9mIG0uZGF0YSA9PT0gXCJzdHJpbmdcIiA/IG0uZGF0YSA6IFwiXCIgfSk7XG4gIHdzLm9uY2xvc2UgPSAoZSkgPT4ge1xuICAgIGlmIChzb2NrZXRzLmdldChzaWQpICE9PSB3cyAmJiBzb2NrZXRzLmhhcyhzaWQpKSByZXR1cm47XG4gICAgY29uc3QgaHR0cFN0YXR1cyA9IGUuY29kZSA+PSA0MTAwICYmIGUuY29kZSA8IDQ2MDAgPyBlLmNvZGUgLSA0MDAwIDogdW5kZWZpbmVkO1xuICAgIHB1c2goeyB0eXBlOiBcIndzLmNsb3NlZFwiLCBzaWQsIGNvZGU6IGh0dHBTdGF0dXMgPyB1bmRlZmluZWQgOiBlLmNvZGUsIHJlYXNvbjogZS5yZWFzb24sIGh0dHBTdGF0dXMgfSk7XG4gIH07XG59XG5cbi8qKiBBIGNoYXQncyByZXF1ZXN0IHRvIHRoZSB0ZXh0IG1vZGVsLCB0aHJvdWdoIHRoZSBzZXJ2ZXI6IGVhY2ggYGRhdGE6YCBsaW5lIG9mIHRoZSBtb2RlbCdzIHN0cmVhbSBnb2VzIHRvIHRoZSBjb3JlIGFzIGl0IGNvbWVzLiAqL1xuYXN5bmMgZnVuY3Rpb24gZ2VuZXJhdGUoaWQ6IG51bWJlciwgYm9keTogc3RyaW5nKSB7XG4gIGNvbnN0IGFib3J0ID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICByZXF1ZXN0cy5zZXQoaWQsIGFib3J0KTtcbiAgbG9nKFwib3V0XCIsIGByZXF1ZXN0ICR7aWR9IFx1MjE5MiAke3NlcnZlci50ZXh0TW9kZWx9ICgke01hdGgucm91bmQoYm9keS5sZW5ndGggLyAxMDI0KX0gS0IpYCwgXCJvdXRcIik7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChcIi9nZW5lcmF0ZVwiLCB7IG1ldGhvZDogXCJQT1NUXCIsIHNpZ25hbDogYWJvcnQuc2lnbmFsLCBoZWFkZXJzOiB7IFwiY29udGVudC10eXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sIGJvZHkgfSk7XG4gICAgaWYgKCFyZXNwb25zZS5vayB8fCAhcmVzcG9uc2UuYm9keSkge1xuICAgICAgY29uc3QgdGV4dCA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKS5jYXRjaCgoKSA9PiBcIlwiKTtcbiAgICAgIHB1c2goeyB0eXBlOiBcImxsbS5lbmRcIiwgaWQsIHN0YXR1czogcmVzcG9uc2Uuc3RhdHVzLCBlcnJvcjogYEhUVFAgJHtyZXNwb25zZS5zdGF0dXN9JHt0ZXh0ID8gXCI6IFwiICsgdGV4dC5yZXBsYWNlKC9cXHMrL2csIFwiIFwiKS5zbGljZSgwLCAyMDApIDogXCJcIn1gIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCByZWFkZXIgPSByZXNwb25zZS5ib2R5LnBpcGVUaHJvdWdoKG5ldyBUZXh0RGVjb2RlclN0cmVhbSgpKS5nZXRSZWFkZXIoKTtcbiAgICBsZXQgYnVmZmVyID0gXCJcIjtcbiAgICBmb3IgKDs7KSB7XG4gICAgICBjb25zdCB7IHZhbHVlLCBkb25lIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpO1xuICAgICAgaWYgKGRvbmUpIGJyZWFrO1xuICAgICAgYnVmZmVyICs9IHZhbHVlO1xuICAgICAgbGV0IGN1dDtcbiAgICAgIHdoaWxlICgoY3V0ID0gYnVmZmVyLmluZGV4T2YoXCJcXG5cIikpID49IDApIHtcbiAgICAgICAgY29uc3QgbGluZSA9IGJ1ZmZlci5zbGljZSgwLCBjdXQpLnJlcGxhY2UoL1xcciQvLCBcIlwiKTtcbiAgICAgICAgYnVmZmVyID0gYnVmZmVyLnNsaWNlKGN1dCArIDEpO1xuICAgICAgICBpZiAobGluZS5zdGFydHNXaXRoKFwiZGF0YTpcIikpIHB1c2goeyB0eXBlOiBcImxsbS5kYXRhXCIsIGlkLCBkYXRhOiBsaW5lLnNsaWNlKDUpLnRyaW0oKSB9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgcHVzaCh7IHR5cGU6IFwibGxtLmVuZFwiLCBpZCB9KTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgaWYgKCFhYm9ydC5zaWduYWwuYWJvcnRlZCkgcHVzaCh7IHR5cGU6IFwibGxtLmVuZFwiLCBpZCwgZXJyb3I6IChlcnIgYXMgRXJyb3IpLm1lc3NhZ2UgfSk7XG4gIH0gZmluYWxseSB7XG4gICAgcmVxdWVzdHMuZGVsZXRlKGlkKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBjYW5jZWxSdW4oa2V5OiBzdHJpbmcsIHJlYXNvbjogc3RyaW5nKSB7XG4gIGNvbnN0IHIgPSBydW5zLmdldChrZXkpO1xuICBsb2coXCJvdXRcIiwgYGNhbmNlbCAke2tleX0gKCR7cmVhc29ufSlgLCBcIm91dFwiKTtcbiAgaWYgKCFyKSByZXR1cm47XG4gIHJ1bnMuZGVsZXRlKGtleSk7XG4gIHIuYWJvcnQuYWJvcnQoKTtcbiAgLy8gQ2FuY2VsbGVkIG9uIHB1cnBvc2U6IHRoZSBhZ2VudCBzdG9wcyB0b28uIEEgY2FsbCB0aGF0IGVuZGVkIGxlYXZlcyBhIGNvZGluZyBhZ2VudCB3b3JraW5nIGluIFQzLlxuICBpZiAocmVhc29uID09PSBcImNhbmNlbGxlZFwiICYmICFjaGVja2VkKFwiZmFrZWhlcm1lc1wiKSkge1xuICAgIHZvaWQgZmV0Y2goci5hZ2VudCA9PT0gXCJ0M1wiID8gXCIvYWdlbnQvY2FuY2VsXCIgOiBcIi9oZXJtZXMvc3RvcFwiLCB7IG1ldGhvZDogXCJQT1NUXCIsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgY2FsbDogY2FsbE5hbWUsIHRhc2tJZDogci50YXNrSWQgfSkgfSk7XG4gIH1cbn1cblxuLyoqIE1vcmUgZm9yIGEgcnVubmluZyB0YXNrLCBpbnRvIGl0cyBjdXJyZW50IHJ1bjsgaWYgdGhlIGFnZW50IHdvbid0IHRha2UgaXQsIHRoZSBjb3JlIHF1ZXVlcyBpdCBpbnN0ZWFkLiAqL1xuYXN5bmMgZnVuY3Rpb24gc3RlZXJSdW4oYzogQ29tbWFuZCkge1xuICBjb25zdCByID0gcnVucy5nZXQoYy5ydW4pO1xuICBsb2coXCJvdXRcIiwgYHN0ZWVyICR7Yy5ydW59OiAke2MudGV4dH1gLCBcIm91dFwiKTtcbiAgaWYgKGNoZWNrZWQoXCJmYWtlaGVybWVzXCIpKSByZXR1cm47XG4gIGNvbnN0IG9rID0gciAhPSBudWxsICYmXG4gICAgKGF3YWl0IGZldGNoKGMuYWdlbnQgPT09IFwidDNcIiA/IFwiL2FnZW50L3N0ZWVyXCIgOiBcIi9oZXJtZXMvc3RlZXJcIiwgeyBtZXRob2Q6IFwiUE9TVFwiLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGNhbGw6IGNhbGxOYW1lLCB0YXNrSWQ6IHIudGFza0lkLCB0ZXh0OiBjLm1lc3NhZ2UgfSkgfSkudGhlbigoeCkgPT4geC5vaywgKCkgPT4gZmFsc2UpKTtcbiAgaWYgKCFvaykgcHVzaCh7IHR5cGU6IFwidG9vbC5zdGVlckZhaWxlZFwiLCBydW46IGMucnVuLCB0ZXh0OiBjLnRleHQgfSk7XG4gIGVsc2UgdG9hc3QoYCR7Yy5hZ2VudCA9PT0gXCJ0M1wiID8gXCJUaGUgY29kaW5nIGFnZW50XCIgOiBcIkhlcm1lc1wifSB0b29rIHRoZSBmb2xsb3ctdXAgd2hpbGUgaXQgd29ya3NgKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gdG9vbChjOiBDb21tYW5kKSB7XG4gIGlmIChjLmtpbmQgPT09IFwiaG9zdFwiKSB7XG4gICAgbG9nKFwib3V0XCIsIGBob3N0IHRvb2wgJHtjLm5hbWV9ICR7SlNPTi5zdHJpbmdpZnkoYy5hcmdzKX1gLCBcIm91dFwiKTtcbiAgICBjb25zdCBhbnN3ZXIgPSBjLm5hbWUgPT09IFwidHZfdm9sdW1lXCIgPyBgVGhlIFRWIGlzIGF0ICR7KGZha2VUdkxldmVsID0gTnVtYmVyKGMuYXJncz8ubGV2ZWwgPz8gZmFrZVR2TGV2ZWwpKX0uYFxuICAgICAgOiBjLm5hbWUgPT09IFwidHZfcGF1c2VcIiA/IChjLmFyZ3M/LnBhdXNlID09PSBmYWxzZSA/IFwiUGxheWluZy5cIiA6IFwiUGF1c2VkLlwiKSA6IFwiRG9uZS5cIjtcbiAgICBzZXRUaW1lb3V0KCgpID0+IHB1c2goeyB0eXBlOiBcInRvb2wucmVzdWx0XCIsIHJ1bjogYy5ydW4sIHRleHQ6IGFuc3dlciB9KSwgMzAwKTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgYWdlbnQgPSBjLmFnZW50ID09PSBcInQzXCIgPyBcInQzXCIgOiBcImhlcm1lc1wiO1xuICBjb25zdCBvcmlnaW5TZXNzaW9uID0gYWN0aXZlU2Vzc2lvbjtcbiAgbG9nKFwib3V0XCIsIGAke2FnZW50fSAke2MuZm9sbG93VXAgPyBcImZvbGxvdy11cFwiIDogXCJ0YXNrXCJ9IFwiJHtjLmxhYmVsfVwiJHtjLnByb2plY3QgPyBgIGluICR7Yy5wcm9qZWN0fWAgOiBcIlwifTogJHtjLnJlcXVlc3R9YCwgXCJvdXRcIik7XG4gIGNvbnN0IGFib3J0ID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICBydW5zLnNldChjLnJ1biwgeyBhYm9ydCwgYWdlbnQsIHRhc2tJZDogYy50YXNrSWQgfSk7XG4gIGNvbnN0IGRvbmUgPSAodGV4dDogc3RyaW5nLCBmYWlsZWQgPSBmYWxzZSkgPT4ge1xuICAgIGlmICghcnVucy5oYXMoYy5ydW4pKSByZXR1cm47XG4gICAgcnVucy5kZWxldGUoYy5ydW4pO1xuICAgIGNvbnN0IHZpZXcgPSB0YXNrcy5nZXQoYy50YXNrSWQpO1xuICAgIGNvbnN0IHJlc0lkID0gcmVzdWx0KGFnZW50LCBjLmxhYmVsLCB0ZXh0LCBmYWlsZWQsIGMudGFza0lkLCBvcmlnaW5TZXNzaW9uKTtcbiAgICBub3RpZnkoYCR7YWdlbnQgPT09IFwidDNcIiA/IFwiVDNcIiA6IFwiSGVybWVzXCJ9IFx1MDBCNyAke2MubGFiZWx9YCwgdGV4dCk7XG4gICAgaWYgKCFmYWlsZWQpIHsgcmVtZW1iZXIoXCJhc3Npc3RhbnRcIiwgdGV4dCwgYCR7YWdlbnQgPT09IFwidDNcIiA/IFwiVDNcIiA6IFwiSGVybWVzXCJ9IFx1MDBCNyAke2MubGFiZWx9YCk7IGxhc3RMaW5lID0gbnVsbDsgfVxuICAgIGlmICh2aWV3KSB7IHZpZXcucmVzdWx0SWQgPSByZXNJZDsgc2hvd1Rhc2tzKCk7IH1cbiAgICBwdXNoKHsgdHlwZTogXCJ0b29sLnJlc3VsdFwiLCBydW46IGMucnVuLCB0ZXh0LCBmYWlsZWQgfSk7XG4gIH07XG4gIGlmIChjaGVja2VkKFwiZmFrZWhlcm1lc1wiKSkge1xuICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiBkb25lKGAoRmFrZSAke2FnZW50ID09PSBcInQzXCIgPyBcIlQzXCIgOiBcIkhlcm1lc1wifSkgRG9uZTogXHUyMDFDJHtjLnJlcXVlc3R9XHUyMDFELiBOb3RoaW5nIHdhcyBhY3R1YWxseSBydW4uYCksIE51bWJlcigkPEhUTUxJbnB1dEVsZW1lbnQ+KFwiZmFrZWRlbGF5XCIpLnZhbHVlKSAqIDEwMDApO1xuICAgIGFib3J0LnNpZ25hbC5vbmFib3J0ID0gKCkgPT4gY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICByZXR1cm47XG4gIH1cbiAgdHJ5IHtcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKGFnZW50ID09PSBcInQzXCIgPyBcIi9hZ2VudFwiIDogXCIvaGVybWVzXCIsIHtcbiAgICAgIG1ldGhvZDogXCJQT1NUXCIsIHNpZ25hbDogYWJvcnQuc2lnbmFsLCBoZWFkZXJzOiB7IFwiY29udGVudC10eXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGNhbGw6IGNhbGxOYW1lLCB0YXNrSWQ6IGMudGFza0lkLCBmb2xsb3dVcDogYy5mb2xsb3dVcCwgbWVzc2FnZTogYy5tZXNzYWdlLCBsYWJlbDogYy5sYWJlbCwgcmVxdWVzdDogYy5yZXF1ZXN0LCBwcm9qZWN0OiBjLnByb2plY3QsIGFwcHJvdmFsczogXCJzY3JlZW5cIiB9KSxcbiAgICB9KTtcbiAgICBpZiAoIXJlc3BvbnNlLm9rIHx8ICFyZXNwb25zZS5ib2R5KSB0aHJvdyBuZXcgRXJyb3IoYEhUVFAgJHtyZXNwb25zZS5zdGF0dXN9YCk7XG4gICAgY29uc3QgcmVhZGVyID0gcmVzcG9uc2UuYm9keS5waXBlVGhyb3VnaChuZXcgVGV4dERlY29kZXJTdHJlYW0oKSkuZ2V0UmVhZGVyKCk7XG4gICAgbGV0IGJ1ZmZlciA9IFwiXCI7XG4gICAgZm9yICg7Oykge1xuICAgICAgY29uc3QgeyB2YWx1ZSwgZG9uZTogZmluaXNoZWQgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICBpZiAoZmluaXNoZWQpIGJyZWFrO1xuICAgICAgYnVmZmVyICs9IHZhbHVlO1xuICAgICAgbGV0IGN1dDtcbiAgICAgIHdoaWxlICgoY3V0ID0gYnVmZmVyLmluZGV4T2YoXCJcXG5cXG5cIikpID49IDApIHtcbiAgICAgICAgY29uc3QgYmxvY2sgPSBidWZmZXIuc2xpY2UoMCwgY3V0KTtcbiAgICAgICAgYnVmZmVyID0gYnVmZmVyLnNsaWNlKGN1dCArIDIpO1xuICAgICAgICBjb25zdCBldmVudCA9IGJsb2NrLm1hdGNoKC9eZXZlbnQ6ICguKikkL20pPy5bMV07XG4gICAgICAgIGlmICghZXZlbnQpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCBkYXRhID0gSlNPTi5wYXJzZShibG9jay5tYXRjaCgvXmRhdGE6ICguKikkL20pPy5bMV0gPz8gXCJ7fVwiKTtcbiAgICAgICAgaWYgKGV2ZW50ID09PSBcInByb2dyZXNzXCIpIHB1c2goeyB0eXBlOiBcInRhc2sucHJvZ3Jlc3NcIiwgdGFzazogYy50YXNrSWQsIHRleHQ6IGRhdGEudGV4dCB9KTtcbiAgICAgICAgZWxzZSBpZiAoZXZlbnQgPT09IFwidGhyZWFkXCIpIHsgY29uc3QgdmlldyA9IHRhc2tzLmdldChjLnRhc2tJZCk7IGlmICh2aWV3KSB7IHZpZXcudGhyZWFkID0gZGF0YS50aHJlYWQ7IHNob3dUYXNrcygpOyB9IH1cbiAgICAgICAgZWxzZSBpZiAoZXZlbnQgPT09IFwiYXBwcm92YWxcIikge1xuICAgICAgICAgIGNvbnN0IHZpZXcgPSB0YXNrcy5nZXQoYy50YXNrSWQpO1xuICAgICAgICAgIGlmICh2aWV3KSB7IHZpZXcuYXBwcm92YWwgPSB7IGNvbW1hbmQ6IGRhdGEuY29tbWFuZCB9OyBzaG93VGFza3ModHJ1ZSk7IH1cbiAgICAgICAgICB0b2FzdChgSGVybWVzIGFza3MgdG8gcnVuOiAke2RhdGEuY29tbWFuZC5zbGljZSgwLCA4MCl9YCk7XG4gICAgICAgICAgbm90aWZ5KGBIZXJtZXMgXHUwMEI3ICR7Yy5sYWJlbH0gbmVlZHMgeW91ciBhcHByb3ZhbGAsIGRhdGEuY29tbWFuZCk7XG4gICAgICAgICAgYXVkaW8uY3VlKEFQUFJPVkFMX1RPTkUpO1xuICAgICAgICB9XG4gICAgICAgIGVsc2UgaWYgKGV2ZW50ID09PSBcInJlc3VsdFwiKSBkb25lKGRhdGEudGV4dCwgZGF0YS5mYWlsZWQpO1xuICAgICAgICBlbHNlIGlmIChldmVudCA9PT0gXCJlcnJvclwiKSB7IHJ1bnMuZGVsZXRlKGMucnVuKTsgcHVzaCh7IHR5cGU6IFwidG9vbC5lcnJvclwiLCBydW46IGMucnVuLCBtZXNzYWdlOiBkYXRhLm1lc3NhZ2UgfSk7IH1cbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKHJ1bnMuaGFzKGMucnVuKSkgeyBydW5zLmRlbGV0ZShjLnJ1bik7IHB1c2goeyB0eXBlOiBcInRvb2wuZXJyb3JcIiwgcnVuOiBjLnJ1biwgbWVzc2FnZTogXCJ0aGUgc2VydmVyIGNsb3NlZCB0aGUgc3RyZWFtIHdpdGhvdXQgYSByZXN1bHRcIiB9KTsgfVxuICB9IGNhdGNoIChlcnIpIHtcbiAgICBpZiAoIWFib3J0LnNpZ25hbC5hYm9ydGVkICYmIHJ1bnMuaGFzKGMucnVuKSkgeyBydW5zLmRlbGV0ZShjLnJ1bik7IHB1c2goeyB0eXBlOiBcInRvb2wuZXJyb3JcIiwgcnVuOiBjLnJ1biwgbWVzc2FnZTogKGVyciBhcyBFcnJvcikubWVzc2FnZSB9KTsgfVxuICB9XG59XG5cbmZ1bmN0aW9uIG1pY09wdGlvbnMoKSB7XG4gIGNvbnN0IGFlYyA9IGNoZWNrZWQoXCJhZWNcIik7XG4gIHJldHVybiB7IGVjaG9DYW5jZWxsYXRpb246IGFlYywgbm9pc2VTdXBwcmVzc2lvbjogYWVjLCBhdXRvR2FpbkNvbnRyb2w6IGFlYyB9O1xufVxuXG5mdW5jdGlvbiBudW1iZXJTZXR0aW5nKGlkOiBzdHJpbmcsIGZhbGxiYWNrOiBudW1iZXIsIG1pbiA9IDAsIG1heCA9IDM2MDApOiBudW1iZXIge1xuICBjb25zdCBuID0gTnVtYmVyKCQ8SFRNTElucHV0RWxlbWVudD4oaWQpLnZhbHVlKTtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShuKSA/IE1hdGgubWF4KG1pbiwgTWF0aC5taW4obWF4LCBuKSkgOiBmYWxsYmFjaztcbn1cblxuZnVuY3Rpb24gZGV2ZWxvcGVyT3ZlcnJpZGVzKCkge1xuICB0cnkge1xuICAgIGNvbnN0IGdpdmVuID0gSlNPTi5wYXJzZSgkPEhUTUxUZXh0QXJlYUVsZW1lbnQ+KFwiY29uZmlnXCIpLnZhbHVlKTtcbiAgICBpZiAoIWdpdmVuIHx8IHR5cGVvZiBnaXZlbiAhPT0gXCJvYmplY3RcIikge1xuICAgICAgcmV0dXJuIHsgbm9uV2ViUGxhdGZvcm06IG51bGwgYXMgc3RyaW5nIHwgbnVsbCwgaGFzQXR0ZW50aW9uOiBmYWxzZSwgaGFzSGFuZ1VwOiBmYWxzZSwgaGFzU3RhbmRieTogZmFsc2UsIGhhc01pY1doaWxlU3BlYWtpbmc6IGZhbHNlIH07XG4gICAgfVxuICAgIGNvbnN0IG5vbldlYlBsYXRmb3JtID0gdHlwZW9mIGdpdmVuLnBsYXRmb3JtID09PSBcInN0cmluZ1wiICYmIGdpdmVuLnBsYXRmb3JtICE9PSBcIndlYlwiID8gZ2l2ZW4ucGxhdGZvcm0gOiBudWxsO1xuICAgIGNvbnN0IG1pYyA9IGdpdmVuLm1pYyAmJiB0eXBlb2YgZ2l2ZW4ubWljID09PSBcIm9iamVjdFwiID8gZ2l2ZW4ubWljIDogbnVsbDtcbiAgICByZXR1cm4ge1xuICAgICAgbm9uV2ViUGxhdGZvcm0sXG4gICAgICBoYXNBdHRlbnRpb246IGdpdmVuLmF0dGVudGlvbiAhPT0gdW5kZWZpbmVkLFxuICAgICAgaGFzSGFuZ1VwOiBnaXZlbi5oYW5nVXBBZnRlciAhPT0gdW5kZWZpbmVkLFxuICAgICAgaGFzU3RhbmRieTogZ2l2ZW4uc3RhbmRieUFmdGVyICE9PSB1bmRlZmluZWQsXG4gICAgICBoYXNNaWNXaGlsZVNwZWFraW5nOiBtaWMgIT0gbnVsbCAmJiBtaWMud2hpbGVTcGVha2luZyAhPT0gdW5kZWZpbmVkLFxuICAgIH07XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiB7IG5vbldlYlBsYXRmb3JtOiBudWxsIGFzIHN0cmluZyB8IG51bGwsIGhhc0F0dGVudGlvbjogZmFsc2UsIGhhc0hhbmdVcDogZmFsc2UsIGhhc1N0YW5kYnk6IGZhbHNlLCBoYXNNaWNXaGlsZVNwZWFraW5nOiBmYWxzZSB9O1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlYWRDb25maWcoKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICBjb25zdCBnaXZlbiA9IEpTT04ucGFyc2UoJDxIVE1MVGV4dEFyZWFFbGVtZW50PihcImNvbmZpZ1wiKS52YWx1ZSk7XG4gIGNvbnN0IGNvbmZpZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgbW9kZWw6IHNlcnZlci5tb2RlbCwgYXBpOiBzZXJ2ZXIucm91dGUgPT09IFwidmVydGV4XCIgPyBcInZlcnRleFwiIDogXCJnZW1pbmlcIiwgdG9kYXk6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKS5zbGljZSgwLCAxMCksXG4gICAgLi4uZ2l2ZW4sIHRyYWNlOiBjaGVja2VkKFwidHJhY2VcIiksXG4gIH07XG4gIGlmIChjaGVja2VkKFwicHR0XCIpKSBjb25maWcubXV0ZWQgPSB0cnVlO1xuICBpZiAoZ2l2ZW4udm9pY2UgPT09IHVuZGVmaW5lZCkgY29uZmlnLnZvaWNlID0gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJ2b2ljZVwiKS52YWx1ZTtcbiAgaWYgKGNvbmZpZy5zdGVlcmluZyA9PT0gdW5kZWZpbmVkKSBjb25maWcuc3RlZXJpbmcgPSBbXCJoZXJtZXNcIiwgXCJ0M1wiXTtcbiAgLy8gQSB3ZWIgY29uZmlnIHNhdmVkIGJlZm9yZSBoYW5kLW9mZnMgd2VyZSBuYW1lZCBpbiB3b3JkcyBnZXRzIHRoYXQgdG9vLlxuICBpZiAoY29uZmlnLmhhbmRPZmYgPT09IHVuZGVmaW5lZCAmJiBjb25maWcucGxhdGZvcm0gPT09IFwid2ViXCIpIGNvbmZpZy5oYW5kT2ZmID0gXCJuYW1lZFwiO1xuICAvLyBBbmQgb25lIHNhdmVkIGJlZm9yZSB0aGUgcGFnZSBmb2xsb3dlZCB0aGUgdXNlcidzIGxlYWQgKHN1cGVydmlzZSkgZ2V0cyB0aGF0LlxuICBpZiAoY29uZmlnLnN1cGVydmlzZSA9PT0gdW5kZWZpbmVkICYmIGNvbmZpZy5wbGF0Zm9ybSA9PT0gXCJ3ZWJcIikgY29uZmlnLnN1cGVydmlzZSA9IHRydWU7XG4gIGlmIChjaGVja2VkKFwiY29kaW5nXCIpICYmIChzZXJ2ZXIudDMgfHwgY2hlY2tlZChcImZha2VoZXJtZXNcIikpICYmIGNvbmZpZy5jb2RpbmdBZ2VudCA9PT0gdW5kZWZpbmVkKSBjb25maWcuY29kaW5nQWdlbnQgPSB7IHByb2plY3RzOiBzZXJ2ZXIudDMgPz8gW10gfTtcbiAgaWYgKGNoZWNrZWQoXCJjYXB0aW9uc1wiKSAmJiBzZXJ2ZXIuY2FwdGlvbnNNb2RlbCAmJiBjb25maWcuY2FwdGlvbnMgPT09IHVuZGVmaW5lZCkgY29uZmlnLmNhcHRpb25zID0geyBtb2RlbDogc2VydmVyLmNhcHRpb25zTW9kZWwgfTtcbiAgLy8gQXBwbHkgZWFjaCBTZXR0aW5ncyBzaWduYWxpbmcgZmllbGQgaW5kZXBlbmRlbnRseSBmb3Igd2ViIGNvbmZpZ3MgdW5sZXNzIHNldCBpbiBEZXZlbG9wZXIgSlNPTiAvIHByZXNldC5cbiAgY29uc3Qgbm9uV2ViID0gdHlwZW9mIGdpdmVuLnBsYXRmb3JtID09PSBcInN0cmluZ1wiICYmIGdpdmVuLnBsYXRmb3JtICE9PSBcIndlYlwiO1xuICBpZiAoIW5vbldlYikge1xuICAgIGNvbnN0IHNpZ25hbGluZyA9ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwic2lnbmFsaW5nXCIpLnZhbHVlO1xuICAgIGlmIChnaXZlbi5hdHRlbnRpb24gPT09IHVuZGVmaW5lZCAmJiAoc2lnbmFsaW5nID09PSBcIndpbmRvd1wiIHx8IHNpZ25hbGluZyA9PT0gXCJlY2hvXCIpKSB7XG4gICAgICBjb25maWcuYXR0ZW50aW9uID0ge1xuICAgICAgICBtb2RlOiBcIndpbmRvd1wiLFxuICAgICAgICBhZnRlcldha2U6IG51bWJlclNldHRpbmcoXCJhdHRuLWFmdGVyLXdha2VcIiwgOCwgMSwgNjApLFxuICAgICAgICB3aW5kb3c6IG51bWJlclNldHRpbmcoXCJhdHRuLXdpbmRvd1wiLCA1LCAwLCA2MCksXG4gICAgICAgIGFmdGVyUXVlc3Rpb246IG51bWJlclNldHRpbmcoXCJhdHRuLWFmdGVyLXF1ZXN0aW9uXCIsIDEwLCAwLCA2MCksXG4gICAgICAgIGFmdGVySGFuZE9mZjogMyxcbiAgICAgICAgYWZ0ZXJBbm5vdW5jZW1lbnQ6IDAsXG4gICAgICB9O1xuICAgIH1cbiAgICBpZiAoZ2l2ZW4uaGFuZ1VwQWZ0ZXIgPT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uZmlnLmhhbmdVcEFmdGVyID0gbnVtYmVyU2V0dGluZyhcImhhbmd1cC1hZnRlclwiLCBzaWduYWxpbmcgPT09IFwiZWNob1wiID8gMTUgOiAzMDAsIDAsIDM2MDApO1xuICAgIH1cbiAgICBpZiAoc2lnbmFsaW5nID09PSBcImVjaG9cIiAmJiBnaXZlbi5zdGFuZGJ5QWZ0ZXIgPT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uZmlnLnN0YW5kYnlBZnRlciA9IDg7XG4gICAgfVxuICAgIGNvbnN0IGdpdmVuTWljID0gZ2l2ZW4ubWljICYmIHR5cGVvZiBnaXZlbi5taWMgPT09IFwib2JqZWN0XCIgPyAoZ2l2ZW4ubWljIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA6IG51bGw7XG4gICAgaWYgKCghZ2l2ZW5NaWMgfHwgZ2l2ZW5NaWMud2hpbGVTcGVha2luZyA9PT0gdW5kZWZpbmVkKSAmJiAoY2hlY2tlZChcIndha2UtYmFyZ2VcIikgfHwgc2lnbmFsaW5nID09PSBcImVjaG9cIikpIHtcbiAgICAgIGNvbmZpZy5taWMgPSB7IGdhaW5EYjogMCwgLi4uKGdpdmVuTWljID8/IHt9KSwgd2hpbGVTcGVha2luZzogXCJ3YWtlXCIgfTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGNvbmZpZztcbn1cblxuLyoqIFN0YXJ0cyBhIHZvaWNlIGNhbGwsIG9yIHdpdGggW3R5cGVkXSBhIGNoYXQgKHRoZSBjb3JlJ3MgbWVkaXVtIFwidGV4dFwiOiBubyBhdWRpbywgYSB0ZXh0IG1vZGVsKS4gKi9cbmFzeW5jIGZ1bmN0aW9uIHN0YXJ0KGNhcnJ5T24gPSBmYWxzZSwgdHlwZWQgPSBmYWxzZSk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBpZiAoc3RhcnRpbmdDYWxsIHx8IGNhbGxJZCkgcmV0dXJuIGZhbHNlO1xuICBzdGFydGluZ0NhbGwgPSB0cnVlO1xuICB0cnkge1xuICAgIGF3YWl0IGVuZGluZztcbiAgICBpZiAoY2FsbElkKSByZXR1cm4gZmFsc2U7XG4gICAgbGV0IGdpdmVuOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICB0cnkge1xuICAgICAgZ2l2ZW4gPSByZWFkQ29uZmlnKCk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICB0b2FzdChgVGhlIGRldmVsb3BlciBzZXR0aW5ncyBhcmVuJ3QgdmFsaWQgSlNPTjogJHsoZXJyIGFzIEVycm9yKS5tZXNzYWdlfWApO1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICBpZiAodHlwZWQpIHtcbiAgICAgIGlmICghc2VydmVyLnRleHRNb2RlbCkgeyB0b2FzdChcIlRoaXMgc2VydmVyIGhhcyBubyB0ZXh0IG1vZGVsIGZvciBhIGNoYXQ6IHN0YXJ0IGEgY2FsbCB0byB0eXBlIHRvIGl0XCIpOyByZXR1cm4gZmFsc2U7IH1cbiAgICAgIGdpdmVuID0geyAuLi5naXZlbiwgbWVkaXVtOiBcInRleHRcIiwgbXV0ZWQ6IGZhbHNlIH07XG4gICAgICBkZWxldGUgZ2l2ZW4uY2FwdGlvbnM7XG4gICAgfVxuICAgICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiY2FsbFwiKS5kaXNhYmxlZCA9IHRydWU7XG4gICAgJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJoZXJvLWNhbGxcIikuZGlzYWJsZWQgPSB0cnVlO1xuICAgIGlmIChcIk5vdGlmaWNhdGlvblwiIGluIHdpbmRvdyAmJiBOb3RpZmljYXRpb24ucGVybWlzc2lvbiA9PT0gXCJkZWZhdWx0XCIpIHZvaWQgTm90aWZpY2F0aW9uLnJlcXVlc3RQZXJtaXNzaW9uKCkuY2F0Y2goKCkgPT4ge30pO1xuICAgIGxldCBsb2FkZWRDb3JlOiBDb3JlO1xuICAgIHRyeSB7XG4gICAgICBpZiAoIXR5cGVkKSBhd2FpdCBhdWRpby5vcGVuKCk7XG4gICAgICBsb2FkZWRDb3JlID0gYXdhaXQgbG9hZENvcmUoKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJjYWxsXCIpLmRpc2FibGVkID0gZmFsc2U7XG4gICAgICAkPEhUTUxCdXR0b25FbGVtZW50PihcImhlcm8tY2FsbFwiKS5kaXNhYmxlZCA9IGZhbHNlO1xuICAgIH1cbiAgICBpZiAoY2FsbElkKSByZXR1cm4gZmFsc2U7XG4gICAgY29yZSA9IGxvYWRlZENvcmU7XG4gICAgaWYgKHR5cGVkKSB7XG4gICAgICB3YWtlU3RhcnRpbmcgPSBmYWxzZTtcbiAgICAgIG9wZW5pbmdDaHVua3MgPSBbXTtcbiAgICAgIG9wZW5pbmdCeXRlcyA9IDA7XG4gICAgICBpZiAod2FrZUFybWVkKSBhdWRpby5zdG9wTWljKCk7XG4gICAgfVxuICAgIG1lZGl1bSA9IHR5cGVkID8gXCJ0ZXh0XCIgOiBcInZvaWNlXCI7XG4gICAgdGhpbmtpbmcgPSBmYWxzZTtcbiAgICAkKFwidmVyc2lvblwiKS50ZXh0Q29udGVudCA9IGNvcmUudmVyc2lvbjtcbiAgICAkKFwibG9nXCIpLmlubmVySFRNTCA9IFwiXCI7XG4gICAgaWYgKCF0eXBlZCAmJiAodGFza3Muc2l6ZSA+IDAgfHwgJChcInRyYW5zY3JpcHRcIikuY2hpbGRFbGVtZW50Q291bnQgPiAxKSkgbm90ZShgTmV3IGNhbGwgXHUwMEI3ICR7bmV3IERhdGUoKS50b0xvY2FsZVRpbWVTdHJpbmcoKX1gKTtcbiAgICBzY3JvbGxEb3duKHRydWUpO1xuICAgIHRhc2tzLmNsZWFyKCk7XG4gICAgYWN0aXZlU2Vzc2lvbiA9ICsrc2Vzc2lvblNlcTtcbiAgICBzaG93VGFza3MoKTtcbiAgICBjb3VudHMgPSB7IG1pYzogMCwgcGxheTogMCwgc2VudDogMCB9O1xuICAgIG1ldHJpY3MucmVwbHkgPSBbXTtcbiAgICBzdGFydGVkQXQgPSBub3coKTtcbiAgICBtdXRlZCA9IGdpdmVuLm11dGVkID09PSB0cnVlO1xuICAgIGNvbnN0IG1pY0NmZyA9IGdpdmVuLm1pYyAmJiB0eXBlb2YgZ2l2ZW4ubWljID09PSBcIm9iamVjdFwiID8gKGdpdmVuLm1pYyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgOiBudWxsO1xuICAgIGNhbGxXaGlsZVNwZWFraW5nID0gdHlwZW9mIG1pY0NmZz8ud2hpbGVTcGVha2luZyA9PT0gXCJzdHJpbmdcIiA/IG1pY0NmZy53aGlsZVNwZWFraW5nIDogXCJzZW5kXCI7XG4gICAgY29yZVNwZWVjaFVudGlsID0gMDtcbiAgICBkZWZlcnJlZE1pYyA9IFtdO1xuICAgIHdha2VQZXJpb2RDYWxsSWQgPSBudWxsO1xuICAgIHdha2VDbGllbnQucmVzZXQoKTtcbiAgICAvLyBDYXJyeWluZyBvbjogdGhlIG1vZGVsIGdldHMgdGhlIGxhc3QgY29udmVyc2F0aW9uIGFzIGEgcmVjYXAuIFRoZSBjb3JlIGNhcHMgaXQsIGxhdGVzdCBsaW5lcyBmaXJzdC5cbiAgICAvLyBBIGNoYXQgYWx3YXlzIGNhcnJpZXMgb24gZnJvbSB3aGF0J3Mgb24gdGhlIHNjcmVlbiAoYW4gZWFybGllciBjYWxsIG9yIGNoYXQgb24gdGhpcyBwYWdlKS5cbiAgICBpZiAodHlwZWQpIHsgaWYgKGNoYXQubGVuZ3RoID4gMCAmJiBnaXZlbi5oaXN0b3J5ID09PSB1bmRlZmluZWQpIGdpdmVuLmhpc3RvcnkgPSBjaGF0OyB9XG4gICAgZWxzZSBpZiAoY2FycnlPbiAmJiBnaXZlbi5oaXN0b3J5ID09PSB1bmRlZmluZWQpIGdpdmVuLmhpc3RvcnkgPSBzYXZlZEhpc3RvcnkoKTtcbiAgICBlbHNlIGlmICghY2FycnlPbikgY2hhdCA9IFtdO1xuICAgIGlmIChjYXJyeU9uICYmICF0eXBlZCkgY2hhdCA9IHNhdmVkSGlzdG9yeSgpO1xuICAgIGxhc3RMaW5lID0gbnVsbDtcbiAgICBvcGVuTGluZSA9IG51bGw7XG4gICAgc3luY1Jlc3VtZUJ1dHRvbnMoZmFsc2UpO1xuICAgIGNhbGxOYW1lID0gYCR7bmV3IERhdGUoKS50b0lTT1N0cmluZygpLnJlcGxhY2UoL1s6Ll0vZywgXCItXCIpfS0ke3R5cGVkID8gXCJjaGF0XCIgOiBcIndlYlwifS0ke2NvcmUudmVyc2lvbn1gO1xuICAgIGNvbnN0IGNyZWF0ZWQgPSBKU09OLnBhcnNlKGNvcmUuY3JlYXRlKEpTT04uc3RyaW5naWZ5KGdpdmVuKSwgbm93KCkpKTtcbiAgICBjYWxsSWQgPSBjcmVhdGVkLmlkO1xuICAgIGlmICghdHlwZWQpIHtcbiAgICAgIHNldENhbGxCdXR0b24odHJ1ZSk7XG4gICAgICAkPEhUTUxCdXR0b25FbGVtZW50PihcIm1pY1wiKS5kaXNhYmxlZCA9IGZhbHNlO1xuICAgIH1cbiAgICAkPEhUTUxCdXR0b25FbGVtZW50PihcImh1c2hcIikuZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAkKFwibWljXCIpLmNsYXNzTGlzdC50b2dnbGUoXCJtdXRlZFwiLCBtdXRlZCk7XG4gICAgcnVuKGNyZWF0ZWQuY29tbWFuZHMpO1xuICAgIHNob3dTdGF0dXMoKTtcbiAgICB0aWNrZXIgPSB3aW5kb3cuc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgICAgcHVzaCh7IHR5cGU6IFwidGlja1wiIH0pO1xuICAgICAgY29uc3QgbGV2ZWwgPSBtdXRlZCAmJiAhaG9sZGluZyA/IDAgOiBhdWRpby5sZXZlbDtcbiAgICAgIGNvbnN0IHN0cmVuZ3RoID0gTWF0aC5taW4oMSwgbGV2ZWwgKiAxMik7XG4gICAgICAkKFwicmluZ1wiKS5zdHlsZS5vcGFjaXR5ID0gU3RyaW5nKHN0cmVuZ3RoKTtcbiAgICAgICQoXCJyaW5nXCIpLnN0eWxlLnRyYW5zZm9ybSA9IGBzY2FsZSgkeygxICsgc3RyZW5ndGggKiAwLjEyKS50b0ZpeGVkKDMpfSlgO1xuICAgICAgJChcImNvdW50c1wiKS50ZXh0Q29udGVudCA9IGBtaWMgJHtjb3VudHMubWljfSBcdTAwQjcgc2VudCAke2NvdW50cy5zZW50fSBcdTAwQjcgcGxheWVkICR7Y291bnRzLnBsYXl9IFx1MDBCNyBxdWV1ZWQgJHthdWRpby5xdWV1ZWQudG9GaXhlZCgxKX0gc2A7XG4gICAgICBzaG93U3RhdHVzKCk7XG4gICAgfSwgMTAwKTtcbiAgICB0cmFjZVRpbWVyID0gd2luZG93LnNldEludGVydmFsKCgpID0+IHsgdm9pZCBzYXZlVHJhY2UoKTsgdm9pZCBwaW5nKCk7IHNob3dUYXNrcygpOyB9LCA1MDAwKTtcbiAgICB2b2lkIHBpbmcoKTtcbiAgICBpZiAoIXR5cGVkKSB7XG4gICAgICBzdG9wV29yZHMuc3RhcnQoKTtcbiAgICAgIGF3YWl0IGFjcXVpcmVXYWtlTG9jaygpO1xuICAgIH1cbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSBmaW5hbGx5IHtcbiAgICBzdGFydGluZ0NhbGwgPSBmYWxzZTtcbiAgfVxufVxuXG4vKiogVGhlIENhbGwgYnV0dG9uOiBoYW5ncyB1cCBhIGNhbGw7IHN0YXJ0cyBvbmU7IG9yLCB3aXRoIGEgY2hhdCBvbiwgZW5kcyB0aGUgY2hhdCBhbmQgY2FycmllcyBpdHMgY29udmVyc2F0aW9uIG9uIGJ5IHZvaWNlLiAqL1xuYXN5bmMgZnVuY3Rpb24gY2FsbEJ1dHRvbigpIHtcbiAgaWYgKGNhbGxJZCAmJiBtZWRpdW0gPT09IFwidm9pY2VcIikgeyBoYW5nVXAoKTsgcmV0dXJuOyB9XG4gIGlmIChjYWxsSWQpIHtcbiAgICAvLyBBIGNhbGwgY2FuJ3QgdGFrZSBvdmVyIHRoZSBjaGF0J3MgdGFza3MsIGFuZCBlbmRpbmcgdGhlIGNoYXQgd291bGQgc3RvcCB0aGVtLlxuICAgIGlmIChbLi4udGFza3MudmFsdWVzKCldLnNvbWUoKHYpID0+IHYuYy5zdGF0ZSA9PT0gXCJydW5uaW5nXCIpKSB7IHRvYXN0KFwiVGhlIGNoYXQncyB0YXNrcyBhcmUgc3RpbGwgcnVubmluZzogd2FpdCBmb3IgdGhlbSBvciBjYW5jZWwgdGhlbSwgdGhlbiBjYWxsXCIpOyByZXR1cm47IH1cbiAgICBwdXNoKHsgdHlwZTogXCJzdG9wXCIgfSk7XG4gICAgYXdhaXQgc3RhcnQodHJ1ZSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGF3YWl0IHN0YXJ0KCk7XG59XG5cbmZ1bmN0aW9uIGhhbmdVcCgpIHtcbiAgaWYgKGNhbGxJZCkgcHVzaCh7IHR5cGU6IFwic3RvcFwiLCBtZXNzYWdlOiBcIllvdSBodW5nIHVwLlwiIH0pO1xufVxuXG5mdW5jdGlvbiBlbmQoKSB7XG4gIHdpbmRvdy5jbGVhckludGVydmFsKHRpY2tlcik7XG4gIHdpbmRvdy5jbGVhckludGVydmFsKHRyYWNlVGltZXIpO1xuICBzdG9wV29yZHMuc3RvcCgpO1xuICBhY3RpdmVTZXNzaW9uID0gMDtcbiAgc3luY1Jlc3VsdEZvbGxvd1VwQnV0dG9ucygpO1xuICBjb3JlV2FudHNXYWtlID0gZmFsc2U7XG4gIGNvcmVTcGVlY2hVbnRpbCA9IDA7XG4gIGRlZmVycmVkTWljID0gW107XG4gIHdha2VQZXJpb2RDYWxsSWQgPSB3YWtlQXJtZWQgPyAwIDogbnVsbDtcbiAgd2FrZVN0YXJ0aW5nID0gZmFsc2U7XG4gIG9wZW5pbmdDaHVua3MgPSBbXTtcbiAgb3BlbmluZ0J5dGVzID0gMDtcbiAgY29uc3QgZmluaXNoZWRJZCA9IGNhbGxJZDtcbiAgY29uc3QgZmluaXNoZWRDb3JlID0gY29yZTtcbiAgY2FsbElkID0gMDtcbiAgZW5kaW5nID0gc2F2ZVRyYWNlKGZpbmlzaGVkSWQsIGZpbmlzaGVkQ29yZSkudGhlbigoKSA9PiB7IGlmIChmaW5pc2hlZENvcmUgJiYgZmluaXNoZWRJZCkgZmluaXNoZWRDb3JlLmRpc3Bvc2UoZmluaXNoZWRJZCk7IHNob3dUYXNrcygpOyBzeW5jV2FrZVVpKCk7IH0pO1xuICBpZiAod2FrZUFybWVkKSB7XG4gICAgYXVkaW8uc3RvcFBsYXliYWNrKCk7XG4gICAgd2FrZUNsaWVudC5yZXNldCgpO1xuICAgIHZvaWQgYXVkaW8uZW5zdXJlTWljKG9uTWljLCBtaWNPcHRpb25zKCkpLmNhdGNoKChlcnIpID0+IHtcbiAgICAgIGxvZyhcImVycm9yXCIsIGB3YWtlIG1pY3JvcGhvbmU6ICR7ZXJyLm1lc3NhZ2V9YCwgXCJlcnJcIik7XG4gICAgICB0b2FzdChgV2FrZSBtaWNyb3Bob25lOiAke2Vyci5tZXNzYWdlfWApO1xuICAgICAgdm9pZCBhcm1XYWtlKGZhbHNlKTtcbiAgICB9KTtcbiAgfSBlbHNlIHtcbiAgICBhdWRpby5zdG9wKCk7XG4gICAgcmVsZWFzZVdha2VMb2NrKCk7XG4gIH1cbiAgZm9yIChjb25zdCB3cyBvZiBzb2NrZXRzLnZhbHVlcygpKSB3cy5jbG9zZSgpO1xuICBzb2NrZXRzLmNsZWFyKCk7XG4gIGZvciAoY29uc3QgciBvZiBydW5zLnZhbHVlcygpKSByLmFib3J0LmFib3J0KCk7XG4gIHJ1bnMuY2xlYXIoKTtcbiAgZm9yIChjb25zdCByIG9mIHJlcXVlc3RzLnZhbHVlcygpKSByLmFib3J0KCk7XG4gIHJlcXVlc3RzLmNsZWFyKCk7XG4gIHRoaW5raW5nID0gZmFsc2U7XG4gIHNldENhbGxCdXR0b24oZmFsc2UpO1xuICBmb3IgKGNvbnN0IGlkIG9mIFtcIm1pY1wiLCBcImh1c2hcIl0pICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KGlkKS5kaXNhYmxlZCA9IHRydWU7XG4gICQoXCJyaW5nXCIpLnN0eWxlLm9wYWNpdHkgPSBcIjBcIjtcbiAgJChcInJpbmdcIikuc3R5bGUudHJhbnNmb3JtID0gXCJcIjtcbiAgJChcImNhbGxiYXJcIikuaGlkZGVuID0gdHJ1ZTtcbiAgJChcIm1pY3dhcm5cIikuaGlkZGVuID0gdHJ1ZTtcbiAgZG9jdW1lbnQuYm9keS5kYXRhc2V0LnN0YXRlID0gd2FrZUFybWVkID8gXCJhcm1lZFwiIDogXCJpZGxlXCI7XG4gIGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LnJlbW92ZShcImluLXNlc3Npb25cIik7XG4gIHN5bmNSZXN1bWVCdXR0b25zKGNoYXQubGVuZ3RoID4gMCk7XG4gIHZvaWQgc2hvd0VhcmxpZXIoKTtcbiAgc3luY1dha2VVaSgpO1xufVxuXG5mdW5jdGlvbiBzZXRNdXRlZCh2YWx1ZTogYm9vbGVhbikge1xuICBpZiAoIWNhbGxJZCB8fCBtdXRlZCA9PT0gdmFsdWUpIHJldHVybjtcbiAgbXV0ZWQgPSB2YWx1ZTtcbiAgaWYgKG11dGVkKSB7XG4gICAgZmx1c2hEZWZlcnJlZE1pYygpO1xuICAgIHdha2VDbGllbnQucmVzZXQoKTtcbiAgfVxuICAkKFwibWljXCIpLmNsYXNzTGlzdC50b2dnbGUoXCJtdXRlZFwiLCBtdXRlZCk7XG4gIHB1c2goeyB0eXBlOiBtdXRlZCA/IFwibXV0ZVwiIDogXCJ1bm11dGVcIiB9KTtcbiAgc2hvd1N0YXR1cygpO1xufVxuXG4vKiogU2VuZHMgd2hhdCB0aGUgdHJhY2Uga2VwdCBzaW5jZSBsYXN0IHRpbWUgdG8gdGhlIGRldiBzZXJ2ZXIsIGFzIEpTT04gbGluZXM6IGEgaGVhZGVyLCB0aGVuIGV2ZW50cy4gKi9cbmFzeW5jIGZ1bmN0aW9uIHNhdmVUcmFjZShpZCA9IGNhbGxJZCwgdGFyZ2V0Q29yZSA9IGNvcmUpIHtcbiAgaWYgKCF0YXJnZXRDb3JlIHx8ICFpZCB8fCAhY2hlY2tlZChcInRyYWNlXCIpKSByZXR1cm47XG4gIGNvbnN0IGtlcHQgPSBKU09OLnBhcnNlKHRhcmdldENvcmUudHJhY2UoaWQpKTtcbiAgaWYgKCFrZXB0KSByZXR1cm47XG4gIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICBpZiAoa2VwdC5jb25maWcpIGxpbmVzLnB1c2goSlNPTi5zdHJpbmdpZnkoeyB2ZXJzaW9uOiBrZXB0LnZlcnNpb24sIGNvbmZpZzoga2VwdC5jb25maWcsIHN0YXJ0OiBrZXB0LnN0YXJ0IH0pKTtcbiAgZm9yIChjb25zdCBlIG9mIGtlcHQuZXZlbnRzKSBsaW5lcy5wdXNoKEpTT04uc3RyaW5naWZ5KGUpKTtcbiAgaWYgKGxpbmVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuICBhd2FpdCBmZXRjaChgL3RyYWNlcz9uYW1lPSR7ZW5jb2RlVVJJQ29tcG9uZW50KGNhbGxOYW1lKX0uanNvbmxgLCB7IG1ldGhvZDogXCJQT1NUXCIsIGJvZHk6IGxpbmVzLmpvaW4oXCJcXG5cIikgKyBcIlxcblwiIH0pLmNhdGNoKCgpID0+IHt9KTtcbiAgJChcInRyYWNlbmFtZVwiKS50ZXh0Q29udGVudCA9IGB0cmFjZSAke2NhbGxOYW1lfS5qc29ubGA7XG59XG5cbi8vIFwiU3RvcFwiIGFuZCBcImdvb2RieWVcIiBoZWFyZCBieSB0aGUgYnJvd3NlcidzIG93biByZWNvZ25pemVyOiBxdWlja2VyIHRoYW4gdGhlIG1vZGVsJ3MgdHJhbnNjcmlwdCxcbi8vIGFuZCBpdCB3b3JrcyB3aGlsZSB0aGUgbW9kZWwncyByZXBseSBwbGF5cyBldmVuIHdoZW4gdGhlIG1vZGVsIGlzbid0IGhlYXJpbmcgdGhlIG1pY3JvcGhvbmUuXG5cbmNsYXNzIFN0b3BXb3JkcyB7XG4gIHByaXZhdGUgcmVjOiBhbnkgPSBudWxsO1xuICBwcml2YXRlIG9uID0gZmFsc2U7XG4gIHByaXZhdGUgY29tbWFuZHMgPSB7IHN0b3A6IFtdIGFzIHN0cmluZ1tdLCBoYW5nVXA6IFtdIGFzIHN0cmluZ1tdLCBjYW5jZWxBbGw6IFtdIGFzIHN0cmluZ1tdIH07XG5cbiAgZ2V0IHN1cHBvcnRlZCgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gXCJ3ZWJraXRTcGVlY2hSZWNvZ25pdGlvblwiIGluIHdpbmRvdyB8fCBcIlNwZWVjaFJlY29nbml0aW9uXCIgaW4gd2luZG93O1xuICB9XG5cbiAgc3RhcnQoKSB7XG4gICAgaWYgKCFjaGVja2VkKFwic3RvcHdvcmRcIikgfHwgIXRoaXMuc3VwcG9ydGVkIHx8ICFjb3JlKSByZXR1cm47XG4gICAgdGhpcy5jb21tYW5kcyA9IEpTT04ucGFyc2UoY29yZS5kZWZhdWx0cygpKS52b2ljZUNvbW1hbmRzO1xuICAgIGNvbnN0IFJlY29nbml0aW9uID0gKHdpbmRvdyBhcyBhbnkpLlNwZWVjaFJlY29nbml0aW9uID8/ICh3aW5kb3cgYXMgYW55KS53ZWJraXRTcGVlY2hSZWNvZ25pdGlvbjtcbiAgICB0aGlzLnJlYyA9IG5ldyBSZWNvZ25pdGlvbigpO1xuICAgIHRoaXMucmVjLmNvbnRpbnVvdXMgPSB0cnVlO1xuICAgIHRoaXMucmVjLmludGVyaW1SZXN1bHRzID0gdHJ1ZTtcbiAgICB0aGlzLnJlYy5sYW5nID0gbmF2aWdhdG9yLmxhbmd1YWdlIHx8IFwiZW4tR0JcIjtcbiAgICB0aGlzLnJlYy5vbnJlc3VsdCA9IChlOiBhbnkpID0+IHtcbiAgICAgIGZvciAobGV0IGkgPSBlLnJlc3VsdEluZGV4OyBpIDwgZS5yZXN1bHRzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIGNvbnN0IHRleHQgPSBlLnJlc3VsdHNbaV1bMF0udHJhbnNjcmlwdCBhcyBzdHJpbmc7XG4gICAgICAgIGNvbnN0IGNvbW1hbmQgPSBjb21tYW5kSW4odGV4dCwgdGhpcy5jb21tYW5kcywgW1wiV29vZGhvdXNlXCIsIFwiSGVybWVzXCIsIFwiQmVudG9cIl0pO1xuICAgICAgICBpZiAoY29tbWFuZCA9PT0gXCJzdG9wXCIgJiYgYXVkaW8ucXVldWVkID4gMC4wNSkge1xuICAgICAgICAgIGxvZyhcIm91dFwiLCBgbG9jYWwgc3RvcCB3b3JkOiAke3RleHR9YCwgXCJvdXRcIik7XG4gICAgICAgICAgdG9hc3QoYEhlYXJkIFx1MjAxQyR7dGV4dC50cmltKCl9XHUyMDFEOiBzdG9wcGVkYCk7XG4gICAgICAgICAgcHVzaCh7IHR5cGU6IFwiaW50ZXJydXB0XCIgfSk7XG4gICAgICAgIH0gZWxzZSBpZiAoY29tbWFuZCA9PT0gXCJjYW5jZWxBbGxcIiAmJiBlLnJlc3VsdHNbaV0uaXNGaW5hbCkge1xuICAgICAgICAgIGxvZyhcIm91dFwiLCBgbG9jYWwgY2FuY2VsLWFsbDogJHt0ZXh0fWAsIFwib3V0XCIpO1xuICAgICAgICAgIHB1c2goeyB0eXBlOiBcImNhbmNlbEFsbFwiIH0pO1xuICAgICAgICAgIHB1c2goeyB0eXBlOiBcImludGVycnVwdFwiIH0pO1xuICAgICAgICB9IGVsc2UgaWYgKGNvbW1hbmQgPT09IFwiaGFuZ1VwXCIgJiYgZS5yZXN1bHRzW2ldLmlzRmluYWwpIHtcbiAgICAgICAgICBsb2coXCJvdXRcIiwgYGxvY2FsIGhhbmctdXA6ICR7dGV4dH1gLCBcIm91dFwiKTtcbiAgICAgICAgICBoYW5nVXAoKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH07XG4gICAgdGhpcy5yZWMub25lbmQgPSAoKSA9PiB7IGlmICh0aGlzLm9uKSBzZXRUaW1lb3V0KCgpID0+IHsgdHJ5IHsgdGhpcy5yZWM/LnN0YXJ0KCk7IH0gY2F0Y2gge30gfSwgMjUwKTsgfTtcbiAgICB0aGlzLnJlYy5vbmVycm9yID0gKGU6IGFueSkgPT4geyBpZiAoZS5lcnJvciA9PT0gXCJub3QtYWxsb3dlZFwiKSB0aGlzLm9uID0gZmFsc2U7IH07XG4gICAgdGhpcy5vbiA9IHRydWU7XG4gICAgdHJ5IHsgdGhpcy5yZWMuc3RhcnQoKTsgfSBjYXRjaCB7fVxuICB9XG5cbiAgc3RvcCgpIHtcbiAgICB0aGlzLm9uID0gZmFsc2U7XG4gICAgdHJ5IHsgdGhpcy5yZWM/LnN0b3AoKTsgfSBjYXRjaCB7fVxuICAgIHRoaXMucmVjID0gbnVsbDtcbiAgfVxufVxuY29uc3Qgc3RvcFdvcmRzID0gbmV3IFN0b3BXb3JkcygpO1xuXG4vLyBMb2NhbCB3YWtlIHdvcmQgbG9vcCAoTGl2ZUtpdCBXYWtlV29yZCBPTk5YIGluIGEgV2ViIFdvcmtlcik6IGxpc3RlbnMgYmV0d2VlbiBjYWxscyB3aGVuIGFybWVkLFxuLy8gYW5kIGluc2lkZSBhbiBhY3RpdmUgY2FsbCB3aGVuZXZlciB0aGUgY29yZSBhc2tzIChgd2FrZXdvcmQ6IG9uYDogZG9ybWFudCBvciB3aGlsZVNwZWFraW5nIFwid2FrZVwiKS5cblxuYXN5bmMgZnVuY3Rpb24gYWNxdWlyZVdha2VMb2NrKCkge1xuICBhd2FpdCBzY3JlZW5XYWtlTG9jay5hY3F1aXJlKCgpID0+ICFkb2N1bWVudC5oaWRkZW4gJiYgKGNhbGxJZCAhPT0gMCB8fCB3YWtlQXJtZWQpKTtcbn1cblxuZnVuY3Rpb24gcmVsZWFzZVdha2VMb2NrKCkge1xuICBzY3JlZW5XYWtlTG9jay5yZWxlYXNlKCk7XG59XG5cbmZ1bmN0aW9uIHNlbGVjdGVkV2FrZU1vZGVsKCk6IFdha2VNb2RlbEluZm8gfCBudWxsIHtcbiAgY29uc3QgbW9kZWxzID0gc2VydmVyPy53YWtlTW9kZWxzID8/IFtdO1xuICBpZiAobW9kZWxzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHBpY2sgPSAkPEhUTUxTZWxlY3RFbGVtZW50PihcIndha2UtbW9kZWxcIikudmFsdWU7XG4gIHJldHVybiBtb2RlbHMuZmluZCgobSkgPT4gbS5pZCA9PT0gcGljaykgPz8gbW9kZWxzLmZpbmQoKG0pID0+IG0uaWQgPT09IFwicGVubnl3b3J0aFwiKSA/PyBtb2RlbHNbMF07XG59XG5cbmZ1bmN0aW9uIHdha2VUaHJlc2hvbGQoKTogbnVtYmVyIHtcbiAgY29uc3QgbiA9IE51bWJlcigkPEhUTUxJbnB1dEVsZW1lbnQ+KFwid2FrZS10aHJlc2hvbGRcIikudmFsdWUpO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pID8gTWF0aC5tYXgoMC4xLCBNYXRoLm1pbigwLjk5LCBuKSkgOiAwLjc7XG59XG5cbmZ1bmN0aW9uIHNob3VsZEZlZWRXYWtlKCk6IGJvb2xlYW4ge1xuICBpZiAod2FrZVN0YXJ0aW5nIHx8IHN0YXJ0aW5nQ2FsbCkgcmV0dXJuIGZhbHNlO1xuICBpZiAoY2FsbElkID09PSAwKSByZXR1cm4gd2FrZUFybWVkO1xuICByZXR1cm4gbWVkaXVtID09PSBcInZvaWNlXCIgJiYgY29yZVdhbnRzV2FrZSAmJiAhKG11dGVkICYmICFob2xkaW5nKTtcbn1cblxuLyoqXG4gKiBXaGV0aGVyIGEgd2FrZSBkZXRlY3Rpb24gcmV0dXJuaW5nIGFzeW5jaHJvbm91c2x5IGZyb20gdGhlIHdvcmtlciBzdGlsbCBiZWxvbmdzIHRvIHRoZSBhY3RpdmVcbiAqIGxpc3RlbmluZyBwZXJpb2QuIFVubGlrZSBgc2hvdWxkRmVlZFdha2UoKWAsIHRoaXMgc3RheXMgdHJ1ZSBmb3IgYW4gYWN0aXZlIHZvaWNlIGNhbGwgZXZlbiBpZlxuICogYGNvcmVXYW50c1dha2VgIGp1c3QgZmxpcHBlZCBvZmYgYXMgcGxheWJhY2sgZW5kZWQgd2hpbGUgdGhlIHdvcmtlciB3YXMgc2NvcmluZyB0aGUgbGFzdCBmcmFtZS5cbiAqL1xuZnVuY3Rpb24gY2FuQWNjZXB0V2FrZUhpdCgpOiBib29sZWFuIHtcbiAgaWYgKHdha2VTdGFydGluZyB8fCBzdGFydGluZ0NhbGwpIHJldHVybiBmYWxzZTtcbiAgaWYgKGNhbGxJZCA9PT0gMCkgcmV0dXJuIHdha2VBcm1lZCAmJiB3YWtlUGVyaW9kQ2FsbElkID09PSAwO1xuICByZXR1cm4gbWVkaXVtID09PSBcInZvaWNlXCIgJiYgIShtdXRlZCAmJiAhaG9sZGluZykgJiYgd2FrZVBlcmlvZENhbGxJZCA9PT0gY2FsbElkO1xufVxuXG5mdW5jdGlvbiByZW5kZXJXYWtlVGVsZW1ldHJ5KCkge1xuICBjb25zdCBhY3RpdmUgPSAoY2FsbElkID09PSAwICYmIHdha2VBcm1lZCkgfHwgKGNhbGxJZCAhPT0gMCAmJiBtZWRpdW0gPT09IFwidm9pY2VcIiAmJiBjb3JlV2FudHNXYWtlKTtcbiAgaWYgKCFhY3RpdmUpIHsgJChcImhlYXJkXCIpLnRleHRDb250ZW50ID0gXCJcIjsgcmV0dXJuOyB9XG4gIGNvbnN0IGxhYmVsID0gc2VsZWN0ZWRXYWtlTW9kZWwoKT8ubGFiZWwgPz8gXCJ3YWtlIHdvcmRcIjtcbiAgaWYgKHdha2VMb2FkaW5nKSB7ICQoXCJoZWFyZFwiKS50ZXh0Q29udGVudCA9IGBMb2FkaW5nIHdha2Ugd29yZCBcdTIwMUMke2xhYmVsfVx1MjAxRFx1MjAyNmA7IHJldHVybjsgfVxuICBpZiAoY2FsbElkID09PSAwICYmIGF1ZGlvLmF1ZGlvU3VzcGVuZGVkKSB7ICQoXCJoZWFyZFwiKS50ZXh0Q29udGVudCA9IGBBdWRpbyBwYXVzZWQgYnkgYnJvd3NlciBcdTAwQjcgdGFwIG9yIHByZXNzIGEga2V5IHRvIHJlc3VtZSBcdTIwMUMke2xhYmVsfVx1MjAxRGA7IHJldHVybjsgfVxuICBpZiAoIXdha2VMYXN0VGVsKSB7ICQoXCJoZWFyZFwiKS50ZXh0Q29udGVudCA9IGBXYWtlIFx1MjAxQyR7bGFiZWx9XHUyMDFEIHJlYWR5ICh0aHJlc2hvbGQgJHt3YWtlVGhyZXNob2xkKCkudG9GaXhlZCgyKX0pYDsgcmV0dXJuOyB9XG4gIGNvbnN0IHN0YXRlID0gd2FrZUxhc3RUZWwuZ2F0ZU9wZW4gPyBgc2NvcmluZyAke3dha2VMYXN0VGVsLnNjb3JlLnRvRml4ZWQoMil9YCA6IFwicXVpZXRcIjtcbiAgY29uc3Qgc3BlZWQgPSB3YWtlTGFzdFRlbC5pbmZlck1zID4gMCA/IGAgXHUwMEI3ICR7d2FrZUxhc3RUZWwuaW5mZXJNcy50b0ZpeGVkKDEpfSBtc2AgOiBcIlwiO1xuICAkKFwiaGVhcmRcIikudGV4dENvbnRlbnQgPSBgV2FrZSBcdTIwMUMke2xhYmVsfVx1MjAxRCBcdTAwQjcgJHtzdGF0ZX0gXHUwMEI3IHBlYWsgJHt3YWtlTGFzdFRlbC5wZWFrLnRvRml4ZWQoMil9JHtzcGVlZH1gO1xufVxuXG5mdW5jdGlvbiBzeW5jV2FrZVVpKCkge1xuICBjb25zdCBtb2RlbCA9IHNlbGVjdGVkV2FrZU1vZGVsKCk7XG4gIGNvbnN0IGhhc01vZGVscyA9IG1vZGVsICE9IG51bGw7XG4gIGNvbnN0IGxhYmVsID0gbW9kZWw/LmxhYmVsID8/IFwid2FrZSB3b3JkXCI7XG4gIGNvbnN0IGJ0biA9ICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwid2FrZWJ0blwiKTtcbiAgYnRuLmhpZGRlbiA9ICFoYXNNb2RlbHM7XG4gIGJ0bi5jbGFzc0xpc3QudG9nZ2xlKFwib25cIiwgd2FrZUFybWVkKTtcbiAgYnRuLmNsYXNzTGlzdC50b2dnbGUoXCJsb2FkaW5nXCIsIHdha2VMb2FkaW5nICYmICh3YWtlQXJtZWQgfHwgY29yZVdhbnRzV2FrZSkpO1xuICBidG4uc2V0QXR0cmlidXRlKFwiYXJpYS1wcmVzc2VkXCIsIFN0cmluZyh3YWtlQXJtZWQpKTtcbiAgYnRuLnRpdGxlID0gd2FrZUFybWVkID8gYFN0b3Agd2FrZSB3b3JkIFx1MjAxQyR7bGFiZWx9XHUyMDFEIChXKWAgOiBgTGlzdGVuIGZvciBcdTIwMUMke2xhYmVsfVx1MjAxRCAoVylgO1xuICBjb25zdCBoZXJvID0gJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJoZXJvLXdha2VcIik7XG4gIGhlcm8uaGlkZGVuID0gIWhhc01vZGVscztcbiAgaGVyby5jbGFzc0xpc3QudG9nZ2xlKFwib25cIiwgd2FrZUFybWVkKTtcbiAgaGVyby50ZXh0Q29udGVudCA9IHdha2VBcm1lZFxuICAgID8gKHdha2VMb2FkaW5nID8gYExvYWRpbmcgXHUyMDFDJHtsYWJlbH1cdTIwMURcdTIwMjZgIDogYXVkaW8uYXVkaW9TdXNwZW5kZWQgPyBgQWN0aXZhdGUgXHUyMDFDJHtsYWJlbH1cdTIwMURgIDogYExpc3RlbmluZyBmb3IgXHUyMDFDJHtsYWJlbH1cdTIwMURgKVxuICAgIDogYExpc3RlbiBmb3IgXHUyMDFDJHtsYWJlbH1cdTIwMURgO1xuICAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwid2FrZS1lbmFibGVkXCIpLmNoZWNrZWQgPSB3YWtlQXJtZWQ7XG4gIHJlbmRlcldha2VUZWxlbWV0cnkoKTtcbiAgc2hvd1N0YXR1cygpO1xufVxuXG5mdW5jdGlvbiBzeW5jU2lnbmFsaW5nVWkoKSB7XG4gIGNvbnN0IG92ID0gZGV2ZWxvcGVyT3ZlcnJpZGVzKCk7XG4gIGNvbnN0IHNpZ25hbGluZ0VsID0gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJzaWduYWxpbmdcIik7XG4gIGNvbnN0IHNpZ25hbGluZyA9IHNpZ25hbGluZ0VsLnZhbHVlO1xuICBjb25zdCBub25XZWIgPSBvdi5ub25XZWJQbGF0Zm9ybSAhPSBudWxsO1xuICBzaWduYWxpbmdFbC5kaXNhYmxlZCA9IG5vbldlYiB8fCBvdi5oYXNBdHRlbnRpb247XG4gIGNvbnN0IHdpbmRvd0NvbnRyb2xzID0gIW5vbldlYiAmJiAhb3YuaGFzQXR0ZW50aW9uICYmIChzaWduYWxpbmcgPT09IFwid2luZG93XCIgfHwgc2lnbmFsaW5nID09PSBcImVjaG9cIik7XG4gIGZvciAoY29uc3QgaWQgb2YgW1wiYXR0bi1hZnRlci13YWtlXCIsIFwiYXR0bi13aW5kb3dcIiwgXCJhdHRuLWFmdGVyLXF1ZXN0aW9uXCJdKSB7XG4gICAgJDxIVE1MSW5wdXRFbGVtZW50PihpZCkuZGlzYWJsZWQgPSAhd2luZG93Q29udHJvbHM7XG4gIH1cbiAgJDxIVE1MSW5wdXRFbGVtZW50PihcImhhbmd1cC1hZnRlclwiKS5kaXNhYmxlZCA9IG5vbldlYiB8fCBvdi5oYXNIYW5nVXA7XG4gIGNvbnN0IGJhcmdlID0gJDxIVE1MSW5wdXRFbGVtZW50PihcIndha2UtYmFyZ2VcIik7XG4gIGlmIChub25XZWIgfHwgb3YuaGFzTWljV2hpbGVTcGVha2luZykge1xuICAgIGJhcmdlLmRpc2FibGVkID0gdHJ1ZTtcbiAgfSBlbHNlIGlmIChzaWduYWxpbmcgPT09IFwiZWNob1wiKSB7XG4gICAgYmFyZ2UuY2hlY2tlZCA9IHRydWU7XG4gICAgYmFyZ2UuZGlzYWJsZWQgPSB0cnVlO1xuICB9IGVsc2Uge1xuICAgIGJhcmdlLmRpc2FibGVkID0gZmFsc2U7XG4gICAgYmFyZ2UuY2hlY2tlZCA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2Uud2FrZS1iYXJnZVwiKSA9PT0gXCIxXCI7XG4gIH1cbiAgY29uc3Qgb3ZlcnJpZGRlbjogc3RyaW5nW10gPSBbXTtcbiAgaWYgKG92Lmhhc0F0dGVudGlvbikgb3ZlcnJpZGRlbi5wdXNoKFwiYXR0ZW50aW9uXCIpO1xuICBpZiAob3YuaGFzSGFuZ1VwKSBvdmVycmlkZGVuLnB1c2goXCJoYW5nVXBBZnRlclwiKTtcbiAgaWYgKG92Lmhhc01pY1doaWxlU3BlYWtpbmcpIG92ZXJyaWRkZW4ucHVzaChcIm1pYy53aGlsZVNwZWFraW5nXCIpO1xuICBjb25zdCBoYXNNb2RlbHMgPSAoc2VydmVyPy53YWtlTW9kZWxzPy5sZW5ndGggPz8gMCkgPiAwO1xuICAkKFwic2lnbmFsaW5nLWhlbHBcIikudGV4dENvbnRlbnQgPSBub25XZWJcbiAgICA/IGBEZXZlbG9wZXIgcHJlc2V0ICgke292Lm5vbldlYlBsYXRmb3JtfSkgY29udHJvbHMgc2lnbmFsaW5nLmBcbiAgICA6IG92ZXJyaWRkZW4ubGVuZ3RoID4gMFxuICAgICAgPyBgRGV2ZWxvcGVyIGNvbmZpZyBzZXRzICR7b3ZlcnJpZGRlbi5qb2luKFwiLCBcIil9LmBcbiAgICAgIDogIWhhc01vZGVscyAmJiBzaWduYWxpbmcgIT09IFwib3BlblwiXG4gICAgICAgID8gXCJObyB3YWtlIG1vZGVscyBvbiBzZXJ2ZXI6IHVzZSB0aGUgV2FrZSBidXR0b24gd2hlbiBkb3JtYW50LlwiXG4gICAgICAgIDogXCJBcHBsaWVkIG9uIHRoZSBuZXh0IGNhbGwgdW5sZXNzIG92ZXJyaWRkZW4gaW4gRGV2ZWxvcGVyIEpTT04uXCI7XG59XG5cbmNvbnN0IHdha2VDbGllbnQgPSBuZXcgV2FrZUNsaWVudCh7XG4gIG9uUmVhZHkobW9kZWxJZCwgd2FybXVwTXMpIHtcbiAgICB3YWtlTG9hZGluZyA9IGZhbHNlO1xuICAgIGxvZyhcIm91dFwiLCBgd2FrZSB3b3JkIHJlYWR5OiAke21vZGVsSWR9JHt3YXJtdXBNcyA+IDAgPyBgICgke3dhcm11cE1zfSBtcylgIDogXCJcIn1gLCBcIm91dFwiKTtcbiAgICBzeW5jV2FrZVVpKCk7XG4gIH0sXG4gIG9uRGV0ZWN0ZWQoaGl0KSB7XG4gICAgb25XYWtlRGV0ZWN0ZWQoaGl0KTtcbiAgfSxcbiAgb25UZWxlbWV0cnkodGVsKSB7XG4gICAgd2FrZUxhc3RUZWwgPSB0ZWw7XG4gICAgcmVuZGVyV2FrZVRlbGVtZXRyeSgpO1xuICB9LFxuICBvblN1cHByZXNzZWRTZXR0bGVkKCkge1xuICAgIGZsdXNoRGVmZXJyZWRNaWMoKTtcbiAgfSxcbiAgb25FcnJvcihtZXNzYWdlKSB7XG4gICAgd2FrZUxvYWRpbmcgPSBmYWxzZTtcbiAgICBmbHVzaERlZmVycmVkTWljKCk7XG4gICAgbG9nKFwiZXJyb3JcIiwgYHdha2Ugd29yZDogJHttZXNzYWdlfWAsIFwiZXJyXCIpO1xuICAgIHRvYXN0KGBXYWtlIHdvcmQgZXJyb3I6ICR7bWVzc2FnZX1gKTtcbiAgICBpZiAod2FrZUFybWVkKSB2b2lkIGFybVdha2UoZmFsc2UpO1xuICAgIGVsc2Ugc3luY1dha2VVaSgpO1xuICB9LFxufSk7XG5cbmFzeW5jIGZ1bmN0aW9uIGFybVdha2Uob246IGJvb2xlYW4sIHBlcnNpc3QgPSB0cnVlKSB7XG4gIGNvbnN0IG1vZGVsID0gc2VsZWN0ZWRXYWtlTW9kZWwoKTtcbiAgaWYgKG9uICYmICFtb2RlbCkge1xuICAgIHRvYXN0KFwiTm8gd2FrZSB3b3JkIG1vZGVscyBmb3VuZCBvbiB0aGUgc2VydmVyXCIpO1xuICAgICQ8SFRNTElucHV0RWxlbWVudD4oXCJ3YWtlLWVuYWJsZWRcIikuY2hlY2tlZCA9IGZhbHNlO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBnZW4gPSArK2FybUdlbjtcbiAgd2FrZUFybWVkID0gb247XG4gIGlmIChwZXJzaXN0KSBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLndha2UtZW5hYmxlZFwiLCBvbiA/IFwiMVwiIDogXCIwXCIpO1xuICBpZiAob24gJiYgbW9kZWwpIHtcbiAgICB3YWtlTGFzdFRlbCA9IG51bGw7XG4gICAgaWYgKCF3YWtlQ2xpZW50LnJlYWR5IHx8IHdha2VDbGllbnQubW9kZWxJZCAhPT0gbW9kZWwuaWQpIHdha2VMb2FkaW5nID0gdHJ1ZTtcbiAgICB3YWtlQ2xpZW50LmxvYWQobW9kZWwuaWQsIHdha2VUaHJlc2hvbGQoKSk7XG4gICAgaWYgKCFjYWxsSWQpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IGF1ZGlvLmVuc3VyZU1pYyhvbk1pYywgbWljT3B0aW9ucygpKTtcbiAgICAgICAgaWYgKGdlbiAhPT0gYXJtR2VuIHx8ICF3YWtlQXJtZWQpIHJldHVybjtcbiAgICAgICAgd2FrZVBlcmlvZENhbGxJZCA9IDA7XG4gICAgICAgIHdha2VDbGllbnQucmVzZXQoKTtcbiAgICAgICAgYXdhaXQgYWNxdWlyZVdha2VMb2NrKCk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgaWYgKGdlbiAhPT0gYXJtR2VuKSByZXR1cm47XG4gICAgICAgIHdha2VBcm1lZCA9IGZhbHNlO1xuICAgICAgICB3YWtlTG9hZGluZyA9IGZhbHNlO1xuICAgICAgICBpZiAoIWNhbGxJZCkge1xuICAgICAgICAgIGF1ZGlvLnN0b3BNaWMoKTtcbiAgICAgICAgICByZWxlYXNlV2FrZUxvY2soKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAocGVyc2lzdCkgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS53YWtlLWVuYWJsZWRcIiwgXCIwXCIpO1xuICAgICAgICB0b2FzdChgTWljcm9waG9uZTogJHsoZXJyIGFzIEVycm9yKS5tZXNzYWdlfWApO1xuICAgICAgICBsb2coXCJlcnJvclwiLCBgd2FrZSBtaWNyb3Bob25lOiAkeyhlcnIgYXMgRXJyb3IpLm1lc3NhZ2V9YCwgXCJlcnJcIik7XG4gICAgICB9XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIHdha2VMb2FkaW5nID0gZmFsc2U7XG4gICAgd2FrZUxhc3RUZWwgPSBudWxsO1xuICAgIGlmICghY2FsbElkKSB7XG4gICAgICB3YWtlUGVyaW9kQ2FsbElkID0gbnVsbDtcbiAgICAgIGF1ZGlvLnN0b3BNaWMoKTtcbiAgICAgIHJlbGVhc2VXYWtlTG9jaygpO1xuICAgICAgd2FrZUNsaWVudC5yZXNldCgpO1xuICAgIH1cbiAgfVxuICBzeW5jV2FrZVVpKCk7XG59XG5cbmZ1bmN0aW9uIGVuc3VyZUNvcmVXYWtlKG9uOiBib29sZWFuKSB7XG4gIGNvcmVXYW50c1dha2UgPSBvbjtcbiAgY29uc3QgbW9kZWwgPSBzZWxlY3RlZFdha2VNb2RlbCgpO1xuICBpZiAob24pIHtcbiAgICBpZiAoIW1vZGVsKSB7XG4gICAgICBsb2coXCJ3YXJuXCIsIFwiY29yZSBhc2tlZCBmb3Igd2FrZSB3b3JkLCBidXQgbm8gbW9kZWxzIGFyZSBhdmFpbGFibGVcIiwgXCJ3YXJuXCIpO1xuICAgIH0gZWxzZSB7XG4gICAgICB3YWtlTGFzdFRlbCA9IG51bGw7XG4gICAgICB3YWtlUGVyaW9kQ2FsbElkID0gY2FsbElkO1xuICAgICAgaWYgKCF3YWtlQ2xpZW50LnJlYWR5IHx8IHdha2VDbGllbnQubW9kZWxJZCAhPT0gbW9kZWwuaWQpIHdha2VMb2FkaW5nID0gdHJ1ZTtcbiAgICAgIHdha2VDbGllbnQubG9hZChtb2RlbC5pZCwgd2FrZVRocmVzaG9sZCgpKTtcbiAgICAgIHdha2VDbGllbnQucmVzZXQoKTtcbiAgICAgIGxvZyhcIm91dFwiLCBgd2FrZSB3b3JkIGxpc3RlbmluZyAoJHttb2RlbC5sYWJlbH0pYCwgXCJvdXRcIik7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIGlmICghd2FrZUFybWVkKSB3YWtlTGFzdFRlbCA9IG51bGw7XG4gICAgbG9nKFwib3V0XCIsIFwid2FrZSB3b3JkIG9mZlwiLCBcIm91dFwiKTtcbiAgfVxuICBzeW5jV2FrZVVpKCk7XG59XG5cbmZ1bmN0aW9uIG9uV2FrZURldGVjdGVkKGhpdDogV2FrZURldGVjdGlvbkV2ZW50KSB7XG4gIGlmICghY2FuQWNjZXB0V2FrZUhpdCgpKSByZXR1cm47XG4gIGNvbnN0IGxhYmVsID0gc2VsZWN0ZWRXYWtlTW9kZWwoKT8ubGFiZWwgPz8gXCJ3YWtlIHdvcmRcIjtcbiAgbG9nKFwib3V0XCIsIGB3YWtlIGRldGVjdGVkIFx1MjAxQyR7bGFiZWx9XHUyMDFEIChzY29yZSAke2hpdC5zY29yZS50b0ZpeGVkKDIpfSwgJHtoaXQuaW5mZXJNcy50b0ZpeGVkKDEpfSBtcylgLCBcIm91dFwiKTtcbiAgaWYgKGNoZWNrZWQoXCJ3YWtlLWN1ZVwiKSkgdm9pZCBhdWRpby5vcGVuKCkudGhlbigoKSA9PiBhdWRpby5jdWUoV0FLRV9UT05FKSkuY2F0Y2goKCkgPT4ge30pO1xuICB0b2FzdChgSGVhcmQgXHUyMDFDJHtsYWJlbH1cdTIwMUQgKCR7aGl0LnNjb3JlLnRvRml4ZWQoMil9KWApO1xuICBpZiAoY2FsbElkICE9PSAwKSB7XG4gICAgY29uc3QgZGVmZXJyZWQgPSBkZWZlcnJlZE1pYy5zcGxpY2UoMCk7XG4gICAgY29uc3QgZGVmZXJyZWRTZXFzID0gbmV3IFNldChkZWZlcnJlZC5tYXAoKGQpID0+IGQuc2VxKS5maWx0ZXIoKHMpID0+IHMgPiAwKSk7XG4gICAgcHVzaCh7IHR5cGU6IFwid2FrZVwiIH0pO1xuICAgIC8vIFJlcGxheSBzdXBwcmVzc2VkIGNodW5rcyBhbmQgYW55IGRlZmVycmVkIHBvc3QtcGxheWJhY2sgY2h1bmtzIGluIGV4YWN0IGNocm9ub2xvZ2ljYWwgb3JkZXIsXG4gICAgLy8gc28gcGxheWJhY2sgZW5kaW5nIG1pZC1pbmZlcmVuY2UgbmV2ZXIgcmV2ZXJzZXMgb3IgbG9zZXMgc3BlZWNoLlxuICAgIGNvbnN0IHJlcGxheWVkU2VxcyA9IG5ldyBTZXQ8bnVtYmVyPigpO1xuICAgIGZvciAoY29uc3QgY2h1bmsgb2YgaGl0LnRyYWlsaW5nKSB7XG4gICAgICBpZiAoIWNhbGxJZCkgYnJlYWs7XG4gICAgICBpZiAoY2h1bmsuYnl0ZXMuYnl0ZUxlbmd0aCA9PT0gMCkgY29udGludWU7XG4gICAgICBpZiAoIWNodW5rLnN1cHByZXNzZWQgJiYgIWRlZmVycmVkU2Vxcy5oYXMoY2h1bmsuc2VxKSkgY29udGludWU7XG4gICAgICBpZiAoY2h1bmsuc2VxID4gMCkgcmVwbGF5ZWRTZXFzLmFkZChjaHVuay5zZXEpO1xuICAgICAgY291bnRzLm1pYysrO1xuICAgICAgcHVzaCh7IHR5cGU6IFwibWljXCIsIHBjbTogYnl0ZXNUb0Jhc2U2NChjaHVuay5ieXRlcykgfSk7XG4gICAgfVxuICAgIGZvciAoY29uc3QgaXRlbSBvZiBkZWZlcnJlZCkge1xuICAgICAgaWYgKCFjYWxsSWQpIGJyZWFrO1xuICAgICAgaWYgKGl0ZW0uc2VxID4gMCAmJiByZXBsYXllZFNlcXMuaGFzKGl0ZW0uc2VxKSkgY29udGludWU7XG4gICAgICBjb3VudHMubWljKys7XG4gICAgICBwdXNoKHsgdHlwZTogXCJtaWNcIiwgcGNtOiBpdGVtLnBjbSB9LCBpdGVtLnQpO1xuICAgIH1cbiAgICByZXR1cm47XG4gIH1cbiAgd2FrZVN0YXJ0aW5nID0gdHJ1ZTtcbiAgb3BlbmluZ0NodW5rcyA9IFtdO1xuICBvcGVuaW5nQnl0ZXMgPSAwO1xuICBmb3IgKGNvbnN0IGNodW5rIG9mIGhpdC50cmFpbGluZykge1xuICAgIGlmIChjaHVuay5ieXRlcy5ieXRlTGVuZ3RoID09PSAwKSBjb250aW51ZTtcbiAgICBvcGVuaW5nQ2h1bmtzLnB1c2goY2h1bmsuYnl0ZXMpO1xuICAgIG9wZW5pbmdCeXRlcyArPSBjaHVuay5ieXRlcy5ieXRlTGVuZ3RoO1xuICAgIHdoaWxlIChvcGVuaW5nQnl0ZXMgPiBPUEVOSU5HX01BWF9CWVRFUyAmJiBvcGVuaW5nQ2h1bmtzLmxlbmd0aCA+IDEpIHtcbiAgICAgIG9wZW5pbmdCeXRlcyAtPSBvcGVuaW5nQ2h1bmtzLnNoaWZ0KCkhLmJ5dGVMZW5ndGg7XG4gICAgfVxuICB9XG4gIHZvaWQgc3RhcnQoY2hhdC5sZW5ndGggPiAwKS50aGVuKChzdGFydGVkKSA9PiB7XG4gICAgaWYgKCFzdGFydGVkICYmIHdha2VTdGFydGluZykge1xuICAgICAgd2FrZVN0YXJ0aW5nID0gZmFsc2U7XG4gICAgICBvcGVuaW5nQ2h1bmtzID0gW107XG4gICAgICBvcGVuaW5nQnl0ZXMgPSAwO1xuICAgICAgc3luY1dha2VVaSgpO1xuICAgIH1cbiAgfSkuY2F0Y2goKGVycikgPT4ge1xuICAgIHdha2VTdGFydGluZyA9IGZhbHNlO1xuICAgIG9wZW5pbmdDaHVua3MgPSBbXTtcbiAgICBvcGVuaW5nQnl0ZXMgPSAwO1xuICAgIHRvYXN0KChlcnIgYXMgRXJyb3IpLm1lc3NhZ2UpO1xuICAgIGxvZyhcImVycm9yXCIsIChlcnIgYXMgRXJyb3IpLm1lc3NhZ2UsIFwiZXJyXCIpO1xuICAgIHN5bmNXYWtlVWkoKTtcbiAgfSk7XG59XG5cbi8vIFdpcmluZy5cblxuZnVuY3Rpb24gc2V0dGluZ3NGcm9tU3RvcmFnZSgpIHtcbiAgZm9yIChjb25zdCBpZCBvZiBbXCJhZWNcIiwgXCJzdG9wd29yZFwiLCBcInB0dFwiLCBcImNhcHRpb25zXCIsIFwiY29kaW5nXCIsIFwiZmFrZWhlcm1lc1wiLCBcInRyYWNlXCIsIFwid2FrZS1jdWVcIiwgXCJ3YWtlLWJhcmdlXCJdKSB7XG4gICAgY29uc3QgdiA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKGB2b2ljZS4ke2lkfWApO1xuICAgIGlmICh2ICE9IG51bGwpICQ8SFRNTElucHV0RWxlbWVudD4oaWQpLmNoZWNrZWQgPSB2ID09PSBcIjFcIjtcbiAgICAkKGlkKS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHtcbiAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKGB2b2ljZS4ke2lkfWAsIGNoZWNrZWQoaWQpID8gXCIxXCIgOiBcIjBcIik7XG4gICAgICBpZiAoaWQgPT09IFwiYWVjXCIgJiYgd2FrZUFybWVkICYmICFjYWxsSWQpIHtcbiAgICAgICAgdm9pZCBhdWRpby5zdGFydE1pYyhvbk1pYywgbWljT3B0aW9ucygpKS5jYXRjaCgoZXJyKSA9PiB0b2FzdChgTWljcm9waG9uZTogJHtlcnIubWVzc2FnZX1gKSk7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cbiAgZm9yIChjb25zdCBbaWQsIGtleV0gb2YgW1xuICAgIFtcImZha2VkZWxheVwiLCBcInZvaWNlLmZha2VkZWxheVwiXSxcbiAgICBbXCJhdHRuLWFmdGVyLXdha2VcIiwgXCJ2b2ljZS5hdHRuLWFmdGVyLXdha2VcIl0sXG4gICAgW1wiYXR0bi13aW5kb3dcIiwgXCJ2b2ljZS5hdHRuLXdpbmRvd1wiXSxcbiAgICBbXCJhdHRuLWFmdGVyLXF1ZXN0aW9uXCIsIFwidm9pY2UuYXR0bi1hZnRlci1xdWVzdGlvblwiXSxcbiAgICBbXCJoYW5ndXAtYWZ0ZXJcIiwgXCJ2b2ljZS5oYW5ndXAtYWZ0ZXJcIl0sXG4gIF0gYXMgY29uc3QpIHtcbiAgICBjb25zdCBzYXZlZCA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKGtleSk7XG4gICAgaWYgKHNhdmVkICE9IG51bGwpICQ8SFRNTElucHV0RWxlbWVudD4oaWQpLnZhbHVlID0gc2F2ZWQ7XG4gICAgJChpZCkuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiB7XG4gICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShrZXksICQ8SFRNTElucHV0RWxlbWVudD4oaWQpLnZhbHVlKTtcbiAgICAgIGlmIChpZCA9PT0gXCJoYW5ndXAtYWZ0ZXJcIikgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS5oYW5ndXAtY3VzdG9tXCIsIFwiMVwiKTtcbiAgICB9KTtcbiAgfVxuICBjb25zdCB0aHJlc2ggPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLndha2UtdGhyZXNob2xkXCIpO1xuICBpZiAodGhyZXNoICE9IG51bGwpICQ8SFRNTElucHV0RWxlbWVudD4oXCJ3YWtlLXRocmVzaG9sZFwiKS52YWx1ZSA9IHRocmVzaDtcbiAgJChcIndha2UtdGhyZXNob2xkLXZhbFwiKS50ZXh0Q29udGVudCA9IHdha2VUaHJlc2hvbGQoKS50b0ZpeGVkKDIpO1xuICAkKFwid2FrZS10aHJlc2hvbGRcIikuYWRkRXZlbnRMaXN0ZW5lcihcImlucHV0XCIsICgpID0+IHtcbiAgICBjb25zdCB2ID0gd2FrZVRocmVzaG9sZCgpO1xuICAgICQoXCJ3YWtlLXRocmVzaG9sZC12YWxcIikudGV4dENvbnRlbnQgPSB2LnRvRml4ZWQoMik7XG4gICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS53YWtlLXRocmVzaG9sZFwiLCB2LnRvRml4ZWQoMikpO1xuICAgIHdha2VDbGllbnQuc2V0VGhyZXNob2xkKHYpO1xuICAgIHJlbmRlcldha2VUZWxlbWV0cnkoKTtcbiAgfSk7XG4gIGNvbnN0IHNpZ25hbGluZyA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2Uuc2lnbmFsaW5nXCIpO1xuICBpZiAoc2lnbmFsaW5nKSAkPEhUTUxTZWxlY3RFbGVtZW50PihcInNpZ25hbGluZ1wiKS52YWx1ZSA9IHNpZ25hbGluZztcbiAgJChcInNpZ25hbGluZ1wiKS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHtcbiAgICBjb25zdCBtb2RlID0gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJzaWduYWxpbmdcIikudmFsdWU7XG4gICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS5zaWduYWxpbmdcIiwgbW9kZSk7XG4gICAgaWYgKGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UuaGFuZ3VwLWN1c3RvbVwiKSAhPT0gXCIxXCIpIHtcbiAgICAgIGNvbnN0IGRlZiA9IG1vZGUgPT09IFwiZWNob1wiID8gXCIxNVwiIDogXCIzMDBcIjtcbiAgICAgICQ8SFRNTElucHV0RWxlbWVudD4oXCJoYW5ndXAtYWZ0ZXJcIikudmFsdWUgPSBkZWY7XG4gICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLmhhbmd1cC1hZnRlclwiLCBkZWYpO1xuICAgIH1cbiAgICBzeW5jU2lnbmFsaW5nVWkoKTtcbiAgfSk7XG4gICQoXCJ3YWtlLWVuYWJsZWRcIikuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiB2b2lkIGFybVdha2UoY2hlY2tlZChcIndha2UtZW5hYmxlZFwiKSkpO1xuICAkKFwid2FrZS1tb2RlbFwiKS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHtcbiAgICBjb25zdCBpZCA9ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwid2FrZS1tb2RlbFwiKS52YWx1ZTtcbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLndha2UtbW9kZWxcIiwgaWQpO1xuICAgIGlmICh3YWtlQXJtZWQgfHwgY29yZVdhbnRzV2FrZSkge1xuICAgICAgd2FrZUxvYWRpbmcgPSB0cnVlO1xuICAgICAgd2FrZUxhc3RUZWwgPSBudWxsO1xuICAgICAgd2FrZUNsaWVudC5sb2FkKGlkLCB3YWtlVGhyZXNob2xkKCkpO1xuICAgICAgc3luY1dha2VVaSgpO1xuICAgIH0gZWxzZSB7XG4gICAgICBzeW5jV2FrZVVpKCk7XG4gICAgfVxuICB9KTtcbiAgY29uc3Qgdm9pY2UgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLnZvaWNlXCIpO1xuICBpZiAodm9pY2UpICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwidm9pY2VcIikudmFsdWUgPSB2b2ljZTtcbiAgJChcInZvaWNlXCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4gbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS52b2ljZVwiLCAkPEhUTUxTZWxlY3RFbGVtZW50PihcInZvaWNlXCIpLnZhbHVlKSk7XG4gIGNvbnN0IG1vZGUgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLm1vZGVcIik7XG4gIGlmIChtb2RlKSAkPEhUTUxTZWxlY3RFbGVtZW50PihcIm1vZGVcIikudmFsdWUgPSBtb2RlO1xuICAkKFwibW9kZVwiKS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHtcbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLm1vZGVcIiwgJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJtb2RlXCIpLnZhbHVlKTtcbiAgICBzeW5jQ29tcG9zZXIoKTtcbiAgfSk7XG4gIGNvbnN0IHRoZW1lID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS50aGVtZVwiKSA/PyBcInN5c3RlbVwiO1xuICBhcHBseVRoZW1lKHRoZW1lKTtcbiAgZm9yIChjb25zdCBidG4gb2YgQXJyYXkuZnJvbShkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxCdXR0b25FbGVtZW50PihcIiN0aGVtZS1waWNrZXIgYnV0dG9uXCIpKSkge1xuICAgIGJ0bi5vbmNsaWNrID0gKCkgPT4ge1xuICAgICAgY29uc3QgY2hvaWNlID0gYnRuLmRhdGFzZXQudGhlbWUgPz8gXCJzeXN0ZW1cIjtcbiAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2UudGhlbWVcIiwgY2hvaWNlKTtcbiAgICAgIGFwcGx5VGhlbWUoY2hvaWNlKTtcbiAgICB9O1xuICB9XG4gIGNvbnN0IGRlbnNpdHkgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLmRlbnNpdHlcIik7XG4gIGFwcGx5RGVuc2l0eShkZW5zaXR5KTtcbiAgZm9yIChjb25zdCBidG4gb2YgQXJyYXkuZnJvbShkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxCdXR0b25FbGVtZW50PihcIiNkZW5zaXR5LXBpY2tlciBidXR0b25cIikpKSB7XG4gICAgYnRuLm9uY2xpY2sgPSAoKSA9PiB7XG4gICAgICBjb25zdCBjaG9pY2UgPSBub3JtYWxpemVEZW5zaXR5KGJ0bi5kYXRhc2V0LmRlbnNpdHkpO1xuICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS5kZW5zaXR5XCIsIGNob2ljZSk7XG4gICAgICBhcHBseURlbnNpdHkoY2hvaWNlKTtcbiAgICB9O1xuICB9XG4gIG1hdGNoTWVkaWEoXCIocHJlZmVycy1jb2xvci1zY2hlbWU6IGRhcmspXCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4ge1xuICAgIGlmICgobG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS50aGVtZVwiKSA/PyBcInN5c3RlbVwiKSA9PT0gXCJzeXN0ZW1cIikgYXBwbHlUaGVtZShcInN5c3RlbVwiKTtcbiAgfSk7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJ2aXNpYmlsaXR5Y2hhbmdlXCIsICgpID0+IHtcbiAgICBpZiAoIWRvY3VtZW50LmhpZGRlbiAmJiAoY2FsbElkIHx8IHdha2VBcm1lZCkpIHZvaWQgYWNxdWlyZVdha2VMb2NrKCk7XG4gIH0pO1xuICBhdWRpby5vbkF1ZGlvU3RhdGVDaGFuZ2UoKCkgPT4gc3luY1dha2VVaSgpKTtcbiAgY29uc3QgcmVzdW1lSWZTdXNwZW5kZWQgPSAoKSA9PiB7XG4gICAgaWYgKGF1ZGlvLmF1ZGlvU3VzcGVuZGVkICYmICh3YWtlQXJtZWQgfHwgY2FsbElkKSkge1xuICAgICAgdm9pZCBhdWRpby5yZXN1bWVBdWRpbygpLnRoZW4oKCkgPT4gc3luY1dha2VVaSgpKTtcbiAgICB9XG4gIH07XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJwb2ludGVyZG93blwiLCByZXN1bWVJZlN1c3BlbmRlZCwgeyBwYXNzaXZlOiB0cnVlIH0pO1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwicG9pbnRlcnVwXCIsIHJlc3VtZUlmU3VzcGVuZGVkLCB7IHBhc3NpdmU6IHRydWUgfSk7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCByZXN1bWVJZlN1c3BlbmRlZCwgeyBwYXNzaXZlOiB0cnVlIH0pO1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCByZXN1bWVJZlN1c3BlbmRlZCwgeyBwYXNzaXZlOiB0cnVlIH0pO1xuICBzeW5jU2lnbmFsaW5nVWkoKTtcbn1cblxuY29uc3QgbW9iaWxlTGF5b3V0ID0gbWF0Y2hNZWRpYShcIihtYXgtd2lkdGg6IDkyMHB4KVwiKTtcbmxldCBkcmF3ZXJPcGVuZXI6IEhUTUxFbGVtZW50IHwgbnVsbCA9IG51bGw7XG5cbmZ1bmN0aW9uIHNldFRhc2tzT3BlbihvcGVuOiBib29sZWFuLCBvcGVuZXI/OiBIVE1MRWxlbWVudCB8IG51bGwpIHtcbiAgY29uc3QgY2FuT3BlbiA9IG1vYmlsZUxheW91dC5tYXRjaGVzICYmICEkKFwidGFsa1wiKS5oaWRkZW47XG4gIGNvbnN0IG5leHQgPSBvcGVuICYmIGNhbk9wZW47XG4gIGNvbnN0IHdhc09wZW4gPSBkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5jb250YWlucyhcInRhc2tzLW9wZW5cIik7XG4gIGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LnRvZ2dsZShcInRhc2tzLW9wZW5cIiwgbmV4dCk7XG4gIGNvbnN0IGhlYWRlciA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoXCJoZWFkZXJcIikgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAoaGVhZGVyKSBoZWFkZXIuaW5lcnQgPSBuZXh0O1xuICAkKFwiY29udm9cIikuaW5lcnQgPSBuZXh0O1xuICAkKFwic2lkZVwiKS5pbmVydCA9IG1vYmlsZUxheW91dC5tYXRjaGVzICYmICFuZXh0O1xuICAkKFwidGFza3MtdG9nZ2xlXCIpLnNldEF0dHJpYnV0ZShcImFyaWEtZXhwYW5kZWRcIiwgU3RyaW5nKG5leHQpKTtcbiAgJChcIm1vYmlsZS10YXNrcy1iYXJcIikuc2V0QXR0cmlidXRlKFwiYXJpYS1leHBhbmRlZFwiLCBTdHJpbmcobmV4dCkpO1xuICBpZiAobmV4dCAmJiAhd2FzT3Blbikge1xuICAgIGRyYXdlck9wZW5lciA9IG9wZW5lciA/PyAoZG9jdW1lbnQuYWN0aXZlRWxlbWVudCBhcyBIVE1MRWxlbWVudCB8IG51bGwpO1xuICAgIGNsZWFyVW5yZWFkSWZSZXN1bHRzVmlzaWJsZSgpO1xuICAgICQoXCJ0YXNrcy1jbG9zZVwiKS5mb2N1cygpO1xuICAgIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB1cGRhdGVBbGxSZXN1bHRDbGFtcGluZygpKTtcbiAgfSBlbHNlIGlmICghbmV4dCAmJiB3YXNPcGVuKSB7XG4gICAgY29uc3QgdGFyZ2V0ID0gZHJhd2VyT3BlbmVyO1xuICAgIGRyYXdlck9wZW5lciA9IG51bGw7XG4gICAgaWYgKHRhcmdldCAmJiB0YXJnZXQuaXNDb25uZWN0ZWQgJiYgIXRhcmdldC5oaWRkZW4gJiYgdGFyZ2V0Lm9mZnNldFBhcmVudCAhPT0gbnVsbCkge1xuICAgICAgdGFyZ2V0LmZvY3VzKCk7XG4gICAgfSBlbHNlIGlmICh0YXJnZXQgPT09ICQoXCJtb2JpbGUtdGFza3MtYmFyXCIpKSB7XG4gICAgICBjb25zdCBmYWxsYmFjayA9ICQoXCJ0YXNrcy10b2dnbGVcIik7XG4gICAgICBpZiAoIWZhbGxiYWNrLmhpZGRlbiAmJiBmYWxsYmFjay5vZmZzZXRQYXJlbnQgIT09IG51bGwpIGZhbGxiYWNrLmZvY3VzKCk7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIHRhYnMoKSB7XG4gIGNvbnN0IHZpZXdzOiBSZWNvcmQ8c3RyaW5nLCBIVE1MRWxlbWVudD4gPSB7IHRhbGs6ICQoXCJ0YWxrXCIpLCBkZXY6ICQoXCJkZXZcIiksIHJlcGxheTogJChcInJlcGxheW1haW5cIikgfTtcbiAgZm9yIChjb25zdCBuYW1lIG9mIE9iamVjdC5rZXlzKHZpZXdzKSkge1xuICAgICQoYHRhYi0ke25hbWV9YCkub25jbGljayA9ICgpID0+IHtcbiAgICAgIGZvciAoY29uc3QgW290aGVyLCBlbF0gb2YgT2JqZWN0LmVudHJpZXModmlld3MpKSB7XG4gICAgICAgIGVsLmhpZGRlbiA9IG90aGVyICE9PSBuYW1lO1xuICAgICAgICAkKGB0YWItJHtvdGhlcn1gKS5jbGFzc0xpc3QudG9nZ2xlKFwib25cIiwgb3RoZXIgPT09IG5hbWUpO1xuICAgICAgfVxuICAgICAgJChcInRhc2tzLXRvZ2dsZVwiKS5oaWRkZW4gPSBuYW1lICE9PSBcInRhbGtcIjtcbiAgICAgIHNldFRhc2tzT3BlbihmYWxzZSk7XG4gICAgICBpZiAobmFtZSA9PT0gXCJ0YWxrXCIpIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB1cGRhdGVBbGxSZXN1bHRDbGFtcGluZygpKTtcbiAgICB9O1xuICB9XG4gIGZvciAoY29uc3QgYnRuIG9mIEFycmF5LmZyb20oZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MQnV0dG9uRWxlbWVudD4oXCIjc2lkZS10YWJzIGJ1dHRvblwiKSkpIHtcbiAgICBidG4ub25jbGljayA9ICgpID0+IHNldFNpZGVGaWx0ZXIobm9ybWFsaXplU2lkZUZpbHRlcihidG4uZGF0YXNldC5maWx0ZXIpKTtcbiAgfVxuICAkKFwidG9nZ2xlLWFsbC1yZXN1bHRzXCIpLm9uY2xpY2sgPSAoKSA9PiB7XG4gICAgY29uc3QgY2xhbXBlZCA9IFsuLi5yZXN1bHRzLnZhbHVlcygpXS5maWx0ZXIoKHIpID0+IHIuY2FyZC5jbGFzc0xpc3QuY29udGFpbnMoXCJjbGFtcGVkXCIpKTtcbiAgICBjb25zdCBvcGVuQWxsID0gY2xhbXBlZC5zb21lKChyKSA9PiAhci5jYXJkLmNsYXNzTGlzdC5jb250YWlucyhcIm9wZW5cIikpO1xuICAgIGZvciAoY29uc3QgZW50cnkgb2YgY2xhbXBlZCkgc2V0UmVzdWx0T3BlbihlbnRyeSwgb3BlbkFsbCk7XG4gIH07XG4gICQoXCJnZWFyXCIpLm9uY2xpY2sgPSAoKSA9PiB7ICQoXCJzZXR0aW5nc1wiKS5oaWRkZW4gPSBmYWxzZTsgfTtcbiAgJChcImNsb3Nlc2V0dGluZ3NcIikub25jbGljayA9ICgpID0+IHsgJChcInNldHRpbmdzXCIpLmhpZGRlbiA9IHRydWU7IH07XG4gICQoXCJjbG9zZXNldHRpbmdzLXhcIikub25jbGljayA9ICgpID0+IHsgJChcInNldHRpbmdzXCIpLmhpZGRlbiA9IHRydWU7IH07XG4gICQoXCJzZXR0aW5nc1wiKS5vbmNsaWNrID0gKGUpID0+IHsgaWYgKGUudGFyZ2V0ID09PSAkKFwic2V0dGluZ3NcIikpICQoXCJzZXR0aW5nc1wiKS5oaWRkZW4gPSB0cnVlOyB9O1xuICBjb25zdCBvcGVuTW9iaWxlVGFza3NEcmF3ZXIgPSAob3BlbmVyOiBIVE1MRWxlbWVudCkgPT4ge1xuICAgIGNvbnN0IGFjdGl2ZVRvdGFsID0gWy4uLnRhc2tzLnZhbHVlcygpXS5maWx0ZXIoaXNBY3RpdmVUYXNrKS5sZW5ndGggKyBlYXJsaWVyQWN0aXZlQ291bnQ7XG4gICAgY29uc3QgbmV4dEZpbHRlciA9IHJlc29sdmVNb2JpbGVCYW5uZXJGaWx0ZXIoc2lkZUZpbHRlciwgYWN0aXZlVG90YWwsIHVucmVhZE1vYmlsZVJlc3VsdHMpO1xuICAgIGlmIChuZXh0RmlsdGVyICE9PSBzaWRlRmlsdGVyKSBzZXRTaWRlRmlsdGVyKG5leHRGaWx0ZXIpO1xuICAgIHNldFRhc2tzT3Blbih0cnVlLCBvcGVuZXIpO1xuICB9O1xuICAkKFwidGFza3MtdG9nZ2xlXCIpLm9uY2xpY2sgPSAoKSA9PiB7XG4gICAgaWYgKGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LmNvbnRhaW5zKFwidGFza3Mtb3BlblwiKSkgc2V0VGFza3NPcGVuKGZhbHNlKTtcbiAgICBlbHNlIG9wZW5Nb2JpbGVUYXNrc0RyYXdlcigkKFwidGFza3MtdG9nZ2xlXCIpKTtcbiAgfTtcbiAgJChcIm1vYmlsZS10YXNrcy1iYXJcIikub25jbGljayA9ICgpID0+IG9wZW5Nb2JpbGVUYXNrc0RyYXdlcigkKFwibW9iaWxlLXRhc2tzLWJhclwiKSk7XG4gICQoXCJ0YXNrcy1jbG9zZVwiKS5vbmNsaWNrID0gKCkgPT4gc2V0VGFza3NPcGVuKGZhbHNlKTtcbiAgJChcInNpZGUtYmFja2Ryb3BcIikub25jbGljayA9ICgpID0+IHNldFRhc2tzT3BlbihmYWxzZSk7XG4gIG1vYmlsZUxheW91dC5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHtcbiAgICBzZXRUYXNrc09wZW4oZmFsc2UpO1xuICAgIGNsZWFyVW5yZWFkSWZSZXN1bHRzVmlzaWJsZSgpO1xuICAgIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB1cGRhdGVBbGxSZXN1bHRDbGFtcGluZygpKTtcbiAgfSk7XG4gIHNldFRhc2tzT3BlbihmYWxzZSk7XG59XG5cbmZ1bmN0aW9uIHR5cGluZygpOiBib29sZWFuIHtcbiAgY29uc3QgZWwgPSBkb2N1bWVudC5hY3RpdmVFbGVtZW50IGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgcmV0dXJuICEhZWwgJiYgKGVsLnRhZ05hbWUgPT09IFwiSU5QVVRcIiB8fCBlbC50YWdOYW1lID09PSBcIlRFWFRBUkVBXCIgfHwgZWwudGFnTmFtZSA9PT0gXCJTRUxFQ1RcIiB8fCBlbC5pc0NvbnRlbnRFZGl0YWJsZSk7XG59XG5cbmZ1bmN0aW9uIGtleXMoKSB7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJrZXlkb3duXCIsIChlKSA9PiB7XG4gICAgaWYgKGUua2V5ID09PSBcIkVzY2FwZVwiKSB7XG4gICAgICBpZiAoISQoXCJzZXR0aW5nc1wiKS5oaWRkZW4pIHsgJChcInNldHRpbmdzXCIpLmhpZGRlbiA9IHRydWU7IHJldHVybjsgfVxuICAgICAgaWYgKGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LmNvbnRhaW5zKFwidGFza3Mtb3BlblwiKSAmJiBtb2JpbGVMYXlvdXQubWF0Y2hlcyAmJiAhJChcInRhbGtcIikuaGlkZGVuKSB7IHNldFRhc2tzT3BlbihmYWxzZSk7IHJldHVybjsgfVxuICAgICAgaWYgKGNhbGxJZCkgeyBwdXNoKHsgdHlwZTogXCJpbnRlcnJ1cHRcIiB9KTsgYXVkaW8uZmx1c2goKTsgcmV0dXJuOyB9XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICh0eXBpbmcoKSB8fCAhJChcInNldHRpbmdzXCIpLmhpZGRlbiB8fCBkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5jb250YWlucyhcInRhc2tzLW9wZW5cIikgfHwgZS5tZXRhS2V5IHx8IGUuY3RybEtleSB8fCBlLmFsdEtleSkgcmV0dXJuO1xuICAgIGlmIChlLmtleSA9PT0gXCJtXCIgfHwgZS5rZXkgPT09IFwiTVwiKSB7IHNldE11dGVkKCFtdXRlZCk7IGUucHJldmVudERlZmF1bHQoKTsgfVxuICAgIGVsc2UgaWYgKGUua2V5ID09PSBcIndcIiB8fCBlLmtleSA9PT0gXCJXXCIpIHsgdm9pZCBhcm1XYWtlKCF3YWtlQXJtZWQpOyBlLnByZXZlbnREZWZhdWx0KCk7IH1cbiAgICBlbHNlIGlmIChlLmtleSA9PT0gXCIvXCIpIHsgJChcInRleHRcIikuZm9jdXMoKTsgZS5wcmV2ZW50RGVmYXVsdCgpOyB9XG4gICAgZWxzZSBpZiAoZS5jb2RlID09PSBcIlNwYWNlXCIgJiYgY2FsbElkICYmIG11dGVkICYmICFlLnJlcGVhdCkgeyBob2xkaW5nID0gdHJ1ZTsgcHVzaCh7IHR5cGU6IFwidW5tdXRlXCIgfSk7IHNob3dTdGF0dXMoKTsgZS5wcmV2ZW50RGVmYXVsdCgpOyB9XG4gIH0pO1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5dXBcIiwgKGUpID0+IHtcbiAgICBpZiAoZS5jb2RlID09PSBcIlNwYWNlXCIgJiYgaG9sZGluZykgeyBob2xkaW5nID0gZmFsc2U7IHB1c2goeyB0eXBlOiBcIm11dGVcIiB9KTsgc2hvd1N0YXR1cygpOyB9XG4gIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBzdWJtaXRUZXh0KGU6IEV2ZW50KSB7XG4gIGUucHJldmVudERlZmF1bHQoKTtcbiAgY29uc3QgaW5wdXQgPSAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwidGV4dFwiKTtcbiAgbGV0IHRleHQgPSBpbnB1dC52YWx1ZS50cmltKCk7XG4gIGlmICghdGV4dCkgcmV0dXJuO1xuICAvLyBXaXRoIG5vIGNhbGwgb24sIHR5cGluZyBzdGFydHMgYSBjaGF0OiB0aGUgc2FtZSBtYWluIHRocmVhZCwgaW4gdGV4dC5cbiAgaWYgKCFjYWxsSWQpIHtcbiAgICBpbnB1dC52YWx1ZSA9IFwiXCI7XG4gICAgc3luY0NvbXBvc2VyKCk7XG4gICAgdHJ5IHsgYXdhaXQgc3RhcnQoZmFsc2UsIHRydWUpOyB9IGNhdGNoIChlcnIpIHsgdG9hc3QoKGVyciBhcyBFcnJvcikubWVzc2FnZSk7IGxvZyhcImVycm9yXCIsIChlcnIgYXMgRXJyb3IpLm1lc3NhZ2UsIFwiZXJyXCIpOyB9XG4gICAgaWYgKCFjYWxsSWQpIHsgaW5wdXQudmFsdWUgPSB0ZXh0OyBzeW5jQ29tcG9zZXIoKTsgcmV0dXJuOyB9XG4gIH1cbiAgLy8gXCIvdDMgXHUyMDI2XCIgYW5kIFwiL2ggXHUyMDI2XCIgcGljayB0aGUgYWdlbnQgd2hhdGV2ZXIgdGhlIHNlbGVjdG9yIHNheXMuXG4gIGNvbnN0IHBhcnNlZCA9IHBhcnNlUHJlZml4KHRleHQpO1xuICBjb25zdCBtb2RlID0gcGFyc2VkLm1vZGUgPz8gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJtb2RlXCIpLnZhbHVlO1xuICB0ZXh0ID0gcGFyc2VkLnJlc3Q7XG4gIGlmICghdGV4dCkgcmV0dXJuO1xuICBpZiAobW9kZSA9PT0gXCJzYXlcIikge1xuICAgIHB1c2goeyB0eXBlOiBcInNheVwiLCB0ZXh0IH0pO1xuICAgIHNjcm9sbERvd24odHJ1ZSk7XG4gIH0gZWxzZSB7XG4gICAgcHVzaCh7IHR5cGU6IFwiYXNrXCIsIHRleHQsIGFnZW50OiBtb2RlIH0pO1xuICAgIG5vdGUoYFlvdSBcdTIxOTIgbmV3ICR7bW9kZSA9PT0gXCJ0M1wiID8gXCJjb2RpbmdcIiA6IFwiSGVybWVzXCJ9IHRhc2s6ICR7dGV4dH1gKTtcbiAgICBzY3JvbGxEb3duKHRydWUpO1xuICB9XG4gIGlucHV0LnZhbHVlID0gXCJcIjtcbiAgc3luY0NvbXBvc2VyKCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIG1haW4oKSB7XG4gIGFwcGx5VGhlbWUobG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS50aGVtZVwiKSA/PyBcInN5c3RlbVwiKTtcbiAgYXBwbHlEZW5zaXR5KGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UuZGVuc2l0eVwiKSk7XG4gIHNlcnZlciA9IGF3YWl0IChhd2FpdCBmZXRjaChcIi9jb25maWdcIikpLmpzb24oKTtcbiAgJChcInJvdXRlXCIpLnRleHRDb250ZW50ID0gYCR7c2VydmVyLnJvdXRlID09PSBcInZlcnRleFwiID8gXCJWZXJ0ZXhcIiA6IFwiR2VtaW5pIEFQSVwifSBcdTAwQjcgJHtzZXJ2ZXIubW9kZWwuc3BsaXQoXCIvXCIpLnBvcCgpfWA7XG4gICQoXCJ2ZXJzaW9uXCIpLnRleHRDb250ZW50ID0gc2VydmVyLnZlcnNpb247XG4gICQoXCJidWlsZFwiKS50ZXh0Q29udGVudCA9IGBjb3JlICR7c2VydmVyLnZlcnNpb259YDtcbiAgc2V0dGluZ3NGcm9tU3RvcmFnZSgpO1xuICBjb25zdCB3YWtlU2VsZWN0ID0gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJ3YWtlLW1vZGVsXCIpO1xuICBjb25zdCB3YWtlTGlzdCA9IHNlcnZlci53YWtlTW9kZWxzID8/IFtdO1xuICBmb3IgKGNvbnN0IG0gb2Ygd2FrZUxpc3QpIHdha2VTZWxlY3QuYWRkKG5ldyBPcHRpb24obS5sYWJlbCwgbS5pZCkpO1xuICBjb25zdCBzYXZlZFdha2VNb2RlbCA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2Uud2FrZS1tb2RlbFwiKTtcbiAgaWYgKHNhdmVkV2FrZU1vZGVsICYmIHdha2VMaXN0LnNvbWUoKG0pID0+IG0uaWQgPT09IHNhdmVkV2FrZU1vZGVsKSkgd2FrZVNlbGVjdC52YWx1ZSA9IHNhdmVkV2FrZU1vZGVsO1xuICBlbHNlIGlmICh3YWtlTGlzdC5zb21lKChtKSA9PiBtLmlkID09PSBcInBlbm55d29ydGhcIikpIHdha2VTZWxlY3QudmFsdWUgPSBcInBlbm55d29ydGhcIjtcbiAgaWYgKHdha2VMaXN0Lmxlbmd0aCA9PT0gMCkge1xuICAgICQ8SFRNTElucHV0RWxlbWVudD4oXCJ3YWtlLWVuYWJsZWRcIikuZGlzYWJsZWQgPSB0cnVlO1xuICAgIHdha2VTZWxlY3QuZGlzYWJsZWQgPSB0cnVlO1xuICAgICQoXCJ3YWtlLWhlbHBcIikudGV4dENvbnRlbnQgPSBcIk5vIC5vbm54IHdha2Ugd29yZCBtb2RlbHMgZm91bmQgb24gdGhlIHNlcnZlci5cIjtcbiAgfVxuICBpZiAoIXNlcnZlci5oZXJtZXMpIHsgJDxIVE1MSW5wdXRFbGVtZW50PihcImZha2VoZXJtZXNcIikuY2hlY2tlZCA9IHRydWU7ICQ8SFRNTElucHV0RWxlbWVudD4oXCJmYWtlaGVybWVzXCIpLmRpc2FibGVkID0gdHJ1ZTsgfVxuICBpZiAoIXNlcnZlci50MykgJChcImNvZGluZ2hlbHBcIikudGV4dENvbnRlbnQgPSBcIlQzIGlzbid0IGF2YWlsYWJsZSBvbiB0aGUgc2VydmVyOiBvbmx5IHdpdGggZmFrZSBhbnN3ZXJzLlwiO1xuICBlbHNlICQoXCJjb2RpbmdoZWxwXCIpLnRleHRDb250ZW50ID0gYENvZGUgY2hhbmdlcyBnbyB0byBhIFQzIENvZGUgdGhyZWFkIGluIG9uZSBvZjogJHtzZXJ2ZXIudDMuam9pbihcIiwgXCIpfS5gO1xuICBpZiAoIXN0b3BXb3Jkcy5zdXBwb3J0ZWQpIHsgJDxIVE1MSW5wdXRFbGVtZW50PihcInN0b3B3b3JkXCIpLmNoZWNrZWQgPSBmYWxzZTsgJDxIVE1MSW5wdXRFbGVtZW50PihcInN0b3B3b3JkXCIpLmRpc2FibGVkID0gdHJ1ZTsgfVxuICBjb25zdCBwcmVzZXQgPSAkPEhUTUxTZWxlY3RFbGVtZW50PihcInByZXNldFwiKTtcbiAgZm9yIChjb25zdCBuYW1lIG9mIE9iamVjdC5rZXlzKFBSRVNFVFMpKSBwcmVzZXQuYWRkKG5ldyBPcHRpb24obmFtZSwgbmFtZSkpO1xuICBwcmVzZXQudmFsdWUgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLWNvcmUucHJlc2V0XCIpID8/IFwid2ViXCI7XG4gIGlmICghUFJFU0VUU1twcmVzZXQudmFsdWVdKSBwcmVzZXQudmFsdWUgPSBcIndlYlwiO1xuICAkPEhUTUxUZXh0QXJlYUVsZW1lbnQ+KFwiY29uZmlnXCIpLnZhbHVlID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS1jb3JlLmNvbmZpZ1wiKSA/PyBKU09OLnN0cmluZ2lmeShQUkVTRVRTW3ByZXNldC52YWx1ZV0sIG51bGwsIDIpO1xuICBzeW5jU2lnbmFsaW5nVWkoKTtcbiAgcHJlc2V0Lm9uY2hhbmdlID0gKCkgPT4ge1xuICAgICQ8SFRNTFRleHRBcmVhRWxlbWVudD4oXCJjb25maWdcIikudmFsdWUgPSBKU09OLnN0cmluZ2lmeShQUkVTRVRTW3ByZXNldC52YWx1ZV0sIG51bGwsIDIpO1xuICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2UtY29yZS5wcmVzZXRcIiwgcHJlc2V0LnZhbHVlKTtcbiAgICBsb2NhbFN0b3JhZ2UucmVtb3ZlSXRlbShcInZvaWNlLWNvcmUuY29uZmlnXCIpO1xuICAgIHN5bmNTaWduYWxpbmdVaSgpO1xuICB9O1xuICAkKFwiY29uZmlnXCIpLm9uaW5wdXQgPSAoKSA9PiB7IGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2UtY29yZS5jb25maWdcIiwgJDxIVE1MVGV4dEFyZWFFbGVtZW50PihcImNvbmZpZ1wiKS52YWx1ZSk7IHN5bmNTaWduYWxpbmdVaSgpOyB9O1xuICAkKFwiZGVmYXVsdHNcIikub25jbGljayA9IGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBjID0gY29yZSA/PyAoYXdhaXQgbG9hZENvcmUoKSk7XG4gICAgJChcImRlZmF1bHRzdmlld1wiKS50ZXh0Q29udGVudCA9IEpTT04uc3RyaW5naWZ5KEpTT04ucGFyc2UoYy5kZWZhdWx0cygpKSwgbnVsbCwgMik7XG4gICAgJChcImRlZmF1bHRzdmlld1wiKS5oaWRkZW4gPSAhJChcImRlZmF1bHRzdmlld1wiKS5oaWRkZW47XG4gIH07XG4gIGNvbnN0IG9uQ2FsbENsaWNrID0gKCkgPT4gdm9pZCBjYWxsQnV0dG9uKCkuY2F0Y2goKGVycikgPT4geyB0b2FzdChlcnIubWVzc2FnZSk7IGxvZyhcImVycm9yXCIsIGVyci5tZXNzYWdlLCBcImVyclwiKTsgfSk7XG4gIGNvbnN0IG9uSGVyb0NhbGxDbGljayA9ICgpID0+IHsgaWYgKCFjYWxsSWQpIHZvaWQgc3RhcnQoKS5jYXRjaCgoZXJyKSA9PiB7IHRvYXN0KGVyci5tZXNzYWdlKTsgbG9nKFwiZXJyb3JcIiwgZXJyLm1lc3NhZ2UsIFwiZXJyXCIpOyB9KTsgfTtcbiAgY29uc3Qgb25SZXN1bWVDbGljayA9ICgpID0+IHZvaWQgc3RhcnQodHJ1ZSkuY2F0Y2goKGVycikgPT4geyB0b2FzdChlcnIubWVzc2FnZSk7IGxvZyhcImVycm9yXCIsIGVyci5tZXNzYWdlLCBcImVyclwiKTsgfSk7XG4gICQoXCJjYWxsXCIpLm9uY2xpY2sgPSBvbkNhbGxDbGljaztcbiAgJChcImhlcm8tY2FsbFwiKS5vbmNsaWNrID0gb25IZXJvQ2FsbENsaWNrO1xuICAkKFwiaGVyby13YWtlXCIpLm9uY2xpY2sgPSAoKSA9PiB7XG4gICAgaWYgKHdha2VBcm1lZCAmJiBhdWRpby5hdWRpb1N1c3BlbmRlZCkgeyB2b2lkIGF1ZGlvLnJlc3VtZUF1ZGlvKCkudGhlbigoKSA9PiBzeW5jV2FrZVVpKCkpOyByZXR1cm47IH1cbiAgICB2b2lkIGFybVdha2UoIXdha2VBcm1lZCk7XG4gIH07XG4gICQoXCJ3YWtlYnRuXCIpLm9uY2xpY2sgPSAoKSA9PiB7XG4gICAgaWYgKHdha2VBcm1lZCAmJiBhdWRpby5hdWRpb1N1c3BlbmRlZCkgeyB2b2lkIGF1ZGlvLnJlc3VtZUF1ZGlvKCkudGhlbigoKSA9PiBzeW5jV2FrZVVpKCkpOyByZXR1cm47IH1cbiAgICB2b2lkIGFybVdha2UoIXdha2VBcm1lZCk7XG4gIH07XG4gICQoXCJ3YWtlLW5vd1wiKS5vbmNsaWNrID0gKCkgPT4geyBpZiAoY2FsbElkKSB7IGZsdXNoRGVmZXJyZWRNaWMoKTsgcHVzaCh7IHR5cGU6IFwicmVzdW1lXCIgfSk7IH0gfTtcbiAgJChcInJlc3VtZVwiKS5vbmNsaWNrID0gb25SZXN1bWVDbGljaztcbiAgJChcImhlcm8tcmVzdW1lXCIpLm9uY2xpY2sgPSBvblJlc3VtZUNsaWNrO1xuICBzeW5jV2FrZVVpKCk7XG4gIGlmIChsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLndha2UtZW5hYmxlZFwiKSA9PT0gXCIxXCIgJiYgd2FrZUxpc3QubGVuZ3RoID4gMCkge1xuICAgIC8vIFJlLWFybSBhdXRvbWF0aWNhbGx5IG9uIHJlbG9hZCBvbmx5IHdoZW4gbWljcm9waG9uZSBwZXJtaXNzaW9uIGlzIGFscmVhZHkgZ3JhbnRlZC5cbiAgICB2b2lkIG5hdmlnYXRvci5wZXJtaXNzaW9ucz8ucXVlcnkoeyBuYW1lOiBcIm1pY3JvcGhvbmVcIiBhcyBQZXJtaXNzaW9uTmFtZSB9KVxuICAgICAgLnRoZW4oKHApID0+IHsgaWYgKHAuc3RhdGUgPT09IFwiZ3JhbnRlZFwiKSB2b2lkIGFybVdha2UodHJ1ZSwgZmFsc2UpOyB9KVxuICAgICAgLmNhdGNoKCgpID0+IHt9KTtcbiAgfVxuICBpZiAoc2F2ZWRIaXN0b3J5KCkubGVuZ3RoID4gMCkge1xuICAgIHN5bmNSZXN1bWVCdXR0b25zKHRydWUpO1xuICAgICQoXCJyZXN1bWVcIikudGl0bGUgPSBcIkNhbGwgYWdhaW4sIGNhcnJ5aW5nIG9uIGZyb20gdGhlIGxhc3QgY29udmVyc2F0aW9uXCI7XG4gIH1cbiAgJChcIm1pY1wiKS5vbmNsaWNrID0gKCkgPT4gc2V0TXV0ZWQoIW11dGVkKTtcbiAgJChcImh1c2hcIikub25jbGljayA9ICgpID0+IHsgcHVzaCh7IHR5cGU6IFwiaW50ZXJydXB0XCIgfSk7IGF1ZGlvLmZsdXNoKCk7IH07XG4gICQoXCJjYW5jZWxhbGxcIikub25jbGljayA9ICgpID0+IHB1c2goeyB0eXBlOiBcImNhbmNlbEFsbFwiIH0pO1xuICAkKFwiZG9uZWJveFwiKS5hZGRFdmVudExpc3RlbmVyKFwidG9nZ2xlXCIsICgpID0+IHsgaWYgKCQ8SFRNTERldGFpbHNFbGVtZW50PihcImRvbmVib3hcIikub3BlbikgJChcImRvbmVib3hcIikuc2Nyb2xsSW50b1ZpZXcoeyBibG9jazogXCJuZWFyZXN0XCIgfSk7IH0pO1xuICAkKFwic2F5XCIpLm9uc3VibWl0ID0gKGUpID0+IHZvaWQgc3VibWl0VGV4dChlKTtcbiAgJChcInRleHRcIikuYWRkRXZlbnRMaXN0ZW5lcihcImlucHV0XCIsIHN5bmNDb21wb3Nlcik7XG4gIGNvbnN0IHRyYW5zY3JpcHRQYW5lID0gJChcInRyYW5zY3JpcHRcIik7XG4gIHRyYW5zY3JpcHRQYW5lLmFkZEV2ZW50TGlzdGVuZXIoXCJzY3JvbGxcIiwgKCkgPT4gdHJhbnNjcmlwdFNjcm9sbC5vblNjcm9sbCgpLCB7IHBhc3NpdmU6IHRydWUgfSk7XG4gIHRyYW5zY3JpcHRQYW5lLmFkZEV2ZW50TGlzdGVuZXIoXCJzY3JvbGxlbmRcIiwgKCkgPT4gdHJhbnNjcmlwdFNjcm9sbC5vblNjcm9sbEVuZCgpLCB7IHBhc3NpdmU6IHRydWUgfSk7XG4gIHRyYW5zY3JpcHRQYW5lLmFkZEV2ZW50TGlzdGVuZXIoXCJ3aGVlbFwiLCAoZSkgPT4geyBpZiAoZS5kZWx0YVkgPCAwKSB0cmFuc2NyaXB0U2Nyb2xsLmNhbmNlbEp1bXAoKTsgfSwgeyBwYXNzaXZlOiB0cnVlIH0pO1xuICB0cmFuc2NyaXB0UGFuZS5hZGRFdmVudExpc3RlbmVyKFwidG91Y2hzdGFydFwiLCAoKSA9PiB0cmFuc2NyaXB0U2Nyb2xsLmNhbmNlbEp1bXAoKSwgeyBwYXNzaXZlOiB0cnVlIH0pO1xuICBpZiAodHlwZW9mIFJlc2l6ZU9ic2VydmVyICE9PSBcInVuZGVmaW5lZFwiKSB7XG4gICAgbmV3IFJlc2l6ZU9ic2VydmVyKCgpID0+IHRyYW5zY3JpcHRTY3JvbGwub25SZXNpemUoKSkub2JzZXJ2ZSh0cmFuc2NyaXB0UGFuZSk7XG4gICAgbmV3IFJlc2l6ZU9ic2VydmVyKCgpID0+IHVwZGF0ZUFsbFJlc3VsdENsYW1waW5nKCkpLm9ic2VydmUoJChcInJlc3VsdHNcIikpO1xuICB9XG4gICQoXCJqdW1wYm90dG9tXCIpLm9uY2xpY2sgPSAoKSA9PiB0cmFuc2NyaXB0U2Nyb2xsLmp1bXBUb0JvdHRvbSgpO1xuICBzeW5jQ29tcG9zZXIoKTtcbiAgc3luY1NpZGVMYXlvdXQoKTtcbiAgdGFicygpO1xuICBrZXlzKCk7XG4gIGNvbnN0IGV2ZW50cyA9IG5ldyBFdmVudFNvdXJjZShcIi9ldmVudHNcIik7XG4gIGV2ZW50cy5hZGRFdmVudExpc3RlbmVyKFwiY29yZVwiLCAoZSkgPT4ge1xuICAgIGNvbnN0IHsgdmVyc2lvbiB9ID0gSlNPTi5wYXJzZSgoZSBhcyBNZXNzYWdlRXZlbnQpLmRhdGEpO1xuICAgICQoXCJ2ZXJzaW9uXCIpLnRleHRDb250ZW50ID0gdmVyc2lvbiArIChjYWxsSWQgJiYgY29yZSAmJiBjb3JlLnZlcnNpb24gIT09IHZlcnNpb24gPyBgIChuZXh0IGNhbGw7IHRoaXMgb25lIHJ1bnMgJHtjb3JlLnZlcnNpb259KWAgOiBcIlwiKTtcbiAgICAkKFwiYnVpbGRcIikudGV4dENvbnRlbnQgPSBgY29yZSAke3ZlcnNpb259YDtcbiAgfSk7XG4gIGV2ZW50cy5hZGRFdmVudExpc3RlbmVyKFwiYXBwXCIsICgpID0+IHsgaWYgKCFjYWxsSWQpIGxvY2F0aW9uLnJlbG9hZCgpOyBlbHNlIHRvYXN0KFwiVGhlIHBhZ2UgY2hhbmdlZDogcmVsb2FkIGFmdGVyIHRoaXMgY2FsbFwiKTsgfSk7XG4gIGV2ZW50cy5hZGRFdmVudExpc3RlbmVyKFwiZXJyb3JcIiwgKGUpID0+IHtcbiAgICBjb25zdCBkYXRhID0gKGUgYXMgTWVzc2FnZUV2ZW50KS5kYXRhO1xuICAgIGlmIChkYXRhKSB0b2FzdChgQnVpbGQgZmFpbGVkOiAke0pTT04ucGFyc2UoZGF0YSkubWVzc2FnZX1gKTtcbiAgfSk7XG4gIG5ldyBSZXBsYXkoJChcInJlcGxheVwiKSwgbG9hZENvcmUpO1xuICB2b2lkIHBpbmcoKTtcbiAgdm9pZCBzaG93RWFybGllcigpO1xuICB3aW5kb3cuc2V0SW50ZXJ2YWwoKCkgPT4gdm9pZCBzaG93RWFybGllcigpLCAzMF8wMDApO1xufVxuXG52b2lkIG1haW4oKTtcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFTQSxJQUFNLFNBQVMsb0JBQUksSUFBSTtBQUFBLEVBQ3JCO0FBQUEsRUFBTztBQUFBLEVBQU07QUFBQSxFQUFRO0FBQUEsRUFBVTtBQUFBLEVBQU87QUFBQSxFQUFRO0FBQUEsRUFBTTtBQUFBLEVBQU07QUFBQSxFQUFNO0FBQUEsRUFBTTtBQUFBLEVBQVc7QUFBQSxFQUFTO0FBQUEsRUFBUTtBQUFBLEVBQU87QUFBQSxFQUFVO0FBQUEsRUFBUztBQUFBLEVBQzVIO0FBQ0YsQ0FBQztBQUdNLFNBQVMsTUFBTSxNQUF3QjtBQUM1QyxTQUFPLEtBQUssWUFBWSxFQUFFLFFBQVEsVUFBVSxFQUFFLEVBQUUsUUFBUSxxQkFBcUIsR0FBRyxFQUFFLEtBQUssRUFBRSxNQUFNLEdBQUcsRUFBRSxPQUFPLENBQUMsTUFBTSxFQUFFLFNBQVMsQ0FBQztBQUNoSTtBQUdPLFNBQVMsVUFBVSxXQUFtQixVQUF5QixRQUFrQixDQUFDLEdBQXdCO0FBQy9HLFFBQU0sVUFBVSxvQkFBSSxJQUFJLENBQUMsR0FBRyxRQUFRLEdBQUcsTUFBTSxRQUFRLEtBQUssQ0FBQyxDQUFDO0FBQzVELFFBQU0sT0FBTyxNQUFNLFNBQVM7QUFDNUIsTUFBSSxPQUFPO0FBQ1gsTUFBSSxLQUFLLEtBQUs7QUFDZCxTQUFPLE9BQU8sTUFBTSxRQUFRLElBQUksS0FBSyxJQUFJLENBQUMsRUFBRztBQUM3QyxTQUFPLEtBQUssUUFBUSxRQUFRLElBQUksS0FBSyxLQUFLLENBQUMsQ0FBQyxFQUFHO0FBQy9DLE1BQUksU0FBUyxNQUFNLEtBQUssT0FBTyxFQUFHLFFBQU87QUFDekMsUUFBTUEsUUFBTyxLQUFLLE1BQU0sTUFBTSxFQUFFLEVBQUUsS0FBSyxHQUFHO0FBQzFDLFFBQU0sS0FBSyxDQUFDLFlBQXNCLFFBQVEsS0FBSyxDQUFD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
