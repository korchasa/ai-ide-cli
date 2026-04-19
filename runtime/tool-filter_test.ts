import { assertEquals, assertThrows } from "@std/assert";
import { TOOL_FILTER_FLAGS, validateToolFilter } from "./tool-filter.ts";

Deno.test("validateToolFilter — returns undefined when neither field set", () => {
  assertEquals(validateToolFilter("claude", {}), undefined);
  assertEquals(
    validateToolFilter("claude", { extraArgs: { "--other": "x" } }),
    undefined,
  );
});

Deno.test("validateToolFilter — returns 'allowed' when allowedTools set", () => {
  assertEquals(
    validateToolFilter("claude", { allowedTools: ["Read"] }),
    "allowed",
  );
});

Deno.test("validateToolFilter — returns 'disallowed' when disallowedTools set", () => {
  assertEquals(
    validateToolFilter("claude", { disallowedTools: ["Bash"] }),
    "disallowed",
  );
});

Deno.test("validateToolFilter — throws when both fields set (mutual exclusion)", () => {
  assertThrows(
    () =>
      validateToolFilter("claude", {
        allowedTools: ["Read"],
        disallowedTools: ["Bash"],
      }),
    Error,
    "mutually exclusive",
  );
});

Deno.test("validateToolFilter — throws on empty allowedTools array", () => {
  assertThrows(
    () => validateToolFilter("claude", { allowedTools: [] }),
    Error,
    "non-empty",
  );
});

Deno.test("validateToolFilter — throws on empty disallowedTools array", () => {
  assertThrows(
    () => validateToolFilter("claude", { disallowedTools: [] }),
    Error,
    "non-empty",
  );
});

Deno.test("validateToolFilter — throws on empty-string members in allowedTools", () => {
  assertThrows(
    () => validateToolFilter("claude", { allowedTools: ["Read", ""] }),
    Error,
    "non-empty strings",
  );
});

Deno.test("validateToolFilter — throws on empty-string members in disallowedTools", () => {
  assertThrows(
    () => validateToolFilter("claude", { disallowedTools: [""] }),
    Error,
    "non-empty strings",
  );
});

Deno.test("validateToolFilter — throws when typed field collides with --allowedTools in extraArgs", () => {
  assertThrows(
    () =>
      validateToolFilter("claude", {
        allowedTools: ["Read"],
        extraArgs: { "--allowedTools": "Read,Grep" },
      }),
    Error,
    'extraArgs key "--allowedTools"',
  );
});

Deno.test("validateToolFilter — throws when typed field collides with --allowed-tools in extraArgs", () => {
  assertThrows(
    () =>
      validateToolFilter("claude", {
        allowedTools: ["Read"],
        extraArgs: { "--allowed-tools": "Read,Grep" },
      }),
    Error,
    'extraArgs key "--allowed-tools"',
  );
});

Deno.test("validateToolFilter — throws when typed field collides with --disallowedTools in extraArgs", () => {
  assertThrows(
    () =>
      validateToolFilter("claude", {
        disallowedTools: ["Bash"],
        extraArgs: { "--disallowedTools": "Bash" },
      }),
    Error,
    'extraArgs key "--disallowedTools"',
  );
});

Deno.test("validateToolFilter — throws when typed field collides with --disallowed-tools in extraArgs", () => {
  assertThrows(
    () =>
      validateToolFilter("claude", {
        disallowedTools: ["Bash"],
        extraArgs: { "--disallowed-tools": "Bash" },
      }),
    Error,
    'extraArgs key "--disallowed-tools"',
  );
});

Deno.test("validateToolFilter — throws when typed field collides with --tools in extraArgs", () => {
  assertThrows(
    () =>
      validateToolFilter("claude", {
        allowedTools: ["Read"],
        extraArgs: { "--tools": "default" },
      }),
    Error,
    'extraArgs key "--tools"',
  );
});

Deno.test("validateToolFilter — legacy path: extraArgs only, no typed field, does NOT throw", () => {
  assertEquals(
    validateToolFilter("claude", {
      extraArgs: { "--allowedTools": "Read,Grep" },
    }),
    undefined,
  );
  assertEquals(
    validateToolFilter("claude", {
      extraArgs: { "--tools": "default" },
    }),
    undefined,
  );
});

Deno.test("validateToolFilter — error message carries the runtime attribution", () => {
  assertThrows(
    () =>
      validateToolFilter("opencode", {
        allowedTools: ["Read"],
        disallowedTools: ["Bash"],
      }),
    Error,
    "opencode:",
  );
});

Deno.test("TOOL_FILTER_FLAGS — contains the five Claude tool-filter flag aliases", () => {
  const expected = [
    "--allowedTools",
    "--allowed-tools",
    "--disallowedTools",
    "--disallowed-tools",
    "--tools",
  ];
  for (const f of expected) {
    assertEquals(TOOL_FILTER_FLAGS.includes(f), true, `missing ${f}`);
  }
});
