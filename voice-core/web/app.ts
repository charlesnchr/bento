// The web surface: a fourth host for the voice core, and a phone-friendly way to use it for work.
// It loads the dev server's latest build at each call, so an edit in src/ is live on the next
// call, and keeps every call as a trace the replay view (and any other host) can run again.
//
// The host's part is small: the microphone and speaker (audio.ts), the model's socket through the
// server's relay, Hermes and T3 through the server, and the screen. The core decides the rest.

import { commandIn } from "../src/commands.ts";
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
interface ServerConfig { route: string; model: string; captionsModel?: string; version: string; hermes: boolean; t3: string[] | null }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const now = () => performance.now() / 1000;
const checked = (id: string) => $<HTMLInputElement>(id).checked;

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
  web: { platform: "web", device: "browser", standbyAfter: 30, hangUpAfter: 300, handOff: "named", supervise: true, vocabulary: ["Hermes", "Bento", "Woodhouse", "T3"] },
  android: { platform: "Android", device: "phone", standbyAfter: 20 },
  "android wake word": { platform: "Android", device: "phone", standbyAfter: 20, hangUpAfter: 15 },
  macos: { platform: "macOS", device: "Mac", standbyAfter: 20 },
  echo: {
    platform: "Echo", device: "speaker", hangUpAfter: 6, standbyAfter: 8, earcons: true, vocabulary: ["Hermes", "Bento", "Woodhouse"],
    mic: { whileSpeaking: "wake", gainDb: 0 }, hostTools: FAKE_TV,
  },
};

// State.

const audio = new CallAudio();
let server: ServerConfig;
let core: Core | null = null;
let callId = 0;
let callName = "";
let ticker = 0;
let traceTimer = 0;
let startedAt = now();
const sockets = new Map<number, WebSocket>();
/** The sockets to the transcription model: their audio is the model's again, so it isn't counted or logged twice. */
const captionSockets = new Set<number>();
const runs = new Map<string, { abort: AbortController; agent: string; taskId: string }>();
interface TaskView { c: Command; since: number; ended: number | null; thread?: string; result?: HTMLElement; approval?: { command: string } }
const tasks = new Map<string, TaskView>();
let counts = { mic: 0, play: 0, sent: 0 };
let fakeTvLevel = 15;
let coreStatus = "idle";
let muted = false;
let holding = false;
let wakeLock: { release(): Promise<void> } | null = null;

// The conversation, kept so a new call can carry on from it (the core's `history`, recapped to the model).
interface ChatLine { role: "user" | "assistant"; speaker?: string; text: string }
const HISTORY = "voice.history";
const HISTORY_MAX_AGE = 12 * 3600 * 1000;
let chat: ChatLine[] = [];
/** The core's number for the line the last words were remembered on, until something else is. */
let lastLine: number | null = null;

function remember(role: "user" | "assistant", text: string, speaker?: string, join = false) {
  const last = chat.at(-1);
  if (join && last && last.role === role && last.speaker === speaker) last.text += text;
  else chat.push(speaker ? { role, speaker, text } : { role, text });
  if (chat.length > 200) chat.splice(0, chat.length - 200);
  localStorage.setItem(HISTORY, JSON.stringify({ at: Date.now(), chat }));
}

function savedHistory(): ChatLine[] {
  try {
    const saved = JSON.parse(localStorage.getItem(HISTORY) ?? "null");
    return saved && Date.now() - saved.at < HISTORY_MAX_AGE && Array.isArray(saved.chat) ? saved.chat : [];
  } catch {
    return [];
  }
}

/** Two rising notes: something on the screen needs the user. PCM16 at 24 kHz, base64. */
const APPROVAL_TONE = (() => {
  const rate = 24000, out = new Int16Array(rate * 0.32);
  for (let i = 0; i < out.length; i++) {
    const t = i / rate, f = t < 0.16 ? 660 : 880, local = t < 0.16 ? t : t - 0.16;
    out[i] = Math.round(Math.sin(2 * Math.PI * f * t) * Math.min(1, local * 60, (0.16 - local) * 60) * 6000);
  }
  let bin = "";
  const bytes = new Uint8Array(out.buffer);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
})();

// Latency: the network's round trip, and how long after the user stops talking the reply starts.
const metrics = { rtt: [] as number[], reply: [] as number[], lastVoice: 0, lastPlay: 0, replied: true };

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function showMetrics() {
  const parts: string[] = [];
  const rtt = median(metrics.rtt);
  if (rtt != null) parts.push(`network ${Math.round(rtt * 1000)} ms`);
  const reply = median(metrics.reply);
  if (reply != null) parts.push(`reply ${metrics.reply.at(-1)!.toFixed(1)} s (median ${reply.toFixed(1)})`);
  const out = audio.outputLatency;
  if (out != null) parts.push(`audio ${Math.round(out * 1000)} ms`);
  let buffered = 0;
  for (const ws of sockets.values()) buffered += ws.bufferedAmount;
  if (buffered > 32_000) parts.push(`upload behind ${(buffered / 32_000).toFixed(1)} s`);
  $("metrics").textContent = parts.join(" · ");
}

async function ping() {
  const t = now();
  try {
    await fetch("/ping", { cache: "no-store" });
    metrics.rtt.push(now() - t);
    if (metrics.rtt.length > 12) metrics.rtt.shift();
  } catch {}
  showMetrics();
}

// The screen.

/** A system notification while the page is hidden: a task finished, or one needs the user. */
function notify(title: string, body: string) {
  if (!document.hidden || !("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, { body: body.slice(0, 180), icon: "/web/icons/icon-192.png", tag: title });
    n.onclick = () => { window.focus(); n.close(); };
  } catch {
    // Phones want notifications from a service worker; the page has none.
  }
}

function toast(text: string) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("on");
  clearTimeout((toast as any).timer);
  (toast as any).timer = setTimeout(() => t.classList.remove("on"), 1800);
}

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
  while (pane.childElementCount > 3000) pane.firstElementChild!.remove();
  if (stick) pane.scrollTop = pane.scrollHeight;
}

/** A frame from or to Gemini, with audio cut out, short enough to read. */
function brief(data: string): string {
  return data.replace(/"data":"[A-Za-z0-9+/=]{40,}"/g, (m) => `"data":"…${Math.round(((m.length - 9) * 3) / 4)} bytes"`).slice(0, 600);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** A little Markdown, safely: code, bold, links, lists and headings, the rest as text. */
function markdown(text: string): string {
  const blocks = escapeHtml(text.trim()).split(/```(?:\w+)?\n?/);
  return blocks.map((block, i) => {
    if (i % 2 === 1) return `<pre>${block}</pre>`;
    const inline = (s: string) => s
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    let html = "";
    let list: string | null = null;
    for (const raw of block.split("\n")) {
      const item = raw.match(/^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/);
      if (item) {
        const kind = item[1] ? "ol" : "ul";
        if (list !== kind) { if (list) html += `</${list}>`; html += `<${kind}>`; list = kind; }
        html += `<li>${inline(item[2])}</li>`;
        continue;
      }
      if (list) { html += `</${list}>`; list = null; }
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

/** The core's number for the line the last row shows, until another row follows it. */
let openLine: number | null = null;

/** Words go on the row the core says they belong to: it starts a new line for each turn, however long the gap. */
function transcript(role: "user" | "assistant", text: string, line: number) {
  $("empty").hidden = true;
  const pane = $("transcript");
  const last = pane.lastElementChild as HTMLElement | null;
  if (openLine === line && last && last.dataset.role === role) last.querySelector(".text")!.textContent += text;
  else {
    const row = document.createElement("div");
    row.className = `line ${role}`;
    row.dataset.role = role;
    row.innerHTML = `<span class="who">${role === "user" ? "You" : "Gemini"}</span><span class="text"></span>`;
    row.querySelector(".text")!.textContent = text.trimStart();
    pane.append(row);
    openLine = line;
  }
  scrollDown(role === "user");
}

/**
 * The words the user is saying, before the model has transcribed them: a faint row that stays last
 * on screen (its CSS `order`) and first in the pane, so the lines after it join up as before.
 */
function caption(text: string | null) {
  const pane = $("transcript");
  let row = document.getElementById("caption");
  if (text == null) { row?.remove(); return; }
  $("empty").hidden = true;
  if (!row) {
    row = document.createElement("div");
    row.id = "caption";
    row.className = "line user caption";
    row.innerHTML = `<span class="who">You</span><span class="text"></span>`;
    pane.prepend(row);
  }
  row.querySelector(".text")!.textContent = text;
  scrollDown(true);
}

function note(text: string) {
  $("empty").hidden = true;
  const row = document.createElement("div");
  row.className = "line note";
  row.textContent = text;
  $("transcript").append(row);
  openLine = null;
  scrollDown();
}

function result(agent: string, label: string, text: string, failed = false): HTMLElement {
  $("empty").hidden = true;
  const row = document.createElement("div");
  row.className = `line result ${agent === "t3" ? "t3" : ""}`;
  row.innerHTML = `<span class="who">${agent === "t3" ? "T3" : "Hermes"} · ${escapeHtml(label)}${failed ? " · failed" : ""}</span><div class="body">${markdown(text)}</div>`;
  $("transcript").append(row);
  openLine = null;
  const body = row.querySelector(".body") as HTMLElement;
  requestAnimationFrame(() => {
    if (body.scrollHeight > body.clientHeight + 4) {
      const more = document.createElement("button");
      more.className = "more";
      more.textContent = "Show all";
      more.onclick = () => { row.classList.toggle("open"); more.textContent = row.classList.contains("open") ? "Show less" : "Show all"; };
      row.append(more);
    }
  });
  scrollDown(true);
  return row;
}

function elapsed(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)} s`;
  const m = Math.floor(seconds / 60);
  return m < 60 ? `${m} min ${Math.floor(seconds % 60)} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** The empty task list's words, kept to put back. */
const noTasks = document.getElementById("notasks")!;

/** Whether a task still wants the screen: it's working, or it waits for the user. The rest fold away under Finished. */
const live = (state: string) => state === "running" || state.startsWith("waiting");

/** The Finished fold's count, and the fold itself only when something is in it. */
function showDone() {
  const n = $("donenow").childElementCount + $("doneearlier").childElementCount;
  $("donebox").hidden = n === 0;
  $("donecount").textContent = n > 0 ? `· ${n}` : "";
}

function showTasks(force = false) {
  const pane = $("tasks");
  const done = $("donenow");
  const open = document.activeElement?.closest?.(".task") as HTMLElement | null;
  if (!force && open && (pane.contains(open) || done.contains(open)) && open.querySelector("form")) return; // don't redraw under someone typing a follow-up
  pane.innerHTML = "";
  done.innerHTML = "";
  const all = [...tasks.values()].reverse();
  if (all.length === 0) { pane.append(noTasks); $("taskcount").textContent = ""; showDone(); return; }
  const running = all.filter((t) => t.c.state === "running").length;
  $("taskcount").textContent = running > 0 ? `${running} running` : "";
  $("cancelall").hidden = !callId || running < 2;
  for (const view of all) {
    const t = view.c;
    const waiting = t.state.startsWith("waiting");
    const card = document.createElement("div");
    card.className = `task ${waiting ? "waiting" : t.state}`;
    const age = (view.ended ?? now()) - view.since;
    card.innerHTML = `<div class="top"><span class="badge ${t.agent === "t3" ? "t3" : ""}">${t.agent === "t3" ? "T3" : "Hermes"}</span>` +
      `<span class="label"></span><span class="state">${t.state === "running" ? '<span class="spin"></span> ' : ""}${escapeHtml(t.state)} · ${elapsed(age)}</span></div>` +
      `<div class="p"></div>`;
    card.querySelector(".label")!.textContent = t.label;
    card.querySelector(".p")!.textContent = t.progress ?? t.request;
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
      box.querySelector("code")!.textContent = view.approval.command;
      const answer = (choice: "once" | "deny") => {
        view.approval = undefined;
        showTasks(true);
        void fetch("/hermes/approval", { method: "POST", body: JSON.stringify({ call: callName, taskId: t.id, choice }) })
          .then((r) => toast(r.ok ? (choice === "once" ? "Approved" : "Denied") : "That approval had already lapsed"));
      };
      for (const [label, choice] of [["Approve once", "once"], ["Deny", "deny"]] as const) {
        const b = document.createElement("button");
        b.textContent = label;
        if (choice === "once") b.className = "go";
        b.onclick = () => answer(choice);
        box.querySelector(".acts")!.append(b);
      }
      card.append(box);
    }
    if (t.state !== "running") view.approval = undefined;
    const acts = document.createElement("div");
    acts.className = "acts";
    const button = (text: string, fn: () => void) => { const b = document.createElement("button"); b.textContent = text; b.onclick = fn; acts.append(b); return b; };
    if (callId) {
      button(waiting ? "Answer" : "Follow up", () => followUpForm(card, t));
      if (t.state === "running") button("Cancel", () => push({ type: "cancelTask", task: t.id }));
    }
    if (view.result) button("Result", () => { view.result!.scrollIntoView({ behavior: "smooth", block: "center" }); view.result!.classList.add("open"); });
    if (view.thread) button("Copy thread id", () => { void navigator.clipboard?.writeText(view.thread!); toast("Thread id copied"); });
    if (acts.childElementCount) card.append(acts);
    (live(t.state) ? pane : done).append(card);
  }
  showDone();
}

function followUpForm(card: HTMLElement, t: Command) {
  if (card.querySelector("form")) return;
  const form = document.createElement("form");
  form.innerHTML = `<input type="text" placeholder="Tell “${escapeHtml(t.label)}”…" enterkeyhint="send"><button>Send</button>`;
  const input = form.querySelector("input")!;
  form.onsubmit = (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (text) { push({ type: "steer", task: t.id, text }); note(`You → ${t.label}: ${text}`); }
    input.blur();
    form.remove();
    showTasks();
  };
  input.onkeydown = (e) => { if (e.key === "Escape") { input.blur(); form.remove(); showTasks(); } };
  card.append(form);
  input.focus();
}

/** T3 threads earlier calls started: they carry on after a call, so the panel says how they're doing. */
async function showEarlier() {
  let list: { thread: string; title: string; status: string; branch: string | null; pr: string | null; updated: string; last: string; waiting: boolean }[] = [];
  try { list = await (await fetch("/agent/recent", { cache: "no-store" })).json(); } catch {}
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
    const ago = Math.max(0, (Date.now() - Date.parse(t.updated)) / 1000);
    card.innerHTML = `<div class="top"><span class="badge t3">T3</span><span class="label"></span>` +
      `<span class="state">${t.status === "running" ? '<span class="spin"></span> ' : ""}${escapeHtml(state)} · ${elapsed(ago)} ago</span></div><div class="p"></div>`;
    card.querySelector(".label")!.textContent = t.title;
    card.querySelector(".p")!.textContent = t.last || (t.branch ? `On ${t.branch}` : "");
    const acts = document.createElement("div");
    acts.className = "acts";
    if (t.pr) { const a = document.createElement("a"); a.href = t.pr; a.target = "_blank"; a.rel = "noopener"; a.textContent = "Pull request"; acts.append(a); }
    const copy = document.createElement("button");
    copy.textContent = "Copy thread id";
    copy.onclick = () => { void navigator.clipboard?.writeText(t.thread); toast("Thread id copied"); };
    acts.append(copy);
    card.append(acts);
    (t.status === "running" || t.waiting ? pane : done).append(card);
  }
  $("earlierbox").hidden = pane.childElementCount === 0;
  showDone();
}

const STATUS_TEXT: Record<string, string> = {
  idle: "Idle", connecting: "Connecting…", listening: "Listening", working: "Listening · tasks running",
  standby: "Paused while tasks run · speak to resume", waking: "Resuming…", ended: "Ended",
};

function showStatus(message?: string) {
  const speaking = callId && coreStatus !== "standby" && audio.queued > 0.05;
  const shown = speaking ? "speaking" : coreStatus;
  $("status").className = shown;
  let text = speaking ? "Speaking" : STATUS_TEXT[coreStatus] ?? coreStatus;
  if (callId && muted && !holding && !speaking) text += " · muted";
  if (holding) text = "Talking (hold)";
  if (message) text = `${text}: ${message}`;
  if (coreStatus !== "ended" || message) $("statustext").textContent = text;
  $<HTMLButtonElement>("hush").classList.toggle("live", Boolean(speaking));
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
      case "ws.connect": connect(c.sid, c.purpose === "captions"); break;
      case "ws.send": {
        sockets.get(c.sid)?.send(c.data);
        if (!c.data.startsWith('{"realtimeInput":{"audio"')) log("out", `ws ${c.sid} → ${brief(c.data)}`, "out");
        else if (!captionSockets.has(c.sid)) counts.sent++;
        break;
      }
      case "ws.close": sockets.get(c.sid)?.close(); sockets.delete(c.sid); log("out", `ws ${c.sid} close`, "out"); break;
      case "mic.start":
      case "mic.restart":
        log("out", c.type, "out");
        void audio.startMic(onMic, micOptions()).catch((err) => { log("error", `microphone: ${err.message}`, "err"); toast(`Microphone: ${err.message}`); });
        break;
      case "mic.stop": audio.stopMic(); break;
      case "play": {
        const t = now();
        // A reply starting: from the end of the user's speech to its first sound.
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
      case "flush": audio.flush(); log("out", "flush", "out"); break;
      case "cue":
        audio.cue(c.pcm);
        log("out", `cue ${c.earcon}`, "out");
        // A request that became a task gets a tone, not a spoken reply: nothing to time.
        if (c.earcon === "taskStarted") metrics.replied = true;
        break;
      case "wakeword": log("out", `wake word ${c.on ? "listening" : "off"}`, "out"); break;
      case "tool.call": void tool(c); break;
      case "tool.cancel": cancelRun(c.run, c.reason); break;
      case "tool.steer": void steerRun(c); break;
      case "status":
        coreStatus = c.status;
        showStatus(c.status === "ended" ? c.message ?? undefined : undefined);
        log("status", c.status + (c.message ? `: ${c.message}` : ""), "status");
        if (c.status === "ended") { if (c.message) note(c.message); end(); }
        break;
      case "caption": caption(c.text); break;
      case "transcript":
        transcript(c.role, c.text, c.line);
        remember(c.role, c.text, c.role === "assistant" ? "Gemini" : undefined, lastLine === c.line);
        lastLine = c.line;
        break;
      case "task": {
        const view = tasks.get(c.id) ?? { c, since: now(), ended: null };
        if (c.state === "running" && view.c.state !== "running") { view.since = now(); view.ended = null; }
        if (c.state !== "running" && view.ended == null) view.ended = now();
        view.c = c;
        tasks.set(c.id, view);
        showTasks();
        break;
      }
      case "questions": break;
      case "micSilent": $("micwarn").hidden = !c.silent; break;
      case "voiceCommand":
        toast(`Heard “${c.heard}”: ${c.command === "stop" ? "stopped" : c.command === "cancelAll" ? "cancelling every task" : "hanging up"}`);
        log("out", `voice command ${c.command}: ${c.heard}`, "out");
        break;
      case "log": log(c.level, c.message, c.level === "warn" ? "warn" : ""); break;
      default: log("out", JSON.stringify(c).slice(0, 300), "out");
    }
  }
}

function onMic(pcm: string, level: number) {
  counts.mic++;
  if (level > 0.03 && !(muted && !holding)) {
    metrics.lastVoice = now();
    if (audio.queued < 0.05) metrics.replied = false;
  }
  push({ type: "mic", pcm });
}

function connect(sid: number, captions: boolean) {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/live${captions ? "?for=captions" : ""}`);
  sockets.set(sid, ws);
  if (captions) captionSockets.add(sid);
  log("out", `ws ${sid} connect (${server.route}${captions ? ", captions" : ""})`, "out");
  ws.onopen = () => push({ type: "ws.open", sid });
  ws.onmessage = (m) => push({ type: "ws.message", sid, data: typeof m.data === "string" ? m.data : "" });
  ws.onclose = (e) => {
    if (sockets.get(sid) !== ws && sockets.has(sid)) return;
    const httpStatus = e.code >= 4100 && e.code < 4600 ? e.code - 4000 : undefined;
    push({ type: "ws.closed", sid, code: httpStatus ? undefined : e.code, reason: e.reason, httpStatus });
  };
}

function cancelRun(key: string, reason: string) {
  const r = runs.get(key);
  log("out", `cancel ${key} (${reason})`, "out");
  if (!r) return;
  runs.delete(key);
  r.abort.abort();
  // Cancelled on purpose: the agent stops too. A call that ended leaves a coding agent working in T3.
  if (reason === "cancelled" && !checked("fakehermes")) {
    void fetch(r.agent === "t3" ? "/agent/cancel" : "/hermes/stop", { method: "POST", body: JSON.stringify({ call: callName, taskId: r.taskId }) });
  }
}

/** More for a running task, into its current run; if the agent won't take it, the core queues it instead. */
async function steerRun(c: Command) {
  const r = runs.get(c.run);
  log("out", `steer ${c.run}: ${c.text}`, "out");
  if (checked("fakehermes")) return;
  const ok = r != null &&
    (await fetch(c.agent === "t3" ? "/agent/steer" : "/hermes/steer", { method: "POST", body: JSON.stringify({ call: callName, taskId: r.taskId, text: c.message }) }).then((x) => x.ok, () => false));
  if (!ok) push({ type: "tool.steerFailed", run: c.run, text: c.text });
  else toast(`${c.agent === "t3" ? "The coding agent" : "Hermes"} took the follow-up while it works`);
}

async function tool(c: Command) {
  if (c.kind === "host") {
    log("out", `host tool ${c.name} ${JSON.stringify(c.args)}`, "out");
    const answer = c.name === "tv_volume" ? `The TV is at ${(fakeTvLevel = Number(c.args?.level ?? fakeTvLevel))}.`
      : c.name === "tv_pause" ? (c.args?.pause === false ? "Playing." : "Paused.") : "Done.";
    setTimeout(() => push({ type: "tool.result", run: c.run, text: answer }), 300);
    return;
  }
  const agent = c.agent === "t3" ? "t3" : "hermes";
  log("out", `${agent} ${c.followUp ? "follow-up" : "task"} "${c.label}"${c.project ? ` in ${c.project}` : ""}: ${c.request}`, "out");
  const abort = new AbortController();
  runs.set(c.run, { abort, agent, taskId: c.taskId });
  const done = (text: string, failed = false) => {
    if (!runs.has(c.run)) return;
    runs.delete(c.run);
    const view = tasks.get(c.taskId);
    const row = result(agent, c.label, text, failed);
    notify(`${agent === "t3" ? "T3" : "Hermes"} · ${c.label}`, text);
    if (!failed) { remember("assistant", text, `${agent === "t3" ? "T3" : "Hermes"} · ${c.label}`); lastLine = null; }
    if (view) { view.result = row; showTasks(); }
    push({ type: "tool.result", run: c.run, text, failed });
  };
  if (checked("fakehermes")) {
    const timer = setTimeout(() => done(`(Fake ${agent === "t3" ? "T3" : "Hermes"}) Done: “${c.request}”. Nothing was actually run.`), Number($<HTMLInputElement>("fakedelay").value) * 1000);
    abort.signal.onabort = () => clearTimeout(timer);
    return;
  }
  try {
    const response = await fetch(agent === "t3" ? "/agent" : "/hermes", {
      method: "POST", signal: abort.signal, headers: { "content-type": "application/json" },
      body: JSON.stringify({ call: callName, taskId: c.taskId, followUp: c.followUp, message: c.message, label: c.label, request: c.request, project: c.project, approvals: "screen" }),
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
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
        else if (event === "thread") { const view = tasks.get(c.taskId); if (view) { view.thread = data.thread; showTasks(); } }
        else if (event === "approval") {
          const view = tasks.get(c.taskId);
          if (view) { view.approval = { command: data.command }; showTasks(true); }
          toast(`Hermes asks to run: ${data.command.slice(0, 80)}`);
          notify(`Hermes · ${c.label} needs your approval`, data.command);
          audio.cue(APPROVAL_TONE);
        }
        else if (event === "result") done(data.text, data.failed);
        else if (event === "error") { runs.delete(c.run); push({ type: "tool.error", run: c.run, message: data.message }); }
      }
    }
    if (runs.has(c.run)) { runs.delete(c.run); push({ type: "tool.error", run: c.run, message: "the server closed the stream without a result" }); }
  } catch (err) {
    if (!abort.signal.aborted && runs.has(c.run)) { runs.delete(c.run); push({ type: "tool.error", run: c.run, message: (err as Error).message }); }
  }
}

function micOptions() {
  const aec = checked("aec");
  return { echoCancellation: aec, noiseSuppression: aec, autoGainControl: aec };
}

function readConfig(): Record<string, unknown> {
  const given = JSON.parse($<HTMLTextAreaElement>("config").value);
  const config: Record<string, unknown> = {
    model: server.model, api: server.route === "vertex" ? "vertex" : "gemini", today: new Date().toISOString().slice(0, 10),
    ...given, trace: checked("trace"),
  };
  if (checked("ptt")) config.muted = true;
  if (given.voice === undefined) config.voice = $<HTMLSelectElement>("voice").value;
  if (config.steering === undefined) config.steering = ["hermes", "t3"];
  // A web config saved before hand-offs were named in words gets that too.
  if (config.handOff === undefined && config.platform === "web") config.handOff = "named";
  // And one saved before the page followed the user's lead (supervise) gets that.
  if (config.supervise === undefined && config.platform === "web") config.supervise = true;
  if (checked("coding") && (server.t3 || checked("fakehermes")) && config.codingAgent === undefined) config.codingAgent = { projects: server.t3 ?? [] };
  if (checked("captions") && server.captionsModel && config.captions === undefined) config.captions = { model: server.captionsModel };
  return config;
}

async function start(carryOn = false) {
  if (callId) return;
  let given: Record<string, unknown>;
  try {
    given = readConfig();
  } catch (err) {
    toast(`The developer settings aren't valid JSON: ${(err as Error).message}`);
    return;
  }
  $<HTMLButtonElement>("call").disabled = true;
  if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission().catch(() => {});
  try {
    await audio.open();
    core = await loadCore();
  } finally {
    $<HTMLButtonElement>("call").disabled = false;
  }
  $("version").textContent = core.version;
  $("log").innerHTML = "";
  if (tasks.size > 0 || $("transcript").childElementCount > 1) note(`New call · ${new Date().toLocaleTimeString()}`);
  tasks.clear();
  showTasks();
  counts = { mic: 0, play: 0, sent: 0 };
  metrics.reply = [];
  startedAt = now();
  muted = given.muted === true;
  // Carrying on: the model gets the last conversation as a recap. The core caps it, latest lines first.
  if (carryOn && given.history === undefined) given.history = savedHistory();
  else if (!carryOn) chat = [];
  if (carryOn) chat = savedHistory();
  lastLine = null;
  openLine = null;
  $("resume").hidden = true;
  callName = `${new Date().toISOString().replace(/[:.]/g, "-")}-web-${core.version}`;
  const created = JSON.parse(core.create(JSON.stringify(given), now()));
  callId = created.id;
  $<HTMLButtonElement>("call").textContent = "Hang up";
  $("call").classList.add("live");
  for (const id of ["mic", "hush"]) $<HTMLButtonElement>(id).disabled = false;
  $("mic").classList.toggle("muted", muted);
  run(created.commands);
  ticker = window.setInterval(() => {
    push({ type: "tick" });
    const level = muted && !holding ? 0 : audio.level;
    $("ring").style.opacity = String(Math.min(1, level * 12));
    $("counts").textContent = `mic ${counts.mic} · sent ${counts.sent} · played ${counts.play} · queued ${audio.queued.toFixed(1)} s`;
    showStatus();
  }, 100);
  traceTimer = window.setInterval(() => { void saveTrace(); void ping(); showTasks(); }, 5000);
  void ping();
  stopWords.start();
  try { wakeLock = await (navigator as any).wakeLock?.request("screen"); } catch {}
}

function hangUp() {
  if (callId) push({ type: "stop", message: "You hung up." });
}

function end() {
  window.clearInterval(ticker);
  window.clearInterval(traceTimer);
  stopWords.stop();
  void saveTrace().then(() => { if (core && callId) core.dispose(callId); callId = 0; showTasks(); });
  audio.stop();
  for (const ws of sockets.values()) ws.close();
  sockets.clear();
  for (const r of runs.values()) r.abort.abort();
  runs.clear();
  $<HTMLButtonElement>("call").textContent = "Call";
  $("call").classList.remove("live");
  for (const id of ["mic", "hush"]) $<HTMLButtonElement>(id).disabled = true;
  $("ring").style.opacity = "0";
  $("resume").hidden = chat.length === 0;
  void showEarlier();
  void wakeLock?.release().catch(() => {});
  wakeLock = null;
}

function setMuted(value: boolean) {
  if (!callId || muted === value) return;
  muted = value;
  $("mic").classList.toggle("muted", muted);
  push({ type: muted ? "mute" : "unmute" });
  showStatus();
}

/** Sends what the trace kept since last time to the dev server, as JSON lines: a header, then events. */
async function saveTrace() {
  if (!core || !callId || !checked("trace")) return;
  const kept = JSON.parse(core.trace(callId));
  if (!kept) return;
  const lines: string[] = [];
  if (kept.config) lines.push(JSON.stringify({ version: kept.version, config: kept.config, start: kept.start }));
  for (const e of kept.events) lines.push(JSON.stringify(e));
  if (lines.length === 0) return;
  await fetch(`/traces?name=${encodeURIComponent(callName)}.jsonl`, { method: "POST", body: lines.join("\n") + "\n" }).catch(() => {});
  $("tracename").textContent = `trace ${callName}.jsonl`;
}

// "Stop" and "goodbye" heard by the browser's own recognizer: quicker than the model's transcript,
// and it works while the model's reply plays even when the model isn't hearing the microphone.

class StopWords {
  private rec: any = null;
  private on = false;
  private commands = { stop: [] as string[], hangUp: [] as string[], cancelAll: [] as string[] };

  get supported(): boolean {
    return "webkitSpeechRecognition" in window || "SpeechRecognition" in window;
  }

  start() {
    if (!checked("stopword") || !this.supported || !core) return;
    this.commands = JSON.parse(core.defaults()).voiceCommands;
    const Recognition = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    this.rec = new Recognition();
    this.rec.continuous = true;
    this.rec.interimResults = true;
    this.rec.lang = navigator.language || "en-GB";
    this.rec.onresult = (e: any) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const text = e.results[i][0].transcript as string;
        const command = commandIn(text, this.commands, ["Woodhouse", "Hermes", "Bento"]);
        if (command === "stop" && audio.queued > 0.05) {
          log("out", `local stop word: ${text}`, "out");
          toast(`Heard “${text.trim()}”: stopped`);
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
    this.rec.onend = () => { if (this.on) setTimeout(() => { try { this.rec?.start(); } catch {} }, 250); };
    this.rec.onerror = (e: any) => { if (e.error === "not-allowed") this.on = false; };
    this.on = true;
    try { this.rec.start(); } catch {}
  }

  stop() {
    this.on = false;
    try { this.rec?.stop(); } catch {}
    this.rec = null;
  }
}
const stopWords = new StopWords();

// Wiring.

function settingsFromStorage() {
  for (const id of ["aec", "stopword", "ptt", "captions", "coding", "fakehermes", "trace"]) {
    const v = localStorage.getItem(`voice.${id}`);
    if (v != null) $<HTMLInputElement>(id).checked = v === "1";
    $(id).addEventListener("change", () => localStorage.setItem(`voice.${id}`, checked(id) ? "1" : "0"));
  }
  const delay = localStorage.getItem("voice.fakedelay");
  if (delay) $<HTMLInputElement>("fakedelay").value = delay;
  $("fakedelay").addEventListener("change", () => localStorage.setItem("voice.fakedelay", $<HTMLInputElement>("fakedelay").value));
  const voice = localStorage.getItem("voice.voice");
  if (voice) $<HTMLSelectElement>("voice").value = voice;
  $("voice").addEventListener("change", () => localStorage.setItem("voice.voice", $<HTMLSelectElement>("voice").value));
  const mode = localStorage.getItem("voice.mode");
  if (mode) $<HTMLSelectElement>("mode").value = mode;
  $("mode").addEventListener("change", () => localStorage.setItem("voice.mode", $<HTMLSelectElement>("mode").value));
}

function tabs() {
  const views: Record<string, HTMLElement> = { talk: $("talk"), dev: $("dev"), replay: $("replaymain") };
  for (const name of Object.keys(views)) {
    $(`tab-${name}`).onclick = () => {
      for (const [other, el] of Object.entries(views)) {
        el.hidden = other !== name;
        $(`tab-${other}`).classList.toggle("on", other === name);
      }
    };
  }
  $("gear").onclick = () => { $("settings").hidden = false; };
  $("closesettings").onclick = () => { $("settings").hidden = true; };
  $("settings").onclick = (e) => { if (e.target === $("settings")) $("settings").hidden = true; };
}

function typing(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

function keys() {
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && callId) { push({ type: "interrupt" }); audio.flush(); return; }
    if (typing() || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "m" || e.key === "M") { setMuted(!muted); e.preventDefault(); }
    else if (e.key === "/") { $("text").focus(); e.preventDefault(); }
    else if (e.code === "Space" && callId && muted && !e.repeat) { holding = true; push({ type: "unmute" }); showStatus(); e.preventDefault(); }
  });
  document.addEventListener("keyup", (e) => {
    if (e.code === "Space" && holding) { holding = false; push({ type: "mute" }); showStatus(); }
  });
}

function submitText(e: Event) {
  e.preventDefault();
  const input = $<HTMLInputElement>("text");
  let text = input.value.trim();
  if (!text) return;
  if (!callId) { toast("Start a call first"); return; }
  // "/t3 …" and "/h …" pick the agent whatever the selector says.
  let mode = $<HTMLSelectElement>("mode").value;
  const prefix = text.match(/^\/(t3|code|h|hermes)\s+/i);
  if (prefix) { mode = /^(t3|code)$/i.test(prefix[1]) ? "t3" : "hermes"; text = text.slice(prefix[0].length).trim(); }
  if (!text) return;
  if (mode === "say") push({ type: "say", text });
  else {
    push({ type: "ask", text, agent: mode });
    note(`You → new ${mode === "t3" ? "coding" : "Hermes"} task: ${text}`);
  }
  input.value = "";
}

async function main() {
  server = await (await fetch("/config")).json();
  $("route").textContent = `${server.route === "vertex" ? "GSK Vertex" : "Gemini API"} · ${server.model.split("/").pop()}`;
  $("version").textContent = server.version;
  $("build").textContent = `core ${server.version}`;
  settingsFromStorage();
  if (!server.hermes) { $<HTMLInputElement>("fakehermes").checked = true; $<HTMLInputElement>("fakehermes").disabled = true; }
  if (!server.t3) $("codinghelp").textContent = "T3 isn't available on the server: only with fake answers.";
  else $("codinghelp").textContent = `Code changes go to a T3 Code thread in one of: ${server.t3.join(", ")}.`;
  if (!stopWords.supported) { $<HTMLInputElement>("stopword").checked = false; $<HTMLInputElement>("stopword").disabled = true; }
  const preset = $<HTMLSelectElement>("preset");
  for (const name of Object.keys(PRESETS)) preset.add(new Option(name, name));
  preset.value = localStorage.getItem("voice-core.preset") ?? "web";
  if (!PRESETS[preset.value]) preset.value = "web";
  $<HTMLTextAreaElement>("config").value = localStorage.getItem("voice-core.config") ?? JSON.stringify(PRESETS[preset.value], null, 2);
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
  $("call").onclick = () => (callId ? hangUp() : void start().catch((err) => { toast(err.message); log("error", err.message, "err"); }));
  $("resume").onclick = () => void start(true).catch((err) => { toast(err.message); log("error", err.message, "err"); });
  if (savedHistory().length > 0) { $("resume").hidden = false; $("resume").title = "Call again, carrying on from the last conversation"; }
  $("mic").onclick = () => setMuted(!muted);
  $("hush").onclick = () => { push({ type: "interrupt" }); audio.flush(); };
  $("cancelall").onclick = () => push({ type: "cancelAll" });
  $("donebox").addEventListener("toggle", () => { if ($<HTMLDetailsElement>("donebox").open) $("donebox").scrollIntoView({ block: "nearest" }); });
  $("say").onsubmit = submitText;
  $("text").addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") submitText(e); });
  tabs();
  keys();
  const events = new EventSource("/events");
  events.addEventListener("core", (e) => {
    const { version } = JSON.parse((e as MessageEvent).data);
    $("version").textContent = version + (callId && core && core.version !== version ? ` (next call; this one runs ${core.version})` : "");
    $("build").textContent = `core ${version}`;
  });
  events.addEventListener("app", () => { if (!callId) location.reload(); else toast("The page changed: reload after this call"); });
  events.addEventListener("error", (e) => {
    const data = (e as MessageEvent).data;
    if (data) toast(`Build failed: ${JSON.parse(data).message}`);
  });
  new Replay($("replay"), loadCore);
  void ping();
  void showEarlier();
  window.setInterval(() => void showEarlier(), 30_000);
}

void main();
