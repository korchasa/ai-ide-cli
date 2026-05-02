/**
 * @module
 * `cursor agent create-chat` invocation. Returns the freshly minted chat ID
 * used as the `--resume` target by every subsequent
 * {@link import("./session.ts").CursorSession.send}.
 *
 * Split out of `cursor/session.ts` so the create-chat path has a focused
 * test surface independent of the worker loop. The parent module re-exports
 * {@link createCursorChat} for back-compat.
 */

import type { ProcessRegistry } from "../process-registry.ts";
import { withSyncedPWD } from "../runtime/env-cwd-sync.ts";

/** Options for {@link createCursorChat}. */
export interface CreateCursorChatOptions {
  /** Working directory for the subprocess. */
  cwd?: string;
  /** Extra env merged into the subprocess env. */
  env?: Record<string, string>;
  /**
   * Optional timeout in seconds for the create-chat call.
   * Default: 30 seconds.
   */
  timeoutSeconds?: number;
  /**
   * Optional process registry that owns the spawned subprocess. When
   * omitted, the module-level default registry is used.
   */
  processRegistry: ProcessRegistry;
}

/**
 * Invoke `cursor agent create-chat`, returning the new chat ID.
 * Exported for callers that want to create a chat ahead of time (e.g. to
 * pass to {@link import("./process.ts").invokeCursorCli} via
 * `resumeSessionId`).
 */
export async function createCursorChat(
  opts: CreateCursorChatOptions,
): Promise<string> {
  const timeoutMs = (opts.timeoutSeconds ?? 30) * 1000;
  // FR-L33: sync env.PWD with cwd at the spawn boundary.
  const syncedEnv = withSyncedPWD(opts.env, opts.cwd);
  const cmd = new Deno.Command("cursor", {
    args: ["agent", "create-chat"],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(syncedEnv ? { env: syncedEnv } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const proc = cmd.spawn();
  const registry = opts.processRegistry;
  registry.register(proc);
  try {
    const [status, stdoutBuf, stderrBuf] = await Promise.all([
      proc.status,
      readAll(proc.stdout),
      readAll(proc.stderr),
    ]);
    if (!status.success) {
      const stderr = new TextDecoder().decode(stderrBuf).trim();
      throw new Error(
        `cursor agent create-chat exited with code ${status.code}${
          stderr ? `: ${stderr}` : ""
        }`,
      );
    }
    const id = parseChatId(new TextDecoder().decode(stdoutBuf));
    if (!id) {
      throw new Error(
        "cursor agent create-chat returned empty output (expected chat ID)",
      );
    }
    return id;
  } finally {
    registry.unregister(proc);
  }
}

async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.length;
  }
  return buf;
}

/**
 * Extract a chat ID from `cursor agent create-chat` stdout.
 *
 * The CLI may wrap the ID in surrounding log noise depending on version; we
 * pick the last non-empty whitespace-separated token to be resilient.
 */
function parseChatId(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  return tokens[tokens.length - 1] ?? "";
}
