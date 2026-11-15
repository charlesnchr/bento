// Spoken commands the core acts on without the model: "stop" and "hang up". An utterance counts
// only when it is one of the phrases and nothing more, once names and fillers around it are gone,
// so "Woodhouse, stop please" stops and "stop the Pennyworth task" goes to the model as usual.

import type { VoiceCommands } from "./types.ts";

export type VoiceCommand = "stop" | "hangUp" | "cancelAll";

/** Words that may come before or after a command without changing it. */
const FILLER = new Set([
  "hey", "ok", "okay", "please", "now", "just", "so", "um", "uh", "oh", "alright", "right", "yeah", "yes", "thanks", "thank", "you",
  "gemini",
]);

/** [text] as lower-case words, apostrophes dropped ("That's" is "thats"). */
export function words(text: string): string[] {
  return text.toLowerCase().replace(/['’`]/g, "").replace(/[^\p{L}\p{Nd}]+/gu, " ").trim().split(" ").filter((w) => w.length > 0);
}

/** The command [utterance] is, if it's one and nothing more; [names] (the assistant's, "Woodhouse") don't count. */
export function commandIn(utterance: string, commands: VoiceCommands, names: string[] = []): VoiceCommand | null {
  const ignored = new Set([...FILLER, ...names.flatMap(words)]);
  const said = words(utterance);
  let from = 0;
  let to = said.length;
  while (from < to && ignored.has(said[from])) from++;
  while (to > from && ignored.has(said[to - 1])) to--;
  if (from === to || to - from > 5) return null;
  const core = said.slice(from, to).join(" ");
  const is = (phrases: string[]) => phrases.some((p) => words(p).join(" ") === core);
  if (is(commands.hangUp)) return "hangUp";
  if (is(commands.cancelAll ?? [])) return "cancelAll";
  if (is(commands.stop)) return "stop";
  return null;
}
