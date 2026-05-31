/**
 * @module
 * Cross-runtime contract suite for the ACP transport (FR-L39). Asserts
 * that **every** runtime — Claude, OpenCode, Cursor, Codex — exposes the
 * same {@link RuntimeSession} behavior when driven through
 * `transport: "acp"`. The matrix uses a single bash JSON-RPC stub
 * supplied via `acpFront` so the per-runtime `pilot` guard is bypassed
 * and the wire dialect is identical for every runtime — any divergence
 * here is a real adapter bug.
 *
 * Contract slice covered:
 *
 * - `runtime` matches the adapter id (per-runtime tag flows through).
 * - `sessionId` is populated synchronously after `openSession()`.
 * - `send` after `endInput` → {@link SessionInputClosedError}.
 * - `send` after `abort` → {@link SessionAbortedError}.
 * - `abort` is idempotent.
 * - `events` is a one-shot async iterator.
 * - `done` always resolves with {@link RuntimeSessionStatus}.
 * - Synthetic turn-end emitted exactly once per completed prompt.
 * - Transport-level RPC failures during `send` raise
 *   {@link SessionDeliveryError}.
 * - `extractSessionContent` (FR-L23) returns `[]` for ACP envelopes
 *   today — pinned so the gap promotes intentionally.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { ProcessRegistry } from "../../process-registry.ts";
import { getRuntimeAdapter } from "../index.ts";
import type { RuntimeId } from "../../types.ts";
import {
  type RuntimeSessionEvent,
  SessionAbortedError,
  SessionDeliveryError,
  SessionError,
  SessionInputClosedError,
  SYNTHETIC_TURN_END,
} from "../types.ts";
import { extractSessionContent } from "../content.ts";
import type { AcpFrontLauncher } from "./fronts.ts";

const RUNTIMES: readonly RuntimeId[] = [
  "claude",
  "opencode",
  "cursor",
  "codex",
];

const HANDSHAKE_SCRIPT = `
respond() {
  printf '{"jsonrpc":"2.0","id":%s,"result":%s}\\n' "$1" "$2"
}
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\\1/')
  method=$(printf '%s' "$line" | sed -E 's/.*"method":"([^"]+)".*/\\1/')
  case "$method" in
    initialize) respond "$id" '{}' ;;
    session/new) respond "$id" '{"sessionId":"contract-sess"}' ;;
    session/set_mode|session/set_config_option) respond "$id" 'null' ;;
    session/prompt)
      printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"contract-sess","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"ok"}}}}\\n'
      respond "$id" '{"stopReason":"end_turn"}'
      ;;
    *) respond "$id" 'null' ;;
  esac
done
`;

const PROMPT_RPC_ERROR_SCRIPT = `
respond() {
  printf '{"jsonrpc":"2.0","id":%s,"result":%s}\\n' "$1" "$2"
}
respond_err() {
  printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32603,"message":"prompt blew up"}}\\n' "$1"
}
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\\1/')
  method=$(printf '%s' "$line" | sed -E 's/.*"method":"([^"]+)".*/\\1/')
  case "$method" in
    initialize) respond "$id" '{}' ;;
    session/new) respond "$id" '{"sessionId":"contract-sess"}' ;;
    session/prompt) respond_err "$id" ;;
    *) respond "$id" 'null' ;;
  esac
done
`;

/**
 * Materialize a script-backed launcher under a unique temp dir. Returns
 * the launcher plus a disposer that removes the dir.
 */
async function makeStubLauncher(
  script: string,
): Promise<{ launcher: AcpFrontLauncher; dispose: () => Promise<void> }> {
  const dir = await Deno.makeTempDir({ prefix: "acp-contract-launcher-" });
  const path = `${dir}/acp-peer.sh`;
  await Deno.writeTextFile(path, `#!/usr/bin/env bash\n${script}\n`);
  await Deno.chmod(path, 0o755);
  return {
    launcher: { cmd: path, args: [], pilot: true },
    dispose: async () => {
      try {
        await Deno.remove(dir, { recursive: true });
      } catch {
        // best-effort cleanup
      }
    },
  };
}

/**
 * Generic per-runtime contract test wrapper. Spins up the launcher,
 * routes calls via the adapter under `transport: "acp"`, and tears down.
 */
async function withAcpSession<T>(
  runtime: RuntimeId,
  script: string,
  fn: (
    open: (extra?: Partial<{ resumeSessionId: string }>) => Promise<
      Awaited<
        ReturnType<
          NonNullable<
            ReturnType<typeof getRuntimeAdapter>["openSession"]
          >
        >
      >
    >,
  ) => Promise<T>,
): Promise<T> {
  const { launcher, dispose } = await makeStubLauncher(script);
  const adapter = getRuntimeAdapter(runtime);
  const registry = new ProcessRegistry();
  try {
    return await fn(async () =>
      await adapter.openSession!({
        processRegistry: registry,
        transport: "acp",
        acpFront: launcher,
      })
    );
  } finally {
    await registry.killAll().catch(() => {});
    await dispose();
  }
}

for (const runtime of RUNTIMES) {
  Deno.test(
    `RuntimeSession contract (acp/${runtime}) — runtime field matches adapter id`,
    async () => {
      await withAcpSession(runtime, HANDSHAKE_SCRIPT, async (open) => {
        const session = await open();
        try {
          assertEquals(session.runtime, runtime);
        } finally {
          session.abort();
          await session.done;
        }
      });
    },
  );

  Deno.test(
    `RuntimeSession contract (acp/${runtime}) — sessionId is populated synchronously`,
    async () => {
      await withAcpSession(runtime, HANDSHAKE_SCRIPT, async (open) => {
        const session = await open();
        try {
          assertEquals(session.sessionId, "contract-sess");
        } finally {
          session.abort();
          await session.done;
        }
      });
    },
  );

  Deno.test(
    `RuntimeSession contract (acp/${runtime}) — send after endInput throws SessionInputClosedError`,
    async () => {
      await withAcpSession(runtime, HANDSHAKE_SCRIPT, async (open) => {
        const session = await open();
        await session.endInput();
        const err = await assertRejects(
          () => session.send("late"),
          SessionInputClosedError,
        );
        assert(err instanceof SessionError);
        assertEquals(err.runtime, runtime);
        await session.done;
      });
    },
  );

  Deno.test(
    `RuntimeSession contract (acp/${runtime}) — send after abort throws SessionAbortedError`,
    async () => {
      await withAcpSession(runtime, HANDSHAKE_SCRIPT, async (open) => {
        const session = await open();
        session.abort("contract-test");
        const err = await assertRejects(
          () => session.send("after-abort"),
          SessionAbortedError,
        );
        assert(err instanceof SessionError);
        assertEquals(err.runtime, runtime);
        await session.done;
      });
    },
  );

  Deno.test(
    `RuntimeSession contract (acp/${runtime}) — abort is idempotent`,
    async () => {
      await withAcpSession(runtime, HANDSHAKE_SCRIPT, async (open) => {
        const session = await open();
        session.abort("first");
        session.abort("second");
        session.abort("third");
        const status = await session.done;
        assertEquals(typeof status.stderr, "string");
        assert(typeof status.exitCode === "number" || status.exitCode === null);
      });
    },
  );

  Deno.test(
    `RuntimeSession contract (acp/${runtime}) — done resolves after abort`,
    async () => {
      await withAcpSession(runtime, HANDSHAKE_SCRIPT, async (open) => {
        const session = await open();
        session.abort();
        const status = await session.done;
        assert(typeof status.exitCode === "number" || status.exitCode === null);
        assert(typeof status.stderr === "string");
        assert(status.signal === null || typeof status.signal === "string");
      });
    },
  );

  Deno.test(
    `RuntimeSession contract (acp/${runtime}) — events iterable is single-consumer`,
    async () => {
      await withAcpSession(runtime, HANDSHAKE_SCRIPT, async (open) => {
        const session = await open();
        try {
          await session.send("ping");
          session.abort();
          for await (const _ of session.events) {
            // drain to completion
          }
          let threw = false;
          try {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            for await (const _ of session.events) { /* noop */ }
          } catch (err) {
            threw = true;
            assert(err instanceof Error);
            assert(/only be iterated once/.test(err.message));
          }
          assert(threw, "expected re-iteration to throw");
        } finally {
          await session.done;
        }
      });
    },
  );

  Deno.test(
    `RuntimeSession contract (acp/${runtime}) — synthetic turn-end is emitted after a completed prompt`,
    async () => {
      await withAcpSession(runtime, HANDSHAKE_SCRIPT, async (open) => {
        const session = await open();
        try {
          const collected: RuntimeSessionEvent[] = [];
          const drainer = (async () => {
            for await (const ev of session.events) {
              collected.push(ev);
              if (ev.type === SYNTHETIC_TURN_END) break;
            }
          })();
          await session.send("hello");
          await drainer;
          const turnEnds = collected.filter((e) =>
            e.type === SYNTHETIC_TURN_END
          );
          assertEquals(
            turnEnds.length,
            1,
            `expected one synthetic turn-end, got ${turnEnds.length}`,
          );
          assert(turnEnds[0].synthetic === true);
          assertEquals(turnEnds[0].runtime, runtime);
          assertEquals(turnEnds[0].raw["stopReason"], "end_turn");
        } finally {
          session.abort();
          await session.done;
        }
      });
    },
  );

  Deno.test(
    `RuntimeSession contract (acp/${runtime}) — send wraps RPC failure in SessionDeliveryError`,
    async () => {
      await withAcpSession(runtime, PROMPT_RPC_ERROR_SCRIPT, async (open) => {
        const session = await open();
        try {
          const err = await assertRejects(
            () => session.send("boom"),
            SessionDeliveryError,
          );
          assert(err instanceof SessionError);
          assertEquals(err.runtime, runtime);
          assert(
            /prompt blew up/.test(err.message),
            `expected RPC error message in SessionDeliveryError, got ${err.message}`,
          );
        } finally {
          session.abort();
          await session.done;
        }
      });
    },
  );

  Deno.test(
    `RuntimeSession contract (acp/${runtime}) — extractSessionContent returns [] for ACP events today`,
    async () => {
      // Documented gap (see `runtime/acp/mapping.ts`): the FR-L23
      // dispatcher currently has no ACP arm. Pinning the gap so a
      // future ACP-aware extractor promotes intentionally rather than
      // by accident — and to confirm that every runtime sees the same
      // behavior here (the dispatcher branches on `event.runtime`, so
      // a regression on one runtime would split the matrix).
      await withAcpSession(runtime, HANDSHAKE_SCRIPT, async (open) => {
        const session = await open();
        try {
          const collected: RuntimeSessionEvent[] = [];
          const drainer = (async () => {
            for await (const ev of session.events) {
              collected.push(ev);
              if (ev.type === SYNTHETIC_TURN_END) break;
            }
          })();
          await session.send("hi");
          await drainer;
          const normalized = collected.flatMap(extractSessionContent);
          assertEquals(
            normalized.length,
            0,
            `expected no normalized content for ACP envelopes on ${runtime}, got ${
              JSON.stringify(normalized)
            }`,
          );
        } finally {
          session.abort();
          await session.done;
        }
      });
    },
  );
}

// ───────────── Cross-runtime invariants ─────────────

Deno.test(
  "RuntimeSession contract (acp) — every runtime advertises session capability",
  () => {
    // The ACP adapter does not register a new RuntimeAdapter — it
    // shares the per-runtime adapter's capability vector. This pins
    // that the ACP code path is reachable on every runtime today.
    for (const runtime of RUNTIMES) {
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
  },
);

Deno.test(
  "RuntimeSession contract (acp) — without acpFront override, non-pilot runtimes are refused",
  async () => {
    // Counter-test: ensure the override is the only documented escape
    // hatch. Without it, runtimes flagged `pilot: false` in
    // `runtime/acp/fronts.ts` (cursor — needs local IDE binary; claude,
    // codex, and opencode are piloted) must NOT silently spawn — a
    // regression that lifts that guard would falsely promote untested
    // wire compatibility.
    const nonPilot: RuntimeId[] = ["cursor"];
    for (const runtime of nonPilot) {
      const adapter = getRuntimeAdapter(runtime);
      const registry = new ProcessRegistry();
      const result = await adapter.invoke({
        processRegistry: registry,
        taskPrompt: "ok",
        timeoutSeconds: 30,
        maxRetries: 0,
        retryDelaySeconds: 0,
        transport: "acp",
      });
      assert(
        result.error,
        `expected refusal for ${runtime} without acpFront, got ${
          JSON.stringify(result)
        }`,
      );
      assert(
        /not piloted/.test(result.error),
        `${runtime} error must mention pilot status: ${result.error}`,
      );
    }
  },
);
