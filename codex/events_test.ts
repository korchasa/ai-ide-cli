import { assertEquals } from "@std/assert";
import {
  type CodexAgentMessageDeltaNotification,
  type CodexCommandExecutionItem,
  type CodexItemCompletedNotification,
  type CodexTurnCompletedNotification,
  type CodexTurnStartedNotification,
  type CodexUntypedNotification,
  isCodexNotification,
} from "./events.ts";

Deno.test("isCodexNotification narrows turn/started", () => {
  const note: CodexUntypedNotification = {
    method: "turn/started",
    params: {
      threadId: "T1",
      turn: {
        id: "turn-1",
        status: "inProgress",
      },
    },
  };
  if (isCodexNotification(note, "turn/started")) {
    // Compile-time check: `note.params.turn.id` is `string`, no cast.
    const typed: CodexTurnStartedNotification = note;
    assertEquals(typed.params.turn.id, "turn-1");
    assertEquals(typed.params.threadId, "T1");
  } else {
    throw new Error("expected narrow to match");
  }
});

Deno.test("isCodexNotification narrows turn/completed", () => {
  const note: CodexUntypedNotification = {
    method: "turn/completed",
    params: {
      threadId: "T1",
      turn: {
        id: "turn-1",
        status: "completed",
        durationMs: 4321,
      },
    },
  };
  if (isCodexNotification(note, "turn/completed")) {
    const typed: CodexTurnCompletedNotification = note;
    assertEquals(typed.params.turn.status, "completed");
    assertEquals(typed.params.turn.durationMs, 4321);
  } else {
    throw new Error("expected narrow to match");
  }
});

Deno.test("isCodexNotification narrows item/agentMessage/delta", () => {
  const note: CodexUntypedNotification = {
    method: "item/agentMessage/delta",
    params: {
      threadId: "T1",
      turnId: "turn-1",
      itemId: "msg-1",
      delta: "hello",
    },
  };
  if (isCodexNotification(note, "item/agentMessage/delta")) {
    const typed: CodexAgentMessageDeltaNotification = note;
    assertEquals(typed.params.delta, "hello");
    assertEquals(typed.params.itemId, "msg-1");
  } else {
    throw new Error("expected narrow to match");
  }
});

Deno.test("item/completed narrows on item.type discriminator", () => {
  const note: CodexUntypedNotification = {
    method: "item/completed",
    params: {
      threadId: "T1",
      turnId: "turn-1",
      item: {
        type: "commandExecution",
        id: "cmd-1",
        command: "ls",
        cwd: "/tmp",
        status: "completed",
        exitCode: 0,
        aggregatedOutput: "a\nb\n",
      },
    },
  };
  if (isCodexNotification(note, "item/completed")) {
    const completed: CodexItemCompletedNotification = note;
    if (completed.params.item.type === "commandExecution") {
      const cmd: CodexCommandExecutionItem = completed.params.item;
      assertEquals(cmd.command, "ls");
      assertEquals(cmd.exitCode, 0);
      assertEquals(cmd.status, "completed");
    } else {
      throw new Error("expected commandExecution item discriminator");
    }
  } else {
    throw new Error("expected narrow to match");
  }
});

Deno.test("isCodexNotification returns false for unknown methods", () => {
  const note: CodexUntypedNotification = {
    method: "future/method/not-yet-typed",
    params: { foo: "bar" },
  };
  assertEquals(isCodexNotification(note, "turn/started"), false);
  assertEquals(isCodexNotification(note, "item/completed"), false);
  // Raw `params` stays readable on the untyped side.
  assertEquals(note.params.foo, "bar");
});

Deno.test("item/started narrows mcpToolCall item", () => {
  const note: CodexUntypedNotification = {
    method: "item/started",
    params: {
      threadId: "T1",
      turnId: "turn-1",
      item: {
        type: "mcpToolCall",
        id: "mcp-1",
        server: "search",
        tool: "web",
        status: "inProgress",
        arguments: { query: "?" },
      },
    },
  };
  if (
    isCodexNotification(note, "item/started") &&
    note.params.item.type === "mcpToolCall"
  ) {
    assertEquals(note.params.item.server, "search");
    assertEquals(note.params.item.tool, "web");
  } else {
    throw new Error("expected mcpToolCall narrow to succeed");
  }
});
