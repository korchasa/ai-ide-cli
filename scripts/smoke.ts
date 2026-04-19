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
