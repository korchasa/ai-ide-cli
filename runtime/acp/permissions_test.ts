import { assertEquals } from "@std/assert";
import { createPermissionHandler } from "./permissions.ts";

Deno.test("request_permission denies by default when no callback supplied", async () => {
  const handler = createPermissionHandler({
    runtime: "claude",
    getTurn: () => 1,
  });
  const res = await handler({
    options: [
      { optionId: "allow", kind: "allow_once" },
      { optionId: "reject", kind: "reject_once" },
    ],
  });
  assertEquals(res, { outcome: { type: "selected", optionId: "reject" } });
});

Deno.test("request_permission falls back to cancelled when no reject option offered", async () => {
  const handler = createPermissionHandler({
    runtime: "claude",
    getTurn: () => 1,
  });
  const res = await handler({
    options: [{ optionId: "allow", kind: "allow_once" }],
  });
  assertEquals(res, { outcome: { type: "cancelled" } });
});

Deno.test("request_permission routes 'allow' decision through callback", async () => {
  const handler = createPermissionHandler({
    runtime: "claude",
    onToolUseObserved: () => "allow",
    getTurn: () => 1,
  });
  const res = await handler({
    options: [
      { optionId: "allow", kind: "allow_once" },
      { optionId: "reject", kind: "reject_once" },
    ],
  });
  assertEquals(res, { outcome: { type: "selected", optionId: "allow" } });
});

Deno.test("request_permission routes 'abort' decision through callback", async () => {
  const handler = createPermissionHandler({
    runtime: "claude",
    onToolUseObserved: () => "abort",
    getTurn: () => 1,
  });
  const res = await handler({
    options: [
      { optionId: "allow", kind: "allow_once" },
      { optionId: "reject", kind: "reject_once" },
    ],
  });
  assertEquals(res, { outcome: { type: "selected", optionId: "reject" } });
});

Deno.test("request_permission forwards toolCall metadata into info object", async () => {
  let captured: { name?: string; id?: string; turn?: number } = {};
  const handler = createPermissionHandler({
    runtime: "claude",
    onToolUseObserved: (info) => {
      captured = { name: info.name, id: info.id, turn: info.turn };
      return "allow";
    },
    getTurn: () => 7,
  });
  await handler({
    toolCall: { toolCallId: "tc_1", title: "Read", rawInput: { file: "x" } },
    options: [{ optionId: "allow", kind: "allow_once" }],
  });
  assertEquals(captured, { name: "Read", id: "tc_1", turn: 7 });
});
