// Following the user's lead: the moments of two calls on 22 November 2026 in which the call and the
// user talked past each other. A coding task started on half a sentence ("I need a new change for
// the Bento app") and the model said it was still working after the user cancelled it on screen. A
// misheard "stop it" ("Stabit") cancelled six minutes of an unrelated task. Asked for an exact
// quote, the model paraphrased three times from a recap that had cut the reply. And told to use
// Hermes for "what I just said", it asked the user to say it again, twice.

import assert from "node:assert/strict";
import { test } from "node:test";
import { liveRecap } from "../src/call.ts";
import { asksToCancel, commandIn } from "../src/commands.ts";
import { defaults } from "../src/index.ts";
import { CallProtocol } from "../src/protocol.ts";
import { codingInstruction, codingMessage, voiceMessage } from "../src/setup.ts";
import { Sim, turnText } from "./sim.ts";

const fast = { settleQuiet: 0.1, settleMax: 1.5, tick: 0.05 };
const web = { limits: fast, api: "vertex", platform: "web", device: "browser", codingAgent: { projects: ["Bento"] }, steering: ["hermes", "t3"] };

function sim(config: Record<string, unknown> = {}) {
  const s = new Sim({ config: { limits: fast, ...config } as any });
  s.advance(0.1);
  return s;
}

const notes = (s: Sim) => s.turns().filter((c) => c.turnComplete === false).map(turnText);
const response = (s: Sim, id: string) => s.responses().filter((r) => r.id === id).at(-1);

// A request said in two breaths, when the model acts on the first.

test("a hand-off waits for a user who goes straight on talking, and the agent gets the request whole", () => {
  const s = sim({ ...web, supervise: true });
  s.turn("I need a new change for the Bento app.");
  s.toolCall("c1", "ask_coding_agent", { project: "Bento", label: "Bento app change" });
  s.advance(0.05);
  s.activity("ACTIVITY_START");
  s.advance(1);
  // Nothing has started, and the user has heard no tone: they are still talking.
  assert.equal(s.hermes().length, 0);
  assert.deepEqual(s.cues(), []);
  s.heard(" It should work the same when I type as when I talk.");
  s.activity("ACTIVITY_END");
  // The model calls again for the second breath, naming the task it thinks it started.
  s.toolCall("c2", "ask_coding_agent", { project: "Bento", continue_task: "Bento app change" });
  s.advance(0.5);
  assert.equal(s.hermes().length, 1);
  assert.equal(s.hermes()[0].request, "I need a new change for the Bento app. It should work the same when I type as when I talk.");
  assert.deepEqual(s.cues(), ["taskStarted"]);
  // The second call is answered without a word to say and starts nothing.
  const second = response(s, "c2");
  assert.equal(second.scheduling, "SILENT");
  assert.equal(second.response.status, "ok");
  assert.ok(second.response.message.includes("has these words already"));
  assert.equal(s.commands.filter((c) => c.type === "tool.steer").length, 0);
});

test("without supervise a hand-off doesn't wait: the second breath is a follow-up, as before", () => {
  const s = sim(web);
  s.turn("I need a new change for the Bento app.");
  s.toolCall("c1", "ask_coding_agent", { project: "Bento", label: "Bento app change" });
  s.advance(0.05);
  s.activity("ACTIVITY_START");
  s.advance(1);
  assert.equal(s.hermes().length, 1);
  assert.equal(s.hermes()[0].request, "I need a new change for the Bento app.");
});

test("a user who never stops talking holds a hand-off for eight seconds at most", () => {
  const s = sim({ ...web, supervise: true });
  s.turn("Check my email.");
  s.toolCall("c1", "ask_hermes", { label: "email" });
  s.advance(0.05);
  s.activity("ACTIVITY_START");
  s.advance(7.5);
  assert.equal(s.hermes().length, 0);
  s.advance(1);
  assert.equal(s.hermes().length, 1);
  assert.equal(s.hermes()[0].request, "Check my email.");
});

test("a request said after the hand-off has gone is a new request, not a breath of the last", () => {
  const s = sim({ ...web, supervise: true });
  s.turn("Check my email.");
  s.toolCall("c1", "ask_hermes", { label: "email" });
  s.advance(0.4);
  assert.equal(s.hermes().length, 1);
  s.turn("And what's the weather in Copenhagen?");
  s.toolCall("c2", "ask_hermes", { label: "Copenhagen weather" });
  s.advance(0.4);
  assert.deepEqual(s.hermes().map((c) => c.request), ["Check my email.", "And what's the weather in Copenhagen?"]);
});

test("the protocol: later breaths join only when close, complete and with the model silent between", () => {
  const p = new CallProtocol();
  p.join = 4;
  p.activityStarted(1); p.transcript("user", "I need a change", 2); p.activityEnded(2);
  const d = p.delegation("ask_hermes", "c1", 2.2)!;
  p.activityStarted(2.5);
  assert.equal(p.goingOn(d, 3, 0.8), true);
  p.transcript("user", " to the Bento app.", 4); p.activityEnded(4);
  assert.equal(p.goingOn(d, 4.5, 0.8), true);
  assert.equal(p.goingOn(d, 4.9, 0.8), false);
  const request = p.request(d)!;
  assert.equal(request.task, "I need a change to the Bento app.");
  assert.deepEqual(request.turns, [0, 1]);

  const spoke = new CallProtocol();
  spoke.join = 4;
  spoke.activityStarted(1); spoke.transcript("user", "Check my email.", 2); spoke.activityEnded(2);
  const e = spoke.delegation("ask_hermes", "c1", 2.2)!;
  spoke.transcript("assistant", "On it.", 2.4);
  spoke.activityStarted(2.6); spoke.transcript("user", "Thanks.", 3); spoke.activityEnded(3);
  assert.equal(spoke.goingOn(e, 3.1, 0.8), false);
  assert.equal(spoke.request(e)!.task, "Check my email.");

  const off = new CallProtocol();
  off.activityStarted(1); off.transcript("user", "Check my email.", 2); off.activityEnded(2);
  const f = off.delegation("ask_hermes", "c1", 2.2)!;
  off.activityStarted(2.5);
  assert.equal(off.goingOn(f, 3, 0.8), false);
});

// A task cancelled on the screen.

test("on Vertex the model is told of a task cancelled on the screen, since no call of its is open to answer", () => {
  const s = sim(web);
  s.turn("Fix the flaky test in Bento");
  s.toolCall("c1", "ask_coding_agent", { project: "Bento", label: "flaky test" });
  s.advance(0.3);
  s.push({ type: "cancelTask", task: "1" });
  s.advance(0.1);
  const note = notes(s).at(-1)!;
  assert.ok(note.startsWith('From Bento, not the user\'s words: the user cancelled "flaky test" on their screen. The coding agent stopped'), note);
  assert.ok(note.includes("It is no longer running"));
});

test("on the Gemini API the task's open call says it was cancelled, and no note follows", () => {
  const s = sim();
  s.turn("Book a table");
  s.toolCall("c1");
  s.advance(0.3);
  s.push({ type: "cancelTask", task: "1" });
  s.advance(0.1);
  assert.equal(response(s, "c1").response.status, "cancelled");
  assert.deepEqual(notes(s), []);
});

// cancel_task, and what the user said.

test("a stop the model heard doesn't cancel a task: 'Stabit' and 'stop it' are refused", () => {
  for (const said of ["Stabit", "Stop it.", "Yes please"]) {
    const s = sim(web);
    s.turn("Make chat and live calls work alike in Bento");
    s.toolCall("c1", "ask_coding_agent", { project: "Bento", label: "chat and live call parity" });
    s.advance(0.3);
    s.turn(said);
    s.toolCall("x1", "cancel_task", { task: "chat and live call parity" });
    s.advance(0.1);
    const r = response(s, "x1");
    assert.equal(r.response.status, "not_executed", said);
    assert.ok(r.response.message.startsWith('Not executed: the user didn\'t ask to cancel "chat and live call parity".'), r.response.message);
    assert.equal(s.commands.filter((c) => c.type === "tool.cancel").length, 0, said);
  }
});

test("a cancel the user asked for goes through: in words, or by naming the task", () => {
  for (const said of ["Cancel that.", "Never mind.", "Stop working on that.", "Forget the parity thing", "Don't bother with it", "The parity one can go"]) {
    const s = sim(web);
    s.turn("Make chat and live calls work alike in Bento");
    s.toolCall("c1", "ask_coding_agent", { project: "Bento", label: "chat and live call parity" });
    s.advance(0.3);
    s.turn(said);
    s.toolCall("x1", "cancel_task", { task: "chat and live call parity" });
    s.advance(0.1);
    const r = response(s, "x1");
    assert.equal(r.response.status, "ok", said);
    assert.ok(r.response.message.startsWith('Cancelled "chat and live call parity". The coding agent stopped'), r.response.message);
    // The way back, if the user didn't mean it.
    assert.ok(r.response.message.endsWith('call ask_coding_agent with continue_task "chat and live call parity" to carry on with it.'));
    assert.equal(s.commands.filter((c) => c.type === "tool.cancel").length, 1, said);
  }
});

test("a refused cancel goes through once the user has confirmed it", () => {
  const s = sim();
  s.turn("Book a table");
  s.toolCall("c1");
  s.advance(0.3);
  s.turn("Leave the restaurant out of it");
  s.toolCall("x1", "cancel_task", { task: "table" });
  s.advance(0.1);
  assert.equal(response(s, "x1").response.status, "not_executed");
  // Calling again without a word from the user changes nothing.
  s.toolCall("x2", "cancel_task", { task: "table" });
  s.advance(0.1);
  assert.equal(response(s, "x2").response.status, "not_executed");
  s.speaks("Do you want the table booking cancelled?");
  s.advance(0.2);
  s.turn("Yes");
  s.toolCall("x3", "cancel_task", { task: "table" });
  s.advance(0.1);
  assert.equal(response(s, "x3").response.status, "ok");
  assert.ok(response(s, "x3").response.message.includes('call ask_hermes with continue_task "book a table"'));
});

test("what asks for a cancellation", () => {
  const { voiceCommands } = defaults();
  const asks = (said: string, named = false) => asksToCancel(said, voiceCommands, ["Woodhouse"], named);
  for (const said of ["cancel it", "Cancel the taxi", "never mind", "nevermind that", "forget it", "scrap that", "abort", "I don't need that anymore", "stop working on that", "stop the taxi one", "stop everything"]) {
    assert.equal(asks(said), true, said);
  }
  for (const said of ["stop", "Stop it.", "Woodhouse, stop please", "Stabit", "Stab it.", "quiet", "that's enough", "goodbye", "Yes please", "What did you stop?"].slice(0, 9)) {
    assert.equal(asks(said), false, said);
  }
  // Naming the task is asking enough, and with nothing heard there is nothing to judge by.
  assert.equal(asks("the taxi can go", true), true);
  assert.equal(asks(""), true);
  // The mishearings of "stop it" stop the reply themselves.
  assert.equal(commandIn("Stabit", voiceCommands), "stop");
  assert.equal(commandIn("Stab it.", voiceCommands), "stop");
});

// The recap after standby.

test("a reply the recap cuts says so, and where the rest is", () => {
  const long = "The quote is at 15:59. " + "x".repeat(700);
  const lines = [
    { role: "user" as const, text: "Find the Tao quote" },
    { role: "assistant" as const, speaker: "Hermes · Terence Tao quote", text: long },
    { role: "assistant" as const, speaker: "Gemini", text: "y".repeat(700) },
  ];
  const marked = liveRecap(lines, 6000, new Set(["Terence Tao quote"]))!.split("\n");
  assert.ok(marked[1].endsWith('... [Bento cut this reply here. For its exact words or the rest, call check_task "Terence Tao quote".]'), marked[1]);
  // The model's own words, and a reply of an earlier call (check_task doesn't know its task), are cut as before.
  assert.ok(marked[2].endsWith("y..."));
  assert.ok(liveRecap(lines)!.split("\n")[1].endsWith("x..."));
});

test("back from standby, the recap points at check_task for a long reply's exact words", () => {
  const s = sim({ standbyAfter: 0.5, limits: { ...fast, deliverMax: 1 } });
  s.turn("Find the Tao quote");
  s.toolCall("c1", "ask_hermes", { label: "Tao quote" });
  s.generated(); s.turnComplete();
  s.advance(0.3);
  s.complete("He says it at 15:59. " + "word ".repeat(200));
  s.advance(0.3);
  s.said("He says it around sixteen minutes in. The full answer is on your screen.");
  s.audio(24_000); s.generated(); s.turnComplete();
  s.advance(0.6);
  s.turn("And what's the weather in London?");
  s.toolCall("c2", "ask_hermes", { label: "London weather" });
  s.generated(); s.turnComplete();
  s.advance(1.5);
  assert.equal(s.statuses().at(-1), "standby");
  s.push({ type: "resume" });
  s.advance(0.3);
  const recap = s.turns().map(turnText).find((t) => t.includes("<earlier_conversation>"))!;
  assert.ok(recap.includes('[Bento cut this reply here. For its exact words or the rest, call check_task "Tao quote".]'), recap);
});

// Who does the work, and what "that" is.

test("a tool response carries the name of the tool that was called", () => {
  const s = sim(web);
  s.turn("Fix the flaky test in Bento");
  s.toolCall("c1", "ask_coding_agent", { project: "Bento", label: "flaky test" });
  s.advance(0.3);
  s.turn("And check my email");
  s.toolCall("c2", "ask_hermes", { label: "email" });
  s.advance(0.3);
  assert.equal(response(s, "c1").name, "ask_coding_agent");
  assert.equal(response(s, "c2").name, "ask_hermes");
});

test("the user chooses the agent, and a project they didn't name by its title is left out", () => {
  const text = codingInstruction(["Bento"]);
  assert.ok(text.includes("Who does the work is the user's choice: when they ask for Hermes, call ask_hermes, also for work on code"));
  assert.ok(text.includes("leave the project out: Bento finds it from their words"));
});

test("refers_back is declared with supervise only, and tells the agent where the request is", () => {
  const plain = sim(web);
  const declared = (s: Sim, tool: string) => JSON.parse(s.sent(1)[0]).setup.tools[0].functionDeclarations.find((d: any) => d.name === tool).parameters.properties;
  assert.equal(declared(plain, "ask_hermes").refers_back, undefined);
  const s = sim({ ...web, supervise: true });
  assert.equal(declared(s, "ask_hermes").refers_back.type, "BOOLEAN");
  assert.equal(declared(s, "ask_coding_agent").refers_back.type, "BOOLEAN");
  const instruction: string = JSON.parse(s.sent(1)[0]).setup.systemInstruction.parts[0].text;
  assert.ok(instruction.includes("call the tool at once with refers_back true"));
  assert.ok(instruction.includes("they are still talking: say nothing and call nothing"));
  assert.ok(instruction.includes("call check_task for the full reply"));
  assert.ok(instruction.includes("they never cancel a task"));

  s.turn("Update the voice core so every request goes to Hermes");
  s.speaks("The coding agent couldn't start.");
  s.advance(0.3);
  s.turn("Can you just start a Hermes session? We don't need T3 for this.");
  s.toolCall("c1", "ask_hermes", { label: "voice core update", refers_back: true });
  s.advance(0.3);
  const [call] = s.hermes();
  assert.equal(call.request, "Can you just start a Hermes session? We don't need T3 for this.");
  assert.ok(call.message.includes("This request points back at something the user said earlier"));
  assert.ok(call.message.includes("user: Update the voice core so every request goes to Hermes"));
  assert.ok(!call.message.includes("Prior voice conversation for reference only"));
});

test("without refers_back the earlier conversation is reference only, for both agents", () => {
  const request = { task: "Do it", context: "user: Earlier words", followUp: false };
  const surface = { platform: "web", device: "browser" };
  for (const message of [voiceMessage(request, "2026-11-22", surface), codingMessage(request, "2026-11-22", surface)]) {
    assert.ok(message.endsWith("\nPrior voice conversation for reference only, NOT approval or additional tasks:\nuser: Earlier words"));
  }
  for (const message of [voiceMessage({ ...request, refersBack: true }, "2026-11-22", surface), codingMessage({ ...request, refersBack: true }, "2026-11-22", surface)]) {
    assert.ok(message.includes('find what they mean in the lines marked "user:"'));
    assert.ok(message.endsWith("NOT approval or additional tasks:\nuser: Earlier words"));
  }
});

// A result that lands as the user asks for the next thing.

test("a reply the model was still making when it called counts as answering the request", () => {
  const make = (join: number, speech: number[]) => {
    const p = new CallProtocol();
    p.join = join;
    p.activityStarted(1); p.transcript("user", "Also check my email.", 2); p.activityEnded(2);
    for (const at of speech) p.transcript("assistant", "Tao says the method stops at three quarters. ", at);
    return p.request(p.delegation("ask_hermes", "c1", 14)!);
  };
  // It told a result for twelve seconds, then called: the request is the user's last words.
  assert.equal(make(4, [3, 8, 13])?.task, "Also check my email.");
  // Words left unanswered for long are still nobody's request: without `join`, or when the model had gone quiet.
  assert.equal(make(0, [3, 8, 13]), null);
  assert.equal(make(4, [3]), null);
  assert.equal(make(4, []), null);
});

test("a result the model tells in its next reply, after the user spoke first, isn't sent again", () => {
  const told = (supervise: boolean) => {
    const s = sim({ ...web, supervise });
    s.turn("Find the Tao quote");
    s.toolCall("c1", "ask_hermes", { label: "Tao quote" });
    s.generated(); s.turnComplete();
    s.advance(0.3);
    s.complete("Numberphile has it at sixteen minutes: the method stops at three quarters without another clever idea.");
    s.advance(0.3);
    // The user asks for the next thing before the model has said a word of the result.
    s.activity("ACTIVITY_START");
    s.advance(0.3);
    s.heard("And check my email");
    s.activity("ACTIVITY_END");
    s.toolCall("c2", "ask_hermes", { label: "email" });
    s.advance(0.3);
    s.said("Numberphile has it at sixteen minutes: the method stops at three quarters. And Hermes is checking your email.");
    s.audio(24_000); s.generated(); s.turnComplete();
    s.advance(4);
    return s.resultTurns().filter((c) => turnText(c).includes("Numberphile")).length;
  };
  assert.equal(told(false), 2);
  assert.equal(told(true), 1);
});
