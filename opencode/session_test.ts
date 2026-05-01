import { assert, assertEquals, assertRejects } from "@std/assert";
import { defaultRegistry } from "../process-registry.ts";
import {
  extractOpenCodeSessionId,
  type OpenCodeSessionEvent,
  openOpenCodeSession,
  parseOpenCodeSseFrame,
} from "./session.ts";

// --- parseOpenCodeSseFrame ---

Deno.test("parseOpenCodeSseFrame — parses data: JSON line", () => {
  const event = parseOpenCodeSseFrame(
    `data: {"type":"server.connected","properties":{}}`,
  );
  assert(event);
  assertEquals(event.type, "server.connected");
  assertEquals(event.properties, {});
});

Deno.test("parseOpenCodeSseFrame — preserves unknown type as 'unknown'", () => {
  const event = parseOpenCodeSseFrame(`data: {"foo":"bar"}`);
  assert(event);
  assertEquals(event.type, "unknown");
  assertEquals(event.raw, { foo: "bar" });
});

Deno.test("parseOpenCodeSseFrame — ignores comment-only frames", () => {
  assertEquals(parseOpenCodeSseFrame(`: keepalive`), undefined);
  assertEquals(parseOpenCodeSseFrame(``), undefined);
});

Deno.test("parseOpenCodeSseFrame — ignores malformed JSON", () => {
  assertEquals(parseOpenCodeSseFrame(`data: {not json}`), undefined);
});

Deno.test("parseOpenCodeSseFrame — tolerates multi-line frames with data: first", () => {
  const event = parseOpenCodeSseFrame(
    `event: session.idle\ndata: {"type":"session.idle","properties":{"sessionID":"ses_x"}}`,
  );
  assert(event);
  assertEquals(event.type, "session.idle");
  assertEquals(
    (event.properties as Record<string, unknown>).sessionID,
    "ses_x",
  );
});

// --- extractOpenCodeSessionId ---

function ev(
  type: string,
  properties: Record<string, unknown> | undefined,
): OpenCodeSessionEvent {
  return { type, properties, raw: { type, properties } };
}

Deno.test("extractOpenCodeSessionId — top-level properties.sessionID", () => {
  assertEquals(
    extractOpenCodeSessionId(ev("session.idle", { sessionID: "ses_1" })),
    "ses_1",
  );
});

Deno.test("extractOpenCodeSessionId — nested properties.part.sessionID", () => {
  const e = ev("message.part.updated", {
    part: { sessionID: "ses_2", type: "text", text: "hi" },
  });
  assertEquals(extractOpenCodeSessionId(e), "ses_2");
});

Deno.test("extractOpenCodeSessionId — nested properties.info.sessionID", () => {
  const e = ev("message.updated", {
    info: { sessionID: "ses_3", role: "assistant" },
  });
  assertEquals(extractOpenCodeSessionId(e), "ses_3");
});

Deno.test("extractOpenCodeSessionId — returns undefined when missing", () => {
  assertEquals(extractOpenCodeSessionId(ev("server.connected", {})), undefined);
  assertEquals(extractOpenCodeSessionId(ev("x", undefined)), undefined);
});

// --- openOpenCodeSession end-to-end against a Deno-served stub binary ---

/**
 * Write a stub `opencode` shell script on PATH that execs a Deno-based fake
 * server. The fake server:
 *  - prints `opencode server listening on http://HOST:PORT` to stdout,
 *  - serves `POST /session` → `{id:"ses_stub"}`,
 *  - serves `GET /event` → an SSE stream with one `server.connected` event
 *    followed by one `session.idle` event scoped to `ses_stub`,
 *  - serves `POST /session/:id/prompt_async` → 204,
 *  - serves `POST /session/:id/abort` → `true`,
 *  - appends each received prompt_async body to `$STUB_CAPTURE` if set.
 */
async function withStubOpenCode<T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "opencode-session-stub-" });
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
    if (capturePath) {
      const body = await req.text();
      await Deno.writeTextFile(capturePath, body + "\\n", { append: true, create: true });
    } else {
      await req.text();
    }
    // Push a busy→idle status pair so the session can observe the turn cycle.
    if (sseController) {
      sseController.enqueue(enc.encode(
        \`data: {"type":"session.status","properties":{"sessionID":"ses_stub","status":{"type":"busy"}}}\\n\\n\`,
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
  const binPath = `${dir}/opencode`;
  const denoPath = Deno.execPath();
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

Deno.test("openOpenCodeSession — creates session and streams events", async () => {
  await withStubOpenCode(async () => {
    const session = await openOpenCodeSession({
      processRegistry: defaultRegistry,
    });
    try {
      assertEquals(session.sessionId, "ses_stub");
      assert(session.baseUrl.startsWith("http://127.0.0.1:"));
      // Trigger a send so we get busy+idle events.
      await session.send("hello");
      const types: string[] = [];
      for await (const ev of session.events) {
        types.push(ev.type);
        if (ev.type === "session.idle") break;
      }
      // Must have seen at least busy then idle for our session.
      assert(types.includes("session.status"));
      assert(types.includes("session.idle"));
    } finally {
      session.abort();
      await session.done;
    }
  });
});

Deno.test("openOpenCodeSession — send POSTs prompt body to prompt_async", async () => {
  await withStubOpenCode(async (dir) => {
    const capture = `${dir}/stdin.log`;
    const session = await openOpenCodeSession({
      processRegistry: defaultRegistry,
      env: { STUB_CAPTURE: capture },
      agent: "build",
      model: "zai-coding-plan/glm-5",
      systemPrompt: "You are helpful.",
    });
    try {
      await session.send("first");
      await session.send("second");
      // Let the capture finish writing.
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      session.abort();
      await session.done;
    }
    const lines = (await Deno.readTextFile(capture)).trim().split("\n");
    assertEquals(lines.length, 2);
    const first = JSON.parse(lines[0]);
    assertEquals(first.parts, [{ type: "text", text: "first" }]);
    assertEquals(first.agent, "build");
    assertEquals(first.system, "You are helpful.");
    assertEquals(first.model, {
      providerID: "zai-coding-plan",
      modelID: "glm-5",
    });
    const second = JSON.parse(lines[1]);
    assertEquals(second.parts, [{ type: "text", text: "second" }]);
  });
});

Deno.test("openOpenCodeSession — send throws after endInput", async () => {
  await withStubOpenCode(async () => {
    const session = await openOpenCodeSession({
      processRegistry: defaultRegistry,
    });
    await session.endInput();
    await assertRejects(
      () => session.send("late"),
      Error,
      "input already closed",
    );
    await session.done;
  });
});

Deno.test("openOpenCodeSession — abort() tears the server down and resolves done", async () => {
  await withStubOpenCode(async () => {
    const session = await openOpenCodeSession({
      processRegistry: defaultRegistry,
    });
    session.abort("test");
    const status = await session.done;
    // Deno.serve exits cleanly on SIGTERM; accept either signal or code.
    assert(status.exitCode !== undefined || status.signal !== null);
  });
});

Deno.test("openOpenCodeSession — external AbortSignal triggers shutdown", async () => {
  await withStubOpenCode(async () => {
    const controller = new AbortController();
    const session = await openOpenCodeSession({
      processRegistry: defaultRegistry,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort("external"), 50);
    const status = await session.done;
    assert(status.exitCode !== undefined || status.signal !== null);
  });
});
