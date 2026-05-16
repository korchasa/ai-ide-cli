/**
 * @module
 * Negative-invariant regression tests for {@link buildCodexArgs}.
 *
 * Codex `rust-v0.128.0` deprecated `--full-auto` in favor of explicit
 * permission profiles. This file pins the contract that the adapter
 * never emits `--full-auto` — so a future refactor that reaches for
 * the deprecated flag fails this test before consumers fail at
 * runtime on a modern Codex binary.
 */

import { assert } from "@std/assert";
import { buildCodexArgs } from "./argv.ts";
import type { RuntimeInvokeOptions } from "../runtime/types.ts";

const ALL_MODES: readonly (string | undefined)[] = [
  undefined,
  "default",
  "plan",
  "acceptEdits",
  "bypassPermissions",
  "read-only",
  "workspace-write",
  "danger-full-access",
  "never",
  "on-request",
  "on-failure",
  "untrusted",
  "garbage",
];

// FR-L13
Deno.test("never emits deprecated --full-auto", () => {
  for (const mode of ALL_MODES) {
    const argv = buildCodexArgs(
      { permissionMode: mode } as RuntimeInvokeOptions,
    );
    assert(
      !argv.includes("--full-auto"),
      `buildCodexArgs emitted deprecated --full-auto for permissionMode=${mode}: ${
        JSON.stringify(argv)
      }`,
    );
  }
});
