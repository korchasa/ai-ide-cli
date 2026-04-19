/**
 * @module
 * Streaming-input OpenCode session: spawns `opencode serve`, creates (or
 * resumes) a session via HTTP, consumes the server's SSE event stream, and
 * lets the caller push additional user messages into the live session via
 * {@link OpenCodeSession.send} while observing
 * {@link OpenCodeSessionEvent}s in real time.
 *
 * This is the OpenCode counterpart to the one-shot {@link invokeOpenCodeCli}
 * in `opencode/process.ts`. Unlike `opencode run` (which is a one-shot CLI
 * invocation with no stdin), the server exposes long-lived sessions: client
 * calls `POST /session/:id/prompt_async` to enqueue a user turn and consumes
 * `session.status` / `session.idle` events to know when the agent is done.
 *
 * Transport reference: https://opencode.ai/docs/server/
 *
 * Entry point: {@link openOpenCodeSession}.
 */

import { register, unregister } from "../process-registry.ts";

/** Parsed SSE event from the OpenCode server's `/event` endpoint. */
export interface OpenCodeSessionEvent {
  /** Native event discriminator (e.g. `"message.part.delta"`, `"session.idle"`). */
  type: string;
  /** Event `properties` object from the raw payload (may be absent). */
  properties?: Record<string, unknown>;
  /** Raw event object as parsed from the SSE `data:` line. */
  raw: Record<string, unknown>;
}

/** Options for {@link openOpenCodeSession}. */
export interface OpenCodeSessionOptions {
  /** Agent name forwarded as `agent` in each prompt body. */
  agent?: string;
  /** System prompt forwarded as `system` in each prompt body. */
  systemPrompt?: string;
  /**
   * Model identifier forwarded as `model` in each prompt body.
   * Plain string (e.g. `"glm-5"`) passes through verbatim; a
   * `"<providerID>/<modelID>"` value is split into `{providerID, modelID}`.
   */
  model?: string;
  /** Resume an existing session ID instead of creating a new one via `POST /session`. */
  resumeSessionId?: string;
  /** Working directory for the `opencode serve` subprocess. */
  cwd?: string;
  /** Extra env merged into the subprocess env. */
  env?: Record<string, string>;
  /**
   * External abort signal. On abort, `POST /session/:id/abort` is issued
   * (best-effort) and the server subprocess is SIGTERMed; `done` resolves.
   */
  signal?: AbortSignal;
  /** Fires for every parsed SSE event (both session-scoped and global). */
  onEvent?: (event: OpenCodeSessionEvent) => void;
  /** Fires for every decoded stderr line (trimmed, may be empty). */
  onStderr?: (line: string) => void;
  /**
   * Explicit TCP port for `opencode serve --port`. When omitted, a free port
   * is picked via an ephemeral `Deno.listen({ port: 0 })`.
   */
  port?: number;
  /** Bind hostname. Defaults to `127.0.0.1`. */
  hostname?: string;
}

/** Terminal state of the OpenCode server subprocess. */
export interface OpenCodeSessionStatus {
  /** OS exit code when exited normally, `null` when killed by signal. */
  exitCode: number | null;
  /** Termination signal name when killed by signal, `null` otherwise. */
  signal: Deno.Signal | null;
  /** Aggregated stderr text captured during the session. */
  stderr: string;
}

/**
 * Live handle for an OpenCode session backed by a dedicated `opencode serve`
 * subprocess.
 *
 * Lifecycle: spawn server → POST /session → SSE /event → zero or more
 * {@link send} / {@link events} iterations → {@link endInput} (graceful close
 * after next `session.idle`) or {@link abort} (POST /abort + SIGTERM) → `done`
 * resolves.
 */
export interface OpenCodeSession {
  /** OS process ID of the spawned `opencode serve` subprocess. */
  readonly pid: number;
  /** Session ID assigned by the OpenCode server (`ses_…`). */
  readonly sessionId: string;
  /** Base URL of the spawned server (`http://host:port`). */
  readonly baseUrl: string;
  /**
   * Push an additional user message by posting
   * `POST /session/:id/prompt_async`. Resolves once the server acknowledges
   * receipt (HTTP 204). Throws if the session has been aborted.
   */
  send(content: string): Promise<void>;
  /**
   * Async iterable of session-scoped events (filtered by sessionID). Global
   * events (server.connected, non-session state changes) are delivered via
   * {@link OpenCodeSessionOptions.onEvent} but NOT pushed to this queue.
   * Can be iterated at most once.
   */
  readonly events: AsyncIterable<OpenCodeSessionEvent>;
  /**
   * Wait for the session to become idle (when a send is in flight) and then
   * SIGTERM the server. Idempotent. Blocks indefinitely if the agent never
   * reaches `session.idle`; callers with stricter timing should use
   * {@link OpenCodeSessionOptions.signal} or {@link abort}.
   */
  endInput(): Promise<void>;
  /**
   * Best-effort `POST /session/:id/abort`, then SIGTERM the server.
   * Idempotent. Subsequent {@link send} calls throw.
   */
  abort(reason?: string): void;
  /** Resolves with terminal status when the server subprocess exits. */
  readonly done: Promise<OpenCodeSessionStatus>;
}

/**
 * Spawn a dedicated `opencode serve` subprocess and open a long-lived session
 * against it.
 *
 * The returned handle stays alive until the caller closes it (via
 * {@link OpenCodeSession.endInput} or {@link OpenCodeSession.abort}), the
 * external {@link OpenCodeSessionOptions.signal} fires, or the server exits
 * on its own. Each call spawns its own server instance — sessions do not
 * share subprocesses.
 */
export async function openOpenCodeSession(
  opts: OpenCodeSessionOptions,
): Promise<OpenCodeSession> {
  const hostname = opts.hostname ?? "127.0.0.1";
  const port = opts.port ?? await pickFreePort(hostname);
  const baseUrl = `http://${hostname}:${port}`;

  const env: Record<string, string> = { ...(opts.env ?? {}) };

  const cmd = new Deno.Command("opencode", {
    args: ["serve", "--hostname", hostname, "--port", String(port)],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    env,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });

  const process = cmd.spawn();
  register(process);

  let readyResolve: (() => void) | null = null;
  let readyReject: ((e: Error) => void) | null = null;
  const ready = new Promise<void>((res, rej) => {
    readyResolve = res;
    readyReject = rej;
  });

  const stdoutPump = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    const reader = process.stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (readyResolve !== null && line.includes("listening on ")) {
            const r: () => void = readyResolve;
            readyResolve = null;
            readyReject = null;
            r();
          }
        }
      }
      if (buffer.includes("listening on ") && readyResolve !== null) {
        const r: () => void = readyResolve;
        readyResolve = null;
        readyReject = null;
        r();
      }
    } catch {
      // Stream closed mid-read — ready latch finalizer runs below.
    } finally {
      if (readyReject) {
        readyReject(new Error("opencode serve stdout closed before ready"));
        readyReject = null;
      }
    }
  })();

  const stderrChunks: Uint8Array[] = [];
  const stderrPump = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    const reader = process.stderr.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stderrChunks.push(value);
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          try {
            opts.onStderr?.(line);
          } catch {
            // ignore
          }
        }
      }
      if (buffer.length > 0) {
        try {
          opts.onStderr?.(buffer);
        } catch {
          // ignore
        }
      }
    } catch {
      // stream closed
    }
  })();

  let aborted = false;
  const doKill = () => {
    try {
      process.kill("SIGTERM");
    } catch {
      // Process may have already exited.
    }
  };
  const onExternalAbort = () => {
    aborted = true;
    doKill();
  };
  if (opts.signal) {
    if (opts.signal.aborted) {
      onExternalAbort();
    } else {
      opts.signal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  try {
    await Promise.race([
      ready,
      process.status.then((status) => {
        throw new Error(
          `opencode serve exited before ready (code=${status.code})`,
        );
      }),
    ]);
  } catch (err) {
    unregister(process);
    throw err;
  }

  let sessionId: string;
  if (opts.resumeSessionId) {
    sessionId = opts.resumeSessionId;
  } else {
    const res = await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      doKill();
      unregister(process);
      throw new Error(`POST /session failed: ${res.status} ${text}`);
    }
    const body = await res.json() as { id?: unknown };
    if (typeof body.id !== "string") {
      doKill();
      unregister(process);
      throw new Error("POST /session returned no id");
    }
    sessionId = body.id;
  }

  const queue = new EventQueue();
  const waiters: Array<{
    predicate: (e: OpenCodeSessionEvent) => boolean;
    resolve: () => void;
  }> = [];
  let isIdle = true;
  let hasSentAny = false;
  let lastSendAt = 0;
  let inputClosed = false;

  function dispatch(event: OpenCodeSessionEvent): void {
    const eventSessionId = extractOpenCodeSessionId(event);
    if (!eventSessionId || eventSessionId === sessionId) {
      queue.push(event);
    }
    if (eventSessionId === sessionId) {
      if (event.type === "session.status") {
        const status = (event.properties?.status as Record<string, unknown>)
          ?.type;
        if (status === "busy") isIdle = false;
        else if (status === "idle") isIdle = true;
      } else if (event.type === "session.idle") {
        isIdle = true;
      }
    }
    try {
      opts.onEvent?.(event);
    } catch {
      // onEvent is a notification hook; swallow consumer errors.
    }
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(event)) {
        const w = waiters[i];
        waiters.splice(i, 1);
        w.resolve();
      }
    }
  }

  function waitForNext(
    predicate: (e: OpenCodeSessionEvent) => boolean,
  ): Promise<void> {
    return new Promise((resolve) => {
      waiters.push({ predicate, resolve });
    });
  }

  const sseController = new AbortController();
  const ssePump = (async () => {
    try {
      const res = await fetch(`${baseUrl}/event`, {
        headers: { Accept: "text/event-stream" },
        signal: sseController.signal,
      });
      if (!res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sepIdx: number;
          while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
            const chunk = buffer.slice(0, sepIdx);
            buffer = buffer.slice(sepIdx + 2);
            const event = parseOpenCodeSseFrame(chunk);
            if (event) dispatch(event);
          }
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // already released
        }
      }
    } catch {
      // SSE aborted or server closed — normal on shutdown.
    } finally {
      queue.close();
      for (const w of waiters.splice(0)) {
        w.resolve();
      }
    }
  })();

  async function send(content: string): Promise<void> {
    if (aborted) throw new Error("OpenCodeSession: aborted");
    if (inputClosed) throw new Error("OpenCodeSession: input already closed");
    const body: Record<string, unknown> = {
      parts: [{ type: "text", text: content }],
    };
    if (opts.agent) body.agent = opts.agent;
    if (opts.systemPrompt) body.system = opts.systemPrompt;
    if (opts.model) {
      const slash = opts.model.indexOf("/");
      body.model = slash > 0
        ? {
          providerID: opts.model.slice(0, slash),
          modelID: opts.model.slice(slash + 1),
        }
        : opts.model;
    }
    hasSentAny = true;
    lastSendAt = Date.now();
    const res = await fetch(`${baseUrl}/session/${sessionId}/prompt_async`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status !== 204 && !res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`prompt_async failed: ${res.status} ${text}`);
    }
    // Drain body on non-204 success to avoid leaked HTTP1 connections.
    if (res.status !== 204) {
      try {
        await res.arrayBuffer();
      } catch {
        // ignore
      }
    }
  }

  async function endInput(): Promise<void> {
    if (aborted) return;
    if (inputClosed) return;
    inputClosed = true;
    // If a send was just issued, the `session.status busy` event may not
    // have arrived yet. Wait for it (or idle) before relying on `isIdle`.
    if (hasSentAny && Date.now() - lastSendAt < 500) {
      await Promise.race([
        waitForNext((e) =>
          (e.type === "session.status" || e.type === "session.idle") &&
          extractOpenCodeSessionId(e) === sessionId
        ),
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ]);
    }
    while (!isIdle) {
      await waitForNext((e) =>
        (e.type === "session.idle" ||
          (e.type === "session.status" &&
            (e.properties?.status as Record<string, unknown>)?.type ===
              "idle")) &&
        extractOpenCodeSessionId(e) === sessionId
      );
    }
    sseController.abort();
    doKill();
  }

  function abort(_reason?: string): void {
    if (aborted) return;
    aborted = true;
    // Fire-and-forget: SIGTERM below tears the server down even if the HTTP
    // call doesn't complete.
    fetch(`${baseUrl}/session/${sessionId}/abort`, { method: "POST" }).then(
      (r) => {
        r.body?.cancel().catch(() => {});
      },
    ).catch(() => {});
    sseController.abort();
    doKill();
  }

  const done = (async (): Promise<OpenCodeSessionStatus> => {
    try {
      const [status] = await Promise.all([
        process.status,
        stdoutPump,
        stderrPump,
        ssePump,
      ]);
      const stderr = decodeConcat(stderrChunks);
      return {
        exitCode: status.code,
        signal: status.signal ?? null,
        stderr,
      };
    } finally {
      if (opts.signal) {
        opts.signal.removeEventListener("abort", onExternalAbort);
      }
      unregister(process);
    }
  })();

  return {
    pid: process.pid,
    sessionId,
    baseUrl,
    send,
    events: queue,
    endInput,
    abort,
    done,
  };
}

/**
 * Extract the session ID from a parsed OpenCode SSE event. Looks in the
 * top-level `properties.sessionID`, then nested `properties.part.sessionID`
 * and `properties.info.sessionID` where the server places it for
 * `message.part.*` / `message.updated` variants.
 *
 * Exported for unit testing.
 */
export function extractOpenCodeSessionId(
  event: OpenCodeSessionEvent,
): string | undefined {
  const s = event.properties?.sessionID;
  if (typeof s === "string") return s;
  const part = event.properties?.part;
  if (part && typeof part === "object" && "sessionID" in part) {
    const ps = (part as Record<string, unknown>).sessionID;
    if (typeof ps === "string") return ps;
  }
  const info = event.properties?.info;
  if (info && typeof info === "object" && "sessionID" in info) {
    const is = (info as Record<string, unknown>).sessionID;
    if (typeof is === "string") return is;
  }
  return undefined;
}

/**
 * Parse one SSE frame (the text between two `\n\n` separators) into an
 * {@link OpenCodeSessionEvent}. Returns `undefined` for comment-only frames,
 * frames without a `data:` line, or frames whose `data:` payload fails to
 * `JSON.parse`.
 *
 * Exported for unit testing.
 */
export function parseOpenCodeSseFrame(
  frame: string,
): OpenCodeSessionEvent | undefined {
  const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
  if (!dataLine) return undefined;
  const json = dataLine.slice(5).trim();
  if (!json) return undefined;
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    const typeField = typeof raw.type === "string" ? raw.type : "unknown";
    const propsField = raw.properties && typeof raw.properties === "object"
      ? raw.properties as Record<string, unknown>
      : undefined;
    return { type: typeField, properties: propsField, raw };
  } catch {
    return undefined;
  }
}

async function pickFreePort(hostname: string): Promise<number> {
  const listener = Deno.listen({ port: 0, transport: "tcp", hostname });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  // Yield once so the kernel marks the port reusable before the subprocess
  // binds it.
  await Promise.resolve();
  return port;
}

/**
 * Unbounded FIFO queue backing {@link OpenCodeSession.events}. Mirrors the
 * pattern used by {@link import("../claude/session").openClaudeSession}'s
 * event queue: async iterator blocks on `next()` until a new event arrives or
 * the queue is closed. Can be iterated at most once; re-iteration throws.
 */
class EventQueue implements AsyncIterable<OpenCodeSessionEvent> {
  private items: OpenCodeSessionEvent[] = [];
  private resolvers: Array<(r: IteratorResult<OpenCodeSessionEvent>) => void> =
    [];
  private closed = false;
  private iterated = false;

  push(event: OpenCodeSessionEvent): void {
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

  [Symbol.asyncIterator](): AsyncIterator<OpenCodeSessionEvent> {
    if (this.iterated) {
      throw new Error("OpenCodeSession.events can only be iterated once");
    }
    this.iterated = true;
    return {
      next: (): Promise<IteratorResult<OpenCodeSessionEvent>> => {
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
      return: (): Promise<IteratorResult<OpenCodeSessionEvent>> => {
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
