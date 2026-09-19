import { assertStringIncludes, assertThrows } from "@std/assert";
import { ProcessRegistry } from "../../process-registry.ts";
import { missingFrontExecutableError, spawnClient } from "./handshake.ts";

Deno.test("spawnClient names the missing executable instead of `os error 2`", () => {
  const cmd = "ai-ide-cli-no-such-front-binary";
  const err = assertThrows(
    () =>
      spawnClient({
        runtime: "claude",
        processRegistry: new ProcessRegistry(),
        acpFront: { cmd, args: ["acp"], pilot: true },
      }),
    Error,
  );
  assertStringIncludes(err.message, "claude");
  assertStringIncludes(err.message, cmd);
  assertStringIncludes(err.message, "not found on PATH");
});

Deno.test("missingFrontExecutableError adds the install-Deno hint only for the bare `deno`", () => {
  const bare = missingFrontExecutableError("codex", "deno").message;
  assertStringIncludes(bare, "codex");
  assertStringIncludes(bare, "`deno` not found on PATH");
  assertStringIncludes(bare, "compiled");
  assertStringIncludes(bare, "acpFront");

  const other = missingFrontExecutableError("opencode", "opencode").message;
  assertStringIncludes(other, "`opencode` not found on PATH");
  if (other.includes("compiled")) {
    throw new Error(`hint must not appear for a non-deno executable: ${other}`);
  }
});
