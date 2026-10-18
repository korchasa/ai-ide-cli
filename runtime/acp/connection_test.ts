import { assertEquals, assertNotEquals } from "@std/assert";
import { ProcessRegistry } from "../../process-registry.ts";
import { openAcpConnection } from "./adapter.ts";
import { ask, STUB_FRONT } from "./testdata/stub_front_helpers.ts";

Deno.test("FR-L58 two sessions share one process and see only their own updates", async () => {
  const registry = new ProcessRegistry();
  const conn = await openAcpConnection("claude", {
    processRegistry: registry,
    acpFront: STUB_FRONT,
  });
  try {
    const a = await conn.openSession({ acpSessionMeta: { who: "a" } });
    const b = await conn.openSession({
      acpSessionMeta: { who: "b" },
      onToolUseObserved: () => "allow",
    });
    assertNotEquals(a.sessionId, b.sessionId);
    // One process behind both sessions.
    const pidA = await ask(a, "PID");
    assertEquals(await ask(b, "PID"), pidA);
    assertEquals(String(conn.pid), pidA);
    // Each session gets only its own stream, `_meta` and permission policy.
    assertEquals(await ask(a, "hi"), `echo:${a.sessionId}:hi`);
    assertEquals(await ask(b, "yo"), `echo:${b.sessionId}:yo`);
    assertEquals(JSON.parse(await ask(a, "META")), { who: "a" });
    assertEquals(JSON.parse(await ask(b, "META")), { who: "b" });
    assertEquals(
      JSON.parse(await ask(a, "PERMIT")).outcome.optionId,
      "reject-1",
    );
    assertEquals(
      JSON.parse(await ask(b, "PERMIT")).outcome.optionId,
      "allow-1",
    );
    // Ending one session leaves the process and the other session alive.
    await a.endInput();
    await a.done;
    assertEquals(await ask(b, "still"), `echo:${b.sessionId}:still`);
    // The front was told: it closed `a` (it advertises `session/close`).
    assertEquals(await ask(b, "OPEN"), "1");
    const c = await conn.openSession();
    assertEquals(await ask(c, "PID"), pidA);
  } finally {
    await conn.close();
  }
  const status = await conn.done;
  assertEquals(status.success, false); // ended by close(), not by itself
});

Deno.test("FR-L58 close() ends every open session", async () => {
  const conn = await openAcpConnection("claude", {
    processRegistry: new ProcessRegistry(),
    acpFront: STUB_FRONT,
  });
  const s = await conn.openSession();
  await conn.close();
  const { done } = await s.events.next();
  assertEquals(done, true);
  await s.done;
});

Deno.test("FR-L58 the runtime's login variables reach the front", async () => {
  // The caller passes no matcher: the connection picks the runtime's own
  // (FR-L53), so a login token in the parent env survives an isolated env.
  const name = "CLAUDE_CODE_OAUTH_TOKEN";
  const saved = Deno.env.get(name);
  Deno.env.set(name, "conn-token");
  try {
    const conn = await openAcpConnection("claude", {
      processRegistry: new ProcessRegistry(),
      acpFront: STUB_FRONT,
      inheritEnv: false,
    });
    try {
      const s = await conn.openSession();
      assertEquals(await ask(s, `ENV ${name}`), "conn-token");
    } finally {
      await conn.close();
    }
  } finally {
    if (saved === undefined) Deno.env.delete(name);
    else Deno.env.set(name, saved);
  }
});
