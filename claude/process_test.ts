import { assertEquals } from "@std/assert";
import { buildClaudeArgs } from "./process.ts";
import type { ClaudeInvokeOptions } from "./process.ts";

function makeOpts(
  overrides?: Partial<ClaudeInvokeOptions>,
): ClaudeInvokeOptions {
  return {
    taskPrompt: "do something",
    timeoutSeconds: 60,
    maxRetries: 1,
    retryDelaySeconds: 1,
    ...overrides,
  };
}

// --- env field type-level acceptance ---

Deno.test("ClaudeInvokeOptions — env field accepted by buildClaudeArgs without affecting args", () => {
  const args = buildClaudeArgs(
    makeOpts({ env: { CLAUDE_CONFIG_DIR: "/tmp/cleanroom" } }),
  );
  // env is not in CLI args — it goes to Deno.Command env
  assertEquals(args.includes("CLAUDE_CONFIG_DIR"), false);
  assertEquals(args.includes("/tmp/cleanroom"), false);
  // standard flags still present
  assertEquals(args.includes("--output-format"), true);
});

// --- onEvent field type-level acceptance ---

Deno.test("ClaudeInvokeOptions — onEvent field accepted without affecting args", () => {
  const events: Record<string, unknown>[] = [];
  const args = buildClaudeArgs(
    makeOpts({ onEvent: (e) => events.push(e) }),
  );
  assertEquals(args.includes("--output-format"), true);
});
