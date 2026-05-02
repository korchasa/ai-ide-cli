/**
 * @module
 * Real-binary smoke for the typed `reasoningEffort` field (FR-L25) on
 * Claude and Codex. Verifies that the adapter passes the resulting
 * native control (`--effort <value>` for Claude,
 * `--config model_reasoning_effort="<value>"` for Codex) to the binary
 * in a way the binary accepts — i.e. the run completes without a
 * flag-parse / unknown-config error from the CLI.
 *
 * The test deliberately does NOT assert on whether the model actually
 * reasons "harder" — that is provider/model-dependent and not the
 * adapter's contract. What the library guarantees, and what this test
 * pins, is that the typed field reaches the subprocess intact.
 *
 * OpenCode (`--variant <value>`) is excluded: the variant is
 * provider-specific and a fresh OpenCode install with the default
 * model may not have a `low` / `high` variant configured, which would
 * surface as a benign upstream error rather than an adapter
 * regression. Argv propagation for OpenCode is unit-tested.
 *
 * Cursor sets `capabilities.reasoningEffort = false`; the adapter
 * warns once and ignores the field — that path is unit-tested.
 */

import { assert } from "@std/assert";
import type { RuntimeId } from "../types.ts";
import { defaultRegistry } from "../process-registry.ts";
import { getRuntimeAdapter } from "../runtime/index.ts";
import { ONE_WORD_OK, resolveEnabledMap } from "./_helpers.ts";

const RUNTIMES: RuntimeId[] = ["claude", "codex"];

const enabled = await resolveEnabledMap();

for (const runtime of RUNTIMES) {
  Deno.test({
    name:
      `e2e reasoning-effort/${runtime}/typed field propagates to argv without parse error`,
    ignore: !enabled[runtime],
    sanitizeOps: false,
    sanitizeResources: false,
    sanitizeExit: false,
    // FR-L25
    fn: async () => {
      const tmp = await Deno.makeTempDir({
        prefix: `ai-ide-cli-e2e-${runtime}-effort-`,
      });
      try {
        // Codex refuses to run in a non-trusted directory unless given
        // `--skip-git-repo-check`. `git init` is the runtime-neutral
        // form (every other adapter is happy with a plain dir).
        if (runtime === "codex") {
          const init = await new Deno.Command("git", {
            args: ["init", "--quiet"],
            cwd: tmp,
            stdout: "null",
            stderr: "null",
          }).output();
          assert(
            init.success,
            `codex tempdir git-init failed (exit=${init.code})`,
          );
        }

        const adapter = getRuntimeAdapter(runtime);
        const result = await adapter.invoke({
          processRegistry: defaultRegistry,
          taskPrompt: ONE_WORD_OK,
          timeoutSeconds: 60,
          maxRetries: 1,
          retryDelaySeconds: 0,
          cwd: tmp,
          reasoningEffort: "low",
          verbosity: "quiet",
        });
        assert(
          !result.error,
          `${runtime} rejected reasoningEffort argv: ${result.error ?? ""}`,
        );
        assert(
          result.output && !result.output.is_error,
          `${runtime} run errored despite valid argv: ${
            JSON.stringify(result)
          }`,
        );
      } finally {
        await Deno.remove(tmp, { recursive: true }).catch(() => {});
      }
    },
  });
}
