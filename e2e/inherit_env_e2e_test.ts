/**
 * @module
 * Real-binary smoke for FR-L53: with `inheritEnv: false` and no `env` at
 * all, the agent still starts, authenticates and replies — the identity
 * and login vars carried from this process are enough. The env leak itself
 * is unit-tested with stubs (`runtime/inherit_env_test.ts`); the login
 * lists are drift-checked without tokens in `isolated_auth_e2e_test.ts`.
 *
 * Cases: claude CLI, claude ACP front, codex CLI. One-word prompt in a
 * scratch git repo, `permissionMode: "plan"`.
 */

import { assert, assertStringIncludes } from "@std/assert";
import type { RuntimeId, TransportOption } from "../runtime/types.ts";
import { ProcessRegistry } from "../process-registry.ts";
import { getRuntimeAdapter } from "../runtime/index.ts";
import { e2eAcpEnabled, ONE_WORD_OK, resolveEnabledMap } from "./_helpers.ts";

const enabled = await resolveEnabledMap();
const claudeAcp = await e2eAcpEnabled("claude");

const SANITIZE = {
  sanitizeOps: false,
  sanitizeResources: false,
  sanitizeExit: false,
};

const CASES: { runtime: RuntimeId; transport: TransportOption; on: boolean }[] =
  [
    { runtime: "claude", transport: "cli", on: enabled.claude },
    { runtime: "claude", transport: "acp", on: claudeAcp },
    { runtime: "codex", transport: "cli", on: enabled.codex },
  ];

for (const { runtime, transport, on } of CASES) {
  Deno.test({
    name: `e2e inherit-env/${runtime}/${transport} FR-L53 isolated run replies`,
    ignore: !on,
    ...SANITIZE,
    fn: async () => {
      const cwd = await Deno.makeTempDir({
        prefix: `ai-ide-cli-e2e-${runtime}-isolated-`,
      });
      try {
        const init = await new Deno.Command("git", {
          args: ["init", "--quiet"],
          cwd,
          stdout: "null",
          stderr: "null",
        }).output();
        assert(init.success, `git init failed in ${cwd}`);
        const result = await getRuntimeAdapter(runtime).invoke({
          processRegistry: new ProcessRegistry(),
          transport,
          taskPrompt: ONE_WORD_OK,
          timeoutSeconds: 120,
          maxRetries: 1,
          retryDelaySeconds: 0,
          cwd,
          permissionMode: "plan",
          inheritEnv: false,
        });
        assert(!result.error, `${runtime}/${transport}: ${result.error}`);
        assertStringIncludes(result.output?.result.toLowerCase() ?? "", "ok");
      } finally {
        await Deno.remove(cwd, { recursive: true }).catch(() => {});
      }
    },
  });
}
