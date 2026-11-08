// A host for tests: a virtual clock, a fake Gemini on every socket the call opens, a microphone
// giving 20 ms frames while it's on, and a record of every command. Nothing waits on real time,
// so a test of a minute's call runs in milliseconds.

import { Call } from "../src/call.ts";
import { configFrom } from "../src/index.ts";
import type { CallConfig, Command, Event } from "../src/types.ts";

/** An event as a test writes it: the simulator stamps the time. */
export type EventIn = Event extends infer E ? (E extends { t: number } ? Omit<E, "t"> : never) : never;

export type MicMode = "quiet" | "loud" | "dead" | "none";

const FRAME = 640; // 20 ms at 16 kHz, 16-bit

function frame(mode: MicMode, size = FRAME): string {
  const pcm = new Uint8Array(size);
  if (mode === "quiet") for (let i = 0; i < size; i += 2) pcm[i] = (i / 2) % 7; // room noise, never exact zeros
  if (mode === "loud") for (let i = 0; i < size; i += 2) { const s = (i / 2) % 2 === 0 ? 8000 : -8000; pcm[i] = s & 0xff; pcm[i + 1] = (s >> 8) & 0xff; }
  return Buffer.from(pcm).toString("base64");
}

export interface SimOptions {
  config?: Partial<CallConfig>;
  /** Fake Gemini answers each setup with setupComplete (default true). */
  autoSetup?: boolean;
  tick?: number;
  /** Microphone frames: every this many seconds, of this many bytes (20 ms of real audio by default). */
  micEvery?: number;
  micBytes?: number;
}

export class Sim {
  readonly call: Call;
  readonly config: CallConfig;
  t = 0;
  readonly commands: Command[] = [];
  readonly events: Event[] = [];
  /** Sockets as the host holds them: sid → frames sent on it. */
  readonly sockets = new Map<number, { sent: string[]; open: boolean; closed: boolean }>();
  /** The socket fake Gemini speaks on: the latest one opened. */
  sid = 0;
  micOn = false;
  mic: MicMode = "quiet";
  autoSetup: boolean;
  private readonly tickEvery: number;
  private readonly micEvery: number;
  private readonly micBytes: number;
  private nextTick = 0;
  private nextFrame = 0;

  constructor(o: SimOptions = {}) {
    this.autoSetup = o.autoSetup ?? true;
    this.tickEvery = o.tick ?? 0.05;
    this.micEvery = o.micEvery ?? 0.02;
    this.micBytes = o.micBytes ?? FRAME;
    this.config = configFrom({ today: "2026-11-08", ...(o.config ?? {}) } as Partial<CallConfig> & Record<string, unknown>);
    this.call = new Call(this.config);
    this.take(this.call.start(0));
  }

  /** Pushes [e] at the current time; returns its commands. */
  push(e: EventIn): Command[] {
    const event = { ...e, t: this.t } as Event;
    this.events.push(event);
    return this.take(this.call.push(event));
  }

  private take(out: Command[]): Command[] {
    for (const c of out) {
      this.commands.push(c);
      switch (c.type) {
        case "ws.connect":
          this.sockets.set(c.sid, { sent: [], open: false, closed: false });
          this.later.push(() => {
            const s = this.sockets.get(c.sid)!;
            if (s.closed) return;
            s.open = true;
            this.sid = c.sid;
            this.push({ type: "ws.open", sid: c.sid });
          });
          break;
        case "ws.send": {
          const s = this.sockets.get(c.sid)!;
          s.sent.push(c.data);
          if (this.autoSetup && c.data.startsWith('{"setup"')) this.later.push(() => this.gemini({ setupComplete: {} }, c.sid));
          break;
        }
        case "ws.close": this.sockets.get(c.sid)!.closed = true; break;
        case "mic.start": this.micOn = true; this.nextFrame = this.t; break;
        case "mic.stop": this.micOn = false; break;
      }
    }
    return out;
  }

  /** Socket opens and fake Gemini's setupComplete, run as time moves on. */
  private later: (() => void)[] = [];

  private flushLater(): void {
    while (this.later.length > 0) this.later.shift()!();
  }

  /** Moves the clock on by [seconds]: microphone frames every 20 ms, ticks, and whatever the host owed. */
  advance(seconds: number): void {
    const end = this.t + seconds;
    this.flushLater();
    for (;;) {
      const nextMic = this.micOn && this.mic !== "none" ? this.nextFrame : Infinity;
      const next = Math.min(this.nextTick, nextMic);
      if (next > end + 1e-9) break;
      this.t = Math.max(this.t, next);
      if (next === this.nextTick) {
        this.nextTick = Math.round((this.nextTick + this.tickEvery) * 1e6) / 1e6;
        this.push({ type: "tick" });
      } else {
        this.nextFrame = Math.round((this.nextFrame + this.micEvery) * 1e6) / 1e6;
        this.push({ type: "mic", pcm: frame(this.mic, this.micBytes) });
      }
      this.flushLater();
    }
    this.t = end;
  }

  /** A frame from fake Gemini on the latest socket (or [sid]). */
  gemini(frameObj: unknown, sid = this.sid): Command[] {
    return this.push({ type: "ws.message", sid, data: typeof frameObj === "string" ? frameObj : JSON.stringify(frameObj) });
  }

  // Gemini's frames, as Android's tests write them.
  activity(type: "ACTIVITY_START" | "ACTIVITY_END") { return this.gemini({ voiceActivity: { type } }); }
  heard(text: string) { return this.gemini({ serverContent: { inputTranscription: { text } } }); }
  said(text: string) { return this.gemini({ serverContent: { outputTranscription: { text } } }); }
  toolCall(id: string, name = "ask_hermes", args: Record<string, unknown> = {}) {
    return this.gemini({ toolCall: { functionCalls: [{ id, name, args }] } });
  }
  /** One user turn: the words, inside its voice activity. */
  turn(words: string) { this.activity("ACTIVITY_START"); this.heard(words); this.activity("ACTIVITY_END"); }
  audio(bytes: number, mime = "audio/pcm;rate=24000") {
    return this.gemini({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: mime, data: Buffer.alloc(bytes).toString("base64") } }] } } });
  }
  interrupted() { return this.gemini({ serverContent: { interrupted: true } }); }
  generated() { return this.gemini({ serverContent: { generationComplete: true } }); }
  turnComplete() { return this.gemini({ serverContent: { turnComplete: true } }); }
  speaks(words: string) { this.said(words); this.generated(); this.turnComplete(); }
  resumable(handle: string) { return this.gemini({ sessionResumptionUpdate: { newHandle: handle, resumable: true } }); }

  // What the call did.

  sent(sid?: number): string[] {
    if (sid != null) return this.sockets.get(sid)?.sent ?? [];
    return [...this.sockets.values()].flatMap((s) => s.sent);
  }
  responses(): any[] {
    return this.sent().filter((s) => s.includes('"toolResponse"')).map((s) => JSON.parse(s).toolResponse.functionResponses[0]);
  }
  /** Responses but the "started" ones ask_hermes sends before Hermes's result. */
  finals(): any[] { return this.responses().filter((r) => r.response.status !== "started"); }
  turns(): any[] { return this.sent().filter((s) => s.includes('"clientContent"')).map((s) => JSON.parse(s).clientContent); }
  resultTurns(): any[] { return this.turns().filter((c) => c.turnComplete === true); }
  toolCalls(): Extract<Command, { type: "tool.call" }>[] {
    return this.commands.filter((c): c is Extract<Command, { type: "tool.call" }> => c.type === "tool.call");
  }
  hermes(): Extract<Command, { type: "tool.call"; kind: "hermes" }>[] {
    return this.toolCalls().filter((c): c is Extract<Command, { type: "tool.call"; kind: "hermes" }> => c.kind === "hermes");
  }
  cues(): string[] { return this.commands.flatMap((c) => (c.type === "cue" ? [c.earcon] : [])); }
  statuses(): string[] { return this.commands.flatMap((c) => (c.type === "status" ? [c.status] : [])); }
  ended(): Extract<Command, { type: "status" }> | undefined {
    return this.commands.find((c): c is Extract<Command, { type: "status" }> => c.type === "status" && c.status === "ended");
  }
  /** Hermes answers the latest run (or [run]). */
  complete(text: string, run?: string) {
    const r = run ?? this.hermes().at(-1)!.run;
    return this.push({ type: "tool.result", run: r, text });
  }
}

export function turnText(c: any): string {
  return c.turns[0].parts[0].text;
}
