import type { RuntimeId } from "../types.ts";

/**
 * Base class for every error thrown by `RuntimeSession.send`. Adapter
 * implementations construct one of the three concrete subclasses so that
 * consumers can branch on `instanceof` instead of parsing message prefixes.
 *
 * `cause` (standard `Error.cause`) carries the underlying transport error
 * when one exists (e.g. the raw `fetch` failure for OpenCode, the
 * `CodexAppServerError` for Codex).
 */
export class SessionError extends Error {
  /** Runtime that produced the error. */
  readonly runtime: RuntimeId;
  /**
   * Construct a new base session error. Subclasses pre-fill `message`
   * with a standard phrase; the base class is exposed for consumers that
   * want to rethrow a generic failure (rare — prefer a concrete subclass).
   *
   * @param runtime Runtime that produced the error.
   * @param message Human-readable failure description.
   * @param options Standard `ErrorOptions` — use `cause` to attach the
   *   underlying transport exception.
   */
  constructor(runtime: RuntimeId, message: string, options?: ErrorOptions) {
    super(message, options);
    this.runtime = runtime;
    this.name = "SessionError";
  }
}

/**
 * Thrown by `RuntimeSession.send` after `RuntimeSession.endInput` has
 * closed the input channel. Indicates programmer error on the consumer
 * side (or a race with a graceful shutdown); reopening the session is the
 * normal recovery path.
 */
export class SessionInputClosedError extends SessionError {
  /**
   * Construct a new input-closed error for the given runtime.
   *
   * @param runtime Runtime whose session rejected the send.
   * @param message Optional override; defaults to
   *   `"<runtime> session: input already closed"`.
   * @param options Standard `ErrorOptions`.
   */
  constructor(runtime: RuntimeId, message?: string, options?: ErrorOptions) {
    super(
      runtime,
      message ?? `${runtime} session: input already closed`,
      options,
    );
    this.name = "SessionInputClosedError";
  }
}

/**
 * Thrown by `RuntimeSession.send` after `RuntimeSession.abort` (or an
 * external `AbortSignal`) tore the session down. The consumer should open
 * a fresh session, passing the prior `sessionId` as `resumeSessionId` to
 * preserve the conversation.
 */
export class SessionAbortedError extends SessionError {
  /**
   * Construct a new aborted-session error for the given runtime.
   *
   * @param runtime Runtime whose session was aborted.
   * @param message Optional override; defaults to `"<runtime> session: aborted"`.
   * @param options Standard `ErrorOptions`.
   */
  constructor(runtime: RuntimeId, message?: string, options?: ErrorOptions) {
    super(runtime, message ?? `${runtime} session: aborted`, options);
    this.name = "SessionAbortedError";
  }
}

/**
 * Thrown by `RuntimeSession.send` when the adapter failed to put the
 * message on the runtime's transport — HTTP non-2xx (OpenCode), broken
 * stdin pipe (Claude / Codex app-server), JSON-RPC error (Codex), etc. The
 * session may or may not still be usable; the consumer should inspect
 * `cause` if it needs to decide whether to retry on the same handle or
 * reopen.
 */
export class SessionDeliveryError extends SessionError {
  /**
   * Construct a new delivery-failure error for the given runtime.
   *
   * @param runtime Runtime whose transport refused or failed to accept the send.
   * @param message Description of the delivery failure (e.g. HTTP status + body).
   * @param options Standard `ErrorOptions`; attach the underlying transport
   *   exception via `cause` so callers can branch on it.
   */
  constructor(runtime: RuntimeId, message: string, options?: ErrorOptions) {
    super(runtime, message, options);
    this.name = "SessionDeliveryError";
  }
}
