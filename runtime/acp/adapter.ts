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
import { AcpRpcError, AcpStdioClient } from "./client.ts";
import { extractAcpContent } from "./content.ts";
import { getAcpFront } from "./fronts.ts";
import {
  type AcpConfigOptionDecl,
  type AcpDegradedOption,
  type AcpModeDecl,
  buildInitializeParams,
  buildSessionNewParams,
  buildTurnEndEvent,
  collectDegradedOptions,
  mapSessionUpdate,
  pickConfigForModel,
  pickConfigForReasoningEffort,
  pickModeForPermissionMode,
} from "./mapping.ts";
import { createPermissionHandler } from "./permissions.ts";

/** Subset of the `session/new` response we read. */
interface SessionNewResult {
  sessionId: string;
  modes?: { availableModes?: AcpModeDecl[]; currentModeId?: string };
  /** Field name used by claude / codex ACP fronts. */
  sessionConfigOptions?: AcpConfigOptionDecl[];
  /** Field name used by opencode ACP front (1.15.x). */
  configOptions?: AcpConfigOptionDecl[];
}

interface PromptResult {
  stopReason?: string;
}

function notPiloted(runtime: RuntimeId): Error {
  return new Error(
    `acp transport: ${runtime} front is not piloted yet (FR-L39). ` +
      `Promote it in runtime/acp/fronts.ts after empirical validation.`,
  );
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

function spawnClient(opts: {
  runtime: RuntimeId;
  cwd?: string;
  env?: Record<string, string>;
  processRegistry: RuntimeInvokeOptions["processRegistry"];
  onStderr?: (line: string) => void;
  onRequest?: ConstructorParameters<typeof AcpStdioClient>[0]["onRequest"];
  acpFront?: RuntimeInvokeOptions["acpFront"];
}): AcpStdioClient {
  // FR-L39: when the consumer supplies an `acpFront` override, bypass
  // the per-runtime pilot guard — they're explicitly opting into the
  // launcher they pointed us at (local fork, binary download, test
  // stub). Otherwise resolve from the pinned registry and refuse
  // non-piloted runtimes.
  const front = opts.acpFront ?? getAcpFront(opts.runtime);
  if (!opts.acpFront && !front.pilot) throw notPiloted(opts.runtime);
  const mergedEnv = { ...(front.env ?? {}), ...(opts.env ?? {}) };
  return new AcpStdioClient({
    cmd: front.cmd,
    args: front.args,
    cwd: opts.cwd,
    env: mergedEnv,
    processRegistry: opts.processRegistry,
    onStderr: opts.onStderr,
    onRequest: opts.onRequest,
  });
}

async function handshake(
  client: AcpStdioClient,
  runtime: RuntimeId,
  opts: Pick<
    RuntimeInvokeOptions,
    | "cwd"
    | "mcpServers"
    | "extraArgs"
    | "env"
    | "permissionMode"
    | "model"
    | "reasoningEffort"
  >,
): Promise<{ sessionId: string }> {
  await client.request("initialize", {
    ...buildInitializeParams(),
  } as unknown as Record<string, unknown>);

  const sessionParams = buildSessionNewParams(runtime, opts);
  const sessionRes = await client.request<SessionNewResult>(
    "session/new",
    sessionParams as unknown as Record<string, unknown>,
  );
  const sessionId = sessionRes.sessionId;

  const declaredModes = sessionRes.modes?.availableModes;
  const modeId = pickModeForPermissionMode(
    runtime,
    declaredModes,
    opts.permissionMode,
  );
  if (modeId) {
    await client.request("session/set_mode", {
      sessionId,
      modeId,
    });
  }

  // Claude / Codex put the declared options under `sessionConfigOptions`;
  // OpenCode (1.15.x) uses `configOptions`. Accept either so the same
  // mapper logic works across all fronts.
  const declaredCfg = sessionRes.sessionConfigOptions ??
    sessionRes.configOptions;
  const effortCfg = pickConfigForReasoningEffort(runtime, declaredCfg, {
    reasoningEffort: opts.reasoningEffort,
    extraArgs: opts.extraArgs,
  });
  if (effortCfg) {
    await client.request("session/set_config_option", {
      sessionId,
      configId: effortCfg.configId,
      value: effortCfg.value,
    });
  }
  const modelCfg = pickConfigForModel(declaredCfg, opts.model);
  if (modelCfg) {
    await client.request("session/set_config_option", {
      sessionId,
      configId: modelCfg.configId,
      value: modelCfg.value,
    });
  }

  return { sessionId };
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
    opts.hooks?.onInit?.({ runtime, sessionId });

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

  const { sessionId } = await handshake(client, runtime, opts);
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
