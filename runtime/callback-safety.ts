/**
 * @module
 * Routed error sink for consumer-supplied callbacks (FR-L32).
 *
 * Every adapter — Claude, OpenCode, Cursor, Codex — accepts notification
 * callbacks (`onEvent`, `onStderr`, `onToolUseObserved`, `onSendFailed`).
 * When a consumer-supplied callback throws, the streaming loop must stay
 * alive (per the documented `RuntimeSession` contract) but the throw must
 * not vanish — that hides bugs in consumer code (typos, null derefs,
 * shape mismatches).
 *
 * `safeInvokeCallback` wraps `cb(...args)` in a try/catch and routes any
 * thrown value through `onCallbackError(err, source)`. When the caller
 * supplies no `onCallbackError`, the default handler logs the error to
 * `console.warn` with the source tag and stack trace — visible by default,
 * but consumers can opt out by supplying a no-op handler.
 *
 * This module is the single home for the convention. Every silent-swallow
 * site that fronts a consumer callback should call through this helper.
 * Transport-teardown idempotent catches (SIGTERM, broken pipe,
 * already-closed stream, cleanup `Deno.remove`) stay as-is — they're not
 * consumer-facing.
 */

/**
 * Source tag identifying which consumer callback raised the error. The
 * union is open-ended on purpose so adapters that grow new notification
 * hooks (e.g. a future `onTokenUsage`) can extend it without breaking
 * existing handlers.
 */
export type CallbackErrorSource =
  | "onEvent"
  | "onStderr"
  | "onToolUseObserved"
  | "onSendFailed";

/**
 * Notification fired when a consumer-supplied callback throws. Receives the
 * thrown value (NOT necessarily an `Error` — JS allows `throw "string"`)
 * and a string tag identifying which callback raised it.
 *
 * Set this on `RuntimeInvokeOptions.onCallbackError` /
 * `RuntimeSessionOptions.onCallbackError` to capture errors from
 * `onEvent`, `onStderr`, `onToolUseObserved`, and `onSendFailed`. The
 * handler MUST NOT throw — it is itself wrapped in try/catch so a bug
 * here does not bring down the streaming loop.
 */
export type OnCallbackError = (
  err: unknown,
  source: CallbackErrorSource,
) => void;

/**
 * Default `onCallbackError` handler. Writes a one-line warning header plus
 * the error stack (or `String(err)` when the throw value is not an `Error`)
 * to `console.warn`, prefixed with the source tag so consumers see which
 * callback failed.
 *
 * Exported so consumers who want to wrap the default with extra logic
 * (e.g. forward to a structured logger) can compose it instead of
 * reimplementing the formatting.
 */
// FR-L32
export function defaultOnCallbackError(
  err: unknown,
  source: CallbackErrorSource,
): void {
  const detail = err instanceof Error
    ? (err.stack ?? `${err.name}: ${err.message}`)
    : String(err);
  console.warn(
    `[ai-ide-cli] consumer ${source} callback threw — streaming loop continues:\n${detail}`,
  );
}

/**
 * Invoke `cb(...args)` and route any throw through `onCallbackError`. When
 * `cb` is `undefined`, returns immediately. When `onCallbackError` is
 * `undefined`, the default handler logs to `console.warn` (see
 * {@link defaultOnCallbackError}).
 *
 * The helper is synchronous — it does NOT await `cb`'s return value.
 * Async callbacks should be awaited explicitly by the caller and the
 * result fed through {@link safeAwaitCallback} instead.
 *
 * @param cb       Consumer callback to invoke (may be `undefined`).
 * @param args     Argument tuple forwarded to `cb`.
 * @param source   Source tag used by the default warn formatter.
 * @param onCallbackError  Optional consumer-supplied error sink.
 */
// FR-L32
export function safeInvokeCallback<A extends readonly unknown[]>(
  cb: ((...args: A) => void) | undefined,
  args: A,
  source: CallbackErrorSource,
  onCallbackError?: OnCallbackError,
): void {
  if (!cb) return;
  try {
    cb(...args);
  } catch (err) {
    routeCallbackError(err, source, onCallbackError);
  }
}

/**
 * Async counterpart to {@link safeInvokeCallback}. Awaits the callback's
 * result and routes both synchronous throws and rejected promises through
 * `onCallbackError`. Returns the resolved value on success and `undefined`
 * on failure so callers can fall back to a default decision (see
 * `onToolUseObserved` allow-on-error semantics).
 *
 * @param cb       Async callback to invoke (may be `undefined`).
 * @param args     Argument tuple forwarded to `cb`.
 * @param source   Source tag used by the default warn formatter.
 * @param onCallbackError  Optional consumer-supplied error sink.
 */
// FR-L32
export async function safeAwaitCallback<R, A extends readonly unknown[]>(
  cb: ((...args: A) => R | Promise<R>) | undefined,
  args: A,
  source: CallbackErrorSource,
  onCallbackError?: OnCallbackError,
): Promise<R | undefined> {
  if (!cb) return undefined;
  try {
    return await cb(...args);
  } catch (err) {
    routeCallbackError(err, source, onCallbackError);
    return undefined;
  }
}

function routeCallbackError(
  err: unknown,
  source: CallbackErrorSource,
  onCallbackError: OnCallbackError | undefined,
): void {
  const handler = onCallbackError ?? defaultOnCallbackError;
  try {
    handler(err, source);
  } catch (handlerErr) {
    // The handler itself threw — fall back to the default formatter so
    // the original error is at least visible. Do NOT recurse further.
    if (handler !== defaultOnCallbackError) {
      defaultOnCallbackError(err, source);
    }
    // Surface the handler's bug too, on a separate line.
    defaultOnCallbackError(handlerErr, source);
  }
}
