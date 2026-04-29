/**
 * @module
 * Generator for the session-contract matrix (FR-L31). For every
 * (runtime × scenario) pair allowed by the scenario's `only` / `skip`
 * lists, registers one `Deno.test` guarded by the pre-resolved `E2E` gate.
 *
 * Ignored tests still appear in the report — a missing binary is visible
 * rather than silently skipped.
 */

import type { RuntimeId } from "../types.ts";
import { resolveEnabledMap } from "./_helpers.ts";
import { SESSION_CONTRACT_MATRIX } from "./_matrix.ts";

const RUNTIMES: RuntimeId[] = ["claude", "opencode", "cursor", "codex"];

// Pre-resolve the gate once per runtime — Deno.test#ignore is boolean-only.
const enabled = await resolveEnabledMap();

for (const runtime of RUNTIMES) {
  for (const scenario of SESSION_CONTRACT_MATRIX) {
    if (scenario.skip?.includes(runtime)) continue;
    if (scenario.only && !scenario.only.includes(runtime)) continue;
    Deno.test({
      name: `e2e session/${runtime}/${scenario.id}`,
      ignore: !enabled[runtime],
      // OpenCode `abort()` fires-and-forgets `POST /session/:id/abort`
      // (see SDS §3.8 / FR-L19) — a contract, not a leak. Deno's test
      // sanitizers are stricter than the legacy `scripts/smoke.ts`
      // runner; disable them on the matrix so the contracted behaviour
      // doesn't surface as a false failure. Individual scenarios still
      // await `session.done` in their finalizer so the process exits.
      sanitizeOps: false,
      sanitizeResources: false,
      sanitizeExit: false,
      fn: () => scenario.run(runtime),
    });
  }
}
