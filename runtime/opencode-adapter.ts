import { invokeOpenCodeCli } from "../opencode/process.ts";
import {
  type OpenCodeSessionEvent,
  openOpenCodeSession,
} from "../opencode/session.ts";
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
  RuntimeSessionEvent,
  RuntimeSessionOptions,
  TransportOption,
} from "./types.ts";
import type { RuntimeCapabilities } from "./capability-types.ts";
import { adaptEventCallback, adaptRuntimeSession } from "./session-adapter.ts";
import {
  type CapabilityInventory,
  type FetchCapabilitiesOptions,
  fetchInventoryViaInvoke,
} from "./capabilities.ts";
import { validateToolFilter } from "./tool-filter.ts";
import { validateReasoningEffort } from "./reasoning-effort.ts";
import { validateMcpServers } from "./mcp-injection.ts";
import { rejectUnsupportedSystemPromptFile } from "./system-prompt-file.ts";
import {
  rejectProcessGroupOnWindows,
  rejectUnsupportedRunOptions,
} from "./run-options.ts";
import { opencodeAuthEnv } from "../opencode/auth-env.ts";

// FR-L24: OpenCode has no native tool-filter CLI flag. The validator
// still runs (uniform malformed-input rejection across runtimes); the
// warn-once latch fires `console.warn` on the first valid set-value
// call per process. Shared across `invoke` and `openSession`.
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
    "[opencode] allowedTools/disallowedTools ignored — runtime does not support tool filtering (capabilities.toolFilter === false). See FR-L24.",
  );
}

/**
 * Test-only: reset the one-time warning latch so individual tests can
 * assert the warning fires again.
 *
 * @internal
 */
export function _resetToolFilterWarning(): void {
  warnedToolFilter = false;
}

// FR-L25: OpenCode maps `reasoningEffort` → `--variant` / `body.variant`,
// but the value is provider-specific — a given provider may or may not
// support the requested depth. Warn once per process on first use so
// consumers know the translation is approximate.
let warnedReasoningEffort = false;

function warnReasoningEffortOnce(value: unknown): void {
  if (warnedReasoningEffort) return;
  if (value === undefined) return;
  warnedReasoningEffort = true;
  console.warn(
    "[opencode] reasoningEffort forwarded as provider-specific --variant / body.variant — interpretation depends on the active model provider. See FR-L25.",
  );
}

/**
 * Test-only: reset the one-time reasoning-effort warning latch.
 *
 * @internal
 */
export function _resetReasoningEffortWarning(): void {
  warnedReasoningEffort = false;
}

function opencodeEventToRuntime(
  event: OpenCodeSessionEvent,
): RuntimeSessionEvent {
  const neutral: RuntimeSessionEvent = {
    runtime: "opencode",
    type: event.type,
    raw: event.raw,
  };
  // The OpenCode dispatcher inserts an edge-triggered synthetic turn-end
  // marker into the native queue (see `opencode/session.ts`). Forward the
  // `synthetic` flag so consumers observe one and only one turn-end per
  // assistant turn — even if the server emits both `session.idle` and
  // `session.status { status: idle }` for the same idle transition.
  if (event.synthetic) neutral.synthetic = true;
  return neutral;
}

// FR-L39: transport-scoped capability vector for the OpenCode ACP
// front (`opencode acp`). Mirrors the cross-pilot downgrade rule:
// transcript / toolFilter drop to `false` because neither
// survive the ACP wire dialect; `capabilityInventory` is `true`
// (FR-L20) — `fetchCapabilitiesSlow` routes through `invokeViaAcp`. The
// remaining surfaces (permissionMode, toolUseObservation, session,
// reasoningEffort, mcpInjection) round-trip natively.
const OPENCODE_ACP_CAPABILITIES: RuntimeCapabilities = {
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

export const opencodeRuntimeAdapter: RuntimeAdapter = {
  id: "opencode",
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
    if (transport === "acp") return OPENCODE_ACP_CAPABILITIES;
    return this.capabilities;
  },
  invoke(opts) {
    // FR-L51: Deno cannot signal a process group on Windows.
    rejectProcessGroupOnWindows("opencode", opts);
    // FR-L39: opt-in ACP transport. Default `transport === "cli"` keeps
    // the CLI path unchanged.
    if (opts.transport === "acp") {
      return invokeViaAcp("opencode", opts, opencodeAuthEnv);
    }
    rejectUnsupportedSystemPromptFile("opencode", opts);
    // FR-L50 / FR-L52: no schema flag, no way to skip session files.
    // FR-L28: `settingSources` names Claude config sources only.
    rejectUnsupportedRunOptions("opencode", opts, [
      "outputSchema",
      "ephemeral",
      "settingSources",
    ]);
    validateToolFilter("opencode", opts);
    warnToolFilterOnce(opts);
    validateReasoningEffort("opencode", opts);
    warnReasoningEffortOnce(opts.reasoningEffort);
    // FR-L35: validate at the adapter boundary too — keeps malformed
    // input throwing uniformly even if a refactor moves env injection
    // out of `invokeOpenCodeCli`.
    validateMcpServers("opencode", opts);
    return invokeOpenCodeCli(opts);
  },

  fetchCapabilitiesSlow(
    opts: FetchCapabilitiesOptions,
  ): Promise<CapabilityInventory> {
    return fetchInventoryViaInvoke(
      "opencode",
      (inner) => this.invoke(inner),
      opts,
    );
  },

  // FR-L42: zero-LLM-cost commands fast-channel via the ACP front.
  fetchCommands(opts: FetchCommandsOptions): Promise<CommandsSnapshot> {
    if (opts.transport === "acp") {
      return fetchAcpCommands("opencode", opts, opencodeAuthEnv);
    }
    return Promise.reject(
      new CommandsUnavailableError(
        "opencode",
        opts.transport,
        "no_fast_channel",
      ),
    );
  },

  async openSession(opts: RuntimeSessionOptions): Promise<RuntimeSession> {
    // FR-L51: Deno cannot signal a process group on Windows.
    rejectProcessGroupOnWindows("opencode", opts);
    if (opts.transport === "acp") {
      return openSessionViaAcp("opencode", opts, opencodeAuthEnv);
    }
    // FR-L50 / FR-L52
    // FR-L28
    rejectUnsupportedRunOptions("opencode", opts, [
      "outputSchema",
      "ephemeral",
      "settingSources",
    ]);
    validateToolFilter("opencode", opts);
    warnToolFilterOnce(opts);
    validateReasoningEffort("opencode", opts);
    warnReasoningEffortOnce(opts.reasoningEffort);
    // FR-L35
    validateMcpServers("opencode", opts);
    const inner = await openOpenCodeSession({
      agent: opts.agent,
      systemPrompt: opts.systemPrompt,
      model: opts.model,
      resumeSessionId: opts.resumeSessionId,
      reasoningEffort: opts.reasoningEffort,
      // FR-L35
      mcpServers: opts.mcpServers,
      cwd: opts.cwd,
      env: opts.env,
      inheritEnv: opts.inheritEnv,
      signal: opts.signal,
      onEvent: adaptEventCallback(opts.onEvent, opencodeEventToRuntime),
      onStderr: opts.onStderr,
      onCallbackError: opts.onCallbackError,
      // FR-L51
      processGroup: opts.processGroup,
      processRegistry: opts.processRegistry,
    });
    return adaptRuntimeSession("opencode", inner, opencodeEventToRuntime);
  },
};
