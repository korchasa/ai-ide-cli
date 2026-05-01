/**
 * @module
 * Unit tests for Claude's {@link NormalizedContent} extractor.
 *
 * Tests feed synthetic {@link RuntimeSessionEvent} payloads through the
 * runtime-neutral dispatcher because the extractor is pure and the
 * dispatcher is a one-line switch — exercising via `extractSessionContent`
 * keeps the public contract under test.
 */

import { assertEquals } from "@std/assert";
import {
  extractSessionContent,
  type NormalizedContent,
} from "../runtime/content.ts";
import type { RuntimeSessionEvent } from "../runtime/types.ts";

function event(
  type: string,
  raw: Record<string, unknown>,
): RuntimeSessionEvent {
  return { runtime: "claude", type, raw };
}

Deno.test("extractSessionContent — claude assistant text block → cumulative text", () => {
  const ev = event("assistant", {
    type: "assistant",
    message: {
      content: [{ type: "text", text: "Hello" }],
    },
  });
  assertEquals(
    extractSessionContent(ev),
    [
      { kind: "text", text: "Hello", cumulative: true },
    ] satisfies NormalizedContent[],
  );
});

Deno.test("extractSessionContent — claude assistant tool_use block → tool invocation", () => {
  const ev = event("assistant", {
    type: "assistant",
    message: {
      content: [{
        type: "tool_use",
        id: "call_1",
        name: "Read",
        input: { file_path: "cli.ts" },
      }],
    },
  });
  assertEquals(extractSessionContent(ev), [
    {
      kind: "tool",
      id: "call_1",
      name: "Read",
      input: { file_path: "cli.ts" },
    },
  ]);
});

Deno.test("extractSessionContent — claude mixed text + tool_use preserves source order", () => {
  const ev = event("assistant", {
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Let me read it" },
        { type: "tool_use", id: "t1", name: "Read", input: { path: "a" } },
        { type: "text", text: " and then edit" },
        { type: "tool_use", id: "t2", name: "Edit", input: { path: "a" } },
      ],
    },
  });
  const out = extractSessionContent(ev);
  assertEquals(out.length, 4);
  assertEquals(out[0].kind, "text");
  assertEquals(out[1].kind, "tool");
  assertEquals((out[1] as { id: string }).id, "t1");
  assertEquals(out[2].kind, "text");
  assertEquals(out[3].kind, "tool");
  assertEquals((out[3] as { id: string }).id, "t2");
});

Deno.test("extractSessionContent — claude thinking block is skipped", () => {
  const ev = event("assistant", {
    type: "assistant",
    message: {
      content: [
        { type: "thinking", thinking: "internal" },
        { type: "text", text: "visible" },
      ],
    },
  });
  assertEquals(extractSessionContent(ev), [
    { kind: "text", text: "visible", cumulative: true },
  ]);
});

Deno.test("extractSessionContent — claude result → final text", () => {
  const ev = event("result", {
    type: "result",
    subtype: "success",
    result: "All done.",
    is_error: false,
  });
  assertEquals(extractSessionContent(ev), [
    { kind: "final", text: "All done." },
  ]);
});

Deno.test("extractSessionContent — claude result with empty string still emits final", () => {
  // Intentional: consumer decides whether to render an empty reply.
  const ev = event("result", {
    type: "result",
    result: "",
    is_error: false,
  });
  assertEquals(extractSessionContent(ev), [{ kind: "final", text: "" }]);
});

Deno.test("extractSessionContent — claude system init → no content", () => {
  const ev = event("system", {
    type: "system",
    subtype: "init",
    session_id: "abc",
  });
  assertEquals(extractSessionContent(ev), []);
});

Deno.test("extractSessionContent — claude malformed assistant (no message) → []", () => {
  const ev = event("assistant", { type: "assistant" });
  assertEquals(extractSessionContent(ev), []);
});

Deno.test("extractSessionContent — claude malformed content (non-array) → []", () => {
  const ev = event("assistant", {
    type: "assistant",
    message: { content: "not an array" },
  });
  assertEquals(extractSessionContent(ev), []);
});

Deno.test("extractSessionContent — claude tool_use missing name → skipped", () => {
  const ev = event("assistant", {
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "x" /* no name */ },
        { type: "text", text: "ok" },
      ],
    },
  });
  assertEquals(extractSessionContent(ev), [
    { kind: "text", text: "ok", cumulative: true },
  ]);
});
