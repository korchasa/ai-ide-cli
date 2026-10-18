import { invokeCodexCli } from "../codex/process.ts";
import {
  rejectProcessGroupOnWindows,
  rejectUnsupportedRunOptions,
} from "./run-options.ts";
import { openCodexSession } from "../codex/session.ts";
import { invokeViaAcp, openSessionViaAcp } from "./acp/adapter.ts";
import { fetchAcpCommands } from "./acp/commands.ts";
import {
  type CommandsSnapshot,
  CommandsUnavailableError,
  type FetchCommandsOptions,
} from "./commands.ts";
import type {
  RuntimeAdapter,
  RuntimeInvokeOptions,
  RuntimeSession,
  RuntimeSessionOptions,
  TransportOption,
} from "./types.ts";
import type { RuntimeCapabilities } from "./capability-types.ts";
import {
  CAPABILITY_INVENTORY_SCHEMA,
  type CapabilityInventory,
  type FetchCapabilitiesOptions,
  fetchInventoryViaInvoke,
} from "./capabilities.ts";
import { validateToolFilter } from "./tool-filter.ts";
import { validateReasoningEffort } from "./reasoning-effort.ts";
import { validateMcpServers } from "./mcp-injection.ts";
import { rejectUnsupportedSystemPromptFile } from "./system-prompt-file.ts";
import { codexAuthEnv } from "../codex/auth-env.ts";

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
// FR-L39: transport-scoped capability vector for the Codex ACP front
// (`@agentclientprotocol/codex-acp`, FR-L43). Same downgrade rationale as the
// Claude pilot — transcript / toolFilter are unavailable
// on the ACP path while session, reasoning-effort, MCP injection, and
// tool-use observation round-trip natively. `capabilityInventory` is
// `true` (FR-L20) — `fetchCapabilitiesSlow` routes through
// `invokeViaAcp`. The toolFilter dimension was already `false` on
// Codex's CLI baseline; carrying it forward unchanged keeps the
// vector explicit.
const CODEX_ACP_CAPABILITIES: RuntimeCapabilities = {
  permissionMode: true,
  transcript: false,
  toolUseObservation: true,
  session: true,
  // FR-L20: fetchCapabilitiesSlow routes through invokeViaAcp on ACP.
  capabilityInventory: true,
  toolFilter: false,
  reasoningEffort: true,
  mcpInjection: true,
  // FR-L42: ACP front pushes `available_commands_update`.
  commandsFastChannel: true,
  sessionFidelity: "native",
};

export const codexRuntimeAdapter: RuntimeAdapter = {
  id: "codex",
  capabilities: {
    permissionMode: true,
    transcript: true,
    toolUseObservation: true,
    session: true,
    capabilityInventory: true,
    toolFilter: false,
    reasoningEffort: true,
    // FR-L35
    mcpInjection: true,
    // FR-L42: no CLI fast-channel.
    commandsFastChannel: false,
    sessionFidelity: "native",
  },
  capabilitiesFor(transport: TransportOption): RuntimeCapabilities {
    if (transport === "acp") return CODEX_ACP_CAPABILITIES;
    return this.capabilities;
  },
  invoke(opts) {
    // FR-L51: Deno cannot signal a process group on Windows.
    rejectProcessGroupOnWindows("codex", opts);
    // FR-L39
    if (opts.transport === "acp") {
      return invokeViaAcp("codex", opts, codexAuthEnv);
    }
    rejectUnsupportedSystemPromptFile("codex", opts);
    // FR-L28: `settingSources` names Claude config sources; Codex config
    // layers do not map onto them.
    rejectUnsupportedRunOptions("codex", opts, ["settingSources"]);
    validateToolFilter("codex", opts);
    warnToolFilterOnce(opts);
    validateReasoningEffort("codex", opts);
    // FR-L35
    validateMcpServers("codex", opts);
    return invokeCodexCli(opts);
  },
  openSession(opts: RuntimeSessionOptions): Promise<RuntimeSession> {
    // FR-L51: Deno cannot signal a process group on Windows.
    rejectProcessGroupOnWindows("codex", opts);
    if (opts.transport === "acp") {
      return openSessionViaAcp("codex", opts, codexAuthEnv);
    }
    // FR-L28
    rejectUnsupportedRunOptions("codex", opts, ["settingSources"]);
    validateToolFilter("codex", opts);
    warnToolFilterOnce(opts);
    validateReasoningEffort("codex", opts);
    // FR-L35
    validateMcpServers("codex", opts);
    return openCodexSession(opts);
  },

  fetchCapabilitiesSlow(
    opts: FetchCapabilitiesOptions,
  ): Promise<CapabilityInventory> {
    // FR-L50: the runner writes the schema file and removes it.
    return fetchInventoryViaInvoke(
      "codex",
      (inner) => this.invoke(inner),
      opts,
      undefined,
      CAPABILITY_INVENTORY_SCHEMA,
    );
  },

  // FR-L42: zero-LLM-cost commands fast-channel via the ACP front.
  fetchCommands(opts: FetchCommandsOptions): Promise<CommandsSnapshot> {
    if (opts.transport === "acp") {
      return fetchAcpCommands("codex", opts, codexAuthEnv);
    }
    return Promise.reject(
      new CommandsUnavailableError("codex", opts.transport, "no_fast_channel"),
    );
  },
};
