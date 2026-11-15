// Google credentials for the dev server's relay: an access token from a service account's key,
// minted with Node's own crypto (no Google library), cached until a minute before it expires.

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const SCOPE = "https://www.googleapis.com/auth/cloud-platform";

export function serviceAccount(path) {
  const key = JSON.parse(readFileSync(path, "utf8"));
  if (key.type !== "service_account") throw new Error(`${path} is not a service account key`);
  let cached = null;
  return {
    email: key.client_email,
    async token() {
      if (cached && cached.expires - Date.now() > 60_000) return cached.token;
      const now = Math.floor(Date.now() / 1000);
      const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
      const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: key.client_email, scope: SCOPE, aud: key.token_uri, iat: now, exp: now + 3600 })}`;
      const signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key).toString("base64url");
      const response = await fetch(key.token_uri, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }),
      });
      if (!response.ok) throw new Error(`token exchange failed: HTTP ${response.status}`);
      const body = await response.json();
      cached = { token: body.access_token, expires: Date.now() + body.expires_in * 1000 };
      return cached.token;
    },
  };
}

/** KEY=value lines from an env file, without exporting anything. */
export function envFile(path) {
  const out = {};
  let text = "";
  try { text = readFileSync(path, "utf8"); } catch { return out; }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}
