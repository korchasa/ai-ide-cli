/**
 * @module
 * Codex transcript path discovery. Codex writes rollouts to
 * `<sessionsDir>/YYYY/MM/DD/rollout-<timestamp>-<thread_id>.jsonl`. The
 * helpers in this file walk the date-bucketed directory layout for the
 * run's start date and a small surrounding window (covers UTC/local
 * midnight boundaries) to surface the absolute path on `CliRunOutput`.
 */

import { join } from "@std/path";

/** Default Codex sessions directory: `$CODEX_HOME/sessions` or `~/.codex/sessions`. */
export function defaultCodexSessionsDir(): string {
  const codexHome = Deno.env.get("CODEX_HOME") ??
    join(Deno.env.get("HOME") ?? Deno.cwd(), ".codex");
  return join(codexHome, "sessions");
}

/**
 * Locate the persisted Codex rollout transcript file for a given thread id.
 *
 * Codex writes rollouts as
 * `<sessionsDir>/YYYY/MM/DD/rollout-<timestamp>-<thread_id>.jsonl`. The
 * directory layout reflects the run's start date, so the lookup walks
 * `<sessionsDir>/<year>/<month>/<day>` for the run's own start date and the
 * preceding day (covers UTC/local-midnight boundaries) before falling back
 * to a small recent-history scan.
 *
 * Returns the absolute path on success, or `undefined` if no matching file
 * is found (or the sessions dir does not exist).
 */
export async function findCodexSessionFile(
  threadId: string,
  startMs: number = Date.now(),
  sessionsDir: string = defaultCodexSessionsDir(),
): Promise<string | undefined> {
  if (!threadId) return undefined;
  try {
    await Deno.stat(sessionsDir);
  } catch {
    return undefined;
  }

  const suffix = `-${threadId}.jsonl`;
  const dates: string[] = [];
  for (
    let offsetMs = 0;
    offsetMs <= 24 * 3600 * 1000;
    offsetMs += 3600 * 1000
  ) {
    const d = new Date(startMs + offsetMs);
    dates.push(formatYmd(d));
    const back = new Date(startMs - offsetMs);
    dates.push(formatYmd(back));
  }
  const seen = new Set<string>();
  for (const ymd of dates) {
    if (seen.has(ymd)) continue;
    seen.add(ymd);
    const [y, m, d] = ymd.split("-");
    const dir = join(sessionsDir, y, m, d);
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (
          entry.isFile && entry.name.startsWith("rollout-") &&
          entry.name.endsWith(suffix)
        ) {
          return join(dir, entry.name);
        }
      }
    } catch {
      // Directory absent for this date — ignore and continue.
    }
  }
  return undefined;
}

/** Format a Date as `YYYY-MM-DD`. Exported for testing. */
export function formatYmd(d: Date): string {
  const y = d.getFullYear().toString().padStart(4, "0");
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}
