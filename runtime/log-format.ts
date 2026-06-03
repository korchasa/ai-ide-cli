/**
 * @module
 * Shared log-formatting helpers used by every runtime adapter to write
 * `stream.log`. Lives in `runtime/` (not a per-runtime directory) because
 * the helpers are runtime-agnostic — each adapter still owns its own
 * `format<Runtime>EventForOutput` summary; this module only wraps the
 * result with a timestamp prefix so the file shape is uniform across
 * Claude, Codex, Cursor, and OpenCode (FR-L40).
 */

/** Returns current local time as `[HH:MM:SS]` prefix string. */
export function tsPrefix(): string {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `[${h}:${m}:${s}]`;
}

/**
 * Prepend `[HH:MM:SS] ` to each non-empty line of `text`. Empty lines
 * pass through unchanged so paragraph breaks survive round-trip.
 */
// FR-L40
export function stampLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line ? `${tsPrefix()} ${line}` : line)
    .join("\n");
}
