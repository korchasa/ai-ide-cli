import type { CliRunOutput, RuntimeId } from "../types.ts";

/** Capability flags advertised by a runtime adapter. */
export interface RuntimeCapabilities {
  /** Whether the runtime supports a first-class permission mode flag. */
  permissionMode: boolean;
  /** Whether the runtime provides an external transcript file the engine can copy. */
  transcript: boolean;
  /** Whether the runtime supports interactive CLI mode (stdin-based REPL). */
  interactive: boolean;
  /**
   * Whether the runtime surfaces a per-tool-use observation hook
   * (`onToolUseObserved`). All four adapters expose it: Claude, Codex,
   * OpenCode emit tool events inline; Cursor surfaces them via separate
   * `tool_call/started` events (FR-L30).
   */
  toolUseObservation: boolean;
  /**
   * Whether the runtime supports a long-lived session with streaming user
   * input (i.e. `openSession`). Implemented by every registered adapter
   * (Claude, OpenCode, Cursor faux, Codex app-server). Callers should still
   * check the flag (and that `openSession` is defined) before invoking —
   * future adapters may opt out.
   */
  session: boolean;
  /**
   * Whether the runtime implements `RuntimeAdapter.fetchCapabilitiesSlow`
   * for enumerating skills and slash commands via an LLM prompt.
   */
  capabilityInventory: boolean;
  /**
   * Whether the adapter translates `allowedTools` / `disallowedTools` into
   * a runtime-native tool-filter flag. Adapters with `false` silently
   * accept the field, emit one `console.warn` on first use per process,
   * and otherwise ignore it. See FR-L24.
   */
  toolFilter: boolean;
  /**
   * Whether the adapter translates `reasoningEffort` into a runtime-native
   * reasoning-effort control. Adapters with `false` silently accept the
   * field, emit one `console.warn` on first use per process, and otherwise
   * ignore it. Adapters with `true` may still warn on a lossy mapping
   * (e.g. Claude has no `"minimal"` level and substitutes `"low"`).
   * See FR-L25.
   */
  reasoningEffort: boolean;
  /**
   * Whether the adapter renders `mcpServers` into a runtime-native
   * MCP-server registration mechanism for the duration of one
   * invocation. Adapters with `false` accept the typed field, validate
   * it uniformly, emit one `console.warn` on first set-value call per
   * process, and otherwise drop it on the wire. See FR-L35.
   */
  mcpInjection: boolean;
  /**
   * Backing-transport fidelity for `RuntimeAdapter.openSession`.
   *
   * - `"native"` — adapter wraps a real long-lived streaming-input
   *   transport: stdin pipe (Claude), HTTP server (OpenCode), or
   *   JSON-RPC over stdio (Codex app-server). One subprocess for the
   *   whole session.
   * - `"emulated"` — adapter fakes a session by spawning a fresh
   *   subprocess per send and queueing requests. Currently only Cursor
   *   (via `cursor agent -p --resume <chatId> <message>`). The
   *   `RuntimeSession` contract still holds, but the deviations listed
   *   under "Emulated session caveat" on `RuntimeSession` apply.
   *
   * Omitted ⇒ treat as `"native"` (preserves API stability for any
   * out-of-tree adapter that has not yet adopted the field).
   */
  sessionFidelity?: "native" | "emulated";
}

/**
 * Info passed to the runtime-neutral `onInit` lifecycle hook.
 * Each adapter translates its native init event into this minimal shape.
 */
export interface RuntimeInitInfo {
  /** Runtime that produced the init event. */
  runtime: RuntimeId;
  /** Active model identifier, if the runtime exposes one. */
  model?: string;
  /** Session/thread ID assigned by the runtime, if known at init time. */
  sessionId?: string;
}

/**
 * Runtime-neutral lifecycle hooks invoked by every adapter (with
 * best-effort translation from each runtime's native events).
 */
export interface RuntimeLifecycleHooks {
  /** Fires once at session start. */
  onInit?: (info: RuntimeInitInfo) => void;
  /** Fires exactly once after the run terminates with its final output. */
  onResult?: (output: CliRunOutput) => void;
}
