import { assertEquals, assertThrows } from "@std/assert";
import {
  REASONING_EFFORT_FLAGS,
  REASONING_EFFORT_VALUES,
  validateReasoningEffort,
} from "./reasoning-effort.ts";

Deno.test("validateReasoningEffort — returns undefined when field unset", () => {
  assertEquals(validateReasoningEffort("claude", {}), undefined);
  assertEquals(
    validateReasoningEffort("claude", { extraArgs: { "--other": "x" } }),
    undefined,
  );
});

Deno.test("validateReasoningEffort — returns the enum value when set", () => {
  for (const value of REASONING_EFFORT_VALUES) {
    assertEquals(
      validateReasoningEffort("codex", { reasoningEffort: value }),
      value,
    );
  }
});

Deno.test("validateReasoningEffort — throws on out-of-enum value", () => {
  assertThrows(
    () =>
      validateReasoningEffort("claude", {
        // deno-lint-ignore no-explicit-any
        reasoningEffort: "xhigh" as any,
      }),
    Error,
    "reasoningEffort must be one of",
  );
});

Deno.test("validateReasoningEffort — throws on --effort collision in extraArgs", () => {
  assertThrows(
    () =>
      validateReasoningEffort("claude", {
        reasoningEffort: "medium",
        extraArgs: { "--effort": "high" },
      }),
    Error,
    "collides with typed reasoningEffort",
  );
});

Deno.test("validateReasoningEffort — throws on --variant collision in extraArgs", () => {
  assertThrows(
    () =>
      validateReasoningEffort("opencode", {
        reasoningEffort: "minimal",
        extraArgs: { "--variant": "max" },
      }),
    Error,
    "collides with typed reasoningEffort",
  );
});

Deno.test("validateReasoningEffort — legacy path: extraArgs only, no typed field, does NOT throw", () => {
  // Mirrors the FR-L24 legacy-compat pattern. When the typed field is
  // unset, extraArgs with the native flag still passes through.
  assertEquals(
    validateReasoningEffort("opencode", {
      extraArgs: { "--variant": "high" },
    }),
    undefined,
  );
  assertEquals(
    validateReasoningEffort("claude", { extraArgs: { "--effort": "low" } }),
    undefined,
  );
});

Deno.test("validateReasoningEffort — error message carries runtime attribution", () => {
  const err = assertThrows(
    () =>
      validateReasoningEffort("cursor", {
        // deno-lint-ignore no-explicit-any
        reasoningEffort: "nope" as any,
      }),
    Error,
  );
  assertEquals(err.message.startsWith("cursor:"), true);
});

Deno.test("REASONING_EFFORT_FLAGS — contains --effort and --variant", () => {
  assertEquals(REASONING_EFFORT_FLAGS.includes("--effort"), true);
  assertEquals(REASONING_EFFORT_FLAGS.includes("--variant"), true);
});

Deno.test("REASONING_EFFORT_VALUES — ascending 4-level enum", () => {
  assertEquals(
    [...REASONING_EFFORT_VALUES],
    ["minimal", "low", "medium", "high"],
  );
});
