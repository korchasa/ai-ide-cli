import { assertEquals } from "@std/assert";
import {
  buildOpenCodeArgs,
  buildOpenCodeConfigContent,
  extractOpenCodeOutput,
  formatOpenCodeEventForOutput,
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

Deno.test("buildOpenCodeArgs — fresh invocation includes run, model, agent, format json", () => {
  const args = buildOpenCodeArgs(
    makeInvokeOpts({
      agent: "builder",
      model: "anthropic/claude-sonnet-4-5",
      extraArgs: ["--variant", "high"],
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

Deno.test("extractOpenCodeOutput — tool_use HITL event maps to hitl_request", () => {
  const output = extractOpenCodeOutput([
    JSON.stringify({
      type: "step_start",
      timestamp: 1000,
      sessionID: "ses_123",
      part: { type: "step-start" },
    }),
    JSON.stringify({
      type: "tool_use",
      timestamp: 1200,
      sessionID: "ses_123",
      part: {
        tool: "hitl_request_human_input",
        state: {
          status: "completed",
          input: {
            question: "Which deployment target?",
            header: "HITL",
            options: [{ label: "prod" }, { label: "staging" }],
          },
          output: '{"ok":true}',
        },
      },
    }),
  ]);

  assertEquals(output.session_id, "ses_123");
  assertEquals(output.hitl_request?.question, "Which deployment target?");
  assertEquals(output.hitl_request?.header, "HITL");
  assertEquals(output.hitl_request?.options?.length, 2);
  assertEquals(output.is_error, false);
});

Deno.test("formatOpenCodeEventForOutput — text event emits stream summary", () => {
  const line = formatOpenCodeEventForOutput({
    type: "text",
    part: { type: "text", text: "hello" },
  });
  assertEquals(line, "[stream] text: hello");
});

Deno.test("buildOpenCodeConfigContent — injects local MCP config when HITL configured", () => {
  const raw = buildOpenCodeConfigContent(
    makeInvokeOpts({
      hitlConfig: {
        ask_script: "ask.sh",
        check_script: "check.sh",
        poll_interval: 60,
        timeout: 120,
      },
      hitlMcpCommandBuilder: () => ["deno", "run", "-A", "./cli.ts", "--mcp"],
    }),
  );
  const config = JSON.parse(raw ?? "{}") as {
    mcp?: Record<
      string,
      { type?: string; command?: string[]; enabled?: boolean }
    >;
  };

  assertEquals(config.mcp?.hitl?.type, "local");
  assertEquals(config.mcp?.hitl?.enabled, true);
  assertEquals(config.mcp?.hitl?.command, [
    "deno",
    "run",
    "-A",
    "./cli.ts",
    "--mcp",
  ]);
});

Deno.test("buildOpenCodeConfigContent — throws when HITL is set but no hitlMcpCommandBuilder", () => {
  let caught: Error | undefined;
  try {
    buildOpenCodeConfigContent(
      makeInvokeOpts({
        hitlConfig: {
          ask_script: "ask.sh",
          check_script: "check.sh",
          poll_interval: 60,
          timeout: 120,
        },
      }),
    );
  } catch (err) {
    caught = err as Error;
  }
  assertEquals(caught !== undefined, true);
  assertEquals(
    caught?.message.includes("hitlMcpCommandBuilder"),
    true,
  );
});

Deno.test("buildOpenCodeConfigContent — returns undefined when HITL not configured", () => {
  const raw = buildOpenCodeConfigContent(makeInvokeOpts());
  assertEquals(raw, undefined);
});
