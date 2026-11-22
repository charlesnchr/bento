// Calls scripted on the simulator and kept as recordings (scenarios/*.json) with what the core
// answered (scenarios/*.golden.json). Every host replays them through its own engine and must
// answer the same, byte for byte: that's what makes the core one implementation everywhere.
//
// `npm run golden` rewrites them; a change there is a change in behaviour, so read the diff.

import { Sim } from "./sim.ts";

const fast = { settleQuiet: 0.1, settleMax: 1.5, tick: 0.05 };

export const scenarios: Record<string, () => Sim> = {
  /** A request, Hermes's answer, the model speaking it. */
  "request-and-result": () => {
    const s = new Sim({ micEvery: 0.1, micBytes: 32, config: { limits: fast } as any });
    s.advance(0.1);
    s.said("Hi, how can I help?");
    s.turn("What's the weather in London?");
    s.toolCall("c1");
    s.advance(0.4);
    s.complete("It's sunny in London, 18 degrees.");
    s.advance(2);
    s.said("It's sunny in London.");
    s.audio(24_000);
    s.generated();
    s.turnComplete();
    s.advance(1);
    return s;
  },

  /** Two tasks, a follow-up answering a question, list_tasks and cancel_task. */
  "tasks-and-follow-ups": () => {
    const s = new Sim({ micEvery: 0.1, micBytes: 32, config: { limits: fast } as any });
    s.advance(0.1);
    s.turn("Book a table at Noma");
    s.toolCall("c1", "ask_hermes", { label: "Noma table" });
    s.advance(0.3);
    s.turn("Find a taxi");
    s.toolCall("c2");
    s.advance(0.3);
    s.complete("There's a table at eight. Shall I book it?", s.hermes()[0].run);
    s.advance(2);
    s.speaks("There's a table at Noma at eight. Shall I book it?");
    s.advance(1.5);
    s.turn("Yes please");
    s.toolCall("c3");
    s.advance(0.3);
    s.toolCall("l1", "list_tasks");
    s.advance(0.1);
    s.toolCall("x1", "cancel_task", { task: "taxi" });
    s.advance(0.1);
    s.complete("Booked for eight.", s.hermes()[2].run);
    s.advance(2);
    s.speaks("Booked for eight.");
    s.advance(1);
    return s;
  },

  /** Talking over a reply with a result in it, unknown tools, a cancelled call. */
  "interruptions": () => {
    const s = new Sim({ micEvery: 0.1, micBytes: 32, config: { limits: fast } as any });
    s.advance(0.1);
    s.toolCall("x1", "launch_rockets");
    s.turn("Book a table");
    s.toolCall("c1");
    s.advance(0.3);
    s.complete("Booked for 8pm.");
    s.advance(1.5);
    s.said("Task 1");
    s.audio(144_000);
    s.advance(0.1);
    s.activity("ACTIVITY_START"); s.interrupted(); s.turnComplete();
    s.turn("Sorry, go on");
    s.turnComplete();
    s.advance(3);
    s.turn("Never mind");
    s.toolCall("c2");
    s.gemini({ toolCallCancellation: { ids: ["c2"] } });
    s.advance(2);
    return s;
  },

  /** goAway, a new socket from the handle, standby while Hermes works and the comeback. */
  "rotation-and-standby": () => {
    const s = new Sim({ micEvery: 0.1, micBytes: 32, config: { limits: fast, standbyAfter: 0.5, history: [{ role: "user", text: "Earlier, I asked about trains." }] } as any });
    s.advance(0.1);
    s.resumable("h1");
    s.gemini({ goAway: { timeLeft: "10s" } });
    s.advance(0.2);
    s.turn("Book a table");
    s.toolCall("c1");
    s.advance(1.5);
    s.complete("Booked for 8pm.");
    s.advance(0.5);
    s.speaks("Your table is booked for eight.");
    s.advance(1);
    return s;
  },

  /** The Echo's way: wake word over replies, gain, a host tool, hanging up when it's over. */
  "echo-policies": () => {
    const s = new Sim({
      micEvery: 0.1, micBytes: 32,
      config: {
        limits: fast, platform: "Echo", device: "speaker", hangUpAfter: 1.5, earcons: false,
        mic: { whileSpeaking: "wake", gainDb: 12 },
        hostTools: [{ name: "tv_volume", description: "Sets the TV's volume.", parameters: { type: "OBJECT", properties: { level: { type: "INTEGER" } } } }],
      } as any,
    });
    s.mic = "loud";
    s.advance(0.1);
    s.turn("Turn the TV down to ten");
    s.toolCall("t1", "tv_volume", { level: 10 });
    s.push({ type: "tool.result", run: s.toolCalls().at(-1)!.run, text: "The TV is at 10." });
    s.said("It's at ten.");
    s.audio(48_000);
    s.advance(0.3);
    s.push({ type: "wake" });
    s.audio(4_800);
    s.turnComplete();
    s.advance(0.2);
    s.mic = "quiet";
    s.advance(2);
    return s;
  },

  /** Spoken stop and goodbye, the stop button, typing, tasks from the screen and the coding agent. */
  controls: () => {
    const s = new Sim({ micEvery: 0.1, micBytes: 32, config: { limits: fast, codingAgent: { projects: ["Bento"] }, steering: ["hermes"] } as any });
    s.advance(0.1);
    s.audio(24_000);
    s.activity("ACTIVITY_START");
    s.interrupted();
    s.heard("Woodhouse, stop.");
    s.activity("ACTIVITY_END");
    s.audio(9_600);
    s.turnComplete();
    s.push({ type: "say", text: "Fix the flaky test in Bento" });
    s.toolCall("c1", "ask_coding_agent", { project: "Bento", label: "flaky test" });
    s.advance(0.3);
    s.push({ type: "ask", text: "What's on my calendar today?" });
    s.advance(0.2);
    s.push({ type: "steer", task: "1", text: "Run the whole suite too" });
    s.push({ type: "steer", task: "2", text: "Include tomorrow too" });
    s.audio(24_000);
    s.push({ type: "interrupt" });
    s.audio(9_600);
    s.turnComplete();
    s.complete("Two meetings: standup at ten, review at three.", s.hermes()[1].run);
    s.advance(2);
    s.complete("Fixed; PR opened.", s.hermes()[0].run);
    s.advance(0.5);
    s.activity("ACTIVITY_START");
    s.heard("Goodbye");
    s.advance(2);
    return s;
  },

  /** Hand-offs named in words while other work is in flight (handOff "named"): a first task gets its tone alone, a result
   *  waits for the next request's confirmation, a hand-off talked over is named with the next one, and so is a steered follow-up. */
  "named-hand-offs": () => {
    const s = new Sim({ micEvery: 0.1, micBytes: 32, config: {
      limits: fast, api: "vertex", platform: "web", device: "browser", handOff: "named", codingAgent: { projects: ["Bento"] }, steering: ["hermes", "t3"],
    } as any });
    const silentTurn = () => { s.generated(); s.turnComplete(); };
    const says = (words: string, seconds: number) => { s.said(words); s.audio(Math.round(seconds * 24_000) * 2); s.advance(seconds); s.generated(); s.turnComplete(); };
    s.advance(0.1);
    s.turn("Find out what's going on with my Fluide sessions");
    s.toolCall("c1", "ask_hermes", { label: "Fluide sessions" });
    silentTurn();
    s.advance(0.7);
    // The result lands while the user asks for the next thing: it waits for that request's confirmation.
    s.activity("ACTIVITY_START");
    s.advance(0.2);
    s.complete("All three Fluide services are up.", s.hermes()[0].run);
    s.advance(0.4);
    s.heard("Now start a coding session: make the Mac app use the voice core");
    s.activity("ACTIVITY_END");
    s.toolCall("c2", "ask_coding_agent", { project: "Bento", label: "voice core" });
    silentTurn();
    s.advance(0.6);
    says("A coding agent is starting on the voice core in Bento.", 1.2);
    s.advance(0.4);
    says("Your Fluide services are all up.", 1);
    s.advance(0.5);
    // Two requests without a pause: the first gets its tone, and the second's confirmation names both.
    s.turn("Look at my running T3 Code sessions");
    s.toolCall("c3", "ask_hermes", { label: "T3 sessions" });
    silentTurn();
    s.activity("ACTIVITY_START");
    s.advance(0.3);
    s.heard("And what's the weather in Copenhagen");
    s.activity("ACTIVITY_END");
    s.toolCall("c4", "ask_hermes", { label: "Copenhagen weather" });
    silentTurn();
    s.advance(0.3);
    says("Hermes has both: your T3 sessions and the weather in Copenhagen.", 1.5);
    s.advance(0.4);
    // A follow-up steered into the coding agent's run.
    s.turn("Tell the coding agent to keep the old path behind a setting");
    s.toolCall("c5", "ask_coding_agent", { continue_task: "voice core" });
    silentTurn();
    s.advance(0.3);
    says("The coding agent has that.", 0.8);
    s.advance(1);
    return s;
  },

  /** The core tells results itself and listens in windows: a brief in a quiet room, one waiting on a
   *  reply, a question, a brief that failed, dormant and woken. */
  "announcements-and-attention": () => {
    const s = new Sim({ micEvery: 0.1, micBytes: 32, config: {
      limits: fast, supervise: true,
      announce: { by: "host", engaged: 6, lull: 3, attach: 0.4, briefWait: 2, maxWait: 8, maxWords: 28 },
      attention: { mode: "window", afterWake: 4, window: 2, afterQuestion: 3, afterHandOff: 1, afterAnnouncement: 0 },
    } as any });
    const brief = () => s.commands.flatMap((c) => (c.type === "brief" ? [c.id] : [])).at(-1)!;
    const ready = (text: string, seconds: number) => s.push({ type: "brief.ready", id: brief(), text, pcm: Buffer.alloc(Math.round(seconds * 24_000) * 2, 1).toString("base64") });
    s.advance(0.1);
    s.turn("Book a table at Dishoom");
    s.toolCall("c1");
    s.advance(0.3);
    s.turn("And find me a taxi for eight");
    s.toolCall("c2");
    s.advance(0.3);
    s.complete("Booked for 8pm at Dishoom.", s.hermes()[0].run);
    s.advance(0.5);
    ready("Your table at Dishoom is booked for 8pm.", 1);
    s.advance(8);
    s.push({ type: "wake" });
    s.advance(0.3);
    s.turn("What's two plus two?");
    s.said("Four.");
    s.audio(24_000);
    s.generated();
    s.turnComplete();
    s.complete("There are two taxis. Shall I book the 8pm one?", s.hermes()[1].run);
    s.advance(0.3);
    ready("There are two taxis. Shall I book the 8pm one?", 1.5);
    s.advance(3);
    s.turn("Yes please");
    s.toolCall("c3");
    s.advance(0.3);
    s.toolCall("k1", "check_task", { task: "taxi" });
    s.advance(0.1);
    s.complete("The 8pm taxi is booked.", s.hermes()[2].run);
    s.advance(0.2);
    s.push({ type: "brief.failed", id: brief(), message: "speech timed out" });
    s.advance(6);
    return s;
  },
  /** Captions: guesses while the user speaks and the model's transcript in their place, a pause only
   *  the model splits, a caption nothing replaces, a mute, a socket that rotates and one that breaks,
   *  standby and the words that end it. */
  captions: () => {
    const s = new Sim({ micEvery: 0.1, micBytes: 320, config: { limits: fast, standbyAfter: 1, captions: { idle: 4, linger: 0.5 } } as any });
    s.advance(0.3);
    s.utterance("ACTIVITY_START", "0.020s");
    s.activity("ACTIVITY_START");
    s.guess("What's the");
    s.advance(0.3);
    s.guess("What's the weather in Londo");
    s.advance(0.3);
    s.heard("What's the weather in London?");
    s.activity("ACTIVITY_END");
    s.guess("What's the weather in London? ");
    s.speaks("It's sunny.");
    s.advance(0.4);
    s.activity("ACTIVITY_START");
    s.advance(0.2);
    s.guess("What's the weather in London? And tomorrow");
    s.advance(0.2);
    s.heard("And tomorrow?");
    s.activity("ACTIVITY_END");
    s.gemini({ serverContent: { inputTranscription: { text: "What's the weather in London? And tomorrow?" } } }, s.captionSid);
    s.utterance("ACTIVITY_END", "0.170s");
    s.advance(0.3);
    s.utterance("ACTIVITY_START", "0.200s");
    s.guess("Hmm");
    s.utterance("ACTIVITY_END", "0.230s");
    s.advance(0.8);
    s.push({ type: "mute" });
    s.advance(0.3);
    s.push({ type: "unmute" });
    s.advance(0.3);
    s.utterance("ACTIVITY_START", "0.250s");
    s.guess("Book a");
    s.gemini({ goAway: { timeLeft: "5s" } }, s.captionSid);
    s.advance(0.8);
    s.push({ type: "ws.closed", sid: s.captionSid, code: 1006 });
    s.advance(5.5);
    s.utterance("ACTIVITY_START");
    s.activity("ACTIVITY_START");
    s.guess("Book a table at Noma");
    s.heard("Book a table at Noma");
    s.activity("ACTIVITY_END");
    s.toolCall("c1");
    s.advance(0.3);
    s.utterance("ACTIVITY_START");
    s.guess("And also");
    s.advance(2);
    s.guess("And also check");
    s.mic = "loud";
    s.advance(0.8);
    s.mic = "quiet";
    s.utterance("ACTIVITY_START");
    s.guess("Are you there");
    s.activity("ACTIVITY_START");
    s.heard("Are you there?");
    s.activity("ACTIVITY_END");
    s.complete("Booked for eight.");
    s.advance(5);
    s.push({ type: "stop" });
    return s;
  },

  /** A typed chat (medium "text"): answers of the model's own, tasks, a follow-up, a message typed mid-answer, list_tasks, a failed request and stop. */
  "typed-chat": () => {
    const s = new Sim({ config: { medium: "text", limits: fast, history: [{ role: "user", text: "Hello" }, { role: "assistant", speaker: "Gemini", text: "Hi." }] } as any });
    s.advance(0.1);
    s.type("Why is the sky blue?");
    s.advance(0.5);
    s.writes("Sunlight scatters off the air, blue most of all.");
    s.advance(1);
    s.type("Book a table at Noma:\n- Friday\n- for two");
    s.advance(0.4);
    s.calls("ask_hermes", { label: "Noma table" });
    s.advance(0.3);
    s.type("And find a taxi for eight");
    s.advance(0.2);
    s.type("What is 2 + 2?");
    s.calls("ask_hermes", {}, s.requests().at(-1)!.id);
    s.advance(0.3);
    s.writes("4.");
    s.advance(0.5);
    s.push({ type: "task.progress", task: "1", text: "Using browser" });
    s.complete("There's a table at eight. Shall I book it?", s.hermes()[0].run);
    s.advance(1);
    s.type("Yes please");
    s.advance(0.3);
    s.calls("ask_hermes");
    s.advance(0.3);
    s.type("What's going on?");
    s.calls("list_tasks");
    s.advance(0.2);
    s.writes("The Noma table is being booked and the taxi search is running.");
    s.advance(0.5);
    s.type("Cancel the taxi");
    s.calls("cancel_task", { task: "taxi" });
    s.advance(0.2);
    s.writes("Cancelled.");
    s.complete("Booked for eight.", s.hermes()[2].run);
    s.advance(0.5);
    s.type("Thanks");
    s.push({ type: "llm.end", id: s.requests().at(-1)!.id, status: 503 });
    s.advance(0.5);
    s.type("Tell me a story");
    s.push({ type: "llm.data", id: s.requests().at(-1)!.id, data: JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "Once upon a time" }] } }] }) });
    s.push({ type: "interrupt" });
    s.advance(0.5);
    s.push({ type: "stop" });
    return s;
  },
};
