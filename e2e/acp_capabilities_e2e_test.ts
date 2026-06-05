/**
 * @module
 * FR-L20 capability-inventory-over-ACP real-binary smoke. Drives
 * `adapter.fetchCapabilitiesSlow({ transport: "acp", ... })` against the
 * Claude ACP pilot and asserts a non-empty inventory comes back — proving
 * the inventory driver (`fetchInventoryViaInvoke`) routes its single LLM
 * turn through `invokeViaAcp` when the consumer opts into the ACP wire.
 *
 * Claude-only: it is the pilot whose front reliably answers a one-turn
 * inventory prompt. Gated by `E2E=1` + `e2eAcpEnabled("claude")`.
 * Complements the deterministic plumbing coverage in
 * `runtime/capabilities_test.ts` (transport threading + schema-flag
 * suppression) and the capability-flag contract in
 * `runtime/transport_capabilities_test.ts`.
 */

import { assert } from "@std/assert";
import { getRuntimeAdapter } from "../runtime/index.ts";
import { defaultRegistry } from "../process-registry.ts";
import { e2eAcpEnabled } from "./_helpers.ts";

const claudeEnabled = await e2eAcpEnabled("claude");

// FR-L20
Deno.test({
  name:
    "e2e acp/claude fetchCapabilitiesSlow returns a non-empty inventory under ACP",
  ignore: !claudeEnabled,
  sanitizeOps: false,
  sanitizeResources: false,
  sanitizeExit: false,
  fn: async () => {
    const adapter = getRuntimeAdapter("claude");
    assert(
      adapter.fetchCapabilitiesSlow,
      "claude adapter must expose fetchCapabilitiesSlow",
    );
    const inv = await adapter.fetchCapabilitiesSlow({
      transport: "acp",
      processRegistry: defaultRegistry,
      cwd: Deno.cwd(),
      model: "claude-haiku-4-5-20251001",
      signal: AbortSignal.timeout(90_000),
    });
    assert(inv.runtime === "claude", `expected claude, got ${inv.runtime}`);
    assert(
      inv.skills.length + inv.commands.length > 0,
      `expected ≥1 skill or command, got ${JSON.stringify(inv)}`,
    );
  },
});
