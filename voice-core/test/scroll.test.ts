import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AutoScroller, type ScrollPane } from "../web/scroll.ts";

class FakePane implements ScrollPane {
  private _scrollTop = 0;
  scrollHeight: number;
  clientHeight: number;
  smoothTargets: number[] = [];

  constructor(clientHeight = 500, scrollHeight = 500) {
    this.clientHeight = clientHeight;
    this.scrollHeight = scrollHeight;
  }

  get scrollTop(): number {
    return this._scrollTop;
  }

  set scrollTop(value: number) {
    const max = Math.max(0, this.scrollHeight - this.clientHeight);
    this._scrollTop = Math.max(0, Math.min(value, max));
  }

  scrollTo(options: { top: number; behavior?: ScrollBehavior }): void {
    this.smoothTargets.push(options.top);
  }

  /** Simulate a browser clamping scrollTop when scrollHeight shrinks or clientHeight grows. */
  clamp(): void {
    this.scrollTop = this._scrollTop;
  }
}

describe("AutoScroller", () => {
  it("stays pinned even when a single appended message exceeds the old 80px threshold", () => {
    const pane = new FakePane(500, 500);
    let jumpShown = false;
    const scroller = new AutoScroller(pane, { onJumpChange: (s) => { jumpShown = s; } });

    // First message overflows by 220px (would have broken the post-append 80px check).
    pane.scrollHeight = 720;
    scroller.onContent();
    assert.equal(pane.scrollTop, 220);
    assert.equal(scroller.isPinned, true);
    assert.equal(jumpShown, false);

    // Browser delivers the async scroll event after programmatic snap.
    scroller.onScroll();
    assert.equal(scroller.isPinned, true);

    // Next large result card adds 340px.
    pane.scrollHeight = 1060;
    scroller.onContent();
    assert.equal(pane.scrollTop, 560);
    assert.equal(scroller.isPinned, true);
    assert.equal(jumpShown, false);
  });

  it("re-scrolls when a result card grows on a follow-up frame (e.g. Show full result button)", () => {
    const pane = new FakePane(500, 900);
    const scroller = new AutoScroller(pane);
    scroller.onContent();
    assert.equal(pane.scrollTop, 400);

    pane.scrollHeight = 944;
    scroller.onContent();
    assert.equal(pane.scrollTop, 444);
    assert.equal(scroller.isPinned, true);
  });

  it("unpins when the user scrolls up and does not yank them down on new messages", () => {
    const pane = new FakePane(500, 1200);
    let jumpShown = false;
    const scroller = new AutoScroller(pane, { onJumpChange: (s) => { jumpShown = s; } });
    scroller.onContent();
    assert.equal(pane.scrollTop, 700);

    // User scrolls up 200px to read earlier messages.
    pane.scrollTop = 500;
    scroller.onScroll();
    assert.equal(scroller.isPinned, false);
    assert.equal(jumpShown, true);

    // New messages arrive while reading.
    pane.scrollHeight = 1500;
    scroller.onContent();
    assert.equal(pane.scrollTop, 500);
    assert.equal(scroller.isPinned, false);
    assert.equal(jumpShown, true);
  });

  it("unpins on slow sub-pixel upward scrolling once past the pin threshold", () => {
    const pane = new FakePane(500, 1000);
    const scroller = new AutoScroller(pane);
    scroller.onContent();
    assert.equal(pane.scrollTop, 500);

    for (let i = 1; i <= 100; i++) {
      pane.scrollTop = 500 - i * 0.5;
      scroller.onScroll();
    }
    assert.equal(pane.scrollTop, 450);
    assert.equal(scroller.isPinned, false);
  });

  it("re-pins when the user scrolls back near the bottom", () => {
    const pane = new FakePane(500, 1200);
    let jumpShown = false;
    const scroller = new AutoScroller(pane, { onJumpChange: (s) => { jumpShown = s; } });
    scroller.onContent();

    pane.scrollTop = 400;
    scroller.onScroll();
    assert.equal(scroller.isPinned, false);
    assert.equal(jumpShown, true);

    // Scroll down partway: still unpinned.
    pane.scrollTop = 620;
    scroller.onScroll();
    assert.equal(scroller.isPinned, false);
    assert.equal(jumpShown, false);

    // Scroll back within pinThreshold (32px) of bottom: re-pins.
    pane.scrollTop = 680;
    scroller.onScroll();
    assert.equal(scroller.isPinned, true);

    pane.scrollHeight = 1400;
    scroller.onContent();
    assert.equal(pane.scrollTop, 900);
  });

  it("stays pinned across viewport shrinks (callbar, mobile task bar, keyboard) and tab switches", () => {
    const pane = new FakePane(600, 1200);
    const scroller = new AutoScroller(pane);
    scroller.onContent();
    assert.equal(pane.scrollTop, 600);

    // Callbar + mobile tasks bar shrink the transcript pane by 90px.
    pane.clientHeight = 510;
    scroller.onResize();
    assert.equal(pane.scrollTop, 690);
    assert.equal(scroller.isPinned, true);

    // Switching to Developer tab hides #talk (clientHeight = 0, scrollTop reset to 0).
    pane.clientHeight = 0;
    pane.scrollTop = 0;
    scroller.onResize();
    scroller.onScroll();
    assert.equal(scroller.isPinned, true);

    // Switching back to Talk restores bottom position.
    pane.clientHeight = 510;
    scroller.onResize();
    assert.equal(pane.scrollTop, 690);
    assert.equal(scroller.isPinned, true);
  });

  it("handles jump-to-bottom smooth scroll, retargeting on new messages, and user cancellation", () => {
    const pane = new FakePane(500, 1500);
    let jumpShown = false;
    const scroller = new AutoScroller(pane, { onJumpChange: (s) => { jumpShown = s; } });
    scroller.onContent();

    pane.scrollTop = 200;
    scroller.onScroll();
    assert.equal(scroller.isPinned, false);
    assert.equal(jumpShown, true);

    scroller.jumpToBottom();
    assert.deepEqual(pane.smoothTargets, [1500]);
    assert.equal(scroller.isPinned, true);
    assert.equal(jumpShown, false);

    // Mid-animation progress does not unpin.
    pane.scrollTop = 500;
    scroller.onScroll();
    assert.equal(scroller.isPinned, true);

    // New message arriving mid-animation retargets to the updated bottom.
    pane.scrollHeight = 1700;
    scroller.onContent();
    assert.deepEqual(pane.smoothTargets, [1500, 1700]);

    // User cancels mid-flight (e.g. touchstart / wheel up) far from bottom.
    scroller.cancelJump();
    assert.equal(scroller.isPinned, false);
    assert.equal(jumpShown, true);

    // Another jump completes smoothly to bottom.
    scroller.jumpToBottom();
    pane.scrollTop = 1200;
    scroller.onScroll();
    scroller.onScrollEnd();
    assert.equal(scroller.isPinned, true);
    assert.equal(jumpShown, false);
  });

  it("forces scroll and re-pins when user submits a message", () => {
    const pane = new FakePane(500, 1200);
    const scroller = new AutoScroller(pane);
    scroller.onContent();

    pane.scrollTop = 200;
    scroller.onScroll();
    assert.equal(scroller.isPinned, false);

    pane.scrollHeight = 1320;
    scroller.onContent(true);
    assert.equal(pane.scrollTop, 820);
    assert.equal(scroller.isPinned, true);
  });

  it("unpins when expanding a card pushes the bottom away and hides jump button while empty", () => {
    let empty = true;
    let jumpShown = false;
    const pane = new FakePane(500, 1000);
    const scroller = new AutoScroller(pane, {
      onJumpChange: (s) => { jumpShown = s; },
      isEmpty: () => empty,
    });
    scroller.onContent();
    assert.equal(jumpShown, false);

    empty = false;
    // User expands the last result card, growing scrollHeight by 400px without moving scrollTop.
    pane.scrollHeight = 1400;
    scroller.syncFromPosition();
    assert.equal(scroller.isPinned, false);
    assert.equal(jumpShown, true);
  });
});
