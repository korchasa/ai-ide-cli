/**
 * Tests for instance-scoped {@link ProcessRegistry} and the
 * backward-compatible default-instance free-function wrappers.
 */

import { assertEquals } from "@std/assert";
import {
  _getProcesses,
  _getShutdownCallbacks,
  _reset,
  killAll,
  onShutdown,
  ProcessRegistry,
  register,
  unregister,
} from "./process-registry.ts";

const SH = Deno.build.os === "windows" ? "cmd" : "/bin/sh";
function shArgs(cmd: string): string[] {
  return Deno.build.os === "windows" ? ["/c", cmd] : ["-c", cmd];
}

function spawnSleep(seconds: number): Deno.ChildProcess {
  return new Deno.Command(SH, {
    args: shArgs(`sleep ${seconds}`),
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
}

Deno.test("ProcessRegistry instances are isolated", async () => {
  const a = new ProcessRegistry();
  const b = new ProcessRegistry();
  const pa = spawnSleep(60);
  const pb = spawnSleep(60);
  a.register(pa);
  b.register(pb);

  assertEquals(a.size, 1);
  assertEquals(b.size, 1);

  await a.killAll();

  assertEquals(a.size, 0);
  assertEquals(b.size, 1, "killAll on registry a must not touch registry b");

  const exitedA = await pa.status;
  assertEquals(exitedA.success, false);

  await b.killAll();
  await pb.status;
});

Deno.test("ProcessRegistry shutdown callbacks fire after process kill", async () => {
  const reg = new ProcessRegistry();
  const order: string[] = [];
  const proc = spawnSleep(60);
  reg.register(proc);
  reg.onShutdown(() => {
    order.push("cb");
  });
  await reg.killAll();
  await proc.status;
  assertEquals(order, ["cb"]);
  assertEquals(reg.size, 0);
});

Deno.test("ProcessRegistry onShutdown disposer removes the callback", async () => {
  const reg = new ProcessRegistry();
  const seen: string[] = [];
  const dispose = reg.onShutdown(() => {
    seen.push("never");
  });
  dispose();
  await reg.killAll();
  assertEquals(seen, []);
});

Deno.test("default-instance free functions wrap the global registry (back-compat)", async () => {
  _reset();
  const proc = spawnSleep(60);
  register(proc);
  assertEquals(_getProcesses().size, 1);
  let cbFired = false;
  onShutdown(() => {
    cbFired = true;
  });
  assertEquals(_getShutdownCallbacks().length, 1);

  unregister(proc);
  assertEquals(_getProcesses().size, 0);

  // Re-register so killAll has something to terminate.
  register(proc);
  await killAll();
  assertEquals(_getProcesses().size, 0);
  assertEquals(_getShutdownCallbacks().length, 0);
  assertEquals(cbFired, true);
  await proc.status;
});

Deno.test("ProcessRegistry.killAll escalates to SIGKILL after grace timeout", async () => {
  // Process that ignores SIGTERM via `trap`. We want killAll to escalate.
  if (Deno.build.os === "windows") return; // POSIX-only behaviour.
  const reg = new ProcessRegistry({ graceMs: 100 });
  const proc = new Deno.Command("/bin/sh", {
    args: ["-c", "trap '' TERM; sleep 60"],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
  reg.register(proc);
  const t0 = performance.now();
  await reg.killAll();
  const elapsed = performance.now() - t0;
  const status = await proc.status;
  assertEquals(status.success, false);
  // SIGKILL escalation should fire shortly after graceMs, well under 5s.
  assertEquals(
    elapsed < 1500,
    true,
    `killAll took ${elapsed}ms, expected < 1500ms`,
  );
});
