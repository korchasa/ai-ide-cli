/**
 * @module
 * FR-L39 ACP retry-loop smoke. Drives `invokeViaAcp` against a wrapper
 * (`e2e/_acp_retry_wrapper.ts`) that fails the first spawn with a
 * JSON-RPC `-32603` error on `initialize`, then forwards the second
 * spawn to the real `@agentclientprotocol/claude-agent-acp` front.
 * Asserts the retry loop recovers — `is_error: false` after exactly two
 * spawn attempts.
 *
 * Gated identically to `acp_claude_smoke_e2e_test.ts` — `E2E=1` plus
 * either `ANTHROPIC_API_KEY` or a working `claude` CLI auth probe. No
 * `claude` binary required on PATH; the wrapped ACP front speaks the
 * Anthropic API directly.
 */

import { assert, assertEquals } from "@std/assert";
import { getRuntimeAdapter } from "../runtime/index.ts";
import { defaultRegistry } from "../process-registry.ts";
import { e2eAcpEnabled, ONE_WORD_OK } from "./_helpers.ts";

const enabled = await e2eAcpEnabled("claude");

// FR-L39
Deno.test({
  name: "e2e acp/claude invokeViaAcp retries past broken first attempt",
  ignore: !enabled,
  sanitizeOps: false,
  sanitizeResources: false,
  sanitizeExit: false,
  fn: async () => {
    const counterPath = await Deno.makeTempFile({
      prefix: "acp-retry-counter-",
    });
    await Deno.writeTextFile(counterPath, "0");
    const adapter = getRuntimeAdapter("claude");
    const controller = new AbortController();
    const ceilingId = setTimeout(() => controller.abort("ceiling-90s"), 90_000);
    try {
      const res = await adapter.invoke({
        processRegistry: defaultRegistry,
        taskPrompt: ONE_WORD_OK,
        timeoutSeconds: 60,
        maxRetries: 1,
        retryDelaySeconds: 1,
        permissionMode: "plan",
        signal: controller.signal,
        transport: "acp",
        // Pin a cheap model to bound token cost — two spawn attempts per
        // run, only the second actually exchanges a prompt.
        model: "claude-haiku-4-5-20251001",
        acpFront: {
          cmd: Deno.execPath(),
          args: [
            "run",
            "-A",
            "e2e/_acp_retry_wrapper.ts",
            "--counter",
            counterPath,
            "--",
            "npx",
            "-y",
            "@agentclientprotocol/claude-agent-acp@0.37.0",
          ],
          pilot: true,
        },
      });
      assert(
        res.output,
        `expected ACP output after retry, got ${JSON.stringify(res)}`,
      );
      assertEquals(
        res.output.is_error,
        false,
        `expected non-error reply, got ${JSON.stringify(res.output)}`,
      );
      const attempts = Number((await Deno.readTextFile(counterPath)).trim());
      assertEquals(attempts, 2, `expected exactly two spawn attempts`);
    } finally {
      clearTimeout(ceilingId);
      await Deno.remove(counterPath).catch(() => {});
    }
  },
});
