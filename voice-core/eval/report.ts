// Tables from finished runs: one suite's scenarios, or two suites side by side.
//
//   node eval/report.ts runs/baseline [runs/candidate] [--judge]
//
// Each scenario's numbers are means over its repeats. The score is 100 less the penalties in
// metrics.ts; the judge's (0 to 10, judge.ts) is reported beside it, never mixed in.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { judge, type Verdict } from "./judge.ts";
import { loadRun, score, type Metrics } from "./metrics.ts";

interface Row { scenario: string; runs: number; score: number; spread: number; collisions: number; lost: number; repeated: number; unscripted: number; failedChecks: number; checks: number; ambient: number; reply: number | null; announce: number | null; words: number; connected: number; judge: number | null; timeouts: number }

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);

export async function collect(dir: string, o: { judge?: boolean } = {}): Promise<{ rows: Row[]; runs: { dir: string; metrics: Metrics; verdict: Verdict | null }[] }> {
  const runs: { dir: string; metrics: Metrics; verdict: Verdict | null }[] = [];
  const dirs = readdirSync(dir).map((d) => join(dir, d)).filter((d) => existsSync(join(d, "log.jsonl"))).sort();
  await Promise.all(dirs.map(async (d) => {
    const { log, scenario } = loadRun(d);
    const metrics = score(log, scenario);
    writeFileSync(join(d, "metrics.json"), JSON.stringify(metrics, null, 1));
    let verdict: Verdict | null = null;
    const cached = join(d, "judge.json");
    if (existsSync(cached)) verdict = JSON.parse(readFileSync(cached, "utf8"));
    else if (o.judge) { verdict = await judge(log, scenario).catch((err) => { console.error(`judge failed for ${d}: ${err.message}`); return null; }); if (verdict) writeFileSync(cached, JSON.stringify(verdict, null, 1)); }
    runs.push({ dir: d, metrics, verdict });
  }));
  runs.sort((a, b) => a.dir.localeCompare(b.dir));
  const by = new Map<string, typeof runs>();
  for (const r of runs) by.set(r.metrics.scenario, [...(by.get(r.metrics.scenario) ?? []), r]);
  const rows: Row[] = [...by.entries()].map(([scenario, rs]) => {
    const ms = rs.map((r) => r.metrics);
    const scores = ms.map((m) => m.score);
    const verdicts = rs.map((r) => r.verdict?.overall).filter((v): v is number => typeof v === "number");
    return {
      scenario, runs: rs.length,
      score: mean(scores), spread: Math.max(...scores) - Math.min(...scores),
      collisions: mean(ms.map((m) => m.turnCollisions)),
      lost: mean(ms.map((m) => m.lostResults)),
      repeated: mean(ms.map((m) => m.repeatedResults)),
      unscripted: mean(ms.map((m) => m.unscriptedDispatches)),
      failedChecks: mean(ms.map((m) => m.checks.filter((c) => !c.pass).length)),
      checks: ms[0].checks.length,
      ambient: mean(ms.map((m) => m.ambientSpeechSeconds)),
      reply: median(ms.flatMap((m) => m.replyLatency)),
      announce: median(ms.flatMap((m) => m.announcements.map((a) => a.delay).filter((d): d is number => d != null))),
      words: mean(ms.map((m) => m.modelWords)),
      connected: mean(ms.map((m) => m.connectedSeconds / Math.max(1, m.callSeconds))),
      judge: verdicts.length ? mean(verdicts) : null,
      timeouts: mean(ms.map((m) => m.timeouts.length)),
    };
  });
  return { rows, runs };
}

const f = (v: number | null, d = 1) => (v == null ? "-" : v.toFixed(d));

function table(rows: Row[]): string {
  const head = ["scenario", "n", "score", "±", "collide", "lost", "repeat", "stray", "checks", "ambient s", "reply s", "announce s", "words", "judge"];
  const body = rows.map((r) => [r.scenario, String(r.runs), f(r.score, 0), f(r.spread, 0), f(r.collisions), f(r.lost), f(r.repeated), f(r.unscripted), `${f(r.checks - r.failedChecks, 1)}/${r.checks}`, f(r.ambient), f(r.reply, 2), f(r.announce), f(r.words, 0), f(r.judge)]);
  const total = ["ALL", String(rows.reduce((n, r) => n + r.runs, 0)), f(mean(rows.map((r) => r.score)), 1), "", f(rows.reduce((n, r) => n + r.collisions, 0)), f(rows.reduce((n, r) => n + r.lost, 0)), f(rows.reduce((n, r) => n + r.repeated, 0)), f(rows.reduce((n, r) => n + r.unscripted, 0)),
    `${f(rows.reduce((n, r) => n + r.checks - r.failedChecks, 0))}/${rows.reduce((n, r) => n + r.checks, 0)}`, f(rows.reduce((n, r) => n + r.ambient, 0)), f(median(rows.map((r) => r.reply).filter((v): v is number => v != null)), 2), f(median(rows.map((r) => r.announce).filter((v): v is number => v != null))), f(rows.reduce((n, r) => n + r.words, 0), 0),
    f(rows.some((r) => r.judge != null) ? mean(rows.map((r) => r.judge).filter((v): v is number => v != null)) : null)];
  const all = [head, ...body, total];
  const width = head.map((_, i) => Math.max(...all.map((row) => row[i].length)));
  return all.map((row) => row.map((c, i) => (i === 0 ? c.padEnd(width[i]) : c.padStart(width[i]))).join("  ")).join("\n");
}

export async function report(dirs: string[], o: { judge?: boolean } = {}): Promise<string> {
  const suites = await Promise.all(dirs.map((d) => collect(d, o)));
  const out: string[] = [];
  suites.forEach((s, i) => {
    out.push(`== ${dirs[i]}`, table(s.rows), "");
    writeFileSync(join(dirs[i], "report.json"), JSON.stringify(s.rows, null, 1));
    const failed = s.runs.flatMap((r) => r.metrics.checks.filter((c) => !c.pass).map((c) => `  ${r.dir.split("/").pop()}: ${JSON.stringify(c.check)} (${c.why.slice(0, 140)})`));
    if (failed.length) out.push("failed checks:", ...failed, "");
  });
  if (suites.length === 2) {
    const [a, b] = suites;
    out.push(`== ${dirs[1]} against ${dirs[0]} (score, by scenario)`);
    for (const rb of b.rows) {
      const ra = a.rows.find((r) => r.scenario === rb.scenario);
      if (!ra) continue;
      const d = rb.score - ra.score;
      out.push(`${rb.scenario.padEnd(32)} ${f(ra.score, 0).padStart(4)} -> ${f(rb.score, 0).padStart(4)}  ${d >= 0 ? "+" : ""}${f(d, 0)}${ra.judge != null && rb.judge != null ? `   judge ${f(ra.judge)} -> ${f(rb.judge)}` : ""}`);
    }
  }
  return out.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dirs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  console.log(await report(dirs, { judge: process.argv.includes("--judge") }));
  process.exit(0);
}
