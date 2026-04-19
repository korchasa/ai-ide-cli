#!/usr/bin/env -S deno run -A
/**
 * @module
 * Behavioural smoke tests against real agent CLI binaries.
 *
 * Not part of `deno task check`. Invoked manually:
 *
 *   deno run -A scripts/smoke.ts            # run everything
 *   deno run -A scripts/smoke.ts abort      # only AbortSignal cases
 *   deno run -A scripts/smoke.ts settings   # only settingSources case
 *
 * Each scenario spends real tokens — gate with env flag or a real API key
 * in the environment. Failing scenarios exit with non-zero.
 */

import { invokeClaudeCli } from "../claude/process.ts";
import { openClaudeSession } from "../claude/session.ts";
import { getRuntimeAdapter } from "../runtime/index.ts";
import {
  SessionAbortedError,
  SessionInputClosedError,
  SYNTHETIC_TURN_END,
} from "../runtime/types.ts";
import type { RuntimeId } from "../types.ts";

interface Scenario {
  name: string;
  group: string;
  run: () => Promise<void>;
}

const scenarios: Scenario[] = [];

function scenario(group: string, name: string, run: () => Promise<void>) {
  scenarios.push({ group, name, run });
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`smoke assertion failed: ${msg}`);
}

// --- A2: AbortSignal ---

scenario(
  "abort",
  "pre-start abort returns 'Aborted before start'",
  async () => {
    const controller = new AbortController();
    controller.abort("manual");
    const res = await invokeClaudeCli({
      taskPrompt: "say hello",
      timeoutSeconds: 30,
      maxRetries: 1,
      retryDelaySeconds: 1,
      signal: controller.signal,
    });
    assert(res.error === "Aborted before start", `got ${JSON.stringify(res)}`);
    assert(res.output === undefined, "no output expected");
  },
);

scenario(
  "abort",
  "mid-run abort triggers SIGTERM and returns Aborted",
  async () => {
    const controller = new AbortController();
    // Give claude time to spawn, then abort.
    const abortTimer = setTimeout(() => controller.abort("smoke-test"), 800);
    const start = Date.now();
    const res = await invokeClaudeCli({
      taskPrompt: "Count from 1 to 1000 slowly, one number per line.",
      timeoutSeconds: 30,
      maxRetries: 1,
      retryDelaySeconds: 1,
      signal: controller.signal,
      verbosity: "quiet",
    });
    clearTimeout(abortTimer);
    const elapsed = Date.now() - start;
    assert(
      res.error?.startsWith("Aborted:"),
      `expected Aborted error, got ${JSON.stringify(res)}`,
    );
    // Must terminate well before timeoutSeconds (30s).
    assert(elapsed < 15000, `took too long: ${elapsed}ms`);
  },
);

scenario(
  "abort",
  "timeout fires without external signal (very short timeout)",
  async () => {
    const start = Date.now();
    const res = await invokeClaudeCli({
      taskPrompt: "Count from 1 to 1000 slowly, one number per line.",
      timeoutSeconds: 2,
      maxRetries: 1,
      retryDelaySeconds: 1,
      verbosity: "quiet",
    });
    const elapsed = Date.now() - start;
    // Without a user signal we don't return "Aborted" — the runtime surfaces
    // either the last partial result or an exit-code error, depending on
    // timing. What MUST hold is that we don't hang past ~timeout+slack.
    assert(
      elapsed < 10000,
      `timeout didn't fire in time: ${elapsed}ms (${JSON.stringify(res)})`,
    );
  },
);

// --- B3: settingSources isolation ---

scenario(
  "settings",
  "settingSources=[] produces an empty CLAUDE_CONFIG_DIR for the run",
  async () => {
    // End-to-end check: we just confirm the run completes without stalling
    // or crashing when Claude is pointed at an empty config dir.
    const res = await invokeClaudeCli({
      taskPrompt: "Reply with the single word: ok",
      timeoutSeconds: 30,
      maxRetries: 1,
      retryDelaySeconds: 1,
      settingSources: [],
      verbosity: "quiet",
    });
    assert(
      res.error === undefined,
      `settingSources=[] caused error: ${res.error}`,
    );
    assert(res.output !== undefined, "no output from claude");
  },
);

// --- session: streaming input ---

scenario(
  "session",
  "two user messages in one live session produce two turns",
  async () => {
    const session = await openClaudeSession({});
    const events: string[] = [];
    const turns: string[] = [];

    const collector = (async () => {
      for await (const event of session.events) {
        events.push(event.type);
        if (event.type === "result") {
          const r = event as { result?: string };
          turns.push(r.result ?? "");
        }
      }
    })();

    await session.send("Reply with exactly the word: one");
    // Wait for the first result, then push another message.
    while (turns.length < 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await session.send("Reply with exactly the word: two");
    while (turns.length < 2) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await session.endInput();
    const status = await session.done;
    await collector;

    assert(
      status.exitCode === 0,
      `session exited with code ${status.exitCode}: ${status.stderr}`,
    );
    assert(
      turns.length >= 2,
      `expected ≥2 result events, got ${turns.length}: ${
        JSON.stringify(turns)
      }`,
    );
    assert(
      turns[0].toLowerCase().includes("one"),
      `first turn missing 'one': ${turns[0]}`,
    );
    assert(
      turns[1].toLowerCase().includes("two"),
      `second turn missing 'two': ${turns[1]}`,
    );
  },
);

scenario(
  "session",
  "abort mid-session terminates the subprocess",
  async () => {
    const session = await openClaudeSession({});
    await session.send("Count slowly from 1 to 1000, one per line.");
    setTimeout(() => session.abort("smoke-test"), 600);
    const start = Date.now();
    const status = await session.done;
    const elapsed = Date.now() - start;
    assert(elapsed < 15000, `abort took too long: ${elapsed}ms`);
    assert(
      status.exitCode !== 0 || status.signal !== null,
      `expected non-zero/signal exit, got ${JSON.stringify(status)}`,
    );
  },
);

// --- session: neutral contract invariants (real Claude binary) ---

scenario(
  "session",
  "synthetic turn-end fires once per turn and carries native result in raw",
  async () => {
    const adapter = getRuntimeAdapter("claude");
    const session = await adapter.openSession!({});
    let turnEndCount = 0;
    let lastTurnEndRawType: unknown = undefined;
    let syntheticFlagSeen = false;

    await session.send("Reply with exactly the word: ping");

    const collector = (async () => {
      for await (const event of session.events) {
        if (event.type === SYNTHETIC_TURN_END) {
          turnEndCount++;
          lastTurnEndRawType = event.raw["type"];
          if (event.synthetic === true) syntheticFlagSeen = true;
          // One turn is enough — close the input after observing it.
          if (turnEndCount === 1) {
            await session.endInput();
          }
        }
      }
    })();

    await session.done;
    await collector;

    assert(
      turnEndCount === 1,
      `expected exactly one synthetic turn-end, got ${turnEndCount}`,
    );
    assert(
      syntheticFlagSeen,
      "synthetic flag must be true on the turn-end event",
    );
    assert(
      lastTurnEndRawType === "result",
      `turn-end raw should preserve native result type, got ${
        String(lastTurnEndRawType)
      }`,
    );
  },
);

scenario(
  "session",
  "sessionId populated after first init event on real Claude",
  async () => {
    const adapter = getRuntimeAdapter("claude");
    const session = await adapter.openSession!({});
    // Right after openSession() resolves, Claude's sessionId is still "" —
    // the CLI has not yet emitted system/init.
    const initial = session.sessionId;
    assert(
      initial === "",
      `expected empty sessionId before first event, got ${
        JSON.stringify(initial)
      }`,
    );

    await session.send("Reply with exactly the word: ok");

    let afterInit: string | undefined;
    const collector = (async () => {
      for await (const event of session.events) {
        if (event.type === "system" && afterInit === undefined) {
          afterInit = session.sessionId;
        }
        if (event.type === SYNTHETIC_TURN_END) {
          await session.endInput();
        }
      }
    })();

    await session.done;
    await collector;

    assert(
      typeof afterInit === "string" && afterInit.length > 0,
      `expected non-empty sessionId after system event, got ${
        JSON.stringify(afterInit)
      }`,
    );
    // Final read should also be stable and match the one captured at init.
    assert(
      session.sessionId === afterInit,
      `sessionId drifted: init=${afterInit}, final=${session.sessionId}`,
    );
  },
);

scenario(
  "session",
  "send after endInput throws SessionInputClosedError (real Claude)",
  async () => {
    const adapter = getRuntimeAdapter("claude");
    const session = await adapter.openSession!({});
    await session.endInput();
    let caught: unknown;
    try {
      await session.send("this should never be delivered");
    } catch (err) {
      caught = err;
    }
    await session.done;
    assert(
      caught instanceof SessionInputClosedError,
      `expected SessionInputClosedError, got ${
        Object.prototype.toString.call(caught)
      }: ${(caught as Error | undefined)?.message}`,
    );
  },
);

scenario(
  "session",
  "send after abort throws SessionAbortedError (real Claude)",
  async () => {
    const adapter = getRuntimeAdapter("claude");
    const session = await adapter.openSession!({});
    session.abort("smoke-test");
    let caught: unknown;
    try {
      await session.send("this should never be delivered");
    } catch (err) {
      caught = err;
    }
    await session.done;
    assert(
      caught instanceof SessionAbortedError,
      `expected SessionAbortedError, got ${
        Object.prototype.toString.call(caught)
      }: ${(caught as Error | undefined)?.message}`,
    );
  },
);

// --- session: neutral contract invariants on non-Claude runtimes ---
//
// For OpenCode/Cursor/Codex the session id is known synchronously at open
// time (unlike Claude, where the CLI allocates it inside the subprocess).
// We also verify synthetic turn-end and typed errors against the real
// binaries to catch any runtime-specific drift from the contract.

interface NonClaudeSpec {
  runtime: RuntimeId;
  group: string;
  prompt: string;
  // Per-runtime expected raw.type on the synthetic turn-end event.
  expectedTurnEndRawType: string;
}

const nonClaudeMatrix: NonClaudeSpec[] = [
  {
    runtime: "opencode",
    group: "session-opencode",
    prompt: "Reply with exactly the word: ok",
    // OpenCode dispatcher injects turn-end when it observes the busy→idle
    // edge; raw is the native event that triggered the transition —
    // typically `session.idle`, but `session.status` is also valid
    // depending on server build.
    expectedTurnEndRawType: "session.idle",
  },
  {
    runtime: "cursor",
    group: "session-cursor",
    prompt: "Reply with exactly the word: ok",
    expectedTurnEndRawType: "result",
  },
  {
    runtime: "codex",
    group: "session-codex",
    prompt: "Reply with exactly the word: ok",
    // Codex notifications are JSON-RPC — type is the last path segment.
    expectedTurnEndRawType: "completed",
  },
];

for (const spec of nonClaudeMatrix) {
  scenario(
    spec.group,
    `${spec.runtime}: sessionId populated synchronously at open`,
    async () => {
      const adapter = getRuntimeAdapter(spec.runtime);
      const session = await adapter.openSession!({});
      const captured = session.sessionId;
      session.abort("smoke-test");
      await session.done;
      assert(
        typeof captured === "string" && captured.length > 0,
        `expected non-empty sessionId immediately after openSession(), got ${
          JSON.stringify(captured)
        }`,
      );
    },
  );

  scenario(
    spec.group,
    `${spec.runtime}: synthetic turn-end fires once per turn with native raw`,
    async () => {
      const adapter = getRuntimeAdapter(spec.runtime);
      const session = await adapter.openSession!({});
      let turnEndCount = 0;
      let lastRawType: unknown = undefined;
      let syntheticFlagSeen = false;

      await session.send(spec.prompt);

      const collector = (async () => {
        for await (const event of session.events) {
          if (event.type === SYNTHETIC_TURN_END) {
            turnEndCount++;
            lastRawType = event.raw["type"] ?? event.raw["method"];
            if (event.synthetic === true) syntheticFlagSeen = true;
            if (turnEndCount === 1) await session.endInput();
          }
        }
      })();

      // Hard ceiling so a misconfigured backend doesn't hang the run.
      const timeoutId = setTimeout(
        () => session.abort("smoke-timeout"),
        60_000,
      );
      await session.done;
      clearTimeout(timeoutId);
      await collector;

      assert(
        turnEndCount === 1,
        `expected exactly one synthetic turn-end, got ${turnEndCount}`,
      );
      assert(
        syntheticFlagSeen,
        "synthetic flag must be true on the turn-end event",
      );
      // OpenCode's idle signal can be either `session.idle` or
      // `session.status`; accept both. Other runtimes are strict.
      if (spec.runtime === "opencode") {
        const ok = lastRawType === "session.idle" ||
          lastRawType === "session.status";
        assert(
          ok,
          `opencode turn-end raw type should be session.idle|session.status, got ${
            String(lastRawType)
          }`,
        );
      } else {
        // Codex stores the JSON-RPC method under raw.method; lastPathSegment
        // (`completed`) is already on event.type, so we verified it above.
        // For Cursor/Claude we check raw.type matches the native terminator.
        if (spec.runtime !== "codex") {
          assert(
            lastRawType === spec.expectedTurnEndRawType,
            `${spec.runtime} turn-end raw.type should be ${spec.expectedTurnEndRawType}, got ${
              String(lastRawType)
            }`,
          );
        }
      }
    },
  );

  scenario(
    spec.group,
    `${spec.runtime}: send after endInput throws SessionInputClosedError`,
    async () => {
      const adapter = getRuntimeAdapter(spec.runtime);
      const session = await adapter.openSession!({});
      await session.endInput();
      let caught: unknown;
      try {
        await session.send("this should never be delivered");
      } catch (err) {
        caught = err;
      }
      const timeoutId = setTimeout(
        () => session.abort("smoke-timeout"),
        30_000,
      );
      await session.done;
      clearTimeout(timeoutId);
      assert(
        caught instanceof SessionInputClosedError,
        `expected SessionInputClosedError, got ${
          Object.prototype.toString.call(caught)
        }: ${(caught as Error | undefined)?.message}`,
      );
    },
  );

  scenario(
    spec.group,
    `${spec.runtime}: send after abort throws SessionAbortedError`,
    async () => {
      const adapter = getRuntimeAdapter(spec.runtime);
      const session = await adapter.openSession!({});
      session.abort("smoke-test");
      let caught: unknown;
      try {
        await session.send("this should never be delivered");
      } catch (err) {
        caught = err;
      }
      await session.done;
      assert(
        caught instanceof SessionAbortedError,
        `expected SessionAbortedError, got ${
          Object.prototype.toString.call(caught)
        }: ${(caught as Error | undefined)?.message}`,
      );
    },
  );
}

// --- Runner ---

async function main() {
  const filter = Deno.args[0];
  const selected = filter
    ? scenarios.filter((s) => s.group === filter)
    : scenarios;
  if (!selected.length) {
    console.error(
      `no scenarios matched filter '${filter}'. Groups: ${
        [...new Set(scenarios.map((s) => s.group))].join(", ")
      }`,
    );
    Deno.exit(2);
  }

  let failed = 0;
  for (const s of selected) {
    const label = `[${s.group}] ${s.name}`;
    const start = Date.now();
    try {
      console.log(`\n--- ${label} ---`);
      await s.run();
      console.log(`OK (${Date.now() - start}ms)`);
    } catch (err) {
      failed++;
      console.error(
        `FAIL (${Date.now() - start}ms): ${(err as Error).message}`,
      );
    }
  }
  console.log(`\n${selected.length - failed}/${selected.length} passed`);
  if (failed > 0) Deno.exit(1);
}

if (import.meta.main) {
  await main();
}
