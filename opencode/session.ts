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

import type { ProcessRegistry } from "../process-registry.ts";
import { SessionEventQueue } from "../runtime/event-queue.ts";
import {
  SessionAbortedError,
  SessionDeliveryError,
  SessionInputClosedError,
} from "../runtime/types.ts";
import {
  type OnCallbackError,
  safeInvokeCallback,
} from "../runtime/callback-safety.ts";
import { withSyncedPWD } from "../runtime/env-cwd-sync.ts";
import type { ReasoningEffort } from "../runtime/reasoning-effort.ts";
import {
  buildOpenCodeConfigContent,
  type McpServers,
  validateMcpServers,
} from "../runtime/mcp-injection.ts";
import {
  decodeConcat,
  extractOpenCodeSessionId,
  type OpenCodeSessionEvent,
  parseOpenCodeSseFrame,
  pickFreePort,
} from "./sse.ts";

// Re-export the SSE parsing surface for back-compat. Tests and downstream
// consumers continue to import these from `./session.ts`.
export {
  extractOpenCodeSessionId,
  type OpenCodeSessionEvent,
  parseOpenCodeSseFrame,
};

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
  /**
   * Abstract reasoning-effort depth. Forwarded verbatim as `body.variant`
   * on every `POST /session/:id/prompt_async`. Provider-specific
   * interpretation may differ from the requested depth — see FR-L25.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Per-session MCP server registration (FR-L35). Serialized into the
   * `OPENCODE_CONFIG_CONTENT` env var of the spawned `opencode serve`
   * subprocess. Replacement, not merge: overrides the user's full
   * OpenCode config for the lifetime of the session.
   */
  mcpServers?: McpServers;
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
   * Routed error sink for `onEvent` / `onStderr` throws. Default handler
   * logs to `console.warn`; supply a no-op to opt out. SSE pump stays
   * alive regardless. See FR-L32.
   */
  onCallbackError?: OnCallbackError;
  /**
   * Explicit TCP port for `opencode serve --port`. When omitted, a free port
   * is picked via an ephemeral `Deno.listen({ port: 0 })`.
   */
  port?: number;
  /** Bind hostname. Defaults to `127.0.0.1`. */
  hostname?: string;
  /**
   * Optional process registry that owns this session's `opencode serve`
   * subprocess. When omitted, the module-level default registry is used,
   * preserving backward compatibility. Embedders that host multiple
   * independent runtimes in one process should pass an instance-scoped
   * {@link ProcessRegistry} so `killAll` is scoped to the embedder.
   */
  processRegistry: ProcessRegistry;
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
   * receipt (HTTP 204). Rejects with {@link SessionInputClosedError} after
   * {@link endInput}, {@link SessionAbortedError} after {@link abort}, or
   * {@link SessionDeliveryError} when the HTTP call returns a non-2xx
   * status or the network fetch itself fails.
   */
  send(content: string): Promise<void>;
  /**
   * Async iterator of session-scoped events (filtered by sessionID). Global
   * events (server.connected, non-session state changes) are delivered via
   * {@link OpenCodeSessionOptions.onEvent} but NOT pushed to this queue.
   * **One-shot** — typed as `AsyncIterableIterator` to surface a TypeScript
   * error on accidental re-iteration, with the runtime guard in
   * {@link import("../runtime/event-queue.ts").SessionEventQueue} as a
   * belt-and-suspenders fallback.
   */
  readonly events: AsyncIterableIterator<OpenCodeSessionEvent>;
  /**
   * Signal no more sends will arrive. Returns promptly. A background task
   * waits for the next session-scoped `session.idle` event and SIGTERMs the
   * server; the full shutdown is observable via {@link done}. Idempotent.
   * For stricter timing, combine with {@link OpenCodeSessionOptions.signal}
   * or call {@link abort} directly.
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

  // FR-L35: validate and inject the OPENCODE_CONFIG_CONTENT env before
  // spawning the server. Collision with non-empty pre-existing
  // OPENCODE_CONFIG_CONTENT throws synchronously.
  validateMcpServers("opencode", {
    mcpServers: opts.mcpServers,
    env: opts.env,
  });
  const env: Record<string, string> = { ...(opts.env ?? {}) };
  if (opts.mcpServers) {
    env.OPENCODE_CONFIG_CONTENT = buildOpenCodeConfigContent(opts.mcpServers);
  }

  // FR-L33: sync env.PWD with cwd at the spawn boundary.
  const syncedEnv = withSyncedPWD(env, opts.cwd) ?? env;
  const cmd = new Deno.Command("opencode", {
    args: ["serve", "--hostname", hostname, "--port", String(port)],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    env: syncedEnv,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });

  const process = cmd.spawn();
  const registry = opts.processRegistry;
  registry.register(process);

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
          // FR-L32: route consumer-callback throws to onCallbackError.
          safeInvokeCallback(
            opts.onStderr,
            [line],
            "onStderr",
            opts.onCallbackError,
          );
        }
      }
      if (buffer.length > 0) {
        // FR-L32: same routing for the trailing partial line.
        safeInvokeCallback(
          opts.onStderr,
          [buffer],
          "onStderr",
          opts.onCallbackError,
        );
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
    registry.unregister(process);
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
      registry.unregister(process);
      throw new Error(`POST /session failed: ${res.status} ${text}`);
    }
    const body = await res.json() as { id?: unknown };
    if (typeof body.id !== "string") {
      doKill();
      registry.unregister(process);
      throw new Error("POST /session returned no id");
    }
    sessionId = body.id;
  }

  const queue = new SessionEventQueue<OpenCodeSessionEvent>(
    "OpenCodeSession",
  );
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
    // Track busy → idle transitions so we can emit exactly one synthetic
    // turn-end per completed turn, regardless of which of the two
    // idle-signalling events the server sent. `wasBusy` guards against
    // initial idle bursts and duplicate idles on the same transition.
    let becameIdle = false;
    if (eventSessionId === sessionId) {
      if (event.type === "session.status") {
        const status = (event.properties?.status as Record<string, unknown>)
          ?.type;
        if (status === "busy") isIdle = false;
        else if (status === "idle" && !isIdle) {
          isIdle = true;
          becameIdle = true;
        }
      } else if (event.type === "session.idle" && !isIdle) {
        isIdle = true;
        becameIdle = true;
      }
    }
    // FR-L32: route consumer-callback throws to onCallbackError.
    safeInvokeCallback(
      opts.onEvent,
      [event],
      "onEvent",
      opts.onCallbackError,
    );
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(event)) {
        const w = waiters[i];
        waiters.splice(i, 1);
        w.resolve();
      }
    }
    if (becameIdle) {
      const synthetic: OpenCodeSessionEvent = {
        type: "turn-end",
        properties: event.properties,
        raw: event.raw,
        synthetic: true,
      };
      queue.push(synthetic);
      // FR-L32: same routing for the synthetic turn-end event.
      safeInvokeCallback(
        opts.onEvent,
        [synthetic],
        "onEvent",
        opts.onCallbackError,
      );
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
    if (aborted) throw new SessionAbortedError("opencode");
    if (inputClosed) throw new SessionInputClosedError("opencode");
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
    // FR-L25: abstract reasoning effort → OpenCode `body.variant`.
    if (opts.reasoningEffort) body.variant = opts.reasoningEffort;
    hasSentAny = true;
    lastSendAt = Date.now();
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/session/${sessionId}/prompt_async`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new SessionDeliveryError(
        "opencode",
        `opencode prompt_async fetch failed: ${(err as Error).message}`,
        { cause: err },
      );
    }
    if (res.status !== 204 && !res.ok) {
      const text = await res.text().catch(() => "");
      throw new SessionDeliveryError(
        "opencode",
        `opencode prompt_async failed: ${res.status} ${text}`,
      );
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

  async function waitForIdleAndTeardown(): Promise<void> {
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
    while (!isIdle && !aborted) {
      await waitForNext((e) =>
        (e.type === "session.idle" ||
          (e.type === "session.status" &&
            (e.properties?.status as Record<string, unknown>)?.type ===
              "idle")) &&
        extractOpenCodeSessionId(e) === sessionId
      );
    }
    if (!aborted) {
      sseController.abort();
      doKill();
    }
  }

  function endInput(): Promise<void> {
    if (aborted) return Promise.resolve();
    if (inputClosed) return Promise.resolve();
    inputClosed = true;
    // Signal-only: schedule the wait-idle-then-SIGTERM in the background.
    // Full-shutdown observation lives on `session.done`.
    waitForIdleAndTeardown().catch(() => {
      // best-effort — abort() path will tear the server down.
    });
    return Promise.resolve();
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
      registry.unregister(process);
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
