/**
 * @module
 * FR-L42 commands fast-channel — neutral types + typed error.
 *
 * The fast-channel pairs with the existing FR-L20
 * `fetchCapabilitiesSlow` (LLM-probed; expensive). Today the only
 * backing transport is ACP, where the spec defines a single
 * `session/update` notification variant
 * (`available_commands_update`) that carries the current slash-command
 * list. CLI transport has no equivalent — adapters throw a typed
 * {@link CommandsUnavailableError} for any consumer that asks anyway.
 *
 * The neutral types live here (`runtime/commands.ts`) rather than
 * `runtime/acp/` because both transports must conform to the same
 * shape — keeping the public surface protocol-agnostic preserves
 * future Claude `system/init` / OpenCode-update / other fast-paths
 * without breaking JSR consumers.
 *
 * Pure; no I/O.
 */

import type { RuntimeId } from "../types.ts";
import type { TransportOption } from "./adapter-types.ts";

// FR-L42
/**
 * One slash-command exposed by a runtime at runtime.
 *
 * Mirrors ACP's `AvailableCommand` shape (the wire structure verified
 * against the upstream JSON schema), normalised so consumers don't
 * branch on which transport surfaced the entry.
 */
export interface Command {
  /** Command identifier as the agent renders it (e.g. `"/help"`). */
  name: string;
  /** Human-readable description, suitable for picker UIs. */
  description: string;
  /**
   * Optional input hint metadata when the command accepts an argument.
   * Absent when the command is parameterless OR when the transport
   * does not surface argument metadata.
   */
  input?: {
    /** Free-text hint about the expected argument shape. */
    hint?: string;
  };
}

// FR-L42
/**
 * Snapshot returned by {@link import("./adapter-types.ts").RuntimeAdapter.fetchCommands}.
 *
 * Stateless: represents the list at the time of capture. Mid-session
 * refreshes are observable via `RuntimeSession.events` →
 * {@link extractSessionContent} (see `NormalizedCommandsContent`).
 */
export interface CommandsSnapshot {
  /** Runtime that produced the snapshot. */
  runtime: RuntimeId;
  /**
   * Session id that produced the snapshot, when the transport assigns
   * one (ACP always does; future CLI fast-paths may not).
   */
  sessionId?: string;
  /** Captured commands, in the order the transport reported them. */
  commands: Command[];
}

// FR-L42
/**
 * Options for `RuntimeAdapter.fetchCommands`.
 *
 * `transport` is required because the adapter cannot infer the route
 * — consumers explicitly pick the fast-channel they want. Mirrors
 * `RuntimeInvokeOptions.transport`.
 */
export interface FetchCommandsOptions {
  /** Transport route. Currently only `"acp"` produces a snapshot. */
  transport: TransportOption;
  /**
   * Working directory passed to the ACP front. Absolute path
   * recommended (ACP requires absolute `cwd`).
   */
  cwd?: string;
  /**
   * Extra env vars merged into the subprocess env.
   */
  env?: Record<string, string>;
  /**
   * Ceiling on the wait for the first
   * `available_commands_update` notification. Default 10 000 ms.
   * On expiry the adapter throws
   * {@link CommandsUnavailableError} with `reason: "timeout"`.
   */
  timeoutMs?: number;
  /**
   * Cancellation signal. When aborted the wait resolves and the
   * adapter throws {@link CommandsUnavailableError} with
   * `reason: "timeout"` (signal- and timeout-driven aborts share the
   * same surfaced reason — both mean "no snapshot captured before the
   * ceiling").
   */
  signal?: AbortSignal;
}

/**
 * Why the fast-channel produced no snapshot.
 *
 * - `no_fast_channel` — the requested transport has no fast-channel
 *   implementation for this runtime (e.g. CLI on Claude today).
 * - `timeout` — the wait for the first
 *   `available_commands_update` notification exceeded
 *   `FetchCommandsOptions.timeoutMs` (or the caller's `signal`
 *   aborted before the snapshot arrived).
 * - `front_not_piloted` — the ACP front for this runtime is not
 *   piloted (cursor today).
 */
export type CommandsUnavailableReason =
  | "no_fast_channel"
  | "timeout"
  | "front_not_piloted";

// FR-L42
/**
 * Typed error surfaced by `RuntimeAdapter.fetchCommands` when no
 * snapshot can be produced. Always synchronous for
 * `no_fast_channel` / `front_not_piloted`; awaited for `timeout`.
 */
export class CommandsUnavailableError extends Error {
  /** Runtime the caller targeted. */
  readonly runtime: RuntimeId;
  /** Transport the caller picked. */
  readonly transport: TransportOption;
  /** Why no snapshot was produced. */
  readonly reason: CommandsUnavailableReason;

  /**
   * Construct a typed unavailable-channel error.
   *
   * @param runtime Runtime the caller targeted.
   * @param transport Transport the caller picked.
   * @param reason Why no snapshot was produced.
   * @param opts Optional `{ cause }` for chained diagnostics.
   */
  constructor(
    runtime: RuntimeId,
    transport: TransportOption,
    reason: CommandsUnavailableReason,
    opts?: { cause?: unknown },
  ) {
    super(messageFor(runtime, transport, reason), opts);
    this.name = "CommandsUnavailableError";
    this.runtime = runtime;
    this.transport = transport;
    this.reason = reason;
  }
}

function messageFor(
  runtime: RuntimeId,
  transport: TransportOption,
  reason: CommandsUnavailableReason,
): string {
  switch (reason) {
    case "no_fast_channel":
      return `commands fast-channel unavailable for runtime=${runtime} ` +
        `transport=${transport}: no fast-channel implementation ` +
        `(use fetchCapabilitiesSlow for the slow LLM-probed path)`;
    case "timeout":
      return `commands fast-channel unavailable for runtime=${runtime} ` +
        `transport=${transport}: timed out waiting for ` +
        `available_commands_update`;
    case "front_not_piloted":
      return `commands fast-channel unavailable for runtime=${runtime} ` +
        `transport=${transport}: ACP front is not piloted yet (see ` +
        `runtime/acp/fronts.ts)`;
  }
}
