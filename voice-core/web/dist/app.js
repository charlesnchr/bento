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
  async startMic(onFrame, options) {
    await this.open();
    this.stopMic();
    const context = this.context;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, ...options } });
    this.source = context.createMediaStreamSource(this.stream);
    this.capture = new AudioWorkletNode(context, "capture", { numberOfOutputs: 0 });
    this.capture.port.onmessage = (e) => {
      const frame = new Int16Array(e.data);
      let sum = 0;
      for (const s of frame) sum += s * s;
      this.level = Math.sqrt(sum / frame.length) / 32768;
      onFrame(bytesToBase64(new Uint8Array(e.data)), this.level);
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
  stop() {
    this.stopMic();
    this.playback?.port.postMessage({ type: "stop" });
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
  web: { platform: "web", device: "browser", standbyAfter: 30, hangUpAfter: 300, handOff: "named", supervise: true, vocabulary: ["Hermes", "Bento", "Woodhouse", "T3"] },
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
var APPROVAL_TONE = (() => {
  const rate = 24e3, out = new Int16Array(rate * 0.32);
  for (let i = 0; i < out.length; i++) {
    const t = i / rate, f = t < 0.16 ? 660 : 880, local = t < 0.16 ? t : t - 0.16;
    out[i] = Math.round(Math.sin(2 * Math.PI * f * t) * Math.min(1, local * 60, (0.16 - local) * 60) * 6e3);
  }
  let bin = "";
  const bytes = new Uint8Array(out.buffer);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
})();
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
  standby: "Paused while tasks run \xB7 speak to resume",
  waking: "Resuming\u2026",
  ended: "Ended"
};
function showStatus(message) {
  const typed = Boolean(callId) && medium === "text";
  const speaking = Boolean(callId) && !typed && coreStatus !== "standby" && audio.queued > 0.05;
  const shown = speaking || typed && thinking ? "speaking" : coreStatus;
  $("status").className = shown;
  document.body.dataset.state = callId ? shown : "idle";
  document.body.classList.toggle("in-session", Boolean(callId));
  let text = speaking ? "Speaking" : STATUS_TEXT[coreStatus] ?? coreStatus;
  if (typed && coreStatus !== "ended") text = thinking ? "Writing\u2026" : coreStatus === "working" ? "Chat \xB7 tasks running" : "Chat";
  if (callId && !typed && muted && !holding && !speaking) text += " \xB7 muted";
  if (holding) text = "Talking (hold)";
  if (message) text = `${text}: ${message}`;
  if (coreStatus !== "ended" || message) $("statustext").textContent = text;
  $("hush").classList.toggle("live", speaking || typed && thinking);
  const bar = $("callbar");
  bar.hidden = !callId;
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
      case "mic.start":
      case "mic.restart":
        log("out", c.type, "out");
        void audio.startMic(onMic, micOptions()).catch((err) => {
          log("error", `microphone: ${err.message}`, "err");
          toast(`Microphone: ${err.message}`);
        });
        break;
      case "mic.stop":
        audio.stopMic();
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
        log("out", `wake word ${c.on ? "listening" : "off"}`, "out");
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
      case "status":
        coreStatus = c.status;
        showStatus(c.status === "ended" ? c.message ?? void 0 : void 0);
        log("status", c.status + (c.message ? `: ${c.message}` : ""), "status");
        if (c.status === "ended") {
          if (c.message) note(c.message);
          end();
        }
        break;
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
function onMic(pcm, level) {
  counts.mic++;
  if (level > 0.03 && !(muted && !holding)) {
    metrics.lastVoice = now();
    if (audio.queued < 0.05) metrics.replied = false;
  }
  push({ type: "mic", pcm });
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
  activeSession = ++sessionSeq;
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
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
  } catch {
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
  ending = saveTrace().then(() => {
    if (core && callId) core.dispose(callId);
    callId = 0;
    showTasks();
    showStatus();
  });
  audio.stop();
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
  document.body.dataset.state = "idle";
  document.body.classList.remove("in-session");
  syncResumeButtons(chat.length > 0);
  void showEarlier();
  void wakeLock?.release().catch(() => {
  });
  wakeLock = null;
}
function setMuted(value) {
  if (!callId || muted === value) return;
  muted = value;
  $("mic").classList.toggle("muted", muted);
  push({ type: muted ? "mute" : "unmute" });
  showStatus();
}
async function saveTrace() {
  if (!core || !callId || !checked("trace")) return;
  const kept = JSON.parse(core.trace(callId));
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
function settingsFromStorage() {
  for (const id of ["aec", "stopword", "ptt", "captions", "coding", "fakehermes", "trace"]) {
    const v = localStorage.getItem(`voice.${id}`);
    if (v != null) $(id).checked = v === "1";
    $(id).addEventListener("change", () => localStorage.setItem(`voice.${id}`, checked(id) ? "1" : "0"));
  }
  const delay = localStorage.getItem("voice.fakedelay");
  if (delay) $("fakedelay").value = delay;
  $("fakedelay").addEventListener("change", () => localStorage.setItem("voice.fakedelay", $("fakedelay").value));
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
  };
  $("config").oninput = () => localStorage.setItem("voice-core.config", $("config").value);
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
  $("resume").onclick = onResumeClick;
  $("hero-resume").onclick = onResumeClick;
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL2NvbW1hbmRzLnRzIiwgIi4uL2F1ZGlvLnRzIiwgIi4uL3JlcGxheS50cyIsICIuLi9zY3JvbGwudHMiLCAiLi4vdWkudHMiLCAiLi4vYXBwLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBTcG9rZW4gY29tbWFuZHMgdGhlIGNvcmUgYWN0cyBvbiB3aXRob3V0IHRoZSBtb2RlbDogXCJzdG9wXCIgYW5kIFwiaGFuZyB1cFwiLiBBbiB1dHRlcmFuY2UgY291bnRzXG4vLyBvbmx5IHdoZW4gaXQgaXMgb25lIG9mIHRoZSBwaHJhc2VzIGFuZCBub3RoaW5nIG1vcmUsIG9uY2UgbmFtZXMgYW5kIGZpbGxlcnMgYXJvdW5kIGl0IGFyZSBnb25lLFxuLy8gc28gXCJXb29kaG91c2UsIHN0b3AgcGxlYXNlXCIgc3RvcHMgYW5kIFwic3RvcCB0aGUgUGVubnl3b3J0aCB0YXNrXCIgZ29lcyB0byB0aGUgbW9kZWwgYXMgdXN1YWwuXG5cbmltcG9ydCB0eXBlIHsgVm9pY2VDb21tYW5kcyB9IGZyb20gXCIuL3R5cGVzLnRzXCI7XG5cbmV4cG9ydCB0eXBlIFZvaWNlQ29tbWFuZCA9IFwic3RvcFwiIHwgXCJoYW5nVXBcIiB8IFwiY2FuY2VsQWxsXCI7XG5cbi8qKiBXb3JkcyB0aGF0IG1heSBjb21lIGJlZm9yZSBvciBhZnRlciBhIGNvbW1hbmQgd2l0aG91dCBjaGFuZ2luZyBpdC4gKi9cbmNvbnN0IEZJTExFUiA9IG5ldyBTZXQoW1xuICBcImhleVwiLCBcIm9rXCIsIFwib2theVwiLCBcInBsZWFzZVwiLCBcIm5vd1wiLCBcImp1c3RcIiwgXCJzb1wiLCBcInVtXCIsIFwidWhcIiwgXCJvaFwiLCBcImFscmlnaHRcIiwgXCJyaWdodFwiLCBcInllYWhcIiwgXCJ5ZXNcIiwgXCJ0aGFua3NcIiwgXCJ0aGFua1wiLCBcInlvdVwiLFxuICBcImdlbWluaVwiLFxuXSk7XG5cbi8qKiBbdGV4dF0gYXMgbG93ZXItY2FzZSB3b3JkcywgYXBvc3Ryb3BoZXMgZHJvcHBlZCAoXCJUaGF0J3NcIiBpcyBcInRoYXRzXCIpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdvcmRzKHRleHQ6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIHRleHQudG9Mb3dlckNhc2UoKS5yZXBsYWNlKC9bJ1x1MjAxOWBdL2csIFwiXCIpLnJlcGxhY2UoL1teXFxwe0x9XFxwe05kfV0rL2d1LCBcIiBcIikudHJpbSgpLnNwbGl0KFwiIFwiKS5maWx0ZXIoKHcpID0+IHcubGVuZ3RoID4gMCk7XG59XG5cbi8qKiBUaGUgY29tbWFuZCBbdXR0ZXJhbmNlXSBpcywgaWYgaXQncyBvbmUgYW5kIG5vdGhpbmcgbW9yZTsgW25hbWVzXSAodGhlIGFzc2lzdGFudCdzLCBcIldvb2Rob3VzZVwiKSBkb24ndCBjb3VudC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb21tYW5kSW4odXR0ZXJhbmNlOiBzdHJpbmcsIGNvbW1hbmRzOiBWb2ljZUNvbW1hbmRzLCBuYW1lczogc3RyaW5nW10gPSBbXSk6IFZvaWNlQ29tbWFuZCB8IG51bGwge1xuICBjb25zdCBpZ25vcmVkID0gbmV3IFNldChbLi4uRklMTEVSLCAuLi5uYW1lcy5mbGF0TWFwKHdvcmRzKV0pO1xuICBjb25zdCBzYWlkID0gd29yZHModXR0ZXJhbmNlKTtcbiAgbGV0IGZyb20gPSAwO1xuICBsZXQgdG8gPSBzYWlkLmxlbmd0aDtcbiAgd2hpbGUgKGZyb20gPCB0byAmJiBpZ25vcmVkLmhhcyhzYWlkW2Zyb21dKSkgZnJvbSsrO1xuICB3aGlsZSAodG8gPiBmcm9tICYmIGlnbm9yZWQuaGFzKHNhaWRbdG8gLSAxXSkpIHRvLS07XG4gIGlmIChmcm9tID09PSB0byB8fCB0byAtIGZyb20gPiA1KSByZXR1cm4gbnVsbDtcbiAgY29uc3QgY29yZSA9IHNhaWQuc2xpY2UoZnJvbSwgdG8pLmpvaW4oXCIgXCIpO1xuICBjb25zdCBpcyA9IChwaHJhc2VzOiBzdHJpbmdbXSkgPT4gcGhyYXNlcy5zb21lKChwKSA9PiB3b3JkcyhwKS5qb2luKFwiIFwiKSA9PT0gY29yZSk7XG4gIGlmIChpcyhjb21tYW5kcy5oYW5nVXApKSByZXR1cm4gXCJoYW5nVXBcIjtcbiAgaWYgKGlzKGNvbW1hbmRzLmNhbmNlbEFsbCA/PyBbXSkpIHJldHVybiBcImNhbmNlbEFsbFwiO1xuICBpZiAoaXMoY29tbWFuZHMuc3RvcCkpIHJldHVybiBcInN0b3BcIjtcbiAgcmV0dXJuIG51bGw7XG59XG5cbi8qKiBXb3JkcyB0aGF0IHRha2UgYSByZXF1ZXN0IGJhY2suICovXG5jb25zdCBDQU5DRUxTID0gL1xcYig/OmNhbmNlbFxcdyp8YWJvcnRcXHcqfGtpbGx8c2NyYXB8c2NyYXRjaHxkcm9wfGZvcmdldHx1bmRvfHRlcm1pbmF0ZXxuZXZlciA/bWluZHxjYWxsICg/Oml0fHRoYXR8dGhpcykgb2ZmfCg/OmRvbnR8ZG8gbm90KSAoPzpib3RoZXJ8bmVlZHx3YW50fGRvKXxubyBuZWVkfG5vIGxvbmdlcnxub3QgYW55bW9yZXxsZWF2ZSBpdHxza2lwICg/Oml0fHRoYXQpKVxcYi87XG5jb25zdCBTVE9QUyA9IC9cXGIoPzpzdG9wXFx3KnxoYWx0fHF1aXR8ZW5kKVxcYi87XG5cbi8qKlxuICogV2hldGhlciBbdXR0ZXJhbmNlXSBhc2tzIGZvciBhIHRhc2sgdG8gYmUgY2FuY2VsbGVkLCBmb3IgYSBjYW5jZWxfdGFzayB0aGUgbW9kZWwgY2FsbGVkIG9uIGl0LiBcIlN0b3BcIiBhbG9uZSBhbmQgdGhlXG4gKiBvdGhlciBzdG9wIGFuZCBoYW5nLXVwIHBocmFzZXMgZG9uJ3Q6IHRoZXkgbWVhbiBzdG9wIHRhbGtpbmcuIE90aGVyd2lzZSBpdCBkb2VzIHdoZW4gaXQgc2F5cyBzbyBpbiB3b3Jkcywgd2hlbiBpdFxuICogbmFtZXMgdGhlIHRhc2sgKFtuYW1lZF0pLCBvciB3aGVuIGl0IHNheXMgdG8gc3RvcCBzb21ldGhpbmcgbW9yZSB0aGFuIHRoZSB0YWxraW5nIChcInN0b3Agd29ya2luZyBvbiB0aGF0XCIpLlxuICogV29yZHMgdGhhdCBzYXkgbm9uZSBvZiB0aGlzIChhIG1pc2hlYXJpbmcgc3VjaCBhcyBcIlN0YWJpdFwiKSBkb24ndC4gV2l0aCBub3RoaW5nIGhlYXJkIHRoZXJlIGlzIG5vdGhpbmcgdG8ganVkZ2UgYnkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhc2tzVG9DYW5jZWwodXR0ZXJhbmNlOiBzdHJpbmcsIGNvbW1hbmRzOiBWb2ljZUNvbW1hbmRzLCBuYW1lczogc3RyaW5nW10sIG5hbWVkOiBib29sZWFuKTogYm9vbGVhbiB7XG4gIGNvbnN0IHNhaWQgPSB3b3Jkcyh1dHRlcmFuY2UpLmpvaW4oXCIgXCIpO1xuICBpZiAoc2FpZC5sZW5ndGggPT09IDApIHJldHVybiB0cnVlO1xuICBjb25zdCBjb21tYW5kID0gY29tbWFuZEluKHV0dGVyYW5jZSwgY29tbWFuZHMsIG5hbWVzKTtcbiAgaWYgKGNvbW1hbmQgPT09IFwic3RvcFwiIHx8IGNvbW1hbmQgPT09IFwiaGFuZ1VwXCIpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIGNvbW1hbmQgPT09IFwiY2FuY2VsQWxsXCIgfHwgbmFtZWQgfHwgQ0FOQ0VMUy50ZXN0KHNhaWQpIHx8IFNUT1BTLnRlc3Qoc2FpZCk7XG59XG4iLCAiLy8gVGhlIGJyb3dzZXIncyBtaWNyb3Bob25lIGFuZCBzcGVha2VyIGZvciBhIGNhbGw6IDE2IGtIeiBQQ00xNiBmcmFtZXMgb3V0IG9mIHRoZSBtaWNyb3Bob25lLFxuLy8gMjQga0h6IFBDTTE2IGludG8gdGhlIHNwZWFrZXIsIGFuZCB0b25lcyBsYWlkIG92ZXIgd2hhdGV2ZXIgcGxheXMuIEJvdGggcnVuIGluIEF1ZGlvV29ya2xldHMgb25cbi8vIG9uZSBBdWRpb0NvbnRleHQgYXQgdGhlIGRldmljZSdzIHJhdGUsIHJlc2FtcGxpbmcgdGhlcmUuXG5cbmNvbnN0IFdPUktMRVRTID0gYFxuY2xhc3MgQ2FwdHVyZSBleHRlbmRzIEF1ZGlvV29ya2xldFByb2Nlc3NvciB7XG4gIGNvbnN0cnVjdG9yKCkge1xuICAgIHN1cGVyKCk7XG4gICAgdGhpcy5zdGVwID0gc2FtcGxlUmF0ZSAvIDE2MDAwO1xuICAgIHRoaXMucG9zID0gMDtcbiAgICB0aGlzLmZyYW1lID0gbmV3IEludDE2QXJyYXkoMzIwKTtcbiAgICB0aGlzLm4gPSAwO1xuICAgIC8vIEEgd2luZG93ZWQtc2luYyBsb3ctcGFzcyBhdCA3IGtIeiwgc28gbm90aGluZyBhYm92ZSAxNiBrSHoncyA4IGtIeiBsaW1pdCBmb2xkcyBiYWNrIGludG8gc3BlZWNoLlxuICAgIGNvbnN0IHRhcHMgPSA0NywgY3V0ID0gNzAwMCAvIHNhbXBsZVJhdGU7XG4gICAgdGhpcy50YXBzID0gbmV3IEZsb2F0MzJBcnJheSh0YXBzKTtcbiAgICBsZXQgc3VtID0gMDtcbiAgICBmb3IgKGxldCBrID0gMDsgayA8IHRhcHM7IGsrKykge1xuICAgICAgY29uc3QgbSA9IGsgLSAodGFwcyAtIDEpIC8gMjtcbiAgICAgIGNvbnN0IHNpbmMgPSBtID09PSAwID8gMiAqIGN1dCA6IE1hdGguc2luKDIgKiBNYXRoLlBJICogY3V0ICogbSkgLyAoTWF0aC5QSSAqIG0pO1xuICAgICAgY29uc3QgdyA9IDAuNDIgLSAwLjUgKiBNYXRoLmNvcygoMiAqIE1hdGguUEkgKiBrKSAvICh0YXBzIC0gMSkpICsgMC4wOCAqIE1hdGguY29zKCg0ICogTWF0aC5QSSAqIGspIC8gKHRhcHMgLSAxKSk7XG4gICAgICB0aGlzLnRhcHNba10gPSBzaW5jICogdztcbiAgICAgIHN1bSArPSB0aGlzLnRhcHNba107XG4gICAgfVxuICAgIGZvciAobGV0IGsgPSAwOyBrIDwgdGFwczsgaysrKSB0aGlzLnRhcHNba10gLz0gc3VtO1xuICAgIHRoaXMuaGlzdG9yeSA9IG5ldyBGbG9hdDMyQXJyYXkodGFwcyk7XG4gICAgdGhpcy5hdCA9IDA7XG4gIH1cbiAgcHJvY2VzcyhpbnB1dHMpIHtcbiAgICBjb25zdCBpbnB1dCA9IGlucHV0c1swXSAmJiBpbnB1dHNbMF1bMF07XG4gICAgaWYgKCFpbnB1dCkgcmV0dXJuIHRydWU7XG4gICAgY29uc3QgdGFwcyA9IHRoaXMudGFwcywgaCA9IHRoaXMuaGlzdG9yeSwgbiA9IHRhcHMubGVuZ3RoO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgaW5wdXQubGVuZ3RoOyBpKyspIHtcbiAgICAgIGhbdGhpcy5hdF0gPSBpbnB1dFtpXTtcbiAgICAgIHRoaXMuYXQgPSAodGhpcy5hdCArIDEpICUgbjtcbiAgICAgIC8vIE9ubHkgdGhlIHNhbXBsZXMga2VwdCBuZWVkIGZpbHRlcmluZzogYXQgbW9zdCBvbmUgaW4gZXZlcnkgc3RlcC5cbiAgICAgIGlmICh0aGlzLnBvcyA+IDEpIHsgdGhpcy5wb3MgLT0gMTsgY29udGludWU7IH1cbiAgICAgIGxldCB4ID0gMDtcbiAgICAgIGZvciAobGV0IGsgPSAwLCBqID0gdGhpcy5hdDsgayA8IG47IGsrKywgaiA9IGogKyAxID09PSBuID8gMCA6IGogKyAxKSB4ICs9IHRhcHNba10gKiBoW2pdO1xuICAgICAgd2hpbGUgKHRoaXMucG9zIDw9IDEpIHtcbiAgICAgICAgY29uc3QgcyA9IE1hdGgubWF4KC0xLCBNYXRoLm1pbigxLCB4KSk7XG4gICAgICAgIHRoaXMuZnJhbWVbdGhpcy5uKytdID0gcyA8IDAgPyBzICogMzI3NjggOiBzICogMzI3Njc7XG4gICAgICAgIGlmICh0aGlzLm4gPT09IHRoaXMuZnJhbWUubGVuZ3RoKSB7XG4gICAgICAgICAgdGhpcy5wb3J0LnBvc3RNZXNzYWdlKHRoaXMuZnJhbWUuYnVmZmVyLCBbdGhpcy5mcmFtZS5idWZmZXJdKTtcbiAgICAgICAgICB0aGlzLmZyYW1lID0gbmV3IEludDE2QXJyYXkoMzIwKTtcbiAgICAgICAgICB0aGlzLm4gPSAwO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMucG9zICs9IHRoaXMuc3RlcDtcbiAgICAgIH1cbiAgICAgIHRoaXMucG9zIC09IDE7XG4gICAgfVxuICAgIHJldHVybiB0cnVlO1xuICB9XG59XG5cbmNsYXNzIFBsYXliYWNrIGV4dGVuZHMgQXVkaW9Xb3JrbGV0UHJvY2Vzc29yIHtcbiAgY29uc3RydWN0b3IoKSB7XG4gICAgc3VwZXIoKTtcbiAgICB0aGlzLnF1ZXVlID0gW107ICAgICAgLy8gRmxvYXQzMkFycmF5cyBhdCB0aGUgY29udGV4dCdzIHJhdGVcbiAgICB0aGlzLm9mZnNldCA9IDA7XG4gICAgdGhpcy5jdWVzID0gW107XG4gICAgdGhpcy5jdWVPZmZzZXQgPSAwO1xuICAgIHRoaXMucmVwb3J0ZWQgPSAwO1xuICAgIHRoaXMucG9ydC5vbm1lc3NhZ2UgPSAoZSkgPT4ge1xuICAgICAgY29uc3QgbSA9IGUuZGF0YTtcbiAgICAgIGlmIChtLnR5cGUgPT09IFwicGxheVwiKSB0aGlzLnF1ZXVlLnB1c2gobS5zYW1wbGVzKTtcbiAgICAgIGVsc2UgaWYgKG0udHlwZSA9PT0gXCJjdWVcIikgdGhpcy5jdWVzLnB1c2gobS5zYW1wbGVzKTtcbiAgICAgIGVsc2UgaWYgKG0udHlwZSA9PT0gXCJmbHVzaFwiKSB7IHRoaXMucXVldWUgPSBbXTsgdGhpcy5vZmZzZXQgPSAwOyB9XG4gICAgICBlbHNlIGlmIChtLnR5cGUgPT09IFwic3RvcFwiKSB7IHRoaXMucXVldWUgPSBbXTsgdGhpcy5vZmZzZXQgPSAwOyB0aGlzLmN1ZXMgPSBbXTsgdGhpcy5jdWVPZmZzZXQgPSAwOyB9XG4gICAgfTtcbiAgfVxuICBwcm9jZXNzKF8sIG91dHB1dHMpIHtcbiAgICBjb25zdCBvdXQgPSBvdXRwdXRzWzBdWzBdO1xuICAgIG91dC5maWxsKDApO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgb3V0Lmxlbmd0aCAmJiB0aGlzLnF1ZXVlLmxlbmd0aDsgaSsrKSB7XG4gICAgICBvdXRbaV0gPSB0aGlzLnF1ZXVlWzBdW3RoaXMub2Zmc2V0KytdO1xuICAgICAgaWYgKHRoaXMub2Zmc2V0ID49IHRoaXMucXVldWVbMF0ubGVuZ3RoKSB7IHRoaXMucXVldWUuc2hpZnQoKTsgdGhpcy5vZmZzZXQgPSAwOyB9XG4gICAgfVxuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgb3V0Lmxlbmd0aCAmJiB0aGlzLmN1ZXMubGVuZ3RoOyBpKyspIHtcbiAgICAgIG91dFtpXSA9IE1hdGgubWF4KC0xLCBNYXRoLm1pbigxLCBvdXRbaV0gKyB0aGlzLmN1ZXNbMF1bdGhpcy5jdWVPZmZzZXQrK10pKTtcbiAgICAgIGlmICh0aGlzLmN1ZU9mZnNldCA+PSB0aGlzLmN1ZXNbMF0ubGVuZ3RoKSB7IHRoaXMuY3Vlcy5zaGlmdCgpOyB0aGlzLmN1ZU9mZnNldCA9IDA7IH1cbiAgICB9XG4gICAgZm9yIChsZXQgYyA9IDE7IGMgPCBvdXRwdXRzWzBdLmxlbmd0aDsgYysrKSBvdXRwdXRzWzBdW2NdLnNldChvdXQpO1xuICAgIGlmIChjdXJyZW50VGltZSAtIHRoaXMucmVwb3J0ZWQgPiAwLjEpIHtcbiAgICAgIHRoaXMucmVwb3J0ZWQgPSBjdXJyZW50VGltZTtcbiAgICAgIGxldCBxdWV1ZWQgPSAtdGhpcy5vZmZzZXQ7XG4gICAgICBmb3IgKGNvbnN0IHEgb2YgdGhpcy5xdWV1ZSkgcXVldWVkICs9IHEubGVuZ3RoO1xuICAgICAgdGhpcy5wb3J0LnBvc3RNZXNzYWdlKHsgcXVldWVkOiBxdWV1ZWQgLyBzYW1wbGVSYXRlIH0pO1xuICAgIH1cbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxufVxucmVnaXN0ZXJQcm9jZXNzb3IoXCJjYXB0dXJlXCIsIENhcHR1cmUpO1xucmVnaXN0ZXJQcm9jZXNzb3IoXCJwbGF5YmFja1wiLCBQbGF5YmFjayk7XG5gO1xuXG5mdW5jdGlvbiBiYXNlNjRUb0J5dGVzKGI2NDogc3RyaW5nKTogVWludDhBcnJheSB7XG4gIGNvbnN0IGJpbiA9IGF0b2IoYjY0KTtcbiAgY29uc3Qgb3V0ID0gbmV3IFVpbnQ4QXJyYXkoYmluLmxlbmd0aCk7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgYmluLmxlbmd0aDsgaSsrKSBvdXRbaV0gPSBiaW4uY2hhckNvZGVBdChpKTtcbiAgcmV0dXJuIG91dDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGJ5dGVzVG9CYXNlNjQoYnl0ZXM6IFVpbnQ4QXJyYXkpOiBzdHJpbmcge1xuICBsZXQgYmluID0gXCJcIjtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBieXRlcy5sZW5ndGg7IGkgKz0gMHg4MDAwKSBiaW4gKz0gU3RyaW5nLmZyb21DaGFyQ29kZSguLi5ieXRlcy5zdWJhcnJheShpLCBpICsgMHg4MDAwKSk7XG4gIHJldHVybiBidG9hKGJpbik7XG59XG5cbi8qKiBQQ00xNiBsaXR0bGUtZW5kaWFuIGF0IFtyYXRlXSwgYXMgZmxvYXRzIGF0IHRoZSBjb250ZXh0J3MgcmF0ZS4gKi9cbmZ1bmN0aW9uIHRvRmxvYXRzKHBjbTogVWludDhBcnJheSwgcmF0ZTogbnVtYmVyLCB0YXJnZXQ6IG51bWJlcik6IEZsb2F0MzJBcnJheSB7XG4gIGNvbnN0IHZpZXcgPSBuZXcgRGF0YVZpZXcocGNtLmJ1ZmZlciwgcGNtLmJ5dGVPZmZzZXQsIHBjbS5ieXRlTGVuZ3RoKTtcbiAgY29uc3QgbiA9IE1hdGguZmxvb3IocGNtLmJ5dGVMZW5ndGggLyAyKTtcbiAgY29uc3Qgb3V0ID0gbmV3IEZsb2F0MzJBcnJheShNYXRoLmZsb29yKChuICogdGFyZ2V0KSAvIHJhdGUpKTtcbiAgY29uc3Qgc3RlcCA9IHJhdGUgLyB0YXJnZXQ7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgb3V0Lmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgeCA9IGkgKiBzdGVwO1xuICAgIGNvbnN0IGogPSBNYXRoLmZsb29yKHgpO1xuICAgIGNvbnN0IGEgPSB2aWV3LmdldEludDE2KDIgKiBNYXRoLm1pbihqLCBuIC0gMSksIHRydWUpO1xuICAgIGNvbnN0IGIgPSB2aWV3LmdldEludDE2KDIgKiBNYXRoLm1pbihqICsgMSwgbiAtIDEpLCB0cnVlKTtcbiAgICBvdXRbaV0gPSAoYSArIChiIC0gYSkgKiAoeCAtIGopKSAvIDMyNzY4O1xuICB9XG4gIHJldHVybiBvdXQ7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgTWljT3B0aW9ucyB7IGVjaG9DYW5jZWxsYXRpb246IGJvb2xlYW47IG5vaXNlU3VwcHJlc3Npb246IGJvb2xlYW47IGF1dG9HYWluQ29udHJvbDogYm9vbGVhbiB9XG5cbmV4cG9ydCBjbGFzcyBDYWxsQXVkaW8ge1xuICBwcml2YXRlIGNvbnRleHQ6IEF1ZGlvQ29udGV4dCB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIHBsYXliYWNrOiBBdWRpb1dvcmtsZXROb2RlIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgY2FwdHVyZTogQXVkaW9Xb3JrbGV0Tm9kZSB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIHN0cmVhbTogTWVkaWFTdHJlYW0gfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBzb3VyY2U6IE1lZGlhU3RyZWFtQXVkaW9Tb3VyY2VOb2RlIHwgbnVsbCA9IG51bGw7XG4gIC8qKiBTZWNvbmRzIG9mIHNwZWVjaCBxdWV1ZWQsIGFzIHRoZSB3b3JrbGV0IGxhc3Qgc2FpZC4gKi9cbiAgcXVldWVkID0gMDtcbiAgLyoqIFRoZSBtaWNyb3Bob25lJ3MgbGV2ZWwsIFJNUyBvZiB0aGUgbGFzdCBmcmFtZSAoMCB0byAxKS4gKi9cbiAgbGV2ZWwgPSAwO1xuXG4gIGFzeW5jIG9wZW4oKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKHRoaXMuY29udGV4dCkgeyBpZiAodGhpcy5jb250ZXh0LnN0YXRlID09PSBcInN1c3BlbmRlZFwiKSBhd2FpdCB0aGlzLmNvbnRleHQucmVzdW1lKCk7IHJldHVybjsgfVxuICAgIHRoaXMuY29udGV4dCA9IG5ldyBBdWRpb0NvbnRleHQoeyBsYXRlbmN5SGludDogXCJpbnRlcmFjdGl2ZVwiIH0pO1xuICAgIGNvbnN0IHVybCA9IFVSTC5jcmVhdGVPYmplY3RVUkwobmV3IEJsb2IoW1dPUktMRVRTXSwgeyB0eXBlOiBcInRleHQvamF2YXNjcmlwdFwiIH0pKTtcbiAgICBhd2FpdCB0aGlzLmNvbnRleHQuYXVkaW9Xb3JrbGV0LmFkZE1vZHVsZSh1cmwpO1xuICAgIHRoaXMucGxheWJhY2sgPSBuZXcgQXVkaW9Xb3JrbGV0Tm9kZSh0aGlzLmNvbnRleHQsIFwicGxheWJhY2tcIiwgeyBudW1iZXJPZklucHV0czogMCwgb3V0cHV0Q2hhbm5lbENvdW50OiBbMl0gfSk7XG4gICAgdGhpcy5wbGF5YmFjay5wb3J0Lm9ubWVzc2FnZSA9IChlKSA9PiB7IHRoaXMucXVldWVkID0gZS5kYXRhLnF1ZXVlZDsgfTtcbiAgICB0aGlzLnBsYXliYWNrLmNvbm5lY3QodGhpcy5jb250ZXh0LmRlc3RpbmF0aW9uKTtcbiAgfVxuXG4gIC8qKiBTZWNvbmRzIGZyb20gYSBzYW1wbGUgbGVhdmluZyB0aGUgd29ya2xldCB0byB0aGUgc3BlYWtlciwgYXMgdGhlIGJyb3dzZXIgcmVja29ucyBpdC4gKi9cbiAgZ2V0IG91dHB1dExhdGVuY3koKTogbnVtYmVyIHwgbnVsbCB7XG4gICAgaWYgKCF0aGlzLmNvbnRleHQpIHJldHVybiBudWxsO1xuICAgIHJldHVybiB0aGlzLmNvbnRleHQuYmFzZUxhdGVuY3kgKyAoKHRoaXMuY29udGV4dCBhcyBBdWRpb0NvbnRleHQgJiB7IG91dHB1dExhdGVuY3k/OiBudW1iZXIgfSkub3V0cHV0TGF0ZW5jeSA/PyAwKTtcbiAgfVxuXG4gIGFzeW5jIHN0YXJ0TWljKG9uRnJhbWU6IChwY202NDogc3RyaW5nLCBsZXZlbDogbnVtYmVyKSA9PiB2b2lkLCBvcHRpb25zOiBNaWNPcHRpb25zKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgYXdhaXQgdGhpcy5vcGVuKCk7XG4gICAgdGhpcy5zdG9wTWljKCk7XG4gICAgY29uc3QgY29udGV4dCA9IHRoaXMuY29udGV4dCE7XG4gICAgdGhpcy5zdHJlYW0gPSBhd2FpdCBuYXZpZ2F0b3IubWVkaWFEZXZpY2VzLmdldFVzZXJNZWRpYSh7IGF1ZGlvOiB7IGNoYW5uZWxDb3VudDogMSwgLi4ub3B0aW9ucyB9IH0pO1xuICAgIHRoaXMuc291cmNlID0gY29udGV4dC5jcmVhdGVNZWRpYVN0cmVhbVNvdXJjZSh0aGlzLnN0cmVhbSk7XG4gICAgdGhpcy5jYXB0dXJlID0gbmV3IEF1ZGlvV29ya2xldE5vZGUoY29udGV4dCwgXCJjYXB0dXJlXCIsIHsgbnVtYmVyT2ZPdXRwdXRzOiAwIH0pO1xuICAgIHRoaXMuY2FwdHVyZS5wb3J0Lm9ubWVzc2FnZSA9IChlKSA9PiB7XG4gICAgICBjb25zdCBmcmFtZSA9IG5ldyBJbnQxNkFycmF5KGUuZGF0YSBhcyBBcnJheUJ1ZmZlcik7XG4gICAgICBsZXQgc3VtID0gMDtcbiAgICAgIGZvciAoY29uc3QgcyBvZiBmcmFtZSkgc3VtICs9IHMgKiBzO1xuICAgICAgdGhpcy5sZXZlbCA9IE1hdGguc3FydChzdW0gLyBmcmFtZS5sZW5ndGgpIC8gMzI3Njg7XG4gICAgICBvbkZyYW1lKGJ5dGVzVG9CYXNlNjQobmV3IFVpbnQ4QXJyYXkoZS5kYXRhIGFzIEFycmF5QnVmZmVyKSksIHRoaXMubGV2ZWwpO1xuICAgIH07XG4gICAgdGhpcy5zb3VyY2UuY29ubmVjdCh0aGlzLmNhcHR1cmUpO1xuICB9XG5cbiAgc3RvcE1pYygpOiB2b2lkIHtcbiAgICB0aGlzLnNvdXJjZT8uZGlzY29ubmVjdCgpO1xuICAgIHRoaXMuY2FwdHVyZT8ucG9ydC5jbG9zZSgpO1xuICAgIHRoaXMuc3RyZWFtPy5nZXRUcmFja3MoKS5mb3JFYWNoKCh0KSA9PiB0LnN0b3AoKSk7XG4gICAgdGhpcy5zb3VyY2UgPSBudWxsO1xuICAgIHRoaXMuY2FwdHVyZSA9IG51bGw7XG4gICAgdGhpcy5zdHJlYW0gPSBudWxsO1xuICB9XG5cbiAgcGxheShwY202NDogc3RyaW5nKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLmNvbnRleHQgfHwgIXRoaXMucGxheWJhY2spIHJldHVybjtcbiAgICBjb25zdCBzYW1wbGVzID0gdG9GbG9hdHMoYmFzZTY0VG9CeXRlcyhwY202NCksIDI0MDAwLCB0aGlzLmNvbnRleHQuc2FtcGxlUmF0ZSk7XG4gICAgdGhpcy5wbGF5YmFjay5wb3J0LnBvc3RNZXNzYWdlKHsgdHlwZTogXCJwbGF5XCIsIHNhbXBsZXMgfSwgW3NhbXBsZXMuYnVmZmVyXSk7XG4gIH1cblxuICBjdWUocGNtNjQ6IHN0cmluZyk6IHZvaWQge1xuICAgIGlmICghdGhpcy5jb250ZXh0IHx8ICF0aGlzLnBsYXliYWNrKSByZXR1cm47XG4gICAgY29uc3Qgc2FtcGxlcyA9IHRvRmxvYXRzKGJhc2U2NFRvQnl0ZXMocGNtNjQpLCAyNDAwMCwgdGhpcy5jb250ZXh0LnNhbXBsZVJhdGUpO1xuICAgIHRoaXMucGxheWJhY2sucG9ydC5wb3N0TWVzc2FnZSh7IHR5cGU6IFwiY3VlXCIsIHNhbXBsZXMgfSwgW3NhbXBsZXMuYnVmZmVyXSk7XG4gIH1cblxuICBmbHVzaCgpOiB2b2lkIHtcbiAgICB0aGlzLnBsYXliYWNrPy5wb3J0LnBvc3RNZXNzYWdlKHsgdHlwZTogXCJmbHVzaFwiIH0pO1xuICB9XG5cbiAgc3RvcCgpOiB2b2lkIHtcbiAgICB0aGlzLnN0b3BNaWMoKTtcbiAgICB0aGlzLnBsYXliYWNrPy5wb3J0LnBvc3RNZXNzYWdlKHsgdHlwZTogXCJzdG9wXCIgfSk7XG4gIH1cbn1cbiIsICIvLyBUaGUgcmVwbGF5IHZpZXc6IGEgcmVjb3JkZWQgY2FsbCAoYSB0cmFjZSBmcm9tIGFueSBob3N0LCBvciBhIHNjZW5hcmlvKSBydW4gYWdhaW4gdGhyb3VnaCB0aGVcbi8vIGNvcmUsIGFzIHRoZSBidWlsZCB0aGF0IHJlY29yZGVkIGl0IGRpZCBhbmQgYXMgdGhlIGxhdGVzdCBkb2VzLCBzaWRlIGJ5IHNpZGUuIFdoZXJlIHRoZXkgcGFydFxuLy8gaXMgd2hlcmUgYSBjaGFuZ2UgaW4gc3JjLyBjaGFuZ2VkIHdoYXQgdGhlIGNhbGwgZG9lcyB3aXRoIHRoZSBzYW1lIHdvcmRzIGFuZCB0aGUgc2FtZSBtb2RlbC5cblxuaW50ZXJmYWNlIENvcmUge1xuICB2ZXJzaW9uOiBzdHJpbmc7XG4gIGNyZWF0ZShjb25maWc6IHN0cmluZywgdDogbnVtYmVyKTogc3RyaW5nO1xuICBwdXNoKGlkOiBudW1iZXIsIGV2ZW50OiBzdHJpbmcpOiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBSZWNvcmRpbmcgeyB2ZXJzaW9uPzogc3RyaW5nOyBjb25maWc6IHVua25vd247IHN0YXJ0OiBudW1iZXI7IGV2ZW50czogUmVjb3JkPHN0cmluZywgYW55PltdIH1cblxuLyoqIFdoYXQgYSBjb21tYW5kIG9yIGV2ZW50IGxvb2tzIGxpa2UgaW4gYSB0aW1lbGluZTogYXVkaW8gY3V0IG91dCwgb25lIGxpbmUuICovXG5mdW5jdGlvbiBsaW5lKG86IFJlY29yZDxzdHJpbmcsIGFueT4pOiBzdHJpbmcge1xuICBjb25zdCB0ZXh0ID0gSlNPTi5zdHJpbmdpZnkobykucmVwbGFjZSgvXCIoZGF0YXxwY20pXCI6XCJbQS1aYS16MC05Ky89XXs0MCx9XCIvZywgJ1wiJDFcIjpcIlx1MjAyNlwiJylcbiAgICAucmVwbGFjZSgvXFxcXFwiZGF0YVxcXFxcIjpcXFxcXCJbQS1aYS16MC05Ky89XXs0MCx9XFxcXFwiL2csICdcXFxcXCJkYXRhXFxcXFwiOlxcXFxcIlx1MjAyNlxcXFxcIicpO1xuICByZXR1cm4gdGV4dC5sZW5ndGggPiA0MDAgPyB0ZXh0LnNsaWNlKDAsIDQwMCkgKyBcIlx1MjAyNlwiIDogdGV4dDtcbn1cblxuLyoqIEF1ZGlvIGFuZCB0aWNrcyBzYXkgbm90aGluZyBhIHJlYWRlciBuZWVkczsgdGhlIHJlc3QgZG9lcy4gKi9cbmZ1bmN0aW9uIHRlbGxpbmcobzogUmVjb3JkPHN0cmluZywgYW55Pik6IGJvb2xlYW4ge1xuICBpZiAoby50eXBlID09PSBcIm1pY1wiIHx8IG8udHlwZSA9PT0gXCJ0aWNrXCIgfHwgby50eXBlID09PSBcInBsYXlcIikgcmV0dXJuIGZhbHNlO1xuICBpZiAoby50eXBlID09PSBcIndzLnNlbmRcIiAmJiBTdHJpbmcoby5kYXRhKS5zdGFydHNXaXRoKCd7XCJyZWFsdGltZUlucHV0XCI6e1wiYXVkaW9cIicpKSByZXR1cm4gZmFsc2U7XG4gIGlmIChvLnR5cGUgPT09IFwid3MubWVzc2FnZVwiICYmIFN0cmluZyhvLmRhdGEpLmluY2x1ZGVzKCdcImlubGluZURhdGFcIicpICYmICFTdHJpbmcoby5kYXRhKS5pbmNsdWRlcygnXCJ0dXJuQ29tcGxldGVcIicpKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiB0cnVlO1xufVxuXG5mdW5jdGlvbiBydW4oY29yZTogQ29yZSwgcjogUmVjb3JkaW5nKTogc3RyaW5nW11bXSB7XG4gIGNvbnN0IGNyZWF0ZWQgPSBKU09OLnBhcnNlKGNvcmUuY3JlYXRlKEpTT04uc3RyaW5naWZ5KHIuY29uZmlnKSwgci5zdGFydCkpO1xuICBjb25zdCBvdXQ6IHN0cmluZ1tdW10gPSBbY3JlYXRlZC5jb21tYW5kcy5maWx0ZXIodGVsbGluZykubWFwKGxpbmUpXTtcbiAgZm9yIChjb25zdCBlIG9mIHIuZXZlbnRzKSBvdXQucHVzaCgoSlNPTi5wYXJzZShjb3JlLnB1c2goY3JlYXRlZC5pZCwgSlNPTi5zdHJpbmdpZnkoZSkpKSBhcyBSZWNvcmQ8c3RyaW5nLCBhbnk+W10pLmZpbHRlcih0ZWxsaW5nKS5tYXAobGluZSkpO1xuICByZXR1cm4gb3V0O1xufVxuXG5leHBvcnQgY2xhc3MgUmVwbGF5IHtcbiAgcHJpdmF0ZSByZWFkb25seSByb290OiBIVE1MRWxlbWVudDtcbiAgcHJpdmF0ZSByZWFkb25seSBsb2FkOiAodXJsPzogc3RyaW5nKSA9PiBQcm9taXNlPENvcmU+O1xuXG4gIGNvbnN0cnVjdG9yKHJvb3Q6IEhUTUxFbGVtZW50LCBsb2FkOiAodXJsPzogc3RyaW5nKSA9PiBQcm9taXNlPENvcmU+KSB7XG4gICAgdGhpcy5yb290ID0gcm9vdDtcbiAgICB0aGlzLmxvYWQgPSBsb2FkO1xuICAgIHJvb3QuaW5uZXJIVE1MID0gYFxuICAgICAgPGgyPlRyYWNlIHJlcGxheTwvaDI+XG4gICAgICA8ZGl2IGNsYXNzPVwiYmFyXCI+PHNlbGVjdCBjbGFzcz1cInBpY2tcIiBhcmlhLWxhYmVsPVwiUmVjb3JkaW5nXCI+PC9zZWxlY3Q+PGJ1dHRvbiB0eXBlPVwiYnV0dG9uXCIgY2xhc3M9XCJyZWZyZXNoXCIgdGl0bGU9XCJSZWZyZXNoIGxpc3RcIiBhcmlhLWxhYmVsPVwiUmVmcmVzaCBsaXN0XCI+XHUyMUJCPC9idXR0b24+PGJ1dHRvbiB0eXBlPVwiYnV0dG9uXCIgY2xhc3M9XCJnb1wiPlJlcGxheTwvYnV0dG9uPlxuICAgICAgPGxhYmVsIGNsYXNzPVwidG9nZ2xlLWFsbFwiPjxpbnB1dCB0eXBlPVwiY2hlY2tib3hcIiBjbGFzcz1cImFsbFwiPiBTaG93IGF1ZGlvIGFuZCB0aWNrczwvbGFiZWw+PHNwYW4gY2xhc3M9XCJzdW1tYXJ5XCI+PC9zcGFuPjwvZGl2PlxuICAgICAgPGRpdiBjbGFzcz1cInRpbWVsaW5lXCI+PC9kaXY+YDtcbiAgICAocm9vdC5xdWVyeVNlbGVjdG9yKFwiLnJlZnJlc2hcIikgYXMgSFRNTEVsZW1lbnQpLm9uY2xpY2sgPSAoKSA9PiB2b2lkIHRoaXMubGlzdCgpO1xuICAgIChyb290LnF1ZXJ5U2VsZWN0b3IoXCIuZ29cIikgYXMgSFRNTEVsZW1lbnQpLm9uY2xpY2sgPSAoKSA9PiB2b2lkIHRoaXMucmVwbGF5KCkuY2F0Y2goKGVycikgPT4gdGhpcy5zYXkoYFJlcGxheSBmYWlsZWQ6ICR7ZXJyLm1lc3NhZ2V9YCkpO1xuICAgIHZvaWQgdGhpcy5saXN0KCk7XG4gIH1cblxuICBwcml2YXRlIHNheSh0ZXh0OiBzdHJpbmcpIHtcbiAgICAodGhpcy5yb290LnF1ZXJ5U2VsZWN0b3IoXCIuc3VtbWFyeVwiKSBhcyBIVE1MRWxlbWVudCkudGV4dENvbnRlbnQgPSB0ZXh0O1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBsaXN0KCkge1xuICAgIGNvbnN0IHBpY2sgPSB0aGlzLnJvb3QucXVlcnlTZWxlY3RvcihcIi5waWNrXCIpIGFzIEhUTUxTZWxlY3RFbGVtZW50O1xuICAgIHBpY2suaW5uZXJIVE1MID0gXCJcIjtcbiAgICBjb25zdCB0cmFjZXM6IHsgbmFtZTogc3RyaW5nOyBieXRlczogbnVtYmVyIH1bXSA9IGF3YWl0IChhd2FpdCBmZXRjaChcIi90cmFjZXNcIikpLmpzb24oKTtcbiAgICBjb25zdCBzY2VuYXJpb3M6IHN0cmluZ1tdID0gYXdhaXQgKGF3YWl0IGZldGNoKFwiL3NjZW5hcmlvc1wiKSkuanNvbigpO1xuICAgIGNvbnN0IHRyYWNlR3JvdXAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwib3B0Z3JvdXBcIik7XG4gICAgdHJhY2VHcm91cC5sYWJlbCA9IFwiUmVjb3JkZWQgY2FsbHNcIjtcbiAgICBmb3IgKGNvbnN0IHQgb2YgdHJhY2VzKSB0cmFjZUdyb3VwLmFwcGVuZChuZXcgT3B0aW9uKGAke3QubmFtZX0gKCR7TWF0aC5yb3VuZCh0LmJ5dGVzIC8gMTAyNCl9IEtCKWAsIGAvdHJhY2VzLyR7dC5uYW1lfWApKTtcbiAgICBjb25zdCBzY2VuYXJpb0dyb3VwID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcIm9wdGdyb3VwXCIpO1xuICAgIHNjZW5hcmlvR3JvdXAubGFiZWwgPSBcIlNjZW5hcmlvc1wiO1xuICAgIGZvciAoY29uc3QgcyBvZiBzY2VuYXJpb3MpIHNjZW5hcmlvR3JvdXAuYXBwZW5kKG5ldyBPcHRpb24ocywgYC9zY2VuYXJpb3MvJHtzfS5qc29uYCkpO1xuICAgIHBpY2suYXBwZW5kKHRyYWNlR3JvdXAsIHNjZW5hcmlvR3JvdXApO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyByZWNvcmRpbmcodXJsOiBzdHJpbmcpOiBQcm9taXNlPFJlY29yZGluZz4ge1xuICAgIGNvbnN0IHRleHQgPSBhd2FpdCAoYXdhaXQgZmV0Y2godXJsLCB7IGNhY2hlOiBcIm5vLXN0b3JlXCIgfSkpLnRleHQoKTtcbiAgICBpZiAodXJsLmVuZHNXaXRoKFwiLmpzb25cIikpIHJldHVybiBKU09OLnBhcnNlKHRleHQpO1xuICAgIGNvbnN0IFtoZWFkZXIsIC4uLmV2ZW50c10gPSB0ZXh0LnRyaW0oKS5zcGxpdChcIlxcblwiKS5tYXAoKGwpID0+IEpTT04ucGFyc2UobCkpO1xuICAgIHJldHVybiB7IC4uLmhlYWRlciwgZXZlbnRzIH07XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHJlcGxheSgpIHtcbiAgICBjb25zdCB1cmwgPSAodGhpcy5yb290LnF1ZXJ5U2VsZWN0b3IoXCIucGlja1wiKSBhcyBIVE1MU2VsZWN0RWxlbWVudCkudmFsdWU7XG4gICAgaWYgKCF1cmwpIHJldHVybjtcbiAgICBjb25zdCByID0gYXdhaXQgdGhpcy5yZWNvcmRpbmcodXJsKTtcbiAgICBjb25zdCBsYXRlc3QgPSBhd2FpdCB0aGlzLmxvYWQoKTtcbiAgICBsZXQgcmVjb3JkZWQ6IENvcmUgfCBudWxsID0gbnVsbDtcbiAgICBpZiAoci52ZXJzaW9uICYmIHIudmVyc2lvbiAhPT0gbGF0ZXN0LnZlcnNpb24pIHtcbiAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goYC92ZXJzaW9ucy8ke3IudmVyc2lvbn0uanNgLCB7IG1ldGhvZDogXCJIRUFEXCIgfSk7XG4gICAgICBpZiAocmVzcG9uc2Uub2spIHJlY29yZGVkID0gYXdhaXQgdGhpcy5sb2FkKGAvdmVyc2lvbnMvJHtyLnZlcnNpb259LmpzYCk7XG4gICAgfVxuICAgIGNvbnN0IG5vdyA9IHJ1bihsYXRlc3QsIHIpO1xuICAgIGNvbnN0IHRoZW4gPSByZWNvcmRlZCA/IHJ1bihyZWNvcmRlZCwgcikgOiBudWxsO1xuICAgIGNvbnN0IGFsbCA9ICh0aGlzLnJvb3QucXVlcnlTZWxlY3RvcihcIi5hbGxcIikgYXMgSFRNTElucHV0RWxlbWVudCkuY2hlY2tlZDtcbiAgICBjb25zdCB0aW1lbGluZSA9IHRoaXMucm9vdC5xdWVyeVNlbGVjdG9yKFwiLnRpbWVsaW5lXCIpIGFzIEhUTUxFbGVtZW50O1xuICAgIHRpbWVsaW5lLmlubmVySFRNTCA9IFwiXCI7XG4gICAgbGV0IGZpcnN0ID0gLTE7XG4gICAgbGV0IGRpZmZlciA9IDA7XG4gICAgY29uc3Qgcm93czogSFRNTEVsZW1lbnRbXSA9IFtdO1xuICAgIGNvbnN0IGFkZCA9IChjbHM6IHN0cmluZywgdDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpID0+IHtcbiAgICAgIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICByb3cuY2xhc3NOYW1lID0gYHJvdyAke2Nsc31gO1xuICAgICAgcm93LmlubmVySFRNTCA9IGA8c3BhbiBjbGFzcz1cInRcIj4ke3R9PC9zcGFuPmA7XG4gICAgICBjb25zdCBiID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gICAgICBiLmNsYXNzTmFtZSA9IFwiYlwiO1xuICAgICAgYi50ZXh0Q29udGVudCA9IHRleHQ7XG4gICAgICByb3cuYXBwZW5kKGIpO1xuICAgICAgdGltZWxpbmUuYXBwZW5kKHJvdyk7XG4gICAgICByb3dzLnB1c2gocm93KTtcbiAgICAgIHJldHVybiByb3c7XG4gICAgfTtcbiAgICBjb25zdCB0MCA9IHIuc3RhcnQ7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPD0gci5ldmVudHMubGVuZ3RoOyBpKyspIHtcbiAgICAgIGNvbnN0IGUgPSBpID09PSAwID8gbnVsbCA6IHIuZXZlbnRzW2kgLSAxXTtcbiAgICAgIGNvbnN0IG5vd091dCA9IG5vd1tpXTtcbiAgICAgIGNvbnN0IHRoZW5PdXQgPSB0aGVuID8gdGhlbltpXSA6IG5vd091dDtcbiAgICAgIGNvbnN0IHNhbWUgPSBub3dPdXQubGVuZ3RoID09PSB0aGVuT3V0Lmxlbmd0aCAmJiBub3dPdXQuZXZlcnkoKGMsIGopID0+IGMgPT09IHRoZW5PdXRbal0pO1xuICAgICAgaWYgKCFzYW1lKSB7IGRpZmZlcisrOyBpZiAoZmlyc3QgPCAwKSBmaXJzdCA9IGk7IH1cbiAgICAgIGlmICghc2FtZSB8fCBhbGwgfHwgKGUgJiYgdGVsbGluZyhlKSkgfHwgbm93T3V0Lmxlbmd0aCA+IDApIHtcbiAgICAgICAgaWYgKGUgJiYgKGFsbCB8fCB0ZWxsaW5nKGUpIHx8ICFzYW1lKSkgYWRkKFwiaW5cIiwgKGUudCAtIHQwKS50b0ZpeGVkKDIpLCBsaW5lKGUpKTtcbiAgICAgICAgY29uc3QgdCA9IGUgPyAoZS50IC0gdDApLnRvRml4ZWQoMikgOiBcIjAuMDBcIjtcbiAgICAgICAgaWYgKHNhbWUpIGZvciAoY29uc3QgYyBvZiBub3dPdXQpIGFkZChcIm91dFwiLCB0LCBjKTtcbiAgICAgICAgZWxzZSB7XG4gICAgICAgICAgZm9yIChjb25zdCBjIG9mIHRoZW5PdXQpIGFkZChcIm91dCBnb25lXCIsIHQsIGBcdTIyMTIgJHtjfWApO1xuICAgICAgICAgIGZvciAoY29uc3QgYyBvZiBub3dPdXQpIGFkZChcIm91dCBuZXdcIiwgdCwgYCsgJHtjfWApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IHZlcnNpb25zID0gdGhlbiA/IGByZWNvcmRlZCBieSAke3IudmVyc2lvbn0sIHJlcGxheWVkIGJ5IGl0IGFuZCBieSAke2xhdGVzdC52ZXJzaW9ufWAgOiBgcmVwbGF5ZWQgYnkgJHtsYXRlc3QudmVyc2lvbn1gICtcbiAgICAgIChyLnZlcnNpb24gJiYgci52ZXJzaW9uICE9PSBsYXRlc3QudmVyc2lvbiA/IGAgKHRoZSByZWNvcmRpbmcncyBidWlsZCAke3IudmVyc2lvbn0gaXNuJ3Qga2VwdCBoZXJlKWAgOiBcIlwiKTtcbiAgICB0aGlzLnNheShgJHtyLmV2ZW50cy5sZW5ndGh9IGV2ZW50cywgJHt2ZXJzaW9uc30uIGAgKyAodGhlbiA/IChkaWZmZXIgPyBgJHtkaWZmZXJ9IGV2ZW50cyBhbnN3ZXJlZCBkaWZmZXJlbnRseSwgdGhlIGZpcnN0IGF0IGV2ZW50ICR7Zmlyc3R9LmAgOiBcIkJvdGggYW5zd2VyZWQgZXZlcnkgZXZlbnQgdGhlIHNhbWUuXCIpIDogXCJcIikpO1xuICAgIGlmIChmaXJzdCA+PSAwKSB0aW1lbGluZS5xdWVyeVNlbGVjdG9yKFwiLmdvbmUsIC5uZXdcIik/LnNjcm9sbEludG9WaWV3KHsgYmxvY2s6IFwiY2VudGVyXCIgfSk7XG4gIH1cbn1cbiIsICIvKiogTWluaW1hbCBzY3JvbGxpbmcgcGFuZSBzdXJmYWNlIHNvIGF1dG8tc2Nyb2xsIGxvZ2ljIHN0YXlzIHRlc3RhYmxlIHdpdGhvdXQgYSBicm93c2VyIERPTS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgU2Nyb2xsUGFuZSB7XG4gIHNjcm9sbFRvcDogbnVtYmVyO1xuICByZWFkb25seSBzY3JvbGxIZWlnaHQ6IG51bWJlcjtcbiAgcmVhZG9ubHkgY2xpZW50SGVpZ2h0OiBudW1iZXI7XG4gIHNjcm9sbFRvPyhvcHRpb25zOiB7IHRvcDogbnVtYmVyOyBiZWhhdmlvcj86IFNjcm9sbEJlaGF2aW9yIH0pOiB2b2lkO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEF1dG9TY3JvbGxlck9wdGlvbnMge1xuICAvKiogRGlzdGFuY2UgZnJvbSB0aGUgYm90dG9tIChweCkgdGhhdCBzdGlsbCBjb3VudHMgYXMgcGlubmVkLiAqL1xuICBwaW5UaHJlc2hvbGQ/OiBudW1iZXI7XG4gIC8qKiBEaXN0YW5jZSBmcm9tIHRoZSBib3R0b20gKHB4KSBwYXN0IHdoaWNoIHRoZSBqdW1wLXRvLWxhdGVzdCBjb250cm9sIGlzIHNob3duLiAqL1xuICBqdW1wVGhyZXNob2xkPzogbnVtYmVyO1xuICAvKiogQ2FsbGVkIHdoZW5ldmVyIHRoZSBqdW1wLXRvLWxhdGVzdCBjb250cm9sJ3MgdmlzaWJpbGl0eSBtYXkgaGF2ZSBjaGFuZ2VkLiAqL1xuICBvbkp1bXBDaGFuZ2U/OiAoc2hvdzogYm9vbGVhbikgPT4gdm9pZDtcbiAgLyoqIFdoZW4gdHJ1ZSAoZm9yIGV4YW1wbGUgd2hpbGUgdGhlIGVtcHR5IHN0YXRlIGlzIHNob3duKSwga2VlcCB0aGUganVtcCBjb250cm9sIGhpZGRlbi4gKi9cbiAgaXNFbXB0eT86ICgpID0+IGJvb2xlYW47XG59XG5cbi8qKlxuICogS2VlcHMgYSB0cmFuc2NyaXB0IHBhbmUgcGlubmVkIHRvIHRoZSBib3R0b20gYXMgbWVzc2FnZXMgc3RyZWFtIGluLCB3aXRob3V0IG1lYXN1cmluZ1xuICogbmVhci1ib3R0b20gYWZ0ZXIgYW4gYXBwZW5kIGhhcyBhbHJlYWR5IGdyb3duIHNjcm9sbEhlaWdodCwgYW5kIHlpZWxkcyBpbW1lZGlhdGVseSB3aGVuXG4gKiB0aGUgdXNlciBzY3JvbGxzIHVwIHRvIHJlYWQgZWFybGllciBtZXNzYWdlcy5cbiAqL1xuZXhwb3J0IGNsYXNzIEF1dG9TY3JvbGxlciB7XG4gIHByaXZhdGUgcmVhZG9ubHkgcGFuZTogU2Nyb2xsUGFuZTtcbiAgcHJpdmF0ZSByZWFkb25seSBwaW5UaHJlc2hvbGQ6IG51bWJlcjtcbiAgcHJpdmF0ZSByZWFkb25seSBqdW1wVGhyZXNob2xkOiBudW1iZXI7XG4gIHByaXZhdGUgcmVhZG9ubHkgb25KdW1wQ2hhbmdlPzogKHNob3c6IGJvb2xlYW4pID0+IHZvaWQ7XG4gIHByaXZhdGUgcmVhZG9ubHkgaXNFbXB0eT86ICgpID0+IGJvb2xlYW47XG4gIHByaXZhdGUgcGlubmVkID0gdHJ1ZTtcbiAgcHJpdmF0ZSBqdW1waW5nID0gZmFsc2U7XG4gIHByaXZhdGUgbGFzdFNjcm9sbFRvcCA9IDA7XG5cbiAgY29uc3RydWN0b3IocGFuZTogU2Nyb2xsUGFuZSwgb3B0aW9uczogQXV0b1Njcm9sbGVyT3B0aW9ucyA9IHt9KSB7XG4gICAgdGhpcy5wYW5lID0gcGFuZTtcbiAgICB0aGlzLnBpblRocmVzaG9sZCA9IG9wdGlvbnMucGluVGhyZXNob2xkID8/IDMyO1xuICAgIHRoaXMuanVtcFRocmVzaG9sZCA9IG9wdGlvbnMuanVtcFRocmVzaG9sZCA/PyAxMjA7XG4gICAgdGhpcy5vbkp1bXBDaGFuZ2UgPSBvcHRpb25zLm9uSnVtcENoYW5nZTtcbiAgICB0aGlzLmlzRW1wdHkgPSBvcHRpb25zLmlzRW1wdHk7XG4gICAgdGhpcy5sYXN0U2Nyb2xsVG9wID0gcGFuZS5zY3JvbGxUb3A7XG4gIH1cblxuICBnZXQgaXNQaW5uZWQoKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMucGlubmVkO1xuICB9XG5cbiAgcHJpdmF0ZSBkaXN0YW5jZSgpOiBudW1iZXIge1xuICAgIHJldHVybiBNYXRoLm1heCgwLCB0aGlzLnBhbmUuc2Nyb2xsSGVpZ2h0IC0gdGhpcy5wYW5lLnNjcm9sbFRvcCAtIHRoaXMucGFuZS5jbGllbnRIZWlnaHQpO1xuICB9XG5cbiAgcHJpdmF0ZSBpc1Zpc2libGUoKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMucGFuZS5jbGllbnRIZWlnaHQgPiAwO1xuICB9XG5cbiAgcHJpdmF0ZSBzbmFwVG9Cb3R0b20oKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLmlzVmlzaWJsZSgpKSByZXR1cm47XG4gICAgdGhpcy5wYW5lLnNjcm9sbFRvcCA9IHRoaXMucGFuZS5zY3JvbGxIZWlnaHQ7XG4gICAgdGhpcy5sYXN0U2Nyb2xsVG9wID0gdGhpcy5wYW5lLnNjcm9sbFRvcDtcbiAgfVxuXG4gIHByaXZhdGUgdXBkYXRlSnVtcCgpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMub25KdW1wQ2hhbmdlKSByZXR1cm47XG4gICAgY29uc3QgZW1wdHkgPSB0aGlzLmlzRW1wdHk/LigpID8/IGZhbHNlO1xuICAgIGNvbnN0IHNob3cgPSAhZW1wdHkgJiYgdGhpcy5pc1Zpc2libGUoKSAmJiAhdGhpcy5qdW1waW5nICYmIHRoaXMuZGlzdGFuY2UoKSA+IHRoaXMuanVtcFRocmVzaG9sZDtcbiAgICB0aGlzLm9uSnVtcENoYW5nZShzaG93KTtcbiAgfVxuXG4gIC8qKiBDYWxsIGFmdGVyIGNvbnRlbnQgaXMgYWRkZWQsIHVwZGF0ZWQsIG9yIHJlbW92ZWQgaW4gdGhlIHBhbmUuICovXG4gIG9uQ29udGVudChmb3JjZSA9IGZhbHNlKTogdm9pZCB7XG4gICAgaWYgKGZvcmNlKSB7XG4gICAgICB0aGlzLnBpbm5lZCA9IHRydWU7XG4gICAgICB0aGlzLmp1bXBpbmcgPSBmYWxzZTtcbiAgICB9XG4gICAgaWYgKHRoaXMucGlubmVkKSB7XG4gICAgICBpZiAodGhpcy5qdW1waW5nICYmIHRoaXMucGFuZS5zY3JvbGxUbyAmJiB0aGlzLmlzVmlzaWJsZSgpKSB7XG4gICAgICAgIHRoaXMucGFuZS5zY3JvbGxUbyh7IHRvcDogdGhpcy5wYW5lLnNjcm9sbEhlaWdodCwgYmVoYXZpb3I6IFwic21vb3RoXCIgfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aGlzLnNuYXBUb0JvdHRvbSgpO1xuICAgICAgfVxuICAgIH1cbiAgICB0aGlzLnVwZGF0ZUp1bXAoKTtcbiAgfVxuXG4gIC8qKiBDYWxsIHdoZW4gdGhlIHBhbmUncyB2aWV3cG9ydCByZXNpemVzIChiYXJzIGFwcGVhcmluZywga2V5Ym9hcmQsIHRhYiBzd2l0Y2gpLiAqL1xuICBvblJlc2l6ZSgpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuaXNWaXNpYmxlKCkpIHJldHVybjtcbiAgICBpZiAodGhpcy5waW5uZWQpIHtcbiAgICAgIHRoaXMuanVtcGluZyA9IGZhbHNlO1xuICAgICAgdGhpcy5zbmFwVG9Cb3R0b20oKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5sYXN0U2Nyb2xsVG9wID0gdGhpcy5wYW5lLnNjcm9sbFRvcDtcbiAgICB9XG4gICAgdGhpcy51cGRhdGVKdW1wKCk7XG4gIH1cblxuICAvKiogQ2FsbCBmcm9tIHRoZSBwYW5lJ3Mgc2Nyb2xsIGV2ZW50IGxpc3RlbmVyLiAqL1xuICBvblNjcm9sbCgpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuaXNWaXNpYmxlKCkpIHJldHVybjtcbiAgICBjb25zdCB0b3AgPSB0aGlzLnBhbmUuc2Nyb2xsVG9wO1xuICAgIGNvbnN0IGRpc3QgPSB0aGlzLmRpc3RhbmNlKCk7XG4gICAgY29uc3QgbW92ZWRVcCA9IHRvcCA8IHRoaXMubGFzdFNjcm9sbFRvcDtcbiAgICB0aGlzLmxhc3RTY3JvbGxUb3AgPSB0b3A7XG5cbiAgICBpZiAoZGlzdCA8PSB0aGlzLnBpblRocmVzaG9sZCkge1xuICAgICAgdGhpcy5waW5uZWQgPSB0cnVlO1xuICAgICAgdGhpcy5qdW1waW5nID0gZmFsc2U7XG4gICAgfSBlbHNlIGlmIChtb3ZlZFVwKSB7XG4gICAgICB0aGlzLnBpbm5lZCA9IGZhbHNlO1xuICAgICAgdGhpcy5qdW1waW5nID0gZmFsc2U7XG4gICAgfVxuICAgIHRoaXMudXBkYXRlSnVtcCgpO1xuICB9XG5cbiAgLyoqIENhbGwgZnJvbSB0aGUgcGFuZSdzIHNjcm9sbGVuZCBldmVudCBsaXN0ZW5lci4gKi9cbiAgb25TY3JvbGxFbmQoKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLmlzVmlzaWJsZSgpIHx8ICF0aGlzLmp1bXBpbmcpIHJldHVybjtcbiAgICB0aGlzLmp1bXBpbmcgPSBmYWxzZTtcbiAgICBpZiAodGhpcy5kaXN0YW5jZSgpID4gdGhpcy5waW5UaHJlc2hvbGQpIHRoaXMucGlubmVkID0gZmFsc2U7XG4gICAgdGhpcy51cGRhdGVKdW1wKCk7XG4gIH1cblxuICAvKiogQ2FsbCBvbiB1c2VyIHdoZWVsLXVwIG9yIHRvdWNoc3RhcnQgc28gYW4gYWN0aXZlIHNtb290aCBqdW1wIHlpZWxkcyB0byB0aGUgdXNlci4gKi9cbiAgY2FuY2VsSnVtcCgpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuanVtcGluZykgcmV0dXJuO1xuICAgIHRoaXMuanVtcGluZyA9IGZhbHNlO1xuICAgIGlmICh0aGlzLmlzVmlzaWJsZSgpKSB7XG4gICAgICBjb25zdCB0b3AgPSB0aGlzLnBhbmUuc2Nyb2xsVG9wO1xuICAgICAgaWYgKHRoaXMucGFuZS5zY3JvbGxUbykgdGhpcy5wYW5lLnNjcm9sbFRvKHsgdG9wLCBiZWhhdmlvcjogXCJpbnN0YW50XCIgfSk7XG4gICAgICBlbHNlIHRoaXMucGFuZS5zY3JvbGxUb3AgPSB0b3A7XG4gICAgICB0aGlzLmxhc3RTY3JvbGxUb3AgPSB0aGlzLnBhbmUuc2Nyb2xsVG9wO1xuICAgICAgaWYgKHRoaXMuZGlzdGFuY2UoKSA+IHRoaXMucGluVGhyZXNob2xkKSB0aGlzLnBpbm5lZCA9IGZhbHNlO1xuICAgIH1cbiAgICB0aGlzLnVwZGF0ZUp1bXAoKTtcbiAgfVxuXG4gIC8qKiBSZS1waW4gYW5kIHNjcm9sbCBzbW9vdGhseSB0byB0aGUgYm90dG9tICh1c2VkIGJ5IHRoZSBqdW1wLXRvLWxhdGVzdCBidXR0b24pLiAqL1xuICBqdW1wVG9Cb3R0b20oKTogdm9pZCB7XG4gICAgdGhpcy5waW5uZWQgPSB0cnVlO1xuICAgIGlmICghdGhpcy5pc1Zpc2libGUoKSkge1xuICAgICAgdGhpcy51cGRhdGVKdW1wKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICh0aGlzLmRpc3RhbmNlKCkgPD0gdGhpcy5waW5UaHJlc2hvbGQgfHwgIXRoaXMucGFuZS5zY3JvbGxUbykge1xuICAgICAgdGhpcy5qdW1waW5nID0gZmFsc2U7XG4gICAgICB0aGlzLnNuYXBUb0JvdHRvbSgpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLmp1bXBpbmcgPSB0cnVlO1xuICAgICAgdGhpcy5sYXN0U2Nyb2xsVG9wID0gdGhpcy5wYW5lLnNjcm9sbFRvcDtcbiAgICAgIHRoaXMucGFuZS5zY3JvbGxUbyh7IHRvcDogdGhpcy5wYW5lLnNjcm9sbEhlaWdodCwgYmVoYXZpb3I6IFwic21vb3RoXCIgfSk7XG4gICAgfVxuICAgIHRoaXMudXBkYXRlSnVtcCgpO1xuICB9XG5cbiAgLyoqIFJlY29tcHV0ZSBwaW5uZWQgc3RhdGUgZnJvbSB0aGUgY3VycmVudCBwb3NpdGlvbiBhZnRlciBhIHVzZXItZHJpdmVuIGxheW91dCBjaGFuZ2UgKGUuZy4gZXhwYW5kaW5nIGEgcmVzdWx0KS4gKi9cbiAgc3luY0Zyb21Qb3NpdGlvbigpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuaXNWaXNpYmxlKCkpIHJldHVybjtcbiAgICB0aGlzLmp1bXBpbmcgPSBmYWxzZTtcbiAgICB0aGlzLmxhc3RTY3JvbGxUb3AgPSB0aGlzLnBhbmUuc2Nyb2xsVG9wO1xuICAgIHRoaXMucGlubmVkID0gdGhpcy5kaXN0YW5jZSgpIDw9IHRoaXMucGluVGhyZXNob2xkO1xuICAgIHRoaXMudXBkYXRlSnVtcCgpO1xuICB9XG5cbiAgLyoqIFBhdXNlIGF1dG8tc2Nyb2xsIGV4cGxpY2l0bHkgKGUuZy4gd2hlbiByZXZlYWxpbmcgYW4gb2xkZXIgcmVzdWx0IGNhcmQpLiAqL1xuICB1bnBpbigpOiB2b2lkIHtcbiAgICB0aGlzLnBpbm5lZCA9IGZhbHNlO1xuICAgIHRoaXMuanVtcGluZyA9IGZhbHNlO1xuICAgIHRoaXMudXBkYXRlSnVtcCgpO1xuICB9XG59XG4iLCAiLy8gUHVyZSBVSSBoZWxwZXJzIGZvciB0aGUgVm9pY2Ugd2ViIHN1cmZhY2UgKGRlbnNpdHksIGFnZW50LXBhbmUgZmlsdGVyaW5nLCBjb21wYWN0IHByZXZpZXdzKS5cblxuZXhwb3J0IHR5cGUgU2lkZUZpbHRlciA9IFwiYWxsXCIgfCBcImFjdGl2ZVwiIHwgXCJyZXN1bHRzXCI7XG5leHBvcnQgdHlwZSBEZW5zaXR5ID0gXCJjb21wYWN0XCIgfCBcImNvbWZvcnRhYmxlXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2lkZUNvdW50cyB7XG4gIGFjdGl2ZTogbnVtYmVyO1xuICByZXN1bHRzOiBudW1iZXI7XG4gIGVhcmxpZXI6IG51bWJlcjtcbiAgZG9uZTogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFNpZGVWaXNpYmlsaXR5IHtcbiAgc2hvd1Rhc2tzU2VjdGlvbjogYm9vbGVhbjtcbiAgc2hvd0VtcHR5VGFza3M6IGJvb2xlYW47XG4gIHNob3dSZXN1bHRzU2VjdGlvbjogYm9vbGVhbjtcbiAgc2hvd0VtcHR5UmVzdWx0czogYm9vbGVhbjtcbiAgc2hvd0VhcmxpZXJTZWN0aW9uOiBib29sZWFuO1xuICBzaG93RG9uZVNlY3Rpb246IGJvb2xlYW47XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemVEZW5zaXR5KHZhbHVlOiBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkKTogRGVuc2l0eSB7XG4gIHJldHVybiB2YWx1ZSA9PT0gXCJjb21mb3J0YWJsZVwiID8gXCJjb21mb3J0YWJsZVwiIDogXCJjb21wYWN0XCI7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemVTaWRlRmlsdGVyKHZhbHVlOiBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkKTogU2lkZUZpbHRlciB7XG4gIGlmICh2YWx1ZSA9PT0gXCJhY3RpdmVcIiB8fCB2YWx1ZSA9PT0gXCJyZXN1bHRzXCIpIHJldHVybiB2YWx1ZTtcbiAgcmV0dXJuIFwiYWxsXCI7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVByZWZpeCh0ZXh0OiBzdHJpbmcpOiB7IG1vZGU6IFwiaGVybWVzXCIgfCBcInQzXCIgfCBudWxsOyByZXN0OiBzdHJpbmcgfSB7XG4gIGNvbnN0IG0gPSB0ZXh0Lm1hdGNoKC9eXFwvKHQzfGNvZGV8aHxoZXJtZXMpXFxzKyguKikkL2lzKTtcbiAgaWYgKCFtKSByZXR1cm4geyBtb2RlOiBudWxsLCByZXN0OiB0ZXh0IH07XG4gIHJldHVybiB7IG1vZGU6IC9eKHQzfGNvZGUpJC9pLnRlc3QobVsxXSkgPyBcInQzXCIgOiBcImhlcm1lc1wiLCByZXN0OiBtWzJdLnRyaW0oKSB9O1xufVxuXG4vKiogQSByZXN1bHQgY2FyZCBtYXkgb25seSBzdGVlciBhIHRhc2sgdGhhdCBiZWxvbmdzIHRvIHRoZSBzYW1lIGFjdGl2ZSBzZXNzaW9uICh0YXNrIElEcyByZXN0YXJ0IHBlciBjYWxsKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjYW5Gb2xsb3dVcFJlc3VsdChyZXN1bHRTZXNzaW9uOiBudW1iZXIsIGFjdGl2ZVNlc3Npb246IG51bWJlciwgaGFzVGFzazogYm9vbGVhbik6IGJvb2xlYW4ge1xuICByZXR1cm4gYWN0aXZlU2Vzc2lvbiA+IDAgJiYgcmVzdWx0U2Vzc2lvbiA9PT0gYWN0aXZlU2Vzc2lvbiAmJiBoYXNUYXNrO1xufVxuXG4vKiogVW5yZWFkIG1vYmlsZSByZXN1bHQgYWxlcnRzIG9ubHkgY2xlYXIgb25jZSB0aGUgUmVzdWx0cyBzZWN0aW9uIGlzIGFjdHVhbGx5IHZpc2libGUgdG8gdGhlIHVzZXIuICovXG5leHBvcnQgZnVuY3Rpb24gc2hvdWxkQ2xlYXJVbnJlYWRSZXN1bHRzKGlzTW9iaWxlOiBib29sZWFuLCBkcmF3ZXJPcGVuOiBib29sZWFuLCBmaWx0ZXI6IFNpZGVGaWx0ZXIpOiBib29sZWFuIHtcbiAgcmV0dXJuICFpc01vYmlsZSB8fCAoZHJhd2VyT3BlbiAmJiBmaWx0ZXIgIT09IFwiYWN0aXZlXCIpO1xufVxuXG4vKiogUGljayB0aGUgZmlsdGVyIHRvIHNob3cgd2hlbiB0YXBwaW5nIHRoZSBtb2JpbGUgbGl2ZS1zdGF0dXMgYmFubmVyIHNvIHRoZSBhZHZlcnRpc2VkIGl0ZW0gaXMgdmlzaWJsZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlTW9iaWxlQmFubmVyRmlsdGVyKGN1cnJlbnQ6IFNpZGVGaWx0ZXIsIGFjdGl2ZVRvdGFsOiBudW1iZXIsIHVucmVhZFJlc3VsdHM6IG51bWJlcik6IFNpZGVGaWx0ZXIge1xuICBpZiAoYWN0aXZlVG90YWwgPiAwKSByZXR1cm4gY3VycmVudCA9PT0gXCJyZXN1bHRzXCIgPyBcImFsbFwiIDogY3VycmVudDtcbiAgaWYgKHVucmVhZFJlc3VsdHMgPiAwKSByZXR1cm4gXCJyZXN1bHRzXCI7XG4gIHJldHVybiBjdXJyZW50O1xufVxuXG4vKiogRmxhdHRlbiBhIE1hcmtkb3duIGFnZW50IHJlcGx5IGludG8gYSBzaW5nbGUtbGluZSBwbGFpbi10ZXh0IHByZXZpZXcgZm9yIGlubGluZSBoYW5kb2ZmIGNoaXBzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBsYWluUHJldmlldyh0ZXh0OiBzdHJpbmcsIG1heExlbiA9IDE1MCk6IHN0cmluZyB7XG4gIGNvbnN0IGNsZWFuZWQgPSB0ZXh0XG4gICAgLnJlcGxhY2UoL2BgYFteXFxuXSpcXG4/KFtcXHNcXFNdKj8pYGBgL2csIChfLCBjb2RlOiBzdHJpbmcpID0+IGAgJHtjb2RlLnRyaW0oKX0gYClcbiAgICAucmVwbGFjZSgvXFxbKFteXFxdXFxuXSspXFxdXFwoKGh0dHBzPzpcXC9cXC9bXlxccyldKylcXCkvZywgXCIkMVwiKVxuICAgIC5yZXBsYWNlKC9eI3sxLDZ9XFxzKy9nbSwgXCJcIilcbiAgICAucmVwbGFjZSgvXlxccyooPzpbLSpcdTIwMjJdfFxcZCtbLildKVxccysvZ20sIFwiXCIpXG4gICAgLnJlcGxhY2UoL2AoW15gXFxuXSspYC9nLCBcIiQxXCIpXG4gICAgLnJlcGxhY2UoL1xcKlxcKihbXipcXG5dKylcXCpcXCovZywgXCIkMVwiKVxuICAgIC5yZXBsYWNlKC9fXyhbXl9cXG5dKylfXy9nLCBcIiQxXCIpXG4gICAgLnJlcGxhY2UoL1xccysvZywgXCIgXCIpXG4gICAgLnRyaW0oKTtcbiAgaWYgKGNsZWFuZWQubGVuZ3RoIDw9IG1heExlbikgcmV0dXJuIGNsZWFuZWQ7XG4gIGNvbnN0IGN1dCA9IGNsZWFuZWQuc2xpY2UoMCwgbWF4TGVuKTtcbiAgY29uc3Qgc3BhY2UgPSBjdXQubGFzdEluZGV4T2YoXCIgXCIpO1xuICBjb25zdCBiYXNlID0gc3BhY2UgPiBNYXRoLmZsb29yKG1heExlbiAqIDAuNikgPyBjdXQuc2xpY2UoMCwgc3BhY2UpIDogY3V0O1xuICByZXR1cm4gYCR7YmFzZS5yZXBsYWNlKC9bLiw7Olxccy1dKyQvLCBcIlwiKX1cdTIwMjZgO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0U2hvcnRUaW1lKGRhdGU6IERhdGUpOiBzdHJpbmcge1xuICBjb25zdCBwYWQgPSAobjogbnVtYmVyKSA9PiBTdHJpbmcobikucGFkU3RhcnQoMiwgXCIwXCIpO1xuICByZXR1cm4gYCR7cGFkKGRhdGUuZ2V0SG91cnMoKSl9OiR7cGFkKGRhdGUuZ2V0TWludXRlcygpKX1gO1xufVxuXG4vKiogRGVjaWRlIHdoaWNoIHNlY3Rpb25zIG9mIHRoZSByaWdodC1oYW5kIEFnZW50IFdvcmtzcGFjZSBhcmUgdmlzaWJsZSBmb3IgYSBnaXZlbiBmaWx0ZXIgYW5kIGNvdW50cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlU2lkZVNlY3Rpb25zKGZpbHRlcjogU2lkZUZpbHRlciwgY291bnRzOiBTaWRlQ291bnRzKTogU2lkZVZpc2liaWxpdHkge1xuICBpZiAoZmlsdGVyID09PSBcInJlc3VsdHNcIikge1xuICAgIHJldHVybiB7XG4gICAgICBzaG93VGFza3NTZWN0aW9uOiBmYWxzZSxcbiAgICAgIHNob3dFbXB0eVRhc2tzOiBmYWxzZSxcbiAgICAgIHNob3dSZXN1bHRzU2VjdGlvbjogdHJ1ZSxcbiAgICAgIHNob3dFbXB0eVJlc3VsdHM6IGNvdW50cy5yZXN1bHRzID09PSAwLFxuICAgICAgc2hvd0VhcmxpZXJTZWN0aW9uOiBmYWxzZSxcbiAgICAgIHNob3dEb25lU2VjdGlvbjogZmFsc2UsXG4gICAgfTtcbiAgfVxuICBpZiAoZmlsdGVyID09PSBcImFjdGl2ZVwiKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHNob3dUYXNrc1NlY3Rpb246IHRydWUsXG4gICAgICBzaG93RW1wdHlUYXNrczogY291bnRzLmFjdGl2ZSA9PT0gMCAmJiBjb3VudHMuZWFybGllciA9PT0gMCxcbiAgICAgIHNob3dSZXN1bHRzU2VjdGlvbjogZmFsc2UsXG4gICAgICBzaG93RW1wdHlSZXN1bHRzOiBmYWxzZSxcbiAgICAgIHNob3dFYXJsaWVyU2VjdGlvbjogY291bnRzLmVhcmxpZXIgPiAwLFxuICAgICAgc2hvd0RvbmVTZWN0aW9uOiBjb3VudHMuZG9uZSA+IDAsXG4gICAgfTtcbiAgfVxuICAvLyBcImFsbFwiOiBoaWRlIHRoZSBlbXB0eSBhY3RpdmUtdGFza3MgcGxhY2Vob2xkZXIgYXMgc29vbiBhcyByZXN1bHRzIG9yIGVhcmxpZXIgYWdlbnRzIGV4aXN0XG4gIC8vIHNvIGZpbmlzaGVkIHJlc3BvbnNlcyB0YWtlIHRoZSB0b3Agb2YgdGhlIHBhbmUgd2l0aG91dCB3YXN0ZWQgc3BhY2UuXG4gIGNvbnN0IGhhc0FueXRoaW5nQWJvdmVEb25lID0gY291bnRzLmFjdGl2ZSA+IDAgfHwgY291bnRzLnJlc3VsdHMgPiAwIHx8IGNvdW50cy5lYXJsaWVyID4gMDtcbiAgcmV0dXJuIHtcbiAgICBzaG93VGFza3NTZWN0aW9uOiBjb3VudHMuYWN0aXZlID4gMCB8fCAhaGFzQW55dGhpbmdBYm92ZURvbmUsXG4gICAgc2hvd0VtcHR5VGFza3M6ICFoYXNBbnl0aGluZ0Fib3ZlRG9uZSxcbiAgICBzaG93UmVzdWx0c1NlY3Rpb246IGNvdW50cy5yZXN1bHRzID4gMCxcbiAgICBzaG93RW1wdHlSZXN1bHRzOiBmYWxzZSxcbiAgICBzaG93RWFybGllclNlY3Rpb246IGNvdW50cy5lYXJsaWVyID4gMCxcbiAgICBzaG93RG9uZVNlY3Rpb246IGNvdW50cy5kb25lID4gMCxcbiAgfTtcbn1cbiIsICIvLyBUaGUgd2ViIHN1cmZhY2U6IGEgZm91cnRoIGhvc3QgZm9yIHRoZSB2b2ljZSBjb3JlLCBhbmQgYSBwaG9uZS1mcmllbmRseSB3YXkgdG8gdXNlIGl0IGZvciB3b3JrLlxuLy8gSXQgbG9hZHMgdGhlIGRldiBzZXJ2ZXIncyBsYXRlc3QgYnVpbGQgYXQgZWFjaCBjYWxsLCBzbyBhbiBlZGl0IGluIHNyYy8gaXMgbGl2ZSBvbiB0aGUgbmV4dFxuLy8gY2FsbCwgYW5kIGtlZXBzIGV2ZXJ5IGNhbGwgYXMgYSB0cmFjZSB0aGUgcmVwbGF5IHZpZXcgKGFuZCBhbnkgb3RoZXIgaG9zdCkgY2FuIHJ1biBhZ2Fpbi5cbi8vXG4vLyBUaGUgaG9zdCdzIHBhcnQgaXMgc21hbGw6IHRoZSBtaWNyb3Bob25lIGFuZCBzcGVha2VyIChhdWRpby50cyksIHRoZSBtb2RlbCdzIHNvY2tldCB0aHJvdWdoIHRoZVxuLy8gc2VydmVyJ3MgcmVsYXksIEhlcm1lcyBhbmQgVDMgdGhyb3VnaCB0aGUgc2VydmVyLCBhbmQgdGhlIHNjcmVlbi4gVGhlIGNvcmUgZGVjaWRlcyB0aGUgcmVzdC5cbi8vXG4vLyBUeXBpbmcgd2l0aCBubyBjYWxsIG9uIHN0YXJ0cyBhIGNoYXQgaW5zdGVhZDogdGhlIHNhbWUgY29yZSB3aXRoIGBtZWRpdW06IFwidGV4dFwiYCwgd2hvc2UgcmVxdWVzdHNcbi8vIHRvIHRoZSB0ZXh0IG1vZGVsIGdvIHRocm91Z2ggdGhlIHNlcnZlcidzIC9nZW5lcmF0ZS4gVGFza3MsIGZvbGxvdy11cHMgYW5kIHRoZWlyIGNhcmRzIHdvcmsgYXNcbi8vIGluIGEgY2FsbC4gUHJlc3NpbmcgQ2FsbCBlbmRzIHRoZSBjaGF0IGFuZCBjYXJyaWVzIGl0cyBjb252ZXJzYXRpb24gb24gYnkgdm9pY2UuXG5cbmltcG9ydCB7IGNvbW1hbmRJbiB9IGZyb20gXCIuLi9zcmMvY29tbWFuZHMudHNcIjtcbmltcG9ydCB7IENhbGxBdWRpbyB9IGZyb20gXCIuL2F1ZGlvLnRzXCI7XG5pbXBvcnQgeyBSZXBsYXkgfSBmcm9tIFwiLi9yZXBsYXkudHNcIjtcbmltcG9ydCB7IEF1dG9TY3JvbGxlciB9IGZyb20gXCIuL3Njcm9sbC50c1wiO1xuaW1wb3J0IHtcbiAgY2FuRm9sbG93VXBSZXN1bHQsXG4gIGZvcm1hdFNob3J0VGltZSxcbiAgbm9ybWFsaXplRGVuc2l0eSxcbiAgbm9ybWFsaXplU2lkZUZpbHRlcixcbiAgcGFyc2VQcmVmaXgsXG4gIHBsYWluUHJldmlldyxcbiAgcmVzb2x2ZU1vYmlsZUJhbm5lckZpbHRlcixcbiAgcmVzb2x2ZVNpZGVTZWN0aW9ucyxcbiAgc2hvdWxkQ2xlYXJVbnJlYWRSZXN1bHRzLFxuICB0eXBlIFNpZGVGaWx0ZXIsXG59IGZyb20gXCIuL3VpLnRzXCI7XG5cbmludGVyZmFjZSBDb3JlIHtcbiAgdmVyc2lvbjogc3RyaW5nO1xuICBkZWZhdWx0cygpOiBzdHJpbmc7XG4gIGNyZWF0ZShjb25maWc6IHN0cmluZywgdDogbnVtYmVyKTogc3RyaW5nO1xuICBwdXNoKGlkOiBudW1iZXIsIGV2ZW50OiBzdHJpbmcpOiBzdHJpbmc7XG4gIHRyYWNlKGlkOiBudW1iZXIpOiBzdHJpbmc7XG4gIGRpc3Bvc2UoaWQ6IG51bWJlcik6IHZvaWQ7XG59XG50eXBlIENvbW1hbmQgPSBSZWNvcmQ8c3RyaW5nLCBhbnk+ICYgeyB0eXBlOiBzdHJpbmcgfTtcbmludGVyZmFjZSBTZXJ2ZXJDb25maWcgeyByb3V0ZTogc3RyaW5nOyBtb2RlbDogc3RyaW5nOyBjYXB0aW9uc01vZGVsPzogc3RyaW5nOyB0ZXh0TW9kZWw/OiBzdHJpbmc7IHZlcnNpb246IHN0cmluZzsgaGVybWVzOiBib29sZWFuOyB0Mzogc3RyaW5nW10gfCBudWxsIH1cblxuY29uc3QgJCA9IDxUIGV4dGVuZHMgSFRNTEVsZW1lbnQgPSBIVE1MRWxlbWVudD4oaWQ6IHN0cmluZykgPT4gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoaWQpIGFzIFQ7XG5jb25zdCBub3cgPSAoKSA9PiBwZXJmb3JtYW5jZS5ub3coKSAvIDEwMDA7XG5jb25zdCBjaGVja2VkID0gKGlkOiBzdHJpbmcpID0+ICQ8SFRNTElucHV0RWxlbWVudD4oaWQpLmNoZWNrZWQ7XG5cbi8qKiBUaGUgbGF0ZXN0IGJ1aWxkIGZyb20gdGhlIGRldiBzZXJ2ZXIsIGV2YWx1YXRlZCBhZnJlc2g6IGFuIGVkaXQgaW4gc3JjLyBpcyBpbiB0aGUgbmV4dCBjYWxsLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGxvYWRDb3JlKHVybCA9IFwiL3ZvaWNlLWNvcmUuanNcIik6IFByb21pc2U8Q29yZT4ge1xuICBjb25zdCBzb3VyY2UgPSBhd2FpdCAoYXdhaXQgZmV0Y2godXJsLCB7IGNhY2hlOiBcIm5vLXN0b3JlXCIgfSkpLnRleHQoKTtcbiAgY29uc3Qgc2NvcGU6IHsgVm9pY2VDb3JlPzogQ29yZSB9ID0ge307XG4gIG5ldyBGdW5jdGlvbihcImdsb2JhbFRoaXNcIiwgc291cmNlKShzY29wZSk7XG4gIGlmICghc2NvcGUuVm9pY2VDb3JlKSB0aHJvdyBuZXcgRXJyb3IoXCJ0aGUgYnVuZGxlIGRpZG4ndCBkZWZpbmUgVm9pY2VDb3JlXCIpO1xuICByZXR1cm4gc2NvcGUuVm9pY2VDb3JlO1xufVxuXG4vLyBQcmVzZXRzOiBlYWNoIHN1cmZhY2UncyBzZXR0aW5ncyBhcyBpdHMgYXBwIHdvdWxkIHNldCB0aGVtLlxuXG5jb25zdCBGQUtFX1RWID0gW1xuICB7IG5hbWU6IFwidHZfdm9sdW1lXCIsIGRlc2NyaXB0aW9uOiBcIlNldHMgdGhlIGxpdmluZy1yb29tIFRWJ3Mgdm9sdW1lLCAwIHRvIDEwMC5cIiwgcGFyYW1ldGVyczogeyB0eXBlOiBcIk9CSkVDVFwiLCBwcm9wZXJ0aWVzOiB7IGxldmVsOiB7IHR5cGU6IFwiSU5URUdFUlwiIH0gfSwgcmVxdWlyZWQ6IFtcImxldmVsXCJdIH0gfSxcbiAgeyBuYW1lOiBcInR2X3BhdXNlXCIsIGRlc2NyaXB0aW9uOiBcIlBhdXNlcyBvciByZXN1bWVzIHdoYXQncyBwbGF5aW5nIG9uIHRoZSBUVi5cIiwgcGFyYW1ldGVyczogeyB0eXBlOiBcIk9CSkVDVFwiLCBwcm9wZXJ0aWVzOiB7IHBhdXNlOiB7IHR5cGU6IFwiQk9PTEVBTlwiIH0gfSB9IH0sXG5dO1xuXG5jb25zdCBQUkVTRVRTOiBSZWNvcmQ8c3RyaW5nLCBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4gPSB7XG4gIHdlYjogeyBwbGF0Zm9ybTogXCJ3ZWJcIiwgZGV2aWNlOiBcImJyb3dzZXJcIiwgc3RhbmRieUFmdGVyOiAzMCwgaGFuZ1VwQWZ0ZXI6IDMwMCwgaGFuZE9mZjogXCJuYW1lZFwiLCBzdXBlcnZpc2U6IHRydWUsIHZvY2FidWxhcnk6IFtcIkhlcm1lc1wiLCBcIkJlbnRvXCIsIFwiV29vZGhvdXNlXCIsIFwiVDNcIl0gfSxcbiAgYW5kcm9pZDogeyBwbGF0Zm9ybTogXCJBbmRyb2lkXCIsIGRldmljZTogXCJwaG9uZVwiLCBzdGFuZGJ5QWZ0ZXI6IDIwIH0sXG4gIFwiYW5kcm9pZCB3YWtlIHdvcmRcIjogeyBwbGF0Zm9ybTogXCJBbmRyb2lkXCIsIGRldmljZTogXCJwaG9uZVwiLCBzdGFuZGJ5QWZ0ZXI6IDIwLCBoYW5nVXBBZnRlcjogMTUgfSxcbiAgbWFjb3M6IHsgcGxhdGZvcm06IFwibWFjT1NcIiwgZGV2aWNlOiBcIk1hY1wiLCBzdGFuZGJ5QWZ0ZXI6IDIwIH0sXG4gIGVjaG86IHtcbiAgICBwbGF0Zm9ybTogXCJFY2hvXCIsIGRldmljZTogXCJzcGVha2VyXCIsIGhhbmdVcEFmdGVyOiA2LCBzdGFuZGJ5QWZ0ZXI6IDgsIGVhcmNvbnM6IHRydWUsIHZvY2FidWxhcnk6IFtcIkhlcm1lc1wiLCBcIkJlbnRvXCIsIFwiV29vZGhvdXNlXCJdLFxuICAgIG1pYzogeyB3aGlsZVNwZWFraW5nOiBcIndha2VcIiwgZ2FpbkRiOiAwIH0sIGhvc3RUb29sczogRkFLRV9UVixcbiAgfSxcbn07XG5cbi8vIFN0YXRlLlxuXG5jb25zdCBhdWRpbyA9IG5ldyBDYWxsQXVkaW8oKTtcbmxldCBzZXJ2ZXI6IFNlcnZlckNvbmZpZztcbmxldCBjb3JlOiBDb3JlIHwgbnVsbCA9IG51bGw7XG5sZXQgY2FsbElkID0gMDtcbi8qKiBNb25vdG9uaWMgcGVyLXBhZ2Ugc2Vzc2lvbiBpZCAodW5saWtlIGNvcmUncyBjYWxsSWQvdGFza0lkLCB3aGljaCByZXN0YXJ0IGFmdGVyIGxvYWRDb3JlKCkpLiAqL1xubGV0IHNlc3Npb25TZXEgPSAwO1xubGV0IGFjdGl2ZVNlc3Npb24gPSAwO1xubGV0IGNhbGxOYW1lID0gXCJcIjtcbmxldCB0aWNrZXIgPSAwO1xubGV0IHRyYWNlVGltZXIgPSAwO1xubGV0IHN0YXJ0ZWRBdCA9IG5vdygpO1xuY29uc3Qgc29ja2V0cyA9IG5ldyBNYXA8bnVtYmVyLCBXZWJTb2NrZXQ+KCk7XG4vKiogVGhlIHNvY2tldHMgdG8gdGhlIHRyYW5zY3JpcHRpb24gbW9kZWw6IHRoZWlyIGF1ZGlvIGlzIHRoZSBtb2RlbCdzIGFnYWluLCBzbyBpdCBpc24ndCBjb3VudGVkIG9yIGxvZ2dlZCB0d2ljZS4gKi9cbmNvbnN0IGNhcHRpb25Tb2NrZXRzID0gbmV3IFNldDxudW1iZXI+KCk7XG5jb25zdCBydW5zID0gbmV3IE1hcDxzdHJpbmcsIHsgYWJvcnQ6IEFib3J0Q29udHJvbGxlcjsgYWdlbnQ6IHN0cmluZzsgdGFza0lkOiBzdHJpbmcgfT4oKTtcbmludGVyZmFjZSBUYXNrVmlldyB7IGM6IENvbW1hbmQ7IHNpbmNlOiBudW1iZXI7IGVuZGVkOiBudW1iZXIgfCBudWxsOyB0aHJlYWQ/OiBzdHJpbmc7IHJlc3VsdElkPzogc3RyaW5nOyBhcHByb3ZhbD86IHsgY29tbWFuZDogc3RyaW5nIH0gfVxuY29uc3QgdGFza3MgPSBuZXcgTWFwPHN0cmluZywgVGFza1ZpZXc+KCk7XG5pbnRlcmZhY2UgUmVzdWx0RW50cnkge1xuICBpZDogc3RyaW5nO1xuICBhZ2VudDogc3RyaW5nO1xuICBsYWJlbDogc3RyaW5nO1xuICB0ZXh0OiBzdHJpbmc7XG4gIGZhaWxlZDogYm9vbGVhbjtcbiAgdGFza0lkPzogc3RyaW5nO1xuICBzZXNzaW9uSWQ6IG51bWJlcjtcbiAgY2FyZDogSFRNTEVsZW1lbnQ7XG4gIGhlYWQ6IEhUTUxCdXR0b25FbGVtZW50O1xuICBib2R5OiBIVE1MRWxlbWVudDtcbiAgbW9yZUJ0bjogSFRNTEJ1dHRvbkVsZW1lbnQ7XG4gIGZvbGxvd0J0bj86IEhUTUxCdXR0b25FbGVtZW50O1xuICByZWZSb3c6IEhUTUxCdXR0b25FbGVtZW50O1xufVxuY29uc3QgcmVzdWx0cyA9IG5ldyBNYXA8c3RyaW5nLCBSZXN1bHRFbnRyeT4oKTtcbmxldCBuZXh0UmVzdWx0U2VxID0gMDtcbmxldCBzaWRlRmlsdGVyOiBTaWRlRmlsdGVyID0gXCJhbGxcIjtcbmxldCB1bnJlYWRNb2JpbGVSZXN1bHRzID0gMDtcbmxldCBmbGFzaFRpbWVyID0gMDtcbmxldCBlYXJsaWVyQWN0aXZlQ291bnQgPSAwO1xubGV0IGVhcmxpZXJXYWl0aW5nQ291bnQgPSAwO1xubGV0IGNvdW50cyA9IHsgbWljOiAwLCBwbGF5OiAwLCBzZW50OiAwIH07XG5sZXQgZmFrZVR2TGV2ZWwgPSAxNTtcbmxldCBjb3JlU3RhdHVzID0gXCJpZGxlXCI7XG5sZXQgbXV0ZWQgPSBmYWxzZTtcbmxldCBob2xkaW5nID0gZmFsc2U7XG5sZXQgd2FrZUxvY2s6IHsgcmVsZWFzZSgpOiBQcm9taXNlPHZvaWQ+IH0gfCBudWxsID0gbnVsbDtcbi8qKiBXaGF0IHRoZSBzZXNzaW9uIG9uIHNjcmVlbiBpczogYSB2b2ljZSBjYWxsLCBvciBhIHR5cGVkIGNoYXQgKHRoZSBjb3JlJ3MgbWVkaXVtIFwidGV4dFwiKS4gKi9cbmxldCBtZWRpdW06IFwidm9pY2VcIiB8IFwidGV4dFwiID0gXCJ2b2ljZVwiO1xuLyoqIEEgY2hhdCdzIG1vZGVsIGlzIHdyaXRpbmcgaXRzIGFuc3dlci4gKi9cbmxldCB0aGlua2luZyA9IGZhbHNlO1xuLyoqIEEgY2hhdCdzIHJlcXVlc3RzIHRvIHRoZSB0ZXh0IG1vZGVsIHRoYXQgYXJlIHVuZGVyIHdheS4gKi9cbmNvbnN0IHJlcXVlc3RzID0gbmV3IE1hcDxudW1iZXIsIEFib3J0Q29udHJvbGxlcj4oKTtcbi8qKiBUaGUgbGFzdCBzZXNzaW9uIHdpbmRpbmcgZG93biAoaXRzIHRyYWNlIHNhdmVkLCB0aGUgY29yZSdzIGNhbGwgZGlzcG9zZWQpOiB0aGUgbmV4dCBzdGFydHMgYWZ0ZXIgaXQuICovXG5sZXQgZW5kaW5nOiBQcm9taXNlPHZvaWQ+ID0gUHJvbWlzZS5yZXNvbHZlKCk7XG5cbi8vIFRoZSBjb252ZXJzYXRpb24sIGtlcHQgc28gYSBuZXcgY2FsbCBjYW4gY2Fycnkgb24gZnJvbSBpdCAodGhlIGNvcmUncyBgaGlzdG9yeWAsIHJlY2FwcGVkIHRvIHRoZSBtb2RlbCkuXG5pbnRlcmZhY2UgQ2hhdExpbmUgeyByb2xlOiBcInVzZXJcIiB8IFwiYXNzaXN0YW50XCI7IHNwZWFrZXI/OiBzdHJpbmc7IHRleHQ6IHN0cmluZyB9XG5jb25zdCBISVNUT1JZID0gXCJ2b2ljZS5oaXN0b3J5XCI7XG5jb25zdCBISVNUT1JZX01BWF9BR0UgPSAxMiAqIDM2MDAgKiAxMDAwO1xubGV0IGNoYXQ6IENoYXRMaW5lW10gPSBbXTtcbi8qKiBUaGUgY29yZSdzIG51bWJlciBmb3IgdGhlIGxpbmUgdGhlIGxhc3Qgd29yZHMgd2VyZSByZW1lbWJlcmVkIG9uLCB1bnRpbCBzb21ldGhpbmcgZWxzZSBpcy4gKi9cbmxldCBsYXN0TGluZTogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5cbmZ1bmN0aW9uIHJlbWVtYmVyKHJvbGU6IFwidXNlclwiIHwgXCJhc3Npc3RhbnRcIiwgdGV4dDogc3RyaW5nLCBzcGVha2VyPzogc3RyaW5nLCBqb2luID0gZmFsc2UpIHtcbiAgY29uc3QgbGFzdCA9IGNoYXQuYXQoLTEpO1xuICBpZiAoam9pbiAmJiBsYXN0ICYmIGxhc3Qucm9sZSA9PT0gcm9sZSAmJiBsYXN0LnNwZWFrZXIgPT09IHNwZWFrZXIpIGxhc3QudGV4dCArPSB0ZXh0O1xuICBlbHNlIGNoYXQucHVzaChzcGVha2VyID8geyByb2xlLCBzcGVha2VyLCB0ZXh0IH0gOiB7IHJvbGUsIHRleHQgfSk7XG4gIGlmIChjaGF0Lmxlbmd0aCA+IDIwMCkgY2hhdC5zcGxpY2UoMCwgY2hhdC5sZW5ndGggLSAyMDApO1xuICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShISVNUT1JZLCBKU09OLnN0cmluZ2lmeSh7IGF0OiBEYXRlLm5vdygpLCBjaGF0IH0pKTtcbn1cblxuZnVuY3Rpb24gc2F2ZWRIaXN0b3J5KCk6IENoYXRMaW5lW10ge1xuICB0cnkge1xuICAgIGNvbnN0IHNhdmVkID0gSlNPTi5wYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShISVNUT1JZKSA/PyBcIm51bGxcIik7XG4gICAgcmV0dXJuIHNhdmVkICYmIERhdGUubm93KCkgLSBzYXZlZC5hdCA8IEhJU1RPUllfTUFYX0FHRSAmJiBBcnJheS5pc0FycmF5KHNhdmVkLmNoYXQpID8gc2F2ZWQuY2hhdCA6IFtdO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gW107XG4gIH1cbn1cblxuLyoqIFR3byByaXNpbmcgbm90ZXM6IHNvbWV0aGluZyBvbiB0aGUgc2NyZWVuIG5lZWRzIHRoZSB1c2VyLiBQQ00xNiBhdCAyNCBrSHosIGJhc2U2NC4gKi9cbmNvbnN0IEFQUFJPVkFMX1RPTkUgPSAoKCkgPT4ge1xuICBjb25zdCByYXRlID0gMjQwMDAsIG91dCA9IG5ldyBJbnQxNkFycmF5KHJhdGUgKiAwLjMyKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCB0ID0gaSAvIHJhdGUsIGYgPSB0IDwgMC4xNiA/IDY2MCA6IDg4MCwgbG9jYWwgPSB0IDwgMC4xNiA/IHQgOiB0IC0gMC4xNjtcbiAgICBvdXRbaV0gPSBNYXRoLnJvdW5kKE1hdGguc2luKDIgKiBNYXRoLlBJICogZiAqIHQpICogTWF0aC5taW4oMSwgbG9jYWwgKiA2MCwgKDAuMTYgLSBsb2NhbCkgKiA2MCkgKiA2MDAwKTtcbiAgfVxuICBsZXQgYmluID0gXCJcIjtcbiAgY29uc3QgYnl0ZXMgPSBuZXcgVWludDhBcnJheShvdXQuYnVmZmVyKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBieXRlcy5sZW5ndGg7IGkrKykgYmluICs9IFN0cmluZy5mcm9tQ2hhckNvZGUoYnl0ZXNbaV0pO1xuICByZXR1cm4gYnRvYShiaW4pO1xufSkoKTtcblxuLy8gTGF0ZW5jeTogdGhlIG5ldHdvcmsncyByb3VuZCB0cmlwLCBhbmQgaG93IGxvbmcgYWZ0ZXIgdGhlIHVzZXIgc3RvcHMgdGFsa2luZyB0aGUgcmVwbHkgc3RhcnRzLlxuY29uc3QgbWV0cmljcyA9IHsgcnR0OiBbXSBhcyBudW1iZXJbXSwgcmVwbHk6IFtdIGFzIG51bWJlcltdLCBsYXN0Vm9pY2U6IDAsIGxhc3RQbGF5OiAwLCByZXBsaWVkOiB0cnVlIH07XG5cbmZ1bmN0aW9uIG1lZGlhbih4czogbnVtYmVyW10pOiBudW1iZXIgfCBudWxsIHtcbiAgaWYgKHhzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHMgPSBbLi4ueHNdLnNvcnQoKGEsIGIpID0+IGEgLSBiKTtcbiAgcmV0dXJuIHNbTWF0aC5mbG9vcihzLmxlbmd0aCAvIDIpXTtcbn1cblxuZnVuY3Rpb24gc2hvd01ldHJpY3MoKSB7XG4gIGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBydHQgPSBtZWRpYW4obWV0cmljcy5ydHQpO1xuICBpZiAocnR0ICE9IG51bGwpIHBhcnRzLnB1c2goYCR7TWF0aC5yb3VuZChydHQgKiAxMDAwKX0gbXNgKTtcbiAgY29uc3QgcmVwbHkgPSBtZWRpYW4obWV0cmljcy5yZXBseSk7XG4gIGlmIChyZXBseSAhPSBudWxsKSBwYXJ0cy5wdXNoKGByZXBseSAke21ldHJpY3MucmVwbHkuYXQoLTEpIS50b0ZpeGVkKDEpfXMgKCR7cmVwbHkudG9GaXhlZCgxKX1zIG1lZClgKTtcbiAgY29uc3Qgb3V0ID0gYXVkaW8ub3V0cHV0TGF0ZW5jeTtcbiAgaWYgKG91dCAhPSBudWxsKSBwYXJ0cy5wdXNoKGBhdWRpbyAke01hdGgucm91bmQob3V0ICogMTAwMCl9IG1zYCk7XG4gIGxldCBidWZmZXJlZCA9IDA7XG4gIGZvciAoY29uc3Qgd3Mgb2Ygc29ja2V0cy52YWx1ZXMoKSkgYnVmZmVyZWQgKz0gd3MuYnVmZmVyZWRBbW91bnQ7XG4gIGlmIChidWZmZXJlZCA+IDMyXzAwMCkgcGFydHMucHVzaChgdXBsb2FkICskeyhidWZmZXJlZCAvIDMyXzAwMCkudG9GaXhlZCgxKX1zYCk7XG4gICQoXCJtZXRyaWNzXCIpLnRleHRDb250ZW50ID0gcGFydHMuam9pbihcIiBcdTAwQjcgXCIpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBwaW5nKCkge1xuICBjb25zdCB0ID0gbm93KCk7XG4gIHRyeSB7XG4gICAgYXdhaXQgZmV0Y2goXCIvcGluZ1wiLCB7IGNhY2hlOiBcIm5vLXN0b3JlXCIgfSk7XG4gICAgbWV0cmljcy5ydHQucHVzaChub3coKSAtIHQpO1xuICAgIGlmIChtZXRyaWNzLnJ0dC5sZW5ndGggPiAxMikgbWV0cmljcy5ydHQuc2hpZnQoKTtcbiAgfSBjYXRjaCB7fVxuICBzaG93TWV0cmljcygpO1xufVxuXG4vLyBUaGVtZSAmIGRlbnNpdHkuXG5cbmZ1bmN0aW9uIGFwcGx5VGhlbWUoY2hvaWNlOiBzdHJpbmcpIHtcbiAgY29uc3Qgcm9vdCA9IGRvY3VtZW50LmRvY3VtZW50RWxlbWVudDtcbiAgaWYgKGNob2ljZSA9PT0gXCJkYXJrXCIgfHwgY2hvaWNlID09PSBcImxpZ2h0XCIpIHJvb3QuZGF0YXNldC50aGVtZSA9IGNob2ljZTtcbiAgZWxzZSBkZWxldGUgcm9vdC5kYXRhc2V0LnRoZW1lO1xuICBjb25zdCBkYXJrID0gY2hvaWNlID09PSBcImRhcmtcIiB8fCAoY2hvaWNlICE9PSBcImxpZ2h0XCIgJiYgbWF0Y2hNZWRpYShcIihwcmVmZXJzLWNvbG9yLXNjaGVtZTogZGFyaylcIikubWF0Y2hlcyk7XG4gIGNvbnN0IG1ldGEgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInRoZW1lLWNvbG9yXCIpO1xuICBpZiAobWV0YSkgbWV0YS5zZXRBdHRyaWJ1dGUoXCJjb250ZW50XCIsIGRhcmsgPyBcIiMwZTBmMGZcIiA6IFwiI2Y2ZjVmMFwiKTtcbiAgZm9yIChjb25zdCBidG4gb2YgQXJyYXkuZnJvbShkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxCdXR0b25FbGVtZW50PihcIiN0aGVtZS1waWNrZXIgYnV0dG9uXCIpKSkge1xuICAgIGJ0bi5jbGFzc0xpc3QudG9nZ2xlKFwib25cIiwgYnRuLmRhdGFzZXQudGhlbWUgPT09IChjaG9pY2UgfHwgXCJzeXN0ZW1cIikpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGFwcGx5RGVuc2l0eShjaG9pY2U6IHN0cmluZyB8IG51bGwpIHtcbiAgY29uc3QgZGVuc2l0eSA9IG5vcm1hbGl6ZURlbnNpdHkoY2hvaWNlKTtcbiAgY29uc3Qgcm9vdCA9IGRvY3VtZW50LmRvY3VtZW50RWxlbWVudDtcbiAgaWYgKGRlbnNpdHkgPT09IFwiY29tZm9ydGFibGVcIikgcm9vdC5kYXRhc2V0LmRlbnNpdHkgPSBcImNvbWZvcnRhYmxlXCI7XG4gIGVsc2UgZGVsZXRlIHJvb3QuZGF0YXNldC5kZW5zaXR5O1xuICBmb3IgKGNvbnN0IGJ0biBvZiBBcnJheS5mcm9tKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiI2RlbnNpdHktcGlja2VyIGJ1dHRvblwiKSkpIHtcbiAgICBidG4uY2xhc3NMaXN0LnRvZ2dsZShcIm9uXCIsIGJ0bi5kYXRhc2V0LmRlbnNpdHkgPT09IGRlbnNpdHkpO1xuICB9XG4gIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB1cGRhdGVBbGxSZXN1bHRDbGFtcGluZygpKTtcbn1cblxuLy8gVGhlIHNjcmVlbi5cblxuZnVuY3Rpb24gc2V0Q2FsbEJ1dHRvbihsaXZlOiBib29sZWFuKSB7XG4gIGNvbnN0IGJ0biA9ICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiY2FsbFwiKTtcbiAgYnRuLmNsYXNzTGlzdC50b2dnbGUoXCJsaXZlXCIsIGxpdmUpO1xuICBjb25zdCBsYWJlbCA9IGJ0bi5xdWVyeVNlbGVjdG9yKFwiLmNhbGwtbGFiZWxcIik7XG4gIGlmIChsYWJlbCkgbGFiZWwudGV4dENvbnRlbnQgPSBsaXZlID8gXCJIYW5nIHVwXCIgOiBcIkNhbGxcIjtcbn1cblxuZnVuY3Rpb24gc3luY1Jlc3VtZUJ1dHRvbnMoc2hvdzogYm9vbGVhbikge1xuICAkKFwicmVzdW1lXCIpLmhpZGRlbiA9ICFzaG93O1xuICAkKFwiaGVyby1yZXN1bWVcIikuaGlkZGVuID0gIXNob3c7XG59XG5cbmZ1bmN0aW9uIHN5bmNDb21wb3NlcigpIHtcbiAgY29uc3QgaW5wdXQgPSAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwidGV4dFwiKTtcbiAgY29uc3QgdHJpbW1lZCA9IGlucHV0LnZhbHVlLnRyaW0oKTtcbiAgJChcInNlbmRidG5cIikuY2xhc3NMaXN0LnRvZ2dsZShcInJlYWR5XCIsIHRyaW1tZWQubGVuZ3RoID4gMCk7XG4gIGNvbnN0IHBhcnNlZCA9IHBhcnNlUHJlZml4KHRyaW1tZWQpO1xuICAkKFwibW9kZS13cmFwXCIpLmRhdGFzZXQubW9kZSA9IHBhcnNlZC5tb2RlID8/ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwibW9kZVwiKS52YWx1ZTtcbn1cblxuZnVuY3Rpb24gZm9ybWF0Q2xvY2soc2Vjb25kczogbnVtYmVyKTogc3RyaW5nIHtcbiAgY29uc3QgdG90YWwgPSBNYXRoLm1heCgwLCBNYXRoLmZsb29yKHNlY29uZHMpKTtcbiAgY29uc3QgaCA9IE1hdGguZmxvb3IodG90YWwgLyAzNjAwKTtcbiAgY29uc3QgbSA9IE1hdGguZmxvb3IoKHRvdGFsICUgMzYwMCkgLyA2MCk7XG4gIGNvbnN0IHMgPSB0b3RhbCAlIDYwO1xuICBjb25zdCBwYWQgPSAobjogbnVtYmVyKSA9PiBTdHJpbmcobikucGFkU3RhcnQoMiwgXCIwXCIpO1xuICByZXR1cm4gaCA+IDAgPyBgJHtofToke3BhZChtKX06JHtwYWQocyl9YCA6IGAke3BhZChtKX06JHtwYWQocyl9YDtcbn1cblxuY29uc3QgVklaX1dFSUdIVFMgPSBbMC40OCwgMC44NiwgMS4wLCAwLjc4LCAwLjQ0XTtcbmZ1bmN0aW9uIHVwZGF0ZVZpc3VhbGl6ZXIobW9kZTogc3RyaW5nLCBsZXZlbDogbnVtYmVyKSB7XG4gIGNvbnN0IHZpeiA9ICQoXCJ2aXpcIik7XG4gIHZpei5kYXRhc2V0Lm1vZGUgPSBtb2RlO1xuICBjb25zdCBiYXJzID0gdml6LmNoaWxkcmVuO1xuICBpZiAobW9kZSA9PT0gXCJsaXN0ZW5pbmdcIiB8fCBtb2RlID09PSBcIndvcmtpbmdcIikge1xuICAgIGNvbnN0IGVuZXJneSA9IE1hdGgubWluKDEsIGxldmVsICogMTQpO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYmFycy5sZW5ndGg7IGkrKykge1xuICAgICAgY29uc3QgaCA9IDAuMjQgKyBlbmVyZ3kgKiBWSVpfV0VJR0hUU1tpXSAqIDAuNzY7XG4gICAgICAoYmFyc1tpXSBhcyBIVE1MRWxlbWVudCkuc3R5bGUudHJhbnNmb3JtID0gYHNjYWxlWSgke2gudG9GaXhlZCgyKX0pYDtcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBiYXJzLmxlbmd0aDsgaSsrKSAoYmFyc1tpXSBhcyBIVE1MRWxlbWVudCkuc3R5bGUudHJhbnNmb3JtID0gXCJcIjtcbiAgfVxufVxuXG4vKiogQSBzeXN0ZW0gbm90aWZpY2F0aW9uIHdoaWxlIHRoZSBwYWdlIGlzIGhpZGRlbjogYSB0YXNrIGZpbmlzaGVkLCBvciBvbmUgbmVlZHMgdGhlIHVzZXIuICovXG5mdW5jdGlvbiBub3RpZnkodGl0bGU6IHN0cmluZywgYm9keTogc3RyaW5nKSB7XG4gIGlmICghZG9jdW1lbnQuaGlkZGVuIHx8ICEoXCJOb3RpZmljYXRpb25cIiBpbiB3aW5kb3cpIHx8IE5vdGlmaWNhdGlvbi5wZXJtaXNzaW9uICE9PSBcImdyYW50ZWRcIikgcmV0dXJuO1xuICB0cnkge1xuICAgIGNvbnN0IG4gPSBuZXcgTm90aWZpY2F0aW9uKHRpdGxlLCB7IGJvZHk6IGJvZHkuc2xpY2UoMCwgMTgwKSwgaWNvbjogXCIvd2ViL2ljb25zL2ljb24tMTkyLnBuZ1wiLCB0YWc6IHRpdGxlIH0pO1xuICAgIG4ub25jbGljayA9ICgpID0+IHsgd2luZG93LmZvY3VzKCk7IG4uY2xvc2UoKTsgfTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gUGhvbmVzIHdhbnQgbm90aWZpY2F0aW9ucyBmcm9tIGEgc2VydmljZSB3b3JrZXI7IHRoZSBwYWdlIGhhcyBub25lLlxuICB9XG59XG5cbmZ1bmN0aW9uIHRvYXN0KHRleHQ6IHN0cmluZykge1xuICBjb25zdCB0ID0gJChcInRvYXN0XCIpO1xuICB0LnRleHRDb250ZW50ID0gdGV4dDtcbiAgdC5jbGFzc0xpc3QuYWRkKFwib25cIik7XG4gIGNsZWFyVGltZW91dCgodG9hc3QgYXMgYW55KS50aW1lcik7XG4gICh0b2FzdCBhcyBhbnkpLnRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB0LmNsYXNzTGlzdC5yZW1vdmUoXCJvblwiKSwgMTgwMCk7XG59XG5cbmZ1bmN0aW9uIGxvZyhraW5kOiBzdHJpbmcsIHRleHQ6IHN0cmluZywgY2xzID0gXCJcIikge1xuICBjb25zdCBwYW5lID0gJChcImxvZ1wiKTtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IGByb3cgJHtjbHN9YDtcbiAgcm93LmlubmVySFRNTCA9IGA8c3BhbiBjbGFzcz1cInRcIj4keyhub3coKSAtIHN0YXJ0ZWRBdCkudG9GaXhlZCgyKX08L3NwYW4+PHNwYW4gY2xhc3M9XCJrXCI+JHtraW5kfTwvc3Bhbj5gO1xuICBjb25zdCBib2R5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGJvZHkuY2xhc3NOYW1lID0gXCJiXCI7XG4gIGJvZHkudGV4dENvbnRlbnQgPSB0ZXh0O1xuICByb3cuYXBwZW5kKGJvZHkpO1xuICBjb25zdCBzdGljayA9IHBhbmUuc2Nyb2xsVG9wICsgcGFuZS5jbGllbnRIZWlnaHQgPj0gcGFuZS5zY3JvbGxIZWlnaHQgLSAzMDtcbiAgcGFuZS5hcHBlbmQocm93KTtcbiAgd2hpbGUgKHBhbmUuY2hpbGRFbGVtZW50Q291bnQgPiAzMDAwKSBwYW5lLmZpcnN0RWxlbWVudENoaWxkIS5yZW1vdmUoKTtcbiAgaWYgKHN0aWNrKSBwYW5lLnNjcm9sbFRvcCA9IHBhbmUuc2Nyb2xsSGVpZ2h0O1xufVxuXG4vKiogQSBmcmFtZSBmcm9tIG9yIHRvIEdlbWluaSwgd2l0aCBhdWRpbyBjdXQgb3V0LCBzaG9ydCBlbm91Z2ggdG8gcmVhZC4gKi9cbmZ1bmN0aW9uIGJyaWVmKGRhdGE6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBkYXRhLnJlcGxhY2UoL1wiZGF0YVwiOlwiW0EtWmEtejAtOSsvPV17NDAsfVwiL2csIChtKSA9PiBgXCJkYXRhXCI6XCJcdTIwMjYke01hdGgucm91bmQoKChtLmxlbmd0aCAtIDkpICogMykgLyA0KX0gYnl0ZXNcImApLnNsaWNlKDAsIDYwMCk7XG59XG5cbmZ1bmN0aW9uIGVzY2FwZUh0bWwodGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHRleHQucmVwbGFjZSgvWyY8PlwiJ10vZywgKGMpID0+ICh7IFwiJlwiOiBcIiZhbXA7XCIsIFwiPFwiOiBcIiZsdDtcIiwgXCI+XCI6IFwiJmd0O1wiLCAnXCInOiBcIiZxdW90O1wiLCBcIidcIjogXCImIzM5O1wiIH0pW2NdISk7XG59XG5cbi8qKiBBIGxpdHRsZSBNYXJrZG93biwgc2FmZWx5OiBjb2RlLCBib2xkLCBsaW5rcywgbGlzdHMgYW5kIGhlYWRpbmdzLCB0aGUgcmVzdCBhcyB0ZXh0LiAqL1xuZnVuY3Rpb24gbWFya2Rvd24odGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgYmxvY2tzID0gZXNjYXBlSHRtbCh0ZXh0LnRyaW0oKSkuc3BsaXQoL2BgYCg/OlxcdyspP1xcbj8vKTtcbiAgcmV0dXJuIGJsb2Nrcy5tYXAoKGJsb2NrLCBpKSA9PiB7XG4gICAgaWYgKGkgJSAyID09PSAxKSByZXR1cm4gYDxwcmU+PGNvZGU+JHtibG9jay5yZXBsYWNlKC9cXG4kLywgXCJcIil9PC9jb2RlPjwvcHJlPmA7XG4gICAgY29uc3QgaW5saW5lID0gKHM6IHN0cmluZykgPT4gc1xuICAgICAgLnJlcGxhY2UoL2AoW15gXFxuXSspYC9nLCBcIjxjb2RlPiQxPC9jb2RlPlwiKVxuICAgICAgLnJlcGxhY2UoL1xcKlxcKihbXipcXG5dKylcXCpcXCovZywgXCI8Yj4kMTwvYj5cIilcbiAgICAgIC5yZXBsYWNlKC9cXFsoW15cXF1cXG5dKylcXF1cXCgoaHR0cHM/OlxcL1xcL1teXFxzKV0rKVxcKS9nLCAnPGEgaHJlZj1cIiQyXCIgdGFyZ2V0PVwiX2JsYW5rXCIgcmVsPVwibm9vcGVuZXJcIj4kMTwvYT4nKVxuICAgICAgLnJlcGxhY2UoLyhefFtcXHMoXSkoaHR0cHM/OlxcL1xcL1teXFxzPCldKykvZywgJyQxPGEgaHJlZj1cIiQyXCIgdGFyZ2V0PVwiX2JsYW5rXCIgcmVsPVwibm9vcGVuZXJcIj4kMjwvYT4nKTtcbiAgICBsZXQgaHRtbCA9IFwiXCI7XG4gICAgbGV0IGxpc3Q6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgIGZvciAoY29uc3QgcmF3IG9mIGJsb2NrLnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgICBjb25zdCBpdGVtID0gcmF3Lm1hdGNoKC9eXFxzKig/OlstKlx1MjAyMl18KFxcZCspWy4pXSlcXHMrKC4qKSQvKTtcbiAgICAgIGlmIChpdGVtKSB7XG4gICAgICAgIGNvbnN0IGtpbmQgPSBpdGVtWzFdID8gXCJvbFwiIDogXCJ1bFwiO1xuICAgICAgICBpZiAobGlzdCAhPT0ga2luZCkgeyBpZiAobGlzdCkgaHRtbCArPSBgPC8ke2xpc3R9PmA7IGh0bWwgKz0gYDwke2tpbmR9PmA7IGxpc3QgPSBraW5kOyB9XG4gICAgICAgIGh0bWwgKz0gYDxsaT4ke2lubGluZShpdGVtWzJdKX08L2xpPmA7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgaWYgKGxpc3QpIHsgaHRtbCArPSBgPC8ke2xpc3R9PmA7IGxpc3QgPSBudWxsOyB9XG4gICAgICBjb25zdCBoZWFkaW5nID0gcmF3Lm1hdGNoKC9eI3sxLDZ9XFxzKyguKikkLyk7XG4gICAgICBodG1sICs9IGhlYWRpbmcgPyBgPGRpdiBjbGFzcz1cIm1kLWhcIj4ke2lubGluZShoZWFkaW5nWzFdKX08L2Rpdj5gIDogcmF3LnRyaW0oKSA9PT0gXCJcIiA/IFwiPGJyPlwiIDogYCR7aW5saW5lKHJhdyl9PGJyPmA7XG4gICAgfVxuICAgIGlmIChsaXN0KSBodG1sICs9IGA8LyR7bGlzdH0+YDtcbiAgICByZXR1cm4gaHRtbC5yZXBsYWNlKC8oPGJyPikrJC8sIFwiXCIpO1xuICB9KS5qb2luKFwiXCIpO1xufVxuXG5jb25zdCB0cmFuc2NyaXB0U2Nyb2xsID0gbmV3IEF1dG9TY3JvbGxlcigkKFwidHJhbnNjcmlwdFwiKSwge1xuICBvbkp1bXBDaGFuZ2U6IChzaG93KSA9PiB7ICQoXCJqdW1wYm90dG9tXCIpLmhpZGRlbiA9ICFzaG93OyB9LFxuICBpc0VtcHR5OiAoKSA9PiAhJChcImVtcHR5XCIpLmhpZGRlbixcbn0pO1xuXG5mdW5jdGlvbiBzY3JvbGxEb3duKGZvcmNlID0gZmFsc2UpIHtcbiAgdHJhbnNjcmlwdFNjcm9sbC5vbkNvbnRlbnQoZm9yY2UpO1xufVxuXG4vKiogVGhlIGNvcmUncyBudW1iZXIgZm9yIHRoZSBsaW5lIHRoZSBsYXN0IHJvdyBzaG93cywgdW50aWwgYW5vdGhlciByb3cgZm9sbG93cyBpdC4gKi9cbmxldCBvcGVuTGluZTogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5cbi8qKiBXb3JkcyBnbyBvbiB0aGUgcm93IHRoZSBjb3JlIHNheXMgdGhleSBiZWxvbmcgdG86IGl0IHN0YXJ0cyBhIG5ldyBsaW5lIGZvciBlYWNoIHR1cm4sIGhvd2V2ZXIgbG9uZyB0aGUgZ2FwLiAqL1xuZnVuY3Rpb24gdHJhbnNjcmlwdChyb2xlOiBcInVzZXJcIiB8IFwiYXNzaXN0YW50XCIsIHRleHQ6IHN0cmluZywgbGluZTogbnVtYmVyKSB7XG4gICQoXCJlbXB0eVwiKS5oaWRkZW4gPSB0cnVlO1xuICBjb25zdCBwYW5lID0gJChcInRyYW5zY3JpcHRcIik7XG4gIGNvbnN0IGxhc3QgPSBwYW5lLmxhc3RFbGVtZW50Q2hpbGQgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAob3BlbkxpbmUgPT09IGxpbmUgJiYgbGFzdCAmJiBsYXN0LmRhdGFzZXQucm9sZSA9PT0gcm9sZSkgbGFzdC5xdWVyeVNlbGVjdG9yKFwiLnRleHRcIikhLnRleHRDb250ZW50ICs9IHRleHQ7XG4gIGVsc2Uge1xuICAgIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgcm93LmNsYXNzTmFtZSA9IGBsaW5lICR7cm9sZX1gO1xuICAgIHJvdy5kYXRhc2V0LnJvbGUgPSByb2xlO1xuICAgIHJvdy5pbm5lckhUTUwgPSBgPHNwYW4gY2xhc3M9XCJ3aG9cIj4ke3JvbGUgPT09IFwidXNlclwiID8gXCJZb3VcIiA6IFwiR2VtaW5pXCJ9PC9zcGFuPjxzcGFuIGNsYXNzPVwidGV4dFwiPjwvc3Bhbj5gO1xuICAgIHJvdy5xdWVyeVNlbGVjdG9yKFwiLnRleHRcIikhLnRleHRDb250ZW50ID0gdGV4dC50cmltU3RhcnQoKTtcbiAgICBwYW5lLmFwcGVuZChyb3cpO1xuICAgIG9wZW5MaW5lID0gbGluZTtcbiAgfVxuICBzY3JvbGxEb3duKCk7XG59XG5cbi8qKlxuICogVGhlIHdvcmRzIHRoZSB1c2VyIGlzIHNheWluZywgYmVmb3JlIHRoZSBtb2RlbCBoYXMgdHJhbnNjcmliZWQgdGhlbTogYSBmYWludCByb3cgdGhhdCBzdGF5cyBsYXN0XG4gKiBvbiBzY3JlZW4gKGl0cyBDU1MgYG9yZGVyYCkgYW5kIGZpcnN0IGluIHRoZSBwYW5lLCBzbyB0aGUgbGluZXMgYWZ0ZXIgaXQgam9pbiB1cCBhcyBiZWZvcmUuXG4gKi9cbmZ1bmN0aW9uIGNhcHRpb24odGV4dDogc3RyaW5nIHwgbnVsbCkge1xuICBjb25zdCBwYW5lID0gJChcInRyYW5zY3JpcHRcIik7XG4gIGxldCByb3cgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImNhcHRpb25cIik7XG4gIGlmICh0ZXh0ID09IG51bGwpIHsgcm93Py5yZW1vdmUoKTsgc2Nyb2xsRG93bigpOyByZXR1cm47IH1cbiAgJChcImVtcHR5XCIpLmhpZGRlbiA9IHRydWU7XG4gIGlmICghcm93KSB7XG4gICAgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICByb3cuaWQgPSBcImNhcHRpb25cIjtcbiAgICByb3cuY2xhc3NOYW1lID0gXCJsaW5lIHVzZXIgY2FwdGlvblwiO1xuICAgIHJvdy5pbm5lckhUTUwgPSBgPHNwYW4gY2xhc3M9XCJ3aG9cIj5Zb3U8L3NwYW4+PHNwYW4gY2xhc3M9XCJ0ZXh0XCI+PC9zcGFuPmA7XG4gICAgcGFuZS5wcmVwZW5kKHJvdyk7XG4gIH1cbiAgcm93LnF1ZXJ5U2VsZWN0b3IoXCIudGV4dFwiKSEudGV4dENvbnRlbnQgPSB0ZXh0O1xuICBzY3JvbGxEb3duKCk7XG59XG5cbmZ1bmN0aW9uIG5vdGUodGV4dDogc3RyaW5nKSB7XG4gICQoXCJlbXB0eVwiKS5oaWRkZW4gPSB0cnVlO1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gXCJsaW5lIG5vdGVcIjtcbiAgcm93LnRleHRDb250ZW50ID0gdGV4dDtcbiAgJChcInRyYW5zY3JpcHRcIikuYXBwZW5kKHJvdyk7XG4gIG9wZW5MaW5lID0gbnVsbDtcbiAgc2Nyb2xsRG93bigpO1xufVxuXG4vLyBBZ2VudCBoYW5kb2ZmIHJlc3VsdHM6IGNvbXBhY3QgMS1saW5lIHJlZmVyZW5jZSBpbiB0aGUgdm9pY2Ugc3RyZWFtICsgZnVsbCBjb2xsYXBzaWJsZSBjYXJkIGluIHRoZSByaWdodCBwYW5lLlxuXG5mdW5jdGlvbiByZXN1bHRDbGFtcFB4KGVsOiBIVE1MRWxlbWVudCk6IG51bWJlciB7XG4gIGNvbnN0IHJhdyA9IGdldENvbXB1dGVkU3R5bGUoZWwpLmdldFByb3BlcnR5VmFsdWUoXCItLXJlcy1jbGFtcC1tYXhcIikudHJpbSgpO1xuICBjb25zdCBuID0gTnVtYmVyLnBhcnNlRmxvYXQocmF3KTtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShuKSAmJiBuID4gMCA/IG4gOiA2NDtcbn1cblxuZnVuY3Rpb24gc3luY0V4cGFuZEFsbEJ1dHRvbigpIHtcbiAgY29uc3QgY2xhbXBlZCA9IFsuLi5yZXN1bHRzLnZhbHVlcygpXS5maWx0ZXIoKHIpID0+IHIuY2FyZC5jbGFzc0xpc3QuY29udGFpbnMoXCJjbGFtcGVkXCIpKTtcbiAgY29uc3QgYnRuID0gJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJ0b2dnbGUtYWxsLXJlc3VsdHNcIik7XG4gIGJ0bi5oaWRkZW4gPSBjbGFtcGVkLmxlbmd0aCA9PT0gMDtcbiAgaWYgKGNsYW1wZWQubGVuZ3RoID09PSAwKSByZXR1cm47XG4gIGNvbnN0IGFueUNvbGxhcHNlZCA9IGNsYW1wZWQuc29tZSgocikgPT4gIXIuY2FyZC5jbGFzc0xpc3QuY29udGFpbnMoXCJvcGVuXCIpKTtcbiAgYnRuLnRleHRDb250ZW50ID0gYW55Q29sbGFwc2VkID8gXCJFeHBhbmQgYWxsXCIgOiBcIkNvbGxhcHNlIGFsbFwiO1xufVxuXG5mdW5jdGlvbiBzZXRSZXN1bHRPcGVuKGVudHJ5OiBSZXN1bHRFbnRyeSwgb3BlbjogYm9vbGVhbikge1xuICBjb25zdCBjbGFtcGVkID0gZW50cnkuY2FyZC5jbGFzc0xpc3QuY29udGFpbnMoXCJjbGFtcGVkXCIpO1xuICBjb25zdCBuZXh0ID0gY2xhbXBlZCAmJiBvcGVuO1xuICBlbnRyeS5jYXJkLmNsYXNzTGlzdC50b2dnbGUoXCJvcGVuXCIsIG5leHQpO1xuICBlbnRyeS5oZWFkLnNldEF0dHJpYnV0ZShcImFyaWEtZXhwYW5kZWRcIiwgU3RyaW5nKCFjbGFtcGVkIHx8IG5leHQpKTtcbiAgZW50cnkubW9yZUJ0bi50ZXh0Q29udGVudCA9IG5leHQgPyBcIlNob3cgbGVzc1wiIDogXCJTaG93IG1vcmVcIjtcbiAgc3luY0V4cGFuZEFsbEJ1dHRvbigpO1xufVxuXG5mdW5jdGlvbiB1cGRhdGVSZXN1bHRDbGFtcGluZyhlbnRyeTogUmVzdWx0RW50cnkpIHtcbiAgaWYgKGVudHJ5LmJvZHkub2Zmc2V0UGFyZW50ID09PSBudWxsKSByZXR1cm47XG4gIC8vIFVuY2xhbXBlZCBjYXJkcyBoYXZlIG5vIG1heC1oZWlnaHQsIHNvIHNjcm9sbEhlaWdodCBpcyBhbHdheXMgdGhlIGZ1bGwgbmF0dXJhbCBoZWlnaHQuXG4gIGNvbnN0IG92ZXJmbG93cyA9IGVudHJ5LmJvZHkuc2Nyb2xsSGVpZ2h0ID4gcmVzdWx0Q2xhbXBQeChlbnRyeS5jYXJkKSArIDQ7XG4gIGVudHJ5LmNhcmQuY2xhc3NMaXN0LnRvZ2dsZShcImNsYW1wZWRcIiwgb3ZlcmZsb3dzKTtcbiAgaWYgKCFvdmVyZmxvd3MpIGVudHJ5LmNhcmQuY2xhc3NMaXN0LnJlbW92ZShcIm9wZW5cIik7XG4gIGVudHJ5Lm1vcmVCdG4uaGlkZGVuID0gIW92ZXJmbG93cztcbiAgY29uc3QgaXNPcGVuID0gZW50cnkuY2FyZC5jbGFzc0xpc3QuY29udGFpbnMoXCJvcGVuXCIpO1xuICBlbnRyeS5tb3JlQnRuLnRleHRDb250ZW50ID0gaXNPcGVuID8gXCJTaG93IGxlc3NcIiA6IFwiU2hvdyBtb3JlXCI7XG4gIGVudHJ5LmhlYWQuc2V0QXR0cmlidXRlKFwiYXJpYS1leHBhbmRlZFwiLCBTdHJpbmcoIW92ZXJmbG93cyB8fCBpc09wZW4pKTtcbn1cblxuZnVuY3Rpb24gdXBkYXRlQWxsUmVzdWx0Q2xhbXBpbmcoKSB7XG4gIGZvciAoY29uc3QgZW50cnkgb2YgcmVzdWx0cy52YWx1ZXMoKSkgdXBkYXRlUmVzdWx0Q2xhbXBpbmcoZW50cnkpO1xuICBzeW5jRXhwYW5kQWxsQnV0dG9uKCk7XG59XG5cbmZ1bmN0aW9uIHN5bmNSZXN1bHRGb2xsb3dVcEJ1dHRvbnMoKSB7XG4gIGZvciAoY29uc3QgZW50cnkgb2YgcmVzdWx0cy52YWx1ZXMoKSkge1xuICAgIGlmICghZW50cnkuZm9sbG93QnRuKSBjb250aW51ZTtcbiAgICBjb25zdCBjYW5Gb2xsb3cgPSBjYW5Gb2xsb3dVcFJlc3VsdChlbnRyeS5zZXNzaW9uSWQsIGFjdGl2ZVNlc3Npb24sIEJvb2xlYW4oZW50cnkudGFza0lkICYmIHRhc2tzLmhhcyhlbnRyeS50YXNrSWQpKSk7XG4gICAgZW50cnkuZm9sbG93QnRuLmhpZGRlbiA9ICFjYW5Gb2xsb3c7XG4gICAgaWYgKCFjYW5Gb2xsb3cpIGVudHJ5LmNhcmQucXVlcnlTZWxlY3RvcihcImZvcm1cIik/LnJlbW92ZSgpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGNsZWFyVW5yZWFkSWZSZXN1bHRzVmlzaWJsZSgpIHtcbiAgaWYgKHVucmVhZE1vYmlsZVJlc3VsdHMgPT09IDApIHJldHVybjtcbiAgY29uc3QgZHJhd2VyT3BlbiA9IGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LmNvbnRhaW5zKFwidGFza3Mtb3BlblwiKTtcbiAgaWYgKHNob3VsZENsZWFyVW5yZWFkUmVzdWx0cyhtb2JpbGVMYXlvdXQubWF0Y2hlcywgZHJhd2VyT3Blbiwgc2lkZUZpbHRlcikpIHtcbiAgICB1bnJlYWRNb2JpbGVSZXN1bHRzID0gMDtcbiAgICB1cGRhdGVUYXNrQ2hyb21lKCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gZm9jdXNSZXN1bHQoaWQ6IHN0cmluZykge1xuICBjb25zdCBlbnRyeSA9IHJlc3VsdHMuZ2V0KGlkKTtcbiAgaWYgKCFlbnRyeSkgcmV0dXJuO1xuICBpZiAoc2lkZUZpbHRlciA9PT0gXCJhY3RpdmVcIikgc2V0U2lkZUZpbHRlcihcImFsbFwiKTtcbiAgaWYgKG1vYmlsZUxheW91dC5tYXRjaGVzKSBzZXRUYXNrc09wZW4odHJ1ZSk7XG4gIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB7XG4gICAgdXBkYXRlUmVzdWx0Q2xhbXBpbmcoZW50cnkpO1xuICAgIGlmIChlbnRyeS5jYXJkLmNsYXNzTGlzdC5jb250YWlucyhcImNsYW1wZWRcIikpIHNldFJlc3VsdE9wZW4oZW50cnksIHRydWUpO1xuICAgIGZvciAoY29uc3QgciBvZiByZXN1bHRzLnZhbHVlcygpKSByLmNhcmQuY2xhc3NMaXN0LnJlbW92ZShcImZsYXNoXCIpO1xuICAgIHZvaWQgZW50cnkuY2FyZC5vZmZzZXRXaWR0aDtcbiAgICBlbnRyeS5jYXJkLmNsYXNzTGlzdC5hZGQoXCJmbGFzaFwiKTtcbiAgICBjbGVhclRpbWVvdXQoZmxhc2hUaW1lcik7XG4gICAgZmxhc2hUaW1lciA9IHdpbmRvdy5zZXRUaW1lb3V0KCgpID0+IGVudHJ5LmNhcmQuY2xhc3NMaXN0LnJlbW92ZShcImZsYXNoXCIpLCAxNDAwKTtcbiAgICBlbnRyeS5jYXJkLnNjcm9sbEludG9WaWV3KHsgYmVoYXZpb3I6IFwic21vb3RoXCIsIGJsb2NrOiBcIm5lYXJlc3RcIiB9KTtcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHJlc3VsdChhZ2VudDogc3RyaW5nLCBsYWJlbDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcsIGZhaWxlZCA9IGZhbHNlLCB0YXNrSWQ/OiBzdHJpbmcsIHNlc3Npb25JZCA9IGFjdGl2ZVNlc3Npb24pOiBzdHJpbmcge1xuICAkKFwiZW1wdHlcIikuaGlkZGVuID0gdHJ1ZTtcbiAgY29uc3QgaWQgPSBgcmVzLSR7KytuZXh0UmVzdWx0U2VxfWA7XG4gIGNvbnN0IHdobyA9IGFnZW50ID09PSBcInQzXCIgPyBcIlQzXCIgOiBcIkhlcm1lc1wiO1xuICBjb25zdCBhZ2VudENscyA9IGFnZW50ID09PSBcInQzXCIgPyBcInQzXCIgOiBcIlwiO1xuICBjb25zdCBzbmlwcGV0ID0gcGxhaW5QcmV2aWV3KHRleHQsIDE2MCkgfHwgXCIoZW1wdHkgcmVzcG9uc2UpXCI7XG5cbiAgLy8gMS4gQ29tcGFjdCBpbmxpbmUgaGFuZG9mZiBtYXJrZXIgaW4gdGhlIHZvaWNlIHRyYW5zY3JpcHQgc28gY2hyb25vbG9naWNhbCBjb250ZXh0IHN0YXlzIGludGFjdFxuICAvLyB3aXRob3V0IG11bHRpLXBhcmFncmFwaCByZXNwb25zZXMgcHVzaGluZyB2b2ljZSB0dXJucyBvZmYgc2NyZWVuLlxuICBjb25zdCByZWZSb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICByZWZSb3cudHlwZSA9IFwiYnV0dG9uXCI7XG4gIHJlZlJvdy5jbGFzc05hbWUgPSBgbGluZSBoYW5kb2ZmICR7YWdlbnRDbHN9ICR7ZmFpbGVkID8gXCJmYWlsZWRcIiA6IFwiXCJ9YC50cmltKCk7XG4gIHJlZlJvdy5kYXRhc2V0LnJlc3VsdElkID0gaWQ7XG4gIHJlZlJvdy5pbm5lckhUTUwgPVxuICAgIGA8c3BhbiBjbGFzcz1cImJhZGdlICR7YWdlbnRDbHN9XCI+JHt3aG99PC9zcGFuPmAgK1xuICAgIGA8c3BhbiBjbGFzcz1cImhhbmRvZmYtbGFiZWxcIj4ke2VzY2FwZUh0bWwobGFiZWwpfTwvc3Bhbj5gICtcbiAgICBgPHNwYW4gY2xhc3M9XCJoYW5kb2ZmLXNuaXBwZXRcIj4ke2VzY2FwZUh0bWwoc25pcHBldCl9PC9zcGFuPmAgK1xuICAgIGA8c3BhbiBjbGFzcz1cImhhbmRvZmYtY3VlXCI+JHtmYWlsZWQgPyBcIkZhaWxlZFwiIDogXCJPcGVuIFx1MjE5N1wifTwvc3Bhbj5gO1xuICByZWZSb3cub25jbGljayA9ICgpID0+IGZvY3VzUmVzdWx0KGlkKTtcbiAgJChcInRyYW5zY3JpcHRcIikuYXBwZW5kKHJlZlJvdyk7XG4gIG9wZW5MaW5lID0gbnVsbDtcbiAgc2Nyb2xsRG93bigpO1xuXG4gIC8vIDIuIFRydW5jYXRlZCwgZXhwYW5kYWJsZSByZXN1bHQgY2FyZCBpbiB0aGUgcmlnaHQtaGFuZCBBZ2VudCBXb3Jrc3BhY2UgKG5ld2VzdCBmaXJzdCkuXG4gIGNvbnN0IGNhcmQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYXJ0aWNsZVwiKTtcbiAgY2FyZC5jbGFzc05hbWUgPSBgcmVzLWNhcmQgJHthZ2VudENsc30gJHtmYWlsZWQgPyBcImZhaWxlZFwiIDogXCJcIn1gLnRyaW0oKTtcbiAgY2FyZC5kYXRhc2V0LnJlc3VsdElkID0gaWQ7XG5cbiAgY29uc3QgaGVhZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIGhlYWQudHlwZSA9IFwiYnV0dG9uXCI7XG4gIGhlYWQuY2xhc3NOYW1lID0gXCJyZXMtaGVhZFwiO1xuICBoZWFkLnNldEF0dHJpYnV0ZShcImFyaWEtZXhwYW5kZWRcIiwgXCJ0cnVlXCIpO1xuICBoZWFkLmlubmVySFRNTCA9XG4gICAgYDxzcGFuIGNsYXNzPVwiYmFkZ2UgJHthZ2VudENsc31cIj4ke3dob308L3NwYW4+YCArXG4gICAgYDxzcGFuIGNsYXNzPVwicmVzLWxhYmVsXCIgdGl0bGU9XCIke2VzY2FwZUh0bWwobGFiZWwpfVwiPiR7ZXNjYXBlSHRtbChsYWJlbCl9PC9zcGFuPmAgK1xuICAgIChmYWlsZWQgPyBgPHNwYW4gY2xhc3M9XCJyZXMtcGlsbFwiPkZhaWxlZDwvc3Bhbj5gIDogXCJcIikgK1xuICAgIGA8c3BhbiBjbGFzcz1cInJlcy10aW1lXCI+JHtmb3JtYXRTaG9ydFRpbWUobmV3IERhdGUoKSl9PC9zcGFuPmAgK1xuICAgIGA8c3BhbiBjbGFzcz1cInJlcy1jaGV2XCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+PC9zcGFuPmA7XG5cbiAgY29uc3QgYm9keSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGJvZHkuY2xhc3NOYW1lID0gXCJyZXMtYm9keVwiO1xuICBib2R5LmlubmVySFRNTCA9IG1hcmtkb3duKHRleHQpO1xuXG4gIGNvbnN0IGZvb3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBmb290LmNsYXNzTmFtZSA9IFwicmVzLWZvb3RcIjtcblxuICBjb25zdCBtb3JlQnRuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgbW9yZUJ0bi50eXBlID0gXCJidXR0b25cIjtcbiAgbW9yZUJ0bi5jbGFzc05hbWUgPSBcInJlcy1hY3QgcHJpbWFyeVwiO1xuICBtb3JlQnRuLnRleHRDb250ZW50ID0gXCJTaG93IG1vcmVcIjtcbiAgbW9yZUJ0bi5oaWRkZW4gPSB0cnVlO1xuXG4gIGNvbnN0IGNvcHlCdG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBjb3B5QnRuLnR5cGUgPSBcImJ1dHRvblwiO1xuICBjb3B5QnRuLmNsYXNzTmFtZSA9IFwicmVzLWFjdFwiO1xuICBjb3B5QnRuLnRleHRDb250ZW50ID0gXCJDb3B5XCI7XG4gIGNvcHlCdG4ub25jbGljayA9ICgpID0+IHtcbiAgICB2b2lkIG5hdmlnYXRvci5jbGlwYm9hcmQ/LndyaXRlVGV4dCh0ZXh0KTtcbiAgICB0b2FzdChcIlJlc3VsdCBjb3BpZWRcIik7XG4gIH07XG5cbiAgZm9vdC5hcHBlbmQobW9yZUJ0biwgY29weUJ0bik7XG5cbiAgbGV0IGZvbGxvd0J0bjogSFRNTEJ1dHRvbkVsZW1lbnQgfCB1bmRlZmluZWQ7XG4gIGlmICh0YXNrSWQpIHtcbiAgICBmb2xsb3dCdG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICAgIGZvbGxvd0J0bi50eXBlID0gXCJidXR0b25cIjtcbiAgICBmb2xsb3dCdG4uY2xhc3NOYW1lID0gXCJyZXMtYWN0XCI7XG4gICAgZm9sbG93QnRuLnRleHRDb250ZW50ID0gXCJGb2xsb3cgdXBcIjtcbiAgICBmb2xsb3dCdG4ub25jbGljayA9ICgpID0+IHtcbiAgICAgIGlmICghY2FuRm9sbG93VXBSZXN1bHQoc2Vzc2lvbklkLCBhY3RpdmVTZXNzaW9uLCB0YXNrcy5oYXModGFza0lkKSkpIHtcbiAgICAgICAgc3luY1Jlc3VsdEZvbGxvd1VwQnV0dG9ucygpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjb25zdCB2aWV3ID0gdGFza3MuZ2V0KHRhc2tJZCk7XG4gICAgICBpZiAodmlldykgZm9sbG93VXBGb3JtKGNhcmQsIHZpZXcuYywgc2Vzc2lvbklkKTtcbiAgICB9O1xuICAgIGZvb3QuYXBwZW5kKGZvbGxvd0J0bik7XG4gIH1cblxuICBjYXJkLmFwcGVuZChoZWFkLCBib2R5LCBmb290KTtcblxuICBjb25zdCBlbnRyeTogUmVzdWx0RW50cnkgPSB7IGlkLCBhZ2VudCwgbGFiZWwsIHRleHQsIGZhaWxlZCwgdGFza0lkLCBzZXNzaW9uSWQsIGNhcmQsIGhlYWQsIGJvZHksIG1vcmVCdG4sIGZvbGxvd0J0biwgcmVmUm93IH07XG4gIGNvbnN0IHRvZ2dsZSA9ICgpID0+IHtcbiAgICBpZiAoIWVudHJ5LmNhcmQuY2xhc3NMaXN0LmNvbnRhaW5zKFwiY2xhbXBlZFwiKSkgcmV0dXJuO1xuICAgIHNldFJlc3VsdE9wZW4oZW50cnksICFlbnRyeS5jYXJkLmNsYXNzTGlzdC5jb250YWlucyhcIm9wZW5cIikpO1xuICB9O1xuICBoZWFkLm9uY2xpY2sgPSB0b2dnbGU7XG4gIG1vcmVCdG4ub25jbGljayA9IHRvZ2dsZTtcblxuICByZXN1bHRzLnNldChpZCwgZW50cnkpO1xuICAkKFwicmVzdWx0c1wiKS5wcmVwZW5kKGNhcmQpO1xuICBjb25zdCBkcmF3ZXJPcGVuID0gZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QuY29udGFpbnMoXCJ0YXNrcy1vcGVuXCIpO1xuICBpZiAoIXNob3VsZENsZWFyVW5yZWFkUmVzdWx0cyhtb2JpbGVMYXlvdXQubWF0Y2hlcywgZHJhd2VyT3Blbiwgc2lkZUZpbHRlcikpIHVucmVhZE1vYmlsZVJlc3VsdHMrKztcblxuICBzeW5jU2lkZUxheW91dCgpO1xuICB1cGRhdGVUYXNrQ2hyb21lKCk7XG4gIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB7XG4gICAgdXBkYXRlUmVzdWx0Q2xhbXBpbmcoZW50cnkpO1xuICAgIHN5bmNFeHBhbmRBbGxCdXR0b24oKTtcbiAgfSk7XG4gIHJldHVybiBpZDtcbn1cblxuZnVuY3Rpb24gZWxhcHNlZChzZWNvbmRzOiBudW1iZXIpOiBzdHJpbmcge1xuICBpZiAoc2Vjb25kcyA8IDYwKSByZXR1cm4gYCR7TWF0aC5mbG9vcihzZWNvbmRzKX1zYDtcbiAgY29uc3QgbSA9IE1hdGguZmxvb3Ioc2Vjb25kcyAvIDYwKTtcbiAgcmV0dXJuIG0gPCA2MCA/IGAke219bSAke01hdGguZmxvb3Ioc2Vjb25kcyAlIDYwKX1zYCA6IGAke01hdGguZmxvb3IobSAvIDYwKX1oICR7bSAlIDYwfW1gO1xufVxuXG4vKiogVGhlIGVtcHR5IHRhc2sgbGlzdCdzIHdvcmRzLCBrZXB0IHRvIHB1dCBiYWNrLiAqL1xuY29uc3Qgbm9UYXNrcyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwibm90YXNrc1wiKSE7XG5cbi8qKiBXaGV0aGVyIGEgdGFzayBzdGlsbCB3YW50cyB0aGUgc2NyZWVuOiBpdCdzIHdvcmtpbmcsIHdhaXRpbmcsIG9yIG5lZWRzIGFwcHJvdmFsLiBUaGUgcmVzdCBmb2xkIGF3YXkgdW5kZXIgRmluaXNoZWQuICovXG5jb25zdCBsaXZlID0gKHN0YXRlOiBzdHJpbmcpID0+IHN0YXRlID09PSBcInJ1bm5pbmdcIiB8fCBzdGF0ZS5zdGFydHNXaXRoKFwid2FpdGluZ1wiKTtcbmNvbnN0IGlzQWN0aXZlVGFzayA9ICh2aWV3OiBUYXNrVmlldykgPT4gbGl2ZSh2aWV3LmMuc3RhdGUpIHx8IEJvb2xlYW4odmlldy5hcHByb3ZhbCk7XG5cbmZ1bmN0aW9uIHNldFNpZGVGaWx0ZXIoZmlsdGVyOiBTaWRlRmlsdGVyKSB7XG4gIHNpZGVGaWx0ZXIgPSBub3JtYWxpemVTaWRlRmlsdGVyKGZpbHRlcik7XG4gIGZvciAoY29uc3QgYnRuIG9mIEFycmF5LmZyb20oZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MQnV0dG9uRWxlbWVudD4oXCIjc2lkZS10YWJzIGJ1dHRvblwiKSkpIHtcbiAgICBjb25zdCBvbiA9IGJ0bi5kYXRhc2V0LmZpbHRlciA9PT0gc2lkZUZpbHRlcjtcbiAgICBidG4uY2xhc3NMaXN0LnRvZ2dsZShcIm9uXCIsIG9uKTtcbiAgICBidG4uc2V0QXR0cmlidXRlKFwiYXJpYS1wcmVzc2VkXCIsIFN0cmluZyhvbikpO1xuICB9XG4gIHN5bmNTaWRlTGF5b3V0KCk7XG4gIGNsZWFyVW5yZWFkSWZSZXN1bHRzVmlzaWJsZSgpO1xuICByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKCkgPT4gdXBkYXRlQWxsUmVzdWx0Q2xhbXBpbmcoKSk7XG59XG5cbmZ1bmN0aW9uIHN5bmNTaWRlTGF5b3V0KCkge1xuICBjb25zdCBhbGwgPSBbLi4udGFza3MudmFsdWVzKCldO1xuICBjb25zdCBhY3RpdmVDdXJyZW50ID0gYWxsLmZpbHRlcihpc0FjdGl2ZVRhc2spLmxlbmd0aDtcbiAgY29uc3QgYWN0aXZlVG90YWwgPSBhY3RpdmVDdXJyZW50ICsgZWFybGllckFjdGl2ZUNvdW50O1xuICBjb25zdCByZXN1bHRzVG90YWwgPSByZXN1bHRzLnNpemU7XG4gIGNvbnN0IGVhcmxpZXJTaG93biA9ICQoXCJlYXJsaWVyXCIpLmNoaWxkRWxlbWVudENvdW50O1xuICBjb25zdCBkb25lVG90YWwgPSAkKFwiZG9uZW5vd1wiKS5jaGlsZEVsZW1lbnRDb3VudCArICQoXCJkb25lZWFybGllclwiKS5jaGlsZEVsZW1lbnRDb3VudDtcblxuICBjb25zdCB2aXMgPSByZXNvbHZlU2lkZVNlY3Rpb25zKHNpZGVGaWx0ZXIsIHtcbiAgICBhY3RpdmU6IGFjdGl2ZUN1cnJlbnQsXG4gICAgcmVzdWx0czogcmVzdWx0c1RvdGFsLFxuICAgIGVhcmxpZXI6IGVhcmxpZXJTaG93bixcbiAgICBkb25lOiBkb25lVG90YWwsXG4gIH0pO1xuXG4gICQoXCJ0YXNrcy1zZWN0aW9uXCIpLmhpZGRlbiA9ICF2aXMuc2hvd1Rhc2tzU2VjdGlvbjtcbiAgbm9UYXNrcy5oaWRkZW4gPSAhdmlzLnNob3dFbXB0eVRhc2tzO1xuICAkKFwicmVzdWx0cy1zZWN0aW9uXCIpLmhpZGRlbiA9ICF2aXMuc2hvd1Jlc3VsdHNTZWN0aW9uO1xuICAkKFwibm9yZXN1bHRzXCIpLmhpZGRlbiA9ICF2aXMuc2hvd0VtcHR5UmVzdWx0cztcbiAgJChcImVhcmxpZXJib3hcIikuaGlkZGVuID0gIXZpcy5zaG93RWFybGllclNlY3Rpb247XG4gICQoXCJkb25lYm94XCIpLmhpZGRlbiA9ICF2aXMuc2hvd0RvbmVTZWN0aW9uO1xuXG4gICQoXCJzaWRlLWFjdGl2ZS1uXCIpLnRleHRDb250ZW50ID0gYWN0aXZlVG90YWwgPiAwID8gU3RyaW5nKGFjdGl2ZVRvdGFsKSA6IFwiXCI7XG4gICQoXCJzaWRlLXJlc3VsdHMtblwiKS50ZXh0Q29udGVudCA9IHJlc3VsdHNUb3RhbCA+IDAgPyBTdHJpbmcocmVzdWx0c1RvdGFsKSA6IFwiXCI7XG4gICQoXCJyZXN1bHRzY291bnRcIikudGV4dENvbnRlbnQgPSByZXN1bHRzVG90YWwgPiAwID8gYFx1MDBCNyAke3Jlc3VsdHNUb3RhbH1gIDogXCJcIjtcbiAgJChcImRvbmVjb3VudFwiKS50ZXh0Q29udGVudCA9IGRvbmVUb3RhbCA+IDAgPyBgXHUwMEI3ICR7ZG9uZVRvdGFsfWAgOiBcIlwiO1xuICBzeW5jUmVzdWx0Rm9sbG93VXBCdXR0b25zKCk7XG59XG5cbmZ1bmN0aW9uIHVwZGF0ZVRhc2tDaHJvbWUoKSB7XG4gIGNvbnN0IGFsbCA9IFsuLi50YXNrcy52YWx1ZXMoKV07XG4gIGNvbnN0IGFjdGl2ZUN1cnJlbnQgPSBhbGwuZmlsdGVyKGlzQWN0aXZlVGFzaykubGVuZ3RoO1xuICBjb25zdCB3YWl0aW5nID0gYWxsLmZpbHRlcigodCkgPT4gdC5jLnN0YXRlLnN0YXJ0c1dpdGgoXCJ3YWl0aW5nXCIpIHx8IEJvb2xlYW4odC5hcHByb3ZhbCkpLmxlbmd0aDtcbiAgY29uc3QgYWN0aXZlVG90YWwgPSBhY3RpdmVDdXJyZW50ICsgZWFybGllckFjdGl2ZUNvdW50O1xuICBjb25zdCBhdHRlbnRpb25Ub3RhbCA9IHdhaXRpbmcgKyBlYXJsaWVyV2FpdGluZ0NvdW50O1xuICBjb25zdCBiYWRnZUNvdW50ID0gYWN0aXZlVG90YWwgPiAwID8gYWN0aXZlVG90YWwgOiB1bnJlYWRNb2JpbGVSZXN1bHRzO1xuXG4gIGNvbnN0IGJhZGdlID0gJChcInRhc2tzLWJhZGdlXCIpO1xuICBiYWRnZS5oaWRkZW4gPSBiYWRnZUNvdW50ID09PSAwO1xuICBiYWRnZS50ZXh0Q29udGVudCA9IFN0cmluZyhiYWRnZUNvdW50KTtcbiAgYmFkZ2UuY2xhc3NMaXN0LnRvZ2dsZShcIndhcm5cIiwgYXR0ZW50aW9uVG90YWwgPiAwKTtcblxuICBjb25zdCBiYXIgPSAkKFwibW9iaWxlLXRhc2tzLWJhclwiKTtcbiAgY29uc3Qgc2hvd0JhciA9IGFjdGl2ZVRvdGFsID4gMCB8fCB1bnJlYWRNb2JpbGVSZXN1bHRzID4gMDtcbiAgYmFyLmhpZGRlbiA9ICFzaG93QmFyO1xuICBiYXIuY2xhc3NMaXN0LnRvZ2dsZShcInZpc2libGVcIiwgc2hvd0Jhcik7XG4gIGJhci5jbGFzc0xpc3QudG9nZ2xlKFwid2FyblwiLCBhdHRlbnRpb25Ub3RhbCA+IDApO1xuICBpZiAoc2hvd0Jhcikge1xuICAgIGNvbnN0IGFwcHJvdmFsID0gYWxsLmZpbmQoKHQpID0+IHQuYXBwcm92YWwpO1xuICAgIGNvbnN0IGxhYmVsID0gYXBwcm92YWxcbiAgICAgID8gYEFwcHJvdmFsIG5lZWRlZDogJHthcHByb3ZhbC5jLmxhYmVsfWBcbiAgICAgIDogYXR0ZW50aW9uVG90YWwgPiAwXG4gICAgICAgID8gYCR7YXR0ZW50aW9uVG90YWx9IHRhc2ske2F0dGVudGlvblRvdGFsID4gMSA/IFwic1wiIDogXCJcIn0gd2FpdGluZyBmb3IgeW91YFxuICAgICAgICA6IGFjdGl2ZVRvdGFsID4gMFxuICAgICAgICAgID8gYCR7YWN0aXZlVG90YWx9IGFjdGl2ZSB0YXNrJHthY3RpdmVUb3RhbCA+IDEgPyBcInNcIiA6IFwiXCJ9YFxuICAgICAgICAgIDogYCR7dW5yZWFkTW9iaWxlUmVzdWx0c30gbmV3IGFnZW50IHJlc3VsdCR7dW5yZWFkTW9iaWxlUmVzdWx0cyA+IDEgPyBcInNcIiA6IFwiXCJ9YDtcbiAgICAkKFwibXRiLXRleHRcIikudGV4dENvbnRlbnQgPSBsYWJlbDtcbiAgfVxufVxuXG5mdW5jdGlvbiBzaG93VGFza3MoZm9yY2UgPSBmYWxzZSkge1xuICBjb25zdCBwYW5lID0gJChcInRhc2tzXCIpO1xuICBjb25zdCBkb25lID0gJChcImRvbmVub3dcIik7XG4gIGNvbnN0IG9wZW4gPSBkb2N1bWVudC5hY3RpdmVFbGVtZW50Py5jbG9zZXN0Py4oXCIudGFza1wiKSBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gIGlmICghZm9yY2UgJiYgb3BlbiAmJiAocGFuZS5jb250YWlucyhvcGVuKSB8fCBkb25lLmNvbnRhaW5zKG9wZW4pKSAmJiBvcGVuLnF1ZXJ5U2VsZWN0b3IoXCJmb3JtXCIpKSByZXR1cm47IC8vIGRvbid0IHJlZHJhdyB1bmRlciBzb21lb25lIHR5cGluZyBhIGZvbGxvdy11cFxuICBwYW5lLmlubmVySFRNTCA9IFwiXCI7XG4gIGRvbmUuaW5uZXJIVE1MID0gXCJcIjtcbiAgY29uc3QgYWxsID0gWy4uLnRhc2tzLnZhbHVlcygpXS5yZXZlcnNlKCk7XG4gIGlmIChhbGwubGVuZ3RoID09PSAwKSB7XG4gICAgcGFuZS5hcHBlbmQobm9UYXNrcyk7XG4gICAgJChcInRhc2tjb3VudFwiKS50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgJChcImNhbmNlbGFsbFwiKS5oaWRkZW4gPSB0cnVlO1xuICAgIHN5bmNTaWRlTGF5b3V0KCk7XG4gICAgdXBkYXRlVGFza0Nocm9tZSgpO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBydW5uaW5nID0gYWxsLmZpbHRlcigodCkgPT4gdC5jLnN0YXRlID09PSBcInJ1bm5pbmdcIikubGVuZ3RoO1xuICBjb25zdCBhY3RpdmVDb3VudCA9IGFsbC5maWx0ZXIoaXNBY3RpdmVUYXNrKS5sZW5ndGg7XG4gICQoXCJ0YXNrY291bnRcIikudGV4dENvbnRlbnQgPSBydW5uaW5nID4gMCA/IGAke3J1bm5pbmd9IHJ1bm5pbmdgIDogYWN0aXZlQ291bnQgPiAwID8gYCR7YWN0aXZlQ291bnR9IHdhaXRpbmdgIDogXCJcIjtcbiAgJChcImNhbmNlbGFsbFwiKS5oaWRkZW4gPSAhY2FsbElkIHx8IHJ1bm5pbmcgPCAyO1xuICBmb3IgKGNvbnN0IHZpZXcgb2YgYWxsKSB7XG4gICAgY29uc3QgdCA9IHZpZXcuYztcbiAgICBjb25zdCB3YWl0aW5nID0gdC5zdGF0ZS5zdGFydHNXaXRoKFwid2FpdGluZ1wiKTtcbiAgICBjb25zdCBjYXJkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBjYXJkLmNsYXNzTmFtZSA9IGB0YXNrICR7d2FpdGluZyA/IFwid2FpdGluZ1wiIDogdC5zdGF0ZX1gO1xuICAgIGNvbnN0IGFnZSA9ICh2aWV3LmVuZGVkID8/IG5vdygpKSAtIHZpZXcuc2luY2U7XG4gICAgY2FyZC5pbm5lckhUTUwgPVxuICAgICAgYDxkaXYgY2xhc3M9XCJtZXRhLXJvd1wiPmAgK1xuICAgICAgICBgPHNwYW4gY2xhc3M9XCJiYWRnZSAke3QuYWdlbnQgPT09IFwidDNcIiA/IFwidDNcIiA6IFwiXCJ9XCI+JHt0LmFnZW50ID09PSBcInQzXCIgPyBcIlQzXCIgOiBcIkhlcm1lc1wifTwvc3Bhbj5gICtcbiAgICAgICAgYDxzcGFuIGNsYXNzPVwibGFiZWxcIj48L3NwYW4+YCArXG4gICAgICAgIGA8c3BhbiBjbGFzcz1cInN0YXRlXCI+JHt0LnN0YXRlID09PSBcInJ1bm5pbmdcIiA/ICc8c3BhbiBjbGFzcz1cInNwaW5cIj48L3NwYW4+JyA6IFwiXCJ9JHtlc2NhcGVIdG1sKHQuc3RhdGUpfTwvc3Bhbj5gICtcbiAgICAgICAgYDxzcGFuIGNsYXNzPVwiYWdlXCI+JHtlbGFwc2VkKGFnZSl9PC9zcGFuPmAgK1xuICAgICAgYDwvZGl2PmAgK1xuICAgICAgYDxkaXYgY2xhc3M9XCJwXCI+PC9kaXY+YDtcbiAgICBjb25zdCBsYWJlbEVsID0gY2FyZC5xdWVyeVNlbGVjdG9yKFwiLmxhYmVsXCIpIGFzIEhUTUxFbGVtZW50O1xuICAgIGxhYmVsRWwudGV4dENvbnRlbnQgPSB0LmxhYmVsO1xuICAgIGxhYmVsRWwudGl0bGUgPSB0LmxhYmVsO1xuICAgIGNhcmQucXVlcnlTZWxlY3RvcihcIi5wXCIpIS50ZXh0Q29udGVudCA9IHQucHJvZ3Jlc3MgPz8gdC5yZXF1ZXN0O1xuICAgIGlmICh0LnF1ZXN0aW9uKSB7XG4gICAgICBjb25zdCBxID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgIHEuY2xhc3NOYW1lID0gXCJxXCI7XG4gICAgICBxLnRleHRDb250ZW50ID0gYEFza3M6ICR7dC5xdWVzdGlvbn1gO1xuICAgICAgY2FyZC5hcHBlbmQocSk7XG4gICAgfVxuICAgIGlmICh2aWV3LmFwcHJvdmFsICYmIHQuc3RhdGUgPT09IFwicnVubmluZ1wiKSB7XG4gICAgICBjb25zdCBib3ggPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgICAgYm94LmNsYXNzTmFtZSA9IFwiYXBwcm92YWxcIjtcbiAgICAgIGJveC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz1cImFwcHJvdmFsLWhlYWRcIj5IZXJtZXMgYXNrcyB0byBydW48L2Rpdj48Y29kZT48L2NvZGU+PGRpdiBjbGFzcz1cImFjdHNcIj48L2Rpdj5gO1xuICAgICAgYm94LnF1ZXJ5U2VsZWN0b3IoXCJjb2RlXCIpIS50ZXh0Q29udGVudCA9IHZpZXcuYXBwcm92YWwuY29tbWFuZDtcbiAgICAgIGNvbnN0IGFuc3dlciA9IChjaG9pY2U6IFwib25jZVwiIHwgXCJkZW55XCIpID0+IHtcbiAgICAgICAgdmlldy5hcHByb3ZhbCA9IHVuZGVmaW5lZDtcbiAgICAgICAgc2hvd1Rhc2tzKHRydWUpO1xuICAgICAgICB2b2lkIGZldGNoKFwiL2hlcm1lcy9hcHByb3ZhbFwiLCB7IG1ldGhvZDogXCJQT1NUXCIsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgY2FsbDogY2FsbE5hbWUsIHRhc2tJZDogdC5pZCwgY2hvaWNlIH0pIH0pXG4gICAgICAgICAgLnRoZW4oKHIpID0+IHRvYXN0KHIub2sgPyAoY2hvaWNlID09PSBcIm9uY2VcIiA/IFwiQXBwcm92ZWRcIiA6IFwiRGVuaWVkXCIpIDogXCJUaGF0IGFwcHJvdmFsIGhhZCBhbHJlYWR5IGxhcHNlZFwiKSk7XG4gICAgICB9O1xuICAgICAgZm9yIChjb25zdCBbbGFiZWwsIGNob2ljZV0gb2YgW1tcIkFwcHJvdmUgb25jZVwiLCBcIm9uY2VcIl0sIFtcIkRlbnlcIiwgXCJkZW55XCJdXSBhcyBjb25zdCkge1xuICAgICAgICBjb25zdCBiID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgICAgICAgYi50eXBlID0gXCJidXR0b25cIjtcbiAgICAgICAgYi50ZXh0Q29udGVudCA9IGxhYmVsO1xuICAgICAgICBpZiAoY2hvaWNlID09PSBcIm9uY2VcIikgYi5jbGFzc05hbWUgPSBcImdvXCI7XG4gICAgICAgIGVsc2UgYi5jbGFzc05hbWUgPSBcImRhbmdlclwiO1xuICAgICAgICBiLm9uY2xpY2sgPSAoKSA9PiBhbnN3ZXIoY2hvaWNlKTtcbiAgICAgICAgYm94LnF1ZXJ5U2VsZWN0b3IoXCIuYWN0c1wiKSEuYXBwZW5kKGIpO1xuICAgICAgfVxuICAgICAgY2FyZC5hcHBlbmQoYm94KTtcbiAgICB9XG4gICAgaWYgKHQuc3RhdGUgIT09IFwicnVubmluZ1wiKSB2aWV3LmFwcHJvdmFsID0gdW5kZWZpbmVkO1xuICAgIGNvbnN0IGFjdHMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGFjdHMuY2xhc3NOYW1lID0gXCJhY3RzXCI7XG4gICAgY29uc3QgYnV0dG9uID0gKHRleHQ6IHN0cmluZywgZm46ICgpID0+IHZvaWQsIGNscyA9IFwiXCIpID0+IHtcbiAgICAgIGNvbnN0IGIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICAgICAgYi50eXBlID0gXCJidXR0b25cIjtcbiAgICAgIGIudGV4dENvbnRlbnQgPSB0ZXh0O1xuICAgICAgaWYgKGNscykgYi5jbGFzc05hbWUgPSBjbHM7XG4gICAgICBiLm9uY2xpY2sgPSBmbjtcbiAgICAgIGFjdHMuYXBwZW5kKGIpO1xuICAgICAgcmV0dXJuIGI7XG4gICAgfTtcbiAgICBpZiAoY2FsbElkICYmIGFjdGl2ZVNlc3Npb24gPiAwKSB7XG4gICAgICBjb25zdCBvcmlnaW5TZXNzaW9uID0gYWN0aXZlU2Vzc2lvbjtcbiAgICAgIGJ1dHRvbih3YWl0aW5nID8gXCJBbnN3ZXJcIiA6IFwiRm9sbG93IHVwXCIsICgpID0+IGZvbGxvd1VwRm9ybShjYXJkLCB0LCBvcmlnaW5TZXNzaW9uKSk7XG4gICAgICBpZiAodC5zdGF0ZSA9PT0gXCJydW5uaW5nXCIpIGJ1dHRvbihcIkNhbmNlbFwiLCAoKSA9PiBwdXNoKHsgdHlwZTogXCJjYW5jZWxUYXNrXCIsIHRhc2s6IHQuaWQgfSksIFwiZGFuZ2VyXCIpO1xuICAgIH1cbiAgICBpZiAodmlldy5yZXN1bHRJZCkgYnV0dG9uKFwiUmVzdWx0XCIsICgpID0+IGZvY3VzUmVzdWx0KHZpZXcucmVzdWx0SWQhKSk7XG4gICAgaWYgKHZpZXcudGhyZWFkKSBidXR0b24oXCJDb3B5IGlkXCIsICgpID0+IHsgdm9pZCBuYXZpZ2F0b3IuY2xpcGJvYXJkPy53cml0ZVRleHQodmlldy50aHJlYWQhKTsgdG9hc3QoXCJUaHJlYWQgaWQgY29waWVkXCIpOyB9KTtcbiAgICBpZiAoYWN0cy5jaGlsZEVsZW1lbnRDb3VudCkgY2FyZC5hcHBlbmQoYWN0cyk7XG4gICAgKGlzQWN0aXZlVGFzayh2aWV3KSA/IHBhbmUgOiBkb25lKS5hcHBlbmQoY2FyZCk7XG4gIH1cbiAgaWYgKHBhbmUuY2hpbGRFbGVtZW50Q291bnQgPT09IDApIHBhbmUuYXBwZW5kKG5vVGFza3MpO1xuICBzeW5jU2lkZUxheW91dCgpO1xuICB1cGRhdGVUYXNrQ2hyb21lKCk7XG59XG5cbmZ1bmN0aW9uIGZvbGxvd1VwRm9ybShjYXJkOiBIVE1MRWxlbWVudCwgdDogQ29tbWFuZCwgb3JpZ2luU2Vzc2lvbjogbnVtYmVyKSB7XG4gIGNvbnN0IGV4aXN0aW5nID0gY2FyZC5xdWVyeVNlbGVjdG9yKFwiZm9ybVwiKTtcbiAgaWYgKGV4aXN0aW5nKSB7IGV4aXN0aW5nLnF1ZXJ5U2VsZWN0b3IoXCJpbnB1dFwiKT8uZm9jdXMoKTsgcmV0dXJuOyB9XG4gIGNvbnN0IGZvcm0gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZm9ybVwiKTtcbiAgZm9ybS5jbGFzc05hbWUgPSBcImZvbGxvd3VwLWZvcm1cIjtcbiAgZm9ybS5pbm5lckhUTUwgPSBgPGlucHV0IHR5cGU9XCJ0ZXh0XCIgcGxhY2Vob2xkZXI9XCJUZWxsIFx1MjAxQyR7ZXNjYXBlSHRtbCh0LmxhYmVsKX1cdTIwMURcdTIwMjZcIiBlbnRlcmtleWhpbnQ9XCJzZW5kXCI+PGJ1dHRvbiB0eXBlPVwic3VibWl0XCI+U2VuZDwvYnV0dG9uPmA7XG4gIGNvbnN0IGlucHV0ID0gZm9ybS5xdWVyeVNlbGVjdG9yKFwiaW5wdXRcIikhO1xuICBmb3JtLm9uc3VibWl0ID0gKGUpID0+IHtcbiAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgY29uc3QgdGV4dCA9IGlucHV0LnZhbHVlLnRyaW0oKTtcbiAgICBpZiAodGV4dCkge1xuICAgICAgaWYgKCFjYW5Gb2xsb3dVcFJlc3VsdChvcmlnaW5TZXNzaW9uLCBhY3RpdmVTZXNzaW9uLCB0YXNrcy5oYXModC5pZCkpKSB7XG4gICAgICAgIHRvYXN0KFwiVGhhdCB0YXNrJ3MgY2FsbCBoYXMgZW5kZWRcIik7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBwdXNoKHsgdHlwZTogXCJzdGVlclwiLCB0YXNrOiB0LmlkLCB0ZXh0IH0pO1xuICAgICAgICBub3RlKGBZb3UgXHUyMTkyICR7dC5sYWJlbH06ICR7dGV4dH1gKTtcbiAgICAgICAgc2Nyb2xsRG93bih0cnVlKTtcbiAgICAgIH1cbiAgICB9XG4gICAgaW5wdXQuYmx1cigpO1xuICAgIGZvcm0ucmVtb3ZlKCk7XG4gICAgc2hvd1Rhc2tzKCk7XG4gIH07XG4gIGlucHV0Lm9ua2V5ZG93biA9IChlKSA9PiB7IGlmIChlLmtleSA9PT0gXCJFc2NhcGVcIikgeyBlLnN0b3BQcm9wYWdhdGlvbigpOyBpbnB1dC5ibHVyKCk7IGZvcm0ucmVtb3ZlKCk7IHNob3dUYXNrcygpOyB9IH07XG4gIGNhcmQuYXBwZW5kKGZvcm0pO1xuICBpbnB1dC5mb2N1cygpO1xufVxuXG4vKiogVDMgdGhyZWFkcyBlYXJsaWVyIGNhbGxzIHN0YXJ0ZWQ6IHRoZXkgY2Fycnkgb24gYWZ0ZXIgYSBjYWxsLCBzbyB0aGUgcGFuZWwgc2F5cyBob3cgdGhleSdyZSBkb2luZy4gKi9cbmFzeW5jIGZ1bmN0aW9uIHNob3dFYXJsaWVyKCkge1xuICBsZXQgbGlzdDogeyB0aHJlYWQ6IHN0cmluZzsgdGl0bGU6IHN0cmluZzsgc3RhdHVzOiBzdHJpbmc7IGJyYW5jaDogc3RyaW5nIHwgbnVsbDsgcHI6IHN0cmluZyB8IG51bGw7IHVwZGF0ZWQ6IHN0cmluZzsgbGFzdDogc3RyaW5nOyB3YWl0aW5nOiBib29sZWFuIH1bXSA9IFtdO1xuICB0cnkgeyBsaXN0ID0gYXdhaXQgKGF3YWl0IGZldGNoKFwiL2FnZW50L3JlY2VudFwiLCB7IGNhY2hlOiBcIm5vLXN0b3JlXCIgfSkpLmpzb24oKTsgfSBjYXRjaCB7fVxuICBjb25zdCBjdXJyZW50ID0gbmV3IFNldChbLi4udGFza3MudmFsdWVzKCldLm1hcCgodikgPT4gdi50aHJlYWQpLmZpbHRlcihCb29sZWFuKSk7XG4gIGxpc3QgPSBsaXN0LmZpbHRlcigodCkgPT4gIWN1cnJlbnQuaGFzKHQudGhyZWFkKSk7XG4gIGNvbnN0IHBhbmUgPSAkKFwiZWFybGllclwiKTtcbiAgY29uc3QgZG9uZSA9ICQoXCJkb25lZWFybGllclwiKTtcbiAgcGFuZS5pbm5lckhUTUwgPSBcIlwiO1xuICBkb25lLmlubmVySFRNTCA9IFwiXCI7XG4gIGVhcmxpZXJBY3RpdmVDb3VudCA9IDA7XG4gIGVhcmxpZXJXYWl0aW5nQ291bnQgPSAwO1xuICBmb3IgKGNvbnN0IHQgb2YgbGlzdCkge1xuICAgIGNvbnN0IGNhcmQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGNvbnN0IHN0YXRlID0gdC53YWl0aW5nID8gXCJ3YWl0aW5nIGZvciBhcHByb3ZhbCBpbiBUM1wiIDogdC5zdGF0dXM7XG4gICAgY2FyZC5jbGFzc05hbWUgPSBgdGFzayAke3Quc3RhdHVzID09PSBcInJ1bm5pbmdcIiA/IFwicnVubmluZ1wiIDogdC53YWl0aW5nID8gXCJ3YWl0aW5nXCIgOiBcImZpbmlzaGVkXCJ9YDtcbiAgICBjb25zdCBhZ28gPSBNYXRoLm1heCgwLCAoRGF0ZS5ub3coKSAtIERhdGUucGFyc2UodC51cGRhdGVkKSkgLyAxMDAwKTtcbiAgICBjYXJkLmlubmVySFRNTCA9XG4gICAgICBgPGRpdiBjbGFzcz1cIm1ldGEtcm93XCI+YCArXG4gICAgICAgIGA8c3BhbiBjbGFzcz1cImJhZGdlIHQzXCI+VDM8L3NwYW4+YCArXG4gICAgICAgIGA8c3BhbiBjbGFzcz1cImxhYmVsXCI+PC9zcGFuPmAgK1xuICAgICAgICBgPHNwYW4gY2xhc3M9XCJzdGF0ZVwiPiR7dC5zdGF0dXMgPT09IFwicnVubmluZ1wiID8gJzxzcGFuIGNsYXNzPVwic3BpblwiPjwvc3Bhbj4nIDogXCJcIn0ke2VzY2FwZUh0bWwoc3RhdGUpfTwvc3Bhbj5gICtcbiAgICAgICAgYDxzcGFuIGNsYXNzPVwiYWdlXCI+JHtlbGFwc2VkKGFnbyl9IGFnbzwvc3Bhbj5gICtcbiAgICAgIGA8L2Rpdj5gICtcbiAgICAgIGA8ZGl2IGNsYXNzPVwicFwiPjwvZGl2PmA7XG4gICAgY29uc3QgbGFiZWxFbCA9IGNhcmQucXVlcnlTZWxlY3RvcihcIi5sYWJlbFwiKSBhcyBIVE1MRWxlbWVudDtcbiAgICBsYWJlbEVsLnRleHRDb250ZW50ID0gdC50aXRsZTtcbiAgICBsYWJlbEVsLnRpdGxlID0gdC50aXRsZTtcbiAgICBjYXJkLnF1ZXJ5U2VsZWN0b3IoXCIucFwiKSEudGV4dENvbnRlbnQgPSB0Lmxhc3QgfHwgKHQuYnJhbmNoID8gYE9uICR7dC5icmFuY2h9YCA6IFwiXCIpO1xuICAgIGNvbnN0IGFjdHMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGFjdHMuY2xhc3NOYW1lID0gXCJhY3RzXCI7XG4gICAgaWYgKHQucHIpIHsgY29uc3QgYSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJhXCIpOyBhLmhyZWYgPSB0LnByOyBhLnRhcmdldCA9IFwiX2JsYW5rXCI7IGEucmVsID0gXCJub29wZW5lclwiOyBhLnRleHRDb250ZW50ID0gXCJQUiBcdTIxOTdcIjsgYWN0cy5hcHBlbmQoYSk7IH1cbiAgICBjb25zdCBjb3B5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgICBjb3B5LnR5cGUgPSBcImJ1dHRvblwiO1xuICAgIGNvcHkudGV4dENvbnRlbnQgPSBcIkNvcHkgaWRcIjtcbiAgICBjb3B5Lm9uY2xpY2sgPSAoKSA9PiB7IHZvaWQgbmF2aWdhdG9yLmNsaXBib2FyZD8ud3JpdGVUZXh0KHQudGhyZWFkKTsgdG9hc3QoXCJUaHJlYWQgaWQgY29waWVkXCIpOyB9O1xuICAgIGFjdHMuYXBwZW5kKGNvcHkpO1xuICAgIGNhcmQuYXBwZW5kKGFjdHMpO1xuICAgIGNvbnN0IGFjdGl2ZSA9IHQuc3RhdHVzID09PSBcInJ1bm5pbmdcIiB8fCB0LndhaXRpbmc7XG4gICAgaWYgKGFjdGl2ZSkgZWFybGllckFjdGl2ZUNvdW50Kys7XG4gICAgaWYgKHQud2FpdGluZykgZWFybGllcldhaXRpbmdDb3VudCsrO1xuICAgIChhY3RpdmUgPyBwYW5lIDogZG9uZSkuYXBwZW5kKGNhcmQpO1xuICB9XG4gIHN5bmNTaWRlTGF5b3V0KCk7XG4gIHVwZGF0ZVRhc2tDaHJvbWUoKTtcbn1cblxuY29uc3QgU1RBVFVTX1RFWFQ6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gIGlkbGU6IFwiSWRsZVwiLCBjb25uZWN0aW5nOiBcIkNvbm5lY3RpbmdcdTIwMjZcIiwgbGlzdGVuaW5nOiBcIkxpc3RlbmluZ1wiLCB3b3JraW5nOiBcIkxpc3RlbmluZyBcdTAwQjcgdGFza3MgcnVubmluZ1wiLFxuICBzdGFuZGJ5OiBcIlBhdXNlZCB3aGlsZSB0YXNrcyBydW4gXHUwMEI3IHNwZWFrIHRvIHJlc3VtZVwiLCB3YWtpbmc6IFwiUmVzdW1pbmdcdTIwMjZcIiwgZW5kZWQ6IFwiRW5kZWRcIixcbn07XG5cbmZ1bmN0aW9uIHNob3dTdGF0dXMobWVzc2FnZT86IHN0cmluZykge1xuICBjb25zdCB0eXBlZCA9IEJvb2xlYW4oY2FsbElkKSAmJiBtZWRpdW0gPT09IFwidGV4dFwiO1xuICBjb25zdCBzcGVha2luZyA9IEJvb2xlYW4oY2FsbElkKSAmJiAhdHlwZWQgJiYgY29yZVN0YXR1cyAhPT0gXCJzdGFuZGJ5XCIgJiYgYXVkaW8ucXVldWVkID4gMC4wNTtcbiAgY29uc3Qgc2hvd24gPSBzcGVha2luZyB8fCAodHlwZWQgJiYgdGhpbmtpbmcpID8gXCJzcGVha2luZ1wiIDogY29yZVN0YXR1cztcbiAgJChcInN0YXR1c1wiKS5jbGFzc05hbWUgPSBzaG93bjtcbiAgZG9jdW1lbnQuYm9keS5kYXRhc2V0LnN0YXRlID0gY2FsbElkID8gc2hvd24gOiBcImlkbGVcIjtcbiAgZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QudG9nZ2xlKFwiaW4tc2Vzc2lvblwiLCBCb29sZWFuKGNhbGxJZCkpO1xuICBsZXQgdGV4dCA9IHNwZWFraW5nID8gXCJTcGVha2luZ1wiIDogU1RBVFVTX1RFWFRbY29yZVN0YXR1c10gPz8gY29yZVN0YXR1cztcbiAgaWYgKHR5cGVkICYmIGNvcmVTdGF0dXMgIT09IFwiZW5kZWRcIikgdGV4dCA9IHRoaW5raW5nID8gXCJXcml0aW5nXHUyMDI2XCIgOiBjb3JlU3RhdHVzID09PSBcIndvcmtpbmdcIiA/IFwiQ2hhdCBcdTAwQjcgdGFza3MgcnVubmluZ1wiIDogXCJDaGF0XCI7XG4gIGlmIChjYWxsSWQgJiYgIXR5cGVkICYmIG11dGVkICYmICFob2xkaW5nICYmICFzcGVha2luZykgdGV4dCArPSBcIiBcdTAwQjcgbXV0ZWRcIjtcbiAgaWYgKGhvbGRpbmcpIHRleHQgPSBcIlRhbGtpbmcgKGhvbGQpXCI7XG4gIGlmIChtZXNzYWdlKSB0ZXh0ID0gYCR7dGV4dH06ICR7bWVzc2FnZX1gO1xuICBpZiAoY29yZVN0YXR1cyAhPT0gXCJlbmRlZFwiIHx8IG1lc3NhZ2UpICQoXCJzdGF0dXN0ZXh0XCIpLnRleHRDb250ZW50ID0gdGV4dDtcbiAgJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJodXNoXCIpLmNsYXNzTGlzdC50b2dnbGUoXCJsaXZlXCIsIHNwZWFraW5nIHx8ICh0eXBlZCAmJiB0aGlua2luZykpO1xuXG4gIGNvbnN0IGJhciA9ICQoXCJjYWxsYmFyXCIpO1xuICBiYXIuaGlkZGVuID0gIWNhbGxJZDtcbiAgaWYgKGNhbGxJZCkge1xuICAgICQoXCJjYWxsYmFyLXN0YXRlXCIpLnRleHRDb250ZW50ID0gdGV4dDtcbiAgICAkKFwiY2FsbHRpbWVyXCIpLmhpZGRlbiA9IHR5cGVkO1xuICAgIGlmICghdHlwZWQpICQoXCJjYWxsdGltZXJcIikudGV4dENvbnRlbnQgPSBmb3JtYXRDbG9jayhub3coKSAtIHN0YXJ0ZWRBdCk7XG4gICAgY29uc3Qgdml6TW9kZSA9IHR5cGVkID8gKHRoaW5raW5nID8gXCJ0aGlua2luZ1wiIDogXCJpZGxlXCIpXG4gICAgICA6IHNwZWFraW5nID8gXCJzcGVha2luZ1wiXG4gICAgICA6IG11dGVkICYmICFob2xkaW5nID8gXCJtdXRlZFwiXG4gICAgICA6IHNob3duO1xuICAgIHVwZGF0ZVZpc3VhbGl6ZXIodml6TW9kZSwgbXV0ZWQgJiYgIWhvbGRpbmcgPyAwIDogYXVkaW8ubGV2ZWwpO1xuICB9XG59XG5cbi8vIFRoZSBjYWxsLlxuXG5mdW5jdGlvbiBwdXNoKGV2ZW50OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikge1xuICBpZiAoIWNvcmUgfHwgIWNhbGxJZCkgcmV0dXJuO1xuICBjb25zdCBlOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgLi4uZXZlbnQsIHQ6IG5vdygpIH07XG4gIGNvbnN0IHF1aWV0ID0gZS50eXBlID09PSBcIm1pY1wiIHx8IGUudHlwZSA9PT0gXCJ0aWNrXCI7XG4gIGlmICghcXVpZXQpIGxvZyhcImluXCIsIGUudHlwZSA9PT0gXCJ3cy5tZXNzYWdlXCIgPyBgd3MgJHtlLnNpZH0gXHUyMTkwICR7YnJpZWYoU3RyaW5nKGUuZGF0YSkpfWAgOiBKU09OLnN0cmluZ2lmeShlKS5zbGljZSgwLCA0MDApLCBcImluXCIpO1xuICBydW4oSlNPTi5wYXJzZShjb3JlLnB1c2goY2FsbElkLCBKU09OLnN0cmluZ2lmeShlKSkpKTtcbn1cblxuZnVuY3Rpb24gcnVuKGNvbW1hbmRzOiBDb21tYW5kW10pIHtcbiAgZm9yIChjb25zdCBjIG9mIGNvbW1hbmRzKSB7XG4gICAgc3dpdGNoIChjLnR5cGUpIHtcbiAgICAgIGNhc2UgXCJ3cy5jb25uZWN0XCI6IGNvbm5lY3QoYy5zaWQsIGMucHVycG9zZSA9PT0gXCJjYXB0aW9uc1wiKTsgYnJlYWs7XG4gICAgICBjYXNlIFwid3Muc2VuZFwiOiB7XG4gICAgICAgIHNvY2tldHMuZ2V0KGMuc2lkKT8uc2VuZChjLmRhdGEpO1xuICAgICAgICBpZiAoIWMuZGF0YS5zdGFydHNXaXRoKCd7XCJyZWFsdGltZUlucHV0XCI6e1wiYXVkaW9cIicpKSBsb2coXCJvdXRcIiwgYHdzICR7Yy5zaWR9IFx1MjE5MiAke2JyaWVmKGMuZGF0YSl9YCwgXCJvdXRcIik7XG4gICAgICAgIGVsc2UgaWYgKCFjYXB0aW9uU29ja2V0cy5oYXMoYy5zaWQpKSBjb3VudHMuc2VudCsrO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ3cy5jbG9zZVwiOiBzb2NrZXRzLmdldChjLnNpZCk/LmNsb3NlKCk7IHNvY2tldHMuZGVsZXRlKGMuc2lkKTsgbG9nKFwib3V0XCIsIGB3cyAke2Muc2lkfSBjbG9zZWAsIFwib3V0XCIpOyBicmVhaztcbiAgICAgIGNhc2UgXCJtaWMuc3RhcnRcIjpcbiAgICAgIGNhc2UgXCJtaWMucmVzdGFydFwiOlxuICAgICAgICBsb2coXCJvdXRcIiwgYy50eXBlLCBcIm91dFwiKTtcbiAgICAgICAgdm9pZCBhdWRpby5zdGFydE1pYyhvbk1pYywgbWljT3B0aW9ucygpKS5jYXRjaCgoZXJyKSA9PiB7IGxvZyhcImVycm9yXCIsIGBtaWNyb3Bob25lOiAke2Vyci5tZXNzYWdlfWAsIFwiZXJyXCIpOyB0b2FzdChgTWljcm9waG9uZTogJHtlcnIubWVzc2FnZX1gKTsgfSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcIm1pYy5zdG9wXCI6IGF1ZGlvLnN0b3BNaWMoKTsgYnJlYWs7XG4gICAgICBjYXNlIFwicGxheVwiOiB7XG4gICAgICAgIGNvbnN0IHQgPSBub3coKTtcbiAgICAgICAgLy8gQSByZXBseSBzdGFydGluZzogZnJvbSB0aGUgZW5kIG9mIHRoZSB1c2VyJ3Mgc3BlZWNoIHRvIGl0cyBmaXJzdCBzb3VuZC5cbiAgICAgICAgaWYgKCFtZXRyaWNzLnJlcGxpZWQgJiYgYXVkaW8ucXVldWVkIDwgMC4wNSAmJiB0IC0gbWV0cmljcy5sYXN0UGxheSA+IDAuNiAmJiBtZXRyaWNzLmxhc3RWb2ljZSA+IDAgJiYgdCAtIG1ldHJpY3MubGFzdFZvaWNlIDwgMTApIHtcbiAgICAgICAgICBtZXRyaWNzLnJlcGx5LnB1c2godCAtIG1ldHJpY3MubGFzdFZvaWNlKTtcbiAgICAgICAgICBpZiAobWV0cmljcy5yZXBseS5sZW5ndGggPiAyMCkgbWV0cmljcy5yZXBseS5zaGlmdCgpO1xuICAgICAgICAgIG1ldHJpY3MucmVwbGllZCA9IHRydWU7XG4gICAgICAgICAgc2hvd01ldHJpY3MoKTtcbiAgICAgICAgfVxuICAgICAgICBtZXRyaWNzLmxhc3RQbGF5ID0gdDtcbiAgICAgICAgYXVkaW8ucGxheShjLnBjbSk7XG4gICAgICAgIGNvdW50cy5wbGF5Kys7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcImZsdXNoXCI6IGF1ZGlvLmZsdXNoKCk7IGxvZyhcIm91dFwiLCBcImZsdXNoXCIsIFwib3V0XCIpOyBicmVhaztcbiAgICAgIGNhc2UgXCJjdWVcIjpcbiAgICAgICAgYXVkaW8uY3VlKGMucGNtKTtcbiAgICAgICAgbG9nKFwib3V0XCIsIGBjdWUgJHtjLmVhcmNvbn1gLCBcIm91dFwiKTtcbiAgICAgICAgLy8gQSByZXF1ZXN0IHRoYXQgYmVjYW1lIGEgdGFzayBnZXRzIGEgdG9uZSwgbm90IGEgc3Bva2VuIHJlcGx5OiBub3RoaW5nIHRvIHRpbWUuXG4gICAgICAgIGlmIChjLmVhcmNvbiA9PT0gXCJ0YXNrU3RhcnRlZFwiKSBtZXRyaWNzLnJlcGxpZWQgPSB0cnVlO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJ3YWtld29yZFwiOiBsb2coXCJvdXRcIiwgYHdha2Ugd29yZCAke2Mub24gPyBcImxpc3RlbmluZ1wiIDogXCJvZmZcIn1gLCBcIm91dFwiKTsgYnJlYWs7XG4gICAgICBjYXNlIFwidG9vbC5jYWxsXCI6IHZvaWQgdG9vbChjKTsgYnJlYWs7XG4gICAgICBjYXNlIFwidG9vbC5jYW5jZWxcIjogY2FuY2VsUnVuKGMucnVuLCBjLnJlYXNvbik7IGJyZWFrO1xuICAgICAgY2FzZSBcInRvb2wuc3RlZXJcIjogdm9pZCBzdGVlclJ1bihjKTsgYnJlYWs7XG4gICAgICBjYXNlIFwic3RhdHVzXCI6XG4gICAgICAgIGNvcmVTdGF0dXMgPSBjLnN0YXR1cztcbiAgICAgICAgc2hvd1N0YXR1cyhjLnN0YXR1cyA9PT0gXCJlbmRlZFwiID8gYy5tZXNzYWdlID8/IHVuZGVmaW5lZCA6IHVuZGVmaW5lZCk7XG4gICAgICAgIGxvZyhcInN0YXR1c1wiLCBjLnN0YXR1cyArIChjLm1lc3NhZ2UgPyBgOiAke2MubWVzc2FnZX1gIDogXCJcIiksIFwic3RhdHVzXCIpO1xuICAgICAgICBpZiAoYy5zdGF0dXMgPT09IFwiZW5kZWRcIikgeyBpZiAoYy5tZXNzYWdlKSBub3RlKGMubWVzc2FnZSk7IGVuZCgpOyB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcImxsbS5yZXF1ZXN0XCI6IHZvaWQgZ2VuZXJhdGUoYy5pZCwgYy5ib2R5KTsgYnJlYWs7XG4gICAgICBjYXNlIFwibGxtLmNhbmNlbFwiOiByZXF1ZXN0cy5nZXQoYy5pZCk/LmFib3J0KCk7IHJlcXVlc3RzLmRlbGV0ZShjLmlkKTsgbG9nKFwib3V0XCIsIGByZXF1ZXN0ICR7Yy5pZH0gZHJvcHBlZGAsIFwib3V0XCIpOyBicmVhaztcbiAgICAgIGNhc2UgXCJ0aGlua2luZ1wiOiB0aGlua2luZyA9IGMub247IHNob3dTdGF0dXMoKTsgYnJlYWs7XG4gICAgICBjYXNlIFwiZXJyb3JcIjogbm90ZShjLm1lc3NhZ2UpOyBsb2coXCJlcnJvclwiLCBjLm1lc3NhZ2UsIFwiZXJyXCIpOyBicmVhaztcbiAgICAgIGNhc2UgXCJjYXB0aW9uXCI6IGNhcHRpb24oYy50ZXh0KTsgYnJlYWs7XG4gICAgICBjYXNlIFwidHJhbnNjcmlwdFwiOlxuICAgICAgICB0cmFuc2NyaXB0KGMucm9sZSwgYy50ZXh0LCBjLmxpbmUpO1xuICAgICAgICByZW1lbWJlcihjLnJvbGUsIGMudGV4dCwgYy5yb2xlID09PSBcImFzc2lzdGFudFwiID8gXCJHZW1pbmlcIiA6IHVuZGVmaW5lZCwgbGFzdExpbmUgPT09IGMubGluZSk7XG4gICAgICAgIGxhc3RMaW5lID0gYy5saW5lO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJ0YXNrXCI6IHtcbiAgICAgICAgY29uc3QgdmlldyA9IHRhc2tzLmdldChjLmlkKSA/PyB7IGMsIHNpbmNlOiBub3coKSwgZW5kZWQ6IG51bGwgfTtcbiAgICAgICAgaWYgKGMuc3RhdGUgPT09IFwicnVubmluZ1wiICYmIHZpZXcuYy5zdGF0ZSAhPT0gXCJydW5uaW5nXCIpIHsgdmlldy5zaW5jZSA9IG5vdygpOyB2aWV3LmVuZGVkID0gbnVsbDsgfVxuICAgICAgICBpZiAoYy5zdGF0ZSAhPT0gXCJydW5uaW5nXCIgJiYgdmlldy5lbmRlZCA9PSBudWxsKSB2aWV3LmVuZGVkID0gbm93KCk7XG4gICAgICAgIHZpZXcuYyA9IGM7XG4gICAgICAgIHRhc2tzLnNldChjLmlkLCB2aWV3KTtcbiAgICAgICAgc2hvd1Rhc2tzKCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcInF1ZXN0aW9uc1wiOiBicmVhaztcbiAgICAgIGNhc2UgXCJtaWNTaWxlbnRcIjogJChcIm1pY3dhcm5cIikuaGlkZGVuID0gIWMuc2lsZW50OyBicmVhaztcbiAgICAgIGNhc2UgXCJ2b2ljZUNvbW1hbmRcIjpcbiAgICAgICAgdG9hc3QoYEhlYXJkIFx1MjAxQyR7Yy5oZWFyZH1cdTIwMUQ6ICR7Yy5jb21tYW5kID09PSBcInN0b3BcIiA/IFwic3RvcHBlZFwiIDogYy5jb21tYW5kID09PSBcImNhbmNlbEFsbFwiID8gXCJjYW5jZWxsaW5nIGV2ZXJ5IHRhc2tcIiA6IFwiaGFuZ2luZyB1cFwifWApO1xuICAgICAgICBsb2coXCJvdXRcIiwgYHZvaWNlIGNvbW1hbmQgJHtjLmNvbW1hbmR9OiAke2MuaGVhcmR9YCwgXCJvdXRcIik7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcImxvZ1wiOiBsb2coYy5sZXZlbCwgYy5tZXNzYWdlLCBjLmxldmVsID09PSBcIndhcm5cIiA/IFwid2FyblwiIDogXCJcIik7IGJyZWFrO1xuICAgICAgZGVmYXVsdDogbG9nKFwib3V0XCIsIEpTT04uc3RyaW5naWZ5KGMpLnNsaWNlKDAsIDMwMCksIFwib3V0XCIpO1xuICAgIH1cbiAgfVxufVxuXG5mdW5jdGlvbiBvbk1pYyhwY206IHN0cmluZywgbGV2ZWw6IG51bWJlcikge1xuICBjb3VudHMubWljKys7XG4gIGlmIChsZXZlbCA+IDAuMDMgJiYgIShtdXRlZCAmJiAhaG9sZGluZykpIHtcbiAgICBtZXRyaWNzLmxhc3RWb2ljZSA9IG5vdygpO1xuICAgIGlmIChhdWRpby5xdWV1ZWQgPCAwLjA1KSBtZXRyaWNzLnJlcGxpZWQgPSBmYWxzZTtcbiAgfVxuICBwdXNoKHsgdHlwZTogXCJtaWNcIiwgcGNtIH0pO1xufVxuXG5mdW5jdGlvbiBjb25uZWN0KHNpZDogbnVtYmVyLCBjYXB0aW9uczogYm9vbGVhbikge1xuICBjb25zdCB3cyA9IG5ldyBXZWJTb2NrZXQoYCR7bG9jYXRpb24ucHJvdG9jb2wgPT09IFwiaHR0cHM6XCIgPyBcIndzc1wiIDogXCJ3c1wifTovLyR7bG9jYXRpb24uaG9zdH0vbGl2ZSR7Y2FwdGlvbnMgPyBcIj9mb3I9Y2FwdGlvbnNcIiA6IFwiXCJ9YCk7XG4gIHNvY2tldHMuc2V0KHNpZCwgd3MpO1xuICBpZiAoY2FwdGlvbnMpIGNhcHRpb25Tb2NrZXRzLmFkZChzaWQpO1xuICBsb2coXCJvdXRcIiwgYHdzICR7c2lkfSBjb25uZWN0ICgke3NlcnZlci5yb3V0ZX0ke2NhcHRpb25zID8gXCIsIGNhcHRpb25zXCIgOiBcIlwifSlgLCBcIm91dFwiKTtcbiAgd3Mub25vcGVuID0gKCkgPT4gcHVzaCh7IHR5cGU6IFwid3Mub3BlblwiLCBzaWQgfSk7XG4gIHdzLm9ubWVzc2FnZSA9IChtKSA9PiBwdXNoKHsgdHlwZTogXCJ3cy5tZXNzYWdlXCIsIHNpZCwgZGF0YTogdHlwZW9mIG0uZGF0YSA9PT0gXCJzdHJpbmdcIiA/IG0uZGF0YSA6IFwiXCIgfSk7XG4gIHdzLm9uY2xvc2UgPSAoZSkgPT4ge1xuICAgIGlmIChzb2NrZXRzLmdldChzaWQpICE9PSB3cyAmJiBzb2NrZXRzLmhhcyhzaWQpKSByZXR1cm47XG4gICAgY29uc3QgaHR0cFN0YXR1cyA9IGUuY29kZSA+PSA0MTAwICYmIGUuY29kZSA8IDQ2MDAgPyBlLmNvZGUgLSA0MDAwIDogdW5kZWZpbmVkO1xuICAgIHB1c2goeyB0eXBlOiBcIndzLmNsb3NlZFwiLCBzaWQsIGNvZGU6IGh0dHBTdGF0dXMgPyB1bmRlZmluZWQgOiBlLmNvZGUsIHJlYXNvbjogZS5yZWFzb24sIGh0dHBTdGF0dXMgfSk7XG4gIH07XG59XG5cbi8qKiBBIGNoYXQncyByZXF1ZXN0IHRvIHRoZSB0ZXh0IG1vZGVsLCB0aHJvdWdoIHRoZSBzZXJ2ZXI6IGVhY2ggYGRhdGE6YCBsaW5lIG9mIHRoZSBtb2RlbCdzIHN0cmVhbSBnb2VzIHRvIHRoZSBjb3JlIGFzIGl0IGNvbWVzLiAqL1xuYXN5bmMgZnVuY3Rpb24gZ2VuZXJhdGUoaWQ6IG51bWJlciwgYm9keTogc3RyaW5nKSB7XG4gIGNvbnN0IGFib3J0ID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICByZXF1ZXN0cy5zZXQoaWQsIGFib3J0KTtcbiAgbG9nKFwib3V0XCIsIGByZXF1ZXN0ICR7aWR9IFx1MjE5MiAke3NlcnZlci50ZXh0TW9kZWx9ICgke01hdGgucm91bmQoYm9keS5sZW5ndGggLyAxMDI0KX0gS0IpYCwgXCJvdXRcIik7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChcIi9nZW5lcmF0ZVwiLCB7IG1ldGhvZDogXCJQT1NUXCIsIHNpZ25hbDogYWJvcnQuc2lnbmFsLCBoZWFkZXJzOiB7IFwiY29udGVudC10eXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sIGJvZHkgfSk7XG4gICAgaWYgKCFyZXNwb25zZS5vayB8fCAhcmVzcG9uc2UuYm9keSkge1xuICAgICAgY29uc3QgdGV4dCA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKS5jYXRjaCgoKSA9PiBcIlwiKTtcbiAgICAgIHB1c2goeyB0eXBlOiBcImxsbS5lbmRcIiwgaWQsIHN0YXR1czogcmVzcG9uc2Uuc3RhdHVzLCBlcnJvcjogYEhUVFAgJHtyZXNwb25zZS5zdGF0dXN9JHt0ZXh0ID8gXCI6IFwiICsgdGV4dC5yZXBsYWNlKC9cXHMrL2csIFwiIFwiKS5zbGljZSgwLCAyMDApIDogXCJcIn1gIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCByZWFkZXIgPSByZXNwb25zZS5ib2R5LnBpcGVUaHJvdWdoKG5ldyBUZXh0RGVjb2RlclN0cmVhbSgpKS5nZXRSZWFkZXIoKTtcbiAgICBsZXQgYnVmZmVyID0gXCJcIjtcbiAgICBmb3IgKDs7KSB7XG4gICAgICBjb25zdCB7IHZhbHVlLCBkb25lIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpO1xuICAgICAgaWYgKGRvbmUpIGJyZWFrO1xuICAgICAgYnVmZmVyICs9IHZhbHVlO1xuICAgICAgbGV0IGN1dDtcbiAgICAgIHdoaWxlICgoY3V0ID0gYnVmZmVyLmluZGV4T2YoXCJcXG5cIikpID49IDApIHtcbiAgICAgICAgY29uc3QgbGluZSA9IGJ1ZmZlci5zbGljZSgwLCBjdXQpLnJlcGxhY2UoL1xcciQvLCBcIlwiKTtcbiAgICAgICAgYnVmZmVyID0gYnVmZmVyLnNsaWNlKGN1dCArIDEpO1xuICAgICAgICBpZiAobGluZS5zdGFydHNXaXRoKFwiZGF0YTpcIikpIHB1c2goeyB0eXBlOiBcImxsbS5kYXRhXCIsIGlkLCBkYXRhOiBsaW5lLnNsaWNlKDUpLnRyaW0oKSB9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgcHVzaCh7IHR5cGU6IFwibGxtLmVuZFwiLCBpZCB9KTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgaWYgKCFhYm9ydC5zaWduYWwuYWJvcnRlZCkgcHVzaCh7IHR5cGU6IFwibGxtLmVuZFwiLCBpZCwgZXJyb3I6IChlcnIgYXMgRXJyb3IpLm1lc3NhZ2UgfSk7XG4gIH0gZmluYWxseSB7XG4gICAgcmVxdWVzdHMuZGVsZXRlKGlkKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBjYW5jZWxSdW4oa2V5OiBzdHJpbmcsIHJlYXNvbjogc3RyaW5nKSB7XG4gIGNvbnN0IHIgPSBydW5zLmdldChrZXkpO1xuICBsb2coXCJvdXRcIiwgYGNhbmNlbCAke2tleX0gKCR7cmVhc29ufSlgLCBcIm91dFwiKTtcbiAgaWYgKCFyKSByZXR1cm47XG4gIHJ1bnMuZGVsZXRlKGtleSk7XG4gIHIuYWJvcnQuYWJvcnQoKTtcbiAgLy8gQ2FuY2VsbGVkIG9uIHB1cnBvc2U6IHRoZSBhZ2VudCBzdG9wcyB0b28uIEEgY2FsbCB0aGF0IGVuZGVkIGxlYXZlcyBhIGNvZGluZyBhZ2VudCB3b3JraW5nIGluIFQzLlxuICBpZiAocmVhc29uID09PSBcImNhbmNlbGxlZFwiICYmICFjaGVja2VkKFwiZmFrZWhlcm1lc1wiKSkge1xuICAgIHZvaWQgZmV0Y2goci5hZ2VudCA9PT0gXCJ0M1wiID8gXCIvYWdlbnQvY2FuY2VsXCIgOiBcIi9oZXJtZXMvc3RvcFwiLCB7IG1ldGhvZDogXCJQT1NUXCIsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgY2FsbDogY2FsbE5hbWUsIHRhc2tJZDogci50YXNrSWQgfSkgfSk7XG4gIH1cbn1cblxuLyoqIE1vcmUgZm9yIGEgcnVubmluZyB0YXNrLCBpbnRvIGl0cyBjdXJyZW50IHJ1bjsgaWYgdGhlIGFnZW50IHdvbid0IHRha2UgaXQsIHRoZSBjb3JlIHF1ZXVlcyBpdCBpbnN0ZWFkLiAqL1xuYXN5bmMgZnVuY3Rpb24gc3RlZXJSdW4oYzogQ29tbWFuZCkge1xuICBjb25zdCByID0gcnVucy5nZXQoYy5ydW4pO1xuICBsb2coXCJvdXRcIiwgYHN0ZWVyICR7Yy5ydW59OiAke2MudGV4dH1gLCBcIm91dFwiKTtcbiAgaWYgKGNoZWNrZWQoXCJmYWtlaGVybWVzXCIpKSByZXR1cm47XG4gIGNvbnN0IG9rID0gciAhPSBudWxsICYmXG4gICAgKGF3YWl0IGZldGNoKGMuYWdlbnQgPT09IFwidDNcIiA/IFwiL2FnZW50L3N0ZWVyXCIgOiBcIi9oZXJtZXMvc3RlZXJcIiwgeyBtZXRob2Q6IFwiUE9TVFwiLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGNhbGw6IGNhbGxOYW1lLCB0YXNrSWQ6IHIudGFza0lkLCB0ZXh0OiBjLm1lc3NhZ2UgfSkgfSkudGhlbigoeCkgPT4geC5vaywgKCkgPT4gZmFsc2UpKTtcbiAgaWYgKCFvaykgcHVzaCh7IHR5cGU6IFwidG9vbC5zdGVlckZhaWxlZFwiLCBydW46IGMucnVuLCB0ZXh0OiBjLnRleHQgfSk7XG4gIGVsc2UgdG9hc3QoYCR7Yy5hZ2VudCA9PT0gXCJ0M1wiID8gXCJUaGUgY29kaW5nIGFnZW50XCIgOiBcIkhlcm1lc1wifSB0b29rIHRoZSBmb2xsb3ctdXAgd2hpbGUgaXQgd29ya3NgKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gdG9vbChjOiBDb21tYW5kKSB7XG4gIGlmIChjLmtpbmQgPT09IFwiaG9zdFwiKSB7XG4gICAgbG9nKFwib3V0XCIsIGBob3N0IHRvb2wgJHtjLm5hbWV9ICR7SlNPTi5zdHJpbmdpZnkoYy5hcmdzKX1gLCBcIm91dFwiKTtcbiAgICBjb25zdCBhbnN3ZXIgPSBjLm5hbWUgPT09IFwidHZfdm9sdW1lXCIgPyBgVGhlIFRWIGlzIGF0ICR7KGZha2VUdkxldmVsID0gTnVtYmVyKGMuYXJncz8ubGV2ZWwgPz8gZmFrZVR2TGV2ZWwpKX0uYFxuICAgICAgOiBjLm5hbWUgPT09IFwidHZfcGF1c2VcIiA/IChjLmFyZ3M/LnBhdXNlID09PSBmYWxzZSA/IFwiUGxheWluZy5cIiA6IFwiUGF1c2VkLlwiKSA6IFwiRG9uZS5cIjtcbiAgICBzZXRUaW1lb3V0KCgpID0+IHB1c2goeyB0eXBlOiBcInRvb2wucmVzdWx0XCIsIHJ1bjogYy5ydW4sIHRleHQ6IGFuc3dlciB9KSwgMzAwKTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgYWdlbnQgPSBjLmFnZW50ID09PSBcInQzXCIgPyBcInQzXCIgOiBcImhlcm1lc1wiO1xuICBjb25zdCBvcmlnaW5TZXNzaW9uID0gYWN0aXZlU2Vzc2lvbjtcbiAgbG9nKFwib3V0XCIsIGAke2FnZW50fSAke2MuZm9sbG93VXAgPyBcImZvbGxvdy11cFwiIDogXCJ0YXNrXCJ9IFwiJHtjLmxhYmVsfVwiJHtjLnByb2plY3QgPyBgIGluICR7Yy5wcm9qZWN0fWAgOiBcIlwifTogJHtjLnJlcXVlc3R9YCwgXCJvdXRcIik7XG4gIGNvbnN0IGFib3J0ID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICBydW5zLnNldChjLnJ1biwgeyBhYm9ydCwgYWdlbnQsIHRhc2tJZDogYy50YXNrSWQgfSk7XG4gIGNvbnN0IGRvbmUgPSAodGV4dDogc3RyaW5nLCBmYWlsZWQgPSBmYWxzZSkgPT4ge1xuICAgIGlmICghcnVucy5oYXMoYy5ydW4pKSByZXR1cm47XG4gICAgcnVucy5kZWxldGUoYy5ydW4pO1xuICAgIGNvbnN0IHZpZXcgPSB0YXNrcy5nZXQoYy50YXNrSWQpO1xuICAgIGNvbnN0IHJlc0lkID0gcmVzdWx0KGFnZW50LCBjLmxhYmVsLCB0ZXh0LCBmYWlsZWQsIGMudGFza0lkLCBvcmlnaW5TZXNzaW9uKTtcbiAgICBub3RpZnkoYCR7YWdlbnQgPT09IFwidDNcIiA/IFwiVDNcIiA6IFwiSGVybWVzXCJ9IFx1MDBCNyAke2MubGFiZWx9YCwgdGV4dCk7XG4gICAgaWYgKCFmYWlsZWQpIHsgcmVtZW1iZXIoXCJhc3Npc3RhbnRcIiwgdGV4dCwgYCR7YWdlbnQgPT09IFwidDNcIiA/IFwiVDNcIiA6IFwiSGVybWVzXCJ9IFx1MDBCNyAke2MubGFiZWx9YCk7IGxhc3RMaW5lID0gbnVsbDsgfVxuICAgIGlmICh2aWV3KSB7IHZpZXcucmVzdWx0SWQgPSByZXNJZDsgc2hvd1Rhc2tzKCk7IH1cbiAgICBwdXNoKHsgdHlwZTogXCJ0b29sLnJlc3VsdFwiLCBydW46IGMucnVuLCB0ZXh0LCBmYWlsZWQgfSk7XG4gIH07XG4gIGlmIChjaGVja2VkKFwiZmFrZWhlcm1lc1wiKSkge1xuICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiBkb25lKGAoRmFrZSAke2FnZW50ID09PSBcInQzXCIgPyBcIlQzXCIgOiBcIkhlcm1lc1wifSkgRG9uZTogXHUyMDFDJHtjLnJlcXVlc3R9XHUyMDFELiBOb3RoaW5nIHdhcyBhY3R1YWxseSBydW4uYCksIE51bWJlcigkPEhUTUxJbnB1dEVsZW1lbnQ+KFwiZmFrZWRlbGF5XCIpLnZhbHVlKSAqIDEwMDApO1xuICAgIGFib3J0LnNpZ25hbC5vbmFib3J0ID0gKCkgPT4gY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICByZXR1cm47XG4gIH1cbiAgdHJ5IHtcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKGFnZW50ID09PSBcInQzXCIgPyBcIi9hZ2VudFwiIDogXCIvaGVybWVzXCIsIHtcbiAgICAgIG1ldGhvZDogXCJQT1NUXCIsIHNpZ25hbDogYWJvcnQuc2lnbmFsLCBoZWFkZXJzOiB7IFwiY29udGVudC10eXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGNhbGw6IGNhbGxOYW1lLCB0YXNrSWQ6IGMudGFza0lkLCBmb2xsb3dVcDogYy5mb2xsb3dVcCwgbWVzc2FnZTogYy5tZXNzYWdlLCBsYWJlbDogYy5sYWJlbCwgcmVxdWVzdDogYy5yZXF1ZXN0LCBwcm9qZWN0OiBjLnByb2plY3QsIGFwcHJvdmFsczogXCJzY3JlZW5cIiB9KSxcbiAgICB9KTtcbiAgICBpZiAoIXJlc3BvbnNlLm9rIHx8ICFyZXNwb25zZS5ib2R5KSB0aHJvdyBuZXcgRXJyb3IoYEhUVFAgJHtyZXNwb25zZS5zdGF0dXN9YCk7XG4gICAgY29uc3QgcmVhZGVyID0gcmVzcG9uc2UuYm9keS5waXBlVGhyb3VnaChuZXcgVGV4dERlY29kZXJTdHJlYW0oKSkuZ2V0UmVhZGVyKCk7XG4gICAgbGV0IGJ1ZmZlciA9IFwiXCI7XG4gICAgZm9yICg7Oykge1xuICAgICAgY29uc3QgeyB2YWx1ZSwgZG9uZTogZmluaXNoZWQgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICBpZiAoZmluaXNoZWQpIGJyZWFrO1xuICAgICAgYnVmZmVyICs9IHZhbHVlO1xuICAgICAgbGV0IGN1dDtcbiAgICAgIHdoaWxlICgoY3V0ID0gYnVmZmVyLmluZGV4T2YoXCJcXG5cXG5cIikpID49IDApIHtcbiAgICAgICAgY29uc3QgYmxvY2sgPSBidWZmZXIuc2xpY2UoMCwgY3V0KTtcbiAgICAgICAgYnVmZmVyID0gYnVmZmVyLnNsaWNlKGN1dCArIDIpO1xuICAgICAgICBjb25zdCBldmVudCA9IGJsb2NrLm1hdGNoKC9eZXZlbnQ6ICguKikkL20pPy5bMV07XG4gICAgICAgIGlmICghZXZlbnQpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCBkYXRhID0gSlNPTi5wYXJzZShibG9jay5tYXRjaCgvXmRhdGE6ICguKikkL20pPy5bMV0gPz8gXCJ7fVwiKTtcbiAgICAgICAgaWYgKGV2ZW50ID09PSBcInByb2dyZXNzXCIpIHB1c2goeyB0eXBlOiBcInRhc2sucHJvZ3Jlc3NcIiwgdGFzazogYy50YXNrSWQsIHRleHQ6IGRhdGEudGV4dCB9KTtcbiAgICAgICAgZWxzZSBpZiAoZXZlbnQgPT09IFwidGhyZWFkXCIpIHsgY29uc3QgdmlldyA9IHRhc2tzLmdldChjLnRhc2tJZCk7IGlmICh2aWV3KSB7IHZpZXcudGhyZWFkID0gZGF0YS50aHJlYWQ7IHNob3dUYXNrcygpOyB9IH1cbiAgICAgICAgZWxzZSBpZiAoZXZlbnQgPT09IFwiYXBwcm92YWxcIikge1xuICAgICAgICAgIGNvbnN0IHZpZXcgPSB0YXNrcy5nZXQoYy50YXNrSWQpO1xuICAgICAgICAgIGlmICh2aWV3KSB7IHZpZXcuYXBwcm92YWwgPSB7IGNvbW1hbmQ6IGRhdGEuY29tbWFuZCB9OyBzaG93VGFza3ModHJ1ZSk7IH1cbiAgICAgICAgICB0b2FzdChgSGVybWVzIGFza3MgdG8gcnVuOiAke2RhdGEuY29tbWFuZC5zbGljZSgwLCA4MCl9YCk7XG4gICAgICAgICAgbm90aWZ5KGBIZXJtZXMgXHUwMEI3ICR7Yy5sYWJlbH0gbmVlZHMgeW91ciBhcHByb3ZhbGAsIGRhdGEuY29tbWFuZCk7XG4gICAgICAgICAgYXVkaW8uY3VlKEFQUFJPVkFMX1RPTkUpO1xuICAgICAgICB9XG4gICAgICAgIGVsc2UgaWYgKGV2ZW50ID09PSBcInJlc3VsdFwiKSBkb25lKGRhdGEudGV4dCwgZGF0YS5mYWlsZWQpO1xuICAgICAgICBlbHNlIGlmIChldmVudCA9PT0gXCJlcnJvclwiKSB7IHJ1bnMuZGVsZXRlKGMucnVuKTsgcHVzaCh7IHR5cGU6IFwidG9vbC5lcnJvclwiLCBydW46IGMucnVuLCBtZXNzYWdlOiBkYXRhLm1lc3NhZ2UgfSk7IH1cbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKHJ1bnMuaGFzKGMucnVuKSkgeyBydW5zLmRlbGV0ZShjLnJ1bik7IHB1c2goeyB0eXBlOiBcInRvb2wuZXJyb3JcIiwgcnVuOiBjLnJ1biwgbWVzc2FnZTogXCJ0aGUgc2VydmVyIGNsb3NlZCB0aGUgc3RyZWFtIHdpdGhvdXQgYSByZXN1bHRcIiB9KTsgfVxuICB9IGNhdGNoIChlcnIpIHtcbiAgICBpZiAoIWFib3J0LnNpZ25hbC5hYm9ydGVkICYmIHJ1bnMuaGFzKGMucnVuKSkgeyBydW5zLmRlbGV0ZShjLnJ1bik7IHB1c2goeyB0eXBlOiBcInRvb2wuZXJyb3JcIiwgcnVuOiBjLnJ1biwgbWVzc2FnZTogKGVyciBhcyBFcnJvcikubWVzc2FnZSB9KTsgfVxuICB9XG59XG5cbmZ1bmN0aW9uIG1pY09wdGlvbnMoKSB7XG4gIGNvbnN0IGFlYyA9IGNoZWNrZWQoXCJhZWNcIik7XG4gIHJldHVybiB7IGVjaG9DYW5jZWxsYXRpb246IGFlYywgbm9pc2VTdXBwcmVzc2lvbjogYWVjLCBhdXRvR2FpbkNvbnRyb2w6IGFlYyB9O1xufVxuXG5mdW5jdGlvbiByZWFkQ29uZmlnKCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgY29uc3QgZ2l2ZW4gPSBKU09OLnBhcnNlKCQ8SFRNTFRleHRBcmVhRWxlbWVudD4oXCJjb25maWdcIikudmFsdWUpO1xuICBjb25zdCBjb25maWc6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgIG1vZGVsOiBzZXJ2ZXIubW9kZWwsIGFwaTogc2VydmVyLnJvdXRlID09PSBcInZlcnRleFwiID8gXCJ2ZXJ0ZXhcIiA6IFwiZ2VtaW5pXCIsIHRvZGF5OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkuc2xpY2UoMCwgMTApLFxuICAgIC4uLmdpdmVuLCB0cmFjZTogY2hlY2tlZChcInRyYWNlXCIpLFxuICB9O1xuICBpZiAoY2hlY2tlZChcInB0dFwiKSkgY29uZmlnLm11dGVkID0gdHJ1ZTtcbiAgaWYgKGdpdmVuLnZvaWNlID09PSB1bmRlZmluZWQpIGNvbmZpZy52b2ljZSA9ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwidm9pY2VcIikudmFsdWU7XG4gIGlmIChjb25maWcuc3RlZXJpbmcgPT09IHVuZGVmaW5lZCkgY29uZmlnLnN0ZWVyaW5nID0gW1wiaGVybWVzXCIsIFwidDNcIl07XG4gIC8vIEEgd2ViIGNvbmZpZyBzYXZlZCBiZWZvcmUgaGFuZC1vZmZzIHdlcmUgbmFtZWQgaW4gd29yZHMgZ2V0cyB0aGF0IHRvby5cbiAgaWYgKGNvbmZpZy5oYW5kT2ZmID09PSB1bmRlZmluZWQgJiYgY29uZmlnLnBsYXRmb3JtID09PSBcIndlYlwiKSBjb25maWcuaGFuZE9mZiA9IFwibmFtZWRcIjtcbiAgLy8gQW5kIG9uZSBzYXZlZCBiZWZvcmUgdGhlIHBhZ2UgZm9sbG93ZWQgdGhlIHVzZXIncyBsZWFkIChzdXBlcnZpc2UpIGdldHMgdGhhdC5cbiAgaWYgKGNvbmZpZy5zdXBlcnZpc2UgPT09IHVuZGVmaW5lZCAmJiBjb25maWcucGxhdGZvcm0gPT09IFwid2ViXCIpIGNvbmZpZy5zdXBlcnZpc2UgPSB0cnVlO1xuICBpZiAoY2hlY2tlZChcImNvZGluZ1wiKSAmJiAoc2VydmVyLnQzIHx8IGNoZWNrZWQoXCJmYWtlaGVybWVzXCIpKSAmJiBjb25maWcuY29kaW5nQWdlbnQgPT09IHVuZGVmaW5lZCkgY29uZmlnLmNvZGluZ0FnZW50ID0geyBwcm9qZWN0czogc2VydmVyLnQzID8/IFtdIH07XG4gIGlmIChjaGVja2VkKFwiY2FwdGlvbnNcIikgJiYgc2VydmVyLmNhcHRpb25zTW9kZWwgJiYgY29uZmlnLmNhcHRpb25zID09PSB1bmRlZmluZWQpIGNvbmZpZy5jYXB0aW9ucyA9IHsgbW9kZWw6IHNlcnZlci5jYXB0aW9uc01vZGVsIH07XG4gIHJldHVybiBjb25maWc7XG59XG5cbi8qKiBTdGFydHMgYSB2b2ljZSBjYWxsLCBvciB3aXRoIFt0eXBlZF0gYSBjaGF0ICh0aGUgY29yZSdzIG1lZGl1bSBcInRleHRcIjogbm8gYXVkaW8sIGEgdGV4dCBtb2RlbCkuICovXG5hc3luYyBmdW5jdGlvbiBzdGFydChjYXJyeU9uID0gZmFsc2UsIHR5cGVkID0gZmFsc2UpIHtcbiAgYXdhaXQgZW5kaW5nO1xuICBpZiAoY2FsbElkKSByZXR1cm47XG4gIGxldCBnaXZlbjogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIHRyeSB7XG4gICAgZ2l2ZW4gPSByZWFkQ29uZmlnKCk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHRvYXN0KGBUaGUgZGV2ZWxvcGVyIHNldHRpbmdzIGFyZW4ndCB2YWxpZCBKU09OOiAkeyhlcnIgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmICh0eXBlZCkge1xuICAgIGlmICghc2VydmVyLnRleHRNb2RlbCkgeyB0b2FzdChcIlRoaXMgc2VydmVyIGhhcyBubyB0ZXh0IG1vZGVsIGZvciBhIGNoYXQ6IHN0YXJ0IGEgY2FsbCB0byB0eXBlIHRvIGl0XCIpOyByZXR1cm47IH1cbiAgICBnaXZlbiA9IHsgLi4uZ2l2ZW4sIG1lZGl1bTogXCJ0ZXh0XCIsIG11dGVkOiBmYWxzZSB9O1xuICAgIGRlbGV0ZSBnaXZlbi5jYXB0aW9ucztcbiAgfVxuICAkPEhUTUxCdXR0b25FbGVtZW50PihcImNhbGxcIikuZGlzYWJsZWQgPSB0cnVlO1xuICAkPEhUTUxCdXR0b25FbGVtZW50PihcImhlcm8tY2FsbFwiKS5kaXNhYmxlZCA9IHRydWU7XG4gIGlmIChcIk5vdGlmaWNhdGlvblwiIGluIHdpbmRvdyAmJiBOb3RpZmljYXRpb24ucGVybWlzc2lvbiA9PT0gXCJkZWZhdWx0XCIpIHZvaWQgTm90aWZpY2F0aW9uLnJlcXVlc3RQZXJtaXNzaW9uKCkuY2F0Y2goKCkgPT4ge30pO1xuICB0cnkge1xuICAgIGlmICghdHlwZWQpIGF3YWl0IGF1ZGlvLm9wZW4oKTtcbiAgICBjb3JlID0gYXdhaXQgbG9hZENvcmUoKTtcbiAgfSBmaW5hbGx5IHtcbiAgICAkPEhUTUxCdXR0b25FbGVtZW50PihcImNhbGxcIikuZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAkPEhUTUxCdXR0b25FbGVtZW50PihcImhlcm8tY2FsbFwiKS5kaXNhYmxlZCA9IGZhbHNlO1xuICB9XG4gIGlmIChjYWxsSWQpIHJldHVybjsgLy8gYW5vdGhlciBzdGFydCBnb3QgdGhlcmUgZmlyc3RcbiAgbWVkaXVtID0gdHlwZWQgPyBcInRleHRcIiA6IFwidm9pY2VcIjtcbiAgdGhpbmtpbmcgPSBmYWxzZTtcbiAgJChcInZlcnNpb25cIikudGV4dENvbnRlbnQgPSBjb3JlLnZlcnNpb247XG4gICQoXCJsb2dcIikuaW5uZXJIVE1MID0gXCJcIjtcbiAgaWYgKCF0eXBlZCAmJiAodGFza3Muc2l6ZSA+IDAgfHwgJChcInRyYW5zY3JpcHRcIikuY2hpbGRFbGVtZW50Q291bnQgPiAxKSkgbm90ZShgTmV3IGNhbGwgXHUwMEI3ICR7bmV3IERhdGUoKS50b0xvY2FsZVRpbWVTdHJpbmcoKX1gKTtcbiAgc2Nyb2xsRG93bih0cnVlKTtcbiAgdGFza3MuY2xlYXIoKTtcbiAgYWN0aXZlU2Vzc2lvbiA9ICsrc2Vzc2lvblNlcTtcbiAgc2hvd1Rhc2tzKCk7XG4gIGNvdW50cyA9IHsgbWljOiAwLCBwbGF5OiAwLCBzZW50OiAwIH07XG4gIG1ldHJpY3MucmVwbHkgPSBbXTtcbiAgc3RhcnRlZEF0ID0gbm93KCk7XG4gIG11dGVkID0gZ2l2ZW4ubXV0ZWQgPT09IHRydWU7XG4gIC8vIENhcnJ5aW5nIG9uOiB0aGUgbW9kZWwgZ2V0cyB0aGUgbGFzdCBjb252ZXJzYXRpb24gYXMgYSByZWNhcC4gVGhlIGNvcmUgY2FwcyBpdCwgbGF0ZXN0IGxpbmVzIGZpcnN0LlxuICAvLyBBIGNoYXQgYWx3YXlzIGNhcnJpZXMgb24gZnJvbSB3aGF0J3Mgb24gdGhlIHNjcmVlbiAoYW4gZWFybGllciBjYWxsIG9yIGNoYXQgb24gdGhpcyBwYWdlKS5cbiAgaWYgKHR5cGVkKSB7IGlmIChjaGF0Lmxlbmd0aCA+IDAgJiYgZ2l2ZW4uaGlzdG9yeSA9PT0gdW5kZWZpbmVkKSBnaXZlbi5oaXN0b3J5ID0gY2hhdDsgfVxuICBlbHNlIGlmIChjYXJyeU9uICYmIGdpdmVuLmhpc3RvcnkgPT09IHVuZGVmaW5lZCkgZ2l2ZW4uaGlzdG9yeSA9IHNhdmVkSGlzdG9yeSgpO1xuICBlbHNlIGlmICghY2FycnlPbikgY2hhdCA9IFtdO1xuICBpZiAoY2FycnlPbiAmJiAhdHlwZWQpIGNoYXQgPSBzYXZlZEhpc3RvcnkoKTtcbiAgbGFzdExpbmUgPSBudWxsO1xuICBvcGVuTGluZSA9IG51bGw7XG4gIHN5bmNSZXN1bWVCdXR0b25zKGZhbHNlKTtcbiAgY2FsbE5hbWUgPSBgJHtuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkucmVwbGFjZSgvWzouXS9nLCBcIi1cIil9LSR7dHlwZWQgPyBcImNoYXRcIiA6IFwid2ViXCJ9LSR7Y29yZS52ZXJzaW9ufWA7XG4gIGNvbnN0IGNyZWF0ZWQgPSBKU09OLnBhcnNlKGNvcmUuY3JlYXRlKEpTT04uc3RyaW5naWZ5KGdpdmVuKSwgbm93KCkpKTtcbiAgY2FsbElkID0gY3JlYXRlZC5pZDtcbiAgaWYgKCF0eXBlZCkge1xuICAgIHNldENhbGxCdXR0b24odHJ1ZSk7XG4gICAgJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJtaWNcIikuZGlzYWJsZWQgPSBmYWxzZTtcbiAgfVxuICAkPEhUTUxCdXR0b25FbGVtZW50PihcImh1c2hcIikuZGlzYWJsZWQgPSBmYWxzZTtcbiAgJChcIm1pY1wiKS5jbGFzc0xpc3QudG9nZ2xlKFwibXV0ZWRcIiwgbXV0ZWQpO1xuICBydW4oY3JlYXRlZC5jb21tYW5kcyk7XG4gIHNob3dTdGF0dXMoKTtcbiAgdGlja2VyID0gd2luZG93LnNldEludGVydmFsKCgpID0+IHtcbiAgICBwdXNoKHsgdHlwZTogXCJ0aWNrXCIgfSk7XG4gICAgY29uc3QgbGV2ZWwgPSBtdXRlZCAmJiAhaG9sZGluZyA/IDAgOiBhdWRpby5sZXZlbDtcbiAgICBjb25zdCBzdHJlbmd0aCA9IE1hdGgubWluKDEsIGxldmVsICogMTIpO1xuICAgICQoXCJyaW5nXCIpLnN0eWxlLm9wYWNpdHkgPSBTdHJpbmcoc3RyZW5ndGgpO1xuICAgICQoXCJyaW5nXCIpLnN0eWxlLnRyYW5zZm9ybSA9IGBzY2FsZSgkeygxICsgc3RyZW5ndGggKiAwLjEyKS50b0ZpeGVkKDMpfSlgO1xuICAgICQoXCJjb3VudHNcIikudGV4dENvbnRlbnQgPSBgbWljICR7Y291bnRzLm1pY30gXHUwMEI3IHNlbnQgJHtjb3VudHMuc2VudH0gXHUwMEI3IHBsYXllZCAke2NvdW50cy5wbGF5fSBcdTAwQjcgcXVldWVkICR7YXVkaW8ucXVldWVkLnRvRml4ZWQoMSl9IHNgO1xuICAgIHNob3dTdGF0dXMoKTtcbiAgfSwgMTAwKTtcbiAgdHJhY2VUaW1lciA9IHdpbmRvdy5zZXRJbnRlcnZhbCgoKSA9PiB7IHZvaWQgc2F2ZVRyYWNlKCk7IHZvaWQgcGluZygpOyBzaG93VGFza3MoKTsgfSwgNTAwMCk7XG4gIHZvaWQgcGluZygpO1xuICBpZiAodHlwZWQpIHJldHVybjtcbiAgc3RvcFdvcmRzLnN0YXJ0KCk7XG4gIHRyeSB7IHdha2VMb2NrID0gYXdhaXQgKG5hdmlnYXRvciBhcyBhbnkpLndha2VMb2NrPy5yZXF1ZXN0KFwic2NyZWVuXCIpOyB9IGNhdGNoIHt9XG59XG5cbi8qKiBUaGUgQ2FsbCBidXR0b246IGhhbmdzIHVwIGEgY2FsbDsgc3RhcnRzIG9uZTsgb3IsIHdpdGggYSBjaGF0IG9uLCBlbmRzIHRoZSBjaGF0IGFuZCBjYXJyaWVzIGl0cyBjb252ZXJzYXRpb24gb24gYnkgdm9pY2UuICovXG5hc3luYyBmdW5jdGlvbiBjYWxsQnV0dG9uKCkge1xuICBpZiAoY2FsbElkICYmIG1lZGl1bSA9PT0gXCJ2b2ljZVwiKSB7IGhhbmdVcCgpOyByZXR1cm47IH1cbiAgaWYgKGNhbGxJZCkge1xuICAgIC8vIEEgY2FsbCBjYW4ndCB0YWtlIG92ZXIgdGhlIGNoYXQncyB0YXNrcywgYW5kIGVuZGluZyB0aGUgY2hhdCB3b3VsZCBzdG9wIHRoZW0uXG4gICAgaWYgKFsuLi50YXNrcy52YWx1ZXMoKV0uc29tZSgodikgPT4gdi5jLnN0YXRlID09PSBcInJ1bm5pbmdcIikpIHsgdG9hc3QoXCJUaGUgY2hhdCdzIHRhc2tzIGFyZSBzdGlsbCBydW5uaW5nOiB3YWl0IGZvciB0aGVtIG9yIGNhbmNlbCB0aGVtLCB0aGVuIGNhbGxcIik7IHJldHVybjsgfVxuICAgIHB1c2goeyB0eXBlOiBcInN0b3BcIiB9KTtcbiAgICBhd2FpdCBzdGFydCh0cnVlKTtcbiAgICByZXR1cm47XG4gIH1cbiAgYXdhaXQgc3RhcnQoKTtcbn1cblxuZnVuY3Rpb24gaGFuZ1VwKCkge1xuICBpZiAoY2FsbElkKSBwdXNoKHsgdHlwZTogXCJzdG9wXCIsIG1lc3NhZ2U6IFwiWW91IGh1bmcgdXAuXCIgfSk7XG59XG5cbmZ1bmN0aW9uIGVuZCgpIHtcbiAgd2luZG93LmNsZWFySW50ZXJ2YWwodGlja2VyKTtcbiAgd2luZG93LmNsZWFySW50ZXJ2YWwodHJhY2VUaW1lcik7XG4gIHN0b3BXb3Jkcy5zdG9wKCk7XG4gIGFjdGl2ZVNlc3Npb24gPSAwO1xuICBzeW5jUmVzdWx0Rm9sbG93VXBCdXR0b25zKCk7XG4gIGVuZGluZyA9IHNhdmVUcmFjZSgpLnRoZW4oKCkgPT4geyBpZiAoY29yZSAmJiBjYWxsSWQpIGNvcmUuZGlzcG9zZShjYWxsSWQpOyBjYWxsSWQgPSAwOyBzaG93VGFza3MoKTsgc2hvd1N0YXR1cygpOyB9KTtcbiAgYXVkaW8uc3RvcCgpO1xuICBmb3IgKGNvbnN0IHdzIG9mIHNvY2tldHMudmFsdWVzKCkpIHdzLmNsb3NlKCk7XG4gIHNvY2tldHMuY2xlYXIoKTtcbiAgZm9yIChjb25zdCByIG9mIHJ1bnMudmFsdWVzKCkpIHIuYWJvcnQuYWJvcnQoKTtcbiAgcnVucy5jbGVhcigpO1xuICBmb3IgKGNvbnN0IHIgb2YgcmVxdWVzdHMudmFsdWVzKCkpIHIuYWJvcnQoKTtcbiAgcmVxdWVzdHMuY2xlYXIoKTtcbiAgdGhpbmtpbmcgPSBmYWxzZTtcbiAgc2V0Q2FsbEJ1dHRvbihmYWxzZSk7XG4gIGZvciAoY29uc3QgaWQgb2YgW1wibWljXCIsIFwiaHVzaFwiXSkgJDxIVE1MQnV0dG9uRWxlbWVudD4oaWQpLmRpc2FibGVkID0gdHJ1ZTtcbiAgJChcInJpbmdcIikuc3R5bGUub3BhY2l0eSA9IFwiMFwiO1xuICAkKFwicmluZ1wiKS5zdHlsZS50cmFuc2Zvcm0gPSBcIlwiO1xuICAkKFwiY2FsbGJhclwiKS5oaWRkZW4gPSB0cnVlO1xuICAkKFwibWljd2FyblwiKS5oaWRkZW4gPSB0cnVlO1xuICBkb2N1bWVudC5ib2R5LmRhdGFzZXQuc3RhdGUgPSBcImlkbGVcIjtcbiAgZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QucmVtb3ZlKFwiaW4tc2Vzc2lvblwiKTtcbiAgc3luY1Jlc3VtZUJ1dHRvbnMoY2hhdC5sZW5ndGggPiAwKTtcbiAgdm9pZCBzaG93RWFybGllcigpO1xuICB2b2lkIHdha2VMb2NrPy5yZWxlYXNlKCkuY2F0Y2goKCkgPT4ge30pO1xuICB3YWtlTG9jayA9IG51bGw7XG59XG5cbmZ1bmN0aW9uIHNldE11dGVkKHZhbHVlOiBib29sZWFuKSB7XG4gIGlmICghY2FsbElkIHx8IG11dGVkID09PSB2YWx1ZSkgcmV0dXJuO1xuICBtdXRlZCA9IHZhbHVlO1xuICAkKFwibWljXCIpLmNsYXNzTGlzdC50b2dnbGUoXCJtdXRlZFwiLCBtdXRlZCk7XG4gIHB1c2goeyB0eXBlOiBtdXRlZCA/IFwibXV0ZVwiIDogXCJ1bm11dGVcIiB9KTtcbiAgc2hvd1N0YXR1cygpO1xufVxuXG4vKiogU2VuZHMgd2hhdCB0aGUgdHJhY2Uga2VwdCBzaW5jZSBsYXN0IHRpbWUgdG8gdGhlIGRldiBzZXJ2ZXIsIGFzIEpTT04gbGluZXM6IGEgaGVhZGVyLCB0aGVuIGV2ZW50cy4gKi9cbmFzeW5jIGZ1bmN0aW9uIHNhdmVUcmFjZSgpIHtcbiAgaWYgKCFjb3JlIHx8ICFjYWxsSWQgfHwgIWNoZWNrZWQoXCJ0cmFjZVwiKSkgcmV0dXJuO1xuICBjb25zdCBrZXB0ID0gSlNPTi5wYXJzZShjb3JlLnRyYWNlKGNhbGxJZCkpO1xuICBpZiAoIWtlcHQpIHJldHVybjtcbiAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG4gIGlmIChrZXB0LmNvbmZpZykgbGluZXMucHVzaChKU09OLnN0cmluZ2lmeSh7IHZlcnNpb246IGtlcHQudmVyc2lvbiwgY29uZmlnOiBrZXB0LmNvbmZpZywgc3RhcnQ6IGtlcHQuc3RhcnQgfSkpO1xuICBmb3IgKGNvbnN0IGUgb2Yga2VwdC5ldmVudHMpIGxpbmVzLnB1c2goSlNPTi5zdHJpbmdpZnkoZSkpO1xuICBpZiAobGluZXMubGVuZ3RoID09PSAwKSByZXR1cm47XG4gIGF3YWl0IGZldGNoKGAvdHJhY2VzP25hbWU9JHtlbmNvZGVVUklDb21wb25lbnQoY2FsbE5hbWUpfS5qc29ubGAsIHsgbWV0aG9kOiBcIlBPU1RcIiwgYm9keTogbGluZXMuam9pbihcIlxcblwiKSArIFwiXFxuXCIgfSkuY2F0Y2goKCkgPT4ge30pO1xuICAkKFwidHJhY2VuYW1lXCIpLnRleHRDb250ZW50ID0gYHRyYWNlICR7Y2FsbE5hbWV9Lmpzb25sYDtcbn1cblxuLy8gXCJTdG9wXCIgYW5kIFwiZ29vZGJ5ZVwiIGhlYXJkIGJ5IHRoZSBicm93c2VyJ3Mgb3duIHJlY29nbml6ZXI6IHF1aWNrZXIgdGhhbiB0aGUgbW9kZWwncyB0cmFuc2NyaXB0LFxuLy8gYW5kIGl0IHdvcmtzIHdoaWxlIHRoZSBtb2RlbCdzIHJlcGx5IHBsYXlzIGV2ZW4gd2hlbiB0aGUgbW9kZWwgaXNuJ3QgaGVhcmluZyB0aGUgbWljcm9waG9uZS5cblxuY2xhc3MgU3RvcFdvcmRzIHtcbiAgcHJpdmF0ZSByZWM6IGFueSA9IG51bGw7XG4gIHByaXZhdGUgb24gPSBmYWxzZTtcbiAgcHJpdmF0ZSBjb21tYW5kcyA9IHsgc3RvcDogW10gYXMgc3RyaW5nW10sIGhhbmdVcDogW10gYXMgc3RyaW5nW10sIGNhbmNlbEFsbDogW10gYXMgc3RyaW5nW10gfTtcblxuICBnZXQgc3VwcG9ydGVkKCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiBcIndlYmtpdFNwZWVjaFJlY29nbml0aW9uXCIgaW4gd2luZG93IHx8IFwiU3BlZWNoUmVjb2duaXRpb25cIiBpbiB3aW5kb3c7XG4gIH1cblxuICBzdGFydCgpIHtcbiAgICBpZiAoIWNoZWNrZWQoXCJzdG9wd29yZFwiKSB8fCAhdGhpcy5zdXBwb3J0ZWQgfHwgIWNvcmUpIHJldHVybjtcbiAgICB0aGlzLmNvbW1hbmRzID0gSlNPTi5wYXJzZShjb3JlLmRlZmF1bHRzKCkpLnZvaWNlQ29tbWFuZHM7XG4gICAgY29uc3QgUmVjb2duaXRpb24gPSAod2luZG93IGFzIGFueSkuU3BlZWNoUmVjb2duaXRpb24gPz8gKHdpbmRvdyBhcyBhbnkpLndlYmtpdFNwZWVjaFJlY29nbml0aW9uO1xuICAgIHRoaXMucmVjID0gbmV3IFJlY29nbml0aW9uKCk7XG4gICAgdGhpcy5yZWMuY29udGludW91cyA9IHRydWU7XG4gICAgdGhpcy5yZWMuaW50ZXJpbVJlc3VsdHMgPSB0cnVlO1xuICAgIHRoaXMucmVjLmxhbmcgPSBuYXZpZ2F0b3IubGFuZ3VhZ2UgfHwgXCJlbi1HQlwiO1xuICAgIHRoaXMucmVjLm9ucmVzdWx0ID0gKGU6IGFueSkgPT4ge1xuICAgICAgZm9yIChsZXQgaSA9IGUucmVzdWx0SW5kZXg7IGkgPCBlLnJlc3VsdHMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgY29uc3QgdGV4dCA9IGUucmVzdWx0c1tpXVswXS50cmFuc2NyaXB0IGFzIHN0cmluZztcbiAgICAgICAgY29uc3QgY29tbWFuZCA9IGNvbW1hbmRJbih0ZXh0LCB0aGlzLmNvbW1hbmRzLCBbXCJXb29kaG91c2VcIiwgXCJIZXJtZXNcIiwgXCJCZW50b1wiXSk7XG4gICAgICAgIGlmIChjb21tYW5kID09PSBcInN0b3BcIiAmJiBhdWRpby5xdWV1ZWQgPiAwLjA1KSB7XG4gICAgICAgICAgbG9nKFwib3V0XCIsIGBsb2NhbCBzdG9wIHdvcmQ6ICR7dGV4dH1gLCBcIm91dFwiKTtcbiAgICAgICAgICB0b2FzdChgSGVhcmQgXHUyMDFDJHt0ZXh0LnRyaW0oKX1cdTIwMUQ6IHN0b3BwZWRgKTtcbiAgICAgICAgICBwdXNoKHsgdHlwZTogXCJpbnRlcnJ1cHRcIiB9KTtcbiAgICAgICAgfSBlbHNlIGlmIChjb21tYW5kID09PSBcImNhbmNlbEFsbFwiICYmIGUucmVzdWx0c1tpXS5pc0ZpbmFsKSB7XG4gICAgICAgICAgbG9nKFwib3V0XCIsIGBsb2NhbCBjYW5jZWwtYWxsOiAke3RleHR9YCwgXCJvdXRcIik7XG4gICAgICAgICAgcHVzaCh7IHR5cGU6IFwiY2FuY2VsQWxsXCIgfSk7XG4gICAgICAgICAgcHVzaCh7IHR5cGU6IFwiaW50ZXJydXB0XCIgfSk7XG4gICAgICAgIH0gZWxzZSBpZiAoY29tbWFuZCA9PT0gXCJoYW5nVXBcIiAmJiBlLnJlc3VsdHNbaV0uaXNGaW5hbCkge1xuICAgICAgICAgIGxvZyhcIm91dFwiLCBgbG9jYWwgaGFuZy11cDogJHt0ZXh0fWAsIFwib3V0XCIpO1xuICAgICAgICAgIGhhbmdVcCgpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfTtcbiAgICB0aGlzLnJlYy5vbmVuZCA9ICgpID0+IHsgaWYgKHRoaXMub24pIHNldFRpbWVvdXQoKCkgPT4geyB0cnkgeyB0aGlzLnJlYz8uc3RhcnQoKTsgfSBjYXRjaCB7fSB9LCAyNTApOyB9O1xuICAgIHRoaXMucmVjLm9uZXJyb3IgPSAoZTogYW55KSA9PiB7IGlmIChlLmVycm9yID09PSBcIm5vdC1hbGxvd2VkXCIpIHRoaXMub24gPSBmYWxzZTsgfTtcbiAgICB0aGlzLm9uID0gdHJ1ZTtcbiAgICB0cnkgeyB0aGlzLnJlYy5zdGFydCgpOyB9IGNhdGNoIHt9XG4gIH1cblxuICBzdG9wKCkge1xuICAgIHRoaXMub24gPSBmYWxzZTtcbiAgICB0cnkgeyB0aGlzLnJlYz8uc3RvcCgpOyB9IGNhdGNoIHt9XG4gICAgdGhpcy5yZWMgPSBudWxsO1xuICB9XG59XG5jb25zdCBzdG9wV29yZHMgPSBuZXcgU3RvcFdvcmRzKCk7XG5cbi8vIFdpcmluZy5cblxuZnVuY3Rpb24gc2V0dGluZ3NGcm9tU3RvcmFnZSgpIHtcbiAgZm9yIChjb25zdCBpZCBvZiBbXCJhZWNcIiwgXCJzdG9wd29yZFwiLCBcInB0dFwiLCBcImNhcHRpb25zXCIsIFwiY29kaW5nXCIsIFwiZmFrZWhlcm1lc1wiLCBcInRyYWNlXCJdKSB7XG4gICAgY29uc3QgdiA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKGB2b2ljZS4ke2lkfWApO1xuICAgIGlmICh2ICE9IG51bGwpICQ8SFRNTElucHV0RWxlbWVudD4oaWQpLmNoZWNrZWQgPSB2ID09PSBcIjFcIjtcbiAgICAkKGlkKS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IGxvY2FsU3RvcmFnZS5zZXRJdGVtKGB2b2ljZS4ke2lkfWAsIGNoZWNrZWQoaWQpID8gXCIxXCIgOiBcIjBcIikpO1xuICB9XG4gIGNvbnN0IGRlbGF5ID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS5mYWtlZGVsYXlcIik7XG4gIGlmIChkZWxheSkgJDxIVE1MSW5wdXRFbGVtZW50PihcImZha2VkZWxheVwiKS52YWx1ZSA9IGRlbGF5O1xuICAkKFwiZmFrZWRlbGF5XCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4gbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS5mYWtlZGVsYXlcIiwgJDxIVE1MSW5wdXRFbGVtZW50PihcImZha2VkZWxheVwiKS52YWx1ZSkpO1xuICBjb25zdCB2b2ljZSA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2Uudm9pY2VcIik7XG4gIGlmICh2b2ljZSkgJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJ2b2ljZVwiKS52YWx1ZSA9IHZvaWNlO1xuICAkKFwidm9pY2VcIikuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLnZvaWNlXCIsICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwidm9pY2VcIikudmFsdWUpKTtcbiAgY29uc3QgbW9kZSA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UubW9kZVwiKTtcbiAgaWYgKG1vZGUpICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwibW9kZVwiKS52YWx1ZSA9IG1vZGU7XG4gICQoXCJtb2RlXCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4ge1xuICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2UubW9kZVwiLCAkPEhUTUxTZWxlY3RFbGVtZW50PihcIm1vZGVcIikudmFsdWUpO1xuICAgIHN5bmNDb21wb3NlcigpO1xuICB9KTtcbiAgY29uc3QgdGhlbWUgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLnRoZW1lXCIpID8/IFwic3lzdGVtXCI7XG4gIGFwcGx5VGhlbWUodGhlbWUpO1xuICBmb3IgKGNvbnN0IGJ0biBvZiBBcnJheS5mcm9tKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiI3RoZW1lLXBpY2tlciBidXR0b25cIikpKSB7XG4gICAgYnRuLm9uY2xpY2sgPSAoKSA9PiB7XG4gICAgICBjb25zdCBjaG9pY2UgPSBidG4uZGF0YXNldC50aGVtZSA/PyBcInN5c3RlbVwiO1xuICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS50aGVtZVwiLCBjaG9pY2UpO1xuICAgICAgYXBwbHlUaGVtZShjaG9pY2UpO1xuICAgIH07XG4gIH1cbiAgY29uc3QgZGVuc2l0eSA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UuZGVuc2l0eVwiKTtcbiAgYXBwbHlEZW5zaXR5KGRlbnNpdHkpO1xuICBmb3IgKGNvbnN0IGJ0biBvZiBBcnJheS5mcm9tKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiI2RlbnNpdHktcGlja2VyIGJ1dHRvblwiKSkpIHtcbiAgICBidG4ub25jbGljayA9ICgpID0+IHtcbiAgICAgIGNvbnN0IGNob2ljZSA9IG5vcm1hbGl6ZURlbnNpdHkoYnRuLmRhdGFzZXQuZGVuc2l0eSk7XG4gICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLmRlbnNpdHlcIiwgY2hvaWNlKTtcbiAgICAgIGFwcGx5RGVuc2l0eShjaG9pY2UpO1xuICAgIH07XG4gIH1cbiAgbWF0Y2hNZWRpYShcIihwcmVmZXJzLWNvbG9yLXNjaGVtZTogZGFyaylcIikuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiB7XG4gICAgaWYgKChsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLnRoZW1lXCIpID8/IFwic3lzdGVtXCIpID09PSBcInN5c3RlbVwiKSBhcHBseVRoZW1lKFwic3lzdGVtXCIpO1xuICB9KTtcbn1cblxuY29uc3QgbW9iaWxlTGF5b3V0ID0gbWF0Y2hNZWRpYShcIihtYXgtd2lkdGg6IDkyMHB4KVwiKTtcbmxldCBkcmF3ZXJPcGVuZXI6IEhUTUxFbGVtZW50IHwgbnVsbCA9IG51bGw7XG5cbmZ1bmN0aW9uIHNldFRhc2tzT3BlbihvcGVuOiBib29sZWFuLCBvcGVuZXI/OiBIVE1MRWxlbWVudCB8IG51bGwpIHtcbiAgY29uc3QgY2FuT3BlbiA9IG1vYmlsZUxheW91dC5tYXRjaGVzICYmICEkKFwidGFsa1wiKS5oaWRkZW47XG4gIGNvbnN0IG5leHQgPSBvcGVuICYmIGNhbk9wZW47XG4gIGNvbnN0IHdhc09wZW4gPSBkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5jb250YWlucyhcInRhc2tzLW9wZW5cIik7XG4gIGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LnRvZ2dsZShcInRhc2tzLW9wZW5cIiwgbmV4dCk7XG4gIGNvbnN0IGhlYWRlciA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoXCJoZWFkZXJcIikgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAoaGVhZGVyKSBoZWFkZXIuaW5lcnQgPSBuZXh0O1xuICAkKFwiY29udm9cIikuaW5lcnQgPSBuZXh0O1xuICAkKFwic2lkZVwiKS5pbmVydCA9IG1vYmlsZUxheW91dC5tYXRjaGVzICYmICFuZXh0O1xuICAkKFwidGFza3MtdG9nZ2xlXCIpLnNldEF0dHJpYnV0ZShcImFyaWEtZXhwYW5kZWRcIiwgU3RyaW5nKG5leHQpKTtcbiAgJChcIm1vYmlsZS10YXNrcy1iYXJcIikuc2V0QXR0cmlidXRlKFwiYXJpYS1leHBhbmRlZFwiLCBTdHJpbmcobmV4dCkpO1xuICBpZiAobmV4dCAmJiAhd2FzT3Blbikge1xuICAgIGRyYXdlck9wZW5lciA9IG9wZW5lciA/PyAoZG9jdW1lbnQuYWN0aXZlRWxlbWVudCBhcyBIVE1MRWxlbWVudCB8IG51bGwpO1xuICAgIGNsZWFyVW5yZWFkSWZSZXN1bHRzVmlzaWJsZSgpO1xuICAgICQoXCJ0YXNrcy1jbG9zZVwiKS5mb2N1cygpO1xuICAgIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB1cGRhdGVBbGxSZXN1bHRDbGFtcGluZygpKTtcbiAgfSBlbHNlIGlmICghbmV4dCAmJiB3YXNPcGVuKSB7XG4gICAgY29uc3QgdGFyZ2V0ID0gZHJhd2VyT3BlbmVyO1xuICAgIGRyYXdlck9wZW5lciA9IG51bGw7XG4gICAgaWYgKHRhcmdldCAmJiB0YXJnZXQuaXNDb25uZWN0ZWQgJiYgIXRhcmdldC5oaWRkZW4gJiYgdGFyZ2V0Lm9mZnNldFBhcmVudCAhPT0gbnVsbCkge1xuICAgICAgdGFyZ2V0LmZvY3VzKCk7XG4gICAgfSBlbHNlIGlmICh0YXJnZXQgPT09ICQoXCJtb2JpbGUtdGFza3MtYmFyXCIpKSB7XG4gICAgICBjb25zdCBmYWxsYmFjayA9ICQoXCJ0YXNrcy10b2dnbGVcIik7XG4gICAgICBpZiAoIWZhbGxiYWNrLmhpZGRlbiAmJiBmYWxsYmFjay5vZmZzZXRQYXJlbnQgIT09IG51bGwpIGZhbGxiYWNrLmZvY3VzKCk7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIHRhYnMoKSB7XG4gIGNvbnN0IHZpZXdzOiBSZWNvcmQ8c3RyaW5nLCBIVE1MRWxlbWVudD4gPSB7IHRhbGs6ICQoXCJ0YWxrXCIpLCBkZXY6ICQoXCJkZXZcIiksIHJlcGxheTogJChcInJlcGxheW1haW5cIikgfTtcbiAgZm9yIChjb25zdCBuYW1lIG9mIE9iamVjdC5rZXlzKHZpZXdzKSkge1xuICAgICQoYHRhYi0ke25hbWV9YCkub25jbGljayA9ICgpID0+IHtcbiAgICAgIGZvciAoY29uc3QgW290aGVyLCBlbF0gb2YgT2JqZWN0LmVudHJpZXModmlld3MpKSB7XG4gICAgICAgIGVsLmhpZGRlbiA9IG90aGVyICE9PSBuYW1lO1xuICAgICAgICAkKGB0YWItJHtvdGhlcn1gKS5jbGFzc0xpc3QudG9nZ2xlKFwib25cIiwgb3RoZXIgPT09IG5hbWUpO1xuICAgICAgfVxuICAgICAgJChcInRhc2tzLXRvZ2dsZVwiKS5oaWRkZW4gPSBuYW1lICE9PSBcInRhbGtcIjtcbiAgICAgIHNldFRhc2tzT3BlbihmYWxzZSk7XG4gICAgICBpZiAobmFtZSA9PT0gXCJ0YWxrXCIpIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB1cGRhdGVBbGxSZXN1bHRDbGFtcGluZygpKTtcbiAgICB9O1xuICB9XG4gIGZvciAoY29uc3QgYnRuIG9mIEFycmF5LmZyb20oZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MQnV0dG9uRWxlbWVudD4oXCIjc2lkZS10YWJzIGJ1dHRvblwiKSkpIHtcbiAgICBidG4ub25jbGljayA9ICgpID0+IHNldFNpZGVGaWx0ZXIobm9ybWFsaXplU2lkZUZpbHRlcihidG4uZGF0YXNldC5maWx0ZXIpKTtcbiAgfVxuICAkKFwidG9nZ2xlLWFsbC1yZXN1bHRzXCIpLm9uY2xpY2sgPSAoKSA9PiB7XG4gICAgY29uc3QgY2xhbXBlZCA9IFsuLi5yZXN1bHRzLnZhbHVlcygpXS5maWx0ZXIoKHIpID0+IHIuY2FyZC5jbGFzc0xpc3QuY29udGFpbnMoXCJjbGFtcGVkXCIpKTtcbiAgICBjb25zdCBvcGVuQWxsID0gY2xhbXBlZC5zb21lKChyKSA9PiAhci5jYXJkLmNsYXNzTGlzdC5jb250YWlucyhcIm9wZW5cIikpO1xuICAgIGZvciAoY29uc3QgZW50cnkgb2YgY2xhbXBlZCkgc2V0UmVzdWx0T3BlbihlbnRyeSwgb3BlbkFsbCk7XG4gIH07XG4gICQoXCJnZWFyXCIpLm9uY2xpY2sgPSAoKSA9PiB7ICQoXCJzZXR0aW5nc1wiKS5oaWRkZW4gPSBmYWxzZTsgfTtcbiAgJChcImNsb3Nlc2V0dGluZ3NcIikub25jbGljayA9ICgpID0+IHsgJChcInNldHRpbmdzXCIpLmhpZGRlbiA9IHRydWU7IH07XG4gICQoXCJjbG9zZXNldHRpbmdzLXhcIikub25jbGljayA9ICgpID0+IHsgJChcInNldHRpbmdzXCIpLmhpZGRlbiA9IHRydWU7IH07XG4gICQoXCJzZXR0aW5nc1wiKS5vbmNsaWNrID0gKGUpID0+IHsgaWYgKGUudGFyZ2V0ID09PSAkKFwic2V0dGluZ3NcIikpICQoXCJzZXR0aW5nc1wiKS5oaWRkZW4gPSB0cnVlOyB9O1xuICBjb25zdCBvcGVuTW9iaWxlVGFza3NEcmF3ZXIgPSAob3BlbmVyOiBIVE1MRWxlbWVudCkgPT4ge1xuICAgIGNvbnN0IGFjdGl2ZVRvdGFsID0gWy4uLnRhc2tzLnZhbHVlcygpXS5maWx0ZXIoaXNBY3RpdmVUYXNrKS5sZW5ndGggKyBlYXJsaWVyQWN0aXZlQ291bnQ7XG4gICAgY29uc3QgbmV4dEZpbHRlciA9IHJlc29sdmVNb2JpbGVCYW5uZXJGaWx0ZXIoc2lkZUZpbHRlciwgYWN0aXZlVG90YWwsIHVucmVhZE1vYmlsZVJlc3VsdHMpO1xuICAgIGlmIChuZXh0RmlsdGVyICE9PSBzaWRlRmlsdGVyKSBzZXRTaWRlRmlsdGVyKG5leHRGaWx0ZXIpO1xuICAgIHNldFRhc2tzT3Blbih0cnVlLCBvcGVuZXIpO1xuICB9O1xuICAkKFwidGFza3MtdG9nZ2xlXCIpLm9uY2xpY2sgPSAoKSA9PiB7XG4gICAgaWYgKGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LmNvbnRhaW5zKFwidGFza3Mtb3BlblwiKSkgc2V0VGFza3NPcGVuKGZhbHNlKTtcbiAgICBlbHNlIG9wZW5Nb2JpbGVUYXNrc0RyYXdlcigkKFwidGFza3MtdG9nZ2xlXCIpKTtcbiAgfTtcbiAgJChcIm1vYmlsZS10YXNrcy1iYXJcIikub25jbGljayA9ICgpID0+IG9wZW5Nb2JpbGVUYXNrc0RyYXdlcigkKFwibW9iaWxlLXRhc2tzLWJhclwiKSk7XG4gICQoXCJ0YXNrcy1jbG9zZVwiKS5vbmNsaWNrID0gKCkgPT4gc2V0VGFza3NPcGVuKGZhbHNlKTtcbiAgJChcInNpZGUtYmFja2Ryb3BcIikub25jbGljayA9ICgpID0+IHNldFRhc2tzT3BlbihmYWxzZSk7XG4gIG1vYmlsZUxheW91dC5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHtcbiAgICBzZXRUYXNrc09wZW4oZmFsc2UpO1xuICAgIGNsZWFyVW5yZWFkSWZSZXN1bHRzVmlzaWJsZSgpO1xuICAgIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB1cGRhdGVBbGxSZXN1bHRDbGFtcGluZygpKTtcbiAgfSk7XG4gIHNldFRhc2tzT3BlbihmYWxzZSk7XG59XG5cbmZ1bmN0aW9uIHR5cGluZygpOiBib29sZWFuIHtcbiAgY29uc3QgZWwgPSBkb2N1bWVudC5hY3RpdmVFbGVtZW50IGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgcmV0dXJuICEhZWwgJiYgKGVsLnRhZ05hbWUgPT09IFwiSU5QVVRcIiB8fCBlbC50YWdOYW1lID09PSBcIlRFWFRBUkVBXCIgfHwgZWwudGFnTmFtZSA9PT0gXCJTRUxFQ1RcIiB8fCBlbC5pc0NvbnRlbnRFZGl0YWJsZSk7XG59XG5cbmZ1bmN0aW9uIGtleXMoKSB7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJrZXlkb3duXCIsIChlKSA9PiB7XG4gICAgaWYgKGUua2V5ID09PSBcIkVzY2FwZVwiKSB7XG4gICAgICBpZiAoISQoXCJzZXR0aW5nc1wiKS5oaWRkZW4pIHsgJChcInNldHRpbmdzXCIpLmhpZGRlbiA9IHRydWU7IHJldHVybjsgfVxuICAgICAgaWYgKGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LmNvbnRhaW5zKFwidGFza3Mtb3BlblwiKSAmJiBtb2JpbGVMYXlvdXQubWF0Y2hlcyAmJiAhJChcInRhbGtcIikuaGlkZGVuKSB7IHNldFRhc2tzT3BlbihmYWxzZSk7IHJldHVybjsgfVxuICAgICAgaWYgKGNhbGxJZCkgeyBwdXNoKHsgdHlwZTogXCJpbnRlcnJ1cHRcIiB9KTsgYXVkaW8uZmx1c2goKTsgcmV0dXJuOyB9XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICh0eXBpbmcoKSB8fCAhJChcInNldHRpbmdzXCIpLmhpZGRlbiB8fCBkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5jb250YWlucyhcInRhc2tzLW9wZW5cIikgfHwgZS5tZXRhS2V5IHx8IGUuY3RybEtleSB8fCBlLmFsdEtleSkgcmV0dXJuO1xuICAgIGlmIChlLmtleSA9PT0gXCJtXCIgfHwgZS5rZXkgPT09IFwiTVwiKSB7IHNldE11dGVkKCFtdXRlZCk7IGUucHJldmVudERlZmF1bHQoKTsgfVxuICAgIGVsc2UgaWYgKGUua2V5ID09PSBcIi9cIikgeyAkKFwidGV4dFwiKS5mb2N1cygpOyBlLnByZXZlbnREZWZhdWx0KCk7IH1cbiAgICBlbHNlIGlmIChlLmNvZGUgPT09IFwiU3BhY2VcIiAmJiBjYWxsSWQgJiYgbXV0ZWQgJiYgIWUucmVwZWF0KSB7IGhvbGRpbmcgPSB0cnVlOyBwdXNoKHsgdHlwZTogXCJ1bm11dGVcIiB9KTsgc2hvd1N0YXR1cygpOyBlLnByZXZlbnREZWZhdWx0KCk7IH1cbiAgfSk7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJrZXl1cFwiLCAoZSkgPT4ge1xuICAgIGlmIChlLmNvZGUgPT09IFwiU3BhY2VcIiAmJiBob2xkaW5nKSB7IGhvbGRpbmcgPSBmYWxzZTsgcHVzaCh7IHR5cGU6IFwibXV0ZVwiIH0pOyBzaG93U3RhdHVzKCk7IH1cbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHN1Ym1pdFRleHQoZTogRXZlbnQpIHtcbiAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICBjb25zdCBpbnB1dCA9ICQ8SFRNTElucHV0RWxlbWVudD4oXCJ0ZXh0XCIpO1xuICBsZXQgdGV4dCA9IGlucHV0LnZhbHVlLnRyaW0oKTtcbiAgaWYgKCF0ZXh0KSByZXR1cm47XG4gIC8vIFdpdGggbm8gY2FsbCBvbiwgdHlwaW5nIHN0YXJ0cyBhIGNoYXQ6IHRoZSBzYW1lIG1haW4gdGhyZWFkLCBpbiB0ZXh0LlxuICBpZiAoIWNhbGxJZCkge1xuICAgIGlucHV0LnZhbHVlID0gXCJcIjtcbiAgICBzeW5jQ29tcG9zZXIoKTtcbiAgICB0cnkgeyBhd2FpdCBzdGFydChmYWxzZSwgdHJ1ZSk7IH0gY2F0Y2ggKGVycikgeyB0b2FzdCgoZXJyIGFzIEVycm9yKS5tZXNzYWdlKTsgbG9nKFwiZXJyb3JcIiwgKGVyciBhcyBFcnJvcikubWVzc2FnZSwgXCJlcnJcIik7IH1cbiAgICBpZiAoIWNhbGxJZCkgeyBpbnB1dC52YWx1ZSA9IHRleHQ7IHN5bmNDb21wb3NlcigpOyByZXR1cm47IH1cbiAgfVxuICAvLyBcIi90MyBcdTIwMjZcIiBhbmQgXCIvaCBcdTIwMjZcIiBwaWNrIHRoZSBhZ2VudCB3aGF0ZXZlciB0aGUgc2VsZWN0b3Igc2F5cy5cbiAgY29uc3QgcGFyc2VkID0gcGFyc2VQcmVmaXgodGV4dCk7XG4gIGNvbnN0IG1vZGUgPSBwYXJzZWQubW9kZSA/PyAkPEhUTUxTZWxlY3RFbGVtZW50PihcIm1vZGVcIikudmFsdWU7XG4gIHRleHQgPSBwYXJzZWQucmVzdDtcbiAgaWYgKCF0ZXh0KSByZXR1cm47XG4gIGlmIChtb2RlID09PSBcInNheVwiKSB7XG4gICAgcHVzaCh7IHR5cGU6IFwic2F5XCIsIHRleHQgfSk7XG4gICAgc2Nyb2xsRG93bih0cnVlKTtcbiAgfSBlbHNlIHtcbiAgICBwdXNoKHsgdHlwZTogXCJhc2tcIiwgdGV4dCwgYWdlbnQ6IG1vZGUgfSk7XG4gICAgbm90ZShgWW91IFx1MjE5MiBuZXcgJHttb2RlID09PSBcInQzXCIgPyBcImNvZGluZ1wiIDogXCJIZXJtZXNcIn0gdGFzazogJHt0ZXh0fWApO1xuICAgIHNjcm9sbERvd24odHJ1ZSk7XG4gIH1cbiAgaW5wdXQudmFsdWUgPSBcIlwiO1xuICBzeW5jQ29tcG9zZXIoKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gbWFpbigpIHtcbiAgYXBwbHlUaGVtZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLnRoZW1lXCIpID8/IFwic3lzdGVtXCIpO1xuICBhcHBseURlbnNpdHkobG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS5kZW5zaXR5XCIpKTtcbiAgc2VydmVyID0gYXdhaXQgKGF3YWl0IGZldGNoKFwiL2NvbmZpZ1wiKSkuanNvbigpO1xuICAkKFwicm91dGVcIikudGV4dENvbnRlbnQgPSBgJHtzZXJ2ZXIucm91dGUgPT09IFwidmVydGV4XCIgPyBcIlZlcnRleFwiIDogXCJHZW1pbmkgQVBJXCJ9IFx1MDBCNyAke3NlcnZlci5tb2RlbC5zcGxpdChcIi9cIikucG9wKCl9YDtcbiAgJChcInZlcnNpb25cIikudGV4dENvbnRlbnQgPSBzZXJ2ZXIudmVyc2lvbjtcbiAgJChcImJ1aWxkXCIpLnRleHRDb250ZW50ID0gYGNvcmUgJHtzZXJ2ZXIudmVyc2lvbn1gO1xuICBzZXR0aW5nc0Zyb21TdG9yYWdlKCk7XG4gIGlmICghc2VydmVyLmhlcm1lcykgeyAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwiZmFrZWhlcm1lc1wiKS5jaGVja2VkID0gdHJ1ZTsgJDxIVE1MSW5wdXRFbGVtZW50PihcImZha2VoZXJtZXNcIikuZGlzYWJsZWQgPSB0cnVlOyB9XG4gIGlmICghc2VydmVyLnQzKSAkKFwiY29kaW5naGVscFwiKS50ZXh0Q29udGVudCA9IFwiVDMgaXNuJ3QgYXZhaWxhYmxlIG9uIHRoZSBzZXJ2ZXI6IG9ubHkgd2l0aCBmYWtlIGFuc3dlcnMuXCI7XG4gIGVsc2UgJChcImNvZGluZ2hlbHBcIikudGV4dENvbnRlbnQgPSBgQ29kZSBjaGFuZ2VzIGdvIHRvIGEgVDMgQ29kZSB0aHJlYWQgaW4gb25lIG9mOiAke3NlcnZlci50My5qb2luKFwiLCBcIil9LmA7XG4gIGlmICghc3RvcFdvcmRzLnN1cHBvcnRlZCkgeyAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwic3RvcHdvcmRcIikuY2hlY2tlZCA9IGZhbHNlOyAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwic3RvcHdvcmRcIikuZGlzYWJsZWQgPSB0cnVlOyB9XG4gIGNvbnN0IHByZXNldCA9ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwicHJlc2V0XCIpO1xuICBmb3IgKGNvbnN0IG5hbWUgb2YgT2JqZWN0LmtleXMoUFJFU0VUUykpIHByZXNldC5hZGQobmV3IE9wdGlvbihuYW1lLCBuYW1lKSk7XG4gIHByZXNldC52YWx1ZSA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UtY29yZS5wcmVzZXRcIikgPz8gXCJ3ZWJcIjtcbiAgaWYgKCFQUkVTRVRTW3ByZXNldC52YWx1ZV0pIHByZXNldC52YWx1ZSA9IFwid2ViXCI7XG4gICQ8SFRNTFRleHRBcmVhRWxlbWVudD4oXCJjb25maWdcIikudmFsdWUgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLWNvcmUuY29uZmlnXCIpID8/IEpTT04uc3RyaW5naWZ5KFBSRVNFVFNbcHJlc2V0LnZhbHVlXSwgbnVsbCwgMik7XG4gIHByZXNldC5vbmNoYW5nZSA9ICgpID0+IHtcbiAgICAkPEhUTUxUZXh0QXJlYUVsZW1lbnQ+KFwiY29uZmlnXCIpLnZhbHVlID0gSlNPTi5zdHJpbmdpZnkoUFJFU0VUU1twcmVzZXQudmFsdWVdLCBudWxsLCAyKTtcbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLWNvcmUucHJlc2V0XCIsIHByZXNldC52YWx1ZSk7XG4gICAgbG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oXCJ2b2ljZS1jb3JlLmNvbmZpZ1wiKTtcbiAgfTtcbiAgJChcImNvbmZpZ1wiKS5vbmlucHV0ID0gKCkgPT4gbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS1jb3JlLmNvbmZpZ1wiLCAkPEhUTUxUZXh0QXJlYUVsZW1lbnQ+KFwiY29uZmlnXCIpLnZhbHVlKTtcbiAgJChcImRlZmF1bHRzXCIpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYyA9IGNvcmUgPz8gKGF3YWl0IGxvYWRDb3JlKCkpO1xuICAgICQoXCJkZWZhdWx0c3ZpZXdcIikudGV4dENvbnRlbnQgPSBKU09OLnN0cmluZ2lmeShKU09OLnBhcnNlKGMuZGVmYXVsdHMoKSksIG51bGwsIDIpO1xuICAgICQoXCJkZWZhdWx0c3ZpZXdcIikuaGlkZGVuID0gISQoXCJkZWZhdWx0c3ZpZXdcIikuaGlkZGVuO1xuICB9O1xuICBjb25zdCBvbkNhbGxDbGljayA9ICgpID0+IHZvaWQgY2FsbEJ1dHRvbigpLmNhdGNoKChlcnIpID0+IHsgdG9hc3QoZXJyLm1lc3NhZ2UpOyBsb2coXCJlcnJvclwiLCBlcnIubWVzc2FnZSwgXCJlcnJcIik7IH0pO1xuICBjb25zdCBvbkhlcm9DYWxsQ2xpY2sgPSAoKSA9PiB7IGlmICghY2FsbElkKSB2b2lkIHN0YXJ0KCkuY2F0Y2goKGVycikgPT4geyB0b2FzdChlcnIubWVzc2FnZSk7IGxvZyhcImVycm9yXCIsIGVyci5tZXNzYWdlLCBcImVyclwiKTsgfSk7IH07XG4gIGNvbnN0IG9uUmVzdW1lQ2xpY2sgPSAoKSA9PiB2b2lkIHN0YXJ0KHRydWUpLmNhdGNoKChlcnIpID0+IHsgdG9hc3QoZXJyLm1lc3NhZ2UpOyBsb2coXCJlcnJvclwiLCBlcnIubWVzc2FnZSwgXCJlcnJcIik7IH0pO1xuICAkKFwiY2FsbFwiKS5vbmNsaWNrID0gb25DYWxsQ2xpY2s7XG4gICQoXCJoZXJvLWNhbGxcIikub25jbGljayA9IG9uSGVyb0NhbGxDbGljaztcbiAgJChcInJlc3VtZVwiKS5vbmNsaWNrID0gb25SZXN1bWVDbGljaztcbiAgJChcImhlcm8tcmVzdW1lXCIpLm9uY2xpY2sgPSBvblJlc3VtZUNsaWNrO1xuICBpZiAoc2F2ZWRIaXN0b3J5KCkubGVuZ3RoID4gMCkge1xuICAgIHN5bmNSZXN1bWVCdXR0b25zKHRydWUpO1xuICAgICQoXCJyZXN1bWVcIikudGl0bGUgPSBcIkNhbGwgYWdhaW4sIGNhcnJ5aW5nIG9uIGZyb20gdGhlIGxhc3QgY29udmVyc2F0aW9uXCI7XG4gIH1cbiAgJChcIm1pY1wiKS5vbmNsaWNrID0gKCkgPT4gc2V0TXV0ZWQoIW11dGVkKTtcbiAgJChcImh1c2hcIikub25jbGljayA9ICgpID0+IHsgcHVzaCh7IHR5cGU6IFwiaW50ZXJydXB0XCIgfSk7IGF1ZGlvLmZsdXNoKCk7IH07XG4gICQoXCJjYW5jZWxhbGxcIikub25jbGljayA9ICgpID0+IHB1c2goeyB0eXBlOiBcImNhbmNlbEFsbFwiIH0pO1xuICAkKFwiZG9uZWJveFwiKS5hZGRFdmVudExpc3RlbmVyKFwidG9nZ2xlXCIsICgpID0+IHsgaWYgKCQ8SFRNTERldGFpbHNFbGVtZW50PihcImRvbmVib3hcIikub3BlbikgJChcImRvbmVib3hcIikuc2Nyb2xsSW50b1ZpZXcoeyBibG9jazogXCJuZWFyZXN0XCIgfSk7IH0pO1xuICAkKFwic2F5XCIpLm9uc3VibWl0ID0gKGUpID0+IHZvaWQgc3VibWl0VGV4dChlKTtcbiAgJChcInRleHRcIikuYWRkRXZlbnRMaXN0ZW5lcihcImlucHV0XCIsIHN5bmNDb21wb3Nlcik7XG4gIGNvbnN0IHRyYW5zY3JpcHRQYW5lID0gJChcInRyYW5zY3JpcHRcIik7XG4gIHRyYW5zY3JpcHRQYW5lLmFkZEV2ZW50TGlzdGVuZXIoXCJzY3JvbGxcIiwgKCkgPT4gdHJhbnNjcmlwdFNjcm9sbC5vblNjcm9sbCgpLCB7IHBhc3NpdmU6IHRydWUgfSk7XG4gIHRyYW5zY3JpcHRQYW5lLmFkZEV2ZW50TGlzdGVuZXIoXCJzY3JvbGxlbmRcIiwgKCkgPT4gdHJhbnNjcmlwdFNjcm9sbC5vblNjcm9sbEVuZCgpLCB7IHBhc3NpdmU6IHRydWUgfSk7XG4gIHRyYW5zY3JpcHRQYW5lLmFkZEV2ZW50TGlzdGVuZXIoXCJ3aGVlbFwiLCAoZSkgPT4geyBpZiAoZS5kZWx0YVkgPCAwKSB0cmFuc2NyaXB0U2Nyb2xsLmNhbmNlbEp1bXAoKTsgfSwgeyBwYXNzaXZlOiB0cnVlIH0pO1xuICB0cmFuc2NyaXB0UGFuZS5hZGRFdmVudExpc3RlbmVyKFwidG91Y2hzdGFydFwiLCAoKSA9PiB0cmFuc2NyaXB0U2Nyb2xsLmNhbmNlbEp1bXAoKSwgeyBwYXNzaXZlOiB0cnVlIH0pO1xuICBpZiAodHlwZW9mIFJlc2l6ZU9ic2VydmVyICE9PSBcInVuZGVmaW5lZFwiKSB7XG4gICAgbmV3IFJlc2l6ZU9ic2VydmVyKCgpID0+IHRyYW5zY3JpcHRTY3JvbGwub25SZXNpemUoKSkub2JzZXJ2ZSh0cmFuc2NyaXB0UGFuZSk7XG4gICAgbmV3IFJlc2l6ZU9ic2VydmVyKCgpID0+IHVwZGF0ZUFsbFJlc3VsdENsYW1waW5nKCkpLm9ic2VydmUoJChcInJlc3VsdHNcIikpO1xuICB9XG4gICQoXCJqdW1wYm90dG9tXCIpLm9uY2xpY2sgPSAoKSA9PiB0cmFuc2NyaXB0U2Nyb2xsLmp1bXBUb0JvdHRvbSgpO1xuICBzeW5jQ29tcG9zZXIoKTtcbiAgc3luY1NpZGVMYXlvdXQoKTtcbiAgdGFicygpO1xuICBrZXlzKCk7XG4gIGNvbnN0IGV2ZW50cyA9IG5ldyBFdmVudFNvdXJjZShcIi9ldmVudHNcIik7XG4gIGV2ZW50cy5hZGRFdmVudExpc3RlbmVyKFwiY29yZVwiLCAoZSkgPT4ge1xuICAgIGNvbnN0IHsgdmVyc2lvbiB9ID0gSlNPTi5wYXJzZSgoZSBhcyBNZXNzYWdlRXZlbnQpLmRhdGEpO1xuICAgICQoXCJ2ZXJzaW9uXCIpLnRleHRDb250ZW50ID0gdmVyc2lvbiArIChjYWxsSWQgJiYgY29yZSAmJiBjb3JlLnZlcnNpb24gIT09IHZlcnNpb24gPyBgIChuZXh0IGNhbGw7IHRoaXMgb25lIHJ1bnMgJHtjb3JlLnZlcnNpb259KWAgOiBcIlwiKTtcbiAgICAkKFwiYnVpbGRcIikudGV4dENvbnRlbnQgPSBgY29yZSAke3ZlcnNpb259YDtcbiAgfSk7XG4gIGV2ZW50cy5hZGRFdmVudExpc3RlbmVyKFwiYXBwXCIsICgpID0+IHsgaWYgKCFjYWxsSWQpIGxvY2F0aW9uLnJlbG9hZCgpOyBlbHNlIHRvYXN0KFwiVGhlIHBhZ2UgY2hhbmdlZDogcmVsb2FkIGFmdGVyIHRoaXMgY2FsbFwiKTsgfSk7XG4gIGV2ZW50cy5hZGRFdmVudExpc3RlbmVyKFwiZXJyb3JcIiwgKGUpID0+IHtcbiAgICBjb25zdCBkYXRhID0gKGUgYXMgTWVzc2FnZUV2ZW50KS5kYXRhO1xuICAgIGlmIChkYXRhKSB0b2FzdChgQnVpbGQgZmFpbGVkOiAke0pTT04ucGFyc2UoZGF0YSkubWVzc2FnZX1gKTtcbiAgfSk7XG4gIG5ldyBSZXBsYXkoJChcInJlcGxheVwiKSwgbG9hZENvcmUpO1xuICB2b2lkIHBpbmcoKTtcbiAgdm9pZCBzaG93RWFybGllcigpO1xuICB3aW5kb3cuc2V0SW50ZXJ2YWwoKCkgPT4gdm9pZCBzaG93RWFybGllcigpLCAzMF8wMDApO1xufVxuXG52b2lkIG1haW4oKTtcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFTQSxJQUFNLFNBQVMsb0JBQUksSUFBSTtBQUFBLEVBQ3JCO0FBQUEsRUFBTztBQUFBLEVBQU07QUFBQSxFQUFRO0FBQUEsRUFBVTtBQUFBLEVBQU87QUFBQSxFQUFRO0FBQUEsRUFBTTtBQUFBLEVBQU07QUFBQSxFQUFNO0FBQUEsRUFBTTtBQUFBLEVBQVc7QUFBQSxFQUFTO0FBQUEsRUFBUTtBQUFBLEVBQU87QUFBQSxFQUFVO0FBQUEsRUFBUztBQUFBLEVBQzVIO0FBQ0YsQ0FBQztBQUdNLFNBQVMsTUFBTSxNQUF3QjtBQUM1QyxTQUFPLEtBQUssWUFBWSxF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
