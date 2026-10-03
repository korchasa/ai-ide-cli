import { assert, assertEquals, assertThrows } from "@std/assert";
import { VALID_PERMISSION_MODES } from "../../claude/permission-mode.ts";
import {
  ACP_CLIENT_NAME,
  ACP_UNSUPPORTED_INVOKE_OPTIONS,
  ACP_UNSUPPORTED_SESSION_OPTIONS,
  buildInitializeParams,
  buildSessionNewParams,
  buildTurnEndEvent,
  codexThreadStartEnv,
  collectDegradedOptions,
  collectUnsupportedOptions,
  mapSessionUpdate,
  pickConfigForModel,
  pickConfigForReasoningEffort,
  pickModeForPermissionMode,
} from "./mapping.ts";
import { SYNTHETIC_TURN_END } from "../types.ts";

Deno.test("ACP_UNSUPPORTED_INVOKE_OPTIONS pins the invoke surface set", () => {
  // FR-L19: `resumeSessionId` is NOT in this tuple — it moved to a
  // post-`initialize` capability gate inside `handshake` (loadSession is
  // only known after the front advertises its agentCapabilities).
  assertEquals(ACP_UNSUPPORTED_INVOKE_OPTIONS, [
    "agent",
    "systemPromptFile",
    "extraArgs",
    "strictMcpConfig",
    "streamStallTimeoutSeconds",
    "streamLogPath",
    "verbosity",
    "onOutput",
  ]);
});

Deno.test("ACP_UNSUPPORTED_SESSION_OPTIONS pins the session surface set", () => {
  // FR-L19: `resumeSessionId` moved to the post-init capability gate.
  assertEquals(ACP_UNSUPPORTED_SESSION_OPTIONS, [
    "agent",
    "extraArgs",
    "strictMcpConfig",
  ]);
});

Deno.test("collectUnsupportedOptions skips resumeSessionId and returns only [strictMcpConfig] on invoke", () => {
  // FR-L19: empty extraArgs is skipped; resumeSessionId is no longer an
  // entry-time unsupported field (capability-gated post-init), so only
  // strictMcpConfig surfaces here.
  assertEquals(
    collectUnsupportedOptions("invoke", {
      resumeSessionId: "x",
      strictMcpConfig: true,
      extraArgs: {},
    }),
    ["strictMcpConfig"],
  );
});

Deno.test("collectUnsupportedOptions treats null and empty extraArgs as unset", () => {
  assertEquals(
    collectUnsupportedOptions("invoke", {
      agent: null,
      extraArgs: {},
    }),
    [],
  );
});

Deno.test("collectUnsupportedOptions surfaces empty-string systemPromptFile as set", () => {
  // Presence-based: empty string encodes caller intent, so it counts.
  assertEquals(
    collectUnsupportedOptions("invoke", { systemPromptFile: "" }),
    ["systemPromptFile"],
  );
});

Deno.test("collectUnsupportedOptions flags non-empty extraArgs", () => {
  assertEquals(
    collectUnsupportedOptions("invoke", { extraArgs: { "--foo": "bar" } }),
    ["extraArgs"],
  );
});

Deno.test("collectUnsupportedOptions session list is a strict subset (streamLogPath not flagged)", () => {
  assertEquals(
    collectUnsupportedOptions("session", { streamLogPath: "/tmp/x" }),
    [],
  );
});

Deno.test("buildInitializeParams declines fs and terminal", () => {
  const params = buildInitializeParams();
  assertEquals(params.protocolVersion, 1);
  assertEquals(params.clientCapabilities.fs.readTextFile, false);
  assertEquals(params.clientCapabilities.fs.writeTextFile, false);
  assertEquals(params.clientCapabilities.terminal, false);
  assertEquals(params.clientInfo.name, ACP_CLIENT_NAME);
});

Deno.test("buildSessionNewParams renders stdio mcpServers as name/env array", () => {
  const params = buildSessionNewParams("claude", {
    cwd: "/tmp/acp",
    mcpServers: {
      hello: {
        type: "stdio",
        command: "/bin/true",
        args: ["--noop"],
        env: { A: "1" },
      },
    },
  });
  assertEquals(params.cwd, "/tmp/acp");
  assertEquals(params.mcpServers.length, 1);
  const m = params.mcpServers[0];
  assertEquals(m.name, "hello");
  assertEquals(m.type, "stdio");
  assertEquals(m.command, "/bin/true");
  assertEquals(m.args, ["--noop"]);
  assertEquals(m.env, [{ name: "A", value: "1" }]);
});

Deno.test("buildSessionNewParams validates mcpServers (empty record throws)", () => {
  assertThrows(
    () =>
      buildSessionNewParams("claude", {
        cwd: "/tmp/acp",
        mcpServers: {},
      }),
    Error,
  );
});

Deno.test("buildSessionNewParams renders http mcpServers as url/headers array", () => {
  const params = buildSessionNewParams("claude", {
    cwd: "/tmp/acp",
    mcpServers: {
      remote: {
        type: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer x" },
      },
    },
  });
  const m = params.mcpServers[0];
  assertEquals(m.type, "http");
  assertEquals(m.url, "https://example.com/mcp");
  assertEquals(m.headers, [{ name: "Authorization", value: "Bearer x" }]);
});

// The Claude ACP front declares Claude Code's own permission-mode ids
// (verified in 0.62.0 `acp-agent.js:buildAvailableModes` and 0.77.0
// `session-mode.js`), and `VALID_PERMISSION_MODES` in
// `claude/permission-mode.ts` holds the same four names, so every
// neutral mode is already a literal id match. `auto` is front-only —
// a caller can still pass it through as an ACP-native id.
const CLAUDE_ACP_MODES = [
  { id: "default" },
  { id: "acceptEdits" },
  { id: "plan" },
  { id: "auto" },
  { id: "bypassPermissions" },
];

Deno.test("pickModeForPermissionMode passes every Claude permission mode through", () => {
  for (const mode of VALID_PERMISSION_MODES) {
    assertEquals(
      pickModeForPermissionMode("claude", CLAUDE_ACP_MODES, mode),
      mode,
    );
  }
});

Deno.test("pickModeForPermissionMode passes a front-only Claude mode id through", () => {
  assertEquals(
    pickModeForPermissionMode("claude", CLAUDE_ACP_MODES, "auto"),
    "auto",
  );
});

Deno.test("pickModeForPermissionMode yields undefined when the front declares no match", () => {
  assertEquals(
    pickModeForPermissionMode("claude", [{ id: "plan" }], "bypassPermissions"),
    undefined,
  );
});

// FR-L44: `@agentclientprotocol/codex-acp` declares three presets —
// `read-only` / `agent` / `agent-full-access` (ids verified in 1.1.7, 1.7.0
// and 1.11.0 `AgentMode`). None of them matches a neutral permission-mode
// literal, so without a codex table `session/set_mode` was skipped and the
// session silently stayed on the front's default workspace-write preset.
const CODEX_ACP_MODES = [
  { id: "read-only" },
  { id: "agent" },
  { id: "agent-full-access" },
];

// The fourth preset front 2.x adds (verified in codex-acp 2.0.1 by reading
// `session/new`). A front that declares it is the case FR-L44 prefers.
const CODEX_ACP_MODES_2X = [
  { id: "read-only" },
  { id: "workspace-write" },
  { id: "agent" },
  { id: "agent-full-access" },
];

Deno.test("pickModeForPermissionMode maps codex bypassPermissions to agent-full-access", () => {
  const mode = pickModeForPermissionMode(
    "codex",
    CODEX_ACP_MODES,
    "bypassPermissions",
  );
  assertEquals(mode, "agent-full-access");
});

Deno.test("pickModeForPermissionMode maps codex neutral modes onto declared presets", () => {
  const pick = (permissionMode: string) =>
    pickModeForPermissionMode("codex", CODEX_ACP_MODES, permissionMode);
  assertEquals(pick("plan"), "read-only");
  assertEquals(pick("acceptEdits"), "agent");
});

Deno.test("pickModeForPermissionMode maps codex-native sandbox modes onto declared presets", () => {
  const pick = (permissionMode: string) =>
    pickModeForPermissionMode("codex", CODEX_ACP_MODES, permissionMode);
  assertEquals(pick("read-only"), "read-only");
  // This front declares no `workspace-write`, so `agent` is the only
  // preset left to answer the request.
  assertEquals(pick("workspace-write"), "agent");
  assertEquals(pick("danger-full-access"), "agent-full-access");
});

Deno.test("pickModeForPermissionMode prefers the workspace-write preset where the front declares it", () => {
  const pick = (permissionMode: string) =>
    pickModeForPermissionMode("codex", CODEX_ACP_MODES_2X, permissionMode);
  // `agent` grants more than a workspace-write sandbox asked for: it
  // leaves the workspace and reaches the network unprompted whenever the
  // front judges the step safe.
  assertEquals(pick("workspace-write"), "workspace-write");
  assertEquals(pick("acceptEdits"), "workspace-write");
  // The other three sandboxes are unaffected by the extra preset.
  assertEquals(pick("read-only"), "read-only");
  assertEquals(pick("plan"), "read-only");
  assertEquals(pick("bypassPermissions"), "agent-full-access");
  assertEquals(pick("danger-full-access"), "agent-full-access");
});

Deno.test("pickModeForPermissionMode leaves codex approval-only modes unmapped", () => {
  // `never` / `on-request` carry no sandbox decision, and the front
  // declares no matching id — nothing to set_mode.
  assertEquals(
    pickModeForPermissionMode("codex", CODEX_ACP_MODES, "never"),
    undefined,
  );
});

Deno.test("pickModeForPermissionMode falls back to direct id match", () => {
  // Caller passes the ACP-native mode id directly; runtime is non-claude.
  const mode = pickModeForPermissionMode(
    "codex",
    [{ id: "custom-mode" }],
    "custom-mode",
  );
  assertEquals(mode, "custom-mode");
});

Deno.test("pickModeForPermissionMode returns undefined when mode is unknown", () => {
  const mode = pickModeForPermissionMode(
    "claude",
    [{ id: "code" }],
    "definitely-not-declared",
  );
  assertEquals(mode, undefined);
});

Deno.test("pickConfigForReasoningEffort matches declared thought_level value", () => {
  const picked = pickConfigForReasoningEffort(
    "claude",
    [
      {
        id: "cfg-thinking",
        category: "thought_level",
        values: [{ id: "low" }, { id: "medium" }, { id: "high" }],
      },
    ],
    { reasoningEffort: "medium" },
  );
  assertEquals(picked, { configId: "cfg-thinking", value: "medium" });
});

Deno.test("pickConfigForReasoningEffort returns undefined when category missing", () => {
  const picked = pickConfigForReasoningEffort(
    "claude",
    [{ id: "cfg-model", category: "model", values: [{ id: "sonnet" }] }],
    { reasoningEffort: "medium" },
  );
  assertEquals(picked, undefined);
});

Deno.test("pickConfigForModel resolves declared model id", () => {
  const picked = pickConfigForModel(
    [
      {
        id: "cfg-model",
        category: "model",
        values: [{ id: "sonnet" }, { id: "opus" }],
      },
    ],
    "opus",
  );
  assertEquals(picked, { configId: "cfg-model", value: "opus" });
});

Deno.test("collectDegradedOptions flags ACP-lossy fields", () => {
  const degraded = collectDegradedOptions({
    allowedTools: ["Read"],
    disallowedTools: ["Bash"],
    settingSources: ["project"],
    systemPrompt: "Be terse.",
  });
  const fields = degraded.map((d) => d.field).sort();
  assertEquals(fields, [
    "allowedTools",
    "disallowedTools",
    "settingSources",
    "systemPrompt",
  ]);
});

Deno.test("mapSessionUpdate carries method and params into the neutral envelope", () => {
  const ev = mapSessionUpdate("claude", "session/update", {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "hi" },
  });
  assertEquals(ev.runtime, "claude");
  assertEquals(ev.type, "session/update");
  assertEquals(ev.raw.sessionUpdate, "agent_message_chunk");
});

Deno.test("buildTurnEndEvent emits SYNTHETIC_TURN_END with synthetic flag", () => {
  const ev = buildTurnEndEvent("claude", "end_turn");
  assertEquals(ev.type, SYNTHETIC_TURN_END);
  assertEquals(ev.synthetic, true);
  assertEquals(ev.raw.stopReason, "end_turn");
  assert(ev.synthetic === true);
});

// FR-L47: the Codex front opens its thread on codex's default model and
// only records the requested one; the first turn then switches and codex
// repeats its whole base instructions in a `<model_switch>` message.
Deno.test("codexThreadStartEnv puts the model into CODEX_CONFIG", () => {
  assertEquals(
    codexThreadStartEnv({ A: "1" }, undefined, "gpt-6-luna"),
    { A: "1", CODEX_CONFIG: '{"model":"gpt-6-luna"}' },
  );
});

Deno.test("codexThreadStartEnv keeps the caller's other CODEX_CONFIG keys, the model wins", () => {
  const env = {
    CODEX_CONFIG: '{"model":"gpt-6.1-sol","approval_policy":"never"}',
  };
  assertEquals(
    JSON.parse(codexThreadStartEnv(env, undefined, "gpt-6-luna").CODEX_CONFIG),
    { model: "gpt-6-luna", approval_policy: "never" },
  );
});

Deno.test("codexThreadStartEnv reads an inherited CODEX_CONFIG when the caller passes none", () => {
  assertEquals(
    JSON.parse(
      codexThreadStartEnv({}, '{"profile":"ci"}', "gpt-6-luna").CODEX_CONFIG,
    ),
    { profile: "ci", model: "gpt-6-luna" },
  );
});

Deno.test("codexThreadStartEnv leaves the env alone without a model", () => {
  const env = { CODEX_CONFIG: "not even json" };
  assertEquals(codexThreadStartEnv(env, undefined, undefined), env);
});

Deno.test("codexThreadStartEnv refuses a CODEX_CONFIG that is not a JSON object", () => {
  for (const bad of ["not json", "[1]", "null", '"s"']) {
    assertThrows(
      () => codexThreadStartEnv({ CODEX_CONFIG: bad }, undefined, "gpt-6-luna"),
      Error,
      "CODEX_CONFIG",
    );
  }
});
