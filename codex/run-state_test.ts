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
  classifyCodexErrorText,
  createCodexRunState,
  extractCodexOutput,
  extractCodexUsage,
} from "./run-state.ts";
import { ERROR_CATEGORY_INVALID_REQUEST } from "../runtime/error-types.ts";

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

// --- FR-L41: classify permanent Codex API errors ---

Deno.test("FR-L41 classifyCodexErrorText — envelope with invalid_request_error returns invalid_request", () => {
  const text =
    '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"model not supported"}}';
  assertEquals(
    classifyCodexErrorText(text),
    ERROR_CATEGORY_INVALID_REQUEST,
  );
});

Deno.test("FR-L41 classifyCodexErrorText — envelope with status 400 returns invalid_request even without typed inner", () => {
  const text = '{"type":"error","status":400,"error":{"message":"oops"}}';
  assertEquals(
    classifyCodexErrorText(text),
    ERROR_CATEGORY_INVALID_REQUEST,
  );
});

Deno.test("FR-L41 classifyCodexErrorText — flat string substring match", () => {
  assertEquals(
    classifyCodexErrorText("Upstream rejected: invalid_request_error model"),
    ERROR_CATEGORY_INVALID_REQUEST,
  );
});

Deno.test("FR-L41 classifyCodexErrorText — transient 503 envelope returns undefined", () => {
  const text = '{"type":"error","status":503,"error":{"type":"server_error"}}';
  assertEquals(classifyCodexErrorText(text), undefined);
});

Deno.test("FR-L41 classifyCodexErrorText — empty/non-string inputs return undefined", () => {
  assertEquals(classifyCodexErrorText(""), undefined);
  assertEquals(classifyCodexErrorText(undefined), undefined);
  assertEquals(classifyCodexErrorText(null), undefined);
  assertEquals(classifyCodexErrorText({ malformed: true }), undefined);
});

Deno.test("FR-L41 applyCodexEvent — error event sets errorCategory on invalid_request envelope", () => {
  const s = createCodexRunState();
  applyCodexEvent({
    type: "error",
    message:
      '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"bad model"}}',
  }, s);
  assertEquals(s.errorCategory, ERROR_CATEGORY_INVALID_REQUEST);
  assertEquals(s.errorMessage !== undefined, true);
});

Deno.test("FR-L41 applyCodexEvent — turn.failed event sets errorCategory on invalid_request envelope", () => {
  const s = createCodexRunState();
  applyCodexEvent({
    type: "turn.failed",
    error: {
      message:
        '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"x"}}',
    },
  }, s);
  assertEquals(s.errorCategory, ERROR_CATEGORY_INVALID_REQUEST);
});

Deno.test("FR-L41 applyCodexEvent — transient turn.failed leaves errorCategory undefined", () => {
  const s = createCodexRunState();
  applyCodexEvent({
    type: "turn.failed",
    error: { message: "Network unreachable" },
  }, s);
  assertEquals(s.errorCategory, undefined);
});
