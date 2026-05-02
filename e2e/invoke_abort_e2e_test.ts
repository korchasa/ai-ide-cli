/**
 * @module
 * Runtime-neutral one-shot `adapter.invoke()` abort scenarios (FR-L15).
 * Generates one test triple per runtime so the AbortSignal contract
 * (pre-start abort returns `"Aborted before start"`; mid-run abort
 * returns `"Aborted: <reason>"` within the timeout) is asserted on the
 * live binary of every adapter, not just Claude.
 *
 * Gated on `E2E=1` + `E2E_RUNTIMES` + per-runtime CLI binary presence
 * + auth probe (FR-L34) — same gate as the session matrix.
 */

import { assert } from "@std/assert";
import type { RuntimeId } from "../types.ts";
import { getRuntimeAdapter } from "../runtime/index.ts";
import { defaultRegistry } from "../process-registry.ts";
import { LONG_COUNT_PROMPT, resolveEnabledMap } from "./_helpers.ts";

const RUNTIMES: RuntimeId[] = ["claude", "opencode", "cursor", "codex"];

const enabled = await resolveEnabledMap();

for (const runtime of RUNTIMES) {
  Deno.test({
    name: `e2e abort/${runtime}/pre-start returns 'Aborted before start'`,
    ignore: !enabled[runtime],
    sanitizeOps: false,
    sanitizeResources: false,
    sanitizeExit: false,
    fn: async () => {
      const adapter = getRuntimeAdapter(runtime);
      const controller = new AbortController();
      controller.abort("e2e-pre-abort");
      const res = await adapter.invoke({
        processRegistry: defaultRegistry,
        taskPrompt: "say hello",
        timeoutSeconds: 30,
        maxRetries: 1,
        retryDelaySeconds: 1,
        signal: controller.signal,
      });
      assert(
        res.error === "Aborted before start",
        `${runtime}: got ${JSON.stringify(res)}`,
      );
      assert(
        res.output === undefined,
        `${runtime}: no output expected for pre-start abort`,
      );
    },
  });

  Deno.test({
    name: `e2e abort/${runtime}/mid-run triggers abort and returns Aborted`,
    ignore: !enabled[runtime],
    sanitizeOps: false,
    sanitizeResources: false,
    sanitizeExit: false,
    fn: async () => {
      const adapter = getRuntimeAdapter(runtime);
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort("e2e-mid"), 800);
      const start = Date.now();
      const res = await adapter.invoke({
        processRegistry: defaultRegistry,
        taskPrompt: LONG_COUNT_PROMPT,
        timeoutSeconds: 60,
        maxRetries: 1,
        retryDelaySeconds: 1,
        signal: controller.signal,
        verbosity: "quiet",
      });
      clearTimeout(abortTimer);
      const elapsed = Date.now() - start;
      assert(
        res.error?.startsWith("Aborted:"),
        `${runtime}: expected Aborted error, got ${JSON.stringify(res)}`,
      );
      // Cursor faux-session needs a longer slack — `cursor agent -p` is
      // launched per-turn and SIGTERM may take a few seconds to wind
      // down. 25 s upper bound is well below the 60 s timeoutSeconds.
      assert(
        elapsed < 25_000,
        `${runtime}: took too long: ${elapsed}ms`,
      );
    },
  });

  Deno.test({
    name: `e2e abort/${runtime}/timeout fires without external signal`,
    ignore: !enabled[runtime],
    sanitizeOps: false,
    sanitizeResources: false,
    sanitizeExit: false,
    fn: async () => {
      const adapter = getRuntimeAdapter(runtime);
      const start = Date.now();
      const res = await adapter.invoke({
        processRegistry: defaultRegistry,
        taskPrompt: LONG_COUNT_PROMPT,
        timeoutSeconds: 2,
        maxRetries: 1,
        retryDelaySeconds: 1,
        verbosity: "quiet",
      });
      const elapsed = Date.now() - start;
      // Without a user signal we don't return "Aborted" — the runtime
      // surfaces either the last partial result or an exit-code error.
      // What MUST hold is that we don't hang past ~timeout+slack.
      assert(
        elapsed < 15_000,
        `${runtime}: timeout didn't fire in time: ${elapsed}ms (${
          JSON.stringify(res)
        })`,
      );
    },
  });
}
