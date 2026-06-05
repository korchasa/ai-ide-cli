/**
 * @module
 * Cross-runtime contract tests for `RuntimeAdapter.capabilitiesFor`
 * (FR-L39). Every pilot must downgrade transport-bound capabilities
 * (transcript / interactive / toolFilter) when the consumer opts into
 * the ACP transport, while preserving session and reasoning-effort.
 * `capabilityInventory` is advertised `true` on ACP (FR-L20) because
 * `fetchCapabilitiesSlow` routes through `invokeViaAcp`. Cursor stays
 * `pilot: false` and throws.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { getRuntimeAdapter } from "./index.ts";
import type { RuntimeId } from "../types.ts";

const PILOTS: RuntimeId[] = ["claude", "codex", "opencode"];

Deno.test("capabilitiesFor('cli') returns the static CLI baseline byte-for-byte (every adapter)", () => {
  for (const runtime of [...PILOTS, "cursor"] as const) {
    const adapter = getRuntimeAdapter(runtime);
    assert(
      typeof adapter.capabilitiesFor === "function",
      `${runtime} must implement capabilitiesFor`,
    );
    const out = adapter.capabilitiesFor!("cli");
    assertEquals(
      out,
      adapter.capabilities,
      `${runtime} capabilitiesFor("cli") must equal adapter.capabilities`,
    );
  }
});

Deno.test("capabilitiesFor('acp') downgrades transcript/interactive/toolFilter for every pilot", () => {
  for (const runtime of PILOTS) {
    const adapter = getRuntimeAdapter(runtime);
    const acp = adapter.capabilitiesFor!("acp");
    assertEquals(
      acp.transcript,
      false,
      `${runtime} ACP has no exported transcript`,
    );
    assertEquals(
      acp.interactive,
      false,
      `${runtime} ACP has no TUI launcher`,
    );
    assertEquals(
      acp.toolFilter,
      false,
      `${runtime} ACP has no client-side tool-policy`,
    );
  }
});

// FR-L20: the inventory driver (`fetchInventoryViaInvoke`) is
// transport-agnostic — it only needs an `invoke` function — so the ACP
// path advertises `capabilityInventory: true` and routes through
// `invokeViaAcp`.
Deno.test("capabilitiesFor('acp') advertises capabilityInventory: true for every pilot (FR-L20)", () => {
  for (const runtime of PILOTS) {
    const adapter = getRuntimeAdapter(runtime);
    const acp = adapter.capabilitiesFor!("acp");
    assertEquals(
      acp.capabilityInventory,
      true,
      `${runtime} ACP routes fetchCapabilitiesSlow through invokeViaAcp`,
    );
  }
});

Deno.test("capabilitiesFor('acp') preserves session capability for every pilot", () => {
  for (const runtime of PILOTS) {
    const adapter = getRuntimeAdapter(runtime);
    const acp = adapter.capabilitiesFor!("acp");
    assertEquals(
      acp.session,
      true,
      `${runtime} ACP supports openSessionViaAcp`,
    );
    assertEquals(
      acp.sessionFidelity,
      "native",
      `${runtime} ACP uses native stdio JSON-RPC transport`,
    );
  }
});

Deno.test("capabilitiesFor('acp') preserves permissionMode and toolUseObservation for every pilot", () => {
  for (const runtime of PILOTS) {
    const adapter = getRuntimeAdapter(runtime);
    const acp = adapter.capabilitiesFor!("acp");
    assertEquals(
      acp.permissionMode,
      true,
      `${runtime} ACP supports session/set_mode`,
    );
    assertEquals(
      acp.toolUseObservation,
      true,
      `${runtime} ACP routes tool requests through session/request_permission`,
    );
  }
});

Deno.test("capabilitiesFor('acp') keeps reasoningEffort and mcpInjection for every pilot", () => {
  for (const runtime of PILOTS) {
    const adapter = getRuntimeAdapter(runtime);
    const acp = adapter.capabilitiesFor!("acp");
    assertEquals(
      acp.reasoningEffort,
      true,
      `${runtime} ACP supports session/set_config_option thought_level`,
    );
    assertEquals(
      acp.mcpInjection,
      true,
      `${runtime} ACP supports session/new mcpServers`,
    );
  }
});

Deno.test("commandsFastChannel is false on CLI for every adapter and true on ACP for pilots (FR-L42)", () => {
  for (const runtime of [...PILOTS, "cursor"] as const) {
    const adapter = getRuntimeAdapter(runtime);
    assertEquals(
      adapter.capabilitiesFor!("cli").commandsFastChannel,
      false,
      `${runtime} CLI has no commands fast-channel`,
    );
  }
  for (const runtime of PILOTS) {
    const adapter = getRuntimeAdapter(runtime);
    assertEquals(
      adapter.capabilitiesFor!("acp").commandsFastChannel,
      true,
      `${runtime} ACP pushes available_commands_update`,
    );
  }
});

Deno.test("capabilitiesFor('acp') on cursor throws 'not piloted yet'", () => {
  const adapter = getRuntimeAdapter("cursor");
  assert(
    typeof adapter.capabilitiesFor === "function",
    "cursor must implement capabilitiesFor",
  );
  assertThrows(
    () => adapter.capabilitiesFor!("acp"),
    Error,
    "not piloted yet",
  );
});
