// A headless typed chat: types messages into a chat through the dev server (the core's
// `medium: "text"`, the same build and relay the web surface uses), against the real text model,
// and prints what happened. The typed counterpart of talk.ts.
//
//   node dev/chat.ts "What's the weather in Copenhagen?" ["And tomorrow?" ...] [--hermes] [--coding]
//                    [--preset android] [--server http://127.0.0.1:8770] [--quiet 2] [--max 120]
//
// Each message is typed once the model's turn before it has ended; "@<s>:message" types it <s>
// seconds after the previous one instead (while the model or a task is still working), and
// "@wait:message" once every task has finished. Hermes (and T3, with --coding) is faked (an answer
// after 2 s) unless --hermes. The chat ends --quiet seconds after the last message's turn and the
// last task, or after --max seconds.

import vm from "node:vm";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const SERVER = option("server", "http://127.0.0.1:8770");
const PRESET = option("preset", "web");
const QUIET = Number(option("quiet", "2"));
const MAX = Number(option("max", "120"));
const optionValues = new Set(["--server", "--preset", "--quiet", "--max"].filter((o) => args.includes(o)).map((o) => args[args.indexOf(o) + 1]));
const plan = args.filter((a) => !a.startsWith("--") && !optionValues.has(a)).map((a) => {
  const m = a.match(/^@([\d.]+|wait):([\s\S]*)$/);
  return m ? { at: m[1] === "wait" ? null : Number(m[1]), wait: m[1] === "wait", text: m[2] } : { at: null as number | null, wait: false, text: a };
});
if (plan.length === 0) { console.error("say what to type"); process.exit(2); }

const PRESETS: Record<string, Record<string, unknown>> = {
  web: { platform: "web", device: "browser" },
  android: { platform: "Android", device: "phone" },
};

const ACCESS: Record<string, string> = process.env.VOICE_CORE_ACCESS_ID
  ? { "CF-Access-Client-Id": process.env.VOICE_CORE_ACCESS_ID, "CF-Access-Client-Secret": process.env.VOICE_CORE_ACCESS_SECRET ?? "", "User-Agent": "Mozilla/5.0 voice-core-chat" }
  : {};
const get = (url: string, init: RequestInit = {}) => fetch(url, { ...init, headers: { ...ACCESS, ...(init.headers as Record<string, string> ?? {}) } });

const config = await (await get(`${SERVER}/config`)).json();
if (!config.textModel) { console.error("this server has no text model relay (/generate): run the dev server from this checkout"); process.exit(2); }
const context = vm.createContext({});
vm.runInContext(await (await get(`${SERVER}/voice-core.js`)).text(), context);
const core = context.VoiceCore;
console.log(`core ${core.version}, ${config.route} ${config.textModel}, preset ${PRESET}, Hermes ${flag("hermes") ? "real" : "fake"}`);

const t0 = performance.now() / 1000;
const now = () => performance.now() / 1000;
const say = (s: string) => console.log(`${(now() - t0).toFixed(2).padStart(6)}  ${s}`);
const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-chat-${core.version}`;
const running = new Set<string>();
const requests = new Map<number, AbortController>();
let chatId = 0, ended = false, thinking = false, idleSince = now(), typedAt = 0, next = 0, asked = 0;

function push(e: Record<string, unknown>) {
  if (ended) return;
  run(JSON.parse(core.push(chatId, JSON.stringify({ ...e, t: now() }))));
}

let modelLine = "", textLine = 0;
function flushLine() {
  if (modelLine) { say(`model: ${modelLine.trim()}`); modelLine = ""; }
}

function run(commands: Record<string, any>[]) {
  for (const c of commands) {
    switch (c.type) {
      case "llm.request": void generate(c.id, c.body); break;
      case "llm.cancel": requests.get(c.id)?.abort(); requests.delete(c.id); say("(request dropped)"); break;
      case "thinking":
        thinking = c.on;
        if (c.on) asked = now(); else { flushLine(); idleSince = now(); say(`(the model's turn took ${(now() - asked).toFixed(2)} s)`); }
        break;
      case "error": flushLine(); say(`error: ${c.message}`); break;
      case "transcript":
        if (c.line !== textLine) { flushLine(); textLine = c.line; }
        if (c.role === "assistant") modelLine += c.text;
        break;
      case "status": flushLine(); say(`[${c.status}${c.message ? ": " + c.message : ""}]`); if (c.status === "ended") finish(); break;
      case "task":
        if (c.state === "running") running.add(c.id); else { running.delete(c.id); idleSince = now(); }
        say(`task "${c.label}" ${c.state}${c.progress ? " · " + c.progress : ""}${c.question ? ", asks: " + c.question : ""}`);
        break;
      case "tool.call":
        flushLine();
        say(`${c.agent === "t3" ? "T3" : "Hermes"} ${c.followUp ? "follow-up" : "task"} "${c.label}"${c.project ? ` in ${c.project}` : ""}: ${c.request}`);
        if (flag("verbose")) say(`  message: ${c.message}`);
        if (flag("hermes")) void hermes(c);
        else setTimeout(() => push({ type: "tool.result", run: c.run, text: `(Fake ${c.agent === "t3" ? "T3" : "Hermes"}) Done: ${c.request}. Nothing was actually run.` }), 2000);
        break;
      case "tool.cancel": say(`(cancel ${c.run}: ${c.reason})`); break;
      case "tool.steer": say(`(steering: ${c.text})`); push({ type: "tool.steerFailed", run: c.run, text: c.text }); break;
      case "log": say(`(${c.level}: ${c.message})`); break;
    }
  }
}

/** The core's request to the text model, through the server: each `data:` line of the stream goes back as it comes. */
async function generate(id: number, body: string) {
  const abort = new AbortController();
  requests.set(id, abort);
  try {
    const response = await get(`${SERVER}/generate`, { method: "POST", headers: { "content-type": "application/json" }, body, signal: abort.signal });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      push({ type: "llm.end", id, status: response.status, error: `HTTP ${response.status}${text ? ": " + text.replace(/\s+/g, " ").slice(0, 200) : ""}` });
      return;
    }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let cut;
      while ((cut = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, cut).replace(/\r$/, "");
        buffer = buffer.slice(cut + 1);
        if (line.startsWith("data:")) push({ type: "llm.data", id, data: line.slice(5).trim() });
      }
    }
    push({ type: "llm.end", id });
  } catch (err) {
    if (!abort.signal.aborted) push({ type: "llm.end", id, error: (err as Error).message });
  } finally {
    requests.delete(id);
  }
}

async function hermes(c: Record<string, any>) {
  const who = c.agent === "t3" ? "T3" : "Hermes";
  const response = await get(`${SERVER}/${c.agent === "t3" ? "agent" : "hermes"}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ call: name, taskId: c.taskId, followUp: c.followUp, message: c.message, label: c.label, request: c.request, project: c.project }),
  });
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let cut;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const event = block.match(/^event: (.*)$/m)?.[1];
      if (!event) continue;
      const data = JSON.parse(block.match(/^data: (.*)$/m)?.[1] ?? "{}");
      if (event === "progress") { say(`(${who}: ${data.text.slice(0, 120)})`); push({ type: "task.progress", task: c.taskId, text: data.text }); }
      if (event === "result") { say(`${who}: ${data.text.slice(0, 300)}`); push({ type: "tool.result", run: c.run, text: data.text, failed: data.failed }); }
      if (event === "error") push({ type: "tool.error", run: c.run, message: data.message });
    }
  }
}

function finish() {
  if (ended) return;
  ended = true;
  const trace = JSON.parse(core.trace(chatId));
  const lines = [JSON.stringify({ version: trace.version, config: trace.config, start: trace.start }), ...trace.events.map((e: unknown) => JSON.stringify(e))];
  void get(`${SERVER}/traces?name=${name}.jsonl`, { method: "POST", body: lines.join("\n") + "\n" }).then(() => {
    say(`trace: traces/${name}.jsonl (replay it in the web surface)`);
    setTimeout(() => process.exit(0), 100);
  });
}

const created = JSON.parse(core.create(JSON.stringify({
  medium: "text", today: new Date().toISOString().slice(0, 10), trace: true, ...PRESETS[PRESET],
  ...(flag("coding") ? { codingAgent: { projects: config.t3 ?? [] } } : {}),
}), now()));
chatId = created.id;
run(created.commands);

setInterval(() => {
  if (ended) return;
  push({ type: "tick" });
  const t = now();
  if (next < plan.length) {
    const step = plan[next];
    const due = step.at != null ? typedAt > 0 && t - typedAt >= step.at
      : step.wait ? !thinking && running.size === 0 && t - idleSince > 0.5
      : !thinking && (next === 0 || t - idleSince > 0.5);
    if (due) { next++; typedAt = t; say(`you: ${step.text}`); push({ type: "say", text: step.text }); }
    return;
  }
  if ((!thinking && running.size === 0 && t - Math.max(idleSince, typedAt) > QUIET) || t - t0 > MAX) push({ type: "stop" });
}, 100);
