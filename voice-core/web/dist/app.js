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
var WakeAudioGate = class {
  constructor(maxDeferred = 60) {
    this.whileSpeaking = "send";
    this.speechUntil = 0;
    this.announcerFrom = 0;
    this.announcerUntil = 0;
    this.pendingHostBriefs = 0;
    this.requestedBriefIds = /* @__PURE__ */ new Set();
    this.replayFloorSeq = 0;
    this.deferred = [];
    this.maxDeferred = maxDeferred;
  }
  reset(whileSpeaking = "send", floorSeq = 0) {
    this.whileSpeaking = whileSpeaking;
    this.speechUntil = 0;
    this.announcerFrom = 0;
    this.announcerUntil = 0;
    this.pendingHostBriefs = 0;
    this.requestedBriefIds.clear();
    this.replayFloorSeq = floorSeq;
    this.deferred = [];
  }
  get hasDeferred() {
    return this.deferred.length > 0;
  }
  isSuppressed(t) {
    return this.whileSpeaking !== "send" && t < this.speechUntil;
  }
  onBriefRequest(id) {
    if (id) this.requestedBriefIds.add(id);
  }
  onPlay(pcmBase64, eventTime, source) {
    const pad = pcmBase64.endsWith("==") ? 2 : pcmBase64.endsWith("=") ? 1 : 0;
    const pcmBytes = Math.max(0, Math.floor(pcmBase64.length * 3 / 4) - pad);
    this.speechUntil = Math.max(this.speechUntil, eventTime) + pcmBytes / 48e3;
    if (source === "announcer") {
      this.pendingHostBriefs = Math.max(0, this.pendingHostBriefs - 1);
      this.announcerFrom = eventTime;
      this.announcerUntil = this.speechUntil;
    }
  }
  onFlush(eventTime, cause) {
    this.speechUntil = Math.min(this.speechUntil, eventTime);
    if (eventTime < this.announcerUntil) {
      const played = (eventTime - this.announcerFrom) / Math.max(0.1, this.announcerUntil - this.announcerFrom);
      if (played < 0.8 && cause !== "interrupt" && cause !== "stop") {
        this.pendingHostBriefs++;
      }
      this.announcerFrom = 0;
      this.announcerUntil = 0;
    }
  }
  /**
   * Called immediately before pushing an event to the core. Returns any deferred unsuppressed
   * gap frames that must reach the core first so new playback cannot silence them.
   */
  beforePush(event) {
    if (event.type === "brief.ready" && typeof event.id === "string" && this.requestedBriefIds.delete(event.id) && typeof event.pcm === "string" && event.pcm.length > 0 && typeof event.text === "string" && event.text.trim().length > 0) {
      this.pendingHostBriefs++;
    }
    if (this.deferred.length === 0) return [];
    const canStartPlayback = event.type === "brief.ready" || this.pendingHostBriefs > 0 && event.type === "tick" || event.type === "ws.message" && String(event.data ?? "").includes('"inlineData"');
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
  const flushed = wakeGate.beforePush(event);
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
        wakeGate.onPlay(c.pcm, eventTime, typeof c.source === "string" ? c.source : void 0);
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
        wakeGate.onFlush(eventTime, eventType);
        audio.flush();
        log("out", "flush", "out");
        break;
      case "brief":
        if (typeof c.id === "string") wakeGate.onBriefRequest(c.id);
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
    wakeGate.reset(typeof micCfg?.whileSpeaking === "string" ? micCfg.whileSpeaking : "send", wakeClient.lastSeq);
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL2NvbW1hbmRzLnRzIiwgIi4uL2F1ZGlvLnRzIiwgIi4uL3JlcGxheS50cyIsICIuLi9zY3JvbGwudHMiLCAiLi4vdWkudHMiLCAiLi4vd2FrZUNsaWVudC50cyIsICIuLi9hcHAudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFNwb2tlbiBjb21tYW5kcyB0aGUgY29yZSBhY3RzIG9uIHdpdGhvdXQgdGhlIG1vZGVsOiBcInN0b3BcIiBhbmQgXCJoYW5nIHVwXCIuIEFuIHV0dGVyYW5jZSBjb3VudHNcbi8vIG9ubHkgd2hlbiBpdCBpcyBvbmUgb2YgdGhlIHBocmFzZXMgYW5kIG5vdGhpbmcgbW9yZSwgb25jZSBuYW1lcyBhbmQgZmlsbGVycyBhcm91bmQgaXQgYXJlIGdvbmUsXG4vLyBzbyBcIldvb2Rob3VzZSwgc3RvcCBwbGVhc2VcIiBzdG9wcyBhbmQgXCJzdG9wIHRoZSBQZW5ueXdvcnRoIHRhc2tcIiBnb2VzIHRvIHRoZSBtb2RlbCBhcyB1c3VhbC5cblxuaW1wb3J0IHR5cGUgeyBWb2ljZUNvbW1hbmRzIH0gZnJvbSBcIi4vdHlwZXMudHNcIjtcblxuZXhwb3J0IHR5cGUgVm9pY2VDb21tYW5kID0gXCJzdG9wXCIgfCBcImhhbmdVcFwiIHwgXCJjYW5jZWxBbGxcIjtcblxuLyoqIFdvcmRzIHRoYXQgbWF5IGNvbWUgYmVmb3JlIG9yIGFmdGVyIGEgY29tbWFuZCB3aXRob3V0IGNoYW5naW5nIGl0LiAqL1xuY29uc3QgRklMTEVSID0gbmV3IFNldChbXG4gIFwiaGV5XCIsIFwib2tcIiwgXCJva2F5XCIsIFwicGxlYXNlXCIsIFwibm93XCIsIFwianVzdFwiLCBcInNvXCIsIFwidW1cIiwgXCJ1aFwiLCBcIm9oXCIsIFwiYWxyaWdodFwiLCBcInJpZ2h0XCIsIFwieWVhaFwiLCBcInllc1wiLCBcInRoYW5rc1wiLCBcInRoYW5rXCIsIFwieW91XCIsXG4gIFwiZ2VtaW5pXCIsXG5dKTtcblxuLyoqIFt0ZXh0XSBhcyBsb3dlci1jYXNlIHdvcmRzLCBhcG9zdHJvcGhlcyBkcm9wcGVkIChcIlRoYXQnc1wiIGlzIFwidGhhdHNcIikuICovXG5leHBvcnQgZnVuY3Rpb24gd29yZHModGV4dDogc3RyaW5nKTogc3RyaW5nW10ge1xuICByZXR1cm4gdGV4dC50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL1snXHUyMDE5YF0vZywgXCJcIikucmVwbGFjZSgvW15cXHB7TH1cXHB7TmR9XSsvZ3UsIFwiIFwiKS50cmltKCkuc3BsaXQoXCIgXCIpLmZpbHRlcigodykgPT4gdy5sZW5ndGggPiAwKTtcbn1cblxuLyoqIFRoZSBjb21tYW5kIFt1dHRlcmFuY2VdIGlzLCBpZiBpdCdzIG9uZSBhbmQgbm90aGluZyBtb3JlOyBbbmFtZXNdICh0aGUgYXNzaXN0YW50J3MsIFwiV29vZGhvdXNlXCIpIGRvbid0IGNvdW50LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbW1hbmRJbih1dHRlcmFuY2U6IHN0cmluZywgY29tbWFuZHM6IFZvaWNlQ29tbWFuZHMsIG5hbWVzOiBzdHJpbmdbXSA9IFtdKTogVm9pY2VDb21tYW5kIHwgbnVsbCB7XG4gIGNvbnN0IGlnbm9yZWQgPSBuZXcgU2V0KFsuLi5GSUxMRVIsIC4uLm5hbWVzLmZsYXRNYXAod29yZHMpXSk7XG4gIGNvbnN0IHNhaWQgPSB3b3Jkcyh1dHRlcmFuY2UpO1xuICBsZXQgZnJvbSA9IDA7XG4gIGxldCB0byA9IHNhaWQubGVuZ3RoO1xuICB3aGlsZSAoZnJvbSA8IHRvICYmIGlnbm9yZWQuaGFzKHNhaWRbZnJvbV0pKSBmcm9tKys7XG4gIHdoaWxlICh0byA+IGZyb20gJiYgaWdub3JlZC5oYXMoc2FpZFt0byAtIDFdKSkgdG8tLTtcbiAgaWYgKGZyb20gPT09IHRvIHx8IHRvIC0gZnJvbSA+IDUpIHJldHVybiBudWxsO1xuICBjb25zdCBjb3JlID0gc2FpZC5zbGljZShmcm9tLCB0bykuam9pbihcIiBcIik7XG4gIGNvbnN0IGlzID0gKHBocmFzZXM6IHN0cmluZ1tdKSA9PiBwaHJhc2VzLnNvbWUoKHApID0+IHdvcmRzKHApLmpvaW4oXCIgXCIpID09PSBjb3JlKTtcbiAgaWYgKGlzKGNvbW1hbmRzLmhhbmdVcCkpIHJldHVybiBcImhhbmdVcFwiO1xuICBpZiAoaXMoY29tbWFuZHMuY2FuY2VsQWxsID8/IFtdKSkgcmV0dXJuIFwiY2FuY2VsQWxsXCI7XG4gIGlmIChpcyhjb21tYW5kcy5zdG9wKSkgcmV0dXJuIFwic3RvcFwiO1xuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqIFdvcmRzIHRoYXQgdGFrZSBhIHJlcXVlc3QgYmFjay4gKi9cbmNvbnN0IENBTkNFTFMgPSAvXFxiKD86Y2FuY2VsXFx3KnxhYm9ydFxcdyp8a2lsbHxzY3JhcHxzY3JhdGNofGRyb3B8Zm9yZ2V0fHVuZG98dGVybWluYXRlfG5ldmVyID9taW5kfGNhbGwgKD86aXR8dGhhdHx0aGlzKSBvZmZ8KD86ZG9udHxkbyBub3QpICg/OmJvdGhlcnxuZWVkfHdhbnR8ZG8pfG5vIG5lZWR8bm8gbG9uZ2VyfG5vdCBhbnltb3JlfGxlYXZlIGl0fHNraXAgKD86aXR8dGhhdCkpXFxiLztcbmNvbnN0IFNUT1BTID0gL1xcYig/OnN0b3BcXHcqfGhhbHR8cXVpdHxlbmQpXFxiLztcblxuLyoqXG4gKiBXaGV0aGVyIFt1dHRlcmFuY2VdIGFza3MgZm9yIGEgdGFzayB0byBiZSBjYW5jZWxsZWQsIGZvciBhIGNhbmNlbF90YXNrIHRoZSBtb2RlbCBjYWxsZWQgb24gaXQuIFwiU3RvcFwiIGFsb25lIGFuZCB0aGVcbiAqIG90aGVyIHN0b3AgYW5kIGhhbmctdXAgcGhyYXNlcyBkb24ndDogdGhleSBtZWFuIHN0b3AgdGFsa2luZy4gT3RoZXJ3aXNlIGl0IGRvZXMgd2hlbiBpdCBzYXlzIHNvIGluIHdvcmRzLCB3aGVuIGl0XG4gKiBuYW1lcyB0aGUgdGFzayAoW25hbWVkXSksIG9yIHdoZW4gaXQgc2F5cyB0byBzdG9wIHNvbWV0aGluZyBtb3JlIHRoYW4gdGhlIHRhbGtpbmcgKFwic3RvcCB3b3JraW5nIG9uIHRoYXRcIikuXG4gKiBXb3JkcyB0aGF0IHNheSBub25lIG9mIHRoaXMgKGEgbWlzaGVhcmluZyBzdWNoIGFzIFwiU3RhYml0XCIpIGRvbid0LiBXaXRoIG5vdGhpbmcgaGVhcmQgdGhlcmUgaXMgbm90aGluZyB0byBqdWRnZSBieS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFza3NUb0NhbmNlbCh1dHRlcmFuY2U6IHN0cmluZywgY29tbWFuZHM6IFZvaWNlQ29tbWFuZHMsIG5hbWVzOiBzdHJpbmdbXSwgbmFtZWQ6IGJvb2xlYW4pOiBib29sZWFuIHtcbiAgY29uc3Qgc2FpZCA9IHdvcmRzKHV0dGVyYW5jZSkuam9pbihcIiBcIik7XG4gIGlmIChzYWlkLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHRydWU7XG4gIGNvbnN0IGNvbW1hbmQgPSBjb21tYW5kSW4odXR0ZXJhbmNlLCBjb21tYW5kcywgbmFtZXMpO1xuICBpZiAoY29tbWFuZCA9PT0gXCJzdG9wXCIgfHwgY29tbWFuZCA9PT0gXCJoYW5nVXBcIikgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gY29tbWFuZCA9PT0gXCJjYW5jZWxBbGxcIiB8fCBuYW1lZCB8fCBDQU5DRUxTLnRlc3Qoc2FpZCkgfHwgU1RPUFMudGVzdChzYWlkKTtcbn1cbiIsICIvLyBUaGUgYnJvd3NlcidzIG1pY3JvcGhvbmUgYW5kIHNwZWFrZXIgZm9yIGEgY2FsbDogMTYga0h6IFBDTTE2IGZyYW1lcyBvdXQgb2YgdGhlIG1pY3JvcGhvbmUsXG4vLyAyNCBrSHogUENNMTYgaW50byB0aGUgc3BlYWtlciwgYW5kIHRvbmVzIGxhaWQgb3ZlciB3aGF0ZXZlciBwbGF5cy4gQm90aCBydW4gaW4gQXVkaW9Xb3JrbGV0cyBvblxuLy8gb25lIEF1ZGlvQ29udGV4dCBhdCB0aGUgZGV2aWNlJ3MgcmF0ZSwgcmVzYW1wbGluZyB0aGVyZS5cblxuY29uc3QgV09SS0xFVFMgPSBgXG5jbGFzcyBDYXB0dXJlIGV4dGVuZHMgQXVkaW9Xb3JrbGV0UHJvY2Vzc29yIHtcbiAgY29uc3RydWN0b3IoKSB7XG4gICAgc3VwZXIoKTtcbiAgICB0aGlzLnN0ZXAgPSBzYW1wbGVSYXRlIC8gMTYwMDA7XG4gICAgdGhpcy5wb3MgPSAwO1xuICAgIHRoaXMuZnJhbWUgPSBuZXcgSW50MTZBcnJheSgzMjApO1xuICAgIHRoaXMubiA9IDA7XG4gICAgLy8gQSB3aW5kb3dlZC1zaW5jIGxvdy1wYXNzIGF0IDcga0h6LCBzbyBub3RoaW5nIGFib3ZlIDE2IGtIeidzIDgga0h6IGxpbWl0IGZvbGRzIGJhY2sgaW50byBzcGVlY2guXG4gICAgY29uc3QgdGFwcyA9IDQ3LCBjdXQgPSA3MDAwIC8gc2FtcGxlUmF0ZTtcbiAgICB0aGlzLnRhcHMgPSBuZXcgRmxvYXQzMkFycmF5KHRhcHMpO1xuICAgIGxldCBzdW0gPSAwO1xuICAgIGZvciAobGV0IGsgPSAwOyBrIDwgdGFwczsgaysrKSB7XG4gICAgICBjb25zdCBtID0gayAtICh0YXBzIC0gMSkgLyAyO1xuICAgICAgY29uc3Qgc2luYyA9IG0gPT09IDAgPyAyICogY3V0IDogTWF0aC5zaW4oMiAqIE1hdGguUEkgKiBjdXQgKiBtKSAvIChNYXRoLlBJICogbSk7XG4gICAgICBjb25zdCB3ID0gMC40MiAtIDAuNSAqIE1hdGguY29zKCgyICogTWF0aC5QSSAqIGspIC8gKHRhcHMgLSAxKSkgKyAwLjA4ICogTWF0aC5jb3MoKDQgKiBNYXRoLlBJICogaykgLyAodGFwcyAtIDEpKTtcbiAgICAgIHRoaXMudGFwc1trXSA9IHNpbmMgKiB3O1xuICAgICAgc3VtICs9IHRoaXMudGFwc1trXTtcbiAgICB9XG4gICAgZm9yIChsZXQgayA9IDA7IGsgPCB0YXBzOyBrKyspIHRoaXMudGFwc1trXSAvPSBzdW07XG4gICAgdGhpcy5oaXN0b3J5ID0gbmV3IEZsb2F0MzJBcnJheSh0YXBzKTtcbiAgICB0aGlzLmF0ID0gMDtcbiAgfVxuICBwcm9jZXNzKGlucHV0cykge1xuICAgIGNvbnN0IGlucHV0ID0gaW5wdXRzWzBdICYmIGlucHV0c1swXVswXTtcbiAgICBpZiAoIWlucHV0KSByZXR1cm4gdHJ1ZTtcbiAgICBjb25zdCB0YXBzID0gdGhpcy50YXBzLCBoID0gdGhpcy5oaXN0b3J5LCBuID0gdGFwcy5sZW5ndGg7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBpbnB1dC5sZW5ndGg7IGkrKykge1xuICAgICAgaFt0aGlzLmF0XSA9IGlucHV0W2ldO1xuICAgICAgdGhpcy5hdCA9ICh0aGlzLmF0ICsgMSkgJSBuO1xuICAgICAgLy8gT25seSB0aGUgc2FtcGxlcyBrZXB0IG5lZWQgZmlsdGVyaW5nOiBhdCBtb3N0IG9uZSBpbiBldmVyeSBzdGVwLlxuICAgICAgaWYgKHRoaXMucG9zID4gMSkgeyB0aGlzLnBvcyAtPSAxOyBjb250aW51ZTsgfVxuICAgICAgbGV0IHggPSAwO1xuICAgICAgZm9yIChsZXQgayA9IDAsIGogPSB0aGlzLmF0OyBrIDwgbjsgaysrLCBqID0gaiArIDEgPT09IG4gPyAwIDogaiArIDEpIHggKz0gdGFwc1trXSAqIGhbal07XG4gICAgICB3aGlsZSAodGhpcy5wb3MgPD0gMSkge1xuICAgICAgICBjb25zdCBzID0gTWF0aC5tYXgoLTEsIE1hdGgubWluKDEsIHgpKTtcbiAgICAgICAgdGhpcy5mcmFtZVt0aGlzLm4rK10gPSBzIDwgMCA/IHMgKiAzMjc2OCA6IHMgKiAzMjc2NztcbiAgICAgICAgaWYgKHRoaXMubiA9PT0gdGhpcy5mcmFtZS5sZW5ndGgpIHtcbiAgICAgICAgICB0aGlzLnBvcnQucG9zdE1lc3NhZ2UodGhpcy5mcmFtZS5idWZmZXIsIFt0aGlzLmZyYW1lLmJ1ZmZlcl0pO1xuICAgICAgICAgIHRoaXMuZnJhbWUgPSBuZXcgSW50MTZBcnJheSgzMjApO1xuICAgICAgICAgIHRoaXMubiA9IDA7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5wb3MgKz0gdGhpcy5zdGVwO1xuICAgICAgfVxuICAgICAgdGhpcy5wb3MgLT0gMTtcbiAgICB9XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbn1cblxuY2xhc3MgUGxheWJhY2sgZXh0ZW5kcyBBdWRpb1dvcmtsZXRQcm9jZXNzb3Ige1xuICBjb25zdHJ1Y3RvcigpIHtcbiAgICBzdXBlcigpO1xuICAgIHRoaXMucXVldWUgPSBbXTsgICAgICAvLyBGbG9hdDMyQXJyYXlzIGF0IHRoZSBjb250ZXh0J3MgcmF0ZVxuICAgIHRoaXMub2Zmc2V0ID0gMDtcbiAgICB0aGlzLmN1ZXMgPSBbXTtcbiAgICB0aGlzLmN1ZU9mZnNldCA9IDA7XG4gICAgdGhpcy5yZXBvcnRlZCA9IDA7XG4gICAgdGhpcy5wb3J0Lm9ubWVzc2FnZSA9IChlKSA9PiB7XG4gICAgICBjb25zdCBtID0gZS5kYXRhO1xuICAgICAgaWYgKG0udHlwZSA9PT0gXCJwbGF5XCIpIHRoaXMucXVldWUucHVzaChtLnNhbXBsZXMpO1xuICAgICAgZWxzZSBpZiAobS50eXBlID09PSBcImN1ZVwiKSB0aGlzLmN1ZXMucHVzaChtLnNhbXBsZXMpO1xuICAgICAgZWxzZSBpZiAobS50eXBlID09PSBcImZsdXNoXCIpIHsgdGhpcy5xdWV1ZSA9IFtdOyB0aGlzLm9mZnNldCA9IDA7IH1cbiAgICAgIGVsc2UgaWYgKG0udHlwZSA9PT0gXCJzdG9wXCIpIHsgdGhpcy5xdWV1ZSA9IFtdOyB0aGlzLm9mZnNldCA9IDA7IHRoaXMuY3VlcyA9IFtdOyB0aGlzLmN1ZU9mZnNldCA9IDA7IH1cbiAgICB9O1xuICB9XG4gIHByb2Nlc3MoXywgb3V0cHV0cykge1xuICAgIGNvbnN0IG91dCA9IG91dHB1dHNbMF1bMF07XG4gICAgb3V0LmZpbGwoMCk7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoICYmIHRoaXMucXVldWUubGVuZ3RoOyBpKyspIHtcbiAgICAgIG91dFtpXSA9IHRoaXMucXVldWVbMF1bdGhpcy5vZmZzZXQrK107XG4gICAgICBpZiAodGhpcy5vZmZzZXQgPj0gdGhpcy5xdWV1ZVswXS5sZW5ndGgpIHsgdGhpcy5xdWV1ZS5zaGlmdCgpOyB0aGlzLm9mZnNldCA9IDA7IH1cbiAgICB9XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoICYmIHRoaXMuY3Vlcy5sZW5ndGg7IGkrKykge1xuICAgICAgb3V0W2ldID0gTWF0aC5tYXgoLTEsIE1hdGgubWluKDEsIG91dFtpXSArIHRoaXMuY3Vlc1swXVt0aGlzLmN1ZU9mZnNldCsrXSkpO1xuICAgICAgaWYgKHRoaXMuY3VlT2Zmc2V0ID49IHRoaXMuY3Vlc1swXS5sZW5ndGgpIHsgdGhpcy5jdWVzLnNoaWZ0KCk7IHRoaXMuY3VlT2Zmc2V0ID0gMDsgfVxuICAgIH1cbiAgICBmb3IgKGxldCBjID0gMTsgYyA8IG91dHB1dHNbMF0ubGVuZ3RoOyBjKyspIG91dHB1dHNbMF1bY10uc2V0KG91dCk7XG4gICAgaWYgKGN1cnJlbnRUaW1lIC0gdGhpcy5yZXBvcnRlZCA+IDAuMSkge1xuICAgICAgdGhpcy5yZXBvcnRlZCA9IGN1cnJlbnRUaW1lO1xuICAgICAgbGV0IHF1ZXVlZCA9IC10aGlzLm9mZnNldDtcbiAgICAgIGZvciAoY29uc3QgcSBvZiB0aGlzLnF1ZXVlKSBxdWV1ZWQgKz0gcS5sZW5ndGg7XG4gICAgICB0aGlzLnBvcnQucG9zdE1lc3NhZ2UoeyBxdWV1ZWQ6IHF1ZXVlZCAvIHNhbXBsZVJhdGUgfSk7XG4gICAgfVxuICAgIHJldHVybiB0cnVlO1xuICB9XG59XG5yZWdpc3RlclByb2Nlc3NvcihcImNhcHR1cmVcIiwgQ2FwdHVyZSk7XG5yZWdpc3RlclByb2Nlc3NvcihcInBsYXliYWNrXCIsIFBsYXliYWNrKTtcbmA7XG5cbmZ1bmN0aW9uIGJhc2U2NFRvQnl0ZXMoYjY0OiBzdHJpbmcpOiBVaW50OEFycmF5IHtcbiAgY29uc3QgYmluID0gYXRvYihiNjQpO1xuICBjb25zdCBvdXQgPSBuZXcgVWludDhBcnJheShiaW4ubGVuZ3RoKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBiaW4ubGVuZ3RoOyBpKyspIG91dFtpXSA9IGJpbi5jaGFyQ29kZUF0KGkpO1xuICByZXR1cm4gb3V0O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYnl0ZXNUb0Jhc2U2NChieXRlczogVWludDhBcnJheSk6IHN0cmluZyB7XG4gIGxldCBiaW4gPSBcIlwiO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGJ5dGVzLmxlbmd0aDsgaSArPSAweDgwMDApIGJpbiArPSBTdHJpbmcuZnJvbUNoYXJDb2RlKC4uLmJ5dGVzLnN1YmFycmF5KGksIGkgKyAweDgwMDApKTtcbiAgcmV0dXJuIGJ0b2EoYmluKTtcbn1cblxuLyoqIFBDTTE2IGxpdHRsZS1lbmRpYW4gYXQgW3JhdGVdLCBhcyBmbG9hdHMgYXQgdGhlIGNvbnRleHQncyByYXRlLiAqL1xuZnVuY3Rpb24gdG9GbG9hdHMocGNtOiBVaW50OEFycmF5LCByYXRlOiBudW1iZXIsIHRhcmdldDogbnVtYmVyKTogRmxvYXQzMkFycmF5IHtcbiAgY29uc3QgdmlldyA9IG5ldyBEYXRhVmlldyhwY20uYnVmZmVyLCBwY20uYnl0ZU9mZnNldCwgcGNtLmJ5dGVMZW5ndGgpO1xuICBjb25zdCBuID0gTWF0aC5mbG9vcihwY20uYnl0ZUxlbmd0aCAvIDIpO1xuICBjb25zdCBvdXQgPSBuZXcgRmxvYXQzMkFycmF5KE1hdGguZmxvb3IoKG4gKiB0YXJnZXQpIC8gcmF0ZSkpO1xuICBjb25zdCBzdGVwID0gcmF0ZSAvIHRhcmdldDtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCB4ID0gaSAqIHN0ZXA7XG4gICAgY29uc3QgaiA9IE1hdGguZmxvb3IoeCk7XG4gICAgY29uc3QgYSA9IHZpZXcuZ2V0SW50MTYoMiAqIE1hdGgubWluKGosIG4gLSAxKSwgdHJ1ZSk7XG4gICAgY29uc3QgYiA9IHZpZXcuZ2V0SW50MTYoMiAqIE1hdGgubWluKGogKyAxLCBuIC0gMSksIHRydWUpO1xuICAgIG91dFtpXSA9IChhICsgKGIgLSBhKSAqICh4IC0gaikpIC8gMzI3Njg7XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBNaWNPcHRpb25zIHsgZWNob0NhbmNlbGxhdGlvbjogYm9vbGVhbjsgbm9pc2VTdXBwcmVzc2lvbjogYm9vbGVhbjsgYXV0b0dhaW5Db250cm9sOiBib29sZWFuIH1cblxuZXhwb3J0IGNsYXNzIENhbGxBdWRpbyB7XG4gIHByaXZhdGUgY29udGV4dDogQXVkaW9Db250ZXh0IHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgcGxheWJhY2s6IEF1ZGlvV29ya2xldE5vZGUgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBjYXB0dXJlOiBBdWRpb1dvcmtsZXROb2RlIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgc3RyZWFtOiBNZWRpYVN0cmVhbSB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIHNvdXJjZTogTWVkaWFTdHJlYW1BdWRpb1NvdXJjZU5vZGUgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBtaWNPcHRzOiBNaWNPcHRpb25zIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgb25NaWNGcmFtZTogKChzYW1wbGVzOiBJbnQxNkFycmF5LCBsZXZlbDogbnVtYmVyKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuICAvKiogSW5jcmVtZW50ZWQgb24gZXZlcnkgc3RhcnRNaWMvc3RvcE1pYyBzbyBzdXBlcnNlZGVkIG9yIGNhbmNlbGxlZCBnZXRVc2VyTWVkaWEgY2FsbHMgbmV2ZXIgbGVhayB0cmFja3MuICovXG4gIHByaXZhdGUgbWljR2VuID0gMDtcbiAgcHJpdmF0ZSBvcGVuaW5nOiBQcm9taXNlPHZvaWQ+IHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgc3RhdGVMaXN0ZW5lcjogKCgpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XG4gIC8qKiBTZWNvbmRzIG9mIHNwZWVjaCBxdWV1ZWQsIGFzIHRoZSB3b3JrbGV0IGxhc3Qgc2FpZC4gKi9cbiAgcXVldWVkID0gMDtcbiAgLyoqIFRoZSBtaWNyb3Bob25lJ3MgbGV2ZWwsIFJNUyBvZiB0aGUgbGFzdCBmcmFtZSAoMCB0byAxKS4gKi9cbiAgbGV2ZWwgPSAwO1xuXG4gIG9uQXVkaW9TdGF0ZUNoYW5nZShsaXN0ZW5lcjogKCgpID0+IHZvaWQpIHwgbnVsbCk6IHZvaWQge1xuICAgIHRoaXMuc3RhdGVMaXN0ZW5lciA9IGxpc3RlbmVyO1xuICB9XG5cbiAgLyoqIFRydWUgd2hlbiBhbiBBdWRpb0NvbnRleHQgZXhpc3RzIGJ1dCB0aGUgYnJvd3NlciBzdXNwZW5kZWQgaXQgcGVuZGluZyBhIHVzZXIgZ2VzdHVyZS4gKi9cbiAgZ2V0IGF1ZGlvU3VzcGVuZGVkKCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLmNvbnRleHQgIT0gbnVsbCAmJiB0aGlzLmNvbnRleHQuc3RhdGUgIT09IFwicnVubmluZ1wiO1xuICB9XG5cbiAgYXN5bmMgcmVzdW1lQXVkaW8oKTogUHJvbWlzZTxib29sZWFuPiB7XG4gICAgY29uc3QgY3R4ID0gdGhpcy5jb250ZXh0O1xuICAgIGlmICghY3R4KSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKGN0eC5zdGF0ZSA9PT0gXCJydW5uaW5nXCIpIHJldHVybiB0cnVlO1xuICAgIHRyeSB7IGF3YWl0IGN0eC5yZXN1bWUoKTsgfSBjYXRjaCB7fVxuICAgIHJldHVybiAoY3R4LnN0YXRlIGFzIEF1ZGlvQ29udGV4dFN0YXRlKSA9PT0gXCJydW5uaW5nXCI7XG4gIH1cblxuICBhc3luYyBvcGVuKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICh0aGlzLm9wZW5pbmcpIHtcbiAgICAgIGF3YWl0IHRoaXMub3BlbmluZztcbiAgICAgIGlmICh0aGlzLmNvbnRleHQ/LnN0YXRlID09PSBcInN1c3BlbmRlZFwiKSBhd2FpdCB0aGlzLmNvbnRleHQucmVzdW1lKCkuY2F0Y2goKCkgPT4ge30pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAodGhpcy5jb250ZXh0KSB7IGlmICh0aGlzLmNvbnRleHQuc3RhdGUgPT09IFwic3VzcGVuZGVkXCIpIGF3YWl0IHRoaXMuY29udGV4dC5yZXN1bWUoKS5jYXRjaCgoKSA9PiB7fSk7IHJldHVybjsgfVxuICAgIGNvbnN0IGluaXQgPSAoYXN5bmMgKCkgPT4ge1xuICAgICAgbGV0IGN0eDogQXVkaW9Db250ZXh0IHwgbnVsbCA9IG51bGw7XG4gICAgICB0cnkge1xuICAgICAgICBjdHggPSBuZXcgQXVkaW9Db250ZXh0KHsgbGF0ZW5jeUhpbnQ6IFwiaW50ZXJhY3RpdmVcIiB9KTtcbiAgICAgICAgY3R4Lm9uc3RhdGVjaGFuZ2UgPSAoKSA9PiB0aGlzLnN0YXRlTGlzdGVuZXI/LigpO1xuICAgICAgICBjb25zdCB1cmwgPSBVUkwuY3JlYXRlT2JqZWN0VVJMKG5ldyBCbG9iKFtXT1JLTEVUU10sIHsgdHlwZTogXCJ0ZXh0L2phdmFzY3JpcHRcIiB9KSk7XG4gICAgICAgIGF3YWl0IGN0eC5hdWRpb1dvcmtsZXQuYWRkTW9kdWxlKHVybCk7XG4gICAgICAgIGNvbnN0IHBsYXliYWNrID0gbmV3IEF1ZGlvV29ya2xldE5vZGUoY3R4LCBcInBsYXliYWNrXCIsIHsgbnVtYmVyT2ZJbnB1dHM6IDAsIG91dHB1dENoYW5uZWxDb3VudDogWzJdIH0pO1xuICAgICAgICBwbGF5YmFjay5wb3J0Lm9ubWVzc2FnZSA9IChlKSA9PiB7IHRoaXMucXVldWVkID0gZS5kYXRhLnF1ZXVlZDsgfTtcbiAgICAgICAgcGxheWJhY2suY29ubmVjdChjdHguZGVzdGluYXRpb24pO1xuICAgICAgICB0aGlzLmNvbnRleHQgPSBjdHg7XG4gICAgICAgIHRoaXMucGxheWJhY2sgPSBwbGF5YmFjaztcbiAgICAgICAgdGhpcy5zdGF0ZUxpc3RlbmVyPy4oKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICB0cnkgeyBhd2FpdCBjdHg/LmNsb3NlPy4oKTsgfSBjYXRjaCB7fVxuICAgICAgICB0aHJvdyBlcnI7XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICB0aGlzLm9wZW5pbmcgPSBudWxsO1xuICAgICAgfVxuICAgIH0pKCk7XG4gICAgdGhpcy5vcGVuaW5nID0gaW5pdDtcbiAgICBhd2FpdCBpbml0O1xuICB9XG5cbiAgLyoqIFNlY29uZHMgZnJvbSBhIHNhbXBsZSBsZWF2aW5nIHRoZSB3b3JrbGV0IHRvIHRoZSBzcGVha2VyLCBhcyB0aGUgYnJvd3NlciByZWNrb25zIGl0LiAqL1xuICBnZXQgb3V0cHV0TGF0ZW5jeSgpOiBudW1iZXIgfCBudWxsIHtcbiAgICBpZiAoIXRoaXMuY29udGV4dCkgcmV0dXJuIG51bGw7XG4gICAgcmV0dXJuIHRoaXMuY29udGV4dC5iYXNlTGF0ZW5jeSArICgodGhpcy5jb250ZXh0IGFzIEF1ZGlvQ29udGV4dCAmIHsgb3V0cHV0TGF0ZW5jeT86IG51bWJlciB9KS5vdXRwdXRMYXRlbmN5ID8/IDApO1xuICB9XG5cbiAgZ2V0IG1pY0FjdGl2ZSgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5jYXB0dXJlICE9IG51bGwgJiYgdGhpcy5zdHJlYW0gIT0gbnVsbCAmJiB0aGlzLnN0cmVhbS5nZXRUcmFja3MoKS5zb21lKCh0KSA9PiB0LnJlYWR5U3RhdGUgPT09IFwibGl2ZVwiKTtcbiAgfVxuXG4gIC8qKiBTdGFydHMgdGhlIG1pY3JvcGhvbmUgaWYgaXQgaXNuJ3QgYWxyZWFkeSBydW5uaW5nIHdpdGggdGhlIHNhbWUgb3B0aW9uczsgb3RoZXJ3aXNlIHN3YXBzIHRoZSBmcmFtZSBjYWxsYmFjayBjbGVhbmx5LiAqL1xuICBhc3luYyBlbnN1cmVNaWMob25GcmFtZTogKHNhbXBsZXM6IEludDE2QXJyYXksIGxldmVsOiBudW1iZXIpID0+IHZvaWQsIG9wdGlvbnM6IE1pY09wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAoXG4gICAgICB0aGlzLm1pY0FjdGl2ZSAmJlxuICAgICAgdGhpcy5taWNPcHRzICYmXG4gICAgICB0aGlzLm1pY09wdHMuZWNob0NhbmNlbGxhdGlvbiA9PT0gb3B0aW9ucy5lY2hvQ2FuY2VsbGF0aW9uICYmXG4gICAgICB0aGlzLm1pY09wdHMubm9pc2VTdXBwcmVzc2lvbiA9PT0gb3B0aW9ucy5ub2lzZVN1cHByZXNzaW9uICYmXG4gICAgICB0aGlzLm1pY09wdHMuYXV0b0dhaW5Db250cm9sID09PSBvcHRpb25zLmF1dG9HYWluQ29udHJvbFxuICAgICkge1xuICAgICAgYXdhaXQgdGhpcy5vcGVuKCk7XG4gICAgICB0aGlzLm9uTWljRnJhbWUgPSBvbkZyYW1lO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBhd2FpdCB0aGlzLnN0YXJ0TWljKG9uRnJhbWUsIG9wdGlvbnMpO1xuICB9XG5cbiAgYXN5bmMgc3RhcnRNaWMob25GcmFtZTogKHNhbXBsZXM6IEludDE2QXJyYXksIGxldmVsOiBudW1iZXIpID0+IHZvaWQsIG9wdGlvbnM6IE1pY09wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICB0aGlzLnN0b3BNaWMoKTtcbiAgICBjb25zdCBnZW4gPSArK3RoaXMubWljR2VuO1xuICAgIGF3YWl0IHRoaXMub3BlbigpO1xuICAgIGlmIChnZW4gIT09IHRoaXMubWljR2VuKSByZXR1cm47XG4gICAgY29uc3QgY29udGV4dCA9IHRoaXMuY29udGV4dCE7XG4gICAgY29uc3Qgc3RyZWFtID0gYXdhaXQgbmF2aWdhdG9yLm1lZGlhRGV2aWNlcy5nZXRVc2VyTWVkaWEoeyBhdWRpbzogeyBjaGFubmVsQ291bnQ6IDEsIC4uLm9wdGlvbnMgfSB9KTtcbiAgICBpZiAoZ2VuICE9PSB0aGlzLm1pY0dlbikge1xuICAgICAgc3RyZWFtLmdldFRyYWNrcygpLmZvckVhY2goKHQpID0+IHQuc3RvcCgpKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgbGV0IHNvdXJjZTogTWVkaWFTdHJlYW1BdWRpb1NvdXJjZU5vZGUgfCBudWxsID0gbnVsbDtcbiAgICBsZXQgY2FwdHVyZTogQXVkaW9Xb3JrbGV0Tm9kZSB8IG51bGwgPSBudWxsO1xuICAgIHRyeSB7XG4gICAgICBzb3VyY2UgPSBjb250ZXh0LmNyZWF0ZU1lZGlhU3RyZWFtU291cmNlKHN0cmVhbSk7XG4gICAgICBjYXB0dXJlID0gbmV3IEF1ZGlvV29ya2xldE5vZGUoY29udGV4dCwgXCJjYXB0dXJlXCIsIHsgbnVtYmVyT2ZPdXRwdXRzOiAwIH0pO1xuICAgICAgY2FwdHVyZS5wb3J0Lm9ubWVzc2FnZSA9IChlKSA9PiB7XG4gICAgICAgIGNvbnN0IGZyYW1lID0gbmV3IEludDE2QXJyYXkoZS5kYXRhIGFzIEFycmF5QnVmZmVyKTtcbiAgICAgICAgbGV0IHN1bSA9IDA7XG4gICAgICAgIGZvciAoY29uc3QgcyBvZiBmcmFtZSkgc3VtICs9IHMgKiBzO1xuICAgICAgICB0aGlzLmxldmVsID0gTWF0aC5zcXJ0KHN1bSAvIGZyYW1lLmxlbmd0aCkgLyAzMjc2ODtcbiAgICAgICAgdGhpcy5vbk1pY0ZyYW1lPy4oZnJhbWUsIHRoaXMubGV2ZWwpO1xuICAgICAgfTtcbiAgICAgIHNvdXJjZS5jb25uZWN0KGNhcHR1cmUpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgc291cmNlPy5kaXNjb25uZWN0KCk7XG4gICAgICBjYXB0dXJlPy5wb3J0LmNsb3NlKCk7XG4gICAgICBzdHJlYW0uZ2V0VHJhY2tzKCkuZm9yRWFjaCgodCkgPT4gdC5zdG9wKCkpO1xuICAgICAgdGhyb3cgZXJyO1xuICAgIH1cbiAgICB0aGlzLnN0cmVhbSA9IHN0cmVhbTtcbiAgICB0aGlzLm1pY09wdHMgPSB7IC4uLm9wdGlvbnMgfTtcbiAgICB0aGlzLm9uTWljRnJhbWUgPSBvbkZyYW1lO1xuICAgIHRoaXMuc291cmNlID0gc291cmNlO1xuICAgIHRoaXMuY2FwdHVyZSA9IGNhcHR1cmU7XG4gIH1cblxuICBzdG9wTWljKCk6IHZvaWQge1xuICAgIHRoaXMubWljR2VuKys7XG4gICAgdGhpcy5zb3VyY2U/LmRpc2Nvbm5lY3QoKTtcbiAgICB0aGlzLmNhcHR1cmU/LnBvcnQuY2xvc2UoKTtcbiAgICB0aGlzLnN0cmVhbT8uZ2V0VHJhY2tzKCkuZm9yRWFjaCgodCkgPT4gdC5zdG9wKCkpO1xuICAgIHRoaXMuc291cmNlID0gbnVsbDtcbiAgICB0aGlzLmNhcHR1cmUgPSBudWxsO1xuICAgIHRoaXMuc3RyZWFtID0gbnVsbDtcbiAgICB0aGlzLm1pY09wdHMgPSBudWxsO1xuICAgIHRoaXMub25NaWNGcmFtZSA9IG51bGw7XG4gICAgdGhpcy5sZXZlbCA9IDA7XG4gIH1cblxuICBwbGF5KHBjbTY0OiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuY29udGV4dCB8fCAhdGhpcy5wbGF5YmFjaykgcmV0dXJuO1xuICAgIGNvbnN0IHNhbXBsZXMgPSB0b0Zsb2F0cyhiYXNlNjRUb0J5dGVzKHBjbTY0KSwgMjQwMDAsIHRoaXMuY29udGV4dC5zYW1wbGVSYXRlKTtcbiAgICB0aGlzLnBsYXliYWNrLnBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcInBsYXlcIiwgc2FtcGxlcyB9LCBbc2FtcGxlcy5idWZmZXJdKTtcbiAgfVxuXG4gIGN1ZShwY202NDogc3RyaW5nKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLmNvbnRleHQgfHwgIXRoaXMucGxheWJhY2spIHJldHVybjtcbiAgICBjb25zdCBzYW1wbGVzID0gdG9GbG9hdHMoYmFzZTY0VG9CeXRlcyhwY202NCksIDI0MDAwLCB0aGlzLmNvbnRleHQuc2FtcGxlUmF0ZSk7XG4gICAgdGhpcy5wbGF5YmFjay5wb3J0LnBvc3RNZXNzYWdlKHsgdHlwZTogXCJjdWVcIiwgc2FtcGxlcyB9LCBbc2FtcGxlcy5idWZmZXJdKTtcbiAgfVxuXG4gIGZsdXNoKCk6IHZvaWQge1xuICAgIHRoaXMucGxheWJhY2s/LnBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcImZsdXNoXCIgfSk7XG4gIH1cblxuICBzdG9wUGxheWJhY2soKTogdm9pZCB7XG4gICAgdGhpcy5wbGF5YmFjaz8ucG9ydC5wb3N0TWVzc2FnZSh7IHR5cGU6IFwic3RvcFwiIH0pO1xuICAgIHRoaXMucXVldWVkID0gMDtcbiAgfVxuXG4gIHN0b3AoKTogdm9pZCB7XG4gICAgdGhpcy5zdG9wTWljKCk7XG4gICAgdGhpcy5zdG9wUGxheWJhY2soKTtcbiAgfVxufVxuIiwgIi8vIFRoZSByZXBsYXkgdmlldzogYSByZWNvcmRlZCBjYWxsIChhIHRyYWNlIGZyb20gYW55IGhvc3QsIG9yIGEgc2NlbmFyaW8pIHJ1biBhZ2FpbiB0aHJvdWdoIHRoZVxuLy8gY29yZSwgYXMgdGhlIGJ1aWxkIHRoYXQgcmVjb3JkZWQgaXQgZGlkIGFuZCBhcyB0aGUgbGF0ZXN0IGRvZXMsIHNpZGUgYnkgc2lkZS4gV2hlcmUgdGhleSBwYXJ0XG4vLyBpcyB3aGVyZSBhIGNoYW5nZSBpbiBzcmMvIGNoYW5nZWQgd2hhdCB0aGUgY2FsbCBkb2VzIHdpdGggdGhlIHNhbWUgd29yZHMgYW5kIHRoZSBzYW1lIG1vZGVsLlxuXG5pbnRlcmZhY2UgQ29yZSB7XG4gIHZlcnNpb246IHN0cmluZztcbiAgY3JlYXRlKGNvbmZpZzogc3RyaW5nLCB0OiBudW1iZXIpOiBzdHJpbmc7XG4gIHB1c2goaWQ6IG51bWJlciwgZXZlbnQ6IHN0cmluZyk6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFJlY29yZGluZyB7IHZlcnNpb24/OiBzdHJpbmc7IGNvbmZpZzogdW5rbm93bjsgc3RhcnQ6IG51bWJlcjsgZXZlbnRzOiBSZWNvcmQ8c3RyaW5nLCBhbnk+W10gfVxuXG4vKiogV2hhdCBhIGNvbW1hbmQgb3IgZXZlbnQgbG9va3MgbGlrZSBpbiBhIHRpbWVsaW5lOiBhdWRpbyBjdXQgb3V0LCBvbmUgbGluZS4gKi9cbmZ1bmN0aW9uIGxpbmUobzogUmVjb3JkPHN0cmluZywgYW55Pik6IHN0cmluZyB7XG4gIGNvbnN0IHRleHQgPSBKU09OLnN0cmluZ2lmeShvKS5yZXBsYWNlKC9cIihkYXRhfHBjbSlcIjpcIltBLVphLXowLTkrLz1dezQwLH1cIi9nLCAnXCIkMVwiOlwiXHUyMDI2XCInKVxuICAgIC5yZXBsYWNlKC9cXFxcXCJkYXRhXFxcXFwiOlxcXFxcIltBLVphLXowLTkrLz1dezQwLH1cXFxcXCIvZywgJ1xcXFxcImRhdGFcXFxcXCI6XFxcXFwiXHUyMDI2XFxcXFwiJyk7XG4gIHJldHVybiB0ZXh0Lmxlbmd0aCA+IDQwMCA/IHRleHQuc2xpY2UoMCwgNDAwKSArIFwiXHUyMDI2XCIgOiB0ZXh0O1xufVxuXG4vKiogQXVkaW8gYW5kIHRpY2tzIHNheSBub3RoaW5nIGEgcmVhZGVyIG5lZWRzOyB0aGUgcmVzdCBkb2VzLiAqL1xuZnVuY3Rpb24gdGVsbGluZyhvOiBSZWNvcmQ8c3RyaW5nLCBhbnk+KTogYm9vbGVhbiB7XG4gIGlmIChvLnR5cGUgPT09IFwibWljXCIgfHwgby50eXBlID09PSBcInRpY2tcIiB8fCBvLnR5cGUgPT09IFwicGxheVwiKSByZXR1cm4gZmFsc2U7XG4gIGlmIChvLnR5cGUgPT09IFwid3Muc2VuZFwiICYmIFN0cmluZyhvLmRhdGEpLnN0YXJ0c1dpdGgoJ3tcInJlYWx0aW1lSW5wdXRcIjp7XCJhdWRpb1wiJykpIHJldHVybiBmYWxzZTtcbiAgaWYgKG8udHlwZSA9PT0gXCJ3cy5tZXNzYWdlXCIgJiYgU3RyaW5nKG8uZGF0YSkuaW5jbHVkZXMoJ1wiaW5saW5lRGF0YVwiJykgJiYgIVN0cmluZyhvLmRhdGEpLmluY2x1ZGVzKCdcInR1cm5Db21wbGV0ZVwiJykpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmZ1bmN0aW9uIHJ1bihjb3JlOiBDb3JlLCByOiBSZWNvcmRpbmcpOiBzdHJpbmdbXVtdIHtcbiAgY29uc3QgY3JlYXRlZCA9IEpTT04ucGFyc2UoY29yZS5jcmVhdGUoSlNPTi5zdHJpbmdpZnkoci5jb25maWcpLCByLnN0YXJ0KSk7XG4gIGNvbnN0IG91dDogc3RyaW5nW11bXSA9IFtjcmVhdGVkLmNvbW1hbmRzLmZpbHRlcih0ZWxsaW5nKS5tYXAobGluZSldO1xuICBmb3IgKGNvbnN0IGUgb2Ygci5ldmVudHMpIG91dC5wdXNoKChKU09OLnBhcnNlKGNvcmUucHVzaChjcmVhdGVkLmlkLCBKU09OLnN0cmluZ2lmeShlKSkpIGFzIFJlY29yZDxzdHJpbmcsIGFueT5bXSkuZmlsdGVyKHRlbGxpbmcpLm1hcChsaW5lKSk7XG4gIHJldHVybiBvdXQ7XG59XG5cbmV4cG9ydCBjbGFzcyBSZXBsYXkge1xuICBwcml2YXRlIHJlYWRvbmx5IHJvb3Q6IEhUTUxFbGVtZW50O1xuICBwcml2YXRlIHJlYWRvbmx5IGxvYWQ6ICh1cmw/OiBzdHJpbmcpID0+IFByb21pc2U8Q29yZT47XG5cbiAgY29uc3RydWN0b3Iocm9vdDogSFRNTEVsZW1lbnQsIGxvYWQ6ICh1cmw/OiBzdHJpbmcpID0+IFByb21pc2U8Q29yZT4pIHtcbiAgICB0aGlzLnJvb3QgPSByb290O1xuICAgIHRoaXMubG9hZCA9IGxvYWQ7XG4gICAgcm9vdC5pbm5lckhUTUwgPSBgXG4gICAgICA8aDI+VHJhY2UgcmVwbGF5PC9oMj5cbiAgICAgIDxkaXYgY2xhc3M9XCJiYXJcIj48c2VsZWN0IGNsYXNzPVwicGlja1wiIGFyaWEtbGFiZWw9XCJSZWNvcmRpbmdcIj48L3NlbGVjdD48YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cInJlZnJlc2hcIiB0aXRsZT1cIlJlZnJlc2ggbGlzdFwiIGFyaWEtbGFiZWw9XCJSZWZyZXNoIGxpc3RcIj5cdTIxQkI8L2J1dHRvbj48YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cImdvXCI+UmVwbGF5PC9idXR0b24+XG4gICAgICA8bGFiZWwgY2xhc3M9XCJ0b2dnbGUtYWxsXCI+PGlucHV0IHR5cGU9XCJjaGVja2JveFwiIGNsYXNzPVwiYWxsXCI+IFNob3cgYXVkaW8gYW5kIHRpY2tzPC9sYWJlbD48c3BhbiBjbGFzcz1cInN1bW1hcnlcIj48L3NwYW4+PC9kaXY+XG4gICAgICA8ZGl2IGNsYXNzPVwidGltZWxpbmVcIj48L2Rpdj5gO1xuICAgIChyb290LnF1ZXJ5U2VsZWN0b3IoXCIucmVmcmVzaFwiKSBhcyBIVE1MRWxlbWVudCkub25jbGljayA9ICgpID0+IHZvaWQgdGhpcy5saXN0KCk7XG4gICAgKHJvb3QucXVlcnlTZWxlY3RvcihcIi5nb1wiKSBhcyBIVE1MRWxlbWVudCkub25jbGljayA9ICgpID0+IHZvaWQgdGhpcy5yZXBsYXkoKS5jYXRjaCgoZXJyKSA9PiB0aGlzLnNheShgUmVwbGF5IGZhaWxlZDogJHtlcnIubWVzc2FnZX1gKSk7XG4gICAgdm9pZCB0aGlzLmxpc3QoKTtcbiAgfVxuXG4gIHByaXZhdGUgc2F5KHRleHQ6IHN0cmluZykge1xuICAgICh0aGlzLnJvb3QucXVlcnlTZWxlY3RvcihcIi5zdW1tYXJ5XCIpIGFzIEhUTUxFbGVtZW50KS50ZXh0Q29udGVudCA9IHRleHQ7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGxpc3QoKSB7XG4gICAgY29uc3QgcGljayA9IHRoaXMucm9vdC5xdWVyeVNlbGVjdG9yKFwiLnBpY2tcIikgYXMgSFRNTFNlbGVjdEVsZW1lbnQ7XG4gICAgcGljay5pbm5lckhUTUwgPSBcIlwiO1xuICAgIGNvbnN0IHRyYWNlczogeyBuYW1lOiBzdHJpbmc7IGJ5dGVzOiBudW1iZXIgfVtdID0gYXdhaXQgKGF3YWl0IGZldGNoKFwiL3RyYWNlc1wiKSkuanNvbigpO1xuICAgIGNvbnN0IHNjZW5hcmlvczogc3RyaW5nW10gPSBhd2FpdCAoYXdhaXQgZmV0Y2goXCIvc2NlbmFyaW9zXCIpKS5qc29uKCk7XG4gICAgY29uc3QgdHJhY2VHcm91cCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJvcHRncm91cFwiKTtcbiAgICB0cmFjZUdyb3VwLmxhYmVsID0gXCJSZWNvcmRlZCBjYWxsc1wiO1xuICAgIGZvciAoY29uc3QgdCBvZiB0cmFjZXMpIHRyYWNlR3JvdXAuYXBwZW5kKG5ldyBPcHRpb24oYCR7dC5uYW1lfSAoJHtNYXRoLnJvdW5kKHQuYnl0ZXMgLyAxMDI0KX0gS0IpYCwgYC90cmFjZXMvJHt0Lm5hbWV9YCkpO1xuICAgIGNvbnN0IHNjZW5hcmlvR3JvdXAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwib3B0Z3JvdXBcIik7XG4gICAgc2NlbmFyaW9Hcm91cC5sYWJlbCA9IFwiU2NlbmFyaW9zXCI7XG4gICAgZm9yIChjb25zdCBzIG9mIHNjZW5hcmlvcykgc2NlbmFyaW9Hcm91cC5hcHBlbmQobmV3IE9wdGlvbihzLCBgL3NjZW5hcmlvcy8ke3N9Lmpzb25gKSk7XG4gICAgcGljay5hcHBlbmQodHJhY2VHcm91cCwgc2NlbmFyaW9Hcm91cCk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHJlY29yZGluZyh1cmw6IHN0cmluZyk6IFByb21pc2U8UmVjb3JkaW5nPiB7XG4gICAgY29uc3QgdGV4dCA9IGF3YWl0IChhd2FpdCBmZXRjaCh1cmwsIHsgY2FjaGU6IFwibm8tc3RvcmVcIiB9KSkudGV4dCgpO1xuICAgIGlmICh1cmwuZW5kc1dpdGgoXCIuanNvblwiKSkgcmV0dXJuIEpTT04ucGFyc2UodGV4dCk7XG4gICAgY29uc3QgW2hlYWRlciwgLi4uZXZlbnRzXSA9IHRleHQudHJpbSgpLnNwbGl0KFwiXFxuXCIpLm1hcCgobCkgPT4gSlNPTi5wYXJzZShsKSk7XG4gICAgcmV0dXJuIHsgLi4uaGVhZGVyLCBldmVudHMgfTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgcmVwbGF5KCkge1xuICAgIGNvbnN0IHVybCA9ICh0aGlzLnJvb3QucXVlcnlTZWxlY3RvcihcIi5waWNrXCIpIGFzIEhUTUxTZWxlY3RFbGVtZW50KS52YWx1ZTtcbiAgICBpZiAoIXVybCkgcmV0dXJuO1xuICAgIGNvbnN0IHIgPSBhd2FpdCB0aGlzLnJlY29yZGluZyh1cmwpO1xuICAgIGNvbnN0IGxhdGVzdCA9IGF3YWl0IHRoaXMubG9hZCgpO1xuICAgIGxldCByZWNvcmRlZDogQ29yZSB8IG51bGwgPSBudWxsO1xuICAgIGlmIChyLnZlcnNpb24gJiYgci52ZXJzaW9uICE9PSBsYXRlc3QudmVyc2lvbikge1xuICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChgL3ZlcnNpb25zLyR7ci52ZXJzaW9ufS5qc2AsIHsgbWV0aG9kOiBcIkhFQURcIiB9KTtcbiAgICAgIGlmIChyZXNwb25zZS5vaykgcmVjb3JkZWQgPSBhd2FpdCB0aGlzLmxvYWQoYC92ZXJzaW9ucy8ke3IudmVyc2lvbn0uanNgKTtcbiAgICB9XG4gICAgY29uc3Qgbm93ID0gcnVuKGxhdGVzdCwgcik7XG4gICAgY29uc3QgdGhlbiA9IHJlY29yZGVkID8gcnVuKHJlY29yZGVkLCByKSA6IG51bGw7XG4gICAgY29uc3QgYWxsID0gKHRoaXMucm9vdC5xdWVyeVNlbGVjdG9yKFwiLmFsbFwiKSBhcyBIVE1MSW5wdXRFbGVtZW50KS5jaGVja2VkO1xuICAgIGNvbnN0IHRpbWVsaW5lID0gdGhpcy5yb290LnF1ZXJ5U2VsZWN0b3IoXCIudGltZWxpbmVcIikgYXMgSFRNTEVsZW1lbnQ7XG4gICAgdGltZWxpbmUuaW5uZXJIVE1MID0gXCJcIjtcbiAgICBsZXQgZmlyc3QgPSAtMTtcbiAgICBsZXQgZGlmZmVyID0gMDtcbiAgICBjb25zdCByb3dzOiBIVE1MRWxlbWVudFtdID0gW107XG4gICAgY29uc3QgYWRkID0gKGNsczogc3RyaW5nLCB0OiBzdHJpbmcsIHRleHQ6IHN0cmluZykgPT4ge1xuICAgICAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgIHJvdy5jbGFzc05hbWUgPSBgcm93ICR7Y2xzfWA7XG4gICAgICByb3cuaW5uZXJIVE1MID0gYDxzcGFuIGNsYXNzPVwidFwiPiR7dH08L3NwYW4+YDtcbiAgICAgIGNvbnN0IGIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgICAgIGIuY2xhc3NOYW1lID0gXCJiXCI7XG4gICAgICBiLnRleHRDb250ZW50ID0gdGV4dDtcbiAgICAgIHJvdy5hcHBlbmQoYik7XG4gICAgICB0aW1lbGluZS5hcHBlbmQocm93KTtcbiAgICAgIHJvd3MucHVzaChyb3cpO1xuICAgICAgcmV0dXJuIHJvdztcbiAgICB9O1xuICAgIGNvbnN0IHQwID0gci5zdGFydDtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8PSByLmV2ZW50cy5sZW5ndGg7IGkrKykge1xuICAgICAgY29uc3QgZSA9IGkgPT09IDAgPyBudWxsIDogci5ldmVudHNbaSAtIDFdO1xuICAgICAgY29uc3Qgbm93T3V0ID0gbm93W2ldO1xuICAgICAgY29uc3QgdGhlbk91dCA9IHRoZW4gPyB0aGVuW2ldIDogbm93T3V0O1xuICAgICAgY29uc3Qgc2FtZSA9IG5vd091dC5sZW5ndGggPT09IHRoZW5PdXQubGVuZ3RoICYmIG5vd091dC5ldmVyeSgoYywgaikgPT4gYyA9PT0gdGhlbk91dFtqXSk7XG4gICAgICBpZiAoIXNhbWUpIHsgZGlmZmVyKys7IGlmIChmaXJzdCA8IDApIGZpcnN0ID0gaTsgfVxuICAgICAgaWYgKCFzYW1lIHx8IGFsbCB8fCAoZSAmJiB0ZWxsaW5nKGUpKSB8fCBub3dPdXQubGVuZ3RoID4gMCkge1xuICAgICAgICBpZiAoZSAmJiAoYWxsIHx8IHRlbGxpbmcoZSkgfHwgIXNhbWUpKSBhZGQoXCJpblwiLCAoZS50IC0gdDApLnRvRml4ZWQoMiksIGxpbmUoZSkpO1xuICAgICAgICBjb25zdCB0ID0gZSA/IChlLnQgLSB0MCkudG9GaXhlZCgyKSA6IFwiMC4wMFwiO1xuICAgICAgICBpZiAoc2FtZSkgZm9yIChjb25zdCBjIG9mIG5vd091dCkgYWRkKFwib3V0XCIsIHQsIGMpO1xuICAgICAgICBlbHNlIHtcbiAgICAgICAgICBmb3IgKGNvbnN0IGMgb2YgdGhlbk91dCkgYWRkKFwib3V0IGdvbmVcIiwgdCwgYFx1MjIxMiAke2N9YCk7XG4gICAgICAgICAgZm9yIChjb25zdCBjIG9mIG5vd091dCkgYWRkKFwib3V0IG5ld1wiLCB0LCBgKyAke2N9YCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgY29uc3QgdmVyc2lvbnMgPSB0aGVuID8gYHJlY29yZGVkIGJ5ICR7ci52ZXJzaW9ufSwgcmVwbGF5ZWQgYnkgaXQgYW5kIGJ5ICR7bGF0ZXN0LnZlcnNpb259YCA6IGByZXBsYXllZCBieSAke2xhdGVzdC52ZXJzaW9ufWAgK1xuICAgICAgKHIudmVyc2lvbiAmJiByLnZlcnNpb24gIT09IGxhdGVzdC52ZXJzaW9uID8gYCAodGhlIHJlY29yZGluZydzIGJ1aWxkICR7ci52ZXJzaW9ufSBpc24ndCBrZXB0IGhlcmUpYCA6IFwiXCIpO1xuICAgIHRoaXMuc2F5KGAke3IuZXZlbnRzLmxlbmd0aH0gZXZlbnRzLCAke3ZlcnNpb25zfS4gYCArICh0aGVuID8gKGRpZmZlciA/IGAke2RpZmZlcn0gZXZlbnRzIGFuc3dlcmVkIGRpZmZlcmVudGx5LCB0aGUgZmlyc3QgYXQgZXZlbnQgJHtmaXJzdH0uYCA6IFwiQm90aCBhbnN3ZXJlZCBldmVyeSBldmVudCB0aGUgc2FtZS5cIikgOiBcIlwiKSk7XG4gICAgaWYgKGZpcnN0ID49IDApIHRpbWVsaW5lLnF1ZXJ5U2VsZWN0b3IoXCIuZ29uZSwgLm5ld1wiKT8uc2Nyb2xsSW50b1ZpZXcoeyBibG9jazogXCJjZW50ZXJcIiB9KTtcbiAgfVxufVxuIiwgIi8qKiBNaW5pbWFsIHNjcm9sbGluZyBwYW5lIHN1cmZhY2Ugc28gYXV0by1zY3JvbGwgbG9naWMgc3RheXMgdGVzdGFibGUgd2l0aG91dCBhIGJyb3dzZXIgRE9NLiAqL1xuZXhwb3J0IGludGVyZmFjZSBTY3JvbGxQYW5lIHtcbiAgc2Nyb2xsVG9wOiBudW1iZXI7XG4gIHJlYWRvbmx5IHNjcm9sbEhlaWdodDogbnVtYmVyO1xuICByZWFkb25seSBjbGllbnRIZWlnaHQ6IG51bWJlcjtcbiAgc2Nyb2xsVG8/KG9wdGlvbnM6IHsgdG9wOiBudW1iZXI7IGJlaGF2aW9yPzogU2Nyb2xsQmVoYXZpb3IgfSk6IHZvaWQ7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXV0b1Njcm9sbGVyT3B0aW9ucyB7XG4gIC8qKiBEaXN0YW5jZSBmcm9tIHRoZSBib3R0b20gKHB4KSB0aGF0IHN0aWxsIGNvdW50cyBhcyBwaW5uZWQuICovXG4gIHBpblRocmVzaG9sZD86IG51bWJlcjtcbiAgLyoqIERpc3RhbmNlIGZyb20gdGhlIGJvdHRvbSAocHgpIHBhc3Qgd2hpY2ggdGhlIGp1bXAtdG8tbGF0ZXN0IGNvbnRyb2wgaXMgc2hvd24uICovXG4gIGp1bXBUaHJlc2hvbGQ/OiBudW1iZXI7XG4gIC8qKiBDYWxsZWQgd2hlbmV2ZXIgdGhlIGp1bXAtdG8tbGF0ZXN0IGNvbnRyb2wncyB2aXNpYmlsaXR5IG1heSBoYXZlIGNoYW5nZWQuICovXG4gIG9uSnVtcENoYW5nZT86IChzaG93OiBib29sZWFuKSA9PiB2b2lkO1xuICAvKiogV2hlbiB0cnVlIChmb3IgZXhhbXBsZSB3aGlsZSB0aGUgZW1wdHkgc3RhdGUgaXMgc2hvd24pLCBrZWVwIHRoZSBqdW1wIGNvbnRyb2wgaGlkZGVuLiAqL1xuICBpc0VtcHR5PzogKCkgPT4gYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBLZWVwcyBhIHRyYW5zY3JpcHQgcGFuZSBwaW5uZWQgdG8gdGhlIGJvdHRvbSBhcyBtZXNzYWdlcyBzdHJlYW0gaW4sIHdpdGhvdXQgbWVhc3VyaW5nXG4gKiBuZWFyLWJvdHRvbSBhZnRlciBhbiBhcHBlbmQgaGFzIGFscmVhZHkgZ3Jvd24gc2Nyb2xsSGVpZ2h0LCBhbmQgeWllbGRzIGltbWVkaWF0ZWx5IHdoZW5cbiAqIHRoZSB1c2VyIHNjcm9sbHMgdXAgdG8gcmVhZCBlYXJsaWVyIG1lc3NhZ2VzLlxuICovXG5leHBvcnQgY2xhc3MgQXV0b1Njcm9sbGVyIHtcbiAgcHJpdmF0ZSByZWFkb25seSBwYW5lOiBTY3JvbGxQYW5lO1xuICBwcml2YXRlIHJlYWRvbmx5IHBpblRocmVzaG9sZDogbnVtYmVyO1xuICBwcml2YXRlIHJlYWRvbmx5IGp1bXBUaHJlc2hvbGQ6IG51bWJlcjtcbiAgcHJpdmF0ZSByZWFkb25seSBvbkp1bXBDaGFuZ2U/OiAoc2hvdzogYm9vbGVhbikgPT4gdm9pZDtcbiAgcHJpdmF0ZSByZWFkb25seSBpc0VtcHR5PzogKCkgPT4gYm9vbGVhbjtcbiAgcHJpdmF0ZSBwaW5uZWQgPSB0cnVlO1xuICBwcml2YXRlIGp1bXBpbmcgPSBmYWxzZTtcbiAgcHJpdmF0ZSBsYXN0U2Nyb2xsVG9wID0gMDtcblxuICBjb25zdHJ1Y3RvcihwYW5lOiBTY3JvbGxQYW5lLCBvcHRpb25zOiBBdXRvU2Nyb2xsZXJPcHRpb25zID0ge30pIHtcbiAgICB0aGlzLnBhbmUgPSBwYW5lO1xuICAgIHRoaXMucGluVGhyZXNob2xkID0gb3B0aW9ucy5waW5UaHJlc2hvbGQgPz8gMzI7XG4gICAgdGhpcy5qdW1wVGhyZXNob2xkID0gb3B0aW9ucy5qdW1wVGhyZXNob2xkID8/IDEyMDtcbiAgICB0aGlzLm9uSnVtcENoYW5nZSA9IG9wdGlvbnMub25KdW1wQ2hhbmdlO1xuICAgIHRoaXMuaXNFbXB0eSA9IG9wdGlvbnMuaXNFbXB0eTtcbiAgICB0aGlzLmxhc3RTY3JvbGxUb3AgPSBwYW5lLnNjcm9sbFRvcDtcbiAgfVxuXG4gIGdldCBpc1Bpbm5lZCgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5waW5uZWQ7XG4gIH1cblxuICBwcml2YXRlIGRpc3RhbmNlKCk6IG51bWJlciB7XG4gICAgcmV0dXJuIE1hdGgubWF4KDAsIHRoaXMucGFuZS5zY3JvbGxIZWlnaHQgLSB0aGlzLnBhbmUuc2Nyb2xsVG9wIC0gdGhpcy5wYW5lLmNsaWVudEhlaWdodCk7XG4gIH1cblxuICBwcml2YXRlIGlzVmlzaWJsZSgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5wYW5lLmNsaWVudEhlaWdodCA+IDA7XG4gIH1cblxuICBwcml2YXRlIHNuYXBUb0JvdHRvbSgpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuaXNWaXNpYmxlKCkpIHJldHVybjtcbiAgICB0aGlzLnBhbmUuc2Nyb2xsVG9wID0gdGhpcy5wYW5lLnNjcm9sbEhlaWdodDtcbiAgICB0aGlzLmxhc3RTY3JvbGxUb3AgPSB0aGlzLnBhbmUuc2Nyb2xsVG9wO1xuICB9XG5cbiAgcHJpdmF0ZSB1cGRhdGVKdW1wKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5vbkp1bXBDaGFuZ2UpIHJldHVybjtcbiAgICBjb25zdCBlbXB0eSA9IHRoaXMuaXNFbXB0eT8uKCkgPz8gZmFsc2U7XG4gICAgY29uc3Qgc2hvdyA9ICFlbXB0eSAmJiB0aGlzLmlzVmlzaWJsZSgpICYmICF0aGlzLmp1bXBpbmcgJiYgdGhpcy5kaXN0YW5jZSgpID4gdGhpcy5qdW1wVGhyZXNob2xkO1xuICAgIHRoaXMub25KdW1wQ2hhbmdlKHNob3cpO1xuICB9XG5cbiAgLyoqIENhbGwgYWZ0ZXIgY29udGVudCBpcyBhZGRlZCwgdXBkYXRlZCwgb3IgcmVtb3ZlZCBpbiB0aGUgcGFuZS4gKi9cbiAgb25Db250ZW50KGZvcmNlID0gZmFsc2UpOiB2b2lkIHtcbiAgICBpZiAoZm9yY2UpIHtcbiAgICAgIHRoaXMucGlubmVkID0gdHJ1ZTtcbiAgICAgIHRoaXMuanVtcGluZyA9IGZhbHNlO1xuICAgIH1cbiAgICBpZiAodGhpcy5waW5uZWQpIHtcbiAgICAgIGlmICh0aGlzLmp1bXBpbmcgJiYgdGhpcy5wYW5lLnNjcm9sbFRvICYmIHRoaXMuaXNWaXNpYmxlKCkpIHtcbiAgICAgICAgdGhpcy5wYW5lLnNjcm9sbFRvKHsgdG9wOiB0aGlzLnBhbmUuc2Nyb2xsSGVpZ2h0LCBiZWhhdmlvcjogXCJzbW9vdGhcIiB9KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMuc25hcFRvQm90dG9tKCk7XG4gICAgICB9XG4gICAgfVxuICAgIHRoaXMudXBkYXRlSnVtcCgpO1xuICB9XG5cbiAgLyoqIENhbGwgd2hlbiB0aGUgcGFuZSdzIHZpZXdwb3J0IHJlc2l6ZXMgKGJhcnMgYXBwZWFyaW5nLCBrZXlib2FyZCwgdGFiIHN3aXRjaCkuICovXG4gIG9uUmVzaXplKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5pc1Zpc2libGUoKSkgcmV0dXJuO1xuICAgIGlmICh0aGlzLnBpbm5lZCkge1xuICAgICAgdGhpcy5qdW1waW5nID0gZmFsc2U7XG4gICAgICB0aGlzLnNuYXBUb0JvdHRvbSgpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLmxhc3RTY3JvbGxUb3AgPSB0aGlzLnBhbmUuc2Nyb2xsVG9wO1xuICAgIH1cbiAgICB0aGlzLnVwZGF0ZUp1bXAoKTtcbiAgfVxuXG4gIC8qKiBDYWxsIGZyb20gdGhlIHBhbmUncyBzY3JvbGwgZXZlbnQgbGlzdGVuZXIuICovXG4gIG9uU2Nyb2xsKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5pc1Zpc2libGUoKSkgcmV0dXJuO1xuICAgIGNvbnN0IHRvcCA9IHRoaXMucGFuZS5zY3JvbGxUb3A7XG4gICAgY29uc3QgZGlzdCA9IHRoaXMuZGlzdGFuY2UoKTtcbiAgICBjb25zdCBtb3ZlZFVwID0gdG9wIDwgdGhpcy5sYXN0U2Nyb2xsVG9wO1xuICAgIHRoaXMubGFzdFNjcm9sbFRvcCA9IHRvcDtcblxuICAgIGlmIChkaXN0IDw9IHRoaXMucGluVGhyZXNob2xkKSB7XG4gICAgICB0aGlzLnBpbm5lZCA9IHRydWU7XG4gICAgICB0aGlzLmp1bXBpbmcgPSBmYWxzZTtcbiAgICB9IGVsc2UgaWYgKG1vdmVkVXApIHtcbiAgICAgIHRoaXMucGlubmVkID0gZmFsc2U7XG4gICAgICB0aGlzLmp1bXBpbmcgPSBmYWxzZTtcbiAgICB9XG4gICAgdGhpcy51cGRhdGVKdW1wKCk7XG4gIH1cblxuICAvKiogQ2FsbCBmcm9tIHRoZSBwYW5lJ3Mgc2Nyb2xsZW5kIGV2ZW50IGxpc3RlbmVyLiAqL1xuICBvblNjcm9sbEVuZCgpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuaXNWaXNpYmxlKCkgfHwgIXRoaXMuanVtcGluZykgcmV0dXJuO1xuICAgIHRoaXMuanVtcGluZyA9IGZhbHNlO1xuICAgIGlmICh0aGlzLmRpc3RhbmNlKCkgPiB0aGlzLnBpblRocmVzaG9sZCkgdGhpcy5waW5uZWQgPSBmYWxzZTtcbiAgICB0aGlzLnVwZGF0ZUp1bXAoKTtcbiAgfVxuXG4gIC8qKiBDYWxsIG9uIHVzZXIgd2hlZWwtdXAgb3IgdG91Y2hzdGFydCBzbyBhbiBhY3RpdmUgc21vb3RoIGp1bXAgeWllbGRzIHRvIHRoZSB1c2VyLiAqL1xuICBjYW5jZWxKdW1wKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5qdW1waW5nKSByZXR1cm47XG4gICAgdGhpcy5qdW1waW5nID0gZmFsc2U7XG4gICAgaWYgKHRoaXMuaXNWaXNpYmxlKCkpIHtcbiAgICAgIGNvbnN0IHRvcCA9IHRoaXMucGFuZS5zY3JvbGxUb3A7XG4gICAgICBpZiAodGhpcy5wYW5lLnNjcm9sbFRvKSB0aGlzLnBhbmUuc2Nyb2xsVG8oeyB0b3AsIGJlaGF2aW9yOiBcImluc3RhbnRcIiB9KTtcbiAgICAgIGVsc2UgdGhpcy5wYW5lLnNjcm9sbFRvcCA9IHRvcDtcbiAgICAgIHRoaXMubGFzdFNjcm9sbFRvcCA9IHRoaXMucGFuZS5zY3JvbGxUb3A7XG4gICAgICBpZiAodGhpcy5kaXN0YW5jZSgpID4gdGhpcy5waW5UaHJlc2hvbGQpIHRoaXMucGlubmVkID0gZmFsc2U7XG4gICAgfVxuICAgIHRoaXMudXBkYXRlSnVtcCgpO1xuICB9XG5cbiAgLyoqIFJlLXBpbiBhbmQgc2Nyb2xsIHNtb290aGx5IHRvIHRoZSBib3R0b20gKHVzZWQgYnkgdGhlIGp1bXAtdG8tbGF0ZXN0IGJ1dHRvbikuICovXG4gIGp1bXBUb0JvdHRvbSgpOiB2b2lkIHtcbiAgICB0aGlzLnBpbm5lZCA9IHRydWU7XG4gICAgaWYgKCF0aGlzLmlzVmlzaWJsZSgpKSB7XG4gICAgICB0aGlzLnVwZGF0ZUp1bXAoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHRoaXMuZGlzdGFuY2UoKSA8PSB0aGlzLnBpblRocmVzaG9sZCB8fCAhdGhpcy5wYW5lLnNjcm9sbFRvKSB7XG4gICAgICB0aGlzLmp1bXBpbmcgPSBmYWxzZTtcbiAgICAgIHRoaXMuc25hcFRvQm90dG9tKCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuanVtcGluZyA9IHRydWU7XG4gICAgICB0aGlzLmxhc3RTY3JvbGxUb3AgPSB0aGlzLnBhbmUuc2Nyb2xsVG9wO1xuICAgICAgdGhpcy5wYW5lLnNjcm9sbFRvKHsgdG9wOiB0aGlzLnBhbmUuc2Nyb2xsSGVpZ2h0LCBiZWhhdmlvcjogXCJzbW9vdGhcIiB9KTtcbiAgICB9XG4gICAgdGhpcy51cGRhdGVKdW1wKCk7XG4gIH1cblxuICAvKiogUmVjb21wdXRlIHBpbm5lZCBzdGF0ZSBmcm9tIHRoZSBjdXJyZW50IHBvc2l0aW9uIGFmdGVyIGEgdXNlci1kcml2ZW4gbGF5b3V0IGNoYW5nZSAoZS5nLiBleHBhbmRpbmcgYSByZXN1bHQpLiAqL1xuICBzeW5jRnJvbVBvc2l0aW9uKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5pc1Zpc2libGUoKSkgcmV0dXJuO1xuICAgIHRoaXMuanVtcGluZyA9IGZhbHNlO1xuICAgIHRoaXMubGFzdFNjcm9sbFRvcCA9IHRoaXMucGFuZS5zY3JvbGxUb3A7XG4gICAgdGhpcy5waW5uZWQgPSB0aGlzLmRpc3RhbmNlKCkgPD0gdGhpcy5waW5UaHJlc2hvbGQ7XG4gICAgdGhpcy51cGRhdGVKdW1wKCk7XG4gIH1cblxuICAvKiogUGF1c2UgYXV0by1zY3JvbGwgZXhwbGljaXRseSAoZS5nLiB3aGVuIHJldmVhbGluZyBhbiBvbGRlciByZXN1bHQgY2FyZCkuICovXG4gIHVucGluKCk6IHZvaWQge1xuICAgIHRoaXMucGlubmVkID0gZmFsc2U7XG4gICAgdGhpcy5qdW1waW5nID0gZmFsc2U7XG4gICAgdGhpcy51cGRhdGVKdW1wKCk7XG4gIH1cbn1cbiIsICIvLyBQdXJlIFVJIGhlbHBlcnMgZm9yIHRoZSBWb2ljZSB3ZWIgc3VyZmFjZSAoZGVuc2l0eSwgYWdlbnQtcGFuZSBmaWx0ZXJpbmcsIGNvbXBhY3QgcHJldmlld3MpLlxuXG5leHBvcnQgdHlwZSBTaWRlRmlsdGVyID0gXCJhbGxcIiB8IFwiYWN0aXZlXCIgfCBcInJlc3VsdHNcIjtcbmV4cG9ydCB0eXBlIERlbnNpdHkgPSBcImNvbXBhY3RcIiB8IFwiY29tZm9ydGFibGVcIjtcblxuZXhwb3J0IGludGVyZmFjZSBTaWRlQ291bnRzIHtcbiAgYWN0aXZlOiBudW1iZXI7XG4gIHJlc3VsdHM6IG51bWJlcjtcbiAgZWFybGllcjogbnVtYmVyO1xuICBkb25lOiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2lkZVZpc2liaWxpdHkge1xuICBzaG93VGFza3NTZWN0aW9uOiBib29sZWFuO1xuICBzaG93RW1wdHlUYXNrczogYm9vbGVhbjtcbiAgc2hvd1Jlc3VsdHNTZWN0aW9uOiBib29sZWFuO1xuICBzaG93RW1wdHlSZXN1bHRzOiBib29sZWFuO1xuICBzaG93RWFybGllclNlY3Rpb246IGJvb2xlYW47XG4gIHNob3dEb25lU2VjdGlvbjogYm9vbGVhbjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZURlbnNpdHkodmFsdWU6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQpOiBEZW5zaXR5IHtcbiAgcmV0dXJuIHZhbHVlID09PSBcImNvbWZvcnRhYmxlXCIgPyBcImNvbWZvcnRhYmxlXCIgOiBcImNvbXBhY3RcIjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZVNpZGVGaWx0ZXIodmFsdWU6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQpOiBTaWRlRmlsdGVyIHtcbiAgaWYgKHZhbHVlID09PSBcImFjdGl2ZVwiIHx8IHZhbHVlID09PSBcInJlc3VsdHNcIikgcmV0dXJuIHZhbHVlO1xuICByZXR1cm4gXCJhbGxcIjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlUHJlZml4KHRleHQ6IHN0cmluZyk6IHsgbW9kZTogXCJoZXJtZXNcIiB8IFwidDNcIiB8IG51bGw7IHJlc3Q6IHN0cmluZyB9IHtcbiAgY29uc3QgbSA9IHRleHQubWF0Y2goL15cXC8odDN8Y29kZXxofGhlcm1lcylcXHMrKC4qKSQvaXMpO1xuICBpZiAoIW0pIHJldHVybiB7IG1vZGU6IG51bGwsIHJlc3Q6IHRleHQgfTtcbiAgcmV0dXJuIHsgbW9kZTogL14odDN8Y29kZSkkL2kudGVzdChtWzFdKSA/IFwidDNcIiA6IFwiaGVybWVzXCIsIHJlc3Q6IG1bMl0udHJpbSgpIH07XG59XG5cbi8qKiBBIHJlc3VsdCBjYXJkIG1heSBvbmx5IHN0ZWVyIGEgdGFzayB0aGF0IGJlbG9uZ3MgdG8gdGhlIHNhbWUgYWN0aXZlIHNlc3Npb24gKHRhc2sgSURzIHJlc3RhcnQgcGVyIGNhbGwpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNhbkZvbGxvd1VwUmVzdWx0KHJlc3VsdFNlc3Npb246IG51bWJlciwgYWN0aXZlU2Vzc2lvbjogbnVtYmVyLCBoYXNUYXNrOiBib29sZWFuKTogYm9vbGVhbiB7XG4gIHJldHVybiBhY3RpdmVTZXNzaW9uID4gMCAmJiByZXN1bHRTZXNzaW9uID09PSBhY3RpdmVTZXNzaW9uICYmIGhhc1Rhc2s7XG59XG5cbi8qKiBVbnJlYWQgbW9iaWxlIHJlc3VsdCBhbGVydHMgb25seSBjbGVhciBvbmNlIHRoZSBSZXN1bHRzIHNlY3Rpb24gaXMgYWN0dWFsbHkgdmlzaWJsZSB0byB0aGUgdXNlci4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzaG91bGRDbGVhclVucmVhZFJlc3VsdHMoaXNNb2JpbGU6IGJvb2xlYW4sIGRyYXdlck9wZW46IGJvb2xlYW4sIGZpbHRlcjogU2lkZUZpbHRlcik6IGJvb2xlYW4ge1xuICByZXR1cm4gIWlzTW9iaWxlIHx8IChkcmF3ZXJPcGVuICYmIGZpbHRlciAhPT0gXCJhY3RpdmVcIik7XG59XG5cbi8qKiBQaWNrIHRoZSBmaWx0ZXIgdG8gc2hvdyB3aGVuIHRhcHBpbmcgdGhlIG1vYmlsZSBsaXZlLXN0YXR1cyBiYW5uZXIgc28gdGhlIGFkdmVydGlzZWQgaXRlbSBpcyB2aXNpYmxlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVNb2JpbGVCYW5uZXJGaWx0ZXIoY3VycmVudDogU2lkZUZpbHRlciwgYWN0aXZlVG90YWw6IG51bWJlciwgdW5yZWFkUmVzdWx0czogbnVtYmVyKTogU2lkZUZpbHRlciB7XG4gIGlmIChhY3RpdmVUb3RhbCA+IDApIHJldHVybiBjdXJyZW50ID09PSBcInJlc3VsdHNcIiA/IFwiYWxsXCIgOiBjdXJyZW50O1xuICBpZiAodW5yZWFkUmVzdWx0cyA+IDApIHJldHVybiBcInJlc3VsdHNcIjtcbiAgcmV0dXJuIGN1cnJlbnQ7XG59XG5cbi8qKiBGbGF0dGVuIGEgTWFya2Rvd24gYWdlbnQgcmVwbHkgaW50byBhIHNpbmdsZS1saW5lIHBsYWluLXRleHQgcHJldmlldyBmb3IgaW5saW5lIGhhbmRvZmYgY2hpcHMuICovXG5leHBvcnQgZnVuY3Rpb24gcGxhaW5QcmV2aWV3KHRleHQ6IHN0cmluZywgbWF4TGVuID0gMTUwKTogc3RyaW5nIHtcbiAgY29uc3QgY2xlYW5lZCA9IHRleHRcbiAgICAucmVwbGFjZSgvYGBgW15cXG5dKlxcbj8oW1xcc1xcU10qPylgYGAvZywgKF8sIGNvZGU6IHN0cmluZykgPT4gYCAke2NvZGUudHJpbSgpfSBgKVxuICAgIC5yZXBsYWNlKC9cXFsoW15cXF1cXG5dKylcXF1cXCgoaHR0cHM/OlxcL1xcL1teXFxzKV0rKVxcKS9nLCBcIiQxXCIpXG4gICAgLnJlcGxhY2UoL14jezEsNn1cXHMrL2dtLCBcIlwiKVxuICAgIC5yZXBsYWNlKC9eXFxzKig/OlstKlx1MjAyMl18XFxkK1suKV0pXFxzKy9nbSwgXCJcIilcbiAgICAucmVwbGFjZSgvYChbXmBcXG5dKylgL2csIFwiJDFcIilcbiAgICAucmVwbGFjZSgvXFwqXFwqKFteKlxcbl0rKVxcKlxcKi9nLCBcIiQxXCIpXG4gICAgLnJlcGxhY2UoL19fKFteX1xcbl0rKV9fL2csIFwiJDFcIilcbiAgICAucmVwbGFjZSgvXFxzKy9nLCBcIiBcIilcbiAgICAudHJpbSgpO1xuICBpZiAoY2xlYW5lZC5sZW5ndGggPD0gbWF4TGVuKSByZXR1cm4gY2xlYW5lZDtcbiAgY29uc3QgY3V0ID0gY2xlYW5lZC5zbGljZSgwLCBtYXhMZW4pO1xuICBjb25zdCBzcGFjZSA9IGN1dC5sYXN0SW5kZXhPZihcIiBcIik7XG4gIGNvbnN0IGJhc2UgPSBzcGFjZSA+IE1hdGguZmxvb3IobWF4TGVuICogMC42KSA/IGN1dC5zbGljZSgwLCBzcGFjZSkgOiBjdXQ7XG4gIHJldHVybiBgJHtiYXNlLnJlcGxhY2UoL1suLDs6XFxzLV0rJC8sIFwiXCIpfVx1MjAyNmA7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXRTaG9ydFRpbWUoZGF0ZTogRGF0ZSk6IHN0cmluZyB7XG4gIGNvbnN0IHBhZCA9IChuOiBudW1iZXIpID0+IFN0cmluZyhuKS5wYWRTdGFydCgyLCBcIjBcIik7XG4gIHJldHVybiBgJHtwYWQoZGF0ZS5nZXRIb3VycygpKX06JHtwYWQoZGF0ZS5nZXRNaW51dGVzKCkpfWA7XG59XG5cbi8qKiBEZWNpZGUgd2hpY2ggc2VjdGlvbnMgb2YgdGhlIHJpZ2h0LWhhbmQgQWdlbnQgV29ya3NwYWNlIGFyZSB2aXNpYmxlIGZvciBhIGdpdmVuIGZpbHRlciBhbmQgY291bnRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVTaWRlU2VjdGlvbnMoZmlsdGVyOiBTaWRlRmlsdGVyLCBjb3VudHM6IFNpZGVDb3VudHMpOiBTaWRlVmlzaWJpbGl0eSB7XG4gIGlmIChmaWx0ZXIgPT09IFwicmVzdWx0c1wiKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHNob3dUYXNrc1NlY3Rpb246IGZhbHNlLFxuICAgICAgc2hvd0VtcHR5VGFza3M6IGZhbHNlLFxuICAgICAgc2hvd1Jlc3VsdHNTZWN0aW9uOiB0cnVlLFxuICAgICAgc2hvd0VtcHR5UmVzdWx0czogY291bnRzLnJlc3VsdHMgPT09IDAsXG4gICAgICBzaG93RWFybGllclNlY3Rpb246IGZhbHNlLFxuICAgICAgc2hvd0RvbmVTZWN0aW9uOiBmYWxzZSxcbiAgICB9O1xuICB9XG4gIGlmIChmaWx0ZXIgPT09IFwiYWN0aXZlXCIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc2hvd1Rhc2tzU2VjdGlvbjogdHJ1ZSxcbiAgICAgIHNob3dFbXB0eVRhc2tzOiBjb3VudHMuYWN0aXZlID09PSAwICYmIGNvdW50cy5lYXJsaWVyID09PSAwLFxuICAgICAgc2hvd1Jlc3VsdHNTZWN0aW9uOiBmYWxzZSxcbiAgICAgIHNob3dFbXB0eVJlc3VsdHM6IGZhbHNlLFxuICAgICAgc2hvd0VhcmxpZXJTZWN0aW9uOiBjb3VudHMuZWFybGllciA+IDAsXG4gICAgICBzaG93RG9uZVNlY3Rpb246IGNvdW50cy5kb25lID4gMCxcbiAgICB9O1xuICB9XG4gIC8vIFwiYWxsXCI6IGhpZGUgdGhlIGVtcHR5IGFjdGl2ZS10YXNrcyBwbGFjZWhvbGRlciBhcyBzb29uIGFzIHJlc3VsdHMgb3IgZWFybGllciBhZ2VudHMgZXhpc3RcbiAgLy8gc28gZmluaXNoZWQgcmVzcG9uc2VzIHRha2UgdGhlIHRvcCBvZiB0aGUgcGFuZSB3aXRob3V0IHdhc3RlZCBzcGFjZS5cbiAgY29uc3QgaGFzQW55dGhpbmdBYm92ZURvbmUgPSBjb3VudHMuYWN0aXZlID4gMCB8fCBjb3VudHMucmVzdWx0cyA+IDAgfHwgY291bnRzLmVhcmxpZXIgPiAwO1xuICByZXR1cm4ge1xuICAgIHNob3dUYXNrc1NlY3Rpb246IGNvdW50cy5hY3RpdmUgPiAwIHx8ICFoYXNBbnl0aGluZ0Fib3ZlRG9uZSxcbiAgICBzaG93RW1wdHlUYXNrczogIWhhc0FueXRoaW5nQWJvdmVEb25lLFxuICAgIHNob3dSZXN1bHRzU2VjdGlvbjogY291bnRzLnJlc3VsdHMgPiAwLFxuICAgIHNob3dFbXB0eVJlc3VsdHM6IGZhbHNlLFxuICAgIHNob3dFYXJsaWVyU2VjdGlvbjogY291bnRzLmVhcmxpZXIgPiAwLFxuICAgIHNob3dEb25lU2VjdGlvbjogY291bnRzLmRvbmUgPiAwLFxuICB9O1xufVxuIiwgIi8vIE1haW4tdGhyZWFkIGNvbnRyb2xsZXIgZm9yIHRoZSB3YWtlIHdvcmQgV2ViIFdvcmtlciBhbmQgU2NyZWVuIFdha2UgTG9jayBoZWxwZXIuXG4vLyBUYWdzIGV2ZXJ5IGxvYWQgYW5kIHJlc2V0IHdpdGggYSBtb25vdG9uaWMgZ2VuZXJhdGlvbiAoYGdlbmApIHNvIHN0YWxlIGRldGVjdGlvbnMgb3IgcmVhZHkgZXZlbnRzXG4vLyBhZnRlciBhIG1vZGVsIHN3aXRjaCBvciByZXNldCBhcmUgaWdub3JlZCwgYW5kIGtlZXBzIGEgc2hvcnQgcmluZyBidWZmZXIgb2YgcmVjZW50IGZlZCBjaHVua3Ncbi8vIGluZGV4ZWQgYnkgYHNlcWAgKHdpdGggcGVyLWZyYW1lIGBzdXBwcmVzc2VkYCBmbGFncykgc28gYXVkaW8gY2FwdHVyZWQgd2hpbGUgdGhlIHdvcmtlciB3YXNcbi8vIHNjb3JpbmcgaXMgcHJlc2VydmVkIGluIGBoaXQudHJhaWxpbmdgIHdpdGhvdXQgZHVwbGljYXRpbmcgdW5zdXBwcmVzc2VkIGZyYW1lcy5cblxuZXhwb3J0IGludGVyZmFjZSBXYWtlVGVsZW1ldHJ5IHtcbiAgc2NvcmU6IG51bWJlcjtcbiAgcGVhazogbnVtYmVyO1xuICBnYXRlT3BlbjogYm9vbGVhbjtcbiAgZnJhbWVzOiBudW1iZXI7XG4gIHNjb3JlZDogbnVtYmVyO1xuICBpbmZlck1zOiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgV2FrZVRyYWlsaW5nQ2h1bmsge1xuICAvKiogU2VxdWVuY2UgbnVtYmVyIGZyb20gYGZlZWQoKWAsIG1hdGNoaW5nIHRoZSBmZWQgY2h1bmsuICovXG4gIHNlcTogbnVtYmVyO1xuICBieXRlczogVWludDhBcnJheTtcbiAgLyoqIFRydWUgd2hlbiB0aGUgY29yZSBzdXBwcmVzc2VkIChzaWxlbmNlZCkgdGhpcyBmcmFtZSBkdXJpbmcgYXVkaWJsZSBwbGF5YmFjayAoYHdoaWxlU3BlYWtpbmcgIT09IFwic2VuZFwiYCkuICovXG4gIHN1cHByZXNzZWQ6IGJvb2xlYW47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgV2FrZURldGVjdGlvbkV2ZW50IHtcbiAgc2NvcmU6IG51bWJlcjtcbiAgYXRGcmFtZTogbnVtYmVyO1xuICAvKiogQXVkaW8gY2h1bmtzIHNwb2tlbiBhZnRlciB0aGUgd2FrZSB3b3JkOiB0aGUgdHJpZ2dlcmluZyBjaHVuaydzIHRhaWwgcGx1cyBhbnkgY2h1bmtzIGFscmVhZHkgc2VudCBhZnRlciBpdC4gKi9cbiAgdHJhaWxpbmc6IFdha2VUcmFpbGluZ0NodW5rW107XG4gIGluZmVyTXM6IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBXYWtlQ2xpZW50Q2FsbGJhY2tzIHtcbiAgb25SZWFkeT86IChtb2RlbElkOiBzdHJpbmcsIHdhcm11cE1zOiBudW1iZXIpID0+IHZvaWQ7XG4gIG9uRGV0ZWN0ZWQ6IChoaXQ6IFdha2VEZXRlY3Rpb25FdmVudCkgPT4gdm9pZDtcbiAgb25UZWxlbWV0cnk/OiAodDogV2FrZVRlbGVtZXRyeSkgPT4gdm9pZDtcbiAgLyoqIENhbGxlZCBvbmNlIGFsbCBpbi1mbGlnaHQgc3VwcHJlc3NlZCBmcmFtZXMgaGF2ZSBiZWVuIHNjb3JlZCB3aXRob3V0IGZpcmluZyBhIGRldGVjdGlvbi4gKi9cbiAgb25TdXBwcmVzc2VkU2V0dGxlZD86ICgpID0+IHZvaWQ7XG4gIG9uRXJyb3I/OiAobWVzc2FnZTogc3RyaW5nKSA9PiB2b2lkO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFdvcmtlckxpa2Uge1xuICBvbm1lc3NhZ2U6ICgoZTogTWVzc2FnZUV2ZW50PFJlY29yZDxzdHJpbmcsIGFueT4+KSA9PiB2b2lkKSB8IG51bGw7XG4gIG9uZXJyb3I6ICgoZTogRXJyb3JFdmVudCkgPT4gdm9pZCkgfCBudWxsO1xuICBwb3N0TWVzc2FnZShtZXNzYWdlOiB1bmtub3duLCB0cmFuc2Zlcj86IFRyYW5zZmVyYWJsZVtdKTogdm9pZDtcbiAgdGVybWluYXRlKCk6IHZvaWQ7XG59XG5cbi8qKiBNYXggYnVmZmVyZWQgcG9zdC1mZWVkIGF1ZGlvICh+MS41IHMgYXQgMjAgbXMgY2h1bmtzKSB0byBjb3ZlciB3b3JrZXIgc2NvcmluZyBsYXRlbmN5LiAqL1xuY29uc3QgUkVDRU5UX01BWF9CWVRFUyA9IE1hdGgucm91bmQoMS41ICogMzJfMDAwKTtcblxuZXhwb3J0IGNsYXNzIFdha2VDbGllbnQge1xuICBwcml2YXRlIHdvcmtlcjogV29ya2VyTGlrZSB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIHJlYWRvbmx5IGNhbGxiYWNrczogV2FrZUNsaWVudENhbGxiYWNrcztcbiAgcHJpdmF0ZSByZWFkb25seSBjcmVhdGVXb3JrZXI6ICgpID0+IFdvcmtlckxpa2U7XG4gIHByaXZhdGUgbG9hZGVkTW9kZWxJZDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgbG9hZGluZ01vZGVsSWQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIGN1cnJlbnRUaHJlc2hvbGQgPSAwLjc7XG4gIHByaXZhdGUgZ2VuID0gMDtcbiAgcHJpdmF0ZSBzZXEgPSAwO1xuICBwcml2YXRlIGxhc3RTdXBwcmVzc2VkU2VxID0gMDtcbiAgcHJpdmF0ZSBsYXN0QWNrZWRTZXEgPSAwO1xuICBwcml2YXRlIHJlY2VudDogeyBzZXE6IG51bWJlcjsgYnl0ZXM6IFVpbnQ4QXJyYXk7IHN1cHByZXNzZWQ6IGJvb2xlYW4gfVtdID0gW107XG4gIHByaXZhdGUgcmVjZW50Qnl0ZXMgPSAwO1xuICByZWFkeSA9IGZhbHNlO1xuXG4gIGNvbnN0cnVjdG9yKFxuICAgIGNhbGxiYWNrczogV2FrZUNsaWVudENhbGxiYWNrcyxcbiAgICBjcmVhdGVXb3JrZXI6ICgpID0+IFdvcmtlckxpa2UgPSAoKSA9PiBuZXcgV29ya2VyKFwiL3dha2Uud29ya2VyLmpzXCIsIHsgdHlwZTogXCJtb2R1bGVcIiB9KSxcbiAgKSB7XG4gICAgdGhpcy5jYWxsYmFja3MgPSBjYWxsYmFja3M7XG4gICAgdGhpcy5jcmVhdGVXb3JrZXIgPSBjcmVhdGVXb3JrZXI7XG4gIH1cblxuICAvKiogTGF0ZXN0IG1vbm90b25pYyBzZXF1ZW5jZSBudW1iZXIgYXNzaWduZWQgYnkgYGZlZWQoKWAuICovXG4gIGdldCBsYXN0U2VxKCk6IG51bWJlciB7XG4gICAgcmV0dXJuIHRoaXMuc2VxO1xuICB9XG5cbiAgLyoqIEhpZ2hlc3Qgc2VxdWVuY2UgbnVtYmVyIG9mIGFuIGluLWZsaWdodCBzdXBwcmVzc2VkIGZyYW1lLCBvciAwIGlmIG5vbmUgYXJlIHNjb3JpbmcuICovXG4gIGdldCBpbkZsaWdodFN1cHByZXNzZWRTZXEoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gdGhpcy5sYXN0U3VwcHJlc3NlZFNlcSA+IHRoaXMubGFzdEFja2VkU2VxID8gdGhpcy5sYXN0U3VwcHJlc3NlZFNlcSA6IDA7XG4gIH1cblxuICAvKiogVHJ1ZSB3aGlsZSBhdCBsZWFzdCBvbmUgc3VwcHJlc3NlZCBmcmFtZSBpcyBzdGlsbCBxdWV1ZWQgb3Igc2NvcmluZyBpbiB0aGUgd29ya2VyLiAqL1xuICBnZXQgc3VwcHJlc3NlZEluRmxpZ2h0KCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLmluRmxpZ2h0U3VwcHJlc3NlZFNlcSA+IDA7XG4gIH1cblxuICBwcml2YXRlIGNsZWFyUmVjZW50KCk6IHZvaWQge1xuICAgIHRoaXMucmVjZW50ID0gW107XG4gICAgdGhpcy5yZWNlbnRCeXRlcyA9IDA7XG4gIH1cblxuICBwcml2YXRlIGNsZWFyU3VwcHJlc3NlZFRyYWNraW5nKCk6IHZvaWQge1xuICAgIGNvbnN0IGhhZEluRmxpZ2h0ID0gdGhpcy5zdXBwcmVzc2VkSW5GbGlnaHQ7XG4gICAgdGhpcy5sYXN0U3VwcHJlc3NlZFNlcSA9IDA7XG4gICAgdGhpcy5sYXN0QWNrZWRTZXEgPSAwO1xuICAgIGlmIChoYWRJbkZsaWdodCkgdGhpcy5jYWxsYmFja3Mub25TdXBwcmVzc2VkU2V0dGxlZD8uKCk7XG4gIH1cblxuICBwcml2YXRlIGVuc3VyZVdvcmtlcigpOiBXb3JrZXJMaWtlIHtcbiAgICBpZiAodGhpcy53b3JrZXIpIHJldHVybiB0aGlzLndvcmtlcjtcbiAgICBjb25zdCB3b3JrZXIgPSB0aGlzLmNyZWF0ZVdvcmtlcigpO1xuICAgIHdvcmtlci5vbm1lc3NhZ2UgPSAoZTogTWVzc2FnZUV2ZW50PFJlY29yZDxzdHJpbmcsIGFueT4+KSA9PiB7XG4gICAgICBjb25zdCBtID0gZS5kYXRhO1xuICAgICAgaWYgKHR5cGVvZiBtLmdlbiA9PT0gXCJudW1iZXJcIiAmJiBtLmdlbiAhPT0gdGhpcy5nZW4pIHJldHVybjtcbiAgICAgIGlmIChtLnR5cGUgPT09IFwicmVhZHlcIikge1xuICAgICAgICB0aGlzLmxvYWRpbmdNb2RlbElkID0gbnVsbDtcbiAgICAgICAgdGhpcy5sb2FkZWRNb2RlbElkID0gbS5tb2RlbElkO1xuICAgICAgICB0aGlzLnJlYWR5ID0gdHJ1ZTtcbiAgICAgICAgdGhpcy5jYWxsYmFja3Mub25SZWFkeT8uKG0ubW9kZWxJZCwgbS53YXJtdXBNcyk7XG4gICAgICB9IGVsc2UgaWYgKG0udHlwZSA9PT0gXCJhY2tcIikge1xuICAgICAgICBjb25zdCB3YXNJbkZsaWdodCA9IHRoaXMuc3VwcHJlc3NlZEluRmxpZ2h0O1xuICAgICAgICBpZiAodHlwZW9mIG0uc2VxID09PSBcIm51bWJlclwiICYmIG0uc2VxID4gdGhpcy5sYXN0QWNrZWRTZXEpIHRoaXMubGFzdEFja2VkU2VxID0gbS5zZXE7XG4gICAgICAgIGlmICh3YXNJbkZsaWdodCAmJiAhdGhpcy5zdXBwcmVzc2VkSW5GbGlnaHQpIHRoaXMuY2FsbGJhY2tzLm9uU3VwcHJlc3NlZFNldHRsZWQ/LigpO1xuICAgICAgfSBlbHNlIGlmIChtLnR5cGUgPT09IFwiZGV0ZWN0ZWRcIikge1xuICAgICAgICBjb25zdCB0cmFpbGluZzogV2FrZVRyYWlsaW5nQ2h1bmtbXSA9IFtdO1xuICAgICAgICBjb25zdCByZXN0ID0gbmV3IFVpbnQ4QXJyYXkobS5yZXN0Qnl0ZXMgYXMgQXJyYXlCdWZmZXIpO1xuICAgICAgICBjb25zdCBoaXRTZXEgPSB0eXBlb2YgbS5zZXEgPT09IFwibnVtYmVyXCIgPyBtLnNlcSA6IE51bWJlci5NQVhfU0FGRV9JTlRFR0VSO1xuICAgICAgICBjb25zdCBoaXRJdGVtID0gdGhpcy5yZWNlbnQuZmluZCgoaXRlbSkgPT4gaXRlbS5zZXEgPT09IGhpdFNlcSk7XG4gICAgICAgIGlmIChyZXN0LmJ5dGVMZW5ndGggPiAwKSB7XG4gICAgICAgICAgdHJhaWxpbmcucHVzaCh7IHNlcTogaGl0U2VxLCBieXRlczogcmVzdCwgc3VwcHJlc3NlZDogaGl0SXRlbT8uc3VwcHJlc3NlZCA/PyBmYWxzZSB9KTtcbiAgICAgICAgfVxuICAgICAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgdGhpcy5yZWNlbnQpIHtcbiAgICAgICAgICBpZiAoaXRlbS5zZXEgPiBoaXRTZXEpIHRyYWlsaW5nLnB1c2goeyBzZXE6IGl0ZW0uc2VxLCBieXRlczogaXRlbS5ieXRlcywgc3VwcHJlc3NlZDogaXRlbS5zdXBwcmVzc2VkIH0pO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMuY2xlYXJSZWNlbnQoKTtcbiAgICAgICAgdGhpcy5sYXN0U3VwcHJlc3NlZFNlcSA9IDA7XG4gICAgICAgIHRoaXMubGFzdEFja2VkU2VxID0gMDtcbiAgICAgICAgdGhpcy5jYWxsYmFja3Mub25EZXRlY3RlZCh7XG4gICAgICAgICAgc2NvcmU6IG0uc2NvcmUsXG4gICAgICAgICAgYXRGcmFtZTogbS5hdEZyYW1lLFxuICAgICAgICAgIHRyYWlsaW5nLFxuICAgICAgICAgIGluZmVyTXM6IG0uaW5mZXJNcyxcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2UgaWYgKG0udHlwZSA9PT0gXCJ0ZWxlbWV0cnlcIikge1xuICAgICAgICB0aGlzLmNhbGxiYWNrcy5vblRlbGVtZXRyeT8uKHtcbiAgICAgICAgICBzY29yZTogbS5zY29yZSxcbiAgICAgICAgICBwZWFrOiBtLnBlYWssXG4gICAgICAgICAgZ2F0ZU9wZW46IG0uZ2F0ZU9wZW4sXG4gICAgICAgICAgZnJhbWVzOiBtLmZyYW1lcyxcbiAgICAgICAgICBzY29yZWQ6IG0uc2NvcmVkLFxuICAgICAgICAgIGluZmVyTXM6IG0uaW5mZXJNcyxcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2UgaWYgKG0udHlwZSA9PT0gXCJlcnJvclwiKSB7XG4gICAgICAgIHRoaXMubG9hZGluZ01vZGVsSWQgPSBudWxsO1xuICAgICAgICB0aGlzLnJlYWR5ID0gZmFsc2U7XG4gICAgICAgIHRoaXMuY2xlYXJTdXBwcmVzc2VkVHJhY2tpbmcoKTtcbiAgICAgICAgdGhpcy5jYWxsYmFja3Mub25FcnJvcj8uKFN0cmluZyhtLm1lc3NhZ2UgPz8gXCJ3YWtlIHdvcmtlciBlcnJvclwiKSk7XG4gICAgICB9XG4gICAgfTtcbiAgICB3b3JrZXIub25lcnJvciA9IChlcnIpID0+IHtcbiAgICAgIHRoaXMubG9hZGluZ01vZGVsSWQgPSBudWxsO1xuICAgICAgdGhpcy5yZWFkeSA9IGZhbHNlO1xuICAgICAgdGhpcy5jbGVhclN1cHByZXNzZWRUcmFja2luZygpO1xuICAgICAgdGhpcy5jYWxsYmFja3Mub25FcnJvcj8uKGVyci5tZXNzYWdlIHx8IFwid2FrZSB3b3JrZXIgZmFpbGVkXCIpO1xuICAgIH07XG4gICAgdGhpcy53b3JrZXIgPSB3b3JrZXI7XG4gICAgcmV0dXJuIHdvcmtlcjtcbiAgfVxuXG4gIC8qKiBMb2FkcyAob3Igc3dpdGNoZXMgdG8pIHRoZSBuYW1lZCBtb2RlbDsgaWdub3JlcyBzdGFsZSByZXN1bHRzIGZyb20gZWFybGllciBsb2Fkcy4gKi9cbiAgbG9hZChtb2RlbElkOiBzdHJpbmcsIHRocmVzaG9sZDogbnVtYmVyKTogdm9pZCB7XG4gICAgdGhpcy5jdXJyZW50VGhyZXNob2xkID0gdGhyZXNob2xkO1xuICAgIGNvbnN0IHdvcmtlciA9IHRoaXMuZW5zdXJlV29ya2VyKCk7XG4gICAgaWYgKHRoaXMucmVhZHkgJiYgdGhpcy5sb2FkZWRNb2RlbElkID09PSBtb2RlbElkKSB7XG4gICAgICB3b3JrZXIucG9zdE1lc3NhZ2UoeyB0eXBlOiBcImNvbmZpZ1wiLCB0aHJlc2hvbGQgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICh0aGlzLmxvYWRpbmdNb2RlbElkID09PSBtb2RlbElkKSB7XG4gICAgICB3b3JrZXIucG9zdE1lc3NhZ2UoeyB0eXBlOiBcImNvbmZpZ1wiLCB0aHJlc2hvbGQgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRoaXMuZ2VuKys7XG4gICAgdGhpcy5yZWFkeSA9IGZhbHNlO1xuICAgIHRoaXMubG9hZGluZ01vZGVsSWQgPSBtb2RlbElkO1xuICAgIHRoaXMuY2xlYXJSZWNlbnQoKTtcbiAgICB0aGlzLmNsZWFyU3VwcHJlc3NlZFRyYWNraW5nKCk7XG4gICAgd29ya2VyLnBvc3RNZXNzYWdlKHtcbiAgICAgIHR5cGU6IFwibG9hZFwiLFxuICAgICAgZ2VuOiB0aGlzLmdlbixcbiAgICAgIG1vZGVsSWQsXG4gICAgICB1cmw6IGAvd2FrZS9tb2RlbHMvJHtlbmNvZGVVUklDb21wb25lbnQobW9kZWxJZCl9Lm9ubnhgLFxuICAgICAgdGhyZXNob2xkLFxuICAgICAgd2FzbVBhdGhzOiBcIi9vcnQvXCIsXG4gICAgfSk7XG4gIH1cblxuICBzZXRUaHJlc2hvbGQodGhyZXNob2xkOiBudW1iZXIpOiB2b2lkIHtcbiAgICB0aGlzLmN1cnJlbnRUaHJlc2hvbGQgPSB0aHJlc2hvbGQ7XG4gICAgdGhpcy53b3JrZXI/LnBvc3RNZXNzYWdlKHsgdHlwZTogXCJjb25maWdcIiwgdGhyZXNob2xkIH0pO1xuICB9XG5cbiAgLyoqIEZlZWRzIGEgMTYga0h6IFBDTTE2IGNodW5rIHRvIHRoZSB3b3JrZXI7IHJldHVybnMgaXRzIHNlcXVlbmNlIG51bWJlciAob3IgMCBpZiBub3QgcmVhZHkpLiAqL1xuICBmZWVkKHNhbXBsZXM6IEludDE2QXJyYXksIHN1cHByZXNzZWQgPSBmYWxzZSk6IG51bWJlciB7XG4gICAgaWYgKCF0aGlzLnJlYWR5IHx8ICF0aGlzLndvcmtlcikgcmV0dXJuIDA7XG4gICAgY29uc3Qgc2VxID0gKyt0aGlzLnNlcTtcbiAgICBpZiAoc3VwcHJlc3NlZCkgdGhpcy5sYXN0U3VwcHJlc3NlZFNlcSA9IHNlcTtcbiAgICBjb25zdCBieXRlcyA9IG5ldyBVaW50OEFycmF5KHNhbXBsZXMuYnl0ZUxlbmd0aCk7XG4gICAgYnl0ZXMuc2V0KG5ldyBVaW50OEFycmF5KHNhbXBsZXMuYnVmZmVyLCBzYW1wbGVzLmJ5dGVPZmZzZXQsIHNhbXBsZXMuYnl0ZUxlbmd0aCkpO1xuICAgIHRoaXMucmVjZW50LnB1c2goeyBzZXEsIGJ5dGVzLCBzdXBwcmVzc2VkIH0pO1xuICAgIHRoaXMucmVjZW50Qnl0ZXMgKz0gYnl0ZXMuYnl0ZUxlbmd0aDtcbiAgICB3aGlsZSAodGhpcy5yZWNlbnRCeXRlcyA+IFJFQ0VOVF9NQVhfQllURVMgJiYgdGhpcy5yZWNlbnQubGVuZ3RoID4gMSkge1xuICAgICAgdGhpcy5yZWNlbnRCeXRlcyAtPSB0aGlzLnJlY2VudC5zaGlmdCgpIS5ieXRlcy5ieXRlTGVuZ3RoO1xuICAgIH1cbiAgICBjb25zdCBjb3B5ID0gbmV3IEludDE2QXJyYXkoc2FtcGxlcy5sZW5ndGgpO1xuICAgIGNvcHkuc2V0KHNhbXBsZXMpO1xuICAgIHRoaXMud29ya2VyLnBvc3RNZXNzYWdlKHsgdHlwZTogXCJmZWVkXCIsIGdlbjogdGhpcy5nZW4sIHNlcSwgYWNrOiBzdXBwcmVzc2VkLCBwY206IGNvcHkuYnVmZmVyIH0sIFtjb3B5LmJ1ZmZlcl0pO1xuICAgIHJldHVybiBzZXE7XG4gIH1cblxuICByZXNldCgpOiB2b2lkIHtcbiAgICB0aGlzLmNsZWFyUmVjZW50KCk7XG4gICAgdGhpcy5jbGVhclN1cHByZXNzZWRUcmFja2luZygpO1xuICAgIGlmICghdGhpcy53b3JrZXIgfHwgIXRoaXMucmVhZHkpIHJldHVybjtcbiAgICB0aGlzLmdlbisrO1xuICAgIHRoaXMud29ya2VyLnBvc3RNZXNzYWdlKHsgdHlwZTogXCJyZXNldFwiLCBnZW46IHRoaXMuZ2VuIH0pO1xuICB9XG5cbiAgZGlzcG9zZSgpOiB2b2lkIHtcbiAgICB0aGlzLmdlbisrO1xuICAgIHRoaXMucmVhZHkgPSBmYWxzZTtcbiAgICB0aGlzLmxvYWRlZE1vZGVsSWQgPSBudWxsO1xuICAgIHRoaXMubG9hZGluZ01vZGVsSWQgPSBudWxsO1xuICAgIHRoaXMuY2xlYXJSZWNlbnQoKTtcbiAgICB0aGlzLmNsZWFyU3VwcHJlc3NlZFRyYWNraW5nKCk7XG4gICAgaWYgKHRoaXMud29ya2VyKSB7XG4gICAgICB0aGlzLndvcmtlci5wb3N0TWVzc2FnZSh7IHR5cGU6IFwiZGlzcG9zZVwiLCBnZW46IHRoaXMuZ2VuIH0pO1xuICAgICAgdGhpcy53b3JrZXIudGVybWluYXRlKCk7XG4gICAgICB0aGlzLndvcmtlciA9IG51bGw7XG4gICAgfVxuICB9XG5cbiAgZ2V0IG1vZGVsSWQoKTogc3RyaW5nIHwgbnVsbCB7XG4gICAgcmV0dXJuIHRoaXMubG9hZGVkTW9kZWxJZCA/PyB0aGlzLmxvYWRpbmdNb2RlbElkO1xuICB9XG5cbiAgZ2V0IHRocmVzaG9sZCgpOiBudW1iZXIge1xuICAgIHJldHVybiB0aGlzLmN1cnJlbnRUaHJlc2hvbGQ7XG4gIH1cbn1cblxuZXhwb3J0IGludGVyZmFjZSBXYWtlTG9ja1NlbnRpbmVsTGlrZSB7XG4gIHJlYWRvbmx5IHJlbGVhc2VkPzogYm9vbGVhbjtcbiAgcmVsZWFzZSgpOiBQcm9taXNlPHZvaWQ+O1xuICBhZGRFdmVudExpc3RlbmVyPyh0eXBlOiBzdHJpbmcsIGxpc3RlbmVyOiAoKSA9PiB2b2lkKTogdm9pZDtcbn1cblxuLyoqXG4gKiBXcmFwcyB0aGUgU2NyZWVuIFdha2UgTG9jayBBUEkgc28gYnJvd3Nlci1pbml0aWF0ZWQgcmVsZWFzZXMgKHN1Y2ggYXMgaGlkaW5nIGEgdGFiKSBjbGVhciB0aGVcbiAqIHN0b3JlZCBzZW50aW5lbCBhbmQgYWxsb3cgcmVhY3F1aXJpbmcgb24gdmlzaWJpbGl0eSByZXN0b3JlLCB3aGlsZSBjYW5jZWxsaW5nIGluLWZsaWdodCByZXF1ZXN0cy5cbiAqL1xuZXhwb3J0IGNsYXNzIFNjcmVlbldha2VMb2NrIHtcbiAgcHJpdmF0ZSBzZW50aW5lbDogV2FrZUxvY2tTZW50aW5lbExpa2UgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBnZW4gPSAwO1xuICBwcml2YXRlIHJlYWRvbmx5IHJlcXVlc3RMb2NrOiAoKSA9PiBQcm9taXNlPFdha2VMb2NrU2VudGluZWxMaWtlIHwgdW5kZWZpbmVkPjtcblxuICBjb25zdHJ1Y3RvcihcbiAgICByZXF1ZXN0TG9jazogKCkgPT4gUHJvbWlzZTxXYWtlTG9ja1NlbnRpbmVsTGlrZSB8IHVuZGVmaW5lZD4gPSAoKSA9PlxuICAgICAgKG5hdmlnYXRvciBhcyBhbnkpLndha2VMb2NrPy5yZXF1ZXN0KFwic2NyZWVuXCIpID8/IFByb21pc2UucmVzb2x2ZSh1bmRlZmluZWQpLFxuICApIHtcbiAgICB0aGlzLnJlcXVlc3RMb2NrID0gcmVxdWVzdExvY2s7XG4gIH1cblxuICBnZXQgaGVsZCgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5zZW50aW5lbCAhPSBudWxsICYmICF0aGlzLnNlbnRpbmVsLnJlbGVhc2VkO1xuICB9XG5cbiAgYXN5bmMgYWNxdWlyZShzdGlsbFdhbnRlZDogKCkgPT4gYm9vbGVhbik6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICh0aGlzLmhlbGQgfHwgIXN0aWxsV2FudGVkKCkpIHJldHVybjtcbiAgICBjb25zdCBnZW4gPSArK3RoaXMuZ2VuO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBsb2NrID0gYXdhaXQgdGhpcy5yZXF1ZXN0TG9jaygpO1xuICAgICAgaWYgKCFsb2NrKSByZXR1cm47XG4gICAgICBpZiAoZ2VuICE9PSB0aGlzLmdlbiB8fCAhc3RpbGxXYW50ZWQoKSkge1xuICAgICAgICB2b2lkIGxvY2sucmVsZWFzZSgpLmNhdGNoKCgpID0+IHt9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgdGhpcy5zZW50aW5lbCA9IGxvY2s7XG4gICAgICBsb2NrLmFkZEV2ZW50TGlzdGVuZXI/LihcInJlbGVhc2VcIiwgKCkgPT4ge1xuICAgICAgICBpZiAodGhpcy5zZW50aW5lbCA9PT0gbG9jaykgdGhpcy5zZW50aW5lbCA9IG51bGw7XG4gICAgICB9KTtcbiAgICB9IGNhdGNoIHt9XG4gIH1cblxuICByZWxlYXNlKCk6IHZvaWQge1xuICAgIHRoaXMuZ2VuKys7XG4gICAgY29uc3QgbG9jayA9IHRoaXMuc2VudGluZWw7XG4gICAgdGhpcy5zZW50aW5lbCA9IG51bGw7XG4gICAgdm9pZCBsb2NrPy5yZWxlYXNlKCkuY2F0Y2goKCkgPT4ge30pO1xuICB9XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRGVmZXJyZWRNaWNGcmFtZSB7XG4gIHNlcTogbnVtYmVyO1xuICBmbG9vclNlcTogbnVtYmVyO1xuICBwY206IHN0cmluZztcbiAgdDogbnVtYmVyO1xufVxuXG4vKipcbiAqIE1pcnJvcnMgdGhlIHZvaWNlIGNvcmUncyBwbGF5YmFjayBzdXBwcmVzc2lvbiBjbG9jayBhbmQgY29vcmRpbmF0ZXMgZGVmZXJyZWQgcG9zdC1wbGF5YmFja1xuICogbWljcm9waG9uZSBmcmFtZXMgd2l0aCBhc3luY2hyb25vdXMgd2FrZS13b3JkIHRhaWwgcmVwbGF5LlxuICpcbiAqIFNlcGFyYXRpbmcgd2FrZSBhY2NlcHRhbmNlIGZyb20gcmVwbGF5IGVsaWdpYmlsaXR5IChgcmVwbGF5Rmxvb3JTZXFgKSBlbnN1cmVzIHRoYXQgZm9yd2FyZGluZ1xuICogYSBnYXAgZnJhbWUgYmVmb3JlIG5ldyBwbGF5YmFjayBuZXZlciBzaWxlbmNlcyBnYXAgYXVkaW8sIG5ldmVyIGRpc2NhcmRzIGEgdmFsaWQgd2FrZSBoaXQsXG4gKiBhbmQgbmV2ZXIgcmVwbGF5cyBvbGRlciBzdXBwcmVzc2VkIGF1ZGlvIGFmdGVyIG5ld2VyIGF1ZGlvIGFscmVhZHkgc2VudCB0byB0aGUgY29yZS5cbiAqL1xuZXhwb3J0IGNsYXNzIFdha2VBdWRpb0dhdGUge1xuICBwcml2YXRlIHdoaWxlU3BlYWtpbmcgPSBcInNlbmRcIjtcbiAgcHJpdmF0ZSBzcGVlY2hVbnRpbCA9IDA7XG4gIHByaXZhdGUgYW5ub3VuY2VyRnJvbSA9IDA7XG4gIHByaXZhdGUgYW5ub3VuY2VyVW50aWwgPSAwO1xuICBwcml2YXRlIHBlbmRpbmdIb3N0QnJpZWZzID0gMDtcbiAgcHJpdmF0ZSByZXF1ZXN0ZWRCcmllZklkcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBwcml2YXRlIHJlcGxheUZsb29yU2VxID0gMDtcbiAgcHJpdmF0ZSBkZWZlcnJlZDogRGVmZXJyZWRNaWNGcmFtZVtdID0gW107XG4gIHByaXZhdGUgcmVhZG9ubHkgbWF4RGVmZXJyZWQ6IG51bWJlcjtcblxuICBjb25zdHJ1Y3RvcihtYXhEZWZlcnJlZCA9IDYwKSB7XG4gICAgdGhpcy5tYXhEZWZlcnJlZCA9IG1heERlZmVycmVkO1xuICB9XG5cbiAgcmVzZXQod2hpbGVTcGVha2luZyA9IFwic2VuZFwiLCBmbG9vclNlcSA9IDApOiB2b2lkIHtcbiAgICB0aGlzLndoaWxlU3BlYWtpbmcgPSB3aGlsZVNwZWFraW5nO1xuICAgIHRoaXMuc3BlZWNoVW50aWwgPSAwO1xuICAgIHRoaXMuYW5ub3VuY2VyRnJvbSA9IDA7XG4gICAgdGhpcy5hbm5vdW5jZXJVbnRpbCA9IDA7XG4gICAgdGhpcy5wZW5kaW5nSG9zdEJyaWVmcyA9IDA7XG4gICAgdGhpcy5yZXF1ZXN0ZWRCcmllZklkcy5jbGVhcigpO1xuICAgIHRoaXMucmVwbGF5Rmxvb3JTZXEgPSBmbG9vclNlcTtcbiAgICB0aGlzLmRlZmVycmVkID0gW107XG4gIH1cblxuICBnZXQgaGFzRGVmZXJyZWQoKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMuZGVmZXJyZWQubGVuZ3RoID4gMDtcbiAgfVxuXG4gIGlzU3VwcHJlc3NlZCh0OiBudW1iZXIpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy53aGlsZVNwZWFraW5nICE9PSBcInNlbmRcIiAmJiB0IDwgdGhpcy5zcGVlY2hVbnRpbDtcbiAgfVxuXG4gIG9uQnJpZWZSZXF1ZXN0KGlkOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAoaWQpIHRoaXMucmVxdWVzdGVkQnJpZWZJZHMuYWRkKGlkKTtcbiAgfVxuXG4gIG9uUGxheShwY21CYXNlNjQ6IHN0cmluZywgZXZlbnRUaW1lOiBudW1iZXIsIHNvdXJjZT86IHN0cmluZyk6IHZvaWQge1xuICAgIGNvbnN0IHBhZCA9IHBjbUJhc2U2NC5lbmRzV2l0aChcIj09XCIpID8gMiA6IHBjbUJhc2U2NC5lbmRzV2l0aChcIj1cIikgPyAxIDogMDtcbiAgICBjb25zdCBwY21CeXRlcyA9IE1hdGgubWF4KDAsIE1hdGguZmxvb3IoKHBjbUJhc2U2NC5sZW5ndGggKiAzKSAvIDQpIC0gcGFkKTtcbiAgICB0aGlzLnNwZWVjaFVudGlsID0gTWF0aC5tYXgodGhpcy5zcGVlY2hVbnRpbCwgZXZlbnRUaW1lKSArIHBjbUJ5dGVzIC8gNDhfMDAwO1xuICAgIGlmIChzb3VyY2UgPT09IFwiYW5ub3VuY2VyXCIpIHtcbiAgICAgIHRoaXMucGVuZGluZ0hvc3RCcmllZnMgPSBNYXRoLm1heCgwLCB0aGlzLnBlbmRpbmdIb3N0QnJpZWZzIC0gMSk7XG4gICAgICB0aGlzLmFubm91bmNlckZyb20gPSBldmVudFRpbWU7XG4gICAgICB0aGlzLmFubm91bmNlclVudGlsID0gdGhpcy5zcGVlY2hVbnRpbDtcbiAgICB9XG4gIH1cblxuICBvbkZsdXNoKGV2ZW50VGltZTogbnVtYmVyLCBjYXVzZT86IHN0cmluZyk6IHZvaWQge1xuICAgIHRoaXMuc3BlZWNoVW50aWwgPSBNYXRoLm1pbih0aGlzLnNwZWVjaFVudGlsLCBldmVudFRpbWUpO1xuICAgIGlmIChldmVudFRpbWUgPCB0aGlzLmFubm91bmNlclVudGlsKSB7XG4gICAgICAvLyBNYXRjaCBjYWxsLnRzIGN1dEFubm91bmNlbWVudCgpOiBhIGJyaWVmIGN1dCBhdCA+PSA4MCUgKG9yIGV4cGxpY2l0bHkgc3RvcHBlZC9odXNoZWQpIGlzIG5vdCByZS1xdWV1ZWQuXG4gICAgICBjb25zdCBwbGF5ZWQgPSAoZXZlbnRUaW1lIC0gdGhpcy5hbm5vdW5jZXJGcm9tKSAvIE1hdGgubWF4KDAuMSwgdGhpcy5hbm5vdW5jZXJVbnRpbCAtIHRoaXMuYW5ub3VuY2VyRnJvbSk7XG4gICAgICBpZiAocGxheWVkIDwgMC44ICYmIGNhdXNlICE9PSBcImludGVycnVwdFwiICYmIGNhdXNlICE9PSBcInN0b3BcIikge1xuICAgICAgICB0aGlzLnBlbmRpbmdIb3N0QnJpZWZzKys7XG4gICAgICB9XG4gICAgICB0aGlzLmFubm91bmNlckZyb20gPSAwO1xuICAgICAgdGhpcy5hbm5vdW5jZXJVbnRpbCA9IDA7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIENhbGxlZCBpbW1lZGlhdGVseSBiZWZvcmUgcHVzaGluZyBhbiBldmVudCB0byB0aGUgY29yZS4gUmV0dXJucyBhbnkgZGVmZXJyZWQgdW5zdXBwcmVzc2VkXG4gICAqIGdhcCBmcmFtZXMgdGhhdCBtdXN0IHJlYWNoIHRoZSBjb3JlIGZpcnN0IHNvIG5ldyBwbGF5YmFjayBjYW5ub3Qgc2lsZW5jZSB0aGVtLlxuICAgKi9cbiAgYmVmb3JlUHVzaChldmVudDogeyB0eXBlPzogdW5rbm93bjsgaWQ/OiB1bmtub3duOyBwY20/OiB1bmtub3duOyB0ZXh0PzogdW5rbm93bjsgZGF0YT86IHVua25vd24gfSk6IHsgcGNtOiBzdHJpbmc7IHQ6IG51bWJlciB9W10ge1xuICAgIGlmIChcbiAgICAgIGV2ZW50LnR5cGUgPT09IFwiYnJpZWYucmVhZHlcIiAmJlxuICAgICAgdHlwZW9mIGV2ZW50LmlkID09PSBcInN0cmluZ1wiICYmXG4gICAgICB0aGlzLnJlcXVlc3RlZEJyaWVmSWRzLmRlbGV0ZShldmVudC5pZCkgJiZcbiAgICAgIHR5cGVvZiBldmVudC5wY20gPT09IFwic3RyaW5nXCIgJiZcbiAgICAgIGV2ZW50LnBjbS5sZW5ndGggPiAwICYmXG4gICAgICB0eXBlb2YgZXZlbnQudGV4dCA9PT0gXCJzdHJpbmdcIiAmJlxuICAgICAgZXZlbnQudGV4dC50cmltKCkubGVuZ3RoID4gMFxuICAgICkge1xuICAgICAgdGhpcy5wZW5kaW5nSG9zdEJyaWVmcysrO1xuICAgIH1cbiAgICBpZiAodGhpcy5kZWZlcnJlZC5sZW5ndGggPT09IDApIHJldHVybiBbXTtcbiAgICBjb25zdCBjYW5TdGFydFBsYXliYWNrID1cbiAgICAgIGV2ZW50LnR5cGUgPT09IFwiYnJpZWYucmVhZHlcIiB8fFxuICAgICAgKHRoaXMucGVuZGluZ0hvc3RCcmllZnMgPiAwICYmIGV2ZW50LnR5cGUgPT09IFwidGlja1wiKSB8fFxuICAgICAgKGV2ZW50LnR5cGUgPT09IFwid3MubWVzc2FnZVwiICYmIFN0cmluZyhldmVudC5kYXRhID8/IFwiXCIpLmluY2x1ZGVzKCdcImlubGluZURhdGFcIicpKTtcbiAgICByZXR1cm4gY2FuU3RhcnRQbGF5YmFjayA/IHRoaXMuZmx1c2hEZWZlcnJlZCgpIDogW107XG4gIH1cblxuICBmbHVzaERlZmVycmVkKCk6IHsgcGNtOiBzdHJpbmc7IHQ6IG51bWJlciB9W10ge1xuICAgIGlmICh0aGlzLmRlZmVycmVkLmxlbmd0aCA9PT0gMCkgcmV0dXJuIFtdO1xuICAgIGNvbnN0IGl0ZW1zID0gdGhpcy5kZWZlcnJlZC5zcGxpY2UoMCk7XG4gICAgZm9yIChjb25zdCBpdGVtIG9mIGl0ZW1zKSB7XG4gICAgICBpZiAoaXRlbS5mbG9vclNlcSA+IHRoaXMucmVwbGF5Rmxvb3JTZXEpIHRoaXMucmVwbGF5Rmxvb3JTZXEgPSBpdGVtLmZsb29yU2VxO1xuICAgIH1cbiAgICByZXR1cm4gaXRlbXMubWFwKCh7IHBjbSwgdCB9KSA9PiAoeyBwY20sIHQgfSkpO1xuICB9XG5cbiAgLyoqIERldGFjaGVzIGRlZmVycmVkIGZyYW1lcyBiZWZvcmUgYHB1c2goeyB0eXBlOiBcIndha2VcIiB9KWAgd2l0aG91dCBidW1waW5nIGByZXBsYXlGbG9vclNlcWAgeWV0LiAqL1xuICB0YWtlRGVmZXJyZWQoKTogRGVmZXJyZWRNaWNGcmFtZVtdIHtcbiAgICByZXR1cm4gdGhpcy5kZWZlcnJlZC5zcGxpY2UoMCk7XG4gIH1cblxuICBvbk1pY0ZyYW1lKHBhcmFtczoge1xuICAgIHBjbTogc3RyaW5nO1xuICAgIHQ6IG51bWJlcjtcbiAgICBzZXE6IG51bWJlcjtcbiAgICBsYXN0U2VxOiBudW1iZXI7XG4gICAgaW5GbGlnaHRTdXBwcmVzc2VkU2VxOiBudW1iZXI7XG4gICAgc3VwcHJlc3NlZDogYm9vbGVhbjtcbiAgfSk6IHsgcGNtOiBzdHJpbmc7IHQ6IG51bWJlciB9W10ge1xuICAgIGNvbnN0IGZsb29yU2VxID0gcGFyYW1zLnNlcSA+IDAgPyBwYXJhbXMuc2VxIDogcGFyYW1zLmxhc3RTZXE7XG4gICAgaWYgKCFwYXJhbXMuc3VwcHJlc3NlZCAmJiB0aGlzLndoaWxlU3BlYWtpbmcgIT09IFwic2VuZFwiICYmIHBhcmFtcy5pbkZsaWdodFN1cHByZXNzZWRTZXEgPiB0aGlzLnJlcGxheUZsb29yU2VxKSB7XG4gICAgICB0aGlzLmRlZmVycmVkLnB1c2goeyBzZXE6IHBhcmFtcy5zZXEsIGZsb29yU2VxLCBwY206IHBhcmFtcy5wY20sIHQ6IHBhcmFtcy50IH0pO1xuICAgICAgaWYgKHRoaXMuZGVmZXJyZWQubGVuZ3RoID4gdGhpcy5tYXhEZWZlcnJlZCkgcmV0dXJuIHRoaXMuZmx1c2hEZWZlcnJlZCgpO1xuICAgICAgcmV0dXJuIFtdO1xuICAgIH1cbiAgICBjb25zdCBvdXQgPSB0aGlzLmZsdXNoRGVmZXJyZWQoKTtcbiAgICBpZiAoIXBhcmFtcy5zdXBwcmVzc2VkICYmIGZsb29yU2VxID4gdGhpcy5yZXBsYXlGbG9vclNlcSkge1xuICAgICAgdGhpcy5yZXBsYXlGbG9vclNlcSA9IGZsb29yU2VxO1xuICAgIH1cbiAgICBvdXQucHVzaCh7IHBjbTogcGFyYW1zLnBjbSwgdDogcGFyYW1zLnQgfSk7XG4gICAgcmV0dXJuIG91dDtcbiAgfVxuXG4gIC8qKlxuICAgKiBDb21wdXRlcyB0aGUgb3JkZXJlZCBtaWMgZnJhbWVzIHRvIHJlcGxheSBhZnRlciBgcHVzaCh7IHR5cGU6IFwid2FrZVwiIH0pYCwgc2tpcHBpbmcgYW55IGNodW5rXG4gICAqIGF0IG9yIGJlbG93IGByZXBsYXlGbG9vclNlcWAgc28gYWxyZWFkeS1mb3J3YXJkZWQgZ2FwIGZyYW1lcyBhcmUgbmV2ZXIgZm9sbG93ZWQgYnkgb2xkZXIgYXVkaW8uXG4gICAqL1xuICBwbGFuV2FrZVJlcGxheShcbiAgICBoaXQ6IFdha2VEZXRlY3Rpb25FdmVudCxcbiAgICBkZWZlcnJlZDogRGVmZXJyZWRNaWNGcmFtZVtdLFxuICAgIGJ5dGVzVG9CYXNlNjQ6IChieXRlczogVWludDhBcnJheSkgPT4gc3RyaW5nLFxuICApOiB7IHBjbTogc3RyaW5nOyB0PzogbnVtYmVyIH1bXSB7XG4gICAgY29uc3QgZGVmZXJyZWRTZXFzID0gbmV3IFNldChkZWZlcnJlZC5tYXAoKGQpID0+IGQuc2VxKS5maWx0ZXIoKHMpID0+IHMgPiAwKSk7XG4gICAgY29uc3Qgb3V0OiB7IHBjbTogc3RyaW5nOyB0PzogbnVtYmVyIH1bXSA9IFtdO1xuICAgIGNvbnN0IHJlcGxheWVkU2VxcyA9IG5ldyBTZXQ8bnVtYmVyPigpO1xuICAgIGxldCBtYXhGbG9vciA9IHRoaXMucmVwbGF5Rmxvb3JTZXE7XG4gICAgZm9yIChjb25zdCBjaHVuayBvZiBoaXQudHJhaWxpbmcpIHtcbiAgICAgIGlmIChjaHVuay5ieXRlcy5ieXRlTGVuZ3RoID09PSAwKSBjb250aW51ZTtcbiAgICAgIGlmIChjaHVuay5zZXEgPD0gdGhpcy5yZXBsYXlGbG9vclNlcSkgY29udGludWU7XG4gICAgICBpZiAoIWNodW5rLnN1cHByZXNzZWQgJiYgIWRlZmVycmVkU2Vxcy5oYXMoY2h1bmsuc2VxKSkgY29udGludWU7XG4gICAgICBpZiAoY2h1bmsuc2VxID4gMCkge1xuICAgICAgICByZXBsYXllZFNlcXMuYWRkKGNodW5rLnNlcSk7XG4gICAgICAgIGlmIChjaHVuay5zZXEgPiBtYXhGbG9vcikgbWF4Rmxvb3IgPSBjaHVuay5zZXE7XG4gICAgICB9XG4gICAgICBvdXQucHVzaCh7IHBjbTogYnl0ZXNUb0Jhc2U2NChjaHVuay5ieXRlcykgfSk7XG4gICAgfVxuICAgIGZvciAoY29uc3QgaXRlbSBvZiBkZWZlcnJlZCkge1xuICAgICAgaWYgKGl0ZW0uZmxvb3JTZXEgPiBtYXhGbG9vcikgbWF4Rmxvb3IgPSBpdGVtLmZsb29yU2VxO1xuICAgICAgaWYgKGl0ZW0uc2VxID4gMCAmJiByZXBsYXllZFNlcXMuaGFzKGl0ZW0uc2VxKSkgY29udGludWU7XG4gICAgICBvdXQucHVzaCh7IHBjbTogaXRlbS5wY20sIHQ6IGl0ZW0udCB9KTtcbiAgICB9XG4gICAgdGhpcy5yZXBsYXlGbG9vclNlcSA9IG1heEZsb29yO1xuICAgIHJldHVybiBvdXQ7XG4gIH1cbn1cbiIsICIvLyBUaGUgd2ViIHN1cmZhY2U6IGEgZm91cnRoIGhvc3QgZm9yIHRoZSB2b2ljZSBjb3JlLCBhbmQgYSBwaG9uZS1mcmllbmRseSB3YXkgdG8gdXNlIGl0IGZvciB3b3JrLlxuLy8gSXQgbG9hZHMgdGhlIGRldiBzZXJ2ZXIncyBsYXRlc3QgYnVpbGQgYXQgZWFjaCBjYWxsLCBzbyBhbiBlZGl0IGluIHNyYy8gaXMgbGl2ZSBvbiB0aGUgbmV4dFxuLy8gY2FsbCwgYW5kIGtlZXBzIGV2ZXJ5IGNhbGwgYXMgYSB0cmFjZSB0aGUgcmVwbGF5IHZpZXcgKGFuZCBhbnkgb3RoZXIgaG9zdCkgY2FuIHJ1biBhZ2Fpbi5cbi8vXG4vLyBUaGUgaG9zdCdzIHBhcnQgaXMgc21hbGw6IHRoZSBtaWNyb3Bob25lIGFuZCBzcGVha2VyIChhdWRpby50cyksIHRoZSBtb2RlbCdzIHNvY2tldCB0aHJvdWdoIHRoZVxuLy8gc2VydmVyJ3MgcmVsYXksIEhlcm1lcyBhbmQgVDMgdGhyb3VnaCB0aGUgc2VydmVyLCBhbmQgdGhlIHNjcmVlbi4gVGhlIGNvcmUgZGVjaWRlcyB0aGUgcmVzdC5cbi8vXG4vLyBUeXBpbmcgd2l0aCBubyBjYWxsIG9uIHN0YXJ0cyBhIGNoYXQgaW5zdGVhZDogdGhlIHNhbWUgY29yZSB3aXRoIGBtZWRpdW06IFwidGV4dFwiYCwgd2hvc2UgcmVxdWVzdHNcbi8vIHRvIHRoZSB0ZXh0IG1vZGVsIGdvIHRocm91Z2ggdGhlIHNlcnZlcidzIC9nZW5lcmF0ZS4gVGFza3MsIGZvbGxvdy11cHMgYW5kIHRoZWlyIGNhcmRzIHdvcmsgYXNcbi8vIGluIGEgY2FsbC4gUHJlc3NpbmcgQ2FsbCBlbmRzIHRoZSBjaGF0IGFuZCBjYXJyaWVzIGl0cyBjb252ZXJzYXRpb24gb24gYnkgdm9pY2UuXG5cbmltcG9ydCB7IGNvbW1hbmRJbiB9IGZyb20gXCIuLi9zcmMvY29tbWFuZHMudHNcIjtcbmltcG9ydCB7IENhbGxBdWRpbywgYnl0ZXNUb0Jhc2U2NCB9IGZyb20gXCIuL2F1ZGlvLnRzXCI7XG5pbXBvcnQgeyBSZXBsYXkgfSBmcm9tIFwiLi9yZXBsYXkudHNcIjtcbmltcG9ydCB7IEF1dG9TY3JvbGxlciB9IGZyb20gXCIuL3Njcm9sbC50c1wiO1xuaW1wb3J0IHtcbiAgY2FuRm9sbG93VXBSZXN1bHQsXG4gIGZvcm1hdFNob3J0VGltZSxcbiAgbm9ybWFsaXplRGVuc2l0eSxcbiAgbm9ybWFsaXplU2lkZUZpbHRlcixcbiAgcGFyc2VQcmVmaXgsXG4gIHBsYWluUHJldmlldyxcbiAgcmVzb2x2ZU1vYmlsZUJhbm5lckZpbHRlcixcbiAgcmVzb2x2ZVNpZGVTZWN0aW9ucyxcbiAgc2hvdWxkQ2xlYXJVbnJlYWRSZXN1bHRzLFxuICB0eXBlIFNpZGVGaWx0ZXIsXG59IGZyb20gXCIuL3VpLnRzXCI7XG5pbXBvcnQgeyBTY3JlZW5XYWtlTG9jaywgV2FrZUF1ZGlvR2F0ZSwgV2FrZUNsaWVudCwgdHlwZSBXYWtlRGV0ZWN0aW9uRXZlbnQsIHR5cGUgV2FrZVRlbGVtZXRyeSB9IGZyb20gXCIuL3dha2VDbGllbnQudHNcIjtcblxuaW50ZXJmYWNlIENvcmUge1xuICB2ZXJzaW9uOiBzdHJpbmc7XG4gIGRlZmF1bHRzKCk6IHN0cmluZztcbiAgY3JlYXRlKGNvbmZpZzogc3RyaW5nLCB0OiBudW1iZXIpOiBzdHJpbmc7XG4gIHB1c2goaWQ6IG51bWJlciwgZXZlbnQ6IHN0cmluZyk6IHN0cmluZztcbiAgdHJhY2UoaWQ6IG51bWJlcik6IHN0cmluZztcbiAgZGlzcG9zZShpZDogbnVtYmVyKTogdm9pZDtcbn1cbnR5cGUgQ29tbWFuZCA9IFJlY29yZDxzdHJpbmcsIGFueT4gJiB7IHR5cGU6IHN0cmluZyB9O1xuaW50ZXJmYWNlIFdha2VNb2RlbEluZm8geyBpZDogc3RyaW5nOyBsYWJlbDogc3RyaW5nIH1cbmludGVyZmFjZSBTZXJ2ZXJDb25maWcgeyByb3V0ZTogc3RyaW5nOyBtb2RlbDogc3RyaW5nOyBjYXB0aW9uc01vZGVsPzogc3RyaW5nOyB0ZXh0TW9kZWw/OiBzdHJpbmc7IHZlcnNpb246IHN0cmluZzsgaGVybWVzOiBib29sZWFuOyB0Mzogc3RyaW5nW10gfCBudWxsOyB3YWtlTW9kZWxzPzogV2FrZU1vZGVsSW5mb1tdIH1cblxuY29uc3QgJCA9IDxUIGV4dGVuZHMgSFRNTEVsZW1lbnQgPSBIVE1MRWxlbWVudD4oaWQ6IHN0cmluZykgPT4gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoaWQpIGFzIFQ7XG5jb25zdCBub3cgPSAoKSA9PiBwZXJmb3JtYW5jZS5ub3coKSAvIDEwMDA7XG5jb25zdCBjaGVja2VkID0gKGlkOiBzdHJpbmcpID0+ICQ8SFRNTElucHV0RWxlbWVudD4oaWQpLmNoZWNrZWQ7XG5cbi8qKiBUaGUgbGF0ZXN0IGJ1aWxkIGZyb20gdGhlIGRldiBzZXJ2ZXIsIGV2YWx1YXRlZCBhZnJlc2g6IGFuIGVkaXQgaW4gc3JjLyBpcyBpbiB0aGUgbmV4dCBjYWxsLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGxvYWRDb3JlKHVybCA9IFwiL3ZvaWNlLWNvcmUuanNcIik6IFByb21pc2U8Q29yZT4ge1xuICBjb25zdCBzb3VyY2UgPSBhd2FpdCAoYXdhaXQgZmV0Y2godXJsLCB7IGNhY2hlOiBcIm5vLXN0b3JlXCIgfSkpLnRleHQoKTtcbiAgY29uc3Qgc2NvcGU6IHsgVm9pY2VDb3JlPzogQ29yZSB9ID0ge307XG4gIG5ldyBGdW5jdGlvbihcImdsb2JhbFRoaXNcIiwgc291cmNlKShzY29wZSk7XG4gIGlmICghc2NvcGUuVm9pY2VDb3JlKSB0aHJvdyBuZXcgRXJyb3IoXCJ0aGUgYnVuZGxlIGRpZG4ndCBkZWZpbmUgVm9pY2VDb3JlXCIpO1xuICByZXR1cm4gc2NvcGUuVm9pY2VDb3JlO1xufVxuXG4vLyBQcmVzZXRzOiBlYWNoIHN1cmZhY2UncyBzZXR0aW5ncyBhcyBpdHMgYXBwIHdvdWxkIHNldCB0aGVtLlxuXG5jb25zdCBGQUtFX1RWID0gW1xuICB7IG5hbWU6IFwidHZfdm9sdW1lXCIsIGRlc2NyaXB0aW9uOiBcIlNldHMgdGhlIGxpdmluZy1yb29tIFRWJ3Mgdm9sdW1lLCAwIHRvIDEwMC5cIiwgcGFyYW1ldGVyczogeyB0eXBlOiBcIk9CSkVDVFwiLCBwcm9wZXJ0aWVzOiB7IGxldmVsOiB7IHR5cGU6IFwiSU5URUdFUlwiIH0gfSwgcmVxdWlyZWQ6IFtcImxldmVsXCJdIH0gfSxcbiAgeyBuYW1lOiBcInR2X3BhdXNlXCIsIGRlc2NyaXB0aW9uOiBcIlBhdXNlcyBvciByZXN1bWVzIHdoYXQncyBwbGF5aW5nIG9uIHRoZSBUVi5cIiwgcGFyYW1ldGVyczogeyB0eXBlOiBcIk9CSkVDVFwiLCBwcm9wZXJ0aWVzOiB7IHBhdXNlOiB7IHR5cGU6IFwiQk9PTEVBTlwiIH0gfSB9IH0sXG5dO1xuXG5jb25zdCBQUkVTRVRTOiBSZWNvcmQ8c3RyaW5nLCBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4gPSB7XG4gIHdlYjogeyBwbGF0Zm9ybTogXCJ3ZWJcIiwgZGV2aWNlOiBcImJyb3dzZXJcIiwgc3RhbmRieUFmdGVyOiAzMCwgaGFuZE9mZjogXCJuYW1lZFwiLCBzdXBlcnZpc2U6IHRydWUsIHZvY2FidWxhcnk6IFtcIkhlcm1lc1wiLCBcIkJlbnRvXCIsIFwiV29vZGhvdXNlXCIsIFwiUGVubnl3b3J0aFwiLCBcIlQzXCJdIH0sXG4gIFwid2ViIHdha2Ugd29yZFwiOiB7XG4gICAgcGxhdGZvcm06IFwid2ViXCIsIGRldmljZTogXCJicm93c2VyXCIsIHN0YW5kYnlBZnRlcjogMjAsIGhhbmdVcEFmdGVyOiAxMjAsIGhhbmRPZmY6IFwibmFtZWRcIiwgc3VwZXJ2aXNlOiB0cnVlLFxuICAgIGF0dGVudGlvbjogeyBtb2RlOiBcIndpbmRvd1wiLCBhZnRlcldha2U6IDgsIHdpbmRvdzogNSwgYWZ0ZXJRdWVzdGlvbjogMTAsIGFmdGVySGFuZE9mZjogMywgYWZ0ZXJBbm5vdW5jZW1lbnQ6IDAgfSxcbiAgICB2b2NhYnVsYXJ5OiBbXCJIZXJtZXNcIiwgXCJCZW50b1wiLCBcIldvb2Rob3VzZVwiLCBcIlBlbm55d29ydGhcIiwgXCJUM1wiXSxcbiAgfSxcbiAgYW5kcm9pZDogeyBwbGF0Zm9ybTogXCJBbmRyb2lkXCIsIGRldmljZTogXCJwaG9uZVwiLCBzdGFuZGJ5QWZ0ZXI6IDIwIH0sXG4gIFwiYW5kcm9pZCB3YWtlIHdvcmRcIjogeyBwbGF0Zm9ybTogXCJBbmRyb2lkXCIsIGRldmljZTogXCJwaG9uZVwiLCBzdGFuZGJ5QWZ0ZXI6IDIwLCBoYW5nVXBBZnRlcjogMTUgfSxcbiAgbWFjb3M6IHsgcGxhdGZvcm06IFwibWFjT1NcIiwgZGV2aWNlOiBcIk1hY1wiLCBzdGFuZGJ5QWZ0ZXI6IDIwIH0sXG4gIGVjaG86IHtcbiAgICBwbGF0Zm9ybTogXCJFY2hvXCIsIGRldmljZTogXCJzcGVha2VyXCIsIGhhbmdVcEFmdGVyOiA2LCBzdGFuZGJ5QWZ0ZXI6IDgsIGVhcmNvbnM6IHRydWUsIHZvY2FidWxhcnk6IFtcIkhlcm1lc1wiLCBcIkJlbnRvXCIsIFwiV29vZGhvdXNlXCJdLFxuICAgIG1pYzogeyB3aGlsZVNwZWFraW5nOiBcIndha2VcIiwgZ2FpbkRiOiAwIH0sIGhvc3RUb29sczogRkFLRV9UVixcbiAgfSxcbn07XG5cbi8vIFN0YXRlLlxuXG5jb25zdCBhdWRpbyA9IG5ldyBDYWxsQXVkaW8oKTtcbmxldCBzZXJ2ZXI6IFNlcnZlckNvbmZpZztcbmxldCBjb3JlOiBDb3JlIHwgbnVsbCA9IG51bGw7XG5sZXQgY2FsbElkID0gMDtcbi8qKiBNb25vdG9uaWMgcGVyLXBhZ2Ugc2Vzc2lvbiBpZCAodW5saWtlIGNvcmUncyBjYWxsSWQvdGFza0lkLCB3aGljaCByZXN0YXJ0IGFmdGVyIGxvYWRDb3JlKCkpLiAqL1xubGV0IHNlc3Npb25TZXEgPSAwO1xubGV0IGFjdGl2ZVNlc3Npb24gPSAwO1xubGV0IGNhbGxOYW1lID0gXCJcIjtcbmxldCB0aWNrZXIgPSAwO1xubGV0IHRyYWNlVGltZXIgPSAwO1xubGV0IHN0YXJ0ZWRBdCA9IG5vdygpO1xuY29uc3Qgc29ja2V0cyA9IG5ldyBNYXA8bnVtYmVyLCBXZWJTb2NrZXQ+KCk7XG4vKiogVGhlIHNvY2tldHMgdG8gdGhlIHRyYW5zY3JpcHRpb24gbW9kZWw6IHRoZWlyIGF1ZGlvIGlzIHRoZSBtb2RlbCdzIGFnYWluLCBzbyBpdCBpc24ndCBjb3VudGVkIG9yIGxvZ2dlZCB0d2ljZS4gKi9cbmNvbnN0IGNhcHRpb25Tb2NrZXRzID0gbmV3IFNldDxudW1iZXI+KCk7XG5jb25zdCBydW5zID0gbmV3IE1hcDxzdHJpbmcsIHsgYWJvcnQ6IEFib3J0Q29udHJvbGxlcjsgYWdlbnQ6IHN0cmluZzsgdGFza0lkOiBzdHJpbmcgfT4oKTtcbmludGVyZmFjZSBUYXNrVmlldyB7IGM6IENvbW1hbmQ7IHNpbmNlOiBudW1iZXI7IGVuZGVkOiBudW1iZXIgfCBudWxsOyB0aHJlYWQ/OiBzdHJpbmc7IHJlc3VsdElkPzogc3RyaW5nOyBhcHByb3ZhbD86IHsgY29tbWFuZDogc3RyaW5nIH0gfVxuY29uc3QgdGFza3MgPSBuZXcgTWFwPHN0cmluZywgVGFza1ZpZXc+KCk7XG5pbnRlcmZhY2UgUmVzdWx0RW50cnkge1xuICBpZDogc3RyaW5nO1xuICBhZ2VudDogc3RyaW5nO1xuICBsYWJlbDogc3RyaW5nO1xuICB0ZXh0OiBzdHJpbmc7XG4gIGZhaWxlZDogYm9vbGVhbjtcbiAgdGFza0lkPzogc3RyaW5nO1xuICBzZXNzaW9uSWQ6IG51bWJlcjtcbiAgY2FyZDogSFRNTEVsZW1lbnQ7XG4gIGhlYWQ6IEhUTUxCdXR0b25FbGVtZW50O1xuICBib2R5OiBIVE1MRWxlbWVudDtcbiAgbW9yZUJ0bjogSFRNTEJ1dHRvbkVsZW1lbnQ7XG4gIGZvbGxvd0J0bj86IEhUTUxCdXR0b25FbGVtZW50O1xuICByZWZSb3c6IEhUTUxCdXR0b25FbGVtZW50O1xufVxuY29uc3QgcmVzdWx0cyA9IG5ldyBNYXA8c3RyaW5nLCBSZXN1bHRFbnRyeT4oKTtcbmxldCBuZXh0UmVzdWx0U2VxID0gMDtcbmxldCBzaWRlRmlsdGVyOiBTaWRlRmlsdGVyID0gXCJhbGxcIjtcbmxldCB1bnJlYWRNb2JpbGVSZXN1bHRzID0gMDtcbmxldCBmbGFzaFRpbWVyID0gMDtcbmxldCBlYXJsaWVyQWN0aXZlQ291bnQgPSAwO1xubGV0IGVhcmxpZXJXYWl0aW5nQ291bnQgPSAwO1xubGV0IGNvdW50cyA9IHsgbWljOiAwLCBwbGF5OiAwLCBzZW50OiAwIH07XG5sZXQgZmFrZVR2TGV2ZWwgPSAxNTtcbmxldCBjb3JlU3RhdHVzID0gXCJpZGxlXCI7XG5sZXQgbXV0ZWQgPSBmYWxzZTtcbmxldCBob2xkaW5nID0gZmFsc2U7XG5jb25zdCBzY3JlZW5XYWtlTG9jayA9IG5ldyBTY3JlZW5XYWtlTG9jaygpO1xuLyoqIFdha2Ugd29yZCBsb29wIHN0YXRlOiBhcm1lZCBiZXR3ZWVuIGNhbGxzLCByZXF1ZXN0ZWQgYnkgY29yZSB3aGlsZSBkb3JtYW50L3NwZWFraW5nLCBvciBtaWQtaGFuZG9mZi4gKi9cbmxldCB3YWtlQXJtZWQgPSBmYWxzZTtcbmxldCBhcm1HZW4gPSAwO1xubGV0IGNvcmVXYW50c1dha2UgPSBmYWxzZTtcbi8qKiBXaGljaCBjYWxsIChvciAwIGZvciBpZGxlKSBvd25zIHRoZSB3YWtlIHdvcmtlcidzIGN1cnJlbnQgbGlzdGVuaW5nIHBlcmlvZC4gKi9cbmxldCB3YWtlUGVyaW9kQ2FsbElkOiBudW1iZXIgfCBudWxsID0gbnVsbDtcbmNvbnN0IHdha2VHYXRlID0gbmV3IFdha2VBdWRpb0dhdGUoKTtcbmxldCB3YWtlTG9hZGluZyA9IGZhbHNlO1xubGV0IHdha2VTdGFydGluZyA9IGZhbHNlO1xubGV0IHN0YXJ0aW5nQ2FsbCA9IGZhbHNlO1xubGV0IG9wZW5pbmdDaHVua3M6IFVpbnQ4QXJyYXlbXSA9IFtdO1xubGV0IG9wZW5pbmdCeXRlcyA9IDA7XG5jb25zdCBPUEVOSU5HX01BWF9CWVRFUyA9IDEwICogMzJfMDAwO1xubGV0IHdha2VMYXN0VGVsOiBXYWtlVGVsZW1ldHJ5IHwgbnVsbCA9IG51bGw7XG4vKiogV2hhdCB0aGUgc2Vzc2lvbiBvbiBzY3JlZW4gaXM6IGEgdm9pY2UgY2FsbCwgb3IgYSB0eXBlZCBjaGF0ICh0aGUgY29yZSdzIG1lZGl1bSBcInRleHRcIikuICovXG5sZXQgbWVkaXVtOiBcInZvaWNlXCIgfCBcInRleHRcIiA9IFwidm9pY2VcIjtcbi8qKiBBIGNoYXQncyBtb2RlbCBpcyB3cml0aW5nIGl0cyBhbnN3ZXIuICovXG5sZXQgdGhpbmtpbmcgPSBmYWxzZTtcbi8qKiBBIGNoYXQncyByZXF1ZXN0cyB0byB0aGUgdGV4dCBtb2RlbCB0aGF0IGFyZSB1bmRlciB3YXkuICovXG5jb25zdCByZXF1ZXN0cyA9IG5ldyBNYXA8bnVtYmVyLCBBYm9ydENvbnRyb2xsZXI+KCk7XG4vKiogVGhlIGxhc3Qgc2Vzc2lvbiB3aW5kaW5nIGRvd24gKGl0cyB0cmFjZSBzYXZlZCwgdGhlIGNvcmUncyBjYWxsIGRpc3Bvc2VkKTogdGhlIG5leHQgc3RhcnRzIGFmdGVyIGl0LiAqL1xubGV0IGVuZGluZzogUHJvbWlzZTx2b2lkPiA9IFByb21pc2UucmVzb2x2ZSgpO1xuXG4vLyBUaGUgY29udmVyc2F0aW9uLCBrZXB0IHNvIGEgbmV3IGNhbGwgY2FuIGNhcnJ5IG9uIGZyb20gaXQgKHRoZSBjb3JlJ3MgYGhpc3RvcnlgLCByZWNhcHBlZCB0byB0aGUgbW9kZWwpLlxuaW50ZXJmYWNlIENoYXRMaW5lIHsgcm9sZTogXCJ1c2VyXCIgfCBcImFzc2lzdGFudFwiOyBzcGVha2VyPzogc3RyaW5nOyB0ZXh0OiBzdHJpbmcgfVxuY29uc3QgSElTVE9SWSA9IFwidm9pY2UuaGlzdG9yeVwiO1xuY29uc3QgSElTVE9SWV9NQVhfQUdFID0gMTIgKiAzNjAwICogMTAwMDtcbmxldCBjaGF0OiBDaGF0TGluZVtdID0gW107XG4vKiogVGhlIGNvcmUncyBudW1iZXIgZm9yIHRoZSBsaW5lIHRoZSBsYXN0IHdvcmRzIHdlcmUgcmVtZW1iZXJlZCBvbiwgdW50aWwgc29tZXRoaW5nIGVsc2UgaXMuICovXG5sZXQgbGFzdExpbmU6IG51bWJlciB8IG51bGwgPSBudWxsO1xuXG5mdW5jdGlvbiByZW1lbWJlcihyb2xlOiBcInVzZXJcIiB8IFwiYXNzaXN0YW50XCIsIHRleHQ6IHN0cmluZywgc3BlYWtlcj86IHN0cmluZywgam9pbiA9IGZhbHNlKSB7XG4gIGNvbnN0IGxhc3QgPSBjaGF0LmF0KC0xKTtcbiAgaWYgKGpvaW4gJiYgbGFzdCAmJiBsYXN0LnJvbGUgPT09IHJvbGUgJiYgbGFzdC5zcGVha2VyID09PSBzcGVha2VyKSBsYXN0LnRleHQgKz0gdGV4dDtcbiAgZWxzZSBjaGF0LnB1c2goc3BlYWtlciA/IHsgcm9sZSwgc3BlYWtlciwgdGV4dCB9IDogeyByb2xlLCB0ZXh0IH0pO1xuICBpZiAoY2hhdC5sZW5ndGggPiAyMDApIGNoYXQuc3BsaWNlKDAsIGNoYXQubGVuZ3RoIC0gMjAwKTtcbiAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oSElTVE9SWSwgSlNPTi5zdHJpbmdpZnkoeyBhdDogRGF0ZS5ub3coKSwgY2hhdCB9KSk7XG59XG5cbmZ1bmN0aW9uIHNhdmVkSGlzdG9yeSgpOiBDaGF0TGluZVtdIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBzYXZlZCA9IEpTT04ucGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oSElTVE9SWSkgPz8gXCJudWxsXCIpO1xuICAgIHJldHVybiBzYXZlZCAmJiBEYXRlLm5vdygpIC0gc2F2ZWQuYXQgPCBISVNUT1JZX01BWF9BR0UgJiYgQXJyYXkuaXNBcnJheShzYXZlZC5jaGF0KSA/IHNhdmVkLmNoYXQgOiBbXTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG59XG5cbi8qKiBUd28tbm90ZSBjaGltZSwgUENNMTYgbW9ubyBhdCAyNCBrSHosIGJhc2U2NC4gKi9cbmZ1bmN0aW9uIHR3b05vdGVUb25lKGYxOiBudW1iZXIsIGYyOiBudW1iZXIsIG5vdGVTZWM6IG51bWJlciwgYW1wOiBudW1iZXIpOiBzdHJpbmcge1xuICBjb25zdCByYXRlID0gMjQwMDAsIG4gPSBNYXRoLnJvdW5kKHJhdGUgKiBub3RlU2VjICogMiksIGhhbGYgPSBNYXRoLnJvdW5kKHJhdGUgKiBub3RlU2VjKSwgb3V0ID0gbmV3IEludDE2QXJyYXkobik7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgbjsgaSsrKSB7XG4gICAgY29uc3QgZmlyc3QgPSBpIDwgaGFsZjtcbiAgICBjb25zdCB0ID0gaSAvIHJhdGUsIGYgPSBmaXJzdCA/IGYxIDogZjIsIGxvY2FsID0gZmlyc3QgPyB0IDogdCAtIG5vdGVTZWM7XG4gICAgY29uc3QgZW52ID0gTWF0aC5taW4oMSwgbG9jYWwgKiA2MCwgKG5vdGVTZWMgLSBsb2NhbCkgKiA2MCk7XG4gICAgb3V0W2ldID0gTWF0aC5yb3VuZChNYXRoLnNpbigyICogTWF0aC5QSSAqIGYgKiB0KSAqIE1hdGgubWF4KDAsIGVudikgKiBhbXApO1xuICB9XG4gIHJldHVybiBieXRlc1RvQmFzZTY0KG5ldyBVaW50OEFycmF5KG91dC5idWZmZXIpKTtcbn1cblxuLyoqIFR3byByaXNpbmcgbm90ZXM6IHNvbWV0aGluZyBvbiB0aGUgc2NyZWVuIG5lZWRzIHRoZSB1c2VyLiAqL1xuY29uc3QgQVBQUk9WQUxfVE9ORSA9IHR3b05vdGVUb25lKDY2MCwgODgwLCAwLjE2LCA2MDAwKTtcbi8qKiBDcmlzcCByaXNpbmcgY2hpbWU6IHRoZSB3YWtlIHdvcmQgZmlyZWQgKHN0YXJ0IHNpZ25hbCkuICovXG5jb25zdCBXQUtFX1RPTkUgPSB0d29Ob3RlVG9uZSg1ODcuMzMsIDg4MCwgMC4xMSwgNTUwMCk7XG4vKiogU29mdCBmYWxsaW5nIGNoaW1lOiB0aGUgYXR0ZW50aW9uIHdpbmRvdyBjbG9zZWQgYW5kIHRoZSBjYWxsIHdlbnQgZG9ybWFudCAoZW5kIHNpZ25hbCkuICovXG5jb25zdCBTTEVFUF9UT05FID0gdHdvTm90ZVRvbmUoNjU5LjI1LCA0OTMuODgsIDAuMTEsIDM0MDApO1xuXG4vLyBMYXRlbmN5OiB0aGUgbmV0d29yaydzIHJvdW5kIHRyaXAsIGFuZCBob3cgbG9uZyBhZnRlciB0aGUgdXNlciBzdG9wcyB0YWxraW5nIHRoZSByZXBseSBzdGFydHMuXG5jb25zdCBtZXRyaWNzID0geyBydHQ6IFtdIGFzIG51bWJlcltdLCByZXBseTogW10gYXMgbnVtYmVyW10sIGxhc3RWb2ljZTogMCwgbGFzdFBsYXk6IDAsIHJlcGxpZWQ6IHRydWUgfTtcblxuZnVuY3Rpb24gbWVkaWFuKHhzOiBudW1iZXJbXSk6IG51bWJlciB8IG51bGwge1xuICBpZiAoeHMubGVuZ3RoID09PSAwKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgcyA9IFsuLi54c10uc29ydCgoYSwgYikgPT4gYSAtIGIpO1xuICByZXR1cm4gc1tNYXRoLmZsb29yKHMubGVuZ3RoIC8gMildO1xufVxuXG5mdW5jdGlvbiBzaG93TWV0cmljcygpIHtcbiAgY29uc3QgcGFydHM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IHJ0dCA9IG1lZGlhbihtZXRyaWNzLnJ0dCk7XG4gIGlmIChydHQgIT0gbnVsbCkgcGFydHMucHVzaChgJHtNYXRoLnJvdW5kKHJ0dCAqIDEwMDApfSBtc2ApO1xuICBjb25zdCByZXBseSA9IG1lZGlhbihtZXRyaWNzLnJlcGx5KTtcbiAgaWYgKHJlcGx5ICE9IG51bGwpIHBhcnRzLnB1c2goYHJlcGx5ICR7bWV0cmljcy5yZXBseS5hdCgtMSkhLnRvRml4ZWQoMSl9cyAoJHtyZXBseS50b0ZpeGVkKDEpfXMgbWVkKWApO1xuICBjb25zdCBvdXQgPSBhdWRpby5vdXRwdXRMYXRlbmN5O1xuICBpZiAob3V0ICE9IG51bGwpIHBhcnRzLnB1c2goYGF1ZGlvICR7TWF0aC5yb3VuZChvdXQgKiAxMDAwKX0gbXNgKTtcbiAgbGV0IGJ1ZmZlcmVkID0gMDtcbiAgZm9yIChjb25zdCB3cyBvZiBzb2NrZXRzLnZhbHVlcygpKSBidWZmZXJlZCArPSB3cy5idWZmZXJlZEFtb3VudDtcbiAgaWYgKGJ1ZmZlcmVkID4gMzJfMDAwKSBwYXJ0cy5wdXNoKGB1cGxvYWQgKyR7KGJ1ZmZlcmVkIC8gMzJfMDAwKS50b0ZpeGVkKDEpfXNgKTtcbiAgJChcIm1ldHJpY3NcIikudGV4dENvbnRlbnQgPSBwYXJ0cy5qb2luKFwiIFx1MDBCNyBcIik7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHBpbmcoKSB7XG4gIGNvbnN0IHQgPSBub3coKTtcbiAgdHJ5IHtcbiAgICBhd2FpdCBmZXRjaChcIi9waW5nXCIsIHsgY2FjaGU6IFwibm8tc3RvcmVcIiB9KTtcbiAgICBtZXRyaWNzLnJ0dC5wdXNoKG5vdygpIC0gdCk7XG4gICAgaWYgKG1ldHJpY3MucnR0Lmxlbmd0aCA+IDEyKSBtZXRyaWNzLnJ0dC5zaGlmdCgpO1xuICB9IGNhdGNoIHt9XG4gIHNob3dNZXRyaWNzKCk7XG59XG5cbi8vIFRoZW1lICYgZGVuc2l0eS5cblxuZnVuY3Rpb24gYXBwbHlUaGVtZShjaG9pY2U6IHN0cmluZykge1xuICBjb25zdCByb290ID0gZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50O1xuICBpZiAoY2hvaWNlID09PSBcImRhcmtcIiB8fCBjaG9pY2UgPT09IFwibGlnaHRcIikgcm9vdC5kYXRhc2V0LnRoZW1lID0gY2hvaWNlO1xuICBlbHNlIGRlbGV0ZSByb290LmRhdGFzZXQudGhlbWU7XG4gIGNvbnN0IGRhcmsgPSBjaG9pY2UgPT09IFwiZGFya1wiIHx8IChjaG9pY2UgIT09IFwibGlnaHRcIiAmJiBtYXRjaE1lZGlhKFwiKHByZWZlcnMtY29sb3Itc2NoZW1lOiBkYXJrKVwiKS5tYXRjaGVzKTtcbiAgY29uc3QgbWV0YSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwidGhlbWUtY29sb3JcIik7XG4gIGlmIChtZXRhKSBtZXRhLnNldEF0dHJpYnV0ZShcImNvbnRlbnRcIiwgZGFyayA/IFwiIzBlMGYwZlwiIDogXCIjZjZmNWYwXCIpO1xuICBmb3IgKGNvbnN0IGJ0biBvZiBBcnJheS5mcm9tKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiI3RoZW1lLXBpY2tlciBidXR0b25cIikpKSB7XG4gICAgYnRuLmNsYXNzTGlzdC50b2dnbGUoXCJvblwiLCBidG4uZGF0YXNldC50aGVtZSA9PT0gKGNob2ljZSB8fCBcInN5c3RlbVwiKSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gYXBwbHlEZW5zaXR5KGNob2ljZTogc3RyaW5nIHwgbnVsbCkge1xuICBjb25zdCBkZW5zaXR5ID0gbm9ybWFsaXplRGVuc2l0eShjaG9pY2UpO1xuICBjb25zdCByb290ID0gZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50O1xuICBpZiAoZGVuc2l0eSA9PT0gXCJjb21mb3J0YWJsZVwiKSByb290LmRhdGFzZXQuZGVuc2l0eSA9IFwiY29tZm9ydGFibGVcIjtcbiAgZWxzZSBkZWxldGUgcm9vdC5kYXRhc2V0LmRlbnNpdHk7XG4gIGZvciAoY29uc3QgYnRuIG9mIEFycmF5LmZyb20oZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MQnV0dG9uRWxlbWVudD4oXCIjZGVuc2l0eS1waWNrZXIgYnV0dG9uXCIpKSkge1xuICAgIGJ0bi5jbGFzc0xpc3QudG9nZ2xlKFwib25cIiwgYnRuLmRhdGFzZXQuZGVuc2l0eSA9PT0gZGVuc2l0eSk7XG4gIH1cbiAgcmVxdWVzdEFuaW1hdGlvbkZyYW1lKCgpID0+IHVwZGF0ZUFsbFJlc3VsdENsYW1waW5nKCkpO1xufVxuXG4vLyBUaGUgc2NyZWVuLlxuXG5mdW5jdGlvbiBzZXRDYWxsQnV0dG9uKGxpdmU6IGJvb2xlYW4pIHtcbiAgY29uc3QgYnRuID0gJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJjYWxsXCIpO1xuICBidG4uY2xhc3NMaXN0LnRvZ2dsZShcImxpdmVcIiwgbGl2ZSk7XG4gIGNvbnN0IGxhYmVsID0gYnRuLnF1ZXJ5U2VsZWN0b3IoXCIuY2FsbC1sYWJlbFwiKTtcbiAgaWYgKGxhYmVsKSBsYWJlbC50ZXh0Q29udGVudCA9IGxpdmUgPyBcIkhhbmcgdXBcIiA6IFwiQ2FsbFwiO1xufVxuXG5mdW5jdGlvbiBzeW5jUmVzdW1lQnV0dG9ucyhzaG93OiBib29sZWFuKSB7XG4gICQoXCJyZXN1bWVcIikuaGlkZGVuID0gIXNob3c7XG4gICQoXCJoZXJvLXJlc3VtZVwiKS5oaWRkZW4gPSAhc2hvdztcbn1cblxuZnVuY3Rpb24gc3luY0NvbXBvc2VyKCkge1xuICBjb25zdCBpbnB1dCA9ICQ8SFRNTElucHV0RWxlbWVudD4oXCJ0ZXh0XCIpO1xuICBjb25zdCB0cmltbWVkID0gaW5wdXQudmFsdWUudHJpbSgpO1xuICAkKFwic2VuZGJ0blwiKS5jbGFzc0xpc3QudG9nZ2xlKFwicmVhZHlcIiwgdHJpbW1lZC5sZW5ndGggPiAwKTtcbiAgY29uc3QgcGFyc2VkID0gcGFyc2VQcmVmaXgodHJpbW1lZCk7XG4gICQoXCJtb2RlLXdyYXBcIikuZGF0YXNldC5tb2RlID0gcGFyc2VkLm1vZGUgPz8gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJtb2RlXCIpLnZhbHVlO1xufVxuXG5mdW5jdGlvbiBmb3JtYXRDbG9jayhzZWNvbmRzOiBudW1iZXIpOiBzdHJpbmcge1xuICBjb25zdCB0b3RhbCA9IE1hdGgubWF4KDAsIE1hdGguZmxvb3Ioc2Vjb25kcykpO1xuICBjb25zdCBoID0gTWF0aC5mbG9vcih0b3RhbCAvIDM2MDApO1xuICBjb25zdCBtID0gTWF0aC5mbG9vcigodG90YWwgJSAzNjAwKSAvIDYwKTtcbiAgY29uc3QgcyA9IHRvdGFsICUgNjA7XG4gIGNvbnN0IHBhZCA9IChuOiBudW1iZXIpID0+IFN0cmluZyhuKS5wYWRTdGFydCgyLCBcIjBcIik7XG4gIHJldHVybiBoID4gMCA/IGAke2h9OiR7cGFkKG0pfToke3BhZChzKX1gIDogYCR7cGFkKG0pfToke3BhZChzKX1gO1xufVxuXG5jb25zdCBWSVpfV0VJR0hUUyA9IFswLjQ4LCAwLjg2LCAxLjAsIDAuNzgsIDAuNDRdO1xuZnVuY3Rpb24gdXBkYXRlVmlzdWFsaXplcihtb2RlOiBzdHJpbmcsIGxldmVsOiBudW1iZXIpIHtcbiAgY29uc3Qgdml6ID0gJChcInZpelwiKTtcbiAgdml6LmRhdGFzZXQubW9kZSA9IG1vZGU7XG4gIGNvbnN0IGJhcnMgPSB2aXouY2hpbGRyZW47XG4gIGlmIChtb2RlID09PSBcImxpc3RlbmluZ1wiIHx8IG1vZGUgPT09IFwid29ya2luZ1wiKSB7XG4gICAgY29uc3QgZW5lcmd5ID0gTWF0aC5taW4oMSwgbGV2ZWwgKiAxNCk7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBiYXJzLmxlbmd0aDsgaSsrKSB7XG4gICAgICBjb25zdCBoID0gMC4yNCArIGVuZXJneSAqIFZJWl9XRUlHSFRTW2ldICogMC43NjtcbiAgICAgIChiYXJzW2ldIGFzIEhUTUxFbGVtZW50KS5zdHlsZS50cmFuc2Zvcm0gPSBgc2NhbGVZKCR7aC50b0ZpeGVkKDIpfSlgO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGJhcnMubGVuZ3RoOyBpKyspIChiYXJzW2ldIGFzIEhUTUxFbGVtZW50KS5zdHlsZS50cmFuc2Zvcm0gPSBcIlwiO1xuICB9XG59XG5cbi8qKiBBIHN5c3RlbSBub3RpZmljYXRpb24gd2hpbGUgdGhlIHBhZ2UgaXMgaGlkZGVuOiBhIHRhc2sgZmluaXNoZWQsIG9yIG9uZSBuZWVkcyB0aGUgdXNlci4gKi9cbmZ1bmN0aW9uIG5vdGlmeSh0aXRsZTogc3RyaW5nLCBib2R5OiBzdHJpbmcpIHtcbiAgaWYgKCFkb2N1bWVudC5oaWRkZW4gfHwgIShcIk5vdGlmaWNhdGlvblwiIGluIHdpbmRvdykgfHwgTm90aWZpY2F0aW9uLnBlcm1pc3Npb24gIT09IFwiZ3JhbnRlZFwiKSByZXR1cm47XG4gIHRyeSB7XG4gICAgY29uc3QgbiA9IG5ldyBOb3RpZmljYXRpb24odGl0bGUsIHsgYm9keTogYm9keS5zbGljZSgwLCAxODApLCBpY29uOiBcIi93ZWIvaWNvbnMvaWNvbi0xOTIucG5nXCIsIHRhZzogdGl0bGUgfSk7XG4gICAgbi5vbmNsaWNrID0gKCkgPT4geyB3aW5kb3cuZm9jdXMoKTsgbi5jbG9zZSgpOyB9O1xuICB9IGNhdGNoIHtcbiAgICAvLyBQaG9uZXMgd2FudCBub3RpZmljYXRpb25zIGZyb20gYSBzZXJ2aWNlIHdvcmtlcjsgdGhlIHBhZ2UgaGFzIG5vbmUuXG4gIH1cbn1cblxuZnVuY3Rpb24gdG9hc3QodGV4dDogc3RyaW5nKSB7XG4gIGNvbnN0IHQgPSAkKFwidG9hc3RcIik7XG4gIHQudGV4dENvbnRlbnQgPSB0ZXh0O1xuICB0LmNsYXNzTGlzdC5hZGQoXCJvblwiKTtcbiAgY2xlYXJUaW1lb3V0KCh0b2FzdCBhcyBhbnkpLnRpbWVyKTtcbiAgKHRvYXN0IGFzIGFueSkudGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHQuY2xhc3NMaXN0LnJlbW92ZShcIm9uXCIpLCAxODAwKTtcbn1cblxuZnVuY3Rpb24gbG9nKGtpbmQ6IHN0cmluZywgdGV4dDogc3RyaW5nLCBjbHMgPSBcIlwiKSB7XG4gIGNvbnN0IHBhbmUgPSAkKFwibG9nXCIpO1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gYHJvdyAke2Nsc31gO1xuICByb3cuaW5uZXJIVE1MID0gYDxzcGFuIGNsYXNzPVwidFwiPiR7KG5vdygpIC0gc3RhcnRlZEF0KS50b0ZpeGVkKDIpfTwvc3Bhbj48c3BhbiBjbGFzcz1cImtcIj4ke2tpbmR9PC9zcGFuPmA7XG4gIGNvbnN0IGJvZHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgYm9keS5jbGFzc05hbWUgPSBcImJcIjtcbiAgYm9keS50ZXh0Q29udGVudCA9IHRleHQ7XG4gIHJvdy5hcHBlbmQoYm9keSk7XG4gIGNvbnN0IHN0aWNrID0gcGFuZS5zY3JvbGxUb3AgKyBwYW5lLmNsaWVudEhlaWdodCA+PSBwYW5lLnNjcm9sbEhlaWdodCAtIDMwO1xuICBwYW5lLmFwcGVuZChyb3cpO1xuICB3aGlsZSAocGFuZS5jaGlsZEVsZW1lbnRDb3VudCA+IDMwMDApIHBhbmUuZmlyc3RFbGVtZW50Q2hpbGQhLnJlbW92ZSgpO1xuICBpZiAoc3RpY2spIHBhbmUuc2Nyb2xsVG9wID0gcGFuZS5zY3JvbGxIZWlnaHQ7XG59XG5cbi8qKiBBIGZyYW1lIGZyb20gb3IgdG8gR2VtaW5pLCB3aXRoIGF1ZGlvIGN1dCBvdXQsIHNob3J0IGVub3VnaCB0byByZWFkLiAqL1xuZnVuY3Rpb24gYnJpZWYoZGF0YTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGRhdGEucmVwbGFjZSgvXCJkYXRhXCI6XCJbQS1aYS16MC05Ky89XXs0MCx9XCIvZywgKG0pID0+IGBcImRhdGFcIjpcIlx1MjAyNiR7TWF0aC5yb3VuZCgoKG0ubGVuZ3RoIC0gOSkgKiAzKSAvIDQpfSBieXRlc1wiYCkuc2xpY2UoMCwgNjAwKTtcbn1cblxuZnVuY3Rpb24gZXNjYXBlSHRtbCh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdGV4dC5yZXBsYWNlKC9bJjw+XCInXS9nLCAoYykgPT4gKHsgXCImXCI6IFwiJmFtcDtcIiwgXCI8XCI6IFwiJmx0O1wiLCBcIj5cIjogXCImZ3Q7XCIsICdcIic6IFwiJnF1b3Q7XCIsIFwiJ1wiOiBcIiYjMzk7XCIgfSlbY10hKTtcbn1cblxuLyoqIEEgbGl0dGxlIE1hcmtkb3duLCBzYWZlbHk6IGNvZGUsIGJvbGQsIGxpbmtzLCBsaXN0cyBhbmQgaGVhZGluZ3MsIHRoZSByZXN0IGFzIHRleHQuICovXG5mdW5jdGlvbiBtYXJrZG93bih0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBibG9ja3MgPSBlc2NhcGVIdG1sKHRleHQudHJpbSgpKS5zcGxpdCgvYGBgKD86XFx3Kyk/XFxuPy8pO1xuICByZXR1cm4gYmxvY2tzLm1hcCgoYmxvY2ssIGkpID0+IHtcbiAgICBpZiAoaSAlIDIgPT09IDEpIHJldHVybiBgPHByZT48Y29kZT4ke2Jsb2NrLnJlcGxhY2UoL1xcbiQvLCBcIlwiKX08L2NvZGU+PC9wcmU+YDtcbiAgICBjb25zdCBpbmxpbmUgPSAoczogc3RyaW5nKSA9PiBzXG4gICAgICAucmVwbGFjZSgvYChbXmBcXG5dKylgL2csIFwiPGNvZGU+JDE8L2NvZGU+XCIpXG4gICAgICAucmVwbGFjZSgvXFwqXFwqKFteKlxcbl0rKVxcKlxcKi9nLCBcIjxiPiQxPC9iPlwiKVxuICAgICAgLnJlcGxhY2UoL1xcWyhbXlxcXVxcbl0rKVxcXVxcKChodHRwcz86XFwvXFwvW15cXHMpXSspXFwpL2csICc8YSBocmVmPVwiJDJcIiB0YXJnZXQ9XCJfYmxhbmtcIiByZWw9XCJub29wZW5lclwiPiQxPC9hPicpXG4gICAgICAucmVwbGFjZSgvKF58W1xccyhdKShodHRwcz86XFwvXFwvW15cXHM8KV0rKS9nLCAnJDE8YSBocmVmPVwiJDJcIiB0YXJnZXQ9XCJfYmxhbmtcIiByZWw9XCJub29wZW5lclwiPiQyPC9hPicpO1xuICAgIGxldCBodG1sID0gXCJcIjtcbiAgICBsZXQgbGlzdDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gICAgZm9yIChjb25zdCByYXcgb2YgYmxvY2suc3BsaXQoXCJcXG5cIikpIHtcbiAgICAgIGNvbnN0IGl0ZW0gPSByYXcubWF0Y2goL15cXHMqKD86Wy0qXHUyMDIyXXwoXFxkKylbLildKVxccysoLiopJC8pO1xuICAgICAgaWYgKGl0ZW0pIHtcbiAgICAgICAgY29uc3Qga2luZCA9IGl0ZW1bMV0gPyBcIm9sXCIgOiBcInVsXCI7XG4gICAgICAgIGlmIChsaXN0ICE9PSBraW5kKSB7IGlmIChsaXN0KSBodG1sICs9IGA8LyR7bGlzdH0+YDsgaHRtbCArPSBgPCR7a2luZH0+YDsgbGlzdCA9IGtpbmQ7IH1cbiAgICAgICAgaHRtbCArPSBgPGxpPiR7aW5saW5lKGl0ZW1bMl0pfTwvbGk+YDtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBpZiAobGlzdCkgeyBodG1sICs9IGA8LyR7bGlzdH0+YDsgbGlzdCA9IG51bGw7IH1cbiAgICAgIGNvbnN0IGhlYWRpbmcgPSByYXcubWF0Y2goL14jezEsNn1cXHMrKC4qKSQvKTtcbiAgICAgIGh0bWwgKz0gaGVhZGluZyA/IGA8ZGl2IGNsYXNzPVwibWQtaFwiPiR7aW5saW5lKGhlYWRpbmdbMV0pfTwvZGl2PmAgOiByYXcudHJpbSgpID09PSBcIlwiID8gXCI8YnI+XCIgOiBgJHtpbmxpbmUocmF3KX08YnI+YDtcbiAgICB9XG4gICAgaWYgKGxpc3QpIGh0bWwgKz0gYDwvJHtsaXN0fT5gO1xuICAgIHJldHVybiBodG1sLnJlcGxhY2UoLyg8YnI+KSskLywgXCJcIik7XG4gIH0pLmpvaW4oXCJcIik7XG59XG5cbmNvbnN0IHRyYW5zY3JpcHRTY3JvbGwgPSBuZXcgQXV0b1Njcm9sbGVyKCQoXCJ0cmFuc2NyaXB0XCIpLCB7XG4gIG9uSnVtcENoYW5nZTogKHNob3cpID0+IHsgJChcImp1bXBib3R0b21cIikuaGlkZGVuID0gIXNob3c7IH0sXG4gIGlzRW1wdHk6ICgpID0+ICEkKFwiZW1wdHlcIikuaGlkZGVuLFxufSk7XG5cbmZ1bmN0aW9uIHNjcm9sbERvd24oZm9yY2UgPSBmYWxzZSkge1xuICB0cmFuc2NyaXB0U2Nyb2xsLm9uQ29udGVudChmb3JjZSk7XG59XG5cbi8qKiBUaGUgY29yZSdzIG51bWJlciBmb3IgdGhlIGxpbmUgdGhlIGxhc3Qgcm93IHNob3dzLCB1bnRpbCBhbm90aGVyIHJvdyBmb2xsb3dzIGl0LiAqL1xubGV0IG9wZW5MaW5lOiBudW1iZXIgfCBudWxsID0gbnVsbDtcblxuLyoqIFdvcmRzIGdvIG9uIHRoZSByb3cgdGhlIGNvcmUgc2F5cyB0aGV5IGJlbG9uZyB0bzogaXQgc3RhcnRzIGEgbmV3IGxpbmUgZm9yIGVhY2ggdHVybiwgaG93ZXZlciBsb25nIHRoZSBnYXAuICovXG5mdW5jdGlvbiB0cmFuc2NyaXB0KHJvbGU6IFwidXNlclwiIHwgXCJhc3Npc3RhbnRcIiwgdGV4dDogc3RyaW5nLCBsaW5lOiBudW1iZXIpIHtcbiAgJChcImVtcHR5XCIpLmhpZGRlbiA9IHRydWU7XG4gIGNvbnN0IHBhbmUgPSAkKFwidHJhbnNjcmlwdFwiKTtcbiAgY29uc3QgbGFzdCA9IHBhbmUubGFzdEVsZW1lbnRDaGlsZCBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gIGlmIChvcGVuTGluZSA9PT0gbGluZSAmJiBsYXN0ICYmIGxhc3QuZGF0YXNldC5yb2xlID09PSByb2xlKSBsYXN0LnF1ZXJ5U2VsZWN0b3IoXCIudGV4dFwiKSEudGV4dENvbnRlbnQgKz0gdGV4dDtcbiAgZWxzZSB7XG4gICAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICByb3cuY2xhc3NOYW1lID0gYGxpbmUgJHtyb2xlfWA7XG4gICAgcm93LmRhdGFzZXQucm9sZSA9IHJvbGU7XG4gICAgcm93LmlubmVySFRNTCA9IGA8c3BhbiBjbGFzcz1cIndob1wiPiR7cm9sZSA9PT0gXCJ1c2VyXCIgPyBcIllvdVwiIDogXCJHZW1pbmlcIn08L3NwYW4+PHNwYW4gY2xhc3M9XCJ0ZXh0XCI+PC9zcGFuPmA7XG4gICAgcm93LnF1ZXJ5U2VsZWN0b3IoXCIudGV4dFwiKSEudGV4dENvbnRlbnQgPSB0ZXh0LnRyaW1TdGFydCgpO1xuICAgIHBhbmUuYXBwZW5kKHJvdyk7XG4gICAgb3BlbkxpbmUgPSBsaW5lO1xuICB9XG4gIHNjcm9sbERvd24oKTtcbn1cblxuLyoqXG4gKiBUaGUgd29yZHMgdGhlIHVzZXIgaXMgc2F5aW5nLCBiZWZvcmUgdGhlIG1vZGVsIGhhcyB0cmFuc2NyaWJlZCB0aGVtOiBhIGZhaW50IHJvdyB0aGF0IHN0YXlzIGxhc3RcbiAqIG9uIHNjcmVlbiAoaXRzIENTUyBgb3JkZXJgKSBhbmQgZmlyc3QgaW4gdGhlIHBhbmUsIHNvIHRoZSBsaW5lcyBhZnRlciBpdCBqb2luIHVwIGFzIGJlZm9yZS5cbiAqL1xuZnVuY3Rpb24gY2FwdGlvbih0ZXh0OiBzdHJpbmcgfCBudWxsKSB7XG4gIGNvbnN0IHBhbmUgPSAkKFwidHJhbnNjcmlwdFwiKTtcbiAgbGV0IHJvdyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwiY2FwdGlvblwiKTtcbiAgaWYgKHRleHQgPT0gbnVsbCkgeyByb3c/LnJlbW92ZSgpOyBzY3JvbGxEb3duKCk7IHJldHVybjsgfVxuICAkKFwiZW1wdHlcIikuaGlkZGVuID0gdHJ1ZTtcbiAgaWYgKCFyb3cpIHtcbiAgICByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIHJvdy5pZCA9IFwiY2FwdGlvblwiO1xuICAgIHJvdy5jbGFzc05hbWUgPSBcImxpbmUgdXNlciBjYXB0aW9uXCI7XG4gICAgcm93LmlubmVySFRNTCA9IGA8c3BhbiBjbGFzcz1cIndob1wiPllvdTwvc3Bhbj48c3BhbiBjbGFzcz1cInRleHRcIj48L3NwYW4+YDtcbiAgICBwYW5lLnByZXBlbmQocm93KTtcbiAgfVxuICByb3cucXVlcnlTZWxlY3RvcihcIi50ZXh0XCIpIS50ZXh0Q29udGVudCA9IHRleHQ7XG4gIHNjcm9sbERvd24oKTtcbn1cblxuZnVuY3Rpb24gbm90ZSh0ZXh0OiBzdHJpbmcpIHtcbiAgJChcImVtcHR5XCIpLmhpZGRlbiA9IHRydWU7XG4gIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvdy5jbGFzc05hbWUgPSBcImxpbmUgbm90ZVwiO1xuICByb3cudGV4dENvbnRlbnQgPSB0ZXh0O1xuICAkKFwidHJhbnNjcmlwdFwiKS5hcHBlbmQocm93KTtcbiAgb3BlbkxpbmUgPSBudWxsO1xuICBzY3JvbGxEb3duKCk7XG59XG5cbi8vIEFnZW50IGhhbmRvZmYgcmVzdWx0czogY29tcGFjdCAxLWxpbmUgcmVmZXJlbmNlIGluIHRoZSB2b2ljZSBzdHJlYW0gKyBmdWxsIGNvbGxhcHNpYmxlIGNhcmQgaW4gdGhlIHJpZ2h0IHBhbmUuXG5cbmZ1bmN0aW9uIHJlc3VsdENsYW1wUHgoZWw6IEhUTUxFbGVtZW50KTogbnVtYmVyIHtcbiAgY29uc3QgcmF3ID0gZ2V0Q29tcHV0ZWRTdHlsZShlbCkuZ2V0UHJvcGVydHlWYWx1ZShcIi0tcmVzLWNsYW1wLW1heFwiKS50cmltKCk7XG4gIGNvbnN0IG4gPSBOdW1iZXIucGFyc2VGbG9hdChyYXcpO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pICYmIG4gPiAwID8gbiA6IDY0O1xufVxuXG5mdW5jdGlvbiBzeW5jRXhwYW5kQWxsQnV0dG9uKCkge1xuICBjb25zdCBjbGFtcGVkID0gWy4uLnJlc3VsdHMudmFsdWVzKCldLmZpbHRlcigocikgPT4gci5jYXJkLmNsYXNzTGlzdC5jb250YWlucyhcImNsYW1wZWRcIikpO1xuICBjb25zdCBidG4gPSAkPEhUTUxCdXR0b25FbGVtZW50PihcInRvZ2dsZS1hbGwtcmVzdWx0c1wiKTtcbiAgYnRuLmhpZGRlbiA9IGNsYW1wZWQubGVuZ3RoID09PSAwO1xuICBpZiAoY2xhbXBlZC5sZW5ndGggPT09IDApIHJldHVybjtcbiAgY29uc3QgYW55Q29sbGFwc2VkID0gY2xhbXBlZC5zb21lKChyKSA9PiAhci5jYXJkLmNsYXNzTGlzdC5jb250YWlucyhcIm9wZW5cIikpO1xuICBidG4udGV4dENvbnRlbnQgPSBhbnlDb2xsYXBzZWQgPyBcIkV4cGFuZCBhbGxcIiA6IFwiQ29sbGFwc2UgYWxsXCI7XG59XG5cbmZ1bmN0aW9uIHNldFJlc3VsdE9wZW4oZW50cnk6IFJlc3VsdEVudHJ5LCBvcGVuOiBib29sZWFuKSB7XG4gIGNvbnN0IGNsYW1wZWQgPSBlbnRyeS5jYXJkLmNsYXNzTGlzdC5jb250YWlucyhcImNsYW1wZWRcIik7XG4gIGNvbnN0IG5leHQgPSBjbGFtcGVkICYmIG9wZW47XG4gIGVudHJ5LmNhcmQuY2xhc3NMaXN0LnRvZ2dsZShcIm9wZW5cIiwgbmV4dCk7XG4gIGVudHJ5LmhlYWQuc2V0QXR0cmlidXRlKFwiYXJpYS1leHBhbmRlZFwiLCBTdHJpbmcoIWNsYW1wZWQgfHwgbmV4dCkpO1xuICBlbnRyeS5tb3JlQnRuLnRleHRDb250ZW50ID0gbmV4dCA/IFwiU2hvdyBsZXNzXCIgOiBcIlNob3cgbW9yZVwiO1xuICBzeW5jRXhwYW5kQWxsQnV0dG9uKCk7XG59XG5cbmZ1bmN0aW9uIHVwZGF0ZVJlc3VsdENsYW1waW5nKGVudHJ5OiBSZXN1bHRFbnRyeSkge1xuICBpZiAoZW50cnkuYm9keS5vZmZzZXRQYXJlbnQgPT09IG51bGwpIHJldHVybjtcbiAgLy8gVW5jbGFtcGVkIGNhcmRzIGhhdmUgbm8gbWF4LWhlaWdodCwgc28gc2Nyb2xsSGVpZ2h0IGlzIGFsd2F5cyB0aGUgZnVsbCBuYXR1cmFsIGhlaWdodC5cbiAgY29uc3Qgb3ZlcmZsb3dzID0gZW50cnkuYm9keS5zY3JvbGxIZWlnaHQgPiByZXN1bHRDbGFtcFB4KGVudHJ5LmNhcmQpICsgNDtcbiAgZW50cnkuY2FyZC5jbGFzc0xpc3QudG9nZ2xlKFwiY2xhbXBlZFwiLCBvdmVyZmxvd3MpO1xuICBpZiAoIW92ZXJmbG93cykgZW50cnkuY2FyZC5jbGFzc0xpc3QucmVtb3ZlKFwib3BlblwiKTtcbiAgZW50cnkubW9yZUJ0bi5oaWRkZW4gPSAhb3ZlcmZsb3dzO1xuICBjb25zdCBpc09wZW4gPSBlbnRyeS5jYXJkLmNsYXNzTGlzdC5jb250YWlucyhcIm9wZW5cIik7XG4gIGVudHJ5Lm1vcmVCdG4udGV4dENvbnRlbnQgPSBpc09wZW4gPyBcIlNob3cgbGVzc1wiIDogXCJTaG93IG1vcmVcIjtcbiAgZW50cnkuaGVhZC5zZXRBdHRyaWJ1dGUoXCJhcmlhLWV4cGFuZGVkXCIsIFN0cmluZyghb3ZlcmZsb3dzIHx8IGlzT3BlbikpO1xufVxuXG5mdW5jdGlvbiB1cGRhdGVBbGxSZXN1bHRDbGFtcGluZygpIHtcbiAgZm9yIChjb25zdCBlbnRyeSBvZiByZXN1bHRzLnZhbHVlcygpKSB1cGRhdGVSZXN1bHRDbGFtcGluZyhlbnRyeSk7XG4gIHN5bmNFeHBhbmRBbGxCdXR0b24oKTtcbn1cblxuZnVuY3Rpb24gc3luY1Jlc3VsdEZvbGxvd1VwQnV0dG9ucygpIHtcbiAgZm9yIChjb25zdCBlbnRyeSBvZiByZXN1bHRzLnZhbHVlcygpKSB7XG4gICAgaWYgKCFlbnRyeS5mb2xsb3dCdG4pIGNvbnRpbnVlO1xuICAgIGNvbnN0IGNhbkZvbGxvdyA9IGNhbkZvbGxvd1VwUmVzdWx0KGVudHJ5LnNlc3Npb25JZCwgYWN0aXZlU2Vzc2lvbiwgQm9vbGVhbihlbnRyeS50YXNrSWQgJiYgdGFza3MuaGFzKGVudHJ5LnRhc2tJZCkpKTtcbiAgICBlbnRyeS5mb2xsb3dCdG4uaGlkZGVuID0gIWNhbkZvbGxvdztcbiAgICBpZiAoIWNhbkZvbGxvdykgZW50cnkuY2FyZC5xdWVyeVNlbGVjdG9yKFwiZm9ybVwiKT8ucmVtb3ZlKCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gY2xlYXJVbnJlYWRJZlJlc3VsdHNWaXNpYmxlKCkge1xuICBpZiAodW5yZWFkTW9iaWxlUmVzdWx0cyA9PT0gMCkgcmV0dXJuO1xuICBjb25zdCBkcmF3ZXJPcGVuID0gZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QuY29udGFpbnMoXCJ0YXNrcy1vcGVuXCIpO1xuICBpZiAoc2hvdWxkQ2xlYXJVbnJlYWRSZXN1bHRzKG1vYmlsZUxheW91dC5tYXRjaGVzLCBkcmF3ZXJPcGVuLCBzaWRlRmlsdGVyKSkge1xuICAgIHVucmVhZE1vYmlsZVJlc3VsdHMgPSAwO1xuICAgIHVwZGF0ZVRhc2tDaHJvbWUoKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBmb2N1c1Jlc3VsdChpZDogc3RyaW5nKSB7XG4gIGNvbnN0IGVudHJ5ID0gcmVzdWx0cy5nZXQoaWQpO1xuICBpZiAoIWVudHJ5KSByZXR1cm47XG4gIGlmIChzaWRlRmlsdGVyID09PSBcImFjdGl2ZVwiKSBzZXRTaWRlRmlsdGVyKFwiYWxsXCIpO1xuICBpZiAobW9iaWxlTGF5b3V0Lm1hdGNoZXMpIHNldFRhc2tzT3Blbih0cnVlKTtcbiAgcmVxdWVzdEFuaW1hdGlvbkZyYW1lKCgpID0+IHtcbiAgICB1cGRhdGVSZXN1bHRDbGFtcGluZyhlbnRyeSk7XG4gICAgaWYgKGVudHJ5LmNhcmQuY2xhc3NMaXN0LmNvbnRhaW5zKFwiY2xhbXBlZFwiKSkgc2V0UmVzdWx0T3BlbihlbnRyeSwgdHJ1ZSk7XG4gICAgZm9yIChjb25zdCByIG9mIHJlc3VsdHMudmFsdWVzKCkpIHIuY2FyZC5jbGFzc0xpc3QucmVtb3ZlKFwiZmxhc2hcIik7XG4gICAgdm9pZCBlbnRyeS5jYXJkLm9mZnNldFdpZHRoO1xuICAgIGVudHJ5LmNhcmQuY2xhc3NMaXN0LmFkZChcImZsYXNoXCIpO1xuICAgIGNsZWFyVGltZW91dChmbGFzaFRpbWVyKTtcbiAgICBmbGFzaFRpbWVyID0gd2luZG93LnNldFRpbWVvdXQoKCkgPT4gZW50cnkuY2FyZC5jbGFzc0xpc3QucmVtb3ZlKFwiZmxhc2hcIiksIDE0MDApO1xuICAgIGVudHJ5LmNhcmQuc2Nyb2xsSW50b1ZpZXcoeyBiZWhhdmlvcjogXCJzbW9vdGhcIiwgYmxvY2s6IFwibmVhcmVzdFwiIH0pO1xuICB9KTtcbn1cblxuZnVuY3Rpb24gcmVzdWx0KGFnZW50OiBzdHJpbmcsIGxhYmVsOiBzdHJpbmcsIHRleHQ6IHN0cmluZywgZmFpbGVkID0gZmFsc2UsIHRhc2tJZD86IHN0cmluZywgc2Vzc2lvbklkID0gYWN0aXZlU2Vzc2lvbik6IHN0cmluZyB7XG4gICQoXCJlbXB0eVwiKS5oaWRkZW4gPSB0cnVlO1xuICBjb25zdCBpZCA9IGByZXMtJHsrK25leHRSZXN1bHRTZXF9YDtcbiAgY29uc3Qgd2hvID0gYWdlbnQgPT09IFwidDNcIiA/IFwiVDNcIiA6IFwiSGVybWVzXCI7XG4gIGNvbnN0IGFnZW50Q2xzID0gYWdlbnQgPT09IFwidDNcIiA/IFwidDNcIiA6IFwiXCI7XG4gIGNvbnN0IHNuaXBwZXQgPSBwbGFpblByZXZpZXcodGV4dCwgMTYwKSB8fCBcIihlbXB0eSByZXNwb25zZSlcIjtcblxuICAvLyAxLiBDb21wYWN0IGlubGluZSBoYW5kb2ZmIG1hcmtlciBpbiB0aGUgdm9pY2UgdHJhbnNjcmlwdCBzbyBjaHJvbm9sb2dpY2FsIGNvbnRleHQgc3RheXMgaW50YWN0XG4gIC8vIHdpdGhvdXQgbXVsdGktcGFyYWdyYXBoIHJlc3BvbnNlcyBwdXNoaW5nIHZvaWNlIHR1cm5zIG9mZiBzY3JlZW4uXG4gIGNvbnN0IHJlZlJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIHJlZlJvdy50eXBlID0gXCJidXR0b25cIjtcbiAgcmVmUm93LmNsYXNzTmFtZSA9IGBsaW5lIGhhbmRvZmYgJHthZ2VudENsc30gJHtmYWlsZWQgPyBcImZhaWxlZFwiIDogXCJcIn1gLnRyaW0oKTtcbiAgcmVmUm93LmRhdGFzZXQucmVzdWx0SWQgPSBpZDtcbiAgcmVmUm93LmlubmVySFRNTCA9XG4gICAgYDxzcGFuIGNsYXNzPVwiYmFkZ2UgJHthZ2VudENsc31cIj4ke3dob308L3NwYW4+YCArXG4gICAgYDxzcGFuIGNsYXNzPVwiaGFuZG9mZi1sYWJlbFwiPiR7ZXNjYXBlSHRtbChsYWJlbCl9PC9zcGFuPmAgK1xuICAgIGA8c3BhbiBjbGFzcz1cImhhbmRvZmYtc25pcHBldFwiPiR7ZXNjYXBlSHRtbChzbmlwcGV0KX08L3NwYW4+YCArXG4gICAgYDxzcGFuIGNsYXNzPVwiaGFuZG9mZi1jdWVcIj4ke2ZhaWxlZCA/IFwiRmFpbGVkXCIgOiBcIk9wZW4gXHUyMTk3XCJ9PC9zcGFuPmA7XG4gIHJlZlJvdy5vbmNsaWNrID0gKCkgPT4gZm9jdXNSZXN1bHQoaWQpO1xuICAkKFwidHJhbnNjcmlwdFwiKS5hcHBlbmQocmVmUm93KTtcbiAgb3BlbkxpbmUgPSBudWxsO1xuICBzY3JvbGxEb3duKCk7XG5cbiAgLy8gMi4gVHJ1bmNhdGVkLCBleHBhbmRhYmxlIHJlc3VsdCBjYXJkIGluIHRoZSByaWdodC1oYW5kIEFnZW50IFdvcmtzcGFjZSAobmV3ZXN0IGZpcnN0KS5cbiAgY29uc3QgY2FyZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJhcnRpY2xlXCIpO1xuICBjYXJkLmNsYXNzTmFtZSA9IGByZXMtY2FyZCAke2FnZW50Q2xzfSAke2ZhaWxlZCA/IFwiZmFpbGVkXCIgOiBcIlwifWAudHJpbSgpO1xuICBjYXJkLmRhdGFzZXQucmVzdWx0SWQgPSBpZDtcblxuICBjb25zdCBoZWFkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgaGVhZC50eXBlID0gXCJidXR0b25cIjtcbiAgaGVhZC5jbGFzc05hbWUgPSBcInJlcy1oZWFkXCI7XG4gIGhlYWQuc2V0QXR0cmlidXRlKFwiYXJpYS1leHBhbmRlZFwiLCBcInRydWVcIik7XG4gIGhlYWQuaW5uZXJIVE1MID1cbiAgICBgPHNwYW4gY2xhc3M9XCJiYWRnZSAke2FnZW50Q2xzfVwiPiR7d2hvfTwvc3Bhbj5gICtcbiAgICBgPHNwYW4gY2xhc3M9XCJyZXMtbGFiZWxcIiB0aXRsZT1cIiR7ZXNjYXBlSHRtbChsYWJlbCl9XCI+JHtlc2NhcGVIdG1sKGxhYmVsKX08L3NwYW4+YCArXG4gICAgKGZhaWxlZCA/IGA8c3BhbiBjbGFzcz1cInJlcy1waWxsXCI+RmFpbGVkPC9zcGFuPmAgOiBcIlwiKSArXG4gICAgYDxzcGFuIGNsYXNzPVwicmVzLXRpbWVcIj4ke2Zvcm1hdFNob3J0VGltZShuZXcgRGF0ZSgpKX08L3NwYW4+YCArXG4gICAgYDxzcGFuIGNsYXNzPVwicmVzLWNoZXZcIiBhcmlhLWhpZGRlbj1cInRydWVcIj48L3NwYW4+YDtcblxuICBjb25zdCBib2R5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYm9keS5jbGFzc05hbWUgPSBcInJlcy1ib2R5XCI7XG4gIGJvZHkuaW5uZXJIVE1MID0gbWFya2Rvd24odGV4dCk7XG5cbiAgY29uc3QgZm9vdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGZvb3QuY2xhc3NOYW1lID0gXCJyZXMtZm9vdFwiO1xuXG4gIGNvbnN0IG1vcmVCdG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBtb3JlQnRuLnR5cGUgPSBcImJ1dHRvblwiO1xuICBtb3JlQnRuLmNsYXNzTmFtZSA9IFwicmVzLWFjdCBwcmltYXJ5XCI7XG4gIG1vcmVCdG4udGV4dENvbnRlbnQgPSBcIlNob3cgbW9yZVwiO1xuICBtb3JlQnRuLmhpZGRlbiA9IHRydWU7XG5cbiAgY29uc3QgY29weUJ0biA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIGNvcHlCdG4udHlwZSA9IFwiYnV0dG9uXCI7XG4gIGNvcHlCdG4uY2xhc3NOYW1lID0gXCJyZXMtYWN0XCI7XG4gIGNvcHlCdG4udGV4dENvbnRlbnQgPSBcIkNvcHlcIjtcbiAgY29weUJ0bi5vbmNsaWNrID0gKCkgPT4ge1xuICAgIHZvaWQgbmF2aWdhdG9yLmNsaXBib2FyZD8ud3JpdGVUZXh0KHRleHQpO1xuICAgIHRvYXN0KFwiUmVzdWx0IGNvcGllZFwiKTtcbiAgfTtcblxuICBmb290LmFwcGVuZChtb3JlQnRuLCBjb3B5QnRuKTtcblxuICBsZXQgZm9sbG93QnRuOiBIVE1MQnV0dG9uRWxlbWVudCB8IHVuZGVmaW5lZDtcbiAgaWYgKHRhc2tJZCkge1xuICAgIGZvbGxvd0J0biA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gICAgZm9sbG93QnRuLnR5cGUgPSBcImJ1dHRvblwiO1xuICAgIGZvbGxvd0J0bi5jbGFzc05hbWUgPSBcInJlcy1hY3RcIjtcbiAgICBmb2xsb3dCdG4udGV4dENvbnRlbnQgPSBcIkZvbGxvdyB1cFwiO1xuICAgIGZvbGxvd0J0bi5vbmNsaWNrID0gKCkgPT4ge1xuICAgICAgaWYgKCFjYW5Gb2xsb3dVcFJlc3VsdChzZXNzaW9uSWQsIGFjdGl2ZVNlc3Npb24sIHRhc2tzLmhhcyh0YXNrSWQpKSkge1xuICAgICAgICBzeW5jUmVzdWx0Rm9sbG93VXBCdXR0b25zKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHZpZXcgPSB0YXNrcy5nZXQodGFza0lkKTtcbiAgICAgIGlmICh2aWV3KSBmb2xsb3dVcEZvcm0oY2FyZCwgdmlldy5jLCBzZXNzaW9uSWQpO1xuICAgIH07XG4gICAgZm9vdC5hcHBlbmQoZm9sbG93QnRuKTtcbiAgfVxuXG4gIGNhcmQuYXBwZW5kKGhlYWQsIGJvZHksIGZvb3QpO1xuXG4gIGNvbnN0IGVudHJ5OiBSZXN1bHRFbnRyeSA9IHsgaWQsIGFnZW50LCBsYWJlbCwgdGV4dCwgZmFpbGVkLCB0YXNrSWQsIHNlc3Npb25JZCwgY2FyZCwgaGVhZCwgYm9keSwgbW9yZUJ0biwgZm9sbG93QnRuLCByZWZSb3cgfTtcbiAgY29uc3QgdG9nZ2xlID0gKCkgPT4ge1xuICAgIGlmICghZW50cnkuY2FyZC5jbGFzc0xpc3QuY29udGFpbnMoXCJjbGFtcGVkXCIpKSByZXR1cm47XG4gICAgc2V0UmVzdWx0T3BlbihlbnRyeSwgIWVudHJ5LmNhcmQuY2xhc3NMaXN0LmNvbnRhaW5zKFwib3BlblwiKSk7XG4gIH07XG4gIGhlYWQub25jbGljayA9IHRvZ2dsZTtcbiAgbW9yZUJ0bi5vbmNsaWNrID0gdG9nZ2xlO1xuXG4gIHJlc3VsdHMuc2V0KGlkLCBlbnRyeSk7XG4gICQoXCJyZXN1bHRzXCIpLnByZXBlbmQoY2FyZCk7XG4gIGNvbnN0IGRyYXdlck9wZW4gPSBkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5jb250YWlucyhcInRhc2tzLW9wZW5cIik7XG4gIGlmICghc2hvdWxkQ2xlYXJVbnJlYWRSZXN1bHRzKG1vYmlsZUxheW91dC5tYXRjaGVzLCBkcmF3ZXJPcGVuLCBzaWRlRmlsdGVyKSkgdW5yZWFkTW9iaWxlUmVzdWx0cysrO1xuXG4gIHN5bmNTaWRlTGF5b3V0KCk7XG4gIHVwZGF0ZVRhc2tDaHJvbWUoKTtcbiAgcmVxdWVzdEFuaW1hdGlvbkZyYW1lKCgpID0+IHtcbiAgICB1cGRhdGVSZXN1bHRDbGFtcGluZyhlbnRyeSk7XG4gICAgc3luY0V4cGFuZEFsbEJ1dHRvbigpO1xuICB9KTtcbiAgcmV0dXJuIGlkO1xufVxuXG5mdW5jdGlvbiBlbGFwc2VkKHNlY29uZHM6IG51bWJlcik6IHN0cmluZyB7XG4gIGlmIChzZWNvbmRzIDwgNjApIHJldHVybiBgJHtNYXRoLmZsb29yKHNlY29uZHMpfXNgO1xuICBjb25zdCBtID0gTWF0aC5mbG9vcihzZWNvbmRzIC8gNjApO1xuICByZXR1cm4gbSA8IDYwID8gYCR7bX1tICR7TWF0aC5mbG9vcihzZWNvbmRzICUgNjApfXNgIDogYCR7TWF0aC5mbG9vcihtIC8gNjApfWggJHttICUgNjB9bWA7XG59XG5cbi8qKiBUaGUgZW1wdHkgdGFzayBsaXN0J3Mgd29yZHMsIGtlcHQgdG8gcHV0IGJhY2suICovXG5jb25zdCBub1Rhc2tzID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJub3Rhc2tzXCIpITtcblxuLyoqIFdoZXRoZXIgYSB0YXNrIHN0aWxsIHdhbnRzIHRoZSBzY3JlZW46IGl0J3Mgd29ya2luZywgd2FpdGluZywgb3IgbmVlZHMgYXBwcm92YWwuIFRoZSByZXN0IGZvbGQgYXdheSB1bmRlciBGaW5pc2hlZC4gKi9cbmNvbnN0IGxpdmUgPSAoc3RhdGU6IHN0cmluZykgPT4gc3RhdGUgPT09IFwicnVubmluZ1wiIHx8IHN0YXRlLnN0YXJ0c1dpdGgoXCJ3YWl0aW5nXCIpO1xuY29uc3QgaXNBY3RpdmVUYXNrID0gKHZpZXc6IFRhc2tWaWV3KSA9PiBsaXZlKHZpZXcuYy5zdGF0ZSkgfHwgQm9vbGVhbih2aWV3LmFwcHJvdmFsKTtcblxuZnVuY3Rpb24gc2V0U2lkZUZpbHRlcihmaWx0ZXI6IFNpZGVGaWx0ZXIpIHtcbiAgc2lkZUZpbHRlciA9IG5vcm1hbGl6ZVNpZGVGaWx0ZXIoZmlsdGVyKTtcbiAgZm9yIChjb25zdCBidG4gb2YgQXJyYXkuZnJvbShkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxCdXR0b25FbGVtZW50PihcIiNzaWRlLXRhYnMgYnV0dG9uXCIpKSkge1xuICAgIGNvbnN0IG9uID0gYnRuLmRhdGFzZXQuZmlsdGVyID09PSBzaWRlRmlsdGVyO1xuICAgIGJ0bi5jbGFzc0xpc3QudG9nZ2xlKFwib25cIiwgb24pO1xuICAgIGJ0bi5zZXRBdHRyaWJ1dGUoXCJhcmlhLXByZXNzZWRcIiwgU3RyaW5nKG9uKSk7XG4gIH1cbiAgc3luY1NpZGVMYXlvdXQoKTtcbiAgY2xlYXJVbnJlYWRJZlJlc3VsdHNWaXNpYmxlKCk7XG4gIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB1cGRhdGVBbGxSZXN1bHRDbGFtcGluZygpKTtcbn1cblxuZnVuY3Rpb24gc3luY1NpZGVMYXlvdXQoKSB7XG4gIGNvbnN0IGFsbCA9IFsuLi50YXNrcy52YWx1ZXMoKV07XG4gIGNvbnN0IGFjdGl2ZUN1cnJlbnQgPSBhbGwuZmlsdGVyKGlzQWN0aXZlVGFzaykubGVuZ3RoO1xuICBjb25zdCBhY3RpdmVUb3RhbCA9IGFjdGl2ZUN1cnJlbnQgKyBlYXJsaWVyQWN0aXZlQ291bnQ7XG4gIGNvbnN0IHJlc3VsdHNUb3RhbCA9IHJlc3VsdHMuc2l6ZTtcbiAgY29uc3QgZWFybGllclNob3duID0gJChcImVhcmxpZXJcIikuY2hpbGRFbGVtZW50Q291bnQ7XG4gIGNvbnN0IGRvbmVUb3RhbCA9ICQoXCJkb25lbm93XCIpLmNoaWxkRWxlbWVudENvdW50ICsgJChcImRvbmVlYXJsaWVyXCIpLmNoaWxkRWxlbWVudENvdW50O1xuXG4gIGNvbnN0IHZpcyA9IHJlc29sdmVTaWRlU2VjdGlvbnMoc2lkZUZpbHRlciwge1xuICAgIGFjdGl2ZTogYWN0aXZlQ3VycmVudCxcbiAgICByZXN1bHRzOiByZXN1bHRzVG90YWwsXG4gICAgZWFybGllcjogZWFybGllclNob3duLFxuICAgIGRvbmU6IGRvbmVUb3RhbCxcbiAgfSk7XG5cbiAgJChcInRhc2tzLXNlY3Rpb25cIikuaGlkZGVuID0gIXZpcy5zaG93VGFza3NTZWN0aW9uO1xuICBub1Rhc2tzLmhpZGRlbiA9ICF2aXMuc2hvd0VtcHR5VGFza3M7XG4gICQoXCJyZXN1bHRzLXNlY3Rpb25cIikuaGlkZGVuID0gIXZpcy5zaG93UmVzdWx0c1NlY3Rpb247XG4gICQoXCJub3Jlc3VsdHNcIikuaGlkZGVuID0gIXZpcy5zaG93RW1wdHlSZXN1bHRzO1xuICAkKFwiZWFybGllcmJveFwiKS5oaWRkZW4gPSAhdmlzLnNob3dFYXJsaWVyU2VjdGlvbjtcbiAgJChcImRvbmVib3hcIikuaGlkZGVuID0gIXZpcy5zaG93RG9uZVNlY3Rpb247XG5cbiAgJChcInNpZGUtYWN0aXZlLW5cIikudGV4dENvbnRlbnQgPSBhY3RpdmVUb3RhbCA+IDAgPyBTdHJpbmcoYWN0aXZlVG90YWwpIDogXCJcIjtcbiAgJChcInNpZGUtcmVzdWx0cy1uXCIpLnRleHRDb250ZW50ID0gcmVzdWx0c1RvdGFsID4gMCA/IFN0cmluZyhyZXN1bHRzVG90YWwpIDogXCJcIjtcbiAgJChcInJlc3VsdHNjb3VudFwiKS50ZXh0Q29udGVudCA9IHJlc3VsdHNUb3RhbCA+IDAgPyBgXHUwMEI3ICR7cmVzdWx0c1RvdGFsfWAgOiBcIlwiO1xuICAkKFwiZG9uZWNvdW50XCIpLnRleHRDb250ZW50ID0gZG9uZVRvdGFsID4gMCA/IGBcdTAwQjcgJHtkb25lVG90YWx9YCA6IFwiXCI7XG4gIHN5bmNSZXN1bHRGb2xsb3dVcEJ1dHRvbnMoKTtcbn1cblxuZnVuY3Rpb24gdXBkYXRlVGFza0Nocm9tZSgpIHtcbiAgY29uc3QgYWxsID0gWy4uLnRhc2tzLnZhbHVlcygpXTtcbiAgY29uc3QgYWN0aXZlQ3VycmVudCA9IGFsbC5maWx0ZXIoaXNBY3RpdmVUYXNrKS5sZW5ndGg7XG4gIGNvbnN0IHdhaXRpbmcgPSBhbGwuZmlsdGVyKCh0KSA9PiB0LmMuc3RhdGUuc3RhcnRzV2l0aChcIndhaXRpbmdcIikgfHwgQm9vbGVhbih0LmFwcHJvdmFsKSkubGVuZ3RoO1xuICBjb25zdCBhY3RpdmVUb3RhbCA9IGFjdGl2ZUN1cnJlbnQgKyBlYXJsaWVyQWN0aXZlQ291bnQ7XG4gIGNvbnN0IGF0dGVudGlvblRvdGFsID0gd2FpdGluZyArIGVhcmxpZXJXYWl0aW5nQ291bnQ7XG4gIGNvbnN0IGJhZGdlQ291bnQgPSBhY3RpdmVUb3RhbCA+IDAgPyBhY3RpdmVUb3RhbCA6IHVucmVhZE1vYmlsZVJlc3VsdHM7XG5cbiAgY29uc3QgYmFkZ2UgPSAkKFwidGFza3MtYmFkZ2VcIik7XG4gIGJhZGdlLmhpZGRlbiA9IGJhZGdlQ291bnQgPT09IDA7XG4gIGJhZGdlLnRleHRDb250ZW50ID0gU3RyaW5nKGJhZGdlQ291bnQpO1xuICBiYWRnZS5jbGFzc0xpc3QudG9nZ2xlKFwid2FyblwiLCBhdHRlbnRpb25Ub3RhbCA+IDApO1xuXG4gIGNvbnN0IGJhciA9ICQoXCJtb2JpbGUtdGFza3MtYmFyXCIpO1xuICBjb25zdCBzaG93QmFyID0gYWN0aXZlVG90YWwgPiAwIHx8IHVucmVhZE1vYmlsZVJlc3VsdHMgPiAwO1xuICBiYXIuaGlkZGVuID0gIXNob3dCYXI7XG4gIGJhci5jbGFzc0xpc3QudG9nZ2xlKFwidmlzaWJsZVwiLCBzaG93QmFyKTtcbiAgYmFyLmNsYXNzTGlzdC50b2dnbGUoXCJ3YXJuXCIsIGF0dGVudGlvblRvdGFsID4gMCk7XG4gIGlmIChzaG93QmFyKSB7XG4gICAgY29uc3QgYXBwcm92YWwgPSBhbGwuZmluZCgodCkgPT4gdC5hcHByb3ZhbCk7XG4gICAgY29uc3QgbGFiZWwgPSBhcHByb3ZhbFxuICAgICAgPyBgQXBwcm92YWwgbmVlZGVkOiAke2FwcHJvdmFsLmMubGFiZWx9YFxuICAgICAgOiBhdHRlbnRpb25Ub3RhbCA+IDBcbiAgICAgICAgPyBgJHthdHRlbnRpb25Ub3RhbH0gdGFzayR7YXR0ZW50aW9uVG90YWwgPiAxID8gXCJzXCIgOiBcIlwifSB3YWl0aW5nIGZvciB5b3VgXG4gICAgICAgIDogYWN0aXZlVG90YWwgPiAwXG4gICAgICAgICAgPyBgJHthY3RpdmVUb3RhbH0gYWN0aXZlIHRhc2ske2FjdGl2ZVRvdGFsID4gMSA/IFwic1wiIDogXCJcIn1gXG4gICAgICAgICAgOiBgJHt1bnJlYWRNb2JpbGVSZXN1bHRzfSBuZXcgYWdlbnQgcmVzdWx0JHt1bnJlYWRNb2JpbGVSZXN1bHRzID4gMSA/IFwic1wiIDogXCJcIn1gO1xuICAgICQoXCJtdGItdGV4dFwiKS50ZXh0Q29udGVudCA9IGxhYmVsO1xuICB9XG59XG5cbmZ1bmN0aW9uIHNob3dUYXNrcyhmb3JjZSA9IGZhbHNlKSB7XG4gIGNvbnN0IHBhbmUgPSAkKFwidGFza3NcIik7XG4gIGNvbnN0IGRvbmUgPSAkKFwiZG9uZW5vd1wiKTtcbiAgY29uc3Qgb3BlbiA9IGRvY3VtZW50LmFjdGl2ZUVsZW1lbnQ/LmNsb3Nlc3Q/LihcIi50YXNrXCIpIGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgaWYgKCFmb3JjZSAmJiBvcGVuICYmIChwYW5lLmNvbnRhaW5zKG9wZW4pIHx8IGRvbmUuY29udGFpbnMob3BlbikpICYmIG9wZW4ucXVlcnlTZWxlY3RvcihcImZvcm1cIikpIHJldHVybjsgLy8gZG9uJ3QgcmVkcmF3IHVuZGVyIHNvbWVvbmUgdHlwaW5nIGEgZm9sbG93LXVwXG4gIHBhbmUuaW5uZXJIVE1MID0gXCJcIjtcbiAgZG9uZS5pbm5lckhUTUwgPSBcIlwiO1xuICBjb25zdCBhbGwgPSBbLi4udGFza3MudmFsdWVzKCldLnJldmVyc2UoKTtcbiAgaWYgKGFsbC5sZW5ndGggPT09IDApIHtcbiAgICBwYW5lLmFwcGVuZChub1Rhc2tzKTtcbiAgICAkKFwidGFza2NvdW50XCIpLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAkKFwiY2FuY2VsYWxsXCIpLmhpZGRlbiA9IHRydWU7XG4gICAgc3luY1NpZGVMYXlvdXQoKTtcbiAgICB1cGRhdGVUYXNrQ2hyb21lKCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHJ1bm5pbmcgPSBhbGwuZmlsdGVyKCh0KSA9PiB0LmMuc3RhdGUgPT09IFwicnVubmluZ1wiKS5sZW5ndGg7XG4gIGNvbnN0IGFjdGl2ZUNvdW50ID0gYWxsLmZpbHRlcihpc0FjdGl2ZVRhc2spLmxlbmd0aDtcbiAgJChcInRhc2tjb3VudFwiKS50ZXh0Q29udGVudCA9IHJ1bm5pbmcgPiAwID8gYCR7cnVubmluZ30gcnVubmluZ2AgOiBhY3RpdmVDb3VudCA+IDAgPyBgJHthY3RpdmVDb3VudH0gd2FpdGluZ2AgOiBcIlwiO1xuICAkKFwiY2FuY2VsYWxsXCIpLmhpZGRlbiA9ICFjYWxsSWQgfHwgcnVubmluZyA8IDI7XG4gIGZvciAoY29uc3QgdmlldyBvZiBhbGwpIHtcbiAgICBjb25zdCB0ID0gdmlldy5jO1xuICAgIGNvbnN0IHdhaXRpbmcgPSB0LnN0YXRlLnN0YXJ0c1dpdGgoXCJ3YWl0aW5nXCIpO1xuICAgIGNvbnN0IGNhcmQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGNhcmQuY2xhc3NOYW1lID0gYHRhc2sgJHt3YWl0aW5nID8gXCJ3YWl0aW5nXCIgOiB0LnN0YXRlfWA7XG4gICAgY29uc3QgYWdlID0gKHZpZXcuZW5kZWQgPz8gbm93KCkpIC0gdmlldy5zaW5jZTtcbiAgICBjYXJkLmlubmVySFRNTCA9XG4gICAgICBgPGRpdiBjbGFzcz1cIm1ldGEtcm93XCI+YCArXG4gICAgICAgIGA8c3BhbiBjbGFzcz1cImJhZGdlICR7dC5hZ2VudCA9PT0gXCJ0M1wiID8gXCJ0M1wiIDogXCJcIn1cIj4ke3QuYWdlbnQgPT09IFwidDNcIiA/IFwiVDNcIiA6IFwiSGVybWVzXCJ9PC9zcGFuPmAgK1xuICAgICAgICBgPHNwYW4gY2xhc3M9XCJsYWJlbFwiPjwvc3Bhbj5gICtcbiAgICAgICAgYDxzcGFuIGNsYXNzPVwic3RhdGVcIj4ke3Quc3RhdGUgPT09IFwicnVubmluZ1wiID8gJzxzcGFuIGNsYXNzPVwic3BpblwiPjwvc3Bhbj4nIDogXCJcIn0ke2VzY2FwZUh0bWwodC5zdGF0ZSl9PC9zcGFuPmAgK1xuICAgICAgICBgPHNwYW4gY2xhc3M9XCJhZ2VcIj4ke2VsYXBzZWQoYWdlKX08L3NwYW4+YCArXG4gICAgICBgPC9kaXY+YCArXG4gICAgICBgPGRpdiBjbGFzcz1cInBcIj48L2Rpdj5gO1xuICAgIGNvbnN0IGxhYmVsRWwgPSBjYXJkLnF1ZXJ5U2VsZWN0b3IoXCIubGFiZWxcIikgYXMgSFRNTEVsZW1lbnQ7XG4gICAgbGFiZWxFbC50ZXh0Q29udGVudCA9IHQubGFiZWw7XG4gICAgbGFiZWxFbC50aXRsZSA9IHQubGFiZWw7XG4gICAgY2FyZC5xdWVyeVNlbGVjdG9yKFwiLnBcIikhLnRleHRDb250ZW50ID0gdC5wcm9ncmVzcyA/PyB0LnJlcXVlc3Q7XG4gICAgaWYgKHQucXVlc3Rpb24pIHtcbiAgICAgIGNvbnN0IHEgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgICAgcS5jbGFzc05hbWUgPSBcInFcIjtcbiAgICAgIHEudGV4dENvbnRlbnQgPSBgQXNrczogJHt0LnF1ZXN0aW9ufWA7XG4gICAgICBjYXJkLmFwcGVuZChxKTtcbiAgICB9XG4gICAgaWYgKHZpZXcuYXBwcm92YWwgJiYgdC5zdGF0ZSA9PT0gXCJydW5uaW5nXCIpIHtcbiAgICAgIGNvbnN0IGJveCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICBib3guY2xhc3NOYW1lID0gXCJhcHByb3ZhbFwiO1xuICAgICAgYm94LmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPVwiYXBwcm92YWwtaGVhZFwiPkhlcm1lcyBhc2tzIHRvIHJ1bjwvZGl2Pjxjb2RlPjwvY29kZT48ZGl2IGNsYXNzPVwiYWN0c1wiPjwvZGl2PmA7XG4gICAgICBib3gucXVlcnlTZWxlY3RvcihcImNvZGVcIikhLnRleHRDb250ZW50ID0gdmlldy5hcHByb3ZhbC5jb21tYW5kO1xuICAgICAgY29uc3QgYW5zd2VyID0gKGNob2ljZTogXCJvbmNlXCIgfCBcImRlbnlcIikgPT4ge1xuICAgICAgICB2aWV3LmFwcHJvdmFsID0gdW5kZWZpbmVkO1xuICAgICAgICBzaG93VGFza3ModHJ1ZSk7XG4gICAgICAgIHZvaWQgZmV0Y2goXCIvaGVybWVzL2FwcHJvdmFsXCIsIHsgbWV0aG9kOiBcIlBPU1RcIiwgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBjYWxsOiBjYWxsTmFtZSwgdGFza0lkOiB0LmlkLCBjaG9pY2UgfSkgfSlcbiAgICAgICAgICAudGhlbigocikgPT4gdG9hc3Qoci5vayA/IChjaG9pY2UgPT09IFwib25jZVwiID8gXCJBcHByb3ZlZFwiIDogXCJEZW5pZWRcIikgOiBcIlRoYXQgYXBwcm92YWwgaGFkIGFscmVhZHkgbGFwc2VkXCIpKTtcbiAgICAgIH07XG4gICAgICBmb3IgKGNvbnN0IFtsYWJlbCwgY2hvaWNlXSBvZiBbW1wiQXBwcm92ZSBvbmNlXCIsIFwib25jZVwiXSwgW1wiRGVueVwiLCBcImRlbnlcIl1dIGFzIGNvbnN0KSB7XG4gICAgICAgIGNvbnN0IGIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICAgICAgICBiLnR5cGUgPSBcImJ1dHRvblwiO1xuICAgICAgICBiLnRleHRDb250ZW50ID0gbGFiZWw7XG4gICAgICAgIGlmIChjaG9pY2UgPT09IFwib25jZVwiKSBiLmNsYXNzTmFtZSA9IFwiZ29cIjtcbiAgICAgICAgZWxzZSBiLmNsYXNzTmFtZSA9IFwiZGFuZ2VyXCI7XG4gICAgICAgIGIub25jbGljayA9ICgpID0+IGFuc3dlcihjaG9pY2UpO1xuICAgICAgICBib3gucXVlcnlTZWxlY3RvcihcIi5hY3RzXCIpIS5hcHBlbmQoYik7XG4gICAgICB9XG4gICAgICBjYXJkLmFwcGVuZChib3gpO1xuICAgIH1cbiAgICBpZiAodC5zdGF0ZSAhPT0gXCJydW5uaW5nXCIpIHZpZXcuYXBwcm92YWwgPSB1bmRlZmluZWQ7XG4gICAgY29uc3QgYWN0cyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgYWN0cy5jbGFzc05hbWUgPSBcImFjdHNcIjtcbiAgICBjb25zdCBidXR0b24gPSAodGV4dDogc3RyaW5nLCBmbjogKCkgPT4gdm9pZCwgY2xzID0gXCJcIikgPT4ge1xuICAgICAgY29uc3QgYiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gICAgICBiLnR5cGUgPSBcImJ1dHRvblwiO1xuICAgICAgYi50ZXh0Q29udGVudCA9IHRleHQ7XG4gICAgICBpZiAoY2xzKSBiLmNsYXNzTmFtZSA9IGNscztcbiAgICAgIGIub25jbGljayA9IGZuO1xuICAgICAgYWN0cy5hcHBlbmQoYik7XG4gICAgICByZXR1cm4gYjtcbiAgICB9O1xuICAgIGlmIChjYWxsSWQgJiYgYWN0aXZlU2Vzc2lvbiA+IDApIHtcbiAgICAgIGNvbnN0IG9yaWdpblNlc3Npb24gPSBhY3RpdmVTZXNzaW9uO1xuICAgICAgYnV0dG9uKHdhaXRpbmcgPyBcIkFuc3dlclwiIDogXCJGb2xsb3cgdXBcIiwgKCkgPT4gZm9sbG93VXBGb3JtKGNhcmQsIHQsIG9yaWdpblNlc3Npb24pKTtcbiAgICAgIGlmICh0LnN0YXRlID09PSBcInJ1bm5pbmdcIikgYnV0dG9uKFwiQ2FuY2VsXCIsICgpID0+IHB1c2goeyB0eXBlOiBcImNhbmNlbFRhc2tcIiwgdGFzazogdC5pZCB9KSwgXCJkYW5nZXJcIik7XG4gICAgfVxuICAgIGlmICh2aWV3LnJlc3VsdElkKSBidXR0b24oXCJSZXN1bHRcIiwgKCkgPT4gZm9jdXNSZXN1bHQodmlldy5yZXN1bHRJZCEpKTtcbiAgICBpZiAodmlldy50aHJlYWQpIGJ1dHRvbihcIkNvcHkgaWRcIiwgKCkgPT4geyB2b2lkIG5hdmlnYXRvci5jbGlwYm9hcmQ/LndyaXRlVGV4dCh2aWV3LnRocmVhZCEpOyB0b2FzdChcIlRocmVhZCBpZCBjb3BpZWRcIik7IH0pO1xuICAgIGlmIChhY3RzLmNoaWxkRWxlbWVudENvdW50KSBjYXJkLmFwcGVuZChhY3RzKTtcbiAgICAoaXNBY3RpdmVUYXNrKHZpZXcpID8gcGFuZSA6IGRvbmUpLmFwcGVuZChjYXJkKTtcbiAgfVxuICBpZiAocGFuZS5jaGlsZEVsZW1lbnRDb3VudCA9PT0gMCkgcGFuZS5hcHBlbmQobm9UYXNrcyk7XG4gIHN5bmNTaWRlTGF5b3V0KCk7XG4gIHVwZGF0ZVRhc2tDaHJvbWUoKTtcbn1cblxuZnVuY3Rpb24gZm9sbG93VXBGb3JtKGNhcmQ6IEhUTUxFbGVtZW50LCB0OiBDb21tYW5kLCBvcmlnaW5TZXNzaW9uOiBudW1iZXIpIHtcbiAgY29uc3QgZXhpc3RpbmcgPSBjYXJkLnF1ZXJ5U2VsZWN0b3IoXCJmb3JtXCIpO1xuICBpZiAoZXhpc3RpbmcpIHsgZXhpc3RpbmcucXVlcnlTZWxlY3RvcihcImlucHV0XCIpPy5mb2N1cygpOyByZXR1cm47IH1cbiAgY29uc3QgZm9ybSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJmb3JtXCIpO1xuICBmb3JtLmNsYXNzTmFtZSA9IFwiZm9sbG93dXAtZm9ybVwiO1xuICBmb3JtLmlubmVySFRNTCA9IGA8aW5wdXQgdHlwZT1cInRleHRcIiBwbGFjZWhvbGRlcj1cIlRlbGwgXHUyMDFDJHtlc2NhcGVIdG1sKHQubGFiZWwpfVx1MjAxRFx1MjAyNlwiIGVudGVya2V5aGludD1cInNlbmRcIj48YnV0dG9uIHR5cGU9XCJzdWJtaXRcIj5TZW5kPC9idXR0b24+YDtcbiAgY29uc3QgaW5wdXQgPSBmb3JtLnF1ZXJ5U2VsZWN0b3IoXCJpbnB1dFwiKSE7XG4gIGZvcm0ub25zdWJtaXQgPSAoZSkgPT4ge1xuICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICBjb25zdCB0ZXh0ID0gaW5wdXQudmFsdWUudHJpbSgpO1xuICAgIGlmICh0ZXh0KSB7XG4gICAgICBpZiAoIWNhbkZvbGxvd1VwUmVzdWx0KG9yaWdpblNlc3Npb24sIGFjdGl2ZVNlc3Npb24sIHRhc2tzLmhhcyh0LmlkKSkpIHtcbiAgICAgICAgdG9hc3QoXCJUaGF0IHRhc2sncyBjYWxsIGhhcyBlbmRlZFwiKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHB1c2goeyB0eXBlOiBcInN0ZWVyXCIsIHRhc2s6IHQuaWQsIHRleHQgfSk7XG4gICAgICAgIG5vdGUoYFlvdSBcdTIxOTIgJHt0LmxhYmVsfTogJHt0ZXh0fWApO1xuICAgICAgICBzY3JvbGxEb3duKHRydWUpO1xuICAgICAgfVxuICAgIH1cbiAgICBpbnB1dC5ibHVyKCk7XG4gICAgZm9ybS5yZW1vdmUoKTtcbiAgICBzaG93VGFza3MoKTtcbiAgfTtcbiAgaW5wdXQub25rZXlkb3duID0gKGUpID0+IHsgaWYgKGUua2V5ID09PSBcIkVzY2FwZVwiKSB7IGUuc3RvcFByb3BhZ2F0aW9uKCk7IGlucHV0LmJsdXIoKTsgZm9ybS5yZW1vdmUoKTsgc2hvd1Rhc2tzKCk7IH0gfTtcbiAgY2FyZC5hcHBlbmQoZm9ybSk7XG4gIGlucHV0LmZvY3VzKCk7XG59XG5cbi8qKiBUMyB0aHJlYWRzIGVhcmxpZXIgY2FsbHMgc3RhcnRlZDogdGhleSBjYXJyeSBvbiBhZnRlciBhIGNhbGwsIHNvIHRoZSBwYW5lbCBzYXlzIGhvdyB0aGV5J3JlIGRvaW5nLiAqL1xuYXN5bmMgZnVuY3Rpb24gc2hvd0VhcmxpZXIoKSB7XG4gIGxldCBsaXN0OiB7IHRocmVhZDogc3RyaW5nOyB0aXRsZTogc3RyaW5nOyBzdGF0dXM6IHN0cmluZzsgYnJhbmNoOiBzdHJpbmcgfCBudWxsOyBwcjogc3RyaW5nIHwgbnVsbDsgdXBkYXRlZDogc3RyaW5nOyBsYXN0OiBzdHJpbmc7IHdhaXRpbmc6IGJvb2xlYW4gfVtdID0gW107XG4gIHRyeSB7IGxpc3QgPSBhd2FpdCAoYXdhaXQgZmV0Y2goXCIvYWdlbnQvcmVjZW50XCIsIHsgY2FjaGU6IFwibm8tc3RvcmVcIiB9KSkuanNvbigpOyB9IGNhdGNoIHt9XG4gIGNvbnN0IGN1cnJlbnQgPSBuZXcgU2V0KFsuLi50YXNrcy52YWx1ZXMoKV0ubWFwKCh2KSA9PiB2LnRocmVhZCkuZmlsdGVyKEJvb2xlYW4pKTtcbiAgbGlzdCA9IGxpc3QuZmlsdGVyKCh0KSA9PiAhY3VycmVudC5oYXModC50aHJlYWQpKTtcbiAgY29uc3QgcGFuZSA9ICQoXCJlYXJsaWVyXCIpO1xuICBjb25zdCBkb25lID0gJChcImRvbmVlYXJsaWVyXCIpO1xuICBwYW5lLmlubmVySFRNTCA9IFwiXCI7XG4gIGRvbmUuaW5uZXJIVE1MID0gXCJcIjtcbiAgZWFybGllckFjdGl2ZUNvdW50ID0gMDtcbiAgZWFybGllcldhaXRpbmdDb3VudCA9IDA7XG4gIGZvciAoY29uc3QgdCBvZiBsaXN0KSB7XG4gICAgY29uc3QgY2FyZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgY29uc3Qgc3RhdGUgPSB0LndhaXRpbmcgPyBcIndhaXRpbmcgZm9yIGFwcHJvdmFsIGluIFQzXCIgOiB0LnN0YXR1cztcbiAgICBjYXJkLmNsYXNzTmFtZSA9IGB0YXNrICR7dC5zdGF0dXMgPT09IFwicnVubmluZ1wiID8gXCJydW5uaW5nXCIgOiB0LndhaXRpbmcgPyBcIndhaXRpbmdcIiA6IFwiZmluaXNoZWRcIn1gO1xuICAgIGNvbnN0IGFnbyA9IE1hdGgubWF4KDAsIChEYXRlLm5vdygpIC0gRGF0ZS5wYXJzZSh0LnVwZGF0ZWQpKSAvIDEwMDApO1xuICAgIGNhcmQuaW5uZXJIVE1MID1cbiAgICAgIGA8ZGl2IGNsYXNzPVwibWV0YS1yb3dcIj5gICtcbiAgICAgICAgYDxzcGFuIGNsYXNzPVwiYmFkZ2UgdDNcIj5UMzwvc3Bhbj5gICtcbiAgICAgICAgYDxzcGFuIGNsYXNzPVwibGFiZWxcIj48L3NwYW4+YCArXG4gICAgICAgIGA8c3BhbiBjbGFzcz1cInN0YXRlXCI+JHt0LnN0YXR1cyA9PT0gXCJydW5uaW5nXCIgPyAnPHNwYW4gY2xhc3M9XCJzcGluXCI+PC9zcGFuPicgOiBcIlwifSR7ZXNjYXBlSHRtbChzdGF0ZSl9PC9zcGFuPmAgK1xuICAgICAgICBgPHNwYW4gY2xhc3M9XCJhZ2VcIj4ke2VsYXBzZWQoYWdvKX0gYWdvPC9zcGFuPmAgK1xuICAgICAgYDwvZGl2PmAgK1xuICAgICAgYDxkaXYgY2xhc3M9XCJwXCI+PC9kaXY+YDtcbiAgICBjb25zdCBsYWJlbEVsID0gY2FyZC5xdWVyeVNlbGVjdG9yKFwiLmxhYmVsXCIpIGFzIEhUTUxFbGVtZW50O1xuICAgIGxhYmVsRWwudGV4dENvbnRlbnQgPSB0LnRpdGxlO1xuICAgIGxhYmVsRWwudGl0bGUgPSB0LnRpdGxlO1xuICAgIGNhcmQucXVlcnlTZWxlY3RvcihcIi5wXCIpIS50ZXh0Q29udGVudCA9IHQubGFzdCB8fCAodC5icmFuY2ggPyBgT24gJHt0LmJyYW5jaH1gIDogXCJcIik7XG4gICAgY29uc3QgYWN0cyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgYWN0cy5jbGFzc05hbWUgPSBcImFjdHNcIjtcbiAgICBpZiAodC5wcikgeyBjb25zdCBhID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImFcIik7IGEuaHJlZiA9IHQucHI7IGEudGFyZ2V0ID0gXCJfYmxhbmtcIjsgYS5yZWwgPSBcIm5vb3BlbmVyXCI7IGEudGV4dENvbnRlbnQgPSBcIlBSIFx1MjE5N1wiOyBhY3RzLmFwcGVuZChhKTsgfVxuICAgIGNvbnN0IGNvcHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICAgIGNvcHkudHlwZSA9IFwiYnV0dG9uXCI7XG4gICAgY29weS50ZXh0Q29udGVudCA9IFwiQ29weSBpZFwiO1xuICAgIGNvcHkub25jbGljayA9ICgpID0+IHsgdm9pZCBuYXZpZ2F0b3IuY2xpcGJvYXJkPy53cml0ZVRleHQodC50aHJlYWQpOyB0b2FzdChcIlRocmVhZCBpZCBjb3BpZWRcIik7IH07XG4gICAgYWN0cy5hcHBlbmQoY29weSk7XG4gICAgY2FyZC5hcHBlbmQoYWN0cyk7XG4gICAgY29uc3QgYWN0aXZlID0gdC5zdGF0dXMgPT09IFwicnVubmluZ1wiIHx8IHQud2FpdGluZztcbiAgICBpZiAoYWN0aXZlKSBlYXJsaWVyQWN0aXZlQ291bnQrKztcbiAgICBpZiAodC53YWl0aW5nKSBlYXJsaWVyV2FpdGluZ0NvdW50Kys7XG4gICAgKGFjdGl2ZSA/IHBhbmUgOiBkb25lKS5hcHBlbmQoY2FyZCk7XG4gIH1cbiAgc3luY1NpZGVMYXlvdXQoKTtcbiAgdXBkYXRlVGFza0Nocm9tZSgpO1xufVxuXG5jb25zdCBTVEFUVVNfVEVYVDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgaWRsZTogXCJJZGxlXCIsIGNvbm5lY3Rpbmc6IFwiQ29ubmVjdGluZ1x1MjAyNlwiLCBsaXN0ZW5pbmc6IFwiTGlzdGVuaW5nXCIsIHdvcmtpbmc6IFwiTGlzdGVuaW5nIFx1MDBCNyB0YXNrcyBydW5uaW5nXCIsXG4gIGRvcm1hbnQ6IFwiRG9ybWFudCBcdTAwQjcgd2FpdGluZyBmb3Igd2FrZSB3b3JkXCIsXG4gIHN0YW5kYnk6IFwiUGF1c2VkIHdoaWxlIHRhc2tzIHJ1biBcdTAwQjcgc3BlYWsgdG8gcmVzdW1lXCIsIHdha2luZzogXCJSZXN1bWluZ1x1MjAyNlwiLCBlbmRlZDogXCJFbmRlZFwiLFxufTtcblxuZnVuY3Rpb24gc2hvd1N0YXR1cyhtZXNzYWdlPzogc3RyaW5nKSB7XG4gIGNvbnN0IHR5cGVkID0gQm9vbGVhbihjYWxsSWQpICYmIG1lZGl1bSA9PT0gXCJ0ZXh0XCI7XG4gIGNvbnN0IHNwZWFraW5nID0gQm9vbGVhbihjYWxsSWQpICYmICF0eXBlZCAmJiBjb3JlU3RhdHVzICE9PSBcInN0YW5kYnlcIiAmJiBjb3JlU3RhdHVzICE9PSBcImRvcm1hbnRcIiAmJiBhdWRpby5xdWV1ZWQgPiAwLjA1O1xuICBjb25zdCBhcm1lZElkbGUgPSAhY2FsbElkICYmIHdha2VBcm1lZDtcbiAgY29uc3Qgc2hvd24gPSBjYWxsSWRcbiAgICA/IChzcGVha2luZyB8fCAodHlwZWQgJiYgdGhpbmtpbmcpID8gXCJzcGVha2luZ1wiIDogY29yZVN0YXR1cylcbiAgICA6IGFybWVkSWRsZSA/IFwiYXJtZWRcIiA6IGNvcmVTdGF0dXM7XG4gICQoXCJzdGF0dXNcIikuY2xhc3NOYW1lID0gc2hvd247XG4gIGRvY3VtZW50LmJvZHkuZGF0YXNldC5zdGF0ZSA9IGNhbGxJZCA/IHNob3duIDogYXJtZWRJZGxlID8gXCJhcm1lZFwiIDogXCJpZGxlXCI7XG4gIGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LnRvZ2dsZShcImluLXNlc3Npb25cIiwgQm9vbGVhbihjYWxsSWQpKTtcbiAgY29uc3Qgd2FrZUxhYmVsID0gc2VsZWN0ZWRXYWtlTW9kZWwoKT8ubGFiZWwgPz8gXCJ3YWtlIHdvcmRcIjtcbiAgbGV0IHRleHQgPSBhcm1lZElkbGVcbiAgICA/ICh3YWtlTG9hZGluZyA/IGBMb2FkaW5nIFx1MjAxQyR7d2FrZUxhYmVsfVx1MjAxRFx1MjAyNmBcbiAgICAgIDogYXVkaW8uYXVkaW9TdXNwZW5kZWQgPyBgVGFwIGFueXdoZXJlIHRvIGFjdGl2YXRlIFx1MjAxQyR7d2FrZUxhYmVsfVx1MjAxRGBcbiAgICAgIDogYFdhaXRpbmcgZm9yIFx1MjAxQyR7d2FrZUxhYmVsfVx1MjAxRGApXG4gICAgOiBzcGVha2luZyA/IFwiU3BlYWtpbmdcIlxuICAgIDogY29yZVN0YXR1cyA9PT0gXCJkb3JtYW50XCIgPyBgRG9ybWFudCBcdTAwQjcgc2F5IFx1MjAxQyR7d2FrZUxhYmVsfVx1MjAxRGBcbiAgICA6IFNUQVRVU19URVhUW2NvcmVTdGF0dXNdID8/IGNvcmVTdGF0dXM7XG4gIGlmICh0eXBlZCAmJiBjb3JlU3RhdHVzICE9PSBcImVuZGVkXCIpIHRleHQgPSB0aGlua2luZyA/IFwiV3JpdGluZ1x1MjAyNlwiIDogY29yZVN0YXR1cyA9PT0gXCJ3b3JraW5nXCIgPyBcIkNoYXQgXHUwMEI3IHRhc2tzIHJ1bm5pbmdcIiA6IFwiQ2hhdFwiO1xuICBpZiAoY2FsbElkICYmICF0eXBlZCAmJiBtdXRlZCAmJiAhaG9sZGluZyAmJiAhc3BlYWtpbmcpIHRleHQgKz0gXCIgXHUwMEI3IG11dGVkXCI7XG4gIGlmIChob2xkaW5nKSB0ZXh0ID0gXCJUYWxraW5nIChob2xkKVwiO1xuICBpZiAobWVzc2FnZSkgdGV4dCA9IGAke3RleHR9OiAke21lc3NhZ2V9YDtcbiAgaWYgKGNvcmVTdGF0dXMgIT09IFwiZW5kZWRcIiB8fCBtZXNzYWdlIHx8IGFybWVkSWRsZSkgJChcInN0YXR1c3RleHRcIikudGV4dENvbnRlbnQgPSB0ZXh0O1xuICAkPEhUTUxCdXR0b25FbGVtZW50PihcImh1c2hcIikuY2xhc3NMaXN0LnRvZ2dsZShcImxpdmVcIiwgc3BlYWtpbmcgfHwgKHR5cGVkICYmIHRoaW5raW5nKSk7XG5cbiAgY29uc3QgYmFyID0gJChcImNhbGxiYXJcIik7XG4gIGJhci5oaWRkZW4gPSAhY2FsbElkO1xuICAkKFwid2FrZS1ub3dcIikuaGlkZGVuID0gIShjYWxsSWQgJiYgIXR5cGVkICYmIChjb3JlU3RhdHVzID09PSBcImRvcm1hbnRcIiB8fCBjb3JlU3RhdHVzID09PSBcInN0YW5kYnlcIikpO1xuICBpZiAoY2FsbElkKSB7XG4gICAgJChcImNhbGxiYXItc3RhdGVcIikudGV4dENvbnRlbnQgPSB0ZXh0O1xuICAgICQoXCJjYWxsdGltZXJcIikuaGlkZGVuID0gdHlwZWQ7XG4gICAgaWYgKCF0eXBlZCkgJChcImNhbGx0aW1lclwiKS50ZXh0Q29udGVudCA9IGZvcm1hdENsb2NrKG5vdygpIC0gc3RhcnRlZEF0KTtcbiAgICBjb25zdCB2aXpNb2RlID0gdHlwZWQgPyAodGhpbmtpbmcgPyBcInRoaW5raW5nXCIgOiBcImlkbGVcIilcbiAgICAgIDogc3BlYWtpbmcgPyBcInNwZWFraW5nXCJcbiAgICAgIDogbXV0ZWQgJiYgIWhvbGRpbmcgPyBcIm11dGVkXCJcbiAgICAgIDogc2hvd247XG4gICAgdXBkYXRlVmlzdWFsaXplcih2aXpNb2RlLCBtdXRlZCAmJiAhaG9sZGluZyA/IDAgOiBhdWRpby5sZXZlbCk7XG4gIH1cbn1cblxuLy8gVGhlIGNhbGwuXG5cbmZ1bmN0aW9uIHB1c2goZXZlbnQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LCB0ID0gbm93KCkpOiBDb21tYW5kW10ge1xuICBpZiAoIWNvcmUgfHwgIWNhbGxJZCkgcmV0dXJuIFtdO1xuICAvLyBGbHVzaCBkZWZlcnJlZCB1bnN1cHByZXNzZWQgZ2FwIGZyYW1lcyBiZWZvcmUgYW55IGV2ZW50IHRoYXQgY2FuIHN0YXJ0IG5ldyBwbGF5YmFja1xuICAvLyAoYWR2YW5jaW5nIHJlcGxheUZsb29yU2VxIHdpdGhvdXQgcmVzZXR0aW5nIHdha2VDbGllbnQsIHNvIGEgdmFsaWQgd2FrZSBoaXQgc3RpbGwgbGFuZHMpLlxuICBjb25zdCBmbHVzaGVkID0gd2FrZUdhdGUuYmVmb3JlUHVzaChldmVudCk7XG4gIGlmIChtZWRpdW0gPT09IFwidm9pY2VcIikge1xuICAgIGZvciAoY29uc3QgaXRlbSBvZiBmbHVzaGVkKSB7XG4gICAgICBpZiAoIWNhbGxJZCkgYnJlYWs7XG4gICAgICBjb3VudHMubWljKys7XG4gICAgICBwdXNoKHsgdHlwZTogXCJtaWNcIiwgcGNtOiBpdGVtLnBjbSB9LCBpdGVtLnQpO1xuICAgIH1cbiAgfVxuICBjb25zdCBlOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgLi4uZXZlbnQsIHQgfTtcbiAgY29uc3QgcXVpZXQgPSBlLnR5cGUgPT09IFwibWljXCIgfHwgZS50eXBlID09PSBcInRpY2tcIjtcbiAgaWYgKCFxdWlldCkgbG9nKFwiaW5cIiwgZS50eXBlID09PSBcIndzLm1lc3NhZ2VcIiA/IGB3cyAke2Uuc2lkfSBcdTIxOTAgJHticmllZihTdHJpbmcoZS5kYXRhKSl9YCA6IEpTT04uc3RyaW5naWZ5KGUpLnNsaWNlKDAsIDQwMCksIFwiaW5cIik7XG4gIGNvbnN0IGNvbW1hbmRzID0gSlNPTi5wYXJzZShjb3JlLnB1c2goY2FsbElkLCBKU09OLnN0cmluZ2lmeShlKSkpIGFzIENvbW1hbmRbXTtcbiAgcnVuKGNvbW1hbmRzLCB0LCB0eXBlb2YgZXZlbnQudHlwZSA9PT0gXCJzdHJpbmdcIiA/IGV2ZW50LnR5cGUgOiB1bmRlZmluZWQpO1xuICByZXR1cm4gY29tbWFuZHM7XG59XG5cbmZ1bmN0aW9uIHJ1bihjb21tYW5kczogQ29tbWFuZFtdLCBldmVudFRpbWUgPSBub3coKSwgZXZlbnRUeXBlPzogc3RyaW5nKSB7XG4gIGZvciAoY29uc3QgYyBvZiBjb21tYW5kcykge1xuICAgIHN3aXRjaCAoYy50eXBlKSB7XG4gICAgICBjYXNlIFwid3MuY29ubmVjdFwiOiBjb25uZWN0KGMuc2lkLCBjLnB1cnBvc2UgPT09IFwiY2FwdGlvbnNcIik7IGJyZWFrO1xuICAgICAgY2FzZSBcIndzLnNlbmRcIjoge1xuICAgICAgICBzb2NrZXRzLmdldChjLnNpZCk/LnNlbmQoYy5kYXRhKTtcbiAgICAgICAgaWYgKCFjLmRhdGEuc3RhcnRzV2l0aCgne1wicmVhbHRpbWVJbnB1dFwiOntcImF1ZGlvXCInKSkgbG9nKFwib3V0XCIsIGB3cyAke2Muc2lkfSBcdTIxOTIgJHticmllZihjLmRhdGEpfWAsIFwib3V0XCIpO1xuICAgICAgICBlbHNlIGlmICghY2FwdGlvblNvY2tldHMuaGFzKGMuc2lkKSkgY291bnRzLnNlbnQrKztcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwid3MuY2xvc2VcIjogc29ja2V0cy5nZXQoYy5zaWQpPy5jbG9zZSgpOyBzb2NrZXRzLmRlbGV0ZShjLnNpZCk7IGxvZyhcIm91dFwiLCBgd3MgJHtjLnNpZH0gY2xvc2VgLCBcIm91dFwiKTsgYnJlYWs7XG4gICAgICBjYXNlIFwibWljLnN0YXJ0XCI6IHtcbiAgICAgICAgbG9nKFwib3V0XCIsIGMudHlwZSwgXCJvdXRcIik7XG4gICAgICAgIGNvbnN0IHBlbmRpbmdPcGVuaW5nID0gd2FrZVN0YXJ0aW5nID8gb3BlbmluZ0NodW5rcy5zcGxpY2UoMCkgOiBbXTtcbiAgICAgICAgb3BlbmluZ0J5dGVzID0gMDtcbiAgICAgICAgd2FrZVN0YXJ0aW5nID0gZmFsc2U7XG4gICAgICAgIHZvaWQgYXVkaW8uZW5zdXJlTWljKG9uTWljLCBtaWNPcHRpb25zKCkpLmNhdGNoKChlcnIpID0+IHsgbG9nKFwiZXJyb3JcIiwgYG1pY3JvcGhvbmU6ICR7ZXJyLm1lc3NhZ2V9YCwgXCJlcnJcIik7IHRvYXN0KGBNaWNyb3Bob25lOiAke2Vyci5tZXNzYWdlfWApOyB9KTtcbiAgICAgICAgaWYgKHBlbmRpbmdPcGVuaW5nLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICBjb25zdCB0b3RhbE1zID0gTWF0aC5yb3VuZChwZW5kaW5nT3BlbmluZy5yZWR1Y2UoKHMsIGIpID0+IHMgKyBiLmJ5dGVMZW5ndGgsIDApIC8gMzIpO1xuICAgICAgICAgIGxvZyhcIm91dFwiLCBgZmx1c2hpbmcgJHt0b3RhbE1zfSBtcyBzcG9rZW4gYWZ0ZXIgd2FrZSB3b3JkYCwgXCJvdXRcIik7XG4gICAgICAgICAgcXVldWVNaWNyb3Rhc2soKCkgPT4ge1xuICAgICAgICAgICAgaWYgKCFjYWxsSWQpIHJldHVybjtcbiAgICAgICAgICAgIGZvciAoY29uc3QgY2h1bmsgb2YgcGVuZGluZ09wZW5pbmcpIHtcbiAgICAgICAgICAgICAgaWYgKCFjYWxsSWQpIGJyZWFrO1xuICAgICAgICAgICAgICBjb3VudHMubWljKys7XG4gICAgICAgICAgICAgIHB1c2goeyB0eXBlOiBcIm1pY1wiLCBwY206IGJ5dGVzVG9CYXNlNjQoY2h1bmspIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcIm1pYy5yZXN0YXJ0XCI6XG4gICAgICAgIGxvZyhcIm91dFwiLCBjLnR5cGUsIFwib3V0XCIpO1xuICAgICAgICB2b2lkIGF1ZGlvLnN0YXJ0TWljKG9uTWljLCBtaWNPcHRpb25zKCkpLmNhdGNoKChlcnIpID0+IHsgbG9nKFwiZXJyb3JcIiwgYG1pY3JvcGhvbmU6ICR7ZXJyLm1lc3NhZ2V9YCwgXCJlcnJcIik7IHRvYXN0KGBNaWNyb3Bob25lOiAke2Vyci5tZXNzYWdlfWApOyB9KTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwibWljLnN0b3BcIjpcbiAgICAgICAgaWYgKCF3YWtlQXJtZWQpIGF1ZGlvLnN0b3BNaWMoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwicGxheVwiOiB7XG4gICAgICAgIGNvbnN0IHQgPSBub3coKTtcbiAgICAgICAgd2FrZUdhdGUub25QbGF5KGMucGNtLCBldmVudFRpbWUsIHR5cGVvZiBjLnNvdXJjZSA9PT0gXCJzdHJpbmdcIiA/IGMuc291cmNlIDogdW5kZWZpbmVkKTtcbiAgICAgICAgLy8gQSByZXBseSBzdGFydGluZzogZnJvbSB0aGUgZW5kIG9mIHRoZSB1c2VyJ3Mgc3BlZWNoIHRvIGl0cyBmaXJzdCBzb3VuZC5cbiAgICAgICAgaWYgKCFtZXRyaWNzLnJlcGxpZWQgJiYgYXVkaW8ucXVldWVkIDwgMC4wNSAmJiB0IC0gbWV0cmljcy5sYXN0UGxheSA+IDAuNiAmJiBtZXRyaWNzLmxhc3RWb2ljZSA+IDAgJiYgdCAtIG1ldHJpY3MubGFzdFZvaWNlIDwgMTApIHtcbiAgICAgICAgICBtZXRyaWNzLnJlcGx5LnB1c2godCAtIG1ldHJpY3MubGFzdFZvaWNlKTtcbiAgICAgICAgICBpZiAobWV0cmljcy5yZXBseS5sZW5ndGggPiAyMCkgbWV0cmljcy5yZXBseS5zaGlmdCgpO1xuICAgICAgICAgIG1ldHJpY3MucmVwbGllZCA9IHRydWU7XG4gICAgICAgICAgc2hvd01ldHJpY3MoKTtcbiAgICAgICAgfVxuICAgICAgICBtZXRyaWNzLmxhc3RQbGF5ID0gdDtcbiAgICAgICAgYXVkaW8ucGxheShjLnBjbSk7XG4gICAgICAgIGNvdW50cy5wbGF5Kys7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcImZsdXNoXCI6XG4gICAgICAgIHdha2VHYXRlLm9uRmx1c2goZXZlbnRUaW1lLCBldmVudFR5cGUpO1xuICAgICAgICBhdWRpby5mbHVzaCgpO1xuICAgICAgICBsb2coXCJvdXRcIiwgXCJmbHVzaFwiLCBcIm91dFwiKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiYnJpZWZcIjpcbiAgICAgICAgaWYgKHR5cGVvZiBjLmlkID09PSBcInN0cmluZ1wiKSB3YWtlR2F0ZS5vbkJyaWVmUmVxdWVzdChjLmlkKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiY3VlXCI6XG4gICAgICAgIGF1ZGlvLmN1ZShjLnBjbSk7XG4gICAgICAgIGxvZyhcIm91dFwiLCBgY3VlICR7Yy5lYXJjb259YCwgXCJvdXRcIik7XG4gICAgICAgIC8vIEEgcmVxdWVzdCB0aGF0IGJlY2FtZSBhIHRhc2sgZ2V0cyBhIHRvbmUsIG5vdCBhIHNwb2tlbiByZXBseTogbm90aGluZyB0byB0aW1lLlxuICAgICAgICBpZiAoYy5lYXJjb24gPT09IFwidGFza1N0YXJ0ZWRcIikgbWV0cmljcy5yZXBsaWVkID0gdHJ1ZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwid2FrZXdvcmRcIjogZW5zdXJlQ29yZVdha2UoQm9vbGVhbihjLm9uKSk7IGJyZWFrO1xuICAgICAgY2FzZSBcInRvb2wuY2FsbFwiOiB2b2lkIHRvb2woYyk7IGJyZWFrO1xuICAgICAgY2FzZSBcInRvb2wuY2FuY2VsXCI6IGNhbmNlbFJ1bihjLnJ1biwgYy5yZWFzb24pOyBicmVhaztcbiAgICAgIGNhc2UgXCJ0b29sLnN0ZWVyXCI6IHZvaWQgc3RlZXJSdW4oYyk7IGJyZWFrO1xuICAgICAgY2FzZSBcInN0YXR1c1wiOiB7XG4gICAgICAgIGNvbnN0IHByZXYgPSBjb3JlU3RhdHVzO1xuICAgICAgICBjb3JlU3RhdHVzID0gYy5zdGF0dXM7XG4gICAgICAgIGlmIChjLnN0YXR1cyA9PT0gXCJkb3JtYW50XCIgJiYgcHJldiAhPT0gXCJkb3JtYW50XCIgJiYgY2hlY2tlZChcIndha2UtY3VlXCIpKSBhdWRpby5jdWUoU0xFRVBfVE9ORSk7XG4gICAgICAgIHNob3dTdGF0dXMoYy5zdGF0dXMgPT09IFwiZW5kZWRcIiA/IGMubWVzc2FnZSA/PyB1bmRlZmluZWQgOiB1bmRlZmluZWQpO1xuICAgICAgICBsb2coXCJzdGF0dXNcIiwgYy5zdGF0dXMgKyAoYy5tZXNzYWdlID8gYDogJHtjLm1lc3NhZ2V9YCA6IFwiXCIpLCBcInN0YXR1c1wiKTtcbiAgICAgICAgaWYgKGMuc3RhdHVzID09PSBcImVuZGVkXCIpIHsgaWYgKGMubWVzc2FnZSkgbm90ZShjLm1lc3NhZ2UpOyBlbmQoKTsgfVxuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJsbG0ucmVxdWVzdFwiOiB2b2lkIGdlbmVyYXRlKGMuaWQsIGMuYm9keSk7IGJyZWFrO1xuICAgICAgY2FzZSBcImxsbS5jYW5jZWxcIjogcmVxdWVzdHMuZ2V0KGMuaWQpPy5hYm9ydCgpOyByZXF1ZXN0cy5kZWxldGUoYy5pZCk7IGxvZyhcIm91dFwiLCBgcmVxdWVzdCAke2MuaWR9IGRyb3BwZWRgLCBcIm91dFwiKTsgYnJlYWs7XG4gICAgICBjYXNlIFwidGhpbmtpbmdcIjogdGhpbmtpbmcgPSBjLm9uOyBzaG93U3RhdHVzKCk7IGJyZWFrO1xuICAgICAgY2FzZSBcImVycm9yXCI6IG5vdGUoYy5tZXNzYWdlKTsgbG9nKFwiZXJyb3JcIiwgYy5tZXNzYWdlLCBcImVyclwiKTsgYnJlYWs7XG4gICAgICBjYXNlIFwiY2FwdGlvblwiOiBjYXB0aW9uKGMudGV4dCk7IGJyZWFrO1xuICAgICAgY2FzZSBcInRyYW5zY3JpcHRcIjpcbiAgICAgICAgdHJhbnNjcmlwdChjLnJvbGUsIGMudGV4dCwgYy5saW5lKTtcbiAgICAgICAgcmVtZW1iZXIoYy5yb2xlLCBjLnRleHQsIGMucm9sZSA9PT0gXCJhc3Npc3RhbnRcIiA/IFwiR2VtaW5pXCIgOiB1bmRlZmluZWQsIGxhc3RMaW5lID09PSBjLmxpbmUpO1xuICAgICAgICBsYXN0TGluZSA9IGMubGluZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwidGFza1wiOiB7XG4gICAgICAgIGNvbnN0IHZpZXcgPSB0YXNrcy5nZXQoYy5pZCkgPz8geyBjLCBzaW5jZTogbm93KCksIGVuZGVkOiBudWxsIH07XG4gICAgICAgIGlmIChjLnN0YXRlID09PSBcInJ1bm5pbmdcIiAmJiB2aWV3LmMuc3RhdGUgIT09IFwicnVubmluZ1wiKSB7IHZpZXcuc2luY2UgPSBub3coKTsgdmlldy5lbmRlZCA9IG51bGw7IH1cbiAgICAgICAgaWYgKGMuc3RhdGUgIT09IFwicnVubmluZ1wiICYmIHZpZXcuZW5kZWQgPT0gbnVsbCkgdmlldy5lbmRlZCA9IG5vdygpO1xuICAgICAgICB2aWV3LmMgPSBjO1xuICAgICAgICB0YXNrcy5zZXQoYy5pZCwgdmlldyk7XG4gICAgICAgIHNob3dUYXNrcygpO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJxdWVzdGlvbnNcIjogYnJlYWs7XG4gICAgICBjYXNlIFwibWljU2lsZW50XCI6ICQoXCJtaWN3YXJuXCIpLmhpZGRlbiA9ICFjLnNpbGVudDsgYnJlYWs7XG4gICAgICBjYXNlIFwidm9pY2VDb21tYW5kXCI6XG4gICAgICAgIHRvYXN0KGBIZWFyZCBcdTIwMUMke2MuaGVhcmR9XHUyMDFEOiAke2MuY29tbWFuZCA9PT0gXCJzdG9wXCIgPyBcInN0b3BwZWRcIiA6IGMuY29tbWFuZCA9PT0gXCJjYW5jZWxBbGxcIiA/IFwiY2FuY2VsbGluZyBldmVyeSB0YXNrXCIgOiBcImhhbmdpbmcgdXBcIn1gKTtcbiAgICAgICAgbG9nKFwib3V0XCIsIGB2b2ljZSBjb21tYW5kICR7Yy5jb21tYW5kfTogJHtjLmhlYXJkfWAsIFwib3V0XCIpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJsb2dcIjogbG9nKGMubGV2ZWwsIGMubWVzc2FnZSwgYy5sZXZlbCA9PT0gXCJ3YXJuXCIgPyBcIndhcm5cIiA6IFwiXCIpOyBicmVhaztcbiAgICAgIGRlZmF1bHQ6IGxvZyhcIm91dFwiLCBKU09OLnN0cmluZ2lmeShjKS5zbGljZSgwLCAzMDApLCBcIm91dFwiKTtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gZmx1c2hEZWZlcnJlZE1pYygpIHtcbiAgY29uc3QgaXRlbXMgPSB3YWtlR2F0ZS5mbHVzaERlZmVycmVkKCk7XG4gIGlmICghY2FsbElkIHx8IG1lZGl1bSAhPT0gXCJ2b2ljZVwiKSByZXR1cm47XG4gIGZvciAoY29uc3QgaXRlbSBvZiBpdGVtcykge1xuICAgIGlmICghY2FsbElkKSBicmVhaztcbiAgICBjb3VudHMubWljKys7XG4gICAgcHVzaCh7IHR5cGU6IFwibWljXCIsIHBjbTogaXRlbS5wY20gfSwgaXRlbS50KTtcbiAgfVxufVxuXG5mdW5jdGlvbiBvbk1pYyhzYW1wbGVzOiBJbnQxNkFycmF5LCBsZXZlbDogbnVtYmVyKSB7XG4gIGNvbnN0IHQgPSBub3coKTtcbiAgY29uc3Qgc3VwcHJlc3NlZCA9IGNhbGxJZCAhPT0gMCAmJiBtZWRpdW0gPT09IFwidm9pY2VcIiAmJiB3YWtlR2F0ZS5pc1N1cHByZXNzZWQodCk7XG4gIGNvbnN0IHNlcSA9IHNob3VsZEZlZWRXYWtlKCkgPyB3YWtlQ2xpZW50LmZlZWQoc2FtcGxlcywgc3VwcHJlc3NlZCkgOiAwO1xuICBpZiAod2FrZVN0YXJ0aW5nKSB7XG4gICAgY29uc3QgY29weSA9IG5ldyBVaW50OEFycmF5KHNhbXBsZXMuYnl0ZUxlbmd0aCk7XG4gICAgY29weS5zZXQobmV3IFVpbnQ4QXJyYXkoc2FtcGxlcy5idWZmZXIsIHNhbXBsZXMuYnl0ZU9mZnNldCwgc2FtcGxlcy5ieXRlTGVuZ3RoKSk7XG4gICAgb3BlbmluZ0NodW5rcy5wdXNoKGNvcHkpO1xuICAgIG9wZW5pbmdCeXRlcyArPSBjb3B5LmJ5dGVMZW5ndGg7XG4gICAgd2hpbGUgKG9wZW5pbmdCeXRlcyA+IE9QRU5JTkdfTUFYX0JZVEVTICYmIG9wZW5pbmdDaHVua3MubGVuZ3RoID4gMSkge1xuICAgICAgb3BlbmluZ0J5dGVzIC09IG9wZW5pbmdDaHVua3Muc2hpZnQoKSEuYnl0ZUxlbmd0aDtcbiAgICB9XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmICghY2FsbElkIHx8IG1lZGl1bSAhPT0gXCJ2b2ljZVwiKSByZXR1cm47XG4gIGlmIChsZXZlbCA+IDAuMDMgJiYgIShtdXRlZCAmJiAhaG9sZGluZykpIHtcbiAgICBtZXRyaWNzLmxhc3RWb2ljZSA9IHQ7XG4gICAgaWYgKGF1ZGlvLnF1ZXVlZCA8IDAuMDUpIG1ldHJpY3MucmVwbGllZCA9IGZhbHNlO1xuICB9XG4gIGNvbnN0IHBjbSA9IGJ5dGVzVG9CYXNlNjQobmV3IFVpbnQ4QXJyYXkoc2FtcGxlcy5idWZmZXIsIHNhbXBsZXMuYnl0ZU9mZnNldCwgc2FtcGxlcy5ieXRlTGVuZ3RoKSk7XG4gIGNvbnN0IHRvU2VuZCA9IHdha2VHYXRlLm9uTWljRnJhbWUoe1xuICAgIHBjbSxcbiAgICB0LFxuICAgIHNlcSxcbiAgICBsYXN0U2VxOiB3YWtlQ2xpZW50Lmxhc3RTZXEsXG4gICAgaW5GbGlnaHRTdXBwcmVzc2VkU2VxOiB3YWtlQ2xpZW50LmluRmxpZ2h0U3VwcHJlc3NlZFNlcSxcbiAgICBzdXBwcmVzc2VkLFxuICB9KTtcbiAgZm9yIChjb25zdCBpdGVtIG9mIHRvU2VuZCkge1xuICAgIGlmICghY2FsbElkKSBicmVhaztcbiAgICBjb3VudHMubWljKys7XG4gICAgcHVzaCh7IHR5cGU6IFwibWljXCIsIHBjbTogaXRlbS5wY20gfSwgaXRlbS50KTtcbiAgfVxufVxuXG5mdW5jdGlvbiBjb25uZWN0KHNpZDogbnVtYmVyLCBjYXB0aW9uczogYm9vbGVhbikge1xuICBjb25zdCB3cyA9IG5ldyBXZWJTb2NrZXQoYCR7bG9jYXRpb24ucHJvdG9jb2wgPT09IFwiaHR0cHM6XCIgPyBcIndzc1wiIDogXCJ3c1wifTovLyR7bG9jYXRpb24uaG9zdH0vbGl2ZSR7Y2FwdGlvbnMgPyBcIj9mb3I9Y2FwdGlvbnNcIiA6IFwiXCJ9YCk7XG4gIHNvY2tldHMuc2V0KHNpZCwgd3MpO1xuICBpZiAoY2FwdGlvbnMpIGNhcHRpb25Tb2NrZXRzLmFkZChzaWQpO1xuICBsb2coXCJvdXRcIiwgYHdzICR7c2lkfSBjb25uZWN0ICgke3NlcnZlci5yb3V0ZX0ke2NhcHRpb25zID8gXCIsIGNhcHRpb25zXCIgOiBcIlwifSlgLCBcIm91dFwiKTtcbiAgd3Mub25vcGVuID0gKCkgPT4gcHVzaCh7IHR5cGU6IFwid3Mub3BlblwiLCBzaWQgfSk7XG4gIHdzLm9ubWVzc2FnZSA9IChtKSA9PiBwdXNoKHsgdHlwZTogXCJ3cy5tZXNzYWdlXCIsIHNpZCwgZGF0YTogdHlwZW9mIG0uZGF0YSA9PT0gXCJzdHJpbmdcIiA/IG0uZGF0YSA6IFwiXCIgfSk7XG4gIHdzLm9uY2xvc2UgPSAoZSkgPT4ge1xuICAgIGlmIChzb2NrZXRzLmdldChzaWQpICE9PSB3cyAmJiBzb2NrZXRzLmhhcyhzaWQpKSByZXR1cm47XG4gICAgY29uc3QgaHR0cFN0YXR1cyA9IGUuY29kZSA+PSA0MTAwICYmIGUuY29kZSA8IDQ2MDAgPyBlLmNvZGUgLSA0MDAwIDogdW5kZWZpbmVkO1xuICAgIHB1c2goeyB0eXBlOiBcIndzLmNsb3NlZFwiLCBzaWQsIGNvZGU6IGh0dHBTdGF0dXMgPyB1bmRlZmluZWQgOiBlLmNvZGUsIHJlYXNvbjogZS5yZWFzb24sIGh0dHBTdGF0dXMgfSk7XG4gIH07XG59XG5cbi8qKiBBIGNoYXQncyByZXF1ZXN0IHRvIHRoZSB0ZXh0IG1vZGVsLCB0aHJvdWdoIHRoZSBzZXJ2ZXI6IGVhY2ggYGRhdGE6YCBsaW5lIG9mIHRoZSBtb2RlbCdzIHN0cmVhbSBnb2VzIHRvIHRoZSBjb3JlIGFzIGl0IGNvbWVzLiAqL1xuYXN5bmMgZnVuY3Rpb24gZ2VuZXJhdGUoaWQ6IG51bWJlciwgYm9keTogc3RyaW5nKSB7XG4gIGNvbnN0IGFib3J0ID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICByZXF1ZXN0cy5zZXQoaWQsIGFib3J0KTtcbiAgbG9nKFwib3V0XCIsIGByZXF1ZXN0ICR7aWR9IFx1MjE5MiAke3NlcnZlci50ZXh0TW9kZWx9ICgke01hdGgucm91bmQoYm9keS5sZW5ndGggLyAxMDI0KX0gS0IpYCwgXCJvdXRcIik7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChcIi9nZW5lcmF0ZVwiLCB7IG1ldGhvZDogXCJQT1NUXCIsIHNpZ25hbDogYWJvcnQuc2lnbmFsLCBoZWFkZXJzOiB7IFwiY29udGVudC10eXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sIGJvZHkgfSk7XG4gICAgaWYgKCFyZXNwb25zZS5vayB8fCAhcmVzcG9uc2UuYm9keSkge1xuICAgICAgY29uc3QgdGV4dCA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKS5jYXRjaCgoKSA9PiBcIlwiKTtcbiAgICAgIHB1c2goeyB0eXBlOiBcImxsbS5lbmRcIiwgaWQsIHN0YXR1czogcmVzcG9uc2Uuc3RhdHVzLCBlcnJvcjogYEhUVFAgJHtyZXNwb25zZS5zdGF0dXN9JHt0ZXh0ID8gXCI6IFwiICsgdGV4dC5yZXBsYWNlKC9cXHMrL2csIFwiIFwiKS5zbGljZSgwLCAyMDApIDogXCJcIn1gIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCByZWFkZXIgPSByZXNwb25zZS5ib2R5LnBpcGVUaHJvdWdoKG5ldyBUZXh0RGVjb2RlclN0cmVhbSgpKS5nZXRSZWFkZXIoKTtcbiAgICBsZXQgYnVmZmVyID0gXCJcIjtcbiAgICBmb3IgKDs7KSB7XG4gICAgICBjb25zdCB7IHZhbHVlLCBkb25lIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpO1xuICAgICAgaWYgKGRvbmUpIGJyZWFrO1xuICAgICAgYnVmZmVyICs9IHZhbHVlO1xuICAgICAgbGV0IGN1dDtcbiAgICAgIHdoaWxlICgoY3V0ID0gYnVmZmVyLmluZGV4T2YoXCJcXG5cIikpID49IDApIHtcbiAgICAgICAgY29uc3QgbGluZSA9IGJ1ZmZlci5zbGljZSgwLCBjdXQpLnJlcGxhY2UoL1xcciQvLCBcIlwiKTtcbiAgICAgICAgYnVmZmVyID0gYnVmZmVyLnNsaWNlKGN1dCArIDEpO1xuICAgICAgICBpZiAobGluZS5zdGFydHNXaXRoKFwiZGF0YTpcIikpIHB1c2goeyB0eXBlOiBcImxsbS5kYXRhXCIsIGlkLCBkYXRhOiBsaW5lLnNsaWNlKDUpLnRyaW0oKSB9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgcHVzaCh7IHR5cGU6IFwibGxtLmVuZFwiLCBpZCB9KTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgaWYgKCFhYm9ydC5zaWduYWwuYWJvcnRlZCkgcHVzaCh7IHR5cGU6IFwibGxtLmVuZFwiLCBpZCwgZXJyb3I6IChlcnIgYXMgRXJyb3IpLm1lc3NhZ2UgfSk7XG4gIH0gZmluYWxseSB7XG4gICAgcmVxdWVzdHMuZGVsZXRlKGlkKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBjYW5jZWxSdW4oa2V5OiBzdHJpbmcsIHJlYXNvbjogc3RyaW5nKSB7XG4gIGNvbnN0IHIgPSBydW5zLmdldChrZXkpO1xuICBsb2coXCJvdXRcIiwgYGNhbmNlbCAke2tleX0gKCR7cmVhc29ufSlgLCBcIm91dFwiKTtcbiAgaWYgKCFyKSByZXR1cm47XG4gIHJ1bnMuZGVsZXRlKGtleSk7XG4gIHIuYWJvcnQuYWJvcnQoKTtcbiAgLy8gQ2FuY2VsbGVkIG9uIHB1cnBvc2U6IHRoZSBhZ2VudCBzdG9wcyB0b28uIEEgY2FsbCB0aGF0IGVuZGVkIGxlYXZlcyBhIGNvZGluZyBhZ2VudCB3b3JraW5nIGluIFQzLlxuICBpZiAocmVhc29uID09PSBcImNhbmNlbGxlZFwiICYmICFjaGVja2VkKFwiZmFrZWhlcm1lc1wiKSkge1xuICAgIHZvaWQgZmV0Y2goci5hZ2VudCA9PT0gXCJ0M1wiID8gXCIvYWdlbnQvY2FuY2VsXCIgOiBcIi9oZXJtZXMvc3RvcFwiLCB7IG1ldGhvZDogXCJQT1NUXCIsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgY2FsbDogY2FsbE5hbWUsIHRhc2tJZDogci50YXNrSWQgfSkgfSk7XG4gIH1cbn1cblxuLyoqIE1vcmUgZm9yIGEgcnVubmluZyB0YXNrLCBpbnRvIGl0cyBjdXJyZW50IHJ1bjsgaWYgdGhlIGFnZW50IHdvbid0IHRha2UgaXQsIHRoZSBjb3JlIHF1ZXVlcyBpdCBpbnN0ZWFkLiAqL1xuYXN5bmMgZnVuY3Rpb24gc3RlZXJSdW4oYzogQ29tbWFuZCkge1xuICBjb25zdCByID0gcnVucy5nZXQoYy5ydW4pO1xuICBsb2coXCJvdXRcIiwgYHN0ZWVyICR7Yy5ydW59OiAke2MudGV4dH1gLCBcIm91dFwiKTtcbiAgaWYgKGNoZWNrZWQoXCJmYWtlaGVybWVzXCIpKSByZXR1cm47XG4gIGNvbnN0IG9rID0gciAhPSBudWxsICYmXG4gICAgKGF3YWl0IGZldGNoKGMuYWdlbnQgPT09IFwidDNcIiA/IFwiL2FnZW50L3N0ZWVyXCIgOiBcIi9oZXJtZXMvc3RlZXJcIiwgeyBtZXRob2Q6IFwiUE9TVFwiLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGNhbGw6IGNhbGxOYW1lLCB0YXNrSWQ6IHIudGFza0lkLCB0ZXh0OiBjLm1lc3NhZ2UgfSkgfSkudGhlbigoeCkgPT4geC5vaywgKCkgPT4gZmFsc2UpKTtcbiAgaWYgKCFvaykgcHVzaCh7IHR5cGU6IFwidG9vbC5zdGVlckZhaWxlZFwiLCBydW46IGMucnVuLCB0ZXh0OiBjLnRleHQgfSk7XG4gIGVsc2UgdG9hc3QoYCR7Yy5hZ2VudCA9PT0gXCJ0M1wiID8gXCJUaGUgY29kaW5nIGFnZW50XCIgOiBcIkhlcm1lc1wifSB0b29rIHRoZSBmb2xsb3ctdXAgd2hpbGUgaXQgd29ya3NgKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gdG9vbChjOiBDb21tYW5kKSB7XG4gIGlmIChjLmtpbmQgPT09IFwiaG9zdFwiKSB7XG4gICAgbG9nKFwib3V0XCIsIGBob3N0IHRvb2wgJHtjLm5hbWV9ICR7SlNPTi5zdHJpbmdpZnkoYy5hcmdzKX1gLCBcIm91dFwiKTtcbiAgICBjb25zdCBhbnN3ZXIgPSBjLm5hbWUgPT09IFwidHZfdm9sdW1lXCIgPyBgVGhlIFRWIGlzIGF0ICR7KGZha2VUdkxldmVsID0gTnVtYmVyKGMuYXJncz8ubGV2ZWwgPz8gZmFrZVR2TGV2ZWwpKX0uYFxuICAgICAgOiBjLm5hbWUgPT09IFwidHZfcGF1c2VcIiA/IChjLmFyZ3M/LnBhdXNlID09PSBmYWxzZSA/IFwiUGxheWluZy5cIiA6IFwiUGF1c2VkLlwiKSA6IFwiRG9uZS5cIjtcbiAgICBzZXRUaW1lb3V0KCgpID0+IHB1c2goeyB0eXBlOiBcInRvb2wucmVzdWx0XCIsIHJ1bjogYy5ydW4sIHRleHQ6IGFuc3dlciB9KSwgMzAwKTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgYWdlbnQgPSBjLmFnZW50ID09PSBcInQzXCIgPyBcInQzXCIgOiBcImhlcm1lc1wiO1xuICBjb25zdCBvcmlnaW5TZXNzaW9uID0gYWN0aXZlU2Vzc2lvbjtcbiAgbG9nKFwib3V0XCIsIGAke2FnZW50fSAke2MuZm9sbG93VXAgPyBcImZvbGxvdy11cFwiIDogXCJ0YXNrXCJ9IFwiJHtjLmxhYmVsfVwiJHtjLnByb2plY3QgPyBgIGluICR7Yy5wcm9qZWN0fWAgOiBcIlwifTogJHtjLnJlcXVlc3R9YCwgXCJvdXRcIik7XG4gIGNvbnN0IGFib3J0ID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICBydW5zLnNldChjLnJ1biwgeyBhYm9ydCwgYWdlbnQsIHRhc2tJZDogYy50YXNrSWQgfSk7XG4gIGNvbnN0IGRvbmUgPSAodGV4dDogc3RyaW5nLCBmYWlsZWQgPSBmYWxzZSkgPT4ge1xuICAgIGlmICghcnVucy5oYXMoYy5ydW4pKSByZXR1cm47XG4gICAgcnVucy5kZWxldGUoYy5ydW4pO1xuICAgIGNvbnN0IHZpZXcgPSB0YXNrcy5nZXQoYy50YXNrSWQpO1xuICAgIGNvbnN0IHJlc0lkID0gcmVzdWx0KGFnZW50LCBjLmxhYmVsLCB0ZXh0LCBmYWlsZWQsIGMudGFza0lkLCBvcmlnaW5TZXNzaW9uKTtcbiAgICBub3RpZnkoYCR7YWdlbnQgPT09IFwidDNcIiA/IFwiVDNcIiA6IFwiSGVybWVzXCJ9IFx1MDBCNyAke2MubGFiZWx9YCwgdGV4dCk7XG4gICAgaWYgKCFmYWlsZWQpIHsgcmVtZW1iZXIoXCJhc3Npc3RhbnRcIiwgdGV4dCwgYCR7YWdlbnQgPT09IFwidDNcIiA/IFwiVDNcIiA6IFwiSGVybWVzXCJ9IFx1MDBCNyAke2MubGFiZWx9YCk7IGxhc3RMaW5lID0gbnVsbDsgfVxuICAgIGlmICh2aWV3KSB7IHZpZXcucmVzdWx0SWQgPSByZXNJZDsgc2hvd1Rhc2tzKCk7IH1cbiAgICBwdXNoKHsgdHlwZTogXCJ0b29sLnJlc3VsdFwiLCBydW46IGMucnVuLCB0ZXh0LCBmYWlsZWQgfSk7XG4gIH07XG4gIGlmIChjaGVja2VkKFwiZmFrZWhlcm1lc1wiKSkge1xuICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiBkb25lKGAoRmFrZSAke2FnZW50ID09PSBcInQzXCIgPyBcIlQzXCIgOiBcIkhlcm1lc1wifSkgRG9uZTogXHUyMDFDJHtjLnJlcXVlc3R9XHUyMDFELiBOb3RoaW5nIHdhcyBhY3R1YWxseSBydW4uYCksIE51bWJlcigkPEhUTUxJbnB1dEVsZW1lbnQ+KFwiZmFrZWRlbGF5XCIpLnZhbHVlKSAqIDEwMDApO1xuICAgIGFib3J0LnNpZ25hbC5vbmFib3J0ID0gKCkgPT4gY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICByZXR1cm47XG4gIH1cbiAgdHJ5IHtcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKGFnZW50ID09PSBcInQzXCIgPyBcIi9hZ2VudFwiIDogXCIvaGVybWVzXCIsIHtcbiAgICAgIG1ldGhvZDogXCJQT1NUXCIsIHNpZ25hbDogYWJvcnQuc2lnbmFsLCBoZWFkZXJzOiB7IFwiY29udGVudC10eXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGNhbGw6IGNhbGxOYW1lLCB0YXNrSWQ6IGMudGFza0lkLCBmb2xsb3dVcDogYy5mb2xsb3dVcCwgbWVzc2FnZTogYy5tZXNzYWdlLCBsYWJlbDogYy5sYWJlbCwgcmVxdWVzdDogYy5yZXF1ZXN0LCBwcm9qZWN0OiBjLnByb2plY3QsIGFwcHJvdmFsczogXCJzY3JlZW5cIiB9KSxcbiAgICB9KTtcbiAgICBpZiAoIXJlc3BvbnNlLm9rIHx8ICFyZXNwb25zZS5ib2R5KSB0aHJvdyBuZXcgRXJyb3IoYEhUVFAgJHtyZXNwb25zZS5zdGF0dXN9YCk7XG4gICAgY29uc3QgcmVhZGVyID0gcmVzcG9uc2UuYm9keS5waXBlVGhyb3VnaChuZXcgVGV4dERlY29kZXJTdHJlYW0oKSkuZ2V0UmVhZGVyKCk7XG4gICAgbGV0IGJ1ZmZlciA9IFwiXCI7XG4gICAgZm9yICg7Oykge1xuICAgICAgY29uc3QgeyB2YWx1ZSwgZG9uZTogZmluaXNoZWQgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICBpZiAoZmluaXNoZWQpIGJyZWFrO1xuICAgICAgYnVmZmVyICs9IHZhbHVlO1xuICAgICAgbGV0IGN1dDtcbiAgICAgIHdoaWxlICgoY3V0ID0gYnVmZmVyLmluZGV4T2YoXCJcXG5cXG5cIikpID49IDApIHtcbiAgICAgICAgY29uc3QgYmxvY2sgPSBidWZmZXIuc2xpY2UoMCwgY3V0KTtcbiAgICAgICAgYnVmZmVyID0gYnVmZmVyLnNsaWNlKGN1dCArIDIpO1xuICAgICAgICBjb25zdCBldmVudCA9IGJsb2NrLm1hdGNoKC9eZXZlbnQ6ICguKikkL20pPy5bMV07XG4gICAgICAgIGlmICghZXZlbnQpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCBkYXRhID0gSlNPTi5wYXJzZShibG9jay5tYXRjaCgvXmRhdGE6ICguKikkL20pPy5bMV0gPz8gXCJ7fVwiKTtcbiAgICAgICAgaWYgKGV2ZW50ID09PSBcInByb2dyZXNzXCIpIHB1c2goeyB0eXBlOiBcInRhc2sucHJvZ3Jlc3NcIiwgdGFzazogYy50YXNrSWQsIHRleHQ6IGRhdGEudGV4dCB9KTtcbiAgICAgICAgZWxzZSBpZiAoZXZlbnQgPT09IFwidGhyZWFkXCIpIHsgY29uc3QgdmlldyA9IHRhc2tzLmdldChjLnRhc2tJZCk7IGlmICh2aWV3KSB7IHZpZXcudGhyZWFkID0gZGF0YS50aHJlYWQ7IHNob3dUYXNrcygpOyB9IH1cbiAgICAgICAgZWxzZSBpZiAoZXZlbnQgPT09IFwiYXBwcm92YWxcIikge1xuICAgICAgICAgIGNvbnN0IHZpZXcgPSB0YXNrcy5nZXQoYy50YXNrSWQpO1xuICAgICAgICAgIGlmICh2aWV3KSB7IHZpZXcuYXBwcm92YWwgPSB7IGNvbW1hbmQ6IGRhdGEuY29tbWFuZCB9OyBzaG93VGFza3ModHJ1ZSk7IH1cbiAgICAgICAgICB0b2FzdChgSGVybWVzIGFza3MgdG8gcnVuOiAke2RhdGEuY29tbWFuZC5zbGljZSgwLCA4MCl9YCk7XG4gICAgICAgICAgbm90aWZ5KGBIZXJtZXMgXHUwMEI3ICR7Yy5sYWJlbH0gbmVlZHMgeW91ciBhcHByb3ZhbGAsIGRhdGEuY29tbWFuZCk7XG4gICAgICAgICAgYXVkaW8uY3VlKEFQUFJPVkFMX1RPTkUpO1xuICAgICAgICB9XG4gICAgICAgIGVsc2UgaWYgKGV2ZW50ID09PSBcInJlc3VsdFwiKSBkb25lKGRhdGEudGV4dCwgZGF0YS5mYWlsZWQpO1xuICAgICAgICBlbHNlIGlmIChldmVudCA9PT0gXCJlcnJvclwiKSB7IHJ1bnMuZGVsZXRlKGMucnVuKTsgcHVzaCh7IHR5cGU6IFwidG9vbC5lcnJvclwiLCBydW46IGMucnVuLCBtZXNzYWdlOiBkYXRhLm1lc3NhZ2UgfSk7IH1cbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKHJ1bnMuaGFzKGMucnVuKSkgeyBydW5zLmRlbGV0ZShjLnJ1bik7IHB1c2goeyB0eXBlOiBcInRvb2wuZXJyb3JcIiwgcnVuOiBjLnJ1biwgbWVzc2FnZTogXCJ0aGUgc2VydmVyIGNsb3NlZCB0aGUgc3RyZWFtIHdpdGhvdXQgYSByZXN1bHRcIiB9KTsgfVxuICB9IGNhdGNoIChlcnIpIHtcbiAgICBpZiAoIWFib3J0LnNpZ25hbC5hYm9ydGVkICYmIHJ1bnMuaGFzKGMucnVuKSkgeyBydW5zLmRlbGV0ZShjLnJ1bik7IHB1c2goeyB0eXBlOiBcInRvb2wuZXJyb3JcIiwgcnVuOiBjLnJ1biwgbWVzc2FnZTogKGVyciBhcyBFcnJvcikubWVzc2FnZSB9KTsgfVxuICB9XG59XG5cbmZ1bmN0aW9uIG1pY09wdGlvbnMoKSB7XG4gIGNvbnN0IGFlYyA9IGNoZWNrZWQoXCJhZWNcIik7XG4gIHJldHVybiB7IGVjaG9DYW5jZWxsYXRpb246IGFlYywgbm9pc2VTdXBwcmVzc2lvbjogYWVjLCBhdXRvR2FpbkNvbnRyb2w6IGFlYyB9O1xufVxuXG5mdW5jdGlvbiBudW1iZXJTZXR0aW5nKGlkOiBzdHJpbmcsIGZhbGxiYWNrOiBudW1iZXIsIG1pbiA9IDAsIG1heCA9IDM2MDApOiBudW1iZXIge1xuICBjb25zdCBuID0gTnVtYmVyKCQ8SFRNTElucHV0RWxlbWVudD4oaWQpLnZhbHVlKTtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShuKSA/IE1hdGgubWF4KG1pbiwgTWF0aC5taW4obWF4LCBuKSkgOiBmYWxsYmFjaztcbn1cblxuZnVuY3Rpb24gZGV2ZWxvcGVyT3ZlcnJpZGVzKCkge1xuICB0cnkge1xuICAgIGNvbnN0IGdpdmVuID0gSlNPTi5wYXJzZSgkPEhUTUxUZXh0QXJlYUVsZW1lbnQ+KFwiY29uZmlnXCIpLnZhbHVlKTtcbiAgICBpZiAoIWdpdmVuIHx8IHR5cGVvZiBnaXZlbiAhPT0gXCJvYmplY3RcIikge1xuICAgICAgcmV0dXJuIHsgbm9uV2ViUGxhdGZvcm06IG51bGwgYXMgc3RyaW5nIHwgbnVsbCwgaGFzQXR0ZW50aW9uOiBmYWxzZSwgaGFzSGFuZ1VwOiBmYWxzZSwgaGFzU3RhbmRieTogZmFsc2UsIGhhc01pY1doaWxlU3BlYWtpbmc6IGZhbHNlIH07XG4gICAgfVxuICAgIGNvbnN0IG5vbldlYlBsYXRmb3JtID0gdHlwZW9mIGdpdmVuLnBsYXRmb3JtID09PSBcInN0cmluZ1wiICYmIGdpdmVuLnBsYXRmb3JtICE9PSBcIndlYlwiID8gZ2l2ZW4ucGxhdGZvcm0gOiBudWxsO1xuICAgIGNvbnN0IG1pYyA9IGdpdmVuLm1pYyAmJiB0eXBlb2YgZ2l2ZW4ubWljID09PSBcIm9iamVjdFwiID8gZ2l2ZW4ubWljIDogbnVsbDtcbiAgICByZXR1cm4ge1xuICAgICAgbm9uV2ViUGxhdGZvcm0sXG4gICAgICBoYXNBdHRlbnRpb246IGdpdmVuLmF0dGVudGlvbiAhPT0gdW5kZWZpbmVkLFxuICAgICAgaGFzSGFuZ1VwOiBnaXZlbi5oYW5nVXBBZnRlciAhPT0gdW5kZWZpbmVkLFxuICAgICAgaGFzU3RhbmRieTogZ2l2ZW4uc3RhbmRieUFmdGVyICE9PSB1bmRlZmluZWQsXG4gICAgICBoYXNNaWNXaGlsZVNwZWFraW5nOiBtaWMgIT0gbnVsbCAmJiBtaWMud2hpbGVTcGVha2luZyAhPT0gdW5kZWZpbmVkLFxuICAgIH07XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiB7IG5vbldlYlBsYXRmb3JtOiBudWxsIGFzIHN0cmluZyB8IG51bGwsIGhhc0F0dGVudGlvbjogZmFsc2UsIGhhc0hhbmdVcDogZmFsc2UsIGhhc1N0YW5kYnk6IGZhbHNlLCBoYXNNaWNXaGlsZVNwZWFraW5nOiBmYWxzZSB9O1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlYWRDb25maWcoKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICBjb25zdCBnaXZlbiA9IEpTT04ucGFyc2UoJDxIVE1MVGV4dEFyZWFFbGVtZW50PihcImNvbmZpZ1wiKS52YWx1ZSk7XG4gIGNvbnN0IGNvbmZpZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgbW9kZWw6IHNlcnZlci5tb2RlbCwgYXBpOiBzZXJ2ZXIucm91dGUgPT09IFwidmVydGV4XCIgPyBcInZlcnRleFwiIDogXCJnZW1pbmlcIiwgdG9kYXk6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKS5zbGljZSgwLCAxMCksXG4gICAgLi4uZ2l2ZW4sIHRyYWNlOiBjaGVja2VkKFwidHJhY2VcIiksXG4gIH07XG4gIGlmIChjaGVja2VkKFwicHR0XCIpKSBjb25maWcubXV0ZWQgPSB0cnVlO1xuICBpZiAoZ2l2ZW4udm9pY2UgPT09IHVuZGVmaW5lZCkgY29uZmlnLnZvaWNlID0gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJ2b2ljZVwiKS52YWx1ZTtcbiAgaWYgKGNvbmZpZy5zdGVlcmluZyA9PT0gdW5kZWZpbmVkKSBjb25maWcuc3RlZXJpbmcgPSBbXCJoZXJtZXNcIiwgXCJ0M1wiXTtcbiAgLy8gQSB3ZWIgY29uZmlnIHNhdmVkIGJlZm9yZSBoYW5kLW9mZnMgd2VyZSBuYW1lZCBpbiB3b3JkcyBnZXRzIHRoYXQgdG9vLlxuICBpZiAoY29uZmlnLmhhbmRPZmYgPT09IHVuZGVmaW5lZCAmJiBjb25maWcucGxhdGZvcm0gPT09IFwid2ViXCIpIGNvbmZpZy5oYW5kT2ZmID0gXCJuYW1lZFwiO1xuICAvLyBBbmQgb25lIHNhdmVkIGJlZm9yZSB0aGUgcGFnZSBmb2xsb3dlZCB0aGUgdXNlcidzIGxlYWQgKHN1cGVydmlzZSkgZ2V0cyB0aGF0LlxuICBpZiAoY29uZmlnLnN1cGVydmlzZSA9PT0gdW5kZWZpbmVkICYmIGNvbmZpZy5wbGF0Zm9ybSA9PT0gXCJ3ZWJcIikgY29uZmlnLnN1cGVydmlzZSA9IHRydWU7XG4gIGlmIChjaGVja2VkKFwiY29kaW5nXCIpICYmIChzZXJ2ZXIudDMgfHwgY2hlY2tlZChcImZha2VoZXJtZXNcIikpICYmIGNvbmZpZy5jb2RpbmdBZ2VudCA9PT0gdW5kZWZpbmVkKSBjb25maWcuY29kaW5nQWdlbnQgPSB7IHByb2plY3RzOiBzZXJ2ZXIudDMgPz8gW10gfTtcbiAgaWYgKGNoZWNrZWQoXCJjYXB0aW9uc1wiKSAmJiBzZXJ2ZXIuY2FwdGlvbnNNb2RlbCAmJiBjb25maWcuY2FwdGlvbnMgPT09IHVuZGVmaW5lZCkgY29uZmlnLmNhcHRpb25zID0geyBtb2RlbDogc2VydmVyLmNhcHRpb25zTW9kZWwgfTtcbiAgLy8gQXBwbHkgZWFjaCBTZXR0aW5ncyBzaWduYWxpbmcgZmllbGQgaW5kZXBlbmRlbnRseSBmb3Igd2ViIGNvbmZpZ3MgdW5sZXNzIHNldCBpbiBEZXZlbG9wZXIgSlNPTiAvIHByZXNldC5cbiAgY29uc3Qgbm9uV2ViID0gdHlwZW9mIGdpdmVuLnBsYXRmb3JtID09PSBcInN0cmluZ1wiICYmIGdpdmVuLnBsYXRmb3JtICE9PSBcIndlYlwiO1xuICBpZiAoIW5vbldlYikge1xuICAgIGNvbnN0IHNpZ25hbGluZyA9ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwic2lnbmFsaW5nXCIpLnZhbHVlO1xuICAgIGlmIChnaXZlbi5hdHRlbnRpb24gPT09IHVuZGVmaW5lZCAmJiAoc2lnbmFsaW5nID09PSBcIndpbmRvd1wiIHx8IHNpZ25hbGluZyA9PT0gXCJlY2hvXCIpKSB7XG4gICAgICBjb25maWcuYXR0ZW50aW9uID0ge1xuICAgICAgICBtb2RlOiBcIndpbmRvd1wiLFxuICAgICAgICBhZnRlcldha2U6IG51bWJlclNldHRpbmcoXCJhdHRuLWFmdGVyLXdha2VcIiwgOCwgMSwgNjApLFxuICAgICAgICB3aW5kb3c6IG51bWJlclNldHRpbmcoXCJhdHRuLXdpbmRvd1wiLCA1LCAwLCA2MCksXG4gICAgICAgIGFmdGVyUXVlc3Rpb246IG51bWJlclNldHRpbmcoXCJhdHRuLWFmdGVyLXF1ZXN0aW9uXCIsIDEwLCAwLCA2MCksXG4gICAgICAgIGFmdGVySGFuZE9mZjogMyxcbiAgICAgICAgYWZ0ZXJBbm5vdW5jZW1lbnQ6IDAsXG4gICAgICB9O1xuICAgIH1cbiAgICBpZiAoZ2l2ZW4uaGFuZ1VwQWZ0ZXIgPT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uZmlnLmhhbmdVcEFmdGVyID0gbnVtYmVyU2V0dGluZyhcImhhbmd1cC1hZnRlclwiLCBzaWduYWxpbmcgPT09IFwiZWNob1wiID8gMTUgOiAzMDAsIDAsIDM2MDApO1xuICAgIH1cbiAgICBpZiAoc2lnbmFsaW5nID09PSBcImVjaG9cIiAmJiBnaXZlbi5zdGFuZGJ5QWZ0ZXIgPT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uZmlnLnN0YW5kYnlBZnRlciA9IDg7XG4gICAgfVxuICAgIGNvbnN0IGdpdmVuTWljID0gZ2l2ZW4ubWljICYmIHR5cGVvZiBnaXZlbi5taWMgPT09IFwib2JqZWN0XCIgPyAoZ2l2ZW4ubWljIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA6IG51bGw7XG4gICAgaWYgKCghZ2l2ZW5NaWMgfHwgZ2l2ZW5NaWMud2hpbGVTcGVha2luZyA9PT0gdW5kZWZpbmVkKSAmJiAoY2hlY2tlZChcIndha2UtYmFyZ2VcIikgfHwgc2lnbmFsaW5nID09PSBcImVjaG9cIikpIHtcbiAgICAgIGNvbmZpZy5taWMgPSB7IGdhaW5EYjogMCwgLi4uKGdpdmVuTWljID8/IHt9KSwgd2hpbGVTcGVha2luZzogXCJ3YWtlXCIgfTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGNvbmZpZztcbn1cblxuLyoqIFN0YXJ0cyBhIHZvaWNlIGNhbGwsIG9yIHdpdGggW3R5cGVkXSBhIGNoYXQgKHRoZSBjb3JlJ3MgbWVkaXVtIFwidGV4dFwiOiBubyBhdWRpbywgYSB0ZXh0IG1vZGVsKS4gKi9cbmFzeW5jIGZ1bmN0aW9uIHN0YXJ0KGNhcnJ5T24gPSBmYWxzZSwgdHlwZWQgPSBmYWxzZSk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBpZiAoc3RhcnRpbmdDYWxsIHx8IGNhbGxJZCkgcmV0dXJuIGZhbHNlO1xuICBzdGFydGluZ0NhbGwgPSB0cnVlO1xuICB0cnkge1xuICAgIGF3YWl0IGVuZGluZztcbiAgICBpZiAoY2FsbElkKSByZXR1cm4gZmFsc2U7XG4gICAgbGV0IGdpdmVuOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICB0cnkge1xuICAgICAgZ2l2ZW4gPSByZWFkQ29uZmlnKCk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICB0b2FzdChgVGhlIGRldmVsb3BlciBzZXR0aW5ncyBhcmVuJ3QgdmFsaWQgSlNPTjogJHsoZXJyIGFzIEVycm9yKS5tZXNzYWdlfWApO1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICBpZiAodHlwZWQpIHtcbiAgICAgIGlmICghc2VydmVyLnRleHRNb2RlbCkgeyB0b2FzdChcIlRoaXMgc2VydmVyIGhhcyBubyB0ZXh0IG1vZGVsIGZvciBhIGNoYXQ6IHN0YXJ0IGEgY2FsbCB0byB0eXBlIHRvIGl0XCIpOyByZXR1cm4gZmFsc2U7IH1cbiAgICAgIGdpdmVuID0geyAuLi5naXZlbiwgbWVkaXVtOiBcInRleHRcIiwgbXV0ZWQ6IGZhbHNlIH07XG4gICAgICBkZWxldGUgZ2l2ZW4uY2FwdGlvbnM7XG4gICAgfVxuICAgICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiY2FsbFwiKS5kaXNhYmxlZCA9IHRydWU7XG4gICAgJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJoZXJvLWNhbGxcIikuZGlzYWJsZWQgPSB0cnVlO1xuICAgIGlmIChcIk5vdGlmaWNhdGlvblwiIGluIHdpbmRvdyAmJiBOb3RpZmljYXRpb24ucGVybWlzc2lvbiA9PT0gXCJkZWZhdWx0XCIpIHZvaWQgTm90aWZpY2F0aW9uLnJlcXVlc3RQZXJtaXNzaW9uKCkuY2F0Y2goKCkgPT4ge30pO1xuICAgIGxldCBsb2FkZWRDb3JlOiBDb3JlO1xuICAgIHRyeSB7XG4gICAgICBpZiAoIXR5cGVkKSBhd2FpdCBhdWRpby5vcGVuKCk7XG4gICAgICBsb2FkZWRDb3JlID0gYXdhaXQgbG9hZENvcmUoKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJjYWxsXCIpLmRpc2FibGVkID0gZmFsc2U7XG4gICAgICAkPEhUTUxCdXR0b25FbGVtZW50PihcImhlcm8tY2FsbFwiKS5kaXNhYmxlZCA9IGZhbHNlO1xuICAgIH1cbiAgICBpZiAoY2FsbElkKSByZXR1cm4gZmFsc2U7XG4gICAgY29yZSA9IGxvYWRlZENvcmU7XG4gICAgaWYgKHR5cGVkKSB7XG4gICAgICB3YWtlU3RhcnRpbmcgPSBmYWxzZTtcbiAgICAgIG9wZW5pbmdDaHVua3MgPSBbXTtcbiAgICAgIG9wZW5pbmdCeXRlcyA9IDA7XG4gICAgICBpZiAod2FrZUFybWVkKSBhdWRpby5zdG9wTWljKCk7XG4gICAgfVxuICAgIG1lZGl1bSA9IHR5cGVkID8gXCJ0ZXh0XCIgOiBcInZvaWNlXCI7XG4gICAgdGhpbmtpbmcgPSBmYWxzZTtcbiAgICAkKFwidmVyc2lvblwiKS50ZXh0Q29udGVudCA9IGNvcmUudmVyc2lvbjtcbiAgICAkKFwibG9nXCIpLmlubmVySFRNTCA9IFwiXCI7XG4gICAgaWYgKCF0eXBlZCAmJiAodGFza3Muc2l6ZSA+IDAgfHwgJChcInRyYW5zY3JpcHRcIikuY2hpbGRFbGVtZW50Q291bnQgPiAxKSkgbm90ZShgTmV3IGNhbGwgXHUwMEI3ICR7bmV3IERhdGUoKS50b0xvY2FsZVRpbWVTdHJpbmcoKX1gKTtcbiAgICBzY3JvbGxEb3duKHRydWUpO1xuICAgIHRhc2tzLmNsZWFyKCk7XG4gICAgYWN0aXZlU2Vzc2lvbiA9ICsrc2Vzc2lvblNlcTtcbiAgICBzaG93VGFza3MoKTtcbiAgICBjb3VudHMgPSB7IG1pYzogMCwgcGxheTogMCwgc2VudDogMCB9O1xuICAgIG1ldHJpY3MucmVwbHkgPSBbXTtcbiAgICBzdGFydGVkQXQgPSBub3coKTtcbiAgICBtdXRlZCA9IGdpdmVuLm11dGVkID09PSB0cnVlO1xuICAgIGNvbnN0IG1pY0NmZyA9IGdpdmVuLm1pYyAmJiB0eXBlb2YgZ2l2ZW4ubWljID09PSBcIm9iamVjdFwiID8gKGdpdmVuLm1pYyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgOiBudWxsO1xuICAgIHdha2VHYXRlLnJlc2V0KHR5cGVvZiBtaWNDZmc/LndoaWxlU3BlYWtpbmcgPT09IFwic3RyaW5nXCIgPyBtaWNDZmcud2hpbGVTcGVha2luZyA6IFwic2VuZFwiLCB3YWtlQ2xpZW50Lmxhc3RTZXEpO1xuICAgIHdha2VQZXJpb2RDYWxsSWQgPSBudWxsO1xuICAgIHdha2VDbGllbnQucmVzZXQoKTtcbiAgICAvLyBDYXJyeWluZyBvbjogdGhlIG1vZGVsIGdldHMgdGhlIGxhc3QgY29udmVyc2F0aW9uIGFzIGEgcmVjYXAuIFRoZSBjb3JlIGNhcHMgaXQsIGxhdGVzdCBsaW5lcyBmaXJzdC5cbiAgICAvLyBBIGNoYXQgYWx3YXlzIGNhcnJpZXMgb24gZnJvbSB3aGF0J3Mgb24gdGhlIHNjcmVlbiAoYW4gZWFybGllciBjYWxsIG9yIGNoYXQgb24gdGhpcyBwYWdlKS5cbiAgICBpZiAodHlwZWQpIHsgaWYgKGNoYXQubGVuZ3RoID4gMCAmJiBnaXZlbi5oaXN0b3J5ID09PSB1bmRlZmluZWQpIGdpdmVuLmhpc3RvcnkgPSBjaGF0OyB9XG4gICAgZWxzZSBpZiAoY2FycnlPbiAmJiBnaXZlbi5oaXN0b3J5ID09PSB1bmRlZmluZWQpIGdpdmVuLmhpc3RvcnkgPSBzYXZlZEhpc3RvcnkoKTtcbiAgICBlbHNlIGlmICghY2FycnlPbikgY2hhdCA9IFtdO1xuICAgIGlmIChjYXJyeU9uICYmICF0eXBlZCkgY2hhdCA9IHNhdmVkSGlzdG9yeSgpO1xuICAgIGxhc3RMaW5lID0gbnVsbDtcbiAgICBvcGVuTGluZSA9IG51bGw7XG4gICAgc3luY1Jlc3VtZUJ1dHRvbnMoZmFsc2UpO1xuICAgIGNhbGxOYW1lID0gYCR7bmV3IERhdGUoKS50b0lTT1N0cmluZygpLnJlcGxhY2UoL1s6Ll0vZywgXCItXCIpfS0ke3R5cGVkID8gXCJjaGF0XCIgOiBcIndlYlwifS0ke2NvcmUudmVyc2lvbn1gO1xuICAgIGNvbnN0IGNyZWF0ZWQgPSBKU09OLnBhcnNlKGNvcmUuY3JlYXRlKEpTT04uc3RyaW5naWZ5KGdpdmVuKSwgbm93KCkpKTtcbiAgICBjYWxsSWQgPSBjcmVhdGVkLmlkO1xuICAgIGlmICghdHlwZWQpIHtcbiAgICAgIHNldENhbGxCdXR0b24odHJ1ZSk7XG4gICAgICAkPEhUTUxCdXR0b25FbGVtZW50PihcIm1pY1wiKS5kaXNhYmxlZCA9IGZhbHNlO1xuICAgIH1cbiAgICAkPEhUTUxCdXR0b25FbGVtZW50PihcImh1c2hcIikuZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAkKFwibWljXCIpLmNsYXNzTGlzdC50b2dnbGUoXCJtdXRlZFwiLCBtdXRlZCk7XG4gICAgcnVuKGNyZWF0ZWQuY29tbWFuZHMpO1xuICAgIHNob3dTdGF0dXMoKTtcbiAgICB0aWNrZXIgPSB3aW5kb3cuc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgICAgcHVzaCh7IHR5cGU6IFwidGlja1wiIH0pO1xuICAgICAgY29uc3QgbGV2ZWwgPSBtdXRlZCAmJiAhaG9sZGluZyA/IDAgOiBhdWRpby5sZXZlbDtcbiAgICAgIGNvbnN0IHN0cmVuZ3RoID0gTWF0aC5taW4oMSwgbGV2ZWwgKiAxMik7XG4gICAgICAkKFwicmluZ1wiKS5zdHlsZS5vcGFjaXR5ID0gU3RyaW5nKHN0cmVuZ3RoKTtcbiAgICAgICQoXCJyaW5nXCIpLnN0eWxlLnRyYW5zZm9ybSA9IGBzY2FsZSgkeygxICsgc3RyZW5ndGggKiAwLjEyKS50b0ZpeGVkKDMpfSlgO1xuICAgICAgJChcImNvdW50c1wiKS50ZXh0Q29udGVudCA9IGBtaWMgJHtjb3VudHMubWljfSBcdTAwQjcgc2VudCAke2NvdW50cy5zZW50fSBcdTAwQjcgcGxheWVkICR7Y291bnRzLnBsYXl9IFx1MDBCNyBxdWV1ZWQgJHthdWRpby5xdWV1ZWQudG9GaXhlZCgxKX0gc2A7XG4gICAgICBzaG93U3RhdHVzKCk7XG4gICAgfSwgMTAwKTtcbiAgICB0cmFjZVRpbWVyID0gd2luZG93LnNldEludGVydmFsKCgpID0+IHsgdm9pZCBzYXZlVHJhY2UoKTsgdm9pZCBwaW5nKCk7IHNob3dUYXNrcygpOyB9LCA1MDAwKTtcbiAgICB2b2lkIHBpbmcoKTtcbiAgICBpZiAoIXR5cGVkKSB7XG4gICAgICBzdG9wV29yZHMuc3RhcnQoKTtcbiAgICAgIGF3YWl0IGFjcXVpcmVXYWtlTG9jaygpO1xuICAgIH1cbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSBmaW5hbGx5IHtcbiAgICBzdGFydGluZ0NhbGwgPSBmYWxzZTtcbiAgfVxufVxuXG4vKiogVGhlIENhbGwgYnV0dG9uOiBoYW5ncyB1cCBhIGNhbGw7IHN0YXJ0cyBvbmU7IG9yLCB3aXRoIGEgY2hhdCBvbiwgZW5kcyB0aGUgY2hhdCBhbmQgY2FycmllcyBpdHMgY29udmVyc2F0aW9uIG9uIGJ5IHZvaWNlLiAqL1xuYXN5bmMgZnVuY3Rpb24gY2FsbEJ1dHRvbigpIHtcbiAgaWYgKGNhbGxJZCAmJiBtZWRpdW0gPT09IFwidm9pY2VcIikgeyBoYW5nVXAoKTsgcmV0dXJuOyB9XG4gIGlmIChjYWxsSWQpIHtcbiAgICAvLyBBIGNhbGwgY2FuJ3QgdGFrZSBvdmVyIHRoZSBjaGF0J3MgdGFza3MsIGFuZCBlbmRpbmcgdGhlIGNoYXQgd291bGQgc3RvcCB0aGVtLlxuICAgIGlmIChbLi4udGFza3MudmFsdWVzKCldLnNvbWUoKHYpID0+IHYuYy5zdGF0ZSA9PT0gXCJydW5uaW5nXCIpKSB7IHRvYXN0KFwiVGhlIGNoYXQncyB0YXNrcyBhcmUgc3RpbGwgcnVubmluZzogd2FpdCBmb3IgdGhlbSBvciBjYW5jZWwgdGhlbSwgdGhlbiBjYWxsXCIpOyByZXR1cm47IH1cbiAgICBwdXNoKHsgdHlwZTogXCJzdG9wXCIgfSk7XG4gICAgYXdhaXQgc3RhcnQodHJ1ZSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGF3YWl0IHN0YXJ0KCk7XG59XG5cbmZ1bmN0aW9uIGhhbmdVcCgpIHtcbiAgaWYgKGNhbGxJZCkgcHVzaCh7IHR5cGU6IFwic3RvcFwiLCBtZXNzYWdlOiBcIllvdSBodW5nIHVwLlwiIH0pO1xufVxuXG5mdW5jdGlvbiBlbmQoKSB7XG4gIHdpbmRvdy5jbGVhckludGVydmFsKHRpY2tlcik7XG4gIHdpbmRvdy5jbGVhckludGVydmFsKHRyYWNlVGltZXIpO1xuICBzdG9wV29yZHMuc3RvcCgpO1xuICBhY3RpdmVTZXNzaW9uID0gMDtcbiAgc3luY1Jlc3VsdEZvbGxvd1VwQnV0dG9ucygpO1xuICBjb3JlV2FudHNXYWtlID0gZmFsc2U7XG4gIHdha2VHYXRlLnJlc2V0KFwic2VuZFwiLCB3YWtlQ2xpZW50Lmxhc3RTZXEpO1xuICB3YWtlUGVyaW9kQ2FsbElkID0gd2FrZUFybWVkID8gMCA6IG51bGw7XG4gIHdha2VTdGFydGluZyA9IGZhbHNlO1xuICBvcGVuaW5nQ2h1bmtzID0gW107XG4gIG9wZW5pbmdCeXRlcyA9IDA7XG4gIGNvbnN0IGZpbmlzaGVkSWQgPSBjYWxsSWQ7XG4gIGNvbnN0IGZpbmlzaGVkQ29yZSA9IGNvcmU7XG4gIGNhbGxJZCA9IDA7XG4gIGVuZGluZyA9IHNhdmVUcmFjZShmaW5pc2hlZElkLCBmaW5pc2hlZENvcmUpLnRoZW4oKCkgPT4geyBpZiAoZmluaXNoZWRDb3JlICYmIGZpbmlzaGVkSWQpIGZpbmlzaGVkQ29yZS5kaXNwb3NlKGZpbmlzaGVkSWQpOyBzaG93VGFza3MoKTsgc3luY1dha2VVaSgpOyB9KTtcbiAgaWYgKHdha2VBcm1lZCkge1xuICAgIGF1ZGlvLnN0b3BQbGF5YmFjaygpO1xuICAgIHdha2VDbGllbnQucmVzZXQoKTtcbiAgICB2b2lkIGF1ZGlvLmVuc3VyZU1pYyhvbk1pYywgbWljT3B0aW9ucygpKS5jYXRjaCgoZXJyKSA9PiB7XG4gICAgICBsb2coXCJlcnJvclwiLCBgd2FrZSBtaWNyb3Bob25lOiAke2Vyci5tZXNzYWdlfWAsIFwiZXJyXCIpO1xuICAgICAgdG9hc3QoYFdha2UgbWljcm9waG9uZTogJHtlcnIubWVzc2FnZX1gKTtcbiAgICAgIHZvaWQgYXJtV2FrZShmYWxzZSk7XG4gICAgfSk7XG4gIH0gZWxzZSB7XG4gICAgYXVkaW8uc3RvcCgpO1xuICAgIHJlbGVhc2VXYWtlTG9jaygpO1xuICB9XG4gIGZvciAoY29uc3Qgd3Mgb2Ygc29ja2V0cy52YWx1ZXMoKSkgd3MuY2xvc2UoKTtcbiAgc29ja2V0cy5jbGVhcigpO1xuICBmb3IgKGNvbnN0IHIgb2YgcnVucy52YWx1ZXMoKSkgci5hYm9ydC5hYm9ydCgpO1xuICBydW5zLmNsZWFyKCk7XG4gIGZvciAoY29uc3QgciBvZiByZXF1ZXN0cy52YWx1ZXMoKSkgci5hYm9ydCgpO1xuICByZXF1ZXN0cy5jbGVhcigpO1xuICB0aGlua2luZyA9IGZhbHNlO1xuICBzZXRDYWxsQnV0dG9uKGZhbHNlKTtcbiAgZm9yIChjb25zdCBpZCBvZiBbXCJtaWNcIiwgXCJodXNoXCJdKSAkPEhUTUxCdXR0b25FbGVtZW50PihpZCkuZGlzYWJsZWQgPSB0cnVlO1xuICAkKFwicmluZ1wiKS5zdHlsZS5vcGFjaXR5ID0gXCIwXCI7XG4gICQoXCJyaW5nXCIpLnN0eWxlLnRyYW5zZm9ybSA9IFwiXCI7XG4gICQoXCJjYWxsYmFyXCIpLmhpZGRlbiA9IHRydWU7XG4gICQoXCJtaWN3YXJuXCIpLmhpZGRlbiA9IHRydWU7XG4gIGRvY3VtZW50LmJvZHkuZGF0YXNldC5zdGF0ZSA9IHdha2VBcm1lZCA/IFwiYXJtZWRcIiA6IFwiaWRsZVwiO1xuICBkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5yZW1vdmUoXCJpbi1zZXNzaW9uXCIpO1xuICBzeW5jUmVzdW1lQnV0dG9ucyhjaGF0Lmxlbmd0aCA+IDApO1xuICB2b2lkIHNob3dFYXJsaWVyKCk7XG4gIHN5bmNXYWtlVWkoKTtcbn1cblxuZnVuY3Rpb24gc2V0TXV0ZWQodmFsdWU6IGJvb2xlYW4pIHtcbiAgaWYgKCFjYWxsSWQgfHwgbXV0ZWQgPT09IHZhbHVlKSByZXR1cm47XG4gIG11dGVkID0gdmFsdWU7XG4gIGlmIChtdXRlZCkge1xuICAgIGZsdXNoRGVmZXJyZWRNaWMoKTtcbiAgICB3YWtlQ2xpZW50LnJlc2V0KCk7XG4gIH1cbiAgJChcIm1pY1wiKS5jbGFzc0xpc3QudG9nZ2xlKFwibXV0ZWRcIiwgbXV0ZWQpO1xuICBwdXNoKHsgdHlwZTogbXV0ZWQgPyBcIm11dGVcIiA6IFwidW5tdXRlXCIgfSk7XG4gIHNob3dTdGF0dXMoKTtcbn1cblxuLyoqIFNlbmRzIHdoYXQgdGhlIHRyYWNlIGtlcHQgc2luY2UgbGFzdCB0aW1lIHRvIHRoZSBkZXYgc2VydmVyLCBhcyBKU09OIGxpbmVzOiBhIGhlYWRlciwgdGhlbiBldmVudHMuICovXG5hc3luYyBmdW5jdGlvbiBzYXZlVHJhY2UoaWQgPSBjYWxsSWQsIHRhcmdldENvcmUgPSBjb3JlKSB7XG4gIGlmICghdGFyZ2V0Q29yZSB8fCAhaWQgfHwgIWNoZWNrZWQoXCJ0cmFjZVwiKSkgcmV0dXJuO1xuICBjb25zdCBrZXB0ID0gSlNPTi5wYXJzZSh0YXJnZXRDb3JlLnRyYWNlKGlkKSk7XG4gIGlmICgha2VwdCkgcmV0dXJuO1xuICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcbiAgaWYgKGtlcHQuY29uZmlnKSBsaW5lcy5wdXNoKEpTT04uc3RyaW5naWZ5KHsgdmVyc2lvbjoga2VwdC52ZXJzaW9uLCBjb25maWc6IGtlcHQuY29uZmlnLCBzdGFydDoga2VwdC5zdGFydCB9KSk7XG4gIGZvciAoY29uc3QgZSBvZiBrZXB0LmV2ZW50cykgbGluZXMucHVzaChKU09OLnN0cmluZ2lmeShlKSk7XG4gIGlmIChsaW5lcy5sZW5ndGggPT09IDApIHJldHVybjtcbiAgYXdhaXQgZmV0Y2goYC90cmFjZXM/bmFtZT0ke2VuY29kZVVSSUNvbXBvbmVudChjYWxsTmFtZSl9Lmpzb25sYCwgeyBtZXRob2Q6IFwiUE9TVFwiLCBib2R5OiBsaW5lcy5qb2luKFwiXFxuXCIpICsgXCJcXG5cIiB9KS5jYXRjaCgoKSA9PiB7fSk7XG4gICQoXCJ0cmFjZW5hbWVcIikudGV4dENvbnRlbnQgPSBgdHJhY2UgJHtjYWxsTmFtZX0uanNvbmxgO1xufVxuXG4vLyBcIlN0b3BcIiBhbmQgXCJnb29kYnllXCIgaGVhcmQgYnkgdGhlIGJyb3dzZXIncyBvd24gcmVjb2duaXplcjogcXVpY2tlciB0aGFuIHRoZSBtb2RlbCdzIHRyYW5zY3JpcHQsXG4vLyBhbmQgaXQgd29ya3Mgd2hpbGUgdGhlIG1vZGVsJ3MgcmVwbHkgcGxheXMgZXZlbiB3aGVuIHRoZSBtb2RlbCBpc24ndCBoZWFyaW5nIHRoZSBtaWNyb3Bob25lLlxuXG5jbGFzcyBTdG9wV29yZHMge1xuICBwcml2YXRlIHJlYzogYW55ID0gbnVsbDtcbiAgcHJpdmF0ZSBvbiA9IGZhbHNlO1xuICBwcml2YXRlIGNvbW1hbmRzID0geyBzdG9wOiBbXSBhcyBzdHJpbmdbXSwgaGFuZ1VwOiBbXSBhcyBzdHJpbmdbXSwgY2FuY2VsQWxsOiBbXSBhcyBzdHJpbmdbXSB9O1xuXG4gIGdldCBzdXBwb3J0ZWQoKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIFwid2Via2l0U3BlZWNoUmVjb2duaXRpb25cIiBpbiB3aW5kb3cgfHwgXCJTcGVlY2hSZWNvZ25pdGlvblwiIGluIHdpbmRvdztcbiAgfVxuXG4gIHN0YXJ0KCkge1xuICAgIGlmICghY2hlY2tlZChcInN0b3B3b3JkXCIpIHx8ICF0aGlzLnN1cHBvcnRlZCB8fCAhY29yZSkgcmV0dXJuO1xuICAgIHRoaXMuY29tbWFuZHMgPSBKU09OLnBhcnNlKGNvcmUuZGVmYXVsdHMoKSkudm9pY2VDb21tYW5kcztcbiAgICBjb25zdCBSZWNvZ25pdGlvbiA9ICh3aW5kb3cgYXMgYW55KS5TcGVlY2hSZWNvZ25pdGlvbiA/PyAod2luZG93IGFzIGFueSkud2Via2l0U3BlZWNoUmVjb2duaXRpb247XG4gICAgdGhpcy5yZWMgPSBuZXcgUmVjb2duaXRpb24oKTtcbiAgICB0aGlzLnJlYy5jb250aW51b3VzID0gdHJ1ZTtcbiAgICB0aGlzLnJlYy5pbnRlcmltUmVzdWx0cyA9IHRydWU7XG4gICAgdGhpcy5yZWMubGFuZyA9IG5hdmlnYXRvci5sYW5ndWFnZSB8fCBcImVuLUdCXCI7XG4gICAgdGhpcy5yZWMub25yZXN1bHQgPSAoZTogYW55KSA9PiB7XG4gICAgICBmb3IgKGxldCBpID0gZS5yZXN1bHRJbmRleDsgaSA8IGUucmVzdWx0cy5sZW5ndGg7IGkrKykge1xuICAgICAgICBjb25zdCB0ZXh0ID0gZS5yZXN1bHRzW2ldWzBdLnRyYW5zY3JpcHQgYXMgc3RyaW5nO1xuICAgICAgICBjb25zdCBjb21tYW5kID0gY29tbWFuZEluKHRleHQsIHRoaXMuY29tbWFuZHMsIFtcIldvb2Rob3VzZVwiLCBcIkhlcm1lc1wiLCBcIkJlbnRvXCJdKTtcbiAgICAgICAgaWYgKGNvbW1hbmQgPT09IFwic3RvcFwiICYmIGF1ZGlvLnF1ZXVlZCA+IDAuMDUpIHtcbiAgICAgICAgICBsb2coXCJvdXRcIiwgYGxvY2FsIHN0b3Agd29yZDogJHt0ZXh0fWAsIFwib3V0XCIpO1xuICAgICAgICAgIHRvYXN0KGBIZWFyZCBcdTIwMUMke3RleHQudHJpbSgpfVx1MjAxRDogc3RvcHBlZGApO1xuICAgICAgICAgIHB1c2goeyB0eXBlOiBcImludGVycnVwdFwiIH0pO1xuICAgICAgICB9IGVsc2UgaWYgKGNvbW1hbmQgPT09IFwiY2FuY2VsQWxsXCIgJiYgZS5yZXN1bHRzW2ldLmlzRmluYWwpIHtcbiAgICAgICAgICBsb2coXCJvdXRcIiwgYGxvY2FsIGNhbmNlbC1hbGw6ICR7dGV4dH1gLCBcIm91dFwiKTtcbiAgICAgICAgICBwdXNoKHsgdHlwZTogXCJjYW5jZWxBbGxcIiB9KTtcbiAgICAgICAgICBwdXNoKHsgdHlwZTogXCJpbnRlcnJ1cHRcIiB9KTtcbiAgICAgICAgfSBlbHNlIGlmIChjb21tYW5kID09PSBcImhhbmdVcFwiICYmIGUucmVzdWx0c1tpXS5pc0ZpbmFsKSB7XG4gICAgICAgICAgbG9nKFwib3V0XCIsIGBsb2NhbCBoYW5nLXVwOiAke3RleHR9YCwgXCJvdXRcIik7XG4gICAgICAgICAgaGFuZ1VwKCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9O1xuICAgIHRoaXMucmVjLm9uZW5kID0gKCkgPT4geyBpZiAodGhpcy5vbikgc2V0VGltZW91dCgoKSA9PiB7IHRyeSB7IHRoaXMucmVjPy5zdGFydCgpOyB9IGNhdGNoIHt9IH0sIDI1MCk7IH07XG4gICAgdGhpcy5yZWMub25lcnJvciA9IChlOiBhbnkpID0+IHsgaWYgKGUuZXJyb3IgPT09IFwibm90LWFsbG93ZWRcIikgdGhpcy5vbiA9IGZhbHNlOyB9O1xuICAgIHRoaXMub24gPSB0cnVlO1xuICAgIHRyeSB7IHRoaXMucmVjLnN0YXJ0KCk7IH0gY2F0Y2gge31cbiAgfVxuXG4gIHN0b3AoKSB7XG4gICAgdGhpcy5vbiA9IGZhbHNlO1xuICAgIHRyeSB7IHRoaXMucmVjPy5zdG9wKCk7IH0gY2F0Y2gge31cbiAgICB0aGlzLnJlYyA9IG51bGw7XG4gIH1cbn1cbmNvbnN0IHN0b3BXb3JkcyA9IG5ldyBTdG9wV29yZHMoKTtcblxuLy8gTG9jYWwgd2FrZSB3b3JkIGxvb3AgKExpdmVLaXQgV2FrZVdvcmQgT05OWCBpbiBhIFdlYiBXb3JrZXIpOiBsaXN0ZW5zIGJldHdlZW4gY2FsbHMgd2hlbiBhcm1lZCxcbi8vIGFuZCBpbnNpZGUgYW4gYWN0aXZlIGNhbGwgd2hlbmV2ZXIgdGhlIGNvcmUgYXNrcyAoYHdha2V3b3JkOiBvbmA6IGRvcm1hbnQgb3Igd2hpbGVTcGVha2luZyBcIndha2VcIikuXG5cbmFzeW5jIGZ1bmN0aW9uIGFjcXVpcmVXYWtlTG9jaygpIHtcbiAgYXdhaXQgc2NyZWVuV2FrZUxvY2suYWNxdWlyZSgoKSA9PiAhZG9jdW1lbnQuaGlkZGVuICYmIChjYWxsSWQgIT09IDAgfHwgd2FrZUFybWVkKSk7XG59XG5cbmZ1bmN0aW9uIHJlbGVhc2VXYWtlTG9jaygpIHtcbiAgc2NyZWVuV2FrZUxvY2sucmVsZWFzZSgpO1xufVxuXG5mdW5jdGlvbiBzZWxlY3RlZFdha2VNb2RlbCgpOiBXYWtlTW9kZWxJbmZvIHwgbnVsbCB7XG4gIGNvbnN0IG1vZGVscyA9IHNlcnZlcj8ud2FrZU1vZGVscyA/PyBbXTtcbiAgaWYgKG1vZGVscy5sZW5ndGggPT09IDApIHJldHVybiBudWxsO1xuICBjb25zdCBwaWNrID0gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJ3YWtlLW1vZGVsXCIpLnZhbHVlO1xuICByZXR1cm4gbW9kZWxzLmZpbmQoKG0pID0+IG0uaWQgPT09IHBpY2spID8/IG1vZGVscy5maW5kKChtKSA9PiBtLmlkID09PSBcInBlbm55d29ydGhcIikgPz8gbW9kZWxzWzBdO1xufVxuXG5mdW5jdGlvbiB3YWtlVGhyZXNob2xkKCk6IG51bWJlciB7XG4gIGNvbnN0IG4gPSBOdW1iZXIoJDxIVE1MSW5wdXRFbGVtZW50PihcIndha2UtdGhyZXNob2xkXCIpLnZhbHVlKTtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShuKSA/IE1hdGgubWF4KDAuMSwgTWF0aC5taW4oMC45OSwgbikpIDogMC43O1xufVxuXG5mdW5jdGlvbiBzaG91bGRGZWVkV2FrZSgpOiBib29sZWFuIHtcbiAgaWYgKHdha2VTdGFydGluZyB8fCBzdGFydGluZ0NhbGwpIHJldHVybiBmYWxzZTtcbiAgaWYgKGNhbGxJZCA9PT0gMCkgcmV0dXJuIHdha2VBcm1lZDtcbiAgcmV0dXJuIG1lZGl1bSA9PT0gXCJ2b2ljZVwiICYmIGNvcmVXYW50c1dha2UgJiYgIShtdXRlZCAmJiAhaG9sZGluZyk7XG59XG5cbi8qKlxuICogV2hldGhlciBhIHdha2UgZGV0ZWN0aW9uIHJldHVybmluZyBhc3luY2hyb25vdXNseSBmcm9tIHRoZSB3b3JrZXIgc3RpbGwgYmVsb25ncyB0byB0aGUgYWN0aXZlXG4gKiBsaXN0ZW5pbmcgcGVyaW9kLiBVbmxpa2UgYHNob3VsZEZlZWRXYWtlKClgLCB0aGlzIHN0YXlzIHRydWUgZm9yIGFuIGFjdGl2ZSB2b2ljZSBjYWxsIGV2ZW4gaWZcbiAqIGBjb3JlV2FudHNXYWtlYCBqdXN0IGZsaXBwZWQgb2ZmIGFzIHBsYXliYWNrIGVuZGVkIHdoaWxlIHRoZSB3b3JrZXIgd2FzIHNjb3JpbmcgdGhlIGxhc3QgZnJhbWUuXG4gKi9cbmZ1bmN0aW9uIGNhbkFjY2VwdFdha2VIaXQoKTogYm9vbGVhbiB7XG4gIGlmICh3YWtlU3RhcnRpbmcgfHwgc3RhcnRpbmdDYWxsKSByZXR1cm4gZmFsc2U7XG4gIGlmIChjYWxsSWQgPT09IDApIHJldHVybiB3YWtlQXJtZWQgJiYgd2FrZVBlcmlvZENhbGxJZCA9PT0gMDtcbiAgcmV0dXJuIG1lZGl1bSA9PT0gXCJ2b2ljZVwiICYmICEobXV0ZWQgJiYgIWhvbGRpbmcpICYmIHdha2VQZXJpb2RDYWxsSWQgPT09IGNhbGxJZDtcbn1cblxuZnVuY3Rpb24gcmVuZGVyV2FrZVRlbGVtZXRyeSgpIHtcbiAgY29uc3QgYWN0aXZlID0gKGNhbGxJZCA9PT0gMCAmJiB3YWtlQXJtZWQpIHx8IChjYWxsSWQgIT09IDAgJiYgbWVkaXVtID09PSBcInZvaWNlXCIgJiYgY29yZVdhbnRzV2FrZSk7XG4gIGlmICghYWN0aXZlKSB7ICQoXCJoZWFyZFwiKS50ZXh0Q29udGVudCA9IFwiXCI7IHJldHVybjsgfVxuICBjb25zdCBsYWJlbCA9IHNlbGVjdGVkV2FrZU1vZGVsKCk/LmxhYmVsID8/IFwid2FrZSB3b3JkXCI7XG4gIGlmICh3YWtlTG9hZGluZykgeyAkKFwiaGVhcmRcIikudGV4dENvbnRlbnQgPSBgTG9hZGluZyB3YWtlIHdvcmQgXHUyMDFDJHtsYWJlbH1cdTIwMURcdTIwMjZgOyByZXR1cm47IH1cbiAgaWYgKGNhbGxJZCA9PT0gMCAmJiBhdWRpby5hdWRpb1N1c3BlbmRlZCkgeyAkKFwiaGVhcmRcIikudGV4dENvbnRlbnQgPSBgQXVkaW8gcGF1c2VkIGJ5IGJyb3dzZXIgXHUwMEI3IHRhcCBvciBwcmVzcyBhIGtleSB0byByZXN1bWUgXHUyMDFDJHtsYWJlbH1cdTIwMURgOyByZXR1cm47IH1cbiAgaWYgKCF3YWtlTGFzdFRlbCkgeyAkKFwiaGVhcmRcIikudGV4dENvbnRlbnQgPSBgV2FrZSBcdTIwMUMke2xhYmVsfVx1MjAxRCByZWFkeSAodGhyZXNob2xkICR7d2FrZVRocmVzaG9sZCgpLnRvRml4ZWQoMil9KWA7IHJldHVybjsgfVxuICBjb25zdCBzdGF0ZSA9IHdha2VMYXN0VGVsLmdhdGVPcGVuID8gYHNjb3JpbmcgJHt3YWtlTGFzdFRlbC5zY29yZS50b0ZpeGVkKDIpfWAgOiBcInF1aWV0XCI7XG4gIGNvbnN0IHNwZWVkID0gd2FrZUxhc3RUZWwuaW5mZXJNcyA+IDAgPyBgIFx1MDBCNyAke3dha2VMYXN0VGVsLmluZmVyTXMudG9GaXhlZCgxKX0gbXNgIDogXCJcIjtcbiAgJChcImhlYXJkXCIpLnRleHRDb250ZW50ID0gYFdha2UgXHUyMDFDJHtsYWJlbH1cdTIwMUQgXHUwMEI3ICR7c3RhdGV9IFx1MDBCNyBwZWFrICR7d2FrZUxhc3RUZWwucGVhay50b0ZpeGVkKDIpfSR7c3BlZWR9YDtcbn1cblxuZnVuY3Rpb24gc3luY1dha2VVaSgpIHtcbiAgY29uc3QgbW9kZWwgPSBzZWxlY3RlZFdha2VNb2RlbCgpO1xuICBjb25zdCBoYXNNb2RlbHMgPSBtb2RlbCAhPSBudWxsO1xuICBjb25zdCBsYWJlbCA9IG1vZGVsPy5sYWJlbCA/PyBcIndha2Ugd29yZFwiO1xuICBjb25zdCBidG4gPSAkPEhUTUxCdXR0b25FbGVtZW50PihcIndha2VidG5cIik7XG4gIGJ0bi5oaWRkZW4gPSAhaGFzTW9kZWxzO1xuICBidG4uY2xhc3NMaXN0LnRvZ2dsZShcIm9uXCIsIHdha2VBcm1lZCk7XG4gIGJ0bi5jbGFzc0xpc3QudG9nZ2xlKFwibG9hZGluZ1wiLCB3YWtlTG9hZGluZyAmJiAod2FrZUFybWVkIHx8IGNvcmVXYW50c1dha2UpKTtcbiAgYnRuLnNldEF0dHJpYnV0ZShcImFyaWEtcHJlc3NlZFwiLCBTdHJpbmcod2FrZUFybWVkKSk7XG4gIGJ0bi50aXRsZSA9IHdha2VBcm1lZCA/IGBTdG9wIHdha2Ugd29yZCBcdTIwMUMke2xhYmVsfVx1MjAxRCAoVylgIDogYExpc3RlbiBmb3IgXHUyMDFDJHtsYWJlbH1cdTIwMUQgKFcpYDtcbiAgY29uc3QgaGVybyA9ICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiaGVyby13YWtlXCIpO1xuICBoZXJvLmhpZGRlbiA9ICFoYXNNb2RlbHM7XG4gIGhlcm8uY2xhc3NMaXN0LnRvZ2dsZShcIm9uXCIsIHdha2VBcm1lZCk7XG4gIGhlcm8udGV4dENvbnRlbnQgPSB3YWtlQXJtZWRcbiAgICA/ICh3YWtlTG9hZGluZyA/IGBMb2FkaW5nIFx1MjAxQyR7bGFiZWx9XHUyMDFEXHUyMDI2YCA6IGF1ZGlvLmF1ZGlvU3VzcGVuZGVkID8gYEFjdGl2YXRlIFx1MjAxQyR7bGFiZWx9XHUyMDFEYCA6IGBMaXN0ZW5pbmcgZm9yIFx1MjAxQyR7bGFiZWx9XHUyMDFEYClcbiAgICA6IGBMaXN0ZW4gZm9yIFx1MjAxQyR7bGFiZWx9XHUyMDFEYDtcbiAgJDxIVE1MSW5wdXRFbGVtZW50PihcIndha2UtZW5hYmxlZFwiKS5jaGVja2VkID0gd2FrZUFybWVkO1xuICByZW5kZXJXYWtlVGVsZW1ldHJ5KCk7XG4gIHNob3dTdGF0dXMoKTtcbn1cblxuZnVuY3Rpb24gc3luY1NpZ25hbGluZ1VpKCkge1xuICBjb25zdCBvdiA9IGRldmVsb3Blck92ZXJyaWRlcygpO1xuICBjb25zdCBzaWduYWxpbmdFbCA9ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwic2lnbmFsaW5nXCIpO1xuICBjb25zdCBzaWduYWxpbmcgPSBzaWduYWxpbmdFbC52YWx1ZTtcbiAgY29uc3Qgbm9uV2ViID0gb3Yubm9uV2ViUGxhdGZvcm0gIT0gbnVsbDtcbiAgc2lnbmFsaW5nRWwuZGlzYWJsZWQgPSBub25XZWIgfHwgb3YuaGFzQXR0ZW50aW9uO1xuICBjb25zdCB3aW5kb3dDb250cm9scyA9ICFub25XZWIgJiYgIW92Lmhhc0F0dGVudGlvbiAmJiAoc2lnbmFsaW5nID09PSBcIndpbmRvd1wiIHx8IHNpZ25hbGluZyA9PT0gXCJlY2hvXCIpO1xuICBmb3IgKGNvbnN0IGlkIG9mIFtcImF0dG4tYWZ0ZXItd2FrZVwiLCBcImF0dG4td2luZG93XCIsIFwiYXR0bi1hZnRlci1xdWVzdGlvblwiXSkge1xuICAgICQ8SFRNTElucHV0RWxlbWVudD4oaWQpLmRpc2FibGVkID0gIXdpbmRvd0NvbnRyb2xzO1xuICB9XG4gICQ8SFRNTElucHV0RWxlbWVudD4oXCJoYW5ndXAtYWZ0ZXJcIikuZGlzYWJsZWQgPSBub25XZWIgfHwgb3YuaGFzSGFuZ1VwO1xuICBjb25zdCBiYXJnZSA9ICQ8SFRNTElucHV0RWxlbWVudD4oXCJ3YWtlLWJhcmdlXCIpO1xuICBpZiAobm9uV2ViIHx8IG92Lmhhc01pY1doaWxlU3BlYWtpbmcpIHtcbiAgICBiYXJnZS5kaXNhYmxlZCA9IHRydWU7XG4gIH0gZWxzZSBpZiAoc2lnbmFsaW5nID09PSBcImVjaG9cIikge1xuICAgIGJhcmdlLmNoZWNrZWQgPSB0cnVlO1xuICAgIGJhcmdlLmRpc2FibGVkID0gdHJ1ZTtcbiAgfSBlbHNlIHtcbiAgICBiYXJnZS5kaXNhYmxlZCA9IGZhbHNlO1xuICAgIGJhcmdlLmNoZWNrZWQgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLndha2UtYmFyZ2VcIikgPT09IFwiMVwiO1xuICB9XG4gIGNvbnN0IG92ZXJyaWRkZW46IHN0cmluZ1tdID0gW107XG4gIGlmIChvdi5oYXNBdHRlbnRpb24pIG92ZXJyaWRkZW4ucHVzaChcImF0dGVudGlvblwiKTtcbiAgaWYgKG92Lmhhc0hhbmdVcCkgb3ZlcnJpZGRlbi5wdXNoKFwiaGFuZ1VwQWZ0ZXJcIik7XG4gIGlmIChvdi5oYXNNaWNXaGlsZVNwZWFraW5nKSBvdmVycmlkZGVuLnB1c2goXCJtaWMud2hpbGVTcGVha2luZ1wiKTtcbiAgY29uc3QgaGFzTW9kZWxzID0gKHNlcnZlcj8ud2FrZU1vZGVscz8ubGVuZ3RoID8/IDApID4gMDtcbiAgJChcInNpZ25hbGluZy1oZWxwXCIpLnRleHRDb250ZW50ID0gbm9uV2ViXG4gICAgPyBgRGV2ZWxvcGVyIHByZXNldCAoJHtvdi5ub25XZWJQbGF0Zm9ybX0pIGNvbnRyb2xzIHNpZ25hbGluZy5gXG4gICAgOiBvdmVycmlkZGVuLmxlbmd0aCA+IDBcbiAgICAgID8gYERldmVsb3BlciBjb25maWcgc2V0cyAke292ZXJyaWRkZW4uam9pbihcIiwgXCIpfS5gXG4gICAgICA6ICFoYXNNb2RlbHMgJiYgc2lnbmFsaW5nICE9PSBcIm9wZW5cIlxuICAgICAgICA/IFwiTm8gd2FrZSBtb2RlbHMgb24gc2VydmVyOiB1c2UgdGhlIFdha2UgYnV0dG9uIHdoZW4gZG9ybWFudC5cIlxuICAgICAgICA6IFwiQXBwbGllZCBvbiB0aGUgbmV4dCBjYWxsIHVubGVzcyBvdmVycmlkZGVuIGluIERldmVsb3BlciBKU09OLlwiO1xufVxuXG5jb25zdCB3YWtlQ2xpZW50ID0gbmV3IFdha2VDbGllbnQoe1xuICBvblJlYWR5KG1vZGVsSWQsIHdhcm11cE1zKSB7XG4gICAgd2FrZUxvYWRpbmcgPSBmYWxzZTtcbiAgICBsb2coXCJvdXRcIiwgYHdha2Ugd29yZCByZWFkeTogJHttb2RlbElkfSR7d2FybXVwTXMgPiAwID8gYCAoJHt3YXJtdXBNc30gbXMpYCA6IFwiXCJ9YCwgXCJvdXRcIik7XG4gICAgc3luY1dha2VVaSgpO1xuICB9LFxuICBvbkRldGVjdGVkKGhpdCkge1xuICAgIG9uV2FrZURldGVjdGVkKGhpdCk7XG4gIH0sXG4gIG9uVGVsZW1ldHJ5KHRlbCkge1xuICAgIHdha2VMYXN0VGVsID0gdGVsO1xuICAgIHJlbmRlcldha2VUZWxlbWV0cnkoKTtcbiAgfSxcbiAgb25TdXBwcmVzc2VkU2V0dGxlZCgpIHtcbiAgICBmbHVzaERlZmVycmVkTWljKCk7XG4gIH0sXG4gIG9uRXJyb3IobWVzc2FnZSkge1xuICAgIHdha2VMb2FkaW5nID0gZmFsc2U7XG4gICAgZmx1c2hEZWZlcnJlZE1pYygpO1xuICAgIGxvZyhcImVycm9yXCIsIGB3YWtlIHdvcmQ6ICR7bWVzc2FnZX1gLCBcImVyclwiKTtcbiAgICB0b2FzdChgV2FrZSB3b3JkIGVycm9yOiAke21lc3NhZ2V9YCk7XG4gICAgaWYgKHdha2VBcm1lZCkgdm9pZCBhcm1XYWtlKGZhbHNlKTtcbiAgICBlbHNlIHN5bmNXYWtlVWkoKTtcbiAgfSxcbn0pO1xuXG5hc3luYyBmdW5jdGlvbiBhcm1XYWtlKG9uOiBib29sZWFuLCBwZXJzaXN0ID0gdHJ1ZSkge1xuICBjb25zdCBtb2RlbCA9IHNlbGVjdGVkV2FrZU1vZGVsKCk7XG4gIGlmIChvbiAmJiAhbW9kZWwpIHtcbiAgICB0b2FzdChcIk5vIHdha2Ugd29yZCBtb2RlbHMgZm91bmQgb24gdGhlIHNlcnZlclwiKTtcbiAgICAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwid2FrZS1lbmFibGVkXCIpLmNoZWNrZWQgPSBmYWxzZTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgZ2VuID0gKythcm1HZW47XG4gIHdha2VBcm1lZCA9IG9uO1xuICBpZiAocGVyc2lzdCkgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS53YWtlLWVuYWJsZWRcIiwgb24gPyBcIjFcIiA6IFwiMFwiKTtcbiAgaWYgKG9uICYmIG1vZGVsKSB7XG4gICAgd2FrZUxhc3RUZWwgPSBudWxsO1xuICAgIGlmICghd2FrZUNsaWVudC5yZWFkeSB8fCB3YWtlQ2xpZW50Lm1vZGVsSWQgIT09IG1vZGVsLmlkKSB3YWtlTG9hZGluZyA9IHRydWU7XG4gICAgd2FrZUNsaWVudC5sb2FkKG1vZGVsLmlkLCB3YWtlVGhyZXNob2xkKCkpO1xuICAgIGlmICghY2FsbElkKSB7XG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCBhdWRpby5lbnN1cmVNaWMob25NaWMsIG1pY09wdGlvbnMoKSk7XG4gICAgICAgIGlmIChnZW4gIT09IGFybUdlbiB8fCAhd2FrZUFybWVkKSByZXR1cm47XG4gICAgICAgIHdha2VQZXJpb2RDYWxsSWQgPSAwO1xuICAgICAgICB3YWtlQ2xpZW50LnJlc2V0KCk7XG4gICAgICAgIGF3YWl0IGFjcXVpcmVXYWtlTG9jaygpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGlmIChnZW4gIT09IGFybUdlbikgcmV0dXJuO1xuICAgICAgICB3YWtlQXJtZWQgPSBmYWxzZTtcbiAgICAgICAgd2FrZUxvYWRpbmcgPSBmYWxzZTtcbiAgICAgICAgaWYgKCFjYWxsSWQpIHtcbiAgICAgICAgICBhdWRpby5zdG9wTWljKCk7XG4gICAgICAgICAgcmVsZWFzZVdha2VMb2NrKCk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHBlcnNpc3QpIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2Uud2FrZS1lbmFibGVkXCIsIFwiMFwiKTtcbiAgICAgICAgdG9hc3QoYE1pY3JvcGhvbmU6ICR7KGVyciBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICAgICAgbG9nKFwiZXJyb3JcIiwgYHdha2UgbWljcm9waG9uZTogJHsoZXJyIGFzIEVycm9yKS5tZXNzYWdlfWAsIFwiZXJyXCIpO1xuICAgICAgfVxuICAgIH1cbiAgfSBlbHNlIHtcbiAgICB3YWtlTG9hZGluZyA9IGZhbHNlO1xuICAgIHdha2VMYXN0VGVsID0gbnVsbDtcbiAgICBpZiAoIWNhbGxJZCkge1xuICAgICAgd2FrZVBlcmlvZENhbGxJZCA9IG51bGw7XG4gICAgICBhdWRpby5zdG9wTWljKCk7XG4gICAgICByZWxlYXNlV2FrZUxvY2soKTtcbiAgICAgIHdha2VDbGllbnQucmVzZXQoKTtcbiAgICB9XG4gIH1cbiAgc3luY1dha2VVaSgpO1xufVxuXG5mdW5jdGlvbiBlbnN1cmVDb3JlV2FrZShvbjogYm9vbGVhbikge1xuICBjb3JlV2FudHNXYWtlID0gb247XG4gIGNvbnN0IG1vZGVsID0gc2VsZWN0ZWRXYWtlTW9kZWwoKTtcbiAgaWYgKG9uKSB7XG4gICAgaWYgKCFtb2RlbCkge1xuICAgICAgbG9nKFwid2FyblwiLCBcImNvcmUgYXNrZWQgZm9yIHdha2Ugd29yZCwgYnV0IG5vIG1vZGVscyBhcmUgYXZhaWxhYmxlXCIsIFwid2FyblwiKTtcbiAgICB9IGVsc2Uge1xuICAgICAgd2FrZUxhc3RUZWwgPSBudWxsO1xuICAgICAgY29uc3QgcHJlc2VydmVJbkZsaWdodCA9IHdha2VQZXJpb2RDYWxsSWQgPT09IGNhbGxJZCAmJiB3YWtlQ2xpZW50Lm1vZGVsSWQgPT09IG1vZGVsLmlkICYmIHdha2VDbGllbnQuc3VwcHJlc3NlZEluRmxpZ2h0O1xuICAgICAgd2FrZVBlcmlvZENhbGxJZCA9IGNhbGxJZDtcbiAgICAgIGlmICghd2FrZUNsaWVudC5yZWFkeSB8fCB3YWtlQ2xpZW50Lm1vZGVsSWQgIT09IG1vZGVsLmlkKSB3YWtlTG9hZGluZyA9IHRydWU7XG4gICAgICB3YWtlQ2xpZW50LmxvYWQobW9kZWwuaWQsIHdha2VUaHJlc2hvbGQoKSk7XG4gICAgICBpZiAoIXByZXNlcnZlSW5GbGlnaHQpIHdha2VDbGllbnQucmVzZXQoKTtcbiAgICAgIGxvZyhcIm91dFwiLCBgd2FrZSB3b3JkIGxpc3RlbmluZyAoJHttb2RlbC5sYWJlbH0pYCwgXCJvdXRcIik7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIGlmICghd2FrZUFybWVkKSB3YWtlTGFzdFRlbCA9IG51bGw7XG4gICAgbG9nKFwib3V0XCIsIFwid2FrZSB3b3JkIG9mZlwiLCBcIm91dFwiKTtcbiAgfVxuICBzeW5jV2FrZVVpKCk7XG59XG5cbmZ1bmN0aW9uIG9uV2FrZURldGVjdGVkKGhpdDogV2FrZURldGVjdGlvbkV2ZW50KSB7XG4gIGlmICghY2FuQWNjZXB0V2FrZUhpdCgpKSByZXR1cm47XG4gIGNvbnN0IGxhYmVsID0gc2VsZWN0ZWRXYWtlTW9kZWwoKT8ubGFiZWwgPz8gXCJ3YWtlIHdvcmRcIjtcbiAgbG9nKFwib3V0XCIsIGB3YWtlIGRldGVjdGVkIFx1MjAxQyR7bGFiZWx9XHUyMDFEIChzY29yZSAke2hpdC5zY29yZS50b0ZpeGVkKDIpfSwgJHtoaXQuaW5mZXJNcy50b0ZpeGVkKDEpfSBtcylgLCBcIm91dFwiKTtcbiAgaWYgKGNoZWNrZWQoXCJ3YWtlLWN1ZVwiKSkgdm9pZCBhdWRpby5vcGVuKCkudGhlbigoKSA9PiBhdWRpby5jdWUoV0FLRV9UT05FKSkuY2F0Y2goKCkgPT4ge30pO1xuICB0b2FzdChgSGVhcmQgXHUyMDFDJHtsYWJlbH1cdTIwMUQgKCR7aGl0LnNjb3JlLnRvRml4ZWQoMil9KWApO1xuICBpZiAoY2FsbElkICE9PSAwKSB7XG4gICAgY29uc3QgZGVmZXJyZWQgPSB3YWtlR2F0ZS50YWtlRGVmZXJyZWQoKTtcbiAgICBwdXNoKHsgdHlwZTogXCJ3YWtlXCIgfSk7XG4gICAgLy8gUmVwbGF5IHN1cHByZXNzZWQgY2h1bmtzIGFuZCBhbnkgZGVmZXJyZWQgcG9zdC1wbGF5YmFjayBjaHVua3MgaW4gZXhhY3QgY2hyb25vbG9naWNhbCBvcmRlcixcbiAgICAvLyBza2lwcGluZyBhbnl0aGluZyBvbGRlciB0aGFuIGFscmVhZHktZm9yd2FyZGVkIGdhcCBhdWRpby5cbiAgICBmb3IgKGNvbnN0IGl0ZW0gb2Ygd2FrZUdhdGUucGxhbldha2VSZXBsYXkoaGl0LCBkZWZlcnJlZCwgYnl0ZXNUb0Jhc2U2NCkpIHtcbiAgICAgIGlmICghY2FsbElkKSBicmVhaztcbiAgICAgIGNvdW50cy5taWMrKztcbiAgICAgIGlmIChpdGVtLnQgIT09IHVuZGVmaW5lZCkgcHVzaCh7IHR5cGU6IFwibWljXCIsIHBjbTogaXRlbS5wY20gfSwgaXRlbS50KTtcbiAgICAgIGVsc2UgcHVzaCh7IHR5cGU6IFwibWljXCIsIHBjbTogaXRlbS5wY20gfSk7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuICB3YWtlU3RhcnRpbmcgPSB0cnVlO1xuICBvcGVuaW5nQ2h1bmtzID0gW107XG4gIG9wZW5pbmdCeXRlcyA9IDA7XG4gIGZvciAoY29uc3QgY2h1bmsgb2YgaGl0LnRyYWlsaW5nKSB7XG4gICAgaWYgKGNodW5rLmJ5dGVzLmJ5dGVMZW5ndGggPT09IDApIGNvbnRpbnVlO1xuICAgIG9wZW5pbmdDaHVua3MucHVzaChjaHVuay5ieXRlcyk7XG4gICAgb3BlbmluZ0J5dGVzICs9IGNodW5rLmJ5dGVzLmJ5dGVMZW5ndGg7XG4gICAgd2hpbGUgKG9wZW5pbmdCeXRlcyA+IE9QRU5JTkdfTUFYX0JZVEVTICYmIG9wZW5pbmdDaHVua3MubGVuZ3RoID4gMSkge1xuICAgICAgb3BlbmluZ0J5dGVzIC09IG9wZW5pbmdDaHVua3Muc2hpZnQoKSEuYnl0ZUxlbmd0aDtcbiAgICB9XG4gIH1cbiAgdm9pZCBzdGFydChjaGF0Lmxlbmd0aCA+IDApLnRoZW4oKHN0YXJ0ZWQpID0+IHtcbiAgICBpZiAoIXN0YXJ0ZWQgJiYgd2FrZVN0YXJ0aW5nKSB7XG4gICAgICB3YWtlU3RhcnRpbmcgPSBmYWxzZTtcbiAgICAgIG9wZW5pbmdDaHVua3MgPSBbXTtcbiAgICAgIG9wZW5pbmdCeXRlcyA9IDA7XG4gICAgICBzeW5jV2FrZVVpKCk7XG4gICAgfVxuICB9KS5jYXRjaCgoZXJyKSA9PiB7XG4gICAgd2FrZVN0YXJ0aW5nID0gZmFsc2U7XG4gICAgb3BlbmluZ0NodW5rcyA9IFtdO1xuICAgIG9wZW5pbmdCeXRlcyA9IDA7XG4gICAgdG9hc3QoKGVyciBhcyBFcnJvcikubWVzc2FnZSk7XG4gICAgbG9nKFwiZXJyb3JcIiwgKGVyciBhcyBFcnJvcikubWVzc2FnZSwgXCJlcnJcIik7XG4gICAgc3luY1dha2VVaSgpO1xuICB9KTtcbn1cblxuLy8gV2lyaW5nLlxuXG5mdW5jdGlvbiBzZXR0aW5nc0Zyb21TdG9yYWdlKCkge1xuICBmb3IgKGNvbnN0IGlkIG9mIFtcImFlY1wiLCBcInN0b3B3b3JkXCIsIFwicHR0XCIsIFwiY2FwdGlvbnNcIiwgXCJjb2RpbmdcIiwgXCJmYWtlaGVybWVzXCIsIFwidHJhY2VcIiwgXCJ3YWtlLWN1ZVwiLCBcIndha2UtYmFyZ2VcIl0pIHtcbiAgICBjb25zdCB2ID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oYHZvaWNlLiR7aWR9YCk7XG4gICAgaWYgKHYgIT0gbnVsbCkgJDxIVE1MSW5wdXRFbGVtZW50PihpZCkuY2hlY2tlZCA9IHYgPT09IFwiMVwiO1xuICAgICQoaWQpLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4ge1xuICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oYHZvaWNlLiR7aWR9YCwgY2hlY2tlZChpZCkgPyBcIjFcIiA6IFwiMFwiKTtcbiAgICAgIGlmIChpZCA9PT0gXCJhZWNcIiAmJiB3YWtlQXJtZWQgJiYgIWNhbGxJZCkge1xuICAgICAgICB2b2lkIGF1ZGlvLnN0YXJ0TWljKG9uTWljLCBtaWNPcHRpb25zKCkpLmNhdGNoKChlcnIpID0+IHRvYXN0KGBNaWNyb3Bob25lOiAke2Vyci5tZXNzYWdlfWApKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxuICBmb3IgKGNvbnN0IFtpZCwga2V5XSBvZiBbXG4gICAgW1wiZmFrZWRlbGF5XCIsIFwidm9pY2UuZmFrZWRlbGF5XCJdLFxuICAgIFtcImF0dG4tYWZ0ZXItd2FrZVwiLCBcInZvaWNlLmF0dG4tYWZ0ZXItd2FrZVwiXSxcbiAgICBbXCJhdHRuLXdpbmRvd1wiLCBcInZvaWNlLmF0dG4td2luZG93XCJdLFxuICAgIFtcImF0dG4tYWZ0ZXItcXVlc3Rpb25cIiwgXCJ2b2ljZS5hdHRuLWFmdGVyLXF1ZXN0aW9uXCJdLFxuICAgIFtcImhhbmd1cC1hZnRlclwiLCBcInZvaWNlLmhhbmd1cC1hZnRlclwiXSxcbiAgXSBhcyBjb25zdCkge1xuICAgIGNvbnN0IHNhdmVkID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oa2V5KTtcbiAgICBpZiAoc2F2ZWQgIT0gbnVsbCkgJDxIVE1MSW5wdXRFbGVtZW50PihpZCkudmFsdWUgPSBzYXZlZDtcbiAgICAkKGlkKS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHtcbiAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKGtleSwgJDxIVE1MSW5wdXRFbGVtZW50PihpZCkudmFsdWUpO1xuICAgICAgaWYgKGlkID09PSBcImhhbmd1cC1hZnRlclwiKSBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLmhhbmd1cC1jdXN0b21cIiwgXCIxXCIpO1xuICAgIH0pO1xuICB9XG4gIGNvbnN0IHRocmVzaCA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2Uud2FrZS10aHJlc2hvbGRcIik7XG4gIGlmICh0aHJlc2ggIT0gbnVsbCkgJDxIVE1MSW5wdXRFbGVtZW50PihcIndha2UtdGhyZXNob2xkXCIpLnZhbHVlID0gdGhyZXNoO1xuICAkKFwid2FrZS10aHJlc2hvbGQtdmFsXCIpLnRleHRDb250ZW50ID0gd2FrZVRocmVzaG9sZCgpLnRvRml4ZWQoMik7XG4gICQoXCJ3YWtlLXRocmVzaG9sZFwiKS5hZGRFdmVudExpc3RlbmVyKFwiaW5wdXRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHYgPSB3YWtlVGhyZXNob2xkKCk7XG4gICAgJChcIndha2UtdGhyZXNob2xkLXZhbFwiKS50ZXh0Q29udGVudCA9IHYudG9GaXhlZCgyKTtcbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLndha2UtdGhyZXNob2xkXCIsIHYudG9GaXhlZCgyKSk7XG4gICAgd2FrZUNsaWVudC5zZXRUaHJlc2hvbGQodik7XG4gICAgcmVuZGVyV2FrZVRlbGVtZXRyeSgpO1xuICB9KTtcbiAgY29uc3Qgc2lnbmFsaW5nID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS5zaWduYWxpbmdcIik7XG4gIGlmIChzaWduYWxpbmcpICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwic2lnbmFsaW5nXCIpLnZhbHVlID0gc2lnbmFsaW5nO1xuICAkKFwic2lnbmFsaW5nXCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4ge1xuICAgIGNvbnN0IG1vZGUgPSAkPEhUTUxTZWxlY3RFbGVtZW50PihcInNpZ25hbGluZ1wiKS52YWx1ZTtcbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLnNpZ25hbGluZ1wiLCBtb2RlKTtcbiAgICBpZiAobG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS5oYW5ndXAtY3VzdG9tXCIpICE9PSBcIjFcIikge1xuICAgICAgY29uc3QgZGVmID0gbW9kZSA9PT0gXCJlY2hvXCIgPyBcIjE1XCIgOiBcIjMwMFwiO1xuICAgICAgJDxIVE1MSW5wdXRFbGVtZW50PihcImhhbmd1cC1hZnRlclwiKS52YWx1ZSA9IGRlZjtcbiAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2UuaGFuZ3VwLWFmdGVyXCIsIGRlZik7XG4gICAgfVxuICAgIHN5bmNTaWduYWxpbmdVaSgpO1xuICB9KTtcbiAgJChcIndha2UtZW5hYmxlZFwiKS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHZvaWQgYXJtV2FrZShjaGVja2VkKFwid2FrZS1lbmFibGVkXCIpKSk7XG4gICQoXCJ3YWtlLW1vZGVsXCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGlkID0gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJ3YWtlLW1vZGVsXCIpLnZhbHVlO1xuICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2Uud2FrZS1tb2RlbFwiLCBpZCk7XG4gICAgaWYgKHdha2VBcm1lZCB8fCBjb3JlV2FudHNXYWtlKSB7XG4gICAgICB3YWtlTG9hZGluZyA9IHRydWU7XG4gICAgICB3YWtlTGFzdFRlbCA9IG51bGw7XG4gICAgICB3YWtlQ2xpZW50LmxvYWQoaWQsIHdha2VUaHJlc2hvbGQoKSk7XG4gICAgICBzeW5jV2FrZVVpKCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHN5bmNXYWtlVWkoKTtcbiAgICB9XG4gIH0pO1xuICBjb25zdCB2b2ljZSA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2Uudm9pY2VcIik7XG4gIGlmICh2b2ljZSkgJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJ2b2ljZVwiKS52YWx1ZSA9IHZvaWNlO1xuICAkKFwidm9pY2VcIikuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLnZvaWNlXCIsICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwidm9pY2VcIikudmFsdWUpKTtcbiAgY29uc3QgbW9kZSA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UubW9kZVwiKTtcbiAgaWYgKG1vZGUpICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwibW9kZVwiKS52YWx1ZSA9IG1vZGU7XG4gICQoXCJtb2RlXCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4ge1xuICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2UubW9kZVwiLCAkPEhUTUxTZWxlY3RFbGVtZW50PihcIm1vZGVcIikudmFsdWUpO1xuICAgIHN5bmNDb21wb3NlcigpO1xuICB9KTtcbiAgY29uc3QgdGhlbWUgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLnRoZW1lXCIpID8/IFwic3lzdGVtXCI7XG4gIGFwcGx5VGhlbWUodGhlbWUpO1xuICBmb3IgKGNvbnN0IGJ0biBvZiBBcnJheS5mcm9tKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiI3RoZW1lLXBpY2tlciBidXR0b25cIikpKSB7XG4gICAgYnRuLm9uY2xpY2sgPSAoKSA9PiB7XG4gICAgICBjb25zdCBjaG9pY2UgPSBidG4uZGF0YXNldC50aGVtZSA/PyBcInN5c3RlbVwiO1xuICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS50aGVtZVwiLCBjaG9pY2UpO1xuICAgICAgYXBwbHlUaGVtZShjaG9pY2UpO1xuICAgIH07XG4gIH1cbiAgY29uc3QgZGVuc2l0eSA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UuZGVuc2l0eVwiKTtcbiAgYXBwbHlEZW5zaXR5KGRlbnNpdHkpO1xuICBmb3IgKGNvbnN0IGJ0biBvZiBBcnJheS5mcm9tKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiI2RlbnNpdHktcGlja2VyIGJ1dHRvblwiKSkpIHtcbiAgICBidG4ub25jbGljayA9ICgpID0+IHtcbiAgICAgIGNvbnN0IGNob2ljZSA9IG5vcm1hbGl6ZURlbnNpdHkoYnRuLmRhdGFzZXQuZGVuc2l0eSk7XG4gICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLmRlbnNpdHlcIiwgY2hvaWNlKTtcbiAgICAgIGFwcGx5RGVuc2l0eShjaG9pY2UpO1xuICAgIH07XG4gIH1cbiAgbWF0Y2hNZWRpYShcIihwcmVmZXJzLWNvbG9yLXNjaGVtZTogZGFyaylcIikuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiB7XG4gICAgaWYgKChsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLnRoZW1lXCIpID8/IFwic3lzdGVtXCIpID09PSBcInN5c3RlbVwiKSBhcHBseVRoZW1lKFwic3lzdGVtXCIpO1xuICB9KTtcbiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcInZpc2liaWxpdHljaGFuZ2VcIiwgKCkgPT4ge1xuICAgIGlmICghZG9jdW1lbnQuaGlkZGVuICYmIChjYWxsSWQgfHwgd2FrZUFybWVkKSkgdm9pZCBhY3F1aXJlV2FrZUxvY2soKTtcbiAgfSk7XG4gIGF1ZGlvLm9uQXVkaW9TdGF0ZUNoYW5nZSgoKSA9PiBzeW5jV2FrZVVpKCkpO1xuICBjb25zdCByZXN1bWVJZlN1c3BlbmRlZCA9ICgpID0+IHtcbiAgICBpZiAoYXVkaW8uYXVkaW9TdXNwZW5kZWQgJiYgKHdha2VBcm1lZCB8fCBjYWxsSWQpKSB7XG4gICAgICB2b2lkIGF1ZGlvLnJlc3VtZUF1ZGlvKCkudGhlbigoKSA9PiBzeW5jV2FrZVVpKCkpO1xuICAgIH1cbiAgfTtcbiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcInBvaW50ZXJkb3duXCIsIHJlc3VtZUlmU3VzcGVuZGVkLCB7IHBhc3NpdmU6IHRydWUgfSk7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJwb2ludGVydXBcIiwgcmVzdW1lSWZTdXNwZW5kZWQsIHsgcGFzc2l2ZTogdHJ1ZSB9KTtcbiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIHJlc3VtZUlmU3VzcGVuZGVkLCB7IHBhc3NpdmU6IHRydWUgfSk7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJrZXlkb3duXCIsIHJlc3VtZUlmU3VzcGVuZGVkLCB7IHBhc3NpdmU6IHRydWUgfSk7XG4gIHN5bmNTaWduYWxpbmdVaSgpO1xufVxuXG5jb25zdCBtb2JpbGVMYXlvdXQgPSBtYXRjaE1lZGlhKFwiKG1heC13aWR0aDogOTIwcHgpXCIpO1xubGV0IGRyYXdlck9wZW5lcjogSFRNTEVsZW1lbnQgfCBudWxsID0gbnVsbDtcblxuZnVuY3Rpb24gc2V0VGFza3NPcGVuKG9wZW46IGJvb2xlYW4sIG9wZW5lcj86IEhUTUxFbGVtZW50IHwgbnVsbCkge1xuICBjb25zdCBjYW5PcGVuID0gbW9iaWxlTGF5b3V0Lm1hdGNoZXMgJiYgISQoXCJ0YWxrXCIpLmhpZGRlbjtcbiAgY29uc3QgbmV4dCA9IG9wZW4gJiYgY2FuT3BlbjtcbiAgY29uc3Qgd2FzT3BlbiA9IGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LmNvbnRhaW5zKFwidGFza3Mtb3BlblwiKTtcbiAgZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QudG9nZ2xlKFwidGFza3Mtb3BlblwiLCBuZXh0KTtcbiAgY29uc3QgaGVhZGVyID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihcImhlYWRlclwiKSBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gIGlmIChoZWFkZXIpIGhlYWRlci5pbmVydCA9IG5leHQ7XG4gICQoXCJjb252b1wiKS5pbmVydCA9IG5leHQ7XG4gICQoXCJzaWRlXCIpLmluZXJ0ID0gbW9iaWxlTGF5b3V0Lm1hdGNoZXMgJiYgIW5leHQ7XG4gICQoXCJ0YXNrcy10b2dnbGVcIikuc2V0QXR0cmlidXRlKFwiYXJpYS1leHBhbmRlZFwiLCBTdHJpbmcobmV4dCkpO1xuICAkKFwibW9iaWxlLXRhc2tzLWJhclwiKS5zZXRBdHRyaWJ1dGUoXCJhcmlhLWV4cGFuZGVkXCIsIFN0cmluZyhuZXh0KSk7XG4gIGlmIChuZXh0ICYmICF3YXNPcGVuKSB7XG4gICAgZHJhd2VyT3BlbmVyID0gb3BlbmVyID8/IChkb2N1bWVudC5hY3RpdmVFbGVtZW50IGFzIEhUTUxFbGVtZW50IHwgbnVsbCk7XG4gICAgY2xlYXJVbnJlYWRJZlJlc3VsdHNWaXNpYmxlKCk7XG4gICAgJChcInRhc2tzLWNsb3NlXCIpLmZvY3VzKCk7XG4gICAgcmVxdWVzdEFuaW1hdGlvbkZyYW1lKCgpID0+IHVwZGF0ZUFsbFJlc3VsdENsYW1waW5nKCkpO1xuICB9IGVsc2UgaWYgKCFuZXh0ICYmIHdhc09wZW4pIHtcbiAgICBjb25zdCB0YXJnZXQgPSBkcmF3ZXJPcGVuZXI7XG4gICAgZHJhd2VyT3BlbmVyID0gbnVsbDtcbiAgICBpZiAodGFyZ2V0ICYmIHRhcmdldC5pc0Nvbm5lY3RlZCAmJiAhdGFyZ2V0LmhpZGRlbiAmJiB0YXJnZXQub2Zmc2V0UGFyZW50ICE9PSBudWxsKSB7XG4gICAgICB0YXJnZXQuZm9jdXMoKTtcbiAgICB9IGVsc2UgaWYgKHRhcmdldCA9PT0gJChcIm1vYmlsZS10YXNrcy1iYXJcIikpIHtcbiAgICAgIGNvbnN0IGZhbGxiYWNrID0gJChcInRhc2tzLXRvZ2dsZVwiKTtcbiAgICAgIGlmICghZmFsbGJhY2suaGlkZGVuICYmIGZhbGxiYWNrLm9mZnNldFBhcmVudCAhPT0gbnVsbCkgZmFsbGJhY2suZm9jdXMoKTtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gdGFicygpIHtcbiAgY29uc3Qgdmlld3M6IFJlY29yZDxzdHJpbmcsIEhUTUxFbGVtZW50PiA9IHsgdGFsazogJChcInRhbGtcIiksIGRldjogJChcImRldlwiKSwgcmVwbGF5OiAkKFwicmVwbGF5bWFpblwiKSB9O1xuICBmb3IgKGNvbnN0IG5hbWUgb2YgT2JqZWN0LmtleXModmlld3MpKSB7XG4gICAgJChgdGFiLSR7bmFtZX1gKS5vbmNsaWNrID0gKCkgPT4ge1xuICAgICAgZm9yIChjb25zdCBbb3RoZXIsIGVsXSBvZiBPYmplY3QuZW50cmllcyh2aWV3cykpIHtcbiAgICAgICAgZWwuaGlkZGVuID0gb3RoZXIgIT09IG5hbWU7XG4gICAgICAgICQoYHRhYi0ke290aGVyfWApLmNsYXNzTGlzdC50b2dnbGUoXCJvblwiLCBvdGhlciA9PT0gbmFtZSk7XG4gICAgICB9XG4gICAgICAkKFwidGFza3MtdG9nZ2xlXCIpLmhpZGRlbiA9IG5hbWUgIT09IFwidGFsa1wiO1xuICAgICAgc2V0VGFza3NPcGVuKGZhbHNlKTtcbiAgICAgIGlmIChuYW1lID09PSBcInRhbGtcIikgcmVxdWVzdEFuaW1hdGlvbkZyYW1lKCgpID0+IHVwZGF0ZUFsbFJlc3VsdENsYW1waW5nKCkpO1xuICAgIH07XG4gIH1cbiAgZm9yIChjb25zdCBidG4gb2YgQXJyYXkuZnJvbShkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxCdXR0b25FbGVtZW50PihcIiNzaWRlLXRhYnMgYnV0dG9uXCIpKSkge1xuICAgIGJ0bi5vbmNsaWNrID0gKCkgPT4gc2V0U2lkZUZpbHRlcihub3JtYWxpemVTaWRlRmlsdGVyKGJ0bi5kYXRhc2V0LmZpbHRlcikpO1xuICB9XG4gICQoXCJ0b2dnbGUtYWxsLXJlc3VsdHNcIikub25jbGljayA9ICgpID0+IHtcbiAgICBjb25zdCBjbGFtcGVkID0gWy4uLnJlc3VsdHMudmFsdWVzKCldLmZpbHRlcigocikgPT4gci5jYXJkLmNsYXNzTGlzdC5jb250YWlucyhcImNsYW1wZWRcIikpO1xuICAgIGNvbnN0IG9wZW5BbGwgPSBjbGFtcGVkLnNvbWUoKHIpID0+ICFyLmNhcmQuY2xhc3NMaXN0LmNvbnRhaW5zKFwib3BlblwiKSk7XG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiBjbGFtcGVkKSBzZXRSZXN1bHRPcGVuKGVudHJ5LCBvcGVuQWxsKTtcbiAgfTtcbiAgJChcImdlYXJcIikub25jbGljayA9ICgpID0+IHsgJChcInNldHRpbmdzXCIpLmhpZGRlbiA9IGZhbHNlOyB9O1xuICAkKFwiY2xvc2VzZXR0aW5nc1wiKS5vbmNsaWNrID0gKCkgPT4geyAkKFwic2V0dGluZ3NcIikuaGlkZGVuID0gdHJ1ZTsgfTtcbiAgJChcImNsb3Nlc2V0dGluZ3MteFwiKS5vbmNsaWNrID0gKCkgPT4geyAkKFwic2V0dGluZ3NcIikuaGlkZGVuID0gdHJ1ZTsgfTtcbiAgJChcInNldHRpbmdzXCIpLm9uY2xpY2sgPSAoZSkgPT4geyBpZiAoZS50YXJnZXQgPT09ICQoXCJzZXR0aW5nc1wiKSkgJChcInNldHRpbmdzXCIpLmhpZGRlbiA9IHRydWU7IH07XG4gIGNvbnN0IG9wZW5Nb2JpbGVUYXNrc0RyYXdlciA9IChvcGVuZXI6IEhUTUxFbGVtZW50KSA9PiB7XG4gICAgY29uc3QgYWN0aXZlVG90YWwgPSBbLi4udGFza3MudmFsdWVzKCldLmZpbHRlcihpc0FjdGl2ZVRhc2spLmxlbmd0aCArIGVhcmxpZXJBY3RpdmVDb3VudDtcbiAgICBjb25zdCBuZXh0RmlsdGVyID0gcmVzb2x2ZU1vYmlsZUJhbm5lckZpbHRlcihzaWRlRmlsdGVyLCBhY3RpdmVUb3RhbCwgdW5yZWFkTW9iaWxlUmVzdWx0cyk7XG4gICAgaWYgKG5leHRGaWx0ZXIgIT09IHNpZGVGaWx0ZXIpIHNldFNpZGVGaWx0ZXIobmV4dEZpbHRlcik7XG4gICAgc2V0VGFza3NPcGVuKHRydWUsIG9wZW5lcik7XG4gIH07XG4gICQoXCJ0YXNrcy10b2dnbGVcIikub25jbGljayA9ICgpID0+IHtcbiAgICBpZiAoZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QuY29udGFpbnMoXCJ0YXNrcy1vcGVuXCIpKSBzZXRUYXNrc09wZW4oZmFsc2UpO1xuICAgIGVsc2Ugb3Blbk1vYmlsZVRhc2tzRHJhd2VyKCQoXCJ0YXNrcy10b2dnbGVcIikpO1xuICB9O1xuICAkKFwibW9iaWxlLXRhc2tzLWJhclwiKS5vbmNsaWNrID0gKCkgPT4gb3Blbk1vYmlsZVRhc2tzRHJhd2VyKCQoXCJtb2JpbGUtdGFza3MtYmFyXCIpKTtcbiAgJChcInRhc2tzLWNsb3NlXCIpLm9uY2xpY2sgPSAoKSA9PiBzZXRUYXNrc09wZW4oZmFsc2UpO1xuICAkKFwic2lkZS1iYWNrZHJvcFwiKS5vbmNsaWNrID0gKCkgPT4gc2V0VGFza3NPcGVuKGZhbHNlKTtcbiAgbW9iaWxlTGF5b3V0LmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4ge1xuICAgIHNldFRhc2tzT3BlbihmYWxzZSk7XG4gICAgY2xlYXJVbnJlYWRJZlJlc3VsdHNWaXNpYmxlKCk7XG4gICAgcmVxdWVzdEFuaW1hdGlvbkZyYW1lKCgpID0+IHVwZGF0ZUFsbFJlc3VsdENsYW1waW5nKCkpO1xuICB9KTtcbiAgc2V0VGFza3NPcGVuKGZhbHNlKTtcbn1cblxuZnVuY3Rpb24gdHlwaW5nKCk6IGJvb2xlYW4ge1xuICBjb25zdCBlbCA9IGRvY3VtZW50LmFjdGl2ZUVsZW1lbnQgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICByZXR1cm4gISFlbCAmJiAoZWwudGFnTmFtZSA9PT0gXCJJTlBVVFwiIHx8IGVsLnRhZ05hbWUgPT09IFwiVEVYVEFSRUFcIiB8fCBlbC50YWdOYW1lID09PSBcIlNFTEVDVFwiIHx8IGVsLmlzQ29udGVudEVkaXRhYmxlKTtcbn1cblxuZnVuY3Rpb24ga2V5cygpIHtcbiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcImtleWRvd25cIiwgKGUpID0+IHtcbiAgICBpZiAoZS5rZXkgPT09IFwiRXNjYXBlXCIpIHtcbiAgICAgIGlmICghJChcInNldHRpbmdzXCIpLmhpZGRlbikgeyAkKFwic2V0dGluZ3NcIikuaGlkZGVuID0gdHJ1ZTsgcmV0dXJuOyB9XG4gICAgICBpZiAoZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QuY29udGFpbnMoXCJ0YXNrcy1vcGVuXCIpICYmIG1vYmlsZUxheW91dC5tYXRjaGVzICYmICEkKFwidGFsa1wiKS5oaWRkZW4pIHsgc2V0VGFza3NPcGVuKGZhbHNlKTsgcmV0dXJuOyB9XG4gICAgICBpZiAoY2FsbElkKSB7IHB1c2goeyB0eXBlOiBcImludGVycnVwdFwiIH0pOyBhdWRpby5mbHVzaCgpOyByZXR1cm47IH1cbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHR5cGluZygpIHx8ICEkKFwic2V0dGluZ3NcIikuaGlkZGVuIHx8IGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LmNvbnRhaW5zKFwidGFza3Mtb3BlblwiKSB8fCBlLm1ldGFLZXkgfHwgZS5jdHJsS2V5IHx8IGUuYWx0S2V5KSByZXR1cm47XG4gICAgaWYgKGUua2V5ID09PSBcIm1cIiB8fCBlLmtleSA9PT0gXCJNXCIpIHsgc2V0TXV0ZWQoIW11dGVkKTsgZS5wcmV2ZW50RGVmYXVsdCgpOyB9XG4gICAgZWxzZSBpZiAoZS5rZXkgPT09IFwid1wiIHx8IGUua2V5ID09PSBcIldcIikgeyB2b2lkIGFybVdha2UoIXdha2VBcm1lZCk7IGUucHJldmVudERlZmF1bHQoKTsgfVxuICAgIGVsc2UgaWYgKGUua2V5ID09PSBcIi9cIikgeyAkKFwidGV4dFwiKS5mb2N1cygpOyBlLnByZXZlbnREZWZhdWx0KCk7IH1cbiAgICBlbHNlIGlmIChlLmNvZGUgPT09IFwiU3BhY2VcIiAmJiBjYWxsSWQgJiYgbXV0ZWQgJiYgIWUucmVwZWF0KSB7IGhvbGRpbmcgPSB0cnVlOyBwdXNoKHsgdHlwZTogXCJ1bm11dGVcIiB9KTsgc2hvd1N0YXR1cygpOyBlLnByZXZlbnREZWZhdWx0KCk7IH1cbiAgfSk7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJrZXl1cFwiLCAoZSkgPT4ge1xuICAgIGlmIChlLmNvZGUgPT09IFwiU3BhY2VcIiAmJiBob2xkaW5nKSB7IGhvbGRpbmcgPSBmYWxzZTsgcHVzaCh7IHR5cGU6IFwibXV0ZVwiIH0pOyBzaG93U3RhdHVzKCk7IH1cbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHN1Ym1pdFRleHQoZTogRXZlbnQpIHtcbiAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICBjb25zdCBpbnB1dCA9ICQ8SFRNTElucHV0RWxlbWVudD4oXCJ0ZXh0XCIpO1xuICBsZXQgdGV4dCA9IGlucHV0LnZhbHVlLnRyaW0oKTtcbiAgaWYgKCF0ZXh0KSByZXR1cm47XG4gIC8vIFdpdGggbm8gY2FsbCBvbiwgdHlwaW5nIHN0YXJ0cyBhIGNoYXQ6IHRoZSBzYW1lIG1haW4gdGhyZWFkLCBpbiB0ZXh0LlxuICBpZiAoIWNhbGxJZCkge1xuICAgIGlucHV0LnZhbHVlID0gXCJcIjtcbiAgICBzeW5jQ29tcG9zZXIoKTtcbiAgICB0cnkgeyBhd2FpdCBzdGFydChmYWxzZSwgdHJ1ZSk7IH0gY2F0Y2ggKGVycikgeyB0b2FzdCgoZXJyIGFzIEVycm9yKS5tZXNzYWdlKTsgbG9nKFwiZXJyb3JcIiwgKGVyciBhcyBFcnJvcikubWVzc2FnZSwgXCJlcnJcIik7IH1cbiAgICBpZiAoIWNhbGxJZCkgeyBpbnB1dC52YWx1ZSA9IHRleHQ7IHN5bmNDb21wb3NlcigpOyByZXR1cm47IH1cbiAgfVxuICAvLyBcIi90MyBcdTIwMjZcIiBhbmQgXCIvaCBcdTIwMjZcIiBwaWNrIHRoZSBhZ2VudCB3aGF0ZXZlciB0aGUgc2VsZWN0b3Igc2F5cy5cbiAgY29uc3QgcGFyc2VkID0gcGFyc2VQcmVmaXgodGV4dCk7XG4gIGNvbnN0IG1vZGUgPSBwYXJzZWQubW9kZSA/PyAkPEhUTUxTZWxlY3RFbGVtZW50PihcIm1vZGVcIikudmFsdWU7XG4gIHRleHQgPSBwYXJzZWQucmVzdDtcbiAgaWYgKCF0ZXh0KSByZXR1cm47XG4gIGlmIChtb2RlID09PSBcInNheVwiKSB7XG4gICAgcHVzaCh7IHR5cGU6IFwic2F5XCIsIHRleHQgfSk7XG4gICAgc2Nyb2xsRG93bih0cnVlKTtcbiAgfSBlbHNlIHtcbiAgICBwdXNoKHsgdHlwZTogXCJhc2tcIiwgdGV4dCwgYWdlbnQ6IG1vZGUgfSk7XG4gICAgbm90ZShgWW91IFx1MjE5MiBuZXcgJHttb2RlID09PSBcInQzXCIgPyBcImNvZGluZ1wiIDogXCJIZXJtZXNcIn0gdGFzazogJHt0ZXh0fWApO1xuICAgIHNjcm9sbERvd24odHJ1ZSk7XG4gIH1cbiAgaW5wdXQudmFsdWUgPSBcIlwiO1xuICBzeW5jQ29tcG9zZXIoKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gbWFpbigpIHtcbiAgYXBwbHlUaGVtZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLnRoZW1lXCIpID8/IFwic3lzdGVtXCIpO1xuICBhcHBseURlbnNpdHkobG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS5kZW5zaXR5XCIpKTtcbiAgc2VydmVyID0gYXdhaXQgKGF3YWl0IGZldGNoKFwiL2NvbmZpZ1wiKSkuanNvbigpO1xuICAkKFwicm91dGVcIikudGV4dENvbnRlbnQgPSBgJHtzZXJ2ZXIucm91dGUgPT09IFwidmVydGV4XCIgPyBcIlZlcnRleFwiIDogXCJHZW1pbmkgQVBJXCJ9IFx1MDBCNyAke3NlcnZlci5tb2RlbC5zcGxpdChcIi9cIikucG9wKCl9YDtcbiAgJChcInZlcnNpb25cIikudGV4dENvbnRlbnQgPSBzZXJ2ZXIudmVyc2lvbjtcbiAgJChcImJ1aWxkXCIpLnRleHRDb250ZW50ID0gYGNvcmUgJHtzZXJ2ZXIudmVyc2lvbn1gO1xuICBzZXR0aW5nc0Zyb21TdG9yYWdlKCk7XG4gIGNvbnN0IHdha2VTZWxlY3QgPSAkPEhUTUxTZWxlY3RFbGVtZW50PihcIndha2UtbW9kZWxcIik7XG4gIGNvbnN0IHdha2VMaXN0ID0gc2VydmVyLndha2VNb2RlbHMgPz8gW107XG4gIGZvciAoY29uc3QgbSBvZiB3YWtlTGlzdCkgd2FrZVNlbGVjdC5hZGQobmV3IE9wdGlvbihtLmxhYmVsLCBtLmlkKSk7XG4gIGNvbnN0IHNhdmVkV2FrZU1vZGVsID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS53YWtlLW1vZGVsXCIpO1xuICBpZiAoc2F2ZWRXYWtlTW9kZWwgJiYgd2FrZUxpc3Quc29tZSgobSkgPT4gbS5pZCA9PT0gc2F2ZWRXYWtlTW9kZWwpKSB3YWtlU2VsZWN0LnZhbHVlID0gc2F2ZWRXYWtlTW9kZWw7XG4gIGVsc2UgaWYgKHdha2VMaXN0LnNvbWUoKG0pID0+IG0uaWQgPT09IFwicGVubnl3b3J0aFwiKSkgd2FrZVNlbGVjdC52YWx1ZSA9IFwicGVubnl3b3J0aFwiO1xuICBpZiAod2FrZUxpc3QubGVuZ3RoID09PSAwKSB7XG4gICAgJDxIVE1MSW5wdXRFbGVtZW50PihcIndha2UtZW5hYmxlZFwiKS5kaXNhYmxlZCA9IHRydWU7XG4gICAgd2FrZVNlbGVjdC5kaXNhYmxlZCA9IHRydWU7XG4gICAgJChcIndha2UtaGVscFwiKS50ZXh0Q29udGVudCA9IFwiTm8gLm9ubnggd2FrZSB3b3JkIG1vZGVscyBmb3VuZCBvbiB0aGUgc2VydmVyLlwiO1xuICB9XG4gIGlmICghc2VydmVyLmhlcm1lcykgeyAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwiZmFrZWhlcm1lc1wiKS5jaGVja2VkID0gdHJ1ZTsgJDxIVE1MSW5wdXRFbGVtZW50PihcImZha2VoZXJtZXNcIikuZGlzYWJsZWQgPSB0cnVlOyB9XG4gIGlmICghc2VydmVyLnQzKSAkKFwiY29kaW5naGVscFwiKS50ZXh0Q29udGVudCA9IFwiVDMgaXNuJ3QgYXZhaWxhYmxlIG9uIHRoZSBzZXJ2ZXI6IG9ubHkgd2l0aCBmYWtlIGFuc3dlcnMuXCI7XG4gIGVsc2UgJChcImNvZGluZ2hlbHBcIikudGV4dENvbnRlbnQgPSBgQ29kZSBjaGFuZ2VzIGdvIHRvIGEgVDMgQ29kZSB0aHJlYWQgaW4gb25lIG9mOiAke3NlcnZlci50My5qb2luKFwiLCBcIil9LmA7XG4gIGlmICghc3RvcFdvcmRzLnN1cHBvcnRlZCkgeyAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwic3RvcHdvcmRcIikuY2hlY2tlZCA9IGZhbHNlOyAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwic3RvcHdvcmRcIikuZGlzYWJsZWQgPSB0cnVlOyB9XG4gIGNvbnN0IHByZXNldCA9ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwicHJlc2V0XCIpO1xuICBmb3IgKGNvbnN0IG5hbWUgb2YgT2JqZWN0LmtleXMoUFJFU0VUUykpIHByZXNldC5hZGQobmV3IE9wdGlvbihuYW1lLCBuYW1lKSk7XG4gIHByZXNldC52YWx1ZSA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UtY29yZS5wcmVzZXRcIikgPz8gXCJ3ZWJcIjtcbiAgaWYgKCFQUkVTRVRTW3ByZXNldC52YWx1ZV0pIHByZXNldC52YWx1ZSA9IFwid2ViXCI7XG4gICQ8SFRNTFRleHRBcmVhRWxlbWVudD4oXCJjb25maWdcIikudmFsdWUgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLWNvcmUuY29uZmlnXCIpID8/IEpTT04uc3RyaW5naWZ5KFBSRVNFVFNbcHJlc2V0LnZhbHVlXSwgbnVsbCwgMik7XG4gIHN5bmNTaWduYWxpbmdVaSgpO1xuICBwcmVzZXQub25jaGFuZ2UgPSAoKSA9PiB7XG4gICAgJDxIVE1MVGV4dEFyZWFFbGVtZW50PihcImNvbmZpZ1wiKS52YWx1ZSA9IEpTT04uc3RyaW5naWZ5KFBSRVNFVFNbcHJlc2V0LnZhbHVlXSwgbnVsbCwgMik7XG4gICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS1jb3JlLnByZXNldFwiLCBwcmVzZXQudmFsdWUpO1xuICAgIGxvY2FsU3RvcmFnZS5yZW1vdmVJdGVtKFwidm9pY2UtY29yZS5jb25maWdcIik7XG4gICAgc3luY1NpZ25hbGluZ1VpKCk7XG4gIH07XG4gICQoXCJjb25maWdcIikub25pbnB1dCA9ICgpID0+IHsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS1jb3JlLmNvbmZpZ1wiLCAkPEhUTUxUZXh0QXJlYUVsZW1lbnQ+KFwiY29uZmlnXCIpLnZhbHVlKTsgc3luY1NpZ25hbGluZ1VpKCk7IH07XG4gICQoXCJkZWZhdWx0c1wiKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGMgPSBjb3JlID8/IChhd2FpdCBsb2FkQ29yZSgpKTtcbiAgICAkKFwiZGVmYXVsdHN2aWV3XCIpLnRleHRDb250ZW50ID0gSlNPTi5zdHJpbmdpZnkoSlNPTi5wYXJzZShjLmRlZmF1bHRzKCkpLCBudWxsLCAyKTtcbiAgICAkKFwiZGVmYXVsdHN2aWV3XCIpLmhpZGRlbiA9ICEkKFwiZGVmYXVsdHN2aWV3XCIpLmhpZGRlbjtcbiAgfTtcbiAgY29uc3Qgb25DYWxsQ2xpY2sgPSAoKSA9PiB2b2lkIGNhbGxCdXR0b24oKS5jYXRjaCgoZXJyKSA9PiB7IHRvYXN0KGVyci5tZXNzYWdlKTsgbG9nKFwiZXJyb3JcIiwgZXJyLm1lc3NhZ2UsIFwiZXJyXCIpOyB9KTtcbiAgY29uc3Qgb25IZXJvQ2FsbENsaWNrID0gKCkgPT4geyBpZiAoIWNhbGxJZCkgdm9pZCBzdGFydCgpLmNhdGNoKChlcnIpID0+IHsgdG9hc3QoZXJyLm1lc3NhZ2UpOyBsb2coXCJlcnJvclwiLCBlcnIubWVzc2FnZSwgXCJlcnJcIik7IH0pOyB9O1xuICBjb25zdCBvblJlc3VtZUNsaWNrID0gKCkgPT4gdm9pZCBzdGFydCh0cnVlKS5jYXRjaCgoZXJyKSA9PiB7IHRvYXN0KGVyci5tZXNzYWdlKTsgbG9nKFwiZXJyb3JcIiwgZXJyLm1lc3NhZ2UsIFwiZXJyXCIpOyB9KTtcbiAgJChcImNhbGxcIikub25jbGljayA9IG9uQ2FsbENsaWNrO1xuICAkKFwiaGVyby1jYWxsXCIpLm9uY2xpY2sgPSBvbkhlcm9DYWxsQ2xpY2s7XG4gICQoXCJoZXJvLXdha2VcIikub25jbGljayA9ICgpID0+IHtcbiAgICBpZiAod2FrZUFybWVkICYmIGF1ZGlvLmF1ZGlvU3VzcGVuZGVkKSB7IHZvaWQgYXVkaW8ucmVzdW1lQXVkaW8oKS50aGVuKCgpID0+IHN5bmNXYWtlVWkoKSk7IHJldHVybjsgfVxuICAgIHZvaWQgYXJtV2FrZSghd2FrZUFybWVkKTtcbiAgfTtcbiAgJChcIndha2VidG5cIikub25jbGljayA9ICgpID0+IHtcbiAgICBpZiAod2FrZUFybWVkICYmIGF1ZGlvLmF1ZGlvU3VzcGVuZGVkKSB7IHZvaWQgYXVkaW8ucmVzdW1lQXVkaW8oKS50aGVuKCgpID0+IHN5bmNXYWtlVWkoKSk7IHJldHVybjsgfVxuICAgIHZvaWQgYXJtV2FrZSghd2FrZUFybWVkKTtcbiAgfTtcbiAgJChcIndha2Utbm93XCIpLm9uY2xpY2sgPSAoKSA9PiB7XG4gICAgaWYgKGNhbGxJZCkge1xuICAgICAgZmx1c2hEZWZlcnJlZE1pYygpO1xuICAgICAgd2FrZUNsaWVudC5yZXNldCgpO1xuICAgICAgcHVzaCh7IHR5cGU6IFwicmVzdW1lXCIgfSk7XG4gICAgfVxuICB9O1xuICAkKFwicmVzdW1lXCIpLm9uY2xpY2sgPSBvblJlc3VtZUNsaWNrO1xuICAkKFwiaGVyby1yZXN1bWVcIikub25jbGljayA9IG9uUmVzdW1lQ2xpY2s7XG4gIHN5bmNXYWtlVWkoKTtcbiAgaWYgKGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2Uud2FrZS1lbmFibGVkXCIpID09PSBcIjFcIiAmJiB3YWtlTGlzdC5sZW5ndGggPiAwKSB7XG4gICAgLy8gUmUtYXJtIGF1dG9tYXRpY2FsbHkgb24gcmVsb2FkIG9ubHkgd2hlbiBtaWNyb3Bob25lIHBlcm1pc3Npb24gaXMgYWxyZWFkeSBncmFudGVkLlxuICAgIHZvaWQgbmF2aWdhdG9yLnBlcm1pc3Npb25zPy5xdWVyeSh7IG5hbWU6IFwibWljcm9waG9uZVwiIGFzIFBlcm1pc3Npb25OYW1lIH0pXG4gICAgICAudGhlbigocCkgPT4geyBpZiAocC5zdGF0ZSA9PT0gXCJncmFudGVkXCIpIHZvaWQgYXJtV2FrZSh0cnVlLCBmYWxzZSk7IH0pXG4gICAgICAuY2F0Y2goKCkgPT4ge30pO1xuICB9XG4gIGlmIChzYXZlZEhpc3RvcnkoKS5sZW5ndGggPiAwKSB7XG4gICAgc3luY1Jlc3VtZUJ1dHRvbnModHJ1ZSk7XG4gICAgJChcInJlc3VtZVwiKS50aXRsZSA9IFwiQ2FsbCBhZ2FpbiwgY2Fycnlpbmcgb24gZnJvbSB0aGUgbGFzdCBjb252ZXJzYXRpb25cIjtcbiAgfVxuICAkKFwibWljXCIpLm9uY2xpY2sgPSAoKSA9PiBzZXRNdXRlZCghbXV0ZWQpO1xuICAkKFwiaHVzaFwiKS5vbmNsaWNrID0gKCkgPT4geyBwdXNoKHsgdHlwZTogXCJpbnRlcnJ1cHRcIiB9KTsgYXVkaW8uZmx1c2goKTsgfTtcbiAgJChcImNhbmNlbGFsbFwiKS5vbmNsaWNrID0gKCkgPT4gcHVzaCh7IHR5cGU6IFwiY2FuY2VsQWxsXCIgfSk7XG4gICQoXCJkb25lYm94XCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJ0b2dnbGVcIiwgKCkgPT4geyBpZiAoJDxIVE1MRGV0YWlsc0VsZW1lbnQ+KFwiZG9uZWJveFwiKS5vcGVuKSAkKFwiZG9uZWJveFwiKS5zY3JvbGxJbnRvVmlldyh7IGJsb2NrOiBcIm5lYXJlc3RcIiB9KTsgfSk7XG4gICQoXCJzYXlcIikub25zdWJtaXQgPSAoZSkgPT4gdm9pZCBzdWJtaXRUZXh0KGUpO1xuICAkKFwidGV4dFwiKS5hZGRFdmVudExpc3RlbmVyKFwiaW5wdXRcIiwgc3luY0NvbXBvc2VyKTtcbiAgY29uc3QgdHJhbnNjcmlwdFBhbmUgPSAkKFwidHJhbnNjcmlwdFwiKTtcbiAgdHJhbnNjcmlwdFBhbmUuYWRkRXZlbnRMaXN0ZW5lcihcInNjcm9sbFwiLCAoKSA9PiB0cmFuc2NyaXB0U2Nyb2xsLm9uU2Nyb2xsKCksIHsgcGFzc2l2ZTogdHJ1ZSB9KTtcbiAgdHJhbnNjcmlwdFBhbmUuYWRkRXZlbnRMaXN0ZW5lcihcInNjcm9sbGVuZFwiLCAoKSA9PiB0cmFuc2NyaXB0U2Nyb2xsLm9uU2Nyb2xsRW5kKCksIHsgcGFzc2l2ZTogdHJ1ZSB9KTtcbiAgdHJhbnNjcmlwdFBhbmUuYWRkRXZlbnRMaXN0ZW5lcihcIndoZWVsXCIsIChlKSA9PiB7IGlmIChlLmRlbHRhWSA8IDApIHRyYW5zY3JpcHRTY3JvbGwuY2FuY2VsSnVtcCgpOyB9LCB7IHBhc3NpdmU6IHRydWUgfSk7XG4gIHRyYW5zY3JpcHRQYW5lLmFkZEV2ZW50TGlzdGVuZXIoXCJ0b3VjaHN0YXJ0XCIsICgpID0+IHRyYW5zY3JpcHRTY3JvbGwuY2FuY2VsSnVtcCgpLCB7IHBhc3NpdmU6IHRydWUgfSk7XG4gIGlmICh0eXBlb2YgUmVzaXplT2JzZXJ2ZXIgIT09IFwidW5kZWZpbmVkXCIpIHtcbiAgICBuZXcgUmVzaXplT2JzZXJ2ZXIoKCkgPT4gdHJhbnNjcmlwdFNjcm9sbC5vblJlc2l6ZSgpKS5vYnNlcnZlKHRyYW5zY3JpcHRQYW5lKTtcbiAgICBuZXcgUmVzaXplT2JzZXJ2ZXIoKCkgPT4gdXBkYXRlQWxsUmVzdWx0Q2xhbXBpbmcoKSkub2JzZXJ2ZSgkKFwicmVzdWx0c1wiKSk7XG4gIH1cbiAgJChcImp1bXBib3R0b21cIikub25jbGljayA9ICgpID0+IHRyYW5zY3JpcHRTY3JvbGwuanVtcFRvQm90dG9tKCk7XG4gIHN5bmNDb21wb3NlcigpO1xuICBzeW5jU2lkZUxheW91dCgpO1xuICB0YWJzKCk7XG4gIGtleXMoKTtcbiAgY29uc3QgZXZlbnRzID0gbmV3IEV2ZW50U291cmNlKFwiL2V2ZW50c1wiKTtcbiAgZXZlbnRzLmFkZEV2ZW50TGlzdGVuZXIoXCJjb3JlXCIsIChlKSA9PiB7XG4gICAgY29uc3QgeyB2ZXJzaW9uIH0gPSBKU09OLnBhcnNlKChlIGFzIE1lc3NhZ2VFdmVudCkuZGF0YSk7XG4gICAgJChcInZlcnNpb25cIikudGV4dENvbnRlbnQgPSB2ZXJzaW9uICsgKGNhbGxJZCAmJiBjb3JlICYmIGNvcmUudmVyc2lvbiAhPT0gdmVyc2lvbiA/IGAgKG5leHQgY2FsbDsgdGhpcyBvbmUgcnVucyAke2NvcmUudmVyc2lvbn0pYCA6IFwiXCIpO1xuICAgICQoXCJidWlsZFwiKS50ZXh0Q29udGVudCA9IGBjb3JlICR7dmVyc2lvbn1gO1xuICB9KTtcbiAgZXZlbnRzLmFkZEV2ZW50TGlzdGVuZXIoXCJhcHBcIiwgKCkgPT4geyBpZiAoIWNhbGxJZCkgbG9jYXRpb24ucmVsb2FkKCk7IGVsc2UgdG9hc3QoXCJUaGUgcGFnZSBjaGFuZ2VkOiByZWxvYWQgYWZ0ZXIgdGhpcyBjYWxsXCIpOyB9KTtcbiAgZXZlbnRzLmFkZEV2ZW50TGlzdGVuZXIoXCJlcnJvclwiLCAoZSkgPT4ge1xuICAgIGNvbnN0IGRhdGEgPSAoZSBhcyBNZXNzYWdlRXZlbnQpLmRhdGE7XG4gICAgaWYgKGRhdGEpIHRvYXN0KGBCdWlsZCBmYWlsZWQ6ICR7SlNPTi5wYXJzZShkYXRhKS5tZXNzYWdlfWApO1xuICB9KTtcbiAgbmV3IFJlcGxheSgkKFwicmVwbGF5XCIpLCBsb2FkQ29yZSk7XG4gIHZvaWQgcGluZygpO1xuICB2b2lkIHNob3dFYXJsaWVyKCk7XG4gIHdpbmRvdy5zZXRJbnRlcnZhbCgoKSA9PiB2b2lkIHNob3dFYXJsaWVyKCksIDMwXzAwMCk7XG59XG5cbnZvaWQgbWFpbigpO1xuIl0sCiAgIm1hcHBpbmdzIjogIjtBQVNBLElBQU0sU0FBUyxvQkFBSSxJQUFJO0FBQUEsRUFDckI7QUFBQSxFQUFPO0FBQUEsRUFBTTtBQUFBLEVBQVE7QUFBQSxFQUFVO0FBQUEsRUFBTztBQUFBLEVBQVE7QUFBQSxFQUFNO0FBQUEsRUFBTTtBQUFBLEVBQU07QUFBQSxFQUFNO0FBQUEsRUFBVztBQUFBLEVBQVM7QUFBQSxFQUFRO0FBQUEsRUFBTztBQUFBLEVBQVU7QUFBQSxFQUFTO0FBQUEsRUFDNUg7QUFDRixDQUFDO0FBR00sU0FBUyxNQUFNLE1BQXdCO0FBQzVDLFNBQU8sS0FBSyxZQUFZLEVBQUUsUUFBUSxVQUFVLEVBQUUsRUFBRSxRQUFRLHFCQUFxQixHQUFHLEVBQUUsS0FBSyxFQUFFLE1BQU0sR0FBRyxFQUFFLE9BQU8sQ0FBQyxNQUFNLEVBQUUsU0FBUyxDQUFDO0FBQ2hJO0FBR08sU0FBUyxVQUFVLFdBQW1CLFVBQXlCLFFBQWtCLENBQUMsR0FBd0I7QUFDL0csUUFBTSxVQUFVLG9CQUFJLElBQUksQ0FBQyxHQUFHLFFBQVEsR0FBRyxNQUFNLFFBQVEsS0FBSyxDQUFDLENBQUM7QUFDNUQsUUFBTSxPQUFPLE1BQU0sU0FBUztBQUM1QixNQUFJLE9BQU87QUFDWCxNQUFJLEtBQUssS0FBSztBQUNkLFNBQU8sT0FBTyxNQUFNLFFBQVEsSUFBSSxLQUFLLElBQUksQ0FBQyxFQUFHO0FBQzdDLFNBQU8sS0FBSyxRQUFRLFFBQVEsSUFBSSxLQUFLLEtBQUssQ0FBQyxDQUFDLEVBQUc7QUFDL0MsTUFBSSxTQUFTLE1BQU0sS0FBSyxPQUFPLEVBQUcsUUFBTztBQUN6QyxRQUFNQSxRQUFPLEtBQUssTUFBTSxN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WUFBWSxTQUFTO0FBQ3hDLFNBQU8saUJBQWlCLFFBQVEsQ0FBQyxNQUFNO0FBQ3JDLFVBQU0sRUFBRSxRQUFRLElBQUksS0FBSyxNQUFPLEVBQW1CLElBQUk7QUFDdkQsTUFBRSxTQUFTLEVBQUUsY0FBYyxXQUFXLFVBQVUsUUFBUSxLQUFLLFlBQVksVUFBVSw4QkFBOEIsS0FBSyxPQUFPLE1BQU07QUFDbkksTUFBRSxPQUFPLEVBQUUsY0FBYyxRQUFRLE9BQU87QUFBQSxFQUMxQyxDQUFDO0FBQ0QsU0FBTyxpQkFBaUIsT0FBTyxNQUFNO0FBQUUsUUFBSSxDQUFDLE9BQVEsVUFBUyxPQUFPO0FBQUEsUUFBUSxPQUFNLDBDQUEwQztBQUFBLEVBQUcsQ0FBQztBQUNoSSxTQUFPLGlCQUFpQixTQUFTLENBQUMsTUFBTTtBQUN0QyxVQUFNLE9BQVEsRUFBbUI7QUFDakMsUUFBSSxLQUFNLE9BQU0saUJBQWlCLEtBQUssTUFBTSxJQUFJLEVBQUUsT0FBTyxFQUFFO0FBQUEsRUFDN0QsQ0FBQztBQUNELE1BQUksT0FBTyxFQUFFLFFBQVEsR0FBRyxRQUFRO0FBQ2hDLE9BQUssS0FBSztBQUNWLE9BQUssWUFBWTtBQUNqQixTQUFPLFlBQVksTUFBTSxLQUFLLFlBQVksR0FBRyxHQUFNO0FBQ3JEO0FBRUEsS0FBSyxLQUFLOyIsCiAgIm5hbWVzIjogWyJjb3JlIiwgImNvcmUiLCAibm93IiwgImFjdGl2ZVNlc3Npb24iLCAiY291bnRzIiwgImJ5dGVzVG9CYXNlNjQiLCAibGl2ZSIsICJsaW5lIiwgInJ1biIsICJtb2RlIl0KfQo=
