/**
 * @module
 * Pure mappers between `RuntimeInvokeOptions` / `RuntimeSessionOptions`
 * and the on-the-wire shapes used by the Agent Client Protocol:
 *
 * - `buildInitializeParams` — `initialize` request payload.
 * - `buildSessionNewParams` — `session/new` request payload.
 * - `pickModeForPermissionMode` — `session/set_mode` selection over the
 *   front's declared `modes`.
 * - `pickConfigForReasoningEffort` / `pickConfigForModel` —
 *   `session/set_config_option` selection over the front's declared
 *   `sessionConfigOptions`.
 * - `mapSessionUpdate` — translates one inbound `session/update`
 *   notification into the runtime-neutral
 *   {@link RuntimeSessionEvent}, projecting text deltas, tool calls,
 *   plan updates, and mode / config-option updates.
 *
 * Lossy mappings (`allowedTools`, `disallowedTools`, `systemPrompt`,
 * `settingSources`) are documented per option and surfaced to the
 * adapter as a structured `degradedOptions` array — adapters route the
 * warning through `OnCallbackError` so consumers can monitor PoC
 * coverage gaps without grepping logs.
 */

import type { RuntimeId } from "../../types.ts";
import type { RuntimeInvokeOptions, RuntimeSessionOptions } from "../types.ts";
import type { McpServers } from "../mcp-injection.ts";
import { validateMcpServers } from "../mcp-injection.ts";
import { validateReasoningEffort } from "../reasoning-effort.ts";
import {
  decidePermissionMode,
  type SandboxMode,
} from "../../codex/permission-mode.ts";
import {
  type RuntimeSessionEvent,
  SYNTHETIC_TURN_END,
} from "../session-types.ts";

/** ACP `initialize` request params (subset we emit). */
export interface AcpInitializeParams {
  /** Protocol version (`1` at the time of this PoC). */
  protocolVersion: 1;
  /** Capability flags the client supports. */
  clientCapabilities: {
    fs: { readTextFile: boolean; writeTextFile: boolean };
    terminal: boolean;
  };
  /** Identifying metadata. */
  clientInfo: { name: string; version: string };
}

/**
 * Subset of the ACP `initialize` response the handshake reads.
 *
 * `agentCapabilities.loadSession` is the capability gate for FR-L19
 * resume — a front that advertises `true` accepts `session/load`; absent
 * or non-`true` is treated as unsupported (fail-closed).
 */
// FR-L19
export interface AcpInitializeResult {
  /** Capabilities the front advertises. */
  agentCapabilities?: {
    /** Whether the front implements `session/load` (resume). */
    loadSession?: boolean;
  };
}

/** ACP MCP-server descriptor (`session/new.params.mcpServers[]`). */
export interface AcpMcpServer {
  /** Server name referenced as `<name>.<tool>` in tool calls. */
  name: string;
  /** Transport tag (only stdio fronts are universally supported). */
  type: "stdio" | "http";
  /** Stdio: executable. HTTP: ignored (use `url`). */
  command?: string;
  /** Stdio: argv. */
  args?: string[];
  /**
   * Env vars as ACP expresses them — an array of `{ name, value }` pairs
   * (object form is not portable across fronts).
   */
  env?: Array<{ name: string; value: string }>;
  /** HTTP: endpoint URL. */
  url?: string;
  /** HTTP: headers. */
  headers?: Array<{ name: string; value: string }>;
}

/** ACP `session/new` request params. */
export interface AcpSessionNewParams {
  /** Absolute cwd (ACP requires absolute paths). */
  cwd: string;
  /** MCP servers to register for the session. */
  mcpServers: AcpMcpServer[];
}

/** Declared mode entry returned in `session/new` response. */
export interface AcpModeDecl {
  /** Stable id used in `session/set_mode`. */
  id: string;
  /** Display name for UIs. */
  name?: string;
}

/**
 * Declared config-option entry returned in `session/new` response.
 *
 * Two wire shapes exist for the allowed-value list and we accept
 * either. A well-behaved front populates exactly one of `values` /
 * `options`; if both arrive we currently ignore the duplicate without
 * complaining (the adapter passes the verbatim user-supplied value
 * through anyway — the declared set is informational).
 */
export interface AcpConfigOptionDecl {
  /** Stable id used in `session/set_config_option`. */
  id: string;
  /** Logical category — `"model"`, `"thought_level"`, … */
  category: string;
  /** Allowed value list — claude / codex shape (`values[].id`). */
  values?: Array<{ id: string }>;
  /** Allowed value list — opencode shape (`options[].value`). */
  options?: Array<{ value: string }>;
}

/**
 * Per-option degradation diagnostic emitted when an option in the neutral
 * surface has no ACP equivalent. Adapter forwards each entry through
 * `OnCallbackError` (source `"acp"`) so it shows up alongside other
 * routed warnings.
 */
export interface AcpDegradedOption {
  /** Field name on `RuntimeInvokeOptions` / `RuntimeSessionOptions`. */
  field: string;
  /** Brief explanation. */
  reason: string;
}

/** Library name / version embedded in the `initialize` `clientInfo` block. */
export const ACP_CLIENT_NAME = "ai-ide-cli";

/**
 * Pinned at the PoC's snapshot. Independent from the package's JSR
 * version because the wire identity is informational only.
 */
export const ACP_CLIENT_VERSION = "0.0.1-poc";

/** Build the `initialize` request payload. */
export function buildInitializeParams(): AcpInitializeParams {
  return {
    protocolVersion: 1,
    clientCapabilities: {
      // FR-L39: deliberately decline filesystem access — ADR-0002 keeps
      // HITL / FS bridges out of scope. Documented degradation: agents
      // that depend on `fs/*` may surface reduced features.
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: {
      name: ACP_CLIENT_NAME,
      version: ACP_CLIENT_VERSION,
    },
  };
}

/**
 * Build the `session/new` request payload, translating typed
 * {@link McpServers} into the ACP-expected array shape.
 *
 * @param runtime Runtime id (used in {@link validateMcpServers} errors).
 * @param opts Options carrying `cwd` and `mcpServers`.
 */
export function buildSessionNewParams(
  runtime: RuntimeId,
  opts: Pick<
    RuntimeInvokeOptions | RuntimeSessionOptions,
    "cwd" | "mcpServers" | "extraArgs" | "env"
  >,
): AcpSessionNewParams {
  validateMcpServers(runtime, {
    mcpServers: opts.mcpServers,
    extraArgs: opts.extraArgs,
    env: opts.env,
  });
  return {
    cwd: opts.cwd ?? Deno.cwd(),
    mcpServers: renderMcpServers(opts.mcpServers),
  };
}

function renderMcpServers(servers: McpServers | undefined): AcpMcpServer[] {
  if (!servers) return [];
  const out: AcpMcpServer[] = [];
  for (const [name, spec] of Object.entries(servers)) {
    if (spec.type === "stdio") {
      out.push({
        name,
        type: "stdio",
        command: spec.command,
        args: spec.args ? [...spec.args] : [],
        env: spec.env
          ? Object.entries(spec.env).map(([k, v]) => ({ name: k, value: v }))
          : [],
      });
    } else {
      out.push({
        name,
        type: "http",
        url: spec.url,
        headers: spec.headers
          ? Object.entries(spec.headers).map(([k, v]) => ({
            name: k,
            value: v,
          }))
          : [],
      });
    }
  }
  return out;
}

/**
 * Static permission-mode → ACP-mode-id map per pilot front. Returns the
 * declared mode that best matches the caller's request; falls back to
 * `undefined` when there is no match (the adapter then skips
 * `session/set_mode`).
 */
const CLAUDE_PERMISSION_TO_MODE: Record<string, string> = {
  plan: "plan",
  acceptEdits: "code",
  bypassPermissions: "yolo",
  default: "code",
};

/**
 * FR-L44: Codex sandbox decision → `@agentclientprotocol/codex-acp` preset
 * id. The front declares exactly three presets — `read-only`, `agent`,
 * `agent-full-access` — whose `sandboxMode` fields are the three Codex
 * sandbox literals (verified against 1.1.7 and 1.7.0 `src/AgentMode.ts`).
 * Keying off {@link decidePermissionMode} keeps ACP on the same single
 * source of truth as both CLI transports instead of a parallel table.
 *
 * Lossy on approval policy: the presets bind their own `approvalPolicy`
 * (`on-request` for `read-only` / `agent`, `never` for
 * `agent-full-access`), so a neutral mode whose decision asks for a
 * different policy — `plan` and `acceptEdits` both decide `never` — gets
 * the sandbox it asked for and the preset's policy. ACP exposes no way to
 * set the two independently.
 */
const CODEX_SANDBOX_TO_MODE: Record<SandboxMode, string> = {
  "read-only": "read-only",
  "workspace-write": "agent",
  "danger-full-access": "agent-full-access",
};

/** Pick the ACP `modeId` for a runtime-neutral `permissionMode`. */
export function pickModeForPermissionMode(
  runtime: RuntimeId,
  declared: AcpModeDecl[] | undefined,
  permissionMode: string | undefined,
): string | undefined {
  if (!permissionMode || !declared || declared.length === 0) return undefined;
  // First try a per-runtime mapping.
  let mapped: string | undefined;
  if (runtime === "claude") {
    mapped = CLAUDE_PERMISSION_TO_MODE[permissionMode];
  } else if (runtime === "codex") {
    const { sandbox } = decidePermissionMode(permissionMode);
    mapped = sandbox ? CODEX_SANDBOX_TO_MODE[sandbox] : undefined;
  }
  if (mapped && declared.some((m) => m.id === mapped)) return mapped;
  // Fall back to direct id match — keep ACP-native ids passing through.
  if (declared.some((m) => m.id === permissionMode)) return permissionMode;
  return undefined;
}

/**
 * Pick a `{configId, value}` pair from the declared `sessionConfigOptions`
 * for the abstract `reasoningEffort` enum. Returns `undefined` when the
 * front did not declare a matching category.
 */
export function pickConfigForReasoningEffort(
  runtime: RuntimeId,
  declared: AcpConfigOptionDecl[] | undefined,
  opts: Pick<RuntimeInvokeOptions, "reasoningEffort" | "extraArgs">,
): { configId: string; value: string } | undefined {
  const effort = validateReasoningEffort(runtime, opts);
  if (!effort || !declared) return undefined;
  const decl = declared.find((d) => d.category === "thought_level");
  if (!decl) return undefined;
  // Pass the verbatim level; the front validates against its own set.
  return { configId: decl.id, value: effort };
}

/** Pick a `{configId, value}` pair for the typed `model` selector. */
export function pickConfigForModel(
  declared: AcpConfigOptionDecl[] | undefined,
  model: string | undefined,
): { configId: string; value: string } | undefined {
  if (!model || !declared) return undefined;
  const decl = declared.find((d) => d.category === "model");
  if (!decl) return undefined;
  // Pass the verbatim model id whether or not it is in the front's
  // declared set — the front is the authoritative validator.
  return { configId: decl.id, value: model };
}

/** Inspect options for features ACP cannot losslessly carry. */
export function collectDegradedOptions(
  opts: Pick<
    RuntimeInvokeOptions,
    "allowedTools" | "disallowedTools" | "settingSources" | "systemPrompt"
  >,
): AcpDegradedOption[] {
  const out: AcpDegradedOption[] = [];
  if (opts.allowedTools && opts.allowedTools.length > 0) {
    out.push({
      field: "allowedTools",
      reason:
        "ACP has no standard tool allow-list; the front controls tool exposure on its own.",
    });
  }
  if (opts.disallowedTools && opts.disallowedTools.length > 0) {
    out.push({
      field: "disallowedTools",
      reason:
        "ACP has no standard tool deny-list; the front controls tool exposure on its own.",
    });
  }
  if (opts.settingSources && opts.settingSources.length > 0) {
    out.push({
      field: "settingSources",
      reason:
        "ACP fronts read their own config sources; no client-side cleanroom equivalent.",
    });
  }
  if (opts.systemPrompt && opts.systemPrompt.trim().length > 0) {
    out.push({
      field: "systemPrompt",
      reason:
        "ACP has no `system` content; prepended to the user prompt as a fallback.",
    });
  }
  return out;
}

/**
 * Invoke-only options the ACP wire cannot carry. Adapter throws
 * `AcpUnsupportedOptionError` when any is set. Distinct from
 * {@link collectDegradedOptions} (warn-only, lossy-but-handled).
 *
 * Field notes:
 * - `agent` is a runtime-internal subagent selector (Claude / OpenCode
 *   `--agent`). ACP fronts launch their own process and accept no
 *   sub-agent override on the wire.
 * - `resumeSessionId` is NOT here (FR-L19): its support is
 *   runtime-advertised (`agentCapabilities.loadSession`), known only
 *   after `initialize`. It is gated post-init inside
 *   `runtime/acp/handshake.ts` — routed to `session/load` when the front
 *   advertises the capability, else throwing the SAME
 *   `AcpUnsupportedOptionError` (later in the lifecycle, after spawn).
 * - `extraArgs` has no destination on the wire (ACP carries no CLI argv).
 *
 * Set membership — not heuristics — is the source of truth. Adding a new
 * field to `RuntimeInvokeOptions` does NOT silently bypass the check, but
 * a missing entry here would: each new field needs an explicit
 * classify-and-mention decision (degraded vs unsupported vs honoured vs
 * capability-gated).
 */
// FR-L39
export const ACP_UNSUPPORTED_INVOKE_OPTIONS = [
  "agent",
  "systemPromptFile",
  "extraArgs",
  "strictMcpConfig",
  "streamStallTimeoutSeconds",
  "streamLogPath",
  "verbosity",
  "onOutput",
] as const;

/**
 * Session-options counterpart. Strict subset of the invoke list —
 * `RuntimeSessionOptions` omits the one-shot fields (`streamLogPath`,
 * `verbosity`, `onOutput`, `streamStallTimeoutSeconds`,
 * `systemPromptFile`). `resumeSessionId` is capability-gated post-init
 * (FR-L19), not listed here.
 */
// FR-L39
export const ACP_UNSUPPORTED_SESSION_OPTIONS = [
  "agent",
  "extraArgs",
  "strictMcpConfig",
] as const;

/**
 * Pure: return the names of fields that are set on `opts` and listed in
 * the relevant pinned tuple. Presence-based — anything other than
 * `undefined` / `null` counts as set (empty array / empty string / `0` /
 * `false` all encode caller intent). The sole exception is `extraArgs`:
 * a map with zero entries does NOT count, because the engine cascade
 * resolves an unset `extraArgs` to `{}`. Never throws.
 *
 * @param kind Whether to validate against the invoke or session tuple.
 * @param opts Option bag read by field name.
 */
// FR-L39
export function collectUnsupportedOptions(
  kind: "invoke" | "session",
  opts: Record<string, unknown>,
): string[] {
  const set = kind === "invoke"
    ? ACP_UNSUPPORTED_INVOKE_OPTIONS
    : ACP_UNSUPPORTED_SESSION_OPTIONS;
  const out: string[] = [];
  for (const field of set) {
    const value = opts[field];
    if (value === undefined || value === null) continue;
    if (
      field === "extraArgs" &&
      typeof value === "object" &&
      Object.keys(value as Record<string, unknown>).length === 0
    ) {
      continue;
    }
    out.push(field);
  }
  return out;
}

/**
 * Map one inbound `session/update` notification (or higher-level method)
 * into the runtime-neutral event envelope. Unknown methods pass through
 * untouched so consumers see them under `raw`.
 *
 * The PoC keeps the projection deliberately minimal: every notification
 * surfaces as one `RuntimeSessionEvent`, with the original method stored
 * under `type`. Higher-level normalization (e.g. assembling text
 * chunks) lives in `runtime/content.ts` — which dispatches by runtime,
 * not by transport. Because the dispatcher currently has no ACP arm,
 * `extractSessionContent` returns `[]` for these events; that gap is
 * documented in the PoC results, not silently swallowed.
 */
export function mapSessionUpdate(
  runtime: RuntimeId,
  method: string,
  params: Record<string, unknown> | undefined,
): RuntimeSessionEvent {
  return {
    runtime,
    type: method,
    raw: params ?? {},
  };
}

/**
 * Build a synthetic turn-end event from the terminal
 * `PromptResponse.stopReason`. Mirrors the cross-runtime
 * {@link SYNTHETIC_TURN_END} contract emitted by every native adapter.
 */
export function buildTurnEndEvent(
  runtime: RuntimeId,
  stopReason: string,
): RuntimeSessionEvent {
  return {
    runtime,
    type: SYNTHETIC_TURN_END,
    raw: { stopReason },
    synthetic: true,
  };
}
