/**
 * @module
 * FR-L23 ACP content-extraction smoke. Opens a real ACP session via the
 * Claude pilot, sends a trivial prompt, runs each emitted event through
 * `extractSessionContent`, and asserts at least one non-empty text entry
 * appears. Complements the stub-driven coverage in
 * `runtime/acp/content_test.ts` — this leg proves the contract against
 * the pinned `@agentclientprotocol/claude-agent-acp` front.
 *
 * Gated identically to `acp_claude_smoke_e2e_test.ts` — `E2E=1` plus
 * either `ANTHROPIC_API_KEY` or a working `claude` CLI auth probe. No
 * `claude` binary required on PATH; the ACP front speaks the Anthropic
 * API directly.
 */

import { assert } from "@std/assert";
import { getRuntimeAdapter } from "../runtime/index.ts";
import { extractSessionContent } from "../runtime/content.ts";
import { defaultRegistry } from "../process-registry.ts";
import { e2eAcpEnabled, ONE_WORD_OK } from "./_helpers.ts";
import { SYNTHETIC_TURN_END } from "../runtime/session-types.ts";

const enabled = await e2eAcpEnabled("claude");

// FR-L23
Deno.test({
  name:
    "e2e acp/claude extractSessionContent returns text content on real turn",
  ignore: !enabled,
  sanitizeOps: false,
  sanitizeResources: false,
  sanitizeExit: false,
  fn: async () => {
    const adapter = getRuntimeAdapter("claude");
    assert(
      adapter.openSession,
      "claude adapter must expose openSession for the ACP session smoke",
    );
    const controller = new AbortController();
    const ceilingId = setTimeout(() => controller.abort("ceiling-60s"), 60_000);
    const session = await adapter.openSession({
      processRegistry: defaultRegistry,
      transport: "acp",
      permissionMode: "plan",
      signal: controller.signal,
    });
    const seenText: string[] = [];
    try {
      await session.send(ONE_WORD_OK);
      for await (const event of session.events) {
        for (const c of extractSessionContent(event)) {
          if (c.kind === "text") seenText.push(c.text);
        }
        if (event.type === SYNTHETIC_TURN_END) break;
      }
    } finally {
      session.abort();
      await session.done;
      clearTimeout(ceilingId);
    }
    assert(
      seenText.length > 0,
      `expected ≥1 text content entry, got ${JSON.stringify(seenText)}`,
    );
    const joined = seenText.join("");
    assert(
      joined.length > 0,
      `expected non-empty concatenated text, got ${JSON.stringify(joined)}`,
    );
  },
});
