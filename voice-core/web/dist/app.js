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
        connect(c.sid);
        break;
      case "ws.send": {
        sockets.get(c.sid)?.send(c.data);
        if (c.data.startsWith('{"realtimeInput":{"audio"')) counts.sent++;
        else log("out", `ws ${c.sid} \u2192 ${brief(c.data)}`, "out");
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
function connect(sid) {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/live`);
  sockets.set(sid, ws);
  log("out", `ws ${sid} connect (${server.route})`, "out");
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
  for (const id of ["aec", "stopword", "ptt", "coding", "fakehermes", "trace"]) {
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL2NvbW1hbmRzLnRzIiwgIi4uL2F1ZGlvLnRzIiwgIi4uL3JlcGxheS50cyIsICIuLi9hcHAudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFNwb2tlbiBjb21tYW5kcyB0aGUgY29yZSBhY3RzIG9uIHdpdGhvdXQgdGhlIG1vZGVsOiBcInN0b3BcIiBhbmQgXCJoYW5nIHVwXCIuIEFuIHV0dGVyYW5jZSBjb3VudHNcbi8vIG9ubHkgd2hlbiBpdCBpcyBvbmUgb2YgdGhlIHBocmFzZXMgYW5kIG5vdGhpbmcgbW9yZSwgb25jZSBuYW1lcyBhbmQgZmlsbGVycyBhcm91bmQgaXQgYXJlIGdvbmUsXG4vLyBzbyBcIldvb2Rob3VzZSwgc3RvcCBwbGVhc2VcIiBzdG9wcyBhbmQgXCJzdG9wIHRoZSBQZW5ueXdvcnRoIHRhc2tcIiBnb2VzIHRvIHRoZSBtb2RlbCBhcyB1c3VhbC5cblxuaW1wb3J0IHR5cGUgeyBWb2ljZUNvbW1hbmRzIH0gZnJvbSBcIi4vdHlwZXMudHNcIjtcblxuZXhwb3J0IHR5cGUgVm9pY2VDb21tYW5kID0gXCJzdG9wXCIgfCBcImhhbmdVcFwiIHwgXCJjYW5jZWxBbGxcIjtcblxuLyoqIFdvcmRzIHRoYXQgbWF5IGNvbWUgYmVmb3JlIG9yIGFmdGVyIGEgY29tbWFuZCB3aXRob3V0IGNoYW5naW5nIGl0LiAqL1xuY29uc3QgRklMTEVSID0gbmV3IFNldChbXG4gIFwiaGV5XCIsIFwib2tcIiwgXCJva2F5XCIsIFwicGxlYXNlXCIsIFwibm93XCIsIFwianVzdFwiLCBcInNvXCIsIFwidW1cIiwgXCJ1aFwiLCBcIm9oXCIsIFwiYWxyaWdodFwiLCBcInJpZ2h0XCIsIFwieWVhaFwiLCBcInllc1wiLCBcInRoYW5rc1wiLCBcInRoYW5rXCIsIFwieW91XCIsXG4gIFwiZ2VtaW5pXCIsXG5dKTtcblxuLyoqIFt0ZXh0XSBhcyBsb3dlci1jYXNlIHdvcmRzLCBhcG9zdHJvcGhlcyBkcm9wcGVkIChcIlRoYXQnc1wiIGlzIFwidGhhdHNcIikuICovXG5leHBvcnQgZnVuY3Rpb24gd29yZHModGV4dDogc3RyaW5nKTogc3RyaW5nW10ge1xuICByZXR1cm4gdGV4dC50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL1snXHUyMDE5YF0vZywgXCJcIikucmVwbGFjZSgvW15cXHB7TH1cXHB7TmR9XSsvZ3UsIFwiIFwiKS50cmltKCkuc3BsaXQoXCIgXCIpLmZpbHRlcigodykgPT4gdy5sZW5ndGggPiAwKTtcbn1cblxuLyoqIFRoZSBjb21tYW5kIFt1dHRlcmFuY2VdIGlzLCBpZiBpdCdzIG9uZSBhbmQgbm90aGluZyBtb3JlOyBbbmFtZXNdICh0aGUgYXNzaXN0YW50J3MsIFwiV29vZGhvdXNlXCIpIGRvbid0IGNvdW50LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbW1hbmRJbih1dHRlcmFuY2U6IHN0cmluZywgY29tbWFuZHM6IFZvaWNlQ29tbWFuZHMsIG5hbWVzOiBzdHJpbmdbXSA9IFtdKTogVm9pY2VDb21tYW5kIHwgbnVsbCB7XG4gIGNvbnN0IGlnbm9yZWQgPSBuZXcgU2V0KFsuLi5GSUxMRVIsIC4uLm5hbWVzLmZsYXRNYXAod29yZHMpXSk7XG4gIGNvbnN0IHNhaWQgPSB3b3Jkcyh1dHRlcmFuY2UpO1xuICBsZXQgZnJvbSA9IDA7XG4gIGxldCB0byA9IHNhaWQubGVuZ3RoO1xuICB3aGlsZSAoZnJvbSA8IHRvICYmIGlnbm9yZWQuaGFzKHNhaWRbZnJvbV0pKSBmcm9tKys7XG4gIHdoaWxlICh0byA+IGZyb20gJiYgaWdub3JlZC5oYXMoc2FpZFt0byAtIDFdKSkgdG8tLTtcbiAgaWYgKGZyb20gPT09IHRvIHx8IHRvIC0gZnJvbSA+IDUpIHJldHVybiBudWxsO1xuICBjb25zdCBjb3JlID0gc2FpZC5zbGljZShmcm9tLCB0bykuam9pbihcIiBcIik7XG4gIGNvbnN0IGlzID0gKHBocmFzZXM6IHN0cmluZ1tdKSA9PiBwaHJhc2VzLnNvbWUoKHApID0+IHdvcmRzKHApLmpvaW4oXCIgXCIpID09PSBjb3JlKTtcbiAgaWYgKGlzKGNvbW1hbmRzLmhhbmdVcCkpIHJldHVybiBcImhhbmdVcFwiO1xuICBpZiAoaXMoY29tbWFuZHMuY2FuY2VsQWxsID8/IFtdKSkgcmV0dXJuIFwiY2FuY2VsQWxsXCI7XG4gIGlmIChpcyhjb21tYW5kcy5zdG9wKSkgcmV0dXJuIFwic3RvcFwiO1xuICByZXR1cm4gbnVsbDtcbn1cbiIsICIvLyBUaGUgYnJvd3NlcidzIG1pY3JvcGhvbmUgYW5kIHNwZWFrZXIgZm9yIGEgY2FsbDogMTYga0h6IFBDTTE2IGZyYW1lcyBvdXQgb2YgdGhlIG1pY3JvcGhvbmUsXG4vLyAyNCBrSHogUENNMTYgaW50byB0aGUgc3BlYWtlciwgYW5kIHRvbmVzIGxhaWQgb3ZlciB3aGF0ZXZlciBwbGF5cy4gQm90aCBydW4gaW4gQXVkaW9Xb3JrbGV0cyBvblxuLy8gb25lIEF1ZGlvQ29udGV4dCBhdCB0aGUgZGV2aWNlJ3MgcmF0ZSwgcmVzYW1wbGluZyB0aGVyZS5cblxuY29uc3QgV09SS0xFVFMgPSBgXG5jbGFzcyBDYXB0dXJlIGV4dGVuZHMgQXVkaW9Xb3JrbGV0UHJvY2Vzc29yIHtcbiAgY29uc3RydWN0b3IoKSB7XG4gICAgc3VwZXIoKTtcbiAgICB0aGlzLnN0ZXAgPSBzYW1wbGVSYXRlIC8gMTYwMDA7XG4gICAgdGhpcy5wb3MgPSAwO1xuICAgIHRoaXMuZnJhbWUgPSBuZXcgSW50MTZBcnJheSgzMjApO1xuICAgIHRoaXMubiA9IDA7XG4gICAgLy8gQSB3aW5kb3dlZC1zaW5jIGxvdy1wYXNzIGF0IDcga0h6LCBzbyBub3RoaW5nIGFib3ZlIDE2IGtIeidzIDgga0h6IGxpbWl0IGZvbGRzIGJhY2sgaW50byBzcGVlY2guXG4gICAgY29uc3QgdGFwcyA9IDQ3LCBjdXQgPSA3MDAwIC8gc2FtcGxlUmF0ZTtcbiAgICB0aGlzLnRhcHMgPSBuZXcgRmxvYXQzMkFycmF5KHRhcHMpO1xuICAgIGxldCBzdW0gPSAwO1xuICAgIGZvciAobGV0IGsgPSAwOyBrIDwgdGFwczsgaysrKSB7XG4gICAgICBjb25zdCBtID0gayAtICh0YXBzIC0gMSkgLyAyO1xuICAgICAgY29uc3Qgc2luYyA9IG0gPT09IDAgPyAyICogY3V0IDogTWF0aC5zaW4oMiAqIE1hdGguUEkgKiBjdXQgKiBtKSAvIChNYXRoLlBJICogbSk7XG4gICAgICBjb25zdCB3ID0gMC40MiAtIDAuNSAqIE1hdGguY29zKCgyICogTWF0aC5QSSAqIGspIC8gKHRhcHMgLSAxKSkgKyAwLjA4ICogTWF0aC5jb3MoKDQgKiBNYXRoLlBJICogaykgLyAodGFwcyAtIDEpKTtcbiAgICAgIHRoaXMudGFwc1trXSA9IHNpbmMgKiB3O1xuICAgICAgc3VtICs9IHRoaXMudGFwc1trXTtcbiAgICB9XG4gICAgZm9yIChsZXQgayA9IDA7IGsgPCB0YXBzOyBrKyspIHRoaXMudGFwc1trXSAvPSBzdW07XG4gICAgdGhpcy5oaXN0b3J5ID0gbmV3IEZsb2F0MzJBcnJheSh0YXBzKTtcbiAgICB0aGlzLmF0ID0gMDtcbiAgfVxuICBwcm9jZXNzKGlucHV0cykge1xuICAgIGNvbnN0IGlucHV0ID0gaW5wdXRzWzBdICYmIGlucHV0c1swXVswXTtcbiAgICBpZiAoIWlucHV0KSByZXR1cm4gdHJ1ZTtcbiAgICBjb25zdCB0YXBzID0gdGhpcy50YXBzLCBoID0gdGhpcy5oaXN0b3J5LCBuID0gdGFwcy5sZW5ndGg7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBpbnB1dC5sZW5ndGg7IGkrKykge1xuICAgICAgaFt0aGlzLmF0XSA9IGlucHV0W2ldO1xuICAgICAgdGhpcy5hdCA9ICh0aGlzLmF0ICsgMSkgJSBuO1xuICAgICAgLy8gT25seSB0aGUgc2FtcGxlcyBrZXB0IG5lZWQgZmlsdGVyaW5nOiBhdCBtb3N0IG9uZSBpbiBldmVyeSBzdGVwLlxuICAgICAgaWYgKHRoaXMucG9zID4gMSkgeyB0aGlzLnBvcyAtPSAxOyBjb250aW51ZTsgfVxuICAgICAgbGV0IHggPSAwO1xuICAgICAgZm9yIChsZXQgayA9IDAsIGogPSB0aGlzLmF0OyBrIDwgbjsgaysrLCBqID0gaiArIDEgPT09IG4gPyAwIDogaiArIDEpIHggKz0gdGFwc1trXSAqIGhbal07XG4gICAgICB3aGlsZSAodGhpcy5wb3MgPD0gMSkge1xuICAgICAgICBjb25zdCBzID0gTWF0aC5tYXgoLTEsIE1hdGgubWluKDEsIHgpKTtcbiAgICAgICAgdGhpcy5mcmFtZVt0aGlzLm4rK10gPSBzIDwgMCA/IHMgKiAzMjc2OCA6IHMgKiAzMjc2NztcbiAgICAgICAgaWYgKHRoaXMubiA9PT0gdGhpcy5mcmFtZS5sZW5ndGgpIHtcbiAgICAgICAgICB0aGlzLnBvcnQucG9zdE1lc3NhZ2UodGhpcy5mcmFtZS5idWZmZXIsIFt0aGlzLmZyYW1lLmJ1ZmZlcl0pO1xuICAgICAgICAgIHRoaXMuZnJhbWUgPSBuZXcgSW50MTZBcnJheSgzMjApO1xuICAgICAgICAgIHRoaXMubiA9IDA7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5wb3MgKz0gdGhpcy5zdGVwO1xuICAgICAgfVxuICAgICAgdGhpcy5wb3MgLT0gMTtcbiAgICB9XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbn1cblxuY2xhc3MgUGxheWJhY2sgZXh0ZW5kcyBBdWRpb1dvcmtsZXRQcm9jZXNzb3Ige1xuICBjb25zdHJ1Y3RvcigpIHtcbiAgICBzdXBlcigpO1xuICAgIHRoaXMucXVldWUgPSBbXTsgICAgICAvLyBGbG9hdDMyQXJyYXlzIGF0IHRoZSBjb250ZXh0J3MgcmF0ZVxuICAgIHRoaXMub2Zmc2V0ID0gMDtcbiAgICB0aGlzLmN1ZXMgPSBbXTtcbiAgICB0aGlzLmN1ZU9mZnNldCA9IDA7XG4gICAgdGhpcy5yZXBvcnRlZCA9IDA7XG4gICAgdGhpcy5wb3J0Lm9ubWVzc2FnZSA9IChlKSA9PiB7XG4gICAgICBjb25zdCBtID0gZS5kYXRhO1xuICAgICAgaWYgKG0udHlwZSA9PT0gXCJwbGF5XCIpIHRoaXMucXVldWUucHVzaChtLnNhbXBsZXMpO1xuICAgICAgZWxzZSBpZiAobS50eXBlID09PSBcImN1ZVwiKSB0aGlzLmN1ZXMucHVzaChtLnNhbXBsZXMpO1xuICAgICAgZWxzZSBpZiAobS50eXBlID09PSBcImZsdXNoXCIpIHsgdGhpcy5xdWV1ZSA9IFtdOyB0aGlzLm9mZnNldCA9IDA7IH1cbiAgICAgIGVsc2UgaWYgKG0udHlwZSA9PT0gXCJzdG9wXCIpIHsgdGhpcy5xdWV1ZSA9IFtdOyB0aGlzLm9mZnNldCA9IDA7IHRoaXMuY3VlcyA9IFtdOyB0aGlzLmN1ZU9mZnNldCA9IDA7IH1cbiAgICB9O1xuICB9XG4gIHByb2Nlc3MoXywgb3V0cHV0cykge1xuICAgIGNvbnN0IG91dCA9IG91dHB1dHNbMF1bMF07XG4gICAgb3V0LmZpbGwoMCk7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoICYmIHRoaXMucXVldWUubGVuZ3RoOyBpKyspIHtcbiAgICAgIG91dFtpXSA9IHRoaXMucXVldWVbMF1bdGhpcy5vZmZzZXQrK107XG4gICAgICBpZiAodGhpcy5vZmZzZXQgPj0gdGhpcy5xdWV1ZVswXS5sZW5ndGgpIHsgdGhpcy5xdWV1ZS5zaGlmdCgpOyB0aGlzLm9mZnNldCA9IDA7IH1cbiAgICB9XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoICYmIHRoaXMuY3Vlcy5sZW5ndGg7IGkrKykge1xuICAgICAgb3V0W2ldID0gTWF0aC5tYXgoLTEsIE1hdGgubWluKDEsIG91dFtpXSArIHRoaXMuY3Vlc1swXVt0aGlzLmN1ZU9mZnNldCsrXSkpO1xuICAgICAgaWYgKHRoaXMuY3VlT2Zmc2V0ID49IHRoaXMuY3Vlc1swXS5sZW5ndGgpIHsgdGhpcy5jdWVzLnNoaWZ0KCk7IHRoaXMuY3VlT2Zmc2V0ID0gMDsgfVxuICAgIH1cbiAgICBmb3IgKGxldCBjID0gMTsgYyA8IG91dHB1dHNbMF0ubGVuZ3RoOyBjKyspIG91dHB1dHNbMF1bY10uc2V0KG91dCk7XG4gICAgaWYgKGN1cnJlbnRUaW1lIC0gdGhpcy5yZXBvcnRlZCA+IDAuMSkge1xuICAgICAgdGhpcy5yZXBvcnRlZCA9IGN1cnJlbnRUaW1lO1xuICAgICAgbGV0IHF1ZXVlZCA9IC10aGlzLm9mZnNldDtcbiAgICAgIGZvciAoY29uc3QgcSBvZiB0aGlzLnF1ZXVlKSBxdWV1ZWQgKz0gcS5sZW5ndGg7XG4gICAgICB0aGlzLnBvcnQucG9zdE1lc3NhZ2UoeyBxdWV1ZWQ6IHF1ZXVlZCAvIHNhbXBsZVJhdGUgfSk7XG4gICAgfVxuICAgIHJldHVybiB0cnVlO1xuICB9XG59XG5yZWdpc3RlclByb2Nlc3NvcihcImNhcHR1cmVcIiwgQ2FwdHVyZSk7XG5yZWdpc3RlclByb2Nlc3NvcihcInBsYXliYWNrXCIsIFBsYXliYWNrKTtcbmA7XG5cbmZ1bmN0aW9uIGJhc2U2NFRvQnl0ZXMoYjY0OiBzdHJpbmcpOiBVaW50OEFycmF5IHtcbiAgY29uc3QgYmluID0gYXRvYihiNjQpO1xuICBjb25zdCBvdXQgPSBuZXcgVWludDhBcnJheShiaW4ubGVuZ3RoKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBiaW4ubGVuZ3RoOyBpKyspIG91dFtpXSA9IGJpbi5jaGFyQ29kZUF0KGkpO1xuICByZXR1cm4gb3V0O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYnl0ZXNUb0Jhc2U2NChieXRlczogVWludDhBcnJheSk6IHN0cmluZyB7XG4gIGxldCBiaW4gPSBcIlwiO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGJ5dGVzLmxlbmd0aDsgaSArPSAweDgwMDApIGJpbiArPSBTdHJpbmcuZnJvbUNoYXJDb2RlKC4uLmJ5dGVzLnN1YmFycmF5KGksIGkgKyAweDgwMDApKTtcbiAgcmV0dXJuIGJ0b2EoYmluKTtcbn1cblxuLyoqIFBDTTE2IGxpdHRsZS1lbmRpYW4gYXQgW3JhdGVdLCBhcyBmbG9hdHMgYXQgdGhlIGNvbnRleHQncyByYXRlLiAqL1xuZnVuY3Rpb24gdG9GbG9hdHMocGNtOiBVaW50OEFycmF5LCByYXRlOiBudW1iZXIsIHRhcmdldDogbnVtYmVyKTogRmxvYXQzMkFycmF5IHtcbiAgY29uc3QgdmlldyA9IG5ldyBEYXRhVmlldyhwY20uYnVmZmVyLCBwY20uYnl0ZU9mZnNldCwgcGNtLmJ5dGVMZW5ndGgpO1xuICBjb25zdCBuID0gTWF0aC5mbG9vcihwY20uYnl0ZUxlbmd0aCAvIDIpO1xuICBjb25zdCBvdXQgPSBuZXcgRmxvYXQzMkFycmF5KE1hdGguZmxvb3IoKG4gKiB0YXJnZXQpIC8gcmF0ZSkpO1xuICBjb25zdCBzdGVwID0gcmF0ZSAvIHRhcmdldDtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCB4ID0gaSAqIHN0ZXA7XG4gICAgY29uc3QgaiA9IE1hdGguZmxvb3IoeCk7XG4gICAgY29uc3QgYSA9IHZpZXcuZ2V0SW50MTYoMiAqIE1hdGgubWluKGosIG4gLSAxKSwgdHJ1ZSk7XG4gICAgY29uc3QgYiA9IHZpZXcuZ2V0SW50MTYoMiAqIE1hdGgubWluKGogKyAxLCBuIC0gMSksIHRydWUpO1xuICAgIG91dFtpXSA9IChhICsgKGIgLSBhKSAqICh4IC0gaikpIC8gMzI3Njg7XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBNaWNPcHRpb25zIHsgZWNob0NhbmNlbGxhdGlvbjogYm9vbGVhbjsgbm9pc2VTdXBwcmVzc2lvbjogYm9vbGVhbjsgYXV0b0dhaW5Db250cm9sOiBib29sZWFuIH1cblxuZXhwb3J0IGNsYXNzIENhbGxBdWRpbyB7XG4gIHByaXZhdGUgY29udGV4dDogQXVkaW9Db250ZXh0IHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgcGxheWJhY2s6IEF1ZGlvV29ya2xldE5vZGUgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBjYXB0dXJlOiBBdWRpb1dvcmtsZXROb2RlIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgc3RyZWFtOiBNZWRpYVN0cmVhbSB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIHNvdXJjZTogTWVkaWFTdHJlYW1BdWRpb1NvdXJjZU5vZGUgfCBudWxsID0gbnVsbDtcbiAgLyoqIFNlY29uZHMgb2Ygc3BlZWNoIHF1ZXVlZCwgYXMgdGhlIHdvcmtsZXQgbGFzdCBzYWlkLiAqL1xuICBxdWV1ZWQgPSAwO1xuICAvKiogVGhlIG1pY3JvcGhvbmUncyBsZXZlbCwgUk1TIG9mIHRoZSBsYXN0IGZyYW1lICgwIHRvIDEpLiAqL1xuICBsZXZlbCA9IDA7XG5cbiAgYXN5bmMgb3BlbigpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAodGhpcy5jb250ZXh0KSB7IGlmICh0aGlzLmNvbnRleHQuc3RhdGUgPT09IFwic3VzcGVuZGVkXCIpIGF3YWl0IHRoaXMuY29udGV4dC5yZXN1bWUoKTsgcmV0dXJuOyB9XG4gICAgdGhpcy5jb250ZXh0ID0gbmV3IEF1ZGlvQ29udGV4dCh7IGxhdGVuY3lIaW50OiBcImludGVyYWN0aXZlXCIgfSk7XG4gICAgY29uc3QgdXJsID0gVVJMLmNyZWF0ZU9iamVjdFVSTChuZXcgQmxvYihbV09SS0xFVFNdLCB7IHR5cGU6IFwidGV4dC9qYXZhc2NyaXB0XCIgfSkpO1xuICAgIGF3YWl0IHRoaXMuY29udGV4dC5hdWRpb1dvcmtsZXQuYWRkTW9kdWxlKHVybCk7XG4gICAgdGhpcy5wbGF5YmFjayA9IG5ldyBBdWRpb1dvcmtsZXROb2RlKHRoaXMuY29udGV4dCwgXCJwbGF5YmFja1wiLCB7IG51bWJlck9mSW5wdXRzOiAwLCBvdXRwdXRDaGFubmVsQ291bnQ6IFsyXSB9KTtcbiAgICB0aGlzLnBsYXliYWNrLnBvcnQub25tZXNzYWdlID0gKGUpID0+IHsgdGhpcy5xdWV1ZWQgPSBlLmRhdGEucXVldWVkOyB9O1xuICAgIHRoaXMucGxheWJhY2suY29ubmVjdCh0aGlzLmNvbnRleHQuZGVzdGluYXRpb24pO1xuICB9XG5cbiAgLyoqIFNlY29uZHMgZnJvbSBhIHNhbXBsZSBsZWF2aW5nIHRoZSB3b3JrbGV0IHRvIHRoZSBzcGVha2VyLCBhcyB0aGUgYnJvd3NlciByZWNrb25zIGl0LiAqL1xuICBnZXQgb3V0cHV0TGF0ZW5jeSgpOiBudW1iZXIgfCBudWxsIHtcbiAgICBpZiAoIXRoaXMuY29udGV4dCkgcmV0dXJuIG51bGw7XG4gICAgcmV0dXJuIHRoaXMuY29udGV4dC5iYXNlTGF0ZW5jeSArICgodGhpcy5jb250ZXh0IGFzIEF1ZGlvQ29udGV4dCAmIHsgb3V0cHV0TGF0ZW5jeT86IG51bWJlciB9KS5vdXRwdXRMYXRlbmN5ID8/IDApO1xuICB9XG5cbiAgYXN5bmMgc3RhcnRNaWMob25GcmFtZTogKHBjbTY0OiBzdHJpbmcsIGxldmVsOiBudW1iZXIpID0+IHZvaWQsIG9wdGlvbnM6IE1pY09wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBhd2FpdCB0aGlzLm9wZW4oKTtcbiAgICB0aGlzLnN0b3BNaWMoKTtcbiAgICBjb25zdCBjb250ZXh0ID0gdGhpcy5jb250ZXh0ITtcbiAgICB0aGlzLnN0cmVhbSA9IGF3YWl0IG5hdmlnYXRvci5tZWRpYURldmljZXMuZ2V0VXNlck1lZGlhKHsgYXVkaW86IHsgY2hhbm5lbENvdW50OiAxLCAuLi5vcHRpb25zIH0gfSk7XG4gICAgdGhpcy5zb3VyY2UgPSBjb250ZXh0LmNyZWF0ZU1lZGlhU3RyZWFtU291cmNlKHRoaXMuc3RyZWFtKTtcbiAgICB0aGlzLmNhcHR1cmUgPSBuZXcgQXVkaW9Xb3JrbGV0Tm9kZShjb250ZXh0LCBcImNhcHR1cmVcIiwgeyBudW1iZXJPZk91dHB1dHM6IDAgfSk7XG4gICAgdGhpcy5jYXB0dXJlLnBvcnQub25tZXNzYWdlID0gKGUpID0+IHtcbiAgICAgIGNvbnN0IGZyYW1lID0gbmV3IEludDE2QXJyYXkoZS5kYXRhIGFzIEFycmF5QnVmZmVyKTtcbiAgICAgIGxldCBzdW0gPSAwO1xuICAgICAgZm9yIChjb25zdCBzIG9mIGZyYW1lKSBzdW0gKz0gcyAqIHM7XG4gICAgICB0aGlzLmxldmVsID0gTWF0aC5zcXJ0KHN1bSAvIGZyYW1lLmxlbmd0aCkgLyAzMjc2ODtcbiAgICAgIG9uRnJhbWUoYnl0ZXNUb0Jhc2U2NChuZXcgVWludDhBcnJheShlLmRhdGEgYXMgQXJyYXlCdWZmZXIpKSwgdGhpcy5sZXZlbCk7XG4gICAgfTtcbiAgICB0aGlzLnNvdXJjZS5jb25uZWN0KHRoaXMuY2FwdHVyZSk7XG4gIH1cblxuICBzdG9wTWljKCk6IHZvaWQge1xuICAgIHRoaXMuc291cmNlPy5kaXNjb25uZWN0KCk7XG4gICAgdGhpcy5jYXB0dXJlPy5wb3J0LmNsb3NlKCk7XG4gICAgdGhpcy5zdHJlYW0/LmdldFRyYWNrcygpLmZvckVhY2goKHQpID0+IHQuc3RvcCgpKTtcbiAgICB0aGlzLnNvdXJjZSA9IG51bGw7XG4gICAgdGhpcy5jYXB0dXJlID0gbnVsbDtcbiAgICB0aGlzLnN0cmVhbSA9IG51bGw7XG4gIH1cblxuICBwbGF5KHBjbTY0OiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuY29udGV4dCB8fCAhdGhpcy5wbGF5YmFjaykgcmV0dXJuO1xuICAgIGNvbnN0IHNhbXBsZXMgPSB0b0Zsb2F0cyhiYXNlNjRUb0J5dGVzKHBjbTY0KSwgMjQwMDAsIHRoaXMuY29udGV4dC5zYW1wbGVSYXRlKTtcbiAgICB0aGlzLnBsYXliYWNrLnBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcInBsYXlcIiwgc2FtcGxlcyB9LCBbc2FtcGxlcy5idWZmZXJdKTtcbiAgfVxuXG4gIGN1ZShwY202NDogc3RyaW5nKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLmNvbnRleHQgfHwgIXRoaXMucGxheWJhY2spIHJldHVybjtcbiAgICBjb25zdCBzYW1wbGVzID0gdG9GbG9hdHMoYmFzZTY0VG9CeXRlcyhwY202NCksIDI0MDAwLCB0aGlzLmNvbnRleHQuc2FtcGxlUmF0ZSk7XG4gICAgdGhpcy5wbGF5YmFjay5wb3J0LnBvc3RNZXNzYWdlKHsgdHlwZTogXCJjdWVcIiwgc2FtcGxlcyB9LCBbc2FtcGxlcy5idWZmZXJdKTtcbiAgfVxuXG4gIGZsdXNoKCk6IHZvaWQge1xuICAgIHRoaXMucGxheWJhY2s/LnBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcImZsdXNoXCIgfSk7XG4gIH1cblxuICBzdG9wKCk6IHZvaWQge1xuICAgIHRoaXMuc3RvcE1pYygpO1xuICAgIHRoaXMucGxheWJhY2s/LnBvcnQucG9zdE1lc3NhZ2UoeyB0eXBlOiBcInN0b3BcIiB9KTtcbiAgfVxufVxuIiwgIi8vIFRoZSByZXBsYXkgdmlldzogYSByZWNvcmRlZCBjYWxsIChhIHRyYWNlIGZyb20gYW55IGhvc3QsIG9yIGEgc2NlbmFyaW8pIHJ1biBhZ2FpbiB0aHJvdWdoIHRoZVxuLy8gY29yZSwgYXMgdGhlIGJ1aWxkIHRoYXQgcmVjb3JkZWQgaXQgZGlkIGFuZCBhcyB0aGUgbGF0ZXN0IGRvZXMsIHNpZGUgYnkgc2lkZS4gV2hlcmUgdGhleSBwYXJ0XG4vLyBpcyB3aGVyZSBhIGNoYW5nZSBpbiBzcmMvIGNoYW5nZWQgd2hhdCB0aGUgY2FsbCBkb2VzIHdpdGggdGhlIHNhbWUgd29yZHMgYW5kIHRoZSBzYW1lIG1vZGVsLlxuXG5pbnRlcmZhY2UgQ29yZSB7XG4gIHZlcnNpb246IHN0cmluZztcbiAgY3JlYXRlKGNvbmZpZzogc3RyaW5nLCB0OiBudW1iZXIpOiBzdHJpbmc7XG4gIHB1c2goaWQ6IG51bWJlciwgZXZlbnQ6IHN0cmluZyk6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFJlY29yZGluZyB7IHZlcnNpb24/OiBzdHJpbmc7IGNvbmZpZzogdW5rbm93bjsgc3RhcnQ6IG51bWJlcjsgZXZlbnRzOiBSZWNvcmQ8c3RyaW5nLCBhbnk+W10gfVxuXG4vKiogV2hhdCBhIGNvbW1hbmQgb3IgZXZlbnQgbG9va3MgbGlrZSBpbiBhIHRpbWVsaW5lOiBhdWRpbyBjdXQgb3V0LCBvbmUgbGluZS4gKi9cbmZ1bmN0aW9uIGxpbmUobzogUmVjb3JkPHN0cmluZywgYW55Pik6IHN0cmluZyB7XG4gIGNvbnN0IHRleHQgPSBKU09OLnN0cmluZ2lmeShvKS5yZXBsYWNlKC9cIihkYXRhfHBjbSlcIjpcIltBLVphLXowLTkrLz1dezQwLH1cIi9nLCAnXCIkMVwiOlwiXHUyMDI2XCInKVxuICAgIC5yZXBsYWNlKC9cXFxcXCJkYXRhXFxcXFwiOlxcXFxcIltBLVphLXowLTkrLz1dezQwLH1cXFxcXCIvZywgJ1xcXFxcImRhdGFcXFxcXCI6XFxcXFwiXHUyMDI2XFxcXFwiJyk7XG4gIHJldHVybiB0ZXh0Lmxlbmd0aCA+IDQwMCA/IHRleHQuc2xpY2UoMCwgNDAwKSArIFwiXHUyMDI2XCIgOiB0ZXh0O1xufVxuXG4vKiogQXVkaW8gYW5kIHRpY2tzIHNheSBub3RoaW5nIGEgcmVhZGVyIG5lZWRzOyB0aGUgcmVzdCBkb2VzLiAqL1xuZnVuY3Rpb24gdGVsbGluZyhvOiBSZWNvcmQ8c3RyaW5nLCBhbnk+KTogYm9vbGVhbiB7XG4gIGlmIChvLnR5cGUgPT09IFwibWljXCIgfHwgby50eXBlID09PSBcInRpY2tcIiB8fCBvLnR5cGUgPT09IFwicGxheVwiKSByZXR1cm4gZmFsc2U7XG4gIGlmIChvLnR5cGUgPT09IFwid3Muc2VuZFwiICYmIFN0cmluZyhvLmRhdGEpLnN0YXJ0c1dpdGgoJ3tcInJlYWx0aW1lSW5wdXRcIjp7XCJhdWRpb1wiJykpIHJldHVybiBmYWxzZTtcbiAgaWYgKG8udHlwZSA9PT0gXCJ3cy5tZXNzYWdlXCIgJiYgU3RyaW5nKG8uZGF0YSkuaW5jbHVkZXMoJ1wiaW5saW5lRGF0YVwiJykgJiYgIVN0cmluZyhvLmRhdGEpLmluY2x1ZGVzKCdcInR1cm5Db21wbGV0ZVwiJykpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmZ1bmN0aW9uIHJ1bihjb3JlOiBDb3JlLCByOiBSZWNvcmRpbmcpOiBzdHJpbmdbXVtdIHtcbiAgY29uc3QgY3JlYXRlZCA9IEpTT04ucGFyc2UoY29yZS5jcmVhdGUoSlNPTi5zdHJpbmdpZnkoci5jb25maWcpLCByLnN0YXJ0KSk7XG4gIGNvbnN0IG91dDogc3RyaW5nW11bXSA9IFtjcmVhdGVkLmNvbW1hbmRzLmZpbHRlcih0ZWxsaW5nKS5tYXAobGluZSldO1xuICBmb3IgKGNvbnN0IGUgb2Ygci5ldmVudHMpIG91dC5wdXNoKChKU09OLnBhcnNlKGNvcmUucHVzaChjcmVhdGVkLmlkLCBKU09OLnN0cmluZ2lmeShlKSkpIGFzIFJlY29yZDxzdHJpbmcsIGFueT5bXSkuZmlsdGVyKHRlbGxpbmcpLm1hcChsaW5lKSk7XG4gIHJldHVybiBvdXQ7XG59XG5cbmV4cG9ydCBjbGFzcyBSZXBsYXkge1xuICBwcml2YXRlIHJlYWRvbmx5IHJvb3Q6IEhUTUxFbGVtZW50O1xuICBwcml2YXRlIHJlYWRvbmx5IGxvYWQ6ICh1cmw/OiBzdHJpbmcpID0+IFByb21pc2U8Q29yZT47XG5cbiAgY29uc3RydWN0b3Iocm9vdDogSFRNTEVsZW1lbnQsIGxvYWQ6ICh1cmw/OiBzdHJpbmcpID0+IFByb21pc2U8Q29yZT4pIHtcbiAgICB0aGlzLnJvb3QgPSByb290O1xuICAgIHRoaXMubG9hZCA9IGxvYWQ7XG4gICAgcm9vdC5pbm5lckhUTUwgPSBgXG4gICAgICA8ZGl2IGNsYXNzPVwiYmFyXCI+PHNlbGVjdCBjbGFzcz1cInBpY2tcIj48L3NlbGVjdD48YnV0dG9uIGNsYXNzPVwicmVmcmVzaFwiPlx1MjFCQjwvYnV0dG9uPjxidXR0b24gY2xhc3M9XCJnb1wiPlJlcGxheTwvYnV0dG9uPlxuICAgICAgPGxhYmVsPjxpbnB1dCB0eXBlPVwiY2hlY2tib3hcIiBjbGFzcz1cImFsbFwiPiBzaG93IGF1ZGlvIGFuZCB0aWNrczwvbGFiZWw+PHNwYW4gY2xhc3M9XCJzdW1tYXJ5XCI+PC9zcGFuPjwvZGl2PlxuICAgICAgPGRpdiBjbGFzcz1cInRpbWVsaW5lXCI+PC9kaXY+YDtcbiAgICAocm9vdC5xdWVyeVNlbGVjdG9yKFwiLnJlZnJlc2hcIikgYXMgSFRNTEVsZW1lbnQpLm9uY2xpY2sgPSAoKSA9PiB2b2lkIHRoaXMubGlzdCgpO1xuICAgIChyb290LnF1ZXJ5U2VsZWN0b3IoXCIuZ29cIikgYXMgSFRNTEVsZW1lbnQpLm9uY2xpY2sgPSAoKSA9PiB2b2lkIHRoaXMucmVwbGF5KCkuY2F0Y2goKGVycikgPT4gdGhpcy5zYXkoYFJlcGxheSBmYWlsZWQ6ICR7ZXJyLm1lc3NhZ2V9YCkpO1xuICAgIHZvaWQgdGhpcy5saXN0KCk7XG4gIH1cblxuICBwcml2YXRlIHNheSh0ZXh0OiBzdHJpbmcpIHtcbiAgICAodGhpcy5yb290LnF1ZXJ5U2VsZWN0b3IoXCIuc3VtbWFyeVwiKSBhcyBIVE1MRWxlbWVudCkudGV4dENvbnRlbnQgPSB0ZXh0O1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBsaXN0KCkge1xuICAgIGNvbnN0IHBpY2sgPSB0aGlzLnJvb3QucXVlcnlTZWxlY3RvcihcIi5waWNrXCIpIGFzIEhUTUxTZWxlY3RFbGVtZW50O1xuICAgIHBpY2suaW5uZXJIVE1MID0gXCJcIjtcbiAgICBjb25zdCB0cmFjZXM6IHsgbmFtZTogc3RyaW5nOyBieXRlczogbnVtYmVyIH1bXSA9IGF3YWl0IChhd2FpdCBmZXRjaChcIi90cmFjZXNcIikpLmpzb24oKTtcbiAgICBjb25zdCBzY2VuYXJpb3M6IHN0cmluZ1tdID0gYXdhaXQgKGF3YWl0IGZldGNoKFwiL3NjZW5hcmlvc1wiKSkuanNvbigpO1xuICAgIGNvbnN0IHRyYWNlR3JvdXAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwib3B0Z3JvdXBcIik7XG4gICAgdHJhY2VHcm91cC5sYWJlbCA9IFwiUmVjb3JkZWQgY2FsbHNcIjtcbiAgICBmb3IgKGNvbnN0IHQgb2YgdHJhY2VzKSB0cmFjZUdyb3VwLmFwcGVuZChuZXcgT3B0aW9uKGAke3QubmFtZX0gKCR7TWF0aC5yb3VuZCh0LmJ5dGVzIC8gMTAyNCl9IEtCKWAsIGAvdHJhY2VzLyR7dC5uYW1lfWApKTtcbiAgICBjb25zdCBzY2VuYXJpb0dyb3VwID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcIm9wdGdyb3VwXCIpO1xuICAgIHNjZW5hcmlvR3JvdXAubGFiZWwgPSBcIlNjZW5hcmlvc1wiO1xuICAgIGZvciAoY29uc3QgcyBvZiBzY2VuYXJpb3MpIHNjZW5hcmlvR3JvdXAuYXBwZW5kKG5ldyBPcHRpb24ocywgYC9zY2VuYXJpb3MvJHtzfS5qc29uYCkpO1xuICAgIHBpY2suYXBwZW5kKHRyYWNlR3JvdXAsIHNjZW5hcmlvR3JvdXApO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyByZWNvcmRpbmcodXJsOiBzdHJpbmcpOiBQcm9taXNlPFJlY29yZGluZz4ge1xuICAgIGNvbnN0IHRleHQgPSBhd2FpdCAoYXdhaXQgZmV0Y2godXJsLCB7IGNhY2hlOiBcIm5vLXN0b3JlXCIgfSkpLnRleHQoKTtcbiAgICBpZiAodXJsLmVuZHNXaXRoKFwiLmpzb25cIikpIHJldHVybiBKU09OLnBhcnNlKHRleHQpO1xuICAgIGNvbnN0IFtoZWFkZXIsIC4uLmV2ZW50c10gPSB0ZXh0LnRyaW0oKS5zcGxpdChcIlxcblwiKS5tYXAoKGwpID0+IEpTT04ucGFyc2UobCkpO1xuICAgIHJldHVybiB7IC4uLmhlYWRlciwgZXZlbnRzIH07XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHJlcGxheSgpIHtcbiAgICBjb25zdCB1cmwgPSAodGhpcy5yb290LnF1ZXJ5U2VsZWN0b3IoXCIucGlja1wiKSBhcyBIVE1MU2VsZWN0RWxlbWVudCkudmFsdWU7XG4gICAgaWYgKCF1cmwpIHJldHVybjtcbiAgICBjb25zdCByID0gYXdhaXQgdGhpcy5yZWNvcmRpbmcodXJsKTtcbiAgICBjb25zdCBsYXRlc3QgPSBhd2FpdCB0aGlzLmxvYWQoKTtcbiAgICBsZXQgcmVjb3JkZWQ6IENvcmUgfCBudWxsID0gbnVsbDtcbiAgICBpZiAoci52ZXJzaW9uICYmIHIudmVyc2lvbiAhPT0gbGF0ZXN0LnZlcnNpb24pIHtcbiAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goYC92ZXJzaW9ucy8ke3IudmVyc2lvbn0uanNgLCB7IG1ldGhvZDogXCJIRUFEXCIgfSk7XG4gICAgICBpZiAocmVzcG9uc2Uub2spIHJlY29yZGVkID0gYXdhaXQgdGhpcy5sb2FkKGAvdmVyc2lvbnMvJHtyLnZlcnNpb259LmpzYCk7XG4gICAgfVxuICAgIGNvbnN0IG5vdyA9IHJ1bihsYXRlc3QsIHIpO1xuICAgIGNvbnN0IHRoZW4gPSByZWNvcmRlZCA/IHJ1bihyZWNvcmRlZCwgcikgOiBudWxsO1xuICAgIGNvbnN0IGFsbCA9ICh0aGlzLnJvb3QucXVlcnlTZWxlY3RvcihcIi5hbGxcIikgYXMgSFRNTElucHV0RWxlbWVudCkuY2hlY2tlZDtcbiAgICBjb25zdCB0aW1lbGluZSA9IHRoaXMucm9vdC5xdWVyeVNlbGVjdG9yKFwiLnRpbWVsaW5lXCIpIGFzIEhUTUxFbGVtZW50O1xuICAgIHRpbWVsaW5lLmlubmVySFRNTCA9IFwiXCI7XG4gICAgbGV0IGZpcnN0ID0gLTE7XG4gICAgbGV0IGRpZmZlciA9IDA7XG4gICAgY29uc3Qgcm93czogSFRNTEVsZW1lbnRbXSA9IFtdO1xuICAgIGNvbnN0IGFkZCA9IChjbHM6IHN0cmluZywgdDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpID0+IHtcbiAgICAgIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICByb3cuY2xhc3NOYW1lID0gYHJvdyAke2Nsc31gO1xuICAgICAgcm93LmlubmVySFRNTCA9IGA8c3BhbiBjbGFzcz1cInRcIj4ke3R9PC9zcGFuPmA7XG4gICAgICBjb25zdCBiID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gICAgICBiLmNsYXNzTmFtZSA9IFwiYlwiO1xuICAgICAgYi50ZXh0Q29udGVudCA9IHRleHQ7XG4gICAgICByb3cuYXBwZW5kKGIpO1xuICAgICAgdGltZWxpbmUuYXBwZW5kKHJvdyk7XG4gICAgICByb3dzLnB1c2gocm93KTtcbiAgICAgIHJldHVybiByb3c7XG4gICAgfTtcbiAgICBjb25zdCB0MCA9IHIuc3RhcnQ7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPD0gci5ldmVudHMubGVuZ3RoOyBpKyspIHtcbiAgICAgIGNvbnN0IGUgPSBpID09PSAwID8gbnVsbCA6IHIuZXZlbnRzW2kgLSAxXTtcbiAgICAgIGNvbnN0IG5vd091dCA9IG5vd1tpXTtcbiAgICAgIGNvbnN0IHRoZW5PdXQgPSB0aGVuID8gdGhlbltpXSA6IG5vd091dDtcbiAgICAgIGNvbnN0IHNhbWUgPSBub3dPdXQubGVuZ3RoID09PSB0aGVuT3V0Lmxlbmd0aCAmJiBub3dPdXQuZXZlcnkoKGMsIGopID0+IGMgPT09IHRoZW5PdXRbal0pO1xuICAgICAgaWYgKCFzYW1lKSB7IGRpZmZlcisrOyBpZiAoZmlyc3QgPCAwKSBmaXJzdCA9IGk7IH1cbiAgICAgIGlmICghc2FtZSB8fCBhbGwgfHwgKGUgJiYgdGVsbGluZyhlKSkgfHwgbm93T3V0Lmxlbmd0aCA+IDApIHtcbiAgICAgICAgaWYgKGUgJiYgKGFsbCB8fCB0ZWxsaW5nKGUpIHx8ICFzYW1lKSkgYWRkKFwiaW5cIiwgKGUudCAtIHQwKS50b0ZpeGVkKDIpLCBsaW5lKGUpKTtcbiAgICAgICAgY29uc3QgdCA9IGUgPyAoZS50IC0gdDApLnRvRml4ZWQoMikgOiBcIjAuMDBcIjtcbiAgICAgICAgaWYgKHNhbWUpIGZvciAoY29uc3QgYyBvZiBub3dPdXQpIGFkZChcIm91dFwiLCB0LCBjKTtcbiAgICAgICAgZWxzZSB7XG4gICAgICAgICAgZm9yIChjb25zdCBjIG9mIHRoZW5PdXQpIGFkZChcIm91dCBnb25lXCIsIHQsIGBcdTIyMTIgJHtjfWApO1xuICAgICAgICAgIGZvciAoY29uc3QgYyBvZiBub3dPdXQpIGFkZChcIm91dCBuZXdcIiwgdCwgYCsgJHtjfWApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IHZlcnNpb25zID0gdGhlbiA/IGByZWNvcmRlZCBieSAke3IudmVyc2lvbn0sIHJlcGxheWVkIGJ5IGl0IGFuZCBieSAke2xhdGVzdC52ZXJzaW9ufWAgOiBgcmVwbGF5ZWQgYnkgJHtsYXRlc3QudmVyc2lvbn1gICtcbiAgICAgIChyLnZlcnNpb24gJiYgci52ZXJzaW9uICE9PSBsYXRlc3QudmVyc2lvbiA/IGAgKHRoZSByZWNvcmRpbmcncyBidWlsZCAke3IudmVyc2lvbn0gaXNuJ3Qga2VwdCBoZXJlKWAgOiBcIlwiKTtcbiAgICB0aGlzLnNheShgJHtyLmV2ZW50cy5sZW5ndGh9IGV2ZW50cywgJHt2ZXJzaW9uc30uIGAgKyAodGhlbiA/IChkaWZmZXIgPyBgJHtkaWZmZXJ9IGV2ZW50cyBhbnN3ZXJlZCBkaWZmZXJlbnRseSwgdGhlIGZpcnN0IGF0IGV2ZW50ICR7Zmlyc3R9LmAgOiBcIkJvdGggYW5zd2VyZWQgZXZlcnkgZXZlbnQgdGhlIHNhbWUuXCIpIDogXCJcIikpO1xuICAgIGlmIChmaXJzdCA+PSAwKSB0aW1lbGluZS5xdWVyeVNlbGVjdG9yKFwiLmdvbmUsIC5uZXdcIik/LnNjcm9sbEludG9WaWV3KHsgYmxvY2s6IFwiY2VudGVyXCIgfSk7XG4gIH1cbn1cbiIsICIvLyBUaGUgd2ViIHN1cmZhY2U6IGEgZm91cnRoIGhvc3QgZm9yIHRoZSB2b2ljZSBjb3JlLCBhbmQgYSBwaG9uZS1mcmllbmRseSB3YXkgdG8gdXNlIGl0IGZvciB3b3JrLlxuLy8gSXQgbG9hZHMgdGhlIGRldiBzZXJ2ZXIncyBsYXRlc3QgYnVpbGQgYXQgZWFjaCBjYWxsLCBzbyBhbiBlZGl0IGluIHNyYy8gaXMgbGl2ZSBvbiB0aGUgbmV4dFxuLy8gY2FsbCwgYW5kIGtlZXBzIGV2ZXJ5IGNhbGwgYXMgYSB0cmFjZSB0aGUgcmVwbGF5IHZpZXcgKGFuZCBhbnkgb3RoZXIgaG9zdCkgY2FuIHJ1biBhZ2Fpbi5cbi8vXG4vLyBUaGUgaG9zdCdzIHBhcnQgaXMgc21hbGw6IHRoZSBtaWNyb3Bob25lIGFuZCBzcGVha2VyIChhdWRpby50cyksIHRoZSBtb2RlbCdzIHNvY2tldCB0aHJvdWdoIHRoZVxuLy8gc2VydmVyJ3MgcmVsYXksIEhlcm1lcyBhbmQgVDMgdGhyb3VnaCB0aGUgc2VydmVyLCBhbmQgdGhlIHNjcmVlbi4gVGhlIGNvcmUgZGVjaWRlcyB0aGUgcmVzdC5cblxuaW1wb3J0IHsgY29tbWFuZEluIH0gZnJvbSBcIi4uL3NyYy9jb21tYW5kcy50c1wiO1xuaW1wb3J0IHsgQ2FsbEF1ZGlvIH0gZnJvbSBcIi4vYXVkaW8udHNcIjtcbmltcG9ydCB7IFJlcGxheSB9IGZyb20gXCIuL3JlcGxheS50c1wiO1xuXG5pbnRlcmZhY2UgQ29yZSB7XG4gIHZlcnNpb246IHN0cmluZztcbiAgZGVmYXVsdHMoKTogc3RyaW5nO1xuICBjcmVhdGUoY29uZmlnOiBzdHJpbmcsIHQ6IG51bWJlcik6IHN0cmluZztcbiAgcHVzaChpZDogbnVtYmVyLCBldmVudDogc3RyaW5nKTogc3RyaW5nO1xuICB0cmFjZShpZDogbnVtYmVyKTogc3RyaW5nO1xuICBkaXNwb3NlKGlkOiBudW1iZXIpOiB2b2lkO1xufVxudHlwZSBDb21tYW5kID0gUmVjb3JkPHN0cmluZywgYW55PiAmIHsgdHlwZTogc3RyaW5nIH07XG5pbnRlcmZhY2UgU2VydmVyQ29uZmlnIHsgcm91dGU6IHN0cmluZzsgbW9kZWw6IHN0cmluZzsgdmVyc2lvbjogc3RyaW5nOyBoZXJtZXM6IGJvb2xlYW47IHQzOiBzdHJpbmdbXSB8IG51bGwgfVxuXG5jb25zdCAkID0gPFQgZXh0ZW5kcyBIVE1MRWxlbWVudCA9IEhUTUxFbGVtZW50PihpZDogc3RyaW5nKSA9PiBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChpZCkgYXMgVDtcbmNvbnN0IG5vdyA9ICgpID0+IHBlcmZvcm1hbmNlLm5vdygpIC8gMTAwMDtcbmNvbnN0IGNoZWNrZWQgPSAoaWQ6IHN0cmluZykgPT4gJDxIVE1MSW5wdXRFbGVtZW50PihpZCkuY2hlY2tlZDtcblxuLyoqIFRoZSBsYXRlc3QgYnVpbGQgZnJvbSB0aGUgZGV2IHNlcnZlciwgZXZhbHVhdGVkIGFmcmVzaDogYW4gZWRpdCBpbiBzcmMvIGlzIGluIHRoZSBuZXh0IGNhbGwuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbG9hZENvcmUodXJsID0gXCIvdm9pY2UtY29yZS5qc1wiKTogUHJvbWlzZTxDb3JlPiB7XG4gIGNvbnN0IHNvdXJjZSA9IGF3YWl0IChhd2FpdCBmZXRjaCh1cmwsIHsgY2FjaGU6IFwibm8tc3RvcmVcIiB9KSkudGV4dCgpO1xuICBjb25zdCBzY29wZTogeyBWb2ljZUNvcmU/OiBDb3JlIH0gPSB7fTtcbiAgbmV3IEZ1bmN0aW9uKFwiZ2xvYmFsVGhpc1wiLCBzb3VyY2UpKHNjb3BlKTtcbiAgaWYgKCFzY29wZS5Wb2ljZUNvcmUpIHRocm93IG5ldyBFcnJvcihcInRoZSBidW5kbGUgZGlkbid0IGRlZmluZSBWb2ljZUNvcmVcIik7XG4gIHJldHVybiBzY29wZS5Wb2ljZUNvcmU7XG59XG5cbi8vIFByZXNldHM6IGVhY2ggc3VyZmFjZSdzIHNldHRpbmdzIGFzIGl0cyBhcHAgd291bGQgc2V0IHRoZW0uXG5cbmNvbnN0IEZBS0VfVFYgPSBbXG4gIHsgbmFtZTogXCJ0dl92b2x1bWVcIiwgZGVzY3JpcHRpb246IFwiU2V0cyB0aGUgbGl2aW5nLXJvb20gVFYncyB2b2x1bWUsIDAgdG8gMTAwLlwiLCBwYXJhbWV0ZXJzOiB7IHR5cGU6IFwiT0JKRUNUXCIsIHByb3BlcnRpZXM6IHsgbGV2ZWw6IHsgdHlwZTogXCJJTlRFR0VSXCIgfSB9LCByZXF1aXJlZDogW1wibGV2ZWxcIl0gfSB9LFxuICB7IG5hbWU6IFwidHZfcGF1c2VcIiwgZGVzY3JpcHRpb246IFwiUGF1c2VzIG9yIHJlc3VtZXMgd2hhdCdzIHBsYXlpbmcgb24gdGhlIFRWLlwiLCBwYXJhbWV0ZXJzOiB7IHR5cGU6IFwiT0JKRUNUXCIsIHByb3BlcnRpZXM6IHsgcGF1c2U6IHsgdHlwZTogXCJCT09MRUFOXCIgfSB9IH0gfSxcbl07XG5cbmNvbnN0IFBSRVNFVFM6IFJlY29yZDxzdHJpbmcsIFJlY29yZDxzdHJpbmcsIHVua25vd24+PiA9IHtcbiAgd2ViOiB7IHBsYXRmb3JtOiBcIndlYlwiLCBkZXZpY2U6IFwiYnJvd3NlclwiLCBzdGFuZGJ5QWZ0ZXI6IDMwLCBoYW5nVXBBZnRlcjogMzAwLCB2b2NhYnVsYXJ5OiBbXCJIZXJtZXNcIiwgXCJCZW50b1wiLCBcIldvb2Rob3VzZVwiLCBcIlQzXCJdIH0sXG4gIGFuZHJvaWQ6IHsgcGxhdGZvcm06IFwiQW5kcm9pZFwiLCBkZXZpY2U6IFwicGhvbmVcIiwgc3RhbmRieUFmdGVyOiAyMCB9LFxuICBcImFuZHJvaWQgd2FrZSB3b3JkXCI6IHsgcGxhdGZvcm06IFwiQW5kcm9pZFwiLCBkZXZpY2U6IFwicGhvbmVcIiwgc3RhbmRieUFmdGVyOiAyMCwgaGFuZ1VwQWZ0ZXI6IDE1IH0sXG4gIG1hY29zOiB7IHBsYXRmb3JtOiBcIm1hY09TXCIsIGRldmljZTogXCJNYWNcIiwgc3RhbmRieUFmdGVyOiAyMCB9LFxuICBlY2hvOiB7XG4gICAgcGxhdGZvcm06IFwiRWNob1wiLCBkZXZpY2U6IFwic3BlYWtlclwiLCBoYW5nVXBBZnRlcjogNiwgc3RhbmRieUFmdGVyOiA4LCBlYXJjb25zOiB0cnVlLCB2b2NhYnVsYXJ5OiBbXCJIZXJtZXNcIiwgXCJCZW50b1wiLCBcIldvb2Rob3VzZVwiXSxcbiAgICBtaWM6IHsgd2hpbGVTcGVha2luZzogXCJ3YWtlXCIsIGdhaW5EYjogMCB9LCBob3N0VG9vbHM6IEZBS0VfVFYsXG4gIH0sXG59O1xuXG4vLyBTdGF0ZS5cblxuY29uc3QgYXVkaW8gPSBuZXcgQ2FsbEF1ZGlvKCk7XG5sZXQgc2VydmVyOiBTZXJ2ZXJDb25maWc7XG5sZXQgY29yZTogQ29yZSB8IG51bGwgPSBudWxsO1xubGV0IGNhbGxJZCA9IDA7XG5sZXQgY2FsbE5hbWUgPSBcIlwiO1xubGV0IHRpY2tlciA9IDA7XG5sZXQgdHJhY2VUaW1lciA9IDA7XG5sZXQgc3RhcnRlZEF0ID0gbm93KCk7XG5jb25zdCBzb2NrZXRzID0gbmV3IE1hcDxudW1iZXIsIFdlYlNvY2tldD4oKTtcbmNvbnN0IHJ1bnMgPSBuZXcgTWFwPHN0cmluZywgeyBhYm9ydDogQWJvcnRDb250cm9sbGVyOyBhZ2VudDogc3RyaW5nOyB0YXNrSWQ6IHN0cmluZyB9PigpO1xuaW50ZXJmYWNlIFRhc2tWaWV3IHsgYzogQ29tbWFuZDsgc2luY2U6IG51bWJlcjsgZW5kZWQ6IG51bWJlciB8IG51bGw7IHRocmVhZD86IHN0cmluZzsgcmVzdWx0PzogSFRNTEVsZW1lbnQ7IGFwcHJvdmFsPzogeyBjb21tYW5kOiBzdHJpbmcgfSB9XG5jb25zdCB0YXNrcyA9IG5ldyBNYXA8c3RyaW5nLCBUYXNrVmlldz4oKTtcbmxldCBjb3VudHMgPSB7IG1pYzogMCwgcGxheTogMCwgc2VudDogMCB9O1xubGV0IGZha2VUdkxldmVsID0gMTU7XG5sZXQgY29yZVN0YXR1cyA9IFwiaWRsZVwiO1xubGV0IG11dGVkID0gZmFsc2U7XG5sZXQgaG9sZGluZyA9IGZhbHNlO1xubGV0IHdha2VMb2NrOiB7IHJlbGVhc2UoKTogUHJvbWlzZTx2b2lkPiB9IHwgbnVsbCA9IG51bGw7XG5cbi8vIFRoZSBjb252ZXJzYXRpb24sIGtlcHQgc28gYSBuZXcgY2FsbCBjYW4gY2Fycnkgb24gZnJvbSBpdCAodGhlIGNvcmUncyBgaGlzdG9yeWAsIHJlY2FwcGVkIHRvIHRoZSBtb2RlbCkuXG5pbnRlcmZhY2UgQ2hhdExpbmUgeyByb2xlOiBcInVzZXJcIiB8IFwiYXNzaXN0YW50XCI7IHNwZWFrZXI/OiBzdHJpbmc7IHRleHQ6IHN0cmluZyB9XG5jb25zdCBISVNUT1JZID0gXCJ2b2ljZS5oaXN0b3J5XCI7XG5jb25zdCBISVNUT1JZX01BWF9BR0UgPSAxMiAqIDM2MDAgKiAxMDAwO1xubGV0IGNoYXQ6IENoYXRMaW5lW10gPSBbXTtcbmxldCBsYXN0Um9sZSA9IFwiXCI7XG5cbmZ1bmN0aW9uIHJlbWVtYmVyKHJvbGU6IFwidXNlclwiIHwgXCJhc3Npc3RhbnRcIiwgdGV4dDogc3RyaW5nLCBzcGVha2VyPzogc3RyaW5nLCBqb2luID0gZmFsc2UpIHtcbiAgY29uc3QgbGFzdCA9IGNoYXQuYXQoLTEpO1xuICBpZiAoam9pbiAmJiBsYXN0ICYmIGxhc3Qucm9sZSA9PT0gcm9sZSAmJiBsYXN0LnNwZWFrZXIgPT09IHNwZWFrZXIpIGxhc3QudGV4dCArPSB0ZXh0O1xuICBlbHNlIGNoYXQucHVzaChzcGVha2VyID8geyByb2xlLCBzcGVha2VyLCB0ZXh0IH0gOiB7IHJvbGUsIHRleHQgfSk7XG4gIGlmIChjaGF0Lmxlbmd0aCA+IDIwMCkgY2hhdC5zcGxpY2UoMCwgY2hhdC5sZW5ndGggLSAyMDApO1xuICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShISVNUT1JZLCBKU09OLnN0cmluZ2lmeSh7IGF0OiBEYXRlLm5vdygpLCBjaGF0IH0pKTtcbn1cblxuZnVuY3Rpb24gc2F2ZWRIaXN0b3J5KCk6IENoYXRMaW5lW10ge1xuICB0cnkge1xuICAgIGNvbnN0IHNhdmVkID0gSlNPTi5wYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShISVNUT1JZKSA/PyBcIm51bGxcIik7XG4gICAgcmV0dXJuIHNhdmVkICYmIERhdGUubm93KCkgLSBzYXZlZC5hdCA8IEhJU1RPUllfTUFYX0FHRSAmJiBBcnJheS5pc0FycmF5KHNhdmVkLmNoYXQpID8gc2F2ZWQuY2hhdCA6IFtdO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gW107XG4gIH1cbn1cblxuLyoqIFR3byByaXNpbmcgbm90ZXM6IHNvbWV0aGluZyBvbiB0aGUgc2NyZWVuIG5lZWRzIHRoZSB1c2VyLiBQQ00xNiBhdCAyNCBrSHosIGJhc2U2NC4gKi9cbmNvbnN0IEFQUFJPVkFMX1RPTkUgPSAoKCkgPT4ge1xuICBjb25zdCByYXRlID0gMjQwMDAsIG91dCA9IG5ldyBJbnQxNkFycmF5KHJhdGUgKiAwLjMyKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBvdXQubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCB0ID0gaSAvIHJhdGUsIGYgPSB0IDwgMC4xNiA/IDY2MCA6IDg4MCwgbG9jYWwgPSB0IDwgMC4xNiA/IHQgOiB0IC0gMC4xNjtcbiAgICBvdXRbaV0gPSBNYXRoLnJvdW5kKE1hdGguc2luKDIgKiBNYXRoLlBJICogZiAqIHQpICogTWF0aC5taW4oMSwgbG9jYWwgKiA2MCwgKDAuMTYgLSBsb2NhbCkgKiA2MCkgKiA2MDAwKTtcbiAgfVxuICBsZXQgYmluID0gXCJcIjtcbiAgY29uc3QgYnl0ZXMgPSBuZXcgVWludDhBcnJheShvdXQuYnVmZmVyKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBieXRlcy5sZW5ndGg7IGkrKykgYmluICs9IFN0cmluZy5mcm9tQ2hhckNvZGUoYnl0ZXNbaV0pO1xuICByZXR1cm4gYnRvYShiaW4pO1xufSkoKTtcblxuLy8gTGF0ZW5jeTogdGhlIG5ldHdvcmsncyByb3VuZCB0cmlwLCBhbmQgaG93IGxvbmcgYWZ0ZXIgdGhlIHVzZXIgc3RvcHMgdGFsa2luZyB0aGUgcmVwbHkgc3RhcnRzLlxuY29uc3QgbWV0cmljcyA9IHsgcnR0OiBbXSBhcyBudW1iZXJbXSwgcmVwbHk6IFtdIGFzIG51bWJlcltdLCBsYXN0Vm9pY2U6IDAsIGxhc3RQbGF5OiAwLCByZXBsaWVkOiB0cnVlIH07XG5cbmZ1bmN0aW9uIG1lZGlhbih4czogbnVtYmVyW10pOiBudW1iZXIgfCBudWxsIHtcbiAgaWYgKHhzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHMgPSBbLi4ueHNdLnNvcnQoKGEsIGIpID0+IGEgLSBiKTtcbiAgcmV0dXJuIHNbTWF0aC5mbG9vcihzLmxlbmd0aCAvIDIpXTtcbn1cblxuZnVuY3Rpb24gc2hvd01ldHJpY3MoKSB7XG4gIGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBydHQgPSBtZWRpYW4obWV0cmljcy5ydHQpO1xuICBpZiAocnR0ICE9IG51bGwpIHBhcnRzLnB1c2goYG5ldHdvcmsgJHtNYXRoLnJvdW5kKHJ0dCAqIDEwMDApfSBtc2ApO1xuICBjb25zdCByZXBseSA9IG1lZGlhbihtZXRyaWNzLnJlcGx5KTtcbiAgaWYgKHJlcGx5ICE9IG51bGwpIHBhcnRzLnB1c2goYHJlcGx5ICR7bWV0cmljcy5yZXBseS5hdCgtMSkhLnRvRml4ZWQoMSl9IHMgKG1lZGlhbiAke3JlcGx5LnRvRml4ZWQoMSl9KWApO1xuICBjb25zdCBvdXQgPSBhdWRpby5vdXRwdXRMYXRlbmN5O1xuICBpZiAob3V0ICE9IG51bGwpIHBhcnRzLnB1c2goYGF1ZGlvICR7TWF0aC5yb3VuZChvdXQgKiAxMDAwKX0gbXNgKTtcbiAgbGV0IGJ1ZmZlcmVkID0gMDtcbiAgZm9yIChjb25zdCB3cyBvZiBzb2NrZXRzLnZhbHVlcygpKSBidWZmZXJlZCArPSB3cy5idWZmZXJlZEFtb3VudDtcbiAgaWYgKGJ1ZmZlcmVkID4gMzJfMDAwKSBwYXJ0cy5wdXNoKGB1cGxvYWQgYmVoaW5kICR7KGJ1ZmZlcmVkIC8gMzJfMDAwKS50b0ZpeGVkKDEpfSBzYCk7XG4gICQoXCJtZXRyaWNzXCIpLnRleHRDb250ZW50ID0gcGFydHMuam9pbihcIiBcdTAwQjcgXCIpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBwaW5nKCkge1xuICBjb25zdCB0ID0gbm93KCk7XG4gIHRyeSB7XG4gICAgYXdhaXQgZmV0Y2goXCIvcGluZ1wiLCB7IGNhY2hlOiBcIm5vLXN0b3JlXCIgfSk7XG4gICAgbWV0cmljcy5ydHQucHVzaChub3coKSAtIHQpO1xuICAgIGlmIChtZXRyaWNzLnJ0dC5sZW5ndGggPiAxMikgbWV0cmljcy5ydHQuc2hpZnQoKTtcbiAgfSBjYXRjaCB7fVxuICBzaG93TWV0cmljcygpO1xufVxuXG4vLyBUaGUgc2NyZWVuLlxuXG4vKiogQSBzeXN0ZW0gbm90aWZpY2F0aW9uIHdoaWxlIHRoZSBwYWdlIGlzIGhpZGRlbjogYSB0YXNrIGZpbmlzaGVkLCBvciBvbmUgbmVlZHMgdGhlIHVzZXIuICovXG5mdW5jdGlvbiBub3RpZnkodGl0bGU6IHN0cmluZywgYm9keTogc3RyaW5nKSB7XG4gIGlmICghZG9jdW1lbnQuaGlkZGVuIHx8ICEoXCJOb3RpZmljYXRpb25cIiBpbiB3aW5kb3cpIHx8IE5vdGlmaWNhdGlvbi5wZXJtaXNzaW9uICE9PSBcImdyYW50ZWRcIikgcmV0dXJuO1xuICB0cnkge1xuICAgIGNvbnN0IG4gPSBuZXcgTm90aWZpY2F0aW9uKHRpdGxlLCB7IGJvZHk6IGJvZHkuc2xpY2UoMCwgMTgwKSwgaWNvbjogXCIvd2ViL2ljb25zL2ljb24tMTkyLnBuZ1wiLCB0YWc6IHRpdGxlIH0pO1xuICAgIG4ub25jbGljayA9ICgpID0+IHsgd2luZG93LmZvY3VzKCk7IG4uY2xvc2UoKTsgfTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gUGhvbmVzIHdhbnQgbm90aWZpY2F0aW9ucyBmcm9tIGEgc2VydmljZSB3b3JrZXI7IHRoZSBwYWdlIGhhcyBub25lLlxuICB9XG59XG5cbmZ1bmN0aW9uIHRvYXN0KHRleHQ6IHN0cmluZykge1xuICBjb25zdCB0ID0gJChcInRvYXN0XCIpO1xuICB0LnRleHRDb250ZW50ID0gdGV4dDtcbiAgdC5jbGFzc0xpc3QuYWRkKFwib25cIik7XG4gIGNsZWFyVGltZW91dCgodG9hc3QgYXMgYW55KS50aW1lcik7XG4gICh0b2FzdCBhcyBhbnkpLnRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB0LmNsYXNzTGlzdC5yZW1vdmUoXCJvblwiKSwgMTgwMCk7XG59XG5cbmZ1bmN0aW9uIGxvZyhraW5kOiBzdHJpbmcsIHRleHQ6IHN0cmluZywgY2xzID0gXCJcIikge1xuICBjb25zdCBwYW5lID0gJChcImxvZ1wiKTtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IGByb3cgJHtjbHN9YDtcbiAgcm93LmlubmVySFRNTCA9IGA8c3BhbiBjbGFzcz1cInRcIj4keyhub3coKSAtIHN0YXJ0ZWRBdCkudG9GaXhlZCgyKX08L3NwYW4+PHNwYW4gY2xhc3M9XCJrXCI+JHtraW5kfTwvc3Bhbj5gO1xuICBjb25zdCBib2R5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGJvZHkuY2xhc3NOYW1lID0gXCJiXCI7XG4gIGJvZHkudGV4dENvbnRlbnQgPSB0ZXh0O1xuICByb3cuYXBwZW5kKGJvZHkpO1xuICBjb25zdCBzdGljayA9IHBhbmUuc2Nyb2xsVG9wICsgcGFuZS5jbGllbnRIZWlnaHQgPj0gcGFuZS5zY3JvbGxIZWlnaHQgLSAzMDtcbiAgcGFuZS5hcHBlbmQocm93KTtcbiAgd2hpbGUgKHBhbmUuY2hpbGRFbGVtZW50Q291bnQgPiAzMDAwKSBwYW5lLmZpcnN0RWxlbWVudENoaWxkIS5yZW1vdmUoKTtcbiAgaWYgKHN0aWNrKSBwYW5lLnNjcm9sbFRvcCA9IHBhbmUuc2Nyb2xsSGVpZ2h0O1xufVxuXG4vKiogQSBmcmFtZSBmcm9tIG9yIHRvIEdlbWluaSwgd2l0aCBhdWRpbyBjdXQgb3V0LCBzaG9ydCBlbm91Z2ggdG8gcmVhZC4gKi9cbmZ1bmN0aW9uIGJyaWVmKGRhdGE6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBkYXRhLnJlcGxhY2UoL1wiZGF0YVwiOlwiW0EtWmEtejAtOSsvPV17NDAsfVwiL2csIChtKSA9PiBgXCJkYXRhXCI6XCJcdTIwMjYke01hdGgucm91bmQoKChtLmxlbmd0aCAtIDkpICogMykgLyA0KX0gYnl0ZXNcImApLnNsaWNlKDAsIDYwMCk7XG59XG5cbmZ1bmN0aW9uIGVzY2FwZUh0bWwodGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHRleHQucmVwbGFjZSgvWyY8PlwiJ10vZywgKGMpID0+ICh7IFwiJlwiOiBcIiZhbXA7XCIsIFwiPFwiOiBcIiZsdDtcIiwgXCI+XCI6IFwiJmd0O1wiLCAnXCInOiBcIiZxdW90O1wiLCBcIidcIjogXCImIzM5O1wiIH0pW2NdISk7XG59XG5cbi8qKiBBIGxpdHRsZSBNYXJrZG93biwgc2FmZWx5OiBjb2RlLCBib2xkLCBsaW5rcywgbGlzdHMgYW5kIGhlYWRpbmdzLCB0aGUgcmVzdCBhcyB0ZXh0LiAqL1xuZnVuY3Rpb24gbWFya2Rvd24odGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgYmxvY2tzID0gZXNjYXBlSHRtbCh0ZXh0LnRyaW0oKSkuc3BsaXQoL2BgYCg/OlxcdyspP1xcbj8vKTtcbiAgcmV0dXJuIGJsb2Nrcy5tYXAoKGJsb2NrLCBpKSA9PiB7XG4gICAgaWYgKGkgJSAyID09PSAxKSByZXR1cm4gYDxwcmU+JHtibG9ja308L3ByZT5gO1xuICAgIGNvbnN0IGlubGluZSA9IChzOiBzdHJpbmcpID0+IHNcbiAgICAgIC5yZXBsYWNlKC9gKFteYFxcbl0rKWAvZywgXCI8Y29kZT4kMTwvY29kZT5cIilcbiAgICAgIC5yZXBsYWNlKC9cXCpcXCooW14qXFxuXSspXFwqXFwqL2csIFwiPGI+JDE8L2I+XCIpXG4gICAgICAucmVwbGFjZSgvXFxbKFteXFxdXFxuXSspXFxdXFwoKGh0dHBzPzpcXC9cXC9bXlxccyldKylcXCkvZywgJzxhIGhyZWY9XCIkMlwiIHRhcmdldD1cIl9ibGFua1wiIHJlbD1cIm5vb3BlbmVyXCI+JDE8L2E+JylcbiAgICAgIC5yZXBsYWNlKC8oXnxbXFxzKF0pKGh0dHBzPzpcXC9cXC9bXlxcczwpXSspL2csICckMTxhIGhyZWY9XCIkMlwiIHRhcmdldD1cIl9ibGFua1wiIHJlbD1cIm5vb3BlbmVyXCI+JDI8L2E+Jyk7XG4gICAgbGV0IGh0bWwgPSBcIlwiO1xuICAgIGxldCBsaXN0OiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICBmb3IgKGNvbnN0IHJhdyBvZiBibG9jay5zcGxpdChcIlxcblwiKSkge1xuICAgICAgY29uc3QgaXRlbSA9IHJhdy5tYXRjaCgvXlxccyooPzpbLSpcdTIwMjJdfChcXGQrKVsuKV0pXFxzKyguKikkLyk7XG4gICAgICBpZiAoaXRlbSkge1xuICAgICAgICBjb25zdCBraW5kID0gaXRlbVsxXSA/IFwib2xcIiA6IFwidWxcIjtcbiAgICAgICAgaWYgKGxpc3QgIT09IGtpbmQpIHsgaWYgKGxpc3QpIGh0bWwgKz0gYDwvJHtsaXN0fT5gOyBodG1sICs9IGA8JHtraW5kfT5gOyBsaXN0ID0ga2luZDsgfVxuICAgICAgICBodG1sICs9IGA8bGk+JHtpbmxpbmUoaXRlbVsyXSl9PC9saT5gO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGlmIChsaXN0KSB7IGh0bWwgKz0gYDwvJHtsaXN0fT5gOyBsaXN0ID0gbnVsbDsgfVxuICAgICAgY29uc3QgaGVhZGluZyA9IHJhdy5tYXRjaCgvXiN7MSw2fVxccysoLiopJC8pO1xuICAgICAgaHRtbCArPSBoZWFkaW5nID8gYDxiPiR7aW5saW5lKGhlYWRpbmdbMV0pfTwvYj48YnI+YCA6IHJhdy50cmltKCkgPT09IFwiXCIgPyBcIjxicj5cIiA6IGAke2lubGluZShyYXcpfTxicj5gO1xuICAgIH1cbiAgICBpZiAobGlzdCkgaHRtbCArPSBgPC8ke2xpc3R9PmA7XG4gICAgcmV0dXJuIGh0bWw7XG4gIH0pLmpvaW4oXCJcIik7XG59XG5cbmZ1bmN0aW9uIHNjcm9sbERvd24oZm9yY2UgPSBmYWxzZSkge1xuICBjb25zdCBwYW5lID0gJChcInRyYW5zY3JpcHRcIik7XG4gIGlmIChmb3JjZSB8fCBwYW5lLnNjcm9sbFRvcCArIHBhbmUuY2xpZW50SGVpZ2h0ID49IHBhbmUuc2Nyb2xsSGVpZ2h0IC0gODApIHBhbmUuc2Nyb2xsVG9wID0gcGFuZS5zY3JvbGxIZWlnaHQ7XG59XG5cbmxldCBsaW5lT3BlbiA9IGZhbHNlO1xuXG5mdW5jdGlvbiB0cmFuc2NyaXB0KHJvbGU6IFwidXNlclwiIHwgXCJhc3Npc3RhbnRcIiwgdGV4dDogc3RyaW5nKSB7XG4gICQoXCJlbXB0eVwiKS5oaWRkZW4gPSB0cnVlO1xuICBjb25zdCBwYW5lID0gJChcInRyYW5zY3JpcHRcIik7XG4gIGNvbnN0IGxhc3QgPSBwYW5lLmxhc3RFbGVtZW50Q2hpbGQgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAobGluZU9wZW4gJiYgbGFzdCAmJiBsYXN0LmRhdGFzZXQucm9sZSA9PT0gcm9sZSkgbGFzdC5xdWVyeVNlbGVjdG9yKFwiLnRleHRcIikhLnRleHRDb250ZW50ICs9IHRleHQ7XG4gIGVsc2Uge1xuICAgIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgcm93LmNsYXNzTmFtZSA9IGBsaW5lICR7cm9sZX1gO1xuICAgIHJvdy5kYXRhc2V0LnJvbGUgPSByb2xlO1xuICAgIHJvdy5pbm5lckhUTUwgPSBgPHNwYW4gY2xhc3M9XCJ3aG9cIj4ke3JvbGUgPT09IFwidXNlclwiID8gXCJZb3VcIiA6IFwiR2VtaW5pXCJ9PC9zcGFuPjxzcGFuIGNsYXNzPVwidGV4dFwiPjwvc3Bhbj5gO1xuICAgIHJvdy5xdWVyeVNlbGVjdG9yKFwiLnRleHRcIikhLnRleHRDb250ZW50ID0gdGV4dC50cmltU3RhcnQoKTtcbiAgICBwYW5lLmFwcGVuZChyb3cpO1xuICAgIGxpbmVPcGVuID0gdHJ1ZTtcbiAgfVxuICBzY3JvbGxEb3duKHJvbGUgPT09IFwidXNlclwiKTtcbn1cblxuZnVuY3Rpb24gbm90ZSh0ZXh0OiBzdHJpbmcpIHtcbiAgJChcImVtcHR5XCIpLmhpZGRlbiA9IHRydWU7XG4gIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvdy5jbGFzc05hbWUgPSBcImxpbmUgbm90ZVwiO1xuICByb3cudGV4dENvbnRlbnQgPSB0ZXh0O1xuICAkKFwidHJhbnNjcmlwdFwiKS5hcHBlbmQocm93KTtcbiAgbGluZU9wZW4gPSBmYWxzZTtcbiAgc2Nyb2xsRG93bigpO1xufVxuXG5mdW5jdGlvbiByZXN1bHQoYWdlbnQ6IHN0cmluZywgbGFiZWw6IHN0cmluZywgdGV4dDogc3RyaW5nLCBmYWlsZWQgPSBmYWxzZSk6IEhUTUxFbGVtZW50IHtcbiAgJChcImVtcHR5XCIpLmhpZGRlbiA9IHRydWU7XG4gIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvdy5jbGFzc05hbWUgPSBgbGluZSByZXN1bHQgJHthZ2VudCA9PT0gXCJ0M1wiID8gXCJ0M1wiIDogXCJcIn1gO1xuICByb3cuaW5uZXJIVE1MID0gYDxzcGFuIGNsYXNzPVwid2hvXCI+JHthZ2VudCA9PT0gXCJ0M1wiID8gXCJUM1wiIDogXCJIZXJtZXNcIn0gXHUwMEI3ICR7ZXNjYXBlSHRtbChsYWJlbCl9JHtmYWlsZWQgPyBcIiBcdTAwQjcgZmFpbGVkXCIgOiBcIlwifTwvc3Bhbj48ZGl2IGNsYXNzPVwiYm9keVwiPiR7bWFya2Rvd24odGV4dCl9PC9kaXY+YDtcbiAgJChcInRyYW5zY3JpcHRcIikuYXBwZW5kKHJvdyk7XG4gIGxpbmVPcGVuID0gZmFsc2U7XG4gIGNvbnN0IGJvZHkgPSByb3cucXVlcnlTZWxlY3RvcihcIi5ib2R5XCIpIGFzIEhUTUxFbGVtZW50O1xuICByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKCkgPT4ge1xuICAgIGlmIChib2R5LnNjcm9sbEhlaWdodCA+IGJvZHkuY2xpZW50SGVpZ2h0ICsgNCkge1xuICAgICAgY29uc3QgbW9yZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gICAgICBtb3JlLmNsYXNzTmFtZSA9IFwibW9yZVwiO1xuICAgICAgbW9yZS50ZXh0Q29udGVudCA9IFwiU2hvdyBhbGxcIjtcbiAgICAgIG1vcmUub25jbGljayA9ICgpID0+IHsgcm93LmNsYXNzTGlzdC50b2dnbGUoXCJvcGVuXCIpOyBtb3JlLnRleHRDb250ZW50ID0gcm93LmNsYXNzTGlzdC5jb250YWlucyhcIm9wZW5cIikgPyBcIlNob3cgbGVzc1wiIDogXCJTaG93IGFsbFwiOyB9O1xuICAgICAgcm93LmFwcGVuZChtb3JlKTtcbiAgICB9XG4gIH0pO1xuICBzY3JvbGxEb3duKHRydWUpO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBlbGFwc2VkKHNlY29uZHM6IG51bWJlcik6IHN0cmluZyB7XG4gIGlmIChzZWNvbmRzIDwgNjApIHJldHVybiBgJHtNYXRoLmZsb29yKHNlY29uZHMpfSBzYDtcbiAgY29uc3QgbSA9IE1hdGguZmxvb3Ioc2Vjb25kcyAvIDYwKTtcbiAgcmV0dXJuIG0gPCA2MCA/IGAke219IG1pbiAke01hdGguZmxvb3Ioc2Vjb25kcyAlIDYwKX0gc2AgOiBgJHtNYXRoLmZsb29yKG0gLyA2MCl9IGggJHttICUgNjB9IG1pbmA7XG59XG5cbi8qKiBUaGUgZW1wdHkgdGFzayBsaXN0J3Mgd29yZHMsIGtlcHQgdG8gcHV0IGJhY2suICovXG5jb25zdCBub1Rhc2tzID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJub3Rhc2tzXCIpITtcblxuLyoqIFdoZXRoZXIgYSB0YXNrIHN0aWxsIHdhbnRzIHRoZSBzY3JlZW46IGl0J3Mgd29ya2luZywgb3IgaXQgd2FpdHMgZm9yIHRoZSB1c2VyLiBUaGUgcmVzdCBmb2xkIGF3YXkgdW5kZXIgRmluaXNoZWQuICovXG5jb25zdCBsaXZlID0gKHN0YXRlOiBzdHJpbmcpID0+IHN0YXRlID09PSBcInJ1bm5pbmdcIiB8fCBzdGF0ZS5zdGFydHNXaXRoKFwid2FpdGluZ1wiKTtcblxuLyoqIFRoZSBGaW5pc2hlZCBmb2xkJ3MgY291bnQsIGFuZCB0aGUgZm9sZCBpdHNlbGYgb25seSB3aGVuIHNvbWV0aGluZyBpcyBpbiBpdC4gKi9cbmZ1bmN0aW9uIHNob3dEb25lKCkge1xuICBjb25zdCBuID0gJChcImRvbmVub3dcIikuY2hpbGRFbGVtZW50Q291bnQgKyAkKFwiZG9uZWVhcmxpZXJcIikuY2hpbGRFbGVtZW50Q291bnQ7XG4gICQoXCJkb25lYm94XCIpLmhpZGRlbiA9IG4gPT09IDA7XG4gICQoXCJkb25lY291bnRcIikudGV4dENvbnRlbnQgPSBuID4gMCA/IGBcdTAwQjcgJHtufWAgOiBcIlwiO1xufVxuXG5mdW5jdGlvbiBzaG93VGFza3MoZm9yY2UgPSBmYWxzZSkge1xuICBjb25zdCBwYW5lID0gJChcInRhc2tzXCIpO1xuICBjb25zdCBkb25lID0gJChcImRvbmVub3dcIik7XG4gIGNvbnN0IG9wZW4gPSBkb2N1bWVudC5hY3RpdmVFbGVtZW50Py5jbG9zZXN0Py4oXCIudGFza1wiKSBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gIGlmICghZm9yY2UgJiYgb3BlbiAmJiAocGFuZS5jb250YWlucyhvcGVuKSB8fCBkb25lLmNvbnRhaW5zKG9wZW4pKSAmJiBvcGVuLnF1ZXJ5U2VsZWN0b3IoXCJmb3JtXCIpKSByZXR1cm47IC8vIGRvbid0IHJlZHJhdyB1bmRlciBzb21lb25lIHR5cGluZyBhIGZvbGxvdy11cFxuICBwYW5lLmlubmVySFRNTCA9IFwiXCI7XG4gIGRvbmUuaW5uZXJIVE1MID0gXCJcIjtcbiAgY29uc3QgYWxsID0gWy4uLnRhc2tzLnZhbHVlcygpXS5yZXZlcnNlKCk7XG4gIGlmIChhbGwubGVuZ3RoID09PSAwKSB7IHBhbmUuYXBwZW5kKG5vVGFza3MpOyAkKFwidGFza2NvdW50XCIpLnRleHRDb250ZW50ID0gXCJcIjsgc2hvd0RvbmUoKTsgcmV0dXJuOyB9XG4gIGNvbnN0IHJ1bm5pbmcgPSBhbGwuZmlsdGVyKCh0KSA9PiB0LmMuc3RhdGUgPT09IFwicnVubmluZ1wiKS5sZW5ndGg7XG4gICQoXCJ0YXNrY291bnRcIikudGV4dENvbnRlbnQgPSBydW5uaW5nID4gMCA/IGAke3J1bm5pbmd9IHJ1bm5pbmdgIDogXCJcIjtcbiAgJChcImNhbmNlbGFsbFwiKS5oaWRkZW4gPSAhY2FsbElkIHx8IHJ1bm5pbmcgPCAyO1xuICBmb3IgKGNvbnN0IHZpZXcgb2YgYWxsKSB7XG4gICAgY29uc3QgdCA9IHZpZXcuYztcbiAgICBjb25zdCB3YWl0aW5nID0gdC5zdGF0ZS5zdGFydHNXaXRoKFwid2FpdGluZ1wiKTtcbiAgICBjb25zdCBjYXJkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBjYXJkLmNsYXNzTmFtZSA9IGB0YXNrICR7d2FpdGluZyA/IFwid2FpdGluZ1wiIDogdC5zdGF0ZX1gO1xuICAgIGNvbnN0IGFnZSA9ICh2aWV3LmVuZGVkID8/IG5vdygpKSAtIHZpZXcuc2luY2U7XG4gICAgY2FyZC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz1cInRvcFwiPjxzcGFuIGNsYXNzPVwiYmFkZ2UgJHt0LmFnZW50ID09PSBcInQzXCIgPyBcInQzXCIgOiBcIlwifVwiPiR7dC5hZ2VudCA9PT0gXCJ0M1wiID8gXCJUM1wiIDogXCJIZXJtZXNcIn08L3NwYW4+YCArXG4gICAgICBgPHNwYW4gY2xhc3M9XCJsYWJlbFwiPjwvc3Bhbj48c3BhbiBjbGFzcz1cInN0YXRlXCI+JHt0LnN0YXRlID09PSBcInJ1bm5pbmdcIiA/ICc8c3BhbiBjbGFzcz1cInNwaW5cIj48L3NwYW4+ICcgOiBcIlwifSR7ZXNjYXBlSHRtbCh0LnN0YXRlKX0gXHUwMEI3ICR7ZWxhcHNlZChhZ2UpfTwvc3Bhbj48L2Rpdj5gICtcbiAgICAgIGA8ZGl2IGNsYXNzPVwicFwiPjwvZGl2PmA7XG4gICAgY2FyZC5xdWVyeVNlbGVjdG9yKFwiLmxhYmVsXCIpIS50ZXh0Q29udGVudCA9IHQubGFiZWw7XG4gICAgY2FyZC5xdWVyeVNlbGVjdG9yKFwiLnBcIikhLnRleHRDb250ZW50ID0gdC5wcm9ncmVzcyA/PyB0LnJlcXVlc3Q7XG4gICAgaWYgKHQucXVlc3Rpb24pIHtcbiAgICAgIGNvbnN0IHEgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgICAgcS5jbGFzc05hbWUgPSBcInFcIjtcbiAgICAgIHEudGV4dENvbnRlbnQgPSBgQXNrczogJHt0LnF1ZXN0aW9ufWA7XG4gICAgICBjYXJkLmFwcGVuZChxKTtcbiAgICB9XG4gICAgaWYgKHZpZXcuYXBwcm92YWwgJiYgdC5zdGF0ZSA9PT0gXCJydW5uaW5nXCIpIHtcbiAgICAgIGNvbnN0IGJveCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICBib3guY2xhc3NOYW1lID0gXCJhcHByb3ZhbFwiO1xuICAgICAgYm94LmlubmVySFRNTCA9IGA8ZGl2Pkhlcm1lcyBhc2tzIHRvIHJ1bjo8L2Rpdj48Y29kZT48L2NvZGU+PGRpdiBjbGFzcz1cImFjdHNcIj48L2Rpdj5gO1xuICAgICAgYm94LnF1ZXJ5U2VsZWN0b3IoXCJjb2RlXCIpIS50ZXh0Q29udGVudCA9IHZpZXcuYXBwcm92YWwuY29tbWFuZDtcbiAgICAgIGNvbnN0IGFuc3dlciA9IChjaG9pY2U6IFwib25jZVwiIHwgXCJkZW55XCIpID0+IHtcbiAgICAgICAgdmlldy5hcHByb3ZhbCA9IHVuZGVmaW5lZDtcbiAgICAgICAgc2hvd1Rhc2tzKHRydWUpO1xuICAgICAgICB2b2lkIGZldGNoKFwiL2hlcm1lcy9hcHByb3ZhbFwiLCB7IG1ldGhvZDogXCJQT1NUXCIsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgY2FsbDogY2FsbE5hbWUsIHRhc2tJZDogdC5pZCwgY2hvaWNlIH0pIH0pXG4gICAgICAgICAgLnRoZW4oKHIpID0+IHRvYXN0KHIub2sgPyAoY2hvaWNlID09PSBcIm9uY2VcIiA/IFwiQXBwcm92ZWRcIiA6IFwiRGVuaWVkXCIpIDogXCJUaGF0IGFwcHJvdmFsIGhhZCBhbHJlYWR5IGxhcHNlZFwiKSk7XG4gICAgICB9O1xuICAgICAgZm9yIChjb25zdCBbbGFiZWwsIGNob2ljZV0gb2YgW1tcIkFwcHJvdmUgb25jZVwiLCBcIm9uY2VcIl0sIFtcIkRlbnlcIiwgXCJkZW55XCJdXSBhcyBjb25zdCkge1xuICAgICAgICBjb25zdCBiID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgICAgICAgYi50ZXh0Q29udGVudCA9IGxhYmVsO1xuICAgICAgICBpZiAoY2hvaWNlID09PSBcIm9uY2VcIikgYi5jbGFzc05hbWUgPSBcImdvXCI7XG4gICAgICAgIGIub25jbGljayA9ICgpID0+IGFuc3dlcihjaG9pY2UpO1xuICAgICAgICBib3gucXVlcnlTZWxlY3RvcihcIi5hY3RzXCIpIS5hcHBlbmQoYik7XG4gICAgICB9XG4gICAgICBjYXJkLmFwcGVuZChib3gpO1xuICAgIH1cbiAgICBpZiAodC5zdGF0ZSAhPT0gXCJydW5uaW5nXCIpIHZpZXcuYXBwcm92YWwgPSB1bmRlZmluZWQ7XG4gICAgY29uc3QgYWN0cyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgYWN0cy5jbGFzc05hbWUgPSBcImFjdHNcIjtcbiAgICBjb25zdCBidXR0b24gPSAodGV4dDogc3RyaW5nLCBmbjogKCkgPT4gdm9pZCkgPT4geyBjb25zdCBiID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTsgYi50ZXh0Q29udGVudCA9IHRleHQ7IGIub25jbGljayA9IGZuOyBhY3RzLmFwcGVuZChiKTsgcmV0dXJuIGI7IH07XG4gICAgaWYgKGNhbGxJZCkge1xuICAgICAgYnV0dG9uKHdhaXRpbmcgPyBcIkFuc3dlclwiIDogXCJGb2xsb3cgdXBcIiwgKCkgPT4gZm9sbG93VXBGb3JtKGNhcmQsIHQpKTtcbiAgICAgIGlmICh0LnN0YXRlID09PSBcInJ1bm5pbmdcIikgYnV0dG9uKFwiQ2FuY2VsXCIsICgpID0+IHB1c2goeyB0eXBlOiBcImNhbmNlbFRhc2tcIiwgdGFzazogdC5pZCB9KSk7XG4gICAgfVxuICAgIGlmICh2aWV3LnJlc3VsdCkgYnV0dG9uKFwiUmVzdWx0XCIsICgpID0+IHsgdmlldy5yZXN1bHQhLnNjcm9sbEludG9WaWV3KHsgYmVoYXZpb3I6IFwic21vb3RoXCIsIGJsb2NrOiBcImNlbnRlclwiIH0pOyB2aWV3LnJlc3VsdCEuY2xhc3NMaXN0LmFkZChcIm9wZW5cIik7IH0pO1xuICAgIGlmICh2aWV3LnRocmVhZCkgYnV0dG9uKFwiQ29weSB0aHJlYWQgaWRcIiwgKCkgPT4geyB2b2lkIG5hdmlnYXRvci5jbGlwYm9hcmQ/LndyaXRlVGV4dCh2aWV3LnRocmVhZCEpOyB0b2FzdChcIlRocmVhZCBpZCBjb3BpZWRcIik7IH0pO1xuICAgIGlmIChhY3RzLmNoaWxkRWxlbWVudENvdW50KSBjYXJkLmFwcGVuZChhY3RzKTtcbiAgICAobGl2ZSh0LnN0YXRlKSA/IHBhbmUgOiBkb25lKS5hcHBlbmQoY2FyZCk7XG4gIH1cbiAgc2hvd0RvbmUoKTtcbn1cblxuZnVuY3Rpb24gZm9sbG93VXBGb3JtKGNhcmQ6IEhUTUxFbGVtZW50LCB0OiBDb21tYW5kKSB7XG4gIGlmIChjYXJkLnF1ZXJ5U2VsZWN0b3IoXCJmb3JtXCIpKSByZXR1cm47XG4gIGNvbnN0IGZvcm0gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZm9ybVwiKTtcbiAgZm9ybS5pbm5lckhUTUwgPSBgPGlucHV0IHR5cGU9XCJ0ZXh0XCIgcGxhY2Vob2xkZXI9XCJUZWxsIFx1MjAxQyR7ZXNjYXBlSHRtbCh0LmxhYmVsKX1cdTIwMURcdTIwMjZcIiBlbnRlcmtleWhpbnQ9XCJzZW5kXCI+PGJ1dHRvbj5TZW5kPC9idXR0b24+YDtcbiAgY29uc3QgaW5wdXQgPSBmb3JtLnF1ZXJ5U2VsZWN0b3IoXCJpbnB1dFwiKSE7XG4gIGZvcm0ub25zdWJtaXQgPSAoZSkgPT4ge1xuICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICBjb25zdCB0ZXh0ID0gaW5wdXQudmFsdWUudHJpbSgpO1xuICAgIGlmICh0ZXh0KSB7IHB1c2goeyB0eXBlOiBcInN0ZWVyXCIsIHRhc2s6IHQuaWQsIHRleHQgfSk7IG5vdGUoYFlvdSBcdTIxOTIgJHt0LmxhYmVsfTogJHt0ZXh0fWApOyB9XG4gICAgaW5wdXQuYmx1cigpO1xuICAgIGZvcm0ucmVtb3ZlKCk7XG4gICAgc2hvd1Rhc2tzKCk7XG4gIH07XG4gIGlucHV0Lm9ua2V5ZG93biA9IChlKSA9PiB7IGlmIChlLmtleSA9PT0gXCJFc2NhcGVcIikgeyBpbnB1dC5ibHVyKCk7IGZvcm0ucmVtb3ZlKCk7IHNob3dUYXNrcygpOyB9IH07XG4gIGNhcmQuYXBwZW5kKGZvcm0pO1xuICBpbnB1dC5mb2N1cygpO1xufVxuXG4vKiogVDMgdGhyZWFkcyBlYXJsaWVyIGNhbGxzIHN0YXJ0ZWQ6IHRoZXkgY2Fycnkgb24gYWZ0ZXIgYSBjYWxsLCBzbyB0aGUgcGFuZWwgc2F5cyBob3cgdGhleSdyZSBkb2luZy4gKi9cbmFzeW5jIGZ1bmN0aW9uIHNob3dFYXJsaWVyKCkge1xuICBsZXQgbGlzdDogeyB0aHJlYWQ6IHN0cmluZzsgdGl0bGU6IHN0cmluZzsgc3RhdHVzOiBzdHJpbmc7IGJyYW5jaDogc3RyaW5nIHwgbnVsbDsgcHI6IHN0cmluZyB8IG51bGw7IHVwZGF0ZWQ6IHN0cmluZzsgbGFzdDogc3RyaW5nOyB3YWl0aW5nOiBib29sZWFuIH1bXSA9IFtdO1xuICB0cnkgeyBsaXN0ID0gYXdhaXQgKGF3YWl0IGZldGNoKFwiL2FnZW50L3JlY2VudFwiLCB7IGNhY2hlOiBcIm5vLXN0b3JlXCIgfSkpLmpzb24oKTsgfSBjYXRjaCB7fVxuICBjb25zdCBjdXJyZW50ID0gbmV3IFNldChbLi4udGFza3MudmFsdWVzKCldLm1hcCgodikgPT4gdi50aHJlYWQpLmZpbHRlcihCb29sZWFuKSk7XG4gIGxpc3QgPSBsaXN0LmZpbHRlcigodCkgPT4gIWN1cnJlbnQuaGFzKHQudGhyZWFkKSk7XG4gIGNvbnN0IHBhbmUgPSAkKFwiZWFybGllclwiKTtcbiAgY29uc3QgZG9uZSA9ICQoXCJkb25lZWFybGllclwiKTtcbiAgcGFuZS5pbm5lckhUTUwgPSBcIlwiO1xuICBkb25lLmlubmVySFRNTCA9IFwiXCI7XG4gIGZvciAoY29uc3QgdCBvZiBsaXN0KSB7XG4gICAgY29uc3QgY2FyZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgY29uc3Qgc3RhdGUgPSB0LndhaXRpbmcgPyBcIndhaXRpbmcgZm9yIGFwcHJvdmFsIGluIFQzXCIgOiB0LnN0YXR1cztcbiAgICBjYXJkLmNsYXNzTmFtZSA9IGB0YXNrICR7dC5zdGF0dXMgPT09IFwicnVubmluZ1wiID8gXCJydW5uaW5nXCIgOiB0LndhaXRpbmcgPyBcIndhaXRpbmdcIiA6IFwiZmluaXNoZWRcIn1gO1xuICAgIGNvbnN0IGFnbyA9IE1hdGgubWF4KDAsIChEYXRlLm5vdygpIC0gRGF0ZS5wYXJzZSh0LnVwZGF0ZWQpKSAvIDEwMDApO1xuICAgIGNhcmQuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9XCJ0b3BcIj48c3BhbiBjbGFzcz1cImJhZGdlIHQzXCI+VDM8L3NwYW4+PHNwYW4gY2xhc3M9XCJsYWJlbFwiPjwvc3Bhbj5gICtcbiAgICAgIGA8c3BhbiBjbGFzcz1cInN0YXRlXCI+JHt0LnN0YXR1cyA9PT0gXCJydW5uaW5nXCIgPyAnPHNwYW4gY2xhc3M9XCJzcGluXCI+PC9zcGFuPiAnIDogXCJcIn0ke2VzY2FwZUh0bWwoc3RhdGUpfSBcdTAwQjcgJHtlbGFwc2VkKGFnbyl9IGFnbzwvc3Bhbj48L2Rpdj48ZGl2IGNsYXNzPVwicFwiPjwvZGl2PmA7XG4gICAgY2FyZC5xdWVyeVNlbGVjdG9yKFwiLmxhYmVsXCIpIS50ZXh0Q29udGVudCA9IHQudGl0bGU7XG4gICAgY2FyZC5xdWVyeVNlbGVjdG9yKFwiLnBcIikhLnRleHRDb250ZW50ID0gdC5sYXN0IHx8ICh0LmJyYW5jaCA/IGBPbiAke3QuYnJhbmNofWAgOiBcIlwiKTtcbiAgICBjb25zdCBhY3RzID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBhY3RzLmNsYXNzTmFtZSA9IFwiYWN0c1wiO1xuICAgIGlmICh0LnByKSB7IGNvbnN0IGEgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYVwiKTsgYS5ocmVmID0gdC5wcjsgYS50YXJnZXQgPSBcIl9ibGFua1wiOyBhLnJlbCA9IFwibm9vcGVuZXJcIjsgYS50ZXh0Q29udGVudCA9IFwiUHVsbCByZXF1ZXN0XCI7IGFjdHMuYXBwZW5kKGEpOyB9XG4gICAgY29uc3QgY29weSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gICAgY29weS50ZXh0Q29udGVudCA9IFwiQ29weSB0aHJlYWQgaWRcIjtcbiAgICBjb3B5Lm9uY2xpY2sgPSAoKSA9PiB7IHZvaWQgbmF2aWdhdG9yLmNsaXBib2FyZD8ud3JpdGVUZXh0KHQudGhyZWFkKTsgdG9hc3QoXCJUaHJlYWQgaWQgY29waWVkXCIpOyB9O1xuICAgIGFjdHMuYXBwZW5kKGNvcHkpO1xuICAgIGNhcmQuYXBwZW5kKGFjdHMpO1xuICAgICh0LnN0YXR1cyA9PT0gXCJydW5uaW5nXCIgfHwgdC53YWl0aW5nID8gcGFuZSA6IGRvbmUpLmFwcGVuZChjYXJkKTtcbiAgfVxuICAkKFwiZWFybGllcmJveFwiKS5oaWRkZW4gPSBwYW5lLmNoaWxkRWxlbWVudENvdW50ID09PSAwO1xuICBzaG93RG9uZSgpO1xufVxuXG5jb25zdCBTVEFUVVNfVEVYVDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgaWRsZTogXCJJZGxlXCIsIGNvbm5lY3Rpbmc6IFwiQ29ubmVjdGluZ1x1MjAyNlwiLCBsaXN0ZW5pbmc6IFwiTGlzdGVuaW5nXCIsIHdvcmtpbmc6IFwiTGlzdGVuaW5nIFx1MDBCNyB0YXNrcyBydW5uaW5nXCIsXG4gIHN0YW5kYnk6IFwiUGF1c2VkIHdoaWxlIHRhc2tzIHJ1biBcdTAwQjcgc3BlYWsgdG8gcmVzdW1lXCIsIHdha2luZzogXCJSZXN1bWluZ1x1MjAyNlwiLCBlbmRlZDogXCJFbmRlZFwiLFxufTtcblxuZnVuY3Rpb24gc2hvd1N0YXR1cyhtZXNzYWdlPzogc3RyaW5nKSB7XG4gIGNvbnN0IHNwZWFraW5nID0gY2FsbElkICYmIGNvcmVTdGF0dXMgIT09IFwic3RhbmRieVwiICYmIGF1ZGlvLnF1ZXVlZCA+IDAuMDU7XG4gIGNvbnN0IHNob3duID0gc3BlYWtpbmcgPyBcInNwZWFraW5nXCIgOiBjb3JlU3RhdHVzO1xuICAkKFwic3RhdHVzXCIpLmNsYXNzTmFtZSA9IHNob3duO1xuICBsZXQgdGV4dCA9IHNwZWFraW5nID8gXCJTcGVha2luZ1wiIDogU1RBVFVTX1RFWFRbY29yZVN0YXR1c10gPz8gY29yZVN0YXR1cztcbiAgaWYgKGNhbGxJZCAmJiBtdXRlZCAmJiAhaG9sZGluZyAmJiAhc3BlYWtpbmcpIHRleHQgKz0gXCIgXHUwMEI3IG11dGVkXCI7XG4gIGlmIChob2xkaW5nKSB0ZXh0ID0gXCJUYWxraW5nIChob2xkKVwiO1xuICBpZiAobWVzc2FnZSkgdGV4dCA9IGAke3RleHR9OiAke21lc3NhZ2V9YDtcbiAgaWYgKGNvcmVTdGF0dXMgIT09IFwiZW5kZWRcIiB8fCBtZXNzYWdlKSAkKFwic3RhdHVzdGV4dFwiKS50ZXh0Q29udGVudCA9IHRleHQ7XG4gICQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiaHVzaFwiKS5jbGFzc0xpc3QudG9nZ2xlKFwibGl2ZVwiLCBCb29sZWFuKHNwZWFraW5nKSk7XG59XG5cbi8vIFRoZSBjYWxsLlxuXG5mdW5jdGlvbiBwdXNoKGV2ZW50OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikge1xuICBpZiAoIWNvcmUgfHwgIWNhbGxJZCkgcmV0dXJuO1xuICBjb25zdCBlOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgLi4uZXZlbnQsIHQ6IG5vdygpIH07XG4gIGNvbnN0IHF1aWV0ID0gZS50eXBlID09PSBcIm1pY1wiIHx8IGUudHlwZSA9PT0gXCJ0aWNrXCI7XG4gIGlmICghcXVpZXQpIGxvZyhcImluXCIsIGUudHlwZSA9PT0gXCJ3cy5tZXNzYWdlXCIgPyBgd3MgJHtlLnNpZH0gXHUyMTkwICR7YnJpZWYoU3RyaW5nKGUuZGF0YSkpfWAgOiBKU09OLnN0cmluZ2lmeShlKS5zbGljZSgwLCA0MDApLCBcImluXCIpO1xuICBydW4oSlNPTi5wYXJzZShjb3JlLnB1c2goY2FsbElkLCBKU09OLnN0cmluZ2lmeShlKSkpKTtcbn1cblxuZnVuY3Rpb24gcnVuKGNvbW1hbmRzOiBDb21tYW5kW10pIHtcbiAgZm9yIChjb25zdCBjIG9mIGNvbW1hbmRzKSB7XG4gICAgc3dpdGNoIChjLnR5cGUpIHtcbiAgICAgIGNhc2UgXCJ3cy5jb25uZWN0XCI6IGNvbm5lY3QoYy5zaWQpOyBicmVhaztcbiAgICAgIGNhc2UgXCJ3cy5zZW5kXCI6IHtcbiAgICAgICAgc29ja2V0cy5nZXQoYy5zaWQpPy5zZW5kKGMuZGF0YSk7XG4gICAgICAgIGlmIChjLmRhdGEuc3RhcnRzV2l0aCgne1wicmVhbHRpbWVJbnB1dFwiOntcImF1ZGlvXCInKSkgY291bnRzLnNlbnQrKztcbiAgICAgICAgZWxzZSBsb2coXCJvdXRcIiwgYHdzICR7Yy5zaWR9IFx1MjE5MiAke2JyaWVmKGMuZGF0YSl9YCwgXCJvdXRcIik7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcIndzLmNsb3NlXCI6IHNvY2tldHMuZ2V0KGMuc2lkKT8uY2xvc2UoKTsgc29ja2V0cy5kZWxldGUoYy5zaWQpOyBsb2coXCJvdXRcIiwgYHdzICR7Yy5zaWR9IGNsb3NlYCwgXCJvdXRcIik7IGJyZWFrO1xuICAgICAgY2FzZSBcIm1pYy5zdGFydFwiOlxuICAgICAgY2FzZSBcIm1pYy5yZXN0YXJ0XCI6XG4gICAgICAgIGxvZyhcIm91dFwiLCBjLnR5cGUsIFwib3V0XCIpO1xuICAgICAgICB2b2lkIGF1ZGlvLnN0YXJ0TWljKG9uTWljLCBtaWNPcHRpb25zKCkpLmNhdGNoKChlcnIpID0+IHsgbG9nKFwiZXJyb3JcIiwgYG1pY3JvcGhvbmU6ICR7ZXJyLm1lc3NhZ2V9YCwgXCJlcnJcIik7IHRvYXN0KGBNaWNyb3Bob25lOiAke2Vyci5tZXNzYWdlfWApOyB9KTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwibWljLnN0b3BcIjogYXVkaW8uc3RvcE1pYygpOyBicmVhaztcbiAgICAgIGNhc2UgXCJwbGF5XCI6IHtcbiAgICAgICAgY29uc3QgdCA9IG5vdygpO1xuICAgICAgICAvLyBBIHJlcGx5IHN0YXJ0aW5nOiBmcm9tIHRoZSBlbmQgb2YgdGhlIHVzZXIncyBzcGVlY2ggdG8gaXRzIGZpcnN0IHNvdW5kLlxuICAgICAgICBpZiAoIW1ldHJpY3MucmVwbGllZCAmJiBhdWRpby5xdWV1ZWQgPCAwLjA1ICYmIHQgLSBtZXRyaWNzLmxhc3RQbGF5ID4gMC42ICYmIG1ldHJpY3MubGFzdFZvaWNlID4gMCAmJiB0IC0gbWV0cmljcy5sYXN0Vm9pY2UgPCAxMCkge1xuICAgICAgICAgIG1ldHJpY3MucmVwbHkucHVzaCh0IC0gbWV0cmljcy5sYXN0Vm9pY2UpO1xuICAgICAgICAgIGlmIChtZXRyaWNzLnJlcGx5Lmxlbmd0aCA+IDIwKSBtZXRyaWNzLnJlcGx5LnNoaWZ0KCk7XG4gICAgICAgICAgbWV0cmljcy5yZXBsaWVkID0gdHJ1ZTtcbiAgICAgICAgICBzaG93TWV0cmljcygpO1xuICAgICAgICB9XG4gICAgICAgIG1ldHJpY3MubGFzdFBsYXkgPSB0O1xuICAgICAgICBhdWRpby5wbGF5KGMucGNtKTtcbiAgICAgICAgY291bnRzLnBsYXkrKztcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwiZmx1c2hcIjogYXVkaW8uZmx1c2goKTsgbG9nKFwib3V0XCIsIFwiZmx1c2hcIiwgXCJvdXRcIik7IGJyZWFrO1xuICAgICAgY2FzZSBcImN1ZVwiOlxuICAgICAgICBhdWRpby5jdWUoYy5wY20pO1xuICAgICAgICBsb2coXCJvdXRcIiwgYGN1ZSAke2MuZWFyY29ufWAsIFwib3V0XCIpO1xuICAgICAgICAvLyBBIHJlcXVlc3QgdGhhdCBiZWNhbWUgYSB0YXNrIGdldHMgYSB0b25lLCBub3QgYSBzcG9rZW4gcmVwbHk6IG5vdGhpbmcgdG8gdGltZS5cbiAgICAgICAgaWYgKGMuZWFyY29uID09PSBcInRhc2tTdGFydGVkXCIpIG1ldHJpY3MucmVwbGllZCA9IHRydWU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcIndha2V3b3JkXCI6IGxvZyhcIm91dFwiLCBgd2FrZSB3b3JkICR7Yy5vbiA/IFwibGlzdGVuaW5nXCIgOiBcIm9mZlwifWAsIFwib3V0XCIpOyBicmVhaztcbiAgICAgIGNhc2UgXCJ0b29sLmNhbGxcIjogdm9pZCB0b29sKGMpOyBicmVhaztcbiAgICAgIGNhc2UgXCJ0b29sLmNhbmNlbFwiOiBjYW5jZWxSdW4oYy5ydW4sIGMucmVhc29uKTsgYnJlYWs7XG4gICAgICBjYXNlIFwidG9vbC5zdGVlclwiOiB2b2lkIHN0ZWVyUnVuKGMpOyBicmVhaztcbiAgICAgIGNhc2UgXCJzdGF0dXNcIjpcbiAgICAgICAgY29yZVN0YXR1cyA9IGMuc3RhdHVzO1xuICAgICAgICBzaG93U3RhdHVzKGMuc3RhdHVzID09PSBcImVuZGVkXCIgPyBjLm1lc3NhZ2UgPz8gdW5kZWZpbmVkIDogdW5kZWZpbmVkKTtcbiAgICAgICAgbG9nKFwic3RhdHVzXCIsIGMuc3RhdHVzICsgKGMubWVzc2FnZSA/IGA6ICR7Yy5tZXNzYWdlfWAgOiBcIlwiKSwgXCJzdGF0dXNcIik7XG4gICAgICAgIGlmIChjLnN0YXR1cyA9PT0gXCJlbmRlZFwiKSB7IGlmIChjLm1lc3NhZ2UpIG5vdGUoYy5tZXNzYWdlKTsgZW5kKCk7IH1cbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwidHJhbnNjcmlwdFwiOlxuICAgICAgICB0cmFuc2NyaXB0KGMucm9sZSwgYy50ZXh0KTtcbiAgICAgICAgcmVtZW1iZXIoYy5yb2xlLCBjLnRleHQsIGMucm9sZSA9PT0gXCJhc3Npc3RhbnRcIiA/IFwiR2VtaW5pXCIgOiB1bmRlZmluZWQsIGxhc3RSb2xlID09PSBjLnJvbGUpO1xuICAgICAgICBsYXN0Um9sZSA9IGMucm9sZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwidGFza1wiOiB7XG4gICAgICAgIGNvbnN0IHZpZXcgPSB0YXNrcy5nZXQoYy5pZCkgPz8geyBjLCBzaW5jZTogbm93KCksIGVuZGVkOiBudWxsIH07XG4gICAgICAgIGlmIChjLnN0YXRlID09PSBcInJ1bm5pbmdcIiAmJiB2aWV3LmMuc3RhdGUgIT09IFwicnVubmluZ1wiKSB7IHZpZXcuc2luY2UgPSBub3coKTsgdmlldy5lbmRlZCA9IG51bGw7IH1cbiAgICAgICAgaWYgKGMuc3RhdGUgIT09IFwicnVubmluZ1wiICYmIHZpZXcuZW5kZWQgPT0gbnVsbCkgdmlldy5lbmRlZCA9IG5vdygpO1xuICAgICAgICB2aWV3LmMgPSBjO1xuICAgICAgICB0YXNrcy5zZXQoYy5pZCwgdmlldyk7XG4gICAgICAgIHNob3dUYXNrcygpO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJxdWVzdGlvbnNcIjogYnJlYWs7XG4gICAgICBjYXNlIFwibWljU2lsZW50XCI6ICQoXCJtaWN3YXJuXCIpLmhpZGRlbiA9ICFjLnNpbGVudDsgYnJlYWs7XG4gICAgICBjYXNlIFwidm9pY2VDb21tYW5kXCI6XG4gICAgICAgIHRvYXN0KGBIZWFyZCBcdTIwMUMke2MuaGVhcmR9XHUyMDFEOiAke2MuY29tbWFuZCA9PT0gXCJzdG9wXCIgPyBcInN0b3BwZWRcIiA6IGMuY29tbWFuZCA9PT0gXCJjYW5jZWxBbGxcIiA/IFwiY2FuY2VsbGluZyBldmVyeSB0YXNrXCIgOiBcImhhbmdpbmcgdXBcIn1gKTtcbiAgICAgICAgbG9nKFwib3V0XCIsIGB2b2ljZSBjb21tYW5kICR7Yy5jb21tYW5kfTogJHtjLmhlYXJkfWAsIFwib3V0XCIpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJsb2dcIjogbG9nKGMubGV2ZWwsIGMubWVzc2FnZSwgYy5sZXZlbCA9PT0gXCJ3YXJuXCIgPyBcIndhcm5cIiA6IFwiXCIpOyBicmVhaztcbiAgICAgIGRlZmF1bHQ6IGxvZyhcIm91dFwiLCBKU09OLnN0cmluZ2lmeShjKS5zbGljZSgwLCAzMDApLCBcIm91dFwiKTtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gb25NaWMocGNtOiBzdHJpbmcsIGxldmVsOiBudW1iZXIpIHtcbiAgY291bnRzLm1pYysrO1xuICBpZiAobGV2ZWwgPiAwLjAzICYmICEobXV0ZWQgJiYgIWhvbGRpbmcpKSB7XG4gICAgbWV0cmljcy5sYXN0Vm9pY2UgPSBub3coKTtcbiAgICBpZiAoYXVkaW8ucXVldWVkIDwgMC4wNSkgbWV0cmljcy5yZXBsaWVkID0gZmFsc2U7XG4gIH1cbiAgcHVzaCh7IHR5cGU6IFwibWljXCIsIHBjbSB9KTtcbn1cblxuZnVuY3Rpb24gY29ubmVjdChzaWQ6IG51bWJlcikge1xuICBjb25zdCB3cyA9IG5ldyBXZWJTb2NrZXQoYCR7bG9jYXRpb24ucHJvdG9jb2wgPT09IFwiaHR0cHM6XCIgPyBcIndzc1wiIDogXCJ3c1wifTovLyR7bG9jYXRpb24uaG9zdH0vbGl2ZWApO1xuICBzb2NrZXRzLnNldChzaWQsIHdzKTtcbiAgbG9nKFwib3V0XCIsIGB3cyAke3NpZH0gY29ubmVjdCAoJHtzZXJ2ZXIucm91dGV9KWAsIFwib3V0XCIpO1xuICB3cy5vbm9wZW4gPSAoKSA9PiBwdXNoKHsgdHlwZTogXCJ3cy5vcGVuXCIsIHNpZCB9KTtcbiAgd3Mub25tZXNzYWdlID0gKG0pID0+IHB1c2goeyB0eXBlOiBcIndzLm1lc3NhZ2VcIiwgc2lkLCBkYXRhOiB0eXBlb2YgbS5kYXRhID09PSBcInN0cmluZ1wiID8gbS5kYXRhIDogXCJcIiB9KTtcbiAgd3Mub25jbG9zZSA9IChlKSA9PiB7XG4gICAgaWYgKHNvY2tldHMuZ2V0KHNpZCkgIT09IHdzICYmIHNvY2tldHMuaGFzKHNpZCkpIHJldHVybjtcbiAgICBjb25zdCBodHRwU3RhdHVzID0gZS5jb2RlID49IDQxMDAgJiYgZS5jb2RlIDwgNDYwMCA/IGUuY29kZSAtIDQwMDAgOiB1bmRlZmluZWQ7XG4gICAgcHVzaCh7IHR5cGU6IFwid3MuY2xvc2VkXCIsIHNpZCwgY29kZTogaHR0cFN0YXR1cyA/IHVuZGVmaW5lZCA6IGUuY29kZSwgcmVhc29uOiBlLnJlYXNvbiwgaHR0cFN0YXR1cyB9KTtcbiAgfTtcbn1cblxuZnVuY3Rpb24gY2FuY2VsUnVuKGtleTogc3RyaW5nLCByZWFzb246IHN0cmluZykge1xuICBjb25zdCByID0gcnVucy5nZXQoa2V5KTtcbiAgbG9nKFwib3V0XCIsIGBjYW5jZWwgJHtrZXl9ICgke3JlYXNvbn0pYCwgXCJvdXRcIik7XG4gIGlmICghcikgcmV0dXJuO1xuICBydW5zLmRlbGV0ZShrZXkpO1xuICByLmFib3J0LmFib3J0KCk7XG4gIC8vIENhbmNlbGxlZCBvbiBwdXJwb3NlOiB0aGUgYWdlbnQgc3RvcHMgdG9vLiBBIGNhbGwgdGhhdCBlbmRlZCBsZWF2ZXMgYSBjb2RpbmcgYWdlbnQgd29ya2luZyBpbiBUMy5cbiAgaWYgKHJlYXNvbiA9PT0gXCJjYW5jZWxsZWRcIiAmJiAhY2hlY2tlZChcImZha2VoZXJtZXNcIikpIHtcbiAgICB2b2lkIGZldGNoKHIuYWdlbnQgPT09IFwidDNcIiA/IFwiL2FnZW50L2NhbmNlbFwiIDogXCIvaGVybWVzL3N0b3BcIiwgeyBtZXRob2Q6IFwiUE9TVFwiLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGNhbGw6IGNhbGxOYW1lLCB0YXNrSWQ6IHIudGFza0lkIH0pIH0pO1xuICB9XG59XG5cbi8qKiBNb3JlIGZvciBhIHJ1bm5pbmcgdGFzaywgaW50byBpdHMgY3VycmVudCBydW47IGlmIHRoZSBhZ2VudCB3b24ndCB0YWtlIGl0LCB0aGUgY29yZSBxdWV1ZXMgaXQgaW5zdGVhZC4gKi9cbmFzeW5jIGZ1bmN0aW9uIHN0ZWVyUnVuKGM6IENvbW1hbmQpIHtcbiAgY29uc3QgciA9IHJ1bnMuZ2V0KGMucnVuKTtcbiAgbG9nKFwib3V0XCIsIGBzdGVlciAke2MucnVufTogJHtjLnRleHR9YCwgXCJvdXRcIik7XG4gIGlmIChjaGVja2VkKFwiZmFrZWhlcm1lc1wiKSkgcmV0dXJuO1xuICBjb25zdCBvayA9IHIgIT0gbnVsbCAmJlxuICAgIChhd2FpdCBmZXRjaChjLmFnZW50ID09PSBcInQzXCIgPyBcIi9hZ2VudC9zdGVlclwiIDogXCIvaGVybWVzL3N0ZWVyXCIsIHsgbWV0aG9kOiBcIlBPU1RcIiwgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBjYWxsOiBjYWxsTmFtZSwgdGFza0lkOiByLnRhc2tJZCwgdGV4dDogYy5tZXNzYWdlIH0pIH0pLnRoZW4oKHgpID0+IHgub2ssICgpID0+IGZhbHNlKSk7XG4gIGlmICghb2spIHB1c2goeyB0eXBlOiBcInRvb2wuc3RlZXJGYWlsZWRcIiwgcnVuOiBjLnJ1biwgdGV4dDogYy50ZXh0IH0pO1xuICBlbHNlIHRvYXN0KGAke2MuYWdlbnQgPT09IFwidDNcIiA/IFwiVGhlIGNvZGluZyBhZ2VudFwiIDogXCJIZXJtZXNcIn0gdG9vayB0aGUgZm9sbG93LXVwIHdoaWxlIGl0IHdvcmtzYCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHRvb2woYzogQ29tbWFuZCkge1xuICBpZiAoYy5raW5kID09PSBcImhvc3RcIikge1xuICAgIGxvZyhcIm91dFwiLCBgaG9zdCB0b29sICR7Yy5uYW1lfSAke0pTT04uc3RyaW5naWZ5KGMuYXJncyl9YCwgXCJvdXRcIik7XG4gICAgY29uc3QgYW5zd2VyID0gYy5uYW1lID09PSBcInR2X3ZvbHVtZVwiID8gYFRoZSBUViBpcyBhdCAkeyhmYWtlVHZMZXZlbCA9IE51bWJlcihjLmFyZ3M/LmxldmVsID8/IGZha2VUdkxldmVsKSl9LmBcbiAgICAgIDogYy5uYW1lID09PSBcInR2X3BhdXNlXCIgPyAoYy5hcmdzPy5wYXVzZSA9PT0gZmFsc2UgPyBcIlBsYXlpbmcuXCIgOiBcIlBhdXNlZC5cIikgOiBcIkRvbmUuXCI7XG4gICAgc2V0VGltZW91dCgoKSA9PiBwdXNoKHsgdHlwZTogXCJ0b29sLnJlc3VsdFwiLCBydW46IGMucnVuLCB0ZXh0OiBhbnN3ZXIgfSksIDMwMCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IGFnZW50ID0gYy5hZ2VudCA9PT0gXCJ0M1wiID8gXCJ0M1wiIDogXCJoZXJtZXNcIjtcbiAgbG9nKFwib3V0XCIsIGAke2FnZW50fSAke2MuZm9sbG93VXAgPyBcImZvbGxvdy11cFwiIDogXCJ0YXNrXCJ9IFwiJHtjLmxhYmVsfVwiJHtjLnByb2plY3QgPyBgIGluICR7Yy5wcm9qZWN0fWAgOiBcIlwifTogJHtjLnJlcXVlc3R9YCwgXCJvdXRcIik7XG4gIGNvbnN0IGFib3J0ID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICBydW5zLnNldChjLnJ1biwgeyBhYm9ydCwgYWdlbnQsIHRhc2tJZDogYy50YXNrSWQgfSk7XG4gIGNvbnN0IGRvbmUgPSAodGV4dDogc3RyaW5nLCBmYWlsZWQgPSBmYWxzZSkgPT4ge1xuICAgIGlmICghcnVucy5oYXMoYy5ydW4pKSByZXR1cm47XG4gICAgcnVucy5kZWxldGUoYy5ydW4pO1xuICAgIGNvbnN0IHZpZXcgPSB0YXNrcy5nZXQoYy50YXNrSWQpO1xuICAgIGNvbnN0IHJvdyA9IHJlc3VsdChhZ2VudCwgYy5sYWJlbCwgdGV4dCwgZmFpbGVkKTtcbiAgICBub3RpZnkoYCR7YWdlbnQgPT09IFwidDNcIiA/IFwiVDNcIiA6IFwiSGVybWVzXCJ9IFx1MDBCNyAke2MubGFiZWx9YCwgdGV4dCk7XG4gICAgaWYgKCFmYWlsZWQpIHsgcmVtZW1iZXIoXCJhc3Npc3RhbnRcIiwgdGV4dCwgYCR7YWdlbnQgPT09IFwidDNcIiA/IFwiVDNcIiA6IFwiSGVybWVzXCJ9IFx1MDBCNyAke2MubGFiZWx9YCk7IGxhc3RSb2xlID0gXCJcIjsgfVxuICAgIGlmICh2aWV3KSB7IHZpZXcucmVzdWx0ID0gcm93OyBzaG93VGFza3MoKTsgfVxuICAgIHB1c2goeyB0eXBlOiBcInRvb2wucmVzdWx0XCIsIHJ1bjogYy5ydW4sIHRleHQsIGZhaWxlZCB9KTtcbiAgfTtcbiAgaWYgKGNoZWNrZWQoXCJmYWtlaGVybWVzXCIpKSB7XG4gICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IGRvbmUoYChGYWtlICR7YWdlbnQgPT09IFwidDNcIiA/IFwiVDNcIiA6IFwiSGVybWVzXCJ9KSBEb25lOiBcdTIwMUMke2MucmVxdWVzdH1cdTIwMUQuIE5vdGhpbmcgd2FzIGFjdHVhbGx5IHJ1bi5gKSwgTnVtYmVyKCQ8SFRNTElucHV0RWxlbWVudD4oXCJmYWtlZGVsYXlcIikudmFsdWUpICogMTAwMCk7XG4gICAgYWJvcnQuc2lnbmFsLm9uYWJvcnQgPSAoKSA9PiBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgIHJldHVybjtcbiAgfVxuICB0cnkge1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goYWdlbnQgPT09IFwidDNcIiA/IFwiL2FnZW50XCIgOiBcIi9oZXJtZXNcIiwge1xuICAgICAgbWV0aG9kOiBcIlBPU1RcIiwgc2lnbmFsOiBhYm9ydC5zaWduYWwsIGhlYWRlcnM6IHsgXCJjb250ZW50LXR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgY2FsbDogY2FsbE5hbWUsIHRhc2tJZDogYy50YXNrSWQsIGZvbGxvd1VwOiBjLmZvbGxvd1VwLCBtZXNzYWdlOiBjLm1lc3NhZ2UsIGxhYmVsOiBjLmxhYmVsLCByZXF1ZXN0OiBjLnJlcXVlc3QsIHByb2plY3Q6IGMucHJvamVjdCwgYXBwcm92YWxzOiBcInNjcmVlblwiIH0pLFxuICAgIH0pO1xuICAgIGlmICghcmVzcG9uc2Uub2sgfHwgIXJlc3BvbnNlLmJvZHkpIHRocm93IG5ldyBFcnJvcihgSFRUUCAke3Jlc3BvbnNlLnN0YXR1c31gKTtcbiAgICBjb25zdCByZWFkZXIgPSByZXNwb25zZS5ib2R5LnBpcGVUaHJvdWdoKG5ldyBUZXh0RGVjb2RlclN0cmVhbSgpKS5nZXRSZWFkZXIoKTtcbiAgICBsZXQgYnVmZmVyID0gXCJcIjtcbiAgICBmb3IgKDs7KSB7XG4gICAgICBjb25zdCB7IHZhbHVlLCBkb25lOiBmaW5pc2hlZCB9ID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcbiAgICAgIGlmIChmaW5pc2hlZCkgYnJlYWs7XG4gICAgICBidWZmZXIgKz0gdmFsdWU7XG4gICAgICBsZXQgY3V0O1xuICAgICAgd2hpbGUgKChjdXQgPSBidWZmZXIuaW5kZXhPZihcIlxcblxcblwiKSkgPj0gMCkge1xuICAgICAgICBjb25zdCBibG9jayA9IGJ1ZmZlci5zbGljZSgwLCBjdXQpO1xuICAgICAgICBidWZmZXIgPSBidWZmZXIuc2xpY2UoY3V0ICsgMik7XG4gICAgICAgIGNvbnN0IGV2ZW50ID0gYmxvY2subWF0Y2goL15ldmVudDogKC4qKSQvbSk/LlsxXTtcbiAgICAgICAgaWYgKCFldmVudCkgY29udGludWU7XG4gICAgICAgIGNvbnN0IGRhdGEgPSBKU09OLnBhcnNlKGJsb2NrLm1hdGNoKC9eZGF0YTogKC4qKSQvbSk/LlsxXSA/PyBcInt9XCIpO1xuICAgICAgICBpZiAoZXZlbnQgPT09IFwicHJvZ3Jlc3NcIikgcHVzaCh7IHR5cGU6IFwidGFzay5wcm9ncmVzc1wiLCB0YXNrOiBjLnRhc2tJZCwgdGV4dDogZGF0YS50ZXh0IH0pO1xuICAgICAgICBlbHNlIGlmIChldmVudCA9PT0gXCJ0aHJlYWRcIikgeyBjb25zdCB2aWV3ID0gdGFza3MuZ2V0KGMudGFza0lkKTsgaWYgKHZpZXcpIHsgdmlldy50aHJlYWQgPSBkYXRhLnRocmVhZDsgc2hvd1Rhc2tzKCk7IH0gfVxuICAgICAgICBlbHNlIGlmIChldmVudCA9PT0gXCJhcHByb3ZhbFwiKSB7XG4gICAgICAgICAgY29uc3QgdmlldyA9IHRhc2tzLmdldChjLnRhc2tJZCk7XG4gICAgICAgICAgaWYgKHZpZXcpIHsgdmlldy5hcHByb3ZhbCA9IHsgY29tbWFuZDogZGF0YS5jb21tYW5kIH07IHNob3dUYXNrcyh0cnVlKTsgfVxuICAgICAgICAgIHRvYXN0KGBIZXJtZXMgYXNrcyB0byBydW46ICR7ZGF0YS5jb21tYW5kLnNsaWNlKDAsIDgwKX1gKTtcbiAgICAgICAgICBub3RpZnkoYEhlcm1lcyBcdTAwQjcgJHtjLmxhYmVsfSBuZWVkcyB5b3VyIGFwcHJvdmFsYCwgZGF0YS5jb21tYW5kKTtcbiAgICAgICAgICBhdWRpby5jdWUoQVBQUk9WQUxfVE9ORSk7XG4gICAgICAgIH1cbiAgICAgICAgZWxzZSBpZiAoZXZlbnQgPT09IFwicmVzdWx0XCIpIGRvbmUoZGF0YS50ZXh0LCBkYXRhLmZhaWxlZCk7XG4gICAgICAgIGVsc2UgaWYgKGV2ZW50ID09PSBcImVycm9yXCIpIHsgcnVucy5kZWxldGUoYy5ydW4pOyBwdXNoKHsgdHlwZTogXCJ0b29sLmVycm9yXCIsIHJ1bjogYy5ydW4sIG1lc3NhZ2U6IGRhdGEubWVzc2FnZSB9KTsgfVxuICAgICAgfVxuICAgIH1cbiAgICBpZiAocnVucy5oYXMoYy5ydW4pKSB7IHJ1bnMuZGVsZXRlKGMucnVuKTsgcHVzaCh7IHR5cGU6IFwidG9vbC5lcnJvclwiLCBydW46IGMucnVuLCBtZXNzYWdlOiBcInRoZSBzZXJ2ZXIgY2xvc2VkIHRoZSBzdHJlYW0gd2l0aG91dCBhIHJlc3VsdFwiIH0pOyB9XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGlmICghYWJvcnQuc2lnbmFsLmFib3J0ZWQgJiYgcnVucy5oYXMoYy5ydW4pKSB7IHJ1bnMuZGVsZXRlKGMucnVuKTsgcHVzaCh7IHR5cGU6IFwidG9vbC5lcnJvclwiLCBydW46IGMucnVuLCBtZXNzYWdlOiAoZXJyIGFzIEVycm9yKS5tZXNzYWdlIH0pOyB9XG4gIH1cbn1cblxuZnVuY3Rpb24gbWljT3B0aW9ucygpIHtcbiAgY29uc3QgYWVjID0gY2hlY2tlZChcImFlY1wiKTtcbiAgcmV0dXJuIHsgZWNob0NhbmNlbGxhdGlvbjogYWVjLCBub2lzZVN1cHByZXNzaW9uOiBhZWMsIGF1dG9HYWluQ29udHJvbDogYWVjIH07XG59XG5cbmZ1bmN0aW9uIHJlYWRDb25maWcoKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICBjb25zdCBnaXZlbiA9IEpTT04ucGFyc2UoJDxIVE1MVGV4dEFyZWFFbGVtZW50PihcImNvbmZpZ1wiKS52YWx1ZSk7XG4gIGNvbnN0IGNvbmZpZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgbW9kZWw6IHNlcnZlci5tb2RlbCwgYXBpOiBzZXJ2ZXIucm91dGUgPT09IFwidmVydGV4XCIgPyBcInZlcnRleFwiIDogXCJnZW1pbmlcIiwgdG9kYXk6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKS5zbGljZSgwLCAxMCksXG4gICAgLi4uZ2l2ZW4sIHRyYWNlOiBjaGVja2VkKFwidHJhY2VcIiksXG4gIH07XG4gIGlmIChjaGVja2VkKFwicHR0XCIpKSBjb25maWcubXV0ZWQgPSB0cnVlO1xuICBpZiAoZ2l2ZW4udm9pY2UgPT09IHVuZGVmaW5lZCkgY29uZmlnLnZvaWNlID0gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJ2b2ljZVwiKS52YWx1ZTtcbiAgaWYgKGNvbmZpZy5zdGVlcmluZyA9PT0gdW5kZWZpbmVkKSBjb25maWcuc3RlZXJpbmcgPSBbXCJoZXJtZXNcIiwgXCJ0M1wiXTtcbiAgaWYgKGNoZWNrZWQoXCJjb2RpbmdcIikgJiYgKHNlcnZlci50MyB8fCBjaGVja2VkKFwiZmFrZWhlcm1lc1wiKSkgJiYgY29uZmlnLmNvZGluZ0FnZW50ID09PSB1bmRlZmluZWQpIGNvbmZpZy5jb2RpbmdBZ2VudCA9IHsgcHJvamVjdHM6IHNlcnZlci50MyA/PyBbXSB9O1xuICByZXR1cm4gY29uZmlnO1xufVxuXG5hc3luYyBmdW5jdGlvbiBzdGFydChjYXJyeU9uID0gZmFsc2UpIHtcbiAgaWYgKGNhbGxJZCkgcmV0dXJuO1xuICBsZXQgZ2l2ZW46IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICB0cnkge1xuICAgIGdpdmVuID0gcmVhZENvbmZpZygpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICB0b2FzdChgVGhlIGRldmVsb3BlciBzZXR0aW5ncyBhcmVuJ3QgdmFsaWQgSlNPTjogJHsoZXJyIGFzIEVycm9yKS5tZXNzYWdlfWApO1xuICAgIHJldHVybjtcbiAgfVxuICAkPEhUTUxCdXR0b25FbGVtZW50PihcImNhbGxcIikuZGlzYWJsZWQgPSB0cnVlO1xuICBpZiAoXCJOb3RpZmljYXRpb25cIiBpbiB3aW5kb3cgJiYgTm90aWZpY2F0aW9uLnBlcm1pc3Npb24gPT09IFwiZGVmYXVsdFwiKSB2b2lkIE5vdGlmaWNhdGlvbi5yZXF1ZXN0UGVybWlzc2lvbigpLmNhdGNoKCgpID0+IHt9KTtcbiAgdHJ5IHtcbiAgICBhd2FpdCBhdWRpby5vcGVuKCk7XG4gICAgY29yZSA9IGF3YWl0IGxvYWRDb3JlKCk7XG4gIH0gZmluYWxseSB7XG4gICAgJDxIVE1MQnV0dG9uRWxlbWVudD4oXCJjYWxsXCIpLmRpc2FibGVkID0gZmFsc2U7XG4gIH1cbiAgJChcInZlcnNpb25cIikudGV4dENvbnRlbnQgPSBjb3JlLnZlcnNpb247XG4gICQoXCJsb2dcIikuaW5uZXJIVE1MID0gXCJcIjtcbiAgaWYgKHRhc2tzLnNpemUgPiAwIHx8ICQoXCJ0cmFuc2NyaXB0XCIpLmNoaWxkRWxlbWVudENvdW50ID4gMSkgbm90ZShgTmV3IGNhbGwgXHUwMEI3ICR7bmV3IERhdGUoKS50b0xvY2FsZVRpbWVTdHJpbmcoKX1gKTtcbiAgdGFza3MuY2xlYXIoKTtcbiAgc2hvd1Rhc2tzKCk7XG4gIGNvdW50cyA9IHsgbWljOiAwLCBwbGF5OiAwLCBzZW50OiAwIH07XG4gIG1ldHJpY3MucmVwbHkgPSBbXTtcbiAgc3RhcnRlZEF0ID0gbm93KCk7XG4gIG11dGVkID0gZ2l2ZW4ubXV0ZWQgPT09IHRydWU7XG4gIC8vIENhcnJ5aW5nIG9uOiB0aGUgbW9kZWwgZ2V0cyB0aGUgbGFzdCBjb252ZXJzYXRpb24gYXMgYSByZWNhcC4gVGhlIGNvcmUgY2FwcyBpdCwgbGF0ZXN0IGxpbmVzIGZpcnN0LlxuICBpZiAoY2FycnlPbiAmJiBnaXZlbi5oaXN0b3J5ID09PSB1bmRlZmluZWQpIGdpdmVuLmhpc3RvcnkgPSBzYXZlZEhpc3RvcnkoKTtcbiAgZWxzZSBpZiAoIWNhcnJ5T24pIGNoYXQgPSBbXTtcbiAgaWYgKGNhcnJ5T24pIGNoYXQgPSBzYXZlZEhpc3RvcnkoKTtcbiAgbGFzdFJvbGUgPSBcIlwiO1xuICAkKFwicmVzdW1lXCIpLmhpZGRlbiA9IHRydWU7XG4gIGNhbGxOYW1lID0gYCR7bmV3IERhdGUoKS50b0lTT1N0cmluZygpLnJlcGxhY2UoL1s6Ll0vZywgXCItXCIpfS13ZWItJHtjb3JlLnZlcnNpb259YDtcbiAgY29uc3QgY3JlYXRlZCA9IEpTT04ucGFyc2UoY29yZS5jcmVhdGUoSlNPTi5zdHJpbmdpZnkoZ2l2ZW4pLCBub3coKSkpO1xuICBjYWxsSWQgPSBjcmVhdGVkLmlkO1xuICAkPEhUTUxCdXR0b25FbGVtZW50PihcImNhbGxcIikudGV4dENvbnRlbnQgPSBcIkhhbmcgdXBcIjtcbiAgJChcImNhbGxcIikuY2xhc3NMaXN0LmFkZChcImxpdmVcIik7XG4gIGZvciAoY29uc3QgaWQgb2YgW1wibWljXCIsIFwiaHVzaFwiXSkgJDxIVE1MQnV0dG9uRWxlbWVudD4oaWQpLmRpc2FibGVkID0gZmFsc2U7XG4gICQoXCJtaWNcIikuY2xhc3NMaXN0LnRvZ2dsZShcIm11dGVkXCIsIG11dGVkKTtcbiAgcnVuKGNyZWF0ZWQuY29tbWFuZHMpO1xuICB0aWNrZXIgPSB3aW5kb3cuc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgIHB1c2goeyB0eXBlOiBcInRpY2tcIiB9KTtcbiAgICBjb25zdCBsZXZlbCA9IG11dGVkICYmICFob2xkaW5nID8gMCA6IGF1ZGlvLmxldmVsO1xuICAgICQoXCJyaW5nXCIpLnN0eWxlLm9wYWNpdHkgPSBTdHJpbmcoTWF0aC5taW4oMSwgbGV2ZWwgKiAxMikpO1xuICAgICQoXCJjb3VudHNcIikudGV4dENvbnRlbnQgPSBgbWljICR7Y291bnRzLm1pY30gXHUwMEI3IHNlbnQgJHtjb3VudHMuc2VudH0gXHUwMEI3IHBsYXllZCAke2NvdW50cy5wbGF5fSBcdTAwQjcgcXVldWVkICR7YXVkaW8ucXVldWVkLnRvRml4ZWQoMSl9IHNgO1xuICAgIHNob3dTdGF0dXMoKTtcbiAgfSwgMTAwKTtcbiAgdHJhY2VUaW1lciA9IHdpbmRvdy5zZXRJbnRlcnZhbCgoKSA9PiB7IHZvaWQgc2F2ZVRyYWNlKCk7IHZvaWQgcGluZygpOyBzaG93VGFza3MoKTsgfSwgNTAwMCk7XG4gIHZvaWQgcGluZygpO1xuICBzdG9wV29yZHMuc3RhcnQoKTtcbiAgdHJ5IHsgd2FrZUxvY2sgPSBhd2FpdCAobmF2aWdhdG9yIGFzIGFueSkud2FrZUxvY2s/LnJlcXVlc3QoXCJzY3JlZW5cIik7IH0gY2F0Y2gge31cbn1cblxuZnVuY3Rpb24gaGFuZ1VwKCkge1xuICBpZiAoY2FsbElkKSBwdXNoKHsgdHlwZTogXCJzdG9wXCIsIG1lc3NhZ2U6IFwiWW91IGh1bmcgdXAuXCIgfSk7XG59XG5cbmZ1bmN0aW9uIGVuZCgpIHtcbiAgd2luZG93LmNsZWFySW50ZXJ2YWwodGlja2VyKTtcbiAgd2luZG93LmNsZWFySW50ZXJ2YWwodHJhY2VUaW1lcik7XG4gIHN0b3BXb3Jkcy5zdG9wKCk7XG4gIHZvaWQgc2F2ZVRyYWNlKCkudGhlbigoKSA9PiB7IGlmIChjb3JlICYmIGNhbGxJZCkgY29yZS5kaXNwb3NlKGNhbGxJZCk7IGNhbGxJZCA9IDA7IHNob3dUYXNrcygpOyB9KTtcbiAgYXVkaW8uc3RvcCgpO1xuICBmb3IgKGNvbnN0IHdzIG9mIHNvY2tldHMudmFsdWVzKCkpIHdzLmNsb3NlKCk7XG4gIHNvY2tldHMuY2xlYXIoKTtcbiAgZm9yIChjb25zdCByIG9mIHJ1bnMudmFsdWVzKCkpIHIuYWJvcnQuYWJvcnQoKTtcbiAgcnVucy5jbGVhcigpO1xuICAkPEhUTUxCdXR0b25FbGVtZW50PihcImNhbGxcIikudGV4dENvbnRlbnQgPSBcIkNhbGxcIjtcbiAgJChcImNhbGxcIikuY2xhc3NMaXN0LnJlbW92ZShcImxpdmVcIik7XG4gIGZvciAoY29uc3QgaWQgb2YgW1wibWljXCIsIFwiaHVzaFwiXSkgJDxIVE1MQnV0dG9uRWxlbWVudD4oaWQpLmRpc2FibGVkID0gdHJ1ZTtcbiAgJChcInJpbmdcIikuc3R5bGUub3BhY2l0eSA9IFwiMFwiO1xuICAkKFwicmVzdW1lXCIpLmhpZGRlbiA9IGNoYXQubGVuZ3RoID09PSAwO1xuICB2b2lkIHNob3dFYXJsaWVyKCk7XG4gIHZvaWQgd2FrZUxvY2s/LnJlbGVhc2UoKS5jYXRjaCgoKSA9PiB7fSk7XG4gIHdha2VMb2NrID0gbnVsbDtcbn1cblxuZnVuY3Rpb24gc2V0TXV0ZWQodmFsdWU6IGJvb2xlYW4pIHtcbiAgaWYgKCFjYWxsSWQgfHwgbXV0ZWQgPT09IHZhbHVlKSByZXR1cm47XG4gIG11dGVkID0gdmFsdWU7XG4gICQoXCJtaWNcIikuY2xhc3NMaXN0LnRvZ2dsZShcIm11dGVkXCIsIG11dGVkKTtcbiAgcHVzaCh7IHR5cGU6IG11dGVkID8gXCJtdXRlXCIgOiBcInVubXV0ZVwiIH0pO1xuICBzaG93U3RhdHVzKCk7XG59XG5cbi8qKiBTZW5kcyB3aGF0IHRoZSB0cmFjZSBrZXB0IHNpbmNlIGxhc3QgdGltZSB0byB0aGUgZGV2IHNlcnZlciwgYXMgSlNPTiBsaW5lczogYSBoZWFkZXIsIHRoZW4gZXZlbnRzLiAqL1xuYXN5bmMgZnVuY3Rpb24gc2F2ZVRyYWNlKCkge1xuICBpZiAoIWNvcmUgfHwgIWNhbGxJZCB8fCAhY2hlY2tlZChcInRyYWNlXCIpKSByZXR1cm47XG4gIGNvbnN0IGtlcHQgPSBKU09OLnBhcnNlKGNvcmUudHJhY2UoY2FsbElkKSk7XG4gIGlmICgha2VwdCkgcmV0dXJuO1xuICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcbiAgaWYgKGtlcHQuY29uZmlnKSBsaW5lcy5wdXNoKEpTT04uc3RyaW5naWZ5KHsgdmVyc2lvbjoga2VwdC52ZXJzaW9uLCBjb25maWc6IGtlcHQuY29uZmlnLCBzdGFydDoga2VwdC5zdGFydCB9KSk7XG4gIGZvciAoY29uc3QgZSBvZiBrZXB0LmV2ZW50cykgbGluZXMucHVzaChKU09OLnN0cmluZ2lmeShlKSk7XG4gIGlmIChsaW5lcy5sZW5ndGggPT09IDApIHJldHVybjtcbiAgYXdhaXQgZmV0Y2goYC90cmFjZXM/bmFtZT0ke2VuY29kZVVSSUNvbXBvbmVudChjYWxsTmFtZSl9Lmpzb25sYCwgeyBtZXRob2Q6IFwiUE9TVFwiLCBib2R5OiBsaW5lcy5qb2luKFwiXFxuXCIpICsgXCJcXG5cIiB9KS5jYXRjaCgoKSA9PiB7fSk7XG4gICQoXCJ0cmFjZW5hbWVcIikudGV4dENvbnRlbnQgPSBgdHJhY2UgJHtjYWxsTmFtZX0uanNvbmxgO1xufVxuXG4vLyBcIlN0b3BcIiBhbmQgXCJnb29kYnllXCIgaGVhcmQgYnkgdGhlIGJyb3dzZXIncyBvd24gcmVjb2duaXplcjogcXVpY2tlciB0aGFuIHRoZSBtb2RlbCdzIHRyYW5zY3JpcHQsXG4vLyBhbmQgaXQgd29ya3Mgd2hpbGUgdGhlIG1vZGVsJ3MgcmVwbHkgcGxheXMgZXZlbiB3aGVuIHRoZSBtb2RlbCBpc24ndCBoZWFyaW5nIHRoZSBtaWNyb3Bob25lLlxuXG5jbGFzcyBTdG9wV29yZHMge1xuICBwcml2YXRlIHJlYzogYW55ID0gbnVsbDtcbiAgcHJpdmF0ZSBvbiA9IGZhbHNlO1xuICBwcml2YXRlIGNvbW1hbmRzID0geyBzdG9wOiBbXSBhcyBzdHJpbmdbXSwgaGFuZ1VwOiBbXSBhcyBzdHJpbmdbXSwgY2FuY2VsQWxsOiBbXSBhcyBzdHJpbmdbXSB9O1xuXG4gIGdldCBzdXBwb3J0ZWQoKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIFwid2Via2l0U3BlZWNoUmVjb2duaXRpb25cIiBpbiB3aW5kb3cgfHwgXCJTcGVlY2hSZWNvZ25pdGlvblwiIGluIHdpbmRvdztcbiAgfVxuXG4gIHN0YXJ0KCkge1xuICAgIGlmICghY2hlY2tlZChcInN0b3B3b3JkXCIpIHx8ICF0aGlzLnN1cHBvcnRlZCB8fCAhY29yZSkgcmV0dXJuO1xuICAgIHRoaXMuY29tbWFuZHMgPSBKU09OLnBhcnNlKGNvcmUuZGVmYXVsdHMoKSkudm9pY2VDb21tYW5kcztcbiAgICBjb25zdCBSZWNvZ25pdGlvbiA9ICh3aW5kb3cgYXMgYW55KS5TcGVlY2hSZWNvZ25pdGlvbiA/PyAod2luZG93IGFzIGFueSkud2Via2l0U3BlZWNoUmVjb2duaXRpb247XG4gICAgdGhpcy5yZWMgPSBuZXcgUmVjb2duaXRpb24oKTtcbiAgICB0aGlzLnJlYy5jb250aW51b3VzID0gdHJ1ZTtcbiAgICB0aGlzLnJlYy5pbnRlcmltUmVzdWx0cyA9IHRydWU7XG4gICAgdGhpcy5yZWMubGFuZyA9IG5hdmlnYXRvci5sYW5ndWFnZSB8fCBcImVuLUdCXCI7XG4gICAgdGhpcy5yZWMub25yZXN1bHQgPSAoZTogYW55KSA9PiB7XG4gICAgICBmb3IgKGxldCBpID0gZS5yZXN1bHRJbmRleDsgaSA8IGUucmVzdWx0cy5sZW5ndGg7IGkrKykge1xuICAgICAgICBjb25zdCB0ZXh0ID0gZS5yZXN1bHRzW2ldWzBdLnRyYW5zY3JpcHQgYXMgc3RyaW5nO1xuICAgICAgICBjb25zdCBjb21tYW5kID0gY29tbWFuZEluKHRleHQsIHRoaXMuY29tbWFuZHMsIFtcIldvb2Rob3VzZVwiLCBcIkhlcm1lc1wiLCBcIkJlbnRvXCJdKTtcbiAgICAgICAgaWYgKGNvbW1hbmQgPT09IFwic3RvcFwiICYmIGF1ZGlvLnF1ZXVlZCA+IDAuMDUpIHtcbiAgICAgICAgICBsb2coXCJvdXRcIiwgYGxvY2FsIHN0b3Agd29yZDogJHt0ZXh0fWAsIFwib3V0XCIpO1xuICAgICAgICAgIHRvYXN0KGBIZWFyZCBcdTIwMUMke3RleHQudHJpbSgpfVx1MjAxRDogc3RvcHBlZGApO1xuICAgICAgICAgIHB1c2goeyB0eXBlOiBcImludGVycnVwdFwiIH0pO1xuICAgICAgICB9IGVsc2UgaWYgKGNvbW1hbmQgPT09IFwiY2FuY2VsQWxsXCIgJiYgZS5yZXN1bHRzW2ldLmlzRmluYWwpIHtcbiAgICAgICAgICBsb2coXCJvdXRcIiwgYGxvY2FsIGNhbmNlbC1hbGw6ICR7dGV4dH1gLCBcIm91dFwiKTtcbiAgICAgICAgICBwdXNoKHsgdHlwZTogXCJjYW5jZWxBbGxcIiB9KTtcbiAgICAgICAgICBwdXNoKHsgdHlwZTogXCJpbnRlcnJ1cHRcIiB9KTtcbiAgICAgICAgfSBlbHNlIGlmIChjb21tYW5kID09PSBcImhhbmdVcFwiICYmIGUucmVzdWx0c1tpXS5pc0ZpbmFsKSB7XG4gICAgICAgICAgbG9nKFwib3V0XCIsIGBsb2NhbCBoYW5nLXVwOiAke3RleHR9YCwgXCJvdXRcIik7XG4gICAgICAgICAgaGFuZ1VwKCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9O1xuICAgIHRoaXMucmVjLm9uZW5kID0gKCkgPT4geyBpZiAodGhpcy5vbikgc2V0VGltZW91dCgoKSA9PiB7IHRyeSB7IHRoaXMucmVjPy5zdGFydCgpOyB9IGNhdGNoIHt9IH0sIDI1MCk7IH07XG4gICAgdGhpcy5yZWMub25lcnJvciA9IChlOiBhbnkpID0+IHsgaWYgKGUuZXJyb3IgPT09IFwibm90LWFsbG93ZWRcIikgdGhpcy5vbiA9IGZhbHNlOyB9O1xuICAgIHRoaXMub24gPSB0cnVlO1xuICAgIHRyeSB7IHRoaXMucmVjLnN0YXJ0KCk7IH0gY2F0Y2gge31cbiAgfVxuXG4gIHN0b3AoKSB7XG4gICAgdGhpcy5vbiA9IGZhbHNlO1xuICAgIHRyeSB7IHRoaXMucmVjPy5zdG9wKCk7IH0gY2F0Y2gge31cbiAgICB0aGlzLnJlYyA9IG51bGw7XG4gIH1cbn1cbmNvbnN0IHN0b3BXb3JkcyA9IG5ldyBTdG9wV29yZHMoKTtcblxuLy8gV2lyaW5nLlxuXG5mdW5jdGlvbiBzZXR0aW5nc0Zyb21TdG9yYWdlKCkge1xuICBmb3IgKGNvbnN0IGlkIG9mIFtcImFlY1wiLCBcInN0b3B3b3JkXCIsIFwicHR0XCIsIFwiY29kaW5nXCIsIFwiZmFrZWhlcm1lc1wiLCBcInRyYWNlXCJdKSB7XG4gICAgY29uc3QgdiA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKGB2b2ljZS4ke2lkfWApO1xuICAgIGlmICh2ICE9IG51bGwpICQ8SFRNTElucHV0RWxlbWVudD4oaWQpLmNoZWNrZWQgPSB2ID09PSBcIjFcIjtcbiAgICAkKGlkKS5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IGxvY2FsU3RvcmFnZS5zZXRJdGVtKGB2b2ljZS4ke2lkfWAsIGNoZWNrZWQoaWQpID8gXCIxXCIgOiBcIjBcIikpO1xuICB9XG4gIGNvbnN0IGRlbGF5ID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS5mYWtlZGVsYXlcIik7XG4gIGlmIChkZWxheSkgJDxIVE1MSW5wdXRFbGVtZW50PihcImZha2VkZWxheVwiKS52YWx1ZSA9IGRlbGF5O1xuICAkKFwiZmFrZWRlbGF5XCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4gbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS5mYWtlZGVsYXlcIiwgJDxIVE1MSW5wdXRFbGVtZW50PihcImZha2VkZWxheVwiKS52YWx1ZSkpO1xuICBjb25zdCB2b2ljZSA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2Uudm9pY2VcIik7XG4gIGlmICh2b2ljZSkgJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJ2b2ljZVwiKS52YWx1ZSA9IHZvaWNlO1xuICAkKFwidm9pY2VcIikuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLnZvaWNlXCIsICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwidm9pY2VcIikudmFsdWUpKTtcbiAgY29uc3QgbW9kZSA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UubW9kZVwiKTtcbiAgaWYgKG1vZGUpICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwibW9kZVwiKS52YWx1ZSA9IG1vZGU7XG4gICQoXCJtb2RlXCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4gbG9jYWxTdG9yYWdlLnNldEl0ZW0oXCJ2b2ljZS5tb2RlXCIsICQ8SFRNTFNlbGVjdEVsZW1lbnQ+KFwibW9kZVwiKS52YWx1ZSkpO1xufVxuXG5mdW5jdGlvbiB0YWJzKCkge1xuICBjb25zdCB2aWV3czogUmVjb3JkPHN0cmluZywgSFRNTEVsZW1lbnQ+ID0geyB0YWxrOiAkKFwidGFsa1wiKSwgZGV2OiAkKFwiZGV2XCIpLCByZXBsYXk6ICQoXCJyZXBsYXltYWluXCIpIH07XG4gIGZvciAoY29uc3QgbmFtZSBvZiBPYmplY3Qua2V5cyh2aWV3cykpIHtcbiAgICAkKGB0YWItJHtuYW1lfWApLm9uY2xpY2sgPSAoKSA9PiB7XG4gICAgICBmb3IgKGNvbnN0IFtvdGhlciwgZWxdIG9mIE9iamVjdC5lbnRyaWVzKHZpZXdzKSkge1xuICAgICAgICBlbC5oaWRkZW4gPSBvdGhlciAhPT0gbmFtZTtcbiAgICAgICAgJChgdGFiLSR7b3RoZXJ9YCkuY2xhc3NMaXN0LnRvZ2dsZShcIm9uXCIsIG90aGVyID09PSBuYW1lKTtcbiAgICAgIH1cbiAgICB9O1xuICB9XG4gICQoXCJnZWFyXCIpLm9uY2xpY2sgPSAoKSA9PiB7ICQoXCJzZXR0aW5nc1wiKS5oaWRkZW4gPSBmYWxzZTsgfTtcbiAgJChcImNsb3Nlc2V0dGluZ3NcIikub25jbGljayA9ICgpID0+IHsgJChcInNldHRpbmdzXCIpLmhpZGRlbiA9IHRydWU7IH07XG4gICQoXCJzZXR0aW5nc1wiKS5vbmNsaWNrID0gKGUpID0+IHsgaWYgKGUudGFyZ2V0ID09PSAkKFwic2V0dGluZ3NcIikpICQoXCJzZXR0aW5nc1wiKS5oaWRkZW4gPSB0cnVlOyB9O1xufVxuXG5mdW5jdGlvbiB0eXBpbmcoKTogYm9vbGVhbiB7XG4gIGNvbnN0IGVsID0gZG9jdW1lbnQuYWN0aXZlRWxlbWVudCBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gIHJldHVybiAhIWVsICYmIChlbC50YWdOYW1lID09PSBcIklOUFVUXCIgfHwgZWwudGFnTmFtZSA9PT0gXCJURVhUQVJFQVwiIHx8IGVsLnRhZ05hbWUgPT09IFwiU0VMRUNUXCIgfHwgZWwuaXNDb250ZW50RWRpdGFibGUpO1xufVxuXG5mdW5jdGlvbiBrZXlzKCkge1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCAoZSkgPT4ge1xuICAgIGlmIChlLmtleSA9PT0gXCJFc2NhcGVcIiAmJiBjYWxsSWQpIHsgcHVzaCh7IHR5cGU6IFwiaW50ZXJydXB0XCIgfSk7IGF1ZGlvLmZsdXNoKCk7IHJldHVybjsgfVxuICAgIGlmICh0eXBpbmcoKSB8fCBlLm1ldGFLZXkgfHwgZS5jdHJsS2V5IHx8IGUuYWx0S2V5KSByZXR1cm47XG4gICAgaWYgKGUua2V5ID09PSBcIm1cIiB8fCBlLmtleSA9PT0gXCJNXCIpIHsgc2V0TXV0ZWQoIW11dGVkKTsgZS5wcmV2ZW50RGVmYXVsdCgpOyB9XG4gICAgZWxzZSBpZiAoZS5rZXkgPT09IFwiL1wiKSB7ICQoXCJ0ZXh0XCIpLmZvY3VzKCk7IGUucHJldmVudERlZmF1bHQoKTsgfVxuICAgIGVsc2UgaWYgKGUuY29kZSA9PT0gXCJTcGFjZVwiICYmIGNhbGxJZCAmJiBtdXRlZCAmJiAhZS5yZXBlYXQpIHsgaG9sZGluZyA9IHRydWU7IHB1c2goeyB0eXBlOiBcInVubXV0ZVwiIH0pOyBzaG93U3RhdHVzKCk7IGUucHJldmVudERlZmF1bHQoKTsgfVxuICB9KTtcbiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcImtleXVwXCIsIChlKSA9PiB7XG4gICAgaWYgKGUuY29kZSA9PT0gXCJTcGFjZVwiICYmIGhvbGRpbmcpIHsgaG9sZGluZyA9IGZhbHNlOyBwdXNoKHsgdHlwZTogXCJtdXRlXCIgfSk7IHNob3dTdGF0dXMoKTsgfVxuICB9KTtcbn1cblxuZnVuY3Rpb24gc3VibWl0VGV4dChlOiBFdmVudCkge1xuICBlLnByZXZlbnREZWZhdWx0KCk7XG4gIGNvbnN0IGlucHV0ID0gJDxIVE1MSW5wdXRFbGVtZW50PihcInRleHRcIik7XG4gIGxldCB0ZXh0ID0gaW5wdXQudmFsdWUudHJpbSgpO1xuICBpZiAoIXRleHQpIHJldHVybjtcbiAgaWYgKCFjYWxsSWQpIHsgdG9hc3QoXCJTdGFydCBhIGNhbGwgZmlyc3RcIik7IHJldHVybjsgfVxuICAvLyBcIi90MyBcdTIwMjZcIiBhbmQgXCIvaCBcdTIwMjZcIiBwaWNrIHRoZSBhZ2VudCB3aGF0ZXZlciB0aGUgc2VsZWN0b3Igc2F5cy5cbiAgbGV0IG1vZGUgPSAkPEhUTUxTZWxlY3RFbGVtZW50PihcIm1vZGVcIikudmFsdWU7XG4gIGNvbnN0IHByZWZpeCA9IHRleHQubWF0Y2goL15cXC8odDN8Y29kZXxofGhlcm1lcylcXHMrL2kpO1xuICBpZiAocHJlZml4KSB7IG1vZGUgPSAvXih0M3xjb2RlKSQvaS50ZXN0KHByZWZpeFsxXSkgPyBcInQzXCIgOiBcImhlcm1lc1wiOyB0ZXh0ID0gdGV4dC5zbGljZShwcmVmaXhbMF0ubGVuZ3RoKS50cmltKCk7IH1cbiAgaWYgKCF0ZXh0KSByZXR1cm47XG4gIGlmIChtb2RlID09PSBcInNheVwiKSBwdXNoKHsgdHlwZTogXCJzYXlcIiwgdGV4dCB9KTtcbiAgZWxzZSB7XG4gICAgcHVzaCh7IHR5cGU6IFwiYXNrXCIsIHRleHQsIGFnZW50OiBtb2RlIH0pO1xuICAgIG5vdGUoYFlvdSBcdTIxOTIgbmV3ICR7bW9kZSA9PT0gXCJ0M1wiID8gXCJjb2RpbmdcIiA6IFwiSGVybWVzXCJ9IHRhc2s6ICR7dGV4dH1gKTtcbiAgfVxuICBpbnB1dC52YWx1ZSA9IFwiXCI7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIG1haW4oKSB7XG4gIHNlcnZlciA9IGF3YWl0IChhd2FpdCBmZXRjaChcIi9jb25maWdcIikpLmpzb24oKTtcbiAgJChcInJvdXRlXCIpLnRleHRDb250ZW50ID0gYCR7c2VydmVyLnJvdXRlID09PSBcInZlcnRleFwiID8gXCJHU0sgVmVydGV4XCIgOiBcIkdlbWluaSBBUElcIn0gXHUwMEI3ICR7c2VydmVyLm1vZGVsLnNwbGl0KFwiL1wiKS5wb3AoKX1gO1xuICAkKFwidmVyc2lvblwiKS50ZXh0Q29udGVudCA9IHNlcnZlci52ZXJzaW9uO1xuICAkKFwiYnVpbGRcIikudGV4dENvbnRlbnQgPSBgY29yZSAke3NlcnZlci52ZXJzaW9ufWA7XG4gIHNldHRpbmdzRnJvbVN0b3JhZ2UoKTtcbiAgaWYgKCFzZXJ2ZXIuaGVybWVzKSB7ICQ8SFRNTElucHV0RWxlbWVudD4oXCJmYWtlaGVybWVzXCIpLmNoZWNrZWQgPSB0cnVlOyAkPEhUTUxJbnB1dEVsZW1lbnQ+KFwiZmFrZWhlcm1lc1wiKS5kaXNhYmxlZCA9IHRydWU7IH1cbiAgaWYgKCFzZXJ2ZXIudDMpICQoXCJjb2RpbmdoZWxwXCIpLnRleHRDb250ZW50ID0gXCJUMyBpc24ndCBhdmFpbGFibGUgb24gdGhlIHNlcnZlcjogb25seSB3aXRoIGZha2UgYW5zd2Vycy5cIjtcbiAgZWxzZSAkKFwiY29kaW5naGVscFwiKS50ZXh0Q29udGVudCA9IGBDb2RlIGNoYW5nZXMgZ28gdG8gYSBUMyBDb2RlIHRocmVhZCBpbiBvbmUgb2Y6ICR7c2VydmVyLnQzLmpvaW4oXCIsIFwiKX0uYDtcbiAgaWYgKCFzdG9wV29yZHMuc3VwcG9ydGVkKSB7ICQ8SFRNTElucHV0RWxlbWVudD4oXCJzdG9wd29yZFwiKS5jaGVja2VkID0gZmFsc2U7ICQ8SFRNTElucHV0RWxlbWVudD4oXCJzdG9wd29yZFwiKS5kaXNhYmxlZCA9IHRydWU7IH1cbiAgY29uc3QgcHJlc2V0ID0gJDxIVE1MU2VsZWN0RWxlbWVudD4oXCJwcmVzZXRcIik7XG4gIGZvciAoY29uc3QgbmFtZSBvZiBPYmplY3Qua2V5cyhQUkVTRVRTKSkgcHJlc2V0LmFkZChuZXcgT3B0aW9uKG5hbWUsIG5hbWUpKTtcbiAgcHJlc2V0LnZhbHVlID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJ2b2ljZS1jb3JlLnByZXNldFwiKSA/PyBcIndlYlwiO1xuICBpZiAoIVBSRVNFVFNbcHJlc2V0LnZhbHVlXSkgcHJlc2V0LnZhbHVlID0gXCJ3ZWJcIjtcbiAgJDxIVE1MVGV4dEFyZWFFbGVtZW50PihcImNvbmZpZ1wiKS52YWx1ZSA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFwidm9pY2UtY29yZS5jb25maWdcIikgPz8gSlNPTi5zdHJpbmdpZnkoUFJFU0VUU1twcmVzZXQudmFsdWVdLCBudWxsLCAyKTtcbiAgcHJlc2V0Lm9uY2hhbmdlID0gKCkgPT4ge1xuICAgICQ8SFRNTFRleHRBcmVhRWxlbWVudD4oXCJjb25maWdcIikudmFsdWUgPSBKU09OLnN0cmluZ2lmeShQUkVTRVRTW3ByZXNldC52YWx1ZV0sIG51bGwsIDIpO1xuICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFwidm9pY2UtY29yZS5wcmVzZXRcIiwgcHJlc2V0LnZhbHVlKTtcbiAgICBsb2NhbFN0b3JhZ2UucmVtb3ZlSXRlbShcInZvaWNlLWNvcmUuY29uZmlnXCIpO1xuICB9O1xuICAkKFwiY29uZmlnXCIpLm9uaW5wdXQgPSAoKSA9PiBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcInZvaWNlLWNvcmUuY29uZmlnXCIsICQ8SFRNTFRleHRBcmVhRWxlbWVudD4oXCJjb25maWdcIikudmFsdWUpO1xuICAkKFwiZGVmYXVsdHNcIikub25jbGljayA9IGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBjID0gY29yZSA/PyAoYXdhaXQgbG9hZENvcmUoKSk7XG4gICAgJChcImRlZmF1bHRzdmlld1wiKS50ZXh0Q29udGVudCA9IEpTT04uc3RyaW5naWZ5KEpTT04ucGFyc2UoYy5kZWZhdWx0cygpKSwgbnVsbCwgMik7XG4gICAgJChcImRlZmF1bHRzdmlld1wiKS5oaWRkZW4gPSAhJChcImRlZmF1bHRzdmlld1wiKS5oaWRkZW47XG4gIH07XG4gICQoXCJjYWxsXCIpLm9uY2xpY2sgPSAoKSA9PiAoY2FsbElkID8gaGFuZ1VwKCkgOiB2b2lkIHN0YXJ0KCkuY2F0Y2goKGVycikgPT4geyB0b2FzdChlcnIubWVzc2FnZSk7IGxvZyhcImVycm9yXCIsIGVyci5tZXNzYWdlLCBcImVyclwiKTsgfSkpO1xuICAkKFwicmVzdW1lXCIpLm9uY2xpY2sgPSAoKSA9PiB2b2lkIHN0YXJ0KHRydWUpLmNhdGNoKChlcnIpID0+IHsgdG9hc3QoZXJyLm1lc3NhZ2UpOyBsb2coXCJlcnJvclwiLCBlcnIubWVzc2FnZSwgXCJlcnJcIik7IH0pO1xuICBpZiAoc2F2ZWRIaXN0b3J5KCkubGVuZ3RoID4gMCkgeyAkKFwicmVzdW1lXCIpLmhpZGRlbiA9IGZhbHNlOyAkKFwicmVzdW1lXCIpLnRpdGxlID0gXCJDYWxsIGFnYWluLCBjYXJyeWluZyBvbiBmcm9tIHRoZSBsYXN0IGNvbnZlcnNhdGlvblwiOyB9XG4gICQoXCJtaWNcIikub25jbGljayA9ICgpID0+IHNldE11dGVkKCFtdXRlZCk7XG4gICQoXCJodXNoXCIpLm9uY2xpY2sgPSAoKSA9PiB7IHB1c2goeyB0eXBlOiBcImludGVycnVwdFwiIH0pOyBhdWRpby5mbHVzaCgpOyB9O1xuICAkKFwiY2FuY2VsYWxsXCIpLm9uY2xpY2sgPSAoKSA9PiBwdXNoKHsgdHlwZTogXCJjYW5jZWxBbGxcIiB9KTtcbiAgJChcImRvbmVib3hcIikuYWRkRXZlbnRMaXN0ZW5lcihcInRvZ2dsZVwiLCAoKSA9PiB7IGlmICgkPEhUTUxEZXRhaWxzRWxlbWVudD4oXCJkb25lYm94XCIpLm9wZW4pICQoXCJkb25lYm94XCIpLnNjcm9sbEludG9WaWV3KHsgYmxvY2s6IFwibmVhcmVzdFwiIH0pOyB9KTtcbiAgJChcInNheVwiKS5vbnN1Ym1pdCA9IHN1Ym1pdFRleHQ7XG4gICQoXCJ0ZXh0XCIpLmFkZEV2ZW50TGlzdGVuZXIoXCJrZXlkb3duXCIsIChlKSA9PiB7IGlmICgoZSBhcyBLZXlib2FyZEV2ZW50KS5rZXkgPT09IFwiRW50ZXJcIikgc3VibWl0VGV4dChlKTsgfSk7XG4gIHRhYnMoKTtcbiAga2V5cygpO1xuICBjb25zdCBldmVudHMgPSBuZXcgRXZlbnRTb3VyY2UoXCIvZXZlbnRzXCIpO1xuICBldmVudHMuYWRkRXZlbnRMaXN0ZW5lcihcImNvcmVcIiwgKGUpID0+IHtcbiAgICBjb25zdCB7IHZlcnNpb24gfSA9IEpTT04ucGFyc2UoKGUgYXMgTWVzc2FnZUV2ZW50KS5kYXRhKTtcbiAgICAkKFwidmVyc2lvblwiKS50ZXh0Q29udGVudCA9IHZlcnNpb24gKyAoY2FsbElkICYmIGNvcmUgJiYgY29yZS52ZXJzaW9uICE9PSB2ZXJzaW9uID8gYCAobmV4dCBjYWxsOyB0aGlzIG9uZSBydW5zICR7Y29yZS52ZXJzaW9ufSlgIDogXCJcIik7XG4gICAgJChcImJ1aWxkXCIpLnRleHRDb250ZW50ID0gYGNvcmUgJHt2ZXJzaW9ufWA7XG4gIH0pO1xuICBldmVudHMuYWRkRXZlbnRMaXN0ZW5lcihcImFwcFwiLCAoKSA9PiB7IGlmICghY2FsbElkKSBsb2NhdGlvbi5yZWxvYWQoKTsgZWxzZSB0b2FzdChcIlRoZSBwYWdlIGNoYW5nZWQ6IHJlbG9hZCBhZnRlciB0aGlzIGNhbGxcIik7IH0pO1xuICBldmVudHMuYWRkRXZlbnRMaXN0ZW5lcihcImVycm9yXCIsIChlKSA9PiB7XG4gICAgY29uc3QgZGF0YSA9IChlIGFzIE1lc3NhZ2VFdmVudCkuZGF0YTtcbiAgICBpZiAoZGF0YSkgdG9hc3QoYEJ1aWxkIGZhaWxlZDogJHtKU09OLnBhcnNlKGRhdGEpLm1lc3NhZ2V9YCk7XG4gIH0pO1xuICBuZXcgUmVwbGF5KCQoXCJyZXBsYXlcIiksIGxvYWRDb3JlKTtcbiAgdm9pZCBwaW5nKCk7XG4gIHZvaWQgc2hvd0VhcmxpZXIoKTtcbiAgd2luZG93LnNldEludGVydmFsKCgpID0+IHZvaWQgc2hvd0VhcmxpZXIoKSwgMzBfMDAwKTtcbn1cblxudm9pZCBtYWluKCk7XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBU0EsSUFBTSxTQUFTLG9CQUFJLElBQUk7QUFBQSxFQUNyQjtBQUFBLEVBQU87QUFBQSxFQUFNO0FBQUEsRUFBUTtBQUFBLEVB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
