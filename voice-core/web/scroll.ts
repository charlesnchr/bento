/** Minimal scrolling pane surface so auto-scroll logic stays testable without a browser DOM. */
export interface ScrollPane {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  scrollTo?(options: { top: number; behavior?: ScrollBehavior }): void;
}

export interface AutoScrollerOptions {
  /** Distance from the bottom (px) that still counts as pinned. */
  pinThreshold?: number;
  /** Distance from the bottom (px) past which the jump-to-latest control is shown. */
  jumpThreshold?: number;
  /** Called whenever the jump-to-latest control's visibility may have changed. */
  onJumpChange?: (show: boolean) => void;
  /** When true (for example while the empty state is shown), keep the jump control hidden. */
  isEmpty?: () => boolean;
}

/**
 * Keeps a transcript pane pinned to the bottom as messages stream in, without measuring
 * near-bottom after an append has already grown scrollHeight, and yields immediately when
 * the user scrolls up to read earlier messages.
 */
export class AutoScroller {
  private readonly pane: ScrollPane;
  private readonly pinThreshold: number;
  private readonly jumpThreshold: number;
  private readonly onJumpChange?: (show: boolean) => void;
  private readonly isEmpty?: () => boolean;
  private pinned = true;
  private jumping = false;
  private lastScrollTop = 0;

  constructor(pane: ScrollPane, options: AutoScrollerOptions = {}) {
    this.pane = pane;
    this.pinThreshold = options.pinThreshold ?? 32;
    this.jumpThreshold = options.jumpThreshold ?? 120;
    this.onJumpChange = options.onJumpChange;
    this.isEmpty = options.isEmpty;
    this.lastScrollTop = pane.scrollTop;
  }

  get isPinned(): boolean {
    return this.pinned;
  }

  private distance(): number {
    return Math.max(0, this.pane.scrollHeight - this.pane.scrollTop - this.pane.clientHeight);
  }

  private isVisible(): boolean {
    return this.pane.clientHeight > 0;
  }

  private snapToBottom(): void {
    if (!this.isVisible()) return;
    this.pane.scrollTop = this.pane.scrollHeight;
    this.lastScrollTop = this.pane.scrollTop;
  }

  private updateJump(): void {
    if (!this.onJumpChange) return;
    const empty = this.isEmpty?.() ?? false;
    const show = !empty && this.isVisible() && !this.jumping && this.distance() > this.jumpThreshold;
    this.onJumpChange(show);
  }

  /** Call after content is added, updated, or removed in the pane. */
  onContent(force = false): void {
    if (force) {
      this.pinned = true;
      this.jumping = false;
    }
    if (this.pinned) {
      if (this.jumping && this.pane.scrollTo && this.isVisible()) {
        this.pane.scrollTo({ top: this.pane.scrollHeight, behavior: "smooth" });
      } else {
        this.snapToBottom();
      }
    }
    this.updateJump();
  }

  /** Call when the pane's viewport resizes (bars appearing, keyboard, tab switch). */
  onResize(): void {
    if (!this.isVisible()) return;
    if (this.pinned) {
      this.jumping = false;
      this.snapToBottom();
    } else {
      this.lastScrollTop = this.pane.scrollTop;
    }
    this.updateJump();
  }

  /** Call from the pane's scroll event listener. */
  onScroll(): void {
    if (!this.isVisible()) return;
    const top = this.pane.scrollTop;
    const dist = this.distance();
    const movedUp = top < this.lastScrollTop;
    this.lastScrollTop = top;

    if (dist <= this.pinThreshold) {
      this.pinned = true;
      this.jumping = false;
    } else if (movedUp) {
      this.pinned = false;
      this.jumping = false;
    }
    this.updateJump();
  }

  /** Call from the pane's scrollend event listener. */
  onScrollEnd(): void {
    if (!this.isVisible() || !this.jumping) return;
    this.jumping = false;
    if (this.distance() > this.pinThreshold) this.pinned = false;
    this.updateJump();
  }

  /** Call on user wheel-up or touchstart so an active smooth jump yields to the user. */
  cancelJump(): void {
    if (!this.jumping) return;
    this.jumping = false;
    if (this.distance() > this.pinThreshold) this.pinned = false;
    this.updateJump();
  }

  /** Re-pin and scroll smoothly to the bottom (used by the jump-to-latest button). */
  jumpToBottom(): void {
    this.pinned = true;
    if (!this.isVisible()) {
      this.updateJump();
      return;
    }
    if (this.distance() <= this.pinThreshold || !this.pane.scrollTo) {
      this.jumping = false;
      this.snapToBottom();
    } else {
      this.jumping = true;
      this.lastScrollTop = this.pane.scrollTop;
      this.pane.scrollTo({ top: this.pane.scrollHeight, behavior: "smooth" });
    }
    this.updateJump();
  }

  /** Recompute pinned state from the current position after a user-driven layout change (e.g. expanding a result). */
  syncFromPosition(): void {
    if (!this.isVisible()) return;
    this.jumping = false;
    this.lastScrollTop = this.pane.scrollTop;
    this.pinned = this.distance() <= this.pinThreshold;
    this.updateJump();
  }

  /** Pause auto-scroll explicitly (e.g. when revealing an older result card). */
  unpin(): void {
    this.pinned = false;
    this.jumping = false;
    this.updateJump();
  }
}
