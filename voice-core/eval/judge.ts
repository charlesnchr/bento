// A text model reads the call as a person would have heard it and grades it against a rubric.
// The judge is on GSK Vertex (vertex.ts). Its grades sit beside the trace metrics, never in them:
// the metrics say what happened, the judge says how it came across.

import type { Rec, Scenario } from "./run.ts";
import { readable } from "./metrics.ts";
import { generate } from "./vertex.ts";

export interface Verdict {
  /** 0 to 10 each. */
  flow: number;
  brevity: number;
  accuracy: number;
  supervision: number;
  overall: number;
  /** The scenario's own questions, answered yes or no. */
  answers: { question: string; pass: boolean; why: string }[];
  worst: string;
}

const RUBRIC = `You grade a voice assistant from the timeline of one call. The user talks to a voice front end that hands
work to background agents (lines starting "->") and relays their results (lines starting "<-") when they arrive. Times are
seconds. "cut off" means the user spoke over the assistant and it stopped. AMBIENT lines are speech not addressed to the
assistant (a TV, the user talking to someone else): it should say and do nothing about them.

Grade 0 to 10 (10 is what an excellent human assistant on the phone would do):
- flow: turn-taking. Did the assistant answer what the user had just said before anything else? Did results from agents
  arrive at natural pauses, or did they cut across the user or the topic? Penalise speaking as the user starts, abandoned
  starts ("By the way, the first" then cut off), dead air, and making the user repeat themselves.
- brevity: said what was needed and no more. Penalise filler, saying a result twice, reading long results out in full,
  announcing that work has started when a tone already says so.
- accuracy: everything it said about results and task states was true to what the agents returned and what was running.
  Penalise invented status, wrong numbers, claiming something finished that had not.
- supervision: requests went to the right place: a new task for a new request, a follow-up to the task it belongs to,
  cancel and steer to the task meant, nothing started that the user did not ask for.
- overall: your judgement of the whole call as the user experienced it.
Use the full range. A call with a result repeated or a user turn cut across is not above 6 for flow.`;

export async function judge(log: Rec[], scenario: Scenario): Promise<Verdict> {
  const questions = scenario.judge ?? [];
  const prompt = `${RUBRIC}

What this call was meant to test: ${scenario.about}

${questions.length ? `Also answer each of these yes or no, from the timeline alone:\n${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}\n` : ""}
Timeline:
${readable(log)}

Reply with JSON only: {"flow": n, "brevity": n, "accuracy": n, "supervision": n, "overall": n, ${questions.length ? `"answers": [{"pass": true, "why": "..."}] (one per question, in order), ` : ""}"worst": "the single worst moment, in one sentence, with its time"}`;
  const text = await generate(prompt, { json: true });
  const v = JSON.parse(text) as Verdict;
  for (const k of ["flow", "brevity", "accuracy", "supervision", "overall"] as const) if (typeof v[k] !== "number") throw new Error(`the judge left out ${k}`);
  // Only the scenario's own questions count: with none asked, whatever the judge volunteered is dropped.
  const given = Array.isArray(v.answers) ? v.answers : [];
  if (questions.length > 0 && given.length !== questions.length) throw new Error(`the judge answered ${given.length} of ${questions.length} questions`);
  v.answers = questions.map((question, i) => ({ question, pass: given[i].pass === true, why: String(given[i].why ?? "") }));
  return v;
}
