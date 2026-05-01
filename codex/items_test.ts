/**
 * @module
 * Per-parser equivalence tests for the conceptual tool-item layer.
 *
 * Both wire formats — `codex exec --experimental-json` (snake_case) and
 * `codex app-server` (camelCase) — must lift their tool items into the
 * same {@link CodexConceptualItem} shape (id, kind, name, status). The
 * `input` map intentionally mirrors the source wire format and is
 * therefore checked for key presence rather than exact equality.
 */

import { assert, assertEquals } from "@std/assert";
import type { CodexExecItem } from "./exec-events.ts";
import {
  type CodexConceptualKind,
  parseAppServerItem,
  parseExecItem,
} from "./items.ts";

interface Scenario {
  readonly label: string;
  readonly kind: CodexConceptualKind;
  /** Display name on the snake (NDJSON exec) side. */
  readonly snakeName: string;
  /** Display name on the camel (app-server) side. */
  readonly camelName: string;
  readonly status?: string;
  readonly snake: Record<string, unknown>;
  readonly camel: Record<string, unknown>;
  readonly inputKeys: readonly string[];
}

const SCENARIOS: readonly Scenario[] = [
  {
    label: "command_execution / commandExecution",
    kind: "command_execution",
    snakeName: "command_execution",
    camelName: "commandExecution",
    status: "completed",
    snake: {
      id: "x1",
      type: "command_execution",
      command: "ls",
      status: "completed",
      exit_code: 0,
    },
    camel: {
      id: "x1",
      type: "commandExecution",
      command: "ls",
      status: "completed",
      exitCode: 0,
    },
    inputKeys: ["command", "status"],
  },
  {
    label: "file_change / fileChange",
    kind: "file_change",
    snakeName: "file_change",
    camelName: "fileChange",
    status: "applied",
    snake: {
      id: "f1",
      type: "file_change",
      changes: [],
      status: "applied",
    },
    camel: {
      id: "f1",
      type: "fileChange",
      changes: [],
      status: "applied",
    },
    inputKeys: ["changes", "status"],
  },
  {
    label: "mcp_tool_call / mcpToolCall",
    kind: "mcp_tool_call",
    // mcp_tool_call collapses to "<server>.<tool>" on both sides, so both
    // display names converge.
    snakeName: "fs.read_file",
    camelName: "fs.read_file",
    status: "completed",
    snake: {
      id: "m1",
      type: "mcp_tool_call",
      server: "fs",
      tool: "read_file",
      status: "completed",
      arguments: { path: "a.ts" },
    },
    camel: {
      id: "m1",
      type: "mcpToolCall",
      server: "fs",
      tool: "read_file",
      status: "completed",
      arguments: { path: "a.ts" },
    },
    inputKeys: ["arguments", "status"],
  },
];

for (const sc of SCENARIOS) {
  Deno.test(
    `parseExecItem / parseAppServerItem agree on ${sc.label}`,
    () => {
      const exec = parseExecItem(sc.snake as unknown as CodexExecItem);
      const appS = parseAppServerItem(sc.camel);
      assert(exec, "parseExecItem returned undefined");
      assert(appS, "parseAppServerItem returned undefined");
      assertEquals(exec!.id, appS!.id);
      assertEquals(exec!.kind, sc.kind);
      assertEquals(appS!.kind, sc.kind);
      assertEquals(exec!.name, sc.snakeName);
      assertEquals(appS!.name, sc.camelName);
      assertEquals(exec!.status, sc.status);
      assertEquals(appS!.status, sc.status);
      for (const key of sc.inputKeys) {
        assert(
          key in exec!.input,
          `parseExecItem dropped input key '${key}' for ${sc.label}`,
        );
        assert(
          key in appS!.input,
          `parseAppServerItem dropped input key '${key}' for ${sc.label}`,
        );
      }
    },
  );
}

Deno.test("parseExecItem — non-tool items return undefined", () => {
  assertEquals(
    parseExecItem({ id: "a1", type: "agent_message", text: "hi" }),
    undefined,
  );
  assertEquals(
    parseExecItem({ id: "r1", type: "reasoning", text: "..." }),
    undefined,
  );
  assertEquals(parseExecItem(undefined), undefined);
  assertEquals(parseExecItem(null), undefined);
});

Deno.test("parseAppServerItem — non-tool items / missing id return undefined", () => {
  assertEquals(
    parseAppServerItem({ id: "a1", type: "agentMessage", text: "hi" }),
    undefined,
  );
  assertEquals(
    parseAppServerItem({ type: "commandExecution", command: "ls" }),
    undefined,
  );
  assertEquals(parseAppServerItem(undefined), undefined);
  assertEquals(parseAppServerItem(null), undefined);
});

Deno.test("parseAppServerItem — dynamicToolCall name is item.tool", () => {
  const c = parseAppServerItem({
    id: "d1",
    type: "dynamicToolCall",
    tool: "my_tool",
    status: "success",
    arguments: { x: 1 },
  });
  assert(c);
  assertEquals(c!.kind, "dynamic_tool_call");
  assertEquals(c!.name, "my_tool");
});

Deno.test("parseAppServerItem — webSearch name is webSearch", () => {
  const c = parseAppServerItem({ id: "w1", type: "webSearch", query: "deno" });
  assert(c);
  assertEquals(c!.kind, "web_search");
  assertEquals(c!.name, "webSearch");
});
