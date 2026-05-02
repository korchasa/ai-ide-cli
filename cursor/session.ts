/**
 * @module
 * Faux streaming-input Cursor CLI session.
 *
 * Cursor CLI has no streaming-input transport (no `--input-format stream-json`
 * equivalent). `openCursorSession` emulates a long-lived session by:
 *
 * 1. Obtaining a chat ID up front via `cursor agent create-chat` (unless the
 *    caller supplies `resumeSessionId`).
 * 2. Spawning a fresh `cursor agent -p --resume <chatId> <message>` subprocess
 *    for every {@link CursorSession.send}. Sends are serialized — the worker
 *    waits for the current subprocess to exit before starting the next.
 * 3. Forwarding every NDJSON event from each subprocess into a single
 *    async-iterable queue so consumers see one unbroken event stream across
 *    turns. A synthetic `{type:"system",subtype:"init",synthetic:true}` event
 *    carrying the chat ID is pushed at open time.
 *
 * Contract alignment with {@link import("../runtime/types.ts").RuntimeSession}:
 *
 * - `send(content)` returns **immediately** after the message is enqueued.
 *   The actual subprocess spawn happens asynchronously on the worker. Per-turn
 *   failures surface (a) as a synthetic
 *   `{type:"error",subtype:"send_failed"}` event on the event stream,
 *   (b) through `done.exitCode`, and (c) — when the consumer opts in — via
 *   {@link CursorSessionOptions.onSendFailed} with a typed
 *   {@link SessionDeliveryError}; not as a rejected `send` promise.
 * - `endInput()` signals "no more sends" and returns promptly. The worker
 *   drains any remaining queued sends, then closes the event stream. Full
 *   shutdown is observable via `await session.done`.
 *
 * The session stays "alive" between sends from the caller's perspective, but
 * no subprocess is actually running while idle. `pid` reflects the currently
 * active subprocess (or `0` when idle). Model selection is ignored for the
 * same reason the one-shot path drops it on `--resume`: Cursor's resume flow
 * does not accept `--model`.
 *
 * Entry point: {@link openCursorSession}.
 */

import {
  type ExtraArgsMap,
  SessionAbortedError,
  SessionDeliveryError,
  SessionInputClosedError,
} from "../runtime/types.ts";
import {
  type OnCallbackError,
  safeInvokeCallback,
} from "../runtime/callback-safety.ts";
import { withSyncedPWD } from "../runtime/env-cwd-sync.ts";
import { SessionEventQueue } from "../runtime/event-queue.ts";
import type { ProcessRegistry } from "../process-registry.ts";
import { buildCursorSendArgs } from "./argv.ts";
import { createCursorChat } from "./chat.ts";
import { decodeConcat, pumpCursorStderr, pumpCursorStdout } from "./pumps.ts";

// Back-compat re-exports: tests and downstream consumers continue to import
// these from `./session.ts`.
export { buildCursorSendArgs } from "./argv.ts";
export { createCursorChat, type CreateCursorChatOptions } from "./chat.ts";

/** Options for {@link openCursorSession}. */
export interface CursorSessionOptions {
  /**
   * System prompt prepended to the **first** send of a newly created chat.
   * Ignored when {@link resumeSessionId} is set (resumed chats already carry
   * their original system prompt). Cursor's resume flow does not accept
   * `--append-system-prompt`, so this is merged into the first user message.
   */
  systemPrompt?: string;
  /** Runtime-specific permission mode. `"bypassPermissions"` maps to `--yolo`. */
  permissionMode?: string;
  /**
   * Resume an existing chat instead of creating a new one. When set,
   * `create-chat` is skipped.
   */
  resumeSessionId?: string;
  /**
   * Extra CLI flags forwarded to each `cursor agent -p --resume` invocation.
   * See {@link ExtraArgsMap} for value semantics. Keys in
   * {@link CURSOR_RESERVED_FLAGS} throw.
   */
  cursorArgs?: ExtraArgsMap;
  /** Working directory for the subprocesses. */
  cwd?: string;
  /** Extra env merged into each subprocess's env. */
  env?: Record<string, string>;
  /**
   * External abort signal. On abort, the current subprocess (if any) receives
   * SIGTERM, the worker loop drains and rejects pending sends, and the
   * session's `done` promise resolves.
   */
  signal?: AbortSignal;
  /** Fires for every parsed NDJSON event emitted by any send subprocess. */
  onEvent?: (event: CursorStreamEvent) => void;
  /** Fires for every decoded stderr line across all send subprocesses. */
  onStderr?: (line: string) => void;
  /**
   * Fires once per per-turn subprocess that exits non-zero (and was not
   * aborted). The `err` argument is a {@link SessionDeliveryError} whose
   * `cause` carries the underlying spawn/exit-code error and whose
   * `runtime` is `"cursor"`; `message` is the original text the
   * consumer passed to {@link CursorSession.send} (correlation hook —
   * the synthetic event on the stream does not carry it).
   *
   * Provided so consumers can opt into a typed `SessionDeliveryError`
   * notification path without polling the synthetic
   * `{type:"error",subtype:"send_failed"}` event. The synthetic event
   * is still pushed afterwards, preserving back-compat for existing
   * stream-watching consumers.
   *
   * Consumer exceptions are swallowed (`onSendFailed` is a notification
   * hook, mirroring the contract of {@link onEvent} / {@link onStderr}).
   */
  onSendFailed?: (err: SessionDeliveryError, message: string) => void;
  /**
   * Routed error sink for `onEvent` / `onStderr` / `onSendFailed` throws.
   * Default handler logs to `console.warn`; supply a no-op to opt out.
   * Streaming loop stays alive regardless. See FR-L32.
   */
  onCallbackError?: OnCallbackError;
  /**
   * Optional process registry that owns this session's send subprocesses.
   * When omitted, the module-level default registry is used, preserving
   * backward compatibility. Embedders that host multiple independent
   * runtimes in one process should pass an instance-scoped
   * {@link ProcessRegistry} so `killAll` is scoped to the embedder.
   */
  processRegistry: ProcessRegistry;
}

// FR-L30: re-export the typed discriminated union from cursor/stream.ts as
// the canonical session-event shape. JSON.parse returns `any` so the cast
// in `safeParse` still compiles, and downstream consumers gain narrowing
// on `event.type` / `event.subtype` without changing the call shape.
export type { CursorStreamEvent } from "./stream.ts";
import type { CursorStreamEvent } from "./stream.ts";

/** Terminal state of a Cursor session after all sends have drained. */
export interface CursorSessionStatus {
  /**
   * OS exit code of the **last** send subprocess, or `null` when the session
   * was aborted or never ran a subprocess.
   */
  exitCode: number | null;
  /**
   * Termination signal name of the last subprocess (`"SIGTERM"` after abort),
   * `null` when exited normally.
   */
  signal: Deno.Signal | null;
  /** Aggregated stderr text captured across every send subprocess. */
  stderr: string;
}

/**
 * Live handle for a faux Cursor streaming session.
 *
 * Lifecycle: open → zero or more {@link send} / {@link events} iterations →
 * {@link endInput} (graceful drain) or {@link abort} (SIGTERM current) →
 * `done` resolves.
 */
export interface CursorSession {
  /** Always `"cursor"`. */
  readonly runtime: "cursor";
  /**
   * PID of the currently active send subprocess, or `0` when the session is
   * idle (between sends or after close). Implemented as a getter — reads
   * reflect the live state.
   */
  readonly pid: number;
  /** Chat ID backing every `--resume` call. */
  readonly chatId: string;
  /**
   * Alias of {@link chatId}, matching the neutral
   * {@link import("../runtime/types.ts").RuntimeSession.sessionId} name.
   * Always populated synchronously at open time (either from the supplied
   * `resumeSessionId` or from `cursor agent create-chat`).
   */
  readonly sessionId: string;
  /**
   * Enqueue the given text as a new user message. Resolves **immediately**
   * once the item has been queued — does NOT wait for the subprocess to
   * spawn or complete. Rejects with {@link SessionInputClosedError} after
   * {@link endInput} or {@link SessionAbortedError} after {@link abort}.
   * Per-turn subprocess failures surface as a synthetic
   * `{type:"error",subtype:"send_failed"}` event on the event stream and,
   * when supplied, via {@link CursorSessionOptions.onSendFailed} (typed
   * {@link SessionDeliveryError}). They do NOT reject this promise: the
   * send itself (i.e. enqueueing the message) already succeeded by the
   * time `send` returns; only later subprocess execution failed.
   */
  send(content: string): Promise<void>;
  /**
   * Async iterator of every parsed NDJSON event across all send subprocesses,
   * prefixed by a synthetic `system.init` event carrying the chat ID, plus
   * any synthetic `error` events produced by failed sends.
   * Completes after {@link endInput} drains or {@link abort} fires.
   * **One-shot** — typed as `AsyncIterableIterator` to surface a TypeScript
   * error on accidental re-iteration, with the runtime guard in
   * {@link import("../runtime/event-queue.ts").SessionEventQueue} as a
   * belt-and-suspenders fallback.
   */
  readonly events: AsyncIterableIterator<CursorStreamEvent>;
  /**
   * Signal no more sends will arrive. Returns promptly. The worker drains
   * any remaining queued sends, then closes the event stream. Full shutdown
   * is observable via {@link done}.
   */
  endInput(): Promise<void>;
  /**
   * Refuse further sends, SIGTERM the active subprocess, reject pending sends,
   * close the event stream. Idempotent.
   */
  abort(reason?: string): void;
  /** Resolves with the terminal status once the worker loop has drained. */
  readonly done: Promise<CursorSessionStatus>;
}

/**
 * Open a faux streaming-input Cursor session. See the module header for the
 * create-chat + resume-per-send emulation strategy.
 */
export async function openCursorSession(
  opts: CursorSessionOptions,
): Promise<CursorSession> {
  const registry = opts.processRegistry;
  const chatId = opts.resumeSessionId ??
    (await createCursorChat({
      cwd: opts.cwd,
      env: opts.env,
      processRegistry: opts.processRegistry,
    }));

  const queue = new SessionEventQueue<CursorStreamEvent>("CursorSession");
  queue.push({
    type: "system",
    subtype: "init",
    session_id: chatId,
    runtime: "cursor",
    synthetic: true,
  });

  const pending: string[] = [];
  const stderrChunks: Uint8Array[] = [];

  let inputClosed = false;
  let aborted = false;
  let currentProcess: Deno.ChildProcess | undefined;
  let currentPid = 0;
  let pendingSystemPrompt = opts.resumeSessionId
    ? ""
    : (opts.systemPrompt ?? "");
  let lastExitCode: number | null = null;
  let lastSignal: Deno.Signal | null = null;
  let workerWaker: (() => void) | undefined;

  function wakeWorker(): void {
    const r = workerWaker;
    workerWaker = undefined;
    r?.();
  }

  async function runSingleSend(message: string): Promise<void> {
    const effective = pendingSystemPrompt
      ? `${pendingSystemPrompt}\n\n${message}`
      : message;
    pendingSystemPrompt = "";

    const args = buildCursorSendArgs({
      chatId,
      message: effective,
      permissionMode: opts.permissionMode,
      cursorArgs: opts.cursorArgs,
    });

    // FR-L33: sync env.PWD with cwd at the spawn boundary.
    const syncedEnv = withSyncedPWD(opts.env, opts.cwd);
    const proc = new Deno.Command("cursor", {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      ...(syncedEnv ? { env: syncedEnv } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    }).spawn();

    currentProcess = proc;
    currentPid = proc.pid;
    registry.register(proc);

    // If abort landed between spawn and registration, catch it now.
    if (aborted) {
      try {
        proc.kill("SIGTERM");
      } catch {
        // already exited
      }
    }

    const stdoutPump = pumpCursorStdout(
      proc.stdout,
      queue,
      opts.onEvent,
      opts.onCallbackError,
    );
    const stderrPump = pumpCursorStderr(
      proc.stderr,
      stderrChunks,
      opts.onStderr,
      opts.onCallbackError,
    );

    try {
      const [status] = await Promise.all([proc.status, stdoutPump, stderrPump]);
      lastExitCode = status.code;
      lastSignal = status.signal ?? null;
      if (!status.success && !aborted) {
        throw new Error(
          `Cursor CLI send exited with code ${status.code}${
            status.signal ? ` (signal ${status.signal})` : ""
          }`,
        );
      }
    } finally {
      registry.unregister(proc);
      currentProcess = undefined;
      currentPid = 0;
    }
  }

  async function runWorker(): Promise<void> {
    try {
      while (true) {
        while (pending.length === 0 && !inputClosed && !aborted) {
          await new Promise<void>((r) => {
            workerWaker = r;
          });
        }
        if (aborted) break;
        if (pending.length === 0 && inputClosed) break;

        const message = pending.shift()!;
        try {
          await runSingleSend(message);
        } catch (err) {
          if (!aborted) {
            // Surface the failure two ways:
            //   1. Typed callback: consumers that opt into the
            //      `SessionDeliveryError`-shaped contract get a
            //      synchronous notification with the original message
            //      for correlation.
            //   2. Synthetic event: legacy back-compat path — keeps
            //      stream-watching consumers working unchanged.
            const cause = err instanceof Error ? err : new Error(String(err));
            const deliveryErr = new SessionDeliveryError(
              "cursor",
              cause.message,
              { cause },
            );
            // FR-L32: route consumer-callback throws to onCallbackError.
            safeInvokeCallback(
              opts.onSendFailed,
              [deliveryErr, message],
              "onSendFailed",
              opts.onCallbackError,
            );
            queue.push({
              type: "error",
              subtype: "send_failed",
              runtime: "cursor",
              error: cause.message,
              synthetic: true,
            });
          }
        }
      }
    } finally {
      queue.close();
    }
  }

  const workerDone = runWorker();

  function send(content: string): Promise<void> {
    if (aborted) {
      return Promise.reject(new SessionAbortedError("cursor"));
    }
    if (inputClosed) {
      return Promise.reject(new SessionInputClosedError("cursor"));
    }
    pending.push(content);
    wakeWorker();
    return Promise.resolve();
  }

  function endInput(): Promise<void> {
    if (!inputClosed) {
      inputClosed = true;
      wakeWorker();
    }
    return Promise.resolve();
  }

  function abort(_reason?: string): void {
    if (aborted) return;
    aborted = true;
    inputClosed = true;
    if (currentProcess) {
      try {
        currentProcess.kill("SIGTERM");
      } catch {
        // already exited
      }
    }
    wakeWorker();
  }

  if (opts.signal) {
    if (opts.signal.aborted) {
      abort();
    } else {
      opts.signal.addEventListener("abort", () => abort(), { once: true });
    }
  }

  const done = workerDone.then<CursorSessionStatus>(() => ({
    exitCode: lastExitCode,
    signal: lastSignal,
    stderr: decodeConcat(stderrChunks),
  }));

  return {
    runtime: "cursor",
    get pid() {
      return currentPid;
    },
    chatId,
    sessionId: chatId,
    send,
    events: queue,
    endInput,
    abort,
    done,
  };
}
