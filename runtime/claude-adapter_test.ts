import { assert, assertEquals } from "@std/assert";
import { getRuntimeAdapter } from "./index.ts";

const claudeRuntimeAdapter = getRuntimeAdapter("claude");

/** Swap `claude` for a bash stub on PATH for the duration of `fn`. */
async function withStubClaude<T>(
  script: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "claude-adapter-stub-" });
  const stubPath = `${dir}/claude`;
  await Deno.writeTextFile(stubPath, `#!/usr/bin/env bash\n${script}\n`);
  await Deno.chmod(stubPath, 0o755);
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

Deno.test("claudeRuntimeAdapter — declares session capability", () => {
  assertEquals(claudeRuntimeAdapter.capabilities.session, true);
  assert(typeof claudeRuntimeAdapter.openSession === "function");
});

Deno.test("claudeRuntimeAdapter.openSession — yields normalized session events with raw payload preserved", async () => {
  await withStubClaude(
    `cat <<'EOF'
{"type":"system","subtype":"init","session_id":"stub-1","model":"stub"}
{"type":"result","subtype":"success","result":"ok","session_id":"stub-1","total_cost_usd":0,"duration_ms":1,"duration_api_ms":0,"num_turns":0,"is_error":false}
EOF`,
    async () => {
      const session = await claudeRuntimeAdapter.openSession!({});
      assertEquals(session.runtime, "claude");
      const events = [];
      for await (const event of session.events) {
        events.push(event);
        if (event.type === "result") break;
      }
      session.abort();
      await session.done;

      assertEquals(events.length, 2);
      assertEquals(events[0].runtime, "claude");
      assertEquals(events[0].type, "system");
      assertEquals(events[0].raw["session_id"], "stub-1");
      assertEquals(events[1].type, "result");
      assertEquals(events[1].raw["result"], "ok");
    },
  );
});

Deno.test("claudeRuntimeAdapter.openSession — onEvent receives normalized events in order", async () => {
  await withStubClaude(
    `cat <<'EOF'
{"type":"system","subtype":"init","session_id":"stub-2"}
{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}
{"type":"result","subtype":"success","result":"hi","is_error":false}
EOF`,
    async () => {
      const types: string[] = [];
      const session = await claudeRuntimeAdapter.openSession!({
        onEvent: (e) => {
          assertEquals(e.runtime, "claude");
          types.push(e.type);
        },
      });
      // Drain to completion.
      for await (const _event of session.events) { /* noop */ }
      await session.done;
      assertEquals(types, ["system", "assistant", "result"]);
    },
  );
});

Deno.test("claudeRuntimeAdapter.openSession — send forwards user message to subprocess stdin", async () => {
  await withStubClaude(
    `cat > "$STUB_CAPTURE"`,
    async (dir) => {
      const capture = `${dir}/stdin.log`;
      const session = await claudeRuntimeAdapter.openSession!({
        env: { STUB_CAPTURE: capture },
      });
      await session.send("hello");
      await session.endInput();
      await session.done;
      const lines = (await Deno.readTextFile(capture)).trim().split("\n");
      assertEquals(lines.length, 1);
      assertEquals(JSON.parse(lines[0]), {
        type: "user",
        message: { role: "user", content: "hello" },
      });
    },
  );
});

Deno.test("claudeRuntimeAdapter.openSession — abort returns exit status on done", async () => {
  await withStubClaude(
    `trap 'exit 143' TERM; while true; do sleep 1; done`,
    async () => {
      const session = await claudeRuntimeAdapter.openSession!({});
      session.abort("test");
      const status = await session.done;
      assert(status.exitCode === 143 || status.signal === "SIGTERM");
    },
  );
});
