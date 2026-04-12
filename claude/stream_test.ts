import { assertEquals } from "@std/assert";
import {
  FileReadTracker,
  processStreamEvent,
  type StreamProcessorState,
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

// --- onEvent callback ---

Deno.test("processStreamEvent — onEvent receives every raw event before filtering", async () => {
  const received: Record<string, unknown>[] = [];
  const state = makeState({ onEvent: (e) => received.push(e) });

  const initEvent = { type: "system", subtype: "init", model: "test-model" };
  const assistantEvent = {
    type: "assistant",
    message: { content: [{ type: "text", text: "hello" }] },
  };
  const resultEvent = {
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
  // no crash, turnCount unchanged for system event
  assertEquals(state.turnCount, 0);
});
