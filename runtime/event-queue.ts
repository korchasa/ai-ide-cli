/**
 * @module
 * Shared single-consumer async FIFO queue used by every `openSession`
 * implementation for the `session.events` iterable. Factored out of the
 * four near-identical copies that used to live in each runtime's
 * `session.ts` (Claude / OpenCode / Cursor / Codex).
 *
 * Semantics:
 * - Unbounded FIFO.
 * - `next()` blocks until an item arrives or the queue is closed.
 * - `close()` terminates any pending `next()` callers and all subsequent
 *   iterations complete immediately.
 * - Single-iteration — re-iterating the same instance throws. The queue
 *   itself implements {@link AsyncIterableIterator}: `[Symbol.asyncIterator]()`
 *   returns the queue, so `for await` on a queue twice walks the same
 *   iterator and the runtime guard fires on the second entry. Together
 *   with the type-narrowing of `RuntimeSession.events` to
 *   `AsyncIterableIterator`, this encodes the one-shot contract at both
 *   the type and runtime layers.
 */

/**
 * Single-consumer async FIFO used as the backing store for
 * `RuntimeSession.events` and the per-runtime session `events` iterables.
 *
 * Implements {@link AsyncIterableIterator} so the one-shot contract is
 * visible at the type level — consumers receive an iterator (with `next` /
 * `return`), not a re-iterable iterable. The runtime guard on
 * `[Symbol.asyncIterator]()` stays as a belt-and-suspenders check against
 * structural-typing escapes.
 */
export class SessionEventQueue<T> implements AsyncIterableIterator<T> {
  private items: T[] = [];
  private resolvers: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;
  private iterated = false;
  private readonly label: string;

  /**
   * Construct an empty queue ready to accept pushes.
   *
   * @param label Short identifier used in the re-iteration error message
   *   (e.g. `"ClaudeSession"`, `"RuntimeSession"`). Purely diagnostic.
   */
  constructor(label: string = "SessionEventQueue") {
    this.label = label;
  }

  /** Enqueue an item. No-op after {@link close}. */
  push(event: T): void {
    if (this.closed) return;
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value: event, done: false });
      return;
    }
    this.items.push(event);
  }

  /**
   * Close the queue. Pending `next()` callers resolve with `done: true`.
   * Idempotent.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const resolver of this.resolvers) {
      resolver({ value: undefined, done: true });
    }
    this.resolvers.length = 0;
  }

  /** True after {@link close} has been called. */
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Pull the next item from the FIFO. Resolves with `{done:true}` once the
   * queue is closed and drained, otherwise blocks until {@link push} or
   * {@link close} fires.
   */
  next(): Promise<IteratorResult<T>> {
    const item = this.items.shift();
    if (item !== undefined) {
      return Promise.resolve({ value: item, done: false });
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  /**
   * Close the queue early. Mirrors the iterator-protocol `return()` — used
   * by `for await` loops that exit via `break`/`throw`.
   */
  return(): Promise<IteratorResult<T>> {
    this.close();
    return Promise.resolve({ value: undefined, done: true });
  }

  /**
   * Returns the queue itself — the queue is its own iterator. Throws on
   * a second call so `for await` loops cannot accidentally re-iterate the
   * same queue.
   */
  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    if (this.iterated) {
      throw new Error(`${this.label}.events can only be iterated once`);
    }
    this.iterated = true;
    return this;
  }
}
