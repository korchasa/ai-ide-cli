/**
 * @module
 * Unit tests for Codex's {@link NormalizedContent} extractor.
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
): RuntimeSessionEvent {
  return { runtime: "codex", type, raw };
}

Deno.test("extractSessionContent — codex item/agentMessage/delta → delta text", () => {
  const ev = event("delta", {
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
  // `codex app-server generate-ts` output — see codex/content.ts
  // @module docblock.
  const ev = event("completed", {
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
  const ev = event("completed", {
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
  const ev = event("completed", {
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
  const ev = event("completed", {
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
  const ev = event("completed", {
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
  const ev = event("completed", {
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
    const ev = event("completed", {
      method: "item/completed",
      params: { item: { type: itemType, id: "r1" } },
    });
    assertEquals(extractSessionContent(ev), []);
  }
});

Deno.test("extractSessionContent — codex turn/started → []", () => {
  const ev = event("started", {
    method: "turn/started",
    params: { turn: { id: "t1" } },
  });
  assertEquals(extractSessionContent(ev), []);
});

Deno.test("extractSessionContent — codex malformed payload (no params) → []", () => {
  const ev = event("delta", { method: "item/agentMessage/delta" });
  assertEquals(extractSessionContent(ev), []);
});

Deno.test("extractSessionContent — codex completed without id → []", () => {
  const ev = event("completed", {
    method: "item/completed",
    params: { item: { type: "commandExecution", command: "ls" } },
  });
  assertEquals(extractSessionContent(ev), []);
});
