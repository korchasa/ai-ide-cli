/**
 * @module
 * Handler for inbound ACP `session/request_permission` requests.
 *
 * ADR-0002 keeps HITL out of scope, so the handler degrades the
 * multi-option ACP shape down to the existing
 * `OnRuntimeToolUseObservedCallback` "allow / abort" contract:
 *
 * - No callback supplied → answer with the first `reject_once` /
 *   `reject_always` option declared by the agent, or with `cancelled` if
 *   no rejection option is offered. Either path keeps the agent's UX
 *   intact without delegating policy to the library.
 * - Callback supplied → invoke it with a stub
 *   {@link RuntimeToolUseInfo}; map `"allow"` to the first allow option
 *   (or `selected` with the first option as a last resort) and
 *   `"abort"` to the first reject option.
 */

import type { RuntimeId } from "../../types.ts";
import type {
  OnRuntimeToolUseObservedCallback,
  RuntimeToolUseInfo,
} from "../adapter-types.ts";

/** Single permission option as the agent describes it. */
export interface AcpPermissionOption {
  /** Stable id returned in the response. */
  optionId: string;
  /** Display name. */
  name?: string;
  /** Decision kind tag. */
  kind?:
    | "allow_once"
    | "allow_always"
    | "reject_once"
    | "reject_always"
    | string;
}

/** Params of a `session/request_permission` request, fields we read. */
export interface AcpPermissionRequest {
  /** Session id the request applies to. */
  sessionId?: string;
  /** Tool call descriptor (free-form per ACP). */
  toolCall?: {
    toolCallId?: string;
    title?: string;
    rawInput?: Record<string, unknown>;
  };
  /** Multi-option permission menu. */
  options: AcpPermissionOption[];
}

/** Response shape returned to the agent. */
export type AcpPermissionResponse =
  | { outcome: { type: "selected"; optionId: string } }
  | { outcome: { type: "cancelled" } };

const ALLOW_KINDS = new Set(["allow_once", "allow_always"]);
const REJECT_KINDS = new Set(["reject_once", "reject_always"]);

/**
 * Build a context object that handles inbound `session/request_permission`
 * by collapsing the ACP shape to the consumer's `onToolUseObserved`
 * callback (or to deny-by-default when none supplied).
 */
export function createPermissionHandler(opts: {
  /** Owning runtime id (forwarded into {@link RuntimeToolUseInfo}). */
  runtime: RuntimeId;
  /** Optional observed-tool-use callback. */
  onToolUseObserved?: OnRuntimeToolUseObservedCallback;
  /** Turn counter — incremented by the adapter on every new prompt. */
  getTurn: () => number;
}): (req: AcpPermissionRequest) => Promise<AcpPermissionResponse> {
  return async (req) => {
    const rejectOption = req.options.find((o) =>
      typeof o.kind === "string" && REJECT_KINDS.has(o.kind)
    );
    const allowOption = req.options.find((o) =>
      typeof o.kind === "string" && ALLOW_KINDS.has(o.kind)
    );

    if (!opts.onToolUseObserved) {
      if (rejectOption) {
        return {
          outcome: { type: "selected", optionId: rejectOption.optionId },
        };
      }
      return { outcome: { type: "cancelled" } };
    }

    const info: RuntimeToolUseInfo = {
      runtime: opts.runtime,
      id: req.toolCall?.toolCallId ?? "",
      name: req.toolCall?.title ?? "tool",
      input: req.toolCall?.rawInput,
      turn: opts.getTurn(),
    };

    let decision: "allow" | "abort";
    try {
      decision = await opts.onToolUseObserved(info);
    } catch {
      decision = "abort";
    }

    if (decision === "allow") {
      const chosen = allowOption ?? req.options[0];
      if (chosen) {
        return { outcome: { type: "selected", optionId: chosen.optionId } };
      }
      return { outcome: { type: "cancelled" } };
    }
    if (rejectOption) {
      return { outcome: { type: "selected", optionId: rejectOption.optionId } };
    }
    return { outcome: { type: "cancelled" } };
  };
}
