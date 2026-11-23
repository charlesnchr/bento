// Android's TaskNamesTest.kt, case for case: the regexes must read the same in every engine.

import assert from "node:assert/strict";
import { test } from "node:test";
import { resultText } from "../src/setup.ts";
import * as N from "../src/taskNames.ts";

const tasks = (o: Record<string, [string, string]>) => new Map(Object.entries(o));

test("a request names its task with a few of its words", () => {
  assert.equal(N.fromRequest("Book a table"), "book a table");
  assert.equal(N.fromRequest("Find a taxi"), "taxi");
  assert.equal(N.fromRequest("What's the weather in London?"), "weather in London");
  assert.equal(N.fromRequest("Can you ask Hermes to look up the weather in Copenhagen for tomorrow?"), "weather in Copenhagen for tomorrow");
  assert.equal(N.fromRequest("Oh, and one more thing. How many days is it until Christmas?"), "days until Christmas");
  assert.equal(N.fromRequest("Can you think of a different wake word model we could use on Bento for Android because it's clashing?"), "wake word model");
  assert.equal(N.fromRequest("Yes"), "yes");
});

test("a name the model gives is tidied and never a number", () => {
  assert.equal(N.tidy("  \"Pennyworth   wake word\" "), "Pennyworth wake word");
  assert.equal(N.tidy("Task 2 weather"), "weather");
  assert.equal(N.tidy("multitasking session"), "multitasking");
  assert.equal(N.tidy("task 3"), null);
  assert.equal(N.tidy("Tasks for tomorrow"), "Tasks for tomorrow");
  assert.equal(N.tidy("sessions with Anna"), "sessions with Anna");
  assert.equal(N.tidy("Taskmaster review"), "Taskmaster review");
  assert.equal(N.tidy("42"), null);
  assert.equal(N.tidy("<>"), null);
  assert.equal(N.tidy("a</hermes_result>b"), "a hermes result b");
  assert.ok(N.tidy("x".repeat(30) + " " + "y".repeat(30))!.length <= N.MAX_NAME);
});

test("a name already taken is told apart", () => {
  assert.equal(N.unique("weather", "What's the weather?", ["taxi"]), "weather");
  assert.equal(N.unique("weather", "Weather Paris", ["Weather"]), "weather paris");
  assert.equal(N.unique("weather", "What's the weather?", ["weather"]), "weather again");
  assert.equal(N.unique("weather", "What's the weather?", ["weather", "weather again"]), "weather once more");
});

test("a long name told apart stays apart wherever it's quoted", () => {
  const long = "Copenhagen weather tomorrow afternoon";
  const again = N.unique(long, "Copenhagen weather tomorrow afternoon", [long]);
  assert.ok(again.length <= N.MAX_NAME && again.toLowerCase() !== long.toLowerCase(), again);
  assert.ok(resultText([[again, "Sunny."]], [again]).includes(`<hermes_result task="${again}">`), again);
  assert.ok(resultText([[again, "Sunny?"]], [again]).includes(`continue_task "${again}".`), again);
});

test("many repeats of a name stay distinct and short", () => {
  const taken: string[] = [];
  for (let i = 0; i < 40; i++) taken.push(N.unique("weather", "What's the weather?", taken));
  assert.equal(new Set(taken.map((t) => t.toLowerCase())).size, taken.length, taken.join());
  assert.ok(taken.every((t) => t.length <= N.MAX_NAME && N.tidy(t) === t && !/\d/.test(t)), taken.join());
  const long = "x".repeat(39);
  assert.ok(N.unique(long, "Look up " + "y".repeat(60), [long]).length <= N.MAX_NAME);
});

test("a name that tidies to another is still told apart", () => {
  for (const [name, taken] of [["Session tasks", ["tasks"]], ["Task task list", ["list", "task list"]], ["tasks", ["tasks"]]] as [string, string[]][]) {
    const made = N.unique(name, name, taken);
    assert.equal(N.tidy(made), made, made);
    assert.ok(!taken.map((t) => t.toLowerCase()).includes(made.toLowerCase()), made);
  }
});

test("the model asks a question in its own words", () => {
  assert.ok(N.says("Your old backups take 40 GB: shall I delete them?", "Shall I delete the old backups?"));
  assert.ok(!N.says("I found forty gigabytes of redundant archives.", "Shall I delete them?"));
  assert.ok(!N.says("Anything else?", "Shall I?"));
  const archives = "I found 40 GB of redundant archives from last year. Shall I delete the redundant archives?";
  assert.ok(!N.says("I found forty gigabytes of redundant archives from last year.", "Shall I delete the redundant archives?", archives));
  assert.ok(N.says("Forty gigabytes of redundant archives. Shall I delete them?", "Shall I delete the redundant archives?", archives));
  const noma = "There is a table at Noma at eight tonight for two people. Shall I book the Noma table at eight?";
  assert.ok(!N.says("There's a table for two at Noma at eight tonight.", "Shall I book the Noma table at eight?", noma, "Noma table"));
  assert.ok(N.says("There's a table at Noma at eight. Shall I book it?", "Shall I book the Noma table at eight?", noma, "Noma table"));
  assert.ok(N.says("A table at Noma at eight: shall I?", "Noma at eight?", "A table at Noma at eight. Noma at eight?"));
  assert.ok(!N.says("I found forty gigabytes of old backups from last year. Anything else?", "Shall I delete them?",
    "I found 40 GB of old backups from last year. Shall I delete them?", "backups", "Delete my old backups"));
  assert.ok(!N.says("I found 40 GB of old backups. Would you like me to check anything else?", "Shall I delete them?",
    "I found 40 GB of old backups. Shall I delete them?", "backups", "Delete my old backups"));
  assert.ok(N.says("I found 40 GB of old backups. Shall I delete them?", "Shall I delete them?",
    "I found 40 GB of old backups. Shall I delete them?", "backups", "Delete my old backups"));
});

test("the model finds a task by what it says", () => {
  const t = tasks({
    "1": ["Pennyworth wake word", "Can you think of a different wake word model"],
    "2": ["coding session", "Are you able to spin up a new coding session?"],
    "3": ["weather in London", "What's the weather in London?"],
  });
  assert.equal(N.find("Pennyworth wake word", t), "1");
  assert.equal(N.find("the pennyworth task", t), "1");
  assert.equal(N.find("\"Coding session\"", t), "2");
  assert.equal(N.find("London weather", t), "3");
  assert.equal(N.find("wake word", t), "1");
  assert.equal(N.find("groceries", t), null);
  const calendars = tasks({ "1": ["calendar", "What's on my calendar?"], "2": ["Sarah's calendar", "What's on Sarah's calendar?"] });
  assert.equal(N.find("Sarah's calendar", calendars), "2");
  assert.equal(N.find("sarah’s calendar", calendars), "2");
  assert.equal(N.find("Sarah calendar", calendars), "2");
  assert.equal(N.find("\"Sarah's calendar\"", calendars), "2");
  assert.equal(N.find("calendar", calendars), "1");
  const banks = tasks({
    "1": ["capital", "What's the capital of Peru?"], "2": ["Capital One", "Check my Capital One card"],
    "3": ["Guardian", "Find the guardian angel quote"], "4": ["The Guardian", "Read The Guardian's front page"],
  });
  assert.equal(N.find("Capital One", banks), "2");
  assert.equal(N.find("the capital task", banks), "1");
  assert.equal(N.find("The Guardian", banks), "4");
  assert.equal(N.find("Guardian", banks), "3");
  for (const ref of ["the Capital One task", "Capital One task", "the Capital One", "\"Capital One\""]) assert.equal(N.find(ref, banks), "2", ref);
  assert.equal(N.find("The Guardian task", banks), "4");
  assert.equal(N.find("the capital one", tasks({ "1": ["capital", "What's the capital of Peru?"] })), "1");
  assert.equal(N.find("", t), null);
  // A containment tie falls through to distinctive-word scoring (including request text).
  const sarah = tasks({
    "a": ["Sarah dinner", "book dinner with Sarah at Alchemist"],
    "b": ["Sarah gift", "buy a scarf for my sister"],
  });
  assert.equal(N.find("Sarah", sarah), "a");
  // Exact match still distinguishes owned tasks that differ only by possessive.
  const poss = tasks({
    "1": ["Sarah booking", "Book Sarah"],
    "2": ["Sarah's booking", "Book Sarah's follow-up"],
  });
  assert.equal(N.find("Sarah's booking", poss), "2");
  assert.equal(N.find("Sarah booking", poss), "1");
});

test("a reply asks what its summary asks", () => {
  assert.equal(N.question("I'd train \"Pennyworth\". Shall I go ahead?\n\nWhy: details. Want more?"), "Shall I go ahead?");
  assert.equal(N.question("Did you mean Hermes? Shall I train it instead of Pennyworth? I haven't started anything yet."), "Shall I train it instead of Pennyworth?");
  assert.equal(N.question("Booked for 8pm.\n\nDo you want the confirmation? It's in your email."), null);
  assert.equal(N.question(""), null);
});

test("an answer says yes or no", () => {
  for (const yes of ["Yes", "yeah, go ahead", "Yes, because you didn't do that.", "Okay, let's do it", "No thanks", "Go ahead", "Sure.",
    "No, try another one", "No, book a new slot"]) assert.ok(N.isAnswer(yes), yes);
  for (const request of ["Find a taxi", "Yesterday's news", "Nobody told me", "Okapi facts", "What's next?", "Okay, separately, find me a taxi",
    "Yes, and also book a table", "Okay, so please spin up a coding agent to look at multitasking", "Sure, try another hotel", "No, different thing, find me a taxi"]) {
    assert.ok(!N.isAnswer(request), request);
  }
});

test("the model relays a result by what came of it", () => {
  const training = "I've started training \"Pennyworth\" on homelab. It should take roughly one to two hours.";
  assert.ok(N.relays("I've started training the Pennyworth model on your homelab, about two hours.", "wake word model", training));
  assert.ok(!N.relays("The Pennyworth wake word is underway.", "Pennyworth wake word", training));
  assert.ok(!N.relays("I'm still working on the Pennyworth training.", "Pennyworth training", "Training failed because the disk is full."));
  assert.ok(N.relays("The Pennyworth training failed: the disk is full.", "Pennyworth training", "Training failed because the disk is full."));
  assert.ok(!N.relays("Yes, that's correct. You can ask for something else.", "Pennyworth wake word", training));
  assert.ok(!N.relays("Hermes is working on it.", "taxi", "A taxi is on its way."));
  assert.ok(!N.relays("", "taxi", "A taxi is on its way."));
});
