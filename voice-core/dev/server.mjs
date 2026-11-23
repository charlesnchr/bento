// The dev server: the web surface, the core's latest build for every host, and the services a
// browser can't reach itself.
//
//   GET  /                  the web surface (web/index.html)
//   GET  /voice-core.js     dist/voice-core.js, rebuilt whenever src/ changes; Android, the Mac and
//                           the Echo can load it from here too, to try a change without a release
//   GET  /events            server-sent events: `core` with the new version after each rebuild
//   GET  /config            the model and what's available (route, Hermes)
//   WS   /live              a Gemini Live socket, relayed with the server's credentials;
//                           /live?for=captions goes to the transcription model (the core's captions)
//   POST /generate          a typed chat's request to its text model (the core's `llm.request`), relayed
//                           the same way and streamed back as the model's server-sent events
//   POST /hermes            one Hermes request, streamed back as server-sent events
//   POST /hermes/steer      more for a running Hermes task; /hermes/stop stops it;
//                           /hermes/approval answers a command Hermes asked to run (the page's
//                           requests ask for approvals with `approvals: "screen"`; others deny them)
//   POST /agent             one coding-agent (T3 Code) request, streamed back the same way
//   POST /agent/cancel      interrupts a coding task's T3 thread; /agent/steer adds to its running turn
//   GET  /ping              for the page's round-trip time
//   POST /traces            a call's recording, appended in pieces; GET /traces lists them
//
//   node dev/server.mjs [--port 8770] [--host 127.0.0.1]
//
// Credentials come from ~/.hermes/.env and never reach the browser. The model route is GSK Vertex
// through the GSK SOCKS route (VERTEX_CREDENTIALS_PATH, VERTEX_PROJECT_ID), or the public Gemini
// API with VOICE_CORE_ROUTE=gemini and GEMINI_API_KEY in the environment (that one is personal
// money: set it on purpose). Hermes is the API server in ~/.hermes/.env (API_SERVER_*).

import { createServer } from "node:http";
import https from "node:https";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, watch, writeFileSync } from "node:fs";
import os from "node:os";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { SocksProxyAgent } from "socks-proxy-agent";
import WebSocket, { WebSocketServer } from "ws";
import { build, OUT } from "../scripts/build.mjs";
import { envFile, serviceAccount } from "./google.mjs";
import { chatRequestBody, DEFAULT_REASONING_EFFORT } from "./hermes.mjs";
import * as T3 from "./t3.mjs";
import { discoverWakeModels } from "./wakeModels.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const PORT = Number(arg("port", process.env.VOICE_CORE_PORT ?? 8770));
const HOST = arg("host", process.env.VOICE_CORE_HOST ?? "127.0.0.1");
const hermesEnv = envFile(join(os.homedir(), ".hermes/.env"));
const ROUTE = process.env.VOICE_CORE_ROUTE ?? (process.env.GEMINI_API_KEY ? "gemini" : "vertex");
const SOCKS = process.env.VOICE_CORE_SOCKS ?? "socks5h://127.0.0.1:11080";
const LOCATION = process.env.VOICE_CORE_LOCATION ?? "us-central1"; // 3.8 Live has no global endpoint
const LIVE_MODEL = "gemini-3.8-live";
const CAPTIONS_MODEL = "gemini-3.5-transcribe-live";
const CAPTIONS_LOCATION = "global"; // us-central1 doesn't serve it (2026-11-22)
/** The text model a typed chat runs on (the core's `medium: "text"`), at the global endpoint. */
const TEXT_MODEL = process.env.VOICE_CORE_TEXT_MODEL ?? "gemini-3.8-flash";
const TRACES = join(root, "traces");
const ORT_DIR = join(root, "node_modules/onnxruntime-web/dist");
const wakeModels = discoverWakeModels({
  extraDir: process.env.VOICE_CORE_WAKE_DIR || null,
  repoDir: join(root, "../android/app/src/main/assets/wakeword"),
  lkwwDir: join(os.homedir(), "workspace/home-assistant/wakeword/models/lkww"),
});

// The model route.

let vertex = null;
let model = `models/${LIVE_MODEL}`;
let captionsModel = `models/${CAPTIONS_MODEL}`;
if (ROUTE === "vertex") {
  const path = (hermesEnv.VERTEX_CREDENTIALS_PATH ?? "").replace(/^~/, os.homedir());
  if (!path || !existsSync(path)) throw new Error("VERTEX_CREDENTIALS_PATH in ~/.hermes/.env doesn't name a key file");
  vertex = serviceAccount(path);
  model = `projects/${hermesEnv.VERTEX_PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${LIVE_MODEL}`;
  captionsModel = `projects/${hermesEnv.VERTEX_PROJECT_ID}/locations/${CAPTIONS_LOCATION}/publishers/google/models/${CAPTIONS_MODEL}`;
}

/** A socket to the Live model, or with [captions] to the transcription model. */
async function upstream(captions = false) {
  if (ROUTE === "vertex") {
    const host = captions ? "aiplatform.googleapis.com" : `${LOCATION}-aiplatform.googleapis.com`;
    return new WebSocket(`wss://${host}/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent`, {
      headers: { Authorization: `Bearer ${await vertex.token()}` },
      agent: new SocksProxyAgent(SOCKS),
      maxPayload: 8 * 1024 * 1024,
    });
  }
  return new WebSocket("wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent", {
    headers: { "x-goog-api-key": process.env.GEMINI_API_KEY },
    maxPayload: 8 * 1024 * 1024,
  });
}

/** POST /generate: a `generateContent` request for the text model, answered as its stream of server-sent events. */
async function generate(req, res) {
  const body = await read(req);
  const url = ROUTE === "vertex"
    ? `https://aiplatform.googleapis.com/v1/projects/${hermesEnv.VERTEX_PROJECT_ID}/locations/global/publishers/google/models/${TEXT_MODEL}:streamGenerateContent?alt=sse`
    : `https://generativelanguage.googleapis.com/v1beta/models/${TEXT_MODEL}:streamGenerateContent?alt=sse`;
  const headers = { "content-type": "application/json", ...(ROUTE === "vertex" ? { Authorization: `Bearer ${await vertex.token()}` } : { "x-goog-api-key": process.env.GEMINI_API_KEY }) };
  const far = https.request(url, { method: "POST", headers, agent: ROUTE === "vertex" ? new SocksProxyAgent(SOCKS) : undefined, timeout: 120_000 }, (r) => {
    // The model's status and body as they are: the core reads an error out of either.
    res.writeHead(r.statusCode ?? 502, { "content-type": r.headers["content-type"] ?? "text/event-stream", "cache-control": "no-store" });
    r.pipe(res);
  });
  far.on("timeout", () => far.destroy(new Error("the model timed out")));
  far.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(err.message);
  });
  res.on("close", () => far.destroy());
  far.end(body);
}

// Hermes.

const HERMES_URL = process.env.HERMES_API_URL ?? (hermesEnv.API_SERVER_PORT ? `http://${hermesEnv.API_SERVER_HOST ?? "127.0.0.1"}:${hermesEnv.API_SERVER_PORT}` : null);
const HERMES_KEY = process.env.HERMES_API_KEY ?? hermesEnv.API_SERVER_KEY;
const HERMES_REASONING_EFFORT = process.env.VOICE_CORE_HERMES_REASONING_EFFORT ?? DEFAULT_REASONING_EFFORT;
/** Hermes sessions by call and task: a follow-up continues its task's session. */
const sessions = new Map();
/** The Hermes run each call's task is on, while it runs: what steer and stop act on. */
const hermesRuns = new Map();
/** Approvals the page was asked for, by call and task. */
const approvals = new Map();
const APPROVAL_WAIT = 180;

async function approve(key, choice, why) {
  const pending = approvals.get(key);
  if (!pending) return false;
  approvals.delete(key);
  clearTimeout(pending.timer);
  const r = await fetch(`${HERMES_URL}/v1/runs/${encodeURIComponent(pending.run)}/approval`, {
    method: "POST", headers: { Authorization: `Bearer ${HERMES_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(pending.request ? { choice, request_id: pending.request } : { choice }),
  }).catch((err) => ({ ok: false, status: 502, text: async () => err.message }));
  if (!r.ok) console.error(`Hermes approval ${choice} (${why}): HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.ok;
}

async function hermes(req, res) {
  const body = JSON.parse(await read(req));
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  const send = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  const abort = new AbortController();
  // The request's own "close" has long fired once its body is read: the response's says the page left.
  res.on("close", () => abort.abort());
  const ping = setInterval(() => { if (!res.writableEnded) res.write(": ping\n\n"); }, 20_000);
  res.on("close", () => clearInterval(ping));
  const headers = { Authorization: `Bearer ${HERMES_KEY}`, "content-type": "application/json" };
  let key = null;
  try {
    if (!HERMES_URL) throw new Error("no Hermes API server in ~/.hermes/.env");
    key = `${body.call}/${body.taskId}`;
    let session = body.followUp ? sessions.get(key) : null;
    const chatBody = chatRequestBody(body, {
      defaultEffort: HERMES_REASONING_EFFORT,
      sessionModelOptions: session ? (session.modelOptions ?? {}) : null,
    });
    if (!session) {
      const r = await fetch(`${HERMES_URL}/api/sessions`, { method: "POST", headers, body: JSON.stringify({ source: "api_server" }), signal: abort.signal });
      if (!r.ok) throw new Error(`Hermes couldn't start a session: HTTP ${r.status}`);
      session = { id: (await r.json()).session.id, modelOptions: chatBody.model_options ?? {} };
      sessions.set(key, session);
    }
    const r = await fetch(`${HERMES_URL}/api/sessions/${session.id}/chat/stream`, {
      method: "POST", headers: { ...headers, Accept: "text/event-stream" }, body: JSON.stringify(chatBody), signal: abort.signal,
    });
    if (!r.ok) throw new Error(`Hermes refused the request: HTTP ${r.status}`);
    let answer = "", status = "", ev = null, buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of r.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (line.startsWith("event:")) { ev = line.slice(6).trim(); continue; }
        if (!line.startsWith("data:")) continue;
        let o = {};
        try { o = JSON.parse(line.slice(5).trim() || "{}"); } catch {}
        const name = ev ?? o.event;
        ev = null;
        if (typeof o.run_id === "string") hermesRuns.set(key, o.run_id);
        if (name === "tool.started") send("progress", { text: `Using ${o.tool_name}${o.preview ? ": " + String(o.preview).slice(0, 120) : ""}` });
        else if (name === "approval.request") {
          const what = String(o.command ?? o.description ?? "a command").slice(0, 400);
          if (body.approvals === "screen") {
            // The page shows it with Approve and Deny; unanswered, it's denied.
            const pending = { run: o.run_id, request: o.request_id ?? null, timer: null };
            pending.timer = setTimeout(() => void approve(key, "deny", "nobody answered"), APPROVAL_WAIT * 1000);
            approvals.set(key, pending);
            send("approval", { command: what, description: o.description ?? null });
            send("progress", { text: `Waiting for your approval: ${what}` });
          } else {
            // Anyone near the speaker could be talking: risky commands are denied, as on the Echo.
            send("progress", { text: `Denied a command that needed approval: ${what}` });
            await fetch(`${HERMES_URL}/v1/runs/${o.run_id}/approval`, { method: "POST", headers, body: JSON.stringify({ choice: "deny", request_id: o.request_id }) });
          }
        } else if (name === "assistant.completed") answer = o.content ?? "";
        else if (name === "error") throw new Error(o.message ?? "Hermes error");
        else if (name?.startsWith("run.") && name !== "run.started" && name !== "run.queued") status = name.slice(4);
      }
    }
    hermesRuns.delete(key);
    if (approvals.has(key)) { clearTimeout(approvals.get(key).timer); approvals.delete(key); }
    if (status === "cancelled") send("result", { text: "Cancelled. Completed actions were not undone.", failed: true });
    else if (answer) send("result", { text: answer });
    else if (status === "failed") send("result", { text: "Task failed. No automatic retry. Completed actions were not undone.", failed: true });
    else send("result", { text: "Hermes finished without a text result. Do not infer success." });
  } catch (err) {
    if (!abort.signal.aborted) send("error", { message: err.message });
  } finally {
    if (key && approvals.has(key)) { clearTimeout(approvals.get(key).timer); approvals.delete(key); }
    if (key) hermesRuns.delete(key);
  }
  res.end();
}

/** POST /hermes/steer and /hermes/stop: the running Hermes run of a call's task, given more to go on or stopped. */
async function hermesRun(req, res, action) {
  const body = JSON.parse(await read(req));
  const run = hermesRuns.get(`${body.call}/${body.taskId}`);
  if (!run) { res.writeHead(409); return res.end("no run"); }
  const r = await fetch(`${HERMES_URL}/v1/runs/${encodeURIComponent(run)}/${action}`, {
    method: "POST", headers: { Authorization: `Bearer ${HERMES_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(action === "steer" ? { input: body.text } : {}),
  }).catch((err) => ({ ok: false, status: 502, text: async () => err.message }));
  if (!r.ok) console.error(`Hermes ${action} ${run}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  res.writeHead(r.ok ? 204 : 409);
  res.end();
}

// Traces: a minute of call is two or three megabytes, mostly audio. Old ones go, and the newest
// that fit in TRACE_BUDGET stay.
const TRACE_DAYS = 30;
const TRACE_BUDGET = 5 * 1024 ** 3;
function pruneTraces() {
  if (!existsSync(TRACES)) return;
  const all = readdirSync(TRACES).filter((f) => f.endsWith(".jsonl")).map((f) => ({ f, ...statSync(join(TRACES, f)) }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  let kept = 0;
  for (const t of all) {
    kept += t.size;
    if (Date.now() - t.mtimeMs > TRACE_DAYS * 86_400_000 || kept > TRACE_BUDGET) {
      try { unlinkSync(join(TRACES, t.f)); console.log(`pruned trace ${t.f}`); } catch {}
    }
  }
}
pruneTraces();
setInterval(pruneTraces, 3600_000).unref();

// The coding agent.

async function agent(req, res) {
  const body = JSON.parse(await read(req));
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  const send = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  const abort = new AbortController();
  // The request's own "close" has long fired once its body is read: the response's says the page left.
  res.on("close", () => abort.abort());
  // Proxies close a quiet stream: a comment every 20 s keeps a long run's stream open.
  const ping = setInterval(() => { if (!res.writableEnded) res.write(": ping\n\n"); }, 20_000);
  try {
    await T3.runTask(body, send, abort.signal);
  } catch (err) {
    if (!abort.signal.aborted) send("error", { message: `T3: ${err.message}` });
  } finally {
    clearInterval(ping);
  }
  res.end();
}

// Builds.

let coreVersion = (await build()).version;
const listeners = new Set();
function announce(event, data) {
  for (const res of listeners) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const web = await esbuild.context({
  entryPoints: [join(root, "web/app.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: join(root, "web/dist/app.js"),
  sourcemap: "inline",
  logLevel: "warning",
});
const wakeWorker = await esbuild.context({
  entryPoints: [join(root, "web/wake.worker.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: join(root, "web/dist/wake.worker.js"),
  sourcemap: "inline",
  logLevel: "warning",
});
await Promise.all([web.rebuild(), wakeWorker.rebuild()]);

let pending = null;
function rebuildSoon(what) {
  clearTimeout(pending);
  pending = setTimeout(async () => {
    try {
      if (what === "core") {
        const { version, changed } = await build();
        coreVersion = version;
        if (changed) { console.log(`core rebuilt: ${version}`); announce("core", { version }); }
      } else {
        await Promise.all([web.rebuild(), wakeWorker.rebuild()]);
        announce("app", {});
      }
    } catch (err) {
      console.error(`${what} build failed: ${err.message}`);
      announce("error", { what, message: err.message });
    }
  }, 120);
}
watch(join(root, "src"), { recursive: true }, () => rebuildSoon("core"));
watch(join(root, "web"), { recursive: true }, (_, file) => { if (file && !String(file).startsWith("dist")) rebuildSoon("app"); });

// HTTP.

const TYPES = { ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".onnx": "application/octet-stream", ".css": "text/css", ".json": "application/json", ".jsonl": "application/json", ".wav": "audio/wav" };

function read(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function file(res, path, cacheControl = "no-store") {
  if (!existsSync(path) || !statSync(path).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream", "cache-control": cacheControl });
  res.end(readFileSync(path));
}

/**
 * Only this machine reaches the relay and Hermes: the server listens on loopback, and the tailnet
 * comes in through `tailscale serve`, which connects from loopback too.
 */
function allowed(req) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const path = url.pathname;
  if (!allowed(req)) { res.writeHead(403); res.end(); return; }
  try {
    if (path === "/") return file(res, join(root, "web/index.html"));
    if (path === "/app.js") return file(res, join(root, "web/dist/app.js"));
    if (path === "/wake.worker.js") return file(res, join(root, "web/dist/wake.worker.js"));
    if (path === "/voice-core.js") return file(res, OUT);
    if (path === "/config") {
      res.writeHead(200, { "content-type": "application/json" });
      const projects = T3.available() ? (await T3.projects().catch(() => [])).map((p) => p.title) : null;
      const models = [...wakeModels.values()].map(({ id, label }) => ({ id, label }));
      return res.end(JSON.stringify({ route: ROUTE, model, captionsModel, textModel: TEXT_MODEL, version: coreVersion, hermes: Boolean(HERMES_URL && HERMES_KEY), t3: projects, wakeModels: models }));
    }
    if (path.startsWith("/wake/models/") && path.endsWith(".onnx")) {
      const id = decodeURIComponent(path.slice("/wake/models/".length, -".onnx".length));
      const entry = wakeModels.get(id);
      if (!entry) { res.writeHead(404); return res.end(); }
      return file(res, entry.path, "public, max-age=86400");
    }
    if (path.startsWith("/ort/")) {
      const rel = decodeURIComponent(path.slice("/ort/".length));
      const ext = extname(rel);
      if (ext !== ".wasm" && ext !== ".mjs") { res.writeHead(404); return res.end(); }
      const target = normalize(join(ORT_DIR, rel));
      if (!target.startsWith(ORT_DIR + sep)) { res.writeHead(403); return res.end(); }
      return file(res, target, "public, max-age=86400");
    }
    if (path === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      res.write(`event: core\ndata: ${JSON.stringify({ version: coreVersion })}\n\n`);
      listeners.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
      req.on("close", () => { listeners.delete(res); clearInterval(ping); });
      return;
    }
    if (path === "/generate" && req.method === "POST") return await generate(req, res);
    if (path === "/hermes" && req.method === "POST") return await hermes(req, res);
    if (path === "/agent" && req.method === "POST") return await agent(req, res);
    if (path === "/hermes/steer" && req.method === "POST") return await hermesRun(req, res, "steer");
    if (path === "/hermes/stop" && req.method === "POST") return await hermesRun(req, res, "stop");
    if (path === "/hermes/approval" && req.method === "POST") {
      const b = JSON.parse(await read(req));
      const ok = await approve(`${b.call}/${b.taskId}`, b.choice === "once" ? "once" : "deny", "the page");
      res.writeHead(ok ? 204 : 409);
      return res.end();
    }
    if (path === "/agent/recent") {
      const list = T3.available() ? await T3.recent().catch(() => []) : [];
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify(list));
    }
    if (path === "/agent/steer" && req.method === "POST") {
      const ok = await T3.steer(JSON.parse(await read(req))).catch((err) => { console.error(`T3 steer: ${err.message}`); return false; });
      res.writeHead(ok ? 204 : 409);
      return res.end();
    }
    if (path === "/agent/cancel" && req.method === "POST") {
      const ok = await T3.cancel(JSON.parse(await read(req))).catch((err) => { console.error(`T3 cancel: ${err.message}`); return false; });
      res.writeHead(ok ? 204 : 404);
      return res.end();
    }
    if (path === "/ping") { res.writeHead(204, { "cache-control": "no-store" }); return res.end(); }
    if (path === "/traces" && req.method === "POST") {
      const name = (url.searchParams.get("name") ?? "").replace(/[^\w.-]/g, "");
      if (!name.endsWith(".jsonl")) { res.writeHead(400); return res.end(); }
      mkdirSync(TRACES, { recursive: true });
      appendFileSync(join(TRACES, name), await read(req));
      res.writeHead(204);
      return res.end();
    }
    if (path === "/traces") {
      mkdirSync(TRACES, { recursive: true });
      const list = readdirSync(TRACES).filter((f) => f.endsWith(".jsonl")).sort().reverse()
        .map((f) => ({ name: f, bytes: statSync(join(TRACES, f)).size }));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(list));
    }
    for (const [prefix, dir] of [["/traces/", TRACES], ["/scenarios/", join(root, "scenarios")], ["/versions/", join(root, "dist/versions")], ["/web/", join(root, "web")], ["/clips/", join(os.homedir(), ".local/share/voice-core/clips")]]) {
      if (!path.startsWith(prefix)) continue;
      const target = normalize(join(dir, decodeURIComponent(path.slice(prefix.length))));
      if (!target.startsWith(dir)) break;
      return file(res, target);
    }
    if (path === "/scenarios") {
      const list = readdirSync(join(root, "scenarios")).filter((f) => f.endsWith(".json") && !f.endsWith(".golden.json")).map((f) => f.slice(0, -5));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(list));
    }
    res.writeHead(404);
    res.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

// The relay: frames pass through untouched both ways; the browser hears how the far end closed.

const relay = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/live" || !allowed(req)) { socket.destroy(); return; }
  const captions = url.searchParams.get("for") === "captions";
  relay.handleUpgrade(req, socket, head, async (browser) => {
    // Frames the browser sends before the far end is open (the setup, at once) wait here.
    const early = [];
    let far = null;
    browser.on("message", (data, binary) => {
      const text = binary ? data : data.toString();
      if (far && far.readyState === WebSocket.OPEN) far.send(text); else early.push(text);
    });
    browser.on("close", () => far?.close());
    try {
      far = await upstream(captions);
    } catch (err) {
      browser.close(4500, `relay: ${err.message}`.slice(0, 120));
      return;
    }
    if (browser.readyState !== WebSocket.OPEN) { far.close(); return; }
    far.on("open", () => { for (const m of early.splice(0)) far.send(m); });
    far.on("message", (data) => { if (browser.readyState === WebSocket.OPEN) browser.send(data.toString()); });
    far.on("unexpected-response", (_, res) => browser.close(4000 + Math.min(res.statusCode, 999), `HTTP ${res.statusCode}`));
    far.on("close", (code, reason) => {
      if (browser.readyState !== WebSocket.OPEN) return;
      // 1005 and 1006 can't be sent: they mean "no code", so the browser gets a plain close.
      const ok = code === 1000 || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
      browser.close(ok ? code : 1000, String(reason).slice(0, 120));
    });
    far.on("error", (err) => { if (browser.readyState === WebSocket.OPEN) browser.close(4502, `relay: ${err.message}`.slice(0, 120)); });
  });
});

server.listen(PORT, HOST, () => {
  const models = [...wakeModels.keys()].join(", ") || "none";
  console.log(`voice core dev server on http://${HOST}:${PORT} (core ${coreVersion}, model route ${ROUTE}${ROUTE === "vertex" ? " via " + SOCKS : ""}, Hermes ${HERMES_URL ? "on" : "off"}, wake models: ${models})`);
});
