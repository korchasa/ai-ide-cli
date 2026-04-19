/**
 * @module
 * Shared helpers used by every `*-adapter.ts` to wrap a runtime-specific
 * session handle into the runtime-neutral {@link RuntimeSession} contract.
 *
 * Factored from the four near-identical wrappers that used to live in
 * `runtime/{claude,opencode,cursor,codex}-adapter.ts`.
 */

import type { RuntimeId } from "../types.ts";
import type {
  RuntimeSession,
  RuntimeSessionEvent,
  RuntimeSessionStatus,
} from "./types.ts";

/**
 * Structural shape of a runtime-specific session handle. Each runtime's
 * `openClaudeSession` / `openOpenCodeSession` / etc. returns a value that
 * satisfies this interface for its native event type `T`. Deliberately
 * minimal — the fields the adapter layer needs, nothing else.
 */
export interface InnerSessionHandle<T> {
  /** Push a user message into the underlying transport. */
  send(content: string): Promise<void>;
  /** Single-consumer async iterable of native events. */
  readonly events: AsyncIterable<T>;
  /** Signal graceful shutdown (no-more-input). */
  endInput(): Promise<void>;
  /** SIGTERM / force-stop. Idempotent. */
  abort(reason?: string): void;
  /** Resolves after the underlying transport terminates. */
  readonly done: Promise<{
    exitCode: number | null;
    signal: Deno.Signal | null;
    stderr: string;
  }>;
}

/**
 * Wrap a runtime-specific session handle into the runtime-neutral
 * {@link RuntimeSession}. Converts native events to {@link RuntimeSessionEvent}
 * via the caller-supplied `toEvent` mapper and widens the terminal status
 * `signal` to `string | null`.
 */
export function adaptRuntimeSession<T>(
  runtime: RuntimeId,
  inner: InnerSessionHandle<T>,
  toEvent: (event: T) => RuntimeSessionEvent,
): RuntimeSession {
  return {
    runtime,
    send: (content: string) => inner.send(content),
    events: {
      async *[Symbol.asyncIterator]() {
        for await (const event of inner.events) {
          yield toEvent(event);
        }
      },
    },
    endInput: () => inner.endInput(),
    abort: (reason?: string) => inner.abort(reason),
    done: inner.done.then((status): RuntimeSessionStatus => ({
      exitCode: status.exitCode,
      signal: status.signal,
      stderr: status.stderr,
    })),
  };
}

/**
 * Adapt a consumer-supplied runtime-neutral `onEvent` callback to fire on
 * the runtime's native event type. Returns `undefined` when the consumer
 * did not provide a callback so call sites can thread the result directly
 * into the runtime-specific session opener.
 */
export function adaptEventCallback<T>(
  onEvent: ((event: RuntimeSessionEvent) => void) | undefined,
  toEvent: (event: T) => RuntimeSessionEvent,
): ((event: T) => void) | undefined {
  if (!onEvent) return undefined;
  return (event: T) => onEvent(toEvent(event));
}
