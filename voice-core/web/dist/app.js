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
  web: { platform: "web", device: "browser", standbyAfter: 30, hangUpAfter: 300, vocabulary: ["Hermes", "Bento", "Woodhouse", "T3"] },
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
var lastRole = "";
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
var lineOpen = false;
function transcript(role, text) {
  $("empty").hidden = true;
  const pane = $("transcript");
  const last = pane.lastElementChild;
  if (lineOpen && last && last.dataset.role === role) last.querySelector(".text").textContent += text;
  else {
    const row = document.createElement("div");
    row.className = `line ${role}`;
    row.dataset.role = role;
    row.innerHTML = `<span class="who">${role === "user" ? "You" : "Gemini"}</span><span class="text"></span>`;
    row.querySelector(".text").textContent = text.trimStart();
    pane.append(row);
    lineOpen = true;
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
  lineOpen = false;
  scrollDown();
}
function result(agent, label, text, failed = false) {
  $("empty").hidden = true;
  const row = document.createElement("div");
  row.className = `line result ${agent === "t3" ? "t3" : ""}`;
  row.innerHTML = `<span class="who">${agent === "t3" ? "T3" : "Hermes"} \xB7 ${escapeHtml(label)}${failed ? " \xB7 failed" : ""}</span><div class="body">${markdown(text)}</div>`;
  $("transcript").append(row);
  lineOpen = false;
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
function showTasks(force = false) {
  const pane = $("tasks");
  const open = document.activeElement?.closest?.(".task");
  if (!force && open && pane.contains(open) && open.querySelector("form")) return;
  pane.innerHTML = "";
  const all = [...tasks.values()].reverse();
  if (all.length === 0) {
    pane.append(noTasks);
    $("taskcount").textContent = "";
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
    pane.append(card);
  }
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
  $("earlierbox").hidden = list.length === 0;
  const pane = $("earlier");
  pane.innerHTML = "";
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
    pane.append(card);
  }
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
        transcript(c.role, c.text);
        remember(c.role, c.text, c.role === "assistant" ? "Gemini" : void 0, lastRole === c.role);
        lastRole = c.role;
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
      lastRole = "";
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
  lastRole = "";
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL2NvbW1hbmRzLnRzIiwgIi4uL2F1ZGlvLnRzIiwgIi4uL3JlcGxheS50cyIsICIuLi9hcHAudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFNwb2tlbiBjb21tYW5kcyB0aGUgY29yZSBhY3RzIG9uIHdpdGhvdXQgdGhlIG1vZGVsOiBcInN0b3BcIiBhbmQgXCJoYW5nIHVwXCIuIEFuIHV0dGVyYW5jZSBjb3VudHNcbi8vIG9ubHkgd2hlbiBpdCBpcyBvbmUgb2YgdGhlIHBocmFzZXMgYW5kIG5vdGhpbmcgbW9yZSwgb25jZSBuYW1lcyBhbmQgZmlsbGVycyBhcm91bmQgaXQgYXJlIGdvbmUsXG4vLyBzbyBcIldvb2Rob3VzZSwgc3RvcCBwbGVhc2VcIiBzdG9wcyBhbmQgXCJzdG9wIHRoZSBQZW5ueXdvcnRoIHRhc2tcIiBnb2VzIHRvIHRoZSBtb2RlbCBhcyB1c3VhbC5cblxuaW1wb3J0IHR5cGUgeyBWb2ljZUNvbW1hbmRzIH0gZnJvbSBcIi4vdHlwZXMudHNcIjtcblxuZXhwb3J0IHR5cGUgVm9pY2VDb21tYW5kID0gXCJzdG9wXCIgfCBcImhhbmdVcFwiIHwgXCJjYW5jZWxBbGxcIjtcblxuLyoqIFdvcmRzIHRoYXQgbWF5IGNvbWUgYmVmb3JlIG9yIGFmdGVyIGEgY29tbWFuZCB3aXRob3V0IGNoYW5naW5nIGl0LiAqL1xuY29uc3QgRklMTEVSID0gbmV3IFNldChbXG4gIFwiaGV5XCIsIFwib2tcIiwgXCJva2F5XCIsIFwicGxlYXNlXCIsIFwibm93XCIsIFwianVzdFwiLCBcInNvXCIsIFwidW1cIiwgXCJ1aFwiLCBcIm9oXCIsIFwiYWxyaWdodFwiLCBcInJpZ2h0XCIsIFwieWVhaFwiLCBcInllc1wiLCBcInRoYW5rc1wiLCBcInRoYW5rXCIsIFwieW91XCIsXG4gIFwiZ2VtaW5pXCIsXG5dKTtcblxuLyoqIFt0ZXh0XSBhcyBsb3dlci1jYXNlIHdvcmRzLCBhcG9zdHJvcGhlcyBkcm9wcGVkIChcIlRoYXQnc1wiIGlzIFwidGhhdHNcIikuICovXG5leHBvcnQgZnVuY3Rpb24gd29yZHModGV4dDogc3RyaW5nKTogc3RyaW5nW10ge1xuICByZXR1cm4gdGV4dC50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL1snXHUyMDE5YF0vZywgXCJcIikucmVwbGFjZSgvW15cXHB7TH1cXHB7TmR9XSsvZ3UsIFwiIFwiKS50cmltKCkuc3BsaXQoXCIgXCIpLmZpbHRlcigodykgPT4gdy5sZW5ndGggPiAwKTtcbn1cblxuLyoqIFRoZSBjb21tYW5kIFt1dHRlcmFuY2VdIGlzLCBpZiBpdCdzIG9uZSBhbmQgbm90aGluZyBtb3JlOyBbbmFtZXNdICh0aGUgYXNzaXN0YW50J3MsIFwiV29vZGhvdXNlXCIpIGRvbid0IGNvdW50LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbW1hbmRJbih1dHRlcmFuY2U6IHN0cmluZywgY29tbWFuZHM6IFZvaWNlQ29tbWFuZHMsIG5hbWVzOiBzdHJpbmdbXSA9IFtdKTogVm9pY2VDb21tYW5kIHwgbnVsbCB7XG4gIGNvbnN0IGlnbm9yZWQgPSBuZXcgU2V0KFsuLi5GSUxMRVIsIC4uLm5hbWVzLmZsYXRNYXAod29yZHMpXSk7XG4gIGNvbnN0IHNhaWQgPSB3b3Jkcyh1dHRlcmFuY2UpO1xuICBsZXQgZnJvbSA9IDA7XG4gIGxldCB0byA9IHNhaWQubGVuZ3RoO1xuICB3aGlsZSAoZnJvbSA8IHRvICYmIGlnbm9yZWQuaGFzKHNhaWRbZnJvbV0pKSBmcm9tKys7XG4gIHdoaWxlICh0byA+IGZyb20gJiYgaWdub3JlZC5oYXMoc2FpZFt0byAtIDFdKSkgdG8tLTtcbiAgaWYgKGZyb20gPT09IHRvIHx8IHRvIC0gZnJvbSA+IDUpIHJldHVybiBudWxsO1xuICBjb25zdCBjb3JlID0gc2FpZC5zbGljZShmcm9tLCB0bykuam9pbihcIiBcIik7XG4gIGNvbnN0IGlzID0gKHBocmFzZXM6IHN0cmluZ1tdKSA9PiBwaHJhc2VzLnNvbWUoKHApID0+IHdvcmRzKHApLmpvaW4oXCIgXCIpID09PSBjb3JlKTtcbiAgaWYgKGlzKGNvbW1hbmRzLmhhbmdVcCkpIHJldHVybiBcImhhbmdVcFwiO1xuICBpZiAoaXMoY29tbWFuZHMuY2FuY2VsQWxsID8/IFtdKSkgcmV0dXJuIFwiY2FuY2VsQWxsXCI7XG4gIGlmIChpcyhjb21tYW5kcy5zdG9wKSkgcmV0dXJuIFwic3RvcFwiO1xuICByZXR1cm4gbnVsbDtcbn1cbiIsICIvLyBUaGUgYnJvd3NlcidzIG1pY3JvcGhvbmUgYW5kIHNwZWFrZXIgZm9yIGEgY2FsbDogMTYga0h6IFBDTTE2IGZyYW1lcyBvdXQgb2YgdGhlIG1pY3JvcGhvbmUsXG4vLyAyNCBrSHogUENNMTYgaW50byB0aGUgc3BlYWtlciwgYW5kIHRvbmVzIGxhaWQgb3ZlciB3aGF0ZXZlciBwbGF5cy4gQm90aCBydW4gaW4gQXVkaW9Xb3JrbGV0cyBvblxuLy8gb25lIEF1ZGlvQ29udGV4dCBhdCB0aGUgZGV2aWNlJ3MgcmF0ZSwgcmVzYW1wbGluZyB0aGVyZS5cblxuY29uc3QgV09SS0xFVFMgPSBgXG5jbGFzcyBDYXB0dXJlIGV4dGVuZHMgQXVkaW9Xb3JrbGV0UHJvY2Vzc29yIHtcbiAgY29uc3RydWN0b3IoKSB7XG4gICAgc3VwZXIoKTtcbiAgICB0aGlzLnN0ZXAgPSBzYW1wbGVSYXRlIC8gMTYwMDA7XG4gICAgdGhpcy5wb3MgPSAwO1xuICAgIHRoaXMuZnJhbWUgPSBuZXcgSW50MTZBcnJheSgzMjApO1xuICAgIHRoaXMubiA9IDA7XG4gICAgLy8gQSB3aW5kb3dlZC1zaW5jIGxvdy1wYXNzIGF0IDcga0h6LCBzbyBub3RoaW5nIGFib3ZlIDE2IGtIeidzIDgga0h6IGxpbWl0IGZvbGRzIGJhY2sgaW50byBzcGVlY2guXG4gICAgY29uc3QgdGFwcyA9IDQ3LCBjdXQgPSA3MDAwIC8gc2FtcGxlUmF0ZTtcbiAgICB0aGlzLnRhcHMgPSBuZXcgRmxvYXQzMkFycmF5KHRhcHMpO1xuICAgIGxldCBzdW0gPSAwO1xuICAgIGZvciAobGV0IGsgPSAwOyBrIDwgdGFwczsgaysrKSB7XG4gICAgICBjb25zdCBtID0gayAtICh0YXBzIC0gMSkgLyAyO1xuICAgICAgY29uc3Qgc2luYyA9IG0gPT09IDAgPyAyICogY3V0IDogTWF0aC5zaW4oMiAqIE1hdGguUEkgKiBjdXQgKiBtKSAvIChNYXRoLlBJICogbSk7XG4gICAgICBjb25zdCB3ID0gMC40MiAtIDAuNSAqIE1hdGguY29zKCgyICogTWF0aC5QSSAqIGspIC8gKHRhcHMgLSAxKSkgKyAwLjA4ICogTWF0aC5jb3MoKDQgKiBNYXRoLlBJICogaykgLyAodGFwcyAtIDEpKTtcbiAgICAgIHRoaXMudGFwc1trXSA9IHNpbmMgKiB3O1xuICAgICAgc3VtICs9IHRoaXMudGFwc1trXTtcbiAgICB9XG4gICAgZm9yIChsZXQgayA9IDA7IGsgPCB0YXBzOyBrKyspIHRoaXMudGFwc1trXSAvPSBzdW07XG4gICAgdGhpcy5oaXN0b3J5ID0gbmV3IEZsb2F0MzJBcnJheSh0YXBzKTtcbiAgICB0aGlzLmF0ID0gMDtcbiAgfVxuICBwcm9jZXNzKGlucHV0cykge1xuICAgIGNvbnN0IGlucHV0ID0gaW5wdXRzWzBdICYmIGlucHV0c1swXVswXTtcbiAgICBpZiAoIWlucHV0KSByZXR1cm4gdHJ1ZTtcbiAgICBjb25zdCB0YXBzID0gdGhpcy50YXBzLCBoID0gdGhpcy5oaXN0b3J5LCBuID0gdGFwcy5sZW5ndGg7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBpbnB1dC5sZW5ndGg7IGkrKykge1xuICAgICAgaFt0aGlzLmF0XSA9IGlucHV0W2ldO1xuICAgICAgdGhpcy5hdCA9ICh0aGlzLmF0ICsgMSkgJSBuO1xuICAgICAgLy8gT25seSB0aGUgc2FtcGxlcyBrZXB0IG5lZWQgZmlsdGVyaW5nOiBhdCBtb3N0IG9uZSBpbiBldmVyeSBzdGVwLlxuICAgICAgaWYgKHRoaXMucG9zID4gMSkgeyB0aGlzLnBvcyAtPSAxOyBjb250aW51ZTsgfVxuICAgICAgbGV0IHggPSAwO1xuICAgICAgZm9yIChsZXQgayA9IDAsIGogPSB0aGlzLmF0OyBrIDwgbjsgaysrLCBqID0gaiArIDEgPT09IG4gPyAwIDogaiArIDEpIHggKz0gdGFwc1trXSAqIGhbal07XG4gICAgICB3aGlsZSAodGhpcy5wb3MgPD0gMSkge1xuICAgICAgICBjb25zdCBzID0gTWF0aC5tYXgoLTEsIE1hdGgubWluKDEsIHgpKTtcbiAgICAgICAgdGhpcy5mcmFtZVt0aGlzLm4rK10gPSBzIDwgMCA/IHMgKiAzMjc2OCA6IHMgKiAzMjc2NztcbiAgICAgICAgaWYgKHRoaXMubiA9PT0gdGhpcy5mcmFtZS5sZW5ndGgpIHtcbiAgICAgICAgICB0aGlzLnBvcnQucG9zdE1lc3NhZ2UodGhpcy5mcmFtZS5idWZmZXIsIFt0aGlzLmZyYW1lLmJ1ZmZlcl0pO1xuICAgICAgICAgIHRoaXMuZnJhbWUgPSBuZXcgSW50MTZBcnJheSgzMjApO1xuICAgICAgICAgIHRoaXMubiA9IDA7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5wb3MgKz0gdGhpcy5zdGVwO1xuICAgICAgfVxuICAgICAgdGhpcy5wb3MgLT0gMTtcbiAgICB9XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbn1cblxuY2xhc3MgUGxheWJhY2sgZXh0ZW5kcyBBdWRpb1dvcmtsZXRQcm9jZXNzb3Ige1xuICBjb25zdHJ1Y3RvcigpIHtcbiAgICBzdXBlcigpO1xuICAgIHRoaXMucXVldWUgPSBbXTsgICAgICAvLyBGbG9hdDMyQXJyYXlzIGF0IHRoZSBjb250ZXh0J3MgcmF0ZVxuICAgIHRoaXMub2Zmc2V0ID0gMDtcbiAgICB0aGlzLmN1ZXMgPSBbXTtcbiAgICB0aGlzLmN1ZU9mZnNldCA9IDA7XG4gICAgdGhpcy5yZXBvcnRlZCA9IDA7XG4gICAgdGhpcy5wb3J0Lm9ubWVzc2FnZSA9IChlKSA9PiB7XG4gICAgICBjb25zdCBtID0gZS5kYXRhO1xuICAgICAgaWYgKG0udHlwZSA9PT0gXCJwbGF5XCIpIHRoaXMucXVldWUucHVzaChtLnNhbXBsZXMpO1xuICAgICAgZWxzZSBpZiAobS50eXBlID09PSBcImN1ZVwiKSB0aGlzLmN1ZXMucHVzaChtLnNhbXBsZXMpO1xuICAgICAgZWxzZSBpZiAobS50eXBlID09PSBcImZsdXNoXCIpIHsgdGhpcy5xdWV1ZSA9IFtdOyB0aGlzLm9mZnNldCA9IDA7IH1cbiAgICAgIGVsc2UgaWYgKG0udHlwZSA9PT0gXCJzdG9wXCIpIHsgdGhpcy5xdWV1ZSA9IFtdOyB0aGlzLm9mZnNldCA9IDA7IHRoaXMuY3VlcyA9IFtdOyB0aGlzLmN1ZU9mZnNldCA9IDA7IH1cbiAgICB9O1xuICB9XG4gIHByb2Nlc3MoXywgb3V0cHV0cykge1xuICAgIGNvbnN0IG91dCA9IG91dHB1dHNbMF1bMF07XG4gICAgb3V0LmZpbGwoMCk7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoICYmIHRoaXMucXVldWUubGVuZ3RoOyBpKyspIHtcbiAgICAgIG91dFtpXSA9IHRoaXMucXVldWVbMF1bdGhpcy5vZmZzZXQrK107XG4gICAgICBpZiAodGhpcy5vZmZzZXQgPj0gdGhpcy5xdWV1ZVswXS5sZW5ndGgpIHsgdGhpcy5xdWV1ZS5zaGlmdCgpOyB0aGlzLm9mZnNldCA9IDA7IH1cbiAgICB9XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoICYmIHRoaXMuY3Vlcy5sZW5ndGg7IGkrKykge1xuICAgICAgb3V0W2ldID0gTWF0aC5tYXgoLTEsIE1hdGgubWluKDEsIG91dFtpXSArIHRoaXMuY3Vlc1swXVt0aGlzLmN1ZU9mZnNldCsrXSkpO1xuICAgICAgaWYgKHRoaXMuY3VlT2Zmc2V0ID49IHRoaXMuY3Vlc1swXS5sZW5ndGgpIHsgdGhpcy5jdWVzLnNoaWZ0KCk7IHRoaXMuY3VlT2Zmc2V0ID0gMDsgfVxuICAgIH1cbiAgICBmb3IgKGxldCBjID0gMTsgYyA8IG91dHB1dHNbMF0ubGVuZ3RoOyBjKyspIG91dHB1dHNbMF1bY10uc2V0KG91dCk7XG4gICAgaWYgKGN1cnJlbnRUaW1lIC0gdGhpcy5yZXBvcnRlZCA+IDAuMSkge1xuICAgICAgdGhpcy5yZXBvcnRlZCA9IGN1cnJlbnRUaW1lO1xuICAgICAgbGV0IHF1ZXVlZCA9IC10aGlzLm9mZnNldDtcbiAgICAgIGZvciAoY29uc3QgcSBvZiB0aGlzLnF1ZXVlKSBxdWV1ZWQgKz0gcS5sZW5ndGg7XG4gICAgICB0aGlzLnBvcnQucG9zdE1lc3NhZ2UoeyBxdWV1ZWQ6IHF1ZXVlZCAvIHNhbXBsZVJhdGUgfSk7XG4gICAgfVxuICAgIHJldHVybiB0cnVlO1xuICB9XG59XG5yZWdpc3RlclByb2Nlc3NvcihcImNhcHR1cmVcIiwgQ2FwdHVyZSk7XG5yZWdpc3RlclByb2Nlc3NvcihcInBsYXliYWNrXCIsIFBsYXliYWNrKTtcbmA7XG5cbmZ1bmN0aW9uIGJhc2U2NFRvQnl0ZXMoYjY0OiBzdHJpbmcpOiBVaW50OEFycmF5IHtcbiAgY29uc3QgYmluID0gYXRvYihiNjQpO1xuICBjb25zdCBvdXQgPSBuZXcgVWludDhBcnJheShiaW4ubGVuZ3RoKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBiaW4ubGVuZ3RoOyBpKyspIG91dFtpXSA9IGJpbi5jaGFyQ29kZUF0KGkpO1xuICByZXR1cm4gb3V0O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYnl0ZXNUb0Jhc2U2NChieXRlczogVWludDhBcnJheSk6IHN0cmluZyB7XG4gIGxldCBiaW4gPSBcIlwiO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGJ5dGVzLmxlbmd0aDsgaSArPSAweDgwMDApIGJpbiArPSBTdHJpbmcuZnJvbUNoYXJDb2RlKC4uLmJ5dGVzLnN1YmFycmF5KGksIGkgKyAweDgwMDApKTtcbiAgcmV0dXJuIGJ0b2EoYmluKTtcbn1cblxuLyoqIFBDTTE2IGxpdHRsZS1lbmRpYW4gYXQgW3JhdGVdLCBhcyBmbG9hdHMgYXQgdGhlIGNvbnRleHQncyByYXRlLiAqL1xuZnVuY3Rpb24gdG9GbG9hdHMocGNtOiBVaW50OEFycmF5LCByYXRlOiBudW1iZXIsIHRhcmdldDogbnVtYmVyKTogRmxvYXQzMkFycmF5IHtcbiAgY29uc3QgdmlldyA9IG5ldyBEYXRhVmlldyhwY20uYnVmZmVyLCBwY20uYnl0ZU9mZnNldCwgcGNtLmJ5dGVMZW5ndGgpO1xuICBjb25zdCBuID0gTWF0aC5mbG9vcihwY20uYnl0ZUxlbmd0aCAvIDIpO1xuICBjb25zdCBvdXQgPSBuZXcgRmxvYXQzMkFycmF5KE1hdGguZmxvb3IoKG4gKiB0YXJnZXQpIC8gcmF0ZSkpO1xuICBjb25zdCBzdGVwID0gcmF0ZSAvIHRhcmdldDtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCB4ID0gaSAqIHN0ZXA7XG4gICAgY29uc3QgaiA9IE1hdGguZmxvb3IoeCk7XG4gICAgY29uc3QgYSA9IHZpZXcuZ2V0SW50MTYoMiAqIE1hdGgubWluKGosIG4gLSAxKSwgdHJ1ZSk7XG4gICAgY29uc3QgYiA9IHZpZXcuZ2V0SW50MTYoMiAqIE1hdGgubWluKGogKyAxLCBuIC0gMSksIHRydWUpO1xuICAgIG91dFtpXSA9IChhICsgKGIgLSBhKSAqICh4IC0gaikpIC8gMzI3Njg7XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBNaWNPcHRpb25zIHsgZWNob0NhbmNlbGxhdGlvbjogYm9vbGVhbjsgbm9pc2VTdXBwcmVzc2lvbjogYm9vbGVhbjsgYXV0b0dhaW5Db250cm9sOiBib29sZWFuIH1cblxuZXhwb3J0IGNsYXNzIENhbGxBdWRpbyB7XG4gIHByaXZhdGUgY29udGV4dDogQXVkaW9Db250ZXh0IHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgcGxheWJhY2s6IEF1ZGlvV29ya2xldE5vZGUgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBjYXB0dXJlOiBBdWRpb1dvcmtsZXROb2RlIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgc3RyZWFtOiBNZWRpYVN0cmVhbSB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIHNvdXJjZTogTWVkaWFTdHJlYW1BdWRpb1NvdXJjZU5vZGUgfCBudWxsID0gbnVsbDtcbiAgLyoqIFNlY29uZHMgb2Ygc3BlZWNoIHF1ZXVlZCwgYXMgdGhlIHdvcmtsZXQgbGFzdCBzYWlkLiAqL1xuICBxdWV1ZWQgPSAwO1xuICAvKiogVGhlIG1pY3JvcGhvbmUncyBsZXZlbCwgUk1TIG9mIHRoZSBsYXN0IGZyYW1lICgwIHRvIDEpLiAqL1xuICBsZXZlbCA9IDA7XG5cbiAgYXN5bmMgb3BlbigpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAodGhpcy5jb250ZXh0KSB7IGlmICh0aGlzLmNvbnRleHQuc3RhdGUgPT09IFwic3VzcGVuZGVkXCIpIGF3YWl0IHRoaXMuY29udGV4dC5yZXN1bWUoKTsgcmV0dXJuOyB9XG4gICAgdGhpcy5jb250ZXh0ID0gbmV3IEF1ZGlvQ29udGV4dCh7IGxhdGVuY3lIaW50OiBcImludGVyYWN0aXZlXCIgfSk7XG4gICAgY29uc3QgdXJsID0gVVJMLmNyZWF0ZU9iamVjdFVSTChuZXcgQmxvYihbV09SS0xFVFNdLCB7IHR5cGU6IFwidGV4dC9qYXZhc2NyaXB0XCIgfSkpO1xuICAgIGF3YWl0IHRoaXMuY29udGV4dC5hdWRpb1dvcmtsZXQuYWRkTW9kdWxlKHVybCk7XG4gICAgdGhpcy5wbGF5YmFjayA9IG5ldyBBdWRpb1dvcmtsZXROb2RlKHRoaXMuY29udGV4dCwgXCJwbGF5YmFja1wiLCB7IG51bWJlck9mSW5wdXRzOiAwLCBvdXRwdXRDaGFubmVsQ291bnQ6IFsyXSB9KTtcbiAgICB0aGlzLnBsYXliYWNrLnBvcnQub25tZXNzYWdlID0gKGUpID0+IHsgdGhpcy5xdWV1ZWQgPSBlLmRhdGEucXVldWVkOyB9O1xuICAgIHRoaXMucGxheWJhY2suY29ubmVjdCh0aGlzLmNvbnRleHQuZGVzdGluYXRpb24pO1xuICB9XG5cbiAgLyoqIFNlY29uZHMgZnJvbSBhIHNhbXBsZSBsZWF2aW5nIHRoZSB3b3JrbGV0IHRvIHRoZSBzcGVha2VyLCBhcyB0aGUgYnJvd3NlciByZWNrb25zIGl0LiAqL1xuICBnZXQgb3V0cHV0TGF0ZW5jeSgpOiBudW1iZXIgfCBudWxsIHtcbiAgICBpZiAoIXRoaXMuY29udGV4dCkgcmV0dXJuIG51bGw7XG4gICAgcmV0dXJuIHRoaXMuY29udGV4dC5iYXNlTGF0ZW5jeSArICgodGhpcy5jb250ZXh0IGFzIEF1ZGlvQ29udGV4dCAmIHsgb3V0cHV0TGF0ZW5jeT86IG51bWJlciB9KS5vdXRwdXRMYXRlbmN5ID8/IDApO1xuICB9XG5cbiAgYXN5bmMgc3RhcnRNaWMob25GcmFtZTogKHBjbTY0OiBzdHJpbmcsIGxldmVsOiBudW1iZXIpID0+IHZvaWQsIG9wdGlvbnM6IE1pY09wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBhd2FpdCB0aGlzLm9wZW4oKTtcbiAgICB0aGlzLnN0b3BNaWMoKTtcbiAgICBjb25zdCBjb250ZXh0ID0gdGhpcy5jb250ZXh0ITtcbiAgICB0aGlzLnN0cmVhbSA9IGF3YWl0IG5hdmlnYXRvci5tZWRpYURldmljZXMuZ2V0VXNlck1lZGlhKHsgYXVkaW86IHsgY2hhbm5lbENvdW50OiAxLCAuLi5vcHRpb25zIH0gfSk7XG4gICAgdGhpcy5zb3VyY2UgPSBjb250ZXh0LmNyZWF0ZU1lZGlhU3RyZWFtU291cmNlKHRoaXMuc3RyZWFtKTtcbiAgICB0aGlzLmNhcHR1cmUgPSBuZXcgQXVkaW9Xb3JrbGV0Tm9kZShjb250ZXh0LCBcImNhcHR1cmVcIiwgeyBudW1iZXJPZk91dHB1dHM6IDAgfSk7XG4gICAgdGhpcy5jYXB0dXJlLnBvcnQub25tZXNzYWdlID0gKGUpID0+IHtcbiAgICAgIGNvbnN0IGZyYW1lID0gbmV3IEludDE2QXJyYXkoZS5kYXRhIGFzIEFycmF5QnVmZmVyKTtcbiAgICAgIGxldCBzdW0gPSAwO1xuICAgICAgZm9yIChjb25zdCBzIG9mIGZyYW1lKSBzdW0gKz0gcyAqIHM7XG4gICAgICB0aGlzLmxldmVsID0gTWF0aC5zcXJ0KHN1bSAvIGZyYW1lLmxlbmd0aCkgLyAzMjc2ODtcbiAgICAgIG9uRnJhbWUoYnl0ZXNUb0Jhc2U2NChuZXcgVWludDhBcnJheShlLmRhdGEgYXMgQXJyYXlCdWZmZXIpKSwgdGhpcy5sZXZlbCk7XG4gICAgfTtcbiAgICB0aGlzLnNvdXJjZS5jb25uZWN0KHRoaXMuY2FwdHVyZSk7XG4gIH1cblxuICBzdG9wTWljKCk6IHZvaWQge1xuICAgIHRoaXMuc291cmNlPy5kaXNjb25uZWN0KCk7XG4gICAgdGhpcy5jYXB0dXJlPy5wb3J0LmNsb3NlKCk7XG4gICAgdGhpcy5zdHJlYW0/LmdldFRyYWNrcygpLmZvckVhY2goKHQpID0+IHQuc3RvcCgpKTtcbiAgICB0aGlzLnNvdXJjZSA9IG51bGw7XG4gICAgdGhpcy5jYXB0dXJlID0gbnVsbDtcbiAgICB0aGlzLnN0cmVhbSA9IG51bGw7XG4gIH1cblxuICBwbGF5KHBjbTY0OiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuY29udGV4dCB8fCAhdGhpcy5wbGF5YmFjaykgcmV0dXJuO1xuICAgIGNvbnN0IHNhbXBsZXMgPSB0b0Zsb2F0cyhiYXNlNjRUb0J5dGVzKHBjbTY0KSwgMjQwMDAsIHRoaXMuY29udGV4dC5zYW1wbGVSYXRlKTtcbiAgICB0aGlzLnBsYXliYWNrLnBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcInBsYXlcIiwgc2FtcGxlcyB9LCBbc2FtcGxlcy5idWZmZXJdKTtcbiAgfVxuXG4gIGN1ZShwY202NDogc3RyaW5nKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLmNvbnRleHQgfHwgIXRoaXMucGxheWJhY2spIHJldHVybjtcbiAgICBjb25zdCBzYW1wbGVzID0gdG9GbG9hdHMoYmFzZTY0VG9CeXRlcyhwY202NCksIDI0MDAwLCB0aGlzLmNvbnRleHQuc2FtcGxlUmF0ZSk7XG4gICAgdGhpcy5wbGF5YmFjay5wb3J0LnBvc3RNZXNzYWdlKHsgdHlwZTogXCJjdWVcIiwgc2FtcGxlcyB9LCBbc2FtcGxlcy5idWZmZXJdKTtcbiAgfVxuXG4gIGZsdXNoKCk6IHZvaWQge1xuICAgIHRoaXMucGxheWJhY2s/LnBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcImZsdXNoXCIgfSk7XG4gIH1cblxuICBzdG9wKCk6IHZvaWQge1xuICAgIHRoaXMuc3RvcE1pYygpO1xuICAgIHRoaXMucGxheWJhY2s/LnBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcInN0b3BcIiB9KTtcbiAgfVxufVxuIiwgIi8vIFRoZSByZXBsYXkgdmlldzogYSByZWNvcmRlZCBjYWxsIChhIHRyYWNlIGZyb20gYW55IGhvc3QsIG9yIGEgc2NlbmFyaW8pIHJ1biBhZ2FpbiB0aHJvdWdoIHRoZVxuLy8gY29yZSwgYXMgdGhlIGJ1aWxkIHRoYXQgcmVjb3JkZWQgaXQgZGlkIGFuZCBhcyB0aGUgbGF0ZXN0IGRvZXMsIHNpZGUgYnkgc2lkZS4gV2hlcmUgdGhleSBwYXJ0XG4vLyBpcyB3aGVyZSBhIGNoYW5nZSBpbiBzcmMvIGNoYW5nZWQgd2hhdCB0aGUgY2FsbCBkb2VzIHdpdGggdGhlIHNhbWUgd29yZHMgYW5kIHRoZSBzYW1lIG1vZGVsLlxuXG5pbnRlcmZhY2UgQ29yZSB7XG4gIHZlcnNpb246IHN0cmluZztcbiAgY3JlYXRlKGNvbmZpZzogc3RyaW5nLCB0OiBudW1iZXIpOiBzdHJpbmc7XG4gIHB1c2goaWQ6IG51bWJlciwgZXZlbnQ6IHN0cmluZyk6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFJlY29yZGluZyB7IHZlcnNpb24/OiBzdHJpbmc7IGNvbmZpZzogdW5rbm93bjsgc3RhcnQ6IG51bWJlcjsgZXZlbnRzOiBSZWNvcmQ8c3RyaW5nLCBhbnk+W10gfVxuXG4vKiogV2hhdCBhIGNvbW1hbmQgb3IgZXZlbnQgbG9va3MgbGlrZSBpbiBhIHRpbWVsaW5lOiBhdWRpbyBjdXQgb3V0LCBvbmUgbGluZS4gKi9cbmZ1bmN0aW9uIGxpbmUobzogUmVjb3JkPHN0cmluZywgYW55Pik6IHN0cmluZyB7XG4gIGNvbnN0IHRleHQgPSBKU09OLnN0cmluZ2lmeShvKS5yZXBsYWNlKC9cIihkYXRhfHBjbSlcIjpcIltBLVphLXowLTkrLz1dezQwLH1cIi9nLCAnXCIkMVwiOlwiXHUyMDI2XCInKVxuICAgIC5yZXBsYWNlKC9cXFxcXCJkYXRhXFxcXFwiOlxcXFxcIltBLVphLXowLTkrLz1dezQwLH1cXFxcXCIvZywgJ1xcXFxcImRhdGFcXFxcXCI6XFxcXFwiXHUyMDI2XFxcXFwiJyk7XG4gIHJldHVybiB0ZXh0Lmxlbmd0aCA+IDQwMCA/IHRleHQuc2xpY2UoMCwgNDAwKSArIFwiXHUyMDI2XCIgOiB0ZXh0O1xufVxuXG4vKiogQXVkaW8gYW5kIHRpY2tzIHNheSBub3RoaW5nIGEgcmVhZGVyIG5lZWRzOyB0aGUgcmVzdCBkb2VzLiAqL1xuZnVuY3Rpb24gdGVsbGluZyhvOiBSZWNvcmQ8c3RyaW5nLCBhbnk+KTogYm9vbGVhbiB7XG4gIGlmIChvLnR5cGUgPT09IFwibWljXCIgfHwgby50eXBlID09PSBcInRpY2tcIiB8fCBvLnR5cGUgPT09IFwicGxheVwiKSByZXR1cm4gZmFsc2U7XG4gIGlmIChvLnR5cGUgPT09IFwid3Muc2VuZFwiICYmIFN0cmluZyhvLmRhdGEpLnN0YXJ0c1dpdGgoJ3tcInJlYWx0aW1lSW5wdXRcIjp7XCJhdWRpb1wiJykpIHJldHVybiBmYWxzZTtcbiAgaWYgKG8udHlwZSA9PT0gXCJ3cy5tZXNzYWdlXCIgJiYgU3RyaW5nKG8uZGF0YSkuaW5jbHVkZXMoJ1wiaW5saW5lRGF0YVwiJykgJiYgIVN0cmluZyhvLmRhdGEpLmluY2x1ZGVzKCdcInR1cm5Db21wbGV0ZVwiJykpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmZ1bmN0aW9uIHJ1bihjb3JlOiBDb3JlLCByOiBSZWNvcmRpbmcpOiBzdHJpbmdbXVtdIHtcbiAgY29uc3QgY3JlYXRlZCA9IEpTT04ucGFyc2UoY29yZS5jcmVhdGUoSlNPTi5zdHJpbmdpZnkoci5jb25maWcpLCByLnN0YXJ0KSk7XG4gIGNvbnN0IG91dDogc3RyaW5nW11bXSA9IFtjcmVhdGVkLmNvbW1hbmRzLmZpbHRlcih0ZWxsaW5nKS5tYXAobGluZSldO1xuICBmb3IgKGNvbnN0IGUgb2Ygci5ldmVudHMpIG91dC5wdXNoKChKU09OLnBhcnNlKGNvcmUucHVzaChjcmVhdGVkLmlkLCBKU09OLnN0cmluZ2lmeShlKSkpIGFzIFJlY29yZDxzdHJpbmcsIGFueT5bXSkuZmlsdGVyKHRlbGxpbmcpLm1hcChsaW5lKSk7XG4gIHJldHVybiBvdXQ7XG59XG5cbmV4cG9ydCBjbGFzcyBSZXBsYXkge1xuICBwcml2YXRlIHJlYWRvbmx5IHJvb3Q6IEhUTUxFbGVtZW50O1xuICBwcml2YXRlIHJlYWRvbmx5IGxvYWQ6ICh1cmw/OiBzdHJpbmcpID0+IFByb21pc2U8Q29yZT47XG5cbiAgY29uc3RydWN0b3Iocm9vdDogSFRNTEVsZW1lbnQsIGxvYWQ6ICh1cmw/OiBzdHJpbmcpID0+IFByb21pc2U8Q29yZT4pIHtcbiAgICB0aGlzLnJvb3QgPSByb290O1xuICAgIHRoaXMubG9hZCA9IGxvYWQ7XG4gICAgcm9vdC5pbm5lckhUTUwgPSBgXG4gICAgICA8ZGl2IGNsYXNzPVwiYmFyXCI+PHNlbGVjdCBjbGFzcz1cInBpY2tcIj48L3NlbGVjdD48YnV0dG9uIGNsYXNzPVwicmVmcmVzaFwiPlx1MjFCQjwvYnV0dG9uPjxidXR0b24gY2xhc3M9XCJnb1wiPlJlcGxheTwvYnV0dG9uPlxuICAgICAgPGxhYmVsPjxpbnB1dCB0eXBlPVwiY2hlY2tib3hcIiBjbGFzcz1cImFsbFwiPiBzaG93IGF1ZGlvIGFuZCB0aWNrczwvbGFiZWw+PHNwYW4gY2xhc3M9XCJzdW1tYXJ5XCI+PC9zcGFuPjwvZGl2PlxuICAgICAgPGRpdiBjbGFzcz1cInRpbWVsaW5lXCI+PC9kaXY+YDtcbiAgICAocm9vdC5xdWVyeVNlbGVjdG9yKFwiLnJlZnJlc2hcIikgYXMgSFRNTEVsZW1lbnQpLm9uY2xpY2sgPSAoKSA9PiB2b2lkIHRoaXMubGlzdCgpO1xuICAgIChyb290LnF1ZXJ5U2VsZWN0b3IoXCIuZ29cIikgYXMgSFRNTEVsZW1lbnQpLm9uY2xpY2sgPSAoKSA9PiB2b2lkIHRoaXMucmVwbGF5KCkuY2F0Y2goKGVycikgPT4gdGhpcy5zYXkoYFJlcGxheSBmYWlsZWQ6ICR7ZXJyLm1lc3NhZ2V9YCkpO1xuICAgIHZvaWQgdGhpcy5saXN0KCk7XG4gIH1cblxuICBwcml2YXRlIHNheSh0ZXh0OiBzdHJpbmcpIHtcbiAgICAodGhpcy5yb290LnF1ZXJ5U2VsZWN0b3IoXCIuc3VtbWFyeVwiKSBhcyBIVE1MRWxlbWVudCkudGV4dENvbnRlbnQgPSB0ZXh0O1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBsaXN0KCkge1xuICAgIGNvbnN0IHBpY2sgPSB0aGlzLnJvb3QucXVlcnlTZWxlY3RvcihcIi5waWNrXCIpIGFzIEhUTUxTZWxlY3RFbGVtZW50O1xuICAgIHBpY2suaW5uZXJIVE1MID0gXCJcIjtcbiAgICBjb25zdCB0cmFjZXM6IHsgbmFtZTogc3RyaW5nOyBieXRlczogbnVtYmVyIH1bXSA9IGF3YWl0IChhd2FpdCBmZXRjaChcIi90cmFjZXNcIikpLmpzb24oKTtcbiAgICBjb25zdCBzY2VuYXJpb3M6IHN0cmluZ1tdID0gYXdhaXQgKGF3YWl0IGZldGNoKFwiL3NjZW5hcmlvc1wiKSkuanNvbigpO1xuICAgIGNvbnN0IHRyYWNlR3JvdXAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwib3B0Z3JvdXBcIik7XG4gICAgdHJhY2VHcm91cC5sYWJlbCA9IFwiUmVjb3JkZWQgY2FsbHNcIjtcbiAgICBmb3IgKGNvbnN0IHQgb2YgdHJhY2VzKSB0cmFjZUdyb3VwLmFwcGVuZChuZXcgT3B0aW9uKGAke3QubmFtZX0gKCR7TWF0aC5yb3VuZCh0LmJ5dGVzIC8gMTAyNCl9IEtCKWAsIGAvdHJhY2VzLyR7dC5uYW1lfWApKTtcbiAgICBjb25zdCBzY2VuYXJpb0dyb3VwID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcIm9wdGdyb3VwXCIpO1xuICAgIHNjZW5hcmlvR3JvdXAubGFiZWwgPSBcIlNjZW5hcmlvc1wiO1xuICAgIGZvciAoY29uc3QgcyBvZiBzY2VuYXJpb3MpIHNjZW5hcmlvR3JvdXAuYXBwZW5kKG5ldyBPcHRpb24ocywgYC9zY2VuYXJpb3MvJHtzfS5qc29uYCkpO1xuICAgIHBpY2suYXBwZW5kKHRyYWNlR3JvdXAsIHNjZW5hcmlvR3JvdXApO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyByZWNvcmRpbmcodXJsOiBzdHJpbmcpOiBQcm9taXNlPFJlY29yZGluZz4ge1xuICAgIGNvbnN0IHRleHQgPSBhd2FpdCAoYXdhaXQgZmV0Y2godXJsLCB7IGNhY2hlOiBcIm5vLXN0b3JlXCIgfSkpLnRleHQoKTtcbiAgICBpZiAodXJsLmVuZHNXaXRoKFwiLmpzb25cIikpIHJldHVybiBKU09OLnBhcnNlKHRleHQpO1xuICAgIGNvbnN0IFtoZWFkZXIsIC4uLmV2ZW50c10gPSB0ZXh0LnRyaW0oKS5zcGxpdChcIlxcblwiKS5tYXAoKGwpID0+IEpTT04ucGFyc2UobCkpO1xuICAgIHJldHVybiB7IC4uLmhlYWRlciwgZXZlbnRzIH07XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHJlcGxheSgpIHtcbiAgICBjb25zdCB1cmwgPSAodGhpcy5yb290LnF1ZXJ5U2VsZWN0b3IoXCIucGlja1wiKSBhcyBIVE1MU2VsZWN0RWxlbWVudCkudmFsdWU7XG4gICAgaWYgKCF1cmwpIHJldHVybjtcbiAgICBjb25zdCByID0gYXdhaXQgdGhpcy5yZWNvcmRpbmcodXJsKTtcbiAgICBjb25zdCBsYXRlc3QgPSBhd2FpdCB0aGlzLmxvYWQoKTtcbiAgICBsZXQgcmVjb3JkZWQ6IENvcmUgfCBudWxsID0gbnVsbDtcbiAgICBpZiAoci52ZXJzaW9uICYmIHIudmVyc2lvbiAhPT0gbGF0ZXN0LnZlcnNpb24pIHtcbiAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goYC92ZXJzaW9ucy8ke3IudmVyc2lvbn0uanNgLCB7IG1ldGhvZDogXCJIRUFEXCIgfSk7XG4gICAgICBpZiAocmVzcG9uc2Uub2spIHJlY29yZGVkID0gYXdhaXQgdGhpcy5sb2FkKGAvdmVyc2lvbnMvJHtyLnZlcnNpb259LmpzYCk7XG4gICAgfVxuICAgIGNvbnN0IG5vdyA9IHJ1bihsYXRlc3QsIHIpO1xuICAgIGNvbnN0IHRoZW4gPSByZWNvcmRlZCA/IHJ1bihyZWNvcmRlZCwgcikgOiBudWxsO1xuICAgIGNvbnN0IGFsbCA9ICh0aGlzLnJvb3QucXVlcnlTZWxlY3RvcihcIi5hbGxcIikgYXMgSFRNTElucHV0RWxlbWVudCkuY2hlY2tlZDtcbiAgICBjb25zdCB0aW1lbGluZSA9IHRoaXMucm9vdC5xdWVyeVNlbGVjdG9yKFwiLnRpbWVsaW5lXCIpIGFzIEhUTUxFbGVtZW50O1xuICAgIHRpbWVsaW5lLmlubmVySFRNTCA9IFwiXCI7XG4gICAgbGV0IGZpcnN0ID0gLTE7XG4gICAgbGV0IGRpZmZlciA9IDA7XG4gICAgY29uc3Qgcm93czogSFRNTEVsZW1lbnRbXSA9IFtdO1xuICAgIGNvbnN0IGFkZCA9IChjbHM6IHN0cmluZywgdDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpID0+IHtcbiAgICAgIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICByb3cuY2xhc3NOYW1lID0gYHJvdyAke2Nsc31gO1xuICAgICAgcm93LmlubmVySFRNTCA9IGA8c3BhbiBjbGFzcz1cInRcIj4ke3R9PC9zcGFuPmA7XG4gICAgICBjb25zdCBiID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gICAgICBiLmNsYXNzTmFtZSA9IFwiYlwiO1xuICAgICAgYi50ZXh0Q29udGVudCA9IHRleHQ7XG4gICAgICByb3cuYXBwZW5kKGIpO1xuICAgICAgdGltZWxpbmUuYXBwZW5kKHJvdyk7XG4gICAgICByb3dzLnB1c2gocm93KTtcbiAgICAgIHJldHVybiByb3c7XG4gICAgfTtcbiAgICBjb25zdCB0MCA9IHIuc3RhcnQ7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPD0gci5ldmVudHMubGVuZ3RoOyBpKyspIHtcbiAgICAgIGNvbnN0IGUgPSBpID09PSAwID8gbnVsbCA6IHIuZXZlbnRzW2kgLSAxXTtcbiAgICAgIGNvbnN0IG5vd091dCA9IG5vd1tpXTtcbiAgICAgIGNvbnN0IHRoZW5PdXQgPSB0aGVuID8gdGhlbltpXSA6IG5vd091dDtcbiAgICAgIGNvbnN0IHNhbWUgPSBub3dPdXQubGVuZ3RoID09PSB0aGVuT3V0Lmxlbmd0aCAmJiBub3dPdXQuZXZlcnkoKGMsIGopID0+IGMgPT09IHRoZW5PdXRbal0pO1xuICAgICAgaWYgKCFzYW1lKSB7IGRpZmZlcisrOyBpZiAoZmlyc3QgPCAwKSBmaXJzdCA9IGk7IH1cbiAgICAgIGlmICghc2FtZSB8fCBhbGwgfHwgKGUgJiYgdGVsbGluZyhlKSkgfHwgbm93T3V0Lmxlbmd0aCA+IDApIHtcbiAgICAgICAgaWYgKGUgJiYgKGFsbCB8fCB0ZWxsaW5nKGUpIHx8ICFzYW1lKSkgYWRkKFwiaW5cIiwgKGUudCAtIHQwKS50b0ZpeGVkKDIpLCBsaW5lKGUpKTtcbiAgICAgICAgY29uc3QgdCA9IGUgPyAoZS50IC0gdDApLnRvRml4ZWQoMikgOiBcIjAuMDBcIjtcbiAgICAgICAgaWYgKHNhbWUpIGZvciAoY29uc3QgYyBvZiBub3dPdXQpIGFkZChcIm91dFwiLCB0LCBjKTtcbiAgICAgICAgZWxzZSB7XG4gICAgICAgICAgZm9yIChjb25zdCBjIG9mIHRoZW5PdXQpIGFkZChcIm91dCBnb25lXCIsIHQsIGBcdTIyMTIgJHtjfWApO1xuICAgICAgICAgIGZvciAoY29uc3QgYyBvZiBub3dPdXQpIGFkZChcIm91dCBuZXdcIiwgdCwgYCsgJHtjfWApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IHZlcnNpb25zID0gdGhlbiA/IGByZWNvcmRlZCBieSAke3IudmVyc2lvbn0sIHJlcGxheWVkIGJ5IGl0IGFuZCBieSAke2xhdGVzdC52ZXJzaW9ufWAgOiBgcmVwbGF5ZWQgYnkgJHtsYXRlc3QudmVyc2lvbn1gICtcbiAgICAgIChyLnZlcnNpb24gJiYgci52ZXJzaW9uICE9PSBsYXRlc3QudmVyc2lvbiA/IGAgKHRoZSByZWNvcmRpbmcncyBidWlsZCAke3IudmVyc2lvbn0gaXNuJ3Qga2VwdCBoZXJlKWAgOiBcIlwiKTtcbiAgICB0aGlzLnNheShgJHtyLmV2ZW50cy5sZW5ndGh9IGV2ZW50cywgJHt2ZXJzaW9uc30uIGAgKyAodGhlbiA/IChkaWZmZXIgPyBgJHtkaWZmZXJ9IGV2ZW50cyBhbnN3ZXJlZCBkaWZmZXJlbnRseSwgdGhlIGZpcnN0IGF0IGV2ZW50ICR7Zmlyc3R9LmAgOiBcIkJvdGggYW5zd2VyZWQgZXZlcnkgZXZlbnQgdGhlIHNhbWUuXCIpIDogXCJcIikpO1xuICAgIGlmIChmaXJzdCA+PSAwKSB0aW1lbGluZS5xdWVyeVNlbGVjdG9yKFwiLmdvbmUsIC5uZXdcIik/LnNjcm9sbEludG9WaWV3KHsgYmxvY2s6IFwiY2VudGVyXCIgfSk7XG4gIH1cbn1cbiIsICIvLyBUaGUgd2ViIHN1cmZhY2U6IGEgZm91cnRoIGhvc3QgZm9yIHRoZSB2b2ljZSBjb3JlLCBhbmQgYSBwaG9uZS1mcmllbmRseSB3YXkgdG8gdXNlIGl0IGZvciB3b3JrLlxuLy8gSXQgbG9hZHMgdGhlIGRldiBzZXJ2ZXIncyBsYXRlc3QgYnVpbGQgYXQgZWFjaCBjYWxsLCBzbyBhbiBlZGl0IGluIHNyYy8gaXMgbGl2ZSBvbiB0aGUgbmV4dFxuLy8gY2FsbCwgYW5kIGtlZXBzIGV2ZXJ5IGNhbGwgYXMgYSB0cmFjZSB0aGUgcmVwbGF5IHZpZXcgKGFuZCBhbnkgb3RoZXIgaG9zdCkgY2FuIHJ1biBhZ2Fpbi5cbi8vXG4vLyBUaGUgaG9zdCdzIHBhcnQgaXMgc21hbGw6IHRoZSBtaWNyb3Bob25lIGFuZCBzcGVha2VyIChhdWRpby50cyksIHRoZSBtb2RlbCdzIHNvY2tldCB0aHJvdWdoIHRoZVxuLy8gc2VydmVyJ3MgcmVsYXksIEhlcm1lcyBhbmQgVDMgdGhyb3VnaCB0aGUgc2VydmVyLCBhbmQgdGhlIHNjcmVlbi4gVGhlIGNvcmUgZGVjaWRlcyB0aGUgcmVzdC5cblxuaW1wb3J0IHsgY29tbWFuZEluIH0gZnJvbSBcIi4uL3NyYy9jb21tYW5kcy50c1wiO1xuaW1wb3J0IHsgQ2FsbEF1ZGlvIH0gZnJvbSBcIi4vYXVkaW8udHNcIjtcbmltcG9ydCB7IFJlcGxheSB9IGZyb20gXCIuL3JlcGxheS50c1wiO1xuXG5pbnRlcmZhY2UgQ29yZSB7XG4gIHZlcnNpb246IHN0cmluZztcbiAgZGVmYXVsdHMoKTogc3RyaW5nO1xuICBjcmVhdGUoY29uZmlnOiBzdHJpbmcsIHQ6IG51bWJlcik6IHN0cmluZztcbiAgcHVzaChpZDogbnVtYmVyLCBldmVudDogc3RyaW5nKTogc3RyaW5nO1xuICB0cmFjZShpZDogbnVtYmVyKTogc3RyaW5nO1xuICBkaXNwb3NlKGlkOiBudW1iZXIpOiB2b2lkO1xufVxudHlwZSBDb21tYW5kID0gUmVjb3JkPHN0cmluZywgYW55PiAmIHsgdHlwZTogc3RyaW5nIH07XG5pbnRlcmZhY2UgU2VydmVyQ29uZmlnIHsgcm91dGU6IHN0cmluZzsgbW9kZWw6IHN0cmluZzsgY2FwdGlvbnNNb2RlbD86IHN0cmluZzsgdmVyc2lvbjogc3RyaW5nOyBoZXJtZXM6IGJvb2xlYW47IHQzOiBzdHJpbmdbXSB8IG51bGwgfVxuXG5jb25zdCAkID0gPFQgZXh0ZW5kcyBIVE1MRWxlbWVudCA9IEhUTUxFbGVtZW50PihpZDogc3RyaW5nKSA9PiBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChpZCkgYXMgVDtcbmNvbnN0IG5vdyA9ICgpID0+IHBlcmZvcm1hbmNlLm5vdygpIC8gMTAwMDtcbmNvbnN0IGNoZWNrZWQgPSAoaWQ6IHN0cmluZykgPT4gJDxIVE1MSW5wdXRFbGVtZW50PihpZCkuY2hlY2tlZDtcblxuLyoqIFRoZSBsYXRlc3QgYnVpbGQgZnJvbSB0aGUgZGV2IHNlcnZlciwgZXZhbHVhdGVkIGFmcmVzaDogYW4gZWRpdCBpbiBzcmMvIGlzIGluIHRoZSBuZXh0IGNhbGwuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbG9hZENvcmUodXJsID0gXCIvdm9pY2UtY29yZS5qc1wiKTogUHJvbWlzZTxDb3JlPiB7XG4gIGNvbnN0IHNvdXJjZSA9IGF3YWl0IChhd2FpdCBmZXRjaCh1cmwsIHsgY2FjaGU6IFwibm8tc3RvcmVcIiB9KSkudGV4dCgpO1xuICBjb25zdCBzY29wZTogeyBWb2ljZUNvcmU/OiBDb3JlIH0gPSB7fTtcbiAgbmV3IEZ1bmN0aW9uKFwiZ2xvYmFsVGhpc1wiLCBzb3VyY2UpKHNjb3BlKTtcbiAgaWYgKCFzY29wZS5Wb2ljZUNvcmUpIHRocm93IG5ldyBFcnJvcihcInRoZSBidW5kbGUgZGlkbid0IGRlZmluZSBWb2ljZUNvcmVcIik7XG4gIHJldHVybiBzY29wZS5Wb2ljZUNvcmU7XG59XG5cbi8vIFByZXNldHM6IGVhY2ggc3VyZmFjZSdzIHNldHRpbmdzIGFzIGl0cyBhcHAgd291bGQgc2V0IHRoZW0uXG5cbmNvbnN0IEZBS0VfVFYgPSBbXG4gIHsgbmFtZTogXCJ0dl92b2x1bWVcIiwgZGVzY3JpcHRpb246IFwiU2V0cyB0aGUgbGl2aW5nLXJvb20gVFYncyB2b2x1bWUsIDAgdG8gMTAwLlwiLCBwYXJhbWV0ZXJzOiB7IHR5cGU6IFwiT0JKRUNUXCIsIHByb3BlcnRpZXM6IHsgbGV2ZWw6IHsgdHlwZTogXCJJTlRFR0VSXCIgfSB9LCByZXF1aXJlZDogW1wibGV2ZWxcIl0gfSB9LFxuICB7IG5hbWU6IFwidHZfcGF1c2VcIiwgZGVzY3JpcHRpb246IFwiUGF1c2VzIG9yIHJlc3VtZXMgd2hhdCdzIHBsYXlpbmcgb24gdGhlIFRWLlwiLCBwYXJhbWV0ZXJzOiB7IHR5cGU6IFwiT0JKRUNUXCIsIHByb3BlcnRpZXM6IHsgcGF1c2U6IHsgdHlwZTogXCJCT09MRUFOXCIgfSB9IH0gfSxcbl07XG5cbmNvbnN0IFBSRVNFVFM6IFJlY29yZDxzdHJpbmcsIFJlY29yZDxzdHJpbmcsIHVua25vd24+PiA9IHtcbiAgd2ViOiB7IHBsYXRmb3JtOiBcIndlYlwiLCBkZXZpY2U6IFwiYnJvd3NlclwiLCBzdGFuZGJ5QWZ0ZXI6IDMwLCBoYW5nVXBBZnRlcjogMzAwLCB2b2NhYnVsYXJ5OiBbXCJIZXJtZXNcIiwgXCJCZW50b1wiLCBcIldvb2Rob3VzZVwiLCBcIlQzXCJdIH0sXG4gIGFuZHJvaWQ6IHsgcGxhdGZvcm06IFwiQW5kcm9pZFwiLCBkZXZpY2U6IFwicGhvbmVcIiwgc3RhbmRieUFmdGVyOiAyMCB9LFxuICBcImFuZHJvaWQgd2FrZSB3b3JkXCI6IHsgcGxhdGZvcm06IFwiQW5kcm9pZFwiLCBkZXZpY2U6IFwicGhvbmVcIiwgc3RhbmRieUFmdGVyOiAyMCwgaGFuZ1VwQWZ0ZXI6IDE1IH0sXG4gIG1hY29zOiB7IHBsYXRmb3JtOiBcIm1hY09TXCIsIGRldmljZTogXCJNYWNcIiwgc3RhbmRieUFmdGVyOiAyMCB9LFxuICBlY2hvOiB7XG4gICAgcGxhdGZvcm06IFwiRWNob1wiLCBkZXZpY2U6IFwic3BlYWtlclwiLCBoYW5nVXBBZnRlcjogNiwgc3RhbmRieUFmdGVyOiA4LCBlYXJjb25zOiB0cnVlLCB2b2NhYnVsYXJ5OiBbXCJIZXJtZXNcIiwgXCJCZW50b1wiLCBcIldvb2Rob3VzZVwiXSxcbiAgICBtaWM6IHsgd2hpbGVTcGVha2luZzogXCJ3YWtlXCIsIGdhaW5EYjogMCB9LCBob3N0VG9vbHM6IEZBS0VfVFYsXG4gIH0sXG59O1xuXG4vLyBTdGF0ZS5cblxuY29uc3QgYXVkaW8gPSBuZXcgQ2FsbEF1ZGlvKCk7XG5sZXQgc2VydmVyOiBTZXJ2ZXJDb25maWc7XG5sZXQgY29yZTogQ29yZSB8IG51bGwgPSBudWxsO1xubGV0IGNhbGxJZCA9IDA7XG5sZXQgY2FsbE5hbWUgPSBcIlwiO1xubGV0IHRpY2tlciA9IDA7XG5sZXQgdHJhY2VUaW1lciA9IDA7XG5sZXQgc3RhcnRlZEF0ID0gbm93KCk7XG5jb25zdCBzb2NrZXRzID0gbmV3IE1hcDxudW1iZXIsIFdlYlNvY2tldD4oKTtcbi8qKiBUaGUgc29ja2V0cyB0byB0aGUgdHJhbnNjcmlwdGlvbiBtb2RlbDogdGhlaXIgYXVkaW8gaXMgdGhlIG1vZGVsJ3MgYWdhaW4sIHNvIGl0IGlzbid0IGNvdW50ZWQgb3IgbG9nZ2VkIHR3aWNlLiAqL1xuY29uc3QgY2FwdGlvblNvY2tldHMgPSBuZXcgU2V0PG51bWJlcj4oKTtcbmNvbnN0IHJ1bnMgPSBuZXcgTWFwPHN0cmluZywgeyBhYm9ydDogQWJvcnRDb250cm9sbGVyOyBhZ2VudDogc3RyaW5nOyB0YXNrSWQ6IHN0cmluZyB9PigpO1xuaW50ZXJmYWNlIFRhc2tWaWV3IHsgYzogQ29tbWFuZDsgc2luY2U6IG51bWJlcjsgZW5kZWQ6IG51bWJlciB8IG51bGw7IHRocmVhZD86IHN0cmluZzsgcmVzdWx0PzogSFRNTEVsZW1lbnQ7IGFwcHJvdmFsPzogeyBjb21tYW5kOiBzdHJpbmcgfSB9XG5jb25zdCB0YXNrcyA9IG5ldyBNYXA8c3RyaW5nLCBUYXNrVmlldz4oKTtcbmxldCBjb3VudHMgPSB7IG1pYzogMCwgcGxheTogMCwgc2VudDogMCB9O1xubGV0IGZha2VUdkxldmVsID0gMTU7XG5sZXQgY29yZVN0YXR1cyA9IFwiaWRsZVwiO1xubGV0IG11dGVkID0gZmFsc2U7XG5sZXQgaG9sZGluZyA9IGZhbHNlO1xubGV0IHdha2VMb2NrOiB7IHJlbGVhc2UoKTogUHJvbWlzZTx2b2lkPiB9IHwgbnVsbCA9IG51bGw7XG5cbi8vIFRoZSBjb252ZXJzYXRpb24sIGtlcHQgc28gYSBuZXcgY2FsbCBjYW4gY2Fycnkgb24gZnJvbSBpdCAodGhlIGNvcmUncyBgaGlzdG9yeWAsIHJlY2FwcGVkIHRvIHRoZSBtb2RlbCkuXG5pbnRlcmZhY2UgQ2hhdExpbmUgeyByb2xlOiBcInVzZXJcIiB8IFwiYXNzaXN0YW50XCI7IHNwZWFrZXI/OiBzdHJpbmc7IHRleHQ6IHN0cmluZyB9XG5jb25zdCBISVNUT1JZID0gXCJ2b2ljZS5oaXN0b3J5XCI7XG5jb25zdCBISVNUT1JZX01BWF9BR0UgPSAxMiAqIDM2MDAgKiAxMDAwO1xubGV0IGNoYXQ6IENoYXRMaW5lW10gPSBbXTtcbmxldCBsYXN0Um9sZSA9IFwiXCI7XG5cbmZ1bmN0aW9uIHJlbWVtYmVyKHJvbGU6IFwidXNlclwiIHwgXCJhc3Npc3RhbnRcIiwgdGV4dDogc3RyaW5nLCBzcGVha2VyPzogc3RyaW5nLCBqb2luID0gZmFsc2UpIHtcbiAgY29uc3QgbGFzdCA9IGNoYXQuYXQoLTEpO1xuICBpZiAoam9pbiAmJiBsYXN0ICYmIGxhc3Qucm9sZSA9PT0gcm9sZSAmJiBsYXN0LnNwZWFrZXIgPT09IHNwZWFrZXIpIGxhc3QudGV4dCArPSB0ZXh0O1xuICBlbHNlIGNoYXQucHVzaChzcGVha2VyID8geyByb2xlLCBzcGVha2VyLCB0ZXh0IH0gOiB7IHJvbGUsIHRleHQgfSk7XG4gIGlmIChjaGF0Lmxlbmd0aCA+IDIwMCkgY2hhdC5zcGxpY2UoMCwgY2hhdC5sZW5ndGggLSAyMDApO1xuICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShISVNUT1JZLCBKU09OLnN0cmluZ2lmeSh7IGF0OiBEYXRlLm5vdygpLCBjaGF0IH0pKTtcbn1cblxuZnVuY3Rpb24gc2F2ZWRIaXN0b3J5KCk6IENoYXRMaW5lW10ge1xuICB0cnkge1xuICAgIGNvbnN0IHNhdmVkID0gSlNPTi5wYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShISVNUT1JZKSA/PyBcIm51bGxcIik7XG4gICAgcmV0dXJuIHNhdmVkICYmIERhdGUubm93KCkgLSBzYXZlZC5hdCA8IEhJU1RPUllfTUFYX0FHRSAmJiBBcnJheS5pc0FycmF5KHNhdmVkLmNoYXQpID8gc2F2ZWQuY2hhdCA6IFtdO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gW107XG4gIH1cbn1cblxuLyoqIFR3byByaXNpbmcgbm90ZXM6IHNvbWV0aGluZyBvbiB0aGUgc2NyZWVuIG5lZWRzIHRoZSB1c2VyLiBQQ00xNiBhdCAyNCBrSHosIGJhc2U2NC4gKi9cbmNvbnN0IEFQUFJPVkFMX1RPTkUgPSAoKCkgPT4ge1xuICBjb25zdCByYXRlID0gMjQwMDAsIG91dCA9IG5ldyBJbnQxNkFycmF5KHJhdGUgKiAwLjMyKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCB0ID0gaSAvIHJhdGUsIGYgPSB0IDwgMC4xNiA/IDY2MCA6IDg4MCwgbG9jYWwgPSB0IDwgMC4xNiA/IHQgOiB0IC0gMC4xNjtcbiAgICBvdXRbaV0gPSBNYXRoLnJvdW5kKE1hdGguc2luKDIgKiBNYXRoLlBJICogZiAqIHQpICogTWF0aC5taW4oMSwgbG9jYWwgKiA2MCwgKDAuMTYgLSBsb2NhbCkgKiA2MCkgKiA2MDAwKTtcbiAgfVxuICBsZXQgYmluID0gXCJcIjtcbiAgY29uc3QgYnl0ZXMgPSBuZXcgVWludDhBcnJheShvdXQuYnVmZmVyKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBieXRlcy5sZW5ndGg7IGkrKykgYmluICs9IFN0cmluZy5mcm9tQ2hhckNvZGUoYnl0ZXNbaV0pO1xuICByZXR1cm4gYnRvYShiaW4pO1xufSkoKTtcblxuLy8gTGF0ZW5jeTogdGhlIG5ldHdvcmsncyByb3VuZCB0cmlwLCBhbmQgaG93IGxvbmcgYWZ0ZXIgdGhlIHVzZXIgc3RvcHMgdGFsa2luZyB0aGUgcmVwbHkgc3RhcnRzLlxuY29uc3QgbWV0cmljcyA9IHsgcnR0OiBbXSBhcyBudW1iZXJbXSwgcmVwbHk6IFtdIGFzIG51bWJlcltdLCBsYXN0Vm9pY2U6IDAsIGxhc3RQbGF5OiAwLCByZXBsaWVkOiB0cnVlIH07XG5cbmZ1bmN0aW9uIG1lZGlhbih4czogbnVtYmVyW10pOiBudW1iZXIgfCBudWxsIHtcbiAgaWYgKHhzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHMgPSBbLi4ueHNdLnNvcnQoKGEsIGIpID0+IGEgLSBiKTtcbiAgcmV0dXJuIHNbTWF0aC5mbG9vcihzLmxlbmd0aCAvIDIpXTtcbn1cblxuZnVuY3Rpb24gc2hvd01ldHJpY3MoKSB7XG4gIGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBydHQgPSBtZWRpYW4obWV0cmljcy5ydHQpO1xuICBpZiAocnR0ICE9IG51bGwpIHBhcnRzLnB1c2goYG5ldHdvcmsgJHtNYXRoLnJvdW5kKHJ0dCAqIDEwMDApfSBtc2ApO1xuICBjb25zdCByZXBseSA9IG1lZGlhbihtZXRyaWNzLnJlcGx5KTtcbiAgaWYgKHJlcGx5ICE9IG51bGwpIHBhcnRzLnB1c2goYHJlcGx5ICR7bWV0cmljcy5yZXBseS5hdCgtMSkhLnRvRml4ZWQoMSl9IHMgKG1lZGlhbiAke3JlcGx5LnRvRml4ZWQoMSl9KWApO1xuICBjb25zdCBvdXQgPSBhdWRpby5vdXRwdXRMYXRlbmN5O1xuICBpZiAob3V0ICE9IG51bGwpIHBhcnRzLnB1c2goYGF1ZGlvICR7TWF0aC5yb3VuZChvdXQgKiAxMDAwKX0gbXNgKTtcbiAgbGV0IGJ1ZmZlcmVkID0gMDtcbiAgZm9yIChjb25zdCB3cyBvZiBzb2NrZXRzLnZhbHVlcygpKSBidWZmZXJlZCArPSB3cy5idWZmZXJlZEFtb3VudDtcbiAgaWYgKGJ1ZmZlcmVkID4gMzJfMDAwKSBwYXJ0cy5wdXNoKGB1cGxvYWQgYmVoaW5kICR7KGJ1ZmZlcmVkIC8gMzJfMDAwKS50b0ZpeGVkKDEpfSBzYCk7XG4gICQoXCJtZXRyaWNzXCIpLnRleHRDb250ZW50ID0gcGFydHMuam9pbihcIiBcdTAwQjcgXCIpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBwaW5nKCkge1xuICBjb25zdCB0ID0gbm93KCk7XG4gIHRyeSB7XG4gICAgYXdhaXQgZmV0Y2goXCIvcGluZ1wiLCB7IGNhY2hlOiBcIm5vLXN0b3JlXCIgfSk7XG4gICAgbWV0cmljcy5ydHQucHVzaChub3coKSAtIHQpO1xuICAgIGlmIChtZXRyaWNzLnJ0dC5sZW5ndGggPiAxMikgbWV0cmljcy5ydHQuc2hpZnQoKTtcbiAgfSBjYXRjaCB7fVxuICBzaG93TWV0cmljcygpO1xufVxuXG4vLyBUaGUgc2NyZWVuLlxuXG4vKiogQSBzeXN0ZW0gbm90aWZpY2F0aW9uIHdoaWxlIHRoZSBwYWdlIGlzIGhpZGRlbjogYSB0YXNrIGZpbmlzaGVkLCBvciBvbmUgbmVlZHMgdGhlIHVzZXIuICovXG5mdW5jdGlvbiBub3RpZnkodGl0bGU6IHN0cmluZywgYm9keTogc3RyaW5nKSB7XG4gIGlmICghZG9jdW1lbnQuaGlkZGVuIHx8ICEoXCJOb3RpZmljYXRpb25cIiBpbiB3aW5kb3cpIHx8IE5vdGlmaWNhdGlvbi5wZXJtaXNzaW9uICE9PSBcImdyYW50ZWRcIikgcmV0dXJuO1xuICB0cnkge1xuICAgIGNvbnN0IG4gPSBuZXcgTm90aWZpY2F0aW9uKHRpdGxlLCB7IGJvZHk6IGJvZHkuc2xpY2UoMCwgMTgwKSwgaWNvbjogXCIvd2ViL2ljb25zL2ljb24tMTkyLnBuZ1wiLCB0YWc6IHRpdGxlIH0pO1xuICAgIG4ub25jbGljayA9ICgpID0+IHsgd2luZG93LmZvY3VzKCk7IG4uY2xvc2UoKTsgfTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gUGhvbmVzIHdhbnQgbm90aWZpY2F0aW9ucyBmcm9tIGEgc2VydmljZSB3b3JrZXI7IHRoZSBwYWdlIGhhcyBub25lLlxuICB9XG59XG5cbmZ1bmN0aW9uIHRvYXN0KHRleHQ6IHN0cmluZykge1xuICBjb25zdCB0ID0gJChcInRvYXN0XCIpO1xuICB0LnRleHRDb250ZW50ID0gdGV4dDtcbiAgdC5jbGFzc0xpc3QuYWRkKFwib25cIik7XG4gIGNsZWFyVGltZW91dCgodG9hc3QgYXMgYW55KS50aW1lcik7XG4gICh0b2FzdCBhcyBhbnkpLnRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB0LmNsYXNzTGlzdC5yZW1vdmUoXCJvblwiKSwgMTgwMCk7XG59XG5cbmZ1bmN0aW9uIGxvZyhraW5kOiBzdHJpbmcsIHRleHQ6IHN0cmluZywgY2xzID0gXCJcIikge1xuICBjb25zdCBwYW5lID0gJChcImxvZ1wiKTtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IGByb3cgJHtjbHN9YDtcbiAgcm93LmlubmVySFRNTCA9IGA8c3BhbiBjbGFzcz1cInRcIj4keyhub3coKSAtIHN0YXJ0ZWRBdCkudG9GaXhlZCgyKX08L3NwYW4+PHNwYW4gY2xhc3M9XCJrXCI+JHtraW5kfTwvc3Bhbj5gO1xuICBjb25zdCBib2R5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGJvZHkuY2xhc3NOYW1lID0gXCJiXCI7XG4gIGJvZHkudGV4dENvbnRlbnQgPSB0ZXh0O1xuICByb3cuYXBwZW5kKGJvZHkpO1xuICBjb25zdCBzdGljayA9IHBhbmUuc2Nyb2xsVG9wICsgcGFuZS5jbGllbnRIZWlnaHQgPj0gcGFuZS5zY3JvbGxIZWlnaHQgLSAzMDtcbiAgcGFuZS5hcHBlbmQocm93KTtcbiAgd2hpbGUgKHBhbmUuY2hpbGRFbGVtZW50Q291bnQgPiAzMDAwKSBwYW5lLmZpcnN0RWxlbWVudENoaWxkIS5yZW1vdmUoKTtcbiAgaWYgKHN0aWNrKSBwYW5lLnNjcm9sbFRvcCA9IHBhbmUuc2Nyb2xsSGVpZ2h0O1xufVxuXG4vKiogQSBmcmFtZSBmcm9tIG9yIHRvIEdlbWluaSwgd2l0aCBhdWRpbyBjdXQgb3V0LCBzaG9ydCBlbm91Z2ggdG8gcmVhZC4gKi9cbmZ1bmN0aW9uIGJyaWVmKGRhdGE6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBkYXRhLnJlcGxhY2UoL1wiZGF0YVwiOlwiW0EtWmEtejAtOSsvPV17NDAsfVwiL2csIChtKSA9PiBgXCJkYXRhXCI6XCJcdTIwMjYke01hdGgucm91bmQoKChtLmxlbmd0aCAtIDkpICogMykgLyA0KX0gYnl0ZXNcImApLnNsaWNlKDAsIDYwMCk7XG59XG5cbmZ1bmN0aW9uIGVzY2FwZUh0bWwodGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHRleHQucmVwbGFjZSgvWyY8PlwiJ10vZywgKGMpID0+ICh7IFwiJlwiOiBcIiZhbXA7XCIsIFwiPFwiOiBcIiZsdDtcIiwgXCI+XCI6IFwiJmd0O1wiLCAnXCInOiBcIiZxdW90O1wiLCBcIidcIjogXCImIzM5O1wiIH0pW2NdISk7XG59XG5cbi8qKiBBIGxpdHRsZSBNYXJrZG93biwgc2FmZWx5OiBjb2RlLCBib2xkLCBsaW5rcywgbGlzdHMgYW5kIGhlYWRpbmdzLCB0aGUgcmVzdCBhcyB0ZXh0LiAqL1xuZnVuY3Rpb24gbWFya2Rvd24odGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgYmxvY2tzID0gZXNjYXBlSHRtbCh0ZXh0LnRyaW0oKSkuc3BsaXQoL2BgYCg/OlxcdyspP1xcbj8vKTtcbiAgcmV0dXJuIGJsb2Nrcy5tYXAoKGJsb2NrLCBpKSA9PiB7XG4gICAgaWYgKGkgJSAyID09PSAxKSByZXR1cm4gYDxwcmU+JHtibG9ja308L3ByZT5gO1xuICAgIGNvbnN0IGlubGluZSA9IChzOiBzdHJpbmcpID0+IHNcbiAgICAgIC5yZXBsYWNlKC9gKFteYFxcbl0rKWAvZywgXCI8Y29kZT4kMTwvY29kZT5cIilcbiAgICAgIC5yZXBsYWNlKC9cXCpcXCooW14qXFxuXSspXFwqXFwqL2csIFwiPGI+JDE8L2I+XCIpXG4gICAgICAucmVwbGFjZSgvXFxbKFteXFxdXFxuXSspXFxdXFwoKGh0dHBzPzpcXC9cXC9bXlxccyldKylcXCkvZywgJzxhIGhyZWY9XCIkMlwiIHRhcmdldD1cIl9ibGFua1wiIHJlbD1cIm5vb3BlbmVyXCI+JDE8L2E+JylcbiAgICAgIC5yZXBsYWNlKC8oXnxbXFxzKF0pKGh0dHBzPzpcXC9cXC9bXlxcczwpXSspL2csICckMTxhIGhyZWY9XCIkMlwiIHRhcmdldD1cIl9ibGFua1wiIHJlbD1cIm5vb3BlbmVyXCI+JDI8L2E+Jyk7XG4gICAgbGV0IGh0bWwgPSBcIlwiO1xuICAgIGxldCBsaXN0OiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICBmb3IgKGNvbnN0IHJhdyBvZiBibG9jay5zcGxpdChcIlxcblwiKSkge1xuICAgICAgY29uc3QgaXRlbSA9IHJhdy5tYXRjaCgvXlxccyooPzpbLSpcdTIwMjJdfChcXGQrKVsuKV0pXFxzKyguKikkLyk7XG4gICAgICBpZiAoaXRlbSkge1xuICAgICAgICBjb25zdCBraW5kID0gaXRlbVsxXSA/IFwib2xcIiA6IFwidWxcIjtcbiAgICAgICAgaWYgKGxpc3QgIT09IGtpbmQpIHsgaWYgKGxpc3QpIGh0bWwgKz0gYDwvJHtsaXN0fT5gOyBodG1sICs9IGA8JHtraW5kfT5gOyBsaXN0ID0ga2luZDsgfVxuICAgICAgICBodG1sICs9IGA8bGk+JHtpbmxpbmUoaXRlbVsyXSl9PC9saT5gO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGlmIChsaXN0KSB7IGh0bWwgKz0gYDwvJHtsaXN0fT5gOyBsaXN0ID0gbnVsbDsgfVxuICAgICAgY29uc3QgaGVhZGluZyA9IHJhdy5tYXRjaCgvXiN7MSw2fVxccysoLiopJC8pO1xuICAgICAgaHRtbCArPSBoZWFkaW5nID8gYDxiPiR7aW5saW5lKGhlYWRpbmdbMV0pfTwvYj48YnI+YCA6IHJhdy50cmltKCkgPT09IFwiXCIgPyBcIjxicj5cIiA6IGAke2lubGluZShyYXcpfTxicj5gO1xuICAgIH1cbiAgICBpZiAobGlzdCkgaHRtbCArPSBgPC8ke2xpc3R9PmA7XG4gICAgcmV0dXJuIGh0bWw7XG4gIH0pLmpvaW4oXCJcIik7XG59XG5cbmZ1bmN0aW9uIHNjcm9sbERvd24oZm9yY2UgPSBmYWxzZSkge1xuICBjb25zdCBwYW5lID0gJChcInRyYW5zY3JpcHRcIik7XG4gIGlmIChmb3JjZSB8fCBwYW5lLnNjcm9sbFRvcCArIHBhbmUuY2xpZW50SGVpZ2h0ID49IHBhbmUuc2Nyb2xsSGVpZ2h0IC0gODApIHBhbmUuc2Nyb2xsVG9wID0gcGFuZS5zY3JvbGxIZWlnaHQ7XG59XG5cbmxldCBsaW5lT3BlbiA9IGZhbHNlO1xuXG5mdW5jdGlvbiB0cmFuc2NyaXB0KHJvbGU6IFwidXNlclwiIHwgXCJhc3Npc3RhbnRcIiwgdGV4dDogc3RyaW5nKSB7XG4gICQoXCJlbXB0eVwiKS5oaWRkZW4gPSB0cnVlO1xuICBjb25zdCBwYW5lID0gJChcInRyYW5zY3JpcHRcIik7XG4gIGNvbnN0IGxhc3QgPSBwYW5lLmxhc3RFbGVtZW50Q2hpbGQgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAobGluZU9wZW4gJiYgbGFzdCAmJiBsYXN0LmRhdGFzZXQucm9sZSA9PT0gcm9sZSkgbGFzdC5xdWVyeVNlbGVjdG9yKFwiLnRleHRcIikhLnRleHRDb250ZW50ICs9IHRleHQ7XG4gIGVsc2Uge1xuICAgIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgcm93LmNsYXNzTmFtZSA9IGBsaW5lICR7cm9sZX1gO1xuICAgIHJvdy5kYXRhc2V0LnJvbGUgPSByb2xlO1xuICAgIHJvdy5pbm5lckhUTUwgPSBgPHNwYW4gY2xhc3M9XCJ3aG9cIj4ke3JvbGUgPT09IFwidXNlclwiID8gXCJZb3VcIiA6IFwiR2VtaW5pXCJ9PC9zcGFuPjxzcGFuIGNsYXNzPVwidGV4dFwiPjwvc3Bhbj5gO1xuICAgIHJvdy5xdWVyeVNlbGVjdG9yKFwiLnRleHRcIikhLnRleHRDb250ZW50ID0gdGV4dC50cmltU3RhcnQoKTtcbiAgICBwYW5lLmFwcGVuZChyb3cpO1xuICAgIGxpbmVPcGVuID0gdHJ1ZTtcbiAgfVxuICBzY3JvbGxEb3duKHJvbGUgPT09IFwidXNlclwiKTtcbn1cblxuLyoqXG4gKiBUaGUgd29yZHMgdGhlIHVzZXIgaXMgc2F5aW5nLCBiZWZvcmUgdGhlIG1vZGVsIGhhcyB0cmFuc2NyaWJlZCB0aGVtOiBhIGZhaW50IHJvdyB0aGF0IHN0YXlzIGxhc3RcbiAqIG9uIHNjcmVlbiAoaXRzIENTUyBgb3JkZXJgKSBhbmQgZmlyc3QgaW4gdGhlIHBhbmUsIHNvIHRoZSBsaW5lcyBhZnRlciBpdCBqb2luIHVwIGFzIGJlZm9yZS5cbiAqL1xuZnVuY3Rpb24gY2FwdGlvbih0ZXh0OiBzdHJpbmcgfCBudWxsKSB7XG4gIGNvbnN0IHBhbmUgPSAkKFwidHJhbnNjcmlwdFwiKTtcbiAgbGV0IHJvdyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwiY2FwdGlvblwiKTtcbiAgaWYgKHRleHQgPT0gbnVsbCkgeyByb3c/LnJlbW92ZSgpOyByZXR1cm47IH1cbiAgJChcImVtcHR5XCIpLmhpZGRlbiA9IHRydWU7XG4gIGlmICghcm93KSB7XG4gICAgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICByb3cuaWQgPSBcImNhcHRpb25cIjtcbiAgICByb3cuY2xhc3NOYW1lID0gXCJsaW5lIHVzZXIgY2FwdGlvblwiO1xuICAgIHJvdy5pbm5lckhUTUwgPSBgPHNwYW4gY2xhc3M9XCJ3aG9cIj5Zb3U8L3NwYW4+PHNwYW4gY2xhc3M9XCJ0ZXh0XCI+PC9zcGFuPmA7XG4gICAgcGFuZS5wcmVwZW5kKHJvdyk7XG4gIH1cbiAgcm93LnF1ZXJ5U2VsZWN0b3IoXCIudGV4dFwiKSEudGV4dENvbnRlbnQgPSB0ZXh0O1xuICBzY3JvbGxEb3duKHRydWUpO1xufVxuXG5mdW5jdGlvbiBub3RlKHRleHQ6IHN0cmluZykge1xuICAkKFwiZW1wdHlcIikuaGlkZGVuID0gdHJ1ZTtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IFwibGluZSBub3RlXCI7XG4gIHJvdy50ZXh0Q29udGVudCA9IHRleHQ7XG4gICQoXCJ0cmFuc2NyaXB0XCIpLmFwcGVuZChyb3cpO1xuICBsaW5lT3BlbiA9IGZhbHNlO1xuICBzY3JvbGxEb3duKCk7XG59XG5cbmZ1bmN0aW9uIHJlc3VsdChhZ2VudDogc3RyaW5nLCBsYWJlbDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcsIGZhaWxlZCA9IGZhbHNlKTogSFRNTEVsZW1lbnQge1xuICAkKFwiZW1wdHlcIikuaGlkZGVuID0gdHJ1ZTtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IGBsaW5lIHJlc3VsdCAke2FnZW50ID09PSBcInQzXCIgPyBcInQzXCIgOiBcIlwifWA7XG4gIHJvdy5pbm5lckhUTUwgPSBgPHNwYW4gY2xhc3M9XCJ3aG9cIj4ke2FnZW50ID09PSBcInQzXCIgPyBcIlQzXCIgOiBcIkhlcm1lc1wifSBcdTAwQjcgJHtlc2NhcGVIdG1sKGxhYmVsKX0ke2ZhaWxlZCA/IFwiIFx1MDBCNyBmYWlsZWRcIiA6IFwiXCJ9PC9zcGFuPjxkaXYgY2xhc3M9XCJib2R5XCI+JHttYXJrZG93bih0ZXh0KX08L2Rpdj5gO1xuICAkKFwidHJhbnNjcmlwdFwiKS5hcHBlbmQocm93KTtcbiAgbGluZU9wZW4gPSBmYWxzZTtcbiAgY29uc3QgYm9keSA9IHJvdy5xdWVyeVNlbGVjdG9yKFwiLmJvZHlcIikgYXMgSFRNTEVsZW1lbnQ7XG4gIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB7XG4gICAgaWYgKGJvZHkuc2Nyb2xsSGVpZ2h0ID4gYm9keS5jbGllbnRIZWlnaHQgKyA0KSB7XG4gICAgICBjb25zdCBtb3JlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgICAgIG1vcmUuY2xhc3NOYW1lID0gXCJtb3JlXCI7XG4gICAgICBtb3JlLnRleHRDb250ZW50ID0gXCJTaG93IGFsbFwiO1xuICAgICAgbW9yZS5vbmNsaWNrID0gKCkgPT4geyByb3cuY2xhc3NMaXN0LnRvZ2dsZShcIm9wZW5cIik7IG1vcmUudGV4dENvbnRlbnQgPSByb3cuY2xhc3NMaXN0LmNvbnRhaW5zKFwib3BlblwiKSA/IFwiU2hvdyBsZXNzXCIgOiBcIlNob3cgYWxsXCI7IH07XG4gICAgICByb3cuYXBwZW5kKG1vcmUpO1xuICAgIH1cbiAgfSk7XG4gIHNjcm9sbERvd24odHJ1ZSk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIGVsYXBzZWQoc2Vjb25kczogbnVtYmVyKTogc3RyaW5nIHtcbiAgaWYgKHNlY29uZHMgPCA2MCkgcmV0dXJuIGAke01hdGguZmxvb3Ioc2Vjb25kcyl9IHNgO1xuICBjb25zdCBtID0gTWF0aC5mbG9vcihzZWNvbmRzIC8gNjApO1xuICByZXR1cm4gbSA8IDYwID8gYCR7bX0gbWluICR7TWF0aC5mbG9vcihzZWNvbmRzICUgNjApfSBzYCA6IGAke01hdGguZmxvb3IobSAvIDYwKX0gaCAke20gJSA2MH0gbWluYDtcbn1cblxuLyoqIFRoZSBlbXB0eSB0YXNrIGxpc3QncyB3b3Jkcywga2VwdCB0byBwdXQgYmFjay4gKi9cbmNvbnN0IG5vVGFza3MgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcIm5vdGFza3NcIikhO1xuXG5mdW5jdGlvbiBzaG93VGFza3MoZm9yY2UgPSBmYWxzZSkge1xuICBjb25zdCBwYW5lID0gJChcInRhc2tzXCIpO1xuICBjb25zdCBvcGVuID0gZG9jdW1lbnQuYWN0aXZlRWxlbWVudD8uY2xvc2VzdD8uKFwiLnRhc2tcIikgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAoIWZvcmNlICYmIG9wZW4gJiYgcGFuZS5jb250YWlucyhvcGVuKSAmJiBvcGVuLnF1ZXJ5U2VsZWN0b3IoXCJmb3JtXCIpKSByZXR1cm47IC8vIGRvbid0IHJlZHJhdyB1bmRlciBzb21lb25lIHR5cGluZyBhIGZvbGxvdy11cFxuICBwYW5lLmlubmVySFRNTCA9IFwiXCI7XG4gIGNvbnN0IGFsbCA9IFsuLi50YXNrcy52YWx1ZXMoKV0ucmV2ZXJzZSgpO1xuICBpZiAoYWxsLmxlbmd0aCA9PT0gMCkgeyBwYW5lLmFwcGVuZChub1Rhc2tzKTsgJChcInRhc2tjb3VudFwiKS50ZXh0Q29udGVudCA9IFwiXCI7IHJldHVybjsgfVxuICBjb25zdCBydW5uaW5nID0gYWxsLmZpbHRlcigodCkgPT4gdC5jLnN0YXRlID09PSBcInJ1bm5pbmdcIikubGVuZ3RoO1xuICAkKFwidGFza2NvdW50XCIpLnRleHRDb250ZW50ID0gcnVubmluZyA+IDAgPyBgJHtydW5uaW5nfSBydW5uaW5nYCA6IFwiXCI7XG4gICQoXCJjYW5jZWxhbGxcIikuaGlkZGVuID0gIWNhbGxJZCB8fCBydW5uaW5nIDwgMjtcbiAgZm9yIChjb25zdCB2aWV3IG9mIGFsbCkge1xuICAgIGNvbnN0IHQgPSB2aWV3LmM7XG4gICAgY29uc3Qgd2FpdGluZyA9IHQuc3RhdGUuc3RhcnRzV2l0aChcIndhaXRpbmdcIik7XG4gICAgY29uc3QgY2FyZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgY2FyZC5jbGFzc05hbWUgPSBgdGFzayAke3dhaXRpbmcgPyBcIndhaXRpbmdcIiA6IHQuc3RhdGV9YDtcbiAgICBjb25zdCBhZ2UgPSAodmlldy5lbmRlZCA/PyBub3coKSkgLSB2aWV3LnNpbmNlO1xuICAgIGNhcmQuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9XCJ0b3BcIj48c3BhbiBjbGFzcz1cImJhZGdlICR7dC5hZ2VudCA9PT0gXCJ0M1wiID8gXCJ0M1wiIDogXCJcIn1cIj4ke3QuYWdlbnQgPT09IFwidDNcIiA/IFwiVDNcIiA6IFwiSGVybWVzXCJ9PC9zcGFuPmAgK1xuICAgICAgYDxzcGFuIGNsYXNzPVwibGFiZWxcIj48L3NwYW4+PHNwYW4gY2xhc3M9XCJzdGF0ZVwiPiR7dC5zdGF0ZSA9PT0gXCJydW5uaW5nXCIgPyAnPHNwYW4gY2xhc3M9XCJzcGluXCI+PC9zcGFuPiAnIDogXCJcIn0ke2VzY2FwZUh0bWwodC5zdGF0ZSl9IFx1MDBCNyAke2VsYXBzZWQoYWdlKX08L3NwYW4+PC9kaXY+YCArXG4gICAgICBgPGRpdiBjbGFzcz1cInBcIj48L2Rpdj5gO1xuICAgIGNhcmQucXVlcnlTZWxlY3RvcihcIi5sYWJlbFwiKSEudGV4dENvbnRlbnQgPSB0LmxhYmVsO1xuICAgIGNhcmQucXVlcnlTZWxlY3RvcihcIi5wXCIpIS50ZXh0Q29udGVudCA9IHQucHJvZ3Jlc3MgPz8gdC5yZXF1ZXN0O1xuICAgIGlmICh0LnF1ZXN0aW9uKSB7XG4gICAgICBjb25zdCBxID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgIHEuY2xhc3NOYW1lID0gXCJxXCI7XG4gICAgICBxLnRleHRDb250ZW50ID0gYEFza3M6ICR7dC5xdWVzdGlvbn1gO1xuICAgICAgY2FyZC5hcHBlbmQocSk7XG4gICAgfVxuICAgIGlmICh2aWV3LmFwcHJvdmFsICYmIHQuc3RhdGUgPT09IFwicnVubmluZ1wiKSB7XG4gICAgICBjb25zdCBib3ggPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgICAgYm94LmNsYXNzTmFtZSA9IFwiYXBwcm92YWxcIjtcbiAgICAgIGJveC5pbm5lckhUTUwgPSBgPGRpdj5IZXJtZXMgYXNrcyB0byBydW46PC9kaXY+PGNvZGU+PC9jb2RlPjxkaXYgY2xhc3M9XCJhY3RzXCI+PC9kaXY+YDtcbiAgICAgIGJveC5xdWVyeVNlbGVjdG9yKFwiY29kZVwiKSEudGV4dENvbnRlbnQgPSB2aWV3LmFwcHJvdmFsLmNvbW1hbmQ7XG4gICAgICBjb25zdCBhbnN3ZXIgPSAoY2hvaWNlOiBcIm9uY2VcIiB8IFwiZGVueVwiKSA9PiB7XG4gICAgICAgIHZpZXcuYXBwcm92YWwgPSB1bmRlZmluZWQ7XG4gICAgICAgIHNob3dUYXNrcyh0cnVlKTtcbiAgICAgICAgdm9pZCBmZXRjaChcIi9oZXJtZXMvYXBwcm92YWxcIiwgeyBtZXRob2Q6IFwiUE9TVFwiLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGNhbGw6IGNhbGxOYW1lLCB0YXNrSWQ6IHQuaWQsIGNob2ljZSB9KSB9KVxuICAgICAgICAgIC50aGVuKChyKSA9PiB0b2FzdChyLm9rID8gKGNob2ljZSA9PT0gXCJvbmNlXCIgPyBcIkFwcHJvdmVkXCIgOiBcIkRlbmllZFwiKSA6IFwiVGhhdCBhcHByb3ZhbCBoYWQgYWxyZWFkeSBsYXBzZWRcIikpO1xuICAgICAgfTtcbiAgICAgIGZvciAoY29uc3QgW2xhYmVsLCBjaG9pY2VdIG9mIFtbXCJBcHByb3ZlIG9uY2VcIiwgXCJvbmNlXCJdLCBbXCJEZW55XCIsIFwiZGVueVwiXV0gYXMgY29uc3QpIHtcbiAgICAgICAgY29uc3QgYiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gICAgICAgIGIudGV4dENvbnRlbnQgPSBsYWJlbDtcbiAgICAgICAgaWYgKGNob2ljZSA9PT0gXCJvbmNlXCIpIGIuY2xhc3NOYW1lID0gXCJnb1wiO1xuICAgICAgICBiLm9uY2xpY2sgPSAoKSA9PiBhbnN3ZXIoY2hvaWNlKTtcbiAgICAgICAgYm94LnF1ZXJ5U2VsZWN0b3IoXCIuYWN0c1wiKSEuYXBwZW5kKGIpO1xuICAgICAgfVxuICAgICAgY2FyZC5hcHBlbmQoYm94KTtcbiAgICB9XG4gICAgaWYgKHQuc3RhdGUgIT09IFwicnVubmluZ1wiKSB2aWV3LmFwcHJvdmFsID0gdW5kZWZpbmVkO1xuICAgIGNvbnN0IGFjdHMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGFjdHMuY2xhc3NOYW1lID0gXCJhY3RzXCI7XG4gICAgY29uc3QgYnV0dG9uID0gKHRleHQ6IHN0cmluZywgZm46ICgpID0+IHZvaWQpID0+IHsgY29uc3QgYiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7IGIudGV4dENvbnRlbnQgPSB0ZXh0OyBiLm9uY2xpY2sgPSBmbjsgYWN0cy5hcHBlbmQoYik7IHJldHVybiBiOyB9O1xuICAgIGlmIChjYWxsSWQpIHtcbiAgICAgIGJ1dHRvbih3YWl0aW5nID8gXCJBbnN3ZXJcIiA6IFwiRm9sbG93IHVwXCIsICgpID0+IGZvbGxvd1VwRm9ybShjYXJkLCB0KSk7XG4gICAgICBpZiAodC5zdGF0ZSA9PT0gXCJydW5uaW5nXCIpIGJ1dHRvbihcIkNhbmNlbFwiLCAoKSA9PiBwdXNoKHsgdHlwZTogXCJjYW5jZWxUYXNrXCIsIHRhc2s6IHQuaWQgfSkpO1xuICAgIH1cbiAgICBpZiAodmlldy5yZXN1bHQpIGJ1dHRvbihcIlJlc3VsdFwiLCAoKSA9PiB7IHZpZXcucmVzdWx0IS5zY3JvbGxJbnRvVmlldyh7IGJlaGF2aW9yOiBcInNtb290aFwiLCBibG9jazogXCJjZW50ZXJcIiB9KTsgdmlldy5yZXN1bHQhLmNsYXNzTGlzdC5hZGQoXCJvcGVuXCIpOyB9KTtcbiAgICBpZiAodmlldy50aHJlYWQpIGJ1dHRvbihcIkNvcHkgdGhyZWFkIGlkXCIsICgpID0+IHsgdm9pZCBuYXZpZ2F0b3IuY2xpcGJvYXJkPy53cml0ZVRleHQodmlldy50aHJlYWQhKTsgdG9hc3QoXCJUaHJlYWQgaWQgY29waWVkXCIpOyB9KTtcbiAgICBpZiAoYWN0cy5jaGlsZEVsZW1lbnRDb3VudCkgY2FyZC5hcHBlbmQoYWN0cyk7XG4gICAgcGFuZS5hcHBlbmQoY2FyZCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gZm9sbG93VXBGb3JtKGNhcmQ6IEhUTUxFbGVtZW50LCB0OiBDb21tYW5kKSB7XG4gIGlmIChjYXJkLnF1ZXJ5U2VsZWN0b3IoXCJmb3JtXCIpKSByZXR1cm47XG4gIGNvbnN0IGZvcm0gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZm9ybVwiKTtcbiAgZm9ybS5pbm5lckhUTUwgPSBgPGlucHV0IHR5cGU9XCJ0ZXh0XCIgcGxhY2Vob2xkZXI9XCJUZWxsIFx1MjAxQyR7ZXNjYXBlSHRtbCh0LmxhYmVsKX1cdTIwMURcdTIwMjZcIiBlbnRlcmtleWhpbnQ9XCJzZW5kXCI+PGJ1dHRvbj5TZW5kPC9idXR0b24+YDtcbiAgY29uc3QgaW5wdXQgPSBmb3JtLnF1ZXJ5U2VsZWN0b3IoXCJpbnB1dFwiKSE7XG4gIGZvcm0ub25zdWJtaXQgPSAoZSkgPT4ge1xuICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICBjb25zdCB0ZXh0ID0gaW5wdXQudmFsdWUudHJpbSgpO1xuICAgIGlmICh0ZXh0KSB7IHB1c2goeyB0eXBlOiBcInN0ZWVyXCIsIHRhc2s6IHQuaWQsIHRleHQgfSk7IG5vdGUoYFlvdSBcdTIxOTIgJHt0LmxhYmVsfTogJHt0ZXh0fWApOyB9XG4gICAgaW5wdXQuYmx1cigpO1xuICAgIGZvcm0ucmVtb3ZlKCk7XG4gICAgc2hvd1Rhc2tzKCk7XG4gIH07XG4gIGlucHV0Lm9ua2V5ZG93biA9IChlKSA9PiB7IGlmIChlLmtleSA9PT0gXCJFc2NhcGVcIikgeyBpbnB1dC5ibHVyKCk7IGZvcm0ucmVtb3ZlKCk7IHNob3dUYXNrcygpOyB9IH07XG4gIGNhcmQuYXBwZW5kKGZvcm0pO1xuICBpbnB1dC5mb2N1cygpO1xufVxuXG4vKiogVDMgdGhyZWFkcyBlYXJsaWVyIGNhbGxzIHN0YXJ0ZWQ6IHRoZXkgY2Fycnkgb24gYWZ0ZXIgYSBjYWxsLCBzbyB0aGUgcGFuZWwgc2F5cyBob3cgdGhleSdyZSBkb2luZy4gKi9cbmFzeW5jIGZ1bmN0aW9uIHNob3dFYXJsaWVyKCkge1xuICBsZXQgbGlzdDogeyB0aHJlYWQ6IHN0cmluZzsgdGl0bGU6IHN0cmluZzsgc3RhdHVzOiBzdHJpbmc7IGJyYW5jaDogc3RyaW5nIHwgbnVsbDsgcHI6IHN0cmluZyB8IG51bGw7IHVwZGF0ZWQ6IHN0cmluZzsgbGFzdDogc3RyaW5nOyB3YWl0aW5nOiBib29sZWFuIH1bXSA9IFtdO1xuICB0cnkgeyBsaXN0ID0gYXdhaXQgKGF3YWl0IGZldGNoKFwiL2FnZW50L3JlY2VudFwiLCB7IGNhY2hlOiBcIm5vLXN0b3JlXCIgfSkpLmpzb24oKTsgfSBjYXRjaCB7fVxuICBjb25zdCBjdXJyZW50ID0gbmV3IFNldChbLi4udGFza3MudmFsdWVzKCldLm1hcCgodikgPT4gdi50aHJlYWQpLmZpbHRlcihCb29sZWFuKSk7XG4gIGxpc3QgPSBsaXN0LmZpbHRlcigodCkgPT4gIWN1cnJlbnQuaGFzKHQudGhyZWFkKSk7XG4gICQoXCJlYXJsaWVyYm94XCIpLmhpZGRlbiA9IGxpc3QubGVuZ3RoID09PSAwO1xuICBjb25zdCBwYW5lID0gJChcImVhcmxpZXJcIik7XG4gIHBhbmUuaW5uZXJIVE1MID0gXCJcIjtcbiAgZm9yIChjb25zdCB0IG9mIGxpc3QpIHtcbiAgICBjb25zdCBjYXJkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBjb25zdCBzdGF0ZSA9IHQud2FpdGluZyA/IFwid2FpdGluZyBmb3IgYXBwcm92YWwgaW4gVDNcIiA6IHQuc3RhdHVzO1xuICAgIGNhcmQuY2xhc3NOYW1lID0gYHRhc2sgJHt0LnN0YXR1cyA9PT0gXCJydW5uaW5nXCIgPyBcInJ1bm5pbmdcIiA6IHQud2FpdGluZyA/IFwid2FpdGluZ1wiIDogXCJmaW5pc2hlZFwifWA7XG4gICAgY29uc3QgYWdvID0gTWF0aC5tYXgoMCwgKERhdGUubm93KCkgLSBEYXRlLnBhcnNlKHQudXBkYXRlZCkpIC8gMTAwMCk7XG4gICAgY2FyZC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz1cInRvcFwiPjxzcGFuIGNsYXNzPVwiYmFkZ2UgdDNcIj5UMzwvc3Bhbj48c3BhbiBjbGFzcz1cImxhYmVsXCI+PC9zcGFuPmAgK1xuICAgICAgYDxzcGFuIGNsYXNzPVwic3RhdGVcIj4ke3Quc3RhdHVzID09PSBcInJ1bm5pbmdcIiA/ICc8c3BhbiBjbGFzcz1cInNwaW5cIj48L3NwYW4+ICcgOiBcIlwifSR7ZXNjYXBlSHRtbChzdGF0ZSl9IFx1MDBCNyAke2VsYXBzZWQoYWdvKX0gYWdvPC9zcGFuPjwvZGl2PjxkaXYgY2xhc3M9XCJwXCI+PC9kaXY+YDtcbiAgICBjYXJkLnF1ZXJ5U2VsZWN0b3IoXCIubGFiZWxcIikhLnRleHRDb250ZW50ID0gdC50aXRsZTtcbiAgICBjYXJkLnF1ZXJ5U2VsZWN0b3IoXCIucFwiKSEudGV4dENvbnRlbnQgPSB0Lmxhc3QgfHwgKHQuYnJhbmNoID8gYE9uICR7dC5icmFuY2h9YCA6IFwiXCIpO1xuICAgIGNvbnN0IGFjdHMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGFjdHMuY2xhc3NOYW1lID0gXCJhY3RzXCI7XG4gICAgaWYgKHQucHIpIHsgY29uc3QgYSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJhXCIpOyBhLmhyZWYgPSB0LnByOyBhLnRhcmdldCA9IFwiX2JsYW5rXCI7IGEucmVsID0gXCJub29wZW5lclwiOyBhLnRleHRDb250ZW50ID0gXCJQdWxsIHJlcXVlc3RcIjsgYWN0cy5hcHBlbmQoYSk7IH1cbiAgICBjb25zdCBjb3B5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgICBjb3B5LnRleHRDb250ZW50ID0gXCJDb3B5IHRocmVhZCBpZFwiO1xuICAgIGNvcHkub25jbGljayA9ICgpID0+IHsgdm9pZCBuYXZpZ2F0b3IuY2xpcGJvYXJkPy53cml0ZVRleHQodC50aHJlYWQpOyB0b2FzdChcIlRocmVhZCBpZCBjb3BpZWRcIik7IH07XG4gICAgYWN0cy5hcHBlbmQoY29weSk7XG4gICAgY2FyZC5hcHBlbmQoYWN0cyk7XG4gICAgcGFuZS5hcHBlbmQoY2FyZCk7XG4gIH1cbn1cblxuY29uc3QgU1RBVFVTX1RFWFQ6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gIGlkbGU6IFwiSWRsZVwiLCBjb25uZWN0aW5nOiBcIkNvbm5lY3RpbmdcdTIwMjZcIiwgbGlzdGVuaW5nOiBcIkxpc3RlbmluZ1wiLCB3b3JraW5nOiBcIkxpc3RlbmluZyBcdTAwQjcgdGFza3MgcnVubmluZ1wiLFxuICBzdGFuZGJ5OiBcIlBhdXNlZCB3aGlsZSB0YXNrcyBydW4gXHUwMEI3IHNwZWFrIHRvIHJlc3VtZVwiLCB3YWtpbmc6IFwiUmVzdW1pbmdcdTIwMjZcIiwgZW5kZWQ6IFwiRW5kZWRcIixcbn07XG5cbmZ1bmN0aW9uIHNob3dTdGF0dXMobWVzc2FnZT86IHN0cmluZykge1xuICBjb25zdCBzcGVha2luZyA9IGNhbGxJZCAmJiBjb3JlU3RhdHVzICE9PSBcInN0YW5kYnlcIiAmJiBhdWRpby5xdWV1ZWQgPiAwLjA1O1xuICBjb25zdCBzaG93biA9IHNwZWFraW5nID8gXCJzcGVha2luZ1wiIDogY29yZVN0YXR1cztcbiAgJChcInN0YXR1c1wiKS5jbGFzc05hbWUgPSBzaG93bjtcbiAgbGV0IHRleHQgPSBzcGVha2luZyA/IFwiU3BlYWtpbmdcIiA6IFNUQVRVU19URVhUW2NvcmVTdGF0dXNdID8/IGNvcmVTdGF0dXM7XG4gIGlmIChjYWxsSWQgJiYgbXV0ZWQgJiYgIWhvbGRpbmcgJiYgIXNwZWFraW5nKSB0ZXh0ICs9IFwiIFx1MDBCNyBtdXRlZFwiO1xuICBpZiAoaG9sZGluZykgdGV4dCA9IFwiVGFsa2luZyAoaG9sZClcIjtcbiAgaWYgKG1lc3NhZ2UpIHRleHQgPSBgJHt0ZXh0fTogJHttZXNzYWdlfWA7XG4gIGlmIChjb3JlU3RhdHVzICE9PSBcImVuZGVkXCIgfHwgbWVzc2FnZSkgJChcInN0YXR1c3RleHRcIikudGV4dENvbnRlbnQgPSB0ZXh0O1xuICAkPEhUTUxCdXR0b25FbGVtZW50PihcImh1c2hcIikuY2xhc3NMaXN0LnRvZ2dsZShcImxpdmVcIiwgQm9vbGVhbihzcGVha2luZykpO1xufVxuXG4vLyBUaGUgY2FsbC5cblxuZnVuY3Rpb24gcHVzaChldmVudDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIHtcbiAgaWYgKCFjb3JlIHx8ICFjYWxsSWQpIHJldHVybjtcbiAgY29uc3QgZTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7IC4uLmV2ZW50LCB0OiBub3coKSB9O1xuICBjb25zdCBxdWlldCA9IGUudHlwZSA9PT0gXCJtaWNcIiB8fCBlLnR5cGUgPT09IFwidGlja1wiO1xuICBpZiAoIXF1aWV0KSBsb2coXCJpblwiLCBlLnR5cGUgPT09IFwid3MubWVzc2FnZVwiID8gYHdzICR7ZS5zaWR9IFx1MjE5MCAke2JyaWVmKFN0cmluZyhlLmRhdGEpKX1gIDogSlNPTi5zdHJpbmdpZnkoZSkuc2xpY2UoMCwgNDAwKSwgXCJpblwiKTtcbiAgcnVuKEpTT04ucGFyc2UoY29yZS5wdXNoKGNhbGxJZCwgSlNPTi5zdHJpbmdpZnkoZSkpKSk7XG59XG5cbmZ1bmN0aW9uIHJ1bihjb21tYW5kczogQ29tbWFuZFtdKSB7XG4gIGZvciAoY29uc3QgYyBvZiBjb21tYW5kcykge1xuICAgIHN3aXRjaCAoYy50eXBlKSB7XG4gICAgICBjYXNlIFwid3MuY29ubmVjdFwiOiBjb25uZWN0KGMuc2lkLCBjLnB1cnBvc2UgPT09IFwiY2FwdGlvbnNcIik7IGJyZWFrO1xuICAgICAgY2FzZSBcIndzLnNlbmRcIjoge1xuICAgICAgICBzb2NrZXRzLmdldChjLnNpZCk/LnNlbmQoYy5kYXRhKTtcbiAgICAgICAgaWYgKCFjLmRhdGEuc3RhcnRzV2l0aCgne1wicmVhbHRpbWVJbnB1dFwiOntcImF1ZGlvXCInKSkgbG9nKFwib3V0XCIsIGB3cyAke2Muc2lkfSBcdTIxOTIgJHticmllZihjLmRhdGEpfWAsIFwib3V0XCIpO1xuICAgICAgICBlbHNlIGlmICghY2FwdGlvblNvY2tldHMuaGFzKGMuc2lkKSkgY291bnRzLnNlbnQrKztcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwid3MuY2xvc2VcIjogc29ja2V0cy5nZXQoYy5zaWQpPy5jbG9zZSgpOyBzb2NrZXRzLmRlbGV0ZShjLnNpZCk7IGxvZyhcIm91dFwiLCBgd3MgJHtjLnNpZH0gY2xvc2VgLCBcIm91dFwiKTsgYnJlYWs7XG4gICAgICBjYXNlIFwibWljLnN0YXJ0XCI6XG4gICAgICBjYXNlIFwibWljLnJlc3RhcnRcIjpcbiAgICAgICAgbG9nKFwib3V0XCIsIGMudHlwZSwgXCJvdXRcIik7XG4gICAgICAgIHZvaWQgYXVkaW8uc3RhcnRNaWMob25NaWMsIG1pY09wdGlvbnMoKSkuY2F0Y2goKGVycikgPT4geyBsb2coXCJlcnJvclwiLCBgbWljcm9waG9uZTogJHtlcnIubWVzc2FnZX1gLCBcImVyclwiKTsgdG9hc3QoYE1pY3JvcGhvbmU6ICR7ZXJyLm1lc3NhZ2V9YCk7IH0pO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJtaWMuc3RvcFwiOiBhdWRpby5zdG9wTWljKCk7IGJyZWFrO1xuICAgICAgY2FzZSBcInBsYXlcIjoge1xuICAgICAgICBjb25zdCB0ID0gbm93KCk7XG4gICAgICAgIC8vIEEgcmVwbHkgc3RhcnRpbmc6IGZyb20gdGhlIGVuZCBvZiB0aGUgdXNlcidzIHNwZWVjaCB0byBpdHMgZmlyc3Qgc291bmQuXG4gICAgICAgIGlmICghbWV0cmljcy5yZXBsaWVkICYmIGF1ZGlvLnF1ZXVlZCA8IDAuMDUgJiYgdCAtIG1ldHJpY3MubGFzdFBsYXkgPiAwLjYgJiYgbWV0cmljcy5sYXN0Vm9pY2UgPiAwICYmIHQgLSBtZXRyaWNzLmxhc3RWb2ljZSA8IDEwKSB7XG4gICAgICAgICAgbWV0cmljcy5yZXBseS5wdXNoKHQgLSBtZXRyaWNzLmxhc3RWb2ljZSk7XG4gICAgICAgICAgaWYgKG1ldHJpY3MucmVwbHkubGVuZ3RoID4gMjApIG1ldHJpY3MucmVwbHkuc2hpZnQoKTtcbiAgICAgICAgICBtZXRyaWNzLnJlcGxpZWQgPSB0cnVlO1xuICAgICAgICAgIHNob3dNZXRyaWNzKCk7XG4gICAgICAgIH1cbiAgICAgICAgbWV0cmljcy5sYXN0UGxheSA9IHQ7XG4gICAgICAgIGF1ZGlvLnBsYXkoYy5wY20pO1xuICAgICAgICBjb3VudHMucGxheSsrO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJmbHVzaFwiOiBhdWRpby5mbHVzaCgpOyBsb2coXCJvdXRcIiwgXCJmbHVzaFwiLCBcIm91dFwiKTsgYnJlYWs7XG4gICAgICBjYXNlIFwiY3VlXCI6XG4gICAgICAgIGF1ZGlvLmN1ZShjLnBjbSk7XG4gICAgICAgIGxvZyhcIm91dFwiLCBgY3VlICR7Yy5lYXJjb259YCwgXCJvdXRcIik7XG4gICAgICAgIC8vIEEgcmVxdWVzdCB0aGF0IGJlY2FtZSBhIHRhc2sgZ2V0cyBhIHRvbmUsIG5vdCBhIHNwb2tlbiByZXBseTogbm90aGluZyB0byB0aW1lLlxuICAgICAgICBpZiAoYy5lYXJjb24gPT09IFwidGFza1N0YXJ0ZWRcIikgbWV0cmljcy5yZXBsaWVkID0gdHJ1ZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwid2FrZXdvcmRcIjogbG9nKFwib3V0XCIsIGB3YWtlIHdvcmQgJHtjLm9uID8gXCJsaXN0ZW5pbmdcIiA6IFwib2ZmXCJ9YCwgXCJvdXRcIik7IGJyZWFrO1xuICAgICAgY2FzZSBcInRvb2wuY2FsbFwiOiB2b2lkIHRvb2woYyk7IGJyZWFrO1xuICAgICAgY2FzZSBcInRvb2wuY2FuY2VsXCI6IGNhbmNlbFJ1bihjLnJ1biwgYy5yZWFzb24pOyBicmVhaztcbiAgICAgIGNhc2UgXCJ0b29sLnN0ZWVyXCI6IHZvaWQgc3RlZXJSdW4oYyk7IGJyZWFrO1xuICAgICAgY2FzZSBcInN0YXR1c1wiOlxuICAgICAgICBjb3JlU3RhdHVzID0gYy5zdGF0dXM7XG4gICAgICAgIHNob3dTdGF0dXMoYy5zdGF0dXMgPT09IFwiZW5kZWRcIiA/IGMubWVzc2FnZSA/PyB1bmRlZmluZWQgOiB1bmRlZmluZWQpO1xuICAgICAgICBsb2coXCJzdGF0dXNcIiwgYy5zdGF0dXMgKyAoYy5tZXNzYWdlID8gYDogJHtjLm1lc3NhZ2V9YCA6IFwiXCIpLCBcInN0YXR1c1wiKTtcbiAgICAgICAgaWYgKGMuc3RhdHVzID09PSBcImVuZGVkXCIpIHsgaWYgKGMubWVzc2FnZSkgbm90ZShjLm1lc3NhZ2UpOyBlbmQoKTsgfVxuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJjYXB0aW9uXCI6IGNhcHRpb24oYy50ZXh0KTsgYnJlYWs7XG4gICAgICBjYXNlIFwidHJhbnNjcmlwdFwiOlxuICAgICAgICB0cmFuc2NyaXB0KGMucm9sZSwgYy50ZXh0KTtcbiAgICAgICAgcmVtZW1iZXIoYy5yb2xlLCBjLnRleHQsIGMucm9sZSA9PT0gXCJhc3Npc3RhbnRcIiA/IFwiR2VtaW5pXCIgOiB1bmRlZmluZWQsIGxhc3RSb2xlID09PSBjLnJvbGUpO1xuICAgICAgICBsYXN0Um9sZSA9IGMucm9sZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwidGFza1wiOiB7XG4gICAgICAgIGNvbnN0IHZpZXcgPSB0YXNrcy5nZXQoYy5pZCkgPz8geyBjLCBzaW5jZTogbm93KCksIGVuZGVkOiBudWxsIH07XG4gICAgICAgIGlmIChjLnN0YXRlID09PSBcInJ1bm5pbmdcIiAmJiB2aWV3LmMuc3RhdGUgIT09IFwicnVubmluZ1wiKSB7IHZpZXcuc2luY2UgPSBub3coKTsgdmlldy5lbmRlZCA9IG51bGw7IH1cbiAgICAgICAgaWYgKGMuc3RhdGUgIT09IFwicnVubmluZ1wiICYmIHZpZXcuZW5kZWQgPT0gbnVsbCkgdmlldy5lbmRlZCA9IG5vdygpO1xuICAgICAgICB2aWV3LmMgPSBjO1xuICAgICAgICB0YXNrcy5zZXQoYy5pZCwgdmlldyk7XG4gICAgICAgIHNob3dUYXNrcygpO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJxdWVzdGlvbnNcIjogYnJlYWs7XG4gICAgICBjYXNlIFwibWljU2lsZW50XCI6ICQoXCJtaWN3YXJuXCIpLmhpZGRlbiA9ICFjLnNpbGVudDsgYnJlYWs7XG4gICAgICBjYXNlIFwidm9pY2VDb21tYW5kXCI6XG4gICAgICAgIHRvYXN0KGBIZWFyZCBcdTIwMUMke2MuaGVhcmR9XHUyMDFEOiAke2MuY29tbWFuZCA9PT0gXCJzdG9wXCIgPyBcInN0b3BwZWRcIiA6IGMuY29tbWFuZCA9PT0gXCJjYW5jZWxBbGxcIiA/IFwiY2FuY2VsbGluZyBldmVyeSB0YXNrXCIgOiBcImhhbmdpbmcgdXBcIn1gKTtcbiAgICAgICAgbG9nKFwib3V0XCIsIGB2b2ljZSBjb21tYW5kICR7Yy5jb21tYW5kfTogJHtjLmhlYXJkfWAsIFwib3V0XCIpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJsb2dcIjogbG9nKGMubGV2ZWwsIGMubWVzc2FnZSwgYy5sZXZlbCA9PT0gXCJ3YXJuXCIgPyBcIndhcm5cIiA6IFwiXCIpOyBicmVhaztcbiAgICAgIGRlZmF1bHQ6IGxvZyhcIm91dFwiLCBKU09OLnN0cmluZ2lmeShjKS5zbGljZSgwLCAzMDApLCBcIm91dFwiKTtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gb25NaWMocGNtOiBzdHJpbmcsIGxldmVsOiBudW1iZXIpIHtcbiAgY291bnRzLm1pYysrO1xuICBpZiAobGV2ZWwgPiAwLjAzICYmICEobXV0ZWQgJiYgIWhvbGRpbmcpKSB7XG4gICAgbWV0cmljcy5sYXN0Vm9pY2UgPSBub3coKTtcbiAgICBpZiAoYXVkaW8ucXVldWVkIDwgMC4wNSkgbWV0cmljcy5yZXBsaWVkID0gZmFsc2U7XG4gIH1cbiAgcHVzaCh7IHR5cGU6IFwibWljXCIsIHBjbSB9KTtcbn1cblxuZnVuY3Rpb24gY29ubmVjdChzaWQ6IG51bWJlciwgY2FwdGlvbnM6IGJvb2xlYW4pIHtcbiAgY29uc3Qgd3MgPSBuZXcgV2ViU29ja2V0KGAke2xvY2F0aW9uLnByb3RvY29sID09PSBcImh0dHBzOlwiID8gXCJ3c3NcIiA6IFwid3NcIn06Ly8ke2xvY2F0aW9uLmhvc3R9L2xpdmUke2NhcHRpb25zID8gXCI/Zm9yPWNhcHRpb25zXCIgOiBcIlwifWApO1xuICBzb2NrZXRzLnNldChzaWQsIHdzKTtcbiAgaWYgKGNhcHRpb25zKSBjYXB0aW9uU29ja2V0cy5hZGQoc2lkKTtcbiAgbG9nKFwib3V0XCIsIGB3cyAke3NpZH0gY29ubmVjdCAoJHtzZXJ2ZXIucm91dGV9JHtjYXB0aW9ucyA/IFwiLCBjYXB0aW9uc1wiIDogXCJcIn0pYCwgXCJvdXRcIik7XG4gIHdzLm9ub3BlbiA9ICgpID0+IHB1c2goeyB0eXBlOiBcIndzLm9wZW5cIiwgc2lkIH0pO1xuICB3cy5vbm1lc3NhZ2UgPSAobSkgPT4gcHVzaCh7IHR5cGU6IFwid3MubWVzc2FnZVwiLCBzaWQsIGRhdGE6IHR5cGVvZiBtLmRhdGEgPT09IFwic3RyaW5nXCIgPyBtLmRhdGEgOiBcIlwiIH0pO1xuICB3cy5vbmNsb3NlID0gKGUpID0+IHtcbiAgICBpZiAoc29ja2V0cy5nZXQoc2lkKSAhPT0gd3MgJiYgc29ja2V0cy5oYXMoc2lkKSkgcmV0dXJuO1xuICAgIGNvbnN0IGh0dHBTdGF0dXMgPSBlLmNvZGUgPj0gNDEwMCAmJiBlLmNvZGUgPCA0NjAwID8gZS5jb2RlIC0gNDAwMCA6IHVuZGVmaW5lZDtcbiAgICBwdXNoKHsgdHlwZTogXCJ3cy5jbG9zZWRcIiwgc2lkLCBjb2RlOiBodHRwU3RhdHVzID8gdW5kZWZpbmVkIDogZS5jb2RlLCByZWFzb246IGUucmVhc29uLCBodHRwU3RhdHVzIH0pO1xuICB9O1xufVxuXG5mdW5jdGlvbiBjYW5jZWxSdW4oa2V5OiBzdHJpbmcsIHJlYXNvbjogc3RyaW5nKSB7XG4gIGNvbnN0IHIgPSBydW5zLmdldChrZXkpO1xuICBsb2coXCJvdXRcIiwgYGNhbmNlbCAke2tleX0gKCR7cmVhc29ufSlgLCBcIm91dFwiKTtcbiAgaWYgKCFyKSByZXR1cm47XG4gIHJ1bnMuZGVsZXRlKGtleSk7XG4gIHIuYWJvcnQuYWJvcnQoKTtcbiAgLy8gQ2FuY2VsbGVkIG9uIHB1cnBvc2U6IHRoZSBhZ2VudCBzdG9wcyB0b28uIEEgY2FsbCB0aGF0IGVuZGVkIGxlYXZlcyBhIGNvZGluZyBhZ2VudCB3b3JraW5nIGluIFQzLlxuICBpZiAocmVhc29uID09PSBcImNhbmNlbGxlZFwiICYmICFjaGVja2VkKFwiZmFrZWhlcm1lc1wiKSkge1xuICAgIHZvaWQgZmV0Y2goci5hZ2VudCA9PT0gXCJ0M1wiID8gXCIvYWdlbnQvY2FuY2VsXCIgOiBcIi9oZXJtZXMvc3RvcFwiLCB7IG1ldGhvZDogXCJQT1NUXCIsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgY2FsbDogY2FsbE5hbWUsIHRhc2tJZDogci50YXNrSWQgfSkgfSk7XG4gIH1cbn1cblxuLyoqIE1vcmUgZm9yIGEgcnVubmluZyB0YXNrLCBpbnRvIGl0cyBjdXJyZW50IHJ1bjsgaWYgdGhlIGFnZW50IHdvbid0IHRha2UgaXQsIHRoZSBjb3JlIHF1ZXVlcyBpdCBpbnN0ZWFkLiAqL1xuYXN5bmMgZnVuY3Rpb24gc3RlZXJSdW4oYzogQ29tbWFuZCkge1xuICBjb25zdCByID0gcnVucy5nZXQoYy5ydW4pO1xuICBsb2coXCJvdXRcIiwgYHN0ZWVyICR7Yy5ydW59OiAke2MudGV4dH1gLCBcIm91dFwiKTtcbiAgaWYgKGNoZWNrZWQoXCJmYWtlaGVybWVzXCIpKSByZXR1cm47XG4gIGNvbnN0IG9rID0gciAhPSBudWxsICYmXG4gICAgKGF3YWl0IGZldGNoKGMuYWdlbnQgPT09IFwidDNcIiA/IFwiL2FnZW50L3N0ZWVyXCIgOiBcIi9oZXJtZXMvc3RlZXJcIiwgeyBtZXRob2Q6IFwiUE9TVFwiLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGNhbGw6IGNhbGxOYW1lLCB0YXNrSWQ6IHIudGFza0lkLCB0ZXh0OiBjLm1lc3NhZ2UgfSkgfSkudGhlbigoeCkgPT4geC5vaywgKCkgPT4gZmFsc2UpKTtcbiAgaWYgKCFvaykgcHVzaCh7IHR5cGU6IFwidG9vbC5zdGVlckZhaWxlZFwiLCBydW46IGMucnVuLCB0ZXh0OiBjLnRleHQgfSk7XG4gIGVsc2UgdG9hc3QoYCR7Yy5hZ2VudCA9PT0gXCJ0M1wiID8gXCJUaGUgY29kaW5nIGFnZW50XCIgOiBcIkhlcm1lc1wifSB0b29rIHRoZSBmb2xsb3ctdXAgd2hpbGUgaXQgd29ya3NgKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gdG9vbChjOiBDb21tYW5kKSB7XG4gIGlmIChjLmtpbmQgPT09IFwiaG9zdFwiKSB7XG4gICAgbG9nKFwib3V0XCIsIGBob3N0IHRvb2wgJHtjLm5hbWV9ICR7SlNPTi5zdHJpbmdpZnkoYy5hcmdzKX1gLCBcIm91dFwiKTtcbiAgICBjb25zdCBhbnN3ZXIgPSBjLm5hbWUgPT09IFwidHZfdm9sdW1lXCIgPyBgVGhlIFRWIGlzIGF0ICR7KGZha2VUdkxldmVsID0gTnVtYmVyKGMuYXJncz8ubGV2ZWwgPz8gZmFrZVR2TGV2ZWwpKX0uYFxuICAgICAgOiBjLm5hbWUgPT09IFwidHZfcGF1c2VcIiA/IChjLmFyZ3M/LnBhdXNlID09PSBmYWxzZSA/IFwiUGxheWluZy5cIiA6IFwiUGF1c2VkLlwiKSA6IFwiRG9uZS5cIjtcbiAgICBzZXRUaW1lb3V0KCgpID0+IHB1c2goeyB0eXBlOiBcInRvb2wucmVzdWx0XCIsIHJ1bjogYy5ydW4sIHRleHQ6IGFuc3dlciB9KSwgMzAwKTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgYWdlbnQgPSBjLmFnZW50ID09PSBcInQzXCIgPyBcInQzXCIgOiBcImhlcm1lc1wiO1xuICBsb2coXCJvdXRcIiwgYCR7YWdlbnR9ICR7Yy5mb2xsb3dVcCA/IFwiZm9sbG93LXVwXCIgOiBcInRhc2tcIn0gXCIke2MubGFiZWx9XCIke2MucHJvamVjdCA/IGAgaW4gJHtjLnByb2plY3R9YCA6IFwiXCJ9OiAke2MucmVxdWVzdH1gLCBcIm91dFwiKTtcbiAgY29uc3QgYWJvcnQgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gIHJ1bnMuc2V0KGMucnVuLCB7IGFib3J0LCBhZ2VudCwgdGFza0lkOiBjLnRhc2tJZCB9KTtcbiAgY29uc3QgZG9uZSA9ICh0ZXh0OiBzdHJpbmcsIGZhaWxlZCA9IGZhbHNlKSA9PiB7XG4gICAgaWYgKCFydW5zLmhhcyhjLnJ1bikpIHJldHVybjtcbiAgICBydW5zLmRlbGV0ZShjLnJ1bik7XG4gICAgY29uc3QgdmlldyA9IHRhc2tzLmdldChjLnRhc2tJZCk7XG4gICAgY29uc3Qgcm93ID0gcmVzdWx0KGFnZW50LCBjLmxhYmVsLCB0ZXh0LCBmYWlsZWQpO1xuICAgIG5vdGlmeShgJHthZ2VudCA9PT0gXCJ0M1wiID8gXCJUM1wiIDogXCJIZXJtZXNcIn0gXHUwMEI3ICR7Yy5sYWJlbH1gLCB0ZXh0KTtcbiAgICBpZiAoIWZhaWxlZCkgeyByZW1lbWJlcihcImFzc2lzdGFudFwiLCB0ZXh0LCBgJHthZ2VudCA9PT0gXCJ0M1wiID8gXCJUM1wiIDogXCJIZXJtZXNcIn0gXHUwMEI3ICR7Yy5sYWJlbH1gKTsgbGFzdFJvbGUgPSBcIlwiOyB9XG4gICAgaWYgKHZpZXcpIHsgdmlldy5yZXN1bHQgPSByb3c7IHNob3dUYXNrcygpOyB9XG4gICAgcHVzaCh7IHR5cGU6IFwidG9vbC5yZXN1bHRcIiwgcnVuOiBjLnJ1biwgdGV4dCwgZmFpbGVkIH0pO1xuICB9O1xuICBpZiAoY2hlY2tlZChcImZha2VoZXJtZXNcIikpIHtcbiAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4gZG9uZShgKEZha2UgJHthZ2VudCA9PT0gXCJ0M1wiID8gXCJUM1wiIDogXCJIZXJtZXNcIn0pIERvbmU6IFx1MjAxQyR7Yy5yZXF1ZXN0fVx1MjAxRC4gTm90aGluZyB3YXMgYWN0dWFsbHkgcnVuLmApLCBOdW1iZXIoJDxIVE1MSW5wdXRFbGVtZW50PihcImZha2VkZWxheVwiKS52YWx1ZSkgKiAxMDAwKTtcbiAgICBhYm9ydC5zaWduYWwub25hYm9ydCA9ICgpID0+IGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgcmV0dXJuO1xuICB9XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChhZ2VudCA9PT0gXCJ0M1wiID8gXCIvYWdlbnRcIiA6IFwiL2hlcm1lc1wiLCB7XG4gICAgICBtZXRob2Q6IFwiUE9TVFwiLCBzaWduYWw6IGFib3J0LnNpZ25hbCwgaGVhZGVyczogeyBcImNvbnRlbnQtdHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBjYWxsOiBjYWxsTmFtZSwgdGFza0lkOiBjLnRhc2tJZCwgZm9sbG93VXA6IGMuZm9sbG93VXAsIG1lc3NhZ2U6IGMubWVzc2FnZSwgbGFiZWw6IGMubGFiZWwsIHJlcXVlc3Q6IGMucmVxdWVzdCwgcHJvamVjdDogYy5wcm9qZWN0LCBhcHByb3ZhbHM6IFwic2NyZWVuXCIgfSksXG4gICAgfSk7XG4gICAgaWYgKCFyZXNwb25zZS5vayB8fCAhcmVzcG9uc2UuYm9keSkgdGhyb3cgbmV3IEVycm9yKGBIVFRQICR7cmVzcG9uc2Uuc3RhdHVzfWApO1xuICAgIGNvbnN0IHJlYWRlciA9IHJlc3BvbnNlLmJvZHkucGlwZVRocm91Z2gobmV3IFRleHREZWNvZGVyU3RyZWFtKCkpLmdldFJlYWRlcigpO1xuICAgIGxldCBidWZmZXIgPSBcIlwiO1xuICAgIGZvciAoOzspIHtcbiAgICAgIGNvbnN0IHsgdmFsdWUsIGRvbmU6IGZpbmlzaGVkIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpO1xuICAgICAgaWYgKGZpbmlzaGVkKSBicmVhaztcbiAgICAgIGJ1ZmZlciArPSB2YWx1ZTtcbiAgICAgIGxldCBjdXQ7XG4gICAgICB3aGlsZSAoKGN1dCA9IGJ1ZmZlci5pbmRleE9mKFwiXFxuXFxuXCIpKSA+PSAwKSB7XG4gICAgICAgIGNvbnN0IGJsb2NrID0gYnVmZmVyLnNsaWNlKDAsIGN1dCk7XG4gICAgICAgIGJ1ZmZlciA9IGJ1ZmZlci5zbGljZShjdXQgKyAyKTtcbiAgICAgICAgY29uc3QgZXZlbnQgPSBibG9jay5tYXRjaCgvXmV2ZW50OiAoLiopJC9tKT8uWzFdO1xuICAgICAgICBpZiAoIWV2ZW50KSBjb250aW51ZTtcbiAgICAgICAgY29uc3QgZGF0YSA9IEpTT04ucGFyc2UoYmxvY2subWF0Y2goL15kYXRhOiAoLiopJC9tKT8uWzFdID8/IFwie31cIik7XG4gICAgICAgIGlmIChldmVudCA9PT0gXCJwcm9ncmVzc1wiKSBwdXNoKHsgdHlwZTogXCJ0YXNrLnByb2dyZXNzXCIsIHRhc2s6IGMudGFza0lkLCB0ZXh0OiBkYXRhLnRleHQgfSk7XG4gICAgICAgIGVsc2UgaWYgKGV2ZW50ID09PSBcInRocmVhZFwiKSB7IGNvbnN0IHZpZXcgPSB0YXNrcy5nZXQoYy50YXNrSWQpOyBpZiAodmlldykgeyB2aWV3LnRocmVhZCA9IGRhdGEudGhyZWFkOyBzaG93VGFza3MoKTsgfSB9XG4gICAgICAgIGVsc2UgaWYgKGV2ZW50ID09PSBcImFwcHJvdmFsXCIpIHtcbiAgICAgICAgICBjb25zdCB2aWV3ID0gdGFza3MuZ2V0KGMudGFza0lkKTtcbiAgICAgICAgICBpZiAodmlldykgeyB2aWV3LmFwcHJvdmFsID0geyBjb21tYW5kOiBkYXRhLmNvbW1hbmQgfTsgc2hvd1Rhc2tzKHRydWUpOyB9XG4gICAgICAgICAgdG9hc3QoYEhlcm1lcyBhc2tzIHRvIHJ1bjogJHtkYXRhLmNvbW1hbmQuc2xpY2UoMCwgODApfWApO1xuICAgICAgICAgIG5vdGlmeShgSGVybWVzIFx1MDBCNyAke2MubGFiZWx9IG5lZWRzIHlvdXIgYXBwcm92YWxgLCBkYXRhLmNvbW1hbmQpO1xuICAgICAgICAgIGF1ZGlvLmN1ZShBUFBST1ZBTF9UT05FKTtcbiAgICAgICAgfVxuICAgICAgICBlbHNlIGlmIChldmVudCA9PT0gXCJyZXN1bHRcIikgZG9uZShkYXRhLnRleHQsIGRhdGEuZmFpbGVkKTtcbiAgICAgICAgZWxzZSBpZiAoZXZlbnQgPT09IFwiZXJyb3JcIikgeyBydW5zLmRlbGV0ZShjLnJ1bik7IHB1c2goeyB0eXBlOiBcInRvb2wuZXJyb3JcIiwgcnVuOiBjLnJ1biwgbWVzc2FnZTogZGF0YS5tZXNzYWdlIH0pOyB9XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChydW5zLmhhcyhjLnJ1bikpIHsgcnVucy5kZWxldGUoYy5ydW4pOyBwdXNoKHsgdHlwZTogXCJ0b29sLmVycm9yXCIsIHJ1bjogYy5ydW4sIG1lc3NhZ2U6IFwidGhlIHNlcnZlciBjbG9zZWQgdGhlIHN0cmVhbSB3aXRob3V0IGEgcmVzdWx0XCIgfSk7IH1cbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgaWYgKCFhYm9ydC5zaWduYWwuYWJvcnRlZCAmJiBydW5zLmhhcyhjLnJ1bikpIHsgcnVucy5kZWxldGUoYy5ydW4pOyBwdXNoKHsgdHlwZTogXCJ0b29sLmVycm9yXCIsIHJ1bjogYy5ydW4sIG1lc3NhZ2U6IChlcnIgYXMgRXJyb3IpLm1lc3NhZ2UgfSk7IH1cbiAgfVxufVxuXG5mdW5jdGlvbiBtaWNPcHRpb25zKCkge1xuICBjb25zdCBhZWMgPSBjaGVja2VkKFwiYWVjXCIpO1xuICByZXR1cm4geyBlY2hvQ2FuY2VsbGF0aW9uOiBhZWMsIG5vaXNlU3VwcHJlc3Npb246IGFlYywgYXV0b0dhaW5Db250cm9sOiBhZWMgfTtcbn1cblxuZnVuY3Rpb24gcmVhZENvbmZpZygpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gIGNvbnN0IGdpdmVuID0gSlNPTi5wYXJzZSgkPEhUTUxUZXh0QXJlYUVsZW1lbnQ+KFwiY29uZmlnXCIpLnZhbHVlKTtcbiAgY29uc3QgY29uZmlnOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICBtb2RlbDogc2VydmVyLm1vZGVsLCBhcGk6IHNlcnZlci5yb3V0ZSA9PT0gXCJ2ZXJ0ZXhcIiA/IFwidmVydGV4XCIgOiBcImdlbWluaVwiLCB0b2RheTogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLnNsaWNlKDAsIDEwKSxcbiAgICAuLi5naXZlbiwgdHJhY2U6IGNoZWNrZWQoXCJ0cmFjZVwiKSxcbiAgfTtcbiAgaWYgKGNoZWNrZWQoXCJwdHRcIikpIGNvbmZpZy5tdXRlZCA9IHRydWU7XG4gIGlmIChnaXZlbi52b2ljZSA9PT0gdW5kZWZpbmVkKSBjb25maWcudm9pY2UgPSAkPEhUTUxTZWxlY3RFbGVtZW50PihcInZvaWNlXCIpLnZhbHVlO1xuICBpZiAoY29uZmlnLnN0ZWVyaW5nID09PSB1bmRlZmluZWQpIGNvbmZpZy5zdGVlcmluZyA9IFtcImhlcm1lc1wiLCBcInQzXCJdO1xuICBpZiAoY2hlY2tlZChcImNvZGluZ1wiKSAmJiAoc2VydmVyLnQzIHx8IGNoZWNrZWQoXCJmYWtlaGVybWVzXCIpKSAmJiBjb25maWcuY29kaW5nQWdlbnQgPT09IHVuZGVmaW5lZCkgY29uZmlnLmNvZGluZ0FnZW50ID0geyBwcm9qZWN0czogc2VydmVyLnQzID8/IFtdIH07XG4gIGlmIChjaGVja2VkKFwiY2FwdGlvbnNcIikgJiYgc2VydmVyLmNhcHRpb25zTW9kZWwgJiYgY29uZmlnLmNhcHRpb25zID09PSB1bmRlZmluZWQpIGNvbmZpZy5jYXB0aW9ucyA9IHsgbW9kZWw6IHNlcnZlci5jYXB0aW9uc01vZGVsIH07XG4gIHJldHVybiBjb25maWc7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHN0YXJ0KGNhcnJ5T24gPSBmYWxzZSkge1xuICBpZiAoY2FsbElkKSByZXR1cm47XG4gIGxldCBnaXZlbjogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIHRyeSB7XG4gICAgZ2l2ZW4gPSByZWFkQ29uZmlnKCk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHRvYXN0KGBUaGUgZGV2ZWxvcGVyIHNldHRpbmdzIGFyZW4ndCB2YWxpZCBKU09OOiAkeyhlcnIgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgcmV0dXJuO1xuICB9XG4gICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiY2FsbFwiKS5kaXNhYmxlZCA9IHRydWU7XG4gIGlmIChcIk5vdGlmaWNhdGlvblwiIGluIHdpbmRvdyAmJiBOb3RpZmljYXRpb24ucGVybWlzc2lvbiA9PT0gXCJkZWZhdWx0XCIpIHZvaWQgTm90aWZpY2F0aW9uLnJlcXVlc3RQZXJtaXNzaW9uKCkuY2F0Y2goKCkgPT4ge30pO1xuICB0cnkge1xuICAgIGF3YWl0IGF1ZGlvLm9wZW4oKTtcbiAgICBjb3JlID0gYXdhaXQgbG9hZENvcmUoKTtcbiAgfSBmaW5hbGx5IHtcbiAgICAkPEhUTUxCdXR0b25FbGVtZW50PihcImNhbGxcIikuZGlzYWJsZWQgPSBmYWxzZTtcbiAgfVxuICAkKFwidmVyc2lvblwiKS50ZXh0Q29udGVudCA9IGNvcmUudmVyc2lvbjtcbiAgJChcImxvZ1wiKS5pbm5lckhUTUwgPSBcIlwiO1xuICBpZiAodGFza3Muc2l6ZSA+IDAgfHwgJChcInRyYW5zY3JpcHRcIikuY2hpbGRFbGVtZW50Q291bnQgPiAxKSBub3RlKGBOZXcgY2FsbCBcdTAwQjcgJHtuZXcgRGF0ZSgpLnRvTG9jYWxlVGltZVN0cmluZygpfWApO1xuICB0YXNrcy5jbGVhcigpO1xuICBzaG93VGFza3MoKTtcbiAgY291bnRzID0geyBtaWM6IDAsIHBsYXk6IDAsIHNlbnQ6IDAgfTtcbiAgbWV0cmljcy5yZXBseSA9IFtdO1xuICBzdGFydGVkQXQgPSBub3coKTtcbiAgbXV0ZWQgPSBnaXZlbi5tdXRlZCA9PT0gdHJ1ZTtcbiAgLy8gQ2Fycnlpbmcgb246IHRoZSBtb2RlbCBnZXRzIHRoZSBsYXN0IGNvbnZlcnNhdGlvbiBhcyBhIHJlY2FwLiBUaGUgY29yZSBjYXBzIGl0LCBsYXRlc3QgbGluZXMgZmlyc3QuXG4gIGlmIChjYXJyeU9uICYmIGdpdmVuLmhpc3RvcnkgPT09IHVuZGVmaW5lZCkgZ2l2ZW4uaGlzdG9yeSA9IHNhdmVkSGlzdG9yeSgpO1xuICBlbHNlIGlmICghY2FycnlPbikgY2hhdCA9IFtdO1xuICBpZiAoY2FycnlPbikgY2hhdCA9IHNhdmVkSGlzdG9yeSgpO1xuICBsYXN0Um9sZSA9IFwiXCI7XG4gICQoXCJyZXN1bWVcIikuaGlkZGVuID0gdHJ1ZTtcbiAgY2FsbE5hbWUgPSBgJHtuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkucmVwbGFjZSgvWzouXS9nLCBcIi1cIil9LXdlYi0ke2NvcmUudmVyc2lvbn1gO1xuICBjb25zdCBjcmVhdGVkID0gSlNPTi5wYXJzZShjb3JlLmNyZWF0ZShKU09OLnN0cmluZ2lmeShnaXZlbiksIG5vdygpKSk7XG4gIGNhbGxJZCA9IGNyZWF0ZWQuaWQ7XG4gICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiY2FsbFwiKS50ZXh0Q29udGVudCA9IFwiSGFuZyB1cFwiO1xuICAkKFwiY2FsbFwiKS5jbGFzc0xpc3QuYWRkKFwibGl2ZVwiKTtcbiAgZm9yIChjb25zdCBpZCBvZiBbXCJtaWNcIiwgXCJodXNoXCJdKSAkPEhUTUxCdXR0b25FbGVtZW50PihpZCkuZGlzYWJsZWQgPSBmYWxzZTtcbiAgJChcIm1pY1wiKS5jbGFzc0xpc3QudG9nZ2xlKFwibXV0ZWRcIiwgbXV0ZWQpO1xuICBydW4oY3JlYXRlZC5jb21tYW5kcyk7XG4gIHRpY2tlciA9IHdpbmRvdy5zZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgcHVzaCh7IHR5cGU6IFwidGlja1wiIH0pO1xuICAgIGNvbnN0IGxldmVsID0gbXV0ZWQgJiYgIWhvbGRpbmcgPyAwIDogYXVkaW8ubGV2ZWw7XG4gICAgJChcInJpbmdcIikuc3R5bGUub3BhY2l0eSA9IFN0cmluZyhNYXRoLm1pbigxLCBsZXZlbCAqIDEyKSk7XG4gICAgJChcImNvdW50c1wiKS50ZXh0Q29udGVudCA9IGBtaWMgJHtjb3VudHMubWljfSBcdTAwQjcgc2VudCAke2NvdW50cy5zZW50fSBcdTAwQjcgcGxheWVkICR7Y291bnRzLnBsYXl9IFx1MDBCNyBxdWV1ZWQgJHthdWRpby5xdWV1ZWQudG9GaXhlZCgxKX0gc2A7XG4gICAgc2hvd1N0YXR1cygpO1xuICB9LCAxMDApO1xuICB0cmFjZVRpbWVyID0gd2luZG93LnNldEludGVydmFsKCgpID0+IHsgdm9pZCBzYXZlVHJhY2UoKTsgdm9pZCBwaW5nKCk7IHNob3dUYXNrcygpOyB9LCA1MDAwKTtcbiAgdm9pZCBwaW5nKCk7XG4gIHN0b3BXb3Jkcy5zdGFydCgpO1xuICB0cnkgeyB3YWtlTG9jayA9IGF3YWl0IChuYXZpZ2F0b3IgYXMgYW55KS53YWtlTG9jaz8ucmVxdWVzdChcInNjcmVlblwiKTsgfSBjYXRjaCB7fVxufVxuXG5mdW5jdGlvbiBoYW5nVXAoKSB7XG4gIGlmIChjYWxsSWQpIHB1c2goeyB0eXBlOiBcInN0b3BcIiwgbWVzc2FnZTogXCJZb3UgaHVuZyB1cC5cIiB9KTtcbn1cblxuZnVuY3Rpb24gZW5kKCkge1xuICB3aW5kb3cuY2xlYXJJbnRlcnZhbCh0aWNrZXIpO1xuICB3aW5kb3cuY2xlYXJJbnRlcnZhbCh0cmFjZVRpbWVyKTtcbiAgc3RvcFdvcmRzLnN0b3AoKTtcbiAgdm9pZCBzYXZlVHJhY2UoKS50aGVuKCgpID0+IHsgaWYgKGNvcmUgJiYgY2FsbElkKSBjb3JlLmRpc3Bvc2UoY2FsbElkKTsgY2FsbElkID0gMDsgc2hvd1Rhc2tzKCk7IH0pO1xuICBhdWRpby5zdG9wKCk7XG4gIGZvciAoY29uc3Qgd3Mgb2Ygc29ja2V0cy52YWx1ZXMoKSkgd3MuY2xvc2UoKTtcbiAgc29ja2V0cy5jbGVhcigpO1xuICBmb3IgKGNvbnN0IHIgb2YgcnVucy52YWx1ZXMoKSkgci5hYm9ydC5hYm9ydCgpO1xuICBydW5zLmNsZWFyKCk7XG4gICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiY2FsbFwiKS50ZXh0Q29udGVudCA9IFwiQ2FsbFwiO1xuICAkKFwiY2FsbFwiKS5jbGFzc0xpc3QucmVtb3ZlKFwibGl2ZVwiKTtcbiAgZm9yIChjb25zdCBpZCBvZiBbXCJtaWNcIiwgXCJodXNoXCJdKSAkPEhUTUxCdXR0b25FbGVtZW50PihpZCkuZGlzYWJsZWQgPSB0cnVlO1xuICAkKFwicmluZ1wiKS5zdHlsZS5vcGFjaXR5ID0gXCIwXCI7XG4gICQoXCJyZXN1bWVcIikuaGlkZGVuID0gY2hhdC5sZW5ndGggPT09IDA7XG4gIHZvaWQgc2hvd0VhcmxpZXIoKTtcbiAgdm9pZCB3YWtlTG9jaz8ucmVsZWFzZSgpLmNhdGNoKCgpID0+IHt9KTtcbiAgd2FrZUxvY2sgPSBudWxsO1xufVxuXG5mdW5jdGlvbiBzZXRNdXRlZCh2YWx1ZTogYm9vbGVhbikge1xuICBpZiAoIWNhbGxJZCB8fCBtdXRlZCA9PT0gdmFsdWUpIHJldHVybjtcbiAgbXV0ZWQgPSB2YWx1ZTtcbiAgJChcIm1pY1wiKS5jbGFzc0xpc3QudG9nZ2xlKFwibXV0ZWRcIiwgbXV0ZWQpO1xuICBwdXNoKHsgdHlwZTogbXV0ZWQgPyBcIm11dGVcIiA6IFwidW5tdXRlXCIgfSk7XG4gIHNob3dTdGF0dXMoKTtcbn1cblxuLyoqIFNlbmRzIHdoYXQgdGhlIHRyYWNlIGtlcHQgc2luY2UgbGFzdCB0aW1lIHRvIHRoZSBkZXYgc2VydmVyLCBhcyBKU09OIGxpbmVzOiBhIGhlYWRlciwgdGhlbiBldmVudHMuICovXG5hc3luYyBmdW5jdGlvbiBzYXZlVHJhY2UoKSB7XG4gIGlmICghY29yZSB8fCAhY2FsbElkIHx8ICFjaGVja2VkKFwidHJhY2VcIikpIHJldHVybjtcbiAgY29uc3Qga2VwdCA9IEpTT04ucGFyc2UoY29yZS50cmFjZShjYWxsSWQpKTtcbiAgaWYgKCFrZXB0KSByZXR1cm47XG4gIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICBpZiAoa2VwdC5jb25maWcpIGxpbmVzLnB1c2goSlNPTi5zdHJpbmdpZnkoeyB2ZXJzaW9uOiBrZXB0LnZlcnNpb24sIGNvbmZpZzoga2VwdC5jb25maWcsIHN0YXJ0OiBrZXB0LnN0YXJ0IH0pKTtcbiAgZm9yIChjb25zdCBlIG9mIGtlcHQuZXZlbnRzKSBsaW5lcy5wdXNoKEpTT04uc3RyaW5naWZ5KGUpKTtcbiAgaWYgKGxpbmVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuICBhd2FpdCBmZXRjaChgL3RyYWNlcz9uYW1lPSR7ZW5jb2RlVVJJQ29tcG9uZW50KGNhbGxOYW1lKX0uanNvbmxgLCB7IG1ldGhvZDogXCJQT1NUXCIsIGJvZHk6IGxpbmVzLmpvaW4oXCJcXG5cIikgKyBcIlxcblwiIH0pLmNhdGNoKCgpID0+IHt9KTtcbiAgJChcInRyYWNlbmFtZVwiKS50ZXh0Q29udGVudCA9IGB0cmFjZSAke2NhbGxOYW1lfS5qc29ubGA7XG59XG5cbi8vIFwiU3RvcFwiIGFuZCBcImdvb2RieWVcIiBoZWFyZCBieSB0aGUgYnJvd3NlcidzIG93biByZWNvZ25pemVyOiBxdWlja2VyIHRoYW4gdGhlIG1vZGVsJ3MgdHJhbnNjcmlwdCxcbi8vIGFuZCBpdCB3b3JrcyB3aGlsZSB0aGUgbW9kZWwncyByZXBseSBwbGF5cyBldmVuIHdoZW4gdGhlIG1vZGVsIGlzbid0IGhlYXJpbmcgdGhlIG1pY3JvcGhvbmUuXG5cbmNsYXNzIFN0b3BXb3JkcyB7XG4gIHByaXZhdGUgcmVjOiBhbnkgPSBudWxsO1xuICBwcml2YXRlIG9uID0gZmFsc2U7XG4gIHByaXZhdGUgY29tbWFuZHMgPSB7IHN0b3A6IFtdIGFzIHN0cmluZ1tdLCBoYW5nVXA6IFtdIGFzIHN0cmluZ1tdLCBjYW5jZWxBbGw6IFtdIGFzIHN0cmluZ1tdIH07XG5cbiAgZ2V0IHN1cHBvcnRlZCgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gXCJ3ZWJraXRTcGVlY2hSZWNvZ25pdGlvblwiIGluIHdpbmRvdyB8fCBcIlNwZWVjaFJlY29nbml0aW9uXCIgaW4gd2luZG93O1xuICB9XG5cbiAgc3RhcnQoKSB7XG4gICAgaWYgKCFjaGVja2VkKFwic3RvcHdvcmRcIikgfHwgIXRoaXMuc3VwcG9ydGVkIHx8ICFjb3JlKSByZXR1cm47XG4gICAgdGhpcy5jb21tYW5kcyA9IEpTT04ucGFyc2UoY29yZS5kZWZhdWx0cygpKS52b2ljZUNvbW1hbmRzO1xuICAgIGNvbnN0IFJlY29nbml0aW9uID0gKHdpbmRvdyBhcyBhbnkpLlNwZWVjaFJlY29nbml0aW9uID8/ICh3aW5kb3cgYXMgYW55KS53ZWJraXRTcGVlY2hSZWNvZ25pdGlvbjtcbiAgICB0aGlzLnJlYyA9IG5ldyBSZWNvZ25pdGlvbigpO1xuICAgIHRoaXMucmVjLmNvbnRpbnVvdXMgPSB0cnVlO1xuICAgIHRoaXMucmVjLmludGVyaW1SZXN1bHRzID0gdHJ1ZTtcbiAgICB0aGlzLnJlYy5sYW5nID0gbmF2aWdhdG9yLmxhbmd1YWdlIHx8IFwiZW4tR0JcIjtcbiAgICB0aGlzLnJlYy5vbnJlc3VsdCA9IChlOiBhbnkpID0+IHtcbiAgICAgIGZvciAobGV0IGkgPSBlLnJlc3VsdEluZGV4OyBpIDwgZS5yZXN1bHRzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIGNvbnN0IHRleHQgPSBlLnJlc3VsdHNbaV1bMF0udHJhbnNjcmlwdCBhcyBzdHJpbmc7XG4gICAgICAgIGNvbnN0IGNvbW1hbmQgPSBjb21tYW5kSW4odGV4dCwgdGhpcy5jb21tYW5kcywgW1wiV29vZGhvdXNlXCIsIFwiSGVybWVzXCIsIFwiQmVudG9cIl0pO1xuICAgICAgICBpZiAoY29tbWFuZCA9PT0gXCJzdG9wXCIgJiYgYXVkaW8ucXVldWVkID4gMC4wNSkge1xuICAgICAgICAgIGxvZyhcIm91dFwiLCBgbG9jYWwgc3RvcCB3b3JkOiAke3RleHR9YCwgXCJvdXRcIik7XG4gICAgICAgICAgdG9hc3QoYEhlYXJkIFx1MjAxQyR7dGV4dC50cmltKCl9XHUyMDFEOiBzdG9wcGVkYCk7XG4gICAgICAgICAgcHVzaCh7IHR5cGU6IFwiaW50ZXJydXB0XCIgfSk7XG4gICAgICAgIH0gZWxzZSBpZiAoY29tbWFuZCA9PT0gXCJjYW5jZWxBbGxcIiAmJiBlLnJlc3VsdHNbaV0uaXNGaW5hbCkge1xuICAgICAgICAgIGxvZyhcIm91dFwiLCBgbG9jYWwgY2FuY2VsLWFsbDogJHt0ZXh0fWAsIFwib3V0XCIpO1xuICAgICAgICAgIHB1c2goeyB0eXBlOiBcImNhbmNlbEFsbFwiIH0pO1xuICAgICAgICAgIHB1c2goeyB0eXBlOiBcImludGVycnVwdFwiIH0pO1xuICAgICAgICB9IGVsc2UgaWYgKGNvbW1hbmQgPT09IFwiaGFuZ1VwXCIgJiYgZS5yZXN1bHRzW2ldLmlzRmluYWwpIHtcbiAgICAgICAgICBsb2coXCJvdXRcIiwgYGxvY2FsIGhhbmctdXA6ICR7dGV4dH1gLCBcIm91dFwiKTtcbiAgICAgICAgICBoYW5nVXAoKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH07XG4gICAgdGhpcy5yZWMub25lbmQgPSAoKSA9PiB7IGlmICh0aGlzLm9uKSBzZXRUaW1lb3V0KCgpID0+IHsgdHJ5IHsgdGhpcy5yZWM/LnN0YXJ0KCk7IH0gY2F0Y2gge30gfSwgMjUwKTsgfTtcbiAgICB0aGlzLnJlYy5vbmVycm9yID0gKGU6IGFueSkgPT4geyBpZiAoZS5lcnJvciA9PT0gXCJub3QtYWxsb3dlZFwiKSB0aGlzLm9uID0gZmFsc2U7IH07XG4gICAgdGhpcy5vbiA9IHRydWU7XG4gICAgdHJ5IHsgdGhpcy5yZWMuc3RhcnQoKTsgfSBjYXRjaCB7fVxuICB9XG5cbiAgc3RvcCgpIHtcbiAgICB0aGlzLm9uID0gZmFsc2U7XG4gICAgdHJ5IHsgdGhpcy5yZWM/LnN0b3AoKTsgfSBjYXRjaCB7fVxuICAgIHRoaXMucmVjID0gbnVsbDtcbiAgfVxufVxuY29uc3Qgc3RvcFdvcmRzID0gbmV3IFN0b3BXb3JkcygpO1xuXG4vLyBXaXJpbmcuXG5cbmZ1bmN0aW9uIHNldHRpbmdzRnJvbVN0b3JhZ2UoKSB7XG4gIGZvciAoY29uc3QgaWQgb2YgW1wiYWVjXCIsIFwic3RvcHdvcmRcIiwgXCJwdHRcIiwgXCJjYXB0aW9uc1wiLCBcImNvZGluZ1wiLCBcImZha2VoZXJtZXNcIiwgXCJ0cmFjZVwiXSkge1xuICAgIGNvbnN0IHYgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShgdm9pY2UuJHtpZH1gKTtcbiAgICBpZiAodiAhPSBudWxsKSAkPEhUTUxJbnB1dEVsZW1lbnQ+KGlkKS5jaGVja2VkID0gdiA9PT0gXCIxXCI7XG4gICAgJChpZCkuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShgdm9pY2UuJHtpZH1gLCBjaGVja2VkKGlkKSA/IFwiMVwiIDogXCIwXCIpKTtcbiAgfVxuICBjb25zdCBkZWxheSA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UuZmFrZWRlbGF5XCIpO1xuICBpZiAoZGVsYXkpICQ8SFRNTElucHV0RWxlbWVudD4oXCJmYWtlZGVsYXlcIikudmFsdWUgPSBkZWxheTtcbiAgJChcImZha2VkZWxheVwiKS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2UuZmFrZWRlbGF5XCIsICQ8SFRNTElucHV0RWxlbWVudD4oXCJmYWtlZGVsYXlcIikudmFsdWUpKTtcbiAgY29uc3Qgdm9pY2UgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLnZvaWNlXCIpO1xuICBpZiAodm9pY2UpICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwidm9pY2VcIikudmFsdWUgPSB2b2ljZTtcbiAgJChcInZvaWNlXCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4gbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS52b2ljZVwiLCAkPEhUTUxTZWxlY3RFbGVtZW50PihcInZvaWNlXCIpLnZhbHVlKSk7XG4gIGNvbnN0IG1vZGUgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLm1vZGVcIik7XG4gIGlmIChtb2RlKSAkPEhUTUxTZWxlY3RFbGVtZW50PihcIm1vZGVcIikudmFsdWUgPSBtb2RlO1xuICAkKFwibW9kZVwiKS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2UubW9kZVwiLCAkPEhUTUxTZWxlY3RFbGVtZW50PihcIm1vZGVcIikudmFsdWUpKTtcbn1cblxuZnVuY3Rpb24gdGFicygpIHtcbiAgY29uc3Qgdmlld3M6IFJlY29yZDxzdHJpbmcsIEhUTUxFbGVtZW50PiA9IHsgdGFsazogJChcInRhbGtcIiksIGRldjogJChcImRldlwiKSwgcmVwbGF5OiAkKFwicmVwbGF5bWFpblwiKSB9O1xuICBmb3IgKGNvbnN0IG5hbWUgb2YgT2JqZWN0LmtleXModmlld3MpKSB7XG4gICAgJChgdGFiLSR7bmFtZX1gKS5vbmNsaWNrID0gKCkgPT4ge1xuICAgICAgZm9yIChjb25zdCBbb3RoZXIsIGVsXSBvZiBPYmplY3QuZW50cmllcyh2aWV3cykpIHtcbiAgICAgICAgZWwuaGlkZGVuID0gb3RoZXIgIT09IG5hbWU7XG4gICAgICAgICQoYHRhYi0ke290aGVyfWApLmNsYXNzTGlzdC50b2dnbGUoXCJvblwiLCBvdGhlciA9PT0gbmFtZSk7XG4gICAgICB9XG4gICAgfTtcbiAgfVxuICAkKFwiZ2VhclwiKS5vbmNsaWNrID0gKCkgPT4geyAkKFwic2V0dGluZ3NcIikuaGlkZGVuID0gZmFsc2U7IH07XG4gICQoXCJjbG9zZXNldHRpbmdzXCIpLm9uY2xpY2sgPSAoKSA9PiB7ICQoXCJzZXR0aW5nc1wiKS5oaWRkZW4gPSB0cnVlOyB9O1xuICAkKFwic2V0dGluZ3NcIikub25jbGljayA9IChlKSA9PiB7IGlmIChlLnRhcmdldCA9PT0gJChcInNldHRpbmdzXCIpKSAkKFwic2V0dGluZ3NcIikuaGlkZGVuID0gdHJ1ZTsgfTtcbn1cblxuZnVuY3Rpb24gdHlwaW5nKCk6IGJvb2xlYW4ge1xuICBjb25zdCBlbCA9IGRvY3VtZW50LmFjdGl2ZUVsZW1lbnQgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICByZXR1cm4gISFlbCAmJiAoZWwudGFnTmFtZSA9PT0gXCJJTlBVVFwiIHx8IGVsLnRhZ05hbWUgPT09IFwiVEVYVEFSRUFcIiB8fCBlbC50YWdOYW1lID09PSBcIlNFTEVDVFwiIHx8IGVsLmlzQ29udGVudEVkaXRhYmxlKTtcbn1cblxuZnVuY3Rpb24ga2V5cygpIHtcbiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcImtleWRvd25cIiwgKGUpID0+IHtcbiAgICBpZiAoZS5rZXkgPT09IFwiRXNjYXBlXCIgJiYgY2FsbElkKSB7IHB1c2goeyB0eXBlOiBcImludGVycnVwdFwiIH0pOyBhdWRpby5mbHVzaCgpOyByZXR1cm47IH1cbiAgICBpZiAodHlwaW5nKCkgfHwgZS5tZXRhS2V5IHx8IGUuY3RybEtleSB8fCBlLmFsdEtleSkgcmV0dXJuO1xuICAgIGlmIChlLmtleSA9PT0gXCJtXCIgfHwgZS5rZXkgPT09IFwiTVwiKSB7IHNldE11dGVkKCFtdXRlZCk7IGUucHJldmVudERlZmF1bHQoKTsgfVxuICAgIGVsc2UgaWYgKGUua2V5ID09PSBcIi9cIikgeyAkKFwidGV4dFwiKS5mb2N1cygpOyBlLnByZXZlbnREZWZhdWx0KCk7IH1cbiAgICBlbHNlIGlmIChlLmNvZGUgPT09IFwiU3BhY2VcIiAmJiBjYWxsSWQgJiYgbXV0ZWQgJiYgIWUucmVwZWF0KSB7IGhvbGRpbmcgPSB0cnVlOyBwdXNoKHsgdHlwZTogXCJ1bm11dGVcIiB9KTsgc2hvd1N0YXR1cygpOyBlLnByZXZlbnREZWZhdWx0KCk7IH1cbiAgfSk7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJrZXl1cFwiLCAoZSkgPT4ge1xuICAgIGlmIChlLmNvZGUgPT09IFwiU3BhY2VcIiAmJiBob2xkaW5nKSB7IGhvbGRpbmcgPSBmYWxzZTsgcHVzaCh7IHR5cGU6IFwibXV0ZVwiIH0pOyBzaG93U3RhdHVzKCk7IH1cbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHN1Ym1pdFRleHQoZTogRXZlbnQpIHtcbiAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICBjb25zdCBpbnB1dCA9ICQ8SFRNTElucHV0RWxlbWVudD4oXCJ0ZXh0XCIpO1xuICBsZXQgdGV4dCA9IGlucHV0LnZhbHVlLnRyaW0oKTtcbiAgaWYgKCF0ZXh0KSByZXR1cm47XG4gIGlmICghY2FsbElkKSB7IHRvYXN0KFwiU3RhcnQgYSBjYWxsIGZpcnN0XCIpOyByZXR1cm47IH1cbiAgLy8gXCIvdDMgXHUyMDI2XCIgYW5kIFwiL2ggXHUyMDI2XCIgcGljayB0aGUgYWdlbnQgd2hhdGV2ZXIgdGhlIHNlbGVjdG9yIHNheXMuXG4gIGxldCBtb2RlID0gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJtb2RlXCIpLnZhbHVlO1xuICBjb25zdCBwcmVmaXggPSB0ZXh0Lm1hdGNoKC9eXFwvKHQzfGNvZGV8aHxoZXJtZXMpXFxzKy9pKTtcbiAgaWYgKHByZWZpeCkgeyBtb2RlID0gL14odDN8Y29kZSkkL2kudGVzdChwcmVmaXhbMV0pID8gXCJ0M1wiIDogXCJoZXJtZXNcIjsgdGV4dCA9IHRleHQuc2xpY2UocHJlZml4WzBdLmxlbmd0aCkudHJpbSgpOyB9XG4gIGlmICghdGV4dCkgcmV0dXJuO1xuICBpZiAobW9kZSA9PT0gXCJzYXlcIikgcHVzaCh7IHR5cGU6IFwic2F5XCIsIHRleHQgfSk7XG4gIGVsc2Uge1xuICAgIHB1c2goeyB0eXBlOiBcImFza1wiLCB0ZXh0LCBhZ2VudDogbW9kZSB9KTtcbiAgICBub3RlKGBZb3UgXHUyMTkyIG5ldyAke21vZGUgPT09IFwidDNcIiA/IFwiY29kaW5nXCIgOiBcIkhlcm1lc1wifSB0YXNrOiAke3RleHR9YCk7XG4gIH1cbiAgaW5wdXQudmFsdWUgPSBcIlwiO1xufVxuXG5hc3luYyBmdW5jdGlvbiBtYWluKCkge1xuICBzZXJ2ZXIgPSBhd2FpdCAoYXdhaXQgZmV0Y2goXCIvY29uZmlnXCIpKS5qc29uKCk7XG4gICQoXCJyb3V0ZVwiKS50ZXh0Q29udGVudCA9IGAke3NlcnZlci5yb3V0ZSA9PT0gXCJ2ZXJ0ZXhcIiA/IFwiR1NLIFZlcnRleFwiIDogXCJHZW1pbmkgQVBJXCJ9IFx1MDBCNyAke3NlcnZlci5tb2RlbC5zcGxpdChcIi9cIikucG9wKCl9YDtcbiAgJChcInZlcnNpb25cIikudGV4dENvbnRlbnQgPSBzZXJ2ZXIudmVyc2lvbjtcbiAgJChcImJ1aWxkXCIpLnRleHRDb250ZW50ID0gYGNvcmUgJHtzZXJ2ZXIudmVyc2lvbn1gO1xuICBzZXR0aW5nc0Zyb21TdG9yYWdlKCk7XG4gIGlmICghc2VydmVyLmhlcm1lcykgeyAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwiZmFrZWhlcm1lc1wiKS5jaGVja2VkID0gdHJ1ZTsgJDxIVE1MSW5wdXRFbGVtZW50PihcImZha2VoZXJtZXNcIikuZGlzYWJsZWQgPSB0cnVlOyB9XG4gIGlmICghc2VydmVyLnQzKSAkKFwiY29kaW5naGVscFwiKS50ZXh0Q29udGVudCA9IFwiVDMgaXNuJ3QgYXZhaWxhYmxlIG9uIHRoZSBzZXJ2ZXI6IG9ubHkgd2l0aCBmYWtlIGFuc3dlcnMuXCI7XG4gIGVsc2UgJChcImNvZGluZ2hlbHBcIikudGV4dENvbnRlbnQgPSBgQ29kZSBjaGFuZ2VzIGdvIHRvIGEgVDMgQ29kZSB0aHJlYWQgaW4gb25lIG9mOiAke3NlcnZlci50My5qb2luKFwiLCBcIil9LmA7XG4gIGlmICghc3RvcFdvcmRzLnN1cHBvcnRlZCkgeyAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwic3RvcHdvcmRcIikuY2hlY2tlZCA9IGZhbHNlOyAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwic3RvcHdvcmRcIikuZGlzYWJsZWQgPSB0cnVlOyB9XG4gIGNvbnN0IHByZXNldCA9ICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwicHJlc2V0XCIpO1xuICBmb3IgKGNvbnN0IG5hbWUgb2YgT2JqZWN0LmtleXMoUFJFU0VUUykpIHByZXNldC5hZGQobmV3IE9wdGlvbihuYW1lLCBuYW1lKSk7XG4gIHByZXNldC52YWx1ZSA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UtY29yZS5wcmVzZXRcIikgPz8gXCJ3ZWJcIjtcbiAgaWYgKCFQUkVTRVRTW3ByZXNldC52YWx1ZV0pIHByZXNldC52YWx1ZSA9IFwid2ViXCI7XG4gICQ8SFRNTFRleHRBcmVhRWxlbWVudD4oXCJjb25maWdcIikudmFsdWUgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLWNvcmUuY29uZmlnXCIpID8/IEpTT04uc3RyaW5naWZ5KFBSRVNFVFNbcHJlc2V0LnZhbHVlXSwgbnVsbCwgMik7XG4gIHByZXNldC5vbmNoYW5nZSA9ICgpID0+IHtcbiAgICAkPEhUTUxUZXh0QXJlYUVsZW1lbnQ+KFwiY29uZmlnXCIpLnZhbHVlID0gSlNPTi5zdHJpbmdpZnkoUFJFU0VUU1twcmVzZXQudmFsdWVdLCBudWxsLCAyKTtcbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLWNvcmUucHJlc2V0XCIsIHByZXNldC52YWx1ZSk7XG4gICAgbG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oXCJ2b2ljZS1jb3JlLmNvbmZpZ1wiKTtcbiAgfTtcbiAgJChcImNvbmZpZ1wiKS5vbmlucHV0ID0gKCkgPT4gbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS1jb3JlLmNvbmZpZ1wiLCAkPEhUTUxUZXh0QXJlYUVsZW1lbnQ+KFwiY29uZmlnXCIpLnZhbHVlKTtcbiAgJChcImRlZmF1bHRzXCIpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYyA9IGNvcmUgPz8gKGF3YWl0IGxvYWRDb3JlKCkpO1xuICAgICQoXCJkZWZhdWx0c3ZpZXdcIikudGV4dENvbnRlbnQgPSBKU09OLnN0cmluZ2lmeShKU09OLnBhcnNlKGMuZGVmYXVsdHMoKSksIG51bGwsIDIpO1xuICAgICQoXCJkZWZhdWx0c3ZpZXdcIikuaGlkZGVuID0gISQoXCJkZWZhdWx0c3ZpZXdcIikuaGlkZGVuO1xuICB9O1xuICAkKFwiY2FsbFwiKS5vbmNsaWNrID0gKCkgPT4gKGNhbGxJZCA/IGhhbmdVcCgpIDogdm9pZCBzdGFydCgpLmNhdGNoKChlcnIpID0+IHsgdG9hc3QoZXJyLm1lc3NhZ2UpOyBsb2coXCJlcnJvclwiLCBlcnIubWVzc2FnZSwgXCJlcnJcIik7IH0pKTtcbiAgJChcInJlc3VtZVwiKS5vbmNsaWNrID0gKCkgPT4gdm9pZCBzdGFydCh0cnVlKS5jYXRjaCgoZXJyKSA9PiB7IHRvYXN0KGVyci5tZXNzYWdlKTsgbG9nKFwiZXJyb3JcIiwgZXJyLm1lc3NhZ2UsIFwiZXJyXCIpOyB9KTtcbiAgaWYgKHNhdmVkSGlzdG9yeSgpLmxlbmd0aCA+IDApIHsgJChcInJlc3VtZVwiKS5oaWRkZW4gPSBmYWxzZTsgJChcInJlc3VtZVwiKS50aXRsZSA9IFwiQ2FsbCBhZ2FpbiwgY2Fycnlpbmcgb24gZnJvbSB0aGUgbGFzdCBjb252ZXJzYXRpb25cIjsgfVxuICAkKFwibWljXCIpLm9uY2xpY2sgPSAoKSA9PiBzZXRNdXRlZCghbXV0ZWQpO1xuICAkKFwiaHVzaFwiKS5vbmNsaWNrID0gKCkgPT4geyBwdXNoKHsgdHlwZTogXCJpbnRlcnJ1cHRcIiB9KTsgYXVkaW8uZmx1c2goKTsgfTtcbiAgJChcImNhbmNlbGFsbFwiKS5vbmNsaWNrID0gKCkgPT4gcHVzaCh7IHR5cGU6IFwiY2FuY2VsQWxsXCIgfSk7XG4gICQoXCJzYXlcIikub25zdWJtaXQgPSBzdWJtaXRUZXh0O1xuICAkKFwidGV4dFwiKS5hZGRFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCAoZSkgPT4geyBpZiAoKGUgYXMgS2V5Ym9hcmRFdmVudCkua2V5ID09PSBcIkVudGVyXCIpIHN1Ym1pdFRleHQoZSk7IH0pO1xuICB0YWJzKCk7XG4gIGtleXMoKTtcbiAgY29uc3QgZXZlbnRzID0gbmV3IEV2ZW50U291cmNlKFwiL2V2ZW50c1wiKTtcbiAgZXZlbnRzLmFkZEV2ZW50TGlzdGVuZXIoXCJjb3JlXCIsIChlKSA9PiB7XG4gICAgY29uc3QgeyB2ZXJzaW9uIH0gPSBKU09OLnBhcnNlKChlIGFzIE1lc3NhZ2VFdmVudCkuZGF0YSk7XG4gICAgJChcInZlcnNpb25cIikudGV4dENvbnRlbnQgPSB2ZXJzaW9uICsgKGNhbGxJZCAmJiBjb3JlICYmIGNvcmUudmVyc2lvbiAhPT0gdmVyc2lvbiA/IGAgKG5leHQgY2FsbDsgdGhpcyBvbmUgcnVucyAke2NvcmUudmVyc2lvbn0pYCA6IFwiXCIpO1xuICAgICQoXCJidWlsZFwiKS50ZXh0Q29udGVudCA9IGBjb3JlICR7dmVyc2lvbn1gO1xuICB9KTtcbiAgZXZlbnRzLmFkZEV2ZW50TGlzdGVuZXIoXCJhcHBcIiwgKCkgPT4geyBpZiAoIWNhbGxJZCkgbG9jYXRpb24ucmVsb2FkKCk7IGVsc2UgdG9hc3QoXCJUaGUgcGFnZSBjaGFuZ2VkOiByZWxvYWQgYWZ0ZXIgdGhpcyBjYWxsXCIpOyB9KTtcbiAgZXZlbnRzLmFkZEV2ZW50TGlzdGVuZXIoXCJlcnJvclwiLCAoZSkgPT4ge1xuICAgIGNvbnN0IGRhdGEgPSAoZSBhcyBNZXNzYWdlRXZlbnQpLmRhdGE7XG4gICAgaWYgKGRhdGEpIHRvYXN0KGBCdWlsZCBmYWlsZWQ6ICR7SlNPTi5wYXJzZShkYXRhKS5tZXNzYWdlfWApO1xuICB9KTtcbiAgbmV3IFJlcGxheSgkKFwicmVwbGF5XCIpLCBsb2FkQ29yZSk7XG4gIHZvaWQgcGluZygpO1xuICB2b2lkIHNob3dFYXJsaWVyKCk7XG4gIHdpbmRvdy5zZXRJbnRlcnZhbCgoKSA9PiB2b2lkIHNob3dFYXJsaWVyKCksIDMwXzAwMCk7XG59XG5cbnZvaWQgbWFpbigpO1xuIl0sCiAgIm1hcHBpbmdzIjogIjtBQVNBLElBQU0sU0FBUyxvQkFBSSxJQUFJO0FBQUEsRUFDckI7QUFBQSxFQUFPO0FBQUEsRUFBTTtBQUFBLEVBQVE7QUFBQSxFQUFVO0FBQUEsRUFBTztBQUFBLEVBQVE7QUFBQSxFQUFNO0FBQUEsRUFBTTtBQUFBLEVBQU07QUFBQSxFQUFNO0FBQUEsRUFBVztBQUFBLEVBQVM7QUFBQSxFQUFRO0FBQUEsRUFBTztBQUFBLEVBQVU7QUFBQSxFQUFTO0FBQUEsRUFDNUg7QUFDRixDQUFDO0FBR00sU0FBUyxNQUFNLE1BQXdCO0FBQzVDLFNBQU8sS0FBSyxZQUFZLEVBQUUsUUFBUSxVQUFVLEVBQUUsRUFBRSxRQUFRLHFCQUFxQixHQUFHLEVBQUUsS0FBSyxFQUFFLE1BQU0sR0FBRyxFQUFFLE9BQU8sQ0FBQyxNQUFNLEVBQUUsU0FBUyxDQUFDO0FBQ2hJO0FBR08sU0FBUyxVQUFVLFdBQW1CLFVBQXlCLFFBQWtCLENBQUMsR0FBd0I7QUFDL0csUUFBTSxVQUFVLG9CQUFJLElBQUksQ0FBQyxHQUFHLFFBQVEsR0FBRyxNQUFNLFFBQVEsS0FBSyxDQUFDLENBQUM7QUFDNUQsUUFBTSxPQUFPLE1BQU0sU0FBUztBQUM1QixNQUFJLE9BQU87QUFDWCxNQUFJLEtBQUssS0FBSztBQUNkLFNBQU8sT0FBTyxNQUFNLFFBQVEsSUFBSSxLQUFLLElBQUksQ0FBQyxFQUFHO0FBQzdD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QUFFLE1BQU0sRUFBRSxVQUFVLE1BQU8sU0FBUyxPQUFPLElBQUksS0FBSyxNQUFNLEVBQUUsTUFBTSxDQUFDLFFBQVE7QUFBRSxVQUFNLElBQUksT0FBTztBQUFHLFFBQUksU0FBUyxJQUFJLFNBQVMsS0FBSztBQUFBLEVBQUcsQ0FBQztBQUNwSSxJQUFFLFFBQVEsRUFBRSxVQUFVLE1BQU0sS0FBSyxNQUFNLElBQUksRUFBRSxNQUFNLENBQUMsUUFBUTtBQUFFLFVBQU0sSUFBSSxPQUFPO0FBQUcsUUFBSSxTQUFTLElBQUksU0FBUyxLQUFLO0FBQUEsRUFBRyxDQUFDO0FBQ3JILE1BQUksYUFBYSxFQUFFLFNBQVMsR0FBRztBQUFFLE1BQUUsUUFBUSxFQUFFLFNBQVM7QUFBTyxNQUFFLFFBQVEsRUFBRSxRQUFRO0FBQUEsRUFBc0Q7QUFDdkksSUFBRSxLQUFLLEVBQUUsVUFBVSxNQUFNLFNBQVMsQ0FBQyxLQUFLO0FBQ3hDLElBQUUsTUFBTSxFQUFFLFVBQVUsTUFBTTtBQUFFLFNBQUssRUFBRSxNQUFNLFlBQVksQ0FBQztBQUFHLFVBQU0sTUFBTTtBQUFBLEVBQUc7QUFDeEUsSUFBRSxXQUFXLEVBQUUsVUFBVSxNQUFNLEtBQUssRUFBRSxNQUFNLFlBQVksQ0FBQztBQUN6RCxJQUFFLEtBQUssRUFBRSxXQUFXO0FBQ3BCLElBQUUsTUFBTSxFQUFFLGlCQUFpQixXQUFXLENBQUMsTUFBTTtBQUFFLFFBQUssRUFBb0IsUUFBUSxRQUFTLFlBQVcsQ0FBQztBQUFBLEVBQUcsQ0FBQztBQUN6RyxPQUFLO0FBQ0wsT0FBSztBQUNMLFFBQU0sU0FBUyxJQUFJLFlBQVksU0FBUztBQUN4QyxTQUFPLGlCQUFpQixRQUFRLENBQUMsTUFBTTtBQUNyQyxVQUFNLEVBQUUsUUFBUSxJQUFJLEtBQUssTUFBTyxFQUFtQixJQUFJO0FBQ3ZELE1BQUUsU0FBUyxFQUFFLGNBQWMsV0FBVyxVQUFVLFFBQVEsS0FBSyxZQUFZLFVBQVUsOEJBQThCLEtBQUssT0FBTyxNQUFNO0FBQ25JLE1BQUUsT0FBTyxFQUFFLGNBQWMsUUFBUSxPQUFPO0FBQUEsRUFDMUMsQ0FBQztBQUNELFNBQU8saUJBQWlCLE9BQU8sTUFBTTtBQUFFLFFBQUksQ0FBQyxPQUFRLFVBQVMsT0FBTztBQUFBLFFBQVEsT0FBTSwwQ0FBMEM7QUFBQSxFQUFHLENBQUM7QUFDaEksU0FBTyxpQkFBaUIsU0FBUyxDQUFDLE1BQU07QUFDdEMsVUFBTSxPQUFRLEVBQW1CO0FBQ2pDLFFBQUksS0FBTSxPQUFNLGlCQUFpQixLQUFLLE1BQU0sSUFBSSxFQUFFLE9BQU8sRUFBRTtBQUFBLEVBQzdELENBQUM7QUFDRCxNQUFJLE9BQU8sRUFBRSxRQUFRLEdBQUcsUUFBUTtBQUNoQyxPQUFLLEtBQUs7QUFDVixPQUFLLFlBQVk7QUFDakIsU0FBTyxZQUFZLE1BQU0sS0FBSyxZQUFZLEdBQUcsR0FBTTtBQUNyRDtBQUVBLEtBQUssS0FBSzsiLAogICJuYW1lcyI6IFsiY29yZSIsICJjb3JlIiwgIm5vdyIsICJydW4iXQp9Cg==
