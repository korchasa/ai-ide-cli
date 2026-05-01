import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";

/**
 * Regression suite for the previously latent circular import between
 * `runtime/index.ts` ↔ `*-adapter.ts` ↔ `<runtime>/process.ts`.
 *
 * Loading any `<runtime>-adapter.ts` as the **direct** entry point used to
 * trip a TDZ — `runtime/index.ts` evaluated its `ADAPTERS = { … }` record
 * before the adapter binding was initialized, throwing
 * `Cannot access '<runtime>RuntimeAdapter' before initialization`.
 *
 * Each scenario spawns a fresh `deno eval` so the shared module cache is
 * bypassed; the cycle-sensitive evaluation order can only be observed
 * across independent processes.
 */

const ADAPTER_FILES = [
  { runtime: "claude", file: "claude-adapter.ts" },
  { runtime: "codex", file: "codex-adapter.ts" },
  { runtime: "cursor", file: "cursor-adapter.ts" },
  { runtime: "opencode", file: "opencode-adapter.ts" },
] as const;

const RUNTIME_DIR = fromFileUrl(new URL(".", import.meta.url));

async function importAdapterInFreshProcess(
  file: string,
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
  const adapterUrl = new URL(file, import.meta.url).href;
  // Import the adapter as the FIRST module of a fresh Deno process and
  // print a single token so the parent can assert the binding loaded.
  const code = `
    import { ${
    file.replace("-adapter.ts", "")
  }RuntimeAdapter as adapter } from "${adapterUrl}";
    if (!adapter) throw new Error("adapter unbound");
    if (typeof adapter !== "object") throw new Error("adapter not an object");
    if (typeof adapter.invoke !== "function") {
      throw new Error("adapter.invoke not a function");
    }
    console.log("OK:" + adapter.id);
  `;
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["eval", "--no-check", code],
    stdout: "piped",
    stderr: "piped",
    cwd: RUNTIME_DIR,
  });
  const out = await cmd.output();
  return {
    ok: out.success,
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

for (const { runtime, file } of ADAPTER_FILES) {
  Deno.test(
    `direct-import: runtime/${file} loads as primary entry without TDZ`,
    async () => {
      const result = await importAdapterInFreshProcess(file);
      assert(
        result.ok,
        `deno eval exit code ${result.code}\n` +
          `stdout: ${result.stdout}\n` +
          `stderr: ${result.stderr}`,
      );
      assertEquals(result.stdout.trim(), `OK:${runtime}`);
      assert(
        !result.stderr.includes("before initialization"),
        `TDZ leaked into stderr: ${result.stderr}`,
      );
    },
  );
}
