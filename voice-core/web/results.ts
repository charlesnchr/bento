// Pure helpers for agent result summaries and the side-panel result inspector.

export interface ResultEntry {
  id: number;
  agent: "hermes" | "t3";
  label: string;
  text: string;
  failed: boolean;
}

/**
 * Strips lightweight Markdown formatting and collapses whitespace into a single-line preview
 * suitable for collapsed result headers and compact task cards.
 */
export function resultSnippet(text: string, maxChars = 120): string {
  const flat = text
    .replace(/```(?:\w+)?\n?([\s\S]*?)```/g, (_, code: string) => ` ${code} `)
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/(^|\n)\s*#{1,6}\s+/g, "$1")
    .replace(/(^|\n)\s*(?:[-*•]|\d+[.)])\s+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= maxChars) return flat;
  const cut = flat.slice(0, Math.max(1, maxChars - 1)).replace(/\s+\S*$/, "");
  const prefix = cut.length >= maxChars * 0.5 ? cut : flat.slice(0, Math.max(1, maxChars - 1));
  return `${prefix.trimEnd()}…`;
}

/** Tracks agent results added during the session and which one the inspector currently shows. */
export class ResultStore {
  private entries: ResultEntry[] = [];
  private nextId = 1;
  private activeId: number | null = null;

  add(input: Omit<ResultEntry, "id">): ResultEntry {
    const entry: ResultEntry = { id: this.nextId++, ...input };
    this.entries.push(entry);
    return entry;
  }

  get count(): number {
    return this.entries.length;
  }

  get current(): ResultEntry | null {
    if (this.activeId == null) return null;
    return this.entries.find((e) => e.id === this.activeId) ?? null;
  }

  get currentIndex(): number {
    if (this.activeId == null) return -1;
    return this.entries.findIndex((e) => e.id === this.activeId);
  }

  byId(id: number): ResultEntry | null {
    return this.entries.find((e) => e.id === id) ?? null;
  }

  open(id?: number): ResultEntry | null {
    if (this.entries.length === 0) {
      this.activeId = null;
      return null;
    }
    const target = id != null ? this.byId(id) : this.entries[this.entries.length - 1];
    this.activeId = target ? target.id : null;
    return target;
  }

  close(): void {
    this.activeId = null;
  }

  step(delta: -1 | 1): ResultEntry | null {
    const idx = this.currentIndex;
    if (idx < 0) return null;
    const next = idx + delta;
    if (next < 0 || next >= this.entries.length) return this.entries[idx];
    this.activeId = this.entries[next].id;
    return this.entries[next];
  }
}
