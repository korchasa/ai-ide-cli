/**
 * @module
 * Drift check for FR-L53 login lists: an agent logged in under this
 * process's env must stay logged in under `inheritEnv: false`. Runs each
 * CLI's own login-status command twice — full env, then the isolated env
 * `spawnEnvOptions` builds with the runtime's `<runtime>/auth-env.ts`
 * matcher — and compares the answers. No prompt, no tokens.
 *
 * A failure here means a CLI release started reading its login from a
 * variable the matcher does not carry: add the name to that runtime's
 * `auth-env.ts`.
 *
 * Gate: `E2E=1`, the `E2E_RUNTIMES` allow-list and the binary on PATH. The
 * FR-L34 auth-probe is skipped on purpose — it spends tokens, and the
 * full-env status below already fails loudly when the CLI is logged out.
 */

import { assert, assertEquals } from "@std/assert";
import type { RuntimeId } from "../runtime/types.ts";
import { type AuthEnvMatcher, spawnEnvOptions } from "../runtime/spawn-env.ts";
import { claudeAuthEnv } from "../claude/auth-env.ts";
import { codexAuthEnv } from "../codex/auth-env.ts";
import { cursorAuthEnv } from "../cursor/auth-env.ts";
import { opencodeAuthEnv } from "../opencode/auth-env.ts";
import { detectBinary } from "./_helpers.ts";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

interface StatusCase {
  runtime: RuntimeId;
  matcher: AuthEnvMatcher;
  cmd: string;
  args: string[];
  /** Reduce the status output to the login state; throw when logged out. */
  state: (out: string) => string;
}

const CASES: StatusCase[] = [
  {
    runtime: "claude",
    matcher: claudeAuthEnv,
    cmd: "claude",
    args: ["auth", "status"],
    state: (out) => {
      const s = JSON.parse(out) as { loggedIn?: boolean; authMethod?: string };
      assert(s.loggedIn, `claude not logged in: ${out}`);
      return `${s.authMethod}`;
    },
  },
  {
    runtime: "codex",
    matcher: codexAuthEnv,
    cmd: "codex",
    args: ["login", "status"],
    state: (out) => {
      assert(/^Logged in/m.test(out), `codex not logged in: ${out}`);
      return out.trim();
    },
  },
  {
    runtime: "opencode",
    matcher: opencodeAuthEnv,
    cmd: "opencode",
    args: ["auth", "list"],
    state: (out) => {
      // Strip ANSI colours; keep the provider lines and the count.
      const plain = out.replace(ANSI, "");
      const count = plain.match(/(\d+) credentials/)?.[1];
      assert(count && count !== "0", `opencode has no credentials: ${out}`);
      return plain.split("\n").filter((l) => /^[●└]/.test(l)).join("\n");
    },
  },
  {
    runtime: "cursor",
    matcher: cursorAuthEnv,
    cmd: "cursor-agent",
    args: ["status"],
    state: (out) => {
      assert(
        /Logged in/.test(out) && !/Not logged in/i.test(out),
        `cursor not logged in: ${out}`,
      );
      return "logged in";
    },
  },
];

function gate(runtime: RuntimeId): boolean {
  if (Deno.env.get("E2E") !== "1") return false;
  const allow = (Deno.env.get("E2E_RUNTIMES") ?? "").split(",")
    .map((s) => s.trim()).filter(Boolean);
  return allow.length === 0 || allow.includes(runtime);
}

async function status(
  c: StatusCase,
  isolated: boolean,
): Promise<string> {
  const { stdout, stderr, code } = await new Deno.Command(c.cmd, {
    args: c.args,
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(30_000),
    ...(isolated ? spawnEnvOptions({}, false, c.matcher) : {}),
  }).output();
  const out = new TextDecoder().decode(stdout) +
    new TextDecoder().decode(stderr);
  assertEquals(code, 0, `${c.cmd} ${c.args.join(" ")} exited ${code}: ${out}`);
  return c.state(out);
}

for (const c of CASES) {
  const on = gate(c.runtime) && (await detectBinary(c.runtime)).present;
  Deno.test({
    name:
      `e2e isolated-auth/${c.runtime} FR-L53 login survives inheritEnv: false`,
    ignore: !on,
    fn: async () => {
      const full = await status(c, false);
      const isolated = await status(c, true);
      assertEquals(isolated, full, `${c.runtime} login differs when isolated`);
    },
  });
}
