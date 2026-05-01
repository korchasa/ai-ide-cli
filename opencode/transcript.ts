/**
 * @module
 * OpenCode transcript export. Wraps `opencode export <sessionId>` and
 * captures stdout into a temp file. Surfaces failure via a discriminated
 * result instead of swallowing the error (FR-L32).
 */

import { withSyncedPWD } from "../runtime/env-cwd-sync.ts";

/**
 * Result of {@link exportOpenCodeTranscript}. Exactly one of `path` or
 * `error` is populated:
 *
 * - `{ path }` — export succeeded; absolute path to a temp file holding
 *   the transcript JSON.
 * - `{ error }` — export attempt failed; `error` is a short diagnostic
 *   suitable for surfacing as `CliRunOutput.transcript_error` (FR-L32).
 *
 * Empty / no-id input returns `{}` so callers can branch uniformly.
 */
export interface OpenCodeTranscriptResult {
  /** Absolute path to the temp file holding the captured transcript JSON. */
  path?: string;
  /** Short diagnostic when export failed (subprocess non-zero, I/O error, …). */
  error?: string;
}

/**
 * Export an OpenCode session transcript to a local temporary file by invoking
 * `opencode export <sessionId> [--sanitize]` and capturing stdout.
 *
 * Returns `{ path }` on success, `{ error }` on failure (FR-L32 — previously
 * failures were swallowed wholesale, leaving consumers unable to
 * distinguish "runtime exposes no transcript" from "export attempted but
 * crashed"). The caller is responsible for surfacing `error` to the
 * normalized `CliRunOutput.transcript_error` field; failures still never
 * throw, so the primary invocation result is never masked.
 *
 * Exported for testing.
 */
export async function exportOpenCodeTranscript(
  sessionId: string,
  opts?: {
    cwd?: string;
    env?: Record<string, string>;
    sanitize?: boolean;
    signal?: AbortSignal;
  },
): Promise<OpenCodeTranscriptResult> {
  if (!sessionId) return {};
  const args = ["export", sessionId];
  if (opts?.sanitize) args.push("--sanitize");
  try {
    // FR-L33: sync env.PWD with cwd at the spawn boundary.
    const syncedEnv = withSyncedPWD(opts?.env, opts?.cwd);
    const cmd = new Deno.Command("opencode", {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      ...(syncedEnv ? { env: syncedEnv } : {}),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
    const { success, code, stdout, stderr } = await cmd.output();
    if (!success) {
      const tail = new TextDecoder().decode(stderr).trim();
      return {
        error: `opencode export exited with code ${code}${
          tail ? `: ${tail.slice(0, 256)}` : ""
        }`,
      };
    }
    if (stdout.length === 0) {
      return { error: "opencode export produced empty stdout" };
    }
    const path = await Deno.makeTempFile({
      prefix: `opencode-transcript-${sessionId}-`,
      suffix: ".json",
    });
    await Deno.writeFile(path, stdout);
    return { path };
  } catch (err) {
    return {
      error: `opencode export failed: ${(err as Error).message ?? String(err)}`,
    };
  }
}
