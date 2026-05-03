import { assert, assertEquals } from "@std/assert";
import { defaultRegistry } from "../process-registry.ts";
import {
  buildOpenCodeArgs,
  exportOpenCodeTranscript,
  extractOpenCodeOutput,
  formatOpenCodeEventForOutput,
  invokeOpenCodeCli,
  type OpenCodeToolUseEvent,
  openCodeToolUseInfo,
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
    processRegistry: defaultRegistry,
    ...overrides,
  };
}

Deno.test("buildOpenCodeArgs — fresh invocation includes run, model, agent, format json", () => {
  const args = buildOpenCodeArgs(
    makeInvokeOpts({
      agent: "builder",
      model: "anthropic/claude-sonnet-4-5",
      extraArgs: { "--variant": "high" },
    }),
  );

  assertEquals(args.slice(0, 1), ["run"]);
  assertEquals(args.includes("--model"), true);
  assertEquals(args.includes("--agent"), true);
  assertEquals(args.includes("--format"), true);
  assertEquals(args.includes("json"), true);
  assertEquals(args.includes("--variant"), true);
  assertEquals(args.at(-1), "do something");
});

Deno.test("buildOpenCodeArgs — bypassPermissions adds --dangerously-skip-permissions", () => {
  const args = buildOpenCodeArgs(
    makeInvokeOpts({ permissionMode: "bypassPermissions" }),
  );

  assertEquals(args.includes("--dangerously-skip-permissions"), true);
  assertEquals(args.at(-1), "do something");
});

Deno.test("buildOpenCodeArgs — no permissionMode omits --dangerously-skip-permissions", () => {
  const args = buildOpenCodeArgs(makeInvokeOpts());

  assertEquals(args.includes("--dangerously-skip-permissions"), false);
});

Deno.test("buildOpenCodeArgs — resume with bypassPermissions still includes --dangerously-skip-permissions", () => {
  const args = buildOpenCodeArgs(
    makeInvokeOpts({
      resumeSessionId: "ses_123",
      permissionMode: "bypassPermissions",
    }),
  );

  assertEquals(args.includes("--dangerously-skip-permissions"), true);
  assertEquals(args.includes("--session"), true);
});

Deno.test("buildOpenCodeArgs — emits `--` separator before the positional prompt so leading `-`/`---` is not parsed as a flag", () => {
  // Regression: when the task prompt begins with `-` (typical when an agent
  // markdown file with YAML frontmatter `---` is concatenated as a system
  // prompt), opencode's yargs parser interprets the prompt as an unknown
  // long flag, prints usage, and exits with code 1. The `--` separator
  // forces yargs to treat everything after it as positional.
  const prompt = "---\nname: agent\n---\nbody";
  const args = buildOpenCodeArgs(makeInvokeOpts({ taskPrompt: prompt }));
  const sep = args.indexOf("--");
  assert(sep >= 0, "expected `--` separator before the positional prompt");
  assertEquals(args[sep + 1], prompt);
  assertEquals(args.at(-1), prompt);
});

Deno.test("buildOpenCodeArgs — resume uses --session and omits model and agent", () => {
  const args = buildOpenCodeArgs(
    makeInvokeOpts({
      resumeSessionId: "ses_123",
      agent: "builder",
      model: "anthropic/claude-sonnet-4-5",
    }),
  );

  assertEquals(args.includes("--session"), true);
  assertEquals(args.includes("ses_123"), true);
  assertEquals(args.includes("--model"), false);
  assertEquals(args.includes("--agent"), false);
});

Deno.test("extractOpenCodeOutput — success stream maps to normalized runtime output", () => {
  const output = extractOpenCodeOutput([
    JSON.stringify({
      type: "step_start",
      timestamp: 1000,
      sessionID: "ses_123",
      part: { type: "step-start" },
    }),
    JSON.stringify({
      type: "text",
      timestamp: 1200,
      sessionID: "ses_123",
      part: { type: "text", text: "Hello" },
    }),
    JSON.stringify({
      type: "text",
      timestamp: 1300,
      sessionID: "ses_123",
      part: { type: "text", text: "world" },
    }),
    JSON.stringify({
      type: "step_finish",
      timestamp: 1700,
      sessionID: "ses_123",
      part: {
        type: "step-finish",
        reason: "stop",
        cost: 0.125,
      },
    }),
  ]);

  assertEquals(output.runtime, "opencode");
  assertEquals(output.session_id, "ses_123");
  assertEquals(output.result, "Hello\nworld");
  assertEquals(output.total_cost_usd, 0.125);
  assertEquals(output.duration_ms, 700);
  assertEquals(output.is_error, false);
  // OpenCode reports cost — mirror it on the runtime-neutral usage block.
  assertEquals(output.usage, { cost_usd: 0.125 });
  // OpenCode does NOT split server vs. client time — leave undefined.
  assertEquals(output.duration_api_ms, undefined);
});

Deno.test("extractOpenCodeOutput — error event maps to is_error output", () => {
  const output = extractOpenCodeOutput([
    JSON.stringify({
      type: "error",
      timestamp: 2000,
      sessionID: "ses_999",
      error: {
        name: "UnknownError",
        data: { message: "Model not found: nope/nope." },
      },
    }),
  ]);

  assertEquals(output.runtime, "opencode");
  assertEquals(output.session_id, "ses_999");
  assertEquals(output.result, "Model not found: nope/nope.");
  assertEquals(output.is_error, true);
});

Deno.test("formatOpenCodeEventForOutput — text event emits stream summary", () => {
  const line = formatOpenCodeEventForOutput({
    type: "text",
    part: { type: "text", text: "hello" },
  });
  assertEquals(line, "[stream] text: hello");
});

// --- FR-L16: observed-tool-use hook + --------------------------------------

Deno.test("openCodeToolUseInfo — extracts id/name/input from completed tool event", () => {
  const event: OpenCodeToolUseEvent = {
    type: "tool_use",
    part: {
      tool: "bash",
      id: "tool_abc",
      state: {
        status: "completed",
        input: { command: "ls" },
      },
    },
  };
  const info = openCodeToolUseInfo(event);
  assertEquals(info?.id, "tool_abc");
  assertEquals(info?.name, "bash");
  assertEquals(info?.input, { command: "ls" });
});

Deno.test("openCodeToolUseInfo — skips events without a usable id", () => {
  const event: OpenCodeToolUseEvent = {
    type: "tool_use",
    part: { tool: "bash", state: { status: "completed" } },
  };
  assertEquals(openCodeToolUseInfo(event), undefined);
});

Deno.test("openCodeToolUseInfo — falls back to callID when id missing", () => {
  const event: OpenCodeToolUseEvent = {
    type: "tool_use",
    part: { tool: "edit", callID: "call_42", state: { status: "completed" } },
  };
  const info = openCodeToolUseInfo(event);
  assertEquals(info?.id, "call_42");
  assertEquals(info?.name, "edit");
});

// --- Transcript export helper ---------------------------------------------

Deno.test("exportOpenCodeTranscript — returns empty result for empty sessionId", async () => {
  const result = await exportOpenCodeTranscript("");
  assertEquals(result, {});
});

/**
 * Install a shell-script `opencode` stub on PATH that dispatches on the
 * first arg: `run` → stream JSON events, `export` → echo canned transcript.
 *
 * The stub reads `STUB_RUN_SCRIPT` env var (path to a file) to decide what
 * to emit during `run`. Other subcommands get a trivial success response.
 */
async function withStubOpenCodeBinary<T>(
  runScriptLines: string[],
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "opencode-run-stub-" });
  const binPath = `${dir}/opencode`;
  const runOutPath = `${dir}/run-output.ndjson`;
  await Deno.writeTextFile(runOutPath, runScriptLines.join("\n") + "\n");
  await Deno.writeTextFile(
    binPath,
    `#!/usr/bin/env bash
case "$1" in
  run)
    cat "${runOutPath}"
    exit 0
    ;;
  export)
    printf '{"sessionID":"%s","events":["ok"]}' "$2"
    exit 0
    ;;
  *)
    echo "unknown subcommand: $1" >&2
    exit 2
    ;;
esac
`,
  );
  await Deno.chmod(binPath, 0o755);
  const prevPath = Deno.env.get("PATH") ?? "";
  Deno.env.set("PATH", `${dir}:${prevPath}`);
  try {
    return await fn(dir);
  } finally {
    Deno.env.set("PATH", prevPath);
    try {
      await Deno.remove(dir, { recursive: true });
    } catch {
      // best-effort cleanup
    }
  }
}

Deno.test("exportOpenCodeTranscript — writes stdout of opencode export to a temp file", async () => {
  await withStubOpenCodeBinary([], async () => {
    const result = await exportOpenCodeTranscript("ses_xyz");
    assert(result.path);
    const text = await Deno.readTextFile(result.path);
    assert(text.includes(`"sessionID":"ses_xyz"`));
    await Deno.remove(result.path);
  });
});

// --- FR-L35 mcp injection ---

Deno.test(
  "invokeOpenCodeCli — non-empty OPENCODE_CONFIG_CONTENT collision throws",
  async () => {
    let threw = false;
    try {
      await invokeOpenCodeCli(makeInvokeOpts({
        mcpServers: { hitl: { type: "stdio", command: "deno" } },
        env: { OPENCODE_CONFIG_CONTENT: '{"existing":true}' },
      }));
    } catch (err) {
      threw = true;
      assert(
        (err as Error).message.includes("collides with typed mcpServers"),
        `unexpected: ${(err as Error).message}`,
      );
    }
    assert(threw, "expected env collision to throw");
  },
);

// --- invokeOpenCodeCli: tool-use observation + transcript ------------------

Deno.test(
  "invokeOpenCodeCli — onToolUseObserved abort synthesizes permission_denials",
  async () => {
    await withStubOpenCodeBinary(
      [
        JSON.stringify({
          type: "step_start",
          sessionID: "ses_abort",
          timestamp: 1000,
          part: { type: "step-start" },
        }),
        JSON.stringify({
          type: "tool_use",
          sessionID: "ses_abort",
          timestamp: 1100,
          part: {
            tool: "bash",
            id: "tool_1",
            state: { status: "completed", input: { command: "rm -rf /" } },
          },
        }),
        JSON.stringify({
          type: "step_finish",
          sessionID: "ses_abort",
          timestamp: 1200,
          part: { type: "step-finish", reason: "stop", cost: 0 },
        }),
      ],
      async () => {
        const observed: string[] = [];
        const result = await invokeOpenCodeCli(makeInvokeOpts({
          onToolUseObserved: (info) => {
            observed.push(info.name);
            return "abort";
          },
        }));
        assert(result.output);
        assertEquals(result.output!.is_error, true);
        assertEquals(result.output!.runtime, "opencode");
        assertEquals(result.output!.permission_denials?.length, 1);
        assertEquals(
          result.output!.permission_denials?.[0].tool_name,
          "bash",
        );
        assertEquals(observed, ["bash"]);
      },
    );
  },
);

Deno.test(
  "invokeOpenCodeCli — populates transcript_path via opencode export",
  async () => {
    await withStubOpenCodeBinary(
      [
        JSON.stringify({
          type: "step_start",
          sessionID: "ses_ok",
          timestamp: 1000,
          part: { type: "step-start" },
        }),
        JSON.stringify({
          type: "text",
          sessionID: "ses_ok",
          timestamp: 1100,
          part: { type: "text", text: "hello" },
        }),
        JSON.stringify({
          type: "step_finish",
          sessionID: "ses_ok",
          timestamp: 1200,
          part: { type: "step-finish", reason: "stop", cost: 0.01 },
        }),
      ],
      async () => {
        const result = await invokeOpenCodeCli(makeInvokeOpts());
        assert(result.output);
        assertEquals(result.output!.session_id, "ses_ok");
        assertEquals(result.output!.is_error, false);
        assert(result.output!.transcript_path);
        const text = await Deno.readTextFile(result.output!.transcript_path!);
        assert(text.includes(`"sessionID":"ses_ok"`));
        await Deno.remove(result.output!.transcript_path!);
      },
    );
  },
);

Deno.test(
  "invokeOpenCodeCli — onToolUseObserved allow does not abort",
  async () => {
    await withStubOpenCodeBinary(
      [
        JSON.stringify({
          type: "step_start",
          sessionID: "ses_allow",
          timestamp: 1000,
          part: { type: "step-start" },
        }),
        JSON.stringify({
          type: "tool_use",
          sessionID: "ses_allow",
          timestamp: 1100,
          part: {
            tool: "read",
            id: "tool_r",
            state: { status: "completed", input: { path: "a.ts" } },
          },
        }),
        JSON.stringify({
          type: "text",
          sessionID: "ses_allow",
          timestamp: 1150,
          part: { type: "text", text: "done" },
        }),
        JSON.stringify({
          type: "step_finish",
          sessionID: "ses_allow",
          timestamp: 1200,
          part: { type: "step-finish", reason: "stop", cost: 0 },
        }),
      ],
      async () => {
        let called = 0;
        const result = await invokeOpenCodeCli(makeInvokeOpts({
          onToolUseObserved: () => {
            called += 1;
            return "allow";
          },
        }));
        assert(result.output);
        assertEquals(result.output!.is_error, false);
        assertEquals(result.output!.permission_denials, undefined);
        assertEquals(called, 1);
        if (result.output!.transcript_path) {
          await Deno.remove(result.output!.transcript_path);
        }
      },
    );
  },
);

// FR-L25: reasoning effort → --variant pass-through.

Deno.test("buildOpenCodeArgs — reasoningEffort emits --variant with the abstract value", () => {
  for (const value of ["minimal", "low", "medium", "high"] as const) {
    const args = buildOpenCodeArgs(makeInvokeOpts({ reasoningEffort: value }));
    const idx = args.indexOf("--variant");
    assert(idx >= 0, `missing --variant for ${value}`);
    assertEquals(args[idx + 1], value);
  }
});
