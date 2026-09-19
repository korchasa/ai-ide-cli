/**
 * @module
 * Registry of ACP-front launchers per supported {@link RuntimeId}.
 *
 * The two npm-shipped fronts (Claude, Codex) are launched as real Deno
 * dependencies — `deno run -A ./fronts/<runtime>.ts`, where that entry
 * module carries a single bare import resolved through this package's
 * `deno.json` `imports`. No Node, no `npx`, and the resolved version is
 * pinned by `deno.lock` rather than by whatever the registry serves at
 * spawn time. `deno.json` + `deno.lock` are therefore the ONLY record of
 * which version runs — this module deliberately keeps no copy of it. Cursor and OpenCode wrap a locally-installed binary and
 * have no npm package to pin.
 *
 * Claude, Codex, and OpenCode are piloted end-to-end (`pilot: true`).
 * Cursor wraps the locally-installed `cursor-agent` binary and stays
 * `pilot: false` until that binary is part of the validation matrix —
 * the launcher itself is recorded so a follow-up task can promote it
 * without touching any other module.
 */

import { basename } from "@std/path";
import type { RuntimeId } from "../../types.ts";

/** Launcher record for one ACP front. */
export interface AcpFrontLauncher {
  /**
   * Executable to spawn — a Deno CLI for the npm-shipped fronts (see
   * {@link resolveDenoCli}), a bare binary name (`cursor-agent`,
   * `opencode`) otherwise.
   */
  cmd: string;
  /** CLI args appended verbatim. */
  args: readonly string[];
  /** Frozen extra env vars merged into the subprocess env. */
  env?: Readonly<Record<string, string>>;
  /**
   * `true` ⇒ adapter accepts `transport: "acp"` for this runtime.
   * `false` ⇒ adapter rejects with a clear "not piloted yet" error. The
   * launcher itself is kept so a follow-up task can promote it without
   * touching any other module.
   */
  pilot: boolean;
}

/**
 * Pick the Deno CLI that runs the npm-shipped fronts.
 *
 * Under `deno run` / `deno test` / a JSR `deno install` shim,
 * `Deno.execPath()` is the Deno CLI and is used as-is — no PATH lookup,
 * and the same binary version the consumer already runs on. Inside a
 * `deno compile` binary it is the compiled executable, which has no `run`
 * subcommand, so the bare `deno` is returned and the spawner resolves it
 * on PATH. The check is by executable name (`deno`, `deno.exe`, …).
 *
 * A compiled consumer therefore needs a Deno CLI installed; when it is
 * missing, `spawnClient` fails with an error that says so. Passing a
 * custom `acpFront` remains the override for consumers that want neither.
 *
 * @param execPath What `Deno.execPath()` returned.
 * @returns `execPath` when it is a Deno CLI, else `"deno"`.
 */
export function resolveDenoCli(execPath: string): string {
  const name = basename(execPath).toLowerCase();
  return name === "deno" || name.startsWith("deno.") ? execPath : "deno";
}

/**
 * Argv that runs one npm-shipped front's entry module under a Deno CLI.
 *
 * `-A` matches the authority `npx` handed these fronts implicitly: each
 * one spawns its own agent binary (Claude Code, codex) and needs network,
 * filesystem and subprocess access to do its job. Narrowing it here would
 * only break the front, not sandbox it.
 */
function entryArgs(entry: string): readonly string[] {
  return Object.freeze(["run", "-A", import.meta.resolve(entry)]);
}

const FRONTS: Readonly<Record<RuntimeId, AcpFrontLauncher>> = Object.freeze({
  claude: {
    cmd: resolveDenoCli(Deno.execPath()),
    args: entryArgs("./fronts/claude.ts"),
    // FR-L45: the front runs the Claude Agent SDK, which spawns the same
    // Claude Code binary as the CLI transport — the switch reaches it and
    // buys the same startup saving. `handshake.ts` merges caller `env` over
    // this map, so a consumer can still override it.
    env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    pilot: true,
  },
  codex: {
    cmd: resolveDenoCli(Deno.execPath()),
    // FR-L43: `@zed-industries/codex-acp` is deprecated upstream ("replaced
    // by @agentclientprotocol/codex-acp") and its last release (0.16.0)
    // still embeds a codex-core that rejects newer `config.toml` values —
    // e.g. `model_reasoning_effort = "ultra"` aborts the front before the
    // handshake. The successor package accepts it.
    args: entryArgs("./fronts/codex.ts"),
    pilot: true,
  },
  cursor: {
    cmd: "cursor-agent",
    args: ["acp"],
    pilot: false,
  },
  opencode: {
    cmd: "opencode",
    args: ["acp"],
    // Validated against opencode 1.16.2 on darwin-arm64 (FR-L39/FR-L43).
    // Front wraps the locally-installed `opencode` binary (no `npx`
    // wrapper), so the e2e gate requires `opencode` on PATH.
    pilot: true,
  },
});

/** Look up the pinned ACP-front launcher for a runtime. */
export function getAcpFront(runtime: RuntimeId): AcpFrontLauncher {
  return FRONTS[runtime];
}

/** Snapshot of the full registry. Returned reference is frozen. */
export function listAcpFronts(): Readonly<Record<RuntimeId, AcpFrontLauncher>> {
  return FRONTS;
}
