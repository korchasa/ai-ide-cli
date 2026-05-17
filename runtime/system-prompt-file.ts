/**
 * @module
 * Validation helper for file-based system prompt delivery. Claude supports a
 * native `--append-system-prompt-file` flag; other runtimes currently do not.
 */

import type { RuntimeId } from "../types.ts";
import type { RuntimeInvokeOptions } from "./adapter-types.ts";

/** Reject `systemPromptFile` for runtimes that have no native file prompt flag. */
export function rejectUnsupportedSystemPromptFile(
  runtime: RuntimeId,
  opts: Pick<RuntimeInvokeOptions, "systemPromptFile">,
): void {
  if (opts.systemPromptFile === undefined) return;
  throw new Error(
    `Runtime '${runtime}' does not support systemPromptFile; pass systemPrompt instead.`,
  );
}
