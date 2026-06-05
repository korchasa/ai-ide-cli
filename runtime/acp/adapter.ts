/**
 * @module
 * Runtime-neutral adapter that backs `transport: "acp"` for every
 * supported {@link RuntimeId}. One implementation, one wire protocol —
 * the runtime parameter only picks which ACP front to spawn.
 *
 * **Pilot status.** Claude, Codex, and OpenCode are `pilot: true` in
 * `runtime/acp/fronts.ts` and validated end-to-end by the
 * `e2e/acp_*_smoke_e2e_test.ts` suite. Cursor stays `pilot: false`
 * (needs local `cursor-agent` binary) and throws at invocation with a
 * clear "not piloted yet" message so a typo on the caller cannot
 * silently fall through to an un-tested code path. Consumers can
 * override the pilot guard per-call via `RuntimeInvokeOptions.acpFront`
 * (advanced usage — local forks, custom launchers, test stubs).
 */

import type { RuntimeId } from "../../types.ts";
import type {
  RuntimeInvokeOptions,
  RuntimeInvokeResult,
} from "../adapter-types.ts";
import type {
  RuntimeSession,
  RuntimeSessionEvent,
  RuntimeSessionOptions,
  RuntimeSessionStatus,
} from "../session-types.ts";
import {
  SessionAbortedError,
  SessionDeliveryError,
  SessionInputClosedError,
} from "../errors.ts";
import { safeAwaitCallback, safeInvokeCallback } from "../callback-safety.ts";
import { SessionEventQueue } from "../event-queue.ts";
import {
  analyzeRuntimeErrorSignal,
  type RuntimeErrorAnalysis,
} from "../runtime-error-analysis.ts";
import { AcpRpcError } from "./client.ts";
import type { AcpStdioClient } from "./client.ts";
import { extractAcpContent } from "./content.ts";
import { AcpUnsupportedOptionError } from "./errors.ts";
import { handshake, spawnClient } from "./handshake.ts";
import {
  type AcpDegradedOption,
  buildTurnEndEvent,
  collectDegradedOptions,
  collectUnsupportedOptions,
  mapSessionUpdate,
} from "./mapping.ts";
import { createPermissionHandler } from "./permissions.ts";

interface PromptResult {
  stopReason?: string;
}

function reportDegradedOptions(
  runtime: RuntimeId,
  degraded: AcpDegradedOption[],
  onCallbackError: RuntimeInvokeOptions["onCallbackError"],
): void {
  if (degraded.length === 0 || !onCallbackError) return;
  for (const d of degraded) {
    try {
      onCallbackError(
        new Error(
          `acp(${runtime}): option "${d.field}" degraded — ${d.reason}`,
        ),
        "onEvent",
      );
    } catch {
      // FR-L32: error sink itself must never break the streaming loop.
    }
  }
}

function buildPromptParams(
  sessionId: string,
  text: string,
): Record<string, unknown> {
  return {
    sessionId,
    prompt: [{ type: "text", text }],
  };
}

/**
 * Bounded best-effort drain — yields the event loop until the client's
 * parsed-but-not-yet-consumed notification queue is empty for two
 * consecutive ticks (so a chunk that arrives mid-yield gets a chance
 * to land before we declare drained). Capped by both a tick count and
 * a wall-clock ceiling so a misbehaving front cannot stall the
 * adapter indefinitely.
 */
async function flushDrain(client: AcpStdioClient): Promise<void> {
  const TICK_MS = 5;
  const MAX_TICKS = 20;
  const MAX_WALL_MS = 250;
  const deadline = performance.now() + MAX_WALL_MS;
  let emptyStreak = 0;
  for (let i = 0; i < MAX_TICKS; i++) {
    if (performance.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, TICK_MS));
    if (client.pendingNotificationCount === 0) {
      emptyStreak += 1;
      if (emptyStreak >= 2) return;
    } else {
      emptyStreak = 0;
    }
  }
}

/**
 * FR-L37: map an ACP `PromptResponse.stopReason` to a structured
 * runtime-error analysis. Pure — never throws, never reads from the wire.
 *
 * - `end_turn` / `cancelled` → `undefined` (no failure / consumer-initiated).
 * - `max_tokens` → token-budget classification (via the shared analyzer
 *   so the message normalisation stays consistent with CLI surfaces).
 * - `max_turn_requests` → synthesised `runtime_error` (no neutral analog
 *   in `RuntimeErrorKind`; medium confidence).
 * - `refusal` → synthesised `policy` analysis.
 * - Anything else → synthesised low-confidence `runtime_error`.
 */
function classifyStopReason(
  stopReason: string,
  runtime: RuntimeId,
): RuntimeErrorAnalysis | undefined {
  if (stopReason === "end_turn" || stopReason === "cancelled") return undefined;
  if (stopReason === "max_tokens") {
    // The synthetic text must hit the analyzer's token-budget regex so
    // we get a `token_budget` kind (not the fallback `runtime_error`).
    return analyzeRuntimeErrorSignal({
      runtime,
      source: "error_string",
      text: "token budget exceeded",
      assumeRuntimeError: true,
    });
  }
  if (stopReason === "max_turn_requests") {
    return {
      runtime,
      source: "error_string",
      kind: "runtime_error",
      confidence: "medium",
      message: "max turn requests exceeded",
    };
  }
  if (stopReason === "refusal") {
    return {
      runtime,
      source: "error_string",
      kind: "policy",
      confidence: "high",
      message: "agent refused",
    };
  }
  return {
    runtime,
    source: "error_string",
    kind: "runtime_error",
    confidence: "low",
    message: `unknown stop reason: ${stopReason}`,
  };
}

/**
 * FR-L37: classify a JSON-RPC error surfaced by the ACP client.
 * `assumeRuntimeError` is set so an unrecognised but RPC-confirmed
 * failure still surfaces a low-confidence `runtime_error` kind instead
 * of leaking through as `undefined`.
 */
function classifyRpcError(
  err: AcpRpcError,
  runtime: RuntimeId,
): RuntimeErrorAnalysis | undefined {
  return analyzeRuntimeErrorSignal({
    runtime,
    source: "error_string",
    text: err.message,
    assumeRuntimeError: true,
  });
}

/**
 * FR-L37: classify the captured stderr tail. Falls back to `undefined`
 * for blank/whitespace tails and for tails that the pure classifier
 * cannot recognise — RPC analysis is the primary signal; stderr only
 * fills in when RPC has nothing to say.
 */
function classifyStderrTail(
  text: string,
  runtime: RuntimeId,
): RuntimeErrorAnalysis | undefined {
  if (!text.trim()) return undefined;
  return analyzeRuntimeErrorSignal({ runtime, source: "stderr", text });
}

/**
 * FR-L37: pick the more specific of two candidate analyses. The RPC
 * channel is authoritative — but when its analysis is the catch-all
 * `runtime_error` kind (the analyzer's fallback for opaque wire
 * messages like JSON-RPC -32603 "Internal error"), a stderr-side
 * classification with a narrower kind takes over. Returns `undefined`
 * when both candidates are absent.
 */
function pickClassification(
  rpc: RuntimeErrorAnalysis | undefined,
  stderr: RuntimeErrorAnalysis | undefined,
): RuntimeErrorAnalysis | undefined {
  if (!rpc) return stderr;
  if (
    rpc.kind === "runtime_error" && stderr && stderr.kind !== "runtime_error"
  ) {
    return stderr;
  }
  return rpc;
}

/**
 * FR-L39: kinds of `runtime_error.kind` that mean "do not retry" —
 * mirrors the CLI invokers' policy. Anything not on this list is
 * either explicitly retryable (`rate_limit` / `quota` / `runtime_error`)
 * or an unclassified spawn failure that follows the CLI loop's
 * "retry on unknown exception" pattern.
 */
const TERMINAL_RUNTIME_ERROR_KINDS: ReadonlySet<string> = new Set([
  "auth",
  "policy",
  "context_window",
  "token_budget",
  "plan_limit",
]);

/**
 * FR-L39: retry-decision policy. Driven by the classifier output threaded
 * through `attemptInvocation`. Unclassified spawn / drain exceptions fall
 * back to "retry once like the CLI loop" so a transient `npx` failure is
 * not strictly terminal.
 */
function shouldRetry(
  result: RuntimeInvokeResult,
  attempt: number,
  maxRetries: number,
): boolean {
  if (attempt >= maxRetries) return false;
  // Abort already short-circuits at the top of the loop; treat the
  // `Aborted:` shape as terminal too in case it leaks through here.
  if (result.error?.startsWith("Aborted:")) return false;
  const kind = result.runtime_error?.kind;
  if (kind && TERMINAL_RUNTIME_ERROR_KINDS.has(kind)) return false;
  if (kind === "rate_limit" || kind === "quota" || kind === "runtime_error") {
    return true;
  }
  // Unclassified error path — mirrors CLI loop's "retry on exception".
  return !!result.error;
}

/**
 * FR-L39: abortable sleep. Inlined from `claude/process.ts:sleep` —
 * the helper is leaf-pure and three lines long; extracting to
 * `runtime/abortable-sleep.ts` is a follow-up once a third caller
 * appears (documented on `acp-reliability-parity.md` Risks).
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timerId = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timerId);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortReason(signal?: AbortSignal): string {
  const reason = signal?.reason;
  if (reason === undefined) return "manual abort";
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) return reason.message;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

/**
 * Invoke an ACP front for one prompt turn and return the runtime-neutral
 * {@link RuntimeInvokeResult}.
 *
 * Honours `opts.maxRetries` / `opts.retryDelaySeconds` with exponential
 * backoff (multiplier 2.0) symmetric to the CLI invokers. Each retry
 * spawns a fresh `AcpStdioClient`; the previous one is disposed inside
 * the same loop iteration so the next attempt sees a clean
 * `ProcessRegistry`. Default `maxRetries: 0` keeps single-shot
 * semantics for callers that did not opt in.
 *
 * @param runtime Pilot runtime selector. `claude`, `codex`, and
 *   `opencode` are end-to-end validated; `cursor` rejects with a
 *   "not piloted yet" error unless `opts.acpFront` is supplied.
 * @param opts Standard invocation options.
 */
export async function invokeViaAcp(
  runtime: RuntimeId,
  opts: RuntimeInvokeOptions,
): Promise<RuntimeInvokeResult> {
  // FR-L39: external abort + wall-clock timeout must tear down the ACP
  // front, otherwise consumer ceilings (e2e tests, engine watchdogs)
  // just print a useless timeout without unblocking us.
  if (opts.signal?.aborted) {
    return { error: "Aborted before start" };
  }
  // FR-L39: fail fast on options the ACP wire cannot carry — surfacing the
  // mistake at the call site beats a silent drop that drifts behaviour
  // downstream. Runs BEFORE any subprocess spawn and BEFORE the
  // degraded-options warn path, so the throw always wins.
  const unsupported = collectUnsupportedOptions(
    "invoke",
    opts as unknown as Record<string, unknown>,
  );
  if (unsupported.length > 0) {
    throw new AcpUnsupportedOptionError(runtime, unsupported);
  }
  const maxRetries = opts.maxRetries ?? 0;
  const baseDelayMs = (opts.retryDelaySeconds ?? 1) * 1000;
  let lastResult: RuntimeInvokeResult | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await attemptInvocation(runtime, opts);
    if (!result.error && !result.output?.is_error) return result;
    if (!shouldRetry(result, attempt, maxRetries)) return result;
    lastResult = result;
    try {
      await abortableSleep(baseDelayMs * 2 ** attempt, opts.signal);
    } catch {
      return { error: `Aborted: ${abortReason(opts.signal)}` };
    }
  }
  return lastResult ??
    { error: `acp(${runtime}): exhausted retries with no result` };
}

/**
 * One spawn-handshake-prompt cycle. The retry loop in
 * {@link invokeViaAcp} runs this once per attempt — each call gets a
 * fresh `AcpStdioClient`, runs the drain race, and disposes the client
 * before returning.
 */
async function attemptInvocation(
  runtime: RuntimeId,
  opts: RuntimeInvokeOptions,
): Promise<RuntimeInvokeResult> {
  const startedAt = performance.now();
  const turn = 1;
  const permissionHandler = createPermissionHandler({
    runtime,
    onToolUseObserved: opts.onToolUseObserved,
    getTurn: () => turn,
  });

  let client: AcpStdioClient;
  try {
    client = spawnClient({
      runtime,
      cwd: opts.cwd,
      env: opts.env,
      processRegistry: opts.processRegistry,
      onStderr: undefined,
      acpFront: opts.acpFront,
      onRequest: async (req) => {
        if (req.method === "session/request_permission") {
          return await permissionHandler(
            (req.params ?? { options: [] }) as unknown as Parameters<
              typeof permissionHandler
            >[0],
          );
        }
        throw new Error(`unsupported inbound method: ${req.method}`);
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `acp(${runtime}): ${message}` };
  }

  // Hook external abort + wall-clock timeout to client disposal so the
  // front actually goes down. We listen on each source signal
  // separately rather than via `AbortSignal.any` — empirically the
  // composed signal's handlers do not always fire on Deno 2.8 when a
  // source aborts during a long-running JSON-RPC await (FR-L39).
  const timeoutSignal = opts.timeoutSeconds > 0
    ? AbortSignal.timeout(opts.timeoutSeconds * 1000)
    : undefined;
  let abortedFor: string | undefined;
  let abortHandlerFired = false;
  const onAbort = () => {
    if (abortHandlerFired) return;
    abortHandlerFired = true;
    if (timeoutSignal?.aborted && !opts.signal?.aborted) {
      abortedFor = `timeout after ${opts.timeoutSeconds}s`;
    } else {
      abortedFor = "external abort";
    }
    void client.dispose();
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  timeoutSignal?.addEventListener("abort", onAbort, { once: true });

  const collectedText: string[] = [];
  const drainPromise = (async () => {
    for await (const note of client.notifications()) {
      // Shape-validate the update so a malformed front trips early
      // even when nothing consumes the normalized event today. The
      // return value is intentionally discarded — `invokeViaAcp` does
      // not queue events, and the content-extractor dispatch
      // (`runtime/content.ts`) for ACP is FR-L39 follow-up work.
      mapSessionUpdate(runtime, note.method, note.params);
      safeInvokeCallback(
        opts.onEvent,
        [note.params ?? {}],
        "onEvent",
        opts.onCallbackError,
      );
      // FR-L23: feed the public extractor with the literal "session/update"
      // type so this call site agrees with the dispatcher in
      // runtime/content.ts:isAcpShapedEvent. Filter for text content —
      // `tool_call_update` entries return `kind: "tool"` and stay out of
      // the concatenated text result.
      for (
        const c of extractAcpContent(
          runtime,
          "session/update",
          note.params ?? {},
        )
      ) {
        if (c.kind === "text") collectedText.push(c.text);
      }
    }
  })();

  try {
    const { sessionId } = await handshake(client, runtime, opts);
    // FR-L17: surface the requested model on the onInit hook, matching the
    // CLI adapters. Best-effort — ACP fronts do not echo the effective
    // model, so we report what we asked for (`opts.model`). The field stays
    // absent when unset, mirroring CLI behaviour (`RuntimeInitInfo.model?`).
    opts.hooks?.onInit?.({
      runtime,
      sessionId,
      ...(opts.model ? { model: opts.model } : {}),
    });

    const degraded = collectDegradedOptions(opts);
    reportDegradedOptions(runtime, degraded, opts.onCallbackError);

    const promptText = opts.systemPrompt
      ? `${opts.systemPrompt}\n\n${opts.taskPrompt}`
      : opts.taskPrompt;

    const promptRes = await client.request<PromptResult>(
      "session/prompt",
      buildPromptParams(sessionId, promptText),
    );

    // FR-L39: ACP guarantees PromptResponse arrives after every
    // `session/update` for this turn, but the local stdout parser may
    // still have unprocessed bytes when `request()` resolves — the
    // drain loop runs in a sibling async function and lags by a few
    // microtasks. Yield the event loop until the parsed queue
    // empties (best-effort, bounded) so the final `agent_message_chunk`
    // makes it into `collectedText` before we build the result.
    await flushDrain(client);

    const durationMs = Math.round(performance.now() - startedAt);
    const stopReason = promptRes.stopReason ?? "end_turn";
    // FR-L37: `is_error` flips on any non-`end_turn` reason so consumers
    // that ignore `runtime_error` still see the legacy boolean. The
    // structured analysis is attached separately for callers that
    // branch on `runtime_error.kind`.
    const isError = stopReason !== "end_turn";
    const stopAnalysis = classifyStopReason(stopReason, runtime);

    const result = {
      runtime,
      result: collectedText.join(""),
      session_id: sessionId,
      duration_ms: durationMs,
      num_turns: turn,
      is_error: isError,
    };
    opts.hooks?.onResult?.(result);
    return {
      output: result,
      ...(stopAnalysis ? { runtime_error: stopAnalysis } : {}),
    };
  } catch (err) {
    // FR-L19: the post-init capability gate (resumeSessionId vs
    // loadSession) throws AcpUnsupportedOptionError from inside
    // `handshake`. Surface it as a THROWN error — same contract as the
    // entry-time tuple throw — instead of wrapping it in an error result
    // (and do not retry: capability-unsupported is terminal). The
    // `finally` below still disposes the spawned client.
    if (err instanceof AcpUnsupportedOptionError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const stderrTail = client.stderr.trim().split("\n").slice(-10).join("\n");
    const suffix = stderrTail ? `\nstderr tail:\n${stderrTail}` : "";
    if (abortedFor) {
      return { error: `Aborted: ${abortedFor}` };
    }
    // FR-L37: RPC analysis is the primary signal — but only when it
    // carries a specific kind. When the RPC error is generic (the
    // analyzer fell back to `runtime_error` because the wire message
    // was opaque, e.g. JSON-RPC -32603 "Internal error"), defer to the
    // stderr tail if it classifies to something narrower. Mirrors the
    // documented precedence rule on the Risks section of
    // `acp-reliability-parity.md`.
    const rpcAnalysis = err instanceof AcpRpcError
      ? classifyRpcError(err, runtime)
      : undefined;
    const stderrAnalysis = classifyStderrTail(stderrTail, runtime);
    const runtimeError = pickClassification(rpcAnalysis, stderrAnalysis);
    return {
      error: `acp(${runtime}): ${message}${suffix}`,
      ...(runtimeError ? { runtime_error: runtimeError } : {}),
    };
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    timeoutSignal?.removeEventListener("abort", onAbort);
    await client.dispose();
    await drainPromise.catch(() => {});
  }
}

class AcpRuntimeSession implements RuntimeSession {
  readonly runtime: RuntimeId;
  readonly events: AsyncIterableIterator<RuntimeSessionEvent>;
  readonly done: Promise<RuntimeSessionStatus>;
  #sessionId: string;
  #client: AcpStdioClient;
  #queue: SessionEventQueue<RuntimeSessionEvent>;
  #inputClosed = false;
  #aborted = false;
  #activePrompt: Promise<unknown> | undefined;

  /**
   * Construct a wrapper around an already-handshaked ACP client.
   *
   * @param runtime Runtime id (also stored on emitted events).
   * @param client Connected ACP stdio client.
   * @param sessionId Server-assigned session id.
   * @param drainPromise Background notification drain.
   */
  constructor(
    runtime: RuntimeId,
    client: AcpStdioClient,
    sessionId: string,
    queue: SessionEventQueue<RuntimeSessionEvent>,
    drainPromise: Promise<void>,
  ) {
    this.runtime = runtime;
    this.#client = client;
    this.#sessionId = sessionId;
    this.#queue = queue;
    this.events = queue;
    this.done = (async () => {
      await drainPromise.catch(() => {});
      const status = await client.done.catch(() => ({
        code: -1,
        signal: null,
        success: false,
      }));
      return {
        exitCode: typeof status.code === "number" ? status.code : null,
        signal: status.signal ?? null,
        stderr: client.stderr,
      };
    })();
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  async send(content: string): Promise<void> {
    if (this.#aborted) throw new SessionAbortedError(this.runtime);
    if (this.#inputClosed) throw new SessionInputClosedError(this.runtime);
    this.#activePrompt = this.#client.request(
      "session/prompt",
      buildPromptParams(this.#sessionId, content),
    );
    // Mirror the existing contract: `send` resolves once the runtime has
    // accepted the input. ACP's `session/prompt` is a request, so we
    // can't return until the agent responds. We surface failures via
    // SessionDeliveryError; the response itself feeds turn-end below.
    try {
      const res = (await this.#activePrompt) as PromptResult;
      this.#queue.push(
        buildTurnEndEvent(this.runtime, res.stopReason ?? "end_turn"),
      );
    } catch (err) {
      if (err instanceof AcpRpcError) {
        throw new SessionDeliveryError(this.runtime, err.message, {
          cause: err,
        });
      }
      throw err;
    } finally {
      this.#activePrompt = undefined;
    }
  }

  endInput(): Promise<void> {
    // Signal-only per the cross-runtime contract (`runtime/AGENTS.md`):
    // flip the flag and return promptly. Full-shutdown observation
    // lives on `await session.done`. Best-effort fire-and-forget the
    // dispose in the background so the subprocess does not linger,
    // mirroring opencode's "schedule SIGTERM after idle" pattern.
    this.#inputClosed = true;
    void this.#client.dispose();
    return Promise.resolve();
  }

  abort(_reason?: string): void {
    if (this.#aborted) return;
    this.#aborted = true;
    void this.#client.notify("session/cancel", { sessionId: this.#sessionId });
    void this.#client.dispose();
  }
}

/**
 * Open a long-lived ACP-backed session for the given runtime.
 *
 * @param runtime Pilot runtime selector.
 * @param opts Standard session options.
 */
export async function openSessionViaAcp(
  runtime: RuntimeId,
  opts: RuntimeSessionOptions,
): Promise<RuntimeSession> {
  // FR-L39: mirror the invoke-path guard. The throw lives at the factory
  // entry (not in AcpRuntimeSession's constructor): the class is
  // module-private, so unit tests cannot bypass validation by constructing
  // it directly. Validates BEFORE spawnClient so no front is started.
  const unsupported = collectUnsupportedOptions(
    "session",
    opts as unknown as Record<string, unknown>,
  );
  if (unsupported.length > 0) {
    throw new AcpUnsupportedOptionError(runtime, unsupported);
  }
  const turnCounter = { value: 0 };
  const permissionHandler = createPermissionHandler({
    runtime,
    getTurn: () => turnCounter.value,
  });
  const client = spawnClient({
    runtime,
    cwd: opts.cwd,
    env: opts.env,
    processRegistry: opts.processRegistry,
    onStderr: opts.onStderr,
    acpFront: opts.acpFront,
    onRequest: async (req) => {
      if (req.method === "session/request_permission") {
        return await permissionHandler(
          (req.params ?? { options: [] }) as unknown as Parameters<
            typeof permissionHandler
          >[0],
        );
      }
      throw new Error(`unsupported inbound method: ${req.method}`);
    },
  });

  // FR-L19: handshake may throw AcpUnsupportedOptionError from the
  // post-init resume gate (resumeSessionId set, loadSession unadvertised).
  // The client is already spawned here, so dispose it before rethrowing —
  // the session factory has no `finally` to lean on.
  let sessionId: string;
  try {
    ({ sessionId } = await handshake(client, runtime, opts));
  } catch (err) {
    await client.dispose();
    throw err;
  }
  reportDegradedOptions(
    runtime,
    collectDegradedOptions(opts),
    opts.onCallbackError,
  );

  const queue = new SessionEventQueue<RuntimeSessionEvent>("AcpRuntimeSession");
  const drain = (async () => {
    for await (const note of client.notifications()) {
      const event = mapSessionUpdate(runtime, note.method, note.params);
      if (opts.onEvent) {
        await safeAwaitCallback(
          opts.onEvent,
          [event],
          "onEvent",
          opts.onCallbackError,
        );
      }
      queue.push(event);
      if (note.method === "session/update") {
        const sessionUpdate = note.params?.["sessionUpdate"];
        if (sessionUpdate === "current_mode_update") {
          turnCounter.value += 1;
        }
      }
    }
    queue.close();
  })();

  return new AcpRuntimeSession(runtime, client, sessionId, queue, drain);
}
