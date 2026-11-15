// announce.by "host": the core asks the host for a brief of each result and plays it itself, at a
// moment that fits, and tells the model what was said. Times are on the sim's virtual clock.

import assert from "node:assert/strict";
import { test } from "node:test";
import { fullResult, taskResult } from "../src/protocol.ts";
import { announcedNote, resultText } from "../src/setup.ts";
import type { Command } from "../src/types.ts";
import { Sim, turnText } from "./sim.ts";

const fast = { settleQuiet: 0.1, settleMax: 1.5, tick: 0.05 };
/** engaged above lull, as in the defaults, so the three timings can be told apart. */
const host = { by: "host", engaged: 6, lull: 3, attach: 0.4, briefWait: 2, maxWait: 8, maxWords: 28 };

function sim(config: Record<string, any> = {}) {
  const { announce, limits, ...rest } = config;
  const s = new Sim({ config: { ...rest, limits: { ...fast, ...limits }, announce: { ...host, ...announce } } as any });
  s.advance(0.1);
  return s;
}

/** A task the user asked for at t = 0.1, running by t = 0.4. */
function task(s: Sim, words = "Book a table", id = "c1") {
  s.turn(words);
  s.toolCall(id);
  s.advance(0.3);
}

/** PCM16 at 24 kHz: [seconds] of it, every byte [fill], so briefs can be told apart. */
function pcmOf(seconds: number, fill = 1): string {
  return Buffer.alloc(Math.round(seconds * 24_000) * 2, fill).toString("base64");
}

type Brief = Extract<Command, { type: "brief" }>;
const briefs = (s: Sim): Brief[] => s.commands.filter((c): c is Brief => c.type === "brief");
const plays = (out: Command[]) => out.filter((c) => c.type === "play" && c.source === "announcer");
const played = (s: Sim) => plays(s.commands);
const told = (s: Sim) => s.commands.flatMap((c) => (c.type === "transcript" && c.source === "announcer" ? [c.text] : []));
const notes = (s: Sim) => s.turns().filter((c) => c.turnComplete === false).map(turnText);
const flushes = (s: Sim) => s.commands.filter((c) => c.type === "flush").length;

/** The host's brief for the latest request (or [id]). */
function ready(s: Sim, text: string, seconds = 1, id?: string, fill = 1): Command[] {
  return s.push({ type: "brief.ready", id: id ?? briefs(s).at(-1)!.id, text, pcm: pcmOf(seconds, fill) });
}

/** Moves on in ticks until [pred] holds; the time it first did, or null within [max] seconds. */
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

/** A result in a quiet room: the user last spoke at 0.1, the result came at 6.4, its brief at 7.4 plays at once. */
function quietRoom(config: Record<string, any> = {}, seconds = 1, result = "Booked for 8pm at Dishoom.") {
  const s = sim({ ...config, announce: { lull: 60, ...config.announce } });
  task(s);
  s.advance(6);
  s.complete(result);
  s.advance(1);
  const out = ready(s, "Your table at Dishoom is booked for 8pm.", seconds);
  assert.equal(plays(out).length, 1, "a quiet room hears it at once");
  return s;
}

function checkTask(s: Sim, id: string, task = "book a table"): string {
  s.toolCall(id, "check_task", { task });
  s.advance(0.05);
  return s.responses().find((r) => r.id === id).response.message;
}

// The brief and where it goes.

test("each result asks the host for a brief instead of going to the model", () => {
  const s = sim();
  task(s);
  s.complete("Booked for 8pm at Dishoom.");
  s.advance(1.5); // within briefWait
  assert.deepEqual(briefs(s), [{
    type: "brief", id: "b1", label: "book a table", agent: "hermes", request: "Book a table", result: fullResult("Booked for 8pm at Dishoom."),
    question: null, failed: false, voice: s.config.voice, maxWords: 28,
  }]);
  assert.equal(s.finals().length, 0, "the model isn't given the result while the brief is being made");
  assert.equal(s.resultTurns().length, 0);
});

test("a failed task's brief says so, and a question goes with it", () => {
  const s = sim();
  task(s);
  s.push({ type: "tool.error", run: s.hermes()[0].run, message: "the site was down" });
  assert.equal(briefs(s)[0].failed, true);
  task(s, "Find a taxi", "c2");
  s.complete("There are two taxis. Shall I book the 8pm one?");
  assert.equal(briefs(s)[1].question, "Shall I book the 8pm one?");
  assert.equal(briefs(s)[1].failed, false);
});

test("in a quiet room the brief plays at once, and the model gets a SILENT response saying what was said", () => {
  const s = quietRoom();
  assert.deepEqual(told(s), ["Your table at Dishoom is booked for 8pm."]);
  const [started, note] = s.responses();
  assert.equal(started.response.status, "started");
  assert.equal(note.id, "c1");
  assert.equal(note.scheduling, "SILENT");
  assert.equal(note.response.status, "ok");
  assert.equal(note.response.message, announcedNote("book a table", "Your table at Dishoom is booked for 8pm.", "Booked for 8pm at Dishoom.", null));
  assert.equal(s.resultTurns().length, 0, "the model isn't asked to speak");
  s.advance(1.1);
  assert.ok(!checkTask(s, "k1").includes("hasn't heard"), "played to the end, it has been heard");
});

test("on Vertex the model learns what was said from a note that doesn't ask it to speak", () => {
  const s = quietRoom({ api: "vertex" });
  assert.equal(s.responses().length, 1, "the call took its last response when the task started");
  assert.deepEqual(notes(s), [announcedNote("book a table", "Your table at Dishoom is booked for 8pm.", "Booked for 8pm at Dishoom.", null)]);
  assert.equal(s.resultTurns().length, 0);
});

test("a brief arriving with its result waits out the result's tone", () => {
  const s = sim({ announce: { lull: 60 } });
  task(s);
  s.advance(6);
  s.complete("Booked for 8pm.");
  const toneAt = s.t;
  assert.equal(plays(ready(s, "Booked for 8pm.")).length, 0);
  near(until(s, () => played(s).length > 0, 5), toneAt + 0.6);
});

// When it plays in a conversation.

/** A result whose brief is ready at 0.4, while the user is still engaged (they spoke at 0.1). */
function engaged(config: Record<string, any> = {}) {
  const s = sim(config);
  task(s);
  s.complete("Booked for 8pm.");
  ready(s, "Your table is booked for 8pm.");
  s.advance(0.7);
  assert.equal(played(s).length, 0, "not yet: the user is in a conversation and there's been no lull");
  return s;
}

test("in a conversation the brief follows the model's reply by attach seconds", () => {
  const s = engaged();
  s.turn("What's the time?");
  s.said("It's three o'clock.");
  s.audio(48_000); // a second of reply, ending at 2.1
  s.generated();
  s.turnComplete();
  const replyEnds = s.t + 1;
  near(until(s, () => played(s).length > 0, 10), replyEnds + 0.4);
});

test("a reply that asks the user something isn't followed: the brief waits for a lull", () => {
  const s = engaged();
  s.turn("Set a timer");
  s.said("For how long should I set it?");
  s.audio(48_000);
  s.generated();
  s.turnComplete();
  const replyEnds = s.t + 1;
  s.advance(1.5);
  assert.equal(played(s).length, 0, "not after a question");
  near(until(s, () => played(s).length > 0, 10), replyEnds + 3, 0.08, "lull after the question");
});

test("with no reply to follow, the brief waits for a lull of lull seconds", () => {
  const s = engaged();
  s.turn("Hmm, let me think");
  const spoke = s.t;
  near(until(s, () => played(s).length > 0, 10), spoke + 3);
});

test("the brief never starts while the model owes the user a reply", () => {
  const s = sim({ announce: { lull: 0.5 } });
  task(s);
  s.complete("Booked for 8pm.");
  s.advance(0.1);
  s.turn("And the weather?");
  ready(s, "Your table is booked.");
  const ended = s.t;
  // A lull of 0.5 s has passed long before the model's settleMax (1.5 s) is up.
  near(until(s, () => played(s).length > 0, 5), ended + 1.5);
});

test("the brief never starts while the user is speaking, however long it waits", () => {
  const s = engaged();
  s.activity("ACTIVITY_START");
  s.heard("So the thing about that is");
  s.advance(20); // well past maxWait
  assert.equal(played(s).length, 0);
  s.activity("ACTIVITY_END");
  assert.ok(until(s, () => played(s).length > 0, 10) != null, "it plays once they've finished");
});

test("nor while the model is speaking", () => {
  const s = sim({ announce: { lull: 60 } });
  task(s);
  s.advance(6);
  s.complete("Booked for 8pm.");
  s.advance(1);
  // Three seconds of the model's speech, sent at once: it plays for three seconds after its turn ends.
  s.audio(48_000 * 3);
  s.generated();
  s.turnComplete();
  const speechEnds = s.t + 3;
  ready(s, "Your table is booked.");
  const at = until(s, () => played(s).length > 0, 10);
  assert.ok(at != null && at >= speechEnds - 1e-6, `started at ${at}, before the model's speech ended at ${speechEnds}`);
});

test("a loud microphone holds the brief back, for maxWait at most", () => {
  const s = sim({ announce: { lull: 60 } });
  task(s);
  s.advance(6);
  s.complete("Booked for 8pm.");
  s.mic = "loud"; // a television: loud, but the model hears no speech in it
  s.advance(1);
  const out = ready(s, "Your table is booked.");
  assert.equal(plays(out).length, 0);
  const briefAt = s.t;
  near(until(s, () => played(s).length > 0, 15), briefAt + 8, 0.08, "maxWait");
});

// The user speaking over it.

test("cut within its first second, the brief goes again straight after the next reply", () => {
  const s = quietRoom({}, 3);
  s.advance(0.5);
  s.activity("ACTIVITY_START");
  assert.equal(flushes(s), 1, "what was left of it is dropped");
  assert.ok(notes(s).some((n) => n.includes("the user spoke over Bento and did not hear \"book a table\"'s outcome")));
  s.heard("What time is it?");
  s.advance(0.5);
  s.activity("ACTIVITY_END");
  s.said("It's three.");
  s.audio(48_000);
  s.turnComplete();
  const replyEnds = s.t + 1;
  near(until(s, () => played(s).length > 1, 10), replyEnds + 0.4);
});

test("cut later, the user chose to talk: it isn't attached to the next reply but waits for a longer lull", () => {
    const s = quietRoom({}, 3);
    s.advance(1.5);
    s.activity("ACTIVITY_START");
    s.heard("Hang on, what time is it?");
    s.advance(0.5);
    s.activity("ACTIVITY_END");
    s.said("It's three.");
    s.audio(48_000);
    s.turnComplete();
    const replyEnds = s.t + 1;
    s.advance(1.6);
    assert.equal(played(s).length, 1, "not attached to the reply after a deliberate cut");
    near(until(s, () => played(s).length > 1, 10), replyEnds + 3 * 2, 0.08, "lull doubled by one cut");
  });

test("cut later and no reply, it waits a lull that grows with each cut", () => {
  const s = quietRoom({ announce: { lull: 2.5 } }, 3);
  s.advance(1.5);
  s.turn("Hang on");
  const spoke = s.t;
  near(until(s, () => played(s).length > 1, 15), spoke + 2.5 * 2);
});

test("cut after 80% of it has played, it counts as heard and doesn't go again", () => {
  const s = quietRoom({}, 3);
  s.advance(2.5);
  s.activity("ACTIVITY_START");
  assert.ok(!notes(s).some((n) => n.includes("spoke over")), "the model isn't told it was missed");
  s.heard("Thanks");
  s.activity("ACTIVITY_END");
  s.advance(20);
  assert.equal(played(s).length, 1);
  assert.ok(!checkTask(s, "k1").includes("hasn't heard"));
});

test("the stop button over a brief drops it, and check_task still has the result", () => {
  const s = quietRoom({}, 3);
  s.advance(0.5);
  s.push({ type: "interrupt" });
  assert.equal(flushes(s), 1);
  s.advance(30);
  assert.equal(played(s).length, 1, "not said again");
  assert.equal(s.resultTurns().length, 0, "nor handed to the model");
  const message = checkTask(s, "k1");
  assert.ok(message.includes("Booked for 8pm at Dishoom."), message);
  assert.ok(!message.includes("hasn't heard"));
});

test("saying stop over a brief drops it, as the stop button does", () => {
    const s = quietRoom({}, 3);
    s.advance(0.5);
    s.activity("ACTIVITY_START");
    s.heard("Stop.");
    s.activity("ACTIVITY_END");
    assert.ok(s.commands.some((c) => c.type === "voiceCommand" && c.command === "stop"));
    s.turnComplete();
    s.advance(30);
    assert.equal(played(s).length, 1, "said again after the user told it to stop");
  });

// Falling back to the model.

test("a brief the host couldn't make goes to the model as before", () => {
  const s = sim();
  task(s);
  s.complete("Booked for 8pm.");
  s.push({ type: "brief.failed", id: "b1", message: "TTS quota" });
  s.advance(3);
  const [, result] = s.responses();
  assert.equal(result.id, "c1");
  assert.equal(result.scheduling, "WHEN_IDLE");
  assert.equal(result.response.message, taskResult("book a table", "Booked for 8pm."));
  ready(s, "Too late.", 1, "b1");
  s.advance(10);
  assert.equal(played(s).length, 0, "a brief after the failure is ignored");
});

test("a brief that takes longer than briefWait goes to the model, and the late brief is ignored", () => {
  const s = sim();
  task(s);
  s.complete("Booked for 8pm.");
  s.advance(1.9);
  assert.equal(s.finals().length, 0, "still within briefWait");
  s.advance(2);
  assert.equal(s.finals()[0]?.response.message, taskResult("book a table", "Booked for 8pm."));
  ready(s, "Your table is booked.", 1, "b1");
  s.advance(10);
  assert.equal(played(s).length, 0);
});

test("on Vertex a failed brief goes to the model as a result turn", () => {
  const s = sim({ api: "vertex" });
  task(s);
  s.complete("Booked for 8pm.");
  s.push({ type: "brief.failed", id: "b1" });
  s.advance(3);
  assert.equal(turnText(s.resultTurns()[0]), resultText([["book a table", "Booked for 8pm."]]));
});

test("a brief with bad audio or no words goes to the model instead", () => {
  const cases: [string, string, string][] = [
    ["not base64", "Booked.", "@@not base64@@"],
    ["no audio", "Booked.", ""],
    ["an odd number of bytes", "Booked.", Buffer.alloc(4801, 1).toString("base64")],
    ["more than a minute", "Booked.", Buffer.alloc(2_880_002, 1).toString("base64")],
    ["no words", "   ", pcmOf(1)],
  ];
  for (const [what, text, pcm] of cases) {
    const s = sim();
    task(s);
    s.complete("Booked for 8pm.");
    s.push({ type: "brief.ready", id: "b1", text, pcm });
    s.advance(3);
    assert.equal(played(s).length, 0, what);
    assert.equal(s.finals()[0]?.response.message, taskResult("book a table", "Booked for 8pm."), what);
  }
});

test("a brief for an unknown id, or a second one for the same result, is ignored", () => {
  const s = quietRoom();
  assert.equal(plays(ready(s, "Who's this?", 1, "b99")).length, 0);
  s.advance(1.1);
  assert.equal(plays(ready(s, "Again?", 1, "b1")).length, 0, "already heard");
  s.push({ type: "brief.failed", id: "b1" });
  s.advance(5);
  assert.equal(played(s).length, 1);
  assert.equal(s.finals().length, 1, "only the note: a late failure doesn't hand it to the model");
});

// Several results.

/** Two tasks, both finished in a quiet room, both briefs ready before either can play. */
function twoResults(second: string) {
  const s = sim({ announce: { lull: 60 } });
  task(s);
  task(s, "Find a taxi", "c2");
  s.advance(6.5);
  const [r1, r2] = s.hermes().map((h) => h.run);
  s.complete("Booked for 8pm.", r1);
  s.complete(second, r2);
  ready(s, "Your table is booked.", 1, "b1", 1);
  ready(s, "About the taxi.", 1, "b2", 2);
  assert.equal(played(s).length, 0, "the tone first");
  return s;
}

test("two results ready together are told back to back, in the order they finished", () => {
  const s = twoResults("A taxi comes at 8.");
  const first = until(s, () => played(s).length === 1, 5)!;
  const second = until(s, () => played(s).length === 2, 15);
  // The first ends a second after it starts; the next follows 0.3 s later, as one announcement.
  near(second, first + 1 + 0.3);
  assert.deepEqual(told(s), ["Your table is booked.", "About the taxi."]);
  assert.equal(flushes(s), 0, "the second doesn't cut the first");
});

test("a task's question is told last, so the user can answer it", () => {
  const s = twoResults("There are two taxis. Shall I book the 8pm one?");
  assert.equal(briefs(s)[1].question, "Shall I book the 8pm one?");
  assert.ok(until(s, () => played(s).length === 2, 15) != null);
  assert.deepEqual(told(s), ["Your table is booked.", "About the taxi."]);
  const note = s.responses().find((r) => r.id === "c2" && r.response.status === "ok");
  assert.ok(note.response.message.endsWith("\"taxi\" is waiting for the user's answer to: Shall I book the 8pm one? When they answer, call ask_hermes with continue_task \"taxi\"."));
});

test("a question is told last even when its task finished first", () => {
  const s = sim({ announce: { lull: 60 } });
  task(s);
  task(s, "Find a taxi", "c2");
  s.advance(6.5);
  const [r1, r2] = s.hermes().map((h) => h.run);
  s.complete("There are two taxis. Shall I book the 8pm one?", r2);
  s.complete("Booked for 8pm.", r1);
  ready(s, "About the taxi.", 1, "b1", 2);
  ready(s, "Your table is booked.", 1, "b2", 1);
  assert.ok(until(s, () => played(s).length === 2, 15) != null);
  assert.deepEqual(told(s), ["Your table is booked.", "About the taxi."]);
});

test("a question's brief leaves the floor to the user: a result ready after it waits for a lull", () => {
  const s = sim({ announce: { lull: 60 } });
  task(s);
  task(s, "Find a taxi", "c2");
  s.advance(6.5);
  const [r1, r2] = s.hermes().map((h) => h.run);
  s.complete("There are two taxis. Shall I book the 8pm one?", r2);
  s.advance(1);
  ready(s, "There are two taxis; shall I book the 8pm one?", 1, "b1");
  assert.equal(played(s).length, 1);
  s.complete("Booked for 8pm.", r1);
  ready(s, "Your table is booked.", 1, "b2");
  s.advance(5);
  assert.equal(played(s).length, 1, "nothing straight after a question");
});

// Standby.

test("in standby the brief plays without the model, and it hears what was said when the call comes back", () => {
  const s = sim({ standbyAfter: 0.5 });
  task(s);
  task(s, "Find a taxi", "c2");
  s.advance(1.5);
  assert.equal(s.statuses().at(-1), "standby");
  s.complete("Booked for 8pm.", s.hermes()[0].run);
  assert.ok(s.cues().includes("resultArrived"), "the result's tone sounds in standby");
  ready(s, "Your table is booked for 8pm.");
  assert.ok(until(s, () => played(s).length > 0, 5) != null);
  assert.equal(s.sockets.size, 1, "no new session for it");
  assert.equal(s.statuses().at(-1), "standby");
  s.advance(1.2);
  s.push({ type: "resume" });
  s.advance(0.3);
  assert.equal(s.sockets.size, 2);
  const away = notes(s).filter((n) => n.includes("while this call was paused Bento told the user these results aloud"));
  assert.equal(away.length, 1);
  assert.ok(away[0].endsWith("\n\"book a table\": Your table is booked for 8pm."));
  assert.equal(s.resultTurns().length, 0, "the model isn't asked to say it again");
});

test("the last task finishing in standby brings the call back, and the brief's note goes as a turn", () => {
  const s = sim({ standbyAfter: 0.5 });
  task(s);
  s.advance(1.5);
  assert.equal(s.statuses().at(-1), "standby");
  s.complete("Booked for 8pm.");
  s.advance(0.3);
  assert.equal(s.sockets.size, 2, "with nothing left running the call comes back (attention \"open\")");
  ready(s, "Your table is booked for 8pm.");
  assert.ok(until(s, () => played(s).length > 0, 10) != null);
  assert.equal(s.finals().length, 0, "the call it answered belonged to the old session");
  assert.ok(notes(s).some((n) => n.startsWith("From Bento, not the user's words: \"book a table\" has finished")));
});

// list_tasks and check_task.

test("list_tasks reading a result out before its brief plays means the brief is never played", () => {
  const s = sim();
  task(s);
  s.complete("Booked for 8pm.");
  s.toolCall("l1", "list_tasks");
  s.advance(0.05);
  const listed = s.responses().find((r) => r.id === "l1").response.message;
  assert.ok(listed.includes("The user hasn't heard this result yet: tell them now."), listed);
  s.speaks("Your table is booked for 8pm.");
  ready(s, "Your table is booked.");
  s.advance(20);
  assert.equal(played(s).length, 0);
});

test("check_task reading a result out while its brief waits for a moment: not played as well", () => {
  const s = engaged();
  const message = checkTask(s, "k1");
  assert.ok(message.includes("The user hasn't heard this result yet"), message);
  s.speaks("Your table is booked for 8pm.");
  s.advance(20);
  assert.equal(played(s).length, 0);
});

test("check_task while a brief is playing doesn't ask the model to say it too", () => {
    const s = quietRoom({}, 3);
    s.advance(0.5);
    const message = checkTask(s, "k1");
    assert.ok(!message.includes("tell them now"), message);
  });

// Cancellation and the end of the call.

test("a call Gemini cancelled while the brief was pending gets no response: the note goes as a turn", () => {
  const s = sim({ announce: { lull: 60 } });
  task(s);
  s.advance(6);
  s.complete("Booked for 8pm.");
  s.gemini({ toolCallCancellation: { ids: ["c1"] } });
  s.advance(1);
  ready(s, "Your table is booked.");
  assert.equal(played(s).length, 1);
  assert.equal(s.finals().length, 0);
  assert.ok(notes(s).some((n) => n.startsWith("From Bento, not the user's words: \"book a table\" has finished")));
});

test("cancelling a task while its earlier result's brief is pending still plays that brief", () => {
  const s = sim({ announce: { lull: 60 } });
  task(s);
  s.turn("Make it for four");
  s.toolCall("c2", "ask_hermes", { continue_task: "book a table" });
  s.advance(0.3);
  s.complete("Booked for two at 8pm.");
  ready(s, "Your table for two is booked.", 1, "b1");
  s.advance(0.1);
  assert.equal(s.hermes().length, 2, "the follow-up runs");
  assert.equal(played(s).length, 0, "the user spoke lately: it waits for a moment");
  s.push({ type: "cancelTask", task: "1" });
  s.advance(0.1);
  assert.ok(s.commands.some((c) => c.type === "tool.cancel" && c.run === s.hermes()[1].run));
  assert.ok(until(s, () => played(s).length > 0, 10) != null);
  assert.ok(s.responses().some((r) => r.id === "c1" && r.response.message.startsWith("From Bento")));
});

test("the call ending while a brief plays: nothing more is played or asked for", () => {
  const s = quietRoom({}, 3);
  s.advance(0.5);
  s.push({ type: "stop" });
  assert.equal(s.ended()?.message, null);
  const after = s.commands.length;
  s.advance(5);
  assert.deepEqual(s.push({ type: "brief.ready", id: "b1", text: "x", pcm: pcmOf(1) }), []);
  assert.equal(s.commands.filter((c, i) => i >= after && c.type !== "log").length, 0);
});

test("goodbye over a brief cuts it and hangs up", () => {
  const s = quietRoom({}, 3);
  s.advance(0.5);
  s.activity("ACTIVITY_START");
  s.heard("Goodbye");
  s.advance(1.5);
  assert.equal(s.ended()?.message, "You hung up.");
  assert.equal(flushes(s), 1);
});

test("a call doesn't hang up while a brief is pending or playing", () => {
  const s = sim({ hangUpAfter: 1, announce: { lull: 60 } });
  task(s);
  s.advance(6);
  s.complete("Booked for 8pm.");
  s.advance(1.9);
  assert.equal(s.ended(), undefined, "waiting for its brief");
  ready(s, "Your table is booked.", 2);
  s.advance(1.9);
  assert.equal(s.ended(), undefined, "while it plays");
  assert.ok(until(s, () => s.ended() != null, 5) != null, "after it, the quiet hangs up");
});
