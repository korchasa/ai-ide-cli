import { assert, assertEquals } from "@std/assert";
import {
  type CodexExecAgentMessageItem,
  type CodexExecCommandExecutionItem,
  type CodexExecErrorEvent,
  type CodexExecErrorItem,
  type CodexExecEvent,
  type CodexExecFileChangeItem,
  type CodexExecItem,
  type CodexExecItemCompletedEvent,
  type CodexExecMcpToolCallItem,
  type CodexExecReasoningItem,
  type CodexExecThreadStartedEvent,
  type CodexExecTodoListItem,
  type CodexExecTurnCompletedEvent,
  type CodexExecTurnFailedEvent,
  type CodexExecUnknownEvent,
  type CodexExecUnknownItem,
  type CodexExecWebSearchItem,
  parseCodexExecEvent,
} from "./exec-events.ts";

// --- parseCodexExecEvent: top-level event types ---

Deno.test("parseCodexExecEvent — thread.started parses to CodexExecThreadStarted", () => {
  const event = parseCodexExecEvent(
    JSON.stringify({ type: "thread.started", thread_id: "thrd_abc" }),
  );
  assert(event !== null);
  assertEquals(event.type, "thread.started");
  const narrowed = event as CodexExecThreadStartedEvent;
  assertEquals(narrowed.thread_id, "thrd_abc");
});

Deno.test("parseCodexExecEvent — turn.completed parses with usage", () => {
  const event = parseCodexExecEvent(
    JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 1234,
        cached_input_tokens: 128,
        output_tokens: 256,
      },
    }),
  );
  assert(event !== null);
  assertEquals(event.type, "turn.completed");
  const narrowed = event as CodexExecTurnCompletedEvent;
  assertEquals(narrowed.usage?.input_tokens, 1234);
  assertEquals(narrowed.usage?.cached_input_tokens, 128);
  assertEquals(narrowed.usage?.output_tokens, 256);
});

Deno.test("parseCodexExecEvent — turn.failed parses with error", () => {
  const event = parseCodexExecEvent(
    JSON.stringify({
      type: "turn.failed",
      error: { message: "model refused" },
    }),
  );
  assert(event !== null);
  assertEquals(event.type, "turn.failed");
  const narrowed = event as CodexExecTurnFailedEvent;
  assertEquals(narrowed.error?.message, "model refused");
});

Deno.test("parseCodexExecEvent — top-level error parses", () => {
  const event = parseCodexExecEvent(
    JSON.stringify({ type: "error", message: "network down" }),
  );
  assert(event !== null);
  assertEquals(event.type, "error");
  const narrowed = event as CodexExecErrorEvent;
  assertEquals(narrowed.message, "network down");
});

Deno.test("parseCodexExecEvent — item.completed wraps a CodexExecItem", () => {
  const event = parseCodexExecEvent(
    JSON.stringify({
      type: "item.completed",
      item: { id: "m1", type: "agent_message", text: "Done." },
    }),
  );
  assert(event !== null);
  assertEquals(event.type, "item.completed");
  const narrowed = event as CodexExecItemCompletedEvent;
  assertEquals(narrowed.item.type, "agent_message");
  assertEquals(narrowed.item.id, "m1");
});

// --- parseCodexExecEvent: forward-compat / unknown ---

Deno.test("parseCodexExecEvent — unknown event type falls through with all fields", () => {
  const event = parseCodexExecEvent(
    JSON.stringify({ type: "turn.started", turn_id: "t1", future: 42 }),
  );
  assert(event !== null);
  // Discriminator preserved.
  assertEquals(event.type, "turn.started");
  // Cast to unknown variant proves the index signature carries arbitrary fields.
  const unknown = event as CodexExecUnknownEvent;
  assertEquals(unknown.turn_id, "t1");
  assertEquals(unknown.future, 42);
});

Deno.test("parseCodexExecEvent — invalid JSON returns null", () => {
  assertEquals(parseCodexExecEvent("not json"), null);
});

Deno.test("parseCodexExecEvent — empty/whitespace returns null", () => {
  assertEquals(parseCodexExecEvent(""), null);
  assertEquals(parseCodexExecEvent("   \t\n"), null);
});

Deno.test("parseCodexExecEvent — missing type field returns null", () => {
  assertEquals(parseCodexExecEvent(JSON.stringify({ foo: "bar" })), null);
});

Deno.test("parseCodexExecEvent — JSON array returns null", () => {
  assertEquals(parseCodexExecEvent(JSON.stringify([{ type: "x" }])), null);
});

Deno.test("parseCodexExecEvent — non-string type field returns null", () => {
  assertEquals(parseCodexExecEvent(JSON.stringify({ type: 42 })), null);
});

// --- CodexExecItem variants ---

function parseItemCompleted(item: CodexExecItem): CodexExecItem {
  const event = parseCodexExecEvent(
    JSON.stringify({ type: "item.completed", item }),
  );
  assert(event !== null);
  assertEquals(event.type, "item.completed");
  return (event as CodexExecItemCompletedEvent).item;
}

Deno.test("CodexExecItem — agent_message round-trip", () => {
  const item = parseItemCompleted({
    id: "m1",
    type: "agent_message",
    text: "hi",
  });
  assertEquals(item.type, "agent_message");
  const m = item as CodexExecAgentMessageItem;
  assertEquals(m.text, "hi");
});

Deno.test("CodexExecItem — command_execution round-trip", () => {
  const item = parseItemCompleted({
    id: "c1",
    type: "command_execution",
    command: "ls -la",
    status: "completed",
    exit_code: 0,
    aggregated_output: "file1\nfile2\n",
  });
  assertEquals(item.type, "command_execution");
  const c = item as CodexExecCommandExecutionItem;
  assertEquals(c.command, "ls -la");
  assertEquals(c.status, "completed");
  assertEquals(c.exit_code, 0);
  assertEquals(c.aggregated_output, "file1\nfile2\n");
});

Deno.test("CodexExecItem — file_change round-trip", () => {
  const item = parseItemCompleted({
    id: "f1",
    type: "file_change",
    status: "completed",
    changes: [
      { path: "a.ts", kind: "modify" },
      { path: "b.ts", kind: "create" },
    ],
  });
  assertEquals(item.type, "file_change");
  const f = item as CodexExecFileChangeItem;
  assertEquals(f.changes?.length, 2);
  assertEquals(f.changes?.[0].path, "a.ts");
  assertEquals(f.changes?.[1].kind, "create");
});

Deno.test("CodexExecItem — mcp_tool_call round-trip", () => {
  const item = parseItemCompleted({
    id: "x1",
    type: "mcp_tool_call",
    server: "search",
    tool: "web",
    status: "completed",
    arguments: { q: "deno" },
  });
  assertEquals(item.type, "mcp_tool_call");
  const m = item as CodexExecMcpToolCallItem;
  assertEquals(m.server, "search");
  assertEquals(m.tool, "web");
  assertEquals(m.status, "completed");
  assertEquals(m.arguments?.q, "deno");
});

Deno.test("CodexExecItem — web_search round-trip", () => {
  const item = parseItemCompleted({
    id: "w1",
    type: "web_search",
    query: "deno deploy docs",
  });
  assertEquals(item.type, "web_search");
  const w = item as CodexExecWebSearchItem;
  assertEquals(w.query, "deno deploy docs");
});

Deno.test("CodexExecItem — reasoning round-trip", () => {
  const item = parseItemCompleted({
    id: "r1",
    type: "reasoning",
    text: "thinking through edge cases",
  });
  assertEquals(item.type, "reasoning");
  const r = item as CodexExecReasoningItem;
  assertEquals(r.text, "thinking through edge cases");
});

Deno.test("CodexExecItem — todo_list round-trip", () => {
  const item = parseItemCompleted({
    id: "t1",
    type: "todo_list",
    items: [
      { text: "step one", status: "pending" },
      { text: "step two", status: "in_progress" },
    ],
  });
  assertEquals(item.type, "todo_list");
  const t = item as CodexExecTodoListItem;
  assertEquals(t.items?.length, 2);
  assertEquals(t.items?.[0].text, "step one");
  assertEquals(t.items?.[1].status, "in_progress");
});

Deno.test("CodexExecItem — error item round-trip", () => {
  const item = parseItemCompleted({
    id: "e1",
    type: "error",
    message: "tool blew up",
  });
  assertEquals(item.type, "error");
  const e = item as CodexExecErrorItem;
  assertEquals(e.message, "tool blew up");
});

Deno.test("CodexExecItem — unknown item type preserves fields via fallback", () => {
  const event = parseCodexExecEvent(
    JSON.stringify({
      type: "item.completed",
      item: { id: "u1", type: "future_kind", payload: { foo: "bar" } },
    }),
  );
  assert(event !== null);
  if (event.type !== "item.completed") {
    throw new Error("expected item.completed discriminator");
  }
  const item = (event as CodexExecItemCompletedEvent).item;
  assertEquals(item.type, "future_kind");
  const fallback = item as CodexExecUnknownItem;
  assertEquals(fallback.id, "u1");
  assertEquals(
    (fallback.payload as Record<string, unknown>).foo,
    "bar",
  );
});

// --- Compile-time discriminator coverage (the union exhausts) ---

Deno.test("CodexExecEvent — discriminator covers all known variants", () => {
  const events: CodexExecEvent[] = [
    { type: "thread.started", thread_id: "t" },
    { type: "turn.completed" },
    { type: "turn.failed" },
    { type: "error" },
    {
      type: "item.completed",
      item: { id: "x", type: "agent_message", text: "" },
    },
    { type: "future.unknown" },
  ];
  for (const event of events) {
    // Discriminator string is always present; the union remains
    // forward-compat via the unknown-event fallback variant.
    assert(typeof event.type === "string");
  }
});
