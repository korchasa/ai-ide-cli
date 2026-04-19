import { assert, assertEquals } from "@std/assert";
import { getRuntimeAdapter } from "./index.ts";

const opencodeRuntimeAdapter = getRuntimeAdapter("opencode");

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
