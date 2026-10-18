/**
 * @module
 * Codex CLI argv builders for `codex exec --json`. Pure
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
import {
  rejectTypedFlagCollision,
  validateOutputSchema,
} from "../runtime/run-options.ts";

/**
 * Flags reserved by {@link buildCodexArgs}. Keys in `extraArgs` that match
 * these throw synchronously — the adapter emits them itself. Hidden
 * aliases of these flags are rejected too (see
 * {@link CODEX_RESERVED_FLAG_ALIASES}).
 */
export const CODEX_RESERVED_FLAGS: readonly string[] = [
  "--json",
  "--model",
  "--cd",
  "--sandbox",
];

// FR-L14
/**
 * Hidden aliases of {@link CODEX_RESERVED_FLAGS} entries — never emitted,
 * but rejected in `extraArgs` like the flag they alias.
 * `--experimental-json` is a clap alias of `--json` (one field, every
 * Codex since the 0.121.0 floor); passing it next to the adapter's
 * `--json` makes Codex exit 2 with `the argument '--json' cannot be used
 * multiple times`.
 */
const CODEX_RESERVED_FLAG_ALIASES: readonly string[] = [
  "--experimental-json",
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
  // FR-L50: typed `outputSchema` is preferred; legacy
  // `extraArgs: { "--output-schema": "<file>" }` stays valid when it is
  // unset. Collision is checked by `rejectTypedFlagCollision`.
  "--output-schema",
  // FR-L52: same back-compat reasoning for typed `ephemeral`.
  "--ephemeral",
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

// FR-L13
// FR-L50
// FR-L52
/**
 * Build CLI arguments for the `codex` command.
 * Exported for testing.
 *
 * Codex headless mode: `codex exec --json [flags] [resume <id>]`.
 * Prompt is written to the subprocess stdin; it is NOT appended to argv.
 *
 * - Session resume: `resume <threadId>` positional subcommand.
 * - Permissions: see {@link permissionModeToCodexArgs}.
 * - `outputSchemaPath`: the temp file the runner wrote `opts.outputSchema`
 *   to (FR-L50) → `--output-schema <path>`. The builder stays pure, so
 *   the runner owns the file.
 * - `opts.ephemeral` → `--ephemeral` (FR-L52).
 *
 * @param opts Invocation options.
 * @param outputSchemaPath Path of the written schema file, when any.
 */
export function buildCodexArgs(
  opts: RuntimeInvokeOptions,
  outputSchemaPath?: string,
): string[] {
  validateOutputSchema(opts.outputSchema);
  rejectTypedFlagCollision(
    "outputSchema",
    opts.outputSchema,
    ["--output-schema"],
    opts.extraArgs,
  );
  rejectTypedFlagCollision(
    "ephemeral",
    opts.ephemeral,
    ["--ephemeral"],
    opts.extraArgs,
  );
  const args: string[] = ["exec", "--json"];

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
  // FR-L50 / FR-L52
  if (outputSchemaPath) args.push("--output-schema", outputSchemaPath);
  if (opts.ephemeral) args.push("--ephemeral");
  args.push(
    ...expandExtraArgs(opts.extraArgs, [
      ...CODEX_RESERVED_FLAGS,
      ...CODEX_RESERVED_FLAG_ALIASES,
    ]),
  );

  if (opts.resumeSessionId) {
    args.push("resume", opts.resumeSessionId);
  }

  return args;
}
