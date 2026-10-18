/**
 * FR-L53 behavioural check across every agent spawn site: with
 * `inheritEnv: false` the child sees the env the caller passed, the OS-user
 * vars and its own runtime's login vars from this process, and the
 * library's own variables — never the rest of this process's env. A PATH stub
 * named after each runtime appends its env to `$ENV_PROBE` and exits; this
 * process carries a sentinel variable that must not reach the stub.
 */

import { assert, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { ProcessRegistry } from "../process-registry.ts";
import { getRuntimeAdapter } from "./index.ts";
import { exportOpenCodeTranscript } from "../opencode/transcript.ts";
import { createCursorChat } from "../cursor/chat.ts";
import type { RuntimeId } from "../types.ts";

const SENTINEL = "AI_IDE_CLI_FR_L53_SENTINEL";

const DUMP_STUB = `#!/bin/sh
/usr/bin/env >> "$ENV_PROBE"
echo "--" >> "$ENV_PROBE"
`;

interface Stub {
  /** Env a caller would pass: stub dir as PATH and HOME, the probe path. */
  env: Record<string, string>;
  /** Path of the stub executable. */
  bin: string;
  /** Everything the stub(s) dumped so far. */
  read: () => Promise<string>;
}

async function withDumpStub(
  name: string,
  fn: (stub: Stub) => Promise<void>,
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "inherit-env-stub-" });
  const bin = join(dir, name);
  const probe = join(dir, "probe");
  await Deno.writeTextFile(bin, DUMP_STUB);
  await Deno.chmod(bin, 0o755);
  const prevPath = Deno.env.get("PATH") ?? "";
  // The stub must also win the lookup in default mode.
  Deno.env.set("PATH", `${dir}:${prevPath}`);
  Deno.env.set(SENTINEL, "leaked");
  const read = () => Deno.readTextFile(probe).catch(() => "");
  try {
    await fn({ env: { PATH: dir, HOME: dir, ENV_PROBE: probe }, bin, read });
    return await read();
  } finally {
    Deno.env.set("PATH", prevPath);
    Deno.env.delete(SENTINEL);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** Assert the stub ran and saw the passed env but not the sentinel. */
function assertIsolated(dump: string): void {
  assertStringIncludes(dump, "ENV_PROBE=", "stub never ran");
  assert(!dump.includes(SENTINEL), `parent env leaked:\n${dump}`);
}

const RUNTIMES: readonly RuntimeId[] = [
  "claude",
  "codex",
  "opencode",
  "cursor",
];
const opts = { ignore: Deno.build.os === "windows" };

for (const runtime of RUNTIMES) {
  Deno.test({
    ...opts,
    name:
      `FR-L53 ${runtime} invoke with inheritEnv: false hides the parent env`,
    fn: async () => {
      const dump = await withDumpStub(runtime, async ({ env }) => {
        await getRuntimeAdapter(runtime).invoke({
          processRegistry: new ProcessRegistry(),
          taskPrompt: "x",
          timeoutSeconds: 10,
          maxRetries: 1,
          retryDelaySeconds: 0,
          env,
          inheritEnv: false,
        }).catch(() => {});
      });
      assertIsolated(dump);
    },
  });

  Deno.test({
    ...opts,
    name:
      `FR-L53 ${runtime} session with inheritEnv: false hides the parent env`,
    fn: async () => {
      const dump = await withDumpStub(runtime, async ({ env, read }) => {
        const session = await getRuntimeAdapter(runtime).openSession!({
          processRegistry: new ProcessRegistry(),
          env,
          inheritEnv: false,
          // Cursor spawns per send; skip create-chat (tested on its own).
          ...(runtime === "cursor" ? { resumeSessionId: "chat-1" } : {}),
        }).catch(() => undefined);
        if (session) {
          if (runtime === "cursor") await session.send("x").catch(() => {});
          for (let i = 0; i < 200 && !(await read()); i++) {
            await new Promise((r) => setTimeout(r, 25));
          }
          await session.abort();
          await session.done;
        }
      });
      assertIsolated(dump);
    },
  });
}

Deno.test({
  ...opts,
  name: "FR-L53 ACP front with inheritEnv: false hides the parent env",
  fn: async () => {
    const dump = await withDumpStub("acp-front", async ({ env, bin }) => {
      await getRuntimeAdapter("claude").invoke({
        processRegistry: new ProcessRegistry(),
        transport: "acp",
        acpFront: { cmd: bin, args: [], pilot: true },
        taskPrompt: "x",
        timeoutSeconds: 10,
        maxRetries: 0,
        retryDelaySeconds: 0,
        env,
        inheritEnv: false,
      }).catch(() => {});
    });
    assertIsolated(dump);
  },
});

Deno.test({
  ...opts,
  name: "FR-L53 codex ACP front ignores the parent CODEX_CONFIG when isolated",
  fn: async () => {
    Deno.env.set("CODEX_CONFIG", JSON.stringify({ [SENTINEL]: 1 }));
    try {
      const dump = await withDumpStub("acp-front", async ({ env, bin }) => {
        await getRuntimeAdapter("codex").invoke({
          processRegistry: new ProcessRegistry(),
          transport: "acp",
          acpFront: { cmd: bin, args: [], pilot: true },
          taskPrompt: "x",
          model: "m-1",
          timeoutSeconds: 10,
          maxRetries: 0,
          retryDelaySeconds: 0,
          env,
          inheritEnv: false,
        }).catch(() => {});
      });
      assertIsolated(dump);
      assertStringIncludes(dump, 'CODEX_CONFIG={"model":"m-1"}');
    } finally {
      Deno.env.delete("CODEX_CONFIG");
    }
  },
});

Deno.test({
  ...opts,
  name: "FR-L53 opencode export with inheritEnv: false hides the parent env",
  fn: async () => {
    const dump = await withDumpStub("opencode", async ({ env }) => {
      await exportOpenCodeTranscript("ses-1", { env, inheritEnv: false });
    });
    assertIsolated(dump);
  },
});

Deno.test({
  ...opts,
  name: "FR-L53 cursor create-chat with inheritEnv: false hides the parent env",
  fn: async () => {
    const dump = await withDumpStub("cursor", async ({ env }) => {
      await createCursorChat({
        processRegistry: new ProcessRegistry(),
        env,
        inheritEnv: false,
      }).catch(() => {});
    });
    assertIsolated(dump);
  },
});

/** One login variable per runtime, accepted by its `<runtime>/auth-env.ts`. */
const LOGIN_VAR: Record<RuntimeId, string> = {
  claude: "ANTHROPIC_API_KEY",
  codex: "OPENAI_API_KEY",
  opencode: "AI_IDE_CLI_FR_L53_API_KEY",
  cursor: "CURSOR_API_KEY",
};

/** Run `fn` with `vars` set in this process's env, restoring them after. */
async function withParentEnv(
  vars: Record<string, string>,
  fn: () => Promise<void>,
): Promise<void> {
  const prev = Object.fromEntries(
    Object.keys(vars).map((k) => [k, Deno.env.get(k)]),
  );
  for (const [k, v] of Object.entries(vars)) Deno.env.set(k, v);
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

/** Assert the isolated child kept the OS user and its runtime's login. */
function assertLoginCarried(dump: string, runtime: RuntimeId): void {
  assertIsolated(dump);
  assertStringIncludes(dump, `${LOGIN_VAR[runtime]}=parent-login`);
  assertStringIncludes(dump, "USER=fr-l53-user");
}

const TRANSPORTS = [
  ...RUNTIMES.map((runtime) => ({ runtime, acp: false })),
  { runtime: "claude" as const, acp: true },
  { runtime: "codex" as const, acp: true },
  { runtime: "opencode" as const, acp: true },
];

for (const { runtime, acp } of TRANSPORTS) {
  Deno.test({
    ...opts,
    name: `FR-L53 ${runtime}${
      acp ? " ACP" : ""
    } isolated child keeps the user and its login, no env passed`,
    fn: async () => {
      let dump = "";
      await withParentEnv(
        { [LOGIN_VAR[runtime]]: "parent-login", USER: "fr-l53-user" },
        async () => {
          dump = await withDumpStub(
            acp ? "acp-front" : runtime,
            async ({ env, bin }) => {
              await getRuntimeAdapter(runtime).invoke({
                processRegistry: new ProcessRegistry(),
                taskPrompt: "x",
                timeoutSeconds: 10,
                maxRetries: acp ? 0 : 1,
                retryDelaySeconds: 0,
                // Only the probe path: PATH, HOME, USER and the login come
                // from this process.
                env: { ENV_PROBE: env.ENV_PROBE },
                inheritEnv: false,
                ...(acp
                  ? {
                    transport: "acp" as const,
                    acpFront: { cmd: bin, args: [], pilot: true },
                    model: "m-1",
                  }
                  : {}),
              }).catch(() => {});
            },
          );
        },
      );
      assertLoginCarried(dump, runtime);
    },
  });
}

Deno.test({
  ...opts,
  name: "FR-L53 isolated child does not get another runtime's login",
  fn: async () => {
    let dump = "";
    await withParentEnv({ [LOGIN_VAR.codex]: "parent-login" }, async () => {
      dump = await withDumpStub("claude", async ({ env }) => {
        await getRuntimeAdapter("claude").invoke({
          processRegistry: new ProcessRegistry(),
          taskPrompt: "x",
          timeoutSeconds: 10,
          maxRetries: 1,
          retryDelaySeconds: 0,
          env: { ENV_PROBE: env.ENV_PROBE },
          inheritEnv: false,
        }).catch(() => {});
      });
    });
    assertIsolated(dump);
    assert(!dump.includes(`${LOGIN_VAR.codex}=`), dump);
  },
});

Deno.test({
  ...opts,
  name: "FR-L53 control: default invoke inherits the parent env",
  fn: async () => {
    const dump = await withDumpStub("claude", async ({ env }) => {
      await getRuntimeAdapter("claude").invoke({
        processRegistry: new ProcessRegistry(),
        taskPrompt: "x",
        timeoutSeconds: 10,
        maxRetries: 1,
        retryDelaySeconds: 0,
        env: { ENV_PROBE: env.ENV_PROBE },
      });
    });
    assertStringIncludes(dump, `${SENTINEL}=leaked`);
  },
});
