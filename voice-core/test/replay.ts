// Replays a recording through dist/voice-core.js in a fresh JS context with nothing but the
// language's own globals (no atob, TextEncoder or timers), as JavaScriptCore and QuickJS run it.
// Answers are the raw JSON strings the bundle returns: create's first, then one per event.

import { readFileSync } from "node:fs";
import vm from "node:vm";

export const BUNDLE = new URL("../dist/voice-core.js", import.meta.url);

export interface RecordingFile { config: unknown; start: number; events: unknown[] }

export function engine(source = readFileSync(BUNDLE, "utf8")) {
  const context = vm.createContext({});
  vm.runInContext(source, context);
  return context.VoiceCore as {
    version: string;
    create(config: string, t: number): string;
    push(id: number, event: string): string;
    trace(id: number): string;
  };
}

export function replay(recording: RecordingFile, source?: string): string[] {
  const core = engine(source);
  const created = core.create(JSON.stringify(recording.config), recording.start);
  const { id } = JSON.parse(created);
  const answers = [created];
  for (const e of recording.events) answers.push(core.push(id, JSON.stringify(e)));
  return answers;
}
