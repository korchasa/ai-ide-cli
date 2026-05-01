import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { defaultRegistry } from "../process-registry.ts";
import { getRuntimeAdapter } from "./index.ts";
import {
  _resetReasoningEffortWarning,
  _resetToolFilterWarning,
} from "./cursor-adapter.ts";

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
        processRegistry: defaultRegistry,
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
        processRegistry: defaultRegistry,
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
          processRegistry: defaultRegistry,
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

// --- reasoning effort (FR-L25) ---

Deno.test("cursorRuntimeAdapter — reasoningEffort capability is false", () => {
  assertEquals(cursorRuntimeAdapter.capabilities.reasoningEffort, false);
});

Deno.test("cursorRuntimeAdapter.invoke — reasoningEffort warns once, then silent, resettable", async () => {
  _resetReasoningEffortWarning();
  await withWarnSpy(async (calls) => {
    // We only care about the validation + warn flip — the invocation
    // itself hits the stub-less PATH, which throws an ENOENT-equivalent
    // error we ignore.
    try {
      await cursorRuntimeAdapter.invoke({
        processRegistry: defaultRegistry,
        taskPrompt: "ignored",
        timeoutSeconds: 1,
        maxRetries: 1,
        retryDelaySeconds: 1,
        reasoningEffort: "high",
      });
    } catch {
      // ignore — the warn we test for fires before the subprocess spawns.
    }
    try {
      await cursorRuntimeAdapter.invoke({
        processRegistry: defaultRegistry,
        taskPrompt: "ignored",
        timeoutSeconds: 1,
        maxRetries: 1,
        retryDelaySeconds: 1,
        reasoningEffort: "low",
      });
    } catch {
      // ignore
    }
    const warnCount = calls.filter((c) =>
      String(c[0]).includes("reasoningEffort")
    ).length;
    assertEquals(warnCount, 1);
    _resetReasoningEffortWarning();
    try {
      await cursorRuntimeAdapter.invoke({
        processRegistry: defaultRegistry,
        taskPrompt: "ignored",
        timeoutSeconds: 1,
        maxRetries: 1,
        retryDelaySeconds: 1,
        reasoningEffort: "medium",
      });
    } catch {
      // ignore
    }
    const warnCount2 =
      calls.filter((c) => String(c[0]).includes("reasoningEffort")).length;
    assertEquals(warnCount2, 2);
  });
});

Deno.test("cursorRuntimeAdapter.invoke — malformed reasoningEffort throws synchronously without warn", () => {
  _resetReasoningEffortWarning();
  assertThrows(
    () =>
      cursorRuntimeAdapter.invoke({
        processRegistry: defaultRegistry,
        taskPrompt: "ignored",
        timeoutSeconds: 1,
        maxRetries: 1,
        retryDelaySeconds: 1,
        // deno-lint-ignore no-explicit-any
        reasoningEffort: "bogus" as any,
      }),
    Error,
    "reasoningEffort must be one of",
  );
});

Deno.test("cursorRuntimeAdapter.openSession — malformed reasoningEffort rejects without flipping warn latch", async () => {
  _resetReasoningEffortWarning();
  await withWarnSpy(async (calls) => {
    await assertRejects(
      () =>
        cursorRuntimeAdapter.openSession!({
          processRegistry: defaultRegistry,
          // deno-lint-ignore no-explicit-any
          reasoningEffort: "bogus" as any,
        }),
      Error,
      "reasoningEffort must be one of",
    );
    assertEquals(
      calls.filter((c) => String(c[0]).includes("reasoningEffort")).length,
      0,
    );
  });
});
