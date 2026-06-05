import { assert, assertEquals, assertRejects } from "@std/assert";
import { ProcessRegistry } from "../../process-registry.ts";
import { invokeViaAcp, openSessionViaAcp } from "./adapter.ts";
import { AcpUnsupportedOptionError } from "./errors.ts";
import type { RuntimeInitInfo } from "../types.ts";

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

// FR-L17: the ACP invoke path must surface `model` on the onInit hook,
// matching the CLI adapters (which echo the runtime's effective model).
Deno.test("onInit fires with model from opts on ACP path", async () => {
  await withStubAcpFront({ script: HANDSHAKE_SCRIPT }, async () => {
    const registry = new ProcessRegistry();
    const captured: RuntimeInitInfo[] = [];
    await invokeViaAcp("claude", {
      processRegistry: registry,
      taskPrompt: "say ok",
      model: "claude-haiku-4-5-20251001",
      timeoutSeconds: 30,
      maxRetries: 0,
      retryDelaySeconds: 0,
      hooks: { onInit: (info) => captured.push(info) },
    });
    assertEquals(captured.length, 1);
    assertEquals(captured[0], {
      runtime: "claude",
      sessionId: "sess-1",
      model: "claude-haiku-4-5-20251001",
    });
  });
});

// FR-L17: when the caller did not pin a model, the field stays absent
// (mirrors CLI behaviour when the runtime discloses no model).
Deno.test("onInit omits model when opts.model is unset on ACP path", async () => {
  await withStubAcpFront({ script: HANDSHAKE_SCRIPT }, async () => {
    const registry = new ProcessRegistry();
    const captured: RuntimeInitInfo[] = [];
    await invokeViaAcp("claude", {
      processRegistry: registry,
      taskPrompt: "say ok",
      timeoutSeconds: 30,
      maxRetries: 0,
      retryDelaySeconds: 0,
      hooks: { onInit: (info) => captured.push(info) },
    });
    assertEquals(captured.length, 1);
    assertEquals(captured[0], { runtime: "claude", sessionId: "sess-1" });
    assert(!("model" in captured[0]));
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

// FR-L19: resume is capability-gated post-initialize. A front that does
// NOT advertise `loadSession` makes `resumeSessionId` throw — but now
// AFTER spawn + initialize, not synchronously at adapter entry. The throw
// still propagates as the SAME AcpUnsupportedOptionError class (the
// invoke retry loop re-throws it instead of wrapping it in an error
// result).
const NO_LOAD_SESSION_SCRIPT = `
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
      respond "$id" '{"protocolVersion":1,"agentCapabilities":{"loadSession":false}}'
      ;;
    *)
      respond "$id" 'null'
      ;;
  esac
done
`;

// FR-L19: a front advertising loadSession routes resumeSessionId to
// session/load. This stub FAILS session/new (so a mis-route is caught)
// and succeeds session/load, echoing modes so the mode RPC still runs.
const LOAD_SESSION_SCRIPT = `
shift; shift
respond() {
  local id="$1" payload="$2"
  printf '{"jsonrpc":"2.0","id":%s,"result":%s}\\n' "$id" "$payload"
}
fail() {
  local id="$1" msg="$2"
  printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32000,"message":"%s"}}\\n' "$id" "$msg"
}
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\\1/')
  method=$(printf '%s' "$line" | sed -E 's/.*"method":"([^"]+)".*/\\1/')
  case "$method" in
    initialize)
      respond "$id" '{"protocolVersion":1,"agentCapabilities":{"loadSession":true}}'
      ;;
    session/new)
      fail "$id" "session/new must not be called when resuming"
      ;;
    session/load)
      respond "$id" '{"modes":{"availableModes":[{"id":"plan"},{"id":"code"}],"currentModeId":"code"},"sessionConfigOptions":[]}'
      ;;
    session/set_mode|session/set_config_option)
      respond "$id" 'null'
      ;;
    session/prompt)
      printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"recalled"}}}\\n'
      respond "$id" '{"stopReason":"end_turn"}'
      ;;
    *)
      respond "$id" 'null'
      ;;
  esac
done
`;

Deno.test("invokeViaAcp throws AcpUnsupportedOptionError when resumeSessionId set but loadSession not advertised", async () => {
  await withStubAcpFront({ script: NO_LOAD_SESSION_SCRIPT }, async () => {
    const err = await assertRejects(
      () =>
        invokeViaAcp("claude", {
          processRegistry: new ProcessRegistry(),
          taskPrompt: "x",
          resumeSessionId: "abc",
          timeoutSeconds: 30,
          maxRetries: 0,
          retryDelaySeconds: 0,
        }),
      AcpUnsupportedOptionError,
      "resumeSessionId",
    );
    assertEquals(err.fields, ["resumeSessionId"]);
    assertEquals(err.runtime, "claude");
  });
});

Deno.test("invokeViaAcp routes resumeSessionId to session/load when loadSession advertised", async () => {
  await withStubAcpFront({ script: LOAD_SESSION_SCRIPT }, async () => {
    const result = await invokeViaAcp("claude", {
      processRegistry: new ProcessRegistry(),
      taskPrompt: "recall the fact",
      resumeSessionId: "sess-resumed",
      timeoutSeconds: 30,
      maxRetries: 0,
      retryDelaySeconds: 0,
    });
    // session/new is wired to FAIL — reaching a clean output proves the
    // resume routed through session/load instead.
    assert(result.output, `expected output, got ${JSON.stringify(result)}`);
    assertEquals(result.output.session_id, "sess-resumed");
    assertEquals(result.output.is_error, false);
    assert(result.output.result.includes("recalled"));
  });
});

Deno.test("invokeViaAcp lists multiple unsupported fields in declaration order", async () => {
  const err = await assertRejects(
    () =>
      invokeViaAcp("claude", {
        processRegistry: new ProcessRegistry(),
        taskPrompt: "x",
        strictMcpConfig: true,
        extraArgs: { "--foo": "bar" },
        timeoutSeconds: 30,
        maxRetries: 0,
        retryDelaySeconds: 0,
      }),
    AcpUnsupportedOptionError,
  );
  // FR-L19: resumeSessionId is no longer an entry-time field, so the
  // pre-spawn tuple surfaces only extraArgs + strictMcpConfig (tuple
  // order — not alphabetical, not call order).
  assertEquals(err.fields, ["extraArgs", "strictMcpConfig"]);
});

Deno.test("invokeViaAcp does NOT throw on empty extraArgs map", async () => {
  await withStubAcpFront({ script: HANDSHAKE_SCRIPT }, async () => {
    const result = await invokeViaAcp("claude", {
      processRegistry: new ProcessRegistry(),
      taskPrompt: "say ok",
      extraArgs: {},
      timeoutSeconds: 30,
      maxRetries: 0,
      retryDelaySeconds: 0,
    });
    assert(result.output, `expected output, got ${JSON.stringify(result)}`);
  });
});

Deno.test("invokeViaAcp does NOT throw on degraded-but-handled options", async () => {
  await withStubAcpFront({ script: HANDSHAKE_SCRIPT }, async () => {
    // allowedTools + systemPrompt stay on the warn path, not the throw path.
    const result = await invokeViaAcp("claude", {
      processRegistry: new ProcessRegistry(),
      taskPrompt: "say ok",
      allowedTools: ["Read"],
      systemPrompt: "be terse",
      timeoutSeconds: 30,
      maxRetries: 0,
      retryDelaySeconds: 0,
    });
    assert(result.output, `expected output, got ${JSON.stringify(result)}`);
  });
});

Deno.test("invokeViaAcp throw precedes degraded-options warn", async () => {
  let warned = false;
  const err = await assertRejects(
    () =>
      // Both a degraded field (allowedTools) AND an entry-time unsupported
      // one (strictMcpConfig) are set. The pre-spawn throw must win — the
      // warn loop must never run. (FR-L19: resumeSessionId is no longer an
      // entry-time field, so strictMcpConfig carries this invariant now.)
      invokeViaAcp("claude", {
        processRegistry: new ProcessRegistry(),
        taskPrompt: "x",
        allowedTools: ["Read"],
        strictMcpConfig: true,
        onCallbackError: () => {
          warned = true;
        },
        timeoutSeconds: 30,
        maxRetries: 0,
        retryDelaySeconds: 0,
      }),
    AcpUnsupportedOptionError,
  );
  assertEquals(err.fields, ["strictMcpConfig"]);
  assert(!warned, "degraded-options warn fired despite the unsupported throw");
});

// FR-L19: session path mirrors the invoke path — resume gated on
// loadSession, post-init, tearing the spawned front down on the throw.
Deno.test("openSessionViaAcp throws when resumeSessionId set but loadSession not advertised", async () => {
  await withStubAcpFront({ script: NO_LOAD_SESSION_SCRIPT }, async () => {
    const err = await assertRejects(
      () =>
        openSessionViaAcp("claude", {
          processRegistry: new ProcessRegistry(),
          resumeSessionId: "abc",
        }),
      AcpUnsupportedOptionError,
      "resumeSessionId",
    );
    assertEquals(err.fields, ["resumeSessionId"]);
  });
});

Deno.test("openSessionViaAcp routes resumeSessionId to session/load when advertised", async () => {
  await withStubAcpFront({ script: LOAD_SESSION_SCRIPT }, async () => {
    const session = await openSessionViaAcp("claude", {
      processRegistry: new ProcessRegistry(),
      resumeSessionId: "sess-resumed",
    });
    try {
      // session/new is wired to FAIL; a live handle proves session/load
      // routed instead. sessionId echoes the resumed id.
      assertEquals(session.sessionId, "sess-resumed");
      assertEquals(session.runtime, "claude");
    } finally {
      session.abort();
      await session.done;
    }
  });
});

Deno.test("openSessionViaAcp throws AcpUnsupportedOptionError when strictMcpConfig is set", async () => {
  const err = await assertRejects(
    () =>
      openSessionViaAcp("claude", {
        processRegistry: new ProcessRegistry(),
        strictMcpConfig: true,
      }),
    AcpUnsupportedOptionError,
    "strictMcpConfig",
  );
  assertEquals(err.fields, ["strictMcpConfig"]);
});

Deno.test("openSessionViaAcp accepts the session-allowed surface unchanged", async () => {
  await withStubAcpFront({ script: HANDSHAKE_SCRIPT }, async () => {
    const session = await openSessionViaAcp("claude", {
      processRegistry: new ProcessRegistry(),
    });
    try {
      assertEquals(session.sessionId, "sess-1");
    } finally {
      session.abort();
      await session.done;
    }
  });
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
