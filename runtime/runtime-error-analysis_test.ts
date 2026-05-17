import { assertEquals } from "@std/assert";
import { analyzeRuntimeErrorSignal } from "./runtime-error-analysis.ts";

Deno.test(
  "known runtime error fixtures classify deterministically",
  () => {
    const usageLimit =
      `INFO 2026-05-09T03:54:10 service=upstream-fetch {"statusCode":429,"data":{"error":{"code":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at 2026-05-09 04:56:07"}}}`;
    assertEquals(
      analyzeRuntimeErrorSignal({
        runtime: "opencode",
        source: "log",
        text: usageLimit,
      }),
      {
        runtime: "opencode",
        source: "log",
        kind: "quota",
        confidence: "high",
        statusCode: 429,
        providerCode: "1308",
        message:
          "Usage limit reached for 5 hour. Your limit will reset at 2026-05-09 04:56:07",
        resetAt: "2026-05-09 04:56:07",
      },
    );

    assertEquals(
      analyzeRuntimeErrorSignal({
        runtime: "opencode",
        source: "log",
        text: `... "statusCode":402 ... "message":"Insufficient credits"`,
      }),
      {
        runtime: "opencode",
        source: "log",
        kind: "quota",
        confidence: "high",
        statusCode: 402,
        message: "Insufficient credits",
      },
    );

    assertEquals(
      analyzeRuntimeErrorSignal({
        runtime: "claude",
        source: "stderr",
        text: "Error: context length exceeded the maximum context window",
      }),
      {
        runtime: "claude",
        source: "stderr",
        kind: "context_window",
        confidence: "medium",
        message: "Error: context length exceeded the maximum context window",
      },
    );

    assertEquals(
      analyzeRuntimeErrorSignal({
        runtime: "codex",
        source: "event",
        event: {
          type: "turn.failed",
          error: {
            message: "Maximum output token budget exceeded",
          },
        },
      }),
      {
        runtime: "codex",
        source: "event",
        kind: "token_budget",
        confidence: "medium",
        message: "Maximum output token budget exceeded",
      },
    );
  },
);

Deno.test("runtime error analyzer separates auth / policy / rate / plan categories", () => {
  assertEquals(
    analyzeRuntimeErrorSignal({
      source: "stderr",
      text: `error {"statusCode":401,"error":{"message":"Invalid API key"}}`,
    }),
    {
      source: "stderr",
      kind: "auth",
      confidence: "high",
      statusCode: 401,
      message: "Invalid API key",
    },
  );

  assertEquals(
    analyzeRuntimeErrorSignal({
      source: "stderr",
      text:
        `error {"statusCode":403,"error":{"message":"Access denied by policy"}}`,
    }),
    {
      source: "stderr",
      kind: "policy",
      confidence: "high",
      statusCode: 403,
      message: "Access denied by policy",
    },
  );

  assertEquals(
    analyzeRuntimeErrorSignal({
      source: "error_string",
      text: "Rate limit exceeded. Please retry after 30 seconds.",
    }),
    {
      source: "error_string",
      kind: "rate_limit",
      confidence: "medium",
      message: "Rate limit exceeded. Please retry after 30 seconds.",
      retryAfterSeconds: 30,
    },
  );

  assertEquals(
    analyzeRuntimeErrorSignal({
      runtime: "cursor",
      source: "stderr",
      text:
        "S: Named models unavailable Free plans can only use Auto. Switch to Auto or upgrade plans to continue.",
    }),
    {
      runtime: "cursor",
      source: "stderr",
      kind: "plan_limit",
      confidence: "high",
      message:
        "S: Named models unavailable Free plans can only use Auto. Switch to Auto or upgrade plans to continue.",
    },
  );
});

Deno.test("non-error text is not classified without adapter confirmation", () => {
  for (
    const text of [
      "",
      "OpenCode timed out",
      "HTTP 404 from upstream provider",
      "Set streamStallTimeoutSeconds to limit watchdog noise",
      "The answer describes quota management as a product feature.",
    ]
  ) {
    assertEquals(
      analyzeRuntimeErrorSignal({ source: "error_string", text }),
      undefined,
      `expected no classification for: ${text}`,
    );
  }
});

Deno.test("runtime error analyzer returns generic error when adapter confirms failure", () => {
  assertEquals(
    analyzeRuntimeErrorSignal({
      runtime: "cursor",
      source: "stderr",
      text: "Cursor CLI exited with code 1: unexpected backend failure",
      assumeRuntimeError: true,
    }),
    {
      runtime: "cursor",
      source: "stderr",
      kind: "runtime_error",
      confidence: "low",
      message: "Cursor CLI exited with code 1: unexpected backend failure",
    },
  );
});

Deno.test("runtime error analyzer preserves structured event facts", () => {
  assertEquals(
    analyzeRuntimeErrorSignal({
      runtime: "opencode",
      source: "event",
      event: {
        statusCode: 429,
        error: {
          code: "1308",
          message:
            "Usage limit reached for 5 hour. Your limit will reset at 2026-05-09 04:56:07",
        },
      },
    }),
    {
      runtime: "opencode",
      source: "event",
      kind: "quota",
      confidence: "high",
      statusCode: 429,
      providerCode: "1308",
      message:
        "Usage limit reached for 5 hour. Your limit will reset at 2026-05-09 04:56:07",
      resetAt: "2026-05-09 04:56:07",
    },
  );

  assertEquals(
    analyzeRuntimeErrorSignal({
      runtime: "cursor",
      source: "event",
      event: {
        type: "result",
        subtype: "error",
        result: "Rate limit exceeded. Please retry after 30 seconds.",
      },
    }),
    {
      runtime: "cursor",
      source: "event",
      kind: "rate_limit",
      confidence: "medium",
      message: "Rate limit exceeded. Please retry after 30 seconds.",
      retryAfterSeconds: 30,
    },
  );
});

Deno.test("runtime error analyzer tolerates malformed event payloads", () => {
  assertEquals(
    analyzeRuntimeErrorSignal({
      runtime: "cursor",
      source: "event",
      event: {
        type: "result",
        usage: { inputTokens: 10 },
      },
    }),
    undefined,
  );
  assertEquals(
    analyzeRuntimeErrorSignal({
      runtime: "cursor",
      source: "event",
      event: { error: null },
    }),
    undefined,
  );
});
