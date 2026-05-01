import { assert, assertEquals } from "@std/assert";
import {
  buildCursorArgs,
  extractCursorOutput,
  formatCursorEventForOutput,
  invokeCursorCli,
} from "./process.ts";
import type {
  RuntimeInvokeOptions,
  RuntimeToolUseInfo,
} from "../runtime/types.ts";

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
    duration_ms: 500,
    num_turns: 0,
  });

  assertEquals(output.runtime, "cursor");
  assertEquals(output.result, "Model not found");
  assertEquals(output.is_error, true);
  // Cursor emits no cost field — must surface as `undefined`, not `0`.
  assertEquals(output.total_cost_usd, undefined);
});

Deno.test("extractCursorOutput — missing fields default to safe values", () => {
  const output = extractCursorOutput({ type: "result", subtype: "success" });

  assertEquals(output.runtime, "cursor");
  assertEquals(output.result, "");
  assertEquals(output.session_id, "");
  // No cost / api duration reported by Cursor → undefined (FR-L2 honest signal).
  assertEquals(output.total_cost_usd, undefined);
  assertEquals(output.duration_ms, 0);
  assertEquals(output.duration_api_ms, undefined);
  assertEquals(output.num_turns, 0);
  assertEquals(output.is_error, false);
  assertEquals(output.usage, undefined);
});

Deno.test("extractCursorOutput — populates usage from event.usage token block", () => {
  const output = extractCursorOutput({
    type: "result",
    subtype: "success",
    result: "ok",
    session_id: "chat_u",
    duration_ms: 100,
    is_error: false,
    usage: {
      inputTokens: 200,
      outputTokens: 80,
      cacheReadTokens: 50,
    },
  });

  assertEquals(output.usage, {
    input_tokens: 200,
    output_tokens: 80,
    cached_tokens: 50,
  });
  assertEquals(output.total_cost_usd, undefined);
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

// --- FR-L30: onToolUseObserved + cursorHooks via PATH-stubbed cursor ---

const STUB_NDJSON = [
  {
    type: "system",
    subtype: "init",
    session_id: "sess-1",
    cwd: "/tmp",
    model: "Auto",
    permissionMode: "default",
  },
  {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
    session_id: "sess-1",
    model_call_id: "mc-1",
  },
  {
    type: "tool_call",
    subtype: "started",
    call_id: "call-a",
    tool_call: { readToolCall: { args: { path: "/tmp/foo.txt" } } },
    session_id: "sess-1",
  },
  {
    type: "tool_call",
    subtype: "completed",
    call_id: "call-a",
    tool_call: { readToolCall: { result: { content: "hi" } } },
    session_id: "sess-1",
  },
  {
    type: "result",
    subtype: "success",
    result: "done",
    session_id: "sess-1",
    duration_ms: 100,
    is_error: false,
  },
]
  .map((e) => JSON.stringify(e))
  .join("\n");

async function withStubCursorEmittingNdjson<T>(
  ndjson: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "cursor-process-stub-" });
  const stubPath = `${dir}/cursor`;
  // Write the NDJSON to a file, then have the stub `cat` it on every
  // `cursor agent -p ...` invocation so the test can spec the events
  // independently of the bash heredoc.
  const ndjsonPath = `${dir}/events.ndjson`;
  await Deno.writeTextFile(ndjsonPath, ndjson + "\n");
  await Deno.writeTextFile(
    stubPath,
    `#!/usr/bin/env bash
cat ${ndjsonPath}
exit 0
`,
  );
  await Deno.chmod(stubPath, 0o755);
  const prevPath = Deno.env.get("PATH") ?? "";
  Deno.env.set("PATH", `${dir}:${prevPath}`);
  try {
    return await fn(dir);
  } finally {
    Deno.env.set("PATH", prevPath);
    try {
      await Deno.remove(dir, { recursive: true });
    } catch { /* best effort */ }
  }
}

Deno.test("invokeCursorCli — onToolUseObserved fires once per tool_call/started (FR-L30)", async () => {
  await withStubCursorEmittingNdjson(STUB_NDJSON, async () => {
    const observed: RuntimeToolUseInfo[] = [];
    const { output, error } = await invokeCursorCli({
      taskPrompt: "do something",
      timeoutSeconds: 30,
      maxRetries: 1,
      retryDelaySeconds: 1,
      onToolUseObserved: (info) => {
        observed.push(info);
        return "allow";
      },
    });
    assertEquals(error, undefined);
    assertEquals(output?.is_error, false);
    assertEquals(observed.length, 1);
    assertEquals(observed[0].runtime, "cursor");
    assertEquals(observed[0].id, "call-a");
    assertEquals(observed[0].name, "read");
    assertEquals(observed[0].input, { path: "/tmp/foo.txt" });
    assertEquals(observed[0].turn, 1);
  });
});

Deno.test("invokeCursorCli — onToolUseObserved 'abort' synthesizes permission_denials (FR-L30)", async () => {
  await withStubCursorEmittingNdjson(STUB_NDJSON, async () => {
    const { output, error } = await invokeCursorCli({
      taskPrompt: "do something",
      timeoutSeconds: 30,
      maxRetries: 1,
      retryDelaySeconds: 1,
      onToolUseObserved: () => "abort",
    });
    // Denial path returns a synthesized output, not an error string.
    assertEquals(
      error,
      "Cursor CLI returned error: Aborted by onToolUseObserved callback",
    );
    assertEquals(output?.is_error, true);
    assertEquals(output?.runtime, "cursor");
    assertEquals(output?.permission_denials?.length, 1);
    assertEquals(output?.permission_denials?.[0].tool_name, "read");
    assertEquals(
      (output?.permission_denials?.[0].tool_input as { id: string }).id,
      "call-a",
    );
  });
});

Deno.test("invokeCursorCli — cursorHooks.onAssistant fires per assistant event (FR-L30)", async () => {
  await withStubCursorEmittingNdjson(STUB_NDJSON, async () => {
    let assistantHits = 0;
    let initHit = false;
    let resultHit = false;
    const { output, error } = await invokeCursorCli({
      taskPrompt: "do something",
      timeoutSeconds: 30,
      maxRetries: 1,
      retryDelaySeconds: 1,
      cursorHooks: {
        onInit: () => {
          initHit = true;
        },
        onAssistant: (ev) => {
          assistantHits += 1;
          assert(Array.isArray(ev.message?.content));
        },
        onResult: () => {
          resultHit = true;
        },
      },
    });
    assertEquals(error, undefined);
    assertEquals(output?.is_error, false);
    assertEquals(initHit, true);
    assertEquals(assistantHits, 1);
    assertEquals(resultHit, true);
  });
});

Deno.test("invokeCursorCli — onToolUseObserved is not called when capability not used", async () => {
  // Sanity check: no callback → no error path.
  await withStubCursorEmittingNdjson(STUB_NDJSON, async () => {
    const { output, error } = await invokeCursorCli({
      taskPrompt: "do something",
      timeoutSeconds: 30,
      maxRetries: 1,
      retryDelaySeconds: 1,
    });
    assertEquals(error, undefined);
    assertEquals(output?.is_error, false);
    assertEquals(output?.session_id, "sess-1");
  });
});
