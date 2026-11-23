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
  /** Microphone frames this loud (RMS, fraction of full scale) hold back a brief that was about to start. */
  speechLevel: number;
  /** Seconds of speech in standby that bring the call back. */
  wakeSpeech: number;
  /** Seconds of audio kept for the model from before the sound that woke the call began, so the first words aren't lost. */
  wakePreRoll: number;
  /** In standby, a pause this long ends a sound: what the microphone hears after it begins another. */
  wakeGap: number;
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

/**
 * Who tells the user a task's result, and when.
 * - "model": the speech model gets the full reply as a turn once the line is quiet and words it itself.
 * - "host": the core keeps a queue. For each result it asks the host for a brief (`brief`: a spoken
 *   headline and its audio, from a text model and TTS), and plays it itself at a moment that fits:
 *   at once when the user has been quiet for `engaged` seconds, otherwise straight after the
 *   model's next reply (`attach` seconds after it ends, unless that reply asked the user
 *   something) or at a lull of `lull` seconds. The model is told what was said and gets the full
 *   reply for follow-up questions. A brief the host can't make goes the "model" way.
 */
export interface Announce {
  by: "model" | "host";
  engaged: number;
  lull: number;
  attach: number;
  /** Seconds the host has to make a brief before the result goes the "model" way. */
  briefWait: number;
  /** Seconds a brief waits for a quiet room before it plays over one that never is (speech the model hears still holds it). */
  maxWait: number;
  /** The most words a brief should have, as the host is told. */
  maxWords: number;
}

/**
 * When the model hears the microphone.
 * - "open": throughout the call.
 * - "window": only for a while after something that makes the user's next words likely to be for
 *   it. The wake word, `resume` or the start of the call gives `afterWake` seconds to start
 *   speaking; a spoken reply leaves `window` seconds; a reply or a task's result that asks the user
 *   something leaves `afterQuestion`; a silent hand-off leaves `afterHandOff`; a result told
 *   unprompted leaves `afterAnnouncement`. Speech that began inside a window is heard to its end
 *   and answered. Otherwise the call is dormant: the model hears nothing, the host listens for its
 *   wake word (`wakeword` on), loud sound no longer brings a call back from standby, and a dormant
 *   call may stand by with nothing running. Any of these may be 0. An open window lets in whatever
 *   is said in the room, and a model that answers a television keeps its own window open, so short
 *   is safer.
 */
export interface Attention {
  mode: "open" | "window";
  afterWake: number;
  window: number;
  afterQuestion: number;
  afterHandOff: number;
  afterAnnouncement: number;
}

/**
 * How the user learns a request has gone to an agent.
 * - "tone": the hand-off's tone and nothing said, as on Android.
 * - "named": the tone, and when a tone can't say which request was taken (another task is running,
 *   or a result is still to be told) the model then says in a few words what it started and who
 *   has it, unless it said so with the call. Results wait until it has, so a result that was ready
 *   never takes the place of the answer to the user's newest request. A hand-off the user speaks
 *   straight over is named with the next one's. A call's only task still gets the tone alone.
 */
export type HandOff = "tone" | "named";

/**
 * Captions: the user's words on screen while they speak. The model sends a turn's transcript in
 * one piece once the user stops, so with this set the call also sends the audio the model hears
 * to a transcription model over a second socket (`ws.connect` with `purpose: "captions"`) and
 * shows its growing guess meanwhile (`caption`). Display only: the model's transcript replaces a
 * caption, and is all an agent gets.
 */
export interface Captions {
  /** The transcription model as its socket's setup names it: `models/…` on the Gemini API, a resource path on Vertex. */
  model: string;
  /** Seconds without audio after which the captions socket closes; the next audio opens another. */
  idle: number;
  /** Seconds a caption stays after its utterance ended, if the model sends no transcript to replace it. */
  linger: number;
}

/**
 * How the user and the model talk.
 * - "voice": a call on Gemini Live, with the microphone and the speaker.
 * - "text": a typed chat. The same call, on a text model reached by request and response
 *   (`llm.request`, `TextModel`), with no audio at all: the user's words come as `say`, the
 *   model's as `transcript`, and tasks, follow-ups, `list_tasks`, `check_task` and `cancel_task`
 *   work as in a voice call. A hand-off is silent (the `task` command shows it). A task's result
 *   isn't told by the model: the host shows the reply it gave the core, and the model gets a note
 *   of it for the user's questions. Standby, hanging up, captions, earcons and spoken commands
 *   don't apply.
 */
export type Medium = "voice" | "text";

/** The text model of a typed chat (medium "text"). */
export interface TextModel {
  /** The model as the host's request names it: `models/…` on the Gemini API, a resource path on Vertex. */
  model: string;
  /** The request's `generationConfig` (the thinking level, say). */
  generation: unknown;
  /** The most of the conversation sent with a request, in characters of JSON: the oldest turns go first. */
  historyChars: number;
}

export interface CallConfig {
  /** A voice call (the default), or a typed chat on a text model. */
  medium: Medium;
  /** The text model, for medium "text". */
  text: TextModel;
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
  handOff: HandOff;
  announce: Announce;
  attention: Attention;
  /**
   * Closer supervision: the instruction says how to take corrections and changes of mind (to the
   * same task), to keep replies short and what a status answer holds; list_tasks and check_task
   * say how long a task has run, how long it has been quiet, and each finished task's outcome; and
   * a request said in two breaths reaches its agent whole (CallProtocol.join).
   */
  supervise: boolean;
  /** Captions of the user's speech (a host passes `{}` for the defaults); null for none. */
  captions: Captions | null;
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
  /** The host heard its wake word: over a reply it cuts it; dormant, the call listens again. */
  | { t: number; type: "wake" }
  | { t: number; type: "cancelTask"; task: string }
  /** Cancels every running task. */
  | { t: number; type: "cancelAll" }
  /** The user pressed stop (or the host heard a stop word): the reply stops, and the rest of its turn is dropped. */
  | { t: number; type: "interrupt" }
  /** The user typed to the model: a turn of its own, as if said. In a typed chat, every message of theirs. */
  | { t: number; type: "say"; text: string }
  /** A task result that landed outside this call/chat (e.g. a detached voice-call task): added to context without starting a turn. */
  | { t: number; type: "note"; label: string; text: string; failed?: boolean }
  /**
   * The text model's answer to `llm.request` [id]: one `generateContent` response as JSON, whole
   * or one chunk of a stream (each `data:` line of `streamGenerateContent?alt=sse`).
   */
  | { t: number; type: "llm.data"; id: number; data: string }
  /** The request is over. `error` says why it failed, with the HTTP status if there was one. */
  | { t: number; type: "llm.end"; id: number; error?: string; status?: number }
  /** A new task from the screen, straight to its agent ("hermes" unless "t3"); its result comes back like any other. */
  | { t: number; type: "ask"; text: string; agent?: Agent; project?: string }
  /** A follow-up to a task from the screen: into its current run if it can be steered, otherwise next, in the task's session. */
  | { t: number; type: "steer"; task: string; text: string }
  /** The agent wouldn't take a steer (its run was ending): the follow-up waits for the next run instead. */
  | { t: number; type: "tool.steerFailed"; run: string; text: string }
  /** The host's brief for a result (`brief`): what to say, and that as PCM16 mono at 24 kHz, base64. */
  | { t: number; type: "brief.ready"; id: string; text: string; pcm: string }
  /** The host couldn't make the brief: the speech model tells the result instead. */
  | { t: number; type: "brief.failed"; id: string; message?: string }
  /** Lends the microphone to a dictation while in standby; `reclaim` takes it back. */
  | { t: number; type: "lend" }
  | { t: number; type: "reclaim" }
  | { t: number; type: "stop"; message?: string };

/** Who works on a task: Hermes, or the coding agent (T3 Code). */
export type Agent = "hermes" | "t3";

/** "dormant": the call is up but not listening until the wake word (attention "window"). */
export type Status = "connecting" | "listening" | "working" | "dormant" | "standby" | "waking" | "ended";

export type Command =
  /**
   * Open a socket to the model; `sid` names it in later commands and events. The host owns the URL
   * and credentials. With `purpose: "captions"` it goes to the transcription model `model` instead.
   */
  | { type: "ws.connect"; sid: number; model: string; purpose?: "captions" }
  | { type: "ws.send"; sid: number; data: string }
  | { type: "ws.close"; sid: number }
  /**
   * A typed chat's request to its text model: POST `body` (a `generateContent` request, as JSON) to
   * `model` with the host's own URL and credentials, and answer with `llm.data` for each response
   * (or each chunk, streaming) and then `llm.end`. One is under way at a time.
   */
  | { type: "llm.request"; id: number; model: string; body: string }
  /** Drop the request: its answer is no longer wanted. */
  | { type: "llm.cancel"; id: number }
  /** A typed chat's model is working on its answer (on), or has finished its turn (off). */
  | { type: "thinking"; on: boolean }
  /** Something went wrong that the user should see and the call survives: the text model didn't answer. */
  | { type: "error"; message: string }
  | { type: "mic.start" }
  | { type: "mic.restart" }
  | { type: "mic.stop" }
  /** Play PCM16 mono at 24 kHz, base64, after what's queued. */
  | { type: "play"; pcm: string; source?: "announcer" }
  /**
   * Make a brief of a task's result for the core to say (announce.by "host"): a headline of at
   * most `maxWords` words for the ear, naming what the task was about, and its audio in `voice`.
   * Answer with `brief.ready` or `brief.failed`. `question` is what the reply asks the user, if anything.
   */
  | { type: "brief"; id: string; label: string; agent: Agent; request: string; result: string; question: string | null; failed: boolean; voice: string; maxWords: number }
  /** Drop what hasn't played yet. */
  | { type: "flush" }
  /** A short tone over whatever is playing, at once: PCM16 mono at 24 kHz, base64. */
  | { type: "cue"; earcon: "taskStarted" | "resultArrived"; pcm: string }
  /** Listen for the wake word (on) or stop (off): over a reply with whileSpeaking "wake", and while dormant. */
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
  /**
   * Words said, for the screen. Fragments with the same `line` are one line and a new number starts
   * the next: a new turn of the user's, another speaker, a new session, or a task between.
   */
  | { type: "transcript"; role: "user" | "assistant"; text: string; line: number; source?: "announcer" }
  /**
   * The words the user is saying, for the screen only (CallConfig.captions): each replaces the
   * last, and null takes the caption down (the `transcript` that follows has the words, or
   * nothing came of them). Never part of the conversation.
   */
  | { type: "caption"; text: string | null }
  /** A task's state for the screen. */
  | { type: "task"; id: string; label: string; agent: Agent; request: string; state: string; progress: string | null; question: string | null }
  /** Tasks waiting for the user's answer, by key, with what Hermes asked. */
  | { type: "questions"; questions: Record<string, string> }
  /** The microphone has picked nothing up for a while, even after restarting. */
  | { type: "micSilent"; silent: boolean }
  | { type: "log"; level: "info" | "warn"; message: string }
  /** The core heard a spoken command and acted on it. */
  | { type: "voiceCommand"; command: "stop" | "hangUp" | "cancelAll"; heard: string };
