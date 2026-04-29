import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { getRuntimeAdapter } from "./index.ts";
import {
  _resetReasoningEffortWarning,
  _resetToolFilterWarning,
} from "./opencode-adapter.ts";

const opencodeRuntimeAdapter = getRuntimeAdapter("opencode");

/**
 * Replace `console.warn` with a capturing spy for the duration of `fn`.
 * Restores the original in `finally` so tests stay isolated even on throw.
 */
async function withWarnSpy<T>(
  fn: (calls: unknown[][]) => Promise<T> | T,
): Promise<T> {
  const calls: unknown[][] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => {
    calls.push(args);
  };
  try {
    return await fn(calls);
  } finally {
    console.warn = orig;
  }
}

/**
 * Swap `opencode` for a shell stub on PATH that execs a Deno-based fake
 * server mirroring the subset of the OpenCode HTTP API consumed by
 * {@link import("../opencode/session").openOpenCodeSession}.
 */
async function withStubOpenCode<T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "opencode-adapter-stub-" });
  const stubServerPath = `${dir}/stub-server.ts`;
  await Deno.writeTextFile(
    stubServerPath,
    `
const [hostname, portStr] = Deno.args;
const port = Number(portStr);
const capturePath = Deno.env.get("STUB_CAPTURE");
const enc = new TextEncoder();
let sseController: ReadableStreamDefaultController<Uint8Array> | null = null;
const server = Deno.serve({ hostname, port, onListen: () => {
  console.log(\`opencode server listening on http://\${hostname}:\${port}\`);
}}, async (req) => {
  const url = new URL(req.url);
  if (req.method === "POST" && url.pathname === "/session") {
    return new Response(JSON.stringify({ id: "ses_stub" }), {
      headers: { "Content-Type": "application/json" },
    });
  }
  if (req.method === "POST" && url.pathname.endsWith("/prompt_async")) {
    const body = await req.text();
    if (capturePath) {
      await Deno.writeTextFile(capturePath, body + "\\n", { append: true, create: true });
    }
    if (sseController) {
      sseController.enqueue(enc.encode(
        \`data: {"type":"message.part.updated","properties":{"sessionID":"ses_stub","part":{"type":"text","text":"ok"}}}\\n\\n\`,
      ));
      sseController.enqueue(enc.encode(
        \`data: {"type":"session.idle","properties":{"sessionID":"ses_stub"}}\\n\\n\`,
      ));
    }
    return new Response(null, { status: 204 });
  }
  if (req.method === "POST" && url.pathname.endsWith("/abort")) {
    return new Response("true", { headers: { "Content-Type": "application/json" } });
  }
  if (req.method === "GET" && url.pathname === "/event") {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        sseController = controller;
        controller.enqueue(enc.encode(
          \`data: {"type":"server.connected","properties":{}}\\n\\n\`,
        ));
      },
      cancel() { sseController = null; },
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream" },
    });
  }
  return new Response("not found", { status: 404 });
});
await server.finished;
`,
  );
  const denoPath = Deno.execPath();
  const binPath = `${dir}/opencode`;
  await Deno.writeTextFile(
    binPath,
    `#!/usr/bin/env bash
HOST=""
PORT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --hostname) HOST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    *) shift ;;
  esac
done
exec "${denoPath}" run --allow-net --allow-read --allow-write --allow-env "${stubServerPath}" "$HOST" "$PORT"
`,
  );
  await Deno.chmod(binPath, 0o755);
  const prevPath = Deno.env.get("PATH") ?? "";
  Deno.env.set("PATH", `${dir}:${prevPath}`);
  try {
    return await fn(dir);
  } finally {
    Deno.env.set("PATH", prevPath);
    try {
      await Deno.remove(dir, { recursive: true });
    } catch {
      // best-effort cleanup
    }
  }
}

Deno.test("opencodeRuntimeAdapter — declares session capability", () => {
  assertEquals(opencodeRuntimeAdapter.capabilities.session, true);
  assert(typeof opencodeRuntimeAdapter.openSession === "function");
});

Deno.test("opencodeRuntimeAdapter.openSession — yields normalized runtime events with raw payload", async () => {
  await withStubOpenCode(async () => {
    const session = await opencodeRuntimeAdapter.openSession!({});
    try {
      assertEquals(session.runtime, "opencode");
      await session.send("hi");
      const events: Array<{ runtime: string; type: string }> = [];
      for await (const ev of session.events) {
        events.push({ runtime: ev.runtime, type: ev.type });
        if (ev.type === "session.idle") break;
      }
      const hasPartUpdate = events.some((e) =>
        e.runtime === "opencode" && e.type === "message.part.updated"
      );
      const hasIdle = events.some((e) => e.type === "session.idle");
      assert(hasPartUpdate);
      assert(hasIdle);
    } finally {
      session.abort();
      await session.done;
    }
  });
});

Deno.test("opencodeRuntimeAdapter.openSession — onEvent receives normalized events", async () => {
  await withStubOpenCode(async () => {
    const observed: string[] = [];
    const session = await opencodeRuntimeAdapter.openSession!({
      onEvent: (e) => {
        assertEquals(e.runtime, "opencode");
        observed.push(e.type);
      },
    });
    try {
      await session.send("hi");
      for await (const ev of session.events) {
        if (ev.type === "session.idle") break;
      }
    } finally {
      session.abort();
      await session.done;
    }
    assert(observed.includes("server.connected"));
    assert(observed.includes("session.idle"));
  });
});

Deno.test("opencodeRuntimeAdapter.openSession — abort returns exit status on done", async () => {
  await withStubOpenCode(async () => {
    const session = await opencodeRuntimeAdapter.openSession!({});
    session.abort("test");
    const status = await session.done;
    assert(status.exitCode !== undefined || status.signal !== null);
  });
});

// --- Tool filter (FR-L24) ---

Deno.test("opencodeRuntimeAdapter — toolFilter capability is false", () => {
  assertEquals(opencodeRuntimeAdapter.capabilities.toolFilter, false);
});

Deno.test("opencodeRuntimeAdapter.invoke — malformed tool filter throws synchronously", () => {
  _resetToolFilterWarning();
  // `invoke` is not declared `async`, so the validator throw propagates
  // synchronously to the caller — `assertThrows`, not `assertRejects`.
  assertThrows(
    () =>
      opencodeRuntimeAdapter.invoke({
        taskPrompt: "ignored",
        timeoutSeconds: 1,
        maxRetries: 1,
        retryDelaySeconds: 1,
        allowedTools: ["Read"],
        disallowedTools: ["Bash"],
      }),
    Error,
    "mutually exclusive",
  );
});

Deno.test("opencodeRuntimeAdapter.invoke — empty allowedTools array throws synchronously", () => {
  _resetToolFilterWarning();
  assertThrows(
    () =>
      opencodeRuntimeAdapter.invoke({
        taskPrompt: "ignored",
        timeoutSeconds: 1,
        maxRetries: 1,
        retryDelaySeconds: 1,
        allowedTools: [],
      }),
    Error,
    "non-empty",
  );
});

Deno.test("opencodeRuntimeAdapter.openSession — warns once, subsequent session calls silent, reset re-enables warn", async () => {
  _resetToolFilterWarning();
  await withStubOpenCode(async () => {
    await withWarnSpy(async (calls) => {
      const s1 = await opencodeRuntimeAdapter.openSession!({
        allowedTools: ["Read"],
      });
      s1.abort();
      await s1.done;
      assertEquals(calls.length, 1);
      const s2 = await opencodeRuntimeAdapter.openSession!({
        allowedTools: ["Read"],
      });
      s2.abort();
      await s2.done;
      assertEquals(calls.length, 1, "second call must not warn again");
      _resetToolFilterWarning();
      const s3 = await opencodeRuntimeAdapter.openSession!({
        allowedTools: ["Read"],
      });
      s3.abort();
      await s3.done;
      assertEquals(calls.length, 2, "after reset, next call warns again");
      assert(
        String(calls[0][0]).includes("[opencode]"),
        "warning must attribute the runtime",
      );
    });
  });
});

Deno.test("opencodeRuntimeAdapter.openSession — no warn when typed fields are not set", async () => {
  _resetToolFilterWarning();
  await withStubOpenCode(async () => {
    await withWarnSpy(async (calls) => {
      const s = await opencodeRuntimeAdapter.openSession!({});
      s.abort();
      await s.done;
      assertEquals(calls.length, 0);
    });
  });
});

Deno.test("opencodeRuntimeAdapter.openSession — malformed input rejects without flipping warn latch", async () => {
  _resetToolFilterWarning();
  await withStubOpenCode(async () => {
    await withWarnSpy(async (calls) => {
      // `openSession` is declared `async`, so the synchronous validator
      // throw is wrapped into a rejected promise.
      await assertRejects(
        () =>
          opencodeRuntimeAdapter.openSession!({
            allowedTools: ["Read"],
            disallowedTools: ["Bash"],
          }),
        Error,
        "mutually exclusive",
      );
      assertEquals(calls.length, 0, "failed validation must not warn");
      const s = await opencodeRuntimeAdapter.openSession!({
        allowedTools: ["Read"],
      });
      s.abort();
      await s.done;
      assertEquals(calls.length, 1, "valid call after throw warns once");
    });
  });
});

// --- Reasoning effort (FR-L25) ---

Deno.test("opencodeRuntimeAdapter — reasoningEffort capability is true", () => {
  assertEquals(opencodeRuntimeAdapter.capabilities.reasoningEffort, true);
});

Deno.test("opencodeRuntimeAdapter.openSession — reasoningEffort warns once on provider-specific translation", async () => {
  _resetReasoningEffortWarning();
  await withStubOpenCode(async () => {
    await withWarnSpy(async (calls) => {
      const s1 = await opencodeRuntimeAdapter.openSession!({
        reasoningEffort: "high",
      });
      s1.abort();
      await s1.done;
      const s2 = await opencodeRuntimeAdapter.openSession!({
        reasoningEffort: "low",
      });
      s2.abort();
      await s2.done;
      const reCalls = calls.filter((c) =>
        String(c[0]).includes("reasoningEffort")
      );
      assertEquals(reCalls.length, 1);
      assert(String(reCalls[0][0]).includes("[opencode]"));
      _resetReasoningEffortWarning();
      const s3 = await opencodeRuntimeAdapter.openSession!({
        reasoningEffort: "medium",
      });
      s3.abort();
      await s3.done;
      assertEquals(
        calls.filter((c) => String(c[0]).includes("reasoningEffort")).length,
        2,
        "reset re-enables the warning",
      );
    });
  });
});

Deno.test("opencodeRuntimeAdapter.openSession — reasoningEffort sets body.variant on prompt_async", async () => {
  _resetReasoningEffortWarning();
  const capture = await Deno.makeTempFile({ prefix: "opencode-capture-" });
  try {
    Deno.env.set("STUB_CAPTURE", capture);
    await withStubOpenCode(async () => {
      const session = await opencodeRuntimeAdapter.openSession!({
        reasoningEffort: "high",
      });
      await session.send("hello");
      // Drain one turn — the stub emits a session.idle after prompt_async.
      for await (const e of session.events) {
        if (e.type === "session.idle") break;
      }
      session.abort();
      await session.done;
    });
    Deno.env.delete("STUB_CAPTURE");
    const body = await Deno.readTextFile(capture);
    const line = body.trim().split("\n")[0];
    const parsed = JSON.parse(line);
    assertEquals(parsed.variant, "high");
  } finally {
    try {
      await Deno.remove(capture);
    } catch { /* noop */ }
  }
});
