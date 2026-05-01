import { assert, assertEquals } from "@std/assert";
import {
  type ClaudeAssistantEvent,
  type ClaudeResultEvent,
  type ClaudeStreamEvent,
  type ClaudeSystemEvent,
  extractClaudeOutput,
  FileReadTracker,
  parseClaudeStreamEvent,
  processStreamEvent,
  type StreamProcessorState,
  type ToolUseObservedDecision,
} from "./stream.ts";

function makeState(
  overrides?: Partial<StreamProcessorState>,
): StreamProcessorState {
  return {
    turnCount: 0,
    resultEvent: undefined,
    tracker: new FileReadTracker(),
    logFile: undefined,
    encoder: new TextEncoder(),
    ...overrides,
  };
}

// --- parseClaudeStreamEvent ---

Deno.test("parseClaudeStreamEvent — parses valid JSON with `type` field", () => {
  const event = parseClaudeStreamEvent(
    JSON.stringify({ type: "system", subtype: "init", model: "m" }),
  );
  assert(event !== null);
  assertEquals(event!.type, "system");
});

Deno.test("parseClaudeStreamEvent — returns null on malformed JSON", () => {
  assertEquals(parseClaudeStreamEvent("{invalid"), null);
  assertEquals(parseClaudeStreamEvent(""), null);
  assertEquals(parseClaudeStreamEvent("   "), null);
});

Deno.test("parseClaudeStreamEvent — returns null when type is missing", () => {
  assertEquals(
    parseClaudeStreamEvent(JSON.stringify({ foo: "bar" })),
    null,
  );
});

Deno.test("parseClaudeStreamEvent — returns null for non-object JSON (array, primitive)", () => {
  assertEquals(parseClaudeStreamEvent("[1,2,3]"), null);
  assertEquals(parseClaudeStreamEvent("42"), null);
  assertEquals(parseClaudeStreamEvent("null"), null);
});

// --- onEvent callback ---

Deno.test("processStreamEvent — onEvent receives every raw event before filtering", async () => {
  const received: ClaudeStreamEvent[] = [];
  const state = makeState({ onEvent: (e) => received.push(e) });

  const initEvent: ClaudeSystemEvent = {
    type: "system",
    subtype: "init",
    model: "test-model",
  };
  const assistantEvent: ClaudeAssistantEvent = {
    type: "assistant",
    message: { content: [{ type: "text", text: "hello" }] },
  };
  const resultEvent: ClaudeResultEvent = {
    type: "result",
    subtype: "success",
    result: "done",
    session_id: "s1",
    total_cost_usd: 0.01,
    duration_ms: 100,
    duration_api_ms: 80,
    num_turns: 1,
    is_error: false,
  };

  await processStreamEvent(initEvent, state);
  await processStreamEvent(assistantEvent, state);
  await processStreamEvent(resultEvent, state);

  assertEquals(received.length, 3);
  assertEquals(received[0].type, "system");
  assertEquals(received[1].type, "assistant");
  assertEquals(received[2].type, "result");
});

Deno.test("processStreamEvent — works without onEvent (backward compat)", async () => {
  const state = makeState();
  await processStreamEvent(
    { type: "system", subtype: "init", model: "m" },
    state,
  );
  assertEquals(state.turnCount, 0);
});

// --- Typed lifecycle hooks ---

Deno.test("processStreamEvent — typed hooks fire BEFORE state mutation", async () => {
  const observedTurn: number[] = [];
  const state = makeState({
    hooks: {
      onAssistant: () => {
        observedTurn.push(state.turnCount);
      },
    },
  });
  await processStreamEvent(
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }] },
    },
    state,
  );
  // Hook observed turnCount=0 (pre-increment), actual count after is 1.
  assertEquals(observedTurn, [0]);
  assertEquals(state.turnCount, 1);
});

Deno.test("processStreamEvent — dispatch order: onEvent → typed hook → internal mutations", async () => {
  const log: string[] = [];
  const state = makeState({
    onEvent: () => log.push("onEvent"),
    hooks: {
      onAssistant: () => log.push("typed"),
    },
  });
  await processStreamEvent(
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "x" }] },
    },
    state,
  );
  assertEquals(log[0], "onEvent");
  assertEquals(log[1], "typed");
});

Deno.test("processStreamEvent — onInit only fires on system event, onResult only on result", async () => {
  const log: string[] = [];
  const state = makeState({
    hooks: {
      onInit: () => log.push("init"),
      onAssistant: () => log.push("asst"),
      onResult: () => log.push("res"),
    },
  });
  await processStreamEvent(
    { type: "system", subtype: "init", model: "m" },
    state,
  );
  await processStreamEvent(
    { type: "assistant", message: { content: [] } },
    state,
  );
  await processStreamEvent(
    { type: "result", subtype: "success", session_id: "s" },
    state,
  );
  assertEquals(log, ["init", "asst", "res"]);
});

// --- Observed-tool-use hook ---

Deno.test("processStreamEvent — onToolUseObserved receives tool info verbatim", async () => {
  const received: Array<{ id: string; name: string; turn: number }> = [];
  const state = makeState({
    onToolUseObserved: (info) => {
      received.push({ id: info.id, name: info.name, turn: info.turn });
      return "allow";
    },
  });
  await processStreamEvent(
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: "Read",
            input: { file_path: "/a" },
          },
        ],
      },
    },
    state,
  );
  assertEquals(received.length, 1);
  assertEquals(received[0].id, "tu_1");
  assertEquals(received[0].name, "Read");
  // Turn index is 1 (current turn during which the block was observed).
  assertEquals(received[0].turn, 1);
});

Deno.test("processStreamEvent — onToolUseObserved 'abort' triggers abortController and records denied", async () => {
  const abortController = new AbortController();
  const state = makeState({
    abortController,
    onToolUseObserved: () => "abort",
  });
  await processStreamEvent(
    {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "tu_2", name: "Bash", input: {} },
        ],
      },
    },
    state,
  );
  assertEquals(state.denied?.tool, "Bash");
  assertEquals(state.denied?.id, "tu_2");
  assertEquals(abortController.signal.aborted, true);
});

Deno.test("processStreamEvent — async 'abort' callback aborts cleanly", async () => {
  const abortController = new AbortController();
  const state = makeState({
    abortController,
    onToolUseObserved: async (): Promise<ToolUseObservedDecision> => {
      await new Promise((r) => setTimeout(r, 5));
      return "abort";
    },
  });
  await processStreamEvent(
    {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "tu_3", name: "Edit", input: {} },
        ],
      },
    },
    state,
  );
  assertEquals(state.denied?.tool, "Edit");
  assertEquals(abortController.signal.aborted, true);
});

Deno.test("processStreamEvent — 'allow' decision is a no-op", async () => {
  const abortController = new AbortController();
  const state = makeState({
    abortController,
    onToolUseObserved: () => "allow",
  });
  await processStreamEvent(
    {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "tu_4", name: "Bash", input: {} }],
      },
    },
    state,
  );
  assertEquals(state.denied, undefined);
  assertEquals(abortController.signal.aborted, false);
});

// --- extractClaudeOutput ---

Deno.test("extractClaudeOutput — populates usage from result.usage tokens + cost", () => {
  const event: ClaudeResultEvent = {
    type: "result",
    subtype: "success",
    result: "ok",
    session_id: "s1",
    total_cost_usd: 0.0123,
    duration_ms: 100,
    duration_api_ms: 80,
    num_turns: 1,
    is_error: false,
    usage: {
      input_tokens: 500,
      output_tokens: 120,
      cache_read_input_tokens: 64,
    },
  };
  const out = extractClaudeOutput(event);
  assertEquals(out.runtime, "claude");
  assertEquals(out.total_cost_usd, 0.0123);
  assertEquals(out.duration_api_ms, 80);
  assertEquals(out.usage, {
    input_tokens: 500,
    output_tokens: 120,
    cached_tokens: 64,
    cost_usd: 0.0123,
  });
});

Deno.test("extractClaudeOutput — leaves cost / api duration undefined when result event omits them", () => {
  const out = extractClaudeOutput({
    type: "result",
    subtype: "success",
    result: "ok",
    session_id: "s2",
    duration_ms: 50,
    num_turns: 0,
    is_error: false,
  });
  assertEquals(out.total_cost_usd, undefined);
  assertEquals(out.duration_api_ms, undefined);
  assertEquals(out.usage, undefined);
});
