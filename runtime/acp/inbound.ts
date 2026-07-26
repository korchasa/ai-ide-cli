/**
 * @module
 * Routing for inbound ACP requests (agent → client), shared by the
 * one-shot invoke path and the long-lived session path.
 *
 * ACP fronts call back into the client for anything that needs a
 * client-side decision. This library answers exactly one such method —
 * `session/request_permission` (collapsed onto `onToolUseObserved`, see
 * `permissions.ts`) — because HITL is out of scope (ADR-0002). Fronts
 * keep growing new ones (`session/request_elicitation`, `fs/*`,
 * `terminal/*`), and a client that answers them with a wrong or opaque
 * error teaches the front the wrong lesson: JSON-RPC `-32000` reads as
 * "the client broke", while `-32601` reads as "the client does not
 * implement this", which is what actually happened and what lets a
 * well-behaved front degrade instead of retrying or aborting the turn.
 *
 * The rejection is also surfaced to the consumer through the
 * `OnCallbackError` sink, mirroring the degraded-options warn path in
 * `adapter.ts` — otherwise a front silently losing a capability is
 * invisible from the outside.
 */

import type { RuntimeId } from "../../types.ts";
import type { OnCallbackError } from "../callback-safety.ts";
import type { AcpClientRequest, AcpInboundRequestHandler } from "./client.ts";
import type {
  AcpPermissionRequest,
  AcpPermissionResponse,
} from "./permissions.ts";

/** JSON-RPC 2.0 reserved code for an unimplemented method. */
export const JSON_RPC_METHOD_NOT_FOUND: number = -32601;

/** ACP method this client implements. Everything else is rejected. */
const SUPPORTED_INBOUND_METHOD = "session/request_permission";

/**
 * Thrown by the inbound-request handler for a method this client does not
 * implement. The `code` field is read by `AcpStdioClient` and sent back as
 * the JSON-RPC error code, so the front sees `-32601` (Method not found)
 * rather than the generic `-32000`.
 */
// FR-L43
export class AcpMethodNotFoundError extends Error {
  /** JSON-RPC error code sent back to the front. */
  readonly code: number = JSON_RPC_METHOD_NOT_FOUND;
  /** Runtime whose front issued the request. */
  readonly runtime: RuntimeId;
  /** Inbound method name that was rejected. */
  readonly method: string;

  /**
   * Construct a method-not-found rejection for one inbound ACP request.
   *
   * @param runtime Runtime whose front issued the request.
   * @param method Inbound method name that this client does not implement.
   */
  constructor(runtime: RuntimeId, method: string) {
    super(
      `acp(${runtime}): unimplemented inbound method "${method}" — ` +
        `this client answers only "${SUPPORTED_INBOUND_METHOD}"`,
    );
    this.name = "AcpMethodNotFoundError";
    this.runtime = runtime;
    this.method = method;
  }
}

/**
 * Build the inbound-request handler passed to `spawnClient`.
 *
 * `session/request_permission` is delegated to `permissionHandler`;
 * every other method is rejected with {@link AcpMethodNotFoundError} and
 * reported once through `onCallbackError`. Rejecting does NOT end the
 * turn — the client answers the single request with a JSON-RPC error and
 * the session keeps streaming.
 *
 * @param opts Runtime id, permission handler, and optional error sink.
 */
// FR-L43
export function createInboundRequestHandler(opts: {
  /** Runtime whose ACP front is being served. */
  runtime: RuntimeId;
  /** Handler for `session/request_permission` (see `permissions.ts`). */
  permissionHandler: (
    req: AcpPermissionRequest,
  ) => Promise<AcpPermissionResponse>;
  /** Optional sink notified when an inbound method is rejected. */
  onCallbackError?: OnCallbackError;
}): AcpInboundRequestHandler {
  return async (req: AcpClientRequest) => {
    if (req.method === SUPPORTED_INBOUND_METHOD) {
      return await opts.permissionHandler(
        (req.params ?? { options: [] }) as unknown as AcpPermissionRequest,
      );
    }
    const err = new AcpMethodNotFoundError(opts.runtime, req.method);
    if (opts.onCallbackError) {
      try {
        opts.onCallbackError(err, "onEvent");
      } catch {
        // FR-L32: the error sink must never break the streaming loop.
      }
    }
    throw err;
  };
}
