import { assert, assertEquals } from "@std/assert";
import {
  applyCodexEvent,
  buildCodexArgs,
  type CodexRunState,
  createCodexRunState,
  extractCodexOutput,
  formatCodexEventForOutput,
} from "./process.ts";
import type { RuntimeInvokeOptions } from "../runtime/types.ts";

function makeInvokeOpts(
  overrides?: Partial<RuntimeInvokeOptions>,
): RuntimeInvokeOptions {
  return {
    taskPrompt: "do something",
    timeoutSeconds: 60,
    maxRetries: 1,
    retryDelaySeconds: 1,
    ...overrides,
  };
}

// --- buildCodexArgs ---

Deno.test("buildCodexArgs — fresh invocation starts with exec --experimental-json", () => {
  const args = buildCodexArgs(makeInvokeOpts());
  assertEquals(args[0], "exec");
  assertEquals(args[1], "--experimental-json");
});

Deno.test("buildCodexArgs — prompt is NOT appended to argv (stdin-only)", () => {
  const args = buildCodexArgs(makeInvokeOpts({ taskPrompt: "do something" }));
  assertEquals(args.includes("do something"), false);
});

Deno.test("buildCodexArgs — model flag is forwarded", () => {
  const args = buildCodexArgs(makeInvokeOpts({ model: "gpt-5-codex" }));
  assertEquals(args.includes("--model"), true);
  assertEquals(args.includes("gpt-5-codex"), true);
});

Deno.test("buildCodexArgs — cwd maps to --cd", () => {
  const args = buildCodexArgs(makeInvokeOpts({ cwd: "/tmp/project" }));
  const idx = args.indexOf("--cd");
  assert(idx >= 0);
  assertEquals(args[idx + 1], "/tmp/project");
});

Deno.test("buildCodexArgs — bypassPermissions maps to danger-full-access + approval_policy=never", () => {
  const args = buildCodexArgs(
    makeInvokeOpts({ permissionMode: "bypassPermissions" }),
  );
  const sandboxIdx = args.indexOf("--sandbox");
  assert(sandboxIdx >= 0);
  assertEquals(args[sandboxIdx + 1], "danger-full-access");
  assertEquals(args.includes("--config"), true);
  assertEquals(args.includes(`approval_policy="never"`), true);
});

Deno.test("buildCodexArgs — other permission modes do not emit sandbox/config overrides", () => {
  const args = buildCodexArgs(makeInvokeOpts({ permissionMode: "default" }));
  assertEquals(args.includes("--sandbox"), false);
  assertEquals(args.includes("--config"), false);
});

Deno.test("buildCodexArgs — resume appends `resume <id>` at the end", () => {
  const args = buildCodexArgs(
    makeInvokeOpts({ resumeSessionId: "thrd_abc123" }),
  );
  assertEquals(args.at(-2), "resume");
  assertEquals(args.at(-1), "thrd_abc123");
});

Deno.test("buildCodexArgs — extraArgs are passed through in order", () => {
  const args = buildCodexArgs(
    makeInvokeOpts({ extraArgs: ["--add-dir", "/mnt/data"] }),
  );
  const addIdx = args.indexOf("--add-dir");
  assert(addIdx >= 0);
  assertEquals(args[addIdx + 1], "/mnt/data");
});

// --- applyCodexEvent + extractCodexOutput ---

function replay(
  events: Array<Record<string, unknown>>,
): { state: CodexRunState; output: ReturnType<typeof extractCodexOutput> } {
  const state = createCodexRunState();
  for (const event of events) applyCodexEvent(event, state);
  return { state, output: extractCodexOutput(state) };
}

Deno.test("extractCodexOutput — happy path aggregates thread id, final response, usage, turns", () => {
  const { output, state } = replay([
    { type: "thread.started", thread_id: "thrd_xyz" },
    { type: "turn.started" },
    {
      type: "item.completed",
      item: { id: "m1", type: "agent_message", text: "Done." },
    },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 1234,
        cached_input_tokens: 128,
        output_tokens: 256,
      },
    },
  ]);

  assertEquals(output.runtime, "codex");
  assertEquals(output.session_id, "thrd_xyz");
  assertEquals(output.result, "Done.");
  assertEquals(output.num_turns, 1);
  assertEquals(output.is_error, false);
  assertEquals(output.total_cost_usd, 0);
  assertEquals(state.inputTokens, 1234);
  assertEquals(state.cachedInputTokens, 128);
  assertEquals(state.outputTokens, 256);
});

Deno.test("extractCodexOutput — last agent_message wins when multiple are emitted", () => {
  const { output } = replay([
    { type: "thread.started", thread_id: "thrd_a" },
    {
      type: "item.completed",
      item: { id: "m1", type: "agent_message", text: "first" },
    },
    {
      type: "item.completed",
      item: { id: "m2", type: "agent_message", text: "final" },
    },
    { type: "turn.completed", usage: {} },
  ]);

  assertEquals(output.result, "final");
});

Deno.test("extractCodexOutput — turn.failed marks is_error and surfaces message", () => {
  const { output } = replay([
    { type: "thread.started", thread_id: "thrd_fail" },
    { type: "turn.failed", error: { message: "model refused" } },
  ]);

  assertEquals(output.is_error, true);
  assertEquals(output.result, "model refused");
  assertEquals(output.session_id, "thrd_fail");
});

Deno.test("extractCodexOutput — top-level `error` event marks is_error", () => {
  const { output } = replay([
    { type: "thread.started", thread_id: "thrd_err" },
    { type: "error", message: "network down" },
  ]);

  assertEquals(output.is_error, true);
  assertEquals(output.result, "network down");
});

Deno.test("extractCodexOutput — non-agent_message items do not overwrite final response", () => {
  const { output } = replay([
    { type: "thread.started", thread_id: "thrd_n" },
    {
      type: "item.completed",
      item: { id: "r1", type: "reasoning", text: "thinking" },
    },
    {
      type: "item.completed",
      item: { id: "m1", type: "agent_message", text: "answer" },
    },
    {
      type: "item.completed",
      item: {
        id: "c1",
        type: "command_execution",
        command: "ls",
        status: "completed",
        aggregated_output: "",
      },
    },
    { type: "turn.completed", usage: {} },
  ]);

  assertEquals(output.result, "answer");
});

// --- formatCodexEventForOutput ---

Deno.test("formatCodexEventForOutput — thread.started emits init summary", () => {
  const line = formatCodexEventForOutput({
    type: "thread.started",
    thread_id: "thrd_abc",
  });
  assertEquals(line, "[stream] init thread=thrd_abc");
});

Deno.test("formatCodexEventForOutput — agent_message emits text preview", () => {
  const line = formatCodexEventForOutput({
    type: "item.completed",
    item: { type: "agent_message", text: "hello world" },
  });
  assertEquals(line, "[stream] text: hello world");
});

Deno.test("formatCodexEventForOutput — long text is truncated at 120 chars", () => {
  const longText = "A".repeat(200);
  const line = formatCodexEventForOutput({
    type: "item.completed",
    item: { type: "agent_message", text: longText },
  });
  assertEquals(line, `[stream] text: ${"A".repeat(120)}…`);
});

Deno.test("formatCodexEventForOutput — semi-verbose suppresses reasoning and tool items", () => {
  const reasoning = formatCodexEventForOutput(
    {
      type: "item.completed",
      item: { type: "reasoning", text: "thinking" },
    },
    "semi-verbose",
  );
  const exec = formatCodexEventForOutput(
    {
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "ls",
        status: "completed",
      },
    },
    "semi-verbose",
  );
  const text = formatCodexEventForOutput(
    {
      type: "item.completed",
      item: { type: "agent_message", text: "hi" },
    },
    "semi-verbose",
  );
  assertEquals(reasoning, "");
  assertEquals(exec, "");
  assertEquals(text, "[stream] text: hi");
});

Deno.test("formatCodexEventForOutput — turn.completed emits token usage", () => {
  const line = formatCodexEventForOutput({
    type: "turn.completed",
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cached_input_tokens: 10,
    },
  });
  assertEquals(line, "[stream] turn.completed in=100 out=50 cached=10");
});

Deno.test("formatCodexEventForOutput — turn.failed emits error message", () => {
  const line = formatCodexEventForOutput({
    type: "turn.failed",
    error: { message: "boom" },
  });
  assertEquals(line, "[stream] turn.failed: boom");
});
