import { assertEquals } from "@std/assert";
import {
  buildCursorArgs,
  extractCursorOutput,
  formatCursorEventForOutput,
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

// --- buildCursorArgs ---

Deno.test("buildCursorArgs — fresh invocation includes agent -p, model, output-format, trust", () => {
  const args = buildCursorArgs(
    makeInvokeOpts({
      model: "claude-4.6-sonnet",
      extraArgs: { "--sandbox": "disabled" },
    }),
  );

  assertEquals(args[0], "agent");
  assertEquals(args[1], "-p");
  assertEquals(args.includes("--model"), true);
  assertEquals(args.includes("claude-4.6-sonnet"), true);
  assertEquals(args.includes("--output-format"), true);
  assertEquals(args.includes("stream-json"), true);
  assertEquals(args.includes("--trust"), true);
  assertEquals(args.includes("--sandbox"), true);
  assertEquals(args.at(-1), "do something");
});

Deno.test("buildCursorArgs — bypassPermissions adds --yolo", () => {
  const args = buildCursorArgs(
    makeInvokeOpts({ permissionMode: "bypassPermissions" }),
  );

  assertEquals(args.includes("--yolo"), true);
  assertEquals(args.at(-1), "do something");
});

Deno.test("buildCursorArgs — no permissionMode omits --yolo", () => {
  const args = buildCursorArgs(makeInvokeOpts());

  assertEquals(args.includes("--yolo"), false);
});

Deno.test("buildCursorArgs — resume uses --resume and omits model", () => {
  const args = buildCursorArgs(
    makeInvokeOpts({
      resumeSessionId: "chat_abc123",
      model: "claude-4.6-sonnet",
    }),
  );

  assertEquals(args.includes("--resume"), true);
  assertEquals(args.includes("chat_abc123"), true);
  assertEquals(args.includes("--model"), false);
});

Deno.test("buildCursorArgs — resume with bypassPermissions still includes --yolo", () => {
  const args = buildCursorArgs(
    makeInvokeOpts({
      resumeSessionId: "chat_abc123",
      permissionMode: "bypassPermissions",
    }),
  );

  assertEquals(args.includes("--yolo"), true);
  assertEquals(args.includes("--resume"), true);
});

// --- extractCursorOutput ---

Deno.test("extractCursorOutput — success result event maps to normalized output", () => {
  const output = extractCursorOutput({
    type: "result",
    subtype: "success",
    result: "Task completed.",
    session_id: "chat_xyz",
    total_cost_usd: 0.0512,
    duration_ms: 45000,
    duration_api_ms: 38000,
    num_turns: 12,
    is_error: false,
  });

  assertEquals(output.runtime, "cursor");
  assertEquals(output.result, "Task completed.");
  assertEquals(output.session_id, "chat_xyz");
  assertEquals(output.total_cost_usd, 0.0512);
  assertEquals(output.duration_ms, 45000);
  assertEquals(output.duration_api_ms, 38000);
  assertEquals(output.num_turns, 12);
  assertEquals(output.is_error, false);
});

Deno.test("extractCursorOutput — error result event maps is_error correctly", () => {
  const output = extractCursorOutput({
    type: "result",
    subtype: "error",
    result: "Model not found",
    session_id: "chat_err",
    total_cost_usd: 0,
    duration_ms: 500,
    num_turns: 0,
  });

  assertEquals(output.runtime, "cursor");
  assertEquals(output.result, "Model not found");
  assertEquals(output.is_error, true);
});

Deno.test("extractCursorOutput — missing fields default to safe values", () => {
  const output = extractCursorOutput({ type: "result", subtype: "success" });

  assertEquals(output.runtime, "cursor");
  assertEquals(output.result, "");
  assertEquals(output.session_id, "");
  assertEquals(output.total_cost_usd, 0);
  assertEquals(output.duration_ms, 0);
  assertEquals(output.duration_api_ms, 0);
  assertEquals(output.num_turns, 0);
  assertEquals(output.is_error, false);
});

// --- formatCursorEventForOutput ---

Deno.test("formatCursorEventForOutput — system init event emits model info", () => {
  const line = formatCursorEventForOutput({
    type: "system",
    subtype: "init",
    model: "claude-4.6-sonnet",
  });
  assertEquals(line, "[stream] init model=claude-4.6-sonnet");
});

Deno.test("formatCursorEventForOutput — text block emits stream summary", () => {
  const line = formatCursorEventForOutput({
    type: "assistant",
    message: { content: [{ type: "text", text: "hello world" }] },
  });
  assertEquals(line, "[stream] text: hello world");
});

Deno.test("formatCursorEventForOutput — tool_use block emits tool name", () => {
  const line = formatCursorEventForOutput({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", name: "Edit", input: {} }],
    },
  });
  assertEquals(line, "[stream] tool: Edit");
});

Deno.test("formatCursorEventForOutput — semi-verbose suppresses tool_use", () => {
  const line = formatCursorEventForOutput(
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "thinking..." },
          { type: "tool_use", name: "Bash", input: {} },
        ],
      },
    },
    "semi-verbose",
  );
  assertEquals(line, "[stream] text: thinking...");
});

Deno.test("formatCursorEventForOutput — result event emits cost and duration", () => {
  const line = formatCursorEventForOutput({
    type: "result",
    subtype: "success",
    duration_ms: 12345,
    total_cost_usd: 0.0512,
  });
  assertEquals(line, "[stream] result: success (12345ms, $0.0512)");
});

Deno.test("formatCursorEventForOutput — long text is truncated at 120 chars", () => {
  const longText = "A".repeat(200);
  const line = formatCursorEventForOutput({
    type: "assistant",
    message: { content: [{ type: "text", text: longText }] },
  });
  assertEquals(line, `[stream] text: ${"A".repeat(120)}…`);
});
