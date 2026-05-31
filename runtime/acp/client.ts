/**
 * @module
 * Minimal Deno-native JSON-RPC 2.0 client over newline-delimited stdio.
 *
 * Tailored to the Agent Client Protocol (https://agentclientprotocol.com)
 * but free of ACP-specific shapes: it ships `request`, `notify`, and a
 * single async iterable of inbound notifications. The ACP-specific layer
 * (`mapping.ts`, `adapter.ts`) builds typed wrappers on top.
 *
 * Wire convention used by ACP and the JSON-RPC 2.0 spec extension for
 * stdio transports: one JSON object per line on stdout / stdin, with logs
 * routed to stderr. The client therefore frames using `\n` and rejects
 * any line that does not parse as JSON.
 */

import type { ProcessRegistry } from "../../process-registry.ts";
import { withSyncedPWD } from "../env-cwd-sync.ts";

/** Inbound notification (server → client, no `id`). */
export interface AcpClientNotification {
  /** Method name (e.g. `session/update`, `session/request_permission`). */
  method: string;
  /** Method params; ACP uses object params exclusively. */
  params?: Record<string, unknown>;
}

/** Inbound bidirectional request (server → client, with `id`). */
export interface AcpClientRequest {
  /** JSON-RPC request id. */
  id: number | string;
  /** Method name. */
  method: string;
  /** Method params (object). */
  params?: Record<string, unknown>;
}

/** Discriminated union of inbound messages other than method responses. */
export type AcpClientInbound =
  | ({ kind: "notification" } & AcpClientNotification)
  | ({ kind: "request" } & AcpClientRequest);

/**
 * Handler invoked for inbound requests (e.g. `session/request_permission`).
 * Resolved value is sent back as `result`; throw to send `error`.
 */
export type AcpInboundRequestHandler = (
  req: AcpClientRequest,
) => Promise<unknown> | unknown;

/** Constructor options for {@link AcpStdioClient}. */
export interface AcpStdioClientOptions {
  /** Executable to spawn (e.g. `"npx"`). */
  cmd: string;
  /** CLI args (e.g. `["-y", "@agentclientprotocol/claude-agent-acp@0.39.0"]`). */
  args: readonly string[];
  /** Subprocess working directory. */
  cwd?: string;
  /** Extra env vars merged into the subprocess env. */
  env?: Record<string, string>;
  /** Process tracker. */
  processRegistry: ProcessRegistry;
  /**
   * Optional callback for every stderr line. Default behaviour silently
   * accumulates stderr for inclusion in `.dispose()` diagnostics.
   */
  onStderr?: (line: string) => void;
  /**
   * Inbound-request handler. Required when the agent advertises
   * capabilities that imply server→client calls (e.g.
   * `session/request_permission`). When omitted, every inbound request is
   * responded to with `{error: {code: -32601, message: "Method not found"}}`.
   */
  onRequest?: AcpInboundRequestHandler;
}

/**
 * Grace window between SIGTERM and SIGKILL in {@link AcpStdioClient.dispose}.
 * Matches the {@link ProcessRegistry} default so behavior is uniform across
 * both shutdown paths (FR-L39).
 */
const DISPOSE_GRACE_MS = 5000;

/**
 * Maximum wait for `writer.close()` before fallback to `writer.abort()`
 * in {@link AcpStdioClient.dispose}. `close()` blocks until the agent
 * drains stdin, which never happens when we tear down mid-prompt —
 * the race keeps shutdown bounded.
 */
const WRITER_CLOSE_GRACE_MS = 1000;

/** JSON-RPC error envelope as raised by `request()`. */
export class AcpRpcError extends Error {
  /** JSON-RPC error code. */
  readonly code: number;
  /** Method that produced the error. */
  readonly method: string;
  /** Method-specific error data, if any. */
  readonly data?: unknown;

  /**
   * Construct a typed JSON-RPC error.
   *
   * @param method Method that produced the error.
   * @param code JSON-RPC error code from the wire.
   * @param message Human-readable failure description.
   * @param data Optional error data payload.
   */
  constructor(method: string, code: number, message: string, data?: unknown) {
    super(`${method} → JSON-RPC error ${code}: ${message}`);
    this.name = "AcpRpcError";
    this.code = code;
    this.method = method;
    this.data = data;
  }
}

interface Deferred<T> {
  resolve(value: T): void;
  reject(reason: unknown): void;
}

/**
 * Hand-rolled JSON-RPC 2.0 stdio client. Owns the subprocess lifecycle and
 * routes responses to pending requests by id; remaining traffic surfaces
 * via `notifications`.
 */
export class AcpStdioClient {
  readonly #proc: Deno.ChildProcess;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #encoder = new TextEncoder();
  readonly #pending = new Map<number, Deferred<unknown>>();
  readonly #pendingMethods = new Map<number, string>();
  readonly #registry: ProcessRegistry;
  readonly #onRequest?: AcpInboundRequestHandler;
  readonly #onStderr?: (line: string) => void;
  #nextId = 1;
  #disposed = false;
  #notificationQueue: AcpClientNotification[] = [];
  #notificationWaiter:
    | ((v: IteratorResult<AcpClientNotification>) => void)
    | undefined;
  #notificationClosed = false;
  #stderrBuf = "";
  #stdoutDone: Promise<void>;
  #stderrDone: Promise<void>;
  #exitStatus: Promise<Deno.CommandStatus>;

  /**
   * Spawn the agent and start draining its stdout / stderr.
   *
   * @param opts Launcher configuration. See {@link AcpStdioClientOptions}.
   */
  constructor(opts: AcpStdioClientOptions) {
    this.#registry = opts.processRegistry;
    this.#onRequest = opts.onRequest;
    this.#onStderr = opts.onStderr;
    const baseEnv = { ...Deno.env.toObject(), ...(opts.env ?? {}) };
    const syncedEnv = withSyncedPWD(baseEnv, opts.cwd) ?? baseEnv;
    this.#proc = new Deno.Command(opts.cmd, {
      args: [...opts.args],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      env: syncedEnv,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    }).spawn();
    this.#registry.register(this.#proc);
    this.#writer = this.#proc.stdin.getWriter();
    this.#exitStatus = this.#proc.status;
    this.#stdoutDone = this.#drainStdout();
    this.#stderrDone = this.#drainStderr();
    // Surface unexpected child death by tearing down pending requests.
    this.#exitStatus.then((status) => {
      this.#closeNotifications();
      const reason = new Error(
        `ACP front exited (code=${status.code}, signal=${status.signal})`,
      );
      for (const [id, def] of this.#pending) {
        def.reject(reason);
        this.#pending.delete(id);
      }
    }).catch(() => {
      // status() never throws; swallow defensively for older runtimes.
    });
  }

  /** Send a JSON-RPC request and await its response. */
  request<TResult = unknown>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<TResult> {
    if (this.#disposed) {
      return Promise.reject(new Error("ACP client already disposed"));
    }
    const id = this.#nextId++;
    const envelope = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    const promise = new Promise<TResult>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: (v) => resolve(v as TResult),
        reject,
      });
      this.#pendingMethods.set(id, method);
    });
    this.#writeLine(envelope).catch((err) => {
      const def = this.#pending.get(id);
      this.#pending.delete(id);
      this.#pendingMethods.delete(id);
      def?.reject(err);
    });
    return promise;
  }

  /** Send a JSON-RPC notification (no response expected). */
  notify(method: string, params?: Record<string, unknown>): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    return this.#writeLine({
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    });
  }

  /**
   * Async iterable of inbound notifications (server → client, no id).
   * Single-consumer; subsequent iterators see an empty stream because the
   * underlying queue has already been drained.
   */
  notifications(): AsyncIterableIterator<AcpClientNotification> {
    const next = (): Promise<IteratorResult<AcpClientNotification>> => {
      if (this.#notificationQueue.length > 0) {
        const value = this.#notificationQueue.shift()!;
        return Promise.resolve({ value, done: false });
      }
      if (this.#notificationClosed) {
        return Promise.resolve({ value: undefined, done: true });
      }
      return new Promise((resolve) => {
        this.#notificationWaiter = resolve;
      });
    };
    const close = (): Promise<IteratorResult<AcpClientNotification>> => {
      this.#closeNotifications();
      return Promise.resolve({ value: undefined, done: true });
    };
    const iter: AsyncIterableIterator<AcpClientNotification> = {
      [Symbol.asyncIterator]() {
        return iter;
      },
      next,
      return: close,
    };
    return iter;
  }

  /** Resolves with the subprocess's terminal status. */
  get done(): Promise<Deno.CommandStatus> {
    return this.#exitStatus;
  }

  /** Cumulative stderr accumulated so far (for diagnostics). */
  get stderr(): string {
    return this.#stderrBuf;
  }

  /**
   * Notifications that have been parsed but not yet consumed by the
   * `notifications()` iterator. Used by the adapter to detect "has the
   * consumer caught up to everything on the wire?" after a synchronous
   * RPC response — see the drain-race fix in `invokeViaAcp` (FR-L39).
   */
  get pendingNotificationCount(): number {
    return this.#notificationQueue.length;
  }

  /** SIGTERM the agent and release resources. Idempotent. */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    // `writer.close()` awaits pending writes — if the agent hasn't
    // drained stdin (e.g. mid-LLM-call), it deadlocks. Race it against
    // a short timer and fall back to `writer.abort()` which discards
    // queued bytes without blocking. Observed against codex-acp@0.15.0
    // where `session/prompt` keeps the queue alive until the model
    // returns — disposing during reasoning would otherwise hang
    // forever.
    let writerTimerId: ReturnType<typeof setTimeout> | undefined;
    const writerTimer = new Promise<"timeout">((resolve) => {
      writerTimerId = setTimeout(
        () => resolve("timeout"),
        WRITER_CLOSE_GRACE_MS,
      );
    });
    const closeResult = await Promise.race([
      this.#writer.close().then(() => "closed" as const).catch(() =>
        "errored" as const
      ),
      writerTimer,
    ]);
    if (writerTimerId !== undefined) clearTimeout(writerTimerId);
    if (closeResult !== "closed") {
      try {
        await this.#writer.abort();
      } catch {
        // already broken
      }
    }
    try {
      this.#proc.kill("SIGTERM");
    } catch {
      // already exited
    }
    // SIGTERM-then-SIGKILL escalation. Some ACP fronts ignore SIGTERM
    // mid-prompt (codex-acp at 0.15.0 was observed to). Mirror the
    // pattern used in `ProcessRegistry.killAll` so a stuck front
    // cannot deadlock the calling adapter.
    const exit = this.#exitStatus.catch(() => undefined);
    let exitTimerId: ReturnType<typeof setTimeout> | undefined;
    const timer = new Promise<"timeout">((resolve) => {
      exitTimerId = setTimeout(() => resolve("timeout"), DISPOSE_GRACE_MS);
    });
    const winner = await Promise.race([exit, timer]);
    if (exitTimerId !== undefined) clearTimeout(exitTimerId);
    if (winner === "timeout") {
      try {
        this.#proc.kill("SIGKILL");
      } catch {
        // already exited
      }
      await this.#exitStatus.catch(() => undefined);
    }
    this.#registry.unregister(this.#proc);
    // Cancel the stdout/stderr readers explicitly: an `npx`-spawned
    // grandchild can keep the pipe open after SIGTERM (observed
    // against `npx -y @zed-industries/codex-acp@0.15.0`), and a hung
    // `for await` would keep the Deno event loop alive forever. We
    // also race against a short timer as a belt-and-braces fallback.
    try {
      await this.#proc.stdout.cancel().catch(() => {});
    } catch {
      // already released
    }
    try {
      await this.#proc.stderr.cancel().catch(() => {});
    } catch {
      // already released
    }
    let drainTimerId: ReturnType<typeof setTimeout> | undefined;
    const drainTimer = new Promise<"timeout">((resolve) => {
      drainTimerId = setTimeout(
        () => resolve("timeout"),
        WRITER_CLOSE_GRACE_MS,
      );
    });
    await Promise.race([
      Promise.all([
        this.#stdoutDone.catch(() => {}),
        this.#stderrDone.catch(() => {}),
      ]),
      drainTimer,
    ]);
    if (drainTimerId !== undefined) clearTimeout(drainTimerId);
    this.#closeNotifications();
  }

  // ---- internals ----------------------------------------------------

  async #writeLine(value: unknown): Promise<void> {
    const line = JSON.stringify(value) + "\n";
    await this.#writer.write(this.#encoder.encode(line));
  }

  async #drainStdout(): Promise<void> {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of this.#proc.stdout) {
      buf += decoder.decode(chunk, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const raw = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (raw.length === 0) continue;
        this.#handleLine(raw);
      }
    }
    buf += decoder.decode();
    const tail = buf.trim();
    if (tail.length > 0) this.#handleLine(tail);
  }

  async #drainStderr(): Promise<void> {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of this.#proc.stderr) {
      buf += decoder.decode(chunk, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        this.#stderrBuf += line + "\n";
        this.#onStderr?.(line);
      }
    }
    buf += decoder.decode();
    if (buf.length > 0) {
      this.#stderrBuf += buf;
      this.#onStderr?.(buf);
    }
  }

  #handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Non-JSON line on stdout — log-noise from a misbehaving front.
      // Route through stderr so consumers can still see it.
      this.#onStderr?.(`[acp:non-json-stdout] ${line}`);
      return;
    }
    if (typeof msg["id"] === "number" || typeof msg["id"] === "string") {
      if ("method" in msg && typeof msg["method"] === "string") {
        // Inbound request from agent.
        this.#handleInboundRequest(msg as unknown as AcpClientRequest);
        return;
      }
      // Response to one of our requests.
      this.#handleResponse(msg);
      return;
    }
    if ("method" in msg && typeof msg["method"] === "string") {
      const note: AcpClientNotification = {
        method: msg["method"],
        params: msg["params"] as Record<string, unknown> | undefined,
      };
      if (this.#notificationWaiter) {
        const waiter = this.#notificationWaiter;
        this.#notificationWaiter = undefined;
        waiter({ value: note, done: false });
      } else {
        this.#notificationQueue.push(note);
      }
    }
  }

  #handleResponse(msg: Record<string, unknown>): void {
    const id = msg["id"] as number;
    const def = this.#pending.get(id);
    const method = this.#pendingMethods.get(id) ?? "<unknown>";
    this.#pending.delete(id);
    this.#pendingMethods.delete(id);
    if (!def) return;
    if (msg["error"]) {
      const err = msg["error"] as Record<string, unknown>;
      def.reject(
        new AcpRpcError(
          method,
          typeof err["code"] === "number" ? err["code"] : -32000,
          typeof err["message"] === "string"
            ? err["message"]
            : "unknown JSON-RPC error",
          err["data"],
        ),
      );
      return;
    }
    def.resolve(msg["result"]);
  }

  #handleInboundRequest(req: AcpClientRequest): void {
    const handler = this.#onRequest;
    const respond = async () => {
      if (!handler) {
        await this.#writeLine({
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32601, message: `Method not found: ${req.method}` },
        });
        return;
      }
      try {
        const result = await handler(req);
        await this.#writeLine({
          jsonrpc: "2.0",
          id: req.id,
          result: result ?? null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.#writeLine({
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32000, message },
        });
      }
    };
    respond().catch(() => {
      // Writer broken; nothing meaningful to do.
    });
  }

  #closeNotifications(): void {
    this.#notificationClosed = true;
    const waiter = this.#notificationWaiter;
    if (waiter) {
      this.#notificationWaiter = undefined;
      waiter({ value: undefined, done: true });
    }
  }
}
