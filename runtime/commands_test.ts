/**
 * @module
 * Unit tests for the FR-L42 commands fast-channel neutral surface.
 *
 * Drives types + error class compilation through `mod.ts` (the public
 * surface every JSR consumer sees) so a missed re-export fails here
 * rather than at `deno publish --dry-run`.
 */

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import {
  type Command,
  CommandsUnavailableError,
  type FetchCommandsOptions,
  type NormalizedCommandsContent,
} from "../mod.ts";
import type { CommandsSnapshot } from "../mod.ts";

Deno.test("Command / CommandsSnapshot / FetchCommandsOptions compile via mod.ts", () => {
  const cmd: Command = {
    name: "/help",
    description: "Show help",
    input: { hint: "topic" },
  };
  const snapshot: CommandsSnapshot = {
    runtime: "claude",
    sessionId: "s-1",
    commands: [cmd],
  };
  const opts: FetchCommandsOptions = {
    transport: "acp",
    timeoutMs: 5_000,
    cwd: "/tmp",
  };
  assertEquals(snapshot.commands[0].name, "/help");
  assertEquals(snapshot.commands[0].description, "Show help");
  assertEquals(snapshot.commands[0].input?.hint, "topic");
  assertEquals(opts.transport, "acp");
});

Deno.test("CommandsSnapshot — sessionId is optional", () => {
  const snapshot: CommandsSnapshot = {
    runtime: "codex",
    commands: [],
  };
  assertStrictEquals(snapshot.sessionId, undefined);
});

Deno.test("Command — input is optional", () => {
  const cmd: Command = { name: "/clear", description: "Reset chat" };
  assertStrictEquals(cmd.input, undefined);
});

Deno.test("CommandsUnavailableError — carries runtime/transport/reason", () => {
  const err = new CommandsUnavailableError("claude", "cli", "no_fast_channel");
  assert(err instanceof CommandsUnavailableError);
  assert(err instanceof Error);
  assertEquals(err.runtime, "claude");
  assertEquals(err.transport, "cli");
  assertEquals(err.reason, "no_fast_channel");
  // Message must mention the runtime, transport, and reason — diagnostic
  // value of the typed error degrades if the human-readable text is
  // generic.
  assert(err.message.includes("claude"));
  assert(err.message.includes("cli"));
});

Deno.test("CommandsUnavailableError — each reason produces a distinct message", () => {
  const a = new CommandsUnavailableError("codex", "acp", "timeout");
  const b = new CommandsUnavailableError("codex", "acp", "front_not_piloted");
  const c = new CommandsUnavailableError("codex", "cli", "no_fast_channel");
  assert(a.message !== b.message, "timeout vs front_not_piloted");
  assert(b.message !== c.message, "front_not_piloted vs no_fast_channel");
  assert(a.message !== c.message, "timeout vs no_fast_channel");
});

Deno.test("CommandsUnavailableError — preserves cause", () => {
  const cause = new Error("timed out after 200ms");
  const err = new CommandsUnavailableError(
    "opencode",
    "acp",
    "timeout",
    { cause },
  );
  assertStrictEquals(err.cause, cause);
});

Deno.test("NormalizedCommandsContent — re-exported from mod.ts", () => {
  const c: NormalizedCommandsContent = {
    kind: "commands",
    commands: [{ name: "/help", description: "Show help" }],
  };
  assertEquals(c.kind, "commands");
  assertEquals(c.commands.length, 1);
});
