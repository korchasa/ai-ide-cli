import { assert, assertEquals } from "@std/assert";
import { getAcpFront, listAcpFronts } from "./fronts.ts";

/** npm packages this package declares in its `deno.json` imports. */
async function declaredNpmPackages(): Promise<string[]> {
  const url = import.meta.resolve("../../deno.json");
  const cfg = JSON.parse(await Deno.readTextFile(new URL(url))) as {
    imports: Record<string, string>;
  };
  return Object.entries(cfg.imports)
    .filter(([, specifier]) => specifier.startsWith("npm:"))
    .map(([name]) => name);
}

Deno.test("Claude front runs its entry module under the current Deno binary", () => {
  const front = getAcpFront("claude");
  assertEquals(front.cmd, Deno.execPath());
  assertEquals(front.pilot, true);
  assertEquals(front.args.slice(0, 2), ["run", "-A"]);
  assert(
    front.args[2]?.endsWith("/runtime/acp/fronts/claude.ts"),
    `expected the claude entry module, got ${front.args[2]}`,
  );
  // No Node in the spawn path — the whole point of dropping `npx`.
  assertEquals(front.args.some((a) => a.includes("npx")), false);
});

Deno.test("codex front is piloted (npm self-contained, no local IDE required)", () => {
  const front = getAcpFront("codex");
  assertEquals(front.pilot, true);
  assertEquals(front.cmd, Deno.execPath());
  assertEquals(front.args.slice(0, 2), ["run", "-A"]);
  assert(
    front.args[2]?.endsWith("/runtime/acp/fronts/codex.ts"),
    `expected the codex entry module, got ${front.args[2]}`,
  );
});

// FR-L43: the deprecated `@zed-industries/codex-acp` must not come back —
// its embedded codex-core rejects current `config.toml` values.
Deno.test("the deprecated zed codex front is not declared anywhere", async () => {
  const declared = await declaredNpmPackages();
  assertEquals(declared.includes("@zed-industries/codex-acp"), false);
  // The successor must be there — it is what the entry module imports.
  assertEquals(declared.includes("@agentclientprotocol/codex-acp"), true);
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

// FR-L45: the Claude front spawns the same Claude Code binary, so the
// non-essential-traffic switch belongs on its launcher too.

Deno.test("claude front carries the non-essential-traffic switch", () => {
  const front = getAcpFront("claude");
  assertEquals(front.env?.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
});

Deno.test("no other front carries the Claude-only traffic switch", () => {
  for (const runtime of ["codex", "cursor", "opencode"] as const) {
    assertEquals(
      getAcpFront(runtime).env?.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
      undefined,
    );
  }
});
