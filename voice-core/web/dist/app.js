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
    this.muted = false;
    this.speechUntil = 0;
    this.deliverMax = 30;
    this.briefWait = 3;
    this.activeBrief = null;
    this.readyBriefs = [];
    this.requestedBriefs = /* @__PURE__ */ new Map();
    this.lastEventRanAnnounce = false;
    this.lastCut = null;
    this.lastStoppedBriefAt = null;
    this.replayFloorSeq = 0;
    this.deferred = [];
    this.maxDeferred = maxDeferred;
  }
  reset(whileSpeaking = "send", floorSeq = 0, limits = {}) {
    this.whileSpeaking = whileSpeaking;
    this.muted = limits.muted === true;
    this.speechUntil = 0;
    this.deliverMax = typeof limits.deliverMax === "number" ? limits.deliverMax : 30;
    this.briefWait = typeof limits.briefWait === "number" ? limits.briefWait : 3;
    this.activeBrief = null;
    this.readyBriefs = [];
    this.requestedBriefs.clear();
    this.lastEventRanAnnounce = false;
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
    if (eventType !== "mic" && this.lastEventRanAnnounce) {
      this.lastEventRanAnnounce = false;
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
    if (event.type === "mic") return [];
    if (event.type === "mute") {
      this.lastEventRanAnnounce = false;
      this.muted = true;
      return this.flushDeferred();
    }
    if (event.type === "unmute") {
      this.lastEventRanAnnounce = false;
      this.muted = false;
      return [];
    }
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
    this.lastEventRanAnnounce = event.type === "tick" || acceptedBrief;
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
    if (this.muted) {
      return [{ pcm: params.pcm, t: params.t }];
    }
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
      briefWait: typeof announceCfg?.briefWait === "number" ? announceCfg.briefWait : 3,
      muted
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
      flushDeferredMic();
      wakeClient.reset();
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL2NvbW1hbmRzLnRzIiwgIi4uL2F1ZGlvLnRzIiwgIi4uL3JlcGxheS50cyIsICIuLi9zY3JvbGwudHMiLCAiLi4vdWkudHMiLCAiLi4vd2FrZUNsaWVudC50cyIsICIuLi9hcHAudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFNwb2tlbiBjb21tYW5kcyB0aGUgY29yZSBhY3RzIG9uIHdpdGhvdXQgdGhlIG1vZGVsOiBcInN0b3BcIiBhbmQgXCJoYW5nIHVwXCIuIEFuIHV0dGVyYW5jZSBjb3VudHNcbi8vIG9ubHkgd2hlbiBpdCBpcyBvbmUgb2YgdGhlIHBocmFzZXMgYW5kIG5vdGhpbmcgbW9yZSwgb25jZSBuYW1lcyBhbmQgZmlsbGVycyBhcm91bmQgaXQgYXJlIGdvbmUsXG4vLyBzbyBcIldvb2Rob3VzZSwgc3RvcCBwbGVhc2VcIiBzdG9wcyBhbmQgXCJzdG9wIHRoZSBQZW5ueXdvcnRoIHRhc2tcIiBnb2VzIHRvIHRoZSBtb2RlbCBhcyB1c3VhbC5cblxuaW1wb3J0IHR5cGUgeyBWb2ljZUNvbW1hbmRzIH0gZnJvbSBcIi4vdHlwZXMudHNcIjtcblxuZXhwb3J0IHR5cGUgVm9pY2VDb21tYW5kID0gXCJzdG9wXCIgfCBcImhhbmdVcFwiIHwgXCJjYW5jZWxBbGxcIjtcblxuLyoqIFdvcmRzIHRoYXQgbWF5IGNvbWUgYmVmb3JlIG9yIGFmdGVyIGEgY29tbWFuZCB3aXRob3V0IGNoYW5naW5nIGl0LiAqL1xuY29uc3QgRklMTEVSID0gbmV3IFNldChbXG4gIFwiaGV5XCIsIFwib2tcIiwgXCJva2F5XCIsIFwicGxlYXNlXCIsIFwibm93XCIsIFwianVzdFwiLCBcInNvXCIsIFwidW1cIiwgXCJ1aFwiLCBcIm9oXCIsIFwiYWxyaWdodFwiLCBcInJpZ2h0XCIsIFwieWVhaFwiLCBcInllc1wiLCBcInRoYW5rc1wiLCBcInRoYW5rXCIsIFwieW91XCIsXG4gIFwiZ2VtaW5pXCIsXG5dKTtcblxuLyoqIFt0ZXh0XSBhcyBsb3dlci1jYXNlIHdvcmRzLCBhcG9zdHJvcGhlcyBkcm9wcGVkIChcIlRoYXQnc1wiIGlzIFwidGhhdHNcIikuICovXG5leHBvcnQgZnVuY3Rpb24gd29yZHModGV4dDogc3RyaW5nKTogc3RyaW5nW10ge1xuICByZXR1cm4gdGV4dC50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL1snXHUyMDE5YF0vZywgXCJcIikucmVwbGFjZSgvW15cXHB7TH1cXHB7TmR9XSsvZ3UsIFwiIFwiKS50cmltKCkuc3BsaXQoXCIgXCIpLmZpbHRlcigodykgPT4gdy5sZW5ndGggPiAwKTtcbn1cblxuLyoqIFRoZSBjb21tYW5kIFt1dHRlcmFuY2VdIGlzLCBpZiBpdCdzIG9uZSBhbmQgbm90aGluZyBtb3JlOyBbbmFtZXNdICh0aGUgYXNzaXN0YW50J3MsIFwiV29vZGhvdXNlXCIpIGRvbid0IGNvdW50LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbW1hbmRJbih1dHRlcmFuY2U6IHN0cmluZywgY29tbWFuZHM6IFZvaWNlQ29tbWFuZHMsIG5hbWVzOiBzdHJpbmdbXSA9IFtdKTogVm9pY2VDb21tYW5kIHwgbnVsbCB7XG4gIGNvbnN0IGlnbm9yZWQgPSBuZXcgU2V0KFsuLi5GSUxMRVIsIC4uLm5hbWVzLmZsYXRNYXAod29yZHMpXSk7XG4gIGNvbnN0IHNhaWQgPSB3b3Jkcyh1dHRlcmFuY2UpO1xuICBsZXQgZnJvbSA9IDA7XG4gIGxldCB0byA9IHNhaWQubGVuZ3RoO1xuICB3aGlsZSAoZnJvbSA8IHRvICYmIGlnbm9yZWQuaGFzKHNhaWRbZnJvbV0pKSBmcm9tKys7XG4gIHdoaWxlICh0byA+IGZyb20gJiYgaWdub3JlZC5oYXMoc2FpZFt0byAtIDFdKSkgdG8tLTtcbiAgaWYgKGZyb20gPT09IHRvIHx8IHRvIC0gZnJvbSA+IDUpIHJldHVybiBudWxsO1xuICBjb25zdCBjb3JlID0gc2FpZC5zbGljZShmcm9tLCB0bykuam9pbihcIiBcIik7XG4gIGNvbnN0IGlzID0gKHBocmFzZXM6IHN0cmluZ1tdKSA9PiBwaHJhc2VzLnNvbWUoKHApID0+IHdvcmRzKHApLmpvaW4oXCIgXCIpID09PSBjb3JlKTtcbiAgaWYgKGlzKGNvbW1hbmRzLmhhbmdVcCkpIHJldHVybiBcImhhbmdVcFwiO1xuICBpZiAoaXMoY29tbWFuZHMuY2FuY2VsQWxsID8/IFtdKSkgcmV0dXJuIFwiY2FuY2VsQWxsXCI7XG4gIGlmIChpcyhjb21tYW5kcy5zdG9wKSkgcmV0dXJuIFwic3RvcFwiO1xuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqIFdvcmRzIHRoYXQgdGFrZSBhIHJlcXVlc3QgYmFjay4gKi9cbmNvbnN0IENBTkNFTFMgPSAvXFxiKD86Y2FuY2VsXFx3KnxhYm9ydFxcdyp8a2lsbHxzY3JhcHxzY3JhdGNofGRyb3B8Zm9yZ2V0fHVuZG98dGVybWluYXRlfG5ldmVyID9taW5kfGNhbGwgKD86aXR8dGhhdHx0aGlzKSBvZmZ8KD86ZG9udHxkbyBub3QpICg/OmJvdGhlcnxuZWVkfHdhbnR8ZG8pfG5vIG5lZWR8bm8gbG9uZ2VyfG5vdCBhbnltb3JlfGxlYXZlIGl0fHNraXAgKD86aXR8dGhhdCkpXFxiLztcbmNvbnN0IFNUT1BTID0gL1xcYig/OnN0b3BcXHcqfGhhbHR8cXVpdHxlbmQpXFxiLztcblxuLyoqXG4gKiBXaGV0aGVyIFt1dHRlcmFuY2VdIGFza3MgZm9yIGEgdGFzayB0byBiZSBjYW5jZWxsZWQsIGZvciBhIGNhbmNlbF90YXNrIHRoZSBtb2RlbCBjYWxsZWQgb24gaXQuIFwiU3RvcFwiIGFsb25lIGFuZCB0aGVcbiAqIG90aGVyIHN0b3AgYW5kIGhhbmctdXAgcGhyYXNlcyBkb24ndDogdGhleSBtZWFuIHN0b3AgdGFsa2luZy4gT3RoZXJ3aXNlIGl0IGRvZXMgd2hlbiBpdCBzYXlzIHNvIGluIHdvcmRzLCB3aGVuIGl0XG4gKiBuYW1lcyB0aGUgdGFzayAoW25hbWVkXSksIG9yIHdoZW4gaXQgc2F5cyB0byBzdG9wIHNvbWV0aGluZyBtb3JlIHRoYW4gdGhlIHRhbGtpbmcgKFwic3RvcCB3b3JraW5nIG9uIHRoYXRcIikuXG4gKiBXb3JkcyB0aGF0IHNheSBub25lIG9mIHRoaXMgKGEgbWlzaGVhcmluZyBzdWNoIGFzIFwiU3RhYml0XCIpIGRvbid0LiBXaXRoIG5vdGhpbmcgaGVhcmQgdGhlcmUgaXMgbm90aGluZyB0byBqdWRnZSBieS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFza3NUb0NhbmNlbCh1dHRlcmFuY2U6IHN0cmluZywgY29tbWFuZHM6IFZvaWNlQ29tbWFuZHMsIG5hbWVzOiBzdHJpbmdbXSwgbmFtZWQ6IGJvb2xlYW4pOiBib29sZWFuIHtcbiAgY29uc3Qgc2FpZCA9IHdvcmRzKHV0dGVyYW5jZSkuam9pbihcIiBcIik7XG4gIGlmIChzYWlkLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHRydWU7XG4gIGNvbnN0IGNvbW1hbmQgPSBjb21tYW5kSW4odXR0ZXJhbmNlLCBjb21tYW5kcywgbmFtZXMpO1xuICBpZiAoY29tbWFuZCA9PT0gXCJzdG9wXCIgfHwgY29tbWFuZCA9PT0gXCJoYW5nVXBcIikgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gY29tbWFuZCA9PT0gXCJjYW5jZWxBbGxcIiB8fCBuYW1lZCB8fCBDQU5DRUxTLnRlc3Qoc2FpZCkgfHwgU1RPUFMudGVzdChzYWlkKTtcbn1cbiIsICIvLyBUaGUgYnJvd3NlcidzIG1pY3JvcGhvbmUgYW5kIHNwZWFrZXIgZm9yIGEgY2FsbDogMTYga0h6IFBDTTE2IGZyYW1lcyBvdXQgb2YgdGhlIG1pY3JvcGhvbmUsXG4vLyAyNCBrSHogUENNMTYgaW50byB0aGUgc3BlYWtlciwgYW5kIHRvbmVzIGxhaWQgb3ZlciB3aGF0ZXZlciBwbGF5cy4gQm90aCBydW4gaW4gQXVkaW9Xb3JrbGV0cyBvblxuLy8gb25lIEF1ZGlvQ29udGV4dCBhdCB0aGUgZGV2aWNlJ3MgcmF0ZSwgcmVzYW1wbGluZyB0aGVyZS5cblxuY29uc3QgV09SS0xFVFMgPSBgXG5jbGFzcyBDYXB0dXJlIGV4dGVuZHMgQXVkaW9Xb3JrbGV0UHJvY2Vzc29yIHtcbiAgY29uc3RydWN0b3IoKSB7XG4gICAgc3VwZXIoKTtcbiAgICB0aGlzLnN0ZXAgPSBzYW1wbGVSYXRlIC8gMTYwMDA7XG4gICAgdGhpcy5wb3MgPSAwO1xuICAgIHRoaXMuZnJhbWUgPSBuZXcgSW50MTZBcnJheSgzMjApO1xuICAgIHRoaXMubiA9IDA7XG4gICAgLy8gQSB3aW5kb3dlZC1zaW5jIGxvdy1wYXNzIGF0IDcga0h6LCBzbyBub3RoaW5nIGFib3ZlIDE2IGtIeidzIDgga0h6IGxpbWl0IGZvbGRzIGJhY2sgaW50byBzcGVlY2guXG4gICAgY29uc3QgdGFwcyA9IDQ3LCBjdXQgPSA3MDAwIC8gc2FtcGxlUmF0ZTtcbiAgICB0aGlzLnRhcHMgPSBuZXcgRmxvYXQzMkFycmF5KHRhcHMpO1xuICAgIGxldCBzdW0gPSAwO1xuICAgIGZvciAobGV0IGsgPSAwOyBrIDwgdGFwczsgaysrKSB7XG4gICAgICBjb25zdCBtID0gayAtICh0YXBzIC0gMSkgLyAyO1xuICAgICAgY29uc3Qgc2luYyA9IG0gPT09IDAgPyAyICogY3V0IDogTWF0aC5zaW4oMiAqIE1hdGguUEkgKiBjdXQgKiBtKSAvIChNYXRoLlBJICogbSk7XG4gICAgICBjb25zdCB3ID0gMC40MiAtIDAuNSAqIE1hdGguY29zKCgyICogTWF0aC5QSSAqIGspIC8gKHRhcHMgLSAxKSkgKyAwLjA4ICogTWF0aC5jb3MoKDQgKiBNYXRoLlBJICogaykgLyAodGFwcyAtIDEpKTtcbiAgICAgIHRoaXMudGFwc1trXSA9IHNpbmMgKiB3O1xuICAgICAgc3VtICs9IHRoaXMudGFwc1trXTtcbiAgICB9XG4gICAgZm9yIChsZXQgayA9IDA7IGsgPCB0YXBzOyBrKyspIHRoaXMudGFwc1trXSAvPSBzdW07XG4gICAgdGhpcy5oaXN0b3J5ID0gbmV3IEZsb2F0MzJBcnJheSh0YXBzKTtcbiAgICB0aGlzLmF0ID0gMDtcbiAgfVxuICBwcm9jZXNzKGlucHV0cykge1xuICAgIGNvbnN0IGlucHV0ID0gaW5wdXRzWzBdICYmIGlucHV0c1swXVswXTtcbiAgICBpZiAoIWlucHV0KSByZXR1cm4gdHJ1ZTtcbiAgICBjb25zdCB0YXBzID0gdGhpcy50YXBzLCBoID0gdGhpcy5oaXN0b3J5LCBuID0gdGFwcy5sZW5ndGg7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBpbnB1dC5sZW5ndGg7IGkrKykge1xuICAgICAgaFt0aGlzLmF0XSA9IGlucHV0W2ldO1xuICAgICAgdGhpcy5hdCA9ICh0aGlzLmF0ICsgMSkgJSBuO1xuICAgICAgLy8gT25seSB0aGUgc2FtcGxlcyBrZXB0IG5lZWQgZmlsdGVyaW5nOiBhdCBtb3N0IG9uZSBpbiBldmVyeSBzdGVwLlxuICAgICAgaWYgKHRoaXMucG9zID4gMSkgeyB0aGlzLnBvcyAtPSAxOyBjb250aW51ZTsgfVxuICAgICAgbGV0IHggPSAwO1xuICAgICAgZm9yIChsZXQgayA9IDAsIGogPSB0aGlzLmF0OyBrIDwgbjsgaysrLCBqID0gaiArIDEgPT09IG4gPyAwIDogaiArIDEpIHggKz0gdGFwc1trXSAqIGhbal07XG4gICAgICB3aGlsZSAodGhpcy5wb3MgPD0gMSkge1xuICAgICAgICBjb25zdCBzID0gTWF0aC5tYXgoLTEsIE1hdGgubWluKDEsIHgpKTtcbiAgICAgICAgdGhpcy5mcmFtZVt0aGlzLm4rK10gPSBzIDwgMCA/IHMgKiAzMjc2OCA6IHMgKiAzMjc2NztcbiAgICAgICAgaWYgKHRoaXMubiA9PT0gdGhpcy5mcmFtZS5sZW5ndGgpIHtcbiAgICAgICAgICB0aGlzLnBvcnQucG9zdE1lc3NhZ2UodGhpcy5mcmFtZS5idWZmZXIsIFt0aGlzLmZyYW1lLmJ1ZmZlcl0pO1xuICAgICAgICAgIHRoaXMuZnJhbWUgPSBuZXcgSW50MTZBcnJheSgzMjApO1xuICAgICAgICAgIHRoaXMubiA9IDA7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5wb3MgKz0gdGhpcy5zdGVwO1xuICAgICAgfVxuICAgICAgdGhpcy5wb3MgLT0gMTtcbiAgICB9XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbn1cblxuY2xhc3MgUGxheWJhY2sgZXh0ZW5kcyBBdWRpb1dvcmtsZXRQcm9jZXNzb3Ige1xuICBjb25zdHJ1Y3RvcigpIHtcbiAgICBzdXBlcigpO1xuICAgIHRoaXMucXVldWUgPSBbXTsgICAgICAvLyBGbG9hdDMyQXJyYXlzIGF0IHRoZSBjb250ZXh0J3MgcmF0ZVxuICAgIHRoaXMub2Zmc2V0ID0gMDtcbiAgICB0aGlzLmN1ZXMgPSBbXTtcbiAgICB0aGlzLmN1ZU9mZnNldCA9IDA7XG4gICAgdGhpcy5yZXBvcnRlZCA9IDA7XG4gICAgdGhpcy5wb3J0Lm9ubWVzc2FnZSA9IChlKSA9PiB7XG4gICAgICBjb25zdCBtID0gZS5kYXRhO1xuICAgICAgaWYgKG0udHlwZSA9PT0gXCJwbGF5XCIpIHRoaXMucXVldWUucHVzaChtLnNhbXBsZXMpO1xuICAgICAgZWxzZSBpZiAobS50eXBlID09PSBcImN1ZVwiKSB0aGlzLmN1ZXMucHVzaChtLnNhbXBsZXMpO1xuICAgICAgZWxzZSBpZiAobS50eXBlID09PSBcImZsdXNoXCIpIHsgdGhpcy5xdWV1ZSA9IFtdOyB0aGlzLm9mZnNldCA9IDA7IH1cbiAgICAgIGVsc2UgaWYgKG0udHlwZSA9PT0gXCJzdG9wXCIpIHsgdGhpcy5xdWV1ZSA9IFtdOyB0aGlzLm9mZnNldCA9IDA7IHRoaXMuY3VlcyA9IFtdOyB0aGlzLmN1ZU9mZnNldCA9IDA7IH1cbiAgICB9O1xuICB9XG4gIHByb2Nlc3MoXywgb3V0cHV0cykge1xuICAgIGNvbnN0IG91dCA9IG91dHB1dHNbMF1bMF07XG4gICAgb3V0LmZpbGwoMCk7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoICYmIHRoaXMucXVldWUubGVuZ3RoOyBpKyspIHtcbiAgICAgIG91dFtpXSA9IHRoaXMucXVldWVbMF1bdGhpcy5vZmZzZXQrK107XG4gICAgICBpZiAodGhpcy5vZmZzZXQgPj0gdGhpcy5xdWV1ZVswXS5sZW5ndGgpIHsgdGhpcy5xdWV1ZS5zaGlmdCgpOyB0aGlzLm9mZnNldCA9IDA7IH1cbiAgICB9XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoICYmIHRoaXMuY3Vlcy5sZW5ndGg7IGkrKykge1xuICAgICAgb3V0W2ldID0gTWF0aC5tYXgoLTEsIE1hdGgubWluKDEsIG91dFtpXSArIHRoaXMuY3Vlc1swXVt0aGlzLmN1ZU9mZnNldCsrXSkpO1xuICAgICAgaWYgKHRoaXMuY3VlT2Zmc2V0ID49IHRoaXMuY3Vlc1swXS5sZW5ndGgpIHsgdGhpcy5jdWVzLnNoaWZ0KCk7IHRoaXMuY3VlT2Zmc2V0ID0gMDsgfVxuICAgIH1cbiAgICBmb3IgKGxldCBjID0gMTsgYyA8IG91dHB1dHNbMF0ubGVuZ3RoOyBjKyspIG91dHB1dHNbMF1bY10uc2V0KG91dCk7XG4gICAgaWYgKGN1cnJlbnRUaW1lIC0gdGhpcy5yZXBvcnRlZCA+IDAuMSkge1xuICAgICAgdGhpcy5yZXBvcnRlZCA9IGN1cnJlbnRUaW1lO1xuICAgICAgbGV0IHF1ZXVlZCA9IC10aGlzLm9mZnNldDtcbiAgICAgIGZvciAoY29uc3QgcSBvZiB0aGlzLnF1ZXVlKSBxdWV1ZWQgKz0gcS5sZW5ndGg7XG4gICAgICB0aGlzLnBvcnQucG9zdE1lc3NhZ2UoeyBxdWV1ZWQ6IHF1ZXVlZCAvIHNhbXBsZVJhdGUgfSk7XG4gICAgfVxuICAgIHJldHVybiB0cnVlO1xuICB9XG59XG5yZWdpc3RlclByb2Nlc3NvcihcImNhcHR1cmVcIiwgQ2FwdHVyZSk7XG5yZWdpc3RlclByb2Nlc3NvcihcInBsYXliYWNrXCIsIFBsYXliYWNrKTtcbmA7XG5cbmZ1bmN0aW9uIGJhc2U2NFRvQnl0ZXMoYjY0OiBzdHJpbmcpOiBVaW50OEFycmF5IHtcbiAgY29uc3QgYmluID0gYXRvYihiNjQpO1xuICBjb25zdCBvdXQgPSBuZXcgVWludDhBcnJheShiaW4ubGVuZ3RoKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBiaW4ubGVuZ3RoOyBpKyspIG91dFtpXSA9IGJpbi5jaGFyQ29kZUF0KGkpO1xuICByZXR1cm4gb3V0O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYnl0ZXNUb0Jhc2U2NChieXRlczogVWludDhBcnJheSk6IHN0cmluZyB7XG4gIGxldCBiaW4gPSBcIlwiO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGJ5dGVzLmxlbmd0aDsgaSArPSAweDgwMDApIGJpbiArPSBTdHJpbmcuZnJvbUNoYXJDb2RlKC4uLmJ5dGVzLnN1YmFycmF5KGksIGkgKyAweDgwMDApKTtcbiAgcmV0dXJuIGJ0b2EoYmluKTtcbn1cblxuLyoqIFBDTTE2IGxpdHRsZS1lbmRpYW4gYXQgW3JhdGVdLCBhcyBmbG9hdHMgYXQgdGhlIGNvbnRleHQncyByYXRlLiAqL1xuZnVuY3Rpb24gdG9GbG9hdHMocGNtOiBVaW50OEFycmF5LCByYXRlOiBudW1iZXIsIHRhcmdldDogbnVtYmVyKTogRmxvYXQzMkFycmF5IHtcbiAgY29uc3QgdmlldyA9IG5ldyBEYXRhVmlldyhwY20uYnVmZmVyLCBwY20uYnl0ZU9mZnNldCwgcGNtLmJ5dGVMZW5ndGgpO1xuICBjb25zdCBuID0gTWF0aC5mbG9vcihwY20uYnl0ZUxlbmd0aCAvIDIpO1xuICBjb25zdCBvdXQgPSBuZXcgRmxvYXQzMkFycmF5KE1hdGguZmxvb3IoKG4gKiB0YXJnZXQpIC8gcmF0ZSkpO1xuICBjb25zdCBzdGVwID0gcmF0ZSAvIHRhcmdldDtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCB4ID0gaSAqIHN0ZXA7XG4gICAgY29uc3QgaiA9IE1hdGguZmxvb3IoeCk7XG4gICAgY29uc3QgYSA9IHZpZXcuZ2V0SW50MTYoMiAqIE1hdGgubWluKGosIG4gLSAxKSwgdHJ1ZSk7XG4gICAgY29uc3QgYiA9IHZpZXcuZ2V0SW50MTYoMiAqIE1hdGgubWluKGogKyAxLCBuIC0gMSksIHRydWUpO1xuICAgIG91dFtpXSA9IChhICsgKGIgLSBhKSAqICh4IC0gaikpIC8gMzI3Njg7XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBNaWNPcHRpb25zIHsgZWNob0NhbmNlbGxhdGlvbjogYm9vbGVhbjsgbm9pc2VTdXBwcmVzc2lvbjogYm9vbGVhbjsgYXV0b0dhaW5Db250cm9sOiBib29sZWFuIH1cblxuZXhwb3J0IGNsYXNzIENhbGxBdWRpbyB7XG4gIHByaXZhdGUgY29udGV4dDogQXVkaW9Db250ZXh0IHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgcGxheWJhY2s6IEF1ZGlvV29ya2xldE5vZGUgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBjYXB0dXJlOiBBdWRpb1dvcmtsZXROb2RlIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgc3RyZWFtOiBNZWRpYVN0cmVhbSB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIHNvdXJjZTogTWVkaWFTdHJlYW1BdWRpb1NvdXJjZU5vZGUgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBtaWNPcHRzOiBNaWNPcHRpb25zIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgb25NaWNGcmFtZTogKChzYW1wbGVzOiBJbnQxNkFycmF5LCBsZXZlbDogbnVtYmVyKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuICAvKiogSW5jcmVtZW50ZWQgb24gZXZlcnkgc3RhcnRNaWMvc3RvcE1pYyBzbyBzdXBlcnNlZGVkIG9yIGNhbmNlbGxlZCBnZXRVc2VyTWVkaWEgY2FsbHMgbmV2ZXIgbGVhayB0cmFja3MuICovXG4gIHByaXZhdGUgbWljR2VuID0gMDtcbiAgcHJpdmF0ZSBvcGVuaW5nOiBQcm9taXNlPHZvaWQ+IHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgc3RhdGVMaXN0ZW5lcjogKCgpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XG4gIC8qKiBTZWNvbmRzIG9mIHNwZWVjaCBxdWV1ZWQsIGFzIHRoZSB3b3JrbGV0IGxhc3Qgc2FpZC4gKi9cbiAgcXVldWVkID0gMDtcbiAgLyoqIFRoZSBtaWNyb3Bob25lJ3MgbGV2ZWwsIFJNUyBvZiB0aGUgbGFzdCBmcmFtZSAoMCB0byAxKS4gKi9cbiAgbGV2ZWwgPSAwO1xuXG4gIG9uQXVkaW9TdGF0ZUNoYW5nZShsaXN0ZW5lcjogKCgpID0+IHZvaWQpIHwgbnVsbCk6IHZvaWQge1xuICAgIHRoaXMuc3RhdGVMaXN0ZW5lciA9IGxpc3RlbmVyO1xuICB9XG5cbiAgLyoqIFRydWUgd2hlbiBhbiBBdWRpb0NvbnRleHQgZXhpc3RzIGJ1dCB0aGUgYnJvd3NlciBzdXNwZW5kZWQgaXQgcGVuZGluZyBhIHVzZXIgZ2VzdHVyZS4gKi9cbiAgZ2V0IGF1ZGlvU3VzcGVuZGVkKCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLmNvbnRleHQgIT0gbnVsbCAmJiB0aGlzLmNvbnRleHQuc3RhdGUgIT09IFwicnVubmluZ1wiO1xuICB9XG5cbiAgYXN5bmMgcmVzdW1lQXVkaW8oKTogUHJvbWlzZTxib29sZWFuPiB7XG4gICAgY29uc3QgY3R4ID0gdGhpcy5jb250ZXh0O1xuICAgIGlmICghY3R4KSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKGN0eC5zdGF0ZSA9PT0gXCJydW5uaW5nXCIpIHJldHVybiB0cnVlO1xuICAgIHRyeSB7IGF3YWl0IGN0eC5yZXN1bWUoKTsgfSBjYXRjaCB7fVxuICAgIHJldHVybiAoY3R4LnN0YXRlIGFzIEF1ZGlvQ29udGV4dFN0YXRlKSA9PT0gXCJydW5uaW5nXCI7XG4gIH1cblxuICBhc3luYyBvcGVuKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICh0aGlzLm9wZW5pbmcpIHtcbiAgICAgIGF3YWl0IHRoaXMub3BlbmluZztcbiAgICAgIGlmICh0aGlzLmNvbnRleHQ/LnN0YXRlID09PSBcInN1c3BlbmRlZFwiKSBhd2FpdCB0aGlzLmNvbnRleHQucmVzdW1lKCkuY2F0Y2goKCkgPT4ge30pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAodGhpcy5jb250ZXh0KSB7IGlmICh0aGlzLmNvbnRleHQuc3RhdGUgPT09IFwic3VzcGVuZGVkXCIpIGF3YWl0IHRoaXMuY29udGV4dC5yZXN1bWUoKS5jYXRjaCgoKSA9PiB7fSk7IHJldHVybjsgfVxuICAgIGNvbnN0IGluaXQgPSAoYXN5bmMgKCkgPT4ge1xuICAgICAgbGV0IGN0eDogQXVkaW9Db250ZXh0IHwgbnVsbCA9IG51bGw7XG4gICAgICB0cnkge1xuICAgICAgICBjdHggPSBuZXcgQXVkaW9Db250ZXh0KHsgbGF0ZW5jeUhpbnQ6IFwiaW50ZXJhY3RpdmVcIiB9KTtcbiAgICAgICAgY3R4Lm9uc3RhdGVjaGFuZ2UgPSAoKSA9PiB0aGlzLnN0YXRlTGlzdGVuZXI/LigpO1xuICAgICAgICBjb25zdCB1cmwgPSBVUkwuY3JlYXRlT2JqZWN0VVJMKG5ldyBCbG9iKFtXT1JLTEVUU10sIHsgdHlwZTogXCJ0ZXh0L2phdmFzY3JpcHRcIiB9KSk7XG4gICAgICAgIGF3YWl0IGN0eC5hdWRpb1dvcmtsZXQuYWRkTW9kdWxlKHVybCk7XG4gICAgICAgIGNvbnN0IHBsYXliYWNrID0gbmV3IEF1ZGlvV29ya2xldE5vZGUoY3R4LCBcInBsYXliYWNrXCIsIHsgbnVtYmVyT2ZJbnB1dHM6IDAsIG91dHB1dENoYW5uZWxDb3VudDogWzJdIH0pO1xuICAgICAgICBwbGF5YmFjay5wb3J0Lm9ubWVzc2FnZSA9IChlKSA9PiB7IHRoaXMucXVldWVkID0gZS5kYXRhLnF1ZXVlZDsgfTtcbiAgICAgICAgcGxheWJhY2suY29ubmVjdChjdHguZGVzdGluYXRpb24pO1xuICAgICAgICB0aGlzLmNvbnRleHQgPSBjdHg7XG4gICAgICAgIHRoaXMucGxheWJhY2sgPSBwbGF5YmFjaztcbiAgICAgICAgdGhpcy5zdGF0ZUxpc3RlbmVyPy4oKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICB0cnkgeyBhd2FpdCBjdHg/LmNsb3NlPy4oKTsgfSBjYXRjaCB7fVxuICAgICAgICB0aHJvdyBlcnI7XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICB0aGlzLm9wZW5pbmcgPSBudWxsO1xuICAgICAgfVxuICAgIH0pKCk7XG4gICAgdGhpcy5vcGVuaW5nID0gaW5pdDtcbiAgICBhd2FpdCBpbml0O1xuICB9XG5cbiAgLyoqIFNlY29uZHMgZnJvbSBhIHNhbXBsZSBsZWF2aW5nIHRoZSB3b3JrbGV0IHRvIHRoZSBzcGVha2VyLCBhcyB0aGUgYnJvd3NlciByZWNrb25zIGl0LiAqL1xuICBnZXQgb3V0cHV0TGF0ZW5jeSgpOiBudW1iZXIgfCBudWxsIHtcbiAgICBpZiAoIXRoaXMuY29udGV4dCkgcmV0dXJuIG51bGw7XG4gICAgcmV0dXJuIHRoaXMuY29udGV4dC5iYXNlTGF0ZW5jeSArICgodGhpcy5jb250ZXh0IGFzIEF1ZGlvQ29udGV4dCAmIHsgb3V0cHV0TGF0ZW5jeT86IG51bWJlciB9KS5vdXRwdXRMYXRlbmN5ID8/IDApO1xuICB9XG5cbiAgZ2V0IG1pY0FjdGl2ZSgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5jYXB0dXJlICE9IG51bGwgJiYgdGhpcy5zdHJlYW0gIT0gbnVsbCAmJiB0aGlzLnN0cmVhbS5nZXRUcmFja3MoKS5zb21lKCh0KSA9PiB0LnJlYWR5U3RhdGUgPT09IFwibGl2ZVwiKTtcbiAgfVxuXG4gIC8qKiBTdGFydHMgdGhlIG1pY3JvcGhvbmUgaWYgaXQgaXNuJ3QgYWxyZWFkeSBydW5uaW5nIHdpdGggdGhlIHNhbWUgb3B0aW9uczsgb3RoZXJ3aXNlIHN3YXBzIHRoZSBmcmFtZSBjYWxsYmFjayBjbGVhbmx5LiAqL1xuICBhc3luYyBlbnN1cmVNaWMob25GcmFtZTogKHNhbXBsZXM6IEludDE2QXJyYXksIGxldmVsOiBudW1iZXIpID0+IHZvaWQsIG9wdGlvbnM6IE1pY09wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAoXG4gICAgICB0aGlzLm1pY0FjdGl2ZSAmJlxuICAgICAgdGhpcy5taWNPcHRzICYmXG4gICAgICB0aGlzLm1pY09wdHMuZWNob0NhbmNlbGxhdGlvbiA9PT0gb3B0aW9ucy5lY2hvQ2FuY2VsbGF0aW9uICYmXG4gICAgICB0aGlzLm1pY09wdHMubm9pc2VTdXBwcmVzc2lvbiA9PT0gb3B0aW9ucy5ub2lzZVN1cHByZXNzaW9uICYmXG4gICAgICB0aGlzLm1pY09wdHMuYXV0b0dhaW5Db250cm9sID09PSBvcHRpb25zLmF1dG9HYWluQ29udHJvbFxuICAgICkge1xuICAgICAgYXdhaXQgdGhpcy5vcGVuKCk7XG4gICAgICB0aGlzLm9uTWljRnJhbWUgPSBvbkZyYW1lO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBhd2FpdCB0aGlzLnN0YXJ0TWljKG9uRnJhbWUsIG9wdGlvbnMpO1xuICB9XG5cbiAgYXN5bmMgc3RhcnRNaWMob25GcmFtZTogKHNhbXBsZXM6IEludDE2QXJyYXksIGxldmVsOiBudW1iZXIpID0+IHZvaWQsIG9wdGlvbnM6IE1pY09wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICB0aGlzLnN0b3BNaWMoKTtcbiAgICBjb25zdCBnZW4gPSArK3RoaXMubWljR2VuO1xuICAgIGF3YWl0IHRoaXMub3BlbigpO1xuICAgIGlmIChnZW4gIT09IHRoaXMubWljR2VuKSByZXR1cm47XG4gICAgY29uc3QgY29udGV4dCA9IHRoaXMuY29udGV4dCE7XG4gICAgY29uc3Qgc3RyZWFtID0gYXdhaXQgbmF2aWdhdG9yLm1lZGlhRGV2aWNlcy5nZXRVc2VyTWVkaWEoeyBhdWRpbzogeyBjaGFubmVsQ291bnQ6IDEsIC4uLm9wdGlvbnMgfSB9KTtcbiAgICBpZiAoZ2VuICE9PSB0aGlzLm1pY0dlbikge1xuICAgICAgc3RyZWFtLmdldFRyYWNrcygpLmZvckVhY2goKHQpID0+IHQuc3RvcCgpKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgbGV0IHNvdXJjZTogTWVkaWFTdHJlYW1BdWRpb1NvdXJjZU5vZGUgfCBudWxsID0gbnVsbDtcbiAgICBsZXQgY2FwdHVyZTogQXVkaW9Xb3JrbGV0Tm9kZSB8IG51bGwgPSBudWxsO1xuICAgIHRyeSB7XG4gICAgICBzb3VyY2UgPSBjb250ZXh0LmNyZWF0ZU1lZGlhU3RyZWFtU291cmNlKHN0cmVhbSk7XG4gICAgICBjYXB0dXJlID0gbmV3IEF1ZGlvV29ya2xldE5vZGUoY29udGV4dCwgXCJjYXB0dXJlXCIsIHsgbnVtYmVyT2ZPdXRwdXRzOiAwIH0pO1xuICAgICAgY2FwdHVyZS5wb3J0Lm9ubWVzc2FnZSA9IChlKSA9PiB7XG4gICAgICAgIGNvbnN0IGZyYW1lID0gbmV3IEludDE2QXJyYXkoZS5kYXRhIGFzIEFycmF5QnVmZmVyKTtcbiAgICAgICAgbGV0IHN1bSA9IDA7XG4gICAgICAgIGZvciAoY29uc3QgcyBvZiBmcmFtZSkgc3VtICs9IHMgKiBzO1xuICAgICAgICB0aGlzLmxldmVsID0gTWF0aC5zcXJ0KHN1bSAvIGZyYW1lLmxlbmd0aCkgLyAzMjc2ODtcbiAgICAgICAgdGhpcy5vbk1pY0ZyYW1lPy4oZnJhbWUsIHRoaXMubGV2ZWwpO1xuICAgICAgfTtcbiAgICAgIHNvdXJjZS5jb25uZWN0KGNhcHR1cmUpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgc291cmNlPy5kaXNjb25uZWN0KCk7XG4gICAgICBjYXB0dXJlPy5wb3J0LmNsb3NlKCk7XG4gICAgICBzdHJlYW0uZ2V0VHJhY2tzKCkuZm9yRWFjaCgodCkgPT4gdC5zdG9wKCkpO1xuICAgICAgdGhyb3cgZXJyO1xuICAgIH1cbiAgICB0aGlzLnN0cmVhbSA9IHN0cmVhbTtcbiAgICB0aGlzLm1pY09wdHMgPSB7IC4uLm9wdGlvbnMgfTtcbiAgICB0aGlzLm9uTWljRnJhbWUgPSBvbkZyYW1lO1xuICAgIHRoaXMuc291cmNlID0gc291cmNlO1xuICAgIHRoaXMuY2FwdHVyZSA9IGNhcHR1cmU7XG4gIH1cblxuICBzdG9wTWljKCk6IHZvaWQge1xuICAgIHRoaXMubWljR2VuKys7XG4gICAgdGhpcy5zb3VyY2U/LmRpc2Nvbm5lY3QoKTtcbiAgICB0aGlzLmNhcHR1cmU/LnBvcnQuY2xvc2UoKTtcbiAgICB0aGlzLnN0cmVhbT8uZ2V0VHJhY2tzKCkuZm9yRWFjaCgodCkgPT4gdC5zdG9wKCkpO1xuICAgIHRoaXMuc291cmNlID0gbnVsbDtcbiAgICB0aGlzLmNhcHR1cmUgPSBudWxsO1xuICAgIHRoaXMuc3RyZWFtID0gbnVsbDtcbiAgICB0aGlzLm1pY09wdHMgPSBudWxsO1xuICAgIHRoaXMub25NaWNGcmFtZSA9IG51bGw7XG4gICAgdGhpcy5sZXZlbCA9IDA7XG4gIH1cblxuICBwbGF5KHBjbTY0OiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuY29udGV4dCB8fCAhdGhpcy5wbGF5YmFjaykgcmV0dXJuO1xuICAgIGNvbnN0IHNhbXBsZXMgPSB0b0Zsb2F0cyhiYXNlNjRUb0J5dGVzKHBjbTY0KSwgMjQwMDAsIHRoaXMuY29udGV4dC5zYW1wbGVSYXRlKTtcbiAgICB0aGlzLnBsYXliYWNrLnBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcInBsYXlcIiwgc2FtcGxlcyB9LCBbc2FtcGxlcy5idWZmZXJdKTtcbiAgfVxuXG4gIGN1ZShwY202NDogc3RyaW5nKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLmNvbnRleHQgfHwgIXRoaXMucGxheWJhY2spIHJldHVybjtcbiAgICBjb25zdCBzYW1wbGVzID0gdG9GbG9hdHMoYmFzZTY0VG9CeXRlcyhwY202NCksIDI0MDAwLCB0aGlzLmNvbnRleHQuc2FtcGxlUmF0ZSk7XG4gICAgdGhpcy5wbGF5YmFjay5wb3J0LnBvc3RNZXNzYWdlKHsgdHlwZTogXCJjdWVcIiwgc2FtcGxlcyB9LCBbc2FtcGxlcy5idWZmZXJdKTtcbiAgfVxuXG4gIGZsdXNoKCk6IHZvaWQge1xuICAgIHRoaXMucGxheWJhY2s/LnBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcImZsdXNoXCIgfSk7XG4gIH1cblxuICBzdG9wUGxheWJhY2soKTogdm9pZCB7XG4gICAgdGhpcy5wbGF5YmFjaz8ucG9ydC5wb3N0TWVzc2FnZSh7IHR5cGU6IFwic3RvcFwiIH0pO1xuICAgIHRoaXMucXVldWVkID0gMDtcbiAgfVxuXG4gIHN0b3AoKTogdm9pZCB7XG4gICAgdGhpcy5zdG9wTWljKCk7XG4gICAgdGhpcy5zdG9wUGxheWJhY2soKTtcbiAgfVxufVxuIiwgIi8vIFRoZSByZXBsYXkgdmlldzogYSByZWNvcmRlZCBjYWxsIChhIHRyYWNlIGZyb20gYW55IGhvc3QsIG9yIGEgc2NlbmFyaW8pIHJ1biBhZ2FpbiB0aHJvdWdoIHRoZVxuLy8gY29yZSwgYXMgdGhlIGJ1aWxkIHRoYXQgcmVjb3JkZWQgaXQgZGlkIGFuZCBhcyB0aGUgbGF0ZXN0IGRvZXMsIHNpZGUgYnkgc2lkZS4gV2hlcmUgdGhleSBwYXJ0XG4vLyBpcyB3aGVyZSBhIGNoYW5nZSBpbiBzcmMvIGNoYW5nZWQgd2hhdCB0aGUgY2FsbCBkb2VzIHdpdGggdGhlIHNhbWUgd29yZHMgYW5kIHRoZSBzYW1lIG1vZGVsLlxuXG5pbnRlcmZhY2UgQ29yZSB7XG4gIHZlcnNpb246IHN0cmluZztcbiAgY3JlYXRlKGNvbmZpZzogc3RyaW5nLCB0OiBudW1iZXIpOiBzdHJpbmc7XG4gIHB1c2goaWQ6IG51bWJlciwgZXZlbnQ6IHN0cmluZyk6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFJlY29yZGluZyB7IHZlcnNpb24/OiBzdHJpbmc7IGNvbmZpZzogdW5rbm93bjsgc3RhcnQ6IG51bWJlcjsgZXZlbnRzOiBSZWNvcmQ8c3RyaW5nLCBhbnk+W10gfVxuXG4vKiogV2hhdCBhIGNvbW1hbmQgb3IgZXZlbnQgbG9va3MgbGlrZSBpbiBhIHRpbWVsaW5lOiBhdWRpbyBjdXQgb3V0LCBvbmUgbGluZS4gKi9cbmZ1bmN0aW9uIGxpbmUobzogUmVjb3JkPHN0cmluZywgYW55Pik6IHN0cmluZyB7XG4gIGNvbnN0IHRleHQgPSBKU09OLnN0cmluZ2lmeShvKS5yZXBsYWNlKC9cIihkYXRhfHBjbSlcIjpcIltBLVphLXowLTkrLz1dezQwLH1cIi9nLCAnXCIkMVwiOlwiXHUyMDI2XCInKVxuICAgIC5yZXBsYWNlKC9cXFxcXCJkYXRhXFxcXFwiOlxcXFxcIltBLVphLXowLTkrLz1dezQwLH1cXFxcXCIvZywgJ1xcXFxcImRhdGFcXFxcXCI6XFxcXFwiXHUyMDI2XFxcXFwiJyk7XG4gIHJldHVybiB0ZXh0Lmxlbmd0aCA+IDQwMCA/IHRleHQuc2xpY2UoMCwgNDAwKSArIFwiXHUyMDI2XCIgOiB0ZXh0O1xufVxuXG4vKiogQXVkaW8gYW5kIHRpY2tzIHNheSBub3RoaW5nIGEgcmVhZGVyIG5lZWRzOyB0aGUgcmVzdCBkb2VzLiAqL1xuZnVuY3Rpb24gdGVsbGluZyhvOiBSZWNvcmQ8c3RyaW5nLCBhbnk+KTogYm9vbGVhbiB7XG4gIGlmIChvLnR5cGUgPT09IFwibWljXCIgfHwgby50eXBlID09PSBcInRpY2tcIiB8fCBvLnR5cGUgPT09IFwicGxheVwiKSByZXR1cm4gZmFsc2U7XG4gIGlmIChvLnR5cGUgPT09IFwid3Muc2VuZFwiICYmIFN0cmluZyhvLmRhdGEpLnN0YXJ0c1dpdGgoJ3tcInJlYWx0aW1lSW5wdXRcIjp7XCJhdWRpb1wiJykpIHJldHVybiBmYWxzZTtcbiAgaWYgKG8udHlwZSA9PT0gXCJ3cy5tZXNzYWdlXCIgJiYgU3RyaW5nKG8uZGF0YSkuaW5jbHVkZXMoJ1wiaW5saW5lRGF0YVwiJykgJiYgIVN0cmluZyhvLmRhdGEpLmluY2x1ZGVzKCdcInR1cm5Db21wbGV0ZVwiJykpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmZ1bmN0aW9uIHJ1bihjb3JlOiBDb3JlLCByOiBSZWNvcmRpbmcpOiBzdHJpbmdbXVtdIHtcbiAgY29uc3QgY3JlYXRlZCA9IEpTT04ucGFyc2UoY29yZS5jcmVhdGUoSlNPTi5zdHJpbmdpZnkoci5jb25maWcpLCByLnN0YXJ0KSk7XG4gIGNvbnN0IG91dDogc3RyaW5nW11bXSA9IFtjcmVhdGVkLmNvbW1hbmRzLmZpbHRlcih0ZWxsaW5nKS5tYXAobGluZSldO1xuICBmb3IgKGNvbnN0IGUgb2Ygci5ldmVudHMpIG91dC5wdXNoKChKU09OLnBhcnNlKGNvcmUucHVzaChjcmVhdGVkLmlkLCBKU09OLnN0cmluZ2lmeShlKSkpIGFzIFJlY29yZDxzdHJpbmcsIGFueT5bXSkuZmlsdGVyKHRlbGxpbmcpLm1hcChsaW5lKSk7XG4gIHJldHVybiBvdXQ7XG59XG5cbmV4cG9ydCBjbGFzcyBSZXBsYXkge1xuICBwcml2YXRlIHJlYWRvbmx5IHJvb3Q6IEhUTUxFbGVtZW50O1xuICBwcml2YXRlIHJlYWRvbmx5IGxvYWQ6ICh1cmw/OiBzdHJpbmcpID0+IFByb21pc2U8Q29yZT47XG5cbiAgY29uc3RydWN0b3Iocm9vdDogSFRNTEVsZW1lbnQsIGxvYWQ6ICh1cmw/OiBzdHJpbmcpID0+IFByb21pc2U8Q29yZT4pIHtcbiAgICB0aGlzLnJvb3QgPSByb290O1xuICAgIHRoaXMubG9hZCA9IGxvYWQ7XG4gICAgcm9vdC5pbm5lckhUTUwgPSBgXG4gICAgICA8aDI+VHJhY2UgcmVwbGF5PC9oMj5cbiAgICAgIDxkaXYgY2xhc3M9XCJiYXJcIj48c2VsZWN0IGNsYXNzPVwicGlja1wiIGFyaWEtbGFiZWw9XCJSZWNvcmRpbmdcIj48L3NlbGVjdD48YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cInJlZnJlc2hcIiB0aXRsZT1cIlJlZnJlc2ggbGlzdFwiIGFyaWEtbGFiZWw9XCJSZWZyZXNoIGxpc3RcIj5cdTIxQkI8L2J1dHRvbj48YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cImdvXCI+UmVwbGF5PC9idXR0b24+XG4gICAgICA8bGFiZWwgY2xhc3M9XCJ0b2dnbGUtYWxsXCI+PGlucHV0IHR5cGU9XCJjaGVja2JveFwiIGNsYXNzPVwiYWxsXCI+IFNob3cgYXVkaW8gYW5kIHRpY2tzPC9sYWJlbD48c3BhbiBjbGFzcz1cInN1bW1hcnlcIj48L3NwYW4+PC9kaXY+XG4gICAgICA8ZGl2IGNsYXNzPVwidGltZWxpbmVcIj48L2Rpdj5gO1xuICAgIChyb290LnF1ZXJ5U2VsZWN0b3IoXCIucmVmcmVzaFwiKSBhcyBIVE1MRWxlbWVudCkub25jbGljayA9ICgpID0+IHZvaWQgdGhpcy5saXN0KCk7XG4gICAgKHJvb3QucXVlcnlTZWxlY3RvcihcIi5nb1wiKSBhcyBIVE1MRWxlbWVudCkub25jbGljayA9ICgpID0+IHZvaWQgdGhpcy5yZXBsYXkoKS5jYXRjaCgoZXJyKSA9PiB0aGlzLnNheShgUmVwbGF5IGZhaWxlZDogJHtlcnIubWVzc2FnZX1gKSk7XG4gICAgdm9pZCB0aGlzLmxpc3QoKTtcbiAgfVxuXG4gIHByaXZhdGUgc2F5KHRleHQ6IHN0cmluZykge1xuICAgICh0aGlzLnJvb3QucXVlcnlTZWxlY3RvcihcIi5zdW1tYXJ5XCIpIGFzIEhUTUxFbGVtZW50KS50ZXh0Q29udGVudCA9IHRleHQ7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGxpc3QoKSB7XG4gICAgY29uc3QgcGljayA9IHRoaXMucm9vdC5xdWVyeVNlbGVjdG9yKFwiLnBpY2tcIikgYXMgSFRNTFNlbGVjdEVsZW1lbnQ7XG4gICAgcGljay5pbm5lckhUTUwgPSBcIlwiO1xuICAgIGNvbnN0IHRyYWNlczogeyBuYW1lOiBzdHJpbmc7IGJ5dGVzOiBudW1iZXIgfVtdID0gYXdhaXQgKGF3YWl0IGZldGNoKFwiL3RyYWNlc1wiKSkuanNvbigpO1xuICAgIGNvbnN0IHNjZW5hcmlvczogc3RyaW5nW10gPSBhd2FpdCAoYXdhaXQgZmV0Y2goXCIvc2NlbmFyaW9zXCIpKS5qc29uKCk7XG4gICAgY29uc3QgdHJhY2VHcm91cCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJvcHRncm91cFwiKTtcbiAgICB0cmFjZUdyb3VwLmxhYmVsID0gXCJSZWNvcmRlZCBjYWxsc1wiO1xuICAgIGZvciAoY29uc3QgdCBvZiB0cmFjZXMpIHRyYWNlR3JvdXAuYXBwZW5kKG5ldyBPcHRpb24oYCR7dC5uYW1lfSAoJHtNYXRoLnJvdW5kKHQuYnl0ZXMgLyAxMDI0KX0gS0IpYCwgYC90cmFjZXMvJHt0Lm5hbWV9YCkpO1xuICAgIGNvbnN0IHNjZW5hcmlvR3JvdXAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwib3B0Z3JvdXBcIik7XG4gICAgc2NlbmFyaW9Hcm91cC5sYWJlbCA9IFwiU2NlbmFyaW9zXCI7XG4gICAgZm9yIChjb25zdCBzIG9mIHNjZW5hcmlvcykgc2NlbmFyaW9Hcm91cC5hcHBlbmQobmV3IE9wdGlvbihzLCBgL3NjZW5hcmlvcy8ke3N9Lmpzb25gKSk7XG4gICAgcGljay5hcHBlbmQodHJhY2VHcm91cCwgc2NlbmFyaW9Hcm91cCk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHJlY29yZGluZyh1cmw6IHN0cmluZyk6IFByb21pc2U8UmVjb3JkaW5nPiB7XG4gICAgY29uc3QgdGV4dCA9IGF3YWl0IChhd2FpdCBmZXRjaCh1cmwsIHsgY2FjaGU6IFwibm8tc3RvcmVcIiB9KSkudGV4dCgpO1xuICAgIGlmICh1cmwuZW5kc1dpdGgoXCIuanNvblwiKSkgcmV0dXJuIEpTT04ucGFyc2UodGV4dCk7XG4gICAgY29uc3QgW2hlYWRlciwgLi4uZXZlbnRzXSA9IHRleHQudHJpbSgpLnNwbGl0KFwiXFxuXCIpLm1hcCgobCkgPT4gSlNPTi5wYXJzZShsKSk7XG4gICAgcmV0dXJuIHsgLi4uaGVhZGVyLCBldmVudHMgfTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgcmVwbGF5KCkge1xuICAgIGNvbnN0IHVybCA9ICh0aGlzLnJvb3QucXVlcnlTZWxlY3RvcihcIi5waWNrXCIpIGFzIEhUTUxTZWxlY3RFbGVtZW50KS52YWx1ZTtcbiAgICBpZiAoIXVybCkgcmV0dXJuO1xuICAgIGNvbnN0IHIgPSBhd2FpdCB0aGlzLnJlY29yZGluZyh1cmwpO1xuICAgIGNvbnN0IGxhdGVzdCA9IGF3YWl0IHRoaXMubG9hZCgpO1xuICAgIGxldCByZWNvcmRlZDogQ29yZSB8IG51bGwgPSBudWxsO1xuICAgIGlmIChyLnZlcnNpb24gJiYgci52ZXJzaW9uICE9PSBsYXRlc3QudmVyc2lvbikge1xuICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChgL3ZlcnNpb25zLyR7ci52ZXJzaW9ufS5qc2AsIHsgbWV0aG9kOiBcIkhFQURcIiB9KTtcbiAgICAgIGlmIChyZXNwb25zZS5vaykgcmVjb3JkZWQgPSBhd2FpdCB0aGlzLmxvYWQoYC92ZXJzaW9ucy8ke3IudmVyc2lvbn0uanNgKTtcbiAgICB9XG4gICAgY29uc3Qgbm93ID0gcnVuKGxhdGVzdCwgcik7XG4gICAgY29uc3QgdGhlbiA9IHJlY29yZGVkID8gcnVuKHJlY29yZGVkLCByKSA6IG51bGw7XG4gICAgY29uc3QgYWxsID0gKHRoaXMucm9vdC5xdWVyeVNlbGVjdG9yKFwiLmFsbFwiKSBhcyBIVE1MSW5wdXRFbGVtZW50KS5jaGVja2VkO1xuICAgIGNvbnN0IHRpbWVsaW5lID0gdGhpcy5yb290LnF1ZXJ5U2VsZWN0b3IoXCIudGltZWxpbmVcIikgYXMgSFRNTEVsZW1lbnQ7XG4gICAgdGltZWxpbmUuaW5uZXJIVE1MID0gXCJcIjtcbiAgICBsZXQgZmlyc3QgPSAtMTtcbiAgICBsZXQgZGlmZmVyID0gMDtcbiAgICBjb25zdCByb3dzOiBIVE1MRWxlbWVudFtdID0gW107XG4gICAgY29uc3QgYWRkID0gKGNsczogc3RyaW5nLCB0OiBzdHJpbmcsIHRleHQ6IHN0cmluZykgPT4ge1xuICAgICAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgIHJvdy5jbGFzc05hbWUgPSBgcm93ICR7Y2xzfWA7XG4gICAgICByb3cuaW5uZXJIVE1MID0gYDxzcGFuIGNsYXNzPVwidFwiPiR7dH08L3NwYW4+YDtcbiAgICAgIGNvbnN0IGIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgICAgIGIuY2xhc3NOYW1lID0gXCJiXCI7XG4gICAgICBiLnRleHRDb250ZW50ID0gdGV4dDtcbiAgICAgIHJvdy5hcHBlbmQoYik7XG4gICAgICB0aW1lbGluZS5hcHBlbmQocm93KTtcbiAgICAgIHJvd3MucHVzaChyb3cpO1xuICAgICAgcmV0dXJuIHJvdztcbiAgICB9O1xuICAgIGNvbnN0IHQwID0gci5zdGFydDtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8PSByLmV2ZW50cy5sZW5ndGg7IGkrKykge1xuICAgICAgY29uc3QgZSA9IGkgPT09IDAgPyBudWxsIDogci5ldmVudHNbaSAtIDFdO1xuICAgICAgY29uc3Qgbm93T3V0ID0gbm93W2ldO1xuICAgICAgY29uc3QgdGhlbk91dCA9IHRoZW4gPyB0aGVuW2ldIDogbm93T3V0O1xuICAgICAgY29uc3Qgc2FtZSA9IG5vd091dC5sZW5ndGggPT09IHRoZW5PdXQubGVuZ3RoICYmIG5vd091dC5ldmVyeSgoYywgaikgPT4gYyA9PT0gdGhlbk91dFtqXSk7XG4gICAgICBpZiAoIXNhbWUpIHsgZGlmZmVyKys7IGlmIChmaXJzdCA8IDApIGZpcnN0ID0gaTsgfVxuICAgICAgaWYgKCFzYW1lIHx8IGFsbCB8fCAoZSAmJiB0ZWxsaW5nKGUpKSB8fCBub3dPdXQubGVuZ3RoID4gMCkge1xuICAgICAgICBpZiAoZSAmJiAoYWxsIHx8IHRlbGxpbmcoZSkgfHwgIXNhbWUpKSBhZGQoXCJpblwiLCAoZS50IC0gdDApLnRvRml4ZWQoMiksIGxpbmUoZSkpO1xuICAgICAgICBjb25zdCB0ID0gZSA/IChlLnQgLSB0MCkudG9GaXhlZCgyKSA6IFwiMC4wMFwiO1xuICAgICAgICBpZiAoc2FtZSkgZm9yIChjb25zdCBjIG9mIG5vd091dCkgYWRkKFwib3V0XCIsIHQsIGMpO1xuICAgICAgICBlbHNlIHtcbiAgICAgICAgICBmb3IgKGNvbnN0IGMgb2YgdGhlbk91dCkgYWRkKFwib3V0IGdvbmVcIiwgdCwgYFx1MjIxMiAke2N9YCk7XG4gICAgICAgICAgZm9yIChjb25zdCBjIG9mIG5vd091dCkgYWRkKFwib3V0IG5ld1wiLCB0LCBgKyAke2N9YCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgY29uc3QgdmVyc2lvbnMgPSB0aGVuID8gYHJlY29yZGVkIGJ5ICR7ci52ZXJzaW9ufSwgcmVwbGF5ZWQgYnkgaXQgYW5kIGJ5ICR7bGF0ZXN0LnZlcnNpb259YCA6IGByZXBsYXllZCBieSAke2xhdGVzdC52ZXJzaW9ufWAgK1xuICAgICAgKHIudmVyc2lvbiAmJiByLnZlcnNpb24gIT09IGxhdGVzdC52ZXJzaW9uID8gYCAodGhlIHJlY29yZGluZydzIGJ1aWxkICR7ci52ZXJzaW9ufSBpc24ndCBrZXB0IGhlcmUpYCA6IFwiXCIpO1xuICAgIHRoaXMuc2F5KGAke3IuZXZlbnRzLmxlbmd0aH0gZXZlbnRzLCAke3ZlcnNpb25zfS4gYCArICh0aGVuID8gKGRpZmZlciA/IGAke2RpZmZlcn0gZXZlbnRzIGFuc3dlcmVkIGRpZmZlcmVudGx5LCB0aGUgZmlyc3QgYXQgZXZlbnQgJHtmaXJzdH0uYCA6IFwiQm90aCBhbnN3ZXJlZCBldmVyeSBldmVudCB0aGUgc2FtZS5cIikgOiBcIlwiKSk7XG4gICAgaWYgKGZpcnN0ID49IDApIHRpbWVsaW5lLnF1ZXJ5U2VsZWN0b3IoXCIuZ29uZSwgLm5ld1wiKT8uc2Nyb2xsSW50b1ZpZXcoeyBibG9jazogXCJjZW50ZXJcIiB9KTtcbiAgfVxufVxuIiwgIi8qKiBNaW5pbWFsIHNjcm9sbGluZyBwYW5lIHN1cmZhY2Ugc28gYXV0by1zY3JvbGwgbG9naWMgc3RheXMgdGVzdGFibGUgd2l0aG91dCBhIGJyb3dzZXIgRE9NLiAqL1xuZXhwb3J0IGludGVyZmFjZSBTY3JvbGxQYW5lIHtcbiAgc2Nyb2xsVG9wOiBudW1iZXI7XG4gIHJlYWRvbmx5IHNjcm9sbEhlaWdodDogbnVtYmVyO1xuICByZWFkb25seSBjbGllbnRIZWlnaHQ6IG51bWJlcjtcbiAgc2Nyb2xsVG8/KG9wdGlvbnM6IHsgdG9wOiBudW1iZXI7IGJlaGF2aW9yPzogU2Nyb2xsQmVoYXZpb3IgfSk6IHZvaWQ7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXV0b1Njcm9sbGVyT3B0aW9ucyB7XG4gIC8qKiBEaXN0YW5jZSBmcm9tIHRoZSBib3R0b20gKHB4KSB0aGF0IHN0aWxsIGNvdW50cyBhcyBwaW5uZWQuICovXG4gIHBpblRocmVzaG9sZD86IG51bWJlcjtcbiAgLyoqIERpc3RhbmNlIGZyb20gdGhlIGJvdHRvbSAocHgpIHBhc3Qgd2hpY2ggdGhlIGp1bXAtdG8tbGF0ZXN0IGNvbnRyb2wgaXMgc2hvd24uICovXG4gIGp1bXBUaHJlc2hvbGQ/OiBudW1iZXI7XG4gIC8qKiBDYWxsZWQgd2hlbmV2ZXIgdGhlIGp1bXAtdG8tbGF0ZXN0IGNvbnRyb2wncyB2aXNpYmlsaXR5IG1heSBoYXZlIGNoYW5nZWQuICovXG4gIG9uSnVtcENoYW5nZT86IChzaG93OiBib29sZWFuKSA9PiB2b2lkO1xuICAvKiogV2hlbiB0cnVlIChmb3IgZXhhbXBsZSB3aGlsZSB0aGUgZW1wdHkgc3RhdGUgaXMgc2hvd24pLCBrZWVwIHRoZSBqdW1wIGNvbnRyb2wgaGlkZGVuLiAqL1xuICBpc0VtcHR5PzogKCkgPT4gYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBLZWVwcyBhIHRyYW5zY3JpcHQgcGFuZSBwaW5uZWQgdG8gdGhlIGJvdHRvbSBhcyBtZXNzYWdlcyBzdHJlYW0gaW4sIHdpdGhvdXQgbWVhc3VyaW5nXG4gKiBuZWFyLWJvdHRvbSBhZnRlciBhbiBhcHBlbmQgaGFzIGFscmVhZHkgZ3Jvd24gc2Nyb2xsSGVpZ2h0LCBhbmQgeWllbGRzIGltbWVkaWF0ZWx5IHdoZW5cbiAqIHRoZSB1c2VyIHNjcm9sbHMgdXAgdG8gcmVhZCBlYXJsaWVyIG1lc3NhZ2VzLlxuICovXG5leHBvcnQgY2xhc3MgQXV0b1Njcm9sbGVyIHtcbiAgcHJpdmF0ZSByZWFkb25seSBwYW5lOiBTY3JvbGxQYW5lO1xuICBwcml2YXRlIHJlYWRvbmx5IHBpblRocmVzaG9sZDogbnVtYmVyO1xuICBwcml2YXRlIHJlYWRvbmx5IGp1bXBUaHJlc2hvbGQ6IG51bWJlcjtcbiAgcHJpdmF0ZSByZWFkb25seSBvbkp1bXBDaGFuZ2U/OiAoc2hvdzogYm9vbGVhbikgPT4gdm9pZDtcbiAgcHJpdmF0ZSByZWFkb25seSBpc0VtcHR5PzogKCkgPT4gYm9vbGVhbjtcbiAgcHJpdmF0ZSBwaW5uZWQgPSB0cnVlO1xuICBwcml2YXRlIGp1bXBpbmcgPSBmYWxzZTtcbiAgcHJpdmF0ZSBsYXN0U2Nyb2xsVG9wID0gMDtcblxuICBjb25zdHJ1Y3RvcihwYW5lOiBTY3JvbGxQYW5lLCBvcHRpb25zOiBBdXRvU2Nyb2xsZXJPcHRpb25zID0ge30pIHtcbiAgICB0aGlzLnBhbmUgPSBwYW5lO1xuICAgIHRoaXMucGluVGhyZXNob2xkID0gb3B0aW9ucy5waW5UaHJlc2hvbGQgPz8gMzI7XG4gICAgdGhpcy5qdW1wVGhyZXNob2xkID0gb3B0aW9ucy5qdW1wVGhyZXNob2xkID8/IDEyMDtcbiAgICB0aGlzLm9uSnVtcENoYW5nZSA9IG9wdGlvbnMub25KdW1wQ2hhbmdlO1xuICAgIHRoaXMuaXNFbXB0eSA9IG9wdGlvbnMuaXNFbXB0eTtcbiAgICB0aGlzLmxhc3RTY3JvbGxUb3AgPSBwYW5lLnNjcm9sbFRvcDtcbiAgfVxuXG4gIGdldCBpc1Bpbm5lZCgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5waW5uZWQ7XG4gIH1cblxuICBwcml2YXRlIGRpc3RhbmNlKCk6IG51bWJlciB7XG4gICAgcmV0dXJuIE1hdGgubWF4KDAsIHRoaXMucGFuZS5zY3JvbGxIZWlnaHQgLSB0aGlzLnBhbmUuc2Nyb2xsVG9wIC0gdGhpcy5wYW5lLmNsaWVudEhlaWdodCk7XG4gIH1cblxuICBwcml2YXRlIGlzVmlzaWJsZSgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5wYW5lLmNsaWVudEhlaWdodCA+IDA7XG4gIH1cblxuICBwcml2YXRlIHNuYXBUb0JvdHRvbSgpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuaXNWaXNpYmxlKCkpIHJldHVybjtcbiAgICB0aGlzLnBhbmUuc2Nyb2xsVG9wID0gdGhpcy5wYW5lLnNjcm9sbEhlaWdodDtcbiAgICB0aGlzLmxhc3RTY3JvbGxUb3AgPSB0aGlzLnBhbmUuc2Nyb2xsVG9wO1xuICB9XG5cbiAgcHJpdmF0ZSB1cGRhdGVKdW1wKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5vbkp1bXBDaGFuZ2UpIHJldHVybjtcbiAgICBjb25zdCBlbXB0eSA9IHRoaXMuaXNFbXB0eT8uKCkgPz8gZmFsc2U7XG4gICAgY29uc3Qgc2hvdyA9ICFlbXB0eSAmJiB0aGlzLmlzVmlzaWJsZSgpICYmICF0aGlzLmp1bXBpbmcgJiYgdGhpcy5kaXN0YW5jZSgpID4gdGhpcy5qdW1wVGhyZXNob2xkO1xuICAgIHRoaXMub25KdW1wQ2hhbmdlKHNob3cpO1xuICB9XG5cbiAgLyoqIENhbGwgYWZ0ZXIgY29udGVudCBpcyBhZGRlZCwgdXBkYXRlZCwgb3IgcmVtb3ZlZCBpbiB0aGUgcGFuZS4gKi9cbiAgb25Db250ZW50KGZvcmNlID0gZmFsc2UpOiB2b2lkIHtcbiAgICBpZiAoZm9yY2UpIHtcbiAgICAgIHRoaXMucGlubmVkID0gdHJ1ZTtcbiAgICAgIHRoaXMuanVtcGluZyA9IGZhbHNlO1xuICAgIH1cbiAgICBpZiAodGhpcy5waW5uZWQpIHtcbiAgICAgIGlmICh0aGlzLmp1bXBpbmcgJiYgdGhpcy5wYW5lLnNjcm9sbFRvICYmIHRoaXMuaXNWaXNpYmxlKCkpIHtcbiAgICAgICAgdGhpcy5wYW5lLnNjcm9sbFRvKHsgdG9wOiB0aGlzLnBhbmUuc2Nyb2xsSGVpZ2h0LCBiZWhhdmlvcjogXCJzbW9vdGhcIiB9KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMuc25hcFRvQm90dG9tKCk7XG4gICAgICB9XG4gICAgfVxuICAgIHRoaXMudXBkYXRlSnVtcCgpO1xuICB9XG5cbiAgLyoqIENhbGwgd2hlbiB0aGUgcGFuZSdzIHZpZXdwb3J0IHJlc2l6ZXMgKGJhcnMgYXBwZWFyaW5nLCBrZXlib2FyZCwgdGFiIHN3aXRjaCkuICovXG4gIG9uUmVzaXplKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5pc1Zpc2libGUoKSkgcmV0dXJuO1xuICAgIGlmICh0aGlzLnBpbm5lZCkge1xuICAgICAgdGhpcy5qdW1waW5nID0gZmFsc2U7XG4gICAgICB0aGlzLnNuYXBUb0JvdHRvbSgpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLmxhc3RTY3JvbGxUb3AgPSB0aGlzLnBhbmUuc2Nyb2xsVG9wO1xuICAgIH1cbiAgICB0aGlzLnVwZGF0ZUp1bXAoKTtcbiAgfVxuXG4gIC8qKiBDYWxsIGZyb20gdGhlIHBhbmUncyBzY3JvbGwgZXZlbnQgbGlzdGVuZXIuICovXG4gIG9uU2Nyb2xsKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5pc1Zpc2libGUoKSkgcmV0dXJuO1xuICAgIGNvbnN0IHRvcCA9IHRoaXMucGFuZS5zY3JvbGxUb3A7XG4gICAgY29uc3QgZGlzdCA9IHRoaXMuZGlzdGFuY2UoKTtcbiAgICBjb25zdCBtb3ZlZFVwID0gdG9wIDwgdGhpcy5sYXN0U2Nyb2xsVG9wO1xuICAgIHRoaXMubGFzdFNjcm9sbFRvcCA9IHRvcDtcblxuICAgIGlmIChkaXN0IDw9IHRoaXMucGluVGhyZXNob2xkKSB7XG4gICAgICB0aGlzLnBpbm5lZCA9IHRydWU7XG4gICAgICB0aGlzLmp1bXBpbmcgPSBmYWxzZTtcbiAgICB9IGVsc2UgaWYgKG1vdmVkVXApIHtcbiAgICAgIHRoaXMucGlubmVkID0gZmFsc2U7XG4gICAgICB0aGlzLmp1bXBpbmcgPSBmYWxzZTtcbiAgICB9XG4gICAgdGhpcy51cGRhdGVKdW1wKCk7XG4gIH1cblxuICAvKiogQ2FsbCBmcm9tIHRoZSBwYW5lJ3Mgc2Nyb2xsZW5kIGV2ZW50IGxpc3RlbmVyLiAqL1xuICBvblNjcm9sbEVuZCgpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuaXNWaXNpYmxlKCkgfHwgIXRoaXMuanVtcGluZykgcmV0dXJuO1xuICAgIHRoaXMuanVtcGluZyA9IGZhbHNlO1xuICAgIGlmICh0aGlzLmRpc3RhbmNlKCkgPiB0aGlzLnBpblRocmVzaG9sZCkgdGhpcy5waW5uZWQgPSBmYWxzZTtcbiAgICB0aGlzLnVwZGF0ZUp1bXAoKTtcbiAgfVxuXG4gIC8qKiBDYWxsIG9uIHVzZXIgd2hlZWwtdXAgb3IgdG91Y2hzdGFydCBzbyBhbiBhY3RpdmUgc21vb3RoIGp1bXAgeWllbGRzIHRvIHRoZSB1c2VyLiAqL1xuICBjYW5jZWxKdW1wKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5qdW1waW5nKSByZXR1cm47XG4gICAgdGhpcy5qdW1waW5nID0gZmFsc2U7XG4gICAgaWYgKHRoaXMuaXNWaXNpYmxlKCkpIHtcbiAgICAgIGNvbnN0IHRvcCA9IHRoaXMucGFuZS5zY3JvbGxUb3A7XG4gICAgICBpZiAodGhpcy5wYW5lLnNjcm9sbFRvKSB0aGlzLnBhbmUuc2Nyb2xsVG8oeyB0b3AsIGJlaGF2aW9yOiBcImluc3RhbnRcIiB9KTtcbiAgICAgIGVsc2UgdGhpcy5wYW5lLnNjcm9sbFRvcCA9IHRvcDtcbiAgICAgIHRoaXMubGFzdFNjcm9sbFRvcCA9IHRoaXMucGFuZS5zY3JvbGxUb3A7XG4gICAgICBpZiAodGhpcy5kaXN0YW5jZSgpID4gdGhpcy5waW5UaHJlc2hvbGQpIHRoaXMucGlubmVkID0gZmFsc2U7XG4gICAgfVxuICAgIHRoaXMudXBkYXRlSnVtcCgpO1xuICB9XG5cbiAgLyoqIFJlLXBpbiBhbmQgc2Nyb2xsIHNtb290aGx5IHRvIHRoZSBib3R0b20gKHVzZWQgYnkgdGhlIGp1bXAtdG8tbGF0ZXN0IGJ1dHRvbikuICovXG4gIGp1bXBUb0JvdHRvbSgpOiB2b2lkIHtcbiAgICB0aGlzLnBpbm5lZCA9IHRydWU7XG4gICAgaWYgKCF0aGlzLmlzVmlzaWJsZSgpKSB7XG4gICAgICB0aGlzLnVwZGF0ZUp1bXAoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHRoaXMuZGlzdGFuY2UoKSA8PSB0aGlzLnBpblRocmVzaG9sZCB8fCAhdGhpcy5wYW5lLnNjcm9sbFRvKSB7XG4gICAgICB0aGlzLmp1bXBpbmcgPSBmYWxzZTtcbiAgICAgIHRoaXMuc25hcFRvQm90dG9tKCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuanVtcGluZyA9IHRydWU7XG4gICAgICB0aGlzLmxhc3RTY3JvbGxUb3AgPSB0aGlzLnBhbmUuc2Nyb2xsVG9wO1xuICAgICAgdGhpcy5wYW5lLnNjcm9sbFRvKHsgdG9wOiB0aGlzLnBhbmUuc2Nyb2xsSGVpZ2h0LCBiZWhhdmlvcjogXCJzbW9vdGhcIiB9KTtcbiAgICB9XG4gICAgdGhpcy51cGRhdGVKdW1wKCk7XG4gIH1cblxuICAvKiogUmVjb21wdXRlIHBpbm5lZCBzdGF0ZSBmcm9tIHRoZSBjdXJyZW50IHBvc2l0aW9uIGFmdGVyIGEgdXNlci1kcml2ZW4gbGF5b3V0IGNoYW5nZSAoZS5nLiBleHBhbmRpbmcgYSByZXN1bHQpLiAqL1xuICBzeW5jRnJvbVBvc2l0aW9uKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5pc1Zpc2libGUoKSkgcmV0dXJuO1xuICAgIHRoaXMuanVtcGluZyA9IGZhbHNlO1xuICAgIHRoaXMubGFzdFNjcm9sbFRvcCA9IHRoaXMucGFuZS5zY3JvbGxUb3A7XG4gICAgdGhpcy5waW5uZWQgPSB0aGlzLmRpc3RhbmNlKCkgPD0gdGhpcy5waW5UaHJlc2hvbGQ7XG4gICAgdGhpcy51cGRhdGVKdW1wKCk7XG4gIH1cblxuICAvKiogUGF1c2UgYXV0by1zY3JvbGwgZXhwbGljaXRseSAoZS5nLiB3aGVuIHJldmVhbGluZyBhbiBvbGRlciByZXN1bHQgY2FyZCkuICovXG4gIHVucGluKCk6IHZvaWQge1xuICAgIHRoaXMucGlubmVkID0gZmFsc2U7XG4gICAgdGhpcy5qdW1waW5nID0gZmFsc2U7XG4gICAgdGhpcy51cGRhdGVKdW1wKCk7XG4gIH1cbn1cbiIsICIvLyBQdXJlIFVJIGhlbHBlcnMgZm9yIHRoZSBWb2ljZSB3ZWIgc3VyZmFjZSAoZGVuc2l0eSwgYWdlbnQtcGFuZSBmaWx0ZXJpbmcsIGNvbXBhY3QgcHJldmlld3MpLlxuXG5leHBvcnQgdHlwZSBTaWRlRmlsdGVyID0gXCJhbGxcIiB8IFwiYWN0aXZlXCIgfCBcInJlc3VsdHNcIjtcbmV4cG9ydCB0eXBlIERlbnNpdHkgPSBcImNvbXBhY3RcIiB8IFwiY29tZm9ydGFibGVcIjtcblxuZXhwb3J0IGludGVyZmFjZSBTaWRlQ291bnRzIHtcbiAgYWN0aXZlOiBudW1iZXI7XG4gIHJlc3VsdHM6IG51bWJlcjtcbiAgZWFybGllcjogbnVtYmVyO1xuICBkb25lOiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2lkZVZpc2liaWxpdHkge1xuICBzaG93VGFza3NTZWN0aW9uOiBib29sZWFuO1xuICBzaG93RW1wdHlUYXNrczogYm9vbGVhbjtcbiAgc2hvd1Jlc3VsdHNTZWN0aW9uOiBib29sZWFuO1xuICBzaG93RW1wdHlSZXN1bHRzOiBib29sZWFuO1xuICBzaG93RWFybGllclNlY3Rpb246IGJvb2xlYW47XG4gIHNob3dEb25lU2VjdGlvbjogYm9vbGVhbjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZURlbnNpdHkodmFsdWU6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQpOiBEZW5zaXR5IHtcbiAgcmV0dXJuIHZhbHVlID09PSBcImNvbWZvcnRhYmxlXCIgPyBcImNvbWZvcnRhYmxlXCIgOiBcImNvbXBhY3RcIjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZVNpZGVGaWx0ZXIodmFsdWU6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQpOiBTaWRlRmlsdGVyIHtcbiAgaWYgKHZhbHVlID09PSBcImFjdGl2ZVwiIHx8IHZhbHVlID09PSBcInJlc3VsdHNcIikgcmV0dXJuIHZhbHVlO1xuICByZXR1cm4gXCJhbGxcIjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlUHJlZml4KHRleHQ6IHN0cmluZyk6IHsgbW9kZTogXCJoZXJtZXNcIiB8IFwidDNcIiB8IG51bGw7IHJlc3Q6IHN0cmluZyB9IHtcbiAgY29uc3QgbSA9IHRleHQubWF0Y2goL15cXC8odDN8Y29kZXxofGhlcm1lcylcXHMrKC4qKSQvaXMpO1xuICBpZiAoIW0pIHJldHVybiB7IG1vZGU6IG51bGwsIHJlc3Q6IHRleHQgfTtcbiAgcmV0dXJuIHsgbW9kZTogL14odDN8Y29kZSkkL2kudGVzdChtWzFdKSA/IFwidDNcIiA6IFwiaGVybWVzXCIsIHJlc3Q6IG1bMl0udHJpbSgpIH07XG59XG5cbi8qKiBBIHJlc3VsdCBjYXJkIG1heSBvbmx5IHN0ZWVyIGEgdGFzayB0aGF0IGJlbG9uZ3MgdG8gdGhlIHNhbWUgYWN0aXZlIHNlc3Npb24gKHRhc2sgSURzIHJlc3RhcnQgcGVyIGNhbGwpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNhbkZvbGxvd1VwUmVzdWx0KHJlc3VsdFNlc3Npb246IG51bWJlciwgYWN0aXZlU2Vzc2lvbjogbnVtYmVyLCBoYXNUYXNrOiBib29sZWFuKTogYm9vbGVhbiB7XG4gIHJldHVybiBhY3RpdmVTZXNzaW9uID4gMCAmJiByZXN1bHRTZXNzaW9uID09PSBhY3RpdmVTZXNzaW9uICYmIGhhc1Rhc2s7XG59XG5cbi8qKiBVbnJlYWQgbW9iaWxlIHJlc3VsdCBhbGVydHMgb25seSBjbGVhciBvbmNlIHRoZSBSZXN1bHRzIHNlY3Rpb24gaXMgYWN0dWFsbHkgdmlzaWJsZSB0byB0aGUgdXNlci4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzaG91bGRDbGVhclVucmVhZFJlc3VsdHMoaXNNb2JpbGU6IGJvb2xlYW4sIGRyYXdlck9wZW46IGJvb2xlYW4sIGZpbHRlcjogU2lkZUZpbHRlcik6IGJvb2xlYW4ge1xuICByZXR1cm4gIWlzTW9iaWxlIHx8IChkcmF3ZXJPcGVuICYmIGZpbHRlciAhPT0gXCJhY3RpdmVcIik7XG59XG5cbi8qKiBQaWNrIHRoZSBmaWx0ZXIgdG8gc2hvdyB3aGVuIHRhcHBpbmcgdGhlIG1vYmlsZSBsaXZlLXN0YXR1cyBiYW5uZXIgc28gdGhlIGFkdmVydGlzZWQgaXRlbSBpcyB2aXNpYmxlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVNb2JpbGVCYW5uZXJGaWx0ZXIoY3VycmVudDogU2lkZUZpbHRlciwgYWN0aXZlVG90YWw6IG51bWJlciwgdW5yZWFkUmVzdWx0czogbnVtYmVyKTogU2lkZUZpbHRlciB7XG4gIGlmIChhY3RpdmVUb3RhbCA+IDApIHJldHVybiBjdXJyZW50ID09PSBcInJlc3VsdHNcIiA/IFwiYWxsXCIgOiBjdXJyZW50O1xuICBpZiAodW5yZWFkUmVzdWx0cyA+IDApIHJldHVybiBcInJlc3VsdHNcIjtcbiAgcmV0dXJuIGN1cnJlbnQ7XG59XG5cbi8qKiBGbGF0dGVuIGEgTWFya2Rvd24gYWdlbnQgcmVwbHkgaW50byBhIHNpbmdsZS1saW5lIHBsYWluLXRleHQgcHJldmlldyBmb3IgaW5saW5lIGhhbmRvZmYgY2hpcHMuICovXG5leHBvcnQgZnVuY3Rpb24gcGxhaW5QcmV2aWV3KHRleHQ6IHN0cmluZywgbWF4TGVuID0gMTUwKTogc3RyaW5nIHtcbiAgY29uc3QgY2xlYW5lZCA9IHRleHRcbiAgICAucmVwbGFjZSgvYGBgW15cXG5dKlxcbj8oW1xcc1xcU10qPylgYGAvZywgKF8sIGNvZGU6IHN0cmluZykgPT4gYCAke2NvZGUudHJpbSgpfSBgKVxuICAgIC5yZXBsYWNlKC9cXFsoW15cXF1cXG5dKylcXF1cXCgoaHR0cHM/OlxcL1xcL1teXFxzKV0rKVxcKS9nLCBcIiQxXCIpXG4gICAgLnJlcGxhY2UoL14jezEsNn1cXHMrL2dtLCBcIlwiKVxuICAgIC5yZXBsYWNlKC9eXFxzKig/OlstKlx1MjAyMl18XFxkK1suKV0pXFxzKy9nbSwgXCJcIilcbiAgICAucmVwbGFjZSgvYChbXmBcXG5dKylgL2csIFwiJDFcIilcbiAgICAucmVwbGFjZSgvXFwqXFwqKFteKlxcbl0rKVxcKlxcKi9nLCBcIiQxXCIpXG4gICAgLnJlcGxhY2UoL19fKFteX1xcbl0rKV9fL2csIFwiJDFcIilcbiAgICAucmVwbGFjZSgvXFxzKy9nLCBcIiBcIilcbiAgICAudHJpbSgpO1xuICBpZiAoY2xlYW5lZC5sZW5ndGggPD0gbWF4TGVuKSByZXR1cm4gY2xlYW5lZDtcbiAgY29uc3QgY3V0ID0gY2xlYW5lZC5zbGljZSgwLCBtYXhMZW4pO1xuICBjb25zdCBzcGFjZSA9IGN1dC5sYXN0SW5kZXhPZihcIiBcIik7XG4gIGNvbnN0IGJhc2UgPSBzcGFjZSA+IE1hdGguZmxvb3IobWF4TGVuICogMC42KSA/IGN1dC5zbGljZSgwLCBzcGFjZSkgOiBjdXQ7XG4gIHJldHVybiBgJHtiYXNlLnJlcGxhY2UoL1suLDs6XFxzLV0rJC8sIFwiXCIpfVx1MjAyNmA7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXRTaG9ydFRpbWUoZGF0ZTogRGF0ZSk6IHN0cmluZyB7XG4gIGNvbnN0IHBhZCA9IChuOiBudW1iZXIpID0+IFN0cmluZyhuKS5wYWRTdGFydCgyLCBcIjBcIik7XG4gIHJldHVybiBgJHtwYWQoZGF0ZS5nZXRIb3VycygpKX06JHtwYWQoZGF0ZS5nZXRNaW51dGVzKCkpfWA7XG59XG5cbi8qKiBEZWNpZGUgd2hpY2ggc2VjdGlvbnMgb2YgdGhlIHJpZ2h0LWhhbmQgQWdlbnQgV29ya3NwYWNlIGFyZSB2aXNpYmxlIGZvciBhIGdpdmVuIGZpbHRlciBhbmQgY291bnRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVTaWRlU2VjdGlvbnMoZmlsdGVyOiBTaWRlRmlsdGVyLCBjb3VudHM6IFNpZGVDb3VudHMpOiBTaWRlVmlzaWJpbGl0eSB7XG4gIGlmIChmaWx0ZXIgPT09IFwicmVzdWx0c1wiKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHNob3dUYXNrc1NlY3Rpb246IGZhbHNlLFxuICAgICAgc2hvd0VtcHR5VGFza3M6IGZhbHNlLFxuICAgICAgc2hvd1Jlc3VsdHNTZWN0aW9uOiB0cnVlLFxuICAgICAgc2hvd0VtcHR5UmVzdWx0czogY291bnRzLnJlc3VsdHMgPT09IDAsXG4gICAgICBzaG93RWFybGllclNlY3Rpb246IGZhbHNlLFxuICAgICAgc2hvd0RvbmVTZWN0aW9uOiBmYWxzZSxcbiAgICB9O1xuICB9XG4gIGlmIChmaWx0ZXIgPT09IFwiYWN0aXZlXCIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc2hvd1Rhc2tzU2VjdGlvbjogdHJ1ZSxcbiAgICAgIHNob3dFbXB0eVRhc2tzOiBjb3VudHMuYWN0aXZlID09PSAwICYmIGNvdW50cy5lYXJsaWVyID09PSAwLFxuICAgICAgc2hvd1Jlc3VsdHNTZWN0aW9uOiBmYWxzZSxcbiAgICAgIHNob3dFbXB0eVJlc3VsdHM6IGZhbHNlLFxuICAgICAgc2hvd0VhcmxpZXJTZWN0aW9uOiBjb3VudHMuZWFybGllciA+IDAsXG4gICAgICBzaG93RG9uZVNlY3Rpb246IGNvdW50cy5kb25lID4gMCxcbiAgICB9O1xuICB9XG4gIC8vIFwiYWxsXCI6IGhpZGUgdGhlIGVtcHR5IGFjdGl2ZS10YXNrcyBwbGFjZWhvbGRlciBhcyBzb29uIGFzIHJlc3VsdHMgb3IgZWFybGllciBhZ2VudHMgZXhpc3RcbiAgLy8gc28gZmluaXNoZWQgcmVzcG9uc2VzIHRha2UgdGhlIHRvcCBvZiB0aGUgcGFuZSB3aXRob3V0IHdhc3RlZCBzcGFjZS5cbiAgY29uc3QgaGFzQW55dGhpbmdBYm92ZURvbmUgPSBjb3VudHMuYWN0aXZlID4gMCB8fCBjb3VudHMucmVzdWx0cyA+IDAgfHwgY291bnRzLmVhcmxpZXIgPiAwO1xuICByZXR1cm4ge1xuICAgIHNob3dUYXNrc1NlY3Rpb246IGNvdW50cy5hY3RpdmUgPiAwIHx8ICFoYXNBbnl0aGluZ0Fib3ZlRG9uZSxcbiAgICBzaG93RW1wdHlUYXNrczogIWhhc0FueXRoaW5nQWJvdmVEb25lLFxuICAgIHNob3dSZXN1bHRzU2VjdGlvbjogY291bnRzLnJlc3VsdHMgPiAwLFxuICAgIHNob3dFbXB0eVJlc3VsdHM6IGZhbHNlLFxuICAgIHNob3dFYXJsaWVyU2VjdGlvbjogY291bnRzLmVhcmxpZXIgPiAwLFxuICAgIHNob3dEb25lU2VjdGlvbjogY291bnRzLmRvbmUgPiAwLFxuICB9O1xufVxuIiwgIi8vIE1haW4tdGhyZWFkIGNvbnRyb2xsZXIgZm9yIHRoZSB3YWtlIHdvcmQgV2ViIFdvcmtlciBhbmQgU2NyZWVuIFdha2UgTG9jayBoZWxwZXIuXG4vLyBUYWdzIGV2ZXJ5IGxvYWQgYW5kIHJlc2V0IHdpdGggYSBtb25vdG9uaWMgZ2VuZXJhdGlvbiAoYGdlbmApIHNvIHN0YWxlIGRldGVjdGlvbnMgb3IgcmVhZHkgZXZlbnRzXG4vLyBhZnRlciBhIG1vZGVsIHN3aXRjaCBvciByZXNldCBhcmUgaWdub3JlZCwgYW5kIGtlZXBzIGEgc2hvcnQgcmluZyBidWZmZXIgb2YgcmVjZW50IGZlZCBjaHVua3Ncbi8vIGluZGV4ZWQgYnkgYHNlcWAgKHdpdGggcGVyLWZyYW1lIGBzdXBwcmVzc2VkYCBmbGFncykgc28gYXVkaW8gY2FwdHVyZWQgd2hpbGUgdGhlIHdvcmtlciB3YXNcbi8vIHNjb3JpbmcgaXMgcHJlc2VydmVkIGluIGBoaXQudHJhaWxpbmdgIHdpdGhvdXQgZHVwbGljYXRpbmcgdW5zdXBwcmVzc2VkIGZyYW1lcy5cblxuZXhwb3J0IGludGVyZmFjZSBXYWtlVGVsZW1ldHJ5IHtcbiAgc2NvcmU6IG51bWJlcjtcbiAgcGVhazogbnVtYmVyO1xuICBnYXRlT3BlbjogYm9vbGVhbjtcbiAgZnJhbWVzOiBudW1iZXI7XG4gIHNjb3JlZDogbnVtYmVyO1xuICBpbmZlck1zOiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgV2FrZVRyYWlsaW5nQ2h1bmsge1xuICAvKiogU2VxdWVuY2UgbnVtYmVyIGZyb20gYGZlZWQoKWAsIG1hdGNoaW5nIHRoZSBmZWQgY2h1bmsuICovXG4gIHNlcTogbnVtYmVyO1xuICBieXRlczogVWludDhBcnJheTtcbiAgLyoqIFRydWUgd2hlbiB0aGUgY29yZSBzdXBwcmVzc2VkIChzaWxlbmNlZCkgdGhpcyBmcmFtZSBkdXJpbmcgYXVkaWJsZSBwbGF5YmFjayAoYHdoaWxlU3BlYWtpbmcgIT09IFwic2VuZFwiYCkuICovXG4gIHN1cHByZXNzZWQ6IGJvb2xlYW47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgV2FrZURldGVjdGlvbkV2ZW50IHtcbiAgc2NvcmU6IG51bWJlcjtcbiAgYXRGcmFtZTogbnVtYmVyO1xuICAvKiogQXVkaW8gY2h1bmtzIHNwb2tlbiBhZnRlciB0aGUgd2FrZSB3b3JkOiB0aGUgdHJpZ2dlcmluZyBjaHVuaydzIHRhaWwgcGx1cyBhbnkgY2h1bmtzIGFscmVhZHkgc2VudCBhZnRlciBpdC4gKi9cbiAgdHJhaWxpbmc6IFdha2VUcmFpbGluZ0NodW5rW107XG4gIGluZmVyTXM6IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBXYWtlQ2xpZW50Q2FsbGJhY2tzIHtcbiAgb25SZWFkeT86IChtb2RlbElkOiBzdHJpbmcsIHdhcm11cE1zOiBudW1iZXIpID0+IHZvaWQ7XG4gIG9uRGV0ZWN0ZWQ6IChoaXQ6IFdha2VEZXRlY3Rpb25FdmVudCkgPT4gdm9pZDtcbiAgb25UZWxlbWV0cnk/OiAodDogV2FrZVRlbGVtZXRyeSkgPT4gdm9pZDtcbiAgLyoqIENhbGxlZCBvbmNlIGFsbCBpbi1mbGlnaHQgc3VwcHJlc3NlZCBmcmFtZXMgaGF2ZSBiZWVuIHNjb3JlZCB3aXRob3V0IGZpcmluZyBhIGRldGVjdGlvbi4gKi9cbiAgb25TdXBwcmVzc2VkU2V0dGxlZD86ICgpID0+IHZvaWQ7XG4gIG9uRXJyb3I/OiAobWVzc2FnZTogc3RyaW5nKSA9PiB2b2lkO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFdvcmtlckxpa2Uge1xuICBvbm1lc3NhZ2U6ICgoZTogTWVzc2FnZUV2ZW50PFJlY29yZDxzdHJpbmcsIGFueT4+KSA9PiB2b2lkKSB8IG51bGw7XG4gIG9uZXJyb3I6ICgoZTogRXJyb3JFdmVudCkgPT4gdm9pZCkgfCBudWxsO1xuICBwb3N0TWVzc2FnZShtZXNzYWdlOiB1bmtub3duLCB0cmFuc2Zlcj86IFRyYW5zZmVyYWJsZVtdKTogdm9pZDtcbiAgdGVybWluYXRlKCk6IHZvaWQ7XG59XG5cbi8qKiBNYXggYnVmZmVyZWQgcG9zdC1mZWVkIGF1ZGlvICh+MS41IHMgYXQgMjAgbXMgY2h1bmtzKSB0byBjb3ZlciB3b3JrZXIgc2NvcmluZyBsYXRlbmN5LiAqL1xuY29uc3QgUkVDRU5UX01BWF9CWVRFUyA9IE1hdGgucm91bmQoMS41ICogMzJfMDAwKTtcblxuZXhwb3J0IGNsYXNzIFdha2VDbGllbnQge1xuICBwcml2YXRlIHdvcmtlcjogV29ya2VyTGlrZSB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIHJlYWRvbmx5IGNhbGxiYWNrczogV2FrZUNsaWVudENhbGxiYWNrcztcbiAgcHJpdmF0ZSByZWFkb25seSBjcmVhdGVXb3JrZXI6ICgpID0+IFdvcmtlckxpa2U7XG4gIHByaXZhdGUgbG9hZGVkTW9kZWxJZDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgbG9hZGluZ01vZGVsSWQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIGN1cnJlbnRUaHJlc2hvbGQgPSAwLjc7XG4gIHByaXZhdGUgZ2VuID0gMDtcbiAgcHJpdmF0ZSBzZXEgPSAwO1xuICBwcml2YXRlIGxhc3RTdXBwcmVzc2VkU2VxID0gMDtcbiAgcHJpdmF0ZSBsYXN0QWNrZWRTZXEgPSAwO1xuICBwcml2YXRlIHJlY2VudDogeyBzZXE6IG51bWJlcjsgYnl0ZXM6IFVpbnQ4QXJyYXk7IHN1cHByZXNzZWQ6IGJvb2xlYW4gfVtdID0gW107XG4gIHByaXZhdGUgcmVjZW50Qnl0ZXMgPSAwO1xuICByZWFkeSA9IGZhbHNlO1xuXG4gIGNvbnN0cnVjdG9yKFxuICAgIGNhbGxiYWNrczogV2FrZUNsaWVudENhbGxiYWNrcyxcbiAgICBjcmVhdGVXb3JrZXI6ICgpID0+IFdvcmtlckxpa2UgPSAoKSA9PiBuZXcgV29ya2VyKFwiL3dha2Uud29ya2VyLmpzXCIsIHsgdHlwZTogXCJtb2R1bGVcIiB9KSxcbiAgKSB7XG4gICAgdGhpcy5jYWxsYmFja3MgPSBjYWxsYmFja3M7XG4gICAgdGhpcy5jcmVhdGVXb3JrZXIgPSBjcmVhdGVXb3JrZXI7XG4gIH1cblxuICAvKiogTGF0ZXN0IG1vbm90b25pYyBzZXF1ZW5jZSBudW1iZXIgYXNzaWduZWQgYnkgYGZlZWQoKWAuICovXG4gIGdldCBsYXN0U2VxKCk6IG51bWJlciB7XG4gICAgcmV0dXJuIHRoaXMuc2VxO1xuICB9XG5cbiAgLyoqIEhpZ2hlc3Qgc2VxdWVuY2UgbnVtYmVyIG9mIGFuIGluLWZsaWdodCBzdXBwcmVzc2VkIGZyYW1lLCBvciAwIGlmIG5vbmUgYXJlIHNjb3JpbmcuICovXG4gIGdldCBpbkZsaWdodFN1cHByZXNzZWRTZXEoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gdGhpcy5sYXN0U3VwcHJlc3NlZFNlcSA+IHRoaXMubGFzdEFja2VkU2VxID8gdGhpcy5sYXN0U3VwcHJlc3NlZFNlcSA6IDA7XG4gIH1cblxuICAvKiogVHJ1ZSB3aGlsZSBhdCBsZWFzdCBvbmUgc3VwcHJlc3NlZCBmcmFtZSBpcyBzdGlsbCBxdWV1ZWQgb3Igc2NvcmluZyBpbiB0aGUgd29ya2VyLiAqL1xuICBnZXQgc3VwcHJlc3NlZEluRmxpZ2h0KCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLmluRmxpZ2h0U3VwcHJlc3NlZFNlcSA+IDA7XG4gIH1cblxuICBwcml2YXRlIGNsZWFyUmVjZW50KCk6IHZvaWQge1xuICAgIHRoaXMucmVjZW50ID0gW107XG4gICAgdGhpcy5yZWNlbnRCeXRlcyA9IDA7XG4gIH1cblxuICBwcml2YXRlIGNsZWFyU3VwcHJlc3NlZFRyYWNraW5nKCk6IHZvaWQge1xuICAgIGNvbnN0IGhhZEluRmxpZ2h0ID0gdGhpcy5zdXBwcmVzc2VkSW5GbGlnaHQ7XG4gICAgdGhpcy5sYXN0U3VwcHJlc3NlZFNlcSA9IDA7XG4gICAgdGhpcy5sYXN0QWNrZWRTZXEgPSAwO1xuICAgIGlmIChoYWRJbkZsaWdodCkgdGhpcy5jYWxsYmFja3Mub25TdXBwcmVzc2VkU2V0dGxlZD8uKCk7XG4gIH1cblxuICBwcml2YXRlIGVuc3VyZVdvcmtlcigpOiBXb3JrZXJMaWtlIHtcbiAgICBpZiAodGhpcy53b3JrZXIpIHJldHVybiB0aGlzLndvcmtlcjtcbiAgICBjb25zdCB3b3JrZXIgPSB0aGlzLmNyZWF0ZVdvcmtlcigpO1xuICAgIHdvcmtlci5vbm1lc3NhZ2UgPSAoZTogTWVzc2FnZUV2ZW50PFJlY29yZDxzdHJpbmcsIGFueT4+KSA9PiB7XG4gICAgICBjb25zdCBtID0gZS5kYXRhO1xuICAgICAgaWYgKHR5cGVvZiBtLmdlbiA9PT0gXCJudW1iZXJcIiAmJiBtLmdlbiAhPT0gdGhpcy5nZW4pIHJldHVybjtcbiAgICAgIGlmIChtLnR5cGUgPT09IFwicmVhZHlcIikge1xuICAgICAgICB0aGlzLmxvYWRpbmdNb2RlbElkID0gbnVsbDtcbiAgICAgICAgdGhpcy5sb2FkZWRNb2RlbElkID0gbS5tb2RlbElkO1xuICAgICAgICB0aGlzLnJlYWR5ID0gdHJ1ZTtcbiAgICAgICAgdGhpcy5jYWxsYmFja3Mub25SZWFkeT8uKG0ubW9kZWxJZCwgbS53YXJtdXBNcyk7XG4gICAgICB9IGVsc2UgaWYgKG0udHlwZSA9PT0gXCJhY2tcIikge1xuICAgICAgICBjb25zdCB3YXNJbkZsaWdodCA9IHRoaXMuc3VwcHJlc3NlZEluRmxpZ2h0O1xuICAgICAgICBpZiAodHlwZW9mIG0uc2VxID09PSBcIm51bWJlclwiICYmIG0uc2VxID4gdGhpcy5sYXN0QWNrZWRTZXEpIHRoaXMubGFzdEFja2VkU2VxID0gbS5zZXE7XG4gICAgICAgIGlmICh3YXNJbkZsaWdodCAmJiAhdGhpcy5zdXBwcmVzc2VkSW5GbGlnaHQpIHRoaXMuY2FsbGJhY2tzLm9uU3VwcHJlc3NlZFNldHRsZWQ/LigpO1xuICAgICAgfSBlbHNlIGlmIChtLnR5cGUgPT09IFwiZGV0ZWN0ZWRcIikge1xuICAgICAgICBjb25zdCB0cmFpbGluZzogV2FrZVRyYWlsaW5nQ2h1bmtbXSA9IFtdO1xuICAgICAgICBjb25zdCByZXN0ID0gbmV3IFVpbnQ4QXJyYXkobS5yZXN0Qnl0ZXMgYXMgQXJyYXlCdWZmZXIpO1xuICAgICAgICBjb25zdCBoaXRTZXEgPSB0eXBlb2YgbS5zZXEgPT09IFwibnVtYmVyXCIgPyBtLnNlcSA6IE51bWJlci5NQVhfU0FGRV9JTlRFR0VSO1xuICAgICAgICBjb25zdCBoaXRJdGVtID0gdGhpcy5yZWNlbnQuZmluZCgoaXRlbSkgPT4gaXRlbS5zZXEgPT09IGhpdFNlcSk7XG4gICAgICAgIGlmIChyZXN0LmJ5dGVMZW5ndGggPiAwKSB7XG4gICAgICAgICAgdHJhaWxpbmcucHVzaCh7IHNlcTogaGl0U2VxLCBieXRlczogcmVzdCwgc3VwcHJlc3NlZDogaGl0SXRlbT8uc3VwcHJlc3NlZCA/PyBmYWxzZSB9KTtcbiAgICAgICAgfVxuICAgICAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgdGhpcy5yZWNlbnQpIHtcbiAgICAgICAgICBpZiAoaXRlbS5zZXEgPiBoaXRTZXEpIHRyYWlsaW5nLnB1c2goeyBzZXE6IGl0ZW0uc2VxLCBieXRlczogaXRlbS5ieXRlcywgc3VwcHJlc3NlZDogaXRlbS5zdXBwcmVzc2VkIH0pO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMuY2xlYXJSZWNlbnQoKTtcbiAgICAgICAgdGhpcy5sYXN0U3VwcHJlc3NlZFNlcSA9IDA7XG4gICAgICAgIHRoaXMubGFzdEFja2VkU2VxID0gMDtcbiAgICAgICAgdGhpcy5jYWxsYmFja3Mub25EZXRlY3RlZCh7XG4gICAgICAgICAgc2NvcmU6IG0uc2NvcmUsXG4gICAgICAgICAgYXRGcmFtZTogbS5hdEZyYW1lLFxuICAgICAgICAgIHRyYWlsaW5nLFxuICAgICAgICAgIGluZmVyTXM6IG0uaW5mZXJNcyxcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2UgaWYgKG0udHlwZSA9PT0gXCJ0ZWxlbWV0cnlcIikge1xuICAgICAgICB0aGlzLmNhbGxiYWNrcy5vblRlbGVtZXRyeT8uKHtcbiAgICAgICAgICBzY29yZTogbS5zY29yZSxcbiAgICAgICAgICBwZWFrOiBtLnBlYWssXG4gICAgICAgICAgZ2F0ZU9wZW46IG0uZ2F0ZU9wZW4sXG4gICAgICAgICAgZnJhbWVzOiBtLmZyYW1lcyxcbiAgICAgICAgICBzY29yZWQ6IG0uc2NvcmVkLFxuICAgICAgICAgIGluZmVyTXM6IG0uaW5mZXJNcyxcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2UgaWYgKG0udHlwZSA9PT0gXCJlcnJvclwiKSB7XG4gICAgICAgIHRoaXMubG9hZGluZ01vZGVsSWQgPSBudWxsO1xuICAgICAgICB0aGlzLnJlYWR5ID0gZmFsc2U7XG4gICAgICAgIHRoaXMuY2xlYXJTdXBwcmVzc2VkVHJhY2tpbmcoKTtcbiAgICAgICAgdGhpcy5jYWxsYmFja3Mub25FcnJvcj8uKFN0cmluZyhtLm1lc3NhZ2UgPz8gXCJ3YWtlIHdvcmtlciBlcnJvclwiKSk7XG4gICAgICB9XG4gICAgfTtcbiAgICB3b3JrZXIub25lcnJvciA9IChlcnIpID0+IHtcbiAgICAgIHRoaXMubG9hZGluZ01vZGVsSWQgPSBudWxsO1xuICAgICAgdGhpcy5yZWFkeSA9IGZhbHNlO1xuICAgICAgdGhpcy5jbGVhclN1cHByZXNzZWRUcmFja2luZygpO1xuICAgICAgdGhpcy5jYWxsYmFja3Mub25FcnJvcj8uKGVyci5tZXNzYWdlIHx8IFwid2FrZSB3b3JrZXIgZmFpbGVkXCIpO1xuICAgIH07XG4gICAgdGhpcy53b3JrZXIgPSB3b3JrZXI7XG4gICAgcmV0dXJuIHdvcmtlcjtcbiAgfVxuXG4gIC8qKiBMb2FkcyAob3Igc3dpdGNoZXMgdG8pIHRoZSBuYW1lZCBtb2RlbDsgaWdub3JlcyBzdGFsZSByZXN1bHRzIGZyb20gZWFybGllciBsb2Fkcy4gKi9cbiAgbG9hZChtb2RlbElkOiBzdHJpbmcsIHRocmVzaG9sZDogbnVtYmVyKTogdm9pZCB7XG4gICAgdGhpcy5jdXJyZW50VGhyZXNob2xkID0gdGhyZXNob2xkO1xuICAgIGNvbnN0IHdvcmtlciA9IHRoaXMuZW5zdXJlV29ya2VyKCk7XG4gICAgaWYgKHRoaXMucmVhZHkgJiYgdGhpcy5sb2FkZWRNb2RlbElkID09PSBtb2RlbElkKSB7XG4gICAgICB3b3JrZXIucG9zdE1lc3NhZ2UoeyB0eXBlOiBcImNvbmZpZ1wiLCB0aHJlc2hvbGQgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICh0aGlzLmxvYWRpbmdNb2RlbElkID09PSBtb2RlbElkKSB7XG4gICAgICB3b3JrZXIucG9zdE1lc3NhZ2UoeyB0eXBlOiBcImNvbmZpZ1wiLCB0aHJlc2hvbGQgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRoaXMuZ2VuKys7XG4gICAgdGhpcy5yZWFkeSA9IGZhbHNlO1xuICAgIHRoaXMubG9hZGluZ01vZGVsSWQgPSBtb2RlbElkO1xuICAgIHRoaXMuY2xlYXJSZWNlbnQoKTtcbiAgICB0aGlzLmNsZWFyU3VwcHJlc3NlZFRyYWNraW5nKCk7XG4gICAgd29ya2VyLnBvc3RNZXNzYWdlKHtcbiAgICAgIHR5cGU6IFwibG9hZFwiLFxuICAgICAgZ2VuOiB0aGlzLmdlbixcbiAgICAgIG1vZGVsSWQsXG4gICAgICB1cmw6IGAvd2FrZS9tb2RlbHMvJHtlbmNvZGVVUklDb21wb25lbnQobW9kZWxJZCl9Lm9ubnhgLFxuICAgICAgdGhyZXNob2xkLFxuICAgICAgd2FzbVBhdGhzOiBcIi9vcnQvXCIsXG4gICAgfSk7XG4gIH1cblxuICBzZXRUaHJlc2hvbGQodGhyZXNob2xkOiBudW1iZXIpOiB2b2lkIHtcbiAgICB0aGlzLmN1cnJlbnRUaHJlc2hvbGQgPSB0aHJlc2hvbGQ7XG4gICAgdGhpcy53b3JrZXI/LnBvc3RNZXNzYWdlKHsgdHlwZTogXCJjb25maWdcIiwgdGhyZXNob2xkIH0pO1xuICB9XG5cbiAgLyoqIEZlZWRzIGEgMTYga0h6IFBDTTE2IGNodW5rIHRvIHRoZSB3b3JrZXI7IHJldHVybnMgaXRzIHNlcXVlbmNlIG51bWJlciAob3IgMCBpZiBub3QgcmVhZHkpLiAqL1xuICBmZWVkKHNhbXBsZXM6IEludDE2QXJyYXksIHN1cHByZXNzZWQgPSBmYWxzZSk6IG51bWJlciB7XG4gICAgaWYgKCF0aGlzLnJlYWR5IHx8ICF0aGlzLndvcmtlcikgcmV0dXJuIDA7XG4gICAgY29uc3Qgc2VxID0gKyt0aGlzLnNlcTtcbiAgICBpZiAoc3VwcHJlc3NlZCkgdGhpcy5sYXN0U3VwcHJlc3NlZFNlcSA9IHNlcTtcbiAgICBjb25zdCBieXRlcyA9IG5ldyBVaW50OEFycmF5KHNhbXBsZXMuYnl0ZUxlbmd0aCk7XG4gICAgYnl0ZXMuc2V0KG5ldyBVaW50OEFycmF5KHNhbXBsZXMuYnVmZmVyLCBzYW1wbGVzLmJ5dGVPZmZzZXQsIHNhbXBsZXMuYnl0ZUxlbmd0aCkpO1xuICAgIHRoaXMucmVjZW50LnB1c2goeyBzZXEsIGJ5dGVzLCBzdXBwcmVzc2VkIH0pO1xuICAgIHRoaXMucmVjZW50Qnl0ZXMgKz0gYnl0ZXMuYnl0ZUxlbmd0aDtcbiAgICB3aGlsZSAodGhpcy5yZWNlbnRCeXRlcyA+IFJFQ0VOVF9NQVhfQllURVMgJiYgdGhpcy5yZWNlbnQubGVuZ3RoID4gMSkge1xuICAgICAgdGhpcy5yZWNlbnRCeXRlcyAtPSB0aGlzLnJlY2VudC5zaGlmdCgpIS5ieXRlcy5ieXRlTGVuZ3RoO1xuICAgIH1cbiAgICBjb25zdCBjb3B5ID0gbmV3IEludDE2QXJyYXkoc2FtcGxlcy5sZW5ndGgpO1xuICAgIGNvcHkuc2V0KHNhbXBsZXMpO1xuICAgIHRoaXMud29ya2VyLnBvc3RNZXNzYWdlKHsgdHlwZTogXCJmZWVkXCIsIGdlbjogdGhpcy5nZW4sIHNlcSwgYWNrOiBzdXBwcmVzc2VkLCBwY206IGNvcHkuYnVmZmVyIH0sIFtjb3B5LmJ1ZmZlcl0pO1xuICAgIHJldHVybiBzZXE7XG4gIH1cblxuICByZXNldCgpOiB2b2lkIHtcbiAgICB0aGlzLmNsZWFyUmVjZW50KCk7XG4gICAgdGhpcy5jbGVhclN1cHByZXNzZWRUcmFja2luZygpO1xuICAgIGlmICghdGhpcy53b3JrZXIgfHwgIXRoaXMucmVhZHkpIHJldHVybjtcbiAgICB0aGlzLmdlbisrO1xuICAgIHRoaXMud29ya2VyLnBvc3RNZXNzYWdlKHsgdHlwZTogXCJyZXNldFwiLCBnZW46IHRoaXMuZ2VuIH0pO1xuICB9XG5cbiAgZGlzcG9zZSgpOiB2b2lkIHtcbiAgICB0aGlzLmdlbisrO1xuICAgIHRoaXMucmVhZHkgPSBmYWxzZTtcbiAgICB0aGlzLmxvYWRlZE1vZGVsSWQgPSBudWxsO1xuICAgIHRoaXMubG9hZGluZ01vZGVsSWQgPSBudWxsO1xuICAgIHRoaXMuY2xlYXJSZWNlbnQoKTtcbiAgICB0aGlzLmNsZWFyU3VwcHJlc3NlZFRyYWNraW5nKCk7XG4gICAgaWYgKHRoaXMud29ya2VyKSB7XG4gICAgICB0aGlzLndvcmtlci5wb3N0TWVzc2FnZSh7IHR5cGU6IFwiZGlzcG9zZVwiLCBnZW46IHRoaXMuZ2VuIH0pO1xuICAgICAgdGhpcy53b3JrZXIudGVybWluYXRlKCk7XG4gICAgICB0aGlzLndvcmtlciA9IG51bGw7XG4gICAgfVxuICB9XG5cbiAgZ2V0IG1vZGVsSWQoKTogc3RyaW5nIHwgbnVsbCB7XG4gICAgcmV0dXJuIHRoaXMubG9hZGVkTW9kZWxJZCA/PyB0aGlzLmxvYWRpbmdNb2RlbElkO1xuICB9XG5cbiAgZ2V0IHRocmVzaG9sZCgpOiBudW1iZXIge1xuICAgIHJldHVybiB0aGlzLmN1cnJlbnRUaHJlc2hvbGQ7XG4gIH1cbn1cblxuZXhwb3J0IGludGVyZmFjZSBXYWtlTG9ja1NlbnRpbmVsTGlrZSB7XG4gIHJlYWRvbmx5IHJlbGVhc2VkPzogYm9vbGVhbjtcbiAgcmVsZWFzZSgpOiBQcm9taXNlPHZvaWQ+O1xuICBhZGRFdmVudExpc3RlbmVyPyh0eXBlOiBzdHJpbmcsIGxpc3RlbmVyOiAoKSA9PiB2b2lkKTogdm9pZDtcbn1cblxuLyoqXG4gKiBXcmFwcyB0aGUgU2NyZWVuIFdha2UgTG9jayBBUEkgc28gYnJvd3Nlci1pbml0aWF0ZWQgcmVsZWFzZXMgKHN1Y2ggYXMgaGlkaW5nIGEgdGFiKSBjbGVhciB0aGVcbiAqIHN0b3JlZCBzZW50aW5lbCBhbmQgYWxsb3cgcmVhY3F1aXJpbmcgb24gdmlzaWJpbGl0eSByZXN0b3JlLCB3aGlsZSBjYW5jZWxsaW5nIGluLWZsaWdodCByZXF1ZXN0cy5cbiAqL1xuZXhwb3J0IGNsYXNzIFNjcmVlbldha2VMb2NrIHtcbiAgcHJpdmF0ZSBzZW50aW5lbDogV2FrZUxvY2tTZW50aW5lbExpa2UgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBnZW4gPSAwO1xuICBwcml2YXRlIHJlYWRvbmx5IHJlcXVlc3RMb2NrOiAoKSA9PiBQcm9taXNlPFdha2VMb2NrU2VudGluZWxMaWtlIHwgdW5kZWZpbmVkPjtcblxuICBjb25zdHJ1Y3RvcihcbiAgICByZXF1ZXN0TG9jazogKCkgPT4gUHJvbWlzZTxXYWtlTG9ja1NlbnRpbmVsTGlrZSB8IHVuZGVmaW5lZD4gPSAoKSA9PlxuICAgICAgKG5hdmlnYXRvciBhcyBhbnkpLndha2VMb2NrPy5yZXF1ZXN0KFwic2NyZWVuXCIpID8/IFByb21pc2UucmVzb2x2ZSh1bmRlZmluZWQpLFxuICApIHtcbiAgICB0aGlzLnJlcXVlc3RMb2NrID0gcmVxdWVzdExvY2s7XG4gIH1cblxuICBnZXQgaGVsZCgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5zZW50aW5lbCAhPSBudWxsICYmICF0aGlzLnNlbnRpbmVsLnJlbGVhc2VkO1xuICB9XG5cbiAgYXN5bmMgYWNxdWlyZShzdGlsbFdhbnRlZDogKCkgPT4gYm9vbGVhbik6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICh0aGlzLmhlbGQgfHwgIXN0aWxsV2FudGVkKCkpIHJldHVybjtcbiAgICBjb25zdCBnZW4gPSArK3RoaXMuZ2VuO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBsb2NrID0gYXdhaXQgdGhpcy5yZXF1ZXN0TG9jaygpO1xuICAgICAgaWYgKCFsb2NrKSByZXR1cm47XG4gICAgICBpZiAoZ2VuICE9PSB0aGlzLmdlbiB8fCAhc3RpbGxXYW50ZWQoKSkge1xuICAgICAgICB2b2lkIGxvY2sucmVsZWFzZSgpLmNhdGNoKCgpID0+IHt9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgdGhpcy5zZW50aW5lbCA9IGxvY2s7XG4gICAgICBsb2NrLmFkZEV2ZW50TGlzdGVuZXI/LihcInJlbGVhc2VcIiwgKCkgPT4ge1xuICAgICAgICBpZiAodGhpcy5zZW50aW5lbCA9PT0gbG9jaykgdGhpcy5zZW50aW5lbCA9IG51bGw7XG4gICAgICB9KTtcbiAgICB9IGNhdGNoIHt9XG4gIH1cblxuICByZWxlYXNlKCk6IHZvaWQge1xuICAgIHRoaXMuZ2VuKys7XG4gICAgY29uc3QgbG9jayA9IHRoaXMuc2VudGluZWw7XG4gICAgdGhpcy5zZW50aW5lbCA9IG51bGw7XG4gICAgdm9pZCBsb2NrPy5yZWxlYXNlKCkuY2F0Y2goKCkgPT4ge30pO1xuICB9XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRGVmZXJyZWRNaWNGcmFtZSB7XG4gIHNlcTogbnVtYmVyO1xuICBmbG9vclNlcTogbnVtYmVyO1xuICBwY206IHN0cmluZztcbiAgdDogbnVtYmVyO1xufVxuXG4vKipcbiAqIE1pcnJvcnMgdGhlIHZvaWNlIGNvcmUncyBwbGF5YmFjayBzdXBwcmVzc2lvbiBjbG9jayBhbmQgY29vcmRpbmF0ZXMgZGVmZXJyZWQgcG9zdC1wbGF5YmFja1xuICogbWljcm9waG9uZSBmcmFtZXMgd2l0aCBhc3luY2hyb25vdXMgd2FrZS13b3JkIHRhaWwgcmVwbGF5LlxuICpcbiAqIFNlcGFyYXRpbmcgd2FrZSBhY2NlcHRhbmNlIGZyb20gcmVwbGF5IGVsaWdpYmlsaXR5IChgcmVwbGF5Rmxvb3JTZXFgKSBlbnN1cmVzIHRoYXQgZm9yd2FyZGluZ1xuICogYSBnYXAgZnJhbWUgYmVmb3JlIG5ldyBwbGF5YmFjayBuZXZlciBzaWxlbmNlcyBnYXAgYXVkaW8sIG5ldmVyIGRpc2NhcmRzIGEgdmFsaWQgd2FrZSBoaXQsXG4gKiBhbmQgbmV2ZXIgcmVwbGF5cyBvbGRlciBzdXBwcmVzc2VkIGF1ZGlvIGFmdGVyIG5ld2VyIGF1ZGlvIGFscmVhZHkgc2VudCB0byB0aGUgY29yZS5cbiAqL1xuZnVuY3Rpb24gdmFsaWRCcmllZlBjbUJ5dGVzKHBjbTogdW5rbm93bik6IG51bWJlciB7XG4gIGlmICh0eXBlb2YgcGNtICE9PSBcInN0cmluZ1wiIHx8IHBjbS5sZW5ndGggPT09IDAgfHwgcGNtLmxlbmd0aCAlIDQgIT09IDApIHJldHVybiAtMTtcbiAgaWYgKCEvXltBLVphLXowLTkrL10qPXswLDJ9JC8udGVzdChwY20pKSByZXR1cm4gLTE7XG4gIGNvbnN0IHBhZCA9IHBjbS5lbmRzV2l0aChcIj09XCIpID8gMiA6IHBjbS5lbmRzV2l0aChcIj1cIikgPyAxIDogMDtcbiAgY29uc3Qgc2l6ZSA9IE1hdGguZmxvb3IoKHBjbS5sZW5ndGggKiAzKSAvIDQpIC0gcGFkO1xuICByZXR1cm4gc2l6ZSA+IDAgJiYgc2l6ZSAlIDIgPT09IDAgJiYgc2l6ZSA8PSAyXzg4MF8wMDAgPyBzaXplIDogLTE7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgV2FrZUF1ZGlvR2F0ZUxpbWl0cyB7XG4gIGRlbGl2ZXJNYXg/OiBudW1iZXI7XG4gIGJyaWVmV2FpdD86IG51bWJlcjtcbiAgbXV0ZWQ/OiBib29sZWFuO1xufVxuXG5leHBvcnQgY2xhc3MgV2FrZUF1ZGlvR2F0ZSB7XG4gIHByaXZhdGUgd2hpbGVTcGVha2luZyA9IFwic2VuZFwiO1xuICBwcml2YXRlIG11dGVkID0gZmFsc2U7XG4gIHByaXZhdGUgc3BlZWNoVW50aWwgPSAwO1xuICBwcml2YXRlIGRlbGl2ZXJNYXggPSAzMDtcbiAgcHJpdmF0ZSBicmllZldhaXQgPSAzO1xuICBwcml2YXRlIGFjdGl2ZUJyaWVmOiB7IGZyb206IG51bWJlcjsgdW50aWw6IG51bWJlcjsgYnJpZWZBdDogbnVtYmVyIH0gfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSByZWFkeUJyaWVmczogbnVtYmVyW10gPSBbXTtcbiAgcHJpdmF0ZSByZXF1ZXN0ZWRCcmllZnMgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuICBwcml2YXRlIGxhc3RFdmVudFJhbkFubm91bmNlID0gZmFsc2U7XG4gIHByaXZhdGUgbGFzdEN1dDogeyBhdDogbnVtYmVyOyBicmllZkF0OiBudW1iZXIgfSB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIGxhc3RTdG9wcGVkQnJpZWZBdDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgcmVwbGF5Rmxvb3JTZXEgPSAwO1xuICBwcml2YXRlIGRlZmVycmVkOiBEZWZlcnJlZE1pY0ZyYW1lW10gPSBbXTtcbiAgcHJpdmF0ZSByZWFkb25seSBtYXhEZWZlcnJlZDogbnVtYmVyO1xuXG4gIGNvbnN0cnVjdG9yKG1heERlZmVycmVkID0gNjApIHtcbiAgICB0aGlzLm1heERlZmVycmVkID0gbWF4RGVmZXJyZWQ7XG4gIH1cblxuICByZXNldCh3aGlsZVNwZWFraW5nID0gXCJzZW5kXCIsIGZsb29yU2VxID0gMCwgbGltaXRzOiBXYWtlQXVkaW9HYXRlTGltaXRzID0ge30pOiB2b2lkIHtcbiAgICB0aGlzLndoaWxlU3BlYWtpbmcgPSB3aGlsZVNwZWFraW5nO1xuICAgIHRoaXMubXV0ZWQgPSBsaW1pdHMubXV0ZWQgPT09IHRydWU7XG4gICAgdGhpcy5zcGVlY2hVbnRpbCA9IDA7XG4gICAgdGhpcy5kZWxpdmVyTWF4ID0gdHlwZW9mIGxpbWl0cy5kZWxpdmVyTWF4ID09PSBcIm51bWJlclwiID8gbGltaXRzLmRlbGl2ZXJNYXggOiAzMDtcbiAgICB0aGlzLmJyaWVmV2FpdCA9IHR5cGVvZiBsaW1pdHMuYnJpZWZXYWl0ID09PSBcIm51bWJlclwiID8gbGltaXRzLmJyaWVmV2FpdCA6IDM7XG4gICAgdGhpcy5hY3RpdmVCcmllZiA9IG51bGw7XG4gICAgdGhpcy5yZWFkeUJyaWVmcyA9IFtdO1xuICAgIHRoaXMucmVxdWVzdGVkQnJpZWZzLmNsZWFyKCk7XG4gICAgdGhpcy5sYXN0RXZlbnRSYW5Bbm5vdW5jZSA9IGZhbHNlO1xuICAgIHRoaXMubGFzdEN1dCA9IG51bGw7XG4gICAgdGhpcy5sYXN0U3RvcHBlZEJyaWVmQXQgPSBudWxsO1xuICAgIHRoaXMucmVwbGF5Rmxvb3JTZXEgPSBmbG9vclNlcTtcbiAgICB0aGlzLmRlZmVycmVkID0gW107XG4gIH1cblxuICBnZXQgaGFzRGVmZXJyZWQoKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMuZGVmZXJyZWQubGVuZ3RoID4gMDtcbiAgfVxuXG4gIGlzU3VwcHJlc3NlZCh0OiBudW1iZXIpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy53aGlsZVNwZWFraW5nICE9PSBcInNlbmRcIiAmJiB0IDwgdGhpcy5zcGVlY2hVbnRpbDtcbiAgfVxuXG4gIG9uQnJpZWZSZXF1ZXN0KGlkOiBzdHJpbmcsIGV2ZW50VGltZTogbnVtYmVyKTogdm9pZCB7XG4gICAgaWYgKGlkKSB0aGlzLnJlcXVlc3RlZEJyaWVmcy5zZXQoaWQsIGV2ZW50VGltZSk7XG4gIH1cblxuICBvblBsYXkocGNtQmFzZTY0OiBzdHJpbmcsIGV2ZW50VGltZTogbnVtYmVyLCBzb3VyY2U/OiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBwYWQgPSBwY21CYXNlNjQuZW5kc1dpdGgoXCI9PVwiKSA/IDIgOiBwY21CYXNlNjQuZW5kc1dpdGgoXCI9XCIpID8gMSA6IDA7XG4gICAgY29uc3QgcGNtQnl0ZXMgPSBNYXRoLm1heCgwLCBNYXRoLmZsb29yKChwY21CYXNlNjQubGVuZ3RoICogMykgLyA0KSAtIHBhZCk7XG4gICAgdGhpcy5zcGVlY2hVbnRpbCA9IE1hdGgubWF4KHRoaXMuc3BlZWNoVW50aWwsIGV2ZW50VGltZSkgKyBwY21CeXRlcyAvIDQ4XzAwMDtcbiAgICBpZiAoc291cmNlID09PSBcImFubm91bmNlclwiKSB7XG4gICAgICBjb25zdCBicmllZkF0ID0gdGhpcy5yZWFkeUJyaWVmcy5zaGlmdCgpID8/IGV2ZW50VGltZTtcbiAgICAgIHRoaXMuYWN0aXZlQnJpZWYgPSB7IGZyb206IGV2ZW50VGltZSwgdW50aWw6IHRoaXMuc3BlZWNoVW50aWwsIGJyaWVmQXQgfTtcbiAgICAgIHRoaXMubGFzdFN0b3BwZWRCcmllZkF0ID0gbnVsbDtcbiAgICB9XG4gIH1cblxuICBvbkZsdXNoKGV2ZW50VGltZTogbnVtYmVyLCBodXNoZWQgPSBmYWxzZSk6IHZvaWQge1xuICAgIHRoaXMuc3BlZWNoVW50aWwgPSBNYXRoLm1pbih0aGlzLnNwZWVjaFVudGlsLCBldmVudFRpbWUpO1xuICAgIGlmICh0aGlzLmFjdGl2ZUJyaWVmICYmIGV2ZW50VGltZSA+PSB0aGlzLmFjdGl2ZUJyaWVmLnVudGlsKSB7XG4gICAgICB0aGlzLmFjdGl2ZUJyaWVmID0gbnVsbDtcbiAgICB9XG4gICAgaWYgKHRoaXMuYWN0aXZlQnJpZWYpIHtcbiAgICAgIGNvbnN0IGEgPSB0aGlzLmFjdGl2ZUJyaWVmO1xuICAgICAgdGhpcy5hY3RpdmVCcmllZiA9IG51bGw7XG4gICAgICAvLyBNYXRjaCBjYWxsLnRzIGN1dEFubm91bmNlbWVudCgpIGFuZCBodXNoUmVwbHkoKTogYSBicmllZiBodXNoZWQsID49IDgwJSBwbGF5ZWQsXG4gICAgICAvLyBvciBwYXN0IGRlbGl2ZXJNYXggaXMgbm90IHJlLXF1ZXVlZC5cbiAgICAgIGNvbnN0IHBsYXllZCA9IChldmVudFRpbWUgLSBhLmZyb20pIC8gTWF0aC5tYXgoMC4xLCBhLnVudGlsIC0gYS5mcm9tKTtcbiAgICAgIGlmIChodXNoZWQpIHtcbiAgICAgICAgdGhpcy5sYXN0U3RvcHBlZEJyaWVmQXQgPSBhLmJyaWVmQXQ7XG4gICAgICAgIHRoaXMubGFzdEN1dCA9IG51bGw7XG4gICAgICB9IGVsc2UgaWYgKHBsYXllZCA8IDAuOCAmJiBldmVudFRpbWUgLSBhLmJyaWVmQXQgPCB0aGlzLmRlbGl2ZXJNYXgpIHtcbiAgICAgICAgdGhpcy5yZWFkeUJyaWVmcy5wdXNoKGEuYnJpZWZBdCk7XG4gICAgICAgIHRoaXMubGFzdEN1dCA9IHsgYXQ6IGV2ZW50VGltZSwgYnJpZWZBdDogYS5icmllZkF0IH07XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIC8vIFNheWluZyBcInN0b3BcIiBvdmVyIGEgYnJpZWYgY3V0cyBpdCBvbiBBQ1RJVklUWV9TVEFSVCBhbmQgdGhlbiBodXNoZXMgbGFzdEN1dCB3aXRoaW4gNiBzLlxuICAgIGlmIChodXNoZWQgJiYgdGhpcy5sYXN0Q3V0ICYmIGV2ZW50VGltZSAtIHRoaXMubGFzdEN1dC5hdCA8IDYpIHtcbiAgICAgIGNvbnN0IGlkeCA9IHRoaXMucmVhZHlCcmllZnMubGFzdEluZGV4T2YodGhpcy5sYXN0Q3V0LmJyaWVmQXQpO1xuICAgICAgaWYgKGlkeCA+PSAwKSB7XG4gICAgICAgIHRoaXMucmVhZHlCcmllZnMuc3BsaWNlKGlkeCwgMSk7XG4gICAgICAgIHRoaXMubGFzdFN0b3BwZWRCcmllZkF0ID0gdGhpcy5sYXN0Q3V0LmJyaWVmQXQ7XG4gICAgICB9XG4gICAgICB0aGlzLmxhc3RDdXQgPSBudWxsO1xuICAgIH0gZWxzZSBpZiAoaHVzaGVkKSB7XG4gICAgICB0aGlzLmxhc3RDdXQgPSBudWxsO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBNaXJyb3JzIGNvcmUgY29tbWFuZCBzaWRlIGVmZmVjdHMgZm9yIHBsYXliYWNrLCBmbHVzaGVzLCBicmllZnMsIGFuZCB2b2ljZSBzdG9wIGNvbW1hbmRzLiAqL1xuICBvYnNlcnZlQ29tbWFuZHMoXG4gICAgY29tbWFuZHM6IHJlYWRvbmx5IHsgdHlwZTogc3RyaW5nOyBwY20/OiB1bmtub3duOyBzb3VyY2U/OiB1bmtub3duOyBpZD86IHVua25vd247IGNvbW1hbmQ/OiB1bmtub3duOyBtZXNzYWdlPzogdW5rbm93biB9W10sXG4gICAgZXZlbnRUaW1lOiBudW1iZXIsXG4gICAgZXZlbnRUeXBlPzogc3RyaW5nLFxuICApOiB2b2lkIHtcbiAgICBjb25zdCBodXNoZWQgPVxuICAgICAgZXZlbnRUeXBlID09PSBcImludGVycnVwdFwiIHx8XG4gICAgICBldmVudFR5cGUgPT09IFwic3RvcFwiIHx8XG4gICAgICBjb21tYW5kcy5zb21lKChjKSA9PiBjLnR5cGUgPT09IFwidm9pY2VDb21tYW5kXCIgJiYgKGMuY29tbWFuZCA9PT0gXCJzdG9wXCIgfHwgYy5jb21tYW5kID09PSBcImNhbmNlbEFsbFwiKSk7XG4gICAgZm9yIChjb25zdCBjIG9mIGNvbW1hbmRzKSB7XG4gICAgICBpZiAoYy50eXBlID09PSBcInBsYXlcIiAmJiB0eXBlb2YgYy5wY20gPT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgdGhpcy5vblBsYXkoYy5wY20sIGV2ZW50VGltZSwgdHlwZW9mIGMuc291cmNlID09PSBcInN0cmluZ1wiID8gYy5zb3VyY2UgOiB1bmRlZmluZWQpO1xuICAgICAgfSBlbHNlIGlmIChjLnR5cGUgPT09IFwiZmx1c2hcIikge1xuICAgICAgICB0aGlzLm9uRmx1c2goZXZlbnRUaW1lLCBodXNoZWQpO1xuICAgICAgfSBlbHNlIGlmIChjLnR5cGUgPT09IFwiYnJpZWZcIiAmJiB0eXBlb2YgYy5pZCA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICB0aGlzLm9uQnJpZWZSZXF1ZXN0KGMuaWQsIGV2ZW50VGltZSk7XG4gICAgICB9IGVsc2UgaWYgKFxuICAgICAgICBjLnR5cGUgPT09IFwibG9nXCIgJiZcbiAgICAgICAgdHlwZW9mIGMubWVzc2FnZSA9PT0gXCJzdHJpbmdcIiAmJlxuICAgICAgICBjLm1lc3NhZ2Uuc3RhcnRzV2l0aChcIm5vdCBhIHN0b3AgYWZ0ZXIgYWxsXCIpICYmXG4gICAgICAgIHRoaXMubGFzdFN0b3BwZWRCcmllZkF0ICE9IG51bGxcbiAgICAgICkge1xuICAgICAgICB0aGlzLnJlYWR5QnJpZWZzLnB1c2godGhpcy5sYXN0U3RvcHBlZEJyaWVmQXQpO1xuICAgICAgICB0aGlzLmxhc3RTdG9wcGVkQnJpZWZBdCA9IG51bGw7XG4gICAgICB9XG4gICAgfVxuICAgIC8vIGNhbGwudHMgb25seSBleHBpcmVzIHBlbmRpbmcgYnJpZWYgcmVxdWVzdHMgaW5zaWRlIGFubm91bmNlKCkgb24gdGljayBvciBhbiBhY2NlcHRlZCBicmllZi5yZWFkeS5cbiAgICBpZiAoZXZlbnRUeXBlICE9PSBcIm1pY1wiICYmIHRoaXMubGFzdEV2ZW50UmFuQW5ub3VuY2UpIHtcbiAgICAgIHRoaXMubGFzdEV2ZW50UmFuQW5ub3VuY2UgPSBmYWxzZTtcbiAgICAgIGZvciAoY29uc3QgW2lkLCBhc2tlZEF0XSBvZiB0aGlzLnJlcXVlc3RlZEJyaWVmcykge1xuICAgICAgICBpZiAoZXZlbnRUaW1lIC0gYXNrZWRBdCA+PSB0aGlzLmJyaWVmV2FpdCkgdGhpcy5yZXF1ZXN0ZWRCcmllZnMuZGVsZXRlKGlkKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogQ2FsbGVkIGltbWVkaWF0ZWx5IGJlZm9yZSBwdXNoaW5nIGFuIGV2ZW50IHRvIHRoZSBjb3JlLiBSZXR1cm5zIGFueSBkZWZlcnJlZCB1bnN1cHByZXNzZWRcbiAgICogZ2FwIGZyYW1lcyB0aGF0IG11c3QgcmVhY2ggdGhlIGNvcmUgZmlyc3Qgc28gbmV3IHBsYXliYWNrIGNhbm5vdCBzaWxlbmNlIHRoZW0uXG4gICAqL1xuICBiZWZvcmVQdXNoKFxuICAgIGV2ZW50OiB7IHR5cGU/OiB1bmtub3duOyBpZD86IHVua25vd247IHBjbT86IHVua25vd247IHRleHQ/OiB1bmtub3duOyBkYXRhPzogdW5rbm93biB9LFxuICAgIGV2ZW50VGltZSA9IDAsXG4gICk6IHsgcGNtOiBzdHJpbmc7IHQ6IG51bWJlciB9W10ge1xuICAgIGlmIChldmVudC50eXBlID09PSBcIm1pY1wiKSByZXR1cm4gW107XG4gICAgaWYgKGV2ZW50LnR5cGUgPT09IFwibXV0ZVwiKSB7XG4gICAgICB0aGlzLmxhc3RFdmVudFJhbkFubm91bmNlID0gZmFsc2U7XG4gICAgICB0aGlzLm11dGVkID0gdHJ1ZTtcbiAgICAgIHJldHVybiB0aGlzLmZsdXNoRGVmZXJyZWQoKTtcbiAgICB9XG4gICAgaWYgKGV2ZW50LnR5cGUgPT09IFwidW5tdXRlXCIpIHtcbiAgICAgIHRoaXMubGFzdEV2ZW50UmFuQW5ub3VuY2UgPSBmYWxzZTtcbiAgICAgIHRoaXMubXV0ZWQgPSBmYWxzZTtcbiAgICAgIHJldHVybiBbXTtcbiAgICB9XG4gICAgbGV0IGFjY2VwdGVkQnJpZWYgPSBmYWxzZTtcbiAgICBpZiAoZXZlbnQudHlwZSA9PT0gXCJicmllZi5mYWlsZWRcIiAmJiB0eXBlb2YgZXZlbnQuaWQgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgIHRoaXMucmVxdWVzdGVkQnJpZWZzLmRlbGV0ZShldmVudC5pZCk7XG4gICAgfSBlbHNlIGlmIChldmVudC50eXBlID09PSBcImJyaWVmLnJlYWR5XCIgJiYgdHlwZW9mIGV2ZW50LmlkID09PSBcInN0cmluZ1wiKSB7XG4gICAgICBpZiAodGhpcy5yZXF1ZXN0ZWRCcmllZnMuZGVsZXRlKGV2ZW50LmlkKSkge1xuICAgICAgICBjb25zdCB2YWxpZCA9XG4gICAgICAgICAgdmFsaWRCcmllZlBjbUJ5dGVzKGV2ZW50LnBjbSkgPiAwICYmXG4gICAgICAgICAgdHlwZW9mIGV2ZW50LnRleHQgPT09IFwic3RyaW5nXCIgJiZcbiAgICAgICAgICBldmVudC50ZXh0LnRyaW0oKS5sZW5ndGggPiAwO1xuICAgICAgICBpZiAodmFsaWQpIHtcbiAgICAgICAgICB0aGlzLnJlYWR5QnJpZWZzLnB1c2goZXZlbnRUaW1lKTtcbiAgICAgICAgICBhY2NlcHRlZEJyaWVmID0gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgICB0aGlzLmxhc3RFdmVudFJhbkFubm91bmNlID0gZXZlbnQudHlwZSA9PT0gXCJ0aWNrXCIgfHwgYWNjZXB0ZWRCcmllZjtcbiAgICBpZiAodGhpcy5kZWZlcnJlZC5sZW5ndGggPT09IDApIHJldHVybiBbXTtcbiAgICBjb25zdCBjYW5TdGFydFBsYXliYWNrID1cbiAgICAgIGFjY2VwdGVkQnJpZWYgfHxcbiAgICAgICh0aGlzLnJlYWR5QnJpZWZzLmxlbmd0aCA+IDAgJiYgZXZlbnQudHlwZSA9PT0gXCJ0aWNrXCIpIHx8XG4gICAgICAoZXZlbnQudHlwZSA9PT0gXCJ3cy5tZXNzYWdlXCIgJiYgU3RyaW5nKGV2ZW50LmRhdGEgPz8gXCJcIikuaW5jbHVkZXMoJ1wiaW5saW5lRGF0YVwiJykpO1xuICAgIHJldHVybiBjYW5TdGFydFBsYXliYWNrID8gdGhpcy5mbHVzaERlZmVycmVkKCkgOiBbXTtcbiAgfVxuXG4gIGZsdXNoRGVmZXJyZWQoKTogeyBwY206IHN0cmluZzsgdDogbnVtYmVyIH1bXSB7XG4gICAgaWYgKHRoaXMuZGVmZXJyZWQubGVuZ3RoID09PSAwKSByZXR1cm4gW107XG4gICAgY29uc3QgaXRlbXMgPSB0aGlzLmRlZmVycmVkLnNwbGljZSgwKTtcbiAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgaXRlbXMpIHtcbiAgICAgIGlmIChpdGVtLmZsb29yU2VxID4gdGhpcy5yZXBsYXlGbG9vclNlcSkgdGhpcy5yZXBsYXlGbG9vclNlcSA9IGl0ZW0uZmxvb3JTZXE7XG4gICAgfVxuICAgIHJldHVybiBpdGVtcy5tYXAoKHsgcGNtLCB0IH0pID0+ICh7IHBjbSwgdCB9KSk7XG4gIH1cblxuICAvKiogRGV0YWNoZXMgZGVmZXJyZWQgZnJhbWVzIGJlZm9yZSBgcHVzaCh7IHR5cGU6IFwid2FrZVwiIH0pYCB3aXRob3V0IGJ1bXBpbmcgYHJlcGxheUZsb29yU2VxYCB5ZXQuICovXG4gIHRha2VEZWZlcnJlZCgpOiBEZWZlcnJlZE1pY0ZyYW1lW10ge1xuICAgIHJldHVybiB0aGlzLmRlZmVycmVkLnNwbGljZSgwKTtcbiAgfVxuXG4gIG9uTWljRnJhbWUocGFyYW1zOiB7XG4gICAgcGNtOiBzdHJpbmc7XG4gICAgdDogbnVtYmVyO1xuICAgIHNlcTogbnVtYmVyO1xuICAgIGxhc3RTZXE6IG51bWJlcjtcbiAgICBpbkZsaWdodFN1cHByZXNzZWRTZXE6IG51bWJlcjtcbiAgICBzdXBwcmVzc2VkOiBib29sZWFuO1xuICB9KTogeyBwY206IHN0cmluZzsgdDogbnVtYmVyIH1bXSB7XG4gICAgLy8gTmV2ZXIgZGVmZXIgYXVkaW8gY2FwdHVyZWQgd2hpbGUgbXV0ZWQ6IHBhc3Mgc3RyYWlnaHQgdGhyb3VnaCBzbyB0aGUgbXV0ZWQgY29yZSBkcm9wcyBpdFxuICAgIC8vIGFuZCBpdCBjYW4gbmV2ZXIgbGVhayBhZnRlciBhIGxhdGVyIHVubXV0ZSAoZS5nLiBwdXNoLXRvLXRhbGsgcmVsZWFzZS9yZS1wcmVzcykuXG4gICAgaWYgKHRoaXMubXV0ZWQpIHtcbiAgICAgIHJldHVybiBbeyBwY206IHBhcmFtcy5wY20sIHQ6IHBhcmFtcy50IH1dO1xuICAgIH1cbiAgICBjb25zdCBmbG9vclNlcSA9IHBhcmFtcy5zZXEgPiAwID8gcGFyYW1zLnNlcSA6IHBhcmFtcy5sYXN0U2VxO1xuICAgIGlmICghcGFyYW1zLnN1cHByZXNzZWQgJiYgdGhpcy53aGlsZVNwZWFraW5nICE9PSBcInNlbmRcIiAmJiBwYXJhbXMuaW5GbGlnaHRTdXBwcmVzc2VkU2VxID4gdGhpcy5yZXBsYXlGbG9vclNlcSkge1xuICAgICAgdGhpcy5kZWZlcnJlZC5wdXNoKHsgc2VxOiBwYXJhbXMuc2VxLCBmbG9vclNlcSwgcGNtOiBwYXJhbXMucGNtLCB0OiBwYXJhbXMudCB9KTtcbiAgICAgIGlmICh0aGlzLmRlZmVycmVkLmxlbmd0aCA+IHRoaXMubWF4RGVmZXJyZWQpIHJldHVybiB0aGlzLmZsdXNoRGVmZXJyZWQoKTtcbiAgICAgIHJldHVybiBbXTtcbiAgICB9XG4gICAgY29uc3Qgb3V0ID0gdGhpcy5mbHVzaERlZmVycmVkKCk7XG4gICAgaWYgKCFwYXJhbXMuc3VwcHJlc3NlZCAmJiBmbG9vclNlcSA+IHRoaXMucmVwbGF5Rmxvb3JTZXEpIHtcbiAgICAgIHRoaXMucmVwbGF5Rmxvb3JTZXEgPSBmbG9vclNlcTtcbiAgICB9XG4gICAgb3V0LnB1c2goeyBwY206IHBhcmFtcy5wY20sIHQ6IHBhcmFtcy50IH0pO1xuICAgIHJldHVybiBvdXQ7XG4gIH1cblxuICAvKipcbiAgICogQ29tcHV0ZXMgdGhlIG9yZGVyZWQgbWljIGZyYW1lcyB0byByZXBsYXkgYWZ0ZXIgYHB1c2goeyB0eXBlOiBcIndha2VcIiB9KWAsIHNraXBwaW5nIGFueSBjaHVua1xuICAgKiBhdCBvciBiZWxvdyBgcmVwbGF5Rmxvb3JTZXFgIHNvIGFscmVhZHktZm9yd2FyZGVkIGdhcCBmcmFtZXMgYXJlIG5ldmVyIGZvbGxvd2VkIGJ5IG9sZGVyIGF1ZGlvLlxuICAgKi9cbiAgcGxhbldha2VSZXBsYXkoXG4gICAgaGl0OiBXYWtlRGV0ZWN0aW9uRXZlbnQsXG4gICAgZGVmZXJyZWQ6IERlZmVycmVkTWljRnJhbWVbXSxcbiAgICBieXRlc1RvQmFzZTY0OiAoYnl0ZXM6IFVpbnQ4QXJyYXkpID0+IHN0cmluZyxcbiAgKTogeyBwY206IHN0cmluZzsgdD86IG51bWJlciB9W10ge1xuICAgIGNvbnN0IGRlZmVycmVkU2VxcyA9IG5ldyBTZXQoZGVmZXJyZWQubWFwKChkKSA9PiBkLnNlcSkuZmlsdGVyKChzKSA9PiBzID4gMCkpO1xuICAgIGNvbnN0IG91dDogeyBwY206IHN0cmluZzsgdD86IG51bWJlciB9W10gPSBbXTtcbiAgICBjb25zdCByZXBsYXllZFNlcXMgPSBuZXcgU2V0PG51bWJlcj4oKTtcbiAgICBsZXQgbWF4Rmxvb3IgPSB0aGlzLnJlcGxheUZsb29yU2VxO1xuICAgIGZvciAoY29uc3QgY2h1bmsgb2YgaGl0LnRyYWlsaW5nKSB7XG4gICAgICBpZiAoY2h1bmsuYnl0ZXMuYnl0ZUxlbmd0aCA9PT0gMCkgY29udGludWU7XG4gICAgICBpZiAoY2h1bmsuc2VxIDw9IHRoaXMucmVwbGF5Rmxvb3JTZXEpIGNvbnRpbnVlO1xuICAgICAgaWYgKCFjaHVuay5zdXBwcmVzc2VkICYmICFkZWZlcnJlZFNlcXMuaGFzKGNodW5rLnNlcSkpIGNvbnRpbnVlO1xuICAgICAgaWYgKGNodW5rLnNlcSA+IDApIHtcbiAgICAgICAgcmVwbGF5ZWRTZXFzLmFkZChjaHVuay5zZXEpO1xuICAgICAgICBpZiAoY2h1bmsuc2VxID4gbWF4Rmxvb3IpIG1heEZsb29yID0gY2h1bmsuc2VxO1xuICAgICAgfVxuICAgICAgb3V0LnB1c2goeyBwY206IGJ5dGVzVG9CYXNlNjQoY2h1bmsuYnl0ZXMpIH0pO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgZGVmZXJyZWQpIHtcbiAgICAgIGlmIChpdGVtLmZsb29yU2VxID4gbWF4Rmxvb3IpIG1heEZsb29yID0gaXRlbS5mbG9vclNlcTtcbiAgICAgIGlmIChpdGVtLnNlcSA+IDAgJiYgcmVwbGF5ZWRTZXFzLmhhcyhpdGVtLnNlcSkpIGNvbnRpbnVlO1xuICAgICAgb3V0LnB1c2goeyBwY206IGl0ZW0ucGNtLCB0OiBpdGVtLnQgfSk7XG4gICAgfVxuICAgIHRoaXMucmVwbGF5Rmxvb3JTZXEgPSBtYXhGbG9vcjtcbiAgICByZXR1cm4gb3V0O1xuICB9XG59XG4iLCAiLy8gVGhlIHdlYiBzdXJmYWNlOiBhIGZvdXJ0aCBob3N0IGZvciB0aGUgdm9pY2UgY29yZSwgYW5kIGEgcGhvbmUtZnJpZW5kbHkgd2F5IHRvIHVzZSBpdCBmb3Igd29yay5cbi8vIEl0IGxvYWRzIHRoZSBkZXYgc2VydmVyJ3MgbGF0ZXN0IGJ1aWxkIGF0IGVhY2ggY2FsbCwgc28gYW4gZWRpdCBpbiBzcmMvIGlzIGxpdmUgb24gdGhlIG5leHRcbi8vIGNhbGwsIGFuZCBrZWVwcyBldmVyeSBjYWxsIGFzIGEgdHJhY2UgdGhlIHJlcGxheSB2aWV3IChhbmQgYW55IG90aGVyIGhvc3QpIGNhbiBydW4gYWdhaW4uXG4vL1xuLy8gVGhlIGhvc3QncyBwYXJ0IGlzIHNtYWxsOiB0aGUgbWljcm9waG9uZSBhbmQgc3BlYWtlciAoYXVkaW8udHMpLCB0aGUgbW9kZWwncyBzb2NrZXQgdGhyb3VnaCB0aGVcbi8vIHNlcnZlcidzIHJlbGF5LCBIZXJtZXMgYW5kIFQzIHRocm91Z2ggdGhlIHNlcnZlciwgYW5kIHRoZSBzY3JlZW4uIFRoZSBjb3JlIGRlY2lkZXMgdGhlIHJlc3QuXG4vL1xuLy8gVHlwaW5nIHdpdGggbm8gY2FsbCBvbiBzdGFydHMgYSBjaGF0IGluc3RlYWQ6IHRoZSBzYW1lIGNvcmUgd2l0aCBgbWVkaXVtOiBcInRleHRcImAsIHdob3NlIHJlcXVlc3RzXG4vLyB0byB0aGUgdGV4dCBtb2RlbCBnbyB0aHJvdWdoIHRoZSBzZXJ2ZXIncyAvZ2VuZXJhdGUuIFRhc2tzLCBmb2xsb3ctdXBzIGFuZCB0aGVpciBjYXJkcyB3b3JrIGFzXG4vLyBpbiBhIGNhbGwuIFByZXNzaW5nIENhbGwgZW5kcyB0aGUgY2hhdCBhbmQgY2FycmllcyBpdHMgY29udmVyc2F0aW9uIG9uIGJ5IHZvaWNlLlxuXG5pbXBvcnQgeyBjb21tYW5kSW4gfSBmcm9tIFwiLi4vc3JjL2NvbW1hbmRzLnRzXCI7XG5pbXBvcnQgeyBDYWxsQXVkaW8sIGJ5dGVzVG9CYXNlNjQgfSBmcm9tIFwiLi9hdWRpby50c1wiO1xuaW1wb3J0IHsgUmVwbGF5IH0gZnJvbSBcIi4vcmVwbGF5LnRzXCI7XG5pbXBvcnQgeyBBdXRvU2Nyb2xsZXIgfSBmcm9tIFwiLi9zY3JvbGwudHNcIjtcbmltcG9ydCB7XG4gIGNhbkZvbGxvd1VwUmVzdWx0LFxuICBmb3JtYXRTaG9ydFRpbWUsXG4gIG5vcm1hbGl6ZURlbnNpdHksXG4gIG5vcm1hbGl6ZVNpZGVGaWx0ZXIsXG4gIHBhcnNlUHJlZml4LFxuICBwbGFpblByZXZpZXcsXG4gIHJlc29sdmVNb2JpbGVCYW5uZXJGaWx0ZXIsXG4gIHJlc29sdmVTaWRlU2VjdGlvbnMsXG4gIHNob3VsZENsZWFyVW5yZWFkUmVzdWx0cyxcbiAgdHlwZSBTaWRlRmlsdGVyLFxufSBmcm9tIFwiLi91aS50c1wiO1xuaW1wb3J0IHsgU2NyZWVuV2FrZUxvY2ssIFdha2VBdWRpb0dhdGUsIFdha2VDbGllbnQsIHR5cGUgV2FrZURldGVjdGlvbkV2ZW50LCB0eXBlIFdha2VUZWxlbWV0cnkgfSBmcm9tIFwiLi93YWtlQ2xpZW50LnRzXCI7XG5cbmludGVyZmFjZSBDb3JlIHtcbiAgdmVyc2lvbjogc3RyaW5nO1xuICBkZWZhdWx0cygpOiBzdHJpbmc7XG4gIGNyZWF0ZShjb25maWc6IHN0cmluZywgdDogbnVtYmVyKTogc3RyaW5nO1xuICBwdXNoKGlkOiBudW1iZXIsIGV2ZW50OiBzdHJpbmcpOiBzdHJpbmc7XG4gIHRyYWNlKGlkOiBudW1iZXIpOiBzdHJpbmc7XG4gIGRpc3Bvc2UoaWQ6IG51bWJlcik6IHZvaWQ7XG59XG50eXBlIENvbW1hbmQgPSBSZWNvcmQ8c3RyaW5nLCBhbnk+ICYgeyB0eXBlOiBzdHJpbmcgfTtcbmludGVyZmFjZSBXYWtlTW9kZWxJbmZvIHsgaWQ6IHN0cmluZzsgbGFiZWw6IHN0cmluZyB9XG5pbnRlcmZhY2UgU2VydmVyQ29uZmlnIHsgcm91dGU6IHN0cmluZzsgbW9kZWw6IHN0cmluZzsgY2FwdGlvbnNNb2RlbD86IHN0cmluZzsgdGV4dE1vZGVsPzogc3RyaW5nOyB2ZXJzaW9uOiBzdHJpbmc7IGhlcm1lczogYm9vbGVhbjsgdDM6IHN0cmluZ1tdIHwgbnVsbDsgd2FrZU1vZGVscz86IFdha2VNb2RlbEluZm9bXSB9XG5cbmNvbnN0ICQgPSA8VCBleHRlbmRzIEhUTUxFbGVtZW50ID0gSFRNTEVsZW1lbnQ+KGlkOiBzdHJpbmcpID0+IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGlkKSBhcyBUO1xuY29uc3Qgbm93ID0gKCkgPT4gcGVyZm9ybWFuY2Uubm93KCkgLyAxMDAwO1xuY29uc3QgY2hlY2tlZCA9IChpZDogc3RyaW5nKSA9PiAkPEhUTUxJbnB1dEVsZW1lbnQ+KGlkKS5jaGVja2VkO1xuXG4vKiogVGhlIGxhdGVzdCBidWlsZCBmcm9tIHRoZSBkZXYgc2VydmVyLCBldmFsdWF0ZWQgYWZyZXNoOiBhbiBlZGl0IGluIHNyYy8gaXMgaW4gdGhlIG5leHQgY2FsbC4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBsb2FkQ29yZSh1cmwgPSBcIi92b2ljZS1jb3JlLmpzXCIpOiBQcm9taXNlPENvcmU+IHtcbiAgY29uc3Qgc291cmNlID0gYXdhaXQgKGF3YWl0IGZldGNoKHVybCwgeyBjYWNoZTogXCJuby1zdG9yZVwiIH0pKS50ZXh0KCk7XG4gIGNvbnN0IHNjb3BlOiB7IFZvaWNlQ29yZT86IENvcmUgfSA9IHt9O1xuICBuZXcgRnVuY3Rpb24oXCJnbG9iYWxUaGlzXCIsIHNvdXJjZSkoc2NvcGUpO1xuICBpZiAoIXNjb3BlLlZvaWNlQ29yZSkgdGhyb3cgbmV3IEVycm9yKFwidGhlIGJ1bmRsZSBkaWRuJ3QgZGVmaW5lIFZvaWNlQ29yZVwiKTtcbiAgcmV0dXJuIHNjb3BlLlZvaWNlQ29yZTtcbn1cblxuLy8gUHJlc2V0czogZWFjaCBzdXJmYWNlJ3Mgc2V0dGluZ3MgYXMgaXRzIGFwcCB3b3VsZCBzZXQgdGhlbS5cblxuY29uc3QgRkFLRV9UViA9IFtcbiAgeyBuYW1lOiBcInR2X3ZvbHVtZVwiLCBkZXNjcmlwdGlvbjogXCJTZXRzIHRoZSBsaXZpbmctcm9vbSBUVidzIHZvbHVtZSwgMCB0byAxMDAuXCIsIHBhcmFtZXRlcnM6IHsgdHlwZTogXCJPQkpFQ1RcIiwgcHJvcGVydGllczogeyBsZXZlbDogeyB0eXBlOiBcIklOVEVHRVJcIiB9IH0sIHJlcXVpcmVkOiBbXCJsZXZlbFwiXSB9IH0sXG4gIHsgbmFtZTogXCJ0dl9wYXVzZVwiLCBkZXNjcmlwdGlvbjogXCJQYXVzZXMgb3IgcmVzdW1lcyB3aGF0J3MgcGxheWluZyBvbiB0aGUgVFYuXCIsIHBhcmFtZXRlcnM6IHsgdHlwZTogXCJPQkpFQ1RcIiwgcHJvcGVydGllczogeyBwYXVzZTogeyB0eXBlOiBcIkJPT0xFQU5cIiB9IH0gfSB9LFxuXTtcblxuY29uc3QgUFJFU0VUUzogUmVjb3JkPHN0cmluZywgUmVjb3JkPHN0cmluZywgdW5rbm93bj4+ID0ge1xuICB3ZWI6IHsgcGxhdGZvcm06IFwid2ViXCIsIGRldmljZTogXCJicm93c2VyXCIsIHN0YW5kYnlBZnRlcjogMzAsIGhhbmRPZmY6IFwibmFtZWRcIiwgc3VwZXJ2aXNlOiB0cnVlLCB2b2NhYnVsYXJ5OiBbXCJIZXJtZXNcIiwgXCJCZW50b1wiLCBcIldvb2Rob3VzZVwiLCBcIlBlbm55d29ydGhcIiwgXCJUM1wiXSB9LFxuICBcIndlYiB3YWtlIHdvcmRcIjoge1xuICAgIHBsYXRmb3JtOiBcIndlYlwiLCBkZXZpY2U6IFwiYnJvd3NlclwiLCBzdGFuZGJ5QWZ0ZXI6IDIwLCBoYW5nVXBBZnRlcjogMTIwLCBoYW5kT2ZmOiBcIm5hbWVkXCIsIHN1cGVydmlzZTogdHJ1ZSxcbiAgICBhdHRlbnRpb246IHsgbW9kZTogXCJ3aW5kb3dcIiwgYWZ0ZXJXYWtlOiA4LCB3aW5kb3c6IDUsIGFmdGVyUXVlc3Rpb246IDEwLCBhZnRlckhhbmRPZmY6IDMsIGFmdGVyQW5ub3VuY2VtZW50OiAwIH0sXG4gICAgdm9jYWJ1bGFyeTogW1wiSGVybWVzXCIsIFwiQmVudG9cIiwgXCJXb29kaG91c2VcIiwgXCJQZW5ueXdvcnRoXCIsIFwiVDNcIl0sXG4gIH0sXG4gIGFuZHJvaWQ6IHsgcGxhdGZvcm06IFwiQW5kcm9pZFwiLCBkZXZpY2U6IFwicGhvbmVcIiwgc3RhbmRieUFmdGVyOiAyMCB9LFxuICBcImFuZHJvaWQgd2FrZSB3b3JkXCI6IHsgcGxhdGZvcm06IFwiQW5kcm9pZFwiLCBkZXZpY2U6IFwicGhvbmVcIiwgc3RhbmRieUFmdGVyOiAyMCwgaGFuZ1VwQWZ0ZXI6IDE1IH0sXG4gIG1hY29zOiB7IHBsYXRmb3JtOiBcIm1hY09TXCIsIGRldmljZTogXCJNYWNcIiwgc3RhbmRieUFmdGVyOiAyMCB9LFxuICBlY2hvOiB7XG4gICAgcGxhdGZvcm06IFwiRWNob1wiLCBkZXZpY2U6IFwic3BlYWtlclwiLCBoYW5nVXBBZnRlcjogNiwgc3RhbmRieUFmdGVyOiA4LCBlYXJjb25zOiB0cnVlLCB2b2NhYnVsYXJ5OiBbXCJIZXJtZXNcIiwgXCJCZW50b1wiLCBcIldvb2Rob3VzZVwiXSxcbiAgICBtaWM6IHsgd2hpbGVTcGVha2luZzogXCJ3YWtlXCIsIGdhaW5EYjogMCB9LCBob3N0VG9vbHM6IEZBS0VfVFYsXG4gIH0sXG59O1xuXG4vLyBTdGF0ZS5cblxuY29uc3QgYXVkaW8gPSBuZXcgQ2FsbEF1ZGlvKCk7XG5sZXQgc2VydmVyOiBTZXJ2ZXJDb25maWc7XG5sZXQgY29yZTogQ29yZSB8IG51bGwgPSBudWxsO1xubGV0IGNhbGxJZCA9IDA7XG4vKiogTW9ub3RvbmljIHBlci1wYWdlIHNlc3Npb24gaWQgKHVubGlrZSBjb3JlJ3MgY2FsbElkL3Rhc2tJZCwgd2hpY2ggcmVzdGFydCBhZnRlciBsb2FkQ29yZSgpKS4gKi9cbmxldCBzZXNzaW9uU2VxID0gMDtcbmxldCBhY3RpdmVTZXNzaW9uID0gMDtcbmxldCBjYWxsTmFtZSA9IFwiXCI7XG5sZXQgdGlja2VyID0gMDtcbmxldCB0cmFjZVRpbWVyID0gMDtcbmxldCBzdGFydGVkQXQgPSBub3coKTtcbmNvbnN0IHNvY2tldHMgPSBuZXcgTWFwPG51bWJlciwgV2ViU29ja2V0PigpO1xuLyoqIFRoZSBzb2NrZXRzIHRvIHRoZSB0cmFuc2NyaXB0aW9uIG1vZGVsOiB0aGVpciBhdWRpbyBpcyB0aGUgbW9kZWwncyBhZ2Fpbiwgc28gaXQgaXNuJ3QgY291bnRlZCBvciBsb2dnZWQgdHdpY2UuICovXG5jb25zdCBjYXB0aW9uU29ja2V0cyA9IG5ldyBTZXQ8bnVtYmVyPigpO1xuY29uc3QgcnVucyA9IG5ldyBNYXA8c3RyaW5nLCB7IGFib3J0OiBBYm9ydENvbnRyb2xsZXI7IGFnZW50OiBzdHJpbmc7IHRhc2tJZDogc3RyaW5nIH0+KCk7XG5pbnRlcmZhY2UgVGFza1ZpZXcgeyBjOiBDb21tYW5kOyBzaW5jZTogbnVtYmVyOyBlbmRlZDogbnVtYmVyIHwgbnVsbDsgdGhyZWFkPzogc3RyaW5nOyByZXN1bHRJZD86IHN0cmluZzsgYXBwcm92YWw/OiB7IGNvbW1hbmQ6IHN0cmluZyB9IH1cbmNvbnN0IHRhc2tzID0gbmV3IE1hcDxzdHJpbmcsIFRhc2tWaWV3PigpO1xuaW50ZXJmYWNlIFJlc3VsdEVudHJ5IHtcbiAgaWQ6IHN0cmluZztcbiAgYWdlbnQ6IHN0cmluZztcbiAgbGFiZWw6IHN0cmluZztcbiAgdGV4dDogc3RyaW5nO1xuICBmYWlsZWQ6IGJvb2xlYW47XG4gIHRhc2tJZD86IHN0cmluZztcbiAgc2Vzc2lvbklkOiBudW1iZXI7XG4gIGNhcmQ6IEhUTUxFbGVtZW50O1xuICBoZWFkOiBIVE1MQnV0dG9uRWxlbWVudDtcbiAgYm9keTogSFRNTEVsZW1lbnQ7XG4gIG1vcmVCdG46IEhUTUxCdXR0b25FbGVtZW50O1xuICBmb2xsb3dCdG4/OiBIVE1MQnV0dG9uRWxlbWVudDtcbiAgcmVmUm93OiBIVE1MQnV0dG9uRWxlbWVudDtcbn1cbmNvbnN0IHJlc3VsdHMgPSBuZXcgTWFwPHN0cmluZywgUmVzdWx0RW50cnk+KCk7XG5sZXQgbmV4dFJlc3VsdFNlcSA9IDA7XG5sZXQgc2lkZUZpbHRlcjogU2lkZUZpbHRlciA9IFwiYWxsXCI7XG5sZXQgdW5yZWFkTW9iaWxlUmVzdWx0cyA9IDA7XG5sZXQgZmxhc2hUaW1lciA9IDA7XG5sZXQgZWFybGllckFjdGl2ZUNvdW50ID0gMDtcbmxldCBlYXJsaWVyV2FpdGluZ0NvdW50ID0gMDtcbmxldCBjb3VudHMgPSB7IG1pYzogMCwgcGxheTogMCwgc2VudDogMCB9O1xubGV0IGZha2VUdkxldmVsID0gMTU7XG5sZXQgY29yZVN0YXR1cyA9IFwiaWRsZVwiO1xubGV0IG11dGVkID0gZmFsc2U7XG5sZXQgaG9sZGluZyA9IGZhbHNlO1xuY29uc3Qgc2NyZWVuV2FrZUxvY2sgPSBuZXcgU2NyZWVuV2FrZUxvY2soKTtcbi8qKiBXYWtlIHdvcmQgbG9vcCBzdGF0ZTogYXJtZWQgYmV0d2VlbiBjYWxscywgcmVxdWVzdGVkIGJ5IGNvcmUgd2hpbGUgZG9ybWFudC9zcGVha2luZywgb3IgbWlkLWhhbmRvZmYuICovXG5sZXQgd2FrZUFybWVkID0gZmFsc2U7XG5sZXQgYXJtR2VuID0gMDtcbmxldCBjb3JlV2FudHNXYWtlID0gZmFsc2U7XG4vKiogV2hpY2ggY2FsbCAob3IgMCBmb3IgaWRsZSkgb3ducyB0aGUgd2FrZSB3b3JrZXIncyBjdXJyZW50IGxpc3RlbmluZyBwZXJpb2QuICovXG5sZXQgd2FrZVBlcmlvZENhbGxJZDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5jb25zdCB3YWtlR2F0ZSA9IG5ldyBXYWtlQXVkaW9HYXRlKCk7XG5sZXQgd2FrZUxvYWRpbmcgPSBmYWxzZTtcbmxldCB3YWtlU3RhcnRpbmcgPSBmYWxzZTtcbmxldCBzdGFydGluZ0NhbGwgPSBmYWxzZTtcbmxldCBvcGVuaW5nQ2h1bmtzOiBVaW50OEFycmF5W10gPSBbXTtcbmxldCBvcGVuaW5nQnl0ZXMgPSAwO1xuY29uc3QgT1BFTklOR19NQVhfQllURVMgPSAxMCAqIDMyXzAwMDtcbmxldCB3YWtlTGFzdFRlbDogV2FrZVRlbGVtZXRyeSB8IG51bGwgPSBudWxsO1xuLyoqIFdoYXQgdGhlIHNlc3Npb24gb24gc2NyZWVuIGlzOiBhIHZvaWNlIGNhbGwsIG9yIGEgdHlwZWQgY2hhdCAodGhlIGNvcmUncyBtZWRpdW0gXCJ0ZXh0XCIpLiAqL1xubGV0IG1lZGl1bTogXCJ2b2ljZVwiIHwgXCJ0ZXh0XCIgPSBcInZvaWNlXCI7XG4vKiogQSBjaGF0J3MgbW9kZWwgaXMgd3JpdGluZyBpdHMgYW5zd2VyLiAqL1xubGV0IHRoaW5raW5nID0gZmFsc2U7XG4vKiogQSBjaGF0J3MgcmVxdWVzdHMgdG8gdGhlIHRleHQgbW9kZWwgdGhhdCBhcmUgdW5kZXIgd2F5LiAqL1xuY29uc3QgcmVxdWVzdHMgPSBuZXcgTWFwPG51bWJlciwgQWJvcnRDb250cm9sbGVyPigpO1xuLyoqIFRoZSBsYXN0IHNlc3Npb24gd2luZGluZyBkb3duIChpdHMgdHJhY2Ugc2F2ZWQsIHRoZSBjb3JlJ3MgY2FsbCBkaXNwb3NlZCk6IHRoZSBuZXh0IHN0YXJ0cyBhZnRlciBpdC4gKi9cbmxldCBlbmRpbmc6IFByb21pc2U8dm9pZD4gPSBQcm9taXNlLnJlc29sdmUoKTtcblxuLy8gVGhlIGNvbnZlcnNhdGlvbiwga2VwdCBzbyBhIG5ldyBjYWxsIGNhbiBjYXJyeSBvbiBmcm9tIGl0ICh0aGUgY29yZSdzIGBoaXN0b3J5YCwgcmVjYXBwZWQgdG8gdGhlIG1vZGVsKS5cbmludGVyZmFjZSBDaGF0TGluZSB7IHJvbGU6IFwidXNlclwiIHwgXCJhc3Npc3RhbnRcIjsgc3BlYWtlcj86IHN0cmluZzsgdGV4dDogc3RyaW5nIH1cbmNvbnN0IEhJU1RPUlkgPSBcInZvaWNlLmhpc3RvcnlcIjtcbmNvbnN0IEhJU1RPUllfTUFYX0FHRSA9IDEyICogMzYwMCAqIDEwMDA7XG5sZXQgY2hhdDogQ2hhdExpbmVbXSA9IFtdO1xuLyoqIFRoZSBjb3JlJ3MgbnVtYmVyIGZvciB0aGUgbGluZSB0aGUgbGFzdCB3b3JkcyB3ZXJlIHJlbWVtYmVyZWQgb24sIHVudGlsIHNvbWV0aGluZyBlbHNlIGlzLiAqL1xubGV0IGxhc3RMaW5lOiBudW1iZXIgfCBudWxsID0gbnVsbDtcblxuZnVuY3Rpb24gcmVtZW1iZXIocm9sZTogXCJ1c2VyXCIgfCBcImFzc2lzdGFudFwiLCB0ZXh0OiBzdHJpbmcsIHNwZWFrZXI/OiBzdHJpbmcsIGpvaW4gPSBmYWxzZSkge1xuICBjb25zdCBsYXN0ID0gY2hhdC5hdCgtMSk7XG4gIGlmIChqb2luICYmIGxhc3QgJiYgbGFzdC5yb2xlID09PSByb2xlICYmIGxhc3Quc3BlYWtlciA9PT0gc3BlYWtlcikgbGFzdC50ZXh0ICs9IHRleHQ7XG4gIGVsc2UgY2hhdC5wdXNoKHNwZWFrZXIgPyB7IHJvbGUsIHNwZWFrZXIsIHRleHQgfSA6IHsgcm9sZSwgdGV4dCB9KTtcbiAgaWYgKGNoYXQubGVuZ3RoID4gMjAwKSBjaGF0LnNwbGljZSgwLCBjaGF0Lmxlbmd0aCAtIDIwMCk7XG4gIGxvY2FsU3RvcmFnZS5zZXRJdGVtKEhJU1RPUlksIEpTT04uc3RyaW5naWZ5KHsgYXQ6IERhdGUubm93KCksIGNoYXQgfSkpO1xufVxuXG5mdW5jdGlvbiBzYXZlZEhpc3RvcnkoKTogQ2hhdExpbmVbXSB7XG4gIHRyeSB7XG4gICAgY29uc3Qgc2F2ZWQgPSBKU09OLnBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKEhJU1RPUlkpID8/IFwibnVsbFwiKTtcbiAgICByZXR1cm4gc2F2ZWQgJiYgRGF0ZS5ub3coKSAtIHNhdmVkLmF0IDwgSElTVE9SWV9NQVhfQUdFICYmIEFycmF5LmlzQXJyYXkoc2F2ZWQuY2hhdCkgPyBzYXZlZC5jaGF0IDogW107XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBbXTtcbiAgfVxufVxuXG4vKiogVHdvLW5vdGUgY2hpbWUsIFBDTTE2IG1vbm8gYXQgMjQga0h6LCBiYXNlNjQuICovXG5mdW5jdGlvbiB0d29Ob3RlVG9uZShmMTogbnVtYmVyLCBmMjogbnVtYmVyLCBub3RlU2VjOiBudW1iZXIsIGFtcDogbnVtYmVyKTogc3RyaW5nIHtcbiAgY29uc3QgcmF0ZSA9IDI0MDAwLCBuID0gTWF0aC5yb3VuZChyYXRlICogbm90ZVNlYyAqIDIpLCBoYWxmID0gTWF0aC5yb3VuZChyYXRlICogbm90ZVNlYyksIG91dCA9IG5ldyBJbnQxNkFycmF5KG4pO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IG47IGkrKykge1xuICAgIGNvbnN0IGZpcnN0ID0gaSA8IGhhbGY7XG4gICAgY29uc3QgdCA9IGkgLyByYXRlLCBmID0gZmlyc3QgPyBmMSA6IGYyLCBsb2NhbCA9IGZpcnN0ID8gdCA6IHQgLSBub3RlU2VjO1xuICAgIGNvbnN0IGVudiA9IE1hdGgubWluKDEsIGxvY2FsICogNjAsIChub3RlU2VjIC0gbG9jYWwpICogNjApO1xuICAgIG91dFtpXSA9IE1hdGgucm91bmQoTWF0aC5zaW4oMiAqIE1hdGguUEkgKiBmICogdCkgKiBNYXRoLm1heCgwLCBlbnYpICogYW1wKTtcbiAgfVxuICByZXR1cm4gYnl0ZXNUb0Jhc2U2NChuZXcgVWludDhBcnJheShvdXQuYnVmZmVyKSk7XG59XG5cbi8qKiBUd28gcmlzaW5nIG5vdGVzOiBzb21ldGhpbmcgb24gdGhlIHNjcmVlbiBuZWVkcyB0aGUgdXNlci4gKi9cbmNvbnN0IEFQUFJPVkFMX1RPTkUgPSB0d29Ob3RlVG9uZSg2NjAsIDg4MCwgMC4xNiwgNjAwMCk7XG4vKiogQ3Jpc3AgcmlzaW5nIGNoaW1lOiB0aGUgd2FrZSB3b3JkIGZpcmVkIChzdGFydCBzaWduYWwpLiAqL1xuY29uc3QgV0FLRV9UT05FID0gdHdvTm90ZVRvbmUoNTg3LjMzLCA4ODAsIDAuMTEsIDU1MDApO1xuLyoqIFNvZnQgZmFsbGluZyBjaGltZTogdGhlIGF0dGVudGlvbiB3aW5kb3cgY2xvc2VkIGFuZCB0aGUgY2FsbCB3ZW50IGRvcm1hbnQgKGVuZCBzaWduYWwpLiAqL1xuY29uc3QgU0xFRVBfVE9ORSA9IHR3b05vdGVUb25lKDY1OS4yNSwgNDkzLjg4LCAwLjExLCAzNDAwKTtcblxuLy8gTGF0ZW5jeTogdGhlIG5ldHdvcmsncyByb3VuZCB0cmlwLCBhbmQgaG93IGxvbmcgYWZ0ZXIgdGhlIHVzZXIgc3RvcHMgdGFsa2luZyB0aGUgcmVwbHkgc3RhcnRzLlxuY29uc3QgbWV0cmljcyA9IHsgcnR0OiBbXSBhcyBudW1iZXJbXSwgcmVwbHk6IFtdIGFzIG51bWJlcltdLCBsYXN0Vm9pY2U6IDAsIGxhc3RQbGF5OiAwLCByZXBsaWVkOiB0cnVlIH07XG5cbmZ1bmN0aW9uIG1lZGlhbih4czogbnVtYmVyW10pOiBudW1iZXIgfCBudWxsIHtcbiAgaWYgKHhzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHMgPSBbLi4ueHNdLnNvcnQoKGEsIGIpID0+IGEgLSBiKTtcbiAgcmV0dXJuIHNbTWF0aC5mbG9vcihzLmxlbmd0aCAvIDIpXTtcbn1cblxuZnVuY3Rpb24gc2hvd01ldHJpY3MoKSB7XG4gIGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBydHQgPSBtZWRpYW4obWV0cmljcy5ydHQpO1xuICBpZiAocnR0ICE9IG51bGwpIHBhcnRzLnB1c2goYCR7TWF0aC5yb3VuZChydHQgKiAxMDAwKX0gbXNgKTtcbiAgY29uc3QgcmVwbHkgPSBtZWRpYW4obWV0cmljcy5yZXBseSk7XG4gIGlmIChyZXBseSAhPSBudWxsKSBwYXJ0cy5wdXNoKGByZXBseSAke21ldHJpY3MucmVwbHkuYXQoLTEpIS50b0ZpeGVkKDEpfXMgKCR7cmVwbHkudG9GaXhlZCgxKX1zIG1lZClgKTtcbiAgY29uc3Qgb3V0ID0gYXVkaW8ub3V0cHV0TGF0ZW5jeTtcbiAgaWYgKG91dCAhPSBudWxsKSBwYXJ0cy5wdXNoKGBhdWRpbyAke01hdGgucm91bmQob3V0ICogMTAwMCl9IG1zYCk7XG4gIGxldCBidWZmZXJlZCA9IDA7XG4gIGZvciAoY29uc3Qgd3Mgb2Ygc29ja2V0cy52YWx1ZXMoKSkgYnVmZmVyZWQgKz0gd3MuYnVmZmVyZWRBbW91bnQ7XG4gIGlmIChidWZmZXJlZCA+IDMyXzAwMCkgcGFydHMucHVzaChgdXBsb2FkICskeyhidWZmZXJlZCAvIDMyXzAwMCkudG9GaXhlZCgxKX1zYCk7XG4gICQoXCJtZXRyaWNzXCIpLnRleHRDb250ZW50ID0gcGFydHMuam9pbihcIiBcdTAwQjcgXCIpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBwaW5nKCkge1xuICBjb25zdCB0ID0gbm93KCk7XG4gIHRyeSB7XG4gICAgYXdhaXQgZmV0Y2goXCIvcGluZ1wiLCB7IGNhY2hlOiBcIm5vLXN0b3JlXCIgfSk7XG4gICAgbWV0cmljcy5ydHQucHVzaChub3coKSAtIHQpO1xuICAgIGlmIChtZXRyaWNzLnJ0dC5sZW5ndGggPiAxMikgbWV0cmljcy5ydHQuc2hpZnQoKTtcbiAgfSBjYXRjaCB7fVxuICBzaG93TWV0cmljcygpO1xufVxuXG4vLyBUaGVtZSAmIGRlbnNpdHkuXG5cbmZ1bmN0aW9uIGFwcGx5VGhlbWUoY2hvaWNlOiBzdHJpbmcpIHtcbiAgY29uc3Qgcm9vdCA9IGRvY3VtZW50LmRvY3VtZW50RWxlbWVudDtcbiAgaWYgKGNob2ljZSA9PT0gXCJkYXJrXCIgfHwgY2hvaWNlID09PSBcImxpZ2h0XCIpIHJvb3QuZGF0YXNldC50aGVtZSA9IGNob2ljZTtcbiAgZWxzZSBkZWxldGUgcm9vdC5kYXRhc2V0LnRoZW1lO1xuICBjb25zdCBkYXJrID0gY2hvaWNlID09PSBcImRhcmtcIiB8fCAoY2hvaWNlICE9PSBcImxpZ2h0XCIgJiYgbWF0Y2hNZWRpYShcIihwcmVmZXJzLWNvbG9yLXNjaGVtZTogZGFyaylcIikubWF0Y2hlcyk7XG4gIGNvbnN0IG1ldGEgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInRoZW1lLWNvbG9yXCIpO1xuICBpZiAobWV0YSkgbWV0YS5zZXRBdHRyaWJ1dGUoXCJjb250ZW50XCIsIGRhcmsgPyBcIiMwZTBmMGZcIiA6IFwiI2Y2ZjVmMFwiKTtcbiAgZm9yIChjb25zdCBidG4gb2YgQXJyYXkuZnJvbShkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxCdXR0b25FbGVtZW50PihcIiN0aGVtZS1waWNrZXIgYnV0dG9uXCIpKSkge1xuICAgIGJ0bi5jbGFzc0xpc3QudG9nZ2xlKFwib25cIiwgYnRuLmRhdGFzZXQudGhlbWUgPT09IChjaG9pY2UgfHwgXCJzeXN0ZW1cIikpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGFwcGx5RGVuc2l0eShjaG9pY2U6IHN0cmluZyB8IG51bGwpIHtcbiAgY29uc3QgZGVuc2l0eSA9IG5vcm1hbGl6ZURlbnNpdHkoY2hvaWNlKTtcbiAgY29uc3Qgcm9vdCA9IGRvY3VtZW50LmRvY3VtZW50RWxlbWVudDtcbiAgaWYgKGRlbnNpdHkgPT09IFwiY29tZm9ydGFibGVcIikgcm9vdC5kYXRhc2V0LmRlbnNpdHkgPSBcImNvbWZvcnRhYmxlXCI7XG4gIGVsc2UgZGVsZXRlIHJvb3QuZGF0YXNldC5kZW5zaXR5O1xuICBmb3IgKGNvbnN0IGJ0biBvZiBBcnJheS5mcm9tKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiI2RlbnNpdHktcGlja2VyIGJ1dHRvblwiKSkpIHtcbiAgICBidG4uY2xhc3NMaXN0LnRvZ2dsZShcIm9uXCIsIGJ0bi5kYXRhc2V0LmRlbnNpdHkgPT09IGRlbnNpdHkpO1xuICB9XG4gIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB1cGRhdGVBbGxSZXN1bHRDbGFtcGluZygpKTtcbn1cblxuLy8gVGhlIHNjcmVlbi5cblxuZnVuY3Rpb24gc2V0Q2FsbEJ1dHRvbihsaXZlOiBib29sZWFuKSB7XG4gIGNvbnN0IGJ0biA9ICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiY2FsbFwiKTtcbiAgYnRuLmNsYXNzTGlzdC50b2dnbGUoXCJsaXZlXCIsIGxpdmUpO1xuICBjb25zdCBsYWJlbCA9IGJ0bi5xdWVyeVNlbGVjdG9yKFwiLmNhbGwtbGFiZWxcIik7XG4gIGlmIChsYWJlbCkgbGFiZWwudGV4dENvbnRlbnQgPSBsaXZlID8gXCJIYW5nIHVwXCIgOiBcIkNhbGxcIjtcbn1cblxuZnVuY3Rpb24gc3luY1Jlc3VtZUJ1dHRvbnMoc2hvdzogYm9vbGVhbikge1xuICAkKFwicmVzdW1lXCIpLmhpZGRlbiA9ICFzaG93O1xuICAkKFwiaGVyby1yZXN1bWVcIikuaGlkZGVuID0gIXNob3c7XG59XG5cbmZ1bmN0aW9uIHN5bmNDb21wb3NlcigpIHtcbiAgY29uc3QgaW5wdXQgPSAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwidGV4dFwiKTtcbiAgY29uc3QgdHJpbW1lZCA9IGlucHV0LnZhbHVlLnRyaW0oKTtcbiAgJChcInNlbmRidG5cIikuY2xhc3NMaXN0LnRvZ2dsZShcInJlYWR5XCIsIHRyaW1tZWQubGVuZ3RoID4gMCk7XG4gIGNvbnN0IHBhcnNlZCA9IHBhcnNlUHJlZml4KHRyaW1tZWQpO1xuICAkKFwibW9kZS13cmFwXCIpLmRhdGFzZXQubW9kZSA9IHBhcnNlZC5tb2RlID8/ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwibW9kZVwiKS52YWx1ZTtcbn1cblxuZnVuY3Rpb24gZm9ybWF0Q2xvY2soc2Vjb25kczogbnVtYmVyKTogc3RyaW5nIHtcbiAgY29uc3QgdG90YWwgPSBNYXRoLm1heCgwLCBNYXRoLmZsb29yKHNlY29uZHMpKTtcbiAgY29uc3QgaCA9IE1hdGguZmxvb3IodG90YWwgLyAzNjAwKTtcbiAgY29uc3QgbSA9IE1hdGguZmxvb3IoKHRvdGFsICUgMzYwMCkgLyA2MCk7XG4gIGNvbnN0IHMgPSB0b3RhbCAlIDYwO1xuICBjb25zdCBwYWQgPSAobjogbnVtYmVyKSA9PiBTdHJpbmcobikucGFkU3RhcnQoMiwgXCIwXCIpO1xuICByZXR1cm4gaCA+IDAgPyBgJHtofToke3BhZChtKX06JHtwYWQocyl9YCA6IGAke3BhZChtKX06JHtwYWQocyl9YDtcbn1cblxuY29uc3QgVklaX1dFSUdIVFMgPSBbMC40OCwgMC44NiwgMS4wLCAwLjc4LCAwLjQ0XTtcbmZ1bmN0aW9uIHVwZGF0ZVZpc3VhbGl6ZXIobW9kZTogc3RyaW5nLCBsZXZlbDogbnVtYmVyKSB7XG4gIGNvbnN0IHZpeiA9ICQoXCJ2aXpcIik7XG4gIHZpei5kYXRhc2V0Lm1vZGUgPSBtb2RlO1xuICBjb25zdCBiYXJzID0gdml6LmNoaWxkcmVuO1xuICBpZiAobW9kZSA9PT0gXCJsaXN0ZW5pbmdcIiB8fCBtb2RlID09PSBcIndvcmtpbmdcIikge1xuICAgIGNvbnN0IGVuZXJneSA9IE1hdGgubWluKDEsIGxldmVsICogMTQpO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYmFycy5sZW5ndGg7IGkrKykge1xuICAgICAgY29uc3QgaCA9IDAuMjQgKyBlbmVyZ3kgKiBWSVpfV0VJR0hUU1tpXSAqIDAuNzY7XG4gICAgICAoYmFyc1tpXSBhcyBIVE1MRWxlbWVudCkuc3R5bGUudHJhbnNmb3JtID0gYHNjYWxlWSgke2gudG9GaXhlZCgyKX0pYDtcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBiYXJzLmxlbmd0aDsgaSsrKSAoYmFyc1tpXSBhcyBIVE1MRWxlbWVudCkuc3R5bGUudHJhbnNmb3JtID0gXCJcIjtcbiAgfVxufVxuXG4vKiogQSBzeXN0ZW0gbm90aWZpY2F0aW9uIHdoaWxlIHRoZSBwYWdlIGlzIGhpZGRlbjogYSB0YXNrIGZpbmlzaGVkLCBvciBvbmUgbmVlZHMgdGhlIHVzZXIuICovXG5mdW5jdGlvbiBub3RpZnkodGl0bGU6IHN0cmluZywgYm9keTogc3RyaW5nKSB7XG4gIGlmICghZG9jdW1lbnQuaGlkZGVuIHx8ICEoXCJOb3RpZmljYXRpb25cIiBpbiB3aW5kb3cpIHx8IE5vdGlmaWNhdGlvbi5wZXJtaXNzaW9uICE9PSBcImdyYW50ZWRcIikgcmV0dXJuO1xuICB0cnkge1xuICAgIGNvbnN0IG4gPSBuZXcgTm90aWZpY2F0aW9uKHRpdGxlLCB7IGJvZHk6IGJvZHkuc2xpY2UoMCwgMTgwKSwgaWNvbjogXCIvd2ViL2ljb25zL2ljb24tMTkyLnBuZ1wiLCB0YWc6IHRpdGxlIH0pO1xuICAgIG4ub25jbGljayA9ICgpID0+IHsgd2luZG93LmZvY3VzKCk7IG4uY2xvc2UoKTsgfTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gUGhvbmVzIHdhbnQgbm90aWZpY2F0aW9ucyBmcm9tIGEgc2VydmljZSB3b3JrZXI7IHRoZSBwYWdlIGhhcyBub25lLlxuICB9XG59XG5cbmZ1bmN0aW9uIHRvYXN0KHRleHQ6IHN0cmluZykge1xuICBjb25zdCB0ID0gJChcInRvYXN0XCIpO1xuICB0LnRleHRDb250ZW50ID0gdGV4dDtcbiAgdC5jbGFzc0xpc3QuYWRkKFwib25cIik7XG4gIGNsZWFyVGltZW91dCgodG9hc3QgYXMgYW55KS50aW1lcik7XG4gICh0b2FzdCBhcyBhbnkpLnRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB0LmNsYXNzTGlzdC5yZW1vdmUoXCJvblwiKSwgMTgwMCk7XG59XG5cbmZ1bmN0aW9uIGxvZyhraW5kOiBzdHJpbmcsIHRleHQ6IHN0cmluZywgY2xzID0gXCJcIikge1xuICBjb25zdCBwYW5lID0gJChcImxvZ1wiKTtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IGByb3cgJHtjbHN9YDtcbiAgcm93LmlubmVySFRNTCA9IGA8c3BhbiBjbGFzcz1cInRcIj4keyhub3coKSAtIHN0YXJ0ZWRBdCkudG9GaXhlZCgyKX08L3NwYW4+PHNwYW4gY2xhc3M9XCJrXCI+JHtraW5kfTwvc3Bhbj5gO1xuICBjb25zdCBib2R5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGJvZHkuY2xhc3NOYW1lID0gXCJiXCI7XG4gIGJvZHkudGV4dENvbnRlbnQgPSB0ZXh0O1xuICByb3cuYXBwZW5kKGJvZHkpO1xuICBjb25zdCBzdGljayA9IHBhbmUuc2Nyb2xsVG9wICsgcGFuZS5jbGllbnRIZWlnaHQgPj0gcGFuZS5zY3JvbGxIZWlnaHQgLSAzMDtcbiAgcGFuZS5hcHBlbmQocm93KTtcbiAgd2hpbGUgKHBhbmUuY2hpbGRFbGVtZW50Q291bnQgPiAzMDAwKSBwYW5lLmZpcnN0RWxlbWVudENoaWxkIS5yZW1vdmUoKTtcbiAgaWYgKHN0aWNrKSBwYW5lLnNjcm9sbFRvcCA9IHBhbmUuc2Nyb2xsSGVpZ2h0O1xufVxuXG4vKiogQSBmcmFtZSBmcm9tIG9yIHRvIEdlbWluaSwgd2l0aCBhdWRpbyBjdXQgb3V0LCBzaG9ydCBlbm91Z2ggdG8gcmVhZC4gKi9cbmZ1bmN0aW9uIGJyaWVmKGRhdGE6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBkYXRhLnJlcGxhY2UoL1wiZGF0YVwiOlwiW0EtWmEtejAtOSsvPV17NDAsfVwiL2csIChtKSA9PiBgXCJkYXRhXCI6XCJcdTIwMjYke01hdGgucm91bmQoKChtLmxlbmd0aCAtIDkpICogMykgLyA0KX0gYnl0ZXNcImApLnNsaWNlKDAsIDYwMCk7XG59XG5cbmZ1bmN0aW9uIGVzY2FwZUh0bWwodGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHRleHQucmVwbGFjZSgvWyY8PlwiJ10vZywgKGMpID0+ICh7IFwiJlwiOiBcIiZhbXA7XCIsIFwiPFwiOiBcIiZsdDtcIiwgXCI+XCI6IFwiJmd0O1wiLCAnXCInOiBcIiZxdW90O1wiLCBcIidcIjogXCImIzM5O1wiIH0pW2NdISk7XG59XG5cbi8qKiBBIGxpdHRsZSBNYXJrZG93biwgc2FmZWx5OiBjb2RlLCBib2xkLCBsaW5rcywgbGlzdHMgYW5kIGhlYWRpbmdzLCB0aGUgcmVzdCBhcyB0ZXh0LiAqL1xuZnVuY3Rpb24gbWFya2Rvd24odGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgYmxvY2tzID0gZXNjYXBlSHRtbCh0ZXh0LnRyaW0oKSkuc3BsaXQoL2BgYCg/OlxcdyspP1xcbj8vKTtcbiAgcmV0dXJuIGJsb2Nrcy5tYXAoKGJsb2NrLCBpKSA9PiB7XG4gICAgaWYgKGkgJSAyID09PSAxKSByZXR1cm4gYDxwcmU+PGNvZGU+JHtibG9jay5yZXBsYWNlKC9cXG4kLywgXCJcIil9PC9jb2RlPjwvcHJlPmA7XG4gICAgY29uc3QgaW5saW5lID0gKHM6IHN0cmluZykgPT4gc1xuICAgICAgLnJlcGxhY2UoL2AoW15gXFxuXSspYC9nLCBcIjxjb2RlPiQxPC9jb2RlPlwiKVxuICAgICAgLnJlcGxhY2UoL1xcKlxcKihbXipcXG5dKylcXCpcXCovZywgXCI8Yj4kMTwvYj5cIilcbiAgICAgIC5yZXBsYWNlKC9cXFsoW15cXF1cXG5dKylcXF1cXCgoaHR0cHM/OlxcL1xcL1teXFxzKV0rKVxcKS9nLCAnPGEgaHJlZj1cIiQyXCIgdGFyZ2V0PVwiX2JsYW5rXCIgcmVsPVwibm9vcGVuZXJcIj4kMTwvYT4nKVxuICAgICAgLnJlcGxhY2UoLyhefFtcXHMoXSkoaHR0cHM/OlxcL1xcL1teXFxzPCldKykvZywgJyQxPGEgaHJlZj1cIiQyXCIgdGFyZ2V0PVwiX2JsYW5rXCIgcmVsPVwibm9vcGVuZXJcIj4kMjwvYT4nKTtcbiAgICBsZXQgaHRtbCA9IFwiXCI7XG4gICAgbGV0IGxpc3Q6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgIGZvciAoY29uc3QgcmF3IG9mIGJsb2NrLnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgICBjb25zdCBpdGVtID0gcmF3Lm1hdGNoKC9eXFxzKig/OlstKlx1MjAyMl18KFxcZCspWy4pXSlcXHMrKC4qKSQvKTtcbiAgICAgIGlmIChpdGVtKSB7XG4gICAgICAgIGNvbnN0IGtpbmQgPSBpdGVtWzFdID8gXCJvbFwiIDogXCJ1bFwiO1xuICAgICAgICBpZiAobGlzdCAhPT0ga2luZCkgeyBpZiAobGlzdCkgaHRtbCArPSBgPC8ke2xpc3R9PmA7IGh0bWwgKz0gYDwke2tpbmR9PmA7IGxpc3QgPSBraW5kOyB9XG4gICAgICAgIGh0bWwgKz0gYDxsaT4ke2lubGluZShpdGVtWzJdKX08L2xpPmA7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgaWYgKGxpc3QpIHsgaHRtbCArPSBgPC8ke2xpc3R9PmA7IGxpc3QgPSBudWxsOyB9XG4gICAgICBjb25zdCBoZWFkaW5nID0gcmF3Lm1hdGNoKC9eI3sxLDZ9XFxzKyguKikkLyk7XG4gICAgICBodG1sICs9IGhlYWRpbmcgPyBgPGRpdiBjbGFzcz1cIm1kLWhcIj4ke2lubGluZShoZWFkaW5nWzFdKX08L2Rpdj5gIDogcmF3LnRyaW0oKSA9PT0gXCJcIiA/IFwiPGJyPlwiIDogYCR7aW5saW5lKHJhdyl9PGJyPmA7XG4gICAgfVxuICAgIGlmIChsaXN0KSBodG1sICs9IGA8LyR7bGlzdH0+YDtcbiAgICByZXR1cm4gaHRtbC5yZXBsYWNlKC8oPGJyPikrJC8sIFwiXCIpO1xuICB9KS5qb2luKFwiXCIpO1xufVxuXG5jb25zdCB0cmFuc2NyaXB0U2Nyb2xsID0gbmV3IEF1dG9TY3JvbGxlcigkKFwidHJhbnNjcmlwdFwiKSwge1xuICBvbkp1bXBDaGFuZ2U6IChzaG93KSA9PiB7ICQoXCJqdW1wYm90dG9tXCIpLmhpZGRlbiA9ICFzaG93OyB9LFxuICBpc0VtcHR5OiAoKSA9PiAhJChcImVtcHR5XCIpLmhpZGRlbixcbn0pO1xuXG5mdW5jdGlvbiBzY3JvbGxEb3duKGZvcmNlID0gZmFsc2UpIHtcbiAgdHJhbnNjcmlwdFNjcm9sbC5vbkNvbnRlbnQoZm9yY2UpO1xufVxuXG4vKiogVGhlIGNvcmUncyBudW1iZXIgZm9yIHRoZSBsaW5lIHRoZSBsYXN0IHJvdyBzaG93cywgdW50aWwgYW5vdGhlciByb3cgZm9sbG93cyBpdC4gKi9cbmxldCBvcGVuTGluZTogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5cbi8qKiBXb3JkcyBnbyBvbiB0aGUgcm93IHRoZSBjb3JlIHNheXMgdGhleSBiZWxvbmcgdG86IGl0IHN0YXJ0cyBhIG5ldyBsaW5lIGZvciBlYWNoIHR1cm4sIGhvd2V2ZXIgbG9uZyB0aGUgZ2FwLiAqL1xuZnVuY3Rpb24gdHJhbnNjcmlwdChyb2xlOiBcInVzZXJcIiB8IFwiYXNzaXN0YW50XCIsIHRleHQ6IHN0cmluZywgbGluZTogbnVtYmVyKSB7XG4gICQoXCJlbXB0eVwiKS5oaWRkZW4gPSB0cnVlO1xuICBjb25zdCBwYW5lID0gJChcInRyYW5zY3JpcHRcIik7XG4gIGNvbnN0IGxhc3QgPSBwYW5lLmxhc3RFbGVtZW50Q2hpbGQgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAob3BlbkxpbmUgPT09IGxpbmUgJiYgbGFzdCAmJiBsYXN0LmRhdGFzZXQucm9sZSA9PT0gcm9sZSkgbGFzdC5xdWVyeVNlbGVjdG9yKFwiLnRleHRcIikhLnRleHRDb250ZW50ICs9IHRleHQ7XG4gIGVsc2Uge1xuICAgIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgcm93LmNsYXNzTmFtZSA9IGBsaW5lICR7cm9sZX1gO1xuICAgIHJvdy5kYXRhc2V0LnJvbGUgPSByb2xlO1xuICAgIHJvdy5pbm5lckhUTUwgPSBgPHNwYW4gY2xhc3M9XCJ3aG9cIj4ke3JvbGUgPT09IFwidXNlclwiID8gXCJZb3VcIiA6IFwiR2VtaW5pXCJ9PC9zcGFuPjxzcGFuIGNsYXNzPVwidGV4dFwiPjwvc3Bhbj5gO1xuICAgIHJvdy5xdWVyeVNlbGVjdG9yKFwiLnRleHRcIikhLnRleHRDb250ZW50ID0gdGV4dC50cmltU3RhcnQoKTtcbiAgICBwYW5lLmFwcGVuZChyb3cpO1xuICAgIG9wZW5MaW5lID0gbGluZTtcbiAgfVxuICBzY3JvbGxEb3duKCk7XG59XG5cbi8qKlxuICogVGhlIHdvcmRzIHRoZSB1c2VyIGlzIHNheWluZywgYmVmb3JlIHRoZSBtb2RlbCBoYXMgdHJhbnNjcmliZWQgdGhlbTogYSBmYWludCByb3cgdGhhdCBzdGF5cyBsYXN0XG4gKiBvbiBzY3JlZW4gKGl0cyBDU1MgYG9yZGVyYCkgYW5kIGZpcnN0IGluIHRoZSBwYW5lLCBzbyB0aGUgbGluZXMgYWZ0ZXIgaXQgam9pbiB1cCBhcyBiZWZvcmUuXG4gKi9cbmZ1bmN0aW9uIGNhcHRpb24odGV4dDogc3RyaW5nIHwgbnVsbCkge1xuICBjb25zdCBwYW5lID0gJChcInRyYW5zY3JpcHRcIik7XG4gIGxldCByb3cgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImNhcHRpb25cIik7XG4gIGlmICh0ZXh0ID09IG51bGwpIHsgcm93Py5yZW1vdmUoKTsgc2Nyb2xsRG93bigpOyByZXR1cm47IH1cbiAgJChcImVtcHR5XCIpLmhpZGRlbiA9IHRydWU7XG4gIGlmICghcm93KSB7XG4gICAgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICByb3cuaWQgPSBcImNhcHRpb25cIjtcbiAgICByb3cuY2xhc3NOYW1lID0gXCJsaW5lIHVzZXIgY2FwdGlvblwiO1xuICAgIHJvdy5pbm5lckhUTUwgPSBgPHNwYW4gY2xhc3M9XCJ3aG9cIj5Zb3U8L3NwYW4+PHNwYW4gY2xhc3M9XCJ0ZXh0XCI+PC9zcGFuPmA7XG4gICAgcGFuZS5wcmVwZW5kKHJvdyk7XG4gIH1cbiAgcm93LnF1ZXJ5U2VsZWN0b3IoXCIudGV4dFwiKSEudGV4dENvbnRlbnQgPSB0ZXh0O1xuICBzY3JvbGxEb3duKCk7XG59XG5cbmZ1bmN0aW9uIG5vdGUodGV4dDogc3RyaW5nKSB7XG4gICQoXCJlbXB0eVwiKS5oaWRkZW4gPSB0cnVlO1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gXCJsaW5lIG5vdGVcIjtcbiAgcm93LnRleHRDb250ZW50ID0gdGV4dDtcbiAgJChcInRyYW5zY3JpcHRcIikuYXBwZW5kKHJvdyk7XG4gIG9wZW5MaW5lID0gbnVsbDtcbiAgc2Nyb2xsRG93bigpO1xufVxuXG4vLyBBZ2VudCBoYW5kb2ZmIHJlc3VsdHM6IGNvbXBhY3QgMS1saW5lIHJlZmVyZW5jZSBpbiB0aGUgdm9pY2Ugc3RyZWFtICsgZnVsbCBjb2xsYXBzaWJsZSBjYXJkIGluIHRoZSByaWdodCBwYW5lLlxuXG5mdW5jdGlvbiByZXN1bHRDbGFtcFB4KGVsOiBIVE1MRWxlbWVudCk6IG51bWJlciB7XG4gIGNvbnN0IHJhdyA9IGdldENvbXB1dGVkU3R5bGUoZWwpLmdldFByb3BlcnR5VmFsdWUoXCItLXJlcy1jbGFtcC1tYXhcIikudHJpbSgpO1xuICBjb25zdCBuID0gTnVtYmVyLnBhcnNlRmxvYXQocmF3KTtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShuKSAmJiBuID4gMCA/IG4gOiA2NDtcbn1cblxuZnVuY3Rpb24gc3luY0V4cGFuZEFsbEJ1dHRvbigpIHtcbiAgY29uc3QgY2xhbXBlZCA9IFsuLi5yZXN1bHRzLnZhbHVlcygpXS5maWx0ZXIoKHIpID0+IHIuY2FyZC5jbGFzc0xpc3QuY29udGFpbnMoXCJjbGFtcGVkXCIpKTtcbiAgY29uc3QgYnRuID0gJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJ0b2dnbGUtYWxsLXJlc3VsdHNcIik7XG4gIGJ0bi5oaWRkZW4gPSBjbGFtcGVkLmxlbmd0aCA9PT0gMDtcbiAgaWYgKGNsYW1wZWQubGVuZ3RoID09PSAwKSByZXR1cm47XG4gIGNvbnN0IGFueUNvbGxhcHNlZCA9IGNsYW1wZWQuc29tZSgocikgPT4gIXIuY2FyZC5jbGFzc0xpc3QuY29udGFpbnMoXCJvcGVuXCIpKTtcbiAgYnRuLnRleHRDb250ZW50ID0gYW55Q29sbGFwc2VkID8gXCJFeHBhbmQgYWxsXCIgOiBcIkNvbGxhcHNlIGFsbFwiO1xufVxuXG5mdW5jdGlvbiBzZXRSZXN1bHRPcGVuKGVudHJ5OiBSZXN1bHRFbnRyeSwgb3BlbjogYm9vbGVhbikge1xuICBjb25zdCBjbGFtcGVkID0gZW50cnkuY2FyZC5jbGFzc0xpc3QuY29udGFpbnMoXCJjbGFtcGVkXCIpO1xuICBjb25zdCBuZXh0ID0gY2xhbXBlZCAmJiBvcGVuO1xuICBlbnRyeS5jYXJkLmNsYXNzTGlzdC50b2dnbGUoXCJvcGVuXCIsIG5leHQpO1xuICBlbnRyeS5oZWFkLnNldEF0dHJpYnV0ZShcImFyaWEtZXhwYW5kZWRcIiwgU3RyaW5nKCFjbGFtcGVkIHx8IG5leHQpKTtcbiAgZW50cnkubW9yZUJ0bi50ZXh0Q29udGVudCA9IG5leHQgPyBcIlNob3cgbGVzc1wiIDogXCJTaG93IG1vcmVcIjtcbiAgc3luY0V4cGFuZEFsbEJ1dHRvbigpO1xufVxuXG5mdW5jdGlvbiB1cGRhdGVSZXN1bHRDbGFtcGluZyhlbnRyeTogUmVzdWx0RW50cnkpIHtcbiAgaWYgKGVudHJ5LmJvZHkub2Zmc2V0UGFyZW50ID09PSBudWxsKSByZXR1cm47XG4gIC8vIFVuY2xhbXBlZCBjYXJkcyBoYXZlIG5vIG1heC1oZWlnaHQsIHNvIHNjcm9sbEhlaWdodCBpcyBhbHdheXMgdGhlIGZ1bGwgbmF0dXJhbCBoZWlnaHQuXG4gIGNvbnN0IG92ZXJmbG93cyA9IGVudHJ5LmJvZHkuc2Nyb2xsSGVpZ2h0ID4gcmVzdWx0Q2xhbXBQeChlbnRyeS5jYXJkKSArIDQ7XG4gIGVudHJ5LmNhcmQuY2xhc3NMaXN0LnRvZ2dsZShcImNsYW1wZWRcIiwgb3ZlcmZsb3dzKTtcbiAgaWYgKCFvdmVyZmxvd3MpIGVudHJ5LmNhcmQuY2xhc3NMaXN0LnJlbW92ZShcIm9wZW5cIik7XG4gIGVudHJ5Lm1vcmVCdG4uaGlkZGVuID0gIW92ZXJmbG93cztcbiAgY29uc3QgaXNPcGVuID0gZW50cnkuY2FyZC5jbGFzc0xpc3QuY29udGFpbnMoXCJvcGVuXCIpO1xuICBlbnRyeS5tb3JlQnRuLnRleHRDb250ZW50ID0gaXNPcGVuID8gXCJTaG93IGxlc3NcIiA6IFwiU2hvdyBtb3JlXCI7XG4gIGVudHJ5LmhlYWQuc2V0QXR0cmlidXRlKFwiYXJpYS1leHBhbmRlZFwiLCBTdHJpbmcoIW92ZXJmbG93cyB8fCBpc09wZW4pKTtcbn1cblxuZnVuY3Rpb24gdXBkYXRlQWxsUmVzdWx0Q2xhbXBpbmcoKSB7XG4gIGZvciAoY29uc3QgZW50cnkgb2YgcmVzdWx0cy52YWx1ZXMoKSkgdXBkYXRlUmVzdWx0Q2xhbXBpbmcoZW50cnkpO1xuICBzeW5jRXhwYW5kQWxsQnV0dG9uKCk7XG59XG5cbmZ1bmN0aW9uIHN5bmNSZXN1bHRGb2xsb3dVcEJ1dHRvbnMoKSB7XG4gIGZvciAoY29uc3QgZW50cnkgb2YgcmVzdWx0cy52YWx1ZXMoKSkge1xuICAgIGlmICghZW50cnkuZm9sbG93QnRuKSBjb250aW51ZTtcbiAgICBjb25zdCBjYW5Gb2xsb3cgPSBjYW5Gb2xsb3dVcFJlc3VsdChlbnRyeS5zZXNzaW9uSWQsIGFjdGl2ZVNlc3Npb24sIEJvb2xlYW4oZW50cnkudGFza0lkICYmIHRhc2tzLmhhcyhlbnRyeS50YXNrSWQpKSk7XG4gICAgZW50cnkuZm9sbG93QnRuLmhpZGRlbiA9ICFjYW5Gb2xsb3c7XG4gICAgaWYgKCFjYW5Gb2xsb3cpIGVudHJ5LmNhcmQucXVlcnlTZWxlY3RvcihcImZvcm1cIik/LnJlbW92ZSgpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGNsZWFyVW5yZWFkSWZSZXN1bHRzVmlzaWJsZSgpIHtcbiAgaWYgKHVucmVhZE1vYmlsZVJlc3VsdHMgPT09IDApIHJldHVybjtcbiAgY29uc3QgZHJhd2VyT3BlbiA9IGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LmNvbnRhaW5zKFwidGFza3Mtb3BlblwiKTtcbiAgaWYgKHNob3VsZENsZWFyVW5yZWFkUmVzdWx0cyhtb2JpbGVMYXlvdXQubWF0Y2hlcywgZHJhd2VyT3Blbiwgc2lkZUZpbHRlcikpIHtcbiAgICB1bnJlYWRNb2JpbGVSZXN1bHRzID0gMDtcbiAgICB1cGRhdGVUYXNrQ2hyb21lKCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gZm9jdXNSZXN1bHQoaWQ6IHN0cmluZykge1xuICBjb25zdCBlbnRyeSA9IHJlc3VsdHMuZ2V0KGlkKTtcbiAgaWYgKCFlbnRyeSkgcmV0dXJuO1xuICBpZiAoc2lkZUZpbHRlciA9PT0gXCJhY3RpdmVcIikgc2V0U2lkZUZpbHRlcihcImFsbFwiKTtcbiAgaWYgKG1vYmlsZUxheW91dC5tYXRjaGVzKSBzZXRUYXNrc09wZW4odHJ1ZSk7XG4gIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB7XG4gICAgdXBkYXRlUmVzdWx0Q2xhbXBpbmcoZW50cnkpO1xuICAgIGlmIChlbnRyeS5jYXJkLmNsYXNzTGlzdC5jb250YWlucyhcImNsYW1wZWRcIikpIHNldFJlc3VsdE9wZW4oZW50cnksIHRydWUpO1xuICAgIGZvciAoY29uc3QgciBvZiByZXN1bHRzLnZhbHVlcygpKSByLmNhcmQuY2xhc3NMaXN0LnJlbW92ZShcImZsYXNoXCIpO1xuICAgIHZvaWQgZW50cnkuY2FyZC5vZmZzZXRXaWR0aDtcbiAgICBlbnRyeS5jYXJkLmNsYXNzTGlzdC5hZGQoXCJmbGFzaFwiKTtcbiAgICBjbGVhclRpbWVvdXQoZmxhc2hUaW1lcik7XG4gICAgZmxhc2hUaW1lciA9IHdpbmRvdy5zZXRUaW1lb3V0KCgpID0+IGVudHJ5LmNhcmQuY2xhc3NMaXN0LnJlbW92ZShcImZsYXNoXCIpLCAxNDAwKTtcbiAgICBlbnRyeS5jYXJkLnNjcm9sbEludG9WaWV3KHsgYmVoYXZpb3I6IFwic21vb3RoXCIsIGJsb2NrOiBcIm5lYXJlc3RcIiB9KTtcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHJlc3VsdChhZ2VudDogc3RyaW5nLCBsYWJlbDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcsIGZhaWxlZCA9IGZhbHNlLCB0YXNrSWQ/OiBzdHJpbmcsIHNlc3Npb25JZCA9IGFjdGl2ZVNlc3Npb24pOiBzdHJpbmcge1xuICAkKFwiZW1wdHlcIikuaGlkZGVuID0gdHJ1ZTtcbiAgY29uc3QgaWQgPSBgcmVzLSR7KytuZXh0UmVzdWx0U2VxfWA7XG4gIGNvbnN0IHdobyA9IGFnZW50ID09PSBcInQzXCIgPyBcIlQzXCIgOiBcIkhlcm1lc1wiO1xuICBjb25zdCBhZ2VudENscyA9IGFnZW50ID09PSBcInQzXCIgPyBcInQzXCIgOiBcIlwiO1xuICBjb25zdCBzbmlwcGV0ID0gcGxhaW5QcmV2aWV3KHRleHQsIDE2MCkgfHwgXCIoZW1wdHkgcmVzcG9uc2UpXCI7XG5cbiAgLy8gMS4gQ29tcGFjdCBpbmxpbmUgaGFuZG9mZiBtYXJrZXIgaW4gdGhlIHZvaWNlIHRyYW5zY3JpcHQgc28gY2hyb25vbG9naWNhbCBjb250ZXh0IHN0YXlzIGludGFjdFxuICAvLyB3aXRob3V0IG11bHRpLXBhcmFncmFwaCByZXNwb25zZXMgcHVzaGluZyB2b2ljZSB0dXJucyBvZmYgc2NyZWVuLlxuICBjb25zdCByZWZSb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICByZWZSb3cudHlwZSA9IFwiYnV0dG9uXCI7XG4gIHJlZlJvdy5jbGFzc05hbWUgPSBgbGluZSBoYW5kb2ZmICR7YWdlbnRDbHN9ICR7ZmFpbGVkID8gXCJmYWlsZWRcIiA6IFwiXCJ9YC50cmltKCk7XG4gIHJlZlJvdy5kYXRhc2V0LnJlc3VsdElkID0gaWQ7XG4gIHJlZlJvdy5pbm5lckhUTUwgPVxuICAgIGA8c3BhbiBjbGFzcz1cImJhZGdlICR7YWdlbnRDbHN9XCI+JHt3aG99PC9zcGFuPmAgK1xuICAgIGA8c3BhbiBjbGFzcz1cImhhbmRvZmYtbGFiZWxcIj4ke2VzY2FwZUh0bWwobGFiZWwpfTwvc3Bhbj5gICtcbiAgICBgPHNwYW4gY2xhc3M9XCJoYW5kb2ZmLXNuaXBwZXRcIj4ke2VzY2FwZUh0bWwoc25pcHBldCl9PC9zcGFuPmAgK1xuICAgIGA8c3BhbiBjbGFzcz1cImhhbmRvZmYtY3VlXCI+JHtmYWlsZWQgPyBcIkZhaWxlZFwiIDogXCJPcGVuIFx1MjE5N1wifTwvc3Bhbj5gO1xuICByZWZSb3cub25jbGljayA9ICgpID0+IGZvY3VzUmVzdWx0KGlkKTtcbiAgJChcInRyYW5zY3JpcHRcIikuYXBwZW5kKHJlZlJvdyk7XG4gIG9wZW5MaW5lID0gbnVsbDtcbiAgc2Nyb2xsRG93bigpO1xuXG4gIC8vIDIuIFRydW5jYXRlZCwgZXhwYW5kYWJsZSByZXN1bHQgY2FyZCBpbiB0aGUgcmlnaHQtaGFuZCBBZ2VudCBXb3Jrc3BhY2UgKG5ld2VzdCBmaXJzdCkuXG4gIGNvbnN0IGNhcmQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYXJ0aWNsZVwiKTtcbiAgY2FyZC5jbGFzc05hbWUgPSBgcmVzLWNhcmQgJHthZ2VudENsc30gJHtmYWlsZWQgPyBcImZhaWxlZFwiIDogXCJcIn1gLnRyaW0oKTtcbiAgY2FyZC5kYXRhc2V0LnJlc3VsdElkID0gaWQ7XG5cbiAgY29uc3QgaGVhZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIGhlYWQudHlwZSA9IFwiYnV0dG9uXCI7XG4gIGhlYWQuY2xhc3NOYW1lID0gXCJyZXMtaGVhZFwiO1xuICBoZWFkLnNldEF0dHJpYnV0ZShcImFyaWEtZXhwYW5kZWRcIiwgXCJ0cnVlXCIpO1xuICBoZWFkLmlubmVySFRNTCA9XG4gICAgYDxzcGFuIGNsYXNzPVwiYmFkZ2UgJHthZ2VudENsc31cIj4ke3dob308L3NwYW4+YCArXG4gICAgYDxzcGFuIGNsYXNzPVwicmVzLWxhYmVsXCIgdGl0bGU9XCIke2VzY2FwZUh0bWwobGFiZWwpfVwiPiR7ZXNjYXBlSHRtbChsYWJlbCl9PC9zcGFuPmAgK1xuICAgIChmYWlsZWQgPyBgPHNwYW4gY2xhc3M9XCJyZXMtcGlsbFwiPkZhaWxlZDwvc3Bhbj5gIDogXCJcIikgK1xuICAgIGA8c3BhbiBjbGFzcz1cInJlcy10aW1lXCI+JHtmb3JtYXRTaG9ydFRpbWUobmV3IERhdGUoKSl9PC9zcGFuPmAgK1xuICAgIGA8c3BhbiBjbGFzcz1cInJlcy1jaGV2XCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+PC9zcGFuPmA7XG5cbiAgY29uc3QgYm9keSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGJvZHkuY2xhc3NOYW1lID0gXCJyZXMtYm9keVwiO1xuICBib2R5LmlubmVySFRNTCA9IG1hcmtkb3duKHRleHQpO1xuXG4gIGNvbnN0IGZvb3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBmb290LmNsYXNzTmFtZSA9IFwicmVzLWZvb3RcIjtcblxuICBjb25zdCBtb3JlQnRuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgbW9yZUJ0bi50eXBlID0gXCJidXR0b25cIjtcbiAgbW9yZUJ0bi5jbGFzc05hbWUgPSBcInJlcy1hY3QgcHJpbWFyeVwiO1xuICBtb3JlQnRuLnRleHRDb250ZW50ID0gXCJTaG93IG1vcmVcIjtcbiAgbW9yZUJ0bi5oaWRkZW4gPSB0cnVlO1xuXG4gIGNvbnN0IGNvcHlCdG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBjb3B5QnRuLnR5cGUgPSBcImJ1dHRvblwiO1xuICBjb3B5QnRuLmNsYXNzTmFtZSA9IFwicmVzLWFjdFwiO1xuICBjb3B5QnRuLnRleHRDb250ZW50ID0gXCJDb3B5XCI7XG4gIGNvcHlCdG4ub25jbGljayA9ICgpID0+IHtcbiAgICB2b2lkIG5hdmlnYXRvci5jbGlwYm9hcmQ/LndyaXRlVGV4dCh0ZXh0KTtcbiAgICB0b2FzdChcIlJlc3VsdCBjb3BpZWRcIik7XG4gIH07XG5cbiAgZm9vdC5hcHBlbmQobW9yZUJ0biwgY29weUJ0bik7XG5cbiAgbGV0IGZvbGxvd0J0bjogSFRNTEJ1dHRvbkVsZW1lbnQgfCB1bmRlZmluZWQ7XG4gIGlmICh0YXNrSWQpIHtcbiAgICBmb2xsb3dCdG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICAgIGZvbGxvd0J0bi50eXBlID0gXCJidXR0b25cIjtcbiAgICBmb2xsb3dCdG4uY2xhc3NOYW1lID0gXCJyZXMtYWN0XCI7XG4gICAgZm9sbG93QnRuLnRleHRDb250ZW50ID0gXCJGb2xsb3cgdXBcIjtcbiAgICBmb2xsb3dCdG4ub25jbGljayA9ICgpID0+IHtcbiAgICAgIGlmICghY2FuRm9sbG93VXBSZXN1bHQoc2Vzc2lvbklkLCBhY3RpdmVTZXNzaW9uLCB0YXNrcy5oYXModGFza0lkKSkpIHtcbiAgICAgICAgc3luY1Jlc3VsdEZvbGxvd1VwQnV0dG9ucygpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjb25zdCB2aWV3ID0gdGFza3MuZ2V0KHRhc2tJZCk7XG4gICAgICBpZiAodmlldykgZm9sbG93VXBGb3JtKGNhcmQsIHZpZXcuYywgc2Vzc2lvbklkKTtcbiAgICB9O1xuICAgIGZvb3QuYXBwZW5kKGZvbGxvd0J0bik7XG4gIH1cblxuICBjYXJkLmFwcGVuZChoZWFkLCBib2R5LCBmb290KTtcblxuICBjb25zdCBlbnRyeTogUmVzdWx0RW50cnkgPSB7IGlkLCBhZ2VudCwgbGFiZWwsIHRleHQsIGZhaWxlZCwgdGFza0lkLCBzZXNzaW9uSWQsIGNhcmQsIGhlYWQsIGJvZHksIG1vcmVCdG4sIGZvbGxvd0J0biwgcmVmUm93IH07XG4gIGNvbnN0IHRvZ2dsZSA9ICgpID0+IHtcbiAgICBpZiAoIWVudHJ5LmNhcmQuY2xhc3NMaXN0LmNvbnRhaW5zKFwiY2xhbXBlZFwiKSkgcmV0dXJuO1xuICAgIHNldFJlc3VsdE9wZW4oZW50cnksICFlbnRyeS5jYXJkLmNsYXNzTGlzdC5jb250YWlucyhcIm9wZW5cIikpO1xuICB9O1xuICBoZWFkLm9uY2xpY2sgPSB0b2dnbGU7XG4gIG1vcmVCdG4ub25jbGljayA9IHRvZ2dsZTtcblxuICByZXN1bHRzLnNldChpZCwgZW50cnkpO1xuICAkKFwicmVzdWx0c1wiKS5wcmVwZW5kKGNhcmQpO1xuICBjb25zdCBkcmF3ZXJPcGVuID0gZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QuY29udGFpbnMoXCJ0YXNrcy1vcGVuXCIpO1xuICBpZiAoIXNob3VsZENsZWFyVW5yZWFkUmVzdWx0cyhtb2JpbGVMYXlvdXQubWF0Y2hlcywgZHJhd2VyT3Blbiwgc2lkZUZpbHRlcikpIHVucmVhZE1vYmlsZVJlc3VsdHMrKztcblxuICBzeW5jU2lkZUxheW91dCgpO1xuICB1cGRhdGVUYXNrQ2hyb21lKCk7XG4gIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB7XG4gICAgdXBkYXRlUmVzdWx0Q2xhbXBpbmcoZW50cnkpO1xuICAgIHN5bmNFeHBhbmRBbGxCdXR0b24oKTtcbiAgfSk7XG4gIHJldHVybiBpZDtcbn1cblxuZnVuY3Rpb24gZWxhcHNlZChzZWNvbmRzOiBudW1iZXIpOiBzdHJpbmcge1xuICBpZiAoc2Vjb25kcyA8IDYwKSByZXR1cm4gYCR7TWF0aC5mbG9vcihzZWNvbmRzKX1zYDtcbiAgY29uc3QgbSA9IE1hdGguZmxvb3Ioc2Vjb25kcyAvIDYwKTtcbiAgcmV0dXJuIG0gPCA2MCA/IGAke219bSAke01hdGguZmxvb3Ioc2Vjb25kcyAlIDYwKX1zYCA6IGAke01hdGguZmxvb3IobSAvIDYwKX1oICR7bSAlIDYwfW1gO1xufVxuXG4vKiogVGhlIGVtcHR5IHRhc2sgbGlzdCdzIHdvcmRzLCBrZXB0IHRvIHB1dCBiYWNrLiAqL1xuY29uc3Qgbm9UYXNrcyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwibm90YXNrc1wiKSE7XG5cbi8qKiBXaGV0aGVyIGEgdGFzayBzdGlsbCB3YW50cyB0aGUgc2NyZWVuOiBpdCdzIHdvcmtpbmcsIHdhaXRpbmcsIG9yIG5lZWRzIGFwcHJvdmFsLiBUaGUgcmVzdCBmb2xkIGF3YXkgdW5kZXIgRmluaXNoZWQuICovXG5jb25zdCBsaXZlID0gKHN0YXRlOiBzdHJpbmcpID0+IHN0YXRlID09PSBcInJ1bm5pbmdcIiB8fCBzdGF0ZS5zdGFydHNXaXRoKFwid2FpdGluZ1wiKTtcbmNvbnN0IGlzQWN0aXZlVGFzayA9ICh2aWV3OiBUYXNrVmlldykgPT4gbGl2ZSh2aWV3LmMuc3RhdGUpIHx8IEJvb2xlYW4odmlldy5hcHByb3ZhbCk7XG5cbmZ1bmN0aW9uIHNldFNpZGVGaWx0ZXIoZmlsdGVyOiBTaWRlRmlsdGVyKSB7XG4gIHNpZGVGaWx0ZXIgPSBub3JtYWxpemVTaWRlRmlsdGVyKGZpbHRlcik7XG4gIGZvciAoY29uc3QgYnRuIG9mIEFycmF5LmZyb20oZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MQnV0dG9uRWxlbWVudD4oXCIjc2lkZS10YWJzIGJ1dHRvblwiKSkpIHtcbiAgICBjb25zdCBvbiA9IGJ0bi5kYXRhc2V0LmZpbHRlciA9PT0gc2lkZUZpbHRlcjtcbiAgICBidG4uY2xhc3NMaXN0LnRvZ2dsZShcIm9uXCIsIG9uKTtcbiAgICBidG4uc2V0QXR0cmlidXRlKFwiYXJpYS1wcmVzc2VkXCIsIFN0cmluZyhvbikpO1xuICB9XG4gIHN5bmNTaWRlTGF5b3V0KCk7XG4gIGNsZWFyVW5yZWFkSWZSZXN1bHRzVmlzaWJsZSgpO1xuICByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKCkgPT4gdXBkYXRlQWxsUmVzdWx0Q2xhbXBpbmcoKSk7XG59XG5cbmZ1bmN0aW9uIHN5bmNTaWRlTGF5b3V0KCkge1xuICBjb25zdCBhbGwgPSBbLi4udGFza3MudmFsdWVzKCldO1xuICBjb25zdCBhY3RpdmVDdXJyZW50ID0gYWxsLmZpbHRlcihpc0FjdGl2ZVRhc2spLmxlbmd0aDtcbiAgY29uc3QgYWN0aXZlVG90YWwgPSBhY3RpdmVDdXJyZW50ICsgZWFybGllckFjdGl2ZUNvdW50O1xuICBjb25zdCByZXN1bHRzVG90YWwgPSByZXN1bHRzLnNpemU7XG4gIGNvbnN0IGVhcmxpZXJTaG93biA9ICQoXCJlYXJsaWVyXCIpLmNoaWxkRWxlbWVudENvdW50O1xuICBjb25zdCBkb25lVG90YWwgPSAkKFwiZG9uZW5vd1wiKS5jaGlsZEVsZW1lbnRDb3VudCArICQoXCJkb25lZWFybGllclwiKS5jaGlsZEVsZW1lbnRDb3VudDtcblxuICBjb25zdCB2aXMgPSByZXNvbHZlU2lkZVNlY3Rpb25zKHNpZGVGaWx0ZXIsIHtcbiAgICBhY3RpdmU6IGFjdGl2ZUN1cnJlbnQsXG4gICAgcmVzdWx0czogcmVzdWx0c1RvdGFsLFxuICAgIGVhcmxpZXI6IGVhcmxpZXJTaG93bixcbiAgICBkb25lOiBkb25lVG90YWwsXG4gIH0pO1xuXG4gICQoXCJ0YXNrcy1zZWN0aW9uXCIpLmhpZGRlbiA9ICF2aXMuc2hvd1Rhc2tzU2VjdGlvbjtcbiAgbm9UYXNrcy5oaWRkZW4gPSAhdmlzLnNob3dFbXB0eVRhc2tzO1xuICAkKFwicmVzdWx0cy1zZWN0aW9uXCIpLmhpZGRlbiA9ICF2aXMuc2hvd1Jlc3VsdHNTZWN0aW9uO1xuICAkKFwibm9yZXN1bHRzXCIpLmhpZGRlbiA9ICF2aXMuc2hvd0VtcHR5UmVzdWx0cztcbiAgJChcImVhcmxpZXJib3hcIikuaGlkZGVuID0gIXZpcy5zaG93RWFybGllclNlY3Rpb247XG4gICQoXCJkb25lYm94XCIpLmhpZGRlbiA9ICF2aXMuc2hvd0RvbmVTZWN0aW9uO1xuXG4gICQoXCJzaWRlLWFjdGl2ZS1uXCIpLnRleHRDb250ZW50ID0gYWN0aXZlVG90YWwgPiAwID8gU3RyaW5nKGFjdGl2ZVRvdGFsKSA6IFwiXCI7XG4gICQoXCJzaWRlLXJlc3VsdHMtblwiKS50ZXh0Q29udGVudCA9IHJlc3VsdHNUb3RhbCA+IDAgPyBTdHJpbmcocmVzdWx0c1RvdGFsKSA6IFwiXCI7XG4gICQoXCJyZXN1bHRzY291bnRcIikudGV4dENvbnRlbnQgPSByZXN1bHRzVG90YWwgPiAwID8gYFx1MDBCNyAke3Jlc3VsdHNUb3RhbH1gIDogXCJcIjtcbiAgJChcImRvbmVjb3VudFwiKS50ZXh0Q29udGVudCA9IGRvbmVUb3RhbCA+IDAgPyBgXHUwMEI3ICR7ZG9uZVRvdGFsfWAgOiBcIlwiO1xuICBzeW5jUmVzdWx0Rm9sbG93VXBCdXR0b25zKCk7XG59XG5cbmZ1bmN0aW9uIHVwZGF0ZVRhc2tDaHJvbWUoKSB7XG4gIGNvbnN0IGFsbCA9IFsuLi50YXNrcy52YWx1ZXMoKV07XG4gIGNvbnN0IGFjdGl2ZUN1cnJlbnQgPSBhbGwuZmlsdGVyKGlzQWN0aXZlVGFzaykubGVuZ3RoO1xuICBjb25zdCB3YWl0aW5nID0gYWxsLmZpbHRlcigodCkgPT4gdC5jLnN0YXRlLnN0YXJ0c1dpdGgoXCJ3YWl0aW5nXCIpIHx8IEJvb2xlYW4odC5hcHByb3ZhbCkpLmxlbmd0aDtcbiAgY29uc3QgYWN0aXZlVG90YWwgPSBhY3RpdmVDdXJyZW50ICsgZWFybGllckFjdGl2ZUNvdW50O1xuICBjb25zdCBhdHRlbnRpb25Ub3RhbCA9IHdhaXRpbmcgKyBlYXJsaWVyV2FpdGluZ0NvdW50O1xuICBjb25zdCBiYWRnZUNvdW50ID0gYWN0aXZlVG90YWwgPiAwID8gYWN0aXZlVG90YWwgOiB1bnJlYWRNb2JpbGVSZXN1bHRzO1xuXG4gIGNvbnN0IGJhZGdlID0gJChcInRhc2tzLWJhZGdlXCIpO1xuICBiYWRnZS5oaWRkZW4gPSBiYWRnZUNvdW50ID09PSAwO1xuICBiYWRnZS50ZXh0Q29udGVudCA9IFN0cmluZyhiYWRnZUNvdW50KTtcbiAgYmFkZ2UuY2xhc3NMaXN0LnRvZ2dsZShcIndhcm5cIiwgYXR0ZW50aW9uVG90YWwgPiAwKTtcblxuICBjb25zdCBiYXIgPSAkKFwibW9iaWxlLXRhc2tzLWJhclwiKTtcbiAgY29uc3Qgc2hvd0JhciA9IGFjdGl2ZVRvdGFsID4gMCB8fCB1bnJlYWRNb2JpbGVSZXN1bHRzID4gMDtcbiAgYmFyLmhpZGRlbiA9ICFzaG93QmFyO1xuICBiYXIuY2xhc3NMaXN0LnRvZ2dsZShcInZpc2libGVcIiwgc2hvd0Jhcik7XG4gIGJhci5jbGFzc0xpc3QudG9nZ2xlKFwid2FyblwiLCBhdHRlbnRpb25Ub3RhbCA+IDApO1xuICBpZiAoc2hvd0Jhcikge1xuICAgIGNvbnN0IGFwcHJvdmFsID0gYWxsLmZpbmQoKHQpID0+IHQuYXBwcm92YWwpO1xuICAgIGNvbnN0IGxhYmVsID0gYXBwcm92YWxcbiAgICAgID8gYEFwcHJvdmFsIG5lZWRlZDogJHthcHByb3ZhbC5jLmxhYmVsfWBcbiAgICAgIDogYXR0ZW50aW9uVG90YWwgPiAwXG4gICAgICAgID8gYCR7YXR0ZW50aW9uVG90YWx9IHRhc2ske2F0dGVudGlvblRvdGFsID4gMSA/IFwic1wiIDogXCJcIn0gd2FpdGluZyBmb3IgeW91YFxuICAgICAgICA6IGFjdGl2ZVRvdGFsID4gMFxuICAgICAgICAgID8gYCR7YWN0aXZlVG90YWx9IGFjdGl2ZSB0YXNrJHthY3RpdmVUb3RhbCA+IDEgPyBcInNcIiA6IFwiXCJ9YFxuICAgICAgICAgIDogYCR7dW5yZWFkTW9iaWxlUmVzdWx0c30gbmV3IGFnZW50IHJlc3VsdCR7dW5yZWFkTW9iaWxlUmVzdWx0cyA+IDEgPyBcInNcIiA6IFwiXCJ9YDtcbiAgICAkKFwibXRiLXRleHRcIikudGV4dENvbnRlbnQgPSBsYWJlbDtcbiAgfVxufVxuXG5mdW5jdGlvbiBzaG93VGFza3MoZm9yY2UgPSBmYWxzZSkge1xuICBjb25zdCBwYW5lID0gJChcInRhc2tzXCIpO1xuICBjb25zdCBkb25lID0gJChcImRvbmVub3dcIik7XG4gIGNvbnN0IG9wZW4gPSBkb2N1bWVudC5hY3RpdmVFbGVtZW50Py5jbG9zZXN0Py4oXCIudGFza1wiKSBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gIGlmICghZm9yY2UgJiYgb3BlbiAmJiAocGFuZS5jb250YWlucyhvcGVuKSB8fCBkb25lLmNvbnRhaW5zKG9wZW4pKSAmJiBvcGVuLnF1ZXJ5U2VsZWN0b3IoXCJmb3JtXCIpKSByZXR1cm47IC8vIGRvbid0IHJlZHJhdyB1bmRlciBzb21lb25lIHR5cGluZyBhIGZvbGxvdy11cFxuICBwYW5lLmlubmVySFRNTCA9IFwiXCI7XG4gIGRvbmUuaW5uZXJIVE1MID0gXCJcIjtcbiAgY29uc3QgYWxsID0gWy4uLnRhc2tzLnZhbHVlcygpXS5yZXZlcnNlKCk7XG4gIGlmIChhbGwubGVuZ3RoID09PSAwKSB7XG4gICAgcGFuZS5hcHBlbmQobm9UYXNrcyk7XG4gICAgJChcInRhc2tjb3VudFwiKS50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgJChcImNhbmNlbGFsbFwiKS5oaWRkZW4gPSB0cnVlO1xuICAgIHN5bmNTaWRlTGF5b3V0KCk7XG4gICAgdXBkYXRlVGFza0Nocm9tZSgpO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBydW5uaW5nID0gYWxsLmZpbHRlcigodCkgPT4gdC5jLnN0YXRlID09PSBcInJ1bm5pbmdcIikubGVuZ3RoO1xuICBjb25zdCBhY3RpdmVDb3VudCA9IGFsbC5maWx0ZXIoaXNBY3RpdmVUYXNrKS5sZW5ndGg7XG4gICQoXCJ0YXNrY291bnRcIikudGV4dENvbnRlbnQgPSBydW5uaW5nID4gMCA/IGAke3J1bm5pbmd9IHJ1bm5pbmdgIDogYWN0aXZlQ291bnQgPiAwID8gYCR7YWN0aXZlQ291bnR9IHdhaXRpbmdgIDogXCJcIjtcbiAgJChcImNhbmNlbGFsbFwiKS5oaWRkZW4gPSAhY2FsbElkIHx8IHJ1bm5pbmcgPCAyO1xuICBmb3IgKGNvbnN0IHZpZXcgb2YgYWxsKSB7XG4gICAgY29uc3QgdCA9IHZpZXcuYztcbiAgICBjb25zdCB3YWl0aW5nID0gdC5zdGF0ZS5zdGFydHNXaXRoKFwid2FpdGluZ1wiKTtcbiAgICBjb25zdCBjYXJkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBjYXJkLmNsYXNzTmFtZSA9IGB0YXNrICR7d2FpdGluZyA/IFwid2FpdGluZ1wiIDogdC5zdGF0ZX1gO1xuICAgIGNvbnN0IGFnZSA9ICh2aWV3LmVuZGVkID8/IG5vdygpKSAtIHZpZXcuc2luY2U7XG4gICAgY2FyZC5pbm5lckhUTUwgPVxuICAgICAgYDxkaXYgY2xhc3M9XCJtZXRhLXJvd1wiPmAgK1xuICAgICAgICBgPHNwYW4gY2xhc3M9XCJiYWRnZSAke3QuYWdlbnQgPT09IFwidDNcIiA/IFwidDNcIiA6IFwiXCJ9XCI+JHt0LmFnZW50ID09PSBcInQzXCIgPyBcIlQzXCIgOiBcIkhlcm1lc1wifTwvc3Bhbj5gICtcbiAgICAgICAgYDxzcGFuIGNsYXNzPVwibGFiZWxcIj48L3NwYW4+YCArXG4gICAgICAgIGA8c3BhbiBjbGFzcz1cInN0YXRlXCI+JHt0LnN0YXRlID09PSBcInJ1bm5pbmdcIiA/ICc8c3BhbiBjbGFzcz1cInNwaW5cIj48L3NwYW4+JyA6IFwiXCJ9JHtlc2NhcGVIdG1sKHQuc3RhdGUpfTwvc3Bhbj5gICtcbiAgICAgICAgYDxzcGFuIGNsYXNzPVwiYWdlXCI+JHtlbGFwc2VkKGFnZSl9PC9zcGFuPmAgK1xuICAgICAgYDwvZGl2PmAgK1xuICAgICAgYDxkaXYgY2xhc3M9XCJwXCI+PC9kaXY+YDtcbiAgICBjb25zdCBsYWJlbEVsID0gY2FyZC5xdWVyeVNlbGVjdG9yKFwiLmxhYmVsXCIpIGFzIEhUTUxFbGVtZW50O1xuICAgIGxhYmVsRWwudGV4dENvbnRlbnQgPSB0LmxhYmVsO1xuICAgIGxhYmVsRWwudGl0bGUgPSB0LmxhYmVsO1xuICAgIGNhcmQucXVlcnlTZWxlY3RvcihcIi5wXCIpIS50ZXh0Q29udGVudCA9IHQucHJvZ3Jlc3MgPz8gdC5yZXF1ZXN0O1xuICAgIGlmICh0LnF1ZXN0aW9uKSB7XG4gICAgICBjb25zdCBxID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgIHEuY2xhc3NOYW1lID0gXCJxXCI7XG4gICAgICBxLnRleHRDb250ZW50ID0gYEFza3M6ICR7dC5xdWVzdGlvbn1gO1xuICAgICAgY2FyZC5hcHBlbmQocSk7XG4gICAgfVxuICAgIGlmICh2aWV3LmFwcHJvdmFsICYmIHQuc3RhdGUgPT09IFwicnVubmluZ1wiKSB7XG4gICAgICBjb25zdCBib3ggPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgICAgYm94LmNsYXNzTmFtZSA9IFwiYXBwcm92YWxcIjtcbiAgICAgIGJveC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz1cImFwcHJvdmFsLWhlYWRcIj5IZXJtZXMgYXNrcyB0byBydW48L2Rpdj48Y29kZT48L2NvZGU+PGRpdiBjbGFzcz1cImFjdHNcIj48L2Rpdj5gO1xuICAgICAgYm94LnF1ZXJ5U2VsZWN0b3IoXCJjb2RlXCIpIS50ZXh0Q29udGVudCA9IHZpZXcuYXBwcm92YWwuY29tbWFuZDtcbiAgICAgIGNvbnN0IGFuc3dlciA9IChjaG9pY2U6IFwib25jZVwiIHwgXCJkZW55XCIpID0+IHtcbiAgICAgICAgdmlldy5hcHByb3ZhbCA9IHVuZGVmaW5lZDtcbiAgICAgICAgc2hvd1Rhc2tzKHRydWUpO1xuICAgICAgICB2b2lkIGZldGNoKFwiL2hlcm1lcy9hcHByb3ZhbFwiLCB7IG1ldGhvZDogXCJQT1NUXCIsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgY2FsbDogY2FsbE5hbWUsIHRhc2tJZDogdC5pZCwgY2hvaWNlIH0pIH0pXG4gICAgICAgICAgLnRoZW4oKHIpID0+IHRvYXN0KHIub2sgPyAoY2hvaWNlID09PSBcIm9uY2VcIiA/IFwiQXBwcm92ZWRcIiA6IFwiRGVuaWVkXCIpIDogXCJUaGF0IGFwcHJvdmFsIGhhZCBhbHJlYWR5IGxhcHNlZFwiKSk7XG4gICAgICB9O1xuICAgICAgZm9yIChjb25zdCBbbGFiZWwsIGNob2ljZV0gb2YgW1tcIkFwcHJvdmUgb25jZVwiLCBcIm9uY2VcIl0sIFtcIkRlbnlcIiwgXCJkZW55XCJdXSBhcyBjb25zdCkge1xuICAgICAgICBjb25zdCBiID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgICAgICAgYi50eXBlID0gXCJidXR0b25cIjtcbiAgICAgICAgYi50ZXh0Q29udGVudCA9IGxhYmVsO1xuICAgICAgICBpZiAoY2hvaWNlID09PSBcIm9uY2VcIikgYi5jbGFzc05hbWUgPSBcImdvXCI7XG4gICAgICAgIGVsc2UgYi5jbGFzc05hbWUgPSBcImRhbmdlclwiO1xuICAgICAgICBiLm9uY2xpY2sgPSAoKSA9PiBhbnN3ZXIoY2hvaWNlKTtcbiAgICAgICAgYm94LnF1ZXJ5U2VsZWN0b3IoXCIuYWN0c1wiKSEuYXBwZW5kKGIpO1xuICAgICAgfVxuICAgICAgY2FyZC5hcHBlbmQoYm94KTtcbiAgICB9XG4gICAgaWYgKHQuc3RhdGUgIT09IFwicnVubmluZ1wiKSB2aWV3LmFwcHJvdmFsID0gdW5kZWZpbmVkO1xuICAgIGNvbnN0IGFjdHMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGFjdHMuY2xhc3NOYW1lID0gXCJhY3RzXCI7XG4gICAgY29uc3QgYnV0dG9uID0gKHRleHQ6IHN0cmluZywgZm46ICgpID0+IHZvaWQsIGNscyA9IFwiXCIpID0+IHtcbiAgICAgIGNvbnN0IGIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICAgICAgYi50eXBlID0gXCJidXR0b25cIjtcbiAgICAgIGIudGV4dENvbnRlbnQgPSB0ZXh0O1xuICAgICAgaWYgKGNscykgYi5jbGFzc05hbWUgPSBjbHM7XG4gICAgICBiLm9uY2xpY2sgPSBmbjtcbiAgICAgIGFjdHMuYXBwZW5kKGIpO1xuICAgICAgcmV0dXJuIGI7XG4gICAgfTtcbiAgICBpZiAoY2FsbElkICYmIGFjdGl2ZVNlc3Npb24gPiAwKSB7XG4gICAgICBjb25zdCBvcmlnaW5TZXNzaW9uID0gYWN0aXZlU2Vzc2lvbjtcbiAgICAgIGJ1dHRvbih3YWl0aW5nID8gXCJBbnN3ZXJcIiA6IFwiRm9sbG93IHVwXCIsICgpID0+IGZvbGxvd1VwRm9ybShjYXJkLCB0LCBvcmlnaW5TZXNzaW9uKSk7XG4gICAgICBpZiAodC5zdGF0ZSA9PT0gXCJydW5uaW5nXCIpIGJ1dHRvbihcIkNhbmNlbFwiLCAoKSA9PiBwdXNoKHsgdHlwZTogXCJjYW5jZWxUYXNrXCIsIHRhc2s6IHQuaWQgfSksIFwiZGFuZ2VyXCIpO1xuICAgIH1cbiAgICBpZiAodmlldy5yZXN1bHRJZCkgYnV0dG9uKFwiUmVzdWx0XCIsICgpID0+IGZvY3VzUmVzdWx0KHZpZXcucmVzdWx0SWQhKSk7XG4gICAgaWYgKHZpZXcudGhyZWFkKSBidXR0b24oXCJDb3B5IGlkXCIsICgpID0+IHsgdm9pZCBuYXZpZ2F0b3IuY2xpcGJvYXJkPy53cml0ZVRleHQodmlldy50aHJlYWQhKTsgdG9hc3QoXCJUaHJlYWQgaWQgY29waWVkXCIpOyB9KTtcbiAgICBpZiAoYWN0cy5jaGlsZEVsZW1lbnRDb3VudCkgY2FyZC5hcHBlbmQoYWN0cyk7XG4gICAgKGlzQWN0aXZlVGFzayh2aWV3KSA/IHBhbmUgOiBkb25lKS5hcHBlbmQoY2FyZCk7XG4gIH1cbiAgaWYgKHBhbmUuY2hpbGRFbGVtZW50Q291bnQgPT09IDApIHBhbmUuYXBwZW5kKG5vVGFza3MpO1xuICBzeW5jU2lkZUxheW91dCgpO1xuICB1cGRhdGVUYXNrQ2hyb21lKCk7XG59XG5cbmZ1bmN0aW9uIGZvbGxvd1VwRm9ybShjYXJkOiBIVE1MRWxlbWVudCwgdDogQ29tbWFuZCwgb3JpZ2luU2Vzc2lvbjogbnVtYmVyKSB7XG4gIGNvbnN0IGV4aXN0aW5nID0gY2FyZC5xdWVyeVNlbGVjdG9yKFwiZm9ybVwiKTtcbiAgaWYgKGV4aXN0aW5nKSB7IGV4aXN0aW5nLnF1ZXJ5U2VsZWN0b3IoXCJpbnB1dFwiKT8uZm9jdXMoKTsgcmV0dXJuOyB9XG4gIGNvbnN0IGZvcm0gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZm9ybVwiKTtcbiAgZm9ybS5jbGFzc05hbWUgPSBcImZvbGxvd3VwLWZvcm1cIjtcbiAgZm9ybS5pbm5lckhUTUwgPSBgPGlucHV0IHR5cGU9XCJ0ZXh0XCIgcGxhY2Vob2xkZXI9XCJUZWxsIFx1MjAxQyR7ZXNjYXBlSHRtbCh0LmxhYmVsKX1cdTIwMURcdTIwMjZcIiBlbnRlcmtleWhpbnQ9XCJzZW5kXCI+PGJ1dHRvbiB0eXBlPVwic3VibWl0XCI+U2VuZDwvYnV0dG9uPmA7XG4gIGNvbnN0IGlucHV0ID0gZm9ybS5xdWVyeVNlbGVjdG9yKFwiaW5wdXRcIikhO1xuICBmb3JtLm9uc3VibWl0ID0gKGUpID0+IHtcbiAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgY29uc3QgdGV4dCA9IGlucHV0LnZhbHVlLnRyaW0oKTtcbiAgICBpZiAodGV4dCkge1xuICAgICAgaWYgKCFjYW5Gb2xsb3dVcFJlc3VsdChvcmlnaW5TZXNzaW9uLCBhY3RpdmVTZXNzaW9uLCB0YXNrcy5oYXModC5pZCkpKSB7XG4gICAgICAgIHRvYXN0KFwiVGhhdCB0YXNrJ3MgY2FsbCBoYXMgZW5kZWRcIik7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBwdXNoKHsgdHlwZTogXCJzdGVlclwiLCB0YXNrOiB0LmlkLCB0ZXh0IH0pO1xuICAgICAgICBub3RlKGBZb3UgXHUyMTkyICR7dC5sYWJlbH06ICR7dGV4dH1gKTtcbiAgICAgICAgc2Nyb2xsRG93bih0cnVlKTtcbiAgICAgIH1cbiAgICB9XG4gICAgaW5wdXQuYmx1cigpO1xuICAgIGZvcm0ucmVtb3ZlKCk7XG4gICAgc2hvd1Rhc2tzKCk7XG4gIH07XG4gIGlucHV0Lm9ua2V5ZG93biA9IChlKSA9PiB7IGlmIChlLmtleSA9PT0gXCJFc2NhcGVcIikgeyBlLnN0b3BQcm9wYWdhdGlvbigpOyBpbnB1dC5ibHVyKCk7IGZvcm0ucmVtb3ZlKCk7IHNob3dUYXNrcygpOyB9IH07XG4gIGNhcmQuYXBwZW5kKGZvcm0pO1xuICBpbnB1dC5mb2N1cygpO1xufVxuXG4vKiogVDMgdGhyZWFkcyBlYXJsaWVyIGNhbGxzIHN0YXJ0ZWQ6IHRoZXkgY2Fycnkgb24gYWZ0ZXIgYSBjYWxsLCBzbyB0aGUgcGFuZWwgc2F5cyBob3cgdGhleSdyZSBkb2luZy4gKi9cbmFzeW5jIGZ1bmN0aW9uIHNob3dFYXJsaWVyKCkge1xuICBsZXQgbGlzdDogeyB0aHJlYWQ6IHN0cmluZzsgdGl0bGU6IHN0cmluZzsgc3RhdHVzOiBzdHJpbmc7IGJyYW5jaDogc3RyaW5nIHwgbnVsbDsgcHI6IHN0cmluZyB8IG51bGw7IHVwZGF0ZWQ6IHN0cmluZzsgbGFzdDogc3RyaW5nOyB3YWl0aW5nOiBib29sZWFuIH1bXSA9IFtdO1xuICB0cnkgeyBsaXN0ID0gYXdhaXQgKGF3YWl0IGZldGNoKFwiL2FnZW50L3JlY2VudFwiLCB7IGNhY2hlOiBcIm5vLXN0b3JlXCIgfSkpLmpzb24oKTsgfSBjYXRjaCB7fVxuICBjb25zdCBjdXJyZW50ID0gbmV3IFNldChbLi4udGFza3MudmFsdWVzKCldLm1hcCgodikgPT4gdi50aHJlYWQpLmZpbHRlcihCb29sZWFuKSk7XG4gIGxpc3QgPSBsaXN0LmZpbHRlcigodCkgPT4gIWN1cnJlbnQuaGFzKHQudGhyZWFkKSk7XG4gIGNvbnN0IHBhbmUgPSAkKFwiZWFybGllclwiKTtcbiAgY29uc3QgZG9uZSA9ICQoXCJkb25lZWFybGllclwiKTtcbiAgcGFuZS5pbm5lckhUTUwgPSBcIlwiO1xuICBkb25lLmlubmVySFRNTCA9IFwiXCI7XG4gIGVhcmxpZXJBY3RpdmVDb3VudCA9IDA7XG4gIGVhcmxpZXJXYWl0aW5nQ291bnQgPSAwO1xuICBmb3IgKGNvbnN0IHQgb2YgbGlzdCkge1xuICAgIGNvbnN0IGNhcmQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGNvbnN0IHN0YXRlID0gdC53YWl0aW5nID8gXCJ3YWl0aW5nIGZvciBhcHByb3ZhbCBpbiBUM1wiIDogdC5zdGF0dXM7XG4gICAgY2FyZC5jbGFzc05hbWUgPSBgdGFzayAke3Quc3RhdHVzID09PSBcInJ1bm5pbmdcIiA/IFwicnVubmluZ1wiIDogdC53YWl0aW5nID8gXCJ3YWl0aW5nXCIgOiBcImZpbmlzaGVkXCJ9YDtcbiAgICBjb25zdCBhZ28gPSBNYXRoLm1heCgwLCAoRGF0ZS5ub3coKSAtIERhdGUucGFyc2UodC51cGRhdGVkKSkgLyAxMDAwKTtcbiAgICBjYXJkLmlubmVySFRNTCA9XG4gICAgICBgPGRpdiBjbGFzcz1cIm1ldGEtcm93XCI+YCArXG4gICAgICAgIGA8c3BhbiBjbGFzcz1cImJhZGdlIHQzXCI+VDM8L3NwYW4+YCArXG4gICAgICAgIGA8c3BhbiBjbGFzcz1cImxhYmVsXCI+PC9zcGFuPmAgK1xuICAgICAgICBgPHNwYW4gY2xhc3M9XCJzdGF0ZVwiPiR7dC5zdGF0dXMgPT09IFwicnVubmluZ1wiID8gJzxzcGFuIGNsYXNzPVwic3BpblwiPjwvc3Bhbj4nIDogXCJcIn0ke2VzY2FwZUh0bWwoc3RhdGUpfTwvc3Bhbj5gICtcbiAgICAgICAgYDxzcGFuIGNsYXNzPVwiYWdlXCI+JHtlbGFwc2VkKGFnbyl9IGFnbzwvc3Bhbj5gICtcbiAgICAgIGA8L2Rpdj5gICtcbiAgICAgIGA8ZGl2IGNsYXNzPVwicFwiPjwvZGl2PmA7XG4gICAgY29uc3QgbGFiZWxFbCA9IGNhcmQucXVlcnlTZWxlY3RvcihcIi5sYWJlbFwiKSBhcyBIVE1MRWxlbWVudDtcbiAgICBsYWJlbEVsLnRleHRDb250ZW50ID0gdC50aXRsZTtcbiAgICBsYWJlbEVsLnRpdGxlID0gdC50aXRsZTtcbiAgICBjYXJkLnF1ZXJ5U2VsZWN0b3IoXCIucFwiKSEudGV4dENvbnRlbnQgPSB0Lmxhc3QgfHwgKHQuYnJhbmNoID8gYE9uICR7dC5icmFuY2h9YCA6IFwiXCIpO1xuICAgIGNvbnN0IGFjdHMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGFjdHMuY2xhc3NOYW1lID0gXCJhY3RzXCI7XG4gICAgaWYgKHQucHIpIHsgY29uc3QgYSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJhXCIpOyBhLmhyZWYgPSB0LnByOyBhLnRhcmdldCA9IFwiX2JsYW5rXCI7IGEucmVsID0gXCJub29wZW5lclwiOyBhLnRleHRDb250ZW50ID0gXCJQUiBcdTIxOTdcIjsgYWN0cy5hcHBlbmQoYSk7IH1cbiAgICBjb25zdCBjb3B5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgICBjb3B5LnR5cGUgPSBcImJ1dHRvblwiO1xuICAgIGNvcHkudGV4dENvbnRlbnQgPSBcIkNvcHkgaWRcIjtcbiAgICBjb3B5Lm9uY2xpY2sgPSAoKSA9PiB7IHZvaWQgbmF2aWdhdG9yLmNsaXBib2FyZD8ud3JpdGVUZXh0KHQudGhyZWFkKTsgdG9hc3QoXCJUaHJlYWQgaWQgY29waWVkXCIpOyB9O1xuICAgIGFjdHMuYXBwZW5kKGNvcHkpO1xuICAgIGNhcmQuYXBwZW5kKGFjdHMpO1xuICAgIGNvbnN0IGFjdGl2ZSA9IHQuc3RhdHVzID09PSBcInJ1bm5pbmdcIiB8fCB0LndhaXRpbmc7XG4gICAgaWYgKGFjdGl2ZSkgZWFybGllckFjdGl2ZUNvdW50Kys7XG4gICAgaWYgKHQud2FpdGluZykgZWFybGllcldhaXRpbmdDb3VudCsrO1xuICAgIChhY3RpdmUgPyBwYW5lIDogZG9uZSkuYXBwZW5kKGNhcmQpO1xuICB9XG4gIHN5bmNTaWRlTGF5b3V0KCk7XG4gIHVwZGF0ZVRhc2tDaHJvbWUoKTtcbn1cblxuY29uc3QgU1RBVFVTX1RFWFQ6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gIGlkbGU6IFwiSWRsZVwiLCBjb25uZWN0aW5nOiBcIkNvbm5lY3RpbmdcdTIwMjZcIiwgbGlzdGVuaW5nOiBcIkxpc3RlbmluZ1wiLCB3b3JraW5nOiBcIkxpc3RlbmluZyBcdTAwQjcgdGFza3MgcnVubmluZ1wiLFxuICBkb3JtYW50OiBcIkRvcm1hbnQgXHUwMEI3IHdhaXRpbmcgZm9yIHdha2Ugd29yZFwiLFxuICBzdGFuZGJ5OiBcIlBhdXNlZCB3aGlsZSB0YXNrcyBydW4gXHUwMEI3IHNwZWFrIHRvIHJlc3VtZVwiLCB3YWtpbmc6IFwiUmVzdW1pbmdcdTIwMjZcIiwgZW5kZWQ6IFwiRW5kZWRcIixcbn07XG5cbmZ1bmN0aW9uIHNob3dTdGF0dXMobWVzc2FnZT86IHN0cmluZykge1xuICBjb25zdCB0eXBlZCA9IEJvb2xlYW4oY2FsbElkKSAmJiBtZWRpdW0gPT09IFwidGV4dFwiO1xuICBjb25zdCBzcGVha2luZyA9IEJvb2xlYW4oY2FsbElkKSAmJiAhdHlwZWQgJiYgY29yZVN0YXR1cyAhPT0gXCJzdGFuZGJ5XCIgJiYgY29yZVN0YXR1cyAhPT0gXCJkb3JtYW50XCIgJiYgYXVkaW8ucXVldWVkID4gMC4wNTtcbiAgY29uc3QgYXJtZWRJZGxlID0gIWNhbGxJZCAmJiB3YWtlQXJtZWQ7XG4gIGNvbnN0IHNob3duID0gY2FsbElkXG4gICAgPyAoc3BlYWtpbmcgfHwgKHR5cGVkICYmIHRoaW5raW5nKSA/IFwic3BlYWtpbmdcIiA6IGNvcmVTdGF0dXMpXG4gICAgOiBhcm1lZElkbGUgPyBcImFybWVkXCIgOiBjb3JlU3RhdHVzO1xuICAkKFwic3RhdHVzXCIpLmNsYXNzTmFtZSA9IHNob3duO1xuICBkb2N1bWVudC5ib2R5LmRhdGFzZXQuc3RhdGUgPSBjYWxsSWQgPyBzaG93biA6IGFybWVkSWRsZSA/IFwiYXJtZWRcIiA6IFwiaWRsZVwiO1xuICBkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC50b2dnbGUoXCJpbi1zZXNzaW9uXCIsIEJvb2xlYW4oY2FsbElkKSk7XG4gIGNvbnN0IHdha2VMYWJlbCA9IHNlbGVjdGVkV2FrZU1vZGVsKCk/LmxhYmVsID8/IFwid2FrZSB3b3JkXCI7XG4gIGxldCB0ZXh0ID0gYXJtZWRJZGxlXG4gICAgPyAod2FrZUxvYWRpbmcgPyBgTG9hZGluZyBcdTIwMUMke3dha2VMYWJlbH1cdTIwMURcdTIwMjZgXG4gICAgICA6IGF1ZGlvLmF1ZGlvU3VzcGVuZGVkID8gYFRhcCBhbnl3aGVyZSB0byBhY3RpdmF0ZSBcdTIwMUMke3dha2VMYWJlbH1cdTIwMURgXG4gICAgICA6IGBXYWl0aW5nIGZvciBcdTIwMUMke3dha2VMYWJlbH1cdTIwMURgKVxuICAgIDogc3BlYWtpbmcgPyBcIlNwZWFraW5nXCJcbiAgICA6IGNvcmVTdGF0dXMgPT09IFwiZG9ybWFudFwiID8gYERvcm1hbnQgXHUwMEI3IHNheSBcdTIwMUMke3dha2VMYWJlbH1cdTIwMURgXG4gICAgOiBTVEFUVVNfVEVYVFtjb3JlU3RhdHVzXSA/PyBjb3JlU3RhdHVzO1xuICBpZiAodHlwZWQgJiYgY29yZVN0YXR1cyAhPT0gXCJlbmRlZFwiKSB0ZXh0ID0gdGhpbmtpbmcgPyBcIldyaXRpbmdcdTIwMjZcIiA6IGNvcmVTdGF0dXMgPT09IFwid29ya2luZ1wiID8gXCJDaGF0IFx1MDBCNyB0YXNrcyBydW5uaW5nXCIgOiBcIkNoYXRcIjtcbiAgaWYgKGNhbGxJZCAmJiAhdHlwZWQgJiYgbXV0ZWQgJiYgIWhvbGRpbmcgJiYgIXNwZWFraW5nKSB0ZXh0ICs9IFwiIFx1MDBCNyBtdXRlZFwiO1xuICBpZiAoaG9sZGluZykgdGV4dCA9IFwiVGFsa2luZyAoaG9sZClcIjtcbiAgaWYgKG1lc3NhZ2UpIHRleHQgPSBgJHt0ZXh0fTogJHttZXNzYWdlfWA7XG4gIGlmIChjb3JlU3RhdHVzICE9PSBcImVuZGVkXCIgfHwgbWVzc2FnZSB8fCBhcm1lZElkbGUpICQoXCJzdGF0dXN0ZXh0XCIpLnRleHRDb250ZW50ID0gdGV4dDtcbiAgJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJodXNoXCIpLmNsYXNzTGlzdC50b2dnbGUoXCJsaXZlXCIsIHNwZWFraW5nIHx8ICh0eXBlZCAmJiB0aGlua2luZykpO1xuXG4gIGNvbnN0IGJhciA9ICQoXCJjYWxsYmFyXCIpO1xuICBiYXIuaGlkZGVuID0gIWNhbGxJZDtcbiAgJChcIndha2Utbm93XCIpLmhpZGRlbiA9ICEoY2FsbElkICYmICF0eXBlZCAmJiAoY29yZVN0YXR1cyA9PT0gXCJkb3JtYW50XCIgfHwgY29yZVN0YXR1cyA9PT0gXCJzdGFuZGJ5XCIpKTtcbiAgaWYgKGNhbGxJZCkge1xuICAgICQoXCJjYWxsYmFyLXN0YXRlXCIpLnRleHRDb250ZW50ID0gdGV4dDtcbiAgICAkKFwiY2FsbHRpbWVyXCIpLmhpZGRlbiA9IHR5cGVkO1xuICAgIGlmICghdHlwZWQpICQoXCJjYWxsdGltZXJcIikudGV4dENvbnRlbnQgPSBmb3JtYXRDbG9jayhub3coKSAtIHN0YXJ0ZWRBdCk7XG4gICAgY29uc3Qgdml6TW9kZSA9IHR5cGVkID8gKHRoaW5raW5nID8gXCJ0aGlua2luZ1wiIDogXCJpZGxlXCIpXG4gICAgICA6IHNwZWFraW5nID8gXCJzcGVha2luZ1wiXG4gICAgICA6IG11dGVkICYmICFob2xkaW5nID8gXCJtdXRlZFwiXG4gICAgICA6IHNob3duO1xuICAgIHVwZGF0ZVZpc3VhbGl6ZXIodml6TW9kZSwgbXV0ZWQgJiYgIWhvbGRpbmcgPyAwIDogYXVkaW8ubGV2ZWwpO1xuICB9XG59XG5cbi8vIFRoZSBjYWxsLlxuXG5mdW5jdGlvbiBwdXNoKGV2ZW50OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiwgdCA9IG5vdygpKTogQ29tbWFuZFtdIHtcbiAgaWYgKCFjb3JlIHx8ICFjYWxsSWQpIHJldHVybiBbXTtcbiAgLy8gRmx1c2ggZGVmZXJyZWQgdW5zdXBwcmVzc2VkIGdhcCBmcmFtZXMgYmVmb3JlIGFueSBldmVudCB0aGF0IGNhbiBzdGFydCBuZXcgcGxheWJhY2tcbiAgLy8gKGFkdmFuY2luZyByZXBsYXlGbG9vclNlcSB3aXRob3V0IHJlc2V0dGluZyB3YWtlQ2xpZW50LCBzbyBhIHZhbGlkIHdha2UgaGl0IHN0aWxsIGxhbmRzKS5cbiAgY29uc3QgZmx1c2hlZCA9IHdha2VHYXRlLmJlZm9yZVB1c2goZXZlbnQsIHQpO1xuICBpZiAobWVkaXVtID09PSBcInZvaWNlXCIpIHtcbiAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgZmx1c2hlZCkge1xuICAgICAgaWYgKCFjYWxsSWQpIGJyZWFrO1xuICAgICAgY291bnRzLm1pYysrO1xuICAgICAgcHVzaCh7IHR5cGU6IFwibWljXCIsIHBjbTogaXRlbS5wY20gfSwgaXRlbS50KTtcbiAgICB9XG4gIH1cbiAgY29uc3QgZTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7IC4uLmV2ZW50LCB0IH07XG4gIGNvbnN0IHF1aWV0ID0gZS50eXBlID09PSBcIm1pY1wiIHx8IGUudHlwZSA9PT0gXCJ0aWNrXCI7XG4gIGlmICghcXVpZXQpIGxvZyhcImluXCIsIGUudHlwZSA9PT0gXCJ3cy5tZXNzYWdlXCIgPyBgd3MgJHtlLnNpZH0gXHUyMTkwICR7YnJpZWYoU3RyaW5nKGUuZGF0YSkpfWAgOiBKU09OLnN0cmluZ2lmeShlKS5zbGljZSgwLCA0MDApLCBcImluXCIpO1xuICBjb25zdCBjb21tYW5kcyA9IEpTT04ucGFyc2UoY29yZS5wdXNoKGNhbGxJZCwgSlNPTi5zdHJpbmdpZnkoZSkpKSBhcyBDb21tYW5kW107XG4gIHJ1bihjb21tYW5kcywgdCwgdHlwZW9mIGV2ZW50LnR5cGUgPT09IFwic3RyaW5nXCIgPyBldmVudC50eXBlIDogdW5kZWZpbmVkKTtcbiAgcmV0dXJuIGNvbW1hbmRzO1xufVxuXG5mdW5jdGlvbiBydW4oY29tbWFuZHM6IENvbW1hbmRbXSwgZXZlbnRUaW1lID0gbm93KCksIGV2ZW50VHlwZT86IHN0cmluZykge1xuICB3YWtlR2F0ZS5vYnNlcnZlQ29tbWFuZHMoY29tbWFuZHMsIGV2ZW50VGltZSwgZXZlbnRUeXBlKTtcbiAgZm9yIChjb25zdCBjIG9mIGNvbW1hbmRzKSB7XG4gICAgc3dpdGNoIChjLnR5cGUpIHtcbiAgICAgIGNhc2UgXCJ3cy5jb25uZWN0XCI6IGNvbm5lY3QoYy5zaWQsIGMucHVycG9zZSA9PT0gXCJjYXB0aW9uc1wiKTsgYnJlYWs7XG4gICAgICBjYXNlIFwid3Muc2VuZFwiOiB7XG4gICAgICAgIHNvY2tldHMuZ2V0KGMuc2lkKT8uc2VuZChjLmRhdGEpO1xuICAgICAgICBpZiAoIWMuZGF0YS5zdGFydHNXaXRoKCd7XCJyZWFsdGltZUlucHV0XCI6e1wiYXVkaW9cIicpKSBsb2coXCJvdXRcIiwgYHdzICR7Yy5zaWR9IFx1MjE5MiAke2JyaWVmKGMuZGF0YSl9YCwgXCJvdXRcIik7XG4gICAgICAgIGVsc2UgaWYgKCFjYXB0aW9uU29ja2V0cy5oYXMoYy5zaWQpKSBjb3VudHMuc2VudCsrO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ3cy5jbG9zZVwiOiBzb2NrZXRzLmdldChjLnNpZCk/LmNsb3NlKCk7IHNvY2tldHMuZGVsZXRlKGMuc2lkKTsgbG9nKFwib3V0XCIsIGB3cyAke2Muc2lkfSBjbG9zZWAsIFwib3V0XCIpOyBicmVhaztcbiAgICAgIGNhc2UgXCJtaWMuc3RhcnRcIjoge1xuICAgICAgICBsb2coXCJvdXRcIiwgYy50eXBlLCBcIm91dFwiKTtcbiAgICAgICAgY29uc3QgcGVuZGluZ09wZW5pbmcgPSB3YWtlU3RhcnRpbmcgPyBvcGVuaW5nQ2h1bmtzLnNwbGljZSgwKSA6IFtdO1xuICAgICAgICBvcGVuaW5nQnl0ZXMgPSAwO1xuICAgICAgICB3YWtlU3RhcnRpbmcgPSBmYWxzZTtcbiAgICAgICAgdm9pZCBhdWRpby5lbnN1cmVNaWMob25NaWMsIG1pY09wdGlvbnMoKSkuY2F0Y2goKGVycikgPT4geyBsb2coXCJlcnJvclwiLCBgbWljcm9waG9uZTogJHtlcnIubWVzc2FnZX1gLCBcImVyclwiKTsgdG9hc3QoYE1pY3JvcGhvbmU6ICR7ZXJyLm1lc3NhZ2V9YCk7IH0pO1xuICAgICAgICBpZiAocGVuZGluZ09wZW5pbmcubGVuZ3RoID4gMCkge1xuICAgICAgICAgIGNvbnN0IHRvdGFsTXMgPSBNYXRoLnJvdW5kKHBlbmRpbmdPcGVuaW5nLnJlZHVjZSgocywgYikgPT4gcyArIGIuYnl0ZUxlbmd0aCwgMCkgLyAzMik7XG4gICAgICAgICAgbG9nKFwib3V0XCIsIGBmbHVzaGluZyAke3RvdGFsTXN9IG1zIHNwb2tlbiBhZnRlciB3YWtlIHdvcmRgLCBcIm91dFwiKTtcbiAgICAgICAgICBxdWV1ZU1pY3JvdGFzaygoKSA9PiB7XG4gICAgICAgICAgICBpZiAoIWNhbGxJZCkgcmV0dXJuO1xuICAgICAgICAgICAgZm9yIChjb25zdCBjaHVuayBvZiBwZW5kaW5nT3BlbmluZykge1xuICAgICAgICAgICAgICBpZiAoIWNhbGxJZCkgYnJlYWs7XG4gICAgICAgICAgICAgIGNvdW50cy5taWMrKztcbiAgICAgICAgICAgICAgcHVzaCh7IHR5cGU6IFwibWljXCIsIHBjbTogYnl0ZXNUb0Jhc2U2NChjaHVuaykgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwibWljLnJlc3RhcnRcIjpcbiAgICAgICAgbG9nKFwib3V0XCIsIGMudHlwZSwgXCJvdXRcIik7XG4gICAgICAgIHZvaWQgYXVkaW8uc3RhcnRNaWMob25NaWMsIG1pY09wdGlvbnMoKSkuY2F0Y2goKGVycikgPT4geyBsb2coXCJlcnJvclwiLCBgbWljcm9waG9uZTogJHtlcnIubWVzc2FnZX1gLCBcImVyclwiKTsgdG9hc3QoYE1pY3JvcGhvbmU6ICR7ZXJyLm1lc3NhZ2V9YCk7IH0pO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJtaWMuc3RvcFwiOlxuICAgICAgICBpZiAoIXdha2VBcm1lZCkgYXVkaW8uc3RvcE1pYygpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJwbGF5XCI6IHtcbiAgICAgICAgY29uc3QgdCA9IG5vdygpO1xuICAgICAgICAvLyBBIHJlcGx5IHN0YXJ0aW5nOiBmcm9tIHRoZSBlbmQgb2YgdGhlIHVzZXIncyBzcGVlY2ggdG8gaXRzIGZpcnN0IHNvdW5kLlxuICAgICAgICBpZiAoIW1ldHJpY3MucmVwbGllZCAmJiBhdWRpby5xdWV1ZWQgPCAwLjA1ICYmIHQgLSBtZXRyaWNzLmxhc3RQbGF5ID4gMC42ICYmIG1ldHJpY3MubGFzdFZvaWNlID4gMCAmJiB0IC0gbWV0cmljcy5sYXN0Vm9pY2UgPCAxMCkge1xuICAgICAgICAgIG1ldHJpY3MucmVwbHkucHVzaCh0IC0gbWV0cmljcy5sYXN0Vm9pY2UpO1xuICAgICAgICAgIGlmIChtZXRyaWNzLnJlcGx5Lmxlbmd0aCA+IDIwKSBtZXRyaWNzLnJlcGx5LnNoaWZ0KCk7XG4gICAgICAgICAgbWV0cmljcy5yZXBsaWVkID0gdHJ1ZTtcbiAgICAgICAgICBzaG93TWV0cmljcygpO1xuICAgICAgICB9XG4gICAgICAgIG1ldHJpY3MubGFzdFBsYXkgPSB0O1xuICAgICAgICBhdWRpby5wbGF5KGMucGNtKTtcbiAgICAgICAgY291bnRzLnBsYXkrKztcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwiZmx1c2hcIjpcbiAgICAgICAgYXVkaW8uZmx1c2goKTtcbiAgICAgICAgbG9nKFwib3V0XCIsIFwiZmx1c2hcIiwgXCJvdXRcIik7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcImN1ZVwiOlxuICAgICAgICBhdWRpby5jdWUoYy5wY20pO1xuICAgICAgICBsb2coXCJvdXRcIiwgYGN1ZSAke2MuZWFyY29ufWAsIFwib3V0XCIpO1xuICAgICAgICAvLyBBIHJlcXVlc3QgdGhhdCBiZWNhbWUgYSB0YXNrIGdldHMgYSB0b25lLCBub3QgYSBzcG9rZW4gcmVwbHk6IG5vdGhpbmcgdG8gdGltZS5cbiAgICAgICAgaWYgKGMuZWFyY29uID09PSBcInRhc2tTdGFydGVkXCIpIG1ldHJpY3MucmVwbGllZCA9IHRydWU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcIndha2V3b3JkXCI6IGVuc3VyZUNvcmVXYWtlKEJvb2xlYW4oYy5vbikpOyBicmVhaztcbiAgICAgIGNhc2UgXCJ0b29sLmNhbGxcIjogdm9pZCB0b29sKGMpOyBicmVhaztcbiAgICAgIGNhc2UgXCJ0b29sLmNhbmNlbFwiOiBjYW5jZWxSdW4oYy5ydW4sIGMucmVhc29uKTsgYnJlYWs7XG4gICAgICBjYXNlIFwidG9vbC5zdGVlclwiOiB2b2lkIHN0ZWVyUnVuKGMpOyBicmVhaztcbiAgICAgIGNhc2UgXCJzdGF0dXNcIjoge1xuICAgICAgICBjb25zdCBwcmV2ID0gY29yZVN0YXR1cztcbiAgICAgICAgY29yZVN0YXR1cyA9IGMuc3RhdHVzO1xuICAgICAgICBpZiAoYy5zdGF0dXMgPT09IFwiZG9ybWFudFwiICYmIHByZXYgIT09IFwiZG9ybWFudFwiICYmIGNoZWNrZWQoXCJ3YWtlLWN1ZVwiKSkgYXVkaW8uY3VlKFNMRUVQX1RPTkUpO1xuICAgICAgICBzaG93U3RhdHVzKGMuc3RhdHVzID09PSBcImVuZGVkXCIgPyBjLm1lc3NhZ2UgPz8gdW5kZWZpbmVkIDogdW5kZWZpbmVkKTtcbiAgICAgICAgbG9nKFwic3RhdHVzXCIsIGMuc3RhdHVzICsgKGMubWVzc2FnZSA/IGA6ICR7Yy5tZXNzYWdlfWAgOiBcIlwiKSwgXCJzdGF0dXNcIik7XG4gICAgICAgIGlmIChjLnN0YXR1cyA9PT0gXCJlbmRlZFwiKSB7IGlmIChjLm1lc3NhZ2UpIG5vdGUoYy5tZXNzYWdlKTsgZW5kKCk7IH1cbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwibGxtLnJlcXVlc3RcIjogdm9pZCBnZW5lcmF0ZShjLmlkLCBjLmJvZHkpOyBicmVhaztcbiAgICAgIGNhc2UgXCJsbG0uY2FuY2VsXCI6IHJlcXVlc3RzLmdldChjLmlkKT8uYWJvcnQoKTsgcmVxdWVzdHMuZGVsZXRlKGMuaWQpOyBsb2coXCJvdXRcIiwgYHJlcXVlc3QgJHtjLmlkfSBkcm9wcGVkYCwgXCJvdXRcIik7IGJyZWFrO1xuICAgICAgY2FzZSBcInRoaW5raW5nXCI6IHRoaW5raW5nID0gYy5vbjsgc2hvd1N0YXR1cygpOyBicmVhaztcbiAgICAgIGNhc2UgXCJlcnJvclwiOiBub3RlKGMubWVzc2FnZSk7IGxvZyhcImVycm9yXCIsIGMubWVzc2FnZSwgXCJlcnJcIik7IGJyZWFrO1xuICAgICAgY2FzZSBcImNhcHRpb25cIjogY2FwdGlvbihjLnRleHQpOyBicmVhaztcbiAgICAgIGNhc2UgXCJ0cmFuc2NyaXB0XCI6XG4gICAgICAgIHRyYW5zY3JpcHQoYy5yb2xlLCBjLnRleHQsIGMubGluZSk7XG4gICAgICAgIHJlbWVtYmVyKGMucm9sZSwgYy50ZXh0LCBjLnJvbGUgPT09IFwiYXNzaXN0YW50XCIgPyBcIkdlbWluaVwiIDogdW5kZWZpbmVkLCBsYXN0TGluZSA9PT0gYy5saW5lKTtcbiAgICAgICAgbGFzdExpbmUgPSBjLmxpbmU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcInRhc2tcIjoge1xuICAgICAgICBjb25zdCB2aWV3ID0gdGFza3MuZ2V0KGMuaWQpID8/IHsgYywgc2luY2U6IG5vdygpLCBlbmRlZDogbnVsbCB9O1xuICAgICAgICBpZiAoYy5zdGF0ZSA9PT0gXCJydW5uaW5nXCIgJiYgdmlldy5jLnN0YXRlICE9PSBcInJ1bm5pbmdcIikgeyB2aWV3LnNpbmNlID0gbm93KCk7IHZpZXcuZW5kZWQgPSBudWxsOyB9XG4gICAgICAgIGlmIChjLnN0YXRlICE9PSBcInJ1bm5pbmdcIiAmJiB2aWV3LmVuZGVkID09IG51bGwpIHZpZXcuZW5kZWQgPSBub3coKTtcbiAgICAgICAgdmlldy5jID0gYztcbiAgICAgICAgdGFza3Muc2V0KGMuaWQsIHZpZXcpO1xuICAgICAgICBzaG93VGFza3MoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwicXVlc3Rpb25zXCI6IGJyZWFrO1xuICAgICAgY2FzZSBcIm1pY1NpbGVudFwiOiAkKFwibWljd2FyblwiKS5oaWRkZW4gPSAhYy5zaWxlbnQ7IGJyZWFrO1xuICAgICAgY2FzZSBcInZvaWNlQ29tbWFuZFwiOlxuICAgICAgICB0b2FzdChgSGVhcmQgXHUyMDFDJHtjLmhlYXJkfVx1MjAxRDogJHtjLmNvbW1hbmQgPT09IFwic3RvcFwiID8gXCJzdG9wcGVkXCIgOiBjLmNvbW1hbmQgPT09IFwiY2FuY2VsQWxsXCIgPyBcImNhbmNlbGxpbmcgZXZlcnkgdGFza1wiIDogXCJoYW5naW5nIHVwXCJ9YCk7XG4gICAgICAgIGxvZyhcIm91dFwiLCBgdm9pY2UgY29tbWFuZCAke2MuY29tbWFuZH06ICR7Yy5oZWFyZH1gLCBcIm91dFwiKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwibG9nXCI6IGxvZyhjLmxldmVsLCBjLm1lc3NhZ2UsIGMubGV2ZWwgPT09IFwid2FyblwiID8gXCJ3YXJuXCIgOiBcIlwiKTsgYnJlYWs7XG4gICAgICBkZWZhdWx0OiBsb2coXCJvdXRcIiwgSlNPTi5zdHJpbmdpZnkoYykuc2xpY2UoMCwgMzAwKSwgXCJvdXRcIik7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIGZsdXNoRGVmZXJyZWRNaWMoKSB7XG4gIGNvbnN0IGl0ZW1zID0gd2FrZUdhdGUuZmx1c2hEZWZlcnJlZCgpO1xuICBpZiAoIWNhbGxJZCB8fCBtZWRpdW0gIT09IFwidm9pY2VcIikgcmV0dXJuO1xuICBmb3IgKGNvbnN0IGl0ZW0gb2YgaXRlbXMpIHtcbiAgICBpZiAoIWNhbGxJZCkgYnJlYWs7XG4gICAgY291bnRzLm1pYysrO1xuICAgIHB1c2goeyB0eXBlOiBcIm1pY1wiLCBwY206IGl0ZW0ucGNtIH0sIGl0ZW0udCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gb25NaWMoc2FtcGxlczogSW50MTZBcnJheSwgbGV2ZWw6IG51bWJlcikge1xuICBjb25zdCB0ID0gbm93KCk7XG4gIGNvbnN0IHN1cHByZXNzZWQgPSBjYWxsSWQgIT09IDAgJiYgbWVkaXVtID09PSBcInZvaWNlXCIgJiYgd2FrZUdhdGUuaXNTdXBwcmVzc2VkKHQpO1xuICBjb25zdCBzZXEgPSBzaG91bGRGZWVkV2FrZSgpID8gd2FrZUNsaWVudC5mZWVkKHNhbXBsZXMsIHN1cHByZXNzZWQpIDogMDtcbiAgaWYgKHdha2VTdGFydGluZykge1xuICAgIGNvbnN0IGNvcHkgPSBuZXcgVWludDhBcnJheShzYW1wbGVzLmJ5dGVMZW5ndGgpO1xuICAgIGNvcHkuc2V0KG5ldyBVaW50OEFycmF5KHNhbXBsZXMuYnVmZmVyLCBzYW1wbGVzLmJ5dGVPZmZzZXQsIHNhbXBsZXMuYnl0ZUxlbmd0aCkpO1xuICAgIG9wZW5pbmdDaHVua3MucHVzaChjb3B5KTtcbiAgICBvcGVuaW5nQnl0ZXMgKz0gY29weS5ieXRlTGVuZ3RoO1xuICAgIHdoaWxlIChvcGVuaW5nQnl0ZXMgPiBPUEVOSU5HX01BWF9CWVRFUyAmJiBvcGVuaW5nQ2h1bmtzLmxlbmd0aCA+IDEpIHtcbiAgICAgIG9wZW5pbmdCeXRlcyAtPSBvcGVuaW5nQ2h1bmtzLnNoaWZ0KCkhLmJ5dGVMZW5ndGg7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuICBpZiAoIWNhbGxJZCB8fCBtZWRpdW0gIT09IFwidm9pY2VcIikgcmV0dXJuO1xuICBpZiAobGV2ZWwgPiAwLjAzICYmICEobXV0ZWQgJiYgIWhvbGRpbmcpKSB7XG4gICAgbWV0cmljcy5sYXN0Vm9pY2UgPSB0O1xuICAgIGlmIChhdWRpby5xdWV1ZWQgPCAwLjA1KSBtZXRyaWNzLnJlcGxpZWQgPSBmYWxzZTtcbiAgfVxuICBjb25zdCBwY20gPSBieXRlc1RvQmFzZTY0KG5ldyBVaW50OEFycmF5KHNhbXBsZXMuYnVmZmVyLCBzYW1wbGVzLmJ5dGVPZmZzZXQsIHNhbXBsZXMuYnl0ZUxlbmd0aCkpO1xuICBjb25zdCB0b1NlbmQgPSB3YWtlR2F0ZS5vbk1pY0ZyYW1lKHtcbiAgICBwY20sXG4gICAgdCxcbiAgICBzZXEsXG4gICAgbGFzdFNlcTogd2FrZUNsaWVudC5sYXN0U2VxLFxuICAgIGluRmxpZ2h0U3VwcHJlc3NlZFNlcTogd2FrZUNsaWVudC5pbkZsaWdodFN1cHByZXNzZWRTZXEsXG4gICAgc3VwcHJlc3NlZCxcbiAgfSk7XG4gIGZvciAoY29uc3QgaXRlbSBvZiB0b1NlbmQpIHtcbiAgICBpZiAoIWNhbGxJZCkgYnJlYWs7XG4gICAgY291bnRzLm1pYysrO1xuICAgIHB1c2goeyB0eXBlOiBcIm1pY1wiLCBwY206IGl0ZW0ucGNtIH0sIGl0ZW0udCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gY29ubmVjdChzaWQ6IG51bWJlciwgY2FwdGlvbnM6IGJvb2xlYW4pIHtcbiAgY29uc3Qgd3MgPSBuZXcgV2ViU29ja2V0KGAke2xvY2F0aW9uLnByb3RvY29sID09PSBcImh0dHBzOlwiID8gXCJ3c3NcIiA6IFwid3NcIn06Ly8ke2xvY2F0aW9uLmhvc3R9L2xpdmUke2NhcHRpb25zID8gXCI/Zm9yPWNhcHRpb25zXCIgOiBcIlwifWApO1xuICBzb2NrZXRzLnNldChzaWQsIHdzKTtcbiAgaWYgKGNhcHRpb25zKSBjYXB0aW9uU29ja2V0cy5hZGQoc2lkKTtcbiAgbG9nKFwib3V0XCIsIGB3cyAke3NpZH0gY29ubmVjdCAoJHtzZXJ2ZXIucm91dGV9JHtjYXB0aW9ucyA/IFwiLCBjYXB0aW9uc1wiIDogXCJcIn0pYCwgXCJvdXRcIik7XG4gIHdzLm9ub3BlbiA9ICgpID0+IHB1c2goeyB0eXBlOiBcIndzLm9wZW5cIiwgc2lkIH0pO1xuICB3cy5vbm1lc3NhZ2UgPSAobSkgPT4gcHVzaCh7IHR5cGU6IFwid3MubWVzc2FnZVwiLCBzaWQsIGRhdGE6IHR5cGVvZiBtLmRhdGEgPT09IFwic3RyaW5nXCIgPyBtLmRhdGEgOiBcIlwiIH0pO1xuICB3cy5vbmNsb3NlID0gKGUpID0+IHtcbiAgICBpZiAoc29ja2V0cy5nZXQoc2lkKSAhPT0gd3MgJiYgc29ja2V0cy5oYXMoc2lkKSkgcmV0dXJuO1xuICAgIGNvbnN0IGh0dHBTdGF0dXMgPSBlLmNvZGUgPj0gNDEwMCAmJiBlLmNvZGUgPCA0NjAwID8gZS5jb2RlIC0gNDAwMCA6IHVuZGVmaW5lZDtcbiAgICBwdXNoKHsgdHlwZTogXCJ3cy5jbG9zZWRcIiwgc2lkLCBjb2RlOiBodHRwU3RhdHVzID8gdW5kZWZpbmVkIDogZS5jb2RlLCByZWFzb246IGUucmVhc29uLCBodHRwU3RhdHVzIH0pO1xuICB9O1xufVxuXG4vKiogQSBjaGF0J3MgcmVxdWVzdCB0byB0aGUgdGV4dCBtb2RlbCwgdGhyb3VnaCB0aGUgc2VydmVyOiBlYWNoIGBkYXRhOmAgbGluZSBvZiB0aGUgbW9kZWwncyBzdHJlYW0gZ29lcyB0byB0aGUgY29yZSBhcyBpdCBjb21lcy4gKi9cbmFzeW5jIGZ1bmN0aW9uIGdlbmVyYXRlKGlkOiBudW1iZXIsIGJvZHk6IHN0cmluZykge1xuICBjb25zdCBhYm9ydCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgcmVxdWVzdHMuc2V0KGlkLCBhYm9ydCk7XG4gIGxvZyhcIm91dFwiLCBgcmVxdWVzdCAke2lkfSBcdTIxOTIgJHtzZXJ2ZXIudGV4dE1vZGVsfSAoJHtNYXRoLnJvdW5kKGJvZHkubGVuZ3RoIC8gMTAyNCl9IEtCKWAsIFwib3V0XCIpO1xuICB0cnkge1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goXCIvZ2VuZXJhdGVcIiwgeyBtZXRob2Q6IFwiUE9TVFwiLCBzaWduYWw6IGFib3J0LnNpZ25hbCwgaGVhZGVyczogeyBcImNvbnRlbnQtdHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LCBib2R5IH0pO1xuICAgIGlmICghcmVzcG9uc2Uub2sgfHwgIXJlc3BvbnNlLmJvZHkpIHtcbiAgICAgIGNvbnN0IHRleHQgPSBhd2FpdCByZXNwb25zZS50ZXh0KCkuY2F0Y2goKCkgPT4gXCJcIik7XG4gICAgICBwdXNoKHsgdHlwZTogXCJsbG0uZW5kXCIsIGlkLCBzdGF0dXM6IHJlc3BvbnNlLnN0YXR1cywgZXJyb3I6IGBIVFRQICR7cmVzcG9uc2Uuc3RhdHVzfSR7dGV4dCA/IFwiOiBcIiArIHRleHQucmVwbGFjZSgvXFxzKy9nLCBcIiBcIikuc2xpY2UoMCwgMjAwKSA6IFwiXCJ9YCB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgcmVhZGVyID0gcmVzcG9uc2UuYm9keS5waXBlVGhyb3VnaChuZXcgVGV4dERlY29kZXJTdHJlYW0oKSkuZ2V0UmVhZGVyKCk7XG4gICAgbGV0IGJ1ZmZlciA9IFwiXCI7XG4gICAgZm9yICg7Oykge1xuICAgICAgY29uc3QgeyB2YWx1ZSwgZG9uZSB9ID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcbiAgICAgIGlmIChkb25lKSBicmVhaztcbiAgICAgIGJ1ZmZlciArPSB2YWx1ZTtcbiAgICAgIGxldCBjdXQ7XG4gICAgICB3aGlsZSAoKGN1dCA9IGJ1ZmZlci5pbmRleE9mKFwiXFxuXCIpKSA+PSAwKSB7XG4gICAgICAgIGNvbnN0IGxpbmUgPSBidWZmZXIuc2xpY2UoMCwgY3V0KS5yZXBsYWNlKC9cXHIkLywgXCJcIik7XG4gICAgICAgIGJ1ZmZlciA9IGJ1ZmZlci5zbGljZShjdXQgKyAxKTtcbiAgICAgICAgaWYgKGxpbmUuc3RhcnRzV2l0aChcImRhdGE6XCIpKSBwdXNoKHsgdHlwZTogXCJsbG0uZGF0YVwiLCBpZCwgZGF0YTogbGluZS5zbGljZSg1KS50cmltKCkgfSk7XG4gICAgICB9XG4gICAgfVxuICAgIHB1c2goeyB0eXBlOiBcImxsbS5lbmRcIiwgaWQgfSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGlmICghYWJvcnQuc2lnbmFsLmFib3J0ZWQpIHB1c2goeyB0eXBlOiBcImxsbS5lbmRcIiwgaWQsIGVycm9yOiAoZXJyIGFzIEVycm9yKS5tZXNzYWdlIH0pO1xuICB9IGZpbmFsbHkge1xuICAgIHJlcXVlc3RzLmRlbGV0ZShpZCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gY2FuY2VsUnVuKGtleTogc3RyaW5nLCByZWFzb246IHN0cmluZykge1xuICBjb25zdCByID0gcnVucy5nZXQoa2V5KTtcbiAgbG9nKFwib3V0XCIsIGBjYW5jZWwgJHtrZXl9ICgke3JlYXNvbn0pYCwgXCJvdXRcIik7XG4gIGlmICghcikgcmV0dXJuO1xuICBydW5zLmRlbGV0ZShrZXkpO1xuICByLmFib3J0LmFib3J0KCk7XG4gIC8vIENhbmNlbGxlZCBvbiBwdXJwb3NlOiB0aGUgYWdlbnQgc3RvcHMgdG9vLiBBIGNhbGwgdGhhdCBlbmRlZCBsZWF2ZXMgYSBjb2RpbmcgYWdlbnQgd29ya2luZyBpbiBUMy5cbiAgaWYgKHJlYXNvbiA9PT0gXCJjYW5jZWxsZWRcIiAmJiAhY2hlY2tlZChcImZha2VoZXJtZXNcIikpIHtcbiAgICB2b2lkIGZldGNoKHIuYWdlbnQgPT09IFwidDNcIiA/IFwiL2FnZW50L2NhbmNlbFwiIDogXCIvaGVybWVzL3N0b3BcIiwgeyBtZXRob2Q6IFwiUE9TVFwiLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGNhbGw6IGNhbGxOYW1lLCB0YXNrSWQ6IHIudGFza0lkIH0pIH0pO1xuICB9XG59XG5cbi8qKiBNb3JlIGZvciBhIHJ1bm5pbmcgdGFzaywgaW50byBpdHMgY3VycmVudCBydW47IGlmIHRoZSBhZ2VudCB3b24ndCB0YWtlIGl0LCB0aGUgY29yZSBxdWV1ZXMgaXQgaW5zdGVhZC4gKi9cbmFzeW5jIGZ1bmN0aW9uIHN0ZWVyUnVuKGM6IENvbW1hbmQpIHtcbiAgY29uc3QgciA9IHJ1bnMuZ2V0KGMucnVuKTtcbiAgbG9nKFwib3V0XCIsIGBzdGVlciAke2MucnVufTogJHtjLnRleHR9YCwgXCJvdXRcIik7XG4gIGlmIChjaGVja2VkKFwiZmFrZWhlcm1lc1wiKSkgcmV0dXJuO1xuICBjb25zdCBvayA9IHIgIT0gbnVsbCAmJlxuICAgIChhd2FpdCBmZXRjaChjLmFnZW50ID09PSBcInQzXCIgPyBcIi9hZ2VudC9zdGVlclwiIDogXCIvaGVybWVzL3N0ZWVyXCIsIHsgbWV0aG9kOiBcIlBPU1RcIiwgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBjYWxsOiBjYWxsTmFtZSwgdGFza0lkOiByLnRhc2tJZCwgdGV4dDogYy5tZXNzYWdlIH0pIH0pLnRoZW4oKHgpID0+IHgub2ssICgpID0+IGZhbHNlKSk7XG4gIGlmICghb2spIHB1c2goeyB0eXBlOiBcInRvb2wuc3RlZXJGYWlsZWRcIiwgcnVuOiBjLnJ1biwgdGV4dDogYy50ZXh0IH0pO1xuICBlbHNlIHRvYXN0KGAke2MuYWdlbnQgPT09IFwidDNcIiA/IFwiVGhlIGNvZGluZyBhZ2VudFwiIDogXCJIZXJtZXNcIn0gdG9vayB0aGUgZm9sbG93LXVwIHdoaWxlIGl0IHdvcmtzYCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHRvb2woYzogQ29tbWFuZCkge1xuICBpZiAoYy5raW5kID09PSBcImhvc3RcIikge1xuICAgIGxvZyhcIm91dFwiLCBgaG9zdCB0b29sICR7Yy5uYW1lfSAke0pTT04uc3RyaW5naWZ5KGMuYXJncyl9YCwgXCJvdXRcIik7XG4gICAgY29uc3QgYW5zd2VyID0gYy5uYW1lID09PSBcInR2X3ZvbHVtZVwiID8gYFRoZSBUViBpcyBhdCAkeyhmYWtlVHZMZXZlbCA9IE51bWJlcihjLmFyZ3M/LmxldmVsID8/IGZha2VUdkxldmVsKSl9LmBcbiAgICAgIDogYy5uYW1lID09PSBcInR2X3BhdXNlXCIgPyAoYy5hcmdzPy5wYXVzZSA9PT0gZmFsc2UgPyBcIlBsYXlpbmcuXCIgOiBcIlBhdXNlZC5cIikgOiBcIkRvbmUuXCI7XG4gICAgc2V0VGltZW91dCgoKSA9PiBwdXNoKHsgdHlwZTogXCJ0b29sLnJlc3VsdFwiLCBydW46IGMucnVuLCB0ZXh0OiBhbnN3ZXIgfSksIDMwMCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IGFnZW50ID0gYy5hZ2VudCA9PT0gXCJ0M1wiID8gXCJ0M1wiIDogXCJoZXJtZXNcIjtcbiAgY29uc3Qgb3JpZ2luU2Vzc2lvbiA9IGFjdGl2ZVNlc3Npb247XG4gIGxvZyhcIm91dFwiLCBgJHthZ2VudH0gJHtjLmZvbGxvd1VwID8gXCJmb2xsb3ctdXBcIiA6IFwidGFza1wifSBcIiR7Yy5sYWJlbH1cIiR7Yy5wcm9qZWN0ID8gYCBpbiAke2MucHJvamVjdH1gIDogXCJcIn06ICR7Yy5yZXF1ZXN0fWAsIFwib3V0XCIpO1xuICBjb25zdCBhYm9ydCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgcnVucy5zZXQoYy5ydW4sIHsgYWJvcnQsIGFnZW50LCB0YXNrSWQ6IGMudGFza0lkIH0pO1xuICBjb25zdCBkb25lID0gKHRleHQ6IHN0cmluZywgZmFpbGVkID0gZmFsc2UpID0+IHtcbiAgICBpZiAoIXJ1bnMuaGFzKGMucnVuKSkgcmV0dXJuO1xuICAgIHJ1bnMuZGVsZXRlKGMucnVuKTtcbiAgICBjb25zdCB2aWV3ID0gdGFza3MuZ2V0KGMudGFza0lkKTtcbiAgICBjb25zdCByZXNJZCA9IHJlc3VsdChhZ2VudCwgYy5sYWJlbCwgdGV4dCwgZmFpbGVkLCBjLnRhc2tJZCwgb3JpZ2luU2Vzc2lvbik7XG4gICAgbm90aWZ5KGAke2FnZW50ID09PSBcInQzXCIgPyBcIlQzXCIgOiBcIkhlcm1lc1wifSBcdTAwQjcgJHtjLmxhYmVsfWAsIHRleHQpO1xuICAgIGlmICghZmFpbGVkKSB7IHJlbWVtYmVyKFwiYXNzaXN0YW50XCIsIHRleHQsIGAke2FnZW50ID09PSBcInQzXCIgPyBcIlQzXCIgOiBcIkhlcm1lc1wifSBcdTAwQjcgJHtjLmxhYmVsfWApOyBsYXN0TGluZSA9IG51bGw7IH1cbiAgICBpZiAodmlldykgeyB2aWV3LnJlc3VsdElkID0gcmVzSWQ7IHNob3dUYXNrcygpOyB9XG4gICAgcHVzaCh7IHR5cGU6IFwidG9vbC5yZXN1bHRcIiwgcnVuOiBjLnJ1biwgdGV4dCwgZmFpbGVkIH0pO1xuICB9O1xuICBpZiAoY2hlY2tlZChcImZha2VoZXJtZXNcIikpIHtcbiAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4gZG9uZShgKEZha2UgJHthZ2VudCA9PT0gXCJ0M1wiID8gXCJUM1wiIDogXCJIZXJtZXNcIn0pIERvbmU6IFx1MjAxQyR7Yy5yZXF1ZXN0fVx1MjAxRC4gTm90aGluZyB3YXMgYWN0dWFsbHkgcnVuLmApLCBOdW1iZXIoJDxIVE1MSW5wdXRFbGVtZW50PihcImZha2VkZWxheVwiKS52YWx1ZSkgKiAxMDAwKTtcbiAgICBhYm9ydC5zaWduYWwub25hYm9ydCA9ICgpID0+IGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgcmV0dXJuO1xuICB9XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChhZ2VudCA9PT0gXCJ0M1wiID8gXCIvYWdlbnRcIiA6IFwiL2hlcm1lc1wiLCB7XG4gICAgICBtZXRob2Q6IFwiUE9TVFwiLCBzaWduYWw6IGFib3J0LnNpZ25hbCwgaGVhZGVyczogeyBcImNvbnRlbnQtdHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBjYWxsOiBjYWxsTmFtZSwgdGFza0lkOiBjLnRhc2tJZCwgZm9sbG93VXA6IGMuZm9sbG93VXAsIG1lc3NhZ2U6IGMubWVzc2FnZSwgbGFiZWw6IGMubGFiZWwsIHJlcXVlc3Q6IGMucmVxdWVzdCwgcHJvamVjdDogYy5wcm9qZWN0LCBhcHByb3ZhbHM6IFwic2NyZWVuXCIgfSksXG4gICAgfSk7XG4gICAgaWYgKCFyZXNwb25zZS5vayB8fCAhcmVzcG9uc2UuYm9keSkgdGhyb3cgbmV3IEVycm9yKGBIVFRQICR7cmVzcG9uc2Uuc3RhdHVzfWApO1xuICAgIGNvbnN0IHJlYWRlciA9IHJlc3BvbnNlLmJvZHkucGlwZVRocm91Z2gobmV3IFRleHREZWNvZGVyU3RyZWFtKCkpLmdldFJlYWRlcigpO1xuICAgIGxldCBidWZmZXIgPSBcIlwiO1xuICAgIGZvciAoOzspIHtcbiAgICAgIGNvbnN0IHsgdmFsdWUsIGRvbmU6IGZpbmlzaGVkIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpO1xuICAgICAgaWYgKGZpbmlzaGVkKSBicmVhaztcbiAgICAgIGJ1ZmZlciArPSB2YWx1ZTtcbiAgICAgIGxldCBjdXQ7XG4gICAgICB3aGlsZSAoKGN1dCA9IGJ1ZmZlci5pbmRleE9mKFwiXFxuXFxuXCIpKSA+PSAwKSB7XG4gICAgICAgIGNvbnN0IGJsb2NrID0gYnVmZmVyLnNsaWNlKDAsIGN1dCk7XG4gICAgICAgIGJ1ZmZlciA9IGJ1ZmZlci5zbGljZShjdXQgKyAyKTtcbiAgICAgICAgY29uc3QgZXZlbnQgPSBibG9jay5tYXRjaCgvXmV2ZW50OiAoLiopJC9tKT8uWzFdO1xuICAgICAgICBpZiAoIWV2ZW50KSBjb250aW51ZTtcbiAgICAgICAgY29uc3QgZGF0YSA9IEpTT04ucGFyc2UoYmxvY2subWF0Y2goL15kYXRhOiAoLiopJC9tKT8uWzFdID8/IFwie31cIik7XG4gICAgICAgIGlmIChldmVudCA9PT0gXCJwcm9ncmVzc1wiKSBwdXNoKHsgdHlwZTogXCJ0YXNrLnByb2dyZXNzXCIsIHRhc2s6IGMudGFza0lkLCB0ZXh0OiBkYXRhLnRleHQgfSk7XG4gICAgICAgIGVsc2UgaWYgKGV2ZW50ID09PSBcInRocmVhZFwiKSB7IGNvbnN0IHZpZXcgPSB0YXNrcy5nZXQoYy50YXNrSWQpOyBpZiAodmlldykgeyB2aWV3LnRocmVhZCA9IGRhdGEudGhyZWFkOyBzaG93VGFza3MoKTsgfSB9XG4gICAgICAgIGVsc2UgaWYgKGV2ZW50ID09PSBcImFwcHJvdmFsXCIpIHtcbiAgICAgICAgICBjb25zdCB2aWV3ID0gdGFza3MuZ2V0KGMudGFza0lkKTtcbiAgICAgICAgICBpZiAodmlldykgeyB2aWV3LmFwcHJvdmFsID0geyBjb21tYW5kOiBkYXRhLmNvbW1hbmQgfTsgc2hvd1Rhc2tzKHRydWUpOyB9XG4gICAgICAgICAgdG9hc3QoYEhlcm1lcyBhc2tzIHRvIHJ1bjogJHtkYXRhLmNvbW1hbmQuc2xpY2UoMCwgODApfWApO1xuICAgICAgICAgIG5vdGlmeShgSGVybWVzIFx1MDBCNyAke2MubGFiZWx9IG5lZWRzIHlvdXIgYXBwcm92YWxgLCBkYXRhLmNvbW1hbmQpO1xuICAgICAgICAgIGF1ZGlvLmN1ZShBUFBST1ZBTF9UT05FKTtcbiAgICAgICAgfVxuICAgICAgICBlbHNlIGlmIChldmVudCA9PT0gXCJyZXN1bHRcIikgZG9uZShkYXRhLnRleHQsIGRhdGEuZmFpbGVkKTtcbiAgICAgICAgZWxzZSBpZiAoZXZlbnQgPT09IFwiZXJyb3JcIikgeyBydW5zLmRlbGV0ZShjLnJ1bik7IHB1c2goeyB0eXBlOiBcInRvb2wuZXJyb3JcIiwgcnVuOiBjLnJ1biwgbWVzc2FnZTogZGF0YS5tZXNzYWdlIH0pOyB9XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChydW5zLmhhcyhjLnJ1bikpIHsgcnVucy5kZWxldGUoYy5ydW4pOyBwdXNoKHsgdHlwZTogXCJ0b29sLmVycm9yXCIsIHJ1bjogYy5ydW4sIG1lc3NhZ2U6IFwidGhlIHNlcnZlciBjbG9zZWQgdGhlIHN0cmVhbSB3aXRob3V0IGEgcmVzdWx0XCIgfSk7IH1cbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgaWYgKCFhYm9ydC5zaWduYWwuYWJvcnRlZCAmJiBydW5zLmhhcyhjLnJ1bikpIHsgcnVucy5kZWxldGUoYy5ydW4pOyBwdXNoKHsgdHlwZTogXCJ0b29sLmVycm9yXCIsIHJ1bjogYy5ydW4sIG1lc3NhZ2U6IChlcnIgYXMgRXJyb3IpLm1lc3NhZ2UgfSk7IH1cbiAgfVxufVxuXG5mdW5jdGlvbiBtaWNPcHRpb25zKCkge1xuICBjb25zdCBhZWMgPSBjaGVja2VkKFwiYWVjXCIpO1xuICByZXR1cm4geyBlY2hvQ2FuY2VsbGF0aW9uOiBhZWMsIG5vaXNlU3VwcHJlc3Npb246IGFlYywgYXV0b0dhaW5Db250cm9sOiBhZWMgfTtcbn1cblxuZnVuY3Rpb24gbnVtYmVyU2V0dGluZyhpZDogc3RyaW5nLCBmYWxsYmFjazogbnVtYmVyLCBtaW4gPSAwLCBtYXggPSAzNjAwKTogbnVtYmVyIHtcbiAgY29uc3QgbiA9IE51bWJlcigkPEhUTUxJbnB1dEVsZW1lbnQ+KGlkKS52YWx1ZSk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobikgPyBNYXRoLm1heChtaW4sIE1hdGgubWluKG1heCwgbikpIDogZmFsbGJhY2s7XG59XG5cbmZ1bmN0aW9uIGRldmVsb3Blck92ZXJyaWRlcygpIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBnaXZlbiA9IEpTT04ucGFyc2UoJDxIVE1MVGV4dEFyZWFFbGVtZW50PihcImNvbmZpZ1wiKS52YWx1ZSk7XG4gICAgaWYgKCFnaXZlbiB8fCB0eXBlb2YgZ2l2ZW4gIT09IFwib2JqZWN0XCIpIHtcbiAgICAgIHJldHVybiB7IG5vbldlYlBsYXRmb3JtOiBudWxsIGFzIHN0cmluZyB8IG51bGwsIGhhc0F0dGVudGlvbjogZmFsc2UsIGhhc0hhbmdVcDogZmFsc2UsIGhhc1N0YW5kYnk6IGZhbHNlLCBoYXNNaWNXaGlsZVNwZWFraW5nOiBmYWxzZSB9O1xuICAgIH1cbiAgICBjb25zdCBub25XZWJQbGF0Zm9ybSA9IHR5cGVvZiBnaXZlbi5wbGF0Zm9ybSA9PT0gXCJzdHJpbmdcIiAmJiBnaXZlbi5wbGF0Zm9ybSAhPT0gXCJ3ZWJcIiA/IGdpdmVuLnBsYXRmb3JtIDogbnVsbDtcbiAgICBjb25zdCBtaWMgPSBnaXZlbi5taWMgJiYgdHlwZW9mIGdpdmVuLm1pYyA9PT0gXCJvYmplY3RcIiA/IGdpdmVuLm1pYyA6IG51bGw7XG4gICAgcmV0dXJuIHtcbiAgICAgIG5vbldlYlBsYXRmb3JtLFxuICAgICAgaGFzQXR0ZW50aW9uOiBnaXZlbi5hdHRlbnRpb24gIT09IHVuZGVmaW5lZCxcbiAgICAgIGhhc0hhbmdVcDogZ2l2ZW4uaGFuZ1VwQWZ0ZXIgIT09IHVuZGVmaW5lZCxcbiAgICAgIGhhc1N0YW5kYnk6IGdpdmVuLnN0YW5kYnlBZnRlciAhPT0gdW5kZWZpbmVkLFxuICAgICAgaGFzTWljV2hpbGVTcGVha2luZzogbWljICE9IG51bGwgJiYgbWljLndoaWxlU3BlYWtpbmcgIT09IHVuZGVmaW5lZCxcbiAgICB9O1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4geyBub25XZWJQbGF0Zm9ybTogbnVsbCBhcyBzdHJpbmcgfCBudWxsLCBoYXNBdHRlbnRpb246IGZhbHNlLCBoYXNIYW5nVXA6IGZhbHNlLCBoYXNTdGFuZGJ5OiBmYWxzZSwgaGFzTWljV2hpbGVTcGVha2luZzogZmFsc2UgfTtcbiAgfVxufVxuXG5mdW5jdGlvbiByZWFkQ29uZmlnKCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgY29uc3QgZ2l2ZW4gPSBKU09OLnBhcnNlKCQ8SFRNTFRleHRBcmVhRWxlbWVudD4oXCJjb25maWdcIikudmFsdWUpO1xuICBjb25zdCBjb25maWc6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgIG1vZGVsOiBzZXJ2ZXIubW9kZWwsIGFwaTogc2VydmVyLnJvdXRlID09PSBcInZlcnRleFwiID8gXCJ2ZXJ0ZXhcIiA6IFwiZ2VtaW5pXCIsIHRvZGF5OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkuc2xpY2UoMCwgMTApLFxuICAgIC4uLmdpdmVuLCB0cmFjZTogY2hlY2tlZChcInRyYWNlXCIpLFxuICB9O1xuICBpZiAoY2hlY2tlZChcInB0dFwiKSkgY29uZmlnLm11dGVkID0gdHJ1ZTtcbiAgaWYgKGdpdmVuLnZvaWNlID09PSB1bmRlZmluZWQpIGNvbmZpZy52b2ljZSA9ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwidm9pY2VcIikudmFsdWU7XG4gIGlmIChjb25maWcuc3RlZXJpbmcgPT09IHVuZGVmaW5lZCkgY29uZmlnLnN0ZWVyaW5nID0gW1wiaGVybWVzXCIsIFwidDNcIl07XG4gIC8vIEEgd2ViIGNvbmZpZyBzYXZlZCBiZWZvcmUgaGFuZC1vZmZzIHdlcmUgbmFtZWQgaW4gd29yZHMgZ2V0cyB0aGF0IHRvby5cbiAgaWYgKGNvbmZpZy5oYW5kT2ZmID09PSB1bmRlZmluZWQgJiYgY29uZmlnLnBsYXRmb3JtID09PSBcIndlYlwiKSBjb25maWcuaGFuZE9mZiA9IFwibmFtZWRcIjtcbiAgLy8gQW5kIG9uZSBzYXZlZCBiZWZvcmUgdGhlIHBhZ2UgZm9sbG93ZWQgdGhlIHVzZXIncyBsZWFkIChzdXBlcnZpc2UpIGdldHMgdGhhdC5cbiAgaWYgKGNvbmZpZy5zdXBlcnZpc2UgPT09IHVuZGVmaW5lZCAmJiBjb25maWcucGxhdGZvcm0gPT09IFwid2ViXCIpIGNvbmZpZy5zdXBlcnZpc2UgPSB0cnVlO1xuICBpZiAoY2hlY2tlZChcImNvZGluZ1wiKSAmJiAoc2VydmVyLnQzIHx8IGNoZWNrZWQoXCJmYWtlaGVybWVzXCIpKSAmJiBjb25maWcuY29kaW5nQWdlbnQgPT09IHVuZGVmaW5lZCkgY29uZmlnLmNvZGluZ0FnZW50ID0geyBwcm9qZWN0czogc2VydmVyLnQzID8/IFtdIH07XG4gIGlmIChjaGVja2VkKFwiY2FwdGlvbnNcIikgJiYgc2VydmVyLmNhcHRpb25zTW9kZWwgJiYgY29uZmlnLmNhcHRpb25zID09PSB1bmRlZmluZWQpIGNvbmZpZy5jYXB0aW9ucyA9IHsgbW9kZWw6IHNlcnZlci5jYXB0aW9uc01vZGVsIH07XG4gIC8vIEFwcGx5IGVhY2ggU2V0dGluZ3Mgc2lnbmFsaW5nIGZpZWxkIGluZGVwZW5kZW50bHkgZm9yIHdlYiBjb25maWdzIHVubGVzcyBzZXQgaW4gRGV2ZWxvcGVyIEpTT04gLyBwcmVzZXQuXG4gIGNvbnN0IG5vbldlYiA9IHR5cGVvZiBnaXZlbi5wbGF0Zm9ybSA9PT0gXCJzdHJpbmdcIiAmJiBnaXZlbi5wbGF0Zm9ybSAhPT0gXCJ3ZWJcIjtcbiAgaWYgKCFub25XZWIpIHtcbiAgICBjb25zdCBzaWduYWxpbmcgPSAkPEhUTUxTZWxlY3RFbGVtZW50PihcInNpZ25hbGluZ1wiKS52YWx1ZTtcbiAgICBpZiAoZ2l2ZW4uYXR0ZW50aW9uID09PSB1bmRlZmluZWQgJiYgKHNpZ25hbGluZyA9PT0gXCJ3aW5kb3dcIiB8fCBzaWduYWxpbmcgPT09IFwiZWNob1wiKSkge1xuICAgICAgY29uZmlnLmF0dGVudGlvbiA9IHtcbiAgICAgICAgbW9kZTogXCJ3aW5kb3dcIixcbiAgICAgICAgYWZ0ZXJXYWtlOiBudW1iZXJTZXR0aW5nKFwiYXR0bi1hZnRlci13YWtlXCIsIDgsIDEsIDYwKSxcbiAgICAgICAgd2luZG93OiBudW1iZXJTZXR0aW5nKFwiYXR0bi13aW5kb3dcIiwgNSwgMCwgNjApLFxuICAgICAgICBhZnRlclF1ZXN0aW9uOiBudW1iZXJTZXR0aW5nKFwiYXR0bi1hZnRlci1xdWVzdGlvblwiLCAxMCwgMCwgNjApLFxuICAgICAgICBhZnRlckhhbmRPZmY6IDMsXG4gICAgICAgIGFmdGVyQW5ub3VuY2VtZW50OiAwLFxuICAgICAgfTtcbiAgICB9XG4gICAgaWYgKGdpdmVuLmhhbmdVcEFmdGVyID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbmZpZy5oYW5nVXBBZnRlciA9IG51bWJlclNldHRpbmcoXCJoYW5ndXAtYWZ0ZXJcIiwgc2lnbmFsaW5nID09PSBcImVjaG9cIiA/IDE1IDogMzAwLCAwLCAzNjAwKTtcbiAgICB9XG4gICAgaWYgKHNpZ25hbGluZyA9PT0gXCJlY2hvXCIgJiYgZ2l2ZW4uc3RhbmRieUFmdGVyID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbmZpZy5zdGFuZGJ5QWZ0ZXIgPSA4O1xuICAgIH1cbiAgICBjb25zdCBnaXZlbk1pYyA9IGdpdmVuLm1pYyAmJiB0eXBlb2YgZ2l2ZW4ubWljID09PSBcIm9iamVjdFwiID8gKGdpdmVuLm1pYyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgOiBudWxsO1xuICAgIGlmICgoIWdpdmVuTWljIHx8IGdpdmVuTWljLndoaWxlU3BlYWtpbmcgPT09IHVuZGVmaW5lZCkgJiYgKGNoZWNrZWQoXCJ3YWtlLWJhcmdlXCIpIHx8IHNpZ25hbGluZyA9PT0gXCJlY2hvXCIpKSB7XG4gICAgICBjb25maWcubWljID0geyBnYWluRGI6IDAsIC4uLihnaXZlbk1pYyA/PyB7fSksIHdoaWxlU3BlYWtpbmc6IFwid2FrZVwiIH07XG4gICAgfVxuICB9XG4gIHJldHVybiBjb25maWc7XG59XG5cbi8qKiBTdGFydHMgYSB2b2ljZSBjYWxsLCBvciB3aXRoIFt0eXBlZF0gYSBjaGF0ICh0aGUgY29yZSdzIG1lZGl1bSBcInRleHRcIjogbm8gYXVkaW8sIGEgdGV4dCBtb2RlbCkuICovXG5hc3luYyBmdW5jdGlvbiBzdGFydChjYXJyeU9uID0gZmFsc2UsIHR5cGVkID0gZmFsc2UpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgaWYgKHN0YXJ0aW5nQ2FsbCB8fCBjYWxsSWQpIHJldHVybiBmYWxzZTtcbiAgc3RhcnRpbmdDYWxsID0gdHJ1ZTtcbiAgdHJ5IHtcbiAgICBhd2FpdCBlbmRpbmc7XG4gICAgaWYgKGNhbGxJZCkgcmV0dXJuIGZhbHNlO1xuICAgIGxldCBnaXZlbjogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgdHJ5IHtcbiAgICAgIGdpdmVuID0gcmVhZENvbmZpZygpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgdG9hc3QoYFRoZSBkZXZlbG9wZXIgc2V0dGluZ3MgYXJlbid0IHZhbGlkIEpTT046ICR7KGVyciBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgaWYgKHR5cGVkKSB7XG4gICAgICBpZiAoIXNlcnZlci50ZXh0TW9kZWwpIHsgdG9hc3QoXCJUaGlzIHNlcnZlciBoYXMgbm8gdGV4dCBtb2RlbCBmb3IgYSBjaGF0OiBzdGFydCBhIGNhbGwgdG8gdHlwZSB0byBpdFwiKTsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICBnaXZlbiA9IHsgLi4uZ2l2ZW4sIG1lZGl1bTogXCJ0ZXh0XCIsIG11dGVkOiBmYWxzZSB9O1xuICAgICAgZGVsZXRlIGdpdmVuLmNhcHRpb25zO1xuICAgIH1cbiAgICAkPEhUTUxCdXR0b25FbGVtZW50PihcImNhbGxcIikuZGlzYWJsZWQgPSB0cnVlO1xuICAgICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiaGVyby1jYWxsXCIpLmRpc2FibGVkID0gdHJ1ZTtcbiAgICBpZiAoXCJOb3RpZmljYXRpb25cIiBpbiB3aW5kb3cgJiYgTm90aWZpY2F0aW9uLnBlcm1pc3Npb24gPT09IFwiZGVmYXVsdFwiKSB2b2lkIE5vdGlmaWNhdGlvbi5yZXF1ZXN0UGVybWlzc2lvbigpLmNhdGNoKCgpID0+IHt9KTtcbiAgICBsZXQgbG9hZGVkQ29yZTogQ29yZTtcbiAgICB0cnkge1xuICAgICAgaWYgKCF0eXBlZCkgYXdhaXQgYXVkaW8ub3BlbigpO1xuICAgICAgbG9hZGVkQ29yZSA9IGF3YWl0IGxvYWRDb3JlKCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiY2FsbFwiKS5kaXNhYmxlZCA9IGZhbHNlO1xuICAgICAgJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJoZXJvLWNhbGxcIikuZGlzYWJsZWQgPSBmYWxzZTtcbiAgICB9XG4gICAgaWYgKGNhbGxJZCkgcmV0dXJuIGZhbHNlO1xuICAgIGNvcmUgPSBsb2FkZWRDb3JlO1xuICAgIGlmICh0eXBlZCkge1xuICAgICAgd2FrZVN0YXJ0aW5nID0gZmFsc2U7XG4gICAgICBvcGVuaW5nQ2h1bmtzID0gW107XG4gICAgICBvcGVuaW5nQnl0ZXMgPSAwO1xuICAgICAgaWYgKHdha2VBcm1lZCkgYXVkaW8uc3RvcE1pYygpO1xuICAgIH1cbiAgICBtZWRpdW0gPSB0eXBlZCA/IFwidGV4dFwiIDogXCJ2b2ljZVwiO1xuICAgIHRoaW5raW5nID0gZmFsc2U7XG4gICAgJChcInZlcnNpb25cIikudGV4dENvbnRlbnQgPSBjb3JlLnZlcnNpb247XG4gICAgJChcImxvZ1wiKS5pbm5lckhUTUwgPSBcIlwiO1xuICAgIGlmICghdHlwZWQgJiYgKHRhc2tzLnNpemUgPiAwIHx8ICQoXCJ0cmFuc2NyaXB0XCIpLmNoaWxkRWxlbWVudENvdW50ID4gMSkpIG5vdGUoYE5ldyBjYWxsIFx1MDBCNyAke25ldyBEYXRlKCkudG9Mb2NhbGVUaW1lU3RyaW5nKCl9YCk7XG4gICAgc2Nyb2xsRG93bih0cnVlKTtcbiAgICB0YXNrcy5jbGVhcigpO1xuICAgIGFjdGl2ZVNlc3Npb24gPSArK3Nlc3Npb25TZXE7XG4gICAgc2hvd1Rhc2tzKCk7XG4gICAgY291bnRzID0geyBtaWM6IDAsIHBsYXk6IDAsIHNlbnQ6IDAgfTtcbiAgICBtZXRyaWNzLnJlcGx5ID0gW107XG4gICAgc3RhcnRlZEF0ID0gbm93KCk7XG4gICAgbXV0ZWQgPSBnaXZlbi5tdXRlZCA9PT0gdHJ1ZTtcbiAgICBjb25zdCBtaWNDZmcgPSBnaXZlbi5taWMgJiYgdHlwZW9mIGdpdmVuLm1pYyA9PT0gXCJvYmplY3RcIiA/IChnaXZlbi5taWMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIDogbnVsbDtcbiAgICBjb25zdCBsaW1pdHNDZmcgPSBnaXZlbi5saW1pdHMgJiYgdHlwZW9mIGdpdmVuLmxpbWl0cyA9PT0gXCJvYmplY3RcIiA/IChnaXZlbi5saW1pdHMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIDogbnVsbDtcbiAgICBjb25zdCBhbm5vdW5jZUNmZyA9IGdpdmVuLmFubm91bmNlICYmIHR5cGVvZiBnaXZlbi5hbm5vdW5jZSA9PT0gXCJvYmplY3RcIiA/IChnaXZlbi5hbm5vdW5jZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgOiBudWxsO1xuICAgIHdha2VHYXRlLnJlc2V0KHR5cGVvZiBtaWNDZmc/LndoaWxlU3BlYWtpbmcgPT09IFwic3RyaW5nXCIgPyBtaWNDZmcud2hpbGVTcGVha2luZyA6IFwic2VuZFwiLCB3YWtlQ2xpZW50Lmxhc3RTZXEsIHtcbiAgICAgIGRlbGl2ZXJNYXg6IHR5cGVvZiBsaW1pdHNDZmc/LmRlbGl2ZXJNYXggPT09IFwibnVtYmVyXCIgPyBsaW1pdHNDZmcuZGVsaXZlck1heCA6IDMwLFxuICAgICAgYnJpZWZXYWl0OiB0eXBlb2YgYW5ub3VuY2VDZmc/LmJyaWVmV2FpdCA9PT0gXCJudW1iZXJcIiA/IGFubm91bmNlQ2ZnLmJyaWVmV2FpdCA6IDMsXG4gICAgICBtdXRlZCxcbiAgICB9KTtcbiAgICB3YWtlUGVyaW9kQ2FsbElkID0gbnVsbDtcbiAgICB3YWtlQ2xpZW50LnJlc2V0KCk7XG4gICAgLy8gQ2Fycnlpbmcgb246IHRoZSBtb2RlbCBnZXRzIHRoZSBsYXN0IGNvbnZlcnNhdGlvbiBhcyBhIHJlY2FwLiBUaGUgY29yZSBjYXBzIGl0LCBsYXRlc3QgbGluZXMgZmlyc3QuXG4gICAgLy8gQSBjaGF0IGFsd2F5cyBjYXJyaWVzIG9uIGZyb20gd2hhdCdzIG9uIHRoZSBzY3JlZW4gKGFuIGVhcmxpZXIgY2FsbCBvciBjaGF0IG9uIHRoaXMgcGFnZSkuXG4gICAgaWYgKHR5cGVkKSB7IGlmIChjaGF0Lmxlbmd0aCA+IDAgJiYgZ2l2ZW4uaGlzdG9yeSA9PT0gdW5kZWZpbmVkKSBnaXZlbi5oaXN0b3J5ID0gY2hhdDsgfVxuICAgIGVsc2UgaWYgKGNhcnJ5T24gJiYgZ2l2ZW4uaGlzdG9yeSA9PT0gdW5kZWZpbmVkKSBnaXZlbi5oaXN0b3J5ID0gc2F2ZWRIaXN0b3J5KCk7XG4gICAgZWxzZSBpZiAoIWNhcnJ5T24pIGNoYXQgPSBbXTtcbiAgICBpZiAoY2FycnlPbiAmJiAhdHlwZWQpIGNoYXQgPSBzYXZlZEhpc3RvcnkoKTtcbiAgICBsYXN0TGluZSA9IG51bGw7XG4gICAgb3BlbkxpbmUgPSBudWxsO1xuICAgIHN5bmNSZXN1bWVCdXR0b25zKGZhbHNlKTtcbiAgICBjYWxsTmFtZSA9IGAke25ldyBEYXRlKCkudG9JU09TdHJpbmcoKS5yZXBsYWNlKC9bOi5dL2csIFwiLVwiKX0tJHt0eXBlZCA/IFwiY2hhdFwiIDogXCJ3ZWJcIn0tJHtjb3JlLnZlcnNpb259YDtcbiAgICBjb25zdCBjcmVhdGVkID0gSlNPTi5wYXJzZShjb3JlLmNyZWF0ZShKU09OLnN0cmluZ2lmeShnaXZlbiksIG5vdygpKSk7XG4gICAgY2FsbElkID0gY3JlYXRlZC5pZDtcbiAgICBpZiAoIXR5cGVkKSB7XG4gICAgICBzZXRDYWxsQnV0dG9uKHRydWUpO1xuICAgICAgJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJtaWNcIikuZGlzYWJsZWQgPSBmYWxzZTtcbiAgICB9XG4gICAgJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJodXNoXCIpLmRpc2FibGVkID0gZmFsc2U7XG4gICAgJChcIm1pY1wiKS5jbGFzc0xpc3QudG9nZ2xlKFwibXV0ZWRcIiwgbXV0ZWQpO1xuICAgIHJ1bihjcmVhdGVkLmNvbW1hbmRzKTtcbiAgICBzaG93U3RhdHVzKCk7XG4gICAgdGlja2VyID0gd2luZG93LnNldEludGVydmFsKCgpID0+IHtcbiAgICAgIHB1c2goeyB0eXBlOiBcInRpY2tcIiB9KTtcbiAgICAgIGNvbnN0IGxldmVsID0gbXV0ZWQgJiYgIWhvbGRpbmcgPyAwIDogYXVkaW8ubGV2ZWw7XG4gICAgICBjb25zdCBzdHJlbmd0aCA9IE1hdGgubWluKDEsIGxldmVsICogMTIpO1xuICAgICAgJChcInJpbmdcIikuc3R5bGUub3BhY2l0eSA9IFN0cmluZyhzdHJlbmd0aCk7XG4gICAgICAkKFwicmluZ1wiKS5zdHlsZS50cmFuc2Zvcm0gPSBgc2NhbGUoJHsoMSArIHN0cmVuZ3RoICogMC4xMikudG9GaXhlZCgzKX0pYDtcbiAgICAgICQoXCJjb3VudHNcIikudGV4dENvbnRlbnQgPSBgbWljICR7Y291bnRzLm1pY30gXHUwMEI3IHNlbnQgJHtjb3VudHMuc2VudH0gXHUwMEI3IHBsYXllZCAke2NvdW50cy5wbGF5fSBcdTAwQjcgcXVldWVkICR7YXVkaW8ucXVldWVkLnRvRml4ZWQoMSl9IHNgO1xuICAgICAgc2hvd1N0YXR1cygpO1xuICAgIH0sIDEwMCk7XG4gICAgdHJhY2VUaW1lciA9IHdpbmRvdy5zZXRJbnRlcnZhbCgoKSA9PiB7IHZvaWQgc2F2ZVRyYWNlKCk7IHZvaWQgcGluZygpOyBzaG93VGFza3MoKTsgfSwgNTAwMCk7XG4gICAgdm9pZCBwaW5nKCk7XG4gICAgaWYgKCF0eXBlZCkge1xuICAgICAgc3RvcFdvcmRzLnN0YXJ0KCk7XG4gICAgICBhd2FpdCBhY3F1aXJlV2FrZUxvY2soKTtcbiAgICB9XG4gICAgcmV0dXJuIHRydWU7XG4gIH0gZmluYWxseSB7XG4gICAgc3RhcnRpbmdDYWxsID0gZmFsc2U7XG4gIH1cbn1cblxuLyoqIFRoZSBDYWxsIGJ1dHRvbjogaGFuZ3MgdXAgYSBjYWxsOyBzdGFydHMgb25lOyBvciwgd2l0aCBhIGNoYXQgb24sIGVuZHMgdGhlIGNoYXQgYW5kIGNhcnJpZXMgaXRzIGNvbnZlcnNhdGlvbiBvbiBieSB2b2ljZS4gKi9cbmFzeW5jIGZ1bmN0aW9uIGNhbGxCdXR0b24oKSB7XG4gIGlmIChjYWxsSWQgJiYgbWVkaXVtID09PSBcInZvaWNlXCIpIHsgaGFuZ1VwKCk7IHJldHVybjsgfVxuICBpZiAoY2FsbElkKSB7XG4gICAgLy8gQSBjYWxsIGNhbid0IHRha2Ugb3ZlciB0aGUgY2hhdCdzIHRhc2tzLCBhbmQgZW5kaW5nIHRoZSBjaGF0IHdvdWxkIHN0b3AgdGhlbS5cbiAgICBpZiAoWy4uLnRhc2tzLnZhbHVlcygpXS5zb21lKCh2KSA9PiB2LmMuc3RhdGUgPT09IFwicnVubmluZ1wiKSkgeyB0b2FzdChcIlRoZSBjaGF0J3MgdGFza3MgYXJlIHN0aWxsIHJ1bm5pbmc6IHdhaXQgZm9yIHRoZW0gb3IgY2FuY2VsIHRoZW0sIHRoZW4gY2FsbFwiKTsgcmV0dXJuOyB9XG4gICAgcHVzaCh7IHR5cGU6IFwic3RvcFwiIH0pO1xuICAgIGF3YWl0IHN0YXJ0KHRydWUpO1xuICAgIHJldHVybjtcbiAgfVxuICBhd2FpdCBzdGFydCgpO1xufVxuXG5mdW5jdGlvbiBoYW5nVXAoKSB7XG4gIGlmIChjYWxsSWQpIHB1c2goeyB0eXBlOiBcInN0b3BcIiwgbWVzc2FnZTogXCJZb3UgaHVuZyB1cC5cIiB9KTtcbn1cblxuZnVuY3Rpb24gZW5kKCkge1xuICB3aW5kb3cuY2xlYXJJbnRlcnZhbCh0aWNrZXIpO1xuICB3aW5kb3cuY2xlYXJJbnRlcnZhbCh0cmFjZVRpbWVyKTtcbiAgc3RvcFdvcmRzLnN0b3AoKTtcbiAgYWN0aXZlU2Vzc2lvbiA9IDA7XG4gIHN5bmNSZXN1bHRGb2xsb3dVcEJ1dHRvbnMoKTtcbiAgY29yZVdhbnRzV2FrZSA9IGZhbHNlO1xuICB3YWtlR2F0ZS5yZXNldChcInNlbmRcIiwgd2FrZUNsaWVudC5sYXN0U2VxKTtcbiAgd2FrZVBlcmlvZENhbGxJZCA9IHdha2VBcm1lZCA/IDAgOiBudWxsO1xuICB3YWtlU3RhcnRpbmcgPSBmYWxzZTtcbiAgb3BlbmluZ0NodW5rcyA9IFtdO1xuICBvcGVuaW5nQnl0ZXMgPSAwO1xuICBjb25zdCBmaW5pc2hlZElkID0gY2FsbElkO1xuICBjb25zdCBmaW5pc2hlZENvcmUgPSBjb3JlO1xuICBjYWxsSWQgPSAwO1xuICBlbmRpbmcgPSBzYXZlVHJhY2UoZmluaXNoZWRJZCwgZmluaXNoZWRDb3JlKS50aGVuKCgpID0+IHsgaWYgKGZpbmlzaGVkQ29yZSAmJiBmaW5pc2hlZElkKSBmaW5pc2hlZENvcmUuZGlzcG9zZShmaW5pc2hlZElkKTsgc2hvd1Rhc2tzKCk7IHN5bmNXYWtlVWkoKTsgfSk7XG4gIGlmICh3YWtlQXJtZWQpIHtcbiAgICBhdWRpby5zdG9wUGxheWJhY2soKTtcbiAgICB3YWtlQ2xpZW50LnJlc2V0KCk7XG4gICAgdm9pZCBhdWRpby5lbnN1cmVNaWMob25NaWMsIG1pY09wdGlvbnMoKSkuY2F0Y2goKGVycikgPT4ge1xuICAgICAgbG9nKFwiZXJyb3JcIiwgYHdha2UgbWljcm9waG9uZTogJHtlcnIubWVzc2FnZX1gLCBcImVyclwiKTtcbiAgICAgIHRvYXN0KGBXYWtlIG1pY3JvcGhvbmU6ICR7ZXJyLm1lc3NhZ2V9YCk7XG4gICAgICB2b2lkIGFybVdha2UoZmFsc2UpO1xuICAgIH0pO1xuICB9IGVsc2Uge1xuICAgIGF1ZGlvLnN0b3AoKTtcbiAgICByZWxlYXNlV2FrZUxvY2soKTtcbiAgfVxuICBmb3IgKGNvbnN0IHdzIG9mIHNvY2tldHMudmFsdWVzKCkpIHdzLmNsb3NlKCk7XG4gIHNvY2tldHMuY2xlYXIoKTtcbiAgZm9yIChjb25zdCByIG9mIHJ1bnMudmFsdWVzKCkpIHIuYWJvcnQuYWJvcnQoKTtcbiAgcnVucy5jbGVhcigpO1xuICBmb3IgKGNvbnN0IHIgb2YgcmVxdWVzdHMudmFsdWVzKCkpIHIuYWJvcnQoKTtcbiAgcmVxdWVzdHMuY2xlYXIoKTtcbiAgdGhpbmtpbmcgPSBmYWxzZTtcbiAgc2V0Q2FsbEJ1dHRvbihmYWxzZSk7XG4gIGZvciAoY29uc3QgaWQgb2YgW1wibWljXCIsIFwiaHVzaFwiXSkgJDxIVE1MQnV0dG9uRWxlbWVudD4oaWQpLmRpc2FibGVkID0gdHJ1ZTtcbiAgJChcInJpbmdcIikuc3R5bGUub3BhY2l0eSA9IFwiMFwiO1xuICAkKFwicmluZ1wiKS5zdHlsZS50cmFuc2Zvcm0gPSBcIlwiO1xuICAkKFwiY2FsbGJhclwiKS5oaWRkZW4gPSB0cnVlO1xuICAkKFwibWljd2FyblwiKS5oaWRkZW4gPSB0cnVlO1xuICBkb2N1bWVudC5ib2R5LmRhdGFzZXQuc3RhdGUgPSB3YWtlQXJtZWQgPyBcImFybWVkXCIgOiBcImlkbGVcIjtcbiAgZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QucmVtb3ZlKFwiaW4tc2Vzc2lvblwiKTtcbiAgc3luY1Jlc3VtZUJ1dHRvbnMoY2hhdC5sZW5ndGggPiAwKTtcbiAgdm9pZCBzaG93RWFybGllcigpO1xuICBzeW5jV2FrZVVpKCk7XG59XG5cbmZ1bmN0aW9uIHNldE11dGVkKHZhbHVlOiBib29sZWFuKSB7XG4gIGlmICghY2FsbElkIHx8IG11dGVkID09PSB2YWx1ZSkgcmV0dXJuO1xuICBtdXRlZCA9IHZhbHVlO1xuICBpZiAobXV0ZWQpIHtcbiAgICBmbHVzaERlZmVycmVkTWljKCk7XG4gICAgd2FrZUNsaWVudC5yZXNldCgpO1xuICB9XG4gICQoXCJtaWNcIikuY2xhc3NMaXN0LnRvZ2dsZShcIm11dGVkXCIsIG11dGVkKTtcbiAgcHVzaCh7IHR5cGU6IG11dGVkID8gXCJtdXRlXCIgOiBcInVubXV0ZVwiIH0pO1xuICBzaG93U3RhdHVzKCk7XG59XG5cbi8qKiBTZW5kcyB3aGF0IHRoZSB0cmFjZSBrZXB0IHNpbmNlIGxhc3QgdGltZSB0byB0aGUgZGV2IHNlcnZlciwgYXMgSlNPTiBsaW5lczogYSBoZWFkZXIsIHRoZW4gZXZlbnRzLiAqL1xuYXN5bmMgZnVuY3Rpb24gc2F2ZVRyYWNlKGlkID0gY2FsbElkLCB0YXJnZXRDb3JlID0gY29yZSkge1xuICBpZiAoIXRhcmdldENvcmUgfHwgIWlkIHx8ICFjaGVja2VkKFwidHJhY2VcIikpIHJldHVybjtcbiAgY29uc3Qga2VwdCA9IEpTT04ucGFyc2UodGFyZ2V0Q29yZS50cmFjZShpZCkpO1xuICBpZiAoIWtlcHQpIHJldHVybjtcbiAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG4gIGlmIChrZXB0LmNvbmZpZykgbGluZXMucHVzaChKU09OLnN0cmluZ2lmeSh7IHZlcnNpb246IGtlcHQudmVyc2lvbiwgY29uZmlnOiBrZXB0LmNvbmZpZywgc3RhcnQ6IGtlcHQuc3RhcnQgfSkpO1xuICBmb3IgKGNvbnN0IGUgb2Yga2VwdC5ldmVudHMpIGxpbmVzLnB1c2goSlNPTi5zdHJpbmdpZnkoZSkpO1xuICBpZiAobGluZXMubGVuZ3RoID09PSAwKSByZXR1cm47XG4gIGF3YWl0IGZldGNoKGAvdHJhY2VzP25hbWU9JHtlbmNvZGVVUklDb21wb25lbnQoY2FsbE5hbWUpfS5qc29ubGAsIHsgbWV0aG9kOiBcIlBPU1RcIiwgYm9keTogbGluZXMuam9pbihcIlxcblwiKSArIFwiXFxuXCIgfSkuY2F0Y2goKCkgPT4ge30pO1xuICAkKFwidHJhY2VuYW1lXCIpLnRleHRDb250ZW50ID0gYHRyYWNlICR7Y2FsbE5hbWV9Lmpzb25sYDtcbn1cblxuLy8gXCJTdG9wXCIgYW5kIFwiZ29vZGJ5ZVwiIGhlYXJkIGJ5IHRoZSBicm93c2VyJ3Mgb3duIHJlY29nbml6ZXI6IHF1aWNrZXIgdGhhbiB0aGUgbW9kZWwncyB0cmFuc2NyaXB0LFxuLy8gYW5kIGl0IHdvcmtzIHdoaWxlIHRoZSBtb2RlbCdzIHJlcGx5IHBsYXlzIGV2ZW4gd2hlbiB0aGUgbW9kZWwgaXNuJ3QgaGVhcmluZyB0aGUgbWljcm9waG9uZS5cblxuY2xhc3MgU3RvcFdvcmRzIHtcbiAgcHJpdmF0ZSByZWM6IGFueSA9IG51bGw7XG4gIHByaXZhdGUgb24gPSBmYWxzZTtcbiAgcHJpdmF0ZSBjb21tYW5kcyA9IHsgc3RvcDogW10gYXMgc3RyaW5nW10sIGhhbmdVcDogW10gYXMgc3RyaW5nW10sIGNhbmNlbEFsbDogW10gYXMgc3RyaW5nW10gfTtcblxuICBnZXQgc3VwcG9ydGVkKCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiBcIndlYmtpdFNwZWVjaFJlY29nbml0aW9uXCIgaW4gd2luZG93IHx8IFwiU3BlZWNoUmVjb2duaXRpb25cIiBpbiB3aW5kb3c7XG4gIH1cblxuICBzdGFydCgpIHtcbiAgICBpZiAoIWNoZWNrZWQoXCJzdG9wd29yZFwiKSB8fCAhdGhpcy5zdXBwb3J0ZWQgfHwgIWNvcmUpIHJldHVybjtcbiAgICB0aGlzLmNvbW1hbmRzID0gSlNPTi5wYXJzZShjb3JlLmRlZmF1bHRzKCkpLnZvaWNlQ29tbWFuZHM7XG4gICAgY29uc3QgUmVjb2duaXRpb24gPSAod2luZG93IGFzIGFueSkuU3BlZWNoUmVjb2duaXRpb24gPz8gKHdpbmRvdyBhcyBhbnkpLndlYmtpdFNwZWVjaFJlY29nbml0aW9uO1xuICAgIHRoaXMucmVjID0gbmV3IFJlY29nbml0aW9uKCk7XG4gICAgdGhpcy5yZWMuY29udGludW91cyA9IHRydWU7XG4gICAgdGhpcy5yZWMuaW50ZXJpbVJlc3VsdHMgPSB0cnVlO1xuICAgIHRoaXMucmVjLmxhbmcgPSBuYXZpZ2F0b3IubGFuZ3VhZ2UgfHwgXCJlbi1HQlwiO1xuICAgIHRoaXMucmVjLm9ucmVzdWx0ID0gKGU6IGFueSkgPT4ge1xuICAgICAgZm9yIChsZXQgaSA9IGUucmVzdWx0SW5kZXg7IGkgPCBlLnJlc3VsdHMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgY29uc3QgdGV4dCA9IGUucmVzdWx0c1tpXVswXS50cmFuc2NyaXB0IGFzIHN0cmluZztcbiAgICAgICAgY29uc3QgY29tbWFuZCA9IGNvbW1hbmRJbih0ZXh0LCB0aGlzLmNvbW1hbmRzLCBbXCJXb29kaG91c2VcIiwgXCJIZXJtZXNcIiwgXCJCZW50b1wiXSk7XG4gICAgICAgIGlmIChjb21tYW5kID09PSBcInN0b3BcIiAmJiBhdWRpby5xdWV1ZWQgPiAwLjA1KSB7XG4gICAgICAgICAgbG9nKFwib3V0XCIsIGBsb2NhbCBzdG9wIHdvcmQ6ICR7dGV4dH1gLCBcIm91dFwiKTtcbiAgICAgICAgICB0b2FzdChgSGVhcmQgXHUyMDFDJHt0ZXh0LnRyaW0oKX1cdTIwMUQ6IHN0b3BwZWRgKTtcbiAgICAgICAgICBwdXNoKHsgdHlwZTogXCJpbnRlcnJ1cHRcIiB9KTtcbiAgICAgICAgfSBlbHNlIGlmIChjb21tYW5kID09PSBcImNhbmNlbEFsbFwiICYmIGUucmVzdWx0c1tpXS5pc0ZpbmFsKSB7XG4gICAgICAgICAgbG9nKFwib3V0XCIsIGBsb2NhbCBjYW5jZWwtYWxsOiAke3RleHR9YCwgXCJvdXRcIik7XG4gICAgICAgICAgcHVzaCh7IHR5cGU6IFwiY2FuY2VsQWxsXCIgfSk7XG4gICAgICAgICAgcHVzaCh7IHR5cGU6IFwiaW50ZXJydXB0XCIgfSk7XG4gICAgICAgIH0gZWxzZSBpZiAoY29tbWFuZCA9PT0gXCJoYW5nVXBcIiAmJiBlLnJlc3VsdHNbaV0uaXNGaW5hbCkge1xuICAgICAgICAgIGxvZyhcIm91dFwiLCBgbG9jYWwgaGFuZy11cDogJHt0ZXh0fWAsIFwib3V0XCIpO1xuICAgICAgICAgIGhhbmdVcCgpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfTtcbiAgICB0aGlzLnJlYy5vbmVuZCA9ICgpID0+IHsgaWYgKHRoaXMub24pIHNldFRpbWVvdXQoKCkgPT4geyB0cnkgeyB0aGlzLnJlYz8uc3RhcnQoKTsgfSBjYXRjaCB7fSB9LCAyNTApOyB9O1xuICAgIHRoaXMucmVjLm9uZXJyb3IgPSAoZTogYW55KSA9PiB7IGlmIChlLmVycm9yID09PSBcIm5vdC1hbGxvd2VkXCIpIHRoaXMub24gPSBmYWxzZTsgfTtcbiAgICB0aGlzLm9uID0gdHJ1ZTtcbiAgICB0cnkgeyB0aGlzLnJlYy5zdGFydCgpOyB9IGNhdGNoIHt9XG4gIH1cblxuICBzdG9wKCkge1xuICAgIHRoaXMub24gPSBmYWxzZTtcbiAgICB0cnkgeyB0aGlzLnJlYz8uc3RvcCgpOyB9IGNhdGNoIHt9XG4gICAgdGhpcy5yZWMgPSBudWxsO1xuICB9XG59XG5jb25zdCBzdG9wV29yZHMgPSBuZXcgU3RvcFdvcmRzKCk7XG5cbi8vIExvY2FsIHdha2Ugd29yZCBsb29wIChMaXZlS2l0IFdha2VXb3JkIE9OTlggaW4gYSBXZWIgV29ya2VyKTogbGlzdGVucyBiZXR3ZWVuIGNhbGxzIHdoZW4gYXJtZWQsXG4vLyBhbmQgaW5zaWRlIGFuIGFjdGl2ZSBjYWxsIHdoZW5ldmVyIHRoZSBjb3JlIGFza3MgKGB3YWtld29yZDogb25gOiBkb3JtYW50IG9yIHdoaWxlU3BlYWtpbmcgXCJ3YWtlXCIpLlxuXG5hc3luYyBmdW5jdGlvbiBhY3F1aXJlV2FrZUxvY2soKSB7XG4gIGF3YWl0IHNjcmVlbldha2VMb2NrLmFjcXVpcmUoKCkgPT4gIWRvY3VtZW50LmhpZGRlbiAmJiAoY2FsbElkICE9PSAwIHx8IHdha2VBcm1lZCkpO1xufVxuXG5mdW5jdGlvbiByZWxlYXNlV2FrZUxvY2soKSB7XG4gIHNjcmVlbldha2VMb2NrLnJlbGVhc2UoKTtcbn1cblxuZnVuY3Rpb24gc2VsZWN0ZWRXYWtlTW9kZWwoKTogV2FrZU1vZGVsSW5mbyB8IG51bGwge1xuICBjb25zdCBtb2RlbHMgPSBzZXJ2ZXI/Lndha2VNb2RlbHMgPz8gW107XG4gIGlmIChtb2RlbHMubGVuZ3RoID09PSAwKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgcGljayA9ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwid2FrZS1tb2RlbFwiKS52YWx1ZTtcbiAgcmV0dXJuIG1vZGVscy5maW5kKChtKSA9PiBtLmlkID09PSBwaWNrKSA/PyBtb2RlbHMuZmluZCgobSkgPT4gbS5pZCA9PT0gXCJwZW5ueXdvcnRoXCIpID8/IG1vZGVsc1swXTtcbn1cblxuZnVuY3Rpb24gd2FrZVRocmVzaG9sZCgpOiBudW1iZXIge1xuICBjb25zdCBuID0gTnVtYmVyKCQ8SFRNTElucHV0RWxlbWVudD4oXCJ3YWtlLXRocmVzaG9sZFwiKS52YWx1ZSk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobikgPyBNYXRoLm1heCgwLjEsIE1hdGgubWluKDAuOTksIG4pKSA6IDAuNztcbn1cblxuZnVuY3Rpb24gc2hvdWxkRmVlZFdha2UoKTogYm9vbGVhbiB7XG4gIGlmICh3YWtlU3RhcnRpbmcgfHwgc3RhcnRpbmdDYWxsKSByZXR1cm4gZmFsc2U7XG4gIGlmIChjYWxsSWQgPT09IDApIHJldHVybiB3YWtlQXJtZWQ7XG4gIHJldHVybiBtZWRpdW0gPT09IFwidm9pY2VcIiAmJiBjb3JlV2FudHNXYWtlICYmICEobXV0ZWQgJiYgIWhvbGRpbmcpO1xufVxuXG4vKipcbiAqIFdoZXRoZXIgYSB3YWtlIGRldGVjdGlvbiByZXR1cm5pbmcgYXN5bmNocm9ub3VzbHkgZnJvbSB0aGUgd29ya2VyIHN0aWxsIGJlbG9uZ3MgdG8gdGhlIGFjdGl2ZVxuICogbGlzdGVuaW5nIHBlcmlvZC4gVW5saWtlIGBzaG91bGRGZWVkV2FrZSgpYCwgdGhpcyBzdGF5cyB0cnVlIGZvciBhbiBhY3RpdmUgdm9pY2UgY2FsbCBldmVuIGlmXG4gKiBgY29yZVdhbnRzV2FrZWAganVzdCBmbGlwcGVkIG9mZiBhcyBwbGF5YmFjayBlbmRlZCB3aGlsZSB0aGUgd29ya2VyIHdhcyBzY29yaW5nIHRoZSBsYXN0IGZyYW1lLlxuICovXG5mdW5jdGlvbiBjYW5BY2NlcHRXYWtlSGl0KCk6IGJvb2xlYW4ge1xuICBpZiAod2FrZVN0YXJ0aW5nIHx8IHN0YXJ0aW5nQ2FsbCkgcmV0dXJuIGZhbHNlO1xuICBpZiAoY2FsbElkID09PSAwKSByZXR1cm4gd2FrZUFybWVkICYmIHdha2VQZXJpb2RDYWxsSWQgPT09IDA7XG4gIHJldHVybiBtZWRpdW0gPT09IFwidm9pY2VcIiAmJiAhKG11dGVkICYmICFob2xkaW5nKSAmJiB3YWtlUGVyaW9kQ2FsbElkID09PSBjYWxsSWQ7XG59XG5cbmZ1bmN0aW9uIHJlbmRlcldha2VUZWxlbWV0cnkoKSB7XG4gIGNvbnN0IGFjdGl2ZSA9IChjYWxsSWQgPT09IDAgJiYgd2FrZUFybWVkKSB8fCAoY2FsbElkICE9PSAwICYmIG1lZGl1bSA9PT0gXCJ2b2ljZVwiICYmIGNvcmVXYW50c1dha2UpO1xuICBpZiAoIWFjdGl2ZSkgeyAkKFwiaGVhcmRcIikudGV4dENvbnRlbnQgPSBcIlwiOyByZXR1cm47IH1cbiAgY29uc3QgbGFiZWwgPSBzZWxlY3RlZFdha2VNb2RlbCgpPy5sYWJlbCA/PyBcIndha2Ugd29yZFwiO1xuICBpZiAod2FrZUxvYWRpbmcpIHsgJChcImhlYXJkXCIpLnRleHRDb250ZW50ID0gYExvYWRpbmcgd2FrZSB3b3JkIFx1MjAxQyR7bGFiZWx9XHUyMDFEXHUyMDI2YDsgcmV0dXJuOyB9XG4gIGlmIChjYWxsSWQgPT09IDAgJiYgYXVkaW8uYXVkaW9TdXNwZW5kZWQpIHsgJChcImhlYXJkXCIpLnRleHRDb250ZW50ID0gYEF1ZGlvIHBhdXNlZCBieSBicm93c2VyIFx1MDBCNyB0YXAgb3IgcHJlc3MgYSBrZXkgdG8gcmVzdW1lIFx1MjAxQyR7bGFiZWx9XHUyMDFEYDsgcmV0dXJuOyB9XG4gIGlmICghd2FrZUxhc3RUZWwpIHsgJChcImhlYXJkXCIpLnRleHRDb250ZW50ID0gYFdha2UgXHUyMDFDJHtsYWJlbH1cdTIwMUQgcmVhZHkgKHRocmVzaG9sZCAke3dha2VUaHJlc2hvbGQoKS50b0ZpeGVkKDIpfSlgOyByZXR1cm47IH1cbiAgY29uc3Qgc3RhdGUgPSB3YWtlTGFzdFRlbC5nYXRlT3BlbiA/IGBzY29yaW5nICR7d2FrZUxhc3RUZWwuc2NvcmUudG9GaXhlZCgyKX1gIDogXCJxdWlldFwiO1xuICBjb25zdCBzcGVlZCA9IHdha2VMYXN0VGVsLmluZmVyTXMgPiAwID8gYCBcdTAwQjcgJHt3YWtlTGFzdFRlbC5pbmZlck1zLnRvRml4ZWQoMSl9IG1zYCA6IFwiXCI7XG4gICQoXCJoZWFyZFwiKS50ZXh0Q29udGVudCA9IGBXYWtlIFx1MjAxQyR7bGFiZWx9XHUyMDFEIFx1MDBCNyAke3N0YXRlfSBcdTAwQjcgcGVhayAke3dha2VMYXN0VGVsLnBlYWsudG9GaXhlZCgyKX0ke3NwZWVkfWA7XG59XG5cbmZ1bmN0aW9uIHN5bmNXYWtlVWkoKSB7XG4gIGNvbnN0IG1vZGVsID0gc2VsZWN0ZWRXYWtlTW9kZWwoKTtcbiAgY29uc3QgaGFzTW9kZWxzID0gbW9kZWwgIT0gbnVsbDtcbiAgY29uc3QgbGFiZWwgPSBtb2RlbD8ubGFiZWwgPz8gXCJ3YWtlIHdvcmRcIjtcbiAgY29uc3QgYnRuID0gJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJ3YWtlYnRuXCIpO1xuICBidG4uaGlkZGVuID0gIWhhc01vZGVscztcbiAgYnRuLmNsYXNzTGlzdC50b2dnbGUoXCJvblwiLCB3YWtlQXJtZWQpO1xuICBidG4uY2xhc3NMaXN0LnRvZ2dsZShcImxvYWRpbmdcIiwgd2FrZUxvYWRpbmcgJiYgKHdha2VBcm1lZCB8fCBjb3JlV2FudHNXYWtlKSk7XG4gIGJ0bi5zZXRBdHRyaWJ1dGUoXCJhcmlhLXByZXNzZWRcIiwgU3RyaW5nKHdha2VBcm1lZCkpO1xuICBidG4udGl0bGUgPSB3YWtlQXJtZWQgPyBgU3RvcCB3YWtlIHdvcmQgXHUyMDFDJHtsYWJlbH1cdTIwMUQgKFcpYCA6IGBMaXN0ZW4gZm9yIFx1MjAxQyR7bGFiZWx9XHUyMDFEIChXKWA7XG4gIGNvbnN0IGhlcm8gPSAkPEhUTUxCdXR0b25FbGVtZW50PihcImhlcm8td2FrZVwiKTtcbiAgaGVyby5oaWRkZW4gPSAhaGFzTW9kZWxzO1xuICBoZXJvLmNsYXNzTGlzdC50b2dnbGUoXCJvblwiLCB3YWtlQXJtZWQpO1xuICBoZXJvLnRleHRDb250ZW50ID0gd2FrZUFybWVkXG4gICAgPyAod2FrZUxvYWRpbmcgPyBgTG9hZGluZyBcdTIwMUMke2xhYmVsfVx1MjAxRFx1MjAyNmAgOiBhdWRpby5hdWRpb1N1c3BlbmRlZCA/IGBBY3RpdmF0ZSBcdTIwMUMke2xhYmVsfVx1MjAxRGAgOiBgTGlzdGVuaW5nIGZvciBcdTIwMUMke2xhYmVsfVx1MjAxRGApXG4gICAgOiBgTGlzdGVuIGZvciBcdTIwMUMke2xhYmVsfVx1MjAxRGA7XG4gICQ8SFRNTElucHV0RWxlbWVudD4oXCJ3YWtlLWVuYWJsZWRcIikuY2hlY2tlZCA9IHdha2VBcm1lZDtcbiAgcmVuZGVyV2FrZVRlbGVtZXRyeSgpO1xuICBzaG93U3RhdHVzKCk7XG59XG5cbmZ1bmN0aW9uIHN5bmNTaWduYWxpbmdVaSgpIHtcbiAgY29uc3Qgb3YgPSBkZXZlbG9wZXJPdmVycmlkZXMoKTtcbiAgY29uc3Qgc2lnbmFsaW5nRWwgPSAkPEhUTUxTZWxlY3RFbGVtZW50PihcInNpZ25hbGluZ1wiKTtcbiAgY29uc3Qgc2lnbmFsaW5nID0gc2lnbmFsaW5nRWwudmFsdWU7XG4gIGNvbnN0IG5vbldlYiA9IG92Lm5vbldlYlBsYXRmb3JtICE9IG51bGw7XG4gIHNpZ25hbGluZ0VsLmRpc2FibGVkID0gbm9uV2ViIHx8IG92Lmhhc0F0dGVudGlvbjtcbiAgY29uc3Qgd2luZG93Q29udHJvbHMgPSAhbm9uV2ViICYmICFvdi5oYXNBdHRlbnRpb24gJiYgKHNpZ25hbGluZyA9PT0gXCJ3aW5kb3dcIiB8fCBzaWduYWxpbmcgPT09IFwiZWNob1wiKTtcbiAgZm9yIChjb25zdCBpZCBvZiBbXCJhdHRuLWFmdGVyLXdha2VcIiwgXCJhdHRuLXdpbmRvd1wiLCBcImF0dG4tYWZ0ZXItcXVlc3Rpb25cIl0pIHtcbiAgICAkPEhUTUxJbnB1dEVsZW1lbnQ+KGlkKS5kaXNhYmxlZCA9ICF3aW5kb3dDb250cm9scztcbiAgfVxuICAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwiaGFuZ3VwLWFmdGVyXCIpLmRpc2FibGVkID0gbm9uV2ViIHx8IG92Lmhhc0hhbmdVcDtcbiAgY29uc3QgYmFyZ2UgPSAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwid2FrZS1iYXJnZVwiKTtcbiAgaWYgKG5vbldlYiB8fCBvdi5oYXNNaWNXaGlsZVNwZWFraW5nKSB7XG4gICAgYmFyZ2UuZGlzYWJsZWQgPSB0cnVlO1xuICB9IGVsc2UgaWYgKHNpZ25hbGluZyA9PT0gXCJlY2hvXCIpIHtcbiAgICBiYXJnZS5jaGVja2VkID0gdHJ1ZTtcbiAgICBiYXJnZS5kaXNhYmxlZCA9IHRydWU7XG4gIH0gZWxzZSB7XG4gICAgYmFyZ2UuZGlzYWJsZWQgPSBmYWxzZTtcbiAgICBiYXJnZS5jaGVja2VkID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS53YWtlLWJhcmdlXCIpID09PSBcIjFcIjtcbiAgfVxuICBjb25zdCBvdmVycmlkZGVuOiBzdHJpbmdbXSA9IFtdO1xuICBpZiAob3YuaGFzQXR0ZW50aW9uKSBvdmVycmlkZGVuLnB1c2goXCJhdHRlbnRpb25cIik7XG4gIGlmIChvdi5oYXNIYW5nVXApIG92ZXJyaWRkZW4ucHVzaChcImhhbmdVcEFmdGVyXCIpO1xuICBpZiAob3YuaGFzTWljV2hpbGVTcGVha2luZykgb3ZlcnJpZGRlbi5wdXNoKFwibWljLndoaWxlU3BlYWtpbmdcIik7XG4gIGNvbnN0IGhhc01vZGVscyA9IChzZXJ2ZXI/Lndha2VNb2RlbHM/Lmxlbmd0aCA/PyAwKSA+IDA7XG4gICQoXCJzaWduYWxpbmctaGVscFwiKS50ZXh0Q29udGVudCA9IG5vbldlYlxuICAgID8gYERldmVsb3BlciBwcmVzZXQgKCR7b3Yubm9uV2ViUGxhdGZvcm19KSBjb250cm9scyBzaWduYWxpbmcuYFxuICAgIDogb3ZlcnJpZGRlbi5sZW5ndGggPiAwXG4gICAgICA/IGBEZXZlbG9wZXIgY29uZmlnIHNldHMgJHtvdmVycmlkZGVuLmpvaW4oXCIsIFwiKX0uYFxuICAgICAgOiAhaGFzTW9kZWxzICYmIHNpZ25hbGluZyAhPT0gXCJvcGVuXCJcbiAgICAgICAgPyBcIk5vIHdha2UgbW9kZWxzIG9uIHNlcnZlcjogdXNlIHRoZSBXYWtlIGJ1dHRvbiB3aGVuIGRvcm1hbnQuXCJcbiAgICAgICAgOiBcIkFwcGxpZWQgb24gdGhlIG5leHQgY2FsbCB1bmxlc3Mgb3ZlcnJpZGRlbiBpbiBEZXZlbG9wZXIgSlNPTi5cIjtcbn1cblxuY29uc3Qgd2FrZUNsaWVudCA9IG5ldyBXYWtlQ2xpZW50KHtcbiAgb25SZWFkeShtb2RlbElkLCB3YXJtdXBNcykge1xuICAgIHdha2VMb2FkaW5nID0gZmFsc2U7XG4gICAgbG9nKFwib3V0XCIsIGB3YWtlIHdvcmQgcmVhZHk6ICR7bW9kZWxJZH0ke3dhcm11cE1zID4gMCA/IGAgKCR7d2FybXVwTXN9IG1zKWAgOiBcIlwifWAsIFwib3V0XCIpO1xuICAgIHN5bmNXYWtlVWkoKTtcbiAgfSxcbiAgb25EZXRlY3RlZChoaXQpIHtcbiAgICBvbldha2VEZXRlY3RlZChoaXQpO1xuICB9LFxuICBvblRlbGVtZXRyeSh0ZWwpIHtcbiAgICB3YWtlTGFzdFRlbCA9IHRlbDtcbiAgICByZW5kZXJXYWtlVGVsZW1ldHJ5KCk7XG4gIH0sXG4gIG9uU3VwcHJlc3NlZFNldHRsZWQoKSB7XG4gICAgZmx1c2hEZWZlcnJlZE1pYygpO1xuICB9LFxuICBvbkVycm9yKG1lc3NhZ2UpIHtcbiAgICB3YWtlTG9hZGluZyA9IGZhbHNlO1xuICAgIGZsdXNoRGVmZXJyZWRNaWMoKTtcbiAgICBsb2coXCJlcnJvclwiLCBgd2FrZSB3b3JkOiAke21lc3NhZ2V9YCwgXCJlcnJcIik7XG4gICAgdG9hc3QoYFdha2Ugd29yZCBlcnJvcjogJHttZXNzYWdlfWApO1xuICAgIGlmICh3YWtlQXJtZWQpIHZvaWQgYXJtV2FrZShmYWxzZSk7XG4gICAgZWxzZSBzeW5jV2FrZVVpKCk7XG4gIH0sXG59KTtcblxuYXN5bmMgZnVuY3Rpb24gYXJtV2FrZShvbjogYm9vbGVhbiwgcGVyc2lzdCA9IHRydWUpIHtcbiAgY29uc3QgbW9kZWwgPSBzZWxlY3RlZFdha2VNb2RlbCgpO1xuICBpZiAob24gJiYgIW1vZGVsKSB7XG4gICAgdG9hc3QoXCJObyB3YWtlIHdvcmQgbW9kZWxzIGZvdW5kIG9uIHRoZSBzZXJ2ZXJcIik7XG4gICAgJDxIVE1MSW5wdXRFbGVtZW50PihcIndha2UtZW5hYmxlZFwiKS5jaGVja2VkID0gZmFsc2U7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IGdlbiA9ICsrYXJtR2VuO1xuICB3YWtlQXJtZWQgPSBvbjtcbiAgaWYgKHBlcnNpc3QpIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2Uud2FrZS1lbmFibGVkXCIsIG9uID8gXCIxXCIgOiBcIjBcIik7XG4gIGlmIChvbiAmJiBtb2RlbCkge1xuICAgIHdha2VMYXN0VGVsID0gbnVsbDtcbiAgICBpZiAoIXdha2VDbGllbnQucmVhZHkgfHwgd2FrZUNsaWVudC5tb2RlbElkICE9PSBtb2RlbC5pZCkgd2FrZUxvYWRpbmcgPSB0cnVlO1xuICAgIHdha2VDbGllbnQubG9hZChtb2RlbC5pZCwgd2FrZVRocmVzaG9sZCgpKTtcbiAgICBpZiAoIWNhbGxJZCkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgYXVkaW8uZW5zdXJlTWljKG9uTWljLCBtaWNPcHRpb25zKCkpO1xuICAgICAgICBpZiAoZ2VuICE9PSBhcm1HZW4gfHwgIXdha2VBcm1lZCkgcmV0dXJuO1xuICAgICAgICB3YWtlUGVyaW9kQ2FsbElkID0gMDtcbiAgICAgICAgd2FrZUNsaWVudC5yZXNldCgpO1xuICAgICAgICBhd2FpdCBhY3F1aXJlV2FrZUxvY2soKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBpZiAoZ2VuICE9PSBhcm1HZW4pIHJldHVybjtcbiAgICAgICAgd2FrZUFybWVkID0gZmFsc2U7XG4gICAgICAgIHdha2VMb2FkaW5nID0gZmFsc2U7XG4gICAgICAgIGlmICghY2FsbElkKSB7XG4gICAgICAgICAgYXVkaW8uc3RvcE1pYygpO1xuICAgICAgICAgIHJlbGVhc2VXYWtlTG9jaygpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChwZXJzaXN0KSBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLndha2UtZW5hYmxlZFwiLCBcIjBcIik7XG4gICAgICAgIHRvYXN0KGBNaWNyb3Bob25lOiAkeyhlcnIgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgICAgIGxvZyhcImVycm9yXCIsIGB3YWtlIG1pY3JvcGhvbmU6ICR7KGVyciBhcyBFcnJvcikubWVzc2FnZX1gLCBcImVyclwiKTtcbiAgICAgIH1cbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgd2FrZUxvYWRpbmcgPSBmYWxzZTtcbiAgICB3YWtlTGFzdFRlbCA9IG51bGw7XG4gICAgaWYgKCFjYWxsSWQpIHtcbiAgICAgIHdha2VQZXJpb2RDYWxsSWQgPSBudWxsO1xuICAgICAgYXVkaW8uc3RvcE1pYygpO1xuICAgICAgcmVsZWFzZVdha2VMb2NrKCk7XG4gICAgICB3YWtlQ2xpZW50LnJlc2V0KCk7XG4gICAgfVxuICB9XG4gIHN5bmNXYWtlVWkoKTtcbn1cblxuZnVuY3Rpb24gZW5zdXJlQ29yZVdha2Uob246IGJvb2xlYW4pIHtcbiAgY29yZVdhbnRzV2FrZSA9IG9uO1xuICBjb25zdCBtb2RlbCA9IHNlbGVjdGVkV2FrZU1vZGVsKCk7XG4gIGlmIChvbikge1xuICAgIGlmICghbW9kZWwpIHtcbiAgICAgIGxvZyhcIndhcm5cIiwgXCJjb3JlIGFza2VkIGZvciB3YWtlIHdvcmQsIGJ1dCBubyBtb2RlbHMgYXJlIGF2YWlsYWJsZVwiLCBcIndhcm5cIik7XG4gICAgfSBlbHNlIHtcbiAgICAgIHdha2VMYXN0VGVsID0gbnVsbDtcbiAgICAgIGNvbnN0IHByZXNlcnZlSW5GbGlnaHQgPSB3YWtlUGVyaW9kQ2FsbElkID09PSBjYWxsSWQgJiYgd2FrZUNsaWVudC5tb2RlbElkID09PSBtb2RlbC5pZCAmJiB3YWtlQ2xpZW50LnN1cHByZXNzZWRJbkZsaWdodDtcbiAgICAgIHdha2VQZXJpb2RDYWxsSWQgPSBjYWxsSWQ7XG4gICAgICBpZiAoIXdha2VDbGllbnQucmVhZHkgfHwgd2FrZUNsaWVudC5tb2RlbElkICE9PSBtb2RlbC5pZCkgd2FrZUxvYWRpbmcgPSB0cnVlO1xuICAgICAgd2FrZUNsaWVudC5sb2FkKG1vZGVsLmlkLCB3YWtlVGhyZXNob2xkKCkpO1xuICAgICAgaWYgKCFwcmVzZXJ2ZUluRmxpZ2h0KSB3YWtlQ2xpZW50LnJlc2V0KCk7XG4gICAgICBsb2coXCJvdXRcIiwgYHdha2Ugd29yZCBsaXN0ZW5pbmcgKCR7bW9kZWwubGFiZWx9KWAsIFwib3V0XCIpO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICBpZiAoIXdha2VBcm1lZCkgd2FrZUxhc3RUZWwgPSBudWxsO1xuICAgIGxvZyhcIm91dFwiLCBcIndha2Ugd29yZCBvZmZcIiwgXCJvdXRcIik7XG4gIH1cbiAgc3luY1dha2VVaSgpO1xufVxuXG5mdW5jdGlvbiBvbldha2VEZXRlY3RlZChoaXQ6IFdha2VEZXRlY3Rpb25FdmVudCkge1xuICBpZiAoIWNhbkFjY2VwdFdha2VIaXQoKSkgcmV0dXJuO1xuICBjb25zdCBsYWJlbCA9IHNlbGVjdGVkV2FrZU1vZGVsKCk/LmxhYmVsID8/IFwid2FrZSB3b3JkXCI7XG4gIGxvZyhcIm91dFwiLCBgd2FrZSBkZXRlY3RlZCBcdTIwMUMke2xhYmVsfVx1MjAxRCAoc2NvcmUgJHtoaXQuc2NvcmUudG9GaXhlZCgyKX0sICR7aGl0LmluZmVyTXMudG9GaXhlZCgxKX0gbXMpYCwgXCJvdXRcIik7XG4gIGlmIChjaGVja2VkKFwid2FrZS1jdWVcIikpIHZvaWQgYXVkaW8ub3BlbigpLnRoZW4oKCkgPT4gYXVkaW8uY3VlKFdBS0VfVE9ORSkpLmNhdGNoKCgpID0+IHt9KTtcbiAgdG9hc3QoYEhlYXJkIFx1MjAxQyR7bGFiZWx9XHUyMDFEICgke2hpdC5zY29yZS50b0ZpeGVkKDIpfSlgKTtcbiAgaWYgKGNhbGxJZCAhPT0gMCkge1xuICAgIGNvbnN0IGRlZmVycmVkID0gd2FrZUdhdGUudGFrZURlZmVycmVkKCk7XG4gICAgcHVzaCh7IHR5cGU6IFwid2FrZVwiIH0pO1xuICAgIC8vIFJlcGxheSBzdXBwcmVzc2VkIGNodW5rcyBhbmQgYW55IGRlZmVycmVkIHBvc3QtcGxheWJhY2sgY2h1bmtzIGluIGV4YWN0IGNocm9ub2xvZ2ljYWwgb3JkZXIsXG4gICAgLy8gc2tpcHBpbmcgYW55dGhpbmcgb2xkZXIgdGhhbiBhbHJlYWR5LWZvcndhcmRlZCBnYXAgYXVkaW8uXG4gICAgZm9yIChjb25zdCBpdGVtIG9mIHdha2VHYXRlLnBsYW5XYWtlUmVwbGF5KGhpdCwgZGVmZXJyZWQsIGJ5dGVzVG9CYXNlNjQpKSB7XG4gICAgICBpZiAoIWNhbGxJZCkgYnJlYWs7XG4gICAgICBjb3VudHMubWljKys7XG4gICAgICBpZiAoaXRlbS50ICE9PSB1bmRlZmluZWQpIHB1c2goeyB0eXBlOiBcIm1pY1wiLCBwY206IGl0ZW0ucGNtIH0sIGl0ZW0udCk7XG4gICAgICBlbHNlIHB1c2goeyB0eXBlOiBcIm1pY1wiLCBwY206IGl0ZW0ucGNtIH0pO1xuICAgIH1cbiAgICByZXR1cm47XG4gIH1cbiAgd2FrZVN0YXJ0aW5nID0gdHJ1ZTtcbiAgb3BlbmluZ0NodW5rcyA9IFtdO1xuICBvcGVuaW5nQnl0ZXMgPSAwO1xuICBmb3IgKGNvbnN0IGNodW5rIG9mIGhpdC50cmFpbGluZykge1xuICAgIGlmIChjaHVuay5ieXRlcy5ieXRlTGVuZ3RoID09PSAwKSBjb250aW51ZTtcbiAgICBvcGVuaW5nQ2h1bmtzLnB1c2goY2h1bmsuYnl0ZXMpO1xuICAgIG9wZW5pbmdCeXRlcyArPSBjaHVuay5ieXRlcy5ieXRlTGVuZ3RoO1xuICAgIHdoaWxlIChvcGVuaW5nQnl0ZXMgPiBPUEVOSU5HX01BWF9CWVRFUyAmJiBvcGVuaW5nQ2h1bmtzLmxlbmd0aCA+IDEpIHtcbiAgICAgIG9wZW5pbmdCeXRlcyAtPSBvcGVuaW5nQ2h1bmtzLnNoaWZ0KCkhLmJ5dGVMZW5ndGg7XG4gICAgfVxuICB9XG4gIHZvaWQgc3RhcnQoY2hhdC5sZW5ndGggPiAwKS50aGVuKChzdGFydGVkKSA9PiB7XG4gICAgaWYgKCFzdGFydGVkICYmIHdha2VTdGFydGluZykge1xuICAgICAgd2FrZVN0YXJ0aW5nID0gZmFsc2U7XG4gICAgICBvcGVuaW5nQ2h1bmtzID0gW107XG4gICAgICBvcGVuaW5nQnl0ZXMgPSAwO1xuICAgICAgc3luY1dha2VVaSgpO1xuICAgIH1cbiAgfSkuY2F0Y2goKGVycikgPT4ge1xuICAgIHdha2VTdGFydGluZyA9IGZhbHNlO1xuICAgIG9wZW5pbmdDaHVua3MgPSBbXTtcbiAgICBvcGVuaW5nQnl0ZXMgPSAwO1xuICAgIHRvYXN0KChlcnIgYXMgRXJyb3IpLm1lc3NhZ2UpO1xuICAgIGxvZyhcImVycm9yXCIsIChlcnIgYXMgRXJyb3IpLm1lc3NhZ2UsIFwiZXJyXCIpO1xuICAgIHN5bmNXYWtlVWkoKTtcbiAgfSk7XG59XG5cbi8vIFdpcmluZy5cblxuZnVuY3Rpb24gc2V0dGluZ3NGcm9tU3RvcmFnZSgpIHtcbiAgZm9yIChjb25zdCBpZCBvZiBbXCJhZWNcIiwgXCJzdG9wd29yZFwiLCBcInB0dFwiLCBcImNhcHRpb25zXCIsIFwiY29kaW5nXCIsIFwiZmFrZWhlcm1lc1wiLCBcInRyYWNlXCIsIFwid2FrZS1jdWVcIiwgXCJ3YWtlLWJhcmdlXCJdKSB7XG4gICAgY29uc3QgdiA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKGB2b2ljZS4ke2lkfWApO1xuICAgIGlmICh2ICE9IG51bGwpICQ8SFRNTElucHV0RWxlbWVudD4oaWQpLmNoZWNrZWQgPSB2ID09PSBcIjFcIjtcbiAgICAkKGlkKS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHtcbiAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKGB2b2ljZS4ke2lkfWAsIGNoZWNrZWQoaWQpID8gXCIxXCIgOiBcIjBcIik7XG4gICAgICBpZiAoaWQgPT09IFwiYWVjXCIgJiYgd2FrZUFybWVkICYmICFjYWxsSWQpIHtcbiAgICAgICAgdm9pZCBhdWRpby5zdGFydE1pYyhvbk1pYywgbWljT3B0aW9ucygpKS5jYXRjaCgoZXJyKSA9PiB0b2FzdChgTWljcm9waG9uZTogJHtlcnIubWVzc2FnZX1gKSk7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cbiAgZm9yIChjb25zdCBbaWQsIGtleV0gb2YgW1xuICAgIFtcImZha2VkZWxheVwiLCBcInZvaWNlLmZha2VkZWxheVwiXSxcbiAgICBbXCJhdHRuLWFmdGVyLXdha2VcIiwgXCJ2b2ljZS5hdHRuLWFmdGVyLXdha2VcIl0sXG4gICAgW1wiYXR0bi13aW5kb3dcIiwgXCJ2b2ljZS5hdHRuLXdpbmRvd1wiXSxcbiAgICBbXCJhdHRuLWFmdGVyLXF1ZXN0aW9uXCIsIFwidm9pY2UuYXR0bi1hZnRlci1xdWVzdGlvblwiXSxcbiAgICBbXCJoYW5ndXAtYWZ0ZXJcIiwgXCJ2b2ljZS5oYW5ndXAtYWZ0ZXJcIl0sXG4gIF0gYXMgY29uc3QpIHtcbiAgICBjb25zdCBzYXZlZCA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKGtleSk7XG4gICAgaWYgKHNhdmVkICE9IG51bGwpICQ8SFRNTElucHV0RWxlbWVudD4oaWQpLnZhbHVlID0gc2F2ZWQ7XG4gICAgJChpZCkuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiB7XG4gICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShrZXksICQ8SFRNTElucHV0RWxlbWVudD4oaWQpLnZhbHVlKTtcbiAgICAgIGlmIChpZCA9PT0gXCJoYW5ndXAtYWZ0ZXJcIikgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS5oYW5ndXAtY3VzdG9tXCIsIFwiMVwiKTtcbiAgICB9KTtcbiAgfVxuICBjb25zdCB0aHJlc2ggPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLndha2UtdGhyZXNob2xkXCIpO1xuICBpZiAodGhyZXNoICE9IG51bGwpICQ8SFRNTElucHV0RWxlbWVudD4oXCJ3YWtlLXRocmVzaG9sZFwiKS52YWx1ZSA9IHRocmVzaDtcbiAgJChcIndha2UtdGhyZXNob2xkLXZhbFwiKS50ZXh0Q29udGVudCA9IHdha2VUaHJlc2hvbGQoKS50b0ZpeGVkKDIpO1xuICAkKFwid2FrZS10aHJlc2hvbGRcIikuYWRkRXZlbnRMaXN0ZW5lcihcImlucHV0XCIsICgpID0+IHtcbiAgICBjb25zdCB2ID0gd2FrZVRocmVzaG9sZCgpO1xuICAgICQoXCJ3YWtlLXRocmVzaG9sZC12YWxcIikudGV4dENvbnRlbnQgPSB2LnRvRml4ZWQoMik7XG4gICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS53YWtlLXRocmVzaG9sZFwiLCB2LnRvRml4ZWQoMikpO1xuICAgIHdha2VDbGllbnQuc2V0VGhyZXNob2xkKHYpO1xuICAgIHJlbmRlcldha2VUZWxlbWV0cnkoKTtcbiAgfSk7XG4gIGNvbnN0IHNpZ25hbGluZyA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2Uuc2lnbmFsaW5nXCIpO1xuICBpZiAoc2lnbmFsaW5nKSAkPEhUTUxTZWxlY3RFbGVtZW50PihcInNpZ25hbGluZ1wiKS52YWx1ZSA9IHNpZ25hbGluZztcbiAgJChcInNpZ25hbGluZ1wiKS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHtcbiAgICBjb25zdCBtb2RlID0gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJzaWduYWxpbmdcIikudmFsdWU7XG4gICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS5zaWduYWxpbmdcIiwgbW9kZSk7XG4gICAgaWYgKGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UuaGFuZ3VwLWN1c3RvbVwiKSAhPT0gXCIxXCIpIHtcbiAgICAgIGNvbnN0IGRlZiA9IG1vZGUgPT09IFwiZWNob1wiID8gXCIxNVwiIDogXCIzMDBcIjtcbiAgICAgICQ8SFRNTElucHV0RWxlbWVudD4oXCJoYW5ndXAtYWZ0ZXJcIikudmFsdWUgPSBkZWY7XG4gICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLmhhbmd1cC1hZnRlclwiLCBkZWYpO1xuICAgIH1cbiAgICBzeW5jU2lnbmFsaW5nVWkoKTtcbiAgfSk7XG4gICQoXCJ3YWtlLWVuYWJsZWRcIikuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiB2b2lkIGFybVdha2UoY2hlY2tlZChcIndha2UtZW5hYmxlZFwiKSkpO1xuICAkKFwid2FrZS1tb2RlbFwiKS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHtcbiAgICBjb25zdCBpZCA9ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwid2FrZS1tb2RlbFwiKS52YWx1ZTtcbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLndha2UtbW9kZWxcIiwgaWQpO1xuICAgIGlmICh3YWtlQXJtZWQgfHwgY29yZVdhbnRzV2FrZSkge1xuICAgICAgd2FrZUxvYWRpbmcgPSB0cnVlO1xuICAgICAgd2FrZUxhc3RUZWwgPSBudWxsO1xuICAgICAgd2FrZUNsaWVudC5sb2FkKGlkLCB3YWtlVGhyZXNob2xkKCkpO1xuICAgICAgc3luY1dha2VVaSgpO1xuICAgIH0gZWxzZSB7XG4gICAgICBzeW5jV2FrZVVpKCk7XG4gICAgfVxuICB9KTtcbiAgY29uc3Qgdm9pY2UgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLnZvaWNlXCIpO1xuICBpZiAodm9pY2UpICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwidm9pY2VcIikudmFsdWUgPSB2b2ljZTtcbiAgJChcInZvaWNlXCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4gbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS52b2ljZVwiLCAkPEhUTUxTZWxlY3RFbGVtZW50PihcInZvaWNlXCIpLnZhbHVlKSk7XG4gIGNvbnN0IG1vZGUgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLm1vZGVcIik7XG4gIGlmIChtb2RlKSAkPEhUTUxTZWxlY3RFbGVtZW50PihcIm1vZGVcIikudmFsdWUgPSBtb2RlO1xuICAkKFwibW9kZVwiKS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHtcbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLm1vZGVcIiwgJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJtb2RlXCIpLnZhbHVlKTtcbiAgICBzeW5jQ29tcG9zZXIoKTtcbiAgfSk7XG4gIGNvbnN0IHRoZW1lID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS50aGVtZVwiKSA/PyBcInN5c3RlbVwiO1xuICBhcHBseVRoZW1lKHRoZW1lKTtcbiAgZm9yIChjb25zdCBidG4gb2YgQXJyYXkuZnJvbShkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxCdXR0b25FbGVtZW50PihcIiN0aGVtZS1waWNrZXIgYnV0dG9uXCIpKSkge1xuICAgIGJ0bi5vbmNsaWNrID0gKCkgPT4ge1xuICAgICAgY29uc3QgY2hvaWNlID0gYnRuLmRhdGFzZXQudGhlbWUgPz8gXCJzeXN0ZW1cIjtcbiAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2UudGhlbWVcIiwgY2hvaWNlKTtcbiAgICAgIGFwcGx5VGhlbWUoY2hvaWNlKTtcbiAgICB9O1xuICB9XG4gIGNvbnN0IGRlbnNpdHkgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLmRlbnNpdHlcIik7XG4gIGFwcGx5RGVuc2l0eShkZW5zaXR5KTtcbiAgZm9yIChjb25zdCBidG4gb2YgQXJyYXkuZnJvbShkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxCdXR0b25FbGVtZW50PihcIiNkZW5zaXR5LXBpY2tlciBidXR0b25cIikpKSB7XG4gICAgYnRuLm9uY2xpY2sgPSAoKSA9PiB7XG4gICAgICBjb25zdCBjaG9pY2UgPSBub3JtYWxpemVEZW5zaXR5KGJ0bi5kYXRhc2V0LmRlbnNpdHkpO1xuICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS5kZW5zaXR5XCIsIGNob2ljZSk7XG4gICAgICBhcHBseURlbnNpdHkoY2hvaWNlKTtcbiAgICB9O1xuICB9XG4gIG1hdGNoTWVkaWEoXCIocHJlZmVycy1jb2xvci1zY2hlbWU6IGRhcmspXCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4ge1xuICAgIGlmICgobG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS50aGVtZVwiKSA/PyBcInN5c3RlbVwiKSA9PT0gXCJzeXN0ZW1cIikgYXBwbHlUaGVtZShcInN5c3RlbVwiKTtcbiAgfSk7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJ2aXNpYmlsaXR5Y2hhbmdlXCIsICgpID0+IHtcbiAgICBpZiAoIWRvY3VtZW50LmhpZGRlbiAmJiAoY2FsbElkIHx8IHdha2VBcm1lZCkpIHZvaWQgYWNxdWlyZVdha2VMb2NrKCk7XG4gIH0pO1xuICBhdWRpby5vbkF1ZGlvU3RhdGVDaGFuZ2UoKCkgPT4gc3luY1dha2VVaSgpKTtcbiAgY29uc3QgcmVzdW1lSWZTdXNwZW5kZWQgPSAoKSA9PiB7XG4gICAgaWYgKGF1ZGlvLmF1ZGlvU3VzcGVuZGVkICYmICh3YWtlQXJtZWQgfHwgY2FsbElkKSkge1xuICAgICAgdm9pZCBhdWRpby5yZXN1bWVBdWRpbygpLnRoZW4oKCkgPT4gc3luY1dha2VVaSgpKTtcbiAgICB9XG4gIH07XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJwb2ludGVyZG93blwiLCByZXN1bWVJZlN1c3BlbmRlZCwgeyBwYXNzaXZlOiB0cnVlIH0pO1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwicG9pbnRlcnVwXCIsIHJlc3VtZUlmU3VzcGVuZGVkLCB7IHBhc3NpdmU6IHRydWUgfSk7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCByZXN1bWVJZlN1c3BlbmRlZCwgeyBwYXNzaXZlOiB0cnVlIH0pO1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCByZXN1bWVJZlN1c3BlbmRlZCwgeyBwYXNzaXZlOiB0cnVlIH0pO1xuICBzeW5jU2lnbmFsaW5nVWkoKTtcbn1cblxuY29uc3QgbW9iaWxlTGF5b3V0ID0gbWF0Y2hNZWRpYShcIihtYXgtd2lkdGg6IDkyMHB4KVwiKTtcbmxldCBkcmF3ZXJPcGVuZXI6IEhUTUxFbGVtZW50IHwgbnVsbCA9IG51bGw7XG5cbmZ1bmN0aW9uIHNldFRhc2tzT3BlbihvcGVuOiBib29sZWFuLCBvcGVuZXI/OiBIVE1MRWxlbWVudCB8IG51bGwpIHtcbiAgY29uc3QgY2FuT3BlbiA9IG1vYmlsZUxheW91dC5tYXRjaGVzICYmICEkKFwidGFsa1wiKS5oaWRkZW47XG4gIGNvbnN0IG5leHQgPSBvcGVuICYmIGNhbk9wZW47XG4gIGNvbnN0IHdhc09wZW4gPSBkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5jb250YWlucyhcInRhc2tzLW9wZW5cIik7XG4gIGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LnRvZ2dsZShcInRhc2tzLW9wZW5cIiwgbmV4dCk7XG4gIGNvbnN0IGhlYWRlciA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoXCJoZWFkZXJcIikgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAoaGVhZGVyKSBoZWFkZXIuaW5lcnQgPSBuZXh0O1xuICAkKFwiY29udm9cIikuaW5lcnQgPSBuZXh0O1xuICAkKFwic2lkZVwiKS5pbmVydCA9IG1vYmlsZUxheW91dC5tYXRjaGVzICYmICFuZXh0O1xuICAkKFwidGFza3MtdG9nZ2xlXCIpLnNldEF0dHJpYnV0ZShcImFyaWEtZXhwYW5kZWRcIiwgU3RyaW5nKG5leHQpKTtcbiAgJChcIm1vYmlsZS10YXNrcy1iYXJcIikuc2V0QXR0cmlidXRlKFwiYXJpYS1leHBhbmRlZFwiLCBTdHJpbmcobmV4dCkpO1xuICBpZiAobmV4dCAmJiAhd2FzT3Blbikge1xuICAgIGRyYXdlck9wZW5lciA9IG9wZW5lciA/PyAoZG9jdW1lbnQuYWN0aXZlRWxlbWVudCBhcyBIVE1MRWxlbWVudCB8IG51bGwpO1xuICAgIGNsZWFyVW5yZWFkSWZSZXN1bHRzVmlzaWJsZSgpO1xuICAgICQoXCJ0YXNrcy1jbG9zZVwiKS5mb2N1cygpO1xuICAgIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB1cGRhdGVBbGxSZXN1bHRDbGFtcGluZygpKTtcbiAgfSBlbHNlIGlmICghbmV4dCAmJiB3YXNPcGVuKSB7XG4gICAgY29uc3QgdGFyZ2V0ID0gZHJhd2VyT3BlbmVyO1xuICAgIGRyYXdlck9wZW5lciA9IG51bGw7XG4gICAgaWYgKHRhcmdldCAmJiB0YXJnZXQuaXNDb25uZWN0ZWQgJiYgIXRhcmdldC5oaWRkZW4gJiYgdGFyZ2V0Lm9mZnNldFBhcmVudCAhPT0gbnVsbCkge1xuICAgICAgdGFyZ2V0LmZvY3VzKCk7XG4gICAgfSBlbHNlIGlmICh0YXJnZXQgPT09ICQoXCJtb2JpbGUtdGFza3MtYmFyXCIpKSB7XG4gICAgICBjb25zdCBmYWxsYmFjayA9ICQoXCJ0YXNrcy10b2dnbGVcIik7XG4gICAgICBpZiAoIWZhbGxiYWNrLmhpZGRlbiAmJiBmYWxsYmFjay5vZmZzZXRQYXJlbnQgIT09IG51bGwpIGZhbGxiYWNrLmZvY3VzKCk7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIHRhYnMoKSB7XG4gIGNvbnN0IHZpZXdzOiBSZWNvcmQ8c3RyaW5nLCBIVE1MRWxlbWVudD4gPSB7IHRhbGs6ICQoXCJ0YWxrXCIpLCBkZXY6ICQoXCJkZXZcIiksIHJlcGxheTogJChcInJlcGxheW1haW5cIikgfTtcbiAgZm9yIChjb25zdCBuYW1lIG9mIE9iamVjdC5rZXlzKHZpZXdzKSkge1xuICAgICQoYHRhYi0ke25hbWV9YCkub25jbGljayA9ICgpID0+IHtcbiAgICAgIGZvciAoY29uc3QgW290aGVyLCBlbF0gb2YgT2JqZWN0LmVudHJpZXModmlld3MpKSB7XG4gICAgICAgIGVsLmhpZGRlbiA9IG90aGVyICE9PSBuYW1lO1xuICAgICAgICAkKGB0YWItJHtvdGhlcn1gKS5jbGFzc0xpc3QudG9nZ2xlKFwib25cIiwgb3RoZXIgPT09IG5hbWUpO1xuICAgICAgfVxuICAgICAgJChcInRhc2tzLXRvZ2dsZVwiKS5oaWRkZW4gPSBuYW1lICE9PSBcInRhbGtcIjtcbiAgICAgIHNldFRhc2tzT3BlbihmYWxzZSk7XG4gICAgICBpZiAobmFtZSA9PT0gXCJ0YWxrXCIpIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB1cGRhdGVBbGxSZXN1bHRDbGFtcGluZygpKTtcbiAgICB9O1xuICB9XG4gIGZvciAoY29uc3QgYnRuIG9mIEFycmF5LmZyb20oZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MQnV0dG9uRWxlbWVudD4oXCIjc2lkZS10YWJzIGJ1dHRvblwiKSkpIHtcbiAgICBidG4ub25jbGljayA9ICgpID0+IHNldFNpZGVGaWx0ZXIobm9ybWFsaXplU2lkZUZpbHRlcihidG4uZGF0YXNldC5maWx0ZXIpKTtcbiAgfVxuICAkKFwidG9nZ2xlLWFsbC1yZXN1bHRzXCIpLm9uY2xpY2sgPSAoKSA9PiB7XG4gICAgY29uc3QgY2xhbXBlZCA9IFsuLi5yZXN1bHRzLnZhbHVlcygpXS5maWx0ZXIoKHIpID0+IHIuY2FyZC5jbGFzc0xpc3QuY29udGFpbnMoXCJjbGFtcGVkXCIpKTtcbiAgICBjb25zdCBvcGVuQWxsID0gY2xhbXBlZC5zb21lKChyKSA9PiAhci5jYXJkLmNsYXNzTGlzdC5jb250YWlucyhcIm9wZW5cIikpO1xuICAgIGZvciAoY29uc3QgZW50cnkgb2YgY2xhbXBlZCkgc2V0UmVzdWx0T3BlbihlbnRyeSwgb3BlbkFsbCk7XG4gIH07XG4gICQoXCJnZWFyXCIpLm9uY2xpY2sgPSAoKSA9PiB7ICQoXCJzZXR0aW5nc1wiKS5oaWRkZW4gPSBmYWxzZTsgfTtcbiAgJChcImNsb3Nlc2V0dGluZ3NcIikub25jbGljayA9ICgpID0+IHsgJChcInNldHRpbmdzXCIpLmhpZGRlbiA9IHRydWU7IH07XG4gICQoXCJjbG9zZXNldHRpbmdzLXhcIikub25jbGljayA9ICgpID0+IHsgJChcInNldHRpbmdzXCIpLmhpZGRlbiA9IHRydWU7IH07XG4gICQoXCJzZXR0aW5nc1wiKS5vbmNsaWNrID0gKGUpID0+IHsgaWYgKGUudGFyZ2V0ID09PSAkKFwic2V0dGluZ3NcIikpICQoXCJzZXR0aW5nc1wiKS5oaWRkZW4gPSB0cnVlOyB9O1xuICBjb25zdCBvcGVuTW9iaWxlVGFza3NEcmF3ZXIgPSAob3BlbmVyOiBIVE1MRWxlbWVudCkgPT4ge1xuICAgIGNvbnN0IGFjdGl2ZVRvdGFsID0gWy4uLnRhc2tzLnZhbHVlcygpXS5maWx0ZXIoaXNBY3RpdmVUYXNrKS5sZW5ndGggKyBlYXJsaWVyQWN0aXZlQ291bnQ7XG4gICAgY29uc3QgbmV4dEZpbHRlciA9IHJlc29sdmVNb2JpbGVCYW5uZXJGaWx0ZXIoc2lkZUZpbHRlciwgYWN0aXZlVG90YWwsIHVucmVhZE1vYmlsZVJlc3VsdHMpO1xuICAgIGlmIChuZXh0RmlsdGVyICE9PSBzaWRlRmlsdGVyKSBzZXRTaWRlRmlsdGVyKG5leHRGaWx0ZXIpO1xuICAgIHNldFRhc2tzT3Blbih0cnVlLCBvcGVuZXIpO1xuICB9O1xuICAkKFwidGFza3MtdG9nZ2xlXCIpLm9uY2xpY2sgPSAoKSA9PiB7XG4gICAgaWYgKGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LmNvbnRhaW5zKFwidGFza3Mtb3BlblwiKSkgc2V0VGFza3NPcGVuKGZhbHNlKTtcbiAgICBlbHNlIG9wZW5Nb2JpbGVUYXNrc0RyYXdlcigkKFwidGFza3MtdG9nZ2xlXCIpKTtcbiAgfTtcbiAgJChcIm1vYmlsZS10YXNrcy1iYXJcIikub25jbGljayA9ICgpID0+IG9wZW5Nb2JpbGVUYXNrc0RyYXdlcigkKFwibW9iaWxlLXRhc2tzLWJhclwiKSk7XG4gICQoXCJ0YXNrcy1jbG9zZVwiKS5vbmNsaWNrID0gKCkgPT4gc2V0VGFza3NPcGVuKGZhbHNlKTtcbiAgJChcInNpZGUtYmFja2Ryb3BcIikub25jbGljayA9ICgpID0+IHNldFRhc2tzT3BlbihmYWxzZSk7XG4gIG1vYmlsZUxheW91dC5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHtcbiAgICBzZXRUYXNrc09wZW4oZmFsc2UpO1xuICAgIGNsZWFyVW5yZWFkSWZSZXN1bHRzVmlzaWJsZSgpO1xuICAgIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB1cGRhdGVBbGxSZXN1bHRDbGFtcGluZygpKTtcbiAgfSk7XG4gIHNldFRhc2tzT3BlbihmYWxzZSk7XG59XG5cbmZ1bmN0aW9uIHR5cGluZygpOiBib29sZWFuIHtcbiAgY29uc3QgZWwgPSBkb2N1bWVudC5hY3RpdmVFbGVtZW50IGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgcmV0dXJuICEhZWwgJiYgKGVsLnRhZ05hbWUgPT09IFwiSU5QVVRcIiB8fCBlbC50YWdOYW1lID09PSBcIlRFWFRBUkVBXCIgfHwgZWwudGFnTmFtZSA9PT0gXCJTRUxFQ1RcIiB8fCBlbC5pc0NvbnRlbnRFZGl0YWJsZSk7XG59XG5cbmZ1bmN0aW9uIGtleXMoKSB7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJrZXlkb3duXCIsIChlKSA9PiB7XG4gICAgaWYgKGUua2V5ID09PSBcIkVzY2FwZVwiKSB7XG4gICAgICBpZiAoISQoXCJzZXR0aW5nc1wiKS5oaWRkZW4pIHsgJChcInNldHRpbmdzXCIpLmhpZGRlbiA9IHRydWU7IHJldHVybjsgfVxuICAgICAgaWYgKGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LmNvbnRhaW5zKFwidGFza3Mtb3BlblwiKSAmJiBtb2JpbGVMYXlvdXQubWF0Y2hlcyAmJiAhJChcInRhbGtcIikuaGlkZGVuKSB7IHNldFRhc2tzT3BlbihmYWxzZSk7IHJldHVybjsgfVxuICAgICAgaWYgKGNhbGxJZCkgeyBwdXNoKHsgdHlwZTogXCJpbnRlcnJ1cHRcIiB9KTsgYXVkaW8uZmx1c2goKTsgcmV0dXJuOyB9XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICh0eXBpbmcoKSB8fCAhJChcInNldHRpbmdzXCIpLmhpZGRlbiB8fCBkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5jb250YWlucyhcInRhc2tzLW9wZW5cIikgfHwgZS5tZXRhS2V5IHx8IGUuY3RybEtleSB8fCBlLmFsdEtleSkgcmV0dXJuO1xuICAgIGlmIChlLmtleSA9PT0gXCJtXCIgfHwgZS5rZXkgPT09IFwiTVwiKSB7IHNldE11dGVkKCFtdXRlZCk7IGUucHJldmVudERlZmF1bHQoKTsgfVxuICAgIGVsc2UgaWYgKGUua2V5ID09PSBcIndcIiB8fCBlLmtleSA9PT0gXCJXXCIpIHsgdm9pZCBhcm1XYWtlKCF3YWtlQXJtZWQpOyBlLnByZXZlbnREZWZhdWx0KCk7IH1cbiAgICBlbHNlIGlmIChlLmtleSA9PT0gXCIvXCIpIHsgJChcInRleHRcIikuZm9jdXMoKTsgZS5wcmV2ZW50RGVmYXVsdCgpOyB9XG4gICAgZWxzZSBpZiAoZS5jb2RlID09PSBcIlNwYWNlXCIgJiYgY2FsbElkICYmIG11dGVkICYmICFlLnJlcGVhdCkgeyBob2xkaW5nID0gdHJ1ZTsgcHVzaCh7IHR5cGU6IFwidW5tdXRlXCIgfSk7IHNob3dTdGF0dXMoKTsgZS5wcmV2ZW50RGVmYXVsdCgpOyB9XG4gIH0pO1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5dXBcIiwgKGUpID0+IHtcbiAgICBpZiAoZS5jb2RlID09PSBcIlNwYWNlXCIgJiYgaG9sZGluZykge1xuICAgICAgaG9sZGluZyA9IGZhbHNlO1xuICAgICAgZmx1c2hEZWZlcnJlZE1pYygpO1xuICAgICAgd2FrZUNsaWVudC5yZXNldCgpO1xuICAgICAgcHVzaCh7IHR5cGU6IFwibXV0ZVwiIH0pO1xuICAgICAgc2hvd1N0YXR1cygpO1xuICAgIH1cbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHN1Ym1pdFRleHQoZTogRXZlbnQpIHtcbiAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICBjb25zdCBpbnB1dCA9ICQ8SFRNTElucHV0RWxlbWVudD4oXCJ0ZXh0XCIpO1xuICBsZXQgdGV4dCA9IGlucHV0LnZhbHVlLnRyaW0oKTtcbiAgaWYgKCF0ZXh0KSByZXR1cm47XG4gIC8vIFdpdGggbm8gY2FsbCBvbiwgdHlwaW5nIHN0YXJ0cyBhIGNoYXQ6IHRoZSBzYW1lIG1haW4gdGhyZWFkLCBpbiB0ZXh0LlxuICBpZiAoIWNhbGxJZCkge1xuICAgIGlucHV0LnZhbHVlID0gXCJcIjtcbiAgICBzeW5jQ29tcG9zZXIoKTtcbiAgICB0cnkgeyBhd2FpdCBzdGFydChmYWxzZSwgdHJ1ZSk7IH0gY2F0Y2ggKGVycikgeyB0b2FzdCgoZXJyIGFzIEVycm9yKS5tZXNzYWdlKTsgbG9nKFwiZXJyb3JcIiwgKGVyciBhcyBFcnJvcikubWVzc2FnZSwgXCJlcnJcIik7IH1cbiAgICBpZiAoIWNhbGxJZCkgeyBpbnB1dC52YWx1ZSA9IHRleHQ7IHN5bmNDb21wb3NlcigpOyByZXR1cm47IH1cbiAgfVxuICAvLyBcIi90MyBcdTIwMjZcIiBhbmQgXCIvaCBcdTIwMjZcIiBwaWNrIHRoZSBhZ2VudCB3aGF0ZXZlciB0aGUgc2VsZWN0b3Igc2F5cy5cbiAgY29uc3QgcGFyc2VkID0gcGFyc2VQcmVmaXgodGV4dCk7XG4gIGNvbnN0IG1vZGUgPSBwYXJzZWQubW9kZSA/PyAkPEhUTUxTZWxlY3RFbGVtZW50PihcIm1vZGVcIikudmFsdWU7XG4gIHRleHQgPSBwYXJzZWQucmVzdDtcbiAgaWYgKCF0ZXh0KSByZXR1cm47XG4gIGlmIChtb2RlID09PSBcInNheVwiKSB7XG4gICAgcHVzaCh7IHR5cGU6IFwic2F5XCIsIHRleHQgfSk7XG4gICAgc2Nyb2xsRG93bih0cnVlKTtcbiAgfSBlbHNlIHtcbiAgICBwdXNoKHsgdHlwZTogXCJhc2tcIiwgdGV4dCwgYWdlbnQ6IG1vZGUgfSk7XG4gICAgbm90ZShgWW91IFx1MjE5MiBuZXcgJHttb2RlID09PSBcInQzXCIgPyBcImNvZGluZ1wiIDogXCJIZXJtZXNcIn0gdGFzazogJHt0ZXh0fWApO1xuICAgIHNjcm9sbERvd24odHJ1ZSk7XG4gIH1cbiAgaW5wdXQudmFsdWUgPSBcIlwiO1xuICBzeW5jQ29tcG9zZXIoKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gbWFpbigpIHtcbiAgYXBwbHlUaGVtZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLnRoZW1lXCIpID8/IFwic3lzdGVtXCIpO1xuICBhcHBseURlbnNpdHkobG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS5kZW5zaXR5XCIpKTtcbiAgc2VydmVyID0gYXdhaXQgKGF3YWl0IGZldGNoKFwiL2NvbmZpZ1wiKSkuanNvbigpO1xuICAkKFwicm91dGVcIikudGV4dENvbnRlbnQgPSBgJHtzZXJ2ZXIucm91dGUgPT09IFwidmVydGV4XCIgPyBcIlZlcnRleFwiIDogXCJHZW1pbmkgQVBJXCJ9IFx1MDBCNyAke3NlcnZlci5tb2RlbC5zcGxpdChcIi9cIikucG9wKCl9YDtcbiAgJChcInZlcnNpb25cIikudGV4dENvbnRlbnQgPSBzZXJ2ZXIudmVyc2lvbjtcbiAgJChcImJ1aWxkXCIpLnRleHRDb250ZW50ID0gYGNvcmUgJHtzZXJ2ZXIudmVyc2lvbn1gO1xuICBzZXR0aW5nc0Zyb21TdG9yYWdlKCk7XG4gIGNvbnN0IHdha2VTZWxlY3QgPSAkPEhUTUxTZWxlY3RFbGVtZW50PihcIndha2UtbW9kZWxcIik7XG4gIGNvbnN0IHdha2VMaXN0ID0gc2VydmVyLndha2VNb2RlbHMgPz8gW107XG4gIGZvciAoY29uc3QgbSBvZiB3YWtlTGlzdCkgd2FrZVNlbGVjdC5hZGQobmV3IE9wdGlvbihtLmxhYmVsLCBtLmlkKSk7XG4gIGNvbnN0IHNhdmVkV2FrZU1vZGVsID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS53YWtlLW1vZGVsXCIpO1xuICBpZiAoc2F2ZWRXYWtlTW9kZWwgJiYgd2FrZUxpc3Quc29tZSgobSkgPT4gbS5pZCA9PT0gc2F2ZWRXYWtlTW9kZWwpKSB3YWtlU2VsZWN0LnZhbHVlID0gc2F2ZWRXYWtlTW9kZWw7XG4gIGVsc2UgaWYgKHdha2VMaXN0LnNvbWUoKG0pID0+IG0uaWQgPT09IFwicGVubnl3b3J0aFwiKSkgd2FrZVNlbGVjdC52YWx1ZSA9IFwicGVubnl3b3J0aFwiO1xuICBpZiAod2FrZUxpc3QubGVuZ3RoID09PSAwKSB7XG4gICAgJDxIVE1MSW5wdXRFbGVtZW50PihcIndha2UtZW5hYmxlZFwiKS5kaXNhYmxlZCA9IHRydWU7XG4gICAgd2FrZVNlbGVjdC5kaXNhYmxlZCA9IHRydWU7XG4gICAgJChcIndha2UtaGVscFwiKS50ZXh0Q29udGVudCA9IFwiTm8gLm9ubnggd2FrZSB3b3JkIG1vZGVscyBmb3VuZCBvbiB0aGUgc2VydmVyLlwiO1xuICB9XG4gIGlmICghc2VydmVyLmhlcm1lcykgeyAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwiZmFrZWhlcm1lc1wiKS5jaGVja2VkID0gdHJ1ZTsgJDxIVE1MSW5wdXRFbGVtZW50PihcImZha2VoZXJtZXNcIikuZGlzYWJsZWQgPSB0cnVlOyB9XG4gIGlmICghc2VydmVyLnQzKSAkKFwiY29kaW5naGVscFwiKS50ZXh0Q29udGVudCA9IFwiVDMgaXNuJ3QgYXZhaWxhYmxlIG9uIHRoZSBzZXJ2ZXI6IG9ubHkgd2l0aCBmYWtlIGFuc3dlcnMuXCI7XG4gIGVsc2UgJChcImNvZGluZ2hlbHBcIikudGV4dENvbnRlbnQgPSBgQ29kZSBjaGFuZ2VzIGdvIHRvIGEgVDMgQ29kZSB0aHJlYWQgaW4gb25lIG9mOiAke3NlcnZlci50My5qb2luKFwiLCBcIil9LmA7XG4gIGlmICghc3RvcFdvcmRzLnN1cHBvcnRlZCkgeyAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwic3RvcHdvcmRcIikuY2hlY2tlZCA9IGZhbHNlOyAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwic3RvcHdvcmRcIikuZGlzYWJsZWQgPSB0cnVlOyB9XG4gIGNvbnN0IHByZXNldCA9ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwicHJlc2V0XCIpO1xuICBmb3IgKGNvbnN0IG5hbWUgb2YgT2JqZWN0LmtleXMoUFJFU0VUUykpIHByZXNldC5hZGQobmV3IE9wdGlvbihuYW1lLCBuYW1lKSk7XG4gIHByZXNldC52YWx1ZSA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UtY29yZS5wcmVzZXRcIikgPz8gXCJ3ZWJcIjtcbiAgaWYgKCFQUkVTRVRTW3ByZXNldC52YWx1ZV0pIHByZXNldC52YWx1ZSA9IFwid2ViXCI7XG4gICQ8SFRNTFRleHRBcmVhRWxlbWVudD4oXCJjb25maWdcIikudmFsdWUgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLWNvcmUuY29uZmlnXCIpID8/IEpTT04uc3RyaW5naWZ5KFBSRVNFVFNbcHJlc2V0LnZhbHVlXSwgbnVsbCwgMik7XG4gIHN5bmNTaWduYWxpbmdVaSgpO1xuICBwcmVzZXQub25jaGFuZ2UgPSAoKSA9PiB7XG4gICAgJDxIVE1MVGV4dEFyZWFFbGVtZW50PihcImNvbmZpZ1wiKS52YWx1ZSA9IEpTT04uc3RyaW5naWZ5KFBSRVNFVFNbcHJlc2V0LnZhbHVlXSwgbnVsbCwgMik7XG4gICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS1jb3JlLnByZXNldFwiLCBwcmVzZXQudmFsdWUpO1xuICAgIGxvY2FsU3RvcmFnZS5yZW1vdmVJdGVtKFwidm9pY2UtY29yZS5jb25maWdcIik7XG4gICAgc3luY1NpZ25hbGluZ1VpKCk7XG4gIH07XG4gICQoXCJjb25maWdcIikub25pbnB1dCA9ICgpID0+IHsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS1jb3JlLmNvbmZpZ1wiLCAkPEhUTUxUZXh0QXJlYUVsZW1lbnQ+KFwiY29uZmlnXCIpLnZhbHVlKTsgc3luY1NpZ25hbGluZ1VpKCk7IH07XG4gICQoXCJkZWZhdWx0c1wiKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGMgPSBjb3JlID8/IChhd2FpdCBsb2FkQ29yZSgpKTtcbiAgICAkKFwiZGVmYXVsdHN2aWV3XCIpLnRleHRDb250ZW50ID0gSlNPTi5zdHJpbmdpZnkoSlNPTi5wYXJzZShjLmRlZmF1bHRzKCkpLCBudWxsLCAyKTtcbiAgICAkKFwiZGVmYXVsdHN2aWV3XCIpLmhpZGRlbiA9ICEkKFwiZGVmYXVsdHN2aWV3XCIpLmhpZGRlbjtcbiAgfTtcbiAgY29uc3Qgb25DYWxsQ2xpY2sgPSAoKSA9PiB2b2lkIGNhbGxCdXR0b24oKS5jYXRjaCgoZXJyKSA9PiB7IHRvYXN0KGVyci5tZXNzYWdlKTsgbG9nKFwiZXJyb3JcIiwgZXJyLm1lc3NhZ2UsIFwiZXJyXCIpOyB9KTtcbiAgY29uc3Qgb25IZXJvQ2FsbENsaWNrID0gKCkgPT4geyBpZiAoIWNhbGxJZCkgdm9pZCBzdGFydCgpLmNhdGNoKChlcnIpID0+IHsgdG9hc3QoZXJyLm1lc3NhZ2UpOyBsb2coXCJlcnJvclwiLCBlcnIubWVzc2FnZSwgXCJlcnJcIik7IH0pOyB9O1xuICBjb25zdCBvblJlc3VtZUNsaWNrID0gKCkgPT4gdm9pZCBzdGFydCh0cnVlKS5jYXRjaCgoZXJyKSA9PiB7IHRvYXN0KGVyci5tZXNzYWdlKTsgbG9nKFwiZXJyb3JcIiwgZXJyLm1lc3NhZ2UsIFwiZXJyXCIpOyB9KTtcbiAgJChcImNhbGxcIikub25jbGljayA9IG9uQ2FsbENsaWNrO1xuICAkKFwiaGVyby1jYWxsXCIpLm9uY2xpY2sgPSBvbkhlcm9DYWxsQ2xpY2s7XG4gICQoXCJoZXJvLXdha2VcIikub25jbGljayA9ICgpID0+IHtcbiAgICBpZiAod2FrZUFybWVkICYmIGF1ZGlvLmF1ZGlvU3VzcGVuZGVkKSB7IHZvaWQgYXVkaW8ucmVzdW1lQXVkaW8oKS50aGVuKCgpID0+IHN5bmNXYWtlVWkoKSk7IHJldHVybjsgfVxuICAgIHZvaWQgYXJtV2FrZSghd2FrZUFybWVkKTtcbiAgfTtcbiAgJChcIndha2VidG5cIikub25jbGljayA9ICgpID0+IHtcbiAgICBpZiAod2FrZUFybWVkICYmIGF1ZGlvLmF1ZGlvU3VzcGVuZGVkKSB7IHZvaWQgYXVkaW8ucmVzdW1lQXVkaW8oKS50aGVuKCgpID0+IHN5bmNXYWtlVWkoKSk7IHJldHVybjsgfVxuICAgIHZvaWQgYXJtV2FrZSghd2FrZUFybWVkKTtcbiAgfTtcbiAgJChcIndha2Utbm93XCIpLm9uY2xpY2sgPSAoKSA9PiB7XG4gICAgaWYgKGNhbGxJZCkge1xuICAgICAgZmx1c2hEZWZlcnJlZE1pYygpO1xuICAgICAgd2FrZUNsaWVudC5yZXNldCgpO1xuICAgICAgcHVzaCh7IHR5cGU6IFwicmVzdW1lXCIgfSk7XG4gICAgfVxuICB9O1xuICAkKFwicmVzdW1lXCIpLm9uY2xpY2sgPSBvblJlc3VtZUNsaWNrO1xuICAkKFwiaGVyby1yZXN1bWVcIikub25jbGljayA9IG9uUmVzdW1lQ2xpY2s7XG4gIHN5bmNXYWtlVWkoKTtcbiAgaWYgKGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2Uud2FrZS1lbmFibGVkXCIpID09PSBcIjFcIiAmJiB3YWtlTGlzdC5sZW5ndGggPiAwKSB7XG4gICAgLy8gUmUtYXJtIGF1dG9tYXRpY2FsbHkgb24gcmVsb2FkIG9ubHkgd2hlbiBtaWNyb3Bob25lIHBlcm1pc3Npb24gaXMgYWxyZWFkeSBncmFudGVkLlxuICAgIHZvaWQgbmF2aWdhdG9yLnBlcm1pc3Npb25zPy5xdWVyeSh7IG5hbWU6IFwibWljcm9waG9uZVwiIGFzIFBlcm1pc3Npb25OYW1lIH0pXG4gICAgICAudGhlbigocCkgPT4geyBpZiAocC5zdGF0ZSA9PT0gXCJncmFudGVkXCIpIHZvaWQgYXJtV2FrZSh0cnVlLCBmYWxzZSk7IH0pXG4gICAgICAuY2F0Y2goKCkgPT4ge30pO1xuICB9XG4gIGlmIChzYXZlZEhpc3RvcnkoKS5sZW5ndGggPiAwKSB7XG4gICAgc3luY1Jlc3VtZUJ1dHRvbnModHJ1ZSk7XG4gICAgJChcInJlc3VtZVwiKS50aXRsZSA9IFwiQ2FsbCBhZ2FpbiwgY2Fycnlpbmcgb24gZnJvbSB0aGUgbGFzdCBjb252ZXJzYXRpb25cIjtcbiAgfVxuICAkKFwibWljXCIpLm9uY2xpY2sgPSAoKSA9PiBzZXRNdXRlZCghbXV0ZWQpO1xuICAkKFwiaHVzaFwiKS5vbmNsaWNrID0gKCkgPT4geyBwdXNoKHsgdHlwZTogXCJpbnRlcnJ1cHRcIiB9KTsgYXVkaW8uZmx1c2goKTsgfTtcbiAgJChcImNhbmNlbGFsbFwiKS5vbmNsaWNrID0gKCkgPT4gcHVzaCh7IHR5cGU6IFwiY2FuY2VsQWxsXCIgfSk7XG4gICQoXCJkb25lYm94XCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJ0b2dnbGVcIiwgKCkgPT4geyBpZiAoJDxIVE1MRGV0YWlsc0VsZW1lbnQ+KFwiZG9uZWJveFwiKS5vcGVuKSAkKFwiZG9uZWJveFwiKS5zY3JvbGxJbnRvVmlldyh7IGJsb2NrOiBcIm5lYXJlc3RcIiB9KTsgfSk7XG4gICQoXCJzYXlcIikub25zdWJtaXQgPSAoZSkgPT4gdm9pZCBzdWJtaXRUZXh0KGUpO1xuICAkKFwidGV4dFwiKS5hZGRFdmVudExpc3RlbmVyKFwiaW5wdXRcIiwgc3luY0NvbXBvc2VyKTtcbiAgY29uc3QgdHJhbnNjcmlwdFBhbmUgPSAkKFwidHJhbnNjcmlwdFwiKTtcbiAgdHJhbnNjcmlwdFBhbmUuYWRkRXZlbnRMaXN0ZW5lcihcInNjcm9sbFwiLCAoKSA9PiB0cmFuc2NyaXB0U2Nyb2xsLm9uU2Nyb2xsKCksIHsgcGFzc2l2ZTogdHJ1ZSB9KTtcbiAgdHJhbnNjcmlwdFBhbmUuYWRkRXZlbnRMaXN0ZW5lcihcInNjcm9sbGVuZFwiLCAoKSA9PiB0cmFuc2NyaXB0U2Nyb2xsLm9uU2Nyb2xsRW5kKCksIHsgcGFzc2l2ZTogdHJ1ZSB9KTtcbiAgdHJhbnNjcmlwdFBhbmUuYWRkRXZlbnRMaXN0ZW5lcihcIndoZWVsXCIsIChlKSA9PiB7IGlmIChlLmRlbHRhWSA8IDApIHRyYW5zY3JpcHRTY3JvbGwuY2FuY2VsSnVtcCgpOyB9LCB7IHBhc3NpdmU6IHRydWUgfSk7XG4gIHRyYW5zY3JpcHRQYW5lLmFkZEV2ZW50TGlzdGVuZXIoXCJ0b3VjaHN0YXJ0XCIsICgpID0+IHRyYW5zY3JpcHRTY3JvbGwuY2FuY2VsSnVtcCgpLCB7IHBhc3NpdmU6IHRydWUgfSk7XG4gIGlmICh0eXBlb2YgUmVzaXplT2JzZXJ2ZXIgIT09IFwidW5kZWZpbmVkXCIpIHtcbiAgICBuZXcgUmVzaXplT2JzZXJ2ZXIoKCkgPT4gdHJhbnNjcmlwdFNjcm9sbC5vblJlc2l6ZSgpKS5vYnNlcnZlKHRyYW5zY3JpcHRQYW5lKTtcbiAgICBuZXcgUmVzaXplT2JzZXJ2ZXIoKCkgPT4gdXBkYXRlQWxsUmVzdWx0Q2xhbXBpbmcoKSkub2JzZXJ2ZSgkKFwicmVzdWx0c1wiKSk7XG4gIH1cbiAgJChcImp1bXBib3R0b21cIikub25jbGljayA9ICgpID0+IHRyYW5zY3JpcHRTY3JvbGwuanVtcFRvQm90dG9tKCk7XG4gIHN5bmNDb21wb3NlcigpO1xuICBzeW5jU2lkZUxheW91dCgpO1xuICB0YWJzKCk7XG4gIGtleXMoKTtcbiAgY29uc3QgZXZlbnRzID0gbmV3IEV2ZW50U291cmNlKFwiL2V2ZW50c1wiKTtcbiAgZXZlbnRzLmFkZEV2ZW50TGlzdGVuZXIoXCJjb3JlXCIsIChlKSA9PiB7XG4gICAgY29uc3QgeyB2ZXJzaW9uIH0gPSBKU09OLnBhcnNlKChlIGFzIE1lc3NhZ2VFdmVudCkuZGF0YSk7XG4gICAgJChcInZlcnNpb25cIikudGV4dENvbnRlbnQgPSB2ZXJzaW9uICsgKGNhbGxJZCAmJiBjb3JlICYmIGNvcmUudmVyc2lvbiAhPT0gdmVyc2lvbiA/IGAgKG5leHQgY2FsbDsgdGhpcyBvbmUgcnVucyAke2NvcmUudmVyc2lvbn0pYCA6IFwiXCIpO1xuICAgICQoXCJidWlsZFwiKS50ZXh0Q29udGVudCA9IGBjb3JlICR7dmVyc2lvbn1gO1xuICB9KTtcbiAgZXZlbnRzLmFkZEV2ZW50TGlzdGVuZXIoXCJhcHBcIiwgKCkgPT4geyBpZiAoIWNhbGxJZCkgbG9jYXRpb24ucmVsb2FkKCk7IGVsc2UgdG9hc3QoXCJUaGUgcGFnZSBjaGFuZ2VkOiByZWxvYWQgYWZ0ZXIgdGhpcyBjYWxsXCIpOyB9KTtcbiAgZXZlbnRzLmFkZEV2ZW50TGlzdGVuZXIoXCJlcnJvclwiLCAoZSkgPT4ge1xuICAgIGNvbnN0IGRhdGEgPSAoZSBhcyBNZXNzYWdlRXZlbnQpLmRhdGE7XG4gICAgaWYgKGRhdGEpIHRvYXN0KGBCdWlsZCBmYWlsZWQ6ICR7SlNPTi5wYXJzZShkYXRhKS5tZXNzYWdlfWApO1xuICB9KTtcbiAgbmV3IFJlcGxheSgkKFwicmVwbGF5XCIpLCBsb2FkQ29yZSk7XG4gIHZvaWQgcGluZygpO1xuICB2b2lkIHNob3dFYXJsaWVyKCk7XG4gIHdpbmRvdy5zZXRJbnRlcnZhbCgoKSA9PiB2b2lkIHNob3dFYXJsaWVyKCksIDMwXzAwMCk7XG59XG5cbnZvaWQgbWFpbigpO1xuIl0sCiAgIm1hcHBpbmdzIjogIjtBQVNBLElBQU0sU0FBUyxvQkFBSSxJQUFJO0FBQUEsRUFDckI7QUFBQSxFQUFPO0FBQUEsRUFBTTtBQUFBLEVBQVE7QUFBQSxFQUFVO0FBQUEsRUFBTztBQUFBLEVBQVE7QUFBQSxFQUFNO0FBQUEsRUFBTTtBQUFBLEVBQU07QUFBQSxFQUFNO0FBQUEsRUFBVztBQUFBLEVBQVM7QUFBQSxFQUFRO0FBQUEsRUFBTztBQUFBLEVBQVU7QUFBQSxFQUFTO0FBQUEsRUFDNUg7QUFDRixDQUFDO0FBR00sU0FBUyxNQUFNLE1BQXdCO0FBQzVDLFNBQU8sS0FBSyxZQUFZLEVBQUUsUUFBUSxVQUFVLEVBQUUsRUFBRSxRQUFRLHFCQUFxQixHQUFHLEVBQUUsS0FBSyxFQUFFLE1BQU0sR0FBRyxFQUFFLE9BQU8sQ0FBQyxNQUFNLEVBQUUsU0FBUyxDQUFDO0FBQ2hJO0FBR08sU0FBUyxVQUFVLFdBQW1CLFVBQXlCLFFBQWtCLENBQUMsR0FBd0I7QUFDL0csUUFBTSxVQUFVLG9CQUFJLElBQUksQ0FBQyxHQUFHLFFBQVEsR0FB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U0FBUztBQUN4QyxTQUFPLGlCQUFpQixRQUFRLENBQUMsTUFBTTtBQUNyQyxVQUFNLEVBQUUsUUFBUSxJQUFJLEtBQUssTUFBTyxFQUFtQixJQUFJO0FBQ3ZELE1BQUUsU0FBUyxFQUFFLGNBQWMsV0FBVyxVQUFVLFFBQVEsS0FBSyxZQUFZLFVBQVUsOEJBQThCLEtBQUssT0FBTyxNQUFNO0FBQ25JLE1BQUUsT0FBTyxFQUFFLGNBQWMsUUFBUSxPQUFPO0FBQUEsRUFDMUMsQ0FBQztBQUNELFNBQU8saUJBQWlCLE9BQU8sTUFBTTtBQUFFLFFBQUksQ0FBQyxPQUFRLFVBQVMsT0FBTztBQUFBLFFBQVEsT0FBTSwwQ0FBMEM7QUFBQSxFQUFHLENBQUM7QUFDaEksU0FBTyxpQkFBaUIsU0FBUyxDQUFDLE1BQU07QUFDdEMsVUFBTSxPQUFRLEVBQW1CO0FBQ2pDLFFBQUksS0FBTSxPQUFNLGlCQUFpQixLQUFLLE1BQU0sSUFBSSxFQUFFLE9BQU8sRUFBRTtBQUFBLEVBQzdELENBQUM7QUFDRCxNQUFJLE9BQU8sRUFBRSxRQUFRLEdBQUcsUUFBUTtBQUNoQyxPQUFLLEtBQUs7QUFDVixPQUFLLFlBQVk7QUFDakIsU0FBTyxZQUFZLE1BQU0sS0FBSyxZQUFZLEdBQUcsR0FBTTtBQUNyRDtBQUVBLEtBQUssS0FBSzsiLAogICJuYW1lcyI6IFsiY29yZSIsICJjb3JlIiwgIm5vdyIsICJhY3RpdmVTZXNzaW9uIiwgImNvdW50cyIsICJieXRlc1RvQmFzZTY0IiwgImxpdmUiLCAibGluZSIsICJydW4iLCAibW9kZSJdCn0K
