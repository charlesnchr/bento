// GSK Vertex for the bench: the Live socket the call talks to, Gemini TTS for the simulated
// user's voice, and a text model for the judge. Credentials are the service account the dev
// server uses (VERTEX_* in ~/.hermes/.env), through the GSK SOCKS route. Nothing here can reach
// the public Gemini API, so a bench run never bills a personal key.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import https from "node:https";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SocksProxyAgent } from "socks-proxy-agent";
import WebSocket from "ws";
// @ts-ignore: a plain module
import { envFile, serviceAccount } from "../dev/google.mjs";

const env = envFile(join(os.homedir(), ".hermes/.env")) as Record<string, string>;
const SOCKS = process.env.VOICE_CORE_SOCKS ?? "socks5h://127.0.0.1:11080";
const LOCATION = process.env.VOICE_CORE_LOCATION ?? "us-central1";
export const LIVE_MODEL = process.env.VOICE_EVAL_LIVE_MODEL ?? "gemini-3.8-live";
export const TTS_MODEL = process.env.VOICE_EVAL_TTS_MODEL ?? "gemini-3.8-flash-tts";
export const JUDGE_MODEL = process.env.VOICE_EVAL_JUDGE_MODEL ?? "gemini-4-hydrogen";
const PROJECT = env.VERTEX_PROJECT_ID;
const account = serviceAccount((env.VERTEX_CREDENTIALS_PATH ?? "").replace(/^~/, os.homedir()));
const agent = new SocksProxyAgent(SOCKS);

export const liveModelPath = `projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${LIVE_MODEL}`;

export async function liveSocket(): Promise<WebSocket> {
  return new WebSocket(`wss://${LOCATION}-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent`, {
    headers: { Authorization: `Bearer ${await account.token()}` },
    agent,
    maxPayload: 8 * 1024 * 1024,
  });
}

async function post(url: string, body: unknown, timeoutMs = 120_000): Promise<{ status: number; text: string }> {
  const token = await account.token();
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: "POST", agent, timeout: timeoutMs, headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" } }, (r) => {
      const chunks: Buffer[] = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => resolve({ status: r.statusCode ?? 0, text: Buffer.concat(chunks).toString() }));
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

const modelUrl = (model: string, location = "global") =>
  `https://${location === "global" ? "" : location + "-"}aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${location}/publishers/google/models/${model}:generateContent`;

async function retry<T>(what: string, fn: () => Promise<T>, tries = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (err) { last = err; await new Promise((r) => setTimeout(r, 1500 * (i + 1))); }
  }
  throw new Error(`${what}: ${(last as Error).message}`);
}

const CACHE = fileURLToPath(new URL("./cache/", import.meta.url));

/** [text] spoken by [voice] as 16 kHz PCM16 mono, cached by what was asked for. `style` steers the delivery. */
export async function speech(text: string, voice = "Puck", style = ""): Promise<Int16Array> {
  mkdirSync(CACHE, { recursive: true });
  const key = createHash("sha256").update(JSON.stringify([TTS_MODEL, voice, style, text])).digest("hex").slice(0, 20);
  const path = join(CACHE, `${key}.pcm`);
  if (existsSync(path)) { const b = readFileSync(path); return new Int16Array(b.buffer, b.byteOffset, b.length / 2); }
  const prompt = style ? `${style}: ${text}` : text;
  const pcm24 = await retry(`TTS "${text.slice(0, 40)}"`, async () => {
    const res = await post(modelUrl(TTS_MODEL), {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
    });
    if (res.status !== 200) throw new Error(`HTTP ${res.status} ${res.text.slice(0, 200)}`);
    const part = JSON.parse(res.text).candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
    if (!part) throw new Error("no audio in the reply");
    return Buffer.from(part.inlineData.data, "base64");
  });
  // 24 kHz to 16 kHz: a 3-tap low-pass, then linear interpolation.
  const n24 = pcm24.length >> 1;
  const src = new Float64Array(n24);
  for (let i = 0; i < n24; i++) src[i] = pcm24.readInt16LE(2 * i);
  const low = new Float64Array(n24);
  for (let i = 0; i < n24; i++) low[i] = 0.25 * (src[i - 1] ?? src[i]) + 0.5 * src[i] + 0.25 * (src[i + 1] ?? src[i]);
  const out = new Int16Array(Math.floor((n24 * 2) / 3));
  for (let i = 0; i < out.length; i++) {
    const x = i * 1.5, j = Math.floor(x), f = x - j;
    out[i] = Math.round(low[j] + ((low[j + 1] ?? low[j]) - low[j]) * f);
  }
  // Trim leading and trailing near-silence so timings mean speech.
  let a = 0, b = out.length;
  while (a < b && Math.abs(out[a]) < 300) a++;
  while (b > a && Math.abs(out[b - 1]) < 300) b--;
  const trimmed = out.slice(Math.max(0, a - 800), Math.min(out.length, b + 800));
  writeFileSync(path, Buffer.from(trimmed.buffer, trimmed.byteOffset, trimmed.byteLength));
  return trimmed;
}

/** A text model's answer to [prompt]; with [json], parsed. */
export async function generate(prompt: string, o: { model?: string; json?: boolean; system?: string } = {}): Promise<string> {
  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0, ...(o.json ? { responseMimeType: "application/json" } : {}) },
  };
  if (o.system) body.systemInstruction = { parts: [{ text: o.system }] };
  return retry("generate", async () => {
    const res = await post(modelUrl(o.model ?? JUDGE_MODEL), body);
    if (res.status !== 200) throw new Error(`HTTP ${res.status} ${res.text.slice(0, 300)}`);
    const parts = JSON.parse(res.text).candidates?.[0]?.content?.parts ?? [];
    return parts.filter((p: any) => typeof p.text === "string" && !p.thought).map((p: any) => p.text).join("");
  });
}

if (process.argv[1]?.endsWith("vertex.ts")) {
  const pcm = await speech(process.argv[2] ?? "Hello there, this is a test.", process.argv[3] ?? "Puck");
  console.log(`${(pcm.length / 16000).toFixed(2)} s of speech`);
  console.log(await generate("Reply with the single word: ready"));
}
