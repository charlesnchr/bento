// Scores one run's log (run.ts): who spoke when, what collided, what each agent result cost the
// conversation, whether the scripted checks hold. Every number comes from timestamps in the log,
// with the simulated user's own clip times as ground truth for when the user spoke.
//
//   node eval/metrics.ts runs/x [runs/y ...]     prints each run's metrics and a readable timeline

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Rec, Scenario } from "./run.ts";

export interface Utterance { id: string; text: string; start: number; end: number; ambient: boolean; when: string }
export interface Segment { start: number; end: number; text: string; cut: boolean; audio: number; source: string }

export interface Announcement {
  agent: string;
  at: number;
  /** The first segment that said every fact, and how long after the result it started. */
  voicedAt: number | null;
  delay: number | null;
  /** Segments that said every fact: more than one is a repeat. */
  times: number;
  /** Segments after the result that began saying it and were cut before the facts. */
  aborted: number;
}

export interface CheckResult { check: unknown; pass: boolean; why: string }

export interface Metrics {
  scenario: string;
  core: string;
  callSeconds: number;
  /** Seconds from the end of a user utterance to the model's first sound, for each that got a spoken reply. */
  replyLatency: number[];
  /** Seconds from the end of a request to its agent starting. */
  dispatchLatency: number[];
  /** Times the model began speaking just as, or while, the user took a turn they had waited for. */
  turnCollisions: number;
  /** Seconds the user and the model were audible at once. */
  overlapSeconds: number;
  announcements: Announcement[];
  lostResults: number;
  repeatedResults: number;
  abortedAnnouncements: number;
  /** Requests an agent got that no script expected. */
  unscriptedDispatches: number;
  /** While only ambient speech was audible: the model's speech in seconds, and its tool calls. */
  ambientSpeechSeconds: number;
  ambientToolCalls: number;
  /** Of the words the user said in a request, the share the agent received. */
  requestRecall: number[];
  modelWords: number;
  modelSpeechSeconds: number;
  userSpeechSeconds: number;
  /** Seconds a model socket was open, and the share of the call. */
  connectedSeconds: number;
  standbySeconds: number;
  checks: CheckResult[];
  timeouts: string[];
  penalties: Record<string, number>;
  score: number;
}

const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, " ").split(/\s+/).filter(Boolean);

export function loadRun(dir: string): { log: Rec[]; scenario: Scenario } {
  const log = readFileSync(join(dir, "log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Rec);
  const scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8")) as Scenario;
  return { log, scenario };
}

export function utterances(log: Rec[]): Utterance[] {
  const out: Utterance[] = [];
  const end = log.length ? log[log.length - 1].t : 0;
  for (const r of log) {
    if (r.k === "say.start") out.push({ id: r.id as string, text: r.text as string, start: r.t, end: Math.min(end, r.t + (r.dur as number)), ambient: !!r.ambient, when: "" });
    if (r.k === "say.end") { const u = out.find((x) => x.id === r.id); if (u) u.end = r.t; }
  }
  return out;
}

/** What was played, as stretches of continuous sound with the words said in each. */
export function segments(log: Rec[]): Segment[] {
  const out: Segment[] = [];
  let cur: Segment | null = null;
  let until = -1;
  for (const r of log) {
    if (r.k === "play") {
      if (cur == null || r.t > until + 0.35) { cur = { start: Math.max(r.t, until), end: r.t, text: "", cut: false, audio: 0, source: (r.source as string) ?? "model" }; out.push(cur); until = r.t; }
      until = Math.max(until, r.t) + (r.dur as number);
      cur.end = until;
      cur.audio += r.dur as number;
    } else if (r.k === "flush") {
      if (cur != null && r.t < until) { cur.end = r.t; cur.cut = true; }
      until = Math.min(until, r.t);
      cur = null;
    }
  }
  // Each transcript fragment belongs to the segment being generated when it came.
  for (const r of log) {
    if (r.k !== "tx" || r.role !== "assistant") continue;
    let best: Segment | null = null;
    for (const s of out) if (s.start <= r.t + 0.6) best = s; else break;
    if (best) best.text += r.text as string;
  }
  return out.filter((s) => s.audio > 0.05);
}

function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

interface AgentExpect { facts?: string[] }

export function score(log: Rec[], scenario: Scenario): Metrics {
  const head = log.find((r) => r.k === "run");
  const utts = utterances(log);
  const segs = segments(log);
  const users = utts.filter((u) => !u.ambient);
  const ambient = utts.filter((u) => u.ambient);
  const callSeconds = log.length ? log[log.length - 1].t : 0;

  // Reply latency: the first sound after an utterance, before the next one starts. An utterance
  // handed to an agent before that sound was answered by the hand-off (its tone): the sound is a
  // result, not a reply, and its wait is the agent's.
  const replyLatency: number[] = [];
  users.forEach((u, i) => {
    const next = users[i + 1]?.start ?? Infinity;
    const first = log.find((r) => r.k === "play" && r.t >= u.end - 0.05 && r.t < next);
    const handedOff = first != null && log.some((r) => r.k === "agent.start" && r.t >= u.end - 0.05 && r.t < first.t);
    if (first && !handedOff && first.t - u.end < 10 && !segs.some((s) => s.start < u.end - 0.3 && s.end > u.end + 0.2)) replyLatency.push(+(first.t - u.end).toFixed(2));
  });

  // Turn collisions: the user waited for a quiet line (the script's "turn"), and the model started as they did.
  let turnCollisions = 0;
  for (const u of users) {
    if (segs.some((s) => s.start >= u.start - 0.25 && s.start < u.end - 0.2)) turnCollisions++;
  }
  let overlapSeconds = 0;
  for (const u of users) for (const s of segs) overlapSeconds += overlap(u.start, u.end, s.start, s.end);

  // Announcements: each scripted result with facts must be said, once.
  const starts = log.filter((r) => r.k === "agent.start");
  const results = log.filter((r) => r.k === "agent.result" && r.text != null);
  const expectOf = (id: string): AgentExpect | null => {
    for (const a of scenario.agents ?? []) {
      if (a.id === id) return a as AgentExpect;
      for (const f of a.followUps ?? []) if ((f as { id?: string }).id === id) return f as AgentExpect;
    }
    return null;
  };
  const announcements: Announcement[] = [];
  // From the end of the scenario's `retold` utterance ("what did I miss?") the user has asked to hear results again:
  // saying one there voices it if nothing did before, and is not a repeat.
  const retold = (scenario as { retold?: string }).retold;
  const retoldAt = retold ? utts.find((u) => u.id === retold)?.end ?? Infinity : Infinity;
  for (const r of results) {
    const facts = expectOf(r.id as string)?.facts;
    if (!facts || facts.length === 0) continue;
    const res = facts.map((f) => new RegExp(f, "i"));
    const after = segs.filter((s) => s.end > r.t);
    // A cut segment only counts if most of it played.
    const all = after.filter((s) => res.every((re) => re.test(s.text)) && (!s.cut || (s.end - s.start) / Math.max(0.1, s.audio) > 0.7));
    const before = all.filter((s) => s.start < retoldAt - 0.3);
    const said = before.length > 0 ? before : all.slice(0, 1);
    const firstFact = res[0];
    const aborted = after.filter((s) => s.cut && !said.includes(s) && (firstFact.test(s.text) || /^\s*(by the way|also|oh,|quick update|update)/i.test(s.text)) && (said.length === 0 || s.start < said[0].start)).length;
    announcements.push({
      agent: r.id as string, at: r.t,
      voicedAt: said[0]?.start ?? null,
      delay: said[0] ? +(Math.max(0, said[0].start - r.t)).toFixed(2) : null,
      times: said.length, aborted,
    });
  }
  const lostResults = announcements.filter((a) => a.times === 0).length;
  const repeatedResults = announcements.reduce((n, a) => n + Math.max(0, a.times - 1), 0);
  const abortedAnnouncements = announcements.reduce((n, a) => n + a.aborted, 0);

  const unscriptedDispatches = starts.filter((r) => r.scripted === false).length;

  // Ambient: only ambient speech audible (plus a tail for the model's reaction time).
  let ambientSpeechSeconds = 0, ambientToolCalls = 0;
  for (const a of ambient) {
    const from = a.start + 0.5, to = a.end + 3;
    const clear = !users.some((u) => overlap(u.start, u.end + 4, from, to) > 0);
    if (!clear) continue;
    for (const s of segs) if (s.start >= from && s.start < to) ambientSpeechSeconds += s.end - s.start;
    ambientToolCalls += log.filter((r) => r.k === "model" && r.what === "toolCall" && r.t >= from && r.t < to).length;
  }

  // Request recall and dispatch latency: each scripted new request against the utterance before it.
  const requestRecall: number[] = [], dispatchLatency: number[] = [];
  for (const s of starts) {
    if (s.scripted === false) continue;
    const u = [...users].reverse().find((x) => x.end <= s.t + 0.5 || x.start < s.t);
    if (!u) continue;
    const saidWords = words(u.text);
    const got = new Set(words(String(s.request ?? "")));
    if (saidWords.length > 0) requestRecall.push(+(saidWords.filter((w) => got.has(w)).length / saidWords.length).toFixed(2));
    if (s.t >= u.end) dispatchLatency.push(+(s.t - u.end).toFixed(2));
  }

  let connectedSeconds = 0, open: number | null = null, standbySeconds = 0, standbyFrom: number | null = null;
  for (const r of log) {
    if (r.k === "ws.connect" && open == null) open = r.t;
    if (r.k === "ws.close" && open != null) { connectedSeconds += r.t - open; open = null; }
    if (r.k === "status") {
      if (r.status === "standby" && standbyFrom == null) standbyFrom = r.t;
      else if (r.status !== "standby" && standbyFrom != null) { standbySeconds += r.t - standbyFrom; standbyFrom = null; }
    }
  }
  if (open != null) connectedSeconds += callSeconds - open;

  const checks = (scenario.checks ?? []).map((c) => check(c as Record<string, any>, log, utts, segs, announcements));
  const timeouts = log.filter((r) => r.k === "timeout").map((r) => `${r.waiting} (${r.step})`);

  const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
  const penalties: Record<string, number> = {
    lostResults: 25 * lostResults,
    repeatedResults: 10 * repeatedResults,
    turnCollisions: 10 * turnCollisions,
    unscriptedDispatches: 15 * unscriptedDispatches,
    ambient: 10 * Math.ceil(ambientSpeechSeconds > 0.3 ? Math.max(1, ambientSpeechSeconds / 5) : 0) + 15 * ambientToolCalls,
    failedChecks: 15 * checks.filter((c) => !c.pass).length,
    slowReplies: Math.round(10 * Math.max(0, median(replyLatency) - 1.2)),
    lateAnnouncements: 5 * announcements.filter((a) => a.delay != null && a.delay > 30).length,
    timeouts: 5 * timeouts.length,
  };
  const total = Object.values(penalties).reduce((a, b) => a + b, 0);

  return {
    scenario: scenario.name,
    core: String(head?.core ?? "?"),
    callSeconds: +callSeconds.toFixed(1),
    replyLatency, dispatchLatency, turnCollisions,
    overlapSeconds: +overlapSeconds.toFixed(2),
    announcements, lostResults, repeatedResults, abortedAnnouncements, unscriptedDispatches,
    ambientSpeechSeconds: +ambientSpeechSeconds.toFixed(2), ambientToolCalls,
    requestRecall,
    modelWords: segs.reduce((n, s) => n + words(s.text).length, 0),
    modelSpeechSeconds: +segs.reduce((n, s) => n + (s.end - s.start), 0).toFixed(1),
    userSpeechSeconds: +users.reduce((n, u) => n + (u.end - u.start), 0).toFixed(1),
    connectedSeconds: +connectedSeconds.toFixed(1),
    standbySeconds: +standbySeconds.toFixed(1),
    checks, timeouts, penalties,
    score: Math.max(0, 100 - total),
  };
}

/**
 * A scripted check. `after` and `before` name user utterances by id (from the end of one to the
 * start of the other); without them the whole call counts.
 *   {said: "regex"} / {notSaid: "regex"}    the model's words in the window
 *   {dispatch: "id", count: 1, within: 4}   new tasks started for that agent script (each within so many seconds of the request)
 *   {followUp: "id", match: "regex"}        a follow-up or steer reached that task, with these words
 *   {steer: "id", match: "regex"}           a steer into the running task
 *   {cancel: "id"}                          that task's run was cancelled
 *   {notCancelled: "id"}
 *   {request: "id", contains: ["word"], lacks: ["word"]}   the agent got these words, and not those
 *   {status: "standby"}                     the call reached this status
 *   {voiced: "id", within: 20}              the result was said, within so many seconds
 *   {maxModelWords: 40, after, before}      the model's words in the window, at most
 *   {noSpeech: true, after, before}         the model said nothing in the window
 *   {yields: "utteranceId", within: 1}      the model's sound stopped within so many seconds of the user cutting in
 *   {connected: "id", max: 40}              seconds on a model socket while that task ran, at most
 * `after` and `before` may also be "start:<utterance>", "result:<agent>", "dispatch:<agent>" or "mark:<name>".
 */
function check(c: Record<string, any>, log: Rec[], utts: Utterance[], segs: Segment[], anns: Announcement[]): CheckResult {
  // An utterance id, or "start:<utterance>", "result:<agent>", "dispatch:<agent>", "mark:<name>".
  const edge = (name: string, side: "after" | "before"): number => {
    const m = /^(start|result|dispatch|mark):(.+)$/.exec(name);
    if (!m) { const u = utts.find((x) => x.id === name); return u ? (side === "after" ? u.end : u.start) : Infinity; }
    const [, kind, arg] = m;
    if (kind === "start") return utts.find((u) => u.id === arg)?.start ?? Infinity;
    const k = kind === "result" ? "agent.result" : kind === "dispatch" ? "agent.start" : "mark";
    return log.find((r) => r.k === k && (kind === "mark" ? r.name === arg : r.id === arg))?.t ?? Infinity;
  };
  const from = c.after ? edge(c.after, "after") : -Infinity;
  const to = c.before ? edge(c.before, "before") : Infinity;
  const within = segs.filter((s) => s.start >= from - 0.3 && s.start < to);
  const text = within.map((s) => s.text).join(" ");
  const starts = log.filter((r) => r.k === "agent.start" && r.t >= from && r.t < to);
  const steers = log.filter((r) => r.k === "agent.steer" && r.t >= from && r.t < to);
  const res = (pass: boolean, why: string): CheckResult => ({ check: c, pass, why });
  if (Array.isArray(c.anyOf)) {
    // Passes when any of its checks does (each with its own window).
    const rs = (c.anyOf as Record<string, any>[]).map((x) => check(x, log, utts, segs, anns));
    return res(rs.some((r) => r.pass), rs.map((r) => `${r.pass ? "pass" : "fail"}: ${r.why}`).join(" | "));
  }
  if (c.said != null) return res(new RegExp(c.said, "i").test(text), `the model said: ${text.slice(0, 200)}`);
  if (c.notSaid != null) return res(!new RegExp(c.notSaid, "i").test(text), `the model said: ${text.slice(0, 200)}`);
  if (c.dispatch != null) {
    const got = starts.filter((r) => r.id === c.dispatch && !r.followUp);
    const n = got.length;
    if (c.within == null || n !== (c.count ?? 1)) return res(n === (c.count ?? 1), `${n} task(s) started for ${c.dispatch}`);
    // With `within`: each started that soon after the end of the user's utterance before it.
    const late = got.map((r) => { const u = [...utts].reverse().find((x) => !x.ambient && x.start < r.t); return u ? r.t - u.end : Infinity; });
    return res(late.every((d) => d <= c.within), `${n} task(s) started for ${c.dispatch}, ${late.map((d) => d.toFixed(1)).join(", ")} s after the request`);
  }
  if (c.followUp != null) {
    const re = new RegExp(c.match ?? ".", "i");
    const hit = [...starts.filter((r) => r.followUp), ...steers].filter((r) => (r.id === c.followUp || taskOf(log, r) === c.followUp) && re.test(String(r.request ?? r.text ?? "")));
    return res(hit.length > 0, `${hit.length} follow-up(s) reached ${c.followUp}`);
  }
  if (c.steer != null) {
    const re = new RegExp(c.match ?? ".", "i");
    const hit = steers.filter((r) => r.id === c.steer && re.test(String(r.text ?? "")));
    return res(hit.length > 0, `${hit.length} steer(s) reached ${c.steer}`);
  }
  if (c.cancel != null) return res(log.some((r) => r.k === "agent.cancel" && r.id === c.cancel && r.reason === "cancelled"), `cancel of ${c.cancel}`);
  if (c.notCancelled != null) return res(!log.some((r) => r.k === "agent.cancel" && r.id === c.notCancelled && r.reason === "cancelled"), `${c.notCancelled} kept running`);
  if (c.request != null) {
    const got = starts.filter((r) => r.id === c.request).map((r) => String(r.request)).join(" ");
    const missing = (c.contains as string[] ?? []).filter((w) => !new RegExp(w, "i").test(got));
    const extra = (c.lacks as string[] ?? []).filter((w) => new RegExp(w, "i").test(got));
    // With project, every task started for it got that project.
    const projects = starts.filter((r) => r.id === c.request).map((r) => String(r.project ?? ""));
    const wrongProject = c.project != null && !projects.every((p) => p.toLowerCase() === String(c.project).toLowerCase());
    const why = [missing.length ? `missing: ${missing.join(", ")}` : "", extra.length ? `should lack: ${extra.join(", ")}` : "", wrongProject ? `project ${projects.join(", ") || "none"}` : ""].filter(Boolean).join("; ");
    return res(got.length > 0 && missing.length === 0 && extra.length === 0 && !wrongProject, why ? `${why} in "${got.slice(0, 160)}"` : "all there");
  }
  if (c.yields != null) {
    // The model's sound playing when the user cut in (at the wake word, if the utterance has one) stops within so many seconds.
    const u = utts.find((x) => x.id === c.yields);
    if (!u) return res(false, `no utterance ${c.yields}`);
    const at = (log.find((r) => r.k === "wake" && r.id === c.yields)?.t as number | undefined) ?? u.start;
    let stop: number | null = null;
    for (const s of segs) {
      if (stop == null && s.start <= at && s.end >= at - 0.05) stop = s.end;
      else if (stop != null && s.start < stop + 0.5 && s.start < u.end) stop = Math.max(stop, s.end);
    }
    if (stop == null) return res(false, "the model wasn't speaking when the user cut in");
    return res(stop - at <= (c.within ?? 1), `stopped ${(stop - at).toFixed(2)} s after the user cut in`);
  }
  if (c.connected != null) {
    // Seconds on a model socket while that agent's first task ran (its start to its result, or the end of the call).
    const start = log.find((r) => r.k === "agent.start" && r.id === c.connected && !r.followUp);
    if (!start) return res(false, `no task for ${c.connected}`);
    const end = (log.find((r) => r.k === "agent.result" && r.run === start.run)?.t as number | undefined) ?? log[log.length - 1].t;
    let secs = 0, open: number | null = null;
    for (const r of log) {
      if (r.k === "ws.connect" && open == null) open = r.t;
      if (r.k === "ws.close" && open != null) { secs += overlap(open, r.t, start.t, end); open = null; }
    }
    if (open != null) secs += overlap(open, log[log.length - 1].t, start.t, end);
    return res(secs <= c.max, `connected ${secs.toFixed(1)} s of the task's ${(end - start.t).toFixed(1)} s`);
  }
  if (c.status != null) return res(log.some((r) => r.k === "status" && r.status === c.status), `status ${c.status}`);
  if (c.voiced != null) {
    const a = anns.filter((x) => x.agent === c.voiced);
    const ok = a.length > 0 && a.every((x) => x.times >= 1 && (c.within == null || (x.delay ?? Infinity) <= c.within));
    return res(ok, a.map((x) => `said ${x.times}x, delay ${x.delay}`).join("; ") || "no such result");
  }
  if (c.maxModelWords != null) { const n = words(text).length; return res(n <= c.maxModelWords, `${n} words`); }
  if (c.noSpeech != null) return res(within.length === 0, `${within.length} segment(s): ${text.slice(0, 120)}`);
  return res(false, "unknown check");
}

/** The agent script a follow-up's task belongs to (a follow-up is logged under its own id if it has one). */
function taskOf(log: Rec[], r: Rec): string | null {
  const first = log.find((x) => x.k === "agent.start" && x.taskId === r.taskId && !x.followUp);
  return (first?.id as string) ?? null;
}

/** The call as a person would read it: one line per utterance, reply, hand-off and result. */
export function readable(log: Rec[]): string {
  const lines: [number, string][] = [];
  for (const u of utterances(log)) lines.push([u.start, `${u.ambient ? "AMBIENT" : "USER"} [${u.start.toFixed(1)}-${u.end.toFixed(1)}] ${u.text}`]);
  for (const s of segments(log)) lines.push([s.start, `${s.source === "model" ? "ASSISTANT" : "ASSISTANT(" + s.source + ")"} [${s.start.toFixed(1)}-${s.end.toFixed(1)}${s.cut ? ", cut off" : ""}] ${s.text.trim()}`]);
  for (const r of log) {
    if (r.k === "agent.start") lines.push([r.t, `  -> ${r.agent} ${r.followUp ? "follow-up" : "task"} "${r.label}" (${r.id}): ${r.request}`]);
    if (r.k === "agent.progress") lines.push([r.t, `  .. ${r.id}: ${r.text}`]);
    if (r.k === "agent.result") lines.push([r.t, `  <- ${r.id} result: ${r.error ? "FAILED " + r.error : r.text}`]);
    if (r.k === "agent.steer") lines.push([r.t, `  -> steer ${r.id}: ${r.text}`]);
    if (r.k === "agent.cancel") lines.push([r.t, `  xx ${r.id} ${r.reason}`]);
    if (r.k === "cue") lines.push([r.t, `  (tone: ${r.earcon})`]);
    if (r.k === "status") lines.push([r.t, `  [${r.status}${r.message ? ": " + r.message : ""}]`]);
    if (r.k === "voiceCommand") lines.push([r.t, `  (voice command ${r.command})`]);
    if (r.k === "model" && r.what === "toolCall" && !["ask_hermes", "ask_coding_agent"].includes(r.name as string)) lines.push([r.t, `  (model calls ${r.name} ${JSON.stringify(r.args)})`]);
    if (r.k === "event") lines.push([r.t, `  (host event ${JSON.stringify(r.event)})`]);
    if (r.k === "wake") lines.push([r.t, "  (wake word heard)"]);
    if (r.k === "timeout") lines.push([r.t, `  !! script timed out waiting for ${r.waiting}`]);
  }
  lines.sort((a, b) => a[0] - b[0]);
  return lines.map(([t, l]) => `${t.toFixed(1).padStart(6)}  ${l}`).join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const dir of process.argv.slice(2)) {
    if (!existsSync(join(dir, "log.jsonl"))) continue;
    const { log, scenario } = loadRun(dir);
    console.log(readable(log));
    const m = score(log, scenario);
    const { checks, ...rest } = m;
    console.log(JSON.stringify(rest, null, 1));
    for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"} ${JSON.stringify(c.check)}: ${c.why}`);
  }
}
