import { assertEquals, assertThrows } from "@std/assert";
import { parseCapabilityInventoryResponse } from "./capabilities.ts";

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
