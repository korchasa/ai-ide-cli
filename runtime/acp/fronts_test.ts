import { assertEquals } from "@std/assert";
import { getAcpFront, listAcpFronts } from "./fronts.ts";

Deno.test("getAcpFront returns Claude launcher with pinned version", () => {
  const front = getAcpFront("claude");
  assertEquals(front.cmd, "npx");
  assertEquals(front.versionPin, "0.37.0");
  assertEquals(front.pilot, true);
  assertEquals(
    front.args.includes("@agentclientprotocol/claude-agent-acp@0.37.0"),
    true,
  );
});

Deno.test("codex front is piloted (npm self-contained, no local IDE required)", () => {
  const front = getAcpFront("codex");
  assertEquals(front.pilot, true);
  assertEquals(front.versionPin, "0.15.0");
  assertEquals(front.cmd, "npx");
});

Deno.test("opencode front is piloted (wraps local `opencode acp` binary)", () => {
  const front = getAcpFront("opencode");
  assertEquals(front.pilot, true);
  assertEquals(front.cmd, "opencode");
  assertEquals(front.args.includes("acp"), true);
});

Deno.test("cursor front stays pilot:false (needs local cursor-agent binary)", () => {
  const front = getAcpFront("cursor");
  assertEquals(front.pilot, false);
});

Deno.test("listAcpFronts returns frozen registry", () => {
  const fronts = listAcpFronts();
  assertEquals(Object.isFrozen(fronts), true);
  assertEquals(Object.keys(fronts).sort(), [
    "claude",
    "codex",
    "cursor",
    "opencode",
  ]);
});
