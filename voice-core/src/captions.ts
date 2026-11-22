// The user's words on screen while they speak: port of Android's LiveCaptions (CallCaptions.kt)
// and of AssistantCall's caption bookkeeping.
//
// Gemini Live sends a turn's transcript in one piece just after the user stops. Measured on
// gemini-3.8-live on Vertex on 2026-11-22: 8.8 s of speech came as one inputTranscription 0.84 s
// after it ended, with nothing during it, whatever `inputAudioTranscription.mode` was. So the
// call also streams the audio it sends the model to Gemini's transcription model, which answers
// with a growing guess every quarter to one second (`interimInputTranscription`).
//
// Display only: Hermes still gets Gemini Live's own transcript (CallProtocol), and a caption goes
// once that transcript arrives. A captioner that can't connect gives up quietly; the call goes on
// without captions.
//
// A socket opens with the first audio, so a muted call opens none, and closes after `idle` seconds
// without audio (a long mute, standby). One that ends (Gemini rotates connections after about ten
// minutes) is replaced at the next audio: captions need no memory of earlier speech.

import { lastOrNull } from "./kt.ts";
import { captionsSetupFrame } from "./setup.ts";
import type { Captions as Settings } from "./types.ts";

/** Seconds a socket has to set up. */
const SETUP_WAIT = 10;
/** Seconds after a socket broke before the next opens; what is said meanwhile gets no caption. */
const RETRY = 5;
/** Sockets in a row that broke without a caption before the captioner gives up. */
const MAX_FAILURES = 3;
/** Frames that wait while a socket opens: about two seconds. */
const QUEUE_MAX = 100;
/** The model's user turns kept, to place a transcript. */
const TURNS = 8;
/**
 * Seconds after its ACTIVITY_END a turn's transcript can still come (they came 0.01 s apart on
 * 2026-10-30). Once a next turn has started, TURN_SILENCE after its start bounds this too.
 */
const LATE_TRANSCRIPT = 1.5;
/** Silence Gemini Live waits for before it ends a turn (about 0.8 s on 2026-10-30). */
const TURN_SILENCE = 0.8;
const STREAM_END = '{"realtimeInput":{"audioStreamEnd":true}}';

/** What the call does for its captions: the socket's commands, and the caption for the screen. */
export interface CaptionsHost {
  /** Opens a socket to [model]; its sid. */
  connect(model: string): number;
  send(sid: number, frame: string): void;
  close(sid: number): void;
  /** The words for the screen; null takes them down. */
  show(text: string | null): void;
  log(level: "info" | "warn", message: string): void;
  /** The call is off the model (standby): its captions aren't shown. */
  away(): boolean;
}

/** Audio for the captioner ([bytes] 0: "the microphone went quiet") and when it came. */
interface Frame { frame: string; bytes: number; at: number }

interface Socket {
  sid: number;
  open: boolean;
  ready: boolean;
  openedAt: number;
  /** Frames that came before it was set up. */
  queue: Frame[];
  speaking: boolean;
  captioned: boolean;
  /** Seconds of audio sent on it, and where that jumped in time (a mute, dropped frames): the server counts an utterance's start in audio, the call in time. */
  sent: number;
  marks: [number, number][];
}

/** A user turn as the model heard it. */
interface Turn {
  started: number;
  ended: number | null;
  transcribed: boolean;
  /** A transcript that came during it went to an earlier turn. */
  lent: boolean;
}

export class Captions {
  private readonly host: CaptionsHost;
  private readonly settings: Settings;
  private readonly vocabulary: string[];

  private socket: Socket | null = null;
  private failures = 0;
  private retryAt = 0;
  private gaveUp = false;
  private lastAudio = 0;

  /** The caption on screen, and when the captioner's utterance it came from started. */
  private text: string | null = null;
  private shownFrom: number | null = null;
  /**
   * The model's recent user turns, and when the last one it transcribed ended (or its transcript
   * came, if that was first). The captioner hears the same audio as it's spoken, so an utterance
   * of its that started by then is in the model's transcript.
   */
  private readonly turns: Turn[] = [];
  private transcribedUntil: number | null = null;
  /** When the captioner's current utterance started, its latest guess, and how many of its words the model has transcribed. */
  private turnAt: number | null = null;
  private guess = "";
  private wordsTranscribed = 0;
  /** When the captioned utterance ended, for taking down a caption the model never replaces. */
  private endedAt: number | null = null;

  constructor(settings: Settings, vocabulary: string[], host: CaptionsHost) {
    this.settings = settings;
    this.vocabulary = vocabulary;
    this.host = host;
  }

  // The socket.

  /** Microphone audio as the model was sent it: a `realtimeInput` frame of [bytes] of PCM16 at 16 kHz. */
  feed(frame: string, bytes: number, t: number): void {
    if (this.gaveUp || t < this.retryAt) return;
    this.lastAudio = t;
    this.put(this.socket ?? this.connect(t), { frame, bytes, at: t });
  }

  /** The microphone went quiet (muted, standby): the utterance ends now, not at the next pause. */
  pause(t: number): void {
    // Nothing opens until there is something to hear.
    if (this.socket) this.put(this.socket, { frame: STREAM_END, bytes: 0, at: t });
  }

  private connect(t: number): Socket {
    const socket: Socket = { sid: this.host.connect(this.settings.model), open: false, ready: false, openedAt: t, queue: [], speaking: false, captioned: false, sent: 0, marks: [] };
    this.socket = socket;
    return socket;
  }

  private put(socket: Socket, frame: Frame): void {
    if (socket.ready) { this.transmit(socket, frame); return; }
    socket.queue.push(frame);
    if (socket.queue.length > QUEUE_MAX) socket.queue.shift();
  }

  private transmit(socket: Socket, frame: Frame): void {
    if (frame.bytes > 0) {
      const last = lastOrNull(socket.marks);
      const expected = last ? last[1] + socket.sent - last[0] : null;
      if (expected == null || Math.abs(frame.at - expected) > 0.1) {
        socket.marks.push([socket.sent, frame.at]);
        if (socket.marks.length > 64) socket.marks.shift();
      }
      socket.sent += frame.bytes / 32_000;
    }
    this.host.send(socket.sid, frame.frame);
  }

  /** When the audio at [offset] seconds into the socket's stream was captured. */
  private capturedAt(socket: Socket, offset: number | null): number | null {
    if (offset == null) return null;
    for (let i = socket.marks.length - 1; i >= 0; i--) {
      const [sent, at] = socket.marks[i];
      if (sent <= offset) return at + offset - sent;
    }
    return null;
  }

  /** The host opened [sid]: true if it was the captions socket. */
  opened(sid: number): boolean {
    const socket = this.socket;
    if (!socket || socket.sid !== sid) return false;
    if (!socket.open) {
      socket.open = true;
      this.host.send(sid, captionsSetupFrame(this.settings.model, this.vocabulary));
    }
    return true;
  }

  /** A frame on [sid]: true if it was the captions socket's. */
  message(sid: number, data: string, t: number): boolean {
    const socket = this.socket;
    if (!socket || socket.sid !== sid) return false;
    let root: Record<string, unknown> | null;
    try { root = object(JSON.parse(data)); } catch { root = null; }
    if (!root) return true;
    const error = object(root.error);
    if (error) {
      this.host.log("warn", `captions: ${typeof error.message === "string" ? error.message : "the transcription model failed"}`);
      this.end(true, t);
      return true;
    }
    if (root.setupComplete !== undefined) {
      socket.ready = true;
      for (const frame of socket.queue.splice(0)) this.transmit(socket, frame);
      return true;
    }
    const activity = object(root.voiceActivity);
    const kind = typeof activity?.type === "string" ? activity.type : "";
    if (kind.endsWith("START")) {
      socket.speaking = true;
      this.started(this.capturedAt(socket, seconds(activity?.audioOffset)) ?? t);
    }
    const content = object(root.serverContent);
    const interim = words(object(content?.interimInputTranscription)?.text);
    if (interim) {
      socket.captioned = true;
      this.partial(interim, t);
    }
    // The transcription model's own final: the utterance is over. The words shown stay the model's.
    const final = words(object(content?.inputTranscription)?.text);
    if ((final || kind.endsWith("END")) && socket.speaking) {
      socket.speaking = false;
      this.utteranceEnded(t);
    }
    // The server will close this socket soon: the next audio opens another.
    if (root.goAway !== undefined || content?.goAway !== undefined) this.end(false, t);
    return true;
  }

  /** The host says [sid] closed: true if it was the captions socket. */
  closed(sid: number, t: number): boolean {
    const socket = this.socket;
    if (!socket || socket.sid !== sid) return false;
    this.end(true, t, true);
    return true;
  }

  /** Leaves the socket. One that [broke] (an error, a drop, no setup) waits before the next; idle and goAway don't. */
  private end(broke: boolean, t: number, closedByHost = false): void {
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    if (!closedByHost) this.host.close(socket.sid);
    if (socket.speaking) this.utteranceEnded(t);
    // Only captions prove the captioner works.
    if (socket.captioned) this.failures = 0;
    if (!broke) return;
    if (!socket.captioned && ++this.failures >= MAX_FAILURES) {
      this.gaveUp = true;
      this.host.log("warn", "captions: the transcription model couldn't be reached; the call goes on without them");
      return;
    }
    this.retryAt = t + RETRY;
  }

  /** The call's clock moved on: a socket that never set up or has had no audio closes, and a caption nothing replaced comes down. */
  tick(t: number): void {
    const socket = this.socket;
    if (socket && !socket.ready && t - socket.openedAt >= SETUP_WAIT) this.end(true, t);
    else if (socket && t - this.lastAudio >= this.settings.idle) this.end(false, t);
    if (this.endedAt != null && t - this.endedAt >= this.settings.linger) this.takeDown();
  }

  /** The call ended. */
  stop(): void {
    const socket = this.socket;
    this.socket = null;
    this.gaveUp = true;
    if (socket) this.host.close(socket.sid);
    this.takeDown();
  }

  // The caption on screen.

  private started(at: number): void {
    this.turnAt = at;
    this.guess = "";
    this.wordsTranscribed = 0;
    this.endedAt = null;
  }

  private partial(guess: string, t: number): void {
    const from = this.turnAt ?? (this.turnAt = t);
    this.guess = guess;
    if (this.host.away()) return;
    // Guesses at words the model has transcribed are stale. Once the model hears a new turn and
    // the captioner hasn't split there, what follows those words is the new turn's.
    const latest = lastOrNull(this.turns);
    const text = !this.isTranscribed() ? guess
      : latest && latest.started > this.transcribedUntil! ? split(guess).slice(this.wordsTranscribed).join(" ")
      : "";
    if (text.trim() === "") return;
    this.endedAt = null;
    this.show(text, from);
  }

  private utteranceEnded(t: number): void {
    if (this.text != null) this.endedAt = t;
  }

  private show(text: string, from: number): void {
    this.shownFrom = from;
    if (this.text === text) return;
    this.text = text;
    this.host.show(text);
  }

  /** Takes the caption off the screen. */
  takeDown(): void {
    this.endedAt = null;
    if (this.text == null) return;
    this.text = null;
    this.host.show(null);
  }

  /** The captioner's current utterance started by the end of what the model has transcribed. */
  private isTranscribed(): boolean {
    return this.turnAt != null && this.transcribedUntil != null && this.turnAt <= this.transcribedUntil;
  }

  /** The model heard the user start a turn. */
  turnStarted(t: number): void {
    this.turns.push({ started: t, ended: null, transcribed: false, lent: false });
    if (this.turns.length > TURNS) this.turns.shift();
  }

  /** The model heard the user's turn end. */
  turnEnded(t: number): void {
    const turn = lastOrNull(this.turns);
    if (!turn || turn.ended != null) return;
    turn.ended = t;
    if (!turn.transcribed && turn.lent) {
      // A transcript lent to an earlier turn while this one went on, and none of its own: it was this one's.
      turn.transcribed = true;
      this.transcribedUntil = Math.max(this.transcribedUntil ?? 0, t);
      if (this.isTranscribed()) {
        this.wordsTranscribed = split(this.guess).length;
        if (this.shownFrom != null && this.shownFrom <= this.transcribedUntil) this.takeDown();
      }
    } else if (turn.transcribed) this.transcribedUntil = Math.max(this.transcribedUntil ?? 0, t);
  }

  /**
   * The model's transcript of the user's words is about to go on screen: the caption comes down
   * for it. Returns what puts a caption of later words straight back, to call once it has.
   */
  transcribed(transcript: string, t: number): () => void {
    this.transcribedUntil = Math.max(this.transcribedUntil ?? 0, this.transcribedTurnEnd(t));
    // Covered: this transcript's words, but no more than the captioner has guessed so far (the
    // transcript may span earlier utterances of its; a late one may come after the user has said more).
    if (this.isTranscribed()) this.wordsTranscribed = Math.min(split(this.guess).length, this.wordsTranscribed + split(transcript).length);
    const later = this.text != null && this.shownFrom != null && this.shownFrom > this.transcribedUntil ? this.text : null;
    const from = this.shownFrom;
    if (later == null) this.endedAt = null;
    const linger = this.endedAt;
    this.takeDown();
    return () => {
      if (later == null || from == null) return;
      this.endedAt = linger;
      this.show(later, from);
    };
  }

  /**
   * The turn a user transcript belongs to, marked transcribed, and when it ended (now if it
   * hasn't). The model sends a turn's words with its ACTIVITY_END, so they're the latest turn's,
   * unless an earlier one ended just now without words: then they trail it (LATE_TRANSCRIPT).
   * A turn that ends without words (a cough) is soon past claiming any, and words it claims
   * from a short reply go back to the reply when that ends without words of its own.
   */
  private transcribedTurnEnd(t: number): number {
    const latest = lastOrNull(this.turns);
    if (!latest) return t;
    // The latest turn's own words come after the model has heard its closing silence (TURN_SILENCE).
    const earlier = t - latest.started < TURN_SILENCE
      ? this.turns.find((turn) => turn !== latest && !turn.transcribed && turn.ended != null && t - turn.ended <= LATE_TRANSCRIPT)
      : undefined;
    const owner = earlier ?? latest;
    owner.transcribed = true;
    if (owner !== latest) latest.lent = true;
    return owner.ended ?? t;
  }
}

function object(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** A transcript's text, trimmed; null when there is none. */
function words(v: unknown): string | null {
  const text = typeof v === "string" ? v.trim() : "";
  return text === "" ? null : text;
}

function split(text: string): string[] {
  return text.split(/\s+/).filter((w) => w !== "");
}

/** "0.320s" (a protobuf Duration in JSON), or a bare number. */
function seconds(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const digits = v.endsWith("s") ? v.slice(0, -1) : v;
  const n = Number(digits);
  return digits !== "" && Number.isFinite(n) ? n : null;
}
