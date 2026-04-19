/**
 * @module
 * Unit tests for the runtime-neutral normalized-content extractor.
 *
 * Tests feed synthetic {@link RuntimeSessionEvent} payloads directly —
 * no subprocess, no stubs — because the extractor is pure. Each runtime
 * gets its own group matching the test matrix in
 * `documents/tasks/2026-04-19-normalize-event-content-plan.md`.
 */

import { assertEquals } from "@std/assert";
import { extractSessionContent, type NormalizedContent } from "./content.ts";
import { type RuntimeSessionEvent, SYNTHETIC_TURN_END } from "./types.ts";
import { OPENCODE_HITL_MCP_TOOL_NAME } from "../opencode/hitl-mcp.ts";

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

// ───────────── Claude ─────────────

Deno.test("extractSessionContent — claude assistant text block → cumulative text", () => {
  const ev = event("claude", "assistant", {
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
  const ev = event("claude", "assistant", {
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
  const ev = event("claude", "assistant", {
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
  const ev = event("claude", "assistant", {
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
  const ev = event("claude", "result", {
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
  const ev = event("claude", "result", {
    type: "result",
    result: "",
    is_error: false,
  });
  assertEquals(extractSessionContent(ev), [{ kind: "final", text: "" }]);
});

Deno.test("extractSessionContent — claude system init → no content", () => {
  const ev = event("claude", "system", {
    type: "system",
    subtype: "init",
    session_id: "abc",
  });
  assertEquals(extractSessionContent(ev), []);
});

Deno.test("extractSessionContent — claude malformed assistant (no message) → []", () => {
  const ev = event("claude", "assistant", { type: "assistant" });
  assertEquals(extractSessionContent(ev), []);
});

Deno.test("extractSessionContent — claude malformed content (non-array) → []", () => {
  const ev = event("claude", "assistant", {
    type: "assistant",
    message: { content: "not an array" },
  });
  assertEquals(extractSessionContent(ev), []);
});

Deno.test("extractSessionContent — claude tool_use missing name → skipped", () => {
  const ev = event("claude", "assistant", {
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

// ───────────── Cursor (same extractor as Claude) ─────────────

Deno.test("extractSessionContent — cursor assistant text → cumulative (same shape as claude)", () => {
  const ev = event("cursor", "assistant", {
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
    "cursor",
    "system",
    { type: "system", subtype: "init", session_id: "chat_1" },
    true,
  );
  assertEquals(extractSessionContent(ev), []);
});

Deno.test("extractSessionContent — cursor synthetic send_failed → []", () => {
  const ev = event(
    "cursor",
    "error",
    { type: "error", subtype: "send_failed", error: "boom" },
    true,
  );
  assertEquals(extractSessionContent(ev), []);
});

Deno.test("extractSessionContent — cursor result → final text", () => {
  const ev = event("cursor", "result", {
    type: "result",
    result: "cursor reply",
  });
  assertEquals(extractSessionContent(ev), [
    { kind: "final", text: "cursor reply" },
  ]);
});

// ───────────── Codex ─────────────

Deno.test("extractSessionContent — codex item/agentMessage/delta → delta text", () => {
  const ev = event("codex", "delta", {
    method: "item/agentMessage/delta",
    params: { threadId: "t", turnId: "u", itemId: "i", delta: "Hi" },
  });
  assertEquals(extractSessionContent(ev), [
    { kind: "text", text: "Hi", cumulative: false },
  ]);
});

Deno.test("extractSessionContent — codex agentMessage item/completed → final text from item.text", () => {
  // v2 camelCase type; agentMessage carries `text: string` directly
  // (NOT `content[*].text`). Verified against
  // `codex app-server generate-ts` output — see runtime/content.ts
  // @module docblock.
  const ev = event("codex", "completed", {
    method: "item/completed",
    params: {
      threadId: "t",
      turnId: "u",
      item: {
        type: "agentMessage",
        id: "m1",
        text: "Final answer.",
      },
    },
  });
  assertEquals(extractSessionContent(ev), [
    { kind: "final", text: "Final answer." },
  ]);
});

Deno.test("extractSessionContent — codex commandExecution → tool with verbatim input", () => {
  const ev = event("codex", "completed", {
    method: "item/completed",
    params: {
      item: {
        type: "commandExecution",
        id: "cmd1",
        command: "git status",
        cwd: "/tmp",
        status: "completed",
        exitCode: 0,
        aggregatedOutput: "clean",
        commandActions: [],
        durationMs: 42,
      },
    },
  });
  const out = extractSessionContent(ev);
  assertEquals(out.length, 1);
  assertEquals(out[0].kind, "tool");
  const t = out[0] as {
    name: string;
    id: string;
    input: Record<string, unknown>;
  };
  assertEquals(t.name, "commandExecution");
  assertEquals(t.id, "cmd1");
  assertEquals(t.input.command, "git status");
  assertEquals(t.input.exitCode, 0);
  // `id` and `type` stripped from input
  assertEquals(t.input.id, undefined);
  assertEquals(t.input.type, undefined);
});

Deno.test("extractSessionContent — codex mcpToolCall → name is <server>.<tool>", () => {
  const ev = event("codex", "completed", {
    method: "item/completed",
    params: {
      item: {
        type: "mcpToolCall",
        id: "mcp1",
        server: "fs",
        tool: "read_file",
        status: "success",
        arguments: { path: "a.ts" },
      },
    },
  });
  const out = extractSessionContent(ev);
  assertEquals(out.length, 1);
  assertEquals((out[0] as { name: string }).name, "fs.read_file");
});

Deno.test("extractSessionContent — codex fileChange → tool with name=fileChange", () => {
  const ev = event("codex", "completed", {
    method: "item/completed",
    params: {
      item: {
        type: "fileChange",
        id: "fc1",
        changes: [],
        status: "applied",
      },
    },
  });
  assertEquals(
    (extractSessionContent(ev)[0] as { name: string }).name,
    "fileChange",
  );
});

Deno.test("extractSessionContent — codex webSearch → tool with name=webSearch", () => {
  const ev = event("codex", "completed", {
    method: "item/completed",
    params: {
      item: { type: "webSearch", id: "ws1", query: "deno" },
    },
  });
  const out = extractSessionContent(ev);
  assertEquals((out[0] as { name: string }).name, "webSearch");
  assertEquals(
    (out[0] as { input: Record<string, unknown> }).input.query,
    "deno",
  );
});

Deno.test("extractSessionContent — codex dynamicToolCall → tool with name=item.tool", () => {
  const ev = event("codex", "completed", {
    method: "item/completed",
    params: {
      item: {
        type: "dynamicToolCall",
        id: "dyn1",
        tool: "my_tool",
        arguments: { x: 1 },
        status: "success",
      },
    },
  });
  assertEquals(
    (extractSessionContent(ev)[0] as { name: string }).name,
    "my_tool",
  );
});

Deno.test("extractSessionContent — codex reasoning / userMessage item types → []", () => {
  for (const itemType of ["reasoning", "userMessage", "plan", "imageView"]) {
    const ev = event("codex", "completed", {
      method: "item/completed",
      params: { item: { type: itemType, id: "r1" } },
    });
    assertEquals(extractSessionContent(ev), []);
  }
});

Deno.test("extractSessionContent — codex turn/started → []", () => {
  const ev = event("codex", "started", {
    method: "turn/started",
    params: { turn: { id: "t1" } },
  });
  assertEquals(extractSessionContent(ev), []);
});

Deno.test("extractSessionContent — codex malformed payload (no params) → []", () => {
  const ev = event("codex", "delta", { method: "item/agentMessage/delta" });
  assertEquals(extractSessionContent(ev), []);
});

Deno.test("extractSessionContent — codex completed without id → []", () => {
  const ev = event("codex", "completed", {
    method: "item/completed",
    params: { item: { type: "commandExecution", command: "ls" } },
  });
  assertEquals(extractSessionContent(ev), []);
});

// ───────────── OpenCode ─────────────

Deno.test("extractSessionContent — opencode message.part.updated text → cumulative", () => {
  const ev = event("opencode", "message.part.updated", {
    type: "message.part.updated",
    properties: { part: { type: "text", text: "running so far" } },
  });
  assertEquals(extractSessionContent(ev), [
    { kind: "text", text: "running so far", cumulative: true },
  ]);
});

Deno.test("extractSessionContent — opencode tool at completed state → tool content", () => {
  const ev = event("opencode", "message.part.updated", {
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
  const ev = event("opencode", "message.part.updated", {
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
  const ev = event("opencode", "message.part.updated", {
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
  const ev = event("opencode", "message.part.updated", {
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
  const ev = event("opencode", "message.part.updated", {
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
  const ev = event("opencode", "message.part.updated", {
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
  const ev = event("opencode", "session.idle", { type: "session.idle" });
  assertEquals(extractSessionContent(ev), []);
});

Deno.test("extractSessionContent — opencode malformed (no properties) → []", () => {
  const ev = event("opencode", "message.part.updated", {
    type: "message.part.updated",
  });
  assertEquals(extractSessionContent(ev), []);
});

// ───────────── Cross-cutting ─────────────

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
