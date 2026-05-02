/**
 * @module
 * Private helpers backing {@link import("./app-server.ts").CodexAppServerClient}:
 * the unbounded notification queue plus small byte/abort-reason utilities.
 *
 * Split out so `codex/app-server.ts` can stay focused on the JSON-RPC client
 * itself. Not part of the public API surface — symbols here are imported by
 * the client only.
 */

import type { CodexAppServerNotification } from "./app-server.ts";

/**
 * Unbounded FIFO queue backing
 * {@link import("./app-server.ts").CodexAppServerClient.notifications}.
 *
 * Async iterator blocks on `next()` until a notification arrives or the
 * queue is closed. Can be iterated at most once; re-iteration throws.
 */
export class NotificationQueue
  implements AsyncIterable<CodexAppServerNotification> {
  private items: CodexAppServerNotification[] = [];
  private resolvers: Array<
    (r: IteratorResult<CodexAppServerNotification>) => void
  > = [];
  private closed = false;
  private iterated = false;

  push(event: CodexAppServerNotification): void {
    if (this.closed) return;
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value: event, done: false });
      return;
    }
    this.items.push(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const resolver of this.resolvers) {
      resolver({ value: undefined, done: true });
    }
    this.resolvers.length = 0;
  }

  [Symbol.asyncIterator](): AsyncIterator<CodexAppServerNotification> {
    if (this.iterated) {
      throw new Error(
        "CodexAppServerClient.notifications can only be iterated once",
      );
    }
    this.iterated = true;
    return {
      next: (): Promise<IteratorResult<CodexAppServerNotification>> => {
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
      },
      return: (): Promise<IteratorResult<CodexAppServerNotification>> => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

/** Concatenate captured byte chunks into a trimmed UTF-8 string. */
export function decodeConcat(chunks: Uint8Array[]): string {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(buf).trim();
}

/**
 * Resolve a human-readable reason string from an `AbortSignal`. Falls back
 * to `"manual abort"` when no signal/reason is set.
 */
export function abortReason(signal?: AbortSignal): string {
  if (!signal) return "manual abort";
  const reason = signal.reason;
  if (reason === undefined) return "manual abort";
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) return reason.message;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}
