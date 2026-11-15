// The bench's metrics, on logs written by hand.

import assert from "node:assert/strict";
import { test } from "node:test";
import { score, segments } from "../eval/metrics.ts";

const tx = (t: number, text: string, source?: string) => ({ t, k: "tx", role: "assistant", text, ...(source ? { source } : {}) });
const clip = (t: number, dur: number) => ({ t, k: "play", dur, source: "announcer" });

test("two headlines 0.3 s apart are two stretches, each with its own words", () => {
  const log = [clip(10, 2), tx(10, "Arsenal won two nil."), clip(12.3, 2), tx(12.3, "Your parcel comes Tuesday.")];
  const segs = segments(log);
  assert.deepEqual(segs.map((s) => [s.start, s.end, s.text]), [[10, 12, "Arsenal won two nil."], [12.3, 14.3, "Your parcel comes Tuesday."]]);
});

test("a headline straight after the model's reply is its own stretch, and the model's words stay with the model", () => {
  const log = [
    tx(4.8, "It's three."), { t: 5, k: "play", dur: 1, source: "model" },
    clip(6.2, 2), tx(6.2, "Your table is booked."),
  ];
  assert.deepEqual(segments(log).map((s) => [s.source, s.text]), [["model", "It's three."], ["announcer", "Your table is booked."]]);
});

test("each result's delay is to its own headline, and a headline said twice counts twice", () => {
  const scenario = {
    name: "t", steps: [],
    agents: [{ id: "football", match: "x", result: "Arsenal won 2-0.", facts: ["arsenal"] }, { id: "parcel", match: "y", result: "Tuesday.", facts: ["tuesday"] }],
  };
  const result = (t: number, id: string) => ({ t, k: "agent.result", run: id, id, text: "done" });
  const log = [
    { t: 0, k: "run" }, result(9, "football"), result(9.5, "parcel"),
    clip(10, 2), tx(10, "Arsenal won two nil."), clip(12.3, 2), tx(12.3, "Your parcel comes Tuesday."),
    clip(20, 2), tx(20, "Arsenal won two nil."),
    { t: 25, k: "script.end" },
  ];
  const m = score(log as any, scenario as any);
  const by = Object.fromEntries(m.announcements.map((a) => [a.agent, a]));
  assert.equal(by.football.delay, 1);
  assert.equal(by.parcel.delay, 2.8);
  assert.equal(by.football.times, 2);
  assert.equal(m.repeatedResults, 1);
});

test("a result the model tells either side of a short pause is said once, with its facts found together", () => {
  const scenario = { name: "t", steps: [], agents: [{ id: "dinner", match: "x", result: "Booked for 8.", facts: ["book", "\\b(8|eight)\\b"] }] };
  const model = (t: number, dur: number) => ({ t, k: "play", dur, source: "model" });
  const log = [
    { t: 0, k: "run" }, { t: 9, k: "agent.result", run: "r", id: "dinner", text: "done" },
    tx(9.9, "I've booked your table"), model(10, 1.5), tx(11.9, " for eight on Saturday."), model(12, 1.5),
    { t: 20, k: "script.end" },
  ];
  const m = score(log as any, scenario as any);
  assert.equal(m.lostResults, 0);
  assert.equal(m.repeatedResults, 0);
  assert.equal(m.announcements[0].delay, 1);
});

test("the same result in two replies is two tellings, however close: a repeat", () => {
  const scenario = { name: "t", steps: [], agents: [{ id: "dinner", match: "x", result: "Booked for 8.", facts: ["book", "\\b(8|eight)\\b"] }] };
  const model = (t: number, dur: number) => ({ t, k: "play", dur, source: "model" });
  const ends = (t: number) => ({ t, k: "model", what: "turnComplete" });
  const log = [
    { t: 0, k: "run" }, { t: 9, k: "agent.result", run: "r", id: "dinner", text: "done" },
    tx(9.9, "Your table is booked for eight."), model(10, 2), ends(10.5),
    { t: 11.8, k: "say.start", id: "yes", text: "Yes", dur: 0.4 }, { t: 12.2, k: "say.end", id: "yes" },
    tx(12.7, "Your table is booked for eight."), model(12.8, 2), ends(13.3),
    { t: 20, k: "script.end" },
  ];
  const m = score(log as any, scenario as any);
  assert.equal(m.announcements[0].times, 2);
  assert.equal(m.repeatedResults, 1);
  // And with nothing said in between, the turn's end alone parts them.
  const quiet = log.filter((r) => !String(r.k).startsWith("say."));
  assert.equal(score(quiet as any, scenario as any).repeatedResults, 1);
});
