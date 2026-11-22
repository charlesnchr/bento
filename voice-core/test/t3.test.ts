// Which T3 project a coding task starts in (dev/t3.mjs). On 22 November 2026 "update the VoiceCore
// app" came without a project (VoiceCore is no project's title) and the lookup, given an empty
// name, returned the empty string instead of falling back: the task failed with "T3 has no
// projects" while fourteen were registered.

import assert from "node:assert/strict";
import { test } from "node:test";
import { pick } from "../dev/t3.mjs";

const all = [
  { title: "Website", path: "/x/website", parts: ["content"] },
  { title: "Home Assistant", path: "/x/ha", parts: ["livebridge", "wakeword"] },
  { title: "Scratchpad", path: "/x/scratch", parts: [] },
  { title: "Bento", path: "/x/bento", parts: ["voicecore", "sources"] },
];

test("the project the model named, by title or part of it", () => {
  assert.equal(pick(all, "Bento")?.title, "Bento");
  assert.equal(pick(all, "home assistant")?.title, "Home Assistant");
  assert.equal(pick(all, "Assistant")?.title, "Home Assistant");
});

test("no project named: Scratchpad, never nothing", () => {
  assert.equal(pick(all, null)?.title, "Scratchpad");
  assert.equal(pick(all, "")?.title, "Scratchpad");
  assert.equal(pick(all, undefined, "Write a script that renames my photos")?.title, "Scratchpad");
  assert.equal(pick(all, "No such project")?.title, "Scratchpad");
  assert.equal(pick([all[0]], "")?.title, "Website");
  assert.equal(pick([], ""), null);
});

test("no project named: the one the user's words name, by title or by a part only it has", () => {
  assert.equal(pick(all, null, "Fix the flaky test in Bento")?.title, "Bento");
  assert.equal(pick(all, "", "Update VoiceCore to Hermes Can you just quickly update the VoiceCore app?")?.title, "Bento");
  assert.equal(pick(all, "", "there's a bug in the voice core")?.title, "Bento");
  assert.equal(pick(all, "", "retrain the wake word for home assistant")?.title, "Home Assistant");
  // A part two projects have says nothing.
  const twins = [...all, { title: "Jot", path: "/x/jot", parts: ["voicecore"] }];
  assert.equal(pick(twins, "", "update the voice core")?.title, "Scratchpad");
});
