// The coding agent: T3 Code threads, run through the `t3` CLI of the T3 service on this machine.
// A task's first request starts a thread (in a new worktree when the project is a git repo), a
// follow-up sends the thread another message, and the result is the agent's last message once its
// run ends. Cancelling interrupts the run, and steering adds to it, over T3's WebSocket; a call that
// hangs up only stops watching, so the agent carries on in T3.

import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import WebSocket from "ws";

const run = promisify(execFile);
const T3HOME = process.env.T3CODE_HOME ?? join(os.homedir(), ".t3");
const DB = join(T3HOME, "userdata/statev2.sqlite");
const WS = process.env.T3_WS_URL ?? "ws://127.0.0.1:3773/ws?orchestrationProtocol=2";
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
/** Threads started from calls, newest last, for the page's list of earlier coding tasks. */
let started = Object.values(threads).map((thread) => ({ thread, at: 0 }));
function remember(key, thread) {
  threads[key] = thread;
  started = [...started.filter((s) => s.thread !== thread), { thread, at: Date.now() }].slice(-50);
  try { writeFileSync(STORE, JSON.stringify(threads)); } catch {}
}

/** The latest threads calls started, newest first, with how each is doing. */
export async function recent(limit = 8) {
  const picked = [...started].reverse().slice(0, limit);
  const out = await Promise.all(picked.map(async ({ thread }) => {
    try {
      const { thread: t, messages } = await show(thread, 1);
      if (t.archived) return null;
      const pr = t.linkedPullRequest?.url ?? t.pullRequests?.at(-1)?.url ?? null;
      return {
        thread, title: t.title, status: t.activeRunId != null ? "running" : t.status, branch: t.branch ?? null, pr,
        updated: t.updatedAt, last: (messages.filter((m) => m.role === "assistant").at(-1)?.text ?? "").slice(0, 600),
        waiting: t.pendingRequestCount > 0,
      };
    } catch {
      return null;
    }
  }));
  return out.filter((t) => t != null);
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
  const since = Date.now();
  for (;;) {
    await sleep(POLL, signal);
    const { thread: t, messages } = await show(thread, 3);
    const started = t.latestRunId != null && t.latestRunId !== before;
    if (!started && Date.now() - since > 120_000) throw new Error("the T3 thread never started working on it");
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

// Steering and interrupting go over T3's own WebSocket protocol, as its app does, with a user
// session: its MCP endpoint caps a client without a thread at approval-required, below the
// threads' full access, so it refuses to touch them.

/** Interrupts the task's thread's running turn: the cancel button, or cancel_task. */
export async function cancel(body) {
  const thread = body.thread ?? threads[`${body.call}/${body.taskId}`];
  const run = thread && (await show(thread, 1)).thread.activeRunId;
  if (!run) return false;
  await dispatch({ type: "run.interrupt", commandId: randomUUID(), threadId: thread, runId: run, reason: "Cancelled from the voice call" });
  return true;
}

/** More for the task's running turn, without restarting it. */
export async function steer(body) {
  const thread = threads[`${body.call}/${body.taskId}`];
  const run = thread && (await show(thread, 1)).thread.activeRunId;
  if (!run) return false;
  await dispatch({
    type: "message.dispatch", commandId: randomUUID(), threadId: thread, messageId: randomUUID(), text: body.text, attachments: [],
    createdBy: "user", creationSource: "web", deliveryIntent: "steer", dispatchMode: { type: "steer_active", targetRunId: run },
  });
  return true;
}

let session = null;
async function dispatch(command) {
  session ??= (await t3(["auth", "session", "issue", "--ttl", "12h", "--label", "voice-core", "--token-only"])).trim();
  const ws = new WebSocket(WS, { headers: { Authorization: `Bearer ${session}` } });
  try {
    await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); ws.once("unexpected-response", (_, r) => reject(new Error(`HTTP ${r.statusCode}`))); });
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("T3 didn't answer")), 15_000);
      ws.on("message", (data) => {
        const m = JSON.parse(data.toString());
        if (m.requestId === "1" || m.id === "1") { clearTimeout(timer); resolve(m); }
      });
      ws.send(JSON.stringify({ _tag: "Request", id: "1", tag: "orchestration.dispatchCommand", headers: [], payload: command }));
    });
    const ok = reply._tag === "Exit" && reply.exit?._tag === "Success";
    if (!ok) throw new Error(`T3 refused ${command.type}: ${JSON.stringify(reply).slice(0, 300)}`);
    return reply;
  } catch (err) {
    if (/HTTP 401|HTTP 403/.test(err.message)) session = null;
    throw err;
  } finally {
    ws.close();
  }
}
