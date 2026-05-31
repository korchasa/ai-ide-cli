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

/** Pick the ACP `modeId` for a runtime-neutral `permissionMode`. */
export function pickModeForPermissionMode(
  runtime: RuntimeId,
  declared: AcpModeDecl[] | undefined,
  permissionMode: string | undefined,
): string | undefined {
  if (!permissionMode || !declared || declared.length === 0) return undefined;
  const map = runtime === "claude" ? CLAUDE_PERMISSION_TO_MODE : undefined;
  // First try a per-runtime mapping table.
  const mapped = map?.[permissionMode];
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
