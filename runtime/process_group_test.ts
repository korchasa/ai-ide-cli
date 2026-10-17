/**
 * FR-L51 behavioural check across the CLI spawn sites: with
 * `processGroup: true` the runtime leads its own process group, and an
 * abort kills the tools it forked. A PATH stub named after each runtime
 * forks a `sleep` grandchild, records `pid pgid grandchild`, and waits.
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ProcessRegistry } from "../process-registry.ts";
import { getRuntimeAdapter } from "./index.ts";
import { CodexAppServerClient } from "../codex/app-server.ts";
import type { RuntimeId } from "../types.ts";

const FORKING_STUB = `#!/usr/bin/env bash
sleep 30 &
echo "$$ $(ps -o pgid= -p $$ | tr -d ' ') $!" > "$PGROUP_PROBE"
wait
`;

interface Probe {
  pid: number;
  pgid: number;
  grandchild: number;
}

async function withForkingStub<T>(
  name: string,
  fn: (readProbe: () => Promise<Probe>, binPath: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "pgroup-stub-" });
  const binPath = join(dir, name);
  const probe = join(dir, "probe");
  await Deno.writeTextFile(binPath, FORKING_STUB);
  await Deno.chmod(binPath, 0o755);
  const prevPath = Deno.env.get("PATH") ?? "";
  Deno.env.set("PATH", `${dir}:${prevPath}`);
  Deno.env.set("PGROUP_PROBE", probe);
  const readProbe = async (): Promise<Probe> => {
    for (let i = 0; i < 200; i++) {
      const text = (await Deno.readTextFile(probe).catch(() => "")).trim();
      const parts = text.split(/\s+/).map(Number);
      if (parts.length === 3 && parts.every((n) => n > 0)) {
        return { pid: parts[0], pgid: parts[1], grandchild: parts[2] };
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`stub ${name} never wrote its probe`);
  };
  try {
    return await fn(readProbe, binPath);
  } finally {
    Deno.env.set("PATH", prevPath);
    Deno.env.delete("PGROUP_PROBE");
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

async function isAlive(pid: number): Promise<boolean> {
  const { success } = await new Deno.Command("kill", {
    args: ["-0", String(pid)],
    stdout: "null",
    stderr: "null",
  }).output();
  return success;
}

async function waitDead(pid: number): Promise<boolean> {
  for (let i = 0; i < 80; i++) {
    if (!(await isAlive(pid))) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** Abort an invoke once the stub has forked; return the stub's probe. */
async function abortedInvoke(
  runtime: RuntimeId,
  processGroup: boolean,
): Promise<Probe> {
  return await withForkingStub(runtime, async (readProbe) => {
    const ctrl = new AbortController();
    const run = getRuntimeAdapter(runtime).invoke({
      processRegistry: new ProcessRegistry(),
      taskPrompt: "x",
      timeoutSeconds: 30,
      maxRetries: 1,
      retryDelaySeconds: 0,
      signal: ctrl.signal,
      processGroup,
    });
    const probe = await readProbe();
    ctrl.abort();
    await run;
    return probe;
  });
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
      `FR-L51 ${runtime} invoke leads its group and abort kills the grandchild`,
    fn: async () => {
      const probe = await abortedInvoke(runtime, true);
      assertEquals(probe.pgid, probe.pid, "runtime must lead its own group");
      assert(await waitDead(probe.grandchild), "grandchild outlived abort");
    },
  });
}

Deno.test({
  ...opts,
  name: "FR-L51 control: without processGroup the grandchild survives an abort",
  fn: async () => {
    await withForkingStub("claude", async (readProbe) => {
      const ctrl = new AbortController();
      const run = getRuntimeAdapter("claude").invoke({
        processRegistry: new ProcessRegistry(),
        taskPrompt: "x",
        timeoutSeconds: 30,
        maxRetries: 1,
        retryDelaySeconds: 0,
        signal: ctrl.signal,
      });
      const probe = await readProbe();
      ctrl.abort();
      await new Promise((r) => setTimeout(r, 300));
      // The orphan still holds the stdout pipe, so the run cannot finish
      // until it is killed by hand — the failure FR-L51 removes.
      const survived = await isAlive(probe.grandchild);
      Deno.kill(probe.grandchild, "SIGKILL");
      await run;
      assertEquals(survived, true);
      assert(
        probe.pgid !== probe.pid,
        "a plain spawn shares the caller's group",
      );
    });
  },
});

Deno.test({
  ...opts,
  name: "FR-L51 claude session abort kills the group",
  fn: async () => {
    await withForkingStub("claude", async (readProbe) => {
      const session = await getRuntimeAdapter("claude").openSession!({
        processRegistry: new ProcessRegistry(),
        processGroup: true,
      });
      const probe = await readProbe();
      session.abort();
      await session.done;
      assertEquals(probe.pgid, probe.pid);
      assert(await waitDead(probe.grandchild), "grandchild outlived abort");
    });
  },
});

Deno.test({
  ...opts,
  name: "FR-L51 cursor session send spawns a group leader that abort kills",
  fn: async () => {
    await withForkingStub("cursor", async (readProbe) => {
      // `resumeSessionId` skips `create-chat`, so the first spawn is the
      // per-send subprocess.
      const session = await getRuntimeAdapter("cursor").openSession!({
        processRegistry: new ProcessRegistry(),
        resumeSessionId: "chat-1",
        processGroup: true,
      });
      await session.send("hi");
      const probe = await readProbe();
      session.abort();
      await session.done;
      assertEquals(probe.pgid, probe.pid);
      assert(await waitDead(probe.grandchild), "grandchild outlived abort");
    });
  },
});

Deno.test({
  ...opts,
  name: "FR-L51 codex app-server client leads its group and abort kills it",
  fn: async () => {
    await withForkingStub("codex", async (readProbe, binPath) => {
      const client = CodexAppServerClient.spawn({
        binary: binPath,
        processRegistry: new ProcessRegistry(),
        processGroup: true,
      });
      const probe = await readProbe();
      client.abort();
      await client.done;
      assertEquals(probe.pgid, probe.pid);
      assert(await waitDead(probe.grandchild), "grandchild outlived abort");
    });
  },
});
