import assert from "node:assert/strict";
import { test } from "node:test";
import { chatRequestBody, DEFAULT_REASONING_EFFORT, resolveModelOptions } from "../dev/hermes.mjs";

test("a new VoiceCore Hermes session defaults to low reasoning effort", () => {
  assert.equal(DEFAULT_REASONING_EFFORT, "low");
  assert.deepEqual(chatRequestBody({ message: "Check my calendar" }), {
    message: "Check my calendar",
    model_options: { reasoning_effort: "low" },
  });
});

test("follow-ups inherit the session's reasoning effort", () => {
  const first = chatRequestBody({ message: "First turn" });
  assert.deepEqual(first.model_options, { reasoning_effort: "low" });
  const second = chatRequestBody(
    { message: "Follow-up turn" },
    { sessionModelOptions: first.model_options ?? {} },
  );
  assert.deepEqual(second, {
    message: "Follow-up turn",
    model_options: { reasoning_effort: "low" },
  });
});

test("explicit model_options overrides are preserved without clobbering", () => {
  assert.deepEqual(
    chatRequestBody({ message: "Think deeply", model_options: { reasoning_effort: "high" } }),
    { message: "Think deeply", model_options: { reasoning_effort: "high" } },
  );
  assert.deepEqual(
    chatRequestBody({ message: "No thinking", model_options: { reasoning: { enabled: false } } }),
    { message: "No thinking", model_options: { reasoning: { enabled: false } } },
  );
  assert.deepEqual(
    chatRequestBody({ message: "Fast low", model_options: { service_tier: "priority" } }),
    { message: "Fast low", model_options: { service_tier: "priority", reasoning_effort: "low" } },
  );
});

test("top-level reasoning_effort overrides the default and merges with other model_options", () => {
  assert.deepEqual(
    chatRequestBody({ message: "Medium turn", reasoning_effort: "medium" }),
    { message: "Medium turn", model_options: { reasoning_effort: "medium" } },
  );
  assert.deepEqual(
    chatRequestBody({ message: "Priority high", reasoning_effort: "high", model_options: { service_tier: "priority" } }),
    { message: "Priority high", model_options: { service_tier: "priority", reasoning_effort: "high" } },
  );
  assert.deepEqual(
    chatRequestBody({ message: "model_options wins", reasoning_effort: "medium", model_options: { reasoning_effort: "high" } }),
    { message: "model_options wins", model_options: { reasoning_effort: "high" } },
  );
});

test("an explicit opt-out omits reasoning_effort and persists across follow-ups", () => {
  const first = chatRequestBody({ message: "Use global default", reasoning_effort: null });
  assert.deepEqual(first, { message: "Use global default" });

  const followUp = chatRequestBody(
    { message: "Still global default" },
    { sessionModelOptions: first.model_options ?? {} },
  );
  assert.deepEqual(followUp, { message: "Still global default" });

  assert.deepEqual(
    chatRequestBody({ message: "Empty string opt-out", model_options: { reasoning_effort: "" } }),
    { message: "Empty string opt-out" },
  );
  assert.deepEqual(
    chatRequestBody({ message: "Keep other option", model_options: { reasoning_effort: null, service_tier: "priority" } }),
    { message: "Keep other option", model_options: { service_tier: "priority" } },
  );
});

test("a follow-up override replaces an inherited reasoning shape cleanly", () => {
  assert.deepEqual(
    resolveModelOptions(
      { message: "Turn off", model_options: { reasoning: { enabled: false } } },
      { sessionModelOptions: { reasoning_effort: "low", service_tier: "priority" } },
    ),
    { service_tier: "priority", reasoning: { enabled: false } },
  );
  assert.deepEqual(
    resolveModelOptions(
      { message: "Raise effort", reasoning_effort: "high" },
      { sessionModelOptions: { reasoning: { enabled: true, effort: "low" } } },
    ),
    { reasoning_effort: "high" },
  );
});

test("an empty defaultEffort leaves model_options omitted", () => {
  assert.deepEqual(
    chatRequestBody({ message: "Unset default" }, { defaultEffort: "" }),
    { message: "Unset default" },
  );
});
