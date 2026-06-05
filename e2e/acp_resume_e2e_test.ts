/**
 * @module
 * FR-L19 ACP resume real-binary proof. Drives `transport: "acp"` against
 * the pinned `@agentclientprotocol/claude-agent-acp` front (the only
 * pilot advertising `agentCapabilities.loadSession`) and asserts that
 * conversation history survives a reopen via `resumeSessionId` →
 * `session/load`.
 *
 * Flow: open a session, plant a memorable fact, capture the
 * server-assigned `sessionId`, dispose; then reopen with that
 * `resumeSessionId` and ask the agent to recall the fact — the reply
 * must reference it, proving the prior turn was re-hydrated rather than a
 * fresh session.
 *
 * Gated on `E2E=1` + `e2eAcpEnabled("claude")`. Complements the
 * stub-driven routing coverage in `runtime/acp/adapter_test.ts`.
 */

import { assert } from "@std/assert";
import { getRuntimeAdapter } from "../runtime/index.ts";
import { defaultRegistry } from "../process-registry.ts";
import { extractSessionContent } from "../runtime/content.ts";
import { SYNTHETIC_TURN_END } from "../runtime/session-types.ts";
import type { RuntimeSession } from "../runtime/session-types.ts";
import { e2eAcpEnabled } from "./_helpers.ts";

const enabled = await e2eAcpEnabled("claude");

const SECRET = "BANANA-42";

/**
 * Push one message into a session and collect the assistant text until
 * the synthetic turn-end fires. Returns the concatenated reply text.
 */
async function sendAndCollect(
  session: RuntimeSession,
  message: string,
): Promise<string> {
  const parts: string[] = [];
  await session.send(message);
  for await (const event of session.events) {
    for (const c of extractSessionContent(event)) {
      if (c.kind === "text") parts.push(c.text);
      if (c.kind === "final") parts.push(c.text);
    }
    if (event.type === SYNTHETIC_TURN_END) break;
  }
  return parts.join("");
}

// FR-L19
Deno.test({
  name: "e2e acp/claude resume via session/load preserves history",
  ignore: !enabled,
  sanitizeOps: false,
  sanitizeResources: false,
  sanitizeExit: false,
  fn: async () => {
    const adapter = getRuntimeAdapter("claude");
    assert(adapter.openSession, "claude adapter must expose openSession");

    // Phase 1 — plant the fact and capture the session id.
    const first = await adapter.openSession({
      processRegistry: defaultRegistry,
      transport: "acp",
      permissionMode: "plan",
    });
    let sessionId: string;
    try {
      await sendAndCollect(
        first,
        `Remember this for later: the secret code is ${SECRET}. ` +
          `Reply with just the word "stored".`,
      );
      sessionId = first.sessionId;
      assert(
        sessionId.length > 0,
        "expected a non-empty sessionId after the first turn",
      );
    } finally {
      first.abort();
      await first.done;
    }

    // Phase 2 — reopen by id (routes session/load) and recall the fact.
    const resumed = await adapter.openSession({
      processRegistry: defaultRegistry,
      transport: "acp",
      permissionMode: "plan",
      resumeSessionId: sessionId,
    });
    try {
      assert(
        resumed.sessionId === sessionId,
        `resumed sessionId should echo the original, got ${resumed.sessionId}`,
      );
      const reply = await sendAndCollect(
        resumed,
        "What was the secret code I asked you to remember? " +
          "Reply with just the code.",
      );
      assert(
        reply.includes(SECRET),
        `expected the resumed reply to recall '${SECRET}', got: ${reply}`,
      );
    } finally {
      resumed.abort();
      await resumed.done;
    }
  },
});
