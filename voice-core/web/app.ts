// The web surface: a fourth host for the voice core, for trying a change in seconds. It loads the
// dev server's latest build at each call, so an edit in src/ is live on the next call, and keeps
// every call as a trace the replay view (and any other host) can run again.

import { CallAudio } from "./audio.ts";
import { Replay } from "./replay.ts";

interface Core {
  version: string;
  defaults(): string;
  create(config: string, t: number): string;
  push(id: number, event: string): string;
  trace(id: number): string;
  dispose(id: number): void;
}
type Command = Record<string, any> & { type: string };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const now = () => performance.now() / 1000;

/** The latest build from the dev server, evaluated afresh: an edit in src/ is in the next call. */
export async function loadCore(url = "/voice-core.js"): Promise<Core> {
  const source = await (await fetch(url, { cache: "no-store" })).text();
  const scope: { VoiceCore?: Core } = {};
  new Function("globalThis", source)(scope);
  if (!scope.VoiceCore) throw new Error("the bundle didn't define VoiceCore");
  return scope.VoiceCore;
}

// Presets: each surface's settings as its app would set them.

const FAKE_TV = [
  { name: "tv_volume", description: "Sets the living-room TV's volume, 0 to 100.", parameters: { type: "OBJECT", properties: { level: { type: "INTEGER" } }, required: ["level"] } },
  { name: "tv_pause", description: "Pauses or resumes what's playing on the TV.", parameters: { type: "OBJECT", properties: { pause: { type: "BOOLEAN" } } } },
];

const PRESETS: Record<string, Record<string, unknown>> = {
  web: { platform: "web", device: "browser", standbyAfter: 20 },
  android: { platform: "Android", device: "phone", standbyAfter: 20 },
  "android wake word": { platform: "Android", device: "phone", standbyAfter: 20, hangUpAfter: 15 },
  macos: { platform: "macOS", device: "Mac", standbyAfter: 20 },
  echo: {
    platform: "Echo", device: "speaker", hangUpAfter: 6, standbyAfter: 8, earcons: true, vocabulary: ["Hermes", "Bento", "Woodhouse"],
    mic: { whileSpeaking: "wake", gainDb: 0 }, hostTools: FAKE_TV,
  },
};

// The page.

const audio = new CallAudio();
let config: { route: string; model: string; version: string; hermes: boolean };
let core: Core | null = null;
let callId = 0;
let callName = "";
let ticker = 0;
let traceTimer = 0;
const sockets = new Map<number, WebSocket>();
const tools = new Map<string, AbortController>();
const tasks = new Map<string, Command>();
let counts = { mic: 0, play: 0, sent: 0 };
let fakeTvLevel = 15;

function log(kind: string, text: string, cls = "") {
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
  while (pane.childElementCount > 2000) pane.firstElementChild!.remove();
  if (stick) pane.scrollTop = pane.scrollHeight;
}
let startedAt = now();

/** A frame from or to Gemini, with audio cut out, short enough to read. */
function brief(data: string): string {
  return data.replace(/"data":"[A-Za-z0-9+/=]{40,}"/g, (m) => `"data":"…${Math.round(((m.length - 9) * 3) / 4)} bytes"`).slice(0, 600);
}

function transcript(role: string, text: string) {
  const pane = $("transcript");
  const last = pane.lastElementChild as HTMLElement | null;
  if (last && last.dataset.role === role && !last.dataset.closed) last.querySelector(".text")!.textContent += text;
  else {
    const row = document.createElement("div");
    row.className = `line ${role}`;
    row.dataset.role = role;
    row.innerHTML = `<span class="who">${role === "user" ? "You" : role === "hermes" ? "Hermes" : "Gemini"}</span><span class="text"></span>`;
    row.querySelector(".text")!.textContent = text;
    pane.append(row);
  }
  pane.scrollTop = pane.scrollHeight;
}

function closeLine() {
  const last = $("transcript").lastElementChild as HTMLElement | null;
  if (last) last.dataset.closed = "1";
}

function showTasks() {
  const pane = $("tasks");
  pane.innerHTML = "";
  for (const t of tasks.values()) {
    const row = document.createElement("div");
    row.className = `task ${t.state.replace(/\W+/g, "-")}`;
    row.innerHTML = `<b></b> <i></i><div class="p"></div>`;
    row.querySelector("b")!.textContent = t.label;
    row.querySelector("i")!.textContent = t.state;
    row.querySelector(".p")!.textContent = t.question ? `Asks: ${t.question}` : t.progress ?? t.request;
    if (t.state === "running") {
      const cancel = document.createElement("button");
      cancel.textContent = "Cancel";
      cancel.onclick = () => push({ type: "cancelTask", task: t.id });
      row.append(cancel);
    }
    pane.append(row);
  }
}

function setStatus(text: string, cls = "") {
  $("status").textContent = text;
  $("status").className = cls;
}

// The call.

function push(event: Record<string, unknown>) {
  if (!core || !callId) return;
  const e: Record<string, unknown> = { ...event, t: now() };
  const quiet = e.type === "mic" || e.type === "tick";
  if (!quiet) log("in", e.type === "ws.message" ? `ws ${e.sid} ← ${brief(String(e.data))}` : JSON.stringify(e).slice(0, 400), "in");
  run(JSON.parse(core.push(callId, JSON.stringify(e))));
}

function run(commands: Command[]) {
  for (const c of commands) {
    switch (c.type) {
      case "ws.connect": connect(c.sid); break;
      case "ws.send": {
        sockets.get(c.sid)?.send(c.data);
        if (c.data.startsWith('{"realtimeInput":{"audio"')) counts.sent++;
        else log("out", `ws ${c.sid} → ${brief(c.data)}`, "out");
        break;
      }
      case "ws.close": sockets.get(c.sid)?.close(); sockets.delete(c.sid); log("out", `ws ${c.sid} close`, "out"); break;
      case "mic.start":
      case "mic.restart":
        log("out", c.type, "out");
        void audio.startMic((pcm) => { counts.mic++; push({ type: "mic", pcm }); }, micOptions()).catch((err) => log("error", `microphone: ${err.message}`, "err"));
        break;
      case "mic.stop": audio.stopMic(); break;
      case "play": audio.play(c.pcm); counts.play++; break;
      case "flush": audio.flush(); log("out", "flush (barge-in)", "out"); break;
      case "cue": audio.cue(c.pcm); log("out", `cue ${c.earcon}`, "out"); break;
      case "wakeword":
        $<HTMLButtonElement>("wake").disabled = !c.on;
        $("wake").classList.toggle("armed", c.on);
        log("out", `wake word ${c.on ? "listening" : "off"}`, "out");
        break;
      case "tool.call": tool(c); break;
      case "tool.cancel": tools.get(c.run)?.abort(); tools.delete(c.run); log("out", `cancel ${c.run}`, "out"); break;
      case "status":
        setStatus(c.status === "ended" ? `Ended${c.message ? ": " + c.message : ""}` : c.status, c.status);
        log("status", c.status + (c.message ? `: ${c.message}` : ""), "status");
        if (c.status === "ended") end();
        break;
      case "transcript": transcript(c.role, c.text); break;
      case "task": tasks.set(c.id, c); showTasks(); break;
      case "questions": break;
      case "micSilent": $("micwarn").hidden = !c.silent; break;
      case "log": log(c.level, c.message, c.level === "warn" ? "warn" : ""); break;
      default: log("out", JSON.stringify(c).slice(0, 300), "out");
    }
  }
}

function connect(sid: number) {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/live`);
  sockets.set(sid, ws);
  log("out", `ws ${sid} connect (${config.route})`, "out");
  ws.onopen = () => push({ type: "ws.open", sid });
  ws.onmessage = (m) => {
    const data = typeof m.data === "string" ? m.data : "";
    push({ type: "ws.message", sid, data });
  };
  ws.onclose = (e) => {
    if (sockets.get(sid) !== ws && sockets.has(sid)) return;
    const httpStatus = e.code >= 4100 && e.code < 4600 ? e.code - 4000 : undefined;
    push({ type: "ws.closed", sid, code: httpStatus ? undefined : e.code, reason: e.reason, httpStatus });
  };
}

async function tool(c: Command) {
  if (c.kind === "host") {
    log("out", `host tool ${c.name} ${JSON.stringify(c.args)}`, "out");
    const answer = c.name === "tv_volume" ? `The TV is at ${(fakeTvLevel = Number(c.args?.level ?? fakeTvLevel))}.`
      : c.name === "tv_pause" ? (c.args?.pause === false ? "Playing." : "Paused.") : "Done.";
    setTimeout(() => push({ type: "tool.result", run: c.run, text: answer }), 300);
    return;
  }
  log("out", `Hermes ${c.followUp ? "follow-up" : "task"} "${c.label}": ${c.request}`, "out");
  if ($<HTMLInputElement>("fakehermes").checked) {
    const delay = Number($<HTMLInputElement>("fakedelay").value) * 1000;
    const timer = setTimeout(() => {
      tools.delete(c.run);
      const text = `(Fake Hermes) Done: "${c.request}". Nothing was actually run.`;
      transcript("hermes", text); closeLine();
      push({ type: "tool.result", run: c.run, text });
    }, delay);
    const abort = new AbortController();
    abort.signal.onabort = () => clearTimeout(timer);
    tools.set(c.run, abort);
    return;
  }
  const abort = new AbortController();
  tools.set(c.run, abort);
  try {
    const response = await fetch("/hermes", {
      method: "POST", signal: abort.signal, headers: { "content-type": "application/json" },
      body: JSON.stringify({ call: callName, taskId: c.taskId, followUp: c.followUp, message: c.message }),
    });
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = block.match(/^event: (.*)$/m)?.[1];
        const data = JSON.parse(block.match(/^data: (.*)$/m)?.[1] ?? "{}");
        if (event === "progress") push({ type: "task.progress", task: c.taskId, text: data.text });
        else if (event === "result") { transcript("hermes", data.text); closeLine(); push({ type: "tool.result", run: c.run, text: data.text, failed: data.failed }); }
        else if (event === "error") push({ type: "tool.error", run: c.run, message: data.message });
      }
    }
  } catch (err) {
    if (!abort.signal.aborted) push({ type: "tool.error", run: c.run, message: (err as Error).message });
  } finally {
    tools.delete(c.run);
  }
}

function micOptions() {
  const aec = $<HTMLInputElement>("aec").checked;
  return { echoCancellation: aec, noiseSuppression: aec, autoGainControl: aec };
}

function readConfig(): Record<string, unknown> {
  const text = $<HTMLTextAreaElement>("config").value;
  const given = JSON.parse(text);
  return {
    model: config.model, api: config.route === "vertex" ? "vertex" : "gemini", today: new Date().toISOString().slice(0, 10),
    ...given, trace: $<HTMLInputElement>("trace").checked,
  };
}

async function start() {
  if (callId) return;
  let given: Record<string, unknown>;
  try {
    given = readConfig();
  } catch (err) {
    setStatus(`The settings aren't valid JSON: ${(err as Error).message}`, "ended");
    return;
  }
  await audio.open();
  core = await loadCore();
  $("version").textContent = core.version;
  $("log").innerHTML = "";
  $("transcript").innerHTML = "";
  tasks.clear();
  showTasks();
  counts = { mic: 0, play: 0, sent: 0 };
  startedAt = now();
  callName = `${new Date().toISOString().replace(/[:.]/g, "-")}-web-${core.version}`;
  const created = JSON.parse(core.create(JSON.stringify(given), now()));
  callId = created.id;
  $<HTMLButtonElement>("call").textContent = "Hang up";
  $("call").classList.add("live");
  run(created.commands);
  ticker = window.setInterval(() => {
    push({ type: "tick" });
    $("meter").style.width = `${Math.min(100, audio.level * 400)}%`;
    $("counts").textContent = `mic ${counts.mic} · sent ${counts.sent} · played ${counts.play} · queued ${audio.queued.toFixed(1)} s`;
  }, 100);
  traceTimer = window.setInterval(() => void saveTrace(), 5000);
}

function hangUp() {
  if (callId) push({ type: "stop" });
}

function end() {
  window.clearInterval(ticker);
  window.clearInterval(traceTimer);
  void saveTrace().then(() => { if (core && callId) core.dispose(callId); callId = 0; });
  audio.stop();
  for (const ws of sockets.values()) ws.close();
  sockets.clear();
  for (const a of tools.values()) a.abort();
  tools.clear();
  $<HTMLButtonElement>("call").textContent = "Call";
  $("call").classList.remove("live");
  $<HTMLButtonElement>("wake").disabled = true;
}

/** Sends what the trace kept since last time to the dev server, as JSON lines: a header, then events. */
async function saveTrace() {
  if (!core || !callId || !$<HTMLInputElement>("trace").checked) return;
  const kept = JSON.parse(core.trace(callId));
  if (!kept) return;
  const lines: string[] = [];
  if (kept.config) lines.push(JSON.stringify({ version: kept.version, config: kept.config, start: kept.start }));
  for (const e of kept.events) lines.push(JSON.stringify(e));
  if (lines.length === 0) return;
  await fetch(`/traces?name=${encodeURIComponent(callName)}.jsonl`, { method: "POST", body: lines.join("\n") + "\n" });
  $("tracename").textContent = `${callName}.jsonl`;
}

async function main() {
  config = await (await fetch("/config")).json();
  $("route").textContent = `${config.route === "vertex" ? "GSK Vertex" : "Gemini API"} · ${config.model.split("/").pop()}`;
  $("version").textContent = config.version;
  if (!config.hermes) { $<HTMLInputElement>("fakehermes").checked = true; $<HTMLInputElement>("fakehermes").disabled = true; }
  const preset = $<HTMLSelectElement>("preset");
  for (const name of Object.keys(PRESETS)) preset.add(new Option(name, name));
  const saved = localStorage.getItem("voice-core.config");
  preset.value = localStorage.getItem("voice-core.preset") ?? "web";
  $<HTMLTextAreaElement>("config").value = saved ?? JSON.stringify(PRESETS[preset.value], null, 2);
  preset.onchange = () => {
    $<HTMLTextAreaElement>("config").value = JSON.stringify(PRESETS[preset.value], null, 2);
    localStorage.setItem("voice-core.preset", preset.value);
    localStorage.removeItem("voice-core.config");
  };
  $("config").oninput = () => localStorage.setItem("voice-core.config", $<HTMLTextAreaElement>("config").value);
  $("defaults").onclick = async () => {
    const c = core ?? (await loadCore());
    $("defaultsview").textContent = JSON.stringify(JSON.parse(c.defaults()), null, 2);
    $("defaultsview").hidden = !$("defaultsview").hidden;
  };
  $("call").onclick = () => (callId ? hangUp() : void start().catch((err) => setStatus(err.message, "ended")));
  $("mute").onclick = () => {
    const muted = $("mute").classList.toggle("on");
    push({ type: muted ? "mute" : "unmute" });
  };
  $("resume").onclick = () => push({ type: "resume" });
  $("wake").onclick = () => push({ type: "wake" });
  const events = new EventSource("/events");
  events.addEventListener("core", (e) => {
    const { version } = JSON.parse((e as MessageEvent).data);
    $("version").textContent = version + (callId && core && core.version !== version ? " (next call; this one runs " + core.version + ")" : "");
  });
  events.addEventListener("app", () => { if (!callId) location.reload(); else $("reload").hidden = false; });
  events.addEventListener("error", (e) => {
    const data = (e as MessageEvent).data;
    if (data) setStatus(`Build failed: ${JSON.parse(data).message}`, "ended");
  });
  new Replay($("replay"), loadCore);
}

void main();
