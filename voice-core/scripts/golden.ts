// Writes scenarios/<name>.json (the recording: config and events) and <name>.golden.json (what
// the built bundle answers to each, the first entry being create's). Run `npm run build` first:
// the answers come from dist/voice-core.js in a bare JS context, as the hosts run it.

import { mkdirSync, writeFileSync } from "node:fs";
import { replay } from "../test/replay.ts";
import { scenarios } from "../test/scenarios.ts";

const dir = new URL("../scenarios/", import.meta.url);
mkdirSync(dir, { recursive: true });
for (const [name, make] of Object.entries(scenarios)) {
  const sim = make();
  const recording = { config: sim.config, start: 0, events: sim.events };
  const answers = replay(recording);
  writeFileSync(new URL(`${name}.json`, dir), JSON.stringify(recording, null, 1) + "\n");
  writeFileSync(new URL(`${name}.golden.json`, dir), answers.map((a) => a).join("\n") + "\n");
  console.log(`${name}: ${sim.events.length} events, ${answers.length} answers`);
}
