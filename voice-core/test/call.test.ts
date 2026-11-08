// The call, ported from Android's AssistantCallTest.kt: same scenarios, same expectations, on the
// virtual clock (sim.ts). Limits are Android's `fast` ones.

import assert from "node:assert/strict";
import { test } from "node:test";
import { liveRecap } from "../src/call.ts";
import { taskResult } from "../src/protocol.ts";
import { resultText } from "../src/setup.ts";
import { Sim, turnText } from "./sim.ts";

const fast = { settleQuiet: 0.1, settleMax: 1.5, tick: 0.05 };

function sim(config: Record<string, unknown> = {}) {
  const s = new Sim({ config: { limits: fast, ...config } as any });
  s.advance(0.1);
  return s;
}

/** A call with one task running ("Book a table"), its result not yet in. */
function oneTask() {
  const s = sim();
  s.turn("Book a table");
  s.toolCall("c1");
  s.advance(0.3);
  assert.equal(s.hermes().length, 1);
  return s;
}

test("the setup goes first, then the microphone", () => {
  const s = sim();
  const sent = s.sent(1);
  assert.ok(sent[0].startsWith('{"setup":{"model":"models/gemini-3.8-live"'));
  assert.ok(s.commands.some((c) => c.type === "mic.start"));
  s.advance(0.1);
  assert.ok(s.sent(1).slice(1).every((f) => f.startsWith('{"realtimeInput"')));
  assert.deepEqual(s.statuses(), ["connecting", "listening"]);
});

test("words said before the call connected go first", () => {
  const opening = Buffer.alloc(8000, 1).toString("base64");
  const s = sim({ opening });
  const audio = s.sent(1).filter((f) => f.includes("realtimeInput"));
  // 8,000 bytes in 3,200-byte chunks, before any microphone frame.
  const sizes = audio.slice(0, 3).map((f) => Buffer.from(JSON.parse(f).realtimeInput.audio.data, "base64").length);
  assert.deepEqual(sizes, [3200, 3200, 1600]);
});

test("a spoken request goes to Hermes and the result back", () => {
  const s = sim();
  s.said("Hi, how can I help?");
  s.advance(0.05);
  s.activity("ACTIVITY_START");
  s.heard("What's the weather");
  s.heard(" in London?");
  s.activity("ACTIVITY_END");
  s.toolCall("c1");
  s.advance(0.3);
  const [asked] = s.hermes();
  assert.equal(asked.request, "What's the weather in London?");
  assert.equal(asked.taskId, "1");
  assert.equal(asked.label, "weather in London");
  assert.ok(asked.message.includes("Prior voice conversation for reference only, NOT approval or additional tasks:\nassistant: Hi, how can I help?"));
  s.complete("It's sunny in London.");
  // The model owes the user a reply for settleMax after their turn: the result waits that out.
  s.advance(1);
  assert.equal(s.finals().length, 0);
  s.advance(1);
  const [started, result] = s.responses();
  assert.equal(started.id, "c1");
  assert.equal(started.response.status, "started");
  assert.equal(started.scheduling, "SILENT");
  assert.equal(started.willContinue, true);
  assert.equal(started.response.task, "weather in London");
  assert.equal(result.id, "c1");
  assert.equal(result.scheduling, "WHEN_IDLE");
  assert.equal(result.willContinue, undefined);
  assert.equal(result.response.status, "ok");
  assert.equal(result.response.message, "Hermes has finished \"weather in London\". Give the user the outcome in your own words, after anything they have just asked. Hermes's reply:\nIt's sunny in London.");
  assert.ok(s.commands.some((c) => c.type === "transcript" && c.role === "user" && c.text === "What's the weather"));
});

test("a task starting and its result each play a tone", () => {
  const s = oneTask();
  assert.deepEqual(s.cues(), ["taskStarted"]);
  s.complete("Booked for 8pm.");
  s.advance(0.5);
  assert.deepEqual(s.cues(), ["taskStarted", "resultArrived"]);
  assert.ok(!s.commands.some((c) => c.type === "play"), "the tones never go through the model's playback");
});

test("a call without words runs nothing", () => {
  const s = sim();
  s.activity("ACTIVITY_START");
  s.activity("ACTIVITY_END");
  s.toolCall("c1");
  s.advance(2);
  assert.equal(s.hermes().length, 0);
  assert.equal(s.responses()[0].response.status, "not_executed");
});

test("unknown tools and repeats are answered, not run", () => {
  const s = sim();
  s.toolCall("x1", "launch_rockets");
  s.advance(0.1);
  assert.equal(s.responses()[0].response.message, "Not executed: unknown tool. Only ask_hermes, list_tasks, check_task and cancel_task exist.");
  s.turn("Book a table");
  s.toolCall("c1");
  s.toolCall("c1");
  s.advance(0.5);
  assert.equal(s.hermes().length, 1);
});

test("requests in turns of their own run side by side", () => {
  const s = sim();
  s.turn("Book a table");
  s.toolCall("c1");
  s.advance(0.3);
  s.turn("Find a taxi");
  s.toolCall("c2");
  s.advance(0.3);
  assert.deepEqual(s.hermes().map((h) => [h.taskId, h.label]), [["1", "book a table"], ["2", "taxi"]]);
  assert.ok(s.statuses().includes("working"));
});

test("a result waits while the user says their next request", () => {
  const s = oneTask();
  s.activity("ACTIVITY_START");
  s.advance(0.1);
  s.complete("Booked for 8pm.");
  s.advance(0.6);
  assert.equal(s.finals().length, 0, "nothing goes in while the user talks");
  s.heard("Find a taxi");
  s.activity("ACTIVITY_END");
  s.advance(0.3);
  assert.equal(s.finals().length, 0, "nor while the model owes its reply");
  s.toolCall("c2");
  s.turnComplete();
  s.advance(2.5);
  const responses = s.responses();
  assert.deepEqual(responses.map((r) => [r.id, r.response.status]), [["c1", "started"], ["c2", "started"], ["c1", "ok"]]);
  assert.equal(responses[2].scheduling, "WHEN_IDLE");
  assert.equal(responses[2].response.message, taskResult("book a table", "Booked for 8pm."));
  assert.equal(s.resultTurns().length, 0);
  s.speaks("Task 1 is booked for 8pm.");
  s.advance(0.5);
  assert.equal(s.responses().length, 3);
  assert.equal(s.resultTurns().length, 0);
});

test("a result lost in the user's next turn goes again as a turn", () => {
  const s = oneTask();
  s.complete("Booked for 8pm.");
  s.advance(1.5);
  assert.equal(s.responses().length, 2);
  s.turn("Find a taxi");
  s.toolCall("c2");
  s.turnComplete();
  s.advance(3);
  assert.equal(turnText(s.resultTurns()[0]), resultText([["book a table", "Booked for 8pm."]]));
  assert.deepEqual(s.responses().map((r) => [r.id, r.response.status]), [["c1", "started"], ["c1", "ok"], ["c2", "started"]]);
  s.speaks("Task 1 is booked for 8pm.");
  s.advance(0.5);
  assert.equal(s.resultTurns().length, 1, "spoken, it doesn't go again");
  s.toolCall("l1", "list_tasks");
  s.advance(0.1);
  assert.equal(s.responses().at(-1).response.message,
    "Running:\n- \"taxi\" (asked: \"Find a taxi\").\nDone:\n- \"book a table\" (asked: \"Book a table\").\n" +
    "Tell the user in a sentence or two, by what each is about.");
});

test("a result an interruption cuts short goes again", () => {
  const s = oneTask();
  s.complete("Booked for 8pm.");
  s.advance(1.5);
  s.said("Task 1");
  s.audio(144_000);
  s.advance(0.1);
  s.activity("ACTIVITY_START"); s.interrupted(); s.turnComplete();
  s.turn("Sorry, go on");
  s.turnComplete();
  s.advance(3);
  assert.equal(turnText(s.resultTurns()[0]), resultText([["book a table", "Booked for 8pm."]]));
  assert.ok(s.commands.some((c) => c.type === "flush"));
});

test("a result the model had all but finished saying is heard", () => {
  const s = oneTask();
  s.complete("Booked for 8pm.");
  s.advance(1.5);
  s.said("Task 1 is booked for 8pm.");
  s.audio(9_600);
  s.generated();
  s.advance(0.1);
  s.activity("ACTIVITY_START"); s.interrupted(); s.turnComplete();
  s.turn("Thanks");
  s.speaks("You're welcome.");
  s.advance(0.8);
  assert.equal(s.resultTurns().length, 0, "heard, it doesn't go again");
});

test("a follow-up continues its task in the same session", () => {
  const s = oneTask();
  s.complete("Booked for 8pm. Want a window seat?");
  s.advance(1.5);
  s.speaks("It's booked for 8pm. Want a window seat?");
  s.advance(1.5);
  s.turn("Yes please");
  s.toolCall("c2");
  s.advance(0.3);
  const [, second] = s.hermes();
  assert.equal(second.taskId, "1");
  assert.equal(second.followUp, true);
  assert.ok(second.message.includes("It follows up your earlier work in this conversation"));
  assert.ok(s.responses().at(-1).response.message.startsWith("Bento took this as the user's answer to \"book a table\": Want a window seat? Continuing"));
});

test("Gemini cancels one task and the others carry on", () => {
  const s = sim();
  s.turn("Book a table"); s.toolCall("c1"); s.advance(0.3);
  s.turn("Find a taxi"); s.toolCall("c2"); s.advance(0.3);
  s.toolCall("x1", "cancel_task", { task: "taxi" });
  s.advance(0.1);
  const cancels = s.commands.filter((c) => c.type === "tool.cancel");
  assert.deepEqual(cancels, [{ type: "tool.cancel", run: s.hermes()[1].run }]);
  const messages = s.responses().map((r) => [r.id, r.response.status]);
  assert.deepEqual(messages.slice(-2), [["c2", "cancelled"], ["x1", "ok"]]);
  s.complete("Booked.", s.hermes()[0].run);
  s.advance(1.5);
  assert.equal(s.finals().filter((r) => r.id === "c1").length, 1);
});

test("stopping the call cancels every task", () => {
  const s = oneTask();
  s.push({ type: "stop" });
  assert.ok(s.commands.some((c) => c.type === "tool.cancel"));
  assert.equal(s.ended()?.message, null);
  assert.ok(s.sockets.get(1)!.closed);
});

test("muting pauses the stream", () => {
  const s = sim();
  const before = s.sent(1).length;
  s.push({ type: "mute" });
  s.advance(0.2);
  const after = s.sent(1).slice(before);
  assert.deepEqual(after, ['{"realtimeInput":{"audioStreamEnd":true}}']);
  s.push({ type: "unmute" });
  s.advance(0.1);
  assert.ok(s.sent(1).slice(before + 1).every((f) => f.includes('"audio"')));
});

test("a dead microphone is restarted, then shown", () => {
  const s = sim({ limits: { ...fast, deadMic: 0.3, deadMicWarn: 0.5, deadMicRetry: 1 } });
  s.mic = "dead";
  s.advance(0.5);
  assert.equal(s.commands.filter((c) => c.type === "mic.restart").length, 1);
  s.advance(0.6);
  assert.ok(s.commands.some((c) => c.type === "micSilent" && c.silent));
  s.mic = "quiet";
  s.advance(0.1);
  assert.ok(s.commands.some((c) => c.type === "micSilent" && !c.silent));
  assert.equal(s.ended(), undefined, "the call goes on");
});

test("no answer times out", () => {
  const s = new Sim({ config: { limits: { ...fast, connect: 1 } } as any, autoSetup: false });
  s.advance(1.2);
  assert.equal(s.ended()?.message, "Gemini didn't answer. The call timed out.");
});

test("an error frame ends the call", () => {
  const s = sim();
  s.gemini({ error: { message: "quota" } });
  assert.equal(s.ended()?.message, "Gemini voice failed: quota. No task was retried.");
});

test("a dropped socket says how it ended", () => {
  const s = sim();
  s.push({ type: "ws.closed", sid: 1, code: 1007, reason: "API key not valid" });
  assert.equal(s.ended()?.message, "Gemini rejected the API key. Check it in Settings → Dictation.");
});

test("goAway moves the call to a new socket that resumes the session", () => {
  const s = sim();
  s.resumable("h1");
  s.gemini({ goAway: { timeLeft: "10s" } });
  s.advance(0.2);
  const setup = JSON.parse(s.sent(2)[0]).setup;
  assert.deepEqual(setup.sessionResumption, { handle: "h1" });
  assert.ok(s.sockets.get(1)!.closed, "the old socket closes once the new one is set up");
  s.advance(0.1);
  assert.ok(s.sent(2).slice(1).some((f) => f.includes("realtimeInput")), "audio goes to the new one");
  assert.equal(s.ended(), undefined);
});

test("goAway without a handle still ends at the limit", () => {
  const s = sim();
  s.gemini({ goAway: { timeLeft: "10s" } });
  s.push({ type: "ws.closed", sid: 1, code: 1000 });
  assert.equal(s.ended()?.message, "Gemini ended the call at its time limit. Start again to continue.");
});

test("silence while Hermes works leaves Gemini, and its answer brings the call back", () => {
  const s = sim({ standbyAfter: 0.5 });
  s.turn("Book a table"); s.toolCall("c1");
  s.advance(1.5);
  assert.equal(s.statuses().at(-1), "standby");
  assert.ok(s.sockets.get(1)!.closed);
  s.complete("Booked for 8pm.");
  s.advance(0.3);
  assert.deepEqual(s.statuses().slice(-3), ["standby", "waking", "working"].slice(0, 2).concat(s.statuses().slice(-1)));
  const recap = s.turns()[0];
  assert.ok(turnText(recap).includes("<call_tasks>\n\"book a table\" (running): \"Book a table\"\n</call_tasks>"));
  assert.equal(turnText(s.resultTurns()[0]), resultText([["book a table", "Booked for 8pm."]]));
  assert.deepEqual(s.cues(), ["taskStarted", "resultArrived"]);
});

test("talking in standby brings the call back with the first words", () => {
  const s = sim({ standbyAfter: 0.5 });
  s.turn("Book a table"); s.toolCall("c1");
  s.advance(1.5);
  assert.equal(s.statuses().at(-1), "standby");
  s.mic = "loud";
  s.advance(0.6);
  assert.equal(s.statuses().at(-1), "working");
  const audio = s.sent(2).filter((f) => f.includes("realtimeInput"));
  assert.ok(audio.length >= 25, "the words that woke it go to the new session");
});

test("a call with nothing left hangs up after the quiet", () => {
  const s = sim({ hangUpAfter: 1 });
  s.advance(1.2);
  assert.ok(s.ended());
  assert.equal(s.ended()!.message, null);
});

test("a call waiting on Hermes doesn't hang up", () => {
  const s = sim({ hangUpAfter: 0.5 });
  s.turn("Book a table"); s.toolCall("c1");
  s.advance(2);
  assert.equal(s.ended(), undefined);
});

test("a resumed call sends its recap before any audio", () => {
  const s = sim({ history: [{ role: "user", text: "Earlier words" }, { role: "assistant", speaker: "Gemini", text: "Earlier reply" }] });
  const frames = s.sent(1);
  assert.ok(JSON.parse(frames[0]).setup.systemInstruction.parts[0].text.endsWith("Act only on what the user asks in this call."));
  assert.ok(frames[1].includes('"clientContent"'));
  assert.ok(turnText(JSON.parse(frames[1]).clientContent).includes("User: Earlier words\nGemini: Earlier reply"));
});

test("the recap keeps the latest lines that fit", () => {
  const lines = Array.from({ length: 50 }, (_, i) => ({ role: "user" as const, text: "x".repeat(200) + i }));
  const recap = liveRecap(lines)!;
  assert.ok(recap.length <= 6000);
  assert.ok(recap.endsWith("49"));
});

// The Echo's policies.

test("whileSpeaking wake: the model hears silence over its reply, and the wake word cuts it", () => {
  const s = sim({ mic: { whileSpeaking: "wake", gainDb: 0 } });
  s.mic = "loud";
  s.audio(48_000); // a second of reply
  s.advance(0.1);
  assert.deepEqual(s.commands.filter((c) => c.type === "wakeword"), [{ type: "wakeword", on: true }]);
  const last = JSON.parse(s.sent(1).at(-1)!).realtimeInput.audio.data;
  assert.ok(Buffer.from(last, "base64").every((b: number) => b === 0), "silence over the reply");
  s.push({ type: "wake" });
  assert.ok(s.commands.some((c) => c.type === "flush"));
  assert.deepEqual(s.commands.filter((c) => c.type === "wakeword").at(-1), { type: "wakeword", on: false });
  s.audio(4_800);
  assert.equal(s.commands.filter((c) => c.type === "play").length, 1, "the rest of the cut turn isn't played");
  s.turnComplete();
  s.advance(0.05);
  const after = JSON.parse(s.sent(1).at(-1)!).realtimeInput.audio.data;
  assert.ok(Buffer.from(after, "base64").some((b: number) => b !== 0), "the user is heard again");
});

test("gain makes the microphone louder on its way to the model", () => {
  const s = sim({ mic: { whileSpeaking: "send", gainDb: 6 } });
  s.mic = "loud";
  s.advance(0.05);
  const data = Buffer.from(JSON.parse(s.sent(1).at(-1)!).realtimeInput.audio.data, "base64");
  assert.ok(Math.abs(data.readInt16LE(0)) > 15000);
});

test("host tools go to the host and their answer back", () => {
  const s = sim({ hostTools: [{ name: "tv_volume", description: "Sets the TV's volume.", parameters: { type: "OBJECT", properties: { level: { type: "INTEGER" } } } }] });
  const setup = JSON.parse(s.sent(1)[0]).setup;
  assert.ok(setup.tools[0].functionDeclarations.some((d: any) => d.name === "tv_volume" && d.behavior === "BLOCKING"));
  s.toolCall("t1", "tv_volume", { level: 10 });
  const call = s.toolCalls().at(-1)!;
  assert.deepEqual(call, { type: "tool.call", run: call.run, kind: "host", name: "tv_volume", args: { level: 10 } });
  s.push({ type: "tool.result", run: call.run, text: "The TV is at 10." });
  assert.deepEqual([s.responses()[0].id, s.responses()[0].name, s.responses()[0].response.message], ["t1", "tv_volume", "The TV is at 10."]);
});

test("on Vertex a task's start closes its call, and the result goes in as a turn", () => {
  const s = sim({ api: "vertex" });
  const setup = JSON.parse(s.sent(1)[0]).setup;
  assert.ok(setup.systemInstruction.parts[0].text.includes("Its result arrives later as a message from Bento, after another tone."));
  assert.ok(setup.tools[0].functionDeclarations[0].description.endsWith("and the result follows later as a message from Bento. Without continue_task it starts a new task."));
  s.turn("Book a table");
  s.toolCall("c1");
  s.advance(0.3);
  const [started] = s.responses();
  assert.equal(started.willContinue, undefined, "Vertex refuses willContinue");
  assert.equal(started.response.message, "Started \"book a table\". Hermes is working on it; its result follows later as a message from Bento.");
  s.complete("Booked for 8pm.");
  s.advance(3);
  assert.equal(s.responses().length, 1, "the call took its last response");
  assert.equal(turnText(s.resultTurns()[0]), resultText([["book a table", "Booked for 8pm."]]));
});
