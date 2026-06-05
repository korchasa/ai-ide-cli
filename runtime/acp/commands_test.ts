/**
 * @module
 * PATH-stub-driven unit tests for the FR-L42 ACP commands fast-channel
 * helper (`fetchAcpCommands`) and the pure `parseAvailableCommands`
 * projector. The stub IS the ACP front — no real binary, no tokens.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { ProcessRegistry } from "../../process-registry.ts";
import { CommandsUnavailableError } from "../commands.ts";
import { fetchAcpCommands, parseAvailableCommands } from "./commands.ts";

interface StubScript {
  script: string;
}

/**
 * Install a temporary `npx` stub and override PATH so the spawned ACP
 * front IS the stub. Restores PATH on cleanup.
 */
async function withStubAcpFront<T>(
  { script }: StubScript,
  fn: () => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "acp-commands-stub-" });
  const stub = `${dir}/npx`;
  await Deno.writeTextFile(
    stub,
    `#!/usr/bin/env bash\n# ACP commands front stub\n${script}\n`,
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

const COMMANDS_SCRIPT = `
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
    session/new)
      respond "$id" '{"sessionId":"sess-cmd","modes":{"availableModes":[]},"sessionConfigOptions":[]}'
      printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionUpdate":"available_commands_update","availableCommands":[{"name":"/help","description":"Show help","input":{"hint":"topic"}},{"name":"/clear","description":"Reset chat"}]}}\\n'
      ;;
    *) respond "$id" 'null' ;;
  esac
done
`;

const SILENT_SCRIPT = `
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
    session/new) respond "$id" '{"sessionId":"sess-silent"}' ;;
    *) respond "$id" 'null' ;;
  esac
done
`;

Deno.test("fetchAcpCommands captures the first available_commands_update", async () => {
  await withStubAcpFront({ script: COMMANDS_SCRIPT }, async () => {
    const registry = new ProcessRegistry();
    const snapshot = await fetchAcpCommands("claude", {
      transport: "acp",
      processRegistry: registry,
      timeoutMs: 5_000,
    });
    assertEquals(snapshot.runtime, "claude");
    assertEquals(snapshot.sessionId, "sess-cmd");
    assertEquals(snapshot.commands.length, 2);
    assertEquals(snapshot.commands[0].name, "/help");
    assertEquals(snapshot.commands[0].description, "Show help");
    assertEquals(snapshot.commands[0].input?.hint, "topic");
    assertEquals(snapshot.commands[1].name, "/clear");
    assertEquals(snapshot.commands[1].input, undefined);
  });
});

Deno.test("fetchAcpCommands throws CommandsUnavailableError(timeout) when the front never pushes", async () => {
  await withStubAcpFront({ script: SILENT_SCRIPT }, async () => {
    const registry = new ProcessRegistry();
    const err = await assertRejects(
      () =>
        fetchAcpCommands("claude", {
          transport: "acp",
          processRegistry: registry,
          timeoutMs: 200,
        }),
      CommandsUnavailableError,
    );
    assertEquals(err.reason, "timeout");
    assertEquals(err.runtime, "claude");
    assertEquals(err.transport, "acp");
  });
});

Deno.test("fetchAcpCommands rejects with timeout when the caller signal aborts", async () => {
  await withStubAcpFront({ script: SILENT_SCRIPT }, async () => {
    const registry = new ProcessRegistry();
    const controller = new AbortController();
    const p = fetchAcpCommands("claude", {
      transport: "acp",
      processRegistry: registry,
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort("test"), 50);
    const err = await assertRejects(() => p, CommandsUnavailableError);
    assertEquals(err.reason, "timeout");
  });
});

const HANG_HANDSHAKE_SCRIPT = `
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
    session/new) sleep 30 ;;
    *) respond "$id" 'null' ;;
  esac
done
`;

Deno.test("fetchAcpCommands aborts cleanly when the signal fires during a hung handshake", async () => {
  await withStubAcpFront({ script: HANG_HANDSHAKE_SCRIPT }, async () => {
    const registry = new ProcessRegistry();
    const controller = new AbortController();
    const p = fetchAcpCommands("claude", {
      transport: "acp",
      processRegistry: registry,
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort("test"), 100);
    const err = await assertRejects(() => p, CommandsUnavailableError);
    assertEquals(err.reason, "timeout");
  });
});

Deno.test("fetchAcpCommands throws front_not_piloted for cursor before any spawn", async () => {
  const registry = new ProcessRegistry();
  const err = await assertRejects(
    () =>
      fetchAcpCommands("cursor", {
        transport: "acp",
        processRegistry: registry,
        timeoutMs: 1_000,
      }),
    CommandsUnavailableError,
  );
  assertEquals(err.reason, "front_not_piloted");
  assertEquals(err.runtime, "cursor");
});

Deno.test("parseAvailableCommands skips malformed entries", () => {
  const out = parseAvailableCommands({
    availableCommands: [
      { name: "/ok", description: "fine" },
      { name: 123, description: "bad name" },
      { description: "no name" },
      { name: "/hint", description: "with hint", input: { hint: "x" } },
    ],
  });
  assertEquals(out.length, 2);
  assertEquals(out[0].name, "/ok");
  assertEquals(out[1].input?.hint, "x");
});
