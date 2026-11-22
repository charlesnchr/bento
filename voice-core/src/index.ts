// The bundle's entry: `globalThis.VoiceCore`, called by every host with strings and numbers only,
// so JavaScriptCore (macOS), QuickJS (Android, the Echo's Python) and a browser all drive it alike.
//
//   const { id, commands } = JSON.parse(VoiceCore.create(configJson, t))
//   const commands = JSON.parse(VoiceCore.push(id, eventJson))
//
// A config is merged over `VoiceCore.defaults()`, so a host passes only what differs. With
// `trace` on, every event is kept (with the config) for `VoiceCore.trace(id)`, which hands back
// what was kept since its last call: a recording any host can replay (replay.ts).

import { Call } from "./call.ts";
import { CAPTIONS_MODEL, MODEL, TEXT_MODEL, VOICE } from "./setup.ts";
import type { CallConfig, Captions, Command, Event } from "./types.ts";

declare const __VERSION__: string;
export const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "dev";

export function defaults(): CallConfig {
  return {
    medium: "voice",
    text: { model: TEXT_MODEL, generation: { thinkingConfig: { thinkingLevel: "low" } }, historyChars: 400_000 },
    api: "gemini",
    platform: "Android",
    device: "phone",
    model: MODEL,
    voice: VOICE,
    vocabulary: ["Hermes", "Bento"],
    hostTools: [],
    history: [],
    today: "1970-01-01",
    reconnect: true,
    standbyAfter: 0,
    hangUpAfter: 0,
    muted: false,
    mic: { whileSpeaking: "send", gainDb: 0 },
    earcons: true,
    voiceCommands: {
      // "stab it" and "stabit" are how Gemini Live has transcribed "stop it".
      stop: ["stop", "stop it", "stab it", "stabit", "stop talking", "stop there", "quiet", "be quiet", "hush", "shush", "shut up", "enough", "that's enough", "pause"],
      hangUp: ["hang up", "end call", "end the call", "stop the call", "goodbye", "bye", "bye bye", "that's all", "that's all for now"],
      cancelAll: ["stop everything", "cancel everything", "cancel all tasks", "cancel all the tasks", "stop all tasks", "stop all the tasks", "abort everything"],
    },
    codingAgent: null,
    steering: [],
    handOff: "tone",
    announce: { by: "model", engaged: 12, lull: 4, attach: 0.4, briefWait: 3, maxWait: 6, maxWords: 28 },
    supervise: false,
    captions: null,
    attention: { mode: "open", afterWake: 8, window: 5, afterQuestion: 10, afterHandOff: 3, afterAnnouncement: 0 },
    limits: {
      connect: 25,
      deadMic: 2,
      deadMicWarn: 5,
      deadMicRetry: 10,
      tick: 1,
      settleQuiet: 0.8,
      settleMax: 5,
      deliverMax: 30,
      wakeLevel: 0.05,
      speechLevel: 0.03,
      wakeSpeech: 0.5,
      wakePreRoll: 1.5,
      wakeGap: 3,
      holdMax: 15,
    },
  };
}

/** What `captions: {}` stands for. */
const CAPTIONS: Captions = { model: CAPTIONS_MODEL, idle: 20, linger: 4 };

/** [given] over the defaults; nested objects (mic, voiceCommands, limits) merge a level deep. */
export function configFrom(given: Partial<CallConfig> & Record<string, unknown>): CallConfig {
  const base = defaults();
  return {
    ...base,
    ...given,
    text: { ...base.text, ...(given.text ?? {}) },
    mic: { ...base.mic, ...(given.mic ?? {}) },
    voiceCommands: { ...base.voiceCommands, ...(given.voiceCommands ?? {}) },
    announce: { ...base.announce, ...(given.announce ?? {}) },
    attention: { ...base.attention, ...(given.attention ?? {}) },
    captions: given.captions ? { ...CAPTIONS, ...given.captions } : null,
    limits: { ...base.limits, ...(given.limits ?? {}) },
  } as CallConfig;
}

export interface Recording {
  version: string;
  config: CallConfig;
  start: number;
  events: Event[];
}

interface Entry { call: Call; trace: boolean; kept: Event[]; header: boolean; config: CallConfig; start: number }

const calls = new Map<number, Entry>();
let nextId = 1;

export function create(configJson: string, t: number): string {
  const given = JSON.parse(configJson) as Partial<CallConfig> & { trace?: boolean };
  const trace = given.trace === true;
  delete given.trace;
  const config = configFrom(given);
  const call = new Call(config);
  const id = nextId++;
  calls.set(id, { call, trace, kept: [], header: false, config, start: t });
  return JSON.stringify({ id, commands: call.start(t) });
}

export function push(id: number, eventJson: string): string {
  const entry = calls.get(id);
  if (!entry) return "[]";
  const event = JSON.parse(eventJson) as Event;
  if (entry.trace) entry.kept.push(event);
  return JSON.stringify(entry.call.push(event));
}

/** Several events at once (a host behind on ticks, say); the commands of all, in order. */
export function pushAll(id: number, eventsJson: string): string {
  const entry = calls.get(id);
  if (!entry) return "[]";
  const out: Command[] = [];
  for (const event of JSON.parse(eventsJson) as Event[]) {
    if (entry.trace) entry.kept.push(event);
    out.push(...entry.call.push(event));
  }
  return JSON.stringify(out);
}

/** What the trace kept since the last call: the first time with the version and config, after that events only. */
export function trace(id: number): string {
  const entry = calls.get(id);
  if (!entry) return "null";
  const events = entry.kept.splice(0);
  if (entry.header) return JSON.stringify({ events });
  entry.header = true;
  const recording: Recording = { version: VERSION, config: entry.config, start: entry.start, events };
  return JSON.stringify(recording);
}

export function dispose(id: number): void {
  calls.delete(id);
}

const api = {
  version: VERSION,
  defaults: () => JSON.stringify(defaults()),
  create,
  push,
  pushAll,
  trace,
  dispose,
};

(globalThis as unknown as { VoiceCore: typeof api }).VoiceCore = api;

export { Call };
export type { CallConfig, Command, Event };
