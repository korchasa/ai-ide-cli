/**
 * @module
 * Shared session-contract matrix for the real-binary e2e suite. Each
 * scenario runs once per session-capable runtime (Claude / OpenCode /
 * Cursor / Codex) via the generator in `session_matrix_e2e_test.ts`,
 * except where `only` / `skip` narrow the set.
 *
 * The matrix mirrors the stub-based contract enforced in
 * `runtime/session_contract_test.ts` — a regression in any adapter that
 * passes the stub tests but breaks against the real binary is exactly
 * what this suite is meant to catch (protocol drift, argv renames,
 * event-shape changes upstream).
 */

import { assert, assertEquals } from "@std/assert";
import type { RuntimeId } from "../types.ts";
import { getRuntimeAdapter } from "../runtime/index.ts";
import {
  SessionAbortedError,
  SessionInputClosedError,
  SYNTHETIC_TURN_END,
} from "../runtime/types.ts";
import type { RuntimeSession, RuntimeSessionEvent } from "../runtime/types.ts";
import {
  ceiling,
  LONG_COUNT_PROMPT,
  ONE_WORD_DONE,
  ONE_WORD_OK,
} from "./_helpers.ts";

/** Default hard ceiling (ms) per scenario when the runtime has no override. */
export const DEFAULT_CEILING_MS: number = 60_000;
/** Cursor cold-start + create-chat + resume is slower than the others. */
export const CURSOR_CEILING_MS: number = 90_000;

/** One entry of the shared session-contract catalog. */
export interface MatrixScenario {
  /** Stable short identifier — becomes part of the `Deno.test` name. */
  id: string;
  /** Scenario body. Receives the runtime it is being executed against. */
  run: (runtime: RuntimeId) => Promise<void>;
  /** Runtimes that cannot support this scenario (transport-level skip). */
  skip?: RuntimeId[];
  /** Restrict scenario to a specific subset of runtimes. */
  only?: RuntimeId[];
  /** Per-runtime hard-ceiling override (ms). Falls back to DEFAULT_CEILING_MS. */
  ceilingMs?: Partial<Record<RuntimeId, number>>;
}

/** Per-runtime predicates and tweaks used by matrix scenarios. */
export interface RuntimeMatrixSpec {
  /** Accepts the native raw payload carried on the synthetic turn-end event. */
  turnEndRaw: (raw: Record<string, unknown>) => boolean;
}

/**
 * Per-runtime synthetic-turn-end raw-payload predicates. Keep in sync with
 * `scripts/smoke.ts` and the per-adapter docs in `runtime/CLAUDE.md`.
 */
export const RUNTIME_SPECS: Record<RuntimeId, RuntimeMatrixSpec> = {
  claude: {
    turnEndRaw: (raw) => raw.type === "result",
  },
  cursor: {
    turnEndRaw: (raw) => raw.type === "result",
  },
  codex: {
    // `RuntimeSessionEvent.type` for Codex is the last path segment
    // (`completed`), but `raw` carries the original JSON-RPC envelope.
    turnEndRaw: (raw) => {
      const method = raw.method;
      return typeof method === "string" && method.endsWith("/completed");
    },
  },
  opencode: {
    // OpenCode dispatcher edge-triggers turn-end on busy→idle; the native
    // event that caused the transition is either `session.idle` or
    // `session.status { status: idle }` depending on server build.
    turnEndRaw: (raw) =>
      raw.type === "session.idle" || raw.type === "session.status",
  },
};

/**
 * Resolve the hard-ceiling (ms) for a scenario × runtime pair, falling
 * back to the default when the scenario has no runtime-specific override.
 *
 * @param scenario Scenario whose ceiling overrides to consult.
 * @param runtime Runtime the scenario is being executed against.
 */
export function ceilingForRuntime(
  scenario: MatrixScenario,
  runtime: RuntimeId,
): number {
  return scenario.ceilingMs?.[runtime] ?? DEFAULT_CEILING_MS;
}

/** Fetch the adapter and assert it implements `openSession`. */
function sessionAdapter(runtime: RuntimeId) {
  const adapter = getRuntimeAdapter(runtime);
  if (!adapter.capabilities.session || !adapter.openSession) {
    throw new Error(`runtime ${runtime} does not support openSession`);
  }
  return adapter;
}

/**
 * Drain `session.events` in the background, invoking `onEvent` on every
 * event. Returns a handle that `await`s the drainer on cleanup.
 */
function startDrain(
  session: RuntimeSession,
  onEvent: (ev: RuntimeSessionEvent) => void | Promise<void>,
): { drainer: Promise<void> } {
  const drainer = (async () => {
    for await (const ev of session.events) {
      await onEvent(ev);
    }
  })();
  return { drainer };
}

async function finalizeSession(session: RuntimeSession): Promise<void> {
  try {
    session.abort("e2e-cleanup");
  } catch {
    // abort is idempotent; swallow re-throws
  }
  await session.done;
}

// --- scenario implementations -------------------------------------------

/**
 * Scenario 1a — `sessionId` is non-empty synchronously after `openSession()`
 * resolves. Applies to OpenCode / Cursor / Codex (see scenario 1b for Claude).
 */
export async function scenarioSessionIdSync(runtime: RuntimeId): Promise<void> {
  const adapter = sessionAdapter(runtime);
  const session = await adapter.openSession!({});
  const cancel = ceiling(
    DEFAULT_CEILING_MS,
    () => session.abort("e2e-ceiling"),
  );
  try {
    const captured = session.sessionId;
    assert(
      typeof captured === "string" && captured.length > 0,
      `expected non-empty sessionId synchronously, got ${
        JSON.stringify(captured)
      }`,
    );
  } finally {
    cancel();
    await finalizeSession(session);
  }
}

/**
 * Scenario 1b — Claude-only. `sessionId` is `""` before the first event,
 * non-empty after the first `system/init` event.
 */
export async function scenarioSessionIdAfterInit(
  runtime: RuntimeId,
): Promise<void> {
  assertEquals(runtime, "claude", "sessionId-after-first-event is Claude-only");
  const adapter = sessionAdapter(runtime);
  const session = await adapter.openSession!({});
  const cancel = ceiling(
    DEFAULT_CEILING_MS,
    () => session.abort("e2e-ceiling"),
  );
  try {
    assertEquals(
      session.sessionId,
      "",
      "Claude sessionId must be empty before first event",
    );

    let afterInit: string | undefined;
    const { drainer } = startDrain(session, async (ev) => {
      if (ev.type === "system" && afterInit === undefined) {
        afterInit = session.sessionId;
      }
      if (ev.type === SYNTHETIC_TURN_END) {
        await session.endInput();
      }
    });

    await session.send(ONE_WORD_OK);
    await session.done;
    await drainer;

    assert(
      typeof afterInit === "string" && afterInit.length > 0,
      `expected non-empty sessionId after system event, got ${
        JSON.stringify(afterInit)
      }`,
    );
    assertEquals(
      session.sessionId,
      afterInit,
      "sessionId must be stable after initial population",
    );
  } finally {
    cancel();
    await finalizeSession(session);
  }
}

/**
 * Scenario 2 — exactly one `SYNTHETIC_TURN_END` per completed turn. The raw
 * payload must satisfy the runtime's `turnEndRaw` predicate and carry
 * `synthetic: true`.
 */
export async function scenarioSyntheticTurnEnd(
  runtime: RuntimeId,
): Promise<void> {
  const adapter = sessionAdapter(runtime);
  const session = await adapter.openSession!({});
  const cancel = ceiling(
    runtime === "cursor" ? CURSOR_CEILING_MS : DEFAULT_CEILING_MS,
    () => session.abort("e2e-ceiling"),
  );
  try {
    let turnEndCount = 0;
    let lastRaw: Record<string, unknown> | undefined;
    let syntheticFlagSeen = false;

    const { drainer } = startDrain(session, async (ev) => {
      if (ev.type === SYNTHETIC_TURN_END) {
        turnEndCount++;
        lastRaw = ev.raw;
        if (ev.synthetic === true) syntheticFlagSeen = true;
        if (turnEndCount === 1) await session.endInput();
      }
    });

    await session.send(ONE_WORD_OK);
    await session.done;
    await drainer;

    assertEquals(
      turnEndCount,
      1,
      `expected exactly one synthetic turn-end, got ${turnEndCount}`,
    );
    assert(syntheticFlagSeen, "synthetic flag must be true on turn-end");
    assert(lastRaw !== undefined, "turn-end raw must be present");
    assert(
      RUNTIME_SPECS[runtime].turnEndRaw(lastRaw),
      `turn-end raw failed predicate for ${runtime}: ${
        JSON.stringify(lastRaw)
      }`,
    );
  } finally {
    cancel();
    await finalizeSession(session);
  }
}

/**
 * Scenario 3 — `send` after `endInput` rejects with `SessionInputClosedError`.
 * Finalizer awaits `done` so the next test starts with a clean process table.
 */
export async function scenarioSendAfterEndInput(
  runtime: RuntimeId,
): Promise<void> {
  const adapter = sessionAdapter(runtime);
  const session = await adapter.openSession!({});
  const cancel = ceiling(
    DEFAULT_CEILING_MS,
    () => session.abort("e2e-ceiling"),
  );
  try {
    await session.endInput();
    let caught: unknown;
    try {
      await session.send("this should never be delivered");
    } catch (err) {
      caught = err;
    }
    assert(
      caught instanceof SessionInputClosedError,
      `expected SessionInputClosedError, got ${
        Object.prototype.toString.call(caught)
      }: ${(caught as Error | undefined)?.message}`,
    );
    await session.done;
  } finally {
    cancel();
    await finalizeSession(session);
  }
}

/**
 * Scenario 4 — `send` after `abort` rejects with `SessionAbortedError`.
 * Finalizer awaits `done` so the next test starts with a clean process table.
 */
export async function scenarioSendAfterAbort(
  runtime: RuntimeId,
): Promise<void> {
  const adapter = sessionAdapter(runtime);
  const session = await adapter.openSession!({});
  const cancel = ceiling(
    DEFAULT_CEILING_MS,
    () => session.abort("e2e-ceiling"),
  );
  try {
    session.abort("e2e-test");
    let caught: unknown;
    try {
      await session.send("this should never be delivered");
    } catch (err) {
      caught = err;
    }
    assert(
      caught instanceof SessionAbortedError,
      `expected SessionAbortedError, got ${
        Object.prototype.toString.call(caught)
      }: ${(caught as Error | undefined)?.message}`,
    );
    await session.done;
  } finally {
    cancel();
    await finalizeSession(session);
  }
}

/**
 * Scenario 5 — `abort()` mid-turn resolves `done` within the runtime's hard
 * ceiling. The exact exit form is runtime-specific: Claude/Cursor exit
 * non-zero or on a signal; Codex's app-server catches SIGTERM and exits
 * cleanly (`exitCode: 0, signal: null`); OpenCode's server also shuts down
 * gracefully. The portable invariant is the elapsed-time bound.
 */
export async function scenarioAbortMidTurn(runtime: RuntimeId): Promise<void> {
  const adapter = sessionAdapter(runtime);
  const session = await adapter.openSession!({});
  const runtimeCeiling = runtime === "cursor" ? CURSOR_CEILING_MS : 15_000;
  const cancel = ceiling(runtimeCeiling, () => session.abort("e2e-ceiling"));
  try {
    // Background drain — scenarios must consume events so the queue
    // does not backpressure.
    const { drainer } = startDrain(session, () => {});
    await session.send(LONG_COUNT_PROMPT);
    setTimeout(() => session.abort("e2e-abort"), 600);
    const start = Date.now();
    const status = await session.done;
    const elapsed = Date.now() - start;
    await drainer;
    assert(
      elapsed < runtimeCeiling,
      `abort took too long: ${elapsed}ms (ceiling ${runtimeCeiling}ms)`,
    );
    // Runtimes that propagate the signal (Claude/Cursor): expect non-zero
    // exit or a signal name. Runtimes whose transport handles SIGTERM
    // gracefully (Codex app-server, OpenCode serve): accept a clean exit.
    if (runtime === "claude" || runtime === "cursor") {
      assert(
        status.exitCode !== 0 || status.signal !== null,
        `expected non-zero/signal exit for ${runtime}, got ${
          JSON.stringify(status)
        }`,
      );
    }
  } finally {
    cancel();
    await finalizeSession(session);
  }
}

/**
 * Scenario 6 — two consecutive user messages produce two turn-ends in order;
 * `endInput` then `done` resolves cleanly.
 */
export async function scenarioTwoTurns(runtime: RuntimeId): Promise<void> {
  const adapter = sessionAdapter(runtime);
  const session = await adapter.openSession!({});
  const runtimeCeiling = runtime === "cursor"
    ? CURSOR_CEILING_MS
    : DEFAULT_CEILING_MS;
  const cancel = ceiling(runtimeCeiling, () => session.abort("e2e-ceiling"));
  try {
    let turnEndCount = 0;
    const turnGate = {
      resolveFirst: null as null | (() => void),
    };
    const firstTurnDone = new Promise<void>((resolve) => {
      turnGate.resolveFirst = resolve;
    });

    const { drainer } = startDrain(session, async (ev) => {
      if (ev.type === SYNTHETIC_TURN_END) {
        turnEndCount++;
        if (turnEndCount === 1) {
          turnGate.resolveFirst?.();
        } else if (turnEndCount >= 2) {
          await session.endInput();
        }
      }
    });

    await session.send(ONE_WORD_OK);
    await firstTurnDone;
    await session.send(ONE_WORD_DONE);
    await session.done;
    await drainer;

    assert(
      turnEndCount >= 2,
      `expected ≥2 synthetic turn-ends, got ${turnEndCount}`,
    );
  } finally {
    cancel();
    await finalizeSession(session);
  }
}

/** Session-contract matrix — driven by the generator in the test file. */
// FR-L24
export const SESSION_CONTRACT_MATRIX: MatrixScenario[] = [
  {
    id: "sessionId-sync",
    only: ["opencode", "cursor", "codex"],
    run: scenarioSessionIdSync,
  },
  {
    id: "sessionId-after-first-event",
    only: ["claude"],
    run: scenarioSessionIdAfterInit,
  },
  {
    id: "synthetic-turn-end-once-per-turn",
    ceilingMs: { cursor: CURSOR_CEILING_MS },
    run: scenarioSyntheticTurnEnd,
  },
  {
    id: "send-after-endInput-throws-SessionInputClosedError",
    run: scenarioSendAfterEndInput,
  },
  {
    id: "send-after-abort-throws-SessionAbortedError",
    run: scenarioSendAfterAbort,
  },
  {
    id: "abort-mid-turn-terminates",
    ceilingMs: { cursor: CURSOR_CEILING_MS },
    run: scenarioAbortMidTurn,
  },
  {
    id: "two-turns",
    ceilingMs: { cursor: CURSOR_CEILING_MS },
    run: scenarioTwoTurns,
  },
];
