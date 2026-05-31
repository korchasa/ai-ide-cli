/**
 * @module
 * Opt-in real-binary e2e suite helpers: binary probe, env gate, hard ceiling,
 * canonical prompts. Imported by every `e2e/*_e2e_test.ts` file.
 *
 * Gate semantics (resolved at module-load time — `Deno.env.get` is read once
 * per test-file import, not per test):
 * - `E2E=1` must be set for any e2e test to run.
 * - `E2E_RUNTIMES=claude,codex` (comma-separated) narrows the matrix; empty
 *   value (or unset) means "all four".
 * - Binary must be present on PATH, otherwise the test is marked ignored
 *   with the probe reason recorded for diagnostics.
 * - Binary must be authenticated (FR-L34). When `E2E=1`, the runtime is in
 *   the allow-list, and the binary is on PATH, an auth-probe runs once per
 *   runtime — a one-shot `adapter.invoke("Reply with: ok")` whose output is
 *   scanned for known auth-failure patterns. Match → loud `Error` thrown
 *   from `e2eEnabled`/`resolveEnabledMap` so the test-file fails to load
 *   instead of producing dozens of spurious assertion failures.
 */

import type { RuntimeId } from "../types.ts";
import { assertAuthenticated } from "./_auth.ts";

/** Result of probing `$PATH` for a runtime CLI binary. */
export interface BinaryProbe {
  /** `true` when the binary is executable on the current PATH. */
  present: boolean;
  /** Absolute path resolved by `command -v`; present only on success. */
  path?: string;
  /** Why the probe failed — shown next to ignored test names. */
  reason?: string;
}

const RUNTIME_BIN: Record<RuntimeId, string> = {
  claude: "claude",
  opencode: "opencode",
  cursor: "cursor",
  codex: "codex",
};

const probeCache = new Map<RuntimeId, Promise<BinaryProbe>>();

/**
 * Probe `$PATH` for the runtime's CLI binary. Cached per runtime for the
 * lifetime of the Deno process so matrix generators can `await` once per
 * runtime without spawning N shells.
 *
 * @param runtime Runtime whose CLI binary to probe.
 */
export function detectBinary(runtime: RuntimeId): Promise<BinaryProbe> {
  const cached = probeCache.get(runtime);
  if (cached) return cached;
  const promise = doProbe(runtime);
  probeCache.set(runtime, promise);
  return promise;
}

async function doProbe(runtime: RuntimeId): Promise<BinaryProbe> {
  const bin = RUNTIME_BIN[runtime];
  try {
    const cmd = new Deno.Command("sh", {
      args: ["-c", `command -v ${bin}`],
      stdout: "piped",
      stderr: "null",
    });
    const { success, stdout } = await cmd.output();
    if (!success) {
      return { present: false, reason: `${bin} not found on PATH` };
    }
    const path = new TextDecoder().decode(stdout).trim();
    if (!path) {
      return { present: false, reason: `${bin} resolved to empty path` };
    }
    return { present: true, path };
  } catch (err) {
    return {
      present: false,
      reason: `probe failed: ${(err as Error).message}`,
    };
  }
}

/**
 * Return `true` when the caller opted into e2e runs (`E2E=1`), the runtime
 * passes the `E2E_RUNTIMES` allow-list (or the list is empty), the
 * runtime's binary is on PATH, and the binary is authenticated (FR-L34).
 *
 * Throws (does not return `false`) when the runtime is enabled and present
 * on PATH but not logged in — fail-fast, fail-loud at test-file load time.
 *
 * @param runtime Runtime to gate.
 */
export async function e2eEnabled(runtime: RuntimeId): Promise<boolean> {
  if (Deno.env.get("E2E") !== "1") return false;
  const allowList = (Deno.env.get("E2E_RUNTIMES") ?? "").trim();
  if (allowList) {
    const allow = allowList.split(",").map((s) => s.trim()).filter(Boolean);
    if (!allow.includes(runtime)) return false;
  }
  const probe = await detectBinary(runtime);
  if (!probe.present) return false;
  await assertAuthenticated(runtime);
  return true;
}

/** Record of enabled runtimes resolved once at test-file load time. */
export type EnabledMap = Record<RuntimeId, boolean>;

/** Resolve the gate for every runtime in one pass — use at test-file top level. */
export async function resolveEnabledMap(): Promise<EnabledMap> {
  const [claude, opencode, cursor, codex] = await Promise.all([
    e2eEnabled("claude"),
    e2eEnabled("opencode"),
    e2eEnabled("cursor"),
    e2eEnabled("codex"),
  ]);
  return { claude, opencode, cursor, codex };
}

/**
 * Install a hard ceiling timer. Caller invokes the returned cancel function
 * in `finally` to clear the timer regardless of whether `onFire` fired.
 *
 * @param ms Ceiling in milliseconds.
 * @param onFire Callback invoked once when the ceiling expires.
 */
export function ceiling(ms: number, onFire: () => void): () => void {
  const id = setTimeout(onFire, ms);
  return () => clearTimeout(id);
}

/**
 * Per-runtime auth env var consumed by the runtime's ACP front. Used by
 * {@link e2eAcpEnabled} to gate `transport: "acp"` smokes without
 * requiring the runtime's IDE CLI to be installed on PATH.
 *
 * Cursor / OpenCode ACP fronts wrap the local IDE binary
 * (`cursor-agent acp`, `opencode acp`), so they require a binary probe
 * AND vendor-specific auth — those gates fall back to the standard
 * {@link e2eEnabled} flow.
 */
const ACP_REQUIRED_ENV: Partial<Record<RuntimeId, string>> = {
  // FR-L39: claude-agent-acp uses the standard Anthropic API auth.
  claude: "ANTHROPIC_API_KEY",
  // FR-L39: codex-acp self-contains its native binary and authenticates
  // via the OpenAI API. No `codex` CLI install required.
  codex: "OPENAI_API_KEY",
};

/**
 * Gate for `transport: "acp"` smoke tests. Differs from {@link e2eEnabled}:
 * the per-runtime ACP front is launched via `npx`, so the runtime's own
 * CLI binary is NOT required on PATH. Enabled when EITHER:
 *
 * 1. The API-auth env var the ACP front consumes is set (e.g.
 *    `ANTHROPIC_API_KEY` for claude, `OPENAI_API_KEY` for codex), OR
 * 2. The runtime's IDE CLI is on PATH and the standard auth probe
 *    passes — the ACP front can then read stored credentials from the
 *    CLI's config dir (`~/.claude/`, `~/.config/codex/`, …).
 *
 * @param runtime Runtime to gate.
 */
export async function e2eAcpEnabled(runtime: RuntimeId): Promise<boolean> {
  if (Deno.env.get("E2E") !== "1") return false;
  const allowList = (Deno.env.get("E2E_RUNTIMES") ?? "").trim();
  if (allowList) {
    const allow = allowList.split(",").map((s) => s.trim()).filter(Boolean);
    if (!allow.includes(runtime)) return false;
  }
  const apiEnv = ACP_REQUIRED_ENV[runtime];
  if (apiEnv) {
    const value = Deno.env.get(apiEnv);
    if (typeof value === "string" && value.length > 0) return true;
  }
  // Fall back to the CLI auth probe — covers environments where the
  // IDE binary stores credentials and the ACP front reads them
  // (e.g. claude-agent-acp reads `~/.claude/`).
  return await e2eEnabled(runtime);
}

/** Single-word reply prompts — minimal token spend per turn. */
export const ONE_WORD_OK: string = "Reply with exactly the word: ok";
/** Second-turn prompt used by `two-turns` scenarios. */
export const ONE_WORD_DONE: string = "Reply with exactly the word: done";
/** Long-running prompt used by `abort-mid-turn` scenarios. */
export const LONG_COUNT_PROMPT: string =
  "Count slowly from 1 to 1000, one number per line.";
