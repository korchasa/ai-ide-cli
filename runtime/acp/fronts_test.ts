import { assert, assertEquals } from "@std/assert";
import { getAcpFront, listAcpFronts } from "./fronts.ts";

/** Package → version as declared in this package's `deno.json` imports. */
async function declaredImportVersions(): Promise<Record<string, string>> {
  const url = import.meta.resolve("../../deno.json");
  const cfg = JSON.parse(await Deno.readTextFile(new URL(url))) as {
    imports: Record<string, string>;
  };
  const out: Record<string, string> = {};
  for (const [name, specifier] of Object.entries(cfg.imports)) {
    const at = specifier.lastIndexOf("@");
    if (specifier.startsWith("npm:") && at > "npm:".length) {
      out[name] = specifier.slice(at + 1);
    }
  }
  return out;
}

Deno.test("Claude front runs its entry module under the current Deno binary", () => {
  const front = getAcpFront("claude");
  assertEquals(front.cmd, Deno.execPath());
  assertEquals(front.versionPin, "0.77.0");
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
  assertEquals(front.versionPin, "1.11.0");
  assertEquals(front.cmd, Deno.execPath());
  assertEquals(front.args.slice(0, 2), ["run", "-A"]);
  assert(
    front.args[2]?.endsWith("/runtime/acp/fronts/codex.ts"),
    `expected the codex entry module, got ${front.args[2]}`,
  );
});

// The entry modules resolve their package through `deno.json` imports, so
// that map — not `versionPin` — decides what actually spawns. Guard the
// diagnostic copy against the drift that already happened once: the map
// sat on 0.37.0 + the deprecated @zed-industries/codex-acp@0.15.0 while
// the registry pinned 0.62.0 / 1.1.7.
Deno.test("versionPin matches the version deno.json actually resolves", async () => {
  const declared = await declaredImportVersions();
  assertEquals(
    getAcpFront("claude").versionPin,
    declared["@agentclientprotocol/claude-agent-acp"],
  );
  assertEquals(
    getAcpFront("codex").versionPin,
    declared["@agentclientprotocol/codex-acp"],
  );
});

// FR-L43: the deprecated `@zed-industries/codex-acp` must not come back —
// its embedded codex-core rejects current `config.toml` values.
Deno.test("the deprecated zed codex front is not declared anywhere", async () => {
  const declared = await declaredImportVersions();
  assertEquals(declared["@zed-industries/codex-acp"], undefined);
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
