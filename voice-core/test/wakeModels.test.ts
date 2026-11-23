import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discoverWakeModels, labelForModel } from "../dev/wakeModels.mjs";

test("labelForModel formats snake_case and kebab-case model ids", () => {
  assert.equal(labelForModel("pennyworth"), "Pennyworth");
  assert.equal(labelForModel("hey_woodhouse"), "Hey Woodhouse");
  assert.equal(labelForModel("my-wake-word"), "My Wake Word");
});

test("discoverWakeModels prioritizes extraDir over repoDir and picks highest versioned lkww models", () => {
  const root = mkdtempSync(join(tmpdir(), "wake-models-"));
  try {
    const extraDir = join(root, "extra");
    const repoDir = join(root, "repo");
    const lkwwDir = join(root, "lkww");
    mkdirSync(extraDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(join(lkwwDir, "v1"), { recursive: true });
    mkdirSync(join(lkwwDir, "v2"), { recursive: true });
    mkdirSync(join(lkwwDir, "hey_woodhouse-v1"), { recursive: true });
    mkdirSync(join(lkwwDir, "hey_woodhouse-v2"), { recursive: true });
    mkdirSync(join(lkwwDir, "pennyworth-v6"), { recursive: true });

    writeFileSync(join(extraDir, "custom.onnx"), "extra");
    writeFileSync(join(repoDir, "pennyworth.onnx"), "repo-penny");
    writeFileSync(join(repoDir, "custom.onnx"), "repo-custom");
    writeFileSync(join(lkwwDir, "v1", "woodhouse.onnx"), "w1");
    writeFileSync(join(lkwwDir, "v2", "woodhouse.onnx"), "w2");
    writeFileSync(join(lkwwDir, "hey_woodhouse-v1", "hey_woodhouse.onnx"), "hw1");
    writeFileSync(join(lkwwDir, "hey_woodhouse-v2", "hey_woodhouse.onnx"), "hw2");
    writeFileSync(join(lkwwDir, "pennyworth-v6", "pennyworth.onnx"), "lkww-penny");

    const found = discoverWakeModels({ extraDir, repoDir, lkwwDir });
    assert.deepEqual([...found.keys()], ["custom", "pennyworth", "hey_woodhouse", "woodhouse"]);
    assert.equal(found.get("custom")?.path, join(extraDir, "custom.onnx"));
    assert.equal(found.get("pennyworth")?.path, join(repoDir, "pennyworth.onnx"));
    assert.equal(found.get("woodhouse")?.path, join(lkwwDir, "v2", "woodhouse.onnx"));
    assert.equal(found.get("hey_woodhouse")?.path, join(lkwwDir, "hey_woodhouse-v2", "hey_woodhouse.onnx"));
    assert.equal(found.get("hey_woodhouse")?.label, "Hey Woodhouse");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
