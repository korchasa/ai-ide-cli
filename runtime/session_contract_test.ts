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
import { defaultRegistry } from "../process-registry.ts";
import { getRuntimeAdapter } from "./index.ts";
import {
  type RuntimeSession,
  type RuntimeSessionEvent,
  SessionAbortedError,
  SessionError,
  SessionInputClosedError,
  SYNTHETIC_TURN_END,
} from "./types.ts";
import { extractSessionContent } from "./content.ts";

// ───────────── Type-level assertions ─────────────

// `pid` is intentionally not part of the neutral interface — runtime-specific
// handles may expose it, but consumers of `RuntimeSession` must not rely on
// it. A regression that re-adds `pid` to `RuntimeSession` fails the compile.
type _RuntimeSessionHasNoPid = "pid" extends keyof RuntimeSession ? never
  : true;
const _typeAssertNoPid: _RuntimeSessionHasNoPid = true;
void _typeAssertNoPid;

// `sessionId` IS part of the neutral contract (populated synchronously for
// three runtimes; lazy-populated for Claude). Compile-time assertion catches
// a regression that drops it.
type _RuntimeSessionHasSessionId = "sessionId" extends keyof RuntimeSession
  ? true
  : never;
const _typeAssertSessionId: _RuntimeSessionHasSessionId = true;
void _typeAssertSessionId;

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
      const session = await claudeAdapter.openSession!({
        processRegistry: defaultRegistry,
      });
      try {
        assertEquals(session.runtime, "claude");
      } finally {
        session.abort();
        await session.done;
      }
    },
  );
});

Deno.test("RuntimeSession contract — send after endInput throws SessionInputClosedError", async () => {
  await withStubClaude(
    `cat > /dev/null`,
    async () => {
      const session = await claudeAdapter.openSession!({
        processRegistry: defaultRegistry,
      });
      await session.endInput();
      const err = await assertRejects(
        () => session.send("late"),
        SessionInputClosedError,
      );
      // Every typed error descends from SessionError so consumers can
      // catch one class for all three failure modes.
      assert(err instanceof SessionError);
      assertEquals(err.runtime, "claude");
      await session.done;
    },
  );
});

Deno.test("RuntimeSession contract — send after abort throws SessionAbortedError", async () => {
  await withStubClaude(
    `trap 'exit 143' TERM; while true; do sleep 1; done`,
    async () => {
      const session = await claudeAdapter.openSession!({
        processRegistry: defaultRegistry,
      });
      session.abort("test");
      const err = await assertRejects(
        () => session.send("after-abort"),
        SessionAbortedError,
      );
      assert(err instanceof SessionError);
      assertEquals(err.runtime, "claude");
      await session.done;
    },
  );
});

Deno.test("RuntimeSession contract — abort is idempotent", async () => {
  await withStubClaude(
    `trap 'exit 143' TERM; while true; do sleep 1; done`,
    async () => {
      const session = await claudeAdapter.openSession!({
        processRegistry: defaultRegistry,
      });
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
      const session = await claudeAdapter.openSession!({
        processRegistry: defaultRegistry,
      });
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
      const session = await claudeAdapter.openSession!({
        processRegistry: defaultRegistry,
      });
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

Deno.test("RuntimeSession contract — sessionFidelity is advertised per adapter", () => {
  // Cursor is the only emulated session today (per-send subprocess via
  // `cursor agent -p --resume`); every other adapter wraps a real
  // streaming-input transport. Consumers branch on this flag instead of
  // hard-coding runtime names.
  const expected: Record<string, "native" | "emulated"> = {
    claude: "native",
    opencode: "native",
    codex: "native",
    cursor: "emulated",
  };
  for (const runtime of ["claude", "opencode", "cursor", "codex"] as const) {
    const adapter = getRuntimeAdapter(runtime);
    assertEquals(
      adapter.capabilities.sessionFidelity,
      expected[runtime],
      `${runtime} must advertise sessionFidelity=${expected[runtime]}`,
    );
  }
});

Deno.test("RuntimeSession contract — synthetic turn-end is emitted after native result", async () => {
  // FR-L session-turn-end: every adapter emits exactly one synthetic
  // turn-end event after the runtime signals readiness for the next input.
  // Tested on the Claude backend (smallest stubbable surface) because the
  // neutral wrapper is shared by three of the four runtimes.
  await withStubClaude(
    `cat <<'EOF'
{"type":"system","subtype":"init","session_id":"s1"}
{"type":"result","subtype":"success","result":"ok","is_error":false,"session_id":"s1"}
EOF`,
    async () => {
      const session = await claudeAdapter.openSession!({
        processRegistry: defaultRegistry,
      });
      try {
        const collected: RuntimeSessionEvent[] = [];
        for await (const ev of session.events) {
          collected.push(ev);
        }
        const turnEnds = collected.filter((e) => e.type === SYNTHETIC_TURN_END);
        assertEquals(
          turnEnds.length,
          1,
          `expected exactly one synthetic turn-end, got ${turnEnds.length}`,
        );
        assert(
          turnEnds[0].synthetic === true,
          "synthetic flag must be true on the turn-end event",
        );
        assertEquals(turnEnds[0].runtime, "claude");
        // The raw payload preserves the native terminator so consumers
        // who need richer detail (subtype, cost, etc.) can reach through.
        assertEquals(turnEnds[0].raw["type"], "result");
        // Turn-end must appear AFTER the native `result` in the stream.
        const resultIdx = collected.findIndex((e) =>
          e.type === "result" && !e.synthetic
        );
        const turnEndIdx = collected.findIndex((e) =>
          e.type === SYNTHETIC_TURN_END
        );
        assert(
          resultIdx >= 0 && resultIdx < turnEndIdx,
          "synthetic turn-end must follow the native result event",
        );
      } finally {
        session.abort();
        await session.done;
      }
    },
  );
});

Deno.test("RuntimeSession contract — extractSessionContent surfaces normalized stream (FR-L23)", async () => {
  // End-to-end: stream the native events through the Claude stub, then
  // run `extractSessionContent` on each and assert the normalized stream
  // matches the expected shape (one text chunk, one tool, one final).
  // Runs on the Claude stub because the extractor path for Claude and
  // Cursor is shared — a regression on either path surfaces here.
  await withStubClaude(
    `cat <<'EOF'
{"type":"system","subtype":"init","session_id":"s1"}
{"type":"assistant","message":{"content":[{"type":"text","text":"Reading file"},{"type":"tool_use","id":"tu_1","name":"Read","input":{"file_path":"cli.ts"}}]}}
{"type":"result","subtype":"success","result":"Done reading.","is_error":false,"session_id":"s1"}
EOF`,
    async () => {
      const session = await claudeAdapter.openSession!({
        processRegistry: defaultRegistry,
      });
      try {
        const collected: RuntimeSessionEvent[] = [];
        for await (const ev of session.events) {
          collected.push(ev);
        }
        // Flatten per-event normalization into a single stream for
        // easier assertion.
        const normalized = collected.flatMap(extractSessionContent);
        assertEquals(normalized.length, 3);
        assertEquals(normalized[0], {
          kind: "text",
          text: "Reading file",
          cumulative: true,
        });
        assertEquals(normalized[1].kind, "tool");
        assertEquals((normalized[1] as { name: string }).name, "Read");
        assertEquals((normalized[1] as { id: string }).id, "tu_1");
        assertEquals(normalized[2], { kind: "final", text: "Done reading." });

        // Synthetic turn-end in the envelope must produce no content.
        const turnEnd = collected.find((e) => e.type === SYNTHETIC_TURN_END);
        assert(turnEnd, "expected a synthetic turn-end event");
        assertEquals(extractSessionContent(turnEnd), []);
      } finally {
        session.abort();
        await session.done;
      }
    },
  );
});

Deno.test("RuntimeSession contract — sessionId is populated after first event on Claude", async () => {
  // Claude's id is assigned inside the subprocess and surfaced in the
  // first system/init event. The neutral getter must reflect that once
  // the stream has been consumed.
  await withStubClaude(
    `cat <<'EOF'
{"type":"system","subtype":"init","session_id":"abc-123","model":"stub"}
{"type":"result","subtype":"success","result":"","is_error":false,"session_id":"abc-123"}
EOF`,
    async () => {
      const session = await claudeAdapter.openSession!({
        processRegistry: defaultRegistry,
      });
      try {
        for await (const _ of session.events) {
          // drain — session.sessionId is populated in-place by the
          // underlying Claude handle as events arrive.
        }
        assertEquals(session.sessionId, "abc-123");
      } finally {
        session.abort();
        await session.done;
      }
    },
  );
});
