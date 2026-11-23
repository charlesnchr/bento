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
function updateJumpButton() {
  const pane = $("transcript");
  const away = pane.scrollHeight - pane.scrollTop - pane.clientHeight > 120;
  $("jumpbottom").hidden = !away || !$("empty").hidden;
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
function scrollDown(force = false) {
  const pane = $("transcript");
  if (force || pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 80) pane.scrollTop = pane.scrollHeight;
  updateJumpButton();
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
  scrollDown(role === "user");
}
function caption(text) {
  const pane = $("transcript");
  let row = document.getElementById("caption");
  if (text == null) {
    row?.remove();
    updateJumpButton();
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
  scrollDown(true);
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
  const overflows = entry.body.scrollHeight > resultClampPx(entry.card) + 6;
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
    const canFollow = Boolean(callId && entry.taskId && tasks.has(entry.taskId));
    entry.followBtn.hidden = !canFollow;
    if (!canFollow) entry.card.querySelector("form")?.remove();
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
function result(agent, label, text, failed = false, taskId) {
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
      const view = tasks.get(taskId);
      if (view) followUpForm(card, view.c);
    };
    foot.append(followBtn);
  }
  card.append(head, body, foot);
  const entry = { id, agent, label, text, failed, taskId, card, head, body, moreBtn, followBtn, refRow };
  const toggle = () => {
    if (!entry.card.classList.contains("clamped")) return;
    setResultOpen(entry, !entry.card.classList.contains("open"));
  };
  head.onclick = toggle;
  moreBtn.onclick = toggle;
  results.set(id, entry);
  $("results").prepend(card);
  if (mobileLayout.matches && !document.body.classList.contains("tasks-open")) unreadMobileResults++;
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
function setSideFilter(filter) {
  sideFilter = normalizeSideFilter(filter);
  for (const btn of Array.from(document.querySelectorAll("#side-tabs button"))) {
    const on = btn.dataset.filter === sideFilter;
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-selected", String(on));
  }
  syncSideLayout();
  requestAnimationFrame(() => updateAllResultClamping());
}
function syncSideLayout() {
  const all = [...tasks.values()];
  const activeCurrent = all.filter((t) => live(t.c.state)).length;
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
  const activeCurrent = all.filter((t) => live(t.c.state) || Boolean(t.approval)).length;
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
  const activeCount = all.filter((t) => live(t.c.state)).length;
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
    if (callId) {
      button(waiting ? "Answer" : "Follow up", () => followUpForm(card, t));
      if (t.state === "running") button("Cancel", () => push({ type: "cancelTask", task: t.id }), "danger");
    }
    if (view.resultId) button("Result", () => focusResult(view.resultId));
    if (view.thread) button("Copy id", () => {
      void navigator.clipboard?.writeText(view.thread);
      toast("Thread id copied");
    });
    if (acts.childElementCount) card.append(acts);
    (live(t.state) ? pane : done).append(card);
  }
  if (pane.childElementCount === 0) pane.append(noTasks);
  syncSideLayout();
  updateTaskChrome();
}
function followUpForm(card, t) {
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
      push({ type: "steer", task: t.id, text });
      note(`You \u2192 ${t.label}: ${text}`);
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
  log("out", `${agent} ${c.followUp ? "follow-up" : "task"} "${c.label}"${c.project ? ` in ${c.project}` : ""}: ${c.request}`, "out");
  const abort = new AbortController();
  runs.set(c.run, { abort, agent, taskId: c.taskId });
  const done = (text, failed = false) => {
    if (!runs.has(c.run)) return;
    runs.delete(c.run);
    const view = tasks.get(c.taskId);
    const resId = result(agent, c.label, text, failed, c.taskId);
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
    unreadMobileResults = 0;
    updateTaskChrome();
    drawerOpener = opener ?? document.activeElement;
    $("tasks-close").focus();
    requestAnimationFrame(() => updateAllResultClamping());
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
  $("tasks-toggle").onclick = () => setTasksOpen(!document.body.classList.contains("tasks-open"), $("tasks-toggle"));
  $("mobile-tasks-bar").onclick = () => setTasksOpen(true, $("mobile-tasks-bar"));
  $("tasks-close").onclick = () => setTasksOpen(false);
  $("side-backdrop").onclick = () => setTasksOpen(false);
  mobileLayout.addEventListener("change", () => {
    if (!mobileLayout.matches) unreadMobileResults = 0;
    setTasksOpen(false);
    updateTaskChrome();
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
  if (mode === "say") push({ type: "say", text });
  else {
    push({ type: "ask", text, agent: mode });
    note(`You \u2192 new ${mode === "t3" ? "coding" : "Hermes"} task: ${text}`);
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
  $("transcript").addEventListener("scroll", updateJumpButton, { passive: true });
  $("jumpbottom").onclick = () => $("transcript").scrollTo({ top: $("transcript").scrollHeight, behavior: "smooth" });
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => updateAllResultClamping()).observe($("results"));
  }
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL2NvbW1hbmRzLnRzIiwgIi4uL2F1ZGlvLnRzIiwgIi4uL3JlcGxheS50cyIsICIuLi91aS50cyIsICIuLi9hcHAudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFNwb2tlbiBjb21tYW5kcyB0aGUgY29yZSBhY3RzIG9uIHdpdGhvdXQgdGhlIG1vZGVsOiBcInN0b3BcIiBhbmQgXCJoYW5nIHVwXCIuIEFuIHV0dGVyYW5jZSBjb3VudHNcbi8vIG9ubHkgd2hlbiBpdCBpcyBvbmUgb2YgdGhlIHBocmFzZXMgYW5kIG5vdGhpbmcgbW9yZSwgb25jZSBuYW1lcyBhbmQgZmlsbGVycyBhcm91bmQgaXQgYXJlIGdvbmUsXG4vLyBzbyBcIldvb2Rob3VzZSwgc3RvcCBwbGVhc2VcIiBzdG9wcyBhbmQgXCJzdG9wIHRoZSBQZW5ueXdvcnRoIHRhc2tcIiBnb2VzIHRvIHRoZSBtb2RlbCBhcyB1c3VhbC5cblxuaW1wb3J0IHR5cGUgeyBWb2ljZUNvbW1hbmRzIH0gZnJvbSBcIi4vdHlwZXMudHNcIjtcblxuZXhwb3J0IHR5cGUgVm9pY2VDb21tYW5kID0gXCJzdG9wXCIgfCBcImhhbmdVcFwiIHwgXCJjYW5jZWxBbGxcIjtcblxuLyoqIFdvcmRzIHRoYXQgbWF5IGNvbWUgYmVmb3JlIG9yIGFmdGVyIGEgY29tbWFuZCB3aXRob3V0IGNoYW5naW5nIGl0LiAqL1xuY29uc3QgRklMTEVSID0gbmV3IFNldChbXG4gIFwiaGV5XCIsIFwib2tcIiwgXCJva2F5XCIsIFwicGxlYXNlXCIsIFwibm93XCIsIFwianVzdFwiLCBcInNvXCIsIFwidW1cIiwgXCJ1aFwiLCBcIm9oXCIsIFwiYWxyaWdodFwiLCBcInJpZ2h0XCIsIFwieWVhaFwiLCBcInllc1wiLCBcInRoYW5rc1wiLCBcInRoYW5rXCIsIFwieW91XCIsXG4gIFwiZ2VtaW5pXCIsXG5dKTtcblxuLyoqIFt0ZXh0XSBhcyBsb3dlci1jYXNlIHdvcmRzLCBhcG9zdHJvcGhlcyBkcm9wcGVkIChcIlRoYXQnc1wiIGlzIFwidGhhdHNcIikuICovXG5leHBvcnQgZnVuY3Rpb24gd29yZHModGV4dDogc3RyaW5nKTogc3RyaW5nW10ge1xuICByZXR1cm4gdGV4dC50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL1snXHUyMDE5YF0vZywgXCJcIikucmVwbGFjZSgvW15cXHB7TH1cXHB7TmR9XSsvZ3UsIFwiIFwiKS50cmltKCkuc3BsaXQoXCIgXCIpLmZpbHRlcigodykgPT4gdy5sZW5ndGggPiAwKTtcbn1cblxuLyoqIFRoZSBjb21tYW5kIFt1dHRlcmFuY2VdIGlzLCBpZiBpdCdzIG9uZSBhbmQgbm90aGluZyBtb3JlOyBbbmFtZXNdICh0aGUgYXNzaXN0YW50J3MsIFwiV29vZGhvdXNlXCIpIGRvbid0IGNvdW50LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbW1hbmRJbih1dHRlcmFuY2U6IHN0cmluZywgY29tbWFuZHM6IFZvaWNlQ29tbWFuZHMsIG5hbWVzOiBzdHJpbmdbXSA9IFtdKTogVm9pY2VDb21tYW5kIHwgbnVsbCB7XG4gIGNvbnN0IGlnbm9yZWQgPSBuZXcgU2V0KFsuLi5GSUxMRVIsIC4uLm5hbWVzLmZsYXRNYXAod29yZHMpXSk7XG4gIGNvbnN0IHNhaWQgPSB3b3Jkcyh1dHRlcmFuY2UpO1xuICBsZXQgZnJvbSA9IDA7XG4gIGxldCB0byA9IHNhaWQubGVuZ3RoO1xuICB3aGlsZSAoZnJvbSA8IHRvICYmIGlnbm9yZWQuaGFzKHNhaWRbZnJvbV0pKSBmcm9tKys7XG4gIHdoaWxlICh0byA+IGZyb20gJiYgaWdub3JlZC5oYXMoc2FpZFt0byAtIDFdKSkgdG8tLTtcbiAgaWYgKGZyb20gPT09IHRvIHx8IHRvIC0gZnJvbSA+IDUpIHJldHVybiBudWxsO1xuICBjb25zdCBjb3JlID0gc2FpZC5zbGljZShmcm9tLCB0bykuam9pbihcIiBcIik7XG4gIGNvbnN0IGlzID0gKHBocmFzZXM6IHN0cmluZ1tdKSA9PiBwaHJhc2VzLnNvbWUoKHApID0+IHdvcmRzKHApLmpvaW4oXCIgXCIpID09PSBjb3JlKTtcbiAgaWYgKGlzKGNvbW1hbmRzLmhhbmdVcCkpIHJldHVybiBcImhhbmdVcFwiO1xuICBpZiAoaXMoY29tbWFuZHMuY2FuY2VsQWxsID8/IFtdKSkgcmV0dXJuIFwiY2FuY2VsQWxsXCI7XG4gIGlmIChpcyhjb21tYW5kcy5zdG9wKSkgcmV0dXJuIFwic3RvcFwiO1xuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqIFdvcmRzIHRoYXQgdGFrZSBhIHJlcXVlc3QgYmFjay4gKi9cbmNvbnN0IENBTkNFTFMgPSAvXFxiKD86Y2FuY2VsXFx3KnxhYm9ydFxcdyp8a2lsbHxzY3JhcHxzY3JhdGNofGRyb3B8Zm9yZ2V0fHVuZG98dGVybWluYXRlfG5ldmVyID9taW5kfGNhbGwgKD86aXR8dGhhdHx0aGlzKSBvZmZ8KD86ZG9udHxkbyBub3QpICg/OmJvdGhlcnxuZWVkfHdhbnR8ZG8pfG5vIG5lZWR8bm8gbG9uZ2VyfG5vdCBhbnltb3JlfGxlYXZlIGl0fHNraXAgKD86aXR8dGhhdCkpXFxiLztcbmNvbnN0IFNUT1BTID0gL1xcYig/OnN0b3BcXHcqfGhhbHR8cXVpdHxlbmQpXFxiLztcblxuLyoqXG4gKiBXaGV0aGVyIFt1dHRlcmFuY2VdIGFza3MgZm9yIGEgdGFzayB0byBiZSBjYW5jZWxsZWQsIGZvciBhIGNhbmNlbF90YXNrIHRoZSBtb2RlbCBjYWxsZWQgb24gaXQuIFwiU3RvcFwiIGFsb25lIGFuZCB0aGVcbiAqIG90aGVyIHN0b3AgYW5kIGhhbmctdXAgcGhyYXNlcyBkb24ndDogdGhleSBtZWFuIHN0b3AgdGFsa2luZy4gT3RoZXJ3aXNlIGl0IGRvZXMgd2hlbiBpdCBzYXlzIHNvIGluIHdvcmRzLCB3aGVuIGl0XG4gKiBuYW1lcyB0aGUgdGFzayAoW25hbWVkXSksIG9yIHdoZW4gaXQgc2F5cyB0byBzdG9wIHNvbWV0aGluZyBtb3JlIHRoYW4gdGhlIHRhbGtpbmcgKFwic3RvcCB3b3JraW5nIG9uIHRoYXRcIikuXG4gKiBXb3JkcyB0aGF0IHNheSBub25lIG9mIHRoaXMgKGEgbWlzaGVhcmluZyBzdWNoIGFzIFwiU3RhYml0XCIpIGRvbid0LiBXaXRoIG5vdGhpbmcgaGVhcmQgdGhlcmUgaXMgbm90aGluZyB0byBqdWRnZSBieS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFza3NUb0NhbmNlbCh1dHRlcmFuY2U6IHN0cmluZywgY29tbWFuZHM6IFZvaWNlQ29tbWFuZHMsIG5hbWVzOiBzdHJpbmdbXSwgbmFtZWQ6IGJvb2xlYW4pOiBib29sZWFuIHtcbiAgY29uc3Qgc2FpZCA9IHdvcmRzKHV0dGVyYW5jZSkuam9pbihcIiBcIik7XG4gIGlmIChzYWlkLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHRydWU7XG4gIGNvbnN0IGNvbW1hbmQgPSBjb21tYW5kSW4odXR0ZXJhbmNlLCBjb21tYW5kcywgbmFtZXMpO1xuICBpZiAoY29tbWFuZCA9PT0gXCJzdG9wXCIgfHwgY29tbWFuZCA9PT0gXCJoYW5nVXBcIikgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gY29tbWFuZCA9PT0gXCJjYW5jZWxBbGxcIiB8fCBuYW1lZCB8fCBDQU5DRUxTLnRlc3Qoc2FpZCkgfHwgU1RPUFMudGVzdChzYWlkKTtcbn1cbiIsICIvLyBUaGUgYnJvd3NlcidzIG1pY3JvcGhvbmUgYW5kIHNwZWFrZXIgZm9yIGEgY2FsbDogMTYga0h6IFBDTTE2IGZyYW1lcyBvdXQgb2YgdGhlIG1pY3JvcGhvbmUsXG4vLyAyNCBrSHogUENNMTYgaW50byB0aGUgc3BlYWtlciwgYW5kIHRvbmVzIGxhaWQgb3ZlciB3aGF0ZXZlciBwbGF5cy4gQm90aCBydW4gaW4gQXVkaW9Xb3JrbGV0cyBvblxuLy8gb25lIEF1ZGlvQ29udGV4dCBhdCB0aGUgZGV2aWNlJ3MgcmF0ZSwgcmVzYW1wbGluZyB0aGVyZS5cblxuY29uc3QgV09SS0xFVFMgPSBgXG5jbGFzcyBDYXB0dXJlIGV4dGVuZHMgQXVkaW9Xb3JrbGV0UHJvY2Vzc29yIHtcbiAgY29uc3RydWN0b3IoKSB7XG4gICAgc3VwZXIoKTtcbiAgICB0aGlzLnN0ZXAgPSBzYW1wbGVSYXRlIC8gMTYwMDA7XG4gICAgdGhpcy5wb3MgPSAwO1xuICAgIHRoaXMuZnJhbWUgPSBuZXcgSW50MTZBcnJheSgzMjApO1xuICAgIHRoaXMubiA9IDA7XG4gICAgLy8gQSB3aW5kb3dlZC1zaW5jIGxvdy1wYXNzIGF0IDcga0h6LCBzbyBub3RoaW5nIGFib3ZlIDE2IGtIeidzIDgga0h6IGxpbWl0IGZvbGRzIGJhY2sgaW50byBzcGVlY2guXG4gICAgY29uc3QgdGFwcyA9IDQ3LCBjdXQgPSA3MDAwIC8gc2FtcGxlUmF0ZTtcbiAgICB0aGlzLnRhcHMgPSBuZXcgRmxvYXQzMkFycmF5KHRhcHMpO1xuICAgIGxldCBzdW0gPSAwO1xuICAgIGZvciAobGV0IGsgPSAwOyBrIDwgdGFwczsgaysrKSB7XG4gICAgICBjb25zdCBtID0gayAtICh0YXBzIC0gMSkgLyAyO1xuICAgICAgY29uc3Qgc2luYyA9IG0gPT09IDAgPyAyICogY3V0IDogTWF0aC5zaW4oMiAqIE1hdGguUEkgKiBjdXQgKiBtKSAvIChNYXRoLlBJICogbSk7XG4gICAgICBjb25zdCB3ID0gMC40MiAtIDAuNSAqIE1hdGguY29zKCgyICogTWF0aC5QSSAqIGspIC8gKHRhcHMgLSAxKSkgKyAwLjA4ICogTWF0aC5jb3MoKDQgKiBNYXRoLlBJICogaykgLyAodGFwcyAtIDEpKTtcbiAgICAgIHRoaXMudGFwc1trXSA9IHNpbmMgKiB3O1xuICAgICAgc3VtICs9IHRoaXMudGFwc1trXTtcbiAgICB9XG4gICAgZm9yIChsZXQgayA9IDA7IGsgPCB0YXBzOyBrKyspIHRoaXMudGFwc1trXSAvPSBzdW07XG4gICAgdGhpcy5oaXN0b3J5ID0gbmV3IEZsb2F0MzJBcnJheSh0YXBzKTtcbiAgICB0aGlzLmF0ID0gMDtcbiAgfVxuICBwcm9jZXNzKGlucHV0cykge1xuICAgIGNvbnN0IGlucHV0ID0gaW5wdXRzWzBdICYmIGlucHV0c1swXVswXTtcbiAgICBpZiAoIWlucHV0KSByZXR1cm4gdHJ1ZTtcbiAgICBjb25zdCB0YXBzID0gdGhpcy50YXBzLCBoID0gdGhpcy5oaXN0b3J5LCBuID0gdGFwcy5sZW5ndGg7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBpbnB1dC5sZW5ndGg7IGkrKykge1xuICAgICAgaFt0aGlzLmF0XSA9IGlucHV0W2ldO1xuICAgICAgdGhpcy5hdCA9ICh0aGlzLmF0ICsgMSkgJSBuO1xuICAgICAgLy8gT25seSB0aGUgc2FtcGxlcyBrZXB0IG5lZWQgZmlsdGVyaW5nOiBhdCBtb3N0IG9uZSBpbiBldmVyeSBzdGVwLlxuICAgICAgaWYgKHRoaXMucG9zID4gMSkgeyB0aGlzLnBvcyAtPSAxOyBjb250aW51ZTsgfVxuICAgICAgbGV0IHggPSAwO1xuICAgICAgZm9yIChsZXQgayA9IDAsIGogPSB0aGlzLmF0OyBrIDwgbjsgaysrLCBqID0gaiArIDEgPT09IG4gPyAwIDogaiArIDEpIHggKz0gdGFwc1trXSAqIGhbal07XG4gICAgICB3aGlsZSAodGhpcy5wb3MgPD0gMSkge1xuICAgICAgICBjb25zdCBzID0gTWF0aC5tYXgoLTEsIE1hdGgubWluKDEsIHgpKTtcbiAgICAgICAgdGhpcy5mcmFtZVt0aGlzLm4rK10gPSBzIDwgMCA/IHMgKiAzMjc2OCA6IHMgKiAzMjc2NztcbiAgICAgICAgaWYgKHRoaXMubiA9PT0gdGhpcy5mcmFtZS5sZW5ndGgpIHtcbiAgICAgICAgICB0aGlzLnBvcnQucG9zdE1lc3NhZ2UodGhpcy5mcmFtZS5idWZmZXIsIFt0aGlzLmZyYW1lLmJ1ZmZlcl0pO1xuICAgICAgICAgIHRoaXMuZnJhbWUgPSBuZXcgSW50MTZBcnJheSgzMjApO1xuICAgICAgICAgIHRoaXMubiA9IDA7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5wb3MgKz0gdGhpcy5zdGVwO1xuICAgICAgfVxuICAgICAgdGhpcy5wb3MgLT0gMTtcbiAgICB9XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbn1cblxuY2xhc3MgUGxheWJhY2sgZXh0ZW5kcyBBdWRpb1dvcmtsZXRQcm9jZXNzb3Ige1xuICBjb25zdHJ1Y3RvcigpIHtcbiAgICBzdXBlcigpO1xuICAgIHRoaXMucXVldWUgPSBbXTsgICAgICAvLyBGbG9hdDMyQXJyYXlzIGF0IHRoZSBjb250ZXh0J3MgcmF0ZVxuICAgIHRoaXMub2Zmc2V0ID0gMDtcbiAgICB0aGlzLmN1ZXMgPSBbXTtcbiAgICB0aGlzLmN1ZU9mZnNldCA9IDA7XG4gICAgdGhpcy5yZXBvcnRlZCA9IDA7XG4gICAgdGhpcy5wb3J0Lm9ubWVzc2FnZSA9IChlKSA9PiB7XG4gICAgICBjb25zdCBtID0gZS5kYXRhO1xuICAgICAgaWYgKG0udHlwZSA9PT0gXCJwbGF5XCIpIHRoaXMucXVldWUucHVzaChtLnNhbXBsZXMpO1xuICAgICAgZWxzZSBpZiAobS50eXBlID09PSBcImN1ZVwiKSB0aGlzLmN1ZXMucHVzaChtLnNhbXBsZXMpO1xuICAgICAgZWxzZSBpZiAobS50eXBlID09PSBcImZsdXNoXCIpIHsgdGhpcy5xdWV1ZSA9IFtdOyB0aGlzLm9mZnNldCA9IDA7IH1cbiAgICAgIGVsc2UgaWYgKG0udHlwZSA9PT0gXCJzdG9wXCIpIHsgdGhpcy5xdWV1ZSA9IFtdOyB0aGlzLm9mZnNldCA9IDA7IHRoaXMuY3VlcyA9IFtdOyB0aGlzLmN1ZU9mZnNldCA9IDA7IH1cbiAgICB9O1xuICB9XG4gIHByb2Nlc3MoXywgb3V0cHV0cykge1xuICAgIGNvbnN0IG91dCA9IG91dHB1dHNbMF1bMF07XG4gICAgb3V0LmZpbGwoMCk7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoICYmIHRoaXMucXVldWUubGVuZ3RoOyBpKyspIHtcbiAgICAgIG91dFtpXSA9IHRoaXMucXVldWVbMF1bdGhpcy5vZmZzZXQrK107XG4gICAgICBpZiAodGhpcy5vZmZzZXQgPj0gdGhpcy5xdWV1ZVswXS5sZW5ndGgpIHsgdGhpcy5xdWV1ZS5zaGlmdCgpOyB0aGlzLm9mZnNldCA9IDA7IH1cbiAgICB9XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoICYmIHRoaXMuY3Vlcy5sZW5ndGg7IGkrKykge1xuICAgICAgb3V0W2ldID0gTWF0aC5tYXgoLTEsIE1hdGgubWluKDEsIG91dFtpXSArIHRoaXMuY3Vlc1swXVt0aGlzLmN1ZU9mZnNldCsrXSkpO1xuICAgICAgaWYgKHRoaXMuY3VlT2Zmc2V0ID49IHRoaXMuY3Vlc1swXS5sZW5ndGgpIHsgdGhpcy5jdWVzLnNoaWZ0KCk7IHRoaXMuY3VlT2Zmc2V0ID0gMDsgfVxuICAgIH1cbiAgICBmb3IgKGxldCBjID0gMTsgYyA8IG91dHB1dHNbMF0ubGVuZ3RoOyBjKyspIG91dHB1dHNbMF1bY10uc2V0KG91dCk7XG4gICAgaWYgKGN1cnJlbnRUaW1lIC0gdGhpcy5yZXBvcnRlZCA+IDAuMSkge1xuICAgICAgdGhpcy5yZXBvcnRlZCA9IGN1cnJlbnRUaW1lO1xuICAgICAgbGV0IHF1ZXVlZCA9IC10aGlzLm9mZnNldDtcbiAgICAgIGZvciAoY29uc3QgcSBvZiB0aGlzLnF1ZXVlKSBxdWV1ZWQgKz0gcS5sZW5ndGg7XG4gICAgICB0aGlzLnBvcnQucG9zdE1lc3NhZ2UoeyBxdWV1ZWQ6IHF1ZXVlZCAvIHNhbXBsZVJhdGUgfSk7XG4gICAgfVxuICAgIHJldHVybiB0cnVlO1xuICB9XG59XG5yZWdpc3RlclByb2Nlc3NvcihcImNhcHR1cmVcIiwgQ2FwdHVyZSk7XG5yZWdpc3RlclByb2Nlc3NvcihcInBsYXliYWNrXCIsIFBsYXliYWNrKTtcbmA7XG5cbmZ1bmN0aW9uIGJhc2U2NFRvQnl0ZXMoYjY0OiBzdHJpbmcpOiBVaW50OEFycmF5IHtcbiAgY29uc3QgYmluID0gYXRvYihiNjQpO1xuICBjb25zdCBvdXQgPSBuZXcgVWludDhBcnJheShiaW4ubGVuZ3RoKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBiaW4ubGVuZ3RoOyBpKyspIG91dFtpXSA9IGJpbi5jaGFyQ29kZUF0KGkpO1xuICByZXR1cm4gb3V0O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYnl0ZXNUb0Jhc2U2NChieXRlczogVWludDhBcnJheSk6IHN0cmluZyB7XG4gIGxldCBiaW4gPSBcIlwiO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGJ5dGVzLmxlbmd0aDsgaSArPSAweDgwMDApIGJpbiArPSBTdHJpbmcuZnJvbUNoYXJDb2RlKC4uLmJ5dGVzLnN1YmFycmF5KGksIGkgKyAweDgwMDApKTtcbiAgcmV0dXJuIGJ0b2EoYmluKTtcbn1cblxuLyoqIFBDTTE2IGxpdHRsZS1lbmRpYW4gYXQgW3JhdGVdLCBhcyBmbG9hdHMgYXQgdGhlIGNvbnRleHQncyByYXRlLiAqL1xuZnVuY3Rpb24gdG9GbG9hdHMocGNtOiBVaW50OEFycmF5LCByYXRlOiBudW1iZXIsIHRhcmdldDogbnVtYmVyKTogRmxvYXQzMkFycmF5IHtcbiAgY29uc3QgdmlldyA9IG5ldyBEYXRhVmlldyhwY20uYnVmZmVyLCBwY20uYnl0ZU9mZnNldCwgcGNtLmJ5dGVMZW5ndGgpO1xuICBjb25zdCBuID0gTWF0aC5mbG9vcihwY20uYnl0ZUxlbmd0aCAvIDIpO1xuICBjb25zdCBvdXQgPSBuZXcgRmxvYXQzMkFycmF5KE1hdGguZmxvb3IoKG4gKiB0YXJnZXQpIC8gcmF0ZSkpO1xuICBjb25zdCBzdGVwID0gcmF0ZSAvIHRhcmdldDtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCB4ID0gaSAqIHN0ZXA7XG4gICAgY29uc3QgaiA9IE1hdGguZmxvb3IoeCk7XG4gICAgY29uc3QgYSA9IHZpZXcuZ2V0SW50MTYoMiAqIE1hdGgubWluKGosIG4gLSAxKSwgdHJ1ZSk7XG4gICAgY29uc3QgYiA9IHZpZXcuZ2V0SW50MTYoMiAqIE1hdGgubWluKGogKyAxLCBuIC0gMSksIHRydWUpO1xuICAgIG91dFtpXSA9IChhICsgKGIgLSBhKSAqICh4IC0gaikpIC8gMzI3Njg7XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBNaWNPcHRpb25zIHsgZWNob0NhbmNlbGxhdGlvbjogYm9vbGVhbjsgbm9pc2VTdXBwcmVzc2lvbjogYm9vbGVhbjsgYXV0b0dhaW5Db250cm9sOiBib29sZWFuIH1cblxuZXhwb3J0IGNsYXNzIENhbGxBdWRpbyB7XG4gIHByaXZhdGUgY29udGV4dDogQXVkaW9Db250ZXh0IHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgcGxheWJhY2s6IEF1ZGlvV29ya2xldE5vZGUgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBjYXB0dXJlOiBBdWRpb1dvcmtsZXROb2RlIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgc3RyZWFtOiBNZWRpYVN0cmVhbSB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIHNvdXJjZTogTWVkaWFTdHJlYW1BdWRpb1NvdXJjZU5vZGUgfCBudWxsID0gbnVsbDtcbiAgLyoqIFNlY29uZHMgb2Ygc3BlZWNoIHF1ZXVlZCwgYXMgdGhlIHdvcmtsZXQgbGFzdCBzYWlkLiAqL1xuICBxdWV1ZWQgPSAwO1xuICAvKiogVGhlIG1pY3JvcGhvbmUncyBsZXZlbCwgUk1TIG9mIHRoZSBsYXN0IGZyYW1lICgwIHRvIDEpLiAqL1xuICBsZXZlbCA9IDA7XG5cbiAgYXN5bmMgb3BlbigpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAodGhpcy5jb250ZXh0KSB7IGlmICh0aGlzLmNvbnRleHQuc3RhdGUgPT09IFwic3VzcGVuZGVkXCIpIGF3YWl0IHRoaXMuY29udGV4dC5yZXN1bWUoKTsgcmV0dXJuOyB9XG4gICAgdGhpcy5jb250ZXh0ID0gbmV3IEF1ZGlvQ29udGV4dCh7IGxhdGVuY3lIaW50OiBcImludGVyYWN0aXZlXCIgfSk7XG4gICAgY29uc3QgdXJsID0gVVJMLmNyZWF0ZU9iamVjdFVSTChuZXcgQmxvYihbV09SS0xFVFNdLCB7IHR5cGU6IFwidGV4dC9qYXZhc2NyaXB0XCIgfSkpO1xuICAgIGF3YWl0IHRoaXMuY29udGV4dC5hdWRpb1dvcmtsZXQuYWRkTW9kdWxlKHVybCk7XG4gICAgdGhpcy5wbGF5YmFjayA9IG5ldyBBdWRpb1dvcmtsZXROb2RlKHRoaXMuY29udGV4dCwgXCJwbGF5YmFja1wiLCB7IG51bWJlck9mSW5wdXRzOiAwLCBvdXRwdXRDaGFubmVsQ291bnQ6IFsyXSB9KTtcbiAgICB0aGlzLnBsYXliYWNrLnBvcnQub25tZXNzYWdlID0gKGUpID0+IHsgdGhpcy5xdWV1ZWQgPSBlLmRhdGEucXVldWVkOyB9O1xuICAgIHRoaXMucGxheWJhY2suY29ubmVjdCh0aGlzLmNvbnRleHQuZGVzdGluYXRpb24pO1xuICB9XG5cbiAgLyoqIFNlY29uZHMgZnJvbSBhIHNhbXBsZSBsZWF2aW5nIHRoZSB3b3JrbGV0IHRvIHRoZSBzcGVha2VyLCBhcyB0aGUgYnJvd3NlciByZWNrb25zIGl0LiAqL1xuICBnZXQgb3V0cHV0TGF0ZW5jeSgpOiBudW1iZXIgfCBudWxsIHtcbiAgICBpZiAoIXRoaXMuY29udGV4dCkgcmV0dXJuIG51bGw7XG4gICAgcmV0dXJuIHRoaXMuY29udGV4dC5iYXNlTGF0ZW5jeSArICgodGhpcy5jb250ZXh0IGFzIEF1ZGlvQ29udGV4dCAmIHsgb3V0cHV0TGF0ZW5jeT86IG51bWJlciB9KS5vdXRwdXRMYXRlbmN5ID8/IDApO1xuICB9XG5cbiAgYXN5bmMgc3RhcnRNaWMob25GcmFtZTogKHBjbTY0OiBzdHJpbmcsIGxldmVsOiBudW1iZXIpID0+IHZvaWQsIG9wdGlvbnM6IE1pY09wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBhd2FpdCB0aGlzLm9wZW4oKTtcbiAgICB0aGlzLnN0b3BNaWMoKTtcbiAgICBjb25zdCBjb250ZXh0ID0gdGhpcy5jb250ZXh0ITtcbiAgICB0aGlzLnN0cmVhbSA9IGF3YWl0IG5hdmlnYXRvci5tZWRpYURldmljZXMuZ2V0VXNlck1lZGlhKHsgYXVkaW86IHsgY2hhbm5lbENvdW50OiAxLCAuLi5vcHRpb25zIH0gfSk7XG4gICAgdGhpcy5zb3VyY2UgPSBjb250ZXh0LmNyZWF0ZU1lZGlhU3RyZWFtU291cmNlKHRoaXMuc3RyZWFtKTtcbiAgICB0aGlzLmNhcHR1cmUgPSBuZXcgQXVkaW9Xb3JrbGV0Tm9kZShjb250ZXh0LCBcImNhcHR1cmVcIiwgeyBudW1iZXJPZk91dHB1dHM6IDAgfSk7XG4gICAgdGhpcy5jYXB0dXJlLnBvcnQub25tZXNzYWdlID0gKGUpID0+IHtcbiAgICAgIGNvbnN0IGZyYW1lID0gbmV3IEludDE2QXJyYXkoZS5kYXRhIGFzIEFycmF5QnVmZmVyKTtcbiAgICAgIGxldCBzdW0gPSAwO1xuICAgICAgZm9yIChjb25zdCBzIG9mIGZyYW1lKSBzdW0gKz0gcyAqIHM7XG4gICAgICB0aGlzLmxldmVsID0gTWF0aC5zcXJ0KHN1bSAvIGZyYW1lLmxlbmd0aCkgLyAzMjc2ODtcbiAgICAgIG9uRnJhbWUoYnl0ZXNUb0Jhc2U2NChuZXcgVWludDhBcnJheShlLmRhdGEgYXMgQXJyYXlCdWZmZXIpKSwgdGhpcy5sZXZlbCk7XG4gICAgfTtcbiAgICB0aGlzLnNvdXJjZS5jb25uZWN0KHRoaXMuY2FwdHVyZSk7XG4gIH1cblxuICBzdG9wTWljKCk6IHZvaWQge1xuICAgIHRoaXMuc291cmNlPy5kaXNjb25uZWN0KCk7XG4gICAgdGhpcy5jYXB0dXJlPy5wb3J0LmNsb3NlKCk7XG4gICAgdGhpcy5zdHJlYW0/LmdldFRyYWNrcygpLmZvckVhY2goKHQpID0+IHQuc3RvcCgpKTtcbiAgICB0aGlzLnNvdXJjZSA9IG51bGw7XG4gICAgdGhpcy5jYXB0dXJlID0gbnVsbDtcbiAgICB0aGlzLnN0cmVhbSA9IG51bGw7XG4gIH1cblxuICBwbGF5KHBjbTY0OiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuY29udGV4dCB8fCAhdGhpcy5wbGF5YmFjaykgcmV0dXJuO1xuICAgIGNvbnN0IHNhbXBsZXMgPSB0b0Zsb2F0cyhiYXNlNjRUb0J5dGVzKHBjbTY0KSwgMjQwMDAsIHRoaXMuY29udGV4dC5zYW1wbGVSYXRlKTtcbiAgICB0aGlzLnBsYXliYWNrLnBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcInBsYXlcIiwgc2FtcGxlcyB9LCBbc2FtcGxlcy5idWZmZXJdKTtcbiAgfVxuXG4gIGN1ZShwY202NDogc3RyaW5nKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLmNvbnRleHQgfHwgIXRoaXMucGxheWJhY2spIHJldHVybjtcbiAgICBjb25zdCBzYW1wbGVzID0gdG9GbG9hdHMoYmFzZTY0VG9CeXRlcyhwY202NCksIDI0MDAwLCB0aGlzLmNvbnRleHQuc2FtcGxlUmF0ZSk7XG4gICAgdGhpcy5wbGF5YmFjay5wb3J0LnBvc3RNZXNzYWdlKHsgdHlwZTogXCJjdWVcIiwgc2FtcGxlcyB9LCBbc2FtcGxlcy5idWZmZXJdKTtcbiAgfVxuXG4gIGZsdXNoKCk6IHZvaWQge1xuICAgIHRoaXMucGxheWJhY2s/LnBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcImZsdXNoXCIgfSk7XG4gIH1cblxuICBzdG9wKCk6IHZvaWQge1xuICAgIHRoaXMuc3RvcE1pYygpO1xuICAgIHRoaXMucGxheWJhY2s/LnBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcInN0b3BcIiB9KTtcbiAgfVxufVxuIiwgIi8vIFRoZSByZXBsYXkgdmlldzogYSByZWNvcmRlZCBjYWxsIChhIHRyYWNlIGZyb20gYW55IGhvc3QsIG9yIGEgc2NlbmFyaW8pIHJ1biBhZ2FpbiB0aHJvdWdoIHRoZVxuLy8gY29yZSwgYXMgdGhlIGJ1aWxkIHRoYXQgcmVjb3JkZWQgaXQgZGlkIGFuZCBhcyB0aGUgbGF0ZXN0IGRvZXMsIHNpZGUgYnkgc2lkZS4gV2hlcmUgdGhleSBwYXJ0XG4vLyBpcyB3aGVyZSBhIGNoYW5nZSBpbiBzcmMvIGNoYW5nZWQgd2hhdCB0aGUgY2FsbCBkb2VzIHdpdGggdGhlIHNhbWUgd29yZHMgYW5kIHRoZSBzYW1lIG1vZGVsLlxuXG5pbnRlcmZhY2UgQ29yZSB7XG4gIHZlcnNpb246IHN0cmluZztcbiAgY3JlYXRlKGNvbmZpZzogc3RyaW5nLCB0OiBudW1iZXIpOiBzdHJpbmc7XG4gIHB1c2goaWQ6IG51bWJlciwgZXZlbnQ6IHN0cmluZyk6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFJlY29yZGluZyB7IHZlcnNpb24/OiBzdHJpbmc7IGNvbmZpZzogdW5rbm93bjsgc3RhcnQ6IG51bWJlcjsgZXZlbnRzOiBSZWNvcmQ8c3RyaW5nLCBhbnk+W10gfVxuXG4vKiogV2hhdCBhIGNvbW1hbmQgb3IgZXZlbnQgbG9va3MgbGlrZSBpbiBhIHRpbWVsaW5lOiBhdWRpbyBjdXQgb3V0LCBvbmUgbGluZS4gKi9cbmZ1bmN0aW9uIGxpbmUobzogUmVjb3JkPHN0cmluZywgYW55Pik6IHN0cmluZyB7XG4gIGNvbnN0IHRleHQgPSBKU09OLnN0cmluZ2lmeShvKS5yZXBsYWNlKC9cIihkYXRhfHBjbSlcIjpcIltBLVphLXowLTkrLz1dezQwLH1cIi9nLCAnXCIkMVwiOlwiXHUyMDI2XCInKVxuICAgIC5yZXBsYWNlKC9cXFxcXCJkYXRhXFxcXFwiOlxcXFxcIltBLVphLXowLTkrLz1dezQwLH1cXFxcXCIvZywgJ1xcXFxcImRhdGFcXFxcXCI6XFxcXFwiXHUyMDI2XFxcXFwiJyk7XG4gIHJldHVybiB0ZXh0Lmxlbmd0aCA+IDQwMCA/IHRleHQuc2xpY2UoMCwgNDAwKSArIFwiXHUyMDI2XCIgOiB0ZXh0O1xufVxuXG4vKiogQXVkaW8gYW5kIHRpY2tzIHNheSBub3RoaW5nIGEgcmVhZGVyIG5lZWRzOyB0aGUgcmVzdCBkb2VzLiAqL1xuZnVuY3Rpb24gdGVsbGluZyhvOiBSZWNvcmQ8c3RyaW5nLCBhbnk+KTogYm9vbGVhbiB7XG4gIGlmIChvLnR5cGUgPT09IFwibWljXCIgfHwgby50eXBlID09PSBcInRpY2tcIiB8fCBvLnR5cGUgPT09IFwicGxheVwiKSByZXR1cm4gZmFsc2U7XG4gIGlmIChvLnR5cGUgPT09IFwid3Muc2VuZFwiICYmIFN0cmluZyhvLmRhdGEpLnN0YXJ0c1dpdGgoJ3tcInJlYWx0aW1lSW5wdXRcIjp7XCJhdWRpb1wiJykpIHJldHVybiBmYWxzZTtcbiAgaWYgKG8udHlwZSA9PT0gXCJ3cy5tZXNzYWdlXCIgJiYgU3RyaW5nKG8uZGF0YSkuaW5jbHVkZXMoJ1wiaW5saW5lRGF0YVwiJykgJiYgIVN0cmluZyhvLmRhdGEpLmluY2x1ZGVzKCdcInR1cm5Db21wbGV0ZVwiJykpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmZ1bmN0aW9uIHJ1bihjb3JlOiBDb3JlLCByOiBSZWNvcmRpbmcpOiBzdHJpbmdbXVtdIHtcbiAgY29uc3QgY3JlYXRlZCA9IEpTT04ucGFyc2UoY29yZS5jcmVhdGUoSlNPTi5zdHJpbmdpZnkoci5jb25maWcpLCByLnN0YXJ0KSk7XG4gIGNvbnN0IG91dDogc3RyaW5nW11bXSA9IFtjcmVhdGVkLmNvbW1hbmRzLmZpbHRlcih0ZWxsaW5nKS5tYXAobGluZSldO1xuICBmb3IgKGNvbnN0IGUgb2Ygci5ldmVudHMpIG91dC5wdXNoKChKU09OLnBhcnNlKGNvcmUucHVzaChjcmVhdGVkLmlkLCBKU09OLnN0cmluZ2lmeShlKSkpIGFzIFJlY29yZDxzdHJpbmcsIGFueT5bXSkuZmlsdGVyKHRlbGxpbmcpLm1hcChsaW5lKSk7XG4gIHJldHVybiBvdXQ7XG59XG5cbmV4cG9ydCBjbGFzcyBSZXBsYXkge1xuICBwcml2YXRlIHJlYWRvbmx5IHJvb3Q6IEhUTUxFbGVtZW50O1xuICBwcml2YXRlIHJlYWRvbmx5IGxvYWQ6ICh1cmw/OiBzdHJpbmcpID0+IFByb21pc2U8Q29yZT47XG5cbiAgY29uc3RydWN0b3Iocm9vdDogSFRNTEVsZW1lbnQsIGxvYWQ6ICh1cmw/OiBzdHJpbmcpID0+IFByb21pc2U8Q29yZT4pIHtcbiAgICB0aGlzLnJvb3QgPSByb290O1xuICAgIHRoaXMubG9hZCA9IGxvYWQ7XG4gICAgcm9vdC5pbm5lckhUTUwgPSBgXG4gICAgICA8aDI+VHJhY2UgcmVwbGF5PC9oMj5cbiAgICAgIDxkaXYgY2xhc3M9XCJiYXJcIj48c2VsZWN0IGNsYXNzPVwicGlja1wiIGFyaWEtbGFiZWw9XCJSZWNvcmRpbmdcIj48L3NlbGVjdD48YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cInJlZnJlc2hcIiB0aXRsZT1cIlJlZnJlc2ggbGlzdFwiIGFyaWEtbGFiZWw9XCJSZWZyZXNoIGxpc3RcIj5cdTIxQkI8L2J1dHRvbj48YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cImdvXCI+UmVwbGF5PC9idXR0b24+XG4gICAgICA8bGFiZWwgY2xhc3M9XCJ0b2dnbGUtYWxsXCI+PGlucHV0IHR5cGU9XCJjaGVja2JveFwiIGNsYXNzPVwiYWxsXCI+IFNob3cgYXVkaW8gYW5kIHRpY2tzPC9sYWJlbD48c3BhbiBjbGFzcz1cInN1bW1hcnlcIj48L3NwYW4+PC9kaXY+XG4gICAgICA8ZGl2IGNsYXNzPVwidGltZWxpbmVcIj48L2Rpdj5gO1xuICAgIChyb290LnF1ZXJ5U2VsZWN0b3IoXCIucmVmcmVzaFwiKSBhcyBIVE1MRWxlbWVudCkub25jbGljayA9ICgpID0+IHZvaWQgdGhpcy5saXN0KCk7XG4gICAgKHJvb3QucXVlcnlTZWxlY3RvcihcIi5nb1wiKSBhcyBIVE1MRWxlbWVudCkub25jbGljayA9ICgpID0+IHZvaWQgdGhpcy5yZXBsYXkoKS5jYXRjaCgoZXJyKSA9PiB0aGlzLnNheShgUmVwbGF5IGZhaWxlZDogJHtlcnIubWVzc2FnZX1gKSk7XG4gICAgdm9pZCB0aGlzLmxpc3QoKTtcbiAgfVxuXG4gIHByaXZhdGUgc2F5KHRleHQ6IHN0cmluZykge1xuICAgICh0aGlzLnJvb3QucXVlcnlTZWxlY3RvcihcIi5zdW1tYXJ5XCIpIGFzIEhUTUxFbGVtZW50KS50ZXh0Q29udGVudCA9IHRleHQ7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGxpc3QoKSB7XG4gICAgY29uc3QgcGljayA9IHRoaXMucm9vdC5xdWVyeVNlbGVjdG9yKFwiLnBpY2tcIikgYXMgSFRNTFNlbGVjdEVsZW1lbnQ7XG4gICAgcGljay5pbm5lckhUTUwgPSBcIlwiO1xuICAgIGNvbnN0IHRyYWNlczogeyBuYW1lOiBzdHJpbmc7IGJ5dGVzOiBudW1iZXIgfVtdID0gYXdhaXQgKGF3YWl0IGZldGNoKFwiL3RyYWNlc1wiKSkuanNvbigpO1xuICAgIGNvbnN0IHNjZW5hcmlvczogc3RyaW5nW10gPSBhd2FpdCAoYXdhaXQgZmV0Y2goXCIvc2NlbmFyaW9zXCIpKS5qc29uKCk7XG4gICAgY29uc3QgdHJhY2VHcm91cCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJvcHRncm91cFwiKTtcbiAgICB0cmFjZUdyb3VwLmxhYmVsID0gXCJSZWNvcmRlZCBjYWxsc1wiO1xuICAgIGZvciAoY29uc3QgdCBvZiB0cmFjZXMpIHRyYWNlR3JvdXAuYXBwZW5kKG5ldyBPcHRpb24oYCR7dC5uYW1lfSAoJHtNYXRoLnJvdW5kKHQuYnl0ZXMgLyAxMDI0KX0gS0IpYCwgYC90cmFjZXMvJHt0Lm5hbWV9YCkpO1xuICAgIGNvbnN0IHNjZW5hcmlvR3JvdXAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwib3B0Z3JvdXBcIik7XG4gICAgc2NlbmFyaW9Hcm91cC5sYWJlbCA9IFwiU2NlbmFyaW9zXCI7XG4gICAgZm9yIChjb25zdCBzIG9mIHNjZW5hcmlvcykgc2NlbmFyaW9Hcm91cC5hcHBlbmQobmV3IE9wdGlvbihzLCBgL3NjZW5hcmlvcy8ke3N9Lmpzb25gKSk7XG4gICAgcGljay5hcHBlbmQodHJhY2VHcm91cCwgc2NlbmFyaW9Hcm91cCk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHJlY29yZGluZyh1cmw6IHN0cmluZyk6IFByb21pc2U8UmVjb3JkaW5nPiB7XG4gICAgY29uc3QgdGV4dCA9IGF3YWl0IChhd2FpdCBmZXRjaCh1cmwsIHsgY2FjaGU6IFwibm8tc3RvcmVcIiB9KSkudGV4dCgpO1xuICAgIGlmICh1cmwuZW5kc1dpdGgoXCIuanNvblwiKSkgcmV0dXJuIEpTT04ucGFyc2UodGV4dCk7XG4gICAgY29uc3QgW2hlYWRlciwgLi4uZXZlbnRzXSA9IHRleHQudHJpbSgpLnNwbGl0KFwiXFxuXCIpLm1hcCgobCkgPT4gSlNPTi5wYXJzZShsKSk7XG4gICAgcmV0dXJuIHsgLi4uaGVhZGVyLCBldmVudHMgfTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgcmVwbGF5KCkge1xuICAgIGNvbnN0IHVybCA9ICh0aGlzLnJvb3QucXVlcnlTZWxlY3RvcihcIi5waWNrXCIpIGFzIEhUTUxTZWxlY3RFbGVtZW50KS52YWx1ZTtcbiAgICBpZiAoIXVybCkgcmV0dXJuO1xuICAgIGNvbnN0IHIgPSBhd2FpdCB0aGlzLnJlY29yZGluZyh1cmwpO1xuICAgIGNvbnN0IGxhdGVzdCA9IGF3YWl0IHRoaXMubG9hZCgpO1xuICAgIGxldCByZWNvcmRlZDogQ29yZSB8IG51bGwgPSBudWxsO1xuICAgIGlmIChyLnZlcnNpb24gJiYgci52ZXJzaW9uICE9PSBsYXRlc3QudmVyc2lvbikge1xuICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChgL3ZlcnNpb25zLyR7ci52ZXJzaW9ufS5qc2AsIHsgbWV0aG9kOiBcIkhFQURcIiB9KTtcbiAgICAgIGlmIChyZXNwb25zZS5vaykgcmVjb3JkZWQgPSBhd2FpdCB0aGlzLmxvYWQoYC92ZXJzaW9ucy8ke3IudmVyc2lvbn0uanNgKTtcbiAgICB9XG4gICAgY29uc3Qgbm93ID0gcnVuKGxhdGVzdCwgcik7XG4gICAgY29uc3QgdGhlbiA9IHJlY29yZGVkID8gcnVuKHJlY29yZGVkLCByKSA6IG51bGw7XG4gICAgY29uc3QgYWxsID0gKHRoaXMucm9vdC5xdWVyeVNlbGVjdG9yKFwiLmFsbFwiKSBhcyBIVE1MSW5wdXRFbGVtZW50KS5jaGVja2VkO1xuICAgIGNvbnN0IHRpbWVsaW5lID0gdGhpcy5yb290LnF1ZXJ5U2VsZWN0b3IoXCIudGltZWxpbmVcIikgYXMgSFRNTEVsZW1lbnQ7XG4gICAgdGltZWxpbmUuaW5uZXJIVE1MID0gXCJcIjtcbiAgICBsZXQgZmlyc3QgPSAtMTtcbiAgICBsZXQgZGlmZmVyID0gMDtcbiAgICBjb25zdCByb3dzOiBIVE1MRWxlbWVudFtdID0gW107XG4gICAgY29uc3QgYWRkID0gKGNsczogc3RyaW5nLCB0OiBzdHJpbmcsIHRleHQ6IHN0cmluZykgPT4ge1xuICAgICAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgIHJvdy5jbGFzc05hbWUgPSBgcm93ICR7Y2xzfWA7XG4gICAgICByb3cuaW5uZXJIVE1MID0gYDxzcGFuIGNsYXNzPVwidFwiPiR7dH08L3NwYW4+YDtcbiAgICAgIGNvbnN0IGIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgICAgIGIuY2xhc3NOYW1lID0gXCJiXCI7XG4gICAgICBiLnRleHRDb250ZW50ID0gdGV4dDtcbiAgICAgIHJvdy5hcHBlbmQoYik7XG4gICAgICB0aW1lbGluZS5hcHBlbmQocm93KTtcbiAgICAgIHJvd3MucHVzaChyb3cpO1xuICAgICAgcmV0dXJuIHJvdztcbiAgICB9O1xuICAgIGNvbnN0IHQwID0gci5zdGFydDtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8PSByLmV2ZW50cy5sZW5ndGg7IGkrKykge1xuICAgICAgY29uc3QgZSA9IGkgPT09IDAgPyBudWxsIDogci5ldmVudHNbaSAtIDFdO1xuICAgICAgY29uc3Qgbm93T3V0ID0gbm93W2ldO1xuICAgICAgY29uc3QgdGhlbk91dCA9IHRoZW4gPyB0aGVuW2ldIDogbm93T3V0O1xuICAgICAgY29uc3Qgc2FtZSA9IG5vd091dC5sZW5ndGggPT09IHRoZW5PdXQubGVuZ3RoICYmIG5vd091dC5ldmVyeSgoYywgaikgPT4gYyA9PT0gdGhlbk91dFtqXSk7XG4gICAgICBpZiAoIXNhbWUpIHsgZGlmZmVyKys7IGlmIChmaXJzdCA8IDApIGZpcnN0ID0gaTsgfVxuICAgICAgaWYgKCFzYW1lIHx8IGFsbCB8fCAoZSAmJiB0ZWxsaW5nKGUpKSB8fCBub3dPdXQubGVuZ3RoID4gMCkge1xuICAgICAgICBpZiAoZSAmJiAoYWxsIHx8IHRlbGxpbmcoZSkgfHwgIXNhbWUpKSBhZGQoXCJpblwiLCAoZS50IC0gdDApLnRvRml4ZWQoMiksIGxpbmUoZSkpO1xuICAgICAgICBjb25zdCB0ID0gZSA/IChlLnQgLSB0MCkudG9GaXhlZCgyKSA6IFwiMC4wMFwiO1xuICAgICAgICBpZiAoc2FtZSkgZm9yIChjb25zdCBjIG9mIG5vd091dCkgYWRkKFwib3V0XCIsIHQsIGMpO1xuICAgICAgICBlbHNlIHtcbiAgICAgICAgICBmb3IgKGNvbnN0IGMgb2YgdGhlbk91dCkgYWRkKFwib3V0IGdvbmVcIiwgdCwgYFx1MjIxMiAke2N9YCk7XG4gICAgICAgICAgZm9yIChjb25zdCBjIG9mIG5vd091dCkgYWRkKFwib3V0IG5ld1wiLCB0LCBgKyAke2N9YCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgY29uc3QgdmVyc2lvbnMgPSB0aGVuID8gYHJlY29yZGVkIGJ5ICR7ci52ZXJzaW9ufSwgcmVwbGF5ZWQgYnkgaXQgYW5kIGJ5ICR7bGF0ZXN0LnZlcnNpb259YCA6IGByZXBsYXllZCBieSAke2xhdGVzdC52ZXJzaW9ufWAgK1xuICAgICAgKHIudmVyc2lvbiAmJiByLnZlcnNpb24gIT09IGxhdGVzdC52ZXJzaW9uID8gYCAodGhlIHJlY29yZGluZydzIGJ1aWxkICR7ci52ZXJzaW9ufSBpc24ndCBrZXB0IGhlcmUpYCA6IFwiXCIpO1xuICAgIHRoaXMuc2F5KGAke3IuZXZlbnRzLmxlbmd0aH0gZXZlbnRzLCAke3ZlcnNpb25zfS4gYCArICh0aGVuID8gKGRpZmZlciA/IGAke2RpZmZlcn0gZXZlbnRzIGFuc3dlcmVkIGRpZmZlcmVudGx5LCB0aGUgZmlyc3QgYXQgZXZlbnQgJHtmaXJzdH0uYCA6IFwiQm90aCBhbnN3ZXJlZCBldmVyeSBldmVudCB0aGUgc2FtZS5cIikgOiBcIlwiKSk7XG4gICAgaWYgKGZpcnN0ID49IDApIHRpbWVsaW5lLnF1ZXJ5U2VsZWN0b3IoXCIuZ29uZSwgLm5ld1wiKT8uc2Nyb2xsSW50b1ZpZXcoeyBibG9jazogXCJjZW50ZXJcIiB9KTtcbiAgfVxufVxuIiwgIi8vIFB1cmUgVUkgaGVscGVycyBmb3IgdGhlIFZvaWNlIHdlYiBzdXJmYWNlIChkZW5zaXR5LCBhZ2VudC1wYW5lIGZpbHRlcmluZywgY29tcGFjdCBwcmV2aWV3cykuXG5cbmV4cG9ydCB0eXBlIFNpZGVGaWx0ZXIgPSBcImFsbFwiIHwgXCJhY3RpdmVcIiB8IFwicmVzdWx0c1wiO1xuZXhwb3J0IHR5cGUgRGVuc2l0eSA9IFwiY29tcGFjdFwiIHwgXCJjb21mb3J0YWJsZVwiO1xuXG5leHBvcnQgaW50ZXJmYWNlIFNpZGVDb3VudHMge1xuICBhY3RpdmU6IG51bWJlcjtcbiAgcmVzdWx0czogbnVtYmVyO1xuICBlYXJsaWVyOiBudW1iZXI7XG4gIGRvbmU6IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBTaWRlVmlzaWJpbGl0eSB7XG4gIHNob3dUYXNrc1NlY3Rpb246IGJvb2xlYW47XG4gIHNob3dFbXB0eVRhc2tzOiBib29sZWFuO1xuICBzaG93UmVzdWx0c1NlY3Rpb246IGJvb2xlYW47XG4gIHNob3dFbXB0eVJlc3VsdHM6IGJvb2xlYW47XG4gIHNob3dFYXJsaWVyU2VjdGlvbjogYm9vbGVhbjtcbiAgc2hvd0RvbmVTZWN0aW9uOiBib29sZWFuO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplRGVuc2l0eSh2YWx1ZTogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCk6IERlbnNpdHkge1xuICByZXR1cm4gdmFsdWUgPT09IFwiY29tZm9ydGFibGVcIiA/IFwiY29tZm9ydGFibGVcIiA6IFwiY29tcGFjdFwiO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplU2lkZUZpbHRlcih2YWx1ZTogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCk6IFNpZGVGaWx0ZXIge1xuICBpZiAodmFsdWUgPT09IFwiYWN0aXZlXCIgfHwgdmFsdWUgPT09IFwicmVzdWx0c1wiKSByZXR1cm4gdmFsdWU7XG4gIHJldHVybiBcImFsbFwiO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VQcmVmaXgodGV4dDogc3RyaW5nKTogeyBtb2RlOiBcImhlcm1lc1wiIHwgXCJ0M1wiIHwgbnVsbDsgcmVzdDogc3RyaW5nIH0ge1xuICBjb25zdCBtID0gdGV4dC5tYXRjaCgvXlxcLyh0M3xjb2RlfGh8aGVybWVzKVxccysoLiopJC9pcyk7XG4gIGlmICghbSkgcmV0dXJuIHsgbW9kZTogbnVsbCwgcmVzdDogdGV4dCB9O1xuICByZXR1cm4geyBtb2RlOiAvXih0M3xjb2RlKSQvaS50ZXN0KG1bMV0pID8gXCJ0M1wiIDogXCJoZXJtZXNcIiwgcmVzdDogbVsyXS50cmltKCkgfTtcbn1cblxuLyoqIEZsYXR0ZW4gYSBNYXJrZG93biBhZ2VudCByZXBseSBpbnRvIGEgc2luZ2xlLWxpbmUgcGxhaW4tdGV4dCBwcmV2aWV3IGZvciBpbmxpbmUgaGFuZG9mZiBjaGlwcy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwbGFpblByZXZpZXcodGV4dDogc3RyaW5nLCBtYXhMZW4gPSAxNTApOiBzdHJpbmcge1xuICBjb25zdCBjbGVhbmVkID0gdGV4dFxuICAgIC5yZXBsYWNlKC9gYGBbXlxcbl0qXFxuPyhbXFxzXFxTXSo/KWBgYC9nLCAoXywgY29kZTogc3RyaW5nKSA9PiBgICR7Y29kZS50cmltKCl9IGApXG4gICAgLnJlcGxhY2UoL1xcWyhbXlxcXVxcbl0rKVxcXVxcKChodHRwcz86XFwvXFwvW15cXHMpXSspXFwpL2csIFwiJDFcIilcbiAgICAucmVwbGFjZSgvXiN7MSw2fVxccysvZ20sIFwiXCIpXG4gICAgLnJlcGxhY2UoL15cXHMqKD86Wy0qXHUyMDIyXXxcXGQrWy4pXSlcXHMrL2dtLCBcIlwiKVxuICAgIC5yZXBsYWNlKC9gKFteYFxcbl0rKWAvZywgXCIkMVwiKVxuICAgIC5yZXBsYWNlKC9cXCpcXCooW14qXFxuXSspXFwqXFwqL2csIFwiJDFcIilcbiAgICAucmVwbGFjZSgvX18oW15fXFxuXSspX18vZywgXCIkMVwiKVxuICAgIC5yZXBsYWNlKC9cXHMrL2csIFwiIFwiKVxuICAgIC50cmltKCk7XG4gIGlmIChjbGVhbmVkLmxlbmd0aCA8PSBtYXhMZW4pIHJldHVybiBjbGVhbmVkO1xuICBjb25zdCBjdXQgPSBjbGVhbmVkLnNsaWNlKDAsIG1heExlbik7XG4gIGNvbnN0IHNwYWNlID0gY3V0Lmxhc3RJbmRleE9mKFwiIFwiKTtcbiAgY29uc3QgYmFzZSA9IHNwYWNlID4gTWF0aC5mbG9vcihtYXhMZW4gKiAwLjYpID8gY3V0LnNsaWNlKDAsIHNwYWNlKSA6IGN1dDtcbiAgcmV0dXJuIGAke2Jhc2UucmVwbGFjZSgvWy4sOzpcXHMtXSskLywgXCJcIil9XHUyMDI2YDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdFNob3J0VGltZShkYXRlOiBEYXRlKTogc3RyaW5nIHtcbiAgY29uc3QgcGFkID0gKG46IG51bWJlcikgPT4gU3RyaW5nKG4pLnBhZFN0YXJ0KDIsIFwiMFwiKTtcbiAgcmV0dXJuIGAke3BhZChkYXRlLmdldEhvdXJzKCkpfToke3BhZChkYXRlLmdldE1pbnV0ZXMoKSl9YDtcbn1cblxuLyoqIERlY2lkZSB3aGljaCBzZWN0aW9ucyBvZiB0aGUgcmlnaHQtaGFuZCBBZ2VudCBXb3Jrc3BhY2UgYXJlIHZpc2libGUgZm9yIGEgZ2l2ZW4gZmlsdGVyIGFuZCBjb3VudHMuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZVNpZGVTZWN0aW9ucyhmaWx0ZXI6IFNpZGVGaWx0ZXIsIGNvdW50czogU2lkZUNvdW50cyk6IFNpZGVWaXNpYmlsaXR5IHtcbiAgaWYgKGZpbHRlciA9PT0gXCJyZXN1bHRzXCIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc2hvd1Rhc2tzU2VjdGlvbjogZmFsc2UsXG4gICAgICBzaG93RW1wdHlUYXNrczogZmFsc2UsXG4gICAgICBzaG93UmVzdWx0c1NlY3Rpb246IHRydWUsXG4gICAgICBzaG93RW1wdHlSZXN1bHRzOiBjb3VudHMucmVzdWx0cyA9PT0gMCxcbiAgICAgIHNob3dFYXJsaWVyU2VjdGlvbjogZmFsc2UsXG4gICAgICBzaG93RG9uZVNlY3Rpb246IGZhbHNlLFxuICAgIH07XG4gIH1cbiAgaWYgKGZpbHRlciA9PT0gXCJhY3RpdmVcIikge1xuICAgIHJldHVybiB7XG4gICAgICBzaG93VGFza3NTZWN0aW9uOiB0cnVlLFxuICAgICAgc2hvd0VtcHR5VGFza3M6IGNvdW50cy5hY3RpdmUgPT09IDAgJiYgY291bnRzLmVhcmxpZXIgPT09IDAsXG4gICAgICBzaG93UmVzdWx0c1NlY3Rpb246IGZhbHNlLFxuICAgICAgc2hvd0VtcHR5UmVzdWx0czogZmFsc2UsXG4gICAgICBzaG93RWFybGllclNlY3Rpb246IGNvdW50cy5lYXJsaWVyID4gMCxcbiAgICAgIHNob3dEb25lU2VjdGlvbjogY291bnRzLmRvbmUgPiAwLFxuICAgIH07XG4gIH1cbiAgLy8gXCJhbGxcIjogaGlkZSB0aGUgZW1wdHkgYWN0aXZlLXRhc2tzIHBsYWNlaG9sZGVyIGFzIHNvb24gYXMgcmVzdWx0cyBvciBlYXJsaWVyIGFnZW50cyBleGlzdFxuICAvLyBzbyBmaW5pc2hlZCByZXNwb25zZXMgdGFrZSB0aGUgdG9wIG9mIHRoZSBwYW5lIHdpdGhvdXQgd2FzdGVkIHNwYWNlLlxuICBjb25zdCBoYXNBbnl0aGluZ0Fib3ZlRG9uZSA9IGNvdW50cy5hY3RpdmUgPiAwIHx8IGNvdW50cy5yZXN1bHRzID4gMCB8fCBjb3VudHMuZWFybGllciA+IDA7XG4gIHJldHVybiB7XG4gICAgc2hvd1Rhc2tzU2VjdGlvbjogY291bnRzLmFjdGl2ZSA+IDAgfHwgIWhhc0FueXRoaW5nQWJvdmVEb25lLFxuICAgIHNob3dFbXB0eVRhc2tzOiAhaGFzQW55dGhpbmdBYm92ZURvbmUsXG4gICAgc2hvd1Jlc3VsdHNTZWN0aW9uOiBjb3VudHMucmVzdWx0cyA+IDAsXG4gICAgc2hvd0VtcHR5UmVzdWx0czogZmFsc2UsXG4gICAgc2hvd0VhcmxpZXJTZWN0aW9uOiBjb3VudHMuZWFybGllciA+IDAsXG4gICAgc2hvd0RvbmVTZWN0aW9uOiBjb3VudHMuZG9uZSA+IDAsXG4gIH07XG59XG4iLCAiLy8gVGhlIHdlYiBzdXJmYWNlOiBhIGZvdXJ0aCBob3N0IGZvciB0aGUgdm9pY2UgY29yZSwgYW5kIGEgcGhvbmUtZnJpZW5kbHkgd2F5IHRvIHVzZSBpdCBmb3Igd29yay5cbi8vIEl0IGxvYWRzIHRoZSBkZXYgc2VydmVyJ3MgbGF0ZXN0IGJ1aWxkIGF0IGVhY2ggY2FsbCwgc28gYW4gZWRpdCBpbiBzcmMvIGlzIGxpdmUgb24gdGhlIG5leHRcbi8vIGNhbGwsIGFuZCBrZWVwcyBldmVyeSBjYWxsIGFzIGEgdHJhY2UgdGhlIHJlcGxheSB2aWV3IChhbmQgYW55IG90aGVyIGhvc3QpIGNhbiBydW4gYWdhaW4uXG4vL1xuLy8gVGhlIGhvc3QncyBwYXJ0IGlzIHNtYWxsOiB0aGUgbWljcm9waG9uZSBhbmQgc3BlYWtlciAoYXVkaW8udHMpLCB0aGUgbW9kZWwncyBzb2NrZXQgdGhyb3VnaCB0aGVcbi8vIHNlcnZlcidzIHJlbGF5LCBIZXJtZXMgYW5kIFQzIHRocm91Z2ggdGhlIHNlcnZlciwgYW5kIHRoZSBzY3JlZW4uIFRoZSBjb3JlIGRlY2lkZXMgdGhlIHJlc3QuXG4vL1xuLy8gVHlwaW5nIHdpdGggbm8gY2FsbCBvbiBzdGFydHMgYSBjaGF0IGluc3RlYWQ6IHRoZSBzYW1lIGNvcmUgd2l0aCBgbWVkaXVtOiBcInRleHRcImAsIHdob3NlIHJlcXVlc3RzXG4vLyB0byB0aGUgdGV4dCBtb2RlbCBnbyB0aHJvdWdoIHRoZSBzZXJ2ZXIncyAvZ2VuZXJhdGUuIFRhc2tzLCBmb2xsb3ctdXBzIGFuZCB0aGVpciBjYXJkcyB3b3JrIGFzXG4vLyBpbiBhIGNhbGwuIFByZXNzaW5nIENhbGwgZW5kcyB0aGUgY2hhdCBhbmQgY2FycmllcyBpdHMgY29udmVyc2F0aW9uIG9uIGJ5IHZvaWNlLlxuXG5pbXBvcnQgeyBjb21tYW5kSW4gfSBmcm9tIFwiLi4vc3JjL2NvbW1hbmRzLnRzXCI7XG5pbXBvcnQgeyBDYWxsQXVkaW8gfSBmcm9tIFwiLi9hdWRpby50c1wiO1xuaW1wb3J0IHsgUmVwbGF5IH0gZnJvbSBcIi4vcmVwbGF5LnRzXCI7XG5pbXBvcnQge1xuICBmb3JtYXRTaG9ydFRpbWUsXG4gIG5vcm1hbGl6ZURlbnNpdHksXG4gIG5vcm1hbGl6ZVNpZGVGaWx0ZXIsXG4gIHBhcnNlUHJlZml4LFxuICBwbGFpblByZXZpZXcsXG4gIHJlc29sdmVTaWRlU2VjdGlvbnMsXG4gIHR5cGUgU2lkZUZpbHRlcixcbn0gZnJvbSBcIi4vdWkudHNcIjtcblxuaW50ZXJmYWNlIENvcmUge1xuICB2ZXJzaW9uOiBzdHJpbmc7XG4gIGRlZmF1bHRzKCk6IHN0cmluZztcbiAgY3JlYXRlKGNvbmZpZzogc3RyaW5nLCB0OiBudW1iZXIpOiBzdHJpbmc7XG4gIHB1c2goaWQ6IG51bWJlciwgZXZlbnQ6IHN0cmluZyk6IHN0cmluZztcbiAgdHJhY2UoaWQ6IG51bWJlcik6IHN0cmluZztcbiAgZGlzcG9zZShpZDogbnVtYmVyKTogdm9pZDtcbn1cbnR5cGUgQ29tbWFuZCA9IFJlY29yZDxzdHJpbmcsIGFueT4gJiB7IHR5cGU6IHN0cmluZyB9O1xuaW50ZXJmYWNlIFNlcnZlckNvbmZpZyB7IHJvdXRlOiBzdHJpbmc7IG1vZGVsOiBzdHJpbmc7IGNhcHRpb25zTW9kZWw/OiBzdHJpbmc7IHRleHRNb2RlbD86IHN0cmluZzsgdmVyc2lvbjogc3RyaW5nOyBoZXJtZXM6IGJvb2xlYW47IHQzOiBzdHJpbmdbXSB8IG51bGwgfVxuXG5jb25zdCAkID0gPFQgZXh0ZW5kcyBIVE1MRWxlbWVudCA9IEhUTUxFbGVtZW50PihpZDogc3RyaW5nKSA9PiBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChpZCkgYXMgVDtcbmNvbnN0IG5vdyA9ICgpID0+IHBlcmZvcm1hbmNlLm5vdygpIC8gMTAwMDtcbmNvbnN0IGNoZWNrZWQgPSAoaWQ6IHN0cmluZykgPT4gJDxIVE1MSW5wdXRFbGVtZW50PihpZCkuY2hlY2tlZDtcblxuLyoqIFRoZSBsYXRlc3QgYnVpbGQgZnJvbSB0aGUgZGV2IHNlcnZlciwgZXZhbHVhdGVkIGFmcmVzaDogYW4gZWRpdCBpbiBzcmMvIGlzIGluIHRoZSBuZXh0IGNhbGwuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbG9hZENvcmUodXJsID0gXCIvdm9pY2UtY29yZS5qc1wiKTogUHJvbWlzZTxDb3JlPiB7XG4gIGNvbnN0IHNvdXJjZSA9IGF3YWl0IChhd2FpdCBmZXRjaCh1cmwsIHsgY2FjaGU6IFwibm8tc3RvcmVcIiB9KSkudGV4dCgpO1xuICBjb25zdCBzY29wZTogeyBWb2ljZUNvcmU/OiBDb3JlIH0gPSB7fTtcbiAgbmV3IEZ1bmN0aW9uKFwiZ2xvYmFsVGhpc1wiLCBzb3VyY2UpKHNjb3BlKTtcbiAgaWYgKCFzY29wZS5Wb2ljZUNvcmUpIHRocm93IG5ldyBFcnJvcihcInRoZSBidW5kbGUgZGlkbid0IGRlZmluZSBWb2ljZUNvcmVcIik7XG4gIHJldHVybiBzY29wZS5Wb2ljZUNvcmU7XG59XG5cbi8vIFByZXNldHM6IGVhY2ggc3VyZmFjZSdzIHNldHRpbmdzIGFzIGl0cyBhcHAgd291bGQgc2V0IHRoZW0uXG5cbmNvbnN0IEZBS0VfVFYgPSBbXG4gIHsgbmFtZTogXCJ0dl92b2x1bWVcIiwgZGVzY3JpcHRpb246IFwiU2V0cyB0aGUgbGl2aW5nLXJvb20gVFYncyB2b2x1bWUsIDAgdG8gMTAwLlwiLCBwYXJhbWV0ZXJzOiB7IHR5cGU6IFwiT0JKRUNUXCIsIHByb3BlcnRpZXM6IHsgbGV2ZWw6IHsgdHlwZTogXCJJTlRFR0VSXCIgfSB9LCByZXF1aXJlZDogW1wibGV2ZWxcIl0gfSB9LFxuICB7IG5hbWU6IFwidHZfcGF1c2VcIiwgZGVzY3JpcHRpb246IFwiUGF1c2VzIG9yIHJlc3VtZXMgd2hhdCdzIHBsYXlpbmcgb24gdGhlIFRWLlwiLCBwYXJhbWV0ZXJzOiB7IHR5cGU6IFwiT0JKRUNUXCIsIHByb3BlcnRpZXM6IHsgcGF1c2U6IHsgdHlwZTogXCJCT09MRUFOXCIgfSB9IH0gfSxcbl07XG5cbmNvbnN0IFBSRVNFVFM6IFJlY29yZDxzdHJpbmcsIFJlY29yZDxzdHJpbmcsIHVua25vd24+PiA9IHtcbiAgd2ViOiB7IHBsYXRmb3JtOiBcIndlYlwiLCBkZXZpY2U6IFwiYnJvd3NlclwiLCBzdGFuZGJ5QWZ0ZXI6IDMwLCBoYW5nVXBBZnRlcjogMzAwLCBoYW5kT2ZmOiBcIm5hbWVkXCIsIHN1cGVydmlzZTogdHJ1ZSwgdm9jYWJ1bGFyeTogW1wiSGVybWVzXCIsIFwiQmVudG9cIiwgXCJXb29kaG91c2VcIiwgXCJUM1wiXSB9LFxuICBhbmRyb2lkOiB7IHBsYXRmb3JtOiBcIkFuZHJvaWRcIiwgZGV2aWNlOiBcInBob25lXCIsIHN0YW5kYnlBZnRlcjogMjAgfSxcbiAgXCJhbmRyb2lkIHdha2Ugd29yZFwiOiB7IHBsYXRmb3JtOiBcIkFuZHJvaWRcIiwgZGV2aWNlOiBcInBob25lXCIsIHN0YW5kYnlBZnRlcjogMjAsIGhhbmdVcEFmdGVyOiAxNSB9LFxuICBtYWNvczogeyBwbGF0Zm9ybTogXCJtYWNPU1wiLCBkZXZpY2U6IFwiTWFjXCIsIHN0YW5kYnlBZnRlcjogMjAgfSxcbiAgZWNobzoge1xuICAgIHBsYXRmb3JtOiBcIkVjaG9cIiwgZGV2aWNlOiBcInNwZWFrZXJcIiwgaGFuZ1VwQWZ0ZXI6IDYsIHN0YW5kYnlBZnRlcjogOCwgZWFyY29uczogdHJ1ZSwgdm9jYWJ1bGFyeTogW1wiSGVybWVzXCIsIFwiQmVudG9cIiwgXCJXb29kaG91c2VcIl0sXG4gICAgbWljOiB7IHdoaWxlU3BlYWtpbmc6IFwid2FrZVwiLCBnYWluRGI6IDAgfSwgaG9zdFRvb2xzOiBGQUtFX1RWLFxuICB9LFxufTtcblxuLy8gU3RhdGUuXG5cbmNvbnN0IGF1ZGlvID0gbmV3IENhbGxBdWRpbygpO1xubGV0IHNlcnZlcjogU2VydmVyQ29uZmlnO1xubGV0IGNvcmU6IENvcmUgfCBudWxsID0gbnVsbDtcbmxldCBjYWxsSWQgPSAwO1xubGV0IGNhbGxOYW1lID0gXCJcIjtcbmxldCB0aWNrZXIgPSAwO1xubGV0IHRyYWNlVGltZXIgPSAwO1xubGV0IHN0YXJ0ZWRBdCA9IG5vdygpO1xuY29uc3Qgc29ja2V0cyA9IG5ldyBNYXA8bnVtYmVyLCBXZWJTb2NrZXQ+KCk7XG4vKiogVGhlIHNvY2tldHMgdG8gdGhlIHRyYW5zY3JpcHRpb24gbW9kZWw6IHRoZWlyIGF1ZGlvIGlzIHRoZSBtb2RlbCdzIGFnYWluLCBzbyBpdCBpc24ndCBjb3VudGVkIG9yIGxvZ2dlZCB0d2ljZS4gKi9cbmNvbnN0IGNhcHRpb25Tb2NrZXRzID0gbmV3IFNldDxudW1iZXI+KCk7XG5jb25zdCBydW5zID0gbmV3IE1hcDxzdHJpbmcsIHsgYWJvcnQ6IEFib3J0Q29udHJvbGxlcjsgYWdlbnQ6IHN0cmluZzsgdGFza0lkOiBzdHJpbmcgfT4oKTtcbmludGVyZmFjZSBUYXNrVmlldyB7IGM6IENvbW1hbmQ7IHNpbmNlOiBudW1iZXI7IGVuZGVkOiBudW1iZXIgfCBudWxsOyB0aHJlYWQ/OiBzdHJpbmc7IHJlc3VsdElkPzogc3RyaW5nOyBhcHByb3ZhbD86IHsgY29tbWFuZDogc3RyaW5nIH0gfVxuY29uc3QgdGFza3MgPSBuZXcgTWFwPHN0cmluZywgVGFza1ZpZXc+KCk7XG5pbnRlcmZhY2UgUmVzdWx0RW50cnkge1xuICBpZDogc3RyaW5nO1xuICBhZ2VudDogc3RyaW5nO1xuICBsYWJlbDogc3RyaW5nO1xuICB0ZXh0OiBzdHJpbmc7XG4gIGZhaWxlZDogYm9vbGVhbjtcbiAgdGFza0lkPzogc3RyaW5nO1xuICBjYXJkOiBIVE1MRWxlbWVudDtcbiAgaGVhZDogSFRNTEJ1dHRvbkVsZW1lbnQ7XG4gIGJvZHk6IEhUTUxFbGVtZW50O1xuICBtb3JlQnRuOiBIVE1MQnV0dG9uRWxlbWVudDtcbiAgZm9sbG93QnRuPzogSFRNTEJ1dHRvbkVsZW1lbnQ7XG4gIHJlZlJvdzogSFRNTEJ1dHRvbkVsZW1lbnQ7XG59XG5jb25zdCByZXN1bHRzID0gbmV3IE1hcDxzdHJpbmcsIFJlc3VsdEVudHJ5PigpO1xubGV0IG5leHRSZXN1bHRTZXEgPSAwO1xubGV0IHNpZGVGaWx0ZXI6IFNpZGVGaWx0ZXIgPSBcImFsbFwiO1xubGV0IHVucmVhZE1vYmlsZVJlc3VsdHMgPSAwO1xubGV0IGZsYXNoVGltZXIgPSAwO1xubGV0IGVhcmxpZXJBY3RpdmVDb3VudCA9IDA7XG5sZXQgZWFybGllcldhaXRpbmdDb3VudCA9IDA7XG5sZXQgY291bnRzID0geyBtaWM6IDAsIHBsYXk6IDAsIHNlbnQ6IDAgfTtcbmxldCBmYWtlVHZMZXZlbCA9IDE1O1xubGV0IGNvcmVTdGF0dXMgPSBcImlkbGVcIjtcbmxldCBtdXRlZCA9IGZhbHNlO1xubGV0IGhvbGRpbmcgPSBmYWxzZTtcbmxldCB3YWtlTG9jazogeyByZWxlYXNlKCk6IFByb21pc2U8dm9pZD4gfSB8IG51bGwgPSBudWxsO1xuLyoqIFdoYXQgdGhlIHNlc3Npb24gb24gc2NyZWVuIGlzOiBhIHZvaWNlIGNhbGwsIG9yIGEgdHlwZWQgY2hhdCAodGhlIGNvcmUncyBtZWRpdW0gXCJ0ZXh0XCIpLiAqL1xubGV0IG1lZGl1bTogXCJ2b2ljZVwiIHwgXCJ0ZXh0XCIgPSBcInZvaWNlXCI7XG4vKiogQSBjaGF0J3MgbW9kZWwgaXMgd3JpdGluZyBpdHMgYW5zd2VyLiAqL1xubGV0IHRoaW5raW5nID0gZmFsc2U7XG4vKiogQSBjaGF0J3MgcmVxdWVzdHMgdG8gdGhlIHRleHQgbW9kZWwgdGhhdCBhcmUgdW5kZXIgd2F5LiAqL1xuY29uc3QgcmVxdWVzdHMgPSBuZXcgTWFwPG51bWJlciwgQWJvcnRDb250cm9sbGVyPigpO1xuLyoqIFRoZSBsYXN0IHNlc3Npb24gd2luZGluZyBkb3duIChpdHMgdHJhY2Ugc2F2ZWQsIHRoZSBjb3JlJ3MgY2FsbCBkaXNwb3NlZCk6IHRoZSBuZXh0IHN0YXJ0cyBhZnRlciBpdC4gKi9cbmxldCBlbmRpbmc6IFByb21pc2U8dm9pZD4gPSBQcm9taXNlLnJlc29sdmUoKTtcblxuLy8gVGhlIGNvbnZlcnNhdGlvbiwga2VwdCBzbyBhIG5ldyBjYWxsIGNhbiBjYXJyeSBvbiBmcm9tIGl0ICh0aGUgY29yZSdzIGBoaXN0b3J5YCwgcmVjYXBwZWQgdG8gdGhlIG1vZGVsKS5cbmludGVyZmFjZSBDaGF0TGluZSB7IHJvbGU6IFwidXNlclwiIHwgXCJhc3Npc3RhbnRcIjsgc3BlYWtlcj86IHN0cmluZzsgdGV4dDogc3RyaW5nIH1cbmNvbnN0IEhJU1RPUlkgPSBcInZvaWNlLmhpc3RvcnlcIjtcbmNvbnN0IEhJU1RPUllfTUFYX0FHRSA9IDEyICogMzYwMCAqIDEwMDA7XG5sZXQgY2hhdDogQ2hhdExpbmVbXSA9IFtdO1xuLyoqIFRoZSBjb3JlJ3MgbnVtYmVyIGZvciB0aGUgbGluZSB0aGUgbGFzdCB3b3JkcyB3ZXJlIHJlbWVtYmVyZWQgb24sIHVudGlsIHNvbWV0aGluZyBlbHNlIGlzLiAqL1xubGV0IGxhc3RMaW5lOiBudW1iZXIgfCBudWxsID0gbnVsbDtcblxuZnVuY3Rpb24gcmVtZW1iZXIocm9sZTogXCJ1c2VyXCIgfCBcImFzc2lzdGFudFwiLCB0ZXh0OiBzdHJpbmcsIHNwZWFrZXI/OiBzdHJpbmcsIGpvaW4gPSBmYWxzZSkge1xuICBjb25zdCBsYXN0ID0gY2hhdC5hdCgtMSk7XG4gIGlmIChqb2luICYmIGxhc3QgJiYgbGFzdC5yb2xlID09PSByb2xlICYmIGxhc3Quc3BlYWtlciA9PT0gc3BlYWtlcikgbGFzdC50ZXh0ICs9IHRleHQ7XG4gIGVsc2UgY2hhdC5wdXNoKHNwZWFrZXIgPyB7IHJvbGUsIHNwZWFrZXIsIHRleHQgfSA6IHsgcm9sZSwgdGV4dCB9KTtcbiAgaWYgKGNoYXQubGVuZ3RoID4gMjAwKSBjaGF0LnNwbGljZSgwLCBjaGF0Lmxlbmd0aCAtIDIwMCk7XG4gIGxvY2FsU3RvcmFnZS5zZXRJdGVtKEhJU1RPUlksIEpTT04uc3RyaW5naWZ5KHsgYXQ6IERhdGUubm93KCksIGNoYXQgfSkpO1xufVxuXG5mdW5jdGlvbiBzYXZlZEhpc3RvcnkoKTogQ2hhdExpbmVbXSB7XG4gIHRyeSB7XG4gICAgY29uc3Qgc2F2ZWQgPSBKU09OLnBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKEhJU1RPUlkpID8/IFwibnVsbFwiKTtcbiAgICByZXR1cm4gc2F2ZWQgJiYgRGF0ZS5ub3coKSAtIHNhdmVkLmF0IDwgSElTVE9SWV9NQVhfQUdFICYmIEFycmF5LmlzQXJyYXkoc2F2ZWQuY2hhdCkgPyBzYXZlZC5jaGF0IDogW107XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBbXTtcbiAgfVxufVxuXG4vKiogVHdvIHJpc2luZyBub3Rlczogc29tZXRoaW5nIG9uIHRoZSBzY3JlZW4gbmVlZHMgdGhlIHVzZXIuIFBDTTE2IGF0IDI0IGtIeiwgYmFzZTY0LiAqL1xuY29uc3QgQVBQUk9WQUxfVE9ORSA9ICgoKSA9PiB7XG4gIGNvbnN0IHJhdGUgPSAyNDAwMCwgb3V0ID0gbmV3IEludDE2QXJyYXkocmF0ZSAqIDAuMzIpO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IG91dC5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IHQgPSBpIC8gcmF0ZSwgZiA9IHQgPCAwLjE2ID8gNjYwIDogODgwLCBsb2NhbCA9IHQgPCAwLjE2ID8gdCA6IHQgLSAwLjE2O1xuICAgIG91dFtpXSA9IE1hdGgucm91bmQoTWF0aC5zaW4oMiAqIE1hdGguUEkgKiBmICogdCkgKiBNYXRoLm1pbigxLCBsb2NhbCAqIDYwLCAoMC4xNiAtIGxvY2FsKSAqIDYwKSAqIDYwMDApO1xuICB9XG4gIGxldCBiaW4gPSBcIlwiO1xuICBjb25zdCBieXRlcyA9IG5ldyBVaW50OEFycmF5KG91dC5idWZmZXIpO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGJ5dGVzLmxlbmd0aDsgaSsrKSBiaW4gKz0gU3RyaW5nLmZyb21DaGFyQ29kZShieXRlc1tpXSk7XG4gIHJldHVybiBidG9hKGJpbik7XG59KSgpO1xuXG4vLyBMYXRlbmN5OiB0aGUgbmV0d29yaydzIHJvdW5kIHRyaXAsIGFuZCBob3cgbG9uZyBhZnRlciB0aGUgdXNlciBzdG9wcyB0YWxraW5nIHRoZSByZXBseSBzdGFydHMuXG5jb25zdCBtZXRyaWNzID0geyBydHQ6IFtdIGFzIG51bWJlcltdLCByZXBseTogW10gYXMgbnVtYmVyW10sIGxhc3RWb2ljZTogMCwgbGFzdFBsYXk6IDAsIHJlcGxpZWQ6IHRydWUgfTtcblxuZnVuY3Rpb24gbWVkaWFuKHhzOiBudW1iZXJbXSk6IG51bWJlciB8IG51bGwge1xuICBpZiAoeHMubGVuZ3RoID09PSAwKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgcyA9IFsuLi54c10uc29ydCgoYSwgYikgPT4gYSAtIGIpO1xuICByZXR1cm4gc1tNYXRoLmZsb29yKHMubGVuZ3RoIC8gMildO1xufVxuXG5mdW5jdGlvbiBzaG93TWV0cmljcygpIHtcbiAgY29uc3QgcGFydHM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IHJ0dCA9IG1lZGlhbihtZXRyaWNzLnJ0dCk7XG4gIGlmIChydHQgIT0gbnVsbCkgcGFydHMucHVzaChgJHtNYXRoLnJvdW5kKHJ0dCAqIDEwMDApfSBtc2ApO1xuICBjb25zdCByZXBseSA9IG1lZGlhbihtZXRyaWNzLnJlcGx5KTtcbiAgaWYgKHJlcGx5ICE9IG51bGwpIHBhcnRzLnB1c2goYHJlcGx5ICR7bWV0cmljcy5yZXBseS5hdCgtMSkhLnRvRml4ZWQoMSl9cyAoJHtyZXBseS50b0ZpeGVkKDEpfXMgbWVkKWApO1xuICBjb25zdCBvdXQgPSBhdWRpby5vdXRwdXRMYXRlbmN5O1xuICBpZiAob3V0ICE9IG51bGwpIHBhcnRzLnB1c2goYGF1ZGlvICR7TWF0aC5yb3VuZChvdXQgKiAxMDAwKX0gbXNgKTtcbiAgbGV0IGJ1ZmZlcmVkID0gMDtcbiAgZm9yIChjb25zdCB3cyBvZiBzb2NrZXRzLnZhbHVlcygpKSBidWZmZXJlZCArPSB3cy5idWZmZXJlZEFtb3VudDtcbiAgaWYgKGJ1ZmZlcmVkID4gMzJfMDAwKSBwYXJ0cy5wdXNoKGB1cGxvYWQgKyR7KGJ1ZmZlcmVkIC8gMzJfMDAwKS50b0ZpeGVkKDEpfXNgKTtcbiAgJChcIm1ldHJpY3NcIikudGV4dENvbnRlbnQgPSBwYXJ0cy5qb2luKFwiIFx1MDBCNyBcIik7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHBpbmcoKSB7XG4gIGNvbnN0IHQgPSBub3coKTtcbiAgdHJ5IHtcbiAgICBhd2FpdCBmZXRjaChcIi9waW5nXCIsIHsgY2FjaGU6IFwibm8tc3RvcmVcIiB9KTtcbiAgICBtZXRyaWNzLnJ0dC5wdXNoKG5vdygpIC0gdCk7XG4gICAgaWYgKG1ldHJpY3MucnR0Lmxlbmd0aCA+IDEyKSBtZXRyaWNzLnJ0dC5zaGlmdCgpO1xuICB9IGNhdGNoIHt9XG4gIHNob3dNZXRyaWNzKCk7XG59XG5cbi8vIFRoZW1lICYgZGVuc2l0eS5cblxuZnVuY3Rpb24gYXBwbHlUaGVtZShjaG9pY2U6IHN0cmluZykge1xuICBjb25zdCByb290ID0gZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50O1xuICBpZiAoY2hvaWNlID09PSBcImRhcmtcIiB8fCBjaG9pY2UgPT09IFwibGlnaHRcIikgcm9vdC5kYXRhc2V0LnRoZW1lID0gY2hvaWNlO1xuICBlbHNlIGRlbGV0ZSByb290LmRhdGFzZXQudGhlbWU7XG4gIGNvbnN0IGRhcmsgPSBjaG9pY2UgPT09IFwiZGFya1wiIHx8IChjaG9pY2UgIT09IFwibGlnaHRcIiAmJiBtYXRjaE1lZGlhKFwiKHByZWZlcnMtY29sb3Itc2NoZW1lOiBkYXJrKVwiKS5tYXRjaGVzKTtcbiAgY29uc3QgbWV0YSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwidGhlbWUtY29sb3JcIik7XG4gIGlmIChtZXRhKSBtZXRhLnNldEF0dHJpYnV0ZShcImNvbnRlbnRcIiwgZGFyayA/IFwiIzBlMGYwZlwiIDogXCIjZjZmNWYwXCIpO1xuICBmb3IgKGNvbnN0IGJ0biBvZiBBcnJheS5mcm9tKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiI3RoZW1lLXBpY2tlciBidXR0b25cIikpKSB7XG4gICAgYnRuLmNsYXNzTGlzdC50b2dnbGUoXCJvblwiLCBidG4uZGF0YXNldC50aGVtZSA9PT0gKGNob2ljZSB8fCBcInN5c3RlbVwiKSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gYXBwbHlEZW5zaXR5KGNob2ljZTogc3RyaW5nIHwgbnVsbCkge1xuICBjb25zdCBkZW5zaXR5ID0gbm9ybWFsaXplRGVuc2l0eShjaG9pY2UpO1xuICBjb25zdCByb290ID0gZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50O1xuICBpZiAoZGVuc2l0eSA9PT0gXCJjb21mb3J0YWJsZVwiKSByb290LmRhdGFzZXQuZGVuc2l0eSA9IFwiY29tZm9ydGFibGVcIjtcbiAgZWxzZSBkZWxldGUgcm9vdC5kYXRhc2V0LmRlbnNpdHk7XG4gIGZvciAoY29uc3QgYnRuIG9mIEFycmF5LmZyb20oZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MQnV0dG9uRWxlbWVudD4oXCIjZGVuc2l0eS1waWNrZXIgYnV0dG9uXCIpKSkge1xuICAgIGJ0bi5jbGFzc0xpc3QudG9nZ2xlKFwib25cIiwgYnRuLmRhdGFzZXQuZGVuc2l0eSA9PT0gZGVuc2l0eSk7XG4gIH1cbiAgcmVxdWVzdEFuaW1hdGlvbkZyYW1lKCgpID0+IHVwZGF0ZUFsbFJlc3VsdENsYW1waW5nKCkpO1xufVxuXG4vLyBUaGUgc2NyZWVuLlxuXG5mdW5jdGlvbiBzZXRDYWxsQnV0dG9uKGxpdmU6IGJvb2xlYW4pIHtcbiAgY29uc3QgYnRuID0gJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJjYWxsXCIpO1xuICBidG4uY2xhc3NMaXN0LnRvZ2dsZShcImxpdmVcIiwgbGl2ZSk7XG4gIGNvbnN0IGxhYmVsID0gYnRuLnF1ZXJ5U2VsZWN0b3IoXCIuY2FsbC1sYWJlbFwiKTtcbiAgaWYgKGxhYmVsKSBsYWJlbC50ZXh0Q29udGVudCA9IGxpdmUgPyBcIkhhbmcgdXBcIiA6IFwiQ2FsbFwiO1xufVxuXG5mdW5jdGlvbiBzeW5jUmVzdW1lQnV0dG9ucyhzaG93OiBib29sZWFuKSB7XG4gICQoXCJyZXN1bWVcIikuaGlkZGVuID0gIXNob3c7XG4gICQoXCJoZXJvLXJlc3VtZVwiKS5oaWRkZW4gPSAhc2hvdztcbn1cblxuZnVuY3Rpb24gc3luY0NvbXBvc2VyKCkge1xuICBjb25zdCBpbnB1dCA9ICQ8SFRNTElucHV0RWxlbWVudD4oXCJ0ZXh0XCIpO1xuICBjb25zdCB0cmltbWVkID0gaW5wdXQudmFsdWUudHJpbSgpO1xuICAkKFwic2VuZGJ0blwiKS5jbGFzc0xpc3QudG9nZ2xlKFwicmVhZHlcIiwgdHJpbW1lZC5sZW5ndGggPiAwKTtcbiAgY29uc3QgcGFyc2VkID0gcGFyc2VQcmVmaXgodHJpbW1lZCk7XG4gICQoXCJtb2RlLXdyYXBcIikuZGF0YXNldC5tb2RlID0gcGFyc2VkLm1vZGUgPz8gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJtb2RlXCIpLnZhbHVlO1xufVxuXG5mdW5jdGlvbiB1cGRhdGVKdW1wQnV0dG9uKCkge1xuICBjb25zdCBwYW5lID0gJChcInRyYW5zY3JpcHRcIik7XG4gIGNvbnN0IGF3YXkgPSBwYW5lLnNjcm9sbEhlaWdodCAtIHBhbmUuc2Nyb2xsVG9wIC0gcGFuZS5jbGllbnRIZWlnaHQgPiAxMjA7XG4gICQoXCJqdW1wYm90dG9tXCIpLmhpZGRlbiA9ICFhd2F5IHx8ICEkKFwiZW1wdHlcIikuaGlkZGVuO1xufVxuXG5mdW5jdGlvbiBmb3JtYXRDbG9jayhzZWNvbmRzOiBudW1iZXIpOiBzdHJpbmcge1xuICBjb25zdCB0b3RhbCA9IE1hdGgubWF4KDAsIE1hdGguZmxvb3Ioc2Vjb25kcykpO1xuICBjb25zdCBoID0gTWF0aC5mbG9vcih0b3RhbCAvIDM2MDApO1xuICBjb25zdCBtID0gTWF0aC5mbG9vcigodG90YWwgJSAzNjAwKSAvIDYwKTtcbiAgY29uc3QgcyA9IHRvdGFsICUgNjA7XG4gIGNvbnN0IHBhZCA9IChuOiBudW1iZXIpID0+IFN0cmluZyhuKS5wYWRTdGFydCgyLCBcIjBcIik7XG4gIHJldHVybiBoID4gMCA/IGAke2h9OiR7cGFkKG0pfToke3BhZChzKX1gIDogYCR7cGFkKG0pfToke3BhZChzKX1gO1xufVxuXG5jb25zdCBWSVpfV0VJR0hUUyA9IFswLjQ4LCAwLjg2LCAxLjAsIDAuNzgsIDAuNDRdO1xuZnVuY3Rpb24gdXBkYXRlVmlzdWFsaXplcihtb2RlOiBzdHJpbmcsIGxldmVsOiBudW1iZXIpIHtcbiAgY29uc3Qgdml6ID0gJChcInZpelwiKTtcbiAgdml6LmRhdGFzZXQubW9kZSA9IG1vZGU7XG4gIGNvbnN0IGJhcnMgPSB2aXouY2hpbGRyZW47XG4gIGlmIChtb2RlID09PSBcImxpc3RlbmluZ1wiIHx8IG1vZGUgPT09IFwid29ya2luZ1wiKSB7XG4gICAgY29uc3QgZW5lcmd5ID0gTWF0aC5taW4oMSwgbGV2ZWwgKiAxNCk7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBiYXJzLmxlbmd0aDsgaSsrKSB7XG4gICAgICBjb25zdCBoID0gMC4yNCArIGVuZXJneSAqIFZJWl9XRUlHSFRTW2ldICogMC43NjtcbiAgICAgIChiYXJzW2ldIGFzIEhUTUxFbGVtZW50KS5zdHlsZS50cmFuc2Zvcm0gPSBgc2NhbGVZKCR7aC50b0ZpeGVkKDIpfSlgO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGJhcnMubGVuZ3RoOyBpKyspIChiYXJzW2ldIGFzIEhUTUxFbGVtZW50KS5zdHlsZS50cmFuc2Zvcm0gPSBcIlwiO1xuICB9XG59XG5cbi8qKiBBIHN5c3RlbSBub3RpZmljYXRpb24gd2hpbGUgdGhlIHBhZ2UgaXMgaGlkZGVuOiBhIHRhc2sgZmluaXNoZWQsIG9yIG9uZSBuZWVkcyB0aGUgdXNlci4gKi9cbmZ1bmN0aW9uIG5vdGlmeSh0aXRsZTogc3RyaW5nLCBib2R5OiBzdHJpbmcpIHtcbiAgaWYgKCFkb2N1bWVudC5oaWRkZW4gfHwgIShcIk5vdGlmaWNhdGlvblwiIGluIHdpbmRvdykgfHwgTm90aWZpY2F0aW9uLnBlcm1pc3Npb24gIT09IFwiZ3JhbnRlZFwiKSByZXR1cm47XG4gIHRyeSB7XG4gICAgY29uc3QgbiA9IG5ldyBOb3RpZmljYXRpb24odGl0bGUsIHsgYm9keTogYm9keS5zbGljZSgwLCAxODApLCBpY29uOiBcIi93ZWIvaWNvbnMvaWNvbi0xOTIucG5nXCIsIHRhZzogdGl0bGUgfSk7XG4gICAgbi5vbmNsaWNrID0gKCkgPT4geyB3aW5kb3cuZm9jdXMoKTsgbi5jbG9zZSgpOyB9O1xuICB9IGNhdGNoIHtcbiAgICAvLyBQaG9uZXMgd2FudCBub3RpZmljYXRpb25zIGZyb20gYSBzZXJ2aWNlIHdvcmtlcjsgdGhlIHBhZ2UgaGFzIG5vbmUuXG4gIH1cbn1cblxuZnVuY3Rpb24gdG9hc3QodGV4dDogc3RyaW5nKSB7XG4gIGNvbnN0IHQgPSAkKFwidG9hc3RcIik7XG4gIHQudGV4dENvbnRlbnQgPSB0ZXh0O1xuICB0LmNsYXNzTGlzdC5hZGQoXCJvblwiKTtcbiAgY2xlYXJUaW1lb3V0KCh0b2FzdCBhcyBhbnkpLnRpbWVyKTtcbiAgKHRvYXN0IGFzIGFueSkudGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHQuY2xhc3NMaXN0LnJlbW92ZShcIm9uXCIpLCAxODAwKTtcbn1cblxuZnVuY3Rpb24gbG9nKGtpbmQ6IHN0cmluZywgdGV4dDogc3RyaW5nLCBjbHMgPSBcIlwiKSB7XG4gIGNvbnN0IHBhbmUgPSAkKFwibG9nXCIpO1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gYHJvdyAke2Nsc31gO1xuICByb3cuaW5uZXJIVE1MID0gYDxzcGFuIGNsYXNzPVwidFwiPiR7KG5vdygpIC0gc3RhcnRlZEF0KS50b0ZpeGVkKDIpfTwvc3Bhbj48c3BhbiBjbGFzcz1cImtcIj4ke2tpbmR9PC9zcGFuPmA7XG4gIGNvbnN0IGJvZHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgYm9keS5jbGFzc05hbWUgPSBcImJcIjtcbiAgYm9keS50ZXh0Q29udGVudCA9IHRleHQ7XG4gIHJvdy5hcHBlbmQoYm9keSk7XG4gIGNvbnN0IHN0aWNrID0gcGFuZS5zY3JvbGxUb3AgKyBwYW5lLmNsaWVudEhlaWdodCA+PSBwYW5lLnNjcm9sbEhlaWdodCAtIDMwO1xuICBwYW5lLmFwcGVuZChyb3cpO1xuICB3aGlsZSAocGFuZS5jaGlsZEVsZW1lbnRDb3VudCA+IDMwMDApIHBhbmUuZmlyc3RFbGVtZW50Q2hpbGQhLnJlbW92ZSgpO1xuICBpZiAoc3RpY2spIHBhbmUuc2Nyb2xsVG9wID0gcGFuZS5zY3JvbGxIZWlnaHQ7XG59XG5cbi8qKiBBIGZyYW1lIGZyb20gb3IgdG8gR2VtaW5pLCB3aXRoIGF1ZGlvIGN1dCBvdXQsIHNob3J0IGVub3VnaCB0byByZWFkLiAqL1xuZnVuY3Rpb24gYnJpZWYoZGF0YTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGRhdGEucmVwbGFjZSgvXCJkYXRhXCI6XCJbQS1aYS16MC05Ky89XXs0MCx9XCIvZywgKG0pID0+IGBcImRhdGFcIjpcIlx1MjAyNiR7TWF0aC5yb3VuZCgoKG0ubGVuZ3RoIC0gOSkgKiAzKSAvIDQpfSBieXRlc1wiYCkuc2xpY2UoMCwgNjAwKTtcbn1cblxuZnVuY3Rpb24gZXNjYXBlSHRtbCh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdGV4dC5yZXBsYWNlKC9bJjw+XCInXS9nLCAoYykgPT4gKHsgXCImXCI6IFwiJmFtcDtcIiwgXCI8XCI6IFwiJmx0O1wiLCBcIj5cIjogXCImZ3Q7XCIsICdcIic6IFwiJnF1b3Q7XCIsIFwiJ1wiOiBcIiYjMzk7XCIgfSlbY10hKTtcbn1cblxuLyoqIEEgbGl0dGxlIE1hcmtkb3duLCBzYWZlbHk6IGNvZGUsIGJvbGQsIGxpbmtzLCBsaXN0cyBhbmQgaGVhZGluZ3MsIHRoZSByZXN0IGFzIHRleHQuICovXG5mdW5jdGlvbiBtYXJrZG93bih0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBibG9ja3MgPSBlc2NhcGVIdG1sKHRleHQudHJpbSgpKS5zcGxpdCgvYGBgKD86XFx3Kyk/XFxuPy8pO1xuICByZXR1cm4gYmxvY2tzLm1hcCgoYmxvY2ssIGkpID0+IHtcbiAgICBpZiAoaSAlIDIgPT09IDEpIHJldHVybiBgPHByZT48Y29kZT4ke2Jsb2NrLnJlcGxhY2UoL1xcbiQvLCBcIlwiKX08L2NvZGU+PC9wcmU+YDtcbiAgICBjb25zdCBpbmxpbmUgPSAoczogc3RyaW5nKSA9PiBzXG4gICAgICAucmVwbGFjZSgvYChbXmBcXG5dKylgL2csIFwiPGNvZGU+JDE8L2NvZGU+XCIpXG4gICAgICAucmVwbGFjZSgvXFwqXFwqKFteKlxcbl0rKVxcKlxcKi9nLCBcIjxiPiQxPC9iPlwiKVxuICAgICAgLnJlcGxhY2UoL1xcWyhbXlxcXVxcbl0rKVxcXVxcKChodHRwcz86XFwvXFwvW15cXHMpXSspXFwpL2csICc8YSBocmVmPVwiJDJcIiB0YXJnZXQ9XCJfYmxhbmtcIiByZWw9XCJub29wZW5lclwiPiQxPC9hPicpXG4gICAgICAucmVwbGFjZSgvKF58W1xccyhdKShodHRwcz86XFwvXFwvW15cXHM8KV0rKS9nLCAnJDE8YSBocmVmPVwiJDJcIiB0YXJnZXQ9XCJfYmxhbmtcIiByZWw9XCJub29wZW5lclwiPiQyPC9hPicpO1xuICAgIGxldCBodG1sID0gXCJcIjtcbiAgICBsZXQgbGlzdDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gICAgZm9yIChjb25zdCByYXcgb2YgYmxvY2suc3BsaXQoXCJcXG5cIikpIHtcbiAgICAgIGNvbnN0IGl0ZW0gPSByYXcubWF0Y2goL15cXHMqKD86Wy0qXHUyMDIyXXwoXFxkKylbLildKVxccysoLiopJC8pO1xuICAgICAgaWYgKGl0ZW0pIHtcbiAgICAgICAgY29uc3Qga2luZCA9IGl0ZW1bMV0gPyBcIm9sXCIgOiBcInVsXCI7XG4gICAgICAgIGlmIChsaXN0ICE9PSBraW5kKSB7IGlmIChsaXN0KSBodG1sICs9IGA8LyR7bGlzdH0+YDsgaHRtbCArPSBgPCR7a2luZH0+YDsgbGlzdCA9IGtpbmQ7IH1cbiAgICAgICAgaHRtbCArPSBgPGxpPiR7aW5saW5lKGl0ZW1bMl0pfTwvbGk+YDtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBpZiAobGlzdCkgeyBodG1sICs9IGA8LyR7bGlzdH0+YDsgbGlzdCA9IG51bGw7IH1cbiAgICAgIGNvbnN0IGhlYWRpbmcgPSByYXcubWF0Y2goL14jezEsNn1cXHMrKC4qKSQvKTtcbiAgICAgIGh0bWwgKz0gaGVhZGluZyA/IGA8ZGl2IGNsYXNzPVwibWQtaFwiPiR7aW5saW5lKGhlYWRpbmdbMV0pfTwvZGl2PmAgOiByYXcudHJpbSgpID09PSBcIlwiID8gXCI8YnI+XCIgOiBgJHtpbmxpbmUocmF3KX08YnI+YDtcbiAgICB9XG4gICAgaWYgKGxpc3QpIGh0bWwgKz0gYDwvJHtsaXN0fT5gO1xuICAgIHJldHVybiBodG1sLnJlcGxhY2UoLyg8YnI+KSskLywgXCJcIik7XG4gIH0pLmpvaW4oXCJcIik7XG59XG5cbmZ1bmN0aW9uIHNjcm9sbERvd24oZm9yY2UgPSBmYWxzZSkge1xuICBjb25zdCBwYW5lID0gJChcInRyYW5zY3JpcHRcIik7XG4gIGlmIChmb3JjZSB8fCBwYW5lLnNjcm9sbFRvcCArIHBhbmUuY2xpZW50SGVpZ2h0ID49IHBhbmUuc2Nyb2xsSGVpZ2h0IC0gODApIHBhbmUuc2Nyb2xsVG9wID0gcGFuZS5zY3JvbGxIZWlnaHQ7XG4gIHVwZGF0ZUp1bXBCdXR0b24oKTtcbn1cblxuLyoqIFRoZSBjb3JlJ3MgbnVtYmVyIGZvciB0aGUgbGluZSB0aGUgbGFzdCByb3cgc2hvd3MsIHVudGlsIGFub3RoZXIgcm93IGZvbGxvd3MgaXQuICovXG5sZXQgb3BlbkxpbmU6IG51bWJlciB8IG51bGwgPSBudWxsO1xuXG4vKiogV29yZHMgZ28gb24gdGhlIHJvdyB0aGUgY29yZSBzYXlzIHRoZXkgYmVsb25nIHRvOiBpdCBzdGFydHMgYSBuZXcgbGluZSBmb3IgZWFjaCB0dXJuLCBob3dldmVyIGxvbmcgdGhlIGdhcC4gKi9cbmZ1bmN0aW9uIHRyYW5zY3JpcHQocm9sZTogXCJ1c2VyXCIgfCBcImFzc2lzdGFudFwiLCB0ZXh0OiBzdHJpbmcsIGxpbmU6IG51bWJlcikge1xuICAkKFwiZW1wdHlcIikuaGlkZGVuID0gdHJ1ZTtcbiAgY29uc3QgcGFuZSA9ICQoXCJ0cmFuc2NyaXB0XCIpO1xuICBjb25zdCBsYXN0ID0gcGFuZS5sYXN0RWxlbWVudENoaWxkIGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgaWYgKG9wZW5MaW5lID09PSBsaW5lICYmIGxhc3QgJiYgbGFzdC5kYXRhc2V0LnJvbGUgPT09IHJvbGUpIGxhc3QucXVlcnlTZWxlY3RvcihcIi50ZXh0XCIpIS50ZXh0Q29udGVudCArPSB0ZXh0O1xuICBlbHNlIHtcbiAgICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIHJvdy5jbGFzc05hbWUgPSBgbGluZSAke3JvbGV9YDtcbiAgICByb3cuZGF0YXNldC5yb2xlID0gcm9sZTtcbiAgICByb3cuaW5uZXJIVE1MID0gYDxzcGFuIGNsYXNzPVwid2hvXCI+JHtyb2xlID09PSBcInVzZXJcIiA/IFwiWW91XCIgOiBcIkdlbWluaVwifTwvc3Bhbj48c3BhbiBjbGFzcz1cInRleHRcIj48L3NwYW4+YDtcbiAgICByb3cucXVlcnlTZWxlY3RvcihcIi50ZXh0XCIpIS50ZXh0Q29udGVudCA9IHRleHQudHJpbVN0YXJ0KCk7XG4gICAgcGFuZS5hcHBlbmQocm93KTtcbiAgICBvcGVuTGluZSA9IGxpbmU7XG4gIH1cbiAgc2Nyb2xsRG93bihyb2xlID09PSBcInVzZXJcIik7XG59XG5cbi8qKlxuICogVGhlIHdvcmRzIHRoZSB1c2VyIGlzIHNheWluZywgYmVmb3JlIHRoZSBtb2RlbCBoYXMgdHJhbnNjcmliZWQgdGhlbTogYSBmYWludCByb3cgdGhhdCBzdGF5cyBsYXN0XG4gKiBvbiBzY3JlZW4gKGl0cyBDU1MgYG9yZGVyYCkgYW5kIGZpcnN0IGluIHRoZSBwYW5lLCBzbyB0aGUgbGluZXMgYWZ0ZXIgaXQgam9pbiB1cCBhcyBiZWZvcmUuXG4gKi9cbmZ1bmN0aW9uIGNhcHRpb24odGV4dDogc3RyaW5nIHwgbnVsbCkge1xuICBjb25zdCBwYW5lID0gJChcInRyYW5zY3JpcHRcIik7XG4gIGxldCByb3cgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImNhcHRpb25cIik7XG4gIGlmICh0ZXh0ID09IG51bGwpIHsgcm93Py5yZW1vdmUoKTsgdXBkYXRlSnVtcEJ1dHRvbigpOyByZXR1cm47IH1cbiAgJChcImVtcHR5XCIpLmhpZGRlbiA9IHRydWU7XG4gIGlmICghcm93KSB7XG4gICAgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICByb3cuaWQgPSBcImNhcHRpb25cIjtcbiAgICByb3cuY2xhc3NOYW1lID0gXCJsaW5lIHVzZXIgY2FwdGlvblwiO1xuICAgIHJvdy5pbm5lckhUTUwgPSBgPHNwYW4gY2xhc3M9XCJ3aG9cIj5Zb3U8L3NwYW4+PHNwYW4gY2xhc3M9XCJ0ZXh0XCI+PC9zcGFuPmA7XG4gICAgcGFuZS5wcmVwZW5kKHJvdyk7XG4gIH1cbiAgcm93LnF1ZXJ5U2VsZWN0b3IoXCIudGV4dFwiKSEudGV4dENvbnRlbnQgPSB0ZXh0O1xuICBzY3JvbGxEb3duKHRydWUpO1xufVxuXG5mdW5jdGlvbiBub3RlKHRleHQ6IHN0cmluZykge1xuICAkKFwiZW1wdHlcIikuaGlkZGVuID0gdHJ1ZTtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IFwibGluZSBub3RlXCI7XG4gIHJvdy50ZXh0Q29udGVudCA9IHRleHQ7XG4gICQoXCJ0cmFuc2NyaXB0XCIpLmFwcGVuZChyb3cpO1xuICBvcGVuTGluZSA9IG51bGw7XG4gIHNjcm9sbERvd24oKTtcbn1cblxuLy8gQWdlbnQgaGFuZG9mZiByZXN1bHRzOiBjb21wYWN0IDEtbGluZSByZWZlcmVuY2UgaW4gdGhlIHZvaWNlIHN0cmVhbSArIGZ1bGwgY29sbGFwc2libGUgY2FyZCBpbiB0aGUgcmlnaHQgcGFuZS5cblxuZnVuY3Rpb24gcmVzdWx0Q2xhbXBQeChlbDogSFRNTEVsZW1lbnQpOiBudW1iZXIge1xuICBjb25zdCByYXcgPSBnZXRDb21wdXRlZFN0eWxlKGVsKS5nZXRQcm9wZXJ0eVZhbHVlKFwiLS1yZXMtY2xhbXAtbWF4XCIpLnRyaW0oKTtcbiAgY29uc3QgbiA9IE51bWJlci5wYXJzZUZsb2F0KHJhdyk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobikgJiYgbiA+IDAgPyBuIDogNjQ7XG59XG5cbmZ1bmN0aW9uIHN5bmNFeHBhbmRBbGxCdXR0b24oKSB7XG4gIGNvbnN0IGNsYW1wZWQgPSBbLi4ucmVzdWx0cy52YWx1ZXMoKV0uZmlsdGVyKChyKSA9PiByLmNhcmQuY2xhc3NMaXN0LmNvbnRhaW5zKFwiY2xhbXBlZFwiKSk7XG4gIGNvbnN0IGJ0biA9ICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwidG9nZ2xlLWFsbC1yZXN1bHRzXCIpO1xuICBidG4uaGlkZGVuID0gY2xhbXBlZC5sZW5ndGggPT09IDA7XG4gIGlmIChjbGFtcGVkLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuICBjb25zdCBhbnlDb2xsYXBzZWQgPSBjbGFtcGVkLnNvbWUoKHIpID0+ICFyLmNhcmQuY2xhc3NMaXN0LmNvbnRhaW5zKFwib3BlblwiKSk7XG4gIGJ0bi50ZXh0Q29udGVudCA9IGFueUNvbGxhcHNlZCA/IFwiRXhwYW5kIGFsbFwiIDogXCJDb2xsYXBzZSBhbGxcIjtcbn1cblxuZnVuY3Rpb24gc2V0UmVzdWx0T3BlbihlbnRyeTogUmVzdWx0RW50cnksIG9wZW46IGJvb2xlYW4pIHtcbiAgY29uc3QgY2xhbXBlZCA9IGVudHJ5LmNhcmQuY2xhc3NMaXN0LmNvbnRhaW5zKFwiY2xhbXBlZFwiKTtcbiAgY29uc3QgbmV4dCA9IGNsYW1wZWQgJiYgb3BlbjtcbiAgZW50cnkuY2FyZC5jbGFzc0xpc3QudG9nZ2xlKFwib3BlblwiLCBuZXh0KTtcbiAgZW50cnkuaGVhZC5zZXRBdHRyaWJ1dGUoXCJhcmlhLWV4cGFuZGVkXCIsIFN0cmluZyghY2xhbXBlZCB8fCBuZXh0KSk7XG4gIGVudHJ5Lm1vcmVCdG4udGV4dENvbnRlbnQgPSBuZXh0ID8gXCJTaG93IGxlc3NcIiA6IFwiU2hvdyBtb3JlXCI7XG4gIHN5bmNFeHBhbmRBbGxCdXR0b24oKTtcbn1cblxuZnVuY3Rpb24gdXBkYXRlUmVzdWx0Q2xhbXBpbmcoZW50cnk6IFJlc3VsdEVudHJ5KSB7XG4gIGlmIChlbnRyeS5ib2R5Lm9mZnNldFBhcmVudCA9PT0gbnVsbCkgcmV0dXJuO1xuICBjb25zdCBvdmVyZmxvd3MgPSBlbnRyeS5ib2R5LnNjcm9sbEhlaWdodCA+IHJlc3VsdENsYW1wUHgoZW50cnkuY2FyZCkgKyA2O1xuICBlbnRyeS5jYXJkLmNsYXNzTGlzdC50b2dnbGUoXCJjbGFtcGVkXCIsIG92ZXJmbG93cyk7XG4gIGlmICghb3ZlcmZsb3dzKSBlbnRyeS5jYXJkLmNsYXNzTGlzdC5yZW1vdmUoXCJvcGVuXCIpO1xuICBlbnRyeS5tb3JlQnRuLmhpZGRlbiA9ICFvdmVyZmxvd3M7XG4gIGNvbnN0IGlzT3BlbiA9IGVudHJ5LmNhcmQuY2xhc3NMaXN0LmNvbnRhaW5zKFwib3BlblwiKTtcbiAgZW50cnkubW9yZUJ0bi50ZXh0Q29udGVudCA9IGlzT3BlbiA/IFwiU2hvdyBsZXNzXCIgOiBcIlNob3cgbW9yZVwiO1xuICBlbnRyeS5oZWFkLnNldEF0dHJpYnV0ZShcImFyaWEtZXhwYW5kZWRcIiwgU3RyaW5nKCFvdmVyZmxvd3MgfHwgaXNPcGVuKSk7XG59XG5cbmZ1bmN0aW9uIHVwZGF0ZUFsbFJlc3VsdENsYW1waW5nKCkge1xuICBmb3IgKGNvbnN0IGVudHJ5IG9mIHJlc3VsdHMudmFsdWVzKCkpIHVwZGF0ZVJlc3VsdENsYW1waW5nKGVudHJ5KTtcbiAgc3luY0V4cGFuZEFsbEJ1dHRvbigpO1xufVxuXG5mdW5jdGlvbiBzeW5jUmVzdWx0Rm9sbG93VXBCdXR0b25zKCkge1xuICBmb3IgKGNvbnN0IGVudHJ5IG9mIHJlc3VsdHMudmFsdWVzKCkpIHtcbiAgICBpZiAoIWVudHJ5LmZvbGxvd0J0bikgY29udGludWU7XG4gICAgY29uc3QgY2FuRm9sbG93ID0gQm9vbGVhbihjYWxsSWQgJiYgZW50cnkudGFza0lkICYmIHRhc2tzLmhhcyhlbnRyeS50YXNrSWQpKTtcbiAgICBlbnRyeS5mb2xsb3dCdG4uaGlkZGVuID0gIWNhbkZvbGxvdztcbiAgICBpZiAoIWNhbkZvbGxvdykgZW50cnkuY2FyZC5xdWVyeVNlbGVjdG9yKFwiZm9ybVwiKT8ucmVtb3ZlKCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gZm9jdXNSZXN1bHQoaWQ6IHN0cmluZykge1xuICBjb25zdCBlbnRyeSA9IHJlc3VsdHMuZ2V0KGlkKTtcbiAgaWYgKCFlbnRyeSkgcmV0dXJuO1xuICBpZiAoc2lkZUZpbHRlciA9PT0gXCJhY3RpdmVcIikgc2V0U2lkZUZpbHRlcihcImFsbFwiKTtcbiAgaWYgKG1vYmlsZUxheW91dC5tYXRjaGVzKSBzZXRUYXNrc09wZW4odHJ1ZSk7XG4gIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB7XG4gICAgdXBkYXRlUmVzdWx0Q2xhbXBpbmcoZW50cnkpO1xuICAgIGlmIChlbnRyeS5jYXJkLmNsYXNzTGlzdC5jb250YWlucyhcImNsYW1wZWRcIikpIHNldFJlc3VsdE9wZW4oZW50cnksIHRydWUpO1xuICAgIGZvciAoY29uc3QgciBvZiByZXN1bHRzLnZhbHVlcygpKSByLmNhcmQuY2xhc3NMaXN0LnJlbW92ZShcImZsYXNoXCIpO1xuICAgIHZvaWQgZW50cnkuY2FyZC5vZmZzZXRXaWR0aDtcbiAgICBlbnRyeS5jYXJkLmNsYXNzTGlzdC5hZGQoXCJmbGFzaFwiKTtcbiAgICBjbGVhclRpbWVvdXQoZmxhc2hUaW1lcik7XG4gICAgZmxhc2hUaW1lciA9IHdpbmRvdy5zZXRUaW1lb3V0KCgpID0+IGVudHJ5LmNhcmQuY2xhc3NMaXN0LnJlbW92ZShcImZsYXNoXCIpLCAxNDAwKTtcbiAgICBlbnRyeS5jYXJkLnNjcm9sbEludG9WaWV3KHsgYmVoYXZpb3I6IFwic21vb3RoXCIsIGJsb2NrOiBcIm5lYXJlc3RcIiB9KTtcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHJlc3VsdChhZ2VudDogc3RyaW5nLCBsYWJlbDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcsIGZhaWxlZCA9IGZhbHNlLCB0YXNrSWQ/OiBzdHJpbmcpOiBzdHJpbmcge1xuICAkKFwiZW1wdHlcIikuaGlkZGVuID0gdHJ1ZTtcbiAgY29uc3QgaWQgPSBgcmVzLSR7KytuZXh0UmVzdWx0U2VxfWA7XG4gIGNvbnN0IHdobyA9IGFnZW50ID09PSBcInQzXCIgPyBcIlQzXCIgOiBcIkhlcm1lc1wiO1xuICBjb25zdCBhZ2VudENscyA9IGFnZW50ID09PSBcInQzXCIgPyBcInQzXCIgOiBcIlwiO1xuICBjb25zdCBzbmlwcGV0ID0gcGxhaW5QcmV2aWV3KHRleHQsIDE2MCkgfHwgXCIoZW1wdHkgcmVzcG9uc2UpXCI7XG5cbiAgLy8gMS4gQ29tcGFjdCBpbmxpbmUgaGFuZG9mZiBtYXJrZXIgaW4gdGhlIHZvaWNlIHRyYW5zY3JpcHQgc28gY2hyb25vbG9naWNhbCBjb250ZXh0IHN0YXlzIGludGFjdFxuICAvLyB3aXRob3V0IG11bHRpLXBhcmFncmFwaCByZXNwb25zZXMgcHVzaGluZyB2b2ljZSB0dXJucyBvZmYgc2NyZWVuLlxuICBjb25zdCByZWZSb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICByZWZSb3cudHlwZSA9IFwiYnV0dG9uXCI7XG4gIHJlZlJvdy5jbGFzc05hbWUgPSBgbGluZSBoYW5kb2ZmICR7YWdlbnRDbHN9ICR7ZmFpbGVkID8gXCJmYWlsZWRcIiA6IFwiXCJ9YC50cmltKCk7XG4gIHJlZlJvdy5kYXRhc2V0LnJlc3VsdElkID0gaWQ7XG4gIHJlZlJvdy5pbm5lckhUTUwgPVxuICAgIGA8c3BhbiBjbGFzcz1cImJhZGdlICR7YWdlbnRDbHN9XCI+JHt3aG99PC9zcGFuPmAgK1xuICAgIGA8c3BhbiBjbGFzcz1cImhhbmRvZmYtbGFiZWxcIj4ke2VzY2FwZUh0bWwobGFiZWwpfTwvc3Bhbj5gICtcbiAgICBgPHNwYW4gY2xhc3M9XCJoYW5kb2ZmLXNuaXBwZXRcIj4ke2VzY2FwZUh0bWwoc25pcHBldCl9PC9zcGFuPmAgK1xuICAgIGA8c3BhbiBjbGFzcz1cImhhbmRvZmYtY3VlXCI+JHtmYWlsZWQgPyBcIkZhaWxlZFwiIDogXCJPcGVuIFx1MjE5N1wifTwvc3Bhbj5gO1xuICByZWZSb3cub25jbGljayA9ICgpID0+IGZvY3VzUmVzdWx0KGlkKTtcbiAgJChcInRyYW5zY3JpcHRcIikuYXBwZW5kKHJlZlJvdyk7XG4gIG9wZW5MaW5lID0gbnVsbDtcbiAgc2Nyb2xsRG93bigpO1xuXG4gIC8vIDIuIFRydW5jYXRlZCwgZXhwYW5kYWJsZSByZXN1bHQgY2FyZCBpbiB0aGUgcmlnaHQtaGFuZCBBZ2VudCBXb3Jrc3BhY2UgKG5ld2VzdCBmaXJzdCkuXG4gIGNvbnN0IGNhcmQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYXJ0aWNsZVwiKTtcbiAgY2FyZC5jbGFzc05hbWUgPSBgcmVzLWNhcmQgJHthZ2VudENsc30gJHtmYWlsZWQgPyBcImZhaWxlZFwiIDogXCJcIn1gLnRyaW0oKTtcbiAgY2FyZC5kYXRhc2V0LnJlc3VsdElkID0gaWQ7XG5cbiAgY29uc3QgaGVhZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIGhlYWQudHlwZSA9IFwiYnV0dG9uXCI7XG4gIGhlYWQuY2xhc3NOYW1lID0gXCJyZXMtaGVhZFwiO1xuICBoZWFkLnNldEF0dHJpYnV0ZShcImFyaWEtZXhwYW5kZWRcIiwgXCJ0cnVlXCIpO1xuICBoZWFkLmlubmVySFRNTCA9XG4gICAgYDxzcGFuIGNsYXNzPVwiYmFkZ2UgJHthZ2VudENsc31cIj4ke3dob308L3NwYW4+YCArXG4gICAgYDxzcGFuIGNsYXNzPVwicmVzLWxhYmVsXCIgdGl0bGU9XCIke2VzY2FwZUh0bWwobGFiZWwpfVwiPiR7ZXNjYXBlSHRtbChsYWJlbCl9PC9zcGFuPmAgK1xuICAgIChmYWlsZWQgPyBgPHNwYW4gY2xhc3M9XCJyZXMtcGlsbFwiPkZhaWxlZDwvc3Bhbj5gIDogXCJcIikgK1xuICAgIGA8c3BhbiBjbGFzcz1cInJlcy10aW1lXCI+JHtmb3JtYXRTaG9ydFRpbWUobmV3IERhdGUoKSl9PC9zcGFuPmAgK1xuICAgIGA8c3BhbiBjbGFzcz1cInJlcy1jaGV2XCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+PC9zcGFuPmA7XG5cbiAgY29uc3QgYm9keSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGJvZHkuY2xhc3NOYW1lID0gXCJyZXMtYm9keVwiO1xuICBib2R5LmlubmVySFRNTCA9IG1hcmtkb3duKHRleHQpO1xuXG4gIGNvbnN0IGZvb3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBmb290LmNsYXNzTmFtZSA9IFwicmVzLWZvb3RcIjtcblxuICBjb25zdCBtb3JlQnRuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgbW9yZUJ0bi50eXBlID0gXCJidXR0b25cIjtcbiAgbW9yZUJ0bi5jbGFzc05hbWUgPSBcInJlcy1hY3QgcHJpbWFyeVwiO1xuICBtb3JlQnRuLnRleHRDb250ZW50ID0gXCJTaG93IG1vcmVcIjtcbiAgbW9yZUJ0bi5oaWRkZW4gPSB0cnVlO1xuXG4gIGNvbnN0IGNvcHlCdG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBjb3B5QnRuLnR5cGUgPSBcImJ1dHRvblwiO1xuICBjb3B5QnRuLmNsYXNzTmFtZSA9IFwicmVzLWFjdFwiO1xuICBjb3B5QnRuLnRleHRDb250ZW50ID0gXCJDb3B5XCI7XG4gIGNvcHlCdG4ub25jbGljayA9ICgpID0+IHtcbiAgICB2b2lkIG5hdmlnYXRvci5jbGlwYm9hcmQ/LndyaXRlVGV4dCh0ZXh0KTtcbiAgICB0b2FzdChcIlJlc3VsdCBjb3BpZWRcIik7XG4gIH07XG5cbiAgZm9vdC5hcHBlbmQobW9yZUJ0biwgY29weUJ0bik7XG5cbiAgbGV0IGZvbGxvd0J0bjogSFRNTEJ1dHRvbkVsZW1lbnQgfCB1bmRlZmluZWQ7XG4gIGlmICh0YXNrSWQpIHtcbiAgICBmb2xsb3dCdG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICAgIGZvbGxvd0J0bi50eXBlID0gXCJidXR0b25cIjtcbiAgICBmb2xsb3dCdG4uY2xhc3NOYW1lID0gXCJyZXMtYWN0XCI7XG4gICAgZm9sbG93QnRuLnRleHRDb250ZW50ID0gXCJGb2xsb3cgdXBcIjtcbiAgICBmb2xsb3dCdG4ub25jbGljayA9ICgpID0+IHtcbiAgICAgIGNvbnN0IHZpZXcgPSB0YXNrcy5nZXQodGFza0lkKTtcbiAgICAgIGlmICh2aWV3KSBmb2xsb3dVcEZvcm0oY2FyZCwgdmlldy5jKTtcbiAgICB9O1xuICAgIGZvb3QuYXBwZW5kKGZvbGxvd0J0bik7XG4gIH1cblxuICBjYXJkLmFwcGVuZChoZWFkLCBib2R5LCBmb290KTtcblxuICBjb25zdCBlbnRyeTogUmVzdWx0RW50cnkgPSB7IGlkLCBhZ2VudCwgbGFiZWwsIHRleHQsIGZhaWxlZCwgdGFza0lkLCBjYXJkLCBoZWFkLCBib2R5LCBtb3JlQnRuLCBmb2xsb3dCdG4sIHJlZlJvdyB9O1xuICBjb25zdCB0b2dnbGUgPSAoKSA9PiB7XG4gICAgaWYgKCFlbnRyeS5jYXJkLmNsYXNzTGlzdC5jb250YWlucyhcImNsYW1wZWRcIikpIHJldHVybjtcbiAgICBzZXRSZXN1bHRPcGVuKGVudHJ5LCAhZW50cnkuY2FyZC5jbGFzc0xpc3QuY29udGFpbnMoXCJvcGVuXCIpKTtcbiAgfTtcbiAgaGVhZC5vbmNsaWNrID0gdG9nZ2xlO1xuICBtb3JlQnRuLm9uY2xpY2sgPSB0b2dnbGU7XG5cbiAgcmVzdWx0cy5zZXQoaWQsIGVudHJ5KTtcbiAgJChcInJlc3VsdHNcIikucHJlcGVuZChjYXJkKTtcbiAgaWYgKG1vYmlsZUxheW91dC5tYXRjaGVzICYmICFkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5jb250YWlucyhcInRhc2tzLW9wZW5cIikpIHVucmVhZE1vYmlsZVJlc3VsdHMrKztcblxuICBzeW5jU2lkZUxheW91dCgpO1xuICB1cGRhdGVUYXNrQ2hyb21lKCk7XG4gIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB7XG4gICAgdXBkYXRlUmVzdWx0Q2xhbXBpbmcoZW50cnkpO1xuICAgIHN5bmNFeHBhbmRBbGxCdXR0b24oKTtcbiAgfSk7XG4gIHJldHVybiBpZDtcbn1cblxuZnVuY3Rpb24gZWxhcHNlZChzZWNvbmRzOiBudW1iZXIpOiBzdHJpbmcge1xuICBpZiAoc2Vjb25kcyA8IDYwKSByZXR1cm4gYCR7TWF0aC5mbG9vcihzZWNvbmRzKX1zYDtcbiAgY29uc3QgbSA9IE1hdGguZmxvb3Ioc2Vjb25kcyAvIDYwKTtcbiAgcmV0dXJuIG0gPCA2MCA/IGAke219bSAke01hdGguZmxvb3Ioc2Vjb25kcyAlIDYwKX1zYCA6IGAke01hdGguZmxvb3IobSAvIDYwKX1oICR7bSAlIDYwfW1gO1xufVxuXG4vKiogVGhlIGVtcHR5IHRhc2sgbGlzdCdzIHdvcmRzLCBrZXB0IHRvIHB1dCBiYWNrLiAqL1xuY29uc3Qgbm9UYXNrcyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwibm90YXNrc1wiKSE7XG5cbi8qKiBXaGV0aGVyIGEgdGFzayBzdGlsbCB3YW50cyB0aGUgc2NyZWVuOiBpdCdzIHdvcmtpbmcsIG9yIGl0IHdhaXRzIGZvciB0aGUgdXNlci4gVGhlIHJlc3QgZm9sZCBhd2F5IHVuZGVyIEZpbmlzaGVkLiAqL1xuY29uc3QgbGl2ZSA9IChzdGF0ZTogc3RyaW5nKSA9PiBzdGF0ZSA9PT0gXCJydW5uaW5nXCIgfHwgc3RhdGUuc3RhcnRzV2l0aChcIndhaXRpbmdcIik7XG5cbmZ1bmN0aW9uIHNldFNpZGVGaWx0ZXIoZmlsdGVyOiBTaWRlRmlsdGVyKSB7XG4gIHNpZGVGaWx0ZXIgPSBub3JtYWxpemVTaWRlRmlsdGVyKGZpbHRlcik7XG4gIGZvciAoY29uc3QgYnRuIG9mIEFycmF5LmZyb20oZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MQnV0dG9uRWxlbWVudD4oXCIjc2lkZS10YWJzIGJ1dHRvblwiKSkpIHtcbiAgICBjb25zdCBvbiA9IGJ0bi5kYXRhc2V0LmZpbHRlciA9PT0gc2lkZUZpbHRlcjtcbiAgICBidG4uY2xhc3NMaXN0LnRvZ2dsZShcIm9uXCIsIG9uKTtcbiAgICBidG4uc2V0QXR0cmlidXRlKFwiYXJpYS1zZWxlY3RlZFwiLCBTdHJpbmcob24pKTtcbiAgfVxuICBzeW5jU2lkZUxheW91dCgpO1xuICByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKCkgPT4gdXBkYXRlQWxsUmVzdWx0Q2xhbXBpbmcoKSk7XG59XG5cbmZ1bmN0aW9uIHN5bmNTaWRlTGF5b3V0KCkge1xuICBjb25zdCBhbGwgPSBbLi4udGFza3MudmFsdWVzKCldO1xuICBjb25zdCBhY3RpdmVDdXJyZW50ID0gYWxsLmZpbHRlcigodCkgPT4gbGl2ZSh0LmMuc3RhdGUpKS5sZW5ndGg7XG4gIGNvbnN0IGFjdGl2ZVRvdGFsID0gYWN0aXZlQ3VycmVudCArIGVhcmxpZXJBY3RpdmVDb3VudDtcbiAgY29uc3QgcmVzdWx0c1RvdGFsID0gcmVzdWx0cy5zaXplO1xuICBjb25zdCBlYXJsaWVyU2hvd24gPSAkKFwiZWFybGllclwiKS5jaGlsZEVsZW1lbnRDb3VudDtcbiAgY29uc3QgZG9uZVRvdGFsID0gJChcImRvbmVub3dcIikuY2hpbGRFbGVtZW50Q291bnQgKyAkKFwiZG9uZWVhcmxpZXJcIikuY2hpbGRFbGVtZW50Q291bnQ7XG5cbiAgY29uc3QgdmlzID0gcmVzb2x2ZVNpZGVTZWN0aW9ucyhzaWRlRmlsdGVyLCB7XG4gICAgYWN0aXZlOiBhY3RpdmVDdXJyZW50LFxuICAgIHJlc3VsdHM6IHJlc3VsdHNUb3RhbCxcbiAgICBlYXJsaWVyOiBlYXJsaWVyU2hvd24sXG4gICAgZG9uZTogZG9uZVRvdGFsLFxuICB9KTtcblxuICAkKFwidGFza3Mtc2VjdGlvblwiKS5oaWRkZW4gPSAhdmlzLnNob3dUYXNrc1NlY3Rpb247XG4gIG5vVGFza3MuaGlkZGVuID0gIXZpcy5zaG93RW1wdHlUYXNrcztcbiAgJChcInJlc3VsdHMtc2VjdGlvblwiKS5oaWRkZW4gPSAhdmlzLnNob3dSZXN1bHRzU2VjdGlvbjtcbiAgJChcIm5vcmVzdWx0c1wiKS5oaWRkZW4gPSAhdmlzLnNob3dFbXB0eVJlc3VsdHM7XG4gICQoXCJlYXJsaWVyYm94XCIpLmhpZGRlbiA9ICF2aXMuc2hvd0VhcmxpZXJTZWN0aW9uO1xuICAkKFwiZG9uZWJveFwiKS5oaWRkZW4gPSAhdmlzLnNob3dEb25lU2VjdGlvbjtcblxuICAkKFwic2lkZS1hY3RpdmUtblwiKS50ZXh0Q29udGVudCA9IGFjdGl2ZVRvdGFsID4gMCA/IFN0cmluZyhhY3RpdmVUb3RhbCkgOiBcIlwiO1xuICAkKFwic2lkZS1yZXN1bHRzLW5cIikudGV4dENvbnRlbnQgPSByZXN1bHRzVG90YWwgPiAwID8gU3RyaW5nKHJlc3VsdHNUb3RhbCkgOiBcIlwiO1xuICAkKFwicmVzdWx0c2NvdW50XCIpLnRleHRDb250ZW50ID0gcmVzdWx0c1RvdGFsID4gMCA/IGBcdTAwQjcgJHtyZXN1bHRzVG90YWx9YCA6IFwiXCI7XG4gICQoXCJkb25lY291bnRcIikudGV4dENvbnRlbnQgPSBkb25lVG90YWwgPiAwID8gYFx1MDBCNyAke2RvbmVUb3RhbH1gIDogXCJcIjtcbiAgc3luY1Jlc3VsdEZvbGxvd1VwQnV0dG9ucygpO1xufVxuXG5mdW5jdGlvbiB1cGRhdGVUYXNrQ2hyb21lKCkge1xuICBjb25zdCBhbGwgPSBbLi4udGFza3MudmFsdWVzKCldO1xuICBjb25zdCBhY3RpdmVDdXJyZW50ID0gYWxsLmZpbHRlcigodCkgPT4gbGl2ZSh0LmMuc3RhdGUpIHx8IEJvb2xlYW4odC5hcHByb3ZhbCkpLmxlbmd0aDtcbiAgY29uc3Qgd2FpdGluZyA9IGFsbC5maWx0ZXIoKHQpID0+IHQuYy5zdGF0ZS5zdGFydHNXaXRoKFwid2FpdGluZ1wiKSB8fCBCb29sZWFuKHQuYXBwcm92YWwpKS5sZW5ndGg7XG4gIGNvbnN0IGFjdGl2ZVRvdGFsID0gYWN0aXZlQ3VycmVudCArIGVhcmxpZXJBY3RpdmVDb3VudDtcbiAgY29uc3QgYXR0ZW50aW9uVG90YWwgPSB3YWl0aW5nICsgZWFybGllcldhaXRpbmdDb3VudDtcbiAgY29uc3QgYmFkZ2VDb3VudCA9IGFjdGl2ZVRvdGFsID4gMCA/IGFjdGl2ZVRvdGFsIDogdW5yZWFkTW9iaWxlUmVzdWx0cztcblxuICBjb25zdCBiYWRnZSA9ICQoXCJ0YXNrcy1iYWRnZVwiKTtcbiAgYmFkZ2UuaGlkZGVuID0gYmFkZ2VDb3VudCA9PT0gMDtcbiAgYmFkZ2UudGV4dENvbnRlbnQgPSBTdHJpbmcoYmFkZ2VDb3VudCk7XG4gIGJhZGdlLmNsYXNzTGlzdC50b2dnbGUoXCJ3YXJuXCIsIGF0dGVudGlvblRvdGFsID4gMCk7XG5cbiAgY29uc3QgYmFyID0gJChcIm1vYmlsZS10YXNrcy1iYXJcIik7XG4gIGNvbnN0IHNob3dCYXIgPSBhY3RpdmVUb3RhbCA+IDAgfHwgdW5yZWFkTW9iaWxlUmVzdWx0cyA+IDA7XG4gIGJhci5oaWRkZW4gPSAhc2hvd0JhcjtcbiAgYmFyLmNsYXNzTGlzdC50b2dnbGUoXCJ2aXNpYmxlXCIsIHNob3dCYXIpO1xuICBiYXIuY2xhc3NMaXN0LnRvZ2dsZShcIndhcm5cIiwgYXR0ZW50aW9uVG90YWwgPiAwKTtcbiAgaWYgKHNob3dCYXIpIHtcbiAgICBjb25zdCBhcHByb3ZhbCA9IGFsbC5maW5kKCh0KSA9PiB0LmFwcHJvdmFsKTtcbiAgICBjb25zdCBsYWJlbCA9IGFwcHJvdmFsXG4gICAgICA/IGBBcHByb3ZhbCBuZWVkZWQ6ICR7YXBwcm92YWwuYy5sYWJlbH1gXG4gICAgICA6IGF0dGVudGlvblRvdGFsID4gMFxuICAgICAgICA/IGAke2F0dGVudGlvblRvdGFsfSB0YXNrJHthdHRlbnRpb25Ub3RhbCA+IDEgPyBcInNcIiA6IFwiXCJ9IHdhaXRpbmcgZm9yIHlvdWBcbiAgICAgICAgOiBhY3RpdmVUb3RhbCA+IDBcbiAgICAgICAgICA/IGAke2FjdGl2ZVRvdGFsfSBhY3RpdmUgdGFzayR7YWN0aXZlVG90YWwgPiAxID8gXCJzXCIgOiBcIlwifWBcbiAgICAgICAgICA6IGAke3VucmVhZE1vYmlsZVJlc3VsdHN9IG5ldyBhZ2VudCByZXN1bHQke3VucmVhZE1vYmlsZVJlc3VsdHMgPiAxID8gXCJzXCIgOiBcIlwifWA7XG4gICAgJChcIm10Yi10ZXh0XCIpLnRleHRDb250ZW50ID0gbGFiZWw7XG4gIH1cbn1cblxuZnVuY3Rpb24gc2hvd1Rhc2tzKGZvcmNlID0gZmFsc2UpIHtcbiAgY29uc3QgcGFuZSA9ICQoXCJ0YXNrc1wiKTtcbiAgY29uc3QgZG9uZSA9ICQoXCJkb25lbm93XCIpO1xuICBjb25zdCBvcGVuID0gZG9jdW1lbnQuYWN0aXZlRWxlbWVudD8uY2xvc2VzdD8uKFwiLnRhc2tcIikgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAoIWZvcmNlICYmIG9wZW4gJiYgKHBhbmUuY29udGFpbnMob3BlbikgfHwgZG9uZS5jb250YWlucyhvcGVuKSkgJiYgb3Blbi5xdWVyeVNlbGVjdG9yKFwiZm9ybVwiKSkgcmV0dXJuOyAvLyBkb24ndCByZWRyYXcgdW5kZXIgc29tZW9uZSB0eXBpbmcgYSBmb2xsb3ctdXBcbiAgcGFuZS5pbm5lckhUTUwgPSBcIlwiO1xuICBkb25lLmlubmVySFRNTCA9IFwiXCI7XG4gIGNvbnN0IGFsbCA9IFsuLi50YXNrcy52YWx1ZXMoKV0ucmV2ZXJzZSgpO1xuICBpZiAoYWxsLmxlbmd0aCA9PT0gMCkge1xuICAgIHBhbmUuYXBwZW5kKG5vVGFza3MpO1xuICAgICQoXCJ0YXNrY291bnRcIikudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICQoXCJjYW5jZWxhbGxcIikuaGlkZGVuID0gdHJ1ZTtcbiAgICBzeW5jU2lkZUxheW91dCgpO1xuICAgIHVwZGF0ZVRhc2tDaHJvbWUoKTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgcnVubmluZyA9IGFsbC5maWx0ZXIoKHQpID0+IHQuYy5zdGF0ZSA9PT0gXCJydW5uaW5nXCIpLmxlbmd0aDtcbiAgY29uc3QgYWN0aXZlQ291bnQgPSBhbGwuZmlsdGVyKCh0KSA9PiBsaXZlKHQuYy5zdGF0ZSkpLmxlbmd0aDtcbiAgJChcInRhc2tjb3VudFwiKS50ZXh0Q29udGVudCA9IHJ1bm5pbmcgPiAwID8gYCR7cnVubmluZ30gcnVubmluZ2AgOiBhY3RpdmVDb3VudCA+IDAgPyBgJHthY3RpdmVDb3VudH0gd2FpdGluZ2AgOiBcIlwiO1xuICAkKFwiY2FuY2VsYWxsXCIpLmhpZGRlbiA9ICFjYWxsSWQgfHwgcnVubmluZyA8IDI7XG4gIGZvciAoY29uc3QgdmlldyBvZiBhbGwpIHtcbiAgICBjb25zdCB0ID0gdmlldy5jO1xuICAgIGNvbnN0IHdhaXRpbmcgPSB0LnN0YXRlLnN0YXJ0c1dpdGgoXCJ3YWl0aW5nXCIpO1xuICAgIGNvbnN0IGNhcmQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGNhcmQuY2xhc3NOYW1lID0gYHRhc2sgJHt3YWl0aW5nID8gXCJ3YWl0aW5nXCIgOiB0LnN0YXRlfWA7XG4gICAgY29uc3QgYWdlID0gKHZpZXcuZW5kZWQgPz8gbm93KCkpIC0gdmlldy5zaW5jZTtcbiAgICBjYXJkLmlubmVySFRNTCA9XG4gICAgICBgPGRpdiBjbGFzcz1cIm1ldGEtcm93XCI+YCArXG4gICAgICAgIGA8c3BhbiBjbGFzcz1cImJhZGdlICR7dC5hZ2VudCA9PT0gXCJ0M1wiID8gXCJ0M1wiIDogXCJcIn1cIj4ke3QuYWdlbnQgPT09IFwidDNcIiA/IFwiVDNcIiA6IFwiSGVybWVzXCJ9PC9zcGFuPmAgK1xuICAgICAgICBgPHNwYW4gY2xhc3M9XCJsYWJlbFwiPjwvc3Bhbj5gICtcbiAgICAgICAgYDxzcGFuIGNsYXNzPVwic3RhdGVcIj4ke3Quc3RhdGUgPT09IFwicnVubmluZ1wiID8gJzxzcGFuIGNsYXNzPVwic3BpblwiPjwvc3Bhbj4nIDogXCJcIn0ke2VzY2FwZUh0bWwodC5zdGF0ZSl9PC9zcGFuPmAgK1xuICAgICAgICBgPHNwYW4gY2xhc3M9XCJhZ2VcIj4ke2VsYXBzZWQoYWdlKX08L3NwYW4+YCArXG4gICAgICBgPC9kaXY+YCArXG4gICAgICBgPGRpdiBjbGFzcz1cInBcIj48L2Rpdj5gO1xuICAgIGNvbnN0IGxhYmVsRWwgPSBjYXJkLnF1ZXJ5U2VsZWN0b3IoXCIubGFiZWxcIikgYXMgSFRNTEVsZW1lbnQ7XG4gICAgbGFiZWxFbC50ZXh0Q29udGVudCA9IHQubGFiZWw7XG4gICAgbGFiZWxFbC50aXRsZSA9IHQubGFiZWw7XG4gICAgY2FyZC5xdWVyeVNlbGVjdG9yKFwiLnBcIikhLnRleHRDb250ZW50ID0gdC5wcm9ncmVzcyA/PyB0LnJlcXVlc3Q7XG4gICAgaWYgKHQucXVlc3Rpb24pIHtcbiAgICAgIGNvbnN0IHEgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgICAgcS5jbGFzc05hbWUgPSBcInFcIjtcbiAgICAgIHEudGV4dENvbnRlbnQgPSBgQXNrczogJHt0LnF1ZXN0aW9ufWA7XG4gICAgICBjYXJkLmFwcGVuZChxKTtcbiAgICB9XG4gICAgaWYgKHZpZXcuYXBwcm92YWwgJiYgdC5zdGF0ZSA9PT0gXCJydW5uaW5nXCIpIHtcbiAgICAgIGNvbnN0IGJveCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICBib3guY2xhc3NOYW1lID0gXCJhcHByb3ZhbFwiO1xuICAgICAgYm94LmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPVwiYXBwcm92YWwtaGVhZFwiPkhlcm1lcyBhc2tzIHRvIHJ1bjwvZGl2Pjxjb2RlPjwvY29kZT48ZGl2IGNsYXNzPVwiYWN0c1wiPjwvZGl2PmA7XG4gICAgICBib3gucXVlcnlTZWxlY3RvcihcImNvZGVcIikhLnRleHRDb250ZW50ID0gdmlldy5hcHByb3ZhbC5jb21tYW5kO1xuICAgICAgY29uc3QgYW5zd2VyID0gKGNob2ljZTogXCJvbmNlXCIgfCBcImRlbnlcIikgPT4ge1xuICAgICAgICB2aWV3LmFwcHJvdmFsID0gdW5kZWZpbmVkO1xuICAgICAgICBzaG93VGFza3ModHJ1ZSk7XG4gICAgICAgIHZvaWQgZmV0Y2goXCIvaGVybWVzL2FwcHJvdmFsXCIsIHsgbWV0aG9kOiBcIlBPU1RcIiwgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBjYWxsOiBjYWxsTmFtZSwgdGFza0lkOiB0LmlkLCBjaG9pY2UgfSkgfSlcbiAgICAgICAgICAudGhlbigocikgPT4gdG9hc3Qoci5vayA/IChjaG9pY2UgPT09IFwib25jZVwiID8gXCJBcHByb3ZlZFwiIDogXCJEZW5pZWRcIikgOiBcIlRoYXQgYXBwcm92YWwgaGFkIGFscmVhZHkgbGFwc2VkXCIpKTtcbiAgICAgIH07XG4gICAgICBmb3IgKGNvbnN0IFtsYWJlbCwgY2hvaWNlXSBvZiBbW1wiQXBwcm92ZSBvbmNlXCIsIFwib25jZVwiXSwgW1wiRGVueVwiLCBcImRlbnlcIl1dIGFzIGNvbnN0KSB7XG4gICAgICAgIGNvbnN0IGIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICAgICAgICBiLnR5cGUgPSBcImJ1dHRvblwiO1xuICAgICAgICBiLnRleHRDb250ZW50ID0gbGFiZWw7XG4gICAgICAgIGlmIChjaG9pY2UgPT09IFwib25jZVwiKSBiLmNsYXNzTmFtZSA9IFwiZ29cIjtcbiAgICAgICAgZWxzZSBiLmNsYXNzTmFtZSA9IFwiZGFuZ2VyXCI7XG4gICAgICAgIGIub25jbGljayA9ICgpID0+IGFuc3dlcihjaG9pY2UpO1xuICAgICAgICBib3gucXVlcnlTZWxlY3RvcihcIi5hY3RzXCIpIS5hcHBlbmQoYik7XG4gICAgICB9XG4gICAgICBjYXJkLmFwcGVuZChib3gpO1xuICAgIH1cbiAgICBpZiAodC5zdGF0ZSAhPT0gXCJydW5uaW5nXCIpIHZpZXcuYXBwcm92YWwgPSB1bmRlZmluZWQ7XG4gICAgY29uc3QgYWN0cyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgYWN0cy5jbGFzc05hbWUgPSBcImFjdHNcIjtcbiAgICBjb25zdCBidXR0b24gPSAodGV4dDogc3RyaW5nLCBmbjogKCkgPT4gdm9pZCwgY2xzID0gXCJcIikgPT4ge1xuICAgICAgY29uc3QgYiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gICAgICBiLnR5cGUgPSBcImJ1dHRvblwiO1xuICAgICAgYi50ZXh0Q29udGVudCA9IHRleHQ7XG4gICAgICBpZiAoY2xzKSBiLmNsYXNzTmFtZSA9IGNscztcbiAgICAgIGIub25jbGljayA9IGZuO1xuICAgICAgYWN0cy5hcHBlbmQoYik7XG4gICAgICByZXR1cm4gYjtcbiAgICB9O1xuICAgIGlmIChjYWxsSWQpIHtcbiAgICAgIGJ1dHRvbih3YWl0aW5nID8gXCJBbnN3ZXJcIiA6IFwiRm9sbG93IHVwXCIsICgpID0+IGZvbGxvd1VwRm9ybShjYXJkLCB0KSk7XG4gICAgICBpZiAodC5zdGF0ZSA9PT0gXCJydW5uaW5nXCIpIGJ1dHRvbihcIkNhbmNlbFwiLCAoKSA9PiBwdXNoKHsgdHlwZTogXCJjYW5jZWxUYXNrXCIsIHRhc2s6IHQuaWQgfSksIFwiZGFuZ2VyXCIpO1xuICAgIH1cbiAgICBpZiAodmlldy5yZXN1bHRJZCkgYnV0dG9uKFwiUmVzdWx0XCIsICgpID0+IGZvY3VzUmVzdWx0KHZpZXcucmVzdWx0SWQhKSk7XG4gICAgaWYgKHZpZXcudGhyZWFkKSBidXR0b24oXCJDb3B5IGlkXCIsICgpID0+IHsgdm9pZCBuYXZpZ2F0b3IuY2xpcGJvYXJkPy53cml0ZVRleHQodmlldy50aHJlYWQhKTsgdG9hc3QoXCJUaHJlYWQgaWQgY29waWVkXCIpOyB9KTtcbiAgICBpZiAoYWN0cy5jaGlsZEVsZW1lbnRDb3VudCkgY2FyZC5hcHBlbmQoYWN0cyk7XG4gICAgKGxpdmUodC5zdGF0ZSkgPyBwYW5lIDogZG9uZSkuYXBwZW5kKGNhcmQpO1xuICB9XG4gIGlmIChwYW5lLmNoaWxkRWxlbWVudENvdW50ID09PSAwKSBwYW5lLmFwcGVuZChub1Rhc2tzKTtcbiAgc3luY1NpZGVMYXlvdXQoKTtcbiAgdXBkYXRlVGFza0Nocm9tZSgpO1xufVxuXG5mdW5jdGlvbiBmb2xsb3dVcEZvcm0oY2FyZDogSFRNTEVsZW1lbnQsIHQ6IENvbW1hbmQpIHtcbiAgY29uc3QgZXhpc3RpbmcgPSBjYXJkLnF1ZXJ5U2VsZWN0b3IoXCJmb3JtXCIpO1xuICBpZiAoZXhpc3RpbmcpIHsgZXhpc3RpbmcucXVlcnlTZWxlY3RvcihcImlucHV0XCIpPy5mb2N1cygpOyByZXR1cm47IH1cbiAgY29uc3QgZm9ybSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJmb3JtXCIpO1xuICBmb3JtLmNsYXNzTmFtZSA9IFwiZm9sbG93dXAtZm9ybVwiO1xuICBmb3JtLmlubmVySFRNTCA9IGA8aW5wdXQgdHlwZT1cInRleHRcIiBwbGFjZWhvbGRlcj1cIlRlbGwgXHUyMDFDJHtlc2NhcGVIdG1sKHQubGFiZWwpfVx1MjAxRFx1MjAyNlwiIGVudGVya2V5aGludD1cInNlbmRcIj48YnV0dG9uIHR5cGU9XCJzdWJtaXRcIj5TZW5kPC9idXR0b24+YDtcbiAgY29uc3QgaW5wdXQgPSBmb3JtLnF1ZXJ5U2VsZWN0b3IoXCJpbnB1dFwiKSE7XG4gIGZvcm0ub25zdWJtaXQgPSAoZSkgPT4ge1xuICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICBjb25zdCB0ZXh0ID0gaW5wdXQudmFsdWUudHJpbSgpO1xuICAgIGlmICh0ZXh0KSB7IHB1c2goeyB0eXBlOiBcInN0ZWVyXCIsIHRhc2s6IHQuaWQsIHRleHQgfSk7IG5vdGUoYFlvdSBcdTIxOTIgJHt0LmxhYmVsfTogJHt0ZXh0fWApOyB9XG4gICAgaW5wdXQuYmx1cigpO1xuICAgIGZvcm0ucmVtb3ZlKCk7XG4gICAgc2hvd1Rhc2tzKCk7XG4gIH07XG4gIGlucHV0Lm9ua2V5ZG93biA9IChlKSA9PiB7IGlmIChlLmtleSA9PT0gXCJFc2NhcGVcIikgeyBlLnN0b3BQcm9wYWdhdGlvbigpOyBpbnB1dC5ibHVyKCk7IGZvcm0ucmVtb3ZlKCk7IHNob3dUYXNrcygpOyB9IH07XG4gIGNhcmQuYXBwZW5kKGZvcm0pO1xuICBpbnB1dC5mb2N1cygpO1xufVxuXG4vKiogVDMgdGhyZWFkcyBlYXJsaWVyIGNhbGxzIHN0YXJ0ZWQ6IHRoZXkgY2Fycnkgb24gYWZ0ZXIgYSBjYWxsLCBzbyB0aGUgcGFuZWwgc2F5cyBob3cgdGhleSdyZSBkb2luZy4gKi9cbmFzeW5jIGZ1bmN0aW9uIHNob3dFYXJsaWVyKCkge1xuICBsZXQgbGlzdDogeyB0aHJlYWQ6IHN0cmluZzsgdGl0bGU6IHN0cmluZzsgc3RhdHVzOiBzdHJpbmc7IGJyYW5jaDogc3RyaW5nIHwgbnVsbDsgcHI6IHN0cmluZyB8IG51bGw7IHVwZGF0ZWQ6IHN0cmluZzsgbGFzdDogc3RyaW5nOyB3YWl0aW5nOiBib29sZWFuIH1bXSA9IFtdO1xuICB0cnkgeyBsaXN0ID0gYXdhaXQgKGF3YWl0IGZldGNoKFwiL2FnZW50L3JlY2VudFwiLCB7IGNhY2hlOiBcIm5vLXN0b3JlXCIgfSkpLmpzb24oKTsgfSBjYXRjaCB7fVxuICBjb25zdCBjdXJyZW50ID0gbmV3IFNldChbLi4udGFza3MudmFsdWVzKCldLm1hcCgodikgPT4gdi50aHJlYWQpLmZpbHRlcihCb29sZWFuKSk7XG4gIGxpc3QgPSBsaXN0LmZpbHRlcigodCkgPT4gIWN1cnJlbnQuaGFzKHQudGhyZWFkKSk7XG4gIGNvbnN0IHBhbmUgPSAkKFwiZWFybGllclwiKTtcbiAgY29uc3QgZG9uZSA9ICQoXCJkb25lZWFybGllclwiKTtcbiAgcGFuZS5pbm5lckhUTUwgPSBcIlwiO1xuICBkb25lLmlubmVySFRNTCA9IFwiXCI7XG4gIGVhcmxpZXJBY3RpdmVDb3VudCA9IDA7XG4gIGVhcmxpZXJXYWl0aW5nQ291bnQgPSAwO1xuICBmb3IgKGNvbnN0IHQgb2YgbGlzdCkge1xuICAgIGNvbnN0IGNhcmQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGNvbnN0IHN0YXRlID0gdC53YWl0aW5nID8gXCJ3YWl0aW5nIGZvciBhcHByb3ZhbCBpbiBUM1wiIDogdC5zdGF0dXM7XG4gICAgY2FyZC5jbGFzc05hbWUgPSBgdGFzayAke3Quc3RhdHVzID09PSBcInJ1bm5pbmdcIiA/IFwicnVubmluZ1wiIDogdC53YWl0aW5nID8gXCJ3YWl0aW5nXCIgOiBcImZpbmlzaGVkXCJ9YDtcbiAgICBjb25zdCBhZ28gPSBNYXRoLm1heCgwLCAoRGF0ZS5ub3coKSAtIERhdGUucGFyc2UodC51cGRhdGVkKSkgLyAxMDAwKTtcbiAgICBjYXJkLmlubmVySFRNTCA9XG4gICAgICBgPGRpdiBjbGFzcz1cIm1ldGEtcm93XCI+YCArXG4gICAgICAgIGA8c3BhbiBjbGFzcz1cImJhZGdlIHQzXCI+VDM8L3NwYW4+YCArXG4gICAgICAgIGA8c3BhbiBjbGFzcz1cImxhYmVsXCI+PC9zcGFuPmAgK1xuICAgICAgICBgPHNwYW4gY2xhc3M9XCJzdGF0ZVwiPiR7dC5zdGF0dXMgPT09IFwicnVubmluZ1wiID8gJzxzcGFuIGNsYXNzPVwic3BpblwiPjwvc3Bhbj4nIDogXCJcIn0ke2VzY2FwZUh0bWwoc3RhdGUpfTwvc3Bhbj5gICtcbiAgICAgICAgYDxzcGFuIGNsYXNzPVwiYWdlXCI+JHtlbGFwc2VkKGFnbyl9IGFnbzwvc3Bhbj5gICtcbiAgICAgIGA8L2Rpdj5gICtcbiAgICAgIGA8ZGl2IGNsYXNzPVwicFwiPjwvZGl2PmA7XG4gICAgY29uc3QgbGFiZWxFbCA9IGNhcmQucXVlcnlTZWxlY3RvcihcIi5sYWJlbFwiKSBhcyBIVE1MRWxlbWVudDtcbiAgICBsYWJlbEVsLnRleHRDb250ZW50ID0gdC50aXRsZTtcbiAgICBsYWJlbEVsLnRpdGxlID0gdC50aXRsZTtcbiAgICBjYXJkLnF1ZXJ5U2VsZWN0b3IoXCIucFwiKSEudGV4dENvbnRlbnQgPSB0Lmxhc3QgfHwgKHQuYnJhbmNoID8gYE9uICR7dC5icmFuY2h9YCA6IFwiXCIpO1xuICAgIGNvbnN0IGFjdHMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGFjdHMuY2xhc3NOYW1lID0gXCJhY3RzXCI7XG4gICAgaWYgKHQucHIpIHsgY29uc3QgYSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJhXCIpOyBhLmhyZWYgPSB0LnByOyBhLnRhcmdldCA9IFwiX2JsYW5rXCI7IGEucmVsID0gXCJub29wZW5lclwiOyBhLnRleHRDb250ZW50ID0gXCJQUiBcdTIxOTdcIjsgYWN0cy5hcHBlbmQoYSk7IH1cbiAgICBjb25zdCBjb3B5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgICBjb3B5LnR5cGUgPSBcImJ1dHRvblwiO1xuICAgIGNvcHkudGV4dENvbnRlbnQgPSBcIkNvcHkgaWRcIjtcbiAgICBjb3B5Lm9uY2xpY2sgPSAoKSA9PiB7IHZvaWQgbmF2aWdhdG9yLmNsaXBib2FyZD8ud3JpdGVUZXh0KHQudGhyZWFkKTsgdG9hc3QoXCJUaHJlYWQgaWQgY29waWVkXCIpOyB9O1xuICAgIGFjdHMuYXBwZW5kKGNvcHkpO1xuICAgIGNhcmQuYXBwZW5kKGFjdHMpO1xuICAgIGNvbnN0IGFjdGl2ZSA9IHQuc3RhdHVzID09PSBcInJ1bm5pbmdcIiB8fCB0LndhaXRpbmc7XG4gICAgaWYgKGFjdGl2ZSkgZWFybGllckFjdGl2ZUNvdW50Kys7XG4gICAgaWYgKHQud2FpdGluZykgZWFybGllcldhaXRpbmdDb3VudCsrO1xuICAgIChhY3RpdmUgPyBwYW5lIDogZG9uZSkuYXBwZW5kKGNhcmQpO1xuICB9XG4gIHN5bmNTaWRlTGF5b3V0KCk7XG4gIHVwZGF0ZVRhc2tDaHJvbWUoKTtcbn1cblxuY29uc3QgU1RBVFVTX1RFWFQ6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gIGlkbGU6IFwiSWRsZVwiLCBjb25uZWN0aW5nOiBcIkNvbm5lY3RpbmdcdTIwMjZcIiwgbGlzdGVuaW5nOiBcIkxpc3RlbmluZ1wiLCB3b3JraW5nOiBcIkxpc3RlbmluZyBcdTAwQjcgdGFza3MgcnVubmluZ1wiLFxuICBzdGFuZGJ5OiBcIlBhdXNlZCB3aGlsZSB0YXNrcyBydW4gXHUwMEI3IHNwZWFrIHRvIHJlc3VtZVwiLCB3YWtpbmc6IFwiUmVzdW1pbmdcdTIwMjZcIiwgZW5kZWQ6IFwiRW5kZWRcIixcbn07XG5cbmZ1bmN0aW9uIHNob3dTdGF0dXMobWVzc2FnZT86IHN0cmluZykge1xuICBjb25zdCB0eXBlZCA9IEJvb2xlYW4oY2FsbElkKSAmJiBtZWRpdW0gPT09IFwidGV4dFwiO1xuICBjb25zdCBzcGVha2luZyA9IEJvb2xlYW4oY2FsbElkKSAmJiAhdHlwZWQgJiYgY29yZVN0YXR1cyAhPT0gXCJzdGFuZGJ5XCIgJiYgYXVkaW8ucXVldWVkID4gMC4wNTtcbiAgY29uc3Qgc2hvd24gPSBzcGVha2luZyB8fCAodHlwZWQgJiYgdGhpbmtpbmcpID8gXCJzcGVha2luZ1wiIDogY29yZVN0YXR1cztcbiAgJChcInN0YXR1c1wiKS5jbGFzc05hbWUgPSBzaG93bjtcbiAgZG9jdW1lbnQuYm9keS5kYXRhc2V0LnN0YXRlID0gY2FsbElkID8gc2hvd24gOiBcImlkbGVcIjtcbiAgZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QudG9nZ2xlKFwiaW4tc2Vzc2lvblwiLCBCb29sZWFuKGNhbGxJZCkpO1xuICBsZXQgdGV4dCA9IHNwZWFraW5nID8gXCJTcGVha2luZ1wiIDogU1RBVFVTX1RFWFRbY29yZVN0YXR1c10gPz8gY29yZVN0YXR1cztcbiAgaWYgKHR5cGVkICYmIGNvcmVTdGF0dXMgIT09IFwiZW5kZWRcIikgdGV4dCA9IHRoaW5raW5nID8gXCJXcml0aW5nXHUyMDI2XCIgOiBjb3JlU3RhdHVzID09PSBcIndvcmtpbmdcIiA/IFwiQ2hhdCBcdTAwQjcgdGFza3MgcnVubmluZ1wiIDogXCJDaGF0XCI7XG4gIGlmIChjYWxsSWQgJiYgIXR5cGVkICYmIG11dGVkICYmICFob2xkaW5nICYmICFzcGVha2luZykgdGV4dCArPSBcIiBcdTAwQjcgbXV0ZWRcIjtcbiAgaWYgKGhvbGRpbmcpIHRleHQgPSBcIlRhbGtpbmcgKGhvbGQpXCI7XG4gIGlmIChtZXNzYWdlKSB0ZXh0ID0gYCR7dGV4dH06ICR7bWVzc2FnZX1gO1xuICBpZiAoY29yZVN0YXR1cyAhPT0gXCJlbmRlZFwiIHx8IG1lc3NhZ2UpICQoXCJzdGF0dXN0ZXh0XCIpLnRleHRDb250ZW50ID0gdGV4dDtcbiAgJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJodXNoXCIpLmNsYXNzTGlzdC50b2dnbGUoXCJsaXZlXCIsIHNwZWFraW5nIHx8ICh0eXBlZCAmJiB0aGlua2luZykpO1xuXG4gIGNvbnN0IGJhciA9ICQoXCJjYWxsYmFyXCIpO1xuICBiYXIuaGlkZGVuID0gIWNhbGxJZDtcbiAgaWYgKGNhbGxJZCkge1xuICAgICQoXCJjYWxsYmFyLXN0YXRlXCIpLnRleHRDb250ZW50ID0gdGV4dDtcbiAgICAkKFwiY2FsbHRpbWVyXCIpLmhpZGRlbiA9IHR5cGVkO1xuICAgIGlmICghdHlwZWQpICQoXCJjYWxsdGltZXJcIikudGV4dENvbnRlbnQgPSBmb3JtYXRDbG9jayhub3coKSAtIHN0YXJ0ZWRBdCk7XG4gICAgY29uc3Qgdml6TW9kZSA9IHR5cGVkID8gKHRoaW5raW5nID8gXCJ0aGlua2luZ1wiIDogXCJpZGxlXCIpXG4gICAgICA6IHNwZWFraW5nID8gXCJzcGVha2luZ1wiXG4gICAgICA6IG11dGVkICYmICFob2xkaW5nID8gXCJtdXRlZFwiXG4gICAgICA6IHNob3duO1xuICAgIHVwZGF0ZVZpc3VhbGl6ZXIodml6TW9kZSwgbXV0ZWQgJiYgIWhvbGRpbmcgPyAwIDogYXVkaW8ubGV2ZWwpO1xuICB9XG59XG5cbi8vIFRoZSBjYWxsLlxuXG5mdW5jdGlvbiBwdXNoKGV2ZW50OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikge1xuICBpZiAoIWNvcmUgfHwgIWNhbGxJZCkgcmV0dXJuO1xuICBjb25zdCBlOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgLi4uZXZlbnQsIHQ6IG5vdygpIH07XG4gIGNvbnN0IHF1aWV0ID0gZS50eXBlID09PSBcIm1pY1wiIHx8IGUudHlwZSA9PT0gXCJ0aWNrXCI7XG4gIGlmICghcXVpZXQpIGxvZyhcImluXCIsIGUudHlwZSA9PT0gXCJ3cy5tZXNzYWdlXCIgPyBgd3MgJHtlLnNpZH0gXHUyMTkwICR7YnJpZWYoU3RyaW5nKGUuZGF0YSkpfWAgOiBKU09OLnN0cmluZ2lmeShlKS5zbGljZSgwLCA0MDApLCBcImluXCIpO1xuICBydW4oSlNPTi5wYXJzZShjb3JlLnB1c2goY2FsbElkLCBKU09OLnN0cmluZ2lmeShlKSkpKTtcbn1cblxuZnVuY3Rpb24gcnVuKGNvbW1hbmRzOiBDb21tYW5kW10pIHtcbiAgZm9yIChjb25zdCBjIG9mIGNvbW1hbmRzKSB7XG4gICAgc3dpdGNoIChjLnR5cGUpIHtcbiAgICAgIGNhc2UgXCJ3cy5jb25uZWN0XCI6IGNvbm5lY3QoYy5zaWQsIGMucHVycG9zZSA9PT0gXCJjYXB0aW9uc1wiKTsgYnJlYWs7XG4gICAgICBjYXNlIFwid3Muc2VuZFwiOiB7XG4gICAgICAgIHNvY2tldHMuZ2V0KGMuc2lkKT8uc2VuZChjLmRhdGEpO1xuICAgICAgICBpZiAoIWMuZGF0YS5zdGFydHNXaXRoKCd7XCJyZWFsdGltZUlucHV0XCI6e1wiYXVkaW9cIicpKSBsb2coXCJvdXRcIiwgYHdzICR7Yy5zaWR9IFx1MjE5MiAke2JyaWVmKGMuZGF0YSl9YCwgXCJvdXRcIik7XG4gICAgICAgIGVsc2UgaWYgKCFjYXB0aW9uU29ja2V0cy5oYXMoYy5zaWQpKSBjb3VudHMuc2VudCsrO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ3cy5jbG9zZVwiOiBzb2NrZXRzLmdldChjLnNpZCk/LmNsb3NlKCk7IHNvY2tldHMuZGVsZXRlKGMuc2lkKTsgbG9nKFwib3V0XCIsIGB3cyAke2Muc2lkfSBjbG9zZWAsIFwib3V0XCIpOyBicmVhaztcbiAgICAgIGNhc2UgXCJtaWMuc3RhcnRcIjpcbiAgICAgIGNhc2UgXCJtaWMucmVzdGFydFwiOlxuICAgICAgICBsb2coXCJvdXRcIiwgYy50eXBlLCBcIm91dFwiKTtcbiAgICAgICAgdm9pZCBhdWRpby5zdGFydE1pYyhvbk1pYywgbWljT3B0aW9ucygpKS5jYXRjaCgoZXJyKSA9PiB7IGxvZyhcImVycm9yXCIsIGBtaWNyb3Bob25lOiAke2Vyci5tZXNzYWdlfWAsIFwiZXJyXCIpOyB0b2FzdChgTWljcm9waG9uZTogJHtlcnIubWVzc2FnZX1gKTsgfSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcIm1pYy5zdG9wXCI6IGF1ZGlvLnN0b3BNaWMoKTsgYnJlYWs7XG4gICAgICBjYXNlIFwicGxheVwiOiB7XG4gICAgICAgIGNvbnN0IHQgPSBub3coKTtcbiAgICAgICAgLy8gQSByZXBseSBzdGFydGluZzogZnJvbSB0aGUgZW5kIG9mIHRoZSB1c2VyJ3Mgc3BlZWNoIHRvIGl0cyBmaXJzdCBzb3VuZC5cbiAgICAgICAgaWYgKCFtZXRyaWNzLnJlcGxpZWQgJiYgYXVkaW8ucXVldWVkIDwgMC4wNSAmJiB0IC0gbWV0cmljcy5sYXN0UGxheSA+IDAuNiAmJiBtZXRyaWNzLmxhc3RWb2ljZSA+IDAgJiYgdCAtIG1ldHJpY3MubGFzdFZvaWNlIDwgMTApIHtcbiAgICAgICAgICBtZXRyaWNzLnJlcGx5LnB1c2godCAtIG1ldHJpY3MubGFzdFZvaWNlKTtcbiAgICAgICAgICBpZiAobWV0cmljcy5yZXBseS5sZW5ndGggPiAyMCkgbWV0cmljcy5yZXBseS5zaGlmdCgpO1xuICAgICAgICAgIG1ldHJpY3MucmVwbGllZCA9IHRydWU7XG4gICAgICAgICAgc2hvd01ldHJpY3MoKTtcbiAgICAgICAgfVxuICAgICAgICBtZXRyaWNzLmxhc3RQbGF5ID0gdDtcbiAgICAgICAgYXVkaW8ucGxheShjLnBjbSk7XG4gICAgICAgIGNvdW50cy5wbGF5Kys7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcImZsdXNoXCI6IGF1ZGlvLmZsdXNoKCk7IGxvZyhcIm91dFwiLCBcImZsdXNoXCIsIFwib3V0XCIpOyBicmVhaztcbiAgICAgIGNhc2UgXCJjdWVcIjpcbiAgICAgICAgYXVkaW8uY3VlKGMucGNtKTtcbiAgICAgICAgbG9nKFwib3V0XCIsIGBjdWUgJHtjLmVhcmNvbn1gLCBcIm91dFwiKTtcbiAgICAgICAgLy8gQSByZXF1ZXN0IHRoYXQgYmVjYW1lIGEgdGFzayBnZXRzIGEgdG9uZSwgbm90IGEgc3Bva2VuIHJlcGx5OiBub3RoaW5nIHRvIHRpbWUuXG4gICAgICAgIGlmIChjLmVhcmNvbiA9PT0gXCJ0YXNrU3RhcnRlZFwiKSBtZXRyaWNzLnJlcGxpZWQgPSB0cnVlO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJ3YWtld29yZFwiOiBsb2coXCJvdXRcIiwgYHdha2Ugd29yZCAke2Mub24gPyBcImxpc3RlbmluZ1wiIDogXCJvZmZcIn1gLCBcIm91dFwiKTsgYnJlYWs7XG4gICAgICBjYXNlIFwidG9vbC5jYWxsXCI6IHZvaWQgdG9vbChjKTsgYnJlYWs7XG4gICAgICBjYXNlIFwidG9vbC5jYW5jZWxcIjogY2FuY2VsUnVuKGMucnVuLCBjLnJlYXNvbik7IGJyZWFrO1xuICAgICAgY2FzZSBcInRvb2wuc3RlZXJcIjogdm9pZCBzdGVlclJ1bihjKTsgYnJlYWs7XG4gICAgICBjYXNlIFwic3RhdHVzXCI6XG4gICAgICAgIGNvcmVTdGF0dXMgPSBjLnN0YXR1cztcbiAgICAgICAgc2hvd1N0YXR1cyhjLnN0YXR1cyA9PT0gXCJlbmRlZFwiID8gYy5tZXNzYWdlID8/IHVuZGVmaW5lZCA6IHVuZGVmaW5lZCk7XG4gICAgICAgIGxvZyhcInN0YXR1c1wiLCBjLnN0YXR1cyArIChjLm1lc3NhZ2UgPyBgOiAke2MubWVzc2FnZX1gIDogXCJcIiksIFwic3RhdHVzXCIpO1xuICAgICAgICBpZiAoYy5zdGF0dXMgPT09IFwiZW5kZWRcIikgeyBpZiAoYy5tZXNzYWdlKSBub3RlKGMubWVzc2FnZSk7IGVuZCgpOyB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcImxsbS5yZXF1ZXN0XCI6IHZvaWQgZ2VuZXJhdGUoYy5pZCwgYy5ib2R5KTsgYnJlYWs7XG4gICAgICBjYXNlIFwibGxtLmNhbmNlbFwiOiByZXF1ZXN0cy5nZXQoYy5pZCk/LmFib3J0KCk7IHJlcXVlc3RzLmRlbGV0ZShjLmlkKTsgbG9nKFwib3V0XCIsIGByZXF1ZXN0ICR7Yy5pZH0gZHJvcHBlZGAsIFwib3V0XCIpOyBicmVhaztcbiAgICAgIGNhc2UgXCJ0aGlua2luZ1wiOiB0aGlua2luZyA9IGMub247IHNob3dTdGF0dXMoKTsgYnJlYWs7XG4gICAgICBjYXNlIFwiZXJyb3JcIjogbm90ZShjLm1lc3NhZ2UpOyBsb2coXCJlcnJvclwiLCBjLm1lc3NhZ2UsIFwiZXJyXCIpOyBicmVhaztcbiAgICAgIGNhc2UgXCJjYXB0aW9uXCI6IGNhcHRpb24oYy50ZXh0KTsgYnJlYWs7XG4gICAgICBjYXNlIFwidHJhbnNjcmlwdFwiOlxuICAgICAgICB0cmFuc2NyaXB0KGMucm9sZSwgYy50ZXh0LCBjLmxpbmUpO1xuICAgICAgICByZW1lbWJlcihjLnJvbGUsIGMudGV4dCwgYy5yb2xlID09PSBcImFzc2lzdGFudFwiID8gXCJHZW1pbmlcIiA6IHVuZGVmaW5lZCwgbGFzdExpbmUgPT09IGMubGluZSk7XG4gICAgICAgIGxhc3RMaW5lID0gYy5saW5lO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJ0YXNrXCI6IHtcbiAgICAgICAgY29uc3QgdmlldyA9IHRhc2tzLmdldChjLmlkKSA/PyB7IGMsIHNpbmNlOiBub3coKSwgZW5kZWQ6IG51bGwgfTtcbiAgICAgICAgaWYgKGMuc3RhdGUgPT09IFwicnVubmluZ1wiICYmIHZpZXcuYy5zdGF0ZSAhPT0gXCJydW5uaW5nXCIpIHsgdmlldy5zaW5jZSA9IG5vdygpOyB2aWV3LmVuZGVkID0gbnVsbDsgfVxuICAgICAgICBpZiAoYy5zdGF0ZSAhPT0gXCJydW5uaW5nXCIgJiYgdmlldy5lbmRlZCA9PSBudWxsKSB2aWV3LmVuZGVkID0gbm93KCk7XG4gICAgICAgIHZpZXcuYyA9IGM7XG4gICAgICAgIHRhc2tzLnNldChjLmlkLCB2aWV3KTtcbiAgICAgICAgc2hvd1Rhc2tzKCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcInF1ZXN0aW9uc1wiOiBicmVhaztcbiAgICAgIGNhc2UgXCJtaWNTaWxlbnRcIjogJChcIm1pY3dhcm5cIikuaGlkZGVuID0gIWMuc2lsZW50OyBicmVhaztcbiAgICAgIGNhc2UgXCJ2b2ljZUNvbW1hbmRcIjpcbiAgICAgICAgdG9hc3QoYEhlYXJkIFx1MjAxQyR7Yy5oZWFyZH1cdTIwMUQ6ICR7Yy5jb21tYW5kID09PSBcInN0b3BcIiA/IFwic3RvcHBlZFwiIDogYy5jb21tYW5kID09PSBcImNhbmNlbEFsbFwiID8gXCJjYW5jZWxsaW5nIGV2ZXJ5IHRhc2tcIiA6IFwiaGFuZ2luZyB1cFwifWApO1xuICAgICAgICBsb2coXCJvdXRcIiwgYHZvaWNlIGNvbW1hbmQgJHtjLmNvbW1hbmR9OiAke2MuaGVhcmR9YCwgXCJvdXRcIik7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcImxvZ1wiOiBsb2coYy5sZXZlbCwgYy5tZXNzYWdlLCBjLmxldmVsID09PSBcIndhcm5cIiA/IFwid2FyblwiIDogXCJcIik7IGJyZWFrO1xuICAgICAgZGVmYXVsdDogbG9nKFwib3V0XCIsIEpTT04uc3RyaW5naWZ5KGMpLnNsaWNlKDAsIDMwMCksIFwib3V0XCIpO1xuICAgIH1cbiAgfVxufVxuXG5mdW5jdGlvbiBvbk1pYyhwY206IHN0cmluZywgbGV2ZWw6IG51bWJlcikge1xuICBjb3VudHMubWljKys7XG4gIGlmIChsZXZlbCA+IDAuMDMgJiYgIShtdXRlZCAmJiAhaG9sZGluZykpIHtcbiAgICBtZXRyaWNzLmxhc3RWb2ljZSA9IG5vdygpO1xuICAgIGlmIChhdWRpby5xdWV1ZWQgPCAwLjA1KSBtZXRyaWNzLnJlcGxpZWQgPSBmYWxzZTtcbiAgfVxuICBwdXNoKHsgdHlwZTogXCJtaWNcIiwgcGNtIH0pO1xufVxuXG5mdW5jdGlvbiBjb25uZWN0KHNpZDogbnVtYmVyLCBjYXB0aW9uczogYm9vbGVhbikge1xuICBjb25zdCB3cyA9IG5ldyBXZWJTb2NrZXQoYCR7bG9jYXRpb24ucHJvdG9jb2wgPT09IFwiaHR0cHM6XCIgPyBcIndzc1wiIDogXCJ3c1wifTovLyR7bG9jYXRpb24uaG9zdH0vbGl2ZSR7Y2FwdGlvbnMgPyBcIj9mb3I9Y2FwdGlvbnNcIiA6IFwiXCJ9YCk7XG4gIHNvY2tldHMuc2V0KHNpZCwgd3MpO1xuICBpZiAoY2FwdGlvbnMpIGNhcHRpb25Tb2NrZXRzLmFkZChzaWQpO1xuICBsb2coXCJvdXRcIiwgYHdzICR7c2lkfSBjb25uZWN0ICgke3NlcnZlci5yb3V0ZX0ke2NhcHRpb25zID8gXCIsIGNhcHRpb25zXCIgOiBcIlwifSlgLCBcIm91dFwiKTtcbiAgd3Mub25vcGVuID0gKCkgPT4gcHVzaCh7IHR5cGU6IFwid3Mub3BlblwiLCBzaWQgfSk7XG4gIHdzLm9ubWVzc2FnZSA9IChtKSA9PiBwdXNoKHsgdHlwZTogXCJ3cy5tZXNzYWdlXCIsIHNpZCwgZGF0YTogdHlwZW9mIG0uZGF0YSA9PT0gXCJzdHJpbmdcIiA/IG0uZGF0YSA6IFwiXCIgfSk7XG4gIHdzLm9uY2xvc2UgPSAoZSkgPT4ge1xuICAgIGlmIChzb2NrZXRzLmdldChzaWQpICE9PSB3cyAmJiBzb2NrZXRzLmhhcyhzaWQpKSByZXR1cm47XG4gICAgY29uc3QgaHR0cFN0YXR1cyA9IGUuY29kZSA+PSA0MTAwICYmIGUuY29kZSA8IDQ2MDAgPyBlLmNvZGUgLSA0MDAwIDogdW5kZWZpbmVkO1xuICAgIHB1c2goeyB0eXBlOiBcIndzLmNsb3NlZFwiLCBzaWQsIGNvZGU6IGh0dHBTdGF0dXMgPyB1bmRlZmluZWQgOiBlLmNvZGUsIHJlYXNvbjogZS5yZWFzb24sIGh0dHBTdGF0dXMgfSk7XG4gIH07XG59XG5cbi8qKiBBIGNoYXQncyByZXF1ZXN0IHRvIHRoZSB0ZXh0IG1vZGVsLCB0aHJvdWdoIHRoZSBzZXJ2ZXI6IGVhY2ggYGRhdGE6YCBsaW5lIG9mIHRoZSBtb2RlbCdzIHN0cmVhbSBnb2VzIHRvIHRoZSBjb3JlIGFzIGl0IGNvbWVzLiAqL1xuYXN5bmMgZnVuY3Rpb24gZ2VuZXJhdGUoaWQ6IG51bWJlciwgYm9keTogc3RyaW5nKSB7XG4gIGNvbnN0IGFib3J0ID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICByZXF1ZXN0cy5zZXQoaWQsIGFib3J0KTtcbiAgbG9nKFwib3V0XCIsIGByZXF1ZXN0ICR7aWR9IFx1MjE5MiAke3NlcnZlci50ZXh0TW9kZWx9ICgke01hdGgucm91bmQoYm9keS5sZW5ndGggLyAxMDI0KX0gS0IpYCwgXCJvdXRcIik7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChcIi9nZW5lcmF0ZVwiLCB7IG1ldGhvZDogXCJQT1NUXCIsIHNpZ25hbDogYWJvcnQuc2lnbmFsLCBoZWFkZXJzOiB7IFwiY29udGVudC10eXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sIGJvZHkgfSk7XG4gICAgaWYgKCFyZXNwb25zZS5vayB8fCAhcmVzcG9uc2UuYm9keSkge1xuICAgICAgY29uc3QgdGV4dCA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKS5jYXRjaCgoKSA9PiBcIlwiKTtcbiAgICAgIHB1c2goeyB0eXBlOiBcImxsbS5lbmRcIiwgaWQsIHN0YXR1czogcmVzcG9uc2Uuc3RhdHVzLCBlcnJvcjogYEhUVFAgJHtyZXNwb25zZS5zdGF0dXN9JHt0ZXh0ID8gXCI6IFwiICsgdGV4dC5yZXBsYWNlKC9cXHMrL2csIFwiIFwiKS5zbGljZSgwLCAyMDApIDogXCJcIn1gIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCByZWFkZXIgPSByZXNwb25zZS5ib2R5LnBpcGVUaHJvdWdoKG5ldyBUZXh0RGVjb2RlclN0cmVhbSgpKS5nZXRSZWFkZXIoKTtcbiAgICBsZXQgYnVmZmVyID0gXCJcIjtcbiAgICBmb3IgKDs7KSB7XG4gICAgICBjb25zdCB7IHZhbHVlLCBkb25lIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpO1xuICAgICAgaWYgKGRvbmUpIGJyZWFrO1xuICAgICAgYnVmZmVyICs9IHZhbHVlO1xuICAgICAgbGV0IGN1dDtcbiAgICAgIHdoaWxlICgoY3V0ID0gYnVmZmVyLmluZGV4T2YoXCJcXG5cIikpID49IDApIHtcbiAgICAgICAgY29uc3QgbGluZSA9IGJ1ZmZlci5zbGljZSgwLCBjdXQpLnJlcGxhY2UoL1xcciQvLCBcIlwiKTtcbiAgICAgICAgYnVmZmVyID0gYnVmZmVyLnNsaWNlKGN1dCArIDEpO1xuICAgICAgICBpZiAobGluZS5zdGFydHNXaXRoKFwiZGF0YTpcIikpIHB1c2goeyB0eXBlOiBcImxsbS5kYXRhXCIsIGlkLCBkYXRhOiBsaW5lLnNsaWNlKDUpLnRyaW0oKSB9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgcHVzaCh7IHR5cGU6IFwibGxtLmVuZFwiLCBpZCB9KTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgaWYgKCFhYm9ydC5zaWduYWwuYWJvcnRlZCkgcHVzaCh7IHR5cGU6IFwibGxtLmVuZFwiLCBpZCwgZXJyb3I6IChlcnIgYXMgRXJyb3IpLm1lc3NhZ2UgfSk7XG4gIH0gZmluYWxseSB7XG4gICAgcmVxdWVzdHMuZGVsZXRlKGlkKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBjYW5jZWxSdW4oa2V5OiBzdHJpbmcsIHJlYXNvbjogc3RyaW5nKSB7XG4gIGNvbnN0IHIgPSBydW5zLmdldChrZXkpO1xuICBsb2coXCJvdXRcIiwgYGNhbmNlbCAke2tleX0gKCR7cmVhc29ufSlgLCBcIm91dFwiKTtcbiAgaWYgKCFyKSByZXR1cm47XG4gIHJ1bnMuZGVsZXRlKGtleSk7XG4gIHIuYWJvcnQuYWJvcnQoKTtcbiAgLy8gQ2FuY2VsbGVkIG9uIHB1cnBvc2U6IHRoZSBhZ2VudCBzdG9wcyB0b28uIEEgY2FsbCB0aGF0IGVuZGVkIGxlYXZlcyBhIGNvZGluZyBhZ2VudCB3b3JraW5nIGluIFQzLlxuICBpZiAocmVhc29uID09PSBcImNhbmNlbGxlZFwiICYmICFjaGVja2VkKFwiZmFrZWhlcm1lc1wiKSkge1xuICAgIHZvaWQgZmV0Y2goci5hZ2VudCA9PT0gXCJ0M1wiID8gXCIvYWdlbnQvY2FuY2VsXCIgOiBcIi9oZXJtZXMvc3RvcFwiLCB7IG1ldGhvZDogXCJQT1NUXCIsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgY2FsbDogY2FsbE5hbWUsIHRhc2tJZDogci50YXNrSWQgfSkgfSk7XG4gIH1cbn1cblxuLyoqIE1vcmUgZm9yIGEgcnVubmluZyB0YXNrLCBpbnRvIGl0cyBjdXJyZW50IHJ1bjsgaWYgdGhlIGFnZW50IHdvbid0IHRha2UgaXQsIHRoZSBjb3JlIHF1ZXVlcyBpdCBpbnN0ZWFkLiAqL1xuYXN5bmMgZnVuY3Rpb24gc3RlZXJSdW4oYzogQ29tbWFuZCkge1xuICBjb25zdCByID0gcnVucy5nZXQoYy5ydW4pO1xuICBsb2coXCJvdXRcIiwgYHN0ZWVyICR7Yy5ydW59OiAke2MudGV4dH1gLCBcIm91dFwiKTtcbiAgaWYgKGNoZWNrZWQoXCJmYWtlaGVybWVzXCIpKSByZXR1cm47XG4gIGNvbnN0IG9rID0gciAhPSBudWxsICYmXG4gICAgKGF3YWl0IGZldGNoKGMuYWdlbnQgPT09IFwidDNcIiA/IFwiL2FnZW50L3N0ZWVyXCIgOiBcIi9oZXJtZXMvc3RlZXJcIiwgeyBtZXRob2Q6IFwiUE9TVFwiLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGNhbGw6IGNhbGxOYW1lLCB0YXNrSWQ6IHIudGFza0lkLCB0ZXh0OiBjLm1lc3NhZ2UgfSkgfSkudGhlbigoeCkgPT4geC5vaywgKCkgPT4gZmFsc2UpKTtcbiAgaWYgKCFvaykgcHVzaCh7IHR5cGU6IFwidG9vbC5zdGVlckZhaWxlZFwiLCBydW46IGMucnVuLCB0ZXh0OiBjLnRleHQgfSk7XG4gIGVsc2UgdG9hc3QoYCR7Yy5hZ2VudCA9PT0gXCJ0M1wiID8gXCJUaGUgY29kaW5nIGFnZW50XCIgOiBcIkhlcm1lc1wifSB0b29rIHRoZSBmb2xsb3ctdXAgd2hpbGUgaXQgd29ya3NgKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gdG9vbChjOiBDb21tYW5kKSB7XG4gIGlmIChjLmtpbmQgPT09IFwiaG9zdFwiKSB7XG4gICAgbG9nKFwib3V0XCIsIGBob3N0IHRvb2wgJHtjLm5hbWV9ICR7SlNPTi5zdHJpbmdpZnkoYy5hcmdzKX1gLCBcIm91dFwiKTtcbiAgICBjb25zdCBhbnN3ZXIgPSBjLm5hbWUgPT09IFwidHZfdm9sdW1lXCIgPyBgVGhlIFRWIGlzIGF0ICR7KGZha2VUdkxldmVsID0gTnVtYmVyKGMuYXJncz8ubGV2ZWwgPz8gZmFrZVR2TGV2ZWwpKX0uYFxuICAgICAgOiBjLm5hbWUgPT09IFwidHZfcGF1c2VcIiA/IChjLmFyZ3M/LnBhdXNlID09PSBmYWxzZSA/IFwiUGxheWluZy5cIiA6IFwiUGF1c2VkLlwiKSA6IFwiRG9uZS5cIjtcbiAgICBzZXRUaW1lb3V0KCgpID0+IHB1c2goeyB0eXBlOiBcInRvb2wucmVzdWx0XCIsIHJ1bjogYy5ydW4sIHRleHQ6IGFuc3dlciB9KSwgMzAwKTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgYWdlbnQgPSBjLmFnZW50ID09PSBcInQzXCIgPyBcInQzXCIgOiBcImhlcm1lc1wiO1xuICBsb2coXCJvdXRcIiwgYCR7YWdlbnR9ICR7Yy5mb2xsb3dVcCA/IFwiZm9sbG93LXVwXCIgOiBcInRhc2tcIn0gXCIke2MubGFiZWx9XCIke2MucHJvamVjdCA/IGAgaW4gJHtjLnByb2plY3R9YCA6IFwiXCJ9OiAke2MucmVxdWVzdH1gLCBcIm91dFwiKTtcbiAgY29uc3QgYWJvcnQgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gIHJ1bnMuc2V0KGMucnVuLCB7IGFib3J0LCBhZ2VudCwgdGFza0lkOiBjLnRhc2tJZCB9KTtcbiAgY29uc3QgZG9uZSA9ICh0ZXh0OiBzdHJpbmcsIGZhaWxlZCA9IGZhbHNlKSA9PiB7XG4gICAgaWYgKCFydW5zLmhhcyhjLnJ1bikpIHJldHVybjtcbiAgICBydW5zLmRlbGV0ZShjLnJ1bik7XG4gICAgY29uc3QgdmlldyA9IHRhc2tzLmdldChjLnRhc2tJZCk7XG4gICAgY29uc3QgcmVzSWQgPSByZXN1bHQoYWdlbnQsIGMubGFiZWwsIHRleHQsIGZhaWxlZCwgYy50YXNrSWQpO1xuICAgIG5vdGlmeShgJHthZ2VudCA9PT0gXCJ0M1wiID8gXCJUM1wiIDogXCJIZXJtZXNcIn0gXHUwMEI3ICR7Yy5sYWJlbH1gLCB0ZXh0KTtcbiAgICBpZiAoIWZhaWxlZCkgeyByZW1lbWJlcihcImFzc2lzdGFudFwiLCB0ZXh0LCBgJHthZ2VudCA9PT0gXCJ0M1wiID8gXCJUM1wiIDogXCJIZXJtZXNcIn0gXHUwMEI3ICR7Yy5sYWJlbH1gKTsgbGFzdExpbmUgPSBudWxsOyB9XG4gICAgaWYgKHZpZXcpIHsgdmlldy5yZXN1bHRJZCA9IHJlc0lkOyBzaG93VGFza3MoKTsgfVxuICAgIHB1c2goeyB0eXBlOiBcInRvb2wucmVzdWx0XCIsIHJ1bjogYy5ydW4sIHRleHQsIGZhaWxlZCB9KTtcbiAgfTtcbiAgaWYgKGNoZWNrZWQoXCJmYWtlaGVybWVzXCIpKSB7XG4gICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IGRvbmUoYChGYWtlICR7YWdlbnQgPT09IFwidDNcIiA/IFwiVDNcIiA6IFwiSGVybWVzXCJ9KSBEb25lOiBcdTIwMUMke2MucmVxdWVzdH1cdTIwMUQuIE5vdGhpbmcgd2FzIGFjdHVhbGx5IHJ1bi5gKSwgTnVtYmVyKCQ8SFRNTElucHV0RWxlbWVudD4oXCJmYWtlZGVsYXlcIikudmFsdWUpICogMTAwMCk7XG4gICAgYWJvcnQuc2lnbmFsLm9uYWJvcnQgPSAoKSA9PiBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgIHJldHVybjtcbiAgfVxuICB0cnkge1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goYWdlbnQgPT09IFwidDNcIiA/IFwiL2FnZW50XCIgOiBcIi9oZXJtZXNcIiwge1xuICAgICAgbWV0aG9kOiBcIlBPU1RcIiwgc2lnbmFsOiBhYm9ydC5zaWduYWwsIGhlYWRlcnM6IHsgXCJjb250ZW50LXR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgY2FsbDogY2FsbE5hbWUsIHRhc2tJZDogYy50YXNrSWQsIGZvbGxvd1VwOiBjLmZvbGxvd1VwLCBtZXNzYWdlOiBjLm1lc3NhZ2UsIGxhYmVsOiBjLmxhYmVsLCByZXF1ZXN0OiBjLnJlcXVlc3QsIHByb2plY3Q6IGMucHJvamVjdCwgYXBwcm92YWxzOiBcInNjcmVlblwiIH0pLFxuICAgIH0pO1xuICAgIGlmICghcmVzcG9uc2Uub2sgfHwgIXJlc3BvbnNlLmJvZHkpIHRocm93IG5ldyBFcnJvcihgSFRUUCAke3Jlc3BvbnNlLnN0YXR1c31gKTtcbiAgICBjb25zdCByZWFkZXIgPSByZXNwb25zZS5ib2R5LnBpcGVUaHJvdWdoKG5ldyBUZXh0RGVjb2RlclN0cmVhbSgpKS5nZXRSZWFkZXIoKTtcbiAgICBsZXQgYnVmZmVyID0gXCJcIjtcbiAgICBmb3IgKDs7KSB7XG4gICAgICBjb25zdCB7IHZhbHVlLCBkb25lOiBmaW5pc2hlZCB9ID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcbiAgICAgIGlmIChmaW5pc2hlZCkgYnJlYWs7XG4gICAgICBidWZmZXIgKz0gdmFsdWU7XG4gICAgICBsZXQgY3V0O1xuICAgICAgd2hpbGUgKChjdXQgPSBidWZmZXIuaW5kZXhPZihcIlxcblxcblwiKSkgPj0gMCkge1xuICAgICAgICBjb25zdCBibG9jayA9IGJ1ZmZlci5zbGljZSgwLCBjdXQpO1xuICAgICAgICBidWZmZXIgPSBidWZmZXIuc2xpY2UoY3V0ICsgMik7XG4gICAgICAgIGNvbnN0IGV2ZW50ID0gYmxvY2subWF0Y2goL15ldmVudDogKC4qKSQvbSk/LlsxXTtcbiAgICAgICAgaWYgKCFldmVudCkgY29udGludWU7XG4gICAgICAgIGNvbnN0IGRhdGEgPSBKU09OLnBhcnNlKGJsb2NrLm1hdGNoKC9eZGF0YTogKC4qKSQvbSk/LlsxXSA/PyBcInt9XCIpO1xuICAgICAgICBpZiAoZXZlbnQgPT09IFwicHJvZ3Jlc3NcIikgcHVzaCh7IHR5cGU6IFwidGFzay5wcm9ncmVzc1wiLCB0YXNrOiBjLnRhc2tJZCwgdGV4dDogZGF0YS50ZXh0IH0pO1xuICAgICAgICBlbHNlIGlmIChldmVudCA9PT0gXCJ0aHJlYWRcIikgeyBjb25zdCB2aWV3ID0gdGFza3MuZ2V0KGMudGFza0lkKTsgaWYgKHZpZXcpIHsgdmlldy50aHJlYWQgPSBkYXRhLnRocmVhZDsgc2hvd1Rhc2tzKCk7IH0gfVxuICAgICAgICBlbHNlIGlmIChldmVudCA9PT0gXCJhcHByb3ZhbFwiKSB7XG4gICAgICAgICAgY29uc3QgdmlldyA9IHRhc2tzLmdldChjLnRhc2tJZCk7XG4gICAgICAgICAgaWYgKHZpZXcpIHsgdmlldy5hcHByb3ZhbCA9IHsgY29tbWFuZDogZGF0YS5jb21tYW5kIH07IHNob3dUYXNrcyh0cnVlKTsgfVxuICAgICAgICAgIHRvYXN0KGBIZXJtZXMgYXNrcyB0byBydW46ICR7ZGF0YS5jb21tYW5kLnNsaWNlKDAsIDgwKX1gKTtcbiAgICAgICAgICBub3RpZnkoYEhlcm1lcyBcdTAwQjcgJHtjLmxhYmVsfSBuZWVkcyB5b3VyIGFwcHJvdmFsYCwgZGF0YS5jb21tYW5kKTtcbiAgICAgICAgICBhdWRpby5jdWUoQVBQUk9WQUxfVE9ORSk7XG4gICAgICAgIH1cbiAgICAgICAgZWxzZSBpZiAoZXZlbnQgPT09IFwicmVzdWx0XCIpIGRvbmUoZGF0YS50ZXh0LCBkYXRhLmZhaWxlZCk7XG4gICAgICAgIGVsc2UgaWYgKGV2ZW50ID09PSBcImVycm9yXCIpIHsgcnVucy5kZWxldGUoYy5ydW4pOyBwdXNoKHsgdHlwZTogXCJ0b29sLmVycm9yXCIsIHJ1bjogYy5ydW4sIG1lc3NhZ2U6IGRhdGEubWVzc2FnZSB9KTsgfVxuICAgICAgfVxuICAgIH1cbiAgICBpZiAocnVucy5oYXMoYy5ydW4pKSB7IHJ1bnMuZGVsZXRlKGMucnVuKTsgcHVzaCh7IHR5cGU6IFwidG9vbC5lcnJvclwiLCBydW46IGMucnVuLCBtZXNzYWdlOiBcInRoZSBzZXJ2ZXIgY2xvc2VkIHRoZSBzdHJlYW0gd2l0aG91dCBhIHJlc3VsdFwiIH0pOyB9XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGlmICghYWJvcnQuc2lnbmFsLmFib3J0ZWQgJiYgcnVucy5oYXMoYy5ydW4pKSB7IHJ1bnMuZGVsZXRlKGMucnVuKTsgcHVzaCh7IHR5cGU6IFwidG9vbC5lcnJvclwiLCBydW46IGMucnVuLCBtZXNzYWdlOiAoZXJyIGFzIEVycm9yKS5tZXNzYWdlIH0pOyB9XG4gIH1cbn1cblxuZnVuY3Rpb24gbWljT3B0aW9ucygpIHtcbiAgY29uc3QgYWVjID0gY2hlY2tlZChcImFlY1wiKTtcbiAgcmV0dXJuIHsgZWNob0NhbmNlbGxhdGlvbjogYWVjLCBub2lzZVN1cHByZXNzaW9uOiBhZWMsIGF1dG9HYWluQ29udHJvbDogYWVjIH07XG59XG5cbmZ1bmN0aW9uIHJlYWRDb25maWcoKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICBjb25zdCBnaXZlbiA9IEpTT04ucGFyc2UoJDxIVE1MVGV4dEFyZWFFbGVtZW50PihcImNvbmZpZ1wiKS52YWx1ZSk7XG4gIGNvbnN0IGNvbmZpZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgbW9kZWw6IHNlcnZlci5tb2RlbCwgYXBpOiBzZXJ2ZXIucm91dGUgPT09IFwidmVydGV4XCIgPyBcInZlcnRleFwiIDogXCJnZW1pbmlcIiwgdG9kYXk6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKS5zbGljZSgwLCAxMCksXG4gICAgLi4uZ2l2ZW4sIHRyYWNlOiBjaGVja2VkKFwidHJhY2VcIiksXG4gIH07XG4gIGlmIChjaGVja2VkKFwicHR0XCIpKSBjb25maWcubXV0ZWQgPSB0cnVlO1xuICBpZiAoZ2l2ZW4udm9pY2UgPT09IHVuZGVmaW5lZCkgY29uZmlnLnZvaWNlID0gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJ2b2ljZVwiKS52YWx1ZTtcbiAgaWYgKGNvbmZpZy5zdGVlcmluZyA9PT0gdW5kZWZpbmVkKSBjb25maWcuc3RlZXJpbmcgPSBbXCJoZXJtZXNcIiwgXCJ0M1wiXTtcbiAgLy8gQSB3ZWIgY29uZmlnIHNhdmVkIGJlZm9yZSBoYW5kLW9mZnMgd2VyZSBuYW1lZCBpbiB3b3JkcyBnZXRzIHRoYXQgdG9vLlxuICBpZiAoY29uZmlnLmhhbmRPZmYgPT09IHVuZGVmaW5lZCAmJiBjb25maWcucGxhdGZvcm0gPT09IFwid2ViXCIpIGNvbmZpZy5oYW5kT2ZmID0gXCJuYW1lZFwiO1xuICAvLyBBbmQgb25lIHNhdmVkIGJlZm9yZSB0aGUgcGFnZSBmb2xsb3dlZCB0aGUgdXNlcidzIGxlYWQgKHN1cGVydmlzZSkgZ2V0cyB0aGF0LlxuICBpZiAoY29uZmlnLnN1cGVydmlzZSA9PT0gdW5kZWZpbmVkICYmIGNvbmZpZy5wbGF0Zm9ybSA9PT0gXCJ3ZWJcIikgY29uZmlnLnN1cGVydmlzZSA9IHRydWU7XG4gIGlmIChjaGVja2VkKFwiY29kaW5nXCIpICYmIChzZXJ2ZXIudDMgfHwgY2hlY2tlZChcImZha2VoZXJtZXNcIikpICYmIGNvbmZpZy5jb2RpbmdBZ2VudCA9PT0gdW5kZWZpbmVkKSBjb25maWcuY29kaW5nQWdlbnQgPSB7IHByb2plY3RzOiBzZXJ2ZXIudDMgPz8gW10gfTtcbiAgaWYgKGNoZWNrZWQoXCJjYXB0aW9uc1wiKSAmJiBzZXJ2ZXIuY2FwdGlvbnNNb2RlbCAmJiBjb25maWcuY2FwdGlvbnMgPT09IHVuZGVmaW5lZCkgY29uZmlnLmNhcHRpb25zID0geyBtb2RlbDogc2VydmVyLmNhcHRpb25zTW9kZWwgfTtcbiAgcmV0dXJuIGNvbmZpZztcbn1cblxuLyoqIFN0YXJ0cyBhIHZvaWNlIGNhbGwsIG9yIHdpdGggW3R5cGVkXSBhIGNoYXQgKHRoZSBjb3JlJ3MgbWVkaXVtIFwidGV4dFwiOiBubyBhdWRpbywgYSB0ZXh0IG1vZGVsKS4gKi9cbmFzeW5jIGZ1bmN0aW9uIHN0YXJ0KGNhcnJ5T24gPSBmYWxzZSwgdHlwZWQgPSBmYWxzZSkge1xuICBhd2FpdCBlbmRpbmc7XG4gIGlmIChjYWxsSWQpIHJldHVybjtcbiAgbGV0IGdpdmVuOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgdHJ5IHtcbiAgICBnaXZlbiA9IHJlYWRDb25maWcoKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgdG9hc3QoYFRoZSBkZXZlbG9wZXIgc2V0dGluZ3MgYXJlbid0IHZhbGlkIEpTT046ICR7KGVyciBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKHR5cGVkKSB7XG4gICAgaWYgKCFzZXJ2ZXIudGV4dE1vZGVsKSB7IHRvYXN0KFwiVGhpcyBzZXJ2ZXIgaGFzIG5vIHRleHQgbW9kZWwgZm9yIGEgY2hhdDogc3RhcnQgYSBjYWxsIHRvIHR5cGUgdG8gaXRcIik7IHJldHVybjsgfVxuICAgIGdpdmVuID0geyAuLi5naXZlbiwgbWVkaXVtOiBcInRleHRcIiwgbXV0ZWQ6IGZhbHNlIH07XG4gICAgZGVsZXRlIGdpdmVuLmNhcHRpb25zO1xuICB9XG4gICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiY2FsbFwiKS5kaXNhYmxlZCA9IHRydWU7XG4gICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiaGVyby1jYWxsXCIpLmRpc2FibGVkID0gdHJ1ZTtcbiAgaWYgKFwiTm90aWZpY2F0aW9uXCIgaW4gd2luZG93ICYmIE5vdGlmaWNhdGlvbi5wZXJtaXNzaW9uID09PSBcImRlZmF1bHRcIikgdm9pZCBOb3RpZmljYXRpb24ucmVxdWVzdFBlcm1pc3Npb24oKS5jYXRjaCgoKSA9PiB7fSk7XG4gIHRyeSB7XG4gICAgaWYgKCF0eXBlZCkgYXdhaXQgYXVkaW8ub3BlbigpO1xuICAgIGNvcmUgPSBhd2FpdCBsb2FkQ29yZSgpO1xuICB9IGZpbmFsbHkge1xuICAgICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiY2FsbFwiKS5kaXNhYmxlZCA9IGZhbHNlO1xuICAgICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiaGVyby1jYWxsXCIpLmRpc2FibGVkID0gZmFsc2U7XG4gIH1cbiAgaWYgKGNhbGxJZCkgcmV0dXJuOyAvLyBhbm90aGVyIHN0YXJ0IGdvdCB0aGVyZSBmaXJzdFxuICBtZWRpdW0gPSB0eXBlZCA/IFwidGV4dFwiIDogXCJ2b2ljZVwiO1xuICB0aGlua2luZyA9IGZhbHNlO1xuICAkKFwidmVyc2lvblwiKS50ZXh0Q29udGVudCA9IGNvcmUudmVyc2lvbjtcbiAgJChcImxvZ1wiKS5pbm5lckhUTUwgPSBcIlwiO1xuICBpZiAoIXR5cGVkICYmICh0YXNrcy5zaXplID4gMCB8fCAkKFwidHJhbnNjcmlwdFwiKS5jaGlsZEVsZW1lbnRDb3VudCA+IDEpKSBub3RlKGBOZXcgY2FsbCBcdTAwQjcgJHtuZXcgRGF0ZSgpLnRvTG9jYWxlVGltZVN0cmluZygpfWApO1xuICB0YXNrcy5jbGVhcigpO1xuICBzaG93VGFza3MoKTtcbiAgY291bnRzID0geyBtaWM6IDAsIHBsYXk6IDAsIHNlbnQ6IDAgfTtcbiAgbWV0cmljcy5yZXBseSA9IFtdO1xuICBzdGFydGVkQXQgPSBub3coKTtcbiAgbXV0ZWQgPSBnaXZlbi5tdXRlZCA9PT0gdHJ1ZTtcbiAgLy8gQ2Fycnlpbmcgb246IHRoZSBtb2RlbCBnZXRzIHRoZSBsYXN0IGNvbnZlcnNhdGlvbiBhcyBhIHJlY2FwLiBUaGUgY29yZSBjYXBzIGl0LCBsYXRlc3QgbGluZXMgZmlyc3QuXG4gIC8vIEEgY2hhdCBhbHdheXMgY2FycmllcyBvbiBmcm9tIHdoYXQncyBvbiB0aGUgc2NyZWVuIChhbiBlYXJsaWVyIGNhbGwgb3IgY2hhdCBvbiB0aGlzIHBhZ2UpLlxuICBpZiAodHlwZWQpIHsgaWYgKGNoYXQubGVuZ3RoID4gMCAmJiBnaXZlbi5oaXN0b3J5ID09PSB1bmRlZmluZWQpIGdpdmVuLmhpc3RvcnkgPSBjaGF0OyB9XG4gIGVsc2UgaWYgKGNhcnJ5T24gJiYgZ2l2ZW4uaGlzdG9yeSA9PT0gdW5kZWZpbmVkKSBnaXZlbi5oaXN0b3J5ID0gc2F2ZWRIaXN0b3J5KCk7XG4gIGVsc2UgaWYgKCFjYXJyeU9uKSBjaGF0ID0gW107XG4gIGlmIChjYXJyeU9uICYmICF0eXBlZCkgY2hhdCA9IHNhdmVkSGlzdG9yeSgpO1xuICBsYXN0TGluZSA9IG51bGw7XG4gIG9wZW5MaW5lID0gbnVsbDtcbiAgc3luY1Jlc3VtZUJ1dHRvbnMoZmFsc2UpO1xuICBjYWxsTmFtZSA9IGAke25ldyBEYXRlKCkudG9JU09TdHJpbmcoKS5yZXBsYWNlKC9bOi5dL2csIFwiLVwiKX0tJHt0eXBlZCA/IFwiY2hhdFwiIDogXCJ3ZWJcIn0tJHtjb3JlLnZlcnNpb259YDtcbiAgY29uc3QgY3JlYXRlZCA9IEpTT04ucGFyc2UoY29yZS5jcmVhdGUoSlNPTi5zdHJpbmdpZnkoZ2l2ZW4pLCBub3coKSkpO1xuICBjYWxsSWQgPSBjcmVhdGVkLmlkO1xuICBpZiAoIXR5cGVkKSB7XG4gICAgc2V0Q2FsbEJ1dHRvbih0cnVlKTtcbiAgICAkPEhUTUxCdXR0b25FbGVtZW50PihcIm1pY1wiKS5kaXNhYmxlZCA9IGZhbHNlO1xuICB9XG4gICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiaHVzaFwiKS5kaXNhYmxlZCA9IGZhbHNlO1xuICAkKFwibWljXCIpLmNsYXNzTGlzdC50b2dnbGUoXCJtdXRlZFwiLCBtdXRlZCk7XG4gIHJ1bihjcmVhdGVkLmNvbW1hbmRzKTtcbiAgc2hvd1N0YXR1cygpO1xuICB0aWNrZXIgPSB3aW5kb3cuc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgIHB1c2goeyB0eXBlOiBcInRpY2tcIiB9KTtcbiAgICBjb25zdCBsZXZlbCA9IG11dGVkICYmICFob2xkaW5nID8gMCA6IGF1ZGlvLmxldmVsO1xuICAgIGNvbnN0IHN0cmVuZ3RoID0gTWF0aC5taW4oMSwgbGV2ZWwgKiAxMik7XG4gICAgJChcInJpbmdcIikuc3R5bGUub3BhY2l0eSA9IFN0cmluZyhzdHJlbmd0aCk7XG4gICAgJChcInJpbmdcIikuc3R5bGUudHJhbnNmb3JtID0gYHNjYWxlKCR7KDEgKyBzdHJlbmd0aCAqIDAuMTIpLnRvRml4ZWQoMyl9KWA7XG4gICAgJChcImNvdW50c1wiKS50ZXh0Q29udGVudCA9IGBtaWMgJHtjb3VudHMubWljfSBcdTAwQjcgc2VudCAke2NvdW50cy5zZW50fSBcdTAwQjcgcGxheWVkICR7Y291bnRzLnBsYXl9IFx1MDBCNyBxdWV1ZWQgJHthdWRpby5xdWV1ZWQudG9GaXhlZCgxKX0gc2A7XG4gICAgc2hvd1N0YXR1cygpO1xuICB9LCAxMDApO1xuICB0cmFjZVRpbWVyID0gd2luZG93LnNldEludGVydmFsKCgpID0+IHsgdm9pZCBzYXZlVHJhY2UoKTsgdm9pZCBwaW5nKCk7IHNob3dUYXNrcygpOyB9LCA1MDAwKTtcbiAgdm9pZCBwaW5nKCk7XG4gIGlmICh0eXBlZCkgcmV0dXJuO1xuICBzdG9wV29yZHMuc3RhcnQoKTtcbiAgdHJ5IHsgd2FrZUxvY2sgPSBhd2FpdCAobmF2aWdhdG9yIGFzIGFueSkud2FrZUxvY2s/LnJlcXVlc3QoXCJzY3JlZW5cIik7IH0gY2F0Y2gge31cbn1cblxuLyoqIFRoZSBDYWxsIGJ1dHRvbjogaGFuZ3MgdXAgYSBjYWxsOyBzdGFydHMgb25lOyBvciwgd2l0aCBhIGNoYXQgb24sIGVuZHMgdGhlIGNoYXQgYW5kIGNhcnJpZXMgaXRzIGNvbnZlcnNhdGlvbiBvbiBieSB2b2ljZS4gKi9cbmFzeW5jIGZ1bmN0aW9uIGNhbGxCdXR0b24oKSB7XG4gIGlmIChjYWxsSWQgJiYgbWVkaXVtID09PSBcInZvaWNlXCIpIHsgaGFuZ1VwKCk7IHJldHVybjsgfVxuICBpZiAoY2FsbElkKSB7XG4gICAgLy8gQSBjYWxsIGNhbid0IHRha2Ugb3ZlciB0aGUgY2hhdCdzIHRhc2tzLCBhbmQgZW5kaW5nIHRoZSBjaGF0IHdvdWxkIHN0b3AgdGhlbS5cbiAgICBpZiAoWy4uLnRhc2tzLnZhbHVlcygpXS5zb21lKCh2KSA9PiB2LmMuc3RhdGUgPT09IFwicnVubmluZ1wiKSkgeyB0b2FzdChcIlRoZSBjaGF0J3MgdGFza3MgYXJlIHN0aWxsIHJ1bm5pbmc6IHdhaXQgZm9yIHRoZW0gb3IgY2FuY2VsIHRoZW0sIHRoZW4gY2FsbFwiKTsgcmV0dXJuOyB9XG4gICAgcHVzaCh7IHR5cGU6IFwic3RvcFwiIH0pO1xuICAgIGF3YWl0IHN0YXJ0KHRydWUpO1xuICAgIHJldHVybjtcbiAgfVxuICBhd2FpdCBzdGFydCgpO1xufVxuXG5mdW5jdGlvbiBoYW5nVXAoKSB7XG4gIGlmIChjYWxsSWQpIHB1c2goeyB0eXBlOiBcInN0b3BcIiwgbWVzc2FnZTogXCJZb3UgaHVuZyB1cC5cIiB9KTtcbn1cblxuZnVuY3Rpb24gZW5kKCkge1xuICB3aW5kb3cuY2xlYXJJbnRlcnZhbCh0aWNrZXIpO1xuICB3aW5kb3cuY2xlYXJJbnRlcnZhbCh0cmFjZVRpbWVyKTtcbiAgc3RvcFdvcmRzLnN0b3AoKTtcbiAgZW5kaW5nID0gc2F2ZVRyYWNlKCkudGhlbigoKSA9PiB7IGlmIChjb3JlICYmIGNhbGxJZCkgY29yZS5kaXNwb3NlKGNhbGxJZCk7IGNhbGxJZCA9IDA7IHNob3dUYXNrcygpOyBzaG93U3RhdHVzKCk7IH0pO1xuICBhdWRpby5zdG9wKCk7XG4gIGZvciAoY29uc3Qgd3Mgb2Ygc29ja2V0cy52YWx1ZXMoKSkgd3MuY2xvc2UoKTtcbiAgc29ja2V0cy5jbGVhcigpO1xuICBmb3IgKGNvbnN0IHIgb2YgcnVucy52YWx1ZXMoKSkgci5hYm9ydC5hYm9ydCgpO1xuICBydW5zLmNsZWFyKCk7XG4gIGZvciAoY29uc3QgciBvZiByZXF1ZXN0cy52YWx1ZXMoKSkgci5hYm9ydCgpO1xuICByZXF1ZXN0cy5jbGVhcigpO1xuICB0aGlua2luZyA9IGZhbHNlO1xuICBzZXRDYWxsQnV0dG9uKGZhbHNlKTtcbiAgZm9yIChjb25zdCBpZCBvZiBbXCJtaWNcIiwgXCJodXNoXCJdKSAkPEhUTUxCdXR0b25FbGVtZW50PihpZCkuZGlzYWJsZWQgPSB0cnVlO1xuICAkKFwicmluZ1wiKS5zdHlsZS5vcGFjaXR5ID0gXCIwXCI7XG4gICQoXCJyaW5nXCIpLnN0eWxlLnRyYW5zZm9ybSA9IFwiXCI7XG4gICQoXCJjYWxsYmFyXCIpLmhpZGRlbiA9IHRydWU7XG4gICQoXCJtaWN3YXJuXCIpLmhpZGRlbiA9IHRydWU7XG4gIGRvY3VtZW50LmJvZHkuZGF0YXNldC5zdGF0ZSA9IFwiaWRsZVwiO1xuICBkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5yZW1vdmUoXCJpbi1zZXNzaW9uXCIpO1xuICBzeW5jUmVzdW1lQnV0dG9ucyhjaGF0Lmxlbmd0aCA+IDApO1xuICB2b2lkIHNob3dFYXJsaWVyKCk7XG4gIHZvaWQgd2FrZUxvY2s/LnJlbGVhc2UoKS5jYXRjaCgoKSA9PiB7fSk7XG4gIHdha2VMb2NrID0gbnVsbDtcbn1cblxuZnVuY3Rpb24gc2V0TXV0ZWQodmFsdWU6IGJvb2xlYW4pIHtcbiAgaWYgKCFjYWxsSWQgfHwgbXV0ZWQgPT09IHZhbHVlKSByZXR1cm47XG4gIG11dGVkID0gdmFsdWU7XG4gICQoXCJtaWNcIikuY2xhc3NMaXN0LnRvZ2dsZShcIm11dGVkXCIsIG11dGVkKTtcbiAgcHVzaCh7IHR5cGU6IG11dGVkID8gXCJtdXRlXCIgOiBcInVubXV0ZVwiIH0pO1xuICBzaG93U3RhdHVzKCk7XG59XG5cbi8qKiBTZW5kcyB3aGF0IHRoZSB0cmFjZSBrZXB0IHNpbmNlIGxhc3QgdGltZSB0byB0aGUgZGV2IHNlcnZlciwgYXMgSlNPTiBsaW5lczogYSBoZWFkZXIsIHRoZW4gZXZlbnRzLiAqL1xuYXN5bmMgZnVuY3Rpb24gc2F2ZVRyYWNlKCkge1xuICBpZiAoIWNvcmUgfHwgIWNhbGxJZCB8fCAhY2hlY2tlZChcInRyYWNlXCIpKSByZXR1cm47XG4gIGNvbnN0IGtlcHQgPSBKU09OLnBhcnNlKGNvcmUudHJhY2UoY2FsbElkKSk7XG4gIGlmICgha2VwdCkgcmV0dXJuO1xuICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcbiAgaWYgKGtlcHQuY29uZmlnKSBsaW5lcy5wdXNoKEpTT04uc3RyaW5naWZ5KHsgdmVyc2lvbjoga2VwdC52ZXJzaW9uLCBjb25maWc6IGtlcHQuY29uZmlnLCBzdGFydDoga2VwdC5zdGFydCB9KSk7XG4gIGZvciAoY29uc3QgZSBvZiBrZXB0LmV2ZW50cykgbGluZXMucHVzaChKU09OLnN0cmluZ2lmeShlKSk7XG4gIGlmIChsaW5lcy5sZW5ndGggPT09IDApIHJldHVybjtcbiAgYXdhaXQgZmV0Y2goYC90cmFjZXM/bmFtZT0ke2VuY29kZVVSSUNvbXBvbmVudChjYWxsTmFtZSl9Lmpzb25sYCwgeyBtZXRob2Q6IFwiUE9TVFwiLCBib2R5OiBsaW5lcy5qb2luKFwiXFxuXCIpICsgXCJcXG5cIiB9KS5jYXRjaCgoKSA9PiB7fSk7XG4gICQoXCJ0cmFjZW5hbWVcIikudGV4dENvbnRlbnQgPSBgdHJhY2UgJHtjYWxsTmFtZX0uanNvbmxgO1xufVxuXG4vLyBcIlN0b3BcIiBhbmQgXCJnb29kYnllXCIgaGVhcmQgYnkgdGhlIGJyb3dzZXIncyBvd24gcmVjb2duaXplcjogcXVpY2tlciB0aGFuIHRoZSBtb2RlbCdzIHRyYW5zY3JpcHQsXG4vLyBhbmQgaXQgd29ya3Mgd2hpbGUgdGhlIG1vZGVsJ3MgcmVwbHkgcGxheXMgZXZlbiB3aGVuIHRoZSBtb2RlbCBpc24ndCBoZWFyaW5nIHRoZSBtaWNyb3Bob25lLlxuXG5jbGFzcyBTdG9wV29yZHMge1xuICBwcml2YXRlIHJlYzogYW55ID0gbnVsbDtcbiAgcHJpdmF0ZSBvbiA9IGZhbHNlO1xuICBwcml2YXRlIGNvbW1hbmRzID0geyBzdG9wOiBbXSBhcyBzdHJpbmdbXSwgaGFuZ1VwOiBbXSBhcyBzdHJpbmdbXSwgY2FuY2VsQWxsOiBbXSBhcyBzdHJpbmdbXSB9O1xuXG4gIGdldCBzdXBwb3J0ZWQoKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIFwid2Via2l0U3BlZWNoUmVjb2duaXRpb25cIiBpbiB3aW5kb3cgfHwgXCJTcGVlY2hSZWNvZ25pdGlvblwiIGluIHdpbmRvdztcbiAgfVxuXG4gIHN0YXJ0KCkge1xuICAgIGlmICghY2hlY2tlZChcInN0b3B3b3JkXCIpIHx8ICF0aGlzLnN1cHBvcnRlZCB8fCAhY29yZSkgcmV0dXJuO1xuICAgIHRoaXMuY29tbWFuZHMgPSBKU09OLnBhcnNlKGNvcmUuZGVmYXVsdHMoKSkudm9pY2VDb21tYW5kcztcbiAgICBjb25zdCBSZWNvZ25pdGlvbiA9ICh3aW5kb3cgYXMgYW55KS5TcGVlY2hSZWNvZ25pdGlvbiA/PyAod2luZG93IGFzIGFueSkud2Via2l0U3BlZWNoUmVjb2duaXRpb247XG4gICAgdGhpcy5yZWMgPSBuZXcgUmVjb2duaXRpb24oKTtcbiAgICB0aGlzLnJlYy5jb250aW51b3VzID0gdHJ1ZTtcbiAgICB0aGlzLnJlYy5pbnRlcmltUmVzdWx0cyA9IHRydWU7XG4gICAgdGhpcy5yZWMubGFuZyA9IG5hdmlnYXRvci5sYW5ndWFnZSB8fCBcImVuLUdCXCI7XG4gICAgdGhpcy5yZWMub25yZXN1bHQgPSAoZTogYW55KSA9PiB7XG4gICAgICBmb3IgKGxldCBpID0gZS5yZXN1bHRJbmRleDsgaSA8IGUucmVzdWx0cy5sZW5ndGg7IGkrKykge1xuICAgICAgICBjb25zdCB0ZXh0ID0gZS5yZXN1bHRzW2ldWzBdLnRyYW5zY3JpcHQgYXMgc3RyaW5nO1xuICAgICAgICBjb25zdCBjb21tYW5kID0gY29tbWFuZEluKHRleHQsIHRoaXMuY29tbWFuZHMsIFtcIldvb2Rob3VzZVwiLCBcIkhlcm1lc1wiLCBcIkJlbnRvXCJdKTtcbiAgICAgICAgaWYgKGNvbW1hbmQgPT09IFwic3RvcFwiICYmIGF1ZGlvLnF1ZXVlZCA+IDAuMDUpIHtcbiAgICAgICAgICBsb2coXCJvdXRcIiwgYGxvY2FsIHN0b3Agd29yZDogJHt0ZXh0fWAsIFwib3V0XCIpO1xuICAgICAgICAgIHRvYXN0KGBIZWFyZCBcdTIwMUMke3RleHQudHJpbSgpfVx1MjAxRDogc3RvcHBlZGApO1xuICAgICAgICAgIHB1c2goeyB0eXBlOiBcImludGVycnVwdFwiIH0pO1xuICAgICAgICB9IGVsc2UgaWYgKGNvbW1hbmQgPT09IFwiY2FuY2VsQWxsXCIgJiYgZS5yZXN1bHRzW2ldLmlzRmluYWwpIHtcbiAgICAgICAgICBsb2coXCJvdXRcIiwgYGxvY2FsIGNhbmNlbC1hbGw6ICR7dGV4dH1gLCBcIm91dFwiKTtcbiAgICAgICAgICBwdXNoKHsgdHlwZTogXCJjYW5jZWxBbGxcIiB9KTtcbiAgICAgICAgICBwdXNoKHsgdHlwZTogXCJpbnRlcnJ1cHRcIiB9KTtcbiAgICAgICAgfSBlbHNlIGlmIChjb21tYW5kID09PSBcImhhbmdVcFwiICYmIGUucmVzdWx0c1tpXS5pc0ZpbmFsKSB7XG4gICAgICAgICAgbG9nKFwib3V0XCIsIGBsb2NhbCBoYW5nLXVwOiAke3RleHR9YCwgXCJvdXRcIik7XG4gICAgICAgICAgaGFuZ1VwKCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9O1xuICAgIHRoaXMucmVjLm9uZW5kID0gKCkgPT4geyBpZiAodGhpcy5vbikgc2V0VGltZW91dCgoKSA9PiB7IHRyeSB7IHRoaXMucmVjPy5zdGFydCgpOyB9IGNhdGNoIHt9IH0sIDI1MCk7IH07XG4gICAgdGhpcy5yZWMub25lcnJvciA9IChlOiBhbnkpID0+IHsgaWYgKGUuZXJyb3IgPT09IFwibm90LWFsbG93ZWRcIikgdGhpcy5vbiA9IGZhbHNlOyB9O1xuICAgIHRoaXMub24gPSB0cnVlO1xuICAgIHRyeSB7IHRoaXMucmVjLnN0YXJ0KCk7IH0gY2F0Y2gge31cbiAgfVxuXG4gIHN0b3AoKSB7XG4gICAgdGhpcy5vbiA9IGZhbHNlO1xuICAgIHRyeSB7IHRoaXMucmVjPy5zdG9wKCk7IH0gY2F0Y2gge31cbiAgICB0aGlzLnJlYyA9IG51bGw7XG4gIH1cbn1cbmNvbnN0IHN0b3BXb3JkcyA9IG5ldyBTdG9wV29yZHMoKTtcblxuLy8gV2lyaW5nLlxuXG5mdW5jdGlvbiBzZXR0aW5nc0Zyb21TdG9yYWdlKCkge1xuICBmb3IgKGNvbnN0IGlkIG9mIFtcImFlY1wiLCBcInN0b3B3b3JkXCIsIFwicHR0XCIsIFwiY2FwdGlvbnNcIiwgXCJjb2RpbmdcIiwgXCJmYWtlaGVybWVzXCIsIFwidHJhY2VcIl0pIHtcbiAgICBjb25zdCB2ID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oYHZvaWNlLiR7aWR9YCk7XG4gICAgaWYgKHYgIT0gbnVsbCkgJDxIVE1MSW5wdXRFbGVtZW50PihpZCkuY2hlY2tlZCA9IHYgPT09IFwiMVwiO1xuICAgICQoaWQpLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4gbG9jYWxTdG9yYWdlLnNldEl0ZW0oYHZvaWNlLiR7aWR9YCwgY2hlY2tlZChpZCkgPyBcIjFcIiA6IFwiMFwiKSk7XG4gIH1cbiAgY29uc3QgZGVsYXkgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLmZha2VkZWxheVwiKTtcbiAgaWYgKGRlbGF5KSAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwiZmFrZWRlbGF5XCIpLnZhbHVlID0gZGVsYXk7XG4gICQoXCJmYWtlZGVsYXlcIikuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLmZha2VkZWxheVwiLCAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwiZmFrZWRlbGF5XCIpLnZhbHVlKSk7XG4gIGNvbnN0IHZvaWNlID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS52b2ljZVwiKTtcbiAgaWYgKHZvaWNlKSAkPEhUTUxTZWxlY3RFbGVtZW50PihcInZvaWNlXCIpLnZhbHVlID0gdm9pY2U7XG4gICQoXCJ2b2ljZVwiKS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2Uudm9pY2VcIiwgJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJ2b2ljZVwiKS52YWx1ZSkpO1xuICBjb25zdCBtb2RlID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS5tb2RlXCIpO1xuICBpZiAobW9kZSkgJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJtb2RlXCIpLnZhbHVlID0gbW9kZTtcbiAgJChcIm1vZGVcIikuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiB7XG4gICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS5tb2RlXCIsICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwibW9kZVwiKS52YWx1ZSk7XG4gICAgc3luY0NvbXBvc2VyKCk7XG4gIH0pO1xuICBjb25zdCB0aGVtZSA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UudGhlbWVcIikgPz8gXCJzeXN0ZW1cIjtcbiAgYXBwbHlUaGVtZSh0aGVtZSk7XG4gIGZvciAoY29uc3QgYnRuIG9mIEFycmF5LmZyb20oZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MQnV0dG9uRWxlbWVudD4oXCIjdGhlbWUtcGlja2VyIGJ1dHRvblwiKSkpIHtcbiAgICBidG4ub25jbGljayA9ICgpID0+IHtcbiAgICAgIGNvbnN0IGNob2ljZSA9IGJ0bi5kYXRhc2V0LnRoZW1lID8/IFwic3lzdGVtXCI7XG4gICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLnRoZW1lXCIsIGNob2ljZSk7XG4gICAgICBhcHBseVRoZW1lKGNob2ljZSk7XG4gICAgfTtcbiAgfVxuICBjb25zdCBkZW5zaXR5ID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS5kZW5zaXR5XCIpO1xuICBhcHBseURlbnNpdHkoZGVuc2l0eSk7XG4gIGZvciAoY29uc3QgYnRuIG9mIEFycmF5LmZyb20oZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MQnV0dG9uRWxlbWVudD4oXCIjZGVuc2l0eS1waWNrZXIgYnV0dG9uXCIpKSkge1xuICAgIGJ0bi5vbmNsaWNrID0gKCkgPT4ge1xuICAgICAgY29uc3QgY2hvaWNlID0gbm9ybWFsaXplRGVuc2l0eShidG4uZGF0YXNldC5kZW5zaXR5KTtcbiAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2UuZGVuc2l0eVwiLCBjaG9pY2UpO1xuICAgICAgYXBwbHlEZW5zaXR5KGNob2ljZSk7XG4gICAgfTtcbiAgfVxuICBtYXRjaE1lZGlhKFwiKHByZWZlcnMtY29sb3Itc2NoZW1lOiBkYXJrKVwiKS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHtcbiAgICBpZiAoKGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UudGhlbWVcIikgPz8gXCJzeXN0ZW1cIikgPT09IFwic3lzdGVtXCIpIGFwcGx5VGhlbWUoXCJzeXN0ZW1cIik7XG4gIH0pO1xufVxuXG5jb25zdCBtb2JpbGVMYXlvdXQgPSBtYXRjaE1lZGlhKFwiKG1heC13aWR0aDogOTIwcHgpXCIpO1xubGV0IGRyYXdlck9wZW5lcjogSFRNTEVsZW1lbnQgfCBudWxsID0gbnVsbDtcblxuZnVuY3Rpb24gc2V0VGFza3NPcGVuKG9wZW46IGJvb2xlYW4sIG9wZW5lcj86IEhUTUxFbGVtZW50IHwgbnVsbCkge1xuICBjb25zdCBjYW5PcGVuID0gbW9iaWxlTGF5b3V0Lm1hdGNoZXMgJiYgISQoXCJ0YWxrXCIpLmhpZGRlbjtcbiAgY29uc3QgbmV4dCA9IG9wZW4gJiYgY2FuT3BlbjtcbiAgY29uc3Qgd2FzT3BlbiA9IGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LmNvbnRhaW5zKFwidGFza3Mtb3BlblwiKTtcbiAgZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QudG9nZ2xlKFwidGFza3Mtb3BlblwiLCBuZXh0KTtcbiAgY29uc3QgaGVhZGVyID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihcImhlYWRlclwiKSBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gIGlmIChoZWFkZXIpIGhlYWRlci5pbmVydCA9IG5leHQ7XG4gICQoXCJjb252b1wiKS5pbmVydCA9IG5leHQ7XG4gICQoXCJzaWRlXCIpLmluZXJ0ID0gbW9iaWxlTGF5b3V0Lm1hdGNoZXMgJiYgIW5leHQ7XG4gICQoXCJ0YXNrcy10b2dnbGVcIikuc2V0QXR0cmlidXRlKFwiYXJpYS1leHBhbmRlZFwiLCBTdHJpbmcobmV4dCkpO1xuICAkKFwibW9iaWxlLXRhc2tzLWJhclwiKS5zZXRBdHRyaWJ1dGUoXCJhcmlhLWV4cGFuZGVkXCIsIFN0cmluZyhuZXh0KSk7XG4gIGlmIChuZXh0ICYmICF3YXNPcGVuKSB7XG4gICAgdW5yZWFkTW9iaWxlUmVzdWx0cyA9IDA7XG4gICAgdXBkYXRlVGFza0Nocm9tZSgpO1xuICAgIGRyYXdlck9wZW5lciA9IG9wZW5lciA/PyAoZG9jdW1lbnQuYWN0aXZlRWxlbWVudCBhcyBIVE1MRWxlbWVudCB8IG51bGwpO1xuICAgICQoXCJ0YXNrcy1jbG9zZVwiKS5mb2N1cygpO1xuICAgIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB1cGRhdGVBbGxSZXN1bHRDbGFtcGluZygpKTtcbiAgfSBlbHNlIGlmICghbmV4dCAmJiB3YXNPcGVuKSB7XG4gICAgY29uc3QgdGFyZ2V0ID0gZHJhd2VyT3BlbmVyO1xuICAgIGRyYXdlck9wZW5lciA9IG51bGw7XG4gICAgaWYgKHRhcmdldCAmJiB0YXJnZXQuaXNDb25uZWN0ZWQgJiYgIXRhcmdldC5oaWRkZW4gJiYgdGFyZ2V0Lm9mZnNldFBhcmVudCAhPT0gbnVsbCkgdGFyZ2V0LmZvY3VzKCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdGFicygpIHtcbiAgY29uc3Qgdmlld3M6IFJlY29yZDxzdHJpbmcsIEhUTUxFbGVtZW50PiA9IHsgdGFsazogJChcInRhbGtcIiksIGRldjogJChcImRldlwiKSwgcmVwbGF5OiAkKFwicmVwbGF5bWFpblwiKSB9O1xuICBmb3IgKGNvbnN0IG5hbWUgb2YgT2JqZWN0LmtleXModmlld3MpKSB7XG4gICAgJChgdGFiLSR7bmFtZX1gKS5vbmNsaWNrID0gKCkgPT4ge1xuICAgICAgZm9yIChjb25zdCBbb3RoZXIsIGVsXSBvZiBPYmplY3QuZW50cmllcyh2aWV3cykpIHtcbiAgICAgICAgZWwuaGlkZGVuID0gb3RoZXIgIT09IG5hbWU7XG4gICAgICAgICQoYHRhYi0ke290aGVyfWApLmNsYXNzTGlzdC50b2dnbGUoXCJvblwiLCBvdGhlciA9PT0gbmFtZSk7XG4gICAgICB9XG4gICAgICAkKFwidGFza3MtdG9nZ2xlXCIpLmhpZGRlbiA9IG5hbWUgIT09IFwidGFsa1wiO1xuICAgICAgc2V0VGFza3NPcGVuKGZhbHNlKTtcbiAgICAgIGlmIChuYW1lID09PSBcInRhbGtcIikgcmVxdWVzdEFuaW1hdGlvbkZyYW1lKCgpID0+IHVwZGF0ZUFsbFJlc3VsdENsYW1waW5nKCkpO1xuICAgIH07XG4gIH1cbiAgZm9yIChjb25zdCBidG4gb2YgQXJyYXkuZnJvbShkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxCdXR0b25FbGVtZW50PihcIiNzaWRlLXRhYnMgYnV0dG9uXCIpKSkge1xuICAgIGJ0bi5vbmNsaWNrID0gKCkgPT4gc2V0U2lkZUZpbHRlcihub3JtYWxpemVTaWRlRmlsdGVyKGJ0bi5kYXRhc2V0LmZpbHRlcikpO1xuICB9XG4gICQoXCJ0b2dnbGUtYWxsLXJlc3VsdHNcIikub25jbGljayA9ICgpID0+IHtcbiAgICBjb25zdCBjbGFtcGVkID0gWy4uLnJlc3VsdHMudmFsdWVzKCldLmZpbHRlcigocikgPT4gci5jYXJkLmNsYXNzTGlzdC5jb250YWlucyhcImNsYW1wZWRcIikpO1xuICAgIGNvbnN0IG9wZW5BbGwgPSBjbGFtcGVkLnNvbWUoKHIpID0+ICFyLmNhcmQuY2xhc3NMaXN0LmNvbnRhaW5zKFwib3BlblwiKSk7XG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiBjbGFtcGVkKSBzZXRSZXN1bHRPcGVuKGVudHJ5LCBvcGVuQWxsKTtcbiAgfTtcbiAgJChcImdlYXJcIikub25jbGljayA9ICgpID0+IHsgJChcInNldHRpbmdzXCIpLmhpZGRlbiA9IGZhbHNlOyB9O1xuICAkKFwiY2xvc2VzZXR0aW5nc1wiKS5vbmNsaWNrID0gKCkgPT4geyAkKFwic2V0dGluZ3NcIikuaGlkZGVuID0gdHJ1ZTsgfTtcbiAgJChcImNsb3Nlc2V0dGluZ3MteFwiKS5vbmNsaWNrID0gKCkgPT4geyAkKFwic2V0dGluZ3NcIikuaGlkZGVuID0gdHJ1ZTsgfTtcbiAgJChcInNldHRpbmdzXCIpLm9uY2xpY2sgPSAoZSkgPT4geyBpZiAoZS50YXJnZXQgPT09ICQoXCJzZXR0aW5nc1wiKSkgJChcInNldHRpbmdzXCIpLmhpZGRlbiA9IHRydWU7IH07XG4gICQoXCJ0YXNrcy10b2dnbGVcIikub25jbGljayA9ICgpID0+IHNldFRhc2tzT3BlbighZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QuY29udGFpbnMoXCJ0YXNrcy1vcGVuXCIpLCAkKFwidGFza3MtdG9nZ2xlXCIpKTtcbiAgJChcIm1vYmlsZS10YXNrcy1iYXJcIikub25jbGljayA9ICgpID0+IHNldFRhc2tzT3Blbih0cnVlLCAkKFwibW9iaWxlLXRhc2tzLWJhclwiKSk7XG4gICQoXCJ0YXNrcy1jbG9zZVwiKS5vbmNsaWNrID0gKCkgPT4gc2V0VGFza3NPcGVuKGZhbHNlKTtcbiAgJChcInNpZGUtYmFja2Ryb3BcIikub25jbGljayA9ICgpID0+IHNldFRhc2tzT3BlbihmYWxzZSk7XG4gIG1vYmlsZUxheW91dC5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHtcbiAgICBpZiAoIW1vYmlsZUxheW91dC5tYXRjaGVzKSB1bnJlYWRNb2JpbGVSZXN1bHRzID0gMDtcbiAgICBzZXRUYXNrc09wZW4oZmFsc2UpO1xuICAgIHVwZGF0ZVRhc2tDaHJvbWUoKTtcbiAgICByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKCkgPT4gdXBkYXRlQWxsUmVzdWx0Q2xhbXBpbmcoKSk7XG4gIH0pO1xuICBzZXRUYXNrc09wZW4oZmFsc2UpO1xufVxuXG5mdW5jdGlvbiB0eXBpbmcoKTogYm9vbGVhbiB7XG4gIGNvbnN0IGVsID0gZG9jdW1lbnQuYWN0aXZlRWxlbWVudCBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gIHJldHVybiAhIWVsICYmIChlbC50YWdOYW1lID09PSBcIklOUFVUXCIgfHwgZWwudGFnTmFtZSA9PT0gXCJURVhUQVJFQVwiIHx8IGVsLnRhZ05hbWUgPT09IFwiU0VMRUNUXCIgfHwgZWwuaXNDb250ZW50RWRpdGFibGUpO1xufVxuXG5mdW5jdGlvbiBrZXlzKCkge1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCAoZSkgPT4ge1xuICAgIGlmIChlLmtleSA9PT0gXCJFc2NhcGVcIikge1xuICAgICAgaWYgKCEkKFwic2V0dGluZ3NcIikuaGlkZGVuKSB7ICQoXCJzZXR0aW5nc1wiKS5oaWRkZW4gPSB0cnVlOyByZXR1cm47IH1cbiAgICAgIGlmIChkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5jb250YWlucyhcInRhc2tzLW9wZW5cIikgJiYgbW9iaWxlTGF5b3V0Lm1hdGNoZXMgJiYgISQoXCJ0YWxrXCIpLmhpZGRlbikgeyBzZXRUYXNrc09wZW4oZmFsc2UpOyByZXR1cm47IH1cbiAgICAgIGlmIChjYWxsSWQpIHsgcHVzaCh7IHR5cGU6IFwiaW50ZXJydXB0XCIgfSk7IGF1ZGlvLmZsdXNoKCk7IHJldHVybjsgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAodHlwaW5nKCkgfHwgISQoXCJzZXR0aW5nc1wiKS5oaWRkZW4gfHwgZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QuY29udGFpbnMoXCJ0YXNrcy1vcGVuXCIpIHx8IGUubWV0YUtleSB8fCBlLmN0cmxLZXkgfHwgZS5hbHRLZXkpIHJldHVybjtcbiAgICBpZiAoZS5rZXkgPT09IFwibVwiIHx8IGUua2V5ID09PSBcIk1cIikgeyBzZXRNdXRlZCghbXV0ZWQpOyBlLnByZXZlbnREZWZhdWx0KCk7IH1cbiAgICBlbHNlIGlmIChlLmtleSA9PT0gXCIvXCIpIHsgJChcInRleHRcIikuZm9jdXMoKTsgZS5wcmV2ZW50RGVmYXVsdCgpOyB9XG4gICAgZWxzZSBpZiAoZS5jb2RlID09PSBcIlNwYWNlXCIgJiYgY2FsbElkICYmIG11dGVkICYmICFlLnJlcGVhdCkgeyBob2xkaW5nID0gdHJ1ZTsgcHVzaCh7IHR5cGU6IFwidW5tdXRlXCIgfSk7IHNob3dTdGF0dXMoKTsgZS5wcmV2ZW50RGVmYXVsdCgpOyB9XG4gIH0pO1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5dXBcIiwgKGUpID0+IHtcbiAgICBpZiAoZS5jb2RlID09PSBcIlNwYWNlXCIgJiYgaG9sZGluZykgeyBob2xkaW5nID0gZmFsc2U7IHB1c2goeyB0eXBlOiBcIm11dGVcIiB9KTsgc2hvd1N0YXR1cygpOyB9XG4gIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBzdWJtaXRUZXh0KGU6IEV2ZW50KSB7XG4gIGUucHJldmVudERlZmF1bHQoKTtcbiAgY29uc3QgaW5wdXQgPSAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwidGV4dFwiKTtcbiAgbGV0IHRleHQgPSBpbnB1dC52YWx1ZS50cmltKCk7XG4gIGlmICghdGV4dCkgcmV0dXJuO1xuICAvLyBXaXRoIG5vIGNhbGwgb24sIHR5cGluZyBzdGFydHMgYSBjaGF0OiB0aGUgc2FtZSBtYWluIHRocmVhZCwgaW4gdGV4dC5cbiAgaWYgKCFjYWxsSWQpIHtcbiAgICBpbnB1dC52YWx1ZSA9IFwiXCI7XG4gICAgc3luY0NvbXBvc2VyKCk7XG4gICAgdHJ5IHsgYXdhaXQgc3RhcnQoZmFsc2UsIHRydWUpOyB9IGNhdGNoIChlcnIpIHsgdG9hc3QoKGVyciBhcyBFcnJvcikubWVzc2FnZSk7IGxvZyhcImVycm9yXCIsIChlcnIgYXMgRXJyb3IpLm1lc3NhZ2UsIFwiZXJyXCIpOyB9XG4gICAgaWYgKCFjYWxsSWQpIHsgaW5wdXQudmFsdWUgPSB0ZXh0OyBzeW5jQ29tcG9zZXIoKTsgcmV0dXJuOyB9XG4gIH1cbiAgLy8gXCIvdDMgXHUyMDI2XCIgYW5kIFwiL2ggXHUyMDI2XCIgcGljayB0aGUgYWdlbnQgd2hhdGV2ZXIgdGhlIHNlbGVjdG9yIHNheXMuXG4gIGNvbnN0IHBhcnNlZCA9IHBhcnNlUHJlZml4KHRleHQpO1xuICBjb25zdCBtb2RlID0gcGFyc2VkLm1vZGUgPz8gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJtb2RlXCIpLnZhbHVlO1xuICB0ZXh0ID0gcGFyc2VkLnJlc3Q7XG4gIGlmICghdGV4dCkgcmV0dXJuO1xuICBpZiAobW9kZSA9PT0gXCJzYXlcIikgcHVzaCh7IHR5cGU6IFwic2F5XCIsIHRleHQgfSk7XG4gIGVsc2Uge1xuICAgIHB1c2goeyB0eXBlOiBcImFza1wiLCB0ZXh0LCBhZ2VudDogbW9kZSB9KTtcbiAgICBub3RlKGBZb3UgXHUyMTkyIG5ldyAke21vZGUgPT09IFwidDNcIiA/IFwiY29kaW5nXCIgOiBcIkhlcm1lc1wifSB0YXNrOiAke3RleHR9YCk7XG4gIH1cbiAgaW5wdXQudmFsdWUgPSBcIlwiO1xuICBzeW5jQ29tcG9zZXIoKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gbWFpbigpIHtcbiAgYXBwbHlUaGVtZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLnRoZW1lXCIpID8/IFwic3lzdGVtXCIpO1xuICBhcHBseURlbnNpdHkobG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS5kZW5zaXR5XCIpKTtcbiAgc2VydmVyID0gYXdhaXQgKGF3YWl0IGZldGNoKFwiL2NvbmZpZ1wiKSkuanNvbigpO1xuICAkKFwicm91dGVcIikudGV4dENvbnRlbnQgPSBgJHtzZXJ2ZXIucm91dGUgPT09IFwidmVydGV4XCIgPyBcIlZlcnRleFwiIDogXCJHZW1pbmkgQVBJXCJ9IFx1MDBCNyAke3NlcnZlci5tb2RlbC5zcGxpdChcIi9cIikucG9wKCl9YDtcbiAgJChcInZlcnNpb25cIikudGV4dENvbnRlbnQgPSBzZXJ2ZXIudmVyc2lvbjtcbiAgJChcImJ1aWxkXCIpLnRleHRDb250ZW50ID0gYGNvcmUgJHtzZXJ2ZXIudmVyc2lvbn1gO1xuICBzZXR0aW5nc0Zyb21TdG9yYWdlKCk7XG4gIGlmICghc2VydmVyLmhlcm1lcykgeyAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwiZmFrZWhlcm1lc1wiKS5jaGVja2VkID0gdHJ1ZTsgJDxIVE1MSW5wdXRFbGVtZW50PihcImZha2VoZXJtZXNcIikuZGlzYWJsZWQgPSB0cnVlOyB9XG4gIGlmICghc2VydmVyLnQzKSAkKFwiY29kaW5naGVscFwiKS50ZXh0Q29udGVudCA9IFwiVDMgaXNuJ3QgYXZhaWxhYmxlIG9uIHRoZSBzZXJ2ZXI6IG9ubHkgd2l0aCBmYWtlIGFuc3dlcnMuXCI7XG4gIGVsc2UgJChcImNvZGluZ2hlbHBcIikudGV4dENvbnRlbnQgPSBgQ29kZSBjaGFuZ2VzIGdvIHRvIGEgVDMgQ29kZSB0aHJlYWQgaW4gb25lIG9mOiAke3NlcnZlci50My5qb2luKFwiLCBcIil9LmA7XG4gIGlmICghc3RvcFdvcmRzLnN1cHBvcnRlZCkgeyAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwic3RvcHdvcmRcIikuY2hlY2tlZCA9IGZhbHNlOyAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwic3RvcHdvcmRcIikuZGlzYWJsZWQgPSB0cnVlOyB9XG4gIGNvbnN0IHByZXNldCA9ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwicHJlc2V0XCIpO1xuICBmb3IgKGNvbnN0IG5hbWUgb2YgT2JqZWN0LmtleXMoUFJFU0VUUykpIHByZXNldC5hZGQobmV3IE9wdGlvbihuYW1lLCBuYW1lKSk7XG4gIHByZXNldC52YWx1ZSA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UtY29yZS5wcmVzZXRcIikgPz8gXCJ3ZWJcIjtcbiAgaWYgKCFQUkVTRVRTW3ByZXNldC52YWx1ZV0pIHByZXNldC52YWx1ZSA9IFwid2ViXCI7XG4gICQ8SFRNTFRleHRBcmVhRWxlbWVudD4oXCJjb25maWdcIikudmFsdWUgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLWNvcmUuY29uZmlnXCIpID8/IEpTT04uc3RyaW5naWZ5KFBSRVNFVFNbcHJlc2V0LnZhbHVlXSwgbnVsbCwgMik7XG4gIHByZXNldC5vbmNoYW5nZSA9ICgpID0+IHtcbiAgICAkPEhUTUxUZXh0QXJlYUVsZW1lbnQ+KFwiY29uZmlnXCIpLnZhbHVlID0gSlNPTi5zdHJpbmdpZnkoUFJFU0VUU1twcmVzZXQudmFsdWVdLCBudWxsLCAyKTtcbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLWNvcmUucHJlc2V0XCIsIHByZXNldC52YWx1ZSk7XG4gICAgbG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oXCJ2b2ljZS1jb3JlLmNvbmZpZ1wiKTtcbiAgfTtcbiAgJChcImNvbmZpZ1wiKS5vbmlucHV0ID0gKCkgPT4gbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS1jb3JlLmNvbmZpZ1wiLCAkPEhUTUxUZXh0QXJlYUVsZW1lbnQ+KFwiY29uZmlnXCIpLnZhbHVlKTtcbiAgJChcImRlZmF1bHRzXCIpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYyA9IGNvcmUgPz8gKGF3YWl0IGxvYWRDb3JlKCkpO1xuICAgICQoXCJkZWZhdWx0c3ZpZXdcIikudGV4dENvbnRlbnQgPSBKU09OLnN0cmluZ2lmeShKU09OLnBhcnNlKGMuZGVmYXVsdHMoKSksIG51bGwsIDIpO1xuICAgICQoXCJkZWZhdWx0c3ZpZXdcIikuaGlkZGVuID0gISQoXCJkZWZhdWx0c3ZpZXdcIikuaGlkZGVuO1xuICB9O1xuICBjb25zdCBvbkNhbGxDbGljayA9ICgpID0+IHZvaWQgY2FsbEJ1dHRvbigpLmNhdGNoKChlcnIpID0+IHsgdG9hc3QoZXJyLm1lc3NhZ2UpOyBsb2coXCJlcnJvclwiLCBlcnIubWVzc2FnZSwgXCJlcnJcIik7IH0pO1xuICBjb25zdCBvbkhlcm9DYWxsQ2xpY2sgPSAoKSA9PiB7IGlmICghY2FsbElkKSB2b2lkIHN0YXJ0KCkuY2F0Y2goKGVycikgPT4geyB0b2FzdChlcnIubWVzc2FnZSk7IGxvZyhcImVycm9yXCIsIGVyci5tZXNzYWdlLCBcImVyclwiKTsgfSk7IH07XG4gIGNvbnN0IG9uUmVzdW1lQ2xpY2sgPSAoKSA9PiB2b2lkIHN0YXJ0KHRydWUpLmNhdGNoKChlcnIpID0+IHsgdG9hc3QoZXJyLm1lc3NhZ2UpOyBsb2coXCJlcnJvclwiLCBlcnIubWVzc2FnZSwgXCJlcnJcIik7IH0pO1xuICAkKFwiY2FsbFwiKS5vbmNsaWNrID0gb25DYWxsQ2xpY2s7XG4gICQoXCJoZXJvLWNhbGxcIikub25jbGljayA9IG9uSGVyb0NhbGxDbGljaztcbiAgJChcInJlc3VtZVwiKS5vbmNsaWNrID0gb25SZXN1bWVDbGljaztcbiAgJChcImhlcm8tcmVzdW1lXCIpLm9uY2xpY2sgPSBvblJlc3VtZUNsaWNrO1xuICBpZiAoc2F2ZWRIaXN0b3J5KCkubGVuZ3RoID4gMCkge1xuICAgIHN5bmNSZXN1bWVCdXR0b25zKHRydWUpO1xuICAgICQoXCJyZXN1bWVcIikudGl0bGUgPSBcIkNhbGwgYWdhaW4sIGNhcnJ5aW5nIG9uIGZyb20gdGhlIGxhc3QgY29udmVyc2F0aW9uXCI7XG4gIH1cbiAgJChcIm1pY1wiKS5vbmNsaWNrID0gKCkgPT4gc2V0TXV0ZWQoIW11dGVkKTtcbiAgJChcImh1c2hcIikub25jbGljayA9ICgpID0+IHsgcHVzaCh7IHR5cGU6IFwiaW50ZXJydXB0XCIgfSk7IGF1ZGlvLmZsdXNoKCk7IH07XG4gICQoXCJjYW5jZWxhbGxcIikub25jbGljayA9ICgpID0+IHB1c2goeyB0eXBlOiBcImNhbmNlbEFsbFwiIH0pO1xuICAkKFwiZG9uZWJveFwiKS5hZGRFdmVudExpc3RlbmVyKFwidG9nZ2xlXCIsICgpID0+IHsgaWYgKCQ8SFRNTERldGFpbHNFbGVtZW50PihcImRvbmVib3hcIikub3BlbikgJChcImRvbmVib3hcIikuc2Nyb2xsSW50b1ZpZXcoeyBibG9jazogXCJuZWFyZXN0XCIgfSk7IH0pO1xuICAkKFwic2F5XCIpLm9uc3VibWl0ID0gKGUpID0+IHZvaWQgc3VibWl0VGV4dChlKTtcbiAgJChcInRleHRcIikuYWRkRXZlbnRMaXN0ZW5lcihcImlucHV0XCIsIHN5bmNDb21wb3Nlcik7XG4gICQoXCJ0cmFuc2NyaXB0XCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJzY3JvbGxcIiwgdXBkYXRlSnVtcEJ1dHRvbiwgeyBwYXNzaXZlOiB0cnVlIH0pO1xuICAkKFwianVtcGJvdHRvbVwiKS5vbmNsaWNrID0gKCkgPT4gJChcInRyYW5zY3JpcHRcIikuc2Nyb2xsVG8oeyB0b3A6ICQoXCJ0cmFuc2NyaXB0XCIpLnNjcm9sbEhlaWdodCwgYmVoYXZpb3I6IFwic21vb3RoXCIgfSk7XG4gIGlmICh0eXBlb2YgUmVzaXplT2JzZXJ2ZXIgIT09IFwidW5kZWZpbmVkXCIpIHtcbiAgICBuZXcgUmVzaXplT2JzZXJ2ZXIoKCkgPT4gdXBkYXRlQWxsUmVzdWx0Q2xhbXBpbmcoKSkub2JzZXJ2ZSgkKFwicmVzdWx0c1wiKSk7XG4gIH1cbiAgc3luY0NvbXBvc2VyKCk7XG4gIHN5bmNTaWRlTGF5b3V0KCk7XG4gIHRhYnMoKTtcbiAga2V5cygpO1xuICBjb25zdCBldmVudHMgPSBuZXcgRXZlbnRTb3VyY2UoXCIvZXZlbnRzXCIpO1xuICBldmVudHMuYWRkRXZlbnRMaXN0ZW5lcihcImNvcmVcIiwgKGUpID0+IHtcbiAgICBjb25zdCB7IHZlcnNpb24gfSA9IEpTT04ucGFyc2UoKGUgYXMgTWVzc2FnZUV2ZW50KS5kYXRhKTtcbiAgICAkKFwidmVyc2lvblwiKS50ZXh0Q29udGVudCA9IHZlcnNpb24gKyAoY2FsbElkICYmIGNvcmUgJiYgY29yZS52ZXJzaW9uICE9PSB2ZXJzaW9uID8gYCAobmV4dCBjYWxsOyB0aGlzIG9uZSBydW5zICR7Y29yZS52ZXJzaW9ufSlgIDogXCJcIik7XG4gICAgJChcImJ1aWxkXCIpLnRleHRDb250ZW50ID0gYGNvcmUgJHt2ZXJzaW9ufWA7XG4gIH0pO1xuICBldmVudHMuYWRkRXZlbnRMaXN0ZW5lcihcImFwcFwiLCAoKSA9PiB7IGlmICghY2FsbElkKSBsb2NhdGlvbi5yZWxvYWQoKTsgZWxzZSB0b2FzdChcIlRoZSBwYWdlIGNoYW5nZWQ6IHJlbG9hZCBhZnRlciB0aGlzIGNhbGxcIik7IH0pO1xuICBldmVudHMuYWRkRXZlbnRMaXN0ZW5lcihcImVycm9yXCIsIChlKSA9PiB7XG4gICAgY29uc3QgZGF0YSA9IChlIGFzIE1lc3NhZ2VFdmVudCkuZGF0YTtcbiAgICBpZiAoZGF0YSkgdG9hc3QoYEJ1aWxkIGZhaWxlZDogJHtKU09OLnBhcnNlKGRhdGEpLm1lc3NhZ2V9YCk7XG4gIH0pO1xuICBuZXcgUmVwbGF5KCQoXCJyZXBsYXlcIiksIGxvYWRDb3JlKTtcbiAgdm9pZCBwaW5nKCk7XG4gIHZvaWQgc2hvd0VhcmxpZXIoKTtcbiAgd2luZG93LnNldEludGVydmFsKCgpID0+IHZvaWQgc2hvd0VhcmxpZXIoKSwgMzBfMDAwKTtcbn1cblxudm9pZCBtYWluKCk7XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBU0EsSUFBTSxTQUFTLG9CQUFJLElBQUk7QUFBQSxFQUNyQjtBQUFBLEVBQU87QUFBQSxFQUFNO0FBQUEsRUFBUTtBQUFBLEVBQVU7QUFBQSxFQUFPO0FBQUEsRUFBUTtBQUFBLEVBQU07QUFBQSxFQUFNO0FBQUEsRUFBTTtBQUFBLEVBQU07QUFBQSxFQUFXO0FBQUEsRUFBUztBQUFBLEVBQVE7QUFBQSxFQUFPO0FBQUEsRUFBVTtB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QUNMLFFBQU0sU0FBUyxJQUFJLFlBQVksU0FBUztBQUN4QyxTQUFPLGlCQUFpQixRQUFRLENBQUMsTUFBTTtBQUNyQyxVQUFNLEVBQUUsUUFBUSxJQUFJLEtBQUssTUFBTyxFQUFtQixJQUFJO0FBQ3ZELE1BQUUsU0FBUyxFQUFFLGNBQWMsV0FBVyxVQUFVLFFBQVEsS0FBSyxZQUFZLFVBQVUsOEJBQThCLEtBQUssT0FBTyxNQUFNO0FBQ25JLE1BQUUsT0FBTyxFQUFFLGNBQWMsUUFBUSxPQUFPO0FBQUEsRUFDMUMsQ0FBQztBQUNELFNBQU8saUJBQWlCLE9BQU8sTUFBTTtBQUFFLFFBQUksQ0FBQyxPQUFRLFVBQVMsT0FBTztBQUFBLFFBQVEsT0FBTSwwQ0FBMEM7QUFBQSxFQUFHLENBQUM7QUFDaEksU0FBTyxpQkFBaUIsU0FBUyxDQUFDLE1BQU07QUFDdEMsVUFBTSxPQUFRLEVBQW1CO0FBQ2pDLFFBQUksS0FBTSxPQUFNLGlCQUFpQixLQUFLLE1BQU0sSUFBSSxFQUFFLE9BQU8sRUFBRTtBQUFBLEVBQzdELENBQUM7QUFDRCxNQUFJLE9BQU8sRUFBRSxRQUFRLEdBQUcsUUFBUTtBQUNoQyxPQUFLLEtBQUs7QUFDVixPQUFLLFlBQVk7QUFDakIsU0FBTyxZQUFZLE1BQU0sS0FBSyxZQUFZLEdBQUcsR0FBTTtBQUNyRDtBQUVBLEtBQUssS0FBSzsiLAogICJuYW1lcyI6IFsiY29yZSIsICJjb3JlIiwgIm5vdyIsICJjb3VudHMiLCAibGl2ZSIsICJsaW5lIiwgInJ1biJdCn0K
