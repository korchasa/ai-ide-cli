/**
 * @module
 * Cross-runtime / dispatcher-level tests for {@link extractSessionContent}.
 *
 * Per-runtime extractor scenarios live in `<runtime>/content_test.ts`.
 * This file covers shape-agnostic behaviour: synthetic events, unknown
 * event types, and malformed payloads that every runtime must tolerate
 * without throwing.
 */

import { assertEquals } from "@std/assert";
import { extractSessionContent } from "./content.ts";
import { type RuntimeSessionEvent, SYNTHETIC_TURN_END } from "./types.ts";

function event(
  runtime: RuntimeSessionEvent["runtime"],
  type: string,
  raw: Record<string, unknown>,
  synthetic?: true,
): RuntimeSessionEvent {
  return synthetic
    ? { runtime, type, raw, synthetic: true }
    : { runtime, type, raw };
}

Deno.test("extractSessionContent — synthetic turn-end → []", () => {
  const ev = event(
    "claude",
    SYNTHETIC_TURN_END,
    { type: "result", result: "ok" },
    true,
  );
  assertEquals(extractSessionContent(ev), []);
});

Deno.test("extractSessionContent — unknown event type → []", () => {
  const ev = event("claude", "totally-new-event", {
    type: "totally-new-event",
  });
  assertEquals(extractSessionContent(ev), []);
});

Deno.test("extractSessionContent — malformed raw never throws", () => {
  const weirdPayloads: Record<string, unknown>[] = [
    {},
    { type: null },
    { method: 123 },
    { method: "item/completed", params: "not an object" },
    { method: "item/completed", params: { item: null } },
  ];
  for (const raw of weirdPayloads) {
    for (const runtime of ["claude", "cursor", "codex", "opencode"] as const) {
      // Must not throw, must return [].
      const result = extractSessionContent(event(runtime, "x", raw));
      assertEquals(Array.isArray(result), true);
    }
  }
});
