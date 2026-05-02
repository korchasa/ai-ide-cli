/**
 * @module
 * Real-binary smoke for the typed `allowedTools` / `disallowedTools`
 * filter (FR-L24) on Claude. Verifies that the adapter passes the
 * resulting `--allowedTools` / `--disallowedTools` argv tokens to the
 * binary in a way the binary accepts — i.e. the run completes without
 * a flag-parse / unknown-flag error from the CLI.
 *
 * The test deliberately does NOT assert on whether Claude actually
 * blocks the disallowed tool: the live behaviour of `--allowedTools` /
 * `--disallowedTools` depends on `--permission-mode` and Claude's
 * internal policy, both of which can shift between minor CLI
 * releases. What the library guarantees — and what this test pins —
 * is that the typed fields reach the subprocess intact. Behavioural
 * blocking is a Claude-CLI concern, not an adapter concern.
 *
 * Other runtimes set `capabilities.toolFilter = false`; their adapters
 * emit a one-time warn and ignore the typed field. That path is
 * unit-tested.
 */

import { assert } from "@std/assert";
import { defaultRegistry } from "../process-registry.ts";
import { getRuntimeAdapter } from "../runtime/index.ts";
import { e2eEnabled } from "./_helpers.ts";

const enabled = await e2eEnabled("claude");

Deno.test({
  name:
    "e2e tool-filter/claude/disallowedTools propagates to argv without flag-parse error",
  ignore: !enabled,
  sanitizeOps: false,
  sanitizeResources: false,
  sanitizeExit: false,
  // FR-L24
  fn: async () => {
    const tmp = await Deno.makeTempDir({
      prefix: "ai-ide-cli-e2e-claude-tool-filter-",
    });
    try {
      const adapter = getRuntimeAdapter("claude");
      // The adapter validator forbids passing both `allowedTools` and
      // `disallowedTools` in the same call (FR-L24 mutual exclusion).
      // The smoke uses `disallowedTools` because it is the simpler of
      // the two: the model is not pressured into using a specific tool
      // and the run completes in one short turn.
      const result = await adapter.invoke({
        processRegistry: defaultRegistry,
        taskPrompt: "Reply with exactly the word: ok",
        timeoutSeconds: 60,
        maxRetries: 1,
        retryDelaySeconds: 0,
        cwd: tmp,
        disallowedTools: ["WebSearch"],
      });
      assert(
        !result.error,
        `claude rejected --allowedTools/--disallowedTools argv: ${
          result.error ?? ""
        }`,
      );
      assert(
        result.output && !result.output.is_error,
        `claude run errored despite valid argv: ${JSON.stringify(result)}`,
      );
    } finally {
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    }
  },
});
