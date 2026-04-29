/**
 * @module
 * Tests for {@link parseCursorStreamEvent} and
 * {@link unwrapCursorToolCall}. Sample payloads mirror the empirical
 * dump from `scripts/smoke.ts cursor-events` (see `cursor/stream.ts`).
 */

import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  type CursorAssistantEvent,
  type CursorResultEvent,
  type CursorSystemInitEvent,
  type CursorToolCallStartedEvent,
  parseCursorStreamEvent,
  unwrapCursorToolCall,
} from "./stream.ts";

Deno.test("parseCursorStreamEvent: returns null on blank input", () => {
  assertStrictEquals(parseCursorStreamEvent(""), null);
  assertStrictEquals(parseCursorStreamEvent("   "), null);
  assertStrictEquals(parseCursorStreamEvent("\n"), null);
});

Deno.test("parseCursorStreamEvent: returns null on invalid JSON", () => {
  assertStrictEquals(parseCursorStreamEvent("not-json"), null);
  assertStrictEquals(parseCursorStreamEvent("{"), null);
});

Deno.test("parseCursorStreamEvent: returns null when type is missing", () => {
  assertStrictEquals(
    parseCursorStreamEvent('{"foo":"bar"}'),
    null,
  );
});

Deno.test("parseCursorStreamEvent: returns null on JSON arrays / primitives", () => {
  assertStrictEquals(parseCursorStreamEvent("[1,2,3]"), null);
  assertStrictEquals(parseCursorStreamEvent("42"), null);
});

Deno.test("parseCursorStreamEvent: parses system/init", () => {
  const line = JSON.stringify({
    type: "system",
    subtype: "init",
    apiKeySource: "login",
    cwd: "/tmp/x",
    session_id: "sess-1",
    model: "Auto",
    permissionMode: "default",
  });
  const ev = parseCursorStreamEvent(line) as CursorSystemInitEvent;
  assertEquals(ev.type, "system");
  assertEquals(ev.subtype, "init");
  assertEquals(ev.apiKeySource, "login");
  assertEquals(ev.cwd, "/tmp/x");
  assertEquals(ev.session_id, "sess-1");
});

Deno.test("parseCursorStreamEvent: parses assistant event with text block", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hello world" }],
    },
    session_id: "sess-1",
    model_call_id: "mc-1",
    timestamp_ms: 123,
  });
  const ev = parseCursorStreamEvent(line) as CursorAssistantEvent;
  assertEquals(ev.type, "assistant");
  assertEquals(ev.message?.content?.[0].type, "text");
  assertEquals(ev.message?.content?.[0].text, "hello world");
});

Deno.test("parseCursorStreamEvent: parses tool_call/started with wrapper", () => {
  const line = JSON.stringify({
    type: "tool_call",
    subtype: "started",
    call_id: "call-1",
    tool_call: {
      readToolCall: { args: { path: "/tmp/foo.txt" } },
    },
    model_call_id: "mc-1",
    session_id: "sess-1",
    timestamp_ms: 123,
  });
  const ev = parseCursorStreamEvent(line) as CursorToolCallStartedEvent;
  assertEquals(ev.type, "tool_call");
  assertEquals(ev.subtype, "started");
  assertEquals(ev.call_id, "call-1");
  const unwrapped = unwrapCursorToolCall(ev.tool_call);
  assertEquals(unwrapped, {
    name: "read",
    args: { path: "/tmp/foo.txt" },
  });
});

Deno.test("parseCursorStreamEvent: parses result/success with usage", () => {
  const line = JSON.stringify({
    type: "result",
    subtype: "success",
    duration_ms: 1234,
    duration_api_ms: 1200,
    is_error: false,
    request_id: "req-1",
    result: "done",
    session_id: "sess-1",
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 200,
      cacheWriteTokens: 0,
    },
  });
  const ev = parseCursorStreamEvent(line) as CursorResultEvent;
  assertEquals(ev.type, "result");
  assertEquals(ev.subtype, "success");
  assertEquals(ev.usage?.inputTokens, 100);
  assertEquals(ev.usage?.cacheReadTokens, 200);
});

Deno.test("unwrapCursorToolCall: returns null on null/undefined wrapper", () => {
  assertStrictEquals(unwrapCursorToolCall(null), null);
  assertStrictEquals(unwrapCursorToolCall(undefined), null);
});

Deno.test("unwrapCursorToolCall: returns null on empty wrapper", () => {
  assertStrictEquals(unwrapCursorToolCall({}), null);
});

Deno.test("unwrapCursorToolCall: extracts name and args for read tool", () => {
  const out = unwrapCursorToolCall({
    readToolCall: { args: { path: "/tmp/x" } },
  });
  assertEquals(out, { name: "read", args: { path: "/tmp/x" } });
});

Deno.test("unwrapCursorToolCall: extracts name and args for grep tool", () => {
  const out = unwrapCursorToolCall({
    grepToolCall: {
      args: {
        pattern: "TODO",
        path: "/tmp/repo",
        outputMode: "count",
      },
    },
  });
  assertEquals(out?.name, "grep");
  assertEquals(out?.args?.pattern, "TODO");
});

Deno.test("unwrapCursorToolCall: surfaces error message on failed completion", () => {
  const out = unwrapCursorToolCall({
    readToolCall: {
      result: { error: { errorMessage: "File not found" } },
    },
  });
  assertEquals(out, { name: "read", errorMessage: "File not found" });
});

Deno.test("unwrapCursorToolCall: surfaces successful result block", () => {
  const out = unwrapCursorToolCall({
    grepToolCall: {
      result: { matches: 2, lines: ["a.ts:1", "b.ts:1"] },
    },
  });
  assertEquals(out?.name, "grep");
  assertEquals(out?.result?.matches, 2);
});

Deno.test("unwrapCursorToolCall: keeps unknown wrapper key as-is when ToolCall suffix missing", () => {
  // Forward-compat path: if upstream renames the wrapper convention,
  // we keep the raw key rather than chopping bytes off the end.
  const out = unwrapCursorToolCall({
    customWrapperKey: { args: { foo: 1 } },
  });
  assertEquals(out?.name, "customWrapperKey");
});
