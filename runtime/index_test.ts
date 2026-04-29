import { assert, assertEquals } from "@std/assert";
import { expandExtraArgs, resolveRuntimeConfig } from "./index.ts";

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
