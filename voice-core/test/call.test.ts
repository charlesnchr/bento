// The call, ported from Android's AssistantCallTest.kt: same scenarios, same expectations, on the
// virtual clock (sim.ts). Limits are Android's `fast` ones.

import assert from "node:assert/strict";
import { test } from "node:test";
import { liveRecap } from "../src/call.ts";
import { CallProtocol, taskResult } from "../src/protocol.ts";
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
  assert.ok(asked.message.includes("Prior voice conversation for reference only, NOT approval or additional tasks:\n<prior_conversation>\nassistant: Hi, how can I help?\n</prior_conversation>"));
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
  assert.deepEqual(cancels, [{ type: "tool.cancel", run: s.hermes()[1].run, reason: "cancelled" }]);
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

test("a request longer than the standby time isn't cut off, and starts a second task", () => {
  const s = sim({ standbyAfter: 0.5 });
  s.turn("Book a table"); s.toolCall("c1");
  s.advance(0.3);
  // The model says the user started, then nothing until they stop: five standby times of speech.
  s.activity("ACTIVITY_START");
  s.advance(2.5);
  assert.notEqual(s.statuses().at(-1), "standby");
  assert.ok(!s.sockets.get(1)!.closed, "the session the request is being said to stays open");
  s.heard("And check the token counts for the Hermes session too."); s.activity("ACTIVITY_END");
  s.toolCall("c2");
  s.advance(0.2);
  assert.equal(s.hermes().length, 2, "the follow-up became a task of its own, beside the first");
  // Then it's quiet, and the call leaves as before.
  s.advance(1.5);
  assert.equal(s.statuses().at(-1), "standby");
});

test("a turn the model never ends doesn't keep the call from standing by for good", () => {
  const s = sim({ standbyAfter: 0.5, limits: { ...fast, deliverMax: 1 } });
  s.turn("Book a table"); s.toolCall("c1");
  s.activity("ACTIVITY_START");
  s.advance(2.5);
  assert.notEqual(s.statuses().at(-1), "standby");
  s.advance(1.5);
  assert.equal(s.statuses().at(-1), "standby");
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

/** Microphone frames as the call was given them since [from], and the audio frames [sid] was sent, as base64 PCM. */
function micSince(s: Sim, from: number): string[] {
  return s.events.flatMap((e) => (e.type === "mic" && e.t >= from ? [e.pcm] : []));
}
function audioSent(s: Sim, sid: number): string[] {
  return s.sent(sid).filter((f) => f.includes("realtimeInput")).map((f) => JSON.parse(f).realtimeInput.audio.data);
}

test("halting speech in standby reaches the model from its first word", () => {
  const s = sim({ standbyAfter: 0.5 });
  s.turn("Book a table"); s.toolCall("c1");
  s.advance(4);
  assert.equal(s.statuses().at(-1), "standby");
  // Words with gaps between them: the call takes seconds to be sure this is speech.
  const began = s.t + 1e-6;
  for (let i = 0; s.statuses().at(-1) === "standby"; i++) {
    s.mic = i % 2 === 0 ? "loud" : "quiet";
    s.advance(i % 2 === 0 ? 0.16 : 0.24);
    assert.ok(s.t - began < 10, "the speech wakes the call");
  }
  assert.ok(s.t - began > 3, "it took longer than the audio kept before a wake");
  s.advance(0.1);
  assert.equal(s.statuses().at(-1), "working");
  const said = micSince(s, began);
  assert.deepEqual(audioSent(s, 2).slice(-said.length), said, "everything since the first word goes to the new session");
  assert.ok(audioSent(s, 2).length - said.length >= 70, "with the moments before it");
});

test("a sound that ended before the words that woke the call isn't sent", () => {
  const s = sim({ standbyAfter: 0.5 });
  s.turn("Book a table"); s.toolCall("c1");
  s.advance(1.5);
  assert.equal(s.statuses().at(-1), "standby");
  s.mic = "loud"; s.advance(0.2);
  s.mic = "quiet"; s.advance(3.5);
  const began = s.t + 1e-6;
  s.mic = "loud"; s.advance(0.6);
  assert.equal(s.statuses().at(-1), "working");
  const sent = audioSent(s, 2);
  const words = micSince(s, began);
  assert.deepEqual(sent.slice(-words.length), words);
  const before = sent.slice(0, -words.length);
  assert.ok(before.length >= 70 && before.length <= 80, `1.5 s before the words, not the sound before that (${before.length} frames)`);
  assert.ok(before.every((f) => f !== words[0]), "the earlier sound is left out");
});

test("words after a pause are a new line, on the screen and in the recap", () => {
  const s = sim({ standbyAfter: 0.5 });
  const lines = () => s.commands.flatMap((c) => (c.type === "transcript" ? [`${c.line} ${c.role}: ${c.text}`] : []));
  s.activity("ACTIVITY_START"); s.heard("Book a"); s.heard(" table"); s.activity("ACTIVITY_END");
  s.toolCall("c1");
  s.said("On"); s.said(" it."); s.generated(); s.turnComplete();
  s.turn("I need you to check something else.");
  s.advance(0.4);
  s.turn("The token counts.");
  assert.deepEqual(lines(), [
    "1 user: Book a", "1 user:  table", "2 assistant: On", "2 assistant:  it.",
    "3 user: I need you to check something else.", "4 user: The token counts.",
  ]);
  // Standby and back: the recap has the same lines, and what's said to the new session starts another.
  s.advance(2);
  assert.equal(s.statuses().at(-1), "standby");
  s.mic = "loud"; s.advance(0.8); s.mic = "quiet";
  assert.equal(s.statuses().at(-1), "working");
  assert.ok(turnText(s.turns()[0]).includes("User: I need you to check something else.\nUser: The token counts.\n"), turnText(s.turns()[0]));
  s.turn("And one more thing.");
  assert.equal(lines().at(-1), "5 user: And one more thing.");
});

test("a new session's words don't join the last session's line", () => {
  const s = sim({ standbyAfter: 0.5 });
  s.turn("Book a table"); s.toolCall("c1");
  s.said("Working on it."); s.generated(); s.turnComplete();
  s.advance(2);
  assert.equal(s.statuses().at(-1), "standby");
  s.mic = "loud"; s.advance(0.8); s.mic = "quiet";
  assert.equal(s.statuses().at(-1), "working");
  s.said("Still working on it.");
  const lines = s.commands.flatMap((c) => (c.type === "transcript" && c.role === "assistant" ? [c.line] : []));
  assert.equal(lines.length, 2);
  assert.notEqual(lines[0], lines[1]);
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

test("a turn whose words may be another's is never joined onto the next request", () => {
  const p = new CallProtocol();
  p.join = 4;
  p.activityStarted(0);
  p.activityEnded(0.5); // a turn with no words
  p.activityStarted(1);
  p.transcript("user", "Delete the folder.", 1.2); // late words: they may belong to the turn before
  p.activityEnded(1.5);
  p.activityStarted(2.5);
  p.transcript("user", "List my calendar.", 2.7);
  p.activityEnded(3);
  const d = p.delegation("ask_hermes", "c1", 3.2)!;
  assert.equal(p.request(d)?.task, "List my calendar.");
});

test("cancelling a task that failed: 'already finished' as before, 'already failed' with supervise", () => {
  for (const supervise of [false, true]) {
    const s = new Sim({ config: { supervise, limits: { settleQuiet: 0.1, settleMax: 1.5, tick: 0.05 } } as any });
    s.advance(0.1);
    s.turn("Book a table");
    s.toolCall("c1");
    s.advance(0.3);
    s.push({ type: "tool.error", run: s.hermes()[0].run, message: "the site was down" });
    s.advance(0.2);
    s.toolCall("x1", "cancel_task", { task: "table" });
    s.advance(0.1);
    const message: string = s.responses().find((r) => r.id === "x1").response.message;
    assert.ok(message.includes(supervise ? "has already failed" : "is already finished"), message);
  }
});

test("a voice call with a registered detached task refuses cancel_task for the detached task instead of cancelling its own run", () => {
  const s = new Sim({ config: { supervise: true, limits: { settleQuiet: 0.1, settleMax: 1.5, tick: 0.05 } } as any });
  s.advance(0.1);
  // Detached task from an earlier call registered via note.
  s.push({ type: "note", id: "call-1-1", label: "Alchemist table", text: "Book a table at Alchemist", inHistory: true, active: true, request: "Book a table at Alchemist" });
  s.advance(0.1);
  s.turn("Book a table at Noma");
  s.toolCall("c1", "ask_hermes", { label: "Noma table" });
  s.advance(0.3);
  // User asks to cancel Alchemist; Gemini calls cancel_task("Alchemist table") or cancel_task("Noma table").
  s.turn("Cancel the Alchemist table");
  s.toolCall("x1", "cancel_task", { task: "Alchemist table" });
  s.advance(0.1);
  assert.equal(s.commands.filter((c) => c.type === "tool.cancel").length, 0, "cancel_task('Alchemist table') must not fuzzy-match and cancel owned Noma table");
  const r1 = s.responses().find((r) => r.id === "x1").response;
  assert.equal(r1.status, "not_executed");
  assert.ok(r1.message.includes("ran in an earlier call"), r1.message);
  s.toolCall("x2", "cancel_task", { task: "Noma table" });
  s.advance(0.1);
  assert.equal(s.commands.filter((c) => c.type === "tool.cancel").length, 0, "cancel_task('Noma table') when user said 'Cancel the Alchemist table' must refuse");

  // Naming the detached task as an exclusion ("Cancel the Noma table, not the Alchemist table") allows cancelling owned Noma.
  s.turn("Cancel the Noma table, not the Alchemist table");
  s.toolCall("x3", "cancel_task", { task: "Noma table" });
  s.advance(0.1);
  assert.equal(s.commands.filter((c) => c.type === "tool.cancel").length, 1, "excluding detached Alchemist must not block cancelling Noma");

  // Voice mode also honors explicit exclusions for owned tasks ("Cancel the weather, not the Alchemist table and not the Noma table booking").
  const s2 = new Sim({ config: { supervise: true, limits: { settleQuiet: 0.1, settleMax: 1.5, tick: 0.05 } } as any });
  s2.advance(0.1);
  s2.push({ type: "note", id: "call-1-1", label: "Alchemist table", text: "Book a table at Alchemist", inHistory: true, active: true, request: "Book a table at Alchemist" });
  s2.advance(0.1);
  s2.turn("Book a table at Noma");
  s2.toolCall("c1", "ask_hermes", { label: "Noma table booking" });
  s2.advance(0.3);
  s2.turn("Check the weather");
  s2.toolCall("c2", "ask_hermes", { label: "Weather" });
  s2.advance(0.3);
  s2.turn("Cancel the weather, not the Alchemist table and not the Noma table booking");
  s2.toolCall("x4", "cancel_task", { task: "Noma table booking" });
  s2.advance(0.1);
  assert.equal(s2.commands.filter((c) => c.type === "tool.cancel").length, 0, "explicit exclusion must protect Noma in voice mode");
  s2.toolCall("x5", "cancel_task", { task: "Weather" });
  s2.advance(0.1);
  assert.equal(s2.commands.filter((c) => c.type === "tool.cancel").length, 1, "Weather cancels cleanly in voice mode");

  // Comma-less voice transcript exclusion ("Cancel the weather not the Noma table") protects Noma and cancels Weather.
  const s3 = new Sim({ config: { supervise: true, limits: { settleQuiet: 0.1, settleMax: 1.5, tick: 0.05 } } as any });
  s3.advance(0.1);
  s3.turn("Book a table at Noma");
  s3.toolCall("c1", "ask_hermes", { label: "Noma table" });
  s3.advance(0.3);
  s3.turn("Check the weather");
  s3.toolCall("c2", "ask_hermes", { label: "Weather" });
  s3.advance(0.3);
  s3.turn("Cancel the weather not the Noma table");
  s3.toolCall("x6", "cancel_task", { task: "Noma table" });
  s3.advance(0.1);
  assert.equal(s3.commands.filter((c) => c.type === "tool.cancel").length, 0, "comma-less voice exclusion must protect Noma");
  s3.toolCall("x7", "cancel_task", { task: "Weather" });
  s3.advance(0.1);
  assert.equal(s3.commands.filter((c) => c.type === "tool.cancel").length, 1, "comma-less voice exclusion must cancel Weather");

  // Comma-less idiomatic voice cancels ("Never mind cancel...", "Why not just cancel...", "Not that one cancel...") still cancel.
  for (const phrase of [
    "Never mind cancel the weather",
    "Actually never mind stop the weather",
    "No don't wait just cancel the weather",
    "Why not just cancel the weather",
    "Not that one cancel the weather",
    "Don't worry just cancel the weather",
    "Don't worry about the cancellation fee just cancel the weather",
    "Don't worry about the cancelled Copenhagen dinner reservation just cancel the weather",
    "Never mind the cancelled trip from Paris just cancel the weather",
    "Never mind the cancelled Lisbon flights just cancel the weather",
    "Don't worry about the cancelled Noma bookings just cancel the weather",
    "Don't worry about the cancelled Noma bus just cancel the weather",
    "Never mind the dropped call just cancel the weather",
    "Never mind the dropped call can you cancel the weather",
    "Never mind the dropped call just end the weather task",
    "Never mind the dropped call just drop the weather",
    "Don't worry about the ending just cancel the weather",
    "Don't worry about the stopwatch cancel the weather",
    "Stop the weather check and stop talking about it",
    "Stop talking and stop the weather",
    "Stop talking about it just cancel the weather",
    "Stop rambling please cancel the weather",
    "Stop talking about flights to Paris and cancel the weather",
    "Stop mentioning Noma and cancel the weather",
    "Stop explaining the Noma policy and cancel the weather",
    "Stop explaining just cancel the weather",
    "Stop repeating yourself just cancel the weather",
    "Stop reading that report and cancel the weather",
    "Stop repeating that and cancel the weather",
    "Stop repeating that then cancel the weather",
    "Stop telling me about Noma then cancel the weather",
    "Stop talking about the trip to Paris then cancel the weather",
    "Stop talking about that Noma table then cancel the weather",
    "Stop talking about that trip to Paris then cancel the weather",
    "Don't forget to cancel the weather",
    "Don't hesitate to cancel the weather",
    "I don't need it just cancel the weather",
    "I don't really need it just cancel the weather",
    "I don't care just stop the weather",
    "I don't care about that just cancel the weather",
    "It doesn't matter just cancel the weather",
    "I don't know just cancel the weather",
    "You don't have to wait just cancel the weather",
    "I don't want to wait cancel the weather",
    "I don't have time cancel the weather",
    "I'm not going to need it cancel the weather",
    "I don't think so cancel the weather",
    "It's not needed anymore cancel the weather",
    "If it's not working cancel the weather",
  ]) {
    const sv = new Sim({ config: { supervise: true, limits: { settleQuiet: 0.1, settleMax: 1.5, tick: 0.05 } } as any });
    sv.advance(0.1);
    sv.turn("Check the weather");
    sv.toolCall("c1", "ask_hermes", { label: "Weather" });
    sv.advance(0.3);
    sv.turn(phrase);
    sv.toolCall("x1", "cancel_task", { task: "Weather" });
    sv.advance(0.1);
    assert.equal(sv.commands.filter((c) => c.type === "tool.cancel").length, 1, `voice mode should cancel on: ${phrase}`);
  }

  // Multi-word "don't ... cancel" negations refuse in voice mode as well.
  for (const phrase of [
    "Please don't accidentally cancel the Noma booking",
    "Do not under any circumstances cancel the Noma booking",
    "I don't want you to cancel the Noma table",
    "I don't want you to prematurely cancel the Noma table",
    "I don't want it to stop",
    "I don't want that to stop",
    "Do not let it stop",
    "Never let it stop",
    "Don't make it stop",
    "Don't you dare cancel the Noma table",
    "Don't you cancel the Noma table",
    "I don't think you should cancel the Noma table",
    "I don't need you to cancel the Noma table",
    "Don't have them cancel the Noma table",
    "Don't have your assistant cancel the Noma table",
    "Don't have it cancel the Noma table",
    "Don't have it stop",
    "Do not have that stop",
    "Don't have Sam cancel the Noma table",
    "Don't have the Noma table task stop",
    "I'm not going to have you cancel the Noma table",
    "I don't want it stopped",
    "I don't want the Noma table cancelled",
    "Please don't go cancelling the Noma table",
    "Don't let the Noma table get cancelled",
    "Don't forget the cancelled Noma table policy",
    "Don't forget the cancelled Noma table at the end of the report",
    "Don't worry about the stopped Noma table the rain will end soon",
    "Don't worry about the cancelled Noma table we can drop by later",
    "Don't worry about the cancelled Noma table we can just drop by later",
    "Don't worry about the stopped Noma table it will just end soon",
    "Don't worry about the cancelled Noma table I'll stop by tomorrow",
    "Don't worry about the cancelled Noma table I'll just stop by tomorrow",
    "Don't worry about the cancelled Noma table he can't just cancel the Noma table",
    "Don't worry about the cancelled Noma table he can't even just cancel the Noma table",
    "Don't worry about the cancelled Noma table the team will just cancel the Noma table",
    "Don't worry about the cancelled Noma table the team will probably just cancel the Noma table",
    "Don't worry about the cancelled Noma table I know you will just cancel the Noma table",
    "Don't worry about the cancelled Noma table I know you will definitely just cancel the Noma table",
    "Don't worry about the cancelled Noma table people just cancel the Noma table",
    "Don't worry about the cancelled Noma table restaurants just cancel the Noma table all the time",
    "Don't worry about the cancelled flight budget carriers just cancel them all the time",
    "Don't worry about the cancelled Noma table the chefs just cancel the Noma table",
    "Don't worry about the cancelled Noma table my parents just cancel the Noma table",
    "Don't worry about the cancelled flight bookings travel agencies just cancel these all the time",
    "Don't worry about the cancelled flight staff just cancel the Noma table when needed",
    "Don't worry about the cancelled Noma table staff just cancel them all the time",
    "Don't worry about the cancelled Noma table kitchen staff just cancel them all the time",
    "Never mind the cancelled airlines just cancel them all the time",
    "Never mind the cancelled restaurants just cancel them all the time",
    "Don't worry about the cancelled flight crew just cancel them all the time",
    "Don't worry about the cancelled Noma table management just cancel the Noma table",
    "Don't worry about the cancelled Noma table why would you cancel the Noma table",
    "Never mind the dropped call why would you cancel the Noma table",
    "Never mind the dropped call just drop me a note about the Noma table",
    "Never mind the dropped call just end the summary with the Noma table",
    "Never mind the dropped call just end this summary with the Noma table",
    "Don't worry about the cancelled Noma table",
    "Don't wait for the stopped Noma table",
    "Don't worry about a stopped Noma table",
    "I don't care if they cancel the Noma table",
    "Stop talking about the Noma table",
    "Stop talking about the cancellation fee for the Noma table",
    "Stop reading that staff can waive the fee and cancel the Noma table at their discretion",
    "Stop reading that hosts waive the fee and cancel the Noma table",
    "Stop reading that staff waive fees and cancel the Noma table",
    "Stop reading that they waive fees and cancel the Noma table",
    "Stop reading that the hosts waive fees and cancel the Noma table",
    "Stop mentioning that airlines overbook every morning and cancel the Noma table first",
    "Stop mentioning that airlines overbook constantly and cancel the Noma table",
    "Stop mentioning that airlines overbook regularly and cancel the Noma table first",
    "Stop mentioning that hosts often cancel and cancel the Noma table",
    "Stop mentioning that staff waive corkage and cancel the Noma table after fifteen minutes",
    "Stop mentioning that they send notes and cancel the Noma table every morning",
    "Stop mentioning that staff rewrite policy and cancel the Noma table",
    "Stop mentioning that airlines send alerts and cancel the Noma table",
    "Stop mentioning that staff document safety incidents and cancel the Noma table",
    "Stop mentioning that people order twice and cancel the Noma table",
    "Stop mentioning that staff report twice and cancel the Noma table",
    "Stop mentioning that staff update so slowly and cancel the Noma table",
    "Stop mentioning that airlines issue confirmation and cancel the Noma table",
    "Stop mentioning that hotels email confirmation and cancel the Noma table",
    "Stop mentioning that guests complain out loud and cancel the Noma table",
    "Stop reading that people order aloud and cancel the Noma table",
    "Stop reading that people cheer out loud and cancel the Noma table",
    "Stop reading that children sing aloud and cancel the Noma table",
    "Stop reading that women laugh aloud and cancel the Noma table",
    "Stop reading that men shout out loud then cancel the Noma table",
    "Stop reading that staff vote aloud and cancel the Noma table",
    "Stop reading that hotels cancel aloud and cancel the Noma table",
    "Stop reading that auditors review terms aloud and cancel the Noma table",
    "Stop reading that airlines catalog complaints and cancel the Noma table",
    "Never mind the cancelled pipeline newer builds just cancel the Noma table",
    "Never mind the cancelled airline reps just cancel the Noma table",
    "Stop talking about restaurants that overbook and cancel the Noma table all the time",
    "Stop talking about airlines that overbook and cancel the Noma table all the time",
    "Never mind the cancelled flight airlines just cancel the Noma table",
    "Never mind the cancelled order suppliers just cancel it",
    "Don't worry about the cancelled Noma table guests just cancel them",
    "Don't worry about the cancelled Noma table owners just cancel the Noma table",
    "Never mind the cancelled flights travellers just cancel them",
    "Stop repeating just cancel the Noma table",
    "Stop asking please cancel the Noma table",
    "Stop repeating that some restaurants just cancel the Noma table all the time",
    "Stop repeating to me that restaurants just cancel the Noma table",
    "Stop repeating restaurants just cancel the Noma table",
    "Stop explaining to me that restaurants just cancel the Noma table",
    "Stop explaining to my wife that restaurants just cancel the Noma table",
    "Stop explaining restaurants just cancel the Noma table",
    "Stop explaining the policy restaurants just cancel the Noma table",
    "Stop explaining airlines just cancel the Noma table when bookings are low",
    "Stop talking about plans to just cancel the Noma table",
    "Stop talking about plans to really just cancel the Noma table",
    "Stop explaining that my manager will just cancel the Noma table",
    "Stop telling people to just cancel the Noma table",
    "Stop telling people to maybe just cancel the Noma table",
    "Stop asking Hermes to just cancel the Noma table",
    "Stop asking Hermes to maybe just cancel the Noma table",
    "Stop telling everyone to please cancel the Noma table",
    "Stop telling people the team will probably just cancel the Noma table",
    "Stop telling everyone Sam said just cancel the Noma table",
    "Stop talking about Noma and telling people to just cancel the Noma table",
    "Stop talking about whether we should just cancel the Noma table",
    "Stop talking about Noma and what happens when we then cancel the Noma table",
    "Stop telling me to just cancel the Noma table",
    "Stop asking me whether to just cancel the Noma table",
    "Stop explaining why I should just cancel the Noma table",
    "It doesn't matter just stop talking about the Noma table",
    "I don't like it when you cancel the Noma table",
    "I don't know if you should cancel the Noma table",
    "Don't bother to cancel the Noma table",
    "I'm not ready to cancel the Noma table",
    "Don't worry don't cancel the Noma table",
  ]) {
    const sv2 = new Sim({ config: { supervise: true, limits: { settleQuiet: 0.1, settleMax: 1.5, tick: 0.05 } } as any });
    sv2.advance(0.1);
    sv2.turn("Book a table at Noma");
    sv2.toolCall("c1", "ask_hermes", { label: "Noma table" });
    sv2.advance(0.3);
    sv2.turn(phrase);
    sv2.toolCall("x1", "cancel_task", { task: "Noma table" });
    sv2.advance(0.1);
    assert.equal(sv2.commands.filter((c) => c.type === "tool.cancel").length, 0, `voice mode must refuse: ${phrase}`);
  }

  // Voice mode: coordinated objects under stop-talking do not cancel Weather, while "and cancel" / "then cancel" do.
  const sv3 = new Sim({ config: { supervise: true, limits: { settleQuiet: 0.1, settleMax: 1.5, tick: 0.05 } } as any });
  sv3.advance(0.1);
  sv3.turn("Book a table at Noma");
  sv3.toolCall("c1", "ask_hermes", { label: "Noma table" });
  sv3.advance(0.3);
  sv3.turn("Check Copenhagen weather");
  sv3.toolCall("c2", "ask_hermes", { label: "Weather" });
  sv3.advance(0.3);
  sv3.turn("Stop talking about Noma and the weather");
  sv3.toolCall("x0", "cancel_task", { task: "Weather" });
  sv3.advance(0.1);
  assert.equal(sv3.commands.filter((c) => c.type === "tool.cancel").length, 0, "voice mode must not cancel Weather on coordinated stop-talking");
  sv3.turn("Stop talking about the Noma table and cancel the weather");
  sv3.toolCall("x1", "cancel_task", { task: "Noma table" });
  sv3.advance(0.1);
  assert.equal(sv3.commands.filter((c) => c.type === "tool.cancel").length, 0, "voice mode must not cancel Noma on stop-talking clause");
  sv3.toolCall("x2", "cancel_task", { task: "Weather" });
  sv3.advance(0.1);
  assert.equal(sv3.commands.filter((c) => c.type === "tool.cancel").length, 1, "voice mode must still cancel Weather");

  const sv4 = new Sim({ config: { supervise: true, limits: { settleQuiet: 0.1, settleMax: 1.5, tick: 0.05 } } as any });
  sv4.advance(0.1);
  sv4.turn("Book a table at Noma");
  sv4.toolCall("c1", "ask_hermes", { label: "Noma table" });
  sv4.advance(0.3);
  sv4.turn("Check Copenhagen weather");
  sv4.toolCall("c2", "ask_hermes", { label: "Weather" });
  sv4.advance(0.3);
  sv4.turn("Stop talking about Noma then cancel the weather");
  sv4.toolCall("x1", "cancel_task", { task: "Noma table" });
  sv4.advance(0.1);
  assert.equal(sv4.commands.filter((c) => c.type === "tool.cancel").length, 0, "voice mode 'then cancel' must not cancel Noma");
  sv4.toolCall("x2", "cancel_task", { task: "Weather" });
  sv4.advance(0.1);
  assert.equal(sv4.commands.filter((c) => c.type === "tool.cancel").length, 1, "voice mode 'then cancel' must cancel Weather");

  const sv5 = new Sim({ config: { supervise: true, limits: { settleQuiet: 0.1, settleMax: 1.5, tick: 0.05 } } as any });
  sv5.advance(0.1);
  sv5.turn("Book a table at Noma");
  sv5.toolCall("c1", "ask_hermes", { label: "Noma table" });
  sv5.advance(0.3);
  sv5.turn("Find flights to Paris");
  sv5.toolCall("c2", "ask_hermes", { label: "Paris flights" });
  sv5.advance(0.3);
  sv5.turn("Check Copenhagen weather");
  sv5.toolCall("c3", "ask_hermes", { label: "Weather" });
  sv5.advance(0.3);
  sv5.turn("Stop talking about Noma and the flights then cancel the weather");
  sv5.toolCall("x1", "cancel_task", { task: "Paris flights" });
  sv5.advance(0.1);
  assert.equal(sv5.commands.filter((c) => c.type === "tool.cancel").length, 0, "voice mode coordinated stop-talking must not cancel Paris flights");
  sv5.toolCall("x2", "cancel_task", { task: "Weather" });
  sv5.advance(0.1);
  assert.equal(sv5.commands.filter((c) => c.type === "tool.cancel").length, 1, "voice mode 'and the flights then cancel' must cancel Weather");

  const sv6 = new Sim({ config: { supervise: true, limits: { settleQuiet: 0.1, settleMax: 1.5, tick: 0.05 } } as any });
  sv6.advance(0.1);
  sv6.turn("Book a table at Noma");
  sv6.toolCall("c1", "ask_hermes", { label: "Noma table" });
  sv6.advance(0.3);
  sv6.turn("Check Copenhagen weather");
  sv6.toolCall("c2", "ask_hermes", { label: "Weather" });
  sv6.advance(0.3);
  sv6.turn("Don't worry about the cancelled Noma table just cancel the weather");
  sv6.toolCall("x1", "cancel_task", { task: "Noma table" });
  sv6.advance(0.1);
  assert.equal(sv6.commands.filter((c) => c.type === "tool.cancel").length, 0, "voice mode lead-in object must not cancel Noma");
  sv6.toolCall("x2", "cancel_task", { task: "Weather" });
  sv6.advance(0.1);
  assert.equal(sv6.commands.filter((c) => c.type === "tool.cancel").length, 1, "voice mode 'just cancel the weather' after lead-in must cancel Weather");

  // Voice mode: exact label "All the Time" stays out of cancel-all scope even after being cancelled first in the same turn, and short request-only recipients ("for HR" / "with HR") block cancelling QA "PDF export".
  const sv7 = new Sim({ config: { supervise: true, limits: { settleQuiet: 0.1, settleMax: 1.5, tick: 0.05 } } as any });
  sv7.advance(0.1);
  sv7.turn("Search All the Time");
  sv7.toolCall("c1", "ask_hermes", { label: "All the Time" });
  sv7.advance(0.3);
  sv7.turn("Check Paris weather");
  sv7.toolCall("c2", "ask_hermes", { label: "Weather" });
  sv7.advance(0.3);
  sv7.turn("Cancel All the Time");
  sv7.toolCall("x1", "cancel_task", { task: "All the Time" });
  sv7.advance(0.1);
  assert.equal(sv7.commands.filter((c) => c.type === "tool.cancel").length, 1, "voice mode must cancel All the Time");
  sv7.toolCall("x2", "cancel_task", { task: "Weather" });
  sv7.advance(0.1);
  assert.equal(sv7.commands.filter((c) => c.type === "tool.cancel").length, 1, "voice mode must not cancel unrelated Weather after All the Time stops running");

  const sv8 = new Sim({ config: { supervise: true, limits: { settleQuiet: 0.1, settleMax: 1.5, tick: 0.05 } } as any });
  sv8.advance(0.1);
  sv8.push({ type: "note", id: "call-1-30", label: "Payroll", text: "Exporting.", active: true, request: "Export the PDF for HR" });
  sv8.advance(0.1);
  sv8.turn("Export the PDF for QA");
  sv8.toolCall("c1", "ask_hermes", { label: "PDF export" });
  sv8.advance(0.3);
  sv8.turn("Never mind the dropped call just end the PDF export for HR");
  sv8.toolCall("x1", "cancel_task", { task: "PDF export" });
  sv8.advance(0.1);
  assert.equal(sv8.commands.filter((c) => c.type === "tool.cancel").length, 0, "voice mode detached Payroll requesting 'PDF for HR' must block cancelling QA 'PDF export'");

  const sv9 = new Sim({ config: { supervise: true, limits: { settleQuiet: 0.1, settleMax: 1.5, tick: 0.05 } } as any });
  sv9.advance(0.1);
  sv9.turn("Export the PDF for QA");
  sv9.toolCall("c1", "ask_hermes", { label: "PDF export" });
  sv9.advance(0.3);
  sv9.turn("Export the PDF with HR");
  sv9.toolCall("c2", "ask_hermes", { label: "Payroll" });
  sv9.advance(0.3);
  sv9.turn("Never mind the dropped call just end the PDF export with HR");
  sv9.toolCall("x1", "cancel_task", { task: "PDF export" });
  sv9.advance(0.1);
  assert.equal(sv9.commands.filter((c) => c.type === "tool.cancel").length, 0, "voice mode owned Payroll requesting 'PDF with HR' must block cancelling QA 'PDF export'");

  const sv10 = new Sim({ config: { supervise: true, limits: { settleQuiet: 0.1, settleMax: 1.5, tick: 0.05 } } as any });
  sv10.advance(0.1);
  sv10.turn("Search All the Time");
  sv10.toolCall("c1", "ask_hermes", { label: "All the Time" });
  sv10.advance(0.3);
  sv10.complete("Found it.", sv10.hermes()[0].run);
  sv10.advance(0.3);
  sv10.turn("Check Paris weather");
  sv10.toolCall("c2", "ask_hermes", { label: "Weather" });
  sv10.advance(0.3);
  sv10.turn("Cancel All the Time");
  sv10.toolCall("x1", "cancel_task", { task: "Weather" });
  sv10.advance(0.1);
  assert.equal(sv10.commands.filter((c) => c.type === "tool.cancel").length, 0, "voice mode finished 'All the Time' must still prevent bare 'Cancel All the Time' from cancelling Weather");
});
