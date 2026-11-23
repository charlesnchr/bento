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
  const raw = input.value;
  const trimmed = raw.trim();
  $("sendbtn").classList.toggle("ready", trimmed.length > 0);
  const parsed = parsePrefix(raw.trimStart());
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
    if (typing() || e.metaKey || e.ctrlKey || e.altKey) return;
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL2NvbW1hbmRzLnRzIiwgIi4uL2F1ZGlvLnRzIiwgIi4uL3JlcGxheS50cyIsICIuLi9hcHAudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFNwb2tlbiBjb21tYW5kcyB0aGUgY29yZSBhY3RzIG9uIHdpdGhvdXQgdGhlIG1vZGVsOiBcInN0b3BcIiBhbmQgXCJoYW5nIHVwXCIuIEFuIHV0dGVyYW5jZSBjb3VudHNcbi8vIG9ubHkgd2hlbiBpdCBpcyBvbmUgb2YgdGhlIHBocmFzZXMgYW5kIG5vdGhpbmcgbW9yZSwgb25jZSBuYW1lcyBhbmQgZmlsbGVycyBhcm91bmQgaXQgYXJlIGdvbmUsXG4vLyBzbyBcIldvb2Rob3VzZSwgc3RvcCBwbGVhc2VcIiBzdG9wcyBhbmQgXCJzdG9wIHRoZSBQZW5ueXdvcnRoIHRhc2tcIiBnb2VzIHRvIHRoZSBtb2RlbCBhcyB1c3VhbC5cblxuaW1wb3J0IHR5cGUgeyBWb2ljZUNvbW1hbmRzIH0gZnJvbSBcIi4vdHlwZXMudHNcIjtcblxuZXhwb3J0IHR5cGUgVm9pY2VDb21tYW5kID0gXCJzdG9wXCIgfCBcImhhbmdVcFwiIHwgXCJjYW5jZWxBbGxcIjtcblxuLyoqIFdvcmRzIHRoYXQgbWF5IGNvbWUgYmVmb3JlIG9yIGFmdGVyIGEgY29tbWFuZCB3aXRob3V0IGNoYW5naW5nIGl0LiAqL1xuY29uc3QgRklMTEVSID0gbmV3IFNldChbXG4gIFwiaGV5XCIsIFwib2tcIiwgXCJva2F5XCIsIFwicGxlYXNlXCIsIFwibm93XCIsIFwianVzdFwiLCBcInNvXCIsIFwidW1cIiwgXCJ1aFwiLCBcIm9oXCIsIFwiYWxyaWdodFwiLCBcInJpZ2h0XCIsIFwieWVhaFwiLCBcInllc1wiLCBcInRoYW5rc1wiLCBcInRoYW5rXCIsIFwieW91XCIsXG4gIFwiZ2VtaW5pXCIsXG5dKTtcblxuLyoqIFt0ZXh0XSBhcyBsb3dlci1jYXNlIHdvcmRzLCBhcG9zdHJvcGhlcyBkcm9wcGVkIChcIlRoYXQnc1wiIGlzIFwidGhhdHNcIikuICovXG5leHBvcnQgZnVuY3Rpb24gd29yZHModGV4dDogc3RyaW5nKTogc3RyaW5nW10ge1xuICByZXR1cm4gdGV4dC50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL1snXHUyMDE5YF0vZywgXCJcIikucmVwbGFjZSgvW15cXHB7TH1cXHB7TmR9XSsvZ3UsIFwiIFwiKS50cmltKCkuc3BsaXQoXCIgXCIpLmZpbHRlcigodykgPT4gdy5sZW5ndGggPiAwKTtcbn1cblxuLyoqIFRoZSBjb21tYW5kIFt1dHRlcmFuY2VdIGlzLCBpZiBpdCdzIG9uZSBhbmQgbm90aGluZyBtb3JlOyBbbmFtZXNdICh0aGUgYXNzaXN0YW50J3MsIFwiV29vZGhvdXNlXCIpIGRvbid0IGNvdW50LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbW1hbmRJbih1dHRlcmFuY2U6IHN0cmluZywgY29tbWFuZHM6IFZvaWNlQ29tbWFuZHMsIG5hbWVzOiBzdHJpbmdbXSA9IFtdKTogVm9pY2VDb21tYW5kIHwgbnVsbCB7XG4gIGNvbnN0IGlnbm9yZWQgPSBuZXcgU2V0KFsuLi5GSUxMRVIsIC4uLm5hbWVzLmZsYXRNYXAod29yZHMpXSk7XG4gIGNvbnN0IHNhaWQgPSB3b3Jkcyh1dHRlcmFuY2UpO1xuICBsZXQgZnJvbSA9IDA7XG4gIGxldCB0byA9IHNhaWQubGVuZ3RoO1xuICB3aGlsZSAoZnJvbSA8IHRvICYmIGlnbm9yZWQuaGFzKHNhaWRbZnJvbV0pKSBmcm9tKys7XG4gIHdoaWxlICh0byA+IGZyb20gJiYgaWdub3JlZC5oYXMoc2FpZFt0byAtIDFdKSkgdG8tLTtcbiAgaWYgKGZyb20gPT09IHRvIHx8IHRvIC0gZnJvbSA+IDUpIHJldHVybiBudWxsO1xuICBjb25zdCBjb3JlID0gc2FpZC5zbGljZShmcm9tLCB0bykuam9pbihcIiBcIik7XG4gIGNvbnN0IGlzID0gKHBocmFzZXM6IHN0cmluZ1tdKSA9PiBwaHJhc2VzLnNvbWUoKHApID0+IHdvcmRzKHApLmpvaW4oXCIgXCIpID09PSBjb3JlKTtcbiAgaWYgKGlzKGNvbW1hbmRzLmhhbmdVcCkpIHJldHVybiBcImhhbmdVcFwiO1xuICBpZiAoaXMoY29tbWFuZHMuY2FuY2VsQWxsID8/IFtdKSkgcmV0dXJuIFwiY2FuY2VsQWxsXCI7XG4gIGlmIChpcyhjb21tYW5kcy5zdG9wKSkgcmV0dXJuIFwic3RvcFwiO1xuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqIFdvcmRzIHRoYXQgdGFrZSBhIHJlcXVlc3QgYmFjay4gKi9cbmNvbnN0IENBTkNFTFMgPSAvXFxiKD86Y2FuY2VsXFx3KnxhYm9ydFxcdyp8a2lsbHxzY3JhcHxzY3JhdGNofGRyb3B8Zm9yZ2V0fHVuZG98dGVybWluYXRlfG5ldmVyID9taW5kfGNhbGwgKD86aXR8dGhhdHx0aGlzKSBvZmZ8KD86ZG9udHxkbyBub3QpICg/OmJvdGhlcnxuZWVkfHdhbnR8ZG8pfG5vIG5lZWR8bm8gbG9uZ2VyfG5vdCBhbnltb3JlfGxlYXZlIGl0fHNraXAgKD86aXR8dGhhdCkpXFxiLztcbmNvbnN0IFNUT1BTID0gL1xcYig/OnN0b3BcXHcqfGhhbHR8cXVpdHxlbmQpXFxiLztcblxuLyoqXG4gKiBXaGV0aGVyIFt1dHRlcmFuY2VdIGFza3MgZm9yIGEgdGFzayB0byBiZSBjYW5jZWxsZWQsIGZvciBhIGNhbmNlbF90YXNrIHRoZSBtb2RlbCBjYWxsZWQgb24gaXQuIFwiU3RvcFwiIGFsb25lIGFuZCB0aGVcbiAqIG90aGVyIHN0b3AgYW5kIGhhbmctdXAgcGhyYXNlcyBkb24ndDogdGhleSBtZWFuIHN0b3AgdGFsa2luZy4gT3RoZXJ3aXNlIGl0IGRvZXMgd2hlbiBpdCBzYXlzIHNvIGluIHdvcmRzLCB3aGVuIGl0XG4gKiBuYW1lcyB0aGUgdGFzayAoW25hbWVkXSksIG9yIHdoZW4gaXQgc2F5cyB0byBzdG9wIHNvbWV0aGluZyBtb3JlIHRoYW4gdGhlIHRhbGtpbmcgKFwic3RvcCB3b3JraW5nIG9uIHRoYXRcIikuXG4gKiBXb3JkcyB0aGF0IHNheSBub25lIG9mIHRoaXMgKGEgbWlzaGVhcmluZyBzdWNoIGFzIFwiU3RhYml0XCIpIGRvbid0LiBXaXRoIG5vdGhpbmcgaGVhcmQgdGhlcmUgaXMgbm90aGluZyB0byBqdWRnZSBieS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFza3NUb0NhbmNlbCh1dHRlcmFuY2U6IHN0cmluZywgY29tbWFuZHM6IFZvaWNlQ29tbWFuZHMsIG5hbWVzOiBzdHJpbmdbXSwgbmFtZWQ6IGJvb2xlYW4pOiBib29sZWFuIHtcbiAgY29uc3Qgc2FpZCA9IHdvcmRzKHV0dGVyYW5jZSkuam9pbihcIiBcIik7XG4gIGlmIChzYWlkLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHRydWU7XG4gIGNvbnN0IGNvbW1hbmQgPSBjb21tYW5kSW4odXR0ZXJhbmNlLCBjb21tYW5kcywgbmFtZXMpO1xuICBpZiAoY29tbWFuZCA9PT0gXCJzdG9wXCIgfHwgY29tbWFuZCA9PT0gXCJoYW5nVXBcIikgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gY29tbWFuZCA9PT0gXCJjYW5jZWxBbGxcIiB8fCBuYW1lZCB8fCBDQU5DRUxTLnRlc3Qoc2FpZCkgfHwgU1RPUFMudGVzdChzYWlkKTtcbn1cbiIsICIvLyBUaGUgYnJvd3NlcidzIG1pY3JvcGhvbmUgYW5kIHNwZWFrZXIgZm9yIGEgY2FsbDogMTYga0h6IFBDTTE2IGZyYW1lcyBvdXQgb2YgdGhlIG1pY3JvcGhvbmUsXG4vLyAyNCBrSHogUENNMTYgaW50byB0aGUgc3BlYWtlciwgYW5kIHRvbmVzIGxhaWQgb3ZlciB3aGF0ZXZlciBwbGF5cy4gQm90aCBydW4gaW4gQXVkaW9Xb3JrbGV0cyBvblxuLy8gb25lIEF1ZGlvQ29udGV4dCBhdCB0aGUgZGV2aWNlJ3MgcmF0ZSwgcmVzYW1wbGluZyB0aGVyZS5cblxuY29uc3QgV09SS0xFVFMgPSBgXG5jbGFzcyBDYXB0dXJlIGV4dGVuZHMgQXVkaW9Xb3JrbGV0UHJvY2Vzc29yIHtcbiAgY29uc3RydWN0b3IoKSB7XG4gICAgc3VwZXIoKTtcbiAgICB0aGlzLnN0ZXAgPSBzYW1wbGVSYXRlIC8gMTYwMDA7XG4gICAgdGhpcy5wb3MgPSAwO1xuICAgIHRoaXMuZnJhbWUgPSBuZXcgSW50MTZBcnJheSgzMjApO1xuICAgIHRoaXMubiA9IDA7XG4gICAgLy8gQSB3aW5kb3dlZC1zaW5jIGxvdy1wYXNzIGF0IDcga0h6LCBzbyBub3RoaW5nIGFib3ZlIDE2IGtIeidzIDgga0h6IGxpbWl0IGZvbGRzIGJhY2sgaW50byBzcGVlY2guXG4gICAgY29uc3QgdGFwcyA9IDQ3LCBjdXQgPSA3MDAwIC8gc2FtcGxlUmF0ZTtcbiAgICB0aGlzLnRhcHMgPSBuZXcgRmxvYXQzMkFycmF5KHRhcHMpO1xuICAgIGxldCBzdW0gPSAwO1xuICAgIGZvciAobGV0IGsgPSAwOyBrIDwgdGFwczsgaysrKSB7XG4gICAgICBjb25zdCBtID0gayAtICh0YXBzIC0gMSkgLyAyO1xuICAgICAgY29uc3Qgc2luYyA9IG0gPT09IDAgPyAyICogY3V0IDogTWF0aC5zaW4oMiAqIE1hdGguUEkgKiBjdXQgKiBtKSAvIChNYXRoLlBJICogbSk7XG4gICAgICBjb25zdCB3ID0gMC40MiAtIDAuNSAqIE1hdGguY29zKCgyICogTWF0aC5QSSAqIGspIC8gKHRhcHMgLSAxKSkgKyAwLjA4ICogTWF0aC5jb3MoKDQgKiBNYXRoLlBJICogaykgLyAodGFwcyAtIDEpKTtcbiAgICAgIHRoaXMudGFwc1trXSA9IHNpbmMgKiB3O1xuICAgICAgc3VtICs9IHRoaXMudGFwc1trXTtcbiAgICB9XG4gICAgZm9yIChsZXQgayA9IDA7IGsgPCB0YXBzOyBrKyspIHRoaXMudGFwc1trXSAvPSBzdW07XG4gICAgdGhpcy5oaXN0b3J5ID0gbmV3IEZsb2F0MzJBcnJheSh0YXBzKTtcbiAgICB0aGlzLmF0ID0gMDtcbiAgfVxuICBwcm9jZXNzKGlucHV0cykge1xuICAgIGNvbnN0IGlucHV0ID0gaW5wdXRzWzBdICYmIGlucHV0c1swXVswXTtcbiAgICBpZiAoIWlucHV0KSByZXR1cm4gdHJ1ZTtcbiAgICBjb25zdCB0YXBzID0gdGhpcy50YXBzLCBoID0gdGhpcy5oaXN0b3J5LCBuID0gdGFwcy5sZW5ndGg7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBpbnB1dC5sZW5ndGg7IGkrKykge1xuICAgICAgaFt0aGlzLmF0XSA9IGlucHV0W2ldO1xuICAgICAgdGhpcy5hdCA9ICh0aGlzLmF0ICsgMSkgJSBuO1xuICAgICAgLy8gT25seSB0aGUgc2FtcGxlcyBrZXB0IG5lZWQgZmlsdGVyaW5nOiBhdCBtb3N0IG9uZSBpbiBldmVyeSBzdGVwLlxuICAgICAgaWYgKHRoaXMucG9zID4gMSkgeyB0aGlzLnBvcyAtPSAxOyBjb250aW51ZTsgfVxuICAgICAgbGV0IHggPSAwO1xuICAgICAgZm9yIChsZXQgayA9IDAsIGogPSB0aGlzLmF0OyBrIDwgbjsgaysrLCBqID0gaiArIDEgPT09IG4gPyAwIDogaiArIDEpIHggKz0gdGFwc1trXSAqIGhbal07XG4gICAgICB3aGlsZSAodGhpcy5wb3MgPD0gMSkge1xuICAgICAgICBjb25zdCBzID0gTWF0aC5tYXgoLTEsIE1hdGgubWluKDEsIHgpKTtcbiAgICAgICAgdGhpcy5mcmFtZVt0aGlzLm4rK10gPSBzIDwgMCA/IHMgKiAzMjc2OCA6IHMgKiAzMjc2NztcbiAgICAgICAgaWYgKHRoaXMubiA9PT0gdGhpcy5mcmFtZS5sZW5ndGgpIHtcbiAgICAgICAgICB0aGlzLnBvcnQucG9zdE1lc3NhZ2UodGhpcy5mcmFtZS5idWZmZXIsIFt0aGlzLmZyYW1lLmJ1ZmZlcl0pO1xuICAgICAgICAgIHRoaXMuZnJhbWUgPSBuZXcgSW50MTZBcnJheSgzMjApO1xuICAgICAgICAgIHRoaXMubiA9IDA7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5wb3MgKz0gdGhpcy5zdGVwO1xuICAgICAgfVxuICAgICAgdGhpcy5wb3MgLT0gMTtcbiAgICB9XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbn1cblxuY2xhc3MgUGxheWJhY2sgZXh0ZW5kcyBBdWRpb1dvcmtsZXRQcm9jZXNzb3Ige1xuICBjb25zdHJ1Y3RvcigpIHtcbiAgICBzdXBlcigpO1xuICAgIHRoaXMucXVldWUgPSBbXTsgICAgICAvLyBGbG9hdDMyQXJyYXlzIGF0IHRoZSBjb250ZXh0J3MgcmF0ZVxuICAgIHRoaXMub2Zmc2V0ID0gMDtcbiAgICB0aGlzLmN1ZXMgPSBbXTtcbiAgICB0aGlzLmN1ZU9mZnNldCA9IDA7XG4gICAgdGhpcy5yZXBvcnRlZCA9IDA7XG4gICAgdGhpcy5wb3J0Lm9ubWVzc2FnZSA9IChlKSA9PiB7XG4gICAgICBjb25zdCBtID0gZS5kYXRhO1xuICAgICAgaWYgKG0udHlwZSA9PT0gXCJwbGF5XCIpIHRoaXMucXVldWUucHVzaChtLnNhbXBsZXMpO1xuICAgICAgZWxzZSBpZiAobS50eXBlID09PSBcImN1ZVwiKSB0aGlzLmN1ZXMucHVzaChtLnNhbXBsZXMpO1xuICAgICAgZWxzZSBpZiAobS50eXBlID09PSBcImZsdXNoXCIpIHsgdGhpcy5xdWV1ZSA9IFtdOyB0aGlzLm9mZnNldCA9IDA7IH1cbiAgICAgIGVsc2UgaWYgKG0udHlwZSA9PT0gXCJzdG9wXCIpIHsgdGhpcy5xdWV1ZSA9IFtdOyB0aGlzLm9mZnNldCA9IDA7IHRoaXMuY3VlcyA9IFtdOyB0aGlzLmN1ZU9mZnNldCA9IDA7IH1cbiAgICB9O1xuICB9XG4gIHByb2Nlc3MoXywgb3V0cHV0cykge1xuICAgIGNvbnN0IG91dCA9IG91dHB1dHNbMF1bMF07XG4gICAgb3V0LmZpbGwoMCk7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoICYmIHRoaXMucXVldWUubGVuZ3RoOyBpKyspIHtcbiAgICAgIG91dFtpXSA9IHRoaXMucXVldWVbMF1bdGhpcy5vZmZzZXQrK107XG4gICAgICBpZiAodGhpcy5vZmZzZXQgPj0gdGhpcy5xdWV1ZVswXS5sZW5ndGgpIHsgdGhpcy5xdWV1ZS5zaGlmdCgpOyB0aGlzLm9mZnNldCA9IDA7IH1cbiAgICB9XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoICYmIHRoaXMuY3Vlcy5sZW5ndGg7IGkrKykge1xuICAgICAgb3V0W2ldID0gTWF0aC5tYXgoLTEsIE1hdGgubWluKDEsIG91dFtpXSArIHRoaXMuY3Vlc1swXVt0aGlzLmN1ZU9mZnNldCsrXSkpO1xuICAgICAgaWYgKHRoaXMuY3VlT2Zmc2V0ID49IHRoaXMuY3Vlc1swXS5sZW5ndGgpIHsgdGhpcy5jdWVzLnNoaWZ0KCk7IHRoaXMuY3VlT2Zmc2V0ID0gMDsgfVxuICAgIH1cbiAgICBmb3IgKGxldCBjID0gMTsgYyA8IG91dHB1dHNbMF0ubGVuZ3RoOyBjKyspIG91dHB1dHNbMF1bY10uc2V0KG91dCk7XG4gICAgaWYgKGN1cnJlbnRUaW1lIC0gdGhpcy5yZXBvcnRlZCA+IDAuMSkge1xuICAgICAgdGhpcy5yZXBvcnRlZCA9IGN1cnJlbnRUaW1lO1xuICAgICAgbGV0IHF1ZXVlZCA9IC10aGlzLm9mZnNldDtcbiAgICAgIGZvciAoY29uc3QgcSBvZiB0aGlzLnF1ZXVlKSBxdWV1ZWQgKz0gcS5sZW5ndGg7XG4gICAgICB0aGlzLnBvcnQucG9zdE1lc3NhZ2UoeyBxdWV1ZWQ6IHF1ZXVlZCAvIHNhbXBsZVJhdGUgfSk7XG4gICAgfVxuICAgIHJldHVybiB0cnVlO1xuICB9XG59XG5yZWdpc3RlclByb2Nlc3NvcihcImNhcHR1cmVcIiwgQ2FwdHVyZSk7XG5yZWdpc3RlclByb2Nlc3NvcihcInBsYXliYWNrXCIsIFBsYXliYWNrKTtcbmA7XG5cbmZ1bmN0aW9uIGJhc2U2NFRvQnl0ZXMoYjY0OiBzdHJpbmcpOiBVaW50OEFycmF5IHtcbiAgY29uc3QgYmluID0gYXRvYihiNjQpO1xuICBjb25zdCBvdXQgPSBuZXcgVWludDhBcnJheShiaW4ubGVuZ3RoKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBiaW4ubGVuZ3RoOyBpKyspIG91dFtpXSA9IGJpbi5jaGFyQ29kZUF0KGkpO1xuICByZXR1cm4gb3V0O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYnl0ZXNUb0Jhc2U2NChieXRlczogVWludDhBcnJheSk6IHN0cmluZyB7XG4gIGxldCBiaW4gPSBcIlwiO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGJ5dGVzLmxlbmd0aDsgaSArPSAweDgwMDApIGJpbiArPSBTdHJpbmcuZnJvbUNoYXJDb2RlKC4uLmJ5dGVzLnN1YmFycmF5KGksIGkgKyAweDgwMDApKTtcbiAgcmV0dXJuIGJ0b2EoYmluKTtcbn1cblxuLyoqIFBDTTE2IGxpdHRsZS1lbmRpYW4gYXQgW3JhdGVdLCBhcyBmbG9hdHMgYXQgdGhlIGNvbnRleHQncyByYXRlLiAqL1xuZnVuY3Rpb24gdG9GbG9hdHMocGNtOiBVaW50OEFycmF5LCByYXRlOiBudW1iZXIsIHRhcmdldDogbnVtYmVyKTogRmxvYXQzMkFycmF5IHtcbiAgY29uc3QgdmlldyA9IG5ldyBEYXRhVmlldyhwY20uYnVmZmVyLCBwY20uYnl0ZU9mZnNldCwgcGNtLmJ5dGVMZW5ndGgpO1xuICBjb25zdCBuID0gTWF0aC5mbG9vcihwY20uYnl0ZUxlbmd0aCAvIDIpO1xuICBjb25zdCBvdXQgPSBuZXcgRmxvYXQzMkFycmF5KE1hdGguZmxvb3IoKG4gKiB0YXJnZXQpIC8gcmF0ZSkpO1xuICBjb25zdCBzdGVwID0gcmF0ZSAvIHRhcmdldDtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCB4ID0gaSAqIHN0ZXA7XG4gICAgY29uc3QgaiA9IE1hdGguZmxvb3IoeCk7XG4gICAgY29uc3QgYSA9IHZpZXcuZ2V0SW50MTYoMiAqIE1hdGgubWluKGosIG4gLSAxKSwgdHJ1ZSk7XG4gICAgY29uc3QgYiA9IHZpZXcuZ2V0SW50MTYoMiAqIE1hdGgubWluKGogKyAxLCBuIC0gMSksIHRydWUpO1xuICAgIG91dFtpXSA9IChhICsgKGIgLSBhKSAqICh4IC0gaikpIC8gMzI3Njg7XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBNaWNPcHRpb25zIHsgZWNob0NhbmNlbGxhdGlvbjogYm9vbGVhbjsgbm9pc2VTdXBwcmVzc2lvbjogYm9vbGVhbjsgYXV0b0dhaW5Db250cm9sOiBib29sZWFuIH1cblxuZXhwb3J0IGNsYXNzIENhbGxBdWRpbyB7XG4gIHByaXZhdGUgY29udGV4dDogQXVkaW9Db250ZXh0IHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgcGxheWJhY2s6IEF1ZGlvV29ya2xldE5vZGUgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBjYXB0dXJlOiBBdWRpb1dvcmtsZXROb2RlIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgc3RyZWFtOiBNZWRpYVN0cmVhbSB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIHNvdXJjZTogTWVkaWFTdHJlYW1BdWRpb1NvdXJjZU5vZGUgfCBudWxsID0gbnVsbDtcbiAgLyoqIFNlY29uZHMgb2Ygc3BlZWNoIHF1ZXVlZCwgYXMgdGhlIHdvcmtsZXQgbGFzdCBzYWlkLiAqL1xuICBxdWV1ZWQgPSAwO1xuICAvKiogVGhlIG1pY3JvcGhvbmUncyBsZXZlbCwgUk1TIG9mIHRoZSBsYXN0IGZyYW1lICgwIHRvIDEpLiAqL1xuICBsZXZlbCA9IDA7XG5cbiAgYXN5bmMgb3BlbigpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAodGhpcy5jb250ZXh0KSB7IGlmICh0aGlzLmNvbnRleHQuc3RhdGUgPT09IFwic3VzcGVuZGVkXCIpIGF3YWl0IHRoaXMuY29udGV4dC5yZXN1bWUoKTsgcmV0dXJuOyB9XG4gICAgdGhpcy5jb250ZXh0ID0gbmV3IEF1ZGlvQ29udGV4dCh7IGxhdGVuY3lIaW50OiBcImludGVyYWN0aXZlXCIgfSk7XG4gICAgY29uc3QgdXJsID0gVVJMLmNyZWF0ZU9iamVjdFVSTChuZXcgQmxvYihbV09SS0xFVFNdLCB7IHR5cGU6IFwidGV4dC9qYXZhc2NyaXB0XCIgfSkpO1xuICAgIGF3YWl0IHRoaXMuY29udGV4dC5hdWRpb1dvcmtsZXQuYWRkTW9kdWxlKHVybCk7XG4gICAgdGhpcy5wbGF5YmFjayA9IG5ldyBBdWRpb1dvcmtsZXROb2RlKHRoaXMuY29udGV4dCwgXCJwbGF5YmFja1wiLCB7IG51bWJlck9mSW5wdXRzOiAwLCBvdXRwdXRDaGFubmVsQ291bnQ6IFsyXSB9KTtcbiAgICB0aGlzLnBsYXliYWNrLnBvcnQub25tZXNzYWdlID0gKGUpID0+IHsgdGhpcy5xdWV1ZWQgPSBlLmRhdGEucXVldWVkOyB9O1xuICAgIHRoaXMucGxheWJhY2suY29ubmVjdCh0aGlzLmNvbnRleHQuZGVzdGluYXRpb24pO1xuICB9XG5cbiAgLyoqIFNlY29uZHMgZnJvbSBhIHNhbXBsZSBsZWF2aW5nIHRoZSB3b3JrbGV0IHRvIHRoZSBzcGVha2VyLCBhcyB0aGUgYnJvd3NlciByZWNrb25zIGl0LiAqL1xuICBnZXQgb3V0cHV0TGF0ZW5jeSgpOiBudW1iZXIgfCBudWxsIHtcbiAgICBpZiAoIXRoaXMuY29udGV4dCkgcmV0dXJuIG51bGw7XG4gICAgcmV0dXJuIHRoaXMuY29udGV4dC5iYXNlTGF0ZW5jeSArICgodGhpcy5jb250ZXh0IGFzIEF1ZGlvQ29udGV4dCAmIHsgb3V0cHV0TGF0ZW5jeT86IG51bWJlciB9KS5vdXRwdXRMYXRlbmN5ID8/IDApO1xuICB9XG5cbiAgYXN5bmMgc3RhcnRNaWMob25GcmFtZTogKHBjbTY0OiBzdHJpbmcsIGxldmVsOiBudW1iZXIpID0+IHZvaWQsIG9wdGlvbnM6IE1pY09wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBhd2FpdCB0aGlzLm9wZW4oKTtcbiAgICB0aGlzLnN0b3BNaWMoKTtcbiAgICBjb25zdCBjb250ZXh0ID0gdGhpcy5jb250ZXh0ITtcbiAgICB0aGlzLnN0cmVhbSA9IGF3YWl0IG5hdmlnYXRvci5tZWRpYURldmljZXMuZ2V0VXNlck1lZGlhKHsgYXVkaW86IHsgY2hhbm5lbENvdW50OiAxLCAuLi5vcHRpb25zIH0gfSk7XG4gICAgdGhpcy5zb3VyY2UgPSBjb250ZXh0LmNyZWF0ZU1lZGlhU3RyZWFtU291cmNlKHRoaXMuc3RyZWFtKTtcbiAgICB0aGlzLmNhcHR1cmUgPSBuZXcgQXVkaW9Xb3JrbGV0Tm9kZShjb250ZXh0LCBcImNhcHR1cmVcIiwgeyBudW1iZXJPZk91dHB1dHM6IDAgfSk7XG4gICAgdGhpcy5jYXB0dXJlLnBvcnQub25tZXNzYWdlID0gKGUpID0+IHtcbiAgICAgIGNvbnN0IGZyYW1lID0gbmV3IEludDE2QXJyYXkoZS5kYXRhIGFzIEFycmF5QnVmZmVyKTtcbiAgICAgIGxldCBzdW0gPSAwO1xuICAgICAgZm9yIChjb25zdCBzIG9mIGZyYW1lKSBzdW0gKz0gcyAqIHM7XG4gICAgICB0aGlzLmxldmVsID0gTWF0aC5zcXJ0KHN1bSAvIGZyYW1lLmxlbmd0aCkgLyAzMjc2ODtcbiAgICAgIG9uRnJhbWUoYnl0ZXNUb0Jhc2U2NChuZXcgVWludDhBcnJheShlLmRhdGEgYXMgQXJyYXlCdWZmZXIpKSwgdGhpcy5sZXZlbCk7XG4gICAgfTtcbiAgICB0aGlzLnNvdXJjZS5jb25uZWN0KHRoaXMuY2FwdHVyZSk7XG4gIH1cblxuICBzdG9wTWljKCk6IHZvaWQge1xuICAgIHRoaXMuc291cmNlPy5kaXNjb25uZWN0KCk7XG4gICAgdGhpcy5jYXB0dXJlPy5wb3J0LmNsb3NlKCk7XG4gICAgdGhpcy5zdHJlYW0/LmdldFRyYWNrcygpLmZvckVhY2goKHQpID0+IHQuc3RvcCgpKTtcbiAgICB0aGlzLnNvdXJjZSA9IG51bGw7XG4gICAgdGhpcy5jYXB0dXJlID0gbnVsbDtcbiAgICB0aGlzLnN0cmVhbSA9IG51bGw7XG4gIH1cblxuICBwbGF5KHBjbTY0OiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuY29udGV4dCB8fCAhdGhpcy5wbGF5YmFjaykgcmV0dXJuO1xuICAgIGNvbnN0IHNhbXBsZXMgPSB0b0Zsb2F0cyhiYXNlNjRUb0J5dGVzKHBjbTY0KSwgMjQwMDAsIHRoaXMuY29udGV4dC5zYW1wbGVSYXRlKTtcbiAgICB0aGlzLnBsYXliYWNrLnBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcInBsYXlcIiwgc2FtcGxlcyB9LCBbc2FtcGxlcy5idWZmZXJdKTtcbiAgfVxuXG4gIGN1ZShwY202NDogc3RyaW5nKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLmNvbnRleHQgfHwgIXRoaXMucGxheWJhY2spIHJldHVybjtcbiAgICBjb25zdCBzYW1wbGVzID0gdG9GbG9hdHMoYmFzZTY0VG9CeXRlcyhwY202NCksIDI0MDAwLCB0aGlzLmNvbnRleHQuc2FtcGxlUmF0ZSk7XG4gICAgdGhpcy5wbGF5YmFjay5wb3J0LnBvc3RNZXNzYWdlKHsgdHlwZTogXCJjdWVcIiwgc2FtcGxlcyB9LCBbc2FtcGxlcy5idWZmZXJdKTtcbiAgfVxuXG4gIGZsdXNoKCk6IHZvaWQge1xuICAgIHRoaXMucGxheWJhY2s/LnBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcImZsdXNoXCIgfSk7XG4gIH1cblxuICBzdG9wKCk6IHZvaWQge1xuICAgIHRoaXMuc3RvcE1pYygpO1xuICAgIHRoaXMucGxheWJhY2s/LnBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcInN0b3BcIiB9KTtcbiAgfVxufVxuIiwgIi8vIFRoZSByZXBsYXkgdmlldzogYSByZWNvcmRlZCBjYWxsIChhIHRyYWNlIGZyb20gYW55IGhvc3QsIG9yIGEgc2NlbmFyaW8pIHJ1biBhZ2FpbiB0aHJvdWdoIHRoZVxuLy8gY29yZSwgYXMgdGhlIGJ1aWxkIHRoYXQgcmVjb3JkZWQgaXQgZGlkIGFuZCBhcyB0aGUgbGF0ZXN0IGRvZXMsIHNpZGUgYnkgc2lkZS4gV2hlcmUgdGhleSBwYXJ0XG4vLyBpcyB3aGVyZSBhIGNoYW5nZSBpbiBzcmMvIGNoYW5nZWQgd2hhdCB0aGUgY2FsbCBkb2VzIHdpdGggdGhlIHNhbWUgd29yZHMgYW5kIHRoZSBzYW1lIG1vZGVsLlxuXG5pbnRlcmZhY2UgQ29yZSB7XG4gIHZlcnNpb246IHN0cmluZztcbiAgY3JlYXRlKGNvbmZpZzogc3RyaW5nLCB0OiBudW1iZXIpOiBzdHJpbmc7XG4gIHB1c2goaWQ6IG51bWJlciwgZXZlbnQ6IHN0cmluZyk6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFJlY29yZGluZyB7IHZlcnNpb24/OiBzdHJpbmc7IGNvbmZpZzogdW5rbm93bjsgc3RhcnQ6IG51bWJlcjsgZXZlbnRzOiBSZWNvcmQ8c3RyaW5nLCBhbnk+W10gfVxuXG4vKiogV2hhdCBhIGNvbW1hbmQgb3IgZXZlbnQgbG9va3MgbGlrZSBpbiBhIHRpbWVsaW5lOiBhdWRpbyBjdXQgb3V0LCBvbmUgbGluZS4gKi9cbmZ1bmN0aW9uIGxpbmUobzogUmVjb3JkPHN0cmluZywgYW55Pik6IHN0cmluZyB7XG4gIGNvbnN0IHRleHQgPSBKU09OLnN0cmluZ2lmeShvKS5yZXBsYWNlKC9cIihkYXRhfHBjbSlcIjpcIltBLVphLXowLTkrLz1dezQwLH1cIi9nLCAnXCIkMVwiOlwiXHUyMDI2XCInKVxuICAgIC5yZXBsYWNlKC9cXFxcXCJkYXRhXFxcXFwiOlxcXFxcIltBLVphLXowLTkrLz1dezQwLH1cXFxcXCIvZywgJ1xcXFxcImRhdGFcXFxcXCI6XFxcXFwiXHUyMDI2XFxcXFwiJyk7XG4gIHJldHVybiB0ZXh0Lmxlbmd0aCA+IDQwMCA/IHRleHQuc2xpY2UoMCwgNDAwKSArIFwiXHUyMDI2XCIgOiB0ZXh0O1xufVxuXG4vKiogQXVkaW8gYW5kIHRpY2tzIHNheSBub3RoaW5nIGEgcmVhZGVyIG5lZWRzOyB0aGUgcmVzdCBkb2VzLiAqL1xuZnVuY3Rpb24gdGVsbGluZyhvOiBSZWNvcmQ8c3RyaW5nLCBhbnk+KTogYm9vbGVhbiB7XG4gIGlmIChvLnR5cGUgPT09IFwibWljXCIgfHwgby50eXBlID09PSBcInRpY2tcIiB8fCBvLnR5cGUgPT09IFwicGxheVwiKSByZXR1cm4gZmFsc2U7XG4gIGlmIChvLnR5cGUgPT09IFwid3Muc2VuZFwiICYmIFN0cmluZyhvLmRhdGEpLnN0YXJ0c1dpdGgoJ3tcInJlYWx0aW1lSW5wdXRcIjp7XCJhdWRpb1wiJykpIHJldHVybiBmYWxzZTtcbiAgaWYgKG8udHlwZSA9PT0gXCJ3cy5tZXNzYWdlXCIgJiYgU3RyaW5nKG8uZGF0YSkuaW5jbHVkZXMoJ1wiaW5saW5lRGF0YVwiJykgJiYgIVN0cmluZyhvLmRhdGEpLmluY2x1ZGVzKCdcInR1cm5Db21wbGV0ZVwiJykpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmZ1bmN0aW9uIHJ1bihjb3JlOiBDb3JlLCByOiBSZWNvcmRpbmcpOiBzdHJpbmdbXVtdIHtcbiAgY29uc3QgY3JlYXRlZCA9IEpTT04ucGFyc2UoY29yZS5jcmVhdGUoSlNPTi5zdHJpbmdpZnkoci5jb25maWcpLCByLnN0YXJ0KSk7XG4gIGNvbnN0IG91dDogc3RyaW5nW11bXSA9IFtjcmVhdGVkLmNvbW1hbmRzLmZpbHRlcih0ZWxsaW5nKS5tYXAobGluZSldO1xuICBmb3IgKGNvbnN0IGUgb2Ygci5ldmVudHMpIG91dC5wdXNoKChKU09OLnBhcnNlKGNvcmUucHVzaChjcmVhdGVkLmlkLCBKU09OLnN0cmluZ2lmeShlKSkpIGFzIFJlY29yZDxzdHJpbmcsIGFueT5bXSkuZmlsdGVyKHRlbGxpbmcpLm1hcChsaW5lKSk7XG4gIHJldHVybiBvdXQ7XG59XG5cbmV4cG9ydCBjbGFzcyBSZXBsYXkge1xuICBwcml2YXRlIHJlYWRvbmx5IHJvb3Q6IEhUTUxFbGVtZW50O1xuICBwcml2YXRlIHJlYWRvbmx5IGxvYWQ6ICh1cmw/OiBzdHJpbmcpID0+IFByb21pc2U8Q29yZT47XG5cbiAgY29uc3RydWN0b3Iocm9vdDogSFRNTEVsZW1lbnQsIGxvYWQ6ICh1cmw/OiBzdHJpbmcpID0+IFByb21pc2U8Q29yZT4pIHtcbiAgICB0aGlzLnJvb3QgPSByb290O1xuICAgIHRoaXMubG9hZCA9IGxvYWQ7XG4gICAgcm9vdC5pbm5lckhUTUwgPSBgXG4gICAgICA8aDI+VHJhY2UgcmVwbGF5PC9oMj5cbiAgICAgIDxkaXYgY2xhc3M9XCJiYXJcIj48c2VsZWN0IGNsYXNzPVwicGlja1wiIGFyaWEtbGFiZWw9XCJSZWNvcmRpbmdcIj48L3NlbGVjdD48YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cInJlZnJlc2hcIiB0aXRsZT1cIlJlZnJlc2ggbGlzdFwiIGFyaWEtbGFiZWw9XCJSZWZyZXNoIGxpc3RcIj5cdTIxQkI8L2J1dHRvbj48YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cImdvXCI+UmVwbGF5PC9idXR0b24+XG4gICAgICA8bGFiZWwgY2xhc3M9XCJ0b2dnbGUtYWxsXCI+PGlucHV0IHR5cGU9XCJjaGVja2JveFwiIGNsYXNzPVwiYWxsXCI+IFNob3cgYXVkaW8gYW5kIHRpY2tzPC9sYWJlbD48c3BhbiBjbGFzcz1cInN1bW1hcnlcIj48L3NwYW4+PC9kaXY+XG4gICAgICA8ZGl2IGNsYXNzPVwidGltZWxpbmVcIj48L2Rpdj5gO1xuICAgIChyb290LnF1ZXJ5U2VsZWN0b3IoXCIucmVmcmVzaFwiKSBhcyBIVE1MRWxlbWVudCkub25jbGljayA9ICgpID0+IHZvaWQgdGhpcy5saXN0KCk7XG4gICAgKHJvb3QucXVlcnlTZWxlY3RvcihcIi5nb1wiKSBhcyBIVE1MRWxlbWVudCkub25jbGljayA9ICgpID0+IHZvaWQgdGhpcy5yZXBsYXkoKS5jYXRjaCgoZXJyKSA9PiB0aGlzLnNheShgUmVwbGF5IGZhaWxlZDogJHtlcnIubWVzc2FnZX1gKSk7XG4gICAgdm9pZCB0aGlzLmxpc3QoKTtcbiAgfVxuXG4gIHByaXZhdGUgc2F5KHRleHQ6IHN0cmluZykge1xuICAgICh0aGlzLnJvb3QucXVlcnlTZWxlY3RvcihcIi5zdW1tYXJ5XCIpIGFzIEhUTUxFbGVtZW50KS50ZXh0Q29udGVudCA9IHRleHQ7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGxpc3QoKSB7XG4gICAgY29uc3QgcGljayA9IHRoaXMucm9vdC5xdWVyeVNlbGVjdG9yKFwiLnBpY2tcIikgYXMgSFRNTFNlbGVjdEVsZW1lbnQ7XG4gICAgcGljay5pbm5lckhUTUwgPSBcIlwiO1xuICAgIGNvbnN0IHRyYWNlczogeyBuYW1lOiBzdHJpbmc7IGJ5dGVzOiBudW1iZXIgfVtdID0gYXdhaXQgKGF3YWl0IGZldGNoKFwiL3RyYWNlc1wiKSkuanNvbigpO1xuICAgIGNvbnN0IHNjZW5hcmlvczogc3RyaW5nW10gPSBhd2FpdCAoYXdhaXQgZmV0Y2goXCIvc2NlbmFyaW9zXCIpKS5qc29uKCk7XG4gICAgY29uc3QgdHJhY2VHcm91cCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJvcHRncm91cFwiKTtcbiAgICB0cmFjZUdyb3VwLmxhYmVsID0gXCJSZWNvcmRlZCBjYWxsc1wiO1xuICAgIGZvciAoY29uc3QgdCBvZiB0cmFjZXMpIHRyYWNlR3JvdXAuYXBwZW5kKG5ldyBPcHRpb24oYCR7dC5uYW1lfSAoJHtNYXRoLnJvdW5kKHQuYnl0ZXMgLyAxMDI0KX0gS0IpYCwgYC90cmFjZXMvJHt0Lm5hbWV9YCkpO1xuICAgIGNvbnN0IHNjZW5hcmlvR3JvdXAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwib3B0Z3JvdXBcIik7XG4gICAgc2NlbmFyaW9Hcm91cC5sYWJlbCA9IFwiU2NlbmFyaW9zXCI7XG4gICAgZm9yIChjb25zdCBzIG9mIHNjZW5hcmlvcykgc2NlbmFyaW9Hcm91cC5hcHBlbmQobmV3IE9wdGlvbihzLCBgL3NjZW5hcmlvcy8ke3N9Lmpzb25gKSk7XG4gICAgcGljay5hcHBlbmQodHJhY2VHcm91cCwgc2NlbmFyaW9Hcm91cCk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHJlY29yZGluZyh1cmw6IHN0cmluZyk6IFByb21pc2U8UmVjb3JkaW5nPiB7XG4gICAgY29uc3QgdGV4dCA9IGF3YWl0IChhd2FpdCBmZXRjaCh1cmwsIHsgY2FjaGU6IFwibm8tc3RvcmVcIiB9KSkudGV4dCgpO1xuICAgIGlmICh1cmwuZW5kc1dpdGgoXCIuanNvblwiKSkgcmV0dXJuIEpTT04ucGFyc2UodGV4dCk7XG4gICAgY29uc3QgW2hlYWRlciwgLi4uZXZlbnRzXSA9IHRleHQudHJpbSgpLnNwbGl0KFwiXFxuXCIpLm1hcCgobCkgPT4gSlNPTi5wYXJzZShsKSk7XG4gICAgcmV0dXJuIHsgLi4uaGVhZGVyLCBldmVudHMgfTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgcmVwbGF5KCkge1xuICAgIGNvbnN0IHVybCA9ICh0aGlzLnJvb3QucXVlcnlTZWxlY3RvcihcIi5waWNrXCIpIGFzIEhUTUxTZWxlY3RFbGVtZW50KS52YWx1ZTtcbiAgICBpZiAoIXVybCkgcmV0dXJuO1xuICAgIGNvbnN0IHIgPSBhd2FpdCB0aGlzLnJlY29yZGluZyh1cmwpO1xuICAgIGNvbnN0IGxhdGVzdCA9IGF3YWl0IHRoaXMubG9hZCgpO1xuICAgIGxldCByZWNvcmRlZDogQ29yZSB8IG51bGwgPSBudWxsO1xuICAgIGlmIChyLnZlcnNpb24gJiYgci52ZXJzaW9uICE9PSBsYXRlc3QudmVyc2lvbikge1xuICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChgL3ZlcnNpb25zLyR7ci52ZXJzaW9ufS5qc2AsIHsgbWV0aG9kOiBcIkhFQURcIiB9KTtcbiAgICAgIGlmIChyZXNwb25zZS5vaykgcmVjb3JkZWQgPSBhd2FpdCB0aGlzLmxvYWQoYC92ZXJzaW9ucy8ke3IudmVyc2lvbn0uanNgKTtcbiAgICB9XG4gICAgY29uc3Qgbm93ID0gcnVuKGxhdGVzdCwgcik7XG4gICAgY29uc3QgdGhlbiA9IHJlY29yZGVkID8gcnVuKHJlY29yZGVkLCByKSA6IG51bGw7XG4gICAgY29uc3QgYWxsID0gKHRoaXMucm9vdC5xdWVyeVNlbGVjdG9yKFwiLmFsbFwiKSBhcyBIVE1MSW5wdXRFbGVtZW50KS5jaGVja2VkO1xuICAgIGNvbnN0IHRpbWVsaW5lID0gdGhpcy5yb290LnF1ZXJ5U2VsZWN0b3IoXCIudGltZWxpbmVcIikgYXMgSFRNTEVsZW1lbnQ7XG4gICAgdGltZWxpbmUuaW5uZXJIVE1MID0gXCJcIjtcbiAgICBsZXQgZmlyc3QgPSAtMTtcbiAgICBsZXQgZGlmZmVyID0gMDtcbiAgICBjb25zdCByb3dzOiBIVE1MRWxlbWVudFtdID0gW107XG4gICAgY29uc3QgYWRkID0gKGNsczogc3RyaW5nLCB0OiBzdHJpbmcsIHRleHQ6IHN0cmluZykgPT4ge1xuICAgICAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgIHJvdy5jbGFzc05hbWUgPSBgcm93ICR7Y2xzfWA7XG4gICAgICByb3cuaW5uZXJIVE1MID0gYDxzcGFuIGNsYXNzPVwidFwiPiR7dH08L3NwYW4+YDtcbiAgICAgIGNvbnN0IGIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgICAgIGIuY2xhc3NOYW1lID0gXCJiXCI7XG4gICAgICBiLnRleHRDb250ZW50ID0gdGV4dDtcbiAgICAgIHJvdy5hcHBlbmQoYik7XG4gICAgICB0aW1lbGluZS5hcHBlbmQocm93KTtcbiAgICAgIHJvd3MucHVzaChyb3cpO1xuICAgICAgcmV0dXJuIHJvdztcbiAgICB9O1xuICAgIGNvbnN0IHQwID0gci5zdGFydDtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8PSByLmV2ZW50cy5sZW5ndGg7IGkrKykge1xuICAgICAgY29uc3QgZSA9IGkgPT09IDAgPyBudWxsIDogci5ldmVudHNbaSAtIDFdO1xuICAgICAgY29uc3Qgbm93T3V0ID0gbm93W2ldO1xuICAgICAgY29uc3QgdGhlbk91dCA9IHRoZW4gPyB0aGVuW2ldIDogbm93T3V0O1xuICAgICAgY29uc3Qgc2FtZSA9IG5vd091dC5sZW5ndGggPT09IHRoZW5PdXQubGVuZ3RoICYmIG5vd091dC5ldmVyeSgoYywgaikgPT4gYyA9PT0gdGhlbk91dFtqXSk7XG4gICAgICBpZiAoIXNhbWUpIHsgZGlmZmVyKys7IGlmIChmaXJzdCA8IDApIGZpcnN0ID0gaTsgfVxuICAgICAgaWYgKCFzYW1lIHx8IGFsbCB8fCAoZSAmJiB0ZWxsaW5nKGUpKSB8fCBub3dPdXQubGVuZ3RoID4gMCkge1xuICAgICAgICBpZiAoZSAmJiAoYWxsIHx8IHRlbGxpbmcoZSkgfHwgIXNhbWUpKSBhZGQoXCJpblwiLCAoZS50IC0gdDApLnRvRml4ZWQoMiksIGxpbmUoZSkpO1xuICAgICAgICBjb25zdCB0ID0gZSA/IChlLnQgLSB0MCkudG9GaXhlZCgyKSA6IFwiMC4wMFwiO1xuICAgICAgICBpZiAoc2FtZSkgZm9yIChjb25zdCBjIG9mIG5vd091dCkgYWRkKFwib3V0XCIsIHQsIGMpO1xuICAgICAgICBlbHNlIHtcbiAgICAgICAgICBmb3IgKGNvbnN0IGMgb2YgdGhlbk91dCkgYWRkKFwib3V0IGdvbmVcIiwgdCwgYFx1MjIxMiAke2N9YCk7XG4gICAgICAgICAgZm9yIChjb25zdCBjIG9mIG5vd091dCkgYWRkKFwib3V0IG5ld1wiLCB0LCBgKyAke2N9YCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgY29uc3QgdmVyc2lvbnMgPSB0aGVuID8gYHJlY29yZGVkIGJ5ICR7ci52ZXJzaW9ufSwgcmVwbGF5ZWQgYnkgaXQgYW5kIGJ5ICR7bGF0ZXN0LnZlcnNpb259YCA6IGByZXBsYXllZCBieSAke2xhdGVzdC52ZXJzaW9ufWAgK1xuICAgICAgKHIudmVyc2lvbiAmJiByLnZlcnNpb24gIT09IGxhdGVzdC52ZXJzaW9uID8gYCAodGhlIHJlY29yZGluZydzIGJ1aWxkICR7ci52ZXJzaW9ufSBpc24ndCBrZXB0IGhlcmUpYCA6IFwiXCIpO1xuICAgIHRoaXMuc2F5KGAke3IuZXZlbnRzLmxlbmd0aH0gZXZlbnRzLCAke3ZlcnNpb25zfS4gYCArICh0aGVuID8gKGRpZmZlciA/IGAke2RpZmZlcn0gZXZlbnRzIGFuc3dlcmVkIGRpZmZlcmVudGx5LCB0aGUgZmlyc3QgYXQgZXZlbnQgJHtmaXJzdH0uYCA6IFwiQm90aCBhbnN3ZXJlZCBldmVyeSBldmVudCB0aGUgc2FtZS5cIikgOiBcIlwiKSk7XG4gICAgaWYgKGZpcnN0ID49IDApIHRpbWVsaW5lLnF1ZXJ5U2VsZWN0b3IoXCIuZ29uZSwgLm5ld1wiKT8uc2Nyb2xsSW50b1ZpZXcoeyBibG9jazogXCJjZW50ZXJcIiB9KTtcbiAgfVxufVxuIiwgIi8vIFRoZSB3ZWIgc3VyZmFjZTogYSBmb3VydGggaG9zdCBmb3IgdGhlIHZvaWNlIGNvcmUsIGFuZCBhIHBob25lLWZyaWVuZGx5IHdheSB0byB1c2UgaXQgZm9yIHdvcmsuXG4vLyBJdCBsb2FkcyB0aGUgZGV2IHNlcnZlcidzIGxhdGVzdCBidWlsZCBhdCBlYWNoIGNhbGwsIHNvIGFuIGVkaXQgaW4gc3JjLyBpcyBsaXZlIG9uIHRoZSBuZXh0XG4vLyBjYWxsLCBhbmQga2VlcHMgZXZlcnkgY2FsbCBhcyBhIHRyYWNlIHRoZSByZXBsYXkgdmlldyAoYW5kIGFueSBvdGhlciBob3N0KSBjYW4gcnVuIGFnYWluLlxuLy9cbi8vIFRoZSBob3N0J3MgcGFydCBpcyBzbWFsbDogdGhlIG1pY3JvcGhvbmUgYW5kIHNwZWFrZXIgKGF1ZGlvLnRzKSwgdGhlIG1vZGVsJ3Mgc29ja2V0IHRocm91Z2ggdGhlXG4vLyBzZXJ2ZXIncyByZWxheSwgSGVybWVzIGFuZCBUMyB0aHJvdWdoIHRoZSBzZXJ2ZXIsIGFuZCB0aGUgc2NyZWVuLiBUaGUgY29yZSBkZWNpZGVzIHRoZSByZXN0LlxuLy9cbi8vIFR5cGluZyB3aXRoIG5vIGNhbGwgb24gc3RhcnRzIGEgY2hhdCBpbnN0ZWFkOiB0aGUgc2FtZSBjb3JlIHdpdGggYG1lZGl1bTogXCJ0ZXh0XCJgLCB3aG9zZSByZXF1ZXN0c1xuLy8gdG8gdGhlIHRleHQgbW9kZWwgZ28gdGhyb3VnaCB0aGUgc2VydmVyJ3MgL2dlbmVyYXRlLiBUYXNrcywgZm9sbG93LXVwcyBhbmQgdGhlaXIgY2FyZHMgd29yayBhc1xuLy8gaW4gYSBjYWxsLiBQcmVzc2luZyBDYWxsIGVuZHMgdGhlIGNoYXQgYW5kIGNhcnJpZXMgaXRzIGNvbnZlcnNhdGlvbiBvbiBieSB2b2ljZS5cblxuaW1wb3J0IHsgY29tbWFuZEluIH0gZnJvbSBcIi4uL3NyYy9jb21tYW5kcy50c1wiO1xuaW1wb3J0IHsgQ2FsbEF1ZGlvIH0gZnJvbSBcIi4vYXVkaW8udHNcIjtcbmltcG9ydCB7IFJlcGxheSB9IGZyb20gXCIuL3JlcGxheS50c1wiO1xuXG5pbnRlcmZhY2UgQ29yZSB7XG4gIHZlcnNpb246IHN0cmluZztcbiAgZGVmYXVsdHMoKTogc3RyaW5nO1xuICBjcmVhdGUoY29uZmlnOiBzdHJpbmcsIHQ6IG51bWJlcik6IHN0cmluZztcbiAgcHVzaChpZDogbnVtYmVyLCBldmVudDogc3RyaW5nKTogc3RyaW5nO1xuICB0cmFjZShpZDogbnVtYmVyKTogc3RyaW5nO1xuICBkaXNwb3NlKGlkOiBudW1iZXIpOiB2b2lkO1xufVxudHlwZSBDb21tYW5kID0gUmVjb3JkPHN0cmluZywgYW55PiAmIHsgdHlwZTogc3RyaW5nIH07XG5pbnRlcmZhY2UgU2VydmVyQ29uZmlnIHsgcm91dGU6IHN0cmluZzsgbW9kZWw6IHN0cmluZzsgY2FwdGlvbnNNb2RlbD86IHN0cmluZzsgdGV4dE1vZGVsPzogc3RyaW5nOyB2ZXJzaW9uOiBzdHJpbmc7IGhlcm1lczogYm9vbGVhbjsgdDM6IHN0cmluZ1tdIHwgbnVsbCB9XG5cbmNvbnN0ICQgPSA8VCBleHRlbmRzIEhUTUxFbGVtZW50ID0gSFRNTEVsZW1lbnQ+KGlkOiBzdHJpbmcpID0+IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGlkKSBhcyBUO1xuY29uc3Qgbm93ID0gKCkgPT4gcGVyZm9ybWFuY2Uubm93KCkgLyAxMDAwO1xuY29uc3QgY2hlY2tlZCA9IChpZDogc3RyaW5nKSA9PiAkPEhUTUxJbnB1dEVsZW1lbnQ+KGlkKS5jaGVja2VkO1xuXG4vKiogVGhlIGxhdGVzdCBidWlsZCBmcm9tIHRoZSBkZXYgc2VydmVyLCBldmFsdWF0ZWQgYWZyZXNoOiBhbiBlZGl0IGluIHNyYy8gaXMgaW4gdGhlIG5leHQgY2FsbC4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBsb2FkQ29yZSh1cmwgPSBcIi92b2ljZS1jb3JlLmpzXCIpOiBQcm9taXNlPENvcmU+IHtcbiAgY29uc3Qgc291cmNlID0gYXdhaXQgKGF3YWl0IGZldGNoKHVybCwgeyBjYWNoZTogXCJuby1zdG9yZVwiIH0pKS50ZXh0KCk7XG4gIGNvbnN0IHNjb3BlOiB7IFZvaWNlQ29yZT86IENvcmUgfSA9IHt9O1xuICBuZXcgRnVuY3Rpb24oXCJnbG9iYWxUaGlzXCIsIHNvdXJjZSkoc2NvcGUpO1xuICBpZiAoIXNjb3BlLlZvaWNlQ29yZSkgdGhyb3cgbmV3IEVycm9yKFwidGhlIGJ1bmRsZSBkaWRuJ3QgZGVmaW5lIFZvaWNlQ29yZVwiKTtcbiAgcmV0dXJuIHNjb3BlLlZvaWNlQ29yZTtcbn1cblxuLy8gUHJlc2V0czogZWFjaCBzdXJmYWNlJ3Mgc2V0dGluZ3MgYXMgaXRzIGFwcCB3b3VsZCBzZXQgdGhlbS5cblxuY29uc3QgRkFLRV9UViA9IFtcbiAgeyBuYW1lOiBcInR2X3ZvbHVtZVwiLCBkZXNjcmlwdGlvbjogXCJTZXRzIHRoZSBsaXZpbmctcm9vbSBUVidzIHZvbHVtZSwgMCB0byAxMDAuXCIsIHBhcmFtZXRlcnM6IHsgdHlwZTogXCJPQkpFQ1RcIiwgcHJvcGVydGllczogeyBsZXZlbDogeyB0eXBlOiBcIklOVEVHRVJcIiB9IH0sIHJlcXVpcmVkOiBbXCJsZXZlbFwiXSB9IH0sXG4gIHsgbmFtZTogXCJ0dl9wYXVzZVwiLCBkZXNjcmlwdGlvbjogXCJQYXVzZXMgb3IgcmVzdW1lcyB3aGF0J3MgcGxheWluZyBvbiB0aGUgVFYuXCIsIHBhcmFtZXRlcnM6IHsgdHlwZTogXCJPQkpFQ1RcIiwgcHJvcGVydGllczogeyBwYXVzZTogeyB0eXBlOiBcIkJPT0xFQU5cIiB9IH0gfSB9LFxuXTtcblxuY29uc3QgUFJFU0VUUzogUmVjb3JkPHN0cmluZywgUmVjb3JkPHN0cmluZywgdW5rbm93bj4+ID0ge1xuICB3ZWI6IHsgcGxhdGZvcm06IFwid2ViXCIsIGRldmljZTogXCJicm93c2VyXCIsIHN0YW5kYnlBZnRlcjogMzAsIGhhbmdVcEFmdGVyOiAzMDAsIGhhbmRPZmY6IFwibmFtZWRcIiwgc3VwZXJ2aXNlOiB0cnVlLCB2b2NhYnVsYXJ5OiBbXCJIZXJtZXNcIiwgXCJCZW50b1wiLCBcIldvb2Rob3VzZVwiLCBcIlQzXCJdIH0sXG4gIGFuZHJvaWQ6IHsgcGxhdGZvcm06IFwiQW5kcm9pZFwiLCBkZXZpY2U6IFwicGhvbmVcIiwgc3RhbmRieUFmdGVyOiAyMCB9LFxuICBcImFuZHJvaWQgd2FrZSB3b3JkXCI6IHsgcGxhdGZvcm06IFwiQW5kcm9pZFwiLCBkZXZpY2U6IFwicGhvbmVcIiwgc3RhbmRieUFmdGVyOiAyMCwgaGFuZ1VwQWZ0ZXI6IDE1IH0sXG4gIG1hY29zOiB7IHBsYXRmb3JtOiBcIm1hY09TXCIsIGRldmljZTogXCJNYWNcIiwgc3RhbmRieUFmdGVyOiAyMCB9LFxuICBlY2hvOiB7XG4gICAgcGxhdGZvcm06IFwiRWNob1wiLCBkZXZpY2U6IFwic3BlYWtlclwiLCBoYW5nVXBBZnRlcjogNiwgc3RhbmRieUFmdGVyOiA4LCBlYXJjb25zOiB0cnVlLCB2b2NhYnVsYXJ5OiBbXCJIZXJtZXNcIiwgXCJCZW50b1wiLCBcIldvb2Rob3VzZVwiXSxcbiAgICBtaWM6IHsgd2hpbGVTcGVha2luZzogXCJ3YWtlXCIsIGdhaW5EYjogMCB9LCBob3N0VG9vbHM6IEZBS0VfVFYsXG4gIH0sXG59O1xuXG4vLyBTdGF0ZS5cblxuY29uc3QgYXVkaW8gPSBuZXcgQ2FsbEF1ZGlvKCk7XG5sZXQgc2VydmVyOiBTZXJ2ZXJDb25maWc7XG5sZXQgY29yZTogQ29yZSB8IG51bGwgPSBudWxsO1xubGV0IGNhbGxJZCA9IDA7XG5sZXQgY2FsbE5hbWUgPSBcIlwiO1xubGV0IHRpY2tlciA9IDA7XG5sZXQgdHJhY2VUaW1lciA9IDA7XG5sZXQgc3RhcnRlZEF0ID0gbm93KCk7XG5jb25zdCBzb2NrZXRzID0gbmV3IE1hcDxudW1iZXIsIFdlYlNvY2tldD4oKTtcbi8qKiBUaGUgc29ja2V0cyB0byB0aGUgdHJhbnNjcmlwdGlvbiBtb2RlbDogdGhlaXIgYXVkaW8gaXMgdGhlIG1vZGVsJ3MgYWdhaW4sIHNvIGl0IGlzbid0IGNvdW50ZWQgb3IgbG9nZ2VkIHR3aWNlLiAqL1xuY29uc3QgY2FwdGlvblNvY2tldHMgPSBuZXcgU2V0PG51bWJlcj4oKTtcbmNvbnN0IHJ1bnMgPSBuZXcgTWFwPHN0cmluZywgeyBhYm9ydDogQWJvcnRDb250cm9sbGVyOyBhZ2VudDogc3RyaW5nOyB0YXNrSWQ6IHN0cmluZyB9PigpO1xuaW50ZXJmYWNlIFRhc2tWaWV3IHsgYzogQ29tbWFuZDsgc2luY2U6IG51bWJlcjsgZW5kZWQ6IG51bWJlciB8IG51bGw7IHRocmVhZD86IHN0cmluZzsgcmVzdWx0PzogSFRNTEVsZW1lbnQ7IGFwcHJvdmFsPzogeyBjb21tYW5kOiBzdHJpbmcgfSB9XG5jb25zdCB0YXNrcyA9IG5ldyBNYXA8c3RyaW5nLCBUYXNrVmlldz4oKTtcbmxldCBlYXJsaWVyQWN0aXZlQ291bnQgPSAwO1xubGV0IGVhcmxpZXJXYWl0aW5nQ291bnQgPSAwO1xubGV0IGNvdW50cyA9IHsgbWljOiAwLCBwbGF5OiAwLCBzZW50OiAwIH07XG5sZXQgZmFrZVR2TGV2ZWwgPSAxNTtcbmxldCBjb3JlU3RhdHVzID0gXCJpZGxlXCI7XG5sZXQgbXV0ZWQgPSBmYWxzZTtcbmxldCBob2xkaW5nID0gZmFsc2U7XG5sZXQgd2FrZUxvY2s6IHsgcmVsZWFzZSgpOiBQcm9taXNlPHZvaWQ+IH0gfCBudWxsID0gbnVsbDtcbi8qKiBXaGF0IHRoZSBzZXNzaW9uIG9uIHNjcmVlbiBpczogYSB2b2ljZSBjYWxsLCBvciBhIHR5cGVkIGNoYXQgKHRoZSBjb3JlJ3MgbWVkaXVtIFwidGV4dFwiKS4gKi9cbmxldCBtZWRpdW06IFwidm9pY2VcIiB8IFwidGV4dFwiID0gXCJ2b2ljZVwiO1xuLyoqIEEgY2hhdCdzIG1vZGVsIGlzIHdyaXRpbmcgaXRzIGFuc3dlci4gKi9cbmxldCB0aGlua2luZyA9IGZhbHNlO1xuLyoqIEEgY2hhdCdzIHJlcXVlc3RzIHRvIHRoZSB0ZXh0IG1vZGVsIHRoYXQgYXJlIHVuZGVyIHdheS4gKi9cbmNvbnN0IHJlcXVlc3RzID0gbmV3IE1hcDxudW1iZXIsIEFib3J0Q29udHJvbGxlcj4oKTtcbi8qKiBUaGUgbGFzdCBzZXNzaW9uIHdpbmRpbmcgZG93biAoaXRzIHRyYWNlIHNhdmVkLCB0aGUgY29yZSdzIGNhbGwgZGlzcG9zZWQpOiB0aGUgbmV4dCBzdGFydHMgYWZ0ZXIgaXQuICovXG5sZXQgZW5kaW5nOiBQcm9taXNlPHZvaWQ+ID0gUHJvbWlzZS5yZXNvbHZlKCk7XG5cbi8vIFRoZSBjb252ZXJzYXRpb24sIGtlcHQgc28gYSBuZXcgY2FsbCBjYW4gY2Fycnkgb24gZnJvbSBpdCAodGhlIGNvcmUncyBgaGlzdG9yeWAsIHJlY2FwcGVkIHRvIHRoZSBtb2RlbCkuXG5pbnRlcmZhY2UgQ2hhdExpbmUgeyByb2xlOiBcInVzZXJcIiB8IFwiYXNzaXN0YW50XCI7IHNwZWFrZXI/OiBzdHJpbmc7IHRleHQ6IHN0cmluZyB9XG5jb25zdCBISVNUT1JZID0gXCJ2b2ljZS5oaXN0b3J5XCI7XG5jb25zdCBISVNUT1JZX01BWF9BR0UgPSAxMiAqIDM2MDAgKiAxMDAwO1xubGV0IGNoYXQ6IENoYXRMaW5lW10gPSBbXTtcbi8qKiBUaGUgY29yZSdzIG51bWJlciBmb3IgdGhlIGxpbmUgdGhlIGxhc3Qgd29yZHMgd2VyZSByZW1lbWJlcmVkIG9uLCB1bnRpbCBzb21ldGhpbmcgZWxzZSBpcy4gKi9cbmxldCBsYXN0TGluZTogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5cbmZ1bmN0aW9uIHJlbWVtYmVyKHJvbGU6IFwidXNlclwiIHwgXCJhc3Npc3RhbnRcIiwgdGV4dDogc3RyaW5nLCBzcGVha2VyPzogc3RyaW5nLCBqb2luID0gZmFsc2UpIHtcbiAgY29uc3QgbGFzdCA9IGNoYXQuYXQoLTEpO1xuICBpZiAoam9pbiAmJiBsYXN0ICYmIGxhc3Qucm9sZSA9PT0gcm9sZSAmJiBsYXN0LnNwZWFrZXIgPT09IHNwZWFrZXIpIGxhc3QudGV4dCArPSB0ZXh0O1xuICBlbHNlIGNoYXQucHVzaChzcGVha2VyID8geyByb2xlLCBzcGVha2VyLCB0ZXh0IH0gOiB7IHJvbGUsIHRleHQgfSk7XG4gIGlmIChjaGF0Lmxlbmd0aCA+IDIwMCkgY2hhdC5zcGxpY2UoMCwgY2hhdC5sZW5ndGggLSAyMDApO1xuICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShISVNUT1JZLCBKU09OLnN0cmluZ2lmeSh7IGF0OiBEYXRlLm5vdygpLCBjaGF0IH0pKTtcbn1cblxuZnVuY3Rpb24gc2F2ZWRIaXN0b3J5KCk6IENoYXRMaW5lW10ge1xuICB0cnkge1xuICAgIGNvbnN0IHNhdmVkID0gSlNPTi5wYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShISVNUT1JZKSA/PyBcIm51bGxcIik7XG4gICAgcmV0dXJuIHNhdmVkICYmIERhdGUubm93KCkgLSBzYXZlZC5hdCA8IEhJU1RPUllfTUFYX0FHRSAmJiBBcnJheS5pc0FycmF5KHNhdmVkLmNoYXQpID8gc2F2ZWQuY2hhdCA6IFtdO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gW107XG4gIH1cbn1cblxuLyoqIFR3byByaXNpbmcgbm90ZXM6IHNvbWV0aGluZyBvbiB0aGUgc2NyZWVuIG5lZWRzIHRoZSB1c2VyLiBQQ00xNiBhdCAyNCBrSHosIGJhc2U2NC4gKi9cbmNvbnN0IEFQUFJPVkFMX1RPTkUgPSAoKCkgPT4ge1xuICBjb25zdCByYXRlID0gMjQwMDAsIG91dCA9IG5ldyBJbnQxNkFycmF5KHJhdGUgKiAwLjMyKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCB0ID0gaSAvIHJhdGUsIGYgPSB0IDwgMC4xNiA/IDY2MCA6IDg4MCwgbG9jYWwgPSB0IDwgMC4xNiA/IHQgOiB0IC0gMC4xNjtcbiAgICBvdXRbaV0gPSBNYXRoLnJvdW5kKE1hdGguc2luKDIgKiBNYXRoLlBJICogZiAqIHQpICogTWF0aC5taW4oMSwgbG9jYWwgKiA2MCwgKDAuMTYgLSBsb2NhbCkgKiA2MCkgKiA2MDAwKTtcbiAgfVxuICBsZXQgYmluID0gXCJcIjtcbiAgY29uc3QgYnl0ZXMgPSBuZXcgVWludDhBcnJheShvdXQuYnVmZmVyKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBieXRlcy5sZW5ndGg7IGkrKykgYmluICs9IFN0cmluZy5mcm9tQ2hhckNvZGUoYnl0ZXNbaV0pO1xuICByZXR1cm4gYnRvYShiaW4pO1xufSkoKTtcblxuLy8gTGF0ZW5jeTogdGhlIG5ldHdvcmsncyByb3VuZCB0cmlwLCBhbmQgaG93IGxvbmcgYWZ0ZXIgdGhlIHVzZXIgc3RvcHMgdGFsa2luZyB0aGUgcmVwbHkgc3RhcnRzLlxuY29uc3QgbWV0cmljcyA9IHsgcnR0OiBbXSBhcyBudW1iZXJbXSwgcmVwbHk6IFtdIGFzIG51bWJlcltdLCBsYXN0Vm9pY2U6IDAsIGxhc3RQbGF5OiAwLCByZXBsaWVkOiB0cnVlIH07XG5cbmZ1bmN0aW9uIG1lZGlhbih4czogbnVtYmVyW10pOiBudW1iZXIgfCBudWxsIHtcbiAgaWYgKHhzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHMgPSBbLi4ueHNdLnNvcnQoKGEsIGIpID0+IGEgLSBiKTtcbiAgcmV0dXJuIHNbTWF0aC5mbG9vcihzLmxlbmd0aCAvIDIpXTtcbn1cblxuZnVuY3Rpb24gc2hvd01ldHJpY3MoKSB7XG4gIGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBydHQgPSBtZWRpYW4obWV0cmljcy5ydHQpO1xuICBpZiAocnR0ICE9IG51bGwpIHBhcnRzLnB1c2goYCR7TWF0aC5yb3VuZChydHQgKiAxMDAwKX0gbXNgKTtcbiAgY29uc3QgcmVwbHkgPSBtZWRpYW4obWV0cmljcy5yZXBseSk7XG4gIGlmIChyZXBseSAhPSBudWxsKSBwYXJ0cy5wdXNoKGByZXBseSAke21ldHJpY3MucmVwbHkuYXQoLTEpIS50b0ZpeGVkKDEpfXMgKCR7cmVwbHkudG9GaXhlZCgxKX1zIG1lZClgKTtcbiAgY29uc3Qgb3V0ID0gYXVkaW8ub3V0cHV0TGF0ZW5jeTtcbiAgaWYgKG91dCAhPSBudWxsKSBwYXJ0cy5wdXNoKGBhdWRpbyAke01hdGgucm91bmQob3V0ICogMTAwMCl9IG1zYCk7XG4gIGxldCBidWZmZXJlZCA9IDA7XG4gIGZvciAoY29uc3Qgd3Mgb2Ygc29ja2V0cy52YWx1ZXMoKSkgYnVmZmVyZWQgKz0gd3MuYnVmZmVyZWRBbW91bnQ7XG4gIGlmIChidWZmZXJlZCA+IDMyXzAwMCkgcGFydHMucHVzaChgdXBsb2FkICskeyhidWZmZXJlZCAvIDMyXzAwMCkudG9GaXhlZCgxKX1zYCk7XG4gICQoXCJtZXRyaWNzXCIpLnRleHRDb250ZW50ID0gcGFydHMuam9pbihcIiBcdTAwQjcgXCIpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBwaW5nKCkge1xuICBjb25zdCB0ID0gbm93KCk7XG4gIHRyeSB7XG4gICAgYXdhaXQgZmV0Y2goXCIvcGluZ1wiLCB7IGNhY2hlOiBcIm5vLXN0b3JlXCIgfSk7XG4gICAgbWV0cmljcy5ydHQucHVzaChub3coKSAtIHQpO1xuICAgIGlmIChtZXRyaWNzLnJ0dC5sZW5ndGggPiAxMikgbWV0cmljcy5ydHQuc2hpZnQoKTtcbiAgfSBjYXRjaCB7fVxuICBzaG93TWV0cmljcygpO1xufVxuXG4vLyBUaGVtZS5cblxuZnVuY3Rpb24gYXBwbHlUaGVtZShjaG9pY2U6IHN0cmluZykge1xuICBjb25zdCByb290ID0gZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50O1xuICBpZiAoY2hvaWNlID09PSBcImRhcmtcIiB8fCBjaG9pY2UgPT09IFwibGlnaHRcIikgcm9vdC5kYXRhc2V0LnRoZW1lID0gY2hvaWNlO1xuICBlbHNlIGRlbGV0ZSByb290LmRhdGFzZXQudGhlbWU7XG4gIGNvbnN0IGRhcmsgPSBjaG9pY2UgPT09IFwiZGFya1wiIHx8IChjaG9pY2UgIT09IFwibGlnaHRcIiAmJiBtYXRjaE1lZGlhKFwiKHByZWZlcnMtY29sb3Itc2NoZW1lOiBkYXJrKVwiKS5tYXRjaGVzKTtcbiAgY29uc3QgbWV0YSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwidGhlbWUtY29sb3JcIik7XG4gIGlmIChtZXRhKSBtZXRhLnNldEF0dHJpYnV0ZShcImNvbnRlbnRcIiwgZGFyayA/IFwiIzBlMGYwZlwiIDogXCIjZjZmNWYwXCIpO1xuICBmb3IgKGNvbnN0IGJ0biBvZiBBcnJheS5mcm9tKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiI3RoZW1lLXBpY2tlciBidXR0b25cIikpKSB7XG4gICAgYnRuLmNsYXNzTGlzdC50b2dnbGUoXCJvblwiLCBidG4uZGF0YXNldC50aGVtZSA9PT0gKGNob2ljZSB8fCBcInN5c3RlbVwiKSk7XG4gIH1cbn1cblxuLy8gVGhlIHNjcmVlbi5cblxuZnVuY3Rpb24gc2V0Q2FsbEJ1dHRvbihsaXZlOiBib29sZWFuKSB7XG4gIGNvbnN0IGJ0biA9ICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiY2FsbFwiKTtcbiAgYnRuLmNsYXNzTGlzdC50b2dnbGUoXCJsaXZlXCIsIGxpdmUpO1xuICBjb25zdCBsYWJlbCA9IGJ0bi5xdWVyeVNlbGVjdG9yKFwiLmNhbGwtbGFiZWxcIik7XG4gIGlmIChsYWJlbCkgbGFiZWwudGV4dENvbnRlbnQgPSBsaXZlID8gXCJIYW5nIHVwXCIgOiBcIkNhbGxcIjtcbn1cblxuZnVuY3Rpb24gc3luY1Jlc3VtZUJ1dHRvbnMoc2hvdzogYm9vbGVhbikge1xuICAkKFwicmVzdW1lXCIpLmhpZGRlbiA9ICFzaG93O1xuICAkKFwiaGVyby1yZXN1bWVcIikuaGlkZGVuID0gIXNob3c7XG59XG5cbmZ1bmN0aW9uIHBhcnNlUHJlZml4KHRleHQ6IHN0cmluZyk6IHsgbW9kZTogXCJoZXJtZXNcIiB8IFwidDNcIiB8IG51bGw7IHJlc3Q6IHN0cmluZyB9IHtcbiAgY29uc3QgbSA9IHRleHQubWF0Y2goL15cXC8odDN8Y29kZXxofGhlcm1lcylcXHMrKC4qKSQvaXMpO1xuICBpZiAoIW0pIHJldHVybiB7IG1vZGU6IG51bGwsIHJlc3Q6IHRleHQgfTtcbiAgcmV0dXJuIHsgbW9kZTogL14odDN8Y29kZSkkL2kudGVzdChtWzFdKSA/IFwidDNcIiA6IFwiaGVybWVzXCIsIHJlc3Q6IG1bMl0udHJpbSgpIH07XG59XG5cbmZ1bmN0aW9uIHN5bmNDb21wb3NlcigpIHtcbiAgY29uc3QgaW5wdXQgPSAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwidGV4dFwiKTtcbiAgY29uc3QgcmF3ID0gaW5wdXQudmFsdWU7XG4gIGNvbnN0IHRyaW1tZWQgPSByYXcudHJpbSgpO1xuICAkKFwic2VuZGJ0blwiKS5jbGFzc0xpc3QudG9nZ2xlKFwicmVhZHlcIiwgdHJpbW1lZC5sZW5ndGggPiAwKTtcbiAgY29uc3QgcGFyc2VkID0gcGFyc2VQcmVmaXgocmF3LnRyaW1TdGFydCgpKTtcbiAgJChcIm1vZGUtd3JhcFwiKS5kYXRhc2V0Lm1vZGUgPSBwYXJzZWQubW9kZSA/PyAkPEhUTUxTZWxlY3RFbGVtZW50PihcIm1vZGVcIikudmFsdWU7XG59XG5cbmZ1bmN0aW9uIHVwZGF0ZUp1bXBCdXR0b24oKSB7XG4gIGNvbnN0IHBhbmUgPSAkKFwidHJhbnNjcmlwdFwiKTtcbiAgY29uc3QgYXdheSA9IHBhbmUuc2Nyb2xsSGVpZ2h0IC0gcGFuZS5zY3JvbGxUb3AgLSBwYW5lLmNsaWVudEhlaWdodCA+IDEyMDtcbiAgJChcImp1bXBib3R0b21cIikuaGlkZGVuID0gIWF3YXkgfHwgISQoXCJlbXB0eVwiKS5oaWRkZW47XG59XG5cbmZ1bmN0aW9uIGZvcm1hdENsb2NrKHNlY29uZHM6IG51bWJlcik6IHN0cmluZyB7XG4gIGNvbnN0IHRvdGFsID0gTWF0aC5tYXgoMCwgTWF0aC5mbG9vcihzZWNvbmRzKSk7XG4gIGNvbnN0IGggPSBNYXRoLmZsb29yKHRvdGFsIC8gMzYwMCk7XG4gIGNvbnN0IG0gPSBNYXRoLmZsb29yKCh0b3RhbCAlIDM2MDApIC8gNjApO1xuICBjb25zdCBzID0gdG90YWwgJSA2MDtcbiAgY29uc3QgcGFkID0gKG46IG51bWJlcikgPT4gU3RyaW5nKG4pLnBhZFN0YXJ0KDIsIFwiMFwiKTtcbiAgcmV0dXJuIGggPiAwID8gYCR7aH06JHtwYWQobSl9OiR7cGFkKHMpfWAgOiBgJHtwYWQobSl9OiR7cGFkKHMpfWA7XG59XG5cbmNvbnN0IFZJWl9XRUlHSFRTID0gWzAuNDgsIDAuODYsIDEuMCwgMC43OCwgMC40NF07XG5mdW5jdGlvbiB1cGRhdGVWaXN1YWxpemVyKG1vZGU6IHN0cmluZywgbGV2ZWw6IG51bWJlcikge1xuICBjb25zdCB2aXogPSAkKFwidml6XCIpO1xuICB2aXouZGF0YXNldC5tb2RlID0gbW9kZTtcbiAgY29uc3QgYmFycyA9IHZpei5jaGlsZHJlbjtcbiAgaWYgKG1vZGUgPT09IFwibGlzdGVuaW5nXCIgfHwgbW9kZSA9PT0gXCJ3b3JraW5nXCIpIHtcbiAgICBjb25zdCBlbmVyZ3kgPSBNYXRoLm1pbigxLCBsZXZlbCAqIDE0KTtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGJhcnMubGVuZ3RoOyBpKyspIHtcbiAgICAgIGNvbnN0IGggPSAwLjI0ICsgZW5lcmd5ICogVklaX1dFSUdIVFNbaV0gKiAwLjc2O1xuICAgICAgKGJhcnNbaV0gYXMgSFRNTEVsZW1lbnQpLnN0eWxlLnRyYW5zZm9ybSA9IGBzY2FsZVkoJHtoLnRvRml4ZWQoMil9KWA7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYmFycy5sZW5ndGg7IGkrKykgKGJhcnNbaV0gYXMgSFRNTEVsZW1lbnQpLnN0eWxlLnRyYW5zZm9ybSA9IFwiXCI7XG4gIH1cbn1cblxuLyoqIEEgc3lzdGVtIG5vdGlmaWNhdGlvbiB3aGlsZSB0aGUgcGFnZSBpcyBoaWRkZW46IGEgdGFzayBmaW5pc2hlZCwgb3Igb25lIG5lZWRzIHRoZSB1c2VyLiAqL1xuZnVuY3Rpb24gbm90aWZ5KHRpdGxlOiBzdHJpbmcsIGJvZHk6IHN0cmluZykge1xuICBpZiAoIWRvY3VtZW50LmhpZGRlbiB8fCAhKFwiTm90aWZpY2F0aW9uXCIgaW4gd2luZG93KSB8fCBOb3RpZmljYXRpb24ucGVybWlzc2lvbiAhPT0gXCJncmFudGVkXCIpIHJldHVybjtcbiAgdHJ5IHtcbiAgICBjb25zdCBuID0gbmV3IE5vdGlmaWNhdGlvbih0aXRsZSwgeyBib2R5OiBib2R5LnNsaWNlKDAsIDE4MCksIGljb246IFwiL3dlYi9pY29ucy9pY29uLTE5Mi5wbmdcIiwgdGFnOiB0aXRsZSB9KTtcbiAgICBuLm9uY2xpY2sgPSAoKSA9PiB7IHdpbmRvdy5mb2N1cygpOyBuLmNsb3NlKCk7IH07XG4gIH0gY2F0Y2gge1xuICAgIC8vIFBob25lcyB3YW50IG5vdGlmaWNhdGlvbnMgZnJvbSBhIHNlcnZpY2Ugd29ya2VyOyB0aGUgcGFnZSBoYXMgbm9uZS5cbiAgfVxufVxuXG5mdW5jdGlvbiB0b2FzdCh0ZXh0OiBzdHJpbmcpIHtcbiAgY29uc3QgdCA9ICQoXCJ0b2FzdFwiKTtcbiAgdC50ZXh0Q29udGVudCA9IHRleHQ7XG4gIHQuY2xhc3NMaXN0LmFkZChcIm9uXCIpO1xuICBjbGVhclRpbWVvdXQoKHRvYXN0IGFzIGFueSkudGltZXIpO1xuICAodG9hc3QgYXMgYW55KS50aW1lciA9IHNldFRpbWVvdXQoKCkgPT4gdC5jbGFzc0xpc3QucmVtb3ZlKFwib25cIiksIDE4MDApO1xufVxuXG5mdW5jdGlvbiBsb2coa2luZDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcsIGNscyA9IFwiXCIpIHtcbiAgY29uc3QgcGFuZSA9ICQoXCJsb2dcIik7XG4gIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvdy5jbGFzc05hbWUgPSBgcm93ICR7Y2xzfWA7XG4gIHJvdy5pbm5lckhUTUwgPSBgPHNwYW4gY2xhc3M9XCJ0XCI+JHsobm93KCkgLSBzdGFydGVkQXQpLnRvRml4ZWQoMil9PC9zcGFuPjxzcGFuIGNsYXNzPVwia1wiPiR7a2luZH08L3NwYW4+YDtcbiAgY29uc3QgYm9keSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBib2R5LmNsYXNzTmFtZSA9IFwiYlwiO1xuICBib2R5LnRleHRDb250ZW50ID0gdGV4dDtcbiAgcm93LmFwcGVuZChib2R5KTtcbiAgY29uc3Qgc3RpY2sgPSBwYW5lLnNjcm9sbFRvcCArIHBhbmUuY2xpZW50SGVpZ2h0ID49IHBhbmUuc2Nyb2xsSGVpZ2h0IC0gMzA7XG4gIHBhbmUuYXBwZW5kKHJvdyk7XG4gIHdoaWxlIChwYW5lLmNoaWxkRWxlbWVudENvdW50ID4gMzAwMCkgcGFuZS5maXJzdEVsZW1lbnRDaGlsZCEucmVtb3ZlKCk7XG4gIGlmIChzdGljaykgcGFuZS5zY3JvbGxUb3AgPSBwYW5lLnNjcm9sbEhlaWdodDtcbn1cblxuLyoqIEEgZnJhbWUgZnJvbSBvciB0byBHZW1pbmksIHdpdGggYXVkaW8gY3V0IG91dCwgc2hvcnQgZW5vdWdoIHRvIHJlYWQuICovXG5mdW5jdGlvbiBicmllZihkYXRhOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gZGF0YS5yZXBsYWNlKC9cImRhdGFcIjpcIltBLVphLXowLTkrLz1dezQwLH1cIi9nLCAobSkgPT4gYFwiZGF0YVwiOlwiXHUyMDI2JHtNYXRoLnJvdW5kKCgobS5sZW5ndGggLSA5KSAqIDMpIC8gNCl9IGJ5dGVzXCJgKS5zbGljZSgwLCA2MDApO1xufVxuXG5mdW5jdGlvbiBlc2NhcGVIdG1sKHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiB0ZXh0LnJlcGxhY2UoL1smPD5cIiddL2csIChjKSA9PiAoeyBcIiZcIjogXCImYW1wO1wiLCBcIjxcIjogXCImbHQ7XCIsIFwiPlwiOiBcIiZndDtcIiwgJ1wiJzogXCImcXVvdDtcIiwgXCInXCI6IFwiJiMzOTtcIiB9KVtjXSEpO1xufVxuXG4vKiogQSBsaXR0bGUgTWFya2Rvd24sIHNhZmVseTogY29kZSwgYm9sZCwgbGlua3MsIGxpc3RzIGFuZCBoZWFkaW5ncywgdGhlIHJlc3QgYXMgdGV4dC4gKi9cbmZ1bmN0aW9uIG1hcmtkb3duKHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGJsb2NrcyA9IGVzY2FwZUh0bWwodGV4dC50cmltKCkpLnNwbGl0KC9gYGAoPzpcXHcrKT9cXG4/Lyk7XG4gIHJldHVybiBibG9ja3MubWFwKChibG9jaywgaSkgPT4ge1xuICAgIGlmIChpICUgMiA9PT0gMSkgcmV0dXJuIGA8cHJlPjxjb2RlPiR7YmxvY2sucmVwbGFjZSgvXFxuJC8sIFwiXCIpfTwvY29kZT48L3ByZT5gO1xuICAgIGNvbnN0IGlubGluZSA9IChzOiBzdHJpbmcpID0+IHNcbiAgICAgIC5yZXBsYWNlKC9gKFteYFxcbl0rKWAvZywgXCI8Y29kZT4kMTwvY29kZT5cIilcbiAgICAgIC5yZXBsYWNlKC9cXCpcXCooW14qXFxuXSspXFwqXFwqL2csIFwiPGI+JDE8L2I+XCIpXG4gICAgICAucmVwbGFjZSgvXFxbKFteXFxdXFxuXSspXFxdXFwoKGh0dHBzPzpcXC9cXC9bXlxccyldKylcXCkvZywgJzxhIGhyZWY9XCIkMlwiIHRhcmdldD1cIl9ibGFua1wiIHJlbD1cIm5vb3BlbmVyXCI+JDE8L2E+JylcbiAgICAgIC5yZXBsYWNlKC8oXnxbXFxzKF0pKGh0dHBzPzpcXC9cXC9bXlxcczwpXSspL2csICckMTxhIGhyZWY9XCIkMlwiIHRhcmdldD1cIl9ibGFua1wiIHJlbD1cIm5vb3BlbmVyXCI+JDI8L2E+Jyk7XG4gICAgbGV0IGh0bWwgPSBcIlwiO1xuICAgIGxldCBsaXN0OiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICBmb3IgKGNvbnN0IHJhdyBvZiBibG9jay5zcGxpdChcIlxcblwiKSkge1xuICAgICAgY29uc3QgaXRlbSA9IHJhdy5tYXRjaCgvXlxccyooPzpbLSpcdTIwMjJdfChcXGQrKVsuKV0pXFxzKyguKikkLyk7XG4gICAgICBpZiAoaXRlbSkge1xuICAgICAgICBjb25zdCBraW5kID0gaXRlbVsxXSA/IFwib2xcIiA6IFwidWxcIjtcbiAgICAgICAgaWYgKGxpc3QgIT09IGtpbmQpIHsgaWYgKGxpc3QpIGh0bWwgKz0gYDwvJHtsaXN0fT5gOyBodG1sICs9IGA8JHtraW5kfT5gOyBsaXN0ID0ga2luZDsgfVxuICAgICAgICBodG1sICs9IGA8bGk+JHtpbmxpbmUoaXRlbVsyXSl9PC9saT5gO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGlmIChsaXN0KSB7IGh0bWwgKz0gYDwvJHtsaXN0fT5gOyBsaXN0ID0gbnVsbDsgfVxuICAgICAgY29uc3QgaGVhZGluZyA9IHJhdy5tYXRjaCgvXiN7MSw2fVxccysoLiopJC8pO1xuICAgICAgaHRtbCArPSBoZWFkaW5nID8gYDxkaXYgY2xhc3M9XCJtZC1oXCI+JHtpbmxpbmUoaGVhZGluZ1sxXSl9PC9kaXY+YCA6IHJhdy50cmltKCkgPT09IFwiXCIgPyBcIjxicj5cIiA6IGAke2lubGluZShyYXcpfTxicj5gO1xuICAgIH1cbiAgICBpZiAobGlzdCkgaHRtbCArPSBgPC8ke2xpc3R9PmA7XG4gICAgcmV0dXJuIGh0bWwucmVwbGFjZSgvKDxicj4pKyQvLCBcIlwiKTtcbiAgfSkuam9pbihcIlwiKTtcbn1cblxuZnVuY3Rpb24gc2Nyb2xsRG93bihmb3JjZSA9IGZhbHNlKSB7XG4gIGNvbnN0IHBhbmUgPSAkKFwidHJhbnNjcmlwdFwiKTtcbiAgaWYgKGZvcmNlIHx8IHBhbmUuc2Nyb2xsVG9wICsgcGFuZS5jbGllbnRIZWlnaHQgPj0gcGFuZS5zY3JvbGxIZWlnaHQgLSA4MCkgcGFuZS5zY3JvbGxUb3AgPSBwYW5lLnNjcm9sbEhlaWdodDtcbiAgdXBkYXRlSnVtcEJ1dHRvbigpO1xufVxuXG4vKiogVGhlIGNvcmUncyBudW1iZXIgZm9yIHRoZSBsaW5lIHRoZSBsYXN0IHJvdyBzaG93cywgdW50aWwgYW5vdGhlciByb3cgZm9sbG93cyBpdC4gKi9cbmxldCBvcGVuTGluZTogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5cbi8qKiBXb3JkcyBnbyBvbiB0aGUgcm93IHRoZSBjb3JlIHNheXMgdGhleSBiZWxvbmcgdG86IGl0IHN0YXJ0cyBhIG5ldyBsaW5lIGZvciBlYWNoIHR1cm4sIGhvd2V2ZXIgbG9uZyB0aGUgZ2FwLiAqL1xuZnVuY3Rpb24gdHJhbnNjcmlwdChyb2xlOiBcInVzZXJcIiB8IFwiYXNzaXN0YW50XCIsIHRleHQ6IHN0cmluZywgbGluZTogbnVtYmVyKSB7XG4gICQoXCJlbXB0eVwiKS5oaWRkZW4gPSB0cnVlO1xuICBjb25zdCBwYW5lID0gJChcInRyYW5zY3JpcHRcIik7XG4gIGNvbnN0IGxhc3QgPSBwYW5lLmxhc3RFbGVtZW50Q2hpbGQgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAob3BlbkxpbmUgPT09IGxpbmUgJiYgbGFzdCAmJiBsYXN0LmRhdGFzZXQucm9sZSA9PT0gcm9sZSkgbGFzdC5xdWVyeVNlbGVjdG9yKFwiLnRleHRcIikhLnRleHRDb250ZW50ICs9IHRleHQ7XG4gIGVsc2Uge1xuICAgIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgcm93LmNsYXNzTmFtZSA9IGBsaW5lICR7cm9sZX1gO1xuICAgIHJvdy5kYXRhc2V0LnJvbGUgPSByb2xlO1xuICAgIHJvdy5pbm5lckhUTUwgPSBgPHNwYW4gY2xhc3M9XCJ3aG9cIj4ke3JvbGUgPT09IFwidXNlclwiID8gXCJZb3VcIiA6IFwiR2VtaW5pXCJ9PC9zcGFuPjxzcGFuIGNsYXNzPVwidGV4dFwiPjwvc3Bhbj5gO1xuICAgIHJvdy5xdWVyeVNlbGVjdG9yKFwiLnRleHRcIikhLnRleHRDb250ZW50ID0gdGV4dC50cmltU3RhcnQoKTtcbiAgICBwYW5lLmFwcGVuZChyb3cpO1xuICAgIG9wZW5MaW5lID0gbGluZTtcbiAgfVxuICBzY3JvbGxEb3duKHJvbGUgPT09IFwidXNlclwiKTtcbn1cblxuLyoqXG4gKiBUaGUgd29yZHMgdGhlIHVzZXIgaXMgc2F5aW5nLCBiZWZvcmUgdGhlIG1vZGVsIGhhcyB0cmFuc2NyaWJlZCB0aGVtOiBhIGZhaW50IHJvdyB0aGF0IHN0YXlzIGxhc3RcbiAqIG9uIHNjcmVlbiAoaXRzIENTUyBgb3JkZXJgKSBhbmQgZmlyc3QgaW4gdGhlIHBhbmUsIHNvIHRoZSBsaW5lcyBhZnRlciBpdCBqb2luIHVwIGFzIGJlZm9yZS5cbiAqL1xuZnVuY3Rpb24gY2FwdGlvbih0ZXh0OiBzdHJpbmcgfCBudWxsKSB7XG4gIGNvbnN0IHBhbmUgPSAkKFwidHJhbnNjcmlwdFwiKTtcbiAgbGV0IHJvdyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwiY2FwdGlvblwiKTtcbiAgaWYgKHRleHQgPT0gbnVsbCkgeyByb3c/LnJlbW92ZSgpOyByZXR1cm47IH1cbiAgJChcImVtcHR5XCIpLmhpZGRlbiA9IHRydWU7XG4gIGlmICghcm93KSB7XG4gICAgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICByb3cuaWQgPSBcImNhcHRpb25cIjtcbiAgICByb3cuY2xhc3NOYW1lID0gXCJsaW5lIHVzZXIgY2FwdGlvblwiO1xuICAgIHJvdy5pbm5lckhUTUwgPSBgPHNwYW4gY2xhc3M9XCJ3aG9cIj5Zb3U8L3NwYW4+PHNwYW4gY2xhc3M9XCJ0ZXh0XCI+PC9zcGFuPmA7XG4gICAgcGFuZS5wcmVwZW5kKHJvdyk7XG4gIH1cbiAgcm93LnF1ZXJ5U2VsZWN0b3IoXCIudGV4dFwiKSEudGV4dENvbnRlbnQgPSB0ZXh0O1xuICBzY3JvbGxEb3duKHRydWUpO1xufVxuXG5mdW5jdGlvbiBub3RlKHRleHQ6IHN0cmluZykge1xuICAkKFwiZW1wdHlcIikuaGlkZGVuID0gdHJ1ZTtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IFwibGluZSBub3RlXCI7XG4gIHJvdy50ZXh0Q29udGVudCA9IHRleHQ7XG4gICQoXCJ0cmFuc2NyaXB0XCIpLmFwcGVuZChyb3cpO1xuICBvcGVuTGluZSA9IG51bGw7XG4gIHNjcm9sbERvd24oKTtcbn1cblxuZnVuY3Rpb24gcmVzdWx0KGFnZW50OiBzdHJpbmcsIGxhYmVsOiBzdHJpbmcsIHRleHQ6IHN0cmluZywgZmFpbGVkID0gZmFsc2UpOiBIVE1MRWxlbWVudCB7XG4gICQoXCJlbXB0eVwiKS5oaWRkZW4gPSB0cnVlO1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gYGxpbmUgcmVzdWx0ICR7YWdlbnQgPT09IFwidDNcIiA/IFwidDNcIiA6IFwiXCJ9ICR7ZmFpbGVkID8gXCJmYWlsZWRcIiA6IFwiXCJ9YC50cmltKCk7XG4gIGNvbnN0IHdobyA9IGFnZW50ID09PSBcInQzXCIgPyBcIlQzXCIgOiBcIkhlcm1lc1wiO1xuICByb3cuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9XCJ3aG9cIj48c3BhbiBjbGFzcz1cInJlcy10aXRsZVwiPjxzcGFuIGNsYXNzPVwiYmFkZ2UgJHthZ2VudCA9PT0gXCJ0M1wiID8gXCJ0M1wiIDogXCJcIn1cIj4ke3dob308L3NwYW4+PHNwYW4gY2xhc3M9XCJyZXMtbGFiZWxcIj4ke2VzY2FwZUh0bWwobGFiZWwpfTwvc3Bhbj48L3NwYW4+PHNwYW4gY2xhc3M9XCJyZXMtcGlsbFwiPiR7ZmFpbGVkID8gXCJGYWlsZWRcIiA6IFwiUmVzdWx0XCJ9PC9zcGFuPjwvZGl2PjxkaXYgY2xhc3M9XCJib2R5XCI+JHttYXJrZG93bih0ZXh0KX08L2Rpdj5gO1xuICAkKFwidHJhbnNjcmlwdFwiKS5hcHBlbmQocm93KTtcbiAgb3BlbkxpbmUgPSBudWxsO1xuICBjb25zdCBib2R5ID0gcm93LnF1ZXJ5U2VsZWN0b3IoXCIuYm9keVwiKSBhcyBIVE1MRWxlbWVudDtcbiAgcmVxdWVzdEFuaW1hdGlvbkZyYW1lKCgpID0+IHtcbiAgICBpZiAoYm9keS5zY3JvbGxIZWlnaHQgPiBib2R5LmNsaWVudEhlaWdodCArIDQpIHtcbiAgICAgIHJvdy5jbGFzc0xpc3QuYWRkKFwiY2xhbXBlZFwiKTtcbiAgICAgIGNvbnN0IG1vcmUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICAgICAgbW9yZS5jbGFzc05hbWUgPSBcIm1vcmVcIjtcbiAgICAgIG1vcmUudHlwZSA9IFwiYnV0dG9uXCI7XG4gICAgICBtb3JlLnRleHRDb250ZW50ID0gXCJTaG93IGZ1bGwgcmVzdWx0XCI7XG4gICAgICBtb3JlLm9uY2xpY2sgPSAoKSA9PiB7IHJvdy5jbGFzc0xpc3QudG9nZ2xlKFwib3BlblwiKTsgbW9yZS50ZXh0Q29udGVudCA9IHJvdy5jbGFzc0xpc3QuY29udGFpbnMoXCJvcGVuXCIpID8gXCJTaG93IGxlc3NcIiA6IFwiU2hvdyBmdWxsIHJlc3VsdFwiOyB9O1xuICAgICAgcm93LmFwcGVuZChtb3JlKTtcbiAgICB9XG4gIH0pO1xuICBzY3JvbGxEb3duKHRydWUpO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBlbGFwc2VkKHNlY29uZHM6IG51bWJlcik6IHN0cmluZyB7XG4gIGlmIChzZWNvbmRzIDwgNjApIHJldHVybiBgJHtNYXRoLmZsb29yKHNlY29uZHMpfXNgO1xuICBjb25zdCBtID0gTWF0aC5mbG9vcihzZWNvbmRzIC8gNjApO1xuICByZXR1cm4gbSA8IDYwID8gYCR7bX1tICR7TWF0aC5mbG9vcihzZWNvbmRzICUgNjApfXNgIDogYCR7TWF0aC5mbG9vcihtIC8gNjApfWggJHttICUgNjB9bWA7XG59XG5cbi8qKiBUaGUgZW1wdHkgdGFzayBsaXN0J3Mgd29yZHMsIGtlcHQgdG8gcHV0IGJhY2suICovXG5jb25zdCBub1Rhc2tzID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJub3Rhc2tzXCIpITtcblxuLyoqIFdoZXRoZXIgYSB0YXNrIHN0aWxsIHdhbnRzIHRoZSBzY3JlZW46IGl0J3Mgd29ya2luZywgb3IgaXQgd2FpdHMgZm9yIHRoZSB1c2VyLiBUaGUgcmVzdCBmb2xkIGF3YXkgdW5kZXIgRmluaXNoZWQuICovXG5jb25zdCBsaXZlID0gKHN0YXRlOiBzdHJpbmcpID0+IHN0YXRlID09PSBcInJ1bm5pbmdcIiB8fCBzdGF0ZS5zdGFydHNXaXRoKFwid2FpdGluZ1wiKTtcblxuZnVuY3Rpb24gdXBkYXRlVGFza0Nocm9tZSgpIHtcbiAgY29uc3QgYWxsID0gWy4uLnRhc2tzLnZhbHVlcygpXTtcbiAgY29uc3QgYWN0aXZlQ3VycmVudCA9IGFsbC5maWx0ZXIoKHQpID0+IGxpdmUodC5jLnN0YXRlKSB8fCBCb29sZWFuKHQuYXBwcm92YWwpKS5sZW5ndGg7XG4gIGNvbnN0IHdhaXRpbmcgPSBhbGwuZmlsdGVyKCh0KSA9PiB0LmMuc3RhdGUuc3RhcnRzV2l0aChcIndhaXRpbmdcIikgfHwgQm9vbGVhbih0LmFwcHJvdmFsKSkubGVuZ3RoO1xuICBjb25zdCBhY3RpdmVUb3RhbCA9IGFjdGl2ZUN1cnJlbnQgKyBlYXJsaWVyQWN0aXZlQ291bnQ7XG4gIGNvbnN0IGF0dGVudGlvblRvdGFsID0gd2FpdGluZyArIGVhcmxpZXJXYWl0aW5nQ291bnQ7XG5cbiAgY29uc3QgYmFkZ2UgPSAkKFwidGFza3MtYmFkZ2VcIik7XG4gIGJhZGdlLmhpZGRlbiA9IGFjdGl2ZVRvdGFsID09PSAwO1xuICBiYWRnZS50ZXh0Q29udGVudCA9IFN0cmluZyhhY3RpdmVUb3RhbCk7XG4gIGJhZGdlLmNsYXNzTGlzdC50b2dnbGUoXCJ3YXJuXCIsIGF0dGVudGlvblRvdGFsID4gMCk7XG5cbiAgY29uc3QgYmFyID0gJChcIm1vYmlsZS10YXNrcy1iYXJcIik7XG4gIGNvbnN0IHNob3dCYXIgPSBhY3RpdmVUb3RhbCA+IDA7XG4gIGJhci5oaWRkZW4gPSAhc2hvd0JhcjtcbiAgYmFyLmNsYXNzTGlzdC50b2dnbGUoXCJ2aXNpYmxlXCIsIHNob3dCYXIpO1xuICBiYXIuY2xhc3NMaXN0LnRvZ2dsZShcIndhcm5cIiwgYXR0ZW50aW9uVG90YWwgPiAwKTtcbiAgaWYgKHNob3dCYXIpIHtcbiAgICBjb25zdCBhcHByb3ZhbCA9IGFsbC5maW5kKCh0KSA9PiB0LmFwcHJvdmFsKTtcbiAgICBjb25zdCBsYWJlbCA9IGFwcHJvdmFsXG4gICAgICA/IGBBcHByb3ZhbCBuZWVkZWQ6ICR7YXBwcm92YWwuYy5sYWJlbH1gXG4gICAgICA6IGF0dGVudGlvblRvdGFsID4gMFxuICAgICAgICA/IGAke2F0dGVudGlvblRvdGFsfSB0YXNrJHthdHRlbnRpb25Ub3RhbCA+IDEgPyBcInNcIiA6IFwiXCJ9IHdhaXRpbmcgZm9yIHlvdWBcbiAgICAgICAgOiBgJHthY3RpdmVUb3RhbH0gYWN0aXZlIHRhc2ske2FjdGl2ZVRvdGFsID4gMSA/IFwic1wiIDogXCJcIn1gO1xuICAgICQoXCJtdGItdGV4dFwiKS50ZXh0Q29udGVudCA9IGxhYmVsO1xuICB9XG59XG5cbi8qKiBUaGUgRmluaXNoZWQgZm9sZCdzIGNvdW50LCBhbmQgdGhlIGZvbGQgaXRzZWxmIG9ubHkgd2hlbiBzb21ldGhpbmcgaXMgaW4gaXQuICovXG5mdW5jdGlvbiBzaG93RG9uZSgpIHtcbiAgY29uc3QgbiA9ICQoXCJkb25lbm93XCIpLmNoaWxkRWxlbWVudENvdW50ICsgJChcImRvbmVlYXJsaWVyXCIpLmNoaWxkRWxlbWVudENvdW50O1xuICAkKFwiZG9uZWJveFwiKS5oaWRkZW4gPSBuID09PSAwO1xuICAkKFwiZG9uZWNvdW50XCIpLnRleHRDb250ZW50ID0gbiA+IDAgPyBgXHUwMEI3ICR7bn1gIDogXCJcIjtcbn1cblxuZnVuY3Rpb24gc2hvd1Rhc2tzKGZvcmNlID0gZmFsc2UpIHtcbiAgY29uc3QgcGFuZSA9ICQoXCJ0YXNrc1wiKTtcbiAgY29uc3QgZG9uZSA9ICQoXCJkb25lbm93XCIpO1xuICBjb25zdCBvcGVuID0gZG9jdW1lbnQuYWN0aXZlRWxlbWVudD8uY2xvc2VzdD8uKFwiLnRhc2tcIikgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAoIWZvcmNlICYmIG9wZW4gJiYgKHBhbmUuY29udGFpbnMob3BlbikgfHwgZG9uZS5jb250YWlucyhvcGVuKSkgJiYgb3Blbi5xdWVyeVNlbGVjdG9yKFwiZm9ybVwiKSkgcmV0dXJuOyAvLyBkb24ndCByZWRyYXcgdW5kZXIgc29tZW9uZSB0eXBpbmcgYSBmb2xsb3ctdXBcbiAgcGFuZS5pbm5lckhUTUwgPSBcIlwiO1xuICBkb25lLmlubmVySFRNTCA9IFwiXCI7XG4gIGNvbnN0IGFsbCA9IFsuLi50YXNrcy52YWx1ZXMoKV0ucmV2ZXJzZSgpO1xuICBpZiAoYWxsLmxlbmd0aCA9PT0gMCkge1xuICAgIHBhbmUuYXBwZW5kKG5vVGFza3MpO1xuICAgICQoXCJ0YXNrY291bnRcIikudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICQoXCJjYW5jZWxhbGxcIikuaGlkZGVuID0gdHJ1ZTtcbiAgICBzaG93RG9uZSgpO1xuICAgIHVwZGF0ZVRhc2tDaHJvbWUoKTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgcnVubmluZyA9IGFsbC5maWx0ZXIoKHQpID0+IHQuYy5zdGF0ZSA9PT0gXCJydW5uaW5nXCIpLmxlbmd0aDtcbiAgY29uc3QgYWN0aXZlQ291bnQgPSBhbGwuZmlsdGVyKCh0KSA9PiBsaXZlKHQuYy5zdGF0ZSkpLmxlbmd0aDtcbiAgJChcInRhc2tjb3VudFwiKS50ZXh0Q29udGVudCA9IHJ1bm5pbmcgPiAwID8gYCR7cnVubmluZ30gcnVubmluZ2AgOiBhY3RpdmVDb3VudCA+IDAgPyBgJHthY3RpdmVDb3VudH0gd2FpdGluZ2AgOiBcIlwiO1xuICAkKFwiY2FuY2VsYWxsXCIpLmhpZGRlbiA9ICFjYWxsSWQgfHwgcnVubmluZyA8IDI7XG4gIGZvciAoY29uc3QgdmlldyBvZiBhbGwpIHtcbiAgICBjb25zdCB0ID0gdmlldy5jO1xuICAgIGNvbnN0IHdhaXRpbmcgPSB0LnN0YXRlLnN0YXJ0c1dpdGgoXCJ3YWl0aW5nXCIpO1xuICAgIGNvbnN0IGNhcmQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGNhcmQuY2xhc3NOYW1lID0gYHRhc2sgJHt3YWl0aW5nID8gXCJ3YWl0aW5nXCIgOiB0LnN0YXRlfWA7XG4gICAgY29uc3QgYWdlID0gKHZpZXcuZW5kZWQgPz8gbm93KCkpIC0gdmlldy5zaW5jZTtcbiAgICBjYXJkLmlubmVySFRNTCA9XG4gICAgICBgPGRpdiBjbGFzcz1cIm1ldGEtcm93XCI+YCArXG4gICAgICAgIGA8c3BhbiBjbGFzcz1cImJhZGdlICR7dC5hZ2VudCA9PT0gXCJ0M1wiID8gXCJ0M1wiIDogXCJcIn1cIj4ke3QuYWdlbnQgPT09IFwidDNcIiA/IFwiVDNcIiA6IFwiSGVybWVzXCJ9PC9zcGFuPmAgK1xuICAgICAgICBgPHNwYW4gY2xhc3M9XCJzdGF0ZVwiPiR7dC5zdGF0ZSA9PT0gXCJydW5uaW5nXCIgPyAnPHNwYW4gY2xhc3M9XCJzcGluXCI+PC9zcGFuPicgOiBcIlwifSR7ZXNjYXBlSHRtbCh0LnN0YXRlKX08L3NwYW4+YCArXG4gICAgICAgIGA8c3BhbiBjbGFzcz1cImFnZVwiPiR7ZWxhcHNlZChhZ2UpfTwvc3Bhbj5gICtcbiAgICAgIGA8L2Rpdj5gICtcbiAgICAgIGA8ZGl2IGNsYXNzPVwibGFiZWxcIj48L2Rpdj5gICtcbiAgICAgIGA8ZGl2IGNsYXNzPVwicFwiPjwvZGl2PmA7XG4gICAgY2FyZC5xdWVyeVNlbGVjdG9yKFwiLmxhYmVsXCIpIS50ZXh0Q29udGVudCA9IHQubGFiZWw7XG4gICAgY2FyZC5xdWVyeVNlbGVjdG9yKFwiLnBcIikhLnRleHRDb250ZW50ID0gdC5wcm9ncmVzcyA/PyB0LnJlcXVlc3Q7XG4gICAgaWYgKHQucXVlc3Rpb24pIHtcbiAgICAgIGNvbnN0IHEgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgICAgcS5jbGFzc05hbWUgPSBcInFcIjtcbiAgICAgIHEudGV4dENvbnRlbnQgPSBgQXNrczogJHt0LnF1ZXN0aW9ufWA7XG4gICAgICBjYXJkLmFwcGVuZChxKTtcbiAgICB9XG4gICAgaWYgKHZpZXcuYXBwcm92YWwgJiYgdC5zdGF0ZSA9PT0gXCJydW5uaW5nXCIpIHtcbiAgICAgIGNvbnN0IGJveCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICBib3guY2xhc3NOYW1lID0gXCJhcHByb3ZhbFwiO1xuICAgICAgYm94LmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPVwiYXBwcm92YWwtaGVhZFwiPkhlcm1lcyBhc2tzIHRvIHJ1bjwvZGl2Pjxjb2RlPjwvY29kZT48ZGl2IGNsYXNzPVwiYWN0c1wiPjwvZGl2PmA7XG4gICAgICBib3gucXVlcnlTZWxlY3RvcihcImNvZGVcIikhLnRleHRDb250ZW50ID0gdmlldy5hcHByb3ZhbC5jb21tYW5kO1xuICAgICAgY29uc3QgYW5zd2VyID0gKGNob2ljZTogXCJvbmNlXCIgfCBcImRlbnlcIikgPT4ge1xuICAgICAgICB2aWV3LmFwcHJvdmFsID0gdW5kZWZpbmVkO1xuICAgICAgICBzaG93VGFza3ModHJ1ZSk7XG4gICAgICAgIHZvaWQgZmV0Y2goXCIvaGVybWVzL2FwcHJvdmFsXCIsIHsgbWV0aG9kOiBcIlBPU1RcIiwgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBjYWxsOiBjYWxsTmFtZSwgdGFza0lkOiB0LmlkLCBjaG9pY2UgfSkgfSlcbiAgICAgICAgICAudGhlbigocikgPT4gdG9hc3Qoci5vayA/IChjaG9pY2UgPT09IFwib25jZVwiID8gXCJBcHByb3ZlZFwiIDogXCJEZW5pZWRcIikgOiBcIlRoYXQgYXBwcm92YWwgaGFkIGFscmVhZHkgbGFwc2VkXCIpKTtcbiAgICAgIH07XG4gICAgICBmb3IgKGNvbnN0IFtsYWJlbCwgY2hvaWNlXSBvZiBbW1wiQXBwcm92ZSBvbmNlXCIsIFwib25jZVwiXSwgW1wiRGVueVwiLCBcImRlbnlcIl1dIGFzIGNvbnN0KSB7XG4gICAgICAgIGNvbnN0IGIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICAgICAgICBiLnR5cGUgPSBcImJ1dHRvblwiO1xuICAgICAgICBiLnRleHRDb250ZW50ID0gbGFiZWw7XG4gICAgICAgIGlmIChjaG9pY2UgPT09IFwib25jZVwiKSBiLmNsYXNzTmFtZSA9IFwiZ29cIjtcbiAgICAgICAgZWxzZSBiLmNsYXNzTmFtZSA9IFwiZGFuZ2VyXCI7XG4gICAgICAgIGIub25jbGljayA9ICgpID0+IGFuc3dlcihjaG9pY2UpO1xuICAgICAgICBib3gucXVlcnlTZWxlY3RvcihcIi5hY3RzXCIpIS5hcHBlbmQoYik7XG4gICAgICB9XG4gICAgICBjYXJkLmFwcGVuZChib3gpO1xuICAgIH1cbiAgICBpZiAodC5zdGF0ZSAhPT0gXCJydW5uaW5nXCIpIHZpZXcuYXBwcm92YWwgPSB1bmRlZmluZWQ7XG4gICAgY29uc3QgYWN0cyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgYWN0cy5jbGFzc05hbWUgPSBcImFjdHNcIjtcbiAgICBjb25zdCBidXR0b24gPSAodGV4dDogc3RyaW5nLCBmbjogKCkgPT4gdm9pZCwgY2xzID0gXCJcIikgPT4ge1xuICAgICAgY29uc3QgYiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gICAgICBiLnR5cGUgPSBcImJ1dHRvblwiO1xuICAgICAgYi50ZXh0Q29udGVudCA9IHRleHQ7XG4gICAgICBpZiAoY2xzKSBiLmNsYXNzTmFtZSA9IGNscztcbiAgICAgIGIub25jbGljayA9IGZuO1xuICAgICAgYWN0cy5hcHBlbmQoYik7XG4gICAgICByZXR1cm4gYjtcbiAgICB9O1xuICAgIGlmIChjYWxsSWQpIHtcbiAgICAgIGJ1dHRvbih3YWl0aW5nID8gXCJBbnN3ZXJcIiA6IFwiRm9sbG93IHVwXCIsICgpID0+IGZvbGxvd1VwRm9ybShjYXJkLCB0KSk7XG4gICAgICBpZiAodC5zdGF0ZSA9PT0gXCJydW5uaW5nXCIpIGJ1dHRvbihcIkNhbmNlbFwiLCAoKSA9PiBwdXNoKHsgdHlwZTogXCJjYW5jZWxUYXNrXCIsIHRhc2s6IHQuaWQgfSksIFwiZGFuZ2VyXCIpO1xuICAgIH1cbiAgICBpZiAodmlldy5yZXN1bHQpIGJ1dHRvbihcIlJlc3VsdFwiLCAoKSA9PiB7IHNldFRhc2tzT3BlbihmYWxzZSk7IHZpZXcucmVzdWx0IS5zY3JvbGxJbnRvVmlldyh7IGJlaGF2aW9yOiBcInNtb290aFwiLCBibG9jazogXCJjZW50ZXJcIiB9KTsgdmlldy5yZXN1bHQhLmNsYXNzTGlzdC5hZGQoXCJvcGVuXCIpOyB9KTtcbiAgICBpZiAodmlldy50aHJlYWQpIGJ1dHRvbihcIkNvcHkgdGhyZWFkIGlkXCIsICgpID0+IHsgdm9pZCBuYXZpZ2F0b3IuY2xpcGJvYXJkPy53cml0ZVRleHQodmlldy50aHJlYWQhKTsgdG9hc3QoXCJUaHJlYWQgaWQgY29waWVkXCIpOyB9KTtcbiAgICBpZiAoYWN0cy5jaGlsZEVsZW1lbnRDb3VudCkgY2FyZC5hcHBlbmQoYWN0cyk7XG4gICAgKGxpdmUodC5zdGF0ZSkgPyBwYW5lIDogZG9uZSkuYXBwZW5kKGNhcmQpO1xuICB9XG4gIGlmIChwYW5lLmNoaWxkRWxlbWVudENvdW50ID09PSAwKSBwYW5lLmFwcGVuZChub1Rhc2tzKTtcbiAgc2hvd0RvbmUoKTtcbiAgdXBkYXRlVGFza0Nocm9tZSgpO1xufVxuXG5mdW5jdGlvbiBmb2xsb3dVcEZvcm0oY2FyZDogSFRNTEVsZW1lbnQsIHQ6IENvbW1hbmQpIHtcbiAgaWYgKGNhcmQucXVlcnlTZWxlY3RvcihcImZvcm1cIikpIHJldHVybjtcbiAgY29uc3QgZm9ybSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJmb3JtXCIpO1xuICBmb3JtLmlubmVySFRNTCA9IGA8aW5wdXQgdHlwZT1cInRleHRcIiBwbGFjZWhvbGRlcj1cIlRlbGwgXHUyMDFDJHtlc2NhcGVIdG1sKHQubGFiZWwpfVx1MjAxRFx1MjAyNlwiIGVudGVya2V5aGludD1cInNlbmRcIj48YnV0dG9uIHR5cGU9XCJzdWJtaXRcIj5TZW5kPC9idXR0b24+YDtcbiAgY29uc3QgaW5wdXQgPSBmb3JtLnF1ZXJ5U2VsZWN0b3IoXCJpbnB1dFwiKSE7XG4gIGZvcm0ub25zdWJtaXQgPSAoZSkgPT4ge1xuICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICBjb25zdCB0ZXh0ID0gaW5wdXQudmFsdWUudHJpbSgpO1xuICAgIGlmICh0ZXh0KSB7IHB1c2goeyB0eXBlOiBcInN0ZWVyXCIsIHRhc2s6IHQuaWQsIHRleHQgfSk7IG5vdGUoYFlvdSBcdTIxOTIgJHt0LmxhYmVsfTogJHt0ZXh0fWApOyB9XG4gICAgaW5wdXQuYmx1cigpO1xuICAgIGZvcm0ucmVtb3ZlKCk7XG4gICAgc2hvd1Rhc2tzKCk7XG4gIH07XG4gIGlucHV0Lm9ua2V5ZG93biA9IChlKSA9PiB7IGlmIChlLmtleSA9PT0gXCJFc2NhcGVcIikgeyBpbnB1dC5ibHVyKCk7IGZvcm0ucmVtb3ZlKCk7IHNob3dUYXNrcygpOyB9IH07XG4gIGNhcmQuYXBwZW5kKGZvcm0pO1xuICBpbnB1dC5mb2N1cygpO1xufVxuXG4vKiogVDMgdGhyZWFkcyBlYXJsaWVyIGNhbGxzIHN0YXJ0ZWQ6IHRoZXkgY2Fycnkgb24gYWZ0ZXIgYSBjYWxsLCBzbyB0aGUgcGFuZWwgc2F5cyBob3cgdGhleSdyZSBkb2luZy4gKi9cbmFzeW5jIGZ1bmN0aW9uIHNob3dFYXJsaWVyKCkge1xuICBsZXQgbGlzdDogeyB0aHJlYWQ6IHN0cmluZzsgdGl0bGU6IHN0cmluZzsgc3RhdHVzOiBzdHJpbmc7IGJyYW5jaDogc3RyaW5nIHwgbnVsbDsgcHI6IHN0cmluZyB8IG51bGw7IHVwZGF0ZWQ6IHN0cmluZzsgbGFzdDogc3RyaW5nOyB3YWl0aW5nOiBib29sZWFuIH1bXSA9IFtdO1xuICB0cnkgeyBsaXN0ID0gYXdhaXQgKGF3YWl0IGZldGNoKFwiL2FnZW50L3JlY2VudFwiLCB7IGNhY2hlOiBcIm5vLXN0b3JlXCIgfSkpLmpzb24oKTsgfSBjYXRjaCB7fVxuICBjb25zdCBjdXJyZW50ID0gbmV3IFNldChbLi4udGFza3MudmFsdWVzKCldLm1hcCgodikgPT4gdi50aHJlYWQpLmZpbHRlcihCb29sZWFuKSk7XG4gIGxpc3QgPSBsaXN0LmZpbHRlcigodCkgPT4gIWN1cnJlbnQuaGFzKHQudGhyZWFkKSk7XG4gIGNvbnN0IHBhbmUgPSAkKFwiZWFybGllclwiKTtcbiAgY29uc3QgZG9uZSA9ICQoXCJkb25lZWFybGllclwiKTtcbiAgcGFuZS5pbm5lckhUTUwgPSBcIlwiO1xuICBkb25lLmlubmVySFRNTCA9IFwiXCI7XG4gIGVhcmxpZXJBY3RpdmVDb3VudCA9IDA7XG4gIGVhcmxpZXJXYWl0aW5nQ291bnQgPSAwO1xuICBmb3IgKGNvbnN0IHQgb2YgbGlzdCkge1xuICAgIGNvbnN0IGNhcmQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGNvbnN0IHN0YXRlID0gdC53YWl0aW5nID8gXCJ3YWl0aW5nIGZvciBhcHByb3ZhbCBpbiBUM1wiIDogdC5zdGF0dXM7XG4gICAgY2FyZC5jbGFzc05hbWUgPSBgdGFzayAke3Quc3RhdHVzID09PSBcInJ1bm5pbmdcIiA/IFwicnVubmluZ1wiIDogdC53YWl0aW5nID8gXCJ3YWl0aW5nXCIgOiBcImZpbmlzaGVkXCJ9YDtcbiAgICBjb25zdCBhZ28gPSBNYXRoLm1heCgwLCAoRGF0ZS5ub3coKSAtIERhdGUucGFyc2UodC51cGRhdGVkKSkgLyAxMDAwKTtcbiAgICBjYXJkLmlubmVySFRNTCA9XG4gICAgICBgPGRpdiBjbGFzcz1cIm1ldGEtcm93XCI+YCArXG4gICAgICAgIGA8c3BhbiBjbGFzcz1cImJhZGdlIHQzXCI+VDM8L3NwYW4+YCArXG4gICAgICAgIGA8c3BhbiBjbGFzcz1cInN0YXRlXCI+JHt0LnN0YXR1cyA9PT0gXCJydW5uaW5nXCIgPyAnPHNwYW4gY2xhc3M9XCJzcGluXCI+PC9zcGFuPicgOiBcIlwifSR7ZXNjYXBlSHRtbChzdGF0ZSl9PC9zcGFuPmAgK1xuICAgICAgICBgPHNwYW4gY2xhc3M9XCJhZ2VcIj4ke2VsYXBzZWQoYWdvKX0gYWdvPC9zcGFuPmAgK1xuICAgICAgYDwvZGl2PmAgK1xuICAgICAgYDxkaXYgY2xhc3M9XCJsYWJlbFwiPjwvZGl2PmAgK1xuICAgICAgYDxkaXYgY2xhc3M9XCJwXCI+PC9kaXY+YDtcbiAgICBjYXJkLnF1ZXJ5U2VsZWN0b3IoXCIubGFiZWxcIikhLnRleHRDb250ZW50ID0gdC50aXRsZTtcbiAgICBjYXJkLnF1ZXJ5U2VsZWN0b3IoXCIucFwiKSEudGV4dENvbnRlbnQgPSB0Lmxhc3QgfHwgKHQuYnJhbmNoID8gYE9uICR7dC5icmFuY2h9YCA6IFwiXCIpO1xuICAgIGNvbnN0IGFjdHMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGFjdHMuY2xhc3NOYW1lID0gXCJhY3RzXCI7XG4gICAgaWYgKHQucHIpIHsgY29uc3QgYSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJhXCIpOyBhLmhyZWYgPSB0LnByOyBhLnRhcmdldCA9IFwiX2JsYW5rXCI7IGEucmVsID0gXCJub29wZW5lclwiOyBhLnRleHRDb250ZW50ID0gXCJQdWxsIHJlcXVlc3QgXHUyMTk3XCI7IGFjdHMuYXBwZW5kKGEpOyB9XG4gICAgY29uc3QgY29weSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gICAgY29weS50eXBlID0gXCJidXR0b25cIjtcbiAgICBjb3B5LnRleHRDb250ZW50ID0gXCJDb3B5IHRocmVhZCBpZFwiO1xuICAgIGNvcHkub25jbGljayA9ICgpID0+IHsgdm9pZCBuYXZpZ2F0b3IuY2xpcGJvYXJkPy53cml0ZVRleHQodC50aHJlYWQpOyB0b2FzdChcIlRocmVhZCBpZCBjb3BpZWRcIik7IH07XG4gICAgYWN0cy5hcHBlbmQoY29weSk7XG4gICAgY2FyZC5hcHBlbmQoYWN0cyk7XG4gICAgY29uc3QgYWN0aXZlID0gdC5zdGF0dXMgPT09IFwicnVubmluZ1wiIHx8IHQud2FpdGluZztcbiAgICBpZiAoYWN0aXZlKSBlYXJsaWVyQWN0aXZlQ291bnQrKztcbiAgICBpZiAodC53YWl0aW5nKSBlYXJsaWVyV2FpdGluZ0NvdW50Kys7XG4gICAgKGFjdGl2ZSA/IHBhbmUgOiBkb25lKS5hcHBlbmQoY2FyZCk7XG4gIH1cbiAgJChcImVhcmxpZXJib3hcIikuaGlkZGVuID0gcGFuZS5jaGlsZEVsZW1lbnRDb3VudCA9PT0gMDtcbiAgc2hvd0RvbmUoKTtcbiAgdXBkYXRlVGFza0Nocm9tZSgpO1xufVxuXG5jb25zdCBTVEFUVVNfVEVYVDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgaWRsZTogXCJJZGxlXCIsIGNvbm5lY3Rpbmc6IFwiQ29ubmVjdGluZ1x1MjAyNlwiLCBsaXN0ZW5pbmc6IFwiTGlzdGVuaW5nXCIsIHdvcmtpbmc6IFwiTGlzdGVuaW5nIFx1MDBCNyB0YXNrcyBydW5uaW5nXCIsXG4gIHN0YW5kYnk6IFwiUGF1c2VkIHdoaWxlIHRhc2tzIHJ1biBcdTAwQjcgc3BlYWsgdG8gcmVzdW1lXCIsIHdha2luZzogXCJSZXN1bWluZ1x1MjAyNlwiLCBlbmRlZDogXCJFbmRlZFwiLFxufTtcblxuZnVuY3Rpb24gc2hvd1N0YXR1cyhtZXNzYWdlPzogc3RyaW5nKSB7XG4gIGNvbnN0IHR5cGVkID0gQm9vbGVhbihjYWxsSWQpICYmIG1lZGl1bSA9PT0gXCJ0ZXh0XCI7XG4gIGNvbnN0IHNwZWFraW5nID0gQm9vbGVhbihjYWxsSWQpICYmICF0eXBlZCAmJiBjb3JlU3RhdHVzICE9PSBcInN0YW5kYnlcIiAmJiBhdWRpby5xdWV1ZWQgPiAwLjA1O1xuICBjb25zdCBzaG93biA9IHNwZWFraW5nIHx8ICh0eXBlZCAmJiB0aGlua2luZykgPyBcInNwZWFraW5nXCIgOiBjb3JlU3RhdHVzO1xuICAkKFwic3RhdHVzXCIpLmNsYXNzTmFtZSA9IHNob3duO1xuICBkb2N1bWVudC5ib2R5LmRhdGFzZXQuc3RhdGUgPSBjYWxsSWQgPyBzaG93biA6IFwiaWRsZVwiO1xuICBkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC50b2dnbGUoXCJpbi1zZXNzaW9uXCIsIEJvb2xlYW4oY2FsbElkKSk7XG4gIGxldCB0ZXh0ID0gc3BlYWtpbmcgPyBcIlNwZWFraW5nXCIgOiBTVEFUVVNfVEVYVFtjb3JlU3RhdHVzXSA/PyBjb3JlU3RhdHVzO1xuICBpZiAodHlwZWQgJiYgY29yZVN0YXR1cyAhPT0gXCJlbmRlZFwiKSB0ZXh0ID0gdGhpbmtpbmcgPyBcIldyaXRpbmdcdTIwMjZcIiA6IGNvcmVTdGF0dXMgPT09IFwid29ya2luZ1wiID8gXCJDaGF0IFx1MDBCNyB0YXNrcyBydW5uaW5nXCIgOiBcIkNoYXRcIjtcbiAgaWYgKGNhbGxJZCAmJiAhdHlwZWQgJiYgbXV0ZWQgJiYgIWhvbGRpbmcgJiYgIXNwZWFraW5nKSB0ZXh0ICs9IFwiIFx1MDBCNyBtdXRlZFwiO1xuICBpZiAoaG9sZGluZykgdGV4dCA9IFwiVGFsa2luZyAoaG9sZClcIjtcbiAgaWYgKG1lc3NhZ2UpIHRleHQgPSBgJHt0ZXh0fTogJHttZXNzYWdlfWA7XG4gIGlmIChjb3JlU3RhdHVzICE9PSBcImVuZGVkXCIgfHwgbWVzc2FnZSkgJChcInN0YXR1c3RleHRcIikudGV4dENvbnRlbnQgPSB0ZXh0O1xuICAkPEhUTUxCdXR0b25FbGVtZW50PihcImh1c2hcIikuY2xhc3NMaXN0LnRvZ2dsZShcImxpdmVcIiwgc3BlYWtpbmcgfHwgKHR5cGVkICYmIHRoaW5raW5nKSk7XG5cbiAgY29uc3QgYmFyID0gJChcImNhbGxiYXJcIik7XG4gIGJhci5oaWRkZW4gPSAhY2FsbElkO1xuICBpZiAoY2FsbElkKSB7XG4gICAgJChcImNhbGxiYXItc3RhdGVcIikudGV4dENvbnRlbnQgPSB0ZXh0O1xuICAgICQoXCJjYWxsdGltZXJcIikuaGlkZGVuID0gdHlwZWQ7XG4gICAgaWYgKCF0eXBlZCkgJChcImNhbGx0aW1lclwiKS50ZXh0Q29udGVudCA9IGZvcm1hdENsb2NrKG5vdygpIC0gc3RhcnRlZEF0KTtcbiAgICBjb25zdCB2aXpNb2RlID0gdHlwZWQgPyAodGhpbmtpbmcgPyBcInRoaW5raW5nXCIgOiBcImlkbGVcIilcbiAgICAgIDogc3BlYWtpbmcgPyBcInNwZWFraW5nXCJcbiAgICAgIDogbXV0ZWQgJiYgIWhvbGRpbmcgPyBcIm11dGVkXCJcbiAgICAgIDogc2hvd247XG4gICAgdXBkYXRlVmlzdWFsaXplcih2aXpNb2RlLCBtdXRlZCAmJiAhaG9sZGluZyA/IDAgOiBhdWRpby5sZXZlbCk7XG4gIH1cbn1cblxuLy8gVGhlIGNhbGwuXG5cbmZ1bmN0aW9uIHB1c2goZXZlbnQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XG4gIGlmICghY29yZSB8fCAhY2FsbElkKSByZXR1cm47XG4gIGNvbnN0IGU6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0geyAuLi5ldmVudCwgdDogbm93KCkgfTtcbiAgY29uc3QgcXVpZXQgPSBlLnR5cGUgPT09IFwibWljXCIgfHwgZS50eXBlID09PSBcInRpY2tcIjtcbiAgaWYgKCFxdWlldCkgbG9nKFwiaW5cIiwgZS50eXBlID09PSBcIndzLm1lc3NhZ2VcIiA/IGB3cyAke2Uuc2lkfSBcdTIxOTAgJHticmllZihTdHJpbmcoZS5kYXRhKSl9YCA6IEpTT04uc3RyaW5naWZ5KGUpLnNsaWNlKDAsIDQwMCksIFwiaW5cIik7XG4gIHJ1bihKU09OLnBhcnNlKGNvcmUucHVzaChjYWxsSWQsIEpTT04uc3RyaW5naWZ5KGUpKSkpO1xufVxuXG5mdW5jdGlvbiBydW4oY29tbWFuZHM6IENvbW1hbmRbXSkge1xuICBmb3IgKGNvbnN0IGMgb2YgY29tbWFuZHMpIHtcbiAgICBzd2l0Y2ggKGMudHlwZSkge1xuICAgICAgY2FzZSBcIndzLmNvbm5lY3RcIjogY29ubmVjdChjLnNpZCwgYy5wdXJwb3NlID09PSBcImNhcHRpb25zXCIpOyBicmVhaztcbiAgICAgIGNhc2UgXCJ3cy5zZW5kXCI6IHtcbiAgICAgICAgc29ja2V0cy5nZXQoYy5zaWQpPy5zZW5kKGMuZGF0YSk7XG4gICAgICAgIGlmICghYy5kYXRhLnN0YXJ0c1dpdGgoJ3tcInJlYWx0aW1lSW5wdXRcIjp7XCJhdWRpb1wiJykpIGxvZyhcIm91dFwiLCBgd3MgJHtjLnNpZH0gXHUyMTkyICR7YnJpZWYoYy5kYXRhKX1gLCBcIm91dFwiKTtcbiAgICAgICAgZWxzZSBpZiAoIWNhcHRpb25Tb2NrZXRzLmhhcyhjLnNpZCkpIGNvdW50cy5zZW50Kys7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcIndzLmNsb3NlXCI6IHNvY2tldHMuZ2V0KGMuc2lkKT8uY2xvc2UoKTsgc29ja2V0cy5kZWxldGUoYy5zaWQpOyBsb2coXCJvdXRcIiwgYHdzICR7Yy5zaWR9IGNsb3NlYCwgXCJvdXRcIik7IGJyZWFrO1xuICAgICAgY2FzZSBcIm1pYy5zdGFydFwiOlxuICAgICAgY2FzZSBcIm1pYy5yZXN0YXJ0XCI6XG4gICAgICAgIGxvZyhcIm91dFwiLCBjLnR5cGUsIFwib3V0XCIpO1xuICAgICAgICB2b2lkIGF1ZGlvLnN0YXJ0TWljKG9uTWljLCBtaWNPcHRpb25zKCkpLmNhdGNoKChlcnIpID0+IHsgbG9nKFwiZXJyb3JcIiwgYG1pY3JvcGhvbmU6ICR7ZXJyLm1lc3NhZ2V9YCwgXCJlcnJcIik7IHRvYXN0KGBNaWNyb3Bob25lOiAke2Vyci5tZXNzYWdlfWApOyB9KTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwibWljLnN0b3BcIjogYXVkaW8uc3RvcE1pYygpOyBicmVhaztcbiAgICAgIGNhc2UgXCJwbGF5XCI6IHtcbiAgICAgICAgY29uc3QgdCA9IG5vdygpO1xuICAgICAgICAvLyBBIHJlcGx5IHN0YXJ0aW5nOiBmcm9tIHRoZSBlbmQgb2YgdGhlIHVzZXIncyBzcGVlY2ggdG8gaXRzIGZpcnN0IHNvdW5kLlxuICAgICAgICBpZiAoIW1ldHJpY3MucmVwbGllZCAmJiBhdWRpby5xdWV1ZWQgPCAwLjA1ICYmIHQgLSBtZXRyaWNzLmxhc3RQbGF5ID4gMC42ICYmIG1ldHJpY3MubGFzdFZvaWNlID4gMCAmJiB0IC0gbWV0cmljcy5sYXN0Vm9pY2UgPCAxMCkge1xuICAgICAgICAgIG1ldHJpY3MucmVwbHkucHVzaCh0IC0gbWV0cmljcy5sYXN0Vm9pY2UpO1xuICAgICAgICAgIGlmIChtZXRyaWNzLnJlcGx5Lmxlbmd0aCA+IDIwKSBtZXRyaWNzLnJlcGx5LnNoaWZ0KCk7XG4gICAgICAgICAgbWV0cmljcy5yZXBsaWVkID0gdHJ1ZTtcbiAgICAgICAgICBzaG93TWV0cmljcygpO1xuICAgICAgICB9XG4gICAgICAgIG1ldHJpY3MubGFzdFBsYXkgPSB0O1xuICAgICAgICBhdWRpby5wbGF5KGMucGNtKTtcbiAgICAgICAgY291bnRzLnBsYXkrKztcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwiZmx1c2hcIjogYXVkaW8uZmx1c2goKTsgbG9nKFwib3V0XCIsIFwiZmx1c2hcIiwgXCJvdXRcIik7IGJyZWFrO1xuICAgICAgY2FzZSBcImN1ZVwiOlxuICAgICAgICBhdWRpby5jdWUoYy5wY20pO1xuICAgICAgICBsb2coXCJvdXRcIiwgYGN1ZSAke2MuZWFyY29ufWAsIFwib3V0XCIpO1xuICAgICAgICAvLyBBIHJlcXVlc3QgdGhhdCBiZWNhbWUgYSB0YXNrIGdldHMgYSB0b25lLCBub3QgYSBzcG9rZW4gcmVwbHk6IG5vdGhpbmcgdG8gdGltZS5cbiAgICAgICAgaWYgKGMuZWFyY29uID09PSBcInRhc2tTdGFydGVkXCIpIG1ldHJpY3MucmVwbGllZCA9IHRydWU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcIndha2V3b3JkXCI6IGxvZyhcIm91dFwiLCBgd2FrZSB3b3JkICR7Yy5vbiA/IFwibGlzdGVuaW5nXCIgOiBcIm9mZlwifWAsIFwib3V0XCIpOyBicmVhaztcbiAgICAgIGNhc2UgXCJ0b29sLmNhbGxcIjogdm9pZCB0b29sKGMpOyBicmVhaztcbiAgICAgIGNhc2UgXCJ0b29sLmNhbmNlbFwiOiBjYW5jZWxSdW4oYy5ydW4sIGMucmVhc29uKTsgYnJlYWs7XG4gICAgICBjYXNlIFwidG9vbC5zdGVlclwiOiB2b2lkIHN0ZWVyUnVuKGMpOyBicmVhaztcbiAgICAgIGNhc2UgXCJzdGF0dXNcIjpcbiAgICAgICAgY29yZVN0YXR1cyA9IGMuc3RhdHVzO1xuICAgICAgICBzaG93U3RhdHVzKGMuc3RhdHVzID09PSBcImVuZGVkXCIgPyBjLm1lc3NhZ2UgPz8gdW5kZWZpbmVkIDogdW5kZWZpbmVkKTtcbiAgICAgICAgbG9nKFwic3RhdHVzXCIsIGMuc3RhdHVzICsgKGMubWVzc2FnZSA/IGA6ICR7Yy5tZXNzYWdlfWAgOiBcIlwiKSwgXCJzdGF0dXNcIik7XG4gICAgICAgIGlmIChjLnN0YXR1cyA9PT0gXCJlbmRlZFwiKSB7IGlmIChjLm1lc3NhZ2UpIG5vdGUoYy5tZXNzYWdlKTsgZW5kKCk7IH1cbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwibGxtLnJlcXVlc3RcIjogdm9pZCBnZW5lcmF0ZShjLmlkLCBjLmJvZHkpOyBicmVhaztcbiAgICAgIGNhc2UgXCJsbG0uY2FuY2VsXCI6IHJlcXVlc3RzLmdldChjLmlkKT8uYWJvcnQoKTsgcmVxdWVzdHMuZGVsZXRlKGMuaWQpOyBsb2coXCJvdXRcIiwgYHJlcXVlc3QgJHtjLmlkfSBkcm9wcGVkYCwgXCJvdXRcIik7IGJyZWFrO1xuICAgICAgY2FzZSBcInRoaW5raW5nXCI6IHRoaW5raW5nID0gYy5vbjsgc2hvd1N0YXR1cygpOyBicmVhaztcbiAgICAgIGNhc2UgXCJlcnJvclwiOiBub3RlKGMubWVzc2FnZSk7IGxvZyhcImVycm9yXCIsIGMubWVzc2FnZSwgXCJlcnJcIik7IGJyZWFrO1xuICAgICAgY2FzZSBcImNhcHRpb25cIjogY2FwdGlvbihjLnRleHQpOyBicmVhaztcbiAgICAgIGNhc2UgXCJ0cmFuc2NyaXB0XCI6XG4gICAgICAgIHRyYW5zY3JpcHQoYy5yb2xlLCBjLnRleHQsIGMubGluZSk7XG4gICAgICAgIHJlbWVtYmVyKGMucm9sZSwgYy50ZXh0LCBjLnJvbGUgPT09IFwiYXNzaXN0YW50XCIgPyBcIkdlbWluaVwiIDogdW5kZWZpbmVkLCBsYXN0TGluZSA9PT0gYy5saW5lKTtcbiAgICAgICAgbGFzdExpbmUgPSBjLmxpbmU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcInRhc2tcIjoge1xuICAgICAgICBjb25zdCB2aWV3ID0gdGFza3MuZ2V0KGMuaWQpID8/IHsgYywgc2luY2U6IG5vdygpLCBlbmRlZDogbnVsbCB9O1xuICAgICAgICBpZiAoYy5zdGF0ZSA9PT0gXCJydW5uaW5nXCIgJiYgdmlldy5jLnN0YXRlICE9PSBcInJ1bm5pbmdcIikgeyB2aWV3LnNpbmNlID0gbm93KCk7IHZpZXcuZW5kZWQgPSBudWxsOyB9XG4gICAgICAgIGlmIChjLnN0YXRlICE9PSBcInJ1bm5pbmdcIiAmJiB2aWV3LmVuZGVkID09IG51bGwpIHZpZXcuZW5kZWQgPSBub3coKTtcbiAgICAgICAgdmlldy5jID0gYztcbiAgICAgICAgdGFza3Muc2V0KGMuaWQsIHZpZXcpO1xuICAgICAgICBzaG93VGFza3MoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwicXVlc3Rpb25zXCI6IGJyZWFrO1xuICAgICAgY2FzZSBcIm1pY1NpbGVudFwiOiAkKFwibWljd2FyblwiKS5oaWRkZW4gPSAhYy5zaWxlbnQ7IGJyZWFrO1xuICAgICAgY2FzZSBcInZvaWNlQ29tbWFuZFwiOlxuICAgICAgICB0b2FzdChgSGVhcmQgXHUyMDFDJHtjLmhlYXJkfVx1MjAxRDogJHtjLmNvbW1hbmQgPT09IFwic3RvcFwiID8gXCJzdG9wcGVkXCIgOiBjLmNvbW1hbmQgPT09IFwiY2FuY2VsQWxsXCIgPyBcImNhbmNlbGxpbmcgZXZlcnkgdGFza1wiIDogXCJoYW5naW5nIHVwXCJ9YCk7XG4gICAgICAgIGxvZyhcIm91dFwiLCBgdm9pY2UgY29tbWFuZCAke2MuY29tbWFuZH06ICR7Yy5oZWFyZH1gLCBcIm91dFwiKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwibG9nXCI6IGxvZyhjLmxldmVsLCBjLm1lc3NhZ2UsIGMubGV2ZWwgPT09IFwid2FyblwiID8gXCJ3YXJuXCIgOiBcIlwiKTsgYnJlYWs7XG4gICAgICBkZWZhdWx0OiBsb2coXCJvdXRcIiwgSlNPTi5zdHJpbmdpZnkoYykuc2xpY2UoMCwgMzAwKSwgXCJvdXRcIik7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIG9uTWljKHBjbTogc3RyaW5nLCBsZXZlbDogbnVtYmVyKSB7XG4gIGNvdW50cy5taWMrKztcbiAgaWYgKGxldmVsID4gMC4wMyAmJiAhKG11dGVkICYmICFob2xkaW5nKSkge1xuICAgIG1ldHJpY3MubGFzdFZvaWNlID0gbm93KCk7XG4gICAgaWYgKGF1ZGlvLnF1ZXVlZCA8IDAuMDUpIG1ldHJpY3MucmVwbGllZCA9IGZhbHNlO1xuICB9XG4gIHB1c2goeyB0eXBlOiBcIm1pY1wiLCBwY20gfSk7XG59XG5cbmZ1bmN0aW9uIGNvbm5lY3Qoc2lkOiBudW1iZXIsIGNhcHRpb25zOiBib29sZWFuKSB7XG4gIGNvbnN0IHdzID0gbmV3IFdlYlNvY2tldChgJHtsb2NhdGlvbi5wcm90b2NvbCA9PT0gXCJodHRwczpcIiA/IFwid3NzXCIgOiBcIndzXCJ9Oi8vJHtsb2NhdGlvbi5ob3N0fS9saXZlJHtjYXB0aW9ucyA/IFwiP2Zvcj1jYXB0aW9uc1wiIDogXCJcIn1gKTtcbiAgc29ja2V0cy5zZXQoc2lkLCB3cyk7XG4gIGlmIChjYXB0aW9ucykgY2FwdGlvblNvY2tldHMuYWRkKHNpZCk7XG4gIGxvZyhcIm91dFwiLCBgd3MgJHtzaWR9IGNvbm5lY3QgKCR7c2VydmVyLnJvdXRlfSR7Y2FwdGlvbnMgPyBcIiwgY2FwdGlvbnNcIiA6IFwiXCJ9KWAsIFwib3V0XCIpO1xuICB3cy5vbm9wZW4gPSAoKSA9PiBwdXNoKHsgdHlwZTogXCJ3cy5vcGVuXCIsIHNpZCB9KTtcbiAgd3Mub25tZXNzYWdlID0gKG0pID0+IHB1c2goeyB0eXBlOiBcIndzLm1lc3NhZ2VcIiwgc2lkLCBkYXRhOiB0eXBlb2YgbS5kYXRhID09PSBcInN0cmluZ1wiID8gbS5kYXRhIDogXCJcIiB9KTtcbiAgd3Mub25jbG9zZSA9IChlKSA9PiB7XG4gICAgaWYgKHNvY2tldHMuZ2V0KHNpZCkgIT09IHdzICYmIHNvY2tldHMuaGFzKHNpZCkpIHJldHVybjtcbiAgICBjb25zdCBodHRwU3RhdHVzID0gZS5jb2RlID49IDQxMDAgJiYgZS5jb2RlIDwgNDYwMCA/IGUuY29kZSAtIDQwMDAgOiB1bmRlZmluZWQ7XG4gICAgcHVzaCh7IHR5cGU6IFwid3MuY2xvc2VkXCIsIHNpZCwgY29kZTogaHR0cFN0YXR1cyA/IHVuZGVmaW5lZCA6IGUuY29kZSwgcmVhc29uOiBlLnJlYXNvbiwgaHR0cFN0YXR1cyB9KTtcbiAgfTtcbn1cblxuLyoqIEEgY2hhdCdzIHJlcXVlc3QgdG8gdGhlIHRleHQgbW9kZWwsIHRocm91Z2ggdGhlIHNlcnZlcjogZWFjaCBgZGF0YTpgIGxpbmUgb2YgdGhlIG1vZGVsJ3Mgc3RyZWFtIGdvZXMgdG8gdGhlIGNvcmUgYXMgaXQgY29tZXMuICovXG5hc3luYyBmdW5jdGlvbiBnZW5lcmF0ZShpZDogbnVtYmVyLCBib2R5OiBzdHJpbmcpIHtcbiAgY29uc3QgYWJvcnQgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gIHJlcXVlc3RzLnNldChpZCwgYWJvcnQpO1xuICBsb2coXCJvdXRcIiwgYHJlcXVlc3QgJHtpZH0gXHUyMTkyICR7c2VydmVyLnRleHRNb2RlbH0gKCR7TWF0aC5yb3VuZChib2R5Lmxlbmd0aCAvIDEwMjQpfSBLQilgLCBcIm91dFwiKTtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKFwiL2dlbmVyYXRlXCIsIHsgbWV0aG9kOiBcIlBPU1RcIiwgc2lnbmFsOiBhYm9ydC5zaWduYWwsIGhlYWRlcnM6IHsgXCJjb250ZW50LXR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSwgYm9keSB9KTtcbiAgICBpZiAoIXJlc3BvbnNlLm9rIHx8ICFyZXNwb25zZS5ib2R5KSB7XG4gICAgICBjb25zdCB0ZXh0ID0gYXdhaXQgcmVzcG9uc2UudGV4dCgpLmNhdGNoKCgpID0+IFwiXCIpO1xuICAgICAgcHVzaCh7IHR5cGU6IFwibGxtLmVuZFwiLCBpZCwgc3RhdHVzOiByZXNwb25zZS5zdGF0dXMsIGVycm9yOiBgSFRUUCAke3Jlc3BvbnNlLnN0YXR1c30ke3RleHQgPyBcIjogXCIgKyB0ZXh0LnJlcGxhY2UoL1xccysvZywgXCIgXCIpLnNsaWNlKDAsIDIwMCkgOiBcIlwifWAgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IHJlYWRlciA9IHJlc3BvbnNlLmJvZHkucGlwZVRocm91Z2gobmV3IFRleHREZWNvZGVyU3RyZWFtKCkpLmdldFJlYWRlcigpO1xuICAgIGxldCBidWZmZXIgPSBcIlwiO1xuICAgIGZvciAoOzspIHtcbiAgICAgIGNvbnN0IHsgdmFsdWUsIGRvbmUgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICBpZiAoZG9uZSkgYnJlYWs7XG4gICAgICBidWZmZXIgKz0gdmFsdWU7XG4gICAgICBsZXQgY3V0O1xuICAgICAgd2hpbGUgKChjdXQgPSBidWZmZXIuaW5kZXhPZihcIlxcblwiKSkgPj0gMCkge1xuICAgICAgICBjb25zdCBsaW5lID0gYnVmZmVyLnNsaWNlKDAsIGN1dCkucmVwbGFjZSgvXFxyJC8sIFwiXCIpO1xuICAgICAgICBidWZmZXIgPSBidWZmZXIuc2xpY2UoY3V0ICsgMSk7XG4gICAgICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgoXCJkYXRhOlwiKSkgcHVzaCh7IHR5cGU6IFwibGxtLmRhdGFcIiwgaWQsIGRhdGE6IGxpbmUuc2xpY2UoNSkudHJpbSgpIH0pO1xuICAgICAgfVxuICAgIH1cbiAgICBwdXNoKHsgdHlwZTogXCJsbG0uZW5kXCIsIGlkIH0pO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBpZiAoIWFib3J0LnNpZ25hbC5hYm9ydGVkKSBwdXNoKHsgdHlwZTogXCJsbG0uZW5kXCIsIGlkLCBlcnJvcjogKGVyciBhcyBFcnJvcikubWVzc2FnZSB9KTtcbiAgfSBmaW5hbGx5IHtcbiAgICByZXF1ZXN0cy5kZWxldGUoaWQpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGNhbmNlbFJ1bihrZXk6IHN0cmluZywgcmVhc29uOiBzdHJpbmcpIHtcbiAgY29uc3QgciA9IHJ1bnMuZ2V0KGtleSk7XG4gIGxvZyhcIm91dFwiLCBgY2FuY2VsICR7a2V5fSAoJHtyZWFzb259KWAsIFwib3V0XCIpO1xuICBpZiAoIXIpIHJldHVybjtcbiAgcnVucy5kZWxldGUoa2V5KTtcbiAgci5hYm9ydC5hYm9ydCgpO1xuICAvLyBDYW5jZWxsZWQgb24gcHVycG9zZTogdGhlIGFnZW50IHN0b3BzIHRvby4gQSBjYWxsIHRoYXQgZW5kZWQgbGVhdmVzIGEgY29kaW5nIGFnZW50IHdvcmtpbmcgaW4gVDMuXG4gIGlmIChyZWFzb24gPT09IFwiY2FuY2VsbGVkXCIgJiYgIWNoZWNrZWQoXCJmYWtlaGVybWVzXCIpKSB7XG4gICAgdm9pZCBmZXRjaChyLmFnZW50ID09PSBcInQzXCIgPyBcIi9hZ2VudC9jYW5jZWxcIiA6IFwiL2hlcm1lcy9zdG9wXCIsIHsgbWV0aG9kOiBcIlBPU1RcIiwgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBjYWxsOiBjYWxsTmFtZSwgdGFza0lkOiByLnRhc2tJZCB9KSB9KTtcbiAgfVxufVxuXG4vKiogTW9yZSBmb3IgYSBydW5uaW5nIHRhc2ssIGludG8gaXRzIGN1cnJlbnQgcnVuOyBpZiB0aGUgYWdlbnQgd29uJ3QgdGFrZSBpdCwgdGhlIGNvcmUgcXVldWVzIGl0IGluc3RlYWQuICovXG5hc3luYyBmdW5jdGlvbiBzdGVlclJ1bihjOiBDb21tYW5kKSB7XG4gIGNvbnN0IHIgPSBydW5zLmdldChjLnJ1bik7XG4gIGxvZyhcIm91dFwiLCBgc3RlZXIgJHtjLnJ1bn06ICR7Yy50ZXh0fWAsIFwib3V0XCIpO1xuICBpZiAoY2hlY2tlZChcImZha2VoZXJtZXNcIikpIHJldHVybjtcbiAgY29uc3Qgb2sgPSByICE9IG51bGwgJiZcbiAgICAoYXdhaXQgZmV0Y2goYy5hZ2VudCA9PT0gXCJ0M1wiID8gXCIvYWdlbnQvc3RlZXJcIiA6IFwiL2hlcm1lcy9zdGVlclwiLCB7IG1ldGhvZDogXCJQT1NUXCIsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgY2FsbDogY2FsbE5hbWUsIHRhc2tJZDogci50YXNrSWQsIHRleHQ6IGMubWVzc2FnZSB9KSB9KS50aGVuKCh4KSA9PiB4Lm9rLCAoKSA9PiBmYWxzZSkpO1xuICBpZiAoIW9rKSBwdXNoKHsgdHlwZTogXCJ0b29sLnN0ZWVyRmFpbGVkXCIsIHJ1bjogYy5ydW4sIHRleHQ6IGMudGV4dCB9KTtcbiAgZWxzZSB0b2FzdChgJHtjLmFnZW50ID09PSBcInQzXCIgPyBcIlRoZSBjb2RpbmcgYWdlbnRcIiA6IFwiSGVybWVzXCJ9IHRvb2sgdGhlIGZvbGxvdy11cCB3aGlsZSBpdCB3b3Jrc2ApO1xufVxuXG5hc3luYyBmdW5jdGlvbiB0b29sKGM6IENvbW1hbmQpIHtcbiAgaWYgKGMua2luZCA9PT0gXCJob3N0XCIpIHtcbiAgICBsb2coXCJvdXRcIiwgYGhvc3QgdG9vbCAke2MubmFtZX0gJHtKU09OLnN0cmluZ2lmeShjLmFyZ3MpfWAsIFwib3V0XCIpO1xuICAgIGNvbnN0IGFuc3dlciA9IGMubmFtZSA9PT0gXCJ0dl92b2x1bWVcIiA/IGBUaGUgVFYgaXMgYXQgJHsoZmFrZVR2TGV2ZWwgPSBOdW1iZXIoYy5hcmdzPy5sZXZlbCA/PyBmYWtlVHZMZXZlbCkpfS5gXG4gICAgICA6IGMubmFtZSA9PT0gXCJ0dl9wYXVzZVwiID8gKGMuYXJncz8ucGF1c2UgPT09IGZhbHNlID8gXCJQbGF5aW5nLlwiIDogXCJQYXVzZWQuXCIpIDogXCJEb25lLlwiO1xuICAgIHNldFRpbWVvdXQoKCkgPT4gcHVzaCh7IHR5cGU6IFwidG9vbC5yZXN1bHRcIiwgcnVuOiBjLnJ1biwgdGV4dDogYW5zd2VyIH0pLCAzMDApO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBhZ2VudCA9IGMuYWdlbnQgPT09IFwidDNcIiA/IFwidDNcIiA6IFwiaGVybWVzXCI7XG4gIGxvZyhcIm91dFwiLCBgJHthZ2VudH0gJHtjLmZvbGxvd1VwID8gXCJmb2xsb3ctdXBcIiA6IFwidGFza1wifSBcIiR7Yy5sYWJlbH1cIiR7Yy5wcm9qZWN0ID8gYCBpbiAke2MucHJvamVjdH1gIDogXCJcIn06ICR7Yy5yZXF1ZXN0fWAsIFwib3V0XCIpO1xuICBjb25zdCBhYm9ydCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgcnVucy5zZXQoYy5ydW4sIHsgYWJvcnQsIGFnZW50LCB0YXNrSWQ6IGMudGFza0lkIH0pO1xuICBjb25zdCBkb25lID0gKHRleHQ6IHN0cmluZywgZmFpbGVkID0gZmFsc2UpID0+IHtcbiAgICBpZiAoIXJ1bnMuaGFzKGMucnVuKSkgcmV0dXJuO1xuICAgIHJ1bnMuZGVsZXRlKGMucnVuKTtcbiAgICBjb25zdCB2aWV3ID0gdGFza3MuZ2V0KGMudGFza0lkKTtcbiAgICBjb25zdCByb3cgPSByZXN1bHQoYWdlbnQsIGMubGFiZWwsIHRleHQsIGZhaWxlZCk7XG4gICAgbm90aWZ5KGAke2FnZW50ID09PSBcInQzXCIgPyBcIlQzXCIgOiBcIkhlcm1lc1wifSBcdTAwQjcgJHtjLmxhYmVsfWAsIHRleHQpO1xuICAgIGlmICghZmFpbGVkKSB7IHJlbWVtYmVyKFwiYXNzaXN0YW50XCIsIHRleHQsIGAke2FnZW50ID09PSBcInQzXCIgPyBcIlQzXCIgOiBcIkhlcm1lc1wifSBcdTAwQjcgJHtjLmxhYmVsfWApOyBsYXN0TGluZSA9IG51bGw7IH1cbiAgICBpZiAodmlldykgeyB2aWV3LnJlc3VsdCA9IHJvdzsgc2hvd1Rhc2tzKCk7IH1cbiAgICBwdXNoKHsgdHlwZTogXCJ0b29sLnJlc3VsdFwiLCBydW46IGMucnVuLCB0ZXh0LCBmYWlsZWQgfSk7XG4gIH07XG4gIGlmIChjaGVja2VkKFwiZmFrZWhlcm1lc1wiKSkge1xuICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiBkb25lKGAoRmFrZSAke2FnZW50ID09PSBcInQzXCIgPyBcIlQzXCIgOiBcIkhlcm1lc1wifSkgRG9uZTogXHUyMDFDJHtjLnJlcXVlc3R9XHUyMDFELiBOb3RoaW5nIHdhcyBhY3R1YWxseSBydW4uYCksIE51bWJlcigkPEhUTUxJbnB1dEVsZW1lbnQ+KFwiZmFrZWRlbGF5XCIpLnZhbHVlKSAqIDEwMDApO1xuICAgIGFib3J0LnNpZ25hbC5vbmFib3J0ID0gKCkgPT4gY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICByZXR1cm47XG4gIH1cbiAgdHJ5IHtcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKGFnZW50ID09PSBcInQzXCIgPyBcIi9hZ2VudFwiIDogXCIvaGVybWVzXCIsIHtcbiAgICAgIG1ldGhvZDogXCJQT1NUXCIsIHNpZ25hbDogYWJvcnQuc2lnbmFsLCBoZWFkZXJzOiB7IFwiY29udGVudC10eXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGNhbGw6IGNhbGxOYW1lLCB0YXNrSWQ6IGMudGFza0lkLCBmb2xsb3dVcDogYy5mb2xsb3dVcCwgbWVzc2FnZTogYy5tZXNzYWdlLCBsYWJlbDogYy5sYWJlbCwgcmVxdWVzdDogYy5yZXF1ZXN0LCBwcm9qZWN0OiBjLnByb2plY3QsIGFwcHJvdmFsczogXCJzY3JlZW5cIiB9KSxcbiAgICB9KTtcbiAgICBpZiAoIXJlc3BvbnNlLm9rIHx8ICFyZXNwb25zZS5ib2R5KSB0aHJvdyBuZXcgRXJyb3IoYEhUVFAgJHtyZXNwb25zZS5zdGF0dXN9YCk7XG4gICAgY29uc3QgcmVhZGVyID0gcmVzcG9uc2UuYm9keS5waXBlVGhyb3VnaChuZXcgVGV4dERlY29kZXJTdHJlYW0oKSkuZ2V0UmVhZGVyKCk7XG4gICAgbGV0IGJ1ZmZlciA9IFwiXCI7XG4gICAgZm9yICg7Oykge1xuICAgICAgY29uc3QgeyB2YWx1ZSwgZG9uZTogZmluaXNoZWQgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICBpZiAoZmluaXNoZWQpIGJyZWFrO1xuICAgICAgYnVmZmVyICs9IHZhbHVlO1xuICAgICAgbGV0IGN1dDtcbiAgICAgIHdoaWxlICgoY3V0ID0gYnVmZmVyLmluZGV4T2YoXCJcXG5cXG5cIikpID49IDApIHtcbiAgICAgICAgY29uc3QgYmxvY2sgPSBidWZmZXIuc2xpY2UoMCwgY3V0KTtcbiAgICAgICAgYnVmZmVyID0gYnVmZmVyLnNsaWNlKGN1dCArIDIpO1xuICAgICAgICBjb25zdCBldmVudCA9IGJsb2NrLm1hdGNoKC9eZXZlbnQ6ICguKikkL20pPy5bMV07XG4gICAgICAgIGlmICghZXZlbnQpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCBkYXRhID0gSlNPTi5wYXJzZShibG9jay5tYXRjaCgvXmRhdGE6ICguKikkL20pPy5bMV0gPz8gXCJ7fVwiKTtcbiAgICAgICAgaWYgKGV2ZW50ID09PSBcInByb2dyZXNzXCIpIHB1c2goeyB0eXBlOiBcInRhc2sucHJvZ3Jlc3NcIiwgdGFzazogYy50YXNrSWQsIHRleHQ6IGRhdGEudGV4dCB9KTtcbiAgICAgICAgZWxzZSBpZiAoZXZlbnQgPT09IFwidGhyZWFkXCIpIHsgY29uc3QgdmlldyA9IHRhc2tzLmdldChjLnRhc2tJZCk7IGlmICh2aWV3KSB7IHZpZXcudGhyZWFkID0gZGF0YS50aHJlYWQ7IHNob3dUYXNrcygpOyB9IH1cbiAgICAgICAgZWxzZSBpZiAoZXZlbnQgPT09IFwiYXBwcm92YWxcIikge1xuICAgICAgICAgIGNvbnN0IHZpZXcgPSB0YXNrcy5nZXQoYy50YXNrSWQpO1xuICAgICAgICAgIGlmICh2aWV3KSB7IHZpZXcuYXBwcm92YWwgPSB7IGNvbW1hbmQ6IGRhdGEuY29tbWFuZCB9OyBzaG93VGFza3ModHJ1ZSk7IH1cbiAgICAgICAgICB0b2FzdChgSGVybWVzIGFza3MgdG8gcnVuOiAke2RhdGEuY29tbWFuZC5zbGljZSgwLCA4MCl9YCk7XG4gICAgICAgICAgbm90aWZ5KGBIZXJtZXMgXHUwMEI3ICR7Yy5sYWJlbH0gbmVlZHMgeW91ciBhcHByb3ZhbGAsIGRhdGEuY29tbWFuZCk7XG4gICAgICAgICAgYXVkaW8uY3VlKEFQUFJPVkFMX1RPTkUpO1xuICAgICAgICB9XG4gICAgICAgIGVsc2UgaWYgKGV2ZW50ID09PSBcInJlc3VsdFwiKSBkb25lKGRhdGEudGV4dCwgZGF0YS5mYWlsZWQpO1xuICAgICAgICBlbHNlIGlmIChldmVudCA9PT0gXCJlcnJvclwiKSB7IHJ1bnMuZGVsZXRlKGMucnVuKTsgcHVzaCh7IHR5cGU6IFwidG9vbC5lcnJvclwiLCBydW46IGMucnVuLCBtZXNzYWdlOiBkYXRhLm1lc3NhZ2UgfSk7IH1cbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKHJ1bnMuaGFzKGMucnVuKSkgeyBydW5zLmRlbGV0ZShjLnJ1bik7IHB1c2goeyB0eXBlOiBcInRvb2wuZXJyb3JcIiwgcnVuOiBjLnJ1biwgbWVzc2FnZTogXCJ0aGUgc2VydmVyIGNsb3NlZCB0aGUgc3RyZWFtIHdpdGhvdXQgYSByZXN1bHRcIiB9KTsgfVxuICB9IGNhdGNoIChlcnIpIHtcbiAgICBpZiAoIWFib3J0LnNpZ25hbC5hYm9ydGVkICYmIHJ1bnMuaGFzKGMucnVuKSkgeyBydW5zLmRlbGV0ZShjLnJ1bik7IHB1c2goeyB0eXBlOiBcInRvb2wuZXJyb3JcIiwgcnVuOiBjLnJ1biwgbWVzc2FnZTogKGVyciBhcyBFcnJvcikubWVzc2FnZSB9KTsgfVxuICB9XG59XG5cbmZ1bmN0aW9uIG1pY09wdGlvbnMoKSB7XG4gIGNvbnN0IGFlYyA9IGNoZWNrZWQoXCJhZWNcIik7XG4gIHJldHVybiB7IGVjaG9DYW5jZWxsYXRpb246IGFlYywgbm9pc2VTdXBwcmVzc2lvbjogYWVjLCBhdXRvR2FpbkNvbnRyb2w6IGFlYyB9O1xufVxuXG5mdW5jdGlvbiByZWFkQ29uZmlnKCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgY29uc3QgZ2l2ZW4gPSBKU09OLnBhcnNlKCQ8SFRNTFRleHRBcmVhRWxlbWVudD4oXCJjb25maWdcIikudmFsdWUpO1xuICBjb25zdCBjb25maWc6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgIG1vZGVsOiBzZXJ2ZXIubW9kZWwsIGFwaTogc2VydmVyLnJvdXRlID09PSBcInZlcnRleFwiID8gXCJ2ZXJ0ZXhcIiA6IFwiZ2VtaW5pXCIsIHRvZGF5OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkuc2xpY2UoMCwgMTApLFxuICAgIC4uLmdpdmVuLCB0cmFjZTogY2hlY2tlZChcInRyYWNlXCIpLFxuICB9O1xuICBpZiAoY2hlY2tlZChcInB0dFwiKSkgY29uZmlnLm11dGVkID0gdHJ1ZTtcbiAgaWYgKGdpdmVuLnZvaWNlID09PSB1bmRlZmluZWQpIGNvbmZpZy52b2ljZSA9ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwidm9pY2VcIikudmFsdWU7XG4gIGlmIChjb25maWcuc3RlZXJpbmcgPT09IHVuZGVmaW5lZCkgY29uZmlnLnN0ZWVyaW5nID0gW1wiaGVybWVzXCIsIFwidDNcIl07XG4gIC8vIEEgd2ViIGNvbmZpZyBzYXZlZCBiZWZvcmUgaGFuZC1vZmZzIHdlcmUgbmFtZWQgaW4gd29yZHMgZ2V0cyB0aGF0IHRvby5cbiAgaWYgKGNvbmZpZy5oYW5kT2ZmID09PSB1bmRlZmluZWQgJiYgY29uZmlnLnBsYXRmb3JtID09PSBcIndlYlwiKSBjb25maWcuaGFuZE9mZiA9IFwibmFtZWRcIjtcbiAgLy8gQW5kIG9uZSBzYXZlZCBiZWZvcmUgdGhlIHBhZ2UgZm9sbG93ZWQgdGhlIHVzZXIncyBsZWFkIChzdXBlcnZpc2UpIGdldHMgdGhhdC5cbiAgaWYgKGNvbmZpZy5zdXBlcnZpc2UgPT09IHVuZGVmaW5lZCAmJiBjb25maWcucGxhdGZvcm0gPT09IFwid2ViXCIpIGNvbmZpZy5zdXBlcnZpc2UgPSB0cnVlO1xuICBpZiAoY2hlY2tlZChcImNvZGluZ1wiKSAmJiAoc2VydmVyLnQzIHx8IGNoZWNrZWQoXCJmYWtlaGVybWVzXCIpKSAmJiBjb25maWcuY29kaW5nQWdlbnQgPT09IHVuZGVmaW5lZCkgY29uZmlnLmNvZGluZ0FnZW50ID0geyBwcm9qZWN0czogc2VydmVyLnQzID8/IFtdIH07XG4gIGlmIChjaGVja2VkKFwiY2FwdGlvbnNcIikgJiYgc2VydmVyLmNhcHRpb25zTW9kZWwgJiYgY29uZmlnLmNhcHRpb25zID09PSB1bmRlZmluZWQpIGNvbmZpZy5jYXB0aW9ucyA9IHsgbW9kZWw6IHNlcnZlci5jYXB0aW9uc01vZGVsIH07XG4gIHJldHVybiBjb25maWc7XG59XG5cbi8qKiBTdGFydHMgYSB2b2ljZSBjYWxsLCBvciB3aXRoIFt0eXBlZF0gYSBjaGF0ICh0aGUgY29yZSdzIG1lZGl1bSBcInRleHRcIjogbm8gYXVkaW8sIGEgdGV4dCBtb2RlbCkuICovXG5hc3luYyBmdW5jdGlvbiBzdGFydChjYXJyeU9uID0gZmFsc2UsIHR5cGVkID0gZmFsc2UpIHtcbiAgYXdhaXQgZW5kaW5nO1xuICBpZiAoY2FsbElkKSByZXR1cm47XG4gIGxldCBnaXZlbjogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIHRyeSB7XG4gICAgZ2l2ZW4gPSByZWFkQ29uZmlnKCk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHRvYXN0KGBUaGUgZGV2ZWxvcGVyIHNldHRpbmdzIGFyZW4ndCB2YWxpZCBKU09OOiAkeyhlcnIgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmICh0eXBlZCkge1xuICAgIGlmICghc2VydmVyLnRleHRNb2RlbCkgeyB0b2FzdChcIlRoaXMgc2VydmVyIGhhcyBubyB0ZXh0IG1vZGVsIGZvciBhIGNoYXQ6IHN0YXJ0IGEgY2FsbCB0byB0eXBlIHRvIGl0XCIpOyByZXR1cm47IH1cbiAgICBnaXZlbiA9IHsgLi4uZ2l2ZW4sIG1lZGl1bTogXCJ0ZXh0XCIsIG11dGVkOiBmYWxzZSB9O1xuICAgIGRlbGV0ZSBnaXZlbi5jYXB0aW9ucztcbiAgfVxuICAkPEhUTUxCdXR0b25FbGVtZW50PihcImNhbGxcIikuZGlzYWJsZWQgPSB0cnVlO1xuICAkPEhUTUxCdXR0b25FbGVtZW50PihcImhlcm8tY2FsbFwiKS5kaXNhYmxlZCA9IHRydWU7XG4gIGlmIChcIk5vdGlmaWNhdGlvblwiIGluIHdpbmRvdyAmJiBOb3RpZmljYXRpb24ucGVybWlzc2lvbiA9PT0gXCJkZWZhdWx0XCIpIHZvaWQgTm90aWZpY2F0aW9uLnJlcXVlc3RQZXJtaXNzaW9uKCkuY2F0Y2goKCkgPT4ge30pO1xuICB0cnkge1xuICAgIGlmICghdHlwZWQpIGF3YWl0IGF1ZGlvLm9wZW4oKTtcbiAgICBjb3JlID0gYXdhaXQgbG9hZENvcmUoKTtcbiAgfSBmaW5hbGx5IHtcbiAgICAkPEhUTUxCdXR0b25FbGVtZW50PihcImNhbGxcIikuZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAkPEhUTUxCdXR0b25FbGVtZW50PihcImhlcm8tY2FsbFwiKS5kaXNhYmxlZCA9IGZhbHNlO1xuICB9XG4gIGlmIChjYWxsSWQpIHJldHVybjsgLy8gYW5vdGhlciBzdGFydCBnb3QgdGhlcmUgZmlyc3RcbiAgbWVkaXVtID0gdHlwZWQgPyBcInRleHRcIiA6IFwidm9pY2VcIjtcbiAgdGhpbmtpbmcgPSBmYWxzZTtcbiAgJChcInZlcnNpb25cIikudGV4dENvbnRlbnQgPSBjb3JlLnZlcnNpb247XG4gICQoXCJsb2dcIikuaW5uZXJIVE1MID0gXCJcIjtcbiAgaWYgKCF0eXBlZCAmJiAodGFza3Muc2l6ZSA+IDAgfHwgJChcInRyYW5zY3JpcHRcIikuY2hpbGRFbGVtZW50Q291bnQgPiAxKSkgbm90ZShgTmV3IGNhbGwgXHUwMEI3ICR7bmV3IERhdGUoKS50b0xvY2FsZVRpbWVTdHJpbmcoKX1gKTtcbiAgdGFza3MuY2xlYXIoKTtcbiAgc2hvd1Rhc2tzKCk7XG4gIGNvdW50cyA9IHsgbWljOiAwLCBwbGF5OiAwLCBzZW50OiAwIH07XG4gIG1ldHJpY3MucmVwbHkgPSBbXTtcbiAgc3RhcnRlZEF0ID0gbm93KCk7XG4gIG11dGVkID0gZ2l2ZW4ubXV0ZWQgPT09IHRydWU7XG4gIC8vIENhcnJ5aW5nIG9uOiB0aGUgbW9kZWwgZ2V0cyB0aGUgbGFzdCBjb252ZXJzYXRpb24gYXMgYSByZWNhcC4gVGhlIGNvcmUgY2FwcyBpdCwgbGF0ZXN0IGxpbmVzIGZpcnN0LlxuICAvLyBBIGNoYXQgYWx3YXlzIGNhcnJpZXMgb24gZnJvbSB3aGF0J3Mgb24gdGhlIHNjcmVlbiAoYW4gZWFybGllciBjYWxsIG9yIGNoYXQgb24gdGhpcyBwYWdlKS5cbiAgaWYgKHR5cGVkKSB7IGlmIChjaGF0Lmxlbmd0aCA+IDAgJiYgZ2l2ZW4uaGlzdG9yeSA9PT0gdW5kZWZpbmVkKSBnaXZlbi5oaXN0b3J5ID0gY2hhdDsgfVxuICBlbHNlIGlmIChjYXJyeU9uICYmIGdpdmVuLmhpc3RvcnkgPT09IHVuZGVmaW5lZCkgZ2l2ZW4uaGlzdG9yeSA9IHNhdmVkSGlzdG9yeSgpO1xuICBlbHNlIGlmICghY2FycnlPbikgY2hhdCA9IFtdO1xuICBpZiAoY2FycnlPbiAmJiAhdHlwZWQpIGNoYXQgPSBzYXZlZEhpc3RvcnkoKTtcbiAgbGFzdExpbmUgPSBudWxsO1xuICBvcGVuTGluZSA9IG51bGw7XG4gIHN5bmNSZXN1bWVCdXR0b25zKGZhbHNlKTtcbiAgY2FsbE5hbWUgPSBgJHtuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkucmVwbGFjZSgvWzouXS9nLCBcIi1cIil9LSR7dHlwZWQgPyBcImNoYXRcIiA6IFwid2ViXCJ9LSR7Y29yZS52ZXJzaW9ufWA7XG4gIGNvbnN0IGNyZWF0ZWQgPSBKU09OLnBhcnNlKGNvcmUuY3JlYXRlKEpTT04uc3RyaW5naWZ5KGdpdmVuKSwgbm93KCkpKTtcbiAgY2FsbElkID0gY3JlYXRlZC5pZDtcbiAgaWYgKCF0eXBlZCkge1xuICAgIHNldENhbGxCdXR0b24odHJ1ZSk7XG4gICAgJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJtaWNcIikuZGlzYWJsZWQgPSBmYWxzZTtcbiAgfVxuICAkPEhUTUxCdXR0b25FbGVtZW50PihcImh1c2hcIikuZGlzYWJsZWQgPSBmYWxzZTtcbiAgJChcIm1pY1wiKS5jbGFzc0xpc3QudG9nZ2xlKFwibXV0ZWRcIiwgbXV0ZWQpO1xuICBydW4oY3JlYXRlZC5jb21tYW5kcyk7XG4gIHNob3dTdGF0dXMoKTtcbiAgdGlja2VyID0gd2luZG93LnNldEludGVydmFsKCgpID0+IHtcbiAgICBwdXNoKHsgdHlwZTogXCJ0aWNrXCIgfSk7XG4gICAgY29uc3QgbGV2ZWwgPSBtdXRlZCAmJiAhaG9sZGluZyA/IDAgOiBhdWRpby5sZXZlbDtcbiAgICBjb25zdCBzdHJlbmd0aCA9IE1hdGgubWluKDEsIGxldmVsICogMTIpO1xuICAgICQoXCJyaW5nXCIpLnN0eWxlLm9wYWNpdHkgPSBTdHJpbmcoc3RyZW5ndGgpO1xuICAgICQoXCJyaW5nXCIpLnN0eWxlLnRyYW5zZm9ybSA9IGBzY2FsZSgkeygxICsgc3RyZW5ndGggKiAwLjEyKS50b0ZpeGVkKDMpfSlgO1xuICAgICQoXCJjb3VudHNcIikudGV4dENvbnRlbnQgPSBgbWljICR7Y291bnRzLm1pY30gXHUwMEI3IHNlbnQgJHtjb3VudHMuc2VudH0gXHUwMEI3IHBsYXllZCAke2NvdW50cy5wbGF5fSBcdTAwQjcgcXVldWVkICR7YXVkaW8ucXVldWVkLnRvRml4ZWQoMSl9IHNgO1xuICAgIHNob3dTdGF0dXMoKTtcbiAgfSwgMTAwKTtcbiAgdHJhY2VUaW1lciA9IHdpbmRvdy5zZXRJbnRlcnZhbCgoKSA9PiB7IHZvaWQgc2F2ZVRyYWNlKCk7IHZvaWQgcGluZygpOyBzaG93VGFza3MoKTsgfSwgNTAwMCk7XG4gIHZvaWQgcGluZygpO1xuICBpZiAodHlwZWQpIHJldHVybjtcbiAgc3RvcFdvcmRzLnN0YXJ0KCk7XG4gIHRyeSB7IHdha2VMb2NrID0gYXdhaXQgKG5hdmlnYXRvciBhcyBhbnkpLndha2VMb2NrPy5yZXF1ZXN0KFwic2NyZWVuXCIpOyB9IGNhdGNoIHt9XG59XG5cbi8qKiBUaGUgQ2FsbCBidXR0b246IGhhbmdzIHVwIGEgY2FsbDsgc3RhcnRzIG9uZTsgb3IsIHdpdGggYSBjaGF0IG9uLCBlbmRzIHRoZSBjaGF0IGFuZCBjYXJyaWVzIGl0cyBjb252ZXJzYXRpb24gb24gYnkgdm9pY2UuICovXG5hc3luYyBmdW5jdGlvbiBjYWxsQnV0dG9uKCkge1xuICBpZiAoY2FsbElkICYmIG1lZGl1bSA9PT0gXCJ2b2ljZVwiKSB7IGhhbmdVcCgpOyByZXR1cm47IH1cbiAgaWYgKGNhbGxJZCkge1xuICAgIC8vIEEgY2FsbCBjYW4ndCB0YWtlIG92ZXIgdGhlIGNoYXQncyB0YXNrcywgYW5kIGVuZGluZyB0aGUgY2hhdCB3b3VsZCBzdG9wIHRoZW0uXG4gICAgaWYgKFsuLi50YXNrcy52YWx1ZXMoKV0uc29tZSgodikgPT4gdi5jLnN0YXRlID09PSBcInJ1bm5pbmdcIikpIHsgdG9hc3QoXCJUaGUgY2hhdCdzIHRhc2tzIGFyZSBzdGlsbCBydW5uaW5nOiB3YWl0IGZvciB0aGVtIG9yIGNhbmNlbCB0aGVtLCB0aGVuIGNhbGxcIik7IHJldHVybjsgfVxuICAgIHB1c2goeyB0eXBlOiBcInN0b3BcIiB9KTtcbiAgICBhd2FpdCBzdGFydCh0cnVlKTtcbiAgICByZXR1cm47XG4gIH1cbiAgYXdhaXQgc3RhcnQoKTtcbn1cblxuZnVuY3Rpb24gaGFuZ1VwKCkge1xuICBpZiAoY2FsbElkKSBwdXNoKHsgdHlwZTogXCJzdG9wXCIsIG1lc3NhZ2U6IFwiWW91IGh1bmcgdXAuXCIgfSk7XG59XG5cbmZ1bmN0aW9uIGVuZCgpIHtcbiAgd2luZG93LmNsZWFySW50ZXJ2YWwodGlja2VyKTtcbiAgd2luZG93LmNsZWFySW50ZXJ2YWwodHJhY2VUaW1lcik7XG4gIHN0b3BXb3Jkcy5zdG9wKCk7XG4gIGVuZGluZyA9IHNhdmVUcmFjZSgpLnRoZW4oKCkgPT4geyBpZiAoY29yZSAmJiBjYWxsSWQpIGNvcmUuZGlzcG9zZShjYWxsSWQpOyBjYWxsSWQgPSAwOyBzaG93VGFza3MoKTsgc2hvd1N0YXR1cygpOyB9KTtcbiAgYXVkaW8uc3RvcCgpO1xuICBmb3IgKGNvbnN0IHdzIG9mIHNvY2tldHMudmFsdWVzKCkpIHdzLmNsb3NlKCk7XG4gIHNvY2tldHMuY2xlYXIoKTtcbiAgZm9yIChjb25zdCByIG9mIHJ1bnMudmFsdWVzKCkpIHIuYWJvcnQuYWJvcnQoKTtcbiAgcnVucy5jbGVhcigpO1xuICBmb3IgKGNvbnN0IHIgb2YgcmVxdWVzdHMudmFsdWVzKCkpIHIuYWJvcnQoKTtcbiAgcmVxdWVzdHMuY2xlYXIoKTtcbiAgdGhpbmtpbmcgPSBmYWxzZTtcbiAgc2V0Q2FsbEJ1dHRvbihmYWxzZSk7XG4gIGZvciAoY29uc3QgaWQgb2YgW1wibWljXCIsIFwiaHVzaFwiXSkgJDxIVE1MQnV0dG9uRWxlbWVudD4oaWQpLmRpc2FibGVkID0gdHJ1ZTtcbiAgJChcInJpbmdcIikuc3R5bGUub3BhY2l0eSA9IFwiMFwiO1xuICAkKFwicmluZ1wiKS5zdHlsZS50cmFuc2Zvcm0gPSBcIlwiO1xuICAkKFwiY2FsbGJhclwiKS5oaWRkZW4gPSB0cnVlO1xuICAkKFwibWljd2FyblwiKS5oaWRkZW4gPSB0cnVlO1xuICBkb2N1bWVudC5ib2R5LmRhdGFzZXQuc3RhdGUgPSBcImlkbGVcIjtcbiAgZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QucmVtb3ZlKFwiaW4tc2Vzc2lvblwiKTtcbiAgc3luY1Jlc3VtZUJ1dHRvbnMoY2hhdC5sZW5ndGggPiAwKTtcbiAgdm9pZCBzaG93RWFybGllcigpO1xuICB2b2lkIHdha2VMb2NrPy5yZWxlYXNlKCkuY2F0Y2goKCkgPT4ge30pO1xuICB3YWtlTG9jayA9IG51bGw7XG59XG5cbmZ1bmN0aW9uIHNldE11dGVkKHZhbHVlOiBib29sZWFuKSB7XG4gIGlmICghY2FsbElkIHx8IG11dGVkID09PSB2YWx1ZSkgcmV0dXJuO1xuICBtdXRlZCA9IHZhbHVlO1xuICAkKFwibWljXCIpLmNsYXNzTGlzdC50b2dnbGUoXCJtdXRlZFwiLCBtdXRlZCk7XG4gIHB1c2goeyB0eXBlOiBtdXRlZCA/IFwibXV0ZVwiIDogXCJ1bm11dGVcIiB9KTtcbiAgc2hvd1N0YXR1cygpO1xufVxuXG4vKiogU2VuZHMgd2hhdCB0aGUgdHJhY2Uga2VwdCBzaW5jZSBsYXN0IHRpbWUgdG8gdGhlIGRldiBzZXJ2ZXIsIGFzIEpTT04gbGluZXM6IGEgaGVhZGVyLCB0aGVuIGV2ZW50cy4gKi9cbmFzeW5jIGZ1bmN0aW9uIHNhdmVUcmFjZSgpIHtcbiAgaWYgKCFjb3JlIHx8ICFjYWxsSWQgfHwgIWNoZWNrZWQoXCJ0cmFjZVwiKSkgcmV0dXJuO1xuICBjb25zdCBrZXB0ID0gSlNPTi5wYXJzZShjb3JlLnRyYWNlKGNhbGxJZCkpO1xuICBpZiAoIWtlcHQpIHJldHVybjtcbiAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG4gIGlmIChrZXB0LmNvbmZpZykgbGluZXMucHVzaChKU09OLnN0cmluZ2lmeSh7IHZlcnNpb246IGtlcHQudmVyc2lvbiwgY29uZmlnOiBrZXB0LmNvbmZpZywgc3RhcnQ6IGtlcHQuc3RhcnQgfSkpO1xuICBmb3IgKGNvbnN0IGUgb2Yga2VwdC5ldmVudHMpIGxpbmVzLnB1c2goSlNPTi5zdHJpbmdpZnkoZSkpO1xuICBpZiAobGluZXMubGVuZ3RoID09PSAwKSByZXR1cm47XG4gIGF3YWl0IGZldGNoKGAvdHJhY2VzP25hbWU9JHtlbmNvZGVVUklDb21wb25lbnQoY2FsbE5hbWUpfS5qc29ubGAsIHsgbWV0aG9kOiBcIlBPU1RcIiwgYm9keTogbGluZXMuam9pbihcIlxcblwiKSArIFwiXFxuXCIgfSkuY2F0Y2goKCkgPT4ge30pO1xuICAkKFwidHJhY2VuYW1lXCIpLnRleHRDb250ZW50ID0gYHRyYWNlICR7Y2FsbE5hbWV9Lmpzb25sYDtcbn1cblxuLy8gXCJTdG9wXCIgYW5kIFwiZ29vZGJ5ZVwiIGhlYXJkIGJ5IHRoZSBicm93c2VyJ3Mgb3duIHJlY29nbml6ZXI6IHF1aWNrZXIgdGhhbiB0aGUgbW9kZWwncyB0cmFuc2NyaXB0LFxuLy8gYW5kIGl0IHdvcmtzIHdoaWxlIHRoZSBtb2RlbCdzIHJlcGx5IHBsYXlzIGV2ZW4gd2hlbiB0aGUgbW9kZWwgaXNuJ3QgaGVhcmluZyB0aGUgbWljcm9waG9uZS5cblxuY2xhc3MgU3RvcFdvcmRzIHtcbiAgcHJpdmF0ZSByZWM6IGFueSA9IG51bGw7XG4gIHByaXZhdGUgb24gPSBmYWxzZTtcbiAgcHJpdmF0ZSBjb21tYW5kcyA9IHsgc3RvcDogW10gYXMgc3RyaW5nW10sIGhhbmdVcDogW10gYXMgc3RyaW5nW10sIGNhbmNlbEFsbDogW10gYXMgc3RyaW5nW10gfTtcblxuICBnZXQgc3VwcG9ydGVkKCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiBcIndlYmtpdFNwZWVjaFJlY29nbml0aW9uXCIgaW4gd2luZG93IHx8IFwiU3BlZWNoUmVjb2duaXRpb25cIiBpbiB3aW5kb3c7XG4gIH1cblxuICBzdGFydCgpIHtcbiAgICBpZiAoIWNoZWNrZWQoXCJzdG9wd29yZFwiKSB8fCAhdGhpcy5zdXBwb3J0ZWQgfHwgIWNvcmUpIHJldHVybjtcbiAgICB0aGlzLmNvbW1hbmRzID0gSlNPTi5wYXJzZShjb3JlLmRlZmF1bHRzKCkpLnZvaWNlQ29tbWFuZHM7XG4gICAgY29uc3QgUmVjb2duaXRpb24gPSAod2luZG93IGFzIGFueSkuU3BlZWNoUmVjb2duaXRpb24gPz8gKHdpbmRvdyBhcyBhbnkpLndlYmtpdFNwZWVjaFJlY29nbml0aW9uO1xuICAgIHRoaXMucmVjID0gbmV3IFJlY29nbml0aW9uKCk7XG4gICAgdGhpcy5yZWMuY29udGludW91cyA9IHRydWU7XG4gICAgdGhpcy5yZWMuaW50ZXJpbVJlc3VsdHMgPSB0cnVlO1xuICAgIHRoaXMucmVjLmxhbmcgPSBuYXZpZ2F0b3IubGFuZ3VhZ2UgfHwgXCJlbi1HQlwiO1xuICAgIHRoaXMucmVjLm9ucmVzdWx0ID0gKGU6IGFueSkgPT4ge1xuICAgICAgZm9yIChsZXQgaSA9IGUucmVzdWx0SW5kZXg7IGkgPCBlLnJlc3VsdHMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgY29uc3QgdGV4dCA9IGUucmVzdWx0c1tpXVswXS50cmFuc2NyaXB0IGFzIHN0cmluZztcbiAgICAgICAgY29uc3QgY29tbWFuZCA9IGNvbW1hbmRJbih0ZXh0LCB0aGlzLmNvbW1hbmRzLCBbXCJXb29kaG91c2VcIiwgXCJIZXJtZXNcIiwgXCJCZW50b1wiXSk7XG4gICAgICAgIGlmIChjb21tYW5kID09PSBcInN0b3BcIiAmJiBhdWRpby5xdWV1ZWQgPiAwLjA1KSB7XG4gICAgICAgICAgbG9nKFwib3V0XCIsIGBsb2NhbCBzdG9wIHdvcmQ6ICR7dGV4dH1gLCBcIm91dFwiKTtcbiAgICAgICAgICB0b2FzdChgSGVhcmQgXHUyMDFDJHt0ZXh0LnRyaW0oKX1cdTIwMUQ6IHN0b3BwZWRgKTtcbiAgICAgICAgICBwdXNoKHsgdHlwZTogXCJpbnRlcnJ1cHRcIiB9KTtcbiAgICAgICAgfSBlbHNlIGlmIChjb21tYW5kID09PSBcImNhbmNlbEFsbFwiICYmIGUucmVzdWx0c1tpXS5pc0ZpbmFsKSB7XG4gICAgICAgICAgbG9nKFwib3V0XCIsIGBsb2NhbCBjYW5jZWwtYWxsOiAke3RleHR9YCwgXCJvdXRcIik7XG4gICAgICAgICAgcHVzaCh7IHR5cGU6IFwiY2FuY2VsQWxsXCIgfSk7XG4gICAgICAgICAgcHVzaCh7IHR5cGU6IFwiaW50ZXJydXB0XCIgfSk7XG4gICAgICAgIH0gZWxzZSBpZiAoY29tbWFuZCA9PT0gXCJoYW5nVXBcIiAmJiBlLnJlc3VsdHNbaV0uaXNGaW5hbCkge1xuICAgICAgICAgIGxvZyhcIm91dFwiLCBgbG9jYWwgaGFuZy11cDogJHt0ZXh0fWAsIFwib3V0XCIpO1xuICAgICAgICAgIGhhbmdVcCgpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfTtcbiAgICB0aGlzLnJlYy5vbmVuZCA9ICgpID0+IHsgaWYgKHRoaXMub24pIHNldFRpbWVvdXQoKCkgPT4geyB0cnkgeyB0aGlzLnJlYz8uc3RhcnQoKTsgfSBjYXRjaCB7fSB9LCAyNTApOyB9O1xuICAgIHRoaXMucmVjLm9uZXJyb3IgPSAoZTogYW55KSA9PiB7IGlmIChlLmVycm9yID09PSBcIm5vdC1hbGxvd2VkXCIpIHRoaXMub24gPSBmYWxzZTsgfTtcbiAgICB0aGlzLm9uID0gdHJ1ZTtcbiAgICB0cnkgeyB0aGlzLnJlYy5zdGFydCgpOyB9IGNhdGNoIHt9XG4gIH1cblxuICBzdG9wKCkge1xuICAgIHRoaXMub24gPSBmYWxzZTtcbiAgICB0cnkgeyB0aGlzLnJlYz8uc3RvcCgpOyB9IGNhdGNoIHt9XG4gICAgdGhpcy5yZWMgPSBudWxsO1xuICB9XG59XG5jb25zdCBzdG9wV29yZHMgPSBuZXcgU3RvcFdvcmRzKCk7XG5cbi8vIFdpcmluZy5cblxuZnVuY3Rpb24gc2V0dGluZ3NGcm9tU3RvcmFnZSgpIHtcbiAgZm9yIChjb25zdCBpZCBvZiBbXCJhZWNcIiwgXCJzdG9wd29yZFwiLCBcInB0dFwiLCBcImNhcHRpb25zXCIsIFwiY29kaW5nXCIsIFwiZmFrZWhlcm1lc1wiLCBcInRyYWNlXCJdKSB7XG4gICAgY29uc3QgdiA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKGB2b2ljZS4ke2lkfWApO1xuICAgIGlmICh2ICE9IG51bGwpICQ8SFRNTElucHV0RWxlbWVudD4oaWQpLmNoZWNrZWQgPSB2ID09PSBcIjFcIjtcbiAgICAkKGlkKS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IGxvY2FsU3RvcmFnZS5zZXRJdGVtKGB2b2ljZS4ke2lkfWAsIGNoZWNrZWQoaWQpID8gXCIxXCIgOiBcIjBcIikpO1xuICB9XG4gIGNvbnN0IGRlbGF5ID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS5mYWtlZGVsYXlcIik7XG4gIGlmIChkZWxheSkgJDxIVE1MSW5wdXRFbGVtZW50PihcImZha2VkZWxheVwiKS52YWx1ZSA9IGRlbGF5O1xuICAkKFwiZmFrZWRlbGF5XCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4gbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS5mYWtlZGVsYXlcIiwgJDxIVE1MSW5wdXRFbGVtZW50PihcImZha2VkZWxheVwiKS52YWx1ZSkpO1xuICBjb25zdCB2b2ljZSA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2Uudm9pY2VcIik7XG4gIGlmICh2b2ljZSkgJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJ2b2ljZVwiKS52YWx1ZSA9IHZvaWNlO1xuICAkKFwidm9pY2VcIikuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLnZvaWNlXCIsICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwidm9pY2VcIikudmFsdWUpKTtcbiAgY29uc3QgbW9kZSA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UubW9kZVwiKTtcbiAgaWYgKG1vZGUpICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwibW9kZVwiKS52YWx1ZSA9IG1vZGU7XG4gICQoXCJtb2RlXCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4ge1xuICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2UubW9kZVwiLCAkPEhUTUxTZWxlY3RFbGVtZW50PihcIm1vZGVcIikudmFsdWUpO1xuICAgIHN5bmNDb21wb3NlcigpO1xuICB9KTtcbiAgY29uc3QgdGhlbWUgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLnRoZW1lXCIpID8/IFwic3lzdGVtXCI7XG4gIGFwcGx5VGhlbWUodGhlbWUpO1xuICBmb3IgKGNvbnN0IGJ0biBvZiBBcnJheS5mcm9tKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiI3RoZW1lLXBpY2tlciBidXR0b25cIikpKSB7XG4gICAgYnRuLm9uY2xpY2sgPSAoKSA9PiB7XG4gICAgICBjb25zdCBjaG9pY2UgPSBidG4uZGF0YXNldC50aGVtZSA/PyBcInN5c3RlbVwiO1xuICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS50aGVtZVwiLCBjaG9pY2UpO1xuICAgICAgYXBwbHlUaGVtZShjaG9pY2UpO1xuICAgIH07XG4gIH1cbiAgbWF0Y2hNZWRpYShcIihwcmVmZXJzLWNvbG9yLXNjaGVtZTogZGFyaylcIikuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiB7XG4gICAgaWYgKChsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLnRoZW1lXCIpID8/IFwic3lzdGVtXCIpID09PSBcInN5c3RlbVwiKSBhcHBseVRoZW1lKFwic3lzdGVtXCIpO1xuICB9KTtcbn1cblxuY29uc3QgbW9iaWxlTGF5b3V0ID0gbWF0Y2hNZWRpYShcIihtYXgtd2lkdGg6IDkyMHB4KVwiKTtcbmxldCBkcmF3ZXJPcGVuZXI6IEhUTUxFbGVtZW50IHwgbnVsbCA9IG51bGw7XG5cbmZ1bmN0aW9uIHNldFRhc2tzT3BlbihvcGVuOiBib29sZWFuLCBvcGVuZXI/OiBIVE1MRWxlbWVudCB8IG51bGwpIHtcbiAgY29uc3QgY2FuT3BlbiA9IG1vYmlsZUxheW91dC5tYXRjaGVzICYmICEkKFwidGFsa1wiKS5oaWRkZW47XG4gIGNvbnN0IG5leHQgPSBvcGVuICYmIGNhbk9wZW47XG4gIGNvbnN0IHdhc09wZW4gPSBkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5jb250YWlucyhcInRhc2tzLW9wZW5cIik7XG4gIGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LnRvZ2dsZShcInRhc2tzLW9wZW5cIiwgbmV4dCk7XG4gIGNvbnN0IGhlYWRlciA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoXCJoZWFkZXJcIikgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAoaGVhZGVyKSBoZWFkZXIuaW5lcnQgPSBuZXh0O1xuICAkKFwiY29udm9cIikuaW5lcnQgPSBuZXh0O1xuICAkKFwic2lkZVwiKS5pbmVydCA9IG1vYmlsZUxheW91dC5tYXRjaGVzICYmICFuZXh0O1xuICAkKFwidGFza3MtdG9nZ2xlXCIpLnNldEF0dHJpYnV0ZShcImFyaWEtZXhwYW5kZWRcIiwgU3RyaW5nKG5leHQpKTtcbiAgJChcIm1vYmlsZS10YXNrcy1iYXJcIikuc2V0QXR0cmlidXRlKFwiYXJpYS1leHBhbmRlZFwiLCBTdHJpbmcobmV4dCkpO1xuICBpZiAobmV4dCAmJiAhd2FzT3Blbikge1xuICAgIGRyYXdlck9wZW5lciA9IG9wZW5lciA/PyAoZG9jdW1lbnQuYWN0aXZlRWxlbWVudCBhcyBIVE1MRWxlbWVudCB8IG51bGwpO1xuICAgICQoXCJ0YXNrcy1jbG9zZVwiKS5mb2N1cygpO1xuICB9IGVsc2UgaWYgKCFuZXh0ICYmIHdhc09wZW4pIHtcbiAgICBjb25zdCB0YXJnZXQgPSBkcmF3ZXJPcGVuZXI7XG4gICAgZHJhd2VyT3BlbmVyID0gbnVsbDtcbiAgICBpZiAodGFyZ2V0ICYmIHRhcmdldC5pc0Nvbm5lY3RlZCAmJiAhdGFyZ2V0LmhpZGRlbiAmJiB0YXJnZXQub2Zmc2V0UGFyZW50ICE9PSBudWxsKSB0YXJnZXQuZm9jdXMoKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB0YWJzKCkge1xuICBjb25zdCB2aWV3czogUmVjb3JkPHN0cmluZywgSFRNTEVsZW1lbnQ+ID0geyB0YWxrOiAkKFwidGFsa1wiKSwgZGV2OiAkKFwiZGV2XCIpLCByZXBsYXk6ICQoXCJyZXBsYXltYWluXCIpIH07XG4gIGZvciAoY29uc3QgbmFtZSBvZiBPYmplY3Qua2V5cyh2aWV3cykpIHtcbiAgICAkKGB0YWItJHtuYW1lfWApLm9uY2xpY2sgPSAoKSA9PiB7XG4gICAgICBmb3IgKGNvbnN0IFtvdGhlciwgZWxdIG9mIE9iamVjdC5lbnRyaWVzKHZpZXdzKSkge1xuICAgICAgICBlbC5oaWRkZW4gPSBvdGhlciAhPT0gbmFtZTtcbiAgICAgICAgJChgdGFiLSR7b3RoZXJ9YCkuY2xhc3NMaXN0LnRvZ2dsZShcIm9uXCIsIG90aGVyID09PSBuYW1lKTtcbiAgICAgIH1cbiAgICAgICQoXCJ0YXNrcy10b2dnbGVcIikuaGlkZGVuID0gbmFtZSAhPT0gXCJ0YWxrXCI7XG4gICAgICBzZXRUYXNrc09wZW4oZmFsc2UpO1xuICAgIH07XG4gIH1cbiAgJChcImdlYXJcIikub25jbGljayA9ICgpID0+IHsgJChcInNldHRpbmdzXCIpLmhpZGRlbiA9IGZhbHNlOyB9O1xuICAkKFwiY2xvc2VzZXR0aW5nc1wiKS5vbmNsaWNrID0gKCkgPT4geyAkKFwic2V0dGluZ3NcIikuaGlkZGVuID0gdHJ1ZTsgfTtcbiAgJChcImNsb3Nlc2V0dGluZ3MteFwiKS5vbmNsaWNrID0gKCkgPT4geyAkKFwic2V0dGluZ3NcIikuaGlkZGVuID0gdHJ1ZTsgfTtcbiAgJChcInNldHRpbmdzXCIpLm9uY2xpY2sgPSAoZSkgPT4geyBpZiAoZS50YXJnZXQgPT09ICQoXCJzZXR0aW5nc1wiKSkgJChcInNldHRpbmdzXCIpLmhpZGRlbiA9IHRydWU7IH07XG4gICQoXCJ0YXNrcy10b2dnbGVcIikub25jbGljayA9ICgpID0+IHNldFRhc2tzT3BlbighZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QuY29udGFpbnMoXCJ0YXNrcy1vcGVuXCIpLCAkKFwidGFza3MtdG9nZ2xlXCIpKTtcbiAgJChcIm1vYmlsZS10YXNrcy1iYXJcIikub25jbGljayA9ICgpID0+IHNldFRhc2tzT3Blbih0cnVlLCAkKFwibW9iaWxlLXRhc2tzLWJhclwiKSk7XG4gICQoXCJ0YXNrcy1jbG9zZVwiKS5vbmNsaWNrID0gKCkgPT4gc2V0VGFza3NPcGVuKGZhbHNlKTtcbiAgJChcInNpZGUtYmFja2Ryb3BcIikub25jbGljayA9ICgpID0+IHNldFRhc2tzT3BlbihmYWxzZSk7XG4gIG1vYmlsZUxheW91dC5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHNldFRhc2tzT3BlbihmYWxzZSkpO1xuICBzZXRUYXNrc09wZW4oZmFsc2UpO1xufVxuXG5mdW5jdGlvbiB0eXBpbmcoKTogYm9vbGVhbiB7XG4gIGNvbnN0IGVsID0gZG9jdW1lbnQuYWN0aXZlRWxlbWVudCBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gIHJldHVybiAhIWVsICYmIChlbC50YWdOYW1lID09PSBcIklOUFVUXCIgfHwgZWwudGFnTmFtZSA9PT0gXCJURVhUQVJFQVwiIHx8IGVsLnRhZ05hbWUgPT09IFwiU0VMRUNUXCIgfHwgZWwuaXNDb250ZW50RWRpdGFibGUpO1xufVxuXG5mdW5jdGlvbiBrZXlzKCkge1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCAoZSkgPT4ge1xuICAgIGlmIChlLmtleSA9PT0gXCJFc2NhcGVcIikge1xuICAgICAgaWYgKCEkKFwic2V0dGluZ3NcIikuaGlkZGVuKSB7ICQoXCJzZXR0aW5nc1wiKS5oaWRkZW4gPSB0cnVlOyByZXR1cm47IH1cbiAgICAgIGlmIChkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5jb250YWlucyhcInRhc2tzLW9wZW5cIikgJiYgbW9iaWxlTGF5b3V0Lm1hdGNoZXMgJiYgISQoXCJ0YWxrXCIpLmhpZGRlbikgeyBzZXRUYXNrc09wZW4oZmFsc2UpOyByZXR1cm47IH1cbiAgICAgIGlmIChjYWxsSWQpIHsgcHVzaCh7IHR5cGU6IFwiaW50ZXJydXB0XCIgfSk7IGF1ZGlvLmZsdXNoKCk7IHJldHVybjsgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAodHlwaW5nKCkgfHwgZS5tZXRhS2V5IHx8IGUuY3RybEtleSB8fCBlLmFsdEtleSkgcmV0dXJuO1xuICAgIGlmIChlLmtleSA9PT0gXCJtXCIgfHwgZS5rZXkgPT09IFwiTVwiKSB7IHNldE11dGVkKCFtdXRlZCk7IGUucHJldmVudERlZmF1bHQoKTsgfVxuICAgIGVsc2UgaWYgKGUua2V5ID09PSBcIi9cIikgeyAkKFwidGV4dFwiKS5mb2N1cygpOyBlLnByZXZlbnREZWZhdWx0KCk7IH1cbiAgICBlbHNlIGlmIChlLmNvZGUgPT09IFwiU3BhY2VcIiAmJiBjYWxsSWQgJiYgbXV0ZWQgJiYgIWUucmVwZWF0KSB7IGhvbGRpbmcgPSB0cnVlOyBwdXNoKHsgdHlwZTogXCJ1bm11dGVcIiB9KTsgc2hvd1N0YXR1cygpOyBlLnByZXZlbnREZWZhdWx0KCk7IH1cbiAgfSk7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJrZXl1cFwiLCAoZSkgPT4ge1xuICAgIGlmIChlLmNvZGUgPT09IFwiU3BhY2VcIiAmJiBob2xkaW5nKSB7IGhvbGRpbmcgPSBmYWxzZTsgcHVzaCh7IHR5cGU6IFwibXV0ZVwiIH0pOyBzaG93U3RhdHVzKCk7IH1cbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHN1Ym1pdFRleHQoZTogRXZlbnQpIHtcbiAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICBjb25zdCBpbnB1dCA9ICQ8SFRNTElucHV0RWxlbWVudD4oXCJ0ZXh0XCIpO1xuICBsZXQgdGV4dCA9IGlucHV0LnZhbHVlLnRyaW0oKTtcbiAgaWYgKCF0ZXh0KSByZXR1cm47XG4gIC8vIFdpdGggbm8gY2FsbCBvbiwgdHlwaW5nIHN0YXJ0cyBhIGNoYXQ6IHRoZSBzYW1lIG1haW4gdGhyZWFkLCBpbiB0ZXh0LlxuICBpZiAoIWNhbGxJZCkge1xuICAgIGlucHV0LnZhbHVlID0gXCJcIjtcbiAgICBzeW5jQ29tcG9zZXIoKTtcbiAgICB0cnkgeyBhd2FpdCBzdGFydChmYWxzZSwgdHJ1ZSk7IH0gY2F0Y2ggKGVycikgeyB0b2FzdCgoZXJyIGFzIEVycm9yKS5tZXNzYWdlKTsgbG9nKFwiZXJyb3JcIiwgKGVyciBhcyBFcnJvcikubWVzc2FnZSwgXCJlcnJcIik7IH1cbiAgICBpZiAoIWNhbGxJZCkgeyBpbnB1dC52YWx1ZSA9IHRleHQ7IHN5bmNDb21wb3NlcigpOyByZXR1cm47IH1cbiAgfVxuICAvLyBcIi90MyBcdTIwMjZcIiBhbmQgXCIvaCBcdTIwMjZcIiBwaWNrIHRoZSBhZ2VudCB3aGF0ZXZlciB0aGUgc2VsZWN0b3Igc2F5cy5cbiAgY29uc3QgcGFyc2VkID0gcGFyc2VQcmVmaXgodGV4dCk7XG4gIGNvbnN0IG1vZGUgPSBwYXJzZWQubW9kZSA/PyAkPEhUTUxTZWxlY3RFbGVtZW50PihcIm1vZGVcIikudmFsdWU7XG4gIHRleHQgPSBwYXJzZWQucmVzdDtcbiAgaWYgKCF0ZXh0KSByZXR1cm47XG4gIGlmIChtb2RlID09PSBcInNheVwiKSBwdXNoKHsgdHlwZTogXCJzYXlcIiwgdGV4dCB9KTtcbiAgZWxzZSB7XG4gICAgcHVzaCh7IHR5cGU6IFwiYXNrXCIsIHRleHQsIGFnZW50OiBtb2RlIH0pO1xuICAgIG5vdGUoYFlvdSBcdTIxOTIgbmV3ICR7bW9kZSA9PT0gXCJ0M1wiID8gXCJjb2RpbmdcIiA6IFwiSGVybWVzXCJ9IHRhc2s6ICR7dGV4dH1gKTtcbiAgfVxuICBpbnB1dC52YWx1ZSA9IFwiXCI7XG4gIHN5bmNDb21wb3NlcigpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBtYWluKCkge1xuICBhcHBseVRoZW1lKGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UudGhlbWVcIikgPz8gXCJzeXN0ZW1cIik7XG4gIHNlcnZlciA9IGF3YWl0IChhd2FpdCBmZXRjaChcIi9jb25maWdcIikpLmpzb24oKTtcbiAgJChcInJvdXRlXCIpLnRleHRDb250ZW50ID0gYCR7c2VydmVyLnJvdXRlID09PSBcInZlcnRleFwiID8gXCJWZXJ0ZXhcIiA6IFwiR2VtaW5pIEFQSVwifSBcdTAwQjcgJHtzZXJ2ZXIubW9kZWwuc3BsaXQoXCIvXCIpLnBvcCgpfWA7XG4gICQoXCJ2ZXJzaW9uXCIpLnRleHRDb250ZW50ID0gc2VydmVyLnZlcnNpb247XG4gICQoXCJidWlsZFwiKS50ZXh0Q29udGVudCA9IGBjb3JlICR7c2VydmVyLnZlcnNpb259YDtcbiAgc2V0dGluZ3NGcm9tU3RvcmFnZSgpO1xuICBpZiAoIXNlcnZlci5oZXJtZXMpIHsgJDxIVE1MSW5wdXRFbGVtZW50PihcImZha2VoZXJtZXNcIikuY2hlY2tlZCA9IHRydWU7ICQ8SFRNTElucHV0RWxlbWVudD4oXCJmYWtlaGVybWVzXCIpLmRpc2FibGVkID0gdHJ1ZTsgfVxuICBpZiAoIXNlcnZlci50MykgJChcImNvZGluZ2hlbHBcIikudGV4dENvbnRlbnQgPSBcIlQzIGlzbid0IGF2YWlsYWJsZSBvbiB0aGUgc2VydmVyOiBvbmx5IHdpdGggZmFrZSBhbnN3ZXJzLlwiO1xuICBlbHNlICQoXCJjb2RpbmdoZWxwXCIpLnRleHRDb250ZW50ID0gYENvZGUgY2hhbmdlcyBnbyB0byBhIFQzIENvZGUgdGhyZWFkIGluIG9uZSBvZjogJHtzZXJ2ZXIudDMuam9pbihcIiwgXCIpfS5gO1xuICBpZiAoIXN0b3BXb3Jkcy5zdXBwb3J0ZWQpIHsgJDxIVE1MSW5wdXRFbGVtZW50PihcInN0b3B3b3JkXCIpLmNoZWNrZWQgPSBmYWxzZTsgJDxIVE1MSW5wdXRFbGVtZW50PihcInN0b3B3b3JkXCIpLmRpc2FibGVkID0gdHJ1ZTsgfVxuICBjb25zdCBwcmVzZXQgPSAkPEhUTUxTZWxlY3RFbGVtZW50PihcInByZXNldFwiKTtcbiAgZm9yIChjb25zdCBuYW1lIG9mIE9iamVjdC5rZXlzKFBSRVNFVFMpKSBwcmVzZXQuYWRkKG5ldyBPcHRpb24obmFtZSwgbmFtZSkpO1xuICBwcmVzZXQudmFsdWUgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLWNvcmUucHJlc2V0XCIpID8/IFwid2ViXCI7XG4gIGlmICghUFJFU0VUU1twcmVzZXQudmFsdWVdKSBwcmVzZXQudmFsdWUgPSBcIndlYlwiO1xuICAkPEhUTUxUZXh0QXJlYUVsZW1lbnQ+KFwiY29uZmlnXCIpLnZhbHVlID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS1jb3JlLmNvbmZpZ1wiKSA/PyBKU09OLnN0cmluZ2lmeShQUkVTRVRTW3ByZXNldC52YWx1ZV0sIG51bGwsIDIpO1xuICBwcmVzZXQub25jaGFuZ2UgPSAoKSA9PiB7XG4gICAgJDxIVE1MVGV4dEFyZWFFbGVtZW50PihcImNvbmZpZ1wiKS52YWx1ZSA9IEpTT04uc3RyaW5naWZ5KFBSRVNFVFNbcHJlc2V0LnZhbHVlXSwgbnVsbCwgMik7XG4gICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS1jb3JlLnByZXNldFwiLCBwcmVzZXQudmFsdWUpO1xuICAgIGxvY2FsU3RvcmFnZS5yZW1vdmVJdGVtKFwidm9pY2UtY29yZS5jb25maWdcIik7XG4gIH07XG4gICQoXCJjb25maWdcIikub25pbnB1dCA9ICgpID0+IGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2UtY29yZS5jb25maWdcIiwgJDxIVE1MVGV4dEFyZWFFbGVtZW50PihcImNvbmZpZ1wiKS52YWx1ZSk7XG4gICQoXCJkZWZhdWx0c1wiKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGMgPSBjb3JlID8/IChhd2FpdCBsb2FkQ29yZSgpKTtcbiAgICAkKFwiZGVmYXVsdHN2aWV3XCIpLnRleHRDb250ZW50ID0gSlNPTi5zdHJpbmdpZnkoSlNPTi5wYXJzZShjLmRlZmF1bHRzKCkpLCBudWxsLCAyKTtcbiAgICAkKFwiZGVmYXVsdHN2aWV3XCIpLmhpZGRlbiA9ICEkKFwiZGVmYXVsdHN2aWV3XCIpLmhpZGRlbjtcbiAgfTtcbiAgY29uc3Qgb25DYWxsQ2xpY2sgPSAoKSA9PiB2b2lkIGNhbGxCdXR0b24oKS5jYXRjaCgoZXJyKSA9PiB7IHRvYXN0KGVyci5tZXNzYWdlKTsgbG9nKFwiZXJyb3JcIiwgZXJyLm1lc3NhZ2UsIFwiZXJyXCIpOyB9KTtcbiAgY29uc3Qgb25IZXJvQ2FsbENsaWNrID0gKCkgPT4geyBpZiAoIWNhbGxJZCkgdm9pZCBzdGFydCgpLmNhdGNoKChlcnIpID0+IHsgdG9hc3QoZXJyLm1lc3NhZ2UpOyBsb2coXCJlcnJvclwiLCBlcnIubWVzc2FnZSwgXCJlcnJcIik7IH0pOyB9O1xuICBjb25zdCBvblJlc3VtZUNsaWNrID0gKCkgPT4gdm9pZCBzdGFydCh0cnVlKS5jYXRjaCgoZXJyKSA9PiB7IHRvYXN0KGVyci5tZXNzYWdlKTsgbG9nKFwiZXJyb3JcIiwgZXJyLm1lc3NhZ2UsIFwiZXJyXCIpOyB9KTtcbiAgJChcImNhbGxcIikub25jbGljayA9IG9uQ2FsbENsaWNrO1xuICAkKFwiaGVyby1jYWxsXCIpLm9uY2xpY2sgPSBvbkhlcm9DYWxsQ2xpY2s7XG4gICQoXCJyZXN1bWVcIikub25jbGljayA9IG9uUmVzdW1lQ2xpY2s7XG4gICQoXCJoZXJvLXJlc3VtZVwiKS5vbmNsaWNrID0gb25SZXN1bWVDbGljaztcbiAgaWYgKHNhdmVkSGlzdG9yeSgpLmxlbmd0aCA+IDApIHtcbiAgICBzeW5jUmVzdW1lQnV0dG9ucyh0cnVlKTtcbiAgICAkKFwicmVzdW1lXCIpLnRpdGxlID0gXCJDYWxsIGFnYWluLCBjYXJyeWluZyBvbiBmcm9tIHRoZSBsYXN0IGNvbnZlcnNhdGlvblwiO1xuICB9XG4gICQoXCJtaWNcIikub25jbGljayA9ICgpID0+IHNldE11dGVkKCFtdXRlZCk7XG4gICQoXCJodXNoXCIpLm9uY2xpY2sgPSAoKSA9PiB7IHB1c2goeyB0eXBlOiBcImludGVycnVwdFwiIH0pOyBhdWRpby5mbHVzaCgpOyB9O1xuICAkKFwiY2FuY2VsYWxsXCIpLm9uY2xpY2sgPSAoKSA9PiBwdXNoKHsgdHlwZTogXCJjYW5jZWxBbGxcIiB9KTtcbiAgJChcImRvbmVib3hcIikuYWRkRXZlbnRMaXN0ZW5lcihcInRvZ2dsZVwiLCAoKSA9PiB7IGlmICgkPEhUTUxEZXRhaWxzRWxlbWVudD4oXCJkb25lYm94XCIpLm9wZW4pICQoXCJkb25lYm94XCIpLnNjcm9sbEludG9WaWV3KHsgYmxvY2s6IFwibmVhcmVzdFwiIH0pOyB9KTtcbiAgJChcInNheVwiKS5vbnN1Ym1pdCA9IChlKSA9PiB2b2lkIHN1Ym1pdFRleHQoZSk7XG4gICQoXCJ0ZXh0XCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJpbnB1dFwiLCBzeW5jQ29tcG9zZXIpO1xuICAkKFwidHJhbnNjcmlwdFwiKS5hZGRFdmVudExpc3RlbmVyKFwic2Nyb2xsXCIsIHVwZGF0ZUp1bXBCdXR0b24sIHsgcGFzc2l2ZTogdHJ1ZSB9KTtcbiAgJChcImp1bXBib3R0b21cIikub25jbGljayA9ICgpID0+ICQoXCJ0cmFuc2NyaXB0XCIpLnNjcm9sbFRvKHsgdG9wOiAkKFwidHJhbnNjcmlwdFwiKS5zY3JvbGxIZWlnaHQsIGJlaGF2aW9yOiBcInNtb290aFwiIH0pO1xuICBzeW5jQ29tcG9zZXIoKTtcbiAgdGFicygpO1xuICBrZXlzKCk7XG4gIGNvbnN0IGV2ZW50cyA9IG5ldyBFdmVudFNvdXJjZShcIi9ldmVudHNcIik7XG4gIGV2ZW50cy5hZGRFdmVudExpc3RlbmVyKFwiY29yZVwiLCAoZSkgPT4ge1xuICAgIGNvbnN0IHsgdmVyc2lvbiB9ID0gSlNPTi5wYXJzZSgoZSBhcyBNZXNzYWdlRXZlbnQpLmRhdGEpO1xuICAgICQoXCJ2ZXJzaW9uXCIpLnRleHRDb250ZW50ID0gdmVyc2lvbiArIChjYWxsSWQgJiYgY29yZSAmJiBjb3JlLnZlcnNpb24gIT09IHZlcnNpb24gPyBgIChuZXh0IGNhbGw7IHRoaXMgb25lIHJ1bnMgJHtjb3JlLnZlcnNpb259KWAgOiBcIlwiKTtcbiAgICAkKFwiYnVpbGRcIikudGV4dENvbnRlbnQgPSBgY29yZSAke3ZlcnNpb259YDtcbiAgfSk7XG4gIGV2ZW50cy5hZGRFdmVudExpc3RlbmVyKFwiYXBwXCIsICgpID0+IHsgaWYgKCFjYWxsSWQpIGxvY2F0aW9uLnJlbG9hZCgpOyBlbHNlIHRvYXN0KFwiVGhlIHBhZ2UgY2hhbmdlZDogcmVsb2FkIGFmdGVyIHRoaXMgY2FsbFwiKTsgfSk7XG4gIGV2ZW50cy5hZGRFdmVudExpc3RlbmVyKFwiZXJyb3JcIiwgKGUpID0+IHtcbiAgICBjb25zdCBkYXRhID0gKGUgYXMgTWVzc2FnZUV2ZW50KS5kYXRhO1xuICAgIGlmIChkYXRhKSB0b2FzdChgQnVpbGQgZmFpbGVkOiAke0pTT04ucGFyc2UoZGF0YSkubWVzc2FnZX1gKTtcbiAgfSk7XG4gIG5ldyBSZXBsYXkoJChcInJlcGxheVwiKSwgbG9hZENvcmUpO1xuICB2b2lkIHBpbmcoKTtcbiAgdm9pZCBzaG93RWFybGllcigpO1xuICB3aW5kb3cuc2V0SW50ZXJ2YWwoKCkgPT4gdm9pZCBzaG93RWFybGllcigpLCAzMF8wMDApO1xufVxuXG52b2lkIG1haW4oKTtcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFTQSxJQUFNLFNBQVMsb0JBQUksSUFBSTtBQUFBLEVBQ3JCO0FBQUEsRUFBTztBQUFBLEVBQU07QUFBQSxFQUFRO0FBQUEsRUFBVTtBQUFBLEVBQU87QUFBQSxFQUFRO0FBQUEsRUFBTTtBQUFBLEVBQU07QUFBQSxFQUFNO0FBQUEsRUFBTTtBQUFBLEVBQVc7QUFBQSxFQUFTO0FBQUEsRUFBUTtBQUFBLEVBQU87QUFBQSxFQUFVO0FBQUEsRUFBUztBQUFBLEVBQzVIO0FBQ0YsQ0FBQztBQUdNLFNBQVMsTUFBTSxNQUF3QjtBQUM1QyxTQUFPLEtBQUssWUFBWSxFQUFFLFFBQVEsVUFBVSxFQUFFLEVBQUUsUUFBUSxxQkFBcUIsR0FBRyxFQUFFLEtBQUssRUFBRSxNQUFNLEdBQUcsRUFBRSxPQUFPLENBQUMsTUFBTSxFQUFFLFNBQVMsQ0FBQztBQUNoSTtBQUdPLFNBQVMsVUFBVSxXQUFtQixVQUF5QixRQUFrQixDQUFDLEdBQXdCO0FBQy9HLFFBQU0sVUFBVSxvQkFBSSxJQUFJLENBQUMsR0FBRyxRQUFRLEdBQUcsTUFBTSxRQUFRLEtBQUssQ0FBQyxDQUFDO0FBQzVELFFBQU0sT0FBTyxNQUFNLFNBQVM7QUFDNUIsTUFBSSxPQUFPO0FBQ1gsTUFBSSxLQUFLLEtBQUs7QUFDZCxTQUFPLE9BQU8sTUFBTSxRQUFRLElBQUksS0FBSyxJQUFJLENBQUMsRUFBRztBQUM3QyxTQUFPLEtBQUssUUFBUSxRQUFR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QUFtQixJQUFJO0FBQ3ZELE1BQUUsU0FBUyxFQUFFLGNBQWMsV0FBVyxVQUFVLFFBQVEsS0FBSyxZQUFZLFVBQVUsOEJBQThCLEtBQUssT0FBTyxNQUFNO0FBQ25JLE1BQUUsT0FBTyxFQUFFLGNBQWMsUUFBUSxPQUFPO0FBQUEsRUFDMUMsQ0FBQztBQUNELFNBQU8saUJBQWlCLE9BQU8sTUFBTTtBQUFFLFFBQUksQ0FBQyxPQUFRLFVBQVMsT0FBTztBQUFBLFFBQVEsT0FBTSwwQ0FBMEM7QUFBQSxFQUFHLENBQUM7QUFDaEksU0FBTyxpQkFBaUIsU0FBUyxDQUFDLE1BQU07QUFDdEMsVUFBTSxPQUFRLEVBQW1CO0FBQ2pDLFFBQUksS0FBTSxPQUFNLGlCQUFpQixLQUFLLE1BQU0sSUFBSSxFQUFFLE9BQU8sRUFBRTtBQUFBLEVBQzdELENBQUM7QUFDRCxNQUFJLE9BQU8sRUFBRSxRQUFRLEdBQUcsUUFBUTtBQUNoQyxPQUFLLEtBQUs7QUFDVixPQUFLLFlBQVk7QUFDakIsU0FBTyxZQUFZLE1BQU0sS0FBSyxZQUFZLEdBQUcsR0FBTTtBQUNyRDtBQUVBLEtBQUssS0FBSzsiLAogICJuYW1lcyI6IFsiY29yZSIsICJjb3JlIiwgIm5vdyIsICJsaXZlIiwgImxpbmUiLCAicnVuIl0KfQo=
