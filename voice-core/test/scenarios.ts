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
    const s = new Sim({ micEvery: 0.1, micBytes: 32, config: { limits: fast, codingAgent: { projects: ["Bento"] } } as any });
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
};
