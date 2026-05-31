/**
 * @module
 * Registry of ACP-front launchers per supported {@link RuntimeId}.
 *
 * Versions are pinned to the ACP Registry snapshot at PoC time
 * (https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json).
 *
 * Claude, Codex, and OpenCode are piloted end-to-end (`pilot: true`).
 * Cursor wraps the locally-installed `cursor-agent` binary and stays
 * `pilot: false` until that binary is part of the validation matrix —
 * the launcher itself is recorded so a follow-up task can promote it
 * without touching any other module.
 */

import type { RuntimeId } from "../../types.ts";

/** Launcher record for one ACP front. */
export interface AcpFrontLauncher {
  /** Executable name (`npx`, `cursor-agent`, …). */
  cmd: string;
  /** CLI args appended verbatim. */
  args: readonly string[];
  /** Frozen extra env vars merged into the subprocess env. */
  env?: Readonly<Record<string, string>>;
  /**
   * Version string from the ACP Registry, kept for diagnostics and the
   * PoC `### Results` measurement. Not used at runtime.
   */
  versionPin?: string;
  /**
   * `true` ⇒ adapter accepts `transport: "acp"` for this runtime.
   * `false` ⇒ adapter rejects with a clear "not piloted yet" error. The
   * launcher itself is kept so a follow-up task can promote it without
   * touching any other module.
   */
  pilot: boolean;
}

const FRONTS: Readonly<Record<RuntimeId, AcpFrontLauncher>> = Object.freeze({
  claude: {
    cmd: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp@0.37.0"],
    versionPin: "0.37.0",
    pilot: true,
  },
  codex: {
    cmd: "npx",
    args: ["-y", "@zed-industries/codex-acp@0.15.0"],
    versionPin: "0.15.0",
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
    // Validated against opencode 1.15.10 on darwin-arm64 (FR-L39).
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
