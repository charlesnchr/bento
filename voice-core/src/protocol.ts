// Which user turn a function call answers, and what Hermes gets for it. Port of Android's
// CallProtocol.kt (itself a port of the Mac's GeminiLiveProtocol).
//
// A function call is only a request ID: Hermes gets the user's own transcribed, unconsumed words,
// never text the voice model wrote, and transcripts never execute alone. Gemini marks each user
// turn with voiceActivity ACTIVITY_START and ACTIVITY_END; the transcript arrives inside that
// window and the call just after it. A call belongs to the turn it answers, so earlier speech the
// model never acted on and follow-ups after the call are never its request, and a transcript that
// trails the call still joins its own turn.

import { utf8Length } from "./bytes.ts";
import { lastOrNull, takeLast } from "./kt.ts";

/**
 * A spoken request for Hermes: the user's own transcribed words, and what was said before them.
 * [taskId] is the call's task as the screen keys it ("1", "2", …) once it starts, and [label] its
 * name; Hermes gets neither. A [followUp] continues that task's Hermes session.
 */
export interface HermesCall {
  id: string;
  task: string;
  context: string;
  taskId: string;
  followUp: boolean;
  label: string;
}

export interface Delegation { id: string; at: number; turn: number | null }
interface TurnState { complete: boolean; changed: number | null }

class Turn {
  ended: number | null = null;
  heard: number | null = null;
  text = "";
  consumed = false;
  /** Its first words may be the previous turn's late transcript. */
  ambiguous = false;
  readonly id: number;
  readonly started: number;
  constructor(id: number, started: number) { this.id = id; this.started = started; }
}

interface Fragment { role: string; at: number; text: string }

export const TOOL = "ask_hermes";
export const CODE_TOOL = "ask_coding_agent";
export const LIST_TASKS = "list_tasks";
export const CHECK_TASK = "check_task";
export const CANCEL_TASK = "cancel_task";

export class CallProtocol {
  /**
   * Seconds between two user turns under which the earlier, if the model neither answered it nor
   * acted on it, is part of the request the later one finishes (0 = never). The model's activity
   * detection ends a turn at a pause for thought, so a request said in two breaths is two turns.
   */
  join = 0;
  private seen = new Set<string>();
  private turns: Turn[] = [];
  private history: Fragment[] = [];
  private historyBytes = 0;
  private nextTurn = 0;

  /** A new user turn begins (ACTIVITY_START). */
  activityStarted(at: number): void {
    const last = lastOrNull(this.turns);
    if (!Number.isFinite(at) || at < (last?.started ?? 0)) return;
    const turn = new Turn(this.nextTurn, at);
    if (last != null && last.text.length === 0 && (last.ended == null || at - last.ended < 3)) turn.ambiguous = true;
    this.turns.push(turn);
    this.nextTurn++;
    if (this.turns.length > 32) this.turns.shift();
  }

  /** The current user turn ends (ACTIVITY_END). */
  activityEnded(at: number): void {
    const last = lastOrNull(this.turns);
    if (last == null || !Number.isFinite(at) || last.ended != null || at < last.started) return;
    last.ended = at;
  }

  /** Records a transcript fragment for context and, for the user, the current turn. */
  transcript(role: string, text: string, at: number): void {
    if (role !== "user" && role !== "assistant") return;
    const size = utf8Length(text);
    if (text.length === 0 || size > 12_000 || !Number.isFinite(at) || at < (lastOrNull(this.history)?.at ?? 0)) return;
    this.history.push({ role, at, text });
    this.historyBytes += size;
    while (this.history.length > 128 || this.historyBytes > 12_000) this.historyBytes -= utf8Length(this.history.shift()!.text);
    // User words join the latest turn even after its end; a consumed turn keeps its late words, so they can never run.
    if (role !== "user") return;
    const last = lastOrNull(this.turns);
    if (last == null) return;
    // Past 4,000 characters a turn never runs, so it stops growing.
    if (last.text.length <= 4000) last.text += text;
    last.heard = at;
  }

  /** A new call of a delegating tool ([names]), or null for anything else (unknown name, repeated or bad ID). */
  delegation(name: string | null, id: string | null, at: number, names: string[] = [TOOL]): Delegation | null {
    if (name == null || !names.includes(name) || !id || id.length >= 200 || this.seen.has(id) || this.seen.size >= 256 || !Number.isFinite(at) || at < 0) return null;
    this.seen.add(id);
    const started = this.turns.filter((t) => t.started <= at);
    let turn: Turn | null = lastOrNull(started);
    // The model answers a turn just after its end, so a turn still open when the call arrives is a
    // follow-up to one that ended moments before. If an unanswered turn ended a little earlier,
    // which turn the call answers is unclear and nothing runs.
    if (turn != null && turn.ended == null && started.length > 1) {
      const before = started[started.length - 2];
      const end = before.ended;
      if (!before.consumed && end != null && end >= at - 8) turn = at - end <= 2 ? before : null;
    }
    return { id, at, turn: turn?.id ?? null };
  }

  /** Whether the call's turn has ended with words, and when it last changed. */
  turnState(d: Delegation): TurnState {
    const turn = this.turns.find((t) => t.id === d.turn);
    if (!turn) return { complete: false, changed: null };
    const times = [turn.ended, turn.heard].filter((v): v is number => v != null);
    return { complete: turn.ended != null && turn.text.length > 0, changed: times.length ? Math.max(...times) : null };
  }

  /** When the call's turn started (its ACTIVITY_START), if it's still known. */
  startedAt(d: Delegation): number | null {
    return this.turns.find((t) => t.id === d.turn)?.started ?? null;
  }

  /** Consumes a declined call's turn so a later call cannot replay it. */
  discardRequest(d: Delegation): void {
    const turn = this.turns.find((t) => t.id === d.turn);
    if (turn) turn.consumed = true;
  }

  /** What was said lately, oldest first, as context for a request from the screen. */
  context(): string {
    return takeLast(this.history.map((f) => `${f.role}: ${f.text}`).join("\n"), 6000);
  }

  request(d: Delegation): HermesCall | null {
    const turn = this.turns.find((t) => t.id === d.turn);
    if (!turn || turn.consumed) return null;
    turn.consumed = true;
    // Speech the model left unanswered for long is not this call's request.
    const ended = turn.ended;
    if (ended == null) return null;
    if (ended < d.at - 8 || turn.ambiguous || turn.text.length > 4000) return null;
    let task = turn.text.trim();
    if (task.length === 0) return null;
    // Earlier breaths of the same request: turns just before it that the model let pass without a word or a call.
    let first = turn;
    if (this.join > 0) {
      for (let i = this.turns.indexOf(turn) - 1; i >= 0; i--) {
        const earlier = this.turns[i];
        const end = earlier.ended;
        if (earlier.consumed || end == null || earlier.text.trim().length === 0 || first.started - end > this.join) break;
        if (this.history.some((f) => f.role === "assistant" && f.at >= earlier.started && f.at < first.started)) break;
        if (earlier.text.length + task.length > 4000) break;
        earlier.consumed = true;
        task = earlier.text.trim() + " " + task;
        first = earlier;
      }
    }
    const context = this.history.filter((f) => f.at < first.started).map((f) => `${f.role}: ${f.text}`).join("\n");
    return { id: d.id, task, context: takeLast(context, 6000), taskId: "", followUp: false, label: "" };
  }
}

/** The most of a Hermes reply the voice model gets: the Mac's `LiveHermesResult.limit`, in UTF-16 units. */
export const RESULT_LIMIT = 64000;

/** What the voice model gets for a Hermes reply: all of it, marked only if the core cut it at RESULT_LIMIT. */
export function fullResult(result: string): string {
  if (result.length === 0) return "Hermes returned no text. Do not infer success.";
  if (result.length <= RESULT_LIMIT) return result;
  // Never split a surrogate pair.
  const c = result.charCodeAt(RESULT_LIMIT - 1);
  const end = c >= 0xd800 && c <= 0xdbff ? RESULT_LIMIT - 1 : RESULT_LIMIT;
  return result.slice(0, end) + ` [Bento cut Hermes's reply here at ${RESULT_LIMIT} characters.]`;
}

/** Said before a reply too long to read out; the chat shows all of it. */
export const LONG_RESULT = "Its reply is long: give the gist and tell the user the full answer is on their screen. ";
export const LONG_WORDS = 120;

export function isLong(result: string): boolean {
  return result.split(/\s+/).filter((w) => w.length > 0).length > LONG_WORDS;
}

/**
 * A task's result as its call's last response, by the task's name: marked finished. When Hermes
 * [asked] the user something, it says the task waits for their answer.
 */
export function taskResult(task: string, result: string, asked: string | null = null): string {
  return `Hermes has finished "${task}". ` + (isLong(result) ? LONG_RESULT : "") +
    "Give the user the outcome in your own words, after anything they have just asked. Hermes's reply:\n" +
    (result.length > 0 ? result : "Hermes returned no text. Do not infer success.") +
    (asked != null ? `\n"${task}" is waiting for the user's answer to: ${asked} When they answer, call ask_hermes with continue_task "${task}".` : "");
}

export interface ResponseOptions {
  /** Vertex has no willContinue: it refuses the whole frame with it. */
  vertex?: boolean;
  name?: string;
  task?: string | null;
  status?: string;
  scheduling?: string;
  willContinue?: boolean;
}

/**
 * A function response in the shape Google asks for: status, retryable and a message. WHEN_IDLE
 * waits for the user to finish speaking, so the model always says the outcome; SILENT only informs
 * it. willContinue keeps a non-blocking call open for a later response.
 */
export function response(id: string, message: string, executed: boolean, o: ResponseOptions = {}): string {
  const r: Record<string, unknown> = { id, name: o.name ?? TOOL, scheduling: o.scheduling ?? "WHEN_IDLE" };
  if (o.willContinue && !o.vertex) r.willContinue = true;
  const body: Record<string, unknown> = { status: o.status ?? (executed ? "ok" : "not_executed") };
  if (o.task != null) body.task = o.task;
  body.retryable = false;
  body.message = fullResult(message);
  r.response = body;
  return JSON.stringify({ toolResponse: { functionResponses: [r] } });
}
