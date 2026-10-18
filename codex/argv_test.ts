/**
 * @module
 * Negative-invariant regression tests for {@link buildCodexArgs}.
 *
 * Codex `rust-v0.128.0` deprecated `--full-auto` in favor of explicit
 * permission profiles, and `codex-cli 0.159.1` rejects it outright
 * (`unexpected argument`, exit 2). This file pins the contract that the
 * adapter never emits `--full-auto` — so a future refactor that reaches
 * for the removed flag fails this test before consumers fail at
 * runtime on a modern Codex binary.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
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

const RESERVED_SINGLETON_FLAGS: readonly string[] = [
  "--json",
  "--experimental-json",
  "--model",
  "--cd",
  "--sandbox",
  "--output-schema",
  "--ephemeral",
];

function configKeysFromArgv(argv: readonly string[]): string[] {
  const keys: string[] = [];
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] !== "--config") continue;
    const value = argv[i + 1];
    const eq = value.indexOf("=");
    keys.push(eq < 0 ? value : value.slice(0, eq));
  }
  return keys;
}

// FR-L13
Deno.test("no duplicate shared flag positions", () => {
  for (const mode of ALL_MODES) {
    const argv = buildCodexArgs(
      {
        permissionMode: mode,
        model: "gpt-5",
        cwd: "/tmp/scratch",
        reasoningEffort: "medium",
        mcpServers: {
          local: { type: "stdio", command: "srv", args: ["-v"] },
        },
        outputSchema: { type: "object" },
        ephemeral: true,
        resumeSessionId: "thread-1",
        extraArgs: { "--config": "web_search=true" },
      } as unknown as RuntimeInvokeOptions,
      "/tmp/scratch/schema.json",
    );

    // Subcommand position only: nothing precedes `exec`, so Codex
    // 0.123+ root-flag inheritance has nothing to inherit; the `resume`
    // positional closes argv.
    assertEquals(argv[0], "exec", `argv=${JSON.stringify(argv)}`);
    assertEquals(argv.slice(-2), ["resume", "thread-1"]);
    assertEquals(argv.indexOf("resume"), argv.length - 2);

    for (const token of RESERVED_SINGLETON_FLAGS) {
      const count = argv.filter((t) => t === token).length;
      assert(
        count <= 1,
        `buildCodexArgs emitted ${token} ${count} times for permissionMode=${mode}: ${
          JSON.stringify(argv)
        }`,
      );
    }

    const keys = configKeysFromArgv(argv);
    const unique = new Set(keys);
    assertEquals(
      keys.length,
      unique.size,
      `buildCodexArgs emitted duplicate --config <key> entries for permissionMode=${mode}: keys=${
        JSON.stringify(keys)
      } argv=${JSON.stringify(argv)}`,
    );
  }
});

// FR-L14
Deno.test("extraArgs rejects both JSON output spellings", () => {
  // `--experimental-json` is a clap alias of `--json` (one field), and
  // Codex exits 2 on `the argument '--json' cannot be used multiple
  // times` — so either spelling in extraArgs must fail fast here.
  for (const key of ["--json", "--experimental-json"]) {
    assertThrows(
      () =>
        buildCodexArgs(
          { extraArgs: { [key]: "" } } as unknown as RuntimeInvokeOptions,
        ),
      Error,
      `extraArgs key "${key}" is reserved by the runtime adapter`,
    );
  }
});
