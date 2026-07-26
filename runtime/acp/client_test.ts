import { assert, assertEquals, assertRejects } from "@std/assert";
import { ProcessRegistry } from "../../process-registry.ts";
import { AcpRpcError, AcpStdioClient } from "./client.ts";
import { AcpMethodNotFoundError } from "./inbound.ts";

async function withStubPeer<T>(
  script: string,
  fn: (cmd: string, args: readonly string[]) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "acp-client-stub-" });
  const stub = `${dir}/acp-peer.sh`;
  await Deno.writeTextFile(stub, `#!/usr/bin/env bash\n${script}\n`);
  await Deno.chmod(stub, 0o755);
  try {
    return await fn(stub, []);
  } finally {
    try {
      await Deno.remove(dir, { recursive: true });
    } catch {
      // best-effort
    }
  }
}

Deno.test("AcpStdioClient routes responses by id", async () => {
  // The stub echoes one JSON-RPC response with the same id it received.
  // Reads the first request from stdin, parses out the id with sed.
  const script = `
read -r line
id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\\1/')
printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":1}}\\n' "$id"
# Keep stdin open until parent closes us; ACP fronts hold the stream.
cat > /dev/null
`;
  await withStubPeer(script, async (cmd) => {
    const registry = new ProcessRegistry();
    const client = new AcpStdioClient({
      cmd,
      args: [],
      processRegistry: registry,
    });
    try {
      const result = await client.request<{ protocolVersion: number }>(
        "initialize",
        { protocolVersion: 1, clientCapabilities: {} },
      );
      assertEquals(result.protocolVersion, 1);
    } finally {
      await client.dispose();
    }
  });
});

Deno.test("AcpStdioClient surfaces inbound notifications via iterable", async () => {
  const script = `
read -r line
id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\\1/')
printf '{"jsonrpc":"2.0","method":"session/update","params":{"chunk":"hello"}}\\n'
printf '{"jsonrpc":"2.0","id":%s,"result":null}\\n' "$id"
cat > /dev/null
`;
  await withStubPeer(script, async (cmd) => {
    const registry = new ProcessRegistry();
    const client = new AcpStdioClient({
      cmd,
      args: [],
      processRegistry: registry,
    });
    try {
      const iter = client.notifications();
      const ackPromise = client.request("session/prompt", { sessionId: "x" });
      const first = await iter.next();
      assert(!first.done);
      assertEquals(first.value.method, "session/update");
      assertEquals(first.value.params?.chunk, "hello");
      await ackPromise;
    } finally {
      await client.dispose();
    }
  });
});

Deno.test("AcpStdioClient raises AcpRpcError on error envelope", async () => {
  const script = `
read -r line
id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\\1/')
printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32602,"message":"bad params"}}\\n' "$id"
cat > /dev/null
`;
  await withStubPeer(script, async (cmd) => {
    const registry = new ProcessRegistry();
    const client = new AcpStdioClient({
      cmd,
      args: [],
      processRegistry: registry,
    });
    try {
      const err = await assertRejects(
        () => client.request("session/new", { cwd: "/" }),
        AcpRpcError,
      );
      assertEquals(err.code, -32602);
      assertEquals(err.method, "session/new");
    } finally {
      await client.dispose();
    }
  });
});

/**
 * Drive one inbound request from a stub peer and capture the raw reply the
 * client wrote back. The peer parks our reply in `ackFile` instead of
 * echoing it inside another JSON envelope — no quote escaping, and the
 * assertion reads the literal wire bytes.
 */
async function captureInboundReply(
  method: string,
  onRequest: () => never,
): Promise<Record<string, unknown>> {
  const dir = await Deno.makeTempDir({ prefix: "acp-inbound-reply-" });
  const stub = `${dir}/acp-peer.sh`;
  const ackFile = `${dir}/ack.json`;
  const script = `#!/usr/bin/env bash
read -r line
id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\\1/')
printf '{"jsonrpc":"2.0","id":99,"method":"${method}","params":{}}\\n'
read -r ack
printf '%s' "$ack" > "${ackFile}"
printf '{"jsonrpc":"2.0","id":%s,"result":null}\\n' "$id"
cat > /dev/null
`;
  await Deno.writeTextFile(stub, script);
  await Deno.chmod(stub, 0o755);
  try {
    const client = new AcpStdioClient({
      cmd: stub,
      args: [],
      processRegistry: new ProcessRegistry(),
      onRequest,
    });
    try {
      await client.request("session/prompt", { sessionId: "x" });
    } finally {
      await client.dispose();
    }
    return JSON.parse(await Deno.readTextFile(ackFile)) as Record<
      string,
      unknown
    >;
  } finally {
    try {
      await Deno.remove(dir, { recursive: true });
    } catch {
      // best-effort
    }
  }
}

Deno.test("FR-L43 AcpStdioClient answers with the handler's JSON-RPC error code", async () => {
  const reply = await captureInboundReply(
    "session/request_elicitation",
    () => {
      throw new AcpMethodNotFoundError("claude", "session/request_elicitation");
    },
  );

  assertEquals(reply.id, 99);
  const error = reply.error as Record<string, unknown>;
  assertEquals(error.code, -32601);
  assert(
    String(error.message).includes("session/request_elicitation"),
    `error message must name the method, got: ${error.message}`,
  );
});

Deno.test("FR-L43 AcpStdioClient falls back to -32000 for a codeless handler throw", async () => {
  const reply = await captureInboundReply("terminal/create", () => {
    throw new Error("handler blew up");
  });

  const error = reply.error as Record<string, unknown>;
  assertEquals(error.code, -32000);
  assertEquals(error.message, "handler blew up");
});

Deno.test("AcpStdioClient handles inbound requests via handler", async () => {
  // Peer issues a session/request_permission to us, then waits for our
  // response with the same id, and finally echoes a result on its own
  // pending request so we can synchronise.
  const script = `
read -r line
id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\\1/')
printf '{"jsonrpc":"2.0","id":99,"method":"session/request_permission","params":{"options":[{"optionId":"reject_once","kind":"reject_once"}]}}\\n'
read -r ack
printf '{"jsonrpc":"2.0","id":%s,"result":null}\\n' "$id"
cat > /dev/null
`;
  await withStubPeer(script, async (cmd) => {
    const registry = new ProcessRegistry();
    let observed = false;
    const client = new AcpStdioClient({
      cmd,
      args: [],
      processRegistry: registry,
      onRequest: (req) => {
        observed = true;
        assertEquals(req.method, "session/request_permission");
        return { outcome: { type: "selected", optionId: "reject_once" } };
      },
    });
    try {
      await client.request("session/prompt", { sessionId: "x" });
      assert(observed, "expected inbound request handler to fire");
    } finally {
      await client.dispose();
    }
  });
});
