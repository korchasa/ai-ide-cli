import { assert, assertEquals, assertThrows } from "@std/assert";
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

// --- Tool filter (FR-L24) ---

Deno.test("buildClaudeArgs — allowedTools single tool emits two argv tokens", () => {
  const args = buildClaudeArgs(makeOpts({ allowedTools: ["Read"] }));
  const idx = args.indexOf("--allowedTools");
  assert(idx >= 0);
  assertEquals(args[idx + 1], "Read");
  assertEquals(args.includes("--disallowedTools"), false);
});

Deno.test("buildClaudeArgs — allowedTools multi-tool comma-joined into exactly two argv tokens", () => {
  const args = buildClaudeArgs(
    makeOpts({ allowedTools: ["Read", "Bash(git *)", "Edit"] }),
  );
  const idx = args.indexOf("--allowedTools");
  assert(idx >= 0);
  // Key invariant: exactly two tokens (flag + one comma-joined value),
  // not four tokens (flag + three space-separated values).
  assertEquals(args[idx + 1], "Read,Bash(git *),Edit");
  // The next tokens after the value must NOT be the remaining tool names.
  const next = args[idx + 2];
  assertEquals(next === "Bash(git *)" || next === "Edit", false);
});

Deno.test("buildClaudeArgs — disallowedTools emits --disallowedTools with comma join", () => {
  const args = buildClaudeArgs(
    makeOpts({ disallowedTools: ["Bash(git push *)", "Edit"] }),
  );
  const idx = args.indexOf("--disallowedTools");
  assert(idx >= 0);
  assertEquals(args[idx + 1], "Bash(git push *),Edit");
  assertEquals(args.includes("--allowedTools"), false);
});

Deno.test("buildClaudeArgs — resume path still emits --allowedTools", () => {
  const args = buildClaudeArgs(
    makeOpts({
      resumeSessionId: "ses_abc",
      allowedTools: ["Read"],
    }),
  );
  const idx = args.indexOf("--allowedTools");
  assert(idx >= 0);
  assertEquals(args[idx + 1], "Read");
});

Deno.test("buildClaudeArgs — both typed fields set throws", () => {
  assertThrows(
    () =>
      buildClaudeArgs(
        makeOpts({
          allowedTools: ["Read"],
          disallowedTools: ["Bash"],
        }),
      ),
    Error,
    "mutually exclusive",
  );
});

Deno.test("buildClaudeArgs — typed field + --allowedTools in extraArgs throws", () => {
  assertThrows(
    () =>
      buildClaudeArgs(
        makeOpts({
          allowedTools: ["Read"],
          claudeArgs: { "--allowedTools": "Read" },
        }),
      ),
    Error,
    'extraArgs key "--allowedTools"',
  );
});

Deno.test("buildClaudeArgs — typed field + --allowed-tools in extraArgs throws", () => {
  assertThrows(
    () =>
      buildClaudeArgs(
        makeOpts({
          allowedTools: ["Read"],
          claudeArgs: { "--allowed-tools": "Read" },
        }),
      ),
    Error,
    'extraArgs key "--allowed-tools"',
  );
});

Deno.test("buildClaudeArgs — typed field + --tools in extraArgs throws", () => {
  assertThrows(
    () =>
      buildClaudeArgs(
        makeOpts({
          allowedTools: ["Read"],
          claudeArgs: { "--tools": "default" },
        }),
      ),
    Error,
    'extraArgs key "--tools"',
  );
});

Deno.test("buildClaudeArgs — legacy path (extraArgs --allowedTools only, no typed field) still works", () => {
  const args = buildClaudeArgs(
    makeOpts({ claudeArgs: { "--allowedTools": "Read,Grep" } }),
  );
  const idx = args.indexOf("--allowedTools");
  assert(idx >= 0);
  assertEquals(args[idx + 1], "Read,Grep");
});

Deno.test("buildClaudeArgs — empty allowedTools array throws", () => {
  assertThrows(
    () => buildClaudeArgs(makeOpts({ allowedTools: [] })),
    Error,
    "non-empty",
  );
});

Deno.test("buildClaudeArgs — empty-string member in allowedTools throws", () => {
  assertThrows(
    () => buildClaudeArgs(makeOpts({ allowedTools: [""] })),
    Error,
    "non-empty strings",
  );
});

Deno.test("buildClaudeArgs — empty disallowedTools array throws", () => {
  assertThrows(
    () => buildClaudeArgs(makeOpts({ disallowedTools: [] })),
    Error,
    "non-empty",
  );
});
