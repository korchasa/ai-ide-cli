/**
 * @module
 * FR-L42 commands fast-channel real-binary smoke. Drives
 * `adapter.fetchCommands({ transport: "acp", ... })` against each ACP
 * pilot front and asserts a non-empty slash-command snapshot is
 * captured from the `available_commands_update` push.
 *
 * - **Claude (hard)**: must return ≥1 command — the pinned
 *   `@agentclientprotocol/claude-agent-acp` front pushes the variant
 *   shortly after `session/new`.
 * - **Codex / OpenCode (soft)**: a `CommandsUnavailableError` with
 *   `reason === "timeout"` is logged and skipped (the front does not
 *   push the variant today); ANY other error fails the step so a real
 *   regression (RPC error, spawn failure, `front_not_piloted`) is not
 *   masked.
 *
 * Gated by `E2E=1` + `e2eAcpEnabled(<runtime>)`. Complements the
 * stub-driven coverage in `runtime/acp/commands_test.ts`.
 */

import { assert, assertEquals } from "@std/assert";
import { getRuntimeAdapter } from "../runtime/index.ts";
import { CommandsUnavailableError } from "../runtime/commands.ts";
import { defaultRegistry } from "../process-registry.ts";
import { e2eAcpEnabled } from "./_helpers.ts";
import type { RuntimeId } from "../types.ts";

const claudeEnabled = await e2eAcpEnabled("claude");
const codexEnabled = await e2eAcpEnabled("codex");
const opencodeEnabled = await e2eAcpEnabled("opencode");

// FR-L42
Deno.test({
  name: "e2e acp/claude fetchCommands returns a non-empty command list",
  ignore: !claudeEnabled,
  sanitizeOps: false,
  sanitizeResources: false,
  sanitizeExit: false,
  fn: async () => {
    const adapter = getRuntimeAdapter("claude");
    assert(adapter.fetchCommands, "claude adapter must expose fetchCommands");
    const snapshot = await adapter.fetchCommands({
      transport: "acp",
      processRegistry: defaultRegistry,
      timeoutMs: 15_000,
      cwd: Deno.cwd(),
    });
    assertEquals(snapshot.runtime, "claude");
    assert(
      snapshot.commands.length > 0,
      `expected ≥1 command, got ${JSON.stringify(snapshot.commands)}`,
    );
    assert(
      typeof snapshot.commands[0].name === "string" &&
        snapshot.commands[0].name.length > 0,
      "first command must carry a non-empty name",
    );
  },
});

// FR-L42: soft probe — visibility into which pilots advertise commands
// today without masking real regressions.
async function softProbe(runtime: RuntimeId): Promise<void> {
  const adapter = getRuntimeAdapter(runtime);
  assert(adapter.fetchCommands, `${runtime} adapter must expose fetchCommands`);
  try {
    const snapshot = await adapter.fetchCommands({
      transport: "acp",
      processRegistry: defaultRegistry,
      timeoutMs: 15_000,
      cwd: Deno.cwd(),
    });
    assert(
      snapshot.commands.length >= 0,
      "snapshot must carry a commands array",
    );
    console.log(
      `[ok] ${runtime} commands fast-channel: ${snapshot.commands.length} command(s)`,
    );
  } catch (err) {
    if (err instanceof CommandsUnavailableError && err.reason === "timeout") {
      console.log(
        `[skip] ${runtime} commands fast-channel: front did not push available_commands_update`,
      );
      return;
    }
    throw err;
  }
}

// FR-L42
Deno.test({
  name: "e2e acp/codex fetchCommands soft-probe",
  ignore: !codexEnabled,
  sanitizeOps: false,
  sanitizeResources: false,
  sanitizeExit: false,
  fn: () => softProbe("codex"),
});

// FR-L42
Deno.test({
  name: "e2e acp/opencode fetchCommands soft-probe",
  ignore: !opencodeEnabled,
  sanitizeOps: false,
  sanitizeResources: false,
  sanitizeExit: false,
  fn: () => softProbe("opencode"),
});
