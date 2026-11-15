// Reads a call trace (the JSONL the dev server keeps, or a recording JSON) and replays it through
// the built core to get a timeline of what was said, asked, started, delivered and played, with
// times in seconds from the start of the call. `node eval/timeline.ts trace.jsonl` prints it.

import { readFileSync } from "node:fs";
import { engine } from "../test/replay.ts";

export interface Row { t: number; kind: string; text: string; data?: unknown }

export interface Trace { version?: string; config: Record<string, unknown>; start: number; events: Array<Record<string, unknown>> }

export function load(path: string): Trace {
  const raw = readFileSync(path, "utf8");
  if (path.endsWith(".jsonl")) {
    const lines = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const head = lines[0];
    return { version: head.version, config: head.config, start: head.start, events: lines.slice(1) };
  }
  return JSON.parse(raw);
}

const PLAY_RATE = 24000 * 2;
const MIC_RATE = 16000 * 2;

function b64len(s: string): number {
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return Math.floor((s.length * 3) / 4) - pad;
}

function rms(b64: string): number {
  const buf = Buffer.from(b64, "base64");
  let sum = 0;
  const n = buf.length >> 1;
  for (let i = 0; i < n; i++) { const v = buf.readInt16LE(i * 2) / 32768; sum += v * v; }
  return n ? Math.sqrt(sum / n) : 0;
}

/** Every event and command of the call as rows; transcripts are merged per turn. */
export function timeline(trace: Trace, source?: string): Row[] {
  const core = engine(source);
  const rows: Row[] = [];
  const t0 = trace.start;
  const created = JSON.parse(core.create(JSON.stringify(trace.config), trace.start));
  const id = created.id as number;
  let playEnd = 0;
  let micLoud: number | null = null;
  let micQuietAt = 0;
  const add = (t: number, kind: string, text: string, data?: unknown) => rows.push({ t: +(t - t0).toFixed(3), kind, text, data });

  const commands = (t: number, list: Array<Record<string, any>>) => {
    for (const c of list) {
      switch (c.type) {
        case "play": {
          const dur = b64len(c.pcm) / PLAY_RATE;
          const from = Math.max(t, playEnd);
          if (from - playEnd > 0.25 || playEnd === 0) add(from, "play.start", "");
          playEnd = from + dur;
          rows.push({ t: +(playEnd - t0).toFixed(3), kind: "play.until", text: "" });
          break;
        }
        case "flush": if (playEnd > t) { add(t, "flush", `cut ${(playEnd - t).toFixed(2)}s of speech`); playEnd = t; } else add(t, "flush", ""); break;
        case "cue": add(t, "cue", c.earcon); break;
        case "transcript": add(t, c.role === "user" ? "USER" : "MODEL", c.text); break;
        case "status": add(t, "status", c.status + (c.message ? `: ${c.message}` : "")); break;
        case "tool.call": add(t, "tool.call", c.kind === "host" ? `${c.name} ${JSON.stringify(c.args)}` : `${c.agent} [${c.label}]${c.followUp ? " follow-up" : ""} run=${c.run}: ${c.request}`, c); break;
        case "tool.steer": add(t, "tool.steer", `run=${c.run}: ${c.text}`, c); break;
        case "tool.cancel": add(t, "tool.cancel", `run=${c.run} ${c.reason}`, c); break;
        case "task": add(t, "task", `[${c.label}] ${c.state}${c.question ? " asks: " + c.question : ""}`, c); break;
        case "voiceCommand": add(t, "voiceCommand", `${c.command}: ${c.heard}`); break;
        case "log": add(t, "log", `${c.level}: ${c.message}`); break;
        case "ws.connect": add(t, "ws.connect", `sid=${c.sid}`); break;
        case "ws.close": add(t, "ws.close", `sid=${c.sid}`); break;
        case "ws.send": {
          let m: any;
          try { m = JSON.parse(c.data); } catch { break; }
          if (m.realtimeInput) break;
          if (m.setup) { add(t, "send.setup", `resume=${m.setup.sessionResumption?.handle ? "handle" : "no"}`, m); break; }
          if (m.toolResponse) { for (const r of m.toolResponse.functionResponses ?? []) add(t, "send.toolResponse", `${r.name} ${JSON.stringify(r.response).slice(0, 400)}${r.scheduling ? " sched=" + r.scheduling : ""}`, r); break; }
          if (m.clientContent) { const text = (m.clientContent.turns ?? []).map((x: any) => (x.parts ?? []).map((p: any) => p.text).join("")).join(" | "); add(t, "send.turn", `${m.clientContent.turnComplete ? "complete" : "context"}: ${text.slice(0, 600)}`, m); break; }
          add(t, "send.other", JSON.stringify(m).slice(0, 200));
          break;
        }
      }
    }
  };
  commands(trace.start, created.commands);

  for (const e of trace.events) {
    const t = e.t as number;
    const type = e.type as string;
    if (type === "mic" || (type === undefined && typeof e.pcm === "string")) {
      // Microphone energy, so speech the model never transcribed still shows.
      const level = rms(e.pcm as string);
      if (level > 0.02) { if (micLoud === null) { micLoud = t; add(t, "mic.loud", ""); } micQuietAt = t; }
      else if (micLoud !== null && t - micQuietAt > 0.7) { add(micQuietAt, "mic.quiet", `${(micQuietAt - micLoud).toFixed(1)}s`); micLoud = null; }
    } else if (type === "ws.message") {
      let m: any;
      try { m = JSON.parse(e.data as string); } catch { m = null; }
      if (m?.toolCall) for (const f of m.toolCall.functionCalls ?? []) add(t, "model.toolCall", `${f.name} ${JSON.stringify(f.args ?? {})}`, f);
      if (m?.serverContent?.interrupted) add(t, "model.interrupted", "");
      if (m?.serverContent?.turnComplete) add(t, "model.turnComplete", "");
      if (m?.goAway) add(t, "model.goAway", "");
      if (m?.toolCallCancellation) add(t, "model.toolCancel", JSON.stringify(m.toolCallCancellation.ids));
    } else if (type !== "tick") {
      const { t: _t, type: _y, ...rest } = e;
      add(t, "ev." + type, JSON.stringify(rest).slice(0, 500), e);
    }
    commands(t, JSON.parse(core.push(id, JSON.stringify(e))));
  }
  rows.sort((a, b) => a.t - b.t);
  return merge(rows);
}

/** Transcript fragments of one speaker with nothing between them become one row; play spans collapse. */
function merge(rows: Row[]): Row[] {
  const out: Row[] = [];
  let lastUntil: Row | null = null;
  for (const r of rows) {
    if (r.kind === "play.until") { lastUntil = r; continue; }
    if (r.kind === "play.start" && lastUntil && r.t - lastUntil.t < 0.25) continue;
    if (lastUntil && r.kind !== "play.start" && r.t >= lastUntil.t) { out.push({ t: lastUntil.t, kind: "play.end", text: "" }); lastUntil = null; }
    const prev = out[out.length - 1];
    if (prev && (r.kind === "USER" || r.kind === "MODEL") && prev.kind === r.kind) { prev.text += r.text; (prev.data as any).until = r.t; continue; }
    if (r.kind === "USER" || r.kind === "MODEL") r.data = { until: r.t };
    out.push(r);
  }
  if (lastUntil) out.push({ t: lastUntil.t, kind: "play.end", text: "" });
  return out;
}

export function print(rows: Row[], hide = new Set(["task", "play.start", "play.end", "mic.loud", "mic.quiet"])): string {
  return rows.filter((r) => !hide.has(r.kind)).map((r) => `${r.t.toFixed(1).padStart(7)}  ${r.kind.padEnd(17)} ${r.text}`).join("\n");
}

if (process.argv[1]?.endsWith("timeline.ts")) {
  const all = process.argv.includes("--all");
  for (const path of process.argv.slice(2).filter((a) => !a.startsWith("--"))) {
    console.log(`== ${path}`);
    console.log(print(timeline(load(path)), all ? new Set() : undefined));
  }
}
