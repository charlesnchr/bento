// The built bundle answers every recorded scenario exactly as its golden file says. A failure
// here after a change in src/ means behaviour changed: rerun `npm run golden` if you meant it,
// and read the diff. The Kotlin, Swift and Python hosts run the same files through their engines.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { replay } from "./replay.ts";
import { scenarios } from "./scenarios.ts";

const dir = new URL("../scenarios/", import.meta.url);

for (const file of readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".golden.json"))) {
  const name = file.slice(0, -5);
  test(`scenario ${name} answers as its golden file says`, () => {
    const recording = JSON.parse(readFileSync(new URL(file, dir), "utf8"));
    const golden = readFileSync(new URL(`${name}.golden.json`, dir), "utf8").trimEnd().split("\n");
    const answers = replay(recording);
    assert.equal(answers.length, golden.length);
    answers.forEach((a, i) => assert.equal(a, golden[i], `${name}: answer ${i} differs`));
  });
}

test("every scenario script has its recording", () => {
  const files = new Set(readdirSync(dir));
  for (const name of Object.keys(scenarios)) assert.ok(files.has(`${name}.json`), `${name}: run npm run golden`);
});
