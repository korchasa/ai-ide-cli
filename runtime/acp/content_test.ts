/**
 * @module
 * Unit tests for the ACP {@link NormalizedContent} extractor.
 *
 * Drives both surfaces:
 * - direct `extractAcpContent(runtime, type, raw)` calls verify the
 *   per-pilot projection;
 * - synthetic `RuntimeSessionEvent` payloads through the runtime-neutral
 *   `extractSessionContent` dispatcher verify the detection rule
 *   (`event.type === "session/update"` OR nested `update.sessionUpdate`
 *   string).
 */

import { assertEquals } from "@std/assert";
import { extractAcpContent } from "./content.ts";
import { extractSessionContent, type NormalizedContent } from "../content.ts";
import type { RuntimeSessionEvent } from "../types.ts";
import { SYNTHETIC_TURN_END } from "../types.ts";
import type { RuntimeId } from "../../types.ts";

const PILOTS: RuntimeId[] = ["claude", "codex", "opencode"];

function acpEvent(
  runtime: RuntimeId,
  raw: Record<string, unknown>,
): RuntimeSessionEvent {
  return { runtime, type: "session/update", raw };
}

Deno.test("extractAcpContent — agent_message_chunk → cumulative:false text (every pilot)", () => {
  for (const runtime of PILOTS) {
    const raw = {
      sessionId: "s-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "ok" },
      },
    };
    assertEquals(
      extractAcpContent(runtime, "session/update", raw),
      [{
        kind: "text",
        text: "ok",
        cumulative: false,
      }] satisfies NormalizedContent[],
      `pilot ${runtime} agent_message_chunk`,
    );
  }
});

Deno.test("extractAcpContent — tool_call_update → tool content with title as name", () => {
  for (const runtime of PILOTS) {
    const raw = {
      sessionId: "s-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-42",
        title: "Read",
        kind: "read",
        rawInput: { file_path: "cli.ts" },
      },
    };
    assertEquals(
      extractAcpContent(runtime, "session/update", raw),
      [{
        kind: "tool",
        id: "call-42",
        name: "Read",
        input: { file_path: "cli.ts" },
      }],
      `pilot ${runtime} tool_call_update`,
    );
  }
});

Deno.test("extractAcpContent — tool_call_update falls back to kind when title missing", () => {
  const raw = {
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "call-7",
      kind: "execute",
    },
  };
  assertEquals(
    extractAcpContent("claude", "session/update", raw),
    [{ kind: "tool", id: "call-7", name: "execute" }],
  );
});

Deno.test("extractAcpContent — tool_call_update without toolCallId → []", () => {
  const raw = {
    update: {
      sessionUpdate: "tool_call_update",
      title: "Read",
    },
  };
  assertEquals(extractAcpContent("claude", "session/update", raw), []);
});

Deno.test("extractAcpContent — unknown sessionUpdate variant → []", () => {
  const raw = {
    update: {
      sessionUpdate: "plan",
      entries: [{ description: "step one" }],
    },
  };
  assertEquals(extractAcpContent("claude", "session/update", raw), []);
});

Deno.test("extractAcpContent — payload without sessionUpdate variant → []", () => {
  const raw = { foo: "bar" };
  assertEquals(extractAcpContent("claude", "session/cancel", raw), []);
});

Deno.test("extractAcpContent — top-level sessionUpdate (no `update` wrapper) is accepted", () => {
  const raw = {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "flat" },
  };
  assertEquals(
    extractAcpContent("claude", "session/update", raw),
    [{ kind: "text", text: "flat", cumulative: false }],
  );
});

Deno.test("extractAcpContent — malformed content.text (non-string) → []", () => {
  const raw = {
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: 42 },
    },
  };
  assertEquals(extractAcpContent("claude", "session/update", raw), []);
});

Deno.test("extractSessionContent — routes session/update events to ACP extractor", () => {
  const ev = acpEvent("claude", {
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hi" },
    },
  });
  assertEquals(extractSessionContent(ev), [
    { kind: "text", text: "hi", cumulative: false },
  ]);
});

Deno.test("extractSessionContent — synthetic turn-end short-circuits before ACP arm", () => {
  const ev: RuntimeSessionEvent = {
    runtime: "claude",
    type: SYNTHETIC_TURN_END,
    raw: { stopReason: "end_turn" },
    synthetic: true,
  };
  assertEquals(extractSessionContent(ev), []);
});

Deno.test("extractSessionContent — CLI claude assistant event still routes to claude extractor", () => {
  const ev: RuntimeSessionEvent = {
    runtime: "claude",
    type: "assistant",
    raw: {
      type: "assistant",
      message: { content: [{ type: "text", text: "cli-path" }] },
    },
  };
  assertEquals(extractSessionContent(ev), [
    { kind: "text", text: "cli-path", cumulative: true },
  ]);
});

Deno.test("extractSessionContent — defensive detection via nested update.sessionUpdate", () => {
  // Future ACP fronts may set a method name other than "session/update"
  // while still wrapping the variant under `update`. Detection falls
  // back to the structural marker.
  const ev: RuntimeSessionEvent = {
    runtime: "claude",
    type: "some/future/method",
    raw: {
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "defensive" },
      },
    },
  };
  assertEquals(extractSessionContent(ev), [
    { kind: "text", text: "defensive", cumulative: false },
  ]);
});
