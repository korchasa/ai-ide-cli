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
 * 6. {@link CodexSession.endInput} sends `initialize` → nothing; it closes
 *    the client stdin and waits for exit. {@link CodexSession.abort} SIGTERMs.
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

import type {
  RuntimeSession,
  RuntimeSessionEvent,
  RuntimeSessionOptions,
  RuntimeSessionStatus,
} from "../runtime/types.ts";
import {
  CodexAppServerClient,
  type CodexAppServerNotification,
} from "./app-server.ts";

/**
 * Permission-mode mapping for the app-server transport.
 *
 * Returns the `approvalPolicy` / `sandbox` fields to pass into
 * `thread/start` params. `undefined` fields are omitted from the request so
 * Codex falls back to its own config defaults.
 *
 * Mirrors {@link import("./process.ts").permissionModeToCodexArgs} but emits
 * structured params instead of argv fragments.
 *
 * Exported for testing.
 */
export function permissionModeToThreadStartFields(
  mode?: string,
): { approvalPolicy?: string; sandbox?: string } {
  if (!mode || mode === "default") return {};
  switch (mode) {
    case "plan":
      return { approvalPolicy: "never", sandbox: "read-only" };
    case "acceptEdits":
      return { approvalPolicy: "never", sandbox: "workspace-write" };
    case "bypassPermissions":
      return { approvalPolicy: "never", sandbox: "danger-full-access" };
  }
  // Native pass-through modes (see CODEX_SANDBOX_MODES / CODEX_APPROVAL_MODES
  // in codex/process.ts for the full list).
  if (
    mode === "read-only" || mode === "workspace-write" ||
    mode === "danger-full-access"
  ) {
    return { sandbox: mode };
  }
  if (
    mode === "never" || mode === "on-request" || mode === "on-failure" ||
    mode === "untrusted"
  ) {
    return { approvalPolicy: mode };
  }
  return {};
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
 * semantics.
 */
export interface CodexSession extends RuntimeSession {
  /** Stable Codex thread id assigned by `thread/start` or `thread/resume`. */
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
  } = {},
): Promise<CodexSession> {
  const extraArgv = expandCodexSessionExtraArgs(opts.extraArgs);

  const client = CodexAppServerClient.spawn({
    binary: opts.binary,
    extraArgs: extraArgv,
    cwd: opts.cwd,
    env: opts.env,
    signal: opts.signal,
    onStderr: opts.onStderr,
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
    const events = new EventQueue();

    const notificationPump = (async () => {
      try {
        for await (const note of client.notifications) {
          activeTurnId = updateActiveTurnId(activeTurnId, note);
          const runtimeEvent: RuntimeSessionEvent = {
            runtime: "codex",
            type: lastSegment(note.method),
            raw: { method: note.method, params: note.params },
          };
          events.push(runtimeEvent);
          try {
            opts.onEvent?.(runtimeEvent);
          } catch {
            // onEvent is a notification hook — swallow consumer errors.
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
      if (sessionAborted) throw new Error("CodexSession: aborted");
      if (ended) throw new Error("CodexSession: input closed");
      if (activeTurnId === null) {
        await client.request("turn/start", {
          threadId,
          input: [{ type: "text", text: content, text_elements: [] }],
        });
      } else {
        await client.request("turn/steer", {
          threadId,
          input: [{ type: "text", text: content, text_elements: [] }],
          expectedTurnId: activeTurnId,
        });
      }
    };

    const endInput = async (): Promise<void> => {
      if (ended) return;
      ended = true;
      await client.close();
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
  const params: Record<string, unknown> = {
    experimentalRawEvents: false,
    persistExtendedHistory: false,
  };
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
    persistExtendedHistory: false,
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
  if (note.method === "turn/started") {
    const turn = note.params.turn as Record<string, unknown> | undefined;
    if (turn && typeof turn.id === "string") return turn.id;
    return current;
  }
  if (note.method === "turn/completed") {
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

/**
 * Unbounded FIFO queue backing a session's `events` iterable. Identical
 * semantics to `ClaudeSession`'s queue: blocking `next()`, single-shot
 * iteration, close-on-stdout-eof.
 */
class EventQueue implements AsyncIterable<RuntimeSessionEvent> {
  private items: RuntimeSessionEvent[] = [];
  private resolvers: Array<
    (r: IteratorResult<RuntimeSessionEvent>) => void
  > = [];
  private closed = false;
  private iterated = false;

  push(event: RuntimeSessionEvent): void {
    if (this.closed) return;
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value: event, done: false });
      return;
    }
    this.items.push(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const resolver of this.resolvers) {
      resolver({ value: undefined, done: true });
    }
    this.resolvers.length = 0;
  }

  [Symbol.asyncIterator](): AsyncIterator<RuntimeSessionEvent> {
    if (this.iterated) {
      throw new Error("CodexSession.events can only be iterated once");
    }
    this.iterated = true;
    return {
      next: (): Promise<IteratorResult<RuntimeSessionEvent>> => {
        const item = this.items.shift();
        if (item !== undefined) {
          return Promise.resolve({ value: item, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          this.resolvers.push(resolve);
        });
      },
      return: (): Promise<IteratorResult<RuntimeSessionEvent>> => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
