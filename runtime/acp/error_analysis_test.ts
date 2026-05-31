/**
 * @module
 * FR-L37: ACP-transport classifier wiring. Stub-driven tests that craft
 * JSON-RPC error envelopes, `PromptResponse.stopReason` variants, and
 * stderr-tail content; the adapter must thread them through
 * `analyzeRuntimeErrorSignal` and surface
 * `RuntimeInvokeResult.runtime_error` accordingly.
 */

import { assert, assertEquals } from "@std/assert";
import { ProcessRegistry } from "../../process-registry.ts";
import { invokeViaAcp } from "./adapter.ts";

interface StubScript {
  script: string;
}

async function withStubAcpFront<T>(
  { script }: StubScript,
  fn: () => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "acp-error-stub-" });
  const stub = `${dir}/npx`;
  await Deno.writeTextFile(
    stub,
    `#!/usr/bin/env bash\n# ACP error-analysis stub\n${script}\n`,
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

/**
 * Stub that returns `{stopReason}` on `session/prompt` and `null` on
 * every other request. Lets a test exercise the success-with-is_error
 * path of `invokeViaAcp` without touching the rpc-error code path.
 */
function stopReasonScript(stopReason: string): string {
  return `
shift; shift
respond() {
  local id="$1" payload="$2"
  printf '{"jsonrpc":"2.0","id":%s,"result":%s}\\n' "$id" "$payload"
}
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\\1/')
  method=$(printf '%s' "$line" | sed -E 's/.*"method":"([^"]+)".*/\\1/')
  case "$method" in
    initialize) respond "$id" '{}' ;;
    session/new) respond "$id" '{"sessionId":"sess-1","modes":{"availableModes":[{"id":"plan"},{"id":"code"}],"currentModeId":"code"},"sessionConfigOptions":[]}' ;;
    session/set_mode|session/set_config_option) respond "$id" 'null' ;;
    session/prompt)
      printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"ok"}}}\\n'
      respond "$id" '{"stopReason":"${stopReason}"}' ;;
    *) respond "$id" 'null' ;;
  esac
done
`;
}

/** Stub that fails `session/prompt` with a crafted JSON-RPC error. */
function rpcErrorScript(code: number, message: string): string {
  return `
shift; shift
respond() {
  local id="$1" payload="$2"
  printf '{"jsonrpc":"2.0","id":%s,"result":%s}\\n' "$id" "$payload"
}
respond_err() {
  local id="$1" code="$2" msg="$3"
  printf '{"jsonrpc":"2.0","id":%s,"error":{"code":%s,"message":"%s"}}\\n' "$id" "$code" "$msg"
}
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\\1/')
  method=$(printf '%s' "$line" | sed -E 's/.*"method":"([^"]+)".*/\\1/')
  case "$method" in
    initialize) respond "$id" '{}' ;;
    session/new) respond "$id" '{"sessionId":"sess-1","modes":{"availableModes":[{"id":"plan"},{"id":"code"}],"currentModeId":"code"},"sessionConfigOptions":[]}' ;;
    session/set_mode|session/set_config_option) respond "$id" 'null' ;;
    session/prompt) respond_err "$id" '${code}' '${message}' ;;
    *) respond "$id" 'null' ;;
  esac
done
`;
}

/**
 * Stub that fails `session/prompt` with an RPC error AND writes a
 * classifiable line to stderr — used to assert RPC-vs-stderr precedence.
 */
function rpcErrorWithStderrScript(
  code: number,
  rpcMessage: string,
  stderrLine: string,
): string {
  return `
shift; shift
respond() {
  local id="$1" payload="$2"
  printf '{"jsonrpc":"2.0","id":%s,"result":%s}\\n' "$id" "$payload"
}
respond_err() {
  local id="$1" code="$2" msg="$3"
  printf '{"jsonrpc":"2.0","id":%s,"error":{"code":%s,"message":"%s"}}\\n' "$id" "$code" "$msg"
}
printf '%s\\n' '${stderrLine}' >&2
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\\1/')
  method=$(printf '%s' "$line" | sed -E 's/.*"method":"([^"]+)".*/\\1/')
  case "$method" in
    initialize) respond "$id" '{}' ;;
    session/new) respond "$id" '{"sessionId":"sess-1","modes":{"availableModes":[{"id":"plan"},{"id":"code"}],"currentModeId":"code"},"sessionConfigOptions":[]}' ;;
    session/set_mode|session/set_config_option) respond "$id" 'null' ;;
    session/prompt) respond_err "$id" '${code}' '${rpcMessage}' ;;
    *) respond "$id" 'null' ;;
  esac
done
`;
}

/**
 * Stub that fails `session/new` (early-handshake error) so the adapter
 * hits the catch path with stderr noise but no `session/prompt` RPC
 * error. Used for stderr-only classification.
 */
function stderrOnlyScript(stderrLine: string): string {
  return `
shift; shift
respond() {
  local id="$1" payload="$2"
  printf '{"jsonrpc":"2.0","id":%s,"result":%s}\\n' "$id" "$payload"
}
respond_err() {
  local id="$1"
  printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32603,"message":"boom"}}\\n' "$id"
}
printf '%s\\n' '${stderrLine}' >&2
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\\1/')
  method=$(printf '%s' "$line" | sed -E 's/.*"method":"([^"]+)".*/\\1/')
  case "$method" in
    initialize) respond "$id" '{}' ;;
    session/new) respond_err "$id" ;;
    *) respond "$id" 'null' ;;
  esac
done
`;
}

const BASE_OPTS = {
  taskPrompt: "x",
  timeoutSeconds: 30,
  maxRetries: 0,
  retryDelaySeconds: 0,
} as const;

Deno.test("AcpRpcError surfaces runtime_error.kind on rpc failure path — rate_limit", async () => {
  await withStubAcpFront(
    { script: rpcErrorScript(-32000, "rate limit exceeded, try again later") },
    async () => {
      const registry = new ProcessRegistry();
      const result = await invokeViaAcp("claude", {
        ...BASE_OPTS,
        processRegistry: registry,
      });
      assert(result.error, "expected error path");
      assert(result.runtime_error, "expected runtime_error to be set");
      assertEquals(result.runtime_error.kind, "rate_limit");
      assertEquals(result.runtime_error.source, "error_string");
    },
  );
});

Deno.test("AcpRpcError surfaces runtime_error.kind on rpc failure path — auth", async () => {
  await withStubAcpFront(
    { script: rpcErrorScript(-32602, "invalid api key") },
    async () => {
      const registry = new ProcessRegistry();
      const result = await invokeViaAcp("claude", {
        ...BASE_OPTS,
        processRegistry: registry,
      });
      assert(result.error);
      assert(result.runtime_error);
      assertEquals(result.runtime_error.kind, "auth");
    },
  );
});

Deno.test("AcpRpcError -32603 internal error maps to runtime_error kind (low confidence)", async () => {
  await withStubAcpFront(
    { script: rpcErrorScript(-32603, "Internal server error") },
    async () => {
      const registry = new ProcessRegistry();
      const result = await invokeViaAcp("claude", {
        ...BASE_OPTS,
        processRegistry: registry,
      });
      assert(result.error);
      assert(result.runtime_error);
      assertEquals(result.runtime_error.kind, "runtime_error");
      assertEquals(result.runtime_error.confidence, "low");
    },
  );
});

Deno.test("stopReason maps to runtime_error.kind table — max_tokens → token_budget", async () => {
  await withStubAcpFront(
    { script: stopReasonScript("max_tokens") },
    async () => {
      const registry = new ProcessRegistry();
      const result = await invokeViaAcp("claude", {
        ...BASE_OPTS,
        processRegistry: registry,
      });
      assert(result.output, JSON.stringify(result));
      assertEquals(result.output.is_error, true);
      assert(result.runtime_error);
      assertEquals(result.runtime_error.kind, "token_budget");
    },
  );
});

Deno.test("stopReason maps to runtime_error.kind table — max_turn_requests → runtime_error", async () => {
  await withStubAcpFront(
    { script: stopReasonScript("max_turn_requests") },
    async () => {
      const registry = new ProcessRegistry();
      const result = await invokeViaAcp("claude", {
        ...BASE_OPTS,
        processRegistry: registry,
      });
      assert(result.output);
      assertEquals(result.output.is_error, true);
      assert(result.runtime_error);
      assertEquals(result.runtime_error.kind, "runtime_error");
      assertEquals(result.runtime_error.confidence, "medium");
    },
  );
});

Deno.test("stopReason maps to runtime_error.kind table — refusal → policy", async () => {
  await withStubAcpFront(
    { script: stopReasonScript("refusal") },
    async () => {
      const registry = new ProcessRegistry();
      const result = await invokeViaAcp("claude", {
        ...BASE_OPTS,
        processRegistry: registry,
      });
      assert(result.output);
      assertEquals(result.output.is_error, true);
      assert(result.runtime_error);
      assertEquals(result.runtime_error.kind, "policy");
    },
  );
});

Deno.test("stopReason end_turn → no runtime_error and is_error: false", async () => {
  await withStubAcpFront(
    { script: stopReasonScript("end_turn") },
    async () => {
      const registry = new ProcessRegistry();
      const result = await invokeViaAcp("claude", {
        ...BASE_OPTS,
        processRegistry: registry,
      });
      assert(result.output);
      assertEquals(result.output.is_error, false);
      assertEquals(result.runtime_error, undefined);
    },
  );
});

Deno.test("stopReason cancelled → is_error true, no runtime_error (consumer-initiated)", async () => {
  await withStubAcpFront(
    { script: stopReasonScript("cancelled") },
    async () => {
      const registry = new ProcessRegistry();
      const result = await invokeViaAcp("claude", {
        ...BASE_OPTS,
        processRegistry: registry,
      });
      assert(result.output);
      assertEquals(result.output.is_error, true);
      assertEquals(result.runtime_error, undefined);
    },
  );
});

Deno.test("unknown stopReason falls through to runtime_error (low confidence)", async () => {
  await withStubAcpFront(
    { script: stopReasonScript("totally_made_up") },
    async () => {
      const registry = new ProcessRegistry();
      const result = await invokeViaAcp("claude", {
        ...BASE_OPTS,
        processRegistry: registry,
      });
      assert(result.output);
      assertEquals(result.output.is_error, true);
      assert(result.runtime_error);
      assertEquals(result.runtime_error.kind, "runtime_error");
      assertEquals(result.runtime_error.confidence, "low");
    },
  );
});

Deno.test("stderr tail used as fallback runtime_error source when RPC has no classifiable text", async () => {
  await withStubAcpFront(
    {
      script: stderrOnlyScript(
        "[acp-front] quota exceeded for project free-tier",
      ),
    },
    async () => {
      const registry = new ProcessRegistry();
      const result = await invokeViaAcp("claude", {
        ...BASE_OPTS,
        processRegistry: registry,
      });
      assert(result.error);
      assert(result.runtime_error);
      assertEquals(result.runtime_error.kind, "quota");
      assertEquals(result.runtime_error.source, "stderr");
    },
  );
});

Deno.test("RPC analysis wins over stderr when both are classifiable (precedence)", async () => {
  await withStubAcpFront(
    {
      script: rpcErrorWithStderrScript(
        -32602,
        "invalid api key",
        "[acp-front] rate limit exceeded, retry in 5 minutes",
      ),
    },
    async () => {
      const registry = new ProcessRegistry();
      const result = await invokeViaAcp("claude", {
        ...BASE_OPTS,
        processRegistry: registry,
      });
      assert(result.error);
      assert(result.runtime_error);
      assertEquals(result.runtime_error.kind, "auth");
      assertEquals(result.runtime_error.source, "error_string");
    },
  );
});
