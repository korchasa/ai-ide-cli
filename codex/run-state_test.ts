/**
 * @module
 * Unit tests for {@link applyCodexEvent}, {@link extractCodexUsage},
 * and {@link extractCodexOutput} — the pure run-state aggregator
 * fed by the NDJSON parser.
 *
 * Scope: token-accumulation correctness, especially the Codex
 * `rust-v0.128.0`+ `reasoning_output_tokens` bucket and the
 * `undefined`-vs-`0` projection contract on {@link CliRunUsage}.
 */

import { assertEquals } from "@std/assert";
import {
  applyCodexEvent,
  createCodexRunState,
  extractCodexOutput,
  extractCodexUsage,
} from "./run-state.ts";

// FR-L13
Deno.test("reasoning tokens accumulate and surface on extractCodexUsage", () => {
  const s = createCodexRunState();
  applyCodexEvent({
    type: "turn.completed",
    usage: {
      input_tokens: 100,
      cached_input_tokens: 20,
      output_tokens: 50,
      reasoning_output_tokens: 320,
    },
  }, s);
  applyCodexEvent({
    type: "turn.completed",
    usage: {
      input_tokens: 80,
      output_tokens: 40,
      reasoning_output_tokens: 110,
    },
  }, s);
  const usage = extractCodexUsage(s);
  assertEquals(usage?.reasoning_tokens, 430);
  assertEquals(usage?.input_tokens, 180);
  assertEquals(usage?.output_tokens, 90);
  assertEquals(usage?.cached_tokens, 20);
});

// FR-L13
Deno.test("extractCodexUsage omits reasoning_tokens when wire field absent", () => {
  const s = createCodexRunState();
  applyCodexEvent({
    type: "turn.completed",
    usage: { input_tokens: 100, output_tokens: 50 },
  }, s);
  const usage = extractCodexUsage(s);
  assertEquals(usage?.reasoning_tokens, undefined);
  assertEquals(usage?.input_tokens, 100);
  assertEquals(usage?.output_tokens, 50);
});

// FR-L13
Deno.test("extractCodexUsage returns undefined when every counter is zero", () => {
  const s = createCodexRunState();
  assertEquals(extractCodexUsage(s), undefined);
});

// FR-L13
Deno.test("extractCodexOutput surfaces reasoning_tokens on CliRunOutput.usage", () => {
  const s = createCodexRunState();
  applyCodexEvent({ type: "thread.started", thread_id: "thrd_x" }, s);
  applyCodexEvent({
    type: "turn.completed",
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      reasoning_output_tokens: 200,
    },
  }, s);
  const out = extractCodexOutput(s);
  assertEquals(out.usage?.reasoning_tokens, 200);
  assertEquals(out.session_id, "thrd_x");
  assertEquals(out.is_error, false);
  assertEquals(out.num_turns, 1);
});
