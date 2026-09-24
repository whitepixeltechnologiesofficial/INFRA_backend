// In-thread search — the pure matching core behind the chat search bar.
// Deliberately self-contained (erasable-only syntax, no React) so Node
// harnesses can import it directly and assert correctness on a 50+ message
// thread. The chat UI owns only the highlight rendering on top of these.

export interface SearchableMessage {
  text: string;
}

// Escape a plain-text query so regex metacharacters (`.*+?^${}()|[]\`) are
// matched literally inside the search thread.
export function escapeRegExp(query: string): string {
  return query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Build the search pattern: a single case-insensitive capture group wrapping
// the escaped query, exactly the shape the UI highlights. Returns null for an
// empty/invalid query.
export function buildSearchPattern(query: string): RegExp | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  try {
    return new RegExp("(" + escapeRegExp(trimmed) + ")", "i");
  } catch {
    return null;
  }
}

// Message indexes whose text contains at least one match, in thread order.
// Each message counts at most once (like stepping through matched bubbles).
export function chooseMatchIndexes(history: readonly SearchableMessage[], pattern: RegExp | null): number[] {
  if (!pattern) return [];
  const out: number[] = [];
  history.forEach((m, i) => {
    if (pattern.test(m.text)) out.push(i);
  });
  return out;
}

// Split a bubble's text into matched/unmatched parts: odd indexes are the
// matched fragments (`split` with a capture group keeps the matches), so the
// UI can wrap exactly those in <mark>.
export function splitHighlight(text: string, pattern: RegExp | null): string[] {
  if (!pattern) return [text];
  return text.split(pattern);
}

// Wrap-around current-match index. `n` is the match count; 0 keeps 0 (nothing
// to step). Mirrors the UI's prev/next navigation without the DOM.
export function stepMatchIndex(current: number, n: number, dir: 1 | -1): number {
  if (n === 0) return 0;
  return (Math.min(current, n - 1) + dir + n) % n;
}