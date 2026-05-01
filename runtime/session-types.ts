import type { RuntimeId } from "../types.ts";
import type { ProcessRegistry } from "../process-registry.ts";
import type { OnCallbackError } from "./callback-safety.ts";
import type { SettingSource } from "./setting-sources.ts";
import type { ReasoningEffort } from "./reasoning-effort.ts";
import type { ExtraArgsMap } from "./adapter-types.ts";

/**
 * Options for opening a runtime-neutral streaming session via
 * `RuntimeAdapter.openSession`. Mirrors `RuntimeInvokeOptions` but omits
 * one-shot fields (`taskPrompt`, retries, timeouts, hooks) that do not
 * apply to a long-lived session. Adapters that do not recognize a field
 * ignore it (e.g. non-Claude runtimes ignore `settingSources`).
 *
 * **Out of scope (by design):**
 *
 * - **Per-turn timeouts and retries.** A streaming session is a caller-owned
 *   stream. Unlike `RuntimeInvokeOptions` — which wraps a one-shot CLI call
 *   with `timeoutSeconds` / `maxRetries` / `retryDelaySeconds` — a session
 *   has no "turn" that the library can meaningfully time out and restart in
 *   place. If a turn hangs, the caller should cancel via
 *   `RuntimeSessionOptions.signal` (AbortSignal) and reopen the session
 *   with the captured `RuntimeSession.sessionId` as
 *   `RuntimeSessionOptions.resumeSessionId`.
 * - **Mid-session model / permission-mode / extraArgs changes.** Those flags
 *   are bound to the underlying subprocess at spawn time. Changing them
 *   requires reopening the session: close the current handle (`abort()` or
 *   `endInput()` + `await done`), then call `openSession` again, passing
 *   the previous session's `sessionId` as `resumeSessionId` to preserve the
 *   conversation history.
 */
export interface RuntimeSessionOptions {
  /**
   * Process tracker scope — see `RuntimeInvokeOptions.processRegistry` for
   * the standalone-vs-embedded contract. Required.
   */
  processRegistry: ProcessRegistry;
  /** Optional runtime-native agent selector. */
  agent?: string;
  /** Optional system prompt content for the session. */
  systemPrompt?: string;
  /** Existing session ID to resume. */
  resumeSessionId?: string;
  /**
   * Additional CLI flags forwarded to the runtime. Each runtime reserves its
   * own transport flags; passing a reserved key throws synchronously. See
   * `ExtraArgsMap` for value semantics.
   */
  extraArgs?: ExtraArgsMap;
  /** Runtime-specific permission mode. */
  permissionMode?: string;
  /** Model identifier understood by the selected runtime. */
  model?: string;
  /**
   * External cancellation signal. On abort, the subprocess receives SIGTERM
   * and the session's `done` promise resolves.
   */
  signal?: AbortSignal;
  /** Working directory for the runtime subprocess. */
  cwd?: string;
  /** Extra environment variables merged into the subprocess env. */
  env?: Record<string, string>;
  /** Claude-specific configuration-source filter. Ignored by other runtimes. */
  settingSources?: SettingSource[];
  /**
   * Tool-name allow-list. Same contract as
   * `RuntimeInvokeOptions.allowedTools` — see that field's JSDoc.
   */
  allowedTools?: string[];
  /**
   * Tool-name deny-list. Same contract as
   * `RuntimeInvokeOptions.disallowedTools` — see that field's JSDoc.
   */
  disallowedTools?: string[];
  /**
   * Abstract reasoning-effort depth. Same contract as
   * `RuntimeInvokeOptions.reasoningEffort` — see that field's JSDoc.
   */
  reasoningEffort?: ReasoningEffort;
  /** Fires for every parsed event from the runtime's event stream, in order. */
  onEvent?: (event: RuntimeSessionEvent) => void;
  /** Fires for every decoded stderr chunk (may be empty on a flush). */
  onStderr?: (line: string) => void;
  /**
   * Routed error sink for `onEvent` / `onStderr` (and any future
   * notification hook). Default handler logs the throw to `console.warn`
   * — supply a no-op to opt out. The streaming loop stays alive
   * regardless. See FR-L32.
   */
  onCallbackError?: OnCallbackError;
}

/**
 * Runtime-neutral session event. The `type` and `raw` fields preserve the
 * runtime's native event shape verbatim; consumers that need typed access to
 * runtime-specific payloads should cast `raw` or use the runtime's own
 * helper (e.g. `openClaudeSession`).
 *
 * **Synthetic events.** Some events are injected by the adapter rather than
 * parsed from the runtime's stream — they carry `synthetic: true` and exist
 * to give consumers one cross-runtime handle to hook into. Synthetic events
 * are always emitted **after** the native event they summarize (the native
 * event still passes through untouched). Shipped synthetics:
 *
 * - `SYNTHETIC_TURN_END` (`type: "turn-end"`) — emitted by every adapter
 *   once per completed turn, right after the runtime signals readiness for
 *   the next input. `raw` carries the runtime's native turn-terminator
 *   payload (Claude: `result`; OpenCode: `session.idle`; Cursor: the
 *   subprocess's `result`; Codex: the `turn/completed` JSON-RPC
 *   notification). Callers who need richer per-runtime detail
 *   (success/error subtype, cost, etc.) read it out of `raw`.
 * - Cursor additionally pushes a synthetic `{type:"system", subtype:"init"}`
 *   at session open (Cursor has no native init event) and
 *   `{type:"error", subtype:"send_failed"}` when a per-turn subprocess
 *   exits non-zero. See `cursor/session.ts`.
 *
 * Consumers that want to observe turn boundaries should match on the
 * synthetic event, not on runtime-native discriminators.
 */
export interface RuntimeSessionEvent {
  /** Runtime that produced the event. */
  runtime: RuntimeId;
  /** Event discriminator from the raw payload (`"system"`, `"assistant"`, `"result"`, …). */
  type: string;
  /** Raw event object as parsed from the runtime's event stream. */
  raw: Record<string, unknown>;
  /**
   * `true` when the adapter injected this event rather than receiving it
   * from the runtime's native stream. Absent (not `false`) for native
   * events — do not rely on the falsy path.
   */
  synthetic?: true;
}

/**
 * Neutral event type emitted by every adapter when the runtime signals the
 * end of an assistant turn (i.e. readiness to accept the next user input).
 *
 * Per-runtime source signal preserved in `RuntimeSessionEvent.raw`:
 *
 * - Claude: the native `result` stream event.
 * - OpenCode: the native `session.idle` event.
 * - Cursor: the per-turn subprocess's native `result` stream event.
 * - Codex: the `turn/completed` JSON-RPC notification
 *   (`raw.method === "turn/completed"`, params under `raw.params`).
 *
 * **Honesty note.** This event marks "runtime is ready for next input".
 * It is *not* a success/error verdict — OpenCode's `session.idle` fires
 * whether the turn finished cleanly or errored mid-stream, and detecting
 * failure across runtimes still requires inspecting prior events (or
 * `raw` on Claude/Cursor/Codex where a terminator subtype exists).
 */
export const SYNTHETIC_TURN_END = "turn-end" as const;

/** Terminal state of a runtime session subprocess. */
export interface RuntimeSessionStatus {
  /** OS exit code when exited normally, `null` when killed by signal. */
  exitCode: number | null;
  /** Termination signal name when killed by signal, `null` otherwise. */
  signal: string | null;
  /** Aggregated stderr text captured during the session. */
  stderr: string;
}

/**
 * Live handle for a runtime subprocess in streaming-input mode.
 *
 * Lifecycle: open → zero or more `send` / `events` iterations → `endInput`
 * (graceful) or `abort` (SIGTERM) → `done` resolves. Adapters translate the
 * runtime's native event stream into `RuntimeSessionEvent` while preserving
 * the raw payload for consumers that need it.
 *
 * Contract (uniform across all adapters):
 *
 * - `send(content)` resolves once the runtime has **accepted** the input.
 *   It does NOT wait for the runtime to finish processing the turn.
 *   Transport/runtime errors surfaced during turn processing arrive via
 *   `events` and `done`, not via the `send` promise. `send` rejects with a
 *   `SessionError` subclass:
 *
 *   - `SessionInputClosedError` when input was closed via `endInput`;
 *   - `SessionAbortedError` when the session has been aborted;
 *   - `SessionDeliveryError` when the adapter failed to deliver the
 *     message to the runtime's transport (HTTP non-2xx for OpenCode,
 *     broken stdin pipe for Claude, JSON-RPC error for Codex, etc.).
 *
 *   Consumers should `catch (err)` and branch on `err instanceof …` to
 *   distinguish "reopen needed" (input-closed / aborted) from "transport
 *   error, investigate" (delivery). Matching by message prefix is
 *   discouraged — message wording is not part of the contract.
 * - `endInput()` signals "no more sends will come" and initiates graceful
 *   shutdown of the input channel. It returns promptly. Full-shutdown
 *   observation is `await session.done`.
 * - `abort(reason?)` is a best-effort forceful stop (SIGTERM or
 *   transport-specific equivalent). Idempotent.
 * - `events` is a single-consumer async iterable; re-iteration throws.
 *   Completes when the underlying transport terminates. Emits one
 *   `SYNTHETIC_TURN_END` event per completed turn so consumers can
 *   write a single cross-runtime turn-boundary handler (see
 *   `RuntimeSessionEvent` for details).
 * - `done` always resolves (never rejects) with `RuntimeSessionStatus`
 *   once the backing transport has fully terminated.
 *
 * Runtime-specific handles (e.g. `ClaudeSession`, `CursorSession`) may
 * expose additional fields such as `pid` or a runtime-native id alias
 * (`chatId`, `threadId`); cast to the concrete type when you need them.
 *
 * ## Emulated session caveat
 *
 * Adapters whose `RuntimeCapabilities.sessionFidelity` is `"emulated"`
 * (currently only Cursor — see `CursorSession`) preserve the neutral
 * lifecycle but deviate from "native" sessions in three ways that
 * consumers of the neutral handle must be aware of:
 *
 * 1. **`send()` returns before the transport accepts the message.** A
 *    fresh subprocess is spawned per send and the worker queue
 *    serializes them; `send()` resolves on enqueue, not on subprocess
 *    spawn. Per-turn delivery failures therefore cannot reject `send`
 *    after the fact — they surface on the event stream (Cursor:
 *    synthetic `{type:"error",subtype:"send_failed"}` plus a
 *    runtime-specific callback such as
 *    `CursorSessionOptions.onSendFailed`).
 * 2. **`model` is silently ignored.** Cursor's `--resume` does not
 *    accept `--model`, so any model selection at session-open time has
 *    no effect on the underlying chat.
 * 3. **`systemPrompt` only applies to the first message of newly
 *    created chats.** It is merged into that message's text; resumed
 *    chats already carry the original system prompt and the field is
 *    dropped.
 */
export interface RuntimeSession {
  /** Runtime that owns this session. */
  readonly runtime: RuntimeId;
  /**
   * Session identifier suitable for passing to
   * `RuntimeSessionOptions.resumeSessionId` on a subsequent `openSession`
   * call.
   *
   * **Population timing is runtime-specific — read carefully:**
   *
   * - OpenCode, Cursor, Codex: populated synchronously before
   *   `openSession()` resolves. Safe to persist immediately.
   * - Claude: the CLI allocates the id inside the subprocess and emits it
   *   in the first `system/init` event. The handle exposes an empty string
   *   (`""`) until that event is parsed, then updates in place. Consumers
   *   that need to persist the id for crash recovery should wait until
   *   the first event (the first `SYNTHETIC_TURN_END` or any prior event
   *   will do) before reading.
   *
   * This mirrors what the native CLIs actually guarantee — exposing a
   * Promise here would make the API feel asymmetric for the 3 adapters
   * that know the id synchronously.
   */
  readonly sessionId: string;
  /**
   * Push an additional user message into the running session. Resolves
   * when the runtime has accepted the input (not when the turn completes).
   * Rejects with a `SessionError` subclass — see the contract note on the
   * interface itself for which subclass fires when.
   */
  send(content: string): Promise<void>;
  /**
   * Async iterator of normalized session events. Completes when the
   * runtime's output stream closes. **One-shot** — typed as
   * `AsyncIterableIterator` so a second `for await` (or any second
   * `[Symbol.asyncIterator]()` call) is both a TypeScript error against
   * a freshly assigned `AsyncIterable<…>` view and a runtime throw via
   * the guard in `SessionEventQueue`. Includes adapter-injected
   * synthetics (see `RuntimeSessionEvent`).
   */
  readonly events: AsyncIterableIterator<RuntimeSessionEvent>;
  /**
   * Signal no more sends will arrive; initiate graceful shutdown.
   * Returns promptly — await `done` for full termination.
   */
  endInput(): Promise<void>;
  /** SIGTERM (or transport-equivalent). Idempotent. */
  abort(reason?: string): void;
  /** Resolves with terminal status when the backing transport exits. */
  readonly done: Promise<RuntimeSessionStatus>;
}
