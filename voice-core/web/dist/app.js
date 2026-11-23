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
      this.lastCut = null;
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
      if (!hushed && played < 0.8 && eventTime - a.briefAt < this.deliverMax) {
        this.readyBriefs.push(a.briefAt);
        this.lastCut = { at: eventTime, briefAt: a.briefAt };
      } else {
        this.lastCut = null;
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
      } else if (c.type === "log" && c.message === "not a stop after all" && this.lastStoppedBriefAt != null) {
        this.readyBriefs.push(this.lastStoppedBriefAt);
        this.lastStoppedBriefAt = null;
      }
    }
  }
  /**
   * Called immediately before pushing an event to the core. Returns any deferred unsuppressed
   * gap frames that must reach the core first so new playback cannot silence them.
   */
  beforePush(event, eventTime = 0) {
    let acceptedBrief = false;
    if (event.type === "brief.ready" && typeof event.id === "string") {
      const askedAt = this.requestedBriefs.get(event.id);
      if (askedAt !== void 0) {
        this.requestedBriefs.delete(event.id);
        const valid = eventTime - askedAt < this.briefWait && validBriefPcmBytes(event.pcm) > 0 && typeof event.text === "string" && event.text.trim().length > 0;
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL2NvbW1hbmRzLnRzIiwgIi4uL2F1ZGlvLnRzIiwgIi4uL3JlcGxheS50cyIsICIuLi9zY3JvbGwudHMiLCAiLi4vdWkudHMiLCAiLi4vd2FrZUNsaWVudC50cyIsICIuLi9hcHAudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFNwb2tlbiBjb21tYW5kcyB0aGUgY29yZSBhY3RzIG9uIHdpdGhvdXQgdGhlIG1vZGVsOiBcInN0b3BcIiBhbmQgXCJoYW5nIHVwXCIuIEFuIHV0dGVyYW5jZSBjb3VudHNcbi8vIG9ubHkgd2hlbiBpdCBpcyBvbmUgb2YgdGhlIHBocmFzZXMgYW5kIG5vdGhpbmcgbW9yZSwgb25jZSBuYW1lcyBhbmQgZmlsbGVycyBhcm91bmQgaXQgYXJlIGdvbmUsXG4vLyBzbyBcIldvb2Rob3VzZSwgc3RvcCBwbGVhc2VcIiBzdG9wcyBhbmQgXCJzdG9wIHRoZSBQZW5ueXdvcnRoIHRhc2tcIiBnb2VzIHRvIHRoZSBtb2RlbCBhcyB1c3VhbC5cblxuaW1wb3J0IHR5cGUgeyBWb2ljZUNvbW1hbmRzIH0gZnJvbSBcIi4vdHlwZXMudHNcIjtcblxuZXhwb3J0IHR5cGUgVm9pY2VDb21tYW5kID0gXCJzdG9wXCIgfCBcImhhbmdVcFwiIHwgXCJjYW5jZWxBbGxcIjtcblxuLyoqIFdvcmRzIHRoYXQgbWF5IGNvbWUgYmVmb3JlIG9yIGFmdGVyIGEgY29tbWFuZCB3aXRob3V0IGNoYW5naW5nIGl0LiAqL1xuY29uc3QgRklMTEVSID0gbmV3IFNldChbXG4gIFwiaGV5XCIsIFwib2tcIiwgXCJva2F5XCIsIFwicGxlYXNlXCIsIFwibm93XCIsIFwianVzdFwiLCBcInNvXCIsIFwidW1cIiwgXCJ1aFwiLCBcIm9oXCIsIFwiYWxyaWdodFwiLCBcInJpZ2h0XCIsIFwieWVhaFwiLCBcInllc1wiLCBcInRoYW5rc1wiLCBcInRoYW5rXCIsIFwieW91XCIsXG4gIFwiZ2VtaW5pXCIsXG5dKTtcblxuLyoqIFt0ZXh0XSBhcyBsb3dlci1jYXNlIHdvcmRzLCBhcG9zdHJvcGhlcyBkcm9wcGVkIChcIlRoYXQnc1wiIGlzIFwidGhhdHNcIikuICovXG5leHBvcnQgZnVuY3Rpb24gd29yZHModGV4dDogc3RyaW5nKTogc3RyaW5nW10ge1xuICByZXR1cm4gdGV4dC50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL1snXHUyMDE5YF0vZywgXCJcIikucmVwbGFjZSgvW15cXHB7TH1cXHB7TmR9XSsvZ3UsIFwiIFwiKS50cmltKCkuc3BsaXQoXCIgXCIpLmZpbHRlcigodykgPT4gdy5sZW5ndGggPiAwKTtcbn1cblxuLyoqIFRoZSBjb21tYW5kIFt1dHRlcmFuY2VdIGlzLCBpZiBpdCdzIG9uZSBhbmQgbm90aGluZyBtb3JlOyBbbmFtZXNdICh0aGUgYXNzaXN0YW50J3MsIFwiV29vZGhvdXNlXCIpIGRvbid0IGNvdW50LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbW1hbmRJbih1dHRlcmFuY2U6IHN0cmluZywgY29tbWFuZHM6IFZvaWNlQ29tbWFuZHMsIG5hbWVzOiBzdHJpbmdbXSA9IFtdKTogVm9pY2VDb21tYW5kIHwgbnVsbCB7XG4gIGNvbnN0IGlnbm9yZWQgPSBuZXcgU2V0KFsuLi5GSUxMRVIsIC4uLm5hbWVzLmZsYXRNYXAod29yZHMpXSk7XG4gIGNvbnN0IHNhaWQgPSB3b3Jkcyh1dHRlcmFuY2UpO1xuICBsZXQgZnJvbSA9IDA7XG4gIGxldCB0byA9IHNhaWQubGVuZ3RoO1xuICB3aGlsZSAoZnJvbSA8IHRvICYmIGlnbm9yZWQuaGFzKHNhaWRbZnJvbV0pKSBmcm9tKys7XG4gIHdoaWxlICh0byA+IGZyb20gJiYgaWdub3JlZC5oYXMoc2FpZFt0byAtIDFdKSkgdG8tLTtcbiAgaWYgKGZyb20gPT09IHRvIHx8IHRvIC0gZnJvbSA+IDUpIHJldHVybiBudWxsO1xuICBjb25zdCBjb3JlID0gc2FpZC5zbGljZShmcm9tLCB0bykuam9pbihcIiBcIik7XG4gIGNvbnN0IGlzID0gKHBocmFzZXM6IHN0cmluZ1tdKSA9PiBwaHJhc2VzLnNvbWUoKHApID0+IHdvcmRzKHApLmpvaW4oXCIgXCIpID09PSBjb3JlKTtcbiAgaWYgKGlzKGNvbW1hbmRzLmhhbmdVcCkpIHJldHVybiBcImhhbmdVcFwiO1xuICBpZiAoaXMoY29tbWFuZHMuY2FuY2VsQWxsID8/IFtdKSkgcmV0dXJuIFwiY2FuY2VsQWxsXCI7XG4gIGlmIChpcyhjb21tYW5kcy5zdG9wKSkgcmV0dXJuIFwic3RvcFwiO1xuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqIFdvcmRzIHRoYXQgdGFrZSBhIHJlcXVlc3QgYmFjay4gKi9cbmNvbnN0IENBTkNFTFMgPSAvXFxiKD86Y2FuY2VsXFx3KnxhYm9ydFxcdyp8a2lsbHxzY3JhcHxzY3JhdGNofGRyb3B8Zm9yZ2V0fHVuZG98dGVybWluYXRlfG5ldmVyID9taW5kfGNhbGwgKD86aXR8dGhhdHx0aGlzKSBvZmZ8KD86ZG9udHxkbyBub3QpICg/OmJvdGhlcnxuZWVkfHdhbnR8ZG8pfG5vIG5lZWR8bm8gbG9uZ2VyfG5vdCBhbnltb3JlfGxlYXZlIGl0fHNraXAgKD86aXR8dGhhdCkpXFxiLztcbmNvbnN0IFNUT1BTID0gL1xcYig/OnN0b3BcXHcqfGhhbHR8cXVpdHxlbmQpXFxiLztcblxuLyoqXG4gKiBXaGV0aGVyIFt1dHRlcmFuY2VdIGFza3MgZm9yIGEgdGFzayB0byBiZSBjYW5jZWxsZWQsIGZvciBhIGNhbmNlbF90YXNrIHRoZSBtb2RlbCBjYWxsZWQgb24gaXQuIFwiU3RvcFwiIGFsb25lIGFuZCB0aGVcbiAqIG90aGVyIHN0b3AgYW5kIGhhbmctdXAgcGhyYXNlcyBkb24ndDogdGhleSBtZWFuIHN0b3AgdGFsa2luZy4gT3RoZXJ3aXNlIGl0IGRvZXMgd2hlbiBpdCBzYXlzIHNvIGluIHdvcmRzLCB3aGVuIGl0XG4gKiBuYW1lcyB0aGUgdGFzayAoW25hbWVkXSksIG9yIHdoZW4gaXQgc2F5cyB0byBzdG9wIHNvbWV0aGluZyBtb3JlIHRoYW4gdGhlIHRhbGtpbmcgKFwic3RvcCB3b3JraW5nIG9uIHRoYXRcIikuXG4gKiBXb3JkcyB0aGF0IHNheSBub25lIG9mIHRoaXMgKGEgbWlzaGVhcmluZyBzdWNoIGFzIFwiU3RhYml0XCIpIGRvbid0LiBXaXRoIG5vdGhpbmcgaGVhcmQgdGhlcmUgaXMgbm90aGluZyB0byBqdWRnZSBieS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFza3NUb0NhbmNlbCh1dHRlcmFuY2U6IHN0cmluZywgY29tbWFuZHM6IFZvaWNlQ29tbWFuZHMsIG5hbWVzOiBzdHJpbmdbXSwgbmFtZWQ6IGJvb2xlYW4pOiBib29sZWFuIHtcbiAgY29uc3Qgc2FpZCA9IHdvcmRzKHV0dGVyYW5jZSkuam9pbihcIiBcIik7XG4gIGlmIChzYWlkLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHRydWU7XG4gIGNvbnN0IGNvbW1hbmQgPSBjb21tYW5kSW4odXR0ZXJhbmNlLCBjb21tYW5kcywgbmFtZXMpO1xuICBpZiAoY29tbWFuZCA9PT0gXCJzdG9wXCIgfHwgY29tbWFuZCA9PT0gXCJoYW5nVXBcIikgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gY29tbWFuZCA9PT0gXCJjYW5jZWxBbGxcIiB8fCBuYW1lZCB8fCBDQU5DRUxTLnRlc3Qoc2FpZCkgfHwgU1RPUFMudGVzdChzYWlkKTtcbn1cbiIsICIvLyBUaGUgYnJvd3NlcidzIG1pY3JvcGhvbmUgYW5kIHNwZWFrZXIgZm9yIGEgY2FsbDogMTYga0h6IFBDTTE2IGZyYW1lcyBvdXQgb2YgdGhlIG1pY3JvcGhvbmUsXG4vLyAyNCBrSHogUENNMTYgaW50byB0aGUgc3BlYWtlciwgYW5kIHRvbmVzIGxhaWQgb3ZlciB3aGF0ZXZlciBwbGF5cy4gQm90aCBydW4gaW4gQXVkaW9Xb3JrbGV0cyBvblxuLy8gb25lIEF1ZGlvQ29udGV4dCBhdCB0aGUgZGV2aWNlJ3MgcmF0ZSwgcmVzYW1wbGluZyB0aGVyZS5cblxuY29uc3QgV09SS0xFVFMgPSBgXG5jbGFzcyBDYXB0dXJlIGV4dGVuZHMgQXVkaW9Xb3JrbGV0UHJvY2Vzc29yIHtcbiAgY29uc3RydWN0b3IoKSB7XG4gICAgc3VwZXIoKTtcbiAgICB0aGlzLnN0ZXAgPSBzYW1wbGVSYXRlIC8gMTYwMDA7XG4gICAgdGhpcy5wb3MgPSAwO1xuICAgIHRoaXMuZnJhbWUgPSBuZXcgSW50MTZBcnJheSgzMjApO1xuICAgIHRoaXMubiA9IDA7XG4gICAgLy8gQSB3aW5kb3dlZC1zaW5jIGxvdy1wYXNzIGF0IDcga0h6LCBzbyBub3RoaW5nIGFib3ZlIDE2IGtIeidzIDgga0h6IGxpbWl0IGZvbGRzIGJhY2sgaW50byBzcGVlY2guXG4gICAgY29uc3QgdGFwcyA9IDQ3LCBjdXQgPSA3MDAwIC8gc2FtcGxlUmF0ZTtcbiAgICB0aGlzLnRhcHMgPSBuZXcgRmxvYXQzMkFycmF5KHRhcHMpO1xuICAgIGxldCBzdW0gPSAwO1xuICAgIGZvciAobGV0IGsgPSAwOyBrIDwgdGFwczsgaysrKSB7XG4gICAgICBjb25zdCBtID0gayAtICh0YXBzIC0gMSkgLyAyO1xuICAgICAgY29uc3Qgc2luYyA9IG0gPT09IDAgPyAyICogY3V0IDogTWF0aC5zaW4oMiAqIE1hdGguUEkgKiBjdXQgKiBtKSAvIChNYXRoLlBJICogbSk7XG4gICAgICBjb25zdCB3ID0gMC40MiAtIDAuNSAqIE1hdGguY29zKCgyICogTWF0aC5QSSAqIGspIC8gKHRhcHMgLSAxKSkgKyAwLjA4ICogTWF0aC5jb3MoKDQgKiBNYXRoLlBJICogaykgLyAodGFwcyAtIDEpKTtcbiAgICAgIHRoaXMudGFwc1trXSA9IHNpbmMgKiB3O1xuICAgICAgc3VtICs9IHRoaXMudGFwc1trXTtcbiAgICB9XG4gICAgZm9yIChsZXQgayA9IDA7IGsgPCB0YXBzOyBrKyspIHRoaXMudGFwc1trXSAvPSBzdW07XG4gICAgdGhpcy5oaXN0b3J5ID0gbmV3IEZsb2F0MzJBcnJheSh0YXBzKTtcbiAgICB0aGlzLmF0ID0gMDtcbiAgfVxuICBwcm9jZXNzKGlucHV0cykge1xuICAgIGNvbnN0IGlucHV0ID0gaW5wdXRzWzBdICYmIGlucHV0c1swXVswXTtcbiAgICBpZiAoIWlucHV0KSByZXR1cm4gdHJ1ZTtcbiAgICBjb25zdCB0YXBzID0gdGhpcy50YXBzLCBoID0gdGhpcy5oaXN0b3J5LCBuID0gdGFwcy5sZW5ndGg7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBpbnB1dC5sZW5ndGg7IGkrKykge1xuICAgICAgaFt0aGlzLmF0XSA9IGlucHV0W2ldO1xuICAgICAgdGhpcy5hdCA9ICh0aGlzLmF0ICsgMSkgJSBuO1xuICAgICAgLy8gT25seSB0aGUgc2FtcGxlcyBrZXB0IG5lZWQgZmlsdGVyaW5nOiBhdCBtb3N0IG9uZSBpbiBldmVyeSBzdGVwLlxuICAgICAgaWYgKHRoaXMucG9zID4gMSkgeyB0aGlzLnBvcyAtPSAxOyBjb250aW51ZTsgfVxuICAgICAgbGV0IHggPSAwO1xuICAgICAgZm9yIChsZXQgayA9IDAsIGogPSB0aGlzLmF0OyBrIDwgbjsgaysrLCBqID0gaiArIDEgPT09IG4gPyAwIDogaiArIDEpIHggKz0gdGFwc1trXSAqIGhbal07XG4gICAgICB3aGlsZSAodGhpcy5wb3MgPD0gMSkge1xuICAgICAgICBjb25zdCBzID0gTWF0aC5tYXgoLTEsIE1hdGgubWluKDEsIHgpKTtcbiAgICAgICAgdGhpcy5mcmFtZVt0aGlzLm4rK10gPSBzIDwgMCA/IHMgKiAzMjc2OCA6IHMgKiAzMjc2NztcbiAgICAgICAgaWYgKHRoaXMubiA9PT0gdGhpcy5mcmFtZS5sZW5ndGgpIHtcbiAgICAgICAgICB0aGlzLnBvcnQucG9zdE1lc3NhZ2UodGhpcy5mcmFtZS5idWZmZXIsIFt0aGlzLmZyYW1lLmJ1ZmZlcl0pO1xuICAgICAgICAgIHRoaXMuZnJhbWUgPSBuZXcgSW50MTZBcnJheSgzMjApO1xuICAgICAgICAgIHRoaXMubiA9IDA7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5wb3MgKz0gdGhpcy5zdGVwO1xuICAgICAgfVxuICAgICAgdGhpcy5wb3MgLT0gMTtcbiAgICB9XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbn1cblxuY2xhc3MgUGxheWJhY2sgZXh0ZW5kcyBBdWRpb1dvcmtsZXRQcm9jZXNzb3Ige1xuICBjb25zdHJ1Y3RvcigpIHtcbiAgICBzdXBlcigpO1xuICAgIHRoaXMucXVldWUgPSBbXTsgICAgICAvLyBGbG9hdDMyQXJyYXlzIGF0IHRoZSBjb250ZXh0J3MgcmF0ZVxuICAgIHRoaXMub2Zmc2V0ID0gMDtcbiAgICB0aGlzLmN1ZXMgPSBbXTtcbiAgICB0aGlzLmN1ZU9mZnNldCA9IDA7XG4gICAgdGhpcy5yZXBvcnRlZCA9IDA7XG4gICAgdGhpcy5wb3J0Lm9ubWVzc2FnZSA9IChlKSA9PiB7XG4gICAgICBjb25zdCBtID0gZS5kYXRhO1xuICAgICAgaWYgKG0udHlwZSA9PT0gXCJwbGF5XCIpIHRoaXMucXVldWUucHVzaChtLnNhbXBsZXMpO1xuICAgICAgZWxzZSBpZiAobS50eXBlID09PSBcImN1ZVwiKSB0aGlzLmN1ZXMucHVzaChtLnNhbXBsZXMpO1xuICAgICAgZWxzZSBpZiAobS50eXBlID09PSBcImZsdXNoXCIpIHsgdGhpcy5xdWV1ZSA9IFtdOyB0aGlzLm9mZnNldCA9IDA7IH1cbiAgICAgIGVsc2UgaWYgKG0udHlwZSA9PT0gXCJzdG9wXCIpIHsgdGhpcy5xdWV1ZSA9IFtdOyB0aGlzLm9mZnNldCA9IDA7IHRoaXMuY3VlcyA9IFtdOyB0aGlzLmN1ZU9mZnNldCA9IDA7IH1cbiAgICB9O1xuICB9XG4gIHByb2Nlc3MoXywgb3V0cHV0cykge1xuICAgIGNvbnN0IG91dCA9IG91dHB1dHNbMF1bMF07XG4gICAgb3V0LmZpbGwoMCk7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoICYmIHRoaXMucXVldWUubGVuZ3RoOyBpKyspIHtcbiAgICAgIG91dFtpXSA9IHRoaXMucXVldWVbMF1bdGhpcy5vZmZzZXQrK107XG4gICAgICBpZiAodGhpcy5vZmZzZXQgPj0gdGhpcy5xdWV1ZVswXS5sZW5ndGgpIHsgdGhpcy5xdWV1ZS5zaGlmdCgpOyB0aGlzLm9mZnNldCA9IDA7IH1cbiAgICB9XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoICYmIHRoaXMuY3Vlcy5sZW5ndGg7IGkrKykge1xuICAgICAgb3V0W2ldID0gTWF0aC5tYXgoLTEsIE1hdGgubWluKDEsIG91dFtpXSArIHRoaXMuY3Vlc1swXVt0aGlzLmN1ZU9mZnNldCsrXSkpO1xuICAgICAgaWYgKHRoaXMuY3VlT2Zmc2V0ID49IHRoaXMuY3Vlc1swXS5sZW5ndGgpIHsgdGhpcy5jdWVzLnNoaWZ0KCk7IHRoaXMuY3VlT2Zmc2V0ID0gMDsgfVxuICAgIH1cbiAgICBmb3IgKGxldCBjID0gMTsgYyA8IG91dHB1dHNbMF0ubGVuZ3RoOyBjKyspIG91dHB1dHNbMF1bY10uc2V0KG91dCk7XG4gICAgaWYgKGN1cnJlbnRUaW1lIC0gdGhpcy5yZXBvcnRlZCA+IDAuMSkge1xuICAgICAgdGhpcy5yZXBvcnRlZCA9IGN1cnJlbnRUaW1lO1xuICAgICAgbGV0IHF1ZXVlZCA9IC10aGlzLm9mZnNldDtcbiAgICAgIGZvciAoY29uc3QgcSBvZiB0aGlzLnF1ZXVlKSBxdWV1ZWQgKz0gcS5sZW5ndGg7XG4gICAgICB0aGlzLnBvcnQucG9zdE1lc3NhZ2UoeyBxdWV1ZWQ6IHF1ZXVlZCAvIHNhbXBsZVJhdGUgfSk7XG4gICAgfVxuICAgIHJldHVybiB0cnVlO1xuICB9XG59XG5yZWdpc3RlclByb2Nlc3NvcihcImNhcHR1cmVcIiwgQ2FwdHVyZSk7XG5yZWdpc3RlclByb2Nlc3NvcihcInBsYXliYWNrXCIsIFBsYXliYWNrKTtcbmA7XG5cbmZ1bmN0aW9uIGJhc2U2NFRvQnl0ZXMoYjY0OiBzdHJpbmcpOiBVaW50OEFycmF5IHtcbiAgY29uc3QgYmluID0gYXRvYihiNjQpO1xuICBjb25zdCBvdXQgPSBuZXcgVWludDhBcnJheShiaW4ubGVuZ3RoKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBiaW4ubGVuZ3RoOyBpKyspIG91dFtpXSA9IGJpbi5jaGFyQ29kZUF0KGkpO1xuICByZXR1cm4gb3V0O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYnl0ZXNUb0Jhc2U2NChieXRlczogVWludDhBcnJheSk6IHN0cmluZyB7XG4gIGxldCBiaW4gPSBcIlwiO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGJ5dGVzLmxlbmd0aDsgaSArPSAweDgwMDApIGJpbiArPSBTdHJpbmcuZnJvbUNoYXJDb2RlKC4uLmJ5dGVzLnN1YmFycmF5KGksIGkgKyAweDgwMDApKTtcbiAgcmV0dXJuIGJ0b2EoYmluKTtcbn1cblxuLyoqIFBDTTE2IGxpdHRsZS1lbmRpYW4gYXQgW3JhdGVdLCBhcyBmbG9hdHMgYXQgdGhlIGNvbnRleHQncyByYXRlLiAqL1xuZnVuY3Rpb24gdG9GbG9hdHMocGNtOiBVaW50OEFycmF5LCByYXRlOiBudW1iZXIsIHRhcmdldDogbnVtYmVyKTogRmxvYXQzMkFycmF5IHtcbiAgY29uc3QgdmlldyA9IG5ldyBEYXRhVmlldyhwY20uYnVmZmVyLCBwY20uYnl0ZU9mZnNldCwgcGNtLmJ5dGVMZW5ndGgpO1xuICBjb25zdCBuID0gTWF0aC5mbG9vcihwY20uYnl0ZUxlbmd0aCAvIDIpO1xuICBjb25zdCBvdXQgPSBuZXcgRmxvYXQzMkFycmF5KE1hdGguZmxvb3IoKG4gKiB0YXJnZXQpIC8gcmF0ZSkpO1xuICBjb25zdCBzdGVwID0gcmF0ZSAvIHRhcmdldDtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCB4ID0gaSAqIHN0ZXA7XG4gICAgY29uc3QgaiA9IE1hdGguZmxvb3IoeCk7XG4gICAgY29uc3QgYSA9IHZpZXcuZ2V0SW50MTYoMiAqIE1hdGgubWluKGosIG4gLSAxKSwgdHJ1ZSk7XG4gICAgY29uc3QgYiA9IHZpZXcuZ2V0SW50MTYoMiAqIE1hdGgubWluKGogKyAxLCBuIC0gMSksIHRydWUpO1xuICAgIG91dFtpXSA9IChhICsgKGIgLSBhKSAqICh4IC0gaikpIC8gMzI3Njg7XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBNaWNPcHRpb25zIHsgZWNob0NhbmNlbGxhdGlvbjogYm9vbGVhbjsgbm9pc2VTdXBwcmVzc2lvbjogYm9vbGVhbjsgYXV0b0dhaW5Db250cm9sOiBib29sZWFuIH1cblxuZXhwb3J0IGNsYXNzIENhbGxBdWRpbyB7XG4gIHByaXZhdGUgY29udGV4dDogQXVkaW9Db250ZXh0IHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgcGxheWJhY2s6IEF1ZGlvV29ya2xldE5vZGUgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBjYXB0dXJlOiBBdWRpb1dvcmtsZXROb2RlIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgc3RyZWFtOiBNZWRpYVN0cmVhbSB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIHNvdXJjZTogTWVkaWFTdHJlYW1BdWRpb1NvdXJjZU5vZGUgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBtaWNPcHRzOiBNaWNPcHRpb25zIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgb25NaWNGcmFtZTogKChzYW1wbGVzOiBJbnQxNkFycmF5LCBsZXZlbDogbnVtYmVyKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuICAvKiogSW5jcmVtZW50ZWQgb24gZXZlcnkgc3RhcnRNaWMvc3RvcE1pYyBzbyBzdXBlcnNlZGVkIG9yIGNhbmNlbGxlZCBnZXRVc2VyTWVkaWEgY2FsbHMgbmV2ZXIgbGVhayB0cmFja3MuICovXG4gIHByaXZhdGUgbWljR2VuID0gMDtcbiAgcHJpdmF0ZSBvcGVuaW5nOiBQcm9taXNlPHZvaWQ+IHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgc3RhdGVMaXN0ZW5lcjogKCgpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XG4gIC8qKiBTZWNvbmRzIG9mIHNwZWVjaCBxdWV1ZWQsIGFzIHRoZSB3b3JrbGV0IGxhc3Qgc2FpZC4gKi9cbiAgcXVldWVkID0gMDtcbiAgLyoqIFRoZSBtaWNyb3Bob25lJ3MgbGV2ZWwsIFJNUyBvZiB0aGUgbGFzdCBmcmFtZSAoMCB0byAxKS4gKi9cbiAgbGV2ZWwgPSAwO1xuXG4gIG9uQXVkaW9TdGF0ZUNoYW5nZShsaXN0ZW5lcjogKCgpID0+IHZvaWQpIHwgbnVsbCk6IHZvaWQge1xuICAgIHRoaXMuc3RhdGVMaXN0ZW5lciA9IGxpc3RlbmVyO1xuICB9XG5cbiAgLyoqIFRydWUgd2hlbiBhbiBBdWRpb0NvbnRleHQgZXhpc3RzIGJ1dCB0aGUgYnJvd3NlciBzdXNwZW5kZWQgaXQgcGVuZGluZyBhIHVzZXIgZ2VzdHVyZS4gKi9cbiAgZ2V0IGF1ZGlvU3VzcGVuZGVkKCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLmNvbnRleHQgIT0gbnVsbCAmJiB0aGlzLmNvbnRleHQuc3RhdGUgIT09IFwicnVubmluZ1wiO1xuICB9XG5cbiAgYXN5bmMgcmVzdW1lQXVkaW8oKTogUHJvbWlzZTxib29sZWFuPiB7XG4gICAgY29uc3QgY3R4ID0gdGhpcy5jb250ZXh0O1xuICAgIGlmICghY3R4KSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKGN0eC5zdGF0ZSA9PT0gXCJydW5uaW5nXCIpIHJldHVybiB0cnVlO1xuICAgIHRyeSB7IGF3YWl0IGN0eC5yZXN1bWUoKTsgfSBjYXRjaCB7fVxuICAgIHJldHVybiAoY3R4LnN0YXRlIGFzIEF1ZGlvQ29udGV4dFN0YXRlKSA9PT0gXCJydW5uaW5nXCI7XG4gIH1cblxuICBhc3luYyBvcGVuKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICh0aGlzLm9wZW5pbmcpIHtcbiAgICAgIGF3YWl0IHRoaXMub3BlbmluZztcbiAgICAgIGlmICh0aGlzLmNvbnRleHQ/LnN0YXRlID09PSBcInN1c3BlbmRlZFwiKSBhd2FpdCB0aGlzLmNvbnRleHQucmVzdW1lKCkuY2F0Y2goKCkgPT4ge30pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAodGhpcy5jb250ZXh0KSB7IGlmICh0aGlzLmNvbnRleHQuc3RhdGUgPT09IFwic3VzcGVuZGVkXCIpIGF3YWl0IHRoaXMuY29udGV4dC5yZXN1bWUoKS5jYXRjaCgoKSA9PiB7fSk7IHJldHVybjsgfVxuICAgIGNvbnN0IGluaXQgPSAoYXN5bmMgKCkgPT4ge1xuICAgICAgbGV0IGN0eDogQXVkaW9Db250ZXh0IHwgbnVsbCA9IG51bGw7XG4gICAgICB0cnkge1xuICAgICAgICBjdHggPSBuZXcgQXVkaW9Db250ZXh0KHsgbGF0ZW5jeUhpbnQ6IFwiaW50ZXJhY3RpdmVcIiB9KTtcbiAgICAgICAgY3R4Lm9uc3RhdGVjaGFuZ2UgPSAoKSA9PiB0aGlzLnN0YXRlTGlzdGVuZXI/LigpO1xuICAgICAgICBjb25zdCB1cmwgPSBVUkwuY3JlYXRlT2JqZWN0VVJMKG5ldyBCbG9iKFtXT1JLTEVUU10sIHsgdHlwZTogXCJ0ZXh0L2phdmFzY3JpcHRcIiB9KSk7XG4gICAgICAgIGF3YWl0IGN0eC5hdWRpb1dvcmtsZXQuYWRkTW9kdWxlKHVybCk7XG4gICAgICAgIGNvbnN0IHBsYXliYWNrID0gbmV3IEF1ZGlvV29ya2xldE5vZGUoY3R4LCBcInBsYXliYWNrXCIsIHsgbnVtYmVyT2ZJbnB1dHM6IDAsIG91dHB1dENoYW5uZWxDb3VudDogWzJdIH0pO1xuICAgICAgICBwbGF5YmFjay5wb3J0Lm9ubWVzc2FnZSA9IChlKSA9PiB7IHRoaXMucXVldWVkID0gZS5kYXRhLnF1ZXVlZDsgfTtcbiAgICAgICAgcGxheWJhY2suY29ubmVjdChjdHguZGVzdGluYXRpb24pO1xuICAgICAgICB0aGlzLmNvbnRleHQgPSBjdHg7XG4gICAgICAgIHRoaXMucGxheWJhY2sgPSBwbGF5YmFjaztcbiAgICAgICAgdGhpcy5zdGF0ZUxpc3RlbmVyPy4oKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICB0cnkgeyBhd2FpdCBjdHg/LmNsb3NlPy4oKTsgfSBjYXRjaCB7fVxuICAgICAgICB0aHJvdyBlcnI7XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICB0aGlzLm9wZW5pbmcgPSBudWxsO1xuICAgICAgfVxuICAgIH0pKCk7XG4gICAgdGhpcy5vcGVuaW5nID0gaW5pdDtcbiAgICBhd2FpdCBpbml0O1xuICB9XG5cbiAgLyoqIFNlY29uZHMgZnJvbSBhIHNhbXBsZSBsZWF2aW5nIHRoZSB3b3JrbGV0IHRvIHRoZSBzcGVha2VyLCBhcyB0aGUgYnJvd3NlciByZWNrb25zIGl0LiAqL1xuICBnZXQgb3V0cHV0TGF0ZW5jeSgpOiBudW1iZXIgfCBudWxsIHtcbiAgICBpZiAoIXRoaXMuY29udGV4dCkgcmV0dXJuIG51bGw7XG4gICAgcmV0dXJuIHRoaXMuY29udGV4dC5iYXNlTGF0ZW5jeSArICgodGhpcy5jb250ZXh0IGFzIEF1ZGlvQ29udGV4dCAmIHsgb3V0cHV0TGF0ZW5jeT86IG51bWJlciB9KS5vdXRwdXRMYXRlbmN5ID8/IDApO1xuICB9XG5cbiAgZ2V0IG1pY0FjdGl2ZSgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5jYXB0dXJlICE9IG51bGwgJiYgdGhpcy5zdHJlYW0gIT0gbnVsbCAmJiB0aGlzLnN0cmVhbS5nZXRUcmFja3MoKS5zb21lKCh0KSA9PiB0LnJlYWR5U3RhdGUgPT09IFwibGl2ZVwiKTtcbiAgfVxuXG4gIC8qKiBTdGFydHMgdGhlIG1pY3JvcGhvbmUgaWYgaXQgaXNuJ3QgYWxyZWFkeSBydW5uaW5nIHdpdGggdGhlIHNhbWUgb3B0aW9uczsgb3RoZXJ3aXNlIHN3YXBzIHRoZSBmcmFtZSBjYWxsYmFjayBjbGVhbmx5LiAqL1xuICBhc3luYyBlbnN1cmVNaWMob25GcmFtZTogKHNhbXBsZXM6IEludDE2QXJyYXksIGxldmVsOiBudW1iZXIpID0+IHZvaWQsIG9wdGlvbnM6IE1pY09wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAoXG4gICAgICB0aGlzLm1pY0FjdGl2ZSAmJlxuICAgICAgdGhpcy5taWNPcHRzICYmXG4gICAgICB0aGlzLm1pY09wdHMuZWNob0NhbmNlbGxhdGlvbiA9PT0gb3B0aW9ucy5lY2hvQ2FuY2VsbGF0aW9uICYmXG4gICAgICB0aGlzLm1pY09wdHMubm9pc2VTdXBwcmVzc2lvbiA9PT0gb3B0aW9ucy5ub2lzZVN1cHByZXNzaW9uICYmXG4gICAgICB0aGlzLm1pY09wdHMuYXV0b0dhaW5Db250cm9sID09PSBvcHRpb25zLmF1dG9HYWluQ29udHJvbFxuICAgICkge1xuICAgICAgYXdhaXQgdGhpcy5vcGVuKCk7XG4gICAgICB0aGlzLm9uTWljRnJhbWUgPSBvbkZyYW1lO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBhd2FpdCB0aGlzLnN0YXJ0TWljKG9uRnJhbWUsIG9wdGlvbnMpO1xuICB9XG5cbiAgYXN5bmMgc3RhcnRNaWMob25GcmFtZTogKHNhbXBsZXM6IEludDE2QXJyYXksIGxldmVsOiBudW1iZXIpID0+IHZvaWQsIG9wdGlvbnM6IE1pY09wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICB0aGlzLnN0b3BNaWMoKTtcbiAgICBjb25zdCBnZW4gPSArK3RoaXMubWljR2VuO1xuICAgIGF3YWl0IHRoaXMub3BlbigpO1xuICAgIGlmIChnZW4gIT09IHRoaXMubWljR2VuKSByZXR1cm47XG4gICAgY29uc3QgY29udGV4dCA9IHRoaXMuY29udGV4dCE7XG4gICAgY29uc3Qgc3RyZWFtID0gYXdhaXQgbmF2aWdhdG9yLm1lZGlhRGV2aWNlcy5nZXRVc2VyTWVkaWEoeyBhdWRpbzogeyBjaGFubmVsQ291bnQ6IDEsIC4uLm9wdGlvbnMgfSB9KTtcbiAgICBpZiAoZ2VuICE9PSB0aGlzLm1pY0dlbikge1xuICAgICAgc3RyZWFtLmdldFRyYWNrcygpLmZvckVhY2goKHQpID0+IHQuc3RvcCgpKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgbGV0IHNvdXJjZTogTWVkaWFTdHJlYW1BdWRpb1NvdXJjZU5vZGUgfCBudWxsID0gbnVsbDtcbiAgICBsZXQgY2FwdHVyZTogQXVkaW9Xb3JrbGV0Tm9kZSB8IG51bGwgPSBudWxsO1xuICAgIHRyeSB7XG4gICAgICBzb3VyY2UgPSBjb250ZXh0LmNyZWF0ZU1lZGlhU3RyZWFtU291cmNlKHN0cmVhbSk7XG4gICAgICBjYXB0dXJlID0gbmV3IEF1ZGlvV29ya2xldE5vZGUoY29udGV4dCwgXCJjYXB0dXJlXCIsIHsgbnVtYmVyT2ZPdXRwdXRzOiAwIH0pO1xuICAgICAgY2FwdHVyZS5wb3J0Lm9ubWVzc2FnZSA9IChlKSA9PiB7XG4gICAgICAgIGNvbnN0IGZyYW1lID0gbmV3IEludDE2QXJyYXkoZS5kYXRhIGFzIEFycmF5QnVmZmVyKTtcbiAgICAgICAgbGV0IHN1bSA9IDA7XG4gICAgICAgIGZvciAoY29uc3QgcyBvZiBmcmFtZSkgc3VtICs9IHMgKiBzO1xuICAgICAgICB0aGlzLmxldmVsID0gTWF0aC5zcXJ0KHN1bSAvIGZyYW1lLmxlbmd0aCkgLyAzMjc2ODtcbiAgICAgICAgdGhpcy5vbk1pY0ZyYW1lPy4oZnJhbWUsIHRoaXMubGV2ZWwpO1xuICAgICAgfTtcbiAgICAgIHNvdXJjZS5jb25uZWN0KGNhcHR1cmUpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgc291cmNlPy5kaXNjb25uZWN0KCk7XG4gICAgICBjYXB0dXJlPy5wb3J0LmNsb3NlKCk7XG4gICAgICBzdHJlYW0uZ2V0VHJhY2tzKCkuZm9yRWFjaCgodCkgPT4gdC5zdG9wKCkpO1xuICAgICAgdGhyb3cgZXJyO1xuICAgIH1cbiAgICB0aGlzLnN0cmVhbSA9IHN0cmVhbTtcbiAgICB0aGlzLm1pY09wdHMgPSB7IC4uLm9wdGlvbnMgfTtcbiAgICB0aGlzLm9uTWljRnJhbWUgPSBvbkZyYW1lO1xuICAgIHRoaXMuc291cmNlID0gc291cmNlO1xuICAgIHRoaXMuY2FwdHVyZSA9IGNhcHR1cmU7XG4gIH1cblxuICBzdG9wTWljKCk6IHZvaWQge1xuICAgIHRoaXMubWljR2VuKys7XG4gICAgdGhpcy5zb3VyY2U/LmRpc2Nvbm5lY3QoKTtcbiAgICB0aGlzLmNhcHR1cmU/LnBvcnQuY2xvc2UoKTtcbiAgICB0aGlzLnN0cmVhbT8uZ2V0VHJhY2tzKCkuZm9yRWFjaCgodCkgPT4gdC5zdG9wKCkpO1xuICAgIHRoaXMuc291cmNlID0gbnVsbDtcbiAgICB0aGlzLmNhcHR1cmUgPSBudWxsO1xuICAgIHRoaXMuc3RyZWFtID0gbnVsbDtcbiAgICB0aGlzLm1pY09wdHMgPSBudWxsO1xuICAgIHRoaXMub25NaWNGcmFtZSA9IG51bGw7XG4gICAgdGhpcy5sZXZlbCA9IDA7XG4gIH1cblxuICBwbGF5KHBjbTY0OiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuY29udGV4dCB8fCAhdGhpcy5wbGF5YmFjaykgcmV0dXJuO1xuICAgIGNvbnN0IHNhbXBsZXMgPSB0b0Zsb2F0cyhiYXNlNjRUb0J5dGVzKHBjbTY0KSwgMjQwMDAsIHRoaXMuY29udGV4dC5zYW1wbGVSYXRlKTtcbiAgICB0aGlzLnBsYXliYWNrLnBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcInBsYXlcIiwgc2FtcGxlcyB9LCBbc2FtcGxlcy5idWZmZXJdKTtcbiAgfVxuXG4gIGN1ZShwY202NDogc3RyaW5nKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLmNvbnRleHQgfHwgIXRoaXMucGxheWJhY2spIHJldHVybjtcbiAgICBjb25zdCBzYW1wbGVzID0gdG9GbG9hdHMoYmFzZTY0VG9CeXRlcyhwY202NCksIDI0MDAwLCB0aGlzLmNvbnRleHQuc2FtcGxlUmF0ZSk7XG4gICAgdGhpcy5wbGF5YmFjay5wb3J0LnBvc3RNZXNzYWdlKHsgdHlwZTogXCJjdWVcIiwgc2FtcGxlcyB9LCBbc2FtcGxlcy5idWZmZXJdKTtcbiAgfVxuXG4gIGZsdXNoKCk6IHZvaWQge1xuICAgIHRoaXMucGxheWJhY2s/LnBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcImZsdXNoXCIgfSk7XG4gIH1cblxuICBzdG9wUGxheWJhY2soKTogdm9pZCB7XG4gICAgdGhpcy5wbGF5YmFjaz8ucG9ydC5wb3N0TWVzc2FnZSh7IHR5cGU6IFwic3RvcFwiIH0pO1xuICAgIHRoaXMucXVldWVkID0gMDtcbiAgfVxuXG4gIHN0b3AoKTogdm9pZCB7XG4gICAgdGhpcy5zdG9wTWljKCk7XG4gICAgdGhpcy5zdG9wUGxheWJhY2soKTtcbiAgfVxufVxuIiwgIi8vIFRoZSByZXBsYXkgdmlldzogYSByZWNvcmRlZCBjYWxsIChhIHRyYWNlIGZyb20gYW55IGhvc3QsIG9yIGEgc2NlbmFyaW8pIHJ1biBhZ2FpbiB0aHJvdWdoIHRoZVxuLy8gY29yZSwgYXMgdGhlIGJ1aWxkIHRoYXQgcmVjb3JkZWQgaXQgZGlkIGFuZCBhcyB0aGUgbGF0ZXN0IGRvZXMsIHNpZGUgYnkgc2lkZS4gV2hlcmUgdGhleSBwYXJ0XG4vLyBpcyB3aGVyZSBhIGNoYW5nZSBpbiBzcmMvIGNoYW5nZWQgd2hhdCB0aGUgY2FsbCBkb2VzIHdpdGggdGhlIHNhbWUgd29yZHMgYW5kIHRoZSBzYW1lIG1vZGVsLlxuXG5pbnRlcmZhY2UgQ29yZSB7XG4gIHZlcnNpb246IHN0cmluZztcbiAgY3JlYXRlKGNvbmZpZzogc3RyaW5nLCB0OiBudW1iZXIpOiBzdHJpbmc7XG4gIHB1c2goaWQ6IG51bWJlciwgZXZlbnQ6IHN0cmluZyk6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFJlY29yZGluZyB7IHZlcnNpb24/OiBzdHJpbmc7IGNvbmZpZzogdW5rbm93bjsgc3RhcnQ6IG51bWJlcjsgZXZlbnRzOiBSZWNvcmQ8c3RyaW5nLCBhbnk+W10gfVxuXG4vKiogV2hhdCBhIGNvbW1hbmQgb3IgZXZlbnQgbG9va3MgbGlrZSBpbiBhIHRpbWVsaW5lOiBhdWRpbyBjdXQgb3V0LCBvbmUgbGluZS4gKi9cbmZ1bmN0aW9uIGxpbmUobzogUmVjb3JkPHN0cmluZywgYW55Pik6IHN0cmluZyB7XG4gIGNvbnN0IHRleHQgPSBKU09OLnN0cmluZ2lmeShvKS5yZXBsYWNlKC9cIihkYXRhfHBjbSlcIjpcIltBLVphLXowLTkrLz1dezQwLH1cIi9nLCAnXCIkMVwiOlwiXHUyMDI2XCInKVxuICAgIC5yZXBsYWNlKC9cXFxcXCJkYXRhXFxcXFwiOlxcXFxcIltBLVphLXowLTkrLz1dezQwLH1cXFxcXCIvZywgJ1xcXFxcImRhdGFcXFxcXCI6XFxcXFwiXHUyMDI2XFxcXFwiJyk7XG4gIHJldHVybiB0ZXh0Lmxlbmd0aCA+IDQwMCA/IHRleHQuc2xpY2UoMCwgNDAwKSArIFwiXHUyMDI2XCIgOiB0ZXh0O1xufVxuXG4vKiogQXVkaW8gYW5kIHRpY2tzIHNheSBub3RoaW5nIGEgcmVhZGVyIG5lZWRzOyB0aGUgcmVzdCBkb2VzLiAqL1xuZnVuY3Rpb24gdGVsbGluZyhvOiBSZWNvcmQ8c3RyaW5nLCBhbnk+KTogYm9vbGVhbiB7XG4gIGlmIChvLnR5cGUgPT09IFwibWljXCIgfHwgby50eXBlID09PSBcInRpY2tcIiB8fCBvLnR5cGUgPT09IFwicGxheVwiKSByZXR1cm4gZmFsc2U7XG4gIGlmIChvLnR5cGUgPT09IFwid3Muc2VuZFwiICYmIFN0cmluZyhvLmRhdGEpLnN0YXJ0c1dpdGgoJ3tcInJlYWx0aW1lSW5wdXRcIjp7XCJhdWRpb1wiJykpIHJldHVybiBmYWxzZTtcbiAgaWYgKG8udHlwZSA9PT0gXCJ3cy5tZXNzYWdlXCIgJiYgU3RyaW5nKG8uZGF0YSkuaW5jbHVkZXMoJ1wiaW5saW5lRGF0YVwiJykgJiYgIVN0cmluZyhvLmRhdGEpLmluY2x1ZGVzKCdcInR1cm5Db21wbGV0ZVwiJykpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmZ1bmN0aW9uIHJ1bihjb3JlOiBDb3JlLCByOiBSZWNvcmRpbmcpOiBzdHJpbmdbXVtdIHtcbiAgY29uc3QgY3JlYXRlZCA9IEpTT04ucGFyc2UoY29yZS5jcmVhdGUoSlNPTi5zdHJpbmdpZnkoci5jb25maWcpLCByLnN0YXJ0KSk7XG4gIGNvbnN0IG91dDogc3RyaW5nW11bXSA9IFtjcmVhdGVkLmNvbW1hbmRzLmZpbHRlcih0ZWxsaW5nKS5tYXAobGluZSldO1xuICBmb3IgKGNvbnN0IGUgb2Ygci5ldmVudHMpIG91dC5wdXNoKChKU09OLnBhcnNlKGNvcmUucHVzaChjcmVhdGVkLmlkLCBKU09OLnN0cmluZ2lmeShlKSkpIGFzIFJlY29yZDxzdHJpbmcsIGFueT5bXSkuZmlsdGVyKHRlbGxpbmcpLm1hcChsaW5lKSk7XG4gIHJldHVybiBvdXQ7XG59XG5cbmV4cG9ydCBjbGFzcyBSZXBsYXkge1xuICBwcml2YXRlIHJlYWRvbmx5IHJvb3Q6IEhUTUxFbGVtZW50O1xuICBwcml2YXRlIHJlYWRvbmx5IGxvYWQ6ICh1cmw/OiBzdHJpbmcpID0+IFByb21pc2U8Q29yZT47XG5cbiAgY29uc3RydWN0b3Iocm9vdDogSFRNTEVsZW1lbnQsIGxvYWQ6ICh1cmw/OiBzdHJpbmcpID0+IFByb21pc2U8Q29yZT4pIHtcbiAgICB0aGlzLnJvb3QgPSByb290O1xuICAgIHRoaXMubG9hZCA9IGxvYWQ7XG4gICAgcm9vdC5pbm5lckhUTUwgPSBgXG4gICAgICA8aDI+VHJhY2UgcmVwbGF5PC9oMj5cbiAgICAgIDxkaXYgY2xhc3M9XCJiYXJcIj48c2VsZWN0IGNsYXNzPVwicGlja1wiIGFyaWEtbGFiZWw9XCJSZWNvcmRpbmdcIj48L3NlbGVjdD48YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cInJlZnJlc2hcIiB0aXRsZT1cIlJlZnJlc2ggbGlzdFwiIGFyaWEtbGFiZWw9XCJSZWZyZXNoIGxpc3RcIj5cdTIxQkI8L2J1dHRvbj48YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cImdvXCI+UmVwbGF5PC9idXR0b24+XG4gICAgICA8bGFiZWwgY2xhc3M9XCJ0b2dnbGUtYWxsXCI+PGlucHV0IHR5cGU9XCJjaGVja2JveFwiIGNsYXNzPVwiYWxsXCI+IFNob3cgYXVkaW8gYW5kIHRpY2tzPC9sYWJlbD48c3BhbiBjbGFzcz1cInN1bW1hcnlcIj48L3NwYW4+PC9kaXY+XG4gICAgICA8ZGl2IGNsYXNzPVwidGltZWxpbmVcIj48L2Rpdj5gO1xuICAgIChyb290LnF1ZXJ5U2VsZWN0b3IoXCIucmVmcmVzaFwiKSBhcyBIVE1MRWxlbWVudCkub25jbGljayA9ICgpID0+IHZvaWQgdGhpcy5saXN0KCk7XG4gICAgKHJvb3QucXVlcnlTZWxlY3RvcihcIi5nb1wiKSBhcyBIVE1MRWxlbWVudCkub25jbGljayA9ICgpID0+IHZvaWQgdGhpcy5yZXBsYXkoKS5jYXRjaCgoZXJyKSA9PiB0aGlzLnNheShgUmVwbGF5IGZhaWxlZDogJHtlcnIubWVzc2FnZX1gKSk7XG4gICAgdm9pZCB0aGlzLmxpc3QoKTtcbiAgfVxuXG4gIHByaXZhdGUgc2F5KHRleHQ6IHN0cmluZykge1xuICAgICh0aGlzLnJvb3QucXVlcnlTZWxlY3RvcihcIi5zdW1tYXJ5XCIpIGFzIEhUTUxFbGVtZW50KS50ZXh0Q29udGVudCA9IHRleHQ7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGxpc3QoKSB7XG4gICAgY29uc3QgcGljayA9IHRoaXMucm9vdC5xdWVyeVNlbGVjdG9yKFwiLnBpY2tcIikgYXMgSFRNTFNlbGVjdEVsZW1lbnQ7XG4gICAgcGljay5pbm5lckhUTUwgPSBcIlwiO1xuICAgIGNvbnN0IHRyYWNlczogeyBuYW1lOiBzdHJpbmc7IGJ5dGVzOiBudW1iZXIgfVtdID0gYXdhaXQgKGF3YWl0IGZldGNoKFwiL3RyYWNlc1wiKSkuanNvbigpO1xuICAgIGNvbnN0IHNjZW5hcmlvczogc3RyaW5nW10gPSBhd2FpdCAoYXdhaXQgZmV0Y2goXCIvc2NlbmFyaW9zXCIpKS5qc29uKCk7XG4gICAgY29uc3QgdHJhY2VHcm91cCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJvcHRncm91cFwiKTtcbiAgICB0cmFjZUdyb3VwLmxhYmVsID0gXCJSZWNvcmRlZCBjYWxsc1wiO1xuICAgIGZvciAoY29uc3QgdCBvZiB0cmFjZXMpIHRyYWNlR3JvdXAuYXBwZW5kKG5ldyBPcHRpb24oYCR7dC5uYW1lfSAoJHtNYXRoLnJvdW5kKHQuYnl0ZXMgLyAxMDI0KX0gS0IpYCwgYC90cmFjZXMvJHt0Lm5hbWV9YCkpO1xuICAgIGNvbnN0IHNjZW5hcmlvR3JvdXAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwib3B0Z3JvdXBcIik7XG4gICAgc2NlbmFyaW9Hcm91cC5sYWJlbCA9IFwiU2NlbmFyaW9zXCI7XG4gICAgZm9yIChjb25zdCBzIG9mIHNjZW5hcmlvcykgc2NlbmFyaW9Hcm91cC5hcHBlbmQobmV3IE9wdGlvbihzLCBgL3NjZW5hcmlvcy8ke3N9Lmpzb25gKSk7XG4gICAgcGljay5hcHBlbmQodHJhY2VHcm91cCwgc2NlbmFyaW9Hcm91cCk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHJlY29yZGluZyh1cmw6IHN0cmluZyk6IFByb21pc2U8UmVjb3JkaW5nPiB7XG4gICAgY29uc3QgdGV4dCA9IGF3YWl0IChhd2FpdCBmZXRjaCh1cmwsIHsgY2FjaGU6IFwibm8tc3RvcmVcIiB9KSkudGV4dCgpO1xuICAgIGlmICh1cmwuZW5kc1dpdGgoXCIuanNvblwiKSkgcmV0dXJuIEpTT04ucGFyc2UodGV4dCk7XG4gICAgY29uc3QgW2hlYWRlciwgLi4uZXZlbnRzXSA9IHRleHQudHJpbSgpLnNwbGl0KFwiXFxuXCIpLm1hcCgobCkgPT4gSlNPTi5wYXJzZShsKSk7XG4gICAgcmV0dXJuIHsgLi4uaGVhZGVyLCBldmVudHMgfTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgcmVwbGF5KCkge1xuICAgIGNvbnN0IHVybCA9ICh0aGlzLnJvb3QucXVlcnlTZWxlY3RvcihcIi5waWNrXCIpIGFzIEhUTUxTZWxlY3RFbGVtZW50KS52YWx1ZTtcbiAgICBpZiAoIXVybCkgcmV0dXJuO1xuICAgIGNvbnN0IHIgPSBhd2FpdCB0aGlzLnJlY29yZGluZyh1cmwpO1xuICAgIGNvbnN0IGxhdGVzdCA9IGF3YWl0IHRoaXMubG9hZCgpO1xuICAgIGxldCByZWNvcmRlZDogQ29yZSB8IG51bGwgPSBudWxsO1xuICAgIGlmIChyLnZlcnNpb24gJiYgci52ZXJzaW9uICE9PSBsYXRlc3QudmVyc2lvbikge1xuICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChgL3ZlcnNpb25zLyR7ci52ZXJzaW9ufS5qc2AsIHsgbWV0aG9kOiBcIkhFQURcIiB9KTtcbiAgICAgIGlmIChyZXNwb25zZS5vaykgcmVjb3JkZWQgPSBhd2FpdCB0aGlzLmxvYWQoYC92ZXJzaW9ucy8ke3IudmVyc2lvbn0uanNgKTtcbiAgICB9XG4gICAgY29uc3Qgbm93ID0gcnVuKGxhdGVzdCwgcik7XG4gICAgY29uc3QgdGhlbiA9IHJlY29yZGVkID8gcnVuKHJlY29yZGVkLCByKSA6IG51bGw7XG4gICAgY29uc3QgYWxsID0gKHRoaXMucm9vdC5xdWVyeVNlbGVjdG9yKFwiLmFsbFwiKSBhcyBIVE1MSW5wdXRFbGVtZW50KS5jaGVja2VkO1xuICAgIGNvbnN0IHRpbWVsaW5lID0gdGhpcy5yb290LnF1ZXJ5U2VsZWN0b3IoXCIudGltZWxpbmVcIikgYXMgSFRNTEVsZW1lbnQ7XG4gICAgdGltZWxpbmUuaW5uZXJIVE1MID0gXCJcIjtcbiAgICBsZXQgZmlyc3QgPSAtMTtcbiAgICBsZXQgZGlmZmVyID0gMDtcbiAgICBjb25zdCByb3dzOiBIVE1MRWxlbWVudFtdID0gW107XG4gICAgY29uc3QgYWRkID0gKGNsczogc3RyaW5nLCB0OiBzdHJpbmcsIHRleHQ6IHN0cmluZykgPT4ge1xuICAgICAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgIHJvdy5jbGFzc05hbWUgPSBgcm93ICR7Y2xzfWA7XG4gICAgICByb3cuaW5uZXJIVE1MID0gYDxzcGFuIGNsYXNzPVwidFwiPiR7dH08L3NwYW4+YDtcbiAgICAgIGNvbnN0IGIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgICAgIGIuY2xhc3NOYW1lID0gXCJiXCI7XG4gICAgICBiLnRleHRDb250ZW50ID0gdGV4dDtcbiAgICAgIHJvdy5hcHBlbmQoYik7XG4gICAgICB0aW1lbGluZS5hcHBlbmQocm93KTtcbiAgICAgIHJvd3MucHVzaChyb3cpO1xuICAgICAgcmV0dXJuIHJvdztcbiAgICB9O1xuICAgIGNvbnN0IHQwID0gci5zdGFydDtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8PSByLmV2ZW50cy5sZW5ndGg7IGkrKykge1xuICAgICAgY29uc3QgZSA9IGkgPT09IDAgPyBudWxsIDogci5ldmVudHNbaSAtIDFdO1xuICAgICAgY29uc3Qgbm93T3V0ID0gbm93W2ldO1xuICAgICAgY29uc3QgdGhlbk91dCA9IHRoZW4gPyB0aGVuW2ldIDogbm93T3V0O1xuICAgICAgY29uc3Qgc2FtZSA9IG5vd091dC5sZW5ndGggPT09IHRoZW5PdXQubGVuZ3RoICYmIG5vd091dC5ldmVyeSgoYywgaikgPT4gYyA9PT0gdGhlbk91dFtqXSk7XG4gICAgICBpZiAoIXNhbWUpIHsgZGlmZmVyKys7IGlmIChmaXJzdCA8IDApIGZpcnN0ID0gaTsgfVxuICAgICAgaWYgKCFzYW1lIHx8IGFsbCB8fCAoZSAmJiB0ZWxsaW5nKGUpKSB8fCBub3dPdXQubGVuZ3RoID4gMCkge1xuICAgICAgICBpZiAoZSAmJiAoYWxsIHx8IHRlbGxpbmcoZSkgfHwgIXNhbWUpKSBhZGQoXCJpblwiLCAoZS50IC0gdDApLnRvRml4ZWQoMiksIGxpbmUoZSkpO1xuICAgICAgICBjb25zdCB0ID0gZSA/IChlLnQgLSB0MCkudG9GaXhlZCgyKSA6IFwiMC4wMFwiO1xuICAgICAgICBpZiAoc2FtZSkgZm9yIChjb25zdCBjIG9mIG5vd091dCkgYWRkKFwib3V0XCIsIHQsIGMpO1xuICAgICAgICBlbHNlIHtcbiAgICAgICAgICBmb3IgKGNvbnN0IGMgb2YgdGhlbk91dCkgYWRkKFwib3V0IGdvbmVcIiwgdCwgYFx1MjIxMiAke2N9YCk7XG4gICAgICAgICAgZm9yIChjb25zdCBjIG9mIG5vd091dCkgYWRkKFwib3V0IG5ld1wiLCB0LCBgKyAke2N9YCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgY29uc3QgdmVyc2lvbnMgPSB0aGVuID8gYHJlY29yZGVkIGJ5ICR7ci52ZXJzaW9ufSwgcmVwbGF5ZWQgYnkgaXQgYW5kIGJ5ICR7bGF0ZXN0LnZlcnNpb259YCA6IGByZXBsYXllZCBieSAke2xhdGVzdC52ZXJzaW9ufWAgK1xuICAgICAgKHIudmVyc2lvbiAmJiByLnZlcnNpb24gIT09IGxhdGVzdC52ZXJzaW9uID8gYCAodGhlIHJlY29yZGluZydzIGJ1aWxkICR7ci52ZXJzaW9ufSBpc24ndCBrZXB0IGhlcmUpYCA6IFwiXCIpO1xuICAgIHRoaXMuc2F5KGAke3IuZXZlbnRzLmxlbmd0aH0gZXZlbnRzLCAke3ZlcnNpb25zfS4gYCArICh0aGVuID8gKGRpZmZlciA/IGAke2RpZmZlcn0gZXZlbnRzIGFuc3dlcmVkIGRpZmZlcmVudGx5LCB0aGUgZmlyc3QgYXQgZXZlbnQgJHtmaXJzdH0uYCA6IFwiQm90aCBhbnN3ZXJlZCBldmVyeSBldmVudCB0aGUgc2FtZS5cIikgOiBcIlwiKSk7XG4gICAgaWYgKGZpcnN0ID49IDApIHRpbWVsaW5lLnF1ZXJ5U2VsZWN0b3IoXCIuZ29uZSwgLm5ld1wiKT8uc2Nyb2xsSW50b1ZpZXcoeyBibG9jazogXCJjZW50ZXJcIiB9KTtcbiAgfVxufVxuIiwgIi8qKiBNaW5pbWFsIHNjcm9sbGluZyBwYW5lIHN1cmZhY2Ugc28gYXV0by1zY3JvbGwgbG9naWMgc3RheXMgdGVzdGFibGUgd2l0aG91dCBhIGJyb3dzZXIgRE9NLiAqL1xuZXhwb3J0IGludGVyZmFjZSBTY3JvbGxQYW5lIHtcbiAgc2Nyb2xsVG9wOiBudW1iZXI7XG4gIHJlYWRvbmx5IHNjcm9sbEhlaWdodDogbnVtYmVyO1xuICByZWFkb25seSBjbGllbnRIZWlnaHQ6IG51bWJlcjtcbiAgc2Nyb2xsVG8/KG9wdGlvbnM6IHsgdG9wOiBudW1iZXI7IGJlaGF2aW9yPzogU2Nyb2xsQmVoYXZpb3IgfSk6IHZvaWQ7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXV0b1Njcm9sbGVyT3B0aW9ucyB7XG4gIC8qKiBEaXN0YW5jZSBmcm9tIHRoZSBib3R0b20gKHB4KSB0aGF0IHN0aWxsIGNvdW50cyBhcyBwaW5uZWQuICovXG4gIHBpblRocmVzaG9sZD86IG51bWJlcjtcbiAgLyoqIERpc3RhbmNlIGZyb20gdGhlIGJvdHRvbSAocHgpIHBhc3Qgd2hpY2ggdGhlIGp1bXAtdG8tbGF0ZXN0IGNvbnRyb2wgaXMgc2hvd24uICovXG4gIGp1bXBUaHJlc2hvbGQ/OiBudW1iZXI7XG4gIC8qKiBDYWxsZWQgd2hlbmV2ZXIgdGhlIGp1bXAtdG8tbGF0ZXN0IGNvbnRyb2wncyB2aXNpYmlsaXR5IG1heSBoYXZlIGNoYW5nZWQuICovXG4gIG9uSnVtcENoYW5nZT86IChzaG93OiBib29sZWFuKSA9PiB2b2lkO1xuICAvKiogV2hlbiB0cnVlIChmb3IgZXhhbXBsZSB3aGlsZSB0aGUgZW1wdHkgc3RhdGUgaXMgc2hvd24pLCBrZWVwIHRoZSBqdW1wIGNvbnRyb2wgaGlkZGVuLiAqL1xuICBpc0VtcHR5PzogKCkgPT4gYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBLZWVwcyBhIHRyYW5zY3JpcHQgcGFuZSBwaW5uZWQgdG8gdGhlIGJvdHRvbSBhcyBtZXNzYWdlcyBzdHJlYW0gaW4sIHdpdGhvdXQgbWVhc3VyaW5nXG4gKiBuZWFyLWJvdHRvbSBhZnRlciBhbiBhcHBlbmQgaGFzIGFscmVhZHkgZ3Jvd24gc2Nyb2xsSGVpZ2h0LCBhbmQgeWllbGRzIGltbWVkaWF0ZWx5IHdoZW5cbiAqIHRoZSB1c2VyIHNjcm9sbHMgdXAgdG8gcmVhZCBlYXJsaWVyIG1lc3NhZ2VzLlxuICovXG5leHBvcnQgY2xhc3MgQXV0b1Njcm9sbGVyIHtcbiAgcHJpdmF0ZSByZWFkb25seSBwYW5lOiBTY3JvbGxQYW5lO1xuICBwcml2YXRlIHJlYWRvbmx5IHBpblRocmVzaG9sZDogbnVtYmVyO1xuICBwcml2YXRlIHJlYWRvbmx5IGp1bXBUaHJlc2hvbGQ6IG51bWJlcjtcbiAgcHJpdmF0ZSByZWFkb25seSBvbkp1bXBDaGFuZ2U/OiAoc2hvdzogYm9vbGVhbikgPT4gdm9pZDtcbiAgcHJpdmF0ZSByZWFkb25seSBpc0VtcHR5PzogKCkgPT4gYm9vbGVhbjtcbiAgcHJpdmF0ZSBwaW5uZWQgPSB0cnVlO1xuICBwcml2YXRlIGp1bXBpbmcgPSBmYWxzZTtcbiAgcHJpdmF0ZSBsYXN0U2Nyb2xsVG9wID0gMDtcblxuICBjb25zdHJ1Y3RvcihwYW5lOiBTY3JvbGxQYW5lLCBvcHRpb25zOiBBdXRvU2Nyb2xsZXJPcHRpb25zID0ge30pIHtcbiAgICB0aGlzLnBhbmUgPSBwYW5lO1xuICAgIHRoaXMucGluVGhyZXNob2xkID0gb3B0aW9ucy5waW5UaHJlc2hvbGQgPz8gMzI7XG4gICAgdGhpcy5qdW1wVGhyZXNob2xkID0gb3B0aW9ucy5qdW1wVGhyZXNob2xkID8/IDEyMDtcbiAgICB0aGlzLm9uSnVtcENoYW5nZSA9IG9wdGlvbnMub25KdW1wQ2hhbmdlO1xuICAgIHRoaXMuaXNFbXB0eSA9IG9wdGlvbnMuaXNFbXB0eTtcbiAgICB0aGlzLmxhc3RTY3JvbGxUb3AgPSBwYW5lLnNjcm9sbFRvcDtcbiAgfVxuXG4gIGdldCBpc1Bpbm5lZCgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5waW5uZWQ7XG4gIH1cblxuICBwcml2YXRlIGRpc3RhbmNlKCk6IG51bWJlciB7XG4gICAgcmV0dXJuIE1hdGgubWF4KDAsIHRoaXMucGFuZS5zY3JvbGxIZWlnaHQgLSB0aGlzLnBhbmUuc2Nyb2xsVG9wIC0gdGhpcy5wYW5lLmNsaWVudEhlaWdodCk7XG4gIH1cblxuICBwcml2YXRlIGlzVmlzaWJsZSgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5wYW5lLmNsaWVudEhlaWdodCA+IDA7XG4gIH1cblxuICBwcml2YXRlIHNuYXBUb0JvdHRvbSgpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuaXNWaXNpYmxlKCkpIHJldHVybjtcbiAgICB0aGlzLnBhbmUuc2Nyb2xsVG9wID0gdGhpcy5wYW5lLnNjcm9sbEhlaWdodDtcbiAgICB0aGlzLmxhc3RTY3JvbGxUb3AgPSB0aGlzLnBhbmUuc2Nyb2xsVG9wO1xuICB9XG5cbiAgcHJpdmF0ZSB1cGRhdGVKdW1wKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5vbkp1bXBDaGFuZ2UpIHJldHVybjtcbiAgICBjb25zdCBlbXB0eSA9IHRoaXMuaXNFbXB0eT8uKCkgPz8gZmFsc2U7XG4gICAgY29uc3Qgc2hvdyA9ICFlbXB0eSAmJiB0aGlzLmlzVmlzaWJsZSgpICYmICF0aGlzLmp1bXBpbmcgJiYgdGhpcy5kaXN0YW5jZSgpID4gdGhpcy5qdW1wVGhyZXNob2xkO1xuICAgIHRoaXMub25KdW1wQ2hhbmdlKHNob3cpO1xuICB9XG5cbiAgLyoqIENhbGwgYWZ0ZXIgY29udGVudCBpcyBhZGRlZCwgdXBkYXRlZCwgb3IgcmVtb3ZlZCBpbiB0aGUgcGFuZS4gKi9cbiAgb25Db250ZW50KGZvcmNlID0gZmFsc2UpOiB2b2lkIHtcbiAgICBpZiAoZm9yY2UpIHtcbiAgICAgIHRoaXMucGlubmVkID0gdHJ1ZTtcbiAgICAgIHRoaXMuanVtcGluZyA9IGZhbHNlO1xuICAgIH1cbiAgICBpZiAodGhpcy5waW5uZWQpIHtcbiAgICAgIGlmICh0aGlzLmp1bXBpbmcgJiYgdGhpcy5wYW5lLnNjcm9sbFRvICYmIHRoaXMuaXNWaXNpYmxlKCkpIHtcbiAgICAgICAgdGhpcy5wYW5lLnNjcm9sbFRvKHsgdG9wOiB0aGlzLnBhbmUuc2Nyb2xsSGVpZ2h0LCBiZWhhdmlvcjogXCJzbW9vdGhcIiB9KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMuc25hcFRvQm90dG9tKCk7XG4gICAgICB9XG4gICAgfVxuICAgIHRoaXMudXBkYXRlSnVtcCgpO1xuICB9XG5cbiAgLyoqIENhbGwgd2hlbiB0aGUgcGFuZSdzIHZpZXdwb3J0IHJlc2l6ZXMgKGJhcnMgYXBwZWFyaW5nLCBrZXlib2FyZCwgdGFiIHN3aXRjaCkuICovXG4gIG9uUmVzaXplKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5pc1Zpc2libGUoKSkgcmV0dXJuO1xuICAgIGlmICh0aGlzLnBpbm5lZCkge1xuICAgICAgdGhpcy5qdW1waW5nID0gZmFsc2U7XG4gICAgICB0aGlzLnNuYXBUb0JvdHRvbSgpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLmxhc3RTY3JvbGxUb3AgPSB0aGlzLnBhbmUuc2Nyb2xsVG9wO1xuICAgIH1cbiAgICB0aGlzLnVwZGF0ZUp1bXAoKTtcbiAgfVxuXG4gIC8qKiBDYWxsIGZyb20gdGhlIHBhbmUncyBzY3JvbGwgZXZlbnQgbGlzdGVuZXIuICovXG4gIG9uU2Nyb2xsKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5pc1Zpc2libGUoKSkgcmV0dXJuO1xuICAgIGNvbnN0IHRvcCA9IHRoaXMucGFuZS5zY3JvbGxUb3A7XG4gICAgY29uc3QgZGlzdCA9IHRoaXMuZGlzdGFuY2UoKTtcbiAgICBjb25zdCBtb3ZlZFVwID0gdG9wIDwgdGhpcy5sYXN0U2Nyb2xsVG9wO1xuICAgIHRoaXMubGFzdFNjcm9sbFRvcCA9IHRvcDtcblxuICAgIGlmIChkaXN0IDw9IHRoaXMucGluVGhyZXNob2xkKSB7XG4gICAgICB0aGlzLnBpbm5lZCA9IHRydWU7XG4gICAgICB0aGlzLmp1bXBpbmcgPSBmYWxzZTtcbiAgICB9IGVsc2UgaWYgKG1vdmVkVXApIHtcbiAgICAgIHRoaXMucGlubmVkID0gZmFsc2U7XG4gICAgICB0aGlzLmp1bXBpbmcgPSBmYWxzZTtcbiAgICB9XG4gICAgdGhpcy51cGRhdGVKdW1wKCk7XG4gIH1cblxuICAvKiogQ2FsbCBmcm9tIHRoZSBwYW5lJ3Mgc2Nyb2xsZW5kIGV2ZW50IGxpc3RlbmVyLiAqL1xuICBvblNjcm9sbEVuZCgpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuaXNWaXNpYmxlKCkgfHwgIXRoaXMuanVtcGluZykgcmV0dXJuO1xuICAgIHRoaXMuanVtcGluZyA9IGZhbHNlO1xuICAgIGlmICh0aGlzLmRpc3RhbmNlKCkgPiB0aGlzLnBpblRocmVzaG9sZCkgdGhpcy5waW5uZWQgPSBmYWxzZTtcbiAgICB0aGlzLnVwZGF0ZUp1bXAoKTtcbiAgfVxuXG4gIC8qKiBDYWxsIG9uIHVzZXIgd2hlZWwtdXAgb3IgdG91Y2hzdGFydCBzbyBhbiBhY3RpdmUgc21vb3RoIGp1bXAgeWllbGRzIHRvIHRoZSB1c2VyLiAqL1xuICBjYW5jZWxKdW1wKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5qdW1waW5nKSByZXR1cm47XG4gICAgdGhpcy5qdW1waW5nID0gZmFsc2U7XG4gICAgaWYgKHRoaXMuaXNWaXNpYmxlKCkpIHtcbiAgICAgIGNvbnN0IHRvcCA9IHRoaXMucGFuZS5zY3JvbGxUb3A7XG4gICAgICBpZiAodGhpcy5wYW5lLnNjcm9sbFRvKSB0aGlzLnBhbmUuc2Nyb2xsVG8oeyB0b3AsIGJlaGF2aW9yOiBcImluc3RhbnRcIiB9KTtcbiAgICAgIGVsc2UgdGhpcy5wYW5lLnNjcm9sbFRvcCA9IHRvcDtcbiAgICAgIHRoaXMubGFzdFNjcm9sbFRvcCA9IHRoaXMucGFuZS5zY3JvbGxUb3A7XG4gICAgICBpZiAodGhpcy5kaXN0YW5jZSgpID4gdGhpcy5waW5UaHJlc2hvbGQpIHRoaXMucGlubmVkID0gZmFsc2U7XG4gICAgfVxuICAgIHRoaXMudXBkYXRlSnVtcCgpO1xuICB9XG5cbiAgLyoqIFJlLXBpbiBhbmQgc2Nyb2xsIHNtb290aGx5IHRvIHRoZSBib3R0b20gKHVzZWQgYnkgdGhlIGp1bXAtdG8tbGF0ZXN0IGJ1dHRvbikuICovXG4gIGp1bXBUb0JvdHRvbSgpOiB2b2lkIHtcbiAgICB0aGlzLnBpbm5lZCA9IHRydWU7XG4gICAgaWYgKCF0aGlzLmlzVmlzaWJsZSgpKSB7XG4gICAgICB0aGlzLnVwZGF0ZUp1bXAoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHRoaXMuZGlzdGFuY2UoKSA8PSB0aGlzLnBpblRocmVzaG9sZCB8fCAhdGhpcy5wYW5lLnNjcm9sbFRvKSB7XG4gICAgICB0aGlzLmp1bXBpbmcgPSBmYWxzZTtcbiAgICAgIHRoaXMuc25hcFRvQm90dG9tKCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuanVtcGluZyA9IHRydWU7XG4gICAgICB0aGlzLmxhc3RTY3JvbGxUb3AgPSB0aGlzLnBhbmUuc2Nyb2xsVG9wO1xuICAgICAgdGhpcy5wYW5lLnNjcm9sbFRvKHsgdG9wOiB0aGlzLnBhbmUuc2Nyb2xsSGVpZ2h0LCBiZWhhdmlvcjogXCJzbW9vdGhcIiB9KTtcbiAgICB9XG4gICAgdGhpcy51cGRhdGVKdW1wKCk7XG4gIH1cblxuICAvKiogUmVjb21wdXRlIHBpbm5lZCBzdGF0ZSBmcm9tIHRoZSBjdXJyZW50IHBvc2l0aW9uIGFmdGVyIGEgdXNlci1kcml2ZW4gbGF5b3V0IGNoYW5nZSAoZS5nLiBleHBhbmRpbmcgYSByZXN1bHQpLiAqL1xuICBzeW5jRnJvbVBvc2l0aW9uKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5pc1Zpc2libGUoKSkgcmV0dXJuO1xuICAgIHRoaXMuanVtcGluZyA9IGZhbHNlO1xuICAgIHRoaXMubGFzdFNjcm9sbFRvcCA9IHRoaXMucGFuZS5zY3JvbGxUb3A7XG4gICAgdGhpcy5waW5uZWQgPSB0aGlzLmRpc3RhbmNlKCkgPD0gdGhpcy5waW5UaHJlc2hvbGQ7XG4gICAgdGhpcy51cGRhdGVKdW1wKCk7XG4gIH1cblxuICAvKiogUGF1c2UgYXV0by1zY3JvbGwgZXhwbGljaXRseSAoZS5nLiB3aGVuIHJldmVhbGluZyBhbiBvbGRlciByZXN1bHQgY2FyZCkuICovXG4gIHVucGluKCk6IHZvaWQge1xuICAgIHRoaXMucGlubmVkID0gZmFsc2U7XG4gICAgdGhpcy5qdW1waW5nID0gZmFsc2U7XG4gICAgdGhpcy51cGRhdGVKdW1wKCk7XG4gIH1cbn1cbiIsICIvLyBQdXJlIFVJIGhlbHBlcnMgZm9yIHRoZSBWb2ljZSB3ZWIgc3VyZmFjZSAoZGVuc2l0eSwgYWdlbnQtcGFuZSBmaWx0ZXJpbmcsIGNvbXBhY3QgcHJldmlld3MpLlxuXG5leHBvcnQgdHlwZSBTaWRlRmlsdGVyID0gXCJhbGxcIiB8IFwiYWN0aXZlXCIgfCBcInJlc3VsdHNcIjtcbmV4cG9ydCB0eXBlIERlbnNpdHkgPSBcImNvbXBhY3RcIiB8IFwiY29tZm9ydGFibGVcIjtcblxuZXhwb3J0IGludGVyZmFjZSBTaWRlQ291bnRzIHtcbiAgYWN0aXZlOiBudW1iZXI7XG4gIHJlc3VsdHM6IG51bWJlcjtcbiAgZWFybGllcjogbnVtYmVyO1xuICBkb25lOiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2lkZVZpc2liaWxpdHkge1xuICBzaG93VGFza3NTZWN0aW9uOiBib29sZWFuO1xuICBzaG93RW1wdHlUYXNrczogYm9vbGVhbjtcbiAgc2hvd1Jlc3VsdHNTZWN0aW9uOiBib29sZWFuO1xuICBzaG93RW1wdHlSZXN1bHRzOiBib29sZWFuO1xuICBzaG93RWFybGllclNlY3Rpb246IGJvb2xlYW47XG4gIHNob3dEb25lU2VjdGlvbjogYm9vbGVhbjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZURlbnNpdHkodmFsdWU6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQpOiBEZW5zaXR5IHtcbiAgcmV0dXJuIHZhbHVlID09PSBcImNvbWZvcnRhYmxlXCIgPyBcImNvbWZvcnRhYmxlXCIgOiBcImNvbXBhY3RcIjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZVNpZGVGaWx0ZXIodmFsdWU6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQpOiBTaWRlRmlsdGVyIHtcbiAgaWYgKHZhbHVlID09PSBcImFjdGl2ZVwiIHx8IHZhbHVlID09PSBcInJlc3VsdHNcIikgcmV0dXJuIHZhbHVlO1xuICByZXR1cm4gXCJhbGxcIjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlUHJlZml4KHRleHQ6IHN0cmluZyk6IHsgbW9kZTogXCJoZXJtZXNcIiB8IFwidDNcIiB8IG51bGw7IHJlc3Q6IHN0cmluZyB9IHtcbiAgY29uc3QgbSA9IHRleHQubWF0Y2goL15cXC8odDN8Y29kZXxofGhlcm1lcylcXHMrKC4qKSQvaXMpO1xuICBpZiAoIW0pIHJldHVybiB7IG1vZGU6IG51bGwsIHJlc3Q6IHRleHQgfTtcbiAgcmV0dXJuIHsgbW9kZTogL14odDN8Y29kZSkkL2kudGVzdChtWzFdKSA/IFwidDNcIiA6IFwiaGVybWVzXCIsIHJlc3Q6IG1bMl0udHJpbSgpIH07XG59XG5cbi8qKiBBIHJlc3VsdCBjYXJkIG1heSBvbmx5IHN0ZWVyIGEgdGFzayB0aGF0IGJlbG9uZ3MgdG8gdGhlIHNhbWUgYWN0aXZlIHNlc3Npb24gKHRhc2sgSURzIHJlc3RhcnQgcGVyIGNhbGwpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNhbkZvbGxvd1VwUmVzdWx0KHJlc3VsdFNlc3Npb246IG51bWJlciwgYWN0aXZlU2Vzc2lvbjogbnVtYmVyLCBoYXNUYXNrOiBib29sZWFuKTogYm9vbGVhbiB7XG4gIHJldHVybiBhY3RpdmVTZXNzaW9uID4gMCAmJiByZXN1bHRTZXNzaW9uID09PSBhY3RpdmVTZXNzaW9uICYmIGhhc1Rhc2s7XG59XG5cbi8qKiBVbnJlYWQgbW9iaWxlIHJlc3VsdCBhbGVydHMgb25seSBjbGVhciBvbmNlIHRoZSBSZXN1bHRzIHNlY3Rpb24gaXMgYWN0dWFsbHkgdmlzaWJsZSB0byB0aGUgdXNlci4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzaG91bGRDbGVhclVucmVhZFJlc3VsdHMoaXNNb2JpbGU6IGJvb2xlYW4sIGRyYXdlck9wZW46IGJvb2xlYW4sIGZpbHRlcjogU2lkZUZpbHRlcik6IGJvb2xlYW4ge1xuICByZXR1cm4gIWlzTW9iaWxlIHx8IChkcmF3ZXJPcGVuICYmIGZpbHRlciAhPT0gXCJhY3RpdmVcIik7XG59XG5cbi8qKiBQaWNrIHRoZSBmaWx0ZXIgdG8gc2hvdyB3aGVuIHRhcHBpbmcgdGhlIG1vYmlsZSBsaXZlLXN0YXR1cyBiYW5uZXIgc28gdGhlIGFkdmVydGlzZWQgaXRlbSBpcyB2aXNpYmxlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVNb2JpbGVCYW5uZXJGaWx0ZXIoY3VycmVudDogU2lkZUZpbHRlciwgYWN0aXZlVG90YWw6IG51bWJlciwgdW5yZWFkUmVzdWx0czogbnVtYmVyKTogU2lkZUZpbHRlciB7XG4gIGlmIChhY3RpdmVUb3RhbCA+IDApIHJldHVybiBjdXJyZW50ID09PSBcInJlc3VsdHNcIiA/IFwiYWxsXCIgOiBjdXJyZW50O1xuICBpZiAodW5yZWFkUmVzdWx0cyA+IDApIHJldHVybiBcInJlc3VsdHNcIjtcbiAgcmV0dXJuIGN1cnJlbnQ7XG59XG5cbi8qKiBGbGF0dGVuIGEgTWFya2Rvd24gYWdlbnQgcmVwbHkgaW50byBhIHNpbmdsZS1saW5lIHBsYWluLXRleHQgcHJldmlldyBmb3IgaW5saW5lIGhhbmRvZmYgY2hpcHMuICovXG5leHBvcnQgZnVuY3Rpb24gcGxhaW5QcmV2aWV3KHRleHQ6IHN0cmluZywgbWF4TGVuID0gMTUwKTogc3RyaW5nIHtcbiAgY29uc3QgY2xlYW5lZCA9IHRleHRcbiAgICAucmVwbGFjZSgvYGBgW15cXG5dKlxcbj8oW1xcc1xcU10qPylgYGAvZywgKF8sIGNvZGU6IHN0cmluZykgPT4gYCAke2NvZGUudHJpbSgpfSBgKVxuICAgIC5yZXBsYWNlKC9cXFsoW15cXF1cXG5dKylcXF1cXCgoaHR0cHM/OlxcL1xcL1teXFxzKV0rKVxcKS9nLCBcIiQxXCIpXG4gICAgLnJlcGxhY2UoL14jezEsNn1cXHMrL2dtLCBcIlwiKVxuICAgIC5yZXBsYWNlKC9eXFxzKig/OlstKlx1MjAyMl18XFxkK1suKV0pXFxzKy9nbSwgXCJcIilcbiAgICAucmVwbGFjZSgvYChbXmBcXG5dKylgL2csIFwiJDFcIilcbiAgICAucmVwbGFjZSgvXFwqXFwqKFteKlxcbl0rKVxcKlxcKi9nLCBcIiQxXCIpXG4gICAgLnJlcGxhY2UoL19fKFteX1xcbl0rKV9fL2csIFwiJDFcIilcbiAgICAucmVwbGFjZSgvXFxzKy9nLCBcIiBcIilcbiAgICAudHJpbSgpO1xuICBpZiAoY2xlYW5lZC5sZW5ndGggPD0gbWF4TGVuKSByZXR1cm4gY2xlYW5lZDtcbiAgY29uc3QgY3V0ID0gY2xlYW5lZC5zbGljZSgwLCBtYXhMZW4pO1xuICBjb25zdCBzcGFjZSA9IGN1dC5sYXN0SW5kZXhPZihcIiBcIik7XG4gIGNvbnN0IGJhc2UgPSBzcGFjZSA+IE1hdGguZmxvb3IobWF4TGVuICogMC42KSA/IGN1dC5zbGljZSgwLCBzcGFjZSkgOiBjdXQ7XG4gIHJldHVybiBgJHtiYXNlLnJlcGxhY2UoL1suLDs6XFxzLV0rJC8sIFwiXCIpfVx1MjAyNmA7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXRTaG9ydFRpbWUoZGF0ZTogRGF0ZSk6IHN0cmluZyB7XG4gIGNvbnN0IHBhZCA9IChuOiBudW1iZXIpID0+IFN0cmluZyhuKS5wYWRTdGFydCgyLCBcIjBcIik7XG4gIHJldHVybiBgJHtwYWQoZGF0ZS5nZXRIb3VycygpKX06JHtwYWQoZGF0ZS5nZXRNaW51dGVzKCkpfWA7XG59XG5cbi8qKiBEZWNpZGUgd2hpY2ggc2VjdGlvbnMgb2YgdGhlIHJpZ2h0LWhhbmQgQWdlbnQgV29ya3NwYWNlIGFyZSB2aXNpYmxlIGZvciBhIGdpdmVuIGZpbHRlciBhbmQgY291bnRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVTaWRlU2VjdGlvbnMoZmlsdGVyOiBTaWRlRmlsdGVyLCBjb3VudHM6IFNpZGVDb3VudHMpOiBTaWRlVmlzaWJpbGl0eSB7XG4gIGlmIChmaWx0ZXIgPT09IFwicmVzdWx0c1wiKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHNob3dUYXNrc1NlY3Rpb246IGZhbHNlLFxuICAgICAgc2hvd0VtcHR5VGFza3M6IGZhbHNlLFxuICAgICAgc2hvd1Jlc3VsdHNTZWN0aW9uOiB0cnVlLFxuICAgICAgc2hvd0VtcHR5UmVzdWx0czogY291bnRzLnJlc3VsdHMgPT09IDAsXG4gICAgICBzaG93RWFybGllclNlY3Rpb246IGZhbHNlLFxuICAgICAgc2hvd0RvbmVTZWN0aW9uOiBmYWxzZSxcbiAgICB9O1xuICB9XG4gIGlmIChmaWx0ZXIgPT09IFwiYWN0aXZlXCIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc2hvd1Rhc2tzU2VjdGlvbjogdHJ1ZSxcbiAgICAgIHNob3dFbXB0eVRhc2tzOiBjb3VudHMuYWN0aXZlID09PSAwICYmIGNvdW50cy5lYXJsaWVyID09PSAwLFxuICAgICAgc2hvd1Jlc3VsdHNTZWN0aW9uOiBmYWxzZSxcbiAgICAgIHNob3dFbXB0eVJlc3VsdHM6IGZhbHNlLFxuICAgICAgc2hvd0VhcmxpZXJTZWN0aW9uOiBjb3VudHMuZWFybGllciA+IDAsXG4gICAgICBzaG93RG9uZVNlY3Rpb246IGNvdW50cy5kb25lID4gMCxcbiAgICB9O1xuICB9XG4gIC8vIFwiYWxsXCI6IGhpZGUgdGhlIGVtcHR5IGFjdGl2ZS10YXNrcyBwbGFjZWhvbGRlciBhcyBzb29uIGFzIHJlc3VsdHMgb3IgZWFybGllciBhZ2VudHMgZXhpc3RcbiAgLy8gc28gZmluaXNoZWQgcmVzcG9uc2VzIHRha2UgdGhlIHRvcCBvZiB0aGUgcGFuZSB3aXRob3V0IHdhc3RlZCBzcGFjZS5cbiAgY29uc3QgaGFzQW55dGhpbmdBYm92ZURvbmUgPSBjb3VudHMuYWN0aXZlID4gMCB8fCBjb3VudHMucmVzdWx0cyA+IDAgfHwgY291bnRzLmVhcmxpZXIgPiAwO1xuICByZXR1cm4ge1xuICAgIHNob3dUYXNrc1NlY3Rpb246IGNvdW50cy5hY3RpdmUgPiAwIHx8ICFoYXNBbnl0aGluZ0Fib3ZlRG9uZSxcbiAgICBzaG93RW1wdHlUYXNrczogIWhhc0FueXRoaW5nQWJvdmVEb25lLFxuICAgIHNob3dSZXN1bHRzU2VjdGlvbjogY291bnRzLnJlc3VsdHMgPiAwLFxuICAgIHNob3dFbXB0eVJlc3VsdHM6IGZhbHNlLFxuICAgIHNob3dFYXJsaWVyU2VjdGlvbjogY291bnRzLmVhcmxpZXIgPiAwLFxuICAgIHNob3dEb25lU2VjdGlvbjogY291bnRzLmRvbmUgPiAwLFxuICB9O1xufVxuIiwgIi8vIE1haW4tdGhyZWFkIGNvbnRyb2xsZXIgZm9yIHRoZSB3YWtlIHdvcmQgV2ViIFdvcmtlciBhbmQgU2NyZWVuIFdha2UgTG9jayBoZWxwZXIuXG4vLyBUYWdzIGV2ZXJ5IGxvYWQgYW5kIHJlc2V0IHdpdGggYSBtb25vdG9uaWMgZ2VuZXJhdGlvbiAoYGdlbmApIHNvIHN0YWxlIGRldGVjdGlvbnMgb3IgcmVhZHkgZXZlbnRzXG4vLyBhZnRlciBhIG1vZGVsIHN3aXRjaCBvciByZXNldCBhcmUgaWdub3JlZCwgYW5kIGtlZXBzIGEgc2hvcnQgcmluZyBidWZmZXIgb2YgcmVjZW50IGZlZCBjaHVua3Ncbi8vIGluZGV4ZWQgYnkgYHNlcWAgKHdpdGggcGVyLWZyYW1lIGBzdXBwcmVzc2VkYCBmbGFncykgc28gYXVkaW8gY2FwdHVyZWQgd2hpbGUgdGhlIHdvcmtlciB3YXNcbi8vIHNjb3JpbmcgaXMgcHJlc2VydmVkIGluIGBoaXQudHJhaWxpbmdgIHdpdGhvdXQgZHVwbGljYXRpbmcgdW5zdXBwcmVzc2VkIGZyYW1lcy5cblxuZXhwb3J0IGludGVyZmFjZSBXYWtlVGVsZW1ldHJ5IHtcbiAgc2NvcmU6IG51bWJlcjtcbiAgcGVhazogbnVtYmVyO1xuICBnYXRlT3BlbjogYm9vbGVhbjtcbiAgZnJhbWVzOiBudW1iZXI7XG4gIHNjb3JlZDogbnVtYmVyO1xuICBpbmZlck1zOiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgV2FrZVRyYWlsaW5nQ2h1bmsge1xuICAvKiogU2VxdWVuY2UgbnVtYmVyIGZyb20gYGZlZWQoKWAsIG1hdGNoaW5nIHRoZSBmZWQgY2h1bmsuICovXG4gIHNlcTogbnVtYmVyO1xuICBieXRlczogVWludDhBcnJheTtcbiAgLyoqIFRydWUgd2hlbiB0aGUgY29yZSBzdXBwcmVzc2VkIChzaWxlbmNlZCkgdGhpcyBmcmFtZSBkdXJpbmcgYXVkaWJsZSBwbGF5YmFjayAoYHdoaWxlU3BlYWtpbmcgIT09IFwic2VuZFwiYCkuICovXG4gIHN1cHByZXNzZWQ6IGJvb2xlYW47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgV2FrZURldGVjdGlvbkV2ZW50IHtcbiAgc2NvcmU6IG51bWJlcjtcbiAgYXRGcmFtZTogbnVtYmVyO1xuICAvKiogQXVkaW8gY2h1bmtzIHNwb2tlbiBhZnRlciB0aGUgd2FrZSB3b3JkOiB0aGUgdHJpZ2dlcmluZyBjaHVuaydzIHRhaWwgcGx1cyBhbnkgY2h1bmtzIGFscmVhZHkgc2VudCBhZnRlciBpdC4gKi9cbiAgdHJhaWxpbmc6IFdha2VUcmFpbGluZ0NodW5rW107XG4gIGluZmVyTXM6IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBXYWtlQ2xpZW50Q2FsbGJhY2tzIHtcbiAgb25SZWFkeT86IChtb2RlbElkOiBzdHJpbmcsIHdhcm11cE1zOiBudW1iZXIpID0+IHZvaWQ7XG4gIG9uRGV0ZWN0ZWQ6IChoaXQ6IFdha2VEZXRlY3Rpb25FdmVudCkgPT4gdm9pZDtcbiAgb25UZWxlbWV0cnk/OiAodDogV2FrZVRlbGVtZXRyeSkgPT4gdm9pZDtcbiAgLyoqIENhbGxlZCBvbmNlIGFsbCBpbi1mbGlnaHQgc3VwcHJlc3NlZCBmcmFtZXMgaGF2ZSBiZWVuIHNjb3JlZCB3aXRob3V0IGZpcmluZyBhIGRldGVjdGlvbi4gKi9cbiAgb25TdXBwcmVzc2VkU2V0dGxlZD86ICgpID0+IHZvaWQ7XG4gIG9uRXJyb3I/OiAobWVzc2FnZTogc3RyaW5nKSA9PiB2b2lkO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFdvcmtlckxpa2Uge1xuICBvbm1lc3NhZ2U6ICgoZTogTWVzc2FnZUV2ZW50PFJlY29yZDxzdHJpbmcsIGFueT4+KSA9PiB2b2lkKSB8IG51bGw7XG4gIG9uZXJyb3I6ICgoZTogRXJyb3JFdmVudCkgPT4gdm9pZCkgfCBudWxsO1xuICBwb3N0TWVzc2FnZShtZXNzYWdlOiB1bmtub3duLCB0cmFuc2Zlcj86IFRyYW5zZmVyYWJsZVtdKTogdm9pZDtcbiAgdGVybWluYXRlKCk6IHZvaWQ7XG59XG5cbi8qKiBNYXggYnVmZmVyZWQgcG9zdC1mZWVkIGF1ZGlvICh+MS41IHMgYXQgMjAgbXMgY2h1bmtzKSB0byBjb3ZlciB3b3JrZXIgc2NvcmluZyBsYXRlbmN5LiAqL1xuY29uc3QgUkVDRU5UX01BWF9CWVRFUyA9IE1hdGgucm91bmQoMS41ICogMzJfMDAwKTtcblxuZXhwb3J0IGNsYXNzIFdha2VDbGllbnQge1xuICBwcml2YXRlIHdvcmtlcjogV29ya2VyTGlrZSB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIHJlYWRvbmx5IGNhbGxiYWNrczogV2FrZUNsaWVudENhbGxiYWNrcztcbiAgcHJpdmF0ZSByZWFkb25seSBjcmVhdGVXb3JrZXI6ICgpID0+IFdvcmtlckxpa2U7XG4gIHByaXZhdGUgbG9hZGVkTW9kZWxJZDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgbG9hZGluZ01vZGVsSWQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIGN1cnJlbnRUaHJlc2hvbGQgPSAwLjc7XG4gIHByaXZhdGUgZ2VuID0gMDtcbiAgcHJpdmF0ZSBzZXEgPSAwO1xuICBwcml2YXRlIGxhc3RTdXBwcmVzc2VkU2VxID0gMDtcbiAgcHJpdmF0ZSBsYXN0QWNrZWRTZXEgPSAwO1xuICBwcml2YXRlIHJlY2VudDogeyBzZXE6IG51bWJlcjsgYnl0ZXM6IFVpbnQ4QXJyYXk7IHN1cHByZXNzZWQ6IGJvb2xlYW4gfVtdID0gW107XG4gIHByaXZhdGUgcmVjZW50Qnl0ZXMgPSAwO1xuICByZWFkeSA9IGZhbHNlO1xuXG4gIGNvbnN0cnVjdG9yKFxuICAgIGNhbGxiYWNrczogV2FrZUNsaWVudENhbGxiYWNrcyxcbiAgICBjcmVhdGVXb3JrZXI6ICgpID0+IFdvcmtlckxpa2UgPSAoKSA9PiBuZXcgV29ya2VyKFwiL3dha2Uud29ya2VyLmpzXCIsIHsgdHlwZTogXCJtb2R1bGVcIiB9KSxcbiAgKSB7XG4gICAgdGhpcy5jYWxsYmFja3MgPSBjYWxsYmFja3M7XG4gICAgdGhpcy5jcmVhdGVXb3JrZXIgPSBjcmVhdGVXb3JrZXI7XG4gIH1cblxuICAvKiogTGF0ZXN0IG1vbm90b25pYyBzZXF1ZW5jZSBudW1iZXIgYXNzaWduZWQgYnkgYGZlZWQoKWAuICovXG4gIGdldCBsYXN0U2VxKCk6IG51bWJlciB7XG4gICAgcmV0dXJuIHRoaXMuc2VxO1xuICB9XG5cbiAgLyoqIEhpZ2hlc3Qgc2VxdWVuY2UgbnVtYmVyIG9mIGFuIGluLWZsaWdodCBzdXBwcmVzc2VkIGZyYW1lLCBvciAwIGlmIG5vbmUgYXJlIHNjb3JpbmcuICovXG4gIGdldCBpbkZsaWdodFN1cHByZXNzZWRTZXEoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gdGhpcy5sYXN0U3VwcHJlc3NlZFNlcSA+IHRoaXMubGFzdEFja2VkU2VxID8gdGhpcy5sYXN0U3VwcHJlc3NlZFNlcSA6IDA7XG4gIH1cblxuICAvKiogVHJ1ZSB3aGlsZSBhdCBsZWFzdCBvbmUgc3VwcHJlc3NlZCBmcmFtZSBpcyBzdGlsbCBxdWV1ZWQgb3Igc2NvcmluZyBpbiB0aGUgd29ya2VyLiAqL1xuICBnZXQgc3VwcHJlc3NlZEluRmxpZ2h0KCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLmluRmxpZ2h0U3VwcHJlc3NlZFNlcSA+IDA7XG4gIH1cblxuICBwcml2YXRlIGNsZWFyUmVjZW50KCk6IHZvaWQge1xuICAgIHRoaXMucmVjZW50ID0gW107XG4gICAgdGhpcy5yZWNlbnRCeXRlcyA9IDA7XG4gIH1cblxuICBwcml2YXRlIGNsZWFyU3VwcHJlc3NlZFRyYWNraW5nKCk6IHZvaWQge1xuICAgIGNvbnN0IGhhZEluRmxpZ2h0ID0gdGhpcy5zdXBwcmVzc2VkSW5GbGlnaHQ7XG4gICAgdGhpcy5sYXN0U3VwcHJlc3NlZFNlcSA9IDA7XG4gICAgdGhpcy5sYXN0QWNrZWRTZXEgPSAwO1xuICAgIGlmIChoYWRJbkZsaWdodCkgdGhpcy5jYWxsYmFja3Mub25TdXBwcmVzc2VkU2V0dGxlZD8uKCk7XG4gIH1cblxuICBwcml2YXRlIGVuc3VyZVdvcmtlcigpOiBXb3JrZXJMaWtlIHtcbiAgICBpZiAodGhpcy53b3JrZXIpIHJldHVybiB0aGlzLndvcmtlcjtcbiAgICBjb25zdCB3b3JrZXIgPSB0aGlzLmNyZWF0ZVdvcmtlcigpO1xuICAgIHdvcmtlci5vbm1lc3NhZ2UgPSAoZTogTWVzc2FnZUV2ZW50PFJlY29yZDxzdHJpbmcsIGFueT4+KSA9PiB7XG4gICAgICBjb25zdCBtID0gZS5kYXRhO1xuICAgICAgaWYgKHR5cGVvZiBtLmdlbiA9PT0gXCJudW1iZXJcIiAmJiBtLmdlbiAhPT0gdGhpcy5nZW4pIHJldHVybjtcbiAgICAgIGlmIChtLnR5cGUgPT09IFwicmVhZHlcIikge1xuICAgICAgICB0aGlzLmxvYWRpbmdNb2RlbElkID0gbnVsbDtcbiAgICAgICAgdGhpcy5sb2FkZWRNb2RlbElkID0gbS5tb2RlbElkO1xuICAgICAgICB0aGlzLnJlYWR5ID0gdHJ1ZTtcbiAgICAgICAgdGhpcy5jYWxsYmFja3Mub25SZWFkeT8uKG0ubW9kZWxJZCwgbS53YXJtdXBNcyk7XG4gICAgICB9IGVsc2UgaWYgKG0udHlwZSA9PT0gXCJhY2tcIikge1xuICAgICAgICBjb25zdCB3YXNJbkZsaWdodCA9IHRoaXMuc3VwcHJlc3NlZEluRmxpZ2h0O1xuICAgICAgICBpZiAodHlwZW9mIG0uc2VxID09PSBcIm51bWJlclwiICYmIG0uc2VxID4gdGhpcy5sYXN0QWNrZWRTZXEpIHRoaXMubGFzdEFja2VkU2VxID0gbS5zZXE7XG4gICAgICAgIGlmICh3YXNJbkZsaWdodCAmJiAhdGhpcy5zdXBwcmVzc2VkSW5GbGlnaHQpIHRoaXMuY2FsbGJhY2tzLm9uU3VwcHJlc3NlZFNldHRsZWQ/LigpO1xuICAgICAgfSBlbHNlIGlmIChtLnR5cGUgPT09IFwiZGV0ZWN0ZWRcIikge1xuICAgICAgICBjb25zdCB0cmFpbGluZzogV2FrZVRyYWlsaW5nQ2h1bmtbXSA9IFtdO1xuICAgICAgICBjb25zdCByZXN0ID0gbmV3IFVpbnQ4QXJyYXkobS5yZXN0Qnl0ZXMgYXMgQXJyYXlCdWZmZXIpO1xuICAgICAgICBjb25zdCBoaXRTZXEgPSB0eXBlb2YgbS5zZXEgPT09IFwibnVtYmVyXCIgPyBtLnNlcSA6IE51bWJlci5NQVhfU0FGRV9JTlRFR0VSO1xuICAgICAgICBjb25zdCBoaXRJdGVtID0gdGhpcy5yZWNlbnQuZmluZCgoaXRlbSkgPT4gaXRlbS5zZXEgPT09IGhpdFNlcSk7XG4gICAgICAgIGlmIChyZXN0LmJ5dGVMZW5ndGggPiAwKSB7XG4gICAgICAgICAgdHJhaWxpbmcucHVzaCh7IHNlcTogaGl0U2VxLCBieXRlczogcmVzdCwgc3VwcHJlc3NlZDogaGl0SXRlbT8uc3VwcHJlc3NlZCA/PyBmYWxzZSB9KTtcbiAgICAgICAgfVxuICAgICAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgdGhpcy5yZWNlbnQpIHtcbiAgICAgICAgICBpZiAoaXRlbS5zZXEgPiBoaXRTZXEpIHRyYWlsaW5nLnB1c2goeyBzZXE6IGl0ZW0uc2VxLCBieXRlczogaXRlbS5ieXRlcywgc3VwcHJlc3NlZDogaXRlbS5zdXBwcmVzc2VkIH0pO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMuY2xlYXJSZWNlbnQoKTtcbiAgICAgICAgdGhpcy5sYXN0U3VwcHJlc3NlZFNlcSA9IDA7XG4gICAgICAgIHRoaXMubGFzdEFja2VkU2VxID0gMDtcbiAgICAgICAgdGhpcy5jYWxsYmFja3Mub25EZXRlY3RlZCh7XG4gICAgICAgICAgc2NvcmU6IG0uc2NvcmUsXG4gICAgICAgICAgYXRGcmFtZTogbS5hdEZyYW1lLFxuICAgICAgICAgIHRyYWlsaW5nLFxuICAgICAgICAgIGluZmVyTXM6IG0uaW5mZXJNcyxcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2UgaWYgKG0udHlwZSA9PT0gXCJ0ZWxlbWV0cnlcIikge1xuICAgICAgICB0aGlzLmNhbGxiYWNrcy5vblRlbGVtZXRyeT8uKHtcbiAgICAgICAgICBzY29yZTogbS5zY29yZSxcbiAgICAgICAgICBwZWFrOiBtLnBlYWssXG4gICAgICAgICAgZ2F0ZU9wZW46IG0uZ2F0ZU9wZW4sXG4gICAgICAgICAgZnJhbWVzOiBtLmZyYW1lcyxcbiAgICAgICAgICBzY29yZWQ6IG0uc2NvcmVkLFxuICAgICAgICAgIGluZmVyTXM6IG0uaW5mZXJNcyxcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2UgaWYgKG0udHlwZSA9PT0gXCJlcnJvclwiKSB7XG4gICAgICAgIHRoaXMubG9hZGluZ01vZGVsSWQgPSBudWxsO1xuICAgICAgICB0aGlzLnJlYWR5ID0gZmFsc2U7XG4gICAgICAgIHRoaXMuY2xlYXJTdXBwcmVzc2VkVHJhY2tpbmcoKTtcbiAgICAgICAgdGhpcy5jYWxsYmFja3Mub25FcnJvcj8uKFN0cmluZyhtLm1lc3NhZ2UgPz8gXCJ3YWtlIHdvcmtlciBlcnJvclwiKSk7XG4gICAgICB9XG4gICAgfTtcbiAgICB3b3JrZXIub25lcnJvciA9IChlcnIpID0+IHtcbiAgICAgIHRoaXMubG9hZGluZ01vZGVsSWQgPSBudWxsO1xuICAgICAgdGhpcy5yZWFkeSA9IGZhbHNlO1xuICAgICAgdGhpcy5jbGVhclN1cHByZXNzZWRUcmFja2luZygpO1xuICAgICAgdGhpcy5jYWxsYmFja3Mub25FcnJvcj8uKGVyci5tZXNzYWdlIHx8IFwid2FrZSB3b3JrZXIgZmFpbGVkXCIpO1xuICAgIH07XG4gICAgdGhpcy53b3JrZXIgPSB3b3JrZXI7XG4gICAgcmV0dXJuIHdvcmtlcjtcbiAgfVxuXG4gIC8qKiBMb2FkcyAob3Igc3dpdGNoZXMgdG8pIHRoZSBuYW1lZCBtb2RlbDsgaWdub3JlcyBzdGFsZSByZXN1bHRzIGZyb20gZWFybGllciBsb2Fkcy4gKi9cbiAgbG9hZChtb2RlbElkOiBzdHJpbmcsIHRocmVzaG9sZDogbnVtYmVyKTogdm9pZCB7XG4gICAgdGhpcy5jdXJyZW50VGhyZXNob2xkID0gdGhyZXNob2xkO1xuICAgIGNvbnN0IHdvcmtlciA9IHRoaXMuZW5zdXJlV29ya2VyKCk7XG4gICAgaWYgKHRoaXMucmVhZHkgJiYgdGhpcy5sb2FkZWRNb2RlbElkID09PSBtb2RlbElkKSB7XG4gICAgICB3b3JrZXIucG9zdE1lc3NhZ2UoeyB0eXBlOiBcImNvbmZpZ1wiLCB0aHJlc2hvbGQgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICh0aGlzLmxvYWRpbmdNb2RlbElkID09PSBtb2RlbElkKSB7XG4gICAgICB3b3JrZXIucG9zdE1lc3NhZ2UoeyB0eXBlOiBcImNvbmZpZ1wiLCB0aHJlc2hvbGQgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRoaXMuZ2VuKys7XG4gICAgdGhpcy5yZWFkeSA9IGZhbHNlO1xuICAgIHRoaXMubG9hZGluZ01vZGVsSWQgPSBtb2RlbElkO1xuICAgIHRoaXMuY2xlYXJSZWNlbnQoKTtcbiAgICB0aGlzLmNsZWFyU3VwcHJlc3NlZFRyYWNraW5nKCk7XG4gICAgd29ya2VyLnBvc3RNZXNzYWdlKHtcbiAgICAgIHR5cGU6IFwibG9hZFwiLFxuICAgICAgZ2VuOiB0aGlzLmdlbixcbiAgICAgIG1vZGVsSWQsXG4gICAgICB1cmw6IGAvd2FrZS9tb2RlbHMvJHtlbmNvZGVVUklDb21wb25lbnQobW9kZWxJZCl9Lm9ubnhgLFxuICAgICAgdGhyZXNob2xkLFxuICAgICAgd2FzbVBhdGhzOiBcIi9vcnQvXCIsXG4gICAgfSk7XG4gIH1cblxuICBzZXRUaHJlc2hvbGQodGhyZXNob2xkOiBudW1iZXIpOiB2b2lkIHtcbiAgICB0aGlzLmN1cnJlbnRUaHJlc2hvbGQgPSB0aHJlc2hvbGQ7XG4gICAgdGhpcy53b3JrZXI/LnBvc3RNZXNzYWdlKHsgdHlwZTogXCJjb25maWdcIiwgdGhyZXNob2xkIH0pO1xuICB9XG5cbiAgLyoqIEZlZWRzIGEgMTYga0h6IFBDTTE2IGNodW5rIHRvIHRoZSB3b3JrZXI7IHJldHVybnMgaXRzIHNlcXVlbmNlIG51bWJlciAob3IgMCBpZiBub3QgcmVhZHkpLiAqL1xuICBmZWVkKHNhbXBsZXM6IEludDE2QXJyYXksIHN1cHByZXNzZWQgPSBmYWxzZSk6IG51bWJlciB7XG4gICAgaWYgKCF0aGlzLnJlYWR5IHx8ICF0aGlzLndvcmtlcikgcmV0dXJuIDA7XG4gICAgY29uc3Qgc2VxID0gKyt0aGlzLnNlcTtcbiAgICBpZiAoc3VwcHJlc3NlZCkgdGhpcy5sYXN0U3VwcHJlc3NlZFNlcSA9IHNlcTtcbiAgICBjb25zdCBieXRlcyA9IG5ldyBVaW50OEFycmF5KHNhbXBsZXMuYnl0ZUxlbmd0aCk7XG4gICAgYnl0ZXMuc2V0KG5ldyBVaW50OEFycmF5KHNhbXBsZXMuYnVmZmVyLCBzYW1wbGVzLmJ5dGVPZmZzZXQsIHNhbXBsZXMuYnl0ZUxlbmd0aCkpO1xuICAgIHRoaXMucmVjZW50LnB1c2goeyBzZXEsIGJ5dGVzLCBzdXBwcmVzc2VkIH0pO1xuICAgIHRoaXMucmVjZW50Qnl0ZXMgKz0gYnl0ZXMuYnl0ZUxlbmd0aDtcbiAgICB3aGlsZSAodGhpcy5yZWNlbnRCeXRlcyA+IFJFQ0VOVF9NQVhfQllURVMgJiYgdGhpcy5yZWNlbnQubGVuZ3RoID4gMSkge1xuICAgICAgdGhpcy5yZWNlbnRCeXRlcyAtPSB0aGlzLnJlY2VudC5zaGlmdCgpIS5ieXRlcy5ieXRlTGVuZ3RoO1xuICAgIH1cbiAgICBjb25zdCBjb3B5ID0gbmV3IEludDE2QXJyYXkoc2FtcGxlcy5sZW5ndGgpO1xuICAgIGNvcHkuc2V0KHNhbXBsZXMpO1xuICAgIHRoaXMud29ya2VyLnBvc3RNZXNzYWdlKHsgdHlwZTogXCJmZWVkXCIsIGdlbjogdGhpcy5nZW4sIHNlcSwgYWNrOiBzdXBwcmVzc2VkLCBwY206IGNvcHkuYnVmZmVyIH0sIFtjb3B5LmJ1ZmZlcl0pO1xuICAgIHJldHVybiBzZXE7XG4gIH1cblxuICByZXNldCgpOiB2b2lkIHtcbiAgICB0aGlzLmNsZWFyUmVjZW50KCk7XG4gICAgdGhpcy5jbGVhclN1cHByZXNzZWRUcmFja2luZygpO1xuICAgIGlmICghdGhpcy53b3JrZXIgfHwgIXRoaXMucmVhZHkpIHJldHVybjtcbiAgICB0aGlzLmdlbisrO1xuICAgIHRoaXMud29ya2VyLnBvc3RNZXNzYWdlKHsgdHlwZTogXCJyZXNldFwiLCBnZW46IHRoaXMuZ2VuIH0pO1xuICB9XG5cbiAgZGlzcG9zZSgpOiB2b2lkIHtcbiAgICB0aGlzLmdlbisrO1xuICAgIHRoaXMucmVhZHkgPSBmYWxzZTtcbiAgICB0aGlzLmxvYWRlZE1vZGVsSWQgPSBudWxsO1xuICAgIHRoaXMubG9hZGluZ01vZGVsSWQgPSBudWxsO1xuICAgIHRoaXMuY2xlYXJSZWNlbnQoKTtcbiAgICB0aGlzLmNsZWFyU3VwcHJlc3NlZFRyYWNraW5nKCk7XG4gICAgaWYgKHRoaXMud29ya2VyKSB7XG4gICAgICB0aGlzLndvcmtlci5wb3N0TWVzc2FnZSh7IHR5cGU6IFwiZGlzcG9zZVwiLCBnZW46IHRoaXMuZ2VuIH0pO1xuICAgICAgdGhpcy53b3JrZXIudGVybWluYXRlKCk7XG4gICAgICB0aGlzLndvcmtlciA9IG51bGw7XG4gICAgfVxuICB9XG5cbiAgZ2V0IG1vZGVsSWQoKTogc3RyaW5nIHwgbnVsbCB7XG4gICAgcmV0dXJuIHRoaXMubG9hZGVkTW9kZWxJZCA/PyB0aGlzLmxvYWRpbmdNb2RlbElkO1xuICB9XG5cbiAgZ2V0IHRocmVzaG9sZCgpOiBudW1iZXIge1xuICAgIHJldHVybiB0aGlzLmN1cnJlbnRUaHJlc2hvbGQ7XG4gIH1cbn1cblxuZXhwb3J0IGludGVyZmFjZSBXYWtlTG9ja1NlbnRpbmVsTGlrZSB7XG4gIHJlYWRvbmx5IHJlbGVhc2VkPzogYm9vbGVhbjtcbiAgcmVsZWFzZSgpOiBQcm9taXNlPHZvaWQ+O1xuICBhZGRFdmVudExpc3RlbmVyPyh0eXBlOiBzdHJpbmcsIGxpc3RlbmVyOiAoKSA9PiB2b2lkKTogdm9pZDtcbn1cblxuLyoqXG4gKiBXcmFwcyB0aGUgU2NyZWVuIFdha2UgTG9jayBBUEkgc28gYnJvd3Nlci1pbml0aWF0ZWQgcmVsZWFzZXMgKHN1Y2ggYXMgaGlkaW5nIGEgdGFiKSBjbGVhciB0aGVcbiAqIHN0b3JlZCBzZW50aW5lbCBhbmQgYWxsb3cgcmVhY3F1aXJpbmcgb24gdmlzaWJpbGl0eSByZXN0b3JlLCB3aGlsZSBjYW5jZWxsaW5nIGluLWZsaWdodCByZXF1ZXN0cy5cbiAqL1xuZXhwb3J0IGNsYXNzIFNjcmVlbldha2VMb2NrIHtcbiAgcHJpdmF0ZSBzZW50aW5lbDogV2FrZUxvY2tTZW50aW5lbExpa2UgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBnZW4gPSAwO1xuICBwcml2YXRlIHJlYWRvbmx5IHJlcXVlc3RMb2NrOiAoKSA9PiBQcm9taXNlPFdha2VMb2NrU2VudGluZWxMaWtlIHwgdW5kZWZpbmVkPjtcblxuICBjb25zdHJ1Y3RvcihcbiAgICByZXF1ZXN0TG9jazogKCkgPT4gUHJvbWlzZTxXYWtlTG9ja1NlbnRpbmVsTGlrZSB8IHVuZGVmaW5lZD4gPSAoKSA9PlxuICAgICAgKG5hdmlnYXRvciBhcyBhbnkpLndha2VMb2NrPy5yZXF1ZXN0KFwic2NyZWVuXCIpID8/IFByb21pc2UucmVzb2x2ZSh1bmRlZmluZWQpLFxuICApIHtcbiAgICB0aGlzLnJlcXVlc3RMb2NrID0gcmVxdWVzdExvY2s7XG4gIH1cblxuICBnZXQgaGVsZCgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5zZW50aW5lbCAhPSBudWxsICYmICF0aGlzLnNlbnRpbmVsLnJlbGVhc2VkO1xuICB9XG5cbiAgYXN5bmMgYWNxdWlyZShzdGlsbFdhbnRlZDogKCkgPT4gYm9vbGVhbik6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICh0aGlzLmhlbGQgfHwgIXN0aWxsV2FudGVkKCkpIHJldHVybjtcbiAgICBjb25zdCBnZW4gPSArK3RoaXMuZ2VuO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBsb2NrID0gYXdhaXQgdGhpcy5yZXF1ZXN0TG9jaygpO1xuICAgICAgaWYgKCFsb2NrKSByZXR1cm47XG4gICAgICBpZiAoZ2VuICE9PSB0aGlzLmdlbiB8fCAhc3RpbGxXYW50ZWQoKSkge1xuICAgICAgICB2b2lkIGxvY2sucmVsZWFzZSgpLmNhdGNoKCgpID0+IHt9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgdGhpcy5zZW50aW5lbCA9IGxvY2s7XG4gICAgICBsb2NrLmFkZEV2ZW50TGlzdGVuZXI/LihcInJlbGVhc2VcIiwgKCkgPT4ge1xuICAgICAgICBpZiAodGhpcy5zZW50aW5lbCA9PT0gbG9jaykgdGhpcy5zZW50aW5lbCA9IG51bGw7XG4gICAgICB9KTtcbiAgICB9IGNhdGNoIHt9XG4gIH1cblxuICByZWxlYXNlKCk6IHZvaWQge1xuICAgIHRoaXMuZ2VuKys7XG4gICAgY29uc3QgbG9jayA9IHRoaXMuc2VudGluZWw7XG4gICAgdGhpcy5zZW50aW5lbCA9IG51bGw7XG4gICAgdm9pZCBsb2NrPy5yZWxlYXNlKCkuY2F0Y2goKCkgPT4ge30pO1xuICB9XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRGVmZXJyZWRNaWNGcmFtZSB7XG4gIHNlcTogbnVtYmVyO1xuICBmbG9vclNlcTogbnVtYmVyO1xuICBwY206IHN0cmluZztcbiAgdDogbnVtYmVyO1xufVxuXG4vKipcbiAqIE1pcnJvcnMgdGhlIHZvaWNlIGNvcmUncyBwbGF5YmFjayBzdXBwcmVzc2lvbiBjbG9jayBhbmQgY29vcmRpbmF0ZXMgZGVmZXJyZWQgcG9zdC1wbGF5YmFja1xuICogbWljcm9waG9uZSBmcmFtZXMgd2l0aCBhc3luY2hyb25vdXMgd2FrZS13b3JkIHRhaWwgcmVwbGF5LlxuICpcbiAqIFNlcGFyYXRpbmcgd2FrZSBhY2NlcHRhbmNlIGZyb20gcmVwbGF5IGVsaWdpYmlsaXR5IChgcmVwbGF5Rmxvb3JTZXFgKSBlbnN1cmVzIHRoYXQgZm9yd2FyZGluZ1xuICogYSBnYXAgZnJhbWUgYmVmb3JlIG5ldyBwbGF5YmFjayBuZXZlciBzaWxlbmNlcyBnYXAgYXVkaW8sIG5ldmVyIGRpc2NhcmRzIGEgdmFsaWQgd2FrZSBoaXQsXG4gKiBhbmQgbmV2ZXIgcmVwbGF5cyBvbGRlciBzdXBwcmVzc2VkIGF1ZGlvIGFmdGVyIG5ld2VyIGF1ZGlvIGFscmVhZHkgc2VudCB0byB0aGUgY29yZS5cbiAqL1xuZnVuY3Rpb24gdmFsaWRCcmllZlBjbUJ5dGVzKHBjbTogdW5rbm93bik6IG51bWJlciB7XG4gIGlmICh0eXBlb2YgcGNtICE9PSBcInN0cmluZ1wiIHx8IHBjbS5sZW5ndGggPT09IDAgfHwgcGNtLmxlbmd0aCAlIDQgIT09IDApIHJldHVybiAtMTtcbiAgaWYgKCEvXltBLVphLXowLTkrL10qPXswLDJ9JC8udGVzdChwY20pKSByZXR1cm4gLTE7XG4gIGNvbnN0IHBhZCA9IHBjbS5lbmRzV2l0aChcIj09XCIpID8gMiA6IHBjbS5lbmRzV2l0aChcIj1cIikgPyAxIDogMDtcbiAgY29uc3Qgc2l6ZSA9IE1hdGguZmxvb3IoKHBjbS5sZW5ndGggKiAzKSAvIDQpIC0gcGFkO1xuICByZXR1cm4gc2l6ZSA+IDAgJiYgc2l6ZSAlIDIgPT09IDAgJiYgc2l6ZSA8PSAyXzg4MF8wMDAgPyBzaXplIDogLTE7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgV2FrZUF1ZGlvR2F0ZUxpbWl0cyB7XG4gIGRlbGl2ZXJNYXg/OiBudW1iZXI7XG4gIGJyaWVmV2FpdD86IG51bWJlcjtcbn1cblxuZXhwb3J0IGNsYXNzIFdha2VBdWRpb0dhdGUge1xuICBwcml2YXRlIHdoaWxlU3BlYWtpbmcgPSBcInNlbmRcIjtcbiAgcHJpdmF0ZSBzcGVlY2hVbnRpbCA9IDA7XG4gIHByaXZhdGUgZGVsaXZlck1heCA9IDMwO1xuICBwcml2YXRlIGJyaWVmV2FpdCA9IDM7XG4gIHByaXZhdGUgYWN0aXZlQnJpZWY6IHsgZnJvbTogbnVtYmVyOyB1bnRpbDogbnVtYmVyOyBicmllZkF0OiBudW1iZXIgfSB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIHJlYWR5QnJpZWZzOiBudW1iZXJbXSA9IFtdO1xuICBwcml2YXRlIHJlcXVlc3RlZEJyaWVmcyA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gIHByaXZhdGUgbGFzdEN1dDogeyBhdDogbnVtYmVyOyBicmllZkF0OiBudW1iZXIgfSB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIGxhc3RTdG9wcGVkQnJpZWZBdDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgcmVwbGF5Rmxvb3JTZXEgPSAwO1xuICBwcml2YXRlIGRlZmVycmVkOiBEZWZlcnJlZE1pY0ZyYW1lW10gPSBbXTtcbiAgcHJpdmF0ZSByZWFkb25seSBtYXhEZWZlcnJlZDogbnVtYmVyO1xuXG4gIGNvbnN0cnVjdG9yKG1heERlZmVycmVkID0gNjApIHtcbiAgICB0aGlzLm1heERlZmVycmVkID0gbWF4RGVmZXJyZWQ7XG4gIH1cblxuICByZXNldCh3aGlsZVNwZWFraW5nID0gXCJzZW5kXCIsIGZsb29yU2VxID0gMCwgbGltaXRzOiBXYWtlQXVkaW9HYXRlTGltaXRzID0ge30pOiB2b2lkIHtcbiAgICB0aGlzLndoaWxlU3BlYWtpbmcgPSB3aGlsZVNwZWFraW5nO1xuICAgIHRoaXMuc3BlZWNoVW50aWwgPSAwO1xuICAgIHRoaXMuZGVsaXZlck1heCA9IHR5cGVvZiBsaW1pdHMuZGVsaXZlck1heCA9PT0gXCJudW1iZXJcIiA/IGxpbWl0cy5kZWxpdmVyTWF4IDogMzA7XG4gICAgdGhpcy5icmllZldhaXQgPSB0eXBlb2YgbGltaXRzLmJyaWVmV2FpdCA9PT0gXCJudW1iZXJcIiA/IGxpbWl0cy5icmllZldhaXQgOiAzO1xuICAgIHRoaXMuYWN0aXZlQnJpZWYgPSBudWxsO1xuICAgIHRoaXMucmVhZHlCcmllZnMgPSBbXTtcbiAgICB0aGlzLnJlcXVlc3RlZEJyaWVmcy5jbGVhcigpO1xuICAgIHRoaXMubGFzdEN1dCA9IG51bGw7XG4gICAgdGhpcy5sYXN0U3RvcHBlZEJyaWVmQXQgPSBudWxsO1xuICAgIHRoaXMucmVwbGF5Rmxvb3JTZXEgPSBmbG9vclNlcTtcbiAgICB0aGlzLmRlZmVycmVkID0gW107XG4gIH1cblxuICBnZXQgaGFzRGVmZXJyZWQoKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMuZGVmZXJyZWQubGVuZ3RoID4gMDtcbiAgfVxuXG4gIGlzU3VwcHJlc3NlZCh0OiBudW1iZXIpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy53aGlsZVNwZWFraW5nICE9PSBcInNlbmRcIiAmJiB0IDwgdGhpcy5zcGVlY2hVbnRpbDtcbiAgfVxuXG4gIG9uQnJpZWZSZXF1ZXN0KGlkOiBzdHJpbmcsIGV2ZW50VGltZTogbnVtYmVyKTogdm9pZCB7XG4gICAgaWYgKGlkKSB0aGlzLnJlcXVlc3RlZEJyaWVmcy5zZXQoaWQsIGV2ZW50VGltZSk7XG4gIH1cblxuICBvblBsYXkocGNtQmFzZTY0OiBzdHJpbmcsIGV2ZW50VGltZTogbnVtYmVyLCBzb3VyY2U/OiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBwYWQgPSBwY21CYXNlNjQuZW5kc1dpdGgoXCI9PVwiKSA/IDIgOiBwY21CYXNlNjQuZW5kc1dpdGgoXCI9XCIpID8gMSA6IDA7XG4gICAgY29uc3QgcGNtQnl0ZXMgPSBNYXRoLm1heCgwLCBNYXRoLmZsb29yKChwY21CYXNlNjQubGVuZ3RoICogMykgLyA0KSAtIHBhZCk7XG4gICAgdGhpcy5zcGVlY2hVbnRpbCA9IE1hdGgubWF4KHRoaXMuc3BlZWNoVW50aWwsIGV2ZW50VGltZSkgKyBwY21CeXRlcyAvIDQ4XzAwMDtcbiAgICBpZiAoc291cmNlID09PSBcImFubm91bmNlclwiKSB7XG4gICAgICBjb25zdCBicmllZkF0ID0gdGhpcy5yZWFkeUJyaWVmcy5zaGlmdCgpID8/IGV2ZW50VGltZTtcbiAgICAgIHRoaXMuYWN0aXZlQnJpZWYgPSB7IGZyb206IGV2ZW50VGltZSwgdW50aWw6IHRoaXMuc3BlZWNoVW50aWwsIGJyaWVmQXQgfTtcbiAgICAgIHRoaXMubGFzdEN1dCA9IG51bGw7XG4gICAgICB0aGlzLmxhc3RTdG9wcGVkQnJpZWZBdCA9IG51bGw7XG4gICAgfVxuICB9XG5cbiAgb25GbHVzaChldmVudFRpbWU6IG51bWJlciwgaHVzaGVkID0gZmFsc2UpOiB2b2lkIHtcbiAgICB0aGlzLnNwZWVjaFVudGlsID0gTWF0aC5taW4odGhpcy5zcGVlY2hVbnRpbCwgZXZlbnRUaW1lKTtcbiAgICBpZiAodGhpcy5hY3RpdmVCcmllZiAmJiBldmVudFRpbWUgPj0gdGhpcy5hY3RpdmVCcmllZi51bnRpbCkge1xuICAgICAgdGhpcy5hY3RpdmVCcmllZiA9IG51bGw7XG4gICAgfVxuICAgIGlmICh0aGlzLmFjdGl2ZUJyaWVmKSB7XG4gICAgICBjb25zdCBhID0gdGhpcy5hY3RpdmVCcmllZjtcbiAgICAgIHRoaXMuYWN0aXZlQnJpZWYgPSBudWxsO1xuICAgICAgLy8gTWF0Y2ggY2FsbC50cyBjdXRBbm5vdW5jZW1lbnQoKSBhbmQgaHVzaFJlcGx5KCk6IGEgYnJpZWYgaHVzaGVkLCA+PSA4MCUgcGxheWVkLFxuICAgICAgLy8gb3IgcGFzdCBkZWxpdmVyTWF4IGlzIG5vdCByZS1xdWV1ZWQuXG4gICAgICBjb25zdCBwbGF5ZWQgPSAoZXZlbnRUaW1lIC0gYS5mcm9tKSAvIE1hdGgubWF4KDAuMSwgYS51bnRpbCAtIGEuZnJvbSk7XG4gICAgICBpZiAoIWh1c2hlZCAmJiBwbGF5ZWQgPCAwLjggJiYgZXZlbnRUaW1lIC0gYS5icmllZkF0IDwgdGhpcy5kZWxpdmVyTWF4KSB7XG4gICAgICAgIHRoaXMucmVhZHlCcmllZnMucHVzaChhLmJyaWVmQXQpO1xuICAgICAgICB0aGlzLmxhc3RDdXQgPSB7IGF0OiBldmVudFRpbWUsIGJyaWVmQXQ6IGEuYnJpZWZBdCB9O1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy5sYXN0Q3V0ID0gbnVsbDtcbiAgICAgIH1cbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgLy8gU2F5aW5nIFwic3RvcFwiIG92ZXIgYSBicmllZiBjdXRzIGl0IG9uIEFDVElWSVRZX1NUQVJUIGFuZCB0aGVuIGh1c2hlcyBsYXN0Q3V0IHdpdGhpbiA2IHMuXG4gICAgaWYgKGh1c2hlZCAmJiB0aGlzLmxhc3RDdXQgJiYgZXZlbnRUaW1lIC0gdGhpcy5sYXN0Q3V0LmF0IDwgNikge1xuICAgICAgY29uc3QgaWR4ID0gdGhpcy5yZWFkeUJyaWVmcy5sYXN0SW5kZXhPZih0aGlzLmxhc3RDdXQuYnJpZWZBdCk7XG4gICAgICBpZiAoaWR4ID49IDApIHtcbiAgICAgICAgdGhpcy5yZWFkeUJyaWVmcy5zcGxpY2UoaWR4LCAxKTtcbiAgICAgICAgdGhpcy5sYXN0U3RvcHBlZEJyaWVmQXQgPSB0aGlzLmxhc3RDdXQuYnJpZWZBdDtcbiAgICAgIH1cbiAgICAgIHRoaXMubGFzdEN1dCA9IG51bGw7XG4gICAgfVxuICB9XG5cbiAgLyoqIE1pcnJvcnMgY29yZSBjb21tYW5kIHNpZGUgZWZmZWN0cyBmb3IgcGxheWJhY2ssIGZsdXNoZXMsIGJyaWVmcywgYW5kIHZvaWNlIHN0b3AgY29tbWFuZHMuICovXG4gIG9ic2VydmVDb21tYW5kcyhcbiAgICBjb21tYW5kczogcmVhZG9ubHkgeyB0eXBlOiBzdHJpbmc7IHBjbT86IHVua25vd247IHNvdXJjZT86IHVua25vd247IGlkPzogdW5rbm93bjsgY29tbWFuZD86IHVua25vd247IG1lc3NhZ2U/OiB1bmtub3duIH1bXSxcbiAgICBldmVudFRpbWU6IG51bWJlcixcbiAgICBldmVudFR5cGU/OiBzdHJpbmcsXG4gICk6IHZvaWQge1xuICAgIGNvbnN0IGh1c2hlZCA9XG4gICAgICBldmVudFR5cGUgPT09IFwiaW50ZXJydXB0XCIgfHxcbiAgICAgIGV2ZW50VHlwZSA9PT0gXCJzdG9wXCIgfHxcbiAgICAgIGNvbW1hbmRzLnNvbWUoKGMpID0+IGMudHlwZSA9PT0gXCJ2b2ljZUNvbW1hbmRcIiAmJiAoYy5jb21tYW5kID09PSBcInN0b3BcIiB8fCBjLmNvbW1hbmQgPT09IFwiY2FuY2VsQWxsXCIpKTtcbiAgICBmb3IgKGNvbnN0IGMgb2YgY29tbWFuZHMpIHtcbiAgICAgIGlmIChjLnR5cGUgPT09IFwicGxheVwiICYmIHR5cGVvZiBjLnBjbSA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICB0aGlzLm9uUGxheShjLnBjbSwgZXZlbnRUaW1lLCB0eXBlb2YgYy5zb3VyY2UgPT09IFwic3RyaW5nXCIgPyBjLnNvdXJjZSA6IHVuZGVmaW5lZCk7XG4gICAgICB9IGVsc2UgaWYgKGMudHlwZSA9PT0gXCJmbHVzaFwiKSB7XG4gICAgICAgIHRoaXMub25GbHVzaChldmVudFRpbWUsIGh1c2hlZCk7XG4gICAgICB9IGVsc2UgaWYgKGMudHlwZSA9PT0gXCJicmllZlwiICYmIHR5cGVvZiBjLmlkID09PSBcInN0cmluZ1wiKSB7XG4gICAgICAgIHRoaXMub25CcmllZlJlcXVlc3QoYy5pZCwgZXZlbnRUaW1lKTtcbiAgICAgIH0gZWxzZSBpZiAoYy50eXBlID09PSBcImxvZ1wiICYmIGMubWVzc2FnZSA9PT0gXCJub3QgYSBzdG9wIGFmdGVyIGFsbFwiICYmIHRoaXMubGFzdFN0b3BwZWRCcmllZkF0ICE9IG51bGwpIHtcbiAgICAgICAgdGhpcy5yZWFkeUJyaWVmcy5wdXNoKHRoaXMubGFzdFN0b3BwZWRCcmllZkF0KTtcbiAgICAgICAgdGhpcy5sYXN0U3RvcHBlZEJyaWVmQXQgPSBudWxsO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBDYWxsZWQgaW1tZWRpYXRlbHkgYmVmb3JlIHB1c2hpbmcgYW4gZXZlbnQgdG8gdGhlIGNvcmUuIFJldHVybnMgYW55IGRlZmVycmVkIHVuc3VwcHJlc3NlZFxuICAgKiBnYXAgZnJhbWVzIHRoYXQgbXVzdCByZWFjaCB0aGUgY29yZSBmaXJzdCBzbyBuZXcgcGxheWJhY2sgY2Fubm90IHNpbGVuY2UgdGhlbS5cbiAgICovXG4gIGJlZm9yZVB1c2goXG4gICAgZXZlbnQ6IHsgdHlwZT86IHVua25vd247IGlkPzogdW5rbm93bjsgcGNtPzogdW5rbm93bjsgdGV4dD86IHVua25vd247IGRhdGE/OiB1bmtub3duIH0sXG4gICAgZXZlbnRUaW1lID0gMCxcbiAgKTogeyBwY206IHN0cmluZzsgdDogbnVtYmVyIH1bXSB7XG4gICAgbGV0IGFjY2VwdGVkQnJpZWYgPSBmYWxzZTtcbiAgICBpZiAoZXZlbnQudHlwZSA9PT0gXCJicmllZi5yZWFkeVwiICYmIHR5cGVvZiBldmVudC5pZCA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgY29uc3QgYXNrZWRBdCA9IHRoaXMucmVxdWVzdGVkQnJpZWZzLmdldChldmVudC5pZCk7XG4gICAgICBpZiAoYXNrZWRBdCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHRoaXMucmVxdWVzdGVkQnJpZWZzLmRlbGV0ZShldmVudC5pZCk7XG4gICAgICAgIGNvbnN0IHZhbGlkID1cbiAgICAgICAgICBldmVudFRpbWUgLSBhc2tlZEF0IDwgdGhpcy5icmllZldhaXQgJiZcbiAgICAgICAgICB2YWxpZEJyaWVmUGNtQnl0ZXMoZXZlbnQucGNtKSA+IDAgJiZcbiAgICAgICAgICB0eXBlb2YgZXZlbnQudGV4dCA9PT0gXCJzdHJpbmdcIiAmJlxuICAgICAgICAgIGV2ZW50LnRleHQudHJpbSgpLmxlbmd0aCA+IDA7XG4gICAgICAgIGlmICh2YWxpZCkge1xuICAgICAgICAgIHRoaXMucmVhZHlCcmllZnMucHVzaChldmVudFRpbWUpO1xuICAgICAgICAgIGFjY2VwdGVkQnJpZWYgPSB0cnVlO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIGlmICh0aGlzLmRlZmVycmVkLmxlbmd0aCA9PT0gMCkgcmV0dXJuIFtdO1xuICAgIGNvbnN0IGNhblN0YXJ0UGxheWJhY2sgPVxuICAgICAgYWNjZXB0ZWRCcmllZiB8fFxuICAgICAgKHRoaXMucmVhZHlCcmllZnMubGVuZ3RoID4gMCAmJiBldmVudC50eXBlID09PSBcInRpY2tcIikgfHxcbiAgICAgIChldmVudC50eXBlID09PSBcIndzLm1lc3NhZ2VcIiAmJiBTdHJpbmcoZXZlbnQuZGF0YSA/PyBcIlwiKS5pbmNsdWRlcygnXCJpbmxpbmVEYXRhXCInKSk7XG4gICAgcmV0dXJuIGNhblN0YXJ0UGxheWJhY2sgPyB0aGlzLmZsdXNoRGVmZXJyZWQoKSA6IFtdO1xuICB9XG5cbiAgZmx1c2hEZWZlcnJlZCgpOiB7IHBjbTogc3RyaW5nOyB0OiBudW1iZXIgfVtdIHtcbiAgICBpZiAodGhpcy5kZWZlcnJlZC5sZW5ndGggPT09IDApIHJldHVybiBbXTtcbiAgICBjb25zdCBpdGVtcyA9IHRoaXMuZGVmZXJyZWQuc3BsaWNlKDApO1xuICAgIGZvciAoY29uc3QgaXRlbSBvZiBpdGVtcykge1xuICAgICAgaWYgKGl0ZW0uZmxvb3JTZXEgPiB0aGlzLnJlcGxheUZsb29yU2VxKSB0aGlzLnJlcGxheUZsb29yU2VxID0gaXRlbS5mbG9vclNlcTtcbiAgICB9XG4gICAgcmV0dXJuIGl0ZW1zLm1hcCgoeyBwY20sIHQgfSkgPT4gKHsgcGNtLCB0IH0pKTtcbiAgfVxuXG4gIC8qKiBEZXRhY2hlcyBkZWZlcnJlZCBmcmFtZXMgYmVmb3JlIGBwdXNoKHsgdHlwZTogXCJ3YWtlXCIgfSlgIHdpdGhvdXQgYnVtcGluZyBgcmVwbGF5Rmxvb3JTZXFgIHlldC4gKi9cbiAgdGFrZURlZmVycmVkKCk6IERlZmVycmVkTWljRnJhbWVbXSB7XG4gICAgcmV0dXJuIHRoaXMuZGVmZXJyZWQuc3BsaWNlKDApO1xuICB9XG5cbiAgb25NaWNGcmFtZShwYXJhbXM6IHtcbiAgICBwY206IHN0cmluZztcbiAgICB0OiBudW1iZXI7XG4gICAgc2VxOiBudW1iZXI7XG4gICAgbGFzdFNlcTogbnVtYmVyO1xuICAgIGluRmxpZ2h0U3VwcHJlc3NlZFNlcTogbnVtYmVyO1xuICAgIHN1cHByZXNzZWQ6IGJvb2xlYW47XG4gIH0pOiB7IHBjbTogc3RyaW5nOyB0OiBudW1iZXIgfVtdIHtcbiAgICBjb25zdCBmbG9vclNlcSA9IHBhcmFtcy5zZXEgPiAwID8gcGFyYW1zLnNlcSA6IHBhcmFtcy5sYXN0U2VxO1xuICAgIGlmICghcGFyYW1zLnN1cHByZXNzZWQgJiYgdGhpcy53aGlsZVNwZWFraW5nICE9PSBcInNlbmRcIiAmJiBwYXJhbXMuaW5GbGlnaHRTdXBwcmVzc2VkU2VxID4gdGhpcy5yZXBsYXlGbG9vclNlcSkge1xuICAgICAgdGhpcy5kZWZlcnJlZC5wdXNoKHsgc2VxOiBwYXJhbXMuc2VxLCBmbG9vclNlcSwgcGNtOiBwYXJhbXMucGNtLCB0OiBwYXJhbXMudCB9KTtcbiAgICAgIGlmICh0aGlzLmRlZmVycmVkLmxlbmd0aCA+IHRoaXMubWF4RGVmZXJyZWQpIHJldHVybiB0aGlzLmZsdXNoRGVmZXJyZWQoKTtcbiAgICAgIHJldHVybiBbXTtcbiAgICB9XG4gICAgY29uc3Qgb3V0ID0gdGhpcy5mbHVzaERlZmVycmVkKCk7XG4gICAgaWYgKCFwYXJhbXMuc3VwcHJlc3NlZCAmJiBmbG9vclNlcSA+IHRoaXMucmVwbGF5Rmxvb3JTZXEpIHtcbiAgICAgIHRoaXMucmVwbGF5Rmxvb3JTZXEgPSBmbG9vclNlcTtcbiAgICB9XG4gICAgb3V0LnB1c2goeyBwY206IHBhcmFtcy5wY20sIHQ6IHBhcmFtcy50IH0pO1xuICAgIHJldHVybiBvdXQ7XG4gIH1cblxuICAvKipcbiAgICogQ29tcHV0ZXMgdGhlIG9yZGVyZWQgbWljIGZyYW1lcyB0byByZXBsYXkgYWZ0ZXIgYHB1c2goeyB0eXBlOiBcIndha2VcIiB9KWAsIHNraXBwaW5nIGFueSBjaHVua1xuICAgKiBhdCBvciBiZWxvdyBgcmVwbGF5Rmxvb3JTZXFgIHNvIGFscmVhZHktZm9yd2FyZGVkIGdhcCBmcmFtZXMgYXJlIG5ldmVyIGZvbGxvd2VkIGJ5IG9sZGVyIGF1ZGlvLlxuICAgKi9cbiAgcGxhbldha2VSZXBsYXkoXG4gICAgaGl0OiBXYWtlRGV0ZWN0aW9uRXZlbnQsXG4gICAgZGVmZXJyZWQ6IERlZmVycmVkTWljRnJhbWVbXSxcbiAgICBieXRlc1RvQmFzZTY0OiAoYnl0ZXM6IFVpbnQ4QXJyYXkpID0+IHN0cmluZyxcbiAgKTogeyBwY206IHN0cmluZzsgdD86IG51bWJlciB9W10ge1xuICAgIGNvbnN0IGRlZmVycmVkU2VxcyA9IG5ldyBTZXQoZGVmZXJyZWQubWFwKChkKSA9PiBkLnNlcSkuZmlsdGVyKChzKSA9PiBzID4gMCkpO1xuICAgIGNvbnN0IG91dDogeyBwY206IHN0cmluZzsgdD86IG51bWJlciB9W10gPSBbXTtcbiAgICBjb25zdCByZXBsYXllZFNlcXMgPSBuZXcgU2V0PG51bWJlcj4oKTtcbiAgICBsZXQgbWF4Rmxvb3IgPSB0aGlzLnJlcGxheUZsb29yU2VxO1xuICAgIGZvciAoY29uc3QgY2h1bmsgb2YgaGl0LnRyYWlsaW5nKSB7XG4gICAgICBpZiAoY2h1bmsuYnl0ZXMuYnl0ZUxlbmd0aCA9PT0gMCkgY29udGludWU7XG4gICAgICBpZiAoY2h1bmsuc2VxIDw9IHRoaXMucmVwbGF5Rmxvb3JTZXEpIGNvbnRpbnVlO1xuICAgICAgaWYgKCFjaHVuay5zdXBwcmVzc2VkICYmICFkZWZlcnJlZFNlcXMuaGFzKGNodW5rLnNlcSkpIGNvbnRpbnVlO1xuICAgICAgaWYgKGNodW5rLnNlcSA+IDApIHtcbiAgICAgICAgcmVwbGF5ZWRTZXFzLmFkZChjaHVuay5zZXEpO1xuICAgICAgICBpZiAoY2h1bmsuc2VxID4gbWF4Rmxvb3IpIG1heEZsb29yID0gY2h1bmsuc2VxO1xuICAgICAgfVxuICAgICAgb3V0LnB1c2goeyBwY206IGJ5dGVzVG9CYXNlNjQoY2h1bmsuYnl0ZXMpIH0pO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgZGVmZXJyZWQpIHtcbiAgICAgIGlmIChpdGVtLmZsb29yU2VxID4gbWF4Rmxvb3IpIG1heEZsb29yID0gaXRlbS5mbG9vclNlcTtcbiAgICAgIGlmIChpdGVtLnNlcSA+IDAgJiYgcmVwbGF5ZWRTZXFzLmhhcyhpdGVtLnNlcSkpIGNvbnRpbnVlO1xuICAgICAgb3V0LnB1c2goeyBwY206IGl0ZW0ucGNtLCB0OiBpdGVtLnQgfSk7XG4gICAgfVxuICAgIHRoaXMucmVwbGF5Rmxvb3JTZXEgPSBtYXhGbG9vcjtcbiAgICByZXR1cm4gb3V0O1xuICB9XG59XG4iLCAiLy8gVGhlIHdlYiBzdXJmYWNlOiBhIGZvdXJ0aCBob3N0IGZvciB0aGUgdm9pY2UgY29yZSwgYW5kIGEgcGhvbmUtZnJpZW5kbHkgd2F5IHRvIHVzZSBpdCBmb3Igd29yay5cbi8vIEl0IGxvYWRzIHRoZSBkZXYgc2VydmVyJ3MgbGF0ZXN0IGJ1aWxkIGF0IGVhY2ggY2FsbCwgc28gYW4gZWRpdCBpbiBzcmMvIGlzIGxpdmUgb24gdGhlIG5leHRcbi8vIGNhbGwsIGFuZCBrZWVwcyBldmVyeSBjYWxsIGFzIGEgdHJhY2UgdGhlIHJlcGxheSB2aWV3IChhbmQgYW55IG90aGVyIGhvc3QpIGNhbiBydW4gYWdhaW4uXG4vL1xuLy8gVGhlIGhvc3QncyBwYXJ0IGlzIHNtYWxsOiB0aGUgbWljcm9waG9uZSBhbmQgc3BlYWtlciAoYXVkaW8udHMpLCB0aGUgbW9kZWwncyBzb2NrZXQgdGhyb3VnaCB0aGVcbi8vIHNlcnZlcidzIHJlbGF5LCBIZXJtZXMgYW5kIFQzIHRocm91Z2ggdGhlIHNlcnZlciwgYW5kIHRoZSBzY3JlZW4uIFRoZSBjb3JlIGRlY2lkZXMgdGhlIHJlc3QuXG4vL1xuLy8gVHlwaW5nIHdpdGggbm8gY2FsbCBvbiBzdGFydHMgYSBjaGF0IGluc3RlYWQ6IHRoZSBzYW1lIGNvcmUgd2l0aCBgbWVkaXVtOiBcInRleHRcImAsIHdob3NlIHJlcXVlc3RzXG4vLyB0byB0aGUgdGV4dCBtb2RlbCBnbyB0aHJvdWdoIHRoZSBzZXJ2ZXIncyAvZ2VuZXJhdGUuIFRhc2tzLCBmb2xsb3ctdXBzIGFuZCB0aGVpciBjYXJkcyB3b3JrIGFzXG4vLyBpbiBhIGNhbGwuIFByZXNzaW5nIENhbGwgZW5kcyB0aGUgY2hhdCBhbmQgY2FycmllcyBpdHMgY29udmVyc2F0aW9uIG9uIGJ5IHZvaWNlLlxuXG5pbXBvcnQgeyBjb21tYW5kSW4gfSBmcm9tIFwiLi4vc3JjL2NvbW1hbmRzLnRzXCI7XG5pbXBvcnQgeyBDYWxsQXVkaW8sIGJ5dGVzVG9CYXNlNjQgfSBmcm9tIFwiLi9hdWRpby50c1wiO1xuaW1wb3J0IHsgUmVwbGF5IH0gZnJvbSBcIi4vcmVwbGF5LnRzXCI7XG5pbXBvcnQgeyBBdXRvU2Nyb2xsZXIgfSBmcm9tIFwiLi9zY3JvbGwudHNcIjtcbmltcG9ydCB7XG4gIGNhbkZvbGxvd1VwUmVzdWx0LFxuICBmb3JtYXRTaG9ydFRpbWUsXG4gIG5vcm1hbGl6ZURlbnNpdHksXG4gIG5vcm1hbGl6ZVNpZGVGaWx0ZXIsXG4gIHBhcnNlUHJlZml4LFxuICBwbGFpblByZXZpZXcsXG4gIHJlc29sdmVNb2JpbGVCYW5uZXJGaWx0ZXIsXG4gIHJlc29sdmVTaWRlU2VjdGlvbnMsXG4gIHNob3VsZENsZWFyVW5yZWFkUmVzdWx0cyxcbiAgdHlwZSBTaWRlRmlsdGVyLFxufSBmcm9tIFwiLi91aS50c1wiO1xuaW1wb3J0IHsgU2NyZWVuV2FrZUxvY2ssIFdha2VBdWRpb0dhdGUsIFdha2VDbGllbnQsIHR5cGUgV2FrZURldGVjdGlvbkV2ZW50LCB0eXBlIFdha2VUZWxlbWV0cnkgfSBmcm9tIFwiLi93YWtlQ2xpZW50LnRzXCI7XG5cbmludGVyZmFjZSBDb3JlIHtcbiAgdmVyc2lvbjogc3RyaW5nO1xuICBkZWZhdWx0cygpOiBzdHJpbmc7XG4gIGNyZWF0ZShjb25maWc6IHN0cmluZywgdDogbnVtYmVyKTogc3RyaW5nO1xuICBwdXNoKGlkOiBudW1iZXIsIGV2ZW50OiBzdHJpbmcpOiBzdHJpbmc7XG4gIHRyYWNlKGlkOiBudW1iZXIpOiBzdHJpbmc7XG4gIGRpc3Bvc2UoaWQ6IG51bWJlcik6IHZvaWQ7XG59XG50eXBlIENvbW1hbmQgPSBSZWNvcmQ8c3RyaW5nLCBhbnk+ICYgeyB0eXBlOiBzdHJpbmcgfTtcbmludGVyZmFjZSBXYWtlTW9kZWxJbmZvIHsgaWQ6IHN0cmluZzsgbGFiZWw6IHN0cmluZyB9XG5pbnRlcmZhY2UgU2VydmVyQ29uZmlnIHsgcm91dGU6IHN0cmluZzsgbW9kZWw6IHN0cmluZzsgY2FwdGlvbnNNb2RlbD86IHN0cmluZzsgdGV4dE1vZGVsPzogc3RyaW5nOyB2ZXJzaW9uOiBzdHJpbmc7IGhlcm1lczogYm9vbGVhbjsgdDM6IHN0cmluZ1tdIHwgbnVsbDsgd2FrZU1vZGVscz86IFdha2VNb2RlbEluZm9bXSB9XG5cbmNvbnN0ICQgPSA8VCBleHRlbmRzIEhUTUxFbGVtZW50ID0gSFRNTEVsZW1lbnQ+KGlkOiBzdHJpbmcpID0+IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGlkKSBhcyBUO1xuY29uc3Qgbm93ID0gKCkgPT4gcGVyZm9ybWFuY2Uubm93KCkgLyAxMDAwO1xuY29uc3QgY2hlY2tlZCA9IChpZDogc3RyaW5nKSA9PiAkPEhUTUxJbnB1dEVsZW1lbnQ+KGlkKS5jaGVja2VkO1xuXG4vKiogVGhlIGxhdGVzdCBidWlsZCBmcm9tIHRoZSBkZXYgc2VydmVyLCBldmFsdWF0ZWQgYWZyZXNoOiBhbiBlZGl0IGluIHNyYy8gaXMgaW4gdGhlIG5leHQgY2FsbC4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBsb2FkQ29yZSh1cmwgPSBcIi92b2ljZS1jb3JlLmpzXCIpOiBQcm9taXNlPENvcmU+IHtcbiAgY29uc3Qgc291cmNlID0gYXdhaXQgKGF3YWl0IGZldGNoKHVybCwgeyBjYWNoZTogXCJuby1zdG9yZVwiIH0pKS50ZXh0KCk7XG4gIGNvbnN0IHNjb3BlOiB7IFZvaWNlQ29yZT86IENvcmUgfSA9IHt9O1xuICBuZXcgRnVuY3Rpb24oXCJnbG9iYWxUaGlzXCIsIHNvdXJjZSkoc2NvcGUpO1xuICBpZiAoIXNjb3BlLlZvaWNlQ29yZSkgdGhyb3cgbmV3IEVycm9yKFwidGhlIGJ1bmRsZSBkaWRuJ3QgZGVmaW5lIFZvaWNlQ29yZVwiKTtcbiAgcmV0dXJuIHNjb3BlLlZvaWNlQ29yZTtcbn1cblxuLy8gUHJlc2V0czogZWFjaCBzdXJmYWNlJ3Mgc2V0dGluZ3MgYXMgaXRzIGFwcCB3b3VsZCBzZXQgdGhlbS5cblxuY29uc3QgRkFLRV9UViA9IFtcbiAgeyBuYW1lOiBcInR2X3ZvbHVtZVwiLCBkZXNjcmlwdGlvbjogXCJTZXRzIHRoZSBsaXZpbmctcm9vbSBUVidzIHZvbHVtZSwgMCB0byAxMDAuXCIsIHBhcmFtZXRlcnM6IHsgdHlwZTogXCJPQkpFQ1RcIiwgcHJvcGVydGllczogeyBsZXZlbDogeyB0eXBlOiBcIklOVEVHRVJcIiB9IH0sIHJlcXVpcmVkOiBbXCJsZXZlbFwiXSB9IH0sXG4gIHsgbmFtZTogXCJ0dl9wYXVzZVwiLCBkZXNjcmlwdGlvbjogXCJQYXVzZXMgb3IgcmVzdW1lcyB3aGF0J3MgcGxheWluZyBvbiB0aGUgVFYuXCIsIHBhcmFtZXRlcnM6IHsgdHlwZTogXCJPQkpFQ1RcIiwgcHJvcGVydGllczogeyBwYXVzZTogeyB0eXBlOiBcIkJPT0xFQU5cIiB9IH0gfSB9LFxuXTtcblxuY29uc3QgUFJFU0VUUzogUmVjb3JkPHN0cmluZywgUmVjb3JkPHN0cmluZywgdW5rbm93bj4+ID0ge1xuICB3ZWI6IHsgcGxhdGZvcm06IFwid2ViXCIsIGRldmljZTogXCJicm93c2VyXCIsIHN0YW5kYnlBZnRlcjogMzAsIGhhbmRPZmY6IFwibmFtZWRcIiwgc3VwZXJ2aXNlOiB0cnVlLCB2b2NhYnVsYXJ5OiBbXCJIZXJtZXNcIiwgXCJCZW50b1wiLCBcIldvb2Rob3VzZVwiLCBcIlBlbm55d29ydGhcIiwgXCJUM1wiXSB9LFxuICBcIndlYiB3YWtlIHdvcmRcIjoge1xuICAgIHBsYXRmb3JtOiBcIndlYlwiLCBkZXZpY2U6IFwiYnJvd3NlclwiLCBzdGFuZGJ5QWZ0ZXI6IDIwLCBoYW5nVXBBZnRlcjogMTIwLCBoYW5kT2ZmOiBcIm5hbWVkXCIsIHN1cGVydmlzZTogdHJ1ZSxcbiAgICBhdHRlbnRpb246IHsgbW9kZTogXCJ3aW5kb3dcIiwgYWZ0ZXJXYWtlOiA4LCB3aW5kb3c6IDUsIGFmdGVyUXVlc3Rpb246IDEwLCBhZnRlckhhbmRPZmY6IDMsIGFmdGVyQW5ub3VuY2VtZW50OiAwIH0sXG4gICAgdm9jYWJ1bGFyeTogW1wiSGVybWVzXCIsIFwiQmVudG9cIiwgXCJXb29kaG91c2VcIiwgXCJQZW5ueXdvcnRoXCIsIFwiVDNcIl0sXG4gIH0sXG4gIGFuZHJvaWQ6IHsgcGxhdGZvcm06IFwiQW5kcm9pZFwiLCBkZXZpY2U6IFwicGhvbmVcIiwgc3RhbmRieUFmdGVyOiAyMCB9LFxuICBcImFuZHJvaWQgd2FrZSB3b3JkXCI6IHsgcGxhdGZvcm06IFwiQW5kcm9pZFwiLCBkZXZpY2U6IFwicGhvbmVcIiwgc3RhbmRieUFmdGVyOiAyMCwgaGFuZ1VwQWZ0ZXI6IDE1IH0sXG4gIG1hY29zOiB7IHBsYXRmb3JtOiBcIm1hY09TXCIsIGRldmljZTogXCJNYWNcIiwgc3RhbmRieUFmdGVyOiAyMCB9LFxuICBlY2hvOiB7XG4gICAgcGxhdGZvcm06IFwiRWNob1wiLCBkZXZpY2U6IFwic3BlYWtlclwiLCBoYW5nVXBBZnRlcjogNiwgc3RhbmRieUFmdGVyOiA4LCBlYXJjb25zOiB0cnVlLCB2b2NhYnVsYXJ5OiBbXCJIZXJtZXNcIiwgXCJCZW50b1wiLCBcIldvb2Rob3VzZVwiXSxcbiAgICBtaWM6IHsgd2hpbGVTcGVha2luZzogXCJ3YWtlXCIsIGdhaW5EYjogMCB9LCBob3N0VG9vbHM6IEZBS0VfVFYsXG4gIH0sXG59O1xuXG4vLyBTdGF0ZS5cblxuY29uc3QgYXVkaW8gPSBuZXcgQ2FsbEF1ZGlvKCk7XG5sZXQgc2VydmVyOiBTZXJ2ZXJDb25maWc7XG5sZXQgY29yZTogQ29yZSB8IG51bGwgPSBudWxsO1xubGV0IGNhbGxJZCA9IDA7XG4vKiogTW9ub3RvbmljIHBlci1wYWdlIHNlc3Npb24gaWQgKHVubGlrZSBjb3JlJ3MgY2FsbElkL3Rhc2tJZCwgd2hpY2ggcmVzdGFydCBhZnRlciBsb2FkQ29yZSgpKS4gKi9cbmxldCBzZXNzaW9uU2VxID0gMDtcbmxldCBhY3RpdmVTZXNzaW9uID0gMDtcbmxldCBjYWxsTmFtZSA9IFwiXCI7XG5sZXQgdGlja2VyID0gMDtcbmxldCB0cmFjZVRpbWVyID0gMDtcbmxldCBzdGFydGVkQXQgPSBub3coKTtcbmNvbnN0IHNvY2tldHMgPSBuZXcgTWFwPG51bWJlciwgV2ViU29ja2V0PigpO1xuLyoqIFRoZSBzb2NrZXRzIHRvIHRoZSB0cmFuc2NyaXB0aW9uIG1vZGVsOiB0aGVpciBhdWRpbyBpcyB0aGUgbW9kZWwncyBhZ2Fpbiwgc28gaXQgaXNuJ3QgY291bnRlZCBvciBsb2dnZWQgdHdpY2UuICovXG5jb25zdCBjYXB0aW9uU29ja2V0cyA9IG5ldyBTZXQ8bnVtYmVyPigpO1xuY29uc3QgcnVucyA9IG5ldyBNYXA8c3RyaW5nLCB7IGFib3J0OiBBYm9ydENvbnRyb2xsZXI7IGFnZW50OiBzdHJpbmc7IHRhc2tJZDogc3RyaW5nIH0+KCk7XG5pbnRlcmZhY2UgVGFza1ZpZXcgeyBjOiBDb21tYW5kOyBzaW5jZTogbnVtYmVyOyBlbmRlZDogbnVtYmVyIHwgbnVsbDsgdGhyZWFkPzogc3RyaW5nOyByZXN1bHRJZD86IHN0cmluZzsgYXBwcm92YWw/OiB7IGNvbW1hbmQ6IHN0cmluZyB9IH1cbmNvbnN0IHRhc2tzID0gbmV3IE1hcDxzdHJpbmcsIFRhc2tWaWV3PigpO1xuaW50ZXJmYWNlIFJlc3VsdEVudHJ5IHtcbiAgaWQ6IHN0cmluZztcbiAgYWdlbnQ6IHN0cmluZztcbiAgbGFiZWw6IHN0cmluZztcbiAgdGV4dDogc3RyaW5nO1xuICBmYWlsZWQ6IGJvb2xlYW47XG4gIHRhc2tJZD86IHN0cmluZztcbiAgc2Vzc2lvbklkOiBudW1iZXI7XG4gIGNhcmQ6IEhUTUxFbGVtZW50O1xuICBoZWFkOiBIVE1MQnV0dG9uRWxlbWVudDtcbiAgYm9keTogSFRNTEVsZW1lbnQ7XG4gIG1vcmVCdG46IEhUTUxCdXR0b25FbGVtZW50O1xuICBmb2xsb3dCdG4/OiBIVE1MQnV0dG9uRWxlbWVudDtcbiAgcmVmUm93OiBIVE1MQnV0dG9uRWxlbWVudDtcbn1cbmNvbnN0IHJlc3VsdHMgPSBuZXcgTWFwPHN0cmluZywgUmVzdWx0RW50cnk+KCk7XG5sZXQgbmV4dFJlc3VsdFNlcSA9IDA7XG5sZXQgc2lkZUZpbHRlcjogU2lkZUZpbHRlciA9IFwiYWxsXCI7XG5sZXQgdW5yZWFkTW9iaWxlUmVzdWx0cyA9IDA7XG5sZXQgZmxhc2hUaW1lciA9IDA7XG5sZXQgZWFybGllckFjdGl2ZUNvdW50ID0gMDtcbmxldCBlYXJsaWVyV2FpdGluZ0NvdW50ID0gMDtcbmxldCBjb3VudHMgPSB7IG1pYzogMCwgcGxheTogMCwgc2VudDogMCB9O1xubGV0IGZha2VUdkxldmVsID0gMTU7XG5sZXQgY29yZVN0YXR1cyA9IFwiaWRsZVwiO1xubGV0IG11dGVkID0gZmFsc2U7XG5sZXQgaG9sZGluZyA9IGZhbHNlO1xuY29uc3Qgc2NyZWVuV2FrZUxvY2sgPSBuZXcgU2NyZWVuV2FrZUxvY2soKTtcbi8qKiBXYWtlIHdvcmQgbG9vcCBzdGF0ZTogYXJtZWQgYmV0d2VlbiBjYWxscywgcmVxdWVzdGVkIGJ5IGNvcmUgd2hpbGUgZG9ybWFudC9zcGVha2luZywgb3IgbWlkLWhhbmRvZmYuICovXG5sZXQgd2FrZUFybWVkID0gZmFsc2U7XG5sZXQgYXJtR2VuID0gMDtcbmxldCBjb3JlV2FudHNXYWtlID0gZmFsc2U7XG4vKiogV2hpY2ggY2FsbCAob3IgMCBmb3IgaWRsZSkgb3ducyB0aGUgd2FrZSB3b3JrZXIncyBjdXJyZW50IGxpc3RlbmluZyBwZXJpb2QuICovXG5sZXQgd2FrZVBlcmlvZENhbGxJZDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5jb25zdCB3YWtlR2F0ZSA9IG5ldyBXYWtlQXVkaW9HYXRlKCk7XG5sZXQgd2FrZUxvYWRpbmcgPSBmYWxzZTtcbmxldCB3YWtlU3RhcnRpbmcgPSBmYWxzZTtcbmxldCBzdGFydGluZ0NhbGwgPSBmYWxzZTtcbmxldCBvcGVuaW5nQ2h1bmtzOiBVaW50OEFycmF5W10gPSBbXTtcbmxldCBvcGVuaW5nQnl0ZXMgPSAwO1xuY29uc3QgT1BFTklOR19NQVhfQllURVMgPSAxMCAqIDMyXzAwMDtcbmxldCB3YWtlTGFzdFRlbDogV2FrZVRlbGVtZXRyeSB8IG51bGwgPSBudWxsO1xuLyoqIFdoYXQgdGhlIHNlc3Npb24gb24gc2NyZWVuIGlzOiBhIHZvaWNlIGNhbGwsIG9yIGEgdHlwZWQgY2hhdCAodGhlIGNvcmUncyBtZWRpdW0gXCJ0ZXh0XCIpLiAqL1xubGV0IG1lZGl1bTogXCJ2b2ljZVwiIHwgXCJ0ZXh0XCIgPSBcInZvaWNlXCI7XG4vKiogQSBjaGF0J3MgbW9kZWwgaXMgd3JpdGluZyBpdHMgYW5zd2VyLiAqL1xubGV0IHRoaW5raW5nID0gZmFsc2U7XG4vKiogQSBjaGF0J3MgcmVxdWVzdHMgdG8gdGhlIHRleHQgbW9kZWwgdGhhdCBhcmUgdW5kZXIgd2F5LiAqL1xuY29uc3QgcmVxdWVzdHMgPSBuZXcgTWFwPG51bWJlciwgQWJvcnRDb250cm9sbGVyPigpO1xuLyoqIFRoZSBsYXN0IHNlc3Npb24gd2luZGluZyBkb3duIChpdHMgdHJhY2Ugc2F2ZWQsIHRoZSBjb3JlJ3MgY2FsbCBkaXNwb3NlZCk6IHRoZSBuZXh0IHN0YXJ0cyBhZnRlciBpdC4gKi9cbmxldCBlbmRpbmc6IFByb21pc2U8dm9pZD4gPSBQcm9taXNlLnJlc29sdmUoKTtcblxuLy8gVGhlIGNvbnZlcnNhdGlvbiwga2VwdCBzbyBhIG5ldyBjYWxsIGNhbiBjYXJyeSBvbiBmcm9tIGl0ICh0aGUgY29yZSdzIGBoaXN0b3J5YCwgcmVjYXBwZWQgdG8gdGhlIG1vZGVsKS5cbmludGVyZmFjZSBDaGF0TGluZSB7IHJvbGU6IFwidXNlclwiIHwgXCJhc3Npc3RhbnRcIjsgc3BlYWtlcj86IHN0cmluZzsgdGV4dDogc3RyaW5nIH1cbmNvbnN0IEhJU1RPUlkgPSBcInZvaWNlLmhpc3RvcnlcIjtcbmNvbnN0IEhJU1RPUllfTUFYX0FHRSA9IDEyICogMzYwMCAqIDEwMDA7XG5sZXQgY2hhdDogQ2hhdExpbmVbXSA9IFtdO1xuLyoqIFRoZSBjb3JlJ3MgbnVtYmVyIGZvciB0aGUgbGluZSB0aGUgbGFzdCB3b3JkcyB3ZXJlIHJlbWVtYmVyZWQgb24sIHVudGlsIHNvbWV0aGluZyBlbHNlIGlzLiAqL1xubGV0IGxhc3RMaW5lOiBudW1iZXIgfCBudWxsID0gbnVsbDtcblxuZnVuY3Rpb24gcmVtZW1iZXIocm9sZTogXCJ1c2VyXCIgfCBcImFzc2lzdGFudFwiLCB0ZXh0OiBzdHJpbmcsIHNwZWFrZXI/OiBzdHJpbmcsIGpvaW4gPSBmYWxzZSkge1xuICBjb25zdCBsYXN0ID0gY2hhdC5hdCgtMSk7XG4gIGlmIChqb2luICYmIGxhc3QgJiYgbGFzdC5yb2xlID09PSByb2xlICYmIGxhc3Quc3BlYWtlciA9PT0gc3BlYWtlcikgbGFzdC50ZXh0ICs9IHRleHQ7XG4gIGVsc2UgY2hhdC5wdXNoKHNwZWFrZXIgPyB7IHJvbGUsIHNwZWFrZXIsIHRleHQgfSA6IHsgcm9sZSwgdGV4dCB9KTtcbiAgaWYgKGNoYXQubGVuZ3RoID4gMjAwKSBjaGF0LnNwbGljZSgwLCBjaGF0Lmxlbmd0aCAtIDIwMCk7XG4gIGxvY2FsU3RvcmFnZS5zZXRJdGVtKEhJU1RPUlksIEpTT04uc3RyaW5naWZ5KHsgYXQ6IERhdGUubm93KCksIGNoYXQgfSkpO1xufVxuXG5mdW5jdGlvbiBzYXZlZEhpc3RvcnkoKTogQ2hhdExpbmVbXSB7XG4gIHRyeSB7XG4gICAgY29uc3Qgc2F2ZWQgPSBKU09OLnBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKEhJU1RPUlkpID8/IFwibnVsbFwiKTtcbiAgICByZXR1cm4gc2F2ZWQgJiYgRGF0ZS5ub3coKSAtIHNhdmVkLmF0IDwgSElTVE9SWV9NQVhfQUdFICYmIEFycmF5LmlzQXJyYXkoc2F2ZWQuY2hhdCkgPyBzYXZlZC5jaGF0IDogW107XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBbXTtcbiAgfVxufVxuXG4vKiogVHdvLW5vdGUgY2hpbWUsIFBDTTE2IG1vbm8gYXQgMjQga0h6LCBiYXNlNjQuICovXG5mdW5jdGlvbiB0d29Ob3RlVG9uZShmMTogbnVtYmVyLCBmMjogbnVtYmVyLCBub3RlU2VjOiBudW1iZXIsIGFtcDogbnVtYmVyKTogc3RyaW5nIHtcbiAgY29uc3QgcmF0ZSA9IDI0MDAwLCBuID0gTWF0aC5yb3VuZChyYXRlICogbm90ZVNlYyAqIDIpLCBoYWxmID0gTWF0aC5yb3VuZChyYXRlICogbm90ZVNlYyksIG91dCA9IG5ldyBJbnQxNkFycmF5KG4pO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IG47IGkrKykge1xuICAgIGNvbnN0IGZpcnN0ID0gaSA8IGhhbGY7XG4gICAgY29uc3QgdCA9IGkgLyByYXRlLCBmID0gZmlyc3QgPyBmMSA6IGYyLCBsb2NhbCA9IGZpcnN0ID8gdCA6IHQgLSBub3RlU2VjO1xuICAgIGNvbnN0IGVudiA9IE1hdGgubWluKDEsIGxvY2FsICogNjAsIChub3RlU2VjIC0gbG9jYWwpICogNjApO1xuICAgIG91dFtpXSA9IE1hdGgucm91bmQoTWF0aC5zaW4oMiAqIE1hdGguUEkgKiBmICogdCkgKiBNYXRoLm1heCgwLCBlbnYpICogYW1wKTtcbiAgfVxuICByZXR1cm4gYnl0ZXNUb0Jhc2U2NChuZXcgVWludDhBcnJheShvdXQuYnVmZmVyKSk7XG59XG5cbi8qKiBUd28gcmlzaW5nIG5vdGVzOiBzb21ldGhpbmcgb24gdGhlIHNjcmVlbiBuZWVkcyB0aGUgdXNlci4gKi9cbmNvbnN0IEFQUFJPVkFMX1RPTkUgPSB0d29Ob3RlVG9uZSg2NjAsIDg4MCwgMC4xNiwgNjAwMCk7XG4vKiogQ3Jpc3AgcmlzaW5nIGNoaW1lOiB0aGUgd2FrZSB3b3JkIGZpcmVkIChzdGFydCBzaWduYWwpLiAqL1xuY29uc3QgV0FLRV9UT05FID0gdHdvTm90ZVRvbmUoNTg3LjMzLCA4ODAsIDAuMTEsIDU1MDApO1xuLyoqIFNvZnQgZmFsbGluZyBjaGltZTogdGhlIGF0dGVudGlvbiB3aW5kb3cgY2xvc2VkIGFuZCB0aGUgY2FsbCB3ZW50IGRvcm1hbnQgKGVuZCBzaWduYWwpLiAqL1xuY29uc3QgU0xFRVBfVE9ORSA9IHR3b05vdGVUb25lKDY1OS4yNSwgNDkzLjg4LCAwLjExLCAzNDAwKTtcblxuLy8gTGF0ZW5jeTogdGhlIG5ldHdvcmsncyByb3VuZCB0cmlwLCBhbmQgaG93IGxvbmcgYWZ0ZXIgdGhlIHVzZXIgc3RvcHMgdGFsa2luZyB0aGUgcmVwbHkgc3RhcnRzLlxuY29uc3QgbWV0cmljcyA9IHsgcnR0OiBbXSBhcyBudW1iZXJbXSwgcmVwbHk6IFtdIGFzIG51bWJlcltdLCBsYXN0Vm9pY2U6IDAsIGxhc3RQbGF5OiAwLCByZXBsaWVkOiB0cnVlIH07XG5cbmZ1bmN0aW9uIG1lZGlhbih4czogbnVtYmVyW10pOiBudW1iZXIgfCBudWxsIHtcbiAgaWYgKHhzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHMgPSBbLi4ueHNdLnNvcnQoKGEsIGIpID0+IGEgLSBiKTtcbiAgcmV0dXJuIHNbTWF0aC5mbG9vcihzLmxlbmd0aCAvIDIpXTtcbn1cblxuZnVuY3Rpb24gc2hvd01ldHJpY3MoKSB7XG4gIGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBydHQgPSBtZWRpYW4obWV0cmljcy5ydHQpO1xuICBpZiAocnR0ICE9IG51bGwpIHBhcnRzLnB1c2goYCR7TWF0aC5yb3VuZChydHQgKiAxMDAwKX0gbXNgKTtcbiAgY29uc3QgcmVwbHkgPSBtZWRpYW4obWV0cmljcy5yZXBseSk7XG4gIGlmIChyZXBseSAhPSBudWxsKSBwYXJ0cy5wdXNoKGByZXBseSAke21ldHJpY3MucmVwbHkuYXQoLTEpIS50b0ZpeGVkKDEpfXMgKCR7cmVwbHkudG9GaXhlZCgxKX1zIG1lZClgKTtcbiAgY29uc3Qgb3V0ID0gYXVkaW8ub3V0cHV0TGF0ZW5jeTtcbiAgaWYgKG91dCAhPSBudWxsKSBwYXJ0cy5wdXNoKGBhdWRpbyAke01hdGgucm91bmQob3V0ICogMTAwMCl9IG1zYCk7XG4gIGxldCBidWZmZXJlZCA9IDA7XG4gIGZvciAoY29uc3Qgd3Mgb2Ygc29ja2V0cy52YWx1ZXMoKSkgYnVmZmVyZWQgKz0gd3MuYnVmZmVyZWRBbW91bnQ7XG4gIGlmIChidWZmZXJlZCA+IDMyXzAwMCkgcGFydHMucHVzaChgdXBsb2FkICskeyhidWZmZXJlZCAvIDMyXzAwMCkudG9GaXhlZCgxKX1zYCk7XG4gICQoXCJtZXRyaWNzXCIpLnRleHRDb250ZW50ID0gcGFydHMuam9pbihcIiBcdTAwQjcgXCIpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBwaW5nKCkge1xuICBjb25zdCB0ID0gbm93KCk7XG4gIHRyeSB7XG4gICAgYXdhaXQgZmV0Y2goXCIvcGluZ1wiLCB7IGNhY2hlOiBcIm5vLXN0b3JlXCIgfSk7XG4gICAgbWV0cmljcy5ydHQucHVzaChub3coKSAtIHQpO1xuICAgIGlmIChtZXRyaWNzLnJ0dC5sZW5ndGggPiAxMikgbWV0cmljcy5ydHQuc2hpZnQoKTtcbiAgfSBjYXRjaCB7fVxuICBzaG93TWV0cmljcygpO1xufVxuXG4vLyBUaGVtZSAmIGRlbnNpdHkuXG5cbmZ1bmN0aW9uIGFwcGx5VGhlbWUoY2hvaWNlOiBzdHJpbmcpIHtcbiAgY29uc3Qgcm9vdCA9IGRvY3VtZW50LmRvY3VtZW50RWxlbWVudDtcbiAgaWYgKGNob2ljZSA9PT0gXCJkYXJrXCIgfHwgY2hvaWNlID09PSBcImxpZ2h0XCIpIHJvb3QuZGF0YXNldC50aGVtZSA9IGNob2ljZTtcbiAgZWxzZSBkZWxldGUgcm9vdC5kYXRhc2V0LnRoZW1lO1xuICBjb25zdCBkYXJrID0gY2hvaWNlID09PSBcImRhcmtcIiB8fCAoY2hvaWNlICE9PSBcImxpZ2h0XCIgJiYgbWF0Y2hNZWRpYShcIihwcmVmZXJzLWNvbG9yLXNjaGVtZTogZGFyaylcIikubWF0Y2hlcyk7XG4gIGNvbnN0IG1ldGEgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInRoZW1lLWNvbG9yXCIpO1xuICBpZiAobWV0YSkgbWV0YS5zZXRBdHRyaWJ1dGUoXCJjb250ZW50XCIsIGRhcmsgPyBcIiMwZTBmMGZcIiA6IFwiI2Y2ZjVmMFwiKTtcbiAgZm9yIChjb25zdCBidG4gb2YgQXJyYXkuZnJvbShkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxCdXR0b25FbGVtZW50PihcIiN0aGVtZS1waWNrZXIgYnV0dG9uXCIpKSkge1xuICAgIGJ0bi5jbGFzc0xpc3QudG9nZ2xlKFwib25cIiwgYnRuLmRhdGFzZXQudGhlbWUgPT09IChjaG9pY2UgfHwgXCJzeXN0ZW1cIikpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGFwcGx5RGVuc2l0eShjaG9pY2U6IHN0cmluZyB8IG51bGwpIHtcbiAgY29uc3QgZGVuc2l0eSA9IG5vcm1hbGl6ZURlbnNpdHkoY2hvaWNlKTtcbiAgY29uc3Qgcm9vdCA9IGRvY3VtZW50LmRvY3VtZW50RWxlbWVudDtcbiAgaWYgKGRlbnNpdHkgPT09IFwiY29tZm9ydGFibGVcIikgcm9vdC5kYXRhc2V0LmRlbnNpdHkgPSBcImNvbWZvcnRhYmxlXCI7XG4gIGVsc2UgZGVsZXRlIHJvb3QuZGF0YXNldC5kZW5zaXR5O1xuICBmb3IgKGNvbnN0IGJ0biBvZiBBcnJheS5mcm9tKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiI2RlbnNpdHktcGlja2VyIGJ1dHRvblwiKSkpIHtcbiAgICBidG4uY2xhc3NMaXN0LnRvZ2dsZShcIm9uXCIsIGJ0bi5kYXRhc2V0LmRlbnNpdHkgPT09IGRlbnNpdHkpO1xuICB9XG4gIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB1cGRhdGVBbGxSZXN1bHRDbGFtcGluZygpKTtcbn1cblxuLy8gVGhlIHNjcmVlbi5cblxuZnVuY3Rpb24gc2V0Q2FsbEJ1dHRvbihsaXZlOiBib29sZWFuKSB7XG4gIGNvbnN0IGJ0biA9ICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiY2FsbFwiKTtcbiAgYnRuLmNsYXNzTGlzdC50b2dnbGUoXCJsaXZlXCIsIGxpdmUpO1xuICBjb25zdCBsYWJlbCA9IGJ0bi5xdWVyeVNlbGVjdG9yKFwiLmNhbGwtbGFiZWxcIik7XG4gIGlmIChsYWJlbCkgbGFiZWwudGV4dENvbnRlbnQgPSBsaXZlID8gXCJIYW5nIHVwXCIgOiBcIkNhbGxcIjtcbn1cblxuZnVuY3Rpb24gc3luY1Jlc3VtZUJ1dHRvbnMoc2hvdzogYm9vbGVhbikge1xuICAkKFwicmVzdW1lXCIpLmhpZGRlbiA9ICFzaG93O1xuICAkKFwiaGVyby1yZXN1bWVcIikuaGlkZGVuID0gIXNob3c7XG59XG5cbmZ1bmN0aW9uIHN5bmNDb21wb3NlcigpIHtcbiAgY29uc3QgaW5wdXQgPSAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwidGV4dFwiKTtcbiAgY29uc3QgdHJpbW1lZCA9IGlucHV0LnZhbHVlLnRyaW0oKTtcbiAgJChcInNlbmRidG5cIikuY2xhc3NMaXN0LnRvZ2dsZShcInJlYWR5XCIsIHRyaW1tZWQubGVuZ3RoID4gMCk7XG4gIGNvbnN0IHBhcnNlZCA9IHBhcnNlUHJlZml4KHRyaW1tZWQpO1xuICAkKFwibW9kZS13cmFwXCIpLmRhdGFzZXQubW9kZSA9IHBhcnNlZC5tb2RlID8/ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwibW9kZVwiKS52YWx1ZTtcbn1cblxuZnVuY3Rpb24gZm9ybWF0Q2xvY2soc2Vjb25kczogbnVtYmVyKTogc3RyaW5nIHtcbiAgY29uc3QgdG90YWwgPSBNYXRoLm1heCgwLCBNYXRoLmZsb29yKHNlY29uZHMpKTtcbiAgY29uc3QgaCA9IE1hdGguZmxvb3IodG90YWwgLyAzNjAwKTtcbiAgY29uc3QgbSA9IE1hdGguZmxvb3IoKHRvdGFsICUgMzYwMCkgLyA2MCk7XG4gIGNvbnN0IHMgPSB0b3RhbCAlIDYwO1xuICBjb25zdCBwYWQgPSAobjogbnVtYmVyKSA9PiBTdHJpbmcobikucGFkU3RhcnQoMiwgXCIwXCIpO1xuICByZXR1cm4gaCA+IDAgPyBgJHtofToke3BhZChtKX06JHtwYWQocyl9YCA6IGAke3BhZChtKX06JHtwYWQocyl9YDtcbn1cblxuY29uc3QgVklaX1dFSUdIVFMgPSBbMC40OCwgMC44NiwgMS4wLCAwLjc4LCAwLjQ0XTtcbmZ1bmN0aW9uIHVwZGF0ZVZpc3VhbGl6ZXIobW9kZTogc3RyaW5nLCBsZXZlbDogbnVtYmVyKSB7XG4gIGNvbnN0IHZpeiA9ICQoXCJ2aXpcIik7XG4gIHZpei5kYXRhc2V0Lm1vZGUgPSBtb2RlO1xuICBjb25zdCBiYXJzID0gdml6LmNoaWxkcmVuO1xuICBpZiAobW9kZSA9PT0gXCJsaXN0ZW5pbmdcIiB8fCBtb2RlID09PSBcIndvcmtpbmdcIikge1xuICAgIGNvbnN0IGVuZXJneSA9IE1hdGgubWluKDEsIGxldmVsICogMTQpO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYmFycy5sZW5ndGg7IGkrKykge1xuICAgICAgY29uc3QgaCA9IDAuMjQgKyBlbmVyZ3kgKiBWSVpfV0VJR0hUU1tpXSAqIDAuNzY7XG4gICAgICAoYmFyc1tpXSBhcyBIVE1MRWxlbWVudCkuc3R5bGUudHJhbnNmb3JtID0gYHNjYWxlWSgke2gudG9GaXhlZCgyKX0pYDtcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBiYXJzLmxlbmd0aDsgaSsrKSAoYmFyc1tpXSBhcyBIVE1MRWxlbWVudCkuc3R5bGUudHJhbnNmb3JtID0gXCJcIjtcbiAgfVxufVxuXG4vKiogQSBzeXN0ZW0gbm90aWZpY2F0aW9uIHdoaWxlIHRoZSBwYWdlIGlzIGhpZGRlbjogYSB0YXNrIGZpbmlzaGVkLCBvciBvbmUgbmVlZHMgdGhlIHVzZXIuICovXG5mdW5jdGlvbiBub3RpZnkodGl0bGU6IHN0cmluZywgYm9keTogc3RyaW5nKSB7XG4gIGlmICghZG9jdW1lbnQuaGlkZGVuIHx8ICEoXCJOb3RpZmljYXRpb25cIiBpbiB3aW5kb3cpIHx8IE5vdGlmaWNhdGlvbi5wZXJtaXNzaW9uICE9PSBcImdyYW50ZWRcIikgcmV0dXJuO1xuICB0cnkge1xuICAgIGNvbnN0IG4gPSBuZXcgTm90aWZpY2F0aW9uKHRpdGxlLCB7IGJvZHk6IGJvZHkuc2xpY2UoMCwgMTgwKSwgaWNvbjogXCIvd2ViL2ljb25zL2ljb24tMTkyLnBuZ1wiLCB0YWc6IHRpdGxlIH0pO1xuICAgIG4ub25jbGljayA9ICgpID0+IHsgd2luZG93LmZvY3VzKCk7IG4uY2xvc2UoKTsgfTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gUGhvbmVzIHdhbnQgbm90aWZpY2F0aW9ucyBmcm9tIGEgc2VydmljZSB3b3JrZXI7IHRoZSBwYWdlIGhhcyBub25lLlxuICB9XG59XG5cbmZ1bmN0aW9uIHRvYXN0KHRleHQ6IHN0cmluZykge1xuICBjb25zdCB0ID0gJChcInRvYXN0XCIpO1xuICB0LnRleHRDb250ZW50ID0gdGV4dDtcbiAgdC5jbGFzc0xpc3QuYWRkKFwib25cIik7XG4gIGNsZWFyVGltZW91dCgodG9hc3QgYXMgYW55KS50aW1lcik7XG4gICh0b2FzdCBhcyBhbnkpLnRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB0LmNsYXNzTGlzdC5yZW1vdmUoXCJvblwiKSwgMTgwMCk7XG59XG5cbmZ1bmN0aW9uIGxvZyhraW5kOiBzdHJpbmcsIHRleHQ6IHN0cmluZywgY2xzID0gXCJcIikge1xuICBjb25zdCBwYW5lID0gJChcImxvZ1wiKTtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IGByb3cgJHtjbHN9YDtcbiAgcm93LmlubmVySFRNTCA9IGA8c3BhbiBjbGFzcz1cInRcIj4keyhub3coKSAtIHN0YXJ0ZWRBdCkudG9GaXhlZCgyKX08L3NwYW4+PHNwYW4gY2xhc3M9XCJrXCI+JHtraW5kfTwvc3Bhbj5gO1xuICBjb25zdCBib2R5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGJvZHkuY2xhc3NOYW1lID0gXCJiXCI7XG4gIGJvZHkudGV4dENvbnRlbnQgPSB0ZXh0O1xuICByb3cuYXBwZW5kKGJvZHkpO1xuICBjb25zdCBzdGljayA9IHBhbmUuc2Nyb2xsVG9wICsgcGFuZS5jbGllbnRIZWlnaHQgPj0gcGFuZS5zY3JvbGxIZWlnaHQgLSAzMDtcbiAgcGFuZS5hcHBlbmQocm93KTtcbiAgd2hpbGUgKHBhbmUuY2hpbGRFbGVtZW50Q291bnQgPiAzMDAwKSBwYW5lLmZpcnN0RWxlbWVudENoaWxkIS5yZW1vdmUoKTtcbiAgaWYgKHN0aWNrKSBwYW5lLnNjcm9sbFRvcCA9IHBhbmUuc2Nyb2xsSGVpZ2h0O1xufVxuXG4vKiogQSBmcmFtZSBmcm9tIG9yIHRvIEdlbWluaSwgd2l0aCBhdWRpbyBjdXQgb3V0LCBzaG9ydCBlbm91Z2ggdG8gcmVhZC4gKi9cbmZ1bmN0aW9uIGJyaWVmKGRhdGE6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBkYXRhLnJlcGxhY2UoL1wiZGF0YVwiOlwiW0EtWmEtejAtOSsvPV17NDAsfVwiL2csIChtKSA9PiBgXCJkYXRhXCI6XCJcdTIwMjYke01hdGgucm91bmQoKChtLmxlbmd0aCAtIDkpICogMykgLyA0KX0gYnl0ZXNcImApLnNsaWNlKDAsIDYwMCk7XG59XG5cbmZ1bmN0aW9uIGVzY2FwZUh0bWwodGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHRleHQucmVwbGFjZSgvWyY8PlwiJ10vZywgKGMpID0+ICh7IFwiJlwiOiBcIiZhbXA7XCIsIFwiPFwiOiBcIiZsdDtcIiwgXCI+XCI6IFwiJmd0O1wiLCAnXCInOiBcIiZxdW90O1wiLCBcIidcIjogXCImIzM5O1wiIH0pW2NdISk7XG59XG5cbi8qKiBBIGxpdHRsZSBNYXJrZG93biwgc2FmZWx5OiBjb2RlLCBib2xkLCBsaW5rcywgbGlzdHMgYW5kIGhlYWRpbmdzLCB0aGUgcmVzdCBhcyB0ZXh0LiAqL1xuZnVuY3Rpb24gbWFya2Rvd24odGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgYmxvY2tzID0gZXNjYXBlSHRtbCh0ZXh0LnRyaW0oKSkuc3BsaXQoL2BgYCg/OlxcdyspP1xcbj8vKTtcbiAgcmV0dXJuIGJsb2Nrcy5tYXAoKGJsb2NrLCBpKSA9PiB7XG4gICAgaWYgKGkgJSAyID09PSAxKSByZXR1cm4gYDxwcmU+PGNvZGU+JHtibG9jay5yZXBsYWNlKC9cXG4kLywgXCJcIil9PC9jb2RlPjwvcHJlPmA7XG4gICAgY29uc3QgaW5saW5lID0gKHM6IHN0cmluZykgPT4gc1xuICAgICAgLnJlcGxhY2UoL2AoW15gXFxuXSspYC9nLCBcIjxjb2RlPiQxPC9jb2RlPlwiKVxuICAgICAgLnJlcGxhY2UoL1xcKlxcKihbXipcXG5dKylcXCpcXCovZywgXCI8Yj4kMTwvYj5cIilcbiAgICAgIC5yZXBsYWNlKC9cXFsoW15cXF1cXG5dKylcXF1cXCgoaHR0cHM/OlxcL1xcL1teXFxzKV0rKVxcKS9nLCAnPGEgaHJlZj1cIiQyXCIgdGFyZ2V0PVwiX2JsYW5rXCIgcmVsPVwibm9vcGVuZXJcIj4kMTwvYT4nKVxuICAgICAgLnJlcGxhY2UoLyhefFtcXHMoXSkoaHR0cHM/OlxcL1xcL1teXFxzPCldKykvZywgJyQxPGEgaHJlZj1cIiQyXCIgdGFyZ2V0PVwiX2JsYW5rXCIgcmVsPVwibm9vcGVuZXJcIj4kMjwvYT4nKTtcbiAgICBsZXQgaHRtbCA9IFwiXCI7XG4gICAgbGV0IGxpc3Q6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgIGZvciAoY29uc3QgcmF3IG9mIGJsb2NrLnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgICBjb25zdCBpdGVtID0gcmF3Lm1hdGNoKC9eXFxzKig/OlstKlx1MjAyMl18KFxcZCspWy4pXSlcXHMrKC4qKSQvKTtcbiAgICAgIGlmIChpdGVtKSB7XG4gICAgICAgIGNvbnN0IGtpbmQgPSBpdGVtWzFdID8gXCJvbFwiIDogXCJ1bFwiO1xuICAgICAgICBpZiAobGlzdCAhPT0ga2luZCkgeyBpZiAobGlzdCkgaHRtbCArPSBgPC8ke2xpc3R9PmA7IGh0bWwgKz0gYDwke2tpbmR9PmA7IGxpc3QgPSBraW5kOyB9XG4gICAgICAgIGh0bWwgKz0gYDxsaT4ke2lubGluZShpdGVtWzJdKX08L2xpPmA7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgaWYgKGxpc3QpIHsgaHRtbCArPSBgPC8ke2xpc3R9PmA7IGxpc3QgPSBudWxsOyB9XG4gICAgICBjb25zdCBoZWFkaW5nID0gcmF3Lm1hdGNoKC9eI3sxLDZ9XFxzKyguKikkLyk7XG4gICAgICBodG1sICs9IGhlYWRpbmcgPyBgPGRpdiBjbGFzcz1cIm1kLWhcIj4ke2lubGluZShoZWFkaW5nWzFdKX08L2Rpdj5gIDogcmF3LnRyaW0oKSA9PT0gXCJcIiA/IFwiPGJyPlwiIDogYCR7aW5saW5lKHJhdyl9PGJyPmA7XG4gICAgfVxuICAgIGlmIChsaXN0KSBodG1sICs9IGA8LyR7bGlzdH0+YDtcbiAgICByZXR1cm4gaHRtbC5yZXBsYWNlKC8oPGJyPikrJC8sIFwiXCIpO1xuICB9KS5qb2luKFwiXCIpO1xufVxuXG5jb25zdCB0cmFuc2NyaXB0U2Nyb2xsID0gbmV3IEF1dG9TY3JvbGxlcigkKFwidHJhbnNjcmlwdFwiKSwge1xuICBvbkp1bXBDaGFuZ2U6IChzaG93KSA9PiB7ICQoXCJqdW1wYm90dG9tXCIpLmhpZGRlbiA9ICFzaG93OyB9LFxuICBpc0VtcHR5OiAoKSA9PiAhJChcImVtcHR5XCIpLmhpZGRlbixcbn0pO1xuXG5mdW5jdGlvbiBzY3JvbGxEb3duKGZvcmNlID0gZmFsc2UpIHtcbiAgdHJhbnNjcmlwdFNjcm9sbC5vbkNvbnRlbnQoZm9yY2UpO1xufVxuXG4vKiogVGhlIGNvcmUncyBudW1iZXIgZm9yIHRoZSBsaW5lIHRoZSBsYXN0IHJvdyBzaG93cywgdW50aWwgYW5vdGhlciByb3cgZm9sbG93cyBpdC4gKi9cbmxldCBvcGVuTGluZTogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5cbi8qKiBXb3JkcyBnbyBvbiB0aGUgcm93IHRoZSBjb3JlIHNheXMgdGhleSBiZWxvbmcgdG86IGl0IHN0YXJ0cyBhIG5ldyBsaW5lIGZvciBlYWNoIHR1cm4sIGhvd2V2ZXIgbG9uZyB0aGUgZ2FwLiAqL1xuZnVuY3Rpb24gdHJhbnNjcmlwdChyb2xlOiBcInVzZXJcIiB8IFwiYXNzaXN0YW50XCIsIHRleHQ6IHN0cmluZywgbGluZTogbnVtYmVyKSB7XG4gICQoXCJlbXB0eVwiKS5oaWRkZW4gPSB0cnVlO1xuICBjb25zdCBwYW5lID0gJChcInRyYW5zY3JpcHRcIik7XG4gIGNvbnN0IGxhc3QgPSBwYW5lLmxhc3RFbGVtZW50Q2hpbGQgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAob3BlbkxpbmUgPT09IGxpbmUgJiYgbGFzdCAmJiBsYXN0LmRhdGFzZXQucm9sZSA9PT0gcm9sZSkgbGFzdC5xdWVyeVNlbGVjdG9yKFwiLnRleHRcIikhLnRleHRDb250ZW50ICs9IHRleHQ7XG4gIGVsc2Uge1xuICAgIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgcm93LmNsYXNzTmFtZSA9IGBsaW5lICR7cm9sZX1gO1xuICAgIHJvdy5kYXRhc2V0LnJvbGUgPSByb2xlO1xuICAgIHJvdy5pbm5lckhUTUwgPSBgPHNwYW4gY2xhc3M9XCJ3aG9cIj4ke3JvbGUgPT09IFwidXNlclwiID8gXCJZb3VcIiA6IFwiR2VtaW5pXCJ9PC9zcGFuPjxzcGFuIGNsYXNzPVwidGV4dFwiPjwvc3Bhbj5gO1xuICAgIHJvdy5xdWVyeVNlbGVjdG9yKFwiLnRleHRcIikhLnRleHRDb250ZW50ID0gdGV4dC50cmltU3RhcnQoKTtcbiAgICBwYW5lLmFwcGVuZChyb3cpO1xuICAgIG9wZW5MaW5lID0gbGluZTtcbiAgfVxuICBzY3JvbGxEb3duKCk7XG59XG5cbi8qKlxuICogVGhlIHdvcmRzIHRoZSB1c2VyIGlzIHNheWluZywgYmVmb3JlIHRoZSBtb2RlbCBoYXMgdHJhbnNjcmliZWQgdGhlbTogYSBmYWludCByb3cgdGhhdCBzdGF5cyBsYXN0XG4gKiBvbiBzY3JlZW4gKGl0cyBDU1MgYG9yZGVyYCkgYW5kIGZpcnN0IGluIHRoZSBwYW5lLCBzbyB0aGUgbGluZXMgYWZ0ZXIgaXQgam9pbiB1cCBhcyBiZWZvcmUuXG4gKi9cbmZ1bmN0aW9uIGNhcHRpb24odGV4dDogc3RyaW5nIHwgbnVsbCkge1xuICBjb25zdCBwYW5lID0gJChcInRyYW5zY3JpcHRcIik7XG4gIGxldCByb3cgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImNhcHRpb25cIik7XG4gIGlmICh0ZXh0ID09IG51bGwpIHsgcm93Py5yZW1vdmUoKTsgc2Nyb2xsRG93bigpOyByZXR1cm47IH1cbiAgJChcImVtcHR5XCIpLmhpZGRlbiA9IHRydWU7XG4gIGlmICghcm93KSB7XG4gICAgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICByb3cuaWQgPSBcImNhcHRpb25cIjtcbiAgICByb3cuY2xhc3NOYW1lID0gXCJsaW5lIHVzZXIgY2FwdGlvblwiO1xuICAgIHJvdy5pbm5lckhUTUwgPSBgPHNwYW4gY2xhc3M9XCJ3aG9cIj5Zb3U8L3NwYW4+PHNwYW4gY2xhc3M9XCJ0ZXh0XCI+PC9zcGFuPmA7XG4gICAgcGFuZS5wcmVwZW5kKHJvdyk7XG4gIH1cbiAgcm93LnF1ZXJ5U2VsZWN0b3IoXCIudGV4dFwiKSEudGV4dENvbnRlbnQgPSB0ZXh0O1xuICBzY3JvbGxEb3duKCk7XG59XG5cbmZ1bmN0aW9uIG5vdGUodGV4dDogc3RyaW5nKSB7XG4gICQoXCJlbXB0eVwiKS5oaWRkZW4gPSB0cnVlO1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gXCJsaW5lIG5vdGVcIjtcbiAgcm93LnRleHRDb250ZW50ID0gdGV4dDtcbiAgJChcInRyYW5zY3JpcHRcIikuYXBwZW5kKHJvdyk7XG4gIG9wZW5MaW5lID0gbnVsbDtcbiAgc2Nyb2xsRG93bigpO1xufVxuXG4vLyBBZ2VudCBoYW5kb2ZmIHJlc3VsdHM6IGNvbXBhY3QgMS1saW5lIHJlZmVyZW5jZSBpbiB0aGUgdm9pY2Ugc3RyZWFtICsgZnVsbCBjb2xsYXBzaWJsZSBjYXJkIGluIHRoZSByaWdodCBwYW5lLlxuXG5mdW5jdGlvbiByZXN1bHRDbGFtcFB4KGVsOiBIVE1MRWxlbWVudCk6IG51bWJlciB7XG4gIGNvbnN0IHJhdyA9IGdldENvbXB1dGVkU3R5bGUoZWwpLmdldFByb3BlcnR5VmFsdWUoXCItLXJlcy1jbGFtcC1tYXhcIikudHJpbSgpO1xuICBjb25zdCBuID0gTnVtYmVyLnBhcnNlRmxvYXQocmF3KTtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShuKSAmJiBuID4gMCA/IG4gOiA2NDtcbn1cblxuZnVuY3Rpb24gc3luY0V4cGFuZEFsbEJ1dHRvbigpIHtcbiAgY29uc3QgY2xhbXBlZCA9IFsuLi5yZXN1bHRzLnZhbHVlcygpXS5maWx0ZXIoKHIpID0+IHIuY2FyZC5jbGFzc0xpc3QuY29udGFpbnMoXCJjbGFtcGVkXCIpKTtcbiAgY29uc3QgYnRuID0gJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJ0b2dnbGUtYWxsLXJlc3VsdHNcIik7XG4gIGJ0bi5oaWRkZW4gPSBjbGFtcGVkLmxlbmd0aCA9PT0gMDtcbiAgaWYgKGNsYW1wZWQubGVuZ3RoID09PSAwKSByZXR1cm47XG4gIGNvbnN0IGFueUNvbGxhcHNlZCA9IGNsYW1wZWQuc29tZSgocikgPT4gIXIuY2FyZC5jbGFzc0xpc3QuY29udGFpbnMoXCJvcGVuXCIpKTtcbiAgYnRuLnRleHRDb250ZW50ID0gYW55Q29sbGFwc2VkID8gXCJFeHBhbmQgYWxsXCIgOiBcIkNvbGxhcHNlIGFsbFwiO1xufVxuXG5mdW5jdGlvbiBzZXRSZXN1bHRPcGVuKGVudHJ5OiBSZXN1bHRFbnRyeSwgb3BlbjogYm9vbGVhbikge1xuICBjb25zdCBjbGFtcGVkID0gZW50cnkuY2FyZC5jbGFzc0xpc3QuY29udGFpbnMoXCJjbGFtcGVkXCIpO1xuICBjb25zdCBuZXh0ID0gY2xhbXBlZCAmJiBvcGVuO1xuICBlbnRyeS5jYXJkLmNsYXNzTGlzdC50b2dnbGUoXCJvcGVuXCIsIG5leHQpO1xuICBlbnRyeS5oZWFkLnNldEF0dHJpYnV0ZShcImFyaWEtZXhwYW5kZWRcIiwgU3RyaW5nKCFjbGFtcGVkIHx8IG5leHQpKTtcbiAgZW50cnkubW9yZUJ0bi50ZXh0Q29udGVudCA9IG5leHQgPyBcIlNob3cgbGVzc1wiIDogXCJTaG93IG1vcmVcIjtcbiAgc3luY0V4cGFuZEFsbEJ1dHRvbigpO1xufVxuXG5mdW5jdGlvbiB1cGRhdGVSZXN1bHRDbGFtcGluZyhlbnRyeTogUmVzdWx0RW50cnkpIHtcbiAgaWYgKGVudHJ5LmJvZHkub2Zmc2V0UGFyZW50ID09PSBudWxsKSByZXR1cm47XG4gIC8vIFVuY2xhbXBlZCBjYXJkcyBoYXZlIG5vIG1heC1oZWlnaHQsIHNvIHNjcm9sbEhlaWdodCBpcyBhbHdheXMgdGhlIGZ1bGwgbmF0dXJhbCBoZWlnaHQuXG4gIGNvbnN0IG92ZXJmbG93cyA9IGVudHJ5LmJvZHkuc2Nyb2xsSGVpZ2h0ID4gcmVzdWx0Q2xhbXBQeChlbnRyeS5jYXJkKSArIDQ7XG4gIGVudHJ5LmNhcmQuY2xhc3NMaXN0LnRvZ2dsZShcImNsYW1wZWRcIiwgb3ZlcmZsb3dzKTtcbiAgaWYgKCFvdmVyZmxvd3MpIGVudHJ5LmNhcmQuY2xhc3NMaXN0LnJlbW92ZShcIm9wZW5cIik7XG4gIGVudHJ5Lm1vcmVCdG4uaGlkZGVuID0gIW92ZXJmbG93cztcbiAgY29uc3QgaXNPcGVuID0gZW50cnkuY2FyZC5jbGFzc0xpc3QuY29udGFpbnMoXCJvcGVuXCIpO1xuICBlbnRyeS5tb3JlQnRuLnRleHRDb250ZW50ID0gaXNPcGVuID8gXCJTaG93IGxlc3NcIiA6IFwiU2hvdyBtb3JlXCI7XG4gIGVudHJ5LmhlYWQuc2V0QXR0cmlidXRlKFwiYXJpYS1leHBhbmRlZFwiLCBTdHJpbmcoIW92ZXJmbG93cyB8fCBpc09wZW4pKTtcbn1cblxuZnVuY3Rpb24gdXBkYXRlQWxsUmVzdWx0Q2xhbXBpbmcoKSB7XG4gIGZvciAoY29uc3QgZW50cnkgb2YgcmVzdWx0cy52YWx1ZXMoKSkgdXBkYXRlUmVzdWx0Q2xhbXBpbmcoZW50cnkpO1xuICBzeW5jRXhwYW5kQWxsQnV0dG9uKCk7XG59XG5cbmZ1bmN0aW9uIHN5bmNSZXN1bHRGb2xsb3dVcEJ1dHRvbnMoKSB7XG4gIGZvciAoY29uc3QgZW50cnkgb2YgcmVzdWx0cy52YWx1ZXMoKSkge1xuICAgIGlmICghZW50cnkuZm9sbG93QnRuKSBjb250aW51ZTtcbiAgICBjb25zdCBjYW5Gb2xsb3cgPSBjYW5Gb2xsb3dVcFJlc3VsdChlbnRyeS5zZXNzaW9uSWQsIGFjdGl2ZVNlc3Npb24sIEJvb2xlYW4oZW50cnkudGFza0lkICYmIHRhc2tzLmhhcyhlbnRyeS50YXNrSWQpKSk7XG4gICAgZW50cnkuZm9sbG93QnRuLmhpZGRlbiA9ICFjYW5Gb2xsb3c7XG4gICAgaWYgKCFjYW5Gb2xsb3cpIGVudHJ5LmNhcmQucXVlcnlTZWxlY3RvcihcImZvcm1cIik/LnJlbW92ZSgpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGNsZWFyVW5yZWFkSWZSZXN1bHRzVmlzaWJsZSgpIHtcbiAgaWYgKHVucmVhZE1vYmlsZVJlc3VsdHMgPT09IDApIHJldHVybjtcbiAgY29uc3QgZHJhd2VyT3BlbiA9IGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LmNvbnRhaW5zKFwidGFza3Mtb3BlblwiKTtcbiAgaWYgKHNob3VsZENsZWFyVW5yZWFkUmVzdWx0cyhtb2JpbGVMYXlvdXQubWF0Y2hlcywgZHJhd2VyT3Blbiwgc2lkZUZpbHRlcikpIHtcbiAgICB1bnJlYWRNb2JpbGVSZXN1bHRzID0gMDtcbiAgICB1cGRhdGVUYXNrQ2hyb21lKCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gZm9jdXNSZXN1bHQoaWQ6IHN0cmluZykge1xuICBjb25zdCBlbnRyeSA9IHJlc3VsdHMuZ2V0KGlkKTtcbiAgaWYgKCFlbnRyeSkgcmV0dXJuO1xuICBpZiAoc2lkZUZpbHRlciA9PT0gXCJhY3RpdmVcIikgc2V0U2lkZUZpbHRlcihcImFsbFwiKTtcbiAgaWYgKG1vYmlsZUxheW91dC5tYXRjaGVzKSBzZXRUYXNrc09wZW4odHJ1ZSk7XG4gIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB7XG4gICAgdXBkYXRlUmVzdWx0Q2xhbXBpbmcoZW50cnkpO1xuICAgIGlmIChlbnRyeS5jYXJkLmNsYXNzTGlzdC5jb250YWlucyhcImNsYW1wZWRcIikpIHNldFJlc3VsdE9wZW4oZW50cnksIHRydWUpO1xuICAgIGZvciAoY29uc3QgciBvZiByZXN1bHRzLnZhbHVlcygpKSByLmNhcmQuY2xhc3NMaXN0LnJlbW92ZShcImZsYXNoXCIpO1xuICAgIHZvaWQgZW50cnkuY2FyZC5vZmZzZXRXaWR0aDtcbiAgICBlbnRyeS5jYXJkLmNsYXNzTGlzdC5hZGQoXCJmbGFzaFwiKTtcbiAgICBjbGVhclRpbWVvdXQoZmxhc2hUaW1lcik7XG4gICAgZmxhc2hUaW1lciA9IHdpbmRvdy5zZXRUaW1lb3V0KCgpID0+IGVudHJ5LmNhcmQuY2xhc3NMaXN0LnJlbW92ZShcImZsYXNoXCIpLCAxNDAwKTtcbiAgICBlbnRyeS5jYXJkLnNjcm9sbEludG9WaWV3KHsgYmVoYXZpb3I6IFwic21vb3RoXCIsIGJsb2NrOiBcIm5lYXJlc3RcIiB9KTtcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHJlc3VsdChhZ2VudDogc3RyaW5nLCBsYWJlbDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcsIGZhaWxlZCA9IGZhbHNlLCB0YXNrSWQ/OiBzdHJpbmcsIHNlc3Npb25JZCA9IGFjdGl2ZVNlc3Npb24pOiBzdHJpbmcge1xuICAkKFwiZW1wdHlcIikuaGlkZGVuID0gdHJ1ZTtcbiAgY29uc3QgaWQgPSBgcmVzLSR7KytuZXh0UmVzdWx0U2VxfWA7XG4gIGNvbnN0IHdobyA9IGFnZW50ID09PSBcInQzXCIgPyBcIlQzXCIgOiBcIkhlcm1lc1wiO1xuICBjb25zdCBhZ2VudENscyA9IGFnZW50ID09PSBcInQzXCIgPyBcInQzXCIgOiBcIlwiO1xuICBjb25zdCBzbmlwcGV0ID0gcGxhaW5QcmV2aWV3KHRleHQsIDE2MCkgfHwgXCIoZW1wdHkgcmVzcG9uc2UpXCI7XG5cbiAgLy8gMS4gQ29tcGFjdCBpbmxpbmUgaGFuZG9mZiBtYXJrZXIgaW4gdGhlIHZvaWNlIHRyYW5zY3JpcHQgc28gY2hyb25vbG9naWNhbCBjb250ZXh0IHN0YXlzIGludGFjdFxuICAvLyB3aXRob3V0IG11bHRpLXBhcmFncmFwaCByZXNwb25zZXMgcHVzaGluZyB2b2ljZSB0dXJucyBvZmYgc2NyZWVuLlxuICBjb25zdCByZWZSb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICByZWZSb3cudHlwZSA9IFwiYnV0dG9uXCI7XG4gIHJlZlJvdy5jbGFzc05hbWUgPSBgbGluZSBoYW5kb2ZmICR7YWdlbnRDbHN9ICR7ZmFpbGVkID8gXCJmYWlsZWRcIiA6IFwiXCJ9YC50cmltKCk7XG4gIHJlZlJvdy5kYXRhc2V0LnJlc3VsdElkID0gaWQ7XG4gIHJlZlJvdy5pbm5lckhUTUwgPVxuICAgIGA8c3BhbiBjbGFzcz1cImJhZGdlICR7YWdlbnRDbHN9XCI+JHt3aG99PC9zcGFuPmAgK1xuICAgIGA8c3BhbiBjbGFzcz1cImhhbmRvZmYtbGFiZWxcIj4ke2VzY2FwZUh0bWwobGFiZWwpfTwvc3Bhbj5gICtcbiAgICBgPHNwYW4gY2xhc3M9XCJoYW5kb2ZmLXNuaXBwZXRcIj4ke2VzY2FwZUh0bWwoc25pcHBldCl9PC9zcGFuPmAgK1xuICAgIGA8c3BhbiBjbGFzcz1cImhhbmRvZmYtY3VlXCI+JHtmYWlsZWQgPyBcIkZhaWxlZFwiIDogXCJPcGVuIFx1MjE5N1wifTwvc3Bhbj5gO1xuICByZWZSb3cub25jbGljayA9ICgpID0+IGZvY3VzUmVzdWx0KGlkKTtcbiAgJChcInRyYW5zY3JpcHRcIikuYXBwZW5kKHJlZlJvdyk7XG4gIG9wZW5MaW5lID0gbnVsbDtcbiAgc2Nyb2xsRG93bigpO1xuXG4gIC8vIDIuIFRydW5jYXRlZCwgZXhwYW5kYWJsZSByZXN1bHQgY2FyZCBpbiB0aGUgcmlnaHQtaGFuZCBBZ2VudCBXb3Jrc3BhY2UgKG5ld2VzdCBmaXJzdCkuXG4gIGNvbnN0IGNhcmQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYXJ0aWNsZVwiKTtcbiAgY2FyZC5jbGFzc05hbWUgPSBgcmVzLWNhcmQgJHthZ2VudENsc30gJHtmYWlsZWQgPyBcImZhaWxlZFwiIDogXCJcIn1gLnRyaW0oKTtcbiAgY2FyZC5kYXRhc2V0LnJlc3VsdElkID0gaWQ7XG5cbiAgY29uc3QgaGVhZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIGhlYWQudHlwZSA9IFwiYnV0dG9uXCI7XG4gIGhlYWQuY2xhc3NOYW1lID0gXCJyZXMtaGVhZFwiO1xuICBoZWFkLnNldEF0dHJpYnV0ZShcImFyaWEtZXhwYW5kZWRcIiwgXCJ0cnVlXCIpO1xuICBoZWFkLmlubmVySFRNTCA9XG4gICAgYDxzcGFuIGNsYXNzPVwiYmFkZ2UgJHthZ2VudENsc31cIj4ke3dob308L3NwYW4+YCArXG4gICAgYDxzcGFuIGNsYXNzPVwicmVzLWxhYmVsXCIgdGl0bGU9XCIke2VzY2FwZUh0bWwobGFiZWwpfVwiPiR7ZXNjYXBlSHRtbChsYWJlbCl9PC9zcGFuPmAgK1xuICAgIChmYWlsZWQgPyBgPHNwYW4gY2xhc3M9XCJyZXMtcGlsbFwiPkZhaWxlZDwvc3Bhbj5gIDogXCJcIikgK1xuICAgIGA8c3BhbiBjbGFzcz1cInJlcy10aW1lXCI+JHtmb3JtYXRTaG9ydFRpbWUobmV3IERhdGUoKSl9PC9zcGFuPmAgK1xuICAgIGA8c3BhbiBjbGFzcz1cInJlcy1jaGV2XCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+PC9zcGFuPmA7XG5cbiAgY29uc3QgYm9keSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGJvZHkuY2xhc3NOYW1lID0gXCJyZXMtYm9keVwiO1xuICBib2R5LmlubmVySFRNTCA9IG1hcmtkb3duKHRleHQpO1xuXG4gIGNvbnN0IGZvb3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBmb290LmNsYXNzTmFtZSA9IFwicmVzLWZvb3RcIjtcblxuICBjb25zdCBtb3JlQnRuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgbW9yZUJ0bi50eXBlID0gXCJidXR0b25cIjtcbiAgbW9yZUJ0bi5jbGFzc05hbWUgPSBcInJlcy1hY3QgcHJpbWFyeVwiO1xuICBtb3JlQnRuLnRleHRDb250ZW50ID0gXCJTaG93IG1vcmVcIjtcbiAgbW9yZUJ0bi5oaWRkZW4gPSB0cnVlO1xuXG4gIGNvbnN0IGNvcHlCdG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBjb3B5QnRuLnR5cGUgPSBcImJ1dHRvblwiO1xuICBjb3B5QnRuLmNsYXNzTmFtZSA9IFwicmVzLWFjdFwiO1xuICBjb3B5QnRuLnRleHRDb250ZW50ID0gXCJDb3B5XCI7XG4gIGNvcHlCdG4ub25jbGljayA9ICgpID0+IHtcbiAgICB2b2lkIG5hdmlnYXRvci5jbGlwYm9hcmQ/LndyaXRlVGV4dCh0ZXh0KTtcbiAgICB0b2FzdChcIlJlc3VsdCBjb3BpZWRcIik7XG4gIH07XG5cbiAgZm9vdC5hcHBlbmQobW9yZUJ0biwgY29weUJ0bik7XG5cbiAgbGV0IGZvbGxvd0J0bjogSFRNTEJ1dHRvbkVsZW1lbnQgfCB1bmRlZmluZWQ7XG4gIGlmICh0YXNrSWQpIHtcbiAgICBmb2xsb3dCdG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICAgIGZvbGxvd0J0bi50eXBlID0gXCJidXR0b25cIjtcbiAgICBmb2xsb3dCdG4uY2xhc3NOYW1lID0gXCJyZXMtYWN0XCI7XG4gICAgZm9sbG93QnRuLnRleHRDb250ZW50ID0gXCJGb2xsb3cgdXBcIjtcbiAgICBmb2xsb3dCdG4ub25jbGljayA9ICgpID0+IHtcbiAgICAgIGlmICghY2FuRm9sbG93VXBSZXN1bHQoc2Vzc2lvbklkLCBhY3RpdmVTZXNzaW9uLCB0YXNrcy5oYXModGFza0lkKSkpIHtcbiAgICAgICAgc3luY1Jlc3VsdEZvbGxvd1VwQnV0dG9ucygpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjb25zdCB2aWV3ID0gdGFza3MuZ2V0KHRhc2tJZCk7XG4gICAgICBpZiAodmlldykgZm9sbG93VXBGb3JtKGNhcmQsIHZpZXcuYywgc2Vzc2lvbklkKTtcbiAgICB9O1xuICAgIGZvb3QuYXBwZW5kKGZvbGxvd0J0bik7XG4gIH1cblxuICBjYXJkLmFwcGVuZChoZWFkLCBib2R5LCBmb290KTtcblxuICBjb25zdCBlbnRyeTogUmVzdWx0RW50cnkgPSB7IGlkLCBhZ2VudCwgbGFiZWwsIHRleHQsIGZhaWxlZCwgdGFza0lkLCBzZXNzaW9uSWQsIGNhcmQsIGhlYWQsIGJvZHksIG1vcmVCdG4sIGZvbGxvd0J0biwgcmVmUm93IH07XG4gIGNvbnN0IHRvZ2dsZSA9ICgpID0+IHtcbiAgICBpZiAoIWVudHJ5LmNhcmQuY2xhc3NMaXN0LmNvbnRhaW5zKFwiY2xhbXBlZFwiKSkgcmV0dXJuO1xuICAgIHNldFJlc3VsdE9wZW4oZW50cnksICFlbnRyeS5jYXJkLmNsYXNzTGlzdC5jb250YWlucyhcIm9wZW5cIikpO1xuICB9O1xuICBoZWFkLm9uY2xpY2sgPSB0b2dnbGU7XG4gIG1vcmVCdG4ub25jbGljayA9IHRvZ2dsZTtcblxuICByZXN1bHRzLnNldChpZCwgZW50cnkpO1xuICAkKFwicmVzdWx0c1wiKS5wcmVwZW5kKGNhcmQpO1xuICBjb25zdCBkcmF3ZXJPcGVuID0gZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QuY29udGFpbnMoXCJ0YXNrcy1vcGVuXCIpO1xuICBpZiAoIXNob3VsZENsZWFyVW5yZWFkUmVzdWx0cyhtb2JpbGVMYXlvdXQubWF0Y2hlcywgZHJhd2VyT3Blbiwgc2lkZUZpbHRlcikpIHVucmVhZE1vYmlsZVJlc3VsdHMrKztcblxuICBzeW5jU2lkZUxheW91dCgpO1xuICB1cGRhdGVUYXNrQ2hyb21lKCk7XG4gIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB7XG4gICAgdXBkYXRlUmVzdWx0Q2xhbXBpbmcoZW50cnkpO1xuICAgIHN5bmNFeHBhbmRBbGxCdXR0b24oKTtcbiAgfSk7XG4gIHJldHVybiBpZDtcbn1cblxuZnVuY3Rpb24gZWxhcHNlZChzZWNvbmRzOiBudW1iZXIpOiBzdHJpbmcge1xuICBpZiAoc2Vjb25kcyA8IDYwKSByZXR1cm4gYCR7TWF0aC5mbG9vcihzZWNvbmRzKX1zYDtcbiAgY29uc3QgbSA9IE1hdGguZmxvb3Ioc2Vjb25kcyAvIDYwKTtcbiAgcmV0dXJuIG0gPCA2MCA/IGAke219bSAke01hdGguZmxvb3Ioc2Vjb25kcyAlIDYwKX1zYCA6IGAke01hdGguZmxvb3IobSAvIDYwKX1oICR7bSAlIDYwfW1gO1xufVxuXG4vKiogVGhlIGVtcHR5IHRhc2sgbGlzdCdzIHdvcmRzLCBrZXB0IHRvIHB1dCBiYWNrLiAqL1xuY29uc3Qgbm9UYXNrcyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwibm90YXNrc1wiKSE7XG5cbi8qKiBXaGV0aGVyIGEgdGFzayBzdGlsbCB3YW50cyB0aGUgc2NyZWVuOiBpdCdzIHdvcmtpbmcsIHdhaXRpbmcsIG9yIG5lZWRzIGFwcHJvdmFsLiBUaGUgcmVzdCBmb2xkIGF3YXkgdW5kZXIgRmluaXNoZWQuICovXG5jb25zdCBsaXZlID0gKHN0YXRlOiBzdHJpbmcpID0+IHN0YXRlID09PSBcInJ1bm5pbmdcIiB8fCBzdGF0ZS5zdGFydHNXaXRoKFwid2FpdGluZ1wiKTtcbmNvbnN0IGlzQWN0aXZlVGFzayA9ICh2aWV3OiBUYXNrVmlldykgPT4gbGl2ZSh2aWV3LmMuc3RhdGUpIHx8IEJvb2xlYW4odmlldy5hcHByb3ZhbCk7XG5cbmZ1bmN0aW9uIHNldFNpZGVGaWx0ZXIoZmlsdGVyOiBTaWRlRmlsdGVyKSB7XG4gIHNpZGVGaWx0ZXIgPSBub3JtYWxpemVTaWRlRmlsdGVyKGZpbHRlcik7XG4gIGZvciAoY29uc3QgYnRuIG9mIEFycmF5LmZyb20oZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MQnV0dG9uRWxlbWVudD4oXCIjc2lkZS10YWJzIGJ1dHRvblwiKSkpIHtcbiAgICBjb25zdCBvbiA9IGJ0bi5kYXRhc2V0LmZpbHRlciA9PT0gc2lkZUZpbHRlcjtcbiAgICBidG4uY2xhc3NMaXN0LnRvZ2dsZShcIm9uXCIsIG9uKTtcbiAgICBidG4uc2V0QXR0cmlidXRlKFwiYXJpYS1wcmVzc2VkXCIsIFN0cmluZyhvbikpO1xuICB9XG4gIHN5bmNTaWRlTGF5b3V0KCk7XG4gIGNsZWFyVW5yZWFkSWZSZXN1bHRzVmlzaWJsZSgpO1xuICByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKCkgPT4gdXBkYXRlQWxsUmVzdWx0Q2xhbXBpbmcoKSk7XG59XG5cbmZ1bmN0aW9uIHN5bmNTaWRlTGF5b3V0KCkge1xuICBjb25zdCBhbGwgPSBbLi4udGFza3MudmFsdWVzKCldO1xuICBjb25zdCBhY3RpdmVDdXJyZW50ID0gYWxsLmZpbHRlcihpc0FjdGl2ZVRhc2spLmxlbmd0aDtcbiAgY29uc3QgYWN0aXZlVG90YWwgPSBhY3RpdmVDdXJyZW50ICsgZWFybGllckFjdGl2ZUNvdW50O1xuICBjb25zdCByZXN1bHRzVG90YWwgPSByZXN1bHRzLnNpemU7XG4gIGNvbnN0IGVhcmxpZXJTaG93biA9ICQoXCJlYXJsaWVyXCIpLmNoaWxkRWxlbWVudENvdW50O1xuICBjb25zdCBkb25lVG90YWwgPSAkKFwiZG9uZW5vd1wiKS5jaGlsZEVsZW1lbnRDb3VudCArICQoXCJkb25lZWFybGllclwiKS5jaGlsZEVsZW1lbnRDb3VudDtcblxuICBjb25zdCB2aXMgPSByZXNvbHZlU2lkZVNlY3Rpb25zKHNpZGVGaWx0ZXIsIHtcbiAgICBhY3RpdmU6IGFjdGl2ZUN1cnJlbnQsXG4gICAgcmVzdWx0czogcmVzdWx0c1RvdGFsLFxuICAgIGVhcmxpZXI6IGVhcmxpZXJTaG93bixcbiAgICBkb25lOiBkb25lVG90YWwsXG4gIH0pO1xuXG4gICQoXCJ0YXNrcy1zZWN0aW9uXCIpLmhpZGRlbiA9ICF2aXMuc2hvd1Rhc2tzU2VjdGlvbjtcbiAgbm9UYXNrcy5oaWRkZW4gPSAhdmlzLnNob3dFbXB0eVRhc2tzO1xuICAkKFwicmVzdWx0cy1zZWN0aW9uXCIpLmhpZGRlbiA9ICF2aXMuc2hvd1Jlc3VsdHNTZWN0aW9uO1xuICAkKFwibm9yZXN1bHRzXCIpLmhpZGRlbiA9ICF2aXMuc2hvd0VtcHR5UmVzdWx0cztcbiAgJChcImVhcmxpZXJib3hcIikuaGlkZGVuID0gIXZpcy5zaG93RWFybGllclNlY3Rpb247XG4gICQoXCJkb25lYm94XCIpLmhpZGRlbiA9ICF2aXMuc2hvd0RvbmVTZWN0aW9uO1xuXG4gICQoXCJzaWRlLWFjdGl2ZS1uXCIpLnRleHRDb250ZW50ID0gYWN0aXZlVG90YWwgPiAwID8gU3RyaW5nKGFjdGl2ZVRvdGFsKSA6IFwiXCI7XG4gICQoXCJzaWRlLXJlc3VsdHMtblwiKS50ZXh0Q29udGVudCA9IHJlc3VsdHNUb3RhbCA+IDAgPyBTdHJpbmcocmVzdWx0c1RvdGFsKSA6IFwiXCI7XG4gICQoXCJyZXN1bHRzY291bnRcIikudGV4dENvbnRlbnQgPSByZXN1bHRzVG90YWwgPiAwID8gYFx1MDBCNyAke3Jlc3VsdHNUb3RhbH1gIDogXCJcIjtcbiAgJChcImRvbmVjb3VudFwiKS50ZXh0Q29udGVudCA9IGRvbmVUb3RhbCA+IDAgPyBgXHUwMEI3ICR7ZG9uZVRvdGFsfWAgOiBcIlwiO1xuICBzeW5jUmVzdWx0Rm9sbG93VXBCdXR0b25zKCk7XG59XG5cbmZ1bmN0aW9uIHVwZGF0ZVRhc2tDaHJvbWUoKSB7XG4gIGNvbnN0IGFsbCA9IFsuLi50YXNrcy52YWx1ZXMoKV07XG4gIGNvbnN0IGFjdGl2ZUN1cnJlbnQgPSBhbGwuZmlsdGVyKGlzQWN0aXZlVGFzaykubGVuZ3RoO1xuICBjb25zdCB3YWl0aW5nID0gYWxsLmZpbHRlcigodCkgPT4gdC5jLnN0YXRlLnN0YXJ0c1dpdGgoXCJ3YWl0aW5nXCIpIHx8IEJvb2xlYW4odC5hcHByb3ZhbCkpLmxlbmd0aDtcbiAgY29uc3QgYWN0aXZlVG90YWwgPSBhY3RpdmVDdXJyZW50ICsgZWFybGllckFjdGl2ZUNvdW50O1xuICBjb25zdCBhdHRlbnRpb25Ub3RhbCA9IHdhaXRpbmcgKyBlYXJsaWVyV2FpdGluZ0NvdW50O1xuICBjb25zdCBiYWRnZUNvdW50ID0gYWN0aXZlVG90YWwgPiAwID8gYWN0aXZlVG90YWwgOiB1bnJlYWRNb2JpbGVSZXN1bHRzO1xuXG4gIGNvbnN0IGJhZGdlID0gJChcInRhc2tzLWJhZGdlXCIpO1xuICBiYWRnZS5oaWRkZW4gPSBiYWRnZUNvdW50ID09PSAwO1xuICBiYWRnZS50ZXh0Q29udGVudCA9IFN0cmluZyhiYWRnZUNvdW50KTtcbiAgYmFkZ2UuY2xhc3NMaXN0LnRvZ2dsZShcIndhcm5cIiwgYXR0ZW50aW9uVG90YWwgPiAwKTtcblxuICBjb25zdCBiYXIgPSAkKFwibW9iaWxlLXRhc2tzLWJhclwiKTtcbiAgY29uc3Qgc2hvd0JhciA9IGFjdGl2ZVRvdGFsID4gMCB8fCB1bnJlYWRNb2JpbGVSZXN1bHRzID4gMDtcbiAgYmFyLmhpZGRlbiA9ICFzaG93QmFyO1xuICBiYXIuY2xhc3NMaXN0LnRvZ2dsZShcInZpc2libGVcIiwgc2hvd0Jhcik7XG4gIGJhci5jbGFzc0xpc3QudG9nZ2xlKFwid2FyblwiLCBhdHRlbnRpb25Ub3RhbCA+IDApO1xuICBpZiAoc2hvd0Jhcikge1xuICAgIGNvbnN0IGFwcHJvdmFsID0gYWxsLmZpbmQoKHQpID0+IHQuYXBwcm92YWwpO1xuICAgIGNvbnN0IGxhYmVsID0gYXBwcm92YWxcbiAgICAgID8gYEFwcHJvdmFsIG5lZWRlZDogJHthcHByb3ZhbC5jLmxhYmVsfWBcbiAgICAgIDogYXR0ZW50aW9uVG90YWwgPiAwXG4gICAgICAgID8gYCR7YXR0ZW50aW9uVG90YWx9IHRhc2ske2F0dGVudGlvblRvdGFsID4gMSA/IFwic1wiIDogXCJcIn0gd2FpdGluZyBmb3IgeW91YFxuICAgICAgICA6IGFjdGl2ZVRvdGFsID4gMFxuICAgICAgICAgID8gYCR7YWN0aXZlVG90YWx9IGFjdGl2ZSB0YXNrJHthY3RpdmVUb3RhbCA+IDEgPyBcInNcIiA6IFwiXCJ9YFxuICAgICAgICAgIDogYCR7dW5yZWFkTW9iaWxlUmVzdWx0c30gbmV3IGFnZW50IHJlc3VsdCR7dW5yZWFkTW9iaWxlUmVzdWx0cyA+IDEgPyBcInNcIiA6IFwiXCJ9YDtcbiAgICAkKFwibXRiLXRleHRcIikudGV4dENvbnRlbnQgPSBsYWJlbDtcbiAgfVxufVxuXG5mdW5jdGlvbiBzaG93VGFza3MoZm9yY2UgPSBmYWxzZSkge1xuICBjb25zdCBwYW5lID0gJChcInRhc2tzXCIpO1xuICBjb25zdCBkb25lID0gJChcImRvbmVub3dcIik7XG4gIGNvbnN0IG9wZW4gPSBkb2N1bWVudC5hY3RpdmVFbGVtZW50Py5jbG9zZXN0Py4oXCIudGFza1wiKSBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gIGlmICghZm9yY2UgJiYgb3BlbiAmJiAocGFuZS5jb250YWlucyhvcGVuKSB8fCBkb25lLmNvbnRhaW5zKG9wZW4pKSAmJiBvcGVuLnF1ZXJ5U2VsZWN0b3IoXCJmb3JtXCIpKSByZXR1cm47IC8vIGRvbid0IHJlZHJhdyB1bmRlciBzb21lb25lIHR5cGluZyBhIGZvbGxvdy11cFxuICBwYW5lLmlubmVySFRNTCA9IFwiXCI7XG4gIGRvbmUuaW5uZXJIVE1MID0gXCJcIjtcbiAgY29uc3QgYWxsID0gWy4uLnRhc2tzLnZhbHVlcygpXS5yZXZlcnNlKCk7XG4gIGlmIChhbGwubGVuZ3RoID09PSAwKSB7XG4gICAgcGFuZS5hcHBlbmQobm9UYXNrcyk7XG4gICAgJChcInRhc2tjb3VudFwiKS50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgJChcImNhbmNlbGFsbFwiKS5oaWRkZW4gPSB0cnVlO1xuICAgIHN5bmNTaWRlTGF5b3V0KCk7XG4gICAgdXBkYXRlVGFza0Nocm9tZSgpO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBydW5uaW5nID0gYWxsLmZpbHRlcigodCkgPT4gdC5jLnN0YXRlID09PSBcInJ1bm5pbmdcIikubGVuZ3RoO1xuICBjb25zdCBhY3RpdmVDb3VudCA9IGFsbC5maWx0ZXIoaXNBY3RpdmVUYXNrKS5sZW5ndGg7XG4gICQoXCJ0YXNrY291bnRcIikudGV4dENvbnRlbnQgPSBydW5uaW5nID4gMCA/IGAke3J1bm5pbmd9IHJ1bm5pbmdgIDogYWN0aXZlQ291bnQgPiAwID8gYCR7YWN0aXZlQ291bnR9IHdhaXRpbmdgIDogXCJcIjtcbiAgJChcImNhbmNlbGFsbFwiKS5oaWRkZW4gPSAhY2FsbElkIHx8IHJ1bm5pbmcgPCAyO1xuICBmb3IgKGNvbnN0IHZpZXcgb2YgYWxsKSB7XG4gICAgY29uc3QgdCA9IHZpZXcuYztcbiAgICBjb25zdCB3YWl0aW5nID0gdC5zdGF0ZS5zdGFydHNXaXRoKFwid2FpdGluZ1wiKTtcbiAgICBjb25zdCBjYXJkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBjYXJkLmNsYXNzTmFtZSA9IGB0YXNrICR7d2FpdGluZyA/IFwid2FpdGluZ1wiIDogdC5zdGF0ZX1gO1xuICAgIGNvbnN0IGFnZSA9ICh2aWV3LmVuZGVkID8/IG5vdygpKSAtIHZpZXcuc2luY2U7XG4gICAgY2FyZC5pbm5lckhUTUwgPVxuICAgICAgYDxkaXYgY2xhc3M9XCJtZXRhLXJvd1wiPmAgK1xuICAgICAgICBgPHNwYW4gY2xhc3M9XCJiYWRnZSAke3QuYWdlbnQgPT09IFwidDNcIiA/IFwidDNcIiA6IFwiXCJ9XCI+JHt0LmFnZW50ID09PSBcInQzXCIgPyBcIlQzXCIgOiBcIkhlcm1lc1wifTwvc3Bhbj5gICtcbiAgICAgICAgYDxzcGFuIGNsYXNzPVwibGFiZWxcIj48L3NwYW4+YCArXG4gICAgICAgIGA8c3BhbiBjbGFzcz1cInN0YXRlXCI+JHt0LnN0YXRlID09PSBcInJ1bm5pbmdcIiA/ICc8c3BhbiBjbGFzcz1cInNwaW5cIj48L3NwYW4+JyA6IFwiXCJ9JHtlc2NhcGVIdG1sKHQuc3RhdGUpfTwvc3Bhbj5gICtcbiAgICAgICAgYDxzcGFuIGNsYXNzPVwiYWdlXCI+JHtlbGFwc2VkKGFnZSl9PC9zcGFuPmAgK1xuICAgICAgYDwvZGl2PmAgK1xuICAgICAgYDxkaXYgY2xhc3M9XCJwXCI+PC9kaXY+YDtcbiAgICBjb25zdCBsYWJlbEVsID0gY2FyZC5xdWVyeVNlbGVjdG9yKFwiLmxhYmVsXCIpIGFzIEhUTUxFbGVtZW50O1xuICAgIGxhYmVsRWwudGV4dENvbnRlbnQgPSB0LmxhYmVsO1xuICAgIGxhYmVsRWwudGl0bGUgPSB0LmxhYmVsO1xuICAgIGNhcmQucXVlcnlTZWxlY3RvcihcIi5wXCIpIS50ZXh0Q29udGVudCA9IHQucHJvZ3Jlc3MgPz8gdC5yZXF1ZXN0O1xuICAgIGlmICh0LnF1ZXN0aW9uKSB7XG4gICAgICBjb25zdCBxID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgIHEuY2xhc3NOYW1lID0gXCJxXCI7XG4gICAgICBxLnRleHRDb250ZW50ID0gYEFza3M6ICR7dC5xdWVzdGlvbn1gO1xuICAgICAgY2FyZC5hcHBlbmQocSk7XG4gICAgfVxuICAgIGlmICh2aWV3LmFwcHJvdmFsICYmIHQuc3RhdGUgPT09IFwicnVubmluZ1wiKSB7XG4gICAgICBjb25zdCBib3ggPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgICAgYm94LmNsYXNzTmFtZSA9IFwiYXBwcm92YWxcIjtcbiAgICAgIGJveC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz1cImFwcHJvdmFsLWhlYWRcIj5IZXJtZXMgYXNrcyB0byBydW48L2Rpdj48Y29kZT48L2NvZGU+PGRpdiBjbGFzcz1cImFjdHNcIj48L2Rpdj5gO1xuICAgICAgYm94LnF1ZXJ5U2VsZWN0b3IoXCJjb2RlXCIpIS50ZXh0Q29udGVudCA9IHZpZXcuYXBwcm92YWwuY29tbWFuZDtcbiAgICAgIGNvbnN0IGFuc3dlciA9IChjaG9pY2U6IFwib25jZVwiIHwgXCJkZW55XCIpID0+IHtcbiAgICAgICAgdmlldy5hcHByb3ZhbCA9IHVuZGVmaW5lZDtcbiAgICAgICAgc2hvd1Rhc2tzKHRydWUpO1xuICAgICAgICB2b2lkIGZldGNoKFwiL2hlcm1lcy9hcHByb3ZhbFwiLCB7IG1ldGhvZDogXCJQT1NUXCIsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgY2FsbDogY2FsbE5hbWUsIHRhc2tJZDogdC5pZCwgY2hvaWNlIH0pIH0pXG4gICAgICAgICAgLnRoZW4oKHIpID0+IHRvYXN0KHIub2sgPyAoY2hvaWNlID09PSBcIm9uY2VcIiA/IFwiQXBwcm92ZWRcIiA6IFwiRGVuaWVkXCIpIDogXCJUaGF0IGFwcHJvdmFsIGhhZCBhbHJlYWR5IGxhcHNlZFwiKSk7XG4gICAgICB9O1xuICAgICAgZm9yIChjb25zdCBbbGFiZWwsIGNob2ljZV0gb2YgW1tcIkFwcHJvdmUgb25jZVwiLCBcIm9uY2VcIl0sIFtcIkRlbnlcIiwgXCJkZW55XCJdXSBhcyBjb25zdCkge1xuICAgICAgICBjb25zdCBiID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgICAgICAgYi50eXBlID0gXCJidXR0b25cIjtcbiAgICAgICAgYi50ZXh0Q29udGVudCA9IGxhYmVsO1xuICAgICAgICBpZiAoY2hvaWNlID09PSBcIm9uY2VcIikgYi5jbGFzc05hbWUgPSBcImdvXCI7XG4gICAgICAgIGVsc2UgYi5jbGFzc05hbWUgPSBcImRhbmdlclwiO1xuICAgICAgICBiLm9uY2xpY2sgPSAoKSA9PiBhbnN3ZXIoY2hvaWNlKTtcbiAgICAgICAgYm94LnF1ZXJ5U2VsZWN0b3IoXCIuYWN0c1wiKSEuYXBwZW5kKGIpO1xuICAgICAgfVxuICAgICAgY2FyZC5hcHBlbmQoYm94KTtcbiAgICB9XG4gICAgaWYgKHQuc3RhdGUgIT09IFwicnVubmluZ1wiKSB2aWV3LmFwcHJvdmFsID0gdW5kZWZpbmVkO1xuICAgIGNvbnN0IGFjdHMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGFjdHMuY2xhc3NOYW1lID0gXCJhY3RzXCI7XG4gICAgY29uc3QgYnV0dG9uID0gKHRleHQ6IHN0cmluZywgZm46ICgpID0+IHZvaWQsIGNscyA9IFwiXCIpID0+IHtcbiAgICAgIGNvbnN0IGIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICAgICAgYi50eXBlID0gXCJidXR0b25cIjtcbiAgICAgIGIudGV4dENvbnRlbnQgPSB0ZXh0O1xuICAgICAgaWYgKGNscykgYi5jbGFzc05hbWUgPSBjbHM7XG4gICAgICBiLm9uY2xpY2sgPSBmbjtcbiAgICAgIGFjdHMuYXBwZW5kKGIpO1xuICAgICAgcmV0dXJuIGI7XG4gICAgfTtcbiAgICBpZiAoY2FsbElkICYmIGFjdGl2ZVNlc3Npb24gPiAwKSB7XG4gICAgICBjb25zdCBvcmlnaW5TZXNzaW9uID0gYWN0aXZlU2Vzc2lvbjtcbiAgICAgIGJ1dHRvbih3YWl0aW5nID8gXCJBbnN3ZXJcIiA6IFwiRm9sbG93IHVwXCIsICgpID0+IGZvbGxvd1VwRm9ybShjYXJkLCB0LCBvcmlnaW5TZXNzaW9uKSk7XG4gICAgICBpZiAodC5zdGF0ZSA9PT0gXCJydW5uaW5nXCIpIGJ1dHRvbihcIkNhbmNlbFwiLCAoKSA9PiBwdXNoKHsgdHlwZTogXCJjYW5jZWxUYXNrXCIsIHRhc2s6IHQuaWQgfSksIFwiZGFuZ2VyXCIpO1xuICAgIH1cbiAgICBpZiAodmlldy5yZXN1bHRJZCkgYnV0dG9uKFwiUmVzdWx0XCIsICgpID0+IGZvY3VzUmVzdWx0KHZpZXcucmVzdWx0SWQhKSk7XG4gICAgaWYgKHZpZXcudGhyZWFkKSBidXR0b24oXCJDb3B5IGlkXCIsICgpID0+IHsgdm9pZCBuYXZpZ2F0b3IuY2xpcGJvYXJkPy53cml0ZVRleHQodmlldy50aHJlYWQhKTsgdG9hc3QoXCJUaHJlYWQgaWQgY29waWVkXCIpOyB9KTtcbiAgICBpZiAoYWN0cy5jaGlsZEVsZW1lbnRDb3VudCkgY2FyZC5hcHBlbmQoYWN0cyk7XG4gICAgKGlzQWN0aXZlVGFzayh2aWV3KSA/IHBhbmUgOiBkb25lKS5hcHBlbmQoY2FyZCk7XG4gIH1cbiAgaWYgKHBhbmUuY2hpbGRFbGVtZW50Q291bnQgPT09IDApIHBhbmUuYXBwZW5kKG5vVGFza3MpO1xuICBzeW5jU2lkZUxheW91dCgpO1xuICB1cGRhdGVUYXNrQ2hyb21lKCk7XG59XG5cbmZ1bmN0aW9uIGZvbGxvd1VwRm9ybShjYXJkOiBIVE1MRWxlbWVudCwgdDogQ29tbWFuZCwgb3JpZ2luU2Vzc2lvbjogbnVtYmVyKSB7XG4gIGNvbnN0IGV4aXN0aW5nID0gY2FyZC5xdWVyeVNlbGVjdG9yKFwiZm9ybVwiKTtcbiAgaWYgKGV4aXN0aW5nKSB7IGV4aXN0aW5nLnF1ZXJ5U2VsZWN0b3IoXCJpbnB1dFwiKT8uZm9jdXMoKTsgcmV0dXJuOyB9XG4gIGNvbnN0IGZvcm0gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZm9ybVwiKTtcbiAgZm9ybS5jbGFzc05hbWUgPSBcImZvbGxvd3VwLWZvcm1cIjtcbiAgZm9ybS5pbm5lckhUTUwgPSBgPGlucHV0IHR5cGU9XCJ0ZXh0XCIgcGxhY2Vob2xkZXI9XCJUZWxsIFx1MjAxQyR7ZXNjYXBlSHRtbCh0LmxhYmVsKX1cdTIwMURcdTIwMjZcIiBlbnRlcmtleWhpbnQ9XCJzZW5kXCI+PGJ1dHRvbiB0eXBlPVwic3VibWl0XCI+U2VuZDwvYnV0dG9uPmA7XG4gIGNvbnN0IGlucHV0ID0gZm9ybS5xdWVyeVNlbGVjdG9yKFwiaW5wdXRcIikhO1xuICBmb3JtLm9uc3VibWl0ID0gKGUpID0+IHtcbiAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgY29uc3QgdGV4dCA9IGlucHV0LnZhbHVlLnRyaW0oKTtcbiAgICBpZiAodGV4dCkge1xuICAgICAgaWYgKCFjYW5Gb2xsb3dVcFJlc3VsdChvcmlnaW5TZXNzaW9uLCBhY3RpdmVTZXNzaW9uLCB0YXNrcy5oYXModC5pZCkpKSB7XG4gICAgICAgIHRvYXN0KFwiVGhhdCB0YXNrJ3MgY2FsbCBoYXMgZW5kZWRcIik7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBwdXNoKHsgdHlwZTogXCJzdGVlclwiLCB0YXNrOiB0LmlkLCB0ZXh0IH0pO1xuICAgICAgICBub3RlKGBZb3UgXHUyMTkyICR7dC5sYWJlbH06ICR7dGV4dH1gKTtcbiAgICAgICAgc2Nyb2xsRG93bih0cnVlKTtcbiAgICAgIH1cbiAgICB9XG4gICAgaW5wdXQuYmx1cigpO1xuICAgIGZvcm0ucmVtb3ZlKCk7XG4gICAgc2hvd1Rhc2tzKCk7XG4gIH07XG4gIGlucHV0Lm9ua2V5ZG93biA9IChlKSA9PiB7IGlmIChlLmtleSA9PT0gXCJFc2NhcGVcIikgeyBlLnN0b3BQcm9wYWdhdGlvbigpOyBpbnB1dC5ibHVyKCk7IGZvcm0ucmVtb3ZlKCk7IHNob3dUYXNrcygpOyB9IH07XG4gIGNhcmQuYXBwZW5kKGZvcm0pO1xuICBpbnB1dC5mb2N1cygpO1xufVxuXG4vKiogVDMgdGhyZWFkcyBlYXJsaWVyIGNhbGxzIHN0YXJ0ZWQ6IHRoZXkgY2Fycnkgb24gYWZ0ZXIgYSBjYWxsLCBzbyB0aGUgcGFuZWwgc2F5cyBob3cgdGhleSdyZSBkb2luZy4gKi9cbmFzeW5jIGZ1bmN0aW9uIHNob3dFYXJsaWVyKCkge1xuICBsZXQgbGlzdDogeyB0aHJlYWQ6IHN0cmluZzsgdGl0bGU6IHN0cmluZzsgc3RhdHVzOiBzdHJpbmc7IGJyYW5jaDogc3RyaW5nIHwgbnVsbDsgcHI6IHN0cmluZyB8IG51bGw7IHVwZGF0ZWQ6IHN0cmluZzsgbGFzdDogc3RyaW5nOyB3YWl0aW5nOiBib29sZWFuIH1bXSA9IFtdO1xuICB0cnkgeyBsaXN0ID0gYXdhaXQgKGF3YWl0IGZldGNoKFwiL2FnZW50L3JlY2VudFwiLCB7IGNhY2hlOiBcIm5vLXN0b3JlXCIgfSkpLmpzb24oKTsgfSBjYXRjaCB7fVxuICBjb25zdCBjdXJyZW50ID0gbmV3IFNldChbLi4udGFza3MudmFsdWVzKCldLm1hcCgodikgPT4gdi50aHJlYWQpLmZpbHRlcihCb29sZWFuKSk7XG4gIGxpc3QgPSBsaXN0LmZpbHRlcigodCkgPT4gIWN1cnJlbnQuaGFzKHQudGhyZWFkKSk7XG4gIGNvbnN0IHBhbmUgPSAkKFwiZWFybGllclwiKTtcbiAgY29uc3QgZG9uZSA9ICQoXCJkb25lZWFybGllclwiKTtcbiAgcGFuZS5pbm5lckhUTUwgPSBcIlwiO1xuICBkb25lLmlubmVySFRNTCA9IFwiXCI7XG4gIGVhcmxpZXJBY3RpdmVDb3VudCA9IDA7XG4gIGVhcmxpZXJXYWl0aW5nQ291bnQgPSAwO1xuICBmb3IgKGNvbnN0IHQgb2YgbGlzdCkge1xuICAgIGNvbnN0IGNhcmQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGNvbnN0IHN0YXRlID0gdC53YWl0aW5nID8gXCJ3YWl0aW5nIGZvciBhcHByb3ZhbCBpbiBUM1wiIDogdC5zdGF0dXM7XG4gICAgY2FyZC5jbGFzc05hbWUgPSBgdGFzayAke3Quc3RhdHVzID09PSBcInJ1bm5pbmdcIiA/IFwicnVubmluZ1wiIDogdC53YWl0aW5nID8gXCJ3YWl0aW5nXCIgOiBcImZpbmlzaGVkXCJ9YDtcbiAgICBjb25zdCBhZ28gPSBNYXRoLm1heCgwLCAoRGF0ZS5ub3coKSAtIERhdGUucGFyc2UodC51cGRhdGVkKSkgLyAxMDAwKTtcbiAgICBjYXJkLmlubmVySFRNTCA9XG4gICAgICBgPGRpdiBjbGFzcz1cIm1ldGEtcm93XCI+YCArXG4gICAgICAgIGA8c3BhbiBjbGFzcz1cImJhZGdlIHQzXCI+VDM8L3NwYW4+YCArXG4gICAgICAgIGA8c3BhbiBjbGFzcz1cImxhYmVsXCI+PC9zcGFuPmAgK1xuICAgICAgICBgPHNwYW4gY2xhc3M9XCJzdGF0ZVwiPiR7dC5zdGF0dXMgPT09IFwicnVubmluZ1wiID8gJzxzcGFuIGNsYXNzPVwic3BpblwiPjwvc3Bhbj4nIDogXCJcIn0ke2VzY2FwZUh0bWwoc3RhdGUpfTwvc3Bhbj5gICtcbiAgICAgICAgYDxzcGFuIGNsYXNzPVwiYWdlXCI+JHtlbGFwc2VkKGFnbyl9IGFnbzwvc3Bhbj5gICtcbiAgICAgIGA8L2Rpdj5gICtcbiAgICAgIGA8ZGl2IGNsYXNzPVwicFwiPjwvZGl2PmA7XG4gICAgY29uc3QgbGFiZWxFbCA9IGNhcmQucXVlcnlTZWxlY3RvcihcIi5sYWJlbFwiKSBhcyBIVE1MRWxlbWVudDtcbiAgICBsYWJlbEVsLnRleHRDb250ZW50ID0gdC50aXRsZTtcbiAgICBsYWJlbEVsLnRpdGxlID0gdC50aXRsZTtcbiAgICBjYXJkLnF1ZXJ5U2VsZWN0b3IoXCIucFwiKSEudGV4dENvbnRlbnQgPSB0Lmxhc3QgfHwgKHQuYnJhbmNoID8gYE9uICR7dC5icmFuY2h9YCA6IFwiXCIpO1xuICAgIGNvbnN0IGFjdHMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGFjdHMuY2xhc3NOYW1lID0gXCJhY3RzXCI7XG4gICAgaWYgKHQucHIpIHsgY29uc3QgYSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJhXCIpOyBhLmhyZWYgPSB0LnByOyBhLnRhcmdldCA9IFwiX2JsYW5rXCI7IGEucmVsID0gXCJub29wZW5lclwiOyBhLnRleHRDb250ZW50ID0gXCJQUiBcdTIxOTdcIjsgYWN0cy5hcHBlbmQoYSk7IH1cbiAgICBjb25zdCBjb3B5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgICBjb3B5LnR5cGUgPSBcImJ1dHRvblwiO1xuICAgIGNvcHkudGV4dENvbnRlbnQgPSBcIkNvcHkgaWRcIjtcbiAgICBjb3B5Lm9uY2xpY2sgPSAoKSA9PiB7IHZvaWQgbmF2aWdhdG9yLmNsaXBib2FyZD8ud3JpdGVUZXh0KHQudGhyZWFkKTsgdG9hc3QoXCJUaHJlYWQgaWQgY29waWVkXCIpOyB9O1xuICAgIGFjdHMuYXBwZW5kKGNvcHkpO1xuICAgIGNhcmQuYXBwZW5kKGFjdHMpO1xuICAgIGNvbnN0IGFjdGl2ZSA9IHQuc3RhdHVzID09PSBcInJ1bm5pbmdcIiB8fCB0LndhaXRpbmc7XG4gICAgaWYgKGFjdGl2ZSkgZWFybGllckFjdGl2ZUNvdW50Kys7XG4gICAgaWYgKHQud2FpdGluZykgZWFybGllcldhaXRpbmdDb3VudCsrO1xuICAgIChhY3RpdmUgPyBwYW5lIDogZG9uZSkuYXBwZW5kKGNhcmQpO1xuICB9XG4gIHN5bmNTaWRlTGF5b3V0KCk7XG4gIHVwZGF0ZVRhc2tDaHJvbWUoKTtcbn1cblxuY29uc3QgU1RBVFVTX1RFWFQ6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gIGlkbGU6IFwiSWRsZVwiLCBjb25uZWN0aW5nOiBcIkNvbm5lY3RpbmdcdTIwMjZcIiwgbGlzdGVuaW5nOiBcIkxpc3RlbmluZ1wiLCB3b3JraW5nOiBcIkxpc3RlbmluZyBcdTAwQjcgdGFza3MgcnVubmluZ1wiLFxuICBkb3JtYW50OiBcIkRvcm1hbnQgXHUwMEI3IHdhaXRpbmcgZm9yIHdha2Ugd29yZFwiLFxuICBzdGFuZGJ5OiBcIlBhdXNlZCB3aGlsZSB0YXNrcyBydW4gXHUwMEI3IHNwZWFrIHRvIHJlc3VtZVwiLCB3YWtpbmc6IFwiUmVzdW1pbmdcdTIwMjZcIiwgZW5kZWQ6IFwiRW5kZWRcIixcbn07XG5cbmZ1bmN0aW9uIHNob3dTdGF0dXMobWVzc2FnZT86IHN0cmluZykge1xuICBjb25zdCB0eXBlZCA9IEJvb2xlYW4oY2FsbElkKSAmJiBtZWRpdW0gPT09IFwidGV4dFwiO1xuICBjb25zdCBzcGVha2luZyA9IEJvb2xlYW4oY2FsbElkKSAmJiAhdHlwZWQgJiYgY29yZVN0YXR1cyAhPT0gXCJzdGFuZGJ5XCIgJiYgY29yZVN0YXR1cyAhPT0gXCJkb3JtYW50XCIgJiYgYXVkaW8ucXVldWVkID4gMC4wNTtcbiAgY29uc3QgYXJtZWRJZGxlID0gIWNhbGxJZCAmJiB3YWtlQXJtZWQ7XG4gIGNvbnN0IHNob3duID0gY2FsbElkXG4gICAgPyAoc3BlYWtpbmcgfHwgKHR5cGVkICYmIHRoaW5raW5nKSA/IFwic3BlYWtpbmdcIiA6IGNvcmVTdGF0dXMpXG4gICAgOiBhcm1lZElkbGUgPyBcImFybWVkXCIgOiBjb3JlU3RhdHVzO1xuICAkKFwic3RhdHVzXCIpLmNsYXNzTmFtZSA9IHNob3duO1xuICBkb2N1bWVudC5ib2R5LmRhdGFzZXQuc3RhdGUgPSBjYWxsSWQgPyBzaG93biA6IGFybWVkSWRsZSA/IFwiYXJtZWRcIiA6IFwiaWRsZVwiO1xuICBkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC50b2dnbGUoXCJpbi1zZXNzaW9uXCIsIEJvb2xlYW4oY2FsbElkKSk7XG4gIGNvbnN0IHdha2VMYWJlbCA9IHNlbGVjdGVkV2FrZU1vZGVsKCk/LmxhYmVsID8/IFwid2FrZSB3b3JkXCI7XG4gIGxldCB0ZXh0ID0gYXJtZWRJZGxlXG4gICAgPyAod2FrZUxvYWRpbmcgPyBgTG9hZGluZyBcdTIwMUMke3dha2VMYWJlbH1cdTIwMURcdTIwMjZgXG4gICAgICA6IGF1ZGlvLmF1ZGlvU3VzcGVuZGVkID8gYFRhcCBhbnl3aGVyZSB0byBhY3RpdmF0ZSBcdTIwMUMke3dha2VMYWJlbH1cdTIwMURgXG4gICAgICA6IGBXYWl0aW5nIGZvciBcdTIwMUMke3dha2VMYWJlbH1cdTIwMURgKVxuICAgIDogc3BlYWtpbmcgPyBcIlNwZWFraW5nXCJcbiAgICA6IGNvcmVTdGF0dXMgPT09IFwiZG9ybWFudFwiID8gYERvcm1hbnQgXHUwMEI3IHNheSBcdTIwMUMke3dha2VMYWJlbH1cdTIwMURgXG4gICAgOiBTVEFUVVNfVEVYVFtjb3JlU3RhdHVzXSA/PyBjb3JlU3RhdHVzO1xuICBpZiAodHlwZWQgJiYgY29yZVN0YXR1cyAhPT0gXCJlbmRlZFwiKSB0ZXh0ID0gdGhpbmtpbmcgPyBcIldyaXRpbmdcdTIwMjZcIiA6IGNvcmVTdGF0dXMgPT09IFwid29ya2luZ1wiID8gXCJDaGF0IFx1MDBCNyB0YXNrcyBydW5uaW5nXCIgOiBcIkNoYXRcIjtcbiAgaWYgKGNhbGxJZCAmJiAhdHlwZWQgJiYgbXV0ZWQgJiYgIWhvbGRpbmcgJiYgIXNwZWFraW5nKSB0ZXh0ICs9IFwiIFx1MDBCNyBtdXRlZFwiO1xuICBpZiAoaG9sZGluZykgdGV4dCA9IFwiVGFsa2luZyAoaG9sZClcIjtcbiAgaWYgKG1lc3NhZ2UpIHRleHQgPSBgJHt0ZXh0fTogJHttZXNzYWdlfWA7XG4gIGlmIChjb3JlU3RhdHVzICE9PSBcImVuZGVkXCIgfHwgbWVzc2FnZSB8fCBhcm1lZElkbGUpICQoXCJzdGF0dXN0ZXh0XCIpLnRleHRDb250ZW50ID0gdGV4dDtcbiAgJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJodXNoXCIpLmNsYXNzTGlzdC50b2dnbGUoXCJsaXZlXCIsIHNwZWFraW5nIHx8ICh0eXBlZCAmJiB0aGlua2luZykpO1xuXG4gIGNvbnN0IGJhciA9ICQoXCJjYWxsYmFyXCIpO1xuICBiYXIuaGlkZGVuID0gIWNhbGxJZDtcbiAgJChcIndha2Utbm93XCIpLmhpZGRlbiA9ICEoY2FsbElkICYmICF0eXBlZCAmJiAoY29yZVN0YXR1cyA9PT0gXCJkb3JtYW50XCIgfHwgY29yZVN0YXR1cyA9PT0gXCJzdGFuZGJ5XCIpKTtcbiAgaWYgKGNhbGxJZCkge1xuICAgICQoXCJjYWxsYmFyLXN0YXRlXCIpLnRleHRDb250ZW50ID0gdGV4dDtcbiAgICAkKFwiY2FsbHRpbWVyXCIpLmhpZGRlbiA9IHR5cGVkO1xuICAgIGlmICghdHlwZWQpICQoXCJjYWxsdGltZXJcIikudGV4dENvbnRlbnQgPSBmb3JtYXRDbG9jayhub3coKSAtIHN0YXJ0ZWRBdCk7XG4gICAgY29uc3Qgdml6TW9kZSA9IHR5cGVkID8gKHRoaW5raW5nID8gXCJ0aGlua2luZ1wiIDogXCJpZGxlXCIpXG4gICAgICA6IHNwZWFraW5nID8gXCJzcGVha2luZ1wiXG4gICAgICA6IG11dGVkICYmICFob2xkaW5nID8gXCJtdXRlZFwiXG4gICAgICA6IHNob3duO1xuICAgIHVwZGF0ZVZpc3VhbGl6ZXIodml6TW9kZSwgbXV0ZWQgJiYgIWhvbGRpbmcgPyAwIDogYXVkaW8ubGV2ZWwpO1xuICB9XG59XG5cbi8vIFRoZSBjYWxsLlxuXG5mdW5jdGlvbiBwdXNoKGV2ZW50OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiwgdCA9IG5vdygpKTogQ29tbWFuZFtdIHtcbiAgaWYgKCFjb3JlIHx8ICFjYWxsSWQpIHJldHVybiBbXTtcbiAgLy8gRmx1c2ggZGVmZXJyZWQgdW5zdXBwcmVzc2VkIGdhcCBmcmFtZXMgYmVmb3JlIGFueSBldmVudCB0aGF0IGNhbiBzdGFydCBuZXcgcGxheWJhY2tcbiAgLy8gKGFkdmFuY2luZyByZXBsYXlGbG9vclNlcSB3aXRob3V0IHJlc2V0dGluZyB3YWtlQ2xpZW50LCBzbyBhIHZhbGlkIHdha2UgaGl0IHN0aWxsIGxhbmRzKS5cbiAgY29uc3QgZmx1c2hlZCA9IHdha2VHYXRlLmJlZm9yZVB1c2goZXZlbnQsIHQpO1xuICBpZiAobWVkaXVtID09PSBcInZvaWNlXCIpIHtcbiAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgZmx1c2hlZCkge1xuICAgICAgaWYgKCFjYWxsSWQpIGJyZWFrO1xuICAgICAgY291bnRzLm1pYysrO1xuICAgICAgcHVzaCh7IHR5cGU6IFwibWljXCIsIHBjbTogaXRlbS5wY20gfSwgaXRlbS50KTtcbiAgICB9XG4gIH1cbiAgY29uc3QgZTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7IC4uLmV2ZW50LCB0IH07XG4gIGNvbnN0IHF1aWV0ID0gZS50eXBlID09PSBcIm1pY1wiIHx8IGUudHlwZSA9PT0gXCJ0aWNrXCI7XG4gIGlmICghcXVpZXQpIGxvZyhcImluXCIsIGUudHlwZSA9PT0gXCJ3cy5tZXNzYWdlXCIgPyBgd3MgJHtlLnNpZH0gXHUyMTkwICR7YnJpZWYoU3RyaW5nKGUuZGF0YSkpfWAgOiBKU09OLnN0cmluZ2lmeShlKS5zbGljZSgwLCA0MDApLCBcImluXCIpO1xuICBjb25zdCBjb21tYW5kcyA9IEpTT04ucGFyc2UoY29yZS5wdXNoKGNhbGxJZCwgSlNPTi5zdHJpbmdpZnkoZSkpKSBhcyBDb21tYW5kW107XG4gIHJ1bihjb21tYW5kcywgdCwgdHlwZW9mIGV2ZW50LnR5cGUgPT09IFwic3RyaW5nXCIgPyBldmVudC50eXBlIDogdW5kZWZpbmVkKTtcbiAgcmV0dXJuIGNvbW1hbmRzO1xufVxuXG5mdW5jdGlvbiBydW4oY29tbWFuZHM6IENvbW1hbmRbXSwgZXZlbnRUaW1lID0gbm93KCksIGV2ZW50VHlwZT86IHN0cmluZykge1xuICB3YWtlR2F0ZS5vYnNlcnZlQ29tbWFuZHMoY29tbWFuZHMsIGV2ZW50VGltZSwgZXZlbnRUeXBlKTtcbiAgZm9yIChjb25zdCBjIG9mIGNvbW1hbmRzKSB7XG4gICAgc3dpdGNoIChjLnR5cGUpIHtcbiAgICAgIGNhc2UgXCJ3cy5jb25uZWN0XCI6IGNvbm5lY3QoYy5zaWQsIGMucHVycG9zZSA9PT0gXCJjYXB0aW9uc1wiKTsgYnJlYWs7XG4gICAgICBjYXNlIFwid3Muc2VuZFwiOiB7XG4gICAgICAgIHNvY2tldHMuZ2V0KGMuc2lkKT8uc2VuZChjLmRhdGEpO1xuICAgICAgICBpZiAoIWMuZGF0YS5zdGFydHNXaXRoKCd7XCJyZWFsdGltZUlucHV0XCI6e1wiYXVkaW9cIicpKSBsb2coXCJvdXRcIiwgYHdzICR7Yy5zaWR9IFx1MjE5MiAke2JyaWVmKGMuZGF0YSl9YCwgXCJvdXRcIik7XG4gICAgICAgIGVsc2UgaWYgKCFjYXB0aW9uU29ja2V0cy5oYXMoYy5zaWQpKSBjb3VudHMuc2VudCsrO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ3cy5jbG9zZVwiOiBzb2NrZXRzLmdldChjLnNpZCk/LmNsb3NlKCk7IHNvY2tldHMuZGVsZXRlKGMuc2lkKTsgbG9nKFwib3V0XCIsIGB3cyAke2Muc2lkfSBjbG9zZWAsIFwib3V0XCIpOyBicmVhaztcbiAgICAgIGNhc2UgXCJtaWMuc3RhcnRcIjoge1xuICAgICAgICBsb2coXCJvdXRcIiwgYy50eXBlLCBcIm91dFwiKTtcbiAgICAgICAgY29uc3QgcGVuZGluZ09wZW5pbmcgPSB3YWtlU3RhcnRpbmcgPyBvcGVuaW5nQ2h1bmtzLnNwbGljZSgwKSA6IFtdO1xuICAgICAgICBvcGVuaW5nQnl0ZXMgPSAwO1xuICAgICAgICB3YWtlU3RhcnRpbmcgPSBmYWxzZTtcbiAgICAgICAgdm9pZCBhdWRpby5lbnN1cmVNaWMob25NaWMsIG1pY09wdGlvbnMoKSkuY2F0Y2goKGVycikgPT4geyBsb2coXCJlcnJvclwiLCBgbWljcm9waG9uZTogJHtlcnIubWVzc2FnZX1gLCBcImVyclwiKTsgdG9hc3QoYE1pY3JvcGhvbmU6ICR7ZXJyLm1lc3NhZ2V9YCk7IH0pO1xuICAgICAgICBpZiAocGVuZGluZ09wZW5pbmcubGVuZ3RoID4gMCkge1xuICAgICAgICAgIGNvbnN0IHRvdGFsTXMgPSBNYXRoLnJvdW5kKHBlbmRpbmdPcGVuaW5nLnJlZHVjZSgocywgYikgPT4gcyArIGIuYnl0ZUxlbmd0aCwgMCkgLyAzMik7XG4gICAgICAgICAgbG9nKFwib3V0XCIsIGBmbHVzaGluZyAke3RvdGFsTXN9IG1zIHNwb2tlbiBhZnRlciB3YWtlIHdvcmRgLCBcIm91dFwiKTtcbiAgICAgICAgICBxdWV1ZU1pY3JvdGFzaygoKSA9PiB7XG4gICAgICAgICAgICBpZiAoIWNhbGxJZCkgcmV0dXJuO1xuICAgICAgICAgICAgZm9yIChjb25zdCBjaHVuayBvZiBwZW5kaW5nT3BlbmluZykge1xuICAgICAgICAgICAgICBpZiAoIWNhbGxJZCkgYnJlYWs7XG4gICAgICAgICAgICAgIGNvdW50cy5taWMrKztcbiAgICAgICAgICAgICAgcHVzaCh7IHR5cGU6IFwibWljXCIsIHBjbTogYnl0ZXNUb0Jhc2U2NChjaHVuaykgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwibWljLnJlc3RhcnRcIjpcbiAgICAgICAgbG9nKFwib3V0XCIsIGMudHlwZSwgXCJvdXRcIik7XG4gICAgICAgIHZvaWQgYXVkaW8uc3RhcnRNaWMob25NaWMsIG1pY09wdGlvbnMoKSkuY2F0Y2goKGVycikgPT4geyBsb2coXCJlcnJvclwiLCBgbWljcm9waG9uZTogJHtlcnIubWVzc2FnZX1gLCBcImVyclwiKTsgdG9hc3QoYE1pY3JvcGhvbmU6ICR7ZXJyLm1lc3NhZ2V9YCk7IH0pO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJtaWMuc3RvcFwiOlxuICAgICAgICBpZiAoIXdha2VBcm1lZCkgYXVkaW8uc3RvcE1pYygpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJwbGF5XCI6IHtcbiAgICAgICAgY29uc3QgdCA9IG5vdygpO1xuICAgICAgICAvLyBBIHJlcGx5IHN0YXJ0aW5nOiBmcm9tIHRoZSBlbmQgb2YgdGhlIHVzZXIncyBzcGVlY2ggdG8gaXRzIGZpcnN0IHNvdW5kLlxuICAgICAgICBpZiAoIW1ldHJpY3MucmVwbGllZCAmJiBhdWRpby5xdWV1ZWQgPCAwLjA1ICYmIHQgLSBtZXRyaWNzLmxhc3RQbGF5ID4gMC42ICYmIG1ldHJpY3MubGFzdFZvaWNlID4gMCAmJiB0IC0gbWV0cmljcy5sYXN0Vm9pY2UgPCAxMCkge1xuICAgICAgICAgIG1ldHJpY3MucmVwbHkucHVzaCh0IC0gbWV0cmljcy5sYXN0Vm9pY2UpO1xuICAgICAgICAgIGlmIChtZXRyaWNzLnJlcGx5Lmxlbmd0aCA+IDIwKSBtZXRyaWNzLnJlcGx5LnNoaWZ0KCk7XG4gICAgICAgICAgbWV0cmljcy5yZXBsaWVkID0gdHJ1ZTtcbiAgICAgICAgICBzaG93TWV0cmljcygpO1xuICAgICAgICB9XG4gICAgICAgIG1ldHJpY3MubGFzdFBsYXkgPSB0O1xuICAgICAgICBhdWRpby5wbGF5KGMucGNtKTtcbiAgICAgICAgY291bnRzLnBsYXkrKztcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwiZmx1c2hcIjpcbiAgICAgICAgYXVkaW8uZmx1c2goKTtcbiAgICAgICAgbG9nKFwib3V0XCIsIFwiZmx1c2hcIiwgXCJvdXRcIik7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcImN1ZVwiOlxuICAgICAgICBhdWRpby5jdWUoYy5wY20pO1xuICAgICAgICBsb2coXCJvdXRcIiwgYGN1ZSAke2MuZWFyY29ufWAsIFwib3V0XCIpO1xuICAgICAgICAvLyBBIHJlcXVlc3QgdGhhdCBiZWNhbWUgYSB0YXNrIGdldHMgYSB0b25lLCBub3QgYSBzcG9rZW4gcmVwbHk6IG5vdGhpbmcgdG8gdGltZS5cbiAgICAgICAgaWYgKGMuZWFyY29uID09PSBcInRhc2tTdGFydGVkXCIpIG1ldHJpY3MucmVwbGllZCA9IHRydWU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcIndha2V3b3JkXCI6IGVuc3VyZUNvcmVXYWtlKEJvb2xlYW4oYy5vbikpOyBicmVhaztcbiAgICAgIGNhc2UgXCJ0b29sLmNhbGxcIjogdm9pZCB0b29sKGMpOyBicmVhaztcbiAgICAgIGNhc2UgXCJ0b29sLmNhbmNlbFwiOiBjYW5jZWxSdW4oYy5ydW4sIGMucmVhc29uKTsgYnJlYWs7XG4gICAgICBjYXNlIFwidG9vbC5zdGVlclwiOiB2b2lkIHN0ZWVyUnVuKGMpOyBicmVhaztcbiAgICAgIGNhc2UgXCJzdGF0dXNcIjoge1xuICAgICAgICBjb25zdCBwcmV2ID0gY29yZVN0YXR1cztcbiAgICAgICAgY29yZVN0YXR1cyA9IGMuc3RhdHVzO1xuICAgICAgICBpZiAoYy5zdGF0dXMgPT09IFwiZG9ybWFudFwiICYmIHByZXYgIT09IFwiZG9ybWFudFwiICYmIGNoZWNrZWQoXCJ3YWtlLWN1ZVwiKSkgYXVkaW8uY3VlKFNMRUVQX1RPTkUpO1xuICAgICAgICBzaG93U3RhdHVzKGMuc3RhdHVzID09PSBcImVuZGVkXCIgPyBjLm1lc3NhZ2UgPz8gdW5kZWZpbmVkIDogdW5kZWZpbmVkKTtcbiAgICAgICAgbG9nKFwic3RhdHVzXCIsIGMuc3RhdHVzICsgKGMubWVzc2FnZSA/IGA6ICR7Yy5tZXNzYWdlfWAgOiBcIlwiKSwgXCJzdGF0dXNcIik7XG4gICAgICAgIGlmIChjLnN0YXR1cyA9PT0gXCJlbmRlZFwiKSB7IGlmIChjLm1lc3NhZ2UpIG5vdGUoYy5tZXNzYWdlKTsgZW5kKCk7IH1cbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwibGxtLnJlcXVlc3RcIjogdm9pZCBnZW5lcmF0ZShjLmlkLCBjLmJvZHkpOyBicmVhaztcbiAgICAgIGNhc2UgXCJsbG0uY2FuY2VsXCI6IHJlcXVlc3RzLmdldChjLmlkKT8uYWJvcnQoKTsgcmVxdWVzdHMuZGVsZXRlKGMuaWQpOyBsb2coXCJvdXRcIiwgYHJlcXVlc3QgJHtjLmlkfSBkcm9wcGVkYCwgXCJvdXRcIik7IGJyZWFrO1xuICAgICAgY2FzZSBcInRoaW5raW5nXCI6IHRoaW5raW5nID0gYy5vbjsgc2hvd1N0YXR1cygpOyBicmVhaztcbiAgICAgIGNhc2UgXCJlcnJvclwiOiBub3RlKGMubWVzc2FnZSk7IGxvZyhcImVycm9yXCIsIGMubWVzc2FnZSwgXCJlcnJcIik7IGJyZWFrO1xuICAgICAgY2FzZSBcImNhcHRpb25cIjogY2FwdGlvbihjLnRleHQpOyBicmVhaztcbiAgICAgIGNhc2UgXCJ0cmFuc2NyaXB0XCI6XG4gICAgICAgIHRyYW5zY3JpcHQoYy5yb2xlLCBjLnRleHQsIGMubGluZSk7XG4gICAgICAgIHJlbWVtYmVyKGMucm9sZSwgYy50ZXh0LCBjLnJvbGUgPT09IFwiYXNzaXN0YW50XCIgPyBcIkdlbWluaVwiIDogdW5kZWZpbmVkLCBsYXN0TGluZSA9PT0gYy5saW5lKTtcbiAgICAgICAgbGFzdExpbmUgPSBjLmxpbmU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcInRhc2tcIjoge1xuICAgICAgICBjb25zdCB2aWV3ID0gdGFza3MuZ2V0KGMuaWQpID8/IHsgYywgc2luY2U6IG5vdygpLCBlbmRlZDogbnVsbCB9O1xuICAgICAgICBpZiAoYy5zdGF0ZSA9PT0gXCJydW5uaW5nXCIgJiYgdmlldy5jLnN0YXRlICE9PSBcInJ1bm5pbmdcIikgeyB2aWV3LnNpbmNlID0gbm93KCk7IHZpZXcuZW5kZWQgPSBudWxsOyB9XG4gICAgICAgIGlmIChjLnN0YXRlICE9PSBcInJ1bm5pbmdcIiAmJiB2aWV3LmVuZGVkID09IG51bGwpIHZpZXcuZW5kZWQgPSBub3coKTtcbiAgICAgICAgdmlldy5jID0gYztcbiAgICAgICAgdGFza3Muc2V0KGMuaWQsIHZpZXcpO1xuICAgICAgICBzaG93VGFza3MoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwicXVlc3Rpb25zXCI6IGJyZWFrO1xuICAgICAgY2FzZSBcIm1pY1NpbGVudFwiOiAkKFwibWljd2FyblwiKS5oaWRkZW4gPSAhYy5zaWxlbnQ7IGJyZWFrO1xuICAgICAgY2FzZSBcInZvaWNlQ29tbWFuZFwiOlxuICAgICAgICB0b2FzdChgSGVhcmQgXHUyMDFDJHtjLmhlYXJkfVx1MjAxRDogJHtjLmNvbW1hbmQgPT09IFwic3RvcFwiID8gXCJzdG9wcGVkXCIgOiBjLmNvbW1hbmQgPT09IFwiY2FuY2VsQWxsXCIgPyBcImNhbmNlbGxpbmcgZXZlcnkgdGFza1wiIDogXCJoYW5naW5nIHVwXCJ9YCk7XG4gICAgICAgIGxvZyhcIm91dFwiLCBgdm9pY2UgY29tbWFuZCAke2MuY29tbWFuZH06ICR7Yy5oZWFyZH1gLCBcIm91dFwiKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwibG9nXCI6IGxvZyhjLmxldmVsLCBjLm1lc3NhZ2UsIGMubGV2ZWwgPT09IFwid2FyblwiID8gXCJ3YXJuXCIgOiBcIlwiKTsgYnJlYWs7XG4gICAgICBkZWZhdWx0OiBsb2coXCJvdXRcIiwgSlNPTi5zdHJpbmdpZnkoYykuc2xpY2UoMCwgMzAwKSwgXCJvdXRcIik7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIGZsdXNoRGVmZXJyZWRNaWMoKSB7XG4gIGNvbnN0IGl0ZW1zID0gd2FrZUdhdGUuZmx1c2hEZWZlcnJlZCgpO1xuICBpZiAoIWNhbGxJZCB8fCBtZWRpdW0gIT09IFwidm9pY2VcIikgcmV0dXJuO1xuICBmb3IgKGNvbnN0IGl0ZW0gb2YgaXRlbXMpIHtcbiAgICBpZiAoIWNhbGxJZCkgYnJlYWs7XG4gICAgY291bnRzLm1pYysrO1xuICAgIHB1c2goeyB0eXBlOiBcIm1pY1wiLCBwY206IGl0ZW0ucGNtIH0sIGl0ZW0udCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gb25NaWMoc2FtcGxlczogSW50MTZBcnJheSwgbGV2ZWw6IG51bWJlcikge1xuICBjb25zdCB0ID0gbm93KCk7XG4gIGNvbnN0IHN1cHByZXNzZWQgPSBjYWxsSWQgIT09IDAgJiYgbWVkaXVtID09PSBcInZvaWNlXCIgJiYgd2FrZUdhdGUuaXNTdXBwcmVzc2VkKHQpO1xuICBjb25zdCBzZXEgPSBzaG91bGRGZWVkV2FrZSgpID8gd2FrZUNsaWVudC5mZWVkKHNhbXBsZXMsIHN1cHByZXNzZWQpIDogMDtcbiAgaWYgKHdha2VTdGFydGluZykge1xuICAgIGNvbnN0IGNvcHkgPSBuZXcgVWludDhBcnJheShzYW1wbGVzLmJ5dGVMZW5ndGgpO1xuICAgIGNvcHkuc2V0KG5ldyBVaW50OEFycmF5KHNhbXBsZXMuYnVmZmVyLCBzYW1wbGVzLmJ5dGVPZmZzZXQsIHNhbXBsZXMuYnl0ZUxlbmd0aCkpO1xuICAgIG9wZW5pbmdDaHVua3MucHVzaChjb3B5KTtcbiAgICBvcGVuaW5nQnl0ZXMgKz0gY29weS5ieXRlTGVuZ3RoO1xuICAgIHdoaWxlIChvcGVuaW5nQnl0ZXMgPiBPUEVOSU5HX01BWF9CWVRFUyAmJiBvcGVuaW5nQ2h1bmtzLmxlbmd0aCA+IDEpIHtcbiAgICAgIG9wZW5pbmdCeXRlcyAtPSBvcGVuaW5nQ2h1bmtzLnNoaWZ0KCkhLmJ5dGVMZW5ndGg7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuICBpZiAoIWNhbGxJZCB8fCBtZWRpdW0gIT09IFwidm9pY2VcIikgcmV0dXJuO1xuICBpZiAobGV2ZWwgPiAwLjAzICYmICEobXV0ZWQgJiYgIWhvbGRpbmcpKSB7XG4gICAgbWV0cmljcy5sYXN0Vm9pY2UgPSB0O1xuICAgIGlmIChhdWRpby5xdWV1ZWQgPCAwLjA1KSBtZXRyaWNzLnJlcGxpZWQgPSBmYWxzZTtcbiAgfVxuICBjb25zdCBwY20gPSBieXRlc1RvQmFzZTY0KG5ldyBVaW50OEFycmF5KHNhbXBsZXMuYnVmZmVyLCBzYW1wbGVzLmJ5dGVPZmZzZXQsIHNhbXBsZXMuYnl0ZUxlbmd0aCkpO1xuICBjb25zdCB0b1NlbmQgPSB3YWtlR2F0ZS5vbk1pY0ZyYW1lKHtcbiAgICBwY20sXG4gICAgdCxcbiAgICBzZXEsXG4gICAgbGFzdFNlcTogd2FrZUNsaWVudC5sYXN0U2VxLFxuICAgIGluRmxpZ2h0U3VwcHJlc3NlZFNlcTogd2FrZUNsaWVudC5pbkZsaWdodFN1cHByZXNzZWRTZXEsXG4gICAgc3VwcHJlc3NlZCxcbiAgfSk7XG4gIGZvciAoY29uc3QgaXRlbSBvZiB0b1NlbmQpIHtcbiAgICBpZiAoIWNhbGxJZCkgYnJlYWs7XG4gICAgY291bnRzLm1pYysrO1xuICAgIHB1c2goeyB0eXBlOiBcIm1pY1wiLCBwY206IGl0ZW0ucGNtIH0sIGl0ZW0udCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gY29ubmVjdChzaWQ6IG51bWJlciwgY2FwdGlvbnM6IGJvb2xlYW4pIHtcbiAgY29uc3Qgd3MgPSBuZXcgV2ViU29ja2V0KGAke2xvY2F0aW9uLnByb3RvY29sID09PSBcImh0dHBzOlwiID8gXCJ3c3NcIiA6IFwid3NcIn06Ly8ke2xvY2F0aW9uLmhvc3R9L2xpdmUke2NhcHRpb25zID8gXCI/Zm9yPWNhcHRpb25zXCIgOiBcIlwifWApO1xuICBzb2NrZXRzLnNldChzaWQsIHdzKTtcbiAgaWYgKGNhcHRpb25zKSBjYXB0aW9uU29ja2V0cy5hZGQoc2lkKTtcbiAgbG9nKFwib3V0XCIsIGB3cyAke3NpZH0gY29ubmVjdCAoJHtzZXJ2ZXIucm91dGV9JHtjYXB0aW9ucyA/IFwiLCBjYXB0aW9uc1wiIDogXCJcIn0pYCwgXCJvdXRcIik7XG4gIHdzLm9ub3BlbiA9ICgpID0+IHB1c2goeyB0eXBlOiBcIndzLm9wZW5cIiwgc2lkIH0pO1xuICB3cy5vbm1lc3NhZ2UgPSAobSkgPT4gcHVzaCh7IHR5cGU6IFwid3MubWVzc2FnZVwiLCBzaWQsIGRhdGE6IHR5cGVvZiBtLmRhdGEgPT09IFwic3RyaW5nXCIgPyBtLmRhdGEgOiBcIlwiIH0pO1xuICB3cy5vbmNsb3NlID0gKGUpID0+IHtcbiAgICBpZiAoc29ja2V0cy5nZXQoc2lkKSAhPT0gd3MgJiYgc29ja2V0cy5oYXMoc2lkKSkgcmV0dXJuO1xuICAgIGNvbnN0IGh0dHBTdGF0dXMgPSBlLmNvZGUgPj0gNDEwMCAmJiBlLmNvZGUgPCA0NjAwID8gZS5jb2RlIC0gNDAwMCA6IHVuZGVmaW5lZDtcbiAgICBwdXNoKHsgdHlwZTogXCJ3cy5jbG9zZWRcIiwgc2lkLCBjb2RlOiBodHRwU3RhdHVzID8gdW5kZWZpbmVkIDogZS5jb2RlLCByZWFzb246IGUucmVhc29uLCBodHRwU3RhdHVzIH0pO1xuICB9O1xufVxuXG4vKiogQSBjaGF0J3MgcmVxdWVzdCB0byB0aGUgdGV4dCBtb2RlbCwgdGhyb3VnaCB0aGUgc2VydmVyOiBlYWNoIGBkYXRhOmAgbGluZSBvZiB0aGUgbW9kZWwncyBzdHJlYW0gZ29lcyB0byB0aGUgY29yZSBhcyBpdCBjb21lcy4gKi9cbmFzeW5jIGZ1bmN0aW9uIGdlbmVyYXRlKGlkOiBudW1iZXIsIGJvZHk6IHN0cmluZykge1xuICBjb25zdCBhYm9ydCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgcmVxdWVzdHMuc2V0KGlkLCBhYm9ydCk7XG4gIGxvZyhcIm91dFwiLCBgcmVxdWVzdCAke2lkfSBcdTIxOTIgJHtzZXJ2ZXIudGV4dE1vZGVsfSAoJHtNYXRoLnJvdW5kKGJvZHkubGVuZ3RoIC8gMTAyNCl9IEtCKWAsIFwib3V0XCIpO1xuICB0cnkge1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goXCIvZ2VuZXJhdGVcIiwgeyBtZXRob2Q6IFwiUE9TVFwiLCBzaWduYWw6IGFib3J0LnNpZ25hbCwgaGVhZGVyczogeyBcImNvbnRlbnQtdHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LCBib2R5IH0pO1xuICAgIGlmICghcmVzcG9uc2Uub2sgfHwgIXJlc3BvbnNlLmJvZHkpIHtcbiAgICAgIGNvbnN0IHRleHQgPSBhd2FpdCByZXNwb25zZS50ZXh0KCkuY2F0Y2goKCkgPT4gXCJcIik7XG4gICAgICBwdXNoKHsgdHlwZTogXCJsbG0uZW5kXCIsIGlkLCBzdGF0dXM6IHJlc3BvbnNlLnN0YXR1cywgZXJyb3I6IGBIVFRQICR7cmVzcG9uc2Uuc3RhdHVzfSR7dGV4dCA/IFwiOiBcIiArIHRleHQucmVwbGFjZSgvXFxzKy9nLCBcIiBcIikuc2xpY2UoMCwgMjAwKSA6IFwiXCJ9YCB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgcmVhZGVyID0gcmVzcG9uc2UuYm9keS5waXBlVGhyb3VnaChuZXcgVGV4dERlY29kZXJTdHJlYW0oKSkuZ2V0UmVhZGVyKCk7XG4gICAgbGV0IGJ1ZmZlciA9IFwiXCI7XG4gICAgZm9yICg7Oykge1xuICAgICAgY29uc3QgeyB2YWx1ZSwgZG9uZSB9ID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcbiAgICAgIGlmIChkb25lKSBicmVhaztcbiAgICAgIGJ1ZmZlciArPSB2YWx1ZTtcbiAgICAgIGxldCBjdXQ7XG4gICAgICB3aGlsZSAoKGN1dCA9IGJ1ZmZlci5pbmRleE9mKFwiXFxuXCIpKSA+PSAwKSB7XG4gICAgICAgIGNvbnN0IGxpbmUgPSBidWZmZXIuc2xpY2UoMCwgY3V0KS5yZXBsYWNlKC9cXHIkLywgXCJcIik7XG4gICAgICAgIGJ1ZmZlciA9IGJ1ZmZlci5zbGljZShjdXQgKyAxKTtcbiAgICAgICAgaWYgKGxpbmUuc3RhcnRzV2l0aChcImRhdGE6XCIpKSBwdXNoKHsgdHlwZTogXCJsbG0uZGF0YVwiLCBpZCwgZGF0YTogbGluZS5zbGljZSg1KS50cmltKCkgfSk7XG4gICAgICB9XG4gICAgfVxuICAgIHB1c2goeyB0eXBlOiBcImxsbS5lbmRcIiwgaWQgfSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGlmICghYWJvcnQuc2lnbmFsLmFib3J0ZWQpIHB1c2goeyB0eXBlOiBcImxsbS5lbmRcIiwgaWQsIGVycm9yOiAoZXJyIGFzIEVycm9yKS5tZXNzYWdlIH0pO1xuICB9IGZpbmFsbHkge1xuICAgIHJlcXVlc3RzLmRlbGV0ZShpZCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gY2FuY2VsUnVuKGtleTogc3RyaW5nLCByZWFzb246IHN0cmluZykge1xuICBjb25zdCByID0gcnVucy5nZXQoa2V5KTtcbiAgbG9nKFwib3V0XCIsIGBjYW5jZWwgJHtrZXl9ICgke3JlYXNvbn0pYCwgXCJvdXRcIik7XG4gIGlmICghcikgcmV0dXJuO1xuICBydW5zLmRlbGV0ZShrZXkpO1xuICByLmFib3J0LmFib3J0KCk7XG4gIC8vIENhbmNlbGxlZCBvbiBwdXJwb3NlOiB0aGUgYWdlbnQgc3RvcHMgdG9vLiBBIGNhbGwgdGhhdCBlbmRlZCBsZWF2ZXMgYSBjb2RpbmcgYWdlbnQgd29ya2luZyBpbiBUMy5cbiAgaWYgKHJlYXNvbiA9PT0gXCJjYW5jZWxsZWRcIiAmJiAhY2hlY2tlZChcImZha2VoZXJtZXNcIikpIHtcbiAgICB2b2lkIGZldGNoKHIuYWdlbnQgPT09IFwidDNcIiA/IFwiL2FnZW50L2NhbmNlbFwiIDogXCIvaGVybWVzL3N0b3BcIiwgeyBtZXRob2Q6IFwiUE9TVFwiLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGNhbGw6IGNhbGxOYW1lLCB0YXNrSWQ6IHIudGFza0lkIH0pIH0pO1xuICB9XG59XG5cbi8qKiBNb3JlIGZvciBhIHJ1bm5pbmcgdGFzaywgaW50byBpdHMgY3VycmVudCBydW47IGlmIHRoZSBhZ2VudCB3b24ndCB0YWtlIGl0LCB0aGUgY29yZSBxdWV1ZXMgaXQgaW5zdGVhZC4gKi9cbmFzeW5jIGZ1bmN0aW9uIHN0ZWVyUnVuKGM6IENvbW1hbmQpIHtcbiAgY29uc3QgciA9IHJ1bnMuZ2V0KGMucnVuKTtcbiAgbG9nKFwib3V0XCIsIGBzdGVlciAke2MucnVufTogJHtjLnRleHR9YCwgXCJvdXRcIik7XG4gIGlmIChjaGVja2VkKFwiZmFrZWhlcm1lc1wiKSkgcmV0dXJuO1xuICBjb25zdCBvayA9IHIgIT0gbnVsbCAmJlxuICAgIChhd2FpdCBmZXRjaChjLmFnZW50ID09PSBcInQzXCIgPyBcIi9hZ2VudC9zdGVlclwiIDogXCIvaGVybWVzL3N0ZWVyXCIsIHsgbWV0aG9kOiBcIlBPU1RcIiwgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBjYWxsOiBjYWxsTmFtZSwgdGFza0lkOiByLnRhc2tJZCwgdGV4dDogYy5tZXNzYWdlIH0pIH0pLnRoZW4oKHgpID0+IHgub2ssICgpID0+IGZhbHNlKSk7XG4gIGlmICghb2spIHB1c2goeyB0eXBlOiBcInRvb2wuc3RlZXJGYWlsZWRcIiwgcnVuOiBjLnJ1biwgdGV4dDogYy50ZXh0IH0pO1xuICBlbHNlIHRvYXN0KGAke2MuYWdlbnQgPT09IFwidDNcIiA/IFwiVGhlIGNvZGluZyBhZ2VudFwiIDogXCJIZXJtZXNcIn0gdG9vayB0aGUgZm9sbG93LXVwIHdoaWxlIGl0IHdvcmtzYCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHRvb2woYzogQ29tbWFuZCkge1xuICBpZiAoYy5raW5kID09PSBcImhvc3RcIikge1xuICAgIGxvZyhcIm91dFwiLCBgaG9zdCB0b29sICR7Yy5uYW1lfSAke0pTT04uc3RyaW5naWZ5KGMuYXJncyl9YCwgXCJvdXRcIik7XG4gICAgY29uc3QgYW5zd2VyID0gYy5uYW1lID09PSBcInR2X3ZvbHVtZVwiID8gYFRoZSBUViBpcyBhdCAkeyhmYWtlVHZMZXZlbCA9IE51bWJlcihjLmFyZ3M/LmxldmVsID8/IGZha2VUdkxldmVsKSl9LmBcbiAgICAgIDogYy5uYW1lID09PSBcInR2X3BhdXNlXCIgPyAoYy5hcmdzPy5wYXVzZSA9PT0gZmFsc2UgPyBcIlBsYXlpbmcuXCIgOiBcIlBhdXNlZC5cIikgOiBcIkRvbmUuXCI7XG4gICAgc2V0VGltZW91dCgoKSA9PiBwdXNoKHsgdHlwZTogXCJ0b29sLnJlc3VsdFwiLCBydW46IGMucnVuLCB0ZXh0OiBhbnN3ZXIgfSksIDMwMCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IGFnZW50ID0gYy5hZ2VudCA9PT0gXCJ0M1wiID8gXCJ0M1wiIDogXCJoZXJtZXNcIjtcbiAgY29uc3Qgb3JpZ2luU2Vzc2lvbiA9IGFjdGl2ZVNlc3Npb247XG4gIGxvZyhcIm91dFwiLCBgJHthZ2VudH0gJHtjLmZvbGxvd1VwID8gXCJmb2xsb3ctdXBcIiA6IFwidGFza1wifSBcIiR7Yy5sYWJlbH1cIiR7Yy5wcm9qZWN0ID8gYCBpbiAke2MucHJvamVjdH1gIDogXCJcIn06ICR7Yy5yZXF1ZXN0fWAsIFwib3V0XCIpO1xuICBjb25zdCBhYm9ydCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgcnVucy5zZXQoYy5ydW4sIHsgYWJvcnQsIGFnZW50LCB0YXNrSWQ6IGMudGFza0lkIH0pO1xuICBjb25zdCBkb25lID0gKHRleHQ6IHN0cmluZywgZmFpbGVkID0gZmFsc2UpID0+IHtcbiAgICBpZiAoIXJ1bnMuaGFzKGMucnVuKSkgcmV0dXJuO1xuICAgIHJ1bnMuZGVsZXRlKGMucnVuKTtcbiAgICBjb25zdCB2aWV3ID0gdGFza3MuZ2V0KGMudGFza0lkKTtcbiAgICBjb25zdCByZXNJZCA9IHJlc3VsdChhZ2VudCwgYy5sYWJlbCwgdGV4dCwgZmFpbGVkLCBjLnRhc2tJZCwgb3JpZ2luU2Vzc2lvbik7XG4gICAgbm90aWZ5KGAke2FnZW50ID09PSBcInQzXCIgPyBcIlQzXCIgOiBcIkhlcm1lc1wifSBcdTAwQjcgJHtjLmxhYmVsfWAsIHRleHQpO1xuICAgIGlmICghZmFpbGVkKSB7IHJlbWVtYmVyKFwiYXNzaXN0YW50XCIsIHRleHQsIGAke2FnZW50ID09PSBcInQzXCIgPyBcIlQzXCIgOiBcIkhlcm1lc1wifSBcdTAwQjcgJHtjLmxhYmVsfWApOyBsYXN0TGluZSA9IG51bGw7IH1cbiAgICBpZiAodmlldykgeyB2aWV3LnJlc3VsdElkID0gcmVzSWQ7IHNob3dUYXNrcygpOyB9XG4gICAgcHVzaCh7IHR5cGU6IFwidG9vbC5yZXN1bHRcIiwgcnVuOiBjLnJ1biwgdGV4dCwgZmFpbGVkIH0pO1xuICB9O1xuICBpZiAoY2hlY2tlZChcImZha2VoZXJtZXNcIikpIHtcbiAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4gZG9uZShgKEZha2UgJHthZ2VudCA9PT0gXCJ0M1wiID8gXCJUM1wiIDogXCJIZXJtZXNcIn0pIERvbmU6IFx1MjAxQyR7Yy5yZXF1ZXN0fVx1MjAxRC4gTm90aGluZyB3YXMgYWN0dWFsbHkgcnVuLmApLCBOdW1iZXIoJDxIVE1MSW5wdXRFbGVtZW50PihcImZha2VkZWxheVwiKS52YWx1ZSkgKiAxMDAwKTtcbiAgICBhYm9ydC5zaWduYWwub25hYm9ydCA9ICgpID0+IGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgcmV0dXJuO1xuICB9XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChhZ2VudCA9PT0gXCJ0M1wiID8gXCIvYWdlbnRcIiA6IFwiL2hlcm1lc1wiLCB7XG4gICAgICBtZXRob2Q6IFwiUE9TVFwiLCBzaWduYWw6IGFib3J0LnNpZ25hbCwgaGVhZGVyczogeyBcImNvbnRlbnQtdHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBjYWxsOiBjYWxsTmFtZSwgdGFza0lkOiBjLnRhc2tJZCwgZm9sbG93VXA6IGMuZm9sbG93VXAsIG1lc3NhZ2U6IGMubWVzc2FnZSwgbGFiZWw6IGMubGFiZWwsIHJlcXVlc3Q6IGMucmVxdWVzdCwgcHJvamVjdDogYy5wcm9qZWN0LCBhcHByb3ZhbHM6IFwic2NyZWVuXCIgfSksXG4gICAgfSk7XG4gICAgaWYgKCFyZXNwb25zZS5vayB8fCAhcmVzcG9uc2UuYm9keSkgdGhyb3cgbmV3IEVycm9yKGBIVFRQICR7cmVzcG9uc2Uuc3RhdHVzfWApO1xuICAgIGNvbnN0IHJlYWRlciA9IHJlc3BvbnNlLmJvZHkucGlwZVRocm91Z2gobmV3IFRleHREZWNvZGVyU3RyZWFtKCkpLmdldFJlYWRlcigpO1xuICAgIGxldCBidWZmZXIgPSBcIlwiO1xuICAgIGZvciAoOzspIHtcbiAgICAgIGNvbnN0IHsgdmFsdWUsIGRvbmU6IGZpbmlzaGVkIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpO1xuICAgICAgaWYgKGZpbmlzaGVkKSBicmVhaztcbiAgICAgIGJ1ZmZlciArPSB2YWx1ZTtcbiAgICAgIGxldCBjdXQ7XG4gICAgICB3aGlsZSAoKGN1dCA9IGJ1ZmZlci5pbmRleE9mKFwiXFxuXFxuXCIpKSA+PSAwKSB7XG4gICAgICAgIGNvbnN0IGJsb2NrID0gYnVmZmVyLnNsaWNlKDAsIGN1dCk7XG4gICAgICAgIGJ1ZmZlciA9IGJ1ZmZlci5zbGljZShjdXQgKyAyKTtcbiAgICAgICAgY29uc3QgZXZlbnQgPSBibG9jay5tYXRjaCgvXmV2ZW50OiAoLiopJC9tKT8uWzFdO1xuICAgICAgICBpZiAoIWV2ZW50KSBjb250aW51ZTtcbiAgICAgICAgY29uc3QgZGF0YSA9IEpTT04ucGFyc2UoYmxvY2subWF0Y2goL15kYXRhOiAoLiopJC9tKT8uWzFdID8/IFwie31cIik7XG4gICAgICAgIGlmIChldmVudCA9PT0gXCJwcm9ncmVzc1wiKSBwdXNoKHsgdHlwZTogXCJ0YXNrLnByb2dyZXNzXCIsIHRhc2s6IGMudGFza0lkLCB0ZXh0OiBkYXRhLnRleHQgfSk7XG4gICAgICAgIGVsc2UgaWYgKGV2ZW50ID09PSBcInRocmVhZFwiKSB7IGNvbnN0IHZpZXcgPSB0YXNrcy5nZXQoYy50YXNrSWQpOyBpZiAodmlldykgeyB2aWV3LnRocmVhZCA9IGRhdGEudGhyZWFkOyBzaG93VGFza3MoKTsgfSB9XG4gICAgICAgIGVsc2UgaWYgKGV2ZW50ID09PSBcImFwcHJvdmFsXCIpIHtcbiAgICAgICAgICBjb25zdCB2aWV3ID0gdGFza3MuZ2V0KGMudGFza0lkKTtcbiAgICAgICAgICBpZiAodmlldykgeyB2aWV3LmFwcHJvdmFsID0geyBjb21tYW5kOiBkYXRhLmNvbW1hbmQgfTsgc2hvd1Rhc2tzKHRydWUpOyB9XG4gICAgICAgICAgdG9hc3QoYEhlcm1lcyBhc2tzIHRvIHJ1bjogJHtkYXRhLmNvbW1hbmQuc2xpY2UoMCwgODApfWApO1xuICAgICAgICAgIG5vdGlmeShgSGVybWVzIFx1MDBCNyAke2MubGFiZWx9IG5lZWRzIHlvdXIgYXBwcm92YWxgLCBkYXRhLmNvbW1hbmQpO1xuICAgICAgICAgIGF1ZGlvLmN1ZShBUFBST1ZBTF9UT05FKTtcbiAgICAgICAgfVxuICAgICAgICBlbHNlIGlmIChldmVudCA9PT0gXCJyZXN1bHRcIikgZG9uZShkYXRhLnRleHQsIGRhdGEuZmFpbGVkKTtcbiAgICAgICAgZWxzZSBpZiAoZXZlbnQgPT09IFwiZXJyb3JcIikgeyBydW5zLmRlbGV0ZShjLnJ1bik7IHB1c2goeyB0eXBlOiBcInRvb2wuZXJyb3JcIiwgcnVuOiBjLnJ1biwgbWVzc2FnZTogZGF0YS5tZXNzYWdlIH0pOyB9XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChydW5zLmhhcyhjLnJ1bikpIHsgcnVucy5kZWxldGUoYy5ydW4pOyBwdXNoKHsgdHlwZTogXCJ0b29sLmVycm9yXCIsIHJ1bjogYy5ydW4sIG1lc3NhZ2U6IFwidGhlIHNlcnZlciBjbG9zZWQgdGhlIHN0cmVhbSB3aXRob3V0IGEgcmVzdWx0XCIgfSk7IH1cbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgaWYgKCFhYm9ydC5zaWduYWwuYWJvcnRlZCAmJiBydW5zLmhhcyhjLnJ1bikpIHsgcnVucy5kZWxldGUoYy5ydW4pOyBwdXNoKHsgdHlwZTogXCJ0b29sLmVycm9yXCIsIHJ1bjogYy5ydW4sIG1lc3NhZ2U6IChlcnIgYXMgRXJyb3IpLm1lc3NhZ2UgfSk7IH1cbiAgfVxufVxuXG5mdW5jdGlvbiBtaWNPcHRpb25zKCkge1xuICBjb25zdCBhZWMgPSBjaGVja2VkKFwiYWVjXCIpO1xuICByZXR1cm4geyBlY2hvQ2FuY2VsbGF0aW9uOiBhZWMsIG5vaXNlU3VwcHJlc3Npb246IGFlYywgYXV0b0dhaW5Db250cm9sOiBhZWMgfTtcbn1cblxuZnVuY3Rpb24gbnVtYmVyU2V0dGluZyhpZDogc3RyaW5nLCBmYWxsYmFjazogbnVtYmVyLCBtaW4gPSAwLCBtYXggPSAzNjAwKTogbnVtYmVyIHtcbiAgY29uc3QgbiA9IE51bWJlcigkPEhUTUxJbnB1dEVsZW1lbnQ+KGlkKS52YWx1ZSk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobikgPyBNYXRoLm1heChtaW4sIE1hdGgubWluKG1heCwgbikpIDogZmFsbGJhY2s7XG59XG5cbmZ1bmN0aW9uIGRldmVsb3Blck92ZXJyaWRlcygpIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBnaXZlbiA9IEpTT04ucGFyc2UoJDxIVE1MVGV4dEFyZWFFbGVtZW50PihcImNvbmZpZ1wiKS52YWx1ZSk7XG4gICAgaWYgKCFnaXZlbiB8fCB0eXBlb2YgZ2l2ZW4gIT09IFwib2JqZWN0XCIpIHtcbiAgICAgIHJldHVybiB7IG5vbldlYlBsYXRmb3JtOiBudWxsIGFzIHN0cmluZyB8IG51bGwsIGhhc0F0dGVudGlvbjogZmFsc2UsIGhhc0hhbmdVcDogZmFsc2UsIGhhc1N0YW5kYnk6IGZhbHNlLCBoYXNNaWNXaGlsZVNwZWFraW5nOiBmYWxzZSB9O1xuICAgIH1cbiAgICBjb25zdCBub25XZWJQbGF0Zm9ybSA9IHR5cGVvZiBnaXZlbi5wbGF0Zm9ybSA9PT0gXCJzdHJpbmdcIiAmJiBnaXZlbi5wbGF0Zm9ybSAhPT0gXCJ3ZWJcIiA/IGdpdmVuLnBsYXRmb3JtIDogbnVsbDtcbiAgICBjb25zdCBtaWMgPSBnaXZlbi5taWMgJiYgdHlwZW9mIGdpdmVuLm1pYyA9PT0gXCJvYmplY3RcIiA/IGdpdmVuLm1pYyA6IG51bGw7XG4gICAgcmV0dXJuIHtcbiAgICAgIG5vbldlYlBsYXRmb3JtLFxuICAgICAgaGFzQXR0ZW50aW9uOiBnaXZlbi5hdHRlbnRpb24gIT09IHVuZGVmaW5lZCxcbiAgICAgIGhhc0hhbmdVcDogZ2l2ZW4uaGFuZ1VwQWZ0ZXIgIT09IHVuZGVmaW5lZCxcbiAgICAgIGhhc1N0YW5kYnk6IGdpdmVuLnN0YW5kYnlBZnRlciAhPT0gdW5kZWZpbmVkLFxuICAgICAgaGFzTWljV2hpbGVTcGVha2luZzogbWljICE9IG51bGwgJiYgbWljLndoaWxlU3BlYWtpbmcgIT09IHVuZGVmaW5lZCxcbiAgICB9O1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4geyBub25XZWJQbGF0Zm9ybTogbnVsbCBhcyBzdHJpbmcgfCBudWxsLCBoYXNBdHRlbnRpb246IGZhbHNlLCBoYXNIYW5nVXA6IGZhbHNlLCBoYXNTdGFuZGJ5OiBmYWxzZSwgaGFzTWljV2hpbGVTcGVha2luZzogZmFsc2UgfTtcbiAgfVxufVxuXG5mdW5jdGlvbiByZWFkQ29uZmlnKCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgY29uc3QgZ2l2ZW4gPSBKU09OLnBhcnNlKCQ8SFRNTFRleHRBcmVhRWxlbWVudD4oXCJjb25maWdcIikudmFsdWUpO1xuICBjb25zdCBjb25maWc6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgIG1vZGVsOiBzZXJ2ZXIubW9kZWwsIGFwaTogc2VydmVyLnJvdXRlID09PSBcInZlcnRleFwiID8gXCJ2ZXJ0ZXhcIiA6IFwiZ2VtaW5pXCIsIHRvZGF5OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkuc2xpY2UoMCwgMTApLFxuICAgIC4uLmdpdmVuLCB0cmFjZTogY2hlY2tlZChcInRyYWNlXCIpLFxuICB9O1xuICBpZiAoY2hlY2tlZChcInB0dFwiKSkgY29uZmlnLm11dGVkID0gdHJ1ZTtcbiAgaWYgKGdpdmVuLnZvaWNlID09PSB1bmRlZmluZWQpIGNvbmZpZy52b2ljZSA9ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwidm9pY2VcIikudmFsdWU7XG4gIGlmIChjb25maWcuc3RlZXJpbmcgPT09IHVuZGVmaW5lZCkgY29uZmlnLnN0ZWVyaW5nID0gW1wiaGVybWVzXCIsIFwidDNcIl07XG4gIC8vIEEgd2ViIGNvbmZpZyBzYXZlZCBiZWZvcmUgaGFuZC1vZmZzIHdlcmUgbmFtZWQgaW4gd29yZHMgZ2V0cyB0aGF0IHRvby5cbiAgaWYgKGNvbmZpZy5oYW5kT2ZmID09PSB1bmRlZmluZWQgJiYgY29uZmlnLnBsYXRmb3JtID09PSBcIndlYlwiKSBjb25maWcuaGFuZE9mZiA9IFwibmFtZWRcIjtcbiAgLy8gQW5kIG9uZSBzYXZlZCBiZWZvcmUgdGhlIHBhZ2UgZm9sbG93ZWQgdGhlIHVzZXIncyBsZWFkIChzdXBlcnZpc2UpIGdldHMgdGhhdC5cbiAgaWYgKGNvbmZpZy5zdXBlcnZpc2UgPT09IHVuZGVmaW5lZCAmJiBjb25maWcucGxhdGZvcm0gPT09IFwid2ViXCIpIGNvbmZpZy5zdXBlcnZpc2UgPSB0cnVlO1xuICBpZiAoY2hlY2tlZChcImNvZGluZ1wiKSAmJiAoc2VydmVyLnQzIHx8IGNoZWNrZWQoXCJmYWtlaGVybWVzXCIpKSAmJiBjb25maWcuY29kaW5nQWdlbnQgPT09IHVuZGVmaW5lZCkgY29uZmlnLmNvZGluZ0FnZW50ID0geyBwcm9qZWN0czogc2VydmVyLnQzID8/IFtdIH07XG4gIGlmIChjaGVja2VkKFwiY2FwdGlvbnNcIikgJiYgc2VydmVyLmNhcHRpb25zTW9kZWwgJiYgY29uZmlnLmNhcHRpb25zID09PSB1bmRlZmluZWQpIGNvbmZpZy5jYXB0aW9ucyA9IHsgbW9kZWw6IHNlcnZlci5jYXB0aW9uc01vZGVsIH07XG4gIC8vIEFwcGx5IGVhY2ggU2V0dGluZ3Mgc2lnbmFsaW5nIGZpZWxkIGluZGVwZW5kZW50bHkgZm9yIHdlYiBjb25maWdzIHVubGVzcyBzZXQgaW4gRGV2ZWxvcGVyIEpTT04gLyBwcmVzZXQuXG4gIGNvbnN0IG5vbldlYiA9IHR5cGVvZiBnaXZlbi5wbGF0Zm9ybSA9PT0gXCJzdHJpbmdcIiAmJiBnaXZlbi5wbGF0Zm9ybSAhPT0gXCJ3ZWJcIjtcbiAgaWYgKCFub25XZWIpIHtcbiAgICBjb25zdCBzaWduYWxpbmcgPSAkPEhUTUxTZWxlY3RFbGVtZW50PihcInNpZ25hbGluZ1wiKS52YWx1ZTtcbiAgICBpZiAoZ2l2ZW4uYXR0ZW50aW9uID09PSB1bmRlZmluZWQgJiYgKHNpZ25hbGluZyA9PT0gXCJ3aW5kb3dcIiB8fCBzaWduYWxpbmcgPT09IFwiZWNob1wiKSkge1xuICAgICAgY29uZmlnLmF0dGVudGlvbiA9IHtcbiAgICAgICAgbW9kZTogXCJ3aW5kb3dcIixcbiAgICAgICAgYWZ0ZXJXYWtlOiBudW1iZXJTZXR0aW5nKFwiYXR0bi1hZnRlci13YWtlXCIsIDgsIDEsIDYwKSxcbiAgICAgICAgd2luZG93OiBudW1iZXJTZXR0aW5nKFwiYXR0bi13aW5kb3dcIiwgNSwgMCwgNjApLFxuICAgICAgICBhZnRlclF1ZXN0aW9uOiBudW1iZXJTZXR0aW5nKFwiYXR0bi1hZnRlci1xdWVzdGlvblwiLCAxMCwgMCwgNjApLFxuICAgICAgICBhZnRlckhhbmRPZmY6IDMsXG4gICAgICAgIGFmdGVyQW5ub3VuY2VtZW50OiAwLFxuICAgICAgfTtcbiAgICB9XG4gICAgaWYgKGdpdmVuLmhhbmdVcEFmdGVyID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbmZpZy5oYW5nVXBBZnRlciA9IG51bWJlclNldHRpbmcoXCJoYW5ndXAtYWZ0ZXJcIiwgc2lnbmFsaW5nID09PSBcImVjaG9cIiA/IDE1IDogMzAwLCAwLCAzNjAwKTtcbiAgICB9XG4gICAgaWYgKHNpZ25hbGluZyA9PT0gXCJlY2hvXCIgJiYgZ2l2ZW4uc3RhbmRieUFmdGVyID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbmZpZy5zdGFuZGJ5QWZ0ZXIgPSA4O1xuICAgIH1cbiAgICBjb25zdCBnaXZlbk1pYyA9IGdpdmVuLm1pYyAmJiB0eXBlb2YgZ2l2ZW4ubWljID09PSBcIm9iamVjdFwiID8gKGdpdmVuLm1pYyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgOiBudWxsO1xuICAgIGlmICgoIWdpdmVuTWljIHx8IGdpdmVuTWljLndoaWxlU3BlYWtpbmcgPT09IHVuZGVmaW5lZCkgJiYgKGNoZWNrZWQoXCJ3YWtlLWJhcmdlXCIpIHx8IHNpZ25hbGluZyA9PT0gXCJlY2hvXCIpKSB7XG4gICAgICBjb25maWcubWljID0geyBnYWluRGI6IDAsIC4uLihnaXZlbk1pYyA/PyB7fSksIHdoaWxlU3BlYWtpbmc6IFwid2FrZVwiIH07XG4gICAgfVxuICB9XG4gIHJldHVybiBjb25maWc7XG59XG5cbi8qKiBTdGFydHMgYSB2b2ljZSBjYWxsLCBvciB3aXRoIFt0eXBlZF0gYSBjaGF0ICh0aGUgY29yZSdzIG1lZGl1bSBcInRleHRcIjogbm8gYXVkaW8sIGEgdGV4dCBtb2RlbCkuICovXG5hc3luYyBmdW5jdGlvbiBzdGFydChjYXJyeU9uID0gZmFsc2UsIHR5cGVkID0gZmFsc2UpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgaWYgKHN0YXJ0aW5nQ2FsbCB8fCBjYWxsSWQpIHJldHVybiBmYWxzZTtcbiAgc3RhcnRpbmdDYWxsID0gdHJ1ZTtcbiAgdHJ5IHtcbiAgICBhd2FpdCBlbmRpbmc7XG4gICAgaWYgKGNhbGxJZCkgcmV0dXJuIGZhbHNlO1xuICAgIGxldCBnaXZlbjogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgdHJ5IHtcbiAgICAgIGdpdmVuID0gcmVhZENvbmZpZygpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgdG9hc3QoYFRoZSBkZXZlbG9wZXIgc2V0dGluZ3MgYXJlbid0IHZhbGlkIEpTT046ICR7KGVyciBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgaWYgKHR5cGVkKSB7XG4gICAgICBpZiAoIXNlcnZlci50ZXh0TW9kZWwpIHsgdG9hc3QoXCJUaGlzIHNlcnZlciBoYXMgbm8gdGV4dCBtb2RlbCBmb3IgYSBjaGF0OiBzdGFydCBhIGNhbGwgdG8gdHlwZSB0byBpdFwiKTsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICBnaXZlbiA9IHsgLi4uZ2l2ZW4sIG1lZGl1bTogXCJ0ZXh0XCIsIG11dGVkOiBmYWxzZSB9O1xuICAgICAgZGVsZXRlIGdpdmVuLmNhcHRpb25zO1xuICAgIH1cbiAgICAkPEhUTUxCdXR0b25FbGVtZW50PihcImNhbGxcIikuZGlzYWJsZWQgPSB0cnVlO1xuICAgICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiaGVyby1jYWxsXCIpLmRpc2FibGVkID0gdHJ1ZTtcbiAgICBpZiAoXCJOb3RpZmljYXRpb25cIiBpbiB3aW5kb3cgJiYgTm90aWZpY2F0aW9uLnBlcm1pc3Npb24gPT09IFwiZGVmYXVsdFwiKSB2b2lkIE5vdGlmaWNhdGlvbi5yZXF1ZXN0UGVybWlzc2lvbigpLmNhdGNoKCgpID0+IHt9KTtcbiAgICBsZXQgbG9hZGVkQ29yZTogQ29yZTtcbiAgICB0cnkge1xuICAgICAgaWYgKCF0eXBlZCkgYXdhaXQgYXVkaW8ub3BlbigpO1xuICAgICAgbG9hZGVkQ29yZSA9IGF3YWl0IGxvYWRDb3JlKCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiY2FsbFwiKS5kaXNhYmxlZCA9IGZhbHNlO1xuICAgICAgJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJoZXJvLWNhbGxcIikuZGlzYWJsZWQgPSBmYWxzZTtcbiAgICB9XG4gICAgaWYgKGNhbGxJZCkgcmV0dXJuIGZhbHNlO1xuICAgIGNvcmUgPSBsb2FkZWRDb3JlO1xuICAgIGlmICh0eXBlZCkge1xuICAgICAgd2FrZVN0YXJ0aW5nID0gZmFsc2U7XG4gICAgICBvcGVuaW5nQ2h1bmtzID0gW107XG4gICAgICBvcGVuaW5nQnl0ZXMgPSAwO1xuICAgICAgaWYgKHdha2VBcm1lZCkgYXVkaW8uc3RvcE1pYygpO1xuICAgIH1cbiAgICBtZWRpdW0gPSB0eXBlZCA/IFwidGV4dFwiIDogXCJ2b2ljZVwiO1xuICAgIHRoaW5raW5nID0gZmFsc2U7XG4gICAgJChcInZlcnNpb25cIikudGV4dENvbnRlbnQgPSBjb3JlLnZlcnNpb247XG4gICAgJChcImxvZ1wiKS5pbm5lckhUTUwgPSBcIlwiO1xuICAgIGlmICghdHlwZWQgJiYgKHRhc2tzLnNpemUgPiAwIHx8ICQoXCJ0cmFuc2NyaXB0XCIpLmNoaWxkRWxlbWVudENvdW50ID4gMSkpIG5vdGUoYE5ldyBjYWxsIFx1MDBCNyAke25ldyBEYXRlKCkudG9Mb2NhbGVUaW1lU3RyaW5nKCl9YCk7XG4gICAgc2Nyb2xsRG93bih0cnVlKTtcbiAgICB0YXNrcy5jbGVhcigpO1xuICAgIGFjdGl2ZVNlc3Npb24gPSArK3Nlc3Npb25TZXE7XG4gICAgc2hvd1Rhc2tzKCk7XG4gICAgY291bnRzID0geyBtaWM6IDAsIHBsYXk6IDAsIHNlbnQ6IDAgfTtcbiAgICBtZXRyaWNzLnJlcGx5ID0gW107XG4gICAgc3RhcnRlZEF0ID0gbm93KCk7XG4gICAgbXV0ZWQgPSBnaXZlbi5tdXRlZCA9PT0gdHJ1ZTtcbiAgICBjb25zdCBtaWNDZmcgPSBnaXZlbi5taWMgJiYgdHlwZW9mIGdpdmVuLm1pYyA9PT0gXCJvYmplY3RcIiA/IChnaXZlbi5taWMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIDogbnVsbDtcbiAgICBjb25zdCBsaW1pdHNDZmcgPSBnaXZlbi5saW1pdHMgJiYgdHlwZW9mIGdpdmVuLmxpbWl0cyA9PT0gXCJvYmplY3RcIiA/IChnaXZlbi5saW1pdHMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIDogbnVsbDtcbiAgICBjb25zdCBhbm5vdW5jZUNmZyA9IGdpdmVuLmFubm91bmNlICYmIHR5cGVvZiBnaXZlbi5hbm5vdW5jZSA9PT0gXCJvYmplY3RcIiA/IChnaXZlbi5hbm5vdW5jZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgOiBudWxsO1xuICAgIHdha2VHYXRlLnJlc2V0KHR5cGVvZiBtaWNDZmc/LndoaWxlU3BlYWtpbmcgPT09IFwic3RyaW5nXCIgPyBtaWNDZmcud2hpbGVTcGVha2luZyA6IFwic2VuZFwiLCB3YWtlQ2xpZW50Lmxhc3RTZXEsIHtcbiAgICAgIGRlbGl2ZXJNYXg6IHR5cGVvZiBsaW1pdHNDZmc/LmRlbGl2ZXJNYXggPT09IFwibnVtYmVyXCIgPyBsaW1pdHNDZmcuZGVsaXZlck1heCA6IDMwLFxuICAgICAgYnJpZWZXYWl0OiB0eXBlb2YgYW5ub3VuY2VDZmc/LmJyaWVmV2FpdCA9PT0gXCJudW1iZXJcIiA/IGFubm91bmNlQ2ZnLmJyaWVmV2FpdCA6IDMsXG4gICAgfSk7XG4gICAgd2FrZVBlcmlvZENhbGxJZCA9IG51bGw7XG4gICAgd2FrZUNsaWVudC5yZXNldCgpO1xuICAgIC8vIENhcnJ5aW5nIG9uOiB0aGUgbW9kZWwgZ2V0cyB0aGUgbGFzdCBjb252ZXJzYXRpb24gYXMgYSByZWNhcC4gVGhlIGNvcmUgY2FwcyBpdCwgbGF0ZXN0IGxpbmVzIGZpcnN0LlxuICAgIC8vIEEgY2hhdCBhbHdheXMgY2FycmllcyBvbiBmcm9tIHdoYXQncyBvbiB0aGUgc2NyZWVuIChhbiBlYXJsaWVyIGNhbGwgb3IgY2hhdCBvbiB0aGlzIHBhZ2UpLlxuICAgIGlmICh0eXBlZCkgeyBpZiAoY2hhdC5sZW5ndGggPiAwICYmIGdpdmVuLmhpc3RvcnkgPT09IHVuZGVmaW5lZCkgZ2l2ZW4uaGlzdG9yeSA9IGNoYXQ7IH1cbiAgICBlbHNlIGlmIChjYXJyeU9uICYmIGdpdmVuLmhpc3RvcnkgPT09IHVuZGVmaW5lZCkgZ2l2ZW4uaGlzdG9yeSA9IHNhdmVkSGlzdG9yeSgpO1xuICAgIGVsc2UgaWYgKCFjYXJyeU9uKSBjaGF0ID0gW107XG4gICAgaWYgKGNhcnJ5T24gJiYgIXR5cGVkKSBjaGF0ID0gc2F2ZWRIaXN0b3J5KCk7XG4gICAgbGFzdExpbmUgPSBudWxsO1xuICAgIG9wZW5MaW5lID0gbnVsbDtcbiAgICBzeW5jUmVzdW1lQnV0dG9ucyhmYWxzZSk7XG4gICAgY2FsbE5hbWUgPSBgJHtuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkucmVwbGFjZSgvWzouXS9nLCBcIi1cIil9LSR7dHlwZWQgPyBcImNoYXRcIiA6IFwid2ViXCJ9LSR7Y29yZS52ZXJzaW9ufWA7XG4gICAgY29uc3QgY3JlYXRlZCA9IEpTT04ucGFyc2UoY29yZS5jcmVhdGUoSlNPTi5zdHJpbmdpZnkoZ2l2ZW4pLCBub3coKSkpO1xuICAgIGNhbGxJZCA9IGNyZWF0ZWQuaWQ7XG4gICAgaWYgKCF0eXBlZCkge1xuICAgICAgc2V0Q2FsbEJ1dHRvbih0cnVlKTtcbiAgICAgICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwibWljXCIpLmRpc2FibGVkID0gZmFsc2U7XG4gICAgfVxuICAgICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiaHVzaFwiKS5kaXNhYmxlZCA9IGZhbHNlO1xuICAgICQoXCJtaWNcIikuY2xhc3NMaXN0LnRvZ2dsZShcIm11dGVkXCIsIG11dGVkKTtcbiAgICBydW4oY3JlYXRlZC5jb21tYW5kcyk7XG4gICAgc2hvd1N0YXR1cygpO1xuICAgIHRpY2tlciA9IHdpbmRvdy5zZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgICBwdXNoKHsgdHlwZTogXCJ0aWNrXCIgfSk7XG4gICAgICBjb25zdCBsZXZlbCA9IG11dGVkICYmICFob2xkaW5nID8gMCA6IGF1ZGlvLmxldmVsO1xuICAgICAgY29uc3Qgc3RyZW5ndGggPSBNYXRoLm1pbigxLCBsZXZlbCAqIDEyKTtcbiAgICAgICQoXCJyaW5nXCIpLnN0eWxlLm9wYWNpdHkgPSBTdHJpbmcoc3RyZW5ndGgpO1xuICAgICAgJChcInJpbmdcIikuc3R5bGUudHJhbnNmb3JtID0gYHNjYWxlKCR7KDEgKyBzdHJlbmd0aCAqIDAuMTIpLnRvRml4ZWQoMyl9KWA7XG4gICAgICAkKFwiY291bnRzXCIpLnRleHRDb250ZW50ID0gYG1pYyAke2NvdW50cy5taWN9IFx1MDBCNyBzZW50ICR7Y291bnRzLnNlbnR9IFx1MDBCNyBwbGF5ZWQgJHtjb3VudHMucGxheX0gXHUwMEI3IHF1ZXVlZCAke2F1ZGlvLnF1ZXVlZC50b0ZpeGVkKDEpfSBzYDtcbiAgICAgIHNob3dTdGF0dXMoKTtcbiAgICB9LCAxMDApO1xuICAgIHRyYWNlVGltZXIgPSB3aW5kb3cuc2V0SW50ZXJ2YWwoKCkgPT4geyB2b2lkIHNhdmVUcmFjZSgpOyB2b2lkIHBpbmcoKTsgc2hvd1Rhc2tzKCk7IH0sIDUwMDApO1xuICAgIHZvaWQgcGluZygpO1xuICAgIGlmICghdHlwZWQpIHtcbiAgICAgIHN0b3BXb3Jkcy5zdGFydCgpO1xuICAgICAgYXdhaXQgYWNxdWlyZVdha2VMb2NrKCk7XG4gICAgfVxuICAgIHJldHVybiB0cnVlO1xuICB9IGZpbmFsbHkge1xuICAgIHN0YXJ0aW5nQ2FsbCA9IGZhbHNlO1xuICB9XG59XG5cbi8qKiBUaGUgQ2FsbCBidXR0b246IGhhbmdzIHVwIGEgY2FsbDsgc3RhcnRzIG9uZTsgb3IsIHdpdGggYSBjaGF0IG9uLCBlbmRzIHRoZSBjaGF0IGFuZCBjYXJyaWVzIGl0cyBjb252ZXJzYXRpb24gb24gYnkgdm9pY2UuICovXG5hc3luYyBmdW5jdGlvbiBjYWxsQnV0dG9uKCkge1xuICBpZiAoY2FsbElkICYmIG1lZGl1bSA9PT0gXCJ2b2ljZVwiKSB7IGhhbmdVcCgpOyByZXR1cm47IH1cbiAgaWYgKGNhbGxJZCkge1xuICAgIC8vIEEgY2FsbCBjYW4ndCB0YWtlIG92ZXIgdGhlIGNoYXQncyB0YXNrcywgYW5kIGVuZGluZyB0aGUgY2hhdCB3b3VsZCBzdG9wIHRoZW0uXG4gICAgaWYgKFsuLi50YXNrcy52YWx1ZXMoKV0uc29tZSgodikgPT4gdi5jLnN0YXRlID09PSBcInJ1bm5pbmdcIikpIHsgdG9hc3QoXCJUaGUgY2hhdCdzIHRhc2tzIGFyZSBzdGlsbCBydW5uaW5nOiB3YWl0IGZvciB0aGVtIG9yIGNhbmNlbCB0aGVtLCB0aGVuIGNhbGxcIik7IHJldHVybjsgfVxuICAgIHB1c2goeyB0eXBlOiBcInN0b3BcIiB9KTtcbiAgICBhd2FpdCBzdGFydCh0cnVlKTtcbiAgICByZXR1cm47XG4gIH1cbiAgYXdhaXQgc3RhcnQoKTtcbn1cblxuZnVuY3Rpb24gaGFuZ1VwKCkge1xuICBpZiAoY2FsbElkKSBwdXNoKHsgdHlwZTogXCJzdG9wXCIsIG1lc3NhZ2U6IFwiWW91IGh1bmcgdXAuXCIgfSk7XG59XG5cbmZ1bmN0aW9uIGVuZCgpIHtcbiAgd2luZG93LmNsZWFySW50ZXJ2YWwodGlja2VyKTtcbiAgd2luZG93LmNsZWFySW50ZXJ2YWwodHJhY2VUaW1lcik7XG4gIHN0b3BXb3Jkcy5zdG9wKCk7XG4gIGFjdGl2ZVNlc3Npb24gPSAwO1xuICBzeW5jUmVzdWx0Rm9sbG93VXBCdXR0b25zKCk7XG4gIGNvcmVXYW50c1dha2UgPSBmYWxzZTtcbiAgd2FrZUdhdGUucmVzZXQoXCJzZW5kXCIsIHdha2VDbGllbnQubGFzdFNlcSk7XG4gIHdha2VQZXJpb2RDYWxsSWQgPSB3YWtlQXJtZWQgPyAwIDogbnVsbDtcbiAgd2FrZVN0YXJ0aW5nID0gZmFsc2U7XG4gIG9wZW5pbmdDaHVua3MgPSBbXTtcbiAgb3BlbmluZ0J5dGVzID0gMDtcbiAgY29uc3QgZmluaXNoZWRJZCA9IGNhbGxJZDtcbiAgY29uc3QgZmluaXNoZWRDb3JlID0gY29yZTtcbiAgY2FsbElkID0gMDtcbiAgZW5kaW5nID0gc2F2ZVRyYWNlKGZpbmlzaGVkSWQsIGZpbmlzaGVkQ29yZSkudGhlbigoKSA9PiB7IGlmIChmaW5pc2hlZENvcmUgJiYgZmluaXNoZWRJZCkgZmluaXNoZWRDb3JlLmRpc3Bvc2UoZmluaXNoZWRJZCk7IHNob3dUYXNrcygpOyBzeW5jV2FrZVVpKCk7IH0pO1xuICBpZiAod2FrZUFybWVkKSB7XG4gICAgYXVkaW8uc3RvcFBsYXliYWNrKCk7XG4gICAgd2FrZUNsaWVudC5yZXNldCgpO1xuICAgIHZvaWQgYXVkaW8uZW5zdXJlTWljKG9uTWljLCBtaWNPcHRpb25zKCkpLmNhdGNoKChlcnIpID0+IHtcbiAgICAgIGxvZyhcImVycm9yXCIsIGB3YWtlIG1pY3JvcGhvbmU6ICR7ZXJyLm1lc3NhZ2V9YCwgXCJlcnJcIik7XG4gICAgICB0b2FzdChgV2FrZSBtaWNyb3Bob25lOiAke2Vyci5tZXNzYWdlfWApO1xuICAgICAgdm9pZCBhcm1XYWtlKGZhbHNlKTtcbiAgICB9KTtcbiAgfSBlbHNlIHtcbiAgICBhdWRpby5zdG9wKCk7XG4gICAgcmVsZWFzZVdha2VMb2NrKCk7XG4gIH1cbiAgZm9yIChjb25zdCB3cyBvZiBzb2NrZXRzLnZhbHVlcygpKSB3cy5jbG9zZSgpO1xuICBzb2NrZXRzLmNsZWFyKCk7XG4gIGZvciAoY29uc3QgciBvZiBydW5zLnZhbHVlcygpKSByLmFib3J0LmFib3J0KCk7XG4gIHJ1bnMuY2xlYXIoKTtcbiAgZm9yIChjb25zdCByIG9mIHJlcXVlc3RzLnZhbHVlcygpKSByLmFib3J0KCk7XG4gIHJlcXVlc3RzLmNsZWFyKCk7XG4gIHRoaW5raW5nID0gZmFsc2U7XG4gIHNldENhbGxCdXR0b24oZmFsc2UpO1xuICBmb3IgKGNvbnN0IGlkIG9mIFtcIm1pY1wiLCBcImh1c2hcIl0pICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KGlkKS5kaXNhYmxlZCA9IHRydWU7XG4gICQoXCJyaW5nXCIpLnN0eWxlLm9wYWNpdHkgPSBcIjBcIjtcbiAgJChcInJpbmdcIikuc3R5bGUudHJhbnNmb3JtID0gXCJcIjtcbiAgJChcImNhbGxiYXJcIikuaGlkZGVuID0gdHJ1ZTtcbiAgJChcIm1pY3dhcm5cIikuaGlkZGVuID0gdHJ1ZTtcbiAgZG9jdW1lbnQuYm9keS5kYXRhc2V0LnN0YXRlID0gd2FrZUFybWVkID8gXCJhcm1lZFwiIDogXCJpZGxlXCI7XG4gIGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LnJlbW92ZShcImluLXNlc3Npb25cIik7XG4gIHN5bmNSZXN1bWVCdXR0b25zKGNoYXQubGVuZ3RoID4gMCk7XG4gIHZvaWQgc2hvd0VhcmxpZXIoKTtcbiAgc3luY1dha2VVaSgpO1xufVxuXG5mdW5jdGlvbiBzZXRNdXRlZCh2YWx1ZTogYm9vbGVhbikge1xuICBpZiAoIWNhbGxJZCB8fCBtdXRlZCA9PT0gdmFsdWUpIHJldHVybjtcbiAgbXV0ZWQgPSB2YWx1ZTtcbiAgaWYgKG11dGVkKSB7XG4gICAgZmx1c2hEZWZlcnJlZE1pYygpO1xuICAgIHdha2VDbGllbnQucmVzZXQoKTtcbiAgfVxuICAkKFwibWljXCIpLmNsYXNzTGlzdC50b2dnbGUoXCJtdXRlZFwiLCBtdXRlZCk7XG4gIHB1c2goeyB0eXBlOiBtdXRlZCA/IFwibXV0ZVwiIDogXCJ1bm11dGVcIiB9KTtcbiAgc2hvd1N0YXR1cygpO1xufVxuXG4vKiogU2VuZHMgd2hhdCB0aGUgdHJhY2Uga2VwdCBzaW5jZSBsYXN0IHRpbWUgdG8gdGhlIGRldiBzZXJ2ZXIsIGFzIEpTT04gbGluZXM6IGEgaGVhZGVyLCB0aGVuIGV2ZW50cy4gKi9cbmFzeW5jIGZ1bmN0aW9uIHNhdmVUcmFjZShpZCA9IGNhbGxJZCwgdGFyZ2V0Q29yZSA9IGNvcmUpIHtcbiAgaWYgKCF0YXJnZXRDb3JlIHx8ICFpZCB8fCAhY2hlY2tlZChcInRyYWNlXCIpKSByZXR1cm47XG4gIGNvbnN0IGtlcHQgPSBKU09OLnBhcnNlKHRhcmdldENvcmUudHJhY2UoaWQpKTtcbiAgaWYgKCFrZXB0KSByZXR1cm47XG4gIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICBpZiAoa2VwdC5jb25maWcpIGxpbmVzLnB1c2goSlNPTi5zdHJpbmdpZnkoeyB2ZXJzaW9uOiBrZXB0LnZlcnNpb24sIGNvbmZpZzoga2VwdC5jb25maWcsIHN0YXJ0OiBrZXB0LnN0YXJ0IH0pKTtcbiAgZm9yIChjb25zdCBlIG9mIGtlcHQuZXZlbnRzKSBsaW5lcy5wdXNoKEpTT04uc3RyaW5naWZ5KGUpKTtcbiAgaWYgKGxpbmVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuICBhd2FpdCBmZXRjaChgL3RyYWNlcz9uYW1lPSR7ZW5jb2RlVVJJQ29tcG9uZW50KGNhbGxOYW1lKX0uanNvbmxgLCB7IG1ldGhvZDogXCJQT1NUXCIsIGJvZHk6IGxpbmVzLmpvaW4oXCJcXG5cIikgKyBcIlxcblwiIH0pLmNhdGNoKCgpID0+IHt9KTtcbiAgJChcInRyYWNlbmFtZVwiKS50ZXh0Q29udGVudCA9IGB0cmFjZSAke2NhbGxOYW1lfS5qc29ubGA7XG59XG5cbi8vIFwiU3RvcFwiIGFuZCBcImdvb2RieWVcIiBoZWFyZCBieSB0aGUgYnJvd3NlcidzIG93biByZWNvZ25pemVyOiBxdWlja2VyIHRoYW4gdGhlIG1vZGVsJ3MgdHJhbnNjcmlwdCxcbi8vIGFuZCBpdCB3b3JrcyB3aGlsZSB0aGUgbW9kZWwncyByZXBseSBwbGF5cyBldmVuIHdoZW4gdGhlIG1vZGVsIGlzbid0IGhlYXJpbmcgdGhlIG1pY3JvcGhvbmUuXG5cbmNsYXNzIFN0b3BXb3JkcyB7XG4gIHByaXZhdGUgcmVjOiBhbnkgPSBudWxsO1xuICBwcml2YXRlIG9uID0gZmFsc2U7XG4gIHByaXZhdGUgY29tbWFuZHMgPSB7IHN0b3A6IFtdIGFzIHN0cmluZ1tdLCBoYW5nVXA6IFtdIGFzIHN0cmluZ1tdLCBjYW5jZWxBbGw6IFtdIGFzIHN0cmluZ1tdIH07XG5cbiAgZ2V0IHN1cHBvcnRlZCgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gXCJ3ZWJraXRTcGVlY2hSZWNvZ25pdGlvblwiIGluIHdpbmRvdyB8fCBcIlNwZWVjaFJlY29nbml0aW9uXCIgaW4gd2luZG93O1xuICB9XG5cbiAgc3RhcnQoKSB7XG4gICAgaWYgKCFjaGVja2VkKFwic3RvcHdvcmRcIikgfHwgIXRoaXMuc3VwcG9ydGVkIHx8ICFjb3JlKSByZXR1cm47XG4gICAgdGhpcy5jb21tYW5kcyA9IEpTT04ucGFyc2UoY29yZS5kZWZhdWx0cygpKS52b2ljZUNvbW1hbmRzO1xuICAgIGNvbnN0IFJlY29nbml0aW9uID0gKHdpbmRvdyBhcyBhbnkpLlNwZWVjaFJlY29nbml0aW9uID8/ICh3aW5kb3cgYXMgYW55KS53ZWJraXRTcGVlY2hSZWNvZ25pdGlvbjtcbiAgICB0aGlzLnJlYyA9IG5ldyBSZWNvZ25pdGlvbigpO1xuICAgIHRoaXMucmVjLmNvbnRpbnVvdXMgPSB0cnVlO1xuICAgIHRoaXMucmVjLmludGVyaW1SZXN1bHRzID0gdHJ1ZTtcbiAgICB0aGlzLnJlYy5sYW5nID0gbmF2aWdhdG9yLmxhbmd1YWdlIHx8IFwiZW4tR0JcIjtcbiAgICB0aGlzLnJlYy5vbnJlc3VsdCA9IChlOiBhbnkpID0+IHtcbiAgICAgIGZvciAobGV0IGkgPSBlLnJlc3VsdEluZGV4OyBpIDwgZS5yZXN1bHRzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIGNvbnN0IHRleHQgPSBlLnJlc3VsdHNbaV1bMF0udHJhbnNjcmlwdCBhcyBzdHJpbmc7XG4gICAgICAgIGNvbnN0IGNvbW1hbmQgPSBjb21tYW5kSW4odGV4dCwgdGhpcy5jb21tYW5kcywgW1wiV29vZGhvdXNlXCIsIFwiSGVybWVzXCIsIFwiQmVudG9cIl0pO1xuICAgICAgICBpZiAoY29tbWFuZCA9PT0gXCJzdG9wXCIgJiYgYXVkaW8ucXVldWVkID4gMC4wNSkge1xuICAgICAgICAgIGxvZyhcIm91dFwiLCBgbG9jYWwgc3RvcCB3b3JkOiAke3RleHR9YCwgXCJvdXRcIik7XG4gICAgICAgICAgdG9hc3QoYEhlYXJkIFx1MjAxQyR7dGV4dC50cmltKCl9XHUyMDFEOiBzdG9wcGVkYCk7XG4gICAgICAgICAgcHVzaCh7IHR5cGU6IFwiaW50ZXJydXB0XCIgfSk7XG4gICAgICAgIH0gZWxzZSBpZiAoY29tbWFuZCA9PT0gXCJjYW5jZWxBbGxcIiAmJiBlLnJlc3VsdHNbaV0uaXNGaW5hbCkge1xuICAgICAgICAgIGxvZyhcIm91dFwiLCBgbG9jYWwgY2FuY2VsLWFsbDogJHt0ZXh0fWAsIFwib3V0XCIpO1xuICAgICAgICAgIHB1c2goeyB0eXBlOiBcImNhbmNlbEFsbFwiIH0pO1xuICAgICAgICAgIHB1c2goeyB0eXBlOiBcImludGVycnVwdFwiIH0pO1xuICAgICAgICB9IGVsc2UgaWYgKGNvbW1hbmQgPT09IFwiaGFuZ1VwXCIgJiYgZS5yZXN1bHRzW2ldLmlzRmluYWwpIHtcbiAgICAgICAgICBsb2coXCJvdXRcIiwgYGxvY2FsIGhhbmctdXA6ICR7dGV4dH1gLCBcIm91dFwiKTtcbiAgICAgICAgICBoYW5nVXAoKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH07XG4gICAgdGhpcy5yZWMub25lbmQgPSAoKSA9PiB7IGlmICh0aGlzLm9uKSBzZXRUaW1lb3V0KCgpID0+IHsgdHJ5IHsgdGhpcy5yZWM/LnN0YXJ0KCk7IH0gY2F0Y2gge30gfSwgMjUwKTsgfTtcbiAgICB0aGlzLnJlYy5vbmVycm9yID0gKGU6IGFueSkgPT4geyBpZiAoZS5lcnJvciA9PT0gXCJub3QtYWxsb3dlZFwiKSB0aGlzLm9uID0gZmFsc2U7IH07XG4gICAgdGhpcy5vbiA9IHRydWU7XG4gICAgdHJ5IHsgdGhpcy5yZWMuc3RhcnQoKTsgfSBjYXRjaCB7fVxuICB9XG5cbiAgc3RvcCgpIHtcbiAgICB0aGlzLm9uID0gZmFsc2U7XG4gICAgdHJ5IHsgdGhpcy5yZWM/LnN0b3AoKTsgfSBjYXRjaCB7fVxuICAgIHRoaXMucmVjID0gbnVsbDtcbiAgfVxufVxuY29uc3Qgc3RvcFdvcmRzID0gbmV3IFN0b3BXb3JkcygpO1xuXG4vLyBMb2NhbCB3YWtlIHdvcmQgbG9vcCAoTGl2ZUtpdCBXYWtlV29yZCBPTk5YIGluIGEgV2ViIFdvcmtlcik6IGxpc3RlbnMgYmV0d2VlbiBjYWxscyB3aGVuIGFybWVkLFxuLy8gYW5kIGluc2lkZSBhbiBhY3RpdmUgY2FsbCB3aGVuZXZlciB0aGUgY29yZSBhc2tzIChgd2FrZXdvcmQ6IG9uYDogZG9ybWFudCBvciB3aGlsZVNwZWFraW5nIFwid2FrZVwiKS5cblxuYXN5bmMgZnVuY3Rpb24gYWNxdWlyZVdha2VMb2NrKCkge1xuICBhd2FpdCBzY3JlZW5XYWtlTG9jay5hY3F1aXJlKCgpID0+ICFkb2N1bWVudC5oaWRkZW4gJiYgKGNhbGxJZCAhPT0gMCB8fCB3YWtlQXJtZWQpKTtcbn1cblxuZnVuY3Rpb24gcmVsZWFzZVdha2VMb2NrKCkge1xuICBzY3JlZW5XYWtlTG9jay5yZWxlYXNlKCk7XG59XG5cbmZ1bmN0aW9uIHNlbGVjdGVkV2FrZU1vZGVsKCk6IFdha2VNb2RlbEluZm8gfCBudWxsIHtcbiAgY29uc3QgbW9kZWxzID0gc2VydmVyPy53YWtlTW9kZWxzID8/IFtdO1xuICBpZiAobW9kZWxzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHBpY2sgPSAkPEhUTUxTZWxlY3RFbGVtZW50PihcIndha2UtbW9kZWxcIikudmFsdWU7XG4gIHJldHVybiBtb2RlbHMuZmluZCgobSkgPT4gbS5pZCA9PT0gcGljaykgPz8gbW9kZWxzLmZpbmQoKG0pID0+IG0uaWQgPT09IFwicGVubnl3b3J0aFwiKSA/PyBtb2RlbHNbMF07XG59XG5cbmZ1bmN0aW9uIHdha2VUaHJlc2hvbGQoKTogbnVtYmVyIHtcbiAgY29uc3QgbiA9IE51bWJlcigkPEhUTUxJbnB1dEVsZW1lbnQ+KFwid2FrZS10aHJlc2hvbGRcIikudmFsdWUpO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pID8gTWF0aC5tYXgoMC4xLCBNYXRoLm1pbigwLjk5LCBuKSkgOiAwLjc7XG59XG5cbmZ1bmN0aW9uIHNob3VsZEZlZWRXYWtlKCk6IGJvb2xlYW4ge1xuICBpZiAod2FrZVN0YXJ0aW5nIHx8IHN0YXJ0aW5nQ2FsbCkgcmV0dXJuIGZhbHNlO1xuICBpZiAoY2FsbElkID09PSAwKSByZXR1cm4gd2FrZUFybWVkO1xuICByZXR1cm4gbWVkaXVtID09PSBcInZvaWNlXCIgJiYgY29yZVdhbnRzV2FrZSAmJiAhKG11dGVkICYmICFob2xkaW5nKTtcbn1cblxuLyoqXG4gKiBXaGV0aGVyIGEgd2FrZSBkZXRlY3Rpb24gcmV0dXJuaW5nIGFzeW5jaHJvbm91c2x5IGZyb20gdGhlIHdvcmtlciBzdGlsbCBiZWxvbmdzIHRvIHRoZSBhY3RpdmVcbiAqIGxpc3RlbmluZyBwZXJpb2QuIFVubGlrZSBgc2hvdWxkRmVlZFdha2UoKWAsIHRoaXMgc3RheXMgdHJ1ZSBmb3IgYW4gYWN0aXZlIHZvaWNlIGNhbGwgZXZlbiBpZlxuICogYGNvcmVXYW50c1dha2VgIGp1c3QgZmxpcHBlZCBvZmYgYXMgcGxheWJhY2sgZW5kZWQgd2hpbGUgdGhlIHdvcmtlciB3YXMgc2NvcmluZyB0aGUgbGFzdCBmcmFtZS5cbiAqL1xuZnVuY3Rpb24gY2FuQWNjZXB0V2FrZUhpdCgpOiBib29sZWFuIHtcbiAgaWYgKHdha2VTdGFydGluZyB8fCBzdGFydGluZ0NhbGwpIHJldHVybiBmYWxzZTtcbiAgaWYgKGNhbGxJZCA9PT0gMCkgcmV0dXJuIHdha2VBcm1lZCAmJiB3YWtlUGVyaW9kQ2FsbElkID09PSAwO1xuICByZXR1cm4gbWVkaXVtID09PSBcInZvaWNlXCIgJiYgIShtdXRlZCAmJiAhaG9sZGluZykgJiYgd2FrZVBlcmlvZENhbGxJZCA9PT0gY2FsbElkO1xufVxuXG5mdW5jdGlvbiByZW5kZXJXYWtlVGVsZW1ldHJ5KCkge1xuICBjb25zdCBhY3RpdmUgPSAoY2FsbElkID09PSAwICYmIHdha2VBcm1lZCkgfHwgKGNhbGxJZCAhPT0gMCAmJiBtZWRpdW0gPT09IFwidm9pY2VcIiAmJiBjb3JlV2FudHNXYWtlKTtcbiAgaWYgKCFhY3RpdmUpIHsgJChcImhlYXJkXCIpLnRleHRDb250ZW50ID0gXCJcIjsgcmV0dXJuOyB9XG4gIGNvbnN0IGxhYmVsID0gc2VsZWN0ZWRXYWtlTW9kZWwoKT8ubGFiZWwgPz8gXCJ3YWtlIHdvcmRcIjtcbiAgaWYgKHdha2VMb2FkaW5nKSB7ICQoXCJoZWFyZFwiKS50ZXh0Q29udGVudCA9IGBMb2FkaW5nIHdha2Ugd29yZCBcdTIwMUMke2xhYmVsfVx1MjAxRFx1MjAyNmA7IHJldHVybjsgfVxuICBpZiAoY2FsbElkID09PSAwICYmIGF1ZGlvLmF1ZGlvU3VzcGVuZGVkKSB7ICQoXCJoZWFyZFwiKS50ZXh0Q29udGVudCA9IGBBdWRpbyBwYXVzZWQgYnkgYnJvd3NlciBcdTAwQjcgdGFwIG9yIHByZXNzIGEga2V5IHRvIHJlc3VtZSBcdTIwMUMke2xhYmVsfVx1MjAxRGA7IHJldHVybjsgfVxuICBpZiAoIXdha2VMYXN0VGVsKSB7ICQoXCJoZWFyZFwiKS50ZXh0Q29udGVudCA9IGBXYWtlIFx1MjAxQyR7bGFiZWx9XHUyMDFEIHJlYWR5ICh0aHJlc2hvbGQgJHt3YWtlVGhyZXNob2xkKCkudG9GaXhlZCgyKX0pYDsgcmV0dXJuOyB9XG4gIGNvbnN0IHN0YXRlID0gd2FrZUxhc3RUZWwuZ2F0ZU9wZW4gPyBgc2NvcmluZyAke3dha2VMYXN0VGVsLnNjb3JlLnRvRml4ZWQoMil9YCA6IFwicXVpZXRcIjtcbiAgY29uc3Qgc3BlZWQgPSB3YWtlTGFzdFRlbC5pbmZlck1zID4gMCA/IGAgXHUwMEI3ICR7d2FrZUxhc3RUZWwuaW5mZXJNcy50b0ZpeGVkKDEpfSBtc2AgOiBcIlwiO1xuICAkKFwiaGVhcmRcIikudGV4dENvbnRlbnQgPSBgV2FrZSBcdTIwMUMke2xhYmVsfVx1MjAxRCBcdTAwQjcgJHtzdGF0ZX0gXHUwMEI3IHBlYWsgJHt3YWtlTGFzdFRlbC5wZWFrLnRvRml4ZWQoMil9JHtzcGVlZH1gO1xufVxuXG5mdW5jdGlvbiBzeW5jV2FrZVVpKCkge1xuICBjb25zdCBtb2RlbCA9IHNlbGVjdGVkV2FrZU1vZGVsKCk7XG4gIGNvbnN0IGhhc01vZGVscyA9IG1vZGVsICE9IG51bGw7XG4gIGNvbnN0IGxhYmVsID0gbW9kZWw/LmxhYmVsID8/IFwid2FrZSB3b3JkXCI7XG4gIGNvbnN0IGJ0biA9ICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwid2FrZWJ0blwiKTtcbiAgYnRuLmhpZGRlbiA9ICFoYXNNb2RlbHM7XG4gIGJ0bi5jbGFzc0xpc3QudG9nZ2xlKFwib25cIiwgd2FrZUFybWVkKTtcbiAgYnRuLmNsYXNzTGlzdC50b2dnbGUoXCJsb2FkaW5nXCIsIHdha2VMb2FkaW5nICYmICh3YWtlQXJtZWQgfHwgY29yZVdhbnRzV2FrZSkpO1xuICBidG4uc2V0QXR0cmlidXRlKFwiYXJpYS1wcmVzc2VkXCIsIFN0cmluZyh3YWtlQXJtZWQpKTtcbiAgYnRuLnRpdGxlID0gd2FrZUFybWVkID8gYFN0b3Agd2FrZSB3b3JkIFx1MjAxQyR7bGFiZWx9XHUyMDFEIChXKWAgOiBgTGlzdGVuIGZvciBcdTIwMUMke2xhYmVsfVx1MjAxRCAoVylgO1xuICBjb25zdCBoZXJvID0gJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJoZXJvLXdha2VcIik7XG4gIGhlcm8uaGlkZGVuID0gIWhhc01vZGVscztcbiAgaGVyby5jbGFzc0xpc3QudG9nZ2xlKFwib25cIiwgd2FrZUFybWVkKTtcbiAgaGVyby50ZXh0Q29udGVudCA9IHdha2VBcm1lZFxuICAgID8gKHdha2VMb2FkaW5nID8gYExvYWRpbmcgXHUyMDFDJHtsYWJlbH1cdTIwMURcdTIwMjZgIDogYXVkaW8uYXVkaW9TdXNwZW5kZWQgPyBgQWN0aXZhdGUgXHUyMDFDJHtsYWJlbH1cdTIwMURgIDogYExpc3RlbmluZyBmb3IgXHUyMDFDJHtsYWJlbH1cdTIwMURgKVxuICAgIDogYExpc3RlbiBmb3IgXHUyMDFDJHtsYWJlbH1cdTIwMURgO1xuICAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwid2FrZS1lbmFibGVkXCIpLmNoZWNrZWQgPSB3YWtlQXJtZWQ7XG4gIHJlbmRlcldha2VUZWxlbWV0cnkoKTtcbiAgc2hvd1N0YXR1cygpO1xufVxuXG5mdW5jdGlvbiBzeW5jU2lnbmFsaW5nVWkoKSB7XG4gIGNvbnN0IG92ID0gZGV2ZWxvcGVyT3ZlcnJpZGVzKCk7XG4gIGNvbnN0IHNpZ25hbGluZ0VsID0gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJzaWduYWxpbmdcIik7XG4gIGNvbnN0IHNpZ25hbGluZyA9IHNpZ25hbGluZ0VsLnZhbHVlO1xuICBjb25zdCBub25XZWIgPSBvdi5ub25XZWJQbGF0Zm9ybSAhPSBudWxsO1xuICBzaWduYWxpbmdFbC5kaXNhYmxlZCA9IG5vbldlYiB8fCBvdi5oYXNBdHRlbnRpb247XG4gIGNvbnN0IHdpbmRvd0NvbnRyb2xzID0gIW5vbldlYiAmJiAhb3YuaGFzQXR0ZW50aW9uICYmIChzaWduYWxpbmcgPT09IFwid2luZG93XCIgfHwgc2lnbmFsaW5nID09PSBcImVjaG9cIik7XG4gIGZvciAoY29uc3QgaWQgb2YgW1wiYXR0bi1hZnRlci13YWtlXCIsIFwiYXR0bi13aW5kb3dcIiwgXCJhdHRuLWFmdGVyLXF1ZXN0aW9uXCJdKSB7XG4gICAgJDxIVE1MSW5wdXRFbGVtZW50PihpZCkuZGlzYWJsZWQgPSAhd2luZG93Q29udHJvbHM7XG4gIH1cbiAgJDxIVE1MSW5wdXRFbGVtZW50PihcImhhbmd1cC1hZnRlclwiKS5kaXNhYmxlZCA9IG5vbldlYiB8fCBvdi5oYXNIYW5nVXA7XG4gIGNvbnN0IGJhcmdlID0gJDxIVE1MSW5wdXRFbGVtZW50PihcIndha2UtYmFyZ2VcIik7XG4gIGlmIChub25XZWIgfHwgb3YuaGFzTWljV2hpbGVTcGVha2luZykge1xuICAgIGJhcmdlLmRpc2FibGVkID0gdHJ1ZTtcbiAgfSBlbHNlIGlmIChzaWduYWxpbmcgPT09IFwiZWNob1wiKSB7XG4gICAgYmFyZ2UuY2hlY2tlZCA9IHRydWU7XG4gICAgYmFyZ2UuZGlzYWJsZWQgPSB0cnVlO1xuICB9IGVsc2Uge1xuICAgIGJhcmdlLmRpc2FibGVkID0gZmFsc2U7XG4gICAgYmFyZ2UuY2hlY2tlZCA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2Uud2FrZS1iYXJnZVwiKSA9PT0gXCIxXCI7XG4gIH1cbiAgY29uc3Qgb3ZlcnJpZGRlbjogc3RyaW5nW10gPSBbXTtcbiAgaWYgKG92Lmhhc0F0dGVudGlvbikgb3ZlcnJpZGRlbi5wdXNoKFwiYXR0ZW50aW9uXCIpO1xuICBpZiAob3YuaGFzSGFuZ1VwKSBvdmVycmlkZGVuLnB1c2goXCJoYW5nVXBBZnRlclwiKTtcbiAgaWYgKG92Lmhhc01pY1doaWxlU3BlYWtpbmcpIG92ZXJyaWRkZW4ucHVzaChcIm1pYy53aGlsZVNwZWFraW5nXCIpO1xuICBjb25zdCBoYXNNb2RlbHMgPSAoc2VydmVyPy53YWtlTW9kZWxzPy5sZW5ndGggPz8gMCkgPiAwO1xuICAkKFwic2lnbmFsaW5nLWhlbHBcIikudGV4dENvbnRlbnQgPSBub25XZWJcbiAgICA/IGBEZXZlbG9wZXIgcHJlc2V0ICgke292Lm5vbldlYlBsYXRmb3JtfSkgY29udHJvbHMgc2lnbmFsaW5nLmBcbiAgICA6IG92ZXJyaWRkZW4ubGVuZ3RoID4gMFxuICAgICAgPyBgRGV2ZWxvcGVyIGNvbmZpZyBzZXRzICR7b3ZlcnJpZGRlbi5qb2luKFwiLCBcIil9LmBcbiAgICAgIDogIWhhc01vZGVscyAmJiBzaWduYWxpbmcgIT09IFwib3BlblwiXG4gICAgICAgID8gXCJObyB3YWtlIG1vZGVscyBvbiBzZXJ2ZXI6IHVzZSB0aGUgV2FrZSBidXR0b24gd2hlbiBkb3JtYW50LlwiXG4gICAgICAgIDogXCJBcHBsaWVkIG9uIHRoZSBuZXh0IGNhbGwgdW5sZXNzIG92ZXJyaWRkZW4gaW4gRGV2ZWxvcGVyIEpTT04uXCI7XG59XG5cbmNvbnN0IHdha2VDbGllbnQgPSBuZXcgV2FrZUNsaWVudCh7XG4gIG9uUmVhZHkobW9kZWxJZCwgd2FybXVwTXMpIHtcbiAgICB3YWtlTG9hZGluZyA9IGZhbHNlO1xuICAgIGxvZyhcIm91dFwiLCBgd2FrZSB3b3JkIHJlYWR5OiAke21vZGVsSWR9JHt3YXJtdXBNcyA+IDAgPyBgICgke3dhcm11cE1zfSBtcylgIDogXCJcIn1gLCBcIm91dFwiKTtcbiAgICBzeW5jV2FrZVVpKCk7XG4gIH0sXG4gIG9uRGV0ZWN0ZWQoaGl0KSB7XG4gICAgb25XYWtlRGV0ZWN0ZWQoaGl0KTtcbiAgfSxcbiAgb25UZWxlbWV0cnkodGVsKSB7XG4gICAgd2FrZUxhc3RUZWwgPSB0ZWw7XG4gICAgcmVuZGVyV2FrZVRlbGVtZXRyeSgpO1xuICB9LFxuICBvblN1cHByZXNzZWRTZXR0bGVkKCkge1xuICAgIGZsdXNoRGVmZXJyZWRNaWMoKTtcbiAgfSxcbiAgb25FcnJvcihtZXNzYWdlKSB7XG4gICAgd2FrZUxvYWRpbmcgPSBmYWxzZTtcbiAgICBmbHVzaERlZmVycmVkTWljKCk7XG4gICAgbG9nKFwiZXJyb3JcIiwgYHdha2Ugd29yZDogJHttZXNzYWdlfWAsIFwiZXJyXCIpO1xuICAgIHRvYXN0KGBXYWtlIHdvcmQgZXJyb3I6ICR7bWVzc2FnZX1gKTtcbiAgICBpZiAod2FrZUFybWVkKSB2b2lkIGFybVdha2UoZmFsc2UpO1xuICAgIGVsc2Ugc3luY1dha2VVaSgpO1xuICB9LFxufSk7XG5cbmFzeW5jIGZ1bmN0aW9uIGFybVdha2Uob246IGJvb2xlYW4sIHBlcnNpc3QgPSB0cnVlKSB7XG4gIGNvbnN0IG1vZGVsID0gc2VsZWN0ZWRXYWtlTW9kZWwoKTtcbiAgaWYgKG9uICYmICFtb2RlbCkge1xuICAgIHRvYXN0KFwiTm8gd2FrZSB3b3JkIG1vZGVscyBmb3VuZCBvbiB0aGUgc2VydmVyXCIpO1xuICAgICQ8SFRNTElucHV0RWxlbWVudD4oXCJ3YWtlLWVuYWJsZWRcIikuY2hlY2tlZCA9IGZhbHNlO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBnZW4gPSArK2FybUdlbjtcbiAgd2FrZUFybWVkID0gb247XG4gIGlmIChwZXJzaXN0KSBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLndha2UtZW5hYmxlZFwiLCBvbiA/IFwiMVwiIDogXCIwXCIpO1xuICBpZiAob24gJiYgbW9kZWwpIHtcbiAgICB3YWtlTGFzdFRlbCA9IG51bGw7XG4gICAgaWYgKCF3YWtlQ2xpZW50LnJlYWR5IHx8IHdha2VDbGllbnQubW9kZWxJZCAhPT0gbW9kZWwuaWQpIHdha2VMb2FkaW5nID0gdHJ1ZTtcbiAgICB3YWtlQ2xpZW50LmxvYWQobW9kZWwuaWQsIHdha2VUaHJlc2hvbGQoKSk7XG4gICAgaWYgKCFjYWxsSWQpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IGF1ZGlvLmVuc3VyZU1pYyhvbk1pYywgbWljT3B0aW9ucygpKTtcbiAgICAgICAgaWYgKGdlbiAhPT0gYXJtR2VuIHx8ICF3YWtlQXJtZWQpIHJldHVybjtcbiAgICAgICAgd2FrZVBlcmlvZENhbGxJZCA9IDA7XG4gICAgICAgIHdha2VDbGllbnQucmVzZXQoKTtcbiAgICAgICAgYXdhaXQgYWNxdWlyZVdha2VMb2NrKCk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgaWYgKGdlbiAhPT0gYXJtR2VuKSByZXR1cm47XG4gICAgICAgIHdha2VBcm1lZCA9IGZhbHNlO1xuICAgICAgICB3YWtlTG9hZGluZyA9IGZhbHNlO1xuICAgICAgICBpZiAoIWNhbGxJZCkge1xuICAgICAgICAgIGF1ZGlvLnN0b3BNaWMoKTtcbiAgICAgICAgICByZWxlYXNlV2FrZUxvY2soKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAocGVyc2lzdCkgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS53YWtlLWVuYWJsZWRcIiwgXCIwXCIpO1xuICAgICAgICB0b2FzdChgTWljcm9waG9uZTogJHsoZXJyIGFzIEVycm9yKS5tZXNzYWdlfWApO1xuICAgICAgICBsb2coXCJlcnJvclwiLCBgd2FrZSBtaWNyb3Bob25lOiAkeyhlcnIgYXMgRXJyb3IpLm1lc3NhZ2V9YCwgXCJlcnJcIik7XG4gICAgICB9XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIHdha2VMb2FkaW5nID0gZmFsc2U7XG4gICAgd2FrZUxhc3RUZWwgPSBudWxsO1xuICAgIGlmICghY2FsbElkKSB7XG4gICAgICB3YWtlUGVyaW9kQ2FsbElkID0gbnVsbDtcbiAgICAgIGF1ZGlvLnN0b3BNaWMoKTtcbiAgICAgIHJlbGVhc2VXYWtlTG9jaygpO1xuICAgICAgd2FrZUNsaWVudC5yZXNldCgpO1xuICAgIH1cbiAgfVxuICBzeW5jV2FrZVVpKCk7XG59XG5cbmZ1bmN0aW9uIGVuc3VyZUNvcmVXYWtlKG9uOiBib29sZWFuKSB7XG4gIGNvcmVXYW50c1dha2UgPSBvbjtcbiAgY29uc3QgbW9kZWwgPSBzZWxlY3RlZFdha2VNb2RlbCgpO1xuICBpZiAob24pIHtcbiAgICBpZiAoIW1vZGVsKSB7XG4gICAgICBsb2coXCJ3YXJuXCIsIFwiY29yZSBhc2tlZCBmb3Igd2FrZSB3b3JkLCBidXQgbm8gbW9kZWxzIGFyZSBhdmFpbGFibGVcIiwgXCJ3YXJuXCIpO1xuICAgIH0gZWxzZSB7XG4gICAgICB3YWtlTGFzdFRlbCA9IG51bGw7XG4gICAgICBjb25zdCBwcmVzZXJ2ZUluRmxpZ2h0ID0gd2FrZVBlcmlvZENhbGxJZCA9PT0gY2FsbElkICYmIHdha2VDbGllbnQubW9kZWxJZCA9PT0gbW9kZWwuaWQgJiYgd2FrZUNsaWVudC5zdXBwcmVzc2VkSW5GbGlnaHQ7XG4gICAgICB3YWtlUGVyaW9kQ2FsbElkID0gY2FsbElkO1xuICAgICAgaWYgKCF3YWtlQ2xpZW50LnJlYWR5IHx8IHdha2VDbGllbnQubW9kZWxJZCAhPT0gbW9kZWwuaWQpIHdha2VMb2FkaW5nID0gdHJ1ZTtcbiAgICAgIHdha2VDbGllbnQubG9hZChtb2RlbC5pZCwgd2FrZVRocmVzaG9sZCgpKTtcbiAgICAgIGlmICghcHJlc2VydmVJbkZsaWdodCkgd2FrZUNsaWVudC5yZXNldCgpO1xuICAgICAgbG9nKFwib3V0XCIsIGB3YWtlIHdvcmQgbGlzdGVuaW5nICgke21vZGVsLmxhYmVsfSlgLCBcIm91dFwiKTtcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgaWYgKCF3YWtlQXJtZWQpIHdha2VMYXN0VGVsID0gbnVsbDtcbiAgICBsb2coXCJvdXRcIiwgXCJ3YWtlIHdvcmQgb2ZmXCIsIFwib3V0XCIpO1xuICB9XG4gIHN5bmNXYWtlVWkoKTtcbn1cblxuZnVuY3Rpb24gb25XYWtlRGV0ZWN0ZWQoaGl0OiBXYWtlRGV0ZWN0aW9uRXZlbnQpIHtcbiAgaWYgKCFjYW5BY2NlcHRXYWtlSGl0KCkpIHJldHVybjtcbiAgY29uc3QgbGFiZWwgPSBzZWxlY3RlZFdha2VNb2RlbCgpPy5sYWJlbCA/PyBcIndha2Ugd29yZFwiO1xuICBsb2coXCJvdXRcIiwgYHdha2UgZGV0ZWN0ZWQgXHUyMDFDJHtsYWJlbH1cdTIwMUQgKHNjb3JlICR7aGl0LnNjb3JlLnRvRml4ZWQoMil9LCAke2hpdC5pbmZlck1zLnRvRml4ZWQoMSl9IG1zKWAsIFwib3V0XCIpO1xuICBpZiAoY2hlY2tlZChcIndha2UtY3VlXCIpKSB2b2lkIGF1ZGlvLm9wZW4oKS50aGVuKCgpID0+IGF1ZGlvLmN1ZShXQUtFX1RPTkUpKS5jYXRjaCgoKSA9PiB7fSk7XG4gIHRvYXN0KGBIZWFyZCBcdTIwMUMke2xhYmVsfVx1MjAxRCAoJHtoaXQuc2NvcmUudG9GaXhlZCgyKX0pYCk7XG4gIGlmIChjYWxsSWQgIT09IDApIHtcbiAgICBjb25zdCBkZWZlcnJlZCA9IHdha2VHYXRlLnRha2VEZWZlcnJlZCgpO1xuICAgIHB1c2goeyB0eXBlOiBcIndha2VcIiB9KTtcbiAgICAvLyBSZXBsYXkgc3VwcHJlc3NlZCBjaHVua3MgYW5kIGFueSBkZWZlcnJlZCBwb3N0LXBsYXliYWNrIGNodW5rcyBpbiBleGFjdCBjaHJvbm9sb2dpY2FsIG9yZGVyLFxuICAgIC8vIHNraXBwaW5nIGFueXRoaW5nIG9sZGVyIHRoYW4gYWxyZWFkeS1mb3J3YXJkZWQgZ2FwIGF1ZGlvLlxuICAgIGZvciAoY29uc3QgaXRlbSBvZiB3YWtlR2F0ZS5wbGFuV2FrZVJlcGxheShoaXQsIGRlZmVycmVkLCBieXRlc1RvQmFzZTY0KSkge1xuICAgICAgaWYgKCFjYWxsSWQpIGJyZWFrO1xuICAgICAgY291bnRzLm1pYysrO1xuICAgICAgaWYgKGl0ZW0udCAhPT0gdW5kZWZpbmVkKSBwdXNoKHsgdHlwZTogXCJtaWNcIiwgcGNtOiBpdGVtLnBjbSB9LCBpdGVtLnQpO1xuICAgICAgZWxzZSBwdXNoKHsgdHlwZTogXCJtaWNcIiwgcGNtOiBpdGVtLnBjbSB9KTtcbiAgICB9XG4gICAgcmV0dXJuO1xuICB9XG4gIHdha2VTdGFydGluZyA9IHRydWU7XG4gIG9wZW5pbmdDaHVua3MgPSBbXTtcbiAgb3BlbmluZ0J5dGVzID0gMDtcbiAgZm9yIChjb25zdCBjaHVuayBvZiBoaXQudHJhaWxpbmcpIHtcbiAgICBpZiAoY2h1bmsuYnl0ZXMuYnl0ZUxlbmd0aCA9PT0gMCkgY29udGludWU7XG4gICAgb3BlbmluZ0NodW5rcy5wdXNoKGNodW5rLmJ5dGVzKTtcbiAgICBvcGVuaW5nQnl0ZXMgKz0gY2h1bmsuYnl0ZXMuYnl0ZUxlbmd0aDtcbiAgICB3aGlsZSAob3BlbmluZ0J5dGVzID4gT1BFTklOR19NQVhfQllURVMgJiYgb3BlbmluZ0NodW5rcy5sZW5ndGggPiAxKSB7XG4gICAgICBvcGVuaW5nQnl0ZXMgLT0gb3BlbmluZ0NodW5rcy5zaGlmdCgpIS5ieXRlTGVuZ3RoO1xuICAgIH1cbiAgfVxuICB2b2lkIHN0YXJ0KGNoYXQubGVuZ3RoID4gMCkudGhlbigoc3RhcnRlZCkgPT4ge1xuICAgIGlmICghc3RhcnRlZCAmJiB3YWtlU3RhcnRpbmcpIHtcbiAgICAgIHdha2VTdGFydGluZyA9IGZhbHNlO1xuICAgICAgb3BlbmluZ0NodW5rcyA9IFtdO1xuICAgICAgb3BlbmluZ0J5dGVzID0gMDtcbiAgICAgIHN5bmNXYWtlVWkoKTtcbiAgICB9XG4gIH0pLmNhdGNoKChlcnIpID0+IHtcbiAgICB3YWtlU3RhcnRpbmcgPSBmYWxzZTtcbiAgICBvcGVuaW5nQ2h1bmtzID0gW107XG4gICAgb3BlbmluZ0J5dGVzID0gMDtcbiAgICB0b2FzdCgoZXJyIGFzIEVycm9yKS5tZXNzYWdlKTtcbiAgICBsb2coXCJlcnJvclwiLCAoZXJyIGFzIEVycm9yKS5tZXNzYWdlLCBcImVyclwiKTtcbiAgICBzeW5jV2FrZVVpKCk7XG4gIH0pO1xufVxuXG4vLyBXaXJpbmcuXG5cbmZ1bmN0aW9uIHNldHRpbmdzRnJvbVN0b3JhZ2UoKSB7XG4gIGZvciAoY29uc3QgaWQgb2YgW1wiYWVjXCIsIFwic3RvcHdvcmRcIiwgXCJwdHRcIiwgXCJjYXB0aW9uc1wiLCBcImNvZGluZ1wiLCBcImZha2VoZXJtZXNcIiwgXCJ0cmFjZVwiLCBcIndha2UtY3VlXCIsIFwid2FrZS1iYXJnZVwiXSkge1xuICAgIGNvbnN0IHYgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShgdm9pY2UuJHtpZH1gKTtcbiAgICBpZiAodiAhPSBudWxsKSAkPEhUTUxJbnB1dEVsZW1lbnQ+KGlkKS5jaGVja2VkID0gdiA9PT0gXCIxXCI7XG4gICAgJChpZCkuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiB7XG4gICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShgdm9pY2UuJHtpZH1gLCBjaGVja2VkKGlkKSA/IFwiMVwiIDogXCIwXCIpO1xuICAgICAgaWYgKGlkID09PSBcImFlY1wiICYmIHdha2VBcm1lZCAmJiAhY2FsbElkKSB7XG4gICAgICAgIHZvaWQgYXVkaW8uc3RhcnRNaWMob25NaWMsIG1pY09wdGlvbnMoKSkuY2F0Y2goKGVycikgPT4gdG9hc3QoYE1pY3JvcGhvbmU6ICR7ZXJyLm1lc3NhZ2V9YCkpO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG4gIGZvciAoY29uc3QgW2lkLCBrZXldIG9mIFtcbiAgICBbXCJmYWtlZGVsYXlcIiwgXCJ2b2ljZS5mYWtlZGVsYXlcIl0sXG4gICAgW1wiYXR0bi1hZnRlci13YWtlXCIsIFwidm9pY2UuYXR0bi1hZnRlci13YWtlXCJdLFxuICAgIFtcImF0dG4td2luZG93XCIsIFwidm9pY2UuYXR0bi13aW5kb3dcIl0sXG4gICAgW1wiYXR0bi1hZnRlci1xdWVzdGlvblwiLCBcInZvaWNlLmF0dG4tYWZ0ZXItcXVlc3Rpb25cIl0sXG4gICAgW1wiaGFuZ3VwLWFmdGVyXCIsIFwidm9pY2UuaGFuZ3VwLWFmdGVyXCJdLFxuICBdIGFzIGNvbnN0KSB7XG4gICAgY29uc3Qgc2F2ZWQgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShrZXkpO1xuICAgIGlmIChzYXZlZCAhPSBudWxsKSAkPEhUTUxJbnB1dEVsZW1lbnQ+KGlkKS52YWx1ZSA9IHNhdmVkO1xuICAgICQoaWQpLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4ge1xuICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oa2V5LCAkPEhUTUxJbnB1dEVsZW1lbnQ+KGlkKS52YWx1ZSk7XG4gICAgICBpZiAoaWQgPT09IFwiaGFuZ3VwLWFmdGVyXCIpIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2UuaGFuZ3VwLWN1c3RvbVwiLCBcIjFcIik7XG4gICAgfSk7XG4gIH1cbiAgY29uc3QgdGhyZXNoID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS53YWtlLXRocmVzaG9sZFwiKTtcbiAgaWYgKHRocmVzaCAhPSBudWxsKSAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwid2FrZS10aHJlc2hvbGRcIikudmFsdWUgPSB0aHJlc2g7XG4gICQoXCJ3YWtlLXRocmVzaG9sZC12YWxcIikudGV4dENvbnRlbnQgPSB3YWtlVGhyZXNob2xkKCkudG9GaXhlZCgyKTtcbiAgJChcIndha2UtdGhyZXNob2xkXCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJpbnB1dFwiLCAoKSA9PiB7XG4gICAgY29uc3QgdiA9IHdha2VUaHJlc2hvbGQoKTtcbiAgICAkKFwid2FrZS10aHJlc2hvbGQtdmFsXCIpLnRleHRDb250ZW50ID0gdi50b0ZpeGVkKDIpO1xuICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2Uud2FrZS10aHJlc2hvbGRcIiwgdi50b0ZpeGVkKDIpKTtcbiAgICB3YWtlQ2xpZW50LnNldFRocmVzaG9sZCh2KTtcbiAgICByZW5kZXJXYWtlVGVsZW1ldHJ5KCk7XG4gIH0pO1xuICBjb25zdCBzaWduYWxpbmcgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLnNpZ25hbGluZ1wiKTtcbiAgaWYgKHNpZ25hbGluZykgJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJzaWduYWxpbmdcIikudmFsdWUgPSBzaWduYWxpbmc7XG4gICQoXCJzaWduYWxpbmdcIikuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiB7XG4gICAgY29uc3QgbW9kZSA9ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwic2lnbmFsaW5nXCIpLnZhbHVlO1xuICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2Uuc2lnbmFsaW5nXCIsIG1vZGUpO1xuICAgIGlmIChsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLmhhbmd1cC1jdXN0b21cIikgIT09IFwiMVwiKSB7XG4gICAgICBjb25zdCBkZWYgPSBtb2RlID09PSBcImVjaG9cIiA/IFwiMTVcIiA6IFwiMzAwXCI7XG4gICAgICAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwiaGFuZ3VwLWFmdGVyXCIpLnZhbHVlID0gZGVmO1xuICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS5oYW5ndXAtYWZ0ZXJcIiwgZGVmKTtcbiAgICB9XG4gICAgc3luY1NpZ25hbGluZ1VpKCk7XG4gIH0pO1xuICAkKFwid2FrZS1lbmFibGVkXCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4gdm9pZCBhcm1XYWtlKGNoZWNrZWQoXCJ3YWtlLWVuYWJsZWRcIikpKTtcbiAgJChcIndha2UtbW9kZWxcIikuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiB7XG4gICAgY29uc3QgaWQgPSAkPEhUTUxTZWxlY3RFbGVtZW50PihcIndha2UtbW9kZWxcIikudmFsdWU7XG4gICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS53YWtlLW1vZGVsXCIsIGlkKTtcbiAgICBpZiAod2FrZUFybWVkIHx8IGNvcmVXYW50c1dha2UpIHtcbiAgICAgIHdha2VMb2FkaW5nID0gdHJ1ZTtcbiAgICAgIHdha2VMYXN0VGVsID0gbnVsbDtcbiAgICAgIHdha2VDbGllbnQubG9hZChpZCwgd2FrZVRocmVzaG9sZCgpKTtcbiAgICAgIHN5bmNXYWtlVWkoKTtcbiAgICB9IGVsc2Uge1xuICAgICAgc3luY1dha2VVaSgpO1xuICAgIH1cbiAgfSk7XG4gIGNvbnN0IHZvaWNlID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS52b2ljZVwiKTtcbiAgaWYgKHZvaWNlKSAkPEhUTUxTZWxlY3RFbGVtZW50PihcInZvaWNlXCIpLnZhbHVlID0gdm9pY2U7XG4gICQoXCJ2b2ljZVwiKS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2Uudm9pY2VcIiwgJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJ2b2ljZVwiKS52YWx1ZSkpO1xuICBjb25zdCBtb2RlID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS5tb2RlXCIpO1xuICBpZiAobW9kZSkgJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJtb2RlXCIpLnZhbHVlID0gbW9kZTtcbiAgJChcIm1vZGVcIikuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiB7XG4gICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS5tb2RlXCIsICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwibW9kZVwiKS52YWx1ZSk7XG4gICAgc3luY0NvbXBvc2VyKCk7XG4gIH0pO1xuICBjb25zdCB0aGVtZSA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UudGhlbWVcIikgPz8gXCJzeXN0ZW1cIjtcbiAgYXBwbHlUaGVtZSh0aGVtZSk7XG4gIGZvciAoY29uc3QgYnRuIG9mIEFycmF5LmZyb20oZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MQnV0dG9uRWxlbWVudD4oXCIjdGhlbWUtcGlja2VyIGJ1dHRvblwiKSkpIHtcbiAgICBidG4ub25jbGljayA9ICgpID0+IHtcbiAgICAgIGNvbnN0IGNob2ljZSA9IGJ0bi5kYXRhc2V0LnRoZW1lID8/IFwic3lzdGVtXCI7XG4gICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLnRoZW1lXCIsIGNob2ljZSk7XG4gICAgICBhcHBseVRoZW1lKGNob2ljZSk7XG4gICAgfTtcbiAgfVxuICBjb25zdCBkZW5zaXR5ID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS5kZW5zaXR5XCIpO1xuICBhcHBseURlbnNpdHkoZGVuc2l0eSk7XG4gIGZvciAoY29uc3QgYnRuIG9mIEFycmF5LmZyb20oZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MQnV0dG9uRWxlbWVudD4oXCIjZGVuc2l0eS1waWNrZXIgYnV0dG9uXCIpKSkge1xuICAgIGJ0bi5vbmNsaWNrID0gKCkgPT4ge1xuICAgICAgY29uc3QgY2hvaWNlID0gbm9ybWFsaXplRGVuc2l0eShidG4uZGF0YXNldC5kZW5zaXR5KTtcbiAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2UuZGVuc2l0eVwiLCBjaG9pY2UpO1xuICAgICAgYXBwbHlEZW5zaXR5KGNob2ljZSk7XG4gICAgfTtcbiAgfVxuICBtYXRjaE1lZGlhKFwiKHByZWZlcnMtY29sb3Itc2NoZW1lOiBkYXJrKVwiKS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHtcbiAgICBpZiAoKGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UudGhlbWVcIikgPz8gXCJzeXN0ZW1cIikgPT09IFwic3lzdGVtXCIpIGFwcGx5VGhlbWUoXCJzeXN0ZW1cIik7XG4gIH0pO1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwidmlzaWJpbGl0eWNoYW5nZVwiLCAoKSA9PiB7XG4gICAgaWYgKCFkb2N1bWVudC5oaWRkZW4gJiYgKGNhbGxJZCB8fCB3YWtlQXJtZWQpKSB2b2lkIGFjcXVpcmVXYWtlTG9jaygpO1xuICB9KTtcbiAgYXVkaW8ub25BdWRpb1N0YXRlQ2hhbmdlKCgpID0+IHN5bmNXYWtlVWkoKSk7XG4gIGNvbnN0IHJlc3VtZUlmU3VzcGVuZGVkID0gKCkgPT4ge1xuICAgIGlmIChhdWRpby5hdWRpb1N1c3BlbmRlZCAmJiAod2FrZUFybWVkIHx8IGNhbGxJZCkpIHtcbiAgICAgIHZvaWQgYXVkaW8ucmVzdW1lQXVkaW8oKS50aGVuKCgpID0+IHN5bmNXYWtlVWkoKSk7XG4gICAgfVxuICB9O1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwicG9pbnRlcmRvd25cIiwgcmVzdW1lSWZTdXNwZW5kZWQsIHsgcGFzc2l2ZTogdHJ1ZSB9KTtcbiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcInBvaW50ZXJ1cFwiLCByZXN1bWVJZlN1c3BlbmRlZCwgeyBwYXNzaXZlOiB0cnVlIH0pO1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgcmVzdW1lSWZTdXNwZW5kZWQsIHsgcGFzc2l2ZTogdHJ1ZSB9KTtcbiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcImtleWRvd25cIiwgcmVzdW1lSWZTdXNwZW5kZWQsIHsgcGFzc2l2ZTogdHJ1ZSB9KTtcbiAgc3luY1NpZ25hbGluZ1VpKCk7XG59XG5cbmNvbnN0IG1vYmlsZUxheW91dCA9IG1hdGNoTWVkaWEoXCIobWF4LXdpZHRoOiA5MjBweClcIik7XG5sZXQgZHJhd2VyT3BlbmVyOiBIVE1MRWxlbWVudCB8IG51bGwgPSBudWxsO1xuXG5mdW5jdGlvbiBzZXRUYXNrc09wZW4ob3BlbjogYm9vbGVhbiwgb3BlbmVyPzogSFRNTEVsZW1lbnQgfCBudWxsKSB7XG4gIGNvbnN0IGNhbk9wZW4gPSBtb2JpbGVMYXlvdXQubWF0Y2hlcyAmJiAhJChcInRhbGtcIikuaGlkZGVuO1xuICBjb25zdCBuZXh0ID0gb3BlbiAmJiBjYW5PcGVuO1xuICBjb25zdCB3YXNPcGVuID0gZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QuY29udGFpbnMoXCJ0YXNrcy1vcGVuXCIpO1xuICBkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC50b2dnbGUoXCJ0YXNrcy1vcGVuXCIsIG5leHQpO1xuICBjb25zdCBoZWFkZXIgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKFwiaGVhZGVyXCIpIGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgaWYgKGhlYWRlcikgaGVhZGVyLmluZXJ0ID0gbmV4dDtcbiAgJChcImNvbnZvXCIpLmluZXJ0ID0gbmV4dDtcbiAgJChcInNpZGVcIikuaW5lcnQgPSBtb2JpbGVMYXlvdXQubWF0Y2hlcyAmJiAhbmV4dDtcbiAgJChcInRhc2tzLXRvZ2dsZVwiKS5zZXRBdHRyaWJ1dGUoXCJhcmlhLWV4cGFuZGVkXCIsIFN0cmluZyhuZXh0KSk7XG4gICQoXCJtb2JpbGUtdGFza3MtYmFyXCIpLnNldEF0dHJpYnV0ZShcImFyaWEtZXhwYW5kZWRcIiwgU3RyaW5nKG5leHQpKTtcbiAgaWYgKG5leHQgJiYgIXdhc09wZW4pIHtcbiAgICBkcmF3ZXJPcGVuZXIgPSBvcGVuZXIgPz8gKGRvY3VtZW50LmFjdGl2ZUVsZW1lbnQgYXMgSFRNTEVsZW1lbnQgfCBudWxsKTtcbiAgICBjbGVhclVucmVhZElmUmVzdWx0c1Zpc2libGUoKTtcbiAgICAkKFwidGFza3MtY2xvc2VcIikuZm9jdXMoKTtcbiAgICByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKCkgPT4gdXBkYXRlQWxsUmVzdWx0Q2xhbXBpbmcoKSk7XG4gIH0gZWxzZSBpZiAoIW5leHQgJiYgd2FzT3Blbikge1xuICAgIGNvbnN0IHRhcmdldCA9IGRyYXdlck9wZW5lcjtcbiAgICBkcmF3ZXJPcGVuZXIgPSBudWxsO1xuICAgIGlmICh0YXJnZXQgJiYgdGFyZ2V0LmlzQ29ubmVjdGVkICYmICF0YXJnZXQuaGlkZGVuICYmIHRhcmdldC5vZmZzZXRQYXJlbnQgIT09IG51bGwpIHtcbiAgICAgIHRhcmdldC5mb2N1cygpO1xuICAgIH0gZWxzZSBpZiAodGFyZ2V0ID09PSAkKFwibW9iaWxlLXRhc2tzLWJhclwiKSkge1xuICAgICAgY29uc3QgZmFsbGJhY2sgPSAkKFwidGFza3MtdG9nZ2xlXCIpO1xuICAgICAgaWYgKCFmYWxsYmFjay5oaWRkZW4gJiYgZmFsbGJhY2sub2Zmc2V0UGFyZW50ICE9PSBudWxsKSBmYWxsYmFjay5mb2N1cygpO1xuICAgIH1cbiAgfVxufVxuXG5mdW5jdGlvbiB0YWJzKCkge1xuICBjb25zdCB2aWV3czogUmVjb3JkPHN0cmluZywgSFRNTEVsZW1lbnQ+ID0geyB0YWxrOiAkKFwidGFsa1wiKSwgZGV2OiAkKFwiZGV2XCIpLCByZXBsYXk6ICQoXCJyZXBsYXltYWluXCIpIH07XG4gIGZvciAoY29uc3QgbmFtZSBvZiBPYmplY3Qua2V5cyh2aWV3cykpIHtcbiAgICAkKGB0YWItJHtuYW1lfWApLm9uY2xpY2sgPSAoKSA9PiB7XG4gICAgICBmb3IgKGNvbnN0IFtvdGhlciwgZWxdIG9mIE9iamVjdC5lbnRyaWVzKHZpZXdzKSkge1xuICAgICAgICBlbC5oaWRkZW4gPSBvdGhlciAhPT0gbmFtZTtcbiAgICAgICAgJChgdGFiLSR7b3RoZXJ9YCkuY2xhc3NMaXN0LnRvZ2dsZShcIm9uXCIsIG90aGVyID09PSBuYW1lKTtcbiAgICAgIH1cbiAgICAgICQoXCJ0YXNrcy10b2dnbGVcIikuaGlkZGVuID0gbmFtZSAhPT0gXCJ0YWxrXCI7XG4gICAgICBzZXRUYXNrc09wZW4oZmFsc2UpO1xuICAgICAgaWYgKG5hbWUgPT09IFwidGFsa1wiKSByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKCkgPT4gdXBkYXRlQWxsUmVzdWx0Q2xhbXBpbmcoKSk7XG4gICAgfTtcbiAgfVxuICBmb3IgKGNvbnN0IGJ0biBvZiBBcnJheS5mcm9tKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiI3NpZGUtdGFicyBidXR0b25cIikpKSB7XG4gICAgYnRuLm9uY2xpY2sgPSAoKSA9PiBzZXRTaWRlRmlsdGVyKG5vcm1hbGl6ZVNpZGVGaWx0ZXIoYnRuLmRhdGFzZXQuZmlsdGVyKSk7XG4gIH1cbiAgJChcInRvZ2dsZS1hbGwtcmVzdWx0c1wiKS5vbmNsaWNrID0gKCkgPT4ge1xuICAgIGNvbnN0IGNsYW1wZWQgPSBbLi4ucmVzdWx0cy52YWx1ZXMoKV0uZmlsdGVyKChyKSA9PiByLmNhcmQuY2xhc3NMaXN0LmNvbnRhaW5zKFwiY2xhbXBlZFwiKSk7XG4gICAgY29uc3Qgb3BlbkFsbCA9IGNsYW1wZWQuc29tZSgocikgPT4gIXIuY2FyZC5jbGFzc0xpc3QuY29udGFpbnMoXCJvcGVuXCIpKTtcbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGNsYW1wZWQpIHNldFJlc3VsdE9wZW4oZW50cnksIG9wZW5BbGwpO1xuICB9O1xuICAkKFwiZ2VhclwiKS5vbmNsaWNrID0gKCkgPT4geyAkKFwic2V0dGluZ3NcIikuaGlkZGVuID0gZmFsc2U7IH07XG4gICQoXCJjbG9zZXNldHRpbmdzXCIpLm9uY2xpY2sgPSAoKSA9PiB7ICQoXCJzZXR0aW5nc1wiKS5oaWRkZW4gPSB0cnVlOyB9O1xuICAkKFwiY2xvc2VzZXR0aW5ncy14XCIpLm9uY2xpY2sgPSAoKSA9PiB7ICQoXCJzZXR0aW5nc1wiKS5oaWRkZW4gPSB0cnVlOyB9O1xuICAkKFwic2V0dGluZ3NcIikub25jbGljayA9IChlKSA9PiB7IGlmIChlLnRhcmdldCA9PT0gJChcInNldHRpbmdzXCIpKSAkKFwic2V0dGluZ3NcIikuaGlkZGVuID0gdHJ1ZTsgfTtcbiAgY29uc3Qgb3Blbk1vYmlsZVRhc2tzRHJhd2VyID0gKG9wZW5lcjogSFRNTEVsZW1lbnQpID0+IHtcbiAgICBjb25zdCBhY3RpdmVUb3RhbCA9IFsuLi50YXNrcy52YWx1ZXMoKV0uZmlsdGVyKGlzQWN0aXZlVGFzaykubGVuZ3RoICsgZWFybGllckFjdGl2ZUNvdW50O1xuICAgIGNvbnN0IG5leHRGaWx0ZXIgPSByZXNvbHZlTW9iaWxlQmFubmVyRmlsdGVyKHNpZGVGaWx0ZXIsIGFjdGl2ZVRvdGFsLCB1bnJlYWRNb2JpbGVSZXN1bHRzKTtcbiAgICBpZiAobmV4dEZpbHRlciAhPT0gc2lkZUZpbHRlcikgc2V0U2lkZUZpbHRlcihuZXh0RmlsdGVyKTtcbiAgICBzZXRUYXNrc09wZW4odHJ1ZSwgb3BlbmVyKTtcbiAgfTtcbiAgJChcInRhc2tzLXRvZ2dsZVwiKS5vbmNsaWNrID0gKCkgPT4ge1xuICAgIGlmIChkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5jb250YWlucyhcInRhc2tzLW9wZW5cIikpIHNldFRhc2tzT3BlbihmYWxzZSk7XG4gICAgZWxzZSBvcGVuTW9iaWxlVGFza3NEcmF3ZXIoJChcInRhc2tzLXRvZ2dsZVwiKSk7XG4gIH07XG4gICQoXCJtb2JpbGUtdGFza3MtYmFyXCIpLm9uY2xpY2sgPSAoKSA9PiBvcGVuTW9iaWxlVGFza3NEcmF3ZXIoJChcIm1vYmlsZS10YXNrcy1iYXJcIikpO1xuICAkKFwidGFza3MtY2xvc2VcIikub25jbGljayA9ICgpID0+IHNldFRhc2tzT3BlbihmYWxzZSk7XG4gICQoXCJzaWRlLWJhY2tkcm9wXCIpLm9uY2xpY2sgPSAoKSA9PiBzZXRUYXNrc09wZW4oZmFsc2UpO1xuICBtb2JpbGVMYXlvdXQuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiB7XG4gICAgc2V0VGFza3NPcGVuKGZhbHNlKTtcbiAgICBjbGVhclVucmVhZElmUmVzdWx0c1Zpc2libGUoKTtcbiAgICByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKCkgPT4gdXBkYXRlQWxsUmVzdWx0Q2xhbXBpbmcoKSk7XG4gIH0pO1xuICBzZXRUYXNrc09wZW4oZmFsc2UpO1xufVxuXG5mdW5jdGlvbiB0eXBpbmcoKTogYm9vbGVhbiB7XG4gIGNvbnN0IGVsID0gZG9jdW1lbnQuYWN0aXZlRWxlbWVudCBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gIHJldHVybiAhIWVsICYmIChlbC50YWdOYW1lID09PSBcIklOUFVUXCIgfHwgZWwudGFnTmFtZSA9PT0gXCJURVhUQVJFQVwiIHx8IGVsLnRhZ05hbWUgPT09IFwiU0VMRUNUXCIgfHwgZWwuaXNDb250ZW50RWRpdGFibGUpO1xufVxuXG5mdW5jdGlvbiBrZXlzKCkge1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCAoZSkgPT4ge1xuICAgIGlmIChlLmtleSA9PT0gXCJFc2NhcGVcIikge1xuICAgICAgaWYgKCEkKFwic2V0dGluZ3NcIikuaGlkZGVuKSB7ICQoXCJzZXR0aW5nc1wiKS5oaWRkZW4gPSB0cnVlOyByZXR1cm47IH1cbiAgICAgIGlmIChkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5jb250YWlucyhcInRhc2tzLW9wZW5cIikgJiYgbW9iaWxlTGF5b3V0Lm1hdGNoZXMgJiYgISQoXCJ0YWxrXCIpLmhpZGRlbikgeyBzZXRUYXNrc09wZW4oZmFsc2UpOyByZXR1cm47IH1cbiAgICAgIGlmIChjYWxsSWQpIHsgcHVzaCh7IHR5cGU6IFwiaW50ZXJydXB0XCIgfSk7IGF1ZGlvLmZsdXNoKCk7IHJldHVybjsgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAodHlwaW5nKCkgfHwgISQoXCJzZXR0aW5nc1wiKS5oaWRkZW4gfHwgZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QuY29udGFpbnMoXCJ0YXNrcy1vcGVuXCIpIHx8IGUubWV0YUtleSB8fCBlLmN0cmxLZXkgfHwgZS5hbHRLZXkpIHJldHVybjtcbiAgICBpZiAoZS5rZXkgPT09IFwibVwiIHx8IGUua2V5ID09PSBcIk1cIikgeyBzZXRNdXRlZCghbXV0ZWQpOyBlLnByZXZlbnREZWZhdWx0KCk7IH1cbiAgICBlbHNlIGlmIChlLmtleSA9PT0gXCJ3XCIgfHwgZS5rZXkgPT09IFwiV1wiKSB7IHZvaWQgYXJtV2FrZSghd2FrZUFybWVkKTsgZS5wcmV2ZW50RGVmYXVsdCgpOyB9XG4gICAgZWxzZSBpZiAoZS5rZXkgPT09IFwiL1wiKSB7ICQoXCJ0ZXh0XCIpLmZvY3VzKCk7IGUucHJldmVudERlZmF1bHQoKTsgfVxuICAgIGVsc2UgaWYgKGUuY29kZSA9PT0gXCJTcGFjZVwiICYmIGNhbGxJZCAmJiBtdXRlZCAmJiAhZS5yZXBlYXQpIHsgaG9sZGluZyA9IHRydWU7IHB1c2goeyB0eXBlOiBcInVubXV0ZVwiIH0pOyBzaG93U3RhdHVzKCk7IGUucHJldmVudERlZmF1bHQoKTsgfVxuICB9KTtcbiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcImtleXVwXCIsIChlKSA9PiB7XG4gICAgaWYgKGUuY29kZSA9PT0gXCJTcGFjZVwiICYmIGhvbGRpbmcpIHsgaG9sZGluZyA9IGZhbHNlOyBwdXNoKHsgdHlwZTogXCJtdXRlXCIgfSk7IHNob3dTdGF0dXMoKTsgfVxuICB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gc3VibWl0VGV4dChlOiBFdmVudCkge1xuICBlLnByZXZlbnREZWZhdWx0KCk7XG4gIGNvbnN0IGlucHV0ID0gJDxIVE1MSW5wdXRFbGVtZW50PihcInRleHRcIik7XG4gIGxldCB0ZXh0ID0gaW5wdXQudmFsdWUudHJpbSgpO1xuICBpZiAoIXRleHQpIHJldHVybjtcbiAgLy8gV2l0aCBubyBjYWxsIG9uLCB0eXBpbmcgc3RhcnRzIGEgY2hhdDogdGhlIHNhbWUgbWFpbiB0aHJlYWQsIGluIHRleHQuXG4gIGlmICghY2FsbElkKSB7XG4gICAgaW5wdXQudmFsdWUgPSBcIlwiO1xuICAgIHN5bmNDb21wb3NlcigpO1xuICAgIHRyeSB7IGF3YWl0IHN0YXJ0KGZhbHNlLCB0cnVlKTsgfSBjYXRjaCAoZXJyKSB7IHRvYXN0KChlcnIgYXMgRXJyb3IpLm1lc3NhZ2UpOyBsb2coXCJlcnJvclwiLCAoZXJyIGFzIEVycm9yKS5tZXNzYWdlLCBcImVyclwiKTsgfVxuICAgIGlmICghY2FsbElkKSB7IGlucHV0LnZhbHVlID0gdGV4dDsgc3luY0NvbXBvc2VyKCk7IHJldHVybjsgfVxuICB9XG4gIC8vIFwiL3QzIFx1MjAyNlwiIGFuZCBcIi9oIFx1MjAyNlwiIHBpY2sgdGhlIGFnZW50IHdoYXRldmVyIHRoZSBzZWxlY3RvciBzYXlzLlxuICBjb25zdCBwYXJzZWQgPSBwYXJzZVByZWZpeCh0ZXh0KTtcbiAgY29uc3QgbW9kZSA9IHBhcnNlZC5tb2RlID8/ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwibW9kZVwiKS52YWx1ZTtcbiAgdGV4dCA9IHBhcnNlZC5yZXN0O1xuICBpZiAoIXRleHQpIHJldHVybjtcbiAgaWYgKG1vZGUgPT09IFwic2F5XCIpIHtcbiAgICBwdXNoKHsgdHlwZTogXCJzYXlcIiwgdGV4dCB9KTtcbiAgICBzY3JvbGxEb3duKHRydWUpO1xuICB9IGVsc2Uge1xuICAgIHB1c2goeyB0eXBlOiBcImFza1wiLCB0ZXh0LCBhZ2VudDogbW9kZSB9KTtcbiAgICBub3RlKGBZb3UgXHUyMTkyIG5ldyAke21vZGUgPT09IFwidDNcIiA/IFwiY29kaW5nXCIgOiBcIkhlcm1lc1wifSB0YXNrOiAke3RleHR9YCk7XG4gICAgc2Nyb2xsRG93bih0cnVlKTtcbiAgfVxuICBpbnB1dC52YWx1ZSA9IFwiXCI7XG4gIHN5bmNDb21wb3NlcigpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBtYWluKCkge1xuICBhcHBseVRoZW1lKGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UudGhlbWVcIikgPz8gXCJzeXN0ZW1cIik7XG4gIGFwcGx5RGVuc2l0eShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLmRlbnNpdHlcIikpO1xuICBzZXJ2ZXIgPSBhd2FpdCAoYXdhaXQgZmV0Y2goXCIvY29uZmlnXCIpKS5qc29uKCk7XG4gICQoXCJyb3V0ZVwiKS50ZXh0Q29udGVudCA9IGAke3NlcnZlci5yb3V0ZSA9PT0gXCJ2ZXJ0ZXhcIiA/IFwiVmVydGV4XCIgOiBcIkdlbWluaSBBUElcIn0gXHUwMEI3ICR7c2VydmVyLm1vZGVsLnNwbGl0KFwiL1wiKS5wb3AoKX1gO1xuICAkKFwidmVyc2lvblwiKS50ZXh0Q29udGVudCA9IHNlcnZlci52ZXJzaW9uO1xuICAkKFwiYnVpbGRcIikudGV4dENvbnRlbnQgPSBgY29yZSAke3NlcnZlci52ZXJzaW9ufWA7XG4gIHNldHRpbmdzRnJvbVN0b3JhZ2UoKTtcbiAgY29uc3Qgd2FrZVNlbGVjdCA9ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwid2FrZS1tb2RlbFwiKTtcbiAgY29uc3Qgd2FrZUxpc3QgPSBzZXJ2ZXIud2FrZU1vZGVscyA/PyBbXTtcbiAgZm9yIChjb25zdCBtIG9mIHdha2VMaXN0KSB3YWtlU2VsZWN0LmFkZChuZXcgT3B0aW9uKG0ubGFiZWwsIG0uaWQpKTtcbiAgY29uc3Qgc2F2ZWRXYWtlTW9kZWwgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLndha2UtbW9kZWxcIik7XG4gIGlmIChzYXZlZFdha2VNb2RlbCAmJiB3YWtlTGlzdC5zb21lKChtKSA9PiBtLmlkID09PSBzYXZlZFdha2VNb2RlbCkpIHdha2VTZWxlY3QudmFsdWUgPSBzYXZlZFdha2VNb2RlbDtcbiAgZWxzZSBpZiAod2FrZUxpc3Quc29tZSgobSkgPT4gbS5pZCA9PT0gXCJwZW5ueXdvcnRoXCIpKSB3YWtlU2VsZWN0LnZhbHVlID0gXCJwZW5ueXdvcnRoXCI7XG4gIGlmICh3YWtlTGlzdC5sZW5ndGggPT09IDApIHtcbiAgICAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwid2FrZS1lbmFibGVkXCIpLmRpc2FibGVkID0gdHJ1ZTtcbiAgICB3YWtlU2VsZWN0LmRpc2FibGVkID0gdHJ1ZTtcbiAgICAkKFwid2FrZS1oZWxwXCIpLnRleHRDb250ZW50ID0gXCJObyAub25ueCB3YWtlIHdvcmQgbW9kZWxzIGZvdW5kIG9uIHRoZSBzZXJ2ZXIuXCI7XG4gIH1cbiAgaWYgKCFzZXJ2ZXIuaGVybWVzKSB7ICQ8SFRNTElucHV0RWxlbWVudD4oXCJmYWtlaGVybWVzXCIpLmNoZWNrZWQgPSB0cnVlOyAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwiZmFrZWhlcm1lc1wiKS5kaXNhYmxlZCA9IHRydWU7IH1cbiAgaWYgKCFzZXJ2ZXIudDMpICQoXCJjb2RpbmdoZWxwXCIpLnRleHRDb250ZW50ID0gXCJUMyBpc24ndCBhdmFpbGFibGUgb24gdGhlIHNlcnZlcjogb25seSB3aXRoIGZha2UgYW5zd2Vycy5cIjtcbiAgZWxzZSAkKFwiY29kaW5naGVscFwiKS50ZXh0Q29udGVudCA9IGBDb2RlIGNoYW5nZXMgZ28gdG8gYSBUMyBDb2RlIHRocmVhZCBpbiBvbmUgb2Y6ICR7c2VydmVyLnQzLmpvaW4oXCIsIFwiKX0uYDtcbiAgaWYgKCFzdG9wV29yZHMuc3VwcG9ydGVkKSB7ICQ8SFRNTElucHV0RWxlbWVudD4oXCJzdG9wd29yZFwiKS5jaGVja2VkID0gZmFsc2U7ICQ8SFRNTElucHV0RWxlbWVudD4oXCJzdG9wd29yZFwiKS5kaXNhYmxlZCA9IHRydWU7IH1cbiAgY29uc3QgcHJlc2V0ID0gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJwcmVzZXRcIik7XG4gIGZvciAoY29uc3QgbmFtZSBvZiBPYmplY3Qua2V5cyhQUkVTRVRTKSkgcHJlc2V0LmFkZChuZXcgT3B0aW9uKG5hbWUsIG5hbWUpKTtcbiAgcHJlc2V0LnZhbHVlID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS1jb3JlLnByZXNldFwiKSA/PyBcIndlYlwiO1xuICBpZiAoIVBSRVNFVFNbcHJlc2V0LnZhbHVlXSkgcHJlc2V0LnZhbHVlID0gXCJ3ZWJcIjtcbiAgJDxIVE1MVGV4dEFyZWFFbGVtZW50PihcImNvbmZpZ1wiKS52YWx1ZSA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UtY29yZS5jb25maWdcIikgPz8gSlNPTi5zdHJpbmdpZnkoUFJFU0VUU1twcmVzZXQudmFsdWVdLCBudWxsLCAyKTtcbiAgc3luY1NpZ25hbGluZ1VpKCk7XG4gIHByZXNldC5vbmNoYW5nZSA9ICgpID0+IHtcbiAgICAkPEhUTUxUZXh0QXJlYUVsZW1lbnQ+KFwiY29uZmlnXCIpLnZhbHVlID0gSlNPTi5zdHJpbmdpZnkoUFJFU0VUU1twcmVzZXQudmFsdWVdLCBudWxsLCAyKTtcbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLWNvcmUucHJlc2V0XCIsIHByZXNldC52YWx1ZSk7XG4gICAgbG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oXCJ2b2ljZS1jb3JlLmNvbmZpZ1wiKTtcbiAgICBzeW5jU2lnbmFsaW5nVWkoKTtcbiAgfTtcbiAgJChcImNvbmZpZ1wiKS5vbmlucHV0ID0gKCkgPT4geyBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLWNvcmUuY29uZmlnXCIsICQ8SFRNTFRleHRBcmVhRWxlbWVudD4oXCJjb25maWdcIikudmFsdWUpOyBzeW5jU2lnbmFsaW5nVWkoKTsgfTtcbiAgJChcImRlZmF1bHRzXCIpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYyA9IGNvcmUgPz8gKGF3YWl0IGxvYWRDb3JlKCkpO1xuICAgICQoXCJkZWZhdWx0c3ZpZXdcIikudGV4dENvbnRlbnQgPSBKU09OLnN0cmluZ2lmeShKU09OLnBhcnNlKGMuZGVmYXVsdHMoKSksIG51bGwsIDIpO1xuICAgICQoXCJkZWZhdWx0c3ZpZXdcIikuaGlkZGVuID0gISQoXCJkZWZhdWx0c3ZpZXdcIikuaGlkZGVuO1xuICB9O1xuICBjb25zdCBvbkNhbGxDbGljayA9ICgpID0+IHZvaWQgY2FsbEJ1dHRvbigpLmNhdGNoKChlcnIpID0+IHsgdG9hc3QoZXJyLm1lc3NhZ2UpOyBsb2coXCJlcnJvclwiLCBlcnIubWVzc2FnZSwgXCJlcnJcIik7IH0pO1xuICBjb25zdCBvbkhlcm9DYWxsQ2xpY2sgPSAoKSA9PiB7IGlmICghY2FsbElkKSB2b2lkIHN0YXJ0KCkuY2F0Y2goKGVycikgPT4geyB0b2FzdChlcnIubWVzc2FnZSk7IGxvZyhcImVycm9yXCIsIGVyci5tZXNzYWdlLCBcImVyclwiKTsgfSk7IH07XG4gIGNvbnN0IG9uUmVzdW1lQ2xpY2sgPSAoKSA9PiB2b2lkIHN0YXJ0KHRydWUpLmNhdGNoKChlcnIpID0+IHsgdG9hc3QoZXJyLm1lc3NhZ2UpOyBsb2coXCJlcnJvclwiLCBlcnIubWVzc2FnZSwgXCJlcnJcIik7IH0pO1xuICAkKFwiY2FsbFwiKS5vbmNsaWNrID0gb25DYWxsQ2xpY2s7XG4gICQoXCJoZXJvLWNhbGxcIikub25jbGljayA9IG9uSGVyb0NhbGxDbGljaztcbiAgJChcImhlcm8td2FrZVwiKS5vbmNsaWNrID0gKCkgPT4ge1xuICAgIGlmICh3YWtlQXJtZWQgJiYgYXVkaW8uYXVkaW9TdXNwZW5kZWQpIHsgdm9pZCBhdWRpby5yZXN1bWVBdWRpbygpLnRoZW4oKCkgPT4gc3luY1dha2VVaSgpKTsgcmV0dXJuOyB9XG4gICAgdm9pZCBhcm1XYWtlKCF3YWtlQXJtZWQpO1xuICB9O1xuICAkKFwid2FrZWJ0blwiKS5vbmNsaWNrID0gKCkgPT4ge1xuICAgIGlmICh3YWtlQXJtZWQgJiYgYXVkaW8uYXVkaW9TdXNwZW5kZWQpIHsgdm9pZCBhdWRpby5yZXN1bWVBdWRpbygpLnRoZW4oKCkgPT4gc3luY1dha2VVaSgpKTsgcmV0dXJuOyB9XG4gICAgdm9pZCBhcm1XYWtlKCF3YWtlQXJtZWQpO1xuICB9O1xuICAkKFwid2FrZS1ub3dcIikub25jbGljayA9ICgpID0+IHtcbiAgICBpZiAoY2FsbElkKSB7XG4gICAgICBmbHVzaERlZmVycmVkTWljKCk7XG4gICAgICB3YWtlQ2xpZW50LnJlc2V0KCk7XG4gICAgICBwdXNoKHsgdHlwZTogXCJyZXN1bWVcIiB9KTtcbiAgICB9XG4gIH07XG4gICQoXCJyZXN1bWVcIikub25jbGljayA9IG9uUmVzdW1lQ2xpY2s7XG4gICQoXCJoZXJvLXJlc3VtZVwiKS5vbmNsaWNrID0gb25SZXN1bWVDbGljaztcbiAgc3luY1dha2VVaSgpO1xuICBpZiAobG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS53YWtlLWVuYWJsZWRcIikgPT09IFwiMVwiICYmIHdha2VMaXN0Lmxlbmd0aCA+IDApIHtcbiAgICAvLyBSZS1hcm0gYXV0b21hdGljYWxseSBvbiByZWxvYWQgb25seSB3aGVuIG1pY3JvcGhvbmUgcGVybWlzc2lvbiBpcyBhbHJlYWR5IGdyYW50ZWQuXG4gICAgdm9pZCBuYXZpZ2F0b3IucGVybWlzc2lvbnM/LnF1ZXJ5KHsgbmFtZTogXCJtaWNyb3Bob25lXCIgYXMgUGVybWlzc2lvbk5hbWUgfSlcbiAgICAgIC50aGVuKChwKSA9PiB7IGlmIChwLnN0YXRlID09PSBcImdyYW50ZWRcIikgdm9pZCBhcm1XYWtlKHRydWUsIGZhbHNlKTsgfSlcbiAgICAgIC5jYXRjaCgoKSA9PiB7fSk7XG4gIH1cbiAgaWYgKHNhdmVkSGlzdG9yeSgpLmxlbmd0aCA+IDApIHtcbiAgICBzeW5jUmVzdW1lQnV0dG9ucyh0cnVlKTtcbiAgICAkKFwicmVzdW1lXCIpLnRpdGxlID0gXCJDYWxsIGFnYWluLCBjYXJyeWluZyBvbiBmcm9tIHRoZSBsYXN0IGNvbnZlcnNhdGlvblwiO1xuICB9XG4gICQoXCJtaWNcIikub25jbGljayA9ICgpID0+IHNldE11dGVkKCFtdXRlZCk7XG4gICQoXCJodXNoXCIpLm9uY2xpY2sgPSAoKSA9PiB7IHB1c2goeyB0eXBlOiBcImludGVycnVwdFwiIH0pOyBhdWRpby5mbHVzaCgpOyB9O1xuICAkKFwiY2FuY2VsYWxsXCIpLm9uY2xpY2sgPSAoKSA9PiBwdXNoKHsgdHlwZTogXCJjYW5jZWxBbGxcIiB9KTtcbiAgJChcImRvbmVib3hcIikuYWRkRXZlbnRMaXN0ZW5lcihcInRvZ2dsZVwiLCAoKSA9PiB7IGlmICgkPEhUTUxEZXRhaWxzRWxlbWVudD4oXCJkb25lYm94XCIpLm9wZW4pICQoXCJkb25lYm94XCIpLnNjcm9sbEludG9WaWV3KHsgYmxvY2s6IFwibmVhcmVzdFwiIH0pOyB9KTtcbiAgJChcInNheVwiKS5vbnN1Ym1pdCA9IChlKSA9PiB2b2lkIHN1Ym1pdFRleHQoZSk7XG4gICQoXCJ0ZXh0XCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJpbnB1dFwiLCBzeW5jQ29tcG9zZXIpO1xuICBjb25zdCB0cmFuc2NyaXB0UGFuZSA9ICQoXCJ0cmFuc2NyaXB0XCIpO1xuICB0cmFuc2NyaXB0UGFuZS5hZGRFdmVudExpc3RlbmVyKFwic2Nyb2xsXCIsICgpID0+IHRyYW5zY3JpcHRTY3JvbGwub25TY3JvbGwoKSwgeyBwYXNzaXZlOiB0cnVlIH0pO1xuICB0cmFuc2NyaXB0UGFuZS5hZGRFdmVudExpc3RlbmVyKFwic2Nyb2xsZW5kXCIsICgpID0+IHRyYW5zY3JpcHRTY3JvbGwub25TY3JvbGxFbmQoKSwgeyBwYXNzaXZlOiB0cnVlIH0pO1xuICB0cmFuc2NyaXB0UGFuZS5hZGRFdmVudExpc3RlbmVyKFwid2hlZWxcIiwgKGUpID0+IHsgaWYgKGUuZGVsdGFZIDwgMCkgdHJhbnNjcmlwdFNjcm9sbC5jYW5jZWxKdW1wKCk7IH0sIHsgcGFzc2l2ZTogdHJ1ZSB9KTtcbiAgdHJhbnNjcmlwdFBhbmUuYWRkRXZlbnRMaXN0ZW5lcihcInRvdWNoc3RhcnRcIiwgKCkgPT4gdHJhbnNjcmlwdFNjcm9sbC5jYW5jZWxKdW1wKCksIHsgcGFzc2l2ZTogdHJ1ZSB9KTtcbiAgaWYgKHR5cGVvZiBSZXNpemVPYnNlcnZlciAhPT0gXCJ1bmRlZmluZWRcIikge1xuICAgIG5ldyBSZXNpemVPYnNlcnZlcigoKSA9PiB0cmFuc2NyaXB0U2Nyb2xsLm9uUmVzaXplKCkpLm9ic2VydmUodHJhbnNjcmlwdFBhbmUpO1xuICAgIG5ldyBSZXNpemVPYnNlcnZlcigoKSA9PiB1cGRhdGVBbGxSZXN1bHRDbGFtcGluZygpKS5vYnNlcnZlKCQoXCJyZXN1bHRzXCIpKTtcbiAgfVxuICAkKFwianVtcGJvdHRvbVwiKS5vbmNsaWNrID0gKCkgPT4gdHJhbnNjcmlwdFNjcm9sbC5qdW1wVG9Cb3R0b20oKTtcbiAgc3luY0NvbXBvc2VyKCk7XG4gIHN5bmNTaWRlTGF5b3V0KCk7XG4gIHRhYnMoKTtcbiAga2V5cygpO1xuICBjb25zdCBldmVudHMgPSBuZXcgRXZlbnRTb3VyY2UoXCIvZXZlbnRzXCIpO1xuICBldmVudHMuYWRkRXZlbnRMaXN0ZW5lcihcImNvcmVcIiwgKGUpID0+IHtcbiAgICBjb25zdCB7IHZlcnNpb24gfSA9IEpTT04ucGFyc2UoKGUgYXMgTWVzc2FnZUV2ZW50KS5kYXRhKTtcbiAgICAkKFwidmVyc2lvblwiKS50ZXh0Q29udGVudCA9IHZlcnNpb24gKyAoY2FsbElkICYmIGNvcmUgJiYgY29yZS52ZXJzaW9uICE9PSB2ZXJzaW9uID8gYCAobmV4dCBjYWxsOyB0aGlzIG9uZSBydW5zICR7Y29yZS52ZXJzaW9ufSlgIDogXCJcIik7XG4gICAgJChcImJ1aWxkXCIpLnRleHRDb250ZW50ID0gYGNvcmUgJHt2ZXJzaW9ufWA7XG4gIH0pO1xuICBldmVudHMuYWRkRXZlbnRMaXN0ZW5lcihcImFwcFwiLCAoKSA9PiB7IGlmICghY2FsbElkKSBsb2NhdGlvbi5yZWxvYWQoKTsgZWxzZSB0b2FzdChcIlRoZSBwYWdlIGNoYW5nZWQ6IHJlbG9hZCBhZnRlciB0aGlzIGNhbGxcIik7IH0pO1xuICBldmVudHMuYWRkRXZlbnRMaXN0ZW5lcihcImVycm9yXCIsIChlKSA9PiB7XG4gICAgY29uc3QgZGF0YSA9IChlIGFzIE1lc3NhZ2VFdmVudCkuZGF0YTtcbiAgICBpZiAoZGF0YSkgdG9hc3QoYEJ1aWxkIGZhaWxlZDogJHtKU09OLnBhcnNlKGRhdGEpLm1lc3NhZ2V9YCk7XG4gIH0pO1xuICBuZXcgUmVwbGF5KCQoXCJyZXBsYXlcIiksIGxvYWRDb3JlKTtcbiAgdm9pZCBwaW5nKCk7XG4gIHZvaWQgc2hvd0VhcmxpZXIoKTtcbiAgd2luZG93LnNldEludGVydmFsKCgpID0+IHZvaWQgc2hvd0VhcmxpZXIoKSwgMzBfMDAwKTtcbn1cblxudm9pZCBtYWluKCk7XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBU0EsSUFBTSxTQUFTLG9CQUFJLElBQUk7QUFBQSxFQUNyQjtBQUFBLEVBQU87QUFBQSxFQUFNO0FBQUEsRUFBUTtBQUFBLEVBQVU7QUFBQSxFQUFPO0FBQUEsRUFBUTtBQUFBLEVB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LGlCQUFpQixVQUFVLE1BQU0saUJBQWlCLFNBQVMsR0FBRyxFQUFFLFNBQVMsS0FBSyxDQUFDO0FBQzlGLGlCQUFlLGlCQUFpQixhQUFhLE1BQU0saUJBQWlCLFlBQVksR0FBRyxFQUFFLFNBQVMsS0FBSyxDQUFDO0FBQ3BHLGlCQUFlLGlCQUFpQixTQUFTLENBQUMsTUFBTTtBQUFFLFFBQUksRUFBRSxTQUFTLEVBQUcsa0JBQWlCLFdBQVc7QUFBQSxFQUFHLEdBQUcsRUFBRSxTQUFTLEtBQUssQ0FBQztBQUN2SCxpQkFBZSxpQkFBaUIsY0FBYyxNQUFNLGlCQUFpQixXQUFXLEdBQUcsRUFBRSxTQUFTLEtBQUssQ0FBQztBQUNwRyxNQUFJLE9BQU8sbUJBQW1CLGFBQWE7QUFDekMsUUFBSSxlQUFlLE1BQU0saUJBQWlCLFNBQVMsQ0FBQyxFQUFFLFFBQVEsY0FBYztBQUM1RSxRQUFJLGVBQWUsTUFBTSx3QkFBd0IsQ0FBQyxFQUFFLFFBQVEsRUFBRSxTQUFTLENBQUM7QUFBQSxFQUMxRTtBQUNBLElBQUUsWUFBWSxFQUFFLFVBQVUsTUFBTSxpQkFBaUIsYUFBYTtBQUM5RCxlQUFhO0FBQ2IsaUJBQWU7QUFDZixPQUFLO0FBQ0wsT0FBSztBQUNMLFFBQU0sU0FBUyxJQUFJLFlBQVksU0FBUztBQUN4QyxTQUFPLGlCQUFpQixRQUFRLENBQUMsTUFBTTtBQUNyQyxVQUFNLEVBQUUsUUFBUSxJQUFJLEtBQUssTUFBTyxFQUFtQixJQUFJO0FBQ3ZELE1BQUUsU0FBUyxFQUFFLGNBQWMsV0FBVyxVQUFVLFFBQVEsS0FBSyxZQUFZLFVBQVUsOEJBQThCLEtBQUssT0FBTyxNQUFNO0FBQ25JLE1BQUUsT0FBTyxFQUFFLGNBQWMsUUFBUSxPQUFPO0FBQUEsRUFDMUMsQ0FBQztBQUNELFNBQU8saUJBQWlCLE9BQU8sTUFBTTtBQUFFLFFBQUksQ0FBQyxPQUFRLFVBQVMsT0FBTztBQUFBLFFBQVEsT0FBTSwwQ0FBMEM7QUFBQSxFQUFHLENBQUM7QUFDaEksU0FBTyxpQkFBaUIsU0FBUyxDQUFDLE1BQU07QUFDdEMsVUFBTSxPQUFRLEVBQW1CO0FBQ2pDLFFBQUksS0FBTSxPQUFNLGlCQUFpQixLQUFLLE1BQU0sSUFBSSxFQUFFLE9BQU8sRUFBRTtBQUFBLEVBQzdELENBQUM7QUFDRCxNQUFJLE9BQU8sRUFBRSxRQUFRLEdBQUcsUUFBUTtBQUNoQyxPQUFLLEtBQUs7QUFDVixPQUFLLFlBQVk7QUFDakIsU0FBTyxZQUFZLE1BQU0sS0FBSyxZQUFZLEdBQUcsR0FBTTtBQUNyRDtBQUVBLEtBQUssS0FBSzsiLAogICJuYW1lcyI6IFsiY29yZSIsICJjb3JlIiwgIm5vdyIsICJhY3RpdmVTZXNzaW9uIiwgImNvdW50cyIsICJieXRlc1RvQmFzZTY0IiwgImxpdmUiLCAibGluZSIsICJydW4iLCAibW9kZSJdCn0K
