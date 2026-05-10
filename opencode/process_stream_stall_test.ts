// FR-L36: stream-stall detector tests.
//
// These tests describe the contract for a watchdog that kills the
// OpenCode subprocess when its `--format json` stream stays silent
// longer than `streamStallTimeoutSeconds`, surfacing a typed
// `error_category: "stream_stall"` signal to the consumer.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { defaultRegistry } from "../process-registry.ts";
import { invokeOpenCodeCli } from "./process.ts";
import type { RuntimeInvokeOptions } from "../runtime/types.ts";

function makeInvokeOpts(
  overrides?: Partial<RuntimeInvokeOptions>,
): RuntimeInvokeOptions {
  return {
    taskPrompt: "do something",
    timeoutSeconds: 60,
    maxRetries: 1,
    retryDelaySeconds: 1,
    processRegistry: defaultRegistry,
    ...overrides,
  };
}

/**
 * Stub `opencode` binary that:
 *   1. Emits an initial JSON event burst, controlled by `events`.
 *   2. After the burst, sleeps for `tailSleepSec` simulating an
 *      upstream that holds the connection open without sending data.
 *   3. The adapter's stall watchdog should kill the process before
 *      `tailSleepSec` elapses.
 *
 * Each entry in `events` is a `[json, delaySecBeforeEmit]` pair.
 * Successive entries are emitted with the cumulative delay so the
 * stub can simulate "alive — periodic heartbeat" or "alive once,
 * then silent" patterns.
 */
async function withFakeOpencode<T>(
  events: Array<[Record<string, unknown>, number]>,
  tailSleepSec: number,
  fn: () => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "opencode-stall-stub-" });
  const binPath = `${dir}/opencode`;
  const logDir = `${dir}/log`;
  await Deno.mkdir(logDir);

  const emitLines: string[] = [];
  for (const [evt, delaySec] of events) {
    const json = JSON.stringify(evt).replace(/'/g, "'\\''");
    emitLines.push(`sleep ${delaySec}`);
    emitLines.push(`printf '%s\\n' '${json}'`);
  }
  const emitScript = emitLines.join("\n    ");

  await Deno.writeTextFile(
    binPath,
    `#!/usr/bin/env bash
case "$1" in
  run)
    ${emitScript}
    exec sleep ${tailSleepSec}
    ;;
  export)
    printf '{"sessionID":"%s","events":["ok"]}' "$2"
    exit 0
    ;;
  *)
    echo "unknown subcommand: $1" >&2
    exit 2
    ;;
esac
`,
  );
  await Deno.chmod(binPath, 0o755);

  const prevPath = Deno.env.get("PATH") ?? "";
  const prevLogDir = Deno.env.get("OPENCODE_LOG_DIR");
  Deno.env.set("PATH", `${dir}:${prevPath}`);
  Deno.env.set("OPENCODE_LOG_DIR", logDir);
  try {
    return await fn();
  } finally {
    Deno.env.set("PATH", prevPath);
    if (prevLogDir === undefined) Deno.env.delete("OPENCODE_LOG_DIR");
    else Deno.env.set("OPENCODE_LOG_DIR", prevLogDir);
    try {
      await Deno.remove(dir, { recursive: true });
    } catch {
      // best-effort cleanup
    }
  }
}

const stepStart = {
  type: "step_start",
  sessionID: "ses_stall_stub",
  timestamp: 0,
  part: { type: "step-start" },
};

Deno.test(
  "FR-L36 (a): stall fires after the configured threshold",
  async () => {
    const stallSec = 3;
    const tailSec = 60; // way longer than threshold — stub must be killed
    const start = performance.now();
    const result = await withFakeOpencode(
      [[stepStart, 0]], // one event then go silent
      tailSec,
      () =>
        invokeOpenCodeCli(
          makeInvokeOpts({
            timeoutSeconds: 30,
            streamStallTimeoutSeconds: stallSec,
          }),
        ),
    );
    const elapsedMs = performance.now() - start;

    assert(result.error, "expected stream stall to surface as error");
    assertStringIncludes(result.error!, "stream stall");
    assertStringIncludes(result.error!, `${stallSec}s`);
    assertEquals(
      (result as { error_category?: string }).error_category,
      "stream_stall",
    );
    // Watchdog fires AT the threshold (lower bound exact, no
    // negative slack); allow up to +5s upper slack for stub launch,
    // file IO, SIGTERM delivery.
    assert(
      elapsedMs >= stallSec * 1000 && elapsedMs < stallSec * 1000 + 5000,
      `expected stall in [${stallSec}s, ${stallSec}s + 5s]; elapsed ${elapsedMs}ms`,
    );
  },
);

Deno.test(
  "FR-L36 (b): stall short-circuits maxRetries — single spawn",
  async () => {
    const stallSec = 2;
    const start = performance.now();
    const result = await withFakeOpencode(
      [[stepStart, 0]],
      60,
      () =>
        invokeOpenCodeCli(
          makeInvokeOpts({
            timeoutSeconds: 30,
            maxRetries: 5,
            streamStallTimeoutSeconds: stallSec,
          }),
        ),
    );
    const elapsedMs = performance.now() - start;

    assertEquals(
      (result as { error_category?: string }).error_category,
      "stream_stall",
    );
    // 5 retries × 2s threshold = 10s minimum if retries fired.
    // Single spawn must wrap up before any retry would have had time
    // to spin up another stall window (3 × threshold gives generous
    // CI slack for stub launch / fs / SIGTERM).
    assert(
      elapsedMs < stallSec * 3 * 1000,
      `expected single attempt; elapsed ${elapsedMs}ms suggests retries fired`,
    );
  },
);

Deno.test(
  "FR-L36 (c): streamStallTimeoutSeconds=0 disables watchdog",
  async () => {
    // With watchdog disabled, the stub should run until its tail
    // sleep ends OR the wall-clock timeout fires. We use a short
    // tail (3s) so the test wraps up quickly via natural exit.
    const result = await withFakeOpencode(
      [[stepStart, 0]],
      3,
      () =>
        invokeOpenCodeCli(
          makeInvokeOpts({
            timeoutSeconds: 30,
            streamStallTimeoutSeconds: 0,
          }),
        ),
    );
    // No stream-stall error_category; the run either completed or
    // errored for some other reason (timeout / exit code), but NOT
    // because the disabled watchdog fired. Any error surfaced MUST
    // NOT mention stream stall.
    assertEquals(
      (result as { error_category?: string }).error_category,
      undefined,
      "watchdog disabled — error_category must not be set",
    );
    if (result.error) {
      assert(
        !result.error.includes("stream stall"),
        `unexpected stream-stall message with watchdog disabled: ${result.error}`,
      );
    }
  },
);

Deno.test(
  "FR-L36 (d): periodic heartbeat events keep watchdog at bay",
  async () => {
    // Heartbeat every 1s with a 3s threshold means the watchdog
    // never fires. Total run = 4 events × 1s + 1s tail = 5s.
    const result = await withFakeOpencode(
      [
        [stepStart, 0],
        [stepStart, 1],
        [stepStart, 1],
        [stepStart, 1],
      ],
      1,
      () =>
        invokeOpenCodeCli(
          makeInvokeOpts({
            timeoutSeconds: 30,
            streamStallTimeoutSeconds: 3,
          }),
        ),
    );
    assertEquals(
      (result as { error_category?: string }).error_category,
      undefined,
      "heartbeat must reset watchdog timer — no stall expected",
    );
    if (result.error) {
      assert(
        !result.error.includes("stream stall"),
        `heartbeat-keep-alive must not produce stream-stall error: ${result.error}`,
      );
    }
  },
);
