/**
 * @module
 * Argv builder for the per-send `cursor agent -p --resume <chatId>` invocations
 * spawned by {@link import("./session.ts").openCursorSession}'s worker loop.
 *
 * Split out of `cursor/session.ts` so the argv shape has a focused unit-test
 * surface independent of subprocess wiring. The parent module re-exports
 * {@link buildCursorSendArgs} for back-compat.
 */

import type { ExtraArgsMap } from "../runtime/types.ts";
import { expandExtraArgs } from "../runtime/argv.ts";
import { CURSOR_RESERVED_FLAGS } from "./process.ts";

/**
 * Build the argv for a single `cursor agent -p --resume <chatId> <message>`
 * invocation used by {@link import("./session.ts").openCursorSession}'s
 * worker loop. Exported for unit testing.
 */
export function buildCursorSendArgs(opts: {
  /** Target chat ID for `--resume`. */
  chatId: string;
  /** The user message passed as the positional prompt. */
  message: string;
  /** Cursor permission mode. `"bypassPermissions"` maps to `--yolo`. */
  permissionMode?: string;
  /** Extra CLI flags (see {@link ExtraArgsMap}). */
  cursorArgs?: ExtraArgsMap;
}): string[] {
  const args: string[] = ["agent", "-p", "--resume", opts.chatId];
  if (opts.permissionMode === "bypassPermissions") {
    args.push("--yolo");
  }
  args.push(...expandExtraArgs(opts.cursorArgs, CURSOR_RESERVED_FLAGS));
  args.push("--output-format", "stream-json");
  args.push("--trust");
  args.push(opts.message);
  return args;
}
