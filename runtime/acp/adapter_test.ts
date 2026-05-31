import { assert, assertEquals, assertRejects } from "@std/assert";
import { ProcessRegistry } from "../../process-registry.ts";
import { invokeViaAcp, openSessionViaAcp } from "./adapter.ts";

interface StubScript {
  /** Bash script body, executed by the PATH-stub. */
  script: string;
}

/**
 * Install a temporary `npx` stub that runs `script` and overrides PATH so
 * the spawned ACP front IS the stub. Restores PATH on cleanup.
 */
async function withStubAcpFront<T>(
  { script }: StubScript,
  fn: () => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "acp-adapter-stub-" });
  const stub = `${dir}/npx`;
  await Deno.writeTextFile(
    stub,
    `#!/usr/bin/env bash\n# ACP front stub\n${script}\n`,
  );
  await Deno.chmod(stub, 0o755);
  const prev = Deno.env.get("PATH") ?? "";
  Deno.env.set("PATH", `${dir}:${prev}`);
  try {
    return await fn();
  } finally {
    Deno.env.set("PATH", prev);
    try {
      await Deno.remove(dir, { recursive: true });
    } catch {
      // best-effort
    }
  }
}

const HANDSHAKE_SCRIPT = `
# Discard the npx args (-y @agentclientprotocol/claude-agent-acp@…).
shift; shift
respond() {
  local id="$1" payload="$2"
  printf '{"jsonrpc":"2.0","id":%s,"result":%s}\\n' "$id" "$payload"
}
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\\1/')
  method=$(printf '%s' "$line" | sed -E 's/.*"method":"([^"]+)".*/\\1/')
  case "$method" in
    initialize)
      respond "$id" '{"protocolVersion":1,"agentCapabilities":{}}'
      ;;
    session/new)
      respond "$id" '{"sessionId":"sess-1","modes":{"availableModes":[{"id":"plan"},{"id":"code"}],"currentModeId":"code"},"sessionConfigOptions":[]}'
      ;;
    session/set_mode|session/set_config_option)
      respond "$id" 'null'
      ;;
    session/prompt)
      printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"ok"}}}\\n'
      respond "$id" '{"stopReason":"end_turn"}'
      ;;
    *)
      respond "$id" 'null'
      ;;
  esac
done
`;

Deno.test("invokeViaAcp drives initialize → session/new → session/prompt to a result", async () => {
  await withStubAcpFront({ script: HANDSHAKE_SCRIPT }, async () => {
    const registry = new ProcessRegistry();
    const result = await invokeViaAcp("claude", {
      processRegistry: registry,
      taskPrompt: "say ok",
      timeoutSeconds: 30,
      maxRetries: 0,
      retryDelaySeconds: 0,
    });
    assert(result.output, `expected output, got ${JSON.stringify(result)}`);
    assertEquals(result.output.session_id, "sess-1");
    assertEquals(result.output.runtime, "claude");
    assertEquals(result.output.is_error, false);
    assert(result.output.result.includes("ok"));
  });
});

Deno.test("invokeViaAcp forwards permissionMode through session/set_mode", async () => {
  // Capture the requests on a tmp log inside the stub script.
  const logPath = await Deno.makeTempFile({
    prefix: "acp-modes-",
    suffix: ".log",
  });
  await withStubAcpFront(
    {
      script: `
shift; shift
respond() {
  local id="$1" payload="$2"
  printf '{"jsonrpc":"2.0","id":%s,"result":%s}\\n' "$id" "$payload"
}
while IFS= read -r line; do
  printf '%s\\n' "$line" >> '${logPath}'
  id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\\1/')
  method=$(printf '%s' "$line" | sed -E 's/.*"method":"([^"]+)".*/\\1/')
  case "$method" in
    initialize) respond "$id" '{}' ;;
    session/new) respond "$id" '{"sessionId":"sess-2","modes":{"availableModes":[{"id":"plan"},{"id":"code"}],"currentModeId":"code"}}' ;;
    session/set_mode) respond "$id" 'null' ;;
    session/prompt)
      printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"ok"}}}\\n'
      respond "$id" '{"stopReason":"end_turn"}' ;;
    *) respond "$id" 'null' ;;
  esac
done
`,
    },
    async () => {
      const registry = new ProcessRegistry();
      const result = await invokeViaAcp("claude", {
        processRegistry: registry,
        taskPrompt: "x",
        permissionMode: "plan",
        timeoutSeconds: 30,
        maxRetries: 0,
        retryDelaySeconds: 0,
      });
      assert(result.output);
    },
  );
  const log = await Deno.readTextFile(logPath);
  assert(log.includes('"method":"session/set_mode"'), "must call set_mode");
  assert(log.includes('"modeId":"plan"'), "must send modeId=plan");
  try {
    await Deno.remove(logPath);
  } catch { /* ignore */ }
});

Deno.test("invokeViaAcp surfaces rpc errors as runtime invoke error", async () => {
  await withStubAcpFront(
    {
      script: `
shift; shift
respond_err() {
  local id="$1"
  printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32602,"message":"bad cwd"}}\\n' "$id"
}
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\\1/')
  respond_err "$id"
done
`,
    },
    async () => {
      const registry = new ProcessRegistry();
      const result = await invokeViaAcp("claude", {
        processRegistry: registry,
        taskPrompt: "x",
        timeoutSeconds: 30,
        maxRetries: 0,
        retryDelaySeconds: 0,
      });
      assert(result.error, "expected error path");
      assert(result.error.includes("bad cwd"), result.error);
    },
  );
});

Deno.test("invokeViaAcp refuses non-pilot runtimes with a clear message", async () => {
  const registry = new ProcessRegistry();
  await assertRejects(
    async () =>
      // cursor front is pilot:false (needs local cursor-agent IDE) → must throw
      await invokeViaAcp("cursor", {
        processRegistry: registry,
        taskPrompt: "x",
        timeoutSeconds: 30,
        maxRetries: 0,
        retryDelaySeconds: 0,
      }).then((r) => {
        if (r.error) throw new Error(r.error);
        return r;
      }),
    Error,
    "not piloted",
  );
});

Deno.test("openSessionViaAcp returns a session with sessionId synchronously after handshake", async () => {
  await withStubAcpFront(
    {
      script: HANDSHAKE_SCRIPT,
    },
    async () => {
      const registry = new ProcessRegistry();
      const session = await openSessionViaAcp("claude", {
        processRegistry: registry,
      });
      try {
        assertEquals(session.sessionId, "sess-1");
        assertEquals(session.runtime, "claude");
      } finally {
        session.abort();
        await session.done;
      }
    },
  );
});
