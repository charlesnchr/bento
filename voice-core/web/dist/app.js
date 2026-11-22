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
  web: { platform: "web", device: "browser", standbyAfter: 30, hangUpAfter: 300, handOff: "named", vocabulary: ["Hermes", "Bento", "Woodhouse", "T3"] },
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
  const typed = Boolean(callId) && medium === "text";
  const speaking = callId && !typed && coreStatus !== "standby" && audio.queued > 0.05;
  const shown = speaking || typed && thinking ? "speaking" : coreStatus;
  $("status").className = shown;
  let text = speaking ? "Speaking" : STATUS_TEXT[coreStatus] ?? coreStatus;
  if (typed && coreStatus !== "ended") text = thinking ? "Writing\u2026" : coreStatus === "working" ? "Chat \xB7 tasks running" : "Chat";
  if (callId && !typed && muted && !holding && !speaking) text += " \xB7 muted";
  if (holding) text = "Talking (hold)";
  if (message) text = `${text}: ${message}`;
  if (coreStatus !== "ended" || message) $("statustext").textContent = text;
  $("hush").classList.toggle("live", Boolean(speaking) || typed && thinking);
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
  if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission().catch(() => {
  });
  try {
    if (!typed) await audio.open();
    core = await loadCore();
  } finally {
    $("call").disabled = false;
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
  $("resume").hidden = true;
  callName = `${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}-${typed ? "chat" : "web"}-${core.version}`;
  const created = JSON.parse(core.create(JSON.stringify(given), now()));
  callId = created.id;
  if (!typed) {
    $("call").textContent = "Hang up";
    $("call").classList.add("live");
    $("mic").disabled = false;
  }
  $("hush").disabled = false;
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
  });
  audio.stop();
  for (const ws of sockets.values()) ws.close();
  sockets.clear();
  for (const r of runs.values()) r.abort.abort();
  runs.clear();
  for (const r of requests.values()) r.abort();
  requests.clear();
  thinking = false;
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
async function submitText(e) {
  e.preventDefault();
  const input = $("text");
  let text = input.value.trim();
  if (!text) return;
  if (!callId) {
    input.value = "";
    try {
      await start(false, true);
    } catch (err) {
      toast(err.message);
      log("error", err.message, "err");
    }
    if (!callId) {
      input.value = text;
      return;
    }
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
  $("call").onclick = () => void callButton().catch((err) => {
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
  $("say").onsubmit = (e) => void submitText(e);
  $("text").addEventListener("keydown", (e) => {
    if (e.key === "Enter") void submitText(e);
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL2NvbW1hbmRzLnRzIiwgIi4uL2F1ZGlvLnRzIiwgIi4uL3JlcGxheS50cyIsICIuLi9hcHAudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFNwb2tlbiBjb21tYW5kcyB0aGUgY29yZSBhY3RzIG9uIHdpdGhvdXQgdGhlIG1vZGVsOiBcInN0b3BcIiBhbmQgXCJoYW5nIHVwXCIuIEFuIHV0dGVyYW5jZSBjb3VudHNcbi8vIG9ubHkgd2hlbiBpdCBpcyBvbmUgb2YgdGhlIHBocmFzZXMgYW5kIG5vdGhpbmcgbW9yZSwgb25jZSBuYW1lcyBhbmQgZmlsbGVycyBhcm91bmQgaXQgYXJlIGdvbmUsXG4vLyBzbyBcIldvb2Rob3VzZSwgc3RvcCBwbGVhc2VcIiBzdG9wcyBhbmQgXCJzdG9wIHRoZSBQZW5ueXdvcnRoIHRhc2tcIiBnb2VzIHRvIHRoZSBtb2RlbCBhcyB1c3VhbC5cblxuaW1wb3J0IHR5cGUgeyBWb2ljZUNvbW1hbmRzIH0gZnJvbSBcIi4vdHlwZXMudHNcIjtcblxuZXhwb3J0IHR5cGUgVm9pY2VDb21tYW5kID0gXCJzdG9wXCIgfCBcImhhbmdVcFwiIHwgXCJjYW5jZWxBbGxcIjtcblxuLyoqIFdvcmRzIHRoYXQgbWF5IGNvbWUgYmVmb3JlIG9yIGFmdGVyIGEgY29tbWFuZCB3aXRob3V0IGNoYW5naW5nIGl0LiAqL1xuY29uc3QgRklMTEVSID0gbmV3IFNldChbXG4gIFwiaGV5XCIsIFwib2tcIiwgXCJva2F5XCIsIFwicGxlYXNlXCIsIFwibm93XCIsIFwianVzdFwiLCBcInNvXCIsIFwidW1cIiwgXCJ1aFwiLCBcIm9oXCIsIFwiYWxyaWdodFwiLCBcInJpZ2h0XCIsIFwieWVhaFwiLCBcInllc1wiLCBcInRoYW5rc1wiLCBcInRoYW5rXCIsIFwieW91XCIsXG4gIFwiZ2VtaW5pXCIsXG5dKTtcblxuLyoqIFt0ZXh0XSBhcyBsb3dlci1jYXNlIHdvcmRzLCBhcG9zdHJvcGhlcyBkcm9wcGVkIChcIlRoYXQnc1wiIGlzIFwidGhhdHNcIikuICovXG5leHBvcnQgZnVuY3Rpb24gd29yZHModGV4dDogc3RyaW5nKTogc3RyaW5nW10ge1xuICByZXR1cm4gdGV4dC50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL1snXHUyMDE5YF0vZywgXCJcIikucmVwbGFjZSgvW15cXHB7TH1cXHB7TmR9XSsvZ3UsIFwiIFwiKS50cmltKCkuc3BsaXQoXCIgXCIpLmZpbHRlcigodykgPT4gdy5sZW5ndGggPiAwKTtcbn1cblxuLyoqIFRoZSBjb21tYW5kIFt1dHRlcmFuY2VdIGlzLCBpZiBpdCdzIG9uZSBhbmQgbm90aGluZyBtb3JlOyBbbmFtZXNdICh0aGUgYXNzaXN0YW50J3MsIFwiV29vZGhvdXNlXCIpIGRvbid0IGNvdW50LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbW1hbmRJbih1dHRlcmFuY2U6IHN0cmluZywgY29tbWFuZHM6IFZvaWNlQ29tbWFuZHMsIG5hbWVzOiBzdHJpbmdbXSA9IFtdKTogVm9pY2VDb21tYW5kIHwgbnVsbCB7XG4gIGNvbnN0IGlnbm9yZWQgPSBuZXcgU2V0KFsuLi5GSUxMRVIsIC4uLm5hbWVzLmZsYXRNYXAod29yZHMpXSk7XG4gIGNvbnN0IHNhaWQgPSB3b3Jkcyh1dHRlcmFuY2UpO1xuICBsZXQgZnJvbSA9IDA7XG4gIGxldCB0byA9IHNhaWQubGVuZ3RoO1xuICB3aGlsZSAoZnJvbSA8IHRvICYmIGlnbm9yZWQuaGFzKHNhaWRbZnJvbV0pKSBmcm9tKys7XG4gIHdoaWxlICh0byA+IGZyb20gJiYgaWdub3JlZC5oYXMoc2FpZFt0byAtIDFdKSkgdG8tLTtcbiAgaWYgKGZyb20gPT09IHRvIHx8IHRvIC0gZnJvbSA+IDUpIHJldHVybiBudWxsO1xuICBjb25zdCBjb3JlID0gc2FpZC5zbGljZShmcm9tLCB0bykuam9pbihcIiBcIik7XG4gIGNvbnN0IGlzID0gKHBocmFzZXM6IHN0cmluZ1tdKSA9PiBwaHJhc2VzLnNvbWUoKHApID0+IHdvcmRzKHApLmpvaW4oXCIgXCIpID09PSBjb3JlKTtcbiAgaWYgKGlzKGNvbW1hbmRzLmhhbmdVcCkpIHJldHVybiBcImhhbmdVcFwiO1xuICBpZiAoaXMoY29tbWFuZHMuY2FuY2VsQWxsID8/IFtdKSkgcmV0dXJuIFwiY2FuY2VsQWxsXCI7XG4gIGlmIChpcyhjb21tYW5kcy5zdG9wKSkgcmV0dXJuIFwic3RvcFwiO1xuICByZXR1cm4gbnVsbDtcbn1cbiIsICIvLyBUaGUgYnJvd3NlcidzIG1pY3JvcGhvbmUgYW5kIHNwZWFrZXIgZm9yIGEgY2FsbDogMTYga0h6IFBDTTE2IGZyYW1lcyBvdXQgb2YgdGhlIG1pY3JvcGhvbmUsXG4vLyAyNCBrSHogUENNMTYgaW50byB0aGUgc3BlYWtlciwgYW5kIHRvbmVzIGxhaWQgb3ZlciB3aGF0ZXZlciBwbGF5cy4gQm90aCBydW4gaW4gQXVkaW9Xb3JrbGV0cyBvblxuLy8gb25lIEF1ZGlvQ29udGV4dCBhdCB0aGUgZGV2aWNlJ3MgcmF0ZSwgcmVzYW1wbGluZyB0aGVyZS5cblxuY29uc3QgV09SS0xFVFMgPSBgXG5jbGFzcyBDYXB0dXJlIGV4dGVuZHMgQXVkaW9Xb3JrbGV0UHJvY2Vzc29yIHtcbiAgY29uc3RydWN0b3IoKSB7XG4gICAgc3VwZXIoKTtcbiAgICB0aGlzLnN0ZXAgPSBzYW1wbGVSYXRlIC8gMTYwMDA7XG4gICAgdGhpcy5wb3MgPSAwO1xuICAgIHRoaXMuZnJhbWUgPSBuZXcgSW50MTZBcnJheSgzMjApO1xuICAgIHRoaXMubiA9IDA7XG4gICAgLy8gQSB3aW5kb3dlZC1zaW5jIGxvdy1wYXNzIGF0IDcga0h6LCBzbyBub3RoaW5nIGFib3ZlIDE2IGtIeidzIDgga0h6IGxpbWl0IGZvbGRzIGJhY2sgaW50byBzcGVlY2guXG4gICAgY29uc3QgdGFwcyA9IDQ3LCBjdXQgPSA3MDAwIC8gc2FtcGxlUmF0ZTtcbiAgICB0aGlzLnRhcHMgPSBuZXcgRmxvYXQzMkFycmF5KHRhcHMpO1xuICAgIGxldCBzdW0gPSAwO1xuICAgIGZvciAobGV0IGsgPSAwOyBrIDwgdGFwczsgaysrKSB7XG4gICAgICBjb25zdCBtID0gayAtICh0YXBzIC0gMSkgLyAyO1xuICAgICAgY29uc3Qgc2luYyA9IG0gPT09IDAgPyAyICogY3V0IDogTWF0aC5zaW4oMiAqIE1hdGguUEkgKiBjdXQgKiBtKSAvIChNYXRoLlBJICogbSk7XG4gICAgICBjb25zdCB3ID0gMC40MiAtIDAuNSAqIE1hdGguY29zKCgyICogTWF0aC5QSSAqIGspIC8gKHRhcHMgLSAxKSkgKyAwLjA4ICogTWF0aC5jb3MoKDQgKiBNYXRoLlBJICogaykgLyAodGFwcyAtIDEpKTtcbiAgICAgIHRoaXMudGFwc1trXSA9IHNpbmMgKiB3O1xuICAgICAgc3VtICs9IHRoaXMudGFwc1trXTtcbiAgICB9XG4gICAgZm9yIChsZXQgayA9IDA7IGsgPCB0YXBzOyBrKyspIHRoaXMudGFwc1trXSAvPSBzdW07XG4gICAgdGhpcy5oaXN0b3J5ID0gbmV3IEZsb2F0MzJBcnJheSh0YXBzKTtcbiAgICB0aGlzLmF0ID0gMDtcbiAgfVxuICBwcm9jZXNzKGlucHV0cykge1xuICAgIGNvbnN0IGlucHV0ID0gaW5wdXRzWzBdICYmIGlucHV0c1swXVswXTtcbiAgICBpZiAoIWlucHV0KSByZXR1cm4gdHJ1ZTtcbiAgICBjb25zdCB0YXBzID0gdGhpcy50YXBzLCBoID0gdGhpcy5oaXN0b3J5LCBuID0gdGFwcy5sZW5ndGg7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBpbnB1dC5sZW5ndGg7IGkrKykge1xuICAgICAgaFt0aGlzLmF0XSA9IGlucHV0W2ldO1xuICAgICAgdGhpcy5hdCA9ICh0aGlzLmF0ICsgMSkgJSBuO1xuICAgICAgLy8gT25seSB0aGUgc2FtcGxlcyBrZXB0IG5lZWQgZmlsdGVyaW5nOiBhdCBtb3N0IG9uZSBpbiBldmVyeSBzdGVwLlxuICAgICAgaWYgKHRoaXMucG9zID4gMSkgeyB0aGlzLnBvcyAtPSAxOyBjb250aW51ZTsgfVxuICAgICAgbGV0IHggPSAwO1xuICAgICAgZm9yIChsZXQgayA9IDAsIGogPSB0aGlzLmF0OyBrIDwgbjsgaysrLCBqID0gaiArIDEgPT09IG4gPyAwIDogaiArIDEpIHggKz0gdGFwc1trXSAqIGhbal07XG4gICAgICB3aGlsZSAodGhpcy5wb3MgPD0gMSkge1xuICAgICAgICBjb25zdCBzID0gTWF0aC5tYXgoLTEsIE1hdGgubWluKDEsIHgpKTtcbiAgICAgICAgdGhpcy5mcmFtZVt0aGlzLm4rK10gPSBzIDwgMCA/IHMgKiAzMjc2OCA6IHMgKiAzMjc2NztcbiAgICAgICAgaWYgKHRoaXMubiA9PT0gdGhpcy5mcmFtZS5sZW5ndGgpIHtcbiAgICAgICAgICB0aGlzLnBvcnQucG9zdE1lc3NhZ2UodGhpcy5mcmFtZS5idWZmZXIsIFt0aGlzLmZyYW1lLmJ1ZmZlcl0pO1xuICAgICAgICAgIHRoaXMuZnJhbWUgPSBuZXcgSW50MTZBcnJheSgzMjApO1xuICAgICAgICAgIHRoaXMubiA9IDA7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5wb3MgKz0gdGhpcy5zdGVwO1xuICAgICAgfVxuICAgICAgdGhpcy5wb3MgLT0gMTtcbiAgICB9XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbn1cblxuY2xhc3MgUGxheWJhY2sgZXh0ZW5kcyBBdWRpb1dvcmtsZXRQcm9jZXNzb3Ige1xuICBjb25zdHJ1Y3RvcigpIHtcbiAgICBzdXBlcigpO1xuICAgIHRoaXMucXVldWUgPSBbXTsgICAgICAvLyBGbG9hdDMyQXJyYXlzIGF0IHRoZSBjb250ZXh0J3MgcmF0ZVxuICAgIHRoaXMub2Zmc2V0ID0gMDtcbiAgICB0aGlzLmN1ZXMgPSBbXTtcbiAgICB0aGlzLmN1ZU9mZnNldCA9IDA7XG4gICAgdGhpcy5yZXBvcnRlZCA9IDA7XG4gICAgdGhpcy5wb3J0Lm9ubWVzc2FnZSA9IChlKSA9PiB7XG4gICAgICBjb25zdCBtID0gZS5kYXRhO1xuICAgICAgaWYgKG0udHlwZSA9PT0gXCJwbGF5XCIpIHRoaXMucXVldWUucHVzaChtLnNhbXBsZXMpO1xuICAgICAgZWxzZSBpZiAobS50eXBlID09PSBcImN1ZVwiKSB0aGlzLmN1ZXMucHVzaChtLnNhbXBsZXMpO1xuICAgICAgZWxzZSBpZiAobS50eXBlID09PSBcImZsdXNoXCIpIHsgdGhpcy5xdWV1ZSA9IFtdOyB0aGlzLm9mZnNldCA9IDA7IH1cbiAgICAgIGVsc2UgaWYgKG0udHlwZSA9PT0gXCJzdG9wXCIpIHsgdGhpcy5xdWV1ZSA9IFtdOyB0aGlzLm9mZnNldCA9IDA7IHRoaXMuY3VlcyA9IFtdOyB0aGlzLmN1ZU9mZnNldCA9IDA7IH1cbiAgICB9O1xuICB9XG4gIHByb2Nlc3MoXywgb3V0cHV0cykge1xuICAgIGNvbnN0IG91dCA9IG91dHB1dHNbMF1bMF07XG4gICAgb3V0LmZpbGwoMCk7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoICYmIHRoaXMucXVldWUubGVuZ3RoOyBpKyspIHtcbiAgICAgIG91dFtpXSA9IHRoaXMucXVldWVbMF1bdGhpcy5vZmZzZXQrK107XG4gICAgICBpZiAodGhpcy5vZmZzZXQgPj0gdGhpcy5xdWV1ZVswXS5sZW5ndGgpIHsgdGhpcy5xdWV1ZS5zaGlmdCgpOyB0aGlzLm9mZnNldCA9IDA7IH1cbiAgICB9XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoICYmIHRoaXMuY3Vlcy5sZW5ndGg7IGkrKykge1xuICAgICAgb3V0W2ldID0gTWF0aC5tYXgoLTEsIE1hdGgubWluKDEsIG91dFtpXSArIHRoaXMuY3Vlc1swXVt0aGlzLmN1ZU9mZnNldCsrXSkpO1xuICAgICAgaWYgKHRoaXMuY3VlT2Zmc2V0ID49IHRoaXMuY3Vlc1swXS5sZW5ndGgpIHsgdGhpcy5jdWVzLnNoaWZ0KCk7IHRoaXMuY3VlT2Zmc2V0ID0gMDsgfVxuICAgIH1cbiAgICBmb3IgKGxldCBjID0gMTsgYyA8IG91dHB1dHNbMF0ubGVuZ3RoOyBjKyspIG91dHB1dHNbMF1bY10uc2V0KG91dCk7XG4gICAgaWYgKGN1cnJlbnRUaW1lIC0gdGhpcy5yZXBvcnRlZCA+IDAuMSkge1xuICAgICAgdGhpcy5yZXBvcnRlZCA9IGN1cnJlbnRUaW1lO1xuICAgICAgbGV0IHF1ZXVlZCA9IC10aGlzLm9mZnNldDtcbiAgICAgIGZvciAoY29uc3QgcSBvZiB0aGlzLnF1ZXVlKSBxdWV1ZWQgKz0gcS5sZW5ndGg7XG4gICAgICB0aGlzLnBvcnQucG9zdE1lc3NhZ2UoeyBxdWV1ZWQ6IHF1ZXVlZCAvIHNhbXBsZVJhdGUgfSk7XG4gICAgfVxuICAgIHJldHVybiB0cnVlO1xuICB9XG59XG5yZWdpc3RlclByb2Nlc3NvcihcImNhcHR1cmVcIiwgQ2FwdHVyZSk7XG5yZWdpc3RlclByb2Nlc3NvcihcInBsYXliYWNrXCIsIFBsYXliYWNrKTtcbmA7XG5cbmZ1bmN0aW9uIGJhc2U2NFRvQnl0ZXMoYjY0OiBzdHJpbmcpOiBVaW50OEFycmF5IHtcbiAgY29uc3QgYmluID0gYXRvYihiNjQpO1xuICBjb25zdCBvdXQgPSBuZXcgVWludDhBcnJheShiaW4ubGVuZ3RoKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBiaW4ubGVuZ3RoOyBpKyspIG91dFtpXSA9IGJpbi5jaGFyQ29kZUF0KGkpO1xuICByZXR1cm4gb3V0O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYnl0ZXNUb0Jhc2U2NChieXRlczogVWludDhBcnJheSk6IHN0cmluZyB7XG4gIGxldCBiaW4gPSBcIlwiO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGJ5dGVzLmxlbmd0aDsgaSArPSAweDgwMDApIGJpbiArPSBTdHJpbmcuZnJvbUNoYXJDb2RlKC4uLmJ5dGVzLnN1YmFycmF5KGksIGkgKyAweDgwMDApKTtcbiAgcmV0dXJuIGJ0b2EoYmluKTtcbn1cblxuLyoqIFBDTTE2IGxpdHRsZS1lbmRpYW4gYXQgW3JhdGVdLCBhcyBmbG9hdHMgYXQgdGhlIGNvbnRleHQncyByYXRlLiAqL1xuZnVuY3Rpb24gdG9GbG9hdHMocGNtOiBVaW50OEFycmF5LCByYXRlOiBudW1iZXIsIHRhcmdldDogbnVtYmVyKTogRmxvYXQzMkFycmF5IHtcbiAgY29uc3QgdmlldyA9IG5ldyBEYXRhVmlldyhwY20uYnVmZmVyLCBwY20uYnl0ZU9mZnNldCwgcGNtLmJ5dGVMZW5ndGgpO1xuICBjb25zdCBuID0gTWF0aC5mbG9vcihwY20uYnl0ZUxlbmd0aCAvIDIpO1xuICBjb25zdCBvdXQgPSBuZXcgRmxvYXQzMkFycmF5KE1hdGguZmxvb3IoKG4gKiB0YXJnZXQpIC8gcmF0ZSkpO1xuICBjb25zdCBzdGVwID0gcmF0ZSAvIHRhcmdldDtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCB4ID0gaSAqIHN0ZXA7XG4gICAgY29uc3QgaiA9IE1hdGguZmxvb3IoeCk7XG4gICAgY29uc3QgYSA9IHZpZXcuZ2V0SW50MTYoMiAqIE1hdGgubWluKGosIG4gLSAxKSwgdHJ1ZSk7XG4gICAgY29uc3QgYiA9IHZpZXcuZ2V0SW50MTYoMiAqIE1hdGgubWluKGogKyAxLCBuIC0gMSksIHRydWUpO1xuICAgIG91dFtpXSA9IChhICsgKGIgLSBhKSAqICh4IC0gaikpIC8gMzI3Njg7XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBNaWNPcHRpb25zIHsgZWNob0NhbmNlbGxhdGlvbjogYm9vbGVhbjsgbm9pc2VTdXBwcmVzc2lvbjogYm9vbGVhbjsgYXV0b0dhaW5Db250cm9sOiBib29sZWFuIH1cblxuZXhwb3J0IGNsYXNzIENhbGxBdWRpbyB7XG4gIHByaXZhdGUgY29udGV4dDogQXVkaW9Db250ZXh0IHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgcGxheWJhY2s6IEF1ZGlvV29ya2xldE5vZGUgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBjYXB0dXJlOiBBdWRpb1dvcmtsZXROb2RlIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgc3RyZWFtOiBNZWRpYVN0cmVhbSB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIHNvdXJjZTogTWVkaWFTdHJlYW1BdWRpb1NvdXJjZU5vZGUgfCBudWxsID0gbnVsbDtcbiAgLyoqIFNlY29uZHMgb2Ygc3BlZWNoIHF1ZXVlZCwgYXMgdGhlIHdvcmtsZXQgbGFzdCBzYWlkLiAqL1xuICBxdWV1ZWQgPSAwO1xuICAvKiogVGhlIG1pY3JvcGhvbmUncyBsZXZlbCwgUk1TIG9mIHRoZSBsYXN0IGZyYW1lICgwIHRvIDEpLiAqL1xuICBsZXZlbCA9IDA7XG5cbiAgYXN5bmMgb3BlbigpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAodGhpcy5jb250ZXh0KSB7IGlmICh0aGlzLmNvbnRleHQuc3RhdGUgPT09IFwic3VzcGVuZGVkXCIpIGF3YWl0IHRoaXMuY29udGV4dC5yZXN1bWUoKTsgcmV0dXJuOyB9XG4gICAgdGhpcy5jb250ZXh0ID0gbmV3IEF1ZGlvQ29udGV4dCh7IGxhdGVuY3lIaW50OiBcImludGVyYWN0aXZlXCIgfSk7XG4gICAgY29uc3QgdXJsID0gVVJMLmNyZWF0ZU9iamVjdFVSTChuZXcgQmxvYihbV09SS0xFVFNdLCB7IHR5cGU6IFwidGV4dC9qYXZhc2NyaXB0XCIgfSkpO1xuICAgIGF3YWl0IHRoaXMuY29udGV4dC5hdWRpb1dvcmtsZXQuYWRkTW9kdWxlKHVybCk7XG4gICAgdGhpcy5wbGF5YmFjayA9IG5ldyBBdWRpb1dvcmtsZXROb2RlKHRoaXMuY29udGV4dCwgXCJwbGF5YmFja1wiLCB7IG51bWJlck9mSW5wdXRzOiAwLCBvdXRwdXRDaGFubmVsQ291bnQ6IFsyXSB9KTtcbiAgICB0aGlzLnBsYXliYWNrLnBvcnQub25tZXNzYWdlID0gKGUpID0+IHsgdGhpcy5xdWV1ZWQgPSBlLmRhdGEucXVldWVkOyB9O1xuICAgIHRoaXMucGxheWJhY2suY29ubmVjdCh0aGlzLmNvbnRleHQuZGVzdGluYXRpb24pO1xuICB9XG5cbiAgLyoqIFNlY29uZHMgZnJvbSBhIHNhbXBsZSBsZWF2aW5nIHRoZSB3b3JrbGV0IHRvIHRoZSBzcGVha2VyLCBhcyB0aGUgYnJvd3NlciByZWNrb25zIGl0LiAqL1xuICBnZXQgb3V0cHV0TGF0ZW5jeSgpOiBudW1iZXIgfCBudWxsIHtcbiAgICBpZiAoIXRoaXMuY29udGV4dCkgcmV0dXJuIG51bGw7XG4gICAgcmV0dXJuIHRoaXMuY29udGV4dC5iYXNlTGF0ZW5jeSArICgodGhpcy5jb250ZXh0IGFzIEF1ZGlvQ29udGV4dCAmIHsgb3V0cHV0TGF0ZW5jeT86IG51bWJlciB9KS5vdXRwdXRMYXRlbmN5ID8/IDApO1xuICB9XG5cbiAgYXN5bmMgc3RhcnRNaWMob25GcmFtZTogKHBjbTY0OiBzdHJpbmcsIGxldmVsOiBudW1iZXIpID0+IHZvaWQsIG9wdGlvbnM6IE1pY09wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBhd2FpdCB0aGlzLm9wZW4oKTtcbiAgICB0aGlzLnN0b3BNaWMoKTtcbiAgICBjb25zdCBjb250ZXh0ID0gdGhpcy5jb250ZXh0ITtcbiAgICB0aGlzLnN0cmVhbSA9IGF3YWl0IG5hdmlnYXRvci5tZWRpYURldmljZXMuZ2V0VXNlck1lZGlhKHsgYXVkaW86IHsgY2hhbm5lbENvdW50OiAxLCAuLi5vcHRpb25zIH0gfSk7XG4gICAgdGhpcy5zb3VyY2UgPSBjb250ZXh0LmNyZWF0ZU1lZGlhU3RyZWFtU291cmNlKHRoaXMuc3RyZWFtKTtcbiAgICB0aGlzLmNhcHR1cmUgPSBuZXcgQXVkaW9Xb3JrbGV0Tm9kZShjb250ZXh0LCBcImNhcHR1cmVcIiwgeyBudW1iZXJPZk91dHB1dHM6IDAgfSk7XG4gICAgdGhpcy5jYXB0dXJlLnBvcnQub25tZXNzYWdlID0gKGUpID0+IHtcbiAgICAgIGNvbnN0IGZyYW1lID0gbmV3IEludDE2QXJyYXkoZS5kYXRhIGFzIEFycmF5QnVmZmVyKTtcbiAgICAgIGxldCBzdW0gPSAwO1xuICAgICAgZm9yIChjb25zdCBzIG9mIGZyYW1lKSBzdW0gKz0gcyAqIHM7XG4gICAgICB0aGlzLmxldmVsID0gTWF0aC5zcXJ0KHN1bSAvIGZyYW1lLmxlbmd0aCkgLyAzMjc2ODtcbiAgICAgIG9uRnJhbWUoYnl0ZXNUb0Jhc2U2NChuZXcgVWludDhBcnJheShlLmRhdGEgYXMgQXJyYXlCdWZmZXIpKSwgdGhpcy5sZXZlbCk7XG4gICAgfTtcbiAgICB0aGlzLnNvdXJjZS5jb25uZWN0KHRoaXMuY2FwdHVyZSk7XG4gIH1cblxuICBzdG9wTWljKCk6IHZvaWQge1xuICAgIHRoaXMuc291cmNlPy5kaXNjb25uZWN0KCk7XG4gICAgdGhpcy5jYXB0dXJlPy5wb3J0LmNsb3NlKCk7XG4gICAgdGhpcy5zdHJlYW0/LmdldFRyYWNrcygpLmZvckVhY2goKHQpID0+IHQuc3RvcCgpKTtcbiAgICB0aGlzLnNvdXJjZSA9IG51bGw7XG4gICAgdGhpcy5jYXB0dXJlID0gbnVsbDtcbiAgICB0aGlzLnN0cmVhbSA9IG51bGw7XG4gIH1cblxuICBwbGF5KHBjbTY0OiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuY29udGV4dCB8fCAhdGhpcy5wbGF5YmFjaykgcmV0dXJuO1xuICAgIGNvbnN0IHNhbXBsZXMgPSB0b0Zsb2F0cyhiYXNlNjRUb0J5dGVzKHBjbTY0KSwgMjQwMDAsIHRoaXMuY29udGV4dC5zYW1wbGVSYXRlKTtcbiAgICB0aGlzLnBsYXliYWNrLnBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcInBsYXlcIiwgc2FtcGxlcyB9LCBbc2FtcGxlcy5idWZmZXJdKTtcbiAgfVxuXG4gIGN1ZShwY202NDogc3RyaW5nKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLmNvbnRleHQgfHwgIXRoaXMucGxheWJhY2spIHJldHVybjtcbiAgICBjb25zdCBzYW1wbGVzID0gdG9GbG9hdHMoYmFzZTY0VG9CeXRlcyhwY202NCksIDI0MDAwLCB0aGlzLmNvbnRleHQuc2FtcGxlUmF0ZSk7XG4gICAgdGhpcy5wbGF5YmFjay5wb3J0LnBvc3RNZXNzYWdlKHsgdHlwZTogXCJjdWVcIiwgc2FtcGxlcyB9LCBbc2FtcGxlcy5idWZmZXJdKTtcbiAgfVxuXG4gIGZsdXNoKCk6IHZvaWQge1xuICAgIHRoaXMucGxheWJhY2s/LnBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcImZsdXNoXCIgfSk7XG4gIH1cblxuICBzdG9wKCk6IHZvaWQge1xuICAgIHRoaXMuc3RvcE1pYygpO1xuICAgIHRoaXMucGxheWJhY2s/LnBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcInN0b3BcIiB9KTtcbiAgfVxufVxuIiwgIi8vIFRoZSByZXBsYXkgdmlldzogYSByZWNvcmRlZCBjYWxsIChhIHRyYWNlIGZyb20gYW55IGhvc3QsIG9yIGEgc2NlbmFyaW8pIHJ1biBhZ2FpbiB0aHJvdWdoIHRoZVxuLy8gY29yZSwgYXMgdGhlIGJ1aWxkIHRoYXQgcmVjb3JkZWQgaXQgZGlkIGFuZCBhcyB0aGUgbGF0ZXN0IGRvZXMsIHNpZGUgYnkgc2lkZS4gV2hlcmUgdGhleSBwYXJ0XG4vLyBpcyB3aGVyZSBhIGNoYW5nZSBpbiBzcmMvIGNoYW5nZWQgd2hhdCB0aGUgY2FsbCBkb2VzIHdpdGggdGhlIHNhbWUgd29yZHMgYW5kIHRoZSBzYW1lIG1vZGVsLlxuXG5pbnRlcmZhY2UgQ29yZSB7XG4gIHZlcnNpb246IHN0cmluZztcbiAgY3JlYXRlKGNvbmZpZzogc3RyaW5nLCB0OiBudW1iZXIpOiBzdHJpbmc7XG4gIHB1c2goaWQ6IG51bWJlciwgZXZlbnQ6IHN0cmluZyk6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFJlY29yZGluZyB7IHZlcnNpb24/OiBzdHJpbmc7IGNvbmZpZzogdW5rbm93bjsgc3RhcnQ6IG51bWJlcjsgZXZlbnRzOiBSZWNvcmQ8c3RyaW5nLCBhbnk+W10gfVxuXG4vKiogV2hhdCBhIGNvbW1hbmQgb3IgZXZlbnQgbG9va3MgbGlrZSBpbiBhIHRpbWVsaW5lOiBhdWRpbyBjdXQgb3V0LCBvbmUgbGluZS4gKi9cbmZ1bmN0aW9uIGxpbmUobzogUmVjb3JkPHN0cmluZywgYW55Pik6IHN0cmluZyB7XG4gIGNvbnN0IHRleHQgPSBKU09OLnN0cmluZ2lmeShvKS5yZXBsYWNlKC9cIihkYXRhfHBjbSlcIjpcIltBLVphLXowLTkrLz1dezQwLH1cIi9nLCAnXCIkMVwiOlwiXHUyMDI2XCInKVxuICAgIC5yZXBsYWNlKC9cXFxcXCJkYXRhXFxcXFwiOlxcXFxcIltBLVphLXowLTkrLz1dezQwLH1cXFxcXCIvZywgJ1xcXFxcImRhdGFcXFxcXCI6XFxcXFwiXHUyMDI2XFxcXFwiJyk7XG4gIHJldHVybiB0ZXh0Lmxlbmd0aCA+IDQwMCA/IHRleHQuc2xpY2UoMCwgNDAwKSArIFwiXHUyMDI2XCIgOiB0ZXh0O1xufVxuXG4vKiogQXVkaW8gYW5kIHRpY2tzIHNheSBub3RoaW5nIGEgcmVhZGVyIG5lZWRzOyB0aGUgcmVzdCBkb2VzLiAqL1xuZnVuY3Rpb24gdGVsbGluZyhvOiBSZWNvcmQ8c3RyaW5nLCBhbnk+KTogYm9vbGVhbiB7XG4gIGlmIChvLnR5cGUgPT09IFwibWljXCIgfHwgby50eXBlID09PSBcInRpY2tcIiB8fCBvLnR5cGUgPT09IFwicGxheVwiKSByZXR1cm4gZmFsc2U7XG4gIGlmIChvLnR5cGUgPT09IFwid3Muc2VuZFwiICYmIFN0cmluZyhvLmRhdGEpLnN0YXJ0c1dpdGgoJ3tcInJlYWx0aW1lSW5wdXRcIjp7XCJhdWRpb1wiJykpIHJldHVybiBmYWxzZTtcbiAgaWYgKG8udHlwZSA9PT0gXCJ3cy5tZXNzYWdlXCIgJiYgU3RyaW5nKG8uZGF0YSkuaW5jbHVkZXMoJ1wiaW5saW5lRGF0YVwiJykgJiYgIVN0cmluZyhvLmRhdGEpLmluY2x1ZGVzKCdcInR1cm5Db21wbGV0ZVwiJykpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmZ1bmN0aW9uIHJ1bihjb3JlOiBDb3JlLCByOiBSZWNvcmRpbmcpOiBzdHJpbmdbXVtdIHtcbiAgY29uc3QgY3JlYXRlZCA9IEpTT04ucGFyc2UoY29yZS5jcmVhdGUoSlNPTi5zdHJpbmdpZnkoci5jb25maWcpLCByLnN0YXJ0KSk7XG4gIGNvbnN0IG91dDogc3RyaW5nW11bXSA9IFtjcmVhdGVkLmNvbW1hbmRzLmZpbHRlcih0ZWxsaW5nKS5tYXAobGluZSldO1xuICBmb3IgKGNvbnN0IGUgb2Ygci5ldmVudHMpIG91dC5wdXNoKChKU09OLnBhcnNlKGNvcmUucHVzaChjcmVhdGVkLmlkLCBKU09OLnN0cmluZ2lmeShlKSkpIGFzIFJlY29yZDxzdHJpbmcsIGFueT5bXSkuZmlsdGVyKHRlbGxpbmcpLm1hcChsaW5lKSk7XG4gIHJldHVybiBvdXQ7XG59XG5cbmV4cG9ydCBjbGFzcyBSZXBsYXkge1xuICBwcml2YXRlIHJlYWRvbmx5IHJvb3Q6IEhUTUxFbGVtZW50O1xuICBwcml2YXRlIHJlYWRvbmx5IGxvYWQ6ICh1cmw/OiBzdHJpbmcpID0+IFByb21pc2U8Q29yZT47XG5cbiAgY29uc3RydWN0b3Iocm9vdDogSFRNTEVsZW1lbnQsIGxvYWQ6ICh1cmw/OiBzdHJpbmcpID0+IFByb21pc2U8Q29yZT4pIHtcbiAgICB0aGlzLnJvb3QgPSByb290O1xuICAgIHRoaXMubG9hZCA9IGxvYWQ7XG4gICAgcm9vdC5pbm5lckhUTUwgPSBgXG4gICAgICA8ZGl2IGNsYXNzPVwiYmFyXCI+PHNlbGVjdCBjbGFzcz1cInBpY2tcIj48L3NlbGVjdD48YnV0dG9uIGNsYXNzPVwicmVmcmVzaFwiPlx1MjFCQjwvYnV0dG9uPjxidXR0b24gY2xhc3M9XCJnb1wiPlJlcGxheTwvYnV0dG9uPlxuICAgICAgPGxhYmVsPjxpbnB1dCB0eXBlPVwiY2hlY2tib3hcIiBjbGFzcz1cImFsbFwiPiBzaG93IGF1ZGlvIGFuZCB0aWNrczwvbGFiZWw+PHNwYW4gY2xhc3M9XCJzdW1tYXJ5XCI+PC9zcGFuPjwvZGl2PlxuICAgICAgPGRpdiBjbGFzcz1cInRpbWVsaW5lXCI+PC9kaXY+YDtcbiAgICAocm9vdC5xdWVyeVNlbGVjdG9yKFwiLnJlZnJlc2hcIikgYXMgSFRNTEVsZW1lbnQpLm9uY2xpY2sgPSAoKSA9PiB2b2lkIHRoaXMubGlzdCgpO1xuICAgIChyb290LnF1ZXJ5U2VsZWN0b3IoXCIuZ29cIikgYXMgSFRNTEVsZW1lbnQpLm9uY2xpY2sgPSAoKSA9PiB2b2lkIHRoaXMucmVwbGF5KCkuY2F0Y2goKGVycikgPT4gdGhpcy5zYXkoYFJlcGxheSBmYWlsZWQ6ICR7ZXJyLm1lc3NhZ2V9YCkpO1xuICAgIHZvaWQgdGhpcy5saXN0KCk7XG4gIH1cblxuICBwcml2YXRlIHNheSh0ZXh0OiBzdHJpbmcpIHtcbiAgICAodGhpcy5yb290LnF1ZXJ5U2VsZWN0b3IoXCIuc3VtbWFyeVwiKSBhcyBIVE1MRWxlbWVudCkudGV4dENvbnRlbnQgPSB0ZXh0O1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBsaXN0KCkge1xuICAgIGNvbnN0IHBpY2sgPSB0aGlzLnJvb3QucXVlcnlTZWxlY3RvcihcIi5waWNrXCIpIGFzIEhUTUxTZWxlY3RFbGVtZW50O1xuICAgIHBpY2suaW5uZXJIVE1MID0gXCJcIjtcbiAgICBjb25zdCB0cmFjZXM6IHsgbmFtZTogc3RyaW5nOyBieXRlczogbnVtYmVyIH1bXSA9IGF3YWl0IChhd2FpdCBmZXRjaChcIi90cmFjZXNcIikpLmpzb24oKTtcbiAgICBjb25zdCBzY2VuYXJpb3M6IHN0cmluZ1tdID0gYXdhaXQgKGF3YWl0IGZldGNoKFwiL3NjZW5hcmlvc1wiKSkuanNvbigpO1xuICAgIGNvbnN0IHRyYWNlR3JvdXAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwib3B0Z3JvdXBcIik7XG4gICAgdHJhY2VHcm91cC5sYWJlbCA9IFwiUmVjb3JkZWQgY2FsbHNcIjtcbiAgICBmb3IgKGNvbnN0IHQgb2YgdHJhY2VzKSB0cmFjZUdyb3VwLmFwcGVuZChuZXcgT3B0aW9uKGAke3QubmFtZX0gKCR7TWF0aC5yb3VuZCh0LmJ5dGVzIC8gMTAyNCl9IEtCKWAsIGAvdHJhY2VzLyR7dC5uYW1lfWApKTtcbiAgICBjb25zdCBzY2VuYXJpb0dyb3VwID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcIm9wdGdyb3VwXCIpO1xuICAgIHNjZW5hcmlvR3JvdXAubGFiZWwgPSBcIlNjZW5hcmlvc1wiO1xuICAgIGZvciAoY29uc3QgcyBvZiBzY2VuYXJpb3MpIHNjZW5hcmlvR3JvdXAuYXBwZW5kKG5ldyBPcHRpb24ocywgYC9zY2VuYXJpb3MvJHtzfS5qc29uYCkpO1xuICAgIHBpY2suYXBwZW5kKHRyYWNlR3JvdXAsIHNjZW5hcmlvR3JvdXApO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyByZWNvcmRpbmcodXJsOiBzdHJpbmcpOiBQcm9taXNlPFJlY29yZGluZz4ge1xuICAgIGNvbnN0IHRleHQgPSBhd2FpdCAoYXdhaXQgZmV0Y2godXJsLCB7IGNhY2hlOiBcIm5vLXN0b3JlXCIgfSkpLnRleHQoKTtcbiAgICBpZiAodXJsLmVuZHNXaXRoKFwiLmpzb25cIikpIHJldHVybiBKU09OLnBhcnNlKHRleHQpO1xuICAgIGNvbnN0IFtoZWFkZXIsIC4uLmV2ZW50c10gPSB0ZXh0LnRyaW0oKS5zcGxpdChcIlxcblwiKS5tYXAoKGwpID0+IEpTT04ucGFyc2UobCkpO1xuICAgIHJldHVybiB7IC4uLmhlYWRlciwgZXZlbnRzIH07XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHJlcGxheSgpIHtcbiAgICBjb25zdCB1cmwgPSAodGhpcy5yb290LnF1ZXJ5U2VsZWN0b3IoXCIucGlja1wiKSBhcyBIVE1MU2VsZWN0RWxlbWVudCkudmFsdWU7XG4gICAgaWYgKCF1cmwpIHJldHVybjtcbiAgICBjb25zdCByID0gYXdhaXQgdGhpcy5yZWNvcmRpbmcodXJsKTtcbiAgICBjb25zdCBsYXRlc3QgPSBhd2FpdCB0aGlzLmxvYWQoKTtcbiAgICBsZXQgcmVjb3JkZWQ6IENvcmUgfCBudWxsID0gbnVsbDtcbiAgICBpZiAoci52ZXJzaW9uICYmIHIudmVyc2lvbiAhPT0gbGF0ZXN0LnZlcnNpb24pIHtcbiAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goYC92ZXJzaW9ucy8ke3IudmVyc2lvbn0uanNgLCB7IG1ldGhvZDogXCJIRUFEXCIgfSk7XG4gICAgICBpZiAocmVzcG9uc2Uub2spIHJlY29yZGVkID0gYXdhaXQgdGhpcy5sb2FkKGAvdmVyc2lvbnMvJHtyLnZlcnNpb259LmpzYCk7XG4gICAgfVxuICAgIGNvbnN0IG5vdyA9IHJ1bihsYXRlc3QsIHIpO1xuICAgIGNvbnN0IHRoZW4gPSByZWNvcmRlZCA/IHJ1bihyZWNvcmRlZCwgcikgOiBudWxsO1xuICAgIGNvbnN0IGFsbCA9ICh0aGlzLnJvb3QucXVlcnlTZWxlY3RvcihcIi5hbGxcIikgYXMgSFRNTElucHV0RWxlbWVudCkuY2hlY2tlZDtcbiAgICBjb25zdCB0aW1lbGluZSA9IHRoaXMucm9vdC5xdWVyeVNlbGVjdG9yKFwiLnRpbWVsaW5lXCIpIGFzIEhUTUxFbGVtZW50O1xuICAgIHRpbWVsaW5lLmlubmVySFRNTCA9IFwiXCI7XG4gICAgbGV0IGZpcnN0ID0gLTE7XG4gICAgbGV0IGRpZmZlciA9IDA7XG4gICAgY29uc3Qgcm93czogSFRNTEVsZW1lbnRbXSA9IFtdO1xuICAgIGNvbnN0IGFkZCA9IChjbHM6IHN0cmluZywgdDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpID0+IHtcbiAgICAgIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICByb3cuY2xhc3NOYW1lID0gYHJvdyAke2Nsc31gO1xuICAgICAgcm93LmlubmVySFRNTCA9IGA8c3BhbiBjbGFzcz1cInRcIj4ke3R9PC9zcGFuPmA7XG4gICAgICBjb25zdCBiID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gICAgICBiLmNsYXNzTmFtZSA9IFwiYlwiO1xuICAgICAgYi50ZXh0Q29udGVudCA9IHRleHQ7XG4gICAgICByb3cuYXBwZW5kKGIpO1xuICAgICAgdGltZWxpbmUuYXBwZW5kKHJvdyk7XG4gICAgICByb3dzLnB1c2gocm93KTtcbiAgICAgIHJldHVybiByb3c7XG4gICAgfTtcbiAgICBjb25zdCB0MCA9IHIuc3RhcnQ7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPD0gci5ldmVudHMubGVuZ3RoOyBpKyspIHtcbiAgICAgIGNvbnN0IGUgPSBpID09PSAwID8gbnVsbCA6IHIuZXZlbnRzW2kgLSAxXTtcbiAgICAgIGNvbnN0IG5vd091dCA9IG5vd1tpXTtcbiAgICAgIGNvbnN0IHRoZW5PdXQgPSB0aGVuID8gdGhlbltpXSA6IG5vd091dDtcbiAgICAgIGNvbnN0IHNhbWUgPSBub3dPdXQubGVuZ3RoID09PSB0aGVuT3V0Lmxlbmd0aCAmJiBub3dPdXQuZXZlcnkoKGMsIGopID0+IGMgPT09IHRoZW5PdXRbal0pO1xuICAgICAgaWYgKCFzYW1lKSB7IGRpZmZlcisrOyBpZiAoZmlyc3QgPCAwKSBmaXJzdCA9IGk7IH1cbiAgICAgIGlmICghc2FtZSB8fCBhbGwgfHwgKGUgJiYgdGVsbGluZyhlKSkgfHwgbm93T3V0Lmxlbmd0aCA+IDApIHtcbiAgICAgICAgaWYgKGUgJiYgKGFsbCB8fCB0ZWxsaW5nKGUpIHx8ICFzYW1lKSkgYWRkKFwiaW5cIiwgKGUudCAtIHQwKS50b0ZpeGVkKDIpLCBsaW5lKGUpKTtcbiAgICAgICAgY29uc3QgdCA9IGUgPyAoZS50IC0gdDApLnRvRml4ZWQoMikgOiBcIjAuMDBcIjtcbiAgICAgICAgaWYgKHNhbWUpIGZvciAoY29uc3QgYyBvZiBub3dPdXQpIGFkZChcIm91dFwiLCB0LCBjKTtcbiAgICAgICAgZWxzZSB7XG4gICAgICAgICAgZm9yIChjb25zdCBjIG9mIHRoZW5PdXQpIGFkZChcIm91dCBnb25lXCIsIHQsIGBcdTIyMTIgJHtjfWApO1xuICAgICAgICAgIGZvciAoY29uc3QgYyBvZiBub3dPdXQpIGFkZChcIm91dCBuZXdcIiwgdCwgYCsgJHtjfWApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IHZlcnNpb25zID0gdGhlbiA/IGByZWNvcmRlZCBieSAke3IudmVyc2lvbn0sIHJlcGxheWVkIGJ5IGl0IGFuZCBieSAke2xhdGVzdC52ZXJzaW9ufWAgOiBgcmVwbGF5ZWQgYnkgJHtsYXRlc3QudmVyc2lvbn1gICtcbiAgICAgIChyLnZlcnNpb24gJiYgci52ZXJzaW9uICE9PSBsYXRlc3QudmVyc2lvbiA/IGAgKHRoZSByZWNvcmRpbmcncyBidWlsZCAke3IudmVyc2lvbn0gaXNuJ3Qga2VwdCBoZXJlKWAgOiBcIlwiKTtcbiAgICB0aGlzLnNheShgJHtyLmV2ZW50cy5sZW5ndGh9IGV2ZW50cywgJHt2ZXJzaW9uc30uIGAgKyAodGhlbiA/IChkaWZmZXIgPyBgJHtkaWZmZXJ9IGV2ZW50cyBhbnN3ZXJlZCBkaWZmZXJlbnRseSwgdGhlIGZpcnN0IGF0IGV2ZW50ICR7Zmlyc3R9LmAgOiBcIkJvdGggYW5zd2VyZWQgZXZlcnkgZXZlbnQgdGhlIHNhbWUuXCIpIDogXCJcIikpO1xuICAgIGlmIChmaXJzdCA+PSAwKSB0aW1lbGluZS5xdWVyeVNlbGVjdG9yKFwiLmdvbmUsIC5uZXdcIik/LnNjcm9sbEludG9WaWV3KHsgYmxvY2s6IFwiY2VudGVyXCIgfSk7XG4gIH1cbn1cbiIsICIvLyBUaGUgd2ViIHN1cmZhY2U6IGEgZm91cnRoIGhvc3QgZm9yIHRoZSB2b2ljZSBjb3JlLCBhbmQgYSBwaG9uZS1mcmllbmRseSB3YXkgdG8gdXNlIGl0IGZvciB3b3JrLlxuLy8gSXQgbG9hZHMgdGhlIGRldiBzZXJ2ZXIncyBsYXRlc3QgYnVpbGQgYXQgZWFjaCBjYWxsLCBzbyBhbiBlZGl0IGluIHNyYy8gaXMgbGl2ZSBvbiB0aGUgbmV4dFxuLy8gY2FsbCwgYW5kIGtlZXBzIGV2ZXJ5IGNhbGwgYXMgYSB0cmFjZSB0aGUgcmVwbGF5IHZpZXcgKGFuZCBhbnkgb3RoZXIgaG9zdCkgY2FuIHJ1biBhZ2Fpbi5cbi8vXG4vLyBUaGUgaG9zdCdzIHBhcnQgaXMgc21hbGw6IHRoZSBtaWNyb3Bob25lIGFuZCBzcGVha2VyIChhdWRpby50cyksIHRoZSBtb2RlbCdzIHNvY2tldCB0aHJvdWdoIHRoZVxuLy8gc2VydmVyJ3MgcmVsYXksIEhlcm1lcyBhbmQgVDMgdGhyb3VnaCB0aGUgc2VydmVyLCBhbmQgdGhlIHNjcmVlbi4gVGhlIGNvcmUgZGVjaWRlcyB0aGUgcmVzdC5cbi8vXG4vLyBUeXBpbmcgd2l0aCBubyBjYWxsIG9uIHN0YXJ0cyBhIGNoYXQgaW5zdGVhZDogdGhlIHNhbWUgY29yZSB3aXRoIGBtZWRpdW06IFwidGV4dFwiYCwgd2hvc2UgcmVxdWVzdHNcbi8vIHRvIHRoZSB0ZXh0IG1vZGVsIGdvIHRocm91Z2ggdGhlIHNlcnZlcidzIC9nZW5lcmF0ZS4gVGFza3MsIGZvbGxvdy11cHMgYW5kIHRoZWlyIGNhcmRzIHdvcmsgYXNcbi8vIGluIGEgY2FsbC4gUHJlc3NpbmcgQ2FsbCBlbmRzIHRoZSBjaGF0IGFuZCBjYXJyaWVzIGl0cyBjb252ZXJzYXRpb24gb24gYnkgdm9pY2UuXG5cbmltcG9ydCB7IGNvbW1hbmRJbiB9IGZyb20gXCIuLi9zcmMvY29tbWFuZHMudHNcIjtcbmltcG9ydCB7IENhbGxBdWRpbyB9IGZyb20gXCIuL2F1ZGlvLnRzXCI7XG5pbXBvcnQgeyBSZXBsYXkgfSBmcm9tIFwiLi9yZXBsYXkudHNcIjtcblxuaW50ZXJmYWNlIENvcmUge1xuICB2ZXJzaW9uOiBzdHJpbmc7XG4gIGRlZmF1bHRzKCk6IHN0cmluZztcbiAgY3JlYXRlKGNvbmZpZzogc3RyaW5nLCB0OiBudW1iZXIpOiBzdHJpbmc7XG4gIHB1c2goaWQ6IG51bWJlciwgZXZlbnQ6IHN0cmluZyk6IHN0cmluZztcbiAgdHJhY2UoaWQ6IG51bWJlcik6IHN0cmluZztcbiAgZGlzcG9zZShpZDogbnVtYmVyKTogdm9pZDtcbn1cbnR5cGUgQ29tbWFuZCA9IFJlY29yZDxzdHJpbmcsIGFueT4gJiB7IHR5cGU6IHN0cmluZyB9O1xuaW50ZXJmYWNlIFNlcnZlckNvbmZpZyB7IHJvdXRlOiBzdHJpbmc7IG1vZGVsOiBzdHJpbmc7IGNhcHRpb25zTW9kZWw/OiBzdHJpbmc7IHRleHRNb2RlbD86IHN0cmluZzsgdmVyc2lvbjogc3RyaW5nOyBoZXJtZXM6IGJvb2xlYW47IHQzOiBzdHJpbmdbXSB8IG51bGwgfVxuXG5jb25zdCAkID0gPFQgZXh0ZW5kcyBIVE1MRWxlbWVudCA9IEhUTUxFbGVtZW50PihpZDogc3RyaW5nKSA9PiBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChpZCkgYXMgVDtcbmNvbnN0IG5vdyA9ICgpID0+IHBlcmZvcm1hbmNlLm5vdygpIC8gMTAwMDtcbmNvbnN0IGNoZWNrZWQgPSAoaWQ6IHN0cmluZykgPT4gJDxIVE1MSW5wdXRFbGVtZW50PihpZCkuY2hlY2tlZDtcblxuLyoqIFRoZSBsYXRlc3QgYnVpbGQgZnJvbSB0aGUgZGV2IHNlcnZlciwgZXZhbHVhdGVkIGFmcmVzaDogYW4gZWRpdCBpbiBzcmMvIGlzIGluIHRoZSBuZXh0IGNhbGwuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbG9hZENvcmUodXJsID0gXCIvdm9pY2UtY29yZS5qc1wiKTogUHJvbWlzZTxDb3JlPiB7XG4gIGNvbnN0IHNvdXJjZSA9IGF3YWl0IChhd2FpdCBmZXRjaCh1cmwsIHsgY2FjaGU6IFwibm8tc3RvcmVcIiB9KSkudGV4dCgpO1xuICBjb25zdCBzY29wZTogeyBWb2ljZUNvcmU/OiBDb3JlIH0gPSB7fTtcbiAgbmV3IEZ1bmN0aW9uKFwiZ2xvYmFsVGhpc1wiLCBzb3VyY2UpKHNjb3BlKTtcbiAgaWYgKCFzY29wZS5Wb2ljZUNvcmUpIHRocm93IG5ldyBFcnJvcihcInRoZSBidW5kbGUgZGlkbid0IGRlZmluZSBWb2ljZUNvcmVcIik7XG4gIHJldHVybiBzY29wZS5Wb2ljZUNvcmU7XG59XG5cbi8vIFByZXNldHM6IGVhY2ggc3VyZmFjZSdzIHNldHRpbmdzIGFzIGl0cyBhcHAgd291bGQgc2V0IHRoZW0uXG5cbmNvbnN0IEZBS0VfVFYgPSBbXG4gIHsgbmFtZTogXCJ0dl92b2x1bWVcIiwgZGVzY3JpcHRpb246IFwiU2V0cyB0aGUgbGl2aW5nLXJvb20gVFYncyB2b2x1bWUsIDAgdG8gMTAwLlwiLCBwYXJhbWV0ZXJzOiB7IHR5cGU6IFwiT0JKRUNUXCIsIHByb3BlcnRpZXM6IHsgbGV2ZWw6IHsgdHlwZTogXCJJTlRFR0VSXCIgfSB9LCByZXF1aXJlZDogW1wibGV2ZWxcIl0gfSB9LFxuICB7IG5hbWU6IFwidHZfcGF1c2VcIiwgZGVzY3JpcHRpb246IFwiUGF1c2VzIG9yIHJlc3VtZXMgd2hhdCdzIHBsYXlpbmcgb24gdGhlIFRWLlwiLCBwYXJhbWV0ZXJzOiB7IHR5cGU6IFwiT0JKRUNUXCIsIHByb3BlcnRpZXM6IHsgcGF1c2U6IHsgdHlwZTogXCJCT09MRUFOXCIgfSB9IH0gfSxcbl07XG5cbmNvbnN0IFBSRVNFVFM6IFJlY29yZDxzdHJpbmcsIFJlY29yZDxzdHJpbmcsIHVua25vd24+PiA9IHtcbiAgd2ViOiB7IHBsYXRmb3JtOiBcIndlYlwiLCBkZXZpY2U6IFwiYnJvd3NlclwiLCBzdGFuZGJ5QWZ0ZXI6IDMwLCBoYW5nVXBBZnRlcjogMzAwLCBoYW5kT2ZmOiBcIm5hbWVkXCIsIHZvY2FidWxhcnk6IFtcIkhlcm1lc1wiLCBcIkJlbnRvXCIsIFwiV29vZGhvdXNlXCIsIFwiVDNcIl0gfSxcbiAgYW5kcm9pZDogeyBwbGF0Zm9ybTogXCJBbmRyb2lkXCIsIGRldmljZTogXCJwaG9uZVwiLCBzdGFuZGJ5QWZ0ZXI6IDIwIH0sXG4gIFwiYW5kcm9pZCB3YWtlIHdvcmRcIjogeyBwbGF0Zm9ybTogXCJBbmRyb2lkXCIsIGRldmljZTogXCJwaG9uZVwiLCBzdGFuZGJ5QWZ0ZXI6IDIwLCBoYW5nVXBBZnRlcjogMTUgfSxcbiAgbWFjb3M6IHsgcGxhdGZvcm06IFwibWFjT1NcIiwgZGV2aWNlOiBcIk1hY1wiLCBzdGFuZGJ5QWZ0ZXI6IDIwIH0sXG4gIGVjaG86IHtcbiAgICBwbGF0Zm9ybTogXCJFY2hvXCIsIGRldmljZTogXCJzcGVha2VyXCIsIGhhbmdVcEFmdGVyOiA2LCBzdGFuZGJ5QWZ0ZXI6IDgsIGVhcmNvbnM6IHRydWUsIHZvY2FidWxhcnk6IFtcIkhlcm1lc1wiLCBcIkJlbnRvXCIsIFwiV29vZGhvdXNlXCJdLFxuICAgIG1pYzogeyB3aGlsZVNwZWFraW5nOiBcIndha2VcIiwgZ2FpbkRiOiAwIH0sIGhvc3RUb29sczogRkFLRV9UVixcbiAgfSxcbn07XG5cbi8vIFN0YXRlLlxuXG5jb25zdCBhdWRpbyA9IG5ldyBDYWxsQXVkaW8oKTtcbmxldCBzZXJ2ZXI6IFNlcnZlckNvbmZpZztcbmxldCBjb3JlOiBDb3JlIHwgbnVsbCA9IG51bGw7XG5sZXQgY2FsbElkID0gMDtcbmxldCBjYWxsTmFtZSA9IFwiXCI7XG5sZXQgdGlja2VyID0gMDtcbmxldCB0cmFjZVRpbWVyID0gMDtcbmxldCBzdGFydGVkQXQgPSBub3coKTtcbmNvbnN0IHNvY2tldHMgPSBuZXcgTWFwPG51bWJlciwgV2ViU29ja2V0PigpO1xuLyoqIFRoZSBzb2NrZXRzIHRvIHRoZSB0cmFuc2NyaXB0aW9uIG1vZGVsOiB0aGVpciBhdWRpbyBpcyB0aGUgbW9kZWwncyBhZ2Fpbiwgc28gaXQgaXNuJ3QgY291bnRlZCBvciBsb2dnZWQgdHdpY2UuICovXG5jb25zdCBjYXB0aW9uU29ja2V0cyA9IG5ldyBTZXQ8bnVtYmVyPigpO1xuY29uc3QgcnVucyA9IG5ldyBNYXA8c3RyaW5nLCB7IGFib3J0OiBBYm9ydENvbnRyb2xsZXI7IGFnZW50OiBzdHJpbmc7IHRhc2tJZDogc3RyaW5nIH0+KCk7XG5pbnRlcmZhY2UgVGFza1ZpZXcgeyBjOiBDb21tYW5kOyBzaW5jZTogbnVtYmVyOyBlbmRlZDogbnVtYmVyIHwgbnVsbDsgdGhyZWFkPzogc3RyaW5nOyByZXN1bHQ/OiBIVE1MRWxlbWVudDsgYXBwcm92YWw/OiB7IGNvbW1hbmQ6IHN0cmluZyB9IH1cbmNvbnN0IHRhc2tzID0gbmV3IE1hcDxzdHJpbmcsIFRhc2tWaWV3PigpO1xubGV0IGNvdW50cyA9IHsgbWljOiAwLCBwbGF5OiAwLCBzZW50OiAwIH07XG5sZXQgZmFrZVR2TGV2ZWwgPSAxNTtcbmxldCBjb3JlU3RhdHVzID0gXCJpZGxlXCI7XG5sZXQgbXV0ZWQgPSBmYWxzZTtcbmxldCBob2xkaW5nID0gZmFsc2U7XG5sZXQgd2FrZUxvY2s6IHsgcmVsZWFzZSgpOiBQcm9taXNlPHZvaWQ+IH0gfCBudWxsID0gbnVsbDtcbi8qKiBXaGF0IHRoZSBzZXNzaW9uIG9uIHNjcmVlbiBpczogYSB2b2ljZSBjYWxsLCBvciBhIHR5cGVkIGNoYXQgKHRoZSBjb3JlJ3MgbWVkaXVtIFwidGV4dFwiKS4gKi9cbmxldCBtZWRpdW06IFwidm9pY2VcIiB8IFwidGV4dFwiID0gXCJ2b2ljZVwiO1xuLyoqIEEgY2hhdCdzIG1vZGVsIGlzIHdyaXRpbmcgaXRzIGFuc3dlci4gKi9cbmxldCB0aGlua2luZyA9IGZhbHNlO1xuLyoqIEEgY2hhdCdzIHJlcXVlc3RzIHRvIHRoZSB0ZXh0IG1vZGVsIHRoYXQgYXJlIHVuZGVyIHdheS4gKi9cbmNvbnN0IHJlcXVlc3RzID0gbmV3IE1hcDxudW1iZXIsIEFib3J0Q29udHJvbGxlcj4oKTtcbi8qKiBUaGUgbGFzdCBzZXNzaW9uIHdpbmRpbmcgZG93biAoaXRzIHRyYWNlIHNhdmVkLCB0aGUgY29yZSdzIGNhbGwgZGlzcG9zZWQpOiB0aGUgbmV4dCBzdGFydHMgYWZ0ZXIgaXQuICovXG5sZXQgZW5kaW5nOiBQcm9taXNlPHZvaWQ+ID0gUHJvbWlzZS5yZXNvbHZlKCk7XG5cbi8vIFRoZSBjb252ZXJzYXRpb24sIGtlcHQgc28gYSBuZXcgY2FsbCBjYW4gY2Fycnkgb24gZnJvbSBpdCAodGhlIGNvcmUncyBgaGlzdG9yeWAsIHJlY2FwcGVkIHRvIHRoZSBtb2RlbCkuXG5pbnRlcmZhY2UgQ2hhdExpbmUgeyByb2xlOiBcInVzZXJcIiB8IFwiYXNzaXN0YW50XCI7IHNwZWFrZXI/OiBzdHJpbmc7IHRleHQ6IHN0cmluZyB9XG5jb25zdCBISVNUT1JZID0gXCJ2b2ljZS5oaXN0b3J5XCI7XG5jb25zdCBISVNUT1JZX01BWF9BR0UgPSAxMiAqIDM2MDAgKiAxMDAwO1xubGV0IGNoYXQ6IENoYXRMaW5lW10gPSBbXTtcbi8qKiBUaGUgY29yZSdzIG51bWJlciBmb3IgdGhlIGxpbmUgdGhlIGxhc3Qgd29yZHMgd2VyZSByZW1lbWJlcmVkIG9uLCB1bnRpbCBzb21ldGhpbmcgZWxzZSBpcy4gKi9cbmxldCBsYXN0TGluZTogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5cbmZ1bmN0aW9uIHJlbWVtYmVyKHJvbGU6IFwidXNlclwiIHwgXCJhc3Npc3RhbnRcIiwgdGV4dDogc3RyaW5nLCBzcGVha2VyPzogc3RyaW5nLCBqb2luID0gZmFsc2UpIHtcbiAgY29uc3QgbGFzdCA9IGNoYXQuYXQoLTEpO1xuICBpZiAoam9pbiAmJiBsYXN0ICYmIGxhc3Qucm9sZSA9PT0gcm9sZSAmJiBsYXN0LnNwZWFrZXIgPT09IHNwZWFrZXIpIGxhc3QudGV4dCArPSB0ZXh0O1xuICBlbHNlIGNoYXQucHVzaChzcGVha2VyID8geyByb2xlLCBzcGVha2VyLCB0ZXh0IH0gOiB7IHJvbGUsIHRleHQgfSk7XG4gIGlmIChjaGF0Lmxlbmd0aCA+IDIwMCkgY2hhdC5zcGxpY2UoMCwgY2hhdC5sZW5ndGggLSAyMDApO1xuICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShISVNUT1JZLCBKU09OLnN0cmluZ2lmeSh7IGF0OiBEYXRlLm5vdygpLCBjaGF0IH0pKTtcbn1cblxuZnVuY3Rpb24gc2F2ZWRIaXN0b3J5KCk6IENoYXRMaW5lW10ge1xuICB0cnkge1xuICAgIGNvbnN0IHNhdmVkID0gSlNPTi5wYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShISVNUT1JZKSA/PyBcIm51bGxcIik7XG4gICAgcmV0dXJuIHNhdmVkICYmIERhdGUubm93KCkgLSBzYXZlZC5hdCA8IEhJU1RPUllfTUFYX0FHRSAmJiBBcnJheS5pc0FycmF5KHNhdmVkLmNoYXQpID8gc2F2ZWQuY2hhdCA6IFtdO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gW107XG4gIH1cbn1cblxuLyoqIFR3byByaXNpbmcgbm90ZXM6IHNvbWV0aGluZyBvbiB0aGUgc2NyZWVuIG5lZWRzIHRoZSB1c2VyLiBQQ00xNiBhdCAyNCBrSHosIGJhc2U2NC4gKi9cbmNvbnN0IEFQUFJPVkFMX1RPTkUgPSAoKCkgPT4ge1xuICBjb25zdCByYXRlID0gMjQwMDAsIG91dCA9IG5ldyBJbnQxNkFycmF5KHJhdGUgKiAwLjMyKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCB0ID0gaSAvIHJhdGUsIGYgPSB0IDwgMC4xNiA/IDY2MCA6IDg4MCwgbG9jYWwgPSB0IDwgMC4xNiA/IHQgOiB0IC0gMC4xNjtcbiAgICBvdXRbaV0gPSBNYXRoLnJvdW5kKE1hdGguc2luKDIgKiBNYXRoLlBJICogZiAqIHQpICogTWF0aC5taW4oMSwgbG9jYWwgKiA2MCwgKDAuMTYgLSBsb2NhbCkgKiA2MCkgKiA2MDAwKTtcbiAgfVxuICBsZXQgYmluID0gXCJcIjtcbiAgY29uc3QgYnl0ZXMgPSBuZXcgVWludDhBcnJheShvdXQuYnVmZmVyKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBieXRlcy5sZW5ndGg7IGkrKykgYmluICs9IFN0cmluZy5mcm9tQ2hhckNvZGUoYnl0ZXNbaV0pO1xuICByZXR1cm4gYnRvYShiaW4pO1xufSkoKTtcblxuLy8gTGF0ZW5jeTogdGhlIG5ldHdvcmsncyByb3VuZCB0cmlwLCBhbmQgaG93IGxvbmcgYWZ0ZXIgdGhlIHVzZXIgc3RvcHMgdGFsa2luZyB0aGUgcmVwbHkgc3RhcnRzLlxuY29uc3QgbWV0cmljcyA9IHsgcnR0OiBbXSBhcyBudW1iZXJbXSwgcmVwbHk6IFtdIGFzIG51bWJlcltdLCBsYXN0Vm9pY2U6IDAsIGxhc3RQbGF5OiAwLCByZXBsaWVkOiB0cnVlIH07XG5cbmZ1bmN0aW9uIG1lZGlhbih4czogbnVtYmVyW10pOiBudW1iZXIgfCBudWxsIHtcbiAgaWYgKHhzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHMgPSBbLi4ueHNdLnNvcnQoKGEsIGIpID0+IGEgLSBiKTtcbiAgcmV0dXJuIHNbTWF0aC5mbG9vcihzLmxlbmd0aCAvIDIpXTtcbn1cblxuZnVuY3Rpb24gc2hvd01ldHJpY3MoKSB7XG4gIGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBydHQgPSBtZWRpYW4obWV0cmljcy5ydHQpO1xuICBpZiAocnR0ICE9IG51bGwpIHBhcnRzLnB1c2goYG5ldHdvcmsgJHtNYXRoLnJvdW5kKHJ0dCAqIDEwMDApfSBtc2ApO1xuICBjb25zdCByZXBseSA9IG1lZGlhbihtZXRyaWNzLnJlcGx5KTtcbiAgaWYgKHJlcGx5ICE9IG51bGwpIHBhcnRzLnB1c2goYHJlcGx5ICR7bWV0cmljcy5yZXBseS5hdCgtMSkhLnRvRml4ZWQoMSl9IHMgKG1lZGlhbiAke3JlcGx5LnRvRml4ZWQoMSl9KWApO1xuICBjb25zdCBvdXQgPSBhdWRpby5vdXRwdXRMYXRlbmN5O1xuICBpZiAob3V0ICE9IG51bGwpIHBhcnRzLnB1c2goYGF1ZGlvICR7TWF0aC5yb3VuZChvdXQgKiAxMDAwKX0gbXNgKTtcbiAgbGV0IGJ1ZmZlcmVkID0gMDtcbiAgZm9yIChjb25zdCB3cyBvZiBzb2NrZXRzLnZhbHVlcygpKSBidWZmZXJlZCArPSB3cy5idWZmZXJlZEFtb3VudDtcbiAgaWYgKGJ1ZmZlcmVkID4gMzJfMDAwKSBwYXJ0cy5wdXNoKGB1cGxvYWQgYmVoaW5kICR7KGJ1ZmZlcmVkIC8gMzJfMDAwKS50b0ZpeGVkKDEpfSBzYCk7XG4gICQoXCJtZXRyaWNzXCIpLnRleHRDb250ZW50ID0gcGFydHMuam9pbihcIiBcdTAwQjcgXCIpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBwaW5nKCkge1xuICBjb25zdCB0ID0gbm93KCk7XG4gIHRyeSB7XG4gICAgYXdhaXQgZmV0Y2goXCIvcGluZ1wiLCB7IGNhY2hlOiBcIm5vLXN0b3JlXCIgfSk7XG4gICAgbWV0cmljcy5ydHQucHVzaChub3coKSAtIHQpO1xuICAgIGlmIChtZXRyaWNzLnJ0dC5sZW5ndGggPiAxMikgbWV0cmljcy5ydHQuc2hpZnQoKTtcbiAgfSBjYXRjaCB7fVxuICBzaG93TWV0cmljcygpO1xufVxuXG4vLyBUaGUgc2NyZWVuLlxuXG4vKiogQSBzeXN0ZW0gbm90aWZpY2F0aW9uIHdoaWxlIHRoZSBwYWdlIGlzIGhpZGRlbjogYSB0YXNrIGZpbmlzaGVkLCBvciBvbmUgbmVlZHMgdGhlIHVzZXIuICovXG5mdW5jdGlvbiBub3RpZnkodGl0bGU6IHN0cmluZywgYm9keTogc3RyaW5nKSB7XG4gIGlmICghZG9jdW1lbnQuaGlkZGVuIHx8ICEoXCJOb3RpZmljYXRpb25cIiBpbiB3aW5kb3cpIHx8IE5vdGlmaWNhdGlvbi5wZXJtaXNzaW9uICE9PSBcImdyYW50ZWRcIikgcmV0dXJuO1xuICB0cnkge1xuICAgIGNvbnN0IG4gPSBuZXcgTm90aWZpY2F0aW9uKHRpdGxlLCB7IGJvZHk6IGJvZHkuc2xpY2UoMCwgMTgwKSwgaWNvbjogXCIvd2ViL2ljb25zL2ljb24tMTkyLnBuZ1wiLCB0YWc6IHRpdGxlIH0pO1xuICAgIG4ub25jbGljayA9ICgpID0+IHsgd2luZG93LmZvY3VzKCk7IG4uY2xvc2UoKTsgfTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gUGhvbmVzIHdhbnQgbm90aWZpY2F0aW9ucyBmcm9tIGEgc2VydmljZSB3b3JrZXI7IHRoZSBwYWdlIGhhcyBub25lLlxuICB9XG59XG5cbmZ1bmN0aW9uIHRvYXN0KHRleHQ6IHN0cmluZykge1xuICBjb25zdCB0ID0gJChcInRvYXN0XCIpO1xuICB0LnRleHRDb250ZW50ID0gdGV4dDtcbiAgdC5jbGFzc0xpc3QuYWRkKFwib25cIik7XG4gIGNsZWFyVGltZW91dCgodG9hc3QgYXMgYW55KS50aW1lcik7XG4gICh0b2FzdCBhcyBhbnkpLnRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB0LmNsYXNzTGlzdC5yZW1vdmUoXCJvblwiKSwgMTgwMCk7XG59XG5cbmZ1bmN0aW9uIGxvZyhraW5kOiBzdHJpbmcsIHRleHQ6IHN0cmluZywgY2xzID0gXCJcIikge1xuICBjb25zdCBwYW5lID0gJChcImxvZ1wiKTtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IGByb3cgJHtjbHN9YDtcbiAgcm93LmlubmVySFRNTCA9IGA8c3BhbiBjbGFzcz1cInRcIj4keyhub3coKSAtIHN0YXJ0ZWRBdCkudG9GaXhlZCgyKX08L3NwYW4+PHNwYW4gY2xhc3M9XCJrXCI+JHtraW5kfTwvc3Bhbj5gO1xuICBjb25zdCBib2R5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGJvZHkuY2xhc3NOYW1lID0gXCJiXCI7XG4gIGJvZHkudGV4dENvbnRlbnQgPSB0ZXh0O1xuICByb3cuYXBwZW5kKGJvZHkpO1xuICBjb25zdCBzdGljayA9IHBhbmUuc2Nyb2xsVG9wICsgcGFuZS5jbGllbnRIZWlnaHQgPj0gcGFuZS5zY3JvbGxIZWlnaHQgLSAzMDtcbiAgcGFuZS5hcHBlbmQocm93KTtcbiAgd2hpbGUgKHBhbmUuY2hpbGRFbGVtZW50Q291bnQgPiAzMDAwKSBwYW5lLmZpcnN0RWxlbWVudENoaWxkIS5yZW1vdmUoKTtcbiAgaWYgKHN0aWNrKSBwYW5lLnNjcm9sbFRvcCA9IHBhbmUuc2Nyb2xsSGVpZ2h0O1xufVxuXG4vKiogQSBmcmFtZSBmcm9tIG9yIHRvIEdlbWluaSwgd2l0aCBhdWRpbyBjdXQgb3V0LCBzaG9ydCBlbm91Z2ggdG8gcmVhZC4gKi9cbmZ1bmN0aW9uIGJyaWVmKGRhdGE6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBkYXRhLnJlcGxhY2UoL1wiZGF0YVwiOlwiW0EtWmEtejAtOSsvPV17NDAsfVwiL2csIChtKSA9PiBgXCJkYXRhXCI6XCJcdTIwMjYke01hdGgucm91bmQoKChtLmxlbmd0aCAtIDkpICogMykgLyA0KX0gYnl0ZXNcImApLnNsaWNlKDAsIDYwMCk7XG59XG5cbmZ1bmN0aW9uIGVzY2FwZUh0bWwodGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHRleHQucmVwbGFjZSgvWyY8PlwiJ10vZywgKGMpID0+ICh7IFwiJlwiOiBcIiZhbXA7XCIsIFwiPFwiOiBcIiZsdDtcIiwgXCI+XCI6IFwiJmd0O1wiLCAnXCInOiBcIiZxdW90O1wiLCBcIidcIjogXCImIzM5O1wiIH0pW2NdISk7XG59XG5cbi8qKiBBIGxpdHRsZSBNYXJrZG93biwgc2FmZWx5OiBjb2RlLCBib2xkLCBsaW5rcywgbGlzdHMgYW5kIGhlYWRpbmdzLCB0aGUgcmVzdCBhcyB0ZXh0LiAqL1xuZnVuY3Rpb24gbWFya2Rvd24odGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgYmxvY2tzID0gZXNjYXBlSHRtbCh0ZXh0LnRyaW0oKSkuc3BsaXQoL2BgYCg/OlxcdyspP1xcbj8vKTtcbiAgcmV0dXJuIGJsb2Nrcy5tYXAoKGJsb2NrLCBpKSA9PiB7XG4gICAgaWYgKGkgJSAyID09PSAxKSByZXR1cm4gYDxwcmU+JHtibG9ja308L3ByZT5gO1xuICAgIGNvbnN0IGlubGluZSA9IChzOiBzdHJpbmcpID0+IHNcbiAgICAgIC5yZXBsYWNlKC9gKFteYFxcbl0rKWAvZywgXCI8Y29kZT4kMTwvY29kZT5cIilcbiAgICAgIC5yZXBsYWNlKC9cXCpcXCooW14qXFxuXSspXFwqXFwqL2csIFwiPGI+JDE8L2I+XCIpXG4gICAgICAucmVwbGFjZSgvXFxbKFteXFxdXFxuXSspXFxdXFwoKGh0dHBzPzpcXC9cXC9bXlxccyldKylcXCkvZywgJzxhIGhyZWY9XCIkMlwiIHRhcmdldD1cIl9ibGFua1wiIHJlbD1cIm5vb3BlbmVyXCI+JDE8L2E+JylcbiAgICAgIC5yZXBsYWNlKC8oXnxbXFxzKF0pKGh0dHBzPzpcXC9cXC9bXlxcczwpXSspL2csICckMTxhIGhyZWY9XCIkMlwiIHRhcmdldD1cIl9ibGFua1wiIHJlbD1cIm5vb3BlbmVyXCI+JDI8L2E+Jyk7XG4gICAgbGV0IGh0bWwgPSBcIlwiO1xuICAgIGxldCBsaXN0OiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICBmb3IgKGNvbnN0IHJhdyBvZiBibG9jay5zcGxpdChcIlxcblwiKSkge1xuICAgICAgY29uc3QgaXRlbSA9IHJhdy5tYXRjaCgvXlxccyooPzpbLSpcdTIwMjJdfChcXGQrKVsuKV0pXFxzKyguKikkLyk7XG4gICAgICBpZiAoaXRlbSkge1xuICAgICAgICBjb25zdCBraW5kID0gaXRlbVsxXSA/IFwib2xcIiA6IFwidWxcIjtcbiAgICAgICAgaWYgKGxpc3QgIT09IGtpbmQpIHsgaWYgKGxpc3QpIGh0bWwgKz0gYDwvJHtsaXN0fT5gOyBodG1sICs9IGA8JHtraW5kfT5gOyBsaXN0ID0ga2luZDsgfVxuICAgICAgICBodG1sICs9IGA8bGk+JHtpbmxpbmUoaXRlbVsyXSl9PC9saT5gO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGlmIChsaXN0KSB7IGh0bWwgKz0gYDwvJHtsaXN0fT5gOyBsaXN0ID0gbnVsbDsgfVxuICAgICAgY29uc3QgaGVhZGluZyA9IHJhdy5tYXRjaCgvXiN7MSw2fVxccysoLiopJC8pO1xuICAgICAgaHRtbCArPSBoZWFkaW5nID8gYDxiPiR7aW5saW5lKGhlYWRpbmdbMV0pfTwvYj48YnI+YCA6IHJhdy50cmltKCkgPT09IFwiXCIgPyBcIjxicj5cIiA6IGAke2lubGluZShyYXcpfTxicj5gO1xuICAgIH1cbiAgICBpZiAobGlzdCkgaHRtbCArPSBgPC8ke2xpc3R9PmA7XG4gICAgcmV0dXJuIGh0bWw7XG4gIH0pLmpvaW4oXCJcIik7XG59XG5cbmZ1bmN0aW9uIHNjcm9sbERvd24oZm9yY2UgPSBmYWxzZSkge1xuICBjb25zdCBwYW5lID0gJChcInRyYW5zY3JpcHRcIik7XG4gIGlmIChmb3JjZSB8fCBwYW5lLnNjcm9sbFRvcCArIHBhbmUuY2xpZW50SGVpZ2h0ID49IHBhbmUuc2Nyb2xsSGVpZ2h0IC0gODApIHBhbmUuc2Nyb2xsVG9wID0gcGFuZS5zY3JvbGxIZWlnaHQ7XG59XG5cbi8qKiBUaGUgY29yZSdzIG51bWJlciBmb3IgdGhlIGxpbmUgdGhlIGxhc3Qgcm93IHNob3dzLCB1bnRpbCBhbm90aGVyIHJvdyBmb2xsb3dzIGl0LiAqL1xubGV0IG9wZW5MaW5lOiBudW1iZXIgfCBudWxsID0gbnVsbDtcblxuLyoqIFdvcmRzIGdvIG9uIHRoZSByb3cgdGhlIGNvcmUgc2F5cyB0aGV5IGJlbG9uZyB0bzogaXQgc3RhcnRzIGEgbmV3IGxpbmUgZm9yIGVhY2ggdHVybiwgaG93ZXZlciBsb25nIHRoZSBnYXAuICovXG5mdW5jdGlvbiB0cmFuc2NyaXB0KHJvbGU6IFwidXNlclwiIHwgXCJhc3Npc3RhbnRcIiwgdGV4dDogc3RyaW5nLCBsaW5lOiBudW1iZXIpIHtcbiAgJChcImVtcHR5XCIpLmhpZGRlbiA9IHRydWU7XG4gIGNvbnN0IHBhbmUgPSAkKFwidHJhbnNjcmlwdFwiKTtcbiAgY29uc3QgbGFzdCA9IHBhbmUubGFzdEVsZW1lbnRDaGlsZCBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gIGlmIChvcGVuTGluZSA9PT0gbGluZSAmJiBsYXN0ICYmIGxhc3QuZGF0YXNldC5yb2xlID09PSByb2xlKSBsYXN0LnF1ZXJ5U2VsZWN0b3IoXCIudGV4dFwiKSEudGV4dENvbnRlbnQgKz0gdGV4dDtcbiAgZWxzZSB7XG4gICAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICByb3cuY2xhc3NOYW1lID0gYGxpbmUgJHtyb2xlfWA7XG4gICAgcm93LmRhdGFzZXQucm9sZSA9IHJvbGU7XG4gICAgcm93LmlubmVySFRNTCA9IGA8c3BhbiBjbGFzcz1cIndob1wiPiR7cm9sZSA9PT0gXCJ1c2VyXCIgPyBcIllvdVwiIDogXCJHZW1pbmlcIn08L3NwYW4+PHNwYW4gY2xhc3M9XCJ0ZXh0XCI+PC9zcGFuPmA7XG4gICAgcm93LnF1ZXJ5U2VsZWN0b3IoXCIudGV4dFwiKSEudGV4dENvbnRlbnQgPSB0ZXh0LnRyaW1TdGFydCgpO1xuICAgIHBhbmUuYXBwZW5kKHJvdyk7XG4gICAgb3BlbkxpbmUgPSBsaW5lO1xuICB9XG4gIHNjcm9sbERvd24ocm9sZSA9PT0gXCJ1c2VyXCIpO1xufVxuXG4vKipcbiAqIFRoZSB3b3JkcyB0aGUgdXNlciBpcyBzYXlpbmcsIGJlZm9yZSB0aGUgbW9kZWwgaGFzIHRyYW5zY3JpYmVkIHRoZW06IGEgZmFpbnQgcm93IHRoYXQgc3RheXMgbGFzdFxuICogb24gc2NyZWVuIChpdHMgQ1NTIGBvcmRlcmApIGFuZCBmaXJzdCBpbiB0aGUgcGFuZSwgc28gdGhlIGxpbmVzIGFmdGVyIGl0IGpvaW4gdXAgYXMgYmVmb3JlLlxuICovXG5mdW5jdGlvbiBjYXB0aW9uKHRleHQ6IHN0cmluZyB8IG51bGwpIHtcbiAgY29uc3QgcGFuZSA9ICQoXCJ0cmFuc2NyaXB0XCIpO1xuICBsZXQgcm93ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJjYXB0aW9uXCIpO1xuICBpZiAodGV4dCA9PSBudWxsKSB7IHJvdz8ucmVtb3ZlKCk7IHJldHVybjsgfVxuICAkKFwiZW1wdHlcIikuaGlkZGVuID0gdHJ1ZTtcbiAgaWYgKCFyb3cpIHtcbiAgICByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIHJvdy5pZCA9IFwiY2FwdGlvblwiO1xuICAgIHJvdy5jbGFzc05hbWUgPSBcImxpbmUgdXNlciBjYXB0aW9uXCI7XG4gICAgcm93LmlubmVySFRNTCA9IGA8c3BhbiBjbGFzcz1cIndob1wiPllvdTwvc3Bhbj48c3BhbiBjbGFzcz1cInRleHRcIj48L3NwYW4+YDtcbiAgICBwYW5lLnByZXBlbmQocm93KTtcbiAgfVxuICByb3cucXVlcnlTZWxlY3RvcihcIi50ZXh0XCIpIS50ZXh0Q29udGVudCA9IHRleHQ7XG4gIHNjcm9sbERvd24odHJ1ZSk7XG59XG5cbmZ1bmN0aW9uIG5vdGUodGV4dDogc3RyaW5nKSB7XG4gICQoXCJlbXB0eVwiKS5oaWRkZW4gPSB0cnVlO1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gXCJsaW5lIG5vdGVcIjtcbiAgcm93LnRleHRDb250ZW50ID0gdGV4dDtcbiAgJChcInRyYW5zY3JpcHRcIikuYXBwZW5kKHJvdyk7XG4gIG9wZW5MaW5lID0gbnVsbDtcbiAgc2Nyb2xsRG93bigpO1xufVxuXG5mdW5jdGlvbiByZXN1bHQoYWdlbnQ6IHN0cmluZywgbGFiZWw6IHN0cmluZywgdGV4dDogc3RyaW5nLCBmYWlsZWQgPSBmYWxzZSk6IEhUTUxFbGVtZW50IHtcbiAgJChcImVtcHR5XCIpLmhpZGRlbiA9IHRydWU7XG4gIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvdy5jbGFzc05hbWUgPSBgbGluZSByZXN1bHQgJHthZ2VudCA9PT0gXCJ0M1wiID8gXCJ0M1wiIDogXCJcIn1gO1xuICByb3cuaW5uZXJIVE1MID0gYDxzcGFuIGNsYXNzPVwid2hvXCI+JHthZ2VudCA9PT0gXCJ0M1wiID8gXCJUM1wiIDogXCJIZXJtZXNcIn0gXHUwMEI3ICR7ZXNjYXBlSHRtbChsYWJlbCl9JHtmYWlsZWQgPyBcIiBcdTAwQjcgZmFpbGVkXCIgOiBcIlwifTwvc3Bhbj48ZGl2IGNsYXNzPVwiYm9keVwiPiR7bWFya2Rvd24odGV4dCl9PC9kaXY+YDtcbiAgJChcInRyYW5zY3JpcHRcIikuYXBwZW5kKHJvdyk7XG4gIG9wZW5MaW5lID0gbnVsbDtcbiAgY29uc3QgYm9keSA9IHJvdy5xdWVyeVNlbGVjdG9yKFwiLmJvZHlcIikgYXMgSFRNTEVsZW1lbnQ7XG4gIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB7XG4gICAgaWYgKGJvZHkuc2Nyb2xsSGVpZ2h0ID4gYm9keS5jbGllbnRIZWlnaHQgKyA0KSB7XG4gICAgICBjb25zdCBtb3JlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgICAgIG1vcmUuY2xhc3NOYW1lID0gXCJtb3JlXCI7XG4gICAgICBtb3JlLnRleHRDb250ZW50ID0gXCJTaG93IGFsbFwiO1xuICAgICAgbW9yZS5vbmNsaWNrID0gKCkgPT4geyByb3cuY2xhc3NMaXN0LnRvZ2dsZShcIm9wZW5cIik7IG1vcmUudGV4dENvbnRlbnQgPSByb3cuY2xhc3NMaXN0LmNvbnRhaW5zKFwib3BlblwiKSA/IFwiU2hvdyBsZXNzXCIgOiBcIlNob3cgYWxsXCI7IH07XG4gICAgICByb3cuYXBwZW5kKG1vcmUpO1xuICAgIH1cbiAgfSk7XG4gIHNjcm9sbERvd24odHJ1ZSk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIGVsYXBzZWQoc2Vjb25kczogbnVtYmVyKTogc3RyaW5nIHtcbiAgaWYgKHNlY29uZHMgPCA2MCkgcmV0dXJuIGAke01hdGguZmxvb3Ioc2Vjb25kcyl9IHNgO1xuICBjb25zdCBtID0gTWF0aC5mbG9vcihzZWNvbmRzIC8gNjApO1xuICByZXR1cm4gbSA8IDYwID8gYCR7bX0gbWluICR7TWF0aC5mbG9vcihzZWNvbmRzICUgNjApfSBzYCA6IGAke01hdGguZmxvb3IobSAvIDYwKX0gaCAke20gJSA2MH0gbWluYDtcbn1cblxuLyoqIFRoZSBlbXB0eSB0YXNrIGxpc3QncyB3b3Jkcywga2VwdCB0byBwdXQgYmFjay4gKi9cbmNvbnN0IG5vVGFza3MgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcIm5vdGFza3NcIikhO1xuXG4vKiogV2hldGhlciBhIHRhc2sgc3RpbGwgd2FudHMgdGhlIHNjcmVlbjogaXQncyB3b3JraW5nLCBvciBpdCB3YWl0cyBmb3IgdGhlIHVzZXIuIFRoZSByZXN0IGZvbGQgYXdheSB1bmRlciBGaW5pc2hlZC4gKi9cbmNvbnN0IGxpdmUgPSAoc3RhdGU6IHN0cmluZykgPT4gc3RhdGUgPT09IFwicnVubmluZ1wiIHx8IHN0YXRlLnN0YXJ0c1dpdGgoXCJ3YWl0aW5nXCIpO1xuXG4vKiogVGhlIEZpbmlzaGVkIGZvbGQncyBjb3VudCwgYW5kIHRoZSBmb2xkIGl0c2VsZiBvbmx5IHdoZW4gc29tZXRoaW5nIGlzIGluIGl0LiAqL1xuZnVuY3Rpb24gc2hvd0RvbmUoKSB7XG4gIGNvbnN0IG4gPSAkKFwiZG9uZW5vd1wiKS5jaGlsZEVsZW1lbnRDb3VudCArICQoXCJkb25lZWFybGllclwiKS5jaGlsZEVsZW1lbnRDb3VudDtcbiAgJChcImRvbmVib3hcIikuaGlkZGVuID0gbiA9PT0gMDtcbiAgJChcImRvbmVjb3VudFwiKS50ZXh0Q29udGVudCA9IG4gPiAwID8gYFx1MDBCNyAke259YCA6IFwiXCI7XG59XG5cbmZ1bmN0aW9uIHNob3dUYXNrcyhmb3JjZSA9IGZhbHNlKSB7XG4gIGNvbnN0IHBhbmUgPSAkKFwidGFza3NcIik7XG4gIGNvbnN0IGRvbmUgPSAkKFwiZG9uZW5vd1wiKTtcbiAgY29uc3Qgb3BlbiA9IGRvY3VtZW50LmFjdGl2ZUVsZW1lbnQ/LmNsb3Nlc3Q/LihcIi50YXNrXCIpIGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgaWYgKCFmb3JjZSAmJiBvcGVuICYmIChwYW5lLmNvbnRhaW5zKG9wZW4pIHx8IGRvbmUuY29udGFpbnMob3BlbikpICYmIG9wZW4ucXVlcnlTZWxlY3RvcihcImZvcm1cIikpIHJldHVybjsgLy8gZG9uJ3QgcmVkcmF3IHVuZGVyIHNvbWVvbmUgdHlwaW5nIGEgZm9sbG93LXVwXG4gIHBhbmUuaW5uZXJIVE1MID0gXCJcIjtcbiAgZG9uZS5pbm5lckhUTUwgPSBcIlwiO1xuICBjb25zdCBhbGwgPSBbLi4udGFza3MudmFsdWVzKCldLnJldmVyc2UoKTtcbiAgaWYgKGFsbC5sZW5ndGggPT09IDApIHsgcGFuZS5hcHBlbmQobm9UYXNrcyk7ICQoXCJ0YXNrY291bnRcIikudGV4dENvbnRlbnQgPSBcIlwiOyBzaG93RG9uZSgpOyByZXR1cm47IH1cbiAgY29uc3QgcnVubmluZyA9IGFsbC5maWx0ZXIoKHQpID0+IHQuYy5zdGF0ZSA9PT0gXCJydW5uaW5nXCIpLmxlbmd0aDtcbiAgJChcInRhc2tjb3VudFwiKS50ZXh0Q29udGVudCA9IHJ1bm5pbmcgPiAwID8gYCR7cnVubmluZ30gcnVubmluZ2AgOiBcIlwiO1xuICAkKFwiY2FuY2VsYWxsXCIpLmhpZGRlbiA9ICFjYWxsSWQgfHwgcnVubmluZyA8IDI7XG4gIGZvciAoY29uc3QgdmlldyBvZiBhbGwpIHtcbiAgICBjb25zdCB0ID0gdmlldy5jO1xuICAgIGNvbnN0IHdhaXRpbmcgPSB0LnN0YXRlLnN0YXJ0c1dpdGgoXCJ3YWl0aW5nXCIpO1xuICAgIGNvbnN0IGNhcmQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGNhcmQuY2xhc3NOYW1lID0gYHRhc2sgJHt3YWl0aW5nID8gXCJ3YWl0aW5nXCIgOiB0LnN0YXRlfWA7XG4gICAgY29uc3QgYWdlID0gKHZpZXcuZW5kZWQgPz8gbm93KCkpIC0gdmlldy5zaW5jZTtcbiAgICBjYXJkLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPVwidG9wXCI+PHNwYW4gY2xhc3M9XCJiYWRnZSAke3QuYWdlbnQgPT09IFwidDNcIiA/IFwidDNcIiA6IFwiXCJ9XCI+JHt0LmFnZW50ID09PSBcInQzXCIgPyBcIlQzXCIgOiBcIkhlcm1lc1wifTwvc3Bhbj5gICtcbiAgICAgIGA8c3BhbiBjbGFzcz1cImxhYmVsXCI+PC9zcGFuPjxzcGFuIGNsYXNzPVwic3RhdGVcIj4ke3Quc3RhdGUgPT09IFwicnVubmluZ1wiID8gJzxzcGFuIGNsYXNzPVwic3BpblwiPjwvc3Bhbj4gJyA6IFwiXCJ9JHtlc2NhcGVIdG1sKHQuc3RhdGUpfSBcdTAwQjcgJHtlbGFwc2VkKGFnZSl9PC9zcGFuPjwvZGl2PmAgK1xuICAgICAgYDxkaXYgY2xhc3M9XCJwXCI+PC9kaXY+YDtcbiAgICBjYXJkLnF1ZXJ5U2VsZWN0b3IoXCIubGFiZWxcIikhLnRleHRDb250ZW50ID0gdC5sYWJlbDtcbiAgICBjYXJkLnF1ZXJ5U2VsZWN0b3IoXCIucFwiKSEudGV4dENvbnRlbnQgPSB0LnByb2dyZXNzID8/IHQucmVxdWVzdDtcbiAgICBpZiAodC5xdWVzdGlvbikge1xuICAgICAgY29uc3QgcSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICBxLmNsYXNzTmFtZSA9IFwicVwiO1xuICAgICAgcS50ZXh0Q29udGVudCA9IGBBc2tzOiAke3QucXVlc3Rpb259YDtcbiAgICAgIGNhcmQuYXBwZW5kKHEpO1xuICAgIH1cbiAgICBpZiAodmlldy5hcHByb3ZhbCAmJiB0LnN0YXRlID09PSBcInJ1bm5pbmdcIikge1xuICAgICAgY29uc3QgYm94ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgIGJveC5jbGFzc05hbWUgPSBcImFwcHJvdmFsXCI7XG4gICAgICBib3guaW5uZXJIVE1MID0gYDxkaXY+SGVybWVzIGFza3MgdG8gcnVuOjwvZGl2Pjxjb2RlPjwvY29kZT48ZGl2IGNsYXNzPVwiYWN0c1wiPjwvZGl2PmA7XG4gICAgICBib3gucXVlcnlTZWxlY3RvcihcImNvZGVcIikhLnRleHRDb250ZW50ID0gdmlldy5hcHByb3ZhbC5jb21tYW5kO1xuICAgICAgY29uc3QgYW5zd2VyID0gKGNob2ljZTogXCJvbmNlXCIgfCBcImRlbnlcIikgPT4ge1xuICAgICAgICB2aWV3LmFwcHJvdmFsID0gdW5kZWZpbmVkO1xuICAgICAgICBzaG93VGFza3ModHJ1ZSk7XG4gICAgICAgIHZvaWQgZmV0Y2goXCIvaGVybWVzL2FwcHJvdmFsXCIsIHsgbWV0aG9kOiBcIlBPU1RcIiwgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBjYWxsOiBjYWxsTmFtZSwgdGFza0lkOiB0LmlkLCBjaG9pY2UgfSkgfSlcbiAgICAgICAgICAudGhlbigocikgPT4gdG9hc3Qoci5vayA/IChjaG9pY2UgPT09IFwib25jZVwiID8gXCJBcHByb3ZlZFwiIDogXCJEZW5pZWRcIikgOiBcIlRoYXQgYXBwcm92YWwgaGFkIGFscmVhZHkgbGFwc2VkXCIpKTtcbiAgICAgIH07XG4gICAgICBmb3IgKGNvbnN0IFtsYWJlbCwgY2hvaWNlXSBvZiBbW1wiQXBwcm92ZSBvbmNlXCIsIFwib25jZVwiXSwgW1wiRGVueVwiLCBcImRlbnlcIl1dIGFzIGNvbnN0KSB7XG4gICAgICAgIGNvbnN0IGIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICAgICAgICBiLnRleHRDb250ZW50ID0gbGFiZWw7XG4gICAgICAgIGlmIChjaG9pY2UgPT09IFwib25jZVwiKSBiLmNsYXNzTmFtZSA9IFwiZ29cIjtcbiAgICAgICAgYi5vbmNsaWNrID0gKCkgPT4gYW5zd2VyKGNob2ljZSk7XG4gICAgICAgIGJveC5xdWVyeVNlbGVjdG9yKFwiLmFjdHNcIikhLmFwcGVuZChiKTtcbiAgICAgIH1cbiAgICAgIGNhcmQuYXBwZW5kKGJveCk7XG4gICAgfVxuICAgIGlmICh0LnN0YXRlICE9PSBcInJ1bm5pbmdcIikgdmlldy5hcHByb3ZhbCA9IHVuZGVmaW5lZDtcbiAgICBjb25zdCBhY3RzID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBhY3RzLmNsYXNzTmFtZSA9IFwiYWN0c1wiO1xuICAgIGNvbnN0IGJ1dHRvbiA9ICh0ZXh0OiBzdHJpbmcsIGZuOiAoKSA9PiB2b2lkKSA9PiB7IGNvbnN0IGIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpOyBiLnRleHRDb250ZW50ID0gdGV4dDsgYi5vbmNsaWNrID0gZm47IGFjdHMuYXBwZW5kKGIpOyByZXR1cm4gYjsgfTtcbiAgICBpZiAoY2FsbElkKSB7XG4gICAgICBidXR0b24od2FpdGluZyA/IFwiQW5zd2VyXCIgOiBcIkZvbGxvdyB1cFwiLCAoKSA9PiBmb2xsb3dVcEZvcm0oY2FyZCwgdCkpO1xuICAgICAgaWYgKHQuc3RhdGUgPT09IFwicnVubmluZ1wiKSBidXR0b24oXCJDYW5jZWxcIiwgKCkgPT4gcHVzaCh7IHR5cGU6IFwiY2FuY2VsVGFza1wiLCB0YXNrOiB0LmlkIH0pKTtcbiAgICB9XG4gICAgaWYgKHZpZXcucmVzdWx0KSBidXR0b24oXCJSZXN1bHRcIiwgKCkgPT4geyB2aWV3LnJlc3VsdCEuc2Nyb2xsSW50b1ZpZXcoeyBiZWhhdmlvcjogXCJzbW9vdGhcIiwgYmxvY2s6IFwiY2VudGVyXCIgfSk7IHZpZXcucmVzdWx0IS5jbGFzc0xpc3QuYWRkKFwib3BlblwiKTsgfSk7XG4gICAgaWYgKHZpZXcudGhyZWFkKSBidXR0b24oXCJDb3B5IHRocmVhZCBpZFwiLCAoKSA9PiB7IHZvaWQgbmF2aWdhdG9yLmNsaXBib2FyZD8ud3JpdGVUZXh0KHZpZXcudGhyZWFkISk7IHRvYXN0KFwiVGhyZWFkIGlkIGNvcGllZFwiKTsgfSk7XG4gICAgaWYgKGFjdHMuY2hpbGRFbGVtZW50Q291bnQpIGNhcmQuYXBwZW5kKGFjdHMpO1xuICAgIChsaXZlKHQuc3RhdGUpID8gcGFuZSA6IGRvbmUpLmFwcGVuZChjYXJkKTtcbiAgfVxuICBzaG93RG9uZSgpO1xufVxuXG5mdW5jdGlvbiBmb2xsb3dVcEZvcm0oY2FyZDogSFRNTEVsZW1lbnQsIHQ6IENvbW1hbmQpIHtcbiAgaWYgKGNhcmQucXVlcnlTZWxlY3RvcihcImZvcm1cIikpIHJldHVybjtcbiAgY29uc3QgZm9ybSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJmb3JtXCIpO1xuICBmb3JtLmlubmVySFRNTCA9IGA8aW5wdXQgdHlwZT1cInRleHRcIiBwbGFjZWhvbGRlcj1cIlRlbGwgXHUyMDFDJHtlc2NhcGVIdG1sKHQubGFiZWwpfVx1MjAxRFx1MjAyNlwiIGVudGVya2V5aGludD1cInNlbmRcIj48YnV0dG9uPlNlbmQ8L2J1dHRvbj5gO1xuICBjb25zdCBpbnB1dCA9IGZvcm0ucXVlcnlTZWxlY3RvcihcImlucHV0XCIpITtcbiAgZm9ybS5vbnN1Ym1pdCA9IChlKSA9PiB7XG4gICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGNvbnN0IHRleHQgPSBpbnB1dC52YWx1ZS50cmltKCk7XG4gICAgaWYgKHRleHQpIHsgcHVzaCh7IHR5cGU6IFwic3RlZXJcIiwgdGFzazogdC5pZCwgdGV4dCB9KTsgbm90ZShgWW91IFx1MjE5MiAke3QubGFiZWx9OiAke3RleHR9YCk7IH1cbiAgICBpbnB1dC5ibHVyKCk7XG4gICAgZm9ybS5yZW1vdmUoKTtcbiAgICBzaG93VGFza3MoKTtcbiAgfTtcbiAgaW5wdXQub25rZXlkb3duID0gKGUpID0+IHsgaWYgKGUua2V5ID09PSBcIkVzY2FwZVwiKSB7IGlucHV0LmJsdXIoKTsgZm9ybS5yZW1vdmUoKTsgc2hvd1Rhc2tzKCk7IH0gfTtcbiAgY2FyZC5hcHBlbmQoZm9ybSk7XG4gIGlucHV0LmZvY3VzKCk7XG59XG5cbi8qKiBUMyB0aHJlYWRzIGVhcmxpZXIgY2FsbHMgc3RhcnRlZDogdGhleSBjYXJyeSBvbiBhZnRlciBhIGNhbGwsIHNvIHRoZSBwYW5lbCBzYXlzIGhvdyB0aGV5J3JlIGRvaW5nLiAqL1xuYXN5bmMgZnVuY3Rpb24gc2hvd0VhcmxpZXIoKSB7XG4gIGxldCBsaXN0OiB7IHRocmVhZDogc3RyaW5nOyB0aXRsZTogc3RyaW5nOyBzdGF0dXM6IHN0cmluZzsgYnJhbmNoOiBzdHJpbmcgfCBudWxsOyBwcjogc3RyaW5nIHwgbnVsbDsgdXBkYXRlZDogc3RyaW5nOyBsYXN0OiBzdHJpbmc7IHdhaXRpbmc6IGJvb2xlYW4gfVtdID0gW107XG4gIHRyeSB7IGxpc3QgPSBhd2FpdCAoYXdhaXQgZmV0Y2goXCIvYWdlbnQvcmVjZW50XCIsIHsgY2FjaGU6IFwibm8tc3RvcmVcIiB9KSkuanNvbigpOyB9IGNhdGNoIHt9XG4gIGNvbnN0IGN1cnJlbnQgPSBuZXcgU2V0KFsuLi50YXNrcy52YWx1ZXMoKV0ubWFwKCh2KSA9PiB2LnRocmVhZCkuZmlsdGVyKEJvb2xlYW4pKTtcbiAgbGlzdCA9IGxpc3QuZmlsdGVyKCh0KSA9PiAhY3VycmVudC5oYXModC50aHJlYWQpKTtcbiAgY29uc3QgcGFuZSA9ICQoXCJlYXJsaWVyXCIpO1xuICBjb25zdCBkb25lID0gJChcImRvbmVlYXJsaWVyXCIpO1xuICBwYW5lLmlubmVySFRNTCA9IFwiXCI7XG4gIGRvbmUuaW5uZXJIVE1MID0gXCJcIjtcbiAgZm9yIChjb25zdCB0IG9mIGxpc3QpIHtcbiAgICBjb25zdCBjYXJkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBjb25zdCBzdGF0ZSA9IHQud2FpdGluZyA/IFwid2FpdGluZyBmb3IgYXBwcm92YWwgaW4gVDNcIiA6IHQuc3RhdHVzO1xuICAgIGNhcmQuY2xhc3NOYW1lID0gYHRhc2sgJHt0LnN0YXR1cyA9PT0gXCJydW5uaW5nXCIgPyBcInJ1bm5pbmdcIiA6IHQud2FpdGluZyA/IFwid2FpdGluZ1wiIDogXCJmaW5pc2hlZFwifWA7XG4gICAgY29uc3QgYWdvID0gTWF0aC5tYXgoMCwgKERhdGUubm93KCkgLSBEYXRlLnBhcnNlKHQudXBkYXRlZCkpIC8gMTAwMCk7XG4gICAgY2FyZC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz1cInRvcFwiPjxzcGFuIGNsYXNzPVwiYmFkZ2UgdDNcIj5UMzwvc3Bhbj48c3BhbiBjbGFzcz1cImxhYmVsXCI+PC9zcGFuPmAgK1xuICAgICAgYDxzcGFuIGNsYXNzPVwic3RhdGVcIj4ke3Quc3RhdHVzID09PSBcInJ1bm5pbmdcIiA/ICc8c3BhbiBjbGFzcz1cInNwaW5cIj48L3NwYW4+ICcgOiBcIlwifSR7ZXNjYXBlSHRtbChzdGF0ZSl9IFx1MDBCNyAke2VsYXBzZWQoYWdvKX0gYWdvPC9zcGFuPjwvZGl2PjxkaXYgY2xhc3M9XCJwXCI+PC9kaXY+YDtcbiAgICBjYXJkLnF1ZXJ5U2VsZWN0b3IoXCIubGFiZWxcIikhLnRleHRDb250ZW50ID0gdC50aXRsZTtcbiAgICBjYXJkLnF1ZXJ5U2VsZWN0b3IoXCIucFwiKSEudGV4dENvbnRlbnQgPSB0Lmxhc3QgfHwgKHQuYnJhbmNoID8gYE9uICR7dC5icmFuY2h9YCA6IFwiXCIpO1xuICAgIGNvbnN0IGFjdHMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGFjdHMuY2xhc3NOYW1lID0gXCJhY3RzXCI7XG4gICAgaWYgKHQucHIpIHsgY29uc3QgYSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJhXCIpOyBhLmhyZWYgPSB0LnByOyBhLnRhcmdldCA9IFwiX2JsYW5rXCI7IGEucmVsID0gXCJub29wZW5lclwiOyBhLnRleHRDb250ZW50ID0gXCJQdWxsIHJlcXVlc3RcIjsgYWN0cy5hcHBlbmQoYSk7IH1cbiAgICBjb25zdCBjb3B5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgICBjb3B5LnRleHRDb250ZW50ID0gXCJDb3B5IHRocmVhZCBpZFwiO1xuICAgIGNvcHkub25jbGljayA9ICgpID0+IHsgdm9pZCBuYXZpZ2F0b3IuY2xpcGJvYXJkPy53cml0ZVRleHQodC50aHJlYWQpOyB0b2FzdChcIlRocmVhZCBpZCBjb3BpZWRcIik7IH07XG4gICAgYWN0cy5hcHBlbmQoY29weSk7XG4gICAgY2FyZC5hcHBlbmQoYWN0cyk7XG4gICAgKHQuc3RhdHVzID09PSBcInJ1bm5pbmdcIiB8fCB0LndhaXRpbmcgPyBwYW5lIDogZG9uZSkuYXBwZW5kKGNhcmQpO1xuICB9XG4gICQoXCJlYXJsaWVyYm94XCIpLmhpZGRlbiA9IHBhbmUuY2hpbGRFbGVtZW50Q291bnQgPT09IDA7XG4gIHNob3dEb25lKCk7XG59XG5cbmNvbnN0IFNUQVRVU19URVhUOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICBpZGxlOiBcIklkbGVcIiwgY29ubmVjdGluZzogXCJDb25uZWN0aW5nXHUyMDI2XCIsIGxpc3RlbmluZzogXCJMaXN0ZW5pbmdcIiwgd29ya2luZzogXCJMaXN0ZW5pbmcgXHUwMEI3IHRhc2tzIHJ1bm5pbmdcIixcbiAgc3RhbmRieTogXCJQYXVzZWQgd2hpbGUgdGFza3MgcnVuIFx1MDBCNyBzcGVhayB0byByZXN1bWVcIiwgd2FraW5nOiBcIlJlc3VtaW5nXHUyMDI2XCIsIGVuZGVkOiBcIkVuZGVkXCIsXG59O1xuXG5mdW5jdGlvbiBzaG93U3RhdHVzKG1lc3NhZ2U/OiBzdHJpbmcpIHtcbiAgY29uc3QgdHlwZWQgPSBCb29sZWFuKGNhbGxJZCkgJiYgbWVkaXVtID09PSBcInRleHRcIjtcbiAgY29uc3Qgc3BlYWtpbmcgPSBjYWxsSWQgJiYgIXR5cGVkICYmIGNvcmVTdGF0dXMgIT09IFwic3RhbmRieVwiICYmIGF1ZGlvLnF1ZXVlZCA+IDAuMDU7XG4gIGNvbnN0IHNob3duID0gc3BlYWtpbmcgfHwgKHR5cGVkICYmIHRoaW5raW5nKSA/IFwic3BlYWtpbmdcIiA6IGNvcmVTdGF0dXM7XG4gICQoXCJzdGF0dXNcIikuY2xhc3NOYW1lID0gc2hvd247XG4gIGxldCB0ZXh0ID0gc3BlYWtpbmcgPyBcIlNwZWFraW5nXCIgOiBTVEFUVVNfVEVYVFtjb3JlU3RhdHVzXSA/PyBjb3JlU3RhdHVzO1xuICBpZiAodHlwZWQgJiYgY29yZVN0YXR1cyAhPT0gXCJlbmRlZFwiKSB0ZXh0ID0gdGhpbmtpbmcgPyBcIldyaXRpbmdcdTIwMjZcIiA6IGNvcmVTdGF0dXMgPT09IFwid29ya2luZ1wiID8gXCJDaGF0IFx1MDBCNyB0YXNrcyBydW5uaW5nXCIgOiBcIkNoYXRcIjtcbiAgaWYgKGNhbGxJZCAmJiAhdHlwZWQgJiYgbXV0ZWQgJiYgIWhvbGRpbmcgJiYgIXNwZWFraW5nKSB0ZXh0ICs9IFwiIFx1MDBCNyBtdXRlZFwiO1xuICBpZiAoaG9sZGluZykgdGV4dCA9IFwiVGFsa2luZyAoaG9sZClcIjtcbiAgaWYgKG1lc3NhZ2UpIHRleHQgPSBgJHt0ZXh0fTogJHttZXNzYWdlfWA7XG4gIGlmIChjb3JlU3RhdHVzICE9PSBcImVuZGVkXCIgfHwgbWVzc2FnZSkgJChcInN0YXR1c3RleHRcIikudGV4dENvbnRlbnQgPSB0ZXh0O1xuICAkPEhUTUxCdXR0b25FbGVtZW50PihcImh1c2hcIikuY2xhc3NMaXN0LnRvZ2dsZShcImxpdmVcIiwgQm9vbGVhbihzcGVha2luZykgfHwgKHR5cGVkICYmIHRoaW5raW5nKSk7XG59XG5cbi8vIFRoZSBjYWxsLlxuXG5mdW5jdGlvbiBwdXNoKGV2ZW50OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikge1xuICBpZiAoIWNvcmUgfHwgIWNhbGxJZCkgcmV0dXJuO1xuICBjb25zdCBlOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgLi4uZXZlbnQsIHQ6IG5vdygpIH07XG4gIGNvbnN0IHF1aWV0ID0gZS50eXBlID09PSBcIm1pY1wiIHx8IGUudHlwZSA9PT0gXCJ0aWNrXCI7XG4gIGlmICghcXVpZXQpIGxvZyhcImluXCIsIGUudHlwZSA9PT0gXCJ3cy5tZXNzYWdlXCIgPyBgd3MgJHtlLnNpZH0gXHUyMTkwICR7YnJpZWYoU3RyaW5nKGUuZGF0YSkpfWAgOiBKU09OLnN0cmluZ2lmeShlKS5zbGljZSgwLCA0MDApLCBcImluXCIpO1xuICBydW4oSlNPTi5wYXJzZShjb3JlLnB1c2goY2FsbElkLCBKU09OLnN0cmluZ2lmeShlKSkpKTtcbn1cblxuZnVuY3Rpb24gcnVuKGNvbW1hbmRzOiBDb21tYW5kW10pIHtcbiAgZm9yIChjb25zdCBjIG9mIGNvbW1hbmRzKSB7XG4gICAgc3dpdGNoIChjLnR5cGUpIHtcbiAgICAgIGNhc2UgXCJ3cy5jb25uZWN0XCI6IGNvbm5lY3QoYy5zaWQsIGMucHVycG9zZSA9PT0gXCJjYXB0aW9uc1wiKTsgYnJlYWs7XG4gICAgICBjYXNlIFwid3Muc2VuZFwiOiB7XG4gICAgICAgIHNvY2tldHMuZ2V0KGMuc2lkKT8uc2VuZChjLmRhdGEpO1xuICAgICAgICBpZiAoIWMuZGF0YS5zdGFydHNXaXRoKCd7XCJyZWFsdGltZUlucHV0XCI6e1wiYXVkaW9cIicpKSBsb2coXCJvdXRcIiwgYHdzICR7Yy5zaWR9IFx1MjE5MiAke2JyaWVmKGMuZGF0YSl9YCwgXCJvdXRcIik7XG4gICAgICAgIGVsc2UgaWYgKCFjYXB0aW9uU29ja2V0cy5oYXMoYy5zaWQpKSBjb3VudHMuc2VudCsrO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ3cy5jbG9zZVwiOiBzb2NrZXRzLmdldChjLnNpZCk/LmNsb3NlKCk7IHNvY2tldHMuZGVsZXRlKGMuc2lkKTsgbG9nKFwib3V0XCIsIGB3cyAke2Muc2lkfSBjbG9zZWAsIFwib3V0XCIpOyBicmVhaztcbiAgICAgIGNhc2UgXCJtaWMuc3RhcnRcIjpcbiAgICAgIGNhc2UgXCJtaWMucmVzdGFydFwiOlxuICAgICAgICBsb2coXCJvdXRcIiwgYy50eXBlLCBcIm91dFwiKTtcbiAgICAgICAgdm9pZCBhdWRpby5zdGFydE1pYyhvbk1pYywgbWljT3B0aW9ucygpKS5jYXRjaCgoZXJyKSA9PiB7IGxvZyhcImVycm9yXCIsIGBtaWNyb3Bob25lOiAke2Vyci5tZXNzYWdlfWAsIFwiZXJyXCIpOyB0b2FzdChgTWljcm9waG9uZTogJHtlcnIubWVzc2FnZX1gKTsgfSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcIm1pYy5zdG9wXCI6IGF1ZGlvLnN0b3BNaWMoKTsgYnJlYWs7XG4gICAgICBjYXNlIFwicGxheVwiOiB7XG4gICAgICAgIGNvbnN0IHQgPSBub3coKTtcbiAgICAgICAgLy8gQSByZXBseSBzdGFydGluZzogZnJvbSB0aGUgZW5kIG9mIHRoZSB1c2VyJ3Mgc3BlZWNoIHRvIGl0cyBmaXJzdCBzb3VuZC5cbiAgICAgICAgaWYgKCFtZXRyaWNzLnJlcGxpZWQgJiYgYXVkaW8ucXVldWVkIDwgMC4wNSAmJiB0IC0gbWV0cmljcy5sYXN0UGxheSA+IDAuNiAmJiBtZXRyaWNzLmxhc3RWb2ljZSA+IDAgJiYgdCAtIG1ldHJpY3MubGFzdFZvaWNlIDwgMTApIHtcbiAgICAgICAgICBtZXRyaWNzLnJlcGx5LnB1c2godCAtIG1ldHJpY3MubGFzdFZvaWNlKTtcbiAgICAgICAgICBpZiAobWV0cmljcy5yZXBseS5sZW5ndGggPiAyMCkgbWV0cmljcy5yZXBseS5zaGlmdCgpO1xuICAgICAgICAgIG1ldHJpY3MucmVwbGllZCA9IHRydWU7XG4gICAgICAgICAgc2hvd01ldHJpY3MoKTtcbiAgICAgICAgfVxuICAgICAgICBtZXRyaWNzLmxhc3RQbGF5ID0gdDtcbiAgICAgICAgYXVkaW8ucGxheShjLnBjbSk7XG4gICAgICAgIGNvdW50cy5wbGF5Kys7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcImZsdXNoXCI6IGF1ZGlvLmZsdXNoKCk7IGxvZyhcIm91dFwiLCBcImZsdXNoXCIsIFwib3V0XCIpOyBicmVhaztcbiAgICAgIGNhc2UgXCJjdWVcIjpcbiAgICAgICAgYXVkaW8uY3VlKGMucGNtKTtcbiAgICAgICAgbG9nKFwib3V0XCIsIGBjdWUgJHtjLmVhcmNvbn1gLCBcIm91dFwiKTtcbiAgICAgICAgLy8gQSByZXF1ZXN0IHRoYXQgYmVjYW1lIGEgdGFzayBnZXRzIGEgdG9uZSwgbm90IGEgc3Bva2VuIHJlcGx5OiBub3RoaW5nIHRvIHRpbWUuXG4gICAgICAgIGlmIChjLmVhcmNvbiA9PT0gXCJ0YXNrU3RhcnRlZFwiKSBtZXRyaWNzLnJlcGxpZWQgPSB0cnVlO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJ3YWtld29yZFwiOiBsb2coXCJvdXRcIiwgYHdha2Ugd29yZCAke2Mub24gPyBcImxpc3RlbmluZ1wiIDogXCJvZmZcIn1gLCBcIm91dFwiKTsgYnJlYWs7XG4gICAgICBjYXNlIFwidG9vbC5jYWxsXCI6IHZvaWQgdG9vbChjKTsgYnJlYWs7XG4gICAgICBjYXNlIFwidG9vbC5jYW5jZWxcIjogY2FuY2VsUnVuKGMucnVuLCBjLnJlYXNvbik7IGJyZWFrO1xuICAgICAgY2FzZSBcInRvb2wuc3RlZXJcIjogdm9pZCBzdGVlclJ1bihjKTsgYnJlYWs7XG4gICAgICBjYXNlIFwic3RhdHVzXCI6XG4gICAgICAgIGNvcmVTdGF0dXMgPSBjLnN0YXR1cztcbiAgICAgICAgc2hvd1N0YXR1cyhjLnN0YXR1cyA9PT0gXCJlbmRlZFwiID8gYy5tZXNzYWdlID8/IHVuZGVmaW5lZCA6IHVuZGVmaW5lZCk7XG4gICAgICAgIGxvZyhcInN0YXR1c1wiLCBjLnN0YXR1cyArIChjLm1lc3NhZ2UgPyBgOiAke2MubWVzc2FnZX1gIDogXCJcIiksIFwic3RhdHVzXCIpO1xuICAgICAgICBpZiAoYy5zdGF0dXMgPT09IFwiZW5kZWRcIikgeyBpZiAoYy5tZXNzYWdlKSBub3RlKGMubWVzc2FnZSk7IGVuZCgpOyB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcImxsbS5yZXF1ZXN0XCI6IHZvaWQgZ2VuZXJhdGUoYy5pZCwgYy5ib2R5KTsgYnJlYWs7XG4gICAgICBjYXNlIFwibGxtLmNhbmNlbFwiOiByZXF1ZXN0cy5nZXQoYy5pZCk/LmFib3J0KCk7IHJlcXVlc3RzLmRlbGV0ZShjLmlkKTsgbG9nKFwib3V0XCIsIGByZXF1ZXN0ICR7Yy5pZH0gZHJvcHBlZGAsIFwib3V0XCIpOyBicmVhaztcbiAgICAgIGNhc2UgXCJ0aGlua2luZ1wiOiB0aGlua2luZyA9IGMub247IHNob3dTdGF0dXMoKTsgYnJlYWs7XG4gICAgICBjYXNlIFwiZXJyb3JcIjogbm90ZShjLm1lc3NhZ2UpOyBsb2coXCJlcnJvclwiLCBjLm1lc3NhZ2UsIFwiZXJyXCIpOyBicmVhaztcbiAgICAgIGNhc2UgXCJjYXB0aW9uXCI6IGNhcHRpb24oYy50ZXh0KTsgYnJlYWs7XG4gICAgICBjYXNlIFwidHJhbnNjcmlwdFwiOlxuICAgICAgICB0cmFuc2NyaXB0KGMucm9sZSwgYy50ZXh0LCBjLmxpbmUpO1xuICAgICAgICByZW1lbWJlcihjLnJvbGUsIGMudGV4dCwgYy5yb2xlID09PSBcImFzc2lzdGFudFwiID8gXCJHZW1pbmlcIiA6IHVuZGVmaW5lZCwgbGFzdExpbmUgPT09IGMubGluZSk7XG4gICAgICAgIGxhc3RMaW5lID0gYy5saW5lO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJ0YXNrXCI6IHtcbiAgICAgICAgY29uc3QgdmlldyA9IHRhc2tzLmdldChjLmlkKSA/PyB7IGMsIHNpbmNlOiBub3coKSwgZW5kZWQ6IG51bGwgfTtcbiAgICAgICAgaWYgKGMuc3RhdGUgPT09IFwicnVubmluZ1wiICYmIHZpZXcuYy5zdGF0ZSAhPT0gXCJydW5uaW5nXCIpIHsgdmlldy5zaW5jZSA9IG5vdygpOyB2aWV3LmVuZGVkID0gbnVsbDsgfVxuICAgICAgICBpZiAoYy5zdGF0ZSAhPT0gXCJydW5uaW5nXCIgJiYgdmlldy5lbmRlZCA9PSBudWxsKSB2aWV3LmVuZGVkID0gbm93KCk7XG4gICAgICAgIHZpZXcuYyA9IGM7XG4gICAgICAgIHRhc2tzLnNldChjLmlkLCB2aWV3KTtcbiAgICAgICAgc2hvd1Rhc2tzKCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcInF1ZXN0aW9uc1wiOiBicmVhaztcbiAgICAgIGNhc2UgXCJtaWNTaWxlbnRcIjogJChcIm1pY3dhcm5cIikuaGlkZGVuID0gIWMuc2lsZW50OyBicmVhaztcbiAgICAgIGNhc2UgXCJ2b2ljZUNvbW1hbmRcIjpcbiAgICAgICAgdG9hc3QoYEhlYXJkIFx1MjAxQyR7Yy5oZWFyZH1cdTIwMUQ6ICR7Yy5jb21tYW5kID09PSBcInN0b3BcIiA/IFwic3RvcHBlZFwiIDogYy5jb21tYW5kID09PSBcImNhbmNlbEFsbFwiID8gXCJjYW5jZWxsaW5nIGV2ZXJ5IHRhc2tcIiA6IFwiaGFuZ2luZyB1cFwifWApO1xuICAgICAgICBsb2coXCJvdXRcIiwgYHZvaWNlIGNvbW1hbmQgJHtjLmNvbW1hbmR9OiAke2MuaGVhcmR9YCwgXCJvdXRcIik7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcImxvZ1wiOiBsb2coYy5sZXZlbCwgYy5tZXNzYWdlLCBjLmxldmVsID09PSBcIndhcm5cIiA/IFwid2FyblwiIDogXCJcIik7IGJyZWFrO1xuICAgICAgZGVmYXVsdDogbG9nKFwib3V0XCIsIEpTT04uc3RyaW5naWZ5KGMpLnNsaWNlKDAsIDMwMCksIFwib3V0XCIpO1xuICAgIH1cbiAgfVxufVxuXG5mdW5jdGlvbiBvbk1pYyhwY206IHN0cmluZywgbGV2ZWw6IG51bWJlcikge1xuICBjb3VudHMubWljKys7XG4gIGlmIChsZXZlbCA+IDAuMDMgJiYgIShtdXRlZCAmJiAhaG9sZGluZykpIHtcbiAgICBtZXRyaWNzLmxhc3RWb2ljZSA9IG5vdygpO1xuICAgIGlmIChhdWRpby5xdWV1ZWQgPCAwLjA1KSBtZXRyaWNzLnJlcGxpZWQgPSBmYWxzZTtcbiAgfVxuICBwdXNoKHsgdHlwZTogXCJtaWNcIiwgcGNtIH0pO1xufVxuXG5mdW5jdGlvbiBjb25uZWN0KHNpZDogbnVtYmVyLCBjYXB0aW9uczogYm9vbGVhbikge1xuICBjb25zdCB3cyA9IG5ldyBXZWJTb2NrZXQoYCR7bG9jYXRpb24ucHJvdG9jb2wgPT09IFwiaHR0cHM6XCIgPyBcIndzc1wiIDogXCJ3c1wifTovLyR7bG9jYXRpb24uaG9zdH0vbGl2ZSR7Y2FwdGlvbnMgPyBcIj9mb3I9Y2FwdGlvbnNcIiA6IFwiXCJ9YCk7XG4gIHNvY2tldHMuc2V0KHNpZCwgd3MpO1xuICBpZiAoY2FwdGlvbnMpIGNhcHRpb25Tb2NrZXRzLmFkZChzaWQpO1xuICBsb2coXCJvdXRcIiwgYHdzICR7c2lkfSBjb25uZWN0ICgke3NlcnZlci5yb3V0ZX0ke2NhcHRpb25zID8gXCIsIGNhcHRpb25zXCIgOiBcIlwifSlgLCBcIm91dFwiKTtcbiAgd3Mub25vcGVuID0gKCkgPT4gcHVzaCh7IHR5cGU6IFwid3Mub3BlblwiLCBzaWQgfSk7XG4gIHdzLm9ubWVzc2FnZSA9IChtKSA9PiBwdXNoKHsgdHlwZTogXCJ3cy5tZXNzYWdlXCIsIHNpZCwgZGF0YTogdHlwZW9mIG0uZGF0YSA9PT0gXCJzdHJpbmdcIiA/IG0uZGF0YSA6IFwiXCIgfSk7XG4gIHdzLm9uY2xvc2UgPSAoZSkgPT4ge1xuICAgIGlmIChzb2NrZXRzLmdldChzaWQpICE9PSB3cyAmJiBzb2NrZXRzLmhhcyhzaWQpKSByZXR1cm47XG4gICAgY29uc3QgaHR0cFN0YXR1cyA9IGUuY29kZSA+PSA0MTAwICYmIGUuY29kZSA8IDQ2MDAgPyBlLmNvZGUgLSA0MDAwIDogdW5kZWZpbmVkO1xuICAgIHB1c2goeyB0eXBlOiBcIndzLmNsb3NlZFwiLCBzaWQsIGNvZGU6IGh0dHBTdGF0dXMgPyB1bmRlZmluZWQgOiBlLmNvZGUsIHJlYXNvbjogZS5yZWFzb24sIGh0dHBTdGF0dXMgfSk7XG4gIH07XG59XG5cbi8qKiBBIGNoYXQncyByZXF1ZXN0IHRvIHRoZSB0ZXh0IG1vZGVsLCB0aHJvdWdoIHRoZSBzZXJ2ZXI6IGVhY2ggYGRhdGE6YCBsaW5lIG9mIHRoZSBtb2RlbCdzIHN0cmVhbSBnb2VzIHRvIHRoZSBjb3JlIGFzIGl0IGNvbWVzLiAqL1xuYXN5bmMgZnVuY3Rpb24gZ2VuZXJhdGUoaWQ6IG51bWJlciwgYm9keTogc3RyaW5nKSB7XG4gIGNvbnN0IGFib3J0ID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICByZXF1ZXN0cy5zZXQoaWQsIGFib3J0KTtcbiAgbG9nKFwib3V0XCIsIGByZXF1ZXN0ICR7aWR9IFx1MjE5MiAke3NlcnZlci50ZXh0TW9kZWx9ICgke01hdGgucm91bmQoYm9keS5sZW5ndGggLyAxMDI0KX0gS0IpYCwgXCJvdXRcIik7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChcIi9nZW5lcmF0ZVwiLCB7IG1ldGhvZDogXCJQT1NUXCIsIHNpZ25hbDogYWJvcnQuc2lnbmFsLCBoZWFkZXJzOiB7IFwiY29udGVudC10eXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sIGJvZHkgfSk7XG4gICAgaWYgKCFyZXNwb25zZS5vayB8fCAhcmVzcG9uc2UuYm9keSkge1xuICAgICAgY29uc3QgdGV4dCA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKS5jYXRjaCgoKSA9PiBcIlwiKTtcbiAgICAgIHB1c2goeyB0eXBlOiBcImxsbS5lbmRcIiwgaWQsIHN0YXR1czogcmVzcG9uc2Uuc3RhdHVzLCBlcnJvcjogYEhUVFAgJHtyZXNwb25zZS5zdGF0dXN9JHt0ZXh0ID8gXCI6IFwiICsgdGV4dC5yZXBsYWNlKC9cXHMrL2csIFwiIFwiKS5zbGljZSgwLCAyMDApIDogXCJcIn1gIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCByZWFkZXIgPSByZXNwb25zZS5ib2R5LnBpcGVUaHJvdWdoKG5ldyBUZXh0RGVjb2RlclN0cmVhbSgpKS5nZXRSZWFkZXIoKTtcbiAgICBsZXQgYnVmZmVyID0gXCJcIjtcbiAgICBmb3IgKDs7KSB7XG4gICAgICBjb25zdCB7IHZhbHVlLCBkb25lIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpO1xuICAgICAgaWYgKGRvbmUpIGJyZWFrO1xuICAgICAgYnVmZmVyICs9IHZhbHVlO1xuICAgICAgbGV0IGN1dDtcbiAgICAgIHdoaWxlICgoY3V0ID0gYnVmZmVyLmluZGV4T2YoXCJcXG5cIikpID49IDApIHtcbiAgICAgICAgY29uc3QgbGluZSA9IGJ1ZmZlci5zbGljZSgwLCBjdXQpLnJlcGxhY2UoL1xcciQvLCBcIlwiKTtcbiAgICAgICAgYnVmZmVyID0gYnVmZmVyLnNsaWNlKGN1dCArIDEpO1xuICAgICAgICBpZiAobGluZS5zdGFydHNXaXRoKFwiZGF0YTpcIikpIHB1c2goeyB0eXBlOiBcImxsbS5kYXRhXCIsIGlkLCBkYXRhOiBsaW5lLnNsaWNlKDUpLnRyaW0oKSB9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgcHVzaCh7IHR5cGU6IFwibGxtLmVuZFwiLCBpZCB9KTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgaWYgKCFhYm9ydC5zaWduYWwuYWJvcnRlZCkgcHVzaCh7IHR5cGU6IFwibGxtLmVuZFwiLCBpZCwgZXJyb3I6IChlcnIgYXMgRXJyb3IpLm1lc3NhZ2UgfSk7XG4gIH0gZmluYWxseSB7XG4gICAgcmVxdWVzdHMuZGVsZXRlKGlkKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBjYW5jZWxSdW4oa2V5OiBzdHJpbmcsIHJlYXNvbjogc3RyaW5nKSB7XG4gIGNvbnN0IHIgPSBydW5zLmdldChrZXkpO1xuICBsb2coXCJvdXRcIiwgYGNhbmNlbCAke2tleX0gKCR7cmVhc29ufSlgLCBcIm91dFwiKTtcbiAgaWYgKCFyKSByZXR1cm47XG4gIHJ1bnMuZGVsZXRlKGtleSk7XG4gIHIuYWJvcnQuYWJvcnQoKTtcbiAgLy8gQ2FuY2VsbGVkIG9uIHB1cnBvc2U6IHRoZSBhZ2VudCBzdG9wcyB0b28uIEEgY2FsbCB0aGF0IGVuZGVkIGxlYXZlcyBhIGNvZGluZyBhZ2VudCB3b3JraW5nIGluIFQzLlxuICBpZiAocmVhc29uID09PSBcImNhbmNlbGxlZFwiICYmICFjaGVja2VkKFwiZmFrZWhlcm1lc1wiKSkge1xuICAgIHZvaWQgZmV0Y2goci5hZ2VudCA9PT0gXCJ0M1wiID8gXCIvYWdlbnQvY2FuY2VsXCIgOiBcIi9oZXJtZXMvc3RvcFwiLCB7IG1ldGhvZDogXCJQT1NUXCIsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgY2FsbDogY2FsbE5hbWUsIHRhc2tJZDogci50YXNrSWQgfSkgfSk7XG4gIH1cbn1cblxuLyoqIE1vcmUgZm9yIGEgcnVubmluZyB0YXNrLCBpbnRvIGl0cyBjdXJyZW50IHJ1bjsgaWYgdGhlIGFnZW50IHdvbid0IHRha2UgaXQsIHRoZSBjb3JlIHF1ZXVlcyBpdCBpbnN0ZWFkLiAqL1xuYXN5bmMgZnVuY3Rpb24gc3RlZXJSdW4oYzogQ29tbWFuZCkge1xuICBjb25zdCByID0gcnVucy5nZXQoYy5ydW4pO1xuICBsb2coXCJvdXRcIiwgYHN0ZWVyICR7Yy5ydW59OiAke2MudGV4dH1gLCBcIm91dFwiKTtcbiAgaWYgKGNoZWNrZWQoXCJmYWtlaGVybWVzXCIpKSByZXR1cm47XG4gIGNvbnN0IG9rID0gciAhPSBudWxsICYmXG4gICAgKGF3YWl0IGZldGNoKGMuYWdlbnQgPT09IFwidDNcIiA/IFwiL2FnZW50L3N0ZWVyXCIgOiBcIi9oZXJtZXMvc3RlZXJcIiwgeyBtZXRob2Q6IFwiUE9TVFwiLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGNhbGw6IGNhbGxOYW1lLCB0YXNrSWQ6IHIudGFza0lkLCB0ZXh0OiBjLm1lc3NhZ2UgfSkgfSkudGhlbigoeCkgPT4geC5vaywgKCkgPT4gZmFsc2UpKTtcbiAgaWYgKCFvaykgcHVzaCh7IHR5cGU6IFwidG9vbC5zdGVlckZhaWxlZFwiLCBydW46IGMucnVuLCB0ZXh0OiBjLnRleHQgfSk7XG4gIGVsc2UgdG9hc3QoYCR7Yy5hZ2VudCA9PT0gXCJ0M1wiID8gXCJUaGUgY29kaW5nIGFnZW50XCIgOiBcIkhlcm1lc1wifSB0b29rIHRoZSBmb2xsb3ctdXAgd2hpbGUgaXQgd29ya3NgKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gdG9vbChjOiBDb21tYW5kKSB7XG4gIGlmIChjLmtpbmQgPT09IFwiaG9zdFwiKSB7XG4gICAgbG9nKFwib3V0XCIsIGBob3N0IHRvb2wgJHtjLm5hbWV9ICR7SlNPTi5zdHJpbmdpZnkoYy5hcmdzKX1gLCBcIm91dFwiKTtcbiAgICBjb25zdCBhbnN3ZXIgPSBjLm5hbWUgPT09IFwidHZfdm9sdW1lXCIgPyBgVGhlIFRWIGlzIGF0ICR7KGZha2VUdkxldmVsID0gTnVtYmVyKGMuYXJncz8ubGV2ZWwgPz8gZmFrZVR2TGV2ZWwpKX0uYFxuICAgICAgOiBjLm5hbWUgPT09IFwidHZfcGF1c2VcIiA/IChjLmFyZ3M/LnBhdXNlID09PSBmYWxzZSA/IFwiUGxheWluZy5cIiA6IFwiUGF1c2VkLlwiKSA6IFwiRG9uZS5cIjtcbiAgICBzZXRUaW1lb3V0KCgpID0+IHB1c2goeyB0eXBlOiBcInRvb2wucmVzdWx0XCIsIHJ1bjogYy5ydW4sIHRleHQ6IGFuc3dlciB9KSwgMzAwKTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgYWdlbnQgPSBjLmFnZW50ID09PSBcInQzXCIgPyBcInQzXCIgOiBcImhlcm1lc1wiO1xuICBsb2coXCJvdXRcIiwgYCR7YWdlbnR9ICR7Yy5mb2xsb3dVcCA/IFwiZm9sbG93LXVwXCIgOiBcInRhc2tcIn0gXCIke2MubGFiZWx9XCIke2MucHJvamVjdCA/IGAgaW4gJHtjLnByb2plY3R9YCA6IFwiXCJ9OiAke2MucmVxdWVzdH1gLCBcIm91dFwiKTtcbiAgY29uc3QgYWJvcnQgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gIHJ1bnMuc2V0KGMucnVuLCB7IGFib3J0LCBhZ2VudCwgdGFza0lkOiBjLnRhc2tJZCB9KTtcbiAgY29uc3QgZG9uZSA9ICh0ZXh0OiBzdHJpbmcsIGZhaWxlZCA9IGZhbHNlKSA9PiB7XG4gICAgaWYgKCFydW5zLmhhcyhjLnJ1bikpIHJldHVybjtcbiAgICBydW5zLmRlbGV0ZShjLnJ1bik7XG4gICAgY29uc3QgdmlldyA9IHRhc2tzLmdldChjLnRhc2tJZCk7XG4gICAgY29uc3Qgcm93ID0gcmVzdWx0KGFnZW50LCBjLmxhYmVsLCB0ZXh0LCBmYWlsZWQpO1xuICAgIG5vdGlmeShgJHthZ2VudCA9PT0gXCJ0M1wiID8gXCJUM1wiIDogXCJIZXJtZXNcIn0gXHUwMEI3ICR7Yy5sYWJlbH1gLCB0ZXh0KTtcbiAgICBpZiAoIWZhaWxlZCkgeyByZW1lbWJlcihcImFzc2lzdGFudFwiLCB0ZXh0LCBgJHthZ2VudCA9PT0gXCJ0M1wiID8gXCJUM1wiIDogXCJIZXJtZXNcIn0gXHUwMEI3ICR7Yy5sYWJlbH1gKTsgbGFzdExpbmUgPSBudWxsOyB9XG4gICAgaWYgKHZpZXcpIHsgdmlldy5yZXN1bHQgPSByb3c7IHNob3dUYXNrcygpOyB9XG4gICAgcHVzaCh7IHR5cGU6IFwidG9vbC5yZXN1bHRcIiwgcnVuOiBjLnJ1biwgdGV4dCwgZmFpbGVkIH0pO1xuICB9O1xuICBpZiAoY2hlY2tlZChcImZha2VoZXJtZXNcIikpIHtcbiAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4gZG9uZShgKEZha2UgJHthZ2VudCA9PT0gXCJ0M1wiID8gXCJUM1wiIDogXCJIZXJtZXNcIn0pIERvbmU6IFx1MjAxQyR7Yy5yZXF1ZXN0fVx1MjAxRC4gTm90aGluZyB3YXMgYWN0dWFsbHkgcnVuLmApLCBOdW1iZXIoJDxIVE1MSW5wdXRFbGVtZW50PihcImZha2VkZWxheVwiKS52YWx1ZSkgKiAxMDAwKTtcbiAgICBhYm9ydC5zaWduYWwub25hYm9ydCA9ICgpID0+IGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgcmV0dXJuO1xuICB9XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChhZ2VudCA9PT0gXCJ0M1wiID8gXCIvYWdlbnRcIiA6IFwiL2hlcm1lc1wiLCB7XG4gICAgICBtZXRob2Q6IFwiUE9TVFwiLCBzaWduYWw6IGFib3J0LnNpZ25hbCwgaGVhZGVyczogeyBcImNvbnRlbnQtdHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBjYWxsOiBjYWxsTmFtZSwgdGFza0lkOiBjLnRhc2tJZCwgZm9sbG93VXA6IGMuZm9sbG93VXAsIG1lc3NhZ2U6IGMubWVzc2FnZSwgbGFiZWw6IGMubGFiZWwsIHJlcXVlc3Q6IGMucmVxdWVzdCwgcHJvamVjdDogYy5wcm9qZWN0LCBhcHByb3ZhbHM6IFwic2NyZWVuXCIgfSksXG4gICAgfSk7XG4gICAgaWYgKCFyZXNwb25zZS5vayB8fCAhcmVzcG9uc2UuYm9keSkgdGhyb3cgbmV3IEVycm9yKGBIVFRQICR7cmVzcG9uc2Uuc3RhdHVzfWApO1xuICAgIGNvbnN0IHJlYWRlciA9IHJlc3BvbnNlLmJvZHkucGlwZVRocm91Z2gobmV3IFRleHREZWNvZGVyU3RyZWFtKCkpLmdldFJlYWRlcigpO1xuICAgIGxldCBidWZmZXIgPSBcIlwiO1xuICAgIGZvciAoOzspIHtcbiAgICAgIGNvbnN0IHsgdmFsdWUsIGRvbmU6IGZpbmlzaGVkIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpO1xuICAgICAgaWYgKGZpbmlzaGVkKSBicmVhaztcbiAgICAgIGJ1ZmZlciArPSB2YWx1ZTtcbiAgICAgIGxldCBjdXQ7XG4gICAgICB3aGlsZSAoKGN1dCA9IGJ1ZmZlci5pbmRleE9mKFwiXFxuXFxuXCIpKSA+PSAwKSB7XG4gICAgICAgIGNvbnN0IGJsb2NrID0gYnVmZmVyLnNsaWNlKDAsIGN1dCk7XG4gICAgICAgIGJ1ZmZlciA9IGJ1ZmZlci5zbGljZShjdXQgKyAyKTtcbiAgICAgICAgY29uc3QgZXZlbnQgPSBibG9jay5tYXRjaCgvXmV2ZW50OiAoLiopJC9tKT8uWzFdO1xuICAgICAgICBpZiAoIWV2ZW50KSBjb250aW51ZTtcbiAgICAgICAgY29uc3QgZGF0YSA9IEpTT04ucGFyc2UoYmxvY2subWF0Y2goL15kYXRhOiAoLiopJC9tKT8uWzFdID8/IFwie31cIik7XG4gICAgICAgIGlmIChldmVudCA9PT0gXCJwcm9ncmVzc1wiKSBwdXNoKHsgdHlwZTogXCJ0YXNrLnByb2dyZXNzXCIsIHRhc2s6IGMudGFza0lkLCB0ZXh0OiBkYXRhLnRleHQgfSk7XG4gICAgICAgIGVsc2UgaWYgKGV2ZW50ID09PSBcInRocmVhZFwiKSB7IGNvbnN0IHZpZXcgPSB0YXNrcy5nZXQoYy50YXNrSWQpOyBpZiAodmlldykgeyB2aWV3LnRocmVhZCA9IGRhdGEudGhyZWFkOyBzaG93VGFza3MoKTsgfSB9XG4gICAgICAgIGVsc2UgaWYgKGV2ZW50ID09PSBcImFwcHJvdmFsXCIpIHtcbiAgICAgICAgICBjb25zdCB2aWV3ID0gdGFza3MuZ2V0KGMudGFza0lkKTtcbiAgICAgICAgICBpZiAodmlldykgeyB2aWV3LmFwcHJvdmFsID0geyBjb21tYW5kOiBkYXRhLmNvbW1hbmQgfTsgc2hvd1Rhc2tzKHRydWUpOyB9XG4gICAgICAgICAgdG9hc3QoYEhlcm1lcyBhc2tzIHRvIHJ1bjogJHtkYXRhLmNvbW1hbmQuc2xpY2UoMCwgODApfWApO1xuICAgICAgICAgIG5vdGlmeShgSGVybWVzIFx1MDBCNyAke2MubGFiZWx9IG5lZWRzIHlvdXIgYXBwcm92YWxgLCBkYXRhLmNvbW1hbmQpO1xuICAgICAgICAgIGF1ZGlvLmN1ZShBUFBST1ZBTF9UT05FKTtcbiAgICAgICAgfVxuICAgICAgICBlbHNlIGlmIChldmVudCA9PT0gXCJyZXN1bHRcIikgZG9uZShkYXRhLnRleHQsIGRhdGEuZmFpbGVkKTtcbiAgICAgICAgZWxzZSBpZiAoZXZlbnQgPT09IFwiZXJyb3JcIikgeyBydW5zLmRlbGV0ZShjLnJ1bik7IHB1c2goeyB0eXBlOiBcInRvb2wuZXJyb3JcIiwgcnVuOiBjLnJ1biwgbWVzc2FnZTogZGF0YS5tZXNzYWdlIH0pOyB9XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChydW5zLmhhcyhjLnJ1bikpIHsgcnVucy5kZWxldGUoYy5ydW4pOyBwdXNoKHsgdHlwZTogXCJ0b29sLmVycm9yXCIsIHJ1bjogYy5ydW4sIG1lc3NhZ2U6IFwidGhlIHNlcnZlciBjbG9zZWQgdGhlIHN0cmVhbSB3aXRob3V0IGEgcmVzdWx0XCIgfSk7IH1cbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgaWYgKCFhYm9ydC5zaWduYWwuYWJvcnRlZCAmJiBydW5zLmhhcyhjLnJ1bikpIHsgcnVucy5kZWxldGUoYy5ydW4pOyBwdXNoKHsgdHlwZTogXCJ0b29sLmVycm9yXCIsIHJ1bjogYy5ydW4sIG1lc3NhZ2U6IChlcnIgYXMgRXJyb3IpLm1lc3NhZ2UgfSk7IH1cbiAgfVxufVxuXG5mdW5jdGlvbiBtaWNPcHRpb25zKCkge1xuICBjb25zdCBhZWMgPSBjaGVja2VkKFwiYWVjXCIpO1xuICByZXR1cm4geyBlY2hvQ2FuY2VsbGF0aW9uOiBhZWMsIG5vaXNlU3VwcHJlc3Npb246IGFlYywgYXV0b0dhaW5Db250cm9sOiBhZWMgfTtcbn1cblxuZnVuY3Rpb24gcmVhZENvbmZpZygpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gIGNvbnN0IGdpdmVuID0gSlNPTi5wYXJzZSgkPEhUTUxUZXh0QXJlYUVsZW1lbnQ+KFwiY29uZmlnXCIpLnZhbHVlKTtcbiAgY29uc3QgY29uZmlnOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICBtb2RlbDogc2VydmVyLm1vZGVsLCBhcGk6IHNlcnZlci5yb3V0ZSA9PT0gXCJ2ZXJ0ZXhcIiA/IFwidmVydGV4XCIgOiBcImdlbWluaVwiLCB0b2RheTogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLnNsaWNlKDAsIDEwKSxcbiAgICAuLi5naXZlbiwgdHJhY2U6IGNoZWNrZWQoXCJ0cmFjZVwiKSxcbiAgfTtcbiAgaWYgKGNoZWNrZWQoXCJwdHRcIikpIGNvbmZpZy5tdXRlZCA9IHRydWU7XG4gIGlmIChnaXZlbi52b2ljZSA9PT0gdW5kZWZpbmVkKSBjb25maWcudm9pY2UgPSAkPEhUTUxTZWxlY3RFbGVtZW50PihcInZvaWNlXCIpLnZhbHVlO1xuICBpZiAoY29uZmlnLnN0ZWVyaW5nID09PSB1bmRlZmluZWQpIGNvbmZpZy5zdGVlcmluZyA9IFtcImhlcm1lc1wiLCBcInQzXCJdO1xuICAvLyBBIHdlYiBjb25maWcgc2F2ZWQgYmVmb3JlIGhhbmQtb2ZmcyB3ZXJlIG5hbWVkIGluIHdvcmRzIGdldHMgdGhhdCB0b28uXG4gIGlmIChjb25maWcuaGFuZE9mZiA9PT0gdW5kZWZpbmVkICYmIGNvbmZpZy5wbGF0Zm9ybSA9PT0gXCJ3ZWJcIikgY29uZmlnLmhhbmRPZmYgPSBcIm5hbWVkXCI7XG4gIGlmIChjaGVja2VkKFwiY29kaW5nXCIpICYmIChzZXJ2ZXIudDMgfHwgY2hlY2tlZChcImZha2VoZXJtZXNcIikpICYmIGNvbmZpZy5jb2RpbmdBZ2VudCA9PT0gdW5kZWZpbmVkKSBjb25maWcuY29kaW5nQWdlbnQgPSB7IHByb2plY3RzOiBzZXJ2ZXIudDMgPz8gW10gfTtcbiAgaWYgKGNoZWNrZWQoXCJjYXB0aW9uc1wiKSAmJiBzZXJ2ZXIuY2FwdGlvbnNNb2RlbCAmJiBjb25maWcuY2FwdGlvbnMgPT09IHVuZGVmaW5lZCkgY29uZmlnLmNhcHRpb25zID0geyBtb2RlbDogc2VydmVyLmNhcHRpb25zTW9kZWwgfTtcbiAgcmV0dXJuIGNvbmZpZztcbn1cblxuLyoqIFN0YXJ0cyBhIHZvaWNlIGNhbGwsIG9yIHdpdGggW3R5cGVkXSBhIGNoYXQgKHRoZSBjb3JlJ3MgbWVkaXVtIFwidGV4dFwiOiBubyBhdWRpbywgYSB0ZXh0IG1vZGVsKS4gKi9cbmFzeW5jIGZ1bmN0aW9uIHN0YXJ0KGNhcnJ5T24gPSBmYWxzZSwgdHlwZWQgPSBmYWxzZSkge1xuICBhd2FpdCBlbmRpbmc7XG4gIGlmIChjYWxsSWQpIHJldHVybjtcbiAgbGV0IGdpdmVuOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgdHJ5IHtcbiAgICBnaXZlbiA9IHJlYWRDb25maWcoKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgdG9hc3QoYFRoZSBkZXZlbG9wZXIgc2V0dGluZ3MgYXJlbid0IHZhbGlkIEpTT046ICR7KGVyciBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKHR5cGVkKSB7XG4gICAgaWYgKCFzZXJ2ZXIudGV4dE1vZGVsKSB7IHRvYXN0KFwiVGhpcyBzZXJ2ZXIgaGFzIG5vIHRleHQgbW9kZWwgZm9yIGEgY2hhdDogc3RhcnQgYSBjYWxsIHRvIHR5cGUgdG8gaXRcIik7IHJldHVybjsgfVxuICAgIGdpdmVuID0geyAuLi5naXZlbiwgbWVkaXVtOiBcInRleHRcIiwgbXV0ZWQ6IGZhbHNlIH07XG4gICAgZGVsZXRlIGdpdmVuLmNhcHRpb25zO1xuICB9XG4gICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiY2FsbFwiKS5kaXNhYmxlZCA9IHRydWU7XG4gIGlmIChcIk5vdGlmaWNhdGlvblwiIGluIHdpbmRvdyAmJiBOb3RpZmljYXRpb24ucGVybWlzc2lvbiA9PT0gXCJkZWZhdWx0XCIpIHZvaWQgTm90aWZpY2F0aW9uLnJlcXVlc3RQZXJtaXNzaW9uKCkuY2F0Y2goKCkgPT4ge30pO1xuICB0cnkge1xuICAgIGlmICghdHlwZWQpIGF3YWl0IGF1ZGlvLm9wZW4oKTtcbiAgICBjb3JlID0gYXdhaXQgbG9hZENvcmUoKTtcbiAgfSBmaW5hbGx5IHtcbiAgICAkPEhUTUxCdXR0b25FbGVtZW50PihcImNhbGxcIikuZGlzYWJsZWQgPSBmYWxzZTtcbiAgfVxuICBpZiAoY2FsbElkKSByZXR1cm47IC8vIGFub3RoZXIgc3RhcnQgZ290IHRoZXJlIGZpcnN0XG4gIG1lZGl1bSA9IHR5cGVkID8gXCJ0ZXh0XCIgOiBcInZvaWNlXCI7XG4gIHRoaW5raW5nID0gZmFsc2U7XG4gICQoXCJ2ZXJzaW9uXCIpLnRleHRDb250ZW50ID0gY29yZS52ZXJzaW9uO1xuICAkKFwibG9nXCIpLmlubmVySFRNTCA9IFwiXCI7XG4gIGlmICghdHlwZWQgJiYgKHRhc2tzLnNpemUgPiAwIHx8ICQoXCJ0cmFuc2NyaXB0XCIpLmNoaWxkRWxlbWVudENvdW50ID4gMSkpIG5vdGUoYE5ldyBjYWxsIFx1MDBCNyAke25ldyBEYXRlKCkudG9Mb2NhbGVUaW1lU3RyaW5nKCl9YCk7XG4gIHRhc2tzLmNsZWFyKCk7XG4gIHNob3dUYXNrcygpO1xuICBjb3VudHMgPSB7IG1pYzogMCwgcGxheTogMCwgc2VudDogMCB9O1xuICBtZXRyaWNzLnJlcGx5ID0gW107XG4gIHN0YXJ0ZWRBdCA9IG5vdygpO1xuICBtdXRlZCA9IGdpdmVuLm11dGVkID09PSB0cnVlO1xuICAvLyBDYXJyeWluZyBvbjogdGhlIG1vZGVsIGdldHMgdGhlIGxhc3QgY29udmVyc2F0aW9uIGFzIGEgcmVjYXAuIFRoZSBjb3JlIGNhcHMgaXQsIGxhdGVzdCBsaW5lcyBmaXJzdC5cbiAgLy8gQSBjaGF0IGFsd2F5cyBjYXJyaWVzIG9uIGZyb20gd2hhdCdzIG9uIHRoZSBzY3JlZW4gKGFuIGVhcmxpZXIgY2FsbCBvciBjaGF0IG9uIHRoaXMgcGFnZSkuXG4gIGlmICh0eXBlZCkgeyBpZiAoY2hhdC5sZW5ndGggPiAwICYmIGdpdmVuLmhpc3RvcnkgPT09IHVuZGVmaW5lZCkgZ2l2ZW4uaGlzdG9yeSA9IGNoYXQ7IH1cbiAgZWxzZSBpZiAoY2FycnlPbiAmJiBnaXZlbi5oaXN0b3J5ID09PSB1bmRlZmluZWQpIGdpdmVuLmhpc3RvcnkgPSBzYXZlZEhpc3RvcnkoKTtcbiAgZWxzZSBpZiAoIWNhcnJ5T24pIGNoYXQgPSBbXTtcbiAgaWYgKGNhcnJ5T24gJiYgIXR5cGVkKSBjaGF0ID0gc2F2ZWRIaXN0b3J5KCk7XG4gIGxhc3RMaW5lID0gbnVsbDtcbiAgb3BlbkxpbmUgPSBudWxsO1xuICAkKFwicmVzdW1lXCIpLmhpZGRlbiA9IHRydWU7XG4gIGNhbGxOYW1lID0gYCR7bmV3IERhdGUoKS50b0lTT1N0cmluZygpLnJlcGxhY2UoL1s6Ll0vZywgXCItXCIpfS0ke3R5cGVkID8gXCJjaGF0XCIgOiBcIndlYlwifS0ke2NvcmUudmVyc2lvbn1gO1xuICBjb25zdCBjcmVhdGVkID0gSlNPTi5wYXJzZShjb3JlLmNyZWF0ZShKU09OLnN0cmluZ2lmeShnaXZlbiksIG5vdygpKSk7XG4gIGNhbGxJZCA9IGNyZWF0ZWQuaWQ7XG4gIGlmICghdHlwZWQpIHtcbiAgICAkPEhUTUxCdXR0b25FbGVtZW50PihcImNhbGxcIikudGV4dENvbnRlbnQgPSBcIkhhbmcgdXBcIjtcbiAgICAkKFwiY2FsbFwiKS5jbGFzc0xpc3QuYWRkKFwibGl2ZVwiKTtcbiAgICAkPEhUTUxCdXR0b25FbGVtZW50PihcIm1pY1wiKS5kaXNhYmxlZCA9IGZhbHNlO1xuICB9XG4gICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiaHVzaFwiKS5kaXNhYmxlZCA9IGZhbHNlO1xuICAkKFwibWljXCIpLmNsYXNzTGlzdC50b2dnbGUoXCJtdXRlZFwiLCBtdXRlZCk7XG4gIHJ1bihjcmVhdGVkLmNvbW1hbmRzKTtcbiAgdGlja2VyID0gd2luZG93LnNldEludGVydmFsKCgpID0+IHtcbiAgICBwdXNoKHsgdHlwZTogXCJ0aWNrXCIgfSk7XG4gICAgY29uc3QgbGV2ZWwgPSBtdXRlZCAmJiAhaG9sZGluZyA/IDAgOiBhdWRpby5sZXZlbDtcbiAgICAkKFwicmluZ1wiKS5zdHlsZS5vcGFjaXR5ID0gU3RyaW5nKE1hdGgubWluKDEsIGxldmVsICogMTIpKTtcbiAgICAkKFwiY291bnRzXCIpLnRleHRDb250ZW50ID0gYG1pYyAke2NvdW50cy5taWN9IFx1MDBCNyBzZW50ICR7Y291bnRzLnNlbnR9IFx1MDBCNyBwbGF5ZWQgJHtjb3VudHMucGxheX0gXHUwMEI3IHF1ZXVlZCAke2F1ZGlvLnF1ZXVlZC50b0ZpeGVkKDEpfSBzYDtcbiAgICBzaG93U3RhdHVzKCk7XG4gIH0sIDEwMCk7XG4gIHRyYWNlVGltZXIgPSB3aW5kb3cuc2V0SW50ZXJ2YWwoKCkgPT4geyB2b2lkIHNhdmVUcmFjZSgpOyB2b2lkIHBpbmcoKTsgc2hvd1Rhc2tzKCk7IH0sIDUwMDApO1xuICB2b2lkIHBpbmcoKTtcbiAgaWYgKHR5cGVkKSByZXR1cm47XG4gIHN0b3BXb3Jkcy5zdGFydCgpO1xuICB0cnkgeyB3YWtlTG9jayA9IGF3YWl0IChuYXZpZ2F0b3IgYXMgYW55KS53YWtlTG9jaz8ucmVxdWVzdChcInNjcmVlblwiKTsgfSBjYXRjaCB7fVxufVxuXG4vKiogVGhlIENhbGwgYnV0dG9uOiBoYW5ncyB1cCBhIGNhbGw7IHN0YXJ0cyBvbmU7IG9yLCB3aXRoIGEgY2hhdCBvbiwgZW5kcyB0aGUgY2hhdCBhbmQgY2FycmllcyBpdHMgY29udmVyc2F0aW9uIG9uIGJ5IHZvaWNlLiAqL1xuYXN5bmMgZnVuY3Rpb24gY2FsbEJ1dHRvbigpIHtcbiAgaWYgKGNhbGxJZCAmJiBtZWRpdW0gPT09IFwidm9pY2VcIikgeyBoYW5nVXAoKTsgcmV0dXJuOyB9XG4gIGlmIChjYWxsSWQpIHtcbiAgICAvLyBBIGNhbGwgY2FuJ3QgdGFrZSBvdmVyIHRoZSBjaGF0J3MgdGFza3MsIGFuZCBlbmRpbmcgdGhlIGNoYXQgd291bGQgc3RvcCB0aGVtLlxuICAgIGlmIChbLi4udGFza3MudmFsdWVzKCldLnNvbWUoKHYpID0+IHYuYy5zdGF0ZSA9PT0gXCJydW5uaW5nXCIpKSB7IHRvYXN0KFwiVGhlIGNoYXQncyB0YXNrcyBhcmUgc3RpbGwgcnVubmluZzogd2FpdCBmb3IgdGhlbSBvciBjYW5jZWwgdGhlbSwgdGhlbiBjYWxsXCIpOyByZXR1cm47IH1cbiAgICBwdXNoKHsgdHlwZTogXCJzdG9wXCIgfSk7XG4gICAgYXdhaXQgc3RhcnQodHJ1ZSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGF3YWl0IHN0YXJ0KCk7XG59XG5cbmZ1bmN0aW9uIGhhbmdVcCgpIHtcbiAgaWYgKGNhbGxJZCkgcHVzaCh7IHR5cGU6IFwic3RvcFwiLCBtZXNzYWdlOiBcIllvdSBodW5nIHVwLlwiIH0pO1xufVxuXG5mdW5jdGlvbiBlbmQoKSB7XG4gIHdpbmRvdy5jbGVhckludGVydmFsKHRpY2tlcik7XG4gIHdpbmRvdy5jbGVhckludGVydmFsKHRyYWNlVGltZXIpO1xuICBzdG9wV29yZHMuc3RvcCgpO1xuICBlbmRpbmcgPSBzYXZlVHJhY2UoKS50aGVuKCgpID0+IHsgaWYgKGNvcmUgJiYgY2FsbElkKSBjb3JlLmRpc3Bvc2UoY2FsbElkKTsgY2FsbElkID0gMDsgc2hvd1Rhc2tzKCk7IH0pO1xuICBhdWRpby5zdG9wKCk7XG4gIGZvciAoY29uc3Qgd3Mgb2Ygc29ja2V0cy52YWx1ZXMoKSkgd3MuY2xvc2UoKTtcbiAgc29ja2V0cy5jbGVhcigpO1xuICBmb3IgKGNvbnN0IHIgb2YgcnVucy52YWx1ZXMoKSkgci5hYm9ydC5hYm9ydCgpO1xuICBydW5zLmNsZWFyKCk7XG4gIGZvciAoY29uc3QgciBvZiByZXF1ZXN0cy52YWx1ZXMoKSkgci5hYm9ydCgpO1xuICByZXF1ZXN0cy5jbGVhcigpO1xuICB0aGlua2luZyA9IGZhbHNlO1xuICAkPEhUTUxCdXR0b25FbGVtZW50PihcImNhbGxcIikudGV4dENvbnRlbnQgPSBcIkNhbGxcIjtcbiAgJChcImNhbGxcIikuY2xhc3NMaXN0LnJlbW92ZShcImxpdmVcIik7XG4gIGZvciAoY29uc3QgaWQgb2YgW1wibWljXCIsIFwiaHVzaFwiXSkgJDxIVE1MQnV0dG9uRWxlbWVudD4oaWQpLmRpc2FibGVkID0gdHJ1ZTtcbiAgJChcInJpbmdcIikuc3R5bGUub3BhY2l0eSA9IFwiMFwiO1xuICAkKFwicmVzdW1lXCIpLmhpZGRlbiA9IGNoYXQubGVuZ3RoID09PSAwO1xuICB2b2lkIHNob3dFYXJsaWVyKCk7XG4gIHZvaWQgd2FrZUxvY2s/LnJlbGVhc2UoKS5jYXRjaCgoKSA9PiB7fSk7XG4gIHdha2VMb2NrID0gbnVsbDtcbn1cblxuZnVuY3Rpb24gc2V0TXV0ZWQodmFsdWU6IGJvb2xlYW4pIHtcbiAgaWYgKCFjYWxsSWQgfHwgbXV0ZWQgPT09IHZhbHVlKSByZXR1cm47XG4gIG11dGVkID0gdmFsdWU7XG4gICQoXCJtaWNcIikuY2xhc3NMaXN0LnRvZ2dsZShcIm11dGVkXCIsIG11dGVkKTtcbiAgcHVzaCh7IHR5cGU6IG11dGVkID8gXCJtdXRlXCIgOiBcInVubXV0ZVwiIH0pO1xuICBzaG93U3RhdHVzKCk7XG59XG5cbi8qKiBTZW5kcyB3aGF0IHRoZSB0cmFjZSBrZXB0IHNpbmNlIGxhc3QgdGltZSB0byB0aGUgZGV2IHNlcnZlciwgYXMgSlNPTiBsaW5lczogYSBoZWFkZXIsIHRoZW4gZXZlbnRzLiAqL1xuYXN5bmMgZnVuY3Rpb24gc2F2ZVRyYWNlKCkge1xuICBpZiAoIWNvcmUgfHwgIWNhbGxJZCB8fCAhY2hlY2tlZChcInRyYWNlXCIpKSByZXR1cm47XG4gIGNvbnN0IGtlcHQgPSBKU09OLnBhcnNlKGNvcmUudHJhY2UoY2FsbElkKSk7XG4gIGlmICgha2VwdCkgcmV0dXJuO1xuICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcbiAgaWYgKGtlcHQuY29uZmlnKSBsaW5lcy5wdXNoKEpTT04uc3RyaW5naWZ5KHsgdmVyc2lvbjoga2VwdC52ZXJzaW9uLCBjb25maWc6IGtlcHQuY29uZmlnLCBzdGFydDoga2VwdC5zdGFydCB9KSk7XG4gIGZvciAoY29uc3QgZSBvZiBrZXB0LmV2ZW50cykgbGluZXMucHVzaChKU09OLnN0cmluZ2lmeShlKSk7XG4gIGlmIChsaW5lcy5sZW5ndGggPT09IDApIHJldHVybjtcbiAgYXdhaXQgZmV0Y2goYC90cmFjZXM/bmFtZT0ke2VuY29kZVVSSUNvbXBvbmVudChjYWxsTmFtZSl9Lmpzb25sYCwgeyBtZXRob2Q6IFwiUE9TVFwiLCBib2R5OiBsaW5lcy5qb2luKFwiXFxuXCIpICsgXCJcXG5cIiB9KS5jYXRjaCgoKSA9PiB7fSk7XG4gICQoXCJ0cmFjZW5hbWVcIikudGV4dENvbnRlbnQgPSBgdHJhY2UgJHtjYWxsTmFtZX0uanNvbmxgO1xufVxuXG4vLyBcIlN0b3BcIiBhbmQgXCJnb29kYnllXCIgaGVhcmQgYnkgdGhlIGJyb3dzZXIncyBvd24gcmVjb2duaXplcjogcXVpY2tlciB0aGFuIHRoZSBtb2RlbCdzIHRyYW5zY3JpcHQsXG4vLyBhbmQgaXQgd29ya3Mgd2hpbGUgdGhlIG1vZGVsJ3MgcmVwbHkgcGxheXMgZXZlbiB3aGVuIHRoZSBtb2RlbCBpc24ndCBoZWFyaW5nIHRoZSBtaWNyb3Bob25lLlxuXG5jbGFzcyBTdG9wV29yZHMge1xuICBwcml2YXRlIHJlYzogYW55ID0gbnVsbDtcbiAgcHJpdmF0ZSBvbiA9IGZhbHNlO1xuICBwcml2YXRlIGNvbW1hbmRzID0geyBzdG9wOiBbXSBhcyBzdHJpbmdbXSwgaGFuZ1VwOiBbXSBhcyBzdHJpbmdbXSwgY2FuY2VsQWxsOiBbXSBhcyBzdHJpbmdbXSB9O1xuXG4gIGdldCBzdXBwb3J0ZWQoKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIFwid2Via2l0U3BlZWNoUmVjb2duaXRpb25cIiBpbiB3aW5kb3cgfHwgXCJTcGVlY2hSZWNvZ25pdGlvblwiIGluIHdpbmRvdztcbiAgfVxuXG4gIHN0YXJ0KCkge1xuICAgIGlmICghY2hlY2tlZChcInN0b3B3b3JkXCIpIHx8ICF0aGlzLnN1cHBvcnRlZCB8fCAhY29yZSkgcmV0dXJuO1xuICAgIHRoaXMuY29tbWFuZHMgPSBKU09OLnBhcnNlKGNvcmUuZGVmYXVsdHMoKSkudm9pY2VDb21tYW5kcztcbiAgICBjb25zdCBSZWNvZ25pdGlvbiA9ICh3aW5kb3cgYXMgYW55KS5TcGVlY2hSZWNvZ25pdGlvbiA/PyAod2luZG93IGFzIGFueSkud2Via2l0U3BlZWNoUmVjb2duaXRpb247XG4gICAgdGhpcy5yZWMgPSBuZXcgUmVjb2duaXRpb24oKTtcbiAgICB0aGlzLnJlYy5jb250aW51b3VzID0gdHJ1ZTtcbiAgICB0aGlzLnJlYy5pbnRlcmltUmVzdWx0cyA9IHRydWU7XG4gICAgdGhpcy5yZWMubGFuZyA9IG5hdmlnYXRvci5sYW5ndWFnZSB8fCBcImVuLUdCXCI7XG4gICAgdGhpcy5yZWMub25yZXN1bHQgPSAoZTogYW55KSA9PiB7XG4gICAgICBmb3IgKGxldCBpID0gZS5yZXN1bHRJbmRleDsgaSA8IGUucmVzdWx0cy5sZW5ndGg7IGkrKykge1xuICAgICAgICBjb25zdCB0ZXh0ID0gZS5yZXN1bHRzW2ldWzBdLnRyYW5zY3JpcHQgYXMgc3RyaW5nO1xuICAgICAgICBjb25zdCBjb21tYW5kID0gY29tbWFuZEluKHRleHQsIHRoaXMuY29tbWFuZHMsIFtcIldvb2Rob3VzZVwiLCBcIkhlcm1lc1wiLCBcIkJlbnRvXCJdKTtcbiAgICAgICAgaWYgKGNvbW1hbmQgPT09IFwic3RvcFwiICYmIGF1ZGlvLnF1ZXVlZCA+IDAuMDUpIHtcbiAgICAgICAgICBsb2coXCJvdXRcIiwgYGxvY2FsIHN0b3Agd29yZDogJHt0ZXh0fWAsIFwib3V0XCIpO1xuICAgICAgICAgIHRvYXN0KGBIZWFyZCBcdTIwMUMke3RleHQudHJpbSgpfVx1MjAxRDogc3RvcHBlZGApO1xuICAgICAgICAgIHB1c2goeyB0eXBlOiBcImludGVycnVwdFwiIH0pO1xuICAgICAgICB9IGVsc2UgaWYgKGNvbW1hbmQgPT09IFwiY2FuY2VsQWxsXCIgJiYgZS5yZXN1bHRzW2ldLmlzRmluYWwpIHtcbiAgICAgICAgICBsb2coXCJvdXRcIiwgYGxvY2FsIGNhbmNlbC1hbGw6ICR7dGV4dH1gLCBcIm91dFwiKTtcbiAgICAgICAgICBwdXNoKHsgdHlwZTogXCJjYW5jZWxBbGxcIiB9KTtcbiAgICAgICAgICBwdXNoKHsgdHlwZTogXCJpbnRlcnJ1cHRcIiB9KTtcbiAgICAgICAgfSBlbHNlIGlmIChjb21tYW5kID09PSBcImhhbmdVcFwiICYmIGUucmVzdWx0c1tpXS5pc0ZpbmFsKSB7XG4gICAgICAgICAgbG9nKFwib3V0XCIsIGBsb2NhbCBoYW5nLXVwOiAke3RleHR9YCwgXCJvdXRcIik7XG4gICAgICAgICAgaGFuZ1VwKCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9O1xuICAgIHRoaXMucmVjLm9uZW5kID0gKCkgPT4geyBpZiAodGhpcy5vbikgc2V0VGltZW91dCgoKSA9PiB7IHRyeSB7IHRoaXMucmVjPy5zdGFydCgpOyB9IGNhdGNoIHt9IH0sIDI1MCk7IH07XG4gICAgdGhpcy5yZWMub25lcnJvciA9IChlOiBhbnkpID0+IHsgaWYgKGUuZXJyb3IgPT09IFwibm90LWFsbG93ZWRcIikgdGhpcy5vbiA9IGZhbHNlOyB9O1xuICAgIHRoaXMub24gPSB0cnVlO1xuICAgIHRyeSB7IHRoaXMucmVjLnN0YXJ0KCk7IH0gY2F0Y2gge31cbiAgfVxuXG4gIHN0b3AoKSB7XG4gICAgdGhpcy5vbiA9IGZhbHNlO1xuICAgIHRyeSB7IHRoaXMucmVjPy5zdG9wKCk7IH0gY2F0Y2gge31cbiAgICB0aGlzLnJlYyA9IG51bGw7XG4gIH1cbn1cbmNvbnN0IHN0b3BXb3JkcyA9IG5ldyBTdG9wV29yZHMoKTtcblxuLy8gV2lyaW5nLlxuXG5mdW5jdGlvbiBzZXR0aW5nc0Zyb21TdG9yYWdlKCkge1xuICBmb3IgKGNvbnN0IGlkIG9mIFtcImFlY1wiLCBcInN0b3B3b3JkXCIsIFwicHR0XCIsIFwiY2FwdGlvbnNcIiwgXCJjb2RpbmdcIiwgXCJmYWtlaGVybWVzXCIsIFwidHJhY2VcIl0pIHtcbiAgICBjb25zdCB2ID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oYHZvaWNlLiR7aWR9YCk7XG4gICAgaWYgKHYgIT0gbnVsbCkgJDxIVE1MSW5wdXRFbGVtZW50PihpZCkuY2hlY2tlZCA9IHYgPT09IFwiMVwiO1xuICAgICQoaWQpLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4gbG9jYWxTdG9yYWdlLnNldEl0ZW0oYHZvaWNlLiR7aWR9YCwgY2hlY2tlZChpZCkgPyBcIjFcIiA6IFwiMFwiKSk7XG4gIH1cbiAgY29uc3QgZGVsYXkgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShcInZvaWNlLmZha2VkZWxheVwiKTtcbiAgaWYgKGRlbGF5KSAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwiZmFrZWRlbGF5XCIpLnZhbHVlID0gZGVsYXk7XG4gICQoXCJmYWtlZGVsYXlcIikuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLmZha2VkZWxheVwiLCAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwiZmFrZWRlbGF5XCIpLnZhbHVlKSk7XG4gIGNvbnN0IHZvaWNlID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS52b2ljZVwiKTtcbiAgaWYgKHZvaWNlKSAkPEhUTUxTZWxlY3RFbGVtZW50PihcInZvaWNlXCIpLnZhbHVlID0gdm9pY2U7XG4gICQoXCJ2b2ljZVwiKS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2Uudm9pY2VcIiwgJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJ2b2ljZVwiKS52YWx1ZSkpO1xuICBjb25zdCBtb2RlID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS5tb2RlXCIpO1xuICBpZiAobW9kZSkgJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJtb2RlXCIpLnZhbHVlID0gbW9kZTtcbiAgJChcIm1vZGVcIikuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLm1vZGVcIiwgJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJtb2RlXCIpLnZhbHVlKSk7XG59XG5cbmZ1bmN0aW9uIHRhYnMoKSB7XG4gIGNvbnN0IHZpZXdzOiBSZWNvcmQ8c3RyaW5nLCBIVE1MRWxlbWVudD4gPSB7IHRhbGs6ICQoXCJ0YWxrXCIpLCBkZXY6ICQoXCJkZXZcIiksIHJlcGxheTogJChcInJlcGxheW1haW5cIikgfTtcbiAgZm9yIChjb25zdCBuYW1lIG9mIE9iamVjdC5rZXlzKHZpZXdzKSkge1xuICAgICQoYHRhYi0ke25hbWV9YCkub25jbGljayA9ICgpID0+IHtcbiAgICAgIGZvciAoY29uc3QgW290aGVyLCBlbF0gb2YgT2JqZWN0LmVudHJpZXModmlld3MpKSB7XG4gICAgICAgIGVsLmhpZGRlbiA9IG90aGVyICE9PSBuYW1lO1xuICAgICAgICAkKGB0YWItJHtvdGhlcn1gKS5jbGFzc0xpc3QudG9nZ2xlKFwib25cIiwgb3RoZXIgPT09IG5hbWUpO1xuICAgICAgfVxuICAgIH07XG4gIH1cbiAgJChcImdlYXJcIikub25jbGljayA9ICgpID0+IHsgJChcInNldHRpbmdzXCIpLmhpZGRlbiA9IGZhbHNlOyB9O1xuICAkKFwiY2xvc2VzZXR0aW5nc1wiKS5vbmNsaWNrID0gKCkgPT4geyAkKFwic2V0dGluZ3NcIikuaGlkZGVuID0gdHJ1ZTsgfTtcbiAgJChcInNldHRpbmdzXCIpLm9uY2xpY2sgPSAoZSkgPT4geyBpZiAoZS50YXJnZXQgPT09ICQoXCJzZXR0aW5nc1wiKSkgJChcInNldHRpbmdzXCIpLmhpZGRlbiA9IHRydWU7IH07XG59XG5cbmZ1bmN0aW9uIHR5cGluZygpOiBib29sZWFuIHtcbiAgY29uc3QgZWwgPSBkb2N1bWVudC5hY3RpdmVFbGVtZW50IGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgcmV0dXJuICEhZWwgJiYgKGVsLnRhZ05hbWUgPT09IFwiSU5QVVRcIiB8fCBlbC50YWdOYW1lID09PSBcIlRFWFRBUkVBXCIgfHwgZWwudGFnTmFtZSA9PT0gXCJTRUxFQ1RcIiB8fCBlbC5pc0NvbnRlbnRFZGl0YWJsZSk7XG59XG5cbmZ1bmN0aW9uIGtleXMoKSB7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJrZXlkb3duXCIsIChlKSA9PiB7XG4gICAgaWYgKGUua2V5ID09PSBcIkVzY2FwZVwiICYmIGNhbGxJZCkgeyBwdXNoKHsgdHlwZTogXCJpbnRlcnJ1cHRcIiB9KTsgYXVkaW8uZmx1c2goKTsgcmV0dXJuOyB9XG4gICAgaWYgKHR5cGluZygpIHx8IGUubWV0YUtleSB8fCBlLmN0cmxLZXkgfHwgZS5hbHRLZXkpIHJldHVybjtcbiAgICBpZiAoZS5rZXkgPT09IFwibVwiIHx8IGUua2V5ID09PSBcIk1cIikgeyBzZXRNdXRlZCghbXV0ZWQpOyBlLnByZXZlbnREZWZhdWx0KCk7IH1cbiAgICBlbHNlIGlmIChlLmtleSA9PT0gXCIvXCIpIHsgJChcInRleHRcIikuZm9jdXMoKTsgZS5wcmV2ZW50RGVmYXVsdCgpOyB9XG4gICAgZWxzZSBpZiAoZS5jb2RlID09PSBcIlNwYWNlXCIgJiYgY2FsbElkICYmIG11dGVkICYmICFlLnJlcGVhdCkgeyBob2xkaW5nID0gdHJ1ZTsgcHVzaCh7IHR5cGU6IFwidW5tdXRlXCIgfSk7IHNob3dTdGF0dXMoKTsgZS5wcmV2ZW50RGVmYXVsdCgpOyB9XG4gIH0pO1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5dXBcIiwgKGUpID0+IHtcbiAgICBpZiAoZS5jb2RlID09PSBcIlNwYWNlXCIgJiYgaG9sZGluZykgeyBob2xkaW5nID0gZmFsc2U7IHB1c2goeyB0eXBlOiBcIm11dGVcIiB9KTsgc2hvd1N0YXR1cygpOyB9XG4gIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBzdWJtaXRUZXh0KGU6IEV2ZW50KSB7XG4gIGUucHJldmVudERlZmF1bHQoKTtcbiAgY29uc3QgaW5wdXQgPSAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwidGV4dFwiKTtcbiAgbGV0IHRleHQgPSBpbnB1dC52YWx1ZS50cmltKCk7XG4gIGlmICghdGV4dCkgcmV0dXJuO1xuICAvLyBXaXRoIG5vIGNhbGwgb24sIHR5cGluZyBzdGFydHMgYSBjaGF0OiB0aGUgc2FtZSBtYWluIHRocmVhZCwgaW4gdGV4dC5cbiAgaWYgKCFjYWxsSWQpIHtcbiAgICBpbnB1dC52YWx1ZSA9IFwiXCI7XG4gICAgdHJ5IHsgYXdhaXQgc3RhcnQoZmFsc2UsIHRydWUpOyB9IGNhdGNoIChlcnIpIHsgdG9hc3QoKGVyciBhcyBFcnJvcikubWVzc2FnZSk7IGxvZyhcImVycm9yXCIsIChlcnIgYXMgRXJyb3IpLm1lc3NhZ2UsIFwiZXJyXCIpOyB9XG4gICAgaWYgKCFjYWxsSWQpIHsgaW5wdXQudmFsdWUgPSB0ZXh0OyByZXR1cm47IH1cbiAgfVxuICAvLyBcIi90MyBcdTIwMjZcIiBhbmQgXCIvaCBcdTIwMjZcIiBwaWNrIHRoZSBhZ2VudCB3aGF0ZXZlciB0aGUgc2VsZWN0b3Igc2F5cy5cbiAgbGV0IG1vZGUgPSAkPEhUTUxTZWxlY3RFbGVtZW50PihcIm1vZGVcIikudmFsdWU7XG4gIGNvbnN0IHByZWZpeCA9IHRleHQubWF0Y2goL15cXC8odDN8Y29kZXxofGhlcm1lcylcXHMrL2kpO1xuICBpZiAocHJlZml4KSB7IG1vZGUgPSAvXih0M3xjb2RlKSQvaS50ZXN0KHByZWZpeFsxXSkgPyBcInQzXCIgOiBcImhlcm1lc1wiOyB0ZXh0ID0gdGV4dC5zbGljZShwcmVmaXhbMF0ubGVuZ3RoKS50cmltKCk7IH1cbiAgaWYgKCF0ZXh0KSByZXR1cm47XG4gIGlmIChtb2RlID09PSBcInNheVwiKSBwdXNoKHsgdHlwZTogXCJzYXlcIiwgdGV4dCB9KTtcbiAgZWxzZSB7XG4gICAgcHVzaCh7IHR5cGU6IFwiYXNrXCIsIHRleHQsIGFnZW50OiBtb2RlIH0pO1xuICAgIG5vdGUoYFlvdSBcdTIxOTIgbmV3ICR7bW9kZSA9PT0gXCJ0M1wiID8gXCJjb2RpbmdcIiA6IFwiSGVybWVzXCJ9IHRhc2s6ICR7dGV4dH1gKTtcbiAgfVxuICBpbnB1dC52YWx1ZSA9IFwiXCI7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIG1haW4oKSB7XG4gIHNlcnZlciA9IGF3YWl0IChhd2FpdCBmZXRjaChcIi9jb25maWdcIikpLmpzb24oKTtcbiAgJChcInJvdXRlXCIpLnRleHRDb250ZW50ID0gYCR7c2VydmVyLnJvdXRlID09PSBcInZlcnRleFwiID8gXCJHU0sgVmVydGV4XCIgOiBcIkdlbWluaSBBUElcIn0gXHUwMEI3ICR7c2VydmVyLm1vZGVsLnNwbGl0KFwiL1wiKS5wb3AoKX1gO1xuICAkKFwidmVyc2lvblwiKS50ZXh0Q29udGVudCA9IHNlcnZlci52ZXJzaW9uO1xuICAkKFwiYnVpbGRcIikudGV4dENvbnRlbnQgPSBgY29yZSAke3NlcnZlci52ZXJzaW9ufWA7XG4gIHNldHRpbmdzRnJvbVN0b3JhZ2UoKTtcbiAgaWYgKCFzZXJ2ZXIuaGVybWVzKSB7ICQ8SFRNTElucHV0RWxlbWVudD4oXCJmYWtlaGVybWVzXCIpLmNoZWNrZWQgPSB0cnVlOyAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwiZmFrZWhlcm1lc1wiKS5kaXNhYmxlZCA9IHRydWU7IH1cbiAgaWYgKCFzZXJ2ZXIudDMpICQoXCJjb2RpbmdoZWxwXCIpLnRleHRDb250ZW50ID0gXCJUMyBpc24ndCBhdmFpbGFibGUgb24gdGhlIHNlcnZlcjogb25seSB3aXRoIGZha2UgYW5zd2Vycy5cIjtcbiAgZWxzZSAkKFwiY29kaW5naGVscFwiKS50ZXh0Q29udGVudCA9IGBDb2RlIGNoYW5nZXMgZ28gdG8gYSBUMyBDb2RlIHRocmVhZCBpbiBvbmUgb2Y6ICR7c2VydmVyLnQzLmpvaW4oXCIsIFwiKX0uYDtcbiAgaWYgKCFzdG9wV29yZHMuc3VwcG9ydGVkKSB7ICQ8SFRNTElucHV0RWxlbWVudD4oXCJzdG9wd29yZFwiKS5jaGVja2VkID0gZmFsc2U7ICQ8SFRNTElucHV0RWxlbWVudD4oXCJzdG9wd29yZFwiKS5kaXNhYmxlZCA9IHRydWU7IH1cbiAgY29uc3QgcHJlc2V0ID0gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJwcmVzZXRcIik7XG4gIGZvciAoY29uc3QgbmFtZSBvZiBPYmplY3Qua2V5cyhQUkVTRVRTKSkgcHJlc2V0LmFkZChuZXcgT3B0aW9uKG5hbWUsIG5hbWUpKTtcbiAgcHJlc2V0LnZhbHVlID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS1jb3JlLnByZXNldFwiKSA/PyBcIndlYlwiO1xuICBpZiAoIVBSRVNFVFNbcHJlc2V0LnZhbHVlXSkgcHJlc2V0LnZhbHVlID0gXCJ3ZWJcIjtcbiAgJDxIVE1MVGV4dEFyZWFFbGVtZW50PihcImNvbmZpZ1wiKS52YWx1ZSA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UtY29yZS5jb25maWdcIikgPz8gSlNPTi5zdHJpbmdpZnkoUFJFU0VUU1twcmVzZXQudmFsdWVdLCBudWxsLCAyKTtcbiAgcHJlc2V0Lm9uY2hhbmdlID0gKCkgPT4ge1xuICAgICQ8SFRNTFRleHRBcmVhRWxlbWVudD4oXCJjb25maWdcIikudmFsdWUgPSBKU09OLnN0cmluZ2lmeShQUkVTRVRTW3ByZXNldC52YWx1ZV0sIG51bGwsIDIpO1xuICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2UtY29yZS5wcmVzZXRcIiwgcHJlc2V0LnZhbHVlKTtcbiAgICBsb2NhbFN0b3JhZ2UucmVtb3ZlSXRlbShcInZvaWNlLWNvcmUuY29uZmlnXCIpO1xuICB9O1xuICAkKFwiY29uZmlnXCIpLm9uaW5wdXQgPSAoKSA9PiBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLWNvcmUuY29uZmlnXCIsICQ8SFRNTFRleHRBcmVhRWxlbWVudD4oXCJjb25maWdcIikudmFsdWUpO1xuICAkKFwiZGVmYXVsdHNcIikub25jbGljayA9IGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBjID0gY29yZSA/PyAoYXdhaXQgbG9hZENvcmUoKSk7XG4gICAgJChcImRlZmF1bHRzdmlld1wiKS50ZXh0Q29udGVudCA9IEpTT04uc3RyaW5naWZ5KEpTT04ucGFyc2UoYy5kZWZhdWx0cygpKSwgbnVsbCwgMik7XG4gICAgJChcImRlZmF1bHRzdmlld1wiKS5oaWRkZW4gPSAhJChcImRlZmF1bHRzdmlld1wiKS5oaWRkZW47XG4gIH07XG4gICQoXCJjYWxsXCIpLm9uY2xpY2sgPSAoKSA9PiB2b2lkIGNhbGxCdXR0b24oKS5jYXRjaCgoZXJyKSA9PiB7IHRvYXN0KGVyci5tZXNzYWdlKTsgbG9nKFwiZXJyb3JcIiwgZXJyLm1lc3NhZ2UsIFwiZXJyXCIpOyB9KTtcbiAgJChcInJlc3VtZVwiKS5vbmNsaWNrID0gKCkgPT4gdm9pZCBzdGFydCh0cnVlKS5jYXRjaCgoZXJyKSA9PiB7IHRvYXN0KGVyci5tZXNzYWdlKTsgbG9nKFwiZXJyb3JcIiwgZXJyLm1lc3NhZ2UsIFwiZXJyXCIpOyB9KTtcbiAgaWYgKHNhdmVkSGlzdG9yeSgpLmxlbmd0aCA+IDApIHsgJChcInJlc3VtZVwiKS5oaWRkZW4gPSBmYWxzZTsgJChcInJlc3VtZVwiKS50aXRsZSA9IFwiQ2FsbCBhZ2FpbiwgY2Fycnlpbmcgb24gZnJvbSB0aGUgbGFzdCBjb252ZXJzYXRpb25cIjsgfVxuICAkKFwibWljXCIpLm9uY2xpY2sgPSAoKSA9PiBzZXRNdXRlZCghbXV0ZWQpO1xuICAkKFwiaHVzaFwiKS5vbmNsaWNrID0gKCkgPT4geyBwdXNoKHsgdHlwZTogXCJpbnRlcnJ1cHRcIiB9KTsgYXVkaW8uZmx1c2goKTsgfTtcbiAgJChcImNhbmNlbGFsbFwiKS5vbmNsaWNrID0gKCkgPT4gcHVzaCh7IHR5cGU6IFwiY2FuY2VsQWxsXCIgfSk7XG4gICQoXCJkb25lYm94XCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJ0b2dnbGVcIiwgKCkgPT4geyBpZiAoJDxIVE1MRGV0YWlsc0VsZW1lbnQ+KFwiZG9uZWJveFwiKS5vcGVuKSAkKFwiZG9uZWJveFwiKS5zY3JvbGxJbnRvVmlldyh7IGJsb2NrOiBcIm5lYXJlc3RcIiB9KTsgfSk7XG4gICQoXCJzYXlcIikub25zdWJtaXQgPSAoZSkgPT4gdm9pZCBzdWJtaXRUZXh0KGUpO1xuICAkKFwidGV4dFwiKS5hZGRFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCAoZSkgPT4geyBpZiAoKGUgYXMgS2V5Ym9hcmRFdmVudCkua2V5ID09PSBcIkVudGVyXCIpIHZvaWQgc3VibWl0VGV4dChlKTsgfSk7XG4gIHRhYnMoKTtcbiAga2V5cygpO1xuICBjb25zdCBldmVudHMgPSBuZXcgRXZlbnRTb3VyY2UoXCIvZXZlbnRzXCIpO1xuICBldmVudHMuYWRkRXZlbnRMaXN0ZW5lcihcImNvcmVcIiwgKGUpID0+IHtcbiAgICBjb25zdCB7IHZlcnNpb24gfSA9IEpTT04ucGFyc2UoKGUgYXMgTWVzc2FnZUV2ZW50KS5kYXRhKTtcbiAgICAkKFwidmVyc2lvblwiKS50ZXh0Q29udGVudCA9IHZlcnNpb24gKyAoY2FsbElkICYmIGNvcmUgJiYgY29yZS52ZXJzaW9uICE9PSB2ZXJzaW9uID8gYCAobmV4dCBjYWxsOyB0aGlzIG9uZSBydW5zICR7Y29yZS52ZXJzaW9ufSlgIDogXCJcIik7XG4gICAgJChcImJ1aWxkXCIpLnRleHRDb250ZW50ID0gYGNvcmUgJHt2ZXJzaW9ufWA7XG4gIH0pO1xuICBldmVudHMuYWRkRXZlbnRMaXN0ZW5lcihcImFwcFwiLCAoKSA9PiB7IGlmICghY2FsbElkKSBsb2NhdGlvbi5yZWxvYWQoKTsgZWxzZSB0b2FzdChcIlRoZSBwYWdlIGNoYW5nZWQ6IHJlbG9hZCBhZnRlciB0aGlzIGNhbGxcIik7IH0pO1xuICBldmVudHMuYWRkRXZlbnRMaXN0ZW5lcihcImVycm9yXCIsIChlKSA9PiB7XG4gICAgY29uc3QgZGF0YSA9IChlIGFzIE1lc3NhZ2VFdmVudCkuZGF0YTtcbiAgICBpZiAoZGF0YSkgdG9hc3QoYEJ1aWxkIGZhaWxlZDogJHtKU09OLnBhcnNlKGRhdGEpLm1lc3NhZ2V9YCk7XG4gIH0pO1xuICBuZXcgUmVwbGF5KCQoXCJyZXBsYXlcIiksIGxvYWRDb3JlKTtcbiAgdm9pZCBwaW5nKCk7XG4gIHZvaWQgc2hvd0VhcmxpZXIoKTtcbiAgd2luZG93LnNldEludGVydmFsKCgpID0+IHZvaWQgc2hvd0VhcmxpZXIoKSwgMzBfMDAwKTtcbn1cblxudm9pZCBtYWluKCk7XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBU0EsSUFBTSxTQUFTLG9CQUFJLElBQUk7QUFBQSxFQUNyQjtBQUFBLEVBQU87QUFBQSxFQUFNO0FBQUEsRUFBUTtBQUFBLEVBQVU7QUFBQSxFQUFPO0FBQUEsRUFBUTtBQUFBLEVBQU07QUFBQSxFQUFNO0FBQUEsRUFBTTtBQUFBLEVBQU07QUFBQSxFQUFXO0FBQUEsRUFBUztBQUFBLEVBQVE7QUFBQSxFQUFPO0FBQUEsRUFBVTtBQUFBLEVBQVM7QUFBQSxFQUM1SDtBQUNGLENBQUM7QUFHTSxTQUFTLE1BQU0sTUFBd0I7QUFDNUMsU0FBTyxLQUFLLFlBQVksRUFBRSxRQUFRLFVBQVUsRUFBRSxFQUFFLFFBQVEscUJBQXFCLEdBQUcsRUFBRSxLQUFLLEVBQUUsTUFBTSxHQUFHLEVBQUUsT0FBTyxDQUFDLE1BQU0sRUFBRSxTQUFTLENBQUM7QUFDaEk7QUFHTyxTQUFTLFVBQVUsV0FBbUIsVUFBeUIsUUFBa0IsQ0FBQyxHQUF3QjtBQUMvRyxRQUFNLFVBQVUsb0JBQUksSUFBSSxDQUFDLEdBQUcsUUFBUSxHQUFHLE1BQU0sUUFBUSxLQUFLLENBQUMsQ0FBQztBQUM1RCxRQUFNLE9BQU8sTUFBTSxTQUFTO0FBQzVCLE1BQUksT0FBTztBQUNYLE1BQUksS0FBSyxLQUFLO0FBQ2QsU0FBTyxPQUFPLE1BQU0sUUFBUSxJQUFJLEtBQUssSUFBSSxDQUFDLEVBQUc7QUFDN0MsU0FBTyxLQUFLLFFBQVEsUUFBUSxJQUFJLEtBQUssS0FBSyxDQUFDLENBQUMsRUFBRztBQUMvQyxNQUFJ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
