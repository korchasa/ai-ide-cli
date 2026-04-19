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
 */

import type { RuntimeId } from "../types.ts";

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
 * passes the `E2E_RUNTIMES` allow-list (or the list is empty), and the
 * runtime's binary is on PATH.
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
  return probe.present;
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

/** Single-word reply prompts — minimal token spend per turn. */
export const ONE_WORD_OK: string = "Reply with exactly the word: ok";
/** Second-turn prompt used by `two-turns` scenarios. */
export const ONE_WORD_DONE: string = "Reply with exactly the word: done";
/** Long-running prompt used by `abort-mid-turn` scenarios. */
export const LONG_COUNT_PROMPT: string =
  "Count slowly from 1 to 1000, one number per line.";
