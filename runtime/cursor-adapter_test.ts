import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { getRuntimeAdapter } from "./index.ts";
import { _resetToolFilterWarning } from "./cursor-adapter.ts";

const cursorRuntimeAdapter = getRuntimeAdapter("cursor");

/**
 * Replace `console.warn` with a capturing spy for the duration of `fn`.
 * Restores the original in `finally` so tests stay isolated even on throw.
 */
async function withWarnSpy<T>(
  fn: (calls: unknown[][]) => Promise<T> | T,
): Promise<T> {
  const calls: unknown[][] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => {
    calls.push(args);
  };
  try {
    return await fn(calls);
  } finally {
    console.warn = orig;
  }
}

// --- capability and validator parity (FR-L24) ---

Deno.test("cursorRuntimeAdapter — toolFilter capability is false", () => {
  assertEquals(cursorRuntimeAdapter.capabilities.toolFilter, false);
});

Deno.test("cursorRuntimeAdapter.invoke — malformed tool filter throws synchronously", () => {
  _resetToolFilterWarning();
  assertThrows(
    () =>
      cursorRuntimeAdapter.invoke({
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

Deno.test("cursorRuntimeAdapter.invoke — empty allowedTools array throws synchronously", () => {
  _resetToolFilterWarning();
  assertThrows(
    () =>
      cursorRuntimeAdapter.invoke({
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

Deno.test("cursorRuntimeAdapter.openSession — malformed input rejects without flipping warn latch", async () => {
  _resetToolFilterWarning();
  await withWarnSpy(async (calls) => {
    await assertRejects(
      () =>
        cursorRuntimeAdapter.openSession!({
          allowedTools: ["Read"],
          disallowedTools: ["Bash"],
        }),
      Error,
      "mutually exclusive",
    );
    assertEquals(calls.length, 0, "failed validation must not warn");
  });
});

Deno.test("cursorRuntimeAdapter — _resetToolFilterWarning is exported", () => {
  // Module-level latch reset helper must exist for test isolation.
  // Type-level check is implicit via the import at the top of the file.
  _resetToolFilterWarning();
});
