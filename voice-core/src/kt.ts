// The few Kotlin collection and string helpers the port leans on, written so every engine gives
// the same answer (no reliance on an engine's sort being stable, say).

export function take(text: string, n: number): string {
  return text.length <= n ? text : text.slice(0, n);
}

export function takeLast(text: string, n: number): string {
  return text.length <= n ? text : text.slice(text.length - n);
}

export function trimChars(text: string, chars: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && chars.includes(text[start])) start++;
  while (end > start && chars.includes(text[end - 1])) end--;
  return text.slice(start, end);
}

export function lastOrNull<T>(items: readonly T[]): T | null {
  return items.length === 0 ? null : items[items.length - 1];
}

export function maxOrNull(items: readonly number[]): number | null {
  let best: number | null = null;
  for (const v of items) if (best === null || v > best) best = v;
  return best;
}

/** The only item, or null when there are none or several (Kotlin's `singleOrNull`). */
export function single<T>(items: readonly T[]): T | null {
  return items.length === 1 ? items[0] : null;
}

/** A stable sort, highest first. */
export function sortByDescending<T>(items: readonly T[], key: (item: T) => number): T[] {
  return items.map((item, i) => ({ item, i, k: key(item) }))
    .sort((a, b) => (b.k - a.k) || (a.i - b.i))
    .map((e) => e.item);
}

export function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
