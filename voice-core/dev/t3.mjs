// The coding agent: T3 Code threads, run through the `t3` CLI of the T3 service on this machine.
// A task's first request starts a thread (in a new worktree when the project is a git repo), a
// follow-up sends the thread another message, and the result is the agent's last message once its
// run ends. Cancelling interrupts the run through T3's MCP endpoint; a call that hangs up only
// stops watching, so the agent carries on in T3.

import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const T3HOME = process.env.T3CODE_HOME ?? join(os.homedir(), ".t3");
const DB = join(T3HOME, "userdata/statev2.sqlite");
const MCP = process.env.T3_MCP_URL ?? "http://127.0.0.1:3773/mcp";
const POLL = 2.5;

export function available() {
  return existsSync(join(T3HOME, "runtime/service-state.json")) && existsSync(DB);
}

function binary() {
  const { activeVersion } = JSON.parse(readFileSync(join(T3HOME, "runtime/service-state.json"), "utf8"));
  return join(T3HOME, "runtime/versions", activeVersion, "t3");
}

async function t3(args, input) {
  const child = run(binary(), args, { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 });
  if (input != null) { child.child.stdin.write(input); child.child.stdin.end(); }
  const { stdout } = await child;
  return stdout;
}

/** The registered projects, newest first: `{ title, path }`. */
export async function projects() {
  const { stdout } = await run("sqlite3", ["-json", `file:${DB}?mode=ro`,
    "select title, workspace_root as path from projection_projects where deleted_at is null order by updated_at desc"]);
  return JSON.parse(stdout || "[]").filter((p) => p.path !== join(T3HOME, "scratch") && !/smoke/i.test(p.title));
}

/** The project the model named, by title (exact, then partial); Scratchpad when it named none or none matches. */
async function project(name) {
  const all = await projects();
  const q = (name ?? "").trim().toLowerCase();
  const hit = q && (all.find((p) => p.title.toLowerCase() === q) ?? all.find((p) => p.title.toLowerCase().includes(q) || q.includes(p.title.toLowerCase())));
  return hit ?? all.find((p) => p.title === "Scratchpad") ?? all[0];
}

async function baseBranch(path) {
  try {
    const { stdout } = await run("git", ["-C", path, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    return stdout.trim().replace(/^origin\//, "");
  } catch {}
  try {
    const { stdout } = await run("git", ["-C", path, "rev-parse", "--abbrev-ref", "HEAD"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "task";
}

async function show(thread, messages = 3) {
  return JSON.parse(await t3(["thread", "show", "--json", "--messages", String(messages), thread]));
}

// Threads by call and task, so a follow-up continues its task's thread, kept across restarts.
const STORE = join(os.homedir(), ".local/share/voice-core/t3-threads.json");
let threads = {};
try { threads = JSON.parse(readFileSync(STORE, "utf8")); } catch {}
function remember(key, thread) {
  threads[key] = thread;
  try { writeFileSync(STORE, JSON.stringify(threads)); } catch {}
}

/**
 * Runs one request of a coding task: `send(event, data)` gets `progress`, `thread` and finally
 * `result` (or throws). [signal] stops the watching, not the agent.
 */
export async function runTask(body, send, signal) {
  const key = `${body.call}/${body.taskId}`;
  let thread = body.followUp ? threads[key] : null;
  let before = null;
  let where;
  if (thread) {
    before = (await show(thread, 1)).thread.latestRunId;
    await t3(["thread", "send", thread, "-"], body.message);
    send("progress", { text: "Sent to its T3 thread" });
  } else {
    const p = await project(body.project);
    if (!p) throw new Error("T3 has no projects");
    const args = ["thread", "start", p.path, "-", "--title", body.label || "Voice task", "--json"];
    const base = await baseBranch(p.path);
    const branch = base ? `voice/${slug(body.label || body.request || "task")}-${Date.now().toString(36).slice(-4)}` : null;
    if (base) args.push("--worktree", base, "--branch", branch);
    const out = await t3(args, body.message);
    thread = JSON.parse(out.trim().split("\n").at(-1)).threadId ?? JSON.parse(out).thread?.threadId;
    if (!thread) throw new Error("T3 didn't say which thread it started");
    remember(key, thread);
    where = `${p.title}${branch ? `, branch ${branch}` : ""}`;
    send("progress", { text: `Started in ${where}` });
  }
  send("thread", { thread });
  let said = "";
  for (;;) {
    await sleep(POLL, signal);
    const { thread: t, messages } = await show(thread, 3);
    const started = t.latestRunId != null && t.latestRunId !== before;
    const last = messages.filter((m) => m.role === "assistant" && m.runId === t.latestRunId).at(-1)?.text ?? "";
    if (started && last && last !== said) {
      said = last;
      send("progress", { text: last.replace(/\s+/g, " ").slice(0, 200) });
    }
    if (t.pendingRequestCount > 0 && said !== "approval") {
      said = "approval";
      send("progress", { text: "Waiting for approval in T3" });
    }
    if (started && t.activeRunId == null && !["running", "starting", "queued"].includes(t.status)) {
      const outcome = t.status === "failed" ? "The coding agent's run failed. " : t.status === "interrupted" ? "The coding agent was interrupted. " : "";
      const pr = t.linkedPullRequest?.url ?? t.pullRequests?.at(-1)?.url;
      send("result", {
        text: outcome + (last || "The coding agent finished without a message.") +
          `\n\n(T3 thread "${t.title}"${where ? ` in ${where}` : ""}${pr ? `, pull request ${pr}` : ""}.)`,
        failed: t.status === "failed",
      });
      return;
    }
  }
}

function sleep(seconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(resolve, seconds * 1000);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
  });
}

/** Interrupts the task's thread's running turn: the cancel button, or cancel_task. */
export async function cancel(body) {
  const thread = body.thread ?? threads[`${body.call}/${body.taskId}`];
  if (!thread) return false;
  await mcpCall("t3_thread_interrupt", { threadId: thread, reason: "Cancelled from the voice call" });
  return true;
}

let mcp = null;
async function mcpCall(name, args) {
  if (!mcp) {
    const token = (await t3(["auth", "session", "issue", "--ttl", "12h", "--subject", "mcp-client", "--label", "voice-core", "--token-only"])).trim();
    mcp = { token, session: null, id: 1 };
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "voice-core", version: "1" } });
    await rpc("notifications/initialized", undefined, true);
  }
  return rpc("tools/call", { name, arguments: args });
}

async function rpc(method, params, notification = false) {
  const headers = { Authorization: `Bearer ${mcp.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (mcp.session) headers["mcp-session-id"] = mcp.session;
  const message = notification ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", id: mcp.id++, method, params };
  const r = await fetch(MCP, { method: "POST", headers, body: JSON.stringify(message) });
  mcp.session = r.headers.get("mcp-session-id") ?? mcp.session;
  if (!r.ok && r.status !== 202) { const text = await r.text(); mcp = null; throw new Error(`T3 MCP ${method}: HTTP ${r.status} ${text.slice(0, 200)}`); }
  if (notification) return null;
  const text = await r.text();
  const json = text.trimStart().startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").filter((l) => l.startsWith("data:")).at(-1).slice(5));
  if (json.error) throw new Error(`T3 MCP ${method}: ${json.error.message}`);
  return json.result;
}
