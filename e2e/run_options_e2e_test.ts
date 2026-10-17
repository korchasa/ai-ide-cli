/**
 * @module
 * Real-binary smokes for the per-run options of FR-L49..FR-L52:
 *
 * - FR-L49: an ACP two-turn session reports non-zero usage on every
 *   turn-end, scoped to that turn (claude, codex).
 * - FR-L50: `outputSchema` on the CLI invoke yields a parsed
 *   `structured_output` (claude, codex).
 * - FR-L51: `processGroup: true` runs to completion with piped stdio
 *   (claude, codex) — the kill path is unit-tested with stubs.
 * - FR-L52: a codex app-server session with `ephemeral: true` writes no
 *   rollout under `$CODEX_HOME/sessions/`.
 *
 * Prompts are one-word replies in a scratch git repo, read-only.
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { CliRunUsage, RuntimeId } from "../types.ts";
import { ProcessRegistry } from "../process-registry.ts";
import { getRuntimeAdapter } from "../runtime/index.ts";
import {
  type RuntimeSessionEvent,
  SYNTHETIC_TURN_END,
} from "../runtime/types.ts";
import {
  e2eAcpEnabled,
  ONE_WORD_DONE,
  ONE_WORD_OK,
  resolveEnabledMap,
} from "./_helpers.ts";

const RUNTIMES: RuntimeId[] = ["claude", "codex"];
const enabled = await resolveEnabledMap();
const acpEnabled: Record<string, boolean> = {};
for (const r of RUNTIMES) acpEnabled[r] = await e2eAcpEnabled(r);

const SANITIZE = {
  sanitizeOps: false,
  sanitizeResources: false,
  sanitizeExit: false,
};

async function scratchRepo(runtime: RuntimeId): Promise<string> {
  const dir = await Deno.makeTempDir({
    prefix: `ai-ide-cli-e2e-${runtime}-opts-`,
  });
  const init = await new Deno.Command("git", {
    args: ["init", "--quiet"],
    cwd: dir,
    stdout: "null",
    stderr: "null",
  }).output();
  assert(init.success, `git init failed in ${dir}`);
  return dir;
}

const VERDICT_SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" }, n: { type: "integer" } },
  required: ["answer", "n"],
  additionalProperties: false,
};

for (const runtime of RUNTIMES) {
  Deno.test({
    name:
      `e2e run-options/${runtime}/FR-L49 ACP turn-end carries per-turn usage`,
    ignore: !acpEnabled[runtime],
    ...SANITIZE,
    fn: async () => {
      const cwd = await scratchRepo(runtime);
      const registry = new ProcessRegistry();
      try {
        const session = await getRuntimeAdapter(runtime).openSession!({
          processRegistry: registry,
          transport: "acp",
          permissionMode: "plan",
          cwd,
        });
        const usages: CliRunUsage[] = [];
        const drain = (async () => {
          for await (
            const ev of session.events as AsyncIterable<RuntimeSessionEvent>
          ) {
            if (ev.type !== SYNTHETIC_TURN_END) continue;
            usages.push(ev.raw["usage"] as CliRunUsage);
            if (usages.length === 2) break;
          }
        })();
        await session.send(ONE_WORD_OK);
        await session.send(ONE_WORD_DONE);
        await drain;
        session.abort();
        await session.done;
        console.log(
          `[e2e] ${runtime} ACP usage per turn: ${JSON.stringify(usages)}`,
        );
        for (const u of usages) {
          assert(u, "turn-end carried no usage");
          assert(
            (u.output_tokens ?? 0) > 0,
            `no output tokens: ${JSON.stringify(u)}`,
          );
        }
      } finally {
        await registry.killAll();
        await Deno.remove(cwd, { recursive: true }).catch(() => {});
      }
    },
  });

  Deno.test({
    name:
      `e2e run-options/${runtime}/FR-L50 outputSchema yields structured_output`,
    ignore: !enabled[runtime],
    ...SANITIZE,
    fn: async () => {
      const cwd = await scratchRepo(runtime);
      try {
        const result = await getRuntimeAdapter(runtime).invoke({
          processRegistry: new ProcessRegistry(),
          taskPrompt: "Return answer=ok and n=7.",
          timeoutSeconds: 120,
          maxRetries: 1,
          retryDelaySeconds: 0,
          cwd,
          permissionMode: "plan",
          outputSchema: VERDICT_SCHEMA,
          ephemeral: true,
          // FR-L51 rides along: piped stdio must work on a detached child.
          processGroup: true,
        });
        assert(!result.error, `${runtime}: ${result.error}`);
        assertEquals(result.output?.structured_output, { answer: "ok", n: 7 });
      } finally {
        await Deno.remove(cwd, { recursive: true }).catch(() => {});
      }
    },
  });
}

/** Every file under `dir`, recursively; empty when `dir` is missing. */
async function listFiles(dir: string): Promise<Set<string>> {
  const out = new Set<string>();
  const walk = async (d: string) => {
    for await (const e of Deno.readDir(d)) {
      const p = join(d, e.name);
      if (e.isDirectory) await walk(p);
      else out.add(p);
    }
  };
  await walk(dir).catch(() => {});
  return out;
}

Deno.test({
  name:
    "e2e run-options/codex/FR-L52 ephemeral app-server session writes no rollout",
  ignore: !enabled.codex,
  ...SANITIZE,
  fn: async () => {
    const cwd = await scratchRepo("codex");
    const sessions = join(
      Deno.env.get("CODEX_HOME") ?? join(Deno.env.get("HOME") ?? "", ".codex"),
      "sessions",
    );
    /** Run one-turn session; return the new rollout files naming its thread. */
    const runOnce = async (ephemeral: boolean): Promise<string[]> => {
      const before = await listFiles(sessions);
      const session = await getRuntimeAdapter("codex").openSession!({
        processRegistry: new ProcessRegistry(),
        permissionMode: "plan",
        cwd,
        ephemeral,
      });
      const drain = (async () => {
        for await (const ev of session.events) {
          if (ev.type === SYNTHETIC_TURN_END) break;
        }
      })();
      await session.send(ONE_WORD_OK);
      await drain;
      await session.endInput();
      await session.done;
      return [...await listFiles(sessions)].filter((f) =>
        !before.has(f) && f.includes(session.sessionId)
      );
    };
    try {
      // Control: a persisted thread does land in the sessions dir.
      assertEquals(
        (await runOnce(false)).length,
        1,
        "control wrote no rollout",
      );
      assertEquals(await runOnce(true), [], "ephemeral thread left a rollout");
    } finally {
      await Deno.remove(cwd, { recursive: true }).catch(() => {});
    }
  },
});
