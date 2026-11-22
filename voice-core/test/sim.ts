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
  /** What the fake transcription model answers each captions socket's setup with (setupComplete by default). */
  captioner?: unknown[];
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
  /** The captions sockets the call opened, in order, and what the fake transcription model answers a setup with. */
  readonly captionSids: number[] = [];
  captioner: unknown[];
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
    this.captioner = o.captioner ?? [{ setupComplete: {} }];
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
          if (c.purpose === "captions") this.captionSids.push(c.sid);
          this.later.push(() => {
            const s = this.sockets.get(c.sid)!;
            if (s.closed) return;
            s.open = true;
            if (c.purpose !== "captions") this.sid = c.sid;
            this.push({ type: "ws.open", sid: c.sid });
          });
          break;
        case "ws.send": {
          const s = this.sockets.get(c.sid)!;
          s.sent.push(c.data);
          if (!c.data.startsWith('{"setup"')) break;
          if (this.captionSids.includes(c.sid)) {
            const answer = [...this.captioner];
            this.later.push(() => { for (const frame of answer) if (!s.closed) this.gemini(frame, c.sid); });
          } else if (this.autoSetup) this.later.push(() => this.gemini({ setupComplete: {} }, c.sid));
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

  // A typed chat (config medium "text"): the user's messages, and the text model's answers to the chat's requests.

  /** The user types [text]. */
  type(text: string) { return this.push({ type: "say", text }); }
  /** The chat's requests to its text model, in order, each with its body parsed. */
  requests(): { id: number; model: string; body: any }[] {
    return this.commands.flatMap((c) => (c.type === "llm.request" ? [{ id: c.id, model: c.model, body: JSON.parse(c.body) }] : []));
  }
  /** The text model answers the latest request (or [id]) with [parts], in one response, and the request ends. */
  answer(parts: unknown[], id = this.requests().at(-1)!.id): void {
    this.push({ type: "llm.data", id, data: JSON.stringify({ candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }] }) });
    this.push({ type: "llm.end", id });
  }
  /** The text model writes [text] as its whole answer. */
  writes(text: string, id?: number) { this.answer([{ text }], id); }
  /** The text model calls [name]. */
  calls(name = "ask_hermes", args: Record<string, unknown> = {}, id?: number) {
    this.answer([{ functionCall: { name, args, id: `call_${name}_${this.requests().length}` }, thoughtSignature: "sig" }], id);
  }
  /** What the model was sent with its latest request: each turn's role and its text or function parts. */
  sentTurns(): any[] { return this.requests().at(-1)!.body.contents; }
  /** The lines of the transcript, fragments of a line joined. */
  lines(): { role: string; text: string }[] {
    const out: { role: string; text: string; line: number }[] = [];
    for (const c of this.commands) {
      if (c.type !== "transcript") continue;
      const last = out.at(-1);
      if (last && last.line === c.line && last.role === c.role) last.text += c.text; else out.push({ role: c.role, text: c.text, line: c.line });
    }
    return out.map(({ role, text }) => ({ role, text }));
  }

  // The transcription model's frames, on the latest captions socket.
  get captionSid(): number { return this.captionSids.at(-1) ?? 0; }
  utterance(type: "ACTIVITY_START" | "ACTIVITY_END", audioOffset?: string) {
    return this.gemini({ voiceActivity: audioOffset == null ? { type } : { type, audioOffset } }, this.captionSid);
  }
  guess(text: string) { return this.gemini({ serverContent: { interimInputTranscription: { text } } }, this.captionSid); }
  /** The captions the call showed, in order (null: taken down). */
  captions(): (string | null)[] { return this.commands.flatMap((c) => (c.type === "caption" ? [c.text] : [])); }

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
