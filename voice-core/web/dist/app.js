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
    if (this.distance() > this.pinThreshold) this.pinned = false;
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
      view.result.scrollIntoView({ behavior: "smooth", block: "center" });
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL2NvbW1hbmRzLnRzIiwgIi4uL2F1ZGlvLnRzIiwgIi4uL3JlcGxheS50cyIsICIuLi9zY3JvbGwudHMiLCAiLi4vYXBwLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBTcG9rZW4gY29tbWFuZHMgdGhlIGNvcmUgYWN0cyBvbiB3aXRob3V0IHRoZSBtb2RlbDogXCJzdG9wXCIgYW5kIFwiaGFuZyB1cFwiLiBBbiB1dHRlcmFuY2UgY291bnRzXG4vLyBvbmx5IHdoZW4gaXQgaXMgb25lIG9mIHRoZSBwaHJhc2VzIGFuZCBub3RoaW5nIG1vcmUsIG9uY2UgbmFtZXMgYW5kIGZpbGxlcnMgYXJvdW5kIGl0IGFyZSBnb25lLFxuLy8gc28gXCJXb29kaG91c2UsIHN0b3AgcGxlYXNlXCIgc3RvcHMgYW5kIFwic3RvcCB0aGUgUGVubnl3b3J0aCB0YXNrXCIgZ29lcyB0byB0aGUgbW9kZWwgYXMgdXN1YWwuXG5cbmltcG9ydCB0eXBlIHsgVm9pY2VDb21tYW5kcyB9IGZyb20gXCIuL3R5cGVzLnRzXCI7XG5cbmV4cG9ydCB0eXBlIFZvaWNlQ29tbWFuZCA9IFwic3RvcFwiIHwgXCJoYW5nVXBcIiB8IFwiY2FuY2VsQWxsXCI7XG5cbi8qKiBXb3JkcyB0aGF0IG1heSBjb21lIGJlZm9yZSBvciBhZnRlciBhIGNvbW1hbmQgd2l0aG91dCBjaGFuZ2luZyBpdC4gKi9cbmNvbnN0IEZJTExFUiA9IG5ldyBTZXQoW1xuICBcImhleVwiLCBcIm9rXCIsIFwib2theVwiLCBcInBsZWFzZVwiLCBcIm5vd1wiLCBcImp1c3RcIiwgXCJzb1wiLCBcInVtXCIsIFwidWhcIiwgXCJvaFwiLCBcImFscmlnaHRcIiwgXCJyaWdodFwiLCBcInllYWhcIiwgXCJ5ZXNcIiwgXCJ0aGFua3NcIiwgXCJ0aGFua1wiLCBcInlvdVwiLFxuICBcImdlbWluaVwiLFxuXSk7XG5cbi8qKiBbdGV4dF0gYXMgbG93ZXItY2FzZSB3b3JkcywgYXBvc3Ryb3BoZXMgZHJvcHBlZCAoXCJUaGF0J3NcIiBpcyBcInRoYXRzXCIpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdvcmRzKHRleHQ6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIHRleHQudG9Mb3dlckNhc2UoKS5yZXBsYWNlKC9bJ1x1MjAxOWBdL2csIFwiXCIpLnJlcGxhY2UoL1teXFxwe0x9XFxwe05kfV0rL2d1LCBcIiBcIikudHJpbSgpLnNwbGl0KFwiIFwiKS5maWx0ZXIoKHcpID0+IHcubGVuZ3RoID4gMCk7XG59XG5cbi8qKiBUaGUgY29tbWFuZCBbdXR0ZXJhbmNlXSBpcywgaWYgaXQncyBvbmUgYW5kIG5vdGhpbmcgbW9yZTsgW25hbWVzXSAodGhlIGFzc2lzdGFudCdzLCBcIldvb2Rob3VzZVwiKSBkb24ndCBjb3VudC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb21tYW5kSW4odXR0ZXJhbmNlOiBzdHJpbmcsIGNvbW1hbmRzOiBWb2ljZUNvbW1hbmRzLCBuYW1lczogc3RyaW5nW10gPSBbXSk6IFZvaWNlQ29tbWFuZCB8IG51bGwge1xuICBjb25zdCBpZ25vcmVkID0gbmV3IFNldChbLi4uRklMTEVSLCAuLi5uYW1lcy5mbGF0TWFwKHdvcmRzKV0pO1xuICBjb25zdCBzYWlkID0gd29yZHModXR0ZXJhbmNlKTtcbiAgbGV0IGZyb20gPSAwO1xuICBsZXQgdG8gPSBzYWlkLmxlbmd0aDtcbiAgd2hpbGUgKGZyb20gPCB0byAmJiBpZ25vcmVkLmhhcyhzYWlkW2Zyb21dKSkgZnJvbSsrO1xuICB3aGlsZSAodG8gPiBmcm9tICYmIGlnbm9yZWQuaGFzKHNhaWRbdG8gLSAxXSkpIHRvLS07XG4gIGlmIChmcm9tID09PSB0byB8fCB0byAtIGZyb20gPiA1KSByZXR1cm4gbnVsbDtcbiAgY29uc3QgY29yZSA9IHNhaWQuc2xpY2UoZnJvbSwgdG8pLmpvaW4oXCIgXCIpO1xuICBjb25zdCBpcyA9IChwaHJhc2VzOiBzdHJpbmdbXSkgPT4gcGhyYXNlcy5zb21lKChwKSA9PiB3b3JkcyhwKS5qb2luKFwiIFwiKSA9PT0gY29yZSk7XG4gIGlmIChpcyhjb21tYW5kcy5oYW5nVXApKSByZXR1cm4gXCJoYW5nVXBcIjtcbiAgaWYgKGlzKGNvbW1hbmRzLmNhbmNlbEFsbCA/PyBbXSkpIHJldHVybiBcImNhbmNlbEFsbFwiO1xuICBpZiAoaXMoY29tbWFuZHMuc3RvcCkpIHJldHVybiBcInN0b3BcIjtcbiAgcmV0dXJuIG51bGw7XG59XG5cbi8qKiBXb3JkcyB0aGF0IHRha2UgYSByZXF1ZXN0IGJhY2suICovXG5jb25zdCBDQU5DRUxTID0gL1xcYig/OmNhbmNlbFxcdyp8YWJvcnRcXHcqfGtpbGx8c2NyYXB8c2NyYXRjaHxkcm9wfGZvcmdldHx1bmRvfHRlcm1pbmF0ZXxuZXZlciA/bWluZHxjYWxsICg/Oml0fHRoYXR8dGhpcykgb2ZmfCg/OmRvbnR8ZG8gbm90KSAoPzpib3RoZXJ8bmVlZHx3YW50fGRvKXxubyBuZWVkfG5vIGxvbmdlcnxub3QgYW55bW9yZXxsZWF2ZSBpdHxza2lwICg/Oml0fHRoYXQpKVxcYi87XG5jb25zdCBTVE9QUyA9IC9cXGIoPzpzdG9wXFx3KnxoYWx0fHF1aXR8ZW5kKVxcYi87XG5cbi8qKlxuICogV2hldGhlciBbdXR0ZXJhbmNlXSBhc2tzIGZvciBhIHRhc2sgdG8gYmUgY2FuY2VsbGVkLCBmb3IgYSBjYW5jZWxfdGFzayB0aGUgbW9kZWwgY2FsbGVkIG9uIGl0LiBcIlN0b3BcIiBhbG9uZSBhbmQgdGhlXG4gKiBvdGhlciBzdG9wIGFuZCBoYW5nLXVwIHBocmFzZXMgZG9uJ3Q6IHRoZXkgbWVhbiBzdG9wIHRhbGtpbmcuIE90aGVyd2lzZSBpdCBkb2VzIHdoZW4gaXQgc2F5cyBzbyBpbiB3b3Jkcywgd2hlbiBpdFxuICogbmFtZXMgdGhlIHRhc2sgKFtuYW1lZF0pLCBvciB3aGVuIGl0IHNheXMgdG8gc3RvcCBzb21ldGhpbmcgbW9yZSB0aGFuIHRoZSB0YWxraW5nIChcInN0b3Agd29ya2luZyBvbiB0aGF0XCIpLlxuICogV29yZHMgdGhhdCBzYXkgbm9uZSBvZiB0aGlzIChhIG1pc2hlYXJpbmcgc3VjaCBhcyBcIlN0YWJpdFwiKSBkb24ndC4gV2l0aCBub3RoaW5nIGhlYXJkIHRoZXJlIGlzIG5vdGhpbmcgdG8ganVkZ2UgYnkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhc2tzVG9DYW5jZWwodXR0ZXJhbmNlOiBzdHJpbmcsIGNvbW1hbmRzOiBWb2ljZUNvbW1hbmRzLCBuYW1lczogc3RyaW5nW10sIG5hbWVkOiBib29sZWFuKTogYm9vbGVhbiB7XG4gIGNvbnN0IHNhaWQgPSB3b3Jkcyh1dHRlcmFuY2UpLmpvaW4oXCIgXCIpO1xuICBpZiAoc2FpZC5sZW5ndGggPT09IDApIHJldHVybiB0cnVlO1xuICBjb25zdCBjb21tYW5kID0gY29tbWFuZEluKHV0dGVyYW5jZSwgY29tbWFuZHMsIG5hbWVzKTtcbiAgaWYgKGNvbW1hbmQgPT09IFwic3RvcFwiIHx8IGNvbW1hbmQgPT09IFwiaGFuZ1VwXCIpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIGNvbW1hbmQgPT09IFwiY2FuY2VsQWxsXCIgfHwgbmFtZWQgfHwgQ0FOQ0VMUy50ZXN0KHNhaWQpIHx8IFNUT1BTLnRlc3Qoc2FpZCk7XG59XG4iLCAiLy8gVGhlIGJyb3dzZXIncyBtaWNyb3Bob25lIGFuZCBzcGVha2VyIGZvciBhIGNhbGw6IDE2IGtIeiBQQ00xNiBmcmFtZXMgb3V0IG9mIHRoZSBtaWNyb3Bob25lLFxuLy8gMjQga0h6IFBDTTE2IGludG8gdGhlIHNwZWFrZXIsIGFuZCB0b25lcyBsYWlkIG92ZXIgd2hhdGV2ZXIgcGxheXMuIEJvdGggcnVuIGluIEF1ZGlvV29ya2xldHMgb25cbi8vIG9uZSBBdWRpb0NvbnRleHQgYXQgdGhlIGRldmljZSdzIHJhdGUsIHJlc2FtcGxpbmcgdGhlcmUuXG5cbmNvbnN0IFdPUktMRVRTID0gYFxuY2xhc3MgQ2FwdHVyZSBleHRlbmRzIEF1ZGlvV29ya2xldFByb2Nlc3NvciB7XG4gIGNvbnN0cnVjdG9yKCkge1xuICAgIHN1cGVyKCk7XG4gICAgdGhpcy5zdGVwID0gc2FtcGxlUmF0ZSAvIDE2MDAwO1xuICAgIHRoaXMucG9zID0gMDtcbiAgICB0aGlzLmZyYW1lID0gbmV3IEludDE2QXJyYXkoMzIwKTtcbiAgICB0aGlzLm4gPSAwO1xuICAgIC8vIEEgd2luZG93ZWQtc2luYyBsb3ctcGFzcyBhdCA3IGtIeiwgc28gbm90aGluZyBhYm92ZSAxNiBrSHoncyA4IGtIeiBsaW1pdCBmb2xkcyBiYWNrIGludG8gc3BlZWNoLlxuICAgIGNvbnN0IHRhcHMgPSA0NywgY3V0ID0gNzAwMCAvIHNhbXBsZVJhdGU7XG4gICAgdGhpcy50YXBzID0gbmV3IEZsb2F0MzJBcnJheSh0YXBzKTtcbiAgICBsZXQgc3VtID0gMDtcbiAgICBmb3IgKGxldCBrID0gMDsgayA8IHRhcHM7IGsrKykge1xuICAgICAgY29uc3QgbSA9IGsgLSAodGFwcyAtIDEpIC8gMjtcbiAgICAgIGNvbnN0IHNpbmMgPSBtID09PSAwID8gMiAqIGN1dCA6IE1hdGguc2luKDIgKiBNYXRoLlBJICogY3V0ICogbSkgLyAoTWF0aC5QSSAqIG0pO1xuICAgICAgY29uc3QgdyA9IDAuNDIgLSAwLjUgKiBNYXRoLmNvcygoMiAqIE1hdGguUEkgKiBrKSAvICh0YXBzIC0gMSkpICsgMC4wOCAqIE1hdGguY29zKCg0ICogTWF0aC5QSSAqIGspIC8gKHRhcHMgLSAxKSk7XG4gICAgICB0aGlzLnRhcHNba10gPSBzaW5jICogdztcbiAgICAgIHN1bSArPSB0aGlzLnRhcHNba107XG4gICAgfVxuICAgIGZvciAobGV0IGsgPSAwOyBrIDwgdGFwczsgaysrKSB0aGlzLnRhcHNba10gLz0gc3VtO1xuICAgIHRoaXMuaGlzdG9yeSA9IG5ldyBGbG9hdDMyQXJyYXkodGFwcyk7XG4gICAgdGhpcy5hdCA9IDA7XG4gIH1cbiAgcHJvY2VzcyhpbnB1dHMpIHtcbiAgICBjb25zdCBpbnB1dCA9IGlucHV0c1swXSAmJiBpbnB1dHNbMF1bMF07XG4gICAgaWYgKCFpbnB1dCkgcmV0dXJuIHRydWU7XG4gICAgY29uc3QgdGFwcyA9IHRoaXMudGFwcywgaCA9IHRoaXMuaGlzdG9yeSwgbiA9IHRhcHMubGVuZ3RoO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgaW5wdXQubGVuZ3RoOyBpKyspIHtcbiAgICAgIGhbdGhpcy5hdF0gPSBpbnB1dFtpXTtcbiAgICAgIHRoaXMuYXQgPSAodGhpcy5hdCArIDEpICUgbjtcbiAgICAgIC8vIE9ubHkgdGhlIHNhbXBsZXMga2VwdCBuZWVkIGZpbHRlcmluZzogYXQgbW9zdCBvbmUgaW4gZXZlcnkgc3RlcC5cbiAgICAgIGlmICh0aGlzLnBvcyA+IDEpIHsgdGhpcy5wb3MgLT0gMTsgY29udGludWU7IH1cbiAgICAgIGxldCB4ID0gMDtcbiAgICAgIGZvciAobGV0IGsgPSAwLCBqID0gdGhpcy5hdDsgayA8IG47IGsrKywgaiA9IGogKyAxID09PSBuID8gMCA6IGogKyAxKSB4ICs9IHRhcHNba10gKiBoW2pdO1xuICAgICAgd2hpbGUgKHRoaXMucG9zIDw9IDEpIHtcbiAgICAgICAgY29uc3QgcyA9IE1hdGgubWF4KC0xLCBNYXRoLm1pbigxLCB4KSk7XG4gICAgICAgIHRoaXMuZnJhbWVbdGhpcy5uKytdID0gcyA8IDAgPyBzICogMzI3NjggOiBzICogMzI3Njc7XG4gICAgICAgIGlmICh0aGlzLm4gPT09IHRoaXMuZnJhbWUubGVuZ3RoKSB7XG4gICAgICAgICAgdGhpcy5wb3J0LnBvc3RNZXNzYWdlKHRoaXMuZnJhbWUuYnVmZmVyLCBbdGhpcy5mcmFtZS5idWZmZXJdKTtcbiAgICAgICAgICB0aGlzLmZyYW1lID0gbmV3IEludDE2QXJyYXkoMzIwKTtcbiAgICAgICAgICB0aGlzLm4gPSAwO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMucG9zICs9IHRoaXMuc3RlcDtcbiAgICAgIH1cbiAgICAgIHRoaXMucG9zIC09IDE7XG4gICAgfVxuICAgIHJldHVybiB0cnVlO1xuICB9XG59XG5cbmNsYXNzIFBsYXliYWNrIGV4dGVuZHMgQXVkaW9Xb3JrbGV0UHJvY2Vzc29yIHtcbiAgY29uc3RydWN0b3IoKSB7XG4gICAgc3VwZXIoKTtcbiAgICB0aGlzLnF1ZXVlID0gW107ICAgICAgLy8gRmxvYXQzMkFycmF5cyBhdCB0aGUgY29udGV4dCdzIHJhdGVcbiAgICB0aGlzLm9mZnNldCA9IDA7XG4gICAgdGhpcy5jdWVzID0gW107XG4gICAgdGhpcy5jdWVPZmZzZXQgPSAwO1xuICAgIHRoaXMucmVwb3J0ZWQgPSAwO1xuICAgIHRoaXMucG9ydC5vbm1lc3NhZ2UgPSAoZSkgPT4ge1xuICAgICAgY29uc3QgbSA9IGUuZGF0YTtcbiAgICAgIGlmIChtLnR5cGUgPT09IFwicGxheVwiKSB0aGlzLnF1ZXVlLnB1c2gobS5zYW1wbGVzKTtcbiAgICAgIGVsc2UgaWYgKG0udHlwZSA9PT0gXCJjdWVcIikgdGhpcy5jdWVzLnB1c2gobS5zYW1wbGVzKTtcbiAgICAgIGVsc2UgaWYgKG0udHlwZSA9PT0gXCJmbHVzaFwiKSB7IHRoaXMucXVldWUgPSBbXTsgdGhpcy5vZmZzZXQgPSAwOyB9XG4gICAgICBlbHNlIGlmIChtLnR5cGUgPT09IFwic3RvcFwiKSB7IHRoaXMucXVldWUgPSBbXTsgdGhpcy5vZmZzZXQgPSAwOyB0aGlzLmN1ZXMgPSBbXTsgdGhpcy5jdWVPZmZzZXQgPSAwOyB9XG4gICAgfTtcbiAgfVxuICBwcm9jZXNzKF8sIG91dHB1dHMpIHtcbiAgICBjb25zdCBvdXQgPSBvdXRwdXRzWzBdWzBdO1xuICAgIG91dC5maWxsKDApO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgb3V0Lmxlbmd0aCAmJiB0aGlzLnF1ZXVlLmxlbmd0aDsgaSsrKSB7XG4gICAgICBvdXRbaV0gPSB0aGlzLnF1ZXVlWzBdW3RoaXMub2Zmc2V0KytdO1xuICAgICAgaWYgKHRoaXMub2Zmc2V0ID49IHRoaXMucXVldWVbMF0ubGVuZ3RoKSB7IHRoaXMucXVldWUuc2hpZnQoKTsgdGhpcy5vZmZzZXQgPSAwOyB9XG4gICAgfVxuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgb3V0Lmxlbmd0aCAmJiB0aGlzLmN1ZXMubGVuZ3RoOyBpKyspIHtcbiAgICAgIG91dFtpXSA9IE1hdGgubWF4KC0xLCBNYXRoLm1pbigxLCBvdXRbaV0gKyB0aGlzLmN1ZXNbMF1bdGhpcy5jdWVPZmZzZXQrK10pKTtcbiAgICAgIGlmICh0aGlzLmN1ZU9mZnNldCA+PSB0aGlzLmN1ZXNbMF0ubGVuZ3RoKSB7IHRoaXMuY3Vlcy5zaGlmdCgpOyB0aGlzLmN1ZU9mZnNldCA9IDA7IH1cbiAgICB9XG4gICAgZm9yIChsZXQgYyA9IDE7IGMgPCBvdXRwdXRzWzBdLmxlbmd0aDsgYysrKSBvdXRwdXRzWzBdW2NdLnNldChvdXQpO1xuICAgIGlmIChjdXJyZW50VGltZSAtIHRoaXMucmVwb3J0ZWQgPiAwLjEpIHtcbiAgICAgIHRoaXMucmVwb3J0ZWQgPSBjdXJyZW50VGltZTtcbiAgICAgIGxldCBxdWV1ZWQgPSAtdGhpcy5vZmZzZXQ7XG4gICAgICBmb3IgKGNvbnN0IHEgb2YgdGhpcy5xdWV1ZSkgcXVldWVkICs9IHEubGVuZ3RoO1xuICAgICAgdGhpcy5wb3J0LnBvc3RNZXNzYWdlKHsgcXVldWVkOiBxdWV1ZWQgLyBzYW1wbGVSYXRlIH0pO1xuICAgIH1cbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxufVxucmVnaXN0ZXJQcm9jZXNzb3IoXCJjYXB0dXJlXCIsIENhcHR1cmUpO1xucmVnaXN0ZXJQcm9jZXNzb3IoXCJwbGF5YmFja1wiLCBQbGF5YmFjayk7XG5gO1xuXG5mdW5jdGlvbiBiYXNlNjRUb0J5dGVzKGI2NDogc3RyaW5nKTogVWludDhBcnJheSB7XG4gIGNvbnN0IGJpbiA9IGF0b2IoYjY0KTtcbiAgY29uc3Qgb3V0ID0gbmV3IFVpbnQ4QXJyYXkoYmluLmxlbmd0aCk7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgYmluLmxlbmd0aDsgaSsrKSBvdXRbaV0gPSBiaW4uY2hhckNvZGVBdChpKTtcbiAgcmV0dXJuIG91dDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGJ5dGVzVG9CYXNlNjQoYnl0ZXM6IFVpbnQ4QXJyYXkpOiBzdHJpbmcge1xuICBsZXQgYmluID0gXCJcIjtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBieXRlcy5sZW5ndGg7IGkgKz0gMHg4MDAwKSBiaW4gKz0gU3RyaW5nLmZyb21DaGFyQ29kZSguLi5ieXRlcy5zdWJhcnJheShpLCBpICsgMHg4MDAwKSk7XG4gIHJldHVybiBidG9hKGJpbik7XG59XG5cbi8qKiBQQ00xNiBsaXR0bGUtZW5kaWFuIGF0IFtyYXRlXSwgYXMgZmxvYXRzIGF0IHRoZSBjb250ZXh0J3MgcmF0ZS4gKi9cbmZ1bmN0aW9uIHRvRmxvYXRzKHBjbTogVWludDhBcnJheSwgcmF0ZTogbnVtYmVyLCB0YXJnZXQ6IG51bWJlcik6IEZsb2F0MzJBcnJheSB7XG4gIGNvbnN0IHZpZXcgPSBuZXcgRGF0YVZpZXcocGNtLmJ1ZmZlciwgcGNtLmJ5dGVPZmZzZXQsIHBjbS5ieXRlTGVuZ3RoKTtcbiAgY29uc3QgbiA9IE1hdGguZmxvb3IocGNtLmJ5dGVMZW5ndGggLyAyKTtcbiAgY29uc3Qgb3V0ID0gbmV3IEZsb2F0MzJBcnJheShNYXRoLmZsb29yKChuICogdGFyZ2V0KSAvIHJhdGUpKTtcbiAgY29uc3Qgc3RlcCA9IHJhdGUgLyB0YXJnZXQ7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgb3V0Lmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgeCA9IGkgKiBzdGVwO1xuICAgIGNvbnN0IGogPSBNYXRoLmZsb29yKHgpO1xuICAgIGNvbnN0IGEgPSB2aWV3LmdldEludDE2KDIgKiBNYXRoLm1pbihqLCBuIC0gMSksIHRydWUpO1xuICAgIGNvbnN0IGIgPSB2aWV3LmdldEludDE2KDIgKiBNYXRoLm1pbihqICsgMSwgbiAtIDEpLCB0cnVlKTtcbiAgICBvdXRbaV0gPSAoYSArIChiIC0gYSkgKiAoeCAtIGopKSAvIDMyNzY4O1xuICB9XG4gIHJldHVybiBvdXQ7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgTWljT3B0aW9ucyB7IGVjaG9DYW5jZWxsYXRpb246IGJvb2xlYW47IG5vaXNlU3VwcHJlc3Npb246IGJvb2xlYW47IGF1dG9HYWluQ29udHJvbDogYm9vbGVhbiB9XG5cbmV4cG9ydCBjbGFzcyBDYWxsQXVkaW8ge1xuICBwcml2YXRlIGNvbnRleHQ6IEF1ZGlvQ29udGV4dCB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIHBsYXliYWNrOiBBdWRpb1dvcmtsZXROb2RlIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgY2FwdHVyZTogQXVkaW9Xb3JrbGV0Tm9kZSB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIHN0cmVhbTogTWVkaWFTdHJlYW0gfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBzb3VyY2U6IE1lZGlhU3RyZWFtQXVkaW9Tb3VyY2VOb2RlIHwgbnVsbCA9IG51bGw7XG4gIC8qKiBTZWNvbmRzIG9mIHNwZWVjaCBxdWV1ZWQsIGFzIHRoZSB3b3JrbGV0IGxhc3Qgc2FpZC4gKi9cbiAgcXVldWVkID0gMDtcbiAgLyoqIFRoZSBtaWNyb3Bob25lJ3MgbGV2ZWwsIFJNUyBvZiB0aGUgbGFzdCBmcmFtZSAoMCB0byAxKS4gKi9cbiAgbGV2ZWwgPSAwO1xuXG4gIGFzeW5jIG9wZW4oKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKHRoaXMuY29udGV4dCkgeyBpZiAodGhpcy5jb250ZXh0LnN0YXRlID09PSBcInN1c3BlbmRlZFwiKSBhd2FpdCB0aGlzLmNvbnRleHQucmVzdW1lKCk7IHJldHVybjsgfVxuICAgIHRoaXMuY29udGV4dCA9IG5ldyBBdWRpb0NvbnRleHQoeyBsYXRlbmN5SGludDogXCJpbnRlcmFjdGl2ZVwiIH0pO1xuICAgIGNvbnN0IHVybCA9IFVSTC5jcmVhdGVPYmplY3RVUkwobmV3IEJsb2IoW1dPUktMRVRTXSwgeyB0eXBlOiBcInRleHQvamF2YXNjcmlwdFwiIH0pKTtcbiAgICBhd2FpdCB0aGlzLmNvbnRleHQuYXVkaW9Xb3JrbGV0LmFkZE1vZHVsZSh1cmwpO1xuICAgIHRoaXMucGxheWJhY2sgPSBuZXcgQXVkaW9Xb3JrbGV0Tm9kZSh0aGlzLmNvbnRleHQsIFwicGxheWJhY2tcIiwgeyBudW1iZXJPZklucHV0czogMCwgb3V0cHV0Q2hhbm5lbENvdW50OiBbMl0gfSk7XG4gICAgdGhpcy5wbGF5YmFjay5wb3J0Lm9ubWVzc2FnZSA9IChlKSA9PiB7IHRoaXMucXVldWVkID0gZS5kYXRhLnF1ZXVlZDsgfTtcbiAgICB0aGlzLnBsYXliYWNrLmNvbm5lY3QodGhpcy5jb250ZXh0LmRlc3RpbmF0aW9uKTtcbiAgfVxuXG4gIC8qKiBTZWNvbmRzIGZyb20gYSBzYW1wbGUgbGVhdmluZyB0aGUgd29ya2xldCB0byB0aGUgc3BlYWtlciwgYXMgdGhlIGJyb3dzZXIgcmVja29ucyBpdC4gKi9cbiAgZ2V0IG91dHB1dExhdGVuY3koKTogbnVtYmVyIHwgbnVsbCB7XG4gICAgaWYgKCF0aGlzLmNvbnRleHQpIHJldHVybiBudWxsO1xuICAgIHJldHVybiB0aGlzLmNvbnRleHQuYmFzZUxhdGVuY3kgKyAoKHRoaXMuY29udGV4dCBhcyBBdWRpb0NvbnRleHQgJiB7IG91dHB1dExhdGVuY3k/OiBudW1iZXIgfSkub3V0cHV0TGF0ZW5jeSA/PyAwKTtcbiAgfVxuXG4gIGFzeW5jIHN0YXJ0TWljKG9uRnJhbWU6IChwY202NDogc3RyaW5nLCBsZXZlbDogbnVtYmVyKSA9PiB2b2lkLCBvcHRpb25zOiBNaWNPcHRpb25zKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgYXdhaXQgdGhpcy5vcGVuKCk7XG4gICAgdGhpcy5zdG9wTWljKCk7XG4gICAgY29uc3QgY29udGV4dCA9IHRoaXMuY29udGV4dCE7XG4gICAgdGhpcy5zdHJlYW0gPSBhd2FpdCBuYXZpZ2F0b3IubWVkaWFEZXZpY2VzLmdldFVzZXJNZWRpYSh7IGF1ZGlvOiB7IGNoYW5uZWxDb3VudDogMSwgLi4ub3B0aW9ucyB9IH0pO1xuICAgIHRoaXMuc291cmNlID0gY29udGV4dC5jcmVhdGVNZWRpYVN0cmVhbVNvdXJjZSh0aGlzLnN0cmVhbSk7XG4gICAgdGhpcy5jYXB0dXJlID0gbmV3IEF1ZGlvV29ya2xldE5vZGUoY29udGV4dCwgXCJjYXB0dXJlXCIsIHsgbnVtYmVyT2ZPdXRwdXRzOiAwIH0pO1xuICAgIHRoaXMuY2FwdHVyZS5wb3J0Lm9ubWVzc2FnZSA9IChlKSA9PiB7XG4gICAgICBjb25zdCBmcmFtZSA9IG5ldyBJbnQxNkFycmF5KGUuZGF0YSBhcyBBcnJheUJ1ZmZlcik7XG4gICAgICBsZXQgc3VtID0gMDtcbiAgICAgIGZvciAoY29uc3QgcyBvZiBmcmFtZSkgc3VtICs9IHMgKiBzO1xuICAgICAgdGhpcy5sZXZlbCA9IE1hdGguc3FydChzdW0gLyBmcmFtZS5sZW5ndGgpIC8gMzI3Njg7XG4gICAgICBvbkZyYW1lKGJ5dGVzVG9CYXNlNjQobmV3IFVpbnQ4QXJyYXkoZS5kYXRhIGFzIEFycmF5QnVmZmVyKSksIHRoaXMubGV2ZWwpO1xuICAgIH07XG4gICAgdGhpcy5zb3VyY2UuY29ubmVjdCh0aGlzLmNhcHR1cmUpO1xuICB9XG5cbiAgc3RvcE1pYygpOiB2b2lkIHtcbiAgICB0aGlzLnNvdXJjZT8uZGlzY29ubmVjdCgpO1xuICAgIHRoaXMuY2FwdHVyZT8ucG9ydC5jbG9zZSgpO1xuICAgIHRoaXMuc3RyZWFtPy5nZXRUcmFja3MoKS5mb3JFYWNoKCh0KSA9PiB0LnN0b3AoKSk7XG4gICAgdGhpcy5zb3VyY2UgPSBudWxsO1xuICAgIHRoaXMuY2FwdHVyZSA9IG51bGw7XG4gICAgdGhpcy5zdHJlYW0gPSBudWxsO1xuICB9XG5cbiAgcGxheShwY202NDogc3RyaW5nKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLmNvbnRleHQgfHwgIXRoaXMucGxheWJhY2spIHJldHVybjtcbiAgICBjb25zdCBzYW1wbGVzID0gdG9GbG9hdHMoYmFzZTY0VG9CeXRlcyhwY202NCksIDI0MDAwLCB0aGlzLmNvbnRleHQuc2FtcGxlUmF0ZSk7XG4gICAgdGhpcy5wbGF5YmFjay5wb3J0LnBvc3RNZXNzYWdlKHsgdHlwZTogXCJwbGF5XCIsIHNhbXBsZXMgfSwgW3NhbXBsZXMuYnVmZmVyXSk7XG4gIH1cblxuICBjdWUocGNtNjQ6IHN0cmluZyk6IHZvaWQge1xuICAgIGlmICghdGhpcy5jb250ZXh0IHx8ICF0aGlzLnBsYXliYWNrKSByZXR1cm47XG4gICAgY29uc3Qgc2FtcGxlcyA9IHRvRmxvYXRzKGJhc2U2NFRvQnl0ZXMocGNtNjQpLCAyNDAwMCwgdGhpcy5jb250ZXh0LnNhbXBsZVJhdGUpO1xuICAgIHRoaXMucGxheWJhY2sucG9ydC5wb3N0TWVzc2FnZSh7IHR5cGU6IFwiY3VlXCIsIHNhbXBsZXMgfSwgW3NhbXBsZXMuYnVmZmVyXSk7XG4gIH1cblxuICBmbHVzaCgpOiB2b2lkIHtcbiAgICB0aGlzLnBsYXliYWNrPy5wb3J0LnBvc3RNZXNzYWdlKHsgdHlwZTogXCJmbHVzaFwiIH0pO1xuICB9XG5cbiAgc3RvcCgpOiB2b2lkIHtcbiAgICB0aGlzLnN0b3BNaWMoKTtcbiAgICB0aGlzLnBsYXliYWNrPy5wb3J0LnBvc3RNZXNzYWdlKHsgdHlwZTogXCJzdG9wXCIgfSk7XG4gIH1cbn1cbiIsICIvLyBUaGUgcmVwbGF5IHZpZXc6IGEgcmVjb3JkZWQgY2FsbCAoYSB0cmFjZSBmcm9tIGFueSBob3N0LCBvciBhIHNjZW5hcmlvKSBydW4gYWdhaW4gdGhyb3VnaCB0aGVcbi8vIGNvcmUsIGFzIHRoZSBidWlsZCB0aGF0IHJlY29yZGVkIGl0IGRpZCBhbmQgYXMgdGhlIGxhdGVzdCBkb2VzLCBzaWRlIGJ5IHNpZGUuIFdoZXJlIHRoZXkgcGFydFxuLy8gaXMgd2hlcmUgYSBjaGFuZ2UgaW4gc3JjLyBjaGFuZ2VkIHdoYXQgdGhlIGNhbGwgZG9lcyB3aXRoIHRoZSBzYW1lIHdvcmRzIGFuZCB0aGUgc2FtZSBtb2RlbC5cblxuaW50ZXJmYWNlIENvcmUge1xuICB2ZXJzaW9uOiBzdHJpbmc7XG4gIGNyZWF0ZShjb25maWc6IHN0cmluZywgdDogbnVtYmVyKTogc3RyaW5nO1xuICBwdXNoKGlkOiBudW1iZXIsIGV2ZW50OiBzdHJpbmcpOiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBSZWNvcmRpbmcgeyB2ZXJzaW9uPzogc3RyaW5nOyBjb25maWc6IHVua25vd247IHN0YXJ0OiBudW1iZXI7IGV2ZW50czogUmVjb3JkPHN0cmluZywgYW55PltdIH1cblxuLyoqIFdoYXQgYSBjb21tYW5kIG9yIGV2ZW50IGxvb2tzIGxpa2UgaW4gYSB0aW1lbGluZTogYXVkaW8gY3V0IG91dCwgb25lIGxpbmUuICovXG5mdW5jdGlvbiBsaW5lKG86IFJlY29yZDxzdHJpbmcsIGFueT4pOiBzdHJpbmcge1xuICBjb25zdCB0ZXh0ID0gSlNPTi5zdHJpbmdpZnkobykucmVwbGFjZSgvXCIoZGF0YXxwY20pXCI6XCJbQS1aYS16MC05Ky89XXs0MCx9XCIvZywgJ1wiJDFcIjpcIlx1MjAyNlwiJylcbiAgICAucmVwbGFjZSgvXFxcXFwiZGF0YVxcXFxcIjpcXFxcXCJbQS1aYS16MC05Ky89XXs0MCx9XFxcXFwiL2csICdcXFxcXCJkYXRhXFxcXFwiOlxcXFxcIlx1MjAyNlxcXFxcIicpO1xuICByZXR1cm4gdGV4dC5sZW5ndGggPiA0MDAgPyB0ZXh0LnNsaWNlKDAsIDQwMCkgKyBcIlx1MjAyNlwiIDogdGV4dDtcbn1cblxuLyoqIEF1ZGlvIGFuZCB0aWNrcyBzYXkgbm90aGluZyBhIHJlYWRlciBuZWVkczsgdGhlIHJlc3QgZG9lcy4gKi9cbmZ1bmN0aW9uIHRlbGxpbmcobzogUmVjb3JkPHN0cmluZywgYW55Pik6IGJvb2xlYW4ge1xuICBpZiAoby50eXBlID09PSBcIm1pY1wiIHx8IG8udHlwZSA9PT0gXCJ0aWNrXCIgfHwgby50eXBlID09PSBcInBsYXlcIikgcmV0dXJuIGZhbHNlO1xuICBpZiAoby50eXBlID09PSBcIndzLnNlbmRcIiAmJiBTdHJpbmcoby5kYXRhKS5zdGFydHNXaXRoKCd7XCJyZWFsdGltZUlucHV0XCI6e1wiYXVkaW9cIicpKSByZXR1cm4gZmFsc2U7XG4gIGlmIChvLnR5cGUgPT09IFwid3MubWVzc2FnZVwiICYmIFN0cmluZyhvLmRhdGEpLmluY2x1ZGVzKCdcImlubGluZURhdGFcIicpICYmICFTdHJpbmcoby5kYXRhKS5pbmNsdWRlcygnXCJ0dXJuQ29tcGxldGVcIicpKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiB0cnVlO1xufVxuXG5mdW5jdGlvbiBydW4oY29yZTogQ29yZSwgcjogUmVjb3JkaW5nKTogc3RyaW5nW11bXSB7XG4gIGNvbnN0IGNyZWF0ZWQgPSBKU09OLnBhcnNlKGNvcmUuY3JlYXRlKEpTT04uc3RyaW5naWZ5KHIuY29uZmlnKSwgci5zdGFydCkpO1xuICBjb25zdCBvdXQ6IHN0cmluZ1tdW10gPSBbY3JlYXRlZC5jb21tYW5kcy5maWx0ZXIodGVsbGluZykubWFwKGxpbmUpXTtcbiAgZm9yIChjb25zdCBlIG9mIHIuZXZlbnRzKSBvdXQucHVzaCgoSlNPTi5wYXJzZShjb3JlLnB1c2goY3JlYXRlZC5pZCwgSlNPTi5zdHJpbmdpZnkoZSkpKSBhcyBSZWNvcmQ8c3RyaW5nLCBhbnk+W10pLmZpbHRlcih0ZWxsaW5nKS5tYXAobGluZSkpO1xuICByZXR1cm4gb3V0O1xufVxuXG5leHBvcnQgY2xhc3MgUmVwbGF5IHtcbiAgcHJpdmF0ZSByZWFkb25seSByb290OiBIVE1MRWxlbWVudDtcbiAgcHJpdmF0ZSByZWFkb25seSBsb2FkOiAodXJsPzogc3RyaW5nKSA9PiBQcm9taXNlPENvcmU+O1xuXG4gIGNvbnN0cnVjdG9yKHJvb3Q6IEhUTUxFbGVtZW50LCBsb2FkOiAodXJsPzogc3RyaW5nKSA9PiBQcm9taXNlPENvcmU+KSB7XG4gICAgdGhpcy5yb290ID0gcm9vdDtcbiAgICB0aGlzLmxvYWQgPSBsb2FkO1xuICAgIHJvb3QuaW5uZXJIVE1MID0gYFxuICAgICAgPGgyPlRyYWNlIHJlcGxheTwvaDI+XG4gICAgICA8ZGl2IGNsYXNzPVwiYmFyXCI+PHNlbGVjdCBjbGFzcz1cInBpY2tcIiBhcmlhLWxhYmVsPVwiUmVjb3JkaW5nXCI+PC9zZWxlY3Q+PGJ1dHRvbiB0eXBlPVwiYnV0dG9uXCIgY2xhc3M9XCJyZWZyZXNoXCIgdGl0bGU9XCJSZWZyZXNoIGxpc3RcIiBhcmlhLWxhYmVsPVwiUmVmcmVzaCBsaXN0XCI+XHUyMUJCPC9idXR0b24+PGJ1dHRvbiB0eXBlPVwiYnV0dG9uXCIgY2xhc3M9XCJnb1wiPlJlcGxheTwvYnV0dG9uPlxuICAgICAgPGxhYmVsIGNsYXNzPVwidG9nZ2xlLWFsbFwiPjxpbnB1dCB0eXBlPVwiY2hlY2tib3hcIiBjbGFzcz1cImFsbFwiPiBTaG93IGF1ZGlvIGFuZCB0aWNrczwvbGFiZWw+PHNwYW4gY2xhc3M9XCJzdW1tYXJ5XCI+PC9zcGFuPjwvZGl2PlxuICAgICAgPGRpdiBjbGFzcz1cInRpbWVsaW5lXCI+PC9kaXY+YDtcbiAgICAocm9vdC5xdWVyeVNlbGVjdG9yKFwiLnJlZnJlc2hcIikgYXMgSFRNTEVsZW1lbnQpLm9uY2xpY2sgPSAoKSA9PiB2b2lkIHRoaXMubGlzdCgpO1xuICAgIChyb290LnF1ZXJ5U2VsZWN0b3IoXCIuZ29cIikgYXMgSFRNTEVsZW1lbnQpLm9uY2xpY2sgPSAoKSA9PiB2b2lkIHRoaXMucmVwbGF5KCkuY2F0Y2goKGVycikgPT4gdGhpcy5zYXkoYFJlcGxheSBmYWlsZWQ6ICR7ZXJyLm1lc3NhZ2V9YCkpO1xuICAgIHZvaWQgdGhpcy5saXN0KCk7XG4gIH1cblxuICBwcml2YXRlIHNheSh0ZXh0OiBzdHJpbmcpIHtcbiAgICAodGhpcy5yb290LnF1ZXJ5U2VsZWN0b3IoXCIuc3VtbWFyeVwiKSBhcyBIVE1MRWxlbWVudCkudGV4dENvbnRlbnQgPSB0ZXh0O1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBsaXN0KCkge1xuICAgIGNvbnN0IHBpY2sgPSB0aGlzLnJvb3QucXVlcnlTZWxlY3RvcihcIi5waWNrXCIpIGFzIEhUTUxTZWxlY3RFbGVtZW50O1xuICAgIHBpY2suaW5uZXJIVE1MID0gXCJcIjtcbiAgICBjb25zdCB0cmFjZXM6IHsgbmFtZTogc3RyaW5nOyBieXRlczogbnVtYmVyIH1bXSA9IGF3YWl0IChhd2FpdCBmZXRjaChcIi90cmFjZXNcIikpLmpzb24oKTtcbiAgICBjb25zdCBzY2VuYXJpb3M6IHN0cmluZ1tdID0gYXdhaXQgKGF3YWl0IGZldGNoKFwiL3NjZW5hcmlvc1wiKSkuanNvbigpO1xuICAgIGNvbnN0IHRyYWNlR3JvdXAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwib3B0Z3JvdXBcIik7XG4gICAgdHJhY2VHcm91cC5sYWJlbCA9IFwiUmVjb3JkZWQgY2FsbHNcIjtcbiAgICBmb3IgKGNvbnN0IHQgb2YgdHJhY2VzKSB0cmFjZUdyb3VwLmFwcGVuZChuZXcgT3B0aW9uKGAke3QubmFtZX0gKCR7TWF0aC5yb3VuZCh0LmJ5dGVzIC8gMTAyNCl9IEtCKWAsIGAvdHJhY2VzLyR7dC5uYW1lfWApKTtcbiAgICBjb25zdCBzY2VuYXJpb0dyb3VwID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcIm9wdGdyb3VwXCIpO1xuICAgIHNjZW5hcmlvR3JvdXAubGFiZWwgPSBcIlNjZW5hcmlvc1wiO1xuICAgIGZvciAoY29uc3QgcyBvZiBzY2VuYXJpb3MpIHNjZW5hcmlvR3JvdXAuYXBwZW5kKG5ldyBPcHRpb24ocywgYC9zY2VuYXJpb3MvJHtzfS5qc29uYCkpO1xuICAgIHBpY2suYXBwZW5kKHRyYWNlR3JvdXAsIHNjZW5hcmlvR3JvdXApO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyByZWNvcmRpbmcodXJsOiBzdHJpbmcpOiBQcm9taXNlPFJlY29yZGluZz4ge1xuICAgIGNvbnN0IHRleHQgPSBhd2FpdCAoYXdhaXQgZmV0Y2godXJsLCB7IGNhY2hlOiBcIm5vLXN0b3JlXCIgfSkpLnRleHQoKTtcbiAgICBpZiAodXJsLmVuZHNXaXRoKFwiLmpzb25cIikpIHJldHVybiBKU09OLnBhcnNlKHRleHQpO1xuICAgIGNvbnN0IFtoZWFkZXIsIC4uLmV2ZW50c10gPSB0ZXh0LnRyaW0oKS5zcGxpdChcIlxcblwiKS5tYXAoKGwpID0+IEpTT04ucGFyc2UobCkpO1xuICAgIHJldHVybiB7IC4uLmhlYWRlciwgZXZlbnRzIH07XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHJlcGxheSgpIHtcbiAgICBjb25zdCB1cmwgPSAodGhpcy5yb290LnF1ZXJ5U2VsZWN0b3IoXCIucGlja1wiKSBhcyBIVE1MU2VsZWN0RWxlbWVudCkudmFsdWU7XG4gICAgaWYgKCF1cmwpIHJldHVybjtcbiAgICBjb25zdCByID0gYXdhaXQgdGhpcy5yZWNvcmRpbmcodXJsKTtcbiAgICBjb25zdCBsYXRlc3QgPSBhd2FpdCB0aGlzLmxvYWQoKTtcbiAgICBsZXQgcmVjb3JkZWQ6IENvcmUgfCBudWxsID0gbnVsbDtcbiAgICBpZiAoci52ZXJzaW9uICYmIHIudmVyc2lvbiAhPT0gbGF0ZXN0LnZlcnNpb24pIHtcbiAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goYC92ZXJzaW9ucy8ke3IudmVyc2lvbn0uanNgLCB7IG1ldGhvZDogXCJIRUFEXCIgfSk7XG4gICAgICBpZiAocmVzcG9uc2Uub2spIHJlY29yZGVkID0gYXdhaXQgdGhpcy5sb2FkKGAvdmVyc2lvbnMvJHtyLnZlcnNpb259LmpzYCk7XG4gICAgfVxuICAgIGNvbnN0IG5vdyA9IHJ1bihsYXRlc3QsIHIpO1xuICAgIGNvbnN0IHRoZW4gPSByZWNvcmRlZCA/IHJ1bihyZWNvcmRlZCwgcikgOiBudWxsO1xuICAgIGNvbnN0IGFsbCA9ICh0aGlzLnJvb3QucXVlcnlTZWxlY3RvcihcIi5hbGxcIikgYXMgSFRNTElucHV0RWxlbWVudCkuY2hlY2tlZDtcbiAgICBjb25zdCB0aW1lbGluZSA9IHRoaXMucm9vdC5xdWVyeVNlbGVjdG9yKFwiLnRpbWVsaW5lXCIpIGFzIEhUTUxFbGVtZW50O1xuICAgIHRpbWVsaW5lLmlubmVySFRNTCA9IFwiXCI7XG4gICAgbGV0IGZpcnN0ID0gLTE7XG4gICAgbGV0IGRpZmZlciA9IDA7XG4gICAgY29uc3Qgcm93czogSFRNTEVsZW1lbnRbXSA9IFtdO1xuICAgIGNvbnN0IGFkZCA9IChjbHM6IHN0cmluZywgdDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpID0+IHtcbiAgICAgIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICByb3cuY2xhc3NOYW1lID0gYHJvdyAke2Nsc31gO1xuICAgICAgcm93LmlubmVySFRNTCA9IGA8c3BhbiBjbGFzcz1cInRcIj4ke3R9PC9zcGFuPmA7XG4gICAgICBjb25zdCBiID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gICAgICBiLmNsYXNzTmFtZSA9IFwiYlwiO1xuICAgICAgYi50ZXh0Q29udGVudCA9IHRleHQ7XG4gICAgICByb3cuYXBwZW5kKGIpO1xuICAgICAgdGltZWxpbmUuYXBwZW5kKHJvdyk7XG4gICAgICByb3dzLnB1c2gocm93KTtcbiAgICAgIHJldHVybiByb3c7XG4gICAgfTtcbiAgICBjb25zdCB0MCA9IHIuc3RhcnQ7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPD0gci5ldmVudHMubGVuZ3RoOyBpKyspIHtcbiAgICAgIGNvbnN0IGUgPSBpID09PSAwID8gbnVsbCA6IHIuZXZlbnRzW2kgLSAxXTtcbiAgICAgIGNvbnN0IG5vd091dCA9IG5vd1tpXTtcbiAgICAgIGNvbnN0IHRoZW5PdXQgPSB0aGVuID8gdGhlbltpXSA6IG5vd091dDtcbiAgICAgIGNvbnN0IHNhbWUgPSBub3dPdXQubGVuZ3RoID09PSB0aGVuT3V0Lmxlbmd0aCAmJiBub3dPdXQuZXZlcnkoKGMsIGopID0+IGMgPT09IHRoZW5PdXRbal0pO1xuICAgICAgaWYgKCFzYW1lKSB7IGRpZmZlcisrOyBpZiAoZmlyc3QgPCAwKSBmaXJzdCA9IGk7IH1cbiAgICAgIGlmICghc2FtZSB8fCBhbGwgfHwgKGUgJiYgdGVsbGluZyhlKSkgfHwgbm93T3V0Lmxlbmd0aCA+IDApIHtcbiAgICAgICAgaWYgKGUgJiYgKGFsbCB8fCB0ZWxsaW5nKGUpIHx8ICFzYW1lKSkgYWRkKFwiaW5cIiwgKGUudCAtIHQwKS50b0ZpeGVkKDIpLCBsaW5lKGUpKTtcbiAgICAgICAgY29uc3QgdCA9IGUgPyAoZS50IC0gdDApLnRvRml4ZWQoMikgOiBcIjAuMDBcIjtcbiAgICAgICAgaWYgKHNhbWUpIGZvciAoY29uc3QgYyBvZiBub3dPdXQpIGFkZChcIm91dFwiLCB0LCBjKTtcbiAgICAgICAgZWxzZSB7XG4gICAgICAgICAgZm9yIChjb25zdCBjIG9mIHRoZW5PdXQpIGFkZChcIm91dCBnb25lXCIsIHQsIGBcdTIyMTIgJHtjfWApO1xuICAgICAgICAgIGZvciAoY29uc3QgYyBvZiBub3dPdXQpIGFkZChcIm91dCBuZXdcIiwgdCwgYCsgJHtjfWApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IHZlcnNpb25zID0gdGhlbiA/IGByZWNvcmRlZCBieSAke3IudmVyc2lvbn0sIHJlcGxheWVkIGJ5IGl0IGFuZCBieSAke2xhdGVzdC52ZXJzaW9ufWAgOiBgcmVwbGF5ZWQgYnkgJHtsYXRlc3QudmVyc2lvbn1gICtcbiAgICAgIChyLnZlcnNpb24gJiYgci52ZXJzaW9uICE9PSBsYXRlc3QudmVyc2lvbiA/IGAgKHRoZSByZWNvcmRpbmcncyBidWlsZCAke3IudmVyc2lvbn0gaXNuJ3Qga2VwdCBoZXJlKWAgOiBcIlwiKTtcbiAgICB0aGlzLnNheShgJHtyLmV2ZW50cy5sZW5ndGh9IGV2ZW50cywgJHt2ZXJzaW9uc30uIGAgKyAodGhlbiA/IChkaWZmZXIgPyBgJHtkaWZmZXJ9IGV2ZW50cyBhbnN3ZXJlZCBkaWZmZXJlbnRseSwgdGhlIGZpcnN0IGF0IGV2ZW50ICR7Zmlyc3R9LmAgOiBcIkJvdGggYW5zd2VyZWQgZXZlcnkgZXZlbnQgdGhlIHNhbWUuXCIpIDogXCJcIikpO1xuICAgIGlmIChmaXJzdCA+PSAwKSB0aW1lbGluZS5xdWVyeVNlbGVjdG9yKFwiLmdvbmUsIC5uZXdcIik/LnNjcm9sbEludG9WaWV3KHsgYmxvY2s6IFwiY2VudGVyXCIgfSk7XG4gIH1cbn1cbiIsICIvKiogTWluaW1hbCBzY3JvbGxpbmcgcGFuZSBzdXJmYWNlIHNvIGF1dG8tc2Nyb2xsIGxvZ2ljIHN0YXlzIHRlc3RhYmxlIHdpdGhvdXQgYSBicm93c2VyIERPTS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgU2Nyb2xsUGFuZSB7XG4gIHNjcm9sbFRvcDogbnVtYmVyO1xuICByZWFkb25seSBzY3JvbGxIZWlnaHQ6IG51bWJlcjtcbiAgcmVhZG9ubHkgY2xpZW50SGVpZ2h0OiBudW1iZXI7XG4gIHNjcm9sbFRvPyhvcHRpb25zOiB7IHRvcDogbnVtYmVyOyBiZWhhdmlvcj86IFNjcm9sbEJlaGF2aW9yIH0pOiB2b2lkO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEF1dG9TY3JvbGxlck9wdGlvbnMge1xuICAvKiogRGlzdGFuY2UgZnJvbSB0aGUgYm90dG9tIChweCkgdGhhdCBzdGlsbCBjb3VudHMgYXMgcGlubmVkLiAqL1xuICBwaW5UaHJlc2hvbGQ/OiBudW1iZXI7XG4gIC8qKiBEaXN0YW5jZSBmcm9tIHRoZSBib3R0b20gKHB4KSBwYXN0IHdoaWNoIHRoZSBqdW1wLXRvLWxhdGVzdCBjb250cm9sIGlzIHNob3duLiAqL1xuICBqdW1wVGhyZXNob2xkPzogbnVtYmVyO1xuICAvKiogQ2FsbGVkIHdoZW5ldmVyIHRoZSBqdW1wLXRvLWxhdGVzdCBjb250cm9sJ3MgdmlzaWJpbGl0eSBtYXkgaGF2ZSBjaGFuZ2VkLiAqL1xuICBvbkp1bXBDaGFuZ2U/OiAoc2hvdzogYm9vbGVhbikgPT4gdm9pZDtcbiAgLyoqIFdoZW4gdHJ1ZSAoZm9yIGV4YW1wbGUgd2hpbGUgdGhlIGVtcHR5IHN0YXRlIGlzIHNob3duKSwga2VlcCB0aGUganVtcCBjb250cm9sIGhpZGRlbi4gKi9cbiAgaXNFbXB0eT86ICgpID0+IGJvb2xlYW47XG59XG5cbi8qKlxuICogS2VlcHMgYSB0cmFuc2NyaXB0IHBhbmUgcGlubmVkIHRvIHRoZSBib3R0b20gYXMgbWVzc2FnZXMgc3RyZWFtIGluLCB3aXRob3V0IG1lYXN1cmluZ1xuICogbmVhci1ib3R0b20gYWZ0ZXIgYW4gYXBwZW5kIGhhcyBhbHJlYWR5IGdyb3duIHNjcm9sbEhlaWdodCwgYW5kIHlpZWxkcyBpbW1lZGlhdGVseSB3aGVuXG4gKiB0aGUgdXNlciBzY3JvbGxzIHVwIHRvIHJlYWQgZWFybGllciBtZXNzYWdlcy5cbiAqL1xuZXhwb3J0IGNsYXNzIEF1dG9TY3JvbGxlciB7XG4gIHByaXZhdGUgcmVhZG9ubHkgcGFuZTogU2Nyb2xsUGFuZTtcbiAgcHJpdmF0ZSByZWFkb25seSBwaW5UaHJlc2hvbGQ6IG51bWJlcjtcbiAgcHJpdmF0ZSByZWFkb25seSBqdW1wVGhyZXNob2xkOiBudW1iZXI7XG4gIHByaXZhdGUgcmVhZG9ubHkgb25KdW1wQ2hhbmdlPzogKHNob3c6IGJvb2xlYW4pID0+IHZvaWQ7XG4gIHByaXZhdGUgcmVhZG9ubHkgaXNFbXB0eT86ICgpID0+IGJvb2xlYW47XG4gIHByaXZhdGUgcGlubmVkID0gdHJ1ZTtcbiAgcHJpdmF0ZSBqdW1waW5nID0gZmFsc2U7XG4gIHByaXZhdGUgbGFzdFNjcm9sbFRvcCA9IDA7XG5cbiAgY29uc3RydWN0b3IocGFuZTogU2Nyb2xsUGFuZSwgb3B0aW9uczogQXV0b1Njcm9sbGVyT3B0aW9ucyA9IHt9KSB7XG4gICAgdGhpcy5wYW5lID0gcGFuZTtcbiAgICB0aGlzLnBpblRocmVzaG9sZCA9IG9wdGlvbnMucGluVGhyZXNob2xkID8/IDMyO1xuICAgIHRoaXMuanVtcFRocmVzaG9sZCA9IG9wdGlvbnMuanVtcFRocmVzaG9sZCA/PyAxMjA7XG4gICAgdGhpcy5vbkp1bXBDaGFuZ2UgPSBvcHRpb25zLm9uSnVtcENoYW5nZTtcbiAgICB0aGlzLmlzRW1wdHkgPSBvcHRpb25zLmlzRW1wdHk7XG4gICAgdGhpcy5sYXN0U2Nyb2xsVG9wID0gcGFuZS5zY3JvbGxUb3A7XG4gIH1cblxuICBnZXQgaXNQaW5uZWQoKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMucGlubmVkO1xuICB9XG5cbiAgcHJpdmF0ZSBkaXN0YW5jZSgpOiBudW1iZXIge1xuICAgIHJldHVybiBNYXRoLm1heCgwLCB0aGlzLnBhbmUuc2Nyb2xsSGVpZ2h0IC0gdGhpcy5wYW5lLnNjcm9sbFRvcCAtIHRoaXMucGFuZS5jbGllbnRIZWlnaHQpO1xuICB9XG5cbiAgcHJpdmF0ZSBpc1Zpc2libGUoKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMucGFuZS5jbGllbnRIZWlnaHQgPiAwO1xuICB9XG5cbiAgcHJpdmF0ZSBzbmFwVG9Cb3R0b20oKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLmlzVmlzaWJsZSgpKSByZXR1cm47XG4gICAgdGhpcy5wYW5lLnNjcm9sbFRvcCA9IHRoaXMucGFuZS5zY3JvbGxIZWlnaHQ7XG4gICAgdGhpcy5sYXN0U2Nyb2xsVG9wID0gdGhpcy5wYW5lLnNjcm9sbFRvcDtcbiAgfVxuXG4gIHByaXZhdGUgdXBkYXRlSnVtcCgpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMub25KdW1wQ2hhbmdlKSByZXR1cm47XG4gICAgY29uc3QgZW1wdHkgPSB0aGlzLmlzRW1wdHk/LigpID8/IGZhbHNlO1xuICAgIGNvbnN0IHNob3cgPSAhZW1wdHkgJiYgdGhpcy5pc1Zpc2libGUoKSAmJiAhdGhpcy5qdW1waW5nICYmIHRoaXMuZGlzdGFuY2UoKSA+IHRoaXMuanVtcFRocmVzaG9sZDtcbiAgICB0aGlzLm9uSnVtcENoYW5nZShzaG93KTtcbiAgfVxuXG4gIC8qKiBDYWxsIGFmdGVyIGNvbnRlbnQgaXMgYWRkZWQsIHVwZGF0ZWQsIG9yIHJlbW92ZWQgaW4gdGhlIHBhbmUuICovXG4gIG9uQ29udGVudChmb3JjZSA9IGZhbHNlKTogdm9pZCB7XG4gICAgaWYgKGZvcmNlKSB7XG4gICAgICB0aGlzLnBpbm5lZCA9IHRydWU7XG4gICAgICB0aGlzLmp1bXBpbmcgPSBmYWxzZTtcbiAgICB9XG4gICAgaWYgKHRoaXMucGlubmVkKSB7XG4gICAgICBpZiAodGhpcy5qdW1waW5nICYmIHRoaXMucGFuZS5zY3JvbGxUbyAmJiB0aGlzLmlzVmlzaWJsZSgpKSB7XG4gICAgICAgIHRoaXMucGFuZS5zY3JvbGxUbyh7IHRvcDogdGhpcy5wYW5lLnNjcm9sbEhlaWdodCwgYmVoYXZpb3I6IFwic21vb3RoXCIgfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aGlzLnNuYXBUb0JvdHRvbSgpO1xuICAgICAgfVxuICAgIH1cbiAgICB0aGlzLnVwZGF0ZUp1bXAoKTtcbiAgfVxuXG4gIC8qKiBDYWxsIHdoZW4gdGhlIHBhbmUncyB2aWV3cG9ydCByZXNpemVzIChiYXJzIGFwcGVhcmluZywga2V5Ym9hcmQsIHRhYiBzd2l0Y2gpLiAqL1xuICBvblJlc2l6ZSgpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuaXNWaXNpYmxlKCkpIHJldHVybjtcbiAgICBpZiAodGhpcy5waW5uZWQpIHtcbiAgICAgIHRoaXMuanVtcGluZyA9IGZhbHNlO1xuICAgICAgdGhpcy5zbmFwVG9Cb3R0b20oKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5sYXN0U2Nyb2xsVG9wID0gdGhpcy5wYW5lLnNjcm9sbFRvcDtcbiAgICB9XG4gICAgdGhpcy51cGRhdGVKdW1wKCk7XG4gIH1cblxuICAvKiogQ2FsbCBmcm9tIHRoZSBwYW5lJ3Mgc2Nyb2xsIGV2ZW50IGxpc3RlbmVyLiAqL1xuICBvblNjcm9sbCgpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuaXNWaXNpYmxlKCkpIHJldHVybjtcbiAgICBjb25zdCB0b3AgPSB0aGlzLnBhbmUuc2Nyb2xsVG9wO1xuICAgIGNvbnN0IGRpc3QgPSB0aGlzLmRpc3RhbmNlKCk7XG4gICAgY29uc3QgbW92ZWRVcCA9IHRvcCA8IHRoaXMubGFzdFNjcm9sbFRvcDtcbiAgICB0aGlzLmxhc3RTY3JvbGxUb3AgPSB0b3A7XG5cbiAgICBpZiAoZGlzdCA8PSB0aGlzLnBpblRocmVzaG9sZCkge1xuICAgICAgdGhpcy5waW5uZWQgPSB0cnVlO1xuICAgICAgdGhpcy5qdW1waW5nID0gZmFsc2U7XG4gICAgfSBlbHNlIGlmIChtb3ZlZFVwKSB7XG4gICAgICB0aGlzLnBpbm5lZCA9IGZhbHNlO1xuICAgICAgdGhpcy5qdW1waW5nID0gZmFsc2U7XG4gICAgfVxuICAgIHRoaXMudXBkYXRlSnVtcCgpO1xuICB9XG5cbiAgLyoqIENhbGwgZnJvbSB0aGUgcGFuZSdzIHNjcm9sbGVuZCBldmVudCBsaXN0ZW5lci4gKi9cbiAgb25TY3JvbGxFbmQoKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLmlzVmlzaWJsZSgpIHx8ICF0aGlzLmp1bXBpbmcpIHJldHVybjtcbiAgICB0aGlzLmp1bXBpbmcgPSBmYWxzZTtcbiAgICBpZiAodGhpcy5kaXN0YW5jZSgpID4gdGhpcy5waW5UaHJlc2hvbGQpIHRoaXMucGlubmVkID0gZmFsc2U7XG4gICAgdGhpcy51cGRhdGVKdW1wKCk7XG4gIH1cblxuICAvKiogQ2FsbCBvbiB1c2VyIHdoZWVsLXVwIG9yIHRvdWNoc3RhcnQgc28gYW4gYWN0aXZlIHNtb290aCBqdW1wIHlpZWxkcyB0byB0aGUgdXNlci4gKi9cbiAgY2FuY2VsSnVtcCgpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuanVtcGluZykgcmV0dXJuO1xuICAgIHRoaXMuanVtcGluZyA9IGZhbHNlO1xuICAgIGlmICh0aGlzLmRpc3RhbmNlKCkgPiB0aGlzLnBpblRocmVzaG9sZCkgdGhpcy5waW5uZWQgPSBmYWxzZTtcbiAgICB0aGlzLnVwZGF0ZUp1bXAoKTtcbiAgfVxuXG4gIC8qKiBSZS1waW4gYW5kIHNjcm9sbCBzbW9vdGhseSB0byB0aGUgYm90dG9tICh1c2VkIGJ5IHRoZSBqdW1wLXRvLWxhdGVzdCBidXR0b24pLiAqL1xuICBqdW1wVG9Cb3R0b20oKTogdm9pZCB7XG4gICAgdGhpcy5waW5uZWQgPSB0cnVlO1xuICAgIGlmICghdGhpcy5pc1Zpc2libGUoKSkge1xuICAgICAgdGhpcy51cGRhdGVKdW1wKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICh0aGlzLmRpc3RhbmNlKCkgPD0gdGhpcy5waW5UaHJlc2hvbGQgfHwgIXRoaXMucGFuZS5zY3JvbGxUbykge1xuICAgICAgdGhpcy5qdW1waW5nID0gZmFsc2U7XG4gICAgICB0aGlzLnNuYXBUb0JvdHRvbSgpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLmp1bXBpbmcgPSB0cnVlO1xuICAgICAgdGhpcy5sYXN0U2Nyb2xsVG9wID0gdGhpcy5wYW5lLnNjcm9sbFRvcDtcbiAgICAgIHRoaXMucGFuZS5zY3JvbGxUbyh7IHRvcDogdGhpcy5wYW5lLnNjcm9sbEhlaWdodCwgYmVoYXZpb3I6IFwic21vb3RoXCIgfSk7XG4gICAgfVxuICAgIHRoaXMudXBkYXRlSnVtcCgpO1xuICB9XG5cbiAgLyoqIFJlY29tcHV0ZSBwaW5uZWQgc3RhdGUgZnJvbSB0aGUgY3VycmVudCBwb3NpdGlvbiBhZnRlciBhIHVzZXItZHJpdmVuIGxheW91dCBjaGFuZ2UgKGUuZy4gZXhwYW5kaW5nIGEgcmVzdWx0KS4gKi9cbiAgc3luY0Zyb21Qb3NpdGlvbigpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuaXNWaXNpYmxlKCkpIHJldHVybjtcbiAgICB0aGlzLmp1bXBpbmcgPSBmYWxzZTtcbiAgICB0aGlzLmxhc3RTY3JvbGxUb3AgPSB0aGlzLnBhbmUuc2Nyb2xsVG9wO1xuICAgIHRoaXMucGlubmVkID0gdGhpcy5kaXN0YW5jZSgpIDw9IHRoaXMucGluVGhyZXNob2xkO1xuICAgIHRoaXMudXBkYXRlSnVtcCgpO1xuICB9XG5cbiAgLyoqIFBhdXNlIGF1dG8tc2Nyb2xsIGV4cGxpY2l0bHkgKGUuZy4gd2hlbiByZXZlYWxpbmcgYW4gb2xkZXIgcmVzdWx0IGNhcmQpLiAqL1xuICB1bnBpbigpOiB2b2lkIHtcbiAgICB0aGlzLnBpbm5lZCA9IGZhbHNlO1xuICAgIHRoaXMuanVtcGluZyA9IGZhbHNlO1xuICAgIHRoaXMudXBkYXRlSnVtcCgpO1xuICB9XG59XG4iLCAiLy8gVGhlIHdlYiBzdXJmYWNlOiBhIGZvdXJ0aCBob3N0IGZvciB0aGUgdm9pY2UgY29yZSwgYW5kIGEgcGhvbmUtZnJpZW5kbHkgd2F5IHRvIHVzZSBpdCBmb3Igd29yay5cbi8vIEl0IGxvYWRzIHRoZSBkZXYgc2VydmVyJ3MgbGF0ZXN0IGJ1aWxkIGF0IGVhY2ggY2FsbCwgc28gYW4gZWRpdCBpbiBzcmMvIGlzIGxpdmUgb24gdGhlIG5leHRcbi8vIGNhbGwsIGFuZCBrZWVwcyBldmVyeSBjYWxsIGFzIGEgdHJhY2UgdGhlIHJlcGxheSB2aWV3IChhbmQgYW55IG90aGVyIGhvc3QpIGNhbiBydW4gYWdhaW4uXG4vL1xuLy8gVGhlIGhvc3QncyBwYXJ0IGlzIHNtYWxsOiB0aGUgbWljcm9waG9uZSBhbmQgc3BlYWtlciAoYXVkaW8udHMpLCB0aGUgbW9kZWwncyBzb2NrZXQgdGhyb3VnaCB0aGVcbi8vIHNlcnZlcidzIHJlbGF5LCBIZXJtZXMgYW5kIFQzIHRocm91Z2ggdGhlIHNlcnZlciwgYW5kIHRoZSBzY3JlZW4uIFRoZSBjb3JlIGRlY2lkZXMgdGhlIHJlc3QuXG4vL1xuLy8gVHlwaW5nIHdpdGggbm8gY2FsbCBvbiBzdGFydHMgYSBjaGF0IGluc3RlYWQ6IHRoZSBzYW1lIGNvcmUgd2l0aCBgbWVkaXVtOiBcInRleHRcImAsIHdob3NlIHJlcXVlc3RzXG4vLyB0byB0aGUgdGV4dCBtb2RlbCBnbyB0aHJvdWdoIHRoZSBzZXJ2ZXIncyAvZ2VuZXJhdGUuIFRhc2tzLCBmb2xsb3ctdXBzIGFuZCB0aGVpciBjYXJkcyB3b3JrIGFzXG4vLyBpbiBhIGNhbGwuIFByZXNzaW5nIENhbGwgZW5kcyB0aGUgY2hhdCBhbmQgY2FycmllcyBpdHMgY29udmVyc2F0aW9uIG9uIGJ5IHZvaWNlLlxuXG5pbXBvcnQgeyBjb21tYW5kSW4gfSBmcm9tIFwiLi4vc3JjL2NvbW1hbmRzLnRzXCI7XG5pbXBvcnQgeyBDYWxsQXVkaW8gfSBmcm9tIFwiLi9hdWRpby50c1wiO1xuaW1wb3J0IHsgUmVwbGF5IH0gZnJvbSBcIi4vcmVwbGF5LnRzXCI7XG5pbXBvcnQgeyBBdXRvU2Nyb2xsZXIgfSBmcm9tIFwiLi9zY3JvbGwudHNcIjtcblxuaW50ZXJmYWNlIENvcmUge1xuICB2ZXJzaW9uOiBzdHJpbmc7XG4gIGRlZmF1bHRzKCk6IHN0cmluZztcbiAgY3JlYXRlKGNvbmZpZzogc3RyaW5nLCB0OiBudW1iZXIpOiBzdHJpbmc7XG4gIHB1c2goaWQ6IG51bWJlciwgZXZlbnQ6IHN0cmluZyk6IHN0cmluZztcbiAgdHJhY2UoaWQ6IG51bWJlcik6IHN0cmluZztcbiAgZGlzcG9zZShpZDogbnVtYmVyKTogdm9pZDtcbn1cbnR5cGUgQ29tbWFuZCA9IFJlY29yZDxzdHJpbmcsIGFueT4gJiB7IHR5cGU6IHN0cmluZyB9O1xuaW50ZXJmYWNlIFNlcnZlckNvbmZpZyB7IHJvdXRlOiBzdHJpbmc7IG1vZGVsOiBzdHJpbmc7IGNhcHRpb25zTW9kZWw/OiBzdHJpbmc7IHRleHRNb2RlbD86IHN0cmluZzsgdmVyc2lvbjogc3RyaW5nOyBoZXJtZXM6IGJvb2xlYW47IHQzOiBzdHJpbmdbXSB8IG51bGwgfVxuXG5jb25zdCAkID0gPFQgZXh0ZW5kcyBIVE1MRWxlbWVudCA9IEhUTUxFbGVtZW50PihpZDogc3RyaW5nKSA9PiBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChpZCkgYXMgVDtcbmNvbnN0IG5vdyA9ICgpID0+IHBlcmZvcm1hbmNlLm5vdygpIC8gMTAwMDtcbmNvbnN0IGNoZWNrZWQgPSAoaWQ6IHN0cmluZykgPT4gJDxIVE1MSW5wdXRFbGVtZW50PihpZCkuY2hlY2tlZDtcblxuLyoqIFRoZSBsYXRlc3QgYnVpbGQgZnJvbSB0aGUgZGV2IHNlcnZlciwgZXZhbHVhdGVkIGFmcmVzaDogYW4gZWRpdCBpbiBzcmMvIGlzIGluIHRoZSBuZXh0IGNhbGwuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbG9hZENvcmUodXJsID0gXCIvdm9pY2UtY29yZS5qc1wiKTogUHJvbWlzZTxDb3JlPiB7XG4gIGNvbnN0IHNvdXJjZSA9IGF3YWl0IChhd2FpdCBmZXRjaCh1cmwsIHsgY2FjaGU6IFwibm8tc3RvcmVcIiB9KSkudGV4dCgpO1xuICBjb25zdCBzY29wZTogeyBWb2ljZUNvcmU/OiBDb3JlIH0gPSB7fTtcbiAgbmV3IEZ1bmN0aW9uKFwiZ2xvYmFsVGhpc1wiLCBzb3VyY2UpKHNjb3BlKTtcbiAgaWYgKCFzY29wZS5Wb2ljZUNvcmUpIHRocm93IG5ldyBFcnJvcihcInRoZSBidW5kbGUgZGlkbid0IGRlZmluZSBWb2ljZUNvcmVcIik7XG4gIHJldHVybiBzY29wZS5Wb2ljZUNvcmU7XG59XG5cbi8vIFByZXNldHM6IGVhY2ggc3VyZmFjZSdzIHNldHRpbmdzIGFzIGl0cyBhcHAgd291bGQgc2V0IHRoZW0uXG5cbmNvbnN0IEZBS0VfVFYgPSBbXG4gIHsgbmFtZTogXCJ0dl92b2x1bWVcIiwgZGVzY3JpcHRpb246IFwiU2V0cyB0aGUgbGl2aW5nLXJvb20gVFYncyB2b2x1bWUsIDAgdG8gMTAwLlwiLCBwYXJhbWV0ZXJzOiB7IHR5cGU6IFwiT0JKRUNUXCIsIHByb3BlcnRpZXM6IHsgbGV2ZWw6IHsgdHlwZTogXCJJTlRFR0VSXCIgfSB9LCByZXF1aXJlZDogW1wibGV2ZWxcIl0gfSB9LFxuICB7IG5hbWU6IFwidHZfcGF1c2VcIiwgZGVzY3JpcHRpb246IFwiUGF1c2VzIG9yIHJlc3VtZXMgd2hhdCdzIHBsYXlpbmcgb24gdGhlIFRWLlwiLCBwYXJhbWV0ZXJzOiB7IHR5cGU6IFwiT0JKRUNUXCIsIHByb3BlcnRpZXM6IHsgcGF1c2U6IHsgdHlwZTogXCJCT09MRUFOXCIgfSB9IH0gfSxcbl07XG5cbmNvbnN0IFBSRVNFVFM6IFJlY29yZDxzdHJpbmcsIFJlY29yZDxzdHJpbmcsIHVua25vd24+PiA9IHtcbiAgd2ViOiB7IHBsYXRmb3JtOiBcIndlYlwiLCBkZXZpY2U6IFwiYnJvd3NlclwiLCBzdGFuZGJ5QWZ0ZXI6IDMwLCBoYW5nVXBBZnRlcjogMzAwLCBoYW5kT2ZmOiBcIm5hbWVkXCIsIHN1cGVydmlzZTogdHJ1ZSwgdm9jYWJ1bGFyeTogW1wiSGVybWVzXCIsIFwiQmVudG9cIiwgXCJXb29kaG91c2VcIiwgXCJUM1wiXSB9LFxuICBhbmRyb2lkOiB7IHBsYXRmb3JtOiBcIkFuZHJvaWRcIiwgZGV2aWNlOiBcInBob25lXCIsIHN0YW5kYnlBZnRlcjogMjAgfSxcbiAgXCJhbmRyb2lkIHdha2Ugd29yZFwiOiB7IHBsYXRmb3JtOiBcIkFuZHJvaWRcIiwgZGV2aWNlOiBcInBob25lXCIsIHN0YW5kYnlBZnRlcjogMjAsIGhhbmdVcEFmdGVyOiAxNSB9LFxuICBtYWNvczogeyBwbGF0Zm9ybTogXCJtYWNPU1wiLCBkZXZpY2U6IFwiTWFjXCIsIHN0YW5kYnlBZnRlcjogMjAgfSxcbiAgZWNobzoge1xuICAgIHBsYXRmb3JtOiBcIkVjaG9cIiwgZGV2aWNlOiBcInNwZWFrZXJcIiwgaGFuZ1VwQWZ0ZXI6IDYsIHN0YW5kYnlBZnRlcjogOCwgZWFyY29uczogdHJ1ZSwgdm9jYWJ1bGFyeTogW1wiSGVybWVzXCIsIFwiQmVudG9cIiwgXCJXb29kaG91c2VcIl0sXG4gICAgbWljOiB7IHdoaWxlU3BlYWtpbmc6IFwid2FrZVwiLCBnYWluRGI6IDAgfSwgaG9zdFRvb2xzOiBGQUtFX1RWLFxuICB9LFxufTtcblxuLy8gU3RhdGUuXG5cbmNvbnN0IGF1ZGlvID0gbmV3IENhbGxBdWRpbygpO1xubGV0IHNlcnZlcjogU2VydmVyQ29uZmlnO1xubGV0IGNvcmU6IENvcmUgfCBudWxsID0gbnVsbDtcbmxldCBjYWxsSWQgPSAwO1xubGV0IGNhbGxOYW1lID0gXCJcIjtcbmxldCB0aWNrZXIgPSAwO1xubGV0IHRyYWNlVGltZXIgPSAwO1xubGV0IHN0YXJ0ZWRBdCA9IG5vdygpO1xuY29uc3Qgc29ja2V0cyA9IG5ldyBNYXA8bnVtYmVyLCBXZWJTb2NrZXQ+KCk7XG4vKiogVGhlIHNvY2tldHMgdG8gdGhlIHRyYW5zY3JpcHRpb24gbW9kZWw6IHRoZWlyIGF1ZGlvIGlzIHRoZSBtb2RlbCdzIGFnYWluLCBzbyBpdCBpc24ndCBjb3VudGVkIG9yIGxvZ2dlZCB0d2ljZS4gKi9cbmNvbnN0IGNhcHRpb25Tb2NrZXRzID0gbmV3IFNldDxudW1iZXI+KCk7XG5jb25zdCBydW5zID0gbmV3IE1hcDxzdHJpbmcsIHsgYWJvcnQ6IEFib3J0Q29udHJvbGxlcjsgYWdlbnQ6IHN0cmluZzsgdGFza0lkOiBzdHJpbmcgfT4oKTtcbmludGVyZmFjZSBUYXNrVmlldyB7IGM6IENvbW1hbmQ7IHNpbmNlOiBudW1iZXI7IGVuZGVkOiBudW1iZXIgfCBudWxsOyB0aHJlYWQ/OiBzdHJpbmc7IHJlc3VsdD86IEhUTUxFbGVtZW50OyBhcHByb3ZhbD86IHsgY29tbWFuZDogc3RyaW5nIH0gfVxuY29uc3QgdGFza3MgPSBuZXcgTWFwPHN0cmluZywgVGFza1ZpZXc+KCk7XG5sZXQgZWFybGllckFjdGl2ZUNvdW50ID0gMDtcbmxldCBlYXJsaWVyV2FpdGluZ0NvdW50ID0gMDtcbmxldCBjb3VudHMgPSB7IG1pYzogMCwgcGxheTogMCwgc2VudDogMCB9O1xubGV0IGZha2VUdkxldmVsID0gMTU7XG5sZXQgY29yZVN0YXR1cyA9IFwiaWRsZVwiO1xubGV0IG11dGVkID0gZmFsc2U7XG5sZXQgaG9sZGluZyA9IGZhbHNlO1xubGV0IHdha2VMb2NrOiB7IHJlbGVhc2UoKTogUHJvbWlzZTx2b2lkPiB9IHwgbnVsbCA9IG51bGw7XG4vKiogV2hhdCB0aGUgc2Vzc2lvbiBvbiBzY3JlZW4gaXM6IGEgdm9pY2UgY2FsbCwgb3IgYSB0eXBlZCBjaGF0ICh0aGUgY29yZSdzIG1lZGl1bSBcInRleHRcIikuICovXG5sZXQgbWVkaXVtOiBcInZvaWNlXCIgfCBcInRleHRcIiA9IFwidm9pY2VcIjtcbi8qKiBBIGNoYXQncyBtb2RlbCBpcyB3cml0aW5nIGl0cyBhbnN3ZXIuICovXG5sZXQgdGhpbmtpbmcgPSBmYWxzZTtcbi8qKiBBIGNoYXQncyByZXF1ZXN0cyB0byB0aGUgdGV4dCBtb2RlbCB0aGF0IGFyZSB1bmRlciB3YXkuICovXG5jb25zdCByZXF1ZXN0cyA9IG5ldyBNYXA8bnVtYmVyLCBBYm9ydENvbnRyb2xsZXI+KCk7XG4vKiogVGhlIGxhc3Qgc2Vzc2lvbiB3aW5kaW5nIGRvd24gKGl0cyB0cmFjZSBzYXZlZCwgdGhlIGNvcmUncyBjYWxsIGRpc3Bvc2VkKTogdGhlIG5leHQgc3RhcnRzIGFmdGVyIGl0LiAqL1xubGV0IGVuZGluZzogUHJvbWlzZTx2b2lkPiA9IFByb21pc2UucmVzb2x2ZSgpO1xuXG4vLyBUaGUgY29udmVyc2F0aW9uLCBrZXB0IHNvIGEgbmV3IGNhbGwgY2FuIGNhcnJ5IG9uIGZyb20gaXQgKHRoZSBjb3JlJ3MgYGhpc3RvcnlgLCByZWNhcHBlZCB0byB0aGUgbW9kZWwpLlxuaW50ZXJmYWNlIENoYXRMaW5lIHsgcm9sZTogXCJ1c2VyXCIgfCBcImFzc2lzdGFudFwiOyBzcGVha2VyPzogc3RyaW5nOyB0ZXh0OiBzdHJpbmcgfVxuY29uc3QgSElTVE9SWSA9IFwidm9pY2UuaGlzdG9yeVwiO1xuY29uc3QgSElTVE9SWV9NQVhfQUdFID0gMTIgKiAzNjAwICogMTAwMDtcbmxldCBjaGF0OiBDaGF0TGluZVtdID0gW107XG4vKiogVGhlIGNvcmUncyBudW1iZXIgZm9yIHRoZSBsaW5lIHRoZSBsYXN0IHdvcmRzIHdlcmUgcmVtZW1iZXJlZCBvbiwgdW50aWwgc29tZXRoaW5nIGVsc2UgaXMuICovXG5sZXQgbGFzdExpbmU6IG51bWJlciB8IG51bGwgPSBudWxsO1xuXG5mdW5jdGlvbiByZW1lbWJlcihyb2xlOiBcInVzZXJcIiB8IFwiYXNzaXN0YW50XCIsIHRleHQ6IHN0cmluZywgc3BlYWtlcj86IHN0cmluZywgam9pbiA9IGZhbHNlKSB7XG4gIGNvbnN0IGxhc3QgPSBjaGF0LmF0KC0xKTtcbiAgaWYgKGpvaW4gJiYgbGFzdCAmJiBsYXN0LnJvbGUgPT09IHJvbGUgJiYgbGFzdC5zcGVha2VyID09PSBzcGVha2VyKSBsYXN0LnRleHQgKz0gdGV4dDtcbiAgZWxzZSBjaGF0LnB1c2goc3BlYWtlciA/IHsgcm9sZSwgc3BlYWtlciwgdGV4dCB9IDogeyByb2xlLCB0ZXh0IH0pO1xuICBpZiAoY2hhdC5sZW5ndGggPiAyMDApIGNoYXQuc3BsaWNlKDAsIGNoYXQubGVuZ3RoIC0gMjAwKTtcbiAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oSElTVE9SWSwgSlNPTi5zdHJpbmdpZnkoeyBhdDogRGF0ZS5ub3coKSwgY2hhdCB9KSk7XG59XG5cbmZ1bmN0aW9uIHNhdmVkSGlzdG9yeSgpOiBDaGF0TGluZVtdIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBzYXZlZCA9IEpTT04ucGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oSElTVE9SWSkgPz8gXCJudWxsXCIpO1xuICAgIHJldHVybiBzYXZlZCAmJiBEYXRlLm5vdygpIC0gc2F2ZWQuYXQgPCBISVNUT1JZX01BWF9BR0UgJiYgQXJyYXkuaXNBcnJheShzYXZlZC5jaGF0KSA/IHNhdmVkLmNoYXQgOiBbXTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG59XG5cbi8qKiBUd28gcmlzaW5nIG5vdGVzOiBzb21ldGhpbmcgb24gdGhlIHNjcmVlbiBuZWVkcyB0aGUgdXNlci4gUENNMTYgYXQgMjQga0h6LCBiYXNlNjQuICovXG5jb25zdCBBUFBST1ZBTF9UT05FID0gKCgpID0+IHtcbiAgY29uc3QgcmF0ZSA9IDI0MDAwLCBvdXQgPSBuZXcgSW50MTZBcnJheShyYXRlICogMC4zMik7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgb3V0Lmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgdCA9IGkgLyByYXRlLCBmID0gdCA8IDAuMTYgPyA2NjAgOiA4ODAsIGxvY2FsID0gdCA8IDAuMTYgPyB0IDogdCAtIDAuMTY7XG4gICAgb3V0W2ldID0gTWF0aC5yb3VuZChNYXRoLnNpbigyICogTWF0aC5QSSAqIGYgKiB0KSAqIE1hdGgubWluKDEsIGxvY2FsICogNjAsICgwLjE2IC0gbG9jYWwpICogNjApICogNjAwMCk7XG4gIH1cbiAgbGV0IGJpbiA9IFwiXCI7XG4gIGNvbnN0IGJ5dGVzID0gbmV3IFVpbnQ4QXJyYXkob3V0LmJ1ZmZlcik7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgYnl0ZXMubGVuZ3RoOyBpKyspIGJpbiArPSBTdHJpbmcuZnJvbUNoYXJDb2RlKGJ5dGVzW2ldKTtcbiAgcmV0dXJuIGJ0b2EoYmluKTtcbn0pKCk7XG5cbi8vIExhdGVuY3k6IHRoZSBuZXR3b3JrJ3Mgcm91bmQgdHJpcCwgYW5kIGhvdyBsb25nIGFmdGVyIHRoZSB1c2VyIHN0b3BzIHRhbGtpbmcgdGhlIHJlcGx5IHN0YXJ0cy5cbmNvbnN0IG1ldHJpY3MgPSB7IHJ0dDogW10gYXMgbnVtYmVyW10sIHJlcGx5OiBbXSBhcyBudW1iZXJbXSwgbGFzdFZvaWNlOiAwLCBsYXN0UGxheTogMCwgcmVwbGllZDogdHJ1ZSB9O1xuXG5mdW5jdGlvbiBtZWRpYW4oeHM6IG51bWJlcltdKTogbnVtYmVyIHwgbnVsbCB7XG4gIGlmICh4cy5sZW5ndGggPT09IDApIHJldHVybiBudWxsO1xuICBjb25zdCBzID0gWy4uLnhzXS5zb3J0KChhLCBiKSA9PiBhIC0gYik7XG4gIHJldHVybiBzW01hdGguZmxvb3Iocy5sZW5ndGggLyAyKV07XG59XG5cbmZ1bmN0aW9uIHNob3dNZXRyaWNzKCkge1xuICBjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgcnR0ID0gbWVkaWFuKG1ldHJpY3MucnR0KTtcbiAgaWYgKHJ0dCAhPSBudWxsKSBwYXJ0cy5wdXNoKGAke01hdGgucm91bmQocnR0ICogMTAwMCl9IG1zYCk7XG4gIGNvbnN0IHJlcGx5ID0gbWVkaWFuKG1ldHJpY3MucmVwbHkpO1xuICBpZiAocmVwbHkgIT0gbnVsbCkgcGFydHMucHVzaChgcmVwbHkgJHttZXRyaWNzLnJlcGx5LmF0KC0xKSEudG9GaXhlZCgxKX1zICgke3JlcGx5LnRvRml4ZWQoMSl9cyBtZWQpYCk7XG4gIGNvbnN0IG91dCA9IGF1ZGlvLm91dHB1dExhdGVuY3k7XG4gIGlmIChvdXQgIT0gbnVsbCkgcGFydHMucHVzaChgYXVkaW8gJHtNYXRoLnJvdW5kKG91dCAqIDEwMDApfSBtc2ApO1xuICBsZXQgYnVmZmVyZWQgPSAwO1xuICBmb3IgKGNvbnN0IHdzIG9mIHNvY2tldHMudmFsdWVzKCkpIGJ1ZmZlcmVkICs9IHdzLmJ1ZmZlcmVkQW1vdW50O1xuICBpZiAoYnVmZmVyZWQgPiAzMl8wMDApIHBhcnRzLnB1c2goYHVwbG9hZCArJHsoYnVmZmVyZWQgLyAzMl8wMDApLnRvRml4ZWQoMSl9c2ApO1xuICAkKFwibWV0cmljc1wiKS50ZXh0Q29udGVudCA9IHBhcnRzLmpvaW4oXCIgXHUwMEI3IFwiKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcGluZygpIHtcbiAgY29uc3QgdCA9IG5vdygpO1xuICB0cnkge1xuICAgIGF3YWl0IGZldGNoKFwiL3BpbmdcIiwgeyBjYWNoZTogXCJuby1zdG9yZVwiIH0pO1xuICAgIG1ldHJpY3MucnR0LnB1c2gobm93KCkgLSB0KTtcbiAgICBpZiAobWV0cmljcy5ydHQubGVuZ3RoID4gMTIpIG1ldHJpY3MucnR0LnNoaWZ0KCk7XG4gIH0gY2F0Y2gge31cbiAgc2hvd01ldHJpY3MoKTtcbn1cblxuLy8gVGhlbWUuXG5cbmZ1bmN0aW9uIGFwcGx5VGhlbWUoY2hvaWNlOiBzdHJpbmcpIHtcbiAgY29uc3Qgcm9vdCA9IGRvY3VtZW50LmRvY3VtZW50RWxlbWVudDtcbiAgaWYgKGNob2ljZSA9PT0gXCJkYXJrXCIgfHwgY2hvaWNlID09PSBcImxpZ2h0XCIpIHJvb3QuZGF0YXNldC50aGVtZSA9IGNob2ljZTtcbiAgZWxzZSBkZWxldGUgcm9vdC5kYXRhc2V0LnRoZW1lO1xuICBjb25zdCBkYXJrID0gY2hvaWNlID09PSBcImRhcmtcIiB8fCAoY2hvaWNlICE9PSBcImxpZ2h0XCIgJiYgbWF0Y2hNZWRpYShcIihwcmVmZXJzLWNvbG9yLXNjaGVtZTogZGFyaylcIikubWF0Y2hlcyk7XG4gIGNvbnN0IG1ldGEgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInRoZW1lLWNvbG9yXCIpO1xuICBpZiAobWV0YSkgbWV0YS5zZXRBdHRyaWJ1dGUoXCJjb250ZW50XCIsIGRhcmsgPyBcIiMwZTBmMGZcIiA6IFwiI2Y2ZjVmMFwiKTtcbiAgZm9yIChjb25zdCBidG4gb2YgQXJyYXkuZnJvbShkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxCdXR0b25FbGVtZW50PihcIiN0aGVtZS1waWNrZXIgYnV0dG9uXCIpKSkge1xuICAgIGJ0bi5jbGFzc0xpc3QudG9nZ2xlKFwib25cIiwgYnRuLmRhdGFzZXQudGhlbWUgPT09IChjaG9pY2UgfHwgXCJzeXN0ZW1cIikpO1xuICB9XG59XG5cbi8vIFRoZSBzY3JlZW4uXG5cbmZ1bmN0aW9uIHNldENhbGxCdXR0b24obGl2ZTogYm9vbGVhbikge1xuICBjb25zdCBidG4gPSAkPEhUTUxCdXR0b25FbGVtZW50PihcImNhbGxcIik7XG4gIGJ0bi5jbGFzc0xpc3QudG9nZ2xlKFwibGl2ZVwiLCBsaXZlKTtcbiAgY29uc3QgbGFiZWwgPSBidG4ucXVlcnlTZWxlY3RvcihcIi5jYWxsLWxhYmVsXCIpO1xuICBpZiAobGFiZWwpIGxhYmVsLnRleHRDb250ZW50ID0gbGl2ZSA/IFwiSGFuZyB1cFwiIDogXCJDYWxsXCI7XG59XG5cbmZ1bmN0aW9uIHN5bmNSZXN1bWVCdXR0b25zKHNob3c6IGJvb2xlYW4pIHtcbiAgJChcInJlc3VtZVwiKS5oaWRkZW4gPSAhc2hvdztcbiAgJChcImhlcm8tcmVzdW1lXCIpLmhpZGRlbiA9ICFzaG93O1xufVxuXG5mdW5jdGlvbiBwYXJzZVByZWZpeCh0ZXh0OiBzdHJpbmcpOiB7IG1vZGU6IFwiaGVybWVzXCIgfCBcInQzXCIgfCBudWxsOyByZXN0OiBzdHJpbmcgfSB7XG4gIGNvbnN0IG0gPSB0ZXh0Lm1hdGNoKC9eXFwvKHQzfGNvZGV8aHxoZXJtZXMpXFxzKyguKikkL2lzKTtcbiAgaWYgKCFtKSByZXR1cm4geyBtb2RlOiBudWxsLCByZXN0OiB0ZXh0IH07XG4gIHJldHVybiB7IG1vZGU6IC9eKHQzfGNvZGUpJC9pLnRlc3QobVsxXSkgPyBcInQzXCIgOiBcImhlcm1lc1wiLCByZXN0OiBtWzJdLnRyaW0oKSB9O1xufVxuXG5mdW5jdGlvbiBzeW5jQ29tcG9zZXIoKSB7XG4gIGNvbnN0IGlucHV0ID0gJDxIVE1MSW5wdXRFbGVtZW50PihcInRleHRcIik7XG4gIGNvbnN0IHRyaW1tZWQgPSBpbnB1dC52YWx1ZS50cmltKCk7XG4gICQoXCJzZW5kYnRuXCIpLmNsYXNzTGlzdC50b2dnbGUoXCJyZWFkeVwiLCB0cmltbWVkLmxlbmd0aCA+IDApO1xuICBjb25zdCBwYXJzZWQgPSBwYXJzZVByZWZpeCh0cmltbWVkKTtcbiAgJChcIm1vZGUtd3JhcFwiKS5kYXRhc2V0Lm1vZGUgPSBwYXJzZWQubW9kZSA/PyAkPEhUTUxTZWxlY3RFbGVtZW50PihcIm1vZGVcIikudmFsdWU7XG59XG5cbmZ1bmN0aW9uIGZvcm1hdENsb2NrKHNlY29uZHM6IG51bWJlcik6IHN0cmluZyB7XG4gIGNvbnN0IHRvdGFsID0gTWF0aC5tYXgoMCwgTWF0aC5mbG9vcihzZWNvbmRzKSk7XG4gIGNvbnN0IGggPSBNYXRoLmZsb29yKHRvdGFsIC8gMzYwMCk7XG4gIGNvbnN0IG0gPSBNYXRoLmZsb29yKCh0b3RhbCAlIDM2MDApIC8gNjApO1xuICBjb25zdCBzID0gdG90YWwgJSA2MDtcbiAgY29uc3QgcGFkID0gKG46IG51bWJlcikgPT4gU3RyaW5nKG4pLnBhZFN0YXJ0KDIsIFwiMFwiKTtcbiAgcmV0dXJuIGggPiAwID8gYCR7aH06JHtwYWQobSl9OiR7cGFkKHMpfWAgOiBgJHtwYWQobSl9OiR7cGFkKHMpfWA7XG59XG5cbmNvbnN0IFZJWl9XRUlHSFRTID0gWzAuNDgsIDAuODYsIDEuMCwgMC43OCwgMC40NF07XG5mdW5jdGlvbiB1cGRhdGVWaXN1YWxpemVyKG1vZGU6IHN0cmluZywgbGV2ZWw6IG51bWJlcikge1xuICBjb25zdCB2aXogPSAkKFwidml6XCIpO1xuICB2aXouZGF0YXNldC5tb2RlID0gbW9kZTtcbiAgY29uc3QgYmFycyA9IHZpei5jaGlsZHJlbjtcbiAgaWYgKG1vZGUgPT09IFwibGlzdGVuaW5nXCIgfHwgbW9kZSA9PT0gXCJ3b3JraW5nXCIpIHtcbiAgICBjb25zdCBlbmVyZ3kgPSBNYXRoLm1pbigxLCBsZXZlbCAqIDE0KTtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGJhcnMubGVuZ3RoOyBpKyspIHtcbiAgICAgIGNvbnN0IGggPSAwLjI0ICsgZW5lcmd5ICogVklaX1dFSUdIVFNbaV0gKiAwLjc2O1xuICAgICAgKGJhcnNbaV0gYXMgSFRNTEVsZW1lbnQpLnN0eWxlLnRyYW5zZm9ybSA9IGBzY2FsZVkoJHtoLnRvRml4ZWQoMil9KWA7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYmFycy5sZW5ndGg7IGkrKykgKGJhcnNbaV0gYXMgSFRNTEVsZW1lbnQpLnN0eWxlLnRyYW5zZm9ybSA9IFwiXCI7XG4gIH1cbn1cblxuLyoqIEEgc3lzdGVtIG5vdGlmaWNhdGlvbiB3aGlsZSB0aGUgcGFnZSBpcyBoaWRkZW46IGEgdGFzayBmaW5pc2hlZCwgb3Igb25lIG5lZWRzIHRoZSB1c2VyLiAqL1xuZnVuY3Rpb24gbm90aWZ5KHRpdGxlOiBzdHJpbmcsIGJvZHk6IHN0cmluZykge1xuICBpZiAoIWRvY3VtZW50LmhpZGRlbiB8fCAhKFwiTm90aWZpY2F0aW9uXCIgaW4gd2luZG93KSB8fCBOb3RpZmljYXRpb24ucGVybWlzc2lvbiAhPT0gXCJncmFudGVkXCIpIHJldHVybjtcbiAgdHJ5IHtcbiAgICBjb25zdCBuID0gbmV3IE5vdGlmaWNhdGlvbih0aXRsZSwgeyBib2R5OiBib2R5LnNsaWNlKDAsIDE4MCksIGljb246IFwiL3dlYi9pY29ucy9pY29uLTE5Mi5wbmdcIiwgdGFnOiB0aXRsZSB9KTtcbiAgICBuLm9uY2xpY2sgPSAoKSA9PiB7IHdpbmRvdy5mb2N1cygpOyBuLmNsb3NlKCk7IH07XG4gIH0gY2F0Y2gge1xuICAgIC8vIFBob25lcyB3YW50IG5vdGlmaWNhdGlvbnMgZnJvbSBhIHNlcnZpY2Ugd29ya2VyOyB0aGUgcGFnZSBoYXMgbm9uZS5cbiAgfVxufVxuXG5mdW5jdGlvbiB0b2FzdCh0ZXh0OiBzdHJpbmcpIHtcbiAgY29uc3QgdCA9ICQoXCJ0b2FzdFwiKTtcbiAgdC50ZXh0Q29udGVudCA9IHRleHQ7XG4gIHQuY2xhc3NMaXN0LmFkZChcIm9uXCIpO1xuICBjbGVhclRpbWVvdXQoKHRvYXN0IGFzIGFueSkudGltZXIpO1xuICAodG9hc3QgYXMgYW55KS50aW1lciA9IHNldFRpbWVvdXQoKCkgPT4gdC5jbGFzc0xpc3QucmVtb3ZlKFwib25cIiksIDE4MDApO1xufVxuXG5mdW5jdGlvbiBsb2coa2luZDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcsIGNscyA9IFwiXCIpIHtcbiAgY29uc3QgcGFuZSA9ICQoXCJsb2dcIik7XG4gIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvdy5jbGFzc05hbWUgPSBgcm93ICR7Y2xzfWA7XG4gIHJvdy5pbm5lckhUTUwgPSBgPHNwYW4gY2xhc3M9XCJ0XCI+JHsobm93KCkgLSBzdGFydGVkQXQpLnRvRml4ZWQoMil9PC9zcGFuPjxzcGFuIGNsYXNzPVwia1wiPiR7a2luZH08L3NwYW4+YDtcbiAgY29uc3QgYm9keSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBib2R5LmNsYXNzTmFtZSA9IFwiYlwiO1xuICBib2R5LnRleHRDb250ZW50ID0gdGV4dDtcbiAgcm93LmFwcGVuZChib2R5KTtcbiAgY29uc3Qgc3RpY2sgPSBwYW5lLnNjcm9sbFRvcCArIHBhbmUuY2xpZW50SGVpZ2h0ID49IHBhbmUuc2Nyb2xsSGVpZ2h0IC0gMzA7XG4gIHBhbmUuYXBwZW5kKHJvdyk7XG4gIHdoaWxlIChwYW5lLmNoaWxkRWxlbWVudENvdW50ID4gMzAwMCkgcGFuZS5maXJzdEVsZW1lbnRDaGlsZCEucmVtb3ZlKCk7XG4gIGlmIChzdGljaykgcGFuZS5zY3JvbGxUb3AgPSBwYW5lLnNjcm9sbEhlaWdodDtcbn1cblxuLyoqIEEgZnJhbWUgZnJvbSBvciB0byBHZW1pbmksIHdpdGggYXVkaW8gY3V0IG91dCwgc2hvcnQgZW5vdWdoIHRvIHJlYWQuICovXG5mdW5jdGlvbiBicmllZihkYXRhOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gZGF0YS5yZXBsYWNlKC9cImRhdGFcIjpcIltBLVphLXowLTkrLz1dezQwLH1cIi9nLCAobSkgPT4gYFwiZGF0YVwiOlwiXHUyMDI2JHtNYXRoLnJvdW5kKCgobS5sZW5ndGggLSA5KSAqIDMpIC8gNCl9IGJ5dGVzXCJgKS5zbGljZSgwLCA2MDApO1xufVxuXG5mdW5jdGlvbiBlc2NhcGVIdG1sKHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiB0ZXh0LnJlcGxhY2UoL1smPD5cIiddL2csIChjKSA9PiAoeyBcIiZcIjogXCImYW1wO1wiLCBcIjxcIjogXCImbHQ7XCIsIFwiPlwiOiBcIiZndDtcIiwgJ1wiJzogXCImcXVvdDtcIiwgXCInXCI6IFwiJiMzOTtcIiB9KVtjXSEpO1xufVxuXG4vKiogQSBsaXR0bGUgTWFya2Rvd24sIHNhZmVseTogY29kZSwgYm9sZCwgbGlua3MsIGxpc3RzIGFuZCBoZWFkaW5ncywgdGhlIHJlc3QgYXMgdGV4dC4gKi9cbmZ1bmN0aW9uIG1hcmtkb3duKHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGJsb2NrcyA9IGVzY2FwZUh0bWwodGV4dC50cmltKCkpLnNwbGl0KC9gYGAoPzpcXHcrKT9cXG4/Lyk7XG4gIHJldHVybiBibG9ja3MubWFwKChibG9jaywgaSkgPT4ge1xuICAgIGlmIChpICUgMiA9PT0gMSkgcmV0dXJuIGA8cHJlPjxjb2RlPiR7YmxvY2sucmVwbGFjZSgvXFxuJC8sIFwiXCIpfTwvY29kZT48L3ByZT5gO1xuICAgIGNvbnN0IGlubGluZSA9IChzOiBzdHJpbmcpID0+IHNcbiAgICAgIC5yZXBsYWNlKC9gKFteYFxcbl0rKWAvZywgXCI8Y29kZT4kMTwvY29kZT5cIilcbiAgICAgIC5yZXBsYWNlKC9cXCpcXCooW14qXFxuXSspXFwqXFwqL2csIFwiPGI+JDE8L2I+XCIpXG4gICAgICAucmVwbGFjZSgvXFxbKFteXFxdXFxuXSspXFxdXFwoKGh0dHBzPzpcXC9cXC9bXlxccyldKylcXCkvZywgJzxhIGhyZWY9XCIkMlwiIHRhcmdldD1cIl9ibGFua1wiIHJlbD1cIm5vb3BlbmVyXCI+JDE8L2E+JylcbiAgICAgIC5yZXBsYWNlKC8oXnxbXFxzKF0pKGh0dHBzPzpcXC9cXC9bXlxcczwpXSspL2csICckMTxhIGhyZWY9XCIkMlwiIHRhcmdldD1cIl9ibGFua1wiIHJlbD1cIm5vb3BlbmVyXCI+JDI8L2E+Jyk7XG4gICAgbGV0IGh0bWwgPSBcIlwiO1xuICAgIGxldCBsaXN0OiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICBmb3IgKGNvbnN0IHJhdyBvZiBibG9jay5zcGxpdChcIlxcblwiKSkge1xuICAgICAgY29uc3QgaXRlbSA9IHJhdy5tYXRjaCgvXlxccyooPzpbLSpcdTIwMjJdfChcXGQrKVsuKV0pXFxzKyguKikkLyk7XG4gICAgICBpZiAoaXRlbSkge1xuICAgICAgICBjb25zdCBraW5kID0gaXRlbVsxXSA/IFwib2xcIiA6IFwidWxcIjtcbiAgICAgICAgaWYgKGxpc3QgIT09IGtpbmQpIHsgaWYgKGxpc3QpIGh0bWwgKz0gYDwvJHtsaXN0fT5gOyBodG1sICs9IGA8JHtraW5kfT5gOyBsaXN0ID0ga2luZDsgfVxuICAgICAgICBodG1sICs9IGA8bGk+JHtpbmxpbmUoaXRlbVsyXSl9PC9saT5gO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGlmIChsaXN0KSB7IGh0bWwgKz0gYDwvJHtsaXN0fT5gOyBsaXN0ID0gbnVsbDsgfVxuICAgICAgY29uc3QgaGVhZGluZyA9IHJhdy5tYXRjaCgvXiN7MSw2fVxccysoLiopJC8pO1xuICAgICAgaHRtbCArPSBoZWFkaW5nID8gYDxkaXYgY2xhc3M9XCJtZC1oXCI+JHtpbmxpbmUoaGVhZGluZ1sxXSl9PC9kaXY+YCA6IHJhdy50cmltKCkgPT09IFwiXCIgPyBcIjxicj5cIiA6IGAke2lubGluZShyYXcpfTxicj5gO1xuICAgIH1cbiAgICBpZiAobGlzdCkgaHRtbCArPSBgPC8ke2xpc3R9PmA7XG4gICAgcmV0dXJuIGh0bWwucmVwbGFjZSgvKDxicj4pKyQvLCBcIlwiKTtcbiAgfSkuam9pbihcIlwiKTtcbn1cblxuY29uc3QgdHJhbnNjcmlwdFNjcm9sbCA9IG5ldyBBdXRvU2Nyb2xsZXIoJChcInRyYW5zY3JpcHRcIiksIHtcbiAgb25KdW1wQ2hhbmdlOiAoc2hvdykgPT4geyAkKFwianVtcGJvdHRvbVwiKS5oaWRkZW4gPSAhc2hvdzsgfSxcbiAgaXNFbXB0eTogKCkgPT4gISQoXCJlbXB0eVwiKS5oaWRkZW4sXG59KTtcblxuZnVuY3Rpb24gc2Nyb2xsRG93bihmb3JjZSA9IGZhbHNlKSB7XG4gIHRyYW5zY3JpcHRTY3JvbGwub25Db250ZW50KGZvcmNlKTtcbn1cblxuLyoqIFRoZSBjb3JlJ3MgbnVtYmVyIGZvciB0aGUgbGluZSB0aGUgbGFzdCByb3cgc2hvd3MsIHVudGlsIGFub3RoZXIgcm93IGZvbGxvd3MgaXQuICovXG5sZXQgb3BlbkxpbmU6IG51bWJlciB8IG51bGwgPSBudWxsO1xuXG4vKiogV29yZHMgZ28gb24gdGhlIHJvdyB0aGUgY29yZSBzYXlzIHRoZXkgYmVsb25nIHRvOiBpdCBzdGFydHMgYSBuZXcgbGluZSBmb3IgZWFjaCB0dXJuLCBob3dldmVyIGxvbmcgdGhlIGdhcC4gKi9cbmZ1bmN0aW9uIHRyYW5zY3JpcHQocm9sZTogXCJ1c2VyXCIgfCBcImFzc2lzdGFudFwiLCB0ZXh0OiBzdHJpbmcsIGxpbmU6IG51bWJlcikge1xuICAkKFwiZW1wdHlcIikuaGlkZGVuID0gdHJ1ZTtcbiAgY29uc3QgcGFuZSA9ICQoXCJ0cmFuc2NyaXB0XCIpO1xuICBjb25zdCBsYXN0ID0gcGFuZS5sYXN0RWxlbWVudENoaWxkIGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgaWYgKG9wZW5MaW5lID09PSBsaW5lICYmIGxhc3QgJiYgbGFzdC5kYXRhc2V0LnJvbGUgPT09IHJvbGUpIGxhc3QucXVlcnlTZWxlY3RvcihcIi50ZXh0XCIpIS50ZXh0Q29udGVudCArPSB0ZXh0O1xuICBlbHNlIHtcbiAgICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIHJvdy5jbGFzc05hbWUgPSBgbGluZSAke3JvbGV9YDtcbiAgICByb3cuZGF0YXNldC5yb2xlID0gcm9sZTtcbiAgICByb3cuaW5uZXJIVE1MID0gYDxzcGFuIGNsYXNzPVwid2hvXCI+JHtyb2xlID09PSBcInVzZXJcIiA/IFwiWW91XCIgOiBcIkdlbWluaVwifTwvc3Bhbj48c3BhbiBjbGFzcz1cInRleHRcIj48L3NwYW4+YDtcbiAgICByb3cucXVlcnlTZWxlY3RvcihcIi50ZXh0XCIpIS50ZXh0Q29udGVudCA9IHRleHQudHJpbVN0YXJ0KCk7XG4gICAgcGFuZS5hcHBlbmQocm93KTtcbiAgICBvcGVuTGluZSA9IGxpbmU7XG4gIH1cbiAgc2Nyb2xsRG93bigpO1xufVxuXG4vKipcbiAqIFRoZSB3b3JkcyB0aGUgdXNlciBpcyBzYXlpbmcsIGJlZm9yZSB0aGUgbW9kZWwgaGFzIHRyYW5zY3JpYmVkIHRoZW06IGEgZmFpbnQgcm93IHRoYXQgc3RheXMgbGFzdFxuICogb24gc2NyZWVuIChpdHMgQ1NTIGBvcmRlcmApIGFuZCBmaXJzdCBpbiB0aGUgcGFuZSwgc28gdGhlIGxpbmVzIGFmdGVyIGl0IGpvaW4gdXAgYXMgYmVmb3JlLlxuICovXG5mdW5jdGlvbiBjYXB0aW9uKHRleHQ6IHN0cmluZyB8IG51bGwpIHtcbiAgY29uc3QgcGFuZSA9ICQoXCJ0cmFuc2NyaXB0XCIpO1xuICBsZXQgcm93ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJjYXB0aW9uXCIpO1xuICBpZiAodGV4dCA9PSBudWxsKSB7IHJvdz8ucmVtb3ZlKCk7IHNjcm9sbERvd24oKTsgcmV0dXJuOyB9XG4gICQoXCJlbXB0eVwiKS5oaWRkZW4gPSB0cnVlO1xuICBpZiAoIXJvdykge1xuICAgIHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgcm93LmlkID0gXCJjYXB0aW9uXCI7XG4gICAgcm93LmNsYXNzTmFtZSA9IFwibGluZSB1c2VyIGNhcHRpb25cIjtcbiAgICByb3cuaW5uZXJIVE1MID0gYDxzcGFuIGNsYXNzPVwid2hvXCI+WW91PC9zcGFuPjxzcGFuIGNsYXNzPVwidGV4dFwiPjwvc3Bhbj5gO1xuICAgIHBhbmUucHJlcGVuZChyb3cpO1xuICB9XG4gIHJvdy5xdWVyeVNlbGVjdG9yKFwiLnRleHRcIikhLnRleHRDb250ZW50ID0gdGV4dDtcbiAgc2Nyb2xsRG93bigpO1xufVxuXG5mdW5jdGlvbiBub3RlKHRleHQ6IHN0cmluZykge1xuICAkKFwiZW1wdHlcIikuaGlkZGVuID0gdHJ1ZTtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IFwibGluZSBub3RlXCI7XG4gIHJvdy50ZXh0Q29udGVudCA9IHRleHQ7XG4gICQoXCJ0cmFuc2NyaXB0XCIpLmFwcGVuZChyb3cpO1xuICBvcGVuTGluZSA9IG51bGw7XG4gIHNjcm9sbERvd24oKTtcbn1cblxuZnVuY3Rpb24gcmVzdWx0KGFnZW50OiBzdHJpbmcsIGxhYmVsOiBzdHJpbmcsIHRleHQ6IHN0cmluZywgZmFpbGVkID0gZmFsc2UpOiBIVE1MRWxlbWVudCB7XG4gICQoXCJlbXB0eVwiKS5oaWRkZW4gPSB0cnVlO1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gYGxpbmUgcmVzdWx0ICR7YWdlbnQgPT09IFwidDNcIiA/IFwidDNcIiA6IFwiXCJ9ICR7ZmFpbGVkID8gXCJmYWlsZWRcIiA6IFwiXCJ9YC50cmltKCk7XG4gIGNvbnN0IHdobyA9IGFnZW50ID09PSBcInQzXCIgPyBcIlQzXCIgOiBcIkhlcm1lc1wiO1xuICByb3cuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9XCJ3aG9cIj48c3BhbiBjbGFzcz1cInJlcy10aXRsZVwiPjxzcGFuIGNsYXNzPVwiYmFkZ2UgJHthZ2VudCA9PT0gXCJ0M1wiID8gXCJ0M1wiIDogXCJcIn1cIj4ke3dob308L3NwYW4+PHNwYW4gY2xhc3M9XCJyZXMtbGFiZWxcIj4ke2VzY2FwZUh0bWwobGFiZWwpfTwvc3Bhbj48L3NwYW4+PHNwYW4gY2xhc3M9XCJyZXMtcGlsbFwiPiR7ZmFpbGVkID8gXCJGYWlsZWRcIiA6IFwiUmVzdWx0XCJ9PC9zcGFuPjwvZGl2PjxkaXYgY2xhc3M9XCJib2R5XCI+JHttYXJrZG93bih0ZXh0KX08L2Rpdj5gO1xuICAkKFwidHJhbnNjcmlwdFwiKS5hcHBlbmQocm93KTtcbiAgb3BlbkxpbmUgPSBudWxsO1xuICBjb25zdCBib2R5ID0gcm93LnF1ZXJ5U2VsZWN0b3IoXCIuYm9keVwiKSBhcyBIVE1MRWxlbWVudDtcbiAgcmVxdWVzdEFuaW1hdGlvbkZyYW1lKCgpID0+IHtcbiAgICBpZiAoYm9keS5zY3JvbGxIZWlnaHQgPiBib2R5LmNsaWVudEhlaWdodCArIDQpIHtcbiAgICAgIHJvdy5jbGFzc0xpc3QuYWRkKFwiY2xhbXBlZFwiKTtcbiAgICAgIGNvbnN0IG1vcmUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICAgICAgbW9yZS5jbGFzc05hbWUgPSBcIm1vcmVcIjtcbiAgICAgIG1vcmUudHlwZSA9IFwiYnV0dG9uXCI7XG4gICAgICBtb3JlLnRleHRDb250ZW50ID0gXCJTaG93IGZ1bGwgcmVzdWx0XCI7XG4gICAgICBtb3JlLm9uY2xpY2sgPSAoKSA9PiB7XG4gICAgICAgIHJvdy5jbGFzc0xpc3QudG9nZ2xlKFwib3BlblwiKTtcbiAgICAgICAgbW9yZS50ZXh0Q29udGVudCA9IHJvdy5jbGFzc0xpc3QuY29udGFpbnMoXCJvcGVuXCIpID8gXCJTaG93IGxlc3NcIiA6IFwiU2hvdyBmdWxsIHJlc3VsdFwiO1xuICAgICAgICB0cmFuc2NyaXB0U2Nyb2xsLnN5bmNGcm9tUG9zaXRpb24oKTtcbiAgICAgIH07XG4gICAgICByb3cuYXBwZW5kKG1vcmUpO1xuICAgICAgc2Nyb2xsRG93bigpO1xuICAgIH1cbiAgfSk7XG4gIHNjcm9sbERvd24oKTtcbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gZWxhcHNlZChzZWNvbmRzOiBudW1iZXIpOiBzdHJpbmcge1xuICBpZiAoc2Vjb25kcyA8IDYwKSByZXR1cm4gYCR7TWF0aC5mbG9vcihzZWNvbmRzKX1zYDtcbiAgY29uc3QgbSA9IE1hdGguZmxvb3Ioc2Vjb25kcyAvIDYwKTtcbiAgcmV0dXJuIG0gPCA2MCA/IGAke219bSAke01hdGguZmxvb3Ioc2Vjb25kcyAlIDYwKX1zYCA6IGAke01hdGguZmxvb3IobSAvIDYwKX1oICR7bSAlIDYwfW1gO1xufVxuXG4vKiogVGhlIGVtcHR5IHRhc2sgbGlzdCdzIHdvcmRzLCBrZXB0IHRvIHB1dCBiYWNrLiAqL1xuY29uc3Qgbm9UYXNrcyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwibm90YXNrc1wiKSE7XG5cbi8qKiBXaGV0aGVyIGEgdGFzayBzdGlsbCB3YW50cyB0aGUgc2NyZWVuOiBpdCdzIHdvcmtpbmcsIG9yIGl0IHdhaXRzIGZvciB0aGUgdXNlci4gVGhlIHJlc3QgZm9sZCBhd2F5IHVuZGVyIEZpbmlzaGVkLiAqL1xuY29uc3QgbGl2ZSA9IChzdGF0ZTogc3RyaW5nKSA9PiBzdGF0ZSA9PT0gXCJydW5uaW5nXCIgfHwgc3RhdGUuc3RhcnRzV2l0aChcIndhaXRpbmdcIik7XG5cbmZ1bmN0aW9uIHVwZGF0ZVRhc2tDaHJvbWUoKSB7XG4gIGNvbnN0IGFsbCA9IFsuLi50YXNrcy52YWx1ZXMoKV07XG4gIGNvbnN0IGFjdGl2ZUN1cnJlbnQgPSBhbGwuZmlsdGVyKCh0KSA9PiBsaXZlKHQuYy5zdGF0ZSkgfHwgQm9vbGVhbih0LmFwcHJvdmFsKSkubGVuZ3RoO1xuICBjb25zdCB3YWl0aW5nID0gYWxsLmZpbHRlcigodCkgPT4gdC5jLnN0YXRlLnN0YXJ0c1dpdGgoXCJ3YWl0aW5nXCIpIHx8IEJvb2xlYW4odC5hcHByb3ZhbCkpLmxlbmd0aDtcbiAgY29uc3QgYWN0aXZlVG90YWwgPSBhY3RpdmVDdXJyZW50ICsgZWFybGllckFjdGl2ZUNvdW50O1xuICBjb25zdCBhdHRlbnRpb25Ub3RhbCA9IHdhaXRpbmcgKyBlYXJsaWVyV2FpdGluZ0NvdW50O1xuXG4gIGNvbnN0IGJhZGdlID0gJChcInRhc2tzLWJhZGdlXCIpO1xuICBiYWRnZS5oaWRkZW4gPSBhY3RpdmVUb3RhbCA9PT0gMDtcbiAgYmFkZ2UudGV4dENvbnRlbnQgPSBTdHJpbmcoYWN0aXZlVG90YWwpO1xuICBiYWRnZS5jbGFzc0xpc3QudG9nZ2xlKFwid2FyblwiLCBhdHRlbnRpb25Ub3RhbCA+IDApO1xuXG4gIGNvbnN0IGJhciA9ICQoXCJtb2JpbGUtdGFza3MtYmFyXCIpO1xuICBjb25zdCBzaG93QmFyID0gYWN0aXZlVG90YWwgPiAwO1xuICBiYXIuaGlkZGVuID0gIXNob3dCYXI7XG4gIGJhci5jbGFzc0xpc3QudG9nZ2xlKFwidmlzaWJsZVwiLCBzaG93QmFyKTtcbiAgYmFyLmNsYXNzTGlzdC50b2dnbGUoXCJ3YXJuXCIsIGF0dGVudGlvblRvdGFsID4gMCk7XG4gIGlmIChzaG93QmFyKSB7XG4gICAgY29uc3QgYXBwcm92YWwgPSBhbGwuZmluZCgodCkgPT4gdC5hcHByb3ZhbCk7XG4gICAgY29uc3QgbGFiZWwgPSBhcHByb3ZhbFxuICAgICAgPyBgQXBwcm92YWwgbmVlZGVkOiAke2FwcHJvdmFsLmMubGFiZWx9YFxuICAgICAgOiBhdHRlbnRpb25Ub3RhbCA+IDBcbiAgICAgICAgPyBgJHthdHRlbnRpb25Ub3RhbH0gdGFzayR7YXR0ZW50aW9uVG90YWwgPiAxID8gXCJzXCIgOiBcIlwifSB3YWl0aW5nIGZvciB5b3VgXG4gICAgICAgIDogYCR7YWN0aXZlVG90YWx9IGFjdGl2ZSB0YXNrJHthY3RpdmVUb3RhbCA+IDEgPyBcInNcIiA6IFwiXCJ9YDtcbiAgICAkKFwibXRiLXRleHRcIikudGV4dENvbnRlbnQgPSBsYWJlbDtcbiAgfVxufVxuXG4vKiogVGhlIEZpbmlzaGVkIGZvbGQncyBjb3VudCwgYW5kIHRoZSBmb2xkIGl0c2VsZiBvbmx5IHdoZW4gc29tZXRoaW5nIGlzIGluIGl0LiAqL1xuZnVuY3Rpb24gc2hvd0RvbmUoKSB7XG4gIGNvbnN0IG4gPSAkKFwiZG9uZW5vd1wiKS5jaGlsZEVsZW1lbnRDb3VudCArICQoXCJkb25lZWFybGllclwiKS5jaGlsZEVsZW1lbnRDb3VudDtcbiAgJChcImRvbmVib3hcIikuaGlkZGVuID0gbiA9PT0gMDtcbiAgJChcImRvbmVjb3VudFwiKS50ZXh0Q29udGVudCA9IG4gPiAwID8gYFx1MDBCNyAke259YCA6IFwiXCI7XG59XG5cbmZ1bmN0aW9uIHNob3dUYXNrcyhmb3JjZSA9IGZhbHNlKSB7XG4gIGNvbnN0IHBhbmUgPSAkKFwidGFza3NcIik7XG4gIGNvbnN0IGRvbmUgPSAkKFwiZG9uZW5vd1wiKTtcbiAgY29uc3Qgb3BlbiA9IGRvY3VtZW50LmFjdGl2ZUVsZW1lbnQ/LmNsb3Nlc3Q/LihcIi50YXNrXCIpIGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgaWYgKCFmb3JjZSAmJiBvcGVuICYmIChwYW5lLmNvbnRhaW5zKG9wZW4pIHx8IGRvbmUuY29udGFpbnMob3BlbikpICYmIG9wZW4ucXVlcnlTZWxlY3RvcihcImZvcm1cIikpIHJldHVybjsgLy8gZG9uJ3QgcmVkcmF3IHVuZGVyIHNvbWVvbmUgdHlwaW5nIGEgZm9sbG93LXVwXG4gIHBhbmUuaW5uZXJIVE1MID0gXCJcIjtcbiAgZG9uZS5pbm5lckhUTUwgPSBcIlwiO1xuICBjb25zdCBhbGwgPSBbLi4udGFza3MudmFsdWVzKCldLnJldmVyc2UoKTtcbiAgaWYgKGFsbC5sZW5ndGggPT09IDApIHtcbiAgICBwYW5lLmFwcGVuZChub1Rhc2tzKTtcbiAgICAkKFwidGFza2NvdW50XCIpLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAkKFwiY2FuY2VsYWxsXCIpLmhpZGRlbiA9IHRydWU7XG4gICAgc2hvd0RvbmUoKTtcbiAgICB1cGRhdGVUYXNrQ2hyb21lKCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHJ1bm5pbmcgPSBhbGwuZmlsdGVyKCh0KSA9PiB0LmMuc3RhdGUgPT09IFwicnVubmluZ1wiKS5sZW5ndGg7XG4gIGNvbnN0IGFjdGl2ZUNvdW50ID0gYWxsLmZpbHRlcigodCkgPT4gbGl2ZSh0LmMuc3RhdGUpKS5sZW5ndGg7XG4gICQoXCJ0YXNrY291bnRcIikudGV4dENvbnRlbnQgPSBydW5uaW5nID4gMCA/IGAke3J1bm5pbmd9IHJ1bm5pbmdgIDogYWN0aXZlQ291bnQgPiAwID8gYCR7YWN0aXZlQ291bnR9IHdhaXRpbmdgIDogXCJcIjtcbiAgJChcImNhbmNlbGFsbFwiKS5oaWRkZW4gPSAhY2FsbElkIHx8IHJ1bm5pbmcgPCAyO1xuICBmb3IgKGNvbnN0IHZpZXcgb2YgYWxsKSB7XG4gICAgY29uc3QgdCA9IHZpZXcuYztcbiAgICBjb25zdCB3YWl0aW5nID0gdC5zdGF0ZS5zdGFydHNXaXRoKFwid2FpdGluZ1wiKTtcbiAgICBjb25zdCBjYXJkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBjYXJkLmNsYXNzTmFtZSA9IGB0YXNrICR7d2FpdGluZyA/IFwid2FpdGluZ1wiIDogdC5zdGF0ZX1gO1xuICAgIGNvbnN0IGFnZSA9ICh2aWV3LmVuZGVkID8/IG5vdygpKSAtIHZpZXcuc2luY2U7XG4gICAgY2FyZC5pbm5lckhUTUwgPVxuICAgICAgYDxkaXYgY2xhc3M9XCJtZXRhLXJvd1wiPmAgK1xuICAgICAgICBgPHNwYW4gY2xhc3M9XCJiYWRnZSAke3QuYWdlbnQgPT09IFwidDNcIiA/IFwidDNcIiA6IFwiXCJ9XCI+JHt0LmFnZW50ID09PSBcInQzXCIgPyBcIlQzXCIgOiBcIkhlcm1lc1wifTwvc3Bhbj5gICtcbiAgICAgICAgYDxzcGFuIGNsYXNzPVwic3RhdGVcIj4ke3Quc3RhdGUgPT09IFwicnVubmluZ1wiID8gJzxzcGFuIGNsYXNzPVwic3BpblwiPjwvc3Bhbj4nIDogXCJcIn0ke2VzY2FwZUh0bWwodC5zdGF0ZSl9PC9zcGFuPmAgK1xuICAgICAgICBgPHNwYW4gY2xhc3M9XCJhZ2VcIj4ke2VsYXBzZWQoYWdlKX08L3NwYW4+YCArXG4gICAgICBgPC9kaXY+YCArXG4gICAgICBgPGRpdiBjbGFzcz1cImxhYmVsXCI+PC9kaXY+YCArXG4gICAgICBgPGRpdiBjbGFzcz1cInBcIj48L2Rpdj5gO1xuICAgIGNhcmQucXVlcnlTZWxlY3RvcihcIi5sYWJlbFwiKSEudGV4dENvbnRlbnQgPSB0LmxhYmVsO1xuICAgIGNhcmQucXVlcnlTZWxlY3RvcihcIi5wXCIpIS50ZXh0Q29udGVudCA9IHQucHJvZ3Jlc3MgPz8gdC5yZXF1ZXN0O1xuICAgIGlmICh0LnF1ZXN0aW9uKSB7XG4gICAgICBjb25zdCBxID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgIHEuY2xhc3NOYW1lID0gXCJxXCI7XG4gICAgICBxLnRleHRDb250ZW50ID0gYEFza3M6ICR7dC5xdWVzdGlvbn1gO1xuICAgICAgY2FyZC5hcHBlbmQocSk7XG4gICAgfVxuICAgIGlmICh2aWV3LmFwcHJvdmFsICYmIHQuc3RhdGUgPT09IFwicnVubmluZ1wiKSB7XG4gICAgICBjb25zdCBib3ggPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgICAgYm94LmNsYXNzTmFtZSA9IFwiYXBwcm92YWxcIjtcbiAgICAgIGJveC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz1cImFwcHJvdmFsLWhlYWRcIj5IZXJtZXMgYXNrcyB0byBydW48L2Rpdj48Y29kZT48L2NvZGU+PGRpdiBjbGFzcz1cImFjdHNcIj48L2Rpdj5gO1xuICAgICAgYm94LnF1ZXJ5U2VsZWN0b3IoXCJjb2RlXCIpIS50ZXh0Q29udGVudCA9IHZpZXcuYXBwcm92YWwuY29tbWFuZDtcbiAgICAgIGNvbnN0IGFuc3dlciA9IChjaG9pY2U6IFwib25jZVwiIHwgXCJkZW55XCIpID0+IHtcbiAgICAgICAgdmlldy5hcHByb3ZhbCA9IHVuZGVmaW5lZDtcbiAgICAgICAgc2hvd1Rhc2tzKHRydWUpO1xuICAgICAgICB2b2lkIGZldGNoKFwiL2hlcm1lcy9hcHByb3ZhbFwiLCB7IG1ldGhvZDogXCJQT1NUXCIsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgY2FsbDogY2FsbE5hbWUsIHRhc2tJZDogdC5pZCwgY2hvaWNlIH0pIH0pXG4gICAgICAgICAgLnRoZW4oKHIpID0+IHRvYXN0KHIub2sgPyAoY2hvaWNlID09PSBcIm9uY2VcIiA/IFwiQXBwcm92ZWRcIiA6IFwiRGVuaWVkXCIpIDogXCJUaGF0IGFwcHJvdmFsIGhhZCBhbHJlYWR5IGxhcHNlZFwiKSk7XG4gICAgICB9O1xuICAgICAgZm9yIChjb25zdCBbbGFiZWwsIGNob2ljZV0gb2YgW1tcIkFwcHJvdmUgb25jZVwiLCBcIm9uY2VcIl0sIFtcIkRlbnlcIiwgXCJkZW55XCJdXSBhcyBjb25zdCkge1xuICAgICAgICBjb25zdCBiID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgICAgICAgYi50eXBlID0gXCJidXR0b25cIjtcbiAgICAgICAgYi50ZXh0Q29udGVudCA9IGxhYmVsO1xuICAgICAgICBpZiAoY2hvaWNlID09PSBcIm9uY2VcIikgYi5jbGFzc05hbWUgPSBcImdvXCI7XG4gICAgICAgIGVsc2UgYi5jbGFzc05hbWUgPSBcImRhbmdlclwiO1xuICAgICAgICBiLm9uY2xpY2sgPSAoKSA9PiBhbnN3ZXIoY2hvaWNlKTtcbiAgICAgICAgYm94LnF1ZXJ5U2VsZWN0b3IoXCIuYWN0c1wiKSEuYXBwZW5kKGIpO1xuICAgICAgfVxuICAgICAgY2FyZC5hcHBlbmQoYm94KTtcbiAgICB9XG4gICAgaWYgKHQuc3RhdGUgIT09IFwicnVubmluZ1wiKSB2aWV3LmFwcHJvdmFsID0gdW5kZWZpbmVkO1xuICAgIGNvbnN0IGFjdHMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGFjdHMuY2xhc3NOYW1lID0gXCJhY3RzXCI7XG4gICAgY29uc3QgYnV0dG9uID0gKHRleHQ6IHN0cmluZywgZm46ICgpID0+IHZvaWQsIGNscyA9IFwiXCIpID0+IHtcbiAgICAgIGNvbnN0IGIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICAgICAgYi50eXBlID0gXCJidXR0b25cIjtcbiAgICAgIGIudGV4dENvbnRlbnQgPSB0ZXh0O1xuICAgICAgaWYgKGNscykgYi5jbGFzc05hbWUgPSBjbHM7XG4gICAgICBiLm9uY2xpY2sgPSBmbjtcbiAgICAgIGFjdHMuYXBwZW5kKGIpO1xuICAgICAgcmV0dXJuIGI7XG4gICAgfTtcbiAgICBpZiAoY2FsbElkKSB7XG4gICAgICBidXR0b24od2FpdGluZyA/IFwiQW5zd2VyXCIgOiBcIkZvbGxvdyB1cFwiLCAoKSA9PiBmb2xsb3dVcEZvcm0oY2FyZCwgdCkpO1xuICAgICAgaWYgKHQuc3RhdGUgPT09IFwicnVubmluZ1wiKSBidXR0b24oXCJDYW5jZWxcIiwgKCkgPT4gcHVzaCh7IHR5cGU6IFwiY2FuY2VsVGFza1wiLCB0YXNrOiB0LmlkIH0pLCBcImRhbmdlclwiKTtcbiAgICB9XG4gICAgaWYgKHZpZXcucmVzdWx0KSBidXR0b24oXCJSZXN1bHRcIiwgKCkgPT4ge1xuICAgICAgc2V0VGFza3NPcGVuKGZhbHNlKTtcbiAgICAgIHZpZXcucmVzdWx0IS5jbGFzc0xpc3QuYWRkKFwib3BlblwiKTtcbiAgICAgIGlmICh2aWV3LnJlc3VsdCAhPT0gJChcInRyYW5zY3JpcHRcIikubGFzdEVsZW1lbnRDaGlsZCkgdHJhbnNjcmlwdFNjcm9sbC51bnBpbigpO1xuICAgICAgZWxzZSB0cmFuc2NyaXB0U2Nyb2xsLnN5bmNGcm9tUG9zaXRpb24oKTtcbiAgICAgIHZpZXcucmVzdWx0IS5zY3JvbGxJbnRvVmlldyh7IGJlaGF2aW9yOiBcInNtb290aFwiLCBibG9jazogXCJjZW50ZXJcIiB9KTtcbiAgICB9KTtcbiAgICBpZiAodmlldy50aHJlYWQpIGJ1dHRvbihcIkNvcHkgdGhyZWFkIGlkXCIsICgpID0+IHsgdm9pZCBuYXZpZ2F0b3IuY2xpcGJvYXJkPy53cml0ZVRleHQodmlldy50aHJlYWQhKTsgdG9hc3QoXCJUaHJlYWQgaWQgY29waWVkXCIpOyB9KTtcbiAgICBpZiAoYWN0cy5jaGlsZEVsZW1lbnRDb3VudCkgY2FyZC5hcHBlbmQoYWN0cyk7XG4gICAgKGxpdmUodC5zdGF0ZSkgPyBwYW5lIDogZG9uZSkuYXBwZW5kKGNhcmQpO1xuICB9XG4gIGlmIChwYW5lLmNoaWxkRWxlbWVudENvdW50ID09PSAwKSBwYW5lLmFwcGVuZChub1Rhc2tzKTtcbiAgc2hvd0RvbmUoKTtcbiAgdXBkYXRlVGFza0Nocm9tZSgpO1xufVxuXG5mdW5jdGlvbiBmb2xsb3dVcEZvcm0oY2FyZDogSFRNTEVsZW1lbnQsIHQ6IENvbW1hbmQpIHtcbiAgaWYgKGNhcmQucXVlcnlTZWxlY3RvcihcImZvcm1cIikpIHJldHVybjtcbiAgY29uc3QgZm9ybSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJmb3JtXCIpO1xuICBmb3JtLmlubmVySFRNTCA9IGA8aW5wdXQgdHlwZT1cInRleHRcIiBwbGFjZWhvbGRlcj1cIlRlbGwgXHUyMDFDJHtlc2NhcGVIdG1sKHQubGFiZWwpfVx1MjAxRFx1MjAyNlwiIGVudGVya2V5aGludD1cInNlbmRcIj48YnV0dG9uIHR5cGU9XCJzdWJtaXRcIj5TZW5kPC9idXR0b24+YDtcbiAgY29uc3QgaW5wdXQgPSBmb3JtLnF1ZXJ5U2VsZWN0b3IoXCJpbnB1dFwiKSE7XG4gIGZvcm0ub25zdWJtaXQgPSAoZSkgPT4ge1xuICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICBjb25zdCB0ZXh0ID0gaW5wdXQudmFsdWUudHJpbSgpO1xuICAgIGlmICh0ZXh0KSB7IHB1c2goeyB0eXBlOiBcInN0ZWVyXCIsIHRhc2s6IHQuaWQsIHRleHQgfSk7IG5vdGUoYFlvdSBcdTIxOTIgJHt0LmxhYmVsfTogJHt0ZXh0fWApOyBzY3JvbGxEb3duKHRydWUpOyB9XG4gICAgaW5wdXQuYmx1cigpO1xuICAgIGZvcm0ucmVtb3ZlKCk7XG4gICAgc2hvd1Rhc2tzKCk7XG4gIH07XG4gIGlucHV0Lm9ua2V5ZG93biA9IChlKSA9PiB7IGlmIChlLmtleSA9PT0gXCJFc2NhcGVcIikgeyBpbnB1dC5ibHVyKCk7IGZvcm0ucmVtb3ZlKCk7IHNob3dUYXNrcygpOyB9IH07XG4gIGNhcmQuYXBwZW5kKGZvcm0pO1xuICBpbnB1dC5mb2N1cygpO1xufVxuXG4vKiogVDMgdGhyZWFkcyBlYXJsaWVyIGNhbGxzIHN0YXJ0ZWQ6IHRoZXkgY2Fycnkgb24gYWZ0ZXIgYSBjYWxsLCBzbyB0aGUgcGFuZWwgc2F5cyBob3cgdGhleSdyZSBkb2luZy4gKi9cbmFzeW5jIGZ1bmN0aW9uIHNob3dFYXJsaWVyKCkge1xuICBsZXQgbGlzdDogeyB0aHJlYWQ6IHN0cmluZzsgdGl0bGU6IHN0cmluZzsgc3RhdHVzOiBzdHJpbmc7IGJyYW5jaDogc3RyaW5nIHwgbnVsbDsgcHI6IHN0cmluZyB8IG51bGw7IHVwZGF0ZWQ6IHN0cmluZzsgbGFzdDogc3RyaW5nOyB3YWl0aW5nOiBib29sZWFuIH1bXSA9IFtdO1xuICB0cnkgeyBsaXN0ID0gYXdhaXQgKGF3YWl0IGZldGNoKFwiL2FnZW50L3JlY2VudFwiLCB7IGNhY2hlOiBcIm5vLXN0b3JlXCIgfSkpLmpzb24oKTsgfSBjYXRjaCB7fVxuICBjb25zdCBjdXJyZW50ID0gbmV3IFNldChbLi4udGFza3MudmFsdWVzKCldLm1hcCgodikgPT4gdi50aHJlYWQpLmZpbHRlcihCb29sZWFuKSk7XG4gIGxpc3QgPSBsaXN0LmZpbHRlcigodCkgPT4gIWN1cnJlbnQuaGFzKHQudGhyZWFkKSk7XG4gIGNvbnN0IHBhbmUgPSAkKFwiZWFybGllclwiKTtcbiAgY29uc3QgZG9uZSA9ICQoXCJkb25lZWFybGllclwiKTtcbiAgcGFuZS5pbm5lckhUTUwgPSBcIlwiO1xuICBkb25lLmlubmVySFRNTCA9IFwiXCI7XG4gIGVhcmxpZXJBY3RpdmVDb3VudCA9IDA7XG4gIGVhcmxpZXJXYWl0aW5nQ291bnQgPSAwO1xuICBmb3IgKGNvbnN0IHQgb2YgbGlzdCkge1xuICAgIGNvbnN0IGNhcmQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGNvbnN0IHN0YXRlID0gdC53YWl0aW5nID8gXCJ3YWl0aW5nIGZvciBhcHByb3ZhbCBpbiBUM1wiIDogdC5zdGF0dXM7XG4gICAgY2FyZC5jbGFzc05hbWUgPSBgdGFzayAke3Quc3RhdHVzID09PSBcInJ1bm5pbmdcIiA/IFwicnVubmluZ1wiIDogdC53YWl0aW5nID8gXCJ3YWl0aW5nXCIgOiBcImZpbmlzaGVkXCJ9YDtcbiAgICBjb25zdCBhZ28gPSBNYXRoLm1heCgwLCAoRGF0ZS5ub3coKSAtIERhdGUucGFyc2UodC51cGRhdGVkKSkgLyAxMDAwKTtcbiAgICBjYXJkLmlubmVySFRNTCA9XG4gICAgICBgPGRpdiBjbGFzcz1cIm1ldGEtcm93XCI+YCArXG4gICAgICAgIGA8c3BhbiBjbGFzcz1cImJhZGdlIHQzXCI+VDM8L3NwYW4+YCArXG4gICAgICAgIGA8c3BhbiBjbGFzcz1cInN0YXRlXCI+JHt0LnN0YXR1cyA9PT0gXCJydW5uaW5nXCIgPyAnPHNwYW4gY2xhc3M9XCJzcGluXCI+PC9zcGFuPicgOiBcIlwifSR7ZXNjYXBlSHRtbChzdGF0ZSl9PC9zcGFuPmAgK1xuICAgICAgICBgPHNwYW4gY2xhc3M9XCJhZ2VcIj4ke2VsYXBzZWQoYWdvKX0gYWdvPC9zcGFuPmAgK1xuICAgICAgYDwvZGl2PmAgK1xuICAgICAgYDxkaXYgY2xhc3M9XCJsYWJlbFwiPjwvZGl2PmAgK1xuICAgICAgYDxkaXYgY2xhc3M9XCJwXCI+PC9kaXY+YDtcbiAgICBjYXJkLnF1ZXJ5U2VsZWN0b3IoXCIubGFiZWxcIikhLnRleHRDb250ZW50ID0gdC50aXRsZTtcbiAgICBjYXJkLnF1ZXJ5U2VsZWN0b3IoXCIucFwiKSEudGV4dENvbnRlbnQgPSB0Lmxhc3QgfHwgKHQuYnJhbmNoID8gYE9uICR7dC5icmFuY2h9YCA6IFwiXCIpO1xuICAgIGNvbnN0IGFjdHMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGFjdHMuY2xhc3NOYW1lID0gXCJhY3RzXCI7XG4gICAgaWYgKHQucHIpIHsgY29uc3QgYSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJhXCIpOyBhLmhyZWYgPSB0LnByOyBhLnRhcmdldCA9IFwiX2JsYW5rXCI7IGEucmVsID0gXCJub29wZW5lclwiOyBhLnRleHRDb250ZW50ID0gXCJQdWxsIHJlcXVlc3QgXHUyMTk3XCI7IGFjdHMuYXBwZW5kKGEpOyB9XG4gICAgY29uc3QgY29weSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gICAgY29weS50eXBlID0gXCJidXR0b25cIjtcbiAgICBjb3B5LnRleHRDb250ZW50ID0gXCJDb3B5IHRocmVhZCBpZFwiO1xuICAgIGNvcHkub25jbGljayA9ICgpID0+IHsgdm9pZCBuYXZpZ2F0b3IuY2xpcGJvYXJkPy53cml0ZVRleHQodC50aHJlYWQpOyB0b2FzdChcIlRocmVhZCBpZCBjb3BpZWRcIik7IH07XG4gICAgYWN0cy5hcHBlbmQoY29weSk7XG4gICAgY2FyZC5hcHBlbmQoYWN0cyk7XG4gICAgY29uc3QgYWN0aXZlID0gdC5zdGF0dXMgPT09IFwicnVubmluZ1wiIHx8IHQud2FpdGluZztcbiAgICBpZiAoYWN0aXZlKSBlYXJsaWVyQWN0aXZlQ291bnQrKztcbiAgICBpZiAodC53YWl0aW5nKSBlYXJsaWVyV2FpdGluZ0NvdW50Kys7XG4gICAgKGFjdGl2ZSA/IHBhbmUgOiBkb25lKS5hcHBlbmQoY2FyZCk7XG4gIH1cbiAgJChcImVhcmxpZXJib3hcIikuaGlkZGVuID0gcGFuZS5jaGlsZEVsZW1lbnRDb3VudCA9PT0gMDtcbiAgc2hvd0RvbmUoKTtcbiAgdXBkYXRlVGFza0Nocm9tZSgpO1xufVxuXG5jb25zdCBTVEFUVVNfVEVYVDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgaWRsZTogXCJJZGxlXCIsIGNvbm5lY3Rpbmc6IFwiQ29ubmVjdGluZ1x1MjAyNlwiLCBsaXN0ZW5pbmc6IFwiTGlzdGVuaW5nXCIsIHdvcmtpbmc6IFwiTGlzdGVuaW5nIFx1MDBCNyB0YXNrcyBydW5uaW5nXCIsXG4gIHN0YW5kYnk6IFwiUGF1c2VkIHdoaWxlIHRhc2tzIHJ1biBcdTAwQjcgc3BlYWsgdG8gcmVzdW1lXCIsIHdha2luZzogXCJSZXN1bWluZ1x1MjAyNlwiLCBlbmRlZDogXCJFbmRlZFwiLFxufTtcblxuZnVuY3Rpb24gc2hvd1N0YXR1cyhtZXNzYWdlPzogc3RyaW5nKSB7XG4gIGNvbnN0IHR5cGVkID0gQm9vbGVhbihjYWxsSWQpICYmIG1lZGl1bSA9PT0gXCJ0ZXh0XCI7XG4gIGNvbnN0IHNwZWFraW5nID0gQm9vbGVhbihjYWxsSWQpICYmICF0eXBlZCAmJiBjb3JlU3RhdHVzICE9PSBcInN0YW5kYnlcIiAmJiBhdWRpby5xdWV1ZWQgPiAwLjA1O1xuICBjb25zdCBzaG93biA9IHNwZWFraW5nIHx8ICh0eXBlZCAmJiB0aGlua2luZykgPyBcInNwZWFraW5nXCIgOiBjb3JlU3RhdHVzO1xuICAkKFwic3RhdHVzXCIpLmNsYXNzTmFtZSA9IHNob3duO1xuICBkb2N1bWVudC5ib2R5LmRhdGFzZXQuc3RhdGUgPSBjYWxsSWQgPyBzaG93biA6IFwiaWRsZVwiO1xuICBkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC50b2dnbGUoXCJpbi1zZXNzaW9uXCIsIEJvb2xlYW4oY2FsbElkKSk7XG4gIGxldCB0ZXh0ID0gc3BlYWtpbmcgPyBcIlNwZWFraW5nXCIgOiBTVEFUVVNfVEVYVFtjb3JlU3RhdHVzXSA/PyBjb3JlU3RhdHVzO1xuICBpZiAodHlwZWQgJiYgY29yZVN0YXR1cyAhPT0gXCJlbmRlZFwiKSB0ZXh0ID0gdGhpbmtpbmcgPyBcIldyaXRpbmdcdTIwMjZcIiA6IGNvcmVTdGF0dXMgPT09IFwid29ya2luZ1wiID8gXCJDaGF0IFx1MDBCNyB0YXNrcyBydW5uaW5nXCIgOiBcIkNoYXRcIjtcbiAgaWYgKGNhbGxJZCAmJiAhdHlwZWQgJiYgbXV0ZWQgJiYgIWhvbGRpbmcgJiYgIXNwZWFraW5nKSB0ZXh0ICs9IFwiIFx1MDBCNyBtdXRlZFwiO1xuICBpZiAoaG9sZGluZykgdGV4dCA9IFwiVGFsa2luZyAoaG9sZClcIjtcbiAgaWYgKG1lc3NhZ2UpIHRleHQgPSBgJHt0ZXh0fTogJHttZXNzYWdlfWA7XG4gIGlmIChjb3JlU3RhdHVzICE9PSBcImVuZGVkXCIgfHwgbWVzc2FnZSkgJChcInN0YXR1c3RleHRcIikudGV4dENvbnRlbnQgPSB0ZXh0O1xuICAkPEhUTUxCdXR0b25FbGVtZW50PihcImh1c2hcIikuY2xhc3NMaXN0LnRvZ2dsZShcImxpdmVcIiwgc3BlYWtpbmcgfHwgKHR5cGVkICYmIHRoaW5raW5nKSk7XG5cbiAgY29uc3QgYmFyID0gJChcImNhbGxiYXJcIik7XG4gIGJhci5oaWRkZW4gPSAhY2FsbElkO1xuICBpZiAoY2FsbElkKSB7XG4gICAgJChcImNhbGxiYXItc3RhdGVcIikudGV4dENvbnRlbnQgPSB0ZXh0O1xuICAgICQoXCJjYWxsdGltZXJcIikuaGlkZGVuID0gdHlwZWQ7XG4gICAgaWYgKCF0eXBlZCkgJChcImNhbGx0aW1lclwiKS50ZXh0Q29udGVudCA9IGZvcm1hdENsb2NrKG5vdygpIC0gc3RhcnRlZEF0KTtcbiAgICBjb25zdCB2aXpNb2RlID0gdHlwZWQgPyAodGhpbmtpbmcgPyBcInRoaW5raW5nXCIgOiBcImlkbGVcIilcbiAgICAgIDogc3BlYWtpbmcgPyBcInNwZWFraW5nXCJcbiAgICAgIDogbXV0ZWQgJiYgIWhvbGRpbmcgPyBcIm11dGVkXCJcbiAgICAgIDogc2hvd247XG4gICAgdXBkYXRlVmlzdWFsaXplcih2aXpNb2RlLCBtdXRlZCAmJiAhaG9sZGluZyA/IDAgOiBhdWRpby5sZXZlbCk7XG4gIH1cbn1cblxuLy8gVGhlIGNhbGwuXG5cbmZ1bmN0aW9uIHB1c2goZXZlbnQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XG4gIGlmICghY29yZSB8fCAhY2FsbElkKSByZXR1cm47XG4gIGNvbnN0IGU6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0geyAuLi5ldmVudCwgdDogbm93KCkgfTtcbiAgY29uc3QgcXVpZXQgPSBlLnR5cGUgPT09IFwibWljXCIgfHwgZS50eXBlID09PSBcInRpY2tcIjtcbiAgaWYgKCFxdWlldCkgbG9nKFwiaW5cIiwgZS50eXBlID09PSBcIndzLm1lc3NhZ2VcIiA/IGB3cyAke2Uuc2lkfSBcdTIxOTAgJHticmllZihTdHJpbmcoZS5kYXRhKSl9YCA6IEpTT04uc3RyaW5naWZ5KGUpLnNsaWNlKDAsIDQwMCksIFwiaW5cIik7XG4gIHJ1bihKU09OLnBhcnNlKGNvcmUucHVzaChjYWxsSWQsIEpTT04uc3RyaW5naWZ5KGUpKSkpO1xufVxuXG5mdW5jdGlvbiBydW4oY29tbWFuZHM6IENvbW1hbmRbXSkge1xuICBmb3IgKGNvbnN0IGMgb2YgY29tbWFuZHMpIHtcbiAgICBzd2l0Y2ggKGMudHlwZSkge1xuICAgICAgY2FzZSBcIndzLmNvbm5lY3RcIjogY29ubmVjdChjLnNpZCwgYy5wdXJwb3NlID09PSBcImNhcHRpb25zXCIpOyBicmVhaztcbiAgICAgIGNhc2UgXCJ3cy5zZW5kXCI6IHtcbiAgICAgICAgc29ja2V0cy5nZXQoYy5zaWQpPy5zZW5kKGMuZGF0YSk7XG4gICAgICAgIGlmICghYy5kYXRhLnN0YXJ0c1dpdGgoJ3tcInJlYWx0aW1lSW5wdXRcIjp7XCJhdWRpb1wiJykpIGxvZyhcIm91dFwiLCBgd3MgJHtjLnNpZH0gXHUyMTkyICR7YnJpZWYoYy5kYXRhKX1gLCBcIm91dFwiKTtcbiAgICAgICAgZWxzZSBpZiAoIWNhcHRpb25Tb2NrZXRzLmhhcyhjLnNpZCkpIGNvdW50cy5zZW50Kys7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcIndzLmNsb3NlXCI6IHNvY2tldHMuZ2V0KGMuc2lkKT8uY2xvc2UoKTsgc29ja2V0cy5kZWxldGUoYy5zaWQpOyBsb2coXCJvdXRcIiwgYHdzICR7Yy5zaWR9IGNsb3NlYCwgXCJvdXRcIik7IGJyZWFrO1xuICAgICAgY2FzZSBcIm1pYy5zdGFydFwiOlxuICAgICAgY2FzZSBcIm1pYy5yZXN0YXJ0XCI6XG4gICAgICAgIGxvZyhcIm91dFwiLCBjLnR5cGUsIFwib3V0XCIpO1xuICAgICAgICB2b2lkIGF1ZGlvLnN0YXJ0TWljKG9uTWljLCBtaWNPcHRpb25zKCkpLmNhdGNoKChlcnIpID0+IHsgbG9nKFwiZXJyb3JcIiwgYG1pY3JvcGhvbmU6ICR7ZXJyLm1lc3NhZ2V9YCwgXCJlcnJcIik7IHRvYXN0KGBNaWNyb3Bob25lOiAke2Vyci5tZXNzYWdlfWApOyB9KTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwibWljLnN0b3BcIjogYXVkaW8uc3RvcE1pYygpOyBicmVhaztcbiAgICAgIGNhc2UgXCJwbGF5XCI6IHtcbiAgICAgICAgY29uc3QgdCA9IG5vdygpO1xuICAgICAgICAvLyBBIHJlcGx5IHN0YXJ0aW5nOiBmcm9tIHRoZSBlbmQgb2YgdGhlIHVzZXIncyBzcGVlY2ggdG8gaXRzIGZpcnN0IHNvdW5kLlxuICAgICAgICBpZiAoIW1ldHJpY3MucmVwbGllZCAmJiBhdWRpby5xdWV1ZWQgPCAwLjA1ICYmIHQgLSBtZXRyaWNzLmxhc3RQbGF5ID4gMC42ICYmIG1ldHJpY3MubGFzdFZvaWNlID4gMCAmJiB0IC0gbWV0cmljcy5sYXN0Vm9pY2UgPCAxMCkge1xuICAgICAgICAgIG1ldHJpY3MucmVwbHkucHVzaCh0IC0gbWV0cmljcy5sYXN0Vm9pY2UpO1xuICAgICAgICAgIGlmIChtZXRyaWNzLnJlcGx5Lmxlbmd0aCA+IDIwKSBtZXRyaWNzLnJlcGx5LnNoaWZ0KCk7XG4gICAgICAgICAgbWV0cmljcy5yZXBsaWVkID0gdHJ1ZTtcbiAgICAgICAgICBzaG93TWV0cmljcygpO1xuICAgICAgICB9XG4gICAgICAgIG1ldHJpY3MubGFzdFBsYXkgPSB0O1xuICAgICAgICBhdWRpby5wbGF5KGMucGNtKTtcbiAgICAgICAgY291bnRzLnBsYXkrKztcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwiZmx1c2hcIjogYXVkaW8uZmx1c2goKTsgbG9nKFwib3V0XCIsIFwiZmx1c2hcIiwgXCJvdXRcIik7IGJyZWFrO1xuICAgICAgY2FzZSBcImN1ZVwiOlxuICAgICAgICBhdWRpby5jdWUoYy5wY20pO1xuICAgICAgICBsb2coXCJvdXRcIiwgYGN1ZSAke2MuZWFyY29ufWAsIFwib3V0XCIpO1xuICAgICAgICAvLyBBIHJlcXVlc3QgdGhhdCBiZWNhbWUgYSB0YXNrIGdldHMgYSB0b25lLCBub3QgYSBzcG9rZW4gcmVwbHk6IG5vdGhpbmcgdG8gdGltZS5cbiAgICAgICAgaWYgKGMuZWFyY29uID09PSBcInRhc2tTdGFydGVkXCIpIG1ldHJpY3MucmVwbGllZCA9IHRydWU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcIndha2V3b3JkXCI6IGxvZyhcIm91dFwiLCBgd2FrZSB3b3JkICR7Yy5vbiA/IFwibGlzdGVuaW5nXCIgOiBcIm9mZlwifWAsIFwib3V0XCIpOyBicmVhaztcbiAgICAgIGNhc2UgXCJ0b29sLmNhbGxcIjogdm9pZCB0b29sKGMpOyBicmVhaztcbiAgICAgIGNhc2UgXCJ0b29sLmNhbmNlbFwiOiBjYW5jZWxSdW4oYy5ydW4sIGMucmVhc29uKTsgYnJlYWs7XG4gICAgICBjYXNlIFwidG9vbC5zdGVlclwiOiB2b2lkIHN0ZWVyUnVuKGMpOyBicmVhaztcbiAgICAgIGNhc2UgXCJzdGF0dXNcIjpcbiAgICAgICAgY29yZVN0YXR1cyA9IGMuc3RhdHVzO1xuICAgICAgICBzaG93U3RhdHVzKGMuc3RhdHVzID09PSBcImVuZGVkXCIgPyBjLm1lc3NhZ2UgPz8gdW5kZWZpbmVkIDogdW5kZWZpbmVkKTtcbiAgICAgICAgbG9nKFwic3RhdHVzXCIsIGMuc3RhdHVzICsgKGMubWVzc2FnZSA/IGA6ICR7Yy5tZXNzYWdlfWAgOiBcIlwiKSwgXCJzdGF0dXNcIik7XG4gICAgICAgIGlmIChjLnN0YXR1cyA9PT0gXCJlbmRlZFwiKSB7IGlmIChjLm1lc3NhZ2UpIG5vdGUoYy5tZXNzYWdlKTsgZW5kKCk7IH1cbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwibGxtLnJlcXVlc3RcIjogdm9pZCBnZW5lcmF0ZShjLmlkLCBjLmJvZHkpOyBicmVhaztcbiAgICAgIGNhc2UgXCJsbG0uY2FuY2VsXCI6IHJlcXVlc3RzLmdldChjLmlkKT8uYWJvcnQoKTsgcmVxdWVzdHMuZGVsZXRlKGMuaWQpOyBsb2coXCJvdXRcIiwgYHJlcXVlc3QgJHtjLmlkfSBkcm9wcGVkYCwgXCJvdXRcIik7IGJyZWFrO1xuICAgICAgY2FzZSBcInRoaW5raW5nXCI6IHRoaW5raW5nID0gYy5vbjsgc2hvd1N0YXR1cygpOyBicmVhaztcbiAgICAgIGNhc2UgXCJlcnJvclwiOiBub3RlKGMubWVzc2FnZSk7IGxvZyhcImVycm9yXCIsIGMubWVzc2FnZSwgXCJlcnJcIik7IGJyZWFrO1xuICAgICAgY2FzZSBcImNhcHRpb25cIjogY2FwdGlvbihjLnRleHQpOyBicmVhaztcbiAgICAgIGNhc2UgXCJ0cmFuc2NyaXB0XCI6XG4gICAgICAgIHRyYW5zY3JpcHQoYy5yb2xlLCBjLnRleHQsIGMubGluZSk7XG4gICAgICAgIHJlbWVtYmVyKGMucm9sZSwgYy50ZXh0LCBjLnJvbGUgPT09IFwiYXNzaXN0YW50XCIgPyBcIkdlbWluaVwiIDogdW5kZWZpbmVkLCBsYXN0TGluZSA9PT0gYy5saW5lKTtcbiAgICAgICAgbGFzdExpbmUgPSBjLmxpbmU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcInRhc2tcIjoge1xuICAgICAgICBjb25zdCB2aWV3ID0gdGFza3MuZ2V0KGMuaWQpID8/IHsgYywgc2luY2U6IG5vdygpLCBlbmRlZDogbnVsbCB9O1xuICAgICAgICBpZiAoYy5zdGF0ZSA9PT0gXCJydW5uaW5nXCIgJiYgdmlldy5jLnN0YXRlICE9PSBcInJ1bm5pbmdcIikgeyB2aWV3LnNpbmNlID0gbm93KCk7IHZpZXcuZW5kZWQgPSBudWxsOyB9XG4gICAgICAgIGlmIChjLnN0YXRlICE9PSBcInJ1bm5pbmdcIiAmJiB2aWV3LmVuZGVkID09IG51bGwpIHZpZXcuZW5kZWQgPSBub3coKTtcbiAgICAgICAgdmlldy5jID0gYztcbiAgICAgICAgdGFza3Muc2V0KGMuaWQsIHZpZXcpO1xuICAgICAgICBzaG93VGFza3MoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwicXVlc3Rpb25zXCI6IGJyZWFrO1xuICAgICAgY2FzZSBcIm1pY1NpbGVudFwiOiAkKFwibWljd2FyblwiKS5oaWRkZW4gPSAhYy5zaWxlbnQ7IGJyZWFrO1xuICAgICAgY2FzZSBcInZvaWNlQ29tbWFuZFwiOlxuICAgICAgICB0b2FzdChgSGVhcmQgXHUyMDFDJHtjLmhlYXJkfVx1MjAxRDogJHtjLmNvbW1hbmQgPT09IFwic3RvcFwiID8gXCJzdG9wcGVkXCIgOiBjLmNvbW1hbmQgPT09IFwiY2FuY2VsQWxsXCIgPyBcImNhbmNlbGxpbmcgZXZlcnkgdGFza1wiIDogXCJoYW5naW5nIHVwXCJ9YCk7XG4gICAgICAgIGxvZyhcIm91dFwiLCBgdm9pY2UgY29tbWFuZCAke2MuY29tbWFuZH06ICR7Yy5oZWFyZH1gLCBcIm91dFwiKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwibG9nXCI6IGxvZyhjLmxldmVsLCBjLm1lc3NhZ2UsIGMubGV2ZWwgPT09IFwid2FyblwiID8gXCJ3YXJuXCIgOiBcIlwiKTsgYnJlYWs7XG4gICAgICBkZWZhdWx0OiBsb2coXCJvdXRcIiwgSlNPTi5zdHJpbmdpZnkoYykuc2xpY2UoMCwgMzAwKSwgXCJvdXRcIik7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIG9uTWljKHBjbTogc3RyaW5nLCBsZXZlbDogbnVtYmVyKSB7XG4gIGNvdW50cy5taWMrKztcbiAgaWYgKGxldmVsID4gMC4wMyAmJiAhKG11dGVkICYmICFob2xkaW5nKSkge1xuICAgIG1ldHJpY3MubGFzdFZvaWNlID0gbm93KCk7XG4gICAgaWYgKGF1ZGlvLnF1ZXVlZCA8IDAuMDUpIG1ldHJpY3MucmVwbGllZCA9IGZhbHNlO1xuICB9XG4gIHB1c2goeyB0eXBlOiBcIm1pY1wiLCBwY20gfSk7XG59XG5cbmZ1bmN0aW9uIGNvbm5lY3Qoc2lkOiBudW1iZXIsIGNhcHRpb25zOiBib29sZWFuKSB7XG4gIGNvbnN0IHdzID0gbmV3IFdlYlNvY2tldChgJHtsb2NhdGlvbi5wcm90b2NvbCA9PT0gXCJodHRwczpcIiA/IFwid3NzXCIgOiBcIndzXCJ9Oi8vJHtsb2NhdGlvbi5ob3N0fS9saXZlJHtjYXB0aW9ucyA/IFwiP2Zvcj1jYXB0aW9uc1wiIDogXCJcIn1gKTtcbiAgc29ja2V0cy5zZXQoc2lkLCB3cyk7XG4gIGlmIChjYXB0aW9ucykgY2FwdGlvblNvY2tldHMuYWRkKHNpZCk7XG4gIGxvZyhcIm91dFwiLCBgd3MgJHtzaWR9IGNvbm5lY3QgKCR7c2VydmVyLnJvdXRlfSR7Y2FwdGlvbnMgPyBcIiwgY2FwdGlvbnNcIiA6IFwiXCJ9KWAsIFwib3V0XCIpO1xuICB3cy5vbm9wZW4gPSAoKSA9PiBwdXNoKHsgdHlwZTogXCJ3cy5vcGVuXCIsIHNpZCB9KTtcbiAgd3Mub25tZXNzYWdlID0gKG0pID0+IHB1c2goeyB0eXBlOiBcIndzLm1lc3NhZ2VcIiwgc2lkLCBkYXRhOiB0eXBlb2YgbS5kYXRhID09PSBcInN0cmluZ1wiID8gbS5kYXRhIDogXCJcIiB9KTtcbiAgd3Mub25jbG9zZSA9IChlKSA9PiB7XG4gICAgaWYgKHNvY2tldHMuZ2V0KHNpZCkgIT09IHdzICYmIHNvY2tldHMuaGFzKHNpZCkpIHJldHVybjtcbiAgICBjb25zdCBodHRwU3RhdHVzID0gZS5jb2RlID49IDQxMDAgJiYgZS5jb2RlIDwgNDYwMCA/IGUuY29kZSAtIDQwMDAgOiB1bmRlZmluZWQ7XG4gICAgcHVzaCh7IHR5cGU6IFwid3MuY2xvc2VkXCIsIHNpZCwgY29kZTogaHR0cFN0YXR1cyA/IHVuZGVmaW5lZCA6IGUuY29kZSwgcmVhc29uOiBlLnJlYXNvbiwgaHR0cFN0YXR1cyB9KTtcbiAgfTtcbn1cblxuLyoqIEEgY2hhdCdzIHJlcXVlc3QgdG8gdGhlIHRleHQgbW9kZWwsIHRocm91Z2ggdGhlIHNlcnZlcjogZWFjaCBgZGF0YTpgIGxpbmUgb2YgdGhlIG1vZGVsJ3Mgc3RyZWFtIGdvZXMgdG8gdGhlIGNvcmUgYXMgaXQgY29tZXMuICovXG5hc3luYyBmdW5jdGlvbiBnZW5lcmF0ZShpZDogbnVtYmVyLCBib2R5OiBzdHJpbmcpIHtcbiAgY29uc3QgYWJvcnQgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gIHJlcXVlc3RzLnNldChpZCwgYWJvcnQpO1xuICBsb2coXCJvdXRcIiwgYHJlcXVlc3QgJHtpZH0gXHUyMTkyICR7c2VydmVyLnRleHRNb2RlbH0gKCR7TWF0aC5yb3VuZChib2R5Lmxlbmd0aCAvIDEwMjQpfSBLQilgLCBcIm91dFwiKTtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKFwiL2dlbmVyYXRlXCIsIHsgbWV0aG9kOiBcIlBPU1RcIiwgc2lnbmFsOiBhYm9ydC5zaWduYWwsIGhlYWRlcnM6IHsgXCJjb250ZW50LXR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSwgYm9keSB9KTtcbiAgICBpZiAoIXJlc3BvbnNlLm9rIHx8ICFyZXNwb25zZS5ib2R5KSB7XG4gICAgICBjb25zdCB0ZXh0ID0gYXdhaXQgcmVzcG9uc2UudGV4dCgpLmNhdGNoKCgpID0+IFwiXCIpO1xuICAgICAgcHVzaCh7IHR5cGU6IFwibGxtLmVuZFwiLCBpZCwgc3RhdHVzOiByZXNwb25zZS5zdGF0dXMsIGVycm9yOiBgSFRUUCAke3Jlc3BvbnNlLnN0YXR1c30ke3RleHQgPyBcIjogXCIgKyB0ZXh0LnJlcGxhY2UoL1xccysvZywgXCIgXCIpLnNsaWNlKDAsIDIwMCkgOiBcIlwifWAgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IHJlYWRlciA9IHJlc3BvbnNlLmJvZHkucGlwZVRocm91Z2gobmV3IFRleHREZWNvZGVyU3RyZWFtKCkpLmdldFJlYWRlcigpO1xuICAgIGxldCBidWZmZXIgPSBcIlwiO1xuICAgIGZvciAoOzspIHtcbiAgICAgIGNvbnN0IHsgdmFsdWUsIGRvbmUgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICBpZiAoZG9uZSkgYnJlYWs7XG4gICAgICBidWZmZXIgKz0gdmFsdWU7XG4gICAgICBsZXQgY3V0O1xuICAgICAgd2hpbGUgKChjdXQgPSBidWZmZXIuaW5kZXhPZihcIlxcblwiKSkgPj0gMCkge1xuICAgICAgICBjb25zdCBsaW5lID0gYnVmZmVyLnNsaWNlKDAsIGN1dCkucmVwbGFjZSgvXFxyJC8sIFwiXCIpO1xuICAgICAgICBidWZmZXIgPSBidWZmZXIuc2xpY2UoY3V0ICsgMSk7XG4gICAgICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgoXCJkYXRhOlwiKSkgcHVzaCh7IHR5cGU6IFwibGxtLmRhdGFcIiwgaWQsIGRhdGE6IGxpbmUuc2xpY2UoNSkudHJpbSgpIH0pO1xuICAgICAgfVxuICAgIH1cbiAgICBwdXNoKHsgdHlwZTogXCJsbG0uZW5kXCIsIGlkIH0pO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBpZiAoIWFib3J0LnNpZ25hbC5hYm9ydGVkKSBwdXNoKHsgdHlwZTogXCJsbG0uZW5kXCIsIGlkLCBlcnJvcjogKGVyciBhcyBFcnJvcikubWVzc2FnZSB9KTtcbiAgfSBmaW5hbGx5IHtcbiAgICByZXF1ZXN0cy5kZWxldGUoaWQpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGNhbmNlbFJ1bihrZXk6IHN0cmluZywgcmVhc29uOiBzdHJpbmcpIHtcbiAgY29uc3QgciA9IHJ1bnMuZ2V0KGtleSk7XG4gIGxvZyhcIm91dFwiLCBgY2FuY2VsICR7a2V5fSAoJHtyZWFzb259KWAsIFwib3V0XCIpO1xuICBpZiAoIXIpIHJldHVybjtcbiAgcnVucy5kZWxldGUoa2V5KTtcbiAgci5hYm9ydC5hYm9ydCgpO1xuICAvLyBDYW5jZWxsZWQgb24gcHVycG9zZTogdGhlIGFnZW50IHN0b3BzIHRvby4gQSBjYWxsIHRoYXQgZW5kZWQgbGVhdmVzIGEgY29kaW5nIGFnZW50IHdvcmtpbmcgaW4gVDMuXG4gIGlmIChyZWFzb24gPT09IFwiY2FuY2VsbGVkXCIgJiYgIWNoZWNrZWQoXCJmYWtlaGVybWVzXCIpKSB7XG4gICAgdm9pZCBmZXRjaChyLmFnZW50ID09PSBcInQzXCIgPyBcIi9hZ2VudC9jYW5jZWxcIiA6IFwiL2hlcm1lcy9zdG9wXCIsIHsgbWV0aG9kOiBcIlBPU1RcIiwgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBjYWxsOiBjYWxsTmFtZSwgdGFza0lkOiByLnRhc2tJZCB9KSB9KTtcbiAgfVxufVxuXG4vKiogTW9yZSBmb3IgYSBydW5uaW5nIHRhc2ssIGludG8gaXRzIGN1cnJlbnQgcnVuOyBpZiB0aGUgYWdlbnQgd29uJ3QgdGFrZSBpdCwgdGhlIGNvcmUgcXVldWVzIGl0IGluc3RlYWQuICovXG5hc3luYyBmdW5jdGlvbiBzdGVlclJ1bihjOiBDb21tYW5kKSB7XG4gIGNvbnN0IHIgPSBydW5zLmdldChjLnJ1bik7XG4gIGxvZyhcIm91dFwiLCBgc3RlZXIgJHtjLnJ1bn06ICR7Yy50ZXh0fWAsIFwib3V0XCIpO1xuICBpZiAoY2hlY2tlZChcImZha2VoZXJtZXNcIikpIHJldHVybjtcbiAgY29uc3Qgb2sgPSByICE9IG51bGwgJiZcbiAgICAoYXdhaXQgZmV0Y2goYy5hZ2VudCA9PT0gXCJ0M1wiID8gXCIvYWdlbnQvc3RlZXJcIiA6IFwiL2hlcm1lcy9zdGVlclwiLCB7IG1ldGhvZDogXCJQT1NUXCIsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgY2FsbDogY2FsbE5hbWUsIHRhc2tJZDogci50YXNrSWQsIHRleHQ6IGMubWVzc2FnZSB9KSB9KS50aGVuKCh4KSA9PiB4Lm9rLCAoKSA9PiBmYWxzZSkpO1xuICBpZiAoIW9rKSBwdXNoKHsgdHlwZTogXCJ0b29sLnN0ZWVyRmFpbGVkXCIsIHJ1bjogYy5ydW4sIHRleHQ6IGMudGV4dCB9KTtcbiAgZWxzZSB0b2FzdChgJHtjLmFnZW50ID09PSBcInQzXCIgPyBcIlRoZSBjb2RpbmcgYWdlbnRcIiA6IFwiSGVybWVzXCJ9IHRvb2sgdGhlIGZvbGxvdy11cCB3aGlsZSBpdCB3b3Jrc2ApO1xufVxuXG5hc3luYyBmdW5jdGlvbiB0b29sKGM6IENvbW1hbmQpIHtcbiAgaWYgKGMua2luZCA9PT0gXCJob3N0XCIpIHtcbiAgICBsb2coXCJvdXRcIiwgYGhvc3QgdG9vbCAke2MubmFtZX0gJHtKU09OLnN0cmluZ2lmeShjLmFyZ3MpfWAsIFwib3V0XCIpO1xuICAgIGNvbnN0IGFuc3dlciA9IGMubmFtZSA9PT0gXCJ0dl92b2x1bWVcIiA/IGBUaGUgVFYgaXMgYXQgJHsoZmFrZVR2TGV2ZWwgPSBOdW1iZXIoYy5hcmdzPy5sZXZlbCA/PyBmYWtlVHZMZXZlbCkpfS5gXG4gICAgICA6IGMubmFtZSA9PT0gXCJ0dl9wYXVzZVwiID8gKGMuYXJncz8ucGF1c2UgPT09IGZhbHNlID8gXCJQbGF5aW5nLlwiIDogXCJQYXVzZWQuXCIpIDogXCJEb25lLlwiO1xuICAgIHNldFRpbWVvdXQoKCkgPT4gcHVzaCh7IHR5cGU6IFwidG9vbC5yZXN1bHRcIiwgcnVuOiBjLnJ1biwgdGV4dDogYW5zd2VyIH0pLCAzMDApO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBhZ2VudCA9IGMuYWdlbnQgPT09IFwidDNcIiA/IFwidDNcIiA6IFwiaGVybWVzXCI7XG4gIGxvZyhcIm91dFwiLCBgJHthZ2VudH0gJHtjLmZvbGxvd1VwID8gXCJmb2xsb3ctdXBcIiA6IFwidGFza1wifSBcIiR7Yy5sYWJlbH1cIiR7Yy5wcm9qZWN0ID8gYCBpbiAke2MucHJvamVjdH1gIDogXCJcIn06ICR7Yy5yZXF1ZXN0fWAsIFwib3V0XCIpO1xuICBjb25zdCBhYm9ydCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgcnVucy5zZXQoYy5ydW4sIHsgYWJvcnQsIGFnZW50LCB0YXNrSWQ6IGMudGFza0lkIH0pO1xuICBjb25zdCBkb25lID0gKHRleHQ6IHN0cmluZywgZmFpbGVkID0gZmFsc2UpID0+IHtcbiAgICBpZiAoIXJ1bnMuaGFzKGMucnVuKSkgcmV0dXJuO1xuICAgIHJ1bnMuZGVsZXRlKGMucnVuKTtcbiAgICBjb25zdCB2aWV3ID0gdGFza3MuZ2V0KGMudGFza0lkKTtcbiAgICBjb25zdCByb3cgPSByZXN1bHQoYWdlbnQsIGMubGFiZWwsIHRleHQsIGZhaWxlZCk7XG4gICAgbm90aWZ5KGAke2FnZW50ID09PSBcInQzXCIgPyBcIlQzXCIgOiBcIkhlcm1lc1wifSBcdTAwQjcgJHtjLmxhYmVsfWAsIHRleHQpO1xuICAgIGlmICghZmFpbGVkKSB7IHJlbWVtYmVyKFwiYXNzaXN0YW50XCIsIHRleHQsIGAke2FnZW50ID09PSBcInQzXCIgPyBcIlQzXCIgOiBcIkhlcm1lc1wifSBcdTAwQjcgJHtjLmxhYmVsfWApOyBsYXN0TGluZSA9IG51bGw7IH1cbiAgICBpZiAodmlldykgeyB2aWV3LnJlc3VsdCA9IHJvdzsgc2hvd1Rhc2tzKCk7IH1cbiAgICBwdXNoKHsgdHlwZTogXCJ0b29sLnJlc3VsdFwiLCBydW46IGMucnVuLCB0ZXh0LCBmYWlsZWQgfSk7XG4gIH07XG4gIGlmIChjaGVja2VkKFwiZmFrZWhlcm1lc1wiKSkge1xuICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiBkb25lKGAoRmFrZSAke2FnZW50ID09PSBcInQzXCIgPyBcIlQzXCIgOiBcIkhlcm1lc1wifSkgRG9uZTogXHUyMDFDJHtjLnJlcXVlc3R9XHUyMDFELiBOb3RoaW5nIHdhcyBhY3R1YWxseSBydW4uYCksIE51bWJlcigkPEhUTUxJbnB1dEVsZW1lbnQ+KFwiZmFrZWRlbGF5XCIpLnZhbHVlKSAqIDEwMDApO1xuICAgIGFib3J0LnNpZ25hbC5vbmFib3J0ID0gKCkgPT4gY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICByZXR1cm47XG4gIH1cbiAgdHJ5IHtcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKGFnZW50ID09PSBcInQzXCIgPyBcIi9hZ2VudFwiIDogXCIvaGVybWVzXCIsIHtcbiAgICAgIG1ldGhvZDogXCJQT1NUXCIsIHNpZ25hbDogYWJvcnQuc2lnbmFsLCBoZWFkZXJzOiB7IFwiY29udGVudC10eXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGNhbGw6IGNhbGxOYW1lLCB0YXNrSWQ6IGMudGFza0lkLCBmb2xsb3dVcDogYy5mb2xsb3dVcCwgbWVzc2FnZTogYy5tZXNzYWdlLCBsYWJlbDogYy5sYWJlbCwgcmVxdWVzdDogYy5yZXF1ZXN0LCBwcm9qZWN0OiBjLnByb2plY3QsIGFwcHJvdmFsczogXCJzY3JlZW5cIiB9KSxcbiAgICB9KTtcbiAgICBpZiAoIXJlc3BvbnNlLm9rIHx8ICFyZXNwb25zZS5ib2R5KSB0aHJvdyBuZXcgRXJyb3IoYEhUVFAgJHtyZXNwb25zZS5zdGF0dXN9YCk7XG4gICAgY29uc3QgcmVhZGVyID0gcmVzcG9uc2UuYm9keS5waXBlVGhyb3VnaChuZXcgVGV4dERlY29kZXJTdHJlYW0oKSkuZ2V0UmVhZGVyKCk7XG4gICAgbGV0IGJ1ZmZlciA9IFwiXCI7XG4gICAgZm9yICg7Oykge1xuICAgICAgY29uc3QgeyB2YWx1ZSwgZG9uZTogZmluaXNoZWQgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICBpZiAoZmluaXNoZWQpIGJyZWFrO1xuICAgICAgYnVmZmVyICs9IHZhbHVlO1xuICAgICAgbGV0IGN1dDtcbiAgICAgIHdoaWxlICgoY3V0ID0gYnVmZmVyLmluZGV4T2YoXCJcXG5cXG5cIikpID49IDApIHtcbiAgICAgICAgY29uc3QgYmxvY2sgPSBidWZmZXIuc2xpY2UoMCwgY3V0KTtcbiAgICAgICAgYnVmZmVyID0gYnVmZmVyLnNsaWNlKGN1dCArIDIpO1xuICAgICAgICBjb25zdCBldmVudCA9IGJsb2NrLm1hdGNoKC9eZXZlbnQ6ICguKikkL20pPy5bMV07XG4gICAgICAgIGlmICghZXZlbnQpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCBkYXRhID0gSlNPTi5wYXJzZShibG9jay5tYXRjaCgvXmRhdGE6ICguKikkL20pPy5bMV0gPz8gXCJ7fVwiKTtcbiAgICAgICAgaWYgKGV2ZW50ID09PSBcInByb2dyZXNzXCIpIHB1c2goeyB0eXBlOiBcInRhc2sucHJvZ3Jlc3NcIiwgdGFzazogYy50YXNrSWQsIHRleHQ6IGRhdGEudGV4dCB9KTtcbiAgICAgICAgZWxzZSBpZiAoZXZlbnQgPT09IFwidGhyZWFkXCIpIHsgY29uc3QgdmlldyA9IHRhc2tzLmdldChjLnRhc2tJZCk7IGlmICh2aWV3KSB7IHZpZXcudGhyZWFkID0gZGF0YS50aHJlYWQ7IHNob3dUYXNrcygpOyB9IH1cbiAgICAgICAgZWxzZSBpZiAoZXZlbnQgPT09IFwiYXBwcm92YWxcIikge1xuICAgICAgICAgIGNvbnN0IHZpZXcgPSB0YXNrcy5nZXQoYy50YXNrSWQpO1xuICAgICAgICAgIGlmICh2aWV3KSB7IHZpZXcuYXBwcm92YWwgPSB7IGNvbW1hbmQ6IGRhdGEuY29tbWFuZCB9OyBzaG93VGFza3ModHJ1ZSk7IH1cbiAgICAgICAgICB0b2FzdChgSGVybWVzIGFza3MgdG8gcnVuOiAke2RhdGEuY29tbWFuZC5zbGljZSgwLCA4MCl9YCk7XG4gICAgICAgICAgbm90aWZ5KGBIZXJtZXMgXHUwMEI3ICR7Yy5sYWJlbH0gbmVlZHMgeW91ciBhcHByb3ZhbGAsIGRhdGEuY29tbWFuZCk7XG4gICAgICAgICAgYXVkaW8uY3VlKEFQUFJPVkFMX1RPTkUpO1xuICAgICAgICB9XG4gICAgICAgIGVsc2UgaWYgKGV2ZW50ID09PSBcInJlc3VsdFwiKSBkb25lKGRhdGEudGV4dCwgZGF0YS5mYWlsZWQpO1xuICAgICAgICBlbHNlIGlmIChldmVudCA9PT0gXCJlcnJvclwiKSB7IHJ1bnMuZGVsZXRlKGMucnVuKTsgcHVzaCh7IHR5cGU6IFwidG9vbC5lcnJvclwiLCBydW46IGMucnVuLCBtZXNzYWdlOiBkYXRhLm1lc3NhZ2UgfSk7IH1cbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKHJ1bnMuaGFzKGMucnVuKSkgeyBydW5zLmRlbGV0ZShjLnJ1bik7IHB1c2goeyB0eXBlOiBcInRvb2wuZXJyb3JcIiwgcnVuOiBjLnJ1biwgbWVzc2FnZTogXCJ0aGUgc2VydmVyIGNsb3NlZCB0aGUgc3RyZWFtIHdpdGhvdXQgYSByZXN1bHRcIiB9KTsgfVxuICB9IGNhdGNoIChlcnIpIHtcbiAgICBpZiAoIWFib3J0LnNpZ25hbC5hYm9ydGVkICYmIHJ1bnMuaGFzKGMucnVuKSkgeyBydW5zLmRlbGV0ZShjLnJ1bik7IHB1c2goeyB0eXBlOiBcInRvb2wuZXJyb3JcIiwgcnVuOiBjLnJ1biwgbWVzc2FnZTogKGVyciBhcyBFcnJvcikubWVzc2FnZSB9KTsgfVxuICB9XG59XG5cbmZ1bmN0aW9uIG1pY09wdGlvbnMoKSB7XG4gIGNvbnN0IGFlYyA9IGNoZWNrZWQoXCJhZWNcIik7XG4gIHJldHVybiB7IGVjaG9DYW5jZWxsYXRpb246IGFlYywgbm9pc2VTdXBwcmVzc2lvbjogYWVjLCBhdXRvR2FpbkNvbnRyb2w6IGFlYyB9O1xufVxuXG5mdW5jdGlvbiByZWFkQ29uZmlnKCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgY29uc3QgZ2l2ZW4gPSBKU09OLnBhcnNlKCQ8SFRNTFRleHRBcmVhRWxlbWVudD4oXCJjb25maWdcIikudmFsdWUpO1xuICBjb25zdCBjb25maWc6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgIG1vZGVsOiBzZXJ2ZXIubW9kZWwsIGFwaTogc2VydmVyLnJvdXRlID09PSBcInZlcnRleFwiID8gXCJ2ZXJ0ZXhcIiA6IFwiZ2VtaW5pXCIsIHRvZGF5OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkuc2xpY2UoMCwgMTApLFxuICAgIC4uLmdpdmVuLCB0cmFjZTogY2hlY2tlZChcInRyYWNlXCIpLFxuICB9O1xuICBpZiAoY2hlY2tlZChcInB0dFwiKSkgY29uZmlnLm11dGVkID0gdHJ1ZTtcbiAgaWYgKGdpdmVuLnZvaWNlID09PSB1bmRlZmluZWQpIGNvbmZpZy52b2ljZSA9ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwidm9pY2VcIikudmFsdWU7XG4gIGlmIChjb25maWcuc3RlZXJpbmcgPT09IHVuZGVmaW5lZCkgY29uZmlnLnN0ZWVyaW5nID0gW1wiaGVybWVzXCIsIFwidDNcIl07XG4gIC8vIEEgd2ViIGNvbmZpZyBzYXZlZCBiZWZvcmUgaGFuZC1vZmZzIHdlcmUgbmFtZWQgaW4gd29yZHMgZ2V0cyB0aGF0IHRvby5cbiAgaWYgKGNvbmZpZy5oYW5kT2ZmID09PSB1bmRlZmluZWQgJiYgY29uZmlnLnBsYXRmb3JtID09PSBcIndlYlwiKSBjb25maWcuaGFuZE9mZiA9IFwibmFtZWRcIjtcbiAgLy8gQW5kIG9uZSBzYXZlZCBiZWZvcmUgdGhlIHBhZ2UgZm9sbG93ZWQgdGhlIHVzZXIncyBsZWFkIChzdXBlcnZpc2UpIGdldHMgdGhhdC5cbiAgaWYgKGNvbmZpZy5zdXBlcnZpc2UgPT09IHVuZGVmaW5lZCAmJiBjb25maWcucGxhdGZvcm0gPT09IFwid2ViXCIpIGNvbmZpZy5zdXBlcnZpc2UgPSB0cnVlO1xuICBpZiAoY2hlY2tlZChcImNvZGluZ1wiKSAmJiAoc2VydmVyLnQzIHx8IGNoZWNrZWQoXCJmYWtlaGVybWVzXCIpKSAmJiBjb25maWcuY29kaW5nQWdlbnQgPT09IHVuZGVmaW5lZCkgY29uZmlnLmNvZGluZ0FnZW50ID0geyBwcm9qZWN0czogc2VydmVyLnQzID8/IFtdIH07XG4gIGlmIChjaGVja2VkKFwiY2FwdGlvbnNcIikgJiYgc2VydmVyLmNhcHRpb25zTW9kZWwgJiYgY29uZmlnLmNhcHRpb25zID09PSB1bmRlZmluZWQpIGNvbmZpZy5jYXB0aW9ucyA9IHsgbW9kZWw6IHNlcnZlci5jYXB0aW9uc01vZGVsIH07XG4gIHJldHVybiBjb25maWc7XG59XG5cbi8qKiBTdGFydHMgYSB2b2ljZSBjYWxsLCBvciB3aXRoIFt0eXBlZF0gYSBjaGF0ICh0aGUgY29yZSdzIG1lZGl1bSBcInRleHRcIjogbm8gYXVkaW8sIGEgdGV4dCBtb2RlbCkuICovXG5hc3luYyBmdW5jdGlvbiBzdGFydChjYXJyeU9uID0gZmFsc2UsIHR5cGVkID0gZmFsc2UpIHtcbiAgYXdhaXQgZW5kaW5nO1xuICBpZiAoY2FsbElkKSByZXR1cm47XG4gIGxldCBnaXZlbjogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIHRyeSB7XG4gICAgZ2l2ZW4gPSByZWFkQ29uZmlnKCk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHRvYXN0KGBUaGUgZGV2ZWxvcGVyIHNldHRpbmdzIGFyZW4ndCB2YWxpZCBKU09OOiAkeyhlcnIgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmICh0eXBlZCkge1xuICAgIGlmICghc2VydmVyLnRleHRNb2RlbCkgeyB0b2FzdChcIlRoaXMgc2VydmVyIGhhcyBubyB0ZXh0IG1vZGVsIGZvciBhIGNoYXQ6IHN0YXJ0IGEgY2FsbCB0byB0eXBlIHRvIGl0XCIpOyByZXR1cm47IH1cbiAgICBnaXZlbiA9IHsgLi4uZ2l2ZW4sIG1lZGl1bTogXCJ0ZXh0XCIsIG11dGVkOiBmYWxzZSB9O1xuICAgIGRlbGV0ZSBnaXZlbi5jYXB0aW9ucztcbiAgfVxuICAkPEhUTUxCdXR0b25FbGVtZW50PihcImNhbGxcIikuZGlzYWJsZWQgPSB0cnVlO1xuICAkPEhUTUxCdXR0b25FbGVtZW50PihcImhlcm8tY2FsbFwiKS5kaXNhYmxlZCA9IHRydWU7XG4gIGlmIChcIk5vdGlmaWNhdGlvblwiIGluIHdpbmRvdyAmJiBOb3RpZmljYXRpb24ucGVybWlzc2lvbiA9PT0gXCJkZWZhdWx0XCIpIHZvaWQgTm90aWZpY2F0aW9uLnJlcXVlc3RQZXJtaXNzaW9uKCkuY2F0Y2goKCkgPT4ge30pO1xuICB0cnkge1xuICAgIGlmICghdHlwZWQpIGF3YWl0IGF1ZGlvLm9wZW4oKTtcbiAgICBjb3JlID0gYXdhaXQgbG9hZENvcmUoKTtcbiAgfSBmaW5hbGx5IHtcbiAgICAkPEhUTUxCdXR0b25FbGVtZW50PihcImNhbGxcIikuZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAkPEhUTUxCdXR0b25FbGVtZW50PihcImhlcm8tY2FsbFwiKS5kaXNhYmxlZCA9IGZhbHNlO1xuICB9XG4gIGlmIChjYWxsSWQpIHJldHVybjsgLy8gYW5vdGhlciBzdGFydCBnb3QgdGhlcmUgZmlyc3RcbiAgbWVkaXVtID0gdHlwZWQgPyBcInRleHRcIiA6IFwidm9pY2VcIjtcbiAgdGhpbmtpbmcgPSBmYWxzZTtcbiAgJChcInZlcnNpb25cIikudGV4dENvbnRlbnQgPSBjb3JlLnZlcnNpb247XG4gICQoXCJsb2dcIikuaW5uZXJIVE1MID0gXCJcIjtcbiAgaWYgKCF0eXBlZCAmJiAodGFza3Muc2l6ZSA+IDAgfHwgJChcInRyYW5zY3JpcHRcIikuY2hpbGRFbGVtZW50Q291bnQgPiAxKSkgbm90ZShgTmV3IGNhbGwgXHUwMEI3ICR7bmV3IERhdGUoKS50b0xvY2FsZVRpbWVTdHJpbmcoKX1gKTtcbiAgc2Nyb2xsRG93bih0cnVlKTtcbiAgdGFza3MuY2xlYXIoKTtcbiAgc2hvd1Rhc2tzKCk7XG4gIGNvdW50cyA9IHsgbWljOiAwLCBwbGF5OiAwLCBzZW50OiAwIH07XG4gIG1ldHJpY3MucmVwbHkgPSBbXTtcbiAgc3RhcnRlZEF0ID0gbm93KCk7XG4gIG11dGVkID0gZ2l2ZW4ubXV0ZWQgPT09IHRydWU7XG4gIC8vIENhcnJ5aW5nIG9uOiB0aGUgbW9kZWwgZ2V0cyB0aGUgbGFzdCBjb252ZXJzYXRpb24gYXMgYSByZWNhcC4gVGhlIGNvcmUgY2FwcyBpdCwgbGF0ZXN0IGxpbmVzIGZpcnN0LlxuICAvLyBBIGNoYXQgYWx3YXlzIGNhcnJpZXMgb24gZnJvbSB3aGF0J3Mgb24gdGhlIHNjcmVlbiAoYW4gZWFybGllciBjYWxsIG9yIGNoYXQgb24gdGhpcyBwYWdlKS5cbiAgaWYgKHR5cGVkKSB7IGlmIChjaGF0Lmxlbmd0aCA+IDAgJiYgZ2l2ZW4uaGlzdG9yeSA9PT0gdW5kZWZpbmVkKSBnaXZlbi5oaXN0b3J5ID0gY2hhdDsgfVxuICBlbHNlIGlmIChjYXJyeU9uICYmIGdpdmVuLmhpc3RvcnkgPT09IHVuZGVmaW5lZCkgZ2l2ZW4uaGlzdG9yeSA9IHNhdmVkSGlzdG9yeSgpO1xuICBlbHNlIGlmICghY2FycnlPbikgY2hhdCA9IFtdO1xuICBpZiAoY2FycnlPbiAmJiAhdHlwZWQpIGNoYXQgPSBzYXZlZEhpc3RvcnkoKTtcbiAgbGFzdExpbmUgPSBudWxsO1xuICBvcGVuTGluZSA9IG51bGw7XG4gIHN5bmNSZXN1bWVCdXR0b25zKGZhbHNlKTtcbiAgY2FsbE5hbWUgPSBgJHtuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkucmVwbGFjZSgvWzouXS9nLCBcIi1cIil9LSR7dHlwZWQgPyBcImNoYXRcIiA6IFwid2ViXCJ9LSR7Y29yZS52ZXJzaW9ufWA7XG4gIGNvbnN0IGNyZWF0ZWQgPSBKU09OLnBhcnNlKGNvcmUuY3JlYXRlKEpTT04uc3RyaW5naWZ5KGdpdmVuKSwgbm93KCkpKTtcbiAgY2FsbElkID0gY3JlYXRlZC5pZDtcbiAgaWYgKCF0eXBlZCkge1xuICAgIHNldENhbGxCdXR0b24odHJ1ZSk7XG4gICAgJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJtaWNcIikuZGlzYWJsZWQgPSBmYWxzZTtcbiAgfVxuICAkPEhUTUxCdXR0b25FbGVtZW50PihcImh1c2hcIikuZGlzYWJsZWQgPSBmYWxzZTtcbiAgJChcIm1pY1wiKS5jbGFzc0xpc3QudG9nZ2xlKFwibXV0ZWRcIiwgbXV0ZWQpO1xuICBydW4oY3JlYXRlZC5jb21tYW5kcyk7XG4gIHNob3dTdGF0dXMoKTtcbiAgdGlja2VyID0gd2luZG93LnNldEludGVydmFsKCgpID0+IHtcbiAgICBwdXNoKHsgdHlwZTogXCJ0aWNrXCIgfSk7XG4gICAgY29uc3QgbGV2ZWwgPSBtdXRlZCAmJiAhaG9sZGluZyA/IDAgOiBhdWRpby5sZXZlbDtcbiAgICBjb25zdCBzdHJlbmd0aCA9IE1hdGgubWluKDEsIGxldmVsICogMTIpO1xuICAgICQoXCJyaW5nXCIpLnN0eWxlLm9wYWNpdHkgPSBTdHJpbmcoc3RyZW5ndGgpO1xuICAgICQoXCJyaW5nXCIpLnN0eWxlLnRyYW5zZm9ybSA9IGBzY2FsZSgkeygxICsgc3RyZW5ndGggKiAwLjEyKS50b0ZpeGVkKDMpfSlgO1xuICAgICQoXCJjb3VudHNcIikudGV4dENvbnRlbnQgPSBgbWljICR7Y291bnRzLm1pY30gXHUwMEI3IHNlbnQgJHtjb3VudHMuc2VudH0gXHUwMEI3IHBsYXllZCAke2NvdW50cy5wbGF5fSBcdTAwQjcgcXVldWVkICR7YXVkaW8ucXVldWVkLnRvRml4ZWQoMSl9IHNgO1xuICAgIHNob3dTdGF0dXMoKTtcbiAgfSwgMTAwKTtcbiAgdHJhY2VUaW1lciA9IHdpbmRvdy5zZXRJbnRlcnZhbCgoKSA9PiB7IHZvaWQgc2F2ZVRyYWNlKCk7IHZvaWQgcGluZygpOyBzaG93VGFza3MoKTsgfSwgNTAwMCk7XG4gIHZvaWQgcGluZygpO1xuICBpZiAodHlwZWQpIHJldHVybjtcbiAgc3RvcFdvcmRzLnN0YXJ0KCk7XG4gIHRyeSB7IHdha2VMb2NrID0gYXdhaXQgKG5hdmlnYXRvciBhcyBhbnkpLndha2VMb2NrPy5yZXF1ZXN0KFwic2NyZWVuXCIpOyB9IGNhdGNoIHt9XG59XG5cbi8qKiBUaGUgQ2FsbCBidXR0b246IGhhbmdzIHVwIGEgY2FsbDsgc3RhcnRzIG9uZTsgb3IsIHdpdGggYSBjaGF0IG9uLCBlbmRzIHRoZSBjaGF0IGFuZCBjYXJyaWVzIGl0cyBjb252ZXJzYXRpb24gb24gYnkgdm9pY2UuICovXG5hc3luYyBmdW5jdGlvbiBjYWxsQnV0dG9uKCkge1xuICBpZiAoY2FsbElkICYmIG1lZGl1bSA9PT0gXCJ2b2ljZVwiKSB7IGhhbmdVcCgpOyByZXR1cm47IH1cbiAgaWYgKGNhbGxJZCkge1xuICAgIC8vIEEgY2FsbCBjYW4ndCB0YWtlIG92ZXIgdGhlIGNoYXQncyB0YXNrcywgYW5kIGVuZGluZyB0aGUgY2hhdCB3b3VsZCBzdG9wIHRoZW0uXG4gICAgaWYgKFsuLi50YXNrcy52YWx1ZXMoKV0uc29tZSgodikgPT4gdi5jLnN0YXRlID09PSBcInJ1bm5pbmdcIikpIHsgdG9hc3QoXCJUaGUgY2hhdCdzIHRhc2tzIGFyZSBzdGlsbCBydW5uaW5nOiB3YWl0IGZvciB0aGVtIG9yIGNhbmNlbCB0aGVtLCB0aGVuIGNhbGxcIik7IHJldHVybjsgfVxuICAgIHB1c2goeyB0eXBlOiBcInN0b3BcIiB9KTtcbiAgICBhd2FpdCBzdGFydCh0cnVlKTtcbiAgICByZXR1cm47XG4gIH1cbiAgYXdhaXQgc3RhcnQoKTtcbn1cblxuZnVuY3Rpb24gaGFuZ1VwKCkge1xuICBpZiAoY2FsbElkKSBwdXNoKHsgdHlwZTogXCJzdG9wXCIsIG1lc3NhZ2U6IFwiWW91IGh1bmcgdXAuXCIgfSk7XG59XG5cbmZ1bmN0aW9uIGVuZCgpIHtcbiAgd2luZG93LmNsZWFySW50ZXJ2YWwodGlja2VyKTtcbiAgd2luZG93LmNsZWFySW50ZXJ2YWwodHJhY2VUaW1lcik7XG4gIHN0b3BXb3Jkcy5zdG9wKCk7XG4gIGVuZGluZyA9IHNhdmVUcmFjZSgpLnRoZW4oKCkgPT4geyBpZiAoY29yZSAmJiBjYWxsSWQpIGNvcmUuZGlzcG9zZShjYWxsSWQpOyBjYWxsSWQgPSAwOyBzaG93VGFza3MoKTsgc2hvd1N0YXR1cygpOyB9KTtcbiAgYXVkaW8uc3RvcCgpO1xuICBmb3IgKGNvbnN0IHdzIG9mIHNvY2tldHMudmFsdWVzKCkpIHdzLmNsb3NlKCk7XG4gIHNvY2tldHMuY2xlYXIoKTtcbiAgZm9yIChjb25zdCByIG9mIHJ1bnMudmFsdWVzKCkpIHIuYWJvcnQuYWJvcnQoKTtcbiAgcnVucy5jbGVhcigpO1xuICBmb3IgKGNvbnN0IHIgb2YgcmVxdWVzdHMudmFsdWVzKCkpIHIuYWJvcnQoKTtcbiAgcmVxdWVzdHMuY2xlYXIoKTtcbiAgdGhpbmtpbmcgPSBmYWxzZTtcbiAgc2V0Q2FsbEJ1dHRvbihmYWxzZSk7XG4gIGZvciAoY29uc3QgaWQgb2YgW1wibWljXCIsIFwiaHVzaFwiXSkgJDxIVE1MQnV0dG9uRWxlbWVudD4oaWQpLmRpc2FibGVkID0gdHJ1ZTtcbiAgJChcInJpbmdcIikuc3R5bGUub3BhY2l0eSA9IFwiMFwiO1xuICAkKFwicmluZ1wiKS5zdHlsZS50cmFuc2Zvcm0gPSBcIlwiO1xuICAkKFwiY2FsbGJhclwiKS5oaWRkZW4gPSB0cnVlO1xuICAkKFwibWljd2FyblwiKS5oaWRkZW4gPSB0cnVlO1xuICBkb2N1bWVudC5ib2R5LmRhdGFzZXQuc3RhdGUgPSBcImlkbGVcIjtcbiAgZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QucmVtb3ZlKFwiaW4tc2Vzc2lvblwiKTtcbiAgc3luY1Jlc3VtZUJ1dHRvbnMoY2hhdC5sZW5ndGggPiAwKTtcbiAgdm9pZCBzaG93RWFybGllcigpO1xuICB2b2lkIHdha2VMb2NrPy5yZWxlYXNlKCkuY2F0Y2goKCkgPT4ge30pO1xuICB3YWtlTG9jayA9IG51bGw7XG59XG5cbmZ1bmN0aW9uIHNldE11dGVkKHZhbHVlOiBib29sZWFuKSB7XG4gIGlmICghY2FsbElkIHx8IG11dGVkID09PSB2YWx1ZSkgcmV0dXJuO1xuICBtdXRlZCA9IHZhbHVlO1xuICAkKFwibWljXCIpLmNsYXNzTGlzdC50b2dnbGUoXCJtdXRlZFwiLCBtdXRlZCk7XG4gIHB1c2goeyB0eXBlOiBtdXRlZCA/IFwibXV0ZVwiIDogXCJ1bm11dGVcIiB9KTtcbiAgc2hvd1N0YXR1cygpO1xufVxuXG4vKiogU2VuZHMgd2hhdCB0aGUgdHJhY2Uga2VwdCBzaW5jZSBsYXN0IHRpbWUgdG8gdGhlIGRldiBzZXJ2ZXIsIGFzIEpTT04gbGluZXM6IGEgaGVhZGVyLCB0aGVuIGV2ZW50cy4gKi9cbmFzeW5jIGZ1bmN0aW9uIHNhdmVUcmFjZSgpIHtcbiAgaWYgKCFjb3JlIHx8ICFjYWxsSWQgfHwgIWNoZWNrZWQoXCJ0cmFjZVwiKSkgcmV0dXJuO1xuICBjb25zdCBrZXB0ID0gSlNPTi5wYXJzZShjb3JlLnRyYWNlKGNhbGxJZCkpO1xuICBpZiAoIWtlcHQpIHJldHVybjtcbiAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG4gIGlmIChrZXB0LmNvbmZpZykgbGluZXMucHVzaChKU09OLnN0cmluZ2lmeSh7IHZlcnNpb246IGtlcHQudmVyc2lvbiwgY29uZmlnOiBrZXB0LmNvbmZpZywgc3RhcnQ6IGtlcHQuc3RhcnQgfSkpO1xuICBmb3IgKGNvbnN0IGUgb2Yga2VwdC5ldmVudHMpIGxpbmVzLnB1c2goSlNPTi5zdHJpbmdpZnkoZSkpO1xuICBpZiAobGluZXMubGVuZ3RoID09PSAwKSByZXR1cm47XG4gIGF3YWl0IGZldGNoKGAvdHJhY2VzP25hbWU9JHtlbmNvZGVVUklDb21wb25lbnQoY2FsbE5hbWUpfS5qc29ubGAsIHsgbWV0aG9kOiBcIlBPU1RcIiwgYm9keTogbGluZXMuam9pbihcIlxcblwiKSArIFwiXFxuXCIgfSkuY2F0Y2goKCkgPT4ge30pO1xuICAkKFwidHJhY2VuYW1lXCIpLnRleHRDb250ZW50ID0gYHRyYWNlICR7Y2FsbE5hbWV9Lmpzb25sYDtcbn1cblxuLy8gXCJTdG9wXCIgYW5kIFwiZ29vZGJ5ZVwiIGhlYXJkIGJ5IHRoZSBicm93c2VyJ3Mgb3duIHJlY29nbml6ZXI6IHF1aWNrZXIgdGhhbiB0aGUgbW9kZWwncyB0cmFuc2NyaXB0LFxuLy8gYW5kIGl0IHdvcmtzIHdoaWxlIHRoZSBtb2RlbCdzIHJlcGx5IHBsYXlzIGV2ZW4gd2hlbiB0aGUgbW9kZWwgaXNuJ3QgaGVhcmluZyB0aGUgbWljcm9waG9uZS5cblxuY2xhc3MgU3RvcFdvcmRzIHtcbiAgcHJpdmF0ZSByZWM6IGFueSA9IG51bGw7XG4gIHByaXZhdGUgb24gPSBmYWxzZTtcbiAgcHJpdmF0ZSBjb21tYW5kcyA9IHsgc3RvcDogW10gYXMgc3RyaW5nW10sIGhhbmdVcDogW10gYXMgc3RyaW5nW10sIGNhbmNlbEFsbDogW10gYXMgc3RyaW5nW10gfTtcblxuICBnZXQgc3VwcG9ydGVkKCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiBcIndlYmtpdFNwZWVjaFJlY29nbml0aW9uXCIgaW4gd2luZG93IHx8IFwiU3BlZWNoUmVjb2duaXRpb25cIiBpbiB3aW5kb3c7XG4gIH1cblxuICBzdGFydCgpIHtcbiAgICBpZiAoIWNoZWNrZWQoXCJzdG9wd29yZFwiKSB8fCAhdGhpcy5zdXBwb3J0ZWQgfHwgIWNvcmUpIHJldHVybjtcbiAgICB0aGlzLmNvbW1hbmRzID0gSlNPTi5wYXJzZShjb3JlLmRlZmF1bHRzKCkpLnZvaWNlQ29tbWFuZHM7XG4gICAgY29uc3QgUmVjb2duaXRpb24gPSAod2luZG93IGFzIGFueSkuU3BlZWNoUmVjb2duaXRpb24gPz8gKHdpbmRvdyBhcyBhbnkpLndlYmtpdFNwZWVjaFJlY29nbml0aW9uO1xuICAgIHRoaXMucmVjID0gbmV3IFJlY29nbml0aW9uKCk7XG4gICAgdGhpcy5yZWMuY29udGludW91cyA9IHRydWU7XG4gICAgdGhpcy5yZWMuaW50ZXJpbVJlc3VsdHMgPSB0cnVlO1xuICAgIHRoaXMucmVjLmxhbmcgPSBuYXZpZ2F0b3IubGFuZ3VhZ2UgfHwgXCJlbi1HQlwiO1xuICAgIHRoaXMucmVjLm9ucmVzdWx0ID0gKGU6IGFueSkgPT4ge1xuICAgICAgZm9yIChsZXQgaSA9IGUucmVzdWx0SW5kZXg7IGkgPCBlLnJlc3VsdHMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgY29uc3QgdGV4dCA9IGUucmVzdWx0c1tpXVswXS50cmFuc2NyaXB0IGFzIHN0cmluZztcbiAgICAgICAgY29uc3QgY29tbWFuZCA9IGNvbW1hbmRJbih0ZXh0LCB0aGlzLmNvbW1hbmRzLCBbXCJXb29kaG91c2VcIiwgXCJIZXJtZXNcIiwgXCJCZW50b1wiXSk7XG4gICAgICAgIGlmIChjb21tYW5kID09PSBcInN0b3BcIiAmJiBhdWRpby5xdWV1ZWQgPiAwLjA1KSB7XG4gICAgICAgICAgbG9nKFwib3V0XCIsIGBsb2NhbCBzdG9wIHdvcmQ6ICR7dGV4dH1gLCBcIm91dFwiKTtcbiAgICAgICAgICB0b2FzdChgSGVhcmQgXHUyMDFDJHt0ZXh0LnRyaW0oKX1cdTIwMUQ6IHN0b3BwZWRgKTtcbiAgICAgICAgICBwdXNoKHsgdHlwZTogXCJpbnRlcnJ1cHRcIiB9KTtcbiAgICAgICAgfSBlbHNlIGlmIChjb21tYW5kID09PSBcImNhbmNlbEFsbFwiICYmIGUucmVzdWx0c1tpXS5pc0ZpbmFsKSB7XG4gICAgICAgICAgbG9nKFwib3V0XCIsIGBsb2NhbCBjYW5jZWwtYWxsOiAke3RleHR9YCwgXCJvdXRcIik7XG4gICAgICAgICAgcHVzaCh7IHR5cGU6IFwiY2FuY2VsQWxsXCIgfSk7XG4gICAgICAgICAgcHVzaCh7IHR5cGU6IFwiaW50ZXJydXB0XCIgfSk7XG4gICAgICAgIH0gZWxzZSBpZiAoY29tbWFuZCA9PT0gXCJoYW5nVXBcIiAmJiBlLnJlc3VsdHNbaV0uaXNGaW5hbCkge1xuICAgICAgICAgIGxvZyhcIm91dFwiLCBgbG9jYWwgaGFuZy11cDogJHt0ZXh0fWAsIFwib3V0XCIpO1xuICAgICAgICAgIGhhbmdVcCgpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfTtcbiAgICB0aGlzLnJlYy5vbmVuZCA9ICgpID0+IHsgaWYgKHRoaXMub24pIHNldFRpbWVvdXQoKCkgPT4geyB0cnkgeyB0aGlzLnJlYz8uc3RhcnQoKTsgfSBjYXRjaCB7fSB9LCAyNTApOyB9O1xuICAgIHRoaXMucmVjLm9uZXJyb3IgPSAoZTogYW55KSA9PiB7IGlmIChlLmVycm9yID09PSBcIm5vdC1hbGxvd2VkXCIpIHRoaXMub24gPSBmYWxzZTsgfTtcbiAgICB0aGlzLm9uID0gdHJ1ZTtcbiAgICB0cnkgeyB0aGlzLnJlYy5zdGFydCgpOyB9IGNhdGNoIHt9XG4gIH1cblxuICBzdG9wKCkge1xuICAgIHRoaXMub24gPSBmYWxzZTtcbiAgICB0cnkgeyB0aGlzLnJlYz8uc3RvcCgpOyB9IGNhdGNoIHt9XG4gICAgdGhpcy5yZWMgPSBudWxsO1xuICB9XG59XG5jb25zdCBzdG9wV29yZHMgPSBuZXcgU3RvcFdvcmRzKCk7XG5cbi8vIFdpcmluZy5cblxuZnVuY3Rpb24gc2V0dGluZ3NGcm9tU3RvcmFnZSgpIHtcbiAgZm9yIChjb25zdCBpZCBvZiBbXCJhZWNcIiwgXCJzdG9wd29yZFwiLCBcInB0dFwiLCBcImNhcHRpb25zXCIsIFwiY29kaW5nXCIsIFwiZmFrZWhlcm1lc1wiLCBcInRyYWNlXCJdKSB7XG4gICAgY29uc3QgdiA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKGB2b2ljZS4ke2lkfWApO1xuICAgIGlmICh2ICE9IG51bGwpICQ8SFRNTElucHV0RWxlbWVudD4oaWQpLmNoZWNrZWQgPSB2ID09PSBcIjFcIjtcbiAgICAkKGlkKS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IGxvY2FsU3RvcmFnZS5zZXRJdGVtKGB2b2ljZS4ke2lkfWAsIGNoZWNrZWQoaWQpID8gXCIxXCIgOiBcIjBcIikpO1xuICB9XG4gIGNvbnN0IGRlbGF5ID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS5mYWtlZGVsYXlcIik7XG4gIGlmIChkZWxheSkgJDxIVE1MSW5wdXRFbGVtZW50PihcImZha2VkZWxheVwiKS52YWx1ZSA9IGRlbGF5O1xuICAkKFwiZmFrZWRlbGF5XCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4gbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS5mYWtlZGVsYXlcIiwgJDxIVE1MSW5wdXRFbGVtZW50PihcImZha2VkZWxheVwiKS52YWx1ZSkpO1xuICBjb25zdCB2b2ljZSA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2Uudm9pY2VcIik7XG4gIGlmICh2b2ljZSkgJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJ2b2ljZVwiKS52YWx1ZSA9IHZvaWNlO1xuICAkKFwidm9pY2VcIikuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLnZvaWNlXCIsICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwidm9pY2VcIikudmFsdWUpKTtcbiAgY29uc3QgbW9kZSA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UubW9kZVwiKTtcbiAgaWYgKG1vZGUpICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwibW9kZVwiKS52YWx1ZSA9IG1vZGU7XG4gICQoXCJtb2RlXCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4ge1xuICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2UubW9kZVwiLCAkPEhUTUxTZWxlY3RFbGVtZW50PihcIm1vZGVcIikudmFsdWUpO1xuICAgIHN5bmNDb21wb3NlcigpO1xuICB9KTtcbiAgY29uc3QgdGhlbWUgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLnRoZW1lXCIpID8/IFwic3lzdGVtXCI7XG4gIGFwcGx5VGhlbWUodGhlbWUpO1xuICBmb3IgKGNvbnN0IGJ0biBvZiBBcnJheS5mcm9tKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiI3RoZW1lLXBpY2tlciBidXR0b25cIikpKSB7XG4gICAgYnRuLm9uY2xpY2sgPSAoKSA9PiB7XG4gICAgICBjb25zdCBjaG9pY2UgPSBidG4uZGF0YXNldC50aGVtZSA/PyBcInN5c3RlbVwiO1xuICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS50aGVtZVwiLCBjaG9pY2UpO1xuICAgICAgYXBwbHlUaGVtZShjaG9pY2UpO1xuICAgIH07XG4gIH1cbiAgbWF0Y2hNZWRpYShcIihwcmVmZXJzLWNvbG9yLXNjaGVtZTogZGFyaylcIikuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiB7XG4gICAgaWYgKChsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLnRoZW1lXCIpID8/IFwic3lzdGVtXCIpID09PSBcInN5c3RlbVwiKSBhcHBseVRoZW1lKFwic3lzdGVtXCIpO1xuICB9KTtcbn1cblxuY29uc3QgbW9iaWxlTGF5b3V0ID0gbWF0Y2hNZWRpYShcIihtYXgtd2lkdGg6IDkyMHB4KVwiKTtcbmxldCBkcmF3ZXJPcGVuZXI6IEhUTUxFbGVtZW50IHwgbnVsbCA9IG51bGw7XG5cbmZ1bmN0aW9uIHNldFRhc2tzT3BlbihvcGVuOiBib29sZWFuLCBvcGVuZXI/OiBIVE1MRWxlbWVudCB8IG51bGwpIHtcbiAgY29uc3QgY2FuT3BlbiA9IG1vYmlsZUxheW91dC5tYXRjaGVzICYmICEkKFwidGFsa1wiKS5oaWRkZW47XG4gIGNvbnN0IG5leHQgPSBvcGVuICYmIGNhbk9wZW47XG4gIGNvbnN0IHdhc09wZW4gPSBkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5jb250YWlucyhcInRhc2tzLW9wZW5cIik7XG4gIGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LnRvZ2dsZShcInRhc2tzLW9wZW5cIiwgbmV4dCk7XG4gIGNvbnN0IGhlYWRlciA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoXCJoZWFkZXJcIikgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAoaGVhZGVyKSBoZWFkZXIuaW5lcnQgPSBuZXh0O1xuICAkKFwiY29udm9cIikuaW5lcnQgPSBuZXh0O1xuICAkKFwic2lkZVwiKS5pbmVydCA9IG1vYmlsZUxheW91dC5tYXRjaGVzICYmICFuZXh0O1xuICAkKFwidGFza3MtdG9nZ2xlXCIpLnNldEF0dHJpYnV0ZShcImFyaWEtZXhwYW5kZWRcIiwgU3RyaW5nKG5leHQpKTtcbiAgJChcIm1vYmlsZS10YXNrcy1iYXJcIikuc2V0QXR0cmlidXRlKFwiYXJpYS1leHBhbmRlZFwiLCBTdHJpbmcobmV4dCkpO1xuICBpZiAobmV4dCAmJiAhd2FzT3Blbikge1xuICAgIGRyYXdlck9wZW5lciA9IG9wZW5lciA/PyAoZG9jdW1lbnQuYWN0aXZlRWxlbWVudCBhcyBIVE1MRWxlbWVudCB8IG51bGwpO1xuICAgICQoXCJ0YXNrcy1jbG9zZVwiKS5mb2N1cygpO1xuICB9IGVsc2UgaWYgKCFuZXh0ICYmIHdhc09wZW4pIHtcbiAgICBjb25zdCB0YXJnZXQgPSBkcmF3ZXJPcGVuZXI7XG4gICAgZHJhd2VyT3BlbmVyID0gbnVsbDtcbiAgICBpZiAodGFyZ2V0ICYmIHRhcmdldC5pc0Nvbm5lY3RlZCAmJiAhdGFyZ2V0LmhpZGRlbiAmJiB0YXJnZXQub2Zmc2V0UGFyZW50ICE9PSBudWxsKSB0YXJnZXQuZm9jdXMoKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB0YWJzKCkge1xuICBjb25zdCB2aWV3czogUmVjb3JkPHN0cmluZywgSFRNTEVsZW1lbnQ+ID0geyB0YWxrOiAkKFwidGFsa1wiKSwgZGV2OiAkKFwiZGV2XCIpLCByZXBsYXk6ICQoXCJyZXBsYXltYWluXCIpIH07XG4gIGZvciAoY29uc3QgbmFtZSBvZiBPYmplY3Qua2V5cyh2aWV3cykpIHtcbiAgICAkKGB0YWItJHtuYW1lfWApLm9uY2xpY2sgPSAoKSA9PiB7XG4gICAgICBmb3IgKGNvbnN0IFtvdGhlciwgZWxdIG9mIE9iamVjdC5lbnRyaWVzKHZpZXdzKSkge1xuICAgICAgICBlbC5oaWRkZW4gPSBvdGhlciAhPT0gbmFtZTtcbiAgICAgICAgJChgdGFiLSR7b3RoZXJ9YCkuY2xhc3NMaXN0LnRvZ2dsZShcIm9uXCIsIG90aGVyID09PSBuYW1lKTtcbiAgICAgIH1cbiAgICAgICQoXCJ0YXNrcy10b2dnbGVcIikuaGlkZGVuID0gbmFtZSAhPT0gXCJ0YWxrXCI7XG4gICAgICBzZXRUYXNrc09wZW4oZmFsc2UpO1xuICAgIH07XG4gIH1cbiAgJChcImdlYXJcIikub25jbGljayA9ICgpID0+IHsgJChcInNldHRpbmdzXCIpLmhpZGRlbiA9IGZhbHNlOyB9O1xuICAkKFwiY2xvc2VzZXR0aW5nc1wiKS5vbmNsaWNrID0gKCkgPT4geyAkKFwic2V0dGluZ3NcIikuaGlkZGVuID0gdHJ1ZTsgfTtcbiAgJChcImNsb3Nlc2V0dGluZ3MteFwiKS5vbmNsaWNrID0gKCkgPT4geyAkKFwic2V0dGluZ3NcIikuaGlkZGVuID0gdHJ1ZTsgfTtcbiAgJChcInNldHRpbmdzXCIpLm9uY2xpY2sgPSAoZSkgPT4geyBpZiAoZS50YXJnZXQgPT09ICQoXCJzZXR0aW5nc1wiKSkgJChcInNldHRpbmdzXCIpLmhpZGRlbiA9IHRydWU7IH07XG4gICQoXCJ0YXNrcy10b2dnbGVcIikub25jbGljayA9ICgpID0+IHNldFRhc2tzT3BlbighZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QuY29udGFpbnMoXCJ0YXNrcy1vcGVuXCIpLCAkKFwidGFza3MtdG9nZ2xlXCIpKTtcbiAgJChcIm1vYmlsZS10YXNrcy1iYXJcIikub25jbGljayA9ICgpID0+IHNldFRhc2tzT3Blbih0cnVlLCAkKFwibW9iaWxlLXRhc2tzLWJhclwiKSk7XG4gICQoXCJ0YXNrcy1jbG9zZVwiKS5vbmNsaWNrID0gKCkgPT4gc2V0VGFza3NPcGVuKGZhbHNlKTtcbiAgJChcInNpZGUtYmFja2Ryb3BcIikub25jbGljayA9ICgpID0+IHNldFRhc2tzT3BlbihmYWxzZSk7XG4gIG1vYmlsZUxheW91dC5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHNldFRhc2tzT3BlbihmYWxzZSkpO1xuICBzZXRUYXNrc09wZW4oZmFsc2UpO1xufVxuXG5mdW5jdGlvbiB0eXBpbmcoKTogYm9vbGVhbiB7XG4gIGNvbnN0IGVsID0gZG9jdW1lbnQuYWN0aXZlRWxlbWVudCBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gIHJldHVybiAhIWVsICYmIChlbC50YWdOYW1lID09PSBcIklOUFVUXCIgfHwgZWwudGFnTmFtZSA9PT0gXCJURVhUQVJFQVwiIHx8IGVsLnRhZ05hbWUgPT09IFwiU0VMRUNUXCIgfHwgZWwuaXNDb250ZW50RWRpdGFibGUpO1xufVxuXG5mdW5jdGlvbiBrZXlzKCkge1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCAoZSkgPT4ge1xuICAgIGlmIChlLmtleSA9PT0gXCJFc2NhcGVcIikge1xuICAgICAgaWYgKCEkKFwic2V0dGluZ3NcIikuaGlkZGVuKSB7ICQoXCJzZXR0aW5nc1wiKS5oaWRkZW4gPSB0cnVlOyByZXR1cm47IH1cbiAgICAgIGlmIChkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5jb250YWlucyhcInRhc2tzLW9wZW5cIikgJiYgbW9iaWxlTGF5b3V0Lm1hdGNoZXMgJiYgISQoXCJ0YWxrXCIpLmhpZGRlbikgeyBzZXRUYXNrc09wZW4oZmFsc2UpOyByZXR1cm47IH1cbiAgICAgIGlmIChjYWxsSWQpIHsgcHVzaCh7IHR5cGU6IFwiaW50ZXJydXB0XCIgfSk7IGF1ZGlvLmZsdXNoKCk7IHJldHVybjsgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAodHlwaW5nKCkgfHwgISQoXCJzZXR0aW5nc1wiKS5oaWRkZW4gfHwgZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QuY29udGFpbnMoXCJ0YXNrcy1vcGVuXCIpIHx8IGUubWV0YUtleSB8fCBlLmN0cmxLZXkgfHwgZS5hbHRLZXkpIHJldHVybjtcbiAgICBpZiAoZS5rZXkgPT09IFwibVwiIHx8IGUua2V5ID09PSBcIk1cIikgeyBzZXRNdXRlZCghbXV0ZWQpOyBlLnByZXZlbnREZWZhdWx0KCk7IH1cbiAgICBlbHNlIGlmIChlLmtleSA9PT0gXCIvXCIpIHsgJChcInRleHRcIikuZm9jdXMoKTsgZS5wcmV2ZW50RGVmYXVsdCgpOyB9XG4gICAgZWxzZSBpZiAoZS5jb2RlID09PSBcIlNwYWNlXCIgJiYgY2FsbElkICYmIG11dGVkICYmICFlLnJlcGVhdCkgeyBob2xkaW5nID0gdHJ1ZTsgcHVzaCh7IHR5cGU6IFwidW5tdXRlXCIgfSk7IHNob3dTdGF0dXMoKTsgZS5wcmV2ZW50RGVmYXVsdCgpOyB9XG4gIH0pO1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5dXBcIiwgKGUpID0+IHtcbiAgICBpZiAoZS5jb2RlID09PSBcIlNwYWNlXCIgJiYgaG9sZGluZykgeyBob2xkaW5nID0gZmFsc2U7IHB1c2goeyB0eXBlOiBcIm11dGVcIiB9KTsgc2hvd1N0YXR1cygpOyB9XG4gIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBzdWJtaXRUZXh0KGU6IEV2ZW50KSB7XG4gIGUucHJldmVudERlZmF1bHQoKTtcbiAgY29uc3QgaW5wdXQgPSAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwidGV4dFwiKTtcbiAgbGV0IHRleHQgPSBpbnB1dC52YWx1ZS50cmltKCk7XG4gIGlmICghdGV4dCkgcmV0dXJuO1xuICAvLyBXaXRoIG5vIGNhbGwgb24sIHR5cGluZyBzdGFydHMgYSBjaGF0OiB0aGUgc2FtZSBtYWluIHRocmVhZCwgaW4gdGV4dC5cbiAgaWYgKCFjYWxsSWQpIHtcbiAgICBpbnB1dC52YWx1ZSA9IFwiXCI7XG4gICAgc3luY0NvbXBvc2VyKCk7XG4gICAgdHJ5IHsgYXdhaXQgc3RhcnQoZmFsc2UsIHRydWUpOyB9IGNhdGNoIChlcnIpIHsgdG9hc3QoKGVyciBhcyBFcnJvcikubWVzc2FnZSk7IGxvZyhcImVycm9yXCIsIChlcnIgYXMgRXJyb3IpLm1lc3NhZ2UsIFwiZXJyXCIpOyB9XG4gICAgaWYgKCFjYWxsSWQpIHsgaW5wdXQudmFsdWUgPSB0ZXh0OyBzeW5jQ29tcG9zZXIoKTsgcmV0dXJuOyB9XG4gIH1cbiAgLy8gXCIvdDMgXHUyMDI2XCIgYW5kIFwiL2ggXHUyMDI2XCIgcGljayB0aGUgYWdlbnQgd2hhdGV2ZXIgdGhlIHNlbGVjdG9yIHNheXMuXG4gIGNvbnN0IHBhcnNlZCA9IHBhcnNlUHJlZml4KHRleHQpO1xuICBjb25zdCBtb2RlID0gcGFyc2VkLm1vZGUgPz8gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJtb2RlXCIpLnZhbHVlO1xuICB0ZXh0ID0gcGFyc2VkLnJlc3Q7XG4gIGlmICghdGV4dCkgcmV0dXJuO1xuICBpZiAobW9kZSA9PT0gXCJzYXlcIikge1xuICAgIHB1c2goeyB0eXBlOiBcInNheVwiLCB0ZXh0IH0pO1xuICAgIHNjcm9sbERvd24odHJ1ZSk7XG4gIH0gZWxzZSB7XG4gICAgcHVzaCh7IHR5cGU6IFwiYXNrXCIsIHRleHQsIGFnZW50OiBtb2RlIH0pO1xuICAgIG5vdGUoYFlvdSBcdTIxOTIgbmV3ICR7bW9kZSA9PT0gXCJ0M1wiID8gXCJjb2RpbmdcIiA6IFwiSGVybWVzXCJ9IHRhc2s6ICR7dGV4dH1gKTtcbiAgICBzY3JvbGxEb3duKHRydWUpO1xuICB9XG4gIGlucHV0LnZhbHVlID0gXCJcIjtcbiAgc3luY0NvbXBvc2VyKCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIG1haW4oKSB7XG4gIGFwcGx5VGhlbWUobG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS50aGVtZVwiKSA/PyBcInN5c3RlbVwiKTtcbiAgc2VydmVyID0gYXdhaXQgKGF3YWl0IGZldGNoKFwiL2NvbmZpZ1wiKSkuanNvbigpO1xuICAkKFwicm91dGVcIikudGV4dENvbnRlbnQgPSBgJHtzZXJ2ZXIucm91dGUgPT09IFwidmVydGV4XCIgPyBcIlZlcnRleFwiIDogXCJHZW1pbmkgQVBJXCJ9IFx1MDBCNyAke3NlcnZlci5tb2RlbC5zcGxpdChcIi9cIikucG9wKCl9YDtcbiAgJChcInZlcnNpb25cIikudGV4dENvbnRlbnQgPSBzZXJ2ZXIudmVyc2lvbjtcbiAgJChcImJ1aWxkXCIpLnRleHRDb250ZW50ID0gYGNvcmUgJHtzZXJ2ZXIudmVyc2lvbn1gO1xuICBzZXR0aW5nc0Zyb21TdG9yYWdlKCk7XG4gIGlmICghc2VydmVyLmhlcm1lcykgeyAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwiZmFrZWhlcm1lc1wiKS5jaGVja2VkID0gdHJ1ZTsgJDxIVE1MSW5wdXRFbGVtZW50PihcImZha2VoZXJtZXNcIikuZGlzYWJsZWQgPSB0cnVlOyB9XG4gIGlmICghc2VydmVyLnQzKSAkKFwiY29kaW5naGVscFwiKS50ZXh0Q29udGVudCA9IFwiVDMgaXNuJ3QgYXZhaWxhYmxlIG9uIHRoZSBzZXJ2ZXI6IG9ubHkgd2l0aCBmYWtlIGFuc3dlcnMuXCI7XG4gIGVsc2UgJChcImNvZGluZ2hlbHBcIikudGV4dENvbnRlbnQgPSBgQ29kZSBjaGFuZ2VzIGdvIHRvIGEgVDMgQ29kZSB0aHJlYWQgaW4gb25lIG9mOiAke3NlcnZlci50My5qb2luKFwiLCBcIil9LmA7XG4gIGlmICghc3RvcFdvcmRzLnN1cHBvcnRlZCkgeyAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwic3RvcHdvcmRcIikuY2hlY2tlZCA9IGZhbHNlOyAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwic3RvcHdvcmRcIikuZGlzYWJsZWQgPSB0cnVlOyB9XG4gIGNvbnN0IHByZXNldCA9ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwicHJlc2V0XCIpO1xuICBmb3IgKGNvbnN0IG5hbWUgb2YgT2JqZWN0LmtleXMoUFJFU0VUUykpIHByZXNldC5hZGQobmV3IE9wdGlvbihuYW1lLCBuYW1lKSk7XG4gIHByZXNldC52YWx1ZSA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UtY29yZS5wcmVzZXRcIikgPz8gXCJ3ZWJcIjtcbiAgaWYgKCFQUkVTRVRTW3ByZXNldC52YWx1ZV0pIHByZXNldC52YWx1ZSA9IFwid2ViXCI7XG4gICQ8SFRNTFRleHRBcmVhRWxlbWVudD4oXCJjb25maWdcIikudmFsdWUgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLWNvcmUuY29uZmlnXCIpID8/IEpTT04uc3RyaW5naWZ5KFBSRVNFVFNbcHJlc2V0LnZhbHVlXSwgbnVsbCwgMik7XG4gIHByZXNldC5vbmNoYW5nZSA9ICgpID0+IHtcbiAgICAkPEhUTUxUZXh0QXJlYUVsZW1lbnQ+KFwiY29uZmlnXCIpLnZhbHVlID0gSlNPTi5zdHJpbmdpZnkoUFJFU0VUU1twcmVzZXQudmFsdWVdLCBudWxsLCAyKTtcbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLWNvcmUucHJlc2V0XCIsIHByZXNldC52YWx1ZSk7XG4gICAgbG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oXCJ2b2ljZS1jb3JlLmNvbmZpZ1wiKTtcbiAgfTtcbiAgJChcImNvbmZpZ1wiKS5vbmlucHV0ID0gKCkgPT4gbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS1jb3JlLmNvbmZpZ1wiLCAkPEhUTUxUZXh0QXJlYUVsZW1lbnQ+KFwiY29uZmlnXCIpLnZhbHVlKTtcbiAgJChcImRlZmF1bHRzXCIpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYyA9IGNvcmUgPz8gKGF3YWl0IGxvYWRDb3JlKCkpO1xuICAgICQoXCJkZWZhdWx0c3ZpZXdcIikudGV4dENvbnRlbnQgPSBKU09OLnN0cmluZ2lmeShKU09OLnBhcnNlKGMuZGVmYXVsdHMoKSksIG51bGwsIDIpO1xuICAgICQoXCJkZWZhdWx0c3ZpZXdcIikuaGlkZGVuID0gISQoXCJkZWZhdWx0c3ZpZXdcIikuaGlkZGVuO1xuICB9O1xuICBjb25zdCBvbkNhbGxDbGljayA9ICgpID0+IHZvaWQgY2FsbEJ1dHRvbigpLmNhdGNoKChlcnIpID0+IHsgdG9hc3QoZXJyLm1lc3NhZ2UpOyBsb2coXCJlcnJvclwiLCBlcnIubWVzc2FnZSwgXCJlcnJcIik7IH0pO1xuICBjb25zdCBvbkhlcm9DYWxsQ2xpY2sgPSAoKSA9PiB7IGlmICghY2FsbElkKSB2b2lkIHN0YXJ0KCkuY2F0Y2goKGVycikgPT4geyB0b2FzdChlcnIubWVzc2FnZSk7IGxvZyhcImVycm9yXCIsIGVyci5tZXNzYWdlLCBcImVyclwiKTsgfSk7IH07XG4gIGNvbnN0IG9uUmVzdW1lQ2xpY2sgPSAoKSA9PiB2b2lkIHN0YXJ0KHRydWUpLmNhdGNoKChlcnIpID0+IHsgdG9hc3QoZXJyLm1lc3NhZ2UpOyBsb2coXCJlcnJvclwiLCBlcnIubWVzc2FnZSwgXCJlcnJcIik7IH0pO1xuICAkKFwiY2FsbFwiKS5vbmNsaWNrID0gb25DYWxsQ2xpY2s7XG4gICQoXCJoZXJvLWNhbGxcIikub25jbGljayA9IG9uSGVyb0NhbGxDbGljaztcbiAgJChcInJlc3VtZVwiKS5vbmNsaWNrID0gb25SZXN1bWVDbGljaztcbiAgJChcImhlcm8tcmVzdW1lXCIpLm9uY2xpY2sgPSBvblJlc3VtZUNsaWNrO1xuICBpZiAoc2F2ZWRIaXN0b3J5KCkubGVuZ3RoID4gMCkge1xuICAgIHN5bmNSZXN1bWVCdXR0b25zKHRydWUpO1xuICAgICQoXCJyZXN1bWVcIikudGl0bGUgPSBcIkNhbGwgYWdhaW4sIGNhcnJ5aW5nIG9uIGZyb20gdGhlIGxhc3QgY29udmVyc2F0aW9uXCI7XG4gIH1cbiAgJChcIm1pY1wiKS5vbmNsaWNrID0gKCkgPT4gc2V0TXV0ZWQoIW11dGVkKTtcbiAgJChcImh1c2hcIikub25jbGljayA9ICgpID0+IHsgcHVzaCh7IHR5cGU6IFwiaW50ZXJydXB0XCIgfSk7IGF1ZGlvLmZsdXNoKCk7IH07XG4gICQoXCJjYW5jZWxhbGxcIikub25jbGljayA9ICgpID0+IHB1c2goeyB0eXBlOiBcImNhbmNlbEFsbFwiIH0pO1xuICAkKFwiZG9uZWJveFwiKS5hZGRFdmVudExpc3RlbmVyKFwidG9nZ2xlXCIsICgpID0+IHsgaWYgKCQ8SFRNTERldGFpbHNFbGVtZW50PihcImRvbmVib3hcIikub3BlbikgJChcImRvbmVib3hcIikuc2Nyb2xsSW50b1ZpZXcoeyBibG9jazogXCJuZWFyZXN0XCIgfSk7IH0pO1xuICAkKFwic2F5XCIpLm9uc3VibWl0ID0gKGUpID0+IHZvaWQgc3VibWl0VGV4dChlKTtcbiAgJChcInRleHRcIikuYWRkRXZlbnRMaXN0ZW5lcihcImlucHV0XCIsIHN5bmNDb21wb3Nlcik7XG4gIGNvbnN0IHRyYW5zY3JpcHRQYW5lID0gJChcInRyYW5zY3JpcHRcIik7XG4gIHRyYW5zY3JpcHRQYW5lLmFkZEV2ZW50TGlzdGVuZXIoXCJzY3JvbGxcIiwgKCkgPT4gdHJhbnNjcmlwdFNjcm9sbC5vblNjcm9sbCgpLCB7IHBhc3NpdmU6IHRydWUgfSk7XG4gIHRyYW5zY3JpcHRQYW5lLmFkZEV2ZW50TGlzdGVuZXIoXCJzY3JvbGxlbmRcIiwgKCkgPT4gdHJhbnNjcmlwdFNjcm9sbC5vblNjcm9sbEVuZCgpLCB7IHBhc3NpdmU6IHRydWUgfSk7XG4gIHRyYW5zY3JpcHRQYW5lLmFkZEV2ZW50TGlzdGVuZXIoXCJ3aGVlbFwiLCAoZSkgPT4geyBpZiAoZS5kZWx0YVkgPCAwKSB0cmFuc2NyaXB0U2Nyb2xsLmNhbmNlbEp1bXAoKTsgfSwgeyBwYXNzaXZlOiB0cnVlIH0pO1xuICB0cmFuc2NyaXB0UGFuZS5hZGRFdmVudExpc3RlbmVyKFwidG91Y2hzdGFydFwiLCAoKSA9PiB0cmFuc2NyaXB0U2Nyb2xsLmNhbmNlbEp1bXAoKSwgeyBwYXNzaXZlOiB0cnVlIH0pO1xuICBpZiAodHlwZW9mIFJlc2l6ZU9ic2VydmVyICE9PSBcInVuZGVmaW5lZFwiKSBuZXcgUmVzaXplT2JzZXJ2ZXIoKCkgPT4gdHJhbnNjcmlwdFNjcm9sbC5vblJlc2l6ZSgpKS5vYnNlcnZlKHRyYW5zY3JpcHRQYW5lKTtcbiAgJChcImp1bXBib3R0b21cIikub25jbGljayA9ICgpID0+IHRyYW5zY3JpcHRTY3JvbGwuanVtcFRvQm90dG9tKCk7XG4gIHN5bmNDb21wb3NlcigpO1xuICB0YWJzKCk7XG4gIGtleXMoKTtcbiAgY29uc3QgZXZlbnRzID0gbmV3IEV2ZW50U291cmNlKFwiL2V2ZW50c1wiKTtcbiAgZXZlbnRzLmFkZEV2ZW50TGlzdGVuZXIoXCJjb3JlXCIsIChlKSA9PiB7XG4gICAgY29uc3QgeyB2ZXJzaW9uIH0gPSBKU09OLnBhcnNlKChlIGFzIE1lc3NhZ2VFdmVudCkuZGF0YSk7XG4gICAgJChcInZlcnNpb25cIikudGV4dENvbnRlbnQgPSB2ZXJzaW9uICsgKGNhbGxJZCAmJiBjb3JlICYmIGNvcmUudmVyc2lvbiAhPT0gdmVyc2lvbiA/IGAgKG5leHQgY2FsbDsgdGhpcyBvbmUgcnVucyAke2NvcmUudmVyc2lvbn0pYCA6IFwiXCIpO1xuICAgICQoXCJidWlsZFwiKS50ZXh0Q29udGVudCA9IGBjb3JlICR7dmVyc2lvbn1gO1xuICB9KTtcbiAgZXZlbnRzLmFkZEV2ZW50TGlzdGVuZXIoXCJhcHBcIiwgKCkgPT4geyBpZiAoIWNhbGxJZCkgbG9jYXRpb24ucmVsb2FkKCk7IGVsc2UgdG9hc3QoXCJUaGUgcGFnZSBjaGFuZ2VkOiByZWxvYWQgYWZ0ZXIgdGhpcyBjYWxsXCIpOyB9KTtcbiAgZXZlbnRzLmFkZEV2ZW50TGlzdGVuZXIoXCJlcnJvclwiLCAoZSkgPT4ge1xuICAgIGNvbnN0IGRhdGEgPSAoZSBhcyBNZXNzYWdlRXZlbnQpLmRhdGE7XG4gICAgaWYgKGRhdGEpIHRvYXN0KGBCdWlsZCBmYWlsZWQ6ICR7SlNPTi5wYXJzZShkYXRhKS5tZXNzYWdlfWApO1xuICB9KTtcbiAgbmV3IFJlcGxheSgkKFwicmVwbGF5XCIpLCBsb2FkQ29yZSk7XG4gIHZvaWQgcGluZygpO1xuICB2b2lkIHNob3dFYXJsaWVyKCk7XG4gIHdpbmRvdy5zZXRJbnRlcnZhbCgoKSA9PiB2b2lkIHNo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SSxNQUFFLE9BQU8sRUFBRSxjQUFjLFFBQVEsT0FBTztBQUFBLEVBQzFDLENBQUM7QUFDRCxTQUFPLGlCQUFpQixPQUFPLE1BQU07QUFBRSxRQUFJLENBQUMsT0FBUSxVQUFTLE9BQU87QUFBQSxRQUFRLE9BQU0sMENBQTBDO0FBQUEsRUFBRyxDQUFDO0FBQ2hJLFNBQU8saUJBQWlCLFNBQVMsQ0FBQyxNQUFNO0FBQ3RDLFVBQU0sT0FBUSxFQUFtQjtBQUNqQyxRQUFJLEtBQU0sT0FBTSxpQkFBaUIsS0FBSyxNQUFNLElBQUksRUFBRSxPQUFPLEVBQUU7QUFBQSxFQUM3RCxDQUFDO0FBQ0QsTUFBSSxPQUFPLEVBQUUsUUFBUSxHQUFHLFFBQVE7QUFDaEMsT0FBSyxLQUFLO0FBQ1YsT0FBSyxZQUFZO0FBQ2pCLFNBQU8sWUFBWSxNQUFNLEtBQUssWUFBWSxHQUFHLEdBQU07QUFDckQ7QUFFQSxLQUFLLEtBQUs7IiwKICAibmFtZXMiOiBbImNvcmUiLCAiY29yZSIsICJub3ciLCAibGl2ZSIsICJsaW5lIiwgInJ1biJdCn0K
