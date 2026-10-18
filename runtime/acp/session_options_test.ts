import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { ProcessRegistry } from "../../process-registry.ts";
import type { RuntimeSession } from "../types.ts";
import { openSessionViaAcp } from "./adapter.ts";
import { ask, STUB_FRONT } from "./testdata/stub_front_helpers.ts";
import { getRuntimeAdapter } from "../index.ts";
import { RuntimeUnsupportedOptionError } from "../run-options.ts";

async function withSession<T>(
  opts: Partial<Parameters<typeof openSessionViaAcp>[1]>,
  fn: (s: RuntimeSession) => Promise<T>,
): Promise<T> {
  const session = await openSessionViaAcp("claude", {
    processRegistry: new ProcessRegistry(),
    acpFront: STUB_FRONT,
    ...opts,
  });
  try {
    return await fn(session);
  } finally {
    session.abort();
    await session.done;
  }
}

Deno.test("FR-L55 session permission requests reach onToolUseObserved", async () => {
  const seen: string[] = [];
  const reply = await withSession(
    {
      onToolUseObserved: (info) => {
        seen.push(info.name);
        return "allow";
      },
    },
    (s) => ask(s, "PERMIT"),
  );
  assertEquals(seen, ["Write"]);
  assertEquals(JSON.parse(reply), {
    outcome: { outcome: "selected", optionId: "allow-1" },
  });
});

Deno.test("FR-L55 a session without the callback still rejects", async () => {
  const reply = await withSession({}, (s) => ask(s, "PERMIT"));
  assertEquals(JSON.parse(reply), {
    outcome: { outcome: "selected", optionId: "reject-1" },
  });
});

Deno.test("FR-L55 non-ACP session transports refuse the ACP-only options", async () => {
  for (const runtime of ["claude", "codex", "opencode", "cursor"] as const) {
    for (
      const extra of [
        { onToolUseObserved: () => "allow" as const },
        { acpClientFs: { writeRoot: "/tmp" } },
        { acpSessionMeta: { a: 1 } },
      ]
    ) {
      await assertRejects(
        async () =>
          await getRuntimeAdapter(runtime).openSession!({
            processRegistry: new ProcessRegistry(),
            ...extra,
          }),
        RuntimeUnsupportedOptionError,
        Object.keys(extra)[0],
      );
    }
  }
});

Deno.test("FR-L56 without acpClientFs the fs capability stays declined", async () => {
  const reply = await withSession({}, (s) => ask(s, "INIT"));
  assertEquals(JSON.parse(reply).fs, {
    readTextFile: false,
    writeTextFile: false,
  });
});

Deno.test("FR-L56 client fs anchors relative paths and refuses writes outside writeRoot", async () => {
  const root = await Deno.makeTempDir({ prefix: "acp-fs-" });
  const outside = await Deno.makeTempDir({ prefix: "acp-fs-out-" });
  try {
    await Deno.writeTextFile(join(root, "in.txt"), "inside\n");
    await withSession(
      { cwd: root, acpClientFs: { writeRoot: root } },
      async (s) => {
        assertEquals(JSON.parse(await ask(s, "INIT")).fs, {
          readTextFile: true,
          writeTextFile: true,
        });
        assertEquals(JSON.parse(await ask(s, "READ in.txt")), {
          content: "inside\n",
        });
        await ask(s, "WRITE sub/out.txt hello");
        assertEquals(
          await Deno.readTextFile(join(root, "sub/out.txt")),
          "hello",
        );
        const refused = JSON.parse(
          await ask(s, `WRITE ${join(outside, "x.txt")} no`),
        );
        assert(String(refused.message).includes("outside"), refused.message);
        const escaped = JSON.parse(await ask(s, "WRITE ../escape.txt no"));
        assert(String(escaped.message).includes("outside"), escaped.message);
      },
    );
    assertEquals([...Deno.readDirSync(outside)].length, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("FR-L57 session/new carries acpSessionMeta as _meta", async () => {
  const meta = { claudeCode: { options: { tools: [], effort: "low" } } };
  const reply = await withSession(
    { acpSessionMeta: meta },
    (s) => ask(s, "META"),
  );
  assertEquals(JSON.parse(reply), meta);
});

Deno.test("FR-L59 turn-end never overtakes the turn's last chunks", async () => {
  // The prompt response resolves `send()` while the drain loop may still
  // hold chunks the front wrote before it; turn-end must queue after them.
  for (let i = 0; i < 5; i++) {
    const reply = await withSession({}, (s) => ask(s, "BURST 300"));
    assertEquals(reply.length, 300);
  }
});

Deno.test("FR-L60 abort after the front died raises nothing uncaught", async () => {
  // `abort()` sends `session/cancel` into a pipe whose reader is gone; the
  // write's rejection must not escape as an unhandled one.
  const session = await openSessionViaAcp("claude", {
    processRegistry: new ProcessRegistry(),
    acpFront: STUB_FRONT,
  });
  await assertRejects(() => session.send("DIE"));
  session.abort();
  await session.done;
  // Give a dangling rejection the macrotask it needs to surface.
  await new Promise((r) => setTimeout(r, 50));
});
