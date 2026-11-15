// Spoken test clips from Gemini TTS on GSK Vertex: node dev/tts.mjs out.wav "Words to say" [voice]
// 16 kHz mono PCM16 WAV, ready for talk.ts or the web page's fake microphone.
import { writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { SocksProxyAgent } from "socks-proxy-agent";
import { envFile, serviceAccount } from "./google.mjs";
import https from "node:https";

const [out, text, voice = "Puck"] = process.argv.slice(2);
const env = envFile(join(os.homedir(), ".hermes/.env"));
const token = await serviceAccount(env.VERTEX_CREDENTIALS_PATH.replace(/^~/, os.homedir())).token();
const model = process.env.TTS_MODEL ?? "gemini-3.8-flash-tts";
const body = JSON.stringify({
  contents: [{ role: "user", parts: [{ text }] }],
  generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
});
const url = `https://aiplatform.googleapis.com/v1/projects/${env.VERTEX_PROJECT_ID}/locations/global/publishers/google/models/${model}:generateContent`;
const res = await new Promise((resolve, reject) => {
  const req = https.request(url, { method: "POST", agent: new SocksProxyAgent("socks5h://127.0.0.1:11080"), headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" } }, (r) => {
    const chunks = []; r.on("data", (c) => chunks.push(c)); r.on("end", () => resolve({ status: r.statusCode, text: Buffer.concat(chunks).toString() }));
  });
  req.on("error", reject); req.end(body);
});
if (res.status !== 200) { console.error(res.status, res.text.slice(0, 400)); process.exit(1); }
const part = JSON.parse(res.text).candidates[0].content.parts.find((p) => p.inlineData);
const pcm24 = Buffer.from(part.inlineData.data, "base64");
// 24 kHz to 16 kHz, linear.
const n = Math.floor((pcm24.length / 2) * 2 / 3);
const pcm = Buffer.alloc(n * 2);
for (let i = 0; i < n; i++) {
  const x = i * 1.5, j = Math.floor(x), f = x - j;
  const a = pcm24.readInt16LE(2 * j), b = 2 * (j + 1) < pcm24.length ? pcm24.readInt16LE(2 * (j + 1)) : a;
  pcm.writeInt16LE(Math.round(a + (b - a) * f), 2 * i);
}
const header = Buffer.alloc(44);
header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8);
header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24);
header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
writeFileSync(out, Buffer.concat([header, pcm]));
console.log(`${out}: ${(pcm.length / 32000).toFixed(1)} s`);
