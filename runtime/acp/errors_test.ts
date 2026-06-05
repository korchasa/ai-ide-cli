import { assert, assertEquals } from "@std/assert";
import { AcpUnsupportedOptionError } from "./errors.ts";

Deno.test("AcpUnsupportedOptionError carries runtime and field list", () => {
  const err = new AcpUnsupportedOptionError("codex", [
    "resumeSessionId",
    "strictMcpConfig",
  ]);
  assertEquals(err.runtime, "codex");
  assertEquals(err.fields, ["resumeSessionId", "strictMcpConfig"]);
  assertEquals(err.name, "AcpUnsupportedOptionError");
  assert(err instanceof Error);
  // Message names every field plus the transport hint.
  assert(err.message.includes("acp(codex)"), err.message);
  assert(err.message.includes("resumeSessionId"), err.message);
  assert(err.message.includes("strictMcpConfig"), err.message);
  assert(err.message.includes('transport: "cli"'), err.message);
});
