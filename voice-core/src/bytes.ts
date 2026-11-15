// Byte helpers that every engine the core runs in has: no atob, btoa or TextEncoder, which
// JavaScriptCore and QuickJS embedded without a browser lack.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i;

export function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + "==";
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + "=";
  }
  return out;
}

/** Null when [text] isn't base64 (the standard alphabet, padded or not). */
export function decodeBase64(text: string): Uint8Array | null {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 61) end--;
  if (text.length - end > 2 || end % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((end * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < end; i++) {
    const c = text.charCodeAt(i);
    const v = c < 128 ? LOOKUP[c] : -1;
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

/** Bytes [base64] decodes to, without decoding it. */
export function base64Size(text: string): number {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 61) end--;
  return Math.floor((end * 3) / 4);
}

/** Whether [text] is base64 of nothing but zero bytes, read without decoding it: every digit is "A". */
export function silent64(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c !== 65 && c !== 61) return false;
  }
  return true;
}

/** A plausible base64 payload: digits of the alphabet and padding only at the end. Cheaper than decoding. */
export function looksBase64(text: string): boolean {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 61) end--;
  if (text.length - end > 2 || end % 4 === 1) return false;
  for (let i = 0; i < end; i++) {
    const c = text.charCodeAt(i);
    if (c >= 128 || LOOKUP[c] < 0) return false;
  }
  return true;
}

/** UTF-8 length of [text], as Kotlin's `toByteArray().size` and Swift's `utf8.count` give it. */
export function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { n += 4; i++; } else n += 3;
    } else n += 3;
  }
  return n;
}

/** Unicode code points in [text] (Kotlin's `codePointCount`). */
export function codePoints(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

// PCM16 little-endian, mono.

/** Exact digital silence: no microphone gives that for long, even in a quiet room. */
export function silent(pcm: Uint8Array): boolean {
  for (let i = 0; i < pcm.length; i++) if (pcm[i] !== 0) return false;
  return true;
}

function sample(pcm: Uint8Array, i: number): number {
  const v = pcm[i] | (pcm[i + 1] << 8);
  return v >= 0x8000 ? v - 0x10000 : v;
}

/** RMS as a fraction of full scale. */
export function level(pcm: Uint8Array): number {
  if (pcm.length < 2) return 0;
  let sum = 0;
  let i = 0;
  for (; i + 1 < pcm.length; i += 2) {
    const s = sample(pcm, i);
    sum += s * s;
  }
  return Math.sqrt(sum / Math.floor(pcm.length / 2)) / 32768;
}

/**
 * [pcm] made louder by [db] decibels, the loudest samples limited rather than clipped: a peak
 * that would pass [ceiling] of full scale is compressed into the room above it.
 */
export function gain(pcm: Uint8Array, db: number, ceiling = 0.9): Uint8Array {
  const factor = Math.pow(10, db / 20);
  const out = new Uint8Array(pcm.length - (pcm.length % 2));
  const knee = ceiling * 32767;
  const room = 32767 - knee;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    let v = sample(pcm, i) * factor;
    const a = Math.abs(v);
    if (a > knee) {
      // A soft knee: what passes the ceiling approaches full scale and never reaches it.
      const over = a - knee;
      v = Math.sign(v) * (knee + room * (over / (over + room)));
    }
    const s = Math.round(v) & 0xffff;
    out[i] = s & 0xff;
    out[i + 1] = s >> 8;
  }
  return out;
}

export function zeros(length: number): Uint8Array {
  return new Uint8Array(length);
}
