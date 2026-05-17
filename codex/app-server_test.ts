/**
 * @module
 * Unit tests for the transport-layer primitives backing
 * {@link import("./app-server.ts").CodexAppServerClient}. The full client
 * is exercised end-to-end via `codex/session_test.ts` (stubbed binary) and
 * the opt-in real-binary suite under `e2e/`. This file pins the smaller
 * invariants the queue must satisfy on its own — especially forward-compat
 * tolerance for Codex 0.122+ ThreadStore-backed payloads.
 */

import { assertEquals } from "@std/assert";
import { NotificationQueue } from "./app-server-internals.ts";
import type { CodexAppServerNotification } from "./app-server.ts";

// FR-L13: Codex 0.122+ ThreadStore-backed thread payloads no longer
// carry a local rollout-file path. The transport queue must round-trip
// such notifications field-agnostically — it does not inspect params.
Deno.test("thread without rollout path", async () => {
  const q = new NotificationQueue();
  const note: CodexAppServerNotification = {
    method: "thread/started",
    params: { threadId: "T1" },
  };
  q.push(note);
  q.close();

  const collected: CodexAppServerNotification[] = [];
  for await (const n of q) {
    collected.push(n);
  }
  assertEquals(collected.length, 1);
  assertEquals(collected[0].method, "thread/started");
  assertEquals(collected[0].params.threadId, "T1");
  // The absent `rolloutPath` field must surface as `undefined` on the
  // raw payload — no exception, no synthesized placeholder.
  assertEquals(collected[0].params.rolloutPath, undefined);
});
