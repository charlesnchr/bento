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
      };
      row.append(more);
    }
  });
  scrollDown(true);
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
      view.result.scrollIntoView({ behavior: "smooth", block: "center" });
      view.result.classList.add("open");
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL2NvbW1hbmRzLnRzIiwgIi4uL2F1ZGlvLnRzIiwgIi4uL3JlcGxheS50cyIsICIuLi9hcHAudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFNwb2tlbiBjb21tYW5kcyB0aGUgY29yZSBhY3RzIG9uIHdpdGhvdXQgdGhlIG1vZGVsOiBcInN0b3BcIiBhbmQgXCJoYW5nIHVwXCIuIEFuIHV0dGVyYW5jZSBjb3VudHNcbi8vIG9ubHkgd2hlbiBpdCBpcyBvbmUgb2YgdGhlIHBocmFzZXMgYW5kIG5vdGhpbmcgbW9yZSwgb25jZSBuYW1lcyBhbmQgZmlsbGVycyBhcm91bmQgaXQgYXJlIGdvbmUsXG4vLyBzbyBcIldvb2Rob3VzZSwgc3RvcCBwbGVhc2VcIiBzdG9wcyBhbmQgXCJzdG9wIHRoZSBQZW5ueXdvcnRoIHRhc2tcIiBnb2VzIHRvIHRoZSBtb2RlbCBhcyB1c3VhbC5cblxuaW1wb3J0IHR5cGUgeyBWb2ljZUNvbW1hbmRzIH0gZnJvbSBcIi4vdHlwZXMudHNcIjtcblxuZXhwb3J0IHR5cGUgVm9pY2VDb21tYW5kID0gXCJzdG9wXCIgfCBcImhhbmdVcFwiIHwgXCJjYW5jZWxBbGxcIjtcblxuLyoqIFdvcmRzIHRoYXQgbWF5IGNvbWUgYmVmb3JlIG9yIGFmdGVyIGEgY29tbWFuZCB3aXRob3V0IGNoYW5naW5nIGl0LiAqL1xuY29uc3QgRklMTEVSID0gbmV3IFNldChbXG4gIFwiaGV5XCIsIFwib2tcIiwgXCJva2F5XCIsIFwicGxlYXNlXCIsIFwibm93XCIsIFwianVzdFwiLCBcInNvXCIsIFwidW1cIiwgXCJ1aFwiLCBcIm9oXCIsIFwiYWxyaWdodFwiLCBcInJpZ2h0XCIsIFwieWVhaFwiLCBcInllc1wiLCBcInRoYW5rc1wiLCBcInRoYW5rXCIsIFwieW91XCIsXG4gIFwiZ2VtaW5pXCIsXG5dKTtcblxuLyoqIFt0ZXh0XSBhcyBsb3dlci1jYXNlIHdvcmRzLCBhcG9zdHJvcGhlcyBkcm9wcGVkIChcIlRoYXQnc1wiIGlzIFwidGhhdHNcIikuICovXG5leHBvcnQgZnVuY3Rpb24gd29yZHModGV4dDogc3RyaW5nKTogc3RyaW5nW10ge1xuICByZXR1cm4gdGV4dC50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL1snXHUyMDE5YF0vZywgXCJcIikucmVwbGFjZSgvW15cXHB7TH1cXHB7TmR9XSsvZ3UsIFwiIFwiKS50cmltKCkuc3BsaXQoXCIgXCIpLmZpbHRlcigodykgPT4gdy5sZW5ndGggPiAwKTtcbn1cblxuLyoqIFRoZSBjb21tYW5kIFt1dHRlcmFuY2VdIGlzLCBpZiBpdCdzIG9uZSBhbmQgbm90aGluZyBtb3JlOyBbbmFtZXNdICh0aGUgYXNzaXN0YW50J3MsIFwiV29vZGhvdXNlXCIpIGRvbid0IGNvdW50LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbW1hbmRJbih1dHRlcmFuY2U6IHN0cmluZywgY29tbWFuZHM6IFZvaWNlQ29tbWFuZHMsIG5hbWVzOiBzdHJpbmdbXSA9IFtdKTogVm9pY2VDb21tYW5kIHwgbnVsbCB7XG4gIGNvbnN0IGlnbm9yZWQgPSBuZXcgU2V0KFsuLi5GSUxMRVIsIC4uLm5hbWVzLmZsYXRNYXAod29yZHMpXSk7XG4gIGNvbnN0IHNhaWQgPSB3b3Jkcyh1dHRlcmFuY2UpO1xuICBsZXQgZnJvbSA9IDA7XG4gIGxldCB0byA9IHNhaWQubGVuZ3RoO1xuICB3aGlsZSAoZnJvbSA8IHRvICYmIGlnbm9yZWQuaGFzKHNhaWRbZnJvbV0pKSBmcm9tKys7XG4gIHdoaWxlICh0byA+IGZyb20gJiYgaWdub3JlZC5oYXMoc2FpZFt0byAtIDFdKSkgdG8tLTtcbiAgaWYgKGZyb20gPT09IHRvIHx8IHRvIC0gZnJvbSA+IDUpIHJldHVybiBudWxsO1xuICBjb25zdCBjb3JlID0gc2FpZC5zbGljZShmcm9tLCB0bykuam9pbihcIiBcIik7XG4gIGNvbnN0IGlzID0gKHBocmFzZXM6IHN0cmluZ1tdKSA9PiBwaHJhc2VzLnNvbWUoKHApID0+IHdvcmRzKHApLmpvaW4oXCIgXCIpID09PSBjb3JlKTtcbiAgaWYgKGlzKGNvbW1hbmRzLmhhbmdVcCkpIHJldHVybiBcImhhbmdVcFwiO1xuICBpZiAoaXMoY29tbWFuZHMuY2FuY2VsQWxsID8/IFtdKSkgcmV0dXJuIFwiY2FuY2VsQWxsXCI7XG4gIGlmIChpcyhjb21tYW5kcy5zdG9wKSkgcmV0dXJuIFwic3RvcFwiO1xuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqIFdvcmRzIHRoYXQgdGFrZSBhIHJlcXVlc3QgYmFjay4gKi9cbmNvbnN0IENBTkNFTFMgPSAvXFxiKD86Y2FuY2VsXFx3KnxhYm9ydFxcdyp8a2lsbHxzY3JhcHxzY3JhdGNofGRyb3B8Zm9yZ2V0fHVuZG98dGVybWluYXRlfG5ldmVyID9taW5kfGNhbGwgKD86aXR8dGhhdHx0aGlzKSBvZmZ8KD86ZG9udHxkbyBub3QpICg/OmJvdGhlcnxuZWVkfHdhbnR8ZG8pfG5vIG5lZWR8bm8gbG9uZ2VyfG5vdCBhbnltb3JlfGxlYXZlIGl0fHNraXAgKD86aXR8dGhhdCkpXFxiLztcbmNvbnN0IFNUT1BTID0gL1xcYig/OnN0b3BcXHcqfGhhbHR8cXVpdHxlbmQpXFxiLztcblxuLyoqXG4gKiBXaGV0aGVyIFt1dHRlcmFuY2VdIGFza3MgZm9yIGEgdGFzayB0byBiZSBjYW5jZWxsZWQsIGZvciBhIGNhbmNlbF90YXNrIHRoZSBtb2RlbCBjYWxsZWQgb24gaXQuIFwiU3RvcFwiIGFsb25lIGFuZCB0aGVcbiAqIG90aGVyIHN0b3AgYW5kIGhhbmctdXAgcGhyYXNlcyBkb24ndDogdGhleSBtZWFuIHN0b3AgdGFsa2luZy4gT3RoZXJ3aXNlIGl0IGRvZXMgd2hlbiBpdCBzYXlzIHNvIGluIHdvcmRzLCB3aGVuIGl0XG4gKiBuYW1lcyB0aGUgdGFzayAoW25hbWVkXSksIG9yIHdoZW4gaXQgc2F5cyB0byBzdG9wIHNvbWV0aGluZyBtb3JlIHRoYW4gdGhlIHRhbGtpbmcgKFwic3RvcCB3b3JraW5nIG9uIHRoYXRcIikuXG4gKiBXb3JkcyB0aGF0IHNheSBub25lIG9mIHRoaXMgKGEgbWlzaGVhcmluZyBzdWNoIGFzIFwiU3RhYml0XCIpIGRvbid0LiBXaXRoIG5vdGhpbmcgaGVhcmQgdGhlcmUgaXMgbm90aGluZyB0byBqdWRnZSBieS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFza3NUb0NhbmNlbCh1dHRlcmFuY2U6IHN0cmluZywgY29tbWFuZHM6IFZvaWNlQ29tbWFuZHMsIG5hbWVzOiBzdHJpbmdbXSwgbmFtZWQ6IGJvb2xlYW4pOiBib29sZWFuIHtcbiAgY29uc3Qgc2FpZCA9IHdvcmRzKHV0dGVyYW5jZSkuam9pbihcIiBcIik7XG4gIGlmIChzYWlkLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHRydWU7XG4gIGNvbnN0IGNvbW1hbmQgPSBjb21tYW5kSW4odXR0ZXJhbmNlLCBjb21tYW5kcywgbmFtZXMpO1xuICBpZiAoY29tbWFuZCA9PT0gXCJzdG9wXCIgfHwgY29tbWFuZCA9PT0gXCJoYW5nVXBcIikgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gY29tbWFuZCA9PT0gXCJjYW5jZWxBbGxcIiB8fCBuYW1lZCB8fCBDQU5DRUxTLnRlc3Qoc2FpZCkgfHwgU1RPUFMudGVzdChzYWlkKTtcbn1cbiIsICIvLyBUaGUgYnJvd3NlcidzIG1pY3JvcGhvbmUgYW5kIHNwZWFrZXIgZm9yIGEgY2FsbDogMTYga0h6IFBDTTE2IGZyYW1lcyBvdXQgb2YgdGhlIG1pY3JvcGhvbmUsXG4vLyAyNCBrSHogUENNMTYgaW50byB0aGUgc3BlYWtlciwgYW5kIHRvbmVzIGxhaWQgb3ZlciB3aGF0ZXZlciBwbGF5cy4gQm90aCBydW4gaW4gQXVkaW9Xb3JrbGV0cyBvblxuLy8gb25lIEF1ZGlvQ29udGV4dCBhdCB0aGUgZGV2aWNlJ3MgcmF0ZSwgcmVzYW1wbGluZyB0aGVyZS5cblxuY29uc3QgV09SS0xFVFMgPSBgXG5jbGFzcyBDYXB0dXJlIGV4dGVuZHMgQXVkaW9Xb3JrbGV0UHJvY2Vzc29yIHtcbiAgY29uc3RydWN0b3IoKSB7XG4gICAgc3VwZXIoKTtcbiAgICB0aGlzLnN0ZXAgPSBzYW1wbGVSYXRlIC8gMTYwMDA7XG4gICAgdGhpcy5wb3MgPSAwO1xuICAgIHRoaXMuZnJhbWUgPSBuZXcgSW50MTZBcnJheSgzMjApO1xuICAgIHRoaXMubiA9IDA7XG4gICAgLy8gQSB3aW5kb3dlZC1zaW5jIGxvdy1wYXNzIGF0IDcga0h6LCBzbyBub3RoaW5nIGFib3ZlIDE2IGtIeidzIDgga0h6IGxpbWl0IGZvbGRzIGJhY2sgaW50byBzcGVlY2guXG4gICAgY29uc3QgdGFwcyA9IDQ3LCBjdXQgPSA3MDAwIC8gc2FtcGxlUmF0ZTtcbiAgICB0aGlzLnRhcHMgPSBuZXcgRmxvYXQzMkFycmF5KHRhcHMpO1xuICAgIGxldCBzdW0gPSAwO1xuICAgIGZvciAobGV0IGsgPSAwOyBrIDwgdGFwczsgaysrKSB7XG4gICAgICBjb25zdCBtID0gayAtICh0YXBzIC0gMSkgLyAyO1xuICAgICAgY29uc3Qgc2luYyA9IG0gPT09IDAgPyAyICogY3V0IDogTWF0aC5zaW4oMiAqIE1hdGguUEkgKiBjdXQgKiBtKSAvIChNYXRoLlBJICogbSk7XG4gICAgICBjb25zdCB3ID0gMC40MiAtIDAuNSAqIE1hdGguY29zKCgyICogTWF0aC5QSSAqIGspIC8gKHRhcHMgLSAxKSkgKyAwLjA4ICogTWF0aC5jb3MoKDQgKiBNYXRoLlBJICogaykgLyAodGFwcyAtIDEpKTtcbiAgICAgIHRoaXMudGFwc1trXSA9IHNpbmMgKiB3O1xuICAgICAgc3VtICs9IHRoaXMudGFwc1trXTtcbiAgICB9XG4gICAgZm9yIChsZXQgayA9IDA7IGsgPCB0YXBzOyBrKyspIHRoaXMudGFwc1trXSAvPSBzdW07XG4gICAgdGhpcy5oaXN0b3J5ID0gbmV3IEZsb2F0MzJBcnJheSh0YXBzKTtcbiAgICB0aGlzLmF0ID0gMDtcbiAgfVxuICBwcm9jZXNzKGlucHV0cykge1xuICAgIGNvbnN0IGlucHV0ID0gaW5wdXRzWzBdICYmIGlucHV0c1swXVswXTtcbiAgICBpZiAoIWlucHV0KSByZXR1cm4gdHJ1ZTtcbiAgICBjb25zdCB0YXBzID0gdGhpcy50YXBzLCBoID0gdGhpcy5oaXN0b3J5LCBuID0gdGFwcy5sZW5ndGg7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBpbnB1dC5sZW5ndGg7IGkrKykge1xuICAgICAgaFt0aGlzLmF0XSA9IGlucHV0W2ldO1xuICAgICAgdGhpcy5hdCA9ICh0aGlzLmF0ICsgMSkgJSBuO1xuICAgICAgLy8gT25seSB0aGUgc2FtcGxlcyBrZXB0IG5lZWQgZmlsdGVyaW5nOiBhdCBtb3N0IG9uZSBpbiBldmVyeSBzdGVwLlxuICAgICAgaWYgKHRoaXMucG9zID4gMSkgeyB0aGlzLnBvcyAtPSAxOyBjb250aW51ZTsgfVxuICAgICAgbGV0IHggPSAwO1xuICAgICAgZm9yIChsZXQgayA9IDAsIGogPSB0aGlzLmF0OyBrIDwgbjsgaysrLCBqID0gaiArIDEgPT09IG4gPyAwIDogaiArIDEpIHggKz0gdGFwc1trXSAqIGhbal07XG4gICAgICB3aGlsZSAodGhpcy5wb3MgPD0gMSkge1xuICAgICAgICBjb25zdCBzID0gTWF0aC5tYXgoLTEsIE1hdGgubWluKDEsIHgpKTtcbiAgICAgICAgdGhpcy5mcmFtZVt0aGlzLm4rK10gPSBzIDwgMCA/IHMgKiAzMjc2OCA6IHMgKiAzMjc2NztcbiAgICAgICAgaWYgKHRoaXMubiA9PT0gdGhpcy5mcmFtZS5sZW5ndGgpIHtcbiAgICAgICAgICB0aGlzLnBvcnQucG9zdE1lc3NhZ2UodGhpcy5mcmFtZS5idWZmZXIsIFt0aGlzLmZyYW1lLmJ1ZmZlcl0pO1xuICAgICAgICAgIHRoaXMuZnJhbWUgPSBuZXcgSW50MTZBcnJheSgzMjApO1xuICAgICAgICAgIHRoaXMubiA9IDA7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5wb3MgKz0gdGhpcy5zdGVwO1xuICAgICAgfVxuICAgICAgdGhpcy5wb3MgLT0gMTtcbiAgICB9XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbn1cblxuY2xhc3MgUGxheWJhY2sgZXh0ZW5kcyBBdWRpb1dvcmtsZXRQcm9jZXNzb3Ige1xuICBjb25zdHJ1Y3RvcigpIHtcbiAgICBzdXBlcigpO1xuICAgIHRoaXMucXVldWUgPSBbXTsgICAgICAvLyBGbG9hdDMyQXJyYXlzIGF0IHRoZSBjb250ZXh0J3MgcmF0ZVxuICAgIHRoaXMub2Zmc2V0ID0gMDtcbiAgICB0aGlzLmN1ZXMgPSBbXTtcbiAgICB0aGlzLmN1ZU9mZnNldCA9IDA7XG4gICAgdGhpcy5yZXBvcnRlZCA9IDA7XG4gICAgdGhpcy5wb3J0Lm9ubWVzc2FnZSA9IChlKSA9PiB7XG4gICAgICBjb25zdCBtID0gZS5kYXRhO1xuICAgICAgaWYgKG0udHlwZSA9PT0gXCJwbGF5XCIpIHRoaXMucXVldWUucHVzaChtLnNhbXBsZXMpO1xuICAgICAgZWxzZSBpZiAobS50eXBlID09PSBcImN1ZVwiKSB0aGlzLmN1ZXMucHVzaChtLnNhbXBsZXMpO1xuICAgICAgZWxzZSBpZiAobS50eXBlID09PSBcImZsdXNoXCIpIHsgdGhpcy5xdWV1ZSA9IFtdOyB0aGlzLm9mZnNldCA9IDA7IH1cbiAgICAgIGVsc2UgaWYgKG0udHlwZSA9PT0gXCJzdG9wXCIpIHsgdGhpcy5xdWV1ZSA9IFtdOyB0aGlzLm9mZnNldCA9IDA7IHRoaXMuY3VlcyA9IFtdOyB0aGlzLmN1ZU9mZnNldCA9IDA7IH1cbiAgICB9O1xuICB9XG4gIHByb2Nlc3MoXywgb3V0cHV0cykge1xuICAgIGNvbnN0IG91dCA9IG91dHB1dHNbMF1bMF07XG4gICAgb3V0LmZpbGwoMCk7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoICYmIHRoaXMucXVldWUubGVuZ3RoOyBpKyspIHtcbiAgICAgIG91dFtpXSA9IHRoaXMucXVldWVbMF1bdGhpcy5vZmZzZXQrK107XG4gICAgICBpZiAodGhpcy5vZmZzZXQgPj0gdGhpcy5xdWV1ZVswXS5sZW5ndGgpIHsgdGhpcy5xdWV1ZS5zaGlmdCgpOyB0aGlzLm9mZnNldCA9IDA7IH1cbiAgICB9XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoICYmIHRoaXMuY3Vlcy5sZW5ndGg7IGkrKykge1xuICAgICAgb3V0W2ldID0gTWF0aC5tYXgoLTEsIE1hdGgubWluKDEsIG91dFtpXSArIHRoaXMuY3Vlc1swXVt0aGlzLmN1ZU9mZnNldCsrXSkpO1xuICAgICAgaWYgKHRoaXMuY3VlT2Zmc2V0ID49IHRoaXMuY3Vlc1swXS5sZW5ndGgpIHsgdGhpcy5jdWVzLnNoaWZ0KCk7IHRoaXMuY3VlT2Zmc2V0ID0gMDsgfVxuICAgIH1cbiAgICBmb3IgKGxldCBjID0gMTsgYyA8IG91dHB1dHNbMF0ubGVuZ3RoOyBjKyspIG91dHB1dHNbMF1bY10uc2V0KG91dCk7XG4gICAgaWYgKGN1cnJlbnRUaW1lIC0gdGhpcy5yZXBvcnRlZCA+IDAuMSkge1xuICAgICAgdGhpcy5yZXBvcnRlZCA9IGN1cnJlbnRUaW1lO1xuICAgICAgbGV0IHF1ZXVlZCA9IC10aGlzLm9mZnNldDtcbiAgICAgIGZvciAoY29uc3QgcSBvZiB0aGlzLnF1ZXVlKSBxdWV1ZWQgKz0gcS5sZW5ndGg7XG4gICAgICB0aGlzLnBvcnQucG9zdE1lc3NhZ2UoeyBxdWV1ZWQ6IHF1ZXVlZCAvIHNhbXBsZVJhdGUgfSk7XG4gICAgfVxuICAgIHJldHVybiB0cnVlO1xuICB9XG59XG5yZWdpc3RlclByb2Nlc3NvcihcImNhcHR1cmVcIiwgQ2FwdHVyZSk7XG5yZWdpc3RlclByb2Nlc3NvcihcInBsYXliYWNrXCIsIFBsYXliYWNrKTtcbmA7XG5cbmZ1bmN0aW9uIGJhc2U2NFRvQnl0ZXMoYjY0OiBzdHJpbmcpOiBVaW50OEFycmF5IHtcbiAgY29uc3QgYmluID0gYXRvYihiNjQpO1xuICBjb25zdCBvdXQgPSBuZXcgVWludDhBcnJheShiaW4ubGVuZ3RoKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBiaW4ubGVuZ3RoOyBpKyspIG91dFtpXSA9IGJpbi5jaGFyQ29kZUF0KGkpO1xuICByZXR1cm4gb3V0O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYnl0ZXNUb0Jhc2U2NChieXRlczogVWludDhBcnJheSk6IHN0cmluZyB7XG4gIGxldCBiaW4gPSBcIlwiO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGJ5dGVzLmxlbmd0aDsgaSArPSAweDgwMDApIGJpbiArPSBTdHJpbmcuZnJvbUNoYXJDb2RlKC4uLmJ5dGVzLnN1YmFycmF5KGksIGkgKyAweDgwMDApKTtcbiAgcmV0dXJuIGJ0b2EoYmluKTtcbn1cblxuLyoqIFBDTTE2IGxpdHRsZS1lbmRpYW4gYXQgW3JhdGVdLCBhcyBmbG9hdHMgYXQgdGhlIGNvbnRleHQncyByYXRlLiAqL1xuZnVuY3Rpb24gdG9GbG9hdHMocGNtOiBVaW50OEFycmF5LCByYXRlOiBudW1iZXIsIHRhcmdldDogbnVtYmVyKTogRmxvYXQzMkFycmF5IHtcbiAgY29uc3QgdmlldyA9IG5ldyBEYXRhVmlldyhwY20uYnVmZmVyLCBwY20uYnl0ZU9mZnNldCwgcGNtLmJ5dGVMZW5ndGgpO1xuICBjb25zdCBuID0gTWF0aC5mbG9vcihwY20uYnl0ZUxlbmd0aCAvIDIpO1xuICBjb25zdCBvdXQgPSBuZXcgRmxvYXQzMkFycmF5KE1hdGguZmxvb3IoKG4gKiB0YXJnZXQpIC8gcmF0ZSkpO1xuICBjb25zdCBzdGVwID0gcmF0ZSAvIHRhcmdldDtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCB4ID0gaSAqIHN0ZXA7XG4gICAgY29uc3QgaiA9IE1hdGguZmxvb3IoeCk7XG4gICAgY29uc3QgYSA9IHZpZXcuZ2V0SW50MTYoMiAqIE1hdGgubWluKGosIG4gLSAxKSwgdHJ1ZSk7XG4gICAgY29uc3QgYiA9IHZpZXcuZ2V0SW50MTYoMiAqIE1hdGgubWluKGogKyAxLCBuIC0gMSksIHRydWUpO1xuICAgIG91dFtpXSA9IChhICsgKGIgLSBhKSAqICh4IC0gaikpIC8gMzI3Njg7XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBNaWNPcHRpb25zIHsgZWNob0NhbmNlbGxhdGlvbjogYm9vbGVhbjsgbm9pc2VTdXBwcmVzc2lvbjogYm9vbGVhbjsgYXV0b0dhaW5Db250cm9sOiBib29sZWFuIH1cblxuZXhwb3J0IGNsYXNzIENhbGxBdWRpbyB7XG4gIHByaXZhdGUgY29udGV4dDogQXVkaW9Db250ZXh0IHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgcGxheWJhY2s6IEF1ZGlvV29ya2xldE5vZGUgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBjYXB0dXJlOiBBdWRpb1dvcmtsZXROb2RlIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgc3RyZWFtOiBNZWRpYVN0cmVhbSB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIHNvdXJjZTogTWVkaWFTdHJlYW1BdWRpb1NvdXJjZU5vZGUgfCBudWxsID0gbnVsbDtcbiAgLyoqIFNlY29uZHMgb2Ygc3BlZWNoIHF1ZXVlZCwgYXMgdGhlIHdvcmtsZXQgbGFzdCBzYWlkLiAqL1xuICBxdWV1ZWQgPSAwO1xuICAvKiogVGhlIG1pY3JvcGhvbmUncyBsZXZlbCwgUk1TIG9mIHRoZSBsYXN0IGZyYW1lICgwIHRvIDEpLiAqL1xuICBsZXZlbCA9IDA7XG5cbiAgYXN5bmMgb3BlbigpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAodGhpcy5jb250ZXh0KSB7IGlmICh0aGlzLmNvbnRleHQuc3RhdGUgPT09IFwic3VzcGVuZGVkXCIpIGF3YWl0IHRoaXMuY29udGV4dC5yZXN1bWUoKTsgcmV0dXJuOyB9XG4gICAgdGhpcy5jb250ZXh0ID0gbmV3IEF1ZGlvQ29udGV4dCh7IGxhdGVuY3lIaW50OiBcImludGVyYWN0aXZlXCIgfSk7XG4gICAgY29uc3QgdXJsID0gVVJMLmNyZWF0ZU9iamVjdFVSTChuZXcgQmxvYihbV09SS0xFVFNdLCB7IHR5cGU6IFwidGV4dC9qYXZhc2NyaXB0XCIgfSkpO1xuICAgIGF3YWl0IHRoaXMuY29udGV4dC5hdWRpb1dvcmtsZXQuYWRkTW9kdWxlKHVybCk7XG4gICAgdGhpcy5wbGF5YmFjayA9IG5ldyBBdWRpb1dvcmtsZXROb2RlKHRoaXMuY29udGV4dCwgXCJwbGF5YmFja1wiLCB7IG51bWJlck9mSW5wdXRzOiAwLCBvdXRwdXRDaGFubmVsQ291bnQ6IFsyXSB9KTtcbiAgICB0aGlzLnBsYXliYWNrLnBvcnQub25tZXNzYWdlID0gKGUpID0+IHsgdGhpcy5xdWV1ZWQgPSBlLmRhdGEucXVldWVkOyB9O1xuICAgIHRoaXMucGxheWJhY2suY29ubmVjdCh0aGlzLmNvbnRleHQuZGVzdGluYXRpb24pO1xuICB9XG5cbiAgLyoqIFNlY29uZHMgZnJvbSBhIHNhbXBsZSBsZWF2aW5nIHRoZSB3b3JrbGV0IHRvIHRoZSBzcGVha2VyLCBhcyB0aGUgYnJvd3NlciByZWNrb25zIGl0LiAqL1xuICBnZXQgb3V0cHV0TGF0ZW5jeSgpOiBudW1iZXIgfCBudWxsIHtcbiAgICBpZiAoIXRoaXMuY29udGV4dCkgcmV0dXJuIG51bGw7XG4gICAgcmV0dXJuIHRoaXMuY29udGV4dC5iYXNlTGF0ZW5jeSArICgodGhpcy5jb250ZXh0IGFzIEF1ZGlvQ29udGV4dCAmIHsgb3V0cHV0TGF0ZW5jeT86IG51bWJlciB9KS5vdXRwdXRMYXRlbmN5ID8/IDApO1xuICB9XG5cbiAgYXN5bmMgc3RhcnRNaWMob25GcmFtZTogKHBjbTY0OiBzdHJpbmcsIGxldmVsOiBudW1iZXIpID0+IHZvaWQsIG9wdGlvbnM6IE1pY09wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBhd2FpdCB0aGlzLm9wZW4oKTtcbiAgICB0aGlzLnN0b3BNaWMoKTtcbiAgICBjb25zdCBjb250ZXh0ID0gdGhpcy5jb250ZXh0ITtcbiAgICB0aGlzLnN0cmVhbSA9IGF3YWl0IG5hdmlnYXRvci5tZWRpYURldmljZXMuZ2V0VXNlck1lZGlhKHsgYXVkaW86IHsgY2hhbm5lbENvdW50OiAxLCAuLi5vcHRpb25zIH0gfSk7XG4gICAgdGhpcy5zb3VyY2UgPSBjb250ZXh0LmNyZWF0ZU1lZGlhU3RyZWFtU291cmNlKHRoaXMuc3RyZWFtKTtcbiAgICB0aGlzLmNhcHR1cmUgPSBuZXcgQXVkaW9Xb3JrbGV0Tm9kZShjb250ZXh0LCBcImNhcHR1cmVcIiwgeyBudW1iZXJPZk91dHB1dHM6IDAgfSk7XG4gICAgdGhpcy5jYXB0dXJlLnBvcnQub25tZXNzYWdlID0gKGUpID0+IHtcbiAgICAgIGNvbnN0IGZyYW1lID0gbmV3IEludDE2QXJyYXkoZS5kYXRhIGFzIEFycmF5QnVmZmVyKTtcbiAgICAgIGxldCBzdW0gPSAwO1xuICAgICAgZm9yIChjb25zdCBzIG9mIGZyYW1lKSBzdW0gKz0gcyAqIHM7XG4gICAgICB0aGlzLmxldmVsID0gTWF0aC5zcXJ0KHN1bSAvIGZyYW1lLmxlbmd0aCkgLyAzMjc2ODtcbiAgICAgIG9uRnJhbWUoYnl0ZXNUb0Jhc2U2NChuZXcgVWludDhBcnJheShlLmRhdGEgYXMgQXJyYXlCdWZmZXIpKSwgdGhpcy5sZXZlbCk7XG4gICAgfTtcbiAgICB0aGlzLnNvdXJjZS5jb25uZWN0KHRoaXMuY2FwdHVyZSk7XG4gIH1cblxuICBzdG9wTWljKCk6IHZvaWQge1xuICAgIHRoaXMuc291cmNlPy5kaXNjb25uZWN0KCk7XG4gICAgdGhpcy5jYXB0dXJlPy5wb3J0LmNsb3NlKCk7XG4gICAgdGhpcy5zdHJlYW0/LmdldFRyYWNrcygpLmZvckVhY2goKHQpID0+IHQuc3RvcCgpKTtcbiAgICB0aGlzLnNvdXJjZSA9IG51bGw7XG4gICAgdGhpcy5jYXB0dXJlID0gbnVsbDtcbiAgICB0aGlzLnN0cmVhbSA9IG51bGw7XG4gIH1cblxuICBwbGF5KHBjbTY0OiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuY29udGV4dCB8fCAhdGhpcy5wbGF5YmFjaykgcmV0dXJuO1xuICAgIGNvbnN0IHNhbXBsZXMgPSB0b0Zsb2F0cyhiYXNlNjRUb0J5dGVzKHBjbTY0KSwgMjQwMDAsIHRoaXMuY29udGV4dC5zYW1wbGVSYXRlKTtcbiAgICB0aGlzLnBsYXliYWNrLnBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcInBsYXlcIiwgc2FtcGxlcyB9LCBbc2FtcGxlcy5idWZmZXJdKTtcbiAgfVxuXG4gIGN1ZShwY202NDogc3RyaW5nKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLmNvbnRleHQgfHwgIXRoaXMucGxheWJhY2spIHJldHVybjtcbiAgICBjb25zdCBzYW1wbGVzID0gdG9GbG9hdHMoYmFzZTY0VG9CeXRlcyhwY202NCksIDI0MDAwLCB0aGlzLmNvbnRleHQuc2FtcGxlUmF0ZSk7XG4gICAgdGhpcy5wbGF5YmFjay5wb3J0LnBvc3RNZXNzYWdlKHsgdHlwZTogXCJjdWVcIiwgc2FtcGxlcyB9LCBbc2FtcGxlcy5idWZmZXJdKTtcbiAgfVxuXG4gIGZsdXNoKCk6IHZvaWQge1xuICAgIHRoaXMucGxheWJhY2s/LnBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcImZsdXNoXCIgfSk7XG4gIH1cblxuICBzdG9wKCk6IHZvaWQge1xuICAgIHRoaXMuc3RvcE1pYygpO1xuICAgIHRoaXMucGxheWJhY2s/LnBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcInN0b3BcIiB9KTtcbiAgfVxufVxuIiwgIi8vIFRoZSByZXBsYXkgdmlldzogYSByZWNvcmRlZCBjYWxsIChhIHRyYWNlIGZyb20gYW55IGhvc3QsIG9yIGEgc2NlbmFyaW8pIHJ1biBhZ2FpbiB0aHJvdWdoIHRoZVxuLy8gY29yZSwgYXMgdGhlIGJ1aWxkIHRoYXQgcmVjb3JkZWQgaXQgZGlkIGFuZCBhcyB0aGUgbGF0ZXN0IGRvZXMsIHNpZGUgYnkgc2lkZS4gV2hlcmUgdGhleSBwYXJ0XG4vLyBpcyB3aGVyZSBhIGNoYW5nZSBpbiBzcmMvIGNoYW5nZWQgd2hhdCB0aGUgY2FsbCBkb2VzIHdpdGggdGhlIHNhbWUgd29yZHMgYW5kIHRoZSBzYW1lIG1vZGVsLlxuXG5pbnRlcmZhY2UgQ29yZSB7XG4gIHZlcnNpb246IHN0cmluZztcbiAgY3JlYXRlKGNvbmZpZzogc3RyaW5nLCB0OiBudW1iZXIpOiBzdHJpbmc7XG4gIHB1c2goaWQ6IG51bWJlciwgZXZlbnQ6IHN0cmluZyk6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFJlY29yZGluZyB7IHZlcnNpb24/OiBzdHJpbmc7IGNvbmZpZzogdW5rbm93bjsgc3RhcnQ6IG51bWJlcjsgZXZlbnRzOiBSZWNvcmQ8c3RyaW5nLCBhbnk+W10gfVxuXG4vKiogV2hhdCBhIGNvbW1hbmQgb3IgZXZlbnQgbG9va3MgbGlrZSBpbiBhIHRpbWVsaW5lOiBhdWRpbyBjdXQgb3V0LCBvbmUgbGluZS4gKi9cbmZ1bmN0aW9uIGxpbmUobzogUmVjb3JkPHN0cmluZywgYW55Pik6IHN0cmluZyB7XG4gIGNvbnN0IHRleHQgPSBKU09OLnN0cmluZ2lmeShvKS5yZXBsYWNlKC9cIihkYXRhfHBjbSlcIjpcIltBLVphLXowLTkrLz1dezQwLH1cIi9nLCAnXCIkMVwiOlwiXHUyMDI2XCInKVxuICAgIC5yZXBsYWNlKC9cXFxcXCJkYXRhXFxcXFwiOlxcXFxcIltBLVphLXowLTkrLz1dezQwLH1cXFxcXCIvZywgJ1xcXFxcImRhdGFcXFxcXCI6XFxcXFwiXHUyMDI2XFxcXFwiJyk7XG4gIHJldHVybiB0ZXh0Lmxlbmd0aCA+IDQwMCA/IHRleHQuc2xpY2UoMCwgNDAwKSArIFwiXHUyMDI2XCIgOiB0ZXh0O1xufVxuXG4vKiogQXVkaW8gYW5kIHRpY2tzIHNheSBub3RoaW5nIGEgcmVhZGVyIG5lZWRzOyB0aGUgcmVzdCBkb2VzLiAqL1xuZnVuY3Rpb24gdGVsbGluZyhvOiBSZWNvcmQ8c3RyaW5nLCBhbnk+KTogYm9vbGVhbiB7XG4gIGlmIChvLnR5cGUgPT09IFwibWljXCIgfHwgby50eXBlID09PSBcInRpY2tcIiB8fCBvLnR5cGUgPT09IFwicGxheVwiKSByZXR1cm4gZmFsc2U7XG4gIGlmIChvLnR5cGUgPT09IFwid3Muc2VuZFwiICYmIFN0cmluZyhvLmRhdGEpLnN0YXJ0c1dpdGgoJ3tcInJlYWx0aW1lSW5wdXRcIjp7XCJhdWRpb1wiJykpIHJldHVybiBmYWxzZTtcbiAgaWYgKG8udHlwZSA9PT0gXCJ3cy5tZXNzYWdlXCIgJiYgU3RyaW5nKG8uZGF0YSkuaW5jbHVkZXMoJ1wiaW5saW5lRGF0YVwiJykgJiYgIVN0cmluZyhvLmRhdGEpLmluY2x1ZGVzKCdcInR1cm5Db21wbGV0ZVwiJykpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmZ1bmN0aW9uIHJ1bihjb3JlOiBDb3JlLCByOiBSZWNvcmRpbmcpOiBzdHJpbmdbXVtdIHtcbiAgY29uc3QgY3JlYXRlZCA9IEpTT04ucGFyc2UoY29yZS5jcmVhdGUoSlNPTi5zdHJpbmdpZnkoci5jb25maWcpLCByLnN0YXJ0KSk7XG4gIGNvbnN0IG91dDogc3RyaW5nW11bXSA9IFtjcmVhdGVkLmNvbW1hbmRzLmZpbHRlcih0ZWxsaW5nKS5tYXAobGluZSldO1xuICBmb3IgKGNvbnN0IGUgb2Ygci5ldmVudHMpIG91dC5wdXNoKChKU09OLnBhcnNlKGNvcmUucHVzaChjcmVhdGVkLmlkLCBKU09OLnN0cmluZ2lmeShlKSkpIGFzIFJlY29yZDxzdHJpbmcsIGFueT5bXSkuZmlsdGVyKHRlbGxpbmcpLm1hcChsaW5lKSk7XG4gIHJldHVybiBvdXQ7XG59XG5cbmV4cG9ydCBjbGFzcyBSZXBsYXkge1xuICBwcml2YXRlIHJlYWRvbmx5IHJvb3Q6IEhUTUxFbGVtZW50O1xuICBwcml2YXRlIHJlYWRvbmx5IGxvYWQ6ICh1cmw/OiBzdHJpbmcpID0+IFByb21pc2U8Q29yZT47XG5cbiAgY29uc3RydWN0b3Iocm9vdDogSFRNTEVsZW1lbnQsIGxvYWQ6ICh1cmw/OiBzdHJpbmcpID0+IFByb21pc2U8Q29yZT4pIHtcbiAgICB0aGlzLnJvb3QgPSByb290O1xuICAgIHRoaXMubG9hZCA9IGxvYWQ7XG4gICAgcm9vdC5pbm5lckhUTUwgPSBgXG4gICAgICA8aDI+VHJhY2UgcmVwbGF5PC9oMj5cbiAgICAgIDxkaXYgY2xhc3M9XCJiYXJcIj48c2VsZWN0IGNsYXNzPVwicGlja1wiIGFyaWEtbGFiZWw9XCJSZWNvcmRpbmdcIj48L3NlbGVjdD48YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cInJlZnJlc2hcIiB0aXRsZT1cIlJlZnJlc2ggbGlzdFwiIGFyaWEtbGFiZWw9XCJSZWZyZXNoIGxpc3RcIj5cdTIxQkI8L2J1dHRvbj48YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cImdvXCI+UmVwbGF5PC9idXR0b24+XG4gICAgICA8bGFiZWwgY2xhc3M9XCJ0b2dnbGUtYWxsXCI+PGlucHV0IHR5cGU9XCJjaGVja2JveFwiIGNsYXNzPVwiYWxsXCI+IFNob3cgYXVkaW8gYW5kIHRpY2tzPC9sYWJlbD48c3BhbiBjbGFzcz1cInN1bW1hcnlcIj48L3NwYW4+PC9kaXY+XG4gICAgICA8ZGl2IGNsYXNzPVwidGltZWxpbmVcIj48L2Rpdj5gO1xuICAgIChyb290LnF1ZXJ5U2VsZWN0b3IoXCIucmVmcmVzaFwiKSBhcyBIVE1MRWxlbWVudCkub25jbGljayA9ICgpID0+IHZvaWQgdGhpcy5saXN0KCk7XG4gICAgKHJvb3QucXVlcnlTZWxlY3RvcihcIi5nb1wiKSBhcyBIVE1MRWxlbWVudCkub25jbGljayA9ICgpID0+IHZvaWQgdGhpcy5yZXBsYXkoKS5jYXRjaCgoZXJyKSA9PiB0aGlzLnNheShgUmVwbGF5IGZhaWxlZDogJHtlcnIubWVzc2FnZX1gKSk7XG4gICAgdm9pZCB0aGlzLmxpc3QoKTtcbiAgfVxuXG4gIHByaXZhdGUgc2F5KHRleHQ6IHN0cmluZykge1xuICAgICh0aGlzLnJvb3QucXVlcnlTZWxlY3RvcihcIi5zdW1tYXJ5XCIpIGFzIEhUTUxFbGVtZW50KS50ZXh0Q29udGVudCA9IHRleHQ7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGxpc3QoKSB7XG4gICAgY29uc3QgcGljayA9IHRoaXMucm9vdC5xdWVyeVNlbGVjdG9yKFwiLnBpY2tcIikgYXMgSFRNTFNlbGVjdEVsZW1lbnQ7XG4gICAgcGljay5pbm5lckhUTUwgPSBcIlwiO1xuICAgIGNvbnN0IHRyYWNlczogeyBuYW1lOiBzdHJpbmc7IGJ5dGVzOiBudW1iZXIgfVtdID0gYXdhaXQgKGF3YWl0IGZldGNoKFwiL3RyYWNlc1wiKSkuanNvbigpO1xuICAgIGNvbnN0IHNjZW5hcmlvczogc3RyaW5nW10gPSBhd2FpdCAoYXdhaXQgZmV0Y2goXCIvc2NlbmFyaW9zXCIpKS5qc29uKCk7XG4gICAgY29uc3QgdHJhY2VHcm91cCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJvcHRncm91cFwiKTtcbiAgICB0cmFjZUdyb3VwLmxhYmVsID0gXCJSZWNvcmRlZCBjYWxsc1wiO1xuICAgIGZvciAoY29uc3QgdCBvZiB0cmFjZXMpIHRyYWNlR3JvdXAuYXBwZW5kKG5ldyBPcHRpb24oYCR7dC5uYW1lfSAoJHtNYXRoLnJvdW5kKHQuYnl0ZXMgLyAxMDI0KX0gS0IpYCwgYC90cmFjZXMvJHt0Lm5hbWV9YCkpO1xuICAgIGNvbnN0IHNjZW5hcmlvR3JvdXAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwib3B0Z3JvdXBcIik7XG4gICAgc2NlbmFyaW9Hcm91cC5sYWJlbCA9IFwiU2NlbmFyaW9zXCI7XG4gICAgZm9yIChjb25zdCBzIG9mIHNjZW5hcmlvcykgc2NlbmFyaW9Hcm91cC5hcHBlbmQobmV3IE9wdGlvbihzLCBgL3NjZW5hcmlvcy8ke3N9Lmpzb25gKSk7XG4gICAgcGljay5hcHBlbmQodHJhY2VHcm91cCwgc2NlbmFyaW9Hcm91cCk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHJlY29yZGluZyh1cmw6IHN0cmluZyk6IFByb21pc2U8UmVjb3JkaW5nPiB7XG4gICAgY29uc3QgdGV4dCA9IGF3YWl0IChhd2FpdCBmZXRjaCh1cmwsIHsgY2FjaGU6IFwibm8tc3RvcmVcIiB9KSkudGV4dCgpO1xuICAgIGlmICh1cmwuZW5kc1dpdGgoXCIuanNvblwiKSkgcmV0dXJuIEpTT04ucGFyc2UodGV4dCk7XG4gICAgY29uc3QgW2hlYWRlciwgLi4uZXZlbnRzXSA9IHRleHQudHJpbSgpLnNwbGl0KFwiXFxuXCIpLm1hcCgobCkgPT4gSlNPTi5wYXJzZShsKSk7XG4gICAgcmV0dXJuIHsgLi4uaGVhZGVyLCBldmVudHMgfTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgcmVwbGF5KCkge1xuICAgIGNvbnN0IHVybCA9ICh0aGlzLnJvb3QucXVlcnlTZWxlY3RvcihcIi5waWNrXCIpIGFzIEhUTUxTZWxlY3RFbGVtZW50KS52YWx1ZTtcbiAgICBpZiAoIXVybCkgcmV0dXJuO1xuICAgIGNvbnN0IHIgPSBhd2FpdCB0aGlzLnJlY29yZGluZyh1cmwpO1xuICAgIGNvbnN0IGxhdGVzdCA9IGF3YWl0IHRoaXMubG9hZCgpO1xuICAgIGxldCByZWNvcmRlZDogQ29yZSB8IG51bGwgPSBudWxsO1xuICAgIGlmIChyLnZlcnNpb24gJiYgci52ZXJzaW9uICE9PSBsYXRlc3QudmVyc2lvbikge1xuICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChgL3ZlcnNpb25zLyR7ci52ZXJzaW9ufS5qc2AsIHsgbWV0aG9kOiBcIkhFQURcIiB9KTtcbiAgICAgIGlmIChyZXNwb25zZS5vaykgcmVjb3JkZWQgPSBhd2FpdCB0aGlzLmxvYWQoYC92ZXJzaW9ucy8ke3IudmVyc2lvbn0uanNgKTtcbiAgICB9XG4gICAgY29uc3Qgbm93ID0gcnVuKGxhdGVzdCwgcik7XG4gICAgY29uc3QgdGhlbiA9IHJlY29yZGVkID8gcnVuKHJlY29yZGVkLCByKSA6IG51bGw7XG4gICAgY29uc3QgYWxsID0gKHRoaXMucm9vdC5xdWVyeVNlbGVjdG9yKFwiLmFsbFwiKSBhcyBIVE1MSW5wdXRFbGVtZW50KS5jaGVja2VkO1xuICAgIGNvbnN0IHRpbWVsaW5lID0gdGhpcy5yb290LnF1ZXJ5U2VsZWN0b3IoXCIudGltZWxpbmVcIikgYXMgSFRNTEVsZW1lbnQ7XG4gICAgdGltZWxpbmUuaW5uZXJIVE1MID0gXCJcIjtcbiAgICBsZXQgZmlyc3QgPSAtMTtcbiAgICBsZXQgZGlmZmVyID0gMDtcbiAgICBjb25zdCByb3dzOiBIVE1MRWxlbWVudFtdID0gW107XG4gICAgY29uc3QgYWRkID0gKGNsczogc3RyaW5nLCB0OiBzdHJpbmcsIHRleHQ6IHN0cmluZykgPT4ge1xuICAgICAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgIHJvdy5jbGFzc05hbWUgPSBgcm93ICR7Y2xzfWA7XG4gICAgICByb3cuaW5uZXJIVE1MID0gYDxzcGFuIGNsYXNzPVwidFwiPiR7dH08L3NwYW4+YDtcbiAgICAgIGNvbnN0IGIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgICAgIGIuY2xhc3NOYW1lID0gXCJiXCI7XG4gICAgICBiLnRleHRDb250ZW50ID0gdGV4dDtcbiAgICAgIHJvdy5hcHBlbmQoYik7XG4gICAgICB0aW1lbGluZS5hcHBlbmQocm93KTtcbiAgICAgIHJvd3MucHVzaChyb3cpO1xuICAgICAgcmV0dXJuIHJvdztcbiAgICB9O1xuICAgIGNvbnN0IHQwID0gci5zdGFydDtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8PSByLmV2ZW50cy5sZW5ndGg7IGkrKykge1xuICAgICAgY29uc3QgZSA9IGkgPT09IDAgPyBudWxsIDogci5ldmVudHNbaSAtIDFdO1xuICAgICAgY29uc3Qgbm93T3V0ID0gbm93W2ldO1xuICAgICAgY29uc3QgdGhlbk91dCA9IHRoZW4gPyB0aGVuW2ldIDogbm93T3V0O1xuICAgICAgY29uc3Qgc2FtZSA9IG5vd091dC5sZW5ndGggPT09IHRoZW5PdXQubGVuZ3RoICYmIG5vd091dC5ldmVyeSgoYywgaikgPT4gYyA9PT0gdGhlbk91dFtqXSk7XG4gICAgICBpZiAoIXNhbWUpIHsgZGlmZmVyKys7IGlmIChmaXJzdCA8IDApIGZpcnN0ID0gaTsgfVxuICAgICAgaWYgKCFzYW1lIHx8IGFsbCB8fCAoZSAmJiB0ZWxsaW5nKGUpKSB8fCBub3dPdXQubGVuZ3RoID4gMCkge1xuICAgICAgICBpZiAoZSAmJiAoYWxsIHx8IHRlbGxpbmcoZSkgfHwgIXNhbWUpKSBhZGQoXCJpblwiLCAoZS50IC0gdDApLnRvRml4ZWQoMiksIGxpbmUoZSkpO1xuICAgICAgICBjb25zdCB0ID0gZSA/IChlLnQgLSB0MCkudG9GaXhlZCgyKSA6IFwiMC4wMFwiO1xuICAgICAgICBpZiAoc2FtZSkgZm9yIChjb25zdCBjIG9mIG5vd091dCkgYWRkKFwib3V0XCIsIHQsIGMpO1xuICAgICAgICBlbHNlIHtcbiAgICAgICAgICBmb3IgKGNvbnN0IGMgb2YgdGhlbk91dCkgYWRkKFwib3V0IGdvbmVcIiwgdCwgYFx1MjIxMiAke2N9YCk7XG4gICAgICAgICAgZm9yIChjb25zdCBjIG9mIG5vd091dCkgYWRkKFwib3V0IG5ld1wiLCB0LCBgKyAke2N9YCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgY29uc3QgdmVyc2lvbnMgPSB0aGVuID8gYHJlY29yZGVkIGJ5ICR7ci52ZXJzaW9ufSwgcmVwbGF5ZWQgYnkgaXQgYW5kIGJ5ICR7bGF0ZXN0LnZlcnNpb259YCA6IGByZXBsYXllZCBieSAke2xhdGVzdC52ZXJzaW9ufWAgK1xuICAgICAgKHIudmVyc2lvbiAmJiByLnZlcnNpb24gIT09IGxhdGVzdC52ZXJzaW9uID8gYCAodGhlIHJlY29yZGluZydzIGJ1aWxkICR7ci52ZXJzaW9ufSBpc24ndCBrZXB0IGhlcmUpYCA6IFwiXCIpO1xuICAgIHRoaXMuc2F5KGAke3IuZXZlbnRzLmxlbmd0aH0gZXZlbnRzLCAke3ZlcnNpb25zfS4gYCArICh0aGVuID8gKGRpZmZlciA/IGAke2RpZmZlcn0gZXZlbnRzIGFuc3dlcmVkIGRpZmZlcmVudGx5LCB0aGUgZmlyc3QgYXQgZXZlbnQgJHtmaXJzdH0uYCA6IFwiQm90aCBhbnN3ZXJlZCBldmVyeSBldmVudCB0aGUgc2FtZS5cIikgOiBcIlwiKSk7XG4gICAgaWYgKGZpcnN0ID49IDApIHRpbWVsaW5lLnF1ZXJ5U2VsZWN0b3IoXCIuZ29uZSwgLm5ld1wiKT8uc2Nyb2xsSW50b1ZpZXcoeyBibG9jazogXCJjZW50ZXJcIiB9KTtcbiAgfVxufVxuIiwgIi8vIFRoZSB3ZWIgc3VyZmFjZTogYSBmb3VydGggaG9zdCBmb3IgdGhlIHZvaWNlIGNvcmUsIGFuZCBhIHBob25lLWZyaWVuZGx5IHdheSB0byB1c2UgaXQgZm9yIHdvcmsuXG4vLyBJdCBsb2FkcyB0aGUgZGV2IHNlcnZlcidzIGxhdGVzdCBidWlsZCBhdCBlYWNoIGNhbGwsIHNvIGFuIGVkaXQgaW4gc3JjLyBpcyBsaXZlIG9uIHRoZSBuZXh0XG4vLyBjYWxsLCBhbmQga2VlcHMgZXZlcnkgY2FsbCBhcyBhIHRyYWNlIHRoZSByZXBsYXkgdmlldyAoYW5kIGFueSBvdGhlciBob3N0KSBjYW4gcnVuIGFnYWluLlxuLy9cbi8vIFRoZSBob3N0J3MgcGFydCBpcyBzbWFsbDogdGhlIG1pY3JvcGhvbmUgYW5kIHNwZWFrZXIgKGF1ZGlvLnRzKSwgdGhlIG1vZGVsJ3Mgc29ja2V0IHRocm91Z2ggdGhlXG4vLyBzZXJ2ZXIncyByZWxheSwgSGVybWVzIGFuZCBUMyB0aHJvdWdoIHRoZSBzZXJ2ZXIsIGFuZCB0aGUgc2NyZWVuLiBUaGUgY29yZSBkZWNpZGVzIHRoZSByZXN0LlxuLy9cbi8vIFR5cGluZyB3aXRoIG5vIGNhbGwgb24gc3RhcnRzIGEgY2hhdCBpbnN0ZWFkOiB0aGUgc2FtZSBjb3JlIHdpdGggYG1lZGl1bTogXCJ0ZXh0XCJgLCB3aG9zZSByZXF1ZXN0c1xuLy8gdG8gdGhlIHRleHQgbW9kZWwgZ28gdGhyb3VnaCB0aGUgc2VydmVyJ3MgL2dlbmVyYXRlLiBUYXNrcywgZm9sbG93LXVwcyBhbmQgdGhlaXIgY2FyZHMgd29yayBhc1xuLy8gaW4gYSBjYWxsLiBQcmVzc2luZyBDYWxsIGVuZHMgdGhlIGNoYXQgYW5kIGNhcnJpZXMgaXRzIGNvbnZlcnNhdGlvbiBvbiBieSB2b2ljZS5cblxuaW1wb3J0IHsgY29tbWFuZEluIH0gZnJvbSBcIi4uL3NyYy9jb21tYW5kcy50c1wiO1xuaW1wb3J0IHsgQ2FsbEF1ZGlvIH0gZnJvbSBcIi4vYXVkaW8udHNcIjtcbmltcG9ydCB7IFJlcGxheSB9IGZyb20gXCIuL3JlcGxheS50c1wiO1xuXG5pbnRlcmZhY2UgQ29yZSB7XG4gIHZlcnNpb246IHN0cmluZztcbiAgZGVmYXVsdHMoKTogc3RyaW5nO1xuICBjcmVhdGUoY29uZmlnOiBzdHJpbmcsIHQ6IG51bWJlcik6IHN0cmluZztcbiAgcHVzaChpZDogbnVtYmVyLCBldmVudDogc3RyaW5nKTogc3RyaW5nO1xuICB0cmFjZShpZDogbnVtYmVyKTogc3RyaW5nO1xuICBkaXNwb3NlKGlkOiBudW1iZXIpOiB2b2lkO1xufVxudHlwZSBDb21tYW5kID0gUmVjb3JkPHN0cmluZywgYW55PiAmIHsgdHlwZTogc3RyaW5nIH07XG5pbnRlcmZhY2UgU2VydmVyQ29uZmlnIHsgcm91dGU6IHN0cmluZzsgbW9kZWw6IHN0cmluZzsgY2FwdGlvbnNNb2RlbD86IHN0cmluZzsgdGV4dE1vZGVsPzogc3RyaW5nOyB2ZXJzaW9uOiBzdHJpbmc7IGhlcm1lczogYm9vbGVhbjsgdDM6IHN0cmluZ1tdIHwgbnVsbCB9XG5cbmNvbnN0ICQgPSA8VCBleHRlbmRzIEhUTUxFbGVtZW50ID0gSFRNTEVsZW1lbnQ+KGlkOiBzdHJpbmcpID0+IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGlkKSBhcyBUO1xuY29uc3Qgbm93ID0gKCkgPT4gcGVyZm9ybWFuY2Uubm93KCkgLyAxMDAwO1xuY29uc3QgY2hlY2tlZCA9IChpZDogc3RyaW5nKSA9PiAkPEhUTUxJbnB1dEVsZW1lbnQ+KGlkKS5jaGVja2VkO1xuXG4vKiogVGhlIGxhdGVzdCBidWlsZCBmcm9tIHRoZSBkZXYgc2VydmVyLCBldmFsdWF0ZWQgYWZyZXNoOiBhbiBlZGl0IGluIHNyYy8gaXMgaW4gdGhlIG5leHQgY2FsbC4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBsb2FkQ29yZSh1cmwgPSBcIi92b2ljZS1jb3JlLmpzXCIpOiBQcm9taXNlPENvcmU+IHtcbiAgY29uc3Qgc291cmNlID0gYXdhaXQgKGF3YWl0IGZldGNoKHVybCwgeyBjYWNoZTogXCJuby1zdG9yZVwiIH0pKS50ZXh0KCk7XG4gIGNvbnN0IHNjb3BlOiB7IFZvaWNlQ29yZT86IENvcmUgfSA9IHt9O1xuICBuZXcgRnVuY3Rpb24oXCJnbG9iYWxUaGlzXCIsIHNvdXJjZSkoc2NvcGUpO1xuICBpZiAoIXNjb3BlLlZvaWNlQ29yZSkgdGhyb3cgbmV3IEVycm9yKFwidGhlIGJ1bmRsZSBkaWRuJ3QgZGVmaW5lIFZvaWNlQ29yZVwiKTtcbiAgcmV0dXJuIHNjb3BlLlZvaWNlQ29yZTtcbn1cblxuLy8gUHJlc2V0czogZWFjaCBzdXJmYWNlJ3Mgc2V0dGluZ3MgYXMgaXRzIGFwcCB3b3VsZCBzZXQgdGhlbS5cblxuY29uc3QgRkFLRV9UViA9IFtcbiAgeyBuYW1lOiBcInR2X3ZvbHVtZVwiLCBkZXNjcmlwdGlvbjogXCJTZXRzIHRoZSBsaXZpbmctcm9vbSBUVidzIHZvbHVtZSwgMCB0byAxMDAuXCIsIHBhcmFtZXRlcnM6IHsgdHlwZTogXCJPQkpFQ1RcIiwgcHJvcGVydGllczogeyBsZXZlbDogeyB0eXBlOiBcIklOVEVHRVJcIiB9IH0sIHJlcXVpcmVkOiBbXCJsZXZlbFwiXSB9IH0sXG4gIHsgbmFtZTogXCJ0dl9wYXVzZVwiLCBkZXNjcmlwdGlvbjogXCJQYXVzZXMgb3IgcmVzdW1lcyB3aGF0J3MgcGxheWluZyBvbiB0aGUgVFYuXCIsIHBhcmFtZXRlcnM6IHsgdHlwZTogXCJPQkpFQ1RcIiwgcHJvcGVydGllczogeyBwYXVzZTogeyB0eXBlOiBcIkJPT0xFQU5cIiB9IH0gfSB9LFxuXTtcblxuY29uc3QgUFJFU0VUUzogUmVjb3JkPHN0cmluZywgUmVjb3JkPHN0cmluZywgdW5rbm93bj4+ID0ge1xuICB3ZWI6IHsgcGxhdGZvcm06IFwid2ViXCIsIGRldmljZTogXCJicm93c2VyXCIsIHN0YW5kYnlBZnRlcjogMzAsIGhhbmdVcEFmdGVyOiAzMDAsIGhhbmRPZmY6IFwibmFtZWRcIiwgc3VwZXJ2aXNlOiB0cnVlLCB2b2NhYnVsYXJ5OiBbXCJIZXJtZXNcIiwgXCJCZW50b1wiLCBcIldvb2Rob3VzZVwiLCBcIlQzXCJdIH0sXG4gIGFuZHJvaWQ6IHsgcGxhdGZvcm06IFwiQW5kcm9pZFwiLCBkZXZpY2U6IFwicGhvbmVcIiwgc3RhbmRieUFmdGVyOiAyMCB9LFxuICBcImFuZHJvaWQgd2FrZSB3b3JkXCI6IHsgcGxhdGZvcm06IFwiQW5kcm9pZFwiLCBkZXZpY2U6IFwicGhvbmVcIiwgc3RhbmRieUFmdGVyOiAyMCwgaGFuZ1VwQWZ0ZXI6IDE1IH0sXG4gIG1hY29zOiB7IHBsYXRmb3JtOiBcIm1hY09TXCIsIGRldmljZTogXCJNYWNcIiwgc3RhbmRieUFmdGVyOiAyMCB9LFxuICBlY2hvOiB7XG4gICAgcGxhdGZvcm06IFwiRWNob1wiLCBkZXZpY2U6IFwic3BlYWtlclwiLCBoYW5nVXBBZnRlcjogNiwgc3RhbmRieUFmdGVyOiA4LCBlYXJjb25zOiB0cnVlLCB2b2NhYnVsYXJ5OiBbXCJIZXJtZXNcIiwgXCJCZW50b1wiLCBcIldvb2Rob3VzZVwiXSxcbiAgICBtaWM6IHsgd2hpbGVTcGVha2luZzogXCJ3YWtlXCIsIGdhaW5EYjogMCB9LCBob3N0VG9vbHM6IEZBS0VfVFYsXG4gIH0sXG59O1xuXG4vLyBTdGF0ZS5cblxuY29uc3QgYXVkaW8gPSBuZXcgQ2FsbEF1ZGlvKCk7XG5sZXQgc2VydmVyOiBTZXJ2ZXJDb25maWc7XG5sZXQgY29yZTogQ29yZSB8IG51bGwgPSBudWxsO1xubGV0IGNhbGxJZCA9IDA7XG5sZXQgY2FsbE5hbWUgPSBcIlwiO1xubGV0IHRpY2tlciA9IDA7XG5sZXQgdHJhY2VUaW1lciA9IDA7XG5sZXQgc3RhcnRlZEF0ID0gbm93KCk7XG5jb25zdCBzb2NrZXRzID0gbmV3IE1hcDxudW1iZXIsIFdlYlNvY2tldD4oKTtcbi8qKiBUaGUgc29ja2V0cyB0byB0aGUgdHJhbnNjcmlwdGlvbiBtb2RlbDogdGhlaXIgYXVkaW8gaXMgdGhlIG1vZGVsJ3MgYWdhaW4sIHNvIGl0IGlzbid0IGNvdW50ZWQgb3IgbG9nZ2VkIHR3aWNlLiAqL1xuY29uc3QgY2FwdGlvblNvY2tldHMgPSBuZXcgU2V0PG51bWJlcj4oKTtcbmNvbnN0IHJ1bnMgPSBuZXcgTWFwPHN0cmluZywgeyBhYm9ydDogQWJvcnRDb250cm9sbGVyOyBhZ2VudDogc3RyaW5nOyB0YXNrSWQ6IHN0cmluZyB9PigpO1xuaW50ZXJmYWNlIFRhc2tWaWV3IHsgYzogQ29tbWFuZDsgc2luY2U6IG51bWJlcjsgZW5kZWQ6IG51bWJlciB8IG51bGw7IHRocmVhZD86IHN0cmluZzsgcmVzdWx0PzogSFRNTEVsZW1lbnQ7IGFwcHJvdmFsPzogeyBjb21tYW5kOiBzdHJpbmcgfSB9XG5jb25zdCB0YXNrcyA9IG5ldyBNYXA8c3RyaW5nLCBUYXNrVmlldz4oKTtcbmxldCBlYXJsaWVyQWN0aXZlQ291bnQgPSAwO1xubGV0IGVhcmxpZXJXYWl0aW5nQ291bnQgPSAwO1xubGV0IGNvdW50cyA9IHsgbWljOiAwLCBwbGF5OiAwLCBzZW50OiAwIH07XG5sZXQgZmFrZVR2TGV2ZWwgPSAxNTtcbmxldCBjb3JlU3RhdHVzID0gXCJpZGxlXCI7XG5sZXQgbXV0ZWQgPSBmYWxzZTtcbmxldCBob2xkaW5nID0gZmFsc2U7XG5sZXQgd2FrZUxvY2s6IHsgcmVsZWFzZSgpOiBQcm9taXNlPHZvaWQ+IH0gfCBudWxsID0gbnVsbDtcbi8qKiBXaGF0IHRoZSBzZXNzaW9uIG9uIHNjcmVlbiBpczogYSB2b2ljZSBjYWxsLCBvciBhIHR5cGVkIGNoYXQgKHRoZSBjb3JlJ3MgbWVkaXVtIFwidGV4dFwiKS4gKi9cbmxldCBtZWRpdW06IFwidm9pY2VcIiB8IFwidGV4dFwiID0gXCJ2b2ljZVwiO1xuLyoqIEEgY2hhdCdzIG1vZGVsIGlzIHdyaXRpbmcgaXRzIGFuc3dlci4gKi9cbmxldCB0aGlua2luZyA9IGZhbHNlO1xuLyoqIEEgY2hhdCdzIHJlcXVlc3RzIHRvIHRoZSB0ZXh0IG1vZGVsIHRoYXQgYXJlIHVuZGVyIHdheS4gKi9cbmNvbnN0IHJlcXVlc3RzID0gbmV3IE1hcDxudW1iZXIsIEFib3J0Q29udHJvbGxlcj4oKTtcbi8qKiBUaGUgbGFzdCBzZXNzaW9uIHdpbmRpbmcgZG93biAoaXRzIHRyYWNlIHNhdmVkLCB0aGUgY29yZSdzIGNhbGwgZGlzcG9zZWQpOiB0aGUgbmV4dCBzdGFydHMgYWZ0ZXIgaXQuICovXG5sZXQgZW5kaW5nOiBQcm9taXNlPHZvaWQ+ID0gUHJvbWlzZS5yZXNvbHZlKCk7XG5cbi8vIFRoZSBjb252ZXJzYXRpb24sIGtlcHQgc28gYSBuZXcgY2FsbCBjYW4gY2Fycnkgb24gZnJvbSBpdCAodGhlIGNvcmUncyBgaGlzdG9yeWAsIHJlY2FwcGVkIHRvIHRoZSBtb2RlbCkuXG5pbnRlcmZhY2UgQ2hhdExpbmUgeyByb2xlOiBcInVzZXJcIiB8IFwiYXNzaXN0YW50XCI7IHNwZWFrZXI/OiBzdHJpbmc7IHRleHQ6IHN0cmluZyB9XG5jb25zdCBISVNUT1JZID0gXCJ2b2ljZS5oaXN0b3J5XCI7XG5jb25zdCBISVNUT1JZX01BWF9BR0UgPSAxMiAqIDM2MDAgKiAxMDAwO1xubGV0IGNoYXQ6IENoYXRMaW5lW10gPSBbXTtcbi8qKiBUaGUgY29yZSdzIG51bWJlciBmb3IgdGhlIGxpbmUgdGhlIGxhc3Qgd29yZHMgd2VyZSByZW1lbWJlcmVkIG9uLCB1bnRpbCBzb21ldGhpbmcgZWxzZSBpcy4gKi9cbmxldCBsYXN0TGluZTogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5cbmZ1bmN0aW9uIHJlbWVtYmVyKHJvbGU6IFwidXNlclwiIHwgXCJhc3Npc3RhbnRcIiwgdGV4dDogc3RyaW5nLCBzcGVha2VyPzogc3RyaW5nLCBqb2luID0gZmFsc2UpIHtcbiAgY29uc3QgbGFzdCA9IGNoYXQuYXQoLTEpO1xuICBpZiAoam9pbiAmJiBsYXN0ICYmIGxhc3Qucm9sZSA9PT0gcm9sZSAmJiBsYXN0LnNwZWFrZXIgPT09IHNwZWFrZXIpIGxhc3QudGV4dCArPSB0ZXh0O1xuICBlbHNlIGNoYXQucHVzaChzcGVha2VyID8geyByb2xlLCBzcGVha2VyLCB0ZXh0IH0gOiB7IHJvbGUsIHRleHQgfSk7XG4gIGlmIChjaGF0Lmxlbmd0aCA+IDIwMCkgY2hhdC5zcGxpY2UoMCwgY2hhdC5sZW5ndGggLSAyMDApO1xuICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShISVNUT1JZLCBKU09OLnN0cmluZ2lmeSh7IGF0OiBEYXRlLm5vdygpLCBjaGF0IH0pKTtcbn1cblxuZnVuY3Rpb24gc2F2ZWRIaXN0b3J5KCk6IENoYXRMaW5lW10ge1xuICB0cnkge1xuICAgIGNvbnN0IHNhdmVkID0gSlNPTi5wYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShISVNUT1JZKSA/PyBcIm51bGxcIik7XG4gICAgcmV0dXJuIHNhdmVkICYmIERhdGUubm93KCkgLSBzYXZlZC5hdCA8IEhJU1RPUllfTUFYX0FHRSAmJiBBcnJheS5pc0FycmF5KHNhdmVkLmNoYXQpID8gc2F2ZWQuY2hhdCA6IFtdO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gW107XG4gIH1cbn1cblxuLyoqIFR3byByaXNpbmcgbm90ZXM6IHNvbWV0aGluZyBvbiB0aGUgc2NyZWVuIG5lZWRzIHRoZSB1c2VyLiBQQ00xNiBhdCAyNCBrSHosIGJhc2U2NC4gKi9cbmNvbnN0IEFQUFJPVkFMX1RPTkUgPSAoKCkgPT4ge1xuICBjb25zdCByYXRlID0gMjQwMDAsIG91dCA9IG5ldyBJbnQxNkFycmF5KHJhdGUgKiAwLjMyKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCB0ID0gaSAvIHJhdGUsIGYgPSB0IDwgMC4xNiA/IDY2MCA6IDg4MCwgbG9jYWwgPSB0IDwgMC4xNiA/IHQgOiB0IC0gMC4xNjtcbiAgICBvdXRbaV0gPSBNYXRoLnJvdW5kKE1hdGguc2luKDIgKiBNYXRoLlBJICogZiAqIHQpICogTWF0aC5taW4oMSwgbG9jYWwgKiA2MCwgKDAuMTYgLSBsb2NhbCkgKiA2MCkgKiA2MDAwKTtcbiAgfVxuICBsZXQgYmluID0gXCJcIjtcbiAgY29uc3QgYnl0ZXMgPSBuZXcgVWludDhBcnJheShvdXQuYnVmZmVyKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBieXRlcy5sZW5ndGg7IGkrKykgYmluICs9IFN0cmluZy5mcm9tQ2hhckNvZGUoYnl0ZXNbaV0pO1xuICByZXR1cm4gYnRvYShiaW4pO1xufSkoKTtcblxuLy8gTGF0ZW5jeTogdGhlIG5ldHdvcmsncyByb3VuZCB0cmlwLCBhbmQgaG93IGxvbmcgYWZ0ZXIgdGhlIHVzZXIgc3RvcHMgdGFsa2luZyB0aGUgcmVwbHkgc3RhcnRzLlxuY29uc3QgbWV0cmljcyA9IHsgcnR0OiBbXSBhcyBudW1iZXJbXSwgcmVwbHk6IFtdIGFzIG51bWJlcltdLCBsYXN0Vm9pY2U6IDAsIGxhc3RQbGF5OiAwLCByZXBsaWVkOiB0cnVlIH07XG5cbmZ1bmN0aW9uIG1lZGlhbih4czogbnVtYmVyW10pOiBudW1iZXIgfCBudWxsIHtcbiAgaWYgKHhzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHMgPSBbLi4ueHNdLnNvcnQoKGEsIGIpID0+IGEgLSBiKTtcbiAgcmV0dXJuIHNbTWF0aC5mbG9vcihzLmxlbmd0aCAvIDIpXTtcbn1cblxuZnVuY3Rpb24gc2hvd01ldHJpY3MoKSB7XG4gIGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBydHQgPSBtZWRpYW4obWV0cmljcy5ydHQpO1xuICBpZiAocnR0ICE9IG51bGwpIHBhcnRzLnB1c2goYCR7TWF0aC5yb3VuZChydHQgKiAxMDAwKX0gbXNgKTtcbiAgY29uc3QgcmVwbHkgPSBtZWRpYW4obWV0cmljcy5yZXBseSk7XG4gIGlmIChyZXBseSAhPSBudWxsKSBwYXJ0cy5wdXNoKGByZXBseSAke21ldHJpY3MucmVwbHkuYXQoLTEpIS50b0ZpeGVkKDEpfXMgKCR7cmVwbHkudG9GaXhlZCgxKX1zIG1lZClgKTtcbiAgY29uc3Qgb3V0ID0gYXVkaW8ub3V0cHV0TGF0ZW5jeTtcbiAgaWYgKG91dCAhPSBudWxsKSBwYXJ0cy5wdXNoKGBhdWRpbyAke01hdGgucm91bmQob3V0ICogMTAwMCl9IG1zYCk7XG4gIGxldCBidWZmZXJlZCA9IDA7XG4gIGZvciAoY29uc3Qgd3Mgb2Ygc29ja2V0cy52YWx1ZXMoKSkgYnVmZmVyZWQgKz0gd3MuYnVmZmVyZWRBbW91bnQ7XG4gIGlmIChidWZmZXJlZCA+IDMyXzAwMCkgcGFydHMucHVzaChgdXBsb2FkICskeyhidWZmZXJlZCAvIDMyXzAwMCkudG9GaXhlZCgxKX1zYCk7XG4gICQoXCJtZXRyaWNzXCIpLnRleHRDb250ZW50ID0gcGFydHMuam9pbihcIiBcdTAwQjcgXCIpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBwaW5nKCkge1xuICBjb25zdCB0ID0gbm93KCk7XG4gIHRyeSB7XG4gICAgYXdhaXQgZmV0Y2goXCIvcGluZ1wiLCB7IGNhY2hlOiBcIm5vLXN0b3JlXCIgfSk7XG4gICAgbWV0cmljcy5ydHQucHVzaChub3coKSAtIHQpO1xuICAgIGlmIChtZXRyaWNzLnJ0dC5sZW5ndGggPiAxMikgbWV0cmljcy5ydHQuc2hpZnQoKTtcbiAgfSBjYXRjaCB7fVxuICBzaG93TWV0cmljcygpO1xufVxuXG4vLyBUaGVtZS5cblxuZnVuY3Rpb24gYXBwbHlUaGVtZShjaG9pY2U6IHN0cmluZykge1xuICBjb25zdCByb290ID0gZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50O1xuICBpZiAoY2hvaWNlID09PSBcImRhcmtcIiB8fCBjaG9pY2UgPT09IFwibGlnaHRcIikgcm9vdC5kYXRhc2V0LnRoZW1lID0gY2hvaWNlO1xuICBlbHNlIGRlbGV0ZSByb290LmRhdGFzZXQudGhlbWU7XG4gIGNvbnN0IGRhcmsgPSBjaG9pY2UgPT09IFwiZGFya1wiIHx8IChjaG9pY2UgIT09IFwibGlnaHRcIiAmJiBtYXRjaE1lZGlhKFwiKHByZWZlcnMtY29sb3Itc2NoZW1lOiBkYXJrKVwiKS5tYXRjaGVzKTtcbiAgY29uc3QgbWV0YSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwidGhlbWUtY29sb3JcIik7XG4gIGlmIChtZXRhKSBtZXRhLnNldEF0dHJpYnV0ZShcImNvbnRlbnRcIiwgZGFyayA/IFwiIzBlMGYwZlwiIDogXCIjZjZmNWYwXCIpO1xuICBmb3IgKGNvbnN0IGJ0biBvZiBBcnJheS5mcm9tKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiI3RoZW1lLXBpY2tlciBidXR0b25cIikpKSB7XG4gICAgYnRuLmNsYXNzTGlzdC50b2dnbGUoXCJvblwiLCBidG4uZGF0YXNldC50aGVtZSA9PT0gKGNob2ljZSB8fCBcInN5c3RlbVwiKSk7XG4gIH1cbn1cblxuLy8gVGhlIHNjcmVlbi5cblxuZnVuY3Rpb24gc2V0Q2FsbEJ1dHRvbihsaXZlOiBib29sZWFuKSB7XG4gIGNvbnN0IGJ0biA9ICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiY2FsbFwiKTtcbiAgYnRuLmNsYXNzTGlzdC50b2dnbGUoXCJsaXZlXCIsIGxpdmUpO1xuICBjb25zdCBsYWJlbCA9IGJ0bi5xdWVyeVNlbGVjdG9yKFwiLmNhbGwtbGFiZWxcIik7XG4gIGlmIChsYWJlbCkgbGFiZWwudGV4dENvbnRlbnQgPSBsaXZlID8gXCJIYW5nIHVwXCIgOiBcIkNhbGxcIjtcbn1cblxuZnVuY3Rpb24gc3luY1Jlc3VtZUJ1dHRvbnMoc2hvdzogYm9vbGVhbikge1xuICAkKFwicmVzdW1lXCIpLmhpZGRlbiA9ICFzaG93O1xuICAkKFwiaGVyby1yZXN1bWVcIikuaGlkZGVuID0gIXNob3c7XG59XG5cbmZ1bmN0aW9uIHBhcnNlUHJlZml4KHRleHQ6IHN0cmluZyk6IHsgbW9kZTogXCJoZXJtZXNcIiB8IFwidDNcIiB8IG51bGw7IHJlc3Q6IHN0cmluZyB9IHtcbiAgY29uc3QgbSA9IHRleHQubWF0Y2goL15cXC8odDN8Y29kZXxofGhlcm1lcylcXHMrKC4qKSQvaXMpO1xuICBpZiAoIW0pIHJldHVybiB7IG1vZGU6IG51bGwsIHJlc3Q6IHRleHQgfTtcbiAgcmV0dXJuIHsgbW9kZTogL14odDN8Y29kZSkkL2kudGVzdChtWzFdKSA/IFwidDNcIiA6IFwiaGVybWVzXCIsIHJlc3Q6IG1bMl0udHJpbSgpIH07XG59XG5cbmZ1bmN0aW9uIHN5bmNDb21wb3NlcigpIHtcbiAgY29uc3QgaW5wdXQgPSAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwidGV4dFwiKTtcbiAgY29uc3QgdHJpbW1lZCA9IGlucHV0LnZhbHVlLnRyaW0oKTtcbiAgJChcInNlbmRidG5cIikuY2xhc3NMaXN0LnRvZ2dsZShcInJlYWR5XCIsIHRyaW1tZWQubGVuZ3RoID4gMCk7XG4gIGNvbnN0IHBhcnNlZCA9IHBhcnNlUHJlZml4KHRyaW1tZWQpO1xuICAkKFwibW9kZS13cmFwXCIpLmRhdGFzZXQubW9kZSA9IHBhcnNlZC5tb2RlID8/ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwibW9kZVwiKS52YWx1ZTtcbn1cblxuZnVuY3Rpb24gdXBkYXRlSnVtcEJ1dHRvbigpIHtcbiAgY29uc3QgcGFuZSA9ICQoXCJ0cmFuc2NyaXB0XCIpO1xuICBjb25zdCBhd2F5ID0gcGFuZS5zY3JvbGxIZWlnaHQgLSBwYW5lLnNjcm9sbFRvcCAtIHBhbmUuY2xpZW50SGVpZ2h0ID4gMTIwO1xuICAkKFwianVtcGJvdHRvbVwiKS5oaWRkZW4gPSAhYXdheSB8fCAhJChcImVtcHR5XCIpLmhpZGRlbjtcbn1cblxuZnVuY3Rpb24gZm9ybWF0Q2xvY2soc2Vjb25kczogbnVtYmVyKTogc3RyaW5nIHtcbiAgY29uc3QgdG90YWwgPSBNYXRoLm1heCgwLCBNYXRoLmZsb29yKHNlY29uZHMpKTtcbiAgY29uc3QgaCA9IE1hdGguZmxvb3IodG90YWwgLyAzNjAwKTtcbiAgY29uc3QgbSA9IE1hdGguZmxvb3IoKHRvdGFsICUgMzYwMCkgLyA2MCk7XG4gIGNvbnN0IHMgPSB0b3RhbCAlIDYwO1xuICBjb25zdCBwYWQgPSAobjogbnVtYmVyKSA9PiBTdHJpbmcobikucGFkU3RhcnQoMiwgXCIwXCIpO1xuICByZXR1cm4gaCA+IDAgPyBgJHtofToke3BhZChtKX06JHtwYWQocyl9YCA6IGAke3BhZChtKX06JHtwYWQocyl9YDtcbn1cblxuY29uc3QgVklaX1dFSUdIVFMgPSBbMC40OCwgMC44NiwgMS4wLCAwLjc4LCAwLjQ0XTtcbmZ1bmN0aW9uIHVwZGF0ZVZpc3VhbGl6ZXIobW9kZTogc3RyaW5nLCBsZXZlbDogbnVtYmVyKSB7XG4gIGNvbnN0IHZpeiA9ICQoXCJ2aXpcIik7XG4gIHZpei5kYXRhc2V0Lm1vZGUgPSBtb2RlO1xuICBjb25zdCBiYXJzID0gdml6LmNoaWxkcmVuO1xuICBpZiAobW9kZSA9PT0gXCJsaXN0ZW5pbmdcIiB8fCBtb2RlID09PSBcIndvcmtpbmdcIikge1xuICAgIGNvbnN0IGVuZXJneSA9IE1hdGgubWluKDEsIGxldmVsICogMTQpO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYmFycy5sZW5ndGg7IGkrKykge1xuICAgICAgY29uc3QgaCA9IDAuMjQgKyBlbmVyZ3kgKiBWSVpfV0VJR0hUU1tpXSAqIDAuNzY7XG4gICAgICAoYmFyc1tpXSBhcyBIVE1MRWxlbWVudCkuc3R5bGUudHJhbnNmb3JtID0gYHNjYWxlWSgke2gudG9GaXhlZCgyKX0pYDtcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBiYXJzLmxlbmd0aDsgaSsrKSAoYmFyc1tpXSBhcyBIVE1MRWxlbWVudCkuc3R5bGUudHJhbnNmb3JtID0gXCJcIjtcbiAgfVxufVxuXG4vKiogQSBzeXN0ZW0gbm90aWZpY2F0aW9uIHdoaWxlIHRoZSBwYWdlIGlzIGhpZGRlbjogYSB0YXNrIGZpbmlzaGVkLCBvciBvbmUgbmVlZHMgdGhlIHVzZXIuICovXG5mdW5jdGlvbiBub3RpZnkodGl0bGU6IHN0cmluZywgYm9keTogc3RyaW5nKSB7XG4gIGlmICghZG9jdW1lbnQuaGlkZGVuIHx8ICEoXCJOb3RpZmljYXRpb25cIiBpbiB3aW5kb3cpIHx8IE5vdGlmaWNhdGlvbi5wZXJtaXNzaW9uICE9PSBcImdyYW50ZWRcIikgcmV0dXJuO1xuICB0cnkge1xuICAgIGNvbnN0IG4gPSBuZXcgTm90aWZpY2F0aW9uKHRpdGxlLCB7IGJvZHk6IGJvZHkuc2xpY2UoMCwgMTgwKSwgaWNvbjogXCIvd2ViL2ljb25zL2ljb24tMTkyLnBuZ1wiLCB0YWc6IHRpdGxlIH0pO1xuICAgIG4ub25jbGljayA9ICgpID0+IHsgd2luZG93LmZvY3VzKCk7IG4uY2xvc2UoKTsgfTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gUGhvbmVzIHdhbnQgbm90aWZpY2F0aW9ucyBmcm9tIGEgc2VydmljZSB3b3JrZXI7IHRoZSBwYWdlIGhhcyBub25lLlxuICB9XG59XG5cbmZ1bmN0aW9uIHRvYXN0KHRleHQ6IHN0cmluZykge1xuICBjb25zdCB0ID0gJChcInRvYXN0XCIpO1xuICB0LnRleHRDb250ZW50ID0gdGV4dDtcbiAgdC5jbGFzc0xpc3QuYWRkKFwib25cIik7XG4gIGNsZWFyVGltZW91dCgodG9hc3QgYXMgYW55KS50aW1lcik7XG4gICh0b2FzdCBhcyBhbnkpLnRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB0LmNsYXNzTGlzdC5yZW1vdmUoXCJvblwiKSwgMTgwMCk7XG59XG5cbmZ1bmN0aW9uIGxvZyhraW5kOiBzdHJpbmcsIHRleHQ6IHN0cmluZywgY2xzID0gXCJcIikge1xuICBjb25zdCBwYW5lID0gJChcImxvZ1wiKTtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IGByb3cgJHtjbHN9YDtcbiAgcm93LmlubmVySFRNTCA9IGA8c3BhbiBjbGFzcz1cInRcIj4keyhub3coKSAtIHN0YXJ0ZWRBdCkudG9GaXhlZCgyKX08L3NwYW4+PHNwYW4gY2xhc3M9XCJrXCI+JHtraW5kfTwvc3Bhbj5gO1xuICBjb25zdCBib2R5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGJvZHkuY2xhc3NOYW1lID0gXCJiXCI7XG4gIGJvZHkudGV4dENvbnRlbnQgPSB0ZXh0O1xuICByb3cuYXBwZW5kKGJvZHkpO1xuICBjb25zdCBzdGljayA9IHBhbmUuc2Nyb2xsVG9wICsgcGFuZS5jbGllbnRIZWlnaHQgPj0gcGFuZS5zY3JvbGxIZWlnaHQgLSAzMDtcbiAgcGFuZS5hcHBlbmQocm93KTtcbiAgd2hpbGUgKHBhbmUuY2hpbGRFbGVtZW50Q291bnQgPiAzMDAwKSBwYW5lLmZpcnN0RWxlbWVudENoaWxkIS5yZW1vdmUoKTtcbiAgaWYgKHN0aWNrKSBwYW5lLnNjcm9sbFRvcCA9IHBhbmUuc2Nyb2xsSGVpZ2h0O1xufVxuXG4vKiogQSBmcmFtZSBmcm9tIG9yIHRvIEdlbWluaSwgd2l0aCBhdWRpbyBjdXQgb3V0LCBzaG9ydCBlbm91Z2ggdG8gcmVhZC4gKi9cbmZ1bmN0aW9uIGJyaWVmKGRhdGE6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBkYXRhLnJlcGxhY2UoL1wiZGF0YVwiOlwiW0EtWmEtejAtOSsvPV17NDAsfVwiL2csIChtKSA9PiBgXCJkYXRhXCI6XCJcdTIwMjYke01hdGgucm91bmQoKChtLmxlbmd0aCAtIDkpICogMykgLyA0KX0gYnl0ZXNcImApLnNsaWNlKDAsIDYwMCk7XG59XG5cbmZ1bmN0aW9uIGVzY2FwZUh0bWwodGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHRleHQucmVwbGFjZSgvWyY8PlwiJ10vZywgKGMpID0+ICh7IFwiJlwiOiBcIiZhbXA7XCIsIFwiPFwiOiBcIiZsdDtcIiwgXCI+XCI6IFwiJmd0O1wiLCAnXCInOiBcIiZxdW90O1wiLCBcIidcIjogXCImIzM5O1wiIH0pW2NdISk7XG59XG5cbi8qKiBBIGxpdHRsZSBNYXJrZG93biwgc2FmZWx5OiBjb2RlLCBib2xkLCBsaW5rcywgbGlzdHMgYW5kIGhlYWRpbmdzLCB0aGUgcmVzdCBhcyB0ZXh0LiAqL1xuZnVuY3Rpb24gbWFya2Rvd24odGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgYmxvY2tzID0gZXNjYXBlSHRtbCh0ZXh0LnRyaW0oKSkuc3BsaXQoL2BgYCg/OlxcdyspP1xcbj8vKTtcbiAgcmV0dXJuIGJsb2Nrcy5tYXAoKGJsb2NrLCBpKSA9PiB7XG4gICAgaWYgKGkgJSAyID09PSAxKSByZXR1cm4gYDxwcmU+PGNvZGU+JHtibG9jay5yZXBsYWNlKC9cXG4kLywgXCJcIil9PC9jb2RlPjwvcHJlPmA7XG4gICAgY29uc3QgaW5saW5lID0gKHM6IHN0cmluZykgPT4gc1xuICAgICAgLnJlcGxhY2UoL2AoW15gXFxuXSspYC9nLCBcIjxjb2RlPiQxPC9jb2RlPlwiKVxuICAgICAgLnJlcGxhY2UoL1xcKlxcKihbXipcXG5dKylcXCpcXCovZywgXCI8Yj4kMTwvYj5cIilcbiAgICAgIC5yZXBsYWNlKC9cXFsoW15cXF1cXG5dKylcXF1cXCgoaHR0cHM/OlxcL1xcL1teXFxzKV0rKVxcKS9nLCAnPGEgaHJlZj1cIiQyXCIgdGFyZ2V0PVwiX2JsYW5rXCIgcmVsPVwibm9vcGVuZXJcIj4kMTwvYT4nKVxuICAgICAgLnJlcGxhY2UoLyhefFtcXHMoXSkoaHR0cHM/OlxcL1xcL1teXFxzPCldKykvZywgJyQxPGEgaHJlZj1cIiQyXCIgdGFyZ2V0PVwiX2JsYW5rXCIgcmVsPVwibm9vcGVuZXJcIj4kMjwvYT4nKTtcbiAgICBsZXQgaHRtbCA9IFwiXCI7XG4gICAgbGV0IGxpc3Q6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgIGZvciAoY29uc3QgcmF3IG9mIGJsb2NrLnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgICBjb25zdCBpdGVtID0gcmF3Lm1hdGNoKC9eXFxzKig/OlstKlx1MjAyMl18KFxcZCspWy4pXSlcXHMrKC4qKSQvKTtcbiAgICAgIGlmIChpdGVtKSB7XG4gICAgICAgIGNvbnN0IGtpbmQgPSBpdGVtWzFdID8gXCJvbFwiIDogXCJ1bFwiO1xuICAgICAgICBpZiAobGlzdCAhPT0ga2luZCkgeyBpZiAobGlzdCkgaHRtbCArPSBgPC8ke2xpc3R9PmA7IGh0bWwgKz0gYDwke2tpbmR9PmA7IGxpc3QgPSBraW5kOyB9XG4gICAgICAgIGh0bWwgKz0gYDxsaT4ke2lubGluZShpdGVtWzJdKX08L2xpPmA7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgaWYgKGxpc3QpIHsgaHRtbCArPSBgPC8ke2xpc3R9PmA7IGxpc3QgPSBudWxsOyB9XG4gICAgICBjb25zdCBoZWFkaW5nID0gcmF3Lm1hdGNoKC9eI3sxLDZ9XFxzKyguKikkLyk7XG4gICAgICBodG1sICs9IGhlYWRpbmcgPyBgPGRpdiBjbGFzcz1cIm1kLWhcIj4ke2lubGluZShoZWFkaW5nWzFdKX08L2Rpdj5gIDogcmF3LnRyaW0oKSA9PT0gXCJcIiA/IFwiPGJyPlwiIDogYCR7aW5saW5lKHJhdyl9PGJyPmA7XG4gICAgfVxuICAgIGlmIChsaXN0KSBodG1sICs9IGA8LyR7bGlzdH0+YDtcbiAgICByZXR1cm4gaHRtbC5yZXBsYWNlKC8oPGJyPikrJC8sIFwiXCIpO1xuICB9KS5qb2luKFwiXCIpO1xufVxuXG5mdW5jdGlvbiBzY3JvbGxEb3duKGZvcmNlID0gZmFsc2UpIHtcbiAgY29uc3QgcGFuZSA9ICQoXCJ0cmFuc2NyaXB0XCIpO1xuICBpZiAoZm9yY2UgfHwgcGFuZS5zY3JvbGxUb3AgKyBwYW5lLmNsaWVudEhlaWdodCA+PSBwYW5lLnNjcm9sbEhlaWdodCAtIDgwKSBwYW5lLnNjcm9sbFRvcCA9IHBhbmUuc2Nyb2xsSGVpZ2h0O1xuICB1cGRhdGVKdW1wQnV0dG9uKCk7XG59XG5cbi8qKiBUaGUgY29yZSdzIG51bWJlciBmb3IgdGhlIGxpbmUgdGhlIGxhc3Qgcm93IHNob3dzLCB1bnRpbCBhbm90aGVyIHJvdyBmb2xsb3dzIGl0LiAqL1xubGV0IG9wZW5MaW5lOiBudW1iZXIgfCBudWxsID0gbnVsbDtcblxuLyoqIFdvcmRzIGdvIG9uIHRoZSByb3cgdGhlIGNvcmUgc2F5cyB0aGV5IGJlbG9uZyB0bzogaXQgc3RhcnRzIGEgbmV3IGxpbmUgZm9yIGVhY2ggdHVybiwgaG93ZXZlciBsb25nIHRoZSBnYXAuICovXG5mdW5jdGlvbiB0cmFuc2NyaXB0KHJvbGU6IFwidXNlclwiIHwgXCJhc3Npc3RhbnRcIiwgdGV4dDogc3RyaW5nLCBsaW5lOiBudW1iZXIpIHtcbiAgJChcImVtcHR5XCIpLmhpZGRlbiA9IHRydWU7XG4gIGNvbnN0IHBhbmUgPSAkKFwidHJhbnNjcmlwdFwiKTtcbiAgY29uc3QgbGFzdCA9IHBhbmUubGFzdEVsZW1lbnRDaGlsZCBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gIGlmIChvcGVuTGluZSA9PT0gbGluZSAmJiBsYXN0ICYmIGxhc3QuZGF0YXNldC5yb2xlID09PSByb2xlKSBsYXN0LnF1ZXJ5U2VsZWN0b3IoXCIudGV4dFwiKSEudGV4dENvbnRlbnQgKz0gdGV4dDtcbiAgZWxzZSB7XG4gICAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICByb3cuY2xhc3NOYW1lID0gYGxpbmUgJHtyb2xlfWA7XG4gICAgcm93LmRhdGFzZXQucm9sZSA9IHJvbGU7XG4gICAgcm93LmlubmVySFRNTCA9IGA8c3BhbiBjbGFzcz1cIndob1wiPiR7cm9sZSA9PT0gXCJ1c2VyXCIgPyBcIllvdVwiIDogXCJHZW1pbmlcIn08L3NwYW4+PHNwYW4gY2xhc3M9XCJ0ZXh0XCI+PC9zcGFuPmA7XG4gICAgcm93LnF1ZXJ5U2VsZWN0b3IoXCIudGV4dFwiKSEudGV4dENvbnRlbnQgPSB0ZXh0LnRyaW1TdGFydCgpO1xuICAgIHBhbmUuYXBwZW5kKHJvdyk7XG4gICAgb3BlbkxpbmUgPSBsaW5lO1xuICB9XG4gIHNjcm9sbERvd24ocm9sZSA9PT0gXCJ1c2VyXCIpO1xufVxuXG4vKipcbiAqIFRoZSB3b3JkcyB0aGUgdXNlciBpcyBzYXlpbmcsIGJlZm9yZSB0aGUgbW9kZWwgaGFzIHRyYW5zY3JpYmVkIHRoZW06IGEgZmFpbnQgcm93IHRoYXQgc3RheXMgbGFzdFxuICogb24gc2NyZWVuIChpdHMgQ1NTIGBvcmRlcmApIGFuZCBmaXJzdCBpbiB0aGUgcGFuZSwgc28gdGhlIGxpbmVzIGFmdGVyIGl0IGpvaW4gdXAgYXMgYmVmb3JlLlxuICovXG5mdW5jdGlvbiBjYXB0aW9uKHRleHQ6IHN0cmluZyB8IG51bGwpIHtcbiAgY29uc3QgcGFuZSA9ICQoXCJ0cmFuc2NyaXB0XCIpO1xuICBsZXQgcm93ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJjYXB0aW9uXCIpO1xuICBpZiAodGV4dCA9PSBudWxsKSB7IHJvdz8ucmVtb3ZlKCk7IHJldHVybjsgfVxuICAkKFwiZW1wdHlcIikuaGlkZGVuID0gdHJ1ZTtcbiAgaWYgKCFyb3cpIHtcbiAgICByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIHJvdy5pZCA9IFwiY2FwdGlvblwiO1xuICAgIHJvdy5jbGFzc05hbWUgPSBcImxpbmUgdXNlciBjYXB0aW9uXCI7XG4gICAgcm93LmlubmVySFRNTCA9IGA8c3BhbiBjbGFzcz1cIndob1wiPllvdTwvc3Bhbj48c3BhbiBjbGFzcz1cInRleHRcIj48L3NwYW4+YDtcbiAgICBwYW5lLnByZXBlbmQocm93KTtcbiAgfVxuICByb3cucXVlcnlTZWxlY3RvcihcIi50ZXh0XCIpIS50ZXh0Q29udGVudCA9IHRleHQ7XG4gIHNjcm9sbERvd24odHJ1ZSk7XG59XG5cbmZ1bmN0aW9uIG5vdGUodGV4dDogc3RyaW5nKSB7XG4gICQoXCJlbXB0eVwiKS5oaWRkZW4gPSB0cnVlO1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gXCJsaW5lIG5vdGVcIjtcbiAgcm93LnRleHRDb250ZW50ID0gdGV4dDtcbiAgJChcInRyYW5zY3JpcHRcIikuYXBwZW5kKHJvdyk7XG4gIG9wZW5MaW5lID0gbnVsbDtcbiAgc2Nyb2xsRG93bigpO1xufVxuXG5mdW5jdGlvbiByZXN1bHQoYWdlbnQ6IHN0cmluZywgbGFiZWw6IHN0cmluZywgdGV4dDogc3RyaW5nLCBmYWlsZWQgPSBmYWxzZSk6IEhUTUxFbGVtZW50IHtcbiAgJChcImVtcHR5XCIpLmhpZGRlbiA9IHRydWU7XG4gIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvdy5jbGFzc05hbWUgPSBgbGluZSByZXN1bHQgJHthZ2VudCA9PT0gXCJ0M1wiID8gXCJ0M1wiIDogXCJcIn0gJHtmYWlsZWQgPyBcImZhaWxlZFwiIDogXCJcIn1gLnRyaW0oKTtcbiAgY29uc3Qgd2hvID0gYWdlbnQgPT09IFwidDNcIiA/IFwiVDNcIiA6IFwiSGVybWVzXCI7XG4gIHJvdy5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz1cIndob1wiPjxzcGFuIGNsYXNzPVwicmVzLXRpdGxlXCI+PHNwYW4gY2xhc3M9XCJiYWRnZSAke2FnZW50ID09PSBcInQzXCIgPyBcInQzXCIgOiBcIlwifVwiPiR7d2hvfTwvc3Bhbj48c3BhbiBjbGFzcz1cInJlcy1sYWJlbFwiPiR7ZXNjYXBlSHRtbChsYWJlbCl9PC9zcGFuPjwvc3Bhbj48c3BhbiBjbGFzcz1cInJlcy1waWxsXCI+JHtmYWlsZWQgPyBcIkZhaWxlZFwiIDogXCJSZXN1bHRcIn08L3NwYW4+PC9kaXY+PGRpdiBjbGFzcz1cImJvZHlcIj4ke21hcmtkb3duKHRleHQpfTwvZGl2PmA7XG4gICQoXCJ0cmFuc2NyaXB0XCIpLmFwcGVuZChyb3cpO1xuICBvcGVuTGluZSA9IG51bGw7XG4gIGNvbnN0IGJvZHkgPSByb3cucXVlcnlTZWxlY3RvcihcIi5ib2R5XCIpIGFzIEhUTUxFbGVtZW50O1xuICByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKCkgPT4ge1xuICAgIGlmIChib2R5LnNjcm9sbEhlaWdodCA+IGJvZHkuY2xpZW50SGVpZ2h0ICsgNCkge1xuICAgICAgcm93LmNsYXNzTGlzdC5hZGQoXCJjbGFtcGVkXCIpO1xuICAgICAgY29uc3QgbW9yZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gICAgICBtb3JlLmNsYXNzTmFtZSA9IFwibW9yZVwiO1xuICAgICAgbW9yZS50eXBlID0gXCJidXR0b25cIjtcbiAgICAgIG1vcmUudGV4dENvbnRlbnQgPSBcIlNob3cgZnVsbCByZXN1bHRcIjtcbiAgICAgIG1vcmUub25jbGljayA9ICgpID0+IHsgcm93LmNsYXNzTGlzdC50b2dnbGUoXCJvcGVuXCIpOyBtb3JlLnRleHRDb250ZW50ID0gcm93LmNsYXNzTGlzdC5jb250YWlucyhcIm9wZW5cIikgPyBcIlNob3cgbGVzc1wiIDogXCJTaG93IGZ1bGwgcmVzdWx0XCI7IH07XG4gICAgICByb3cuYXBwZW5kKG1vcmUpO1xuICAgIH1cbiAgfSk7XG4gIHNjcm9sbERvd24odHJ1ZSk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIGVsYXBzZWQoc2Vjb25kczogbnVtYmVyKTogc3RyaW5nIHtcbiAgaWYgKHNlY29uZHMgPCA2MCkgcmV0dXJuIGAke01hdGguZmxvb3Ioc2Vjb25kcyl9c2A7XG4gIGNvbnN0IG0gPSBNYXRoLmZsb29yKHNlY29uZHMgLyA2MCk7XG4gIHJldHVybiBtIDwgNjAgPyBgJHttfW0gJHtNYXRoLmZsb29yKHNlY29uZHMgJSA2MCl9c2AgOiBgJHtNYXRoLmZsb29yKG0gLyA2MCl9aCAke20gJSA2MH1tYDtcbn1cblxuLyoqIFRoZSBlbXB0eSB0YXNrIGxpc3QncyB3b3Jkcywga2VwdCB0byBwdXQgYmFjay4gKi9cbmNvbnN0IG5vVGFza3MgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcIm5vdGFza3NcIikhO1xuXG4vKiogV2hldGhlciBhIHRhc2sgc3RpbGwgd2FudHMgdGhlIHNjcmVlbjogaXQncyB3b3JraW5nLCBvciBpdCB3YWl0cyBmb3IgdGhlIHVzZXIuIFRoZSByZXN0IGZvbGQgYXdheSB1bmRlciBGaW5pc2hlZC4gKi9cbmNvbnN0IGxpdmUgPSAoc3RhdGU6IHN0cmluZykgPT4gc3RhdGUgPT09IFwicnVubmluZ1wiIHx8IHN0YXRlLnN0YXJ0c1dpdGgoXCJ3YWl0aW5nXCIpO1xuXG5mdW5jdGlvbiB1cGRhdGVUYXNrQ2hyb21lKCkge1xuICBjb25zdCBhbGwgPSBbLi4udGFza3MudmFsdWVzKCldO1xuICBjb25zdCBhY3RpdmVDdXJyZW50ID0gYWxsLmZpbHRlcigodCkgPT4gbGl2ZSh0LmMuc3RhdGUpIHx8IEJvb2xlYW4odC5hcHByb3ZhbCkpLmxlbmd0aDtcbiAgY29uc3Qgd2FpdGluZyA9IGFsbC5maWx0ZXIoKHQpID0+IHQuYy5zdGF0ZS5zdGFydHNXaXRoKFwid2FpdGluZ1wiKSB8fCBCb29sZWFuKHQuYXBwcm92YWwpKS5sZW5ndGg7XG4gIGNvbnN0IGFjdGl2ZVRvdGFsID0gYWN0aXZlQ3VycmVudCArIGVhcmxpZXJBY3RpdmVDb3VudDtcbiAgY29uc3QgYXR0ZW50aW9uVG90YWwgPSB3YWl0aW5nICsgZWFybGllcldhaXRpbmdDb3VudDtcblxuICBjb25zdCBiYWRnZSA9ICQoXCJ0YXNrcy1iYWRnZVwiKTtcbiAgYmFkZ2UuaGlkZGVuID0gYWN0aXZlVG90YWwgPT09IDA7XG4gIGJhZGdlLnRleHRDb250ZW50ID0gU3RyaW5nKGFjdGl2ZVRvdGFsKTtcbiAgYmFkZ2UuY2xhc3NMaXN0LnRvZ2dsZShcIndhcm5cIiwgYXR0ZW50aW9uVG90YWwgPiAwKTtcblxuICBjb25zdCBiYXIgPSAkKFwibW9iaWxlLXRhc2tzLWJhclwiKTtcbiAgY29uc3Qgc2hvd0JhciA9IGFjdGl2ZVRvdGFsID4gMDtcbiAgYmFyLmhpZGRlbiA9ICFzaG93QmFyO1xuICBiYXIuY2xhc3NMaXN0LnRvZ2dsZShcInZpc2libGVcIiwgc2hvd0Jhcik7XG4gIGJhci5jbGFzc0xpc3QudG9nZ2xlKFwid2FyblwiLCBhdHRlbnRpb25Ub3RhbCA+IDApO1xuICBpZiAoc2hvd0Jhcikge1xuICAgIGNvbnN0IGFwcHJvdmFsID0gYWxsLmZpbmQoKHQpID0+IHQuYXBwcm92YWwpO1xuICAgIGNvbnN0IGxhYmVsID0gYXBwcm92YWxcbiAgICAgID8gYEFwcHJvdmFsIG5lZWRlZDogJHthcHByb3ZhbC5jLmxhYmVsfWBcbiAgICAgIDogYXR0ZW50aW9uVG90YWwgPiAwXG4gICAgICAgID8gYCR7YXR0ZW50aW9uVG90YWx9IHRhc2ske2F0dGVudGlvblRvdGFsID4gMSA/IFwic1wiIDogXCJcIn0gd2FpdGluZyBmb3IgeW91YFxuICAgICAgICA6IGAke2FjdGl2ZVRvdGFsfSBhY3RpdmUgdGFzayR7YWN0aXZlVG90YWwgPiAxID8gXCJzXCIgOiBcIlwifWA7XG4gICAgJChcIm10Yi10ZXh0XCIpLnRleHRDb250ZW50ID0gbGFiZWw7XG4gIH1cbn1cblxuLyoqIFRoZSBGaW5pc2hlZCBmb2xkJ3MgY291bnQsIGFuZCB0aGUgZm9sZCBpdHNlbGYgb25seSB3aGVuIHNvbWV0aGluZyBpcyBpbiBpdC4gKi9cbmZ1bmN0aW9uIHNob3dEb25lKCkge1xuICBjb25zdCBuID0gJChcImRvbmVub3dcIikuY2hpbGRFbGVtZW50Q291bnQgKyAkKFwiZG9uZWVhcmxpZXJcIikuY2hpbGRFbGVtZW50Q291bnQ7XG4gICQoXCJkb25lYm94XCIpLmhpZGRlbiA9IG4gPT09IDA7XG4gICQoXCJkb25lY291bnRcIikudGV4dENvbnRlbnQgPSBuID4gMCA/IGBcdTAwQjcgJHtufWAgOiBcIlwiO1xufVxuXG5mdW5jdGlvbiBzaG93VGFza3MoZm9yY2UgPSBmYWxzZSkge1xuICBjb25zdCBwYW5lID0gJChcInRhc2tzXCIpO1xuICBjb25zdCBkb25lID0gJChcImRvbmVub3dcIik7XG4gIGNvbnN0IG9wZW4gPSBkb2N1bWVudC5hY3RpdmVFbGVtZW50Py5jbG9zZXN0Py4oXCIudGFza1wiKSBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gIGlmICghZm9yY2UgJiYgb3BlbiAmJiAocGFuZS5jb250YWlucyhvcGVuKSB8fCBkb25lLmNvbnRhaW5zKG9wZW4pKSAmJiBvcGVuLnF1ZXJ5U2VsZWN0b3IoXCJmb3JtXCIpKSByZXR1cm47IC8vIGRvbid0IHJlZHJhdyB1bmRlciBzb21lb25lIHR5cGluZyBhIGZvbGxvdy11cFxuICBwYW5lLmlubmVySFRNTCA9IFwiXCI7XG4gIGRvbmUuaW5uZXJIVE1MID0gXCJcIjtcbiAgY29uc3QgYWxsID0gWy4uLnRhc2tzLnZhbHVlcygpXS5yZXZlcnNlKCk7XG4gIGlmIChhbGwubGVuZ3RoID09PSAwKSB7XG4gICAgcGFuZS5hcHBlbmQobm9UYXNrcyk7XG4gICAgJChcInRhc2tjb3VudFwiKS50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgJChcImNhbmNlbGFsbFwiKS5oaWRkZW4gPSB0cnVlO1xuICAgIHNob3dEb25lKCk7XG4gICAgdXBkYXRlVGFza0Nocm9tZSgpO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBydW5uaW5nID0gYWxsLmZpbHRlcigodCkgPT4gdC5jLnN0YXRlID09PSBcInJ1bm5pbmdcIikubGVuZ3RoO1xuICBjb25zdCBhY3RpdmVDb3VudCA9IGFsbC5maWx0ZXIoKHQpID0+IGxpdmUodC5jLnN0YXRlKSkubGVuZ3RoO1xuICAkKFwidGFza2NvdW50XCIpLnRleHRDb250ZW50ID0gcnVubmluZyA+IDAgPyBgJHtydW5uaW5nfSBydW5uaW5nYCA6IGFjdGl2ZUNvdW50ID4gMCA/IGAke2FjdGl2ZUNvdW50fSB3YWl0aW5nYCA6IFwiXCI7XG4gICQoXCJjYW5jZWxhbGxcIikuaGlkZGVuID0gIWNhbGxJZCB8fCBydW5uaW5nIDwgMjtcbiAgZm9yIChjb25zdCB2aWV3IG9mIGFsbCkge1xuICAgIGNvbnN0IHQgPSB2aWV3LmM7XG4gICAgY29uc3Qgd2FpdGluZyA9IHQuc3RhdGUuc3RhcnRzV2l0aChcIndhaXRpbmdcIik7XG4gICAgY29uc3QgY2FyZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgY2FyZC5jbGFzc05hbWUgPSBgdGFzayAke3dhaXRpbmcgPyBcIndhaXRpbmdcIiA6IHQuc3RhdGV9YDtcbiAgICBjb25zdCBhZ2UgPSAodmlldy5lbmRlZCA/PyBub3coKSkgLSB2aWV3LnNpbmNlO1xuICAgIGNhcmQuaW5uZXJIVE1MID1cbiAgICAgIGA8ZGl2IGNsYXNzPVwibWV0YS1yb3dcIj5gICtcbiAgICAgICAgYDxzcGFuIGNsYXNzPVwiYmFkZ2UgJHt0LmFnZW50ID09PSBcInQzXCIgPyBcInQzXCIgOiBcIlwifVwiPiR7dC5hZ2VudCA9PT0gXCJ0M1wiID8gXCJUM1wiIDogXCJIZXJtZXNcIn08L3NwYW4+YCArXG4gICAgICAgIGA8c3BhbiBjbGFzcz1cInN0YXRlXCI+JHt0LnN0YXRlID09PSBcInJ1bm5pbmdcIiA/ICc8c3BhbiBjbGFzcz1cInNwaW5cIj48L3NwYW4+JyA6IFwiXCJ9JHtlc2NhcGVIdG1sKHQuc3RhdGUpfTwvc3Bhbj5gICtcbiAgICAgICAgYDxzcGFuIGNsYXNzPVwiYWdlXCI+JHtlbGFwc2VkKGFnZSl9PC9zcGFuPmAgK1xuICAgICAgYDwvZGl2PmAgK1xuICAgICAgYDxkaXYgY2xhc3M9XCJsYWJlbFwiPjwvZGl2PmAgK1xuICAgICAgYDxkaXYgY2xhc3M9XCJwXCI+PC9kaXY+YDtcbiAgICBjYXJkLnF1ZXJ5U2VsZWN0b3IoXCIubGFiZWxcIikhLnRleHRDb250ZW50ID0gdC5sYWJlbDtcbiAgICBjYXJkLnF1ZXJ5U2VsZWN0b3IoXCIucFwiKSEudGV4dENvbnRlbnQgPSB0LnByb2dyZXNzID8/IHQucmVxdWVzdDtcbiAgICBpZiAodC5xdWVzdGlvbikge1xuICAgICAgY29uc3QgcSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICBxLmNsYXNzTmFtZSA9IFwicVwiO1xuICAgICAgcS50ZXh0Q29udGVudCA9IGBBc2tzOiAke3QucXVlc3Rpb259YDtcbiAgICAgIGNhcmQuYXBwZW5kKHEpO1xuICAgIH1cbiAgICBpZiAodmlldy5hcHByb3ZhbCAmJiB0LnN0YXRlID09PSBcInJ1bm5pbmdcIikge1xuICAgICAgY29uc3QgYm94ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgIGJveC5jbGFzc05hbWUgPSBcImFwcHJvdmFsXCI7XG4gICAgICBib3guaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9XCJhcHByb3ZhbC1oZWFkXCI+SGVybWVzIGFza3MgdG8gcnVuPC9kaXY+PGNvZGU+PC9jb2RlPjxkaXYgY2xhc3M9XCJhY3RzXCI+PC9kaXY+YDtcbiAgICAgIGJveC5xdWVyeVNlbGVjdG9yKFwiY29kZVwiKSEudGV4dENvbnRlbnQgPSB2aWV3LmFwcHJvdmFsLmNvbW1hbmQ7XG4gICAgICBjb25zdCBhbnN3ZXIgPSAoY2hvaWNlOiBcIm9uY2VcIiB8IFwiZGVueVwiKSA9PiB7XG4gICAgICAgIHZpZXcuYXBwcm92YWwgPSB1bmRlZmluZWQ7XG4gICAgICAgIHNob3dUYXNrcyh0cnVlKTtcbiAgICAgICAgdm9pZCBmZXRjaChcIi9oZXJtZXMvYXBwcm92YWxcIiwgeyBtZXRob2Q6IFwiUE9TVFwiLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGNhbGw6IGNhbGxOYW1lLCB0YXNrSWQ6IHQuaWQsIGNob2ljZSB9KSB9KVxuICAgICAgICAgIC50aGVuKChyKSA9PiB0b2FzdChyLm9rID8gKGNob2ljZSA9PT0gXCJvbmNlXCIgPyBcIkFwcHJvdmVkXCIgOiBcIkRlbmllZFwiKSA6IFwiVGhhdCBhcHByb3ZhbCBoYWQgYWxyZWFkeSBsYXBzZWRcIikpO1xuICAgICAgfTtcbiAgICAgIGZvciAoY29uc3QgW2xhYmVsLCBjaG9pY2VdIG9mIFtbXCJBcHByb3ZlIG9uY2VcIiwgXCJvbmNlXCJdLCBbXCJEZW55XCIsIFwiZGVueVwiXV0gYXMgY29uc3QpIHtcbiAgICAgICAgY29uc3QgYiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gICAgICAgIGIudHlwZSA9IFwiYnV0dG9uXCI7XG4gICAgICAgIGIudGV4dENvbnRlbnQgPSBsYWJlbDtcbiAgICAgICAgaWYgKGNob2ljZSA9PT0gXCJvbmNlXCIpIGIuY2xhc3NOYW1lID0gXCJnb1wiO1xuICAgICAgICBlbHNlIGIuY2xhc3NOYW1lID0gXCJkYW5nZXJcIjtcbiAgICAgICAgYi5vbmNsaWNrID0gKCkgPT4gYW5zd2VyKGNob2ljZSk7XG4gICAgICAgIGJveC5xdWVyeVNlbGVjdG9yKFwiLmFjdHNcIikhLmFwcGVuZChiKTtcbiAgICAgIH1cbiAgICAgIGNhcmQuYXBwZW5kKGJveCk7XG4gICAgfVxuICAgIGlmICh0LnN0YXRlICE9PSBcInJ1bm5pbmdcIikgdmlldy5hcHByb3ZhbCA9IHVuZGVmaW5lZDtcbiAgICBjb25zdCBhY3RzID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBhY3RzLmNsYXNzTmFtZSA9IFwiYWN0c1wiO1xuICAgIGNvbnN0IGJ1dHRvbiA9ICh0ZXh0OiBzdHJpbmcsIGZuOiAoKSA9PiB2b2lkLCBjbHMgPSBcIlwiKSA9PiB7XG4gICAgICBjb25zdCBiID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgICAgIGIudHlwZSA9IFwiYnV0dG9uXCI7XG4gICAgICBiLnRleHRDb250ZW50ID0gdGV4dDtcbiAgICAgIGlmIChjbHMpIGIuY2xhc3NOYW1lID0gY2xzO1xuICAgICAgYi5vbmNsaWNrID0gZm47XG4gICAgICBhY3RzLmFwcGVuZChiKTtcbiAgICAgIHJldHVybiBiO1xuICAgIH07XG4gICAgaWYgKGNhbGxJZCkge1xuICAgICAgYnV0dG9uKHdhaXRpbmcgPyBcIkFuc3dlclwiIDogXCJGb2xsb3cgdXBcIiwgKCkgPT4gZm9sbG93VXBGb3JtKGNhcmQsIHQpKTtcbiAgICAgIGlmICh0LnN0YXRlID09PSBcInJ1bm5pbmdcIikgYnV0dG9uKFwiQ2FuY2VsXCIsICgpID0+IHB1c2goeyB0eXBlOiBcImNhbmNlbFRhc2tcIiwgdGFzazogdC5pZCB9KSwgXCJkYW5nZXJcIik7XG4gICAgfVxuICAgIGlmICh2aWV3LnJlc3VsdCkgYnV0dG9uKFwiUmVzdWx0XCIsICgpID0+IHsgc2V0VGFza3NPcGVuKGZhbHNlKTsgdmlldy5yZXN1bHQhLnNjcm9sbEludG9WaWV3KHsgYmVoYXZpb3I6IFwic21vb3RoXCIsIGJsb2NrOiBcImNlbnRlclwiIH0pOyB2aWV3LnJlc3VsdCEuY2xhc3NMaXN0LmFkZChcIm9wZW5cIik7IH0pO1xuICAgIGlmICh2aWV3LnRocmVhZCkgYnV0dG9uKFwiQ29weSB0aHJlYWQgaWRcIiwgKCkgPT4geyB2b2lkIG5hdmlnYXRvci5jbGlwYm9hcmQ/LndyaXRlVGV4dCh2aWV3LnRocmVhZCEpOyB0b2FzdChcIlRocmVhZCBpZCBjb3BpZWRcIik7IH0pO1xuICAgIGlmIChhY3RzLmNoaWxkRWxlbWVudENvdW50KSBjYXJkLmFwcGVuZChhY3RzKTtcbiAgICAobGl2ZSh0LnN0YXRlKSA/IHBhbmUgOiBkb25lKS5hcHBlbmQoY2FyZCk7XG4gIH1cbiAgaWYgKHBhbmUuY2hpbGRFbGVtZW50Q291bnQgPT09IDApIHBhbmUuYXBwZW5kKG5vVGFza3MpO1xuICBzaG93RG9uZSgpO1xuICB1cGRhdGVUYXNrQ2hyb21lKCk7XG59XG5cbmZ1bmN0aW9uIGZvbGxvd1VwRm9ybShjYXJkOiBIVE1MRWxlbWVudCwgdDogQ29tbWFuZCkge1xuICBpZiAoY2FyZC5xdWVyeVNlbGVjdG9yKFwiZm9ybVwiKSkgcmV0dXJuO1xuICBjb25zdCBmb3JtID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImZvcm1cIik7XG4gIGZvcm0uaW5uZXJIVE1MID0gYDxpbnB1dCB0eXBlPVwidGV4dFwiIHBsYWNlaG9sZGVyPVwiVGVsbCBcdTIwMUMke2VzY2FwZUh0bWwodC5sYWJlbCl9XHUyMDFEXHUyMDI2XCIgZW50ZXJrZXloaW50PVwic2VuZFwiPjxidXR0b24gdHlwZT1cInN1Ym1pdFwiPlNlbmQ8L2J1dHRvbj5gO1xuICBjb25zdCBpbnB1dCA9IGZvcm0ucXVlcnlTZWxlY3RvcihcImlucHV0XCIpITtcbiAgZm9ybS5vbnN1Ym1pdCA9IChlKSA9PiB7XG4gICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGNvbnN0IHRleHQgPSBpbnB1dC52YWx1ZS50cmltKCk7XG4gICAgaWYgKHRleHQpIHsgcHVzaCh7IHR5cGU6IFwic3RlZXJcIiwgdGFzazogdC5pZCwgdGV4dCB9KTsgbm90ZShgWW91IFx1MjE5MiAke3QubGFiZWx9OiAke3RleHR9YCk7IH1cbiAgICBpbnB1dC5ibHVyKCk7XG4gICAgZm9ybS5yZW1vdmUoKTtcbiAgICBzaG93VGFza3MoKTtcbiAgfTtcbiAgaW5wdXQub25rZXlkb3duID0gKGUpID0+IHsgaWYgKGUua2V5ID09PSBcIkVzY2FwZVwiKSB7IGlucHV0LmJsdXIoKTsgZm9ybS5yZW1vdmUoKTsgc2hvd1Rhc2tzKCk7IH0gfTtcbiAgY2FyZC5hcHBlbmQoZm9ybSk7XG4gIGlucHV0LmZvY3VzKCk7XG59XG5cbi8qKiBUMyB0aHJlYWRzIGVhcmxpZXIgY2FsbHMgc3RhcnRlZDogdGhleSBjYXJyeSBvbiBhZnRlciBhIGNhbGwsIHNvIHRoZSBwYW5lbCBzYXlzIGhvdyB0aGV5J3JlIGRvaW5nLiAqL1xuYXN5bmMgZnVuY3Rpb24gc2hvd0VhcmxpZXIoKSB7XG4gIGxldCBsaXN0OiB7IHRocmVhZDogc3RyaW5nOyB0aXRsZTogc3RyaW5nOyBzdGF0dXM6IHN0cmluZzsgYnJhbmNoOiBzdHJpbmcgfCBudWxsOyBwcjogc3RyaW5nIHwgbnVsbDsgdXBkYXRlZDogc3RyaW5nOyBsYXN0OiBzdHJpbmc7IHdhaXRpbmc6IGJvb2xlYW4gfVtdID0gW107XG4gIHRyeSB7IGxpc3QgPSBhd2FpdCAoYXdhaXQgZmV0Y2goXCIvYWdlbnQvcmVjZW50XCIsIHsgY2FjaGU6IFwibm8tc3RvcmVcIiB9KSkuanNvbigpOyB9IGNhdGNoIHt9XG4gIGNvbnN0IGN1cnJlbnQgPSBuZXcgU2V0KFsuLi50YXNrcy52YWx1ZXMoKV0ubWFwKCh2KSA9PiB2LnRocmVhZCkuZmlsdGVyKEJvb2xlYW4pKTtcbiAgbGlzdCA9IGxpc3QuZmlsdGVyKCh0KSA9PiAhY3VycmVudC5oYXModC50aHJlYWQpKTtcbiAgY29uc3QgcGFuZSA9ICQoXCJlYXJsaWVyXCIpO1xuICBjb25zdCBkb25lID0gJChcImRvbmVlYXJsaWVyXCIpO1xuICBwYW5lLmlubmVySFRNTCA9IFwiXCI7XG4gIGRvbmUuaW5uZXJIVE1MID0gXCJcIjtcbiAgZWFybGllckFjdGl2ZUNvdW50ID0gMDtcbiAgZWFybGllcldhaXRpbmdDb3VudCA9IDA7XG4gIGZvciAoY29uc3QgdCBvZiBsaXN0KSB7XG4gICAgY29uc3QgY2FyZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgY29uc3Qgc3RhdGUgPSB0LndhaXRpbmcgPyBcIndhaXRpbmcgZm9yIGFwcHJvdmFsIGluIFQzXCIgOiB0LnN0YXR1cztcbiAgICBjYXJkLmNsYXNzTmFtZSA9IGB0YXNrICR7dC5zdGF0dXMgPT09IFwicnVubmluZ1wiID8gXCJydW5uaW5nXCIgOiB0LndhaXRpbmcgPyBcIndhaXRpbmdcIiA6IFwiZmluaXNoZWRcIn1gO1xuICAgIGNvbnN0IGFnbyA9IE1hdGgubWF4KDAsIChEYXRlLm5vdygpIC0gRGF0ZS5wYXJzZSh0LnVwZGF0ZWQpKSAvIDEwMDApO1xuICAgIGNhcmQuaW5uZXJIVE1MID1cbiAgICAgIGA8ZGl2IGNsYXNzPVwibWV0YS1yb3dcIj5gICtcbiAgICAgICAgYDxzcGFuIGNsYXNzPVwiYmFkZ2UgdDNcIj5UMzwvc3Bhbj5gICtcbiAgICAgICAgYDxzcGFuIGNsYXNzPVwic3RhdGVcIj4ke3Quc3RhdHVzID09PSBcInJ1bm5pbmdcIiA/ICc8c3BhbiBjbGFzcz1cInNwaW5cIj48L3NwYW4+JyA6IFwiXCJ9JHtlc2NhcGVIdG1sKHN0YXRlKX08L3NwYW4+YCArXG4gICAgICAgIGA8c3BhbiBjbGFzcz1cImFnZVwiPiR7ZWxhcHNlZChhZ28pfSBhZ288L3NwYW4+YCArXG4gICAgICBgPC9kaXY+YCArXG4gICAgICBgPGRpdiBjbGFzcz1cImxhYmVsXCI+PC9kaXY+YCArXG4gICAgICBgPGRpdiBjbGFzcz1cInBcIj48L2Rpdj5gO1xuICAgIGNhcmQucXVlcnlTZWxlY3RvcihcIi5sYWJlbFwiKSEudGV4dENvbnRlbnQgPSB0LnRpdGxlO1xuICAgIGNhcmQucXVlcnlTZWxlY3RvcihcIi5wXCIpIS50ZXh0Q29udGVudCA9IHQubGFzdCB8fCAodC5icmFuY2ggPyBgT24gJHt0LmJyYW5jaH1gIDogXCJcIik7XG4gICAgY29uc3QgYWN0cyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgYWN0cy5jbGFzc05hbWUgPSBcImFjdHNcIjtcbiAgICBpZiAodC5wcikgeyBjb25zdCBhID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImFcIik7IGEuaHJlZiA9IHQucHI7IGEudGFyZ2V0ID0gXCJfYmxhbmtcIjsgYS5yZWwgPSBcIm5vb3BlbmVyXCI7IGEudGV4dENvbnRlbnQgPSBcIlB1bGwgcmVxdWVzdCBcdTIxOTdcIjsgYWN0cy5hcHBlbmQoYSk7IH1cbiAgICBjb25zdCBjb3B5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgICBjb3B5LnR5cGUgPSBcImJ1dHRvblwiO1xuICAgIGNvcHkudGV4dENvbnRlbnQgPSBcIkNvcHkgdGhyZWFkIGlkXCI7XG4gICAgY29weS5vbmNsaWNrID0gKCkgPT4geyB2b2lkIG5hdmlnYXRvci5jbGlwYm9hcmQ/LndyaXRlVGV4dCh0LnRocmVhZCk7IHRvYXN0KFwiVGhyZWFkIGlkIGNvcGllZFwiKTsgfTtcbiAgICBhY3RzLmFwcGVuZChjb3B5KTtcbiAgICBjYXJkLmFwcGVuZChhY3RzKTtcbiAgICBjb25zdCBhY3RpdmUgPSB0LnN0YXR1cyA9PT0gXCJydW5uaW5nXCIgfHwgdC53YWl0aW5nO1xuICAgIGlmIChhY3RpdmUpIGVhcmxpZXJBY3RpdmVDb3VudCsrO1xuICAgIGlmICh0LndhaXRpbmcpIGVhcmxpZXJXYWl0aW5nQ291bnQrKztcbiAgICAoYWN0aXZlID8gcGFuZSA6IGRvbmUpLmFwcGVuZChjYXJkKTtcbiAgfVxuICAkKFwiZWFybGllcmJveFwiKS5oaWRkZW4gPSBwYW5lLmNoaWxkRWxlbWVudENvdW50ID09PSAwO1xuICBzaG93RG9uZSgpO1xuICB1cGRhdGVUYXNrQ2hyb21lKCk7XG59XG5cbmNvbnN0IFNUQVRVU19URVhUOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICBpZGxlOiBcIklkbGVcIiwgY29ubmVjdGluZzogXCJDb25uZWN0aW5nXHUyMDI2XCIsIGxpc3RlbmluZzogXCJMaXN0ZW5pbmdcIiwgd29ya2luZzogXCJMaXN0ZW5pbmcgXHUwMEI3IHRhc2tzIHJ1bm5pbmdcIixcbiAgc3RhbmRieTogXCJQYXVzZWQgd2hpbGUgdGFza3MgcnVuIFx1MDBCNyBzcGVhayB0byByZXN1bWVcIiwgd2FraW5nOiBcIlJlc3VtaW5nXHUyMDI2XCIsIGVuZGVkOiBcIkVuZGVkXCIsXG59O1xuXG5mdW5jdGlvbiBzaG93U3RhdHVzKG1lc3NhZ2U/OiBzdHJpbmcpIHtcbiAgY29uc3QgdHlwZWQgPSBCb29sZWFuKGNhbGxJZCkgJiYgbWVkaXVtID09PSBcInRleHRcIjtcbiAgY29uc3Qgc3BlYWtpbmcgPSBCb29sZWFuKGNhbGxJZCkgJiYgIXR5cGVkICYmIGNvcmVTdGF0dXMgIT09IFwic3RhbmRieVwiICYmIGF1ZGlvLnF1ZXVlZCA+IDAuMDU7XG4gIGNvbnN0IHNob3duID0gc3BlYWtpbmcgfHwgKHR5cGVkICYmIHRoaW5raW5nKSA/IFwic3BlYWtpbmdcIiA6IGNvcmVTdGF0dXM7XG4gICQoXCJzdGF0dXNcIikuY2xhc3NOYW1lID0gc2hvd247XG4gIGRvY3VtZW50LmJvZHkuZGF0YXNldC5zdGF0ZSA9IGNhbGxJZCA/IHNob3duIDogXCJpZGxlXCI7XG4gIGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LnRvZ2dsZShcImluLXNlc3Npb25cIiwgQm9vbGVhbihjYWxsSWQpKTtcbiAgbGV0IHRleHQgPSBzcGVha2luZyA/IFwiU3BlYWtpbmdcIiA6IFNUQVRVU19URVhUW2NvcmVTdGF0dXNdID8/IGNvcmVTdGF0dXM7XG4gIGlmICh0eXBlZCAmJiBjb3JlU3RhdHVzICE9PSBcImVuZGVkXCIpIHRleHQgPSB0aGlua2luZyA/IFwiV3JpdGluZ1x1MjAyNlwiIDogY29yZVN0YXR1cyA9PT0gXCJ3b3JraW5nXCIgPyBcIkNoYXQgXHUwMEI3IHRhc2tzIHJ1bm5pbmdcIiA6IFwiQ2hhdFwiO1xuICBpZiAoY2FsbElkICYmICF0eXBlZCAmJiBtdXRlZCAmJiAhaG9sZGluZyAmJiAhc3BlYWtpbmcpIHRleHQgKz0gXCIgXHUwMEI3IG11dGVkXCI7XG4gIGlmIChob2xkaW5nKSB0ZXh0ID0gXCJUYWxraW5nIChob2xkKVwiO1xuICBpZiAobWVzc2FnZSkgdGV4dCA9IGAke3RleHR9OiAke21lc3NhZ2V9YDtcbiAgaWYgKGNvcmVTdGF0dXMgIT09IFwiZW5kZWRcIiB8fCBtZXNzYWdlKSAkKFwic3RhdHVzdGV4dFwiKS50ZXh0Q29udGVudCA9IHRleHQ7XG4gICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiaHVzaFwiKS5jbGFzc0xpc3QudG9nZ2xlKFwibGl2ZVwiLCBzcGVha2luZyB8fCAodHlwZWQgJiYgdGhpbmtpbmcpKTtcblxuICBjb25zdCBiYXIgPSAkKFwiY2FsbGJhclwiKTtcbiAgYmFyLmhpZGRlbiA9ICFjYWxsSWQ7XG4gIGlmIChjYWxsSWQpIHtcbiAgICAkKFwiY2FsbGJhci1zdGF0ZVwiKS50ZXh0Q29udGVudCA9IHRleHQ7XG4gICAgJChcImNhbGx0aW1lclwiKS5oaWRkZW4gPSB0eXBlZDtcbiAgICBpZiAoIXR5cGVkKSAkKFwiY2FsbHRpbWVyXCIpLnRleHRDb250ZW50ID0gZm9ybWF0Q2xvY2sobm93KCkgLSBzdGFydGVkQXQpO1xuICAgIGNvbnN0IHZpek1vZGUgPSB0eXBlZCA/ICh0aGlua2luZyA/IFwidGhpbmtpbmdcIiA6IFwiaWRsZVwiKVxuICAgICAgOiBzcGVha2luZyA/IFwic3BlYWtpbmdcIlxuICAgICAgOiBtdXRlZCAmJiAhaG9sZGluZyA/IFwibXV0ZWRcIlxuICAgICAgOiBzaG93bjtcbiAgICB1cGRhdGVWaXN1YWxpemVyKHZpek1vZGUsIG11dGVkICYmICFob2xkaW5nID8gMCA6IGF1ZGlvLmxldmVsKTtcbiAgfVxufVxuXG4vLyBUaGUgY2FsbC5cblxuZnVuY3Rpb24gcHVzaChldmVudDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIHtcbiAgaWYgKCFjb3JlIHx8ICFjYWxsSWQpIHJldHVybjtcbiAgY29uc3QgZTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7IC4uLmV2ZW50LCB0OiBub3coKSB9O1xuICBjb25zdCBxdWlldCA9IGUudHlwZSA9PT0gXCJtaWNcIiB8fCBlLnR5cGUgPT09IFwidGlja1wiO1xuICBpZiAoIXF1aWV0KSBsb2coXCJpblwiLCBlLnR5cGUgPT09IFwid3MubWVzc2FnZVwiID8gYHdzICR7ZS5zaWR9IFx1MjE5MCAke2JyaWVmKFN0cmluZyhlLmRhdGEpKX1gIDogSlNPTi5zdHJpbmdpZnkoZSkuc2xpY2UoMCwgNDAwKSwgXCJpblwiKTtcbiAgcnVuKEpTT04ucGFyc2UoY29yZS5wdXNoKGNhbGxJZCwgSlNPTi5zdHJpbmdpZnkoZSkpKSk7XG59XG5cbmZ1bmN0aW9uIHJ1bihjb21tYW5kczogQ29tbWFuZFtdKSB7XG4gIGZvciAoY29uc3QgYyBvZiBjb21tYW5kcykge1xuICAgIHN3aXRjaCAoYy50eXBlKSB7XG4gICAgICBjYXNlIFwid3MuY29ubmVjdFwiOiBjb25uZWN0KGMuc2lkLCBjLnB1cnBvc2UgPT09IFwiY2FwdGlvbnNcIik7IGJyZWFrO1xuICAgICAgY2FzZSBcIndzLnNlbmRcIjoge1xuICAgICAgICBzb2NrZXRzLmdldChjLnNpZCk/LnNlbmQoYy5kYXRhKTtcbiAgICAgICAgaWYgKCFjLmRhdGEuc3RhcnRzV2l0aCgne1wicmVhbHRpbWVJbnB1dFwiOntcImF1ZGlvXCInKSkgbG9nKFwib3V0XCIsIGB3cyAke2Muc2lkfSBcdTIxOTIgJHticmllZihjLmRhdGEpfWAsIFwib3V0XCIpO1xuICAgICAgICBlbHNlIGlmICghY2FwdGlvblNvY2tldHMuaGFzKGMuc2lkKSkgY291bnRzLnNlbnQrKztcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwid3MuY2xvc2VcIjogc29ja2V0cy5nZXQoYy5zaWQpPy5jbG9zZSgpOyBzb2NrZXRzLmRlbGV0ZShjLnNpZCk7IGxvZyhcIm91dFwiLCBgd3MgJHtjLnNpZH0gY2xvc2VgLCBcIm91dFwiKTsgYnJlYWs7XG4gICAgICBjYXNlIFwibWljLnN0YXJ0XCI6XG4gICAgICBjYXNlIFwibWljLnJlc3RhcnRcIjpcbiAgICAgICAgbG9nKFwib3V0XCIsIGMudHlwZSwgXCJvdXRcIik7XG4gICAgICAgIHZvaWQgYXVkaW8uc3RhcnRNaWMob25NaWMsIG1pY09wdGlvbnMoKSkuY2F0Y2goKGVycikgPT4geyBsb2coXCJlcnJvclwiLCBgbWljcm9waG9uZTogJHtlcnIubWVzc2FnZX1gLCBcImVyclwiKTsgdG9hc3QoYE1pY3JvcGhvbmU6ICR7ZXJyLm1lc3NhZ2V9YCk7IH0pO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJtaWMuc3RvcFwiOiBhdWRpby5zdG9wTWljKCk7IGJyZWFrO1xuICAgICAgY2FzZSBcInBsYXlcIjoge1xuICAgICAgICBjb25zdCB0ID0gbm93KCk7XG4gICAgICAgIC8vIEEgcmVwbHkgc3RhcnRpbmc6IGZyb20gdGhlIGVuZCBvZiB0aGUgdXNlcidzIHNwZWVjaCB0byBpdHMgZmlyc3Qgc291bmQuXG4gICAgICAgIGlmICghbWV0cmljcy5yZXBsaWVkICYmIGF1ZGlvLnF1ZXVlZCA8IDAuMDUgJiYgdCAtIG1ldHJpY3MubGFzdFBsYXkgPiAwLjYgJiYgbWV0cmljcy5sYXN0Vm9pY2UgPiAwICYmIHQgLSBtZXRyaWNzLmxhc3RWb2ljZSA8IDEwKSB7XG4gICAgICAgICAgbWV0cmljcy5yZXBseS5wdXNoKHQgLSBtZXRyaWNzLmxhc3RWb2ljZSk7XG4gICAgICAgICAgaWYgKG1ldHJpY3MucmVwbHkubGVuZ3RoID4gMjApIG1ldHJpY3MucmVwbHkuc2hpZnQoKTtcbiAgICAgICAgICBtZXRyaWNzLnJlcGxpZWQgPSB0cnVlO1xuICAgICAgICAgIHNob3dNZXRyaWNzKCk7XG4gICAgICAgIH1cbiAgICAgICAgbWV0cmljcy5sYXN0UGxheSA9IHQ7XG4gICAgICAgIGF1ZGlvLnBsYXkoYy5wY20pO1xuICAgICAgICBjb3VudHMucGxheSsrO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJmbHVzaFwiOiBhdWRpby5mbHVzaCgpOyBsb2coXCJvdXRcIiwgXCJmbHVzaFwiLCBcIm91dFwiKTsgYnJlYWs7XG4gICAgICBjYXNlIFwiY3VlXCI6XG4gICAgICAgIGF1ZGlvLmN1ZShjLnBjbSk7XG4gICAgICAgIGxvZyhcIm91dFwiLCBgY3VlICR7Yy5lYXJjb259YCwgXCJvdXRcIik7XG4gICAgICAgIC8vIEEgcmVxdWVzdCB0aGF0IGJlY2FtZSBhIHRhc2sgZ2V0cyBhIHRvbmUsIG5vdCBhIHNwb2tlbiByZXBseTogbm90aGluZyB0byB0aW1lLlxuICAgICAgICBpZiAoYy5lYXJjb24gPT09IFwidGFza1N0YXJ0ZWRcIikgbWV0cmljcy5yZXBsaWVkID0gdHJ1ZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwid2FrZXdvcmRcIjogbG9nKFwib3V0XCIsIGB3YWtlIHdvcmQgJHtjLm9uID8gXCJsaXN0ZW5pbmdcIiA6IFwib2ZmXCJ9YCwgXCJvdXRcIik7IGJyZWFrO1xuICAgICAgY2FzZSBcInRvb2wuY2FsbFwiOiB2b2lkIHRvb2woYyk7IGJyZWFrO1xuICAgICAgY2FzZSBcInRvb2wuY2FuY2VsXCI6IGNhbmNlbFJ1bihjLnJ1biwgYy5yZWFzb24pOyBicmVhaztcbiAgICAgIGNhc2UgXCJ0b29sLnN0ZWVyXCI6IHZvaWQgc3RlZXJSdW4oYyk7IGJyZWFrO1xuICAgICAgY2FzZSBcInN0YXR1c1wiOlxuICAgICAgICBjb3JlU3RhdHVzID0gYy5zdGF0dXM7XG4gICAgICAgIHNob3dTdGF0dXMoYy5zdGF0dXMgPT09IFwiZW5kZWRcIiA/IGMubWVzc2FnZSA/PyB1bmRlZmluZWQgOiB1bmRlZmluZWQpO1xuICAgICAgICBsb2coXCJzdGF0dXNcIiwgYy5zdGF0dXMgKyAoYy5tZXNzYWdlID8gYDogJHtjLm1lc3NhZ2V9YCA6IFwiXCIpLCBcInN0YXR1c1wiKTtcbiAgICAgICAgaWYgKGMuc3RhdHVzID09PSBcImVuZGVkXCIpIHsgaWYgKGMubWVzc2FnZSkgbm90ZShjLm1lc3NhZ2UpOyBlbmQoKTsgfVxuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJsbG0ucmVxdWVzdFwiOiB2b2lkIGdlbmVyYXRlKGMuaWQsIGMuYm9keSk7IGJyZWFrO1xuICAgICAgY2FzZSBcImxsbS5jYW5jZWxcIjogcmVxdWVzdHMuZ2V0KGMuaWQpPy5hYm9ydCgpOyByZXF1ZXN0cy5kZWxldGUoYy5pZCk7IGxvZyhcIm91dFwiLCBgcmVxdWVzdCAke2MuaWR9IGRyb3BwZWRgLCBcIm91dFwiKTsgYnJlYWs7XG4gICAgICBjYXNlIFwidGhpbmtpbmdcIjogdGhpbmtpbmcgPSBjLm9uOyBzaG93U3RhdHVzKCk7IGJyZWFrO1xuICAgICAgY2FzZSBcImVycm9yXCI6IG5vdGUoYy5tZXNzYWdlKTsgbG9nKFwiZXJyb3JcIiwgYy5tZXNzYWdlLCBcImVyclwiKTsgYnJlYWs7XG4gICAgICBjYXNlIFwiY2FwdGlvblwiOiBjYXB0aW9uKGMudGV4dCk7IGJyZWFrO1xuICAgICAgY2FzZSBcInRyYW5zY3JpcHRcIjpcbiAgICAgICAgdHJhbnNjcmlwdChjLnJvbGUsIGMudGV4dCwgYy5saW5lKTtcbiAgICAgICAgcmVtZW1iZXIoYy5yb2xlLCBjLnRleHQsIGMucm9sZSA9PT0gXCJhc3Npc3RhbnRcIiA/IFwiR2VtaW5pXCIgOiB1bmRlZmluZWQsIGxhc3RMaW5lID09PSBjLmxpbmUpO1xuICAgICAgICBsYXN0TGluZSA9IGMubGluZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwidGFza1wiOiB7XG4gICAgICAgIGNvbnN0IHZpZXcgPSB0YXNrcy5nZXQoYy5pZCkgPz8geyBjLCBzaW5jZTogbm93KCksIGVuZGVkOiBudWxsIH07XG4gICAgICAgIGlmIChjLnN0YXRlID09PSBcInJ1bm5pbmdcIiAmJiB2aWV3LmMuc3RhdGUgIT09IFwicnVubmluZ1wiKSB7IHZpZXcuc2luY2UgPSBub3coKTsgdmlldy5lbmRlZCA9IG51bGw7IH1cbiAgICAgICAgaWYgKGMuc3RhdGUgIT09IFwicnVubmluZ1wiICYmIHZpZXcuZW5kZWQgPT0gbnVsbCkgdmlldy5lbmRlZCA9IG5vdygpO1xuICAgICAgICB2aWV3LmMgPSBjO1xuICAgICAgICB0YXNrcy5zZXQoYy5pZCwgdmlldyk7XG4gICAgICAgIHNob3dUYXNrcygpO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJxdWVzdGlvbnNcIjogYnJlYWs7XG4gICAgICBjYXNlIFwibWljU2lsZW50XCI6ICQoXCJtaWN3YXJuXCIpLmhpZGRlbiA9ICFjLnNpbGVudDsgYnJlYWs7XG4gICAgICBjYXNlIFwidm9pY2VDb21tYW5kXCI6XG4gICAgICAgIHRvYXN0KGBIZWFyZCBcdTIwMUMke2MuaGVhcmR9XHUyMDFEOiAke2MuY29tbWFuZCA9PT0gXCJzdG9wXCIgPyBcInN0b3BwZWRcIiA6IGMuY29tbWFuZCA9PT0gXCJjYW5jZWxBbGxcIiA/IFwiY2FuY2VsbGluZyBldmVyeSB0YXNrXCIgOiBcImhhbmdpbmcgdXBcIn1gKTtcbiAgICAgICAgbG9nKFwib3V0XCIsIGB2b2ljZSBjb21tYW5kICR7Yy5jb21tYW5kfTogJHtjLmhlYXJkfWAsIFwib3V0XCIpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJsb2dcIjogbG9nKGMubGV2ZWwsIGMubWVzc2FnZSwgYy5sZXZlbCA9PT0gXCJ3YXJuXCIgPyBcIndhcm5cIiA6IFwiXCIpOyBicmVhaztcbiAgICAgIGRlZmF1bHQ6IGxvZyhcIm91dFwiLCBKU09OLnN0cmluZ2lmeShjKS5zbGljZSgwLCAzMDApLCBcIm91dFwiKTtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gb25NaWMocGNtOiBzdHJpbmcsIGxldmVsOiBudW1iZXIpIHtcbiAgY291bnRzLm1pYysrO1xuICBpZiAobGV2ZWwgPiAwLjAzICYmICEobXV0ZWQgJiYgIWhvbGRpbmcpKSB7XG4gICAgbWV0cmljcy5sYXN0Vm9pY2UgPSBub3coKTtcbiAgICBpZiAoYXVkaW8ucXVldWVkIDwgMC4wNSkgbWV0cmljcy5yZXBsaWVkID0gZmFsc2U7XG4gIH1cbiAgcHVzaCh7IHR5cGU6IFwibWljXCIsIHBjbSB9KTtcbn1cblxuZnVuY3Rpb24gY29ubmVjdChzaWQ6IG51bWJlciwgY2FwdGlvbnM6IGJvb2xlYW4pIHtcbiAgY29uc3Qgd3MgPSBuZXcgV2ViU29ja2V0KGAke2xvY2F0aW9uLnByb3RvY29sID09PSBcImh0dHBzOlwiID8gXCJ3c3NcIiA6IFwid3NcIn06Ly8ke2xvY2F0aW9uLmhvc3R9L2xpdmUke2NhcHRpb25zID8gXCI/Zm9yPWNhcHRpb25zXCIgOiBcIlwifWApO1xuICBzb2NrZXRzLnNldChzaWQsIHdzKTtcbiAgaWYgKGNhcHRpb25zKSBjYXB0aW9uU29ja2V0cy5hZGQoc2lkKTtcbiAgbG9nKFwib3V0XCIsIGB3cyAke3NpZH0gY29ubmVjdCAoJHtzZXJ2ZXIucm91dGV9JHtjYXB0aW9ucyA/IFwiLCBjYXB0aW9uc1wiIDogXCJcIn0pYCwgXCJvdXRcIik7XG4gIHdzLm9ub3BlbiA9ICgpID0+IHB1c2goeyB0eXBlOiBcIndzLm9wZW5cIiwgc2lkIH0pO1xuICB3cy5vbm1lc3NhZ2UgPSAobSkgPT4gcHVzaCh7IHR5cGU6IFwid3MubWVzc2FnZVwiLCBzaWQsIGRhdGE6IHR5cGVvZiBtLmRhdGEgPT09IFwic3RyaW5nXCIgPyBtLmRhdGEgOiBcIlwiIH0pO1xuICB3cy5vbmNsb3NlID0gKGUpID0+IHtcbiAgICBpZiAoc29ja2V0cy5nZXQoc2lkKSAhPT0gd3MgJiYgc29ja2V0cy5oYXMoc2lkKSkgcmV0dXJuO1xuICAgIGNvbnN0IGh0dHBTdGF0dXMgPSBlLmNvZGUgPj0gNDEwMCAmJiBlLmNvZGUgPCA0NjAwID8gZS5jb2RlIC0gNDAwMCA6IHVuZGVmaW5lZDtcbiAgICBwdXNoKHsgdHlwZTogXCJ3cy5jbG9zZWRcIiwgc2lkLCBjb2RlOiBodHRwU3RhdHVzID8gdW5kZWZpbmVkIDogZS5jb2RlLCByZWFzb246IGUucmVhc29uLCBodHRwU3RhdHVzIH0pO1xuICB9O1xufVxuXG4vKiogQSBjaGF0J3MgcmVxdWVzdCB0byB0aGUgdGV4dCBtb2RlbCwgdGhyb3VnaCB0aGUgc2VydmVyOiBlYWNoIGBkYXRhOmAgbGluZSBvZiB0aGUgbW9kZWwncyBzdHJlYW0gZ29lcyB0byB0aGUgY29yZSBhcyBpdCBjb21lcy4gKi9cbmFzeW5jIGZ1bmN0aW9uIGdlbmVyYXRlKGlkOiBudW1iZXIsIGJvZHk6IHN0cmluZykge1xuICBjb25zdCBhYm9ydCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgcmVxdWVzdHMuc2V0KGlkLCBhYm9ydCk7XG4gIGxvZyhcIm91dFwiLCBgcmVxdWVzdCAke2lkfSBcdTIxOTIgJHtzZXJ2ZXIudGV4dE1vZGVsfSAoJHtNYXRoLnJvdW5kKGJvZHkubGVuZ3RoIC8gMTAyNCl9IEtCKWAsIFwib3V0XCIpO1xuICB0cnkge1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goXCIvZ2VuZXJhdGVcIiwgeyBtZXRob2Q6IFwiUE9TVFwiLCBzaWduYWw6IGFib3J0LnNpZ25hbCwgaGVhZGVyczogeyBcImNvbnRlbnQtdHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LCBib2R5IH0pO1xuICAgIGlmICghcmVzcG9uc2Uub2sgfHwgIXJlc3BvbnNlLmJvZHkpIHtcbiAgICAgIGNvbnN0IHRleHQgPSBhd2FpdCByZXNwb25zZS50ZXh0KCkuY2F0Y2goKCkgPT4gXCJcIik7XG4gICAgICBwdXNoKHsgdHlwZTogXCJsbG0uZW5kXCIsIGlkLCBzdGF0dXM6IHJlc3BvbnNlLnN0YXR1cywgZXJyb3I6IGBIVFRQICR7cmVzcG9uc2Uuc3RhdHVzfSR7dGV4dCA/IFwiOiBcIiArIHRleHQucmVwbGFjZSgvXFxzKy9nLCBcIiBcIikuc2xpY2UoMCwgMjAwKSA6IFwiXCJ9YCB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgcmVhZGVyID0gcmVzcG9uc2UuYm9keS5waXBlVGhyb3VnaChuZXcgVGV4dERlY29kZXJTdHJlYW0oKSkuZ2V0UmVhZGVyKCk7XG4gICAgbGV0IGJ1ZmZlciA9IFwiXCI7XG4gICAgZm9yICg7Oykge1xuICAgICAgY29uc3QgeyB2YWx1ZSwgZG9uZSB9ID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcbiAgICAgIGlmIChkb25lKSBicmVhaztcbiAgICAgIGJ1ZmZlciArPSB2YWx1ZTtcbiAgICAgIGxldCBjdXQ7XG4gICAgICB3aGlsZSAoKGN1dCA9IGJ1ZmZlci5pbmRleE9mKFwiXFxuXCIpKSA+PSAwKSB7XG4gICAgICAgIGNvbnN0IGxpbmUgPSBidWZmZXIuc2xpY2UoMCwgY3V0KS5yZXBsYWNlKC9cXHIkLywgXCJcIik7XG4gICAgICAgIGJ1ZmZlciA9IGJ1ZmZlci5zbGljZShjdXQgKyAxKTtcbiAgICAgICAgaWYgKGxpbmUuc3RhcnRzV2l0aChcImRhdGE6XCIpKSBwdXNoKHsgdHlwZTogXCJsbG0uZGF0YVwiLCBpZCwgZGF0YTogbGluZS5zbGljZSg1KS50cmltKCkgfSk7XG4gICAgICB9XG4gICAgfVxuICAgIHB1c2goeyB0eXBlOiBcImxsbS5lbmRcIiwgaWQgfSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGlmICghYWJvcnQuc2lnbmFsLmFib3J0ZWQpIHB1c2goeyB0eXBlOiBcImxsbS5lbmRcIiwgaWQsIGVycm9yOiAoZXJyIGFzIEVycm9yKS5tZXNzYWdlIH0pO1xuICB9IGZpbmFsbHkge1xuICAgIHJlcXVlc3RzLmRlbGV0ZShpZCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gY2FuY2VsUnVuKGtleTogc3RyaW5nLCByZWFzb246IHN0cmluZykge1xuICBjb25zdCByID0gcnVucy5nZXQoa2V5KTtcbiAgbG9nKFwib3V0XCIsIGBjYW5jZWwgJHtrZXl9ICgke3JlYXNvbn0pYCwgXCJvdXRcIik7XG4gIGlmICghcikgcmV0dXJuO1xuICBydW5zLmRlbGV0ZShrZXkpO1xuICByLmFib3J0LmFib3J0KCk7XG4gIC8vIENhbmNlbGxlZCBvbiBwdXJwb3NlOiB0aGUgYWdlbnQgc3RvcHMgdG9vLiBBIGNhbGwgdGhhdCBlbmRlZCBsZWF2ZXMgYSBjb2RpbmcgYWdlbnQgd29ya2luZyBpbiBUMy5cbiAgaWYgKHJlYXNvbiA9PT0gXCJjYW5jZWxsZWRcIiAmJiAhY2hlY2tlZChcImZha2VoZXJtZXNcIikpIHtcbiAgICB2b2lkIGZldGNoKHIuYWdlbnQgPT09IFwidDNcIiA/IFwiL2FnZW50L2NhbmNlbFwiIDogXCIvaGVybWVzL3N0b3BcIiwgeyBtZXRob2Q6IFwiUE9TVFwiLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGNhbGw6IGNhbGxOYW1lLCB0YXNrSWQ6IHIudGFza0lkIH0pIH0pO1xuICB9XG59XG5cbi8qKiBNb3JlIGZvciBhIHJ1bm5pbmcgdGFzaywgaW50byBpdHMgY3VycmVudCBydW47IGlmIHRoZSBhZ2VudCB3b24ndCB0YWtlIGl0LCB0aGUgY29yZSBxdWV1ZXMgaXQgaW5zdGVhZC4gKi9cbmFzeW5jIGZ1bmN0aW9uIHN0ZWVyUnVuKGM6IENvbW1hbmQpIHtcbiAgY29uc3QgciA9IHJ1bnMuZ2V0KGMucnVuKTtcbiAgbG9nKFwib3V0XCIsIGBzdGVlciAke2MucnVufTogJHtjLnRleHR9YCwgXCJvdXRcIik7XG4gIGlmIChjaGVja2VkKFwiZmFrZWhlcm1lc1wiKSkgcmV0dXJuO1xuICBjb25zdCBvayA9IHIgIT0gbnVsbCAmJlxuICAgIChhd2FpdCBmZXRjaChjLmFnZW50ID09PSBcInQzXCIgPyBcIi9hZ2VudC9zdGVlclwiIDogXCIvaGVybWVzL3N0ZWVyXCIsIHsgbWV0aG9kOiBcIlBPU1RcIiwgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBjYWxsOiBjYWxsTmFtZSwgdGFza0lkOiByLnRhc2tJZCwgdGV4dDogYy5tZXNzYWdlIH0pIH0pLnRoZW4oKHgpID0+IHgub2ssICgpID0+IGZhbHNlKSk7XG4gIGlmICghb2spIHB1c2goeyB0eXBlOiBcInRvb2wuc3RlZXJGYWlsZWRcIiwgcnVuOiBjLnJ1biwgdGV4dDogYy50ZXh0IH0pO1xuICBlbHNlIHRvYXN0KGAke2MuYWdlbnQgPT09IFwidDNcIiA/IFwiVGhlIGNvZGluZyBhZ2VudFwiIDogXCJIZXJtZXNcIn0gdG9vayB0aGUgZm9sbG93LXVwIHdoaWxlIGl0IHdvcmtzYCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHRvb2woYzogQ29tbWFuZCkge1xuICBpZiAoYy5raW5kID09PSBcImhvc3RcIikge1xuICAgIGxvZyhcIm91dFwiLCBgaG9zdCB0b29sICR7Yy5uYW1lfSAke0pTT04uc3RyaW5naWZ5KGMuYXJncyl9YCwgXCJvdXRcIik7XG4gICAgY29uc3QgYW5zd2VyID0gYy5uYW1lID09PSBcInR2X3ZvbHVtZVwiID8gYFRoZSBUViBpcyBhdCAkeyhmYWtlVHZMZXZlbCA9IE51bWJlcihjLmFyZ3M/LmxldmVsID8/IGZha2VUdkxldmVsKSl9LmBcbiAgICAgIDogYy5uYW1lID09PSBcInR2X3BhdXNlXCIgPyAoYy5hcmdzPy5wYXVzZSA9PT0gZmFsc2UgPyBcIlBsYXlpbmcuXCIgOiBcIlBhdXNlZC5cIikgOiBcIkRvbmUuXCI7XG4gICAgc2V0VGltZW91dCgoKSA9PiBwdXNoKHsgdHlwZTogXCJ0b29sLnJlc3VsdFwiLCBydW46IGMucnVuLCB0ZXh0OiBhbnN3ZXIgfSksIDMwMCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IGFnZW50ID0gYy5hZ2VudCA9PT0gXCJ0M1wiID8gXCJ0M1wiIDogXCJoZXJtZXNcIjtcbiAgbG9nKFwib3V0XCIsIGAke2FnZW50fSAke2MuZm9sbG93VXAgPyBcImZvbGxvdy11cFwiIDogXCJ0YXNrXCJ9IFwiJHtjLmxhYmVsfVwiJHtjLnByb2plY3QgPyBgIGluICR7Yy5wcm9qZWN0fWAgOiBcIlwifTogJHtjLnJlcXVlc3R9YCwgXCJvdXRcIik7XG4gIGNvbnN0IGFib3J0ID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICBydW5zLnNldChjLnJ1biwgeyBhYm9ydCwgYWdlbnQsIHRhc2tJZDogYy50YXNrSWQgfSk7XG4gIGNvbnN0IGRvbmUgPSAodGV4dDogc3RyaW5nLCBmYWlsZWQgPSBmYWxzZSkgPT4ge1xuICAgIGlmICghcnVucy5oYXMoYy5ydW4pKSByZXR1cm47XG4gICAgcnVucy5kZWxldGUoYy5ydW4pO1xuICAgIGNvbnN0IHZpZXcgPSB0YXNrcy5nZXQoYy50YXNrSWQpO1xuICAgIGNvbnN0IHJvdyA9IHJlc3VsdChhZ2VudCwgYy5sYWJlbCwgdGV4dCwgZmFpbGVkKTtcbiAgICBub3RpZnkoYCR7YWdlbnQgPT09IFwidDNcIiA/IFwiVDNcIiA6IFwiSGVybWVzXCJ9IFx1MDBCNyAke2MubGFiZWx9YCwgdGV4dCk7XG4gICAgaWYgKCFmYWlsZWQpIHsgcmVtZW1iZXIoXCJhc3Npc3RhbnRcIiwgdGV4dCwgYCR7YWdlbnQgPT09IFwidDNcIiA/IFwiVDNcIiA6IFwiSGVybWVzXCJ9IFx1MDBCNyAke2MubGFiZWx9YCk7IGxhc3RMaW5lID0gbnVsbDsgfVxuICAgIGlmICh2aWV3KSB7IHZpZXcucmVzdWx0ID0gcm93OyBzaG93VGFza3MoKTsgfVxuICAgIHB1c2goeyB0eXBlOiBcInRvb2wucmVzdWx0XCIsIHJ1bjogYy5ydW4sIHRleHQsIGZhaWxlZCB9KTtcbiAgfTtcbiAgaWYgKGNoZWNrZWQoXCJmYWtlaGVybWVzXCIpKSB7XG4gICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IGRvbmUoYChGYWtlICR7YWdlbnQgPT09IFwidDNcIiA/IFwiVDNcIiA6IFwiSGVybWVzXCJ9KSBEb25lOiBcdTIwMUMke2MucmVxdWVzdH1cdTIwMUQuIE5vdGhpbmcgd2FzIGFjdHVhbGx5IHJ1bi5gKSwgTnVtYmVyKCQ8SFRNTElucHV0RWxlbWVudD4oXCJmYWtlZGVsYXlcIikudmFsdWUpICogMTAwMCk7XG4gICAgYWJvcnQuc2lnbmFsLm9uYWJvcnQgPSAoKSA9PiBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgIHJldHVybjtcbiAgfVxuICB0cnkge1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goYWdlbnQgPT09IFwidDNcIiA/IFwiL2FnZW50XCIgOiBcIi9oZXJtZXNcIiwge1xuICAgICAgbWV0aG9kOiBcIlBPU1RcIiwgc2lnbmFsOiBhYm9ydC5zaWduYWwsIGhlYWRlcnM6IHsgXCJjb250ZW50LXR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgY2FsbDogY2FsbE5hbWUsIHRhc2tJZDogYy50YXNrSWQsIGZvbGxvd1VwOiBjLmZvbGxvd1VwLCBtZXNzYWdlOiBjLm1lc3NhZ2UsIGxhYmVsOiBjLmxhYmVsLCByZXF1ZXN0OiBjLnJlcXVlc3QsIHByb2plY3Q6IGMucHJvamVjdCwgYXBwcm92YWxzOiBcInNjcmVlblwiIH0pLFxuICAgIH0pO1xuICAgIGlmICghcmVzcG9uc2Uub2sgfHwgIXJlc3BvbnNlLmJvZHkpIHRocm93IG5ldyBFcnJvcihgSFRUUCAke3Jlc3BvbnNlLnN0YXR1c31gKTtcbiAgICBjb25zdCByZWFkZXIgPSByZXNwb25zZS5ib2R5LnBpcGVUaHJvdWdoKG5ldyBUZXh0RGVjb2RlclN0cmVhbSgpKS5nZXRSZWFkZXIoKTtcbiAgICBsZXQgYnVmZmVyID0gXCJcIjtcbiAgICBmb3IgKDs7KSB7XG4gICAgICBjb25zdCB7IHZhbHVlLCBkb25lOiBmaW5pc2hlZCB9ID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcbiAgICAgIGlmIChmaW5pc2hlZCkgYnJlYWs7XG4gICAgICBidWZmZXIgKz0gdmFsdWU7XG4gICAgICBsZXQgY3V0O1xuICAgICAgd2hpbGUgKChjdXQgPSBidWZmZXIuaW5kZXhPZihcIlxcblxcblwiKSkgPj0gMCkge1xuICAgICAgICBjb25zdCBibG9jayA9IGJ1ZmZlci5zbGljZSgwLCBjdXQpO1xuICAgICAgICBidWZmZXIgPSBidWZmZXIuc2xpY2UoY3V0ICsgMik7XG4gICAgICAgIGNvbnN0IGV2ZW50ID0gYmxvY2subWF0Y2goL15ldmVudDogKC4qKSQvbSk/LlsxXTtcbiAgICAgICAgaWYgKCFldmVudCkgY29udGludWU7XG4gICAgICAgIGNvbnN0IGRhdGEgPSBKU09OLnBhcnNlKGJsb2NrLm1hdGNoKC9eZGF0YTogKC4qKSQvbSk/LlsxXSA/PyBcInt9XCIpO1xuICAgICAgICBpZiAoZXZlbnQgPT09IFwicHJvZ3Jlc3NcIikgcHVzaCh7IHR5cGU6IFwidGFzay5wcm9ncmVzc1wiLCB0YXNrOiBjLnRhc2tJZCwgdGV4dDogZGF0YS50ZXh0IH0pO1xuICAgICAgICBlbHNlIGlmIChldmVudCA9PT0gXCJ0aHJlYWRcIikgeyBjb25zdCB2aWV3ID0gdGFza3MuZ2V0KGMudGFza0lkKTsgaWYgKHZpZXcpIHsgdmlldy50aHJlYWQgPSBkYXRhLnRocmVhZDsgc2hvd1Rhc2tzKCk7IH0gfVxuICAgICAgICBlbHNlIGlmIChldmVudCA9PT0gXCJhcHByb3ZhbFwiKSB7XG4gICAgICAgICAgY29uc3QgdmlldyA9IHRhc2tzLmdldChjLnRhc2tJZCk7XG4gICAgICAgICAgaWYgKHZpZXcpIHsgdmlldy5hcHByb3ZhbCA9IHsgY29tbWFuZDogZGF0YS5jb21tYW5kIH07IHNob3dUYXNrcyh0cnVlKTsgfVxuICAgICAgICAgIHRvYXN0KGBIZXJtZXMgYXNrcyB0byBydW46ICR7ZGF0YS5jb21tYW5kLnNsaWNlKDAsIDgwKX1gKTtcbiAgICAgICAgICBub3RpZnkoYEhlcm1lcyBcdTAwQjcgJHtjLmxhYmVsfSBuZWVkcyB5b3VyIGFwcHJvdmFsYCwgZGF0YS5jb21tYW5kKTtcbiAgICAgICAgICBhdWRpby5jdWUoQVBQUk9WQUxfVE9ORSk7XG4gICAgICAgIH1cbiAgICAgICAgZWxzZSBpZiAoZXZlbnQgPT09IFwicmVzdWx0XCIpIGRvbmUoZGF0YS50ZXh0LCBkYXRhLmZhaWxlZCk7XG4gICAgICAgIGVsc2UgaWYgKGV2ZW50ID09PSBcImVycm9yXCIpIHsgcnVucy5kZWxldGUoYy5ydW4pOyBwdXNoKHsgdHlwZTogXCJ0b29sLmVycm9yXCIsIHJ1bjogYy5ydW4sIG1lc3NhZ2U6IGRhdGEubWVzc2FnZSB9KTsgfVxuICAgICAgfVxuICAgIH1cbiAgICBpZiAocnVucy5oYXMoYy5ydW4pKSB7IHJ1bnMuZGVsZXRlKGMucnVuKTsgcHVzaCh7IHR5cGU6IFwidG9vbC5lcnJvclwiLCBydW46IGMucnVuLCBtZXNzYWdlOiBcInRoZSBzZXJ2ZXIgY2xvc2VkIHRoZSBzdHJlYW0gd2l0aG91dCBhIHJlc3VsdFwiIH0pOyB9XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGlmICghYWJvcnQuc2lnbmFsLmFib3J0ZWQgJiYgcnVucy5oYXMoYy5ydW4pKSB7IHJ1bnMuZGVsZXRlKGMucnVuKTsgcHVzaCh7IHR5cGU6IFwidG9vbC5lcnJvclwiLCBydW46IGMucnVuLCBtZXNzYWdlOiAoZXJyIGFzIEVycm9yKS5tZXNzYWdlIH0pOyB9XG4gIH1cbn1cblxuZnVuY3Rpb24gbWljT3B0aW9ucygpIHtcbiAgY29uc3QgYWVjID0gY2hlY2tlZChcImFlY1wiKTtcbiAgcmV0dXJuIHsgZWNob0NhbmNlbGxhdGlvbjogYWVjLCBub2lzZVN1cHByZXNzaW9uOiBhZWMsIGF1dG9HYWluQ29udHJvbDogYWVjIH07XG59XG5cbmZ1bmN0aW9uIHJlYWRDb25maWcoKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICBjb25zdCBnaXZlbiA9IEpTT04ucGFyc2UoJDxIVE1MVGV4dEFyZWFFbGVtZW50PihcImNvbmZpZ1wiKS52YWx1ZSk7XG4gIGNvbnN0IGNvbmZpZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgbW9kZWw6IHNlcnZlci5tb2RlbCwgYXBpOiBzZXJ2ZXIucm91dGUgPT09IFwidmVydGV4XCIgPyBcInZlcnRleFwiIDogXCJnZW1pbmlcIiwgdG9kYXk6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKS5zbGljZSgwLCAxMCksXG4gICAgLi4uZ2l2ZW4sIHRyYWNlOiBjaGVja2VkKFwidHJhY2VcIiksXG4gIH07XG4gIGlmIChjaGVja2VkKFwicHR0XCIpKSBjb25maWcubXV0ZWQgPSB0cnVlO1xuICBpZiAoZ2l2ZW4udm9pY2UgPT09IHVuZGVmaW5lZCkgY29uZmlnLnZvaWNlID0gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJ2b2ljZVwiKS52YWx1ZTtcbiAgaWYgKGNvbmZpZy5zdGVlcmluZyA9PT0gdW5kZWZpbmVkKSBjb25maWcuc3RlZXJpbmcgPSBbXCJoZXJtZXNcIiwgXCJ0M1wiXTtcbiAgLy8gQSB3ZWIgY29uZmlnIHNhdmVkIGJlZm9yZSBoYW5kLW9mZnMgd2VyZSBuYW1lZCBpbiB3b3JkcyBnZXRzIHRoYXQgdG9vLlxuICBpZiAoY29uZmlnLmhhbmRPZmYgPT09IHVuZGVmaW5lZCAmJiBjb25maWcucGxhdGZvcm0gPT09IFwid2ViXCIpIGNvbmZpZy5oYW5kT2ZmID0gXCJuYW1lZFwiO1xuICAvLyBBbmQgb25lIHNhdmVkIGJlZm9yZSB0aGUgcGFnZSBmb2xsb3dlZCB0aGUgdXNlcidzIGxlYWQgKHN1cGVydmlzZSkgZ2V0cyB0aGF0LlxuICBpZiAoY29uZmlnLnN1cGVydmlzZSA9PT0gdW5kZWZpbmVkICYmIGNvbmZpZy5wbGF0Zm9ybSA9PT0gXCJ3ZWJcIikgY29uZmlnLnN1cGVydmlzZSA9IHRydWU7XG4gIGlmIChjaGVja2VkKFwiY29kaW5nXCIpICYmIChzZXJ2ZXIudDMgfHwgY2hlY2tlZChcImZha2VoZXJtZXNcIikpICYmIGNvbmZpZy5jb2RpbmdBZ2VudCA9PT0gdW5kZWZpbmVkKSBjb25maWcuY29kaW5nQWdlbnQgPSB7IHByb2plY3RzOiBzZXJ2ZXIudDMgPz8gW10gfTtcbiAgaWYgKGNoZWNrZWQoXCJjYXB0aW9uc1wiKSAmJiBzZXJ2ZXIuY2FwdGlvbnNNb2RlbCAmJiBjb25maWcuY2FwdGlvbnMgPT09IHVuZGVmaW5lZCkgY29uZmlnLmNhcHRpb25zID0geyBtb2RlbDogc2VydmVyLmNhcHRpb25zTW9kZWwgfTtcbiAgcmV0dXJuIGNvbmZpZztcbn1cblxuLyoqIFN0YXJ0cyBhIHZvaWNlIGNhbGwsIG9yIHdpdGggW3R5cGVkXSBhIGNoYXQgKHRoZSBjb3JlJ3MgbWVkaXVtIFwidGV4dFwiOiBubyBhdWRpbywgYSB0ZXh0IG1vZGVsKS4gKi9cbmFzeW5jIGZ1bmN0aW9uIHN0YXJ0KGNhcnJ5T24gPSBmYWxzZSwgdHlwZWQgPSBmYWxzZSkge1xuICBhd2FpdCBlbmRpbmc7XG4gIGlmIChjYWxsSWQpIHJldHVybjtcbiAgbGV0IGdpdmVuOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgdHJ5IHtcbiAgICBnaXZlbiA9IHJlYWRDb25maWcoKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgdG9hc3QoYFRoZSBkZXZlbG9wZXIgc2V0dGluZ3MgYXJlbid0IHZhbGlkIEpTT046ICR7KGVyciBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKHR5cGVkKSB7XG4gICAgaWYgKCFzZXJ2ZXIudGV4dE1vZGVsKSB7IHRvYXN0KFwiVGhpcyBzZXJ2ZXIgaGFzIG5vIHRleHQgbW9kZWwgZm9yIGEgY2hhdDogc3RhcnQgYSBjYWxsIHRvIHR5cGUgdG8gaXRcIik7IHJldHVybjsgfVxuICAgIGdpdmVuID0geyAuLi5naXZlbiwgbWVkaXVtOiBcInRleHRcIiwgbXV0ZWQ6IGZhbHNlIH07XG4gICAgZGVsZXRlIGdpdmVuLmNhcHRpb25zO1xuICB9XG4gICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiY2FsbFwiKS5kaXNhYmxlZCA9IHRydWU7XG4gICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiaGVyby1jYWxsXCIpLmRpc2FibGVkID0gdHJ1ZTtcbiAgaWYgKFwiTm90aWZpY2F0aW9uXCIgaW4gd2luZG93ICYmIE5vdGlmaWNhdGlvbi5wZXJtaXNzaW9uID09PSBcImRlZmF1bHRcIikgdm9pZCBOb3RpZmljYXRpb24ucmVxdWVzdFBlcm1pc3Npb24oKS5jYXRjaCgoKSA9PiB7fSk7XG4gIHRyeSB7XG4gICAgaWYgKCF0eXBlZCkgYXdhaXQgYXVkaW8ub3BlbigpO1xuICAgIGNvcmUgPSBhd2FpdCBsb2FkQ29yZSgpO1xuICB9IGZpbmFsbHkge1xuICAgICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiY2FsbFwiKS5kaXNhYmxlZCA9IGZhbHNlO1xuICAgICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiaGVyby1jYWxsXCIpLmRpc2FibGVkID0gZmFsc2U7XG4gIH1cbiAgaWYgKGNhbGxJZCkgcmV0dXJuOyAvLyBhbm90aGVyIHN0YXJ0IGdvdCB0aGVyZSBmaXJzdFxuICBtZWRpdW0gPSB0eXBlZCA/IFwidGV4dFwiIDogXCJ2b2ljZVwiO1xuICB0aGlua2luZyA9IGZhbHNlO1xuICAkKFwidmVyc2lvblwiKS50ZXh0Q29udGVudCA9IGNvcmUudmVyc2lvbjtcbiAgJChcImxvZ1wiKS5pbm5lckhUTUwgPSBcIlwiO1xuICBpZiAoIXR5cGVkICYmICh0YXNrcy5zaXplID4gMCB8fCAkKFwidHJhbnNjcmlwdFwiKS5jaGlsZEVsZW1lbnRDb3VudCA+IDEpKSBub3RlKGBOZXcgY2FsbCBcdTAwQjcgJHtuZXcgRGF0ZSgpLnRvTG9jYWxlVGltZVN0cmluZygpfWApO1xuICB0YXNrcy5jbGVhcigpO1xuICBzaG93VGFza3MoKTtcbiAgY291bnRzID0geyBtaWM6IDAsIHBsYXk6IDAsIHNlbnQ6IDAgfTtcbiAgbWV0cmljcy5yZXBseSA9IFtdO1xuICBzdGFydGVkQXQgPSBub3coKTtcbiAgbXV0ZWQgPSBnaXZlbi5tdXRlZCA9PT0gdHJ1ZTtcbiAgLy8gQ2Fycnlpbmcgb246IHRoZSBtb2RlbCBnZXRzIHRoZSBsYXN0IGNvbnZlcnNhdGlvbiBhcyBhIHJlY2FwLiBUaGUgY29yZSBjYXBzIGl0LCBsYXRlc3QgbGluZXMgZmlyc3QuXG4gIC8vIEEgY2hhdCBhbHdheXMgY2FycmllcyBvbiBmcm9tIHdoYXQncyBvbiB0aGUgc2NyZWVuIChhbiBlYXJsaWVyIGNhbGwgb3IgY2hhdCBvbiB0aGlzIHBhZ2UpLlxuICBpZiAodHlwZWQpIHsgaWYgKGNoYXQubGVuZ3RoID4gMCAmJiBnaXZlbi5oaXN0b3J5ID09PSB1bmRlZmluZWQpIGdpdmVuLmhpc3RvcnkgPSBjaGF0OyB9XG4gIGVsc2UgaWYgKGNhcnJ5T24gJiYgZ2l2ZW4uaGlzdG9yeSA9PT0gdW5kZWZpbmVkKSBnaXZlbi5oaXN0b3J5ID0gc2F2ZWRIaXN0b3J5KCk7XG4gIGVsc2UgaWYgKCFjYXJyeU9uKSBjaGF0ID0gW107XG4gIGlmIChjYXJyeU9uICYmICF0eXBlZCkgY2hhdCA9IHNhdmVkSGlzdG9yeSgpO1xuICBsYXN0TGluZSA9IG51bGw7XG4gIG9wZW5MaW5lID0gbnVsbDtcbiAgc3luY1Jlc3VtZUJ1dHRvbnMoZmFsc2UpO1xuICBjYWxsTmFtZSA9IGAke25ldyBEYXRlKCkudG9JU09TdHJpbmcoKS5yZXBsYWNlKC9bOi5dL2csIFwiLVwiKX0tJHt0eXBlZCA/IFwiY2hhdFwiIDogXCJ3ZWJcIn0tJHtjb3JlLnZlcnNpb259YDtcbiAgY29uc3QgY3JlYXRlZCA9IEpTT04ucGFyc2UoY29yZS5jcmVhdGUoSlNPTi5zdHJpbmdpZnkoZ2l2ZW4pLCBub3coKSkpO1xuICBjYWxsSWQgPSBjcmVhdGVkLmlkO1xuICBpZiAoIXR5cGVkKSB7XG4gICAgc2V0Q2FsbEJ1dHRvbih0cnVlKTtcbiAgICAkPEhUTUxCdXR0b25FbGVtZW50PihcIm1pY1wiKS5kaXNhYmxlZCA9IGZhbHNlO1xuICB9XG4gICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiaHVzaFwiKS5kaXNhYmxlZCA9IGZhbHNlO1xuICAkKFwibWljXCIpLmNsYXNzTGlzdC50b2dnbGUoXCJtdXRlZFwiLCBtdXRlZCk7XG4gIHJ1bihjcmVhdGVkLmNvbW1hbmRzKTtcbiAgc2hvd1N0YXR1cygpO1xuICB0aWNrZXIgPSB3aW5kb3cuc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgIHB1c2goeyB0eXBlOiBcInRpY2tcIiB9KTtcbiAgICBjb25zdCBsZXZlbCA9IG11dGVkICYmICFob2xkaW5nID8gMCA6IGF1ZGlvLmxldmVsO1xuICAgIGNvbnN0IHN0cmVuZ3RoID0gTWF0aC5taW4oMSwgbGV2ZWwgKiAxMik7XG4gICAgJChcInJpbmdcIikuc3R5bGUub3BhY2l0eSA9IFN0cmluZyhzdHJlbmd0aCk7XG4gICAgJChcInJpbmdcIikuc3R5bGUudHJhbnNmb3JtID0gYHNjYWxlKCR7KDEgKyBzdHJlbmd0aCAqIDAuMTIpLnRvRml4ZWQoMyl9KWA7XG4gICAgJChcImNvdW50c1wiKS50ZXh0Q29udGVudCA9IGBtaWMgJHtjb3VudHMubWljfSBcdTAwQjcgc2VudCAke2NvdW50cy5zZW50fSBcdTAwQjcgcGxheWVkICR7Y291bnRzLnBsYXl9IFx1MDBCNyBxdWV1ZWQgJHthdWRpby5xdWV1ZWQudG9GaXhlZCgxKX0gc2A7XG4gICAgc2hvd1N0YXR1cygpO1xuICB9LCAxMDApO1xuICB0cmFjZVRpbWVyID0gd2luZG93LnNldEludGVydmFsKCgpID0+IHsgdm9pZCBzYXZlVHJhY2UoKTsgdm9pZCBwaW5nKCk7IHNob3dUYXNrcygpOyB9LCA1MDAwKTtcbiAgdm9pZCBwaW5nKCk7XG4gIGlmICh0eXBlZCkgcmV0dXJuO1xuICBzdG9wV29yZHMuc3RhcnQoKTtcbiAgdHJ5IHsgd2FrZUxvY2sgPSBhd2FpdCAobmF2aWdhdG9yIGFzIGFueSkud2FrZUxvY2s/LnJlcXVlc3QoXCJzY3JlZW5cIik7IH0gY2F0Y2gge31cbn1cblxuLyoqIFRoZSBDYWxsIGJ1dHRvbjogaGFuZ3MgdXAgYSBjYWxsOyBzdGFydHMgb25lOyBvciwgd2l0aCBhIGNoYXQgb24sIGVuZHMgdGhlIGNoYXQgYW5kIGNhcnJpZXMgaXRzIGNvbnZlcnNhdGlvbiBvbiBieSB2b2ljZS4gKi9cbmFzeW5jIGZ1bmN0aW9uIGNhbGxCdXR0b24oKSB7XG4gIGlmIChjYWxsSWQgJiYgbWVkaXVtID09PSBcInZvaWNlXCIpIHsgaGFuZ1VwKCk7IHJldHVybjsgfVxuICBpZiAoY2FsbElkKSB7XG4gICAgLy8gQSBjYWxsIGNhbid0IHRha2Ugb3ZlciB0aGUgY2hhdCdzIHRhc2tzLCBhbmQgZW5kaW5nIHRoZSBjaGF0IHdvdWxkIHN0b3AgdGhlbS5cbiAgICBpZiAoWy4uLnRhc2tzLnZhbHVlcygpXS5zb21lKCh2KSA9PiB2LmMuc3RhdGUgPT09IFwicnVubmluZ1wiKSkgeyB0b2FzdChcIlRoZSBjaGF0J3MgdGFza3MgYXJlIHN0aWxsIHJ1bm5pbmc6IHdhaXQgZm9yIHRoZW0gb3IgY2FuY2VsIHRoZW0sIHRoZW4gY2FsbFwiKTsgcmV0dXJuOyB9XG4gICAgcHVzaCh7IHR5cGU6IFwic3RvcFwiIH0pO1xuICAgIGF3YWl0IHN0YXJ0KHRydWUpO1xuICAgIHJldHVybjtcbiAgfVxuICBhd2FpdCBzdGFydCgpO1xufVxuXG5mdW5jdGlvbiBoYW5nVXAoKSB7XG4gIGlmIChjYWxsSWQpIHB1c2goeyB0eXBlOiBcInN0b3BcIiwgbWVzc2FnZTogXCJZb3UgaHVuZyB1cC5cIiB9KTtcbn1cblxuZnVuY3Rpb24gZW5kKCkge1xuICB3aW5kb3cuY2xlYXJJbnRlcnZhbCh0aWNrZXIpO1xuICB3aW5kb3cuY2xlYXJJbnRlcnZhbCh0cmFjZVRpbWVyKTtcbiAgc3RvcFdvcmRzLnN0b3AoKTtcbiAgZW5kaW5nID0gc2F2ZVRyYWNlKCkudGhlbigoKSA9PiB7IGlmIChjb3JlICYmIGNhbGxJZCkgY29yZS5kaXNwb3NlKGNhbGxJZCk7IGNhbGxJZCA9IDA7IHNob3dUYXNrcygpOyBzaG93U3RhdHVzKCk7IH0pO1xuICBhdWRpby5zdG9wKCk7XG4gIGZvciAoY29uc3Qgd3Mgb2Ygc29ja2V0cy52YWx1ZXMoKSkgd3MuY2xvc2UoKTtcbiAgc29ja2V0cy5jbGVhcigpO1xuICBmb3IgKGNvbnN0IHIgb2YgcnVucy52YWx1ZXMoKSkgci5hYm9ydC5hYm9ydCgpO1xuICBydW5zLmNsZWFyKCk7XG4gIGZvciAoY29uc3QgciBvZiByZXF1ZXN0cy52YWx1ZXMoKSkgci5hYm9ydCgpO1xuICByZXF1ZXN0cy5jbGVhcigpO1xuICB0aGlua2luZyA9IGZhbHNlO1xuICBzZXRDYWxsQnV0dG9uKGZhbHNlKTtcbiAgZm9yIChjb25zdCBpZCBvZiBbXCJtaWNcIiwgXCJodXNoXCJdKSAkPEhUTUxCdXR0b25FbGVtZW50PihpZCkuZGlzYWJsZWQgPSB0cnVlO1xuICAkKFwicmluZ1wiKS5zdHlsZS5vcGFjaXR5ID0gXCIwXCI7XG4gICQoXCJyaW5nXCIpLnN0eWxlLnRyYW5zZm9ybSA9IFwiXCI7XG4gICQoXCJjYWxsYmFyXCIpLmhpZGRlbiA9IHRydWU7XG4gICQoXCJtaWN3YXJuXCIpLmhpZGRlbiA9IHRydWU7XG4gIGRvY3VtZW50LmJvZHkuZGF0YXNldC5zdGF0ZSA9IFwiaWRsZVwiO1xuICBkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5yZW1vdmUoXCJpbi1zZXNzaW9uXCIpO1xuICBzeW5jUmVzdW1lQnV0dG9ucyhjaGF0Lmxlbmd0aCA+IDApO1xuICB2b2lkIHNob3dFYXJsaWVyKCk7XG4gIHZvaWQgd2FrZUxvY2s/LnJlbGVhc2UoKS5jYXRjaCgoKSA9PiB7fSk7XG4gIHdha2VMb2NrID0gbnVsbDtcbn1cblxuZnVuY3Rpb24gc2V0TXV0ZWQodmFsdWU6IGJvb2xlYW4pIHtcbiAgaWYgKCFjYWxsSWQgfHwgbXV0ZWQgPT09IHZhbHVlKSByZXR1cm47XG4gIG11dGVkID0gdmFsdWU7XG4gICQoXCJtaWNcIikuY2xhc3NMaXN0LnRvZ2dsZShcIm11dGVkXCIsIG11dGVkKTtcbiAgcHVzaCh7IHR5cGU6IG11dGVkID8gXCJtdXRlXCIgOiBcInVubXV0ZVwiIH0pO1xuICBzaG93U3RhdHVzKCk7XG59XG5cbi8qKiBTZW5kcyB3aGF0IHRoZSB0cmFjZSBrZXB0IHNpbmNlIGxhc3QgdGltZSB0byB0aGUgZGV2IHNlcnZlciwgYXMgSlNPTiBsaW5lczogYSBoZWFkZXIsIHRoZW4gZXZlbnRzLiAqL1xuYXN5bmMgZnVuY3Rpb24gc2F2ZVRyYWNlKCkge1xuICBpZiAoIWNvcmUgfHwgIWNhbGxJZCB8fCAhY2hlY2tlZChcInRyYWNlXCIpKSByZXR1cm47XG4gIGNvbnN0IGtlcHQgPSBKU09OLnBhcnNlKGNvcmUudHJhY2UoY2FsbElkKSk7XG4gIGlmICgha2VwdCkgcmV0dXJuO1xuICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcbiAgaWYgKGtlcHQuY29uZmlnKSBsaW5lcy5wdXNoKEpTT04uc3RyaW5naWZ5KHsgdmVyc2lvbjoga2VwdC52ZXJzaW9uLCBjb25maWc6IGtlcHQuY29uZmlnLCBzdGFydDoga2VwdC5zdGFydCB9KSk7XG4gIGZvciAoY29uc3QgZSBvZiBrZXB0LmV2ZW50cykgbGluZXMucHVzaChKU09OLnN0cmluZ2lmeShlKSk7XG4gIGlmIChsaW5lcy5sZW5ndGggPT09IDApIHJldHVybjtcbiAgYXdhaXQgZmV0Y2goYC90cmFjZXM/bmFtZT0ke2VuY29kZVVSSUNvbXBvbmVudChjYWxsTmFtZSl9Lmpzb25sYCwgeyBtZXRob2Q6IFwiUE9TVFwiLCBib2R5OiBsaW5lcy5qb2luKFwiXFxuXCIpICsgXCJcXG5cIiB9KS5jYXRjaCgoKSA9PiB7fSk7XG4gICQoXCJ0cmFjZW5hbWVcIikudGV4dENvbnRlbnQgPSBgdHJhY2UgJHtjYWxsTmFtZX0uanNvbmxgO1xufVxuXG4vLyBcIlN0b3BcIiBhbmQgXCJnb29kYnllXCIgaGVhcmQgYnkgdGhlIGJyb3dzZXIncyBvd24gcmVjb2duaXplcjogcXVpY2tlciB0aGFuIHRoZSBtb2RlbCdzIHRyYW5zY3JpcHQsXG4vLyBhbmQgaXQgd29ya3Mgd2hpbGUgdGhlIG1vZGVsJ3MgcmVwbHkgcGxheXMgZXZlbiB3aGVuIHRoZSBtb2RlbCBpc24ndCBoZWFyaW5nIHRoZSBtaWNyb3Bob25lLlxuXG5jbGFzcyBTdG9wV29yZHMge1xuICBwcml2YXRlIHJlYzogYW55ID0gbnVsbDtcbiAgcHJpdmF0ZSBvbiA9IGZhbHNlO1xuICBwcml2YXRlIGNvbW1hbmRzID0geyBzdG9wOiBbXSBhcyBzdHJpbmdbXSwgaGFuZ1VwOiBbXSBhcyBzdHJpbmdbXSwgY2FuY2VsQWxsOiBbXSBhcyBzdHJpbmdbXSB9O1xuXG4gIGdldCBzdXBwb3J0ZWQoKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIFwid2Via2l0U3BlZWNoUmVjb2duaXRpb25cIiBpbiB3aW5kb3cgfHwgXCJTcGVlY2hSZWNvZ25pdGlvblwiIGluIHdpbmRvdztcbiAgfVxuXG4gIHN0YXJ0KCkge1xuICAgIGlmICghY2hlY2tlZChcInN0b3B3b3JkXCIpIHx8ICF0aGlzLnN1cHBvcnRlZCB8fCAhY29yZSkgcmV0dXJuO1xuICAgIHRoaXMuY29tbWFuZHMgPSBKU09OLnBhcnNlKGNvcmUuZGVmYXVsdHMoKSkudm9pY2VDb21tYW5kcztcbiAgICBjb25zdCBSZWNvZ25pdGlvbiA9ICh3aW5kb3cgYXMgYW55KS5TcGVlY2hSZWNvZ25pdGlvbiA/PyAod2luZG93IGFzIGFueSkud2Via2l0U3BlZWNoUmVjb2duaXRpb247XG4gICAgdGhpcy5yZWMgPSBuZXcgUmVjb2duaXRpb24oKTtcbiAgICB0aGlzLnJlYy5jb250aW51b3VzID0gdHJ1ZTtcbiAgICB0aGlzLnJlYy5pbnRlcmltUmVzdWx0cyA9IHRydWU7XG4gICAgdGhpcy5yZWMubGFuZyA9IG5hdmlnYXRvci5sYW5ndWFnZSB8fCBcImVuLUdCXCI7XG4gICAgdGhpcy5yZWMub25yZXN1bHQgPSAoZTogYW55KSA9PiB7XG4gICAgICBmb3IgKGxldCBpID0gZS5yZXN1bHRJbmRleDsgaSA8IGUucmVzdWx0cy5sZW5ndGg7IGkrKykge1xuICAgICAgICBjb25zdCB0ZXh0ID0gZS5yZXN1bHRzW2ldWzBdLnRyYW5zY3JpcHQgYXMgc3RyaW5nO1xuICAgICAgICBjb25zdCBjb21tYW5kID0gY29tbWFuZEluKHRleHQsIHRoaXMuY29tbWFuZHMsIFtcIldvb2Rob3VzZVwiLCBcIkhlcm1lc1wiLCBcIkJlbnRvXCJdKTtcbiAgICAgICAgaWYgKGNvbW1hbmQgPT09IFwic3RvcFwiICYmIGF1ZGlvLnF1ZXVlZCA+IDAuMDUpIHtcbiAgICAgICAgICBsb2coXCJvdXRcIiwgYGxvY2FsIHN0b3Agd29yZDogJHt0ZXh0fWAsIFwib3V0XCIpO1xuICAgICAgICAgIHRvYXN0KGBIZWFyZCBcdTIwMUMke3RleHQudHJpbSgpfVx1MjAxRDogc3RvcHBlZGApO1xuICAgICAgICAgIHB1c2goeyB0eXBlOiBcImludGVycnVwdFwiIH0pO1xuICAgICAgICB9IGVsc2UgaWYgKGNvbW1hbmQgPT09IFwiY2FuY2VsQWxsXCIgJiYgZS5yZXN1bHRzW2ldLmlzRmluYWwpIHtcbiAgICAgICAgICBsb2coXCJvdXRcIiwgYGxvY2FsIGNhbmNlbC1hbGw6ICR7dGV4dH1gLCBcIm91dFwiKTtcbiAgICAgICAgICBwdXNoKHsgdHlwZTogXCJjYW5jZWxBbGxcIiB9KTtcbiAgICAgICAgICBwdXNoKHsgdHlwZTogXCJpbnRlcnJ1cHRcIiB9KTtcbiAgICAgICAgfSBlbHNlIGlmIChjb21tYW5kID09PSBcImhhbmdVcFwiICYmIGUucmVzdWx0c1tpXS5pc0ZpbmFsKSB7XG4gICAgICAgICAgbG9nKFwib3V0XCIsIGBsb2NhbCBoYW5nLXVwOiAke3RleHR9YCwgXCJvdXRcIik7XG4gICAgICAgICAgaGFuZ1VwKCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9O1xuICAgIHRoaXMucmVjLm9uZW5kID0gKCkgPT4geyBpZiAodGhpcy5vbikgc2V0VGltZW91dCgoKSA9PiB7IHRyeSB7IHRoaXMucmVjPy5zdGFydCgpOyB9IGNhdGNoIHt9IH0sIDI1MCk7IH07XG4gICAgdGhpcy5yZWMub25lcnJvciA9IChlOiBhbnkpID0+IHsgaWYgKGUuZXJyb3IgPT09IFwibm90LWFsbG93ZWRcIikgdGhpcy5vbiA9IGZhbHNlOyB9O1xuICAgIHRoaXMub24gPSB0cnVlO1xuICAgIHRyeSB7IHRoaXMucmVjLnN0YXJ0KCk7IH0gY2F0Y2gge31cbiAgfVxuXG4gIHN0b3AoKSB7XG4gICAgdGhpcy5vbiA9IGZhbHNlO1xuICAgIHRyeSB7IHRoaXMucmVjPy5zdG9wKCk7IH0gY2F0Y2gge31cbiAgICB0aGlzLnJlYyA9IG51bGw7XG4gIH1cbn1cbmNvbnN0IHN0b3BXb3JkcyA9IG5ldyBTdG9wV29yZHMoKTtcblxuLy8gV2lyaW5nLlxuXG5mdW5jdGlvbiBzZXR0aW5nc0Zyb21TdG9yYWdlKCkge1xuICBmb3IgKGNvbnN0IGlkIG9mIFtcImFlY1wiLCBcInN0b3B3b3JkXCIsIFwicHR0XCIsIFwiY2FwdGlvbnNcIiwgXCJjb2RpbmdcIiwgXCJmYWtlaGVybWVzXCIsIFwidHJhY2VcIl0pIHtcbiAgICBjb25zdCB2ID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oYHZvaWNlLiR7aWR9YCk7XG4gICAgaWYgKHYgIT0gbnVsbCkgJDxIVE1MSW5wdXRFbGVtZW50PihpZCkuY2hlY2tlZCA9IHYgPT09IFwiMVwiO1xuICAgICQoaWQpLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4gbG9jYWxTdG9yYWdlLnNldEl0ZW0oYHZvaWNlLiR7aWR9YCwgY2hlY2tlZChpZCkgPyBcIjFcIiA6IFwiMFwiKSk7XG4gIH1cbiAgY29uc3QgZGVsYXkgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLmZha2VkZWxheVwiKTtcbiAgaWYgKGRlbGF5KSAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwiZmFrZWRlbGF5XCIpLnZhbHVlID0gZGVsYXk7XG4gICQoXCJmYWtlZGVsYXlcIikuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLmZha2VkZWxheVwiLCAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwiZmFrZWRlbGF5XCIpLnZhbHVlKSk7XG4gIGNvbnN0IHZvaWNlID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS52b2ljZVwiKTtcbiAgaWYgKHZvaWNlKSAkPEhUTUxTZWxlY3RFbGVtZW50PihcInZvaWNlXCIpLnZhbHVlID0gdm9pY2U7XG4gICQoXCJ2b2ljZVwiKS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2Uudm9pY2VcIiwgJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJ2b2ljZVwiKS52YWx1ZSkpO1xuICBjb25zdCBtb2RlID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS5tb2RlXCIpO1xuICBpZiAobW9kZSkgJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJtb2RlXCIpLnZhbHVlID0gbW9kZTtcbiAgJChcIm1vZGVcIikuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiB7XG4gICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS5tb2RlXCIsICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwibW9kZVwiKS52YWx1ZSk7XG4gICAgc3luY0NvbXBvc2VyKCk7XG4gIH0pO1xuICBjb25zdCB0aGVtZSA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UudGhlbWVcIikgPz8gXCJzeXN0ZW1cIjtcbiAgYXBwbHlUaGVtZSh0aGVtZSk7XG4gIGZvciAoY29uc3QgYnRuIG9mIEFycmF5LmZyb20oZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MQnV0dG9uRWxlbWVudD4oXCIjdGhlbWUtcGlja2VyIGJ1dHRvblwiKSkpIHtcbiAgICBidG4ub25jbGljayA9ICgpID0+IHtcbiAgICAgIGNvbnN0IGNob2ljZSA9IGJ0bi5kYXRhc2V0LnRoZW1lID8/IFwic3lzdGVtXCI7XG4gICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLnRoZW1lXCIsIGNob2ljZSk7XG4gICAgICBhcHBseVRoZW1lKGNob2ljZSk7XG4gICAgfTtcbiAgfVxuICBtYXRjaE1lZGlhKFwiKHByZWZlcnMtY29sb3Itc2NoZW1lOiBkYXJrKVwiKS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHtcbiAgICBpZiAoKGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UudGhlbWVcIikgPz8gXCJzeXN0ZW1cIikgPT09IFwic3lzdGVtXCIpIGFwcGx5VGhlbWUoXCJzeXN0ZW1cIik7XG4gIH0pO1xufVxuXG5jb25zdCBtb2JpbGVMYXlvdXQgPSBtYXRjaE1lZGlhKFwiKG1heC13aWR0aDogOTIwcHgpXCIpO1xubGV0IGRyYXdlck9wZW5lcjogSFRNTEVsZW1lbnQgfCBudWxsID0gbnVsbDtcblxuZnVuY3Rpb24gc2V0VGFza3NPcGVuKG9wZW46IGJvb2xlYW4sIG9wZW5lcj86IEhUTUxFbGVtZW50IHwgbnVsbCkge1xuICBjb25zdCBjYW5PcGVuID0gbW9iaWxlTGF5b3V0Lm1hdGNoZXMgJiYgISQoXCJ0YWxrXCIpLmhpZGRlbjtcbiAgY29uc3QgbmV4dCA9IG9wZW4gJiYgY2FuT3BlbjtcbiAgY29uc3Qgd2FzT3BlbiA9IGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LmNvbnRhaW5zKFwidGFza3Mtb3BlblwiKTtcbiAgZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QudG9nZ2xlKFwidGFza3Mtb3BlblwiLCBuZXh0KTtcbiAgY29uc3QgaGVhZGVyID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihcImhlYWRlclwiKSBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gIGlmIChoZWFkZXIpIGhlYWRlci5pbmVydCA9IG5leHQ7XG4gICQoXCJjb252b1wiKS5pbmVydCA9IG5leHQ7XG4gICQoXCJzaWRlXCIpLmluZXJ0ID0gbW9iaWxlTGF5b3V0Lm1hdGNoZXMgJiYgIW5leHQ7XG4gICQoXCJ0YXNrcy10b2dnbGVcIikuc2V0QXR0cmlidXRlKFwiYXJpYS1leHBhbmRlZFwiLCBTdHJpbmcobmV4dCkpO1xuICAkKFwibW9iaWxlLXRhc2tzLWJhclwiKS5zZXRBdHRyaWJ1dGUoXCJhcmlhLWV4cGFuZGVkXCIsIFN0cmluZyhuZXh0KSk7XG4gIGlmIChuZXh0ICYmICF3YXNPcGVuKSB7XG4gICAgZHJhd2VyT3BlbmVyID0gb3BlbmVyID8/IChkb2N1bWVudC5hY3RpdmVFbGVtZW50IGFzIEhUTUxFbGVtZW50IHwgbnVsbCk7XG4gICAgJChcInRhc2tzLWNsb3NlXCIpLmZvY3VzKCk7XG4gIH0gZWxzZSBpZiAoIW5leHQgJiYgd2FzT3Blbikge1xuICAgIGNvbnN0IHRhcmdldCA9IGRyYXdlck9wZW5lcjtcbiAgICBkcmF3ZXJPcGVuZXIgPSBudWxsO1xuICAgIGlmICh0YXJnZXQgJiYgdGFyZ2V0LmlzQ29ubmVjdGVkICYmICF0YXJnZXQuaGlkZGVuICYmIHRhcmdldC5vZmZzZXRQYXJlbnQgIT09IG51bGwpIHRhcmdldC5mb2N1cygpO1xuICB9XG59XG5cbmZ1bmN0aW9uIHRhYnMoKSB7XG4gIGNvbnN0IHZpZXdzOiBSZWNvcmQ8c3RyaW5nLCBIVE1MRWxlbWVudD4gPSB7IHRhbGs6ICQoXCJ0YWxrXCIpLCBkZXY6ICQoXCJkZXZcIiksIHJlcGxheTogJChcInJlcGxheW1haW5cIikgfTtcbiAgZm9yIChjb25zdCBuYW1lIG9mIE9iamVjdC5rZXlzKHZpZXdzKSkge1xuICAgICQoYHRhYi0ke25hbWV9YCkub25jbGljayA9ICgpID0+IHtcbiAgICAgIGZvciAoY29uc3QgW290aGVyLCBlbF0gb2YgT2JqZWN0LmVudHJpZXModmlld3MpKSB7XG4gICAgICAgIGVsLmhpZGRlbiA9IG90aGVyICE9PSBuYW1lO1xuICAgICAgICAkKGB0YWItJHtvdGhlcn1gKS5jbGFzc0xpc3QudG9nZ2xlKFwib25cIiwgb3RoZXIgPT09IG5hbWUpO1xuICAgICAgfVxuICAgICAgJChcInRhc2tzLXRvZ2dsZVwiKS5oaWRkZW4gPSBuYW1lICE9PSBcInRhbGtcIjtcbiAgICAgIHNldFRhc2tzT3BlbihmYWxzZSk7XG4gICAgfTtcbiAgfVxuICAkKFwiZ2VhclwiKS5vbmNsaWNrID0gKCkgPT4geyAkKFwic2V0dGluZ3NcIikuaGlkZGVuID0gZmFsc2U7IH07XG4gICQoXCJjbG9zZXNldHRpbmdzXCIpLm9uY2xpY2sgPSAoKSA9PiB7ICQoXCJzZXR0aW5nc1wiKS5oaWRkZW4gPSB0cnVlOyB9O1xuICAkKFwiY2xvc2VzZXR0aW5ncy14XCIpLm9uY2xpY2sgPSAoKSA9PiB7ICQoXCJzZXR0aW5nc1wiKS5oaWRkZW4gPSB0cnVlOyB9O1xuICAkKFwic2V0dGluZ3NcIikub25jbGljayA9IChlKSA9PiB7IGlmIChlLnRhcmdldCA9PT0gJChcInNldHRpbmdzXCIpKSAkKFwic2V0dGluZ3NcIikuaGlkZGVuID0gdHJ1ZTsgfTtcbiAgJChcInRhc2tzLXRvZ2dsZVwiKS5vbmNsaWNrID0gKCkgPT4gc2V0VGFza3NPcGVuKCFkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5jb250YWlucyhcInRhc2tzLW9wZW5cIiksICQoXCJ0YXNrcy10b2dnbGVcIikpO1xuICAkKFwibW9iaWxlLXRhc2tzLWJhclwiKS5vbmNsaWNrID0gKCkgPT4gc2V0VGFza3NPcGVuKHRydWUsICQoXCJtb2JpbGUtdGFza3MtYmFyXCIpKTtcbiAgJChcInRhc2tzLWNsb3NlXCIpLm9uY2xpY2sgPSAoKSA9PiBzZXRUYXNrc09wZW4oZmFsc2UpO1xuICAkKFwic2lkZS1iYWNrZHJvcFwiKS5vbmNsaWNrID0gKCkgPT4gc2V0VGFza3NPcGVuKGZhbHNlKTtcbiAgbW9iaWxlTGF5b3V0LmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4gc2V0VGFza3NPcGVuKGZhbHNlKSk7XG4gIHNldFRhc2tzT3BlbihmYWxzZSk7XG59XG5cbmZ1bmN0aW9uIHR5cGluZygpOiBib29sZWFuIHtcbiAgY29uc3QgZWwgPSBkb2N1bWVudC5hY3RpdmVFbGVtZW50IGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgcmV0dXJuICEhZWwgJiYgKGVsLnRhZ05hbWUgPT09IFwiSU5QVVRcIiB8fCBlbC50YWdOYW1lID09PSBcIlRFWFRBUkVBXCIgfHwgZWwudGFnTmFtZSA9PT0gXCJTRUxFQ1RcIiB8fCBlbC5pc0NvbnRlbnRFZGl0YWJsZSk7XG59XG5cbmZ1bmN0aW9uIGtleXMoKSB7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJrZXlkb3duXCIsIChlKSA9PiB7XG4gICAgaWYgKGUua2V5ID09PSBcIkVzY2FwZVwiKSB7XG4gICAgICBpZiAoISQoXCJzZXR0aW5nc1wiKS5oaWRkZW4pIHsgJChcInNldHRpbmdzXCIpLmhpZGRlbiA9IHRydWU7IHJldHVybjsgfVxuICAgICAgaWYgKGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LmNvbnRhaW5zKFwidGFza3Mtb3BlblwiKSAmJiBtb2JpbGVMYXlvdXQubWF0Y2hlcyAmJiAhJChcInRhbGtcIikuaGlkZGVuKSB7IHNldFRhc2tzT3BlbihmYWxzZSk7IHJldHVybjsgfVxuICAgICAgaWYgKGNhbGxJZCkgeyBwdXNoKHsgdHlwZTogXCJpbnRlcnJ1cHRcIiB9KTsgYXVkaW8uZmx1c2goKTsgcmV0dXJuOyB9XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICh0eXBpbmcoKSB8fCAhJChcInNldHRpbmdzXCIpLmhpZGRlbiB8fCBkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5jb250YWlucyhcInRhc2tzLW9wZW5cIikgfHwgZS5tZXRhS2V5IHx8IGUuY3RybEtleSB8fCBlLmFsdEtleSkgcmV0dXJuO1xuICAgIGlmIChlLmtleSA9PT0gXCJtXCIgfHwgZS5rZXkgPT09IFwiTVwiKSB7IHNldE11dGVkKCFtdXRlZCk7IGUucHJldmVudERlZmF1bHQoKTsgfVxuICAgIGVsc2UgaWYgKGUua2V5ID09PSBcIi9cIikgeyAkKFwidGV4dFwiKS5mb2N1cygpOyBlLnByZXZlbnREZWZhdWx0KCk7IH1cbiAgICBlbHNlIGlmIChlLmNvZGUgPT09IFwiU3BhY2VcIiAmJiBjYWxsSWQgJiYgbXV0ZWQgJiYgIWUucmVwZWF0KSB7IGhvbGRpbmcgPSB0cnVlOyBwdXNoKHsgdHlwZTogXCJ1bm11dGVcIiB9KTsgc2hvd1N0YXR1cygpOyBlLnByZXZlbnREZWZhdWx0KCk7IH1cbiAgfSk7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJrZXl1cFwiLCAoZSkgPT4ge1xuICAgIGlmIChlLmNvZGUgPT09IFwiU3BhY2VcIiAmJiBob2xkaW5nKSB7IGhvbGRpbmcgPSBmYWxzZTsgcHVzaCh7IHR5cGU6IFwibXV0ZVwiIH0pOyBzaG93U3RhdHVzKCk7IH1cbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHN1Ym1pdFRleHQoZTogRXZlbnQpIHtcbiAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICBjb25zdCBpbnB1dCA9ICQ8SFRNTElucHV0RWxlbWVudD4oXCJ0ZXh0XCIpO1xuICBsZXQgdGV4dCA9IGlucHV0LnZhbHVlLnRyaW0oKTtcbiAgaWYgKCF0ZXh0KSByZXR1cm47XG4gIC8vIFdpdGggbm8gY2FsbCBvbiwgdHlwaW5nIHN0YXJ0cyBhIGNoYXQ6IHRoZSBzYW1lIG1haW4gdGhyZWFkLCBpbiB0ZXh0LlxuICBpZiAoIWNhbGxJZCkge1xuICAgIGlucHV0LnZhbHVlID0gXCJcIjtcbiAgICBzeW5jQ29tcG9zZXIoKTtcbiAgICB0cnkgeyBhd2FpdCBzdGFydChmYWxzZSwgdHJ1ZSk7IH0gY2F0Y2ggKGVycikgeyB0b2FzdCgoZXJyIGFzIEVycm9yKS5tZXNzYWdlKTsgbG9nKFwiZXJyb3JcIiwgKGVyciBhcyBFcnJvcikubWVzc2FnZSwgXCJlcnJcIik7IH1cbiAgICBpZiAoIWNhbGxJZCkgeyBpbnB1dC52YWx1ZSA9IHRleHQ7IHN5bmNDb21wb3NlcigpOyByZXR1cm47IH1cbiAgfVxuICAvLyBcIi90MyBcdTIwMjZcIiBhbmQgXCIvaCBcdTIwMjZcIiBwaWNrIHRoZSBhZ2VudCB3aGF0ZXZlciB0aGUgc2VsZWN0b3Igc2F5cy5cbiAgY29uc3QgcGFyc2VkID0gcGFyc2VQcmVmaXgodGV4dCk7XG4gIGNvbnN0IG1vZGUgPSBwYXJzZWQubW9kZSA/PyAkPEhUTUxTZWxlY3RFbGVtZW50PihcIm1vZGVcIikudmFsdWU7XG4gIHRleHQgPSBwYXJzZWQucmVzdDtcbiAgaWYgKCF0ZXh0KSByZXR1cm47XG4gIGlmIChtb2RlID09PSBcInNheVwiKSBwdXNoKHsgdHlwZTogXCJzYXlcIiwgdGV4dCB9KTtcbiAgZWxzZSB7XG4gICAgcHVzaCh7IHR5cGU6IFwiYXNrXCIsIHRleHQsIGFnZW50OiBtb2RlIH0pO1xuICAgIG5vdGUoYFlvdSBcdTIxOTIgbmV3ICR7bW9kZSA9PT0gXCJ0M1wiID8gXCJjb2RpbmdcIiA6IFwiSGVybWVzXCJ9IHRhc2s6ICR7dGV4dH1gKTtcbiAgfVxuICBpbnB1dC52YWx1ZSA9IFwiXCI7XG4gIHN5bmNDb21wb3NlcigpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBtYWluKCkge1xuICBhcHBseVRoZW1lKGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UudGhlbWVcIikgPz8gXCJzeXN0ZW1cIik7XG4gIHNlcnZlciA9IGF3YWl0IChhd2FpdCBmZXRjaChcIi9jb25maWdcIikpLmpzb24oKTtcbiAgJChcInJvdXRlXCIpLnRleHRDb250ZW50ID0gYCR7c2VydmVyLnJvdXRlID09PSBcInZlcnRleFwiID8gXCJWZXJ0ZXhcIiA6IFwiR2VtaW5pIEFQSVwifSBcdTAwQjcgJHtzZXJ2ZXIubW9kZWwuc3BsaXQoXCIvXCIpLnBvcCgpfWA7XG4gICQoXCJ2ZXJzaW9uXCIpLnRleHRDb250ZW50ID0gc2VydmVyLnZlcnNpb247XG4gICQoXCJidWlsZFwiKS50ZXh0Q29udGVudCA9IGBjb3JlICR7c2VydmVyLnZlcnNpb259YDtcbiAgc2V0dGluZ3NGcm9tU3RvcmFnZSgpO1xuICBpZiAoIXNlcnZlci5oZXJtZXMpIHsgJDxIVE1MSW5wdXRFbGVtZW50PihcImZha2VoZXJtZXNcIikuY2hlY2tlZCA9IHRydWU7ICQ8SFRNTElucHV0RWxlbWVudD4oXCJmYWtlaGVybWVzXCIpLmRpc2FibGVkID0gdHJ1ZTsgfVxuICBpZiAoIXNlcnZlci50MykgJChcImNvZGluZ2hlbHBcIikudGV4dENvbnRlbnQgPSBcIlQzIGlzbid0IGF2YWlsYWJsZSBvbiB0aGUgc2VydmVyOiBvbmx5IHdpdGggZmFrZSBhbnN3ZXJzLlwiO1xuICBlbHNlICQoXCJjb2RpbmdoZWxwXCIpLnRleHRDb250ZW50ID0gYENvZGUgY2hhbmdlcyBnbyB0byBhIFQzIENvZGUgdGhyZWFkIGluIG9uZSBvZjogJHtzZXJ2ZXIudDMuam9pbihcIiwgXCIpfS5gO1xuICBpZiAoIXN0b3BXb3Jkcy5zdXBwb3J0ZWQpIHsgJDxIVE1MSW5wdXRFbGVtZW50PihcInN0b3B3b3JkXCIpLmNoZWNrZWQgPSBmYWxzZTsgJDxIVE1MSW5wdXRFbGVtZW50PihcInN0b3B3b3JkXCIpLmRpc2FibGVkID0gdHJ1ZTsgfVxuICBjb25zdCBwcmVzZXQgPSAkPEhUTUxTZWxlY3RFbGVtZW50PihcInByZXNldFwiKTtcbiAgZm9yIChjb25zdCBuYW1lIG9mIE9iamVjdC5rZXlzKFBSRVNFVFMpKSBwcmVzZXQuYWRkKG5ldyBPcHRpb24obmFtZSwgbmFtZSkpO1xuICBwcmVzZXQudmFsdWUgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLWNvcmUucHJlc2V0XCIpID8/IFwid2ViXCI7XG4gIGlmICghUFJFU0VUU1twcmVzZXQudmFsdWVdKSBwcmVzZXQudmFsdWUgPSBcIndlYlwiO1xuICAkPEhUTUxUZXh0QXJlYUVsZW1lbnQ+KFwiY29uZmlnXCIpLnZhbHVlID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS1jb3JlLmNvbmZpZ1wiKSA/PyBKU09OLnN0cmluZ2lmeShQUkVTRVRTW3ByZXNldC52YWx1ZV0sIG51bGwsIDIpO1xuICBwcmVzZXQub25jaGFuZ2UgPSAoKSA9PiB7XG4gICAgJDxIVE1MVGV4dEFyZWFFbGVtZW50PihcImNvbmZpZ1wiKS52YWx1ZSA9IEpTT04uc3RyaW5naWZ5KFBSRVNFVFNbcHJlc2V0LnZhbHVlXSwgbnVsbCwgMik7XG4gICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS1jb3JlLnByZXNldFwiLCBwcmVzZXQudmFsdWUpO1xuICAgIGxvY2FsU3RvcmFnZS5yZW1vdmVJdGVtKFwidm9pY2UtY29yZS5jb25maWdcIik7XG4gIH07XG4gICQoXCJjb25maWdcIikub25pbnB1dCA9ICgpID0+IGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2UtY29yZS5jb25maWdcIiwgJDxIVE1MVGV4dEFyZWFFbGVtZW50PihcImNvbmZpZ1wiKS52YWx1ZSk7XG4gICQoXCJkZWZhdWx0c1wiKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGMgPSBjb3JlID8/IChhd2FpdCBsb2FkQ29yZSgpKTtcbiAgICAkKFwiZGVmYXVsdHN2aWV3XCIpLnRleHRDb250ZW50ID0gSlNPTi5zdHJpbmdpZnkoSlNPTi5wYXJzZShjLmRlZmF1bHRzKCkpLCBudWxsLCAyKTtcbiAgICAkKFwiZGVmYXVsdHN2aWV3XCIpLmhpZGRlbiA9ICEkKFwiZGVmYXVsdHN2aWV3XCIpLmhpZGRlbjtcbiAgfTtcbiAgY29uc3Qgb25DYWxsQ2xpY2sgPSAoKSA9PiB2b2lkIGNhbGxCdXR0b24oKS5jYXRjaCgoZXJyKSA9PiB7IHRvYXN0KGVyci5tZXNzYWdlKTsgbG9nKFwiZXJyb3JcIiwgZXJyLm1lc3NhZ2UsIFwiZXJyXCIpOyB9KTtcbiAgY29uc3Qgb25IZXJvQ2FsbENsaWNrID0gKCkgPT4geyBpZiAoIWNhbGxJZCkgdm9pZCBzdGFydCgpLmNhdGNoKChlcnIpID0+IHsgdG9hc3QoZXJyLm1lc3NhZ2UpOyBsb2coXCJlcnJvclwiLCBlcnIubWVzc2FnZSwgXCJlcnJcIik7IH0pOyB9O1xuICBjb25zdCBvblJlc3VtZUNsaWNrID0gKCkgPT4gdm9pZCBzdGFydCh0cnVlKS5jYXRjaCgoZXJyKSA9PiB7IHRvYXN0KGVyci5tZXNzYWdlKTsgbG9nKFwiZXJyb3JcIiwgZXJyLm1lc3NhZ2UsIFwiZXJyXCIpOyB9KTtcbiAgJChcImNhbGxcIikub25jbGljayA9IG9uQ2FsbENsaWNrO1xuICAkKFwiaGVyby1jYWxsXCIpLm9uY2xpY2sgPSBvbkhlcm9DYWxsQ2xpY2s7XG4gICQoXCJyZXN1bWVcIikub25jbGljayA9IG9uUmVzdW1lQ2xpY2s7XG4gICQoXCJoZXJvLXJlc3VtZVwiKS5vbmNsaWNrID0gb25SZXN1bWVDbGljaztcbiAgaWYgKHNhdmVkSGlzdG9yeSgpLmxlbmd0aCA+IDApIHtcbiAgICBzeW5jUmVzdW1lQnV0dG9ucyh0cnVlKTtcbiAgICAkKFwicmVzdW1lXCIpLnRpdGxlID0gXCJDYWxsIGFnYWluLCBjYXJyeWluZyBvbiBmcm9tIHRoZSBsYXN0IGNvbnZlcnNhdGlvblwiO1xuICB9XG4gICQoXCJtaWNcIikub25jbGljayA9ICgpID0+IHNldE11dGVkKCFtdXRlZCk7XG4gICQoXCJodXNoXCIpLm9uY2xpY2sgPSAoKSA9PiB7IHB1c2goeyB0eXBlOiBcImludGVycnVwdFwiIH0pOyBhdWRpby5mbHVzaCgpOyB9O1xuICAkKFwiY2FuY2VsYWxsXCIpLm9uY2xpY2sgPSAoKSA9PiBwdXNoKHsgdHlwZTogXCJjYW5jZWxBbGxcIiB9KTtcbiAgJChcImRvbmVib3hcIikuYWRkRXZlbnRMaXN0ZW5lcihcInRvZ2dsZVwiLCAoKSA9PiB7IGlmICgkPEhUTUxEZXRhaWxzRWxlbWVudD4oXCJkb25lYm94XCIpLm9wZW4pICQoXCJkb25lYm94XCIpLnNjcm9sbEludG9WaWV3KHsgYmxvY2s6IFwibmVhcmVzdFwiIH0pOyB9KTtcbiAgJChcInNheVwiKS5vbnN1Ym1pdCA9IChlKSA9PiB2b2lkIHN1Ym1pdFRleHQoZSk7XG4gICQoXCJ0ZXh0XCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJpbnB1dFwiLCBzeW5jQ29tcG9zZXIpO1xuICAkKFwidHJhbnNjcmlwdFwiKS5hZGRFdmVudExpc3RlbmVyKFwic2Nyb2xsXCIsIHVwZGF0ZUp1bXBCdXR0b24sIHsgcGFzc2l2ZTogdHJ1ZSB9KTtcbiAgJChcImp1bXBib3R0b21cIikub25jbGljayA9ICgpID0+ICQoXCJ0cmFuc2NyaXB0XCIpLnNjcm9sbFRvKHsgdG9wOiAkKFwidHJhbnNjcmlwdFwiKS5zY3JvbGxIZWlnaHQsIGJlaGF2aW9yOiBcInNtb290aFwiIH0pO1xuICBzeW5jQ29tcG9zZXIoKTtcbiAgdGFicygpO1xuICBrZXlzKCk7XG4gIGNvbnN0IGV2ZW50cyA9IG5ldyBFdmVudFNvdXJjZShcIi9ldmVudHNcIik7XG4gIGV2ZW50cy5hZGRFdmVudExpc3RlbmVyKFwiY29yZVwiLCAoZSkgPT4ge1xuICAgIGNvbnN0IHsgdmVyc2lvbiB9ID0gSlNPTi5wYXJzZSgoZSBhcyBNZXNzYWdlRXZlbnQpLmRhdGEpO1xuICAgICQoXCJ2ZXJzaW9uXCIpLnRleHRDb250ZW50ID0gdmVyc2lvbiArIChjYWxsSWQgJiYgY29yZSAmJiBjb3JlLnZlcnNpb24gIT09IHZlcnNpb24gPyBgIChuZXh0IGNhbGw7IHRoaXMgb25lIHJ1bnMgJHtjb3JlLnZlcnNpb259KWAgOiBcIlwiKTtcbiAgICAkKFwiYnVpbGRcIikudGV4dENvbnRlbnQgPSBgY29yZSAke3ZlcnNpb259YDtcbiAgfSk7XG4gIGV2ZW50cy5hZGRFdmVudExpc3RlbmVyKFwiYXBwXCIsICgpID0+IHsgaWYgKCFjYWxsSWQpIGxvY2F0aW9uLnJlbG9hZCgpOyBlbHNlIHRvYXN0KFwiVGhlIHBhZ2UgY2hhbmdlZDogcmVsb2FkIGFmdGVyIHRoaXMgY2FsbFwiKTsgfSk7XG4gIGV2ZW50cy5hZGRFdmVudExpc3RlbmVyKFwiZXJyb3JcIiwgKGUpID0+IHtcbiAgICBjb25zdCBkYXRhID0gKGUgYXMgTWVzc2FnZUV2ZW50KS5kYXRhO1xuICAgIGlmIChkYXRhKSB0b2FzdChgQnVpbGQgZmFpbGVkOiAke0pTT04ucGFyc2UoZGF0YSkubWVzc2FnZX1gKTtcbiAgfSk7XG4gIG5ldyBSZXBsYXkoJChcInJlcGxheVwiKSwgbG9hZENvcmUpO1xuICB2b2lkIHBpbmcoKTtcbiAgdm9pZCBzaG93RWFybGllcigpO1xuICB3aW5kb3cuc2V0SW50ZXJ2YWwoKCkgPT4gdm9pZCBzaG93RWFybGllcigpLCAzMF8wMDApO1xufVxuXG52b2lkIG1haW4oKTtcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFTQSxJQUFNLFNBQVMsb0JBQUksSUFBSTtBQUFBLEVBQ3JCO0FBQUEsRUFBTztBQUFBLEVBQU07QUFBQSxFQUFRO0FBQUEsRUFBVTtBQUFBLEVBQU87QUFBQSxFQUFRO0FBQUEsRUFBTTtBQUFBLEVBQU07QUFBQSxFQUFNO0FBQUEsRUFBTTtBQUFBLEVBQVc7QUFBQSxFQUFTO0FBQUEsRUFBUTtBQUFBLEVBQU87QUFBQSxFQUFVO0FBQUEsRUFBUztBQUFBLEVBQzVIO0FBQ0YsQ0FBQztBQUdNLFNBQVMsTUFBTSxNQUF3QjtBQUM1QyxTQUFPLEtBQUssWUFBWSxFQUFFLFFBQVEsVUFBVSxFQUFFLEVBQUUsUUFBUSxxQkFBcUIsR0FBRyxFQUFFLEtBQUssRUFBRSxNQUFNLEdBQUcsRUFBRSxPQUFPLENBQUMsTUFBTSxFQUFFLFNBQVMsQ0FBQztBQUNoSTtBQUdPLFNBQVMsVUFBVSxXQUFtQixVQUF5QixRQUFrQixDQUFDLEdBQXdCO0FBQy9HLFFBQU0sVUFBVSxvQkFBSSxJQUFJLENBQUMsR0FBRyxRQUFRLEdBQUcsTUFBTSxRQUFRLEtBQUssQ0FBQyxDQUFDO0FBQzVELFFBQU0sT0FBTyxNQUFNLFNBQVM7QUFDNUIsTUFBSSxPQUFPO0FBQ1gsTUFBSSxLQUFLLEtBQUs7QUFDZCxTQUFPLE9BQU8sTUFBTSxRQUFRLElBQUksS0FBSyxJQUFJLENBQUMsRUFBRztBQUM3QyxTQUFPLEtBQUssUUFBUSxRQUFRLElBQUksS0FBSyxLQUFLLENBQUMsQ0FBQyxFQUFHO0FBQy9DLE1BQUksU0FBUyxNQUFNLEtBQUssT0FBTyxFQUFHLFFBQU87QUFDekMsUUFBTUEsUUFBTyxLQUFLLE1BQU0sTUFBTSxFQUFFLEVBQUUsS0FBSyxHQUFHO0FBQzFDLFFBQU0sS0FBSyxDQUFDLFlBQXNCLFFBQVEsS0FBSyxDQUFDLE1BQU0sTUFBTSxDQUFDLEVBQUUsS0FBSyxHQUFHLE1BQU1BLEtBQUk7QUFDakYsTUFBSSxHQUFHLFNBQVMsTUFBTSxFQUFHLFFBQU87QUFDaEMsTUFBSSxHQUFHLFNBQVMsYUFBYSxDQUFDLENBQUMsRUFBRyxRQUFPO0FBQ3pDLE1BQUksR0FBRyxTQUFTLElBQUksRUFBRyxRQUFPO0FBQzlCLFNBQU87QUFDVDs7O0FDOUJBLElBQU0sV0FBVztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUEyRmpCLFNBQVMsY0FBYyxLQUF5QjtBQUM5QyxRQUFNLE1BQU0sS0FBSyxH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WUFBWSxTQUFTO0FBQ3hDLFNBQU8saUJBQWlCLFFBQVEsQ0FBQyxNQUFNO0FBQ3JDLFVBQU0sRUFBRSxRQUFRLElBQUksS0FBSyxNQUFPLEVBQW1CLElBQUk7QUFDdkQsTUFBRSxTQUFTLEVBQUUsY0FBYyxXQUFXLFVBQVUsUUFBUSxLQUFLLFlBQVksVUFBVSw4QkFBOEIsS0FBSyxPQUFPLE1BQU07QUFDbkksTUFBRSxPQUFPLEVBQUUsY0FBYyxRQUFRLE9BQU87QUFBQSxFQUMxQyxDQUFDO0FBQ0QsU0FBTyxpQkFBaUIsT0FBTyxNQUFNO0FBQUUsUUFBSSxDQUFDLE9BQVEsVUFBUyxPQUFPO0FBQUEsUUFBUSxPQUFNLDBDQUEwQztBQUFBLEVBQUcsQ0FBQztBQUNoSSxTQUFPLGlCQUFpQixTQUFTLENBQUMsTUFBTTtBQUN0QyxVQUFNLE9BQVEsRUFBbUI7QUFDakMsUUFBSSxLQUFNLE9BQU0saUJBQWlCLEtBQUssTUFBTSxJQUFJLEVBQUUsT0FBTyxFQUFFO0FBQUEsRUFDN0QsQ0FBQztBQUNELE1BQUksT0FBTyxFQUFFLFFBQVEsR0FBRyxRQUFRO0FBQ2hDLE9BQUssS0FBSztBQUNWLE9BQUssWUFBWTtBQUNqQixTQUFPLFlBQVksTUFBTSxLQUFLLFlBQVksR0FBRyxHQUFNO0FBQ3JEO0FBRUEsS0FBSyxLQUFLOyIsCiAgIm5hbWVzIjogWyJjb3JlIiwgImNvcmUiLCAibm93IiwgImxpdmUiLCAibGluZSIsICJydW4iXQp9Cg==
