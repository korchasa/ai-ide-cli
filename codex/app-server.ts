/**
 * @module
 * Low-level JSON-RPC 2.0 client for the **experimental** `codex app-server`
 * transport (`codex app-server --listen stdio://`).
 *
 * This is the transport layer only — it knows nothing about threads or
 * turns. Higher-level semantics (thread lifecycle, turn dispatch,
 * notification routing) live in `codex/session.ts`.
 *
 * Protocol summary:
 *
 * - Newline-delimited JSON-RPC 2.0 over `stdin`/`stdout`.
 * - Outbound requests: `{"jsonrpc":"2.0","id":<n>,"method":…,"params":…}\n`.
 * - Outbound notifications: same shape without `id`.
 * - Inbound responses: matched to outbound requests by `id`. On success the
 *   message carries `result`; on failure, `error`.
 * - Inbound notifications: any inbound message without an `id` — delivered
 *   to consumers via {@link CodexAppServerClient.notifications}.
 *
 * Upstream references — use as source of truth when the protocol moves:
 *
 * - Codex CLI source (binary ships `app-server`, no public SDK package):
 *   https://github.com/openai/codex
 * - Generate current TS bindings ad-hoc:
 *   `codex app-server generate-ts --out <dir>` (produces `ClientRequest.ts`,
 *   `ServerNotification.ts`, `v2/*.ts`).
 * - The `codex --remote ws://…` flag connects a TUI to the same protocol,
 *   which confirms the transport is bidirectional and stable enough for
 *   external clients.
 *
 * IMPORTANT: `codex app-server` is marked EXPERIMENTAL upstream. Protocol
 * shapes (method names, param/response types) can shift between `codex`
 * CLI versions. This client targets `codex-cli >= 0.121.0`.
 *
 * Entry point: {@link CodexAppServerClient}.
 */

import { register, unregister } from "../process-registry.ts";

/**
 * Flags reserved by {@link CodexAppServerClient}. Keys in `extraArgs` that
 * match these throw synchronously — the client emits them itself.
 */
export const CODEX_APP_SERVER_RESERVED_FLAGS: readonly string[] = [
  "app-server",
  "--listen",
];

/** Shape of a server-sent notification (no `id`, just `method` + `params`). */
export interface CodexAppServerNotification {
  /** Notification method name, e.g. `"turn/started"`, `"thread/started"`. */
  method: string;
  /** Notification payload; shape depends on the method. */
  params: Record<string, unknown>;
}

/**
 * Options for {@link CodexAppServerClient.spawn}.
 */
export interface CodexAppServerClientOptions {
  /**
   * Path or PATH-resolvable name of the `codex` binary. Defaults to
   * `"codex"`. Override for tests (stub binaries on a sandboxed PATH).
   */
  binary?: string;
  /**
   * Extra argv inserted between `app-server` and `--listen stdio://` — for
   * example `--config approval_policy=never`. The reserved flags
   * {@link CODEX_APP_SERVER_RESERVED_FLAGS} may NOT appear here.
   */
  extraArgs?: string[];
  /** Working directory for the subprocess. */
  cwd?: string;
  /** Env vars merged into the subprocess environment. */
  env?: Record<string, string>;
  /**
   * External cancellation signal. On abort, the subprocess receives SIGTERM
   * and all pending requests reject.
   */
  signal?: AbortSignal;
  /** Fires for every decoded stderr chunk. */
  onStderr?: (chunk: string) => void;
}

/**
 * JSON-RPC 2.0 error payload returned by the server.
 */
export interface CodexAppServerRpcError {
  /** Server-defined error code. */
  code: number;
  /** Human-readable message. */
  message: string;
  /** Optional structured error payload. */
  data?: unknown;
}

/**
 * Error thrown when a JSON-RPC request receives an error response.
 *
 * The raw JSON-RPC error object is attached as `.rpcError` for callers that
 * need to inspect the server-defined `code`/`data` fields.
 */
export class CodexAppServerError extends Error {
  /** The JSON-RPC error object from the server. */
  readonly rpcError: CodexAppServerRpcError;
  /**
   * Construct a new error from the JSON-RPC method name and the `error`
   * field of the server's response.
   */
  constructor(method: string, rpcError: CodexAppServerRpcError) {
    super(
      `codex app-server ${method} failed (code=${rpcError.code}): ${rpcError.message}`,
    );
    this.name = "CodexAppServerError";
    this.rpcError = rpcError;
  }
}

/** Terminal state of a {@link CodexAppServerClient} subprocess. */
export interface CodexAppServerStatus {
  /** OS exit code when exited normally, `null` when killed by signal. */
  exitCode: number | null;
  /** Termination signal name when killed by signal, `null` otherwise. */
  signal: Deno.Signal | null;
  /** Aggregated stderr text captured during the session. */
  stderr: string;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/**
 * Subprocess-backed JSON-RPC 2.0 client for `codex app-server`. Constructed
 * via {@link CodexAppServerClient.spawn}.
 *
 * Lifecycle: spawn → `request(…)` / `notify(…)` / iterate `notifications` →
 * `close()` (graceful, EOFs stdin and awaits exit) or `abort()` (SIGTERM)
 * → `done` resolves.
 */
export class CodexAppServerClient {
  /** OS process ID of the spawned `codex` subprocess. */
  readonly pid: number;

  private readonly process: Deno.ChildProcess;
  private readonly stdinWriter: WritableStreamDefaultWriter<Uint8Array>;
  private readonly encoder = new TextEncoder();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationQueue = new NotificationQueue();
  private readonly stderrChunks: Uint8Array[] = [];
  private readonly externalSignal?: AbortSignal;
  private readonly onExternalAbort?: () => void;

  private nextId = 1;
  private stdinClosed = false;
  private aborted = false;

  /** Resolves with terminal status when the subprocess exits. */
  readonly done: Promise<CodexAppServerStatus>;

  private constructor(
    process: Deno.ChildProcess,
    opts: CodexAppServerClientOptions,
  ) {
    this.process = process;
    this.pid = process.pid;
    this.stdinWriter = process.stdin.getWriter();
    this.externalSignal = opts.signal;

    // External abort → SIGTERM. Registered only when a signal is provided so
    // clients without a signal incur no listener overhead.
    if (opts.signal) {
      if (opts.signal.aborted) {
        this.abort(abortReason(opts.signal));
      } else {
        this.onExternalAbort = () => this.abort(abortReason(opts.signal));
        opts.signal.addEventListener("abort", this.onExternalAbort, {
          once: true,
        });
      }
    }

    const stdoutPump = this.pumpStdout();
    const stderrPump = this.pumpStderr(opts.onStderr);

    // Capture `process` locally — TypeScript's flow analysis doesn't trust
    // `this.process` inside the async closure until construction completes.
    const proc = process;
    this.done = (async (): Promise<CodexAppServerStatus> => {
      try {
        const [status] = await Promise.all([
          proc.status,
          stdoutPump,
          stderrPump,
        ]);
        await this.forceCloseStdin();
        // Reject any still-pending requests — the stream is gone, they can
        // never resolve on their own.
        const streamGoneErr = new Error(
          "codex app-server subprocess exited before response",
        );
        for (const pending of this.pending.values()) {
          pending.reject(streamGoneErr);
        }
        this.pending.clear();
        this.notificationQueue.close();
        return {
          exitCode: status.code,
          signal: status.signal ?? null,
          stderr: decodeConcat(this.stderrChunks),
        };
      } finally {
        if (this.externalSignal && this.onExternalAbort) {
          this.externalSignal.removeEventListener(
            "abort",
            this.onExternalAbort,
          );
        }
        unregister(proc);
      }
    })();
  }

  /**
   * Spawn `codex app-server --listen stdio://` and return a ready client.
   *
   * The caller owns {@link close} / {@link abort} for shutdown. The client
   * is registered with the project's {@link import("../process-registry.ts")
   * process registry} so SIGINT shutdown reaps it automatically.
   */
  static spawn(
    opts: CodexAppServerClientOptions = {},
  ): CodexAppServerClient {
    const extra = opts.extraArgs ?? [];
    for (const reserved of CODEX_APP_SERVER_RESERVED_FLAGS) {
      if (extra.includes(reserved)) {
        throw new Error(
          `extraArgs may not include reserved flag "${reserved}"`,
        );
      }
    }
    const args = ["app-server", ...extra, "--listen", "stdio://"];
    const cmd = new Deno.Command(opts.binary ?? "codex", {
      args,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
    const process = cmd.spawn();
    register(process);
    return new CodexAppServerClient(process, opts);
  }

  /**
   * Async iterable of inbound server notifications (messages without an
   * `id`). Completes when the subprocess stdout closes. Can be iterated at
   * most once.
   */
  get notifications(): AsyncIterable<CodexAppServerNotification> {
    return this.notificationQueue;
  }

  /**
   * Issue a JSON-RPC request and wait for the matching response.
   *
   * Resolves with the `result` field on success, rejects with
   * {@link CodexAppServerError} on an error response, or a generic Error
   * when the stream closes before a response arrives.
   */
  request<T = unknown>(
    method: string,
    params: Record<string, unknown> | undefined = undefined,
  ): Promise<T> {
    if (this.aborted) {
      return Promise.reject(new Error("codex app-server: aborted"));
    }
    if (this.stdinClosed) {
      return Promise.reject(new Error("codex app-server: stdin closed"));
    }
    const id = this.nextId++;
    const message: Record<string, unknown> = {
      jsonrpc: "2.0",
      id,
      method,
    };
    if (params !== undefined) message.params = params;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        method,
        resolve: (v) => resolve(v as T),
        reject,
      });
      const line = JSON.stringify(message) + "\n";
      this.stdinWriter.write(this.encoder.encode(line)).catch((err) => {
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   *
   * Used for `initialized` and any future notification-style methods the
   * protocol adds.
   */
  async notify(
    method: string,
    params: Record<string, unknown> | undefined = undefined,
  ): Promise<void> {
    if (this.aborted) {
      throw new Error("codex app-server: aborted");
    }
    if (this.stdinClosed) {
      throw new Error("codex app-server: stdin closed");
    }
    const message: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    const line = JSON.stringify(message) + "\n";
    await this.stdinWriter.write(this.encoder.encode(line));
  }

  /**
   * Gracefully close the session: EOF stdin and await the subprocess exit.
   *
   * Pending requests that haven't been answered by the time the stream
   * closes will reject — callers should complete their request/response
   * handshake before invoking {@link close}.
   */
  async close(): Promise<CodexAppServerStatus> {
    await this.forceCloseStdin();
    return await this.done;
  }

  /**
   * Send SIGTERM to the subprocess. Idempotent. Pending requests reject
   * once stdout closes.
   */
  abort(_reason?: string): void {
    if (this.aborted) return;
    this.aborted = true;
    // Fire-and-forget: the stdin pipe may already be broken after SIGTERM.
    this.forceCloseStdin().catch(() => {});
    try {
      this.process.kill("SIGTERM");
    } catch {
      // Process may have already exited.
    }
  }

  /**
   * Close the stdin writer. Idempotent; safe to call from either the
   * graceful path (`close()`) or the abort path. Silently swallows errors
   * when the writer has already errored (common after SIGTERM broke the
   * pipe).
   */
  private async forceCloseStdin(): Promise<void> {
    if (this.stdinClosed) return;
    this.stdinClosed = true;
    try {
      await this.stdinWriter.close();
    } catch {
      try {
        await this.stdinWriter.abort();
      } catch {
        // Writer already errored — nothing to do.
      }
    }
  }

  /**
   * Drain the subprocess stdout stream, splitting on newlines and
   * dispatching each non-empty line through {@link handleLine}. Completes
   * when the stream closes or the reader errors.
   */
  private async pumpStdout(): Promise<void> {
    const decoder = new TextDecoder();
    const reader = this.process.stdout.getReader();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          this.handleLine(line);
        }
      }
      if (buffer.trim()) this.handleLine(buffer);
    } catch {
      // Reader closed — finalization runs in the `done` promise.
    }
  }

  /**
   * Parse a single newline-delimited JSON-RPC frame. Messages with a
   * numeric `id` resolve/reject the matching pending request; messages
   * without one are enqueued as server notifications. Malformed lines are
   * dropped rather than tearing down the stream.
   */
  private handleLine(line: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Skip malformed lines rather than tear down the stream.
      return;
    }
    const id = parsed.id;
    if (typeof id === "number") {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (parsed.error !== undefined) {
        const err = parsed.error as CodexAppServerRpcError;
        pending.reject(new CodexAppServerError(pending.method, err));
      } else {
        pending.resolve(parsed.result);
      }
      return;
    }
    const method = parsed.method;
    if (typeof method === "string") {
      const params = (parsed.params as Record<string, unknown> | undefined) ??
        {};
      this.notificationQueue.push({ method, params });
    }
  }

  /**
   * Drain the subprocess stderr stream. Collected chunks are surfaced in
   * {@link CodexAppServerStatus.stderr}; decoded per-chunk strings are
   * forwarded to the optional `onStderr` callback.
   */
  private async pumpStderr(
    onStderr?: (chunk: string) => void,
  ): Promise<void> {
    const decoder = new TextDecoder();
    const reader = this.process.stderr.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.stderrChunks.push(value);
        if (onStderr) {
          try {
            onStderr(decoder.decode(value, { stream: true }));
          } catch {
            // swallow consumer errors
          }
        }
      }
    } catch {
      // stream closed
    }
  }
}

/**
 * Unbounded FIFO queue backing {@link CodexAppServerClient.notifications}.
 * Async iterator blocks on `next()` until a notification arrives or the
 * queue is closed. Can be iterated at most once; re-iteration throws.
 */
class NotificationQueue implements AsyncIterable<CodexAppServerNotification> {
  private items: CodexAppServerNotification[] = [];
  private resolvers: Array<
    (r: IteratorResult<CodexAppServerNotification>) => void
  > = [];
  private closed = false;
  private iterated = false;

  push(event: CodexAppServerNotification): void {
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

  [Symbol.asyncIterator](): AsyncIterator<CodexAppServerNotification> {
    if (this.iterated) {
      throw new Error(
        "CodexAppServerClient.notifications can only be iterated once",
      );
    }
    this.iterated = true;
    return {
      next: (): Promise<IteratorResult<CodexAppServerNotification>> => {
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
      return: (): Promise<IteratorResult<CodexAppServerNotification>> => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

function decodeConcat(chunks: Uint8Array[]): string {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(buf).trim();
}

function abortReason(signal?: AbortSignal): string {
  if (!signal) return "manual abort";
  const reason = signal.reason;
  if (reason === undefined) return "manual abort";
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) return reason.message;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}
