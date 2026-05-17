import { assertEquals } from "@std/assert";
import {
  type CodexAgentMessageDeltaNotification,
  type CodexCommandExecutionItem,
  type CodexItemCompletedNotification,
  type CodexResponseProcessedNotification,
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

// FR-L26
Deno.test("multi-env fields parsed on turn", () => {
  const note: CodexUntypedNotification = {
    method: "turn/started",
    params: {
      threadId: "T1",
      turn: {
        id: "turn-1",
        status: "inProgress",
        environmentId: "env-A",
        cwd: "/work/repo",
      },
      environmentId: "env-A",
      cwd: "/work/repo",
    },
  };
  if (isCodexNotification(note, "turn/started")) {
    // First-class typed access — assignments below fail compile if the
    // optional fields are not typed as `string | undefined` (the
    // `[key: string]: unknown` index signature alone would type them
    // as `unknown` and reject the assignment).
    const turnEnvId: string | undefined = note.params.turn.environmentId;
    const turnCwd: string | undefined = note.params.turn.cwd;
    const paramsEnvId: string | undefined = note.params.environmentId;
    const paramsCwd: string | undefined = note.params.cwd;
    assertEquals(turnEnvId, "env-A");
    assertEquals(turnCwd, "/work/repo");
    assertEquals(paramsEnvId, "env-A");
    assertEquals(paramsCwd, "/work/repo");
  } else {
    throw new Error("expected turn/started narrow to match");
  }
});

// FR-L26
Deno.test("sticky-env field parsed on thread", () => {
  const note: CodexUntypedNotification = {
    method: "thread/started",
    params: {
      threadId: "T1",
      environmentId: "env-default",
      stickyEnvironment: true,
    },
  };
  if (isCodexNotification(note, "thread/started")) {
    // First-class typed access — assignments fail compile if the
    // optional fields are not typed as their narrow shape.
    const envId: string | undefined = note.params.environmentId;
    const sticky: boolean | undefined = note.params.stickyEnvironment;
    assertEquals(envId, "env-default");
    assertEquals(sticky, true);
  } else {
    throw new Error("expected thread/started narrow to match");
  }
});

// FR-L26
Deno.test("unknown variant produces fallback event", () => {
  const note: CodexUntypedNotification = {
    method: "future/method/not-yet-typed",
    params: { someField: 42, nested: { foo: "bar" } },
  };
  // Every known method discriminator rejects the unknown variant.
  assertEquals(isCodexNotification(note, "turn/started"), false);
  assertEquals(isCodexNotification(note, "turn/completed"), false);
  assertEquals(isCodexNotification(note, "thread/started"), false);
  assertEquals(isCodexNotification(note, "item/started"), false);
  assertEquals(isCodexNotification(note, "item/completed"), false);
  assertEquals(isCodexNotification(note, "response.processed"), false);
  assertEquals(isCodexNotification(note, "error"), false);
  // The raw method + params stay readable on the untyped side — no
  // exception, no silent drop.
  assertEquals(note.method, "future/method/not-yet-typed");
  assertEquals(note.params.someField, 42);
  assertEquals(
    (note.params.nested as Record<string, unknown>).foo,
    "bar",
  );
});

// FR-L26
Deno.test("isCodexNotification narrows response.processed", () => {
  const note: CodexUntypedNotification = {
    method: "response.processed",
    params: {
      threadId: "T1",
      turnId: "turn-1",
      responseId: "resp-1",
    },
  };
  if (isCodexNotification(note, "response.processed")) {
    // Compile-time check: typed params has threadId and turnId; the
    // forward-compat index signature carries the unverified
    // `responseId` field through without a cast.
    const typed: CodexResponseProcessedNotification = note;
    assertEquals(typed.params.threadId, "T1");
    assertEquals(typed.params.turnId, "turn-1");
    assertEquals(typed.params["responseId"], "resp-1");
  } else {
    throw new Error("expected response.processed narrow to match");
  }
});
