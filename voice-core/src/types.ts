// The core's whole interface with a host: events in, commands out, both plain JSON. A host owns
// the microphone, the speaker, the sockets and the tools; the core decides everything else.
// Every event carries `t`, the host's monotonic clock in seconds, and the core never reads a
// clock of its own, so a recorded list of events replays to the same commands anywhere.

import type { HostTool } from "./setup.ts";

export interface Limits {
  /** Seconds to set up a session before the call gives up. */
  connect: number;
  /** Seconds without a nonzero microphone sample, or any frame, before the microphone restarts. */
  deadMic: number;
  /** Seconds still dead after the first restart before the user is told (and it restarts again). */
  deadMicWarn: number;
  /** Seconds between further restarts while it stays dead. */
  deadMicRetry: number;
  /** The watchdog's period, in seconds. */
  tick: number;
  settleQuiet: number;
  settleMax: number;
  /** The longest a result waits for a quiet line, and for the model to say it before it goes again. */
  deliverMax: number;
  /** In standby, microphone frames this loud (RMS, fraction of full scale) count as speech; 0 never wakes. */
  wakeLevel: number;
  /** Seconds of speech in standby that bring the call back. */
  wakeSpeech: number;
  /** Seconds of audio before the wake kept for the model, so the first words aren't lost. */
  wakePreRoll: number;
  /** The most audio held for a session coming back from standby, in seconds. */
  holdMax: number;
}

export interface ChatLine {
  role: "user" | "assistant";
  /** Who an assistant line is from ("Gemini", "Hermes · Copenhagen weather"); Hermes when absent. */
  speaker?: string;
  text: string;
  failed?: boolean;
}

/**
 * What the model hears of the microphone while its own reply is still playing:
 * - "send": everything (the platform's echo canceller keeps the reply out; the phone's does);
 * - "silence": silence, so the reply's echo can't interrupt it, and nor can the user;
 * - "wake": silence, and the host listens for its wake word meanwhile (`wakeword` commands);
 *   hearing it (the `wake` event) cuts the reply and gives the model the microphone again.
 *   The Echo works this way, since its echo canceller leaves the reply as loud as a talker.
 */
export type WhileSpeaking = "send" | "silence" | "wake";

/**
 * Which Live API the socket speaks. Vertex has no `willContinue`, so a call can't take a second
 * response there: a task's "started" answer closes its call, and the result goes in as a turn.
 */
export type Api = "gemini" | "vertex";

/**
 * Spoken commands the core acts on itself, from the user's transcribed words. An utterance that is
 * one of these and nothing more counts: names and fillers around it ("Woodhouse, stop please") are
 * ignored. `stop` cuts the model's reply and keeps it quiet until the user speaks again; `hangUp`
 * ends the call once the user has finished saying it; `cancelAll` cancels every running task too.
 */
export interface VoiceCommands {
  stop: string[];
  hangUp: string[];
  /** Cancels every running task and stops the reply. */
  cancelAll: string[];
}

/**
 * A coding agent the model can hand repository work to (T3 Code), alongside Hermes: its tasks work
 * like Hermes tasks. `projects` are the names the model may pass as `project`.
 */
export interface CodingAgent {
  projects: string[];
}

export interface CallConfig {
  api: Api;
  /** The surface, for the instruction and the words Hermes gets: "Android", "macOS", "web", "Echo". */
  platform: string;
  /** What the user holds, for Hermes's words: "phone", "Mac", "browser". */
  device: string;
  /** The model as the socket's setup names it: `models/…` on the Gemini API, a resource path on Vertex. */
  model: string;
  voice: string;
  /** Replaces the instruction (the Android one with the platform's name in it). */
  instruction?: string;
  vocabulary: string[];
  /** Tools the host runs itself; the model waits for their answer. */
  hostTools: HostTool[];
  /** The conversation before the call, oldest first: a call on it resumes it. */
  history: ChatLine[];
  /** Today's date as Hermes is told it (YYYY-MM-DD). */
  today: string;
  /** Whether the call may open new sockets: to follow Gemini's goAway, and for standby. */
  reconnect: boolean;
  /** Seconds without speech after which a call waiting only on Hermes leaves the model (0 = never). */
  standbyAfter: number;
  /** Seconds without speech after which a call with nothing left to do hangs up (0 = never). */
  hangUpAfter: number;
  /** Tap-to-talk: the call starts muted. */
  muted: boolean;
  /** PCM16 at 16 kHz said before the call connected (the words after a wake word), base64: heard first. */
  opening?: string;
  mic: { whileSpeaking: WhileSpeaking; gainDb: number };
  earcons: boolean;
  voiceCommands: VoiceCommands;
  /** Declares ask_coding_agent when set. */
  codingAgent: CodingAgent | null;
  /**
   * Agents the host can steer while they work (`tool.steer`): a follow-up to a running task of one
   * goes into its current run instead of waiting for it to finish.
   */
  steering: Agent[];
  limits: Limits;
}

export type Event =
  | { t: number; type: "ws.open"; sid: number }
  | { t: number; type: "ws.message"; sid: number; data: string }
  | { t: number; type: "ws.closed"; sid: number; code?: number; reason?: string; httpStatus?: number }
  /** Microphone audio: PCM16 mono at 16 kHz, base64, any length (20 ms frames are usual). */
  | { t: number; type: "mic"; pcm: string }
  /** Every 100 ms or so: the core's timers run on these. */
  | { t: number; type: "tick" }
  /** A tool call finished: Hermes's reply, or a host tool's answer. `failed` keeps it out of the recap. */
  | { t: number; type: "tool.result"; run: string; text: string; failed?: boolean }
  /** A tool call threw: the model hears that it failed. */
  | { t: number; type: "tool.error"; run: string; message: string }
  /** The latest of what a Hermes task is doing ("Using web_search"), for check_task and list_tasks. */
  | { t: number; type: "task.progress"; task: string; text: string }
  | { t: number; type: "mute" }
  | { t: number; type: "unmute" }
  /** Back from standby now, to talk before Hermes finishes. */
  | { t: number; type: "resume" }
  /** The host heard its wake word (whileSpeaking "wake"). */
  | { t: number; type: "wake" }
  | { t: number; type: "cancelTask"; task: string }
  /** Cancels every running task. */
  | { t: number; type: "cancelAll" }
  /** The user pressed stop (or the host heard a stop word): the reply stops, and the rest of its turn is dropped. */
  | { t: number; type: "interrupt" }
  /** The user typed to the model: a turn of its own, as if said. */
  | { t: number; type: "say"; text: string }
  /** A new task from the screen, straight to its agent ("hermes" unless "t3"); its result comes back like any other. */
  | { t: number; type: "ask"; text: string; agent?: Agent; project?: string }
  /** A follow-up to a task from the screen: into its current run if it can be steered, otherwise next, in the task's session. */
  | { t: number; type: "steer"; task: string; text: string }
  /** The agent wouldn't take a steer (its run was ending): the follow-up waits for the next run instead. */
  | { t: number; type: "tool.steerFailed"; run: string; text: string }
  /** Lends the microphone to a dictation while in standby; `reclaim` takes it back. */
  | { t: number; type: "lend" }
  | { t: number; type: "reclaim" }
  | { t: number; type: "stop"; message?: string };

/** Who works on a task: Hermes, or the coding agent (T3 Code). */
export type Agent = "hermes" | "t3";

export type Status = "connecting" | "listening" | "working" | "standby" | "waking" | "ended";

export type Command =
  /** Open a socket to the model; `sid` names it in later commands and events. The host owns the URL and credentials. */
  | { type: "ws.connect"; sid: number; model: string }
  | { type: "ws.send"; sid: number; data: string }
  | { type: "ws.close"; sid: number }
  | { type: "mic.start" }
  | { type: "mic.restart" }
  | { type: "mic.stop" }
  /** Play PCM16 mono at 24 kHz, base64, after what's queued. */
  | { type: "play"; pcm: string }
  /** Drop what hasn't played yet. */
  | { type: "flush" }
  /** A short tone over whatever is playing, at once: PCM16 mono at 24 kHz, base64. */
  | { type: "cue"; earcon: "taskStarted" | "resultArrived"; pcm: string }
  /** whileSpeaking "wake": listen for the wake word (on) or stop (off). */
  | { type: "wakeword"; on: boolean }
  /**
   * Run a tool and answer with `tool.result` or `tool.error` for `run`. A task carries the message
   * for its agent, its task key and name, and whether it continues that task's session; a coding
   * task the project the model named, if it did.
   */
  | { type: "tool.call"; run: string; kind: "hermes"; agent: Agent; message: string; request: string; taskId: string; label: string; followUp: boolean; project?: string }
  | { type: "tool.call"; run: string; kind: "host"; name: string; args: unknown }
  /** Give a running task's agent more to go on, in its current run; `tool.steerFailed` if it won't take it. */
  | { type: "tool.steer"; run: string; agent: Agent; text: string; message: string }
  /** Stop a tool run: the task was cancelled, or the call ended (a host may leave a long agent running then). */
  | { type: "tool.cancel"; run: string; reason: "cancelled" | "ended" }
  | { type: "status"; status: Status; message?: string | null }
  | { type: "transcript"; role: "user" | "assistant"; text: string }
  /** A task's state for the screen. */
  | { type: "task"; id: string; label: string; agent: Agent; request: string; state: string; progress: string | null; question: string | null }
  /** Tasks waiting for the user's answer, by key, with what Hermes asked. */
  | { type: "questions"; questions: Record<string, string> }
  /** The microphone has picked nothing up for a while, even after restarting. */
  | { type: "micSilent"; silent: boolean }
  | { type: "log"; level: "info" | "warn"; message: string }
  /** The core heard a spoken command and acted on it. */
  | { type: "voiceCommand"; command: "stop" | "hangUp" | "cancelAll"; heard: string };
