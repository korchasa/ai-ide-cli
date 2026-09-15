/**
 * @module
 * FR-L39: retry-loop behaviour for `invokeViaAcp`. Stub-driven —
 * the stub counts its own invocations through a shared file so a single
 * `invokeViaAcp` call exercises multiple spawn-and-dispose cycles.
 */

import { assert, assertEquals } from "@std/assert";
import type { AcpFrontLauncher } from "./fronts.ts";
import { ProcessRegistry } from "../../process-registry.ts";
import { invokeViaAcp } from "./adapter.ts";

/**
 * Build a stub ACP front running `script` under bash and hand it to `fn`
 * as an `acpFront` override.
 *
 * Replaces the old PATH-stub named `npx`: the registry now launches the
 * absolute `Deno.execPath()`, which no PATH entry can shadow, so tests
 * drive the supported override seam instead.
 */
async function withCountingStubFront<T>(
  script: string,
  fn: (counterPath: string, front: AcpFrontLauncher) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "acp-retry-stub-" });
  const stub = `${dir}/front.sh`;
  const counter = `${dir}/counter`;
  await Deno.writeTextFile(counter, "0");
  await Deno.writeTextFile(
    stub,
    `#!/usr/bin/env bash\nCOUNTER='${counter}'\n${script}\n`,
  );
  await Deno.chmod(stub, 0o755);
  try {
    return await fn(counter, { cmd: "bash", args: [stub], pilot: true });
  } finally {
    try {
      await Deno.remove(dir, { recursive: true });
    } catch {
      // best-effort
    }
  }
}

const HANDSHAKE_REPLIES = `
respond() {
  local id="$1" payload="$2"
  printf '{"jsonrpc":"2.0","id":%s,"result":%s}\\n' "$id" "$payload"
}
respond_err() {
  local id="$1" code="$2" msg="$3"
  printf '{"jsonrpc":"2.0","id":%s,"error":{"code":%s,"message":"%s"}}\\n' "$id" "$code" "$msg"
}
`;

const BASE_OPTS = {
  taskPrompt: "x",
  timeoutSeconds: 30,
  retryDelaySeconds: 0,
} as const;

Deno.test("invokeViaAcp retries on rate_limit and succeeds on second attempt", async () => {
  const script = `
${HANDSHAKE_REPLIES}
ATTEMPT=$(cat "$COUNTER")
ATTEMPT=$((ATTEMPT + 1))
printf '%s' "$ATTEMPT" > "$COUNTER"
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\\1/')
  method=$(printf '%s' "$line" | sed -E 's/.*"method":"([^"]+)".*/\\1/')
  case "$method" in
    initialize) respond "$id" '{}' ;;
    session/new) respond "$id" '{"sessionId":"sess-1","modes":{"availableModes":[{"id":"plan"},{"id":"code"}],"currentModeId":"code"},"sessionConfigOptions":[]}' ;;
    session/set_mode|session/set_config_option) respond "$id" 'null' ;;
    session/prompt)
      if [ "$ATTEMPT" = "1" ]; then
        respond_err "$id" '-32000' 'rate limit exceeded, retry in 1 second'
      else
        printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"ok"}}}\\n'
        respond "$id" '{"stopReason":"end_turn"}'
      fi
      ;;
    *) respond "$id" 'null' ;;
  esac
done
`;
  await withCountingStubFront(script, async (counter, front) => {
    const registry = new ProcessRegistry();
    const result = await invokeViaAcp("claude", {
      ...BASE_OPTS,
      processRegistry: registry,
      acpFront: front,
      maxRetries: 1,
    });
    assert(result.output, JSON.stringify(result));
    assertEquals(result.output.is_error, false);
    assertEquals(result.runtime_error, undefined);
    const attempts = Number(await Deno.readTextFile(counter));
    assertEquals(attempts, 2, "expected two spawn attempts");
    assertEquals(registry.size, 0, "registry must be empty after loop exits");
  });
});

Deno.test("invokeViaAcp does NOT retry on auth — terminal classifier output", async () => {
  const script = `
${HANDSHAKE_REPLIES}
ATTEMPT=$(cat "$COUNTER")
ATTEMPT=$((ATTEMPT + 1))
printf '%s' "$ATTEMPT" > "$COUNTER"
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\\1/')
  method=$(printf '%s' "$line" | sed -E 's/.*"method":"([^"]+)".*/\\1/')
  case "$method" in
    initialize) respond "$id" '{}' ;;
    session/new) respond "$id" '{"sessionId":"sess-1"}' ;;
    session/set_mode|session/set_config_option) respond "$id" 'null' ;;
    session/prompt) respond_err "$id" '-32602' 'invalid api key' ;;
    *) respond "$id" 'null' ;;
  esac
done
`;
  await withCountingStubFront(script, async (counter, front) => {
    const registry = new ProcessRegistry();
    const result = await invokeViaAcp("claude", {
      ...BASE_OPTS,
      processRegistry: registry,
      acpFront: front,
      maxRetries: 3,
    });
    assert(result.error);
    assert(result.runtime_error);
    assertEquals(result.runtime_error.kind, "auth");
    const attempts = Number(await Deno.readTextFile(counter));
    assertEquals(attempts, 1, "auth must be terminal — only one attempt");
    assertEquals(registry.size, 0);
  });
});

Deno.test("invokeViaAcp retries on JSON-RPC -32603 internal error", async () => {
  const script = `
${HANDSHAKE_REPLIES}
ATTEMPT=$(cat "$COUNTER")
ATTEMPT=$((ATTEMPT + 1))
printf '%s' "$ATTEMPT" > "$COUNTER"
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\\1/')
  method=$(printf '%s' "$line" | sed -E 's/.*"method":"([^"]+)".*/\\1/')
  case "$method" in
    initialize) respond "$id" '{}' ;;
    session/new) respond "$id" '{"sessionId":"sess-1"}' ;;
    session/set_mode|session/set_config_option) respond "$id" 'null' ;;
    session/prompt)
      if [ "$ATTEMPT" -le "2" ]; then
        respond_err "$id" '-32603' 'Internal server error'
      else
        printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"ok"}}}\\n'
        respond "$id" '{"stopReason":"end_turn"}'
      fi
      ;;
    *) respond "$id" 'null' ;;
  esac
done
`;
  await withCountingStubFront(script, async (counter, front) => {
    const registry = new ProcessRegistry();
    const result = await invokeViaAcp("claude", {
      ...BASE_OPTS,
      processRegistry: registry,
      acpFront: front,
      maxRetries: 2,
    });
    assert(result.output, JSON.stringify(result));
    assertEquals(result.output.is_error, false);
    const attempts = Number(await Deno.readTextFile(counter));
    assertEquals(attempts, 3, "expected three spawn attempts");
    assertEquals(registry.size, 0);
  });
});

Deno.test("maxRetries 0 produces single-attempt error string identical to PoC shape", async () => {
  const script = `
${HANDSHAKE_REPLIES}
ATTEMPT=$(cat "$COUNTER")
ATTEMPT=$((ATTEMPT + 1))
printf '%s' "$ATTEMPT" > "$COUNTER"
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\\1/')
  method=$(printf '%s' "$line" | sed -E 's/.*"method":"([^"]+)".*/\\1/')
  case "$method" in
    initialize) respond "$id" '{}' ;;
    session/new) respond "$id" '{"sessionId":"sess-1"}' ;;
    session/set_mode|session/set_config_option) respond "$id" 'null' ;;
    session/prompt) respond_err "$id" '-32602' 'bad cwd' ;;
    *) respond "$id" 'null' ;;
  esac
done
`;
  await withCountingStubFront(script, async (counter, front) => {
    const registry = new ProcessRegistry();
    const result = await invokeViaAcp("claude", {
      ...BASE_OPTS,
      processRegistry: registry,
      acpFront: front,
      maxRetries: 0,
    });
    assert(result.error, "expected error path");
    assert(result.error.startsWith("acp(claude):"), result.error);
    assert(result.error.includes("bad cwd"), result.error);
    const attempts = Number(await Deno.readTextFile(counter));
    assertEquals(attempts, 1);
  });
});

Deno.test("retry sleep is abortable via external signal", async () => {
  const script = `
${HANDSHAKE_REPLIES}
ATTEMPT=$(cat "$COUNTER")
ATTEMPT=$((ATTEMPT + 1))
printf '%s' "$ATTEMPT" > "$COUNTER"
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\\1/')
  method=$(printf '%s' "$line" | sed -E 's/.*"method":"([^"]+)".*/\\1/')
  case "$method" in
    initialize) respond "$id" '{}' ;;
    session/new) respond "$id" '{"sessionId":"sess-1"}' ;;
    session/set_mode|session/set_config_option) respond "$id" 'null' ;;
    session/prompt) respond_err "$id" '-32000' 'rate limit exceeded' ;;
    *) respond "$id" 'null' ;;
  esac
done
`;
  await withCountingStubFront(script, async (counter, front) => {
    const registry = new ProcessRegistry();
    const controller = new AbortController();
    // Abort while the first retry sleep is in flight. First attempt
    // takes ~200ms (bash startup + RPC roundtrips), so 500ms
    // lands the abort safely inside the backoff window. Backoff base
    // is 10s — plenty of headroom against scheduler jitter.
    setTimeout(() => controller.abort("external abort"), 500);
    const result = await invokeViaAcp("claude", {
      ...BASE_OPTS,
      processRegistry: registry,
      acpFront: front,
      maxRetries: 3,
      retryDelaySeconds: 10,
      signal: controller.signal,
    });
    assert(result.error, JSON.stringify(result));
    assert(result.error.startsWith("Aborted:"), result.error);
    const attempts = Number(await Deno.readTextFile(counter));
    assertEquals(attempts, 1, "abort must short-circuit before next attempt");
    assertEquals(registry.size, 0);
  });
});
