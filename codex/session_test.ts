import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  expandCodexSessionExtraArgs,
  openCodexSession,
  permissionModeToThreadStartFields,
  updateActiveTurnId,
} from "./session.ts";
import { SessionInputClosedError } from "../runtime/types.ts";
import { defaultRegistry } from "../process-registry.ts";

// --- Pure helpers ---

Deno.test("permissionModeToThreadStartFields — default/unknown → empty", () => {
  assertEquals(permissionModeToThreadStartFields(), {});
  assertEquals(permissionModeToThreadStartFields("default"), {});
  assertEquals(permissionModeToThreadStartFields("bogus"), {});
});

Deno.test("permissionModeToThreadStartFields — normalized modes map to approval+sandbox", () => {
  assertEquals(permissionModeToThreadStartFields("plan"), {
    approvalPolicy: "never",
    sandbox: "read-only",
  });
  assertEquals(permissionModeToThreadStartFields("acceptEdits"), {
    approvalPolicy: "never",
    sandbox: "workspace-write",
  });
  assertEquals(permissionModeToThreadStartFields("bypassPermissions"), {
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  });
});

Deno.test("permissionModeToThreadStartFields — native modes pass through", () => {
  assertEquals(permissionModeToThreadStartFields("read-only"), {
    sandbox: "read-only",
  });
  assertEquals(permissionModeToThreadStartFields("never"), {
    approvalPolicy: "never",
  });
  assertEquals(permissionModeToThreadStartFields("on-request"), {
    approvalPolicy: "on-request",
  });
});

Deno.test("expandCodexSessionExtraArgs — null suppresses, strings round-trip", () => {
  assertEquals(
    expandCodexSessionExtraArgs({
      "--config": "foo=bar",
      "--disable": "feature",
      "--dropped": null,
    }),
    ["--config", "foo=bar", "--disable", "feature"],
  );
  assertEquals(expandCodexSessionExtraArgs(undefined), []);
});

Deno.test("updateActiveTurnId — turn/started sets, turn/completed clears", () => {
  assertEquals(
    updateActiveTurnId(null, {
      method: "turn/started",
      params: { turn: { id: "t1" } },
    }),
    "t1",
  );
  assertEquals(
    updateActiveTurnId("t1", { method: "turn/completed", params: {} }),
    null,
  );
  // Unrelated notifications pass through.
  assertEquals(
    updateActiveTurnId("t1", {
      method: "item/started",
      params: { item: {} },
    }),
    "t1",
  );
});

// --- Stub-binary integration tests ---

/**
 * Spawn a real `deno run` as the `codex` binary that speaks enough of the
 * app-server JSON-RPC protocol to satisfy openCodexSession(). The stub
 * script is generated per test into a temp dir and put on PATH.
 *
 * Stub protocol:
 *   - Reads newline-delimited JSON from stdin.
 *   - For requests, matches by method and emits a canned response line.
 *   - Pushes optional notifications when instructed via env
 *     `STUB_NOTIFY_AFTER_METHOD` (comma-separated method names); on match,
 *     writes the JSON in `STUB_NOTIFY_PAYLOAD` to stdout.
 *   - Responds to `turn/interrupt` with `{}` and optionally emits a
 *     `turn/completed` notification.
 *   - Exits 0 on stdin EOF (graceful close).
 *   - Traps SIGTERM and exits 143 so `abort()` is observable.
 */
async function withStubCodex<T>(
  fn: (ctx: {
    dir: string;
    captureFile: string;
  }) => Promise<T>,
  stubEnv: Record<string, string> = {},
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "codex-session-stub-" });
  const stubPath = `${dir}/codex`;
  const stubTsPath = `${dir}/stub.ts`;
  const capture = `${dir}/rpc.log`;
  await Deno.writeTextFile(stubTsPath, buildStubTs());
  await Deno.writeTextFile(stubPath, buildStubShell(stubTsPath));
  await Deno.chmod(stubPath, 0o755);

  const prevPath = Deno.env.get("PATH") ?? "";
  Deno.env.set("PATH", `${dir}:${prevPath}`);
  // Capture path is picked up by the Deno stub through env.
  const prevCapture = Deno.env.get("STUB_CAPTURE");
  Deno.env.set("STUB_CAPTURE", capture);
  for (const [k, v] of Object.entries(stubEnv)) {
    Deno.env.set(k, v);
  }

  try {
    return await fn({ dir, captureFile: capture });
  } finally {
    Deno.env.set("PATH", prevPath);
    if (prevCapture === undefined) {
      Deno.env.delete("STUB_CAPTURE");
    } else {
      Deno.env.set("STUB_CAPTURE", prevCapture);
    }
    for (const k of Object.keys(stubEnv)) Deno.env.delete(k);
    try {
      await Deno.remove(dir, { recursive: true });
    } catch {
      // best-effort cleanup
    }
  }
}

/**
 * Minimal bash wrapper that `exec`s `deno run -A <stub.ts>`, forwarding all
 * argv and keeping the original stdin/stdout for the RPC protocol.
 */
function buildStubShell(tsPath: string): string {
  return [
    "#!/usr/bin/env bash",
    "set -e",
    `exec ${Deno.execPath()} run -A ${tsPath} "$@"`,
    "",
  ].join("\n");
}

/**
 * TypeScript stub that speaks just enough of the app-server JSON-RPC
 * protocol to satisfy {@link openCodexSession}: `initialize`,
 * `thread/start`/`thread/resume`, `turn/start`, `turn/steer`, and
 * `turn/interrupt`. Reads newline-delimited JSON on stdin, writes
 * responses and notifications on stdout, appends every inbound message to
 * `STUB_CAPTURE` for assertions.
 */
function buildStubTs(): string {
  return String.raw`
const capture = Deno.env.get("STUB_CAPTURE");
const sleepMs = Number(Deno.env.get("STUB_SLEEP_MS") ?? "0");
const beforeExit = Deno.env.get("STUB_BEFORE_EXIT") ?? "";
const abortMode = Deno.env.get("STUB_ABORT_MODE") === "1";

// If abortMode: ignore stdin close and just block forever until SIGTERM.
if (abortMode) {
  // Register a SIGTERM handler to exit 143.
  Deno.addSignalListener("SIGTERM", () => Deno.exit(143));
  // Keep process alive.
  setInterval(() => {}, 1_000);
}

const enc = new TextEncoder();
const dec = new TextDecoder();

async function writeOut(obj: Record<string, unknown>): Promise<void> {
  await Deno.stdout.write(enc.encode(JSON.stringify(obj) + "\n"));
}

async function appendCapture(obj: Record<string, unknown>): Promise<void> {
  if (!capture) return;
  await Deno.writeTextFile(capture, JSON.stringify(obj) + "\n", { append: true });
}

async function handle(
  req: Record<string, unknown>,
): Promise<void> {
  await appendCapture(req);
  const method = req.method as string;
  const id = req.id;
  if (typeof id === "undefined") {
    // Notification from client (e.g. "initialized") — no response.
    return;
  }
  switch (method) {
    case "initialize":
      await writeOut({ jsonrpc: "2.0", id, result: {
        serverInfo: { name: "codex-stub", version: "0.0.0" },
        capabilities: {},
      }});
      return;
    case "thread/start":
      await writeOut({ jsonrpc: "2.0", id, result: {
        thread: {
          id: "thread-abc",
          forkedFromId: null,
          preview: "",
          ephemeral: false,
          modelProvider: "openai",
          createdAt: 0, updatedAt: 0,
          status: "active",
          path: null, cwd: "/tmp",
          cliVersion: "stub",
          source: "app_server",
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: null,
          turns: [],
        },
        model: "stub-model",
        modelProvider: "openai",
        serviceTier: null,
        cwd: "/tmp",
        instructionSources: [],
        approvalPolicy: "never",
        approvalsReviewer: "ide",
        sandbox: { type: "readOnly", access: { allowReadable: [] }, networkAccess: false },
        reasoningEffort: null,
      }});
      return;
    case "thread/resume":
      await writeOut({ jsonrpc: "2.0", id, result: {
        thread: { id: (req.params as { threadId: string }).threadId,
          forkedFromId: null, preview: "", ephemeral: false,
          modelProvider: "openai", createdAt: 0, updatedAt: 0,
          status: "active", path: null, cwd: "/tmp",
          cliVersion: "stub", source: "app_server",
          agentNickname: null, agentRole: null, gitInfo: null,
          name: null, turns: [] },
        model: "stub-model", modelProvider: "openai",
        serviceTier: null, cwd: "/tmp", instructionSources: [],
        approvalPolicy: "never", approvalsReviewer: "ide",
        sandbox: { type: "readOnly", access: { allowReadable: [] }, networkAccess: false },
        reasoningEffort: null,
      }});
      return;
    case "turn/start": {
      // Respond to the request first.
      const turnId = "turn-1";
      await writeOut({ jsonrpc: "2.0", id, result: {
        turn: { id: turnId, items: [], status: "inProgress",
          error: null, startedAt: 0, completedAt: null, durationMs: null },
      }});
      // Then push a turn/started notification so the client tracks the
      // active turn id (needed for subsequent turn/steer calls).
      await writeOut({ jsonrpc: "2.0", method: "turn/started", params: {
        threadId: "thread-abc",
        turn: { id: turnId, items: [], status: "inProgress",
          error: null, startedAt: 0, completedAt: null, durationMs: null },
      }});
      return;
    }
    case "turn/steer": {
      await writeOut({ jsonrpc: "2.0", id, result: { turnId: "turn-1" } });
      return;
    }
    case "turn/interrupt": {
      await writeOut({ jsonrpc: "2.0", id, result: {} });
      // Mirror the real server: after an interrupt, a turn/completed follows.
      await writeOut({ jsonrpc: "2.0", method: "turn/completed", params: {
        threadId: "thread-abc",
        turn: { id: "turn-1", items: [], status: "interrupted",
          error: null, startedAt: 0, completedAt: 1, durationMs: 1 },
      }});
      return;
    }
    default:
      await writeOut({ jsonrpc: "2.0", id, error: {
        code: -32601, message: "Method not found: " + method,
      }});
  }
}

async function main(): Promise<void> {
  const reader = Deno.stdin.readable.getReader();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          await handle(parsed);
          if (sleepMs > 0) {
            await new Promise((r) => setTimeout(r, sleepMs));
          }
        } catch {
          // ignore malformed
        }
      }
    }
    if (beforeExit) {
      try { await writeOut(JSON.parse(beforeExit)); } catch { /* ignore */ }
    }
  } catch {
    // stdin closed
  }
}

await main();
`;
}

Deno.test({
  name: "openCodexSession — captures threadId from thread/start",
  sanitizeResources: false, // stub subprocess pipes
  fn: async () => {
    await withStubCodex(async () => {
      const session = await openCodexSession({
        processRegistry: defaultRegistry,
      });
      assertEquals(session.threadId, "thread-abc");
      assertEquals(session.runtime, "codex");
      await session.endInput();
      await session.done;
    });
  },
});

Deno.test({
  name:
    "openCodexSession — send issues turn/start first, then turn/steer on follow-up",
  sanitizeResources: false,
  fn: async () => {
    await withStubCodex(async ({ captureFile }) => {
      const session = await openCodexSession({
        processRegistry: defaultRegistry,
      });
      await session.send("first");

      // Wait for the stub's turn/started notification to land in events —
      // updateActiveTurnId will have flipped by then.
      const iter = session.events[Symbol.asyncIterator]();
      while (true) {
        const { done, value } = await iter.next();
        if (done) break;
        if (value.type === "started") break;
      }

      await session.send("second");
      await session.endInput();
      await session.done;

      // Inspect the capture log — assert turn/start came before turn/steer.
      const raw = await Deno.readTextFile(captureFile);
      const methods = raw.trim().split("\n").map((line) => {
        const obj = JSON.parse(line) as { method?: string };
        return obj.method;
      });
      const turnStart = methods.indexOf("turn/start");
      const turnSteer = methods.indexOf("turn/steer");
      assert(turnStart >= 0, "expected a turn/start call");
      assert(turnSteer >= 0, "expected a turn/steer call");
      assert(
        turnStart < turnSteer,
        `expected turn/start before turn/steer, got ${methods.join(",")}`,
      );
    });
  },
});

Deno.test({
  name:
    "openCodexSession — send back-to-back uses turn/steer for the second call without waiting on turn/started",
  sanitizeResources: false,
  fn: async () => {
    // Race regression: prior implementation only set `activeTurnId` from
    // the asynchronous `turn/started` notification. Two `send()` calls
    // back-to-back (before the notification was drained from the queue)
    // both issued `turn/start` and the second one was rejected by Codex.
    // With the fix, the first `send` promotes `turn.id` from the
    // `turn/start` response synchronously, so the second `send` sees a
    // populated `activeTurnId` and routes through `turn/steer`.
    await withStubCodex(async ({ captureFile }) => {
      const session = await openCodexSession({
        processRegistry: defaultRegistry,
      });
      await session.send("first");
      await session.send("second");
      await session.endInput();
      await session.done;

      const raw = await Deno.readTextFile(captureFile);
      const methods = raw.trim().split("\n").map((line) => {
        const obj = JSON.parse(line) as { method?: string };
        return obj.method;
      });
      const turnStarts = methods.filter((m) => m === "turn/start").length;
      const turnSteers = methods.filter((m) => m === "turn/steer").length;
      assertEquals(
        turnStarts,
        1,
        `expected exactly one turn/start, got ${turnStarts} (${
          methods.join(",")
        })`,
      );
      assertEquals(
        turnSteers,
        1,
        `expected exactly one turn/steer, got ${turnSteers} (${
          methods.join(",")
        })`,
      );
    });
  },
});

Deno.test({
  name: "openCodexSession — endInput closes stdin and resolves done",
  sanitizeResources: false,
  fn: async () => {
    await withStubCodex(async () => {
      const session = await openCodexSession({
        processRegistry: defaultRegistry,
      });
      await session.endInput();
      const status = await session.done;
      assertEquals(status.exitCode, 0);
      assertEquals(status.signal, null);
    });
  },
});

Deno.test({
  name: "openCodexSession — send after endInput throws SessionInputClosedError",
  sanitizeResources: false,
  fn: async () => {
    await withStubCodex(async () => {
      const session = await openCodexSession({
        processRegistry: defaultRegistry,
      });
      await session.endInput();
      await assertRejects(
        () => session.send("late"),
        SessionInputClosedError,
      );
      await session.done;
    });
  },
});

Deno.test({
  name:
    "openCodexSession — abort SIGTERMs subprocess, done resolves with signal or 143",
  sanitizeResources: false,
  fn: async () => {
    await withStubCodex(async () => {
      const session = await openCodexSession({
        processRegistry: defaultRegistry,
      });
      session.abort("test");
      const status = await session.done;
      // The Deno runtime is trapping SIGTERM for the stub → exit 143; if the
      // trap didn't install in time, Deno reports signal = "SIGTERM".
      assert(
        status.exitCode === 143 || status.signal === "SIGTERM" ||
          status.exitCode === null,
        `unexpected status: ${JSON.stringify(status)}`,
      );
    }, { STUB_ABORT_MODE: "1" });
  },
});
