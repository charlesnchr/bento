// handOff "named": with other work in flight the model tells the user of a hand-off in words after
// its tone, and a result that was ready waits for that. From a call on 22 November 2026 in which
// three requests in a row got a tone each and an earlier task's result came in place of the third
// one's confirmation. A call's only task keeps the tone alone: on the bench, words after every
// hand-off cost more in talking over the user than they gave.

import assert from "node:assert/strict";
import { test } from "node:test";
import { codingInstruction, instructionFor } from "../src/setup.ts";
import { Sim, turnText } from "./sim.ts";

const fast = { settleQuiet: 0.1, settleMax: 1.5, tick: 0.05 };
const ASK = " Other work is in flight, so tell the user now in a few words what you started and who has it. Nothing else.";

function sim(config: Record<string, unknown> = {}) {
  const s = new Sim({ config: { limits: fast, api: "vertex", platform: "web", handOff: "named", ...config } as any });
  s.advance(0.1);
  return s;
}

/** The model's turn that only called a tool: it ends without a word, as Vertex sends it. */
function request(s: Sim, words: string, id: string, name = "ask_hermes", args: Record<string, unknown> = {}) {
  s.turn(words);
  s.toolCall(id, name, args);
  s.generated();
  s.turnComplete();
  s.advance(0.3);
}

/** The model says [words] over [seconds] and its turn ends. */
function says(s: Sim, words: string, seconds = 1) {
  s.said(words);
  s.audio(Math.round(seconds * 24_000) * 2);
  s.advance(seconds);
  s.generated();
  s.turnComplete();
}

const started = (s: Sim, id: string) => s.responses().find((r) => r.id === id);

test("the instruction says a hand-off may be named in words only with handOff named", () => {
  const tone = instructionFor("web", "vertex");
  const named = instructionFor("web", "vertex", false, true);
  assert.ok(tone.includes("so don't announce that Hermes is working on it. Its result"));
  assert.ok(named.includes("so don't announce that Hermes is working on it, unless Bento's answer asks you to:"));
  assert.ok(named.includes("asks you to tell the user in a few words what you started and who has it"));
  const s = sim();
  assert.equal(JSON.parse(s.sent(1)[0]).setup.systemInstruction.parts[0].text, named);
  const quiet = sim({ handOff: "tone" });
  assert.equal(JSON.parse(quiet.sent(1)[0]).setup.systemInstruction.parts[0].text, tone);
});

test("a call with a coding agent is told its task tools know only its own tasks", () => {
  const text = codingInstruction(["Bento"]);
  assert.ok(text.includes("list_tasks, check_task and cancel_task know only the tasks this call started."));
  assert.ok(text.includes("a request to look at them, list them or check on them is a new request for Hermes"));
});

test("a call's only task gets its tone and no words", () => {
  const s = sim();
  request(s, "Check my Fluide sessions", "c1");
  const answer = started(s, "c1");
  assert.equal(answer.scheduling, "SILENT");
  assert.equal(answer.response.message, "Started \"fluide sessions\". Hermes is working on it; its result follows later as a message from Bento.");
  assert.deepEqual(s.cues(), ["taskStarted"]);
});

test("with another task running, the started answer asks the model to tell the user", () => {
  const s = sim();
  request(s, "Check my Fluide sessions", "c1");
  request(s, "And look at my T3 sessions", "c2", "ask_hermes", { label: "T3 sessions" });
  const answer = started(s, "c2");
  assert.equal(answer.scheduling, "WHEN_IDLE");
  assert.equal(answer.response.status, "started");
  assert.equal(answer.response.message, "Started \"T3 sessions\". Hermes is working on it; its result follows later as a message from Bento." + ASK);
  assert.deepEqual(s.cues(), ["taskStarted", "taskStarted"]);
  assert.equal(s.hermes().length, 2);
});

test("with handOff tone the started answer stays silent whatever else runs", () => {
  const s = sim({ handOff: "tone" });
  request(s, "Check my Fluide sessions", "c1");
  request(s, "And look at my T3 sessions", "c2");
  for (const id of ["c1", "c2"]) {
    assert.equal(started(s, id).scheduling, "SILENT");
    assert.ok(!started(s, id).response.message.includes("tell the user"));
  }
});

test("a task that starts once the others have finished and been told gets the tone alone", () => {
  const s = sim();
  request(s, "Check my Fluide sessions", "c1");
  s.complete("All three services are up.", s.hermes()[0].run);
  s.advance(2);
  says(s, "All three Fluide services are up.");
  s.advance(1.5);
  request(s, "And look at my T3 sessions", "c2");
  assert.equal(started(s, "c2").scheduling, "SILENT");
});

test("a coding hand-off names the coding agent", () => {
  const s = sim({ codingAgent: { projects: ["Bento"] } });
  request(s, "Check my Fluide sessions", "c0");
  request(s, "Make the Mac app use the voice core", "c1", "ask_coding_agent", { project: "Bento", label: "voice core" });
  const answer = started(s, "c1");
  assert.equal(answer.scheduling, "WHEN_IDLE");
  assert.ok(answer.response.message.startsWith("Started \"voice core\". A coding agent in T3 Code is working on it"));
  assert.ok(answer.response.message.endsWith(ASK));
});

test("a result that was ready waits for the new request's confirmation", () => {
  const s = sim();
  request(s, "Check my Fluide sessions", "c1");
  s.advance(0.5);
  // The result lands while the user says the next request.
  s.activity("ACTIVITY_START");
  s.advance(0.2);
  s.complete("All three services are up.", s.hermes()[0].run);
  s.advance(0.5);
  s.heard("Now start a coding session on the voice core");
  s.activity("ACTIVITY_END");
  s.toolCall("c2");
  s.generated();
  s.turnComplete();
  s.advance(0.3);
  assert.equal(started(s, "c2").scheduling, "WHEN_IDLE");
  // The line is quiet, but the model hasn't said its confirmation yet.
  s.advance(0.8);
  assert.equal(s.resultTurns().length, 0, "the result doesn't take the confirmation's place");
  says(s, "Hermes has the coding session.", 1.2);
  assert.equal(s.resultTurns().length, 0, "nor does it go in over the confirmation");
  s.advance(0.4);
  assert.equal(s.resultTurns().length, 1);
  assert.ok(turnText(s.resultTurns()[0]).includes("All three services are up."));
});

test("a confirmation the model never gives holds a result only for settleMax, and not the standby", () => {
  const s = sim({ standbyAfter: 4, reconnect: true });
  request(s, "Check my Fluide sessions", "c1");
  s.activity("ACTIVITY_START");
  s.complete("All three services are up.", s.hermes()[0].run);
  s.heard("And look at my T3 sessions");
  s.activity("ACTIVITY_END");
  s.toolCall("c2");
  s.generated();
  s.turnComplete();
  s.advance(0.3);
  s.advance(1);
  assert.equal(s.resultTurns().length, 0);
  // Nothing said for settleMax: the result goes in, and the model tells it.
  s.advance(1);
  assert.equal(s.resultTurns().length, 1);
  says(s, "All three Fluide services are up.");
  // With the result heard and only Hermes to wait for, the call stands by after standbyAfter, not three times that.
  s.advance(5.5);
  assert.ok(s.statuses().includes("standby"), s.statuses().join(","));
});

test("the model that spoke with its call isn't asked to say it again", () => {
  const s = sim();
  request(s, "Look at my T3 sessions", "c0");
  s.turn("Check my Fluide sessions");
  s.advance(0.4);
  s.said("Sure, Hermes will check.");
  s.audio(24_000);
  s.toolCall("c1");
  s.generated();
  s.turnComplete();
  s.advance(0.3);
  const answer = started(s, "c1");
  assert.equal(answer.scheduling, "SILENT");
  assert.ok(!answer.response.message.includes("tell the user"));
});

test("a hand-off the user talks over is named with the next confirmation", () => {
  const s = sim();
  request(s, "What's the weather in Copenhagen", "c0");
  s.turn("Check my Fluide sessions");
  s.toolCall("c1", "ask_hermes", { label: "Fluide sessions" });
  s.generated();
  s.turnComplete();
  // The user goes straight on, before the first request has settled.
  s.activity("ACTIVITY_START");
  s.advance(0.3);
  const first = started(s, "c1");
  assert.equal(first.scheduling, "SILENT", "nothing is said over the user");
  assert.deepEqual(s.cues(), ["taskStarted", "taskStarted"]);
  s.heard("And look at my T3 sessions too");
  s.activity("ACTIVITY_END");
  s.toolCall("c2", "ask_hermes", { label: "T3 sessions" });
  s.generated();
  s.turnComplete();
  s.advance(0.3);
  const second = started(s, "c2");
  assert.equal(second.scheduling, "WHEN_IDLE");
  assert.ok(second.response.message.endsWith(
    " Other work is in flight, so tell the user now in a few words what you started and who has it. Say too that \"Fluide sessions\" is under way, unless you have told them: they have heard only a tone for it. Nothing else."), second.response.message);
});

test("a confirmation the user speaks before is named with the next one, and one they heard is not", () => {
  const s = sim();
  request(s, "What's on my calendar", "c0");
  request(s, "Check my Fluide sessions", "c1", "ask_hermes", { label: "Fluide sessions" });
  // Asked to confirm, but the user speaks first.
  s.turn("And look at my T3 sessions too");
  s.toolCall("c2", "ask_hermes", { label: "T3 sessions" });
  s.generated();
  s.turnComplete();
  s.advance(0.3);
  assert.ok(started(s, "c2").response.message.includes("Say too that \"Fluide sessions\" is under way"));
  says(s, "Hermes has both: your Fluide sessions and your T3 sessions.");
  s.advance(0.5);
  request(s, "And what's the weather in Copenhagen", "c3", "ask_hermes", { label: "Copenhagen weather" });
  assert.ok(started(s, "c3").response.message.endsWith(ASK), "both were said: only the new one is asked for");
});

test("a task that finished meanwhile isn't named as under way", () => {
  const s = sim();
  request(s, "What's on my calendar", "c0");
  s.turn("Check my Fluide sessions");
  s.toolCall("c1", "ask_hermes", { label: "Fluide sessions" });
  s.generated();
  s.turnComplete();
  s.activity("ACTIVITY_START");
  s.advance(0.3);
  s.complete("All three services are up.", s.hermes()[1].run);
  s.heard("And look at my T3 sessions too");
  s.activity("ACTIVITY_END");
  s.toolCall("c2", "ask_hermes", { label: "T3 sessions" });
  s.generated();
  s.turnComplete();
  s.advance(0.3);
  assert.ok(started(s, "c2").response.message.endsWith(ASK));
});

test("a follow-up steered into one of several running tasks is confirmed in words too", () => {
  const s = sim({ steering: ["hermes"] });
  request(s, "Find flights to Rome", "c1", "ask_hermes", { label: "Rome flights" });
  request(s, "Only direct ones", "c2", "ask_hermes", { continue_task: "Rome flights" });
  assert.equal(started(s, "c2").scheduling, "SILENT", "its only task: the tone says which");
  assert.ok(started(s, "c2").response.message.endsWith("one result covers both. Don't announce it."));
  request(s, "And book a table at Noma", "c3", "ask_hermes", { label: "Noma table" });
  says(s, "Hermes is booking Noma too.");
  s.advance(0.5);
  request(s, "Under two hundred pounds", "c4", "ask_hermes", { continue_task: "Rome flights" });
  const answer = started(s, "c4");
  assert.equal(answer.scheduling, "WHEN_IDLE");
  assert.ok(answer.response.message.endsWith("one result covers both. Other work is in flight, so tell the user now in a few words that Hermes has their follow-up to this. Nothing else."), answer.response.message);
  assert.equal(s.commands.filter((c) => c.type === "tool.steer").length, 2);
});

test("after a stop, a hand-off's confirmation isn't asked for again", () => {
  const s = sim();
  request(s, "What's on my calendar", "c0");
  request(s, "Check my Fluide sessions", "c1", "ask_hermes", { label: "Fluide sessions" });
  s.said("Hermes is");
  s.audio(48_000);
  s.push({ type: "interrupt" });
  s.advance(0.2);
  s.turnComplete();
  s.advance(0.5);
  request(s, "And look at my T3 sessions too", "c2", "ask_hermes", { label: "T3 sessions" });
  assert.ok(started(s, "c2").response.message.endsWith(ASK));
});
