// Runs scenarios against one build of the core, several calls at a time, and reports.
//
//   node eval/suite.ts --name baseline [--scenarios a,b] [--repeat 3] [--parallel 4]
//                      [--bundle dist/voice-core.js] [--config '{"…"}'] [--judge]
//
// Runs go to eval/runs/<name>/<scenario>-<n>/. A run that already has a log is kept, so a suite
// that was interrupted carries on where it stopped; --fresh runs everything again.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { report } from "./report.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const name = option("name", new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-"));
const repeat = Number(option("repeat", "1"));
const parallel = Number(option("parallel", "4"));
const bundle = option("bundle", join(root, "dist/voice-core.js"));
const config = option("config", "{}");
const dir = join(root, "eval/scenarios");
const wanted = option("scenarios", "");
const scenarios = wanted ? wanted.split(",") : readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
const out = join(root, "eval/runs", name);
mkdirSync(out, { recursive: true });

const jobs: { scenario: string; n: number; dir: string }[] = [];
for (let n = 1; n <= repeat; n++) for (const scenario of scenarios) jobs.push({ scenario, n, dir: join(out, `${scenario}-${n}`) });

function run(job: { scenario: string; n: number; dir: string }): Promise<void> {
  if (args.includes("--fresh")) rmSync(job.dir, { recursive: true, force: true });
  if (existsSync(join(job.dir, "log.jsonl"))) return Promise.resolve();
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(root, "eval/run.ts"), join(dir, `${job.scenario}.json`), "--out", job.dir, "--bundle", bundle, "--config", config, "--quietly", ...(args.includes("--audio") ? ["--audio"] : [])], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => { err += d; });
    child.on("exit", (code) => {
      console.log(`${job.scenario}-${job.n}: ${code === 0 ? "done" : "FAILED " + err.trim().split("\n").slice(-2).join(" | ")} in ${Math.round((Date.now() - started) / 1000)}s`);
      done();
    });
  });
}

let next = 0;
await Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, async () => {
  while (next < jobs.length) await run(jobs[next++]);
}));
console.log(await report([out], { judge: args.includes("--judge") }));
process.exit(0);
