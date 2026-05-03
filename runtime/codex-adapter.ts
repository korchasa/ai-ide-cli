import { invokeCodexCli } from "../codex/process.ts";
import { openCodexSession } from "../codex/session.ts";
import type {
  InteractiveOptions,
  InteractiveResult,
  RuntimeAdapter,
  RuntimeInvokeOptions,
  RuntimeSession,
  RuntimeSessionOptions,
} from "./types.ts";
import {
  CAPABILITY_INVENTORY_SCHEMA,
  type CapabilityInventory,
  type FetchCapabilitiesOptions,
  fetchInventoryViaInvoke,
} from "./capabilities.ts";
import { validateToolFilter } from "./tool-filter.ts";
import { validateReasoningEffort } from "./reasoning-effort.ts";
import { validateMcpServers } from "./mcp-injection.ts";
import { withSyncedPWD } from "./env-cwd-sync.ts";
import { join } from "@std/path";
import { copy } from "@std/fs";

// FR-L24: see runtime/opencode-adapter.ts for the shared rationale.
let warnedToolFilter = false;

function warnToolFilterOnce(
  opts: Pick<RuntimeInvokeOptions, "allowedTools" | "disallowedTools">,
): void {
  if (warnedToolFilter) return;
  if (opts.allowedTools === undefined && opts.disallowedTools === undefined) {
    return;
  }
  warnedToolFilter = true;
  console.warn(
    "[codex] allowedTools/disallowedTools ignored — runtime does not support tool filtering (capabilities.toolFilter === false). See FR-L24.",
  );
}

/**
 * Test-only: reset the one-time warning latch.
 *
 * @internal
 */
export function _resetToolFilterWarning(): void {
  warnedToolFilter = false;
}

/**
 * Resolve the Codex user-level skills directory.
 *
 * Codex discovers user-level skills under `~/.agents/skills/<name>/SKILL.md`
 * (verified 2026-04-16; same convention as documented in flow-cli's
 * `scope.ts`). The `~/.codex/` tree is reserved for Codex's own state and
 * agent TOML sidecars.
 */
function codexSkillsDir(): string {
  return join(Deno.env.get("HOME") ?? Deno.cwd(), ".agents", "skills");
}

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
 * Capabilities (full parity with Claude / OpenCode where Codex permits):
 * - `permissionMode: true` — `default` / `plan` / `acceptEdits` /
 *   `bypassPermissions` are mapped to `--sandbox` + `approval_policy`
 *   overrides. Codex-native modes (`read-only`, `workspace-write`,
 *   `danger-full-access`, `never`, `on-request`, `on-failure`,
 *   `untrusted`) are accepted as pass-through values.
 * - `transcript: true` — Codex persists each session as
 *   `~/.codex/sessions/YYYY/MM/DD/rollout-*-<thread_id>.jsonl`; the runner
 *   resolves the path post-completion and returns it as
 *   `CliRunOutput.transcript_path`.
 * - `interactive: true` — `launchInteractive` spawns the Codex TUI with
 *   stdin/stdout/stderr inherited and copies bundled skills into
 *   `~/.agents/skills/<name>/` for the lifetime of the session.
 * - `toolUseObservation: true` — fires `onToolUseObserved` once per
 *   `item.completed` for `command_execution`, `file_change`,
 *   `mcp_tool_call`, and `web_search` items; an `"abort"` decision
 *   SIGTERMs Codex and synthesizes a `permission_denials[]` entry.
 * - `session: true` — {@link openSession} uses Codex's **experimental**
 *   `codex app-server --listen stdio://` JSON-RPC transport (NOT `codex
 *   exec`), which supports follow-up user messages mid-turn via
 *   `turn/steer`. Backed by {@link import("../codex/session.ts").openCodexSession}.
 *   The one-shot `invoke` path still uses `codex exec` and cannot accept
 *   follow-ups.
 */
export const codexRuntimeAdapter: RuntimeAdapter = {
  id: "codex",
  capabilities: {
    permissionMode: true,
    transcript: true,
    interactive: true,
    toolUseObservation: true,
    session: true,
    capabilityInventory: true,
    toolFilter: false,
    reasoningEffort: true,
    // FR-L35
    mcpInjection: true,
    sessionFidelity: "native",
  },
  invoke(opts) {
    validateToolFilter("codex", opts);
    warnToolFilterOnce(opts);
    validateReasoningEffort("codex", opts);
    // FR-L35
    validateMcpServers("codex", opts);
    return invokeCodexCli(opts);
  },
  openSession(opts: RuntimeSessionOptions): Promise<RuntimeSession> {
    validateToolFilter("codex", opts);
    warnToolFilterOnce(opts);
    validateReasoningEffort("codex", opts);
    // FR-L35
    validateMcpServers("codex", opts);
    return openCodexSession(opts);
  },

  async fetchCapabilitiesSlow(
    opts: FetchCapabilitiesOptions,
  ): Promise<CapabilityInventory> {
    const schemaPath = await Deno.makeTempFile({
      prefix: "codex-capability-schema-",
      suffix: ".json",
    });
    try {
      await Deno.writeTextFile(
        schemaPath,
        JSON.stringify(CAPABILITY_INVENTORY_SCHEMA),
      );
      return await fetchInventoryViaInvoke(
        "codex",
        (inner) => this.invoke(inner),
        opts,
        { "--output-schema": schemaPath },
      );
    } finally {
      try {
        await Deno.remove(schemaPath);
      } catch {
        // best-effort cleanup
      }
    }
  },

  async launchInteractive(
    opts: InteractiveOptions,
  ): Promise<InteractiveResult> {
    const injectedPaths: string[] = [];
    try {
      if (opts.skills && opts.skills.length > 0) {
        const skillsDir = codexSkillsDir();
        await Deno.mkdir(skillsDir, { recursive: true });
        for (const skill of opts.skills) {
          const targetDir = join(skillsDir, skill.frontmatter.name);
          await copy(skill.rootPath, targetDir, { overwrite: true });
          injectedPaths.push(targetDir);
        }
      }

      const args: string[] = [];
      if (opts.systemPrompt) {
        // Codex has no `--append-system-prompt`; the closest stable
        // mechanism is a TOML config override on `base_instructions`.
        args.push(
          "--config",
          `base_instructions=${JSON.stringify(opts.systemPrompt)}`,
        );
      }

      // FR-L33: sync env.PWD with cwd at the spawn boundary.
      const syncedEnv = withSyncedPWD(opts.env, opts.cwd);
      const cmd = new Deno.Command("codex", {
        args,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        ...(syncedEnv ? { env: syncedEnv } : {}),
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
      });

      const process = cmd.spawn();
      const status = await process.status;
      return { exitCode: status.code };
    } finally {
      for (const p of injectedPaths) {
        try {
          await Deno.remove(p, { recursive: true });
        } catch {
          // Best-effort cleanup
        }
      }
    }
  },
};
