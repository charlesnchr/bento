// Pure UI helpers for the Voice web surface (density, agent-pane filtering, compact previews).

export type SideFilter = "all" | "active" | "results";
export type Density = "compact" | "comfortable";

export interface SideCounts {
  active: number;
  results: number;
  earlier: number;
  done: number;
}

export interface SideVisibility {
  showTasksSection: boolean;
  showEmptyTasks: boolean;
  showResultsSection: boolean;
  showEmptyResults: boolean;
  showEarlierSection: boolean;
  showDoneSection: boolean;
}

export function normalizeDensity(value: string | null | undefined): Density {
  return value === "comfortable" ? "comfortable" : "compact";
}

export function normalizeSideFilter(value: string | null | undefined): SideFilter {
  if (value === "active" || value === "results") return value;
  return "all";
}

export function parsePrefix(text: string): { mode: "hermes" | "t3" | null; rest: string } {
  const m = text.match(/^\/(t3|code|h|hermes)\s+(.*)$/is);
  if (!m) return { mode: null, rest: text };
  return { mode: /^(t3|code)$/i.test(m[1]) ? "t3" : "hermes", rest: m[2].trim() };
}

/** A result card may only steer a task that belongs to the same active session (task IDs restart per call). */
export function canFollowUpResult(resultSession: number, activeSession: number, hasTask: boolean): boolean {
  return activeSession > 0 && resultSession === activeSession && hasTask;
}

/** Unread mobile result alerts only clear once the Results section is actually visible to the user. */
export function shouldClearUnreadResults(isMobile: boolean, drawerOpen: boolean, filter: SideFilter): boolean {
  return !isMobile || (drawerOpen && filter !== "active");
}

/** Flatten a Markdown agent reply into a single-line plain-text preview for inline handoff chips. */
export function plainPreview(text: string, maxLen = 150): string {
  const cleaned = text
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code: string) => ` ${code.trim()} `)
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, "")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= maxLen) return cleaned;
  const cut = cleaned.slice(0, maxLen);
  const space = cut.lastIndexOf(" ");
  const base = space > Math.floor(maxLen * 0.6) ? cut.slice(0, space) : cut;
  return `${base.replace(/[.,;:\s-]+$/, "")}…`;
}

export function formatShortTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Decide which sections of the right-hand Agent Workspace are visible for a given filter and counts. */
export function resolveSideSections(filter: SideFilter, counts: SideCounts): SideVisibility {
  if (filter === "results") {
    return {
      showTasksSection: false,
      showEmptyTasks: false,
      showResultsSection: true,
      showEmptyResults: counts.results === 0,
      showEarlierSection: false,
      showDoneSection: false,
    };
  }
  if (filter === "active") {
    return {
      showTasksSection: true,
      showEmptyTasks: counts.active === 0 && counts.earlier === 0,
      showResultsSection: false,
      showEmptyResults: false,
      showEarlierSection: counts.earlier > 0,
      showDoneSection: counts.done > 0,
    };
  }
  // "all": hide the empty active-tasks placeholder as soon as results or earlier agents exist
  // so finished responses take the top of the pane without wasted space.
  const hasAnythingAboveDone = counts.active > 0 || counts.results > 0 || counts.earlier > 0;
  return {
    showTasksSection: counts.active > 0 || !hasAnythingAboveDone,
    showEmptyTasks: !hasAnythingAboveDone,
    showResultsSection: counts.results > 0,
    showEmptyResults: false,
    showEarlierSection: counts.earlier > 0,
    showDoneSection: counts.done > 0,
  };
}
