// Discovers local LiveKit WakeWord v2 `.onnx` models for the voice-core dev server.
// Priority order (first hit wins per model id):
//   1. Explicit `extraDir` (VOICE_CORE_WAKE_DIR env var)
//   2. Repo assets (`android/app/src/main/assets/wakeword/*.onnx`, e.g. pennyworth.onnx)
//   3. Optional homelab `home-assistant/wakeword/models/lkww` latest versioned subdirectories

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

/** Turns `hey_woodhouse` into `Hey Woodhouse`. */
export function labelForModel(id) {
  return id
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

/** Trailing version number in a subdir name like `v2` or `hey_woodhouse-v2`, or -1 if none. */
function dirVersion(name) {
  const m = name.match(/(?:^|[-_])v(\d+)$/i);
  return m ? Number(m[1]) : -1;
}

function scanFlat(dir, out) {
  if (!dir || !existsSync(dir)) return;
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries.sort()) {
    if (!name.endsWith(".onnx")) continue;
    const full = join(dir, name);
    try { if (!statSync(full).isFile()) continue; } catch { continue; }
    const id = basename(name, ".onnx").replace(/[^\w-]/g, "");
    if (!id || out.has(id)) continue;
    out.set(id, { id, label: labelForModel(id), path: full });
  }
}

function scanVersioned(dir, out) {
  if (!dir || !existsSync(dir)) return;
  let subdirs;
  try { subdirs = readdirSync(dir); } catch { return; }
  /** @type {Map<string, { version: number; name: string; path: string }>} */
  const best = new Map();
  for (const sub of subdirs.sort()) {
    const subPath = join(dir, sub);
    try { if (!statSync(subPath).isDirectory()) continue; } catch { continue; }
    let files;
    try { files = readdirSync(subPath); } catch { continue; }
    const version = dirVersion(sub);
    for (const file of files.sort()) {
      if (!file.endsWith(".onnx")) continue;
      const full = join(subPath, file);
      try { if (!statSync(full).isFile()) continue; } catch { continue; }
      const id = basename(file, ".onnx").replace(/[^\w-]/g, "");
      if (!id || out.has(id)) continue;
      const cur = best.get(id);
      if (!cur || version > cur.version || (version === cur.version && sub > cur.name)) {
        best.set(id, { version, name: sub, path: full });
      }
    }
  }
  for (const [id, item] of [...best.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    out.set(id, { id, label: labelForModel(id), path: item.path });
  }
}

/**
 * Returns a Map<id, { id, label, path }> of available ONNX wake word models.
 * @param {{ extraDir?: string | null; repoDir?: string | null; lkwwDir?: string | null }} dirs
 */
export function discoverWakeModels({ extraDir = null, repoDir = null, lkwwDir = null } = {}) {
  const models = new Map();
  scanFlat(extraDir, models);
  scanFlat(repoDir, models);
  scanVersioned(lkwwDir, models);
  return models;
}
