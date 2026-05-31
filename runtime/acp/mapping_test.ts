import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  ACP_CLIENT_NAME,
  buildInitializeParams,
  buildSessionNewParams,
  buildTurnEndEvent,
  collectDegradedOptions,
  mapSessionUpdate,
  pickConfigForModel,
  pickConfigForReasoningEffort,
  pickModeForPermissionMode,
} from "./mapping.ts";
import { SYNTHETIC_TURN_END } from "../types.ts";

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

Deno.test("pickModeForPermissionMode picks Claude's plan→plan mapping when declared", () => {
  const mode = pickModeForPermissionMode(
    "claude",
    [{ id: "plan" }, { id: "code" }],
    "plan",
  );
  assertEquals(mode, "plan");
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
