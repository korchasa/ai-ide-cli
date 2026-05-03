/**
 * @module
 * Codex CLI argv builders for `codex exec --experimental-json`. Pure
 * functions: no subprocess spawning, no event aggregation. The runner
 * (`codex/process.ts`) composes these into the `Deno.Command` argv.
 *
 * Mirrors the per-runtime convention seen in `claude/process.ts` /
 * `opencode/process.ts`: argv-shape concerns live next to one another
 * so adding a flag (e.g. `--add-dir`, `--output-schema`) only requires
 * editing this file plus the matching reserved-flag set.
 */

import type { RuntimeInvokeOptions } from "../runtime/types.ts";
import { expandExtraArgs } from "../runtime/argv.ts";
import {
  buildCodexMcpServersArgs,
  validateMcpServers,
} from "../runtime/mcp-injection.ts";
import { decidePermissionMode } from "./permission-mode.ts";

/**
 * Flags reserved by {@link buildCodexArgs}. Keys in `extraArgs` that match
 * these throw synchronously — the adapter emits them itself.
 */
export const CODEX_RESERVED_FLAGS: readonly string[] = [
  "--experimental-json",
  "--model",
  "--cd",
  "--sandbox",
];

/**
 * Informational only — these are positional subcommand names emitted by
 * {@link buildCodexArgs} (`exec`, `resume <id>`), not CLI flags. They cannot
 * enter via `extraArgs` (which serializes only flags), so they are kept
 * separate from {@link CODEX_RESERVED_FLAGS} for documentation.
 */
export const CODEX_RESERVED_POSITIONALS: readonly string[] = [
  "exec",
  "resume",
];

/**
 * Flags {@link buildCodexArgs} may emit but are deliberately **not** in
 * {@link CODEX_RESERVED_FLAGS}. Each entry exists for a documented reason.
 */
export const CODEX_INTENTIONALLY_OPEN_FLAGS: readonly string[] = [
  // The adapter emits `--config <key=value>` for several purposes
  // (approval policy via permission mode, FR-L25 reasoning effort).
  // Reserving `--config` would block legitimate consumer uses of
  // repeatable `--config k=v` overrides (model_reasoning_effort,
  // web_search, sandbox_workspace_write, openai_base_url, etc. — see
  // the SDK reference list at the top of codex/process.ts). Repetition
  // is expected.
  "--config",
];

/**
 * Map a runtime-neutral permission mode to Codex argv fragments.
 *
 * Thin serializer over `decidePermissionMode` — the conceptual decision
 * lives there, this function only renders it as `--sandbox` /
 * `--config approval_policy="…"` argv. The companion mapper for the
 * app-server transport is `permissionModeToThreadStartFields` in
 * `codex/session.ts`.
 *
 * Returns `[]` for `default` / unrecognized values so Codex falls back
 * to its own config defaults.
 *
 * Exported for testing.
 */
export function permissionModeToCodexArgs(mode?: string): string[] {
  const { sandbox, approvalPolicy } = decidePermissionMode(mode);
  const out: string[] = [];
  if (sandbox) out.push("--sandbox", sandbox);
  if (approvalPolicy) {
    out.push("--config", `approval_policy="${approvalPolicy}"`);
  }
  return out;
}

/**
 * Build CLI arguments for the `codex` command.
 * Exported for testing.
 *
 * Codex headless mode: `codex exec --experimental-json [flags] [resume <id>]`.
 * Prompt is written to the subprocess stdin; it is NOT appended to argv.
 *
 * - Session resume: `resume <threadId>` positional subcommand.
 * - Permissions: see {@link permissionModeToCodexArgs}.
 */
export function buildCodexArgs(opts: RuntimeInvokeOptions): string[] {
  const args: string[] = ["exec", "--experimental-json"];

  if (opts.model) {
    args.push("--model", opts.model);
  }

  if (opts.cwd) {
    args.push("--cd", opts.cwd);
  }

  args.push(...permissionModeToCodexArgs(opts.permissionMode));
  // FR-L25: abstract reasoning effort → native Codex config override.
  if (opts.reasoningEffort) {
    args.push(
      "--config",
      `model_reasoning_effort="${opts.reasoningEffort}"`,
    );
  }
  // FR-L35: typed mcpServers → repeated `--config mcp_servers.<name>.*`
  // overrides. Validated synchronously (rejects http on codex). Emitted
  // before consumer-supplied extraArgs so explicit `--config
  // mcp_servers.*` overrides in extraArgs win on duplication.
  validateMcpServers("codex", { mcpServers: opts.mcpServers });
  args.push(...buildCodexMcpServersArgs(opts.mcpServers));
  args.push(...expandExtraArgs(opts.extraArgs, CODEX_RESERVED_FLAGS));

  if (opts.resumeSessionId) {
    args.push("resume", opts.resumeSessionId);
  }

  return args;
}
