import { assertEquals, assertThrows } from "@std/assert";
import { getRuntimeAdapter } from "./index.ts";
import { _resetToolFilterWarning } from "./codex-adapter.ts";

const codexRuntimeAdapter = getRuntimeAdapter("codex");

// --- capability and validator parity (FR-L24) ---

Deno.test("codexRuntimeAdapter — toolFilter capability is false", () => {
  assertEquals(codexRuntimeAdapter.capabilities.toolFilter, false);
});

Deno.test("codexRuntimeAdapter.invoke — malformed tool filter throws synchronously", () => {
  _resetToolFilterWarning();
  assertThrows(
    () =>
      codexRuntimeAdapter.invoke({
        taskPrompt: "ignored",
        timeoutSeconds: 1,
        maxRetries: 1,
        retryDelaySeconds: 1,
        allowedTools: ["Read"],
        disallowedTools: ["Bash"],
      }),
    Error,
    "mutually exclusive",
  );
});

Deno.test("codexRuntimeAdapter.invoke — empty allowedTools array throws synchronously", () => {
  _resetToolFilterWarning();
  assertThrows(
    () =>
      codexRuntimeAdapter.invoke({
        taskPrompt: "ignored",
        timeoutSeconds: 1,
        maxRetries: 1,
        retryDelaySeconds: 1,
        allowedTools: [],
      }),
    Error,
    "non-empty",
  );
});

Deno.test("codexRuntimeAdapter.openSession — malformed input throws synchronously", () => {
  _resetToolFilterWarning();
  // `openSession` is NOT declared `async` — the validator throw
  // propagates synchronously before any Promise is returned.
  assertThrows(
    () =>
      codexRuntimeAdapter.openSession!({
        allowedTools: ["Read"],
        disallowedTools: ["Bash"],
      }),
    Error,
    "mutually exclusive",
  );
});

Deno.test("codexRuntimeAdapter — _resetToolFilterWarning is exported", () => {
  _resetToolFilterWarning();
});
