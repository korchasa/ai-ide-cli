/**
 * @module
 * Typed string-literal categories for runtime-adapter errors. Consumers
 * branch on `RuntimeInvokeResult.error_category` to decide retry vs.
 * fail-fast vs. user-visible escalation without parsing error messages.
 */

// FR-L36: typed string literal so downstream consumers branch on
// `error_category === "stream_stall"` rather than substring-matching the
// human-readable `error` message.
/** Stream-stall category — OpenCode subprocess emitted no JSON events for the configured idle threshold. */
export const ERROR_CATEGORY_STREAM_STALL = "stream_stall" as const;

/**
 * Union of every typed error category surfaced by adapter invocations.
 * Extend in lock-step with new detectors; consumers should treat unknown
 * categories as opaque strings to stay forward-compatible.
 */
export type RuntimeErrorCategory = typeof ERROR_CATEGORY_STREAM_STALL;
