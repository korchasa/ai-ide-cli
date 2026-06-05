import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  expandExtraArgs,
  getRuntimeAdapter,
  resolveRuntimeConfig,
} from "./index.ts";
import { ProcessRegistry } from "../process-registry.ts";
import { CommandsUnavailableError } from "./commands.ts";
import type { RuntimeId } from "../types.ts";

// --- expandExtraArgs ---

Deno.test("expandExtraArgs — empty/undefined map yields empty argv", () => {
  assertEquals(expandExtraArgs(undefined), []);
  assertEquals(expandExtraArgs({}), []);
});

Deno.test("expandExtraArgs — non-empty string emits key/value pair", () => {
  assertEquals(
    expandExtraArgs({ "--model": "claude-4-opus" }),
    ["--model", "claude-4-opus"],
  );
});

Deno.test("expandExtraArgs — empty string emits bare flag", () => {
  assertEquals(expandExtraArgs({ "--verbose": "" }), ["--verbose"]);
});

Deno.test("expandExtraArgs — null value suppresses the flag", () => {
  assertEquals(
    expandExtraArgs({ "--dropped": null, "--kept": "v" }),
    ["--kept", "v"],
  );
});

Deno.test("expandExtraArgs — insertion order is preserved", () => {
  const map: Record<string, string | null> = {};
  map["--a"] = "1";
  map["--b"] = "";
  map["--c"] = "2";
  assertEquals(expandExtraArgs(map), ["--a", "1", "--b", "--c", "2"]);
});

Deno.test("expandExtraArgs — reserved key throws synchronously", () => {
  let caught: Error | undefined;
  try {
    expandExtraArgs({ "--output-format": "json" }, ["--output-format"]);
  } catch (err) {
    caught = err as Error;
  }
  assert(caught !== undefined);
  assert(caught!.message.includes("--output-format"));
});

// --- resolveRuntimeConfig cascade with map-shape runtime_args ---

Deno.test("resolveRuntimeConfig — merges runtime_args cascade last-writer-wins", () => {
  const resolved = resolveRuntimeConfig({
    defaults: { runtime_args: { "--foo": "defaults", "--bar": "shared" } },
    parent: { runtime_args: { "--bar": "parent" } },
    node: { runtime_args: { "--baz": "node" } },
  });
  assertEquals(resolved.args["--foo"], "defaults");
  assertEquals(resolved.args["--bar"], "parent");
  assertEquals(resolved.args["--baz"], "node");
});

Deno.test("resolveRuntimeConfig — null at node suppresses parent value", () => {
  const resolved = resolveRuntimeConfig({
    defaults: {},
    parent: { runtime_args: { "--x": "parent-value" } },
    node: { runtime_args: { "--x": null } },
  });
  // null survives the merge, so expandExtraArgs would drop the flag.
  assertEquals(resolved.args["--x"], null);
  assertEquals(expandExtraArgs(resolved.args), []);
});

Deno.test("resolveRuntimeConfig — omitting runtime_args everywhere yields empty map", () => {
  const resolved = resolveRuntimeConfig({ node: {} });
  assertEquals(resolved.args, {});
});

Deno.test("resolveRuntimeConfig — default runtime remains claude when unspecified", () => {
  const resolved = resolveRuntimeConfig({ node: {} });
  assertEquals(resolved.runtime, "claude");
});

// --- resolveRuntimeConfig: reasoning effort cascade (FR-L25 cascade) ---

Deno.test("resolveRuntimeConfig — reasoningEffort: defaults applied when node omits", () => {
  const resolved = resolveRuntimeConfig({
    defaults: { effort: "medium" },
    node: {},
  });
  assertEquals(resolved.reasoningEffort, "medium");
});

Deno.test("resolveRuntimeConfig — reasoningEffort: node overrides defaults", () => {
  const resolved = resolveRuntimeConfig({
    defaults: { effort: "low" },
    node: { effort: "high" },
  });
  assertEquals(resolved.reasoningEffort, "high");
});

Deno.test("resolveRuntimeConfig — reasoningEffort: parent overrides defaults, node overrides parent", () => {
  // parent set, node omits → parent wins over defaults
  const inheritFromParent = resolveRuntimeConfig({
    defaults: { effort: "low" },
    parent: { effort: "high" },
    node: {},
  });
  assertEquals(inheritFromParent.reasoningEffort, "high");

  // node set → wins over parent and defaults
  const nodeOverride = resolveRuntimeConfig({
    defaults: { effort: "low" },
    parent: { effort: "medium" },
    node: { effort: "minimal" },
  });
  assertEquals(nodeOverride.reasoningEffort, "minimal");
});

Deno.test("resolveRuntimeConfig — reasoningEffort: undefined when nowhere set", () => {
  const resolved = resolveRuntimeConfig({ node: {} });
  assertEquals(resolved.reasoningEffort, undefined);
});

// --- adapter.fetchCommands (FR-L42) ---

const ACP_PILOTS: RuntimeId[] = ["claude", "codex", "opencode"];

/** Run `fn` with a PATH-stub `npx`/`opencode` ACP front. */
async function withStubFront<T>(
  script: string,
  fn: () => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "index-cmd-stub-" });
  for (const name of ["npx", "opencode"]) {
    const stub = `${dir}/${name}`;
    await Deno.writeTextFile(stub, `#!/usr/bin/env bash\n${script}\n`);
    await Deno.chmod(stub, 0o755);
  }
  const prev = Deno.env.get("PATH") ?? "";
  Deno.env.set("PATH", `${dir}:${prev}`);
  try {
    return await fn();
  } finally {
    Deno.env.set("PATH", prev);
    try {
      await Deno.remove(dir, { recursive: true });
    } catch {
      // best-effort
    }
  }
}

const PILOT_COMMANDS_SCRIPT = `
shift; shift 2>/dev/null
respond() { printf '{"jsonrpc":"2.0","id":%s,"result":%s}\\n' "$1" "$2"; }
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\\1/')
  method=$(printf '%s' "$line" | sed -E 's/.*"method":"([^"]+)".*/\\1/')
  case "$method" in
    initialize) respond "$id" '{}' ;;
    session/new)
      respond "$id" '{"sessionId":"sess-x"}'
      printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionUpdate":"available_commands_update","availableCommands":[{"name":"/help","description":"Show help"}]}}\\n'
      ;;
    *) respond "$id" 'null' ;;
  esac
done
`;

Deno.test("ACP-piloted adapters expose fetchCommands and delegate to the ACP helper (FR-L42)", async () => {
  for (const runtime of ACP_PILOTS) {
    const adapter = getRuntimeAdapter(runtime);
    assert(
      typeof adapter.fetchCommands === "function",
      `${runtime} must implement fetchCommands`,
    );
    await withStubFront(PILOT_COMMANDS_SCRIPT, async () => {
      const snapshot = await adapter.fetchCommands!({
        transport: "acp",
        processRegistry: new ProcessRegistry(),
        timeoutMs: 5_000,
      });
      assertEquals(snapshot.runtime, runtime);
      assertEquals(snapshot.commands[0].name, "/help");
    });
  }
});

Deno.test("fetchCommands rejects CommandsUnavailableError(no_fast_channel) on cli transport (FR-L42)", async () => {
  for (const runtime of ACP_PILOTS) {
    const adapter = getRuntimeAdapter(runtime);
    const err = await assertRejects(
      () =>
        adapter.fetchCommands!({
          transport: "cli",
          processRegistry: new ProcessRegistry(),
        }),
      CommandsUnavailableError,
    );
    assertEquals(err.reason, "no_fast_channel");
    assertEquals(err.runtime, runtime);
  }
});

Deno.test("cursor adapter leaves fetchCommands undefined (FR-L42)", () => {
  const adapter = getRuntimeAdapter("cursor");
  assertEquals(adapter.fetchCommands, undefined);
});
