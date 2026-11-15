// attention "window": the model hears the microphone only for a while after something that makes
// the user's next words likely to be for it; otherwise the call is dormant until the wake word.

import assert from "node:assert/strict";
import { test } from "node:test";
import { taskResult } from "../src/protocol.ts";
import type { Command } from "../src/types.ts";
import { Sim } from "./sim.ts";

const fast = { settleQuiet: 0.1, settleMax: 1.5, tick: 0.05, wakePreRoll: 0.5 };
/** Every length different, so a test can tell which one closed the window. */
const win = { mode: "window", afterWake: 2, window: 1.5, afterQuestion: 3, afterHandOff: 0, afterAnnouncement: 1 };
const host = { by: "host", engaged: 6, lull: 3, attach: 0.4, briefWait: 2, maxWait: 8, maxWords: 28 };

function sim(config: Record<string, any> = {}) {
  const { attention, limits, ...rest } = config;
  const s = new Sim({ config: { ...rest, limits: { ...fast, ...limits }, attention: { ...win, ...attention } } as any });
  s.advance(0.1);
  return s;
}

const status = (s: Sim) => s.statuses().at(-1);
const dormant = (s: Sim) => status(s) === "dormant";
const wakewords = (s: Sim) => s.commands.flatMap((c) => (c.type === "wakeword" ? [c.on] : []));
/** Microphone audio the model got (on [sid], or any socket). */
const audio = (s: Sim, sid?: number) => s.sent(sid).filter((f) => f.startsWith('{"realtimeInput":{"audio"'));
const audioIn = (out: Command[]) => out.filter((c) => c.type === "ws.send" && c.data.startsWith('{"realtimeInput":{"audio"')).length;
const streamEnds = (s: Sim) => s.sent().filter((f) => f.includes("audioStreamEnd")).length;
const plays = (s: Sim, source?: "announcer") => s.commands.filter((c) => c.type === "play" && c.source === source).length;

function until(s: Sim, pred: () => boolean, max = 30, step = 0.05): number | null {
  const end = s.t + max;
  while (s.t < end - 1e-9) {
    if (pred()) return s.t;
    s.advance(step);
  }
  return pred() ? s.t : null;
}

function near(actual: number | null, expected: number, slack = 0.08, what = "time") {
  assert.ok(actual != null && Math.abs(actual - expected) <= slack, `${what}: expected about ${expected}, got ${actual}`);
}

/** A call that has gone dormant at the end of its first window. */
function asleep(config: Record<string, any> = {}) {
  const s = sim(config);
  // A dormant call may stand by within the same tick: dormant is in its history, if not its status now.
  assert.ok(until(s, () => s.statuses().includes("dormant"), 5) != null, "dormant at the end of the first window");
  return s;
}

/** The user says [words] and the model answers with [seconds] of speech; returns when that speech ends. */
function exchange(s: Sim, words: string, reply: string, seconds = 1): number {
  s.turn(words);
  s.said(reply);
  s.audio(Math.round(seconds * 24_000) * 2);
  s.generated();
  s.turnComplete();
  return s.t + seconds;
}

// Windows.

test("the call listens for afterWake seconds after it starts, then goes dormant", () => {
  const s = sim();
  near(until(s, () => dormant(s), 5), 2);
  assert.deepEqual(s.statuses(), ["connecting", "listening", "dormant"]);
  assert.deepEqual(wakewords(s), [true], "the host listens for its wake word");
  assert.equal(streamEnds(s), 1, "the model is told the stream paused");
  assert.ok(s.sent(1).at(-1)!.includes("audioStreamEnd"));
  const before = audio(s).length;
  s.advance(1);
  assert.equal(audio(s).length, before, "dormant, the microphone isn't sent");
});

test("the wake word sends the pre-roll, reopens the microphone for afterWake, and turns the wake word off", () => {
  const s = asleep();
  s.mic = "loud";
  s.advance(1);
  const out = s.push({ type: "wake" });
  // The last wakePreRoll (0.5 s) of 20 ms frames, at once.
  assert.equal(audioIn(out), 25);
  assert.equal(status(s), "listening");
  assert.deepEqual(wakewords(s), [true, false]);
  const woke = s.t;
  const before = audio(s).length;
  s.advance(0.5);
  assert.ok(audio(s).length - before >= 24, "the microphone flows again");
  near(until(s, () => dormant(s), 5), woke + 2, 0.08, "afterWake");
  assert.deepEqual(wakewords(s), [true, false, true]);
});

test("resume while dormant wakes the call like the wake word", () => {
  const s = asleep();
  s.advance(1);
  const out = s.push({ type: "resume" });
  assert.equal(audioIn(out), 25);
  assert.equal(status(s), "listening");
  assert.deepEqual(wakewords(s), [true, false]);
});

test("a spoken reply leaves `window` seconds after it has played", () => {
  const s = sim();
  const ends = exchange(s, "What's the time?", "It's three o'clock.", 3);
  // Three seconds of reply arrive at once: the window runs from when it has played.
  near(until(s, () => dormant(s), 10), ends + 1.5, 0.08, "window");
});

test("a reply that asks the user something leaves afterQuestion", () => {
  const s = sim();
  const ends = exchange(s, "Set a timer", "For how long should I set it?");
  near(until(s, () => dormant(s), 10), ends + 3, 0.08, "afterQuestion");
});

test("a silent hand-off leaves afterHandOff", () => {
  const s = sim({ attention: { afterHandOff: 0.5 } });
  s.turn("Book a table");
  s.toolCall("c1");
  // Without the hand-off afterWake would hold it to 2.0; with it, only the model's settleMax after the turn does.
  near(until(s, () => dormant(s), 5), 0.1 + 1.5, 0.08, "afterHandOff");
  assert.equal(s.hermes().length, 1);
});

test("a hand-off the model also spoke leaves the reply's window",
  { todo: "delegate() sets afterHandOff for every hand-off (call.ts:1589), cutting the window a spoken reply just opened" }, () => {
    const s = sim({ attention: { afterHandOff: 0 } });
    s.turn("Book a table");
    s.said("I'll get Hermes on it.");
    s.audio(48_000);
    const ends = s.t + 1;
    s.toolCall("c1");
    s.generated();
    s.turnComplete();
    near(until(s, () => dormant(s), 10), ends + 1.5, 0.08, "window after the spoken reply");
  });

test("speech that began inside a window is heard to its end and answered", () => {
  const s = sim();
  s.advance(1.8);
  s.mic = "loud";
  s.activity("ACTIVITY_START");
  s.heard("So what I'd like you to do is");
  const before = audio(s).length;
  s.advance(3); // well past the window's end at 2.0
  assert.equal(status(s), "listening");
  assert.ok(audio(s).length - before >= 148, "the whole utterance is sent");
  s.activity("ACTIVITY_END");
  s.mic = "quiet";
  s.advance(1);
  assert.equal(status(s), "listening", "the model owes a reply");
  s.said("Sure.");
  s.audio(24_000);
  s.turnComplete();
  const ends = s.t + 0.5;
  near(until(s, () => dormant(s), 5), ends + 1.5, 0.08, "window after the answer");
});

test("speech that began just before the window closed, which the model's VAD reports late, is still heard",
  { todo: "attend() (call.ts:554) only knows the user is talking from ACTIVITY_START; it ignores the microphone's level, so a VAD delay truncates the utterance" }, () => {
    const s = sim();
    s.advance(1.7);
    s.mic = "loud"; // the user starts at 1.8, inside the window
    s.advance(0.4);
    s.activity("ACTIVITY_START"); // Gemini's VAD says so at 2.2
    const before = audio(s).length;
    s.advance(1);
    assert.equal(status(s), "listening");
    assert.ok(audio(s).length - before >= 48);
  });

// Dormant.

test("typed text wakes a dormant call", () => {
  const s = asleep();
  s.push({ type: "say", text: "What's the weather?" });
  assert.deepEqual(wakewords(s), [true, false]);
  const before = audio(s).length;
  s.advance(0.5);
  assert.ok(audio(s).length - before >= 24, "the microphone flows again");
});

test("typed text that wakes a dormant call says so in the status",
  { todo: "typed() clears dormant (call.ts:1486) without settled(), so the host's status stays \"dormant\"" }, () => {
    const s = asleep();
    s.push({ type: "say", text: "What's the weather?" });
    s.advance(0.1);
    assert.equal(status(s), "listening");
  });

test("a dormant call stands by with nothing running, and the wake word brings it back with the pre-roll", () => {
  const s = asleep({ standbyAfter: 0.5 });
  assert.ok(until(s, () => status(s) === "standby", 2) != null);
  assert.ok(s.sockets.get(1)!.closed);
  s.mic = "loud";
  s.advance(2); // a television: loud, but not the wake word
  assert.equal(status(s), "standby", "loudness doesn't bring a dormant call back");
  assert.equal(s.sockets.size, 1);
  s.push({ type: "wake" });
  s.advance(0.1);
  assert.equal(s.sockets.size, 2);
  assert.equal(status(s), "listening");
  assert.ok(audio(s, 2).length >= 25, "the pre-roll goes to the new session");
  assert.deepEqual(wakewords(s), [true, false]);
});

test("typed text brings a dormant call back from standby", () => {
  const s = asleep({ standbyAfter: 0.5 });
  until(s, () => status(s) === "standby", 2);
  s.push({ type: "say", text: "What's the weather?" });
  s.advance(0.1);
  assert.equal(s.sockets.size, 2);
  assert.equal(status(s), "listening");
  assert.ok(s.sent(2).some((f) => f.includes("What's the weather?")));
});

test("a call that stood by while its window was open goes dormant when the window ends",
  { todo: "attend() returns on standby (call.ts:553) before the dormant check, so the call stays a non-dormant standby: no wake word, and loudness brings it back" }, () => {
    const s = sim({ standbyAfter: 1 });
    s.turn("Book a table");
    s.toolCall("c1");
    s.said("Anything else while Hermes books it?");
    s.audio(24_000);
    s.generated();
    s.turnComplete();
    const ends = s.t + 0.5;
    assert.ok(until(s, () => status(s) === "standby", 5) != null);
    until(s, () => s.t >= ends + 3 + 0.2, 10); // afterQuestion has run out
    assert.deepEqual(wakewords(s), [true], "listening for the wake word");
    s.mic = "loud";
    s.advance(2);
    assert.equal(s.sockets.size, 1, "a television doesn't bring it back");
  });

test("a dormant call hangs up from standby after hangUpAfter", () => {
  const s = asleep({ standbyAfter: 0.5, hangUpAfter: 3 });
  until(s, () => status(s) === "standby", 2);
  near(until(s, () => s.ended() != null, 5), 3, 0.08, "hangUpAfter since the call started");
  assert.equal(s.ended()!.message, null);
  assert.deepEqual(wakewords(s), [true, false], "the wake word goes off with the call");
});

test("a dormant call with a task running doesn't hang up", () => {
  const s = sim({ hangUpAfter: 1 });
  s.turn("Book a table");
  s.toolCall("c1");
  assert.ok(until(s, () => dormant(s), 5) != null);
  s.advance(5);
  assert.equal(s.ended(), undefined);
});

test("the call ending while dormant turns the wake word off", () => {
  const s = asleep();
  s.push({ type: "stop" });
  assert.deepEqual(wakewords(s), [true, false]);
});

// Results told to a dormant call.

test("a result the announcer tells a dormant call leaves afterAnnouncement", () => {
  const s = sim({ announce: host });
  s.turn("Book a table");
  s.toolCall("c1");
  assert.ok(until(s, () => dormant(s), 5) != null);
  s.advance(5);
  s.complete("Booked for 8pm.");
  s.push({ type: "brief.ready", id: "b1", text: "Your table is booked.", pcm: Buffer.alloc(48_000, 1).toString("base64") });
  const started = until(s, () => plays(s, "announcer") > 0, 5)!;
  assert.ok(dormant(s), "it plays without waking the call");
  const before = audio(s).length;
  s.advance(0.9);
  assert.equal(audio(s).length, before, "nothing is sent while it plays");
  near(until(s, () => status(s) === "listening", 2), started + 1, 0.08, "listening once it has played");
  assert.deepEqual(wakewords(s), [true, false]);
  near(until(s, () => dormant(s), 5), started + 1 + 1, 0.08, "afterAnnouncement");
});

test("an announced question reopens the microphone for afterQuestion", () => {
  const s = sim({ announce: host });
  s.turn("Find a taxi");
  s.toolCall("c1");
  assert.ok(until(s, () => dormant(s), 5) != null);
  s.advance(5);
  s.complete("There are two taxis. Shall I book the 8pm one?");
  s.push({ type: "brief.ready", id: "b1", text: "Two taxis; shall I book the 8pm one?", pcm: Buffer.alloc(48_000, 1).toString("base64") });
  const started = until(s, () => plays(s, "announcer") > 0, 5)!;
  near(until(s, () => status(s) === "listening", 2), started + 1);
  near(until(s, () => dormant(s), 5), started + 1 + 3, 0.08, "afterQuestion");
});

test("with afterAnnouncement 0 a result told to a dormant call leaves it dormant", () => {
  const s = sim({ announce: host, attention: { afterAnnouncement: 0 } });
  s.turn("Book a table");
  s.toolCall("c1");
  assert.ok(until(s, () => dormant(s), 5) != null);
  s.advance(5);
  s.complete("Booked for 8pm.");
  s.push({ type: "brief.ready", id: "b1", text: "Your table is booked.", pcm: Buffer.alloc(48_000, 1).toString("base64") });
  assert.ok(until(s, () => plays(s, "announcer") > 0, 5) != null);
  s.advance(3);
  assert.ok(!s.statuses().slice(s.statuses().lastIndexOf("dormant")).includes("listening"));
  assert.deepEqual(wakewords(s), [true]);
});

test("a dormant call in standby tells its last result without the model, then the wake word brings the model back with a note", () => {
  // standbyAfter longer than the model's settleMax, so the call is dormant before it stands by.
  const s = sim({ announce: host, standbyAfter: 3, attention: { afterAnnouncement: 0 } });
  s.turn("Book a table");
  s.toolCall("c1");
  assert.ok(until(s, () => status(s) === "standby", 5) != null);
  assert.ok(s.statuses().includes("dormant"));
  s.advance(5);
  s.complete("Booked for 8pm.");
  s.push({ type: "brief.ready", id: "b1", text: "Your table is booked.", pcm: Buffer.alloc(48_000, 1).toString("base64") });
  assert.ok(until(s, () => plays(s, "announcer") > 0, 5) != null);
  s.advance(2);
  assert.equal(s.sockets.size, 1, "no session for it");
  assert.equal(status(s), "standby");
  s.push({ type: "wake" });
  s.advance(0.1);
  assert.ok(s.sent(2).some((f) => f.includes("while this call was paused Bento told the user these results aloud")));
});

test("a result the model tells a dormant call (announce \"model\") leaves afterAnnouncement", () => {
  const s = sim();
  s.turn("Book a table");
  s.toolCall("c1");
  assert.ok(until(s, () => dormant(s), 5) != null);
  s.advance(5);
  s.complete("Booked for 8pm.");
  s.advance(0.5);
  assert.equal(s.finals()[0]?.response.message, taskResult("book a table", "Booked for 8pm."), "it goes to the model while dormant");
  s.said("Your table is booked for 8pm.");
  s.audio(48_000);
  const ends = s.t + 1;
  s.generated();
  s.turnComplete();
  assert.ok(dormant(s));
  near(until(s, () => status(s) === "listening", 2), ends, 0.08, "listening once it has played");
  near(until(s, () => dormant(s), 5), ends + 1, 0.08, "afterAnnouncement");
});

test("a result with a question the model tells a dormant call leaves afterQuestion",
  { todo: "turnComplete opens afterQuestion only when not dormant (call.ts:1207); speaking() gave it afterAnnouncement" }, () => {
    const s = sim();
    s.turn("Find a taxi");
    s.toolCall("c1");
    assert.ok(until(s, () => dormant(s), 5) != null);
    s.advance(5);
    s.complete("There are two taxis. Shall I book the 8pm one?");
    s.advance(0.5);
    s.said("There are two taxis. Shall I book the 8pm one?");
    s.audio(48_000);
    const ends = s.t + 1;
    s.generated();
    s.turnComplete();
    near(until(s, () => status(s) === "listening", 2), ends, 0.08, "listening once it has played");
    near(until(s, () => dormant(s), 10), ends + 3, 0.08, "afterQuestion");
  });

test("the wake word over a result the model tells a dormant call cuts it and listens", () => {
  const s = sim();
  s.turn("Book a table");
  s.toolCall("c1");
  assert.ok(until(s, () => dormant(s), 5) != null);
  s.advance(5);
  s.complete("Booked for 8pm.");
  s.advance(0.5);
  s.audio(48_000 * 3);
  s.advance(0.5);
  s.push({ type: "wake" });
  assert.ok(s.commands.some((c) => c.type === "flush"));
  assert.equal(status(s), "listening");
  const playsBefore = plays(s);
  s.audio(4_800);
  assert.equal(plays(s), playsBefore, "the rest of its turn isn't played");
});

// whileSpeaking "wake" in a windowed call.

test("with whileSpeaking wake the wake word is on over a reply, off after it, and on again when dormant", () => {
  const s = sim({ mic: { whileSpeaking: "wake", gainDb: 0 } });
  s.mic = "loud";
  const ends = exchange(s, "What's the time?", "It's three o'clock.");
  s.advance(0.1);
  assert.deepEqual(wakewords(s), [true], "on over the reply");
  const last = JSON.parse(s.sent(1).at(-1)!).realtimeInput.audio.data;
  assert.ok(Buffer.from(last, "base64").every((b: number) => b === 0), "silence over the reply");
  until(s, () => s.t >= ends + 0.1, 2);
  assert.deepEqual(wakewords(s), [true, false], "off once it has played: the window is open");
  near(until(s, () => dormant(s), 5), ends + 1.5);
  assert.deepEqual(wakewords(s), [true, false, true]);
});

test("with whileSpeaking wake the wake word over a reply in an open window cuts it, and the call stays awake", () => {
  const s = sim({ mic: { whileSpeaking: "wake", gainDb: 0 } });
  s.turn("Tell me a story");
  s.audio(48_000 * 3);
  s.advance(0.5);
  s.push({ type: "wake" });
  assert.ok(s.commands.some((c) => c.type === "flush"));
  assert.deepEqual(wakewords(s), [true, false]);
  assert.equal(status(s), "listening");
});

// Mode "open".

test("in mode open nothing changes: no dormancy, no wake word, the microphone always flows", () => {
  const s = sim({ attention: { mode: "open" }, mic: { whileSpeaking: "send", gainDb: 0 } });
  s.advance(20);
  exchange(s, "What's the time?", "It's three.");
  s.advance(20);
  assert.ok(!s.statuses().includes("dormant"));
  assert.equal(wakewords(s).length, 0);
  assert.equal(streamEnds(s), 0);
  const before = audio(s).length;
  s.advance(1);
  assert.equal(audio(s).length - before, 50);
});

test("in mode open loud speech still brings a call back from standby, and a call with nothing running never stands by", () => {
  const idle = sim({ attention: { mode: "open" }, standbyAfter: 0.5 });
  idle.advance(5);
  assert.ok(!idle.statuses().includes("standby"));
  const s = sim({ attention: { mode: "open" }, standbyAfter: 0.5 });
  s.turn("Book a table");
  s.toolCall("c1");
  assert.ok(until(s, () => status(s) === "standby", 3) != null);
  s.mic = "loud";
  s.advance(0.6);
  assert.equal(s.sockets.size, 2);
  assert.equal(status(s), "working");
});
