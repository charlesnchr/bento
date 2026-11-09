// The controls a user has over a call beyond talking: spoken stop and hang-up, the stop button,
// typing, starting and steering tasks from the screen, and the coding agent.

import assert from "node:assert/strict";
import { test } from "node:test";
import { commandIn } from "../src/commands.ts";
import { defaults } from "../src/index.ts";
import { Sim, turnText } from "./sim.ts";

const fast = { settleQuiet: 0.1, settleMax: 1.5, tick: 0.05 };
const commands = defaults().voiceCommands;

function sim(config: Record<string, unknown> = {}) {
  const s = new Sim({ config: { limits: fast, ...config } as any });
  s.advance(0.1);
  return s;
}

const plays = (s: Sim) => s.commands.filter((c) => c.type === "play").length;

test("a stop or hang-up is the whole utterance, names and fillers aside", () => {
  assert.equal(commandIn("Stop.", commands), "stop");
  assert.equal(commandIn("Woodhouse, stop please", commands, ["Woodhouse"]), "stop");
  assert.equal(commandIn("Okay, that's enough!", commands), "stop");
  assert.equal(commandIn("Goodbye Woodhouse", commands, ["Woodhouse"]), "hangUp");
  assert.equal(commandIn("Hang up.", commands), "hangUp");
  assert.equal(commandIn("Stop the Pennyworth task", commands), null);
  assert.equal(commandIn("Don't stop", commands), null);
  assert.equal(commandIn("", commands), null);
});

test("saying stop cuts the reply and drops the model's answer to it", () => {
  const s = sim();
  s.audio(48_000);
  assert.equal(plays(s), 1);
  s.activity("ACTIVITY_START");
  s.interrupted();
  s.heard("Stop.");
  assert.ok(s.commands.some((c) => c.type === "voiceCommand" && c.command === "stop"));
  assert.ok(s.commands.filter((c) => c.type === "flush").length >= 1);
  s.activity("ACTIVITY_END");
  // The model's "Okay" is never played.
  s.audio(9_600);
  s.said("Okay.");
  s.turnComplete();
  assert.equal(plays(s), 1);
  assert.ok(!s.commands.some((c) => c.type === "transcript" && c.role === "assistant" && c.text === "Okay."));
  // The next turn plays as usual.
  s.turn("What time is it?");
  s.audio(9_600);
  assert.equal(plays(s), 2);
});

test("a stop that turns out to be the start of something else is answered", () => {
  const s = sim();
  s.activity("ACTIVITY_START");
  s.heard("Stop");
  s.heard(" the timer and tell me the news");
  s.activity("ACTIVITY_END");
  s.audio(9_600);
  assert.equal(plays(s), 1);
});

test("the stop button cuts the reply in the middle of its turn", () => {
  const s = sim();
  s.audio(48_000);
  s.push({ type: "interrupt" });
  assert.ok(s.commands.some((c) => c.type === "flush"));
  s.audio(48_000);
  assert.equal(plays(s), 1);
  s.turnComplete();
  s.turn("Next question");
  s.audio(9_600);
  assert.equal(plays(s), 2);
});

test("saying goodbye hangs up once the user has finished", () => {
  const s = sim();
  s.activity("ACTIVITY_START");
  s.heard("Goodbye");
  s.advance(0.5);
  assert.equal(s.ended(), undefined);
  s.advance(1);
  assert.equal(s.ended()?.message, "You hung up.");
});

test("goodbye followed by more words doesn't hang up", () => {
  const s = sim();
  s.activity("ACTIVITY_START");
  s.heard("Goodbye");
  s.advance(0.5);
  s.heard(" to the old config, and add the new one");
  s.advance(2);
  assert.equal(s.ended(), undefined);
});

test("a typed message is a turn the model answers, and can become a Hermes request", () => {
  const s = sim();
  s.push({ type: "say", text: "Find me a train to Oxford" });
  const typed = s.turns().at(-1);
  assert.equal(typed.turnComplete, true);
  assert.equal(turnText(typed), "Find me a train to Oxford");
  assert.ok(s.commands.some((c) => c.type === "transcript" && c.role === "user" && c.text === "Find me a train to Oxford"));
  s.toolCall("c1");
  s.advance(0.3);
  assert.equal(s.hermes()[0]?.request, "Find me a train to Oxford");
});

test("a task started from the screen runs at once and its result goes in as a turn", () => {
  const s = sim();
  s.push({ type: "ask", text: "Summarise my unread email" });
  s.advance(0.1);
  const [call] = s.hermes();
  assert.equal(call.request, "Summarise my unread email");
  assert.equal(call.agent, "hermes");
  assert.equal(s.responses().length, 0);
  s.complete("Three emails: two newsletters and a note from Max.");
  s.advance(2);
  const turn = s.resultTurns().at(-1);
  assert.ok(turnText(turn).includes("a note from Max"));
  assert.equal(s.responses().length, 0);
});

test("a follow-up from the screen goes to the task's session, after what it's doing", () => {
  const s = sim();
  s.turn("Book a table");
  s.toolCall("c1");
  s.advance(0.3);
  s.push({ type: "steer", task: "1", text: "Make it for four people" });
  s.advance(0.1);
  assert.equal(s.hermes().length, 1);
  s.complete("Booked for two at 7.");
  s.advance(0.1);
  const follow = s.hermes()[1];
  assert.equal(follow.request, "Make it for four people");
  assert.equal(follow.followUp, true);
  assert.equal(follow.taskId, "1");
});

test("the coding agent is a second kind of task, with its project", () => {
  const s = sim({ codingAgent: { projects: ["Bento", "Home Assistant"] } });
  const setup = JSON.parse(s.sent(1)[0]).setup;
  const declared = setup.tools[0].functionDeclarations.find((d: any) => d.name === "ask_coding_agent");
  assert.deepEqual(declared.parameters.properties.project.enum, ["Bento", "Home Assistant"]);
  assert.ok(setup.systemInstruction.parts[0].text.includes("call ask_coding_agent instead of ask_hermes"));
  s.turn("Fix the flaky call test in Bento");
  s.toolCall("c1", "ask_coding_agent", { project: "Bento", label: "flaky call test" });
  s.advance(0.3);
  const [call] = s.hermes();
  assert.equal(call.agent, "t3");
  assert.equal(call.project, "Bento");
  assert.ok(call.message.includes("open a pull request"));
  assert.ok(s.responses()[0].response.message.includes("coding agent in T3 Code"));
  assert.ok(s.commands.some((c) => c.type === "task" && c.agent === "t3"));
  // A follow-up by name stays with the coding agent, whichever tool the model used.
  s.complete("Fixed it; PR #12 is open.");
  s.advance(2);
  s.turn("Also add a test for it");
  s.toolCall("c2", "ask_hermes", { continue_task: "flaky call test" });
  s.advance(0.3);
  assert.equal(s.hermes()[1].agent, "t3");
});

test("without a coding agent its tool is unknown", () => {
  const s = sim();
  s.turn("Fix the bug");
  s.toolCall("c1", "ask_coding_agent");
  s.advance(0.3);
  assert.equal(s.hermes().length, 0);
  assert.ok(s.responses()[0].response.message.startsWith("Not executed: unknown tool."));
});

test("hanging up leaves tool runs with the reason the call ended", () => {
  const s = sim();
  s.turn("Book a table");
  s.toolCall("c1");
  s.advance(0.3);
  s.push({ type: "stop" });
  assert.deepEqual(s.commands.filter((c) => c.type === "tool.cancel").map((c: any) => c.reason), ["ended"]);
});

test("a result the user stopped isn't said again later", () => {
  const s = sim();
  s.turn("Book a table");
  s.toolCall("c1");
  s.advance(0.3);
  s.complete("Booked for two at seven.");
  s.advance(2);
  assert.equal(s.finals().length, 1);
  // The model starts saying it; the user talks over it (Gemini interrupts), then says stop.
  s.said("Your table");
  s.audio(48_000);
  s.activity("ACTIVITY_START");
  s.interrupted();
  s.heard("Stop.");
  s.activity("ACTIVITY_END");
  s.turnComplete();
  s.advance(10);
  assert.equal(s.finals().length + s.resultTurns().length, 1);
});
