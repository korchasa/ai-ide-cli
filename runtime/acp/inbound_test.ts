import { assert, assertEquals, assertRejects } from "@std/assert";
import type { CallbackErrorSource } from "../callback-safety.ts";
import {
  AcpMethodNotFoundError,
  createInboundRequestHandler,
  JSON_RPC_METHOD_NOT_FOUND,
} from "./inbound.ts";
import type { AcpPermissionRequest } from "./permissions.ts";

function permissionStub(seen: AcpPermissionRequest[]) {
  return (req: AcpPermissionRequest) => {
    seen.push(req);
    return Promise.resolve(
      { outcome: { type: "selected" as const, optionId: "allow_once" } },
    );
  };
}

Deno.test("FR-L43 inbound handler delegates session/request_permission", async () => {
  const seen: AcpPermissionRequest[] = [];
  const handler = createInboundRequestHandler({
    runtime: "claude",
    permissionHandler: permissionStub(seen),
  });

  const res = await handler({
    id: 1,
    method: "session/request_permission",
    params: { options: [{ optionId: "allow_once", kind: "allow_once" }] },
  });

  assertEquals(res, { outcome: { type: "selected", optionId: "allow_once" } });
  assertEquals(seen.length, 1);
  assertEquals(seen[0].options[0].optionId, "allow_once");
});

Deno.test("FR-L43 inbound handler rejects an unknown method with JSON-RPC method-not-found", async () => {
  const handler = createInboundRequestHandler({
    runtime: "codex",
    permissionHandler: permissionStub([]),
  });

  const err = await assertRejects(
    () =>
      Promise.resolve(
        handler({ id: 7, method: "session/request_elicitation", params: {} }),
      ),
    AcpMethodNotFoundError,
  );

  assertEquals(err.code, JSON_RPC_METHOD_NOT_FOUND);
  assertEquals(err.method, "session/request_elicitation");
  assertEquals(err.runtime, "codex");
  assert(
    err.message.includes("session/request_elicitation"),
    `message must name the method, got: ${err.message}`,
  );
});

Deno.test("FR-L43 inbound handler reports an unknown method through onCallbackError", async () => {
  const reported: Array<{ err: unknown; source: CallbackErrorSource }> = [];
  const handler = createInboundRequestHandler({
    runtime: "opencode",
    permissionHandler: permissionStub([]),
    onCallbackError: (err, source) => reported.push({ err, source }),
  });

  await assertRejects(
    () => Promise.resolve(handler({ id: 9, method: "fs/read_text_file" })),
    AcpMethodNotFoundError,
  );

  assertEquals(reported.length, 1);
  assertEquals(reported[0].source, "onEvent");
  assert(reported[0].err instanceof AcpMethodNotFoundError);
  assert(
    (reported[0].err as Error).message.includes("fs/read_text_file"),
    "reported error must name the rejected method",
  );
});

Deno.test("FR-L43 inbound handler keeps working after an unknown method", async () => {
  const seen: AcpPermissionRequest[] = [];
  const handler = createInboundRequestHandler({
    runtime: "claude",
    permissionHandler: permissionStub(seen),
    onCallbackError: () => {},
  });

  await assertRejects(
    () => Promise.resolve(handler({ id: 1, method: "terminal/create" })),
    AcpMethodNotFoundError,
  );
  const res = await handler({
    id: 2,
    method: "session/request_permission",
    params: { options: [{ optionId: "allow_once", kind: "allow_once" }] },
  });

  assertEquals(res, { outcome: { type: "selected", optionId: "allow_once" } });
  assertEquals(seen.length, 1);
});
