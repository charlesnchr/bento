// A headless host: says WAV files into a call through the dev server (the same relay and core
// build the web surface uses), against the real model, and prints what happened. The quickest
// end-to-end check of a change, and one a script can run.
//
//   node dev/talk.ts question.wav [@2.5:talk_over.wav] [next.wav ...] [--preset echo] [--hermes] [--captions]
//                    [--out reply.wav] [--server http://127.0.0.1:8770] [--quiet 4] [--max 60]
//                    [--delay 2,40] [--reply answer.txt] [--config '{"standbyAfter":5}']
//
// A plain WAV is said once the call is quiet (the model's reply has played and 1.5 s passed);
// "@<s>:" says it <s> seconds after the previous one started instead (talking over a reply).
// Hermes (and T3, with --coding) is faked (an answer after 2 s) unless --hermes. --delay sets the fake's seconds, one
// for each task in order (the last for the rest), and --reply the first task's answer, from a file: a long reply and a
// slow task are what standby and its recap need. --config merges JSON over the preset. The call ends --quiet seconds
// after the last reply, or after --max seconds. --out writes what the model said as one WAV, gaps included.
// --captions turns the core's captions on and prints each one as it comes, so the words shown
// while a WAV is still being said can be read off against the model's transcript after it.

import { readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";
import WebSocket from "ws";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const SERVER = option("server", "http://127.0.0.1:8770");
const PRESET = option("preset", "web");
const QUIET = Number(option("quiet", "4"));
/** Tasks still running: the call waits for them before it hangs up. */
const running = new Set<string>();
/** Each tool run's task, for steering it. */
const taskOf = new Map<string, string>();
const MAX = Number(option("max", "60"));
const OUT = option("out", "");
const DELAYS = option("delay", "2").split(",").map(Number);
const REPLY = option("reply", "") ? readFileSync(option("reply", ""), "utf8").trim() : null;
const EXTRA = JSON.parse(option("config", "{}"));
let faked = 0;
const optionValues = new Set(["--server", "--preset", "--quiet", "--max", "--out", "--delay", "--reply", "--config"].filter((o) => args.includes(o)).map((o) => args[args.indexOf(o) + 1]));
const plan = args.filter((a) => !a.startsWith("--") && !optionValues.has(a)).map((a) => {
  const m = a.match(/^@([\d.]+):(.*)$/);
  return m ? { at: Number(m[1]), file: m[2] } : { at: null as number | null, file: a };
});
if (plan.length === 0) { console.error("say which WAV files to speak"); process.exit(2); }

const PRESETS: Record<string, Record<string, unknown>> = {
  web: { platform: "web", device: "browser", handOff: "named", supervise: true },
  android: { platform: "Android", device: "phone" },
  echo: { platform: "Echo", device: "speaker", mic: { whileSpeaking: "wake", gainDb: 0 }, hangUpAfter: 6 },
};

/** A WAV's samples as 16 kHz PCM16 mono. */
function wav16k(path: string): Int16Array {
  const b = readFileSync(path);
  let o = 12, rate = 16000, channels = 1, data: Buffer | null = null;
  while (o + 8 <= b.length) {
    const id = b.toString("ascii", o, o + 4), size = b.readUInt32LE(o + 4);
    if (id === "fmt ") { channels = b.readUInt16LE(o + 10); rate = b.readUInt32LE(o + 12); }
    if (id === "data") { data = b.subarray(o + 8, o + 8 + size); break; }
    o += 8 + size + (size % 2);
  }
  if (!data) throw new Error(`${path}: no data chunk`);
  const n = Math.floor(data.length / 2 / channels);
  const mono = new Float64Array(n);
  for (let i = 0; i < n; i++) mono[i] = data.readInt16LE(2 * i * channels);
  const out = new Int16Array(Math.floor((n * 16000) / rate));
  for (let i = 0; i < out.length; i++) {
    const x = (i * rate) / 16000, j = Math.floor(x);
    const a = mono[Math.min(j, n - 1)], c = mono[Math.min(j + 1, n - 1)];
    out[i] = Math.round(a + (c - a) * (x - j));
  }
  return out;
}

// Behind Cloudflare Access (https://voice.charlesnchr.com), a service token from the environment
// (VOICE_CORE_ACCESS_ID and VOICE_CORE_ACCESS_SECRET; ~/.local/share/voice-core/access.env) lets it in.
const ACCESS: Record<string, string> = process.env.VOICE_CORE_ACCESS_ID
  ? { "CF-Access-Client-Id": process.env.VOICE_CORE_ACCESS_ID, "CF-Access-Client-Secret": process.env.VOICE_CORE_ACCESS_SECRET ?? "", "User-Agent": "Mozilla/5.0 voice-core-talk" }
  : {};
const get = (url: string, init: RequestInit = {}) => fetch(url, { ...init, headers: { ...ACCESS, ...(init.headers as Record<string, string> ?? {}) } });

const config = await (await get(`${SERVER}/config`)).json();
const context = vm.createContext({});
vm.runInContext(await (await get(`${SERVER}/voice-core.js`)).text(), context);
const core = context.VoiceCore;
console.log(`core ${core.version}, ${config.route} ${config.model.split("/").pop()}, preset ${PRESET}, Hermes ${flag("hermes") ? "real" : "fake"}`);

const t0 = performance.now() / 1000;
const now = () => performance.now() / 1000;
const stamp = () => (now() - t0).toFixed(2).padStart(6);
const sockets = new Map<number, WebSocket>();
const reply: { at: number; pcm: Buffer }[] = [];
const latencies: number[] = [];
let timed = true;
let callId = 0, ended = false, micOn = false, speechUntil = 0, lastReply = 0, spoken = 0;
const say = (s: string) => console.log(`${stamp()}  ${s}`);
const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-talk-${core.version}`;

function push(e: Record<string, unknown>) {
  if (ended) return;
  run(JSON.parse(core.push(callId, JSON.stringify({ ...e, t: now() }))));
}

let userLine = "", modelLine = "", textLine = 0;
function flushLines() {
  if (userLine) { say(`you: ${userLine.trim()}`); userLine = ""; }
  if (modelLine) { say(`model: ${modelLine.trim()}`); modelLine = ""; }
}

function run(commands: Record<string, any>[]) {
  for (const c of commands) {
    switch (c.type) {
      case "ws.connect": {
        const ws = new WebSocket(`${SERVER.replace(/^http/, "ws")}/live${c.purpose === "captions" ? "?for=captions" : ""}`, { headers: ACCESS });
        sockets.set(c.sid, ws);
        ws.on("open", () => push({ type: "ws.open", sid: c.sid }));
        ws.on("error", (err) => say(`(socket ${c.sid}: ${err.message})`)); // "close" follows
        ws.on("message", (d) => push({ type: "ws.message", sid: c.sid, data: d.toString() }));
        ws.on("close", (code, reason) => { if (sockets.get(c.sid) === ws) push({ type: "ws.closed", sid: c.sid, code, reason: reason.toString() }); });
        break;
      }
      case "ws.send": sockets.get(c.sid)?.send(c.data); break;
      case "ws.close": { const ws = sockets.get(c.sid); sockets.delete(c.sid); ws?.close(); break; }
      case "mic.start": micOn = true; break;
      case "mic.stop": micOn = false; break;
      case "play": {
        const pcm = Buffer.from(c.pcm, "base64");
        // A reply starting after the user finished: how long they waited for its first sound.
        if (saidUntil > 0 && now() - saidUntil < 10 && speechUntil < now() - 0.3 && !timed) {
          timed = true;
          latencies.push(now() - saidUntil);
          say(`(first sound ${(now() - saidUntil).toFixed(2)} s after the user stopped)`);
        }
        speechUntil = Math.max(speechUntil, now()) + pcm.length / 48000;
        lastReply = speechUntil;
        reply.push({ at: now() - t0, pcm });
        break;
      }
      case "flush": flushLines(); say("(playback flushed)"); speechUntil = now(); break;
      case "cue": say(`(tone: ${c.earcon})`); break;
      case "wakeword": say(`(wake word ${c.on ? "listening" : "off"})`); break;
      case "caption": say(c.text == null ? "(caption down)" : `caption: ${c.text}`); break;
      case "transcript":
        if (c.line !== textLine) { flushLines(); textLine = c.line; }
        if (c.role === "user") userLine += c.text; else modelLine += c.text;
        break;
      case "status": flushLines(); say(`[${c.status}${c.message ? ": " + c.message : ""}]`); if (c.status === "ended") finish(); break;
      case "task": if (c.state === "running") running.add(c.id); else { running.delete(c.id); lastReply = now(); } say(`task "${c.label}" ${c.state}${c.question ? ", asks: " + c.question : ""}`); break;
      case "tool.call":
        flushLines();
        if (c.kind === "host") { say(`host tool ${c.name} ${JSON.stringify(c.args)}`); setTimeout(() => push({ type: "tool.result", run: c.run, text: "Done." }), 300); break; }
        say(`${c.agent === "t3" ? "T3" : "Hermes"} ${c.followUp ? "follow-up" : "task"} "${c.label}"${c.project ? ` in ${c.project}` : ""}: ${c.request}`);
        taskOf.set(c.run, c.taskId);
        if (flag("hermes")) void hermes(c);
        else {
          const n = faked++;
          const text = n === 0 && REPLY != null ? REPLY : `(Fake ${c.agent === "t3" ? "T3" : "Hermes"}) Done: ${c.request}. Nothing was actually run.`;
          setTimeout(() => push({ type: "tool.result", run: c.run, text }), (DELAYS[Math.min(n, DELAYS.length - 1)] || 2) * 1000);
        }
        break;
      case "voiceCommand": say(`(voice command ${c.command}: ${c.heard})`); break;
      case "tool.steer": {
        say(`(steering ${c.agent === "t3" ? "T3" : "Hermes"}: ${c.text})`);
        const task = taskOf.get(c.run);
        if (!flag("hermes") || !task) break;
        void get(`${SERVER}/${c.agent === "t3" ? "agent" : "hermes"}/steer`, { method: "POST", body: JSON.stringify({ call: name, taskId: task, text: c.message }) })
          .then((r) => { say(`(steer ${r.ok ? "taken" : "refused"})`); if (!r.ok) push({ type: "tool.steerFailed", run: c.run, text: c.text }); });
        break;
      }
      case "log": say(`(${c.level}: ${c.message})`); break;
    }
  }
}

async function hermes(c: Record<string, any>) {
  const who = c.agent === "t3" ? "T3" : "Hermes";
  const response = await get(`${SERVER}/${c.agent === "t3" ? "agent" : "hermes"}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ call: name, taskId: c.taskId, followUp: c.followUp, message: c.message, label: c.label, request: c.request, project: c.project }),
  });
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let cut;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const event = block.match(/^event: (.*)$/m)?.[1];
      if (!event) continue;
      const data = JSON.parse(block.match(/^data: (.*)$/m)?.[1] ?? "{}");
      if (event === "progress") { say(`(${who}: ${data.text.slice(0, 120)})`); push({ type: "task.progress", task: c.taskId, text: data.text }); }
      if (event === "result") { say(`${who}: ${data.text.slice(0, 200)}`); push({ type: "tool.result", run: c.run, text: data.text, failed: data.failed }); }
      if (event === "error") push({ type: "tool.error", run: c.run, message: data.message });
    }
  }
}

function finish() {
  if (ended) return;
  ended = true;
  if (latencies.length > 0) say(`(first sound after the user stopped: ${latencies.map((l) => l.toFixed(2)).join(", ")} s)`);
  for (const ws of sockets.values()) ws.close();
  const trace = JSON.parse(core.trace(callId));
  const lines = [JSON.stringify({ version: trace.version, config: trace.config, start: trace.start }), ...trace.events.map((e: unknown) => JSON.stringify(e))];
  void get(`${SERVER}/traces?name=${name}.jsonl`, { method: "POST", body: lines.join("\n") + "\n" }).then(() => {
    say(`trace: traces/${name}.jsonl (replay it in the web surface)`);
    if (OUT) writeReply(OUT);
    setTimeout(() => process.exit(0), 100);
  });
}

function writeReply(path: string) {
  if (reply.length === 0) return;
  const start = reply[0].at;
  let total = 0;
  for (const r of reply) total = Math.max(total, Math.round((r.at - start) * 24000) * 2 + r.pcm.length);
  const pcm = Buffer.alloc(total);
  let cursor = 0;
  for (const r of reply) { const at = Math.max(cursor, Math.round((r.at - start) * 24000) * 2); r.pcm.copy(pcm, at); cursor = at + r.pcm.length; }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + cursor, 4); header.write("WAVEfmt ", 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(cursor, 40);
  writeFileSync(path, Buffer.concat([header, pcm.subarray(0, cursor)]));
  say(`reply audio: ${path}`);
}

// The microphone: room noise, with each WAV said when its time comes.

const created = JSON.parse(core.create(JSON.stringify({ model: config.model, api: config.route === "vertex" ? "vertex" : "gemini", today: new Date().toISOString().slice(0, 10), trace: true, steering: ["hermes", "t3"], ...PRESETS[PRESET],
  ...(flag("coding") ? { codingAgent: { projects: config.t3 ?? [] } } : {}),
  ...(flag("captions") ? { captions: { model: config.captionsModel } } : {}), ...EXTRA }), now()));
callId = created.id;
run(created.commands);

let speaking: Int16Array | null = null, offset = 0, saidAt = 0, saidUntil = 0, next = 0, micStart = 0;
const noise = () => Math.round((Math.random() - 0.5) * 60);
setInterval(() => push({ type: "tick" }), 100);
setInterval(() => {
  if (!micOn || ended) return;
  if (!micStart) micStart = now();
  const t = now();
  if (!speaking && next < plan.length) {
    const step = plan[next];
    const due = step.at != null ? saidAt > 0 && t - saidAt >= step.at : (next === 0 ? t - micStart >= 1 : t > speechUntil + 1.5 && t - saidUntil > 2 && lastReply > saidUntil);
    if (due) { speaking = wav16k(step.file); offset = 0; saidAt = t; next++; say(`(saying ${step.file})`); }
  }
  const frame = Buffer.alloc(640);
  for (let i = 0; i < 320; i++) frame.writeInt16LE(speaking && offset < speaking.length ? speaking[offset++] : noise(), 2 * i);
  if (speaking && offset >= speaking.length) { speaking = null; spoken++; saidUntil = t; timed = false; }
  push({ type: "mic", pcm: frame.toString("base64") });
  const doneTalking = spoken === plan.length && !speaking;
  if ((doneTalking && running.size === 0 && t - Math.max(lastReply, saidUntil) > QUIET) || t - t0 > MAX) push({ type: "stop" });
}, 20);
