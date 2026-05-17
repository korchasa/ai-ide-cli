/**
 * @module
 * Opt-in capture-harness smoke for runtime-error analysis (FR-L37).
 *
 * This test never attempts to exhaust provider quotas. It verifies that
 * future manual capture can run with temporary HOME / log directories, so
 * OpenCode and similar CLIs do not mutate the user's real configuration while
 * collecting runtime-error samples.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { analyzeRuntimeErrorSignal } from "../runtime/runtime-error-analysis.ts";

const enabled = Deno.env.get("E2E") === "1";

Deno.test({
  name: "runtime error analysis probes are gated",
  ignore: !enabled,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const tmpHome = await Deno.makeTempDir({
      prefix: "ai-ide-cli-limit-home-",
    });
    const tmpLog = await Deno.makeTempDir({
      prefix: "ai-ide-cli-limit-log-",
    });
    try {
      const probe = await new Deno.Command("sh", {
        args: ["-c", "command -v opencode >/dev/null 2>&1"],
        stdout: "null",
        stderr: "null",
      }).output();
      if (!probe.success) return;

      const version = await new Deno.Command("opencode", {
        args: ["--version"],
        env: {
          HOME: tmpHome,
          OPENCODE_LOG_DIR: tmpLog,
          NO_COLOR: "1",
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(
        version.success,
        `opencode --version failed in temp HOME: ${
          new TextDecoder().decode(version.stderr)
        }`,
      );
      assertStringIncludes(new TextDecoder().decode(version.stdout), ".");

      const classified = analyzeRuntimeErrorSignal({
        runtime: "opencode",
        source: "log",
        text:
          `INFO {"statusCode":429,"data":{"error":{"message":"Usage limit reached for 5 hour. Your limit will reset at 2026-05-09 04:56:07"}}}`,
      });
      assertEquals(classified?.kind, "quota");
      assertEquals(classified?.resetAt, "2026-05-09 04:56:07");
    } finally {
      await Deno.remove(tmpHome, { recursive: true });
      await Deno.remove(tmpLog, { recursive: true });
    }
  },
});
