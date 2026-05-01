/**
 * @module
 * Shared helpers used by every `*-adapter.ts` to wrap a runtime-specific
 * session handle into the runtime-neutral {@link RuntimeSession} contract.
 *
 * Factored from the four near-identical wrappers that used to live in
 * `runtime/{claude,opencode,cursor,codex}-adapter.ts`.
 */

import type { RuntimeId } from "../types.ts";
import {
  type RuntimeSession,
  type RuntimeSessionEvent,
  type RuntimeSessionStatus,
  SYNTHETIC_TURN_END,
} from "./types.ts";

/**
 * Structural shape of a runtime-specific session handle. Each runtime's
 * `openClaudeSession` / `openOpenCodeSession` / etc. returns a value that
 * satisfies this interface for its native event type `T`. Deliberately
 * minimal — the fields the adapter layer needs, nothing else.
 */
export interface InnerSessionHandle<T> {
  /**
   * Current session identifier. For runtimes where the id is known
   * synchronously (OpenCode, Cursor) this is a stable string. Claude
   * exposes a getter that returns `""` until the first init event is
   * parsed; the neutral wrapper reads this lazily so late population is
   * visible to consumers without re-wrapping.
   */
  readonly sessionId: string;
  /** Push a user message into the underlying transport. */
  send(content: string): Promise<void>;
  /** Single-consumer async iterator of native events (one-shot). */
  readonly events: AsyncIterableIterator<T>;
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
 *
 * When `isTurnEnd` is provided, the wrapper emits one
 * {@link SYNTHETIC_TURN_END} event **after** every native event for which
 * the predicate returns `true`. The native event still passes through
 * untouched, and `synthetic.raw` carries the same raw payload as the
 * native event so consumers who need richer per-runtime detail can reach
 * through. Adapters whose inner stream does not expose a turn-terminator
 * event (or that inject their own synthetics upstream, e.g. Codex) omit
 * the predicate.
 *
 * Reads `sessionId` lazily through a getter so runtimes that populate the
 * id after the first native event (Claude) stay in sync with the underlying
 * handle.
 */
export function adaptRuntimeSession<T>(
  runtime: RuntimeId,
  inner: InnerSessionHandle<T>,
  toEvent: (event: T) => RuntimeSessionEvent,
  isTurnEnd?: (event: T) => boolean,
): RuntimeSession {
  // Lazily defer to a fresh async generator on `[Symbol.asyncIterator]()`
  // so re-iteration delegates to `inner.events[Symbol.asyncIterator]()` —
  // which is a `SessionEventQueue` whose runtime guard throws. The
  // wrapper's `next` / `return` route through the active generator.
  let active: AsyncGenerator<RuntimeSessionEvent> | undefined;
  async function* mapEvents(): AsyncGenerator<RuntimeSessionEvent> {
    for await (const event of inner.events) {
      const neutral = toEvent(event);
      yield neutral;
      if (isTurnEnd?.(event)) {
        yield {
          runtime,
          type: SYNTHETIC_TURN_END,
          raw: neutral.raw,
          synthetic: true,
        };
      }
    }
  }
  const events: AsyncIterableIterator<RuntimeSessionEvent> = {
    [Symbol.asyncIterator](): AsyncIterableIterator<RuntimeSessionEvent> {
      // First call wires up the generator; subsequent calls re-enter
      // `inner.events[Symbol.asyncIterator]()` via a fresh `mapEvents()`
      // body, which trips the `SessionEventQueue` runtime guard on the
      // 2nd entry. Together with the type narrowing on the public field,
      // this preserves the documented one-shot contract at both layers.
      const gen = mapEvents();
      if (!active) active = gen;
      return gen;
    },
    next(): Promise<IteratorResult<RuntimeSessionEvent>> {
      if (!active) active = mapEvents();
      return active.next();
    },
    return(
      value?: RuntimeSessionEvent,
    ): Promise<IteratorResult<RuntimeSessionEvent>> {
      if (!active) {
        return Promise.resolve({ value, done: true });
      }
      return active.return(value as RuntimeSessionEvent);
    },
  };
  return {
    runtime,
    get sessionId() {
      return inner.sessionId;
    },
    send: (content: string) => inner.send(content),
    events,
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
 *
 * When `isTurnEnd` is provided, the wrapper fires the consumer callback a
 * second time with a {@link SYNTHETIC_TURN_END} event **after** each
 * native event matched by the predicate, mirroring the synthetic emitted
 * on the `events` iterable.
 */
export function adaptEventCallback<T>(
  onEvent: ((event: RuntimeSessionEvent) => void) | undefined,
  toEvent: (event: T) => RuntimeSessionEvent,
  isTurnEnd?: (event: T) => boolean,
): ((event: T) => void) | undefined {
  if (!onEvent) return undefined;
  return (event: T) => {
    const neutral = toEvent(event);
    onEvent(neutral);
    if (isTurnEnd?.(event)) {
      onEvent({
        runtime: neutral.runtime,
        type: SYNTHETIC_TURN_END,
        raw: neutral.raw,
        synthetic: true,
      });
    }
  };
}
