/**
 * @module
 * Runtime-neutral e2e for `onToolUseObserved` (FR-L16) on Claude /
 * OpenCode / Codex. Mirrors the role of
 * `cursor_typed_stream_e2e_test.ts` for the remaining three runtimes —
 * exercises one tool-emitting turn per runtime and asserts that the
 * adapter fires the runtime-neutral observer hook with non-empty
 * `id` + `name` and the correct `runtime` field.
 *
 * The shape of tool events differs per runtime (Claude inline
 * `tool_use` blocks; Codex `command_execution` / `file_change`;
 * OpenCode `tool` parts at terminal state) — this test deliberately
 * does not assert on tool *name* so an upstream tool rename does not
 * cause a false regression. What it asserts is that *some* tool was
 * dispatched and the callback got it.
 *
 * Safety:
 * - cwd is a `Deno.makeTempDir()` scratch dir — no writes outside it.
 * - 60 s `AbortSignal.timeout` ceiling.
 * - One short prompt; one tool dispatch; negligible token spend.
 * - `permissionMode: "bypassPermissions"` is required (without it
 *   Claude / Codex / OpenCode hang on a permission prompt in headless
 *   mode and never emit the tool event); cwd-scope keeps writes
 *   sandboxed to the tempdir.
 *
 * Cursor is excluded — it has its own dedicated FR-L30 test
 * (`cursor_typed_stream_e2e_test.ts`).
 */

import { assert } from "@std/assert";
import type { RuntimeId } from "../types.ts";
import { defaultRegistry } from "../process-registry.ts";
import { getRuntimeAdapter } from "../runtime/index.ts";
import type { RuntimeToolUseInfo } from "../runtime/types.ts";
import { resolveEnabledMap } from "./_helpers.ts";

const RUNTIMES: RuntimeId[] = ["claude", "opencode", "codex"];

const enabled = await resolveEnabledMap();

for (const runtime of RUNTIMES) {
  Deno.test({
    name:
      `e2e tool-use/${runtime}/onToolUseObserved fires with runtime-neutral info`,
    ignore: !enabled[runtime],
    sanitizeOps: false,
    sanitizeResources: false,
    sanitizeExit: false,
    // FR-L16
    fn: async () => {
      const tmp = await Deno.makeTempDir({
        prefix: `ai-ide-cli-e2e-${runtime}-tool-`,
      });
      try {
        await Deno.writeTextFile(`${tmp}/hello.txt`, "ok\n");
        // Codex refuses to run in a non-trusted directory unless the
        // CLI was given `--skip-git-repo-check`. `git init` is the
        // simpler, runtime-neutral form — every other adapter is
        // happy with a plain dir and ignores the `.git` we add.
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

        const observed: RuntimeToolUseInfo[] = [];
        const adapter = getRuntimeAdapter(runtime);
        const result = await adapter.invoke({
          processRegistry: defaultRegistry,
          taskPrompt:
            "Read the file hello.txt in the current directory and reply with exactly the word inside it.",
          timeoutSeconds: 60,
          maxRetries: 1,
          retryDelaySeconds: 0,
          permissionMode: "bypassPermissions",
          cwd: tmp,
          onToolUseObserved: (info) => {
            observed.push(info);
            return "allow";
          },
        });

        assert(
          !result.error,
          `${runtime} invoke errored: ${result.error ?? ""}`,
        );

        assert(
          observed.length >= 1,
          `${runtime}: expected ≥1 onToolUseObserved fire; observed=${observed.length}`,
        );

        const first = observed[0];
        assert(
          first.runtime === runtime,
          `${runtime}: onToolUseObserved.runtime mismatch; got ${first.runtime}`,
        );
        assert(
          first.name.length > 0 && first.id.length > 0,
          `${runtime}: tool info must carry non-empty name+id; got ${
            JSON.stringify(first)
          }`,
        );
        assert(
          typeof first.turn === "number" && first.turn >= 1,
          `${runtime}: tool info.turn must be a 1-based number; got ${
            JSON.stringify(first)
          }`,
        );
      } finally {
        await Deno.remove(tmp, { recursive: true }).catch(() => {});
      }
    },
  });
}
