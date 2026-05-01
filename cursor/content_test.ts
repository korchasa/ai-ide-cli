/**
 * @module
 * Unit tests for Cursor's {@link NormalizedContent} extractor (FR-L30).
 *
 * Tests feed synthetic {@link RuntimeSessionEvent} payloads through the
 * runtime-neutral dispatcher because the extractor is pure and the
 * dispatcher is a one-line switch — exercising via `extractSessionContent`
 * keeps the public contract under test.
 */

import { assertEquals } from "@std/assert";
import { extractSessionContent } from "../runtime/content.ts";
import type { RuntimeSessionEvent } from "../runtime/types.ts";

function event(
  type: string,
  raw: Record<string, unknown>,
  synthetic?: true,
): RuntimeSessionEvent {
  return synthetic
    ? { runtime: "cursor", type, raw, synthetic: true }
    : { runtime: "cursor", type, raw };
}

Deno.test("extractSessionContent — cursor assistant text → cumulative", () => {
  const ev = event("assistant", {
    type: "assistant",
    message: {
      content: [{ type: "text", text: "cursor says hi" }],
    },
  });
  assertEquals(extractSessionContent(ev), [
    { kind: "text", text: "cursor says hi", cumulative: true },
  ]);
});

Deno.test("extractSessionContent — cursor synthetic init event → []", () => {
  const ev = event(
    "system",
    { type: "system", subtype: "init", session_id: "chat_1" },
    true,
  );
  assertEquals(extractSessionContent(ev), []);
});

Deno.test("extractSessionContent — cursor synthetic send_failed → []", () => {
  const ev = event(
    "error",
    { type: "error", subtype: "send_failed", error: "boom" },
    true,
  );
  assertEquals(extractSessionContent(ev), []);
});

Deno.test("extractSessionContent — cursor result → final text", () => {
  const ev = event("result", {
    type: "result",
    result: "cursor reply",
  });
  assertEquals(extractSessionContent(ev), [
    { kind: "final", text: "cursor reply" },
  ]);
});

Deno.test("extractSessionContent — cursor tool_call/started → tool entry (FR-L30)", () => {
  const ev = event("tool_call", {
    type: "tool_call",
    subtype: "started",
    call_id: "call-1",
    tool_call: {
      readToolCall: { args: { path: "/tmp/foo.txt" } },
    },
  });
  assertEquals(extractSessionContent(ev), [
    {
      kind: "tool",
      id: "call-1",
      name: "read",
      input: { path: "/tmp/foo.txt" },
    },
  ]);
});

Deno.test("extractSessionContent — cursor tool_call/completed → [] (no double-emit)", () => {
  const ev = event("tool_call", {
    type: "tool_call",
    subtype: "completed",
    call_id: "call-1",
    tool_call: {
      readToolCall: { result: { content: "hello" } },
    },
  });
  assertEquals(extractSessionContent(ev), []);
});

Deno.test("extractSessionContent — cursor tool_call/started without call_id → []", () => {
  const ev = event("tool_call", {
    type: "tool_call",
    subtype: "started",
    tool_call: { readToolCall: { args: {} } },
  });
  assertEquals(extractSessionContent(ev), []);
});

Deno.test("extractSessionContent — cursor thinking events → []", () => {
  const delta = event("thinking", {
    type: "thinking",
    subtype: "delta",
    text: "Let me think...",
  });
  const completed = event("thinking", {
    type: "thinking",
    subtype: "completed",
  });
  assertEquals(extractSessionContent(delta), []);
  assertEquals(extractSessionContent(completed), []);
});

Deno.test("extractSessionContent — cursor user event → []", () => {
  const ev = event("user", {
    type: "user",
    message: { role: "user", content: "hi" },
  });
  assertEquals(extractSessionContent(ev), []);
});

Deno.test("extractSessionContent — cursor assistant ignores legacy claude tool_use blocks", () => {
  // Claude inlines tool_use blocks inside assistant.message.content[];
  // Cursor never does this. If a stray block somehow appears, the
  // forked extractor should drop it (Claude tool_use is not part of
  // the cursor wire format).
  const ev = event("assistant", {
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "ok" },
        { type: "tool_use", id: "x", name: "Read" },
      ],
    },
  });
  assertEquals(extractSessionContent(ev), [
    { kind: "text", text: "ok", cumulative: true },
  ]);
});
