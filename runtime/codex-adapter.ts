import { invokeCodexCli } from "../codex/process.ts";
import type { InteractiveResult, RuntimeAdapter } from "./types.ts";

/**
 * Runtime adapter for the OpenAI Codex CLI.
 *
 * Modeled after the `@openai/codex-sdk` TypeScript SDK but implemented as a
 * direct subprocess wrapper so the package stays dependency-free for Deno
 * consumers. Upstream reference:
 * https://github.com/openai/codex/tree/main/sdk/typescript — use this as the
 * source of truth when porting additional features (images, output schema,
 * reasoning effort, web search, etc.). See
 * {@link import("../codex/process.ts")} for transport details (argv
 * construction, NDJSON event parsing, and `CliRunOutput` extraction).
 *
 * Capabilities:
 * - `permissionMode: false` — Codex has no first-class `--permission-mode`
 *   flag; the wrapper only recognizes `bypassPermissions` and maps it to
 *   `--sandbox danger-full-access` + `approval_policy="never"`.
 * - `hitl: false` — no engine-managed HITL resume flow.
 * - `transcript: false` — Codex does not expose an external transcript file.
 * - `interactive: false` — interactive CLI mode is the Codex TUI, which the
 *   wrapper does not drive; callers should invoke `codex` directly for that.
 */
export const codexRuntimeAdapter: RuntimeAdapter = {
  id: "codex",
  capabilities: {
    permissionMode: false,
    hitl: false,
    transcript: false,
    interactive: false,
    toolUseObservation: false,
  },
  invoke(opts) {
    return invokeCodexCli(opts);
  },

  launchInteractive(): Promise<InteractiveResult> {
    throw new Error(
      "Codex has no headless interactive mode — use `codex` TUI directly",
    );
  },
};
