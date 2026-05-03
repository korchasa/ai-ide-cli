/**
 * @module
 * Streaming-input Codex session backed by the **experimental** `codex
 * app-server` JSON-RPC transport (`codex app-server --listen stdio://`).
 *
 * Unlike the one-shot `invoke` path in `codex/process.ts` — which writes the
 * prompt to a `codex exec` subprocess stdin, closes stdin, and consumes the
 * NDJSON stream until exit — this session uses Codex's bidirectional
 * JSON-RPC app-server protocol. That transport supports follow-up user
 * messages while a turn is still running (`turn/steer`) and mid-turn
 * cancellation (`turn/interrupt`), which `codex exec` cannot express
 * because it closes stdin immediately.
 *
 * **Parallel protocol warning.** This file consumes the `codex app-server`
 * JSON-RPC v2 transport — item types are **camelCase** (`agentMessage`,
 * `commandExecution`, `fileChange`, `mcpToolCall`, `webSearch`,
 * `dynamicToolCall`, `collabAgentToolCall`, `reasoning`, `plan`,
 * `imageView`, …), field names are camelCase
 * (`aggregatedOutput`, `exitCode`, `threadId`, `turnId`), and final
 * assistant text lives at `params.item.text` (not `content[*].text`).
 * The one-shot `codex/process.ts` file uses a DIFFERENT protocol
 * (`codex exec --experimental-json` NDJSON) with **snake_case** item
 * types (`agent_message`, `command_execution`, `file_change`,
 * `mcp_tool_call`, `web_search`) and slightly different fields. Do NOT
 * cross-reference helpers between the two files — a helper like
 * `codexItemToToolUseInfo` only recognizes the NDJSON literals and will
 * silently return nothing when fed app-server events. Canonical source
 * for this file's types: `codex app-server generate-ts --out <dir>`
 * (`v2/ThreadItem.ts`, `v2/ItemCompletedNotification.ts`).
 *
 * Thread/turn semantics:
 *
 * 1. Spawn the app-server client.
 * 2. `initialize` → `initialized` handshake.
 * 3. `thread/start` (fresh) or `thread/resume` (resume an existing thread
 *    by id). Response carries the {@link Thread} with an `id` we persist as
 *    the session's `thread_id`.
 * 4. First {@link CodexSession.send} → `turn/start`. Additional `send`
 *    calls while the turn is in-flight → `turn/steer` with `expectedTurnId`
 *    set to the currently active turn's id.
 * 5. Inbound `turn/started` / `turn/completed` notifications track the
 *    active turn id.
 * 6. {@link CodexSession.endInput} is signal-only — calls
 *    `CodexAppServerClient.closeStdin()` (EOFs stdin, returns after flush)
 *    and resolves without waiting for the subprocess to exit. Full-shutdown
 *    observation lives on `session.done`. {@link CodexSession.abort}
 *    SIGTERMs.
 *
 * Upstream references — use as source of truth when extending:
 *
 * - Codex CLI source:
 *   https://github.com/openai/codex
 * - TS bindings (generated from the binary):
 *   `codex app-server generate-ts --out <dir>` → `ClientRequest.ts`,
 *   `ServerNotification.ts`, `v2/{ThreadStartParams,TurnStartParams,
 *   TurnSteerParams,TurnInterruptParams,ThreadResumeParams,UserInput}.ts`.
 *
 * IMPORTANT: `codex app-server` is EXPERIMENTAL upstream. Method names,
 * parameter shapes, and notification payloads may shift between CLI
 * versions. This implementation targets `codex-cli >= 0.121.0`.
 *
 * Entry point: {@link openCodexSession}.
 */

import {
  type RuntimeSession,
  type RuntimeSessionEvent,
  type RuntimeSessionOptions,
  type RuntimeSessionStatus,
  SessionAbortedError,
  SessionDeliveryError,
  SessionInputClosedError,
  SYNTHETIC_TURN_END,
} from "../runtime/types.ts";
import { safeInvokeCallback } from "../runtime/callback-safety.ts";
import { SessionEventQueue } from "../runtime/event-queue.ts";
import {
  buildCodexMcpServersArgs,
  validateMcpServers,
} from "../runtime/mcp-injection.ts";
import {
  CodexAppServerClient,
  CodexAppServerError,
  type CodexAppServerNotification,
} from "./app-server.ts";
import { isCodexNotification } from "./events.ts";
import {
  type ApprovalPolicy,
  decidePermissionMode,
  type SandboxMode,
} from "./permission-mode.ts";

/**
 * Permission-mode mapping for the app-server transport.
 *
 * Thin serializer over
 * {@link import("./permission-mode.ts").decidePermissionMode} — the
 * conceptual decision lives there, this function only emits the
 * `thread/start` `approvalPolicy` / `sandbox` fields. `undefined`
 * fields stay omitted from the request so Codex falls back to its
 * own config defaults.
 *
 * Companion serializer for the one-shot transport is
 * {@link import("./process.ts").permissionModeToCodexArgs}.
 *
 * Exported for testing.
 */
export function permissionModeToThreadStartFields(
  mode?: string,
): { approvalPolicy?: ApprovalPolicy; sandbox?: SandboxMode } {
  return decidePermissionMode(mode);
}

/**
 * Convert an {@link import("../runtime/types.ts").ExtraArgsMap}-style map to
 * the `--config key=value` argv list that the app-server accepts. Unlike
 * the one-shot adapter we cannot pass arbitrary CLI flags through — the
 * app-server argv is mostly `--config` overrides. Callers that want
 * anything else should use the `binary` hook to override the executable
 * directly.
 *
 * Exported for testing.
 */
export function expandCodexSessionExtraArgs(
  map?: Record<string, string | null>,
): string[] {
  if (!map) return [];
  const args: string[] = [];
  for (const [key, value] of Object.entries(map)) {
    if (value === null) continue;
    args.push(key, value);
  }
  return args;
}

/**
 * Result of {@link openCodexSession}. Thin wrapper around a
 * {@link CodexAppServerClient} that exposes runtime-neutral session
 * semantics plus the Codex-specific `threadId` and app-server `pid`.
 */
export interface CodexSession extends RuntimeSession {
  /** OS process id of the spawned `codex app-server` subprocess. */
  readonly pid: number;
  /**
   * Stable Codex thread id assigned by `thread/start` or `thread/resume`.
   * The neutral {@link RuntimeSession.sessionId} aliases this value so
   * consumers that treat Codex threads as sessions do not need to cast.
   */
  readonly threadId: string;
}

/**
 * Open a streaming-input Codex session against the app-server transport.
 *
 * Spawns `codex app-server --listen stdio://`, performs the
 * `initialize`/`initialized` handshake, starts (or resumes) a thread, and
 * returns a {@link CodexSession} handle that accepts additional user
 * messages via {@link CodexSession.send}. The first send maps to
 * `turn/start`; subsequent sends while a turn is active map to
 * `turn/steer`.
 *
 * NOTE: `codex app-server` is **experimental** upstream. Expect protocol
 * drift between `codex-cli` releases. Targets `codex-cli >= 0.121.0`.
 */
export async function openCodexSession(
  opts: RuntimeSessionOptions & {
    /** Override the `codex` binary path (used in tests). */
    binary?: string;
  },
): Promise<CodexSession> {
  const extraArgv = expandCodexSessionExtraArgs(opts.extraArgs);
  // FR-L25: abstract reasoning effort → Codex app-server --config override,
  // inserted before the caller's extraArgs so they can still override.
  if (opts.reasoningEffort) {
    extraArgv.unshift(
      "--config",
      `model_reasoning_effort="${opts.reasoningEffort}"`,
    );
  }
  // FR-L35: typed mcpServers → repeated `--config mcp_servers.<name>.*`
  // overrides on the app-server argv. Validate first so http-on-codex
  // throws synchronously; prepend so consumer extraArgs can still
  // override on duplication.
  validateMcpServers("codex", { mcpServers: opts.mcpServers });
  const mcpArgv = buildCodexMcpServersArgs(opts.mcpServers);
  if (mcpArgv.length > 0) extraArgv.unshift(...mcpArgv);

  const client = CodexAppServerClient.spawn({
    binary: opts.binary,
    extraArgs: extraArgv,
    cwd: opts.cwd,
    env: opts.env,
    signal: opts.signal,
    onStderr: opts.onStderr,
    processRegistry: opts.processRegistry,
  });

  // Deliberately do not await the subprocess exit here — the client's
  // `done` promise handles cleanup. We want to push the handshake through
  // as soon as spawn() returns.
  try {
    await handshake(client);

    const threadId = opts.resumeSessionId
      ? await resumeThread(client, opts)
      : await startThread(client, opts);

    // Track active turn id from notifications. Each turn/steer requires
    // the expectedTurnId precondition, so we keep the latest one alive.
    let activeTurnId: string | null = null;

    // Aggregate notifications into a runtime-neutral event queue and keep a
    // side-channel notification pump that owns the activeTurnId tracking.
    const events = new SessionEventQueue<RuntimeSessionEvent>("CodexSession");

    const notificationPump = (async () => {
      try {
        for await (const note of client.notifications) {
          const wasTurnEnd = note.method === "turn/completed";
          activeTurnId = updateActiveTurnId(activeTurnId, note);
          const runtimeEvent: RuntimeSessionEvent = {
            runtime: "codex",
            type: lastSegment(note.method),
            raw: { method: note.method, params: note.params },
          };
          events.push(runtimeEvent);
          // FR-L32: route consumer-callback throws to onCallbackError.
          safeInvokeCallback(
            opts.onEvent,
            [runtimeEvent],
            "onEvent",
            opts.onCallbackError,
          );
          if (wasTurnEnd) {
            const synthetic: RuntimeSessionEvent = {
              runtime: "codex",
              type: SYNTHETIC_TURN_END,
              raw: runtimeEvent.raw,
              synthetic: true,
            };
            events.push(synthetic);
            // FR-L32: same routing for the synthetic turn-end event.
            safeInvokeCallback(
              opts.onEvent,
              [synthetic],
              "onEvent",
              opts.onCallbackError,
            );
          }
        }
      } finally {
        events.close();
      }
    })();

    const done: Promise<RuntimeSessionStatus> = (async () => {
      const status = await client.done;
      // Ensure any in-flight notification pump is drained before we resolve.
      await notificationPump;
      return {
        exitCode: status.exitCode,
        signal: status.signal,
        stderr: status.stderr,
      };
    })();

    let ended = false;
    let sessionAborted = false;

    const send = async (content: string): Promise<void> => {
      if (sessionAborted) throw new SessionAbortedError("codex");
      if (ended) throw new SessionInputClosedError("codex");
      const isFirstTurn = activeTurnId === null;
      const params = isFirstTurn
        ? {
          threadId,
          input: [{ type: "text", text: content, text_elements: [] }],
        }
        : {
          threadId,
          input: [{ type: "text", text: content, text_elements: [] }],
          expectedTurnId: activeTurnId,
        };
      const method = isFirstTurn ? "turn/start" : "turn/steer";
      try {
        // `turn/start` returns `TurnStartResponse = { turn: Turn }` —
        // promote `turn.id` to `activeTurnId` synchronously to close the
        // race where a follow-up `send()` arrives before the asynchronous
        // `turn/started` notification. `turn/steer` returns
        // `TurnSteerResponse = { turnId }` — keep `activeTurnId` aligned.
        if (isFirstTurn) {
          const result = await client.request<
            { turn?: { id?: unknown } } | undefined
          >(method, params);
          const turnIdFromResponse = result?.turn?.id;
          if (typeof turnIdFromResponse === "string" && activeTurnId === null) {
            activeTurnId = turnIdFromResponse;
          }
        } else {
          const result = await client.request<
            { turnId?: unknown } | undefined
          >(method, params);
          const turnIdFromResponse = result?.turnId;
          if (typeof turnIdFromResponse === "string") {
            activeTurnId = turnIdFromResponse;
          }
        }
      } catch (err) {
        // JSON-RPC error, broken stdin pipe, or subprocess exit before
        // response all mean "the message did not reach Codex". Surface them
        // as a uniform SessionDeliveryError so consumers can catch one
        // class rather than three underlying transport exceptions.
        if (err instanceof CodexAppServerError) {
          throw new SessionDeliveryError(
            "codex",
            `codex session: ${method} rejected by server: ${err.message}`,
            { cause: err },
          );
        }
        throw new SessionDeliveryError(
          "codex",
          `codex session: ${method} failed: ${(err as Error).message}`,
          { cause: err },
        );
      }
    };

    const endInput = async (): Promise<void> => {
      if (ended) return;
      ended = true;
      // Signal-only: close stdin and return. Full-shutdown observation is
      // `await session.done`. Matches the uniform RuntimeSession contract.
      await client.closeStdin();
    };

    const abort = (reason?: string): void => {
      if (sessionAborted) return;
      sessionAborted = true;
      ended = true;
      client.abort(reason);
    };

    return {
      runtime: "codex",
      pid: client.pid,
      threadId,
      sessionId: threadId,
      send,
      events,
      endInput,
      abort,
      done,
    };
  } catch (err) {
    // Tear down the subprocess if handshake/thread start failed.
    try {
      client.abort((err as Error).message);
    } catch {
      // best effort
    }
    try {
      await client.done;
    } catch {
      // best effort
    }
    throw err;
  }
}

/** Send `initialize` + `initialized` to the server. */
async function handshake(client: CodexAppServerClient): Promise<void> {
  await client.request("initialize", {
    clientInfo: {
      name: "ai-ide-cli",
      title: null,
      version: CODEX_SESSION_CLIENT_VERSION,
    },
    capabilities: {
      experimentalApi: true,
    },
  });
  await client.notify("initialized");
}

async function startThread(
  client: CodexAppServerClient,
  opts: RuntimeSessionOptions,
): Promise<string> {
  const { approvalPolicy, sandbox } = permissionModeToThreadStartFields(
    opts.permissionMode,
  );
  const params: Record<string, unknown> = {};
  if (opts.model) params.model = opts.model;
  if (opts.cwd) params.cwd = opts.cwd;
  if (approvalPolicy) params.approvalPolicy = approvalPolicy;
  if (sandbox) params.sandbox = sandbox;
  if (opts.systemPrompt) params.baseInstructions = opts.systemPrompt;

  const result = await client.request<{ thread: { id: string } }>(
    "thread/start",
    params,
  );
  return result.thread.id;
}

async function resumeThread(
  client: CodexAppServerClient,
  opts: RuntimeSessionOptions,
): Promise<string> {
  const { approvalPolicy, sandbox } = permissionModeToThreadStartFields(
    opts.permissionMode,
  );
  const params: Record<string, unknown> = {
    threadId: opts.resumeSessionId,
  };
  if (opts.model) params.model = opts.model;
  if (opts.cwd) params.cwd = opts.cwd;
  if (approvalPolicy) params.approvalPolicy = approvalPolicy;
  if (sandbox) params.sandbox = sandbox;
  if (opts.systemPrompt) params.baseInstructions = opts.systemPrompt;

  const result = await client.request<{ thread: { id: string } }>(
    "thread/resume",
    params,
  );
  return result.thread.id;
}

/**
 * Pure helper: update `activeTurnId` from a server notification.
 *
 * Protocol mapping:
 * - `turn/started` → set `activeTurnId` to `params.turn.id`.
 * - `turn/completed` → clear `activeTurnId` (next `send` starts a new turn).
 *
 * Other notifications pass through unchanged.
 *
 * Exported for testing.
 */
export function updateActiveTurnId(
  current: string | null,
  note: CodexAppServerNotification,
): string | null {
  // FR-L26: `isCodexNotification` promotes the raw notification to a sharp
  // discriminated variant — `note.params.turn` is `CodexTurn` after narrow.
  if (isCodexNotification(note, "turn/started")) {
    return typeof note.params.turn.id === "string"
      ? note.params.turn.id
      : current;
  }
  if (isCodexNotification(note, "turn/completed")) {
    return null;
  }
  return current;
}

/** Client version advertised via the `initialize` handshake. Surfaces in Codex logs. */
export const CODEX_SESSION_CLIENT_VERSION = "0.3.0";

/**
 * Take the last path segment of a JSON-RPC method name: `"turn/started"` →
 * `"started"`. Used to produce {@link RuntimeSessionEvent.type} values
 * consistent with the rest of the library (stripped namespace prefix).
 */
function lastSegment(method: string): string {
  const idx = method.lastIndexOf("/");
  return idx >= 0 ? method.slice(idx + 1) : method;
}
