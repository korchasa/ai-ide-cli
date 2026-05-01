/**
 * @module
 * OpenCode CLI argv builder + per-invocation config-content builder.
 *
 * Pure functions: no subprocess spawning, no event aggregation. The runner
 * (`opencode/process.ts`) composes these into the `Deno.Command` argv +
 * `OPENCODE_CONFIG_CONTENT` env var.
 */

import type { HitlConfig } from "../types.ts";
import type { RuntimeInvokeOptions } from "../runtime/types.ts";
import { expandExtraArgs } from "../runtime/argv.ts";
import { OPENCODE_HITL_MCP_SERVER_NAME } from "./hitl-mcp.ts";

/**
 * Flags reserved by {@link buildOpenCodeArgs}. Keys in `extraArgs` that
 * match these throw synchronously — the adapter emits them itself.
 */
export const OPENCODE_RESERVED_FLAGS: readonly string[] = [
  "--format",
  "--session",
  "--model",
  "--agent",
  "--dangerously-skip-permissions",
];

/**
 * Informational only — these are positional subcommand names emitted by
 * {@link buildOpenCodeArgs} (`run`), not CLI flags. They cannot enter via
 * `extraArgs` (which serializes only flags), so they are kept separate
 * from {@link OPENCODE_RESERVED_FLAGS} for documentation.
 */
export const OPENCODE_RESERVED_POSITIONALS: readonly string[] = [
  "run",
];

/**
 * Flags {@link buildOpenCodeArgs} may emit but are deliberately **not**
 * in {@link OPENCODE_RESERVED_FLAGS}.
 */
export const OPENCODE_INTENTIONALLY_OPEN_FLAGS: readonly string[] = [
  // FR-L25: typed `reasoningEffort` is preferred, but legacy
  // `extraArgs: { "--variant": "high" }` still works.
  "--variant",
];

/** Build CLI arguments for the opencode command. Exported for testing. */
export function buildOpenCodeArgs(opts: RuntimeInvokeOptions): string[] {
  const args: string[] = ["run"];

  if (opts.resumeSessionId) {
    args.push("--session", opts.resumeSessionId);
  }

  if (opts.model && !opts.resumeSessionId) {
    args.push("--model", opts.model);
  }

  if (opts.agent && !opts.resumeSessionId) {
    args.push("--agent", opts.agent);
  }

  if (opts.permissionMode === "bypassPermissions") {
    args.push("--dangerously-skip-permissions");
  }

  // FR-L25: abstract reasoning effort → OpenCode's `--variant`.
  // Forwarded verbatim; provider-specific interpretation may differ.
  if (opts.reasoningEffort) {
    args.push("--variant", opts.reasoningEffort);
  }

  args.push(...expandExtraArgs(opts.extraArgs, OPENCODE_RESERVED_FLAGS));

  args.push("--format", "json");
  // `--` separator: taskPrompt is a positional argument and may begin with
  // `-` (e.g. when systemPrompt content starts with YAML frontmatter `---`).
  // Without this separator yargs treats the prompt as an unknown long flag,
  // opencode prints its usage and exits with code 1.
  args.push("--", opts.taskPrompt);

  return args;
}

/** Build per-invocation OpenCode config content used to inject local MCP servers. */
export function buildOpenCodeConfigContent(
  opts: RuntimeInvokeOptions,
): string | undefined {
  if (!hasConfiguredHitl(opts.hitlConfig)) {
    return undefined;
  }

  if (!opts.hitlMcpCommandBuilder) {
    throw new Error(
      "OpenCode HITL requires hitlMcpCommandBuilder — consumer must supply " +
        "a sub-process entry point for the HITL MCP server. See " +
        "RuntimeInvokeOptions.hitlMcpCommandBuilder JSDoc.",
    );
  }

  return JSON.stringify({
    mcp: {
      [OPENCODE_HITL_MCP_SERVER_NAME]: {
        type: "local",
        command: opts.hitlMcpCommandBuilder(),
        enabled: true,
      },
    },
  });
}

function hasConfiguredHitl(config?: HitlConfig): config is HitlConfig {
  return Boolean(config?.ask_script && config?.check_script);
}
