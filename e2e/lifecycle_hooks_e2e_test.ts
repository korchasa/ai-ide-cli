/**
 * @module
 * Runtime-neutral e2e for `RuntimeLifecycleHooks` (FR-L17). One short
 * one-turn invocation per runtime; asserts that the adapter wires its
 * native init/result events through to the runtime-neutral `onInit` /
 * `onResult` callbacks with the correct `runtime` field on `onInit`
 * and a final `CliRunOutput` on `onResult`.
 *
 * The acceptance row in SRS § 3.17 is currently evidenced only by
 * Claude unit tests (`claude/stream_test.ts`); this test pins the same
 * contract on the live binary of every adapter so an OpenCode/Codex/
 * Cursor regression in the init-event translation surfaces in
 * `deno task e2e` instead of slipping past CI.
 *
 * Gated on `E2E=1` + `E2E_RUNTIMES` + per-runtime CLI binary presence
 * + auth probe (FR-L34) — same gate as the rest of the suite.
 */

import { assert } from "@std/assert";
import type { RuntimeId } from "../types.ts";
import { defaultRegistry } from "../process-registry.ts";
import { getRuntimeAdapter } from "../runtime/index.ts";
import type { RuntimeInitInfo } from "../runtime/capability-types.ts";
import type { CliRunOutput } from "../types.ts";
import { ONE_WORD_OK, resolveEnabledMap } from "./_helpers.ts";

const RUNTIMES: RuntimeId[] = ["claude", "opencode", "cursor", "codex"];

const enabled = await resolveEnabledMap();

for (const runtime of RUNTIMES) {
  Deno.test({
    name:
      `e2e lifecycle/${runtime}/onInit + onResult fire with runtime-neutral payload`,
    ignore: !enabled[runtime],
    sanitizeOps: false,
    sanitizeResources: false,
    sanitizeExit: false,
    // FR-L17
    fn: async () => {
      const inits: RuntimeInitInfo[] = [];
      const results: CliRunOutput[] = [];
      const adapter = getRuntimeAdapter(runtime);
      const result = await adapter.invoke({
        processRegistry: defaultRegistry,
        taskPrompt: ONE_WORD_OK,
        timeoutSeconds: 60,
        maxRetries: 1,
        retryDelaySeconds: 0,
        verbosity: "quiet",
        hooks: {
          onInit: (info) => {
            inits.push(info);
          },
          onResult: (output) => {
            results.push(output);
          },
        },
      });

      assert(
        !result.error,
        `${runtime} invoke errored: ${result.error ?? ""}`,
      );

      assert(
        inits.length >= 1,
        `${runtime}: expected ≥1 onInit fire; got ${inits.length}`,
      );
      const init = inits[0];
      assert(
        init.runtime === runtime,
        `${runtime}: onInit.runtime mismatch; got ${init.runtime}`,
      );

      assert(
        results.length === 1,
        `${runtime}: expected exactly 1 onResult fire; got ${results.length}`,
      );
      assert(
        results[0] !== undefined,
        `${runtime}: onResult must receive a defined CliRunOutput`,
      );
    },
  });
}
