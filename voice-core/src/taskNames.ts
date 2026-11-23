// How the call names its Hermes tasks to the model and the user: by what each is about
// ("Pennyworth wake word"), never by number, since a number is what the model then reads out
// ("task one is finished"). Also what a reply asks the user, whether the user's words answer a
// question, and whether the model's speech relayed a result. Names are display and reference
// only: Hermes still gets only the user's words.
//
// Port of Android's TaskNames.kt and TaskLabel.kt; test/taskNames.test.ts holds the cases.

import { lastOrNull, maxOrNull, single, sortByDescending, take, trimChars } from "./kt.ts";

export const MAX_NAME = 40;

const STOP = new Set([
  "a", "an", "the", "to", "of", "for", "in", "on", "at", "with", "from", "by", "about", "into", "and", "or", "but", "so",
  "me", "my", "i", "i'd", "i'm", "we", "our", "us", "you", "your", "it", "its", "it's", "this", "that", "these", "those", "there",
  "is", "are", "was", "be", "been", "am", "do", "does", "did", "can", "could", "would", "will", "should", "shall", "may", "might",
  "what", "what's", "how", "when", "where", "which", "who", "why", "whether", "if", "many", "much", "some", "any", "something",
  "please", "just", "also", "now", "right", "separately", "then", "really", "quite", "very", "one", "more", "thing", "things",
  "think", "find", "out", "look", "up", "tell", "check", "get", "give", "show", "make", "let", "let's", "see", "know", "want",
  "like", "need", "use", "using", "new", "different", "another", "better", "good", "nice", "currently", "current", "still",
  "hermes", "okay", "ok", "yeah", "yes", "no", "hey", "um", "uh", "oh", "well", "actually", "maybe", "because", "them", "they", "their", "then", "than",
]);
/** Words between two named words that read better kept ("weather in Copenhagen", "book a table"). */
const JOINS = new Set(["in", "on", "for", "with", "from", "of", "to", "a", "an", "the"]);

function words(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}']+/u).map((w) => trimChars(w, "'")).filter((w) => w.length > 0);
}

/** Distinctive words: a few letters long and not filler. */
function distinctive(text: string): Set<string> {
  return new Set(words(text).filter((w) => w.length >= 4 && !STOP.has(w)));
}

/** Whether [said] names the task: it shares a distinctive word with its [label] or its [request]. */
export function mentions(said: string, label: string, request: string): boolean {
  const of = new Set([...distinctive(label), ...distinctive(request)]);
  for (const w of distinctive(said)) if (of.has(w)) return true;
  return false;
}

function minus(a: Set<string>, ...others: Set<string>[]): Set<string> {
  const out = new Set<string>();
  for (const w of a) if (!others.some((o) => o.has(w))) out.add(w);
  return out;
}

function substringBeforeLast(text: string, delimiter: string): string {
  const i = text.lastIndexOf(delimiter);
  return i < 0 ? text : text.slice(0, i);
}

function lowerFirst(text: string): string {
  return text.length === 0 ? text : text[0].toLowerCase() + text.slice(1);
}

/** A name the user's own words give a task when the model gave none: up to three words of what was asked, from its first clause. */
export function fromRequest(request: string): string {
  const said = shortLabel(request);
  const clauses = said.split(/[.?!;:]|,\s+(?:because|since|so|and|but)\b/);
  const clause = clauses.find((c) => words(c).some((w) => !STOP.has(w))) ?? said;
  const all = clause.split(/\s+/).map((w) => trimChars(w, ",\"'()")).filter((w) => w.length > 0);
  const picked: string[] = [];
  let named = 0;
  for (const w of all) {
    const lower = w.toLowerCase();
    if (!STOP.has(lower)) { picked.push(w); named++; }
    else if (JOINS.has(lower) && named > 0) picked.push(lower);
    if (named === 3) break;
  }
  while (picked.length > 0 && STOP.has(picked[picked.length - 1].toLowerCase())) picked.pop();
  let name = picked.join(" ");
  if (name.length === 0) name = said.split(/\s+/).slice(0, 3).join(" ");
  return tidy(lowerFirst(name)) ?? "request";
}

/**
 * A name the model proposed, made safe to show and quote: letters, digits, spaces and a little
 * punctuation, no "task 2" of its own; null when nothing usable is left.
 */
export function tidy(name: string | null | undefined): string | null {
  if (name == null) return null;
  let text = name.replace(/[^\p{L}\p{N} '&+-]/gu, " ").replace(/\s+/g, " ").trim();
  text = text.replace(/^(?:the\s+)?(?:task|session)\b\s*(?:\d+|one|two|three|four|five)?\b\s*/i, "")
    .replace(/\s+(?:task|session)$/i, "").trim();
  if (text.length === 0 || /^[\p{Nd} ]*$/u.test(text)) return null;
  if (text.length > MAX_NAME) text = substringBeforeLast(take(text, MAX_NAME), " ") || take(text, MAX_NAME);
  return text;
}

/** How a repeat of a name is told apart when the request has no other word. */
const AGAIN = ["again", "once more", "yet again", "anew", "afresh", "encore", "reprise", "redux"];

/**
 * [given], or if another task already has it, told apart by another word of [request] or "again",
 * cut to leave room for that so the result is still unique within MAX_NAME.
 */
export function unique(given: string, request: string, taken: Iterable<string>): string {
  // A name that tidies to something else would fail every check below: settle it first.
  let name = given;
  for (let i = 0; i < 4; i++) name = tidy(name) ?? "request";
  const used = new Set([...taken].map((t) => t.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  const withSuffix = (suffix: string): string | null => {
    const room = MAX_NAME - suffix.length - 1;
    if (room < 3) return null;
    const base = name.length <= room ? name : substringBeforeLast(take(name, room), " ") || take(name, room);
    const candidate = `${base} ${suffix}`;
    return tidy(candidate) === candidate && !used.has(candidate.toLowerCase()) ? candidate : null;
  };
  const have = new Set(words(name));
  for (const w of words(shortLabel(request))) {
    if (STOP.has(w) || have.has(w) || w.length > 20) continue;
    const found = withSuffix(w);
    if (found) return found;
  }
  for (const suffix of AGAIN) {
    const found = withSuffix(suffix);
    if (found) return found;
  }
  // Past those, a letter or two: never a number, which the model would read out.
  for (let n = 0; n < 26 * 27; n++) {
    let tag = "";
    let k = n;
    do { tag = String.fromCharCode(97 + (k % 26)) + tag; k = Math.floor(k / 26) - 1; } while (k >= 0);
    const found = withSuffix(`again ${tag}`);
    if (found) return found;
  }
  return name;
}

/** [text] lowercased, without quotes or full stops, keeping apostrophes inside words ("sarah's"). */
function norm(text: string): string {
  return text.toLowerCase().replace(/’/g, "'").replace(/["“”`.]/g, " ")
    .replace(/(?<![\p{L}\p{N}])'|'(?![\p{L}\p{N}])/gu, " ").replace(/\s+/g, " ").trim();
}

/** [text]'s words, normalised, without possessives. */
function bare(text: string): string[] {
  return norm(text).split(" ").filter((w) => w.length > 0).map((w) => (w.endsWith("'s") ? w.slice(0, -2) : w));
}

function sameWords(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((w, i) => w === b[i]);
}

/** A normalised reference with less and less around it, least trimmed first. */
function forms(whole: string): string[] {
  const noThe = (whole.startsWith("the ") ? whole.slice(4) : whole).trim();
  const core = (noThe.endsWith(" task") ? noThe.slice(0, -5) : noThe).trim();
  const noTask = (whole.endsWith(" task") ? whole.slice(0, -5) : whole).trim();
  const noOne = (core.endsWith(" one") ? core.slice(0, -4) : core).trim();
  const out: string[] = [];
  for (const f of [whole, noThe, noTask, core, noOne]) if (f.length > 0 && !out.includes(f)) out.push(f);
  return out.length > 0 ? out : [whole];
}

/** Keys whose task name matches [ref] exactly (or word-for-word after trimming "the"/"task"/"one"). */
export function exactMatches(ref: string, tasks: Map<string, [string, string]>): string[] {
  const whole = norm(ref);
  if (whole.length === 0) return [];
  const entries = [...tasks.entries()];
  for (const r of forms(whole)) {
    const exact = entries.filter(([, v]) => norm(v[0]) === r).map(([k]) => k);
    if (exact.length > 0) return exact;
    const b = bare(r);
    const loose = entries.filter(([, v]) => sameWords(bare(v[0]), b)).map(([k]) => k);
    if (loose.length > 0) return loose;
  }
  return [];
}

/**
 * The task the model means by [ref] among (name, request) pairs by key: its name, more or less
 * as given, or the one whose name and request share the most distinctive words with it.
 * Null when none fits or two fit equally.
 */
export function find(ref: string, tasks: Map<string, [string, string]>): string | null {
  const whole = norm(ref);
  if (whole.length === 0) return null;
  const exact = exactMatches(ref, tasks);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const entries = [...tasks.entries()];
  const all = forms(whole);
  const r = all[all.length - 1];
  if (r.length === 0) return null;
  const said = bare(r);
  const within: [string, number][] = [];
  for (const [key, v] of entries) {
    const name = bare(v[0]);
    if (name.length === 0) continue;
    const containsAll = (a: string[], b: string[]) => b.every((w) => a.includes(w));
    if (!(containsAll(said, name) || containsAll(name, said))) continue;
    within.push([key, name.filter((w) => said.includes(w)).length]);
  }
  const most = maxOrNull(within.map((w) => w[1]));
  const best = single(within.filter((w) => w[1] === most));
  if (best) return best[0];
  const wanted = distinctive(r);
  if (wanted.size === 0) return null;
  const scored = sortByDescending(
    entries.map(([key, v]): [string, number] => [
      key,
      [...distinctive(v[0])].filter((w) => wanted.has(w)).length * 2 + [...distinctive(v[1])].filter((w) => wanted.has(w)).length,
    ]).filter((s) => s[1] > 0),
    (s) => s[1],
  );
  if (scored.length === 0 || (scored.length > 1 && scored[0][1] === scored[1][1])) return null;
  return scored[0][0];
}

/** The reply's spoken summary: what comes before its first blank line. */
function summaryOf(reply: string): string {
  return reply.trim().split(/\n\s*\n/)[0] ?? "";
}

/**
 * What [reply] asks the user, if anything: the last question in its spoken summary (Hermes
 * gives one first, then any detail after a blank line), or null.
 */
export function question(reply: string): string | null {
  const summary = summaryOf(reply).trim();
  const sentences = summary.split(/(?<=[.?!])\s+/).map((s) => s.trim()).filter((s) => s.length > 0);
  const asked = lastOrNull(sentences.filter((s) => s.endsWith("?")));
  if (asked == null) return null;
  return asked.length > 200 ? substringBeforeLast(take(asked, 200), " ") + "…?" : asked;
}

/** Openers that answer whatever follows them. */
const ANSWER = /^(?:yes|yeah|yep|yup|yea|no|nope|nah|please do|go ahead|go for it|do it|do that|let's do (?:it|that)|start it|sounds good)\b/i;
/** Openers that also start plenty of requests ("Okay, so…"): an answer only in a short reply. */
const SHORT_ANSWER = /^(?:ok(?:ay)?|sure|fine|correct|right|absolutely|definitely|that's fine|that works|let's go|the (?:first|second|third|last) one|neither|both)\b/i;
const SEPARATE = /\b(?:separately|also|another|as well|a new|different thing|something else)\b/i;
const CLEARLY_SEPARATE = /\b(?:separately|also|as well|something else|different thing)\b/i;

/**
 * The user's words are an answer to a question ("Yes, …", "Go ahead", "No", a short "Okay"), not a
 * request of their own: not when they say it's separate ("Okay, separately, find me a taxi").
 */
export function isAnswer(said: string): boolean {
  const text = said.trim().replace(/^["' ]+/, "");
  if (ANSWER.test(text)) return !CLEARLY_SEPARATE.test(text);
  return SHORT_ANSWER.test(text) && words(text).length <= 5 && !SEPARATE.test(text);
}

const QUESTION_CUE = /\?|\b(?:shall i|should i|want me to|do you want|would you like|ok(?:ay)? to)\b/i;

/**
 * The model's [speech] asks [q], from the reply [result] of the task [name] asked as [request]:
 * it says one of the question's own words, those not already in the rest of the reply, the name or
 * the request. With none of its own, a question cue has to be said in a sentence with one of the question's words.
 */
export function says(speech: string, q: string, result = "", name = "", request = ""): boolean {
  const rest = summaryOf(result).split(q).join(" ");
  const asked = distinctive(q);
  const own = minus(asked, distinctive(rest), distinctive(name), distinctive(request));
  if (own.size > 0) return [...distinctive(speech)].some((w) => own.has(w));
  if (asked.size === 0) return false;
  return speech.split(/(?<=[.?!])\s+/).some((s) => QUESTION_CUE.test(s) && [...distinctive(s)].some((w) => asked.has(w)));
}

/**
 * The model's [speech] relays the result [result] of the task [name], asked as [request]: it says
 * three of the reply's distinctive words besides those of the task's name and request (all of
 * them for a reply with two).
 */
export function relays(speech: string, name: string, result: string, request = ""): boolean {
  const said = distinctive(speech);
  if (said.size === 0) return false;
  const summary = summaryOf(result).split(/\s+/).slice(0, 80).join(" ");
  const reply = minus(distinctive(summary), distinctive(name), distinctive(request));
  if (reply.size < 2) return false;
  return [...reply].filter((w) => said.has(w)).length >= Math.min(3, reply.size);
}

// TaskLabel.kt

const OPENER = /^(?:now|ok(?:ay)?|so|and|also|then|hey|right|alright|um+|uh+)\b[\s,.!]*/i;
const PLEASE = /^please\b[\s,]*/i;
const FILLERS = [
  /^(?:can|could|would|will) you\s+(?:please\s+)?(?:(?:ask|get|have)\s+hermes\s+(?:to\s+|about(?:\s+|$))?|(?:tell|let)\s+hermes\s+to\s+)/i,
  /^(?:(?:ask|get|have)\s+hermes\s+(?:to\s+|about(?:\s+|$))?|(?:tell|let)\s+hermes\s+to\s+)/i,
  /^i(?:'d| would)? (?:like|want|need)\s+hermes\s+to\s+/i,
  /^(?:can|could|would|will) hermes\s+(?:please\s+)?/i,
  /^hermes\s*,\s*/i,
  /^hermes\s+(?:(?:can|could|would|will) you\s+|(?=please\b))/i,
  /^(?:can|could|would|will) you\s+(?:please\s+)?/i,
];
const TRAILING = /[\s,]*(?:,?\s*please)?[\s?.!]*$/i;

/** [request] without the filler before what was asked ("Ask Hermes to …"), capitalised; as said if nothing's left. */
export function shortLabel(request: string): string {
  const said = request.replace(/\s+/g, " ").trim();
  let text = said;
  for (;;) {
    const before = text;
    for (const r of [OPENER, PLEASE, ...FILLERS]) text = text.replace(r, "").replace(/^\s+/, "");
    if (text === before) break;
  }
  text = text.replace(TRAILING, "");
  if (text.length === 0) return said;
  return text[0].toUpperCase() + text.slice(1);
}
