/**
 * Tests for the Claude `permissionMode` enum and its fail-fast validator.
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  VALID_PERMISSION_MODES,
  validateClaudePermissionMode,
} from "./permission-mode.ts";

Deno.test("validateClaudePermissionMode: undefined is a no-op", () => {
  validateClaudePermissionMode(undefined);
});

Deno.test("validateClaudePermissionMode: every narrowed value is accepted", () => {
  for (const value of VALID_PERMISSION_MODES) {
    validateClaudePermissionMode(value);
  }
});

Deno.test("validateClaudePermissionMode: rejects retired 'dontAsk' value", () => {
  const err = assertThrows(
    () => validateClaudePermissionMode("dontAsk"),
    Error,
  );
  // Message must mention the rejected value and at least one allowed value
  // so YAML-driven consumers get an actionable error.
  if (!err.message.includes("dontAsk")) {
    throw new Error(
      `expected message to mention 'dontAsk', got: ${err.message}`,
    );
  }
  if (!err.message.includes("acceptEdits")) {
    throw new Error(
      `expected message to list allowed values, got: ${err.message}`,
    );
  }
});

Deno.test("validateClaudePermissionMode: rejects retired 'auto' value", () => {
  assertThrows(
    () => validateClaudePermissionMode("auto"),
    Error,
    "auto",
  );
});

Deno.test("validateClaudePermissionMode: rejects arbitrary garbage", () => {
  assertThrows(
    () => validateClaudePermissionMode("read-only"),
    Error,
  );
});

Deno.test("VALID_PERMISSION_MODES: matches the narrowed Claude enum", () => {
  assertEquals([...VALID_PERMISSION_MODES].sort(), [
    "acceptEdits",
    "bypassPermissions",
    "default",
    "plan",
  ]);
});
