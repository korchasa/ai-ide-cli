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
import { CODEX_HITL_MCP_SERVER_NAME } from "./hitl-mcp.ts";
import { decidePermissionMode } from "./permission-mode.ts";
import type { HitlConfig } from "../types.ts";

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
  // (approval policy via permission mode, MCP server registration via
  // HITL, FR-L25 reasoning effort). Reserving `--config` would block
  // legitimate consumer uses of repeatable `--config k=v` overrides
  // (model_reasoning_effort, web_search, sandbox_workspace_write,
  // openai_base_url, etc. — see the SDK reference list at the top of
  // codex/process.ts). Repetition is expected.
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
 * Build the `--config mcp_servers.<name>.command/args` overrides that
 * register a per-invocation local stdio MCP server with Codex. Returns
 * `[]` when no HITL command is configured.
 *
 * The serialization mirrors the TOML overrides emitted by
 * `@openai/codex-sdk`: scalar strings are JSON-quoted, arrays are TOML
 * literal arrays of JSON-quoted strings.
 *
 * Exported for testing.
 */
export function buildCodexHitlConfigArgs(
  opts: RuntimeInvokeOptions,
): string[] {
  if (!hasConfiguredHitl(opts.hitlConfig)) return [];
  if (!opts.hitlMcpCommandBuilder) {
    throw new Error(
      "Codex HITL requires hitlMcpCommandBuilder — consumer must supply " +
        "a sub-process entry point for the HITL MCP server. See " +
        "RuntimeInvokeOptions.hitlMcpCommandBuilder JSDoc.",
    );
  }
  const argv = opts.hitlMcpCommandBuilder();
  if (!argv.length) {
    throw new Error("hitlMcpCommandBuilder returned an empty argv");
  }
  const [command, ...rest] = argv;
  const serverPrefix = `mcp_servers.${CODEX_HITL_MCP_SERVER_NAME}`;
  const args: string[] = [
    "--config",
    `${serverPrefix}.command=${JSON.stringify(command)}`,
  ];
  if (rest.length > 0) {
    const renderedArgs = rest.map((a) => JSON.stringify(a)).join(", ");
    args.push("--config", `${serverPrefix}.args=[${renderedArgs}]`);
  }
  return args;
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
 * - HITL injection: see {@link buildCodexHitlConfigArgs}.
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
  args.push(...buildCodexHitlConfigArgs(opts));
  // FR-L25: abstract reasoning effort → native Codex config override.
  if (opts.reasoningEffort) {
    args.push(
      "--config",
      `model_reasoning_effort="${opts.reasoningEffort}"`,
    );
  }
  args.push(...expandExtraArgs(opts.extraArgs, CODEX_RESERVED_FLAGS));

  if (opts.resumeSessionId) {
    args.push("resume", opts.resumeSessionId);
  }

  return args;
}

function hasConfiguredHitl(config?: HitlConfig): config is HitlConfig {
  return Boolean(config?.ask_script && config?.check_script);
}
