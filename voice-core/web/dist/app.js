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
      <div class="bar"><select class="pick"></select><button class="refresh">\u21BB</button><button class="go">Replay</button>
      <label><input type="checkbox" class="all"> show audio and ticks</label><span class="summary"></span></div>
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
var counts = { mic: 0, play: 0, sent: 0 };
var fakeTvLevel = 15;
var coreStatus = "idle";
var muted = false;
var holding = false;
var wakeLock = null;
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
  if (rtt != null) parts.push(`network ${Math.round(rtt * 1e3)} ms`);
  const reply = median(metrics.reply);
  if (reply != null) parts.push(`reply ${metrics.reply.at(-1).toFixed(1)} s (median ${reply.toFixed(1)})`);
  const out = audio.outputLatency;
  if (out != null) parts.push(`audio ${Math.round(out * 1e3)} ms`);
  let buffered = 0;
  for (const ws of sockets.values()) buffered += ws.bufferedAmount;
  if (buffered > 32e3) parts.push(`upload behind ${(buffered / 32e3).toFixed(1)} s`);
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
    if (i % 2 === 1) return `<pre>${block}</pre>`;
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
      html += heading ? `<b>${inline(heading[1])}</b><br>` : raw.trim() === "" ? "<br>" : `${inline(raw)}<br>`;
    }
    if (list) html += `</${list}>`;
    return html;
  }).join("");
}
function scrollDown(force = false) {
  const pane = $("transcript");
  if (force || pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 80) pane.scrollTop = pane.scrollHeight;
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
  row.className = `line result ${agent === "t3" ? "t3" : ""}`;
  row.innerHTML = `<span class="who">${agent === "t3" ? "T3" : "Hermes"} \xB7 ${escapeHtml(label)}${failed ? " \xB7 failed" : ""}</span><div class="body">${markdown(text)}</div>`;
  $("transcript").append(row);
  openLine = null;
  const body = row.querySelector(".body");
  requestAnimationFrame(() => {
    if (body.scrollHeight > body.clientHeight + 4) {
      const more = document.createElement("button");
      more.className = "more";
      more.textContent = "Show all";
      more.onclick = () => {
        row.classList.toggle("open");
        more.textContent = row.classList.contains("open") ? "Show less" : "Show all";
      };
      row.append(more);
    }
  });
  scrollDown(true);
  return row;
}
function elapsed(seconds) {
  if (seconds < 60) return `${Math.floor(seconds)} s`;
  const m = Math.floor(seconds / 60);
  return m < 60 ? `${m} min ${Math.floor(seconds % 60)} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
var noTasks = document.getElementById("notasks");
var live = (state) => state === "running" || state.startsWith("waiting");
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
    showDone();
    return;
  }
  const running = all.filter((t) => t.c.state === "running").length;
  $("taskcount").textContent = running > 0 ? `${running} running` : "";
  $("cancelall").hidden = !callId || running < 2;
  for (const view of all) {
    const t = view.c;
    const waiting = t.state.startsWith("waiting");
    const card = document.createElement("div");
    card.className = `task ${waiting ? "waiting" : t.state}`;
    const age = (view.ended ?? now()) - view.since;
    card.innerHTML = `<div class="top"><span class="badge ${t.agent === "t3" ? "t3" : ""}">${t.agent === "t3" ? "T3" : "Hermes"}</span><span class="label"></span><span class="state">${t.state === "running" ? '<span class="spin"></span> ' : ""}${escapeHtml(t.state)} \xB7 ${elapsed(age)}</span></div><div class="p"></div>`;
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
      box.innerHTML = `<div>Hermes asks to run:</div><code></code><div class="acts"></div>`;
      box.querySelector("code").textContent = view.approval.command;
      const answer = (choice) => {
        view.approval = void 0;
        showTasks(true);
        void fetch("/hermes/approval", { method: "POST", body: JSON.stringify({ call: callName, taskId: t.id, choice }) }).then((r) => toast(r.ok ? choice === "once" ? "Approved" : "Denied" : "That approval had already lapsed"));
      };
      for (const [label, choice] of [["Approve once", "once"], ["Deny", "deny"]]) {
        const b = document.createElement("button");
        b.textContent = label;
        if (choice === "once") b.className = "go";
        b.onclick = () => answer(choice);
        box.querySelector(".acts").append(b);
      }
      card.append(box);
    }
    if (t.state !== "running") view.approval = void 0;
    const acts = document.createElement("div");
    acts.className = "acts";
    const button = (text, fn) => {
      const b = document.createElement("button");
      b.textContent = text;
      b.onclick = fn;
      acts.append(b);
      return b;
    };
    if (callId) {
      button(waiting ? "Answer" : "Follow up", () => followUpForm(card, t));
      if (t.state === "running") button("Cancel", () => push({ type: "cancelTask", task: t.id }));
    }
    if (view.result) button("Result", () => {
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
  showDone();
}
function followUpForm(card, t) {
  if (card.querySelector("form")) return;
  const form = document.createElement("form");
  form.innerHTML = `<input type="text" placeholder="Tell \u201C${escapeHtml(t.label)}\u201D\u2026" enterkeyhint="send"><button>Send</button>`;
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
  for (const t of list) {
    const card = document.createElement("div");
    const state = t.waiting ? "waiting for approval in T3" : t.status;
    card.className = `task ${t.status === "running" ? "running" : t.waiting ? "waiting" : "finished"}`;
    const ago = Math.max(0, (Date.now() - Date.parse(t.updated)) / 1e3);
    card.innerHTML = `<div class="top"><span class="badge t3">T3</span><span class="label"></span><span class="state">${t.status === "running" ? '<span class="spin"></span> ' : ""}${escapeHtml(state)} \xB7 ${elapsed(ago)} ago</span></div><div class="p"></div>`;
    card.querySelector(".label").textContent = t.title;
    card.querySelector(".p").textContent = t.last || (t.branch ? `On ${t.branch}` : "");
    const acts = document.createElement("div");
    acts.className = "acts";
    if (t.pr) {
      const a = document.createElement("a");
      a.href = t.pr;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "Pull request";
      acts.append(a);
    }
    const copy = document.createElement("button");
    copy.textContent = "Copy thread id";
    copy.onclick = () => {
      void navigator.clipboard?.writeText(t.thread);
      toast("Thread id copied");
    };
    acts.append(copy);
    card.append(acts);
    (t.status === "running" || t.waiting ? pane : done).append(card);
  }
  $("earlierbox").hidden = pane.childElementCount === 0;
  showDone();
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
  const speaking = callId && coreStatus !== "standby" && audio.queued > 0.05;
  const shown = speaking ? "speaking" : coreStatus;
  $("status").className = shown;
  let text = speaking ? "Speaking" : STATUS_TEXT[coreStatus] ?? coreStatus;
  if (callId && muted && !holding && !speaking) text += " \xB7 muted";
  if (holding) text = "Talking (hold)";
  if (message) text = `${text}: ${message}`;
  if (coreStatus !== "ended" || message) $("statustext").textContent = text;
  $("hush").classList.toggle("live", Boolean(speaking));
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
async function start(carryOn = false) {
  if (callId) return;
  let given;
  try {
    given = readConfig();
  } catch (err) {
    toast(`The developer settings aren't valid JSON: ${err.message}`);
    return;
  }
  $("call").disabled = true;
  if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission().catch(() => {
  });
  try {
    await audio.open();
    core = await loadCore();
  } finally {
    $("call").disabled = false;
  }
  $("version").textContent = core.version;
  $("log").innerHTML = "";
  if (tasks.size > 0 || $("transcript").childElementCount > 1) note(`New call \xB7 ${(/* @__PURE__ */ new Date()).toLocaleTimeString()}`);
  tasks.clear();
  showTasks();
  counts = { mic: 0, play: 0, sent: 0 };
  metrics.reply = [];
  startedAt = now();
  muted = given.muted === true;
  if (carryOn && given.history === void 0) given.history = savedHistory();
  else if (!carryOn) chat = [];
  if (carryOn) chat = savedHistory();
  lastLine = null;
  openLine = null;
  $("resume").hidden = true;
  callName = `${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}-web-${core.version}`;
  const created = JSON.parse(core.create(JSON.stringify(given), now()));
  callId = created.id;
  $("call").textContent = "Hang up";
  $("call").classList.add("live");
  for (const id of ["mic", "hush"]) $(id).disabled = false;
  $("mic").classList.toggle("muted", muted);
  run2(created.commands);
  ticker = window.setInterval(() => {
    push({ type: "tick" });
    const level = muted && !holding ? 0 : audio.level;
    $("ring").style.opacity = String(Math.min(1, level * 12));
    $("counts").textContent = `mic ${counts.mic} \xB7 sent ${counts.sent} \xB7 played ${counts.play} \xB7 queued ${audio.queued.toFixed(1)} s`;
    showStatus();
  }, 100);
  traceTimer = window.setInterval(() => {
    void saveTrace();
    void ping();
    showTasks();
  }, 5e3);
  void ping();
  stopWords.start();
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
  } catch {
  }
}
function hangUp() {
  if (callId) push({ type: "stop", message: "You hung up." });
}
function end() {
  window.clearInterval(ticker);
  window.clearInterval(traceTimer);
  stopWords.stop();
  void saveTrace().then(() => {
    if (core && callId) core.dispose(callId);
    callId = 0;
    showTasks();
  });
  audio.stop();
  for (const ws of sockets.values()) ws.close();
  sockets.clear();
  for (const r of runs.values()) r.abort.abort();
  runs.clear();
  $("call").textContent = "Call";
  $("call").classList.remove("live");
  for (const id of ["mic", "hush"]) $(id).disabled = true;
  $("ring").style.opacity = "0";
  $("resume").hidden = chat.length === 0;
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
  $("mode").addEventListener("change", () => localStorage.setItem("voice.mode", $("mode").value));
}
function tabs() {
  const views = { talk: $("talk"), dev: $("dev"), replay: $("replaymain") };
  for (const name of Object.keys(views)) {
    $(`tab-${name}`).onclick = () => {
      for (const [other, el] of Object.entries(views)) {
        el.hidden = other !== name;
        $(`tab-${other}`).classList.toggle("on", other === name);
      }
    };
  }
  $("gear").onclick = () => {
    $("settings").hidden = false;
  };
  $("closesettings").onclick = () => {
    $("settings").hidden = true;
  };
  $("settings").onclick = (e) => {
    if (e.target === $("settings")) $("settings").hidden = true;
  };
}
function typing() {
  const el = document.activeElement;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}
function keys() {
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && callId) {
      push({ type: "interrupt" });
      audio.flush();
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
function submitText(e) {
  e.preventDefault();
  const input = $("text");
  let text = input.value.trim();
  if (!text) return;
  if (!callId) {
    toast("Start a call first");
    return;
  }
  let mode = $("mode").value;
  const prefix = text.match(/^\/(t3|code|h|hermes)\s+/i);
  if (prefix) {
    mode = /^(t3|code)$/i.test(prefix[1]) ? "t3" : "hermes";
    text = text.slice(prefix[0].length).trim();
  }
  if (!text) return;
  if (mode === "say") push({ type: "say", text });
  else {
    push({ type: "ask", text, agent: mode });
    note(`You \u2192 new ${mode === "t3" ? "coding" : "Hermes"} task: ${text}`);
  }
  input.value = "";
}
async function main() {
  server = await (await fetch("/config")).json();
  $("route").textContent = `${server.route === "vertex" ? "GSK Vertex" : "Gemini API"} \xB7 ${server.model.split("/").pop()}`;
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
  $("call").onclick = () => callId ? hangUp() : void start().catch((err) => {
    toast(err.message);
    log("error", err.message, "err");
  });
  $("resume").onclick = () => void start(true).catch((err) => {
    toast(err.message);
    log("error", err.message, "err");
  });
  if (savedHistory().length > 0) {
    $("resume").hidden = false;
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
  $("say").onsubmit = submitText;
  $("text").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitText(e);
  });
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL2NvbW1hbmRzLnRzIiwgIi4uL2F1ZGlvLnRzIiwgIi4uL3JlcGxheS50cyIsICIuLi9hcHAudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFNwb2tlbiBjb21tYW5kcyB0aGUgY29yZSBhY3RzIG9uIHdpdGhvdXQgdGhlIG1vZGVsOiBcInN0b3BcIiBhbmQgXCJoYW5nIHVwXCIuIEFuIHV0dGVyYW5jZSBjb3VudHNcbi8vIG9ubHkgd2hlbiBpdCBpcyBvbmUgb2YgdGhlIHBocmFzZXMgYW5kIG5vdGhpbmcgbW9yZSwgb25jZSBuYW1lcyBhbmQgZmlsbGVycyBhcm91bmQgaXQgYXJlIGdvbmUsXG4vLyBzbyBcIldvb2Rob3VzZSwgc3RvcCBwbGVhc2VcIiBzdG9wcyBhbmQgXCJzdG9wIHRoZSBQZW5ueXdvcnRoIHRhc2tcIiBnb2VzIHRvIHRoZSBtb2RlbCBhcyB1c3VhbC5cblxuaW1wb3J0IHR5cGUgeyBWb2ljZUNvbW1hbmRzIH0gZnJvbSBcIi4vdHlwZXMudHNcIjtcblxuZXhwb3J0IHR5cGUgVm9pY2VDb21tYW5kID0gXCJzdG9wXCIgfCBcImhhbmdVcFwiIHwgXCJjYW5jZWxBbGxcIjtcblxuLyoqIFdvcmRzIHRoYXQgbWF5IGNvbWUgYmVmb3JlIG9yIGFmdGVyIGEgY29tbWFuZCB3aXRob3V0IGNoYW5naW5nIGl0LiAqL1xuY29uc3QgRklMTEVSID0gbmV3IFNldChbXG4gIFwiaGV5XCIsIFwib2tcIiwgXCJva2F5XCIsIFwicGxlYXNlXCIsIFwibm93XCIsIFwianVzdFwiLCBcInNvXCIsIFwidW1cIiwgXCJ1aFwiLCBcIm9oXCIsIFwiYWxyaWdodFwiLCBcInJpZ2h0XCIsIFwieWVhaFwiLCBcInllc1wiLCBcInRoYW5rc1wiLCBcInRoYW5rXCIsIFwieW91XCIsXG4gIFwiZ2VtaW5pXCIsXG5dKTtcblxuLyoqIFt0ZXh0XSBhcyBsb3dlci1jYXNlIHdvcmRzLCBhcG9zdHJvcGhlcyBkcm9wcGVkIChcIlRoYXQnc1wiIGlzIFwidGhhdHNcIikuICovXG5leHBvcnQgZnVuY3Rpb24gd29yZHModGV4dDogc3RyaW5nKTogc3RyaW5nW10ge1xuICByZXR1cm4gdGV4dC50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL1snXHUyMDE5YF0vZywgXCJcIikucmVwbGFjZSgvW15cXHB7TH1cXHB7TmR9XSsvZ3UsIFwiIFwiKS50cmltKCkuc3BsaXQoXCIgXCIpLmZpbHRlcigodykgPT4gdy5sZW5ndGggPiAwKTtcbn1cblxuLyoqIFRoZSBjb21tYW5kIFt1dHRlcmFuY2VdIGlzLCBpZiBpdCdzIG9uZSBhbmQgbm90aGluZyBtb3JlOyBbbmFtZXNdICh0aGUgYXNzaXN0YW50J3MsIFwiV29vZGhvdXNlXCIpIGRvbid0IGNvdW50LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbW1hbmRJbih1dHRlcmFuY2U6IHN0cmluZywgY29tbWFuZHM6IFZvaWNlQ29tbWFuZHMsIG5hbWVzOiBzdHJpbmdbXSA9IFtdKTogVm9pY2VDb21tYW5kIHwgbnVsbCB7XG4gIGNvbnN0IGlnbm9yZWQgPSBuZXcgU2V0KFsuLi5GSUxMRVIsIC4uLm5hbWVzLmZsYXRNYXAod29yZHMpXSk7XG4gIGNvbnN0IHNhaWQgPSB3b3Jkcyh1dHRlcmFuY2UpO1xuICBsZXQgZnJvbSA9IDA7XG4gIGxldCB0byA9IHNhaWQubGVuZ3RoO1xuICB3aGlsZSAoZnJvbSA8IHRvICYmIGlnbm9yZWQuaGFzKHNhaWRbZnJvbV0pKSBmcm9tKys7XG4gIHdoaWxlICh0byA+IGZyb20gJiYgaWdub3JlZC5oYXMoc2FpZFt0byAtIDFdKSkgdG8tLTtcbiAgaWYgKGZyb20gPT09IHRvIHx8IHRvIC0gZnJvbSA+IDUpIHJldHVybiBudWxsO1xuICBjb25zdCBjb3JlID0gc2FpZC5zbGljZShmcm9tLCB0bykuam9pbihcIiBcIik7XG4gIGNvbnN0IGlzID0gKHBocmFzZXM6IHN0cmluZ1tdKSA9PiBwaHJhc2VzLnNvbWUoKHApID0+IHdvcmRzKHApLmpvaW4oXCIgXCIpID09PSBjb3JlKTtcbiAgaWYgKGlzKGNvbW1hbmRzLmhhbmdVcCkpIHJldHVybiBcImhhbmdVcFwiO1xuICBpZiAoaXMoY29tbWFuZHMuY2FuY2VsQWxsID8/IFtdKSkgcmV0dXJuIFwiY2FuY2VsQWxsXCI7XG4gIGlmIChpcyhjb21tYW5kcy5zdG9wKSkgcmV0dXJuIFwic3RvcFwiO1xuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqIFdvcmRzIHRoYXQgdGFrZSBhIHJlcXVlc3QgYmFjay4gKi9cbmNvbnN0IENBTkNFTFMgPSAvXFxiKD86Y2FuY2VsXFx3KnxhYm9ydFxcdyp8a2lsbHxzY3JhcHxzY3JhdGNofGRyb3B8Zm9yZ2V0fHVuZG98dGVybWluYXRlfG5ldmVyID9taW5kfGNhbGwgKD86aXR8dGhhdHx0aGlzKSBvZmZ8KD86ZG9udHxkbyBub3QpICg/OmJvdGhlcnxuZWVkfHdhbnR8ZG8pfG5vIG5lZWR8bm8gbG9uZ2VyfG5vdCBhbnltb3JlfGxlYXZlIGl0fHNraXAgKD86aXR8dGhhdCkpXFxiLztcbmNvbnN0IFNUT1BTID0gL1xcYig/OnN0b3BcXHcqfGhhbHR8cXVpdHxlbmQpXFxiLztcblxuLyoqXG4gKiBXaGV0aGVyIFt1dHRlcmFuY2VdIGFza3MgZm9yIGEgdGFzayB0byBiZSBjYW5jZWxsZWQsIGZvciBhIGNhbmNlbF90YXNrIHRoZSBtb2RlbCBjYWxsZWQgb24gaXQuIFwiU3RvcFwiIGFsb25lIGFuZCB0aGVcbiAqIG90aGVyIHN0b3AgYW5kIGhhbmctdXAgcGhyYXNlcyBkb24ndDogdGhleSBtZWFuIHN0b3AgdGFsa2luZy4gT3RoZXJ3aXNlIGl0IGRvZXMgd2hlbiBpdCBzYXlzIHNvIGluIHdvcmRzLCB3aGVuIGl0XG4gKiBuYW1lcyB0aGUgdGFzayAoW25hbWVkXSksIG9yIHdoZW4gaXQgc2F5cyB0byBzdG9wIHNvbWV0aGluZyBtb3JlIHRoYW4gdGhlIHRhbGtpbmcgKFwic3RvcCB3b3JraW5nIG9uIHRoYXRcIikuXG4gKiBXb3JkcyB0aGF0IHNheSBub25lIG9mIHRoaXMgKGEgbWlzaGVhcmluZyBzdWNoIGFzIFwiU3RhYml0XCIpIGRvbid0LiBXaXRoIG5vdGhpbmcgaGVhcmQgdGhlcmUgaXMgbm90aGluZyB0byBqdWRnZSBieS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFza3NUb0NhbmNlbCh1dHRlcmFuY2U6IHN0cmluZywgY29tbWFuZHM6IFZvaWNlQ29tbWFuZHMsIG5hbWVzOiBzdHJpbmdbXSwgbmFtZWQ6IGJvb2xlYW4pOiBib29sZWFuIHtcbiAgY29uc3Qgc2FpZCA9IHdvcmRzKHV0dGVyYW5jZSkuam9pbihcIiBcIik7XG4gIGlmIChzYWlkLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHRydWU7XG4gIGNvbnN0IGNvbW1hbmQgPSBjb21tYW5kSW4odXR0ZXJhbmNlLCBjb21tYW5kcywgbmFtZXMpO1xuICBpZiAoY29tbWFuZCA9PT0gXCJzdG9wXCIgfHwgY29tbWFuZCA9PT0gXCJoYW5nVXBcIikgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gY29tbWFuZCA9PT0gXCJjYW5jZWxBbGxcIiB8fCBuYW1lZCB8fCBDQU5DRUxTLnRlc3Qoc2FpZCkgfHwgU1RPUFMudGVzdChzYWlkKTtcbn1cbiIsICIvLyBUaGUgYnJvd3NlcidzIG1pY3JvcGhvbmUgYW5kIHNwZWFrZXIgZm9yIGEgY2FsbDogMTYga0h6IFBDTTE2IGZyYW1lcyBvdXQgb2YgdGhlIG1pY3JvcGhvbmUsXG4vLyAyNCBrSHogUENNMTYgaW50byB0aGUgc3BlYWtlciwgYW5kIHRvbmVzIGxhaWQgb3ZlciB3aGF0ZXZlciBwbGF5cy4gQm90aCBydW4gaW4gQXVkaW9Xb3JrbGV0cyBvblxuLy8gb25lIEF1ZGlvQ29udGV4dCBhdCB0aGUgZGV2aWNlJ3MgcmF0ZSwgcmVzYW1wbGluZyB0aGVyZS5cblxuY29uc3QgV09SS0xFVFMgPSBgXG5jbGFzcyBDYXB0dXJlIGV4dGVuZHMgQXVkaW9Xb3JrbGV0UHJvY2Vzc29yIHtcbiAgY29uc3RydWN0b3IoKSB7XG4gICAgc3VwZXIoKTtcbiAgICB0aGlzLnN0ZXAgPSBzYW1wbGVSYXRlIC8gMTYwMDA7XG4gICAgdGhpcy5wb3MgPSAwO1xuICAgIHRoaXMuZnJhbWUgPSBuZXcgSW50MTZBcnJheSgzMjApO1xuICAgIHRoaXMubiA9IDA7XG4gICAgLy8gQSB3aW5kb3dlZC1zaW5jIGxvdy1wYXNzIGF0IDcga0h6LCBzbyBub3RoaW5nIGFib3ZlIDE2IGtIeidzIDgga0h6IGxpbWl0IGZvbGRzIGJhY2sgaW50byBzcGVlY2guXG4gICAgY29uc3QgdGFwcyA9IDQ3LCBjdXQgPSA3MDAwIC8gc2FtcGxlUmF0ZTtcbiAgICB0aGlzLnRhcHMgPSBuZXcgRmxvYXQzMkFycmF5KHRhcHMpO1xuICAgIGxldCBzdW0gPSAwO1xuICAgIGZvciAobGV0IGsgPSAwOyBrIDwgdGFwczsgaysrKSB7XG4gICAgICBjb25zdCBtID0gayAtICh0YXBzIC0gMSkgLyAyO1xuICAgICAgY29uc3Qgc2luYyA9IG0gPT09IDAgPyAyICogY3V0IDogTWF0aC5zaW4oMiAqIE1hdGguUEkgKiBjdXQgKiBtKSAvIChNYXRoLlBJICogbSk7XG4gICAgICBjb25zdCB3ID0gMC40MiAtIDAuNSAqIE1hdGguY29zKCgyICogTWF0aC5QSSAqIGspIC8gKHRhcHMgLSAxKSkgKyAwLjA4ICogTWF0aC5jb3MoKDQgKiBNYXRoLlBJICogaykgLyAodGFwcyAtIDEpKTtcbiAgICAgIHRoaXMudGFwc1trXSA9IHNpbmMgKiB3O1xuICAgICAgc3VtICs9IHRoaXMudGFwc1trXTtcbiAgICB9XG4gICAgZm9yIChsZXQgayA9IDA7IGsgPCB0YXBzOyBrKyspIHRoaXMudGFwc1trXSAvPSBzdW07XG4gICAgdGhpcy5oaXN0b3J5ID0gbmV3IEZsb2F0MzJBcnJheSh0YXBzKTtcbiAgICB0aGlzLmF0ID0gMDtcbiAgfVxuICBwcm9jZXNzKGlucHV0cykge1xuICAgIGNvbnN0IGlucHV0ID0gaW5wdXRzWzBdICYmIGlucHV0c1swXVswXTtcbiAgICBpZiAoIWlucHV0KSByZXR1cm4gdHJ1ZTtcbiAgICBjb25zdCB0YXBzID0gdGhpcy50YXBzLCBoID0gdGhpcy5oaXN0b3J5LCBuID0gdGFwcy5sZW5ndGg7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBpbnB1dC5sZW5ndGg7IGkrKykge1xuICAgICAgaFt0aGlzLmF0XSA9IGlucHV0W2ldO1xuICAgICAgdGhpcy5hdCA9ICh0aGlzLmF0ICsgMSkgJSBuO1xuICAgICAgLy8gT25seSB0aGUgc2FtcGxlcyBrZXB0IG5lZWQgZmlsdGVyaW5nOiBhdCBtb3N0IG9uZSBpbiBldmVyeSBzdGVwLlxuICAgICAgaWYgKHRoaXMucG9zID4gMSkgeyB0aGlzLnBvcyAtPSAxOyBjb250aW51ZTsgfVxuICAgICAgbGV0IHggPSAwO1xuICAgICAgZm9yIChsZXQgayA9IDAsIGogPSB0aGlzLmF0OyBrIDwgbjsgaysrLCBqID0gaiArIDEgPT09IG4gPyAwIDogaiArIDEpIHggKz0gdGFwc1trXSAqIGhbal07XG4gICAgICB3aGlsZSAodGhpcy5wb3MgPD0gMSkge1xuICAgICAgICBjb25zdCBzID0gTWF0aC5tYXgoLTEsIE1hdGgubWluKDEsIHgpKTtcbiAgICAgICAgdGhpcy5mcmFtZVt0aGlzLm4rK10gPSBzIDwgMCA/IHMgKiAzMjc2OCA6IHMgKiAzMjc2NztcbiAgICAgICAgaWYgKHRoaXMubiA9PT0gdGhpcy5mcmFtZS5sZW5ndGgpIHtcbiAgICAgICAgICB0aGlzLnBvcnQucG9zdE1lc3NhZ2UodGhpcy5mcmFtZS5idWZmZXIsIFt0aGlzLmZyYW1lLmJ1ZmZlcl0pO1xuICAgICAgICAgIHRoaXMuZnJhbWUgPSBuZXcgSW50MTZBcnJheSgzMjApO1xuICAgICAgICAgIHRoaXMubiA9IDA7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5wb3MgKz0gdGhpcy5zdGVwO1xuICAgICAgfVxuICAgICAgdGhpcy5wb3MgLT0gMTtcbiAgICB9XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbn1cblxuY2xhc3MgUGxheWJhY2sgZXh0ZW5kcyBBdWRpb1dvcmtsZXRQcm9jZXNzb3Ige1xuICBjb25zdHJ1Y3RvcigpIHtcbiAgICBzdXBlcigpO1xuICAgIHRoaXMucXVldWUgPSBbXTsgICAgICAvLyBGbG9hdDMyQXJyYXlzIGF0IHRoZSBjb250ZXh0J3MgcmF0ZVxuICAgIHRoaXMub2Zmc2V0ID0gMDtcbiAgICB0aGlzLmN1ZXMgPSBbXTtcbiAgICB0aGlzLmN1ZU9mZnNldCA9IDA7XG4gICAgdGhpcy5yZXBvcnRlZCA9IDA7XG4gICAgdGhpcy5wb3J0Lm9ubWVzc2FnZSA9IChlKSA9PiB7XG4gICAgICBjb25zdCBtID0gZS5kYXRhO1xuICAgICAgaWYgKG0udHlwZSA9PT0gXCJwbGF5XCIpIHRoaXMucXVldWUucHVzaChtLnNhbXBsZXMpO1xuICAgICAgZWxzZSBpZiAobS50eXBlID09PSBcImN1ZVwiKSB0aGlzLmN1ZXMucHVzaChtLnNhbXBsZXMpO1xuICAgICAgZWxzZSBpZiAobS50eXBlID09PSBcImZsdXNoXCIpIHsgdGhpcy5xdWV1ZSA9IFtdOyB0aGlzLm9mZnNldCA9IDA7IH1cbiAgICAgIGVsc2UgaWYgKG0udHlwZSA9PT0gXCJzdG9wXCIpIHsgdGhpcy5xdWV1ZSA9IFtdOyB0aGlzLm9mZnNldCA9IDA7IHRoaXMuY3VlcyA9IFtdOyB0aGlzLmN1ZU9mZnNldCA9IDA7IH1cbiAgICB9O1xuICB9XG4gIHByb2Nlc3MoXywgb3V0cHV0cykge1xuICAgIGNvbnN0IG91dCA9IG91dHB1dHNbMF1bMF07XG4gICAgb3V0LmZpbGwoMCk7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoICYmIHRoaXMucXVldWUubGVuZ3RoOyBpKyspIHtcbiAgICAgIG91dFtpXSA9IHRoaXMucXVldWVbMF1bdGhpcy5vZmZzZXQrK107XG4gICAgICBpZiAodGhpcy5vZmZzZXQgPj0gdGhpcy5xdWV1ZVswXS5sZW5ndGgpIHsgdGhpcy5xdWV1ZS5zaGlmdCgpOyB0aGlzLm9mZnNldCA9IDA7IH1cbiAgICB9XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoICYmIHRoaXMuY3Vlcy5sZW5ndGg7IGkrKykge1xuICAgICAgb3V0W2ldID0gTWF0aC5tYXgoLTEsIE1hdGgubWluKDEsIG91dFtpXSArIHRoaXMuY3Vlc1swXVt0aGlzLmN1ZU9mZnNldCsrXSkpO1xuICAgICAgaWYgKHRoaXMuY3VlT2Zmc2V0ID49IHRoaXMuY3Vlc1swXS5sZW5ndGgpIHsgdGhpcy5jdWVzLnNoaWZ0KCk7IHRoaXMuY3VlT2Zmc2V0ID0gMDsgfVxuICAgIH1cbiAgICBmb3IgKGxldCBjID0gMTsgYyA8IG91dHB1dHNbMF0ubGVuZ3RoOyBjKyspIG91dHB1dHNbMF1bY10uc2V0KG91dCk7XG4gICAgaWYgKGN1cnJlbnRUaW1lIC0gdGhpcy5yZXBvcnRlZCA+IDAuMSkge1xuICAgICAgdGhpcy5yZXBvcnRlZCA9IGN1cnJlbnRUaW1lO1xuICAgICAgbGV0IHF1ZXVlZCA9IC10aGlzLm9mZnNldDtcbiAgICAgIGZvciAoY29uc3QgcSBvZiB0aGlzLnF1ZXVlKSBxdWV1ZWQgKz0gcS5sZW5ndGg7XG4gICAgICB0aGlzLnBvcnQucG9zdE1lc3NhZ2UoeyBxdWV1ZWQ6IHF1ZXVlZCAvIHNhbXBsZVJhdGUgfSk7XG4gICAgfVxuICAgIHJldHVybiB0cnVlO1xuICB9XG59XG5yZWdpc3RlclByb2Nlc3NvcihcImNhcHR1cmVcIiwgQ2FwdHVyZSk7XG5yZWdpc3RlclByb2Nlc3NvcihcInBsYXliYWNrXCIsIFBsYXliYWNrKTtcbmA7XG5cbmZ1bmN0aW9uIGJhc2U2NFRvQnl0ZXMoYjY0OiBzdHJpbmcpOiBVaW50OEFycmF5IHtcbiAgY29uc3QgYmluID0gYXRvYihiNjQpO1xuICBjb25zdCBvdXQgPSBuZXcgVWludDhBcnJheShiaW4ubGVuZ3RoKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBiaW4ubGVuZ3RoOyBpKyspIG91dFtpXSA9IGJpbi5jaGFyQ29kZUF0KGkpO1xuICByZXR1cm4gb3V0O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYnl0ZXNUb0Jhc2U2NChieXRlczogVWludDhBcnJheSk6IHN0cmluZyB7XG4gIGxldCBiaW4gPSBcIlwiO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGJ5dGVzLmxlbmd0aDsgaSArPSAweDgwMDApIGJpbiArPSBTdHJpbmcuZnJvbUNoYXJDb2RlKC4uLmJ5dGVzLnN1YmFycmF5KGksIGkgKyAweDgwMDApKTtcbiAgcmV0dXJuIGJ0b2EoYmluKTtcbn1cblxuLyoqIFBDTTE2IGxpdHRsZS1lbmRpYW4gYXQgW3JhdGVdLCBhcyBmbG9hdHMgYXQgdGhlIGNvbnRleHQncyByYXRlLiAqL1xuZnVuY3Rpb24gdG9GbG9hdHMocGNtOiBVaW50OEFycmF5LCByYXRlOiBudW1iZXIsIHRhcmdldDogbnVtYmVyKTogRmxvYXQzMkFycmF5IHtcbiAgY29uc3QgdmlldyA9IG5ldyBEYXRhVmlldyhwY20uYnVmZmVyLCBwY20uYnl0ZU9mZnNldCwgcGNtLmJ5dGVMZW5ndGgpO1xuICBjb25zdCBuID0gTWF0aC5mbG9vcihwY20uYnl0ZUxlbmd0aCAvIDIpO1xuICBjb25zdCBvdXQgPSBuZXcgRmxvYXQzMkFycmF5KE1hdGguZmxvb3IoKG4gKiB0YXJnZXQpIC8gcmF0ZSkpO1xuICBjb25zdCBzdGVwID0gcmF0ZSAvIHRhcmdldDtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCB4ID0gaSAqIHN0ZXA7XG4gICAgY29uc3QgaiA9IE1hdGguZmxvb3IoeCk7XG4gICAgY29uc3QgYSA9IHZpZXcuZ2V0SW50MTYoMiAqIE1hdGgubWluKGosIG4gLSAxKSwgdHJ1ZSk7XG4gICAgY29uc3QgYiA9IHZpZXcuZ2V0SW50MTYoMiAqIE1hdGgubWluKGogKyAxLCBuIC0gMSksIHRydWUpO1xuICAgIG91dFtpXSA9IChhICsgKGIgLSBhKSAqICh4IC0gaikpIC8gMzI3Njg7XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBNaWNPcHRpb25zIHsgZWNob0NhbmNlbGxhdGlvbjogYm9vbGVhbjsgbm9pc2VTdXBwcmVzc2lvbjogYm9vbGVhbjsgYXV0b0dhaW5Db250cm9sOiBib29sZWFuIH1cblxuZXhwb3J0IGNsYXNzIENhbGxBdWRpbyB7XG4gIHByaXZhdGUgY29udGV4dDogQXVkaW9Db250ZXh0IHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgcGxheWJhY2s6IEF1ZGlvV29ya2xldE5vZGUgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBjYXB0dXJlOiBBdWRpb1dvcmtsZXROb2RlIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgc3RyZWFtOiBNZWRpYVN0cmVhbSB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIHNvdXJjZTogTWVkaWFTdHJlYW1BdWRpb1NvdXJjZU5vZGUgfCBudWxsID0gbnVsbDtcbiAgLyoqIFNlY29uZHMgb2Ygc3BlZWNoIHF1ZXVlZCwgYXMgdGhlIHdvcmtsZXQgbGFzdCBzYWlkLiAqL1xuICBxdWV1ZWQgPSAwO1xuICAvKiogVGhlIG1pY3JvcGhvbmUncyBsZXZlbCwgUk1TIG9mIHRoZSBsYXN0IGZyYW1lICgwIHRvIDEpLiAqL1xuICBsZXZlbCA9IDA7XG5cbiAgYXN5bmMgb3BlbigpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAodGhpcy5jb250ZXh0KSB7IGlmICh0aGlzLmNvbnRleHQuc3RhdGUgPT09IFwic3VzcGVuZGVkXCIpIGF3YWl0IHRoaXMuY29udGV4dC5yZXN1bWUoKTsgcmV0dXJuOyB9XG4gICAgdGhpcy5jb250ZXh0ID0gbmV3IEF1ZGlvQ29udGV4dCh7IGxhdGVuY3lIaW50OiBcImludGVyYWN0aXZlXCIgfSk7XG4gICAgY29uc3QgdXJsID0gVVJMLmNyZWF0ZU9iamVjdFVSTChuZXcgQmxvYihbV09SS0xFVFNdLCB7IHR5cGU6IFwidGV4dC9qYXZhc2NyaXB0XCIgfSkpO1xuICAgIGF3YWl0IHRoaXMuY29udGV4dC5hdWRpb1dvcmtsZXQuYWRkTW9kdWxlKHVybCk7XG4gICAgdGhpcy5wbGF5YmFjayA9IG5ldyBBdWRpb1dvcmtsZXROb2RlKHRoaXMuY29udGV4dCwgXCJwbGF5YmFja1wiLCB7IG51bWJlck9mSW5wdXRzOiAwLCBvdXRwdXRDaGFubmVsQ291bnQ6IFsyXSB9KTtcbiAgICB0aGlzLnBsYXliYWNrLnBvcnQub25tZXNzYWdlID0gKGUpID0+IHsgdGhpcy5xdWV1ZWQgPSBlLmRhdGEucXVldWVkOyB9O1xuICAgIHRoaXMucGxheWJhY2suY29ubmVjdCh0aGlzLmNvbnRleHQuZGVzdGluYXRpb24pO1xuICB9XG5cbiAgLyoqIFNlY29uZHMgZnJvbSBhIHNhbXBsZSBsZWF2aW5nIHRoZSB3b3JrbGV0IHRvIHRoZSBzcGVha2VyLCBhcyB0aGUgYnJvd3NlciByZWNrb25zIGl0LiAqL1xuICBnZXQgb3V0cHV0TGF0ZW5jeSgpOiBudW1iZXIgfCBudWxsIHtcbiAgICBpZiAoIXRoaXMuY29udGV4dCkgcmV0dXJuIG51bGw7XG4gICAgcmV0dXJuIHRoaXMuY29udGV4dC5iYXNlTGF0ZW5jeSArICgodGhpcy5jb250ZXh0IGFzIEF1ZGlvQ29udGV4dCAmIHsgb3V0cHV0TGF0ZW5jeT86IG51bWJlciB9KS5vdXRwdXRMYXRlbmN5ID8/IDApO1xuICB9XG5cbiAgYXN5bmMgc3RhcnRNaWMob25GcmFtZTogKHBjbTY0OiBzdHJpbmcsIGxldmVsOiBudW1iZXIpID0+IHZvaWQsIG9wdGlvbnM6IE1pY09wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBhd2FpdCB0aGlzLm9wZW4oKTtcbiAgICB0aGlzLnN0b3BNaWMoKTtcbiAgICBjb25zdCBjb250ZXh0ID0gdGhpcy5jb250ZXh0ITtcbiAgICB0aGlzLnN0cmVhbSA9IGF3YWl0IG5hdmlnYXRvci5tZWRpYURldmljZXMuZ2V0VXNlck1lZGlhKHsgYXVkaW86IHsgY2hhbm5lbENvdW50OiAxLCAuLi5vcHRpb25zIH0gfSk7XG4gICAgdGhpcy5zb3VyY2UgPSBjb250ZXh0LmNyZWF0ZU1lZGlhU3RyZWFtU291cmNlKHRoaXMuc3RyZWFtKTtcbiAgICB0aGlzLmNhcHR1cmUgPSBuZXcgQXVkaW9Xb3JrbGV0Tm9kZShjb250ZXh0LCBcImNhcHR1cmVcIiwgeyBudW1iZXJPZk91dHB1dHM6IDAgfSk7XG4gICAgdGhpcy5jYXB0dXJlLnBvcnQub25tZXNzYWdlID0gKGUpID0+IHtcbiAgICAgIGNvbnN0IGZyYW1lID0gbmV3IEludDE2QXJyYXkoZS5kYXRhIGFzIEFycmF5QnVmZmVyKTtcbiAgICAgIGxldCBzdW0gPSAwO1xuICAgICAgZm9yIChjb25zdCBzIG9mIGZyYW1lKSBzdW0gKz0gcyAqIHM7XG4gICAgICB0aGlzLmxldmVsID0gTWF0aC5zcXJ0KHN1bSAvIGZyYW1lLmxlbmd0aCkgLyAzMjc2ODtcbiAgICAgIG9uRnJhbWUoYnl0ZXNUb0Jhc2U2NChuZXcgVWludDhBcnJheShlLmRhdGEgYXMgQXJyYXlCdWZmZXIpKSwgdGhpcy5sZXZlbCk7XG4gICAgfTtcbiAgICB0aGlzLnNvdXJjZS5jb25uZWN0KHRoaXMuY2FwdHVyZSk7XG4gIH1cblxuICBzdG9wTWljKCk6IHZvaWQge1xuICAgIHRoaXMuc291cmNlPy5kaXNjb25uZWN0KCk7XG4gICAgdGhpcy5jYXB0dXJlPy5wb3J0LmNsb3NlKCk7XG4gICAgdGhpcy5zdHJlYW0/LmdldFRyYWNrcygpLmZvckVhY2goKHQpID0+IHQuc3RvcCgpKTtcbiAgICB0aGlzLnNvdXJjZSA9IG51bGw7XG4gICAgdGhpcy5jYXB0dXJlID0gbnVsbDtcbiAgICB0aGlzLnN0cmVhbSA9IG51bGw7XG4gIH1cblxuICBwbGF5KHBjbTY0OiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuY29udGV4dCB8fCAhdGhpcy5wbGF5YmFjaykgcmV0dXJuO1xuICAgIGNvbnN0IHNhbXBsZXMgPSB0b0Zsb2F0cyhiYXNlNjRUb0J5dGVzKHBjbTY0KSwgMjQwMDAsIHRoaXMuY29udGV4dC5zYW1wbGVSYXRlKTtcbiAgICB0aGlzLnBsYXliYWNrLnBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcInBsYXlcIiwgc2FtcGxlcyB9LCBbc2FtcGxlcy5idWZmZXJdKTtcbiAgfVxuXG4gIGN1ZShwY202NDogc3RyaW5nKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLmNvbnRleHQgfHwgIXRoaXMucGxheWJhY2spIHJldHVybjtcbiAgICBjb25zdCBzYW1wbGVzID0gdG9GbG9hdHMoYmFzZTY0VG9CeXRlcyhwY202NCksIDI0MDAwLCB0aGlzLmNvbnRleHQuc2FtcGxlUmF0ZSk7XG4gICAgdGhpcy5wbGF5YmFjay5wb3J0LnBvc3RNZXNzYWdlKHsgdHlwZTogXCJjdWVcIiwgc2FtcGxlcyB9LCBbc2FtcGxlcy5idWZmZXJdKTtcbiAgfVxuXG4gIGZsdXNoKCk6IHZvaWQge1xuICAgIHRoaXMucGxheWJhY2s/LnBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcImZsdXNoXCIgfSk7XG4gIH1cblxuICBzdG9wKCk6IHZvaWQge1xuICAgIHRoaXMuc3RvcE1pYygpO1xuICAgIHRoaXMucGxheWJhY2s/LnBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcInN0b3BcIiB9KTtcbiAgfVxufVxuIiwgIi8vIFRoZSByZXBsYXkgdmlldzogYSByZWNvcmRlZCBjYWxsIChhIHRyYWNlIGZyb20gYW55IGhvc3QsIG9yIGEgc2NlbmFyaW8pIHJ1biBhZ2FpbiB0aHJvdWdoIHRoZVxuLy8gY29yZSwgYXMgdGhlIGJ1aWxkIHRoYXQgcmVjb3JkZWQgaXQgZGlkIGFuZCBhcyB0aGUgbGF0ZXN0IGRvZXMsIHNpZGUgYnkgc2lkZS4gV2hlcmUgdGhleSBwYXJ0XG4vLyBpcyB3aGVyZSBhIGNoYW5nZSBpbiBzcmMvIGNoYW5nZWQgd2hhdCB0aGUgY2FsbCBkb2VzIHdpdGggdGhlIHNhbWUgd29yZHMgYW5kIHRoZSBzYW1lIG1vZGVsLlxuXG5pbnRlcmZhY2UgQ29yZSB7XG4gIHZlcnNpb246IHN0cmluZztcbiAgY3JlYXRlKGNvbmZpZzogc3RyaW5nLCB0OiBudW1iZXIpOiBzdHJpbmc7XG4gIHB1c2goaWQ6IG51bWJlciwgZXZlbnQ6IHN0cmluZyk6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFJlY29yZGluZyB7IHZlcnNpb24/OiBzdHJpbmc7IGNvbmZpZzogdW5rbm93bjsgc3RhcnQ6IG51bWJlcjsgZXZlbnRzOiBSZWNvcmQ8c3RyaW5nLCBhbnk+W10gfVxuXG4vKiogV2hhdCBhIGNvbW1hbmQgb3IgZXZlbnQgbG9va3MgbGlrZSBpbiBhIHRpbWVsaW5lOiBhdWRpbyBjdXQgb3V0LCBvbmUgbGluZS4gKi9cbmZ1bmN0aW9uIGxpbmUobzogUmVjb3JkPHN0cmluZywgYW55Pik6IHN0cmluZyB7XG4gIGNvbnN0IHRleHQgPSBKU09OLnN0cmluZ2lmeShvKS5yZXBsYWNlKC9cIihkYXRhfHBjbSlcIjpcIltBLVphLXowLTkrLz1dezQwLH1cIi9nLCAnXCIkMVwiOlwiXHUyMDI2XCInKVxuICAgIC5yZXBsYWNlKC9cXFxcXCJkYXRhXFxcXFwiOlxcXFxcIltBLVphLXowLTkrLz1dezQwLH1cXFxcXCIvZywgJ1xcXFxcImRhdGFcXFxcXCI6XFxcXFwiXHUyMDI2XFxcXFwiJyk7XG4gIHJldHVybiB0ZXh0Lmxlbmd0aCA+IDQwMCA/IHRleHQuc2xpY2UoMCwgNDAwKSArIFwiXHUyMDI2XCIgOiB0ZXh0O1xufVxuXG4vKiogQXVkaW8gYW5kIHRpY2tzIHNheSBub3RoaW5nIGEgcmVhZGVyIG5lZWRzOyB0aGUgcmVzdCBkb2VzLiAqL1xuZnVuY3Rpb24gdGVsbGluZyhvOiBSZWNvcmQ8c3RyaW5nLCBhbnk+KTogYm9vbGVhbiB7XG4gIGlmIChvLnR5cGUgPT09IFwibWljXCIgfHwgby50eXBlID09PSBcInRpY2tcIiB8fCBvLnR5cGUgPT09IFwicGxheVwiKSByZXR1cm4gZmFsc2U7XG4gIGlmIChvLnR5cGUgPT09IFwid3Muc2VuZFwiICYmIFN0cmluZyhvLmRhdGEpLnN0YXJ0c1dpdGgoJ3tcInJlYWx0aW1lSW5wdXRcIjp7XCJhdWRpb1wiJykpIHJldHVybiBmYWxzZTtcbiAgaWYgKG8udHlwZSA9PT0gXCJ3cy5tZXNzYWdlXCIgJiYgU3RyaW5nKG8uZGF0YSkuaW5jbHVkZXMoJ1wiaW5saW5lRGF0YVwiJykgJiYgIVN0cmluZyhvLmRhdGEpLmluY2x1ZGVzKCdcInR1cm5Db21wbGV0ZVwiJykpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmZ1bmN0aW9uIHJ1bihjb3JlOiBDb3JlLCByOiBSZWNvcmRpbmcpOiBzdHJpbmdbXVtdIHtcbiAgY29uc3QgY3JlYXRlZCA9IEpTT04ucGFyc2UoY29yZS5jcmVhdGUoSlNPTi5zdHJpbmdpZnkoci5jb25maWcpLCByLnN0YXJ0KSk7XG4gIGNvbnN0IG91dDogc3RyaW5nW11bXSA9IFtjcmVhdGVkLmNvbW1hbmRzLmZpbHRlcih0ZWxsaW5nKS5tYXAobGluZSldO1xuICBmb3IgKGNvbnN0IGUgb2Ygci5ldmVudHMpIG91dC5wdXNoKChKU09OLnBhcnNlKGNvcmUucHVzaChjcmVhdGVkLmlkLCBKU09OLnN0cmluZ2lmeShlKSkpIGFzIFJlY29yZDxzdHJpbmcsIGFueT5bXSkuZmlsdGVyKHRlbGxpbmcpLm1hcChsaW5lKSk7XG4gIHJldHVybiBvdXQ7XG59XG5cbmV4cG9ydCBjbGFzcyBSZXBsYXkge1xuICBwcml2YXRlIHJlYWRvbmx5IHJvb3Q6IEhUTUxFbGVtZW50O1xuICBwcml2YXRlIHJlYWRvbmx5IGxvYWQ6ICh1cmw/OiBzdHJpbmcpID0+IFByb21pc2U8Q29yZT47XG5cbiAgY29uc3RydWN0b3Iocm9vdDogSFRNTEVsZW1lbnQsIGxvYWQ6ICh1cmw/OiBzdHJpbmcpID0+IFByb21pc2U8Q29yZT4pIHtcbiAgICB0aGlzLnJvb3QgPSByb290O1xuICAgIHRoaXMubG9hZCA9IGxvYWQ7XG4gICAgcm9vdC5pbm5lckhUTUwgPSBgXG4gICAgICA8ZGl2IGNsYXNzPVwiYmFyXCI+PHNlbGVjdCBjbGFzcz1cInBpY2tcIj48L3NlbGVjdD48YnV0dG9uIGNsYXNzPVwicmVmcmVzaFwiPlx1MjFCQjwvYnV0dG9uPjxidXR0b24gY2xhc3M9XCJnb1wiPlJlcGxheTwvYnV0dG9uPlxuICAgICAgPGxhYmVsPjxpbnB1dCB0eXBlPVwiY2hlY2tib3hcIiBjbGFzcz1cImFsbFwiPiBzaG93IGF1ZGlvIGFuZCB0aWNrczwvbGFiZWw+PHNwYW4gY2xhc3M9XCJzdW1tYXJ5XCI+PC9zcGFuPjwvZGl2PlxuICAgICAgPGRpdiBjbGFzcz1cInRpbWVsaW5lXCI+PC9kaXY+YDtcbiAgICAocm9vdC5xdWVyeVNlbGVjdG9yKFwiLnJlZnJlc2hcIikgYXMgSFRNTEVsZW1lbnQpLm9uY2xpY2sgPSAoKSA9PiB2b2lkIHRoaXMubGlzdCgpO1xuICAgIChyb290LnF1ZXJ5U2VsZWN0b3IoXCIuZ29cIikgYXMgSFRNTEVsZW1lbnQpLm9uY2xpY2sgPSAoKSA9PiB2b2lkIHRoaXMucmVwbGF5KCkuY2F0Y2goKGVycikgPT4gdGhpcy5zYXkoYFJlcGxheSBmYWlsZWQ6ICR7ZXJyLm1lc3NhZ2V9YCkpO1xuICAgIHZvaWQgdGhpcy5saXN0KCk7XG4gIH1cblxuICBwcml2YXRlIHNheSh0ZXh0OiBzdHJpbmcpIHtcbiAgICAodGhpcy5yb290LnF1ZXJ5U2VsZWN0b3IoXCIuc3VtbWFyeVwiKSBhcyBIVE1MRWxlbWVudCkudGV4dENvbnRlbnQgPSB0ZXh0O1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBsaXN0KCkge1xuICAgIGNvbnN0IHBpY2sgPSB0aGlzLnJvb3QucXVlcnlTZWxlY3RvcihcIi5waWNrXCIpIGFzIEhUTUxTZWxlY3RFbGVtZW50O1xuICAgIHBpY2suaW5uZXJIVE1MID0gXCJcIjtcbiAgICBjb25zdCB0cmFjZXM6IHsgbmFtZTogc3RyaW5nOyBieXRlczogbnVtYmVyIH1bXSA9IGF3YWl0IChhd2FpdCBmZXRjaChcIi90cmFjZXNcIikpLmpzb24oKTtcbiAgICBjb25zdCBzY2VuYXJpb3M6IHN0cmluZ1tdID0gYXdhaXQgKGF3YWl0IGZldGNoKFwiL3NjZW5hcmlvc1wiKSkuanNvbigpO1xuICAgIGNvbnN0IHRyYWNlR3JvdXAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwib3B0Z3JvdXBcIik7XG4gICAgdHJhY2VHcm91cC5sYWJlbCA9IFwiUmVjb3JkZWQgY2FsbHNcIjtcbiAgICBmb3IgKGNvbnN0IHQgb2YgdHJhY2VzKSB0cmFjZUdyb3VwLmFwcGVuZChuZXcgT3B0aW9uKGAke3QubmFtZX0gKCR7TWF0aC5yb3VuZCh0LmJ5dGVzIC8gMTAyNCl9IEtCKWAsIGAvdHJhY2VzLyR7dC5uYW1lfWApKTtcbiAgICBjb25zdCBzY2VuYXJpb0dyb3VwID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcIm9wdGdyb3VwXCIpO1xuICAgIHNjZW5hcmlvR3JvdXAubGFiZWwgPSBcIlNjZW5hcmlvc1wiO1xuICAgIGZvciAoY29uc3QgcyBvZiBzY2VuYXJpb3MpIHNjZW5hcmlvR3JvdXAuYXBwZW5kKG5ldyBPcHRpb24ocywgYC9zY2VuYXJpb3MvJHtzfS5qc29uYCkpO1xuICAgIHBpY2suYXBwZW5kKHRyYWNlR3JvdXAsIHNjZW5hcmlvR3JvdXApO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyByZWNvcmRpbmcodXJsOiBzdHJpbmcpOiBQcm9taXNlPFJlY29yZGluZz4ge1xuICAgIGNvbnN0IHRleHQgPSBhd2FpdCAoYXdhaXQgZmV0Y2godXJsLCB7IGNhY2hlOiBcIm5vLXN0b3JlXCIgfSkpLnRleHQoKTtcbiAgICBpZiAodXJsLmVuZHNXaXRoKFwiLmpzb25cIikpIHJldHVybiBKU09OLnBhcnNlKHRleHQpO1xuICAgIGNvbnN0IFtoZWFkZXIsIC4uLmV2ZW50c10gPSB0ZXh0LnRyaW0oKS5zcGxpdChcIlxcblwiKS5tYXAoKGwpID0+IEpTT04ucGFyc2UobCkpO1xuICAgIHJldHVybiB7IC4uLmhlYWRlciwgZXZlbnRzIH07XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHJlcGxheSgpIHtcbiAgICBjb25zdCB1cmwgPSAodGhpcy5yb290LnF1ZXJ5U2VsZWN0b3IoXCIucGlja1wiKSBhcyBIVE1MU2VsZWN0RWxlbWVudCkudmFsdWU7XG4gICAgaWYgKCF1cmwpIHJldHVybjtcbiAgICBjb25zdCByID0gYXdhaXQgdGhpcy5yZWNvcmRpbmcodXJsKTtcbiAgICBjb25zdCBsYXRlc3QgPSBhd2FpdCB0aGlzLmxvYWQoKTtcbiAgICBsZXQgcmVjb3JkZWQ6IENvcmUgfCBudWxsID0gbnVsbDtcbiAgICBpZiAoci52ZXJzaW9uICYmIHIudmVyc2lvbiAhPT0gbGF0ZXN0LnZlcnNpb24pIHtcbiAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goYC92ZXJzaW9ucy8ke3IudmVyc2lvbn0uanNgLCB7IG1ldGhvZDogXCJIRUFEXCIgfSk7XG4gICAgICBpZiAocmVzcG9uc2Uub2spIHJlY29yZGVkID0gYXdhaXQgdGhpcy5sb2FkKGAvdmVyc2lvbnMvJHtyLnZlcnNpb259LmpzYCk7XG4gICAgfVxuICAgIGNvbnN0IG5vdyA9IHJ1bihsYXRlc3QsIHIpO1xuICAgIGNvbnN0IHRoZW4gPSByZWNvcmRlZCA/IHJ1bihyZWNvcmRlZCwgcikgOiBudWxsO1xuICAgIGNvbnN0IGFsbCA9ICh0aGlzLnJvb3QucXVlcnlTZWxlY3RvcihcIi5hbGxcIikgYXMgSFRNTElucHV0RWxlbWVudCkuY2hlY2tlZDtcbiAgICBjb25zdCB0aW1lbGluZSA9IHRoaXMucm9vdC5xdWVyeVNlbGVjdG9yKFwiLnRpbWVsaW5lXCIpIGFzIEhUTUxFbGVtZW50O1xuICAgIHRpbWVsaW5lLmlubmVySFRNTCA9IFwiXCI7XG4gICAgbGV0IGZpcnN0ID0gLTE7XG4gICAgbGV0IGRpZmZlciA9IDA7XG4gICAgY29uc3Qgcm93czogSFRNTEVsZW1lbnRbXSA9IFtdO1xuICAgIGNvbnN0IGFkZCA9IChjbHM6IHN0cmluZywgdDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpID0+IHtcbiAgICAgIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICByb3cuY2xhc3NOYW1lID0gYHJvdyAke2Nsc31gO1xuICAgICAgcm93LmlubmVySFRNTCA9IGA8c3BhbiBjbGFzcz1cInRcIj4ke3R9PC9zcGFuPmA7XG4gICAgICBjb25zdCBiID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gICAgICBiLmNsYXNzTmFtZSA9IFwiYlwiO1xuICAgICAgYi50ZXh0Q29udGVudCA9IHRleHQ7XG4gICAgICByb3cuYXBwZW5kKGIpO1xuICAgICAgdGltZWxpbmUuYXBwZW5kKHJvdyk7XG4gICAgICByb3dzLnB1c2gocm93KTtcbiAgICAgIHJldHVybiByb3c7XG4gICAgfTtcbiAgICBjb25zdCB0MCA9IHIuc3RhcnQ7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPD0gci5ldmVudHMubGVuZ3RoOyBpKyspIHtcbiAgICAgIGNvbnN0IGUgPSBpID09PSAwID8gbnVsbCA6IHIuZXZlbnRzW2kgLSAxXTtcbiAgICAgIGNvbnN0IG5vd091dCA9IG5vd1tpXTtcbiAgICAgIGNvbnN0IHRoZW5PdXQgPSB0aGVuID8gdGhlbltpXSA6IG5vd091dDtcbiAgICAgIGNvbnN0IHNhbWUgPSBub3dPdXQubGVuZ3RoID09PSB0aGVuT3V0Lmxlbmd0aCAmJiBub3dPdXQuZXZlcnkoKGMsIGopID0+IGMgPT09IHRoZW5PdXRbal0pO1xuICAgICAgaWYgKCFzYW1lKSB7IGRpZmZlcisrOyBpZiAoZmlyc3QgPCAwKSBmaXJzdCA9IGk7IH1cbiAgICAgIGlmICghc2FtZSB8fCBhbGwgfHwgKGUgJiYgdGVsbGluZyhlKSkgfHwgbm93T3V0Lmxlbmd0aCA+IDApIHtcbiAgICAgICAgaWYgKGUgJiYgKGFsbCB8fCB0ZWxsaW5nKGUpIHx8ICFzYW1lKSkgYWRkKFwiaW5cIiwgKGUudCAtIHQwKS50b0ZpeGVkKDIpLCBsaW5lKGUpKTtcbiAgICAgICAgY29uc3QgdCA9IGUgPyAoZS50IC0gdDApLnRvRml4ZWQoMikgOiBcIjAuMDBcIjtcbiAgICAgICAgaWYgKHNhbWUpIGZvciAoY29uc3QgYyBvZiBub3dPdXQpIGFkZChcIm91dFwiLCB0LCBjKTtcbiAgICAgICAgZWxzZSB7XG4gICAgICAgICAgZm9yIChjb25zdCBjIG9mIHRoZW5PdXQpIGFkZChcIm91dCBnb25lXCIsIHQsIGBcdTIyMTIgJHtjfWApO1xuICAgICAgICAgIGZvciAoY29uc3QgYyBvZiBub3dPdXQpIGFkZChcIm91dCBuZXdcIiwgdCwgYCsgJHtjfWApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IHZlcnNpb25zID0gdGhlbiA/IGByZWNvcmRlZCBieSAke3IudmVyc2lvbn0sIHJlcGxheWVkIGJ5IGl0IGFuZCBieSAke2xhdGVzdC52ZXJzaW9ufWAgOiBgcmVwbGF5ZWQgYnkgJHtsYXRlc3QudmVyc2lvbn1gICtcbiAgICAgIChyLnZlcnNpb24gJiYgci52ZXJzaW9uICE9PSBsYXRlc3QudmVyc2lvbiA/IGAgKHRoZSByZWNvcmRpbmcncyBidWlsZCAke3IudmVyc2lvbn0gaXNuJ3Qga2VwdCBoZXJlKWAgOiBcIlwiKTtcbiAgICB0aGlzLnNheShgJHtyLmV2ZW50cy5sZW5ndGh9IGV2ZW50cywgJHt2ZXJzaW9uc30uIGAgKyAodGhlbiA/IChkaWZmZXIgPyBgJHtkaWZmZXJ9IGV2ZW50cyBhbnN3ZXJlZCBkaWZmZXJlbnRseSwgdGhlIGZpcnN0IGF0IGV2ZW50ICR7Zmlyc3R9LmAgOiBcIkJvdGggYW5zd2VyZWQgZXZlcnkgZXZlbnQgdGhlIHNhbWUuXCIpIDogXCJcIikpO1xuICAgIGlmIChmaXJzdCA+PSAwKSB0aW1lbGluZS5xdWVyeVNlbGVjdG9yKFwiLmdvbmUsIC5uZXdcIik/LnNjcm9sbEludG9WaWV3KHsgYmxvY2s6IFwiY2VudGVyXCIgfSk7XG4gIH1cbn1cbiIsICIvLyBUaGUgd2ViIHN1cmZhY2U6IGEgZm91cnRoIGhvc3QgZm9yIHRoZSB2b2ljZSBjb3JlLCBhbmQgYSBwaG9uZS1mcmllbmRseSB3YXkgdG8gdXNlIGl0IGZvciB3b3JrLlxuLy8gSXQgbG9hZHMgdGhlIGRldiBzZXJ2ZXIncyBsYXRlc3QgYnVpbGQgYXQgZWFjaCBjYWxsLCBzbyBhbiBlZGl0IGluIHNyYy8gaXMgbGl2ZSBvbiB0aGUgbmV4dFxuLy8gY2FsbCwgYW5kIGtlZXBzIGV2ZXJ5IGNhbGwgYXMgYSB0cmFjZSB0aGUgcmVwbGF5IHZpZXcgKGFuZCBhbnkgb3RoZXIgaG9zdCkgY2FuIHJ1biBhZ2Fpbi5cbi8vXG4vLyBUaGUgaG9zdCdzIHBhcnQgaXMgc21hbGw6IHRoZSBtaWNyb3Bob25lIGFuZCBzcGVha2VyIChhdWRpby50cyksIHRoZSBtb2RlbCdzIHNvY2tldCB0aHJvdWdoIHRoZVxuLy8gc2VydmVyJ3MgcmVsYXksIEhlcm1lcyBhbmQgVDMgdGhyb3VnaCB0aGUgc2VydmVyLCBhbmQgdGhlIHNjcmVlbi4gVGhlIGNvcmUgZGVjaWRlcyB0aGUgcmVzdC5cblxuaW1wb3J0IHsgY29tbWFuZEluIH0gZnJvbSBcIi4uL3NyYy9jb21tYW5kcy50c1wiO1xuaW1wb3J0IHsgQ2FsbEF1ZGlvIH0gZnJvbSBcIi4vYXVkaW8udHNcIjtcbmltcG9ydCB7IFJlcGxheSB9IGZyb20gXCIuL3JlcGxheS50c1wiO1xuXG5pbnRlcmZhY2UgQ29yZSB7XG4gIHZlcnNpb246IHN0cmluZztcbiAgZGVmYXVsdHMoKTogc3RyaW5nO1xuICBjcmVhdGUoY29uZmlnOiBzdHJpbmcsIHQ6IG51bWJlcik6IHN0cmluZztcbiAgcHVzaChpZDogbnVtYmVyLCBldmVudDogc3RyaW5nKTogc3RyaW5nO1xuICB0cmFjZShpZDogbnVtYmVyKTogc3RyaW5nO1xuICBkaXNwb3NlKGlkOiBudW1iZXIpOiB2b2lkO1xufVxudHlwZSBDb21tYW5kID0gUmVjb3JkPHN0cmluZywgYW55PiAmIHsgdHlwZTogc3RyaW5nIH07XG5pbnRlcmZhY2UgU2VydmVyQ29uZmlnIHsgcm91dGU6IHN0cmluZzsgbW9kZWw6IHN0cmluZzsgY2FwdGlvbnNNb2RlbD86IHN0cmluZzsgdmVyc2lvbjogc3RyaW5nOyBoZXJtZXM6IGJvb2xlYW47IHQzOiBzdHJpbmdbXSB8IG51bGwgfVxuXG5jb25zdCAkID0gPFQgZXh0ZW5kcyBIVE1MRWxlbWVudCA9IEhUTUxFbGVtZW50PihpZDogc3RyaW5nKSA9PiBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChpZCkgYXMgVDtcbmNvbnN0IG5vdyA9ICgpID0+IHBlcmZvcm1hbmNlLm5vdygpIC8gMTAwMDtcbmNvbnN0IGNoZWNrZWQgPSAoaWQ6IHN0cmluZykgPT4gJDxIVE1MSW5wdXRFbGVtZW50PihpZCkuY2hlY2tlZDtcblxuLyoqIFRoZSBsYXRlc3QgYnVpbGQgZnJvbSB0aGUgZGV2IHNlcnZlciwgZXZhbHVhdGVkIGFmcmVzaDogYW4gZWRpdCBpbiBzcmMvIGlzIGluIHRoZSBuZXh0IGNhbGwuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbG9hZENvcmUodXJsID0gXCIvdm9pY2UtY29yZS5qc1wiKTogUHJvbWlzZTxDb3JlPiB7XG4gIGNvbnN0IHNvdXJjZSA9IGF3YWl0IChhd2FpdCBmZXRjaCh1cmwsIHsgY2FjaGU6IFwibm8tc3RvcmVcIiB9KSkudGV4dCgpO1xuICBjb25zdCBzY29wZTogeyBWb2ljZUNvcmU/OiBDb3JlIH0gPSB7fTtcbiAgbmV3IEZ1bmN0aW9uKFwiZ2xvYmFsVGhpc1wiLCBzb3VyY2UpKHNjb3BlKTtcbiAgaWYgKCFzY29wZS5Wb2ljZUNvcmUpIHRocm93IG5ldyBFcnJvcihcInRoZSBidW5kbGUgZGlkbid0IGRlZmluZSBWb2ljZUNvcmVcIik7XG4gIHJldHVybiBzY29wZS5Wb2ljZUNvcmU7XG59XG5cbi8vIFByZXNldHM6IGVhY2ggc3VyZmFjZSdzIHNldHRpbmdzIGFzIGl0cyBhcHAgd291bGQgc2V0IHRoZW0uXG5cbmNvbnN0IEZBS0VfVFYgPSBbXG4gIHsgbmFtZTogXCJ0dl92b2x1bWVcIiwgZGVzY3JpcHRpb246IFwiU2V0cyB0aGUgbGl2aW5nLXJvb20gVFYncyB2b2x1bWUsIDAgdG8gMTAwLlwiLCBwYXJhbWV0ZXJzOiB7IHR5cGU6IFwiT0JKRUNUXCIsIHByb3BlcnRpZXM6IHsgbGV2ZWw6IHsgdHlwZTogXCJJTlRFR0VSXCIgfSB9LCByZXF1aXJlZDogW1wibGV2ZWxcIl0gfSB9LFxuICB7IG5hbWU6IFwidHZfcGF1c2VcIiwgZGVzY3JpcHRpb246IFwiUGF1c2VzIG9yIHJlc3VtZXMgd2hhdCdzIHBsYXlpbmcgb24gdGhlIFRWLlwiLCBwYXJhbWV0ZXJzOiB7IHR5cGU6IFwiT0JKRUNUXCIsIHByb3BlcnRpZXM6IHsgcGF1c2U6IHsgdHlwZTogXCJCT09MRUFOXCIgfSB9IH0gfSxcbl07XG5cbmNvbnN0IFBSRVNFVFM6IFJlY29yZDxzdHJpbmcsIFJlY29yZDxzdHJpbmcsIHVua25vd24+PiA9IHtcbiAgd2ViOiB7IHBsYXRmb3JtOiBcIndlYlwiLCBkZXZpY2U6IFwiYnJvd3NlclwiLCBzdGFuZGJ5QWZ0ZXI6IDMwLCBoYW5nVXBBZnRlcjogMzAwLCBoYW5kT2ZmOiBcIm5hbWVkXCIsIHN1cGVydmlzZTogdHJ1ZSwgdm9jYWJ1bGFyeTogW1wiSGVybWVzXCIsIFwiQmVudG9cIiwgXCJXb29kaG91c2VcIiwgXCJUM1wiXSB9LFxuICBhbmRyb2lkOiB7IHBsYXRmb3JtOiBcIkFuZHJvaWRcIiwgZGV2aWNlOiBcInBob25lXCIsIHN0YW5kYnlBZnRlcjogMjAgfSxcbiAgXCJhbmRyb2lkIHdha2Ugd29yZFwiOiB7IHBsYXRmb3JtOiBcIkFuZHJvaWRcIiwgZGV2aWNlOiBcInBob25lXCIsIHN0YW5kYnlBZnRlcjogMjAsIGhhbmdVcEFmdGVyOiAxNSB9LFxuICBtYWNvczogeyBwbGF0Zm9ybTogXCJtYWNPU1wiLCBkZXZpY2U6IFwiTWFjXCIsIHN0YW5kYnlBZnRlcjogMjAgfSxcbiAgZWNobzoge1xuICAgIHBsYXRmb3JtOiBcIkVjaG9cIiwgZGV2aWNlOiBcInNwZWFrZXJcIiwgaGFuZ1VwQWZ0ZXI6IDYsIHN0YW5kYnlBZnRlcjogOCwgZWFyY29uczogdHJ1ZSwgdm9jYWJ1bGFyeTogW1wiSGVybWVzXCIsIFwiQmVudG9cIiwgXCJXb29kaG91c2VcIl0sXG4gICAgbWljOiB7IHdoaWxlU3BlYWtpbmc6IFwid2FrZVwiLCBnYWluRGI6IDAgfSwgaG9zdFRvb2xzOiBGQUtFX1RWLFxuICB9LFxufTtcblxuLy8gU3RhdGUuXG5cbmNvbnN0IGF1ZGlvID0gbmV3IENhbGxBdWRpbygpO1xubGV0IHNlcnZlcjogU2VydmVyQ29uZmlnO1xubGV0IGNvcmU6IENvcmUgfCBudWxsID0gbnVsbDtcbmxldCBjYWxsSWQgPSAwO1xubGV0IGNhbGxOYW1lID0gXCJcIjtcbmxldCB0aWNrZXIgPSAwO1xubGV0IHRyYWNlVGltZXIgPSAwO1xubGV0IHN0YXJ0ZWRBdCA9IG5vdygpO1xuY29uc3Qgc29ja2V0cyA9IG5ldyBNYXA8bnVtYmVyLCBXZWJTb2NrZXQ+KCk7XG4vKiogVGhlIHNvY2tldHMgdG8gdGhlIHRyYW5zY3JpcHRpb24gbW9kZWw6IHRoZWlyIGF1ZGlvIGlzIHRoZSBtb2RlbCdzIGFnYWluLCBzbyBpdCBpc24ndCBjb3VudGVkIG9yIGxvZ2dlZCB0d2ljZS4gKi9cbmNvbnN0IGNhcHRpb25Tb2NrZXRzID0gbmV3IFNldDxudW1iZXI+KCk7XG5jb25zdCBydW5zID0gbmV3IE1hcDxzdHJpbmcsIHsgYWJvcnQ6IEFib3J0Q29udHJvbGxlcjsgYWdlbnQ6IHN0cmluZzsgdGFza0lkOiBzdHJpbmcgfT4oKTtcbmludGVyZmFjZSBUYXNrVmlldyB7IGM6IENvbW1hbmQ7IHNpbmNlOiBudW1iZXI7IGVuZGVkOiBudW1iZXIgfCBudWxsOyB0aHJlYWQ/OiBzdHJpbmc7IHJlc3VsdD86IEhUTUxFbGVtZW50OyBhcHByb3ZhbD86IHsgY29tbWFuZDogc3RyaW5nIH0gfVxuY29uc3QgdGFza3MgPSBuZXcgTWFwPHN0cmluZywgVGFza1ZpZXc+KCk7XG5sZXQgY291bnRzID0geyBtaWM6IDAsIHBsYXk6IDAsIHNlbnQ6IDAgfTtcbmxldCBmYWtlVHZMZXZlbCA9IDE1O1xubGV0IGNvcmVTdGF0dXMgPSBcImlkbGVcIjtcbmxldCBtdXRlZCA9IGZhbHNlO1xubGV0IGhvbGRpbmcgPSBmYWxzZTtcbmxldCB3YWtlTG9jazogeyByZWxlYXNlKCk6IFByb21pc2U8dm9pZD4gfSB8IG51bGwgPSBudWxsO1xuXG4vLyBUaGUgY29udmVyc2F0aW9uLCBrZXB0IHNvIGEgbmV3IGNhbGwgY2FuIGNhcnJ5IG9uIGZyb20gaXQgKHRoZSBjb3JlJ3MgYGhpc3RvcnlgLCByZWNhcHBlZCB0byB0aGUgbW9kZWwpLlxuaW50ZXJmYWNlIENoYXRMaW5lIHsgcm9sZTogXCJ1c2VyXCIgfCBcImFzc2lzdGFudFwiOyBzcGVha2VyPzogc3RyaW5nOyB0ZXh0OiBzdHJpbmcgfVxuY29uc3QgSElTVE9SWSA9IFwidm9pY2UuaGlzdG9yeVwiO1xuY29uc3QgSElTVE9SWV9NQVhfQUdFID0gMTIgKiAzNjAwICogMTAwMDtcbmxldCBjaGF0OiBDaGF0TGluZVtdID0gW107XG4vKiogVGhlIGNvcmUncyBudW1iZXIgZm9yIHRoZSBsaW5lIHRoZSBsYXN0IHdvcmRzIHdlcmUgcmVtZW1iZXJlZCBvbiwgdW50aWwgc29tZXRoaW5nIGVsc2UgaXMuICovXG5sZXQgbGFzdExpbmU6IG51bWJlciB8IG51bGwgPSBudWxsO1xuXG5mdW5jdGlvbiByZW1lbWJlcihyb2xlOiBcInVzZXJcIiB8IFwiYXNzaXN0YW50XCIsIHRleHQ6IHN0cmluZywgc3BlYWtlcj86IHN0cmluZywgam9pbiA9IGZhbHNlKSB7XG4gIGNvbnN0IGxhc3QgPSBjaGF0LmF0KC0xKTtcbiAgaWYgKGpvaW4gJiYgbGFzdCAmJiBsYXN0LnJvbGUgPT09IHJvbGUgJiYgbGFzdC5zcGVha2VyID09PSBzcGVha2VyKSBsYXN0LnRleHQgKz0gdGV4dDtcbiAgZWxzZSBjaGF0LnB1c2goc3BlYWtlciA/IHsgcm9sZSwgc3BlYWtlciwgdGV4dCB9IDogeyByb2xlLCB0ZXh0IH0pO1xuICBpZiAoY2hhdC5sZW5ndGggPiAyMDApIGNoYXQuc3BsaWNlKDAsIGNoYXQubGVuZ3RoIC0gMjAwKTtcbiAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oSElTVE9SWSwgSlNPTi5zdHJpbmdpZnkoeyBhdDogRGF0ZS5ub3coKSwgY2hhdCB9KSk7XG59XG5cbmZ1bmN0aW9uIHNhdmVkSGlzdG9yeSgpOiBDaGF0TGluZVtdIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBzYXZlZCA9IEpTT04ucGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oSElTVE9SWSkgPz8gXCJudWxsXCIpO1xuICAgIHJldHVybiBzYXZlZCAmJiBEYXRlLm5vdygpIC0gc2F2ZWQuYXQgPCBISVNUT1JZX01BWF9BR0UgJiYgQXJyYXkuaXNBcnJheShzYXZlZC5jaGF0KSA/IHNhdmVkLmNoYXQgOiBbXTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG59XG5cbi8qKiBUd28gcmlzaW5nIG5vdGVzOiBzb21ldGhpbmcgb24gdGhlIHNjcmVlbiBuZWVkcyB0aGUgdXNlci4gUENNMTYgYXQgMjQga0h6LCBiYXNlNjQuICovXG5jb25zdCBBUFBST1ZBTF9UT05FID0gKCgpID0+IHtcbiAgY29uc3QgcmF0ZSA9IDI0MDAwLCBvdXQgPSBuZXcgSW50MTZBcnJheShyYXRlICogMC4zMik7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgb3V0Lmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgdCA9IGkgLyByYXRlLCBmID0gdCA8IDAuMTYgPyA2NjAgOiA4ODAsIGxvY2FsID0gdCA8IDAuMTYgPyB0IDogdCAtIDAuMTY7XG4gICAgb3V0W2ldID0gTWF0aC5yb3VuZChNYXRoLnNpbigyICogTWF0aC5QSSAqIGYgKiB0KSAqIE1hdGgubWluKDEsIGxvY2FsICogNjAsICgwLjE2IC0gbG9jYWwpICogNjApICogNjAwMCk7XG4gIH1cbiAgbGV0IGJpbiA9IFwiXCI7XG4gIGNvbnN0IGJ5dGVzID0gbmV3IFVpbnQ4QXJyYXkob3V0LmJ1ZmZlcik7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgYnl0ZXMubGVuZ3RoOyBpKyspIGJpbiArPSBTdHJpbmcuZnJvbUNoYXJDb2RlKGJ5dGVzW2ldKTtcbiAgcmV0dXJuIGJ0b2EoYmluKTtcbn0pKCk7XG5cbi8vIExhdGVuY3k6IHRoZSBuZXR3b3JrJ3Mgcm91bmQgdHJpcCwgYW5kIGhvdyBsb25nIGFmdGVyIHRoZSB1c2VyIHN0b3BzIHRhbGtpbmcgdGhlIHJlcGx5IHN0YXJ0cy5cbmNvbnN0IG1ldHJpY3MgPSB7IHJ0dDogW10gYXMgbnVtYmVyW10sIHJlcGx5OiBbXSBhcyBudW1iZXJbXSwgbGFzdFZvaWNlOiAwLCBsYXN0UGxheTogMCwgcmVwbGllZDogdHJ1ZSB9O1xuXG5mdW5jdGlvbiBtZWRpYW4oeHM6IG51bWJlcltdKTogbnVtYmVyIHwgbnVsbCB7XG4gIGlmICh4cy5sZW5ndGggPT09IDApIHJldHVybiBudWxsO1xuICBjb25zdCBzID0gWy4uLnhzXS5zb3J0KChhLCBiKSA9PiBhIC0gYik7XG4gIHJldHVybiBzW01hdGguZmxvb3Iocy5sZW5ndGggLyAyKV07XG59XG5cbmZ1bmN0aW9uIHNob3dNZXRyaWNzKCkge1xuICBjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgcnR0ID0gbWVkaWFuKG1ldHJpY3MucnR0KTtcbiAgaWYgKHJ0dCAhPSBudWxsKSBwYXJ0cy5wdXNoKGBuZXR3b3JrICR7TWF0aC5yb3VuZChydHQgKiAxMDAwKX0gbXNgKTtcbiAgY29uc3QgcmVwbHkgPSBtZWRpYW4obWV0cmljcy5yZXBseSk7XG4gIGlmIChyZXBseSAhPSBudWxsKSBwYXJ0cy5wdXNoKGByZXBseSAke21ldHJpY3MucmVwbHkuYXQoLTEpIS50b0ZpeGVkKDEpfSBzIChtZWRpYW4gJHtyZXBseS50b0ZpeGVkKDEpfSlgKTtcbiAgY29uc3Qgb3V0ID0gYXVkaW8ub3V0cHV0TGF0ZW5jeTtcbiAgaWYgKG91dCAhPSBudWxsKSBwYXJ0cy5wdXNoKGBhdWRpbyAke01hdGgucm91bmQob3V0ICogMTAwMCl9IG1zYCk7XG4gIGxldCBidWZmZXJlZCA9IDA7XG4gIGZvciAoY29uc3Qgd3Mgb2Ygc29ja2V0cy52YWx1ZXMoKSkgYnVmZmVyZWQgKz0gd3MuYnVmZmVyZWRBbW91bnQ7XG4gIGlmIChidWZmZXJlZCA+IDMyXzAwMCkgcGFydHMucHVzaChgdXBsb2FkIGJlaGluZCAkeyhidWZmZXJlZCAvIDMyXzAwMCkudG9GaXhlZCgxKX0gc2ApO1xuICAkKFwibWV0cmljc1wiKS50ZXh0Q29udGVudCA9IHBhcnRzLmpvaW4oXCIgXHUwMEI3IFwiKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcGluZygpIHtcbiAgY29uc3QgdCA9IG5vdygpO1xuICB0cnkge1xuICAgIGF3YWl0IGZldGNoKFwiL3BpbmdcIiwgeyBjYWNoZTogXCJuby1zdG9yZVwiIH0pO1xuICAgIG1ldHJpY3MucnR0LnB1c2gobm93KCkgLSB0KTtcbiAgICBpZiAobWV0cmljcy5ydHQubGVuZ3RoID4gMTIpIG1ldHJpY3MucnR0LnNoaWZ0KCk7XG4gIH0gY2F0Y2gge31cbiAgc2hvd01ldHJpY3MoKTtcbn1cblxuLy8gVGhlIHNjcmVlbi5cblxuLyoqIEEgc3lzdGVtIG5vdGlmaWNhdGlvbiB3aGlsZSB0aGUgcGFnZSBpcyBoaWRkZW46IGEgdGFzayBmaW5pc2hlZCwgb3Igb25lIG5lZWRzIHRoZSB1c2VyLiAqL1xuZnVuY3Rpb24gbm90aWZ5KHRpdGxlOiBzdHJpbmcsIGJvZHk6IHN0cmluZykge1xuICBpZiAoIWRvY3VtZW50LmhpZGRlbiB8fCAhKFwiTm90aWZpY2F0aW9uXCIgaW4gd2luZG93KSB8fCBOb3RpZmljYXRpb24ucGVybWlzc2lvbiAhPT0gXCJncmFudGVkXCIpIHJldHVybjtcbiAgdHJ5IHtcbiAgICBjb25zdCBuID0gbmV3IE5vdGlmaWNhdGlvbih0aXRsZSwgeyBib2R5OiBib2R5LnNsaWNlKDAsIDE4MCksIGljb246IFwiL3dlYi9pY29ucy9pY29uLTE5Mi5wbmdcIiwgdGFnOiB0aXRsZSB9KTtcbiAgICBuLm9uY2xpY2sgPSAoKSA9PiB7IHdpbmRvdy5mb2N1cygpOyBuLmNsb3NlKCk7IH07XG4gIH0gY2F0Y2gge1xuICAgIC8vIFBob25lcyB3YW50IG5vdGlmaWNhdGlvbnMgZnJvbSBhIHNlcnZpY2Ugd29ya2VyOyB0aGUgcGFnZSBoYXMgbm9uZS5cbiAgfVxufVxuXG5mdW5jdGlvbiB0b2FzdCh0ZXh0OiBzdHJpbmcpIHtcbiAgY29uc3QgdCA9ICQoXCJ0b2FzdFwiKTtcbiAgdC50ZXh0Q29udGVudCA9IHRleHQ7XG4gIHQuY2xhc3NMaXN0LmFkZChcIm9uXCIpO1xuICBjbGVhclRpbWVvdXQoKHRvYXN0IGFzIGFueSkudGltZXIpO1xuICAodG9hc3QgYXMgYW55KS50aW1lciA9IHNldFRpbWVvdXQoKCkgPT4gdC5jbGFzc0xpc3QucmVtb3ZlKFwib25cIiksIDE4MDApO1xufVxuXG5mdW5jdGlvbiBsb2coa2luZDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcsIGNscyA9IFwiXCIpIHtcbiAgY29uc3QgcGFuZSA9ICQoXCJsb2dcIik7XG4gIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvdy5jbGFzc05hbWUgPSBgcm93ICR7Y2xzfWA7XG4gIHJvdy5pbm5lckhUTUwgPSBgPHNwYW4gY2xhc3M9XCJ0XCI+JHsobm93KCkgLSBzdGFydGVkQXQpLnRvRml4ZWQoMil9PC9zcGFuPjxzcGFuIGNsYXNzPVwia1wiPiR7a2luZH08L3NwYW4+YDtcbiAgY29uc3QgYm9keSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBib2R5LmNsYXNzTmFtZSA9IFwiYlwiO1xuICBib2R5LnRleHRDb250ZW50ID0gdGV4dDtcbiAgcm93LmFwcGVuZChib2R5KTtcbiAgY29uc3Qgc3RpY2sgPSBwYW5lLnNjcm9sbFRvcCArIHBhbmUuY2xpZW50SGVpZ2h0ID49IHBhbmUuc2Nyb2xsSGVpZ2h0IC0gMzA7XG4gIHBhbmUuYXBwZW5kKHJvdyk7XG4gIHdoaWxlIChwYW5lLmNoaWxkRWxlbWVudENvdW50ID4gMzAwMCkgcGFuZS5maXJzdEVsZW1lbnRDaGlsZCEucmVtb3ZlKCk7XG4gIGlmIChzdGljaykgcGFuZS5zY3JvbGxUb3AgPSBwYW5lLnNjcm9sbEhlaWdodDtcbn1cblxuLyoqIEEgZnJhbWUgZnJvbSBvciB0byBHZW1pbmksIHdpdGggYXVkaW8gY3V0IG91dCwgc2hvcnQgZW5vdWdoIHRvIHJlYWQuICovXG5mdW5jdGlvbiBicmllZihkYXRhOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gZGF0YS5yZXBsYWNlKC9cImRhdGFcIjpcIltBLVphLXowLTkrLz1dezQwLH1cIi9nLCAobSkgPT4gYFwiZGF0YVwiOlwiXHUyMDI2JHtNYXRoLnJvdW5kKCgobS5sZW5ndGggLSA5KSAqIDMpIC8gNCl9IGJ5dGVzXCJgKS5zbGljZSgwLCA2MDApO1xufVxuXG5mdW5jdGlvbiBlc2NhcGVIdG1sKHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiB0ZXh0LnJlcGxhY2UoL1smPD5cIiddL2csIChjKSA9PiAoeyBcIiZcIjogXCImYW1wO1wiLCBcIjxcIjogXCImbHQ7XCIsIFwiPlwiOiBcIiZndDtcIiwgJ1wiJzogXCImcXVvdDtcIiwgXCInXCI6IFwiJiMzOTtcIiB9KVtjXSEpO1xufVxuXG4vKiogQSBsaXR0bGUgTWFya2Rvd24sIHNhZmVseTogY29kZSwgYm9sZCwgbGlua3MsIGxpc3RzIGFuZCBoZWFkaW5ncywgdGhlIHJlc3QgYXMgdGV4dC4gKi9cbmZ1bmN0aW9uIG1hcmtkb3duKHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGJsb2NrcyA9IGVzY2FwZUh0bWwodGV4dC50cmltKCkpLnNwbGl0KC9gYGAoPzpcXHcrKT9cXG4/Lyk7XG4gIHJldHVybiBibG9ja3MubWFwKChibG9jaywgaSkgPT4ge1xuICAgIGlmIChpICUgMiA9PT0gMSkgcmV0dXJuIGA8cHJlPiR7YmxvY2t9PC9wcmU+YDtcbiAgICBjb25zdCBpbmxpbmUgPSAoczogc3RyaW5nKSA9PiBzXG4gICAgICAucmVwbGFjZSgvYChbXmBcXG5dKylgL2csIFwiPGNvZGU+JDE8L2NvZGU+XCIpXG4gICAgICAucmVwbGFjZSgvXFwqXFwqKFteKlxcbl0rKVxcKlxcKi9nLCBcIjxiPiQxPC9iPlwiKVxuICAgICAgLnJlcGxhY2UoL1xcWyhbXlxcXVxcbl0rKVxcXVxcKChodHRwcz86XFwvXFwvW15cXHMpXSspXFwpL2csICc8YSBocmVmPVwiJDJcIiB0YXJnZXQ9XCJfYmxhbmtcIiByZWw9XCJub29wZW5lclwiPiQxPC9hPicpXG4gICAgICAucmVwbGFjZSgvKF58W1xccyhdKShodHRwcz86XFwvXFwvW15cXHM8KV0rKS9nLCAnJDE8YSBocmVmPVwiJDJcIiB0YXJnZXQ9XCJfYmxhbmtcIiByZWw9XCJub29wZW5lclwiPiQyPC9hPicpO1xuICAgIGxldCBodG1sID0gXCJcIjtcbiAgICBsZXQgbGlzdDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gICAgZm9yIChjb25zdCByYXcgb2YgYmxvY2suc3BsaXQoXCJcXG5cIikpIHtcbiAgICAgIGNvbnN0IGl0ZW0gPSByYXcubWF0Y2goL15cXHMqKD86Wy0qXHUyMDIyXXwoXFxkKylbLildKVxccysoLiopJC8pO1xuICAgICAgaWYgKGl0ZW0pIHtcbiAgICAgICAgY29uc3Qga2luZCA9IGl0ZW1bMV0gPyBcIm9sXCIgOiBcInVsXCI7XG4gICAgICAgIGlmIChsaXN0ICE9PSBraW5kKSB7IGlmIChsaXN0KSBodG1sICs9IGA8LyR7bGlzdH0+YDsgaHRtbCArPSBgPCR7a2luZH0+YDsgbGlzdCA9IGtpbmQ7IH1cbiAgICAgICAgaHRtbCArPSBgPGxpPiR7aW5saW5lKGl0ZW1bMl0pfTwvbGk+YDtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBpZiAobGlzdCkgeyBodG1sICs9IGA8LyR7bGlzdH0+YDsgbGlzdCA9IG51bGw7IH1cbiAgICAgIGNvbnN0IGhlYWRpbmcgPSByYXcubWF0Y2goL14jezEsNn1cXHMrKC4qKSQvKTtcbiAgICAgIGh0bWwgKz0gaGVhZGluZyA/IGA8Yj4ke2lubGluZShoZWFkaW5nWzFdKX08L2I+PGJyPmAgOiByYXcudHJpbSgpID09PSBcIlwiID8gXCI8YnI+XCIgOiBgJHtpbmxpbmUocmF3KX08YnI+YDtcbiAgICB9XG4gICAgaWYgKGxpc3QpIGh0bWwgKz0gYDwvJHtsaXN0fT5gO1xuICAgIHJldHVybiBodG1sO1xuICB9KS5qb2luKFwiXCIpO1xufVxuXG5mdW5jdGlvbiBzY3JvbGxEb3duKGZvcmNlID0gZmFsc2UpIHtcbiAgY29uc3QgcGFuZSA9ICQoXCJ0cmFuc2NyaXB0XCIpO1xuICBpZiAoZm9yY2UgfHwgcGFuZS5zY3JvbGxUb3AgKyBwYW5lLmNsaWVudEhlaWdodCA+PSBwYW5lLnNjcm9sbEhlaWdodCAtIDgwKSBwYW5lLnNjcm9sbFRvcCA9IHBhbmUuc2Nyb2xsSGVpZ2h0O1xufVxuXG4vKiogVGhlIGNvcmUncyBudW1iZXIgZm9yIHRoZSBsaW5lIHRoZSBsYXN0IHJvdyBzaG93cywgdW50aWwgYW5vdGhlciByb3cgZm9sbG93cyBpdC4gKi9cbmxldCBvcGVuTGluZTogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5cbi8qKiBXb3JkcyBnbyBvbiB0aGUgcm93IHRoZSBjb3JlIHNheXMgdGhleSBiZWxvbmcgdG86IGl0IHN0YXJ0cyBhIG5ldyBsaW5lIGZvciBlYWNoIHR1cm4sIGhvd2V2ZXIgbG9uZyB0aGUgZ2FwLiAqL1xuZnVuY3Rpb24gdHJhbnNjcmlwdChyb2xlOiBcInVzZXJcIiB8IFwiYXNzaXN0YW50XCIsIHRleHQ6IHN0cmluZywgbGluZTogbnVtYmVyKSB7XG4gICQoXCJlbXB0eVwiKS5oaWRkZW4gPSB0cnVlO1xuICBjb25zdCBwYW5lID0gJChcInRyYW5zY3JpcHRcIik7XG4gIGNvbnN0IGxhc3QgPSBwYW5lLmxhc3RFbGVtZW50Q2hpbGQgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAob3BlbkxpbmUgPT09IGxpbmUgJiYgbGFzdCAmJiBsYXN0LmRhdGFzZXQucm9sZSA9PT0gcm9sZSkgbGFzdC5xdWVyeVNlbGVjdG9yKFwiLnRleHRcIikhLnRleHRDb250ZW50ICs9IHRleHQ7XG4gIGVsc2Uge1xuICAgIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgcm93LmNsYXNzTmFtZSA9IGBsaW5lICR7cm9sZX1gO1xuICAgIHJvdy5kYXRhc2V0LnJvbGUgPSByb2xlO1xuICAgIHJvdy5pbm5lckhUTUwgPSBgPHNwYW4gY2xhc3M9XCJ3aG9cIj4ke3JvbGUgPT09IFwidXNlclwiID8gXCJZb3VcIiA6IFwiR2VtaW5pXCJ9PC9zcGFuPjxzcGFuIGNsYXNzPVwidGV4dFwiPjwvc3Bhbj5gO1xuICAgIHJvdy5xdWVyeVNlbGVjdG9yKFwiLnRleHRcIikhLnRleHRDb250ZW50ID0gdGV4dC50cmltU3RhcnQoKTtcbiAgICBwYW5lLmFwcGVuZChyb3cpO1xuICAgIG9wZW5MaW5lID0gbGluZTtcbiAgfVxuICBzY3JvbGxEb3duKHJvbGUgPT09IFwidXNlclwiKTtcbn1cblxuLyoqXG4gKiBUaGUgd29yZHMgdGhlIHVzZXIgaXMgc2F5aW5nLCBiZWZvcmUgdGhlIG1vZGVsIGhhcyB0cmFuc2NyaWJlZCB0aGVtOiBhIGZhaW50IHJvdyB0aGF0IHN0YXlzIGxhc3RcbiAqIG9uIHNjcmVlbiAoaXRzIENTUyBgb3JkZXJgKSBhbmQgZmlyc3QgaW4gdGhlIHBhbmUsIHNvIHRoZSBsaW5lcyBhZnRlciBpdCBqb2luIHVwIGFzIGJlZm9yZS5cbiAqL1xuZnVuY3Rpb24gY2FwdGlvbih0ZXh0OiBzdHJpbmcgfCBudWxsKSB7XG4gIGNvbnN0IHBhbmUgPSAkKFwidHJhbnNjcmlwdFwiKTtcbiAgbGV0IHJvdyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwiY2FwdGlvblwiKTtcbiAgaWYgKHRleHQgPT0gbnVsbCkgeyByb3c/LnJlbW92ZSgpOyByZXR1cm47IH1cbiAgJChcImVtcHR5XCIpLmhpZGRlbiA9IHRydWU7XG4gIGlmICghcm93KSB7XG4gICAgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICByb3cuaWQgPSBcImNhcHRpb25cIjtcbiAgICByb3cuY2xhc3NOYW1lID0gXCJsaW5lIHVzZXIgY2FwdGlvblwiO1xuICAgIHJvdy5pbm5lckhUTUwgPSBgPHNwYW4gY2xhc3M9XCJ3aG9cIj5Zb3U8L3NwYW4+PHNwYW4gY2xhc3M9XCJ0ZXh0XCI+PC9zcGFuPmA7XG4gICAgcGFuZS5wcmVwZW5kKHJvdyk7XG4gIH1cbiAgcm93LnF1ZXJ5U2VsZWN0b3IoXCIudGV4dFwiKSEudGV4dENvbnRlbnQgPSB0ZXh0O1xuICBzY3JvbGxEb3duKHRydWUpO1xufVxuXG5mdW5jdGlvbiBub3RlKHRleHQ6IHN0cmluZykge1xuICAkKFwiZW1wdHlcIikuaGlkZGVuID0gdHJ1ZTtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IFwibGluZSBub3RlXCI7XG4gIHJvdy50ZXh0Q29udGVudCA9IHRleHQ7XG4gICQoXCJ0cmFuc2NyaXB0XCIpLmFwcGVuZChyb3cpO1xuICBvcGVuTGluZSA9IG51bGw7XG4gIHNjcm9sbERvd24oKTtcbn1cblxuZnVuY3Rpb24gcmVzdWx0KGFnZW50OiBzdHJpbmcsIGxhYmVsOiBzdHJpbmcsIHRleHQ6IHN0cmluZywgZmFpbGVkID0gZmFsc2UpOiBIVE1MRWxlbWVudCB7XG4gICQoXCJlbXB0eVwiKS5oaWRkZW4gPSB0cnVlO1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gYGxpbmUgcmVzdWx0ICR7YWdlbnQgPT09IFwidDNcIiA/IFwidDNcIiA6IFwiXCJ9YDtcbiAgcm93LmlubmVySFRNTCA9IGA8c3BhbiBjbGFzcz1cIndob1wiPiR7YWdlbnQgPT09IFwidDNcIiA/IFwiVDNcIiA6IFwiSGVybWVzXCJ9IFx1MDBCNyAke2VzY2FwZUh0bWwobGFiZWwpfSR7ZmFpbGVkID8gXCIgXHUwMEI3IGZhaWxlZFwiIDogXCJcIn08L3NwYW4+PGRpdiBjbGFzcz1cImJvZHlcIj4ke21hcmtkb3duKHRleHQpfTwvZGl2PmA7XG4gICQoXCJ0cmFuc2NyaXB0XCIpLmFwcGVuZChyb3cpO1xuICBvcGVuTGluZSA9IG51bGw7XG4gIGNvbnN0IGJvZHkgPSByb3cucXVlcnlTZWxlY3RvcihcIi5ib2R5XCIpIGFzIEhUTUxFbGVtZW50O1xuICByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKCkgPT4ge1xuICAgIGlmIChib2R5LnNjcm9sbEhlaWdodCA+IGJvZHkuY2xpZW50SGVpZ2h0ICsgNCkge1xuICAgICAgY29uc3QgbW9yZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gICAgICBtb3JlLmNsYXNzTmFtZSA9IFwibW9yZVwiO1xuICAgICAgbW9yZS50ZXh0Q29udGVudCA9IFwiU2hvdyBhbGxcIjtcbiAgICAgIG1vcmUub25jbGljayA9ICgpID0+IHsgcm93LmNsYXNzTGlzdC50b2dnbGUoXCJvcGVuXCIpOyBtb3JlLnRleHRDb250ZW50ID0gcm93LmNsYXNzTGlzdC5jb250YWlucyhcIm9wZW5cIikgPyBcIlNob3cgbGVzc1wiIDogXCJTaG93IGFsbFwiOyB9O1xuICAgICAgcm93LmFwcGVuZChtb3JlKTtcbiAgICB9XG4gIH0pO1xuICBzY3JvbGxEb3duKHRydWUpO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBlbGFwc2VkKHNlY29uZHM6IG51bWJlcik6IHN0cmluZyB7XG4gIGlmIChzZWNvbmRzIDwgNjApIHJldHVybiBgJHtNYXRoLmZsb29yKHNlY29uZHMpfSBzYDtcbiAgY29uc3QgbSA9IE1hdGguZmxvb3Ioc2Vjb25kcyAvIDYwKTtcbiAgcmV0dXJuIG0gPCA2MCA/IGAke219IG1pbiAke01hdGguZmxvb3Ioc2Vjb25kcyAlIDYwKX0gc2AgOiBgJHtNYXRoLmZsb29yKG0gLyA2MCl9IGggJHttICUgNjB9IG1pbmA7XG59XG5cbi8qKiBUaGUgZW1wdHkgdGFzayBsaXN0J3Mgd29yZHMsIGtlcHQgdG8gcHV0IGJhY2suICovXG5jb25zdCBub1Rhc2tzID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJub3Rhc2tzXCIpITtcblxuLyoqIFdoZXRoZXIgYSB0YXNrIHN0aWxsIHdhbnRzIHRoZSBzY3JlZW46IGl0J3Mgd29ya2luZywgb3IgaXQgd2FpdHMgZm9yIHRoZSB1c2VyLiBUaGUgcmVzdCBmb2xkIGF3YXkgdW5kZXIgRmluaXNoZWQuICovXG5jb25zdCBsaXZlID0gKHN0YXRlOiBzdHJpbmcpID0+IHN0YXRlID09PSBcInJ1bm5pbmdcIiB8fCBzdGF0ZS5zdGFydHNXaXRoKFwid2FpdGluZ1wiKTtcblxuLyoqIFRoZSBGaW5pc2hlZCBmb2xkJ3MgY291bnQsIGFuZCB0aGUgZm9sZCBpdHNlbGYgb25seSB3aGVuIHNvbWV0aGluZyBpcyBpbiBpdC4gKi9cbmZ1bmN0aW9uIHNob3dEb25lKCkge1xuICBjb25zdCBuID0gJChcImRvbmVub3dcIikuY2hpbGRFbGVtZW50Q291bnQgKyAkKFwiZG9uZWVhcmxpZXJcIikuY2hpbGRFbGVtZW50Q291bnQ7XG4gICQoXCJkb25lYm94XCIpLmhpZGRlbiA9IG4gPT09IDA7XG4gICQoXCJkb25lY291bnRcIikudGV4dENvbnRlbnQgPSBuID4gMCA/IGBcdTAwQjcgJHtufWAgOiBcIlwiO1xufVxuXG5mdW5jdGlvbiBzaG93VGFza3MoZm9yY2UgPSBmYWxzZSkge1xuICBjb25zdCBwYW5lID0gJChcInRhc2tzXCIpO1xuICBjb25zdCBkb25lID0gJChcImRvbmVub3dcIik7XG4gIGNvbnN0IG9wZW4gPSBkb2N1bWVudC5hY3RpdmVFbGVtZW50Py5jbG9zZXN0Py4oXCIudGFza1wiKSBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gIGlmICghZm9yY2UgJiYgb3BlbiAmJiAocGFuZS5jb250YWlucyhvcGVuKSB8fCBkb25lLmNvbnRhaW5zKG9wZW4pKSAmJiBvcGVuLnF1ZXJ5U2VsZWN0b3IoXCJmb3JtXCIpKSByZXR1cm47IC8vIGRvbid0IHJlZHJhdyB1bmRlciBzb21lb25lIHR5cGluZyBhIGZvbGxvdy11cFxuICBwYW5lLmlubmVySFRNTCA9IFwiXCI7XG4gIGRvbmUuaW5uZXJIVE1MID0gXCJcIjtcbiAgY29uc3QgYWxsID0gWy4uLnRhc2tzLnZhbHVlcygpXS5yZXZlcnNlKCk7XG4gIGlmIChhbGwubGVuZ3RoID09PSAwKSB7IHBhbmUuYXBwZW5kKG5vVGFza3MpOyAkKFwidGFza2NvdW50XCIpLnRleHRDb250ZW50ID0gXCJcIjsgc2hvd0RvbmUoKTsgcmV0dXJuOyB9XG4gIGNvbnN0IHJ1bm5pbmcgPSBhbGwuZmlsdGVyKCh0KSA9PiB0LmMuc3RhdGUgPT09IFwicnVubmluZ1wiKS5sZW5ndGg7XG4gICQoXCJ0YXNrY291bnRcIikudGV4dENvbnRlbnQgPSBydW5uaW5nID4gMCA/IGAke3J1bm5pbmd9IHJ1bm5pbmdgIDogXCJcIjtcbiAgJChcImNhbmNlbGFsbFwiKS5oaWRkZW4gPSAhY2FsbElkIHx8IHJ1bm5pbmcgPCAyO1xuICBmb3IgKGNvbnN0IHZpZXcgb2YgYWxsKSB7XG4gICAgY29uc3QgdCA9IHZpZXcuYztcbiAgICBjb25zdCB3YWl0aW5nID0gdC5zdGF0ZS5zdGFydHNXaXRoKFwid2FpdGluZ1wiKTtcbiAgICBjb25zdCBjYXJkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBjYXJkLmNsYXNzTmFtZSA9IGB0YXNrICR7d2FpdGluZyA/IFwid2FpdGluZ1wiIDogdC5zdGF0ZX1gO1xuICAgIGNvbnN0IGFnZSA9ICh2aWV3LmVuZGVkID8/IG5vdygpKSAtIHZpZXcuc2luY2U7XG4gICAgY2FyZC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz1cInRvcFwiPjxzcGFuIGNsYXNzPVwiYmFkZ2UgJHt0LmFnZW50ID09PSBcInQzXCIgPyBcInQzXCIgOiBcIlwifVwiPiR7dC5hZ2VudCA9PT0gXCJ0M1wiID8gXCJUM1wiIDogXCJIZXJtZXNcIn08L3NwYW4+YCArXG4gICAgICBgPHNwYW4gY2xhc3M9XCJsYWJlbFwiPjwvc3Bhbj48c3BhbiBjbGFzcz1cInN0YXRlXCI+JHt0LnN0YXRlID09PSBcInJ1bm5pbmdcIiA/ICc8c3BhbiBjbGFzcz1cInNwaW5cIj48L3NwYW4+ICcgOiBcIlwifSR7ZXNjYXBlSHRtbCh0LnN0YXRlKX0gXHUwMEI3ICR7ZWxhcHNlZChhZ2UpfTwvc3Bhbj48L2Rpdj5gICtcbiAgICAgIGA8ZGl2IGNsYXNzPVwicFwiPjwvZGl2PmA7XG4gICAgY2FyZC5xdWVyeVNlbGVjdG9yKFwiLmxhYmVsXCIpIS50ZXh0Q29udGVudCA9IHQubGFiZWw7XG4gICAgY2FyZC5xdWVyeVNlbGVjdG9yKFwiLnBcIikhLnRleHRDb250ZW50ID0gdC5wcm9ncmVzcyA/PyB0LnJlcXVlc3Q7XG4gICAgaWYgKHQucXVlc3Rpb24pIHtcbiAgICAgIGNvbnN0IHEgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgICAgcS5jbGFzc05hbWUgPSBcInFcIjtcbiAgICAgIHEudGV4dENvbnRlbnQgPSBgQXNrczogJHt0LnF1ZXN0aW9ufWA7XG4gICAgICBjYXJkLmFwcGVuZChxKTtcbiAgICB9XG4gICAgaWYgKHZpZXcuYXBwcm92YWwgJiYgdC5zdGF0ZSA9PT0gXCJydW5uaW5nXCIpIHtcbiAgICAgIGNvbnN0IGJveCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICBib3guY2xhc3NOYW1lID0gXCJhcHByb3ZhbFwiO1xuICAgICAgYm94LmlubmVySFRNTCA9IGA8ZGl2Pkhlcm1lcyBhc2tzIHRvIHJ1bjo8L2Rpdj48Y29kZT48L2NvZGU+PGRpdiBjbGFzcz1cImFjdHNcIj48L2Rpdj5gO1xuICAgICAgYm94LnF1ZXJ5U2VsZWN0b3IoXCJjb2RlXCIpIS50ZXh0Q29udGVudCA9IHZpZXcuYXBwcm92YWwuY29tbWFuZDtcbiAgICAgIGNvbnN0IGFuc3dlciA9IChjaG9pY2U6IFwib25jZVwiIHwgXCJkZW55XCIpID0+IHtcbiAgICAgICAgdmlldy5hcHByb3ZhbCA9IHVuZGVmaW5lZDtcbiAgICAgICAgc2hvd1Rhc2tzKHRydWUpO1xuICAgICAgICB2b2lkIGZldGNoKFwiL2hlcm1lcy9hcHByb3ZhbFwiLCB7IG1ldGhvZDogXCJQT1NUXCIsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgY2FsbDogY2FsbE5hbWUsIHRhc2tJZDogdC5pZCwgY2hvaWNlIH0pIH0pXG4gICAgICAgICAgLnRoZW4oKHIpID0+IHRvYXN0KHIub2sgPyAoY2hvaWNlID09PSBcIm9uY2VcIiA/IFwiQXBwcm92ZWRcIiA6IFwiRGVuaWVkXCIpIDogXCJUaGF0IGFwcHJvdmFsIGhhZCBhbHJlYWR5IGxhcHNlZFwiKSk7XG4gICAgICB9O1xuICAgICAgZm9yIChjb25zdCBbbGFiZWwsIGNob2ljZV0gb2YgW1tcIkFwcHJvdmUgb25jZVwiLCBcIm9uY2VcIl0sIFtcIkRlbnlcIiwgXCJkZW55XCJdXSBhcyBjb25zdCkge1xuICAgICAgICBjb25zdCBiID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgICAgICAgYi50ZXh0Q29udGVudCA9IGxhYmVsO1xuICAgICAgICBpZiAoY2hvaWNlID09PSBcIm9uY2VcIikgYi5jbGFzc05hbWUgPSBcImdvXCI7XG4gICAgICAgIGIub25jbGljayA9ICgpID0+IGFuc3dlcihjaG9pY2UpO1xuICAgICAgICBib3gucXVlcnlTZWxlY3RvcihcIi5hY3RzXCIpIS5hcHBlbmQoYik7XG4gICAgICB9XG4gICAgICBjYXJkLmFwcGVuZChib3gpO1xuICAgIH1cbiAgICBpZiAodC5zdGF0ZSAhPT0gXCJydW5uaW5nXCIpIHZpZXcuYXBwcm92YWwgPSB1bmRlZmluZWQ7XG4gICAgY29uc3QgYWN0cyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgYWN0cy5jbGFzc05hbWUgPSBcImFjdHNcIjtcbiAgICBjb25zdCBidXR0b24gPSAodGV4dDogc3RyaW5nLCBmbjogKCkgPT4gdm9pZCkgPT4geyBjb25zdCBiID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTsgYi50ZXh0Q29udGVudCA9IHRleHQ7IGIub25jbGljayA9IGZuOyBhY3RzLmFwcGVuZChiKTsgcmV0dXJuIGI7IH07XG4gICAgaWYgKGNhbGxJZCkge1xuICAgICAgYnV0dG9uKHdhaXRpbmcgPyBcIkFuc3dlclwiIDogXCJGb2xsb3cgdXBcIiwgKCkgPT4gZm9sbG93VXBGb3JtKGNhcmQsIHQpKTtcbiAgICAgIGlmICh0LnN0YXRlID09PSBcInJ1bm5pbmdcIikgYnV0dG9uKFwiQ2FuY2VsXCIsICgpID0+IHB1c2goeyB0eXBlOiBcImNhbmNlbFRhc2tcIiwgdGFzazogdC5pZCB9KSk7XG4gICAgfVxuICAgIGlmICh2aWV3LnJlc3VsdCkgYnV0dG9uKFwiUmVzdWx0XCIsICgpID0+IHsgdmlldy5yZXN1bHQhLnNjcm9sbEludG9WaWV3KHsgYmVoYXZpb3I6IFwic21vb3RoXCIsIGJsb2NrOiBcImNlbnRlclwiIH0pOyB2aWV3LnJlc3VsdCEuY2xhc3NMaXN0LmFkZChcIm9wZW5cIik7IH0pO1xuICAgIGlmICh2aWV3LnRocmVhZCkgYnV0dG9uKFwiQ29weSB0aHJlYWQgaWRcIiwgKCkgPT4geyB2b2lkIG5hdmlnYXRvci5jbGlwYm9hcmQ/LndyaXRlVGV4dCh2aWV3LnRocmVhZCEpOyB0b2FzdChcIlRocmVhZCBpZCBjb3BpZWRcIik7IH0pO1xuICAgIGlmIChhY3RzLmNoaWxkRWxlbWVudENvdW50KSBjYXJkLmFwcGVuZChhY3RzKTtcbiAgICAobGl2ZSh0LnN0YXRlKSA/IHBhbmUgOiBkb25lKS5hcHBlbmQoY2FyZCk7XG4gIH1cbiAgc2hvd0RvbmUoKTtcbn1cblxuZnVuY3Rpb24gZm9sbG93VXBGb3JtKGNhcmQ6IEhUTUxFbGVtZW50LCB0OiBDb21tYW5kKSB7XG4gIGlmIChjYXJkLnF1ZXJ5U2VsZWN0b3IoXCJmb3JtXCIpKSByZXR1cm47XG4gIGNvbnN0IGZvcm0gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZm9ybVwiKTtcbiAgZm9ybS5pbm5lckhUTUwgPSBgPGlucHV0IHR5cGU9XCJ0ZXh0XCIgcGxhY2Vob2xkZXI9XCJUZWxsIFx1MjAxQyR7ZXNjYXBlSHRtbCh0LmxhYmVsKX1cdTIwMURcdTIwMjZcIiBlbnRlcmtleWhpbnQ9XCJzZW5kXCI+PGJ1dHRvbj5TZW5kPC9idXR0b24+YDtcbiAgY29uc3QgaW5wdXQgPSBmb3JtLnF1ZXJ5U2VsZWN0b3IoXCJpbnB1dFwiKSE7XG4gIGZvcm0ub25zdWJtaXQgPSAoZSkgPT4ge1xuICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICBjb25zdCB0ZXh0ID0gaW5wdXQudmFsdWUudHJpbSgpO1xuICAgIGlmICh0ZXh0KSB7IHB1c2goeyB0eXBlOiBcInN0ZWVyXCIsIHRhc2s6IHQuaWQsIHRleHQgfSk7IG5vdGUoYFlvdSBcdTIxOTIgJHt0LmxhYmVsfTogJHt0ZXh0fWApOyB9XG4gICAgaW5wdXQuYmx1cigpO1xuICAgIGZvcm0ucmVtb3ZlKCk7XG4gICAgc2hvd1Rhc2tzKCk7XG4gIH07XG4gIGlucHV0Lm9ua2V5ZG93biA9IChlKSA9PiB7IGlmIChlLmtleSA9PT0gXCJFc2NhcGVcIikgeyBpbnB1dC5ibHVyKCk7IGZvcm0ucmVtb3ZlKCk7IHNob3dUYXNrcygpOyB9IH07XG4gIGNhcmQuYXBwZW5kKGZvcm0pO1xuICBpbnB1dC5mb2N1cygpO1xufVxuXG4vKiogVDMgdGhyZWFkcyBlYXJsaWVyIGNhbGxzIHN0YXJ0ZWQ6IHRoZXkgY2Fycnkgb24gYWZ0ZXIgYSBjYWxsLCBzbyB0aGUgcGFuZWwgc2F5cyBob3cgdGhleSdyZSBkb2luZy4gKi9cbmFzeW5jIGZ1bmN0aW9uIHNob3dFYXJsaWVyKCkge1xuICBsZXQgbGlzdDogeyB0aHJlYWQ6IHN0cmluZzsgdGl0bGU6IHN0cmluZzsgc3RhdHVzOiBzdHJpbmc7IGJyYW5jaDogc3RyaW5nIHwgbnVsbDsgcHI6IHN0cmluZyB8IG51bGw7IHVwZGF0ZWQ6IHN0cmluZzsgbGFzdDogc3RyaW5nOyB3YWl0aW5nOiBib29sZWFuIH1bXSA9IFtdO1xuICB0cnkgeyBsaXN0ID0gYXdhaXQgKGF3YWl0IGZldGNoKFwiL2FnZW50L3JlY2VudFwiLCB7IGNhY2hlOiBcIm5vLXN0b3JlXCIgfSkpLmpzb24oKTsgfSBjYXRjaCB7fVxuICBjb25zdCBjdXJyZW50ID0gbmV3IFNldChbLi4udGFza3MudmFsdWVzKCldLm1hcCgodikgPT4gdi50aHJlYWQpLmZpbHRlcihCb29sZWFuKSk7XG4gIGxpc3QgPSBsaXN0LmZpbHRlcigodCkgPT4gIWN1cnJlbnQuaGFzKHQudGhyZWFkKSk7XG4gIGNvbnN0IHBhbmUgPSAkKFwiZWFybGllclwiKTtcbiAgY29uc3QgZG9uZSA9ICQoXCJkb25lZWFybGllclwiKTtcbiAgcGFuZS5pbm5lckhUTUwgPSBcIlwiO1xuICBkb25lLmlubmVySFRNTCA9IFwiXCI7XG4gIGZvciAoY29uc3QgdCBvZiBsaXN0KSB7XG4gICAgY29uc3QgY2FyZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgY29uc3Qgc3RhdGUgPSB0LndhaXRpbmcgPyBcIndhaXRpbmcgZm9yIGFwcHJvdmFsIGluIFQzXCIgOiB0LnN0YXR1cztcbiAgICBjYXJkLmNsYXNzTmFtZSA9IGB0YXNrICR7dC5zdGF0dXMgPT09IFwicnVubmluZ1wiID8gXCJydW5uaW5nXCIgOiB0LndhaXRpbmcgPyBcIndhaXRpbmdcIiA6IFwiZmluaXNoZWRcIn1gO1xuICAgIGNvbnN0IGFnbyA9IE1hdGgubWF4KDAsIChEYXRlLm5vdygpIC0gRGF0ZS5wYXJzZSh0LnVwZGF0ZWQpKSAvIDEwMDApO1xuICAgIGNhcmQuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9XCJ0b3BcIj48c3BhbiBjbGFzcz1cImJhZGdlIHQzXCI+VDM8L3NwYW4+PHNwYW4gY2xhc3M9XCJsYWJlbFwiPjwvc3Bhbj5gICtcbiAgICAgIGA8c3BhbiBjbGFzcz1cInN0YXRlXCI+JHt0LnN0YXR1cyA9PT0gXCJydW5uaW5nXCIgPyAnPHNwYW4gY2xhc3M9XCJzcGluXCI+PC9zcGFuPiAnIDogXCJcIn0ke2VzY2FwZUh0bWwoc3RhdGUpfSBcdTAwQjcgJHtlbGFwc2VkKGFnbyl9IGFnbzwvc3Bhbj48L2Rpdj48ZGl2IGNsYXNzPVwicFwiPjwvZGl2PmA7XG4gICAgY2FyZC5xdWVyeVNlbGVjdG9yKFwiLmxhYmVsXCIpIS50ZXh0Q29udGVudCA9IHQudGl0bGU7XG4gICAgY2FyZC5xdWVyeVNlbGVjdG9yKFwiLnBcIikhLnRleHRDb250ZW50ID0gdC5sYXN0IHx8ICh0LmJyYW5jaCA/IGBPbiAke3QuYnJhbmNofWAgOiBcIlwiKTtcbiAgICBjb25zdCBhY3RzID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBhY3RzLmNsYXNzTmFtZSA9IFwiYWN0c1wiO1xuICAgIGlmICh0LnByKSB7IGNvbnN0IGEgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYVwiKTsgYS5ocmVmID0gdC5wcjsgYS50YXJnZXQgPSBcIl9ibGFua1wiOyBhLnJlbCA9IFwibm9vcGVuZXJcIjsgYS50ZXh0Q29udGVudCA9IFwiUHVsbCByZXF1ZXN0XCI7IGFjdHMuYXBwZW5kKGEpOyB9XG4gICAgY29uc3QgY29weSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gICAgY29weS50ZXh0Q29udGVudCA9IFwiQ29weSB0aHJlYWQgaWRcIjtcbiAgICBjb3B5Lm9uY2xpY2sgPSAoKSA9PiB7IHZvaWQgbmF2aWdhdG9yLmNsaXBib2FyZD8ud3JpdGVUZXh0KHQudGhyZWFkKTsgdG9hc3QoXCJUaHJlYWQgaWQgY29waWVkXCIpOyB9O1xuICAgIGFjdHMuYXBwZW5kKGNvcHkpO1xuICAgIGNhcmQuYXBwZW5kKGFjdHMpO1xuICAgICh0LnN0YXR1cyA9PT0gXCJydW5uaW5nXCIgfHwgdC53YWl0aW5nID8gcGFuZSA6IGRvbmUpLmFwcGVuZChjYXJkKTtcbiAgfVxuICAkKFwiZWFybGllcmJveFwiKS5oaWRkZW4gPSBwYW5lLmNoaWxkRWxlbWVudENvdW50ID09PSAwO1xuICBzaG93RG9uZSgpO1xufVxuXG5jb25zdCBTVEFUVVNfVEVYVDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgaWRsZTogXCJJZGxlXCIsIGNvbm5lY3Rpbmc6IFwiQ29ubmVjdGluZ1x1MjAyNlwiLCBsaXN0ZW5pbmc6IFwiTGlzdGVuaW5nXCIsIHdvcmtpbmc6IFwiTGlzdGVuaW5nIFx1MDBCNyB0YXNrcyBydW5uaW5nXCIsXG4gIHN0YW5kYnk6IFwiUGF1c2VkIHdoaWxlIHRhc2tzIHJ1biBcdTAwQjcgc3BlYWsgdG8gcmVzdW1lXCIsIHdha2luZzogXCJSZXN1bWluZ1x1MjAyNlwiLCBlbmRlZDogXCJFbmRlZFwiLFxufTtcblxuZnVuY3Rpb24gc2hvd1N0YXR1cyhtZXNzYWdlPzogc3RyaW5nKSB7XG4gIGNvbnN0IHNwZWFraW5nID0gY2FsbElkICYmIGNvcmVTdGF0dXMgIT09IFwic3RhbmRieVwiICYmIGF1ZGlvLnF1ZXVlZCA+IDAuMDU7XG4gIGNvbnN0IHNob3duID0gc3BlYWtpbmcgPyBcInNwZWFraW5nXCIgOiBjb3JlU3RhdHVzO1xuICAkKFwic3RhdHVzXCIpLmNsYXNzTmFtZSA9IHNob3duO1xuICBsZXQgdGV4dCA9IHNwZWFraW5nID8gXCJTcGVha2luZ1wiIDogU1RBVFVTX1RFWFRbY29yZVN0YXR1c10gPz8gY29yZVN0YXR1cztcbiAgaWYgKGNhbGxJZCAmJiBtdXRlZCAmJiAhaG9sZGluZyAmJiAhc3BlYWtpbmcpIHRleHQgKz0gXCIgXHUwMEI3IG11dGVkXCI7XG4gIGlmIChob2xkaW5nKSB0ZXh0ID0gXCJUYWxraW5nIChob2xkKVwiO1xuICBpZiAobWVzc2FnZSkgdGV4dCA9IGAke3RleHR9OiAke21lc3NhZ2V9YDtcbiAgaWYgKGNvcmVTdGF0dXMgIT09IFwiZW5kZWRcIiB8fCBtZXNzYWdlKSAkKFwic3RhdHVzdGV4dFwiKS50ZXh0Q29udGVudCA9IHRleHQ7XG4gICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiaHVzaFwiKS5jbGFzc0xpc3QudG9nZ2xlKFwibGl2ZVwiLCBCb29sZWFuKHNwZWFraW5nKSk7XG59XG5cbi8vIFRoZSBjYWxsLlxuXG5mdW5jdGlvbiBwdXNoKGV2ZW50OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikge1xuICBpZiAoIWNvcmUgfHwgIWNhbGxJZCkgcmV0dXJuO1xuICBjb25zdCBlOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgLi4uZXZlbnQsIHQ6IG5vdygpIH07XG4gIGNvbnN0IHF1aWV0ID0gZS50eXBlID09PSBcIm1pY1wiIHx8IGUudHlwZSA9PT0gXCJ0aWNrXCI7XG4gIGlmICghcXVpZXQpIGxvZyhcImluXCIsIGUudHlwZSA9PT0gXCJ3cy5tZXNzYWdlXCIgPyBgd3MgJHtlLnNpZH0gXHUyMTkwICR7YnJpZWYoU3RyaW5nKGUuZGF0YSkpfWAgOiBKU09OLnN0cmluZ2lmeShlKS5zbGljZSgwLCA0MDApLCBcImluXCIpO1xuICBydW4oSlNPTi5wYXJzZShjb3JlLnB1c2goY2FsbElkLCBKU09OLnN0cmluZ2lmeShlKSkpKTtcbn1cblxuZnVuY3Rpb24gcnVuKGNvbW1hbmRzOiBDb21tYW5kW10pIHtcbiAgZm9yIChjb25zdCBjIG9mIGNvbW1hbmRzKSB7XG4gICAgc3dpdGNoIChjLnR5cGUpIHtcbiAgICAgIGNhc2UgXCJ3cy5jb25uZWN0XCI6IGNvbm5lY3QoYy5zaWQsIGMucHVycG9zZSA9PT0gXCJjYXB0aW9uc1wiKTsgYnJlYWs7XG4gICAgICBjYXNlIFwid3Muc2VuZFwiOiB7XG4gICAgICAgIHNvY2tldHMuZ2V0KGMuc2lkKT8uc2VuZChjLmRhdGEpO1xuICAgICAgICBpZiAoIWMuZGF0YS5zdGFydHNXaXRoKCd7XCJyZWFsdGltZUlucHV0XCI6e1wiYXVkaW9cIicpKSBsb2coXCJvdXRcIiwgYHdzICR7Yy5zaWR9IFx1MjE5MiAke2JyaWVmKGMuZGF0YSl9YCwgXCJvdXRcIik7XG4gICAgICAgIGVsc2UgaWYgKCFjYXB0aW9uU29ja2V0cy5oYXMoYy5zaWQpKSBjb3VudHMuc2VudCsrO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ3cy5jbG9zZVwiOiBzb2NrZXRzLmdldChjLnNpZCk/LmNsb3NlKCk7IHNvY2tldHMuZGVsZXRlKGMuc2lkKTsgbG9nKFwib3V0XCIsIGB3cyAke2Muc2lkfSBjbG9zZWAsIFwib3V0XCIpOyBicmVhaztcbiAgICAgIGNhc2UgXCJtaWMuc3RhcnRcIjpcbiAgICAgIGNhc2UgXCJtaWMucmVzdGFydFwiOlxuICAgICAgICBsb2coXCJvdXRcIiwgYy50eXBlLCBcIm91dFwiKTtcbiAgICAgICAgdm9pZCBhdWRpby5zdGFydE1pYyhvbk1pYywgbWljT3B0aW9ucygpKS5jYXRjaCgoZXJyKSA9PiB7IGxvZyhcImVycm9yXCIsIGBtaWNyb3Bob25lOiAke2Vyci5tZXNzYWdlfWAsIFwiZXJyXCIpOyB0b2FzdChgTWljcm9waG9uZTogJHtlcnIubWVzc2FnZX1gKTsgfSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcIm1pYy5zdG9wXCI6IGF1ZGlvLnN0b3BNaWMoKTsgYnJlYWs7XG4gICAgICBjYXNlIFwicGxheVwiOiB7XG4gICAgICAgIGNvbnN0IHQgPSBub3coKTtcbiAgICAgICAgLy8gQSByZXBseSBzdGFydGluZzogZnJvbSB0aGUgZW5kIG9mIHRoZSB1c2VyJ3Mgc3BlZWNoIHRvIGl0cyBmaXJzdCBzb3VuZC5cbiAgICAgICAgaWYgKCFtZXRyaWNzLnJlcGxpZWQgJiYgYXVkaW8ucXVldWVkIDwgMC4wNSAmJiB0IC0gbWV0cmljcy5sYXN0UGxheSA+IDAuNiAmJiBtZXRyaWNzLmxhc3RWb2ljZSA+IDAgJiYgdCAtIG1ldHJpY3MubGFzdFZvaWNlIDwgMTApIHtcbiAgICAgICAgICBtZXRyaWNzLnJlcGx5LnB1c2godCAtIG1ldHJpY3MubGFzdFZvaWNlKTtcbiAgICAgICAgICBpZiAobWV0cmljcy5yZXBseS5sZW5ndGggPiAyMCkgbWV0cmljcy5yZXBseS5zaGlmdCgpO1xuICAgICAgICAgIG1ldHJpY3MucmVwbGllZCA9IHRydWU7XG4gICAgICAgICAgc2hvd01ldHJpY3MoKTtcbiAgICAgICAgfVxuICAgICAgICBtZXRyaWNzLmxhc3RQbGF5ID0gdDtcbiAgICAgICAgYXVkaW8ucGxheShjLnBjbSk7XG4gICAgICAgIGNvdW50cy5wbGF5Kys7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcImZsdXNoXCI6IGF1ZGlvLmZsdXNoKCk7IGxvZyhcIm91dFwiLCBcImZsdXNoXCIsIFwib3V0XCIpOyBicmVhaztcbiAgICAgIGNhc2UgXCJjdWVcIjpcbiAgICAgICAgYXVkaW8uY3VlKGMucGNtKTtcbiAgICAgICAgbG9nKFwib3V0XCIsIGBjdWUgJHtjLmVhcmNvbn1gLCBcIm91dFwiKTtcbiAgICAgICAgLy8gQSByZXF1ZXN0IHRoYXQgYmVjYW1lIGEgdGFzayBnZXRzIGEgdG9uZSwgbm90IGEgc3Bva2VuIHJlcGx5OiBub3RoaW5nIHRvIHRpbWUuXG4gICAgICAgIGlmIChjLmVhcmNvbiA9PT0gXCJ0YXNrU3RhcnRlZFwiKSBtZXRyaWNzLnJlcGxpZWQgPSB0cnVlO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJ3YWtld29yZFwiOiBsb2coXCJvdXRcIiwgYHdha2Ugd29yZCAke2Mub24gPyBcImxpc3RlbmluZ1wiIDogXCJvZmZcIn1gLCBcIm91dFwiKTsgYnJlYWs7XG4gICAgICBjYXNlIFwidG9vbC5jYWxsXCI6IHZvaWQgdG9vbChjKTsgYnJlYWs7XG4gICAgICBjYXNlIFwidG9vbC5jYW5jZWxcIjogY2FuY2VsUnVuKGMucnVuLCBjLnJlYXNvbik7IGJyZWFrO1xuICAgICAgY2FzZSBcInRvb2wuc3RlZXJcIjogdm9pZCBzdGVlclJ1bihjKTsgYnJlYWs7XG4gICAgICBjYXNlIFwic3RhdHVzXCI6XG4gICAgICAgIGNvcmVTdGF0dXMgPSBjLnN0YXR1cztcbiAgICAgICAgc2hvd1N0YXR1cyhjLnN0YXR1cyA9PT0gXCJlbmRlZFwiID8gYy5tZXNzYWdlID8/IHVuZGVmaW5lZCA6IHVuZGVmaW5lZCk7XG4gICAgICAgIGxvZyhcInN0YXR1c1wiLCBjLnN0YXR1cyArIChjLm1lc3NhZ2UgPyBgOiAke2MubWVzc2FnZX1gIDogXCJcIiksIFwic3RhdHVzXCIpO1xuICAgICAgICBpZiAoYy5zdGF0dXMgPT09IFwiZW5kZWRcIikgeyBpZiAoYy5tZXNzYWdlKSBub3RlKGMubWVzc2FnZSk7IGVuZCgpOyB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcImNhcHRpb25cIjogY2FwdGlvbihjLnRleHQpOyBicmVhaztcbiAgICAgIGNhc2UgXCJ0cmFuc2NyaXB0XCI6XG4gICAgICAgIHRyYW5zY3JpcHQoYy5yb2xlLCBjLnRleHQsIGMubGluZSk7XG4gICAgICAgIHJlbWVtYmVyKGMucm9sZSwgYy50ZXh0LCBjLnJvbGUgPT09IFwiYXNzaXN0YW50XCIgPyBcIkdlbWluaVwiIDogdW5kZWZpbmVkLCBsYXN0TGluZSA9PT0gYy5saW5lKTtcbiAgICAgICAgbGFzdExpbmUgPSBjLmxpbmU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcInRhc2tcIjoge1xuICAgICAgICBjb25zdCB2aWV3ID0gdGFza3MuZ2V0KGMuaWQpID8/IHsgYywgc2luY2U6IG5vdygpLCBlbmRlZDogbnVsbCB9O1xuICAgICAgICBpZiAoYy5zdGF0ZSA9PT0gXCJydW5uaW5nXCIgJiYgdmlldy5jLnN0YXRlICE9PSBcInJ1bm5pbmdcIikgeyB2aWV3LnNpbmNlID0gbm93KCk7IHZpZXcuZW5kZWQgPSBudWxsOyB9XG4gICAgICAgIGlmIChjLnN0YXRlICE9PSBcInJ1bm5pbmdcIiAmJiB2aWV3LmVuZGVkID09IG51bGwpIHZpZXcuZW5kZWQgPSBub3coKTtcbiAgICAgICAgdmlldy5jID0gYztcbiAgICAgICAgdGFza3Muc2V0KGMuaWQsIHZpZXcpO1xuICAgICAgICBzaG93VGFza3MoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwicXVlc3Rpb25zXCI6IGJyZWFrO1xuICAgICAgY2FzZSBcIm1pY1NpbGVudFwiOiAkKFwibWljd2FyblwiKS5oaWRkZW4gPSAhYy5zaWxlbnQ7IGJyZWFrO1xuICAgICAgY2FzZSBcInZvaWNlQ29tbWFuZFwiOlxuICAgICAgICB0b2FzdChgSGVhcmQgXHUyMDFDJHtjLmhlYXJkfVx1MjAxRDogJHtjLmNvbW1hbmQgPT09IFwic3RvcFwiID8gXCJzdG9wcGVkXCIgOiBjLmNvbW1hbmQgPT09IFwiY2FuY2VsQWxsXCIgPyBcImNhbmNlbGxpbmcgZXZlcnkgdGFza1wiIDogXCJoYW5naW5nIHVwXCJ9YCk7XG4gICAgICAgIGxvZyhcIm91dFwiLCBgdm9pY2UgY29tbWFuZCAke2MuY29tbWFuZH06ICR7Yy5oZWFyZH1gLCBcIm91dFwiKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwibG9nXCI6IGxvZyhjLmxldmVsLCBjLm1lc3NhZ2UsIGMubGV2ZWwgPT09IFwid2FyblwiID8gXCJ3YXJuXCIgOiBcIlwiKTsgYnJlYWs7XG4gICAgICBkZWZhdWx0OiBsb2coXCJvdXRcIiwgSlNPTi5zdHJpbmdpZnkoYykuc2xpY2UoMCwgMzAwKSwgXCJvdXRcIik7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIG9uTWljKHBjbTogc3RyaW5nLCBsZXZlbDogbnVtYmVyKSB7XG4gIGNvdW50cy5taWMrKztcbiAgaWYgKGxldmVsID4gMC4wMyAmJiAhKG11dGVkICYmICFob2xkaW5nKSkge1xuICAgIG1ldHJpY3MubGFzdFZvaWNlID0gbm93KCk7XG4gICAgaWYgKGF1ZGlvLnF1ZXVlZCA8IDAuMDUpIG1ldHJpY3MucmVwbGllZCA9IGZhbHNlO1xuICB9XG4gIHB1c2goeyB0eXBlOiBcIm1pY1wiLCBwY20gfSk7XG59XG5cbmZ1bmN0aW9uIGNvbm5lY3Qoc2lkOiBudW1iZXIsIGNhcHRpb25zOiBib29sZWFuKSB7XG4gIGNvbnN0IHdzID0gbmV3IFdlYlNvY2tldChgJHtsb2NhdGlvbi5wcm90b2NvbCA9PT0gXCJodHRwczpcIiA/IFwid3NzXCIgOiBcIndzXCJ9Oi8vJHtsb2NhdGlvbi5ob3N0fS9saXZlJHtjYXB0aW9ucyA/IFwiP2Zvcj1jYXB0aW9uc1wiIDogXCJcIn1gKTtcbiAgc29ja2V0cy5zZXQoc2lkLCB3cyk7XG4gIGlmIChjYXB0aW9ucykgY2FwdGlvblNvY2tldHMuYWRkKHNpZCk7XG4gIGxvZyhcIm91dFwiLCBgd3MgJHtzaWR9IGNvbm5lY3QgKCR7c2VydmVyLnJvdXRlfSR7Y2FwdGlvbnMgPyBcIiwgY2FwdGlvbnNcIiA6IFwiXCJ9KWAsIFwib3V0XCIpO1xuICB3cy5vbm9wZW4gPSAoKSA9PiBwdXNoKHsgdHlwZTogXCJ3cy5vcGVuXCIsIHNpZCB9KTtcbiAgd3Mub25tZXNzYWdlID0gKG0pID0+IHB1c2goeyB0eXBlOiBcIndzLm1lc3NhZ2VcIiwgc2lkLCBkYXRhOiB0eXBlb2YgbS5kYXRhID09PSBcInN0cmluZ1wiID8gbS5kYXRhIDogXCJcIiB9KTtcbiAgd3Mub25jbG9zZSA9IChlKSA9PiB7XG4gICAgaWYgKHNvY2tldHMuZ2V0KHNpZCkgIT09IHdzICYmIHNvY2tldHMuaGFzKHNpZCkpIHJldHVybjtcbiAgICBjb25zdCBodHRwU3RhdHVzID0gZS5jb2RlID49IDQxMDAgJiYgZS5jb2RlIDwgNDYwMCA/IGUuY29kZSAtIDQwMDAgOiB1bmRlZmluZWQ7XG4gICAgcHVzaCh7IHR5cGU6IFwid3MuY2xvc2VkXCIsIHNpZCwgY29kZTogaHR0cFN0YXR1cyA/IHVuZGVmaW5lZCA6IGUuY29kZSwgcmVhc29uOiBlLnJlYXNvbiwgaHR0cFN0YXR1cyB9KTtcbiAgfTtcbn1cblxuZnVuY3Rpb24gY2FuY2VsUnVuKGtleTogc3RyaW5nLCByZWFzb246IHN0cmluZykge1xuICBjb25zdCByID0gcnVucy5nZXQoa2V5KTtcbiAgbG9nKFwib3V0XCIsIGBjYW5jZWwgJHtrZXl9ICgke3JlYXNvbn0pYCwgXCJvdXRcIik7XG4gIGlmICghcikgcmV0dXJuO1xuICBydW5zLmRlbGV0ZShrZXkpO1xuICByLmFib3J0LmFib3J0KCk7XG4gIC8vIENhbmNlbGxlZCBvbiBwdXJwb3NlOiB0aGUgYWdlbnQgc3RvcHMgdG9vLiBBIGNhbGwgdGhhdCBlbmRlZCBsZWF2ZXMgYSBjb2RpbmcgYWdlbnQgd29ya2luZyBpbiBUMy5cbiAgaWYgKHJlYXNvbiA9PT0gXCJjYW5jZWxsZWRcIiAmJiAhY2hlY2tlZChcImZha2VoZXJtZXNcIikpIHtcbiAgICB2b2lkIGZldGNoKHIuYWdlbnQgPT09IFwidDNcIiA/IFwiL2FnZW50L2NhbmNlbFwiIDogXCIvaGVybWVzL3N0b3BcIiwgeyBtZXRob2Q6IFwiUE9TVFwiLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGNhbGw6IGNhbGxOYW1lLCB0YXNrSWQ6IHIudGFza0lkIH0pIH0pO1xuICB9XG59XG5cbi8qKiBNb3JlIGZvciBhIHJ1bm5pbmcgdGFzaywgaW50byBpdHMgY3VycmVudCBydW47IGlmIHRoZSBhZ2VudCB3b24ndCB0YWtlIGl0LCB0aGUgY29yZSBxdWV1ZXMgaXQgaW5zdGVhZC4gKi9cbmFzeW5jIGZ1bmN0aW9uIHN0ZWVyUnVuKGM6IENvbW1hbmQpIHtcbiAgY29uc3QgciA9IHJ1bnMuZ2V0KGMucnVuKTtcbiAgbG9nKFwib3V0XCIsIGBzdGVlciAke2MucnVufTogJHtjLnRleHR9YCwgXCJvdXRcIik7XG4gIGlmIChjaGVja2VkKFwiZmFrZWhlcm1lc1wiKSkgcmV0dXJuO1xuICBjb25zdCBvayA9IHIgIT0gbnVsbCAmJlxuICAgIChhd2FpdCBmZXRjaChjLmFnZW50ID09PSBcInQzXCIgPyBcIi9hZ2VudC9zdGVlclwiIDogXCIvaGVybWVzL3N0ZWVyXCIsIHsgbWV0aG9kOiBcIlBPU1RcIiwgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBjYWxsOiBjYWxsTmFtZSwgdGFza0lkOiByLnRhc2tJZCwgdGV4dDogYy5tZXNzYWdlIH0pIH0pLnRoZW4oKHgpID0+IHgub2ssICgpID0+IGZhbHNlKSk7XG4gIGlmICghb2spIHB1c2goeyB0eXBlOiBcInRvb2wuc3RlZXJGYWlsZWRcIiwgcnVuOiBjLnJ1biwgdGV4dDogYy50ZXh0IH0pO1xuICBlbHNlIHRvYXN0KGAke2MuYWdlbnQgPT09IFwidDNcIiA/IFwiVGhlIGNvZGluZyBhZ2VudFwiIDogXCJIZXJtZXNcIn0gdG9vayB0aGUgZm9sbG93LXVwIHdoaWxlIGl0IHdvcmtzYCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHRvb2woYzogQ29tbWFuZCkge1xuICBpZiAoYy5raW5kID09PSBcImhvc3RcIikge1xuICAgIGxvZyhcIm91dFwiLCBgaG9zdCB0b29sICR7Yy5uYW1lfSAke0pTT04uc3RyaW5naWZ5KGMuYXJncyl9YCwgXCJvdXRcIik7XG4gICAgY29uc3QgYW5zd2VyID0gYy5uYW1lID09PSBcInR2X3ZvbHVtZVwiID8gYFRoZSBUViBpcyBhdCAkeyhmYWtlVHZMZXZlbCA9IE51bWJlcihjLmFyZ3M/LmxldmVsID8/IGZha2VUdkxldmVsKSl9LmBcbiAgICAgIDogYy5uYW1lID09PSBcInR2X3BhdXNlXCIgPyAoYy5hcmdzPy5wYXVzZSA9PT0gZmFsc2UgPyBcIlBsYXlpbmcuXCIgOiBcIlBhdXNlZC5cIikgOiBcIkRvbmUuXCI7XG4gICAgc2V0VGltZW91dCgoKSA9PiBwdXNoKHsgdHlwZTogXCJ0b29sLnJlc3VsdFwiLCBydW46IGMucnVuLCB0ZXh0OiBhbnN3ZXIgfSksIDMwMCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IGFnZW50ID0gYy5hZ2VudCA9PT0gXCJ0M1wiID8gXCJ0M1wiIDogXCJoZXJtZXNcIjtcbiAgbG9nKFwib3V0XCIsIGAke2FnZW50fSAke2MuZm9sbG93VXAgPyBcImZvbGxvdy11cFwiIDogXCJ0YXNrXCJ9IFwiJHtjLmxhYmVsfVwiJHtjLnByb2plY3QgPyBgIGluICR7Yy5wcm9qZWN0fWAgOiBcIlwifTogJHtjLnJlcXVlc3R9YCwgXCJvdXRcIik7XG4gIGNvbnN0IGFib3J0ID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICBydW5zLnNldChjLnJ1biwgeyBhYm9ydCwgYWdlbnQsIHRhc2tJZDogYy50YXNrSWQgfSk7XG4gIGNvbnN0IGRvbmUgPSAodGV4dDogc3RyaW5nLCBmYWlsZWQgPSBmYWxzZSkgPT4ge1xuICAgIGlmICghcnVucy5oYXMoYy5ydW4pKSByZXR1cm47XG4gICAgcnVucy5kZWxldGUoYy5ydW4pO1xuICAgIGNvbnN0IHZpZXcgPSB0YXNrcy5nZXQoYy50YXNrSWQpO1xuICAgIGNvbnN0IHJvdyA9IHJlc3VsdChhZ2VudCwgYy5sYWJlbCwgdGV4dCwgZmFpbGVkKTtcbiAgICBub3RpZnkoYCR7YWdlbnQgPT09IFwidDNcIiA/IFwiVDNcIiA6IFwiSGVybWVzXCJ9IFx1MDBCNyAke2MubGFiZWx9YCwgdGV4dCk7XG4gICAgaWYgKCFmYWlsZWQpIHsgcmVtZW1iZXIoXCJhc3Npc3RhbnRcIiwgdGV4dCwgYCR7YWdlbnQgPT09IFwidDNcIiA/IFwiVDNcIiA6IFwiSGVybWVzXCJ9IFx1MDBCNyAke2MubGFiZWx9YCk7IGxhc3RMaW5lID0gbnVsbDsgfVxuICAgIGlmICh2aWV3KSB7IHZpZXcucmVzdWx0ID0gcm93OyBzaG93VGFza3MoKTsgfVxuICAgIHB1c2goeyB0eXBlOiBcInRvb2wucmVzdWx0XCIsIHJ1bjogYy5ydW4sIHRleHQsIGZhaWxlZCB9KTtcbiAgfTtcbiAgaWYgKGNoZWNrZWQoXCJmYWtlaGVybWVzXCIpKSB7XG4gICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IGRvbmUoYChGYWtlICR7YWdlbnQgPT09IFwidDNcIiA/IFwiVDNcIiA6IFwiSGVybWVzXCJ9KSBEb25lOiBcdTIwMUMke2MucmVxdWVzdH1cdTIwMUQuIE5vdGhpbmcgd2FzIGFjdHVhbGx5IHJ1bi5gKSwgTnVtYmVyKCQ8SFRNTElucHV0RWxlbWVudD4oXCJmYWtlZGVsYXlcIikudmFsdWUpICogMTAwMCk7XG4gICAgYWJvcnQuc2lnbmFsLm9uYWJvcnQgPSAoKSA9PiBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgIHJldHVybjtcbiAgfVxuICB0cnkge1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goYWdlbnQgPT09IFwidDNcIiA/IFwiL2FnZW50XCIgOiBcIi9oZXJtZXNcIiwge1xuICAgICAgbWV0aG9kOiBcIlBPU1RcIiwgc2lnbmFsOiBhYm9ydC5zaWduYWwsIGhlYWRlcnM6IHsgXCJjb250ZW50LXR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgY2FsbDogY2FsbE5hbWUsIHRhc2tJZDogYy50YXNrSWQsIGZvbGxvd1VwOiBjLmZvbGxvd1VwLCBtZXNzYWdlOiBjLm1lc3NhZ2UsIGxhYmVsOiBjLmxhYmVsLCByZXF1ZXN0OiBjLnJlcXVlc3QsIHByb2plY3Q6IGMucHJvamVjdCwgYXBwcm92YWxzOiBcInNjcmVlblwiIH0pLFxuICAgIH0pO1xuICAgIGlmICghcmVzcG9uc2Uub2sgfHwgIXJlc3BvbnNlLmJvZHkpIHRocm93IG5ldyBFcnJvcihgSFRUUCAke3Jlc3BvbnNlLnN0YXR1c31gKTtcbiAgICBjb25zdCByZWFkZXIgPSByZXNwb25zZS5ib2R5LnBpcGVUaHJvdWdoKG5ldyBUZXh0RGVjb2RlclN0cmVhbSgpKS5nZXRSZWFkZXIoKTtcbiAgICBsZXQgYnVmZmVyID0gXCJcIjtcbiAgICBmb3IgKDs7KSB7XG4gICAgICBjb25zdCB7IHZhbHVlLCBkb25lOiBmaW5pc2hlZCB9ID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcbiAgICAgIGlmIChmaW5pc2hlZCkgYnJlYWs7XG4gICAgICBidWZmZXIgKz0gdmFsdWU7XG4gICAgICBsZXQgY3V0O1xuICAgICAgd2hpbGUgKChjdXQgPSBidWZmZXIuaW5kZXhPZihcIlxcblxcblwiKSkgPj0gMCkge1xuICAgICAgICBjb25zdCBibG9jayA9IGJ1ZmZlci5zbGljZSgwLCBjdXQpO1xuICAgICAgICBidWZmZXIgPSBidWZmZXIuc2xpY2UoY3V0ICsgMik7XG4gICAgICAgIGNvbnN0IGV2ZW50ID0gYmxvY2subWF0Y2goL15ldmVudDogKC4qKSQvbSk/LlsxXTtcbiAgICAgICAgaWYgKCFldmVudCkgY29udGludWU7XG4gICAgICAgIGNvbnN0IGRhdGEgPSBKU09OLnBhcnNlKGJsb2NrLm1hdGNoKC9eZGF0YTogKC4qKSQvbSk/LlsxXSA/PyBcInt9XCIpO1xuICAgICAgICBpZiAoZXZlbnQgPT09IFwicHJvZ3Jlc3NcIikgcHVzaCh7IHR5cGU6IFwidGFzay5wcm9ncmVzc1wiLCB0YXNrOiBjLnRhc2tJZCwgdGV4dDogZGF0YS50ZXh0IH0pO1xuICAgICAgICBlbHNlIGlmIChldmVudCA9PT0gXCJ0aHJlYWRcIikgeyBjb25zdCB2aWV3ID0gdGFza3MuZ2V0KGMudGFza0lkKTsgaWYgKHZpZXcpIHsgdmlldy50aHJlYWQgPSBkYXRhLnRocmVhZDsgc2hvd1Rhc2tzKCk7IH0gfVxuICAgICAgICBlbHNlIGlmIChldmVudCA9PT0gXCJhcHByb3ZhbFwiKSB7XG4gICAgICAgICAgY29uc3QgdmlldyA9IHRhc2tzLmdldChjLnRhc2tJZCk7XG4gICAgICAgICAgaWYgKHZpZXcpIHsgdmlldy5hcHByb3ZhbCA9IHsgY29tbWFuZDogZGF0YS5jb21tYW5kIH07IHNob3dUYXNrcyh0cnVlKTsgfVxuICAgICAgICAgIHRvYXN0KGBIZXJtZXMgYXNrcyB0byBydW46ICR7ZGF0YS5jb21tYW5kLnNsaWNlKDAsIDgwKX1gKTtcbiAgICAgICAgICBub3RpZnkoYEhlcm1lcyBcdTAwQjcgJHtjLmxhYmVsfSBuZWVkcyB5b3VyIGFwcHJvdmFsYCwgZGF0YS5jb21tYW5kKTtcbiAgICAgICAgICBhdWRpby5jdWUoQVBQUk9WQUxfVE9ORSk7XG4gICAgICAgIH1cbiAgICAgICAgZWxzZSBpZiAoZXZlbnQgPT09IFwicmVzdWx0XCIpIGRvbmUoZGF0YS50ZXh0LCBkYXRhLmZhaWxlZCk7XG4gICAgICAgIGVsc2UgaWYgKGV2ZW50ID09PSBcImVycm9yXCIpIHsgcnVucy5kZWxldGUoYy5ydW4pOyBwdXNoKHsgdHlwZTogXCJ0b29sLmVycm9yXCIsIHJ1bjogYy5ydW4sIG1lc3NhZ2U6IGRhdGEubWVzc2FnZSB9KTsgfVxuICAgICAgfVxuICAgIH1cbiAgICBpZiAocnVucy5oYXMoYy5ydW4pKSB7IHJ1bnMuZGVsZXRlKGMucnVuKTsgcHVzaCh7IHR5cGU6IFwidG9vbC5lcnJvclwiLCBydW46IGMucnVuLCBtZXNzYWdlOiBcInRoZSBzZXJ2ZXIgY2xvc2VkIHRoZSBzdHJlYW0gd2l0aG91dCBhIHJlc3VsdFwiIH0pOyB9XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGlmICghYWJvcnQuc2lnbmFsLmFib3J0ZWQgJiYgcnVucy5oYXMoYy5ydW4pKSB7IHJ1bnMuZGVsZXRlKGMucnVuKTsgcHVzaCh7IHR5cGU6IFwidG9vbC5lcnJvclwiLCBydW46IGMucnVuLCBtZXNzYWdlOiAoZXJyIGFzIEVycm9yKS5tZXNzYWdlIH0pOyB9XG4gIH1cbn1cblxuZnVuY3Rpb24gbWljT3B0aW9ucygpIHtcbiAgY29uc3QgYWVjID0gY2hlY2tlZChcImFlY1wiKTtcbiAgcmV0dXJuIHsgZWNob0NhbmNlbGxhdGlvbjogYWVjLCBub2lzZVN1cHByZXNzaW9uOiBhZWMsIGF1dG9HYWluQ29udHJvbDogYWVjIH07XG59XG5cbmZ1bmN0aW9uIHJlYWRDb25maWcoKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICBjb25zdCBnaXZlbiA9IEpTT04ucGFyc2UoJDxIVE1MVGV4dEFyZWFFbGVtZW50PihcImNvbmZpZ1wiKS52YWx1ZSk7XG4gIGNvbnN0IGNvbmZpZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgbW9kZWw6IHNlcnZlci5tb2RlbCwgYXBpOiBzZXJ2ZXIucm91dGUgPT09IFwidmVydGV4XCIgPyBcInZlcnRleFwiIDogXCJnZW1pbmlcIiwgdG9kYXk6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKS5zbGljZSgwLCAxMCksXG4gICAgLi4uZ2l2ZW4sIHRyYWNlOiBjaGVja2VkKFwidHJhY2VcIiksXG4gIH07XG4gIGlmIChjaGVja2VkKFwicHR0XCIpKSBjb25maWcubXV0ZWQgPSB0cnVlO1xuICBpZiAoZ2l2ZW4udm9pY2UgPT09IHVuZGVmaW5lZCkgY29uZmlnLnZvaWNlID0gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJ2b2ljZVwiKS52YWx1ZTtcbiAgaWYgKGNvbmZpZy5zdGVlcmluZyA9PT0gdW5kZWZpbmVkKSBjb25maWcuc3RlZXJpbmcgPSBbXCJoZXJtZXNcIiwgXCJ0M1wiXTtcbiAgLy8gQSB3ZWIgY29uZmlnIHNhdmVkIGJlZm9yZSBoYW5kLW9mZnMgd2VyZSBuYW1lZCBpbiB3b3JkcyBnZXRzIHRoYXQgdG9vLlxuICBpZiAoY29uZmlnLmhhbmRPZmYgPT09IHVuZGVmaW5lZCAmJiBjb25maWcucGxhdGZvcm0gPT09IFwid2ViXCIpIGNvbmZpZy5oYW5kT2ZmID0gXCJuYW1lZFwiO1xuICAvLyBBbmQgb25lIHNhdmVkIGJlZm9yZSB0aGUgcGFnZSBmb2xsb3dlZCB0aGUgdXNlcidzIGxlYWQgKHN1cGVydmlzZSkgZ2V0cyB0aGF0LlxuICBpZiAoY29uZmlnLnN1cGVydmlzZSA9PT0gdW5kZWZpbmVkICYmIGNvbmZpZy5wbGF0Zm9ybSA9PT0gXCJ3ZWJcIikgY29uZmlnLnN1cGVydmlzZSA9IHRydWU7XG4gIGlmIChjaGVja2VkKFwiY29kaW5nXCIpICYmIChzZXJ2ZXIudDMgfHwgY2hlY2tlZChcImZha2VoZXJtZXNcIikpICYmIGNvbmZpZy5jb2RpbmdBZ2VudCA9PT0gdW5kZWZpbmVkKSBjb25maWcuY29kaW5nQWdlbnQgPSB7IHByb2plY3RzOiBzZXJ2ZXIudDMgPz8gW10gfTtcbiAgaWYgKGNoZWNrZWQoXCJjYXB0aW9uc1wiKSAmJiBzZXJ2ZXIuY2FwdGlvbnNNb2RlbCAmJiBjb25maWcuY2FwdGlvbnMgPT09IHVuZGVmaW5lZCkgY29uZmlnLmNhcHRpb25zID0geyBtb2RlbDogc2VydmVyLmNhcHRpb25zTW9kZWwgfTtcbiAgcmV0dXJuIGNvbmZpZztcbn1cblxuYXN5bmMgZnVuY3Rpb24gc3RhcnQoY2FycnlPbiA9IGZhbHNlKSB7XG4gIGlmIChjYWxsSWQpIHJldHVybjtcbiAgbGV0IGdpdmVuOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgdHJ5IHtcbiAgICBnaXZlbiA9IHJlYWRDb25maWcoKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgdG9hc3QoYFRoZSBkZXZlbG9wZXIgc2V0dGluZ3MgYXJlbid0IHZhbGlkIEpTT046ICR7KGVyciBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICByZXR1cm47XG4gIH1cbiAgJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJjYWxsXCIpLmRpc2FibGVkID0gdHJ1ZTtcbiAgaWYgKFwiTm90aWZpY2F0aW9uXCIgaW4gd2luZG93ICYmIE5vdGlmaWNhdGlvbi5wZXJtaXNzaW9uID09PSBcImRlZmF1bHRcIikgdm9pZCBOb3RpZmljYXRpb24ucmVxdWVzdFBlcm1pc3Npb24oKS5jYXRjaCgoKSA9PiB7fSk7XG4gIHRyeSB7XG4gICAgYXdhaXQgYXVkaW8ub3BlbigpO1xuICAgIGNvcmUgPSBhd2FpdCBsb2FkQ29yZSgpO1xuICB9IGZpbmFsbHkge1xuICAgICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiY2FsbFwiKS5kaXNhYmxlZCA9IGZhbHNlO1xuICB9XG4gICQoXCJ2ZXJzaW9uXCIpLnRleHRDb250ZW50ID0gY29yZS52ZXJzaW9uO1xuICAkKFwibG9nXCIpLmlubmVySFRNTCA9IFwiXCI7XG4gIGlmICh0YXNrcy5zaXplID4gMCB8fCAkKFwidHJhbnNjcmlwdFwiKS5jaGlsZEVsZW1lbnRDb3VudCA+IDEpIG5vdGUoYE5ldyBjYWxsIFx1MDBCNyAke25ldyBEYXRlKCkudG9Mb2NhbGVUaW1lU3RyaW5nKCl9YCk7XG4gIHRhc2tzLmNsZWFyKCk7XG4gIHNob3dUYXNrcygpO1xuICBjb3VudHMgPSB7IG1pYzogMCwgcGxheTogMCwgc2VudDogMCB9O1xuICBtZXRyaWNzLnJlcGx5ID0gW107XG4gIHN0YXJ0ZWRBdCA9IG5vdygpO1xuICBtdXRlZCA9IGdpdmVuLm11dGVkID09PSB0cnVlO1xuICAvLyBDYXJyeWluZyBvbjogdGhlIG1vZGVsIGdldHMgdGhlIGxhc3QgY29udmVyc2F0aW9uIGFzIGEgcmVjYXAuIFRoZSBjb3JlIGNhcHMgaXQsIGxhdGVzdCBsaW5lcyBmaXJzdC5cbiAgaWYgKGNhcnJ5T24gJiYgZ2l2ZW4uaGlzdG9yeSA9PT0gdW5kZWZpbmVkKSBnaXZlbi5oaXN0b3J5ID0gc2F2ZWRIaXN0b3J5KCk7XG4gIGVsc2UgaWYgKCFjYXJyeU9uKSBjaGF0ID0gW107XG4gIGlmIChjYXJyeU9uKSBjaGF0ID0gc2F2ZWRIaXN0b3J5KCk7XG4gIGxhc3RMaW5lID0gbnVsbDtcbiAgb3BlbkxpbmUgPSBudWxsO1xuICAkKFwicmVzdW1lXCIpLmhpZGRlbiA9IHRydWU7XG4gIGNhbGxOYW1lID0gYCR7bmV3IERhdGUoKS50b0lTT1N0cmluZygpLnJlcGxhY2UoL1s6Ll0vZywgXCItXCIpfS13ZWItJHtjb3JlLnZlcnNpb259YDtcbiAgY29uc3QgY3JlYXRlZCA9IEpTT04ucGFyc2UoY29yZS5jcmVhdGUoSlNPTi5zdHJpbmdpZnkoZ2l2ZW4pLCBub3coKSkpO1xuICBjYWxsSWQgPSBjcmVhdGVkLmlkO1xuICAkPEhUTUxCdXR0b25FbGVtZW50PihcImNhbGxcIikudGV4dENvbnRlbnQgPSBcIkhhbmcgdXBcIjtcbiAgJChcImNhbGxcIikuY2xhc3NMaXN0LmFkZChcImxpdmVcIik7XG4gIGZvciAoY29uc3QgaWQgb2YgW1wibWljXCIsIFwiaHVzaFwiXSkgJDxIVE1MQnV0dG9uRWxlbWVudD4oaWQpLmRpc2FibGVkID0gZmFsc2U7XG4gICQoXCJtaWNcIikuY2xhc3NMaXN0LnRvZ2dsZShcIm11dGVkXCIsIG11dGVkKTtcbiAgcnVuKGNyZWF0ZWQuY29tbWFuZHMpO1xuICB0aWNrZXIgPSB3aW5kb3cuc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgIHB1c2goeyB0eXBlOiBcInRpY2tcIiB9KTtcbiAgICBjb25zdCBsZXZlbCA9IG11dGVkICYmICFob2xkaW5nID8gMCA6IGF1ZGlvLmxldmVsO1xuICAgICQoXCJyaW5nXCIpLnN0eWxlLm9wYWNpdHkgPSBTdHJpbmcoTWF0aC5taW4oMSwgbGV2ZWwgKiAxMikpO1xuICAgICQoXCJjb3VudHNcIikudGV4dENvbnRlbnQgPSBgbWljICR7Y291bnRzLm1pY30gXHUwMEI3IHNlbnQgJHtjb3VudHMuc2VudH0gXHUwMEI3IHBsYXllZCAke2NvdW50cy5wbGF5fSBcdTAwQjcgcXVldWVkICR7YXVkaW8ucXVldWVkLnRvRml4ZWQoMSl9IHNgO1xuICAgIHNob3dTdGF0dXMoKTtcbiAgfSwgMTAwKTtcbiAgdHJhY2VUaW1lciA9IHdpbmRvdy5zZXRJbnRlcnZhbCgoKSA9PiB7IHZvaWQgc2F2ZVRyYWNlKCk7IHZvaWQgcGluZygpOyBzaG93VGFza3MoKTsgfSwgNTAwMCk7XG4gIHZvaWQgcGluZygpO1xuICBzdG9wV29yZHMuc3RhcnQoKTtcbiAgdHJ5IHsgd2FrZUxvY2sgPSBhd2FpdCAobmF2aWdhdG9yIGFzIGFueSkud2FrZUxvY2s/LnJlcXVlc3QoXCJzY3JlZW5cIik7IH0gY2F0Y2gge31cbn1cblxuZnVuY3Rpb24gaGFuZ1VwKCkge1xuICBpZiAoY2FsbElkKSBwdXNoKHsgdHlwZTogXCJzdG9wXCIsIG1lc3NhZ2U6IFwiWW91IGh1bmcgdXAuXCIgfSk7XG59XG5cbmZ1bmN0aW9uIGVuZCgpIHtcbiAgd2luZG93LmNsZWFySW50ZXJ2YWwodGlja2VyKTtcbiAgd2luZG93LmNsZWFySW50ZXJ2YWwodHJhY2VUaW1lcik7XG4gIHN0b3BXb3Jkcy5zdG9wKCk7XG4gIHZvaWQgc2F2ZVRyYWNlKCkudGhlbigoKSA9PiB7IGlmIChjb3JlICYmIGNhbGxJZCkgY29yZS5kaXNwb3NlKGNhbGxJZCk7IGNhbGxJZCA9IDA7IHNob3dUYXNrcygpOyB9KTtcbiAgYXVkaW8uc3RvcCgpO1xuICBmb3IgKGNvbnN0IHdzIG9mIHNvY2tldHMudmFsdWVzKCkpIHdzLmNsb3NlKCk7XG4gIHNvY2tldHMuY2xlYXIoKTtcbiAgZm9yIChjb25zdCByIG9mIHJ1bnMudmFsdWVzKCkpIHIuYWJvcnQuYWJvcnQoKTtcbiAgcnVucy5jbGVhcigpO1xuICAkPEhUTUxCdXR0b25FbGVtZW50PihcImNhbGxcIikudGV4dENvbnRlbnQgPSBcIkNhbGxcIjtcbiAgJChcImNhbGxcIikuY2xhc3NMaXN0LnJlbW92ZShcImxpdmVcIik7XG4gIGZvciAoY29uc3QgaWQgb2YgW1wibWljXCIsIFwiaHVzaFwiXSkgJDxIVE1MQnV0dG9uRWxlbWVudD4oaWQpLmRpc2FibGVkID0gdHJ1ZTtcbiAgJChcInJpbmdcIikuc3R5bGUub3BhY2l0eSA9IFwiMFwiO1xuICAkKFwicmVzdW1lXCIpLmhpZGRlbiA9IGNoYXQubGVuZ3RoID09PSAwO1xuICB2b2lkIHNob3dFYXJsaWVyKCk7XG4gIHZvaWQgd2FrZUxvY2s/LnJlbGVhc2UoKS5jYXRjaCgoKSA9PiB7fSk7XG4gIHdha2VMb2NrID0gbnVsbDtcbn1cblxuZnVuY3Rpb24gc2V0TXV0ZWQodmFsdWU6IGJvb2xlYW4pIHtcbiAgaWYgKCFjYWxsSWQgfHwgbXV0ZWQgPT09IHZhbHVlKSByZXR1cm47XG4gIG11dGVkID0gdmFsdWU7XG4gICQoXCJtaWNcIikuY2xhc3NMaXN0LnRvZ2dsZShcIm11dGVkXCIsIG11dGVkKTtcbiAgcHVzaCh7IHR5cGU6IG11dGVkID8gXCJtdXRlXCIgOiBcInVubXV0ZVwiIH0pO1xuICBzaG93U3RhdHVzKCk7XG59XG5cbi8qKiBTZW5kcyB3aGF0IHRoZSB0cmFjZSBrZXB0IHNpbmNlIGxhc3QgdGltZSB0byB0aGUgZGV2IHNlcnZlciwgYXMgSlNPTiBsaW5lczogYSBoZWFkZXIsIHRoZW4gZXZlbnRzLiAqL1xuYXN5bmMgZnVuY3Rpb24gc2F2ZVRyYWNlKCkge1xuICBpZiAoIWNvcmUgfHwgIWNhbGxJZCB8fCAhY2hlY2tlZChcInRyYWNlXCIpKSByZXR1cm47XG4gIGNvbnN0IGtlcHQgPSBKU09OLnBhcnNlKGNvcmUudHJhY2UoY2FsbElkKSk7XG4gIGlmICgha2VwdCkgcmV0dXJuO1xuICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcbiAgaWYgKGtlcHQuY29uZmlnKSBsaW5lcy5wdXNoKEpTT04uc3RyaW5naWZ5KHsgdmVyc2lvbjoga2VwdC52ZXJzaW9uLCBjb25maWc6IGtlcHQuY29uZmlnLCBzdGFydDoga2VwdC5zdGFydCB9KSk7XG4gIGZvciAoY29uc3QgZSBvZiBrZXB0LmV2ZW50cykgbGluZXMucHVzaChKU09OLnN0cmluZ2lmeShlKSk7XG4gIGlmIChsaW5lcy5sZW5ndGggPT09IDApIHJldHVybjtcbiAgYXdhaXQgZmV0Y2goYC90cmFjZXM/bmFtZT0ke2VuY29kZVVSSUNvbXBvbmVudChjYWxsTmFtZSl9Lmpzb25sYCwgeyBtZXRob2Q6IFwiUE9TVFwiLCBib2R5OiBsaW5lcy5qb2luKFwiXFxuXCIpICsgXCJcXG5cIiB9KS5jYXRjaCgoKSA9PiB7fSk7XG4gICQoXCJ0cmFjZW5hbWVcIikudGV4dENvbnRlbnQgPSBgdHJhY2UgJHtjYWxsTmFtZX0uanNvbmxgO1xufVxuXG4vLyBcIlN0b3BcIiBhbmQgXCJnb29kYnllXCIgaGVhcmQgYnkgdGhlIGJyb3dzZXIncyBvd24gcmVjb2duaXplcjogcXVpY2tlciB0aGFuIHRoZSBtb2RlbCdzIHRyYW5zY3JpcHQsXG4vLyBhbmQgaXQgd29ya3Mgd2hpbGUgdGhlIG1vZGVsJ3MgcmVwbHkgcGxheXMgZXZlbiB3aGVuIHRoZSBtb2RlbCBpc24ndCBoZWFyaW5nIHRoZSBtaWNyb3Bob25lLlxuXG5jbGFzcyBTdG9wV29yZHMge1xuICBwcml2YXRlIHJlYzogYW55ID0gbnVsbDtcbiAgcHJpdmF0ZSBvbiA9IGZhbHNlO1xuICBwcml2YXRlIGNvbW1hbmRzID0geyBzdG9wOiBbXSBhcyBzdHJpbmdbXSwgaGFuZ1VwOiBbXSBhcyBzdHJpbmdbXSwgY2FuY2VsQWxsOiBbXSBhcyBzdHJpbmdbXSB9O1xuXG4gIGdldCBzdXBwb3J0ZWQoKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIFwid2Via2l0U3BlZWNoUmVjb2duaXRpb25cIiBpbiB3aW5kb3cgfHwgXCJTcGVlY2hSZWNvZ25pdGlvblwiIGluIHdpbmRvdztcbiAgfVxuXG4gIHN0YXJ0KCkge1xuICAgIGlmICghY2hlY2tlZChcInN0b3B3b3JkXCIpIHx8ICF0aGlzLnN1cHBvcnRlZCB8fCAhY29yZSkgcmV0dXJuO1xuICAgIHRoaXMuY29tbWFuZHMgPSBKU09OLnBhcnNlKGNvcmUuZGVmYXVsdHMoKSkudm9pY2VDb21tYW5kcztcbiAgICBjb25zdCBSZWNvZ25pdGlvbiA9ICh3aW5kb3cgYXMgYW55KS5TcGVlY2hSZWNvZ25pdGlvbiA/PyAod2luZG93IGFzIGFueSkud2Via2l0U3BlZWNoUmVjb2duaXRpb247XG4gICAgdGhpcy5yZWMgPSBuZXcgUmVjb2duaXRpb24oKTtcbiAgICB0aGlzLnJlYy5jb250aW51b3VzID0gdHJ1ZTtcbiAgICB0aGlzLnJlYy5pbnRlcmltUmVzdWx0cyA9IHRydWU7XG4gICAgdGhpcy5yZWMubGFuZyA9IG5hdmlnYXRvci5sYW5ndWFnZSB8fCBcImVuLUdCXCI7XG4gICAgdGhpcy5yZWMub25yZXN1bHQgPSAoZTogYW55KSA9PiB7XG4gICAgICBmb3IgKGxldCBpID0gZS5yZXN1bHRJbmRleDsgaSA8IGUucmVzdWx0cy5sZW5ndGg7IGkrKykge1xuICAgICAgICBjb25zdCB0ZXh0ID0gZS5yZXN1bHRzW2ldWzBdLnRyYW5zY3JpcHQgYXMgc3RyaW5nO1xuICAgICAgICBjb25zdCBjb21tYW5kID0gY29tbWFuZEluKHRleHQsIHRoaXMuY29tbWFuZHMsIFtcIldvb2Rob3VzZVwiLCBcIkhlcm1lc1wiLCBcIkJlbnRvXCJdKTtcbiAgICAgICAgaWYgKGNvbW1hbmQgPT09IFwic3RvcFwiICYmIGF1ZGlvLnF1ZXVlZCA+IDAuMDUpIHtcbiAgICAgICAgICBsb2coXCJvdXRcIiwgYGxvY2FsIHN0b3Agd29yZDogJHt0ZXh0fWAsIFwib3V0XCIpO1xuICAgICAgICAgIHRvYXN0KGBIZWFyZCBcdTIwMUMke3RleHQudHJpbSgpfVx1MjAxRDogc3RvcHBlZGApO1xuICAgICAgICAgIHB1c2goeyB0eXBlOiBcImludGVycnVwdFwiIH0pO1xuICAgICAgICB9IGVsc2UgaWYgKGNvbW1hbmQgPT09IFwiY2FuY2VsQWxsXCIgJiYgZS5yZXN1bHRzW2ldLmlzRmluYWwpIHtcbiAgICAgICAgICBsb2coXCJvdXRcIiwgYGxvY2FsIGNhbmNlbC1hbGw6ICR7dGV4dH1gLCBcIm91dFwiKTtcbiAgICAgICAgICBwdXNoKHsgdHlwZTogXCJjYW5jZWxBbGxcIiB9KTtcbiAgICAgICAgICBwdXNoKHsgdHlwZTogXCJpbnRlcnJ1cHRcIiB9KTtcbiAgICAgICAgfSBlbHNlIGlmIChjb21tYW5kID09PSBcImhhbmdVcFwiICYmIGUucmVzdWx0c1tpXS5pc0ZpbmFsKSB7XG4gICAgICAgICAgbG9nKFwib3V0XCIsIGBsb2NhbCBoYW5nLXVwOiAke3RleHR9YCwgXCJvdXRcIik7XG4gICAgICAgICAgaGFuZ1VwKCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9O1xuICAgIHRoaXMucmVjLm9uZW5kID0gKCkgPT4geyBpZiAodGhpcy5vbikgc2V0VGltZW91dCgoKSA9PiB7IHRyeSB7IHRoaXMucmVjPy5zdGFydCgpOyB9IGNhdGNoIHt9IH0sIDI1MCk7IH07XG4gICAgdGhpcy5yZWMub25lcnJvciA9IChlOiBhbnkpID0+IHsgaWYgKGUuZXJyb3IgPT09IFwibm90LWFsbG93ZWRcIikgdGhpcy5vbiA9IGZhbHNlOyB9O1xuICAgIHRoaXMub24gPSB0cnVlO1xuICAgIHRyeSB7IHRoaXMucmVjLnN0YXJ0KCk7IH0gY2F0Y2gge31cbiAgfVxuXG4gIHN0b3AoKSB7XG4gICAgdGhpcy5vbiA9IGZhbHNlO1xuICAgIHRyeSB7IHRoaXMucmVjPy5zdG9wKCk7IH0gY2F0Y2gge31cbiAgICB0aGlzLnJlYyA9IG51bGw7XG4gIH1cbn1cbmNvbnN0IHN0b3BXb3JkcyA9IG5ldyBTdG9wV29yZHMoKTtcblxuLy8gV2lyaW5nLlxuXG5mdW5jdGlvbiBzZXR0aW5nc0Zyb21TdG9yYWdlKCkge1xuICBmb3IgKGNvbnN0IGlkIG9mIFtcImFlY1wiLCBcInN0b3B3b3JkXCIsIFwicHR0XCIsIFwiY2FwdGlvbnNcIiwgXCJjb2RpbmdcIiwgXCJmYWtlaGVybWVzXCIsIFwidHJhY2VcIl0pIHtcbiAgICBjb25zdCB2ID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oYHZvaWNlLiR7aWR9YCk7XG4gICAgaWYgKHYgIT0gbnVsbCkgJDxIVE1MSW5wdXRFbGVtZW50PihpZCkuY2hlY2tlZCA9IHYgPT09IFwiMVwiO1xuICAgICQoaWQpLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4gbG9jYWxTdG9yYWdlLnNldEl0ZW0oYHZvaWNlLiR7aWR9YCwgY2hlY2tlZChpZCkgPyBcIjFcIiA6IFwiMFwiKSk7XG4gIH1cbiAgY29uc3QgZGVsYXkgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLmZha2VkZWxheVwiKTtcbiAgaWYgKGRlbGF5KSAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwiZmFrZWRlbGF5XCIpLnZhbHVlID0gZGVsYXk7XG4gICQoXCJmYWtlZGVsYXlcIikuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLmZha2VkZWxheVwiLCAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwiZmFrZWRlbGF5XCIpLnZhbHVlKSk7XG4gIGNvbnN0IHZvaWNlID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS52b2ljZVwiKTtcbiAgaWYgKHZvaWNlKSAkPEhUTUxTZWxlY3RFbGVtZW50PihcInZvaWNlXCIpLnZhbHVlID0gdm9pY2U7XG4gICQoXCJ2b2ljZVwiKS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2Uudm9pY2VcIiwgJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJ2b2ljZVwiKS52YWx1ZSkpO1xuICBjb25zdCBtb2RlID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS5tb2RlXCIpO1xuICBpZiAobW9kZSkgJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJtb2RlXCIpLnZhbHVlID0gbW9kZTtcbiAgJChcIm1vZGVcIikuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLm1vZGVcIiwgJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJtb2RlXCIpLnZhbHVlKSk7XG59XG5cbmZ1bmN0aW9uIHRhYnMoKSB7XG4gIGNvbnN0IHZpZXdzOiBSZWNvcmQ8c3RyaW5nLCBIVE1MRWxlbWVudD4gPSB7IHRhbGs6ICQoXCJ0YWxrXCIpLCBkZXY6ICQoXCJkZXZcIiksIHJlcGxheTogJChcInJlcGxheW1haW5cIikgfTtcbiAgZm9yIChjb25zdCBuYW1lIG9mIE9iamVjdC5rZXlzKHZpZXdzKSkge1xuICAgICQoYHRhYi0ke25hbWV9YCkub25jbGljayA9ICgpID0+IHtcbiAgICAgIGZvciAoY29uc3QgW290aGVyLCBlbF0gb2YgT2JqZWN0LmVudHJpZXModmlld3MpKSB7XG4gICAgICAgIGVsLmhpZGRlbiA9IG90aGVyICE9PSBuYW1lO1xuICAgICAgICAkKGB0YWItJHtvdGhlcn1gKS5jbGFzc0xpc3QudG9nZ2xlKFwib25cIiwgb3RoZXIgPT09IG5hbWUpO1xuICAgICAgfVxuICAgIH07XG4gIH1cbiAgJChcImdlYXJcIikub25jbGljayA9ICgpID0+IHsgJChcInNldHRpbmdzXCIpLmhpZGRlbiA9IGZhbHNlOyB9O1xuICAkKFwiY2xvc2VzZXR0aW5nc1wiKS5vbmNsaWNrID0gKCkgPT4geyAkKFwic2V0dGluZ3NcIikuaGlkZGVuID0gdHJ1ZTsgfTtcbiAgJChcInNldHRpbmdzXCIpLm9uY2xpY2sgPSAoZSkgPT4geyBpZiAoZS50YXJnZXQgPT09ICQoXCJzZXR0aW5nc1wiKSkgJChcInNldHRpbmdzXCIpLmhpZGRlbiA9IHRydWU7IH07XG59XG5cbmZ1bmN0aW9uIHR5cGluZygpOiBib29sZWFuIHtcbiAgY29uc3QgZWwgPSBkb2N1bWVudC5hY3RpdmVFbGVtZW50IGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgcmV0dXJuICEhZWwgJiYgKGVsLnRhZ05hbWUgPT09IFwiSU5QVVRcIiB8fCBlbC50YWdOYW1lID09PSBcIlRFWFRBUkVBXCIgfHwgZWwudGFnTmFtZSA9PT0gXCJTRUxFQ1RcIiB8fCBlbC5pc0NvbnRlbnRFZGl0YWJsZSk7XG59XG5cbmZ1bmN0aW9uIGtleXMoKSB7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJrZXlkb3duXCIsIChlKSA9PiB7XG4gICAgaWYgKGUua2V5ID09PSBcIkVzY2FwZVwiICYmIGNhbGxJZCkgeyBwdXNoKHsgdHlwZTogXCJpbnRlcnJ1cHRcIiB9KTsgYXVkaW8uZmx1c2goKTsgcmV0dXJuOyB9XG4gICAgaWYgKHR5cGluZygpIHx8IGUubWV0YUtleSB8fCBlLmN0cmxLZXkgfHwgZS5hbHRLZXkpIHJldHVybjtcbiAgICBpZiAoZS5rZXkgPT09IFwibVwiIHx8IGUua2V5ID09PSBcIk1cIikgeyBzZXRNdXRlZCghbXV0ZWQpOyBlLnByZXZlbnREZWZhdWx0KCk7IH1cbiAgICBlbHNlIGlmIChlLmtleSA9PT0gXCIvXCIpIHsgJChcInRleHRcIikuZm9jdXMoKTsgZS5wcmV2ZW50RGVmYXVsdCgpOyB9XG4gICAgZWxzZSBpZiAoZS5jb2RlID09PSBcIlNwYWNlXCIgJiYgY2FsbElkICYmIG11dGVkICYmICFlLnJlcGVhdCkgeyBob2xkaW5nID0gdHJ1ZTsgcHVzaCh7IHR5cGU6IFwidW5tdXRlXCIgfSk7IHNob3dTdGF0dXMoKTsgZS5wcmV2ZW50RGVmYXVsdCgpOyB9XG4gIH0pO1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5dXBcIiwgKGUpID0+IHtcbiAgICBpZiAoZS5jb2RlID09PSBcIlNwYWNlXCIgJiYgaG9sZGluZykgeyBob2xkaW5nID0gZmFsc2U7IHB1c2goeyB0eXBlOiBcIm11dGVcIiB9KTsgc2hvd1N0YXR1cygpOyB9XG4gIH0pO1xufVxuXG5mdW5jdGlvbiBzdWJtaXRUZXh0KGU6IEV2ZW50KSB7XG4gIGUucHJldmVudERlZmF1bHQoKTtcbiAgY29uc3QgaW5wdXQgPSAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwidGV4dFwiKTtcbiAgbGV0IHRleHQgPSBpbnB1dC52YWx1ZS50cmltKCk7XG4gIGlmICghdGV4dCkgcmV0dXJuO1xuICBpZiAoIWNhbGxJZCkgeyB0b2FzdChcIlN0YXJ0IGEgY2FsbCBmaXJzdFwiKTsgcmV0dXJuOyB9XG4gIC8vIFwiL3QzIFx1MjAyNlwiIGFuZCBcIi9oIFx1MjAyNlwiIHBpY2sgdGhlIGFnZW50IHdoYXRldmVyIHRoZSBzZWxlY3RvciBzYXlzLlxuICBsZXQgbW9kZSA9ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwibW9kZVwiKS52YWx1ZTtcbiAgY29uc3QgcHJlZml4ID0gdGV4dC5tYXRjaCgvXlxcLyh0M3xjb2RlfGh8aGVybWVzKVxccysvaSk7XG4gIGlmIChwcmVmaXgpIHsgbW9kZSA9IC9eKHQzfGNvZGUpJC9pLnRlc3QocHJlZml4WzFdKSA/IFwidDNcIiA6IFwiaGVybWVzXCI7IHRleHQgPSB0ZXh0LnNsaWNlKHByZWZpeFswXS5sZW5ndGgpLnRyaW0oKTsgfVxuICBpZiAoIXRleHQpIHJldHVybjtcbiAgaWYgKG1vZGUgPT09IFwic2F5XCIpIHB1c2goeyB0eXBlOiBcInNheVwiLCB0ZXh0IH0pO1xuICBlbHNlIHtcbiAgICBwdXNoKHsgdHlwZTogXCJhc2tcIiwgdGV4dCwgYWdlbnQ6IG1vZGUgfSk7XG4gICAgbm90ZShgWW91IFx1MjE5MiBuZXcgJHttb2RlID09PSBcInQzXCIgPyBcImNvZGluZ1wiIDogXCJIZXJtZXNcIn0gdGFzazogJHt0ZXh0fWApO1xuICB9XG4gIGlucHV0LnZhbHVlID0gXCJcIjtcbn1cblxuYXN5bmMgZnVuY3Rpb24gbWFpbigpIHtcbiAgc2VydmVyID0gYXdhaXQgKGF3YWl0IGZldGNoKFwiL2NvbmZpZ1wiKSkuanNvbigpO1xuICAkKFwicm91dGVcIikudGV4dENvbnRlbnQgPSBgJHtzZXJ2ZXIucm91dGUgPT09IFwidmVydGV4XCIgPyBcIkdTSyBWZXJ0ZXhcIiA6IFwiR2VtaW5pIEFQSVwifSBcdTAwQjcgJHtzZXJ2ZXIubW9kZWwuc3BsaXQoXCIvXCIpLnBvcCgpfWA7XG4gICQoXCJ2ZXJzaW9uXCIpLnRleHRDb250ZW50ID0gc2VydmVyLnZlcnNpb247XG4gICQoXCJidWlsZFwiKS50ZXh0Q29udGVudCA9IGBjb3JlICR7c2VydmVyLnZlcnNpb259YDtcbiAgc2V0dGluZ3NGcm9tU3RvcmFnZSgpO1xuICBpZiAoIXNlcnZlci5oZXJtZXMpIHsgJDxIVE1MSW5wdXRFbGVtZW50PihcImZha2VoZXJtZXNcIikuY2hlY2tlZCA9IHRydWU7ICQ8SFRNTElucHV0RWxlbWVudD4oXCJmYWtlaGVybWVzXCIpLmRpc2FibGVkID0gdHJ1ZTsgfVxuICBpZiAoIXNlcnZlci50MykgJChcImNvZGluZ2hlbHBcIikudGV4dENvbnRlbnQgPSBcIlQzIGlzbid0IGF2YWlsYWJsZSBvbiB0aGUgc2VydmVyOiBvbmx5IHdpdGggZmFrZSBhbnN3ZXJzLlwiO1xuICBlbHNlICQoXCJjb2RpbmdoZWxwXCIpLnRleHRDb250ZW50ID0gYENvZGUgY2hhbmdlcyBnbyB0byBhIFQzIENvZGUgdGhyZWFkIGluIG9uZSBvZjogJHtzZXJ2ZXIudDMuam9pbihcIiwgXCIpfS5gO1xuICBpZiAoIXN0b3BXb3Jkcy5zdXBwb3J0ZWQpIHsgJDxIVE1MSW5wdXRFbGVtZW50PihcInN0b3B3b3JkXCIpLmNoZWNrZWQgPSBmYWxzZTsgJDxIVE1MSW5wdXRFbGVtZW50PihcInN0b3B3b3JkXCIpLmRpc2FibGVkID0gdHJ1ZTsgfVxuICBjb25zdCBwcmVzZXQgPSAkPEhUTUxTZWxlY3RFbGVtZW50PihcInByZXNldFwiKTtcbiAgZm9yIChjb25zdCBuYW1lIG9mIE9iamVjdC5rZXlzKFBSRVNFVFMpKSBwcmVzZXQuYWRkKG5ldyBPcHRpb24obmFtZSwgbmFtZSkpO1xuICBwcmVzZXQudmFsdWUgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLWNvcmUucHJlc2V0XCIpID8/IFwid2ViXCI7XG4gIGlmICghUFJFU0VUU1twcmVzZXQudmFsdWVdKSBwcmVzZXQudmFsdWUgPSBcIndlYlwiO1xuICAkPEhUTUxUZXh0QXJlYUVsZW1lbnQ+KFwiY29uZmlnXCIpLnZhbHVlID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS1jb3JlLmNvbmZpZ1wiKSA/PyBKU09OLnN0cmluZ2lmeShQUkVTRVRTW3ByZXNldC52YWx1ZV0sIG51bGwsIDIpO1xuICBwcmVzZXQub25jaGFuZ2UgPSAoKSA9PiB7XG4gICAgJDxIVE1MVGV4dEFyZWFFbGVtZW50PihcImNvbmZpZ1wiKS52YWx1ZSA9IEpTT04uc3RyaW5naWZ5KFBSRVNFVFNbcHJlc2V0LnZhbHVlXSwgbnVsbCwgMik7XG4gICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS1jb3JlLnByZXNldFwiLCBwcmVzZXQudmFsdWUpO1xuICAgIGxvY2FsU3RvcmFnZS5yZW1vdmVJdGVtKFwidm9pY2UtY29yZS5jb25maWdcIik7XG4gIH07XG4gICQoXCJjb25maWdcIikub25pbnB1dCA9ICgpID0+IGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2UtY29yZS5jb25maWdcIiwgJDxIVE1MVGV4dEFyZWFFbGVtZW50PihcImNvbmZpZ1wiKS52YWx1ZSk7XG4gICQoXCJkZWZhdWx0c1wiKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGMgPSBjb3JlID8/IChhd2FpdCBsb2FkQ29yZSgpKTtcbiAgICAkKFwiZGVmYXVsdHN2aWV3XCIpLnRleHRDb250ZW50ID0gSlNPTi5zdHJpbmdpZnkoSlNPTi5wYXJzZShjLmRlZmF1bHRzKCkpLCBudWxsLCAyKTtcbiAgICAkKFwiZGVmYXVsdHN2aWV3XCIpLmhpZGRlbiA9ICEkKFwiZGVmYXVsdHN2aWV3XCIpLmhpZGRlbjtcbiAgfTtcbiAgJChcImNhbGxcIikub25jbGljayA9ICgpID0+IChjYWxsSWQgPyBoYW5nVXAoKSA6IHZvaWQgc3RhcnQoKS5jYXRjaCgoZXJyKSA9PiB7IHRvYXN0KGVyci5tZXNzYWdlKTsgbG9nKFwiZXJyb3JcIiwgZXJyLm1lc3NhZ2UsIFwiZXJyXCIpOyB9KSk7XG4gICQoXCJyZXN1bWVcIikub25jbGljayA9ICgpID0+IHZvaWQgc3RhcnQodHJ1ZSkuY2F0Y2goKGVycikgPT4geyB0b2FzdChlcnIubWVzc2FnZSk7IGxvZyhcImVycm9yXCIsIGVyci5tZXNzYWdlLCBcImVyclwiKTsgfSk7XG4gIGlmIChzYXZlZEhpc3RvcnkoKS5sZW5ndGggPiAwKSB7ICQoXCJyZXN1bWVcIikuaGlkZGVuID0gZmFsc2U7ICQoXCJyZXN1bWVcIikudGl0bGUgPSBcIkNhbGwgYWdhaW4sIGNhcnJ5aW5nIG9uIGZyb20gdGhlIGxhc3QgY29udmVyc2F0aW9uXCI7IH1cbiAgJChcIm1pY1wiKS5vbmNsaWNrID0gKCkgPT4gc2V0TXV0ZWQoIW11dGVkKTtcbiAgJChcImh1c2hcIikub25jbGljayA9ICgpID0+IHsgcHVzaCh7IHR5cGU6IFwiaW50ZXJydXB0XCIgfSk7IGF1ZGlvLmZsdXNoKCk7IH07XG4gICQoXCJjYW5jZWxhbGxcIikub25jbGljayA9ICgpID0+IHB1c2goeyB0eXBlOiBcImNhbmNlbEFsbFwiIH0pO1xuICAkKFwiZG9uZWJveFwiKS5hZGRFdmVudExpc3RlbmVyKFwidG9nZ2xlXCIsICgpID0+IHsgaWYgKCQ8SFRNTERldGFpbHNFbGVtZW50PihcImRvbmVib3hcIikub3BlbikgJChcImRvbmVib3hcIikuc2Nyb2xsSW50b1ZpZXcoeyBibG9jazogXCJuZWFyZXN0XCIgfSk7IH0pO1xuICAkKFwic2F5XCIpLm9uc3VibWl0ID0gc3VibWl0VGV4dDtcbiAgJChcInRleHRcIikuYWRkRXZlbnRMaXN0ZW5lcihcImtleWRvd25cIiwgKGUpID0+IHsgaWYgKChlIGFzIEtleWJvYXJkRXZlbnQpLmtleSA9PT0gXCJFbnRlclwiKSBzdWJtaXRUZXh0KGUpOyB9KTtcbiAgdGFicygpO1xuICBrZXlzKCk7XG4gIGNvbnN0IGV2ZW50cyA9IG5ldyBFdmVudFNvdXJjZShcIi9ldmVudHNcIik7XG4gIGV2ZW50cy5hZGRFdmVudExpc3RlbmVyKFwiY29yZVwiLCAoZSkgPT4ge1xuICAgIGNvbnN0IHsgdmVyc2lvbiB9ID0gSlNPTi5wYXJzZSgoZSBhcyBNZXNzYWdlRXZlbnQpLmRhdGEpO1xuICAgICQoXCJ2ZXJzaW9uXCIpLnRleHRDb250ZW50ID0gdmVyc2lvbiArIChjYWxsSWQgJiYgY29yZSAmJiBjb3JlLnZlcnNpb24gIT09IHZlcnNpb24gPyBgIChuZXh0IGNhbGw7IHRoaXMgb25lIHJ1bnMgJHtjb3JlLnZlcnNpb259KWAgOiBcIlwiKTtcbiAgICAkKFwiYnVpbGRcIikudGV4dENvbnRlbnQgPSBgY29yZSAke3ZlcnNpb259YDtcbiAgfSk7XG4gIGV2ZW50cy5hZGRFdmVudExpc3RlbmVyKFwiYXBwXCIsICgpID0+IHsgaWYgKCFjYWxsSWQpIGxvY2F0aW9uLnJlbG9hZCgpOyBlbHNlIHRvYXN0KFwiVGhlIHBhZ2UgY2hhbmdlZDogcmVsb2FkIGFmdGVyIHRoaXMgY2FsbFwiKTsgfSk7XG4gIGV2ZW50cy5hZGRFdmVudExpc3RlbmVyKFwiZXJyb3JcIiwgKGUpID0+IHtcbiAgICBjb25zdCBkYXRhID0gKGUgYXMgTWVzc2FnZUV2ZW50KS5kYXRhO1xuICAgIGlmIChkYXRhKSB0b2FzdChgQnVpbGQgZmFpbGVkOiAke0pTT04ucGFyc2UoZGF0YSkubWVzc2FnZX1gKTtcbiAgfSk7XG4gIG5ldyBSZXBsYXkoJChcInJlcGxheVwiKSwgbG9hZENvcmUpO1xuICB2b2lkIHBpbmcoKTtcbiAgdm9pZCBzaG93RWFybGllcigpO1xuICB3aW5kb3cuc2V0SW50ZXJ2YWwoKCkgPT4gdm9pZCBzaG93RWFybGllcigpLCAzMF8wMDApO1xufVxuXG52b2lkIG1haW4oKTtcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFTQSxJQUFNLFNBQVMsb0JBQUksSUFBSTtBQUFBLEVBQ3JCO0FBQUEsRUFBTztBQUFBLEVBQU07QUFBQSxFQUFRO0FBQUEsRUFBVTtBQUFBLEVBQU87QUFBQSxFQUFRO0FBQUEsRUFBTTtBQUFBLEVBQU07QUFBQSxFQUFNO0FBQUEsRUFBTTtBQUFBLEVBQVc7QUFBQSxFQUFTO0FBQUEsRUFBUTtBQUFBLEVBQU87QUFBQSxFQUFVO0FBQUEsRUFBUztBQUFBLEVBQzVIO0FBQ0YsQ0FBQztBQUdNLFNBQVMsTUFBTSxNQUF3QjtBQUM1QyxTQUFPLEtBQUssWUFBWSxFQUFFLFFBQVEsVUFBVSxFQUFFLEVBQUUsUUFBUSxxQkFBcUIsR0FBRyxFQUFFLEtBQUssRUFBRSxNQUFNLEdBQUcsRUFBRSxPQUFPLENBQUMsTUFBTSxFQUFFLFNB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QUssT0FBTyxNQUFNO0FBQ25JLE1BQUUsT0FBTyxFQUFFLGNBQWMsUUFBUSxPQUFPO0FBQUEsRUFDMUMsQ0FBQztBQUNELFNBQU8saUJBQWlCLE9BQU8sTUFBTTtBQUFFLFFBQUksQ0FBQyxPQUFRLFVBQVMsT0FBTztBQUFBLFFBQVEsT0FBTSwwQ0FBMEM7QUFBQSxFQUFHLENBQUM7QUFDaEksU0FBTyxpQkFBaUIsU0FBUyxDQUFDLE1BQU07QUFDdEMsVUFBTSxPQUFRLEVBQW1CO0FBQ2pDLFFBQUksS0FBTSxPQUFNLGlCQUFpQixLQUFLLE1BQU0sSUFBSSxFQUFFLE9BQU8sRUFBRTtBQUFBLEVBQzdELENBQUM7QUFDRCxNQUFJLE9BQU8sRUFBRSxRQUFRLEdBQUcsUUFBUTtBQUNoQyxPQUFLLEtBQUs7QUFDVixPQUFLLFlBQVk7QUFDakIsU0FBTyxZQUFZLE1BQU0sS0FBSyxZQUFZLEdBQUcsR0FBTTtBQUNyRDtBQUVBLEtBQUssS0FBSzsiLAogICJuYW1lcyI6IFsiY29yZSIsICJjb3JlIiwgIm5vdyIsICJsaW5lIiwgInJ1biJdCn0K
