/**
 * @module
 * Unit tests for OpenCode's {@link NormalizedContent} extractor.
 *
 * Tests feed synthetic {@link RuntimeSessionEvent} payloads through the
 * runtime-neutral dispatcher because the extractor is pure and the
 * dispatcher is a one-line switch — exercising via `extractSessionContent`
 * keeps the public contract under test.
 */

import { assertEquals } from "@std/assert";
import { extractSessionContent } from "../runtime/content.ts";
import type { RuntimeSessionEvent } from "../runtime/types.ts";
import { OPENCODE_HITL_MCP_TOOL_NAME } from "./hitl-mcp.ts";

function event(
  type: string,
  raw: Record<string, unknown>,
): RuntimeSessionEvent {
  return { runtime: "opencode", type, raw };
}

Deno.test("extractSessionContent — opencode message.part.updated text → cumulative", () => {
  const ev = event("message.part.updated", {
    type: "message.part.updated",
    properties: { part: { type: "text", text: "running so far" } },
  });
  assertEquals(extractSessionContent(ev), [
    { kind: "text", text: "running so far", cumulative: true },
  ]);
});

Deno.test("extractSessionContent — opencode tool at completed state → tool content", () => {
  const ev = event("message.part.updated", {
    type: "message.part.updated",
    properties: {
      part: {
        type: "tool",
        tool: "bash",
        id: "op_tool_1",
        state: {
          status: "completed",
          input: { command: "ls" },
          output: "a.ts",
        },
      },
    },
  });
  assertEquals(extractSessionContent(ev), [
    {
      kind: "tool",
      id: "op_tool_1",
      name: "bash",
      input: { command: "ls" },
    },
  ]);
});

Deno.test("extractSessionContent — opencode tool at failed state → tool content", () => {
  const ev = event("message.part.updated", {
    type: "message.part.updated",
    properties: {
      part: {
        type: "tool",
        tool: "edit",
        id: "op_tool_2",
        state: { status: "failed", input: { path: "x" } },
      },
    },
  });
  assertEquals(
    (extractSessionContent(ev)[0] as { kind: string }).kind,
    "tool",
  );
});

Deno.test("extractSessionContent — opencode tool at running state → []", () => {
  const ev = event("message.part.updated", {
    type: "message.part.updated",
    properties: {
      part: {
        type: "tool",
        tool: "bash",
        id: "x",
        state: { status: "running", input: { command: "sleep 1" } },
      },
    },
  });
  assertEquals(extractSessionContent(ev), []);
});

Deno.test("extractSessionContent — opencode tool at pending state → []", () => {
  const ev = event("message.part.updated", {
    type: "message.part.updated",
    properties: {
      part: {
        type: "tool",
        tool: "bash",
        id: "x",
        state: { status: "pending" },
      },
    },
  });
  assertEquals(extractSessionContent(ev), []);
});

Deno.test("extractSessionContent — opencode HITL tool → [] (filtered)", () => {
  const ev = event("message.part.updated", {
    type: "message.part.updated",
    properties: {
      part: {
        type: "tool",
        tool: OPENCODE_HITL_MCP_TOOL_NAME,
        id: "hitl_1",
        state: { status: "completed", input: {} },
      },
    },
  });
  assertEquals(extractSessionContent(ev), []);
});

Deno.test("extractSessionContent — opencode tool falls back to callID when id missing", () => {
  const ev = event("message.part.updated", {
    type: "message.part.updated",
    properties: {
      part: {
        type: "tool",
        tool: "bash",
        callID: "callid_1",
        state: { status: "completed", input: { cmd: "ls" } },
      },
    },
  });
  const out = extractSessionContent(ev);
  assertEquals((out[0] as { id: string }).id, "callid_1");
});

Deno.test("extractSessionContent — opencode session.idle → []", () => {
  const ev = event("session.idle", { type: "session.idle" });
  assertEquals(extractSessionContent(ev), []);
});

Deno.test("extractSessionContent — opencode malformed (no properties) → []", () => {
  const ev = event("message.part.updated", {
    type: "message.part.updated",
  });
  assertEquals(extractSessionContent(ev), []);
});
