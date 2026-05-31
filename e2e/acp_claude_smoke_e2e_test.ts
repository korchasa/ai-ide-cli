/**
 * @module
 * FR-L39 ACP transport smoke. Drives `transport: "acp"` end-to-end against
 * the pinned `@agentclientprotocol/claude-agent-acp` front from the ACP
 * Registry, asserting one trivial prompt round-trip.
 *
 * Gated on `E2E=1` + `E2E_RUNTIMES` (claude allowed) + `ANTHROPIC_API_KEY`
 * present in the env. Crucially does NOT require the `claude` CLI binary
 * on PATH — the ACP front speaks the Anthropic API directly. The npm
 * package itself is pinned in `runtime/acp/fronts.ts` and `deno.json`.
 */

import { assert } from "@std/assert";
import { getRuntimeAdapter } from "../runtime/index.ts";
import { defaultRegistry } from "../process-registry.ts";
import { e2eAcpEnabled, ONE_WORD_OK } from "./_helpers.ts";

const enabled = await e2eAcpEnabled("claude");

Deno.test({
  name: "e2e acp/claude/transport=acp returns ok",
  ignore: !enabled,
  sanitizeOps: false,
  sanitizeResources: false,
  sanitizeExit: false,
  fn: async () => {
    const adapter = getRuntimeAdapter("claude");
    const controller = new AbortController();
    const ceilingId = setTimeout(() => controller.abort("ceiling-60s"), 60_000);
    try {
      const res = await adapter.invoke({
        processRegistry: defaultRegistry,
        taskPrompt: ONE_WORD_OK,
        timeoutSeconds: 60,
        maxRetries: 0,
        retryDelaySeconds: 0,
        permissionMode: "plan",
        signal: controller.signal,
        transport: "acp",
      });
      assert(
        res.output,
        `expected ACP output, got ${JSON.stringify(res)}`,
      );
      assert(
        /ok/i.test(res.output.result),
        `expected reply to contain 'ok', got ${JSON.stringify(res.output)}`,
      );
      assert(
        res.output.is_error === false,
        `expected non-error reply, got ${JSON.stringify(res.output)}`,
      );
    } finally {
      clearTimeout(ceilingId);
    }
  },
});
