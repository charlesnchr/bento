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
  /** Latest monotonic sequence number assigned by `feed()`. */
  get lastSeq() {
    return this.seq;
  }
  /** Highest sequence number of an in-flight suppressed frame, or 0 if none are scoring. */
  get inFlightSuppressedSeq() {
    return this.lastSuppressedSeq > this.lastAckedSeq ? this.lastSuppressedSeq : 0;
  }
  /** True while at least one suppressed frame is still queued or scoring in the worker. */
  get suppressedInFlight() {
    return this.inFlightSuppressedSeq > 0;
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
function validBriefPcmBytes(pcm) {
  if (typeof pcm !== "string" || pcm.length === 0 || pcm.length % 4 !== 0) return -1;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(pcm)) return -1;
  const pad = pcm.endsWith("==") ? 2 : pcm.endsWith("=") ? 1 : 0;
  const size = Math.floor(pcm.length * 3 / 4) - pad;
  return size > 0 && size % 2 === 0 && size <= 288e4 ? size : -1;
}
var WakeAudioGate = class {
  constructor(maxDeferred = 60) {
    this.whileSpeaking = "send";
    this.speechUntil = 0;
    this.deliverMax = 30;
    this.briefWait = 3;
    this.activeBrief = null;
    this.readyBriefs = [];
    this.requestedBriefs = /* @__PURE__ */ new Map();
    this.lastCut = null;
    this.lastStoppedBriefAt = null;
    this.replayFloorSeq = 0;
    this.deferred = [];
    this.maxDeferred = maxDeferred;
  }
  reset(whileSpeaking = "send", floorSeq = 0, limits = {}) {
    this.whileSpeaking = whileSpeaking;
    this.speechUntil = 0;
    this.deliverMax = typeof limits.deliverMax === "number" ? limits.deliverMax : 30;
    this.briefWait = typeof limits.briefWait === "number" ? limits.briefWait : 3;
    this.activeBrief = null;
    this.readyBriefs = [];
    this.requestedBriefs.clear();
    this.lastCut = null;
    this.lastStoppedBriefAt = null;
    this.replayFloorSeq = floorSeq;
    this.deferred = [];
  }
  get hasDeferred() {
    return this.deferred.length > 0;
  }
  isSuppressed(t) {
    return this.whileSpeaking !== "send" && t < this.speechUntil;
  }
  onBriefRequest(id, eventTime) {
    if (id) this.requestedBriefs.set(id, eventTime);
  }
  onPlay(pcmBase64, eventTime, source) {
    const pad = pcmBase64.endsWith("==") ? 2 : pcmBase64.endsWith("=") ? 1 : 0;
    const pcmBytes = Math.max(0, Math.floor(pcmBase64.length * 3 / 4) - pad);
    this.speechUntil = Math.max(this.speechUntil, eventTime) + pcmBytes / 48e3;
    if (source === "announcer") {
      const briefAt = this.readyBriefs.shift() ?? eventTime;
      this.activeBrief = { from: eventTime, until: this.speechUntil, briefAt };
      this.lastStoppedBriefAt = null;
    }
  }
  onFlush(eventTime, hushed = false) {
    this.speechUntil = Math.min(this.speechUntil, eventTime);
    if (this.activeBrief && eventTime >= this.activeBrief.until) {
      this.activeBrief = null;
    }
    if (this.activeBrief) {
      const a = this.activeBrief;
      this.activeBrief = null;
      const played = (eventTime - a.from) / Math.max(0.1, a.until - a.from);
      if (hushed) {
        this.lastStoppedBriefAt = a.briefAt;
        this.lastCut = null;
      } else if (played < 0.8 && eventTime - a.briefAt < this.deliverMax) {
        this.readyBriefs.push(a.briefAt);
        this.lastCut = { at: eventTime, briefAt: a.briefAt };
      }
      return;
    }
    if (hushed && this.lastCut && eventTime - this.lastCut.at < 6) {
      const idx = this.readyBriefs.lastIndexOf(this.lastCut.briefAt);
      if (idx >= 0) {
        this.readyBriefs.splice(idx, 1);
        this.lastStoppedBriefAt = this.lastCut.briefAt;
      }
      this.lastCut = null;
    } else if (hushed) {
      this.lastCut = null;
    }
  }
  /** Mirrors core command side effects for playback, flushes, briefs, and voice stop commands. */
  observeCommands(commands, eventTime, eventType) {
    const hushed = eventType === "interrupt" || eventType === "stop" || commands.some((c) => c.type === "voiceCommand" && (c.command === "stop" || c.command === "cancelAll"));
    for (const c of commands) {
      if (c.type === "play" && typeof c.pcm === "string") {
        this.onPlay(c.pcm, eventTime, typeof c.source === "string" ? c.source : void 0);
      } else if (c.type === "flush") {
        this.onFlush(eventTime, hushed);
      } else if (c.type === "brief" && typeof c.id === "string") {
        this.onBriefRequest(c.id, eventTime);
      } else if (c.type === "log" && typeof c.message === "string" && c.message.startsWith("not a stop after all") && this.lastStoppedBriefAt != null) {
        this.readyBriefs.push(this.lastStoppedBriefAt);
        this.lastStoppedBriefAt = null;
      }
    }
    if (eventType === "tick" || eventType === "brief.ready") {
      for (const [id, askedAt] of this.requestedBriefs) {
        if (eventTime - askedAt >= this.briefWait) this.requestedBriefs.delete(id);
      }
    }
  }
  /**
   * Called immediately before pushing an event to the core. Returns any deferred unsuppressed
   * gap frames that must reach the core first so new playback cannot silence them.
   */
  beforePush(event, eventTime = 0) {
    let acceptedBrief = false;
    if (event.type === "brief.failed" && typeof event.id === "string") {
      this.requestedBriefs.delete(event.id);
    } else if (event.type === "brief.ready" && typeof event.id === "string") {
      if (this.requestedBriefs.delete(event.id)) {
        const valid = validBriefPcmBytes(event.pcm) > 0 && typeof event.text === "string" && event.text.trim().length > 0;
        if (valid) {
          this.readyBriefs.push(eventTime);
          acceptedBrief = true;
        }
      }
    }
    if (this.deferred.length === 0) return [];
    const canStartPlayback = acceptedBrief || this.readyBriefs.length > 0 && event.type === "tick" || event.type === "ws.message" && String(event.data ?? "").includes('"inlineData"');
    return canStartPlayback ? this.flushDeferred() : [];
  }
  flushDeferred() {
    if (this.deferred.length === 0) return [];
    const items = this.deferred.splice(0);
    for (const item of items) {
      if (item.floorSeq > this.replayFloorSeq) this.replayFloorSeq = item.floorSeq;
    }
    return items.map(({ pcm, t }) => ({ pcm, t }));
  }
  /** Detaches deferred frames before `push({ type: "wake" })` without bumping `replayFloorSeq` yet. */
  takeDeferred() {
    return this.deferred.splice(0);
  }
  onMicFrame(params) {
    const floorSeq = params.seq > 0 ? params.seq : params.lastSeq;
    if (!params.suppressed && this.whileSpeaking !== "send" && params.inFlightSuppressedSeq > this.replayFloorSeq) {
      this.deferred.push({ seq: params.seq, floorSeq, pcm: params.pcm, t: params.t });
      if (this.deferred.length > this.maxDeferred) return this.flushDeferred();
      return [];
    }
    const out = this.flushDeferred();
    if (!params.suppressed && floorSeq > this.replayFloorSeq) {
      this.replayFloorSeq = floorSeq;
    }
    out.push({ pcm: params.pcm, t: params.t });
    return out;
  }
  /**
   * Computes the ordered mic frames to replay after `push({ type: "wake" })`, skipping any chunk
   * at or below `replayFloorSeq` so already-forwarded gap frames are never followed by older audio.
   */
  planWakeReplay(hit, deferred, bytesToBase642) {
    const deferredSeqs = new Set(deferred.map((d) => d.seq).filter((s) => s > 0));
    const out = [];
    const replayedSeqs = /* @__PURE__ */ new Set();
    let maxFloor = this.replayFloorSeq;
    for (const chunk of hit.trailing) {
      if (chunk.bytes.byteLength === 0) continue;
      if (chunk.seq <= this.replayFloorSeq) continue;
      if (!chunk.suppressed && !deferredSeqs.has(chunk.seq)) continue;
      if (chunk.seq > 0) {
        replayedSeqs.add(chunk.seq);
        if (chunk.seq > maxFloor) maxFloor = chunk.seq;
      }
      out.push({ pcm: bytesToBase642(chunk.bytes) });
    }
    for (const item of deferred) {
      if (item.floorSeq > maxFloor) maxFloor = item.floorSeq;
      if (item.seq > 0 && replayedSeqs.has(item.seq)) continue;
      out.push({ pcm: item.pcm, t: item.t });
    }
    this.replayFloorSeq = maxFloor;
    return out;
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
var wakeGate = new WakeAudioGate();
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
  const flushed = wakeGate.beforePush(event, t);
  if (medium === "voice") {
    for (const item of flushed) {
      if (!callId) break;
      counts.mic++;
      push({ type: "mic", pcm: item.pcm }, item.t);
    }
  }
  const e = { ...event, t };
  const quiet = e.type === "mic" || e.type === "tick";
  if (!quiet) log("in", e.type === "ws.message" ? `ws ${e.sid} \u2190 ${brief(String(e.data))}` : JSON.stringify(e).slice(0, 400), "in");
  const commands = JSON.parse(core.push(callId, JSON.stringify(e)));
  run2(commands, t, typeof event.type === "string" ? event.type : void 0);
  return commands;
}
function run2(commands, eventTime = now(), eventType) {
  wakeGate.observeCommands(commands, eventTime, eventType);
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
function flushDeferredMic() {
  const items = wakeGate.flushDeferred();
  if (!callId || medium !== "voice") return;
  for (const item of items) {
    if (!callId) break;
    counts.mic++;
    push({ type: "mic", pcm: item.pcm }, item.t);
  }
}
function onMic(samples, level) {
  const t = now();
  const suppressed = callId !== 0 && medium === "voice" && wakeGate.isSuppressed(t);
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
  const toSend = wakeGate.onMicFrame({
    pcm,
    t,
    seq,
    lastSeq: wakeClient.lastSeq,
    inFlightSuppressedSeq: wakeClient.inFlightSuppressedSeq,
    suppressed
  });
  for (const item of toSend) {
    if (!callId) break;
    counts.mic++;
    push({ type: "mic", pcm: item.pcm }, item.t);
  }
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
    const limitsCfg = given.limits && typeof given.limits === "object" ? given.limits : null;
    const announceCfg = given.announce && typeof given.announce === "object" ? given.announce : null;
    wakeGate.reset(typeof micCfg?.whileSpeaking === "string" ? micCfg.whileSpeaking : "send", wakeClient.lastSeq, {
      deliverMax: typeof limitsCfg?.deliverMax === "number" ? limitsCfg.deliverMax : 30,
      briefWait: typeof announceCfg?.briefWait === "number" ? announceCfg.briefWait : 3
    });
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
  wakeGate.reset("send", wakeClient.lastSeq);
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
      const preserveInFlight = wakePeriodCallId === callId && wakeClient.modelId === model.id && wakeClient.suppressedInFlight;
      wakePeriodCallId = callId;
      if (!wakeClient.ready || wakeClient.modelId !== model.id) wakeLoading = true;
      wakeClient.load(model.id, wakeThreshold());
      if (!preserveInFlight) wakeClient.reset();
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
    const deferred = wakeGate.takeDeferred();
    push({ type: "wake" });
    for (const item of wakeGate.planWakeReplay(hit, deferred, bytesToBase64)) {
      if (!callId) break;
      counts.mic++;
      if (item.t !== void 0) push({ type: "mic", pcm: item.pcm }, item.t);
      else push({ type: "mic", pcm: item.pcm });
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
      wakeClient.reset();
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL2NvbW1hbmRzLnRzIiwgIi4uL2F1ZGlvLnRzIiwgIi4uL3JlcGxheS50cyIsICIuLi9zY3JvbGwudHMiLCAiLi4vdWkudHMiLCAiLi4vd2FrZUNsaWVudC50cyIsICIuLi9hcHAudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFNwb2tlbiBjb21tYW5kcyB0aGUgY29yZSBhY3RzIG9uIHdpdGhvdXQgdGhlIG1vZGVsOiBcInN0b3BcIiBhbmQgXCJoYW5nIHVwXCIuIEFuIHV0dGVyYW5jZSBjb3VudHNcbi8vIG9ubHkgd2hlbiBpdCBpcyBvbmUgb2YgdGhlIHBocmFzZXMgYW5kIG5vdGhpbmcgbW9yZSwgb25jZSBuYW1lcyBhbmQgZmlsbGVycyBhcm91bmQgaXQgYXJlIGdvbmUsXG4vLyBzbyBcIldvb2Rob3VzZSwgc3RvcCBwbGVhc2VcIiBzdG9wcyBhbmQgXCJzdG9wIHRoZSBQZW5ueXdvcnRoIHRhc2tcIiBnb2VzIHRvIHRoZSBtb2RlbCBhcyB1c3VhbC5cblxuaW1wb3J0IHR5cGUgeyBWb2ljZUNvbW1hbmRzIH0gZnJvbSBcIi4vdHlwZXMudHNcIjtcblxuZXhwb3J0IHR5cGUgVm9pY2VDb21tYW5kID0gXCJzdG9wXCIgfCBcImhhbmdVcFwiIHwgXCJjYW5jZWxBbGxcIjtcblxuLyoqIFdvcmRzIHRoYXQgbWF5IGNvbWUgYmVmb3JlIG9yIGFmdGVyIGEgY29tbWFuZCB3aXRob3V0IGNoYW5naW5nIGl0LiAqL1xuY29uc3QgRklMTEVSID0gbmV3IFNldChbXG4gIFwiaGV5XCIsIFwib2tcIiwgXCJva2F5XCIsIFwicGxlYXNlXCIsIFwibm93XCIsIFwianVzdFwiLCBcInNvXCIsIFwidW1cIiwgXCJ1aFwiLCBcIm9oXCIsIFwiYWxyaWdodFwiLCBcInJpZ2h0XCIsIFwieWVhaFwiLCBcInllc1wiLCBcInRoYW5rc1wiLCBcInRoYW5rXCIsIFwieW91XCIsXG4gIFwiZ2VtaW5pXCIsXG5dKTtcblxuLyoqIFt0ZXh0XSBhcyBsb3dlci1jYXNlIHdvcmRzLCBhcG9zdHJvcGhlcyBkcm9wcGVkIChcIlRoYXQnc1wiIGlzIFwidGhhdHNcIikuICovXG5leHBvcnQgZnVuY3Rpb24gd29yZHModGV4dDogc3RyaW5nKTogc3RyaW5nW10ge1xuICByZXR1cm4gdGV4dC50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL1snXHUyMDE5YF0vZywgXCJcIikucmVwbGFjZSgvW15cXHB7TH1cXHB7TmR9XSsvZ3UsIFwiIFwiKS50cmltKCkuc3BsaXQoXCIgXCIpLmZpbHRlcigodykgPT4gdy5sZW5ndGggPiAwKTtcbn1cblxuLyoqIFRoZSBjb21tYW5kIFt1dHRlcmFuY2VdIGlzLCBpZiBpdCdzIG9uZSBhbmQgbm90aGluZyBtb3JlOyBbbmFtZXNdICh0aGUgYXNzaXN0YW50J3MsIFwiV29vZGhvdXNlXCIpIGRvbid0IGNvdW50LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbW1hbmRJbih1dHRlcmFuY2U6IHN0cmluZywgY29tbWFuZHM6IFZvaWNlQ29tbWFuZHMsIG5hbWVzOiBzdHJpbmdbXSA9IFtdKTogVm9pY2VDb21tYW5kIHwgbnVsbCB7XG4gIGNvbnN0IGlnbm9yZWQgPSBuZXcgU2V0KFsuLi5GSUxMRVIsIC4uLm5hbWVzLmZsYXRNYXAod29yZHMpXSk7XG4gIGNvbnN0IHNhaWQgPSB3b3Jkcyh1dHRlcmFuY2UpO1xuICBsZXQgZnJvbSA9IDA7XG4gIGxldCB0byA9IHNhaWQubGVuZ3RoO1xuICB3aGlsZSAoZnJvbSA8IHRvICYmIGlnbm9yZWQuaGFzKHNhaWRbZnJvbV0pKSBmcm9tKys7XG4gIHdoaWxlICh0byA+IGZyb20gJiYgaWdub3JlZC5oYXMoc2FpZFt0byAtIDFdKSkgdG8tLTtcbiAgaWYgKGZyb20gPT09IHRvIHx8IHRvIC0gZnJvbSA+IDUpIHJldHVybiBudWxsO1xuICBjb25zdCBjb3JlID0gc2FpZC5zbGljZShmcm9tLCB0bykuam9pbihcIiBcIik7XG4gIGNvbnN0IGlzID0gKHBocmFzZXM6IHN0cmluZ1tdKSA9PiBwaHJhc2VzLnNvbWUoKHApID0+IHdvcmRzKHApLmpvaW4oXCIgXCIpID09PSBjb3JlKTtcbiAgaWYgKGlzKGNvbW1hbmRzLmhhbmdVcCkpIHJldHVybiBcImhhbmdVcFwiO1xuICBpZiAoaXMoY29tbWFuZHMuY2FuY2VsQWxsID8/IFtdKSkgcmV0dXJuIFwiY2FuY2VsQWxsXCI7XG4gIGlmIChpcyhjb21tYW5kcy5zdG9wKSkgcmV0dXJuIFwic3RvcFwiO1xuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqIFdvcmRzIHRoYXQgdGFrZSBhIHJlcXVlc3QgYmFjay4gKi9cbmNvbnN0IENBTkNFTFMgPSAvXFxiKD86Y2FuY2VsXFx3KnxhYm9ydFxcdyp8a2lsbHxzY3JhcHxzY3JhdGNofGRyb3B8Zm9yZ2V0fHVuZG98dGVybWluYXRlfG5ldmVyID9taW5kfGNhbGwgKD86aXR8dGhhdHx0aGlzKSBvZmZ8KD86ZG9udHxkbyBub3QpICg/OmJvdGhlcnxuZWVkfHdhbnR8ZG8pfG5vIG5lZWR8bm8gbG9uZ2VyfG5vdCBhbnltb3JlfGxlYXZlIGl0fHNraXAgKD86aXR8dGhhdCkpXFxiLztcbmNvbnN0IFNUT1BTID0gL1xcYig/OnN0b3BcXHcqfGhhbHR8cXVpdHxlbmQpXFxiLztcblxuLyoqXG4gKiBXaGV0aGVyIFt1dHRlcmFuY2VdIGFza3MgZm9yIGEgdGFzayB0byBiZSBjYW5jZWxsZWQsIGZvciBhIGNhbmNlbF90YXNrIHRoZSBtb2RlbCBjYWxsZWQgb24gaXQuIFwiU3RvcFwiIGFsb25lIGFuZCB0aGVcbiAqIG90aGVyIHN0b3AgYW5kIGhhbmctdXAgcGhyYXNlcyBkb24ndDogdGhleSBtZWFuIHN0b3AgdGFsa2luZy4gT3RoZXJ3aXNlIGl0IGRvZXMgd2hlbiBpdCBzYXlzIHNvIGluIHdvcmRzLCB3aGVuIGl0XG4gKiBuYW1lcyB0aGUgdGFzayAoW25hbWVkXSksIG9yIHdoZW4gaXQgc2F5cyB0byBzdG9wIHNvbWV0aGluZyBtb3JlIHRoYW4gdGhlIHRhbGtpbmcgKFwic3RvcCB3b3JraW5nIG9uIHRoYXRcIikuXG4gKiBXb3JkcyB0aGF0IHNheSBub25lIG9mIHRoaXMgKGEgbWlzaGVhcmluZyBzdWNoIGFzIFwiU3RhYml0XCIpIGRvbid0LiBXaXRoIG5vdGhpbmcgaGVhcmQgdGhlcmUgaXMgbm90aGluZyB0byBqdWRnZSBieS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFza3NUb0NhbmNlbCh1dHRlcmFuY2U6IHN0cmluZywgY29tbWFuZHM6IFZvaWNlQ29tbWFuZHMsIG5hbWVzOiBzdHJpbmdbXSwgbmFtZWQ6IGJvb2xlYW4pOiBib29sZWFuIHtcbiAgY29uc3Qgc2FpZCA9IHdvcmRzKHV0dGVyYW5jZSkuam9pbihcIiBcIik7XG4gIGlmIChzYWlkLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHRydWU7XG4gIGNvbnN0IGNvbW1hbmQgPSBjb21tYW5kSW4odXR0ZXJhbmNlLCBjb21tYW5kcywgbmFtZXMpO1xuICBpZiAoY29tbWFuZCA9PT0gXCJzdG9wXCIgfHwgY29tbWFuZCA9PT0gXCJoYW5nVXBcIikgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gY29tbWFuZCA9PT0gXCJjYW5jZWxBbGxcIiB8fCBuYW1lZCB8fCBDQU5DRUxTLnRlc3Qoc2FpZCkgfHwgU1RPUFMudGVzdChzYWlkKTtcbn1cbiIsICIvLyBUaGUgYnJvd3NlcidzIG1pY3JvcGhvbmUgYW5kIHNwZWFrZXIgZm9yIGEgY2FsbDogMTYga0h6IFBDTTE2IGZyYW1lcyBvdXQgb2YgdGhlIG1pY3JvcGhvbmUsXG4vLyAyNCBrSHogUENNMTYgaW50byB0aGUgc3BlYWtlciwgYW5kIHRvbmVzIGxhaWQgb3ZlciB3aGF0ZXZlciBwbGF5cy4gQm90aCBydW4gaW4gQXVkaW9Xb3JrbGV0cyBvblxuLy8gb25lIEF1ZGlvQ29udGV4dCBhdCB0aGUgZGV2aWNlJ3MgcmF0ZSwgcmVzYW1wbGluZyB0aGVyZS5cblxuY29uc3QgV09SS0xFVFMgPSBgXG5jbGFzcyBDYXB0dXJlIGV4dGVuZHMgQXVkaW9Xb3JrbGV0UHJvY2Vzc29yIHtcbiAgY29uc3RydWN0b3IoKSB7XG4gICAgc3VwZXIoKTtcbiAgICB0aGlzLnN0ZXAgPSBzYW1wbGVSYXRlIC8gMTYwMDA7XG4gICAgdGhpcy5wb3MgPSAwO1xuICAgIHRoaXMuZnJhbWUgPSBuZXcgSW50MTZBcnJheSgzMjApO1xuICAgIHRoaXMubiA9IDA7XG4gICAgLy8gQSB3aW5kb3dlZC1zaW5jIGxvdy1wYXNzIGF0IDcga0h6LCBzbyBub3RoaW5nIGFib3ZlIDE2IGtIeidzIDgga0h6IGxpbWl0IGZvbGRzIGJhY2sgaW50byBzcGVlY2guXG4gICAgY29uc3QgdGFwcyA9IDQ3LCBjdXQgPSA3MDAwIC8gc2FtcGxlUmF0ZTtcbiAgICB0aGlzLnRhcHMgPSBuZXcgRmxvYXQzMkFycmF5KHRhcHMpO1xuICAgIGxldCBzdW0gPSAwO1xuICAgIGZvciAobGV0IGsgPSAwOyBrIDwgdGFwczsgaysrKSB7XG4gICAgICBjb25zdCBtID0gayAtICh0YXBzIC0gMSkgLyAyO1xuICAgICAgY29uc3Qgc2luYyA9IG0gPT09IDAgPyAyICogY3V0IDogTWF0aC5zaW4oMiAqIE1hdGguUEkgKiBjdXQgKiBtKSAvIChNYXRoLlBJICogbSk7XG4gICAgICBjb25zdCB3ID0gMC40MiAtIDAuNSAqIE1hdGguY29zKCgyICogTWF0aC5QSSAqIGspIC8gKHRhcHMgLSAxKSkgKyAwLjA4ICogTWF0aC5jb3MoKDQgKiBNYXRoLlBJICogaykgLyAodGFwcyAtIDEpKTtcbiAgICAgIHRoaXMudGFwc1trXSA9IHNpbmMgKiB3O1xuICAgICAgc3VtICs9IHRoaXMudGFwc1trXTtcbiAgICB9XG4gICAgZm9yIChsZXQgayA9IDA7IGsgPCB0YXBzOyBrKyspIHRoaXMudGFwc1trXSAvPSBzdW07XG4gICAgdGhpcy5oaXN0b3J5ID0gbmV3IEZsb2F0MzJBcnJheSh0YXBzKTtcbiAgICB0aGlzLmF0ID0gMDtcbiAgfVxuICBwcm9jZXNzKGlucHV0cykge1xuICAgIGNvbnN0IGlucHV0ID0gaW5wdXRzWzBdICYmIGlucHV0c1swXVswXTtcbiAgICBpZiAoIWlucHV0KSByZXR1cm4gdHJ1ZTtcbiAgICBjb25zdCB0YXBzID0gdGhpcy50YXBzLCBoID0gdGhpcy5oaXN0b3J5LCBuID0gdGFwcy5sZW5ndGg7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBpbnB1dC5sZW5ndGg7IGkrKykge1xuICAgICAgaFt0aGlzLmF0XSA9IGlucHV0W2ldO1xuICAgICAgdGhpcy5hdCA9ICh0aGlzLmF0ICsgMSkgJSBuO1xuICAgICAgLy8gT25seSB0aGUgc2FtcGxlcyBrZXB0IG5lZWQgZmlsdGVyaW5nOiBhdCBtb3N0IG9uZSBpbiBldmVyeSBzdGVwLlxuICAgICAgaWYgKHRoaXMucG9zID4gMSkgeyB0aGlzLnBvcyAtPSAxOyBjb250aW51ZTsgfVxuICAgICAgbGV0IHggPSAwO1xuICAgICAgZm9yIChsZXQgayA9IDAsIGogPSB0aGlzLmF0OyBrIDwgbjsgaysrLCBqID0gaiArIDEgPT09IG4gPyAwIDogaiArIDEpIHggKz0gdGFwc1trXSAqIGhbal07XG4gICAgICB3aGlsZSAodGhpcy5wb3MgPD0gMSkge1xuICAgICAgICBjb25zdCBzID0gTWF0aC5tYXgoLTEsIE1hdGgubWluKDEsIHgpKTtcbiAgICAgICAgdGhpcy5mcmFtZVt0aGlzLm4rK10gPSBzIDwgMCA/IHMgKiAzMjc2OCA6IHMgKiAzMjc2NztcbiAgICAgICAgaWYgKHRoaXMubiA9PT0gdGhpcy5mcmFtZS5sZW5ndGgpIHtcbiAgICAgICAgICB0aGlzLnBvcnQucG9zdE1lc3NhZ2UodGhpcy5mcmFtZS5idWZmZXIsIFt0aGlzLmZyYW1lLmJ1ZmZlcl0pO1xuICAgICAgICAgIHRoaXMuZnJhbWUgPSBuZXcgSW50MTZBcnJheSgzMjApO1xuICAgICAgICAgIHRoaXMubiA9IDA7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5wb3MgKz0gdGhpcy5zdGVwO1xuICAgICAgfVxuICAgICAgdGhpcy5wb3MgLT0gMTtcbiAgICB9XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbn1cblxuY2xhc3MgUGxheWJhY2sgZXh0ZW5kcyBBdWRpb1dvcmtsZXRQcm9jZXNzb3Ige1xuICBjb25zdHJ1Y3RvcigpIHtcbiAgICBzdXBlcigpO1xuICAgIHRoaXMucXVldWUgPSBbXTsgICAgICAvLyBGbG9hdDMyQXJyYXlzIGF0IHRoZSBjb250ZXh0J3MgcmF0ZVxuICAgIHRoaXMub2Zmc2V0ID0gMDtcbiAgICB0aGlzLmN1ZXMgPSBbXTtcbiAgICB0aGlzLmN1ZU9mZnNldCA9IDA7XG4gICAgdGhpcy5yZXBvcnRlZCA9IDA7XG4gICAgdGhpcy5wb3J0Lm9ubWVzc2FnZSA9IChlKSA9PiB7XG4gICAgICBjb25zdCBtID0gZS5kYXRhO1xuICAgICAgaWYgKG0udHlwZSA9PT0gXCJwbGF5XCIpIHRoaXMucXVldWUucHVzaChtLnNhbXBsZXMpO1xuICAgICAgZWxzZSBpZiAobS50eXBlID09PSBcImN1ZVwiKSB0aGlzLmN1ZXMucHVzaChtLnNhbXBsZXMpO1xuICAgICAgZWxzZSBpZiAobS50eXBlID09PSBcImZsdXNoXCIpIHsgdGhpcy5xdWV1ZSA9IFtdOyB0aGlzLm9mZnNldCA9IDA7IH1cbiAgICAgIGVsc2UgaWYgKG0udHlwZSA9PT0gXCJzdG9wXCIpIHsgdGhpcy5xdWV1ZSA9IFtdOyB0aGlzLm9mZnNldCA9IDA7IHRoaXMuY3VlcyA9IFtdOyB0aGlzLmN1ZU9mZnNldCA9IDA7IH1cbiAgICB9O1xuICB9XG4gIHByb2Nlc3MoXywgb3V0cHV0cykge1xuICAgIGNvbnN0IG91dCA9IG91dHB1dHNbMF1bMF07XG4gICAgb3V0LmZpbGwoMCk7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoICYmIHRoaXMucXVldWUubGVuZ3RoOyBpKyspIHtcbiAgICAgIG91dFtpXSA9IHRoaXMucXVldWVbMF1bdGhpcy5vZmZzZXQrK107XG4gICAgICBpZiAodGhpcy5vZmZzZXQgPj0gdGhpcy5xdWV1ZVswXS5sZW5ndGgpIHsgdGhpcy5xdWV1ZS5zaGlmdCgpOyB0aGlzLm9mZnNldCA9IDA7IH1cbiAgICB9XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoICYmIHRoaXMuY3Vlcy5sZW5ndGg7IGkrKykge1xuICAgICAgb3V0W2ldID0gTWF0aC5tYXgoLTEsIE1hdGgubWluKDEsIG91dFtpXSArIHRoaXMuY3Vlc1swXVt0aGlzLmN1ZU9mZnNldCsrXSkpO1xuICAgICAgaWYgKHRoaXMuY3VlT2Zmc2V0ID49IHRoaXMuY3Vlc1swXS5sZW5ndGgpIHsgdGhpcy5jdWVzLnNoaWZ0KCk7IHRoaXMuY3VlT2Zmc2V0ID0gMDsgfVxuICAgIH1cbiAgICBmb3IgKGxldCBjID0gMTsgYyA8IG91dHB1dHNbMF0ubGVuZ3RoOyBjKyspIG91dHB1dHNbMF1bY10uc2V0KG91dCk7XG4gICAgaWYgKGN1cnJlbnRUaW1lIC0gdGhpcy5yZXBvcnRlZCA+IDAuMSkge1xuICAgICAgdGhpcy5yZXBvcnRlZCA9IGN1cnJlbnRUaW1lO1xuICAgICAgbGV0IHF1ZXVlZCA9IC10aGlzLm9mZnNldDtcbiAgICAgIGZvciAoY29uc3QgcSBvZiB0aGlzLnF1ZXVlKSBxdWV1ZWQgKz0gcS5sZW5ndGg7XG4gICAgICB0aGlzLnBvcnQucG9zdE1lc3NhZ2UoeyBxdWV1ZWQ6IHF1ZXVlZCAvIHNhbXBsZVJhdGUgfSk7XG4gICAgfVxuICAgIHJldHVybiB0cnVlO1xuICB9XG59XG5yZWdpc3RlclByb2Nlc3NvcihcImNhcHR1cmVcIiwgQ2FwdHVyZSk7XG5yZWdpc3RlclByb2Nlc3NvcihcInBsYXliYWNrXCIsIFBsYXliYWNrKTtcbmA7XG5cbmZ1bmN0aW9uIGJhc2U2NFRvQnl0ZXMoYjY0OiBzdHJpbmcpOiBVaW50OEFycmF5IHtcbiAgY29uc3QgYmluID0gYXRvYihiNjQpO1xuICBjb25zdCBvdXQgPSBuZXcgVWludDhBcnJheShiaW4ubGVuZ3RoKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBiaW4ubGVuZ3RoOyBpKyspIG91dFtpXSA9IGJpbi5jaGFyQ29kZUF0KGkpO1xuICByZXR1cm4gb3V0O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYnl0ZXNUb0Jhc2U2NChieXRlczogVWludDhBcnJheSk6IHN0cmluZyB7XG4gIGxldCBiaW4gPSBcIlwiO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGJ5dGVzLmxlbmd0aDsgaSArPSAweDgwMDApIGJpbiArPSBTdHJpbmcuZnJvbUNoYXJDb2RlKC4uLmJ5dGVzLnN1YmFycmF5KGksIGkgKyAweDgwMDApKTtcbiAgcmV0dXJuIGJ0b2EoYmluKTtcbn1cblxuLyoqIFBDTTE2IGxpdHRsZS1lbmRpYW4gYXQgW3JhdGVdLCBhcyBmbG9hdHMgYXQgdGhlIGNvbnRleHQncyByYXRlLiAqL1xuZnVuY3Rpb24gdG9GbG9hdHMocGNtOiBVaW50OEFycmF5LCByYXRlOiBudW1iZXIsIHRhcmdldDogbnVtYmVyKTogRmxvYXQzMkFycmF5IHtcbiAgY29uc3QgdmlldyA9IG5ldyBEYXRhVmlldyhwY20uYnVmZmVyLCBwY20uYnl0ZU9mZnNldCwgcGNtLmJ5dGVMZW5ndGgpO1xuICBjb25zdCBuID0gTWF0aC5mbG9vcihwY20uYnl0ZUxlbmd0aCAvIDIpO1xuICBjb25zdCBvdXQgPSBuZXcgRmxvYXQzMkFycmF5KE1hdGguZmxvb3IoKG4gKiB0YXJnZXQpIC8gcmF0ZSkpO1xuICBjb25zdCBzdGVwID0gcmF0ZSAvIHRhcmdldDtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCB4ID0gaSAqIHN0ZXA7XG4gICAgY29uc3QgaiA9IE1hdGguZmxvb3IoeCk7XG4gICAgY29uc3QgYSA9IHZpZXcuZ2V0SW50MTYoMiAqIE1hdGgubWluKGosIG4gLSAxKSwgdHJ1ZSk7XG4gICAgY29uc3QgYiA9IHZpZXcuZ2V0SW50MTYoMiAqIE1hdGgubWluKGogKyAxLCBuIC0gMSksIHRydWUpO1xuICAgIG91dFtpXSA9IChhICsgKGIgLSBhKSAqICh4IC0gaikpIC8gMzI3Njg7XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBNaWNPcHRpb25zIHsgZWNob0NhbmNlbGxhdGlvbjogYm9vbGVhbjsgbm9pc2VTdXBwcmVzc2lvbjogYm9vbGVhbjsgYXV0b0dhaW5Db250cm9sOiBib29sZWFuIH1cblxuZXhwb3J0IGNsYXNzIENhbGxBdWRpbyB7XG4gIHByaXZhdGUgY29udGV4dDogQXVkaW9Db250ZXh0IHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgcGxheWJhY2s6IEF1ZGlvV29ya2xldE5vZGUgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBjYXB0dXJlOiBBdWRpb1dvcmtsZXROb2RlIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgc3RyZWFtOiBNZWRpYVN0cmVhbSB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIHNvdXJjZTogTWVkaWFTdHJlYW1BdWRpb1NvdXJjZU5vZGUgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBtaWNPcHRzOiBNaWNPcHRpb25zIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgb25NaWNGcmFtZTogKChzYW1wbGVzOiBJbnQxNkFycmF5LCBsZXZlbDogbnVtYmVyKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuICAvKiogSW5jcmVtZW50ZWQgb24gZXZlcnkgc3RhcnRNaWMvc3RvcE1pYyBzbyBzdXBlcnNlZGVkIG9yIGNhbmNlbGxlZCBnZXRVc2VyTWVkaWEgY2FsbHMgbmV2ZXIgbGVhayB0cmFja3MuICovXG4gIHByaXZhdGUgbWljR2VuID0gMDtcbiAgcHJpdmF0ZSBvcGVuaW5nOiBQcm9taXNlPHZvaWQ+IHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgc3RhdGVMaXN0ZW5lcjogKCgpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XG4gIC8qKiBTZWNvbmRzIG9mIHNwZWVjaCBxdWV1ZWQsIGFzIHRoZSB3b3JrbGV0IGxhc3Qgc2FpZC4gKi9cbiAgcXVldWVkID0gMDtcbiAgLyoqIFRoZSBtaWNyb3Bob25lJ3MgbGV2ZWwsIFJNUyBvZiB0aGUgbGFzdCBmcmFtZSAoMCB0byAxKS4gKi9cbiAgbGV2ZWwgPSAwO1xuXG4gIG9uQXVkaW9TdGF0ZUNoYW5nZShsaXN0ZW5lcjogKCgpID0+IHZvaWQpIHwgbnVsbCk6IHZvaWQge1xuICAgIHRoaXMuc3RhdGVMaXN0ZW5lciA9IGxpc3RlbmVyO1xuICB9XG5cbiAgLyoqIFRydWUgd2hlbiBhbiBBdWRpb0NvbnRleHQgZXhpc3RzIGJ1dCB0aGUgYnJvd3NlciBzdXNwZW5kZWQgaXQgcGVuZGluZyBhIHVzZXIgZ2VzdHVyZS4gKi9cbiAgZ2V0IGF1ZGlvU3VzcGVuZGVkKCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLmNvbnRleHQgIT0gbnVsbCAmJiB0aGlzLmNvbnRleHQuc3RhdGUgIT09IFwicnVubmluZ1wiO1xuICB9XG5cbiAgYXN5bmMgcmVzdW1lQXVkaW8oKTogUHJvbWlzZTxib29sZWFuPiB7XG4gICAgY29uc3QgY3R4ID0gdGhpcy5jb250ZXh0O1xuICAgIGlmICghY3R4KSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKGN0eC5zdGF0ZSA9PT0gXCJydW5uaW5nXCIpIHJldHVybiB0cnVlO1xuICAgIHRyeSB7IGF3YWl0IGN0eC5yZXN1bWUoKTsgfSBjYXRjaCB7fVxuICAgIHJldHVybiAoY3R4LnN0YXRlIGFzIEF1ZGlvQ29udGV4dFN0YXRlKSA9PT0gXCJydW5uaW5nXCI7XG4gIH1cblxuICBhc3luYyBvcGVuKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICh0aGlzLm9wZW5pbmcpIHtcbiAgICAgIGF3YWl0IHRoaXMub3BlbmluZztcbiAgICAgIGlmICh0aGlzLmNvbnRleHQ/LnN0YXRlID09PSBcInN1c3BlbmRlZFwiKSBhd2FpdCB0aGlzLmNvbnRleHQucmVzdW1lKCkuY2F0Y2goKCkgPT4ge30pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAodGhpcy5jb250ZXh0KSB7IGlmICh0aGlzLmNvbnRleHQuc3RhdGUgPT09IFwic3VzcGVuZGVkXCIpIGF3YWl0IHRoaXMuY29udGV4dC5yZXN1bWUoKS5jYXRjaCgoKSA9PiB7fSk7IHJldHVybjsgfVxuICAgIGNvbnN0IGluaXQgPSAoYXN5bmMgKCkgPT4ge1xuICAgICAgbGV0IGN0eDogQXVkaW9Db250ZXh0IHwgbnVsbCA9IG51bGw7XG4gICAgICB0cnkge1xuICAgICAgICBjdHggPSBuZXcgQXVkaW9Db250ZXh0KHsgbGF0ZW5jeUhpbnQ6IFwiaW50ZXJhY3RpdmVcIiB9KTtcbiAgICAgICAgY3R4Lm9uc3RhdGVjaGFuZ2UgPSAoKSA9PiB0aGlzLnN0YXRlTGlzdGVuZXI/LigpO1xuICAgICAgICBjb25zdCB1cmwgPSBVUkwuY3JlYXRlT2JqZWN0VVJMKG5ldyBCbG9iKFtXT1JLTEVUU10sIHsgdHlwZTogXCJ0ZXh0L2phdmFzY3JpcHRcIiB9KSk7XG4gICAgICAgIGF3YWl0IGN0eC5hdWRpb1dvcmtsZXQuYWRkTW9kdWxlKHVybCk7XG4gICAgICAgIGNvbnN0IHBsYXliYWNrID0gbmV3IEF1ZGlvV29ya2xldE5vZGUoY3R4LCBcInBsYXliYWNrXCIsIHsgbnVtYmVyT2ZJbnB1dHM6IDAsIG91dHB1dENoYW5uZWxDb3VudDogWzJdIH0pO1xuICAgICAgICBwbGF5YmFjay5wb3J0Lm9ubWVzc2FnZSA9IChlKSA9PiB7IHRoaXMucXVldWVkID0gZS5kYXRhLnF1ZXVlZDsgfTtcbiAgICAgICAgcGxheWJhY2suY29ubmVjdChjdHguZGVzdGluYXRpb24pO1xuICAgICAgICB0aGlzLmNvbnRleHQgPSBjdHg7XG4gICAgICAgIHRoaXMucGxheWJhY2sgPSBwbGF5YmFjaztcbiAgICAgICAgdGhpcy5zdGF0ZUxpc3RlbmVyPy4oKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICB0cnkgeyBhd2FpdCBjdHg/LmNsb3NlPy4oKTsgfSBjYXRjaCB7fVxuICAgICAgICB0aHJvdyBlcnI7XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICB0aGlzLm9wZW5pbmcgPSBudWxsO1xuICAgICAgfVxuICAgIH0pKCk7XG4gICAgdGhpcy5vcGVuaW5nID0gaW5pdDtcbiAgICBhd2FpdCBpbml0O1xuICB9XG5cbiAgLyoqIFNlY29uZHMgZnJvbSBhIHNhbXBsZSBsZWF2aW5nIHRoZSB3b3JrbGV0IHRvIHRoZSBzcGVha2VyLCBhcyB0aGUgYnJvd3NlciByZWNrb25zIGl0LiAqL1xuICBnZXQgb3V0cHV0TGF0ZW5jeSgpOiBudW1iZXIgfCBudWxsIHtcbiAgICBpZiAoIXRoaXMuY29udGV4dCkgcmV0dXJuIG51bGw7XG4gICAgcmV0dXJuIHRoaXMuY29udGV4dC5iYXNlTGF0ZW5jeSArICgodGhpcy5jb250ZXh0IGFzIEF1ZGlvQ29udGV4dCAmIHsgb3V0cHV0TGF0ZW5jeT86IG51bWJlciB9KS5vdXRwdXRMYXRlbmN5ID8/IDApO1xuICB9XG5cbiAgZ2V0IG1pY0FjdGl2ZSgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5jYXB0dXJlICE9IG51bGwgJiYgdGhpcy5zdHJlYW0gIT0gbnVsbCAmJiB0aGlzLnN0cmVhbS5nZXRUcmFja3MoKS5zb21lKCh0KSA9PiB0LnJlYWR5U3RhdGUgPT09IFwibGl2ZVwiKTtcbiAgfVxuXG4gIC8qKiBTdGFydHMgdGhlIG1pY3JvcGhvbmUgaWYgaXQgaXNuJ3QgYWxyZWFkeSBydW5uaW5nIHdpdGggdGhlIHNhbWUgb3B0aW9uczsgb3RoZXJ3aXNlIHN3YXBzIHRoZSBmcmFtZSBjYWxsYmFjayBjbGVhbmx5LiAqL1xuICBhc3luYyBlbnN1cmVNaWMob25GcmFtZTogKHNhbXBsZXM6IEludDE2QXJyYXksIGxldmVsOiBudW1iZXIpID0+IHZvaWQsIG9wdGlvbnM6IE1pY09wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAoXG4gICAgICB0aGlzLm1pY0FjdGl2ZSAmJlxuICAgICAgdGhpcy5taWNPcHRzICYmXG4gICAgICB0aGlzLm1pY09wdHMuZWNob0NhbmNlbGxhdGlvbiA9PT0gb3B0aW9ucy5lY2hvQ2FuY2VsbGF0aW9uICYmXG4gICAgICB0aGlzLm1pY09wdHMubm9pc2VTdXBwcmVzc2lvbiA9PT0gb3B0aW9ucy5ub2lzZVN1cHByZXNzaW9uICYmXG4gICAgICB0aGlzLm1pY09wdHMuYXV0b0dhaW5Db250cm9sID09PSBvcHRpb25zLmF1dG9HYWluQ29udHJvbFxuICAgICkge1xuICAgICAgYXdhaXQgdGhpcy5vcGVuKCk7XG4gICAgICB0aGlzLm9uTWljRnJhbWUgPSBvbkZyYW1lO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBhd2FpdCB0aGlzLnN0YXJ0TWljKG9uRnJhbWUsIG9wdGlvbnMpO1xuICB9XG5cbiAgYXN5bmMgc3RhcnRNaWMob25GcmFtZTogKHNhbXBsZXM6IEludDE2QXJyYXksIGxldmVsOiBudW1iZXIpID0+IHZvaWQsIG9wdGlvbnM6IE1pY09wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICB0aGlzLnN0b3BNaWMoKTtcbiAgICBjb25zdCBnZW4gPSArK3RoaXMubWljR2VuO1xuICAgIGF3YWl0IHRoaXMub3BlbigpO1xuICAgIGlmIChnZW4gIT09IHRoaXMubWljR2VuKSByZXR1cm47XG4gICAgY29uc3QgY29udGV4dCA9IHRoaXMuY29udGV4dCE7XG4gICAgY29uc3Qgc3RyZWFtID0gYXdhaXQgbmF2aWdhdG9yLm1lZGlhRGV2aWNlcy5nZXRVc2VyTWVkaWEoeyBhdWRpbzogeyBjaGFubmVsQ291bnQ6IDEsIC4uLm9wdGlvbnMgfSB9KTtcbiAgICBpZiAoZ2VuICE9PSB0aGlzLm1pY0dlbikge1xuICAgICAgc3RyZWFtLmdldFRyYWNrcygpLmZvckVhY2goKHQpID0+IHQuc3RvcCgpKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgbGV0IHNvdXJjZTogTWVkaWFTdHJlYW1BdWRpb1NvdXJjZU5vZGUgfCBudWxsID0gbnVsbDtcbiAgICBsZXQgY2FwdHVyZTogQXVkaW9Xb3JrbGV0Tm9kZSB8IG51bGwgPSBudWxsO1xuICAgIHRyeSB7XG4gICAgICBzb3VyY2UgPSBjb250ZXh0LmNyZWF0ZU1lZGlhU3RyZWFtU291cmNlKHN0cmVhbSk7XG4gICAgICBjYXB0dXJlID0gbmV3IEF1ZGlvV29ya2xldE5vZGUoY29udGV4dCwgXCJjYXB0dXJlXCIsIHsgbnVtYmVyT2ZPdXRwdXRzOiAwIH0pO1xuICAgICAgY2FwdHVyZS5wb3J0Lm9ubWVzc2FnZSA9IChlKSA9PiB7XG4gICAgICAgIGNvbnN0IGZyYW1lID0gbmV3IEludDE2QXJyYXkoZS5kYXRhIGFzIEFycmF5QnVmZmVyKTtcbiAgICAgICAgbGV0IHN1bSA9IDA7XG4gICAgICAgIGZvciAoY29uc3QgcyBvZiBmcmFtZSkgc3VtICs9IHMgKiBzO1xuICAgICAgICB0aGlzLmxldmVsID0gTWF0aC5zcXJ0KHN1bSAvIGZyYW1lLmxlbmd0aCkgLyAzMjc2ODtcbiAgICAgICAgdGhpcy5vbk1pY0ZyYW1lPy4oZnJhbWUsIHRoaXMubGV2ZWwpO1xuICAgICAgfTtcbiAgICAgIHNvdXJjZS5jb25uZWN0KGNhcHR1cmUpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgc291cmNlPy5kaXNjb25uZWN0KCk7XG4gICAgICBjYXB0dXJlPy5wb3J0LmNsb3NlKCk7XG4gICAgICBzdHJlYW0uZ2V0VHJhY2tzKCkuZm9yRWFjaCgodCkgPT4gdC5zdG9wKCkpO1xuICAgICAgdGhyb3cgZXJyO1xuICAgIH1cbiAgICB0aGlzLnN0cmVhbSA9IHN0cmVhbTtcbiAgICB0aGlzLm1pY09wdHMgPSB7IC4uLm9wdGlvbnMgfTtcbiAgICB0aGlzLm9uTWljRnJhbWUgPSBvbkZyYW1lO1xuICAgIHRoaXMuc291cmNlID0gc291cmNlO1xuICAgIHRoaXMuY2FwdHVyZSA9IGNhcHR1cmU7XG4gIH1cblxuICBzdG9wTWljKCk6IHZvaWQge1xuICAgIHRoaXMubWljR2VuKys7XG4gICAgdGhpcy5zb3VyY2U/LmRpc2Nvbm5lY3QoKTtcbiAgICB0aGlzLmNhcHR1cmU/LnBvcnQuY2xvc2UoKTtcbiAgICB0aGlzLnN0cmVhbT8uZ2V0VHJhY2tzKCkuZm9yRWFjaCgodCkgPT4gdC5zdG9wKCkpO1xuICAgIHRoaXMuc291cmNlID0gbnVsbDtcbiAgICB0aGlzLmNhcHR1cmUgPSBudWxsO1xuICAgIHRoaXMuc3RyZWFtID0gbnVsbDtcbiAgICB0aGlzLm1pY09wdHMgPSBudWxsO1xuICAgIHRoaXMub25NaWNGcmFtZSA9IG51bGw7XG4gICAgdGhpcy5sZXZlbCA9IDA7XG4gIH1cblxuICBwbGF5KHBjbTY0OiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuY29udGV4dCB8fCAhdGhpcy5wbGF5YmFjaykgcmV0dXJuO1xuICAgIGNvbnN0IHNhbXBsZXMgPSB0b0Zsb2F0cyhiYXNlNjRUb0J5dGVzKHBjbTY0KSwgMjQwMDAsIHRoaXMuY29udGV4dC5zYW1wbGVSYXRlKTtcbiAgICB0aGlzLnBsYXliYWNrLnBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcInBsYXlcIiwgc2FtcGxlcyB9LCBbc2FtcGxlcy5idWZmZXJdKTtcbiAgfVxuXG4gIGN1ZShwY202NDogc3RyaW5nKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLmNvbnRleHQgfHwgIXRoaXMucGxheWJhY2spIHJldHVybjtcbiAgICBjb25zdCBzYW1wbGVzID0gdG9GbG9hdHMoYmFzZTY0VG9CeXRlcyhwY202NCksIDI0MDAwLCB0aGlzLmNvbnRleHQuc2FtcGxlUmF0ZSk7XG4gICAgdGhpcy5wbGF5YmFjay5wb3J0LnBvc3RNZXNzYWdlKHsgdHlwZTogXCJjdWVcIiwgc2FtcGxlcyB9LCBbc2FtcGxlcy5idWZmZXJdKTtcbiAgfVxuXG4gIGZsdXNoKCk6IHZvaWQge1xuICAgIHRoaXMucGxheWJhY2s/LnBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcImZsdXNoXCIgfSk7XG4gIH1cblxuICBzdG9wUGxheWJhY2soKTogdm9pZCB7XG4gICAgdGhpcy5wbGF5YmFjaz8ucG9ydC5wb3N0TWVzc2FnZSh7IHR5cGU6IFwic3RvcFwiIH0pO1xuICAgIHRoaXMucXVldWVkID0gMDtcbiAgfVxuXG4gIHN0b3AoKTogdm9pZCB7XG4gICAgdGhpcy5zdG9wTWljKCk7XG4gICAgdGhpcy5zdG9wUGxheWJhY2soKTtcbiAgfVxufVxuIiwgIi8vIFRoZSByZXBsYXkgdmlldzogYSByZWNvcmRlZCBjYWxsIChhIHRyYWNlIGZyb20gYW55IGhvc3QsIG9yIGEgc2NlbmFyaW8pIHJ1biBhZ2FpbiB0aHJvdWdoIHRoZVxuLy8gY29yZSwgYXMgdGhlIGJ1aWxkIHRoYXQgcmVjb3JkZWQgaXQgZGlkIGFuZCBhcyB0aGUgbGF0ZXN0IGRvZXMsIHNpZGUgYnkgc2lkZS4gV2hlcmUgdGhleSBwYXJ0XG4vLyBpcyB3aGVyZSBhIGNoYW5nZSBpbiBzcmMvIGNoYW5nZWQgd2hhdCB0aGUgY2FsbCBkb2VzIHdpdGggdGhlIHNhbWUgd29yZHMgYW5kIHRoZSBzYW1lIG1vZGVsLlxuXG5pbnRlcmZhY2UgQ29yZSB7XG4gIHZlcnNpb246IHN0cmluZztcbiAgY3JlYXRlKGNvbmZpZzogc3RyaW5nLCB0OiBudW1iZXIpOiBzdHJpbmc7XG4gIHB1c2goaWQ6IG51bWJlciwgZXZlbnQ6IHN0cmluZyk6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFJlY29yZGluZyB7IHZlcnNpb24/OiBzdHJpbmc7IGNvbmZpZzogdW5rbm93bjsgc3RhcnQ6IG51bWJlcjsgZXZlbnRzOiBSZWNvcmQ8c3RyaW5nLCBhbnk+W10gfVxuXG4vKiogV2hhdCBhIGNvbW1hbmQgb3IgZXZlbnQgbG9va3MgbGlrZSBpbiBhIHRpbWVsaW5lOiBhdWRpbyBjdXQgb3V0LCBvbmUgbGluZS4gKi9cbmZ1bmN0aW9uIGxpbmUobzogUmVjb3JkPHN0cmluZywgYW55Pik6IHN0cmluZyB7XG4gIGNvbnN0IHRleHQgPSBKU09OLnN0cmluZ2lmeShvKS5yZXBsYWNlKC9cIihkYXRhfHBjbSlcIjpcIltBLVphLXowLTkrLz1dezQwLH1cIi9nLCAnXCIkMVwiOlwiXHUyMDI2XCInKVxuICAgIC5yZXBsYWNlKC9cXFxcXCJkYXRhXFxcXFwiOlxcXFxcIltBLVphLXowLTkrLz1dezQwLH1cXFxcXCIvZywgJ1xcXFxcImRhdGFcXFxcXCI6XFxcXFwiXHUyMDI2XFxcXFwiJyk7XG4gIHJldHVybiB0ZXh0Lmxlbmd0aCA+IDQwMCA/IHRleHQuc2xpY2UoMCwgNDAwKSArIFwiXHUyMDI2XCIgOiB0ZXh0O1xufVxuXG4vKiogQXVkaW8gYW5kIHRpY2tzIHNheSBub3RoaW5nIGEgcmVhZGVyIG5lZWRzOyB0aGUgcmVzdCBkb2VzLiAqL1xuZnVuY3Rpb24gdGVsbGluZyhvOiBSZWNvcmQ8c3RyaW5nLCBhbnk+KTogYm9vbGVhbiB7XG4gIGlmIChvLnR5cGUgPT09IFwibWljXCIgfHwgby50eXBlID09PSBcInRpY2tcIiB8fCBvLnR5cGUgPT09IFwicGxheVwiKSByZXR1cm4gZmFsc2U7XG4gIGlmIChvLnR5cGUgPT09IFwid3Muc2VuZFwiICYmIFN0cmluZyhvLmRhdGEpLnN0YXJ0c1dpdGgoJ3tcInJlYWx0aW1lSW5wdXRcIjp7XCJhdWRpb1wiJykpIHJldHVybiBmYWxzZTtcbiAgaWYgKG8udHlwZSA9PT0gXCJ3cy5tZXNzYWdlXCIgJiYgU3RyaW5nKG8uZGF0YSkuaW5jbHVkZXMoJ1wiaW5saW5lRGF0YVwiJykgJiYgIVN0cmluZyhvLmRhdGEpLmluY2x1ZGVzKCdcInR1cm5Db21wbGV0ZVwiJykpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmZ1bmN0aW9uIHJ1bihjb3JlOiBDb3JlLCByOiBSZWNvcmRpbmcpOiBzdHJpbmdbXVtdIHtcbiAgY29uc3QgY3JlYXRlZCA9IEpTT04ucGFyc2UoY29yZS5jcmVhdGUoSlNPTi5zdHJpbmdpZnkoci5jb25maWcpLCByLnN0YXJ0KSk7XG4gIGNvbnN0IG91dDogc3RyaW5nW11bXSA9IFtjcmVhdGVkLmNvbW1hbmRzLmZpbHRlcih0ZWxsaW5nKS5tYXAobGluZSldO1xuICBmb3IgKGNvbnN0IGUgb2Ygci5ldmVudHMpIG91dC5wdXNoKChKU09OLnBhcnNlKGNvcmUucHVzaChjcmVhdGVkLmlkLCBKU09OLnN0cmluZ2lmeShlKSkpIGFzIFJlY29yZDxzdHJpbmcsIGFueT5bXSkuZmlsdGVyKHRlbGxpbmcpLm1hcChsaW5lKSk7XG4gIHJldHVybiBvdXQ7XG59XG5cbmV4cG9ydCBjbGFzcyBSZXBsYXkge1xuICBwcml2YXRlIHJlYWRvbmx5IHJvb3Q6IEhUTUxFbGVtZW50O1xuICBwcml2YXRlIHJlYWRvbmx5IGxvYWQ6ICh1cmw/OiBzdHJpbmcpID0+IFByb21pc2U8Q29yZT47XG5cbiAgY29uc3RydWN0b3Iocm9vdDogSFRNTEVsZW1lbnQsIGxvYWQ6ICh1cmw/OiBzdHJpbmcpID0+IFByb21pc2U8Q29yZT4pIHtcbiAgICB0aGlzLnJvb3QgPSByb290O1xuICAgIHRoaXMubG9hZCA9IGxvYWQ7XG4gICAgcm9vdC5pbm5lckhUTUwgPSBgXG4gICAgICA8aDI+VHJhY2UgcmVwbGF5PC9oMj5cbiAgICAgIDxkaXYgY2xhc3M9XCJiYXJcIj48c2VsZWN0IGNsYXNzPVwicGlja1wiIGFyaWEtbGFiZWw9XCJSZWNvcmRpbmdcIj48L3NlbGVjdD48YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cInJlZnJlc2hcIiB0aXRsZT1cIlJlZnJlc2ggbGlzdFwiIGFyaWEtbGFiZWw9XCJSZWZyZXNoIGxpc3RcIj5cdTIxQkI8L2J1dHRvbj48YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cImdvXCI+UmVwbGF5PC9idXR0b24+XG4gICAgICA8bGFiZWwgY2xhc3M9XCJ0b2dnbGUtYWxsXCI+PGlucHV0IHR5cGU9XCJjaGVja2JveFwiIGNsYXNzPVwiYWxsXCI+IFNob3cgYXVkaW8gYW5kIHRpY2tzPC9sYWJlbD48c3BhbiBjbGFzcz1cInN1bW1hcnlcIj48L3NwYW4+PC9kaXY+XG4gICAgICA8ZGl2IGNsYXNzPVwidGltZWxpbmVcIj48L2Rpdj5gO1xuICAgIChyb290LnF1ZXJ5U2VsZWN0b3IoXCIucmVmcmVzaFwiKSBhcyBIVE1MRWxlbWVudCkub25jbGljayA9ICgpID0+IHZvaWQgdGhpcy5saXN0KCk7XG4gICAgKHJvb3QucXVlcnlTZWxlY3RvcihcIi5nb1wiKSBhcyBIVE1MRWxlbWVudCkub25jbGljayA9ICgpID0+IHZvaWQgdGhpcy5yZXBsYXkoKS5jYXRjaCgoZXJyKSA9PiB0aGlzLnNheShgUmVwbGF5IGZhaWxlZDogJHtlcnIubWVzc2FnZX1gKSk7XG4gICAgdm9pZCB0aGlzLmxpc3QoKTtcbiAgfVxuXG4gIHByaXZhdGUgc2F5KHRleHQ6IHN0cmluZykge1xuICAgICh0aGlzLnJvb3QucXVlcnlTZWxlY3RvcihcIi5zdW1tYXJ5XCIpIGFzIEhUTUxFbGVtZW50KS50ZXh0Q29udGVudCA9IHRleHQ7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGxpc3QoKSB7XG4gICAgY29uc3QgcGljayA9IHRoaXMucm9vdC5xdWVyeVNlbGVjdG9yKFwiLnBpY2tcIikgYXMgSFRNTFNlbGVjdEVsZW1lbnQ7XG4gICAgcGljay5pbm5lckhUTUwgPSBcIlwiO1xuICAgIGNvbnN0IHRyYWNlczogeyBuYW1lOiBzdHJpbmc7IGJ5dGVzOiBudW1iZXIgfVtdID0gYXdhaXQgKGF3YWl0IGZldGNoKFwiL3RyYWNlc1wiKSkuanNvbigpO1xuICAgIGNvbnN0IHNjZW5hcmlvczogc3RyaW5nW10gPSBhd2FpdCAoYXdhaXQgZmV0Y2goXCIvc2NlbmFyaW9zXCIpKS5qc29uKCk7XG4gICAgY29uc3QgdHJhY2VHcm91cCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJvcHRncm91cFwiKTtcbiAgICB0cmFjZUdyb3VwLmxhYmVsID0gXCJSZWNvcmRlZCBjYWxsc1wiO1xuICAgIGZvciAoY29uc3QgdCBvZiB0cmFjZXMpIHRyYWNlR3JvdXAuYXBwZW5kKG5ldyBPcHRpb24oYCR7dC5uYW1lfSAoJHtNYXRoLnJvdW5kKHQuYnl0ZXMgLyAxMDI0KX0gS0IpYCwgYC90cmFjZXMvJHt0Lm5hbWV9YCkpO1xuICAgIGNvbnN0IHNjZW5hcmlvR3JvdXAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwib3B0Z3JvdXBcIik7XG4gICAgc2NlbmFyaW9Hcm91cC5sYWJlbCA9IFwiU2NlbmFyaW9zXCI7XG4gICAgZm9yIChjb25zdCBzIG9mIHNjZW5hcmlvcykgc2NlbmFyaW9Hcm91cC5hcHBlbmQobmV3IE9wdGlvbihzLCBgL3NjZW5hcmlvcy8ke3N9Lmpzb25gKSk7XG4gICAgcGljay5hcHBlbmQodHJhY2VHcm91cCwgc2NlbmFyaW9Hcm91cCk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHJlY29yZGluZyh1cmw6IHN0cmluZyk6IFByb21pc2U8UmVjb3JkaW5nPiB7XG4gICAgY29uc3QgdGV4dCA9IGF3YWl0IChhd2FpdCBmZXRjaCh1cmwsIHsgY2FjaGU6IFwibm8tc3RvcmVcIiB9KSkudGV4dCgpO1xuICAgIGlmICh1cmwuZW5kc1dpdGgoXCIuanNvblwiKSkgcmV0dXJuIEpTT04ucGFyc2UodGV4dCk7XG4gICAgY29uc3QgW2hlYWRlciwgLi4uZXZlbnRzXSA9IHRleHQudHJpbSgpLnNwbGl0KFwiXFxuXCIpLm1hcCgobCkgPT4gSlNPTi5wYXJzZShsKSk7XG4gICAgcmV0dXJuIHsgLi4uaGVhZGVyLCBldmVudHMgfTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgcmVwbGF5KCkge1xuICAgIGNvbnN0IHVybCA9ICh0aGlzLnJvb3QucXVlcnlTZWxlY3RvcihcIi5waWNrXCIpIGFzIEhUTUxTZWxlY3RFbGVtZW50KS52YWx1ZTtcbiAgICBpZiAoIXVybCkgcmV0dXJuO1xuICAgIGNvbnN0IHIgPSBhd2FpdCB0aGlzLnJlY29yZGluZyh1cmwpO1xuICAgIGNvbnN0IGxhdGVzdCA9IGF3YWl0IHRoaXMubG9hZCgpO1xuICAgIGxldCByZWNvcmRlZDogQ29yZSB8IG51bGwgPSBudWxsO1xuICAgIGlmIChyLnZlcnNpb24gJiYgci52ZXJzaW9uICE9PSBsYXRlc3QudmVyc2lvbikge1xuICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChgL3ZlcnNpb25zLyR7ci52ZXJzaW9ufS5qc2AsIHsgbWV0aG9kOiBcIkhFQURcIiB9KTtcbiAgICAgIGlmIChyZXNwb25zZS5vaykgcmVjb3JkZWQgPSBhd2FpdCB0aGlzLmxvYWQoYC92ZXJzaW9ucy8ke3IudmVyc2lvbn0uanNgKTtcbiAgICB9XG4gICAgY29uc3Qgbm93ID0gcnVuKGxhdGVzdCwgcik7XG4gICAgY29uc3QgdGhlbiA9IHJlY29yZGVkID8gcnVuKHJlY29yZGVkLCByKSA6IG51bGw7XG4gICAgY29uc3QgYWxsID0gKHRoaXMucm9vdC5xdWVyeVNlbGVjdG9yKFwiLmFsbFwiKSBhcyBIVE1MSW5wdXRFbGVtZW50KS5jaGVja2VkO1xuICAgIGNvbnN0IHRpbWVsaW5lID0gdGhpcy5yb290LnF1ZXJ5U2VsZWN0b3IoXCIudGltZWxpbmVcIikgYXMgSFRNTEVsZW1lbnQ7XG4gICAgdGltZWxpbmUuaW5uZXJIVE1MID0gXCJcIjtcbiAgICBsZXQgZmlyc3QgPSAtMTtcbiAgICBsZXQgZGlmZmVyID0gMDtcbiAgICBjb25zdCByb3dzOiBIVE1MRWxlbWVudFtdID0gW107XG4gICAgY29uc3QgYWRkID0gKGNsczogc3RyaW5nLCB0OiBzdHJpbmcsIHRleHQ6IHN0cmluZykgPT4ge1xuICAgICAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgIHJvdy5jbGFzc05hbWUgPSBgcm93ICR7Y2xzfWA7XG4gICAgICByb3cuaW5uZXJIVE1MID0gYDxzcGFuIGNsYXNzPVwidFwiPiR7dH08L3NwYW4+YDtcbiAgICAgIGNvbnN0IGIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgICAgIGIuY2xhc3NOYW1lID0gXCJiXCI7XG4gICAgICBiLnRleHRDb250ZW50ID0gdGV4dDtcbiAgICAgIHJvdy5hcHBlbmQoYik7XG4gICAgICB0aW1lbGluZS5hcHBlbmQocm93KTtcbiAgICAgIHJvd3MucHVzaChyb3cpO1xuICAgICAgcmV0dXJuIHJvdztcbiAgICB9O1xuICAgIGNvbnN0IHQwID0gci5zdGFydDtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8PSByLmV2ZW50cy5sZW5ndGg7IGkrKykge1xuICAgICAgY29uc3QgZSA9IGkgPT09IDAgPyBudWxsIDogci5ldmVudHNbaSAtIDFdO1xuICAgICAgY29uc3Qgbm93T3V0ID0gbm93W2ldO1xuICAgICAgY29uc3QgdGhlbk91dCA9IHRoZW4gPyB0aGVuW2ldIDogbm93T3V0O1xuICAgICAgY29uc3Qgc2FtZSA9IG5vd091dC5sZW5ndGggPT09IHRoZW5PdXQubGVuZ3RoICYmIG5vd091dC5ldmVyeSgoYywgaikgPT4gYyA9PT0gdGhlbk91dFtqXSk7XG4gICAgICBpZiAoIXNhbWUpIHsgZGlmZmVyKys7IGlmIChmaXJzdCA8IDApIGZpcnN0ID0gaTsgfVxuICAgICAgaWYgKCFzYW1lIHx8IGFsbCB8fCAoZSAmJiB0ZWxsaW5nKGUpKSB8fCBub3dPdXQubGVuZ3RoID4gMCkge1xuICAgICAgICBpZiAoZSAmJiAoYWxsIHx8IHRlbGxpbmcoZSkgfHwgIXNhbWUpKSBhZGQoXCJpblwiLCAoZS50IC0gdDApLnRvRml4ZWQoMiksIGxpbmUoZSkpO1xuICAgICAgICBjb25zdCB0ID0gZSA/IChlLnQgLSB0MCkudG9GaXhlZCgyKSA6IFwiMC4wMFwiO1xuICAgICAgICBpZiAoc2FtZSkgZm9yIChjb25zdCBjIG9mIG5vd091dCkgYWRkKFwib3V0XCIsIHQsIGMpO1xuICAgICAgICBlbHNlIHtcbiAgICAgICAgICBmb3IgKGNvbnN0IGMgb2YgdGhlbk91dCkgYWRkKFwib3V0IGdvbmVcIiwgdCwgYFx1MjIxMiAke2N9YCk7XG4gICAgICAgICAgZm9yIChjb25zdCBjIG9mIG5vd091dCkgYWRkKFwib3V0IG5ld1wiLCB0LCBgKyAke2N9YCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgY29uc3QgdmVyc2lvbnMgPSB0aGVuID8gYHJlY29yZGVkIGJ5ICR7ci52ZXJzaW9ufSwgcmVwbGF5ZWQgYnkgaXQgYW5kIGJ5ICR7bGF0ZXN0LnZlcnNpb259YCA6IGByZXBsYXllZCBieSAke2xhdGVzdC52ZXJzaW9ufWAgK1xuICAgICAgKHIudmVyc2lvbiAmJiByLnZlcnNpb24gIT09IGxhdGVzdC52ZXJzaW9uID8gYCAodGhlIHJlY29yZGluZydzIGJ1aWxkICR7ci52ZXJzaW9ufSBpc24ndCBrZXB0IGhlcmUpYCA6IFwiXCIpO1xuICAgIHRoaXMuc2F5KGAke3IuZXZlbnRzLmxlbmd0aH0gZXZlbnRzLCAke3ZlcnNpb25zfS4gYCArICh0aGVuID8gKGRpZmZlciA/IGAke2RpZmZlcn0gZXZlbnRzIGFuc3dlcmVkIGRpZmZlcmVudGx5LCB0aGUgZmlyc3QgYXQgZXZlbnQgJHtmaXJzdH0uYCA6IFwiQm90aCBhbnN3ZXJlZCBldmVyeSBldmVudCB0aGUgc2FtZS5cIikgOiBcIlwiKSk7XG4gICAgaWYgKGZpcnN0ID49IDApIHRpbWVsaW5lLnF1ZXJ5U2VsZWN0b3IoXCIuZ29uZSwgLm5ld1wiKT8uc2Nyb2xsSW50b1ZpZXcoeyBibG9jazogXCJjZW50ZXJcIiB9KTtcbiAgfVxufVxuIiwgIi8qKiBNaW5pbWFsIHNjcm9sbGluZyBwYW5lIHN1cmZhY2Ugc28gYXV0by1zY3JvbGwgbG9naWMgc3RheXMgdGVzdGFibGUgd2l0aG91dCBhIGJyb3dzZXIgRE9NLiAqL1xuZXhwb3J0IGludGVyZmFjZSBTY3JvbGxQYW5lIHtcbiAgc2Nyb2xsVG9wOiBudW1iZXI7XG4gIHJlYWRvbmx5IHNjcm9sbEhlaWdodDogbnVtYmVyO1xuICByZWFkb25seSBjbGllbnRIZWlnaHQ6IG51bWJlcjtcbiAgc2Nyb2xsVG8/KG9wdGlvbnM6IHsgdG9wOiBudW1iZXI7IGJlaGF2aW9yPzogU2Nyb2xsQmVoYXZpb3IgfSk6IHZvaWQ7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXV0b1Njcm9sbGVyT3B0aW9ucyB7XG4gIC8qKiBEaXN0YW5jZSBmcm9tIHRoZSBib3R0b20gKHB4KSB0aGF0IHN0aWxsIGNvdW50cyBhcyBwaW5uZWQuICovXG4gIHBpblRocmVzaG9sZD86IG51bWJlcjtcbiAgLyoqIERpc3RhbmNlIGZyb20gdGhlIGJvdHRvbSAocHgpIHBhc3Qgd2hpY2ggdGhlIGp1bXAtdG8tbGF0ZXN0IGNvbnRyb2wgaXMgc2hvd24uICovXG4gIGp1bXBUaHJlc2hvbGQ/OiBudW1iZXI7XG4gIC8qKiBDYWxsZWQgd2hlbmV2ZXIgdGhlIGp1bXAtdG8tbGF0ZXN0IGNvbnRyb2wncyB2aXNpYmlsaXR5IG1heSBoYXZlIGNoYW5nZWQuICovXG4gIG9uSnVtcENoYW5nZT86IChzaG93OiBib29sZWFuKSA9PiB2b2lkO1xuICAvKiogV2hlbiB0cnVlIChmb3IgZXhhbXBsZSB3aGlsZSB0aGUgZW1wdHkgc3RhdGUgaXMgc2hvd24pLCBrZWVwIHRoZSBqdW1wIGNvbnRyb2wgaGlkZGVuLiAqL1xuICBpc0VtcHR5PzogKCkgPT4gYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBLZWVwcyBhIHRyYW5zY3JpcHQgcGFuZSBwaW5uZWQgdG8gdGhlIGJvdHRvbSBhcyBtZXNzYWdlcyBzdHJlYW0gaW4sIHdpdGhvdXQgbWVhc3VyaW5nXG4gKiBuZWFyLWJvdHRvbSBhZnRlciBhbiBhcHBlbmQgaGFzIGFscmVhZHkgZ3Jvd24gc2Nyb2xsSGVpZ2h0LCBhbmQgeWllbGRzIGltbWVkaWF0ZWx5IHdoZW5cbiAqIHRoZSB1c2VyIHNjcm9sbHMgdXAgdG8gcmVhZCBlYXJsaWVyIG1lc3NhZ2VzLlxuICovXG5leHBvcnQgY2xhc3MgQXV0b1Njcm9sbGVyIHtcbiAgcHJpdmF0ZSByZWFkb25seSBwYW5lOiBTY3JvbGxQYW5lO1xuICBwcml2YXRlIHJlYWRvbmx5IHBpblRocmVzaG9sZDogbnVtYmVyO1xuICBwcml2YXRlIHJlYWRvbmx5IGp1bXBUaHJlc2hvbGQ6IG51bWJlcjtcbiAgcHJpdmF0ZSByZWFkb25seSBvbkp1bXBDaGFuZ2U/OiAoc2hvdzogYm9vbGVhbikgPT4gdm9pZDtcbiAgcHJpdmF0ZSByZWFkb25seSBpc0VtcHR5PzogKCkgPT4gYm9vbGVhbjtcbiAgcHJpdmF0ZSBwaW5uZWQgPSB0cnVlO1xuICBwcml2YXRlIGp1bXBpbmcgPSBmYWxzZTtcbiAgcHJpdmF0ZSBsYXN0U2Nyb2xsVG9wID0gMDtcblxuICBjb25zdHJ1Y3RvcihwYW5lOiBTY3JvbGxQYW5lLCBvcHRpb25zOiBBdXRvU2Nyb2xsZXJPcHRpb25zID0ge30pIHtcbiAgICB0aGlzLnBhbmUgPSBwYW5lO1xuICAgIHRoaXMucGluVGhyZXNob2xkID0gb3B0aW9ucy5waW5UaHJlc2hvbGQgPz8gMzI7XG4gICAgdGhpcy5qdW1wVGhyZXNob2xkID0gb3B0aW9ucy5qdW1wVGhyZXNob2xkID8/IDEyMDtcbiAgICB0aGlzLm9uSnVtcENoYW5nZSA9IG9wdGlvbnMub25KdW1wQ2hhbmdlO1xuICAgIHRoaXMuaXNFbXB0eSA9IG9wdGlvbnMuaXNFbXB0eTtcbiAgICB0aGlzLmxhc3RTY3JvbGxUb3AgPSBwYW5lLnNjcm9sbFRvcDtcbiAgfVxuXG4gIGdldCBpc1Bpbm5lZCgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5waW5uZWQ7XG4gIH1cblxuICBwcml2YXRlIGRpc3RhbmNlKCk6IG51bWJlciB7XG4gICAgcmV0dXJuIE1hdGgubWF4KDAsIHRoaXMucGFuZS5zY3JvbGxIZWlnaHQgLSB0aGlzLnBhbmUuc2Nyb2xsVG9wIC0gdGhpcy5wYW5lLmNsaWVudEhlaWdodCk7XG4gIH1cblxuICBwcml2YXRlIGlzVmlzaWJsZSgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5wYW5lLmNsaWVudEhlaWdodCA+IDA7XG4gIH1cblxuICBwcml2YXRlIHNuYXBUb0JvdHRvbSgpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuaXNWaXNpYmxlKCkpIHJldHVybjtcbiAgICB0aGlzLnBhbmUuc2Nyb2xsVG9wID0gdGhpcy5wYW5lLnNjcm9sbEhlaWdodDtcbiAgICB0aGlzLmxhc3RTY3JvbGxUb3AgPSB0aGlzLnBhbmUuc2Nyb2xsVG9wO1xuICB9XG5cbiAgcHJpdmF0ZSB1cGRhdGVKdW1wKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5vbkp1bXBDaGFuZ2UpIHJldHVybjtcbiAgICBjb25zdCBlbXB0eSA9IHRoaXMuaXNFbXB0eT8uKCkgPz8gZmFsc2U7XG4gICAgY29uc3Qgc2hvdyA9ICFlbXB0eSAmJiB0aGlzLmlzVmlzaWJsZSgpICYmICF0aGlzLmp1bXBpbmcgJiYgdGhpcy5kaXN0YW5jZSgpID4gdGhpcy5qdW1wVGhyZXNob2xkO1xuICAgIHRoaXMub25KdW1wQ2hhbmdlKHNob3cpO1xuICB9XG5cbiAgLyoqIENhbGwgYWZ0ZXIgY29udGVudCBpcyBhZGRlZCwgdXBkYXRlZCwgb3IgcmVtb3ZlZCBpbiB0aGUgcGFuZS4gKi9cbiAgb25Db250ZW50KGZvcmNlID0gZmFsc2UpOiB2b2lkIHtcbiAgICBpZiAoZm9yY2UpIHtcbiAgICAgIHRoaXMucGlubmVkID0gdHJ1ZTtcbiAgICAgIHRoaXMuanVtcGluZyA9IGZhbHNlO1xuICAgIH1cbiAgICBpZiAodGhpcy5waW5uZWQpIHtcbiAgICAgIGlmICh0aGlzLmp1bXBpbmcgJiYgdGhpcy5wYW5lLnNjcm9sbFRvICYmIHRoaXMuaXNWaXNpYmxlKCkpIHtcbiAgICAgICAgdGhpcy5wYW5lLnNjcm9sbFRvKHsgdG9wOiB0aGlzLnBhbmUuc2Nyb2xsSGVpZ2h0LCBiZWhhdmlvcjogXCJzbW9vdGhcIiB9KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMuc25hcFRvQm90dG9tKCk7XG4gICAgICB9XG4gICAgfVxuICAgIHRoaXMudXBkYXRlSnVtcCgpO1xuICB9XG5cbiAgLyoqIENhbGwgd2hlbiB0aGUgcGFuZSdzIHZpZXdwb3J0IHJlc2l6ZXMgKGJhcnMgYXBwZWFyaW5nLCBrZXlib2FyZCwgdGFiIHN3aXRjaCkuICovXG4gIG9uUmVzaXplKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5pc1Zpc2libGUoKSkgcmV0dXJuO1xuICAgIGlmICh0aGlzLnBpbm5lZCkge1xuICAgICAgdGhpcy5qdW1waW5nID0gZmFsc2U7XG4gICAgICB0aGlzLnNuYXBUb0JvdHRvbSgpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLmxhc3RTY3JvbGxUb3AgPSB0aGlzLnBhbmUuc2Nyb2xsVG9wO1xuICAgIH1cbiAgICB0aGlzLnVwZGF0ZUp1bXAoKTtcbiAgfVxuXG4gIC8qKiBDYWxsIGZyb20gdGhlIHBhbmUncyBzY3JvbGwgZXZlbnQgbGlzdGVuZXIuICovXG4gIG9uU2Nyb2xsKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5pc1Zpc2libGUoKSkgcmV0dXJuO1xuICAgIGNvbnN0IHRvcCA9IHRoaXMucGFuZS5zY3JvbGxUb3A7XG4gICAgY29uc3QgZGlzdCA9IHRoaXMuZGlzdGFuY2UoKTtcbiAgICBjb25zdCBtb3ZlZFVwID0gdG9wIDwgdGhpcy5sYXN0U2Nyb2xsVG9wO1xuICAgIHRoaXMubGFzdFNjcm9sbFRvcCA9IHRvcDtcblxuICAgIGlmIChkaXN0IDw9IHRoaXMucGluVGhyZXNob2xkKSB7XG4gICAgICB0aGlzLnBpbm5lZCA9IHRydWU7XG4gICAgICB0aGlzLmp1bXBpbmcgPSBmYWxzZTtcbiAgICB9IGVsc2UgaWYgKG1vdmVkVXApIHtcbiAgICAgIHRoaXMucGlubmVkID0gZmFsc2U7XG4gICAgICB0aGlzLmp1bXBpbmcgPSBmYWxzZTtcbiAgICB9XG4gICAgdGhpcy51cGRhdGVKdW1wKCk7XG4gIH1cblxuICAvKiogQ2FsbCBmcm9tIHRoZSBwYW5lJ3Mgc2Nyb2xsZW5kIGV2ZW50IGxpc3RlbmVyLiAqL1xuICBvblNjcm9sbEVuZCgpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuaXNWaXNpYmxlKCkgfHwgIXRoaXMuanVtcGluZykgcmV0dXJuO1xuICAgIHRoaXMuanVtcGluZyA9IGZhbHNlO1xuICAgIGlmICh0aGlzLmRpc3RhbmNlKCkgPiB0aGlzLnBpblRocmVzaG9sZCkgdGhpcy5waW5uZWQgPSBmYWxzZTtcbiAgICB0aGlzLnVwZGF0ZUp1bXAoKTtcbiAgfVxuXG4gIC8qKiBDYWxsIG9uIHVzZXIgd2hlZWwtdXAgb3IgdG91Y2hzdGFydCBzbyBhbiBhY3RpdmUgc21vb3RoIGp1bXAgeWllbGRzIHRvIHRoZSB1c2VyLiAqL1xuICBjYW5jZWxKdW1wKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5qdW1waW5nKSByZXR1cm47XG4gICAgdGhpcy5qdW1waW5nID0gZmFsc2U7XG4gICAgaWYgKHRoaXMuaXNWaXNpYmxlKCkpIHtcbiAgICAgIGNvbnN0IHRvcCA9IHRoaXMucGFuZS5zY3JvbGxUb3A7XG4gICAgICBpZiAodGhpcy5wYW5lLnNjcm9sbFRvKSB0aGlzLnBhbmUuc2Nyb2xsVG8oeyB0b3AsIGJlaGF2aW9yOiBcImluc3RhbnRcIiB9KTtcbiAgICAgIGVsc2UgdGhpcy5wYW5lLnNjcm9sbFRvcCA9IHRvcDtcbiAgICAgIHRoaXMubGFzdFNjcm9sbFRvcCA9IHRoaXMucGFuZS5zY3JvbGxUb3A7XG4gICAgICBpZiAodGhpcy5kaXN0YW5jZSgpID4gdGhpcy5waW5UaHJlc2hvbGQpIHRoaXMucGlubmVkID0gZmFsc2U7XG4gICAgfVxuICAgIHRoaXMudXBkYXRlSnVtcCgpO1xuICB9XG5cbiAgLyoqIFJlLXBpbiBhbmQgc2Nyb2xsIHNtb290aGx5IHRvIHRoZSBib3R0b20gKHVzZWQgYnkgdGhlIGp1bXAtdG8tbGF0ZXN0IGJ1dHRvbikuICovXG4gIGp1bXBUb0JvdHRvbSgpOiB2b2lkIHtcbiAgICB0aGlzLnBpbm5lZCA9IHRydWU7XG4gICAgaWYgKCF0aGlzLmlzVmlzaWJsZSgpKSB7XG4gICAgICB0aGlzLnVwZGF0ZUp1bXAoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHRoaXMuZGlzdGFuY2UoKSA8PSB0aGlzLnBpblRocmVzaG9sZCB8fCAhdGhpcy5wYW5lLnNjcm9sbFRvKSB7XG4gICAgICB0aGlzLmp1bXBpbmcgPSBmYWxzZTtcbiAgICAgIHRoaXMuc25hcFRvQm90dG9tKCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuanVtcGluZyA9IHRydWU7XG4gICAgICB0aGlzLmxhc3RTY3JvbGxUb3AgPSB0aGlzLnBhbmUuc2Nyb2xsVG9wO1xuICAgICAgdGhpcy5wYW5lLnNjcm9sbFRvKHsgdG9wOiB0aGlzLnBhbmUuc2Nyb2xsSGVpZ2h0LCBiZWhhdmlvcjogXCJzbW9vdGhcIiB9KTtcbiAgICB9XG4gICAgdGhpcy51cGRhdGVKdW1wKCk7XG4gIH1cblxuICAvKiogUmVjb21wdXRlIHBpbm5lZCBzdGF0ZSBmcm9tIHRoZSBjdXJyZW50IHBvc2l0aW9uIGFmdGVyIGEgdXNlci1kcml2ZW4gbGF5b3V0IGNoYW5nZSAoZS5nLiBleHBhbmRpbmcgYSByZXN1bHQpLiAqL1xuICBzeW5jRnJvbVBvc2l0aW9uKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5pc1Zpc2libGUoKSkgcmV0dXJuO1xuICAgIHRoaXMuanVtcGluZyA9IGZhbHNlO1xuICAgIHRoaXMubGFzdFNjcm9sbFRvcCA9IHRoaXMucGFuZS5zY3JvbGxUb3A7XG4gICAgdGhpcy5waW5uZWQgPSB0aGlzLmRpc3RhbmNlKCkgPD0gdGhpcy5waW5UaHJlc2hvbGQ7XG4gICAgdGhpcy51cGRhdGVKdW1wKCk7XG4gIH1cblxuICAvKiogUGF1c2UgYXV0by1zY3JvbGwgZXhwbGljaXRseSAoZS5nLiB3aGVuIHJldmVhbGluZyBhbiBvbGRlciByZXN1bHQgY2FyZCkuICovXG4gIHVucGluKCk6IHZvaWQge1xuICAgIHRoaXMucGlubmVkID0gZmFsc2U7XG4gICAgdGhpcy5qdW1waW5nID0gZmFsc2U7XG4gICAgdGhpcy51cGRhdGVKdW1wKCk7XG4gIH1cbn1cbiIsICIvLyBQdXJlIFVJIGhlbHBlcnMgZm9yIHRoZSBWb2ljZSB3ZWIgc3VyZmFjZSAoZGVuc2l0eSwgYWdlbnQtcGFuZSBmaWx0ZXJpbmcsIGNvbXBhY3QgcHJldmlld3MpLlxuXG5leHBvcnQgdHlwZSBTaWRlRmlsdGVyID0gXCJhbGxcIiB8IFwiYWN0aXZlXCIgfCBcInJlc3VsdHNcIjtcbmV4cG9ydCB0eXBlIERlbnNpdHkgPSBcImNvbXBhY3RcIiB8IFwiY29tZm9ydGFibGVcIjtcblxuZXhwb3J0IGludGVyZmFjZSBTaWRlQ291bnRzIHtcbiAgYWN0aXZlOiBudW1iZXI7XG4gIHJlc3VsdHM6IG51bWJlcjtcbiAgZWFybGllcjogbnVtYmVyO1xuICBkb25lOiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2lkZVZpc2liaWxpdHkge1xuICBzaG93VGFza3NTZWN0aW9uOiBib29sZWFuO1xuICBzaG93RW1wdHlUYXNrczogYm9vbGVhbjtcbiAgc2hvd1Jlc3VsdHNTZWN0aW9uOiBib29sZWFuO1xuICBzaG93RW1wdHlSZXN1bHRzOiBib29sZWFuO1xuICBzaG93RWFybGllclNlY3Rpb246IGJvb2xlYW47XG4gIHNob3dEb25lU2VjdGlvbjogYm9vbGVhbjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZURlbnNpdHkodmFsdWU6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQpOiBEZW5zaXR5IHtcbiAgcmV0dXJuIHZhbHVlID09PSBcImNvbWZvcnRhYmxlXCIgPyBcImNvbWZvcnRhYmxlXCIgOiBcImNvbXBhY3RcIjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZVNpZGVGaWx0ZXIodmFsdWU6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQpOiBTaWRlRmlsdGVyIHtcbiAgaWYgKHZhbHVlID09PSBcImFjdGl2ZVwiIHx8IHZhbHVlID09PSBcInJlc3VsdHNcIikgcmV0dXJuIHZhbHVlO1xuICByZXR1cm4gXCJhbGxcIjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlUHJlZml4KHRleHQ6IHN0cmluZyk6IHsgbW9kZTogXCJoZXJtZXNcIiB8IFwidDNcIiB8IG51bGw7IHJlc3Q6IHN0cmluZyB9IHtcbiAgY29uc3QgbSA9IHRleHQubWF0Y2goL15cXC8odDN8Y29kZXxofGhlcm1lcylcXHMrKC4qKSQvaXMpO1xuICBpZiAoIW0pIHJldHVybiB7IG1vZGU6IG51bGwsIHJlc3Q6IHRleHQgfTtcbiAgcmV0dXJuIHsgbW9kZTogL14odDN8Y29kZSkkL2kudGVzdChtWzFdKSA/IFwidDNcIiA6IFwiaGVybWVzXCIsIHJlc3Q6IG1bMl0udHJpbSgpIH07XG59XG5cbi8qKiBBIHJlc3VsdCBjYXJkIG1heSBvbmx5IHN0ZWVyIGEgdGFzayB0aGF0IGJlbG9uZ3MgdG8gdGhlIHNhbWUgYWN0aXZlIHNlc3Npb24gKHRhc2sgSURzIHJlc3RhcnQgcGVyIGNhbGwpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNhbkZvbGxvd1VwUmVzdWx0KHJlc3VsdFNlc3Npb246IG51bWJlciwgYWN0aXZlU2Vzc2lvbjogbnVtYmVyLCBoYXNUYXNrOiBib29sZWFuKTogYm9vbGVhbiB7XG4gIHJldHVybiBhY3RpdmVTZXNzaW9uID4gMCAmJiByZXN1bHRTZXNzaW9uID09PSBhY3RpdmVTZXNzaW9uICYmIGhhc1Rhc2s7XG59XG5cbi8qKiBVbnJlYWQgbW9iaWxlIHJlc3VsdCBhbGVydHMgb25seSBjbGVhciBvbmNlIHRoZSBSZXN1bHRzIHNlY3Rpb24gaXMgYWN0dWFsbHkgdmlzaWJsZSB0byB0aGUgdXNlci4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzaG91bGRDbGVhclVucmVhZFJlc3VsdHMoaXNNb2JpbGU6IGJvb2xlYW4sIGRyYXdlck9wZW46IGJvb2xlYW4sIGZpbHRlcjogU2lkZUZpbHRlcik6IGJvb2xlYW4ge1xuICByZXR1cm4gIWlzTW9iaWxlIHx8IChkcmF3ZXJPcGVuICYmIGZpbHRlciAhPT0gXCJhY3RpdmVcIik7XG59XG5cbi8qKiBQaWNrIHRoZSBmaWx0ZXIgdG8gc2hvdyB3aGVuIHRhcHBpbmcgdGhlIG1vYmlsZSBsaXZlLXN0YXR1cyBiYW5uZXIgc28gdGhlIGFkdmVydGlzZWQgaXRlbSBpcyB2aXNpYmxlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVNb2JpbGVCYW5uZXJGaWx0ZXIoY3VycmVudDogU2lkZUZpbHRlciwgYWN0aXZlVG90YWw6IG51bWJlciwgdW5yZWFkUmVzdWx0czogbnVtYmVyKTogU2lkZUZpbHRlciB7XG4gIGlmIChhY3RpdmVUb3RhbCA+IDApIHJldHVybiBjdXJyZW50ID09PSBcInJlc3VsdHNcIiA/IFwiYWxsXCIgOiBjdXJyZW50O1xuICBpZiAodW5yZWFkUmVzdWx0cyA+IDApIHJldHVybiBcInJlc3VsdHNcIjtcbiAgcmV0dXJuIGN1cnJlbnQ7XG59XG5cbi8qKiBGbGF0dGVuIGEgTWFya2Rvd24gYWdlbnQgcmVwbHkgaW50byBhIHNpbmdsZS1saW5lIHBsYWluLXRleHQgcHJldmlldyBmb3IgaW5saW5lIGhhbmRvZmYgY2hpcHMuICovXG5leHBvcnQgZnVuY3Rpb24gcGxhaW5QcmV2aWV3KHRleHQ6IHN0cmluZywgbWF4TGVuID0gMTUwKTogc3RyaW5nIHtcbiAgY29uc3QgY2xlYW5lZCA9IHRleHRcbiAgICAucmVwbGFjZSgvYGBgW15cXG5dKlxcbj8oW1xcc1xcU10qPylgYGAvZywgKF8sIGNvZGU6IHN0cmluZykgPT4gYCAke2NvZGUudHJpbSgpfSBgKVxuICAgIC5yZXBsYWNlKC9cXFsoW15cXF1cXG5dKylcXF1cXCgoaHR0cHM/OlxcL1xcL1teXFxzKV0rKVxcKS9nLCBcIiQxXCIpXG4gICAgLnJlcGxhY2UoL14jezEsNn1cXHMrL2dtLCBcIlwiKVxuICAgIC5yZXBsYWNlKC9eXFxzKig/OlstKlx1MjAyMl18XFxkK1suKV0pXFxzKy9nbSwgXCJcIilcbiAgICAucmVwbGFjZSgvYChbXmBcXG5dKylgL2csIFwiJDFcIilcbiAgICAucmVwbGFjZSgvXFwqXFwqKFteKlxcbl0rKVxcKlxcKi9nLCBcIiQxXCIpXG4gICAgLnJlcGxhY2UoL19fKFteX1xcbl0rKV9fL2csIFwiJDFcIilcbiAgICAucmVwbGFjZSgvXFxzKy9nLCBcIiBcIilcbiAgICAudHJpbSgpO1xuICBpZiAoY2xlYW5lZC5sZW5ndGggPD0gbWF4TGVuKSByZXR1cm4gY2xlYW5lZDtcbiAgY29uc3QgY3V0ID0gY2xlYW5lZC5zbGljZSgwLCBtYXhMZW4pO1xuICBjb25zdCBzcGFjZSA9IGN1dC5sYXN0SW5kZXhPZihcIiBcIik7XG4gIGNvbnN0IGJhc2UgPSBzcGFjZSA+IE1hdGguZmxvb3IobWF4TGVuICogMC42KSA/IGN1dC5zbGljZSgwLCBzcGFjZSkgOiBjdXQ7XG4gIHJldHVybiBgJHtiYXNlLnJlcGxhY2UoL1suLDs6XFxzLV0rJC8sIFwiXCIpfVx1MjAyNmA7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXRTaG9ydFRpbWUoZGF0ZTogRGF0ZSk6IHN0cmluZyB7XG4gIGNvbnN0IHBhZCA9IChuOiBudW1iZXIpID0+IFN0cmluZyhuKS5wYWRTdGFydCgyLCBcIjBcIik7XG4gIHJldHVybiBgJHtwYWQoZGF0ZS5nZXRIb3VycygpKX06JHtwYWQoZGF0ZS5nZXRNaW51dGVzKCkpfWA7XG59XG5cbi8qKiBEZWNpZGUgd2hpY2ggc2VjdGlvbnMgb2YgdGhlIHJpZ2h0LWhhbmQgQWdlbnQgV29ya3NwYWNlIGFyZSB2aXNpYmxlIGZvciBhIGdpdmVuIGZpbHRlciBhbmQgY291bnRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVTaWRlU2VjdGlvbnMoZmlsdGVyOiBTaWRlRmlsdGVyLCBjb3VudHM6IFNpZGVDb3VudHMpOiBTaWRlVmlzaWJpbGl0eSB7XG4gIGlmIChmaWx0ZXIgPT09IFwicmVzdWx0c1wiKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHNob3dUYXNrc1NlY3Rpb246IGZhbHNlLFxuICAgICAgc2hvd0VtcHR5VGFza3M6IGZhbHNlLFxuICAgICAgc2hvd1Jlc3VsdHNTZWN0aW9uOiB0cnVlLFxuICAgICAgc2hvd0VtcHR5UmVzdWx0czogY291bnRzLnJlc3VsdHMgPT09IDAsXG4gICAgICBzaG93RWFybGllclNlY3Rpb246IGZhbHNlLFxuICAgICAgc2hvd0RvbmVTZWN0aW9uOiBmYWxzZSxcbiAgICB9O1xuICB9XG4gIGlmIChmaWx0ZXIgPT09IFwiYWN0aXZlXCIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc2hvd1Rhc2tzU2VjdGlvbjogdHJ1ZSxcbiAgICAgIHNob3dFbXB0eVRhc2tzOiBjb3VudHMuYWN0aXZlID09PSAwICYmIGNvdW50cy5lYXJsaWVyID09PSAwLFxuICAgICAgc2hvd1Jlc3VsdHNTZWN0aW9uOiBmYWxzZSxcbiAgICAgIHNob3dFbXB0eVJlc3VsdHM6IGZhbHNlLFxuICAgICAgc2hvd0VhcmxpZXJTZWN0aW9uOiBjb3VudHMuZWFybGllciA+IDAsXG4gICAgICBzaG93RG9uZVNlY3Rpb246IGNvdW50cy5kb25lID4gMCxcbiAgICB9O1xuICB9XG4gIC8vIFwiYWxsXCI6IGhpZGUgdGhlIGVtcHR5IGFjdGl2ZS10YXNrcyBwbGFjZWhvbGRlciBhcyBzb29uIGFzIHJlc3VsdHMgb3IgZWFybGllciBhZ2VudHMgZXhpc3RcbiAgLy8gc28gZmluaXNoZWQgcmVzcG9uc2VzIHRha2UgdGhlIHRvcCBvZiB0aGUgcGFuZSB3aXRob3V0IHdhc3RlZCBzcGFjZS5cbiAgY29uc3QgaGFzQW55dGhpbmdBYm92ZURvbmUgPSBjb3VudHMuYWN0aXZlID4gMCB8fCBjb3VudHMucmVzdWx0cyA+IDAgfHwgY291bnRzLmVhcmxpZXIgPiAwO1xuICByZXR1cm4ge1xuICAgIHNob3dUYXNrc1NlY3Rpb246IGNvdW50cy5hY3RpdmUgPiAwIHx8ICFoYXNBbnl0aGluZ0Fib3ZlRG9uZSxcbiAgICBzaG93RW1wdHlUYXNrczogIWhhc0FueXRoaW5nQWJvdmVEb25lLFxuICAgIHNob3dSZXN1bHRzU2VjdGlvbjogY291bnRzLnJlc3VsdHMgPiAwLFxuICAgIHNob3dFbXB0eVJlc3VsdHM6IGZhbHNlLFxuICAgIHNob3dFYXJsaWVyU2VjdGlvbjogY291bnRzLmVhcmxpZXIgPiAwLFxuICAgIHNob3dEb25lU2VjdGlvbjogY291bnRzLmRvbmUgPiAwLFxuICB9O1xufVxuIiwgIi8vIE1haW4tdGhyZWFkIGNvbnRyb2xsZXIgZm9yIHRoZSB3YWtlIHdvcmQgV2ViIFdvcmtlciBhbmQgU2NyZWVuIFdha2UgTG9jayBoZWxwZXIuXG4vLyBUYWdzIGV2ZXJ5IGxvYWQgYW5kIHJlc2V0IHdpdGggYSBtb25vdG9uaWMgZ2VuZXJhdGlvbiAoYGdlbmApIHNvIHN0YWxlIGRldGVjdGlvbnMgb3IgcmVhZHkgZXZlbnRzXG4vLyBhZnRlciBhIG1vZGVsIHN3aXRjaCBvciByZXNldCBhcmUgaWdub3JlZCwgYW5kIGtlZXBzIGEgc2hvcnQgcmluZyBidWZmZXIgb2YgcmVjZW50IGZlZCBjaHVua3Ncbi8vIGluZGV4ZWQgYnkgYHNlcWAgKHdpdGggcGVyLWZyYW1lIGBzdXBwcmVzc2VkYCBmbGFncykgc28gYXVkaW8gY2FwdHVyZWQgd2hpbGUgdGhlIHdvcmtlciB3YXNcbi8vIHNjb3JpbmcgaXMgcHJlc2VydmVkIGluIGBoaXQudHJhaWxpbmdgIHdpdGhvdXQgZHVwbGljYXRpbmcgdW5zdXBwcmVzc2VkIGZyYW1lcy5cblxuZXhwb3J0IGludGVyZmFjZSBXYWtlVGVsZW1ldHJ5IHtcbiAgc2NvcmU6IG51bWJlcjtcbiAgcGVhazogbnVtYmVyO1xuICBnYXRlT3BlbjogYm9vbGVhbjtcbiAgZnJhbWVzOiBudW1iZXI7XG4gIHNjb3JlZDogbnVtYmVyO1xuICBpbmZlck1zOiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgV2FrZVRyYWlsaW5nQ2h1bmsge1xuICAvKiogU2VxdWVuY2UgbnVtYmVyIGZyb20gYGZlZWQoKWAsIG1hdGNoaW5nIHRoZSBmZWQgY2h1bmsuICovXG4gIHNlcTogbnVtYmVyO1xuICBieXRlczogVWludDhBcnJheTtcbiAgLyoqIFRydWUgd2hlbiB0aGUgY29yZSBzdXBwcmVzc2VkIChzaWxlbmNlZCkgdGhpcyBmcmFtZSBkdXJpbmcgYXVkaWJsZSBwbGF5YmFjayAoYHdoaWxlU3BlYWtpbmcgIT09IFwic2VuZFwiYCkuICovXG4gIHN1cHByZXNzZWQ6IGJvb2xlYW47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgV2FrZURldGVjdGlvbkV2ZW50IHtcbiAgc2NvcmU6IG51bWJlcjtcbiAgYXRGcmFtZTogbnVtYmVyO1xuICAvKiogQXVkaW8gY2h1bmtzIHNwb2tlbiBhZnRlciB0aGUgd2FrZSB3b3JkOiB0aGUgdHJpZ2dlcmluZyBjaHVuaydzIHRhaWwgcGx1cyBhbnkgY2h1bmtzIGFscmVhZHkgc2VudCBhZnRlciBpdC4gKi9cbiAgdHJhaWxpbmc6IFdha2VUcmFpbGluZ0NodW5rW107XG4gIGluZmVyTXM6IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBXYWtlQ2xpZW50Q2FsbGJhY2tzIHtcbiAgb25SZWFkeT86IChtb2RlbElkOiBzdHJpbmcsIHdhcm11cE1zOiBudW1iZXIpID0+IHZvaWQ7XG4gIG9uRGV0ZWN0ZWQ6IChoaXQ6IFdha2VEZXRlY3Rpb25FdmVudCkgPT4gdm9pZDtcbiAgb25UZWxlbWV0cnk/OiAodDogV2FrZVRlbGVtZXRyeSkgPT4gdm9pZDtcbiAgLyoqIENhbGxlZCBvbmNlIGFsbCBpbi1mbGlnaHQgc3VwcHJlc3NlZCBmcmFtZXMgaGF2ZSBiZWVuIHNjb3JlZCB3aXRob3V0IGZpcmluZyBhIGRldGVjdGlvbi4gKi9cbiAgb25TdXBwcmVzc2VkU2V0dGxlZD86ICgpID0+IHZvaWQ7XG4gIG9uRXJyb3I/OiAobWVzc2FnZTogc3RyaW5nKSA9PiB2b2lkO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFdvcmtlckxpa2Uge1xuICBvbm1lc3NhZ2U6ICgoZTogTWVzc2FnZUV2ZW50PFJlY29yZDxzdHJpbmcsIGFueT4+KSA9PiB2b2lkKSB8IG51bGw7XG4gIG9uZXJyb3I6ICgoZTogRXJyb3JFdmVudCkgPT4gdm9pZCkgfCBudWxsO1xuICBwb3N0TWVzc2FnZShtZXNzYWdlOiB1bmtub3duLCB0cmFuc2Zlcj86IFRyYW5zZmVyYWJsZVtdKTogdm9pZDtcbiAgdGVybWluYXRlKCk6IHZvaWQ7XG59XG5cbi8qKiBNYXggYnVmZmVyZWQgcG9zdC1mZWVkIGF1ZGlvICh+MS41IHMgYXQgMjAgbXMgY2h1bmtzKSB0byBjb3ZlciB3b3JrZXIgc2NvcmluZyBsYXRlbmN5LiAqL1xuY29uc3QgUkVDRU5UX01BWF9CWVRFUyA9IE1hdGgucm91bmQoMS41ICogMzJfMDAwKTtcblxuZXhwb3J0IGNsYXNzIFdha2VDbGllbnQge1xuICBwcml2YXRlIHdvcmtlcjogV29ya2VyTGlrZSB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIHJlYWRvbmx5IGNhbGxiYWNrczogV2FrZUNsaWVudENhbGxiYWNrcztcbiAgcHJpdmF0ZSByZWFkb25seSBjcmVhdGVXb3JrZXI6ICgpID0+IFdvcmtlckxpa2U7XG4gIHByaXZhdGUgbG9hZGVkTW9kZWxJZDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgbG9hZGluZ01vZGVsSWQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIGN1cnJlbnRUaHJlc2hvbGQgPSAwLjc7XG4gIHByaXZhdGUgZ2VuID0gMDtcbiAgcHJpdmF0ZSBzZXEgPSAwO1xuICBwcml2YXRlIGxhc3RTdXBwcmVzc2VkU2VxID0gMDtcbiAgcHJpdmF0ZSBsYXN0QWNrZWRTZXEgPSAwO1xuICBwcml2YXRlIHJlY2VudDogeyBzZXE6IG51bWJlcjsgYnl0ZXM6IFVpbnQ4QXJyYXk7IHN1cHByZXNzZWQ6IGJvb2xlYW4gfVtdID0gW107XG4gIHByaXZhdGUgcmVjZW50Qnl0ZXMgPSAwO1xuICByZWFkeSA9IGZhbHNlO1xuXG4gIGNvbnN0cnVjdG9yKFxuICAgIGNhbGxiYWNrczogV2FrZUNsaWVudENhbGxiYWNrcyxcbiAgICBjcmVhdGVXb3JrZXI6ICgpID0+IFdvcmtlckxpa2UgPSAoKSA9PiBuZXcgV29ya2VyKFwiL3dha2Uud29ya2VyLmpzXCIsIHsgdHlwZTogXCJtb2R1bGVcIiB9KSxcbiAgKSB7XG4gICAgdGhpcy5jYWxsYmFja3MgPSBjYWxsYmFja3M7XG4gICAgdGhpcy5jcmVhdGVXb3JrZXIgPSBjcmVhdGVXb3JrZXI7XG4gIH1cblxuICAvKiogTGF0ZXN0IG1vbm90b25pYyBzZXF1ZW5jZSBudW1iZXIgYXNzaWduZWQgYnkgYGZlZWQoKWAuICovXG4gIGdldCBsYXN0U2VxKCk6IG51bWJlciB7XG4gICAgcmV0dXJuIHRoaXMuc2VxO1xuICB9XG5cbiAgLyoqIEhpZ2hlc3Qgc2VxdWVuY2UgbnVtYmVyIG9mIGFuIGluLWZsaWdodCBzdXBwcmVzc2VkIGZyYW1lLCBvciAwIGlmIG5vbmUgYXJlIHNjb3JpbmcuICovXG4gIGdldCBpbkZsaWdodFN1cHByZXNzZWRTZXEoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gdGhpcy5sYXN0U3VwcHJlc3NlZFNlcSA+IHRoaXMubGFzdEFja2VkU2VxID8gdGhpcy5sYXN0U3VwcHJlc3NlZFNlcSA6IDA7XG4gIH1cblxuICAvKiogVHJ1ZSB3aGlsZSBhdCBsZWFzdCBvbmUgc3VwcHJlc3NlZCBmcmFtZSBpcyBzdGlsbCBxdWV1ZWQgb3Igc2NvcmluZyBpbiB0aGUgd29ya2VyLiAqL1xuICBnZXQgc3VwcHJlc3NlZEluRmxpZ2h0KCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLmluRmxpZ2h0U3VwcHJlc3NlZFNlcSA+IDA7XG4gIH1cblxuICBwcml2YXRlIGNsZWFyUmVjZW50KCk6IHZvaWQge1xuICAgIHRoaXMucmVjZW50ID0gW107XG4gICAgdGhpcy5yZWNlbnRCeXRlcyA9IDA7XG4gIH1cblxuICBwcml2YXRlIGNsZWFyU3VwcHJlc3NlZFRyYWNraW5nKCk6IHZvaWQge1xuICAgIGNvbnN0IGhhZEluRmxpZ2h0ID0gdGhpcy5zdXBwcmVzc2VkSW5GbGlnaHQ7XG4gICAgdGhpcy5sYXN0U3VwcHJlc3NlZFNlcSA9IDA7XG4gICAgdGhpcy5sYXN0QWNrZWRTZXEgPSAwO1xuICAgIGlmIChoYWRJbkZsaWdodCkgdGhpcy5jYWxsYmFja3Mub25TdXBwcmVzc2VkU2V0dGxlZD8uKCk7XG4gIH1cblxuICBwcml2YXRlIGVuc3VyZVdvcmtlcigpOiBXb3JrZXJMaWtlIHtcbiAgICBpZiAodGhpcy53b3JrZXIpIHJldHVybiB0aGlzLndvcmtlcjtcbiAgICBjb25zdCB3b3JrZXIgPSB0aGlzLmNyZWF0ZVdvcmtlcigpO1xuICAgIHdvcmtlci5vbm1lc3NhZ2UgPSAoZTogTWVzc2FnZUV2ZW50PFJlY29yZDxzdHJpbmcsIGFueT4+KSA9PiB7XG4gICAgICBjb25zdCBtID0gZS5kYXRhO1xuICAgICAgaWYgKHR5cGVvZiBtLmdlbiA9PT0gXCJudW1iZXJcIiAmJiBtLmdlbiAhPT0gdGhpcy5nZW4pIHJldHVybjtcbiAgICAgIGlmIChtLnR5cGUgPT09IFwicmVhZHlcIikge1xuICAgICAgICB0aGlzLmxvYWRpbmdNb2RlbElkID0gbnVsbDtcbiAgICAgICAgdGhpcy5sb2FkZWRNb2RlbElkID0gbS5tb2RlbElkO1xuICAgICAgICB0aGlzLnJlYWR5ID0gdHJ1ZTtcbiAgICAgICAgdGhpcy5jYWxsYmFja3Mub25SZWFkeT8uKG0ubW9kZWxJZCwgbS53YXJtdXBNcyk7XG4gICAgICB9IGVsc2UgaWYgKG0udHlwZSA9PT0gXCJhY2tcIikge1xuICAgICAgICBjb25zdCB3YXNJbkZsaWdodCA9IHRoaXMuc3VwcHJlc3NlZEluRmxpZ2h0O1xuICAgICAgICBpZiAodHlwZW9mIG0uc2VxID09PSBcIm51bWJlclwiICYmIG0uc2VxID4gdGhpcy5sYXN0QWNrZWRTZXEpIHRoaXMubGFzdEFja2VkU2VxID0gbS5zZXE7XG4gICAgICAgIGlmICh3YXNJbkZsaWdodCAmJiAhdGhpcy5zdXBwcmVzc2VkSW5GbGlnaHQpIHRoaXMuY2FsbGJhY2tzLm9uU3VwcHJlc3NlZFNldHRsZWQ/LigpO1xuICAgICAgfSBlbHNlIGlmIChtLnR5cGUgPT09IFwiZGV0ZWN0ZWRcIikge1xuICAgICAgICBjb25zdCB0cmFpbGluZzogV2FrZVRyYWlsaW5nQ2h1bmtbXSA9IFtdO1xuICAgICAgICBjb25zdCByZXN0ID0gbmV3IFVpbnQ4QXJyYXkobS5yZXN0Qnl0ZXMgYXMgQXJyYXlCdWZmZXIpO1xuICAgICAgICBjb25zdCBoaXRTZXEgPSB0eXBlb2YgbS5zZXEgPT09IFwibnVtYmVyXCIgPyBtLnNlcSA6IE51bWJlci5NQVhfU0FGRV9JTlRFR0VSO1xuICAgICAgICBjb25zdCBoaXRJdGVtID0gdGhpcy5yZWNlbnQuZmluZCgoaXRlbSkgPT4gaXRlbS5zZXEgPT09IGhpdFNlcSk7XG4gICAgICAgIGlmIChyZXN0LmJ5dGVMZW5ndGggPiAwKSB7XG4gICAgICAgICAgdHJhaWxpbmcucHVzaCh7IHNlcTogaGl0U2VxLCBieXRlczogcmVzdCwgc3VwcHJlc3NlZDogaGl0SXRlbT8uc3VwcHJlc3NlZCA/PyBmYWxzZSB9KTtcbiAgICAgICAgfVxuICAgICAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgdGhpcy5yZWNlbnQpIHtcbiAgICAgICAgICBpZiAoaXRlbS5zZXEgPiBoaXRTZXEpIHRyYWlsaW5nLnB1c2goeyBzZXE6IGl0ZW0uc2VxLCBieXRlczogaXRlbS5ieXRlcywgc3VwcHJlc3NlZDogaXRlbS5zdXBwcmVzc2VkIH0pO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMuY2xlYXJSZWNlbnQoKTtcbiAgICAgICAgdGhpcy5sYXN0U3VwcHJlc3NlZFNlcSA9IDA7XG4gICAgICAgIHRoaXMubGFzdEFja2VkU2VxID0gMDtcbiAgICAgICAgdGhpcy5jYWxsYmFja3Mub25EZXRlY3RlZCh7XG4gICAgICAgICAgc2NvcmU6IG0uc2NvcmUsXG4gICAgICAgICAgYXRGcmFtZTogbS5hdEZyYW1lLFxuICAgICAgICAgIHRyYWlsaW5nLFxuICAgICAgICAgIGluZmVyTXM6IG0uaW5mZXJNcyxcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2UgaWYgKG0udHlwZSA9PT0gXCJ0ZWxlbWV0cnlcIikge1xuICAgICAgICB0aGlzLmNhbGxiYWNrcy5vblRlbGVtZXRyeT8uKHtcbiAgICAgICAgICBzY29yZTogbS5zY29yZSxcbiAgICAgICAgICBwZWFrOiBtLnBlYWssXG4gICAgICAgICAgZ2F0ZU9wZW46IG0uZ2F0ZU9wZW4sXG4gICAgICAgICAgZnJhbWVzOiBtLmZyYW1lcyxcbiAgICAgICAgICBzY29yZWQ6IG0uc2NvcmVkLFxuICAgICAgICAgIGluZmVyTXM6IG0uaW5mZXJNcyxcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2UgaWYgKG0udHlwZSA9PT0gXCJlcnJvclwiKSB7XG4gICAgICAgIHRoaXMubG9hZGluZ01vZGVsSWQgPSBudWxsO1xuICAgICAgICB0aGlzLnJlYWR5ID0gZmFsc2U7XG4gICAgICAgIHRoaXMuY2xlYXJTdXBwcmVzc2VkVHJhY2tpbmcoKTtcbiAgICAgICAgdGhpcy5jYWxsYmFja3Mub25FcnJvcj8uKFN0cmluZyhtLm1lc3NhZ2UgPz8gXCJ3YWtlIHdvcmtlciBlcnJvclwiKSk7XG4gICAgICB9XG4gICAgfTtcbiAgICB3b3JrZXIub25lcnJvciA9IChlcnIpID0+IHtcbiAgICAgIHRoaXMubG9hZGluZ01vZGVsSWQgPSBudWxsO1xuICAgICAgdGhpcy5yZWFkeSA9IGZhbHNlO1xuICAgICAgdGhpcy5jbGVhclN1cHByZXNzZWRUcmFja2luZygpO1xuICAgICAgdGhpcy5jYWxsYmFja3Mub25FcnJvcj8uKGVyci5tZXNzYWdlIHx8IFwid2FrZSB3b3JrZXIgZmFpbGVkXCIpO1xuICAgIH07XG4gICAgdGhpcy53b3JrZXIgPSB3b3JrZXI7XG4gICAgcmV0dXJuIHdvcmtlcjtcbiAgfVxuXG4gIC8qKiBMb2FkcyAob3Igc3dpdGNoZXMgdG8pIHRoZSBuYW1lZCBtb2RlbDsgaWdub3JlcyBzdGFsZSByZXN1bHRzIGZyb20gZWFybGllciBsb2Fkcy4gKi9cbiAgbG9hZChtb2RlbElkOiBzdHJpbmcsIHRocmVzaG9sZDogbnVtYmVyKTogdm9pZCB7XG4gICAgdGhpcy5jdXJyZW50VGhyZXNob2xkID0gdGhyZXNob2xkO1xuICAgIGNvbnN0IHdvcmtlciA9IHRoaXMuZW5zdXJlV29ya2VyKCk7XG4gICAgaWYgKHRoaXMucmVhZHkgJiYgdGhpcy5sb2FkZWRNb2RlbElkID09PSBtb2RlbElkKSB7XG4gICAgICB3b3JrZXIucG9zdE1lc3NhZ2UoeyB0eXBlOiBcImNvbmZpZ1wiLCB0aHJlc2hvbGQgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICh0aGlzLmxvYWRpbmdNb2RlbElkID09PSBtb2RlbElkKSB7XG4gICAgICB3b3JrZXIucG9zdE1lc3NhZ2UoeyB0eXBlOiBcImNvbmZpZ1wiLCB0aHJlc2hvbGQgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRoaXMuZ2VuKys7XG4gICAgdGhpcy5yZWFkeSA9IGZhbHNlO1xuICAgIHRoaXMubG9hZGluZ01vZGVsSWQgPSBtb2RlbElkO1xuICAgIHRoaXMuY2xlYXJSZWNlbnQoKTtcbiAgICB0aGlzLmNsZWFyU3VwcHJlc3NlZFRyYWNraW5nKCk7XG4gICAgd29ya2VyLnBvc3RNZXNzYWdlKHtcbiAgICAgIHR5cGU6IFwibG9hZFwiLFxuICAgICAgZ2VuOiB0aGlzLmdlbixcbiAgICAgIG1vZGVsSWQsXG4gICAgICB1cmw6IGAvd2FrZS9tb2RlbHMvJHtlbmNvZGVVUklDb21wb25lbnQobW9kZWxJZCl9Lm9ubnhgLFxuICAgICAgdGhyZXNob2xkLFxuICAgICAgd2FzbVBhdGhzOiBcIi9vcnQvXCIsXG4gICAgfSk7XG4gIH1cblxuICBzZXRUaHJlc2hvbGQodGhyZXNob2xkOiBudW1iZXIpOiB2b2lkIHtcbiAgICB0aGlzLmN1cnJlbnRUaHJlc2hvbGQgPSB0aHJlc2hvbGQ7XG4gICAgdGhpcy53b3JrZXI/LnBvc3RNZXNzYWdlKHsgdHlwZTogXCJjb25maWdcIiwgdGhyZXNob2xkIH0pO1xuICB9XG5cbiAgLyoqIEZlZWRzIGEgMTYga0h6IFBDTTE2IGNodW5rIHRvIHRoZSB3b3JrZXI7IHJldHVybnMgaXRzIHNlcXVlbmNlIG51bWJlciAob3IgMCBpZiBub3QgcmVhZHkpLiAqL1xuICBmZWVkKHNhbXBsZXM6IEludDE2QXJyYXksIHN1cHByZXNzZWQgPSBmYWxzZSk6IG51bWJlciB7XG4gICAgaWYgKCF0aGlzLnJlYWR5IHx8ICF0aGlzLndvcmtlcikgcmV0dXJuIDA7XG4gICAgY29uc3Qgc2VxID0gKyt0aGlzLnNlcTtcbiAgICBpZiAoc3VwcHJlc3NlZCkgdGhpcy5sYXN0U3VwcHJlc3NlZFNlcSA9IHNlcTtcbiAgICBjb25zdCBieXRlcyA9IG5ldyBVaW50OEFycmF5KHNhbXBsZXMuYnl0ZUxlbmd0aCk7XG4gICAgYnl0ZXMuc2V0KG5ldyBVaW50OEFycmF5KHNhbXBsZXMuYnVmZmVyLCBzYW1wbGVzLmJ5dGVPZmZzZXQsIHNhbXBsZXMuYnl0ZUxlbmd0aCkpO1xuICAgIHRoaXMucmVjZW50LnB1c2goeyBzZXEsIGJ5dGVzLCBzdXBwcmVzc2VkIH0pO1xuICAgIHRoaXMucmVjZW50Qnl0ZXMgKz0gYnl0ZXMuYnl0ZUxlbmd0aDtcbiAgICB3aGlsZSAodGhpcy5yZWNlbnRCeXRlcyA+IFJFQ0VOVF9NQVhfQllURVMgJiYgdGhpcy5yZWNlbnQubGVuZ3RoID4gMSkge1xuICAgICAgdGhpcy5yZWNlbnRCeXRlcyAtPSB0aGlzLnJlY2VudC5zaGlmdCgpIS5ieXRlcy5ieXRlTGVuZ3RoO1xuICAgIH1cbiAgICBjb25zdCBjb3B5ID0gbmV3IEludDE2QXJyYXkoc2FtcGxlcy5sZW5ndGgpO1xuICAgIGNvcHkuc2V0KHNhbXBsZXMpO1xuICAgIHRoaXMud29ya2VyLnBvc3RNZXNzYWdlKHsgdHlwZTogXCJmZWVkXCIsIGdlbjogdGhpcy5nZW4sIHNlcSwgYWNrOiBzdXBwcmVzc2VkLCBwY206IGNvcHkuYnVmZmVyIH0sIFtjb3B5LmJ1ZmZlcl0pO1xuICAgIHJldHVybiBzZXE7XG4gIH1cblxuICByZXNldCgpOiB2b2lkIHtcbiAgICB0aGlzLmNsZWFyUmVjZW50KCk7XG4gICAgdGhpcy5jbGVhclN1cHByZXNzZWRUcmFja2luZygpO1xuICAgIGlmICghdGhpcy53b3JrZXIgfHwgIXRoaXMucmVhZHkpIHJldHVybjtcbiAgICB0aGlzLmdlbisrO1xuICAgIHRoaXMud29ya2VyLnBvc3RNZXNzYWdlKHsgdHlwZTogXCJyZXNldFwiLCBnZW46IHRoaXMuZ2VuIH0pO1xuICB9XG5cbiAgZGlzcG9zZSgpOiB2b2lkIHtcbiAgICB0aGlzLmdlbisrO1xuICAgIHRoaXMucmVhZHkgPSBmYWxzZTtcbiAgICB0aGlzLmxvYWRlZE1vZGVsSWQgPSBudWxsO1xuICAgIHRoaXMubG9hZGluZ01vZGVsSWQgPSBudWxsO1xuICAgIHRoaXMuY2xlYXJSZWNlbnQoKTtcbiAgICB0aGlzLmNsZWFyU3VwcHJlc3NlZFRyYWNraW5nKCk7XG4gICAgaWYgKHRoaXMud29ya2VyKSB7XG4gICAgICB0aGlzLndvcmtlci5wb3N0TWVzc2FnZSh7IHR5cGU6IFwiZGlzcG9zZVwiLCBnZW46IHRoaXMuZ2VuIH0pO1xuICAgICAgdGhpcy53b3JrZXIudGVybWluYXRlKCk7XG4gICAgICB0aGlzLndvcmtlciA9IG51bGw7XG4gICAgfVxuICB9XG5cbiAgZ2V0IG1vZGVsSWQoKTogc3RyaW5nIHwgbnVsbCB7XG4gICAgcmV0dXJuIHRoaXMubG9hZGVkTW9kZWxJZCA/PyB0aGlzLmxvYWRpbmdNb2RlbElkO1xuICB9XG5cbiAgZ2V0IHRocmVzaG9sZCgpOiBudW1iZXIge1xuICAgIHJldHVybiB0aGlzLmN1cnJlbnRUaHJlc2hvbGQ7XG4gIH1cbn1cblxuZXhwb3J0IGludGVyZmFjZSBXYWtlTG9ja1NlbnRpbmVsTGlrZSB7XG4gIHJlYWRvbmx5IHJlbGVhc2VkPzogYm9vbGVhbjtcbiAgcmVsZWFzZSgpOiBQcm9taXNlPHZvaWQ+O1xuICBhZGRFdmVudExpc3RlbmVyPyh0eXBlOiBzdHJpbmcsIGxpc3RlbmVyOiAoKSA9PiB2b2lkKTogdm9pZDtcbn1cblxuLyoqXG4gKiBXcmFwcyB0aGUgU2NyZWVuIFdha2UgTG9jayBBUEkgc28gYnJvd3Nlci1pbml0aWF0ZWQgcmVsZWFzZXMgKHN1Y2ggYXMgaGlkaW5nIGEgdGFiKSBjbGVhciB0aGVcbiAqIHN0b3JlZCBzZW50aW5lbCBhbmQgYWxsb3cgcmVhY3F1aXJpbmcgb24gdmlzaWJpbGl0eSByZXN0b3JlLCB3aGlsZSBjYW5jZWxsaW5nIGluLWZsaWdodCByZXF1ZXN0cy5cbiAqL1xuZXhwb3J0IGNsYXNzIFNjcmVlbldha2VMb2NrIHtcbiAgcHJpdmF0ZSBzZW50aW5lbDogV2FrZUxvY2tTZW50aW5lbExpa2UgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBnZW4gPSAwO1xuICBwcml2YXRlIHJlYWRvbmx5IHJlcXVlc3RMb2NrOiAoKSA9PiBQcm9taXNlPFdha2VMb2NrU2VudGluZWxMaWtlIHwgdW5kZWZpbmVkPjtcblxuICBjb25zdHJ1Y3RvcihcbiAgICByZXF1ZXN0TG9jazogKCkgPT4gUHJvbWlzZTxXYWtlTG9ja1NlbnRpbmVsTGlrZSB8IHVuZGVmaW5lZD4gPSAoKSA9PlxuICAgICAgKG5hdmlnYXRvciBhcyBhbnkpLndha2VMb2NrPy5yZXF1ZXN0KFwic2NyZWVuXCIpID8/IFByb21pc2UucmVzb2x2ZSh1bmRlZmluZWQpLFxuICApIHtcbiAgICB0aGlzLnJlcXVlc3RMb2NrID0gcmVxdWVzdExvY2s7XG4gIH1cblxuICBnZXQgaGVsZCgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5zZW50aW5lbCAhPSBudWxsICYmICF0aGlzLnNlbnRpbmVsLnJlbGVhc2VkO1xuICB9XG5cbiAgYXN5bmMgYWNxdWlyZShzdGlsbFdhbnRlZDogKCkgPT4gYm9vbGVhbik6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICh0aGlzLmhlbGQgfHwgIXN0aWxsV2FudGVkKCkpIHJldHVybjtcbiAgICBjb25zdCBnZW4gPSArK3RoaXMuZ2VuO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBsb2NrID0gYXdhaXQgdGhpcy5yZXF1ZXN0TG9jaygpO1xuICAgICAgaWYgKCFsb2NrKSByZXR1cm47XG4gICAgICBpZiAoZ2VuICE9PSB0aGlzLmdlbiB8fCAhc3RpbGxXYW50ZWQoKSkge1xuICAgICAgICB2b2lkIGxvY2sucmVsZWFzZSgpLmNhdGNoKCgpID0+IHt9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgdGhpcy5zZW50aW5lbCA9IGxvY2s7XG4gICAgICBsb2NrLmFkZEV2ZW50TGlzdGVuZXI/LihcInJlbGVhc2VcIiwgKCkgPT4ge1xuICAgICAgICBpZiAodGhpcy5zZW50aW5lbCA9PT0gbG9jaykgdGhpcy5zZW50aW5lbCA9IG51bGw7XG4gICAgICB9KTtcbiAgICB9IGNhdGNoIHt9XG4gIH1cblxuICByZWxlYXNlKCk6IHZvaWQge1xuICAgIHRoaXMuZ2VuKys7XG4gICAgY29uc3QgbG9jayA9IHRoaXMuc2VudGluZWw7XG4gICAgdGhpcy5zZW50aW5lbCA9IG51bGw7XG4gICAgdm9pZCBsb2NrPy5yZWxlYXNlKCkuY2F0Y2goKCkgPT4ge30pO1xuICB9XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRGVmZXJyZWRNaWNGcmFtZSB7XG4gIHNlcTogbnVtYmVyO1xuICBmbG9vclNlcTogbnVtYmVyO1xuICBwY206IHN0cmluZztcbiAgdDogbnVtYmVyO1xufVxuXG4vKipcbiAqIE1pcnJvcnMgdGhlIHZvaWNlIGNvcmUncyBwbGF5YmFjayBzdXBwcmVzc2lvbiBjbG9jayBhbmQgY29vcmRpbmF0ZXMgZGVmZXJyZWQgcG9zdC1wbGF5YmFja1xuICogbWljcm9waG9uZSBmcmFtZXMgd2l0aCBhc3luY2hyb25vdXMgd2FrZS13b3JkIHRhaWwgcmVwbGF5LlxuICpcbiAqIFNlcGFyYXRpbmcgd2FrZSBhY2NlcHRhbmNlIGZyb20gcmVwbGF5IGVsaWdpYmlsaXR5IChgcmVwbGF5Rmxvb3JTZXFgKSBlbnN1cmVzIHRoYXQgZm9yd2FyZGluZ1xuICogYSBnYXAgZnJhbWUgYmVmb3JlIG5ldyBwbGF5YmFjayBuZXZlciBzaWxlbmNlcyBnYXAgYXVkaW8sIG5ldmVyIGRpc2NhcmRzIGEgdmFsaWQgd2FrZSBoaXQsXG4gKiBhbmQgbmV2ZXIgcmVwbGF5cyBvbGRlciBzdXBwcmVzc2VkIGF1ZGlvIGFmdGVyIG5ld2VyIGF1ZGlvIGFscmVhZHkgc2VudCB0byB0aGUgY29yZS5cbiAqL1xuZnVuY3Rpb24gdmFsaWRCcmllZlBjbUJ5dGVzKHBjbTogdW5rbm93bik6IG51bWJlciB7XG4gIGlmICh0eXBlb2YgcGNtICE9PSBcInN0cmluZ1wiIHx8IHBjbS5sZW5ndGggPT09IDAgfHwgcGNtLmxlbmd0aCAlIDQgIT09IDApIHJldHVybiAtMTtcbiAgaWYgKCEvXltBLVphLXowLTkrL10qPXswLDJ9JC8udGVzdChwY20pKSByZXR1cm4gLTE7XG4gIGNvbnN0IHBhZCA9IHBjbS5lbmRzV2l0aChcIj09XCIpID8gMiA6IHBjbS5lbmRzV2l0aChcIj1cIikgPyAxIDogMDtcbiAgY29uc3Qgc2l6ZSA9IE1hdGguZmxvb3IoKHBjbS5sZW5ndGggKiAzKSAvIDQpIC0gcGFkO1xuICByZXR1cm4gc2l6ZSA+IDAgJiYgc2l6ZSAlIDIgPT09IDAgJiYgc2l6ZSA8PSAyXzg4MF8wMDAgPyBzaXplIDogLTE7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgV2FrZUF1ZGlvR2F0ZUxpbWl0cyB7XG4gIGRlbGl2ZXJNYXg/OiBudW1iZXI7XG4gIGJyaWVmV2FpdD86IG51bWJlcjtcbn1cblxuZXhwb3J0IGNsYXNzIFdha2VBdWRpb0dhdGUge1xuICBwcml2YXRlIHdoaWxlU3BlYWtpbmcgPSBcInNlbmRcIjtcbiAgcHJpdmF0ZSBzcGVlY2hVbnRpbCA9IDA7XG4gIHByaXZhdGUgZGVsaXZlck1heCA9IDMwO1xuICBwcml2YXRlIGJyaWVmV2FpdCA9IDM7XG4gIHByaXZhdGUgYWN0aXZlQnJpZWY6IHsgZnJvbTogbnVtYmVyOyB1bnRpbDogbnVtYmVyOyBicmllZkF0OiBudW1iZXIgfSB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIHJlYWR5QnJpZWZzOiBudW1iZXJbXSA9IFtdO1xuICBwcml2YXRlIHJlcXVlc3RlZEJyaWVmcyA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gIHByaXZhdGUgbGFzdEN1dDogeyBhdDogbnVtYmVyOyBicmllZkF0OiBudW1iZXIgfSB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIGxhc3RTdG9wcGVkQnJpZWZBdDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgcmVwbGF5Rmxvb3JTZXEgPSAwO1xuICBwcml2YXRlIGRlZmVycmVkOiBEZWZlcnJlZE1pY0ZyYW1lW10gPSBbXTtcbiAgcHJpdmF0ZSByZWFkb25seSBtYXhEZWZlcnJlZDogbnVtYmVyO1xuXG4gIGNvbnN0cnVjdG9yKG1heERlZmVycmVkID0gNjApIHtcbiAgICB0aGlzLm1heERlZmVycmVkID0gbWF4RGVmZXJyZWQ7XG4gIH1cblxuICByZXNldCh3aGlsZVNwZWFraW5nID0gXCJzZW5kXCIsIGZsb29yU2VxID0gMCwgbGltaXRzOiBXYWtlQXVkaW9HYXRlTGltaXRzID0ge30pOiB2b2lkIHtcbiAgICB0aGlzLndoaWxlU3BlYWtpbmcgPSB3aGlsZVNwZWFraW5nO1xuICAgIHRoaXMuc3BlZWNoVW50aWwgPSAwO1xuICAgIHRoaXMuZGVsaXZlck1heCA9IHR5cGVvZiBsaW1pdHMuZGVsaXZlck1heCA9PT0gXCJudW1iZXJcIiA/IGxpbWl0cy5kZWxpdmVyTWF4IDogMzA7XG4gICAgdGhpcy5icmllZldhaXQgPSB0eXBlb2YgbGltaXRzLmJyaWVmV2FpdCA9PT0gXCJudW1iZXJcIiA/IGxpbWl0cy5icmllZldhaXQgOiAzO1xuICAgIHRoaXMuYWN0aXZlQnJpZWYgPSBudWxsO1xuICAgIHRoaXMucmVhZHlCcmllZnMgPSBbXTtcbiAgICB0aGlzLnJlcXVlc3RlZEJyaWVmcy5jbGVhcigpO1xuICAgIHRoaXMubGFzdEN1dCA9IG51bGw7XG4gICAgdGhpcy5sYXN0U3RvcHBlZEJyaWVmQXQgPSBudWxsO1xuICAgIHRoaXMucmVwbGF5Rmxvb3JTZXEgPSBmbG9vclNlcTtcbiAgICB0aGlzLmRlZmVycmVkID0gW107XG4gIH1cblxuICBnZXQgaGFzRGVmZXJyZWQoKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMuZGVmZXJyZWQubGVuZ3RoID4gMDtcbiAgfVxuXG4gIGlzU3VwcHJlc3NlZCh0OiBudW1iZXIpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy53aGlsZVNwZWFraW5nICE9PSBcInNlbmRcIiAmJiB0IDwgdGhpcy5zcGVlY2hVbnRpbDtcbiAgfVxuXG4gIG9uQnJpZWZSZXF1ZXN0KGlkOiBzdHJpbmcsIGV2ZW50VGltZTogbnVtYmVyKTogdm9pZCB7XG4gICAgaWYgKGlkKSB0aGlzLnJlcXVlc3RlZEJyaWVmcy5zZXQoaWQsIGV2ZW50VGltZSk7XG4gIH1cblxuICBvblBsYXkocGNtQmFzZTY0OiBzdHJpbmcsIGV2ZW50VGltZTogbnVtYmVyLCBzb3VyY2U/OiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBwYWQgPSBwY21CYXNlNjQuZW5kc1dpdGgoXCI9PVwiKSA/IDIgOiBwY21CYXNlNjQuZW5kc1dpdGgoXCI9XCIpID8gMSA6IDA7XG4gICAgY29uc3QgcGNtQnl0ZXMgPSBNYXRoLm1heCgwLCBNYXRoLmZsb29yKChwY21CYXNlNjQubGVuZ3RoICogMykgLyA0KSAtIHBhZCk7XG4gICAgdGhpcy5zcGVlY2hVbnRpbCA9IE1hdGgubWF4KHRoaXMuc3BlZWNoVW50aWwsIGV2ZW50VGltZSkgKyBwY21CeXRlcyAvIDQ4XzAwMDtcbiAgICBpZiAoc291cmNlID09PSBcImFubm91bmNlclwiKSB7XG4gICAgICBjb25zdCBicmllZkF0ID0gdGhpcy5yZWFkeUJyaWVmcy5zaGlmdCgpID8/IGV2ZW50VGltZTtcbiAgICAgIHRoaXMuYWN0aXZlQnJpZWYgPSB7IGZyb206IGV2ZW50VGltZSwgdW50aWw6IHRoaXMuc3BlZWNoVW50aWwsIGJyaWVmQXQgfTtcbiAgICAgIHRoaXMubGFzdFN0b3BwZWRCcmllZkF0ID0gbnVsbDtcbiAgICB9XG4gIH1cblxuICBvbkZsdXNoKGV2ZW50VGltZTogbnVtYmVyLCBodXNoZWQgPSBmYWxzZSk6IHZvaWQge1xuICAgIHRoaXMuc3BlZWNoVW50aWwgPSBNYXRoLm1pbih0aGlzLnNwZWVjaFVudGlsLCBldmVudFRpbWUpO1xuICAgIGlmICh0aGlzLmFjdGl2ZUJyaWVmICYmIGV2ZW50VGltZSA+PSB0aGlzLmFjdGl2ZUJyaWVmLnVudGlsKSB7XG4gICAgICB0aGlzLmFjdGl2ZUJyaWVmID0gbnVsbDtcbiAgICB9XG4gICAgaWYgKHRoaXMuYWN0aXZlQnJpZWYpIHtcbiAgICAgIGNvbnN0IGEgPSB0aGlzLmFjdGl2ZUJyaWVmO1xuICAgICAgdGhpcy5hY3RpdmVCcmllZiA9IG51bGw7XG4gICAgICAvLyBNYXRjaCBjYWxsLnRzIGN1dEFubm91bmNlbWVudCgpIGFuZCBodXNoUmVwbHkoKTogYSBicmllZiBodXNoZWQsID49IDgwJSBwbGF5ZWQsXG4gICAgICAvLyBvciBwYXN0IGRlbGl2ZXJNYXggaXMgbm90IHJlLXF1ZXVlZC5cbiAgICAgIGNvbnN0IHBsYXllZCA9IChldmVudFRpbWUgLSBhLmZyb20pIC8gTWF0aC5tYXgoMC4xLCBhLnVudGlsIC0gYS5mcm9tKTtcbiAgICAgIGlmIChodXNoZWQpIHtcbiAgICAgICAgdGhpcy5sYXN0U3RvcHBlZEJyaWVmQXQgPSBhLmJyaWVmQXQ7XG4gICAgICAgIHRoaXMubGFzdEN1dCA9IG51bGw7XG4gICAgICB9IGVsc2UgaWYgKHBsYXllZCA8IDAuOCAmJiBldmVudFRpbWUgLSBhLmJyaWVmQXQgPCB0aGlzLmRlbGl2ZXJNYXgpIHtcbiAgICAgICAgdGhpcy5yZWFkeUJyaWVmcy5wdXNoKGEuYnJpZWZBdCk7XG4gICAgICAgIHRoaXMubGFzdEN1dCA9IHsgYXQ6IGV2ZW50VGltZSwgYnJpZWZBdDogYS5icmllZkF0IH07XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIC8vIFNheWluZyBcInN0b3BcIiBvdmVyIGEgYnJpZWYgY3V0cyBpdCBvbiBBQ1RJVklUWV9TVEFSVCBhbmQgdGhlbiBodXNoZXMgbGFzdEN1dCB3aXRoaW4gNiBzLlxuICAgIGlmIChodXNoZWQgJiYgdGhpcy5sYXN0Q3V0ICYmIGV2ZW50VGltZSAtIHRoaXMubGFzdEN1dC5hdCA8IDYpIHtcbiAgICAgIGNvbnN0IGlkeCA9IHRoaXMucmVhZHlCcmllZnMubGFzdEluZGV4T2YodGhpcy5sYXN0Q3V0LmJyaWVmQXQpO1xuICAgICAgaWYgKGlkeCA+PSAwKSB7XG4gICAgICAgIHRoaXMucmVhZHlCcmllZnMuc3BsaWNlKGlkeCwgMSk7XG4gICAgICAgIHRoaXMubGFzdFN0b3BwZWRCcmllZkF0ID0gdGhpcy5sYXN0Q3V0LmJyaWVmQXQ7XG4gICAgICB9XG4gICAgICB0aGlzLmxhc3RDdXQgPSBudWxsO1xuICAgIH0gZWxzZSBpZiAoaHVzaGVkKSB7XG4gICAgICB0aGlzLmxhc3RDdXQgPSBudWxsO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBNaXJyb3JzIGNvcmUgY29tbWFuZCBzaWRlIGVmZmVjdHMgZm9yIHBsYXliYWNrLCBmbHVzaGVzLCBicmllZnMsIGFuZCB2b2ljZSBzdG9wIGNvbW1hbmRzLiAqL1xuICBvYnNlcnZlQ29tbWFuZHMoXG4gICAgY29tbWFuZHM6IHJlYWRvbmx5IHsgdHlwZTogc3RyaW5nOyBwY20/OiB1bmtub3duOyBzb3VyY2U/OiB1bmtub3duOyBpZD86IHVua25vd247IGNvbW1hbmQ/OiB1bmtub3duOyBtZXNzYWdlPzogdW5rbm93biB9W10sXG4gICAgZXZlbnRUaW1lOiBudW1iZXIsXG4gICAgZXZlbnRUeXBlPzogc3RyaW5nLFxuICApOiB2b2lkIHtcbiAgICBjb25zdCBodXNoZWQgPVxuICAgICAgZXZlbnRUeXBlID09PSBcImludGVycnVwdFwiIHx8XG4gICAgICBldmVudFR5cGUgPT09IFwic3RvcFwiIHx8XG4gICAgICBjb21tYW5kcy5zb21lKChjKSA9PiBjLnR5cGUgPT09IFwidm9pY2VDb21tYW5kXCIgJiYgKGMuY29tbWFuZCA9PT0gXCJzdG9wXCIgfHwgYy5jb21tYW5kID09PSBcImNhbmNlbEFsbFwiKSk7XG4gICAgZm9yIChjb25zdCBjIG9mIGNvbW1hbmRzKSB7XG4gICAgICBpZiAoYy50eXBlID09PSBcInBsYXlcIiAmJiB0eXBlb2YgYy5wY20gPT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgdGhpcy5vblBsYXkoYy5wY20sIGV2ZW50VGltZSwgdHlwZW9mIGMuc291cmNlID09PSBcInN0cmluZ1wiID8gYy5zb3VyY2UgOiB1bmRlZmluZWQpO1xuICAgICAgfSBlbHNlIGlmIChjLnR5cGUgPT09IFwiZmx1c2hcIikge1xuICAgICAgICB0aGlzLm9uRmx1c2goZXZlbnRUaW1lLCBodXNoZWQpO1xuICAgICAgfSBlbHNlIGlmIChjLnR5cGUgPT09IFwiYnJpZWZcIiAmJiB0eXBlb2YgYy5pZCA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICB0aGlzLm9uQnJpZWZSZXF1ZXN0KGMuaWQsIGV2ZW50VGltZSk7XG4gICAgICB9IGVsc2UgaWYgKFxuICAgICAgICBjLnR5cGUgPT09IFwibG9nXCIgJiZcbiAgICAgICAgdHlwZW9mIGMubWVzc2FnZSA9PT0gXCJzdHJpbmdcIiAmJlxuICAgICAgICBjLm1lc3NhZ2Uuc3RhcnRzV2l0aChcIm5vdCBhIHN0b3AgYWZ0ZXIgYWxsXCIpICYmXG4gICAgICAgIHRoaXMubGFzdFN0b3BwZWRCcmllZkF0ICE9IG51bGxcbiAgICAgICkge1xuICAgICAgICB0aGlzLnJlYWR5QnJpZWZzLnB1c2godGhpcy5sYXN0U3RvcHBlZEJyaWVmQXQpO1xuICAgICAgICB0aGlzLmxhc3RTdG9wcGVkQnJpZWZBdCA9IG51bGw7XG4gICAgICB9XG4gICAgfVxuICAgIC8vIGNhbGwudHMgb25seSBleHBpcmVzIHBlbmRpbmcgYnJpZWYgcmVxdWVzdHMgaW5zaWRlIGFubm91bmNlKCkgb24gdGljayBvciBicmllZi5yZWFkeS5cbiAgICBpZiAoZXZlbnRUeXBlID09PSBcInRpY2tcIiB8fCBldmVudFR5cGUgPT09IFwiYnJpZWYucmVhZHlcIikge1xuICAgICAgZm9yIChjb25zdCBbaWQsIGFza2VkQXRdIG9mIHRoaXMucmVxdWVzdGVkQnJpZWZzKSB7XG4gICAgICAgIGlmIChldmVudFRpbWUgLSBhc2tlZEF0ID49IHRoaXMuYnJpZWZXYWl0KSB0aGlzLnJlcXVlc3RlZEJyaWVmcy5kZWxldGUoaWQpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBDYWxsZWQgaW1tZWRpYXRlbHkgYmVmb3JlIHB1c2hpbmcgYW4gZXZlbnQgdG8gdGhlIGNvcmUuIFJldHVybnMgYW55IGRlZmVycmVkIHVuc3VwcHJlc3NlZFxuICAgKiBnYXAgZnJhbWVzIHRoYXQgbXVzdCByZWFjaCB0aGUgY29yZSBmaXJzdCBzbyBuZXcgcGxheWJhY2sgY2Fubm90IHNpbGVuY2UgdGhlbS5cbiAgICovXG4gIGJlZm9yZVB1c2goXG4gICAgZXZlbnQ6IHsgdHlwZT86IHVua25vd247IGlkPzogdW5rbm93bjsgcGNtPzogdW5rbm93bjsgdGV4dD86IHVua25vd247IGRhdGE/OiB1bmtub3duIH0sXG4gICAgZXZlbnRUaW1lID0gMCxcbiAgKTogeyBwY206IHN0cmluZzsgdDogbnVtYmVyIH1bXSB7XG4gICAgbGV0IGFjY2VwdGVkQnJpZWYgPSBmYWxzZTtcbiAgICBpZiAoZXZlbnQudHlwZSA9PT0gXCJicmllZi5mYWlsZWRcIiAmJiB0eXBlb2YgZXZlbnQuaWQgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgIHRoaXMucmVxdWVzdGVkQnJpZWZzLmRlbGV0ZShldmVudC5pZCk7XG4gICAgfSBlbHNlIGlmIChldmVudC50eXBlID09PSBcImJyaWVmLnJlYWR5XCIgJiYgdHlwZW9mIGV2ZW50LmlkID09PSBcInN0cmluZ1wiKSB7XG4gICAgICBpZiAodGhpcy5yZXF1ZXN0ZWRCcmllZnMuZGVsZXRlKGV2ZW50LmlkKSkge1xuICAgICAgICBjb25zdCB2YWxpZCA9XG4gICAgICAgICAgdmFsaWRCcmllZlBjbUJ5dGVzKGV2ZW50LnBjbSkgPiAwICYmXG4gICAgICAgICAgdHlwZW9mIGV2ZW50LnRleHQgPT09IFwic3RyaW5nXCIgJiZcbiAgICAgICAgICBldmVudC50ZXh0LnRyaW0oKS5sZW5ndGggPiAwO1xuICAgICAgICBpZiAodmFsaWQpIHtcbiAgICAgICAgICB0aGlzLnJlYWR5QnJpZWZzLnB1c2goZXZlbnRUaW1lKTtcbiAgICAgICAgICBhY2NlcHRlZEJyaWVmID0gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgICBpZiAodGhpcy5kZWZlcnJlZC5sZW5ndGggPT09IDApIHJldHVybiBbXTtcbiAgICBjb25zdCBjYW5TdGFydFBsYXliYWNrID1cbiAgICAgIGFjY2VwdGVkQnJpZWYgfHxcbiAgICAgICh0aGlzLnJlYWR5QnJpZWZzLmxlbmd0aCA+IDAgJiYgZXZlbnQudHlwZSA9PT0gXCJ0aWNrXCIpIHx8XG4gICAgICAoZXZlbnQudHlwZSA9PT0gXCJ3cy5tZXNzYWdlXCIgJiYgU3RyaW5nKGV2ZW50LmRhdGEgPz8gXCJcIikuaW5jbHVkZXMoJ1wiaW5saW5lRGF0YVwiJykpO1xuICAgIHJldHVybiBjYW5TdGFydFBsYXliYWNrID8gdGhpcy5mbHVzaERlZmVycmVkKCkgOiBbXTtcbiAgfVxuXG4gIGZsdXNoRGVmZXJyZWQoKTogeyBwY206IHN0cmluZzsgdDogbnVtYmVyIH1bXSB7XG4gICAgaWYgKHRoaXMuZGVmZXJyZWQubGVuZ3RoID09PSAwKSByZXR1cm4gW107XG4gICAgY29uc3QgaXRlbXMgPSB0aGlzLmRlZmVycmVkLnNwbGljZSgwKTtcbiAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgaXRlbXMpIHtcbiAgICAgIGlmIChpdGVtLmZsb29yU2VxID4gdGhpcy5yZXBsYXlGbG9vclNlcSkgdGhpcy5yZXBsYXlGbG9vclNlcSA9IGl0ZW0uZmxvb3JTZXE7XG4gICAgfVxuICAgIHJldHVybiBpdGVtcy5tYXAoKHsgcGNtLCB0IH0pID0+ICh7IHBjbSwgdCB9KSk7XG4gIH1cblxuICAvKiogRGV0YWNoZXMgZGVmZXJyZWQgZnJhbWVzIGJlZm9yZSBgcHVzaCh7IHR5cGU6IFwid2FrZVwiIH0pYCB3aXRob3V0IGJ1bXBpbmcgYHJlcGxheUZsb29yU2VxYCB5ZXQuICovXG4gIHRha2VEZWZlcnJlZCgpOiBEZWZlcnJlZE1pY0ZyYW1lW10ge1xuICAgIHJldHVybiB0aGlzLmRlZmVycmVkLnNwbGljZSgwKTtcbiAgfVxuXG4gIG9uTWljRnJhbWUocGFyYW1zOiB7XG4gICAgcGNtOiBzdHJpbmc7XG4gICAgdDogbnVtYmVyO1xuICAgIHNlcTogbnVtYmVyO1xuICAgIGxhc3RTZXE6IG51bWJlcjtcbiAgICBpbkZsaWdodFN1cHByZXNzZWRTZXE6IG51bWJlcjtcbiAgICBzdXBwcmVzc2VkOiBib29sZWFuO1xuICB9KTogeyBwY206IHN0cmluZzsgdDogbnVtYmVyIH1bXSB7XG4gICAgY29uc3QgZmxvb3JTZXEgPSBwYXJhbXMuc2VxID4gMCA/IHBhcmFtcy5zZXEgOiBwYXJhbXMubGFzdFNlcTtcbiAgICBpZiAoIXBhcmFtcy5zdXBwcmVzc2VkICYmIHRoaXMud2hpbGVTcGVha2luZyAhPT0gXCJzZW5kXCIgJiYgcGFyYW1zLmluRmxpZ2h0U3VwcHJlc3NlZFNlcSA+IHRoaXMucmVwbGF5Rmxvb3JTZXEpIHtcbiAgICAgIHRoaXMuZGVmZXJyZWQucHVzaCh7IHNlcTogcGFyYW1zLnNlcSwgZmxvb3JTZXEsIHBjbTogcGFyYW1zLnBjbSwgdDogcGFyYW1zLnQgfSk7XG4gICAgICBpZiAodGhpcy5kZWZlcnJlZC5sZW5ndGggPiB0aGlzLm1heERlZmVycmVkKSByZXR1cm4gdGhpcy5mbHVzaERlZmVycmVkKCk7XG4gICAgICByZXR1cm4gW107XG4gICAgfVxuICAgIGNvbnN0IG91dCA9IHRoaXMuZmx1c2hEZWZlcnJlZCgpO1xuICAgIGlmICghcGFyYW1zLnN1cHByZXNzZWQgJiYgZmxvb3JTZXEgPiB0aGlzLnJlcGxheUZsb29yU2VxKSB7XG4gICAgICB0aGlzLnJlcGxheUZsb29yU2VxID0gZmxvb3JTZXE7XG4gICAgfVxuICAgIG91dC5wdXNoKHsgcGNtOiBwYXJhbXMucGNtLCB0OiBwYXJhbXMudCB9KTtcbiAgICByZXR1cm4gb3V0O1xuICB9XG5cbiAgLyoqXG4gICAqIENvbXB1dGVzIHRoZSBvcmRlcmVkIG1pYyBmcmFtZXMgdG8gcmVwbGF5IGFmdGVyIGBwdXNoKHsgdHlwZTogXCJ3YWtlXCIgfSlgLCBza2lwcGluZyBhbnkgY2h1bmtcbiAgICogYXQgb3IgYmVsb3cgYHJlcGxheUZsb29yU2VxYCBzbyBhbHJlYWR5LWZvcndhcmRlZCBnYXAgZnJhbWVzIGFyZSBuZXZlciBmb2xsb3dlZCBieSBvbGRlciBhdWRpby5cbiAgICovXG4gIHBsYW5XYWtlUmVwbGF5KFxuICAgIGhpdDogV2FrZURldGVjdGlvbkV2ZW50LFxuICAgIGRlZmVycmVkOiBEZWZlcnJlZE1pY0ZyYW1lW10sXG4gICAgYnl0ZXNUb0Jhc2U2NDogKGJ5dGVzOiBVaW50OEFycmF5KSA9PiBzdHJpbmcsXG4gICk6IHsgcGNtOiBzdHJpbmc7IHQ/OiBudW1iZXIgfVtdIHtcbiAgICBjb25zdCBkZWZlcnJlZFNlcXMgPSBuZXcgU2V0KGRlZmVycmVkLm1hcCgoZCkgPT4gZC5zZXEpLmZpbHRlcigocykgPT4gcyA+IDApKTtcbiAgICBjb25zdCBvdXQ6IHsgcGNtOiBzdHJpbmc7IHQ/OiBudW1iZXIgfVtdID0gW107XG4gICAgY29uc3QgcmVwbGF5ZWRTZXFzID0gbmV3IFNldDxudW1iZXI+KCk7XG4gICAgbGV0IG1heEZsb29yID0gdGhpcy5yZXBsYXlGbG9vclNlcTtcbiAgICBmb3IgKGNvbnN0IGNodW5rIG9mIGhpdC50cmFpbGluZykge1xuICAgICAgaWYgKGNodW5rLmJ5dGVzLmJ5dGVMZW5ndGggPT09IDApIGNvbnRpbnVlO1xuICAgICAgaWYgKGNodW5rLnNlcSA8PSB0aGlzLnJlcGxheUZsb29yU2VxKSBjb250aW51ZTtcbiAgICAgIGlmICghY2h1bmsuc3VwcHJlc3NlZCAmJiAhZGVmZXJyZWRTZXFzLmhhcyhjaHVuay5zZXEpKSBjb250aW51ZTtcbiAgICAgIGlmIChjaHVuay5zZXEgPiAwKSB7XG4gICAgICAgIHJlcGxheWVkU2Vxcy5hZGQoY2h1bmsuc2VxKTtcbiAgICAgICAgaWYgKGNodW5rLnNlcSA+IG1heEZsb29yKSBtYXhGbG9vciA9IGNodW5rLnNlcTtcbiAgICAgIH1cbiAgICAgIG91dC5wdXNoKHsgcGNtOiBieXRlc1RvQmFzZTY0KGNodW5rLmJ5dGVzKSB9KTtcbiAgICB9XG4gICAgZm9yIChjb25zdCBpdGVtIG9mIGRlZmVycmVkKSB7XG4gICAgICBpZiAoaXRlbS5mbG9vclNlcSA+IG1heEZsb29yKSBtYXhGbG9vciA9IGl0ZW0uZmxvb3JTZXE7XG4gICAgICBpZiAoaXRlbS5zZXEgPiAwICYmIHJlcGxheWVkU2Vxcy5oYXMoaXRlbS5zZXEpKSBjb250aW51ZTtcbiAgICAgIG91dC5wdXNoKHsgcGNtOiBpdGVtLnBjbSwgdDogaXRlbS50IH0pO1xuICAgIH1cbiAgICB0aGlzLnJlcGxheUZsb29yU2VxID0gbWF4Rmxvb3I7XG4gICAgcmV0dXJuIG91dDtcbiAgfVxufVxuIiwgIi8vIFRoZSB3ZWIgc3VyZmFjZTogYSBmb3VydGggaG9zdCBmb3IgdGhlIHZvaWNlIGNvcmUsIGFuZCBhIHBob25lLWZyaWVuZGx5IHdheSB0byB1c2UgaXQgZm9yIHdvcmsuXG4vLyBJdCBsb2FkcyB0aGUgZGV2IHNlcnZlcidzIGxhdGVzdCBidWlsZCBhdCBlYWNoIGNhbGwsIHNvIGFuIGVkaXQgaW4gc3JjLyBpcyBsaXZlIG9uIHRoZSBuZXh0XG4vLyBjYWxsLCBhbmQga2VlcHMgZXZlcnkgY2FsbCBhcyBhIHRyYWNlIHRoZSByZXBsYXkgdmlldyAoYW5kIGFueSBvdGhlciBob3N0KSBjYW4gcnVuIGFnYWluLlxuLy9cbi8vIFRoZSBob3N0J3MgcGFydCBpcyBzbWFsbDogdGhlIG1pY3JvcGhvbmUgYW5kIHNwZWFrZXIgKGF1ZGlvLnRzKSwgdGhlIG1vZGVsJ3Mgc29ja2V0IHRocm91Z2ggdGhlXG4vLyBzZXJ2ZXIncyByZWxheSwgSGVybWVzIGFuZCBUMyB0aHJvdWdoIHRoZSBzZXJ2ZXIsIGFuZCB0aGUgc2NyZWVuLiBUaGUgY29yZSBkZWNpZGVzIHRoZSByZXN0LlxuLy9cbi8vIFR5cGluZyB3aXRoIG5vIGNhbGwgb24gc3RhcnRzIGEgY2hhdCBpbnN0ZWFkOiB0aGUgc2FtZSBjb3JlIHdpdGggYG1lZGl1bTogXCJ0ZXh0XCJgLCB3aG9zZSByZXF1ZXN0c1xuLy8gdG8gdGhlIHRleHQgbW9kZWwgZ28gdGhyb3VnaCB0aGUgc2VydmVyJ3MgL2dlbmVyYXRlLiBUYXNrcywgZm9sbG93LXVwcyBhbmQgdGhlaXIgY2FyZHMgd29yayBhc1xuLy8gaW4gYSBjYWxsLiBQcmVzc2luZyBDYWxsIGVuZHMgdGhlIGNoYXQgYW5kIGNhcnJpZXMgaXRzIGNvbnZlcnNhdGlvbiBvbiBieSB2b2ljZS5cblxuaW1wb3J0IHsgY29tbWFuZEluIH0gZnJvbSBcIi4uL3NyYy9jb21tYW5kcy50c1wiO1xuaW1wb3J0IHsgQ2FsbEF1ZGlvLCBieXRlc1RvQmFzZTY0IH0gZnJvbSBcIi4vYXVkaW8udHNcIjtcbmltcG9ydCB7IFJlcGxheSB9IGZyb20gXCIuL3JlcGxheS50c1wiO1xuaW1wb3J0IHsgQXV0b1Njcm9sbGVyIH0gZnJvbSBcIi4vc2Nyb2xsLnRzXCI7XG5pbXBvcnQge1xuICBjYW5Gb2xsb3dVcFJlc3VsdCxcbiAgZm9ybWF0U2hvcnRUaW1lLFxuICBub3JtYWxpemVEZW5zaXR5LFxuICBub3JtYWxpemVTaWRlRmlsdGVyLFxuICBwYXJzZVByZWZpeCxcbiAgcGxhaW5QcmV2aWV3LFxuICByZXNvbHZlTW9iaWxlQmFubmVyRmlsdGVyLFxuICByZXNvbHZlU2lkZVNlY3Rpb25zLFxuICBzaG91bGRDbGVhclVucmVhZFJlc3VsdHMsXG4gIHR5cGUgU2lkZUZpbHRlcixcbn0gZnJvbSBcIi4vdWkudHNcIjtcbmltcG9ydCB7IFNjcmVlbldha2VMb2NrLCBXYWtlQXVkaW9HYXRlLCBXYWtlQ2xpZW50LCB0eXBlIFdha2VEZXRlY3Rpb25FdmVudCwgdHlwZSBXYWtlVGVsZW1ldHJ5IH0gZnJvbSBcIi4vd2FrZUNsaWVudC50c1wiO1xuXG5pbnRlcmZhY2UgQ29yZSB7XG4gIHZlcnNpb246IHN0cmluZztcbiAgZGVmYXVsdHMoKTogc3RyaW5nO1xuICBjcmVhdGUoY29uZmlnOiBzdHJpbmcsIHQ6IG51bWJlcik6IHN0cmluZztcbiAgcHVzaChpZDogbnVtYmVyLCBldmVudDogc3RyaW5nKTogc3RyaW5nO1xuICB0cmFjZShpZDogbnVtYmVyKTogc3RyaW5nO1xuICBkaXNwb3NlKGlkOiBudW1iZXIpOiB2b2lkO1xufVxudHlwZSBDb21tYW5kID0gUmVjb3JkPHN0cmluZywgYW55PiAmIHsgdHlwZTogc3RyaW5nIH07XG5pbnRlcmZhY2UgV2FrZU1vZGVsSW5mbyB7IGlkOiBzdHJpbmc7IGxhYmVsOiBzdHJpbmcgfVxuaW50ZXJmYWNlIFNlcnZlckNvbmZpZyB7IHJvdXRlOiBzdHJpbmc7IG1vZGVsOiBzdHJpbmc7IGNhcHRpb25zTW9kZWw/OiBzdHJpbmc7IHRleHRNb2RlbD86IHN0cmluZzsgdmVyc2lvbjogc3RyaW5nOyBoZXJtZXM6IGJvb2xlYW47IHQzOiBzdHJpbmdbXSB8IG51bGw7IHdha2VNb2RlbHM/OiBXYWtlTW9kZWxJbmZvW10gfVxuXG5jb25zdCAkID0gPFQgZXh0ZW5kcyBIVE1MRWxlbWVudCA9IEhUTUxFbGVtZW50PihpZDogc3RyaW5nKSA9PiBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChpZCkgYXMgVDtcbmNvbnN0IG5vdyA9ICgpID0+IHBlcmZvcm1hbmNlLm5vdygpIC8gMTAwMDtcbmNvbnN0IGNoZWNrZWQgPSAoaWQ6IHN0cmluZykgPT4gJDxIVE1MSW5wdXRFbGVtZW50PihpZCkuY2hlY2tlZDtcblxuLyoqIFRoZSBsYXRlc3QgYnVpbGQgZnJvbSB0aGUgZGV2IHNlcnZlciwgZXZhbHVhdGVkIGFmcmVzaDogYW4gZWRpdCBpbiBzcmMvIGlzIGluIHRoZSBuZXh0IGNhbGwuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbG9hZENvcmUodXJsID0gXCIvdm9pY2UtY29yZS5qc1wiKTogUHJvbWlzZTxDb3JlPiB7XG4gIGNvbnN0IHNvdXJjZSA9IGF3YWl0IChhd2FpdCBmZXRjaCh1cmwsIHsgY2FjaGU6IFwibm8tc3RvcmVcIiB9KSkudGV4dCgpO1xuICBjb25zdCBzY29wZTogeyBWb2ljZUNvcmU/OiBDb3JlIH0gPSB7fTtcbiAgbmV3IEZ1bmN0aW9uKFwiZ2xvYmFsVGhpc1wiLCBzb3VyY2UpKHNjb3BlKTtcbiAgaWYgKCFzY29wZS5Wb2ljZUNvcmUpIHRocm93IG5ldyBFcnJvcihcInRoZSBidW5kbGUgZGlkbid0IGRlZmluZSBWb2ljZUNvcmVcIik7XG4gIHJldHVybiBzY29wZS5Wb2ljZUNvcmU7XG59XG5cbi8vIFByZXNldHM6IGVhY2ggc3VyZmFjZSdzIHNldHRpbmdzIGFzIGl0cyBhcHAgd291bGQgc2V0IHRoZW0uXG5cbmNvbnN0IEZBS0VfVFYgPSBbXG4gIHsgbmFtZTogXCJ0dl92b2x1bWVcIiwgZGVzY3JpcHRpb246IFwiU2V0cyB0aGUgbGl2aW5nLXJvb20gVFYncyB2b2x1bWUsIDAgdG8gMTAwLlwiLCBwYXJhbWV0ZXJzOiB7IHR5cGU6IFwiT0JKRUNUXCIsIHByb3BlcnRpZXM6IHsgbGV2ZWw6IHsgdHlwZTogXCJJTlRFR0VSXCIgfSB9LCByZXF1aXJlZDogW1wibGV2ZWxcIl0gfSB9LFxuICB7IG5hbWU6IFwidHZfcGF1c2VcIiwgZGVzY3JpcHRpb246IFwiUGF1c2VzIG9yIHJlc3VtZXMgd2hhdCdzIHBsYXlpbmcgb24gdGhlIFRWLlwiLCBwYXJhbWV0ZXJzOiB7IHR5cGU6IFwiT0JKRUNUXCIsIHByb3BlcnRpZXM6IHsgcGF1c2U6IHsgdHlwZTogXCJCT09MRUFOXCIgfSB9IH0gfSxcbl07XG5cbmNvbnN0IFBSRVNFVFM6IFJlY29yZDxzdHJpbmcsIFJlY29yZDxzdHJpbmcsIHVua25vd24+PiA9IHtcbiAgd2ViOiB7IHBsYXRmb3JtOiBcIndlYlwiLCBkZXZpY2U6IFwiYnJvd3NlclwiLCBzdGFuZGJ5QWZ0ZXI6IDMwLCBoYW5kT2ZmOiBcIm5hbWVkXCIsIHN1cGVydmlzZTogdHJ1ZSwgdm9jYWJ1bGFyeTogW1wiSGVybWVzXCIsIFwiQmVudG9cIiwgXCJXb29kaG91c2VcIiwgXCJQZW5ueXdvcnRoXCIsIFwiVDNcIl0gfSxcbiAgXCJ3ZWIgd2FrZSB3b3JkXCI6IHtcbiAgICBwbGF0Zm9ybTogXCJ3ZWJcIiwgZGV2aWNlOiBcImJyb3dzZXJcIiwgc3RhbmRieUFmdGVyOiAyMCwgaGFuZ1VwQWZ0ZXI6IDEyMCwgaGFuZE9mZjogXCJuYW1lZFwiLCBzdXBlcnZpc2U6IHRydWUsXG4gICAgYXR0ZW50aW9uOiB7IG1vZGU6IFwid2luZG93XCIsIGFmdGVyV2FrZTogOCwgd2luZG93OiA1LCBhZnRlclF1ZXN0aW9uOiAxMCwgYWZ0ZXJIYW5kT2ZmOiAzLCBhZnRlckFubm91bmNlbWVudDogMCB9LFxuICAgIHZvY2FidWxhcnk6IFtcIkhlcm1lc1wiLCBcIkJlbnRvXCIsIFwiV29vZGhvdXNlXCIsIFwiUGVubnl3b3J0aFwiLCBcIlQzXCJdLFxuICB9LFxuICBhbmRyb2lkOiB7IHBsYXRmb3JtOiBcIkFuZHJvaWRcIiwgZGV2aWNlOiBcInBob25lXCIsIHN0YW5kYnlBZnRlcjogMjAgfSxcbiAgXCJhbmRyb2lkIHdha2Ugd29yZFwiOiB7IHBsYXRmb3JtOiBcIkFuZHJvaWRcIiwgZGV2aWNlOiBcInBob25lXCIsIHN0YW5kYnlBZnRlcjogMjAsIGhhbmdVcEFmdGVyOiAxNSB9LFxuICBtYWNvczogeyBwbGF0Zm9ybTogXCJtYWNPU1wiLCBkZXZpY2U6IFwiTWFjXCIsIHN0YW5kYnlBZnRlcjogMjAgfSxcbiAgZWNobzoge1xuICAgIHBsYXRmb3JtOiBcIkVjaG9cIiwgZGV2aWNlOiBcInNwZWFrZXJcIiwgaGFuZ1VwQWZ0ZXI6IDYsIHN0YW5kYnlBZnRlcjogOCwgZWFyY29uczogdHJ1ZSwgdm9jYWJ1bGFyeTogW1wiSGVybWVzXCIsIFwiQmVudG9cIiwgXCJXb29kaG91c2VcIl0sXG4gICAgbWljOiB7IHdoaWxlU3BlYWtpbmc6IFwid2FrZVwiLCBnYWluRGI6IDAgfSwgaG9zdFRvb2xzOiBGQUtFX1RWLFxuICB9LFxufTtcblxuLy8gU3RhdGUuXG5cbmNvbnN0IGF1ZGlvID0gbmV3IENhbGxBdWRpbygpO1xubGV0IHNlcnZlcjogU2VydmVyQ29uZmlnO1xubGV0IGNvcmU6IENvcmUgfCBudWxsID0gbnVsbDtcbmxldCBjYWxsSWQgPSAwO1xuLyoqIE1vbm90b25pYyBwZXItcGFnZSBzZXNzaW9uIGlkICh1bmxpa2UgY29yZSdzIGNhbGxJZC90YXNrSWQsIHdoaWNoIHJlc3RhcnQgYWZ0ZXIgbG9hZENvcmUoKSkuICovXG5sZXQgc2Vzc2lvblNlcSA9IDA7XG5sZXQgYWN0aXZlU2Vzc2lvbiA9IDA7XG5sZXQgY2FsbE5hbWUgPSBcIlwiO1xubGV0IHRpY2tlciA9IDA7XG5sZXQgdHJhY2VUaW1lciA9IDA7XG5sZXQgc3RhcnRlZEF0ID0gbm93KCk7XG5jb25zdCBzb2NrZXRzID0gbmV3IE1hcDxudW1iZXIsIFdlYlNvY2tldD4oKTtcbi8qKiBUaGUgc29ja2V0cyB0byB0aGUgdHJhbnNjcmlwdGlvbiBtb2RlbDogdGhlaXIgYXVkaW8gaXMgdGhlIG1vZGVsJ3MgYWdhaW4sIHNvIGl0IGlzbid0IGNvdW50ZWQgb3IgbG9nZ2VkIHR3aWNlLiAqL1xuY29uc3QgY2FwdGlvblNvY2tldHMgPSBuZXcgU2V0PG51bWJlcj4oKTtcbmNvbnN0IHJ1bnMgPSBuZXcgTWFwPHN0cmluZywgeyBhYm9ydDogQWJvcnRDb250cm9sbGVyOyBhZ2VudDogc3RyaW5nOyB0YXNrSWQ6IHN0cmluZyB9PigpO1xuaW50ZXJmYWNlIFRhc2tWaWV3IHsgYzogQ29tbWFuZDsgc2luY2U6IG51bWJlcjsgZW5kZWQ6IG51bWJlciB8IG51bGw7IHRocmVhZD86IHN0cmluZzsgcmVzdWx0SWQ/OiBzdHJpbmc7IGFwcHJvdmFsPzogeyBjb21tYW5kOiBzdHJpbmcgfSB9XG5jb25zdCB0YXNrcyA9IG5ldyBNYXA8c3RyaW5nLCBUYXNrVmlldz4oKTtcbmludGVyZmFjZSBSZXN1bHRFbnRyeSB7XG4gIGlkOiBzdHJpbmc7XG4gIGFnZW50OiBzdHJpbmc7XG4gIGxhYmVsOiBzdHJpbmc7XG4gIHRleHQ6IHN0cmluZztcbiAgZmFpbGVkOiBib29sZWFuO1xuICB0YXNrSWQ/OiBzdHJpbmc7XG4gIHNlc3Npb25JZDogbnVtYmVyO1xuICBjYXJkOiBIVE1MRWxlbWVudDtcbiAgaGVhZDogSFRNTEJ1dHRvbkVsZW1lbnQ7XG4gIGJvZHk6IEhUTUxFbGVtZW50O1xuICBtb3JlQnRuOiBIVE1MQnV0dG9uRWxlbWVudDtcbiAgZm9sbG93QnRuPzogSFRNTEJ1dHRvbkVsZW1lbnQ7XG4gIHJlZlJvdzogSFRNTEJ1dHRvbkVsZW1lbnQ7XG59XG5jb25zdCByZXN1bHRzID0gbmV3IE1hcDxzdHJpbmcsIFJlc3VsdEVudHJ5PigpO1xubGV0IG5leHRSZXN1bHRTZXEgPSAwO1xubGV0IHNpZGVGaWx0ZXI6IFNpZGVGaWx0ZXIgPSBcImFsbFwiO1xubGV0IHVucmVhZE1vYmlsZVJlc3VsdHMgPSAwO1xubGV0IGZsYXNoVGltZXIgPSAwO1xubGV0IGVhcmxpZXJBY3RpdmVDb3VudCA9IDA7XG5sZXQgZWFybGllcldhaXRpbmdDb3VudCA9IDA7XG5sZXQgY291bnRzID0geyBtaWM6IDAsIHBsYXk6IDAsIHNlbnQ6IDAgfTtcbmxldCBmYWtlVHZMZXZlbCA9IDE1O1xubGV0IGNvcmVTdGF0dXMgPSBcImlkbGVcIjtcbmxldCBtdXRlZCA9IGZhbHNlO1xubGV0IGhvbGRpbmcgPSBmYWxzZTtcbmNvbnN0IHNjcmVlbldha2VMb2NrID0gbmV3IFNjcmVlbldha2VMb2NrKCk7XG4vKiogV2FrZSB3b3JkIGxvb3Agc3RhdGU6IGFybWVkIGJldHdlZW4gY2FsbHMsIHJlcXVlc3RlZCBieSBjb3JlIHdoaWxlIGRvcm1hbnQvc3BlYWtpbmcsIG9yIG1pZC1oYW5kb2ZmLiAqL1xubGV0IHdha2VBcm1lZCA9IGZhbHNlO1xubGV0IGFybUdlbiA9IDA7XG5sZXQgY29yZVdhbnRzV2FrZSA9IGZhbHNlO1xuLyoqIFdoaWNoIGNhbGwgKG9yIDAgZm9yIGlkbGUpIG93bnMgdGhlIHdha2Ugd29ya2VyJ3MgY3VycmVudCBsaXN0ZW5pbmcgcGVyaW9kLiAqL1xubGV0IHdha2VQZXJpb2RDYWxsSWQ6IG51bWJlciB8IG51bGwgPSBudWxsO1xuY29uc3Qgd2FrZUdhdGUgPSBuZXcgV2FrZUF1ZGlvR2F0ZSgpO1xubGV0IHdha2VMb2FkaW5nID0gZmFsc2U7XG5sZXQgd2FrZVN0YXJ0aW5nID0gZmFsc2U7XG5sZXQgc3RhcnRpbmdDYWxsID0gZmFsc2U7XG5sZXQgb3BlbmluZ0NodW5rczogVWludDhBcnJheVtdID0gW107XG5sZXQgb3BlbmluZ0J5dGVzID0gMDtcbmNvbnN0IE9QRU5JTkdfTUFYX0JZVEVTID0gMTAgKiAzMl8wMDA7XG5sZXQgd2FrZUxhc3RUZWw6IFdha2VUZWxlbWV0cnkgfCBudWxsID0gbnVsbDtcbi8qKiBXaGF0IHRoZSBzZXNzaW9uIG9uIHNjcmVlbiBpczogYSB2b2ljZSBjYWxsLCBvciBhIHR5cGVkIGNoYXQgKHRoZSBjb3JlJ3MgbWVkaXVtIFwidGV4dFwiKS4gKi9cbmxldCBtZWRpdW06IFwidm9pY2VcIiB8IFwidGV4dFwiID0gXCJ2b2ljZVwiO1xuLyoqIEEgY2hhdCdzIG1vZGVsIGlzIHdyaXRpbmcgaXRzIGFuc3dlci4gKi9cbmxldCB0aGlua2luZyA9IGZhbHNlO1xuLyoqIEEgY2hhdCdzIHJlcXVlc3RzIHRvIHRoZSB0ZXh0IG1vZGVsIHRoYXQgYXJlIHVuZGVyIHdheS4gKi9cbmNvbnN0IHJlcXVlc3RzID0gbmV3IE1hcDxudW1iZXIsIEFib3J0Q29udHJvbGxlcj4oKTtcbi8qKiBUaGUgbGFzdCBzZXNzaW9uIHdpbmRpbmcgZG93biAoaXRzIHRyYWNlIHNhdmVkLCB0aGUgY29yZSdzIGNhbGwgZGlzcG9zZWQpOiB0aGUgbmV4dCBzdGFydHMgYWZ0ZXIgaXQuICovXG5sZXQgZW5kaW5nOiBQcm9taXNlPHZvaWQ+ID0gUHJvbWlzZS5yZXNvbHZlKCk7XG5cbi8vIFRoZSBjb252ZXJzYXRpb24sIGtlcHQgc28gYSBuZXcgY2FsbCBjYW4gY2Fycnkgb24gZnJvbSBpdCAodGhlIGNvcmUncyBgaGlzdG9yeWAsIHJlY2FwcGVkIHRvIHRoZSBtb2RlbCkuXG5pbnRlcmZhY2UgQ2hhdExpbmUgeyByb2xlOiBcInVzZXJcIiB8IFwiYXNzaXN0YW50XCI7IHNwZWFrZXI/OiBzdHJpbmc7IHRleHQ6IHN0cmluZyB9XG5jb25zdCBISVNUT1JZID0gXCJ2b2ljZS5oaXN0b3J5XCI7XG5jb25zdCBISVNUT1JZX01BWF9BR0UgPSAxMiAqIDM2MDAgKiAxMDAwO1xubGV0IGNoYXQ6IENoYXRMaW5lW10gPSBbXTtcbi8qKiBUaGUgY29yZSdzIG51bWJlciBmb3IgdGhlIGxpbmUgdGhlIGxhc3Qgd29yZHMgd2VyZSByZW1lbWJlcmVkIG9uLCB1bnRpbCBzb21ldGhpbmcgZWxzZSBpcy4gKi9cbmxldCBsYXN0TGluZTogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5cbmZ1bmN0aW9uIHJlbWVtYmVyKHJvbGU6IFwidXNlclwiIHwgXCJhc3Npc3RhbnRcIiwgdGV4dDogc3RyaW5nLCBzcGVha2VyPzogc3RyaW5nLCBqb2luID0gZmFsc2UpIHtcbiAgY29uc3QgbGFzdCA9IGNoYXQuYXQoLTEpO1xuICBpZiAoam9pbiAmJiBsYXN0ICYmIGxhc3Qucm9sZSA9PT0gcm9sZSAmJiBsYXN0LnNwZWFrZXIgPT09IHNwZWFrZXIpIGxhc3QudGV4dCArPSB0ZXh0O1xuICBlbHNlIGNoYXQucHVzaChzcGVha2VyID8geyByb2xlLCBzcGVha2VyLCB0ZXh0IH0gOiB7IHJvbGUsIHRleHQgfSk7XG4gIGlmIChjaGF0Lmxlbmd0aCA+IDIwMCkgY2hhdC5zcGxpY2UoMCwgY2hhdC5sZW5ndGggLSAyMDApO1xuICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShISVNUT1JZLCBKU09OLnN0cmluZ2lmeSh7IGF0OiBEYXRlLm5vdygpLCBjaGF0IH0pKTtcbn1cblxuZnVuY3Rpb24gc2F2ZWRIaXN0b3J5KCk6IENoYXRMaW5lW10ge1xuICB0cnkge1xuICAgIGNvbnN0IHNhdmVkID0gSlNPTi5wYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShISVNUT1JZKSA/PyBcIm51bGxcIik7XG4gICAgcmV0dXJuIHNhdmVkICYmIERhdGUubm93KCkgLSBzYXZlZC5hdCA8IEhJU1RPUllfTUFYX0FHRSAmJiBBcnJheS5pc0FycmF5KHNhdmVkLmNoYXQpID8gc2F2ZWQuY2hhdCA6IFtdO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gW107XG4gIH1cbn1cblxuLyoqIFR3by1ub3RlIGNoaW1lLCBQQ00xNiBtb25vIGF0IDI0IGtIeiwgYmFzZTY0LiAqL1xuZnVuY3Rpb24gdHdvTm90ZVRvbmUoZjE6IG51bWJlciwgZjI6IG51bWJlciwgbm90ZVNlYzogbnVtYmVyLCBhbXA6IG51bWJlcik6IHN0cmluZyB7XG4gIGNvbnN0IHJhdGUgPSAyNDAwMCwgbiA9IE1hdGgucm91bmQocmF0ZSAqIG5vdGVTZWMgKiAyKSwgaGFsZiA9IE1hdGgucm91bmQocmF0ZSAqIG5vdGVTZWMpLCBvdXQgPSBuZXcgSW50MTZBcnJheShuKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBuOyBpKyspIHtcbiAgICBjb25zdCBmaXJzdCA9IGkgPCBoYWxmO1xuICAgIGNvbnN0IHQgPSBpIC8gcmF0ZSwgZiA9IGZpcnN0ID8gZjEgOiBmMiwgbG9jYWwgPSBmaXJzdCA/IHQgOiB0IC0gbm90ZVNlYztcbiAgICBjb25zdCBlbnYgPSBNYXRoLm1pbigxLCBsb2NhbCAqIDYwLCAobm90ZVNlYyAtIGxvY2FsKSAqIDYwKTtcbiAgICBvdXRbaV0gPSBNYXRoLnJvdW5kKE1hdGguc2luKDIgKiBNYXRoLlBJICogZiAqIHQpICogTWF0aC5tYXgoMCwgZW52KSAqIGFtcCk7XG4gIH1cbiAgcmV0dXJuIGJ5dGVzVG9CYXNlNjQobmV3IFVpbnQ4QXJyYXkob3V0LmJ1ZmZlcikpO1xufVxuXG4vKiogVHdvIHJpc2luZyBub3Rlczogc29tZXRoaW5nIG9uIHRoZSBzY3JlZW4gbmVlZHMgdGhlIHVzZXIuICovXG5jb25zdCBBUFBST1ZBTF9UT05FID0gdHdvTm90ZVRvbmUoNjYwLCA4ODAsIDAuMTYsIDYwMDApO1xuLyoqIENyaXNwIHJpc2luZyBjaGltZTogdGhlIHdha2Ugd29yZCBmaXJlZCAoc3RhcnQgc2lnbmFsKS4gKi9cbmNvbnN0IFdBS0VfVE9ORSA9IHR3b05vdGVUb25lKDU4Ny4zMywgODgwLCAwLjExLCA1NTAwKTtcbi8qKiBTb2Z0IGZhbGxpbmcgY2hpbWU6IHRoZSBhdHRlbnRpb24gd2luZG93IGNsb3NlZCBhbmQgdGhlIGNhbGwgd2VudCBkb3JtYW50IChlbmQgc2lnbmFsKS4gKi9cbmNvbnN0IFNMRUVQX1RPTkUgPSB0d29Ob3RlVG9uZSg2NTkuMjUsIDQ5My44OCwgMC4xMSwgMzQwMCk7XG5cbi8vIExhdGVuY3k6IHRoZSBuZXR3b3JrJ3Mgcm91bmQgdHJpcCwgYW5kIGhvdyBsb25nIGFmdGVyIHRoZSB1c2VyIHN0b3BzIHRhbGtpbmcgdGhlIHJlcGx5IHN0YXJ0cy5cbmNvbnN0IG1ldHJpY3MgPSB7IHJ0dDogW10gYXMgbnVtYmVyW10sIHJlcGx5OiBbXSBhcyBudW1iZXJbXSwgbGFzdFZvaWNlOiAwLCBsYXN0UGxheTogMCwgcmVwbGllZDogdHJ1ZSB9O1xuXG5mdW5jdGlvbiBtZWRpYW4oeHM6IG51bWJlcltdKTogbnVtYmVyIHwgbnVsbCB7XG4gIGlmICh4cy5sZW5ndGggPT09IDApIHJldHVybiBudWxsO1xuICBjb25zdCBzID0gWy4uLnhzXS5zb3J0KChhLCBiKSA9PiBhIC0gYik7XG4gIHJldHVybiBzW01hdGguZmxvb3Iocy5sZW5ndGggLyAyKV07XG59XG5cbmZ1bmN0aW9uIHNob3dNZXRyaWNzKCkge1xuICBjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgcnR0ID0gbWVkaWFuKG1ldHJpY3MucnR0KTtcbiAgaWYgKHJ0dCAhPSBudWxsKSBwYXJ0cy5wdXNoKGAke01hdGgucm91bmQocnR0ICogMTAwMCl9IG1zYCk7XG4gIGNvbnN0IHJlcGx5ID0gbWVkaWFuKG1ldHJpY3MucmVwbHkpO1xuICBpZiAocmVwbHkgIT0gbnVsbCkgcGFydHMucHVzaChgcmVwbHkgJHttZXRyaWNzLnJlcGx5LmF0KC0xKSEudG9GaXhlZCgxKX1zICgke3JlcGx5LnRvRml4ZWQoMSl9cyBtZWQpYCk7XG4gIGNvbnN0IG91dCA9IGF1ZGlvLm91dHB1dExhdGVuY3k7XG4gIGlmIChvdXQgIT0gbnVsbCkgcGFydHMucHVzaChgYXVkaW8gJHtNYXRoLnJvdW5kKG91dCAqIDEwMDApfSBtc2ApO1xuICBsZXQgYnVmZmVyZWQgPSAwO1xuICBmb3IgKGNvbnN0IHdzIG9mIHNvY2tldHMudmFsdWVzKCkpIGJ1ZmZlcmVkICs9IHdzLmJ1ZmZlcmVkQW1vdW50O1xuICBpZiAoYnVmZmVyZWQgPiAzMl8wMDApIHBhcnRzLnB1c2goYHVwbG9hZCArJHsoYnVmZmVyZWQgLyAzMl8wMDApLnRvRml4ZWQoMSl9c2ApO1xuICAkKFwibWV0cmljc1wiKS50ZXh0Q29udGVudCA9IHBhcnRzLmpvaW4oXCIgXHUwMEI3IFwiKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcGluZygpIHtcbiAgY29uc3QgdCA9IG5vdygpO1xuICB0cnkge1xuICAgIGF3YWl0IGZldGNoKFwiL3BpbmdcIiwgeyBjYWNoZTogXCJuby1zdG9yZVwiIH0pO1xuICAgIG1ldHJpY3MucnR0LnB1c2gobm93KCkgLSB0KTtcbiAgICBpZiAobWV0cmljcy5ydHQubGVuZ3RoID4gMTIpIG1ldHJpY3MucnR0LnNoaWZ0KCk7XG4gIH0gY2F0Y2gge31cbiAgc2hvd01ldHJpY3MoKTtcbn1cblxuLy8gVGhlbWUgJiBkZW5zaXR5LlxuXG5mdW5jdGlvbiBhcHBseVRoZW1lKGNob2ljZTogc3RyaW5nKSB7XG4gIGNvbnN0IHJvb3QgPSBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQ7XG4gIGlmIChjaG9pY2UgPT09IFwiZGFya1wiIHx8IGNob2ljZSA9PT0gXCJsaWdodFwiKSByb290LmRhdGFzZXQudGhlbWUgPSBjaG9pY2U7XG4gIGVsc2UgZGVsZXRlIHJvb3QuZGF0YXNldC50aGVtZTtcbiAgY29uc3QgZGFyayA9IGNob2ljZSA9PT0gXCJkYXJrXCIgfHwgKGNob2ljZSAhPT0gXCJsaWdodFwiICYmIG1hdGNoTWVkaWEoXCIocHJlZmVycy1jb2xvci1zY2hlbWU6IGRhcmspXCIpLm1hdGNoZXMpO1xuICBjb25zdCBtZXRhID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJ0aGVtZS1jb2xvclwiKTtcbiAgaWYgKG1ldGEpIG1ldGEuc2V0QXR0cmlidXRlKFwiY29udGVudFwiLCBkYXJrID8gXCIjMGUwZjBmXCIgOiBcIiNmNmY1ZjBcIik7XG4gIGZvciAoY29uc3QgYnRuIG9mIEFycmF5LmZyb20oZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MQnV0dG9uRWxlbWVudD4oXCIjdGhlbWUtcGlja2VyIGJ1dHRvblwiKSkpIHtcbiAgICBidG4uY2xhc3NMaXN0LnRvZ2dsZShcIm9uXCIsIGJ0bi5kYXRhc2V0LnRoZW1lID09PSAoY2hvaWNlIHx8IFwic3lzdGVtXCIpKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBhcHBseURlbnNpdHkoY2hvaWNlOiBzdHJpbmcgfCBudWxsKSB7XG4gIGNvbnN0IGRlbnNpdHkgPSBub3JtYWxpemVEZW5zaXR5KGNob2ljZSk7XG4gIGNvbnN0IHJvb3QgPSBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQ7XG4gIGlmIChkZW5zaXR5ID09PSBcImNvbWZvcnRhYmxlXCIpIHJvb3QuZGF0YXNldC5kZW5zaXR5ID0gXCJjb21mb3J0YWJsZVwiO1xuICBlbHNlIGRlbGV0ZSByb290LmRhdGFzZXQuZGVuc2l0eTtcbiAgZm9yIChjb25zdCBidG4gb2YgQXJyYXkuZnJvbShkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxCdXR0b25FbGVtZW50PihcIiNkZW5zaXR5LXBpY2tlciBidXR0b25cIikpKSB7XG4gICAgYnRuLmNsYXNzTGlzdC50b2dnbGUoXCJvblwiLCBidG4uZGF0YXNldC5kZW5zaXR5ID09PSBkZW5zaXR5KTtcbiAgfVxuICByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKCkgPT4gdXBkYXRlQWxsUmVzdWx0Q2xhbXBpbmcoKSk7XG59XG5cbi8vIFRoZSBzY3JlZW4uXG5cbmZ1bmN0aW9uIHNldENhbGxCdXR0b24obGl2ZTogYm9vbGVhbikge1xuICBjb25zdCBidG4gPSAkPEhUTUxCdXR0b25FbGVtZW50PihcImNhbGxcIik7XG4gIGJ0bi5jbGFzc0xpc3QudG9nZ2xlKFwibGl2ZVwiLCBsaXZlKTtcbiAgY29uc3QgbGFiZWwgPSBidG4ucXVlcnlTZWxlY3RvcihcIi5jYWxsLWxhYmVsXCIpO1xuICBpZiAobGFiZWwpIGxhYmVsLnRleHRDb250ZW50ID0gbGl2ZSA/IFwiSGFuZyB1cFwiIDogXCJDYWxsXCI7XG59XG5cbmZ1bmN0aW9uIHN5bmNSZXN1bWVCdXR0b25zKHNob3c6IGJvb2xlYW4pIHtcbiAgJChcInJlc3VtZVwiKS5oaWRkZW4gPSAhc2hvdztcbiAgJChcImhlcm8tcmVzdW1lXCIpLmhpZGRlbiA9ICFzaG93O1xufVxuXG5mdW5jdGlvbiBzeW5jQ29tcG9zZXIoKSB7XG4gIGNvbnN0IGlucHV0ID0gJDxIVE1MSW5wdXRFbGVtZW50PihcInRleHRcIik7XG4gIGNvbnN0IHRyaW1tZWQgPSBpbnB1dC52YWx1ZS50cmltKCk7XG4gICQoXCJzZW5kYnRuXCIpLmNsYXNzTGlzdC50b2dnbGUoXCJyZWFkeVwiLCB0cmltbWVkLmxlbmd0aCA+IDApO1xuICBjb25zdCBwYXJzZWQgPSBwYXJzZVByZWZpeCh0cmltbWVkKTtcbiAgJChcIm1vZGUtd3JhcFwiKS5kYXRhc2V0Lm1vZGUgPSBwYXJzZWQubW9kZSA/PyAkPEhUTUxTZWxlY3RFbGVtZW50PihcIm1vZGVcIikudmFsdWU7XG59XG5cbmZ1bmN0aW9uIGZvcm1hdENsb2NrKHNlY29uZHM6IG51bWJlcik6IHN0cmluZyB7XG4gIGNvbnN0IHRvdGFsID0gTWF0aC5tYXgoMCwgTWF0aC5mbG9vcihzZWNvbmRzKSk7XG4gIGNvbnN0IGggPSBNYXRoLmZsb29yKHRvdGFsIC8gMzYwMCk7XG4gIGNvbnN0IG0gPSBNYXRoLmZsb29yKCh0b3RhbCAlIDM2MDApIC8gNjApO1xuICBjb25zdCBzID0gdG90YWwgJSA2MDtcbiAgY29uc3QgcGFkID0gKG46IG51bWJlcikgPT4gU3RyaW5nKG4pLnBhZFN0YXJ0KDIsIFwiMFwiKTtcbiAgcmV0dXJuIGggPiAwID8gYCR7aH06JHtwYWQobSl9OiR7cGFkKHMpfWAgOiBgJHtwYWQobSl9OiR7cGFkKHMpfWA7XG59XG5cbmNvbnN0IFZJWl9XRUlHSFRTID0gWzAuNDgsIDAuODYsIDEuMCwgMC43OCwgMC40NF07XG5mdW5jdGlvbiB1cGRhdGVWaXN1YWxpemVyKG1vZGU6IHN0cmluZywgbGV2ZWw6IG51bWJlcikge1xuICBjb25zdCB2aXogPSAkKFwidml6XCIpO1xuICB2aXouZGF0YXNldC5tb2RlID0gbW9kZTtcbiAgY29uc3QgYmFycyA9IHZpei5jaGlsZHJlbjtcbiAgaWYgKG1vZGUgPT09IFwibGlzdGVuaW5nXCIgfHwgbW9kZSA9PT0gXCJ3b3JraW5nXCIpIHtcbiAgICBjb25zdCBlbmVyZ3kgPSBNYXRoLm1pbigxLCBsZXZlbCAqIDE0KTtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGJhcnMubGVuZ3RoOyBpKyspIHtcbiAgICAgIGNvbnN0IGggPSAwLjI0ICsgZW5lcmd5ICogVklaX1dFSUdIVFNbaV0gKiAwLjc2O1xuICAgICAgKGJhcnNbaV0gYXMgSFRNTEVsZW1lbnQpLnN0eWxlLnRyYW5zZm9ybSA9IGBzY2FsZVkoJHtoLnRvRml4ZWQoMil9KWA7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYmFycy5sZW5ndGg7IGkrKykgKGJhcnNbaV0gYXMgSFRNTEVsZW1lbnQpLnN0eWxlLnRyYW5zZm9ybSA9IFwiXCI7XG4gIH1cbn1cblxuLyoqIEEgc3lzdGVtIG5vdGlmaWNhdGlvbiB3aGlsZSB0aGUgcGFnZSBpcyBoaWRkZW46IGEgdGFzayBmaW5pc2hlZCwgb3Igb25lIG5lZWRzIHRoZSB1c2VyLiAqL1xuZnVuY3Rpb24gbm90aWZ5KHRpdGxlOiBzdHJpbmcsIGJvZHk6IHN0cmluZykge1xuICBpZiAoIWRvY3VtZW50LmhpZGRlbiB8fCAhKFwiTm90aWZpY2F0aW9uXCIgaW4gd2luZG93KSB8fCBOb3RpZmljYXRpb24ucGVybWlzc2lvbiAhPT0gXCJncmFudGVkXCIpIHJldHVybjtcbiAgdHJ5IHtcbiAgICBjb25zdCBuID0gbmV3IE5vdGlmaWNhdGlvbih0aXRsZSwgeyBib2R5OiBib2R5LnNsaWNlKDAsIDE4MCksIGljb246IFwiL3dlYi9pY29ucy9pY29uLTE5Mi5wbmdcIiwgdGFnOiB0aXRsZSB9KTtcbiAgICBuLm9uY2xpY2sgPSAoKSA9PiB7IHdpbmRvdy5mb2N1cygpOyBuLmNsb3NlKCk7IH07XG4gIH0gY2F0Y2gge1xuICAgIC8vIFBob25lcyB3YW50IG5vdGlmaWNhdGlvbnMgZnJvbSBhIHNlcnZpY2Ugd29ya2VyOyB0aGUgcGFnZSBoYXMgbm9uZS5cbiAgfVxufVxuXG5mdW5jdGlvbiB0b2FzdCh0ZXh0OiBzdHJpbmcpIHtcbiAgY29uc3QgdCA9ICQoXCJ0b2FzdFwiKTtcbiAgdC50ZXh0Q29udGVudCA9IHRleHQ7XG4gIHQuY2xhc3NMaXN0LmFkZChcIm9uXCIpO1xuICBjbGVhclRpbWVvdXQoKHRvYXN0IGFzIGFueSkudGltZXIpO1xuICAodG9hc3QgYXMgYW55KS50aW1lciA9IHNldFRpbWVvdXQoKCkgPT4gdC5jbGFzc0xpc3QucmVtb3ZlKFwib25cIiksIDE4MDApO1xufVxuXG5mdW5jdGlvbiBsb2coa2luZDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcsIGNscyA9IFwiXCIpIHtcbiAgY29uc3QgcGFuZSA9ICQoXCJsb2dcIik7XG4gIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvdy5jbGFzc05hbWUgPSBgcm93ICR7Y2xzfWA7XG4gIHJvdy5pbm5lckhUTUwgPSBgPHNwYW4gY2xhc3M9XCJ0XCI+JHsobm93KCkgLSBzdGFydGVkQXQpLnRvRml4ZWQoMil9PC9zcGFuPjxzcGFuIGNsYXNzPVwia1wiPiR7a2luZH08L3NwYW4+YDtcbiAgY29uc3QgYm9keSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBib2R5LmNsYXNzTmFtZSA9IFwiYlwiO1xuICBib2R5LnRleHRDb250ZW50ID0gdGV4dDtcbiAgcm93LmFwcGVuZChib2R5KTtcbiAgY29uc3Qgc3RpY2sgPSBwYW5lLnNjcm9sbFRvcCArIHBhbmUuY2xpZW50SGVpZ2h0ID49IHBhbmUuc2Nyb2xsSGVpZ2h0IC0gMzA7XG4gIHBhbmUuYXBwZW5kKHJvdyk7XG4gIHdoaWxlIChwYW5lLmNoaWxkRWxlbWVudENvdW50ID4gMzAwMCkgcGFuZS5maXJzdEVsZW1lbnRDaGlsZCEucmVtb3ZlKCk7XG4gIGlmIChzdGljaykgcGFuZS5zY3JvbGxUb3AgPSBwYW5lLnNjcm9sbEhlaWdodDtcbn1cblxuLyoqIEEgZnJhbWUgZnJvbSBvciB0byBHZW1pbmksIHdpdGggYXVkaW8gY3V0IG91dCwgc2hvcnQgZW5vdWdoIHRvIHJlYWQuICovXG5mdW5jdGlvbiBicmllZihkYXRhOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gZGF0YS5yZXBsYWNlKC9cImRhdGFcIjpcIltBLVphLXowLTkrLz1dezQwLH1cIi9nLCAobSkgPT4gYFwiZGF0YVwiOlwiXHUyMDI2JHtNYXRoLnJvdW5kKCgobS5sZW5ndGggLSA5KSAqIDMpIC8gNCl9IGJ5dGVzXCJgKS5zbGljZSgwLCA2MDApO1xufVxuXG5mdW5jdGlvbiBlc2NhcGVIdG1sKHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiB0ZXh0LnJlcGxhY2UoL1smPD5cIiddL2csIChjKSA9PiAoeyBcIiZcIjogXCImYW1wO1wiLCBcIjxcIjogXCImbHQ7XCIsIFwiPlwiOiBcIiZndDtcIiwgJ1wiJzogXCImcXVvdDtcIiwgXCInXCI6IFwiJiMzOTtcIiB9KVtjXSEpO1xufVxuXG4vKiogQSBsaXR0bGUgTWFya2Rvd24sIHNhZmVseTogY29kZSwgYm9sZCwgbGlua3MsIGxpc3RzIGFuZCBoZWFkaW5ncywgdGhlIHJlc3QgYXMgdGV4dC4gKi9cbmZ1bmN0aW9uIG1hcmtkb3duKHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGJsb2NrcyA9IGVzY2FwZUh0bWwodGV4dC50cmltKCkpLnNwbGl0KC9gYGAoPzpcXHcrKT9cXG4/Lyk7XG4gIHJldHVybiBibG9ja3MubWFwKChibG9jaywgaSkgPT4ge1xuICAgIGlmIChpICUgMiA9PT0gMSkgcmV0dXJuIGA8cHJlPjxjb2RlPiR7YmxvY2sucmVwbGFjZSgvXFxuJC8sIFwiXCIpfTwvY29kZT48L3ByZT5gO1xuICAgIGNvbnN0IGlubGluZSA9IChzOiBzdHJpbmcpID0+IHNcbiAgICAgIC5yZXBsYWNlKC9gKFteYFxcbl0rKWAvZywgXCI8Y29kZT4kMTwvY29kZT5cIilcbiAgICAgIC5yZXBsYWNlKC9cXCpcXCooW14qXFxuXSspXFwqXFwqL2csIFwiPGI+JDE8L2I+XCIpXG4gICAgICAucmVwbGFjZSgvXFxbKFteXFxdXFxuXSspXFxdXFwoKGh0dHBzPzpcXC9cXC9bXlxccyldKylcXCkvZywgJzxhIGhyZWY9XCIkMlwiIHRhcmdldD1cIl9ibGFua1wiIHJlbD1cIm5vb3BlbmVyXCI+JDE8L2E+JylcbiAgICAgIC5yZXBsYWNlKC8oXnxbXFxzKF0pKGh0dHBzPzpcXC9cXC9bXlxcczwpXSspL2csICckMTxhIGhyZWY9XCIkMlwiIHRhcmdldD1cIl9ibGFua1wiIHJlbD1cIm5vb3BlbmVyXCI+JDI8L2E+Jyk7XG4gICAgbGV0IGh0bWwgPSBcIlwiO1xuICAgIGxldCBsaXN0OiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICBmb3IgKGNvbnN0IHJhdyBvZiBibG9jay5zcGxpdChcIlxcblwiKSkge1xuICAgICAgY29uc3QgaXRlbSA9IHJhdy5tYXRjaCgvXlxccyooPzpbLSpcdTIwMjJdfChcXGQrKVsuKV0pXFxzKyguKikkLyk7XG4gICAgICBpZiAoaXRlbSkge1xuICAgICAgICBjb25zdCBraW5kID0gaXRlbVsxXSA/IFwib2xcIiA6IFwidWxcIjtcbiAgICAgICAgaWYgKGxpc3QgIT09IGtpbmQpIHsgaWYgKGxpc3QpIGh0bWwgKz0gYDwvJHtsaXN0fT5gOyBodG1sICs9IGA8JHtraW5kfT5gOyBsaXN0ID0ga2luZDsgfVxuICAgICAgICBodG1sICs9IGA8bGk+JHtpbmxpbmUoaXRlbVsyXSl9PC9saT5gO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGlmIChsaXN0KSB7IGh0bWwgKz0gYDwvJHtsaXN0fT5gOyBsaXN0ID0gbnVsbDsgfVxuICAgICAgY29uc3QgaGVhZGluZyA9IHJhdy5tYXRjaCgvXiN7MSw2fVxccysoLiopJC8pO1xuICAgICAgaHRtbCArPSBoZWFkaW5nID8gYDxkaXYgY2xhc3M9XCJtZC1oXCI+JHtpbmxpbmUoaGVhZGluZ1sxXSl9PC9kaXY+YCA6IHJhdy50cmltKCkgPT09IFwiXCIgPyBcIjxicj5cIiA6IGAke2lubGluZShyYXcpfTxicj5gO1xuICAgIH1cbiAgICBpZiAobGlzdCkgaHRtbCArPSBgPC8ke2xpc3R9PmA7XG4gICAgcmV0dXJuIGh0bWwucmVwbGFjZSgvKDxicj4pKyQvLCBcIlwiKTtcbiAgfSkuam9pbihcIlwiKTtcbn1cblxuY29uc3QgdHJhbnNjcmlwdFNjcm9sbCA9IG5ldyBBdXRvU2Nyb2xsZXIoJChcInRyYW5zY3JpcHRcIiksIHtcbiAgb25KdW1wQ2hhbmdlOiAoc2hvdykgPT4geyAkKFwianVtcGJvdHRvbVwiKS5oaWRkZW4gPSAhc2hvdzsgfSxcbiAgaXNFbXB0eTogKCkgPT4gISQoXCJlbXB0eVwiKS5oaWRkZW4sXG59KTtcblxuZnVuY3Rpb24gc2Nyb2xsRG93bihmb3JjZSA9IGZhbHNlKSB7XG4gIHRyYW5zY3JpcHRTY3JvbGwub25Db250ZW50KGZvcmNlKTtcbn1cblxuLyoqIFRoZSBjb3JlJ3MgbnVtYmVyIGZvciB0aGUgbGluZSB0aGUgbGFzdCByb3cgc2hvd3MsIHVudGlsIGFub3RoZXIgcm93IGZvbGxvd3MgaXQuICovXG5sZXQgb3BlbkxpbmU6IG51bWJlciB8IG51bGwgPSBudWxsO1xuXG4vKiogV29yZHMgZ28gb24gdGhlIHJvdyB0aGUgY29yZSBzYXlzIHRoZXkgYmVsb25nIHRvOiBpdCBzdGFydHMgYSBuZXcgbGluZSBmb3IgZWFjaCB0dXJuLCBob3dldmVyIGxvbmcgdGhlIGdhcC4gKi9cbmZ1bmN0aW9uIHRyYW5zY3JpcHQocm9sZTogXCJ1c2VyXCIgfCBcImFzc2lzdGFudFwiLCB0ZXh0OiBzdHJpbmcsIGxpbmU6IG51bWJlcikge1xuICAkKFwiZW1wdHlcIikuaGlkZGVuID0gdHJ1ZTtcbiAgY29uc3QgcGFuZSA9ICQoXCJ0cmFuc2NyaXB0XCIpO1xuICBjb25zdCBsYXN0ID0gcGFuZS5sYXN0RWxlbWVudENoaWxkIGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgaWYgKG9wZW5MaW5lID09PSBsaW5lICYmIGxhc3QgJiYgbGFzdC5kYXRhc2V0LnJvbGUgPT09IHJvbGUpIGxhc3QucXVlcnlTZWxlY3RvcihcIi50ZXh0XCIpIS50ZXh0Q29udGVudCArPSB0ZXh0O1xuICBlbHNlIHtcbiAgICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIHJvdy5jbGFzc05hbWUgPSBgbGluZSAke3JvbGV9YDtcbiAgICByb3cuZGF0YXNldC5yb2xlID0gcm9sZTtcbiAgICByb3cuaW5uZXJIVE1MID0gYDxzcGFuIGNsYXNzPVwid2hvXCI+JHtyb2xlID09PSBcInVzZXJcIiA/IFwiWW91XCIgOiBcIkdlbWluaVwifTwvc3Bhbj48c3BhbiBjbGFzcz1cInRleHRcIj48L3NwYW4+YDtcbiAgICByb3cucXVlcnlTZWxlY3RvcihcIi50ZXh0XCIpIS50ZXh0Q29udGVudCA9IHRleHQudHJpbVN0YXJ0KCk7XG4gICAgcGFuZS5hcHBlbmQocm93KTtcbiAgICBvcGVuTGluZSA9IGxpbmU7XG4gIH1cbiAgc2Nyb2xsRG93bigpO1xufVxuXG4vKipcbiAqIFRoZSB3b3JkcyB0aGUgdXNlciBpcyBzYXlpbmcsIGJlZm9yZSB0aGUgbW9kZWwgaGFzIHRyYW5zY3JpYmVkIHRoZW06IGEgZmFpbnQgcm93IHRoYXQgc3RheXMgbGFzdFxuICogb24gc2NyZWVuIChpdHMgQ1NTIGBvcmRlcmApIGFuZCBmaXJzdCBpbiB0aGUgcGFuZSwgc28gdGhlIGxpbmVzIGFmdGVyIGl0IGpvaW4gdXAgYXMgYmVmb3JlLlxuICovXG5mdW5jdGlvbiBjYXB0aW9uKHRleHQ6IHN0cmluZyB8IG51bGwpIHtcbiAgY29uc3QgcGFuZSA9ICQoXCJ0cmFuc2NyaXB0XCIpO1xuICBsZXQgcm93ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJjYXB0aW9uXCIpO1xuICBpZiAodGV4dCA9PSBudWxsKSB7IHJvdz8ucmVtb3ZlKCk7IHNjcm9sbERvd24oKTsgcmV0dXJuOyB9XG4gICQoXCJlbXB0eVwiKS5oaWRkZW4gPSB0cnVlO1xuICBpZiAoIXJvdykge1xuICAgIHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgcm93LmlkID0gXCJjYXB0aW9uXCI7XG4gICAgcm93LmNsYXNzTmFtZSA9IFwibGluZSB1c2VyIGNhcHRpb25cIjtcbiAgICByb3cuaW5uZXJIVE1MID0gYDxzcGFuIGNsYXNzPVwid2hvXCI+WW91PC9zcGFuPjxzcGFuIGNsYXNzPVwidGV4dFwiPjwvc3Bhbj5gO1xuICAgIHBhbmUucHJlcGVuZChyb3cpO1xuICB9XG4gIHJvdy5xdWVyeVNlbGVjdG9yKFwiLnRleHRcIikhLnRleHRDb250ZW50ID0gdGV4dDtcbiAgc2Nyb2xsRG93bigpO1xufVxuXG5mdW5jdGlvbiBub3RlKHRleHQ6IHN0cmluZykge1xuICAkKFwiZW1wdHlcIikuaGlkZGVuID0gdHJ1ZTtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IFwibGluZSBub3RlXCI7XG4gIHJvdy50ZXh0Q29udGVudCA9IHRleHQ7XG4gICQoXCJ0cmFuc2NyaXB0XCIpLmFwcGVuZChyb3cpO1xuICBvcGVuTGluZSA9IG51bGw7XG4gIHNjcm9sbERvd24oKTtcbn1cblxuLy8gQWdlbnQgaGFuZG9mZiByZXN1bHRzOiBjb21wYWN0IDEtbGluZSByZWZlcmVuY2UgaW4gdGhlIHZvaWNlIHN0cmVhbSArIGZ1bGwgY29sbGFwc2libGUgY2FyZCBpbiB0aGUgcmlnaHQgcGFuZS5cblxuZnVuY3Rpb24gcmVzdWx0Q2xhbXBQeChlbDogSFRNTEVsZW1lbnQpOiBudW1iZXIge1xuICBjb25zdCByYXcgPSBnZXRDb21wdXRlZFN0eWxlKGVsKS5nZXRQcm9wZXJ0eVZhbHVlKFwiLS1yZXMtY2xhbXAtbWF4XCIpLnRyaW0oKTtcbiAgY29uc3QgbiA9IE51bWJlci5wYXJzZUZsb2F0KHJhdyk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobikgJiYgbiA+IDAgPyBuIDogNjQ7XG59XG5cbmZ1bmN0aW9uIHN5bmNFeHBhbmRBbGxCdXR0b24oKSB7XG4gIGNvbnN0IGNsYW1wZWQgPSBbLi4ucmVzdWx0cy52YWx1ZXMoKV0uZmlsdGVyKChyKSA9PiByLmNhcmQuY2xhc3NMaXN0LmNvbnRhaW5zKFwiY2xhbXBlZFwiKSk7XG4gIGNvbnN0IGJ0biA9ICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwidG9nZ2xlLWFsbC1yZXN1bHRzXCIpO1xuICBidG4uaGlkZGVuID0gY2xhbXBlZC5sZW5ndGggPT09IDA7XG4gIGlmIChjbGFtcGVkLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuICBjb25zdCBhbnlDb2xsYXBzZWQgPSBjbGFtcGVkLnNvbWUoKHIpID0+ICFyLmNhcmQuY2xhc3NMaXN0LmNvbnRhaW5zKFwib3BlblwiKSk7XG4gIGJ0bi50ZXh0Q29udGVudCA9IGFueUNvbGxhcHNlZCA/IFwiRXhwYW5kIGFsbFwiIDogXCJDb2xsYXBzZSBhbGxcIjtcbn1cblxuZnVuY3Rpb24gc2V0UmVzdWx0T3BlbihlbnRyeTogUmVzdWx0RW50cnksIG9wZW46IGJvb2xlYW4pIHtcbiAgY29uc3QgY2xhbXBlZCA9IGVudHJ5LmNhcmQuY2xhc3NMaXN0LmNvbnRhaW5zKFwiY2xhbXBlZFwiKTtcbiAgY29uc3QgbmV4dCA9IGNsYW1wZWQgJiYgb3BlbjtcbiAgZW50cnkuY2FyZC5jbGFzc0xpc3QudG9nZ2xlKFwib3BlblwiLCBuZXh0KTtcbiAgZW50cnkuaGVhZC5zZXRBdHRyaWJ1dGUoXCJhcmlhLWV4cGFuZGVkXCIsIFN0cmluZyghY2xhbXBlZCB8fCBuZXh0KSk7XG4gIGVudHJ5Lm1vcmVCdG4udGV4dENvbnRlbnQgPSBuZXh0ID8gXCJTaG93IGxlc3NcIiA6IFwiU2hvdyBtb3JlXCI7XG4gIHN5bmNFeHBhbmRBbGxCdXR0b24oKTtcbn1cblxuZnVuY3Rpb24gdXBkYXRlUmVzdWx0Q2xhbXBpbmcoZW50cnk6IFJlc3VsdEVudHJ5KSB7XG4gIGlmIChlbnRyeS5ib2R5Lm9mZnNldFBhcmVudCA9PT0gbnVsbCkgcmV0dXJuO1xuICAvLyBVbmNsYW1wZWQgY2FyZHMgaGF2ZSBubyBtYXgtaGVpZ2h0LCBzbyBzY3JvbGxIZWlnaHQgaXMgYWx3YXlzIHRoZSBmdWxsIG5hdHVyYWwgaGVpZ2h0LlxuICBjb25zdCBvdmVyZmxvd3MgPSBlbnRyeS5ib2R5LnNjcm9sbEhlaWdodCA+IHJlc3VsdENsYW1wUHgoZW50cnkuY2FyZCkgKyA0O1xuICBlbnRyeS5jYXJkLmNsYXNzTGlzdC50b2dnbGUoXCJjbGFtcGVkXCIsIG92ZXJmbG93cyk7XG4gIGlmICghb3ZlcmZsb3dzKSBlbnRyeS5jYXJkLmNsYXNzTGlzdC5yZW1vdmUoXCJvcGVuXCIpO1xuICBlbnRyeS5tb3JlQnRuLmhpZGRlbiA9ICFvdmVyZmxvd3M7XG4gIGNvbnN0IGlzT3BlbiA9IGVudHJ5LmNhcmQuY2xhc3NMaXN0LmNvbnRhaW5zKFwib3BlblwiKTtcbiAgZW50cnkubW9yZUJ0bi50ZXh0Q29udGVudCA9IGlzT3BlbiA/IFwiU2hvdyBsZXNzXCIgOiBcIlNob3cgbW9yZVwiO1xuICBlbnRyeS5oZWFkLnNldEF0dHJpYnV0ZShcImFyaWEtZXhwYW5kZWRcIiwgU3RyaW5nKCFvdmVyZmxvd3MgfHwgaXNPcGVuKSk7XG59XG5cbmZ1bmN0aW9uIHVwZGF0ZUFsbFJlc3VsdENsYW1waW5nKCkge1xuICBmb3IgKGNvbnN0IGVudHJ5IG9mIHJlc3VsdHMudmFsdWVzKCkpIHVwZGF0ZVJlc3VsdENsYW1waW5nKGVudHJ5KTtcbiAgc3luY0V4cGFuZEFsbEJ1dHRvbigpO1xufVxuXG5mdW5jdGlvbiBzeW5jUmVzdWx0Rm9sbG93VXBCdXR0b25zKCkge1xuICBmb3IgKGNvbnN0IGVudHJ5IG9mIHJlc3VsdHMudmFsdWVzKCkpIHtcbiAgICBpZiAoIWVudHJ5LmZvbGxvd0J0bikgY29udGludWU7XG4gICAgY29uc3QgY2FuRm9sbG93ID0gY2FuRm9sbG93VXBSZXN1bHQoZW50cnkuc2Vzc2lvbklkLCBhY3RpdmVTZXNzaW9uLCBCb29sZWFuKGVudHJ5LnRhc2tJZCAmJiB0YXNrcy5oYXMoZW50cnkudGFza0lkKSkpO1xuICAgIGVudHJ5LmZvbGxvd0J0bi5oaWRkZW4gPSAhY2FuRm9sbG93O1xuICAgIGlmICghY2FuRm9sbG93KSBlbnRyeS5jYXJkLnF1ZXJ5U2VsZWN0b3IoXCJmb3JtXCIpPy5yZW1vdmUoKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBjbGVhclVucmVhZElmUmVzdWx0c1Zpc2libGUoKSB7XG4gIGlmICh1bnJlYWRNb2JpbGVSZXN1bHRzID09PSAwKSByZXR1cm47XG4gIGNvbnN0IGRyYXdlck9wZW4gPSBkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5jb250YWlucyhcInRhc2tzLW9wZW5cIik7XG4gIGlmIChzaG91bGRDbGVhclVucmVhZFJlc3VsdHMobW9iaWxlTGF5b3V0Lm1hdGNoZXMsIGRyYXdlck9wZW4sIHNpZGVGaWx0ZXIpKSB7XG4gICAgdW5yZWFkTW9iaWxlUmVzdWx0cyA9IDA7XG4gICAgdXBkYXRlVGFza0Nocm9tZSgpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGZvY3VzUmVzdWx0KGlkOiBzdHJpbmcpIHtcbiAgY29uc3QgZW50cnkgPSByZXN1bHRzLmdldChpZCk7XG4gIGlmICghZW50cnkpIHJldHVybjtcbiAgaWYgKHNpZGVGaWx0ZXIgPT09IFwiYWN0aXZlXCIpIHNldFNpZGVGaWx0ZXIoXCJhbGxcIik7XG4gIGlmIChtb2JpbGVMYXlvdXQubWF0Y2hlcykgc2V0VGFza3NPcGVuKHRydWUpO1xuICByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKCkgPT4ge1xuICAgIHVwZGF0ZVJlc3VsdENsYW1waW5nKGVudHJ5KTtcbiAgICBpZiAoZW50cnkuY2FyZC5jbGFzc0xpc3QuY29udGFpbnMoXCJjbGFtcGVkXCIpKSBzZXRSZXN1bHRPcGVuKGVudHJ5LCB0cnVlKTtcbiAgICBmb3IgKGNvbnN0IHIgb2YgcmVzdWx0cy52YWx1ZXMoKSkgci5jYXJkLmNsYXNzTGlzdC5yZW1vdmUoXCJmbGFzaFwiKTtcbiAgICB2b2lkIGVudHJ5LmNhcmQub2Zmc2V0V2lkdGg7XG4gICAgZW50cnkuY2FyZC5jbGFzc0xpc3QuYWRkKFwiZmxhc2hcIik7XG4gICAgY2xlYXJUaW1lb3V0KGZsYXNoVGltZXIpO1xuICAgIGZsYXNoVGltZXIgPSB3aW5kb3cuc2V0VGltZW91dCgoKSA9PiBlbnRyeS5jYXJkLmNsYXNzTGlzdC5yZW1vdmUoXCJmbGFzaFwiKSwgMTQwMCk7XG4gICAgZW50cnkuY2FyZC5zY3JvbGxJbnRvVmlldyh7IGJlaGF2aW9yOiBcInNtb290aFwiLCBibG9jazogXCJuZWFyZXN0XCIgfSk7XG4gIH0pO1xufVxuXG5mdW5jdGlvbiByZXN1bHQoYWdlbnQ6IHN0cmluZywgbGFiZWw6IHN0cmluZywgdGV4dDogc3RyaW5nLCBmYWlsZWQgPSBmYWxzZSwgdGFza0lkPzogc3RyaW5nLCBzZXNzaW9uSWQgPSBhY3RpdmVTZXNzaW9uKTogc3RyaW5nIHtcbiAgJChcImVtcHR5XCIpLmhpZGRlbiA9IHRydWU7XG4gIGNvbnN0IGlkID0gYHJlcy0keysrbmV4dFJlc3VsdFNlcX1gO1xuICBjb25zdCB3aG8gPSBhZ2VudCA9PT0gXCJ0M1wiID8gXCJUM1wiIDogXCJIZXJtZXNcIjtcbiAgY29uc3QgYWdlbnRDbHMgPSBhZ2VudCA9PT0gXCJ0M1wiID8gXCJ0M1wiIDogXCJcIjtcbiAgY29uc3Qgc25pcHBldCA9IHBsYWluUHJldmlldyh0ZXh0LCAxNjApIHx8IFwiKGVtcHR5IHJlc3BvbnNlKVwiO1xuXG4gIC8vIDEuIENvbXBhY3QgaW5saW5lIGhhbmRvZmYgbWFya2VyIGluIHRoZSB2b2ljZSB0cmFuc2NyaXB0IHNvIGNocm9ub2xvZ2ljYWwgY29udGV4dCBzdGF5cyBpbnRhY3RcbiAgLy8gd2l0aG91dCBtdWx0aS1wYXJhZ3JhcGggcmVzcG9uc2VzIHB1c2hpbmcgdm9pY2UgdHVybnMgb2ZmIHNjcmVlbi5cbiAgY29uc3QgcmVmUm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgcmVmUm93LnR5cGUgPSBcImJ1dHRvblwiO1xuICByZWZSb3cuY2xhc3NOYW1lID0gYGxpbmUgaGFuZG9mZiAke2FnZW50Q2xzfSAke2ZhaWxlZCA/IFwiZmFpbGVkXCIgOiBcIlwifWAudHJpbSgpO1xuICByZWZSb3cuZGF0YXNldC5yZXN1bHRJZCA9IGlkO1xuICByZWZSb3cuaW5uZXJIVE1MID1cbiAgICBgPHNwYW4gY2xhc3M9XCJiYWRnZSAke2FnZW50Q2xzfVwiPiR7d2hvfTwvc3Bhbj5gICtcbiAgICBgPHNwYW4gY2xhc3M9XCJoYW5kb2ZmLWxhYmVsXCI+JHtlc2NhcGVIdG1sKGxhYmVsKX08L3NwYW4+YCArXG4gICAgYDxzcGFuIGNsYXNzPVwiaGFuZG9mZi1zbmlwcGV0XCI+JHtlc2NhcGVIdG1sKHNuaXBwZXQpfTwvc3Bhbj5gICtcbiAgICBgPHNwYW4gY2xhc3M9XCJoYW5kb2ZmLWN1ZVwiPiR7ZmFpbGVkID8gXCJGYWlsZWRcIiA6IFwiT3BlbiBcdTIxOTdcIn08L3NwYW4+YDtcbiAgcmVmUm93Lm9uY2xpY2sgPSAoKSA9PiBmb2N1c1Jlc3VsdChpZCk7XG4gICQoXCJ0cmFuc2NyaXB0XCIpLmFwcGVuZChyZWZSb3cpO1xuICBvcGVuTGluZSA9IG51bGw7XG4gIHNjcm9sbERvd24oKTtcblxuICAvLyAyLiBUcnVuY2F0ZWQsIGV4cGFuZGFibGUgcmVzdWx0IGNhcmQgaW4gdGhlIHJpZ2h0LWhhbmQgQWdlbnQgV29ya3NwYWNlIChuZXdlc3QgZmlyc3QpLlxuICBjb25zdCBjYXJkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImFydGljbGVcIik7XG4gIGNhcmQuY2xhc3NOYW1lID0gYHJlcy1jYXJkICR7YWdlbnRDbHN9ICR7ZmFpbGVkID8gXCJmYWlsZWRcIiA6IFwiXCJ9YC50cmltKCk7XG4gIGNhcmQuZGF0YXNldC5yZXN1bHRJZCA9IGlkO1xuXG4gIGNvbnN0IGhlYWQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBoZWFkLnR5cGUgPSBcImJ1dHRvblwiO1xuICBoZWFkLmNsYXNzTmFtZSA9IFwicmVzLWhlYWRcIjtcbiAgaGVhZC5zZXRBdHRyaWJ1dGUoXCJhcmlhLWV4cGFuZGVkXCIsIFwidHJ1ZVwiKTtcbiAgaGVhZC5pbm5lckhUTUwgPVxuICAgIGA8c3BhbiBjbGFzcz1cImJhZGdlICR7YWdlbnRDbHN9XCI+JHt3aG99PC9zcGFuPmAgK1xuICAgIGA8c3BhbiBjbGFzcz1cInJlcy1sYWJlbFwiIHRpdGxlPVwiJHtlc2NhcGVIdG1sKGxhYmVsKX1cIj4ke2VzY2FwZUh0bWwobGFiZWwpfTwvc3Bhbj5gICtcbiAgICAoZmFpbGVkID8gYDxzcGFuIGNsYXNzPVwicmVzLXBpbGxcIj5GYWlsZWQ8L3NwYW4+YCA6IFwiXCIpICtcbiAgICBgPHNwYW4gY2xhc3M9XCJyZXMtdGltZVwiPiR7Zm9ybWF0U2hvcnRUaW1lKG5ldyBEYXRlKCkpfTwvc3Bhbj5gICtcbiAgICBgPHNwYW4gY2xhc3M9XCJyZXMtY2hldlwiIGFyaWEtaGlkZGVuPVwidHJ1ZVwiPjwvc3Bhbj5gO1xuXG4gIGNvbnN0IGJvZHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBib2R5LmNsYXNzTmFtZSA9IFwicmVzLWJvZHlcIjtcbiAgYm9keS5pbm5lckhUTUwgPSBtYXJrZG93bih0ZXh0KTtcblxuICBjb25zdCBmb290ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgZm9vdC5jbGFzc05hbWUgPSBcInJlcy1mb290XCI7XG5cbiAgY29uc3QgbW9yZUJ0biA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIG1vcmVCdG4udHlwZSA9IFwiYnV0dG9uXCI7XG4gIG1vcmVCdG4uY2xhc3NOYW1lID0gXCJyZXMtYWN0IHByaW1hcnlcIjtcbiAgbW9yZUJ0bi50ZXh0Q29udGVudCA9IFwiU2hvdyBtb3JlXCI7XG4gIG1vcmVCdG4uaGlkZGVuID0gdHJ1ZTtcblxuICBjb25zdCBjb3B5QnRuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgY29weUJ0bi50eXBlID0gXCJidXR0b25cIjtcbiAgY29weUJ0bi5jbGFzc05hbWUgPSBcInJlcy1hY3RcIjtcbiAgY29weUJ0bi50ZXh0Q29udGVudCA9IFwiQ29weVwiO1xuICBjb3B5QnRuLm9uY2xpY2sgPSAoKSA9PiB7XG4gICAgdm9pZCBuYXZpZ2F0b3IuY2xpcGJvYXJkPy53cml0ZVRleHQodGV4dCk7XG4gICAgdG9hc3QoXCJSZXN1bHQgY29waWVkXCIpO1xuICB9O1xuXG4gIGZvb3QuYXBwZW5kKG1vcmVCdG4sIGNvcHlCdG4pO1xuXG4gIGxldCBmb2xsb3dCdG46IEhUTUxCdXR0b25FbGVtZW50IHwgdW5kZWZpbmVkO1xuICBpZiAodGFza0lkKSB7XG4gICAgZm9sbG93QnRuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgICBmb2xsb3dCdG4udHlwZSA9IFwiYnV0dG9uXCI7XG4gICAgZm9sbG93QnRuLmNsYXNzTmFtZSA9IFwicmVzLWFjdFwiO1xuICAgIGZvbGxvd0J0bi50ZXh0Q29udGVudCA9IFwiRm9sbG93IHVwXCI7XG4gICAgZm9sbG93QnRuLm9uY2xpY2sgPSAoKSA9PiB7XG4gICAgICBpZiAoIWNhbkZvbGxvd1VwUmVzdWx0KHNlc3Npb25JZCwgYWN0aXZlU2Vzc2lvbiwgdGFza3MuaGFzKHRhc2tJZCkpKSB7XG4gICAgICAgIHN5bmNSZXN1bHRGb2xsb3dVcEJ1dHRvbnMoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY29uc3QgdmlldyA9IHRhc2tzLmdldCh0YXNrSWQpO1xuICAgICAgaWYgKHZpZXcpIGZvbGxvd1VwRm9ybShjYXJkLCB2aWV3LmMsIHNlc3Npb25JZCk7XG4gICAgfTtcbiAgICBmb290LmFwcGVuZChmb2xsb3dCdG4pO1xuICB9XG5cbiAgY2FyZC5hcHBlbmQoaGVhZCwgYm9keSwgZm9vdCk7XG5cbiAgY29uc3QgZW50cnk6IFJlc3VsdEVudHJ5ID0geyBpZCwgYWdlbnQsIGxhYmVsLCB0ZXh0LCBmYWlsZWQsIHRhc2tJZCwgc2Vzc2lvbklkLCBjYXJkLCBoZWFkLCBib2R5LCBtb3JlQnRuLCBmb2xsb3dCdG4sIHJlZlJvdyB9O1xuICBjb25zdCB0b2dnbGUgPSAoKSA9PiB7XG4gICAgaWYgKCFlbnRyeS5jYXJkLmNsYXNzTGlzdC5jb250YWlucyhcImNsYW1wZWRcIikpIHJldHVybjtcbiAgICBzZXRSZXN1bHRPcGVuKGVudHJ5LCAhZW50cnkuY2FyZC5jbGFzc0xpc3QuY29udGFpbnMoXCJvcGVuXCIpKTtcbiAgfTtcbiAgaGVhZC5vbmNsaWNrID0gdG9nZ2xlO1xuICBtb3JlQnRuLm9uY2xpY2sgPSB0b2dnbGU7XG5cbiAgcmVzdWx0cy5zZXQoaWQsIGVudHJ5KTtcbiAgJChcInJlc3VsdHNcIikucHJlcGVuZChjYXJkKTtcbiAgY29uc3QgZHJhd2VyT3BlbiA9IGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LmNvbnRhaW5zKFwidGFza3Mtb3BlblwiKTtcbiAgaWYgKCFzaG91bGRDbGVhclVucmVhZFJlc3VsdHMobW9iaWxlTGF5b3V0Lm1hdGNoZXMsIGRyYXdlck9wZW4sIHNpZGVGaWx0ZXIpKSB1bnJlYWRNb2JpbGVSZXN1bHRzKys7XG5cbiAgc3luY1NpZGVMYXlvdXQoKTtcbiAgdXBkYXRlVGFza0Nocm9tZSgpO1xuICByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKCkgPT4ge1xuICAgIHVwZGF0ZVJlc3VsdENsYW1waW5nKGVudHJ5KTtcbiAgICBzeW5jRXhwYW5kQWxsQnV0dG9uKCk7XG4gIH0pO1xuICByZXR1cm4gaWQ7XG59XG5cbmZ1bmN0aW9uIGVsYXBzZWQoc2Vjb25kczogbnVtYmVyKTogc3RyaW5nIHtcbiAgaWYgKHNlY29uZHMgPCA2MCkgcmV0dXJuIGAke01hdGguZmxvb3Ioc2Vjb25kcyl9c2A7XG4gIGNvbnN0IG0gPSBNYXRoLmZsb29yKHNlY29uZHMgLyA2MCk7XG4gIHJldHVybiBtIDwgNjAgPyBgJHttfW0gJHtNYXRoLmZsb29yKHNlY29uZHMgJSA2MCl9c2AgOiBgJHtNYXRoLmZsb29yKG0gLyA2MCl9aCAke20gJSA2MH1tYDtcbn1cblxuLyoqIFRoZSBlbXB0eSB0YXNrIGxpc3QncyB3b3Jkcywga2VwdCB0byBwdXQgYmFjay4gKi9cbmNvbnN0IG5vVGFza3MgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcIm5vdGFza3NcIikhO1xuXG4vKiogV2hldGhlciBhIHRhc2sgc3RpbGwgd2FudHMgdGhlIHNjcmVlbjogaXQncyB3b3JraW5nLCB3YWl0aW5nLCBvciBuZWVkcyBhcHByb3ZhbC4gVGhlIHJlc3QgZm9sZCBhd2F5IHVuZGVyIEZpbmlzaGVkLiAqL1xuY29uc3QgbGl2ZSA9IChzdGF0ZTogc3RyaW5nKSA9PiBzdGF0ZSA9PT0gXCJydW5uaW5nXCIgfHwgc3RhdGUuc3RhcnRzV2l0aChcIndhaXRpbmdcIik7XG5jb25zdCBpc0FjdGl2ZVRhc2sgPSAodmlldzogVGFza1ZpZXcpID0+IGxpdmUodmlldy5jLnN0YXRlKSB8fCBCb29sZWFuKHZpZXcuYXBwcm92YWwpO1xuXG5mdW5jdGlvbiBzZXRTaWRlRmlsdGVyKGZpbHRlcjogU2lkZUZpbHRlcikge1xuICBzaWRlRmlsdGVyID0gbm9ybWFsaXplU2lkZUZpbHRlcihmaWx0ZXIpO1xuICBmb3IgKGNvbnN0IGJ0biBvZiBBcnJheS5mcm9tKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiI3NpZGUtdGFicyBidXR0b25cIikpKSB7XG4gICAgY29uc3Qgb24gPSBidG4uZGF0YXNldC5maWx0ZXIgPT09IHNpZGVGaWx0ZXI7XG4gICAgYnRuLmNsYXNzTGlzdC50b2dnbGUoXCJvblwiLCBvbik7XG4gICAgYnRuLnNldEF0dHJpYnV0ZShcImFyaWEtcHJlc3NlZFwiLCBTdHJpbmcob24pKTtcbiAgfVxuICBzeW5jU2lkZUxheW91dCgpO1xuICBjbGVhclVucmVhZElmUmVzdWx0c1Zpc2libGUoKTtcbiAgcmVxdWVzdEFuaW1hdGlvbkZyYW1lKCgpID0+IHVwZGF0ZUFsbFJlc3VsdENsYW1waW5nKCkpO1xufVxuXG5mdW5jdGlvbiBzeW5jU2lkZUxheW91dCgpIHtcbiAgY29uc3QgYWxsID0gWy4uLnRhc2tzLnZhbHVlcygpXTtcbiAgY29uc3QgYWN0aXZlQ3VycmVudCA9IGFsbC5maWx0ZXIoaXNBY3RpdmVUYXNrKS5sZW5ndGg7XG4gIGNvbnN0IGFjdGl2ZVRvdGFsID0gYWN0aXZlQ3VycmVudCArIGVhcmxpZXJBY3RpdmVDb3VudDtcbiAgY29uc3QgcmVzdWx0c1RvdGFsID0gcmVzdWx0cy5zaXplO1xuICBjb25zdCBlYXJsaWVyU2hvd24gPSAkKFwiZWFybGllclwiKS5jaGlsZEVsZW1lbnRDb3VudDtcbiAgY29uc3QgZG9uZVRvdGFsID0gJChcImRvbmVub3dcIikuY2hpbGRFbGVtZW50Q291bnQgKyAkKFwiZG9uZWVhcmxpZXJcIikuY2hpbGRFbGVtZW50Q291bnQ7XG5cbiAgY29uc3QgdmlzID0gcmVzb2x2ZVNpZGVTZWN0aW9ucyhzaWRlRmlsdGVyLCB7XG4gICAgYWN0aXZlOiBhY3RpdmVDdXJyZW50LFxuICAgIHJlc3VsdHM6IHJlc3VsdHNUb3RhbCxcbiAgICBlYXJsaWVyOiBlYXJsaWVyU2hvd24sXG4gICAgZG9uZTogZG9uZVRvdGFsLFxuICB9KTtcblxuICAkKFwidGFza3Mtc2VjdGlvblwiKS5oaWRkZW4gPSAhdmlzLnNob3dUYXNrc1NlY3Rpb247XG4gIG5vVGFza3MuaGlkZGVuID0gIXZpcy5zaG93RW1wdHlUYXNrcztcbiAgJChcInJlc3VsdHMtc2VjdGlvblwiKS5oaWRkZW4gPSAhdmlzLnNob3dSZXN1bHRzU2VjdGlvbjtcbiAgJChcIm5vcmVzdWx0c1wiKS5oaWRkZW4gPSAhdmlzLnNob3dFbXB0eVJlc3VsdHM7XG4gICQoXCJlYXJsaWVyYm94XCIpLmhpZGRlbiA9ICF2aXMuc2hvd0VhcmxpZXJTZWN0aW9uO1xuICAkKFwiZG9uZWJveFwiKS5oaWRkZW4gPSAhdmlzLnNob3dEb25lU2VjdGlvbjtcblxuICAkKFwic2lkZS1hY3RpdmUtblwiKS50ZXh0Q29udGVudCA9IGFjdGl2ZVRvdGFsID4gMCA/IFN0cmluZyhhY3RpdmVUb3RhbCkgOiBcIlwiO1xuICAkKFwic2lkZS1yZXN1bHRzLW5cIikudGV4dENvbnRlbnQgPSByZXN1bHRzVG90YWwgPiAwID8gU3RyaW5nKHJlc3VsdHNUb3RhbCkgOiBcIlwiO1xuICAkKFwicmVzdWx0c2NvdW50XCIpLnRleHRDb250ZW50ID0gcmVzdWx0c1RvdGFsID4gMCA/IGBcdTAwQjcgJHtyZXN1bHRzVG90YWx9YCA6IFwiXCI7XG4gICQoXCJkb25lY291bnRcIikudGV4dENvbnRlbnQgPSBkb25lVG90YWwgPiAwID8gYFx1MDBCNyAke2RvbmVUb3RhbH1gIDogXCJcIjtcbiAgc3luY1Jlc3VsdEZvbGxvd1VwQnV0dG9ucygpO1xufVxuXG5mdW5jdGlvbiB1cGRhdGVUYXNrQ2hyb21lKCkge1xuICBjb25zdCBhbGwgPSBbLi4udGFza3MudmFsdWVzKCldO1xuICBjb25zdCBhY3RpdmVDdXJyZW50ID0gYWxsLmZpbHRlcihpc0FjdGl2ZVRhc2spLmxlbmd0aDtcbiAgY29uc3Qgd2FpdGluZyA9IGFsbC5maWx0ZXIoKHQpID0+IHQuYy5zdGF0ZS5zdGFydHNXaXRoKFwid2FpdGluZ1wiKSB8fCBCb29sZWFuKHQuYXBwcm92YWwpKS5sZW5ndGg7XG4gIGNvbnN0IGFjdGl2ZVRvdGFsID0gYWN0aXZlQ3VycmVudCArIGVhcmxpZXJBY3RpdmVDb3VudDtcbiAgY29uc3QgYXR0ZW50aW9uVG90YWwgPSB3YWl0aW5nICsgZWFybGllcldhaXRpbmdDb3VudDtcbiAgY29uc3QgYmFkZ2VDb3VudCA9IGFjdGl2ZVRvdGFsID4gMCA/IGFjdGl2ZVRvdGFsIDogdW5yZWFkTW9iaWxlUmVzdWx0cztcblxuICBjb25zdCBiYWRnZSA9ICQoXCJ0YXNrcy1iYWRnZVwiKTtcbiAgYmFkZ2UuaGlkZGVuID0gYmFkZ2VDb3VudCA9PT0gMDtcbiAgYmFkZ2UudGV4dENvbnRlbnQgPSBTdHJpbmcoYmFkZ2VDb3VudCk7XG4gIGJhZGdlLmNsYXNzTGlzdC50b2dnbGUoXCJ3YXJuXCIsIGF0dGVudGlvblRvdGFsID4gMCk7XG5cbiAgY29uc3QgYmFyID0gJChcIm1vYmlsZS10YXNrcy1iYXJcIik7XG4gIGNvbnN0IHNob3dCYXIgPSBhY3RpdmVUb3RhbCA+IDAgfHwgdW5yZWFkTW9iaWxlUmVzdWx0cyA+IDA7XG4gIGJhci5oaWRkZW4gPSAhc2hvd0JhcjtcbiAgYmFyLmNsYXNzTGlzdC50b2dnbGUoXCJ2aXNpYmxlXCIsIHNob3dCYXIpO1xuICBiYXIuY2xhc3NMaXN0LnRvZ2dsZShcIndhcm5cIiwgYXR0ZW50aW9uVG90YWwgPiAwKTtcbiAgaWYgKHNob3dCYXIpIHtcbiAgICBjb25zdCBhcHByb3ZhbCA9IGFsbC5maW5kKCh0KSA9PiB0LmFwcHJvdmFsKTtcbiAgICBjb25zdCBsYWJlbCA9IGFwcHJvdmFsXG4gICAgICA/IGBBcHByb3ZhbCBuZWVkZWQ6ICR7YXBwcm92YWwuYy5sYWJlbH1gXG4gICAgICA6IGF0dGVudGlvblRvdGFsID4gMFxuICAgICAgICA/IGAke2F0dGVudGlvblRvdGFsfSB0YXNrJHthdHRlbnRpb25Ub3RhbCA+IDEgPyBcInNcIiA6IFwiXCJ9IHdhaXRpbmcgZm9yIHlvdWBcbiAgICAgICAgOiBhY3RpdmVUb3RhbCA+IDBcbiAgICAgICAgICA/IGAke2FjdGl2ZVRvdGFsfSBhY3RpdmUgdGFzayR7YWN0aXZlVG90YWwgPiAxID8gXCJzXCIgOiBcIlwifWBcbiAgICAgICAgICA6IGAke3VucmVhZE1vYmlsZVJlc3VsdHN9IG5ldyBhZ2VudCByZXN1bHQke3VucmVhZE1vYmlsZVJlc3VsdHMgPiAxID8gXCJzXCIgOiBcIlwifWA7XG4gICAgJChcIm10Yi10ZXh0XCIpLnRleHRDb250ZW50ID0gbGFiZWw7XG4gIH1cbn1cblxuZnVuY3Rpb24gc2hvd1Rhc2tzKGZvcmNlID0gZmFsc2UpIHtcbiAgY29uc3QgcGFuZSA9ICQoXCJ0YXNrc1wiKTtcbiAgY29uc3QgZG9uZSA9ICQoXCJkb25lbm93XCIpO1xuICBjb25zdCBvcGVuID0gZG9jdW1lbnQuYWN0aXZlRWxlbWVudD8uY2xvc2VzdD8uKFwiLnRhc2tcIikgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAoIWZvcmNlICYmIG9wZW4gJiYgKHBhbmUuY29udGFpbnMob3BlbikgfHwgZG9uZS5jb250YWlucyhvcGVuKSkgJiYgb3Blbi5xdWVyeVNlbGVjdG9yKFwiZm9ybVwiKSkgcmV0dXJuOyAvLyBkb24ndCByZWRyYXcgdW5kZXIgc29tZW9uZSB0eXBpbmcgYSBmb2xsb3ctdXBcbiAgcGFuZS5pbm5lckhUTUwgPSBcIlwiO1xuICBkb25lLmlubmVySFRNTCA9IFwiXCI7XG4gIGNvbnN0IGFsbCA9IFsuLi50YXNrcy52YWx1ZXMoKV0ucmV2ZXJzZSgpO1xuICBpZiAoYWxsLmxlbmd0aCA9PT0gMCkge1xuICAgIHBhbmUuYXBwZW5kKG5vVGFza3MpO1xuICAgICQoXCJ0YXNrY291bnRcIikudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICQoXCJjYW5jZWxhbGxcIikuaGlkZGVuID0gdHJ1ZTtcbiAgICBzeW5jU2lkZUxheW91dCgpO1xuICAgIHVwZGF0ZVRhc2tDaHJvbWUoKTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgcnVubmluZyA9IGFsbC5maWx0ZXIoKHQpID0+IHQuYy5zdGF0ZSA9PT0gXCJydW5uaW5nXCIpLmxlbmd0aDtcbiAgY29uc3QgYWN0aXZlQ291bnQgPSBhbGwuZmlsdGVyKGlzQWN0aXZlVGFzaykubGVuZ3RoO1xuICAkKFwidGFza2NvdW50XCIpLnRleHRDb250ZW50ID0gcnVubmluZyA+IDAgPyBgJHtydW5uaW5nfSBydW5uaW5nYCA6IGFjdGl2ZUNvdW50ID4gMCA/IGAke2FjdGl2ZUNvdW50fSB3YWl0aW5nYCA6IFwiXCI7XG4gICQoXCJjYW5jZWxhbGxcIikuaGlkZGVuID0gIWNhbGxJZCB8fCBydW5uaW5nIDwgMjtcbiAgZm9yIChjb25zdCB2aWV3IG9mIGFsbCkge1xuICAgIGNvbnN0IHQgPSB2aWV3LmM7XG4gICAgY29uc3Qgd2FpdGluZyA9IHQuc3RhdGUuc3RhcnRzV2l0aChcIndhaXRpbmdcIik7XG4gICAgY29uc3QgY2FyZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgY2FyZC5jbGFzc05hbWUgPSBgdGFzayAke3dhaXRpbmcgPyBcIndhaXRpbmdcIiA6IHQuc3RhdGV9YDtcbiAgICBjb25zdCBhZ2UgPSAodmlldy5lbmRlZCA/PyBub3coKSkgLSB2aWV3LnNpbmNlO1xuICAgIGNhcmQuaW5uZXJIVE1MID1cbiAgICAgIGA8ZGl2IGNsYXNzPVwibWV0YS1yb3dcIj5gICtcbiAgICAgICAgYDxzcGFuIGNsYXNzPVwiYmFkZ2UgJHt0LmFnZW50ID09PSBcInQzXCIgPyBcInQzXCIgOiBcIlwifVwiPiR7dC5hZ2VudCA9PT0gXCJ0M1wiID8gXCJUM1wiIDogXCJIZXJtZXNcIn08L3NwYW4+YCArXG4gICAgICAgIGA8c3BhbiBjbGFzcz1cImxhYmVsXCI+PC9zcGFuPmAgK1xuICAgICAgICBgPHNwYW4gY2xhc3M9XCJzdGF0ZVwiPiR7dC5zdGF0ZSA9PT0gXCJydW5uaW5nXCIgPyAnPHNwYW4gY2xhc3M9XCJzcGluXCI+PC9zcGFuPicgOiBcIlwifSR7ZXNjYXBlSHRtbCh0LnN0YXRlKX08L3NwYW4+YCArXG4gICAgICAgIGA8c3BhbiBjbGFzcz1cImFnZVwiPiR7ZWxhcHNlZChhZ2UpfTwvc3Bhbj5gICtcbiAgICAgIGA8L2Rpdj5gICtcbiAgICAgIGA8ZGl2IGNsYXNzPVwicFwiPjwvZGl2PmA7XG4gICAgY29uc3QgbGFiZWxFbCA9IGNhcmQucXVlcnlTZWxlY3RvcihcIi5sYWJlbFwiKSBhcyBIVE1MRWxlbWVudDtcbiAgICBsYWJlbEVsLnRleHRDb250ZW50ID0gdC5sYWJlbDtcbiAgICBsYWJlbEVsLnRpdGxlID0gdC5sYWJlbDtcbiAgICBjYXJkLnF1ZXJ5U2VsZWN0b3IoXCIucFwiKSEudGV4dENvbnRlbnQgPSB0LnByb2dyZXNzID8/IHQucmVxdWVzdDtcbiAgICBpZiAodC5xdWVzdGlvbikge1xuICAgICAgY29uc3QgcSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICBxLmNsYXNzTmFtZSA9IFwicVwiO1xuICAgICAgcS50ZXh0Q29udGVudCA9IGBBc2tzOiAke3QucXVlc3Rpb259YDtcbiAgICAgIGNhcmQuYXBwZW5kKHEpO1xuICAgIH1cbiAgICBpZiAodmlldy5hcHByb3ZhbCAmJiB0LnN0YXRlID09PSBcInJ1bm5pbmdcIikge1xuICAgICAgY29uc3QgYm94ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgIGJveC5jbGFzc05hbWUgPSBcImFwcHJvdmFsXCI7XG4gICAgICBib3guaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9XCJhcHByb3ZhbC1oZWFkXCI+SGVybWVzIGFza3MgdG8gcnVuPC9kaXY+PGNvZGU+PC9jb2RlPjxkaXYgY2xhc3M9XCJhY3RzXCI+PC9kaXY+YDtcbiAgICAgIGJveC5xdWVyeVNlbGVjdG9yKFwiY29kZVwiKSEudGV4dENvbnRlbnQgPSB2aWV3LmFwcHJvdmFsLmNvbW1hbmQ7XG4gICAgICBjb25zdCBhbnN3ZXIgPSAoY2hvaWNlOiBcIm9uY2VcIiB8IFwiZGVueVwiKSA9PiB7XG4gICAgICAgIHZpZXcuYXBwcm92YWwgPSB1bmRlZmluZWQ7XG4gICAgICAgIHNob3dUYXNrcyh0cnVlKTtcbiAgICAgICAgdm9pZCBmZXRjaChcIi9oZXJtZXMvYXBwcm92YWxcIiwgeyBtZXRob2Q6IFwiUE9TVFwiLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGNhbGw6IGNhbGxOYW1lLCB0YXNrSWQ6IHQuaWQsIGNob2ljZSB9KSB9KVxuICAgICAgICAgIC50aGVuKChyKSA9PiB0b2FzdChyLm9rID8gKGNob2ljZSA9PT0gXCJvbmNlXCIgPyBcIkFwcHJvdmVkXCIgOiBcIkRlbmllZFwiKSA6IFwiVGhhdCBhcHByb3ZhbCBoYWQgYWxyZWFkeSBsYXBzZWRcIikpO1xuICAgICAgfTtcbiAgICAgIGZvciAoY29uc3QgW2xhYmVsLCBjaG9pY2VdIG9mIFtbXCJBcHByb3ZlIG9uY2VcIiwgXCJvbmNlXCJdLCBbXCJEZW55XCIsIFwiZGVueVwiXV0gYXMgY29uc3QpIHtcbiAgICAgICAgY29uc3QgYiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gICAgICAgIGIudHlwZSA9IFwiYnV0dG9uXCI7XG4gICAgICAgIGIudGV4dENvbnRlbnQgPSBsYWJlbDtcbiAgICAgICAgaWYgKGNob2ljZSA9PT0gXCJvbmNlXCIpIGIuY2xhc3NOYW1lID0gXCJnb1wiO1xuICAgICAgICBlbHNlIGIuY2xhc3NOYW1lID0gXCJkYW5nZXJcIjtcbiAgICAgICAgYi5vbmNsaWNrID0gKCkgPT4gYW5zd2VyKGNob2ljZSk7XG4gICAgICAgIGJveC5xdWVyeVNlbGVjdG9yKFwiLmFjdHNcIikhLmFwcGVuZChiKTtcbiAgICAgIH1cbiAgICAgIGNhcmQuYXBwZW5kKGJveCk7XG4gICAgfVxuICAgIGlmICh0LnN0YXRlICE9PSBcInJ1bm5pbmdcIikgdmlldy5hcHByb3ZhbCA9IHVuZGVmaW5lZDtcbiAgICBjb25zdCBhY3RzID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBhY3RzLmNsYXNzTmFtZSA9IFwiYWN0c1wiO1xuICAgIGNvbnN0IGJ1dHRvbiA9ICh0ZXh0OiBzdHJpbmcsIGZuOiAoKSA9PiB2b2lkLCBjbHMgPSBcIlwiKSA9PiB7XG4gICAgICBjb25zdCBiID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgICAgIGIudHlwZSA9IFwiYnV0dG9uXCI7XG4gICAgICBiLnRleHRDb250ZW50ID0gdGV4dDtcbiAgICAgIGlmIChjbHMpIGIuY2xhc3NOYW1lID0gY2xzO1xuICAgICAgYi5vbmNsaWNrID0gZm47XG4gICAgICBhY3RzLmFwcGVuZChiKTtcbiAgICAgIHJldHVybiBiO1xuICAgIH07XG4gICAgaWYgKGNhbGxJZCAmJiBhY3RpdmVTZXNzaW9uID4gMCkge1xuICAgICAgY29uc3Qgb3JpZ2luU2Vzc2lvbiA9IGFjdGl2ZVNlc3Npb247XG4gICAgICBidXR0b24od2FpdGluZyA/IFwiQW5zd2VyXCIgOiBcIkZvbGxvdyB1cFwiLCAoKSA9PiBmb2xsb3dVcEZvcm0oY2FyZCwgdCwgb3JpZ2luU2Vzc2lvbikpO1xuICAgICAgaWYgKHQuc3RhdGUgPT09IFwicnVubmluZ1wiKSBidXR0b24oXCJDYW5jZWxcIiwgKCkgPT4gcHVzaCh7IHR5cGU6IFwiY2FuY2VsVGFza1wiLCB0YXNrOiB0LmlkIH0pLCBcImRhbmdlclwiKTtcbiAgICB9XG4gICAgaWYgKHZpZXcucmVzdWx0SWQpIGJ1dHRvbihcIlJlc3VsdFwiLCAoKSA9PiBmb2N1c1Jlc3VsdCh2aWV3LnJlc3VsdElkISkpO1xuICAgIGlmICh2aWV3LnRocmVhZCkgYnV0dG9uKFwiQ29weSBpZFwiLCAoKSA9PiB7IHZvaWQgbmF2aWdhdG9yLmNsaXBib2FyZD8ud3JpdGVUZXh0KHZpZXcudGhyZWFkISk7IHRvYXN0KFwiVGhyZWFkIGlkIGNvcGllZFwiKTsgfSk7XG4gICAgaWYgKGFjdHMuY2hpbGRFbGVtZW50Q291bnQpIGNhcmQuYXBwZW5kKGFjdHMpO1xuICAgIChpc0FjdGl2ZVRhc2sodmlldykgPyBwYW5lIDogZG9uZSkuYXBwZW5kKGNhcmQpO1xuICB9XG4gIGlmIChwYW5lLmNoaWxkRWxlbWVudENvdW50ID09PSAwKSBwYW5lLmFwcGVuZChub1Rhc2tzKTtcbiAgc3luY1NpZGVMYXlvdXQoKTtcbiAgdXBkYXRlVGFza0Nocm9tZSgpO1xufVxuXG5mdW5jdGlvbiBmb2xsb3dVcEZvcm0oY2FyZDogSFRNTEVsZW1lbnQsIHQ6IENvbW1hbmQsIG9yaWdpblNlc3Npb246IG51bWJlcikge1xuICBjb25zdCBleGlzdGluZyA9IGNhcmQucXVlcnlTZWxlY3RvcihcImZvcm1cIik7XG4gIGlmIChleGlzdGluZykgeyBleGlzdGluZy5xdWVyeVNlbGVjdG9yKFwiaW5wdXRcIik/LmZvY3VzKCk7IHJldHVybjsgfVxuICBjb25zdCBmb3JtID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImZvcm1cIik7XG4gIGZvcm0uY2xhc3NOYW1lID0gXCJmb2xsb3d1cC1mb3JtXCI7XG4gIGZvcm0uaW5uZXJIVE1MID0gYDxpbnB1dCB0eXBlPVwidGV4dFwiIHBsYWNlaG9sZGVyPVwiVGVsbCBcdTIwMUMke2VzY2FwZUh0bWwodC5sYWJlbCl9XHUyMDFEXHUyMDI2XCIgZW50ZXJrZXloaW50PVwic2VuZFwiPjxidXR0b24gdHlwZT1cInN1Ym1pdFwiPlNlbmQ8L2J1dHRvbj5gO1xuICBjb25zdCBpbnB1dCA9IGZvcm0ucXVlcnlTZWxlY3RvcihcImlucHV0XCIpITtcbiAgZm9ybS5vbnN1Ym1pdCA9IChlKSA9PiB7XG4gICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGNvbnN0IHRleHQgPSBpbnB1dC52YWx1ZS50cmltKCk7XG4gICAgaWYgKHRleHQpIHtcbiAgICAgIGlmICghY2FuRm9sbG93VXBSZXN1bHQob3JpZ2luU2Vzc2lvbiwgYWN0aXZlU2Vzc2lvbiwgdGFza3MuaGFzKHQuaWQpKSkge1xuICAgICAgICB0b2FzdChcIlRoYXQgdGFzaydzIGNhbGwgaGFzIGVuZGVkXCIpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcHVzaCh7IHR5cGU6IFwic3RlZXJcIiwgdGFzazogdC5pZCwgdGV4dCB9KTtcbiAgICAgICAgbm90ZShgWW91IFx1MjE5MiAke3QubGFiZWx9OiAke3RleHR9YCk7XG4gICAgICAgIHNjcm9sbERvd24odHJ1ZSk7XG4gICAgICB9XG4gICAgfVxuICAgIGlucHV0LmJsdXIoKTtcbiAgICBmb3JtLnJlbW92ZSgpO1xuICAgIHNob3dUYXNrcygpO1xuICB9O1xuICBpbnB1dC5vbmtleWRvd24gPSAoZSkgPT4geyBpZiAoZS5rZXkgPT09IFwiRXNjYXBlXCIpIHsgZS5zdG9wUHJvcGFnYXRpb24oKTsgaW5wdXQuYmx1cigpOyBmb3JtLnJlbW92ZSgpOyBzaG93VGFza3MoKTsgfSB9O1xuICBjYXJkLmFwcGVuZChmb3JtKTtcbiAgaW5wdXQuZm9jdXMoKTtcbn1cblxuLyoqIFQzIHRocmVhZHMgZWFybGllciBjYWxscyBzdGFydGVkOiB0aGV5IGNhcnJ5IG9uIGFmdGVyIGEgY2FsbCwgc28gdGhlIHBhbmVsIHNheXMgaG93IHRoZXkncmUgZG9pbmcuICovXG5hc3luYyBmdW5jdGlvbiBzaG93RWFybGllcigpIHtcbiAgbGV0IGxpc3Q6IHsgdGhyZWFkOiBzdHJpbmc7IHRpdGxlOiBzdHJpbmc7IHN0YXR1czogc3RyaW5nOyBicmFuY2g6IHN0cmluZyB8IG51bGw7IHByOiBzdHJpbmcgfCBudWxsOyB1cGRhdGVkOiBzdHJpbmc7IGxhc3Q6IHN0cmluZzsgd2FpdGluZzogYm9vbGVhbiB9W10gPSBbXTtcbiAgdHJ5IHsgbGlzdCA9IGF3YWl0IChhd2FpdCBmZXRjaChcIi9hZ2VudC9yZWNlbnRcIiwgeyBjYWNoZTogXCJuby1zdG9yZVwiIH0pKS5qc29uKCk7IH0gY2F0Y2gge31cbiAgY29uc3QgY3VycmVudCA9IG5ldyBTZXQoWy4uLnRhc2tzLnZhbHVlcygpXS5tYXAoKHYpID0+IHYudGhyZWFkKS5maWx0ZXIoQm9vbGVhbikpO1xuICBsaXN0ID0gbGlzdC5maWx0ZXIoKHQpID0+ICFjdXJyZW50Lmhhcyh0LnRocmVhZCkpO1xuICBjb25zdCBwYW5lID0gJChcImVhcmxpZXJcIik7XG4gIGNvbnN0IGRvbmUgPSAkKFwiZG9uZWVhcmxpZXJcIik7XG4gIHBhbmUuaW5uZXJIVE1MID0gXCJcIjtcbiAgZG9uZS5pbm5lckhUTUwgPSBcIlwiO1xuICBlYXJsaWVyQWN0aXZlQ291bnQgPSAwO1xuICBlYXJsaWVyV2FpdGluZ0NvdW50ID0gMDtcbiAgZm9yIChjb25zdCB0IG9mIGxpc3QpIHtcbiAgICBjb25zdCBjYXJkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBjb25zdCBzdGF0ZSA9IHQud2FpdGluZyA/IFwid2FpdGluZyBmb3IgYXBwcm92YWwgaW4gVDNcIiA6IHQuc3RhdHVzO1xuICAgIGNhcmQuY2xhc3NOYW1lID0gYHRhc2sgJHt0LnN0YXR1cyA9PT0gXCJydW5uaW5nXCIgPyBcInJ1bm5pbmdcIiA6IHQud2FpdGluZyA/IFwid2FpdGluZ1wiIDogXCJmaW5pc2hlZFwifWA7XG4gICAgY29uc3QgYWdvID0gTWF0aC5tYXgoMCwgKERhdGUubm93KCkgLSBEYXRlLnBhcnNlKHQudXBkYXRlZCkpIC8gMTAwMCk7XG4gICAgY2FyZC5pbm5lckhUTUwgPVxuICAgICAgYDxkaXYgY2xhc3M9XCJtZXRhLXJvd1wiPmAgK1xuICAgICAgICBgPHNwYW4gY2xhc3M9XCJiYWRnZSB0M1wiPlQzPC9zcGFuPmAgK1xuICAgICAgICBgPHNwYW4gY2xhc3M9XCJsYWJlbFwiPjwvc3Bhbj5gICtcbiAgICAgICAgYDxzcGFuIGNsYXNzPVwic3RhdGVcIj4ke3Quc3RhdHVzID09PSBcInJ1bm5pbmdcIiA/ICc8c3BhbiBjbGFzcz1cInNwaW5cIj48L3NwYW4+JyA6IFwiXCJ9JHtlc2NhcGVIdG1sKHN0YXRlKX08L3NwYW4+YCArXG4gICAgICAgIGA8c3BhbiBjbGFzcz1cImFnZVwiPiR7ZWxhcHNlZChhZ28pfSBhZ288L3NwYW4+YCArXG4gICAgICBgPC9kaXY+YCArXG4gICAgICBgPGRpdiBjbGFzcz1cInBcIj48L2Rpdj5gO1xuICAgIGNvbnN0IGxhYmVsRWwgPSBjYXJkLnF1ZXJ5U2VsZWN0b3IoXCIubGFiZWxcIikgYXMgSFRNTEVsZW1lbnQ7XG4gICAgbGFiZWxFbC50ZXh0Q29udGVudCA9IHQudGl0bGU7XG4gICAgbGFiZWxFbC50aXRsZSA9IHQudGl0bGU7XG4gICAgY2FyZC5xdWVyeVNlbGVjdG9yKFwiLnBcIikhLnRleHRDb250ZW50ID0gdC5sYXN0IHx8ICh0LmJyYW5jaCA/IGBPbiAke3QuYnJhbmNofWAgOiBcIlwiKTtcbiAgICBjb25zdCBhY3RzID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBhY3RzLmNsYXNzTmFtZSA9IFwiYWN0c1wiO1xuICAgIGlmICh0LnByKSB7IGNvbnN0IGEgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYVwiKTsgYS5ocmVmID0gdC5wcjsgYS50YXJnZXQgPSBcIl9ibGFua1wiOyBhLnJlbCA9IFwibm9vcGVuZXJcIjsgYS50ZXh0Q29udGVudCA9IFwiUFIgXHUyMTk3XCI7IGFjdHMuYXBwZW5kKGEpOyB9XG4gICAgY29uc3QgY29weSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gICAgY29weS50eXBlID0gXCJidXR0b25cIjtcbiAgICBjb3B5LnRleHRDb250ZW50ID0gXCJDb3B5IGlkXCI7XG4gICAgY29weS5vbmNsaWNrID0gKCkgPT4geyB2b2lkIG5hdmlnYXRvci5jbGlwYm9hcmQ/LndyaXRlVGV4dCh0LnRocmVhZCk7IHRvYXN0KFwiVGhyZWFkIGlkIGNvcGllZFwiKTsgfTtcbiAgICBhY3RzLmFwcGVuZChjb3B5KTtcbiAgICBjYXJkLmFwcGVuZChhY3RzKTtcbiAgICBjb25zdCBhY3RpdmUgPSB0LnN0YXR1cyA9PT0gXCJydW5uaW5nXCIgfHwgdC53YWl0aW5nO1xuICAgIGlmIChhY3RpdmUpIGVhcmxpZXJBY3RpdmVDb3VudCsrO1xuICAgIGlmICh0LndhaXRpbmcpIGVhcmxpZXJXYWl0aW5nQ291bnQrKztcbiAgICAoYWN0aXZlID8gcGFuZSA6IGRvbmUpLmFwcGVuZChjYXJkKTtcbiAgfVxuICBzeW5jU2lkZUxheW91dCgpO1xuICB1cGRhdGVUYXNrQ2hyb21lKCk7XG59XG5cbmNvbnN0IFNUQVRVU19URVhUOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICBpZGxlOiBcIklkbGVcIiwgY29ubmVjdGluZzogXCJDb25uZWN0aW5nXHUyMDI2XCIsIGxpc3RlbmluZzogXCJMaXN0ZW5pbmdcIiwgd29ya2luZzogXCJMaXN0ZW5pbmcgXHUwMEI3IHRhc2tzIHJ1bm5pbmdcIixcbiAgZG9ybWFudDogXCJEb3JtYW50IFx1MDBCNyB3YWl0aW5nIGZvciB3YWtlIHdvcmRcIixcbiAgc3RhbmRieTogXCJQYXVzZWQgd2hpbGUgdGFza3MgcnVuIFx1MDBCNyBzcGVhayB0byByZXN1bWVcIiwgd2FraW5nOiBcIlJlc3VtaW5nXHUyMDI2XCIsIGVuZGVkOiBcIkVuZGVkXCIsXG59O1xuXG5mdW5jdGlvbiBzaG93U3RhdHVzKG1lc3NhZ2U/OiBzdHJpbmcpIHtcbiAgY29uc3QgdHlwZWQgPSBCb29sZWFuKGNhbGxJZCkgJiYgbWVkaXVtID09PSBcInRleHRcIjtcbiAgY29uc3Qgc3BlYWtpbmcgPSBCb29sZWFuKGNhbGxJZCkgJiYgIXR5cGVkICYmIGNvcmVTdGF0dXMgIT09IFwic3RhbmRieVwiICYmIGNvcmVTdGF0dXMgIT09IFwiZG9ybWFudFwiICYmIGF1ZGlvLnF1ZXVlZCA+IDAuMDU7XG4gIGNvbnN0IGFybWVkSWRsZSA9ICFjYWxsSWQgJiYgd2FrZUFybWVkO1xuICBjb25zdCBzaG93biA9IGNhbGxJZFxuICAgID8gKHNwZWFraW5nIHx8ICh0eXBlZCAmJiB0aGlua2luZykgPyBcInNwZWFraW5nXCIgOiBjb3JlU3RhdHVzKVxuICAgIDogYXJtZWRJZGxlID8gXCJhcm1lZFwiIDogY29yZVN0YXR1cztcbiAgJChcInN0YXR1c1wiKS5jbGFzc05hbWUgPSBzaG93bjtcbiAgZG9jdW1lbnQuYm9keS5kYXRhc2V0LnN0YXRlID0gY2FsbElkID8gc2hvd24gOiBhcm1lZElkbGUgPyBcImFybWVkXCIgOiBcImlkbGVcIjtcbiAgZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QudG9nZ2xlKFwiaW4tc2Vzc2lvblwiLCBCb29sZWFuKGNhbGxJZCkpO1xuICBjb25zdCB3YWtlTGFiZWwgPSBzZWxlY3RlZFdha2VNb2RlbCgpPy5sYWJlbCA/PyBcIndha2Ugd29yZFwiO1xuICBsZXQgdGV4dCA9IGFybWVkSWRsZVxuICAgID8gKHdha2VMb2FkaW5nID8gYExvYWRpbmcgXHUyMDFDJHt3YWtlTGFiZWx9XHUyMDFEXHUyMDI2YFxuICAgICAgOiBhdWRpby5hdWRpb1N1c3BlbmRlZCA/IGBUYXAgYW55d2hlcmUgdG8gYWN0aXZhdGUgXHUyMDFDJHt3YWtlTGFiZWx9XHUyMDFEYFxuICAgICAgOiBgV2FpdGluZyBmb3IgXHUyMDFDJHt3YWtlTGFiZWx9XHUyMDFEYClcbiAgICA6IHNwZWFraW5nID8gXCJTcGVha2luZ1wiXG4gICAgOiBjb3JlU3RhdHVzID09PSBcImRvcm1hbnRcIiA/IGBEb3JtYW50IFx1MDBCNyBzYXkgXHUyMDFDJHt3YWtlTGFiZWx9XHUyMDFEYFxuICAgIDogU1RBVFVTX1RFWFRbY29yZVN0YXR1c10gPz8gY29yZVN0YXR1cztcbiAgaWYgKHR5cGVkICYmIGNvcmVTdGF0dXMgIT09IFwiZW5kZWRcIikgdGV4dCA9IHRoaW5raW5nID8gXCJXcml0aW5nXHUyMDI2XCIgOiBjb3JlU3RhdHVzID09PSBcIndvcmtpbmdcIiA/IFwiQ2hhdCBcdTAwQjcgdGFza3MgcnVubmluZ1wiIDogXCJDaGF0XCI7XG4gIGlmIChjYWxsSWQgJiYgIXR5cGVkICYmIG11dGVkICYmICFob2xkaW5nICYmICFzcGVha2luZykgdGV4dCArPSBcIiBcdTAwQjcgbXV0ZWRcIjtcbiAgaWYgKGhvbGRpbmcpIHRleHQgPSBcIlRhbGtpbmcgKGhvbGQpXCI7XG4gIGlmIChtZXNzYWdlKSB0ZXh0ID0gYCR7dGV4dH06ICR7bWVzc2FnZX1gO1xuICBpZiAoY29yZVN0YXR1cyAhPT0gXCJlbmRlZFwiIHx8IG1lc3NhZ2UgfHwgYXJtZWRJZGxlKSAkKFwic3RhdHVzdGV4dFwiKS50ZXh0Q29udGVudCA9IHRleHQ7XG4gICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiaHVzaFwiKS5jbGFzc0xpc3QudG9nZ2xlKFwibGl2ZVwiLCBzcGVha2luZyB8fCAodHlwZWQgJiYgdGhpbmtpbmcpKTtcblxuICBjb25zdCBiYXIgPSAkKFwiY2FsbGJhclwiKTtcbiAgYmFyLmhpZGRlbiA9ICFjYWxsSWQ7XG4gICQoXCJ3YWtlLW5vd1wiKS5oaWRkZW4gPSAhKGNhbGxJZCAmJiAhdHlwZWQgJiYgKGNvcmVTdGF0dXMgPT09IFwiZG9ybWFudFwiIHx8IGNvcmVTdGF0dXMgPT09IFwic3RhbmRieVwiKSk7XG4gIGlmIChjYWxsSWQpIHtcbiAgICAkKFwiY2FsbGJhci1zdGF0ZVwiKS50ZXh0Q29udGVudCA9IHRleHQ7XG4gICAgJChcImNhbGx0aW1lclwiKS5oaWRkZW4gPSB0eXBlZDtcbiAgICBpZiAoIXR5cGVkKSAkKFwiY2FsbHRpbWVyXCIpLnRleHRDb250ZW50ID0gZm9ybWF0Q2xvY2sobm93KCkgLSBzdGFydGVkQXQpO1xuICAgIGNvbnN0IHZpek1vZGUgPSB0eXBlZCA/ICh0aGlua2luZyA/IFwidGhpbmtpbmdcIiA6IFwiaWRsZVwiKVxuICAgICAgOiBzcGVha2luZyA/IFwic3BlYWtpbmdcIlxuICAgICAgOiBtdXRlZCAmJiAhaG9sZGluZyA/IFwibXV0ZWRcIlxuICAgICAgOiBzaG93bjtcbiAgICB1cGRhdGVWaXN1YWxpemVyKHZpek1vZGUsIG11dGVkICYmICFob2xkaW5nID8gMCA6IGF1ZGlvLmxldmVsKTtcbiAgfVxufVxuXG4vLyBUaGUgY2FsbC5cblxuZnVuY3Rpb24gcHVzaChldmVudDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sIHQgPSBub3coKSk6IENvbW1hbmRbXSB7XG4gIGlmICghY29yZSB8fCAhY2FsbElkKSByZXR1cm4gW107XG4gIC8vIEZsdXNoIGRlZmVycmVkIHVuc3VwcHJlc3NlZCBnYXAgZnJhbWVzIGJlZm9yZSBhbnkgZXZlbnQgdGhhdCBjYW4gc3RhcnQgbmV3IHBsYXliYWNrXG4gIC8vIChhZHZhbmNpbmcgcmVwbGF5Rmxvb3JTZXEgd2l0aG91dCByZXNldHRpbmcgd2FrZUNsaWVudCwgc28gYSB2YWxpZCB3YWtlIGhpdCBzdGlsbCBsYW5kcykuXG4gIGNvbnN0IGZsdXNoZWQgPSB3YWtlR2F0ZS5iZWZvcmVQdXNoKGV2ZW50LCB0KTtcbiAgaWYgKG1lZGl1bSA9PT0gXCJ2b2ljZVwiKSB7XG4gICAgZm9yIChjb25zdCBpdGVtIG9mIGZsdXNoZWQpIHtcbiAgICAgIGlmICghY2FsbElkKSBicmVhaztcbiAgICAgIGNvdW50cy5taWMrKztcbiAgICAgIHB1c2goeyB0eXBlOiBcIm1pY1wiLCBwY206IGl0ZW0ucGNtIH0sIGl0ZW0udCk7XG4gICAgfVxuICB9XG4gIGNvbnN0IGU6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0geyAuLi5ldmVudCwgdCB9O1xuICBjb25zdCBxdWlldCA9IGUudHlwZSA9PT0gXCJtaWNcIiB8fCBlLnR5cGUgPT09IFwidGlja1wiO1xuICBpZiAoIXF1aWV0KSBsb2coXCJpblwiLCBlLnR5cGUgPT09IFwid3MubWVzc2FnZVwiID8gYHdzICR7ZS5zaWR9IFx1MjE5MCAke2JyaWVmKFN0cmluZyhlLmRhdGEpKX1gIDogSlNPTi5zdHJpbmdpZnkoZSkuc2xpY2UoMCwgNDAwKSwgXCJpblwiKTtcbiAgY29uc3QgY29tbWFuZHMgPSBKU09OLnBhcnNlKGNvcmUucHVzaChjYWxsSWQsIEpTT04uc3RyaW5naWZ5KGUpKSkgYXMgQ29tbWFuZFtdO1xuICBydW4oY29tbWFuZHMsIHQsIHR5cGVvZiBldmVudC50eXBlID09PSBcInN0cmluZ1wiID8gZXZlbnQudHlwZSA6IHVuZGVmaW5lZCk7XG4gIHJldHVybiBjb21tYW5kcztcbn1cblxuZnVuY3Rpb24gcnVuKGNvbW1hbmRzOiBDb21tYW5kW10sIGV2ZW50VGltZSA9IG5vdygpLCBldmVudFR5cGU/OiBzdHJpbmcpIHtcbiAgd2FrZUdhdGUub2JzZXJ2ZUNvbW1hbmRzKGNvbW1hbmRzLCBldmVudFRpbWUsIGV2ZW50VHlwZSk7XG4gIGZvciAoY29uc3QgYyBvZiBjb21tYW5kcykge1xuICAgIHN3aXRjaCAoYy50eXBlKSB7XG4gICAgICBjYXNlIFwid3MuY29ubmVjdFwiOiBjb25uZWN0KGMuc2lkLCBjLnB1cnBvc2UgPT09IFwiY2FwdGlvbnNcIik7IGJyZWFrO1xuICAgICAgY2FzZSBcIndzLnNlbmRcIjoge1xuICAgICAgICBzb2NrZXRzLmdldChjLnNpZCk/LnNlbmQoYy5kYXRhKTtcbiAgICAgICAgaWYgKCFjLmRhdGEuc3RhcnRzV2l0aCgne1wicmVhbHRpbWVJbnB1dFwiOntcImF1ZGlvXCInKSkgbG9nKFwib3V0XCIsIGB3cyAke2Muc2lkfSBcdTIxOTIgJHticmllZihjLmRhdGEpfWAsIFwib3V0XCIpO1xuICAgICAgICBlbHNlIGlmICghY2FwdGlvblNvY2tldHMuaGFzKGMuc2lkKSkgY291bnRzLnNlbnQrKztcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwid3MuY2xvc2VcIjogc29ja2V0cy5nZXQoYy5zaWQpPy5jbG9zZSgpOyBzb2NrZXRzLmRlbGV0ZShjLnNpZCk7IGxvZyhcIm91dFwiLCBgd3MgJHtjLnNpZH0gY2xvc2VgLCBcIm91dFwiKTsgYnJlYWs7XG4gICAgICBjYXNlIFwibWljLnN0YXJ0XCI6IHtcbiAgICAgICAgbG9nKFwib3V0XCIsIGMudHlwZSwgXCJvdXRcIik7XG4gICAgICAgIGNvbnN0IHBlbmRpbmdPcGVuaW5nID0gd2FrZVN0YXJ0aW5nID8gb3BlbmluZ0NodW5rcy5zcGxpY2UoMCkgOiBbXTtcbiAgICAgICAgb3BlbmluZ0J5dGVzID0gMDtcbiAgICAgICAgd2FrZVN0YXJ0aW5nID0gZmFsc2U7XG4gICAgICAgIHZvaWQgYXVkaW8uZW5zdXJlTWljKG9uTWljLCBtaWNPcHRpb25zKCkpLmNhdGNoKChlcnIpID0+IHsgbG9nKFwiZXJyb3JcIiwgYG1pY3JvcGhvbmU6ICR7ZXJyLm1lc3NhZ2V9YCwgXCJlcnJcIik7IHRvYXN0KGBNaWNyb3Bob25lOiAke2Vyci5tZXNzYWdlfWApOyB9KTtcbiAgICAgICAgaWYgKHBlbmRpbmdPcGVuaW5nLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICBjb25zdCB0b3RhbE1zID0gTWF0aC5yb3VuZChwZW5kaW5nT3BlbmluZy5yZWR1Y2UoKHMsIGIpID0+IHMgKyBiLmJ5dGVMZW5ndGgsIDApIC8gMzIpO1xuICAgICAgICAgIGxvZyhcIm91dFwiLCBgZmx1c2hpbmcgJHt0b3RhbE1zfSBtcyBzcG9rZW4gYWZ0ZXIgd2FrZSB3b3JkYCwgXCJvdXRcIik7XG4gICAgICAgICAgcXVldWVNaWNyb3Rhc2soKCkgPT4ge1xuICAgICAgICAgICAgaWYgKCFjYWxsSWQpIHJldHVybjtcbiAgICAgICAgICAgIGZvciAoY29uc3QgY2h1bmsgb2YgcGVuZGluZ09wZW5pbmcpIHtcbiAgICAgICAgICAgICAgaWYgKCFjYWxsSWQpIGJyZWFrO1xuICAgICAgICAgICAgICBjb3VudHMubWljKys7XG4gICAgICAgICAgICAgIHB1c2goeyB0eXBlOiBcIm1pY1wiLCBwY206IGJ5dGVzVG9CYXNlNjQoY2h1bmspIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcIm1pYy5yZXN0YXJ0XCI6XG4gICAgICAgIGxvZyhcIm91dFwiLCBjLnR5cGUsIFwib3V0XCIpO1xuICAgICAgICB2b2lkIGF1ZGlvLnN0YXJ0TWljKG9uTWljLCBtaWNPcHRpb25zKCkpLmNhdGNoKChlcnIpID0+IHsgbG9nKFwiZXJyb3JcIiwgYG1pY3JvcGhvbmU6ICR7ZXJyLm1lc3NhZ2V9YCwgXCJlcnJcIik7IHRvYXN0KGBNaWNyb3Bob25lOiAke2Vyci5tZXNzYWdlfWApOyB9KTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwibWljLnN0b3BcIjpcbiAgICAgICAgaWYgKCF3YWtlQXJtZWQpIGF1ZGlvLnN0b3BNaWMoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwicGxheVwiOiB7XG4gICAgICAgIGNvbnN0IHQgPSBub3coKTtcbiAgICAgICAgLy8gQSByZXBseSBzdGFydGluZzogZnJvbSB0aGUgZW5kIG9mIHRoZSB1c2VyJ3Mgc3BlZWNoIHRvIGl0cyBmaXJzdCBzb3VuZC5cbiAgICAgICAgaWYgKCFtZXRyaWNzLnJlcGxpZWQgJiYgYXVkaW8ucXVldWVkIDwgMC4wNSAmJiB0IC0gbWV0cmljcy5sYXN0UGxheSA+IDAuNiAmJiBtZXRyaWNzLmxhc3RWb2ljZSA+IDAgJiYgdCAtIG1ldHJpY3MubGFzdFZvaWNlIDwgMTApIHtcbiAgICAgICAgICBtZXRyaWNzLnJlcGx5LnB1c2godCAtIG1ldHJpY3MubGFzdFZvaWNlKTtcbiAgICAgICAgICBpZiAobWV0cmljcy5yZXBseS5sZW5ndGggPiAyMCkgbWV0cmljcy5yZXBseS5zaGlmdCgpO1xuICAgICAgICAgIG1ldHJpY3MucmVwbGllZCA9IHRydWU7XG4gICAgICAgICAgc2hvd01ldHJpY3MoKTtcbiAgICAgICAgfVxuICAgICAgICBtZXRyaWNzLmxhc3RQbGF5ID0gdDtcbiAgICAgICAgYXVkaW8ucGxheShjLnBjbSk7XG4gICAgICAgIGNvdW50cy5wbGF5Kys7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcImZsdXNoXCI6XG4gICAgICAgIGF1ZGlvLmZsdXNoKCk7XG4gICAgICAgIGxvZyhcIm91dFwiLCBcImZsdXNoXCIsIFwib3V0XCIpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJjdWVcIjpcbiAgICAgICAgYXVkaW8uY3VlKGMucGNtKTtcbiAgICAgICAgbG9nKFwib3V0XCIsIGBjdWUgJHtjLmVhcmNvbn1gLCBcIm91dFwiKTtcbiAgICAgICAgLy8gQSByZXF1ZXN0IHRoYXQgYmVjYW1lIGEgdGFzayBnZXRzIGEgdG9uZSwgbm90IGEgc3Bva2VuIHJlcGx5OiBub3RoaW5nIHRvIHRpbWUuXG4gICAgICAgIGlmIChjLmVhcmNvbiA9PT0gXCJ0YXNrU3RhcnRlZFwiKSBtZXRyaWNzLnJlcGxpZWQgPSB0cnVlO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJ3YWtld29yZFwiOiBlbnN1cmVDb3JlV2FrZShCb29sZWFuKGMub24pKTsgYnJlYWs7XG4gICAgICBjYXNlIFwidG9vbC5jYWxsXCI6IHZvaWQgdG9vbChjKTsgYnJlYWs7XG4gICAgICBjYXNlIFwidG9vbC5jYW5jZWxcIjogY2FuY2VsUnVuKGMucnVuLCBjLnJlYXNvbik7IGJyZWFrO1xuICAgICAgY2FzZSBcInRvb2wuc3RlZXJcIjogdm9pZCBzdGVlclJ1bihjKTsgYnJlYWs7XG4gICAgICBjYXNlIFwic3RhdHVzXCI6IHtcbiAgICAgICAgY29uc3QgcHJldiA9IGNvcmVTdGF0dXM7XG4gICAgICAgIGNvcmVTdGF0dXMgPSBjLnN0YXR1cztcbiAgICAgICAgaWYgKGMuc3RhdHVzID09PSBcImRvcm1hbnRcIiAmJiBwcmV2ICE9PSBcImRvcm1hbnRcIiAmJiBjaGVja2VkKFwid2FrZS1jdWVcIikpIGF1ZGlvLmN1ZShTTEVFUF9UT05FKTtcbiAgICAgICAgc2hvd1N0YXR1cyhjLnN0YXR1cyA9PT0gXCJlbmRlZFwiID8gYy5tZXNzYWdlID8/IHVuZGVmaW5lZCA6IHVuZGVmaW5lZCk7XG4gICAgICAgIGxvZyhcInN0YXR1c1wiLCBjLnN0YXR1cyArIChjLm1lc3NhZ2UgPyBgOiAke2MubWVzc2FnZX1gIDogXCJcIiksIFwic3RhdHVzXCIpO1xuICAgICAgICBpZiAoYy5zdGF0dXMgPT09IFwiZW5kZWRcIikgeyBpZiAoYy5tZXNzYWdlKSBub3RlKGMubWVzc2FnZSk7IGVuZCgpOyB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcImxsbS5yZXF1ZXN0XCI6IHZvaWQgZ2VuZXJhdGUoYy5pZCwgYy5ib2R5KTsgYnJlYWs7XG4gICAgICBjYXNlIFwibGxtLmNhbmNlbFwiOiByZXF1ZXN0cy5nZXQoYy5pZCk/LmFib3J0KCk7IHJlcXVlc3RzLmRlbGV0ZShjLmlkKTsgbG9nKFwib3V0XCIsIGByZXF1ZXN0ICR7Yy5pZH0gZHJvcHBlZGAsIFwib3V0XCIpOyBicmVhaztcbiAgICAgIGNhc2UgXCJ0aGlua2luZ1wiOiB0aGlua2luZyA9IGMub247IHNob3dTdGF0dXMoKTsgYnJlYWs7XG4gICAgICBjYXNlIFwiZXJyb3JcIjogbm90ZShjLm1lc3NhZ2UpOyBsb2coXCJlcnJvclwiLCBjLm1lc3NhZ2UsIFwiZXJyXCIpOyBicmVhaztcbiAgICAgIGNhc2UgXCJjYXB0aW9uXCI6IGNhcHRpb24oYy50ZXh0KTsgYnJlYWs7XG4gICAgICBjYXNlIFwidHJhbnNjcmlwdFwiOlxuICAgICAgICB0cmFuc2NyaXB0KGMucm9sZSwgYy50ZXh0LCBjLmxpbmUpO1xuICAgICAgICByZW1lbWJlcihjLnJvbGUsIGMudGV4dCwgYy5yb2xlID09PSBcImFzc2lzdGFudFwiID8gXCJHZW1pbmlcIiA6IHVuZGVmaW5lZCwgbGFzdExpbmUgPT09IGMubGluZSk7XG4gICAgICAgIGxhc3RMaW5lID0gYy5saW5lO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJ0YXNrXCI6IHtcbiAgICAgICAgY29uc3QgdmlldyA9IHRhc2tzLmdldChjLmlkKSA/PyB7IGMsIHNpbmNlOiBub3coKSwgZW5kZWQ6IG51bGwgfTtcbiAgICAgICAgaWYgKGMuc3RhdGUgPT09IFwicnVubmluZ1wiICYmIHZpZXcuYy5zdGF0ZSAhPT0gXCJydW5uaW5nXCIpIHsgdmlldy5zaW5jZSA9IG5vdygpOyB2aWV3LmVuZGVkID0gbnVsbDsgfVxuICAgICAgICBpZiAoYy5zdGF0ZSAhPT0gXCJydW5uaW5nXCIgJiYgdmlldy5lbmRlZCA9PSBudWxsKSB2aWV3LmVuZGVkID0gbm93KCk7XG4gICAgICAgIHZpZXcuYyA9IGM7XG4gICAgICAgIHRhc2tzLnNldChjLmlkLCB2aWV3KTtcbiAgICAgICAgc2hvd1Rhc2tzKCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcInF1ZXN0aW9uc1wiOiBicmVhaztcbiAgICAgIGNhc2UgXCJtaWNTaWxlbnRcIjogJChcIm1pY3dhcm5cIikuaGlkZGVuID0gIWMuc2lsZW50OyBicmVhaztcbiAgICAgIGNhc2UgXCJ2b2ljZUNvbW1hbmRcIjpcbiAgICAgICAgdG9hc3QoYEhlYXJkIFx1MjAxQyR7Yy5oZWFyZH1cdTIwMUQ6ICR7Yy5jb21tYW5kID09PSBcInN0b3BcIiA/IFwic3RvcHBlZFwiIDogYy5jb21tYW5kID09PSBcImNhbmNlbEFsbFwiID8gXCJjYW5jZWxsaW5nIGV2ZXJ5IHRhc2tcIiA6IFwiaGFuZ2luZyB1cFwifWApO1xuICAgICAgICBsb2coXCJvdXRcIiwgYHZvaWNlIGNvbW1hbmQgJHtjLmNvbW1hbmR9OiAke2MuaGVhcmR9YCwgXCJvdXRcIik7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcImxvZ1wiOiBsb2coYy5sZXZlbCwgYy5tZXNzYWdlLCBjLmxldmVsID09PSBcIndhcm5cIiA/IFwid2FyblwiIDogXCJcIik7IGJyZWFrO1xuICAgICAgZGVmYXVsdDogbG9nKFwib3V0XCIsIEpTT04uc3RyaW5naWZ5KGMpLnNsaWNlKDAsIDMwMCksIFwib3V0XCIpO1xuICAgIH1cbiAgfVxufVxuXG5mdW5jdGlvbiBmbHVzaERlZmVycmVkTWljKCkge1xuICBjb25zdCBpdGVtcyA9IHdha2VHYXRlLmZsdXNoRGVmZXJyZWQoKTtcbiAgaWYgKCFjYWxsSWQgfHwgbWVkaXVtICE9PSBcInZvaWNlXCIpIHJldHVybjtcbiAgZm9yIChjb25zdCBpdGVtIG9mIGl0ZW1zKSB7XG4gICAgaWYgKCFjYWxsSWQpIGJyZWFrO1xuICAgIGNvdW50cy5taWMrKztcbiAgICBwdXNoKHsgdHlwZTogXCJtaWNcIiwgcGNtOiBpdGVtLnBjbSB9LCBpdGVtLnQpO1xuICB9XG59XG5cbmZ1bmN0aW9uIG9uTWljKHNhbXBsZXM6IEludDE2QXJyYXksIGxldmVsOiBudW1iZXIpIHtcbiAgY29uc3QgdCA9IG5vdygpO1xuICBjb25zdCBzdXBwcmVzc2VkID0gY2FsbElkICE9PSAwICYmIG1lZGl1bSA9PT0gXCJ2b2ljZVwiICYmIHdha2VHYXRlLmlzU3VwcHJlc3NlZCh0KTtcbiAgY29uc3Qgc2VxID0gc2hvdWxkRmVlZFdha2UoKSA/IHdha2VDbGllbnQuZmVlZChzYW1wbGVzLCBzdXBwcmVzc2VkKSA6IDA7XG4gIGlmICh3YWtlU3RhcnRpbmcpIHtcbiAgICBjb25zdCBjb3B5ID0gbmV3IFVpbnQ4QXJyYXkoc2FtcGxlcy5ieXRlTGVuZ3RoKTtcbiAgICBjb3B5LnNldChuZXcgVWludDhBcnJheShzYW1wbGVzLmJ1ZmZlciwgc2FtcGxlcy5ieXRlT2Zmc2V0LCBzYW1wbGVzLmJ5dGVMZW5ndGgpKTtcbiAgICBvcGVuaW5nQ2h1bmtzLnB1c2goY29weSk7XG4gICAgb3BlbmluZ0J5dGVzICs9IGNvcHkuYnl0ZUxlbmd0aDtcbiAgICB3aGlsZSAob3BlbmluZ0J5dGVzID4gT1BFTklOR19NQVhfQllURVMgJiYgb3BlbmluZ0NodW5rcy5sZW5ndGggPiAxKSB7XG4gICAgICBvcGVuaW5nQnl0ZXMgLT0gb3BlbmluZ0NodW5rcy5zaGlmdCgpIS5ieXRlTGVuZ3RoO1xuICAgIH1cbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKCFjYWxsSWQgfHwgbWVkaXVtICE9PSBcInZvaWNlXCIpIHJldHVybjtcbiAgaWYgKGxldmVsID4gMC4wMyAmJiAhKG11dGVkICYmICFob2xkaW5nKSkge1xuICAgIG1ldHJpY3MubGFzdFZvaWNlID0gdDtcbiAgICBpZiAoYXVkaW8ucXVldWVkIDwgMC4wNSkgbWV0cmljcy5yZXBsaWVkID0gZmFsc2U7XG4gIH1cbiAgY29uc3QgcGNtID0gYnl0ZXNUb0Jhc2U2NChuZXcgVWludDhBcnJheShzYW1wbGVzLmJ1ZmZlciwgc2FtcGxlcy5ieXRlT2Zmc2V0LCBzYW1wbGVzLmJ5dGVMZW5ndGgpKTtcbiAgY29uc3QgdG9TZW5kID0gd2FrZUdhdGUub25NaWNGcmFtZSh7XG4gICAgcGNtLFxuICAgIHQsXG4gICAgc2VxLFxuICAgIGxhc3RTZXE6IHdha2VDbGllbnQubGFzdFNlcSxcbiAgICBpbkZsaWdodFN1cHByZXNzZWRTZXE6IHdha2VDbGllbnQuaW5GbGlnaHRTdXBwcmVzc2VkU2VxLFxuICAgIHN1cHByZXNzZWQsXG4gIH0pO1xuICBmb3IgKGNvbnN0IGl0ZW0gb2YgdG9TZW5kKSB7XG4gICAgaWYgKCFjYWxsSWQpIGJyZWFrO1xuICAgIGNvdW50cy5taWMrKztcbiAgICBwdXNoKHsgdHlwZTogXCJtaWNcIiwgcGNtOiBpdGVtLnBjbSB9LCBpdGVtLnQpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGNvbm5lY3Qoc2lkOiBudW1iZXIsIGNhcHRpb25zOiBib29sZWFuKSB7XG4gIGNvbnN0IHdzID0gbmV3IFdlYlNvY2tldChgJHtsb2NhdGlvbi5wcm90b2NvbCA9PT0gXCJodHRwczpcIiA/IFwid3NzXCIgOiBcIndzXCJ9Oi8vJHtsb2NhdGlvbi5ob3N0fS9saXZlJHtjYXB0aW9ucyA/IFwiP2Zvcj1jYXB0aW9uc1wiIDogXCJcIn1gKTtcbiAgc29ja2V0cy5zZXQoc2lkLCB3cyk7XG4gIGlmIChjYXB0aW9ucykgY2FwdGlvblNvY2tldHMuYWRkKHNpZCk7XG4gIGxvZyhcIm91dFwiLCBgd3MgJHtzaWR9IGNvbm5lY3QgKCR7c2VydmVyLnJvdXRlfSR7Y2FwdGlvbnMgPyBcIiwgY2FwdGlvbnNcIiA6IFwiXCJ9KWAsIFwib3V0XCIpO1xuICB3cy5vbm9wZW4gPSAoKSA9PiBwdXNoKHsgdHlwZTogXCJ3cy5vcGVuXCIsIHNpZCB9KTtcbiAgd3Mub25tZXNzYWdlID0gKG0pID0+IHB1c2goeyB0eXBlOiBcIndzLm1lc3NhZ2VcIiwgc2lkLCBkYXRhOiB0eXBlb2YgbS5kYXRhID09PSBcInN0cmluZ1wiID8gbS5kYXRhIDogXCJcIiB9KTtcbiAgd3Mub25jbG9zZSA9IChlKSA9PiB7XG4gICAgaWYgKHNvY2tldHMuZ2V0KHNpZCkgIT09IHdzICYmIHNvY2tldHMuaGFzKHNpZCkpIHJldHVybjtcbiAgICBjb25zdCBodHRwU3RhdHVzID0gZS5jb2RlID49IDQxMDAgJiYgZS5jb2RlIDwgNDYwMCA/IGUuY29kZSAtIDQwMDAgOiB1bmRlZmluZWQ7XG4gICAgcHVzaCh7IHR5cGU6IFwid3MuY2xvc2VkXCIsIHNpZCwgY29kZTogaHR0cFN0YXR1cyA/IHVuZGVmaW5lZCA6IGUuY29kZSwgcmVhc29uOiBlLnJlYXNvbiwgaHR0cFN0YXR1cyB9KTtcbiAgfTtcbn1cblxuLyoqIEEgY2hhdCdzIHJlcXVlc3QgdG8gdGhlIHRleHQgbW9kZWwsIHRocm91Z2ggdGhlIHNlcnZlcjogZWFjaCBgZGF0YTpgIGxpbmUgb2YgdGhlIG1vZGVsJ3Mgc3RyZWFtIGdvZXMgdG8gdGhlIGNvcmUgYXMgaXQgY29tZXMuICovXG5hc3luYyBmdW5jdGlvbiBnZW5lcmF0ZShpZDogbnVtYmVyLCBib2R5OiBzdHJpbmcpIHtcbiAgY29uc3QgYWJvcnQgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gIHJlcXVlc3RzLnNldChpZCwgYWJvcnQpO1xuICBsb2coXCJvdXRcIiwgYHJlcXVlc3QgJHtpZH0gXHUyMTkyICR7c2VydmVyLnRleHRNb2RlbH0gKCR7TWF0aC5yb3VuZChib2R5Lmxlbmd0aCAvIDEwMjQpfSBLQilgLCBcIm91dFwiKTtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKFwiL2dlbmVyYXRlXCIsIHsgbWV0aG9kOiBcIlBPU1RcIiwgc2lnbmFsOiBhYm9ydC5zaWduYWwsIGhlYWRlcnM6IHsgXCJjb250ZW50LXR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSwgYm9keSB9KTtcbiAgICBpZiAoIXJlc3BvbnNlLm9rIHx8ICFyZXNwb25zZS5ib2R5KSB7XG4gICAgICBjb25zdCB0ZXh0ID0gYXdhaXQgcmVzcG9uc2UudGV4dCgpLmNhdGNoKCgpID0+IFwiXCIpO1xuICAgICAgcHVzaCh7IHR5cGU6IFwibGxtLmVuZFwiLCBpZCwgc3RhdHVzOiByZXNwb25zZS5zdGF0dXMsIGVycm9yOiBgSFRUUCAke3Jlc3BvbnNlLnN0YXR1c30ke3RleHQgPyBcIjogXCIgKyB0ZXh0LnJlcGxhY2UoL1xccysvZywgXCIgXCIpLnNsaWNlKDAsIDIwMCkgOiBcIlwifWAgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IHJlYWRlciA9IHJlc3BvbnNlLmJvZHkucGlwZVRocm91Z2gobmV3IFRleHREZWNvZGVyU3RyZWFtKCkpLmdldFJlYWRlcigpO1xuICAgIGxldCBidWZmZXIgPSBcIlwiO1xuICAgIGZvciAoOzspIHtcbiAgICAgIGNvbnN0IHsgdmFsdWUsIGRvbmUgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICBpZiAoZG9uZSkgYnJlYWs7XG4gICAgICBidWZmZXIgKz0gdmFsdWU7XG4gICAgICBsZXQgY3V0O1xuICAgICAgd2hpbGUgKChjdXQgPSBidWZmZXIuaW5kZXhPZihcIlxcblwiKSkgPj0gMCkge1xuICAgICAgICBjb25zdCBsaW5lID0gYnVmZmVyLnNsaWNlKDAsIGN1dCkucmVwbGFjZSgvXFxyJC8sIFwiXCIpO1xuICAgICAgICBidWZmZXIgPSBidWZmZXIuc2xpY2UoY3V0ICsgMSk7XG4gICAgICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgoXCJkYXRhOlwiKSkgcHVzaCh7IHR5cGU6IFwibGxtLmRhdGFcIiwgaWQsIGRhdGE6IGxpbmUuc2xpY2UoNSkudHJpbSgpIH0pO1xuICAgICAgfVxuICAgIH1cbiAgICBwdXNoKHsgdHlwZTogXCJsbG0uZW5kXCIsIGlkIH0pO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBpZiAoIWFib3J0LnNpZ25hbC5hYm9ydGVkKSBwdXNoKHsgdHlwZTogXCJsbG0uZW5kXCIsIGlkLCBlcnJvcjogKGVyciBhcyBFcnJvcikubWVzc2FnZSB9KTtcbiAgfSBmaW5hbGx5IHtcbiAgICByZXF1ZXN0cy5kZWxldGUoaWQpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGNhbmNlbFJ1bihrZXk6IHN0cmluZywgcmVhc29uOiBzdHJpbmcpIHtcbiAgY29uc3QgciA9IHJ1bnMuZ2V0KGtleSk7XG4gIGxvZyhcIm91dFwiLCBgY2FuY2VsICR7a2V5fSAoJHtyZWFzb259KWAsIFwib3V0XCIpO1xuICBpZiAoIXIpIHJldHVybjtcbiAgcnVucy5kZWxldGUoa2V5KTtcbiAgci5hYm9ydC5hYm9ydCgpO1xuICAvLyBDYW5jZWxsZWQgb24gcHVycG9zZTogdGhlIGFnZW50IHN0b3BzIHRvby4gQSBjYWxsIHRoYXQgZW5kZWQgbGVhdmVzIGEgY29kaW5nIGFnZW50IHdvcmtpbmcgaW4gVDMuXG4gIGlmIChyZWFzb24gPT09IFwiY2FuY2VsbGVkXCIgJiYgIWNoZWNrZWQoXCJmYWtlaGVybWVzXCIpKSB7XG4gICAgdm9pZCBmZXRjaChyLmFnZW50ID09PSBcInQzXCIgPyBcIi9hZ2VudC9jYW5jZWxcIiA6IFwiL2hlcm1lcy9zdG9wXCIsIHsgbWV0aG9kOiBcIlBPU1RcIiwgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBjYWxsOiBjYWxsTmFtZSwgdGFza0lkOiByLnRhc2tJZCB9KSB9KTtcbiAgfVxufVxuXG4vKiogTW9yZSBmb3IgYSBydW5uaW5nIHRhc2ssIGludG8gaXRzIGN1cnJlbnQgcnVuOyBpZiB0aGUgYWdlbnQgd29uJ3QgdGFrZSBpdCwgdGhlIGNvcmUgcXVldWVzIGl0IGluc3RlYWQuICovXG5hc3luYyBmdW5jdGlvbiBzdGVlclJ1bihjOiBDb21tYW5kKSB7XG4gIGNvbnN0IHIgPSBydW5zLmdldChjLnJ1bik7XG4gIGxvZyhcIm91dFwiLCBgc3RlZXIgJHtjLnJ1bn06ICR7Yy50ZXh0fWAsIFwib3V0XCIpO1xuICBpZiAoY2hlY2tlZChcImZha2VoZXJtZXNcIikpIHJldHVybjtcbiAgY29uc3Qgb2sgPSByICE9IG51bGwgJiZcbiAgICAoYXdhaXQgZmV0Y2goYy5hZ2VudCA9PT0gXCJ0M1wiID8gXCIvYWdlbnQvc3RlZXJcIiA6IFwiL2hlcm1lcy9zdGVlclwiLCB7IG1ldGhvZDogXCJQT1NUXCIsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgY2FsbDogY2FsbE5hbWUsIHRhc2tJZDogci50YXNrSWQsIHRleHQ6IGMubWVzc2FnZSB9KSB9KS50aGVuKCh4KSA9PiB4Lm9rLCAoKSA9PiBmYWxzZSkpO1xuICBpZiAoIW9rKSBwdXNoKHsgdHlwZTogXCJ0b29sLnN0ZWVyRmFpbGVkXCIsIHJ1bjogYy5ydW4sIHRleHQ6IGMudGV4dCB9KTtcbiAgZWxzZSB0b2FzdChgJHtjLmFnZW50ID09PSBcInQzXCIgPyBcIlRoZSBjb2RpbmcgYWdlbnRcIiA6IFwiSGVybWVzXCJ9IHRvb2sgdGhlIGZvbGxvdy11cCB3aGlsZSBpdCB3b3Jrc2ApO1xufVxuXG5hc3luYyBmdW5jdGlvbiB0b29sKGM6IENvbW1hbmQpIHtcbiAgaWYgKGMua2luZCA9PT0gXCJob3N0XCIpIHtcbiAgICBsb2coXCJvdXRcIiwgYGhvc3QgdG9vbCAke2MubmFtZX0gJHtKU09OLnN0cmluZ2lmeShjLmFyZ3MpfWAsIFwib3V0XCIpO1xuICAgIGNvbnN0IGFuc3dlciA9IGMubmFtZSA9PT0gXCJ0dl92b2x1bWVcIiA/IGBUaGUgVFYgaXMgYXQgJHsoZmFrZVR2TGV2ZWwgPSBOdW1iZXIoYy5hcmdzPy5sZXZlbCA/PyBmYWtlVHZMZXZlbCkpfS5gXG4gICAgICA6IGMubmFtZSA9PT0gXCJ0dl9wYXVzZVwiID8gKGMuYXJncz8ucGF1c2UgPT09IGZhbHNlID8gXCJQbGF5aW5nLlwiIDogXCJQYXVzZWQuXCIpIDogXCJEb25lLlwiO1xuICAgIHNldFRpbWVvdXQoKCkgPT4gcHVzaCh7IHR5cGU6IFwidG9vbC5yZXN1bHRcIiwgcnVuOiBjLnJ1biwgdGV4dDogYW5zd2VyIH0pLCAzMDApO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBhZ2VudCA9IGMuYWdlbnQgPT09IFwidDNcIiA/IFwidDNcIiA6IFwiaGVybWVzXCI7XG4gIGNvbnN0IG9yaWdpblNlc3Npb24gPSBhY3RpdmVTZXNzaW9uO1xuICBsb2coXCJvdXRcIiwgYCR7YWdlbnR9ICR7Yy5mb2xsb3dVcCA/IFwiZm9sbG93LXVwXCIgOiBcInRhc2tcIn0gXCIke2MubGFiZWx9XCIke2MucHJvamVjdCA/IGAgaW4gJHtjLnByb2plY3R9YCA6IFwiXCJ9OiAke2MucmVxdWVzdH1gLCBcIm91dFwiKTtcbiAgY29uc3QgYWJvcnQgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gIHJ1bnMuc2V0KGMucnVuLCB7IGFib3J0LCBhZ2VudCwgdGFza0lkOiBjLnRhc2tJZCB9KTtcbiAgY29uc3QgZG9uZSA9ICh0ZXh0OiBzdHJpbmcsIGZhaWxlZCA9IGZhbHNlKSA9PiB7XG4gICAgaWYgKCFydW5zLmhhcyhjLnJ1bikpIHJldHVybjtcbiAgICBydW5zLmRlbGV0ZShjLnJ1bik7XG4gICAgY29uc3QgdmlldyA9IHRhc2tzLmdldChjLnRhc2tJZCk7XG4gICAgY29uc3QgcmVzSWQgPSByZXN1bHQoYWdlbnQsIGMubGFiZWwsIHRleHQsIGZhaWxlZCwgYy50YXNrSWQsIG9yaWdpblNlc3Npb24pO1xuICAgIG5vdGlmeShgJHthZ2VudCA9PT0gXCJ0M1wiID8gXCJUM1wiIDogXCJIZXJtZXNcIn0gXHUwMEI3ICR7Yy5sYWJlbH1gLCB0ZXh0KTtcbiAgICBpZiAoIWZhaWxlZCkgeyByZW1lbWJlcihcImFzc2lzdGFudFwiLCB0ZXh0LCBgJHthZ2VudCA9PT0gXCJ0M1wiID8gXCJUM1wiIDogXCJIZXJtZXNcIn0gXHUwMEI3ICR7Yy5sYWJlbH1gKTsgbGFzdExpbmUgPSBudWxsOyB9XG4gICAgaWYgKHZpZXcpIHsgdmlldy5yZXN1bHRJZCA9IHJlc0lkOyBzaG93VGFza3MoKTsgfVxuICAgIHB1c2goeyB0eXBlOiBcInRvb2wucmVzdWx0XCIsIHJ1bjogYy5ydW4sIHRleHQsIGZhaWxlZCB9KTtcbiAgfTtcbiAgaWYgKGNoZWNrZWQoXCJmYWtlaGVybWVzXCIpKSB7XG4gICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IGRvbmUoYChGYWtlICR7YWdlbnQgPT09IFwidDNcIiA/IFwiVDNcIiA6IFwiSGVybWVzXCJ9KSBEb25lOiBcdTIwMUMke2MucmVxdWVzdH1cdTIwMUQuIE5vdGhpbmcgd2FzIGFjdHVhbGx5IHJ1bi5gKSwgTnVtYmVyKCQ8SFRNTElucHV0RWxlbWVudD4oXCJmYWtlZGVsYXlcIikudmFsdWUpICogMTAwMCk7XG4gICAgYWJvcnQuc2lnbmFsLm9uYWJvcnQgPSAoKSA9PiBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgIHJldHVybjtcbiAgfVxuICB0cnkge1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goYWdlbnQgPT09IFwidDNcIiA/IFwiL2FnZW50XCIgOiBcIi9oZXJtZXNcIiwge1xuICAgICAgbWV0aG9kOiBcIlBPU1RcIiwgc2lnbmFsOiBhYm9ydC5zaWduYWwsIGhlYWRlcnM6IHsgXCJjb250ZW50LXR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgY2FsbDogY2FsbE5hbWUsIHRhc2tJZDogYy50YXNrSWQsIGZvbGxvd1VwOiBjLmZvbGxvd1VwLCBtZXNzYWdlOiBjLm1lc3NhZ2UsIGxhYmVsOiBjLmxhYmVsLCByZXF1ZXN0OiBjLnJlcXVlc3QsIHByb2plY3Q6IGMucHJvamVjdCwgYXBwcm92YWxzOiBcInNjcmVlblwiIH0pLFxuICAgIH0pO1xuICAgIGlmICghcmVzcG9uc2Uub2sgfHwgIXJlc3BvbnNlLmJvZHkpIHRocm93IG5ldyBFcnJvcihgSFRUUCAke3Jlc3BvbnNlLnN0YXR1c31gKTtcbiAgICBjb25zdCByZWFkZXIgPSByZXNwb25zZS5ib2R5LnBpcGVUaHJvdWdoKG5ldyBUZXh0RGVjb2RlclN0cmVhbSgpKS5nZXRSZWFkZXIoKTtcbiAgICBsZXQgYnVmZmVyID0gXCJcIjtcbiAgICBmb3IgKDs7KSB7XG4gICAgICBjb25zdCB7IHZhbHVlLCBkb25lOiBmaW5pc2hlZCB9ID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcbiAgICAgIGlmIChmaW5pc2hlZCkgYnJlYWs7XG4gICAgICBidWZmZXIgKz0gdmFsdWU7XG4gICAgICBsZXQgY3V0O1xuICAgICAgd2hpbGUgKChjdXQgPSBidWZmZXIuaW5kZXhPZihcIlxcblxcblwiKSkgPj0gMCkge1xuICAgICAgICBjb25zdCBibG9jayA9IGJ1ZmZlci5zbGljZSgwLCBjdXQpO1xuICAgICAgICBidWZmZXIgPSBidWZmZXIuc2xpY2UoY3V0ICsgMik7XG4gICAgICAgIGNvbnN0IGV2ZW50ID0gYmxvY2subWF0Y2goL15ldmVudDogKC4qKSQvbSk/LlsxXTtcbiAgICAgICAgaWYgKCFldmVudCkgY29udGludWU7XG4gICAgICAgIGNvbnN0IGRhdGEgPSBKU09OLnBhcnNlKGJsb2NrLm1hdGNoKC9eZGF0YTogKC4qKSQvbSk/LlsxXSA/PyBcInt9XCIpO1xuICAgICAgICBpZiAoZXZlbnQgPT09IFwicHJvZ3Jlc3NcIikgcHVzaCh7IHR5cGU6IFwidGFzay5wcm9ncmVzc1wiLCB0YXNrOiBjLnRhc2tJZCwgdGV4dDogZGF0YS50ZXh0IH0pO1xuICAgICAgICBlbHNlIGlmIChldmVudCA9PT0gXCJ0aHJlYWRcIikgeyBjb25zdCB2aWV3ID0gdGFza3MuZ2V0KGMudGFza0lkKTsgaWYgKHZpZXcpIHsgdmlldy50aHJlYWQgPSBkYXRhLnRocmVhZDsgc2hvd1Rhc2tzKCk7IH0gfVxuICAgICAgICBlbHNlIGlmIChldmVudCA9PT0gXCJhcHByb3ZhbFwiKSB7XG4gICAgICAgICAgY29uc3QgdmlldyA9IHRhc2tzLmdldChjLnRhc2tJZCk7XG4gICAgICAgICAgaWYgKHZpZXcpIHsgdmlldy5hcHByb3ZhbCA9IHsgY29tbWFuZDogZGF0YS5jb21tYW5kIH07IHNob3dUYXNrcyh0cnVlKTsgfVxuICAgICAgICAgIHRvYXN0KGBIZXJtZXMgYXNrcyB0byBydW46ICR7ZGF0YS5jb21tYW5kLnNsaWNlKDAsIDgwKX1gKTtcbiAgICAgICAgICBub3RpZnkoYEhlcm1lcyBcdTAwQjcgJHtjLmxhYmVsfSBuZWVkcyB5b3VyIGFwcHJvdmFsYCwgZGF0YS5jb21tYW5kKTtcbiAgICAgICAgICBhdWRpby5jdWUoQVBQUk9WQUxfVE9ORSk7XG4gICAgICAgIH1cbiAgICAgICAgZWxzZSBpZiAoZXZlbnQgPT09IFwicmVzdWx0XCIpIGRvbmUoZGF0YS50ZXh0LCBkYXRhLmZhaWxlZCk7XG4gICAgICAgIGVsc2UgaWYgKGV2ZW50ID09PSBcImVycm9yXCIpIHsgcnVucy5kZWxldGUoYy5ydW4pOyBwdXNoKHsgdHlwZTogXCJ0b29sLmVycm9yXCIsIHJ1bjogYy5ydW4sIG1lc3NhZ2U6IGRhdGEubWVzc2FnZSB9KTsgfVxuICAgICAgfVxuICAgIH1cbiAgICBpZiAocnVucy5oYXMoYy5ydW4pKSB7IHJ1bnMuZGVsZXRlKGMucnVuKTsgcHVzaCh7IHR5cGU6IFwidG9vbC5lcnJvclwiLCBydW46IGMucnVuLCBtZXNzYWdlOiBcInRoZSBzZXJ2ZXIgY2xvc2VkIHRoZSBzdHJlYW0gd2l0aG91dCBhIHJlc3VsdFwiIH0pOyB9XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGlmICghYWJvcnQuc2lnbmFsLmFib3J0ZWQgJiYgcnVucy5oYXMoYy5ydW4pKSB7IHJ1bnMuZGVsZXRlKGMucnVuKTsgcHVzaCh7IHR5cGU6IFwidG9vbC5lcnJvclwiLCBydW46IGMucnVuLCBtZXNzYWdlOiAoZXJyIGFzIEVycm9yKS5tZXNzYWdlIH0pOyB9XG4gIH1cbn1cblxuZnVuY3Rpb24gbWljT3B0aW9ucygpIHtcbiAgY29uc3QgYWVjID0gY2hlY2tlZChcImFlY1wiKTtcbiAgcmV0dXJuIHsgZWNob0NhbmNlbGxhdGlvbjogYWVjLCBub2lzZVN1cHByZXNzaW9uOiBhZWMsIGF1dG9HYWluQ29udHJvbDogYWVjIH07XG59XG5cbmZ1bmN0aW9uIG51bWJlclNldHRpbmcoaWQ6IHN0cmluZywgZmFsbGJhY2s6IG51bWJlciwgbWluID0gMCwgbWF4ID0gMzYwMCk6IG51bWJlciB7XG4gIGNvbnN0IG4gPSBOdW1iZXIoJDxIVE1MSW5wdXRFbGVtZW50PihpZCkudmFsdWUpO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pID8gTWF0aC5tYXgobWluLCBNYXRoLm1pbihtYXgsIG4pKSA6IGZhbGxiYWNrO1xufVxuXG5mdW5jdGlvbiBkZXZlbG9wZXJPdmVycmlkZXMoKSB7XG4gIHRyeSB7XG4gICAgY29uc3QgZ2l2ZW4gPSBKU09OLnBhcnNlKCQ8SFRNTFRleHRBcmVhRWxlbWVudD4oXCJjb25maWdcIikudmFsdWUpO1xuICAgIGlmICghZ2l2ZW4gfHwgdHlwZW9mIGdpdmVuICE9PSBcIm9iamVjdFwiKSB7XG4gICAgICByZXR1cm4geyBub25XZWJQbGF0Zm9ybTogbnVsbCBhcyBzdHJpbmcgfCBudWxsLCBoYXNBdHRlbnRpb246IGZhbHNlLCBoYXNIYW5nVXA6IGZhbHNlLCBoYXNTdGFuZGJ5OiBmYWxzZSwgaGFzTWljV2hpbGVTcGVha2luZzogZmFsc2UgfTtcbiAgICB9XG4gICAgY29uc3Qgbm9uV2ViUGxhdGZvcm0gPSB0eXBlb2YgZ2l2ZW4ucGxhdGZvcm0gPT09IFwic3RyaW5nXCIgJiYgZ2l2ZW4ucGxhdGZvcm0gIT09IFwid2ViXCIgPyBnaXZlbi5wbGF0Zm9ybSA6IG51bGw7XG4gICAgY29uc3QgbWljID0gZ2l2ZW4ubWljICYmIHR5cGVvZiBnaXZlbi5taWMgPT09IFwib2JqZWN0XCIgPyBnaXZlbi5taWMgOiBudWxsO1xuICAgIHJldHVybiB7XG4gICAgICBub25XZWJQbGF0Zm9ybSxcbiAgICAgIGhhc0F0dGVudGlvbjogZ2l2ZW4uYXR0ZW50aW9uICE9PSB1bmRlZmluZWQsXG4gICAgICBoYXNIYW5nVXA6IGdpdmVuLmhhbmdVcEFmdGVyICE9PSB1bmRlZmluZWQsXG4gICAgICBoYXNTdGFuZGJ5OiBnaXZlbi5zdGFuZGJ5QWZ0ZXIgIT09IHVuZGVmaW5lZCxcbiAgICAgIGhhc01pY1doaWxlU3BlYWtpbmc6IG1pYyAhPSBudWxsICYmIG1pYy53aGlsZVNwZWFraW5nICE9PSB1bmRlZmluZWQsXG4gICAgfTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHsgbm9uV2ViUGxhdGZvcm06IG51bGwgYXMgc3RyaW5nIHwgbnVsbCwgaGFzQXR0ZW50aW9uOiBmYWxzZSwgaGFzSGFuZ1VwOiBmYWxzZSwgaGFzU3RhbmRieTogZmFsc2UsIGhhc01pY1doaWxlU3BlYWtpbmc6IGZhbHNlIH07XG4gIH1cbn1cblxuZnVuY3Rpb24gcmVhZENvbmZpZygpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gIGNvbnN0IGdpdmVuID0gSlNPTi5wYXJzZSgkPEhUTUxUZXh0QXJlYUVsZW1lbnQ+KFwiY29uZmlnXCIpLnZhbHVlKTtcbiAgY29uc3QgY29uZmlnOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICBtb2RlbDogc2VydmVyLm1vZGVsLCBhcGk6IHNlcnZlci5yb3V0ZSA9PT0gXCJ2ZXJ0ZXhcIiA/IFwidmVydGV4XCIgOiBcImdlbWluaVwiLCB0b2RheTogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLnNsaWNlKDAsIDEwKSxcbiAgICAuLi5naXZlbiwgdHJhY2U6IGNoZWNrZWQoXCJ0cmFjZVwiKSxcbiAgfTtcbiAgaWYgKGNoZWNrZWQoXCJwdHRcIikpIGNvbmZpZy5tdXRlZCA9IHRydWU7XG4gIGlmIChnaXZlbi52b2ljZSA9PT0gdW5kZWZpbmVkKSBjb25maWcudm9pY2UgPSAkPEhUTUxTZWxlY3RFbGVtZW50PihcInZvaWNlXCIpLnZhbHVlO1xuICBpZiAoY29uZmlnLnN0ZWVyaW5nID09PSB1bmRlZmluZWQpIGNvbmZpZy5zdGVlcmluZyA9IFtcImhlcm1lc1wiLCBcInQzXCJdO1xuICAvLyBBIHdlYiBjb25maWcgc2F2ZWQgYmVmb3JlIGhhbmQtb2ZmcyB3ZXJlIG5hbWVkIGluIHdvcmRzIGdldHMgdGhhdCB0b28uXG4gIGlmIChjb25maWcuaGFuZE9mZiA9PT0gdW5kZWZpbmVkICYmIGNvbmZpZy5wbGF0Zm9ybSA9PT0gXCJ3ZWJcIikgY29uZmlnLmhhbmRPZmYgPSBcIm5hbWVkXCI7XG4gIC8vIEFuZCBvbmUgc2F2ZWQgYmVmb3JlIHRoZSBwYWdlIGZvbGxvd2VkIHRoZSB1c2VyJ3MgbGVhZCAoc3VwZXJ2aXNlKSBnZXRzIHRoYXQuXG4gIGlmIChjb25maWcuc3VwZXJ2aXNlID09PSB1bmRlZmluZWQgJiYgY29uZmlnLnBsYXRmb3JtID09PSBcIndlYlwiKSBjb25maWcuc3VwZXJ2aXNlID0gdHJ1ZTtcbiAgaWYgKGNoZWNrZWQoXCJjb2RpbmdcIikgJiYgKHNlcnZlci50MyB8fCBjaGVja2VkKFwiZmFrZWhlcm1lc1wiKSkgJiYgY29uZmlnLmNvZGluZ0FnZW50ID09PSB1bmRlZmluZWQpIGNvbmZpZy5jb2RpbmdBZ2VudCA9IHsgcHJvamVjdHM6IHNlcnZlci50MyA/PyBbXSB9O1xuICBpZiAoY2hlY2tlZChcImNhcHRpb25zXCIpICYmIHNlcnZlci5jYXB0aW9uc01vZGVsICYmIGNvbmZpZy5jYXB0aW9ucyA9PT0gdW5kZWZpbmVkKSBjb25maWcuY2FwdGlvbnMgPSB7IG1vZGVsOiBzZXJ2ZXIuY2FwdGlvbnNNb2RlbCB9O1xuICAvLyBBcHBseSBlYWNoIFNldHRpbmdzIHNpZ25hbGluZyBmaWVsZCBpbmRlcGVuZGVudGx5IGZvciB3ZWIgY29uZmlncyB1bmxlc3Mgc2V0IGluIERldmVsb3BlciBKU09OIC8gcHJlc2V0LlxuICBjb25zdCBub25XZWIgPSB0eXBlb2YgZ2l2ZW4ucGxhdGZvcm0gPT09IFwic3RyaW5nXCIgJiYgZ2l2ZW4ucGxhdGZvcm0gIT09IFwid2ViXCI7XG4gIGlmICghbm9uV2ViKSB7XG4gICAgY29uc3Qgc2lnbmFsaW5nID0gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJzaWduYWxpbmdcIikudmFsdWU7XG4gICAgaWYgKGdpdmVuLmF0dGVudGlvbiA9PT0gdW5kZWZpbmVkICYmIChzaWduYWxpbmcgPT09IFwid2luZG93XCIgfHwgc2lnbmFsaW5nID09PSBcImVjaG9cIikpIHtcbiAgICAgIGNvbmZpZy5hdHRlbnRpb24gPSB7XG4gICAgICAgIG1vZGU6IFwid2luZG93XCIsXG4gICAgICAgIGFmdGVyV2FrZTogbnVtYmVyU2V0dGluZyhcImF0dG4tYWZ0ZXItd2FrZVwiLCA4LCAxLCA2MCksXG4gICAgICAgIHdpbmRvdzogbnVtYmVyU2V0dGluZyhcImF0dG4td2luZG93XCIsIDUsIDAsIDYwKSxcbiAgICAgICAgYWZ0ZXJRdWVzdGlvbjogbnVtYmVyU2V0dGluZyhcImF0dG4tYWZ0ZXItcXVlc3Rpb25cIiwgMTAsIDAsIDYwKSxcbiAgICAgICAgYWZ0ZXJIYW5kT2ZmOiAzLFxuICAgICAgICBhZnRlckFubm91bmNlbWVudDogMCxcbiAgICAgIH07XG4gICAgfVxuICAgIGlmIChnaXZlbi5oYW5nVXBBZnRlciA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25maWcuaGFuZ1VwQWZ0ZXIgPSBudW1iZXJTZXR0aW5nKFwiaGFuZ3VwLWFmdGVyXCIsIHNpZ25hbGluZyA9PT0gXCJlY2hvXCIgPyAxNSA6IDMwMCwgMCwgMzYwMCk7XG4gICAgfVxuICAgIGlmIChzaWduYWxpbmcgPT09IFwiZWNob1wiICYmIGdpdmVuLnN0YW5kYnlBZnRlciA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25maWcuc3RhbmRieUFmdGVyID0gODtcbiAgICB9XG4gICAgY29uc3QgZ2l2ZW5NaWMgPSBnaXZlbi5taWMgJiYgdHlwZW9mIGdpdmVuLm1pYyA9PT0gXCJvYmplY3RcIiA/IChnaXZlbi5taWMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIDogbnVsbDtcbiAgICBpZiAoKCFnaXZlbk1pYyB8fCBnaXZlbk1pYy53aGlsZVNwZWFraW5nID09PSB1bmRlZmluZWQpICYmIChjaGVja2VkKFwid2FrZS1iYXJnZVwiKSB8fCBzaWduYWxpbmcgPT09IFwiZWNob1wiKSkge1xuICAgICAgY29uZmlnLm1pYyA9IHsgZ2FpbkRiOiAwLCAuLi4oZ2l2ZW5NaWMgPz8ge30pLCB3aGlsZVNwZWFraW5nOiBcIndha2VcIiB9O1xuICAgIH1cbiAgfVxuICByZXR1cm4gY29uZmlnO1xufVxuXG4vKiogU3RhcnRzIGEgdm9pY2UgY2FsbCwgb3Igd2l0aCBbdHlwZWRdIGEgY2hhdCAodGhlIGNvcmUncyBtZWRpdW0gXCJ0ZXh0XCI6IG5vIGF1ZGlvLCBhIHRleHQgbW9kZWwpLiAqL1xuYXN5bmMgZnVuY3Rpb24gc3RhcnQoY2FycnlPbiA9IGZhbHNlLCB0eXBlZCA9IGZhbHNlKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGlmIChzdGFydGluZ0NhbGwgfHwgY2FsbElkKSByZXR1cm4gZmFsc2U7XG4gIHN0YXJ0aW5nQ2FsbCA9IHRydWU7XG4gIHRyeSB7XG4gICAgYXdhaXQgZW5kaW5nO1xuICAgIGlmIChjYWxsSWQpIHJldHVybiBmYWxzZTtcbiAgICBsZXQgZ2l2ZW46IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIHRyeSB7XG4gICAgICBnaXZlbiA9IHJlYWRDb25maWcoKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHRvYXN0KGBUaGUgZGV2ZWxvcGVyIHNldHRpbmdzIGFyZW4ndCB2YWxpZCBKU09OOiAkeyhlcnIgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIGlmICh0eXBlZCkge1xuICAgICAgaWYgKCFzZXJ2ZXIudGV4dE1vZGVsKSB7IHRvYXN0KFwiVGhpcyBzZXJ2ZXIgaGFzIG5vIHRleHQgbW9kZWwgZm9yIGEgY2hhdDogc3RhcnQgYSBjYWxsIHRvIHR5cGUgdG8gaXRcIik7IHJldHVybiBmYWxzZTsgfVxuICAgICAgZ2l2ZW4gPSB7IC4uLmdpdmVuLCBtZWRpdW06IFwidGV4dFwiLCBtdXRlZDogZmFsc2UgfTtcbiAgICAgIGRlbGV0ZSBnaXZlbi5jYXB0aW9ucztcbiAgICB9XG4gICAgJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJjYWxsXCIpLmRpc2FibGVkID0gdHJ1ZTtcbiAgICAkPEhUTUxCdXR0b25FbGVtZW50PihcImhlcm8tY2FsbFwiKS5kaXNhYmxlZCA9IHRydWU7XG4gICAgaWYgKFwiTm90aWZpY2F0aW9uXCIgaW4gd2luZG93ICYmIE5vdGlmaWNhdGlvbi5wZXJtaXNzaW9uID09PSBcImRlZmF1bHRcIikgdm9pZCBOb3RpZmljYXRpb24ucmVxdWVzdFBlcm1pc3Npb24oKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgbGV0IGxvYWRlZENvcmU6IENvcmU7XG4gICAgdHJ5IHtcbiAgICAgIGlmICghdHlwZWQpIGF3YWl0IGF1ZGlvLm9wZW4oKTtcbiAgICAgIGxvYWRlZENvcmUgPSBhd2FpdCBsb2FkQ29yZSgpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICAkPEhUTUxCdXR0b25FbGVtZW50PihcImNhbGxcIikuZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAgICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiaGVyby1jYWxsXCIpLmRpc2FibGVkID0gZmFsc2U7XG4gICAgfVxuICAgIGlmIChjYWxsSWQpIHJldHVybiBmYWxzZTtcbiAgICBjb3JlID0gbG9hZGVkQ29yZTtcbiAgICBpZiAodHlwZWQpIHtcbiAgICAgIHdha2VTdGFydGluZyA9IGZhbHNlO1xuICAgICAgb3BlbmluZ0NodW5rcyA9IFtdO1xuICAgICAgb3BlbmluZ0J5dGVzID0gMDtcbiAgICAgIGlmICh3YWtlQXJtZWQpIGF1ZGlvLnN0b3BNaWMoKTtcbiAgICB9XG4gICAgbWVkaXVtID0gdHlwZWQgPyBcInRleHRcIiA6IFwidm9pY2VcIjtcbiAgICB0aGlua2luZyA9IGZhbHNlO1xuICAgICQoXCJ2ZXJzaW9uXCIpLnRleHRDb250ZW50ID0gY29yZS52ZXJzaW9uO1xuICAgICQoXCJsb2dcIikuaW5uZXJIVE1MID0gXCJcIjtcbiAgICBpZiAoIXR5cGVkICYmICh0YXNrcy5zaXplID4gMCB8fCAkKFwidHJhbnNjcmlwdFwiKS5jaGlsZEVsZW1lbnRDb3VudCA+IDEpKSBub3RlKGBOZXcgY2FsbCBcdTAwQjcgJHtuZXcgRGF0ZSgpLnRvTG9jYWxlVGltZVN0cmluZygpfWApO1xuICAgIHNjcm9sbERvd24odHJ1ZSk7XG4gICAgdGFza3MuY2xlYXIoKTtcbiAgICBhY3RpdmVTZXNzaW9uID0gKytzZXNzaW9uU2VxO1xuICAgIHNob3dUYXNrcygpO1xuICAgIGNvdW50cyA9IHsgbWljOiAwLCBwbGF5OiAwLCBzZW50OiAwIH07XG4gICAgbWV0cmljcy5yZXBseSA9IFtdO1xuICAgIHN0YXJ0ZWRBdCA9IG5vdygpO1xuICAgIG11dGVkID0gZ2l2ZW4ubXV0ZWQgPT09IHRydWU7XG4gICAgY29uc3QgbWljQ2ZnID0gZ2l2ZW4ubWljICYmIHR5cGVvZiBnaXZlbi5taWMgPT09IFwib2JqZWN0XCIgPyAoZ2l2ZW4ubWljIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA6IG51bGw7XG4gICAgY29uc3QgbGltaXRzQ2ZnID0gZ2l2ZW4ubGltaXRzICYmIHR5cGVvZiBnaXZlbi5saW1pdHMgPT09IFwib2JqZWN0XCIgPyAoZ2l2ZW4ubGltaXRzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA6IG51bGw7XG4gICAgY29uc3QgYW5ub3VuY2VDZmcgPSBnaXZlbi5hbm5vdW5jZSAmJiB0eXBlb2YgZ2l2ZW4uYW5ub3VuY2UgPT09IFwib2JqZWN0XCIgPyAoZ2l2ZW4uYW5ub3VuY2UgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIDogbnVsbDtcbiAgICB3YWtlR2F0ZS5yZXNldCh0eXBlb2YgbWljQ2ZnPy53aGlsZVNwZWFraW5nID09PSBcInN0cmluZ1wiID8gbWljQ2ZnLndoaWxlU3BlYWtpbmcgOiBcInNlbmRcIiwgd2FrZUNsaWVudC5sYXN0U2VxLCB7XG4gICAgICBkZWxpdmVyTWF4OiB0eXBlb2YgbGltaXRzQ2ZnPy5kZWxpdmVyTWF4ID09PSBcIm51bWJlclwiID8gbGltaXRzQ2ZnLmRlbGl2ZXJNYXggOiAzMCxcbiAgICAgIGJyaWVmV2FpdDogdHlwZW9mIGFubm91bmNlQ2ZnPy5icmllZldhaXQgPT09IFwibnVtYmVyXCIgPyBhbm5vdW5jZUNmZy5icmllZldhaXQgOiAzLFxuICAgIH0pO1xuICAgIHdha2VQZXJpb2RDYWxsSWQgPSBudWxsO1xuICAgIHdha2VDbGllbnQucmVzZXQoKTtcbiAgICAvLyBDYXJyeWluZyBvbjogdGhlIG1vZGVsIGdldHMgdGhlIGxhc3QgY29udmVyc2F0aW9uIGFzIGEgcmVjYXAuIFRoZSBjb3JlIGNhcHMgaXQsIGxhdGVzdCBsaW5lcyBmaXJzdC5cbiAgICAvLyBBIGNoYXQgYWx3YXlzIGNhcnJpZXMgb24gZnJvbSB3aGF0J3Mgb24gdGhlIHNjcmVlbiAoYW4gZWFybGllciBjYWxsIG9yIGNoYXQgb24gdGhpcyBwYWdlKS5cbiAgICBpZiAodHlwZWQpIHsgaWYgKGNoYXQubGVuZ3RoID4gMCAmJiBnaXZlbi5oaXN0b3J5ID09PSB1bmRlZmluZWQpIGdpdmVuLmhpc3RvcnkgPSBjaGF0OyB9XG4gICAgZWxzZSBpZiAoY2FycnlPbiAmJiBnaXZlbi5oaXN0b3J5ID09PSB1bmRlZmluZWQpIGdpdmVuLmhpc3RvcnkgPSBzYXZlZEhpc3RvcnkoKTtcbiAgICBlbHNlIGlmICghY2FycnlPbikgY2hhdCA9IFtdO1xuICAgIGlmIChjYXJyeU9uICYmICF0eXBlZCkgY2hhdCA9IHNhdmVkSGlzdG9yeSgpO1xuICAgIGxhc3RMaW5lID0gbnVsbDtcbiAgICBvcGVuTGluZSA9IG51bGw7XG4gICAgc3luY1Jlc3VtZUJ1dHRvbnMoZmFsc2UpO1xuICAgIGNhbGxOYW1lID0gYCR7bmV3IERhdGUoKS50b0lTT1N0cmluZygpLnJlcGxhY2UoL1s6Ll0vZywgXCItXCIpfS0ke3R5cGVkID8gXCJjaGF0XCIgOiBcIndlYlwifS0ke2NvcmUudmVyc2lvbn1gO1xuICAgIGNvbnN0IGNyZWF0ZWQgPSBKU09OLnBhcnNlKGNvcmUuY3JlYXRlKEpTT04uc3RyaW5naWZ5KGdpdmVuKSwgbm93KCkpKTtcbiAgICBjYWxsSWQgPSBjcmVhdGVkLmlkO1xuICAgIGlmICghdHlwZWQpIHtcbiAgICAgIHNldENhbGxCdXR0b24odHJ1ZSk7XG4gICAgICAkPEhUTUxCdXR0b25FbGVtZW50PihcIm1pY1wiKS5kaXNhYmxlZCA9IGZhbHNlO1xuICAgIH1cbiAgICAkPEhUTUxCdXR0b25FbGVtZW50PihcImh1c2hcIikuZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAkKFwibWljXCIpLmNsYXNzTGlzdC50b2dnbGUoXCJtdXRlZFwiLCBtdXRlZCk7XG4gICAgcnVuKGNyZWF0ZWQuY29tbWFuZHMpO1xuICAgIHNob3dTdGF0dXMoKTtcbiAgICB0aWNrZXIgPSB3aW5kb3cuc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgICAgcHVzaCh7IHR5cGU6IFwidGlja1wiIH0pO1xuICAgICAgY29uc3QgbGV2ZWwgPSBtdXRlZCAmJiAhaG9sZGluZyA/IDAgOiBhdWRpby5sZXZlbDtcbiAgICAgIGNvbnN0IHN0cmVuZ3RoID0gTWF0aC5taW4oMSwgbGV2ZWwgKiAxMik7XG4gICAgICAkKFwicmluZ1wiKS5zdHlsZS5vcGFjaXR5ID0gU3RyaW5nKHN0cmVuZ3RoKTtcbiAgICAgICQoXCJyaW5nXCIpLnN0eWxlLnRyYW5zZm9ybSA9IGBzY2FsZSgkeygxICsgc3RyZW5ndGggKiAwLjEyKS50b0ZpeGVkKDMpfSlgO1xuICAgICAgJChcImNvdW50c1wiKS50ZXh0Q29udGVudCA9IGBtaWMgJHtjb3VudHMubWljfSBcdTAwQjcgc2VudCAke2NvdW50cy5zZW50fSBcdTAwQjcgcGxheWVkICR7Y291bnRzLnBsYXl9IFx1MDBCNyBxdWV1ZWQgJHthdWRpby5xdWV1ZWQudG9GaXhlZCgxKX0gc2A7XG4gICAgICBzaG93U3RhdHVzKCk7XG4gICAgfSwgMTAwKTtcbiAgICB0cmFjZVRpbWVyID0gd2luZG93LnNldEludGVydmFsKCgpID0+IHsgdm9pZCBzYXZlVHJhY2UoKTsgdm9pZCBwaW5nKCk7IHNob3dUYXNrcygpOyB9LCA1MDAwKTtcbiAgICB2b2lkIHBpbmcoKTtcbiAgICBpZiAoIXR5cGVkKSB7XG4gICAgICBzdG9wV29yZHMuc3RhcnQoKTtcbiAgICAgIGF3YWl0IGFjcXVpcmVXYWtlTG9jaygpO1xuICAgIH1cbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSBmaW5hbGx5IHtcbiAgICBzdGFydGluZ0NhbGwgPSBmYWxzZTtcbiAgfVxufVxuXG4vKiogVGhlIENhbGwgYnV0dG9uOiBoYW5ncyB1cCBhIGNhbGw7IHN0YXJ0cyBvbmU7IG9yLCB3aXRoIGEgY2hhdCBvbiwgZW5kcyB0aGUgY2hhdCBhbmQgY2FycmllcyBpdHMgY29udmVyc2F0aW9uIG9uIGJ5IHZvaWNlLiAqL1xuYXN5bmMgZnVuY3Rpb24gY2FsbEJ1dHRvbigpIHtcbiAgaWYgKGNhbGxJZCAmJiBtZWRpdW0gPT09IFwidm9pY2VcIikgeyBoYW5nVXAoKTsgcmV0dXJuOyB9XG4gIGlmIChjYWxsSWQpIHtcbiAgICAvLyBBIGNhbGwgY2FuJ3QgdGFrZSBvdmVyIHRoZSBjaGF0J3MgdGFza3MsIGFuZCBlbmRpbmcgdGhlIGNoYXQgd291bGQgc3RvcCB0aGVtLlxuICAgIGlmIChbLi4udGFza3MudmFsdWVzKCldLnNvbWUoKHYpID0+IHYuYy5zdGF0ZSA9PT0gXCJydW5uaW5nXCIpKSB7IHRvYXN0KFwiVGhlIGNoYXQncyB0YXNrcyBhcmUgc3RpbGwgcnVubmluZzogd2FpdCBmb3IgdGhlbSBvciBjYW5jZWwgdGhlbSwgdGhlbiBjYWxsXCIpOyByZXR1cm47IH1cbiAgICBwdXNoKHsgdHlwZTogXCJzdG9wXCIgfSk7XG4gICAgYXdhaXQgc3RhcnQodHJ1ZSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGF3YWl0IHN0YXJ0KCk7XG59XG5cbmZ1bmN0aW9uIGhhbmdVcCgpIHtcbiAgaWYgKGNhbGxJZCkgcHVzaCh7IHR5cGU6IFwic3RvcFwiLCBtZXNzYWdlOiBcIllvdSBodW5nIHVwLlwiIH0pO1xufVxuXG5mdW5jdGlvbiBlbmQoKSB7XG4gIHdpbmRvdy5jbGVhckludGVydmFsKHRpY2tlcik7XG4gIHdpbmRvdy5jbGVhckludGVydmFsKHRyYWNlVGltZXIpO1xuICBzdG9wV29yZHMuc3RvcCgpO1xuICBhY3RpdmVTZXNzaW9uID0gMDtcbiAgc3luY1Jlc3VsdEZvbGxvd1VwQnV0dG9ucygpO1xuICBjb3JlV2FudHNXYWtlID0gZmFsc2U7XG4gIHdha2VHYXRlLnJlc2V0KFwic2VuZFwiLCB3YWtlQ2xpZW50Lmxhc3RTZXEpO1xuICB3YWtlUGVyaW9kQ2FsbElkID0gd2FrZUFybWVkID8gMCA6IG51bGw7XG4gIHdha2VTdGFydGluZyA9IGZhbHNlO1xuICBvcGVuaW5nQ2h1bmtzID0gW107XG4gIG9wZW5pbmdCeXRlcyA9IDA7XG4gIGNvbnN0IGZpbmlzaGVkSWQgPSBjYWxsSWQ7XG4gIGNvbnN0IGZpbmlzaGVkQ29yZSA9IGNvcmU7XG4gIGNhbGxJZCA9IDA7XG4gIGVuZGluZyA9IHNhdmVUcmFjZShmaW5pc2hlZElkLCBmaW5pc2hlZENvcmUpLnRoZW4oKCkgPT4geyBpZiAoZmluaXNoZWRDb3JlICYmIGZpbmlzaGVkSWQpIGZpbmlzaGVkQ29yZS5kaXNwb3NlKGZpbmlzaGVkSWQpOyBzaG93VGFza3MoKTsgc3luY1dha2VVaSgpOyB9KTtcbiAgaWYgKHdha2VBcm1lZCkge1xuICAgIGF1ZGlvLnN0b3BQbGF5YmFjaygpO1xuICAgIHdha2VDbGllbnQucmVzZXQoKTtcbiAgICB2b2lkIGF1ZGlvLmVuc3VyZU1pYyhvbk1pYywgbWljT3B0aW9ucygpKS5jYXRjaCgoZXJyKSA9PiB7XG4gICAgICBsb2coXCJlcnJvclwiLCBgd2FrZSBtaWNyb3Bob25lOiAke2Vyci5tZXNzYWdlfWAsIFwiZXJyXCIpO1xuICAgICAgdG9hc3QoYFdha2UgbWljcm9waG9uZTogJHtlcnIubWVzc2FnZX1gKTtcbiAgICAgIHZvaWQgYXJtV2FrZShmYWxzZSk7XG4gICAgfSk7XG4gIH0gZWxzZSB7XG4gICAgYXVkaW8uc3RvcCgpO1xuICAgIHJlbGVhc2VXYWtlTG9jaygpO1xuICB9XG4gIGZvciAoY29uc3Qgd3Mgb2Ygc29ja2V0cy52YWx1ZXMoKSkgd3MuY2xvc2UoKTtcbiAgc29ja2V0cy5jbGVhcigpO1xuICBmb3IgKGNvbnN0IHIgb2YgcnVucy52YWx1ZXMoKSkgci5hYm9ydC5hYm9ydCgpO1xuICBydW5zLmNsZWFyKCk7XG4gIGZvciAoY29uc3QgciBvZiByZXF1ZXN0cy52YWx1ZXMoKSkgci5hYm9ydCgpO1xuICByZXF1ZXN0cy5jbGVhcigpO1xuICB0aGlua2luZyA9IGZhbHNlO1xuICBzZXRDYWxsQnV0dG9uKGZhbHNlKTtcbiAgZm9yIChjb25zdCBpZCBvZiBbXCJtaWNcIiwgXCJodXNoXCJdKSAkPEhUTUxCdXR0b25FbGVtZW50PihpZCkuZGlzYWJsZWQgPSB0cnVlO1xuICAkKFwicmluZ1wiKS5zdHlsZS5vcGFjaXR5ID0gXCIwXCI7XG4gICQoXCJyaW5nXCIpLnN0eWxlLnRyYW5zZm9ybSA9IFwiXCI7XG4gICQoXCJjYWxsYmFyXCIpLmhpZGRlbiA9IHRydWU7XG4gICQoXCJtaWN3YXJuXCIpLmhpZGRlbiA9IHRydWU7XG4gIGRvY3VtZW50LmJvZHkuZGF0YXNldC5zdGF0ZSA9IHdha2VBcm1lZCA/IFwiYXJtZWRcIiA6IFwiaWRsZVwiO1xuICBkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5yZW1vdmUoXCJpbi1zZXNzaW9uXCIpO1xuICBzeW5jUmVzdW1lQnV0dG9ucyhjaGF0Lmxlbmd0aCA+IDApO1xuICB2b2lkIHNob3dFYXJsaWVyKCk7XG4gIHN5bmNXYWtlVWkoKTtcbn1cblxuZnVuY3Rpb24gc2V0TXV0ZWQodmFsdWU6IGJvb2xlYW4pIHtcbiAgaWYgKCFjYWxsSWQgfHwgbXV0ZWQgPT09IHZhbHVlKSByZXR1cm47XG4gIG11dGVkID0gdmFsdWU7XG4gIGlmIChtdXRlZCkge1xuICAgIGZsdXNoRGVmZXJyZWRNaWMoKTtcbiAgICB3YWtlQ2xpZW50LnJlc2V0KCk7XG4gIH1cbiAgJChcIm1pY1wiKS5jbGFzc0xpc3QudG9nZ2xlKFwibXV0ZWRcIiwgbXV0ZWQpO1xuICBwdXNoKHsgdHlwZTogbXV0ZWQgPyBcIm11dGVcIiA6IFwidW5tdXRlXCIgfSk7XG4gIHNob3dTdGF0dXMoKTtcbn1cblxuLyoqIFNlbmRzIHdoYXQgdGhlIHRyYWNlIGtlcHQgc2luY2UgbGFzdCB0aW1lIHRvIHRoZSBkZXYgc2VydmVyLCBhcyBKU09OIGxpbmVzOiBhIGhlYWRlciwgdGhlbiBldmVudHMuICovXG5hc3luYyBmdW5jdGlvbiBzYXZlVHJhY2UoaWQgPSBjYWxsSWQsIHRhcmdldENvcmUgPSBjb3JlKSB7XG4gIGlmICghdGFyZ2V0Q29yZSB8fCAhaWQgfHwgIWNoZWNrZWQoXCJ0cmFjZVwiKSkgcmV0dXJuO1xuICBjb25zdCBrZXB0ID0gSlNPTi5wYXJzZSh0YXJnZXRDb3JlLnRyYWNlKGlkKSk7XG4gIGlmICgha2VwdCkgcmV0dXJuO1xuICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcbiAgaWYgKGtlcHQuY29uZmlnKSBsaW5lcy5wdXNoKEpTT04uc3RyaW5naWZ5KHsgdmVyc2lvbjoga2VwdC52ZXJzaW9uLCBjb25maWc6IGtlcHQuY29uZmlnLCBzdGFydDoga2VwdC5zdGFydCB9KSk7XG4gIGZvciAoY29uc3QgZSBvZiBrZXB0LmV2ZW50cykgbGluZXMucHVzaChKU09OLnN0cmluZ2lmeShlKSk7XG4gIGlmIChsaW5lcy5sZW5ndGggPT09IDApIHJldHVybjtcbiAgYXdhaXQgZmV0Y2goYC90cmFjZXM/bmFtZT0ke2VuY29kZVVSSUNvbXBvbmVudChjYWxsTmFtZSl9Lmpzb25sYCwgeyBtZXRob2Q6IFwiUE9TVFwiLCBib2R5OiBsaW5lcy5qb2luKFwiXFxuXCIpICsgXCJcXG5cIiB9KS5jYXRjaCgoKSA9PiB7fSk7XG4gICQoXCJ0cmFjZW5hbWVcIikudGV4dENvbnRlbnQgPSBgdHJhY2UgJHtjYWxsTmFtZX0uanNvbmxgO1xufVxuXG4vLyBcIlN0b3BcIiBhbmQgXCJnb29kYnllXCIgaGVhcmQgYnkgdGhlIGJyb3dzZXIncyBvd24gcmVjb2duaXplcjogcXVpY2tlciB0aGFuIHRoZSBtb2RlbCdzIHRyYW5zY3JpcHQsXG4vLyBhbmQgaXQgd29ya3Mgd2hpbGUgdGhlIG1vZGVsJ3MgcmVwbHkgcGxheXMgZXZlbiB3aGVuIHRoZSBtb2RlbCBpc24ndCBoZWFyaW5nIHRoZSBtaWNyb3Bob25lLlxuXG5jbGFzcyBTdG9wV29yZHMge1xuICBwcml2YXRlIHJlYzogYW55ID0gbnVsbDtcbiAgcHJpdmF0ZSBvbiA9IGZhbHNlO1xuICBwcml2YXRlIGNvbW1hbmRzID0geyBzdG9wOiBbXSBhcyBzdHJpbmdbXSwgaGFuZ1VwOiBbXSBhcyBzdHJpbmdbXSwgY2FuY2VsQWxsOiBbXSBhcyBzdHJpbmdbXSB9O1xuXG4gIGdldCBzdXBwb3J0ZWQoKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIFwid2Via2l0U3BlZWNoUmVjb2duaXRpb25cIiBpbiB3aW5kb3cgfHwgXCJTcGVlY2hSZWNvZ25pdGlvblwiIGluIHdpbmRvdztcbiAgfVxuXG4gIHN0YXJ0KCkge1xuICAgIGlmICghY2hlY2tlZChcInN0b3B3b3JkXCIpIHx8ICF0aGlzLnN1cHBvcnRlZCB8fCAhY29yZSkgcmV0dXJuO1xuICAgIHRoaXMuY29tbWFuZHMgPSBKU09OLnBhcnNlKGNvcmUuZGVmYXVsdHMoKSkudm9pY2VDb21tYW5kcztcbiAgICBjb25zdCBSZWNvZ25pdGlvbiA9ICh3aW5kb3cgYXMgYW55KS5TcGVlY2hSZWNvZ25pdGlvbiA/PyAod2luZG93IGFzIGFueSkud2Via2l0U3BlZWNoUmVjb2duaXRpb247XG4gICAgdGhpcy5yZWMgPSBuZXcgUmVjb2duaXRpb24oKTtcbiAgICB0aGlzLnJlYy5jb250aW51b3VzID0gdHJ1ZTtcbiAgICB0aGlzLnJlYy5pbnRlcmltUmVzdWx0cyA9IHRydWU7XG4gICAgdGhpcy5yZWMubGFuZyA9IG5hdmlnYXRvci5sYW5ndWFnZSB8fCBcImVuLUdCXCI7XG4gICAgdGhpcy5yZWMub25yZXN1bHQgPSAoZTogYW55KSA9PiB7XG4gICAgICBmb3IgKGxldCBpID0gZS5yZXN1bHRJbmRleDsgaSA8IGUucmVzdWx0cy5sZW5ndGg7IGkrKykge1xuICAgICAgICBjb25zdCB0ZXh0ID0gZS5yZXN1bHRzW2ldWzBdLnRyYW5zY3JpcHQgYXMgc3RyaW5nO1xuICAgICAgICBjb25zdCBjb21tYW5kID0gY29tbWFuZEluKHRleHQsIHRoaXMuY29tbWFuZHMsIFtcIldvb2Rob3VzZVwiLCBcIkhlcm1lc1wiLCBcIkJlbnRvXCJdKTtcbiAgICAgICAgaWYgKGNvbW1hbmQgPT09IFwic3RvcFwiICYmIGF1ZGlvLnF1ZXVlZCA+IDAuMDUpIHtcbiAgICAgICAgICBsb2coXCJvdXRcIiwgYGxvY2FsIHN0b3Agd29yZDogJHt0ZXh0fWAsIFwib3V0XCIpO1xuICAgICAgICAgIHRvYXN0KGBIZWFyZCBcdTIwMUMke3RleHQudHJpbSgpfVx1MjAxRDogc3RvcHBlZGApO1xuICAgICAgICAgIHB1c2goeyB0eXBlOiBcImludGVycnVwdFwiIH0pO1xuICAgICAgICB9IGVsc2UgaWYgKGNvbW1hbmQgPT09IFwiY2FuY2VsQWxsXCIgJiYgZS5yZXN1bHRzW2ldLmlzRmluYWwpIHtcbiAgICAgICAgICBsb2coXCJvdXRcIiwgYGxvY2FsIGNhbmNlbC1hbGw6ICR7dGV4dH1gLCBcIm91dFwiKTtcbiAgICAgICAgICBwdXNoKHsgdHlwZTogXCJjYW5jZWxBbGxcIiB9KTtcbiAgICAgICAgICBwdXNoKHsgdHlwZTogXCJpbnRlcnJ1cHRcIiB9KTtcbiAgICAgICAgfSBlbHNlIGlmIChjb21tYW5kID09PSBcImhhbmdVcFwiICYmIGUucmVzdWx0c1tpXS5pc0ZpbmFsKSB7XG4gICAgICAgICAgbG9nKFwib3V0XCIsIGBsb2NhbCBoYW5nLXVwOiAke3RleHR9YCwgXCJvdXRcIik7XG4gICAgICAgICAgaGFuZ1VwKCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9O1xuICAgIHRoaXMucmVjLm9uZW5kID0gKCkgPT4geyBpZiAodGhpcy5vbikgc2V0VGltZW91dCgoKSA9PiB7IHRyeSB7IHRoaXMucmVjPy5zdGFydCgpOyB9IGNhdGNoIHt9IH0sIDI1MCk7IH07XG4gICAgdGhpcy5yZWMub25lcnJvciA9IChlOiBhbnkpID0+IHsgaWYgKGUuZXJyb3IgPT09IFwibm90LWFsbG93ZWRcIikgdGhpcy5vbiA9IGZhbHNlOyB9O1xuICAgIHRoaXMub24gPSB0cnVlO1xuICAgIHRyeSB7IHRoaXMucmVjLnN0YXJ0KCk7IH0gY2F0Y2gge31cbiAgfVxuXG4gIHN0b3AoKSB7XG4gICAgdGhpcy5vbiA9IGZhbHNlO1xuICAgIHRyeSB7IHRoaXMucmVjPy5zdG9wKCk7IH0gY2F0Y2gge31cbiAgICB0aGlzLnJlYyA9IG51bGw7XG4gIH1cbn1cbmNvbnN0IHN0b3BXb3JkcyA9IG5ldyBTdG9wV29yZHMoKTtcblxuLy8gTG9jYWwgd2FrZSB3b3JkIGxvb3AgKExpdmVLaXQgV2FrZVdvcmQgT05OWCBpbiBhIFdlYiBXb3JrZXIpOiBsaXN0ZW5zIGJldHdlZW4gY2FsbHMgd2hlbiBhcm1lZCxcbi8vIGFuZCBpbnNpZGUgYW4gYWN0aXZlIGNhbGwgd2hlbmV2ZXIgdGhlIGNvcmUgYXNrcyAoYHdha2V3b3JkOiBvbmA6IGRvcm1hbnQgb3Igd2hpbGVTcGVha2luZyBcIndha2VcIikuXG5cbmFzeW5jIGZ1bmN0aW9uIGFjcXVpcmVXYWtlTG9jaygpIHtcbiAgYXdhaXQgc2NyZWVuV2FrZUxvY2suYWNxdWlyZSgoKSA9PiAhZG9jdW1lbnQuaGlkZGVuICYmIChjYWxsSWQgIT09IDAgfHwgd2FrZUFybWVkKSk7XG59XG5cbmZ1bmN0aW9uIHJlbGVhc2VXYWtlTG9jaygpIHtcbiAgc2NyZWVuV2FrZUxvY2sucmVsZWFzZSgpO1xufVxuXG5mdW5jdGlvbiBzZWxlY3RlZFdha2VNb2RlbCgpOiBXYWtlTW9kZWxJbmZvIHwgbnVsbCB7XG4gIGNvbnN0IG1vZGVscyA9IHNlcnZlcj8ud2FrZU1vZGVscyA/PyBbXTtcbiAgaWYgKG1vZGVscy5sZW5ndGggPT09IDApIHJldHVybiBudWxsO1xuICBjb25zdCBwaWNrID0gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJ3YWtlLW1vZGVsXCIpLnZhbHVlO1xuICByZXR1cm4gbW9kZWxzLmZpbmQoKG0pID0+IG0uaWQgPT09IHBpY2spID8/IG1vZGVscy5maW5kKChtKSA9PiBtLmlkID09PSBcInBlbm55d29ydGhcIikgPz8gbW9kZWxzWzBdO1xufVxuXG5mdW5jdGlvbiB3YWtlVGhyZXNob2xkKCk6IG51bWJlciB7XG4gIGNvbnN0IG4gPSBOdW1iZXIoJDxIVE1MSW5wdXRFbGVtZW50PihcIndha2UtdGhyZXNob2xkXCIpLnZhbHVlKTtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShuKSA/IE1hdGgubWF4KDAuMSwgTWF0aC5taW4oMC45OSwgbikpIDogMC43O1xufVxuXG5mdW5jdGlvbiBzaG91bGRGZWVkV2FrZSgpOiBib29sZWFuIHtcbiAgaWYgKHdha2VTdGFydGluZyB8fCBzdGFydGluZ0NhbGwpIHJldHVybiBmYWxzZTtcbiAgaWYgKGNhbGxJZCA9PT0gMCkgcmV0dXJuIHdha2VBcm1lZDtcbiAgcmV0dXJuIG1lZGl1bSA9PT0gXCJ2b2ljZVwiICYmIGNvcmVXYW50c1dha2UgJiYgIShtdXRlZCAmJiAhaG9sZGluZyk7XG59XG5cbi8qKlxuICogV2hldGhlciBhIHdha2UgZGV0ZWN0aW9uIHJldHVybmluZyBhc3luY2hyb25vdXNseSBmcm9tIHRoZSB3b3JrZXIgc3RpbGwgYmVsb25ncyB0byB0aGUgYWN0aXZlXG4gKiBsaXN0ZW5pbmcgcGVyaW9kLiBVbmxpa2UgYHNob3VsZEZlZWRXYWtlKClgLCB0aGlzIHN0YXlzIHRydWUgZm9yIGFuIGFjdGl2ZSB2b2ljZSBjYWxsIGV2ZW4gaWZcbiAqIGBjb3JlV2FudHNXYWtlYCBqdXN0IGZsaXBwZWQgb2ZmIGFzIHBsYXliYWNrIGVuZGVkIHdoaWxlIHRoZSB3b3JrZXIgd2FzIHNjb3JpbmcgdGhlIGxhc3QgZnJhbWUuXG4gKi9cbmZ1bmN0aW9uIGNhbkFjY2VwdFdha2VIaXQoKTogYm9vbGVhbiB7XG4gIGlmICh3YWtlU3RhcnRpbmcgfHwgc3RhcnRpbmdDYWxsKSByZXR1cm4gZmFsc2U7XG4gIGlmIChjYWxsSWQgPT09IDApIHJldHVybiB3YWtlQXJtZWQgJiYgd2FrZVBlcmlvZENhbGxJZCA9PT0gMDtcbiAgcmV0dXJuIG1lZGl1bSA9PT0gXCJ2b2ljZVwiICYmICEobXV0ZWQgJiYgIWhvbGRpbmcpICYmIHdha2VQZXJpb2RDYWxsSWQgPT09IGNhbGxJZDtcbn1cblxuZnVuY3Rpb24gcmVuZGVyV2FrZVRlbGVtZXRyeSgpIHtcbiAgY29uc3QgYWN0aXZlID0gKGNhbGxJZCA9PT0gMCAmJiB3YWtlQXJtZWQpIHx8IChjYWxsSWQgIT09IDAgJiYgbWVkaXVtID09PSBcInZvaWNlXCIgJiYgY29yZVdhbnRzV2FrZSk7XG4gIGlmICghYWN0aXZlKSB7ICQoXCJoZWFyZFwiKS50ZXh0Q29udGVudCA9IFwiXCI7IHJldHVybjsgfVxuICBjb25zdCBsYWJlbCA9IHNlbGVjdGVkV2FrZU1vZGVsKCk/LmxhYmVsID8/IFwid2FrZSB3b3JkXCI7XG4gIGlmICh3YWtlTG9hZGluZykgeyAkKFwiaGVhcmRcIikudGV4dENvbnRlbnQgPSBgTG9hZGluZyB3YWtlIHdvcmQgXHUyMDFDJHtsYWJlbH1cdTIwMURcdTIwMjZgOyByZXR1cm47IH1cbiAgaWYgKGNhbGxJZCA9PT0gMCAmJiBhdWRpby5hdWRpb1N1c3BlbmRlZCkgeyAkKFwiaGVhcmRcIikudGV4dENvbnRlbnQgPSBgQXVkaW8gcGF1c2VkIGJ5IGJyb3dzZXIgXHUwMEI3IHRhcCBvciBwcmVzcyBhIGtleSB0byByZXN1bWUgXHUyMDFDJHtsYWJlbH1cdTIwMURgOyByZXR1cm47IH1cbiAgaWYgKCF3YWtlTGFzdFRlbCkgeyAkKFwiaGVhcmRcIikudGV4dENvbnRlbnQgPSBgV2FrZSBcdTIwMUMke2xhYmVsfVx1MjAxRCByZWFkeSAodGhyZXNob2xkICR7d2FrZVRocmVzaG9sZCgpLnRvRml4ZWQoMil9KWA7IHJldHVybjsgfVxuICBjb25zdCBzdGF0ZSA9IHdha2VMYXN0VGVsLmdhdGVPcGVuID8gYHNjb3JpbmcgJHt3YWtlTGFzdFRlbC5zY29yZS50b0ZpeGVkKDIpfWAgOiBcInF1aWV0XCI7XG4gIGNvbnN0IHNwZWVkID0gd2FrZUxhc3RUZWwuaW5mZXJNcyA+IDAgPyBgIFx1MDBCNyAke3dha2VMYXN0VGVsLmluZmVyTXMudG9GaXhlZCgxKX0gbXNgIDogXCJcIjtcbiAgJChcImhlYXJkXCIpLnRleHRDb250ZW50ID0gYFdha2UgXHUyMDFDJHtsYWJlbH1cdTIwMUQgXHUwMEI3ICR7c3RhdGV9IFx1MDBCNyBwZWFrICR7d2FrZUxhc3RUZWwucGVhay50b0ZpeGVkKDIpfSR7c3BlZWR9YDtcbn1cblxuZnVuY3Rpb24gc3luY1dha2VVaSgpIHtcbiAgY29uc3QgbW9kZWwgPSBzZWxlY3RlZFdha2VNb2RlbCgpO1xuICBjb25zdCBoYXNNb2RlbHMgPSBtb2RlbCAhPSBudWxsO1xuICBjb25zdCBsYWJlbCA9IG1vZGVsPy5sYWJlbCA/PyBcIndha2Ugd29yZFwiO1xuICBjb25zdCBidG4gPSAkPEhUTUxCdXR0b25FbGVtZW50PihcIndha2VidG5cIik7XG4gIGJ0bi5oaWRkZW4gPSAhaGFzTW9kZWxzO1xuICBidG4uY2xhc3NMaXN0LnRvZ2dsZShcIm9uXCIsIHdha2VBcm1lZCk7XG4gIGJ0bi5jbGFzc0xpc3QudG9nZ2xlKFwibG9hZGluZ1wiLCB3YWtlTG9hZGluZyAmJiAod2FrZUFybWVkIHx8IGNvcmVXYW50c1dha2UpKTtcbiAgYnRuLnNldEF0dHJpYnV0ZShcImFyaWEtcHJlc3NlZFwiLCBTdHJpbmcod2FrZUFybWVkKSk7XG4gIGJ0bi50aXRsZSA9IHdha2VBcm1lZCA/IGBTdG9wIHdha2Ugd29yZCBcdTIwMUMke2xhYmVsfVx1MjAxRCAoVylgIDogYExpc3RlbiBmb3IgXHUyMDFDJHtsYWJlbH1cdTIwMUQgKFcpYDtcbiAgY29uc3QgaGVybyA9ICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiaGVyby13YWtlXCIpO1xuICBoZXJvLmhpZGRlbiA9ICFoYXNNb2RlbHM7XG4gIGhlcm8uY2xhc3NMaXN0LnRvZ2dsZShcIm9uXCIsIHdha2VBcm1lZCk7XG4gIGhlcm8udGV4dENvbnRlbnQgPSB3YWtlQXJtZWRcbiAgICA/ICh3YWtlTG9hZGluZyA/IGBMb2FkaW5nIFx1MjAxQyR7bGFiZWx9XHUyMDFEXHUyMDI2YCA6IGF1ZGlvLmF1ZGlvU3VzcGVuZGVkID8gYEFjdGl2YXRlIFx1MjAxQyR7bGFiZWx9XHUyMDFEYCA6IGBMaXN0ZW5pbmcgZm9yIFx1MjAxQyR7bGFiZWx9XHUyMDFEYClcbiAgICA6IGBMaXN0ZW4gZm9yIFx1MjAxQyR7bGFiZWx9XHUyMDFEYDtcbiAgJDxIVE1MSW5wdXRFbGVtZW50PihcIndha2UtZW5hYmxlZFwiKS5jaGVja2VkID0gd2FrZUFybWVkO1xuICByZW5kZXJXYWtlVGVsZW1ldHJ5KCk7XG4gIHNob3dTdGF0dXMoKTtcbn1cblxuZnVuY3Rpb24gc3luY1NpZ25hbGluZ1VpKCkge1xuICBjb25zdCBvdiA9IGRldmVsb3Blck92ZXJyaWRlcygpO1xuICBjb25zdCBzaWduYWxpbmdFbCA9ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwic2lnbmFsaW5nXCIpO1xuICBjb25zdCBzaWduYWxpbmcgPSBzaWduYWxpbmdFbC52YWx1ZTtcbiAgY29uc3Qgbm9uV2ViID0gb3Yubm9uV2ViUGxhdGZvcm0gIT0gbnVsbDtcbiAgc2lnbmFsaW5nRWwuZGlzYWJsZWQgPSBub25XZWIgfHwgb3YuaGFzQXR0ZW50aW9uO1xuICBjb25zdCB3aW5kb3dDb250cm9scyA9ICFub25XZWIgJiYgIW92Lmhhc0F0dGVudGlvbiAmJiAoc2lnbmFsaW5nID09PSBcIndpbmRvd1wiIHx8IHNpZ25hbGluZyA9PT0gXCJlY2hvXCIpO1xuICBmb3IgKGNvbnN0IGlkIG9mIFtcImF0dG4tYWZ0ZXItd2FrZVwiLCBcImF0dG4td2luZG93XCIsIFwiYXR0bi1hZnRlci1xdWVzdGlvblwiXSkge1xuICAgICQ8SFRNTElucHV0RWxlbWVudD4oaWQpLmRpc2FibGVkID0gIXdpbmRvd0NvbnRyb2xzO1xuICB9XG4gICQ8SFRNTElucHV0RWxlbWVudD4oXCJoYW5ndXAtYWZ0ZXJcIikuZGlzYWJsZWQgPSBub25XZWIgfHwgb3YuaGFzSGFuZ1VwO1xuICBjb25zdCBiYXJnZSA9ICQ8SFRNTElucHV0RWxlbWVudD4oXCJ3YWtlLWJhcmdlXCIpO1xuICBpZiAobm9uV2ViIHx8IG92Lmhhc01pY1doaWxlU3BlYWtpbmcpIHtcbiAgICBiYXJnZS5kaXNhYmxlZCA9IHRydWU7XG4gIH0gZWxzZSBpZiAoc2lnbmFsaW5nID09PSBcImVjaG9cIikge1xuICAgIGJhcmdlLmNoZWNrZWQgPSB0cnVlO1xuICAgIGJhcmdlLmRpc2FibGVkID0gdHJ1ZTtcbiAgfSBlbHNlIHtcbiAgICBiYXJnZS5kaXNhYmxlZCA9IGZhbHNlO1xuICAgIGJhcmdlLmNoZWNrZWQgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLndha2UtYmFyZ2VcIikgPT09IFwiMVwiO1xuICB9XG4gIGNvbnN0IG92ZXJyaWRkZW46IHN0cmluZ1tdID0gW107XG4gIGlmIChvdi5oYXNBdHRlbnRpb24pIG92ZXJyaWRkZW4ucHVzaChcImF0dGVudGlvblwiKTtcbiAgaWYgKG92Lmhhc0hhbmdVcCkgb3ZlcnJpZGRlbi5wdXNoKFwiaGFuZ1VwQWZ0ZXJcIik7XG4gIGlmIChvdi5oYXNNaWNXaGlsZVNwZWFraW5nKSBvdmVycmlkZGVuLnB1c2goXCJtaWMud2hpbGVTcGVha2luZ1wiKTtcbiAgY29uc3QgaGFzTW9kZWxzID0gKHNlcnZlcj8ud2FrZU1vZGVscz8ubGVuZ3RoID8/IDApID4gMDtcbiAgJChcInNpZ25hbGluZy1oZWxwXCIpLnRleHRDb250ZW50ID0gbm9uV2ViXG4gICAgPyBgRGV2ZWxvcGVyIHByZXNldCAoJHtvdi5ub25XZWJQbGF0Zm9ybX0pIGNvbnRyb2xzIHNpZ25hbGluZy5gXG4gICAgOiBvdmVycmlkZGVuLmxlbmd0aCA+IDBcbiAgICAgID8gYERldmVsb3BlciBjb25maWcgc2V0cyAke292ZXJyaWRkZW4uam9pbihcIiwgXCIpfS5gXG4gICAgICA6ICFoYXNNb2RlbHMgJiYgc2lnbmFsaW5nICE9PSBcIm9wZW5cIlxuICAgICAgICA/IFwiTm8gd2FrZSBtb2RlbHMgb24gc2VydmVyOiB1c2UgdGhlIFdha2UgYnV0dG9uIHdoZW4gZG9ybWFudC5cIlxuICAgICAgICA6IFwiQXBwbGllZCBvbiB0aGUgbmV4dCBjYWxsIHVubGVzcyBvdmVycmlkZGVuIGluIERldmVsb3BlciBKU09OLlwiO1xufVxuXG5jb25zdCB3YWtlQ2xpZW50ID0gbmV3IFdha2VDbGllbnQoe1xuICBvblJlYWR5KG1vZGVsSWQsIHdhcm11cE1zKSB7XG4gICAgd2FrZUxvYWRpbmcgPSBmYWxzZTtcbiAgICBsb2coXCJvdXRcIiwgYHdha2Ugd29yZCByZWFkeTogJHttb2RlbElkfSR7d2FybXVwTXMgPiAwID8gYCAoJHt3YXJtdXBNc30gbXMpYCA6IFwiXCJ9YCwgXCJvdXRcIik7XG4gICAgc3luY1dha2VVaSgpO1xuICB9LFxuICBvbkRldGVjdGVkKGhpdCkge1xuICAgIG9uV2FrZURldGVjdGVkKGhpdCk7XG4gIH0sXG4gIG9uVGVsZW1ldHJ5KHRlbCkge1xuICAgIHdha2VMYXN0VGVsID0gdGVsO1xuICAgIHJlbmRlcldha2VUZWxlbWV0cnkoKTtcbiAgfSxcbiAgb25TdXBwcmVzc2VkU2V0dGxlZCgpIHtcbiAgICBmbHVzaERlZmVycmVkTWljKCk7XG4gIH0sXG4gIG9uRXJyb3IobWVzc2FnZSkge1xuICAgIHdha2VMb2FkaW5nID0gZmFsc2U7XG4gICAgZmx1c2hEZWZlcnJlZE1pYygpO1xuICAgIGxvZyhcImVycm9yXCIsIGB3YWtlIHdvcmQ6ICR7bWVzc2FnZX1gLCBcImVyclwiKTtcbiAgICB0b2FzdChgV2FrZSB3b3JkIGVycm9yOiAke21lc3NhZ2V9YCk7XG4gICAgaWYgKHdha2VBcm1lZCkgdm9pZCBhcm1XYWtlKGZhbHNlKTtcbiAgICBlbHNlIHN5bmNXYWtlVWkoKTtcbiAgfSxcbn0pO1xuXG5hc3luYyBmdW5jdGlvbiBhcm1XYWtlKG9uOiBib29sZWFuLCBwZXJzaXN0ID0gdHJ1ZSkge1xuICBjb25zdCBtb2RlbCA9IHNlbGVjdGVkV2FrZU1vZGVsKCk7XG4gIGlmIChvbiAmJiAhbW9kZWwpIHtcbiAgICB0b2FzdChcIk5vIHdha2Ugd29yZCBtb2RlbHMgZm91bmQgb24gdGhlIHNlcnZlclwiKTtcbiAgICAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwid2FrZS1lbmFibGVkXCIpLmNoZWNrZWQgPSBmYWxzZTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgZ2VuID0gKythcm1HZW47XG4gIHdha2VBcm1lZCA9IG9uO1xuICBpZiAocGVyc2lzdCkgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS53YWtlLWVuYWJsZWRcIiwgb24gPyBcIjFcIiA6IFwiMFwiKTtcbiAgaWYgKG9uICYmIG1vZGVsKSB7XG4gICAgd2FrZUxhc3RUZWwgPSBudWxsO1xuICAgIGlmICghd2FrZUNsaWVudC5yZWFkeSB8fCB3YWtlQ2xpZW50Lm1vZGVsSWQgIT09IG1vZGVsLmlkKSB3YWtlTG9hZGluZyA9IHRydWU7XG4gICAgd2FrZUNsaWVudC5sb2FkKG1vZGVsLmlkLCB3YWtlVGhyZXNob2xkKCkpO1xuICAgIGlmICghY2FsbElkKSB7XG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCBhdWRpby5lbnN1cmVNaWMob25NaWMsIG1pY09wdGlvbnMoKSk7XG4gICAgICAgIGlmIChnZW4gIT09IGFybUdlbiB8fCAhd2FrZUFybWVkKSByZXR1cm47XG4gICAgICAgIHdha2VQZXJpb2RDYWxsSWQgPSAwO1xuICAgICAgICB3YWtlQ2xpZW50LnJlc2V0KCk7XG4gICAgICAgIGF3YWl0IGFjcXVpcmVXYWtlTG9jaygpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGlmIChnZW4gIT09IGFybUdlbikgcmV0dXJuO1xuICAgICAgICB3YWtlQXJtZWQgPSBmYWxzZTtcbiAgICAgICAgd2FrZUxvYWRpbmcgPSBmYWxzZTtcbiAgICAgICAgaWYgKCFjYWxsSWQpIHtcbiAgICAgICAgICBhdWRpby5zdG9wTWljKCk7XG4gICAgICAgICAgcmVsZWFzZVdha2VMb2NrKCk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHBlcnNpc3QpIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2Uud2FrZS1lbmFibGVkXCIsIFwiMFwiKTtcbiAgICAgICAgdG9hc3QoYE1pY3JvcGhvbmU6ICR7KGVyciBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICAgICAgbG9nKFwiZXJyb3JcIiwgYHdha2UgbWljcm9waG9uZTogJHsoZXJyIGFzIEVycm9yKS5tZXNzYWdlfWAsIFwiZXJyXCIpO1xuICAgICAgfVxuICAgIH1cbiAgfSBlbHNlIHtcbiAgICB3YWtlTG9hZGluZyA9IGZhbHNlO1xuICAgIHdha2VMYXN0VGVsID0gbnVsbDtcbiAgICBpZiAoIWNhbGxJZCkge1xuICAgICAgd2FrZVBlcmlvZENhbGxJZCA9IG51bGw7XG4gICAgICBhdWRpby5zdG9wTWljKCk7XG4gICAgICByZWxlYXNlV2FrZUxvY2soKTtcbiAgICAgIHdha2VDbGllbnQucmVzZXQoKTtcbiAgICB9XG4gIH1cbiAgc3luY1dha2VVaSgpO1xufVxuXG5mdW5jdGlvbiBlbnN1cmVDb3JlV2FrZShvbjogYm9vbGVhbikge1xuICBjb3JlV2FudHNXYWtlID0gb247XG4gIGNvbnN0IG1vZGVsID0gc2VsZWN0ZWRXYWtlTW9kZWwoKTtcbiAgaWYgKG9uKSB7XG4gICAgaWYgKCFtb2RlbCkge1xuICAgICAgbG9nKFwid2FyblwiLCBcImNvcmUgYXNrZWQgZm9yIHdha2Ugd29yZCwgYnV0IG5vIG1vZGVscyBhcmUgYXZhaWxhYmxlXCIsIFwid2FyblwiKTtcbiAgICB9IGVsc2Uge1xuICAgICAgd2FrZUxhc3RUZWwgPSBudWxsO1xuICAgICAgY29uc3QgcHJlc2VydmVJbkZsaWdodCA9IHdha2VQZXJpb2RDYWxsSWQgPT09IGNhbGxJZCAmJiB3YWtlQ2xpZW50Lm1vZGVsSWQgPT09IG1vZGVsLmlkICYmIHdha2VDbGllbnQuc3VwcHJlc3NlZEluRmxpZ2h0O1xuICAgICAgd2FrZVBlcmlvZENhbGxJZCA9IGNhbGxJZDtcbiAgICAgIGlmICghd2FrZUNsaWVudC5yZWFkeSB8fCB3YWtlQ2xpZW50Lm1vZGVsSWQgIT09IG1vZGVsLmlkKSB3YWtlTG9hZGluZyA9IHRydWU7XG4gICAgICB3YWtlQ2xpZW50LmxvYWQobW9kZWwuaWQsIHdha2VUaHJlc2hvbGQoKSk7XG4gICAgICBpZiAoIXByZXNlcnZlSW5GbGlnaHQpIHdha2VDbGllbnQucmVzZXQoKTtcbiAgICAgIGxvZyhcIm91dFwiLCBgd2FrZSB3b3JkIGxpc3RlbmluZyAoJHttb2RlbC5sYWJlbH0pYCwgXCJvdXRcIik7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIGlmICghd2FrZUFybWVkKSB3YWtlTGFzdFRlbCA9IG51bGw7XG4gICAgbG9nKFwib3V0XCIsIFwid2FrZSB3b3JkIG9mZlwiLCBcIm91dFwiKTtcbiAgfVxuICBzeW5jV2FrZVVpKCk7XG59XG5cbmZ1bmN0aW9uIG9uV2FrZURldGVjdGVkKGhpdDogV2FrZURldGVjdGlvbkV2ZW50KSB7XG4gIGlmICghY2FuQWNjZXB0V2FrZUhpdCgpKSByZXR1cm47XG4gIGNvbnN0IGxhYmVsID0gc2VsZWN0ZWRXYWtlTW9kZWwoKT8ubGFiZWwgPz8gXCJ3YWtlIHdvcmRcIjtcbiAgbG9nKFwib3V0XCIsIGB3YWtlIGRldGVjdGVkIFx1MjAxQyR7bGFiZWx9XHUyMDFEIChzY29yZSAke2hpdC5zY29yZS50b0ZpeGVkKDIpfSwgJHtoaXQuaW5mZXJNcy50b0ZpeGVkKDEpfSBtcylgLCBcIm91dFwiKTtcbiAgaWYgKGNoZWNrZWQoXCJ3YWtlLWN1ZVwiKSkgdm9pZCBhdWRpby5vcGVuKCkudGhlbigoKSA9PiBhdWRpby5jdWUoV0FLRV9UT05FKSkuY2F0Y2goKCkgPT4ge30pO1xuICB0b2FzdChgSGVhcmQgXHUyMDFDJHtsYWJlbH1cdTIwMUQgKCR7aGl0LnNjb3JlLnRvRml4ZWQoMil9KWApO1xuICBpZiAoY2FsbElkICE9PSAwKSB7XG4gICAgY29uc3QgZGVmZXJyZWQgPSB3YWtlR2F0ZS50YWtlRGVmZXJyZWQoKTtcbiAgICBwdXNoKHsgdHlwZTogXCJ3YWtlXCIgfSk7XG4gICAgLy8gUmVwbGF5IHN1cHByZXNzZWQgY2h1bmtzIGFuZCBhbnkgZGVmZXJyZWQgcG9zdC1wbGF5YmFjayBjaHVua3MgaW4gZXhhY3QgY2hyb25vbG9naWNhbCBvcmRlcixcbiAgICAvLyBza2lwcGluZyBhbnl0aGluZyBvbGRlciB0aGFuIGFscmVhZHktZm9yd2FyZGVkIGdhcCBhdWRpby5cbiAgICBmb3IgKGNvbnN0IGl0ZW0gb2Ygd2FrZUdhdGUucGxhbldha2VSZXBsYXkoaGl0LCBkZWZlcnJlZCwgYnl0ZXNUb0Jhc2U2NCkpIHtcbiAgICAgIGlmICghY2FsbElkKSBicmVhaztcbiAgICAgIGNvdW50cy5taWMrKztcbiAgICAgIGlmIChpdGVtLnQgIT09IHVuZGVmaW5lZCkgcHVzaCh7IHR5cGU6IFwibWljXCIsIHBjbTogaXRlbS5wY20gfSwgaXRlbS50KTtcbiAgICAgIGVsc2UgcHVzaCh7IHR5cGU6IFwibWljXCIsIHBjbTogaXRlbS5wY20gfSk7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuICB3YWtlU3RhcnRpbmcgPSB0cnVlO1xuICBvcGVuaW5nQ2h1bmtzID0gW107XG4gIG9wZW5pbmdCeXRlcyA9IDA7XG4gIGZvciAoY29uc3QgY2h1bmsgb2YgaGl0LnRyYWlsaW5nKSB7XG4gICAgaWYgKGNodW5rLmJ5dGVzLmJ5dGVMZW5ndGggPT09IDApIGNvbnRpbnVlO1xuICAgIG9wZW5pbmdDaHVua3MucHVzaChjaHVuay5ieXRlcyk7XG4gICAgb3BlbmluZ0J5dGVzICs9IGNodW5rLmJ5dGVzLmJ5dGVMZW5ndGg7XG4gICAgd2hpbGUgKG9wZW5pbmdCeXRlcyA+IE9QRU5JTkdfTUFYX0JZVEVTICYmIG9wZW5pbmdDaHVua3MubGVuZ3RoID4gMSkge1xuICAgICAgb3BlbmluZ0J5dGVzIC09IG9wZW5pbmdDaHVua3Muc2hpZnQoKSEuYnl0ZUxlbmd0aDtcbiAgICB9XG4gIH1cbiAgdm9pZCBzdGFydChjaGF0Lmxlbmd0aCA+IDApLnRoZW4oKHN0YXJ0ZWQpID0+IHtcbiAgICBpZiAoIXN0YXJ0ZWQgJiYgd2FrZVN0YXJ0aW5nKSB7XG4gICAgICB3YWtlU3RhcnRpbmcgPSBmYWxzZTtcbiAgICAgIG9wZW5pbmdDaHVua3MgPSBbXTtcbiAgICAgIG9wZW5pbmdCeXRlcyA9IDA7XG4gICAgICBzeW5jV2FrZVVpKCk7XG4gICAgfVxuICB9KS5jYXRjaCgoZXJyKSA9PiB7XG4gICAgd2FrZVN0YXJ0aW5nID0gZmFsc2U7XG4gICAgb3BlbmluZ0NodW5rcyA9IFtdO1xuICAgIG9wZW5pbmdCeXRlcyA9IDA7XG4gICAgdG9hc3QoKGVyciBhcyBFcnJvcikubWVzc2FnZSk7XG4gICAgbG9nKFwiZXJyb3JcIiwgKGVyciBhcyBFcnJvcikubWVzc2FnZSwgXCJlcnJcIik7XG4gICAgc3luY1dha2VVaSgpO1xuICB9KTtcbn1cblxuLy8gV2lyaW5nLlxuXG5mdW5jdGlvbiBzZXR0aW5nc0Zyb21TdG9yYWdlKCkge1xuICBmb3IgKGNvbnN0IGlkIG9mIFtcImFlY1wiLCBcInN0b3B3b3JkXCIsIFwicHR0XCIsIFwiY2FwdGlvbnNcIiwgXCJjb2RpbmdcIiwgXCJmYWtlaGVybWVzXCIsIFwidHJhY2VcIiwgXCJ3YWtlLWN1ZVwiLCBcIndha2UtYmFyZ2VcIl0pIHtcbiAgICBjb25zdCB2ID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oYHZvaWNlLiR7aWR9YCk7XG4gICAgaWYgKHYgIT0gbnVsbCkgJDxIVE1MSW5wdXRFbGVtZW50PihpZCkuY2hlY2tlZCA9IHYgPT09IFwiMVwiO1xuICAgICQoaWQpLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4ge1xuICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oYHZvaWNlLiR7aWR9YCwgY2hlY2tlZChpZCkgPyBcIjFcIiA6IFwiMFwiKTtcbiAgICAgIGlmIChpZCA9PT0gXCJhZWNcIiAmJiB3YWtlQXJtZWQgJiYgIWNhbGxJZCkge1xuICAgICAgICB2b2lkIGF1ZGlvLnN0YXJ0TWljKG9uTWljLCBtaWNPcHRpb25zKCkpLmNhdGNoKChlcnIpID0+IHRvYXN0KGBNaWNyb3Bob25lOiAke2Vyci5tZXNzYWdlfWApKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxuICBmb3IgKGNvbnN0IFtpZCwga2V5XSBvZiBbXG4gICAgW1wiZmFrZWRlbGF5XCIsIFwidm9pY2UuZmFrZWRlbGF5XCJdLFxuICAgIFtcImF0dG4tYWZ0ZXItd2FrZVwiLCBcInZvaWNlLmF0dG4tYWZ0ZXItd2FrZVwiXSxcbiAgICBbXCJhdHRuLXdpbmRvd1wiLCBcInZvaWNlLmF0dG4td2luZG93XCJdLFxuICAgIFtcImF0dG4tYWZ0ZXItcXVlc3Rpb25cIiwgXCJ2b2ljZS5hdHRuLWFmdGVyLXF1ZXN0aW9uXCJdLFxuICAgIFtcImhhbmd1cC1hZnRlclwiLCBcInZvaWNlLmhhbmd1cC1hZnRlclwiXSxcbiAgXSBhcyBjb25zdCkge1xuICAgIGNvbnN0IHNhdmVkID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oa2V5KTtcbiAgICBpZiAoc2F2ZWQgIT0gbnVsbCkgJDxIVE1MSW5wdXRFbGVtZW50PihpZCkudmFsdWUgPSBzYXZlZDtcbiAgICAkKGlkKS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHtcbiAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKGtleSwgJDxIVE1MSW5wdXRFbGVtZW50PihpZCkudmFsdWUpO1xuICAgICAgaWYgKGlkID09PSBcImhhbmd1cC1hZnRlclwiKSBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLmhhbmd1cC1jdXN0b21cIiwgXCIxXCIpO1xuICAgIH0pO1xuICB9XG4gIGNvbnN0IHRocmVzaCA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2Uud2FrZS10aHJlc2hvbGRcIik7XG4gIGlmICh0aHJlc2ggIT0gbnVsbCkgJDxIVE1MSW5wdXRFbGVtZW50PihcIndha2UtdGhyZXNob2xkXCIpLnZhbHVlID0gdGhyZXNoO1xuICAkKFwid2FrZS10aHJlc2hvbGQtdmFsXCIpLnRleHRDb250ZW50ID0gd2FrZVRocmVzaG9sZCgpLnRvRml4ZWQoMik7XG4gICQoXCJ3YWtlLXRocmVzaG9sZFwiKS5hZGRFdmVudExpc3RlbmVyKFwiaW5wdXRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHYgPSB3YWtlVGhyZXNob2xkKCk7XG4gICAgJChcIndha2UtdGhyZXNob2xkLXZhbFwiKS50ZXh0Q29udGVudCA9IHYudG9GaXhlZCgyKTtcbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLndha2UtdGhyZXNob2xkXCIsIHYudG9GaXhlZCgyKSk7XG4gICAgd2FrZUNsaWVudC5zZXRUaHJlc2hvbGQodik7XG4gICAgcmVuZGVyV2FrZVRlbGVtZXRyeSgpO1xuICB9KTtcbiAgY29uc3Qgc2lnbmFsaW5nID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS5zaWduYWxpbmdcIik7XG4gIGlmIChzaWduYWxpbmcpICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwic2lnbmFsaW5nXCIpLnZhbHVlID0gc2lnbmFsaW5nO1xuICAkKFwic2lnbmFsaW5nXCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4ge1xuICAgIGNvbnN0IG1vZGUgPSAkPEhUTUxTZWxlY3RFbGVtZW50PihcInNpZ25hbGluZ1wiKS52YWx1ZTtcbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLnNpZ25hbGluZ1wiLCBtb2RlKTtcbiAgICBpZiAobG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS5oYW5ndXAtY3VzdG9tXCIpICE9PSBcIjFcIikge1xuICAgICAgY29uc3QgZGVmID0gbW9kZSA9PT0gXCJlY2hvXCIgPyBcIjE1XCIgOiBcIjMwMFwiO1xuICAgICAgJDxIVE1MSW5wdXRFbGVtZW50PihcImhhbmd1cC1hZnRlclwiKS52YWx1ZSA9IGRlZjtcbiAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2UuaGFuZ3VwLWFmdGVyXCIsIGRlZik7XG4gICAgfVxuICAgIHN5bmNTaWduYWxpbmdVaSgpO1xuICB9KTtcbiAgJChcIndha2UtZW5hYmxlZFwiKS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHZvaWQgYXJtV2FrZShjaGVja2VkKFwid2FrZS1lbmFibGVkXCIpKSk7XG4gICQoXCJ3YWtlLW1vZGVsXCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGlkID0gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJ3YWtlLW1vZGVsXCIpLnZhbHVlO1xuICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2Uud2FrZS1tb2RlbFwiLCBpZCk7XG4gICAgaWYgKHdha2VBcm1lZCB8fCBjb3JlV2FudHNXYWtlKSB7XG4gICAgICB3YWtlTG9hZGluZyA9IHRydWU7XG4gICAgICB3YWtlTGFzdFRlbCA9IG51bGw7XG4gICAgICB3YWtlQ2xpZW50LmxvYWQoaWQsIHdha2VUaHJlc2hvbGQoKSk7XG4gICAgICBzeW5jV2FrZVVpKCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHN5bmNXYWtlVWkoKTtcbiAgICB9XG4gIH0pO1xuICBjb25zdCB2b2ljZSA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2Uudm9pY2VcIik7XG4gIGlmICh2b2ljZSkgJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJ2b2ljZVwiKS52YWx1ZSA9IHZvaWNlO1xuICAkKFwidm9pY2VcIikuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLnZvaWNlXCIsICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwidm9pY2VcIikudmFsdWUpKTtcbiAgY29uc3QgbW9kZSA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UubW9kZVwiKTtcbiAgaWYgKG1vZGUpICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwibW9kZVwiKS52YWx1ZSA9IG1vZGU7XG4gICQoXCJtb2RlXCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4ge1xuICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2UubW9kZVwiLCAkPEhUTUxTZWxlY3RFbGVtZW50PihcIm1vZGVcIikudmFsdWUpO1xuICAgIHN5bmNDb21wb3NlcigpO1xuICB9KTtcbiAgY29uc3QgdGhlbWUgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLnRoZW1lXCIpID8/IFwic3lzdGVtXCI7XG4gIGFwcGx5VGhlbWUodGhlbWUpO1xuICBmb3IgKGNvbnN0IGJ0biBvZiBBcnJheS5mcm9tKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiI3RoZW1lLXBpY2tlciBidXR0b25cIikpKSB7XG4gICAgYnRuLm9uY2xpY2sgPSAoKSA9PiB7XG4gICAgICBjb25zdCBjaG9pY2UgPSBidG4uZGF0YXNldC50aGVtZSA/PyBcInN5c3RlbVwiO1xuICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS50aGVtZVwiLCBjaG9pY2UpO1xuICAgICAgYXBwbHlUaGVtZShjaG9pY2UpO1xuICAgIH07XG4gIH1cbiAgY29uc3QgZGVuc2l0eSA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UuZGVuc2l0eVwiKTtcbiAgYXBwbHlEZW5zaXR5KGRlbnNpdHkpO1xuICBmb3IgKGNvbnN0IGJ0biBvZiBBcnJheS5mcm9tKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiI2RlbnNpdHktcGlja2VyIGJ1dHRvblwiKSkpIHtcbiAgICBidG4ub25jbGljayA9ICgpID0+IHtcbiAgICAgIGNvbnN0IGNob2ljZSA9IG5vcm1hbGl6ZURlbnNpdHkoYnRuLmRhdGFzZXQuZGVuc2l0eSk7XG4gICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLmRlbnNpdHlcIiwgY2hvaWNlKTtcbiAgICAgIGFwcGx5RGVuc2l0eShjaG9pY2UpO1xuICAgIH07XG4gIH1cbiAgbWF0Y2hNZWRpYShcIihwcmVmZXJzLWNvbG9yLXNjaGVtZTogZGFyaylcIikuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiB7XG4gICAgaWYgKChsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLnRoZW1lXCIpID8/IFwic3lzdGVtXCIpID09PSBcInN5c3RlbVwiKSBhcHBseVRoZW1lKFwic3lzdGVtXCIpO1xuICB9KTtcbiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcInZpc2liaWxpdHljaGFuZ2VcIiwgKCkgPT4ge1xuICAgIGlmICghZG9jdW1lbnQuaGlkZGVuICYmIChjYWxsSWQgfHwgd2FrZUFybWVkKSkgdm9pZCBhY3F1aXJlV2FrZUxvY2soKTtcbiAgfSk7XG4gIGF1ZGlvLm9uQXVkaW9TdGF0ZUNoYW5nZSgoKSA9PiBzeW5jV2FrZVVpKCkpO1xuICBjb25zdCByZXN1bWVJZlN1c3BlbmRlZCA9ICgpID0+IHtcbiAgICBpZiAoYXVkaW8uYXVkaW9TdXNwZW5kZWQgJiYgKHdha2VBcm1lZCB8fCBjYWxsSWQpKSB7XG4gICAgICB2b2lkIGF1ZGlvLnJlc3VtZUF1ZGlvKCkudGhlbigoKSA9PiBzeW5jV2FrZVVpKCkpO1xuICAgIH1cbiAgfTtcbiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcInBvaW50ZXJkb3duXCIsIHJlc3VtZUlmU3VzcGVuZGVkLCB7IHBhc3NpdmU6IHRydWUgfSk7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJwb2ludGVydXBcIiwgcmVzdW1lSWZTdXNwZW5kZWQsIHsgcGFzc2l2ZTogdHJ1ZSB9KTtcbiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIHJlc3VtZUlmU3VzcGVuZGVkLCB7IHBhc3NpdmU6IHRydWUgfSk7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJrZXlkb3duXCIsIHJlc3VtZUlmU3VzcGVuZGVkLCB7IHBhc3NpdmU6IHRydWUgfSk7XG4gIHN5bmNTaWduYWxpbmdVaSgpO1xufVxuXG5jb25zdCBtb2JpbGVMYXlvdXQgPSBtYXRjaE1lZGlhKFwiKG1heC13aWR0aDogOTIwcHgpXCIpO1xubGV0IGRyYXdlck9wZW5lcjogSFRNTEVsZW1lbnQgfCBudWxsID0gbnVsbDtcblxuZnVuY3Rpb24gc2V0VGFza3NPcGVuKG9wZW46IGJvb2xlYW4sIG9wZW5lcj86IEhUTUxFbGVtZW50IHwgbnVsbCkge1xuICBjb25zdCBjYW5PcGVuID0gbW9iaWxlTGF5b3V0Lm1hdGNoZXMgJiYgISQoXCJ0YWxrXCIpLmhpZGRlbjtcbiAgY29uc3QgbmV4dCA9IG9wZW4gJiYgY2FuT3BlbjtcbiAgY29uc3Qgd2FzT3BlbiA9IGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LmNvbnRhaW5zKFwidGFza3Mtb3BlblwiKTtcbiAgZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QudG9nZ2xlKFwidGFza3Mtb3BlblwiLCBuZXh0KTtcbiAgY29uc3QgaGVhZGVyID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihcImhlYWRlclwiKSBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gIGlmIChoZWFkZXIpIGhlYWRlci5pbmVydCA9IG5leHQ7XG4gICQoXCJjb252b1wiKS5pbmVydCA9IG5leHQ7XG4gICQoXCJzaWRlXCIpLmluZXJ0ID0gbW9iaWxlTGF5b3V0Lm1hdGNoZXMgJiYgIW5leHQ7XG4gICQoXCJ0YXNrcy10b2dnbGVcIikuc2V0QXR0cmlidXRlKFwiYXJpYS1leHBhbmRlZFwiLCBTdHJpbmcobmV4dCkpO1xuICAkKFwibW9iaWxlLXRhc2tzLWJhclwiKS5zZXRBdHRyaWJ1dGUoXCJhcmlhLWV4cGFuZGVkXCIsIFN0cmluZyhuZXh0KSk7XG4gIGlmIChuZXh0ICYmICF3YXNPcGVuKSB7XG4gICAgZHJhd2VyT3BlbmVyID0gb3BlbmVyID8/IChkb2N1bWVudC5hY3RpdmVFbGVtZW50IGFzIEhUTUxFbGVtZW50IHwgbnVsbCk7XG4gICAgY2xlYXJVbnJlYWRJZlJlc3VsdHNWaXNpYmxlKCk7XG4gICAgJChcInRhc2tzLWNsb3NlXCIpLmZvY3VzKCk7XG4gICAgcmVxdWVzdEFuaW1hdGlvbkZyYW1lKCgpID0+IHVwZGF0ZUFsbFJlc3VsdENsYW1waW5nKCkpO1xuICB9IGVsc2UgaWYgKCFuZXh0ICYmIHdhc09wZW4pIHtcbiAgICBjb25zdCB0YXJnZXQgPSBkcmF3ZXJPcGVuZXI7XG4gICAgZHJhd2VyT3BlbmVyID0gbnVsbDtcbiAgICBpZiAodGFyZ2V0ICYmIHRhcmdldC5pc0Nvbm5lY3RlZCAmJiAhdGFyZ2V0LmhpZGRlbiAmJiB0YXJnZXQub2Zmc2V0UGFyZW50ICE9PSBudWxsKSB7XG4gICAgICB0YXJnZXQuZm9jdXMoKTtcbiAgICB9IGVsc2UgaWYgKHRhcmdldCA9PT0gJChcIm1vYmlsZS10YXNrcy1iYXJcIikpIHtcbiAgICAgIGNvbnN0IGZhbGxiYWNrID0gJChcInRhc2tzLXRvZ2dsZVwiKTtcbiAgICAgIGlmICghZmFsbGJhY2suaGlkZGVuICYmIGZhbGxiYWNrLm9mZnNldFBhcmVudCAhPT0gbnVsbCkgZmFsbGJhY2suZm9jdXMoKTtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gdGFicygpIHtcbiAgY29uc3Qgdmlld3M6IFJlY29yZDxzdHJpbmcsIEhUTUxFbGVtZW50PiA9IHsgdGFsazogJChcInRhbGtcIiksIGRldjogJChcImRldlwiKSwgcmVwbGF5OiAkKFwicmVwbGF5bWFpblwiKSB9O1xuICBmb3IgKGNvbnN0IG5hbWUgb2YgT2JqZWN0LmtleXModmlld3MpKSB7XG4gICAgJChgdGFiLSR7bmFtZX1gKS5vbmNsaWNrID0gKCkgPT4ge1xuICAgICAgZm9yIChjb25zdCBbb3RoZXIsIGVsXSBvZiBPYmplY3QuZW50cmllcyh2aWV3cykpIHtcbiAgICAgICAgZWwuaGlkZGVuID0gb3RoZXIgIT09IG5hbWU7XG4gICAgICAgICQoYHRhYi0ke290aGVyfWApLmNsYXNzTGlzdC50b2dnbGUoXCJvblwiLCBvdGhlciA9PT0gbmFtZSk7XG4gICAgICB9XG4gICAgICAkKFwidGFza3MtdG9nZ2xlXCIpLmhpZGRlbiA9IG5hbWUgIT09IFwidGFsa1wiO1xuICAgICAgc2V0VGFza3NPcGVuKGZhbHNlKTtcbiAgICAgIGlmIChuYW1lID09PSBcInRhbGtcIikgcmVxdWVzdEFuaW1hdGlvbkZyYW1lKCgpID0+IHVwZGF0ZUFsbFJlc3VsdENsYW1waW5nKCkpO1xuICAgIH07XG4gIH1cbiAgZm9yIChjb25zdCBidG4gb2YgQXJyYXkuZnJvbShkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxCdXR0b25FbGVtZW50PihcIiNzaWRlLXRhYnMgYnV0dG9uXCIpKSkge1xuICAgIGJ0bi5vbmNsaWNrID0gKCkgPT4gc2V0U2lkZUZpbHRlcihub3JtYWxpemVTaWRlRmlsdGVyKGJ0bi5kYXRhc2V0LmZpbHRlcikpO1xuICB9XG4gICQoXCJ0b2dnbGUtYWxsLXJlc3VsdHNcIikub25jbGljayA9ICgpID0+IHtcbiAgICBjb25zdCBjbGFtcGVkID0gWy4uLnJlc3VsdHMudmFsdWVzKCldLmZpbHRlcigocikgPT4gci5jYXJkLmNsYXNzTGlzdC5jb250YWlucyhcImNsYW1wZWRcIikpO1xuICAgIGNvbnN0IG9wZW5BbGwgPSBjbGFtcGVkLnNvbWUoKHIpID0+ICFyLmNhcmQuY2xhc3NMaXN0LmNvbnRhaW5zKFwib3BlblwiKSk7XG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiBjbGFtcGVkKSBzZXRSZXN1bHRPcGVuKGVudHJ5LCBvcGVuQWxsKTtcbiAgfTtcbiAgJChcImdlYXJcIikub25jbGljayA9ICgpID0+IHsgJChcInNldHRpbmdzXCIpLmhpZGRlbiA9IGZhbHNlOyB9O1xuICAkKFwiY2xvc2VzZXR0aW5nc1wiKS5vbmNsaWNrID0gKCkgPT4geyAkKFwic2V0dGluZ3NcIikuaGlkZGVuID0gdHJ1ZTsgfTtcbiAgJChcImNsb3Nlc2V0dGluZ3MteFwiKS5vbmNsaWNrID0gKCkgPT4geyAkKFwic2V0dGluZ3NcIikuaGlkZGVuID0gdHJ1ZTsgfTtcbiAgJChcInNldHRpbmdzXCIpLm9uY2xpY2sgPSAoZSkgPT4geyBpZiAoZS50YXJnZXQgPT09ICQoXCJzZXR0aW5nc1wiKSkgJChcInNldHRpbmdzXCIpLmhpZGRlbiA9IHRydWU7IH07XG4gIGNvbnN0IG9wZW5Nb2JpbGVUYXNrc0RyYXdlciA9IChvcGVuZXI6IEhUTUxFbGVtZW50KSA9PiB7XG4gICAgY29uc3QgYWN0aXZlVG90YWwgPSBbLi4udGFza3MudmFsdWVzKCldLmZpbHRlcihpc0FjdGl2ZVRhc2spLmxlbmd0aCArIGVhcmxpZXJBY3RpdmVDb3VudDtcbiAgICBjb25zdCBuZXh0RmlsdGVyID0gcmVzb2x2ZU1vYmlsZUJhbm5lckZpbHRlcihzaWRlRmlsdGVyLCBhY3RpdmVUb3RhbCwgdW5yZWFkTW9iaWxlUmVzdWx0cyk7XG4gICAgaWYgKG5leHRGaWx0ZXIgIT09IHNpZGVGaWx0ZXIpIHNldFNpZGVGaWx0ZXIobmV4dEZpbHRlcik7XG4gICAgc2V0VGFza3NPcGVuKHRydWUsIG9wZW5lcik7XG4gIH07XG4gICQoXCJ0YXNrcy10b2dnbGVcIikub25jbGljayA9ICgpID0+IHtcbiAgICBpZiAoZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QuY29udGFpbnMoXCJ0YXNrcy1vcGVuXCIpKSBzZXRUYXNrc09wZW4oZmFsc2UpO1xuICAgIGVsc2Ugb3Blbk1vYmlsZVRhc2tzRHJhd2VyKCQoXCJ0YXNrcy10b2dnbGVcIikpO1xuICB9O1xuICAkKFwibW9iaWxlLXRhc2tzLWJhclwiKS5vbmNsaWNrID0gKCkgPT4gb3Blbk1vYmlsZVRhc2tzRHJhd2VyKCQoXCJtb2JpbGUtdGFza3MtYmFyXCIpKTtcbiAgJChcInRhc2tzLWNsb3NlXCIpLm9uY2xpY2sgPSAoKSA9PiBzZXRUYXNrc09wZW4oZmFsc2UpO1xuICAkKFwic2lkZS1iYWNrZHJvcFwiKS5vbmNsaWNrID0gKCkgPT4gc2V0VGFza3NPcGVuKGZhbHNlKTtcbiAgbW9iaWxlTGF5b3V0LmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4ge1xuICAgIHNldFRhc2tzT3BlbihmYWxzZSk7XG4gICAgY2xlYXJVbnJlYWRJZlJlc3VsdHNWaXNpYmxlKCk7XG4gICAgcmVxdWVzdEFuaW1hdGlvbkZyYW1lKCgpID0+IHVwZGF0ZUFsbFJlc3VsdENsYW1waW5nKCkpO1xuICB9KTtcbiAgc2V0VGFza3NPcGVuKGZhbHNlKTtcbn1cblxuZnVuY3Rpb24gdHlwaW5nKCk6IGJvb2xlYW4ge1xuICBjb25zdCBlbCA9IGRvY3VtZW50LmFjdGl2ZUVsZW1lbnQgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICByZXR1cm4gISFlbCAmJiAoZWwudGFnTmFtZSA9PT0gXCJJTlBVVFwiIHx8IGVsLnRhZ05hbWUgPT09IFwiVEVYVEFSRUFcIiB8fCBlbC50YWdOYW1lID09PSBcIlNFTEVDVFwiIHx8IGVsLmlzQ29udGVudEVkaXRhYmxlKTtcbn1cblxuZnVuY3Rpb24ga2V5cygpIHtcbiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcImtleWRvd25cIiwgKGUpID0+IHtcbiAgICBpZiAoZS5rZXkgPT09IFwiRXNjYXBlXCIpIHtcbiAgICAgIGlmICghJChcInNldHRpbmdzXCIpLmhpZGRlbikgeyAkKFwic2V0dGluZ3NcIikuaGlkZGVuID0gdHJ1ZTsgcmV0dXJuOyB9XG4gICAgICBpZiAoZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QuY29udGFpbnMoXCJ0YXNrcy1vcGVuXCIpICYmIG1vYmlsZUxheW91dC5tYXRjaGVzICYmICEkKFwidGFsa1wiKS5oaWRkZW4pIHsgc2V0VGFza3NPcGVuKGZhbHNlKTsgcmV0dXJuOyB9XG4gICAgICBpZiAoY2FsbElkKSB7IHB1c2goeyB0eXBlOiBcImludGVycnVwdFwiIH0pOyBhdWRpby5mbHVzaCgpOyByZXR1cm47IH1cbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHR5cGluZygpIHx8ICEkKFwic2V0dGluZ3NcIikuaGlkZGVuIHx8IGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LmNvbnRhaW5zKFwidGFza3Mtb3BlblwiKSB8fCBlLm1ldGFLZXkgfHwgZS5jdHJsS2V5IHx8IGUuYWx0S2V5KSByZXR1cm47XG4gICAgaWYgKGUua2V5ID09PSBcIm1cIiB8fCBlLmtleSA9PT0gXCJNXCIpIHsgc2V0TXV0ZWQoIW11dGVkKTsgZS5wcmV2ZW50RGVmYXVsdCgpOyB9XG4gICAgZWxzZSBpZiAoZS5rZXkgPT09IFwid1wiIHx8IGUua2V5ID09PSBcIldcIikgeyB2b2lkIGFybVdha2UoIXdha2VBcm1lZCk7IGUucHJldmVudERlZmF1bHQoKTsgfVxuICAgIGVsc2UgaWYgKGUua2V5ID09PSBcIi9cIikgeyAkKFwidGV4dFwiKS5mb2N1cygpOyBlLnByZXZlbnREZWZhdWx0KCk7IH1cbiAgICBlbHNlIGlmIChlLmNvZGUgPT09IFwiU3BhY2VcIiAmJiBjYWxsSWQgJiYgbXV0ZWQgJiYgIWUucmVwZWF0KSB7IGhvbGRpbmcgPSB0cnVlOyBwdXNoKHsgdHlwZTogXCJ1bm11dGVcIiB9KTsgc2hvd1N0YXR1cygpOyBlLnByZXZlbnREZWZhdWx0KCk7IH1cbiAgfSk7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJrZXl1cFwiLCAoZSkgPT4ge1xuICAgIGlmIChlLmNvZGUgPT09IFwiU3BhY2VcIiAmJiBob2xkaW5nKSB7IGhvbGRpbmcgPSBmYWxzZTsgcHVzaCh7IHR5cGU6IFwibXV0ZVwiIH0pOyBzaG93U3RhdHVzKCk7IH1cbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHN1Ym1pdFRleHQoZTogRXZlbnQpIHtcbiAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICBjb25zdCBpbnB1dCA9ICQ8SFRNTElucHV0RWxlbWVudD4oXCJ0ZXh0XCIpO1xuICBsZXQgdGV4dCA9IGlucHV0LnZhbHVlLnRyaW0oKTtcbiAgaWYgKCF0ZXh0KSByZXR1cm47XG4gIC8vIFdpdGggbm8gY2FsbCBvbiwgdHlwaW5nIHN0YXJ0cyBhIGNoYXQ6IHRoZSBzYW1lIG1haW4gdGhyZWFkLCBpbiB0ZXh0LlxuICBpZiAoIWNhbGxJZCkge1xuICAgIGlucHV0LnZhbHVlID0gXCJcIjtcbiAgICBzeW5jQ29tcG9zZXIoKTtcbiAgICB0cnkgeyBhd2FpdCBzdGFydChmYWxzZSwgdHJ1ZSk7IH0gY2F0Y2ggKGVycikgeyB0b2FzdCgoZXJyIGFzIEVycm9yKS5tZXNzYWdlKTsgbG9nKFwiZXJyb3JcIiwgKGVyciBhcyBFcnJvcikubWVzc2FnZSwgXCJlcnJcIik7IH1cbiAgICBpZiAoIWNhbGxJZCkgeyBpbnB1dC52YWx1ZSA9IHRleHQ7IHN5bmNDb21wb3NlcigpOyByZXR1cm47IH1cbiAgfVxuICAvLyBcIi90MyBcdTIwMjZcIiBhbmQgXCIvaCBcdTIwMjZcIiBwaWNrIHRoZSBhZ2VudCB3aGF0ZXZlciB0aGUgc2VsZWN0b3Igc2F5cy5cbiAgY29uc3QgcGFyc2VkID0gcGFyc2VQcmVmaXgodGV4dCk7XG4gIGNvbnN0IG1vZGUgPSBwYXJzZWQubW9kZSA/PyAkPEhUTUxTZWxlY3RFbGVtZW50PihcIm1vZGVcIikudmFsdWU7XG4gIHRleHQgPSBwYXJzZWQucmVzdDtcbiAgaWYgKCF0ZXh0KSByZXR1cm47XG4gIGlmIChtb2RlID09PSBcInNheVwiKSB7XG4gICAgcHVzaCh7IHR5cGU6IFwic2F5XCIsIHRleHQgfSk7XG4gICAgc2Nyb2xsRG93bih0cnVlKTtcbiAgfSBlbHNlIHtcbiAgICBwdXNoKHsgdHlwZTogXCJhc2tcIiwgdGV4dCwgYWdlbnQ6IG1vZGUgfSk7XG4gICAgbm90ZShgWW91IFx1MjE5MiBuZXcgJHttb2RlID09PSBcInQzXCIgPyBcImNvZGluZ1wiIDogXCJIZXJtZXNcIn0gdGFzazogJHt0ZXh0fWApO1xuICAgIHNjcm9sbERvd24odHJ1ZSk7XG4gIH1cbiAgaW5wdXQudmFsdWUgPSBcIlwiO1xuICBzeW5jQ29tcG9zZXIoKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gbWFpbigpIHtcbiAgYXBwbHlUaGVtZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLnRoZW1lXCIpID8/IFwic3lzdGVtXCIpO1xuICBhcHBseURlbnNpdHkobG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS5kZW5zaXR5XCIpKTtcbiAgc2VydmVyID0gYXdhaXQgKGF3YWl0IGZldGNoKFwiL2NvbmZpZ1wiKSkuanNvbigpO1xuICAkKFwicm91dGVcIikudGV4dENvbnRlbnQgPSBgJHtzZXJ2ZXIucm91dGUgPT09IFwidmVydGV4XCIgPyBcIlZlcnRleFwiIDogXCJHZW1pbmkgQVBJXCJ9IFx1MDBCNyAke3NlcnZlci5tb2RlbC5zcGxpdChcIi9cIikucG9wKCl9YDtcbiAgJChcInZlcnNpb25cIikudGV4dENvbnRlbnQgPSBzZXJ2ZXIudmVyc2lvbjtcbiAgJChcImJ1aWxkXCIpLnRleHRDb250ZW50ID0gYGNvcmUgJHtzZXJ2ZXIudmVyc2lvbn1gO1xuICBzZXR0aW5nc0Zyb21TdG9yYWdlKCk7XG4gIGNvbnN0IHdha2VTZWxlY3QgPSAkPEhUTUxTZWxlY3RFbGVtZW50PihcIndha2UtbW9kZWxcIik7XG4gIGNvbnN0IHdha2VMaXN0ID0gc2VydmVyLndha2VNb2RlbHMgPz8gW107XG4gIGZvciAoY29uc3QgbSBvZiB3YWtlTGlzdCkgd2FrZVNlbGVjdC5hZGQobmV3IE9wdGlvbihtLmxhYmVsLCBtLmlkKSk7XG4gIGNvbnN0IHNhdmVkV2FrZU1vZGVsID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS53YWtlLW1vZGVsXCIpO1xuICBpZiAoc2F2ZWRXYWtlTW9kZWwgJiYgd2FrZUxpc3Quc29tZSgobSkgPT4gbS5pZCA9PT0gc2F2ZWRXYWtlTW9kZWwpKSB3YWtlU2VsZWN0LnZhbHVlID0gc2F2ZWRXYWtlTW9kZWw7XG4gIGVsc2UgaWYgKHdha2VMaXN0LnNvbWUoKG0pID0+IG0uaWQgPT09IFwicGVubnl3b3J0aFwiKSkgd2FrZVNlbGVjdC52YWx1ZSA9IFwicGVubnl3b3J0aFwiO1xuICBpZiAod2FrZUxpc3QubGVuZ3RoID09PSAwKSB7XG4gICAgJDxIVE1MSW5wdXRFbGVtZW50PihcIndha2UtZW5hYmxlZFwiKS5kaXNhYmxlZCA9IHRydWU7XG4gICAgd2FrZVNlbGVjdC5kaXNhYmxlZCA9IHRydWU7XG4gICAgJChcIndha2UtaGVscFwiKS50ZXh0Q29udGVudCA9IFwiTm8gLm9ubnggd2FrZSB3b3JkIG1vZGVscyBmb3VuZCBvbiB0aGUgc2VydmVyLlwiO1xuICB9XG4gIGlmICghc2VydmVyLmhlcm1lcykgeyAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwiZmFrZWhlcm1lc1wiKS5jaGVja2VkID0gdHJ1ZTsgJDxIVE1MSW5wdXRFbGVtZW50PihcImZha2VoZXJtZXNcIikuZGlzYWJsZWQgPSB0cnVlOyB9XG4gIGlmICghc2VydmVyLnQzKSAkKFwiY29kaW5naGVscFwiKS50ZXh0Q29udGVudCA9IFwiVDMgaXNuJ3QgYXZhaWxhYmxlIG9uIHRoZSBzZXJ2ZXI6IG9ubHkgd2l0aCBmYWtlIGFuc3dlcnMuXCI7XG4gIGVsc2UgJChcImNvZGluZ2hlbHBcIikudGV4dENvbnRlbnQgPSBgQ29kZSBjaGFuZ2VzIGdvIHRvIGEgVDMgQ29kZSB0aHJlYWQgaW4gb25lIG9mOiAke3NlcnZlci50My5qb2luKFwiLCBcIil9LmA7XG4gIGlmICghc3RvcFdvcmRzLnN1cHBvcnRlZCkgeyAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwic3RvcHdvcmRcIikuY2hlY2tlZCA9IGZhbHNlOyAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwic3RvcHdvcmRcIikuZGlzYWJsZWQgPSB0cnVlOyB9XG4gIGNvbnN0IHByZXNldCA9ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwicHJlc2V0XCIpO1xuICBmb3IgKGNvbnN0IG5hbWUgb2YgT2JqZWN0LmtleXMoUFJFU0VUUykpIHByZXNldC5hZGQobmV3IE9wdGlvbihuYW1lLCBuYW1lKSk7XG4gIHByZXNldC52YWx1ZSA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UtY29yZS5wcmVzZXRcIikgPz8gXCJ3ZWJcIjtcbiAgaWYgKCFQUkVTRVRTW3ByZXNldC52YWx1ZV0pIHByZXNldC52YWx1ZSA9IFwid2ViXCI7XG4gICQ8SFRNTFRleHRBcmVhRWxlbWVudD4oXCJjb25maWdcIikudmFsdWUgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLWNvcmUuY29uZmlnXCIpID8/IEpTT04uc3RyaW5naWZ5KFBSRVNFVFNbcHJlc2V0LnZhbHVlXSwgbnVsbCwgMik7XG4gIHN5bmNTaWduYWxpbmdVaSgpO1xuICBwcmVzZXQub25jaGFuZ2UgPSAoKSA9PiB7XG4gICAgJDxIVE1MVGV4dEFyZWFFbGVtZW50PihcImNvbmZpZ1wiKS52YWx1ZSA9IEpTT04uc3RyaW5naWZ5KFBSRVNFVFNbcHJlc2V0LnZhbHVlXSwgbnVsbCwgMik7XG4gICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS1jb3JlLnByZXNldFwiLCBwcmVzZXQudmFsdWUpO1xuICAgIGxvY2FsU3RvcmFnZS5yZW1vdmVJdGVtKFwidm9pY2UtY29yZS5jb25maWdcIik7XG4gICAgc3luY1NpZ25hbGluZ1VpKCk7XG4gIH07XG4gICQoXCJjb25maWdcIikub25pbnB1dCA9ICgpID0+IHsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS1jb3JlLmNvbmZpZ1wiLCAkPEhUTUxUZXh0QXJlYUVsZW1lbnQ+KFwiY29uZmlnXCIpLnZhbHVlKTsgc3luY1NpZ25hbGluZ1VpKCk7IH07XG4gICQoXCJkZWZhdWx0c1wiKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGMgPSBjb3JlID8/IChhd2FpdCBsb2FkQ29yZSgpKTtcbiAgICAkKFwiZGVmYXVsdHN2aWV3XCIpLnRleHRDb250ZW50ID0gSlNPTi5zdHJpbmdpZnkoSlNPTi5wYXJzZShjLmRlZmF1bHRzKCkpLCBudWxsLCAyKTtcbiAgICAkKFwiZGVmYXVsdHN2aWV3XCIpLmhpZGRlbiA9ICEkKFwiZGVmYXVsdHN2aWV3XCIpLmhpZGRlbjtcbiAgfTtcbiAgY29uc3Qgb25DYWxsQ2xpY2sgPSAoKSA9PiB2b2lkIGNhbGxCdXR0b24oKS5jYXRjaCgoZXJyKSA9PiB7IHRvYXN0KGVyci5tZXNzYWdlKTsgbG9nKFwiZXJyb3JcIiwgZXJyLm1lc3NhZ2UsIFwiZXJyXCIpOyB9KTtcbiAgY29uc3Qgb25IZXJvQ2FsbENsaWNrID0gKCkgPT4geyBpZiAoIWNhbGxJZCkgdm9pZCBzdGFydCgpLmNhdGNoKChlcnIpID0+IHsgdG9hc3QoZXJyLm1lc3NhZ2UpOyBsb2coXCJlcnJvclwiLCBlcnIubWVzc2FnZSwgXCJlcnJcIik7IH0pOyB9O1xuICBjb25zdCBvblJlc3VtZUNsaWNrID0gKCkgPT4gdm9pZCBzdGFydCh0cnVlKS5jYXRjaCgoZXJyKSA9PiB7IHRvYXN0KGVyci5tZXNzYWdlKTsgbG9nKFwiZXJyb3JcIiwgZXJyLm1lc3NhZ2UsIFwiZXJyXCIpOyB9KTtcbiAgJChcImNhbGxcIikub25jbGljayA9IG9uQ2FsbENsaWNrO1xuICAkKFwiaGVyby1jYWxsXCIpLm9uY2xpY2sgPSBvbkhlcm9DYWxsQ2xpY2s7XG4gICQoXCJoZXJvLXdha2VcIikub25jbGljayA9ICgpID0+IHtcbiAgICBpZiAod2FrZUFybWVkICYmIGF1ZGlvLmF1ZGlvU3VzcGVuZGVkKSB7IHZvaWQgYXVkaW8ucmVzdW1lQXVkaW8oKS50aGVuKCgpID0+IHN5bmNXYWtlVWkoKSk7IHJldHVybjsgfVxuICAgIHZvaWQgYXJtV2FrZSghd2FrZUFybWVkKTtcbiAgfTtcbiAgJChcIndha2VidG5cIikub25jbGljayA9ICgpID0+IHtcbiAgICBpZiAod2FrZUFybWVkICYmIGF1ZGlvLmF1ZGlvU3VzcGVuZGVkKSB7IHZvaWQgYXVkaW8ucmVzdW1lQXVkaW8oKS50aGVuKCgpID0+IHN5bmNXYWtlVWkoKSk7IHJldHVybjsgfVxuICAgIHZvaWQgYXJtV2FrZSghd2FrZUFybWVkKTtcbiAgfTtcbiAgJChcIndha2Utbm93XCIpLm9uY2xpY2sgPSAoKSA9PiB7XG4gICAgaWYgKGNhbGxJZCkge1xuICAgICAgZmx1c2hEZWZlcnJlZE1pYygpO1xuICAgICAgd2FrZUNsaWVudC5yZXNldCgpO1xuICAgICAgcHVzaCh7IHR5cGU6IFwicmVzdW1lXCIgfSk7XG4gICAgfVxuICB9O1xuICAkKFwicmVzdW1lXCIpLm9uY2xpY2sgPSBvblJlc3VtZUNsaWNrO1xuICAkKFwiaGVyby1yZXN1bWVcIikub25jbGljayA9IG9uUmVzdW1lQ2xpY2s7XG4gIHN5bmNXYWtlVWkoKTtcbiAgaWYgKGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2Uud2FrZS1lbmFibGVkXCIpID09PSBcIjFcIiAmJiB3YWtlTGlzdC5sZW5ndGggPiAwKSB7XG4gICAgLy8gUmUtYXJtIGF1dG9tYXRpY2FsbHkgb24gcmVsb2FkIG9ubHkgd2hlbiBtaWNyb3Bob25lIHBlcm1pc3Npb24gaXMgYWxyZWFkeSBncmFudGVkLlxuICAgIHZvaWQgbmF2aWdhdG9yLnBlcm1pc3Npb25zPy5xdWVyeSh7IG5hbWU6IFwibWljcm9waG9uZVwiIGFzIFBlcm1pc3Npb25OYW1lIH0pXG4gICAgICAudGhlbigocCkgPT4geyBpZiAocC5zdGF0ZSA9PT0gXCJncmFudGVkXCIpIHZvaWQgYXJtV2FrZSh0cnVlLCBmYWxzZSk7IH0pXG4gICAgICAuY2F0Y2goKCkgPT4ge30pO1xuICB9XG4gIGlmIChzYXZlZEhpc3RvcnkoKS5sZW5ndGggPiAwKSB7XG4gICAgc3luY1Jlc3VtZUJ1dHRvbnModHJ1ZSk7XG4gICAgJChcInJlc3VtZVwiKS50aXRsZSA9IFwiQ2FsbCBhZ2FpbiwgY2Fycnlpbmcgb24gZnJvbSB0aGUgbGFzdCBjb252ZXJzYXRpb25cIjtcbiAgfVxuICAkKFwibWljXCIpLm9uY2xpY2sgPSAoKSA9PiBzZXRNdXRlZCghbXV0ZWQpO1xuICAkKFwiaHVzaFwiKS5vbmNsaWNrID0gKCkgPT4geyBwdXNoKHsgdHlwZTogXCJpbnRlcnJ1cHRcIiB9KTsgYXVkaW8uZmx1c2goKTsgfTtcbiAgJChcImNhbmNlbGFsbFwiKS5vbmNsaWNrID0gKCkgPT4gcHVzaCh7IHR5cGU6IFwiY2FuY2VsQWxsXCIgfSk7XG4gICQoXCJkb25lYm94XCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJ0b2dnbGVcIiwgKCkgPT4geyBpZiAoJDxIVE1MRGV0YWlsc0VsZW1lbnQ+KFwiZG9uZWJveFwiKS5vcGVuKSAkKFwiZG9uZWJveFwiKS5zY3JvbGxJbnRvVmlldyh7IGJsb2NrOiBcIm5lYXJlc3RcIiB9KTsgfSk7XG4gICQoXCJzYXlcIikub25zdWJtaXQgPSAoZSkgPT4gdm9pZCBzdWJtaXRUZXh0KGUpO1xuICAkKFwidGV4dFwiKS5hZGRFdmVudExpc3RlbmVyKFwiaW5wdXRcIiwgc3luY0NvbXBvc2VyKTtcbiAgY29uc3QgdHJhbnNjcmlwdFBhbmUgPSAkKFwidHJhbnNjcmlwdFwiKTtcbiAgdHJhbnNjcmlwdFBhbmUuYWRkRXZlbnRMaXN0ZW5lcihcInNjcm9sbFwiLCAoKSA9PiB0cmFuc2NyaXB0U2Nyb2xsLm9uU2Nyb2xsKCksIHsgcGFzc2l2ZTogdHJ1ZSB9KTtcbiAgdHJhbnNjcmlwdFBhbmUuYWRkRXZlbnRMaXN0ZW5lcihcInNjcm9sbGVuZFwiLCAoKSA9PiB0cmFuc2NyaXB0U2Nyb2xsLm9uU2Nyb2xsRW5kKCksIHsgcGFzc2l2ZTogdHJ1ZSB9KTtcbiAgdHJhbnNjcmlwdFBhbmUuYWRkRXZlbnRMaXN0ZW5lcihcIndoZWVsXCIsIChlKSA9PiB7IGlmIChlLmRlbHRhWSA8IDApIHRyYW5zY3JpcHRTY3JvbGwuY2FuY2VsSnVtcCgpOyB9LCB7IHBhc3NpdmU6IHRydWUgfSk7XG4gIHRyYW5zY3JpcHRQYW5lLmFkZEV2ZW50TGlzdGVuZXIoXCJ0b3VjaHN0YXJ0XCIsICgpID0+IHRyYW5zY3JpcHRTY3JvbGwuY2FuY2VsSnVtcCgpLCB7IHBhc3NpdmU6IHRydWUgfSk7XG4gIGlmICh0eXBlb2YgUmVzaXplT2JzZXJ2ZXIgIT09IFwidW5kZWZpbmVkXCIpIHtcbiAgICBuZXcgUmVzaXplT2JzZXJ2ZXIoKCkgPT4gdHJhbnNjcmlwdFNjcm9sbC5vblJlc2l6ZSgpKS5vYnNlcnZlKHRyYW5zY3JpcHRQYW5lKTtcbiAgICBuZXcgUmVzaXplT2JzZXJ2ZXIoKCkgPT4gdXBkYXRlQWxsUmVzdWx0Q2xhbXBpbmcoKSkub2JzZXJ2ZSgkKFwicmVzdWx0c1wiKSk7XG4gIH1cbiAgJChcImp1bXBib3R0b21cIikub25jbGljayA9ICgpID0+IHRyYW5zY3JpcHRTY3JvbGwuanVtcFRvQm90dG9tKCk7XG4gIHN5bmNDb21wb3NlcigpO1xuICBzeW5jU2lkZUxheW91dCgpO1xuICB0YWJzKCk7XG4gIGtleXMoKTtcbiAgY29uc3QgZXZlbnRzID0gbmV3IEV2ZW50U291cmNlKFwiL2V2ZW50c1wiKTtcbiAgZXZlbnRzLmFkZEV2ZW50TGlzdGVuZXIoXCJjb3JlXCIsIChlKSA9PiB7XG4gICAgY29uc3QgeyB2ZXJzaW9uIH0gPSBKU09OLnBhcnNlKChlIGFzIE1lc3NhZ2VFdmVudCkuZGF0YSk7XG4gICAgJChcInZlcnNpb25cIikudGV4dENvbnRlbnQgPSB2ZXJzaW9uICsgKGNhbGxJZCAmJiBjb3JlICYmIGNvcmUudmVyc2lvbiAhPT0gdmVyc2lvbiA/IGAgKG5leHQgY2FsbDsgdGhpcyBvbmUgcnVucyAke2NvcmUudmVyc2lvbn0pYCA6IFwiXCIpO1xuICAgICQoXCJidWlsZFwiKS50ZXh0Q29udGVudCA9IGBjb3JlICR7dmVyc2lvbn1gO1xuICB9KTtcbiAgZXZlbnRzLmFkZEV2ZW50TGlzdGVuZXIoXCJhcHBcIiwgKCkgPT4geyBpZiAoIWNhbGxJZCkgbG9jYXRpb24ucmVsb2FkKCk7IGVsc2UgdG9hc3QoXCJUaGUgcGFnZSBjaGFuZ2VkOiByZWxvYWQgYWZ0ZXIgdGhpcyBjYWxsXCIpOyB9KTtcbiAgZXZlbnRzLmFkZEV2ZW50TGlzdGVuZXIoXCJlcnJvclwiLCAoZSkgPT4ge1xuICAgIGNvbnN0IGRhdGEgPSAoZSBhcyBNZXNzYWdlRXZlbnQpLmRhdGE7XG4gICAgaWYgKGRhdGEpIHRvYXN0KGBCdWlsZCBmYWlsZWQ6ICR7SlNPTi5wYXJzZShkYXRhKS5tZXNzYWdlfWApO1xuICB9KTtcbiAgbmV3IFJlcGxheSgkKFwicmVwbGF5XCIpLCBsb2FkQ29yZSk7XG4gIHZvaWQgcGluZygpO1xuICB2b2lkIHNob3dFYXJsaWVyKCk7XG4gIHdpbmRvdy5zZXRJbnRlcnZhbCgoKSA9PiB2b2lkIHNob3dFYXJsaWVyKCksIDMwXzAwMCk7XG59XG5cbnZvaWQgbWFpbigpO1xuIl0sCiAgIm1hcHBpbmdzIjogIjtBQVNBLElBQU0sU0FBUyxvQkFBSSxJQUFJO0FBQUEsRUFDckI7QUFBQSxFQUFPO0FBQUEsRUFBTTtBQUFBLEVBQVE7QUFBQSxFQUFVO0FBQUEsRUFBTztBQUFBLEVBQVE7QUFBQSxFQUFNO0FBQUEsRUFBTTtBQUFBLEVBQU07QUFBQSxFQUFNO0FBQUEsRUFBVztBQUFBLEVBQVM7QUFBQSxFQUFRO0FBQUEsRUFBTztBQUFBLEVBQVU7QUFBQSxFQUFTO0FBQUEsRUFDNUg7QUFDRixDQUFDO0FBR00sU0FBUyxNQUFNLE1BQXdCO0FBQzVDLFNBQU8sS0FBSyxZQUFZLEVBQUUsUUFBUSxVQUFVLEVBQUUsRUFBRSxRQUFRLHFCQUFxQixHQUFHLEVBQUUsS0FBSyxFQUFFLE1BQU0sR0FBRyxFQUFFLE9BQU8sQ0FBQyxNQUFNLEVBQUUsU0FBUyxDQUFDO0FBQ2hJO0FBR08sU0FBUyxVQUFVLFdBQW1CLFVBQXlCLFFBQWtCLENBQUMsR0FBd0I7QUFDL0csUUFBTSxVQUFVLG9CQUFJLElBQUksQ0FBQyxHQUFHLFFBQVEsR0FBRyxNQUFNLFFBQVEsS0FBSyxDQUFDLENBQUM7QUFDNUQsUUFBTSxPQUFPLE1BQU0sU0FBUztBQUM1QixNQUFJLE9BQU87QUFDWCxN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
