import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { defaultRegistry } from "../process-registry.ts";
import { invokeOpenCodeCli } from "./process.ts";
import type { RuntimeInvokeOptions } from "../runtime/types.ts";

function makeInvokeOpts(
  overrides?: Partial<RuntimeInvokeOptions>,
): RuntimeInvokeOptions {
  return {
    taskPrompt: "do something",
    timeoutSeconds: 30,
    maxRetries: 3,
    retryDelaySeconds: 1,
    processRegistry: defaultRegistry,
    ...overrides,
  };
}

/**
 * Stub `opencode` binary that:
 *   1. Emits a single `step_start` JSON event to stdout (so the adapter
 *      starts processing).
 *   2. Appends a 429 line to a fake internal log file at
 *      `$OPENCODE_LOG_DIR/<ts>.log` after a small delay (simulating the
 *      CLI's silent retry on rate-limited upstream).
 *   3. Replaces itself with `sleep` so the process stays alive until the
 *      adapter kills it via SIGTERM.
 *
 * The fake log file lives in a per-test temp dir; the adapter is steered
 * to it via the `OPENCODE_LOG_DIR` env override.
 */
async function withFakeOpencode<T>(
  logBody: string,
  delayMs: number,
  fn: (logDir: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "opencode-fatal-stub-" });
  const binPath = `${dir}/opencode`;
  const logDir = `${dir}/log`;
  await Deno.mkdir(logDir);
  const logFile = `${logDir}/active.log`;

  const stepStart = JSON.stringify({
    type: "step_start",
    sessionID: "ses_fatal_stub",
    timestamp: Date.now(),
    part: { type: "step-start" },
  });

  await Deno.writeTextFile(
    binPath,
    `#!/usr/bin/env bash
case "$1" in
  run)
    printf '%s\n' '${stepStart.replace(/'/g, "'\\''")}'
    (sleep $(awk "BEGIN{print ${delayMs}/1000}"); cat >> "${logFile}" <<'LOGEOF'
${logBody}
LOGEOF
    ) &
    exec sleep 30
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
    return await fn(logDir);
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

Deno.test(
  "invokeOpenCodeCli — detects upstream 429 in opencode log and surfaces verbatim message",
  async () => {
    const start = performance.now();
    const result = await withFakeOpencode(
      `INFO 2026-05-09T03:54:10 service=upstream-fetch {"statusCode":429,"data":{"error":{"code":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at 2026-05-09 04:56:07"}}}`,
      300,
      async () =>
        await invokeOpenCodeCli(
          makeInvokeOpts({ timeoutSeconds: 30, maxRetries: 1 }),
        ),
    );
    const elapsedMs = performance.now() - start;

    assert(result.error, "expected upstream fatal to surface as error");
    assertStringIncludes(result.error!, "upstream HTTP 429");
    assertStringIncludes(result.error!, "Usage limit reached for 5 hour");
    // Detector + SIGTERM path is fast — should be well under 5s vs the
    // 30s sleep in the stub.
    assert(
      elapsedMs < 5_000,
      `detection should be sub-second; elapsed ${elapsedMs}ms`,
    );
  },
);

Deno.test(
  "invokeOpenCodeCli — upstream-fatal error short-circuits the maxRetries loop",
  async () => {
    // With maxRetries=3 and no upstream-fatal short-circuit, three full
    // 30s spawns would be attempted. With the short-circuit, we expect
    // exactly one spawn → fast failure.
    const start = performance.now();
    const result = await withFakeOpencode(
      `... {"statusCode":429,"error":{"message":"Quota exceeded"}}`,
      200,
      async () =>
        await invokeOpenCodeCli(
          makeInvokeOpts({ timeoutSeconds: 30, maxRetries: 3 }),
        ),
    );
    const elapsedMs = performance.now() - start;

    assertStringIncludes(result.error!, "upstream HTTP 429");
    assertStringIncludes(result.error!, "Quota exceeded");
    assert(
      elapsedMs < 5_000,
      `expected single attempt; elapsed ${elapsedMs}ms suggests retries fired`,
    );
  },
);

Deno.test(
  "invokeOpenCodeCli — non-fatal status (HTTP 503) does NOT trigger detector",
  async () => {
    // 503 is not in the fatal set; the detector should ignore it. The stub
    // still goes to the `exec sleep 30` path so the run will time out via
    // the wall-clock timeout — that's fine, we only assert no upstream
    // message is surfaced.
    const result = await withFakeOpencode(
      `INFO {"statusCode":503,"error":{"message":"upstream temporarily unavailable"}}`,
      200,
      async () =>
        await invokeOpenCodeCli(
          makeInvokeOpts({ timeoutSeconds: 2, maxRetries: 1 }),
        ),
    );

    assertEquals(
      result.error?.includes("upstream HTTP") ?? false,
      false,
      `503 should not surface as upstream-fatal; got error: ${result.error}`,
    );
  },
);
