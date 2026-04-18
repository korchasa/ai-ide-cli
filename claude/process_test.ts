import { assert, assertEquals } from "@std/assert";
import { buildClaudeArgs, invokeClaudeCli } from "./process.ts";
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
  const events: unknown[] = [];
  const args = buildClaudeArgs(
    makeOpts({ onEvent: (e) => events.push(e) }),
  );
  assertEquals(args.includes("--output-format"), true);
});

// --- claudeArgs map shape ---

Deno.test("buildClaudeArgs — map-shape claudeArgs expands value pairs", () => {
  const args = buildClaudeArgs(
    makeOpts({
      claudeArgs: { "--mcp-config": "/tmp/cfg.json", "--dangerously": "" },
    }),
  );
  const idx = args.indexOf("--mcp-config");
  assert(idx >= 0);
  assertEquals(args[idx + 1], "/tmp/cfg.json");
  assertEquals(args.includes("--dangerously"), true);
});

Deno.test("buildClaudeArgs — null value suppresses the flag", () => {
  const args = buildClaudeArgs(
    makeOpts({ claudeArgs: { "--dropped": null, "--kept": "value" } }),
  );
  assertEquals(args.includes("--dropped"), false);
  assertEquals(args.includes("--kept"), true);
});

Deno.test("buildClaudeArgs — passing a reserved flag throws", () => {
  let caught: Error | undefined;
  try {
    buildClaudeArgs(
      makeOpts({ claudeArgs: { "--output-format": "json" } }),
    );
  } catch (err) {
    caught = err as Error;
  }
  assert(caught !== undefined);
  assertEquals(
    caught?.message.includes(`"--output-format"`),
    true,
  );
});

// --- AbortSignal ---

Deno.test("invokeClaudeCli — aborted-before-start signal returns Aborted error without spawning", async () => {
  const controller = new AbortController();
  controller.abort("manual");
  const result = await invokeClaudeCli(
    makeOpts({ signal: controller.signal, maxRetries: 3 }),
  );
  assertEquals(result.error, "Aborted before start");
  assertEquals(result.output, undefined);
});
