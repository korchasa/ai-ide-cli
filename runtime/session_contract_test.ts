/**
 * @module
 * Backend-independent contract tests for {@link RuntimeSession}. The four
 * adapters (Claude, OpenCode, Cursor, Codex) all expose the same public
 * contract — this file asserts the invariants at both the type level and
 * the behavioural level.
 *
 * Behavioural tests use the Claude stub (smallest surface area); adapter
 * divergence is caught here the moment any runtime-specific test drifts
 * from the contract. Runtime-specific behaviour lives in the per-adapter
 * test files.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { getRuntimeAdapter } from "./index.ts";
import type { RuntimeSession } from "./types.ts";

// ───────────── Type-level assertions ─────────────

// `pid` is intentionally not part of the neutral interface — runtime-specific
// handles may expose it, but consumers of `RuntimeSession` must not rely on
// it. A regression that re-adds `pid` to `RuntimeSession` fails the compile.
type _RuntimeSessionHasNoPid = "pid" extends keyof RuntimeSession ? never
  : true;
const _typeAssertNoPid: _RuntimeSessionHasNoPid = true;
void _typeAssertNoPid;

// ───────────── Behavioural invariants (Claude stub) ─────────────

async function withStubClaude<T>(
  script: string,
  fn: () => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({
    prefix: "session-contract-claude-stub-",
  });
  const stubPath = `${dir}/claude`;
  await Deno.writeTextFile(stubPath, `#!/usr/bin/env bash\n${script}\n`);
  await Deno.chmod(stubPath, 0o755);
  const prevPath = Deno.env.get("PATH") ?? "";
  Deno.env.set("PATH", `${dir}:${prevPath}`);
  try {
    return await fn();
  } finally {
    Deno.env.set("PATH", prevPath);
    try {
      await Deno.remove(dir, { recursive: true });
    } catch {
      // best-effort cleanup
    }
  }
}

const claudeAdapter = getRuntimeAdapter("claude");

Deno.test("RuntimeSession contract — runtime field matches adapter id", async () => {
  await withStubClaude(
    `cat <<'EOF'
{"type":"system","subtype":"init","session_id":"x"}
{"type":"result","subtype":"success","result":"ok","is_error":false}
EOF`,
    async () => {
      const session = await claudeAdapter.openSession!({});
      try {
        assertEquals(session.runtime, "claude");
      } finally {
        session.abort();
        await session.done;
      }
    },
  );
});

Deno.test("RuntimeSession contract — send after endInput throws", async () => {
  await withStubClaude(
    `cat > /dev/null`,
    async () => {
      const session = await claudeAdapter.openSession!({});
      await session.endInput();
      await assertRejects(() => session.send("late"), Error);
      await session.done;
    },
  );
});

Deno.test("RuntimeSession contract — abort is idempotent", async () => {
  await withStubClaude(
    `trap 'exit 143' TERM; while true; do sleep 1; done`,
    async () => {
      const session = await claudeAdapter.openSession!({});
      session.abort("first");
      session.abort("second");
      session.abort("third");
      // No throws. `done` still resolves.
      const status = await session.done;
      assert(status.exitCode === 143 || status.signal === "SIGTERM");
    },
  );
});

Deno.test("RuntimeSession contract — events iterable is single-consumer", async () => {
  await withStubClaude(
    `cat <<'EOF'
{"type":"result","subtype":"success","result":"ok","is_error":false}
EOF`,
    async () => {
      const session = await claudeAdapter.openSession!({});
      try {
        for await (const _event of session.events) {
          // drain
        }
        // Re-iteration must throw.
        let threw = false;
        try {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          for await (const _event of session.events) { /* noop */ }
        } catch (err) {
          threw = true;
          assert(err instanceof Error);
          assert(/only be iterated once/.test(err.message));
        }
        assert(threw, "expected re-iteration to throw");
      } finally {
        session.abort();
        await session.done;
      }
    },
  );
});

Deno.test("RuntimeSession contract — done resolves after abort", async () => {
  await withStubClaude(
    `trap 'exit 143' TERM; while true; do sleep 1; done`,
    async () => {
      const session = await claudeAdapter.openSession!({});
      session.abort();
      const status = await session.done;
      assert(typeof status.exitCode === "number" || status.exitCode === null);
      assert(typeof status.stderr === "string");
    },
  );
});

Deno.test("RuntimeSession contract — all four adapters advertise session capability", () => {
  for (const runtime of ["claude", "opencode", "cursor", "codex"] as const) {
    const adapter = getRuntimeAdapter(runtime);
    assertEquals(
      adapter.capabilities.session,
      true,
      `${runtime} must advertise session capability`,
    );
    assert(
      typeof adapter.openSession === "function",
      `${runtime} must implement openSession`,
    );
  }
});
