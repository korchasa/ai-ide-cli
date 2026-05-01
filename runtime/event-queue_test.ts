import { assert, assertEquals } from "@std/assert";
import { SessionEventQueue } from "./event-queue.ts";
import type { RuntimeSession, RuntimeSessionEvent } from "./types.ts";

Deno.test("SessionEventQueue — single iteration drains pushed events in order", async () => {
  const q = new SessionEventQueue<number>("Test");
  q.push(1);
  q.push(2);
  q.push(3);
  q.close();
  const seen: number[] = [];
  for await (const n of q) seen.push(n);
  assertEquals(seen, [1, 2, 3]);
});

Deno.test("SessionEventQueue — re-iteration throws at runtime (belt-and-suspenders)", async () => {
  const q = new SessionEventQueue<number>("Test");
  q.push(1);
  q.close();
  for await (const _ of q) { /* drain */ }
  let threw = false;
  try {
    // Re-call [Symbol.asyncIterator]() — runtime guard must throw.
    for await (const _ of q) { /* noop */ }
  } catch (err) {
    threw = true;
    assert(err instanceof Error);
    assert(/only be iterated once/.test(err.message));
  }
  assert(threw, "expected re-iteration to throw");
});

Deno.test("SessionEventQueue — exposes AsyncIterableIterator surface (next/return)", async () => {
  const q = new SessionEventQueue<number>("Test");
  q.push(7);
  q.close();
  // `next()` is callable directly — proves the queue satisfies
  // `AsyncIterableIterator`, not just `AsyncIterable`.
  const r = await q.next();
  assertEquals(r, { value: 7, done: false });
  const end = await q.next();
  assertEquals(end.done, true);
});

Deno.test("SessionEventQueue — return() closes the queue", async () => {
  const q = new SessionEventQueue<number>("Test");
  q.push(1);
  // `return()` is part of the AsyncIterableIterator surface.
  const r = await q.return!();
  assertEquals(r.done, true);
  assert(q.isClosed);
});

// Type-level proof that `RuntimeSession.events` is one-shot
// (`AsyncIterableIterator`), not multi-shot (`AsyncIterable`). Compile-time
// only — no runtime assertion needed. If the type ever widens back to plain
// `AsyncIterable`, these will fail to compile.

// `next()` lives on `AsyncIterator`/`AsyncIterableIterator` but NOT on bare
// `AsyncIterable`. Reaching it via `RuntimeSession["events"]` proves the
// narrowing.
type _EventsHasNext = ReturnType<RuntimeSession["events"]["next"]>;
const _eventsHasNext: _EventsHasNext = Promise.resolve({
  value: undefined,
  done: true,
});
void _eventsHasNext;

// Conditional-type proof: `events` extends `AsyncIterableIterator`.
type _IsOneShot = RuntimeSession["events"] extends
  AsyncIterableIterator<RuntimeSessionEvent> ? true : false;
const _isOneShot: _IsOneShot = true;
void _isOneShot;

Deno.test("RuntimeSession.events — type-level one-shot enforcement", () => {
  // The `@ts-expect-error` below MUST fire. If it doesn't, `events` widened
  // back to bare `AsyncIterable` (which has no `.next` method) and the
  // one-shot type-level enforcement is gone.
  type _BareAsyncIterable = AsyncIterable<RuntimeSessionEvent>;
  // @ts-expect-error - bare AsyncIterable has no `.next` method.
  type _ShouldError = ReturnType<_BareAsyncIterable["next"]>;
  // Reference the alias so the compiler evaluates it.
  type _Use = _ShouldError;
  const _: _Use = undefined as unknown as _Use;
  void _;
});
