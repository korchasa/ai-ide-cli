/**
 * Integration test: when a caller passes a custom `processRegistry` to
 * `RuntimeInvokeOptions` / `RuntimeSessionOptions`, the spawned subprocess
 * MUST be tracked by that registry, not by the module-level default
 * registry. This is the contract that lets embedders host multiple
 * independent runtimes in one process and reap them by `killAll`.
 *
 * The test exercises the cursor adapter's `createCursorChat` path because
 * it is the simplest end-to-end spawn that completes synchronously with a
 * stub binary on PATH.
 */

import { assert, assertEquals } from "@std/assert";
import { ProcessRegistry } from "../process-registry.ts";
import { _getProcesses as _getDefaultProcesses } from "../process-registry.ts";
import { createCursorChat } from "../cursor/session.ts";

async function withStubCursor<T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "process-registry-stub-" });
  const stubPath = `${dir}/cursor`;
  await Deno.writeTextFile(
    stubPath,
    `#!/usr/bin/env bash
set -e
shift
if [ "$1" = "create-chat" ]; then
  printf '%s\\n' "stub-chat-id"
  exit 0
fi
exit 99
`,
  );
  await Deno.chmod(stubPath, 0o755);
  const prevPath = Deno.env.get("PATH") ?? "";
  Deno.env.set("PATH", `${dir}:${prevPath}`);
  try {
    return await fn(dir);
  } finally {
    Deno.env.set("PATH", prevPath);
    try {
      await Deno.remove(dir, { recursive: true });
    } catch { /* best-effort */ }
  }
}

/**
 * Tracking registry: counts register/unregister calls so the test can
 * prove the custom registry was used (and the default singleton was not).
 */
class CountingRegistry extends ProcessRegistry {
  registers = 0;
  unregisters = 0;
  override register(p: Deno.ChildProcess): void {
    this.registers++;
    super.register(p);
  }
  override unregister(p: Deno.ChildProcess): void {
    this.unregisters++;
    super.unregister(p);
  }
}

Deno.test(
  "processRegistry routing — createCursorChat tracks subprocess on supplied registry, not default",
  async () => {
    await withStubCursor(async () => {
      const reg = new CountingRegistry();
      const defaultBefore = _getDefaultProcesses().size;

      const id = await createCursorChat({ processRegistry: reg });

      assertEquals(id, "stub-chat-id");
      assert(
        reg.registers >= 1,
        `expected custom registry to record at least one register, got ${reg.registers}`,
      );
      assertEquals(
        reg.registers,
        reg.unregisters,
        "register/unregister should be balanced after a successful call",
      );
      assertEquals(
        _getDefaultProcesses().size,
        defaultBefore,
        "default singleton must not have grown",
      );
    });
  },
);
