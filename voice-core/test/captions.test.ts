// Captions, ported from Android's CallCaptionsTest.kt and the caption tests of AssistantCallTest.kt:
// same scenarios on the virtual clock (sim.ts). The core says when a caption comes down (a
// `caption` with null), where Android's screen did that itself on a user transcript, and it
// doesn't repeat a caption that hasn't changed.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Command } from "../src/types.ts";
import { Sim, type SimOptions } from "./sim.ts";

const fast = { settleQuiet: 0.1, settleMax: 1.5, tick: 0.05 };
const STREAM_END = '{"realtimeInput":{"audioStreamEnd":true}}';

/** A call with captions, listening, its captions socket set up and hearing the microphone. */
function sim(config: Record<string, unknown> = {}, o: SimOptions = {}) {
  const s = new Sim({ ...o, config: { limits: fast, captions: { linger: 0.2 }, ...config } as any });
  s.advance(0.1);
  return s;
}

function audio(s: Sim, sid: number): string[] {
  return s.sent(sid).filter((f) => f.startsWith('{"realtimeInput":{"audio"'));
}

function connects(s: Sim): Extract<Command, { type: "ws.connect" }>[] {
  return s.commands.filter((c): c is Extract<Command, { type: "ws.connect" }> => c.type === "ws.connect");
}

// The socket.

test("without captions the call opens one socket and shows none", () => {
  const s = new Sim({ config: { limits: fast } as any });
  s.advance(0.5);
  s.turn("Hello");
  assert.equal(connects(s).length, 1);
  assert.equal(connects(s)[0].purpose, undefined);
  assert.deepEqual(s.captions(), []);
});

test("a captions socket opens with the first audio and hears what the model hears", () => {
  const s = sim({ muted: true, vocabulary: ["Hermes", "Bento"] });
  s.advance(0.2);
  assert.equal(connects(s).length, 1, "no audio, no socket: a muted call pays for nothing");
  s.push({ type: "unmute" });
  s.advance(0.1);
  assert.deepEqual(connects(s).map((c) => [c.sid, c.model, c.purpose]), [[1, "models/gemini-3.8-live", undefined], [2, "models/gemini-3.5-transcribe-live", "captions"]]);
  const sent = s.sent(2);
  const setup = JSON.parse(sent[0]).setup;
  assert.equal(setup.model, "models/gemini-3.5-transcribe-live");
  assert.deepEqual(setup.generationConfig, { responseModalities: ["TEXT"] });
  assert.deepEqual(setup.inputAudioTranscription, { mode: "VERBATIM", customVocabulary: ["Hermes", "Bento"] });
  assert.equal(setup.realtimeInputConfig, undefined, "the server finds where utterances end");
  assert.ok(audio(s, 2).length >= 4);
  assert.deepEqual(audio(s, 2), audio(s, 1), "frame for frame what the model was sent");
});

test("the model on Vertex is the host's to name", () => {
  const model = "projects/p/locations/global/publishers/google/models/gemini-3.5-transcribe-live";
  const s = sim({ captions: { model } });
  assert.equal(connects(s)[1].model, model);
  assert.equal(JSON.parse(s.sent(2)[0]).setup.model, model);
});

test("the captioner hears silence where the model does", () => {
  const s = sim({ mic: { whileSpeaking: "silence", gainDb: 0 } });
  s.mic = "loud";
  s.audio(48_000);
  s.advance(0.2);
  const last = JSON.parse(audio(s, 2).at(-1)!).realtimeInput.audio.data;
  assert.ok(Buffer.from(last, "base64").every((b) => b === 0), "the reply's echo isn't captioned");
  assert.deepEqual(audio(s, 2), audio(s, 1));
});

test("guesses arrive as captions, and the caption comes down after the utterance", () => {
  const s = sim();
  s.utterance("ACTIVITY_START");
  s.guess("What's the");
  s.guess("What's the weather ");
  s.guess("What's the weather ");
  assert.deepEqual(s.captions(), ["What's the", "What's the weather"], "trimmed, and not repeated");
  s.gemini({ serverContent: { inputTranscription: { text: "What's the weather?" } } }, s.captionSid);
  s.utterance("ACTIVITY_END");
  assert.deepEqual(s.captions(), ["What's the", "What's the weather"], "the captioner's own final isn't shown: the words on screen stay the model's");
  s.advance(0.3);
  assert.deepEqual(s.captions(), ["What's the", "What's the weather", null]);
  assert.ok(!s.commands.some((c) => c.type === "transcript"), "a caption is never part of the conversation");
});

test("muting ends the utterance now, and nothing is heard while muted", () => {
  const s = sim();
  s.push({ type: "mute" });
  s.advance(0.05);
  assert.equal(s.sent(2).at(-1), STREAM_END);
  const fed = audio(s, 2).length;
  s.advance(0.2);
  assert.equal(audio(s, 2).length, fed);
});

test("a connection the server rotates is replaced at the next audio", () => {
  const s = sim();
  s.utterance("ACTIVITY_START");
  s.guess("Book a");
  s.gemini({ goAway: { timeLeft: "5s" } }, 2);
  assert.ok(s.sockets.get(2)!.closed);
  s.advance(0.3);
  assert.deepEqual(s.captions(), ["Book a", null], "an utterance the socket took with it ends");
  assert.deepEqual(s.captionSids, [2, 3], "no wait: it didn't break");
  assert.ok(audio(s, 3).length > 0);
});

test("an idle socket closes and audio opens another", () => {
  const s = sim({ captions: { idle: 0.5 } });
  s.push({ type: "mute" });
  s.advance(0.4);
  assert.ok(!s.sockets.get(2)!.closed);
  s.advance(0.3);
  assert.ok(s.sockets.get(2)!.closed);
  s.advance(1);
  assert.deepEqual(s.captionSids, [2]);
  s.push({ type: "unmute" });
  s.advance(0.1);
  assert.deepEqual(s.captionSids, [2, 3]);
  assert.ok(audio(s, 3).length > 0);
});

test("a captioner Gemini refuses gives up, and the call goes on", () => {
  const s = sim({}, { captioner: [{ error: { message: "API key not valid" } }] });
  s.advance(30);
  assert.deepEqual(s.captionSids, [2, 3, 4], "three refusals, five seconds apart");
  assert.ok(s.captionSids.every((sid) => s.sockets.get(sid)!.closed));
  assert.equal(s.ended(), undefined);
  assert.equal(s.statuses().at(-1), "listening");
  assert.ok(s.commands.some((c) => c.type === "log" && c.level === "warn" && c.message.includes("without them")));
  s.turn("Still here?");
  assert.ok(s.commands.some((c) => c.type === "transcript" && c.text === "Still here?"));
});

test("a socket that breaks without captions is a failure even after an utterance started", () => {
  const s = sim({}, { captioner: [{ setupComplete: {} }, { voiceActivity: { type: "ACTIVITY_START" } }, { error: { message: "Internal error" } }] });
  s.advance(30);
  assert.equal(s.captionSids.length, 3, "no captions, three breaks: the captioner gives up");
});

test("captions keep the captioner going through breaks", () => {
  const s = sim({}, { captioner: [{ setupComplete: {} }, { serverContent: { interimInputTranscription: { text: "Hi" } } }, { error: { message: "Internal error" } }] });
  s.advance(30);
  assert.ok(s.captionSids.length >= 5, `${s.captionSids.length} sockets`);
});

test("a socket the host says closed is replaced after a wait, with no captions meanwhile", () => {
  const s = sim();
  s.push({ type: "ws.closed", sid: 2, code: 1006 });
  assert.ok(!s.commands.some((c) => c.type === "ws.close" && c.sid === 2), "it is closed already");
  s.advance(4.5);
  assert.deepEqual(s.captionSids, [2]);
  s.advance(1);
  assert.deepEqual(s.captionSids, [2, 3]);
  assert.equal(s.ended(), undefined, "losing captions never ends the call");
});

test("a socket that never sets up is given up on", () => {
  const s = sim({}, { captioner: [] });
  s.advance(9.5);
  assert.ok(!s.sockets.get(2)!.closed);
  s.advance(1);
  assert.ok(s.sockets.get(2)!.closed);
  assert.equal(audio(s, 2).length, 0, "nothing is sent before the setup is answered");
});

test("audio said while the socket opened follows its setup", () => {
  const s = new Sim({ config: { limits: fast, captions: {} } as any, captioner: [] });
  s.advance(1);
  assert.equal(audio(s, 2).length, 0);
  s.gemini({ setupComplete: {} }, 2);
  const fed = audio(s, 2).length;
  assert.ok(fed >= 40 && fed <= 100, `${fed} frames: what was said while it opened, about two seconds at most`);
});

test("hanging up closes the captions socket and takes the caption down", () => {
  const s = sim();
  s.utterance("ACTIVITY_START");
  s.guess("Good");
  s.push({ type: "stop" });
  assert.ok(s.sockets.get(2)!.closed);
  assert.deepEqual(s.captions(), ["Good", null]);
  assert.equal(s.commands.at(-1)!.type, "status");
});

// The caption on screen, against the model's own transcript.

test("captions show the user speaking until the model's transcript replaces them", () => {
  const s = sim();
  s.utterance("ACTIVITY_START");
  s.guess("What's the");
  s.guess("What's the weather in Londo");
  assert.deepEqual(s.captions(), ["What's the", "What's the weather in Londo"]);
  s.activity("ACTIVITY_START");
  s.heard("What's the weather in London?");
  s.activity("ACTIVITY_END");
  assert.deepEqual(s.captions(), ["What's the", "What's the weather in Londo", null]);
  const down = s.commands.findIndex((c) => c.type === "caption" && c.text === null);
  const words = s.commands.findIndex((c) => c.type === "transcript" && c.role === "user");
  assert.ok(down < words, "the caption comes down, then its words go up");
  // The captioner's late guesses at the same words are stale; its next utterance shows again.
  s.guess("What's the weather in London?");
  s.utterance("ACTIVITY_END");
  s.advance(0.6);
  assert.equal(s.captions().length, 3);
  s.utterance("ACTIVITY_START");
  s.guess("Thanks");
  assert.equal(s.captions().at(-1), "Thanks");
  s.toolCall("c1");
  s.advance(0.3);
  assert.equal(s.hermes()[0].request, "What's the weather in London?", "Hermes gets the model's words, never a caption");
});

test("a late transcript of the last utterance leaves the next one's caption", () => {
  const s = sim();
  s.activity("ACTIVITY_START");
  s.utterance("ACTIVITY_START");
  s.guess("First request");
  s.utterance("ACTIVITY_END");
  s.activity("ACTIVITY_END");
  s.advance(0.7);
  // The model's next turn starts before the last one's transcript arrives.
  s.activity("ACTIVITY_START");
  s.utterance("ACTIVITY_START");
  s.guess("Second request");
  s.heard("First request.");
  s.advance(0.2);
  s.guess("Second request continues");
  // The first caption came down after its utterance (the test's linger). The model's late transcript of
  // it takes the later caption's place for a moment, and the later caption comes straight back.
  assert.deepEqual(s.captions(), ["First request", null, "Second request", null, "Second request", "Second request continues"]);
  const i = s.commands.findIndex((c) => c.type === "transcript" && c.role === "user");
  assert.deepEqual(s.commands.slice(i - 1, i + 2).map((c) => c.type), ["caption", "transcript", "caption"]);
});

test("the next turn's own transcript still replaces its caption", () => {
  const s = sim();
  s.turn("First request.");
  s.advance(0.7);
  s.activity("ACTIVITY_START");
  s.utterance("ACTIVITY_START");
  s.guess("Second");
  s.heard("Second request.");
  s.guess("Second request");
  s.advance(0.2);
  assert.deepEqual(s.captions(), ["Second", null], "the second turn's transcript replaced its caption for good");
});

test("a captioner that catches up late is matched by when the audio was captured", () => {
  const s = sim();
  assert.equal(s.t, 0.1);
  s.activity("ACTIVITY_START");
  s.heard("Yes, do it.");
  // A captioner a second behind hears the same words: they were said 0.06 s into its audio.
  s.advance(1);
  s.utterance("ACTIVITY_START", "0.060s");
  s.guess("Yes, do it");
  s.advance(0.2);
  assert.deepEqual(s.captions(), [], "words the model has transcribed don't come back as a caption");
});

test("an utterance starts when its audio was captured, through a mute", () => {
  const s = sim({ captions: { idle: 1000, linger: 0.2 } });
  s.push({ type: "mute" });
  s.advance(0.1);
  const before = audio(s, 2).length * 0.02;
  // The model's transcript of what was said before the mute comes a second into it.
  s.advance(1);
  s.turn("First.");
  s.advance(100);
  s.push({ type: "unmute" });
  const unmuted = s.t;
  s.advance(0.5);
  assert.deepEqual(s.captionSids, [2], "the same socket: its audio jumped in time");
  // Said 0.04 s after the unmute: after the turn the model transcribed, though only a moment later in the socket's audio.
  s.utterance("ACTIVITY_START", `${(before + 0.04).toFixed(3)}s`);
  s.guess("Second");
  assert.deepEqual(s.captions(), ["Second"]);
  s.activity("ACTIVITY_START");
  s.heard("Second thing.");
  s.activity("ACTIVITY_END");
  assert.deepEqual(s.captions(), ["Second", null]);
  // The captioner splits what the model heard as one turn, and says so a second late: its audio was captured before the turn ended.
  s.advance(1);
  assert.ok(s.t - unmuted > 1.4);
  s.utterance("ACTIVITY_START", `${(before + 0.3).toFixed(3)}s`);
  s.guess("thing");
  assert.deepEqual(s.captions(), ["Second", null], "by when it was said, the model has it");
});

test("a pause the model splits and the captioner doesn't captions the second half", () => {
  const s = sim();
  s.utterance("ACTIVITY_START");
  s.activity("ACTIVITY_START");
  s.guess("Book a table");
  s.heard("Book a table.");
  s.activity("ACTIVITY_END");
  s.guess("Book a table for");
  s.advance(0.2);
  assert.deepEqual(s.captions(), ["Book a table", null], "until the model hears more, guesses at transcribed words are stale");
  s.activity("ACTIVITY_START");
  s.advance(0.1);
  s.guess("Book a table for two");
  assert.equal(s.captions().at(-1), "for two", "the words after the transcribed ones");
});

test("a pause the captioner splits and the model doesn't isn't shown twice", () => {
  const s = sim();
  s.activity("ACTIVITY_START");
  s.utterance("ACTIVITY_START");
  s.guess("Book a table");
  s.utterance("ACTIVITY_END");
  s.advance(0.7);
  s.utterance("ACTIVITY_START");
  s.guess("for two");
  s.heard("Book a table for two.");
  s.guess("for two please");
  s.advance(0.2);
  assert.deepEqual(s.captions(), ["Book a table", null, "for two", null], "both halves are in the transcript: neither comes back");
});

test("a turn the model never transcribed doesn't claim the next one's words", () => {
  const s = sim();
  // A cough: a turn with no words.
  s.activity("ACTIVITY_START");
  s.activity("ACTIVITY_END");
  s.advance(0.3);
  s.activity("ACTIVITY_START");
  s.utterance("ACTIVITY_START");
  s.guess("Hello there");
  s.advance(1.5);
  assert.deepEqual(s.captions(), ["Hello there"], "it stays while the utterance goes on");
  s.heard("Hello there.");
  s.guess("Hello there.");
  s.advance(0.2);
  assert.deepEqual(s.captions(), ["Hello there", null], "the transcript replaced its own caption");
});

test("both pauses disagreeing still caption the new words only", () => {
  const s = sim();
  s.activity("ACTIVITY_START");
  s.utterance("ACTIVITY_START");
  s.guess("Book a table");
  s.utterance("ACTIVITY_END");
  s.advance(0.7);
  // The captioner split there; the model didn't.
  s.utterance("ACTIVITY_START");
  s.guess("for two");
  s.heard("Book a table for two.");
  s.activity("ACTIVITY_END");
  // The model splits the next pause; the captioner doesn't.
  s.advance(0.05);
  s.activity("ACTIVITY_START");
  s.advance(0.1);
  s.guess("for two please near the station");
  assert.equal(s.captions().at(-1), "please near the station");
});

test("a late transcript skips only its own words of an unsplit caption", () => {
  const s = sim();
  s.activity("ACTIVITY_START");
  s.utterance("ACTIVITY_START");
  s.guess("Book a table");
  s.activity("ACTIVITY_END");
  s.advance(0.2);
  // The model splits the pause, the captioner doesn't, and the first turn's transcript is late.
  s.activity("ACTIVITY_START");
  s.guess("Book a table for two");
  s.heard("Book a table.");
  s.guess("Book a table for two please");
  assert.deepEqual(s.captions(), ["Book a table", "Book a table for two", null, "for two please"]);
});

test("a short reply after a cough gets its words back when it ends", () => {
  const s = sim();
  s.activity("ACTIVITY_START");
  s.activity("ACTIVITY_END");
  s.advance(0.2);
  s.activity("ACTIVITY_START");
  s.utterance("ACTIVITY_START");
  s.guess("Yes");
  s.advance(0.3);
  // Within the cough's late-transcript window, so it's lent to the cough for now.
  s.heard("Yes.");
  assert.deepEqual(s.captions(), ["Yes", null, "Yes"]);
  s.activity("ACTIVITY_END");
  s.guess("Yes.");
  s.advance(0.2);
  assert.deepEqual(s.captions(), ["Yes", null, "Yes", null], "the reply ended without words of its own: the transcript was its");
});

test("a caption comes back only if its own utterance is later", () => {
  const s = sim();
  s.activity("ACTIVITY_START");
  s.utterance("ACTIVITY_START");
  s.guess("Book it");
  s.activity("ACTIVITY_END");
  s.advance(0.3);
  // The captioner starts another utterance before the model's transcript of the first one comes.
  s.utterance("ACTIVITY_START");
  s.advance(0.1);
  s.heard("Book it.");
  s.advance(0.2);
  assert.deepEqual(s.captions(), ["Book it", null], "the caption on screen was the transcribed utterance's: it stays down");
});

test("a caption the model never replaces is taken down after the utterance", () => {
  const s = sim();
  s.utterance("ACTIVITY_START");
  s.guess("Hmm");
  s.advance(0.4);
  assert.deepEqual(s.captions(), ["Hmm"], "it stays while the utterance goes on");
  s.utterance("ACTIVITY_END");
  s.advance(0.15);
  assert.deepEqual(s.captions(), ["Hmm"]);
  s.advance(0.1);
  assert.deepEqual(s.captions(), ["Hmm", null]);
});

test("standby takes the caption down and stops feeding the captioner", () => {
  const s = sim({ standbyAfter: 0.5 });
  s.turn("What's on my calendar?");
  s.toolCall("c1");
  s.advance(0.3);
  // A new utterance, after the one the model transcribed.
  s.utterance("ACTIVITY_START");
  s.guess("And also");
  assert.deepEqual(s.captions(), ["And also"]);
  s.advance(1.5);
  assert.equal(s.statuses().at(-1), "standby");
  assert.deepEqual(s.captions(), ["And also", null]);
  assert.equal(s.sent(2).at(-1), STREAM_END);
  const fed = audio(s, 2).length;
  s.guess("And also check");
  s.advance(0.2);
  assert.equal(audio(s, 2).length, fed, "in standby the model hears nothing, so neither does the captioner");
  assert.deepEqual(s.captions(), ["And also", null], "and nothing is shown that the model can't hear");
});

test("the words that brought a call back from standby are captioned too", () => {
  const s = sim({ standbyAfter: 0.5 });
  s.turn("Book a table");
  s.toolCall("c1");
  s.advance(1.5);
  assert.equal(s.statuses().at(-1), "standby");
  const fed = audio(s, 2).length;
  s.mic = "loud";
  s.advance(0.6);
  assert.equal(s.statuses().at(-1), "working");
  const held = audio(s, 3).length;
  assert.ok(held >= 25);
  assert.ok(audio(s, 2).length - fed >= held, "what the new session heard, the captioner heard");
});

test("a dormant call's captioner hears nothing until the call listens again", () => {
  const s = sim({ attention: { mode: "window", afterWake: 0.5, window: 0.5 } });
  s.advance(1);
  assert.equal(s.statuses().at(-1), "dormant");
  assert.equal(s.sent(2).at(-1), STREAM_END);
  const fed = audio(s, 2).length;
  s.advance(0.5);
  assert.equal(audio(s, 2).length, fed);
  s.push({ type: "wake" });
  s.advance(0.1);
  assert.ok(audio(s, 2).length > fed, "from just before the wake word");
});
