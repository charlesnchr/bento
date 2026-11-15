// Runs one scripted call against the real model: a simulated user (synthesized speech played into
// the call's microphone on a script that reacts to the call), scripted fake agents in place of
// Hermes and T3, and a log of everything the core heard and did, for metrics.ts to score.
//
//   node eval/run.ts scenarios/single-task.json [--out runs/x] [--bundle dist/voice-core.js]
//                    [--config '{"standbyAfter":0}'] [--audio] [--quietly]
//
// The scenario format is in eval/README.md. The call is real time: a scenario takes as long as
// the conversation it scripts.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import type WebSocket from "ws";
import { brief } from "./brief.ts";
import { liveModelPath, liveSocket, speech } from "./vertex.ts";

export interface AgentScript {
  /** How checks and steps name this agent's task. */
  id: string;
  /** Tested against the request's words (case-insensitive). */
  match: string;
  /** "hermes" or "t3": only requests to that agent match. */
  agent?: string;
  /** Seconds until the result. */
  after: number;
  /** [seconds from the start, progress line]. */
  progress?: [number, string][];
  result?: string;
  /** The run fails with this message instead. */
  error?: string;
  /** Later requests in the same task (follow-ups, answers), tried in order. */
  followUps?: Omit<AgentScript, "followUps" | "agent">[];
  /** A steer into the running task: "accept" (default) or "refuse". */
  steer?: "accept" | "refuse";
  /** With an accepted steer, the result becomes this. */
  steeredResult?: string;
}

export interface Step {
  say?: string;
  id?: string;
  voice?: string;
  style?: string;
  gain?: number;
  /** Not addressed to the assistant (a TV, the user talking to someone else). */
  ambient?: boolean;
  /** "turn" (default), "now", {speaking: s}, or {after: condition, delay: s}. */
  when?: "turn" | "now" | { speaking: number } | { after: string; delay?: number };
  gap?: number;
  patience?: number;
  /** False lets the next step start while this is still being said. */
  block?: boolean;
  /** The host's wake word detector fires this many seconds into the clip (true = 0.7). */
  wake?: boolean | number;
  wait?: number;
  until?: string;
  timeout?: number;
  event?: Record<string, unknown>;
  mark?: string;
}

export interface Scenario {
  name: string;
  about: string;
  config?: Record<string, unknown>;
  agents?: AgentScript[];
  steps: Step[];
  /** Seconds after which the call is ended whatever the script is doing. */
  max?: number;
  checks?: unknown[];
  judge?: string[];
}

export interface Rec { t: number; k: string; [key: string]: unknown }

const BASE_CONFIG = {
  api: "vertex", platform: "web", device: "browser", vocabulary: ["Hermes", "Bento", "Woodhouse", "T3"],
  standbyAfter: 30, hangUpAfter: 0, steering: ["hermes", "t3"], trace: true,
};

const sleep = (s: number) => new Promise<void>((r) => setTimeout(r, s * 1000));

export async function runScenario(scenario: Scenario, o: { bundle: string; config?: Record<string, unknown>; out: string; audio?: boolean; quiet?: boolean }): Promise<Rec[]> {
  // Every clip is synthesized (or read from the cache) before the call starts, so none delays a step.
  const clips = new Map<Step, Int16Array>();
  for (const s of scenario.steps) if (s.say) clips.set(s, await speech(s.say, s.voice ?? (s.ambient ? "Kore" : "Puck"), s.style ?? ""));

  const context = vm.createContext({});
  vm.runInContext(readFileSync(o.bundle, "utf8"), context);
  const core = (context as any).VoiceCore;
  const config = { ...BASE_CONFIG, model: liveModelPath, today: new Date().toISOString().slice(0, 10), ...(scenario.config ?? {}), ...(o.config ?? {}) };

  const t0 = performance.now() / 1000;
  const now = () => performance.now() / 1000 - t0;
  const log: Rec[] = [];
  const rec = (k: string, more: Record<string, unknown> = {}) => {
    const r = { t: +now().toFixed(3), k, ...more };
    log.push(r);
    if (!o.quiet && !["play", "task", "model", "send"].includes(k)) console.log(`${r.t.toFixed(1).padStart(6)}  ${k.padEnd(13)} ${describe(r)}`);
    return r;
  };
  rec("run", { scenario: scenario.name, core: core.version, model: liveModelPath.split("/").pop(), config });

  const sockets = new Map<number, WebSocket>();
  let callId = 0, ended = false, micOn = false;
  let speechUntil = 0, modelSpeakingSince: number | null = null, lastUserEnd = 0, lastPlay = -1, status = "";
  let modelText = "", repliedSince = false, dispatchedSince = false;
  const dispatched = new Map<string, number>(), resulted = new Map<string, number>();
  const speaking: { step: Step; pcm: Int16Array; offset: number; gain: number; id: string; waked: boolean; done: () => void }[] = [];
  const playLog: { at: number; pcm: Buffer }[] = [];
  const micLog: Buffer[] = [];

  // Fake agents.
  const scripts = scenario.agents ?? [];
  const taskScript = new Map<string, AgentScript>();
  const runs = new Map<string, { timers: NodeJS.Timeout[]; id: string; taskId: string; script: Omit<AgentScript, "followUps"> | null; result: string }>();

  function agentCall(c: Record<string, any>) {
    let script: Omit<AgentScript, "followUps"> | null = null;
    let id = "?";
    const words = String(c.request ?? "");
    const owner = taskScript.get(c.taskId);
    if (c.followUp && owner) {
      id = owner.id;
      script = (owner.followUps ?? []).find((f) => new RegExp(f.match, "i").test(words)) ?? null;
      if (script) id = script.id ?? owner.id;
    } else {
      const found = scripts.find((a) => (!a.agent || a.agent === c.agent) && new RegExp(a.match, "i").test(words)) ?? null;
      if (found) { script = found; id = found.id; taskScript.set(c.taskId, found); }
    }
    const after = script?.after ?? 3;
    const result = script?.result ?? `Done: ${words}`;
    rec("agent.start", { run: c.run, id, taskId: c.taskId, agent: c.agent, label: c.label, followUp: c.followUp, request: words, project: c.project ?? null, scripted: script != null });
    dispatched.set(id, now());
    dispatchedSince = true;
    const entry = { timers: [] as NodeJS.Timeout[], id, taskId: c.taskId, script, result };
    runs.set(c.run, entry);
    for (const [at, text] of script?.progress ?? []) {
      entry.timers.push(setTimeout(() => { rec("agent.progress", { run: c.run, id, text }); push({ type: "task.progress", task: c.taskId, text }); }, at * 1000));
    }
    entry.timers.push(setTimeout(() => {
      runs.delete(c.run);
      resulted.set(id, now());
      if (script?.error) { rec("agent.result", { run: c.run, id, error: script.error }); push({ type: "tool.error", run: c.run, message: script.error }); }
      else { rec("agent.result", { run: c.run, id, text: entry.result }); push({ type: "tool.result", run: c.run, text: entry.result }); }
    }, after * 1000));
  }

  function push(e: Record<string, unknown>) {
    if (ended) return;
    handle(JSON.parse(core.push(callId, JSON.stringify({ ...e, t: performance.now() / 1000 }))));
  }

  function handle(commands: Record<string, any>[]) {
    for (const c of commands) {
      switch (c.type) {
        case "ws.connect": {
          rec("ws.connect", { sid: c.sid });
          void liveSocket().then((ws) => {
            sockets.set(c.sid, ws);
            ws.on("open", () => push({ type: "ws.open", sid: c.sid }));
            ws.on("error", (err) => rec("ws.error", { sid: c.sid, message: err.message }));
            ws.on("message", (d) => { const data = d.toString(); modelFrame(data); push({ type: "ws.message", sid: c.sid, data }); });
            ws.on("close", (code, reason) => { if (sockets.get(c.sid) === ws) push({ type: "ws.closed", sid: c.sid, code, reason: reason.toString() }); });
          });
          break;
        }
        case "ws.send": sent(c.data); sockets.get(c.sid)?.send(c.data); break;
        case "ws.close": { rec("ws.close", { sid: c.sid }); const ws = sockets.get(c.sid); sockets.delete(c.sid); ws?.close(); break; }
        case "mic.start": micOn = true; rec("mic.start"); break;
        case "mic.stop": micOn = false; break;
        case "play": {
          const bytes = Math.floor((c.pcm.length * 3) / 4);
          const t = now();
          if (t > speechUntil + 0.3) modelSpeakingSince = t;
          speechUntil = Math.max(speechUntil, t) + bytes / 48000;
          lastPlay = t;
          rec("play", { dur: +(bytes / 48000).toFixed(3), source: c.source ?? "model" });
          if (o.audio) playLog.push({ at: t, pcm: Buffer.from(c.pcm, "base64") });
          break;
        }
        case "flush": rec("flush", { cut: +Math.max(0, speechUntil - now()).toFixed(2) }); speechUntil = Math.min(speechUntil, now()); modelSpeakingSince = null; break;
        case "cue": rec("cue", { earcon: c.earcon }); break;
        case "wakeword": rec("wakeword", { on: c.on }); break;
        case "transcript": rec("tx", { role: c.role, text: c.text }); if (c.role === "assistant") { modelText += c.text; repliedSince = true; } break;
        case "status": status = c.status; rec("status", { status: c.status, message: c.message ?? null }); if (c.status === "ended") ended = true; break;
        case "task": rec("task", { id: c.id, label: c.label, agent: c.agent, state: c.state, progress: c.progress, question: c.question }); break;
        case "tool.call":
          if (c.kind === "host") { rec("host.tool", { name: c.name, args: c.args }); setTimeout(() => push({ type: "tool.result", run: c.run, text: "Done." }), 300); break; }
          agentCall(c);
          break;
        case "tool.steer": {
          const run = runs.get(c.run);
          const refuse = run?.script && (taskScript.get(run.taskId)?.steer === "refuse");
          rec("agent.steer", { run: c.run, id: run?.id ?? "?", text: c.text, taken: !refuse });
          if (refuse || !run) push({ type: "tool.steerFailed", run: c.run, text: c.text });
          else { const s = taskScript.get(run.taskId); if (s?.steeredResult) run.result = s.steeredResult; }
          break;
        }
        case "tool.cancel": {
          const run = runs.get(c.run);
          if (run) { for (const timer of run.timers) clearTimeout(timer); runs.delete(c.run); }
          rec("agent.cancel", { run: c.run, id: run?.id ?? "?", reason: c.reason });
          break;
        }
        case "brief": {
          // announce.by "host": the summary and its speech, as a host would make them.
          const asked = now();
          void brief(c as any).then((b) => { rec("brief", { id: c.id, label: c.label, text: b.text, ms: b.ms, after: +(now() - asked).toFixed(2) }); push({ type: "brief.ready", id: c.id, text: b.text, pcm: b.pcm }); })
            .catch((err) => { rec("brief", { id: c.id, label: c.label, error: (err as Error).message }); push({ type: "brief.failed", id: c.id, message: (err as Error).message }); });
          break;
        }
        case "voiceCommand": rec("voiceCommand", { command: c.command, heard: c.heard }); break;
        case "log": rec("log", { level: c.level, message: c.message }); break;
        case "micSilent": rec("micSilent", { silent: c.silent }); break;
        default:
          // Commands a newer core adds are logged as they come, without their audio.
          if (c.type !== "questions" && c.type !== "mic.restart") { const { pcm: _pcm, ...rest } = c; rec("cmd." + c.type, rest); }
      }
    }
  }

  /** What the core sent the model, without the audio. */
  function sent(data: string) {
    if (data.startsWith('{"realtimeInput":{"audio"')) return;
    let m: any;
    try { m = JSON.parse(data); } catch { return; }
    if (m.setup) rec("send", { what: "setup", resumed: !!m.setup.sessionResumption?.handle, instruction: m.setup.systemInstruction?.parts?.[0]?.text?.length ?? 0 });
    else if (m.toolResponse) for (const r of m.toolResponse.functionResponses ?? []) rec("send", { what: "toolResponse", name: r.name, scheduling: r.scheduling ?? null, text: JSON.stringify(r.response).slice(0, 1500) });
    else if (m.clientContent) rec("send", { what: m.clientContent.turnComplete ? "turn" : "note", text: (m.clientContent.turns ?? []).map((x: any) => (x.parts ?? []).map((p: any) => p.text).join("")).join(" | ").slice(0, 1500) });
    else if (m.realtimeInput) rec("send", { what: "realtime", text: JSON.stringify(m.realtimeInput).slice(0, 200) });
  }

  /** What the model said in frames the core turns into commands only indirectly. */
  function modelFrame(data: string) {
    if (data.length > 200_000 && !data.includes("toolCall")) return;
    let m: any;
    try { m = JSON.parse(data); } catch { return; }
    for (const f of m.toolCall?.functionCalls ?? []) rec("model", { what: "toolCall", name: f.name, args: f.args ?? {} });
    if (m.serverContent?.interrupted) rec("model", { what: "interrupted" });
    if (m.serverContent?.turnComplete) rec("model", { what: "turnComplete" });
    if (m.voiceActivity?.type) rec("model", { what: "vad", type: m.voiceActivity.type });
    if (m.goAway) rec("model", { what: "goAway" });
    if (m.usageMetadata) rec("model", { what: "usage", usage: m.usageMetadata });
  }

  // The call.
  const created = JSON.parse(core.create(JSON.stringify(config), performance.now() / 1000));
  callId = created.id;
  handle(created.commands);

  const ticker = setInterval(() => push({ type: "tick" }), 100);
  let micStart = 0, framesSent = 0;
  const noise = () => Math.round((Math.random() - 0.5) * 60);
  const micTimer = setInterval(() => {
    if (!micOn || ended) return;
    const real = performance.now() / 1000;
    if (!micStart) micStart = real;
    // As many 20 ms frames as real time has passed, so the microphone never drifts from the clock.
    const due = Math.min(10, Math.floor((real - micStart) / 0.02) - framesSent);
    for (let n = 0; n < due; n++) {
      framesSent++;
      const frame = Buffer.alloc(640);
      for (let i = 0; i < 320; i++) {
        let v = noise();
        for (const s of speaking) if (s.offset + i < s.pcm.length) v += s.pcm[s.offset + i] * s.gain;
        frame.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), 2 * i);
      }
      for (const s of [...speaking]) {
        s.offset += 320;
        const wakeAt = s.step.wake === true ? 0.7 : typeof s.step.wake === "number" ? s.step.wake : null;
        if (wakeAt != null && !s.waked && s.offset / 16000 >= wakeAt) { s.waked = true; rec("wake", { id: s.id }); push({ type: "wake" }); }
        if (s.offset >= s.pcm.length) {
          speaking.splice(speaking.indexOf(s), 1);
          rec("say.end", { id: s.id, ambient: !!s.step.ambient });
          if (!s.step.ambient) { lastUserEnd = now(); repliedSince = false; dispatchedSince = false; }
          s.done();
        }
      }
      if (o.audio) micLog.push(frame);
      push({ type: "mic", pcm: frame.toString("base64") });
    }
  }, 10);

  const userSpeaking = () => speaking.some((s) => !s.step.ambient);
  const modelSpeaking = () => now() < speechUntil;

  function met(cond: string, since: number, textFrom: number): boolean {
    const [kind, ...rest] = cond.split(":");
    const arg = rest.join(":");
    const t = now();
    switch (kind) {
      case "quiet": return !userSpeaking() && !modelSpeaking() && t - Math.max(speechUntil, lastUserEnd, since) >= Number(arg || 3);
      case "dispatch": return dispatched.has(arg);
      case "result": return resulted.has(arg);
      case "reply": return repliedSince && !modelSpeaking() && t - speechUntil >= 0.3;
      case "status": return status === arg;
      case "said": return new RegExp(arg, "i").test(modelText.slice(textFrom));
      case "agents-done": return runs.size === 0;
      case "speaking": return modelSpeaking();
      default: throw new Error(`unknown condition "${cond}"`);
    }
  }

  async function until(cond: string, timeout: number, what: string): Promise<boolean> {
    const since = now(), textFrom = modelText.length;
    const all = cond.split("&").map((c) => c.trim());
    while (!ended) {
      if (all.every((c) => met(c, since, textFrom))) return true;
      if (now() - since > timeout) { rec("timeout", { waiting: cond, step: what }); return false; }
      await sleep(0.05);
    }
    return false;
  }

  let said = 0;
  async function say(step: Step) {
    const pcm = clips.get(step)!;
    const when = step.when ?? "turn";
    if (when === "turn") {
      const gap = step.gap ?? 1.2, patience = step.patience ?? 8;
      const asked = now();
      // The user's turn: the model has answered what was said last (or handed it off, or stayed silent for long) and has finished speaking.
      while (!ended) {
        const t = now();
        const answered = lastUserEnd === 0 || repliedSince || dispatchedSince || t - Math.max(lastUserEnd, asked) >= patience;
        if (answered && !modelSpeaking() && !userSpeaking() && t - Math.max(speechUntil, lastUserEnd) >= gap) break;
        await sleep(0.03);
      }
    } else if (when !== "now" && "speaking" in when) {
      const since = now();
      while (!ended && !(modelSpeakingSince != null && modelSpeaking() && now() - modelSpeakingSince >= when.speaking)) {
        if (now() - since > (step.timeout ?? 30)) { rec("timeout", { waiting: `speaking ${when.speaking}`, step: step.say }); break; }
        await sleep(0.03);
      }
    } else if (when !== "now" && "after" in when) {
      await until(when.after, step.timeout ?? 60, step.say ?? "");
      if (when.delay) await sleep(when.delay);
    }
    if (ended) return;
    const id = step.id ?? `u${++said}`;
    const overModel = modelSpeaking();
    rec("say.start", { id, text: step.say, ambient: !!step.ambient, dur: +(pcm.length / 16000).toFixed(2), overModel });
    const finished = new Promise<void>((done) => speaking.push({ step, pcm, offset: 0, gain: step.gain ?? (step.ambient ? 0.35 : 1), id, waked: false, done }));
    if (step.block !== false) await finished;
  }

  const deadline = scenario.max ?? 300;
  const guard = setTimeout(() => { rec("timeout", { waiting: "the scenario", step: `max ${deadline}s` }); push({ type: "stop" }); }, deadline * 1000);

  // Wait for the microphone, then run the script.
  while (!micOn && !ended && now() < 30) await sleep(0.05);
  await sleep(1);
  for (let i = 0; i < scenario.steps.length && !ended; i++) {
    const s = scenario.steps[i];
    if (s.say != null) await say(s);
    else if (s.wait != null) await sleep(s.wait);
    else if (s.until != null) await until(s.until, s.timeout ?? 30, `step ${i}`);
    else if (s.event != null) { rec("event", { event: s.event }); push(s.event); }
    else if (s.mark != null) rec("mark", { name: s.mark });
  }
  while (speaking.length > 0 && !ended) await sleep(0.05);
  rec("script.end");
  push({ type: "stop", message: "The script ended." });
  clearTimeout(guard);
  clearInterval(ticker);
  clearInterval(micTimer);
  for (const run of runs.values()) for (const timer of run.timers) clearTimeout(timer);
  for (const ws of sockets.values()) ws.close();

  mkdirSync(o.out, { recursive: true });
  writeFileSync(join(o.out, "log.jsonl"), log.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(join(o.out, "scenario.json"), JSON.stringify(scenario, null, 1));
  const trace = JSON.parse(core.trace(callId));
  writeFileSync(join(o.out, "trace.jsonl"), [JSON.stringify({ version: trace.version, config: trace.config, start: trace.start }), ...trace.events.map((e: unknown) => JSON.stringify(e))].join("\n") + "\n");
  if (o.audio) writeFileSync(join(o.out, "call.wav"), mixdown(micLog, playLog));
  return log;
}

function describe(r: Rec): string {
  const { t: _t, k: _k, ...rest } = r;
  if (r.k === "tx") return `${r.role}: ${r.text}`;
  if (r.k === "say.start") return `${r.ambient ? "(ambient) " : ""}"${r.text}"`;
  if (r.k === "run") return `${r.scenario} on core ${r.core}`;
  return JSON.stringify(rest).slice(0, 300);
}

/** The call as one 16 kHz mono WAV: the microphone and what was played, for listening to a run. */
function mixdown(mic: Buffer[], plays: { at: number; pcm: Buffer }[]): Buffer {
  const micPcm = Buffer.concat(mic);
  const n = micPcm.length >> 1;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = micPcm.readInt16LE(2 * i);
  let cursor = 0;
  const first = plays[0]?.at ?? 0;
  void first;
  for (const p of plays) {
    const at = Math.max(cursor, Math.round((p.at - 1) * 16000)); // the microphone starts about a second into the run
    const m = p.pcm.length >> 1;
    const len = Math.floor((m * 2) / 3);
    for (let i = 0; i < len && at + i < n; i++) out[at + i] += p.pcm.readInt16LE(2 * Math.min(m - 1, Math.floor(i * 1.5))) * 0.8;
    cursor = at + len;
  }
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(out[i]))), 2 * i);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name: string, fallback: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
  const file = args.find((a) => a.endsWith(".json") && !a.startsWith("{"));
  if (!file) { console.error("say which scenario to run"); process.exit(2); }
  const scenario = JSON.parse(readFileSync(file, "utf8")) as Scenario;
  const root = fileURLToPath(new URL("..", import.meta.url));
  const out = option("out", join(root, "eval/runs", `${new Date().toISOString().replace(/[:.]/g, "-")}-${basename(file, ".json")}`));
  await runScenario(scenario, {
    bundle: option("bundle", join(root, "dist/voice-core.js")),
    config: JSON.parse(option("config", "{}")),
    out,
    audio: args.includes("--audio"),
    quiet: args.includes("--quietly"),
  });
  console.log(`log: ${join(out, "log.jsonl")}`);
  process.exit(0);
}
