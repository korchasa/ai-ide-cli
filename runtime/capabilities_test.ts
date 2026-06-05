import { assertEquals, assertThrows } from "@std/assert";
import {
  type FetchCapabilitiesOptions,
  fetchInventoryViaInvoke,
  parseCapabilityInventoryResponse,
} from "./capabilities.ts";
import { ProcessRegistry } from "../process-registry.ts";
import type { CliRunOutput } from "../types.ts";

/** Build a minimal successful invoke result carrying `result` text. */
function okResult(result: string): { output: CliRunOutput } {
  return {
    output: {
      runtime: "claude",
      result,
      session_id: "sess-x",
      duration_ms: 0,
      num_turns: 1,
      is_error: false,
    },
  };
}

const INVENTORY_JSON =
  '{"skills":[{"name":"alpha"}],"commands":[{"name":"beta"}]}';

// FR-L20: on the ACP transport the driver must (a) thread `transport`
// into the captured invoke so it routes through `invokeViaAcp`, and
// (b) suppress the schema `extraArgs` (those CLI flags have no ACP wire
// home and would trip AcpUnsupportedOptionError).
Deno.test("fetchInventoryViaInvoke threads transport and drops schema extraArgs on ACP", async () => {
  let received: Record<string, unknown> | undefined;
  const inv = await fetchInventoryViaInvoke(
    "claude",
    (opts) => {
      received = opts as unknown as Record<string, unknown>;
      return Promise.resolve(okResult(INVENTORY_JSON));
    },
    {
      processRegistry: new ProcessRegistry(),
      transport: "acp",
    } as FetchCapabilitiesOptions,
    { "--json-schema": "{}", "--max-turns": "1" },
  );
  assertEquals(received?.transport, "acp");
  assertEquals(received?.extraArgs, undefined);
  assertEquals(inv.skills, [{ name: "alpha" }]);
  assertEquals(inv.commands, [{ name: "beta" }]);
});

// FR-L20: the CLI transport (default / unset) keeps the schema flags so
// Claude / Codex still get structured-output enforcement.
Deno.test("fetchInventoryViaInvoke passes schema extraArgs through on CLI transport", async () => {
  let received: Record<string, unknown> | undefined;
  await fetchInventoryViaInvoke(
    "claude",
    (opts) => {
      received = opts as unknown as Record<string, unknown>;
      return Promise.resolve(okResult('{"skills":[],"commands":[]}'));
    },
    { processRegistry: new ProcessRegistry() } as FetchCapabilitiesOptions,
    { "--json-schema": "{}" },
  );
  assertEquals(received?.transport, undefined);
  assertEquals(received?.extraArgs, { "--json-schema": "{}" });
});

Deno.test("parseCapabilityInventoryResponse — pure minified JSON", () => {
  const json =
    '{"skills":[{"name":"simplify"},{"name":"skill-x","plugin":"p@v"}],' +
    '"commands":[{"name":"init"}]}';
  const inv = parseCapabilityInventoryResponse(json, "claude");
  assertEquals(inv.runtime, "claude");
  assertEquals(inv.skills, [
    { name: "simplify" },
    { name: "skill-x", plugin: "p@v" },
  ]);
  assertEquals(inv.commands, [{ name: "init" }]);
});

Deno.test("parseCapabilityInventoryResponse — string-array entries coerced", () => {
  const json = '{"skills":["a","b"],"commands":["c"]}';
  const inv = parseCapabilityInventoryResponse(json, "opencode");
  assertEquals(inv.skills, [{ name: "a" }, { name: "b" }]);
  assertEquals(inv.commands, [{ name: "c" }]);
});

Deno.test("parseCapabilityInventoryResponse — JSON inside markdown fence", () => {
  const raw = '```json\n{"skills":[{"name":"x"}],"commands":[]}\n```';
  const inv = parseCapabilityInventoryResponse(raw, "cursor");
  assertEquals(inv.skills, [{ name: "x" }]);
  assertEquals(inv.commands, []);
});

Deno.test("parseCapabilityInventoryResponse — JSON embedded in prose", () => {
  const raw =
    'Here is your inventory: {"skills":[{"name":"y"}],"commands":[]} Done.';
  const inv = parseCapabilityInventoryResponse(raw, "codex");
  assertEquals(inv.skills, [{ name: "y" }]);
  assertEquals(inv.commands, []);
});

Deno.test("parseCapabilityInventoryResponse — missing arrays default to empty", () => {
  const inv = parseCapabilityInventoryResponse("{}", "claude");
  assertEquals(inv.skills, []);
  assertEquals(inv.commands, []);
});

Deno.test("parseCapabilityInventoryResponse — invalid entries filtered out", () => {
  const raw = '{"skills":[{"name":"ok"},{"noname":true},42,null,{"name":""}],' +
    '"commands":[]}';
  const inv = parseCapabilityInventoryResponse(raw, "opencode");
  assertEquals(inv.skills, [{ name: "ok" }]);
});

Deno.test("parseCapabilityInventoryResponse — throws on unparseable text", () => {
  assertThrows(
    () => parseCapabilityInventoryResponse("not json at all", "claude"),
    Error,
    "could not parse JSON",
  );
});

Deno.test("parseCapabilityInventoryResponse — throws on non-object JSON", () => {
  assertThrows(
    () => parseCapabilityInventoryResponse("[1,2,3]", "claude"),
    Error,
    "not a JSON object",
  );
});
