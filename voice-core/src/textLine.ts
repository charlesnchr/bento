// The model's side of a typed chat (CallConfig.medium "text"): a text model reached by request and
// response, made to look like the Live socket the call was written for.
//
// The call sends it the frames it would send Gemini Live (its setup, user turns, notes, function
// responses) and gets back the frames Live would send (the model's words, function calls, the end
// of its turn), so everything the call decides about tasks is the same code by voice and by text.
// Underneath, each of the model's turns is one or more `generateContent` requests the host makes
// (`llm.request`, answered with `llm.data` and `llm.end`): a turn that calls functions goes on in
// a second request once the call has answered them, unless every answer was silent (a hand-off the
// screen already shows), which ends the turn there.
//
// The conversation is kept here, as the API wants it back with every request: the model's parts
// go back as they came, since they carry the thought signatures its function calls are checked
// against. What the user types while a turn is under way waits for the turn to end.

import { fencedNote } from "./setup.ts";
import type { Command } from "./types.ts";

type Json = Record<string, unknown>;
type Part = Json;
interface Content { role: "user" | "model"; parts: Part[] }

export interface LineHost {
  emit(c: Command): void;
  /** A frame as Gemini Live would send it, for the call. */
  receive(frame: string): void;
  /** Runs once the event being handled has been, so frames sent together make one request. */
  defer(fn: () => void): void;
  now(): number;
  log(level: "info" | "warn", message: string): void;
}

export interface LineConfig {
  /** The model as the host's request names it. */
  model: string;
  /** The request's `generationConfig`. */
  generation: unknown;
  /** The most of the conversation sent with a request, in characters of JSON: the oldest turns go first. */
  historyChars: number;
}

/** Seconds the call has to answer the model's function calls before the turn goes on without the rest. */
const ANSWER_WAIT = 15;
/** Seconds without a byte from a request before it is given up. */
const REQUEST_WAIT = 90;
const TURN_END = '{"serverContent":{"generationComplete":true,"turnComplete":true}}';

function obj(v: unknown): Json | null {
  return v != null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function parse(data: string): Json | null {
  try { return obj(JSON.parse(data)); } catch { return null; }
}

interface Pending { key: string; name: string; given: string | null; answer: Part | null }

export class TextLine {
  private system = "";
  private tools: unknown[] = [];
  private readonly contents: Content[] = [];
  private nextId = 1;
  private nextCall = 1;
  /** The request under way: the parts it has brought so far, and when the last came. */
  private request: { id: number; parts: Part[]; lastAt: number; error: string | null } | null = null;
  /** The model's function calls of this turn, in its order, until the call has answered them all. */
  private calls: Pending[] = [];
  private callsAt = 0;
  /** An answer asked the model to go on (anything but a silent one). */
  private speak = false;
  /** User turns that came while the model's turn was under way. */
  private readonly held: { content: Content; complete: boolean; turn: { seq: number; turnId: number | null; text: string } | null }[] = [];
  /** Sequence, protocol turn id and text of the latest complete user turn accepted into `contents`. */
  private nextUserTurn = 0;
  private latestUserTurn: { seq: number; turnId: number | null; text: string } | null = null;
  /** A user turn waits for the model's answer. */
  private due = false;
  private turnOpen = false;
  private thinking = false;
  private stopped = false;
  /**
   * When the request the model is answering was made: a function call answers the user's latest
   * turn as of then, not one typed while the model was still writing.
   */
  asOf = 0;
  /** The exact complete user turn the current model turn is answering (immune to same-timestamp queuing). */
  answeredTurn: { seq: number; turnId: number | null; text: string } | null = null;
  private readonly host: LineHost;
  private readonly c: LineConfig;

  constructor(config: LineConfig, host: LineHost) {
    this.c = config;
    this.host = host;
  }

  /** The call's setup frame: its instruction and tools are every request's. */
  setup(frame: string): void {
    const setup = obj(parse(frame)?.setup);
    const parts = arr(obj(setup?.systemInstruction)?.parts);
    this.system = parts.map((p) => obj(p)?.text).filter((t): t is string => typeof t === "string").join("\n");
    const declarations = arr(obj(arr(setup?.tools)[0])?.functionDeclarations).map((d) => {
      // `behavior` is the Live API's: a request and response call always waits for its answer.
      const { behavior: _, ...rest } = obj(d) ?? {};
      return rest;
    });
    this.tools = declarations.length > 0 ? [{ functionDeclarations: declarations }] : [];
  }

  /** A frame the call would send Gemini Live. [recap]: the earlier conversation's own recap frame, which carries its own fence. */
  send(frame: string, recap = false, turnId: number | null = null): void {
    if (this.stopped) return;
    const f = parse(frame);
    if (!f) return;
    const content = obj(f.clientContent);
    if (content) {
      const turns = arr(content.turns);
      turns.forEach((turn, i) => {
        const text = arr(obj(turn)?.parts).map((p) => obj(p)?.text).filter((t): t is string => typeof t === "string").join("\n");
        if (text.length === 0) return;
        // A turn the model isn't to answer is a note of Bento's (a result, a cancellation): fenced, so the user's next message stands apart from it.
        const complete = content.turnComplete === true && i === turns.length - 1;
        const note = content.turnComplete !== true && !recap;
        const userTurn = complete ? { seq: ++this.nextUserTurn, turnId, text } : null;
        this.take({ role: "user", parts: [{ text: note ? fencedNote(text) : text }] }, complete, userTurn);
      });
      return;
    }
    for (const r of arr(obj(f.toolResponse)?.functionResponses)) this.answer(obj(r));
  }

  private get busy(): boolean {
    return this.request != null || this.calls.length > 0;
  }

  private take(content: Content, complete: boolean, turn: { seq: number; turnId: number | null; text: string } | null): void {
    if (this.busy) { this.held.push({ content, complete, turn }); return; }
    this.contents.push(content);
    if (complete) { this.due = true; if (turn) this.latestUserTurn = turn; }
    this.host.defer(() => this.go());
  }

  /** The call's answer to one of the model's function calls. */
  private answer(r: Json | null): void {
    const key = typeof r?.id === "string" ? r.id : null;
    const call = this.calls.find((c) => c.key === key && c.answer == null);
    if (!r || !call) return;
    const response: Json = { name: call.name, response: obj(r.response) ?? {} };
    if (call.given != null) response.id = call.given;
    call.answer = { functionResponse: response };
    if (r.scheduling !== "SILENT") this.speak = true;
    if (this.calls.every((c) => c.answer != null)) this.answered();
  }

  /** Every call of the turn has its answer: they go back together, and the model goes on if any asked it to. */
  private answered(): void {
    this.contents.push({ role: "user", parts: this.calls.map((c) => c.answer!) });
    this.calls = [];
    const speak = this.speak;
    this.speak = false;
    if (speak) this.due = true; else this.endTurn();
    this.host.defer(() => this.go());
  }

  /** Makes the next request if one is owed and none is under way. */
  private go(): void {
    if (this.stopped || this.busy) return;
    if (!this.due) {
      for (const h of this.held.splice(0)) {
        this.contents.push(h.content);
        if (h.complete) { this.due = true; if (h.turn) this.latestUserTurn = h.turn; }
      }
      if (!this.due) return;
    }
    this.due = false;
    this.trim();
    const id = this.nextId++;
    const now = this.host.now();
    this.request = { id, parts: [], lastAt: now, error: null };
    if (!this.turnOpen) { this.turnOpen = true; this.asOf = now; this.answeredTurn = this.latestUserTurn; }
    this.setThinking(true);
    const body: Json = { systemInstruction: { parts: [{ text: this.system }] }, contents: this.contents };
    if (this.tools.length > 0) body.tools = this.tools;
    if (this.c.generation != null) body.generationConfig = this.c.generation;
    this.host.emit({ type: "llm.request", id, model: this.c.model, body: JSON.stringify(body) });
  }

  /** One response of the request: all of it, or a chunk of its stream. */
  data(id: number, data: string): void {
    const r = this.request;
    if (!r || r.id !== id) return;
    r.lastAt = this.host.now();
    const response = parse(data);
    if (!response) return;
    const error = obj(response.error);
    if (error) { r.error = typeof error.message === "string" ? error.message : "the model refused the request"; return; }
    const blocked = obj(response.promptFeedback)?.blockReason;
    if (typeof blocked === "string") { r.error = `the request was blocked (${blocked})`; return; }
    const candidate = obj(arr(response.candidates)[0]);
    for (const p of arr(obj(candidate?.content)?.parts)) {
      const part = obj(p);
      if (!part) continue;
      r.parts.push(part);
      if (typeof part.text === "string" && part.text.length > 0 && part.thought !== true) {
        this.host.receive(JSON.stringify({ serverContent: { outputTranscription: { text: part.text } } }));
      }
    }
    const reason = candidate?.finishReason;
    if (typeof reason === "string" && reason !== "STOP" && reason !== "FINISH_REASON_UNSPECIFIED" && r.parts.length === 0) {
      r.error = `the model stopped without an answer (${reason})`;
    }
  }

  /** The request is over. [error] is why it failed, with its HTTP [status] if it had one. */
  end(id: number, error: string | null, status: number | null): void {
    const r = this.request;
    if (!r || r.id !== id) return;
    this.request = null;
    const failure = error ?? r.error;
    // Thoughts and nothing else (a signature on an empty text) is no answer either: the user would be left waiting.
    const empty = !r.parts.some((p) => obj(p.functionCall) != null || (typeof p.text === "string" && p.thought !== true && p.text.trim().length > 0));
    if (failure != null || empty) {
      // A request the API calls malformed would be refused again with the same conversation: it starts over from the user's last words.
      if (status === 400) this.forget();
      this.fail(failure ?? "the model sent nothing");
      return;
    }
    this.contents.push({ role: "model", parts: compact(r.parts) });
    const calls = r.parts.filter((p) => obj(p.functionCall) != null).slice(0, 16);
    if (calls.length === 0) { this.endTurn(); this.host.defer(() => this.go()); return; }
    this.callsAt = this.host.now();
    this.calls = calls.map((p) => {
      const call = obj(p.functionCall)!;
      const given = typeof call.id === "string" && call.id.length > 0 && call.id.length < 200 ? call.id : null;
      // The call keys its tasks' requests by this: one of the line's own never repeats.
      return { key: `t${this.nextCall++}`, name: typeof call.name === "string" ? call.name : "", given, answer: null };
    });
    const frames = this.calls.map((c, i) => ({ id: c.key, name: c.name, args: obj(obj(calls[i].functionCall)!.args) ?? {} }));
    this.host.receive(JSON.stringify({ toolCall: { functionCalls: frames } }));
  }

  /** The request timers: a call left unanswered, and a request that has gone quiet. */
  tick(): void {
    const now = this.host.now();
    if (this.calls.length > 0 && now - this.callsAt >= ANSWER_WAIT) {
      for (const c of this.calls) {
        if (c.answer != null) continue;
        const response: Json = { name: c.name, response: { status: "not_executed", retryable: false, message: "Bento did not answer this call. Nothing was run." } };
        if (c.given != null) response.id = c.given;
        c.answer = { functionResponse: response };
      }
      this.speak = true;
      this.answered();
    }
    const r = this.request;
    if (r && now - r.lastAt >= REQUEST_WAIT) {
      this.host.emit({ type: "llm.cancel", id: r.id });
      this.request = null;
      this.fail("the model took too long to answer");
    }
  }

  /** The user stopped the reply: the request is dropped, and what the model had written so far stays said. */
  interrupt(): void {
    const r = this.request;
    if (r) {
      this.host.emit({ type: "llm.cancel", id: r.id });
      this.request = null;
      const said = compact(r.parts.filter((p) => typeof p.text === "string" && p.thought !== true).map((p) => ({ text: p.text })));
      if (said.length > 0) this.contents.push({ role: "model", parts: said });
    }
    if (this.calls.length > 0) {
      for (const c of this.calls) {
        if (c.answer != null) continue;
        const response: Json = { name: c.name, response: { status: "not_executed", retryable: false, message: "The user stopped this before it ran." } };
        if (c.given != null) response.id = c.given;
        c.answer = { functionResponse: response };
      }
      this.contents.push({ role: "user", parts: this.calls.map((c) => c.answer!) });
      this.calls = [];
      this.speak = false;
    }
    this.due = false;
    if (this.turnOpen) this.endTurn();
    this.host.defer(() => this.go());
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.request) this.host.emit({ type: "llm.cancel", id: this.request.id });
    this.request = null;
    this.calls = [];
    this.setThinking(false);
  }

  private fail(why: string): void {
    this.host.log("warn", `the text model didn't answer: ${why}`);
    this.host.emit({ type: "error", message: `Gemini didn't answer: ${why}. Nothing was started; send it again.` });
    this.endTurn();
    this.host.defer(() => this.go());
  }

  private endTurn(): void {
    this.turnOpen = false;
    this.setThinking(false);
    this.host.receive(TURN_END);
  }

  private setThinking(on: boolean): void {
    if (this.thinking === on) return;
    this.thinking = on;
    this.host.emit({ type: "thinking", on });
  }

  /** Only the user's last words are kept. */
  private forget(): void {
    let last: Content | null = null;
    for (const c of this.contents) if (c.role === "user" && c.parts.every((p) => typeof p.text === "string")) last = c;
    this.contents.length = 0;
    if (last) this.contents.push(last);
  }

  /** Past the limit the oldest turns go, up to a turn of the user's own words: a function's answer never leads. */
  private trim(): void {
    const sizes = this.contents.map((c) => JSON.stringify(c).length);
    let total = sizes.reduce((n, s) => n + s, 0);
    let drop = 0;
    while (total > this.c.historyChars && drop < this.contents.length - 1) {
      total -= sizes[drop++];
      while (drop < this.contents.length - 1 && !(this.contents[drop].role === "user" && this.contents[drop].parts.every((p) => typeof p.text === "string"))) {
        total -= sizes[drop++];
      }
    }
    if (drop > 0) this.contents.splice(0, drop);
  }
}

/** Adjacent pieces of plain text as one part; anything with more to it (a signature, a call, a thought) stays as it came. */
function compact(parts: Part[]): Part[] {
  const out: Part[] = [];
  for (const part of parts) {
    const plain = typeof part.text === "string" && Object.keys(part).length === 1;
    const last = out[out.length - 1];
    if (plain && last && typeof last.text === "string" && Object.keys(last).length === 1) last.text = (last.text as string) + (part.text as string);
    else if (plain && (part.text as string).length === 0) continue;
    else out.push(plain ? { text: part.text } : part);
  }
  return out;
}
