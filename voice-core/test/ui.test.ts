import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canFollowUpResult,
  formatShortTime,
  normalizeDensity,
  normalizeSideFilter,
  parsePrefix,
  plainPreview,
  resolveSideSections,
  shouldClearUnreadResults,
} from "../web/ui.ts";

describe("web UI helpers", () => {
  it("normalizes density with compact as the default", () => {
    assert.equal(normalizeDensity(null), "compact");
    assert.equal(normalizeDensity(undefined), "compact");
    assert.equal(normalizeDensity("compact"), "compact");
    assert.equal(normalizeDensity("comfortable"), "comfortable");
    assert.equal(normalizeDensity("weird"), "compact");
  });

  it("normalizes side filter tabs", () => {
    assert.equal(normalizeSideFilter(null), "all");
    assert.equal(normalizeSideFilter("active"), "active");
    assert.equal(normalizeSideFilter("results"), "results");
    assert.equal(normalizeSideFilter("unknown"), "all");
  });

  it("parses /h and /t3 composer prefixes", () => {
    assert.deepEqual(parsePrefix("/h check weather"), { mode: "hermes", rest: "check weather" });
    assert.deepEqual(parsePrefix("/t3 fix layout"), { mode: "t3", rest: "fix layout" });
    assert.deepEqual(parsePrefix("/code add test"), { mode: "t3", rest: "add test" });
    assert.deepEqual(parsePrefix("plain message"), { mode: null, rest: "plain message" });
  });

  it("scopes result follow-ups to the originating session", () => {
    assert.equal(canFollowUpResult(1, 1, true), true);
    assert.equal(canFollowUpResult(1, 2, true), false); // later call reusing taskId 1
    assert.equal(canFollowUpResult(1, 0, true), false); // call ended
    assert.equal(canFollowUpResult(0, 0, true), false); // no active call
    assert.equal(canFollowUpResult(2, 2, false), false); // task missing
  });

  it("clears mobile unread result alerts only when results are visible", () => {
    assert.equal(shouldClearUnreadResults(false, false, "active"), true); // desktop always clears
    assert.equal(shouldClearUnreadResults(true, false, "all"), false); // drawer closed on mobile
    assert.equal(shouldClearUnreadResults(true, true, "active"), false); // drawer open, but filtered to Active
    assert.equal(shouldClearUnreadResults(true, true, "all"), true);
    assert.equal(shouldClearUnreadResults(true, true, "results"), true);
  });

  it("flattens markdown into a single-line plain preview and truncates cleanly", () => {
    const md = "## Summary\n- **PR #94** opened at [GitHub](https://github.com/charlesnchr/bento/pull/94)\n- Checked `styles.css`\n```ts\nconst x = 1;\n```";
    const preview = plainPreview(md, 200);
    assert.equal(preview, "Summary PR #94 opened at GitHub Checked styles.css const x = 1;");

    const truncated = plainPreview("One two three four five six seven eight nine ten", 24);
    assert.ok(truncated.endsWith("…"));
    assert.ok(truncated.length <= 25);
    assert.equal(truncated, "One two three four five…");
  });

  it("formats short 24-hour timestamps", () => {
    assert.equal(formatShortTime(new Date(2026, 10, 23, 8, 5)), "08:05");
    assert.equal(formatShortTime(new Date(2026, 10, 23, 14, 29)), "14:29");
  });

  it("resolves right-pane section visibility across filters", () => {
    // Empty idle state in All: show empty tasks hint only
    assert.deepEqual(
      resolveSideSections("all", { active: 0, results: 0, earlier: 0, done: 0 }),
      {
        showTasksSection: true,
        showEmptyTasks: true,
        showResultsSection: false,
        showEmptyResults: false,
        showEarlierSection: false,
        showDoneSection: false,
      },
    );

    // Finished responses with no running tasks in All: drop empty tasks box so results rise to top
    assert.deepEqual(
      resolveSideSections("all", { active: 0, results: 3, earlier: 0, done: 3 }),
      {
        showTasksSection: false,
        showEmptyTasks: false,
        showResultsSection: true,
        showEmptyResults: false,
        showEarlierSection: false,
        showDoneSection: true,
      },
    );

    // Both active tasks and finished results in All
    assert.deepEqual(
      resolveSideSections("all", { active: 2, results: 4, earlier: 1, done: 2 }),
      {
        showTasksSection: true,
        showEmptyTasks: false,
        showResultsSection: true,
        showEmptyResults: false,
        showEarlierSection: true,
        showDoneSection: true,
      },
    );

    // Results filter hides active/earlier/done and shows empty state when 0 results
    assert.deepEqual(
      resolveSideSections("results", { active: 2, results: 0, earlier: 1, done: 2 }),
      {
        showTasksSection: false,
        showEmptyTasks: false,
        showResultsSection: true,
        showEmptyResults: true,
        showEarlierSection: false,
        showDoneSection: false,
      },
    );

    // Active filter hides results
    assert.deepEqual(
      resolveSideSections("active", { active: 0, results: 3, earlier: 0, done: 1 }),
      {
        showTasksSection: true,
        showEmptyTasks: true,
        showResultsSection: false,
        showEmptyResults: false,
        showEarlierSection: false,
        showDoneSection: true,
      },
    );
  });
});
