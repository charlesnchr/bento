import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ResultStore, resultSnippet } from "../web/results.ts";

describe("resultSnippet", () => {
  it("strips markdown headings, bold, inline code, lists, and links into one line", () => {
    const md = [
      "## Summary",
      "- **Hermes** is the leanest at `23k` tokens.",
      "- See [PR #91](https://github.com/charlesnchr/bento/pull/91) for details.",
    ].join("\n");
    assert.equal(
      resultSnippet(md, 200),
      "Summary Hermes is the leanest at 23k tokens. See PR #91 for details.",
    );
  });

  it("flattens fenced code blocks and truncates cleanly at word boundaries", () => {
    const md = "Ran check:\n```bash\nnpm test\n```\nAll two hundred seventy eight tests passed without issues.";
    const out = resultSnippet(md, 48);
    assert.ok(out.endsWith("…"));
    assert.ok(out.length <= 48);
    assert.ok(out.includes("npm test"));
  });

  it("handles long single words without spaces", () => {
    const out = resultSnippet("a".repeat(80), 20);
    assert.equal(out.length, 20);
    assert.ok(out.endsWith("…"));
  });
});

describe("ResultStore", () => {
  it("opens latest by default and steps between results within bounds", () => {
    const store = new ResultStore();
    assert.equal(store.open(), null);

    const a = store.add({ agent: "hermes", label: "Lights", text: "Turned on.", failed: false, taskId: "t1", at: 1 });
    const b = store.add({ agent: "t3", label: "Auto scroll", text: "Opened PR #94.", failed: false, taskId: "t2", at: 2 });
    const c = store.add({ agent: "hermes", label: "Check model", text: "Vertex AI.", failed: false, taskId: "t1", at: 3 });

    assert.equal(store.count, 3);
    assert.equal(store.latestForTask("t1")?.id, c.id);
    assert.equal(store.open()?.id, c.id);
    assert.equal(store.currentIndex, 2);

    assert.equal(store.step(1)?.id, c.id);
    assert.equal(store.step(-1)?.id, b.id);
    assert.equal(store.step(-1)?.id, a.id);
    assert.equal(store.step(-1)?.id, a.id);

    assert.equal(store.open(b.id)?.id, b.id);
    store.close();
    assert.equal(store.current, null);
    assert.equal(store.currentIndex, -1);
  });
});
