import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  applyCodexEvent,
  buildCodexArgs,
  buildCodexHitlConfigArgs,
  codexItemToToolUseInfo,
  type CodexRunState,
  createCodexRunState,
  extractCodexHitlRequest,
  extractCodexOutput,
  findCodexSessionFile,
  formatCodexEventForOutput,
  permissionModeToCodexArgs,
} from "./process.ts";
import type { CodexExecEvent } from "./exec-events.ts";
import {
  CODEX_HITL_MCP_SERVER_NAME,
  CODEX_HITL_MCP_TOOL_NAME,
} from "./hitl-mcp.ts";
import type { RuntimeInvokeOptions } from "../runtime/types.ts";
import { defaultRegistry } from "../process-registry.ts";
import { join } from "@std/path";

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

Deno.test("buildCodexArgs — default permission mode does not emit sandbox/config overrides", () => {
  const args = buildCodexArgs(makeInvokeOpts({ permissionMode: "default" }));
  assertEquals(args.includes("--sandbox"), false);
  assertEquals(args.includes("--config"), false);
});

Deno.test("permissionModeToCodexArgs — plan maps to read-only + approval=never", () => {
  const args = permissionModeToCodexArgs("plan");
  assertEquals(args, [
    "--sandbox",
    "read-only",
    "--config",
    `approval_policy="never"`,
  ]);
});

Deno.test("permissionModeToCodexArgs — acceptEdits maps to workspace-write + approval=never", () => {
  const args = permissionModeToCodexArgs("acceptEdits");
  assertEquals(args, [
    "--sandbox",
    "workspace-write",
    "--config",
    `approval_policy="never"`,
  ]);
});

Deno.test("permissionModeToCodexArgs — Codex-native sandbox values pass through bare", () => {
  for (const mode of ["read-only", "workspace-write", "danger-full-access"]) {
    if (mode === "danger-full-access") continue; // exercised via bypassPermissions test
    assertEquals(permissionModeToCodexArgs(mode), ["--sandbox", mode]);
  }
});

Deno.test("permissionModeToCodexArgs — Codex-native approval values pass through as config", () => {
  for (const mode of ["never", "on-request", "on-failure", "untrusted"]) {
    assertEquals(permissionModeToCodexArgs(mode), [
      "--config",
      `approval_policy="${mode}"`,
    ]);
  }
});

Deno.test("permissionModeToCodexArgs — undefined and unrecognized modes return empty", () => {
  assertEquals(permissionModeToCodexArgs(undefined), []);
  assertEquals(permissionModeToCodexArgs("default"), []);
  assertEquals(permissionModeToCodexArgs("garbage"), []);
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
    makeInvokeOpts({ extraArgs: { "--add-dir": "/mnt/data" } }),
  );
  const addIdx = args.indexOf("--add-dir");
  assert(addIdx >= 0);
  assertEquals(args[addIdx + 1], "/mnt/data");
});

// --- applyCodexEvent + extractCodexOutput ---

function replay(
  events: Array<CodexExecEvent | Record<string, unknown>>,
): { state: CodexRunState; output: ReturnType<typeof extractCodexOutput> } {
  const state = createCodexRunState();
  for (const event of events) applyCodexEvent(event as CodexExecEvent, state);
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
  // Codex has no cost field — must be `undefined`, not `0`.
  assertEquals(output.total_cost_usd, undefined);
  assertEquals(output.duration_api_ms, undefined);
  assertEquals(state.inputTokens, 1234);
  assertEquals(state.cachedInputTokens, 128);
  assertEquals(state.outputTokens, 256);
  // Token counts surface via the usage telemetry block.
  assertEquals(output.usage, {
    input_tokens: 1234,
    output_tokens: 256,
    cached_tokens: 128,
  });
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

Deno.test("formatCodexEventForOutput — HITL mcp_tool_call emits hitl_request summary", () => {
  const line = formatCodexEventForOutput({
    type: "item.completed",
    item: {
      type: "mcp_tool_call",
      server: CODEX_HITL_MCP_SERVER_NAME,
      tool: CODEX_HITL_MCP_TOOL_NAME,
      status: "completed",
      arguments: { question: "Approve?" },
    },
  });
  assertEquals(line, "[stream] hitl_request: Approve?");
});

// --- buildCodexHitlConfigArgs ---

Deno.test("buildCodexHitlConfigArgs — no hitlConfig returns empty array", () => {
  assertEquals(buildCodexHitlConfigArgs(makeInvokeOpts()), []);
});

Deno.test("buildCodexHitlConfigArgs — single-arg builder emits only command override", () => {
  const args = buildCodexHitlConfigArgs(makeInvokeOpts({
    hitlConfig: {
      ask_script: "ask.sh",
      check_script: "check.sh",
      poll_interval: 60,
      timeout: 7200,
    },
    hitlMcpCommandBuilder: () => ["/usr/local/bin/myhitl"],
  }));
  assertEquals(args, [
    "--config",
    `mcp_servers.${CODEX_HITL_MCP_SERVER_NAME}.command="/usr/local/bin/myhitl"`,
  ]);
});

Deno.test("buildCodexHitlConfigArgs — multi-arg builder emits command + args TOML array", () => {
  const args = buildCodexHitlConfigArgs(makeInvokeOpts({
    hitlConfig: {
      ask_script: "ask.sh",
      check_script: "check.sh",
      poll_interval: 60,
      timeout: 7200,
    },
    hitlMcpCommandBuilder: () => ["deno", "run", "-A", "cli.ts", "--mcp"],
  }));
  assertEquals(args, [
    "--config",
    `mcp_servers.${CODEX_HITL_MCP_SERVER_NAME}.command="deno"`,
    "--config",
    `mcp_servers.${CODEX_HITL_MCP_SERVER_NAME}.args=["run", "-A", "cli.ts", "--mcp"]`,
  ]);
});

Deno.test("buildCodexHitlConfigArgs — missing builder with configured hitl throws", () => {
  assertThrows(
    () =>
      buildCodexHitlConfigArgs(makeInvokeOpts({
        hitlConfig: {
          ask_script: "ask.sh",
          check_script: "check.sh",
          poll_interval: 60,
          timeout: 7200,
        },
      })),
    Error,
    "hitlMcpCommandBuilder",
  );
});

Deno.test("buildCodexHitlConfigArgs — builder returning empty argv throws", () => {
  assertThrows(
    () =>
      buildCodexHitlConfigArgs(makeInvokeOpts({
        hitlConfig: {
          ask_script: "ask.sh",
          check_script: "check.sh",
          poll_interval: 60,
          timeout: 7200,
        },
        hitlMcpCommandBuilder: () => [],
      })),
    Error,
    "empty argv",
  );
});

// --- extractCodexHitlRequest ---

Deno.test("extractCodexHitlRequest — populated payload returns normalized request", () => {
  const req = extractCodexHitlRequest({
    question: "Continue?",
    header: "Approval needed",
    options: [
      { label: "yes" },
      { label: "no", description: "stop now" },
    ],
    multiSelect: false,
  });
  assertEquals(req?.question, "Continue?");
  assertEquals(req?.header, "Approval needed");
  assertEquals(req?.options?.length, 2);
  assertEquals(req?.options?.[1].description, "stop now");
  assertEquals(req?.multiSelect, false);
});

Deno.test("extractCodexHitlRequest — missing question returns undefined", () => {
  assertEquals(extractCodexHitlRequest({ header: "x" }), undefined);
  assertEquals(extractCodexHitlRequest({ question: "   " }), undefined);
  assertEquals(extractCodexHitlRequest(undefined), undefined);
});

// --- applyCodexEvent HITL detection ---

Deno.test("applyCodexEvent — HITL mcp_tool_call captured into state.hitlRequest", () => {
  const state = createCodexRunState();
  applyCodexEvent({
    type: "item.completed",
    item: {
      type: "mcp_tool_call",
      server: CODEX_HITL_MCP_SERVER_NAME,
      tool: CODEX_HITL_MCP_TOOL_NAME,
      status: "completed",
      arguments: { question: "Approve?" },
    },
  }, state);
  assertEquals(state.hitlRequest?.question, "Approve?");
});

Deno.test("applyCodexEvent — non-HITL mcp_tool_call leaves state.hitlRequest empty", () => {
  const state = createCodexRunState();
  applyCodexEvent({
    type: "item.completed",
    item: {
      type: "mcp_tool_call",
      server: "other",
      tool: "search",
      status: "completed",
      arguments: { q: "test" },
    },
  }, state);
  assertEquals(state.hitlRequest, undefined);
});

Deno.test("applyCodexEvent — only the first HITL request is captured", () => {
  const state = createCodexRunState();
  for (const q of ["first", "second"]) {
    applyCodexEvent({
      type: "item.completed",
      item: {
        type: "mcp_tool_call",
        server: CODEX_HITL_MCP_SERVER_NAME,
        tool: CODEX_HITL_MCP_TOOL_NAME,
        status: "completed",
        arguments: { question: q },
      },
    }, state);
  }
  assertEquals(state.hitlRequest?.question, "first");
});

Deno.test("extractCodexOutput — propagates hitlRequest into output", () => {
  const state = createCodexRunState();
  state.threadId = "thrd_h";
  state.hitlRequest = { question: "?" };
  const output = extractCodexOutput(state);
  assertEquals(output.hitl_request?.question, "?");
});

// --- codexItemToToolUseInfo ---

Deno.test("codexItemToToolUseInfo — command_execution maps to neutral tool info", () => {
  const info = codexItemToToolUseInfo({
    id: "x1",
    type: "command_execution",
    command: "ls -la",
    status: "completed",
    exit_code: 0,
  });
  assertEquals(info?.id, "x1");
  assertEquals(info?.name, "command_execution");
  assertEquals(info?.input.command, "ls -la");
});

Deno.test("codexItemToToolUseInfo — mcp_tool_call name combines server.tool", () => {
  const info = codexItemToToolUseInfo({
    id: "m1",
    type: "mcp_tool_call",
    server: "search",
    tool: "web",
    status: "completed",
    arguments: { q: "hi" },
  });
  assertEquals(info?.name, "search.web");
});

Deno.test("codexItemToToolUseInfo — agent_message returns undefined", () => {
  const info = codexItemToToolUseInfo({
    id: "a1",
    type: "agent_message",
    text: "hi",
  });
  assertEquals(info, undefined);
});

// --- findCodexSessionFile ---

Deno.test("findCodexSessionFile — locates rollout file by thread id", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "codex-sessions-" });
  try {
    const now = new Date();
    const y = now.getFullYear().toString().padStart(4, "0");
    const m = (now.getMonth() + 1).toString().padStart(2, "0");
    const d = now.getDate().toString().padStart(2, "0");
    const dayDir = join(tmp, y, m, d);
    await Deno.mkdir(dayDir, { recursive: true });
    const filename = `rollout-${y}-${m}-${d}T12-00-00-thrd_test.jsonl`;
    await Deno.writeTextFile(join(dayDir, filename), "{}\n");

    const found = await findCodexSessionFile("thrd_test", Date.now(), tmp);
    assertEquals(found, join(dayDir, filename));
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("findCodexSessionFile — empty thread id returns undefined", async () => {
  assertEquals(await findCodexSessionFile(""), undefined);
});

Deno.test("findCodexSessionFile — missing sessions dir returns undefined", async () => {
  assertEquals(
    await findCodexSessionFile("any", Date.now(), "/does/not/exist"),
    undefined,
  );
});

Deno.test("findCodexSessionFile — no matching file returns undefined", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "codex-sessions-" });
  try {
    const found = await findCodexSessionFile("thrd_missing", Date.now(), tmp);
    assertEquals(found, undefined);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

// FR-L25: reasoning effort — Codex maps the abstract enum 1:1 onto
// `--config model_reasoning_effort="<value>"`.

Deno.test("buildCodexArgs — reasoningEffort emits model_reasoning_effort config override", () => {
  for (const value of ["minimal", "low", "medium", "high"] as const) {
    const args = buildCodexArgs(makeInvokeOpts({ reasoningEffort: value }));
    const idx = args.findIndex((a, i) =>
      a === "--config" && args[i + 1] === `model_reasoning_effort="${value}"`
    );
    assert(idx >= 0, `Codex missing config override for ${value}`);
  }
});

Deno.test("buildCodexArgs — reasoningEffort precedes expandExtraArgs (caller can still override)", () => {
  const args = buildCodexArgs(
    makeInvokeOpts({
      reasoningEffort: "medium",
      extraArgs: { "--foo": "bar" },
    }),
  );
  const effortIdx = args.findIndex((a, i) =>
    a === "--config" && args[i + 1]?.startsWith("model_reasoning_effort")
  );
  const fooIdx = args.indexOf("--foo");
  assert(effortIdx >= 0 && fooIdx >= 0);
  assert(effortIdx < fooIdx, "expected reasoning-effort config before extras");
});
