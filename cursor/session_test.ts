import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  buildCursorSendArgs,
  createCursorChat,
  type CursorSessionOptions,
  openCursorSession,
} from "./session.ts";

// --- buildCursorSendArgs ---

Deno.test("buildCursorSendArgs — emits agent -p --resume <id> with stream-json", () => {
  const args = buildCursorSendArgs({
    chatId: "chat-123",
    message: "hello",
  });
  assertEquals(args[0], "agent");
  assertEquals(args[1], "-p");
  assertEquals(args[2], "--resume");
  assertEquals(args[3], "chat-123");
  assertEquals(args.includes("--output-format"), true);
  const ofIdx = args.indexOf("--output-format");
  assertEquals(args[ofIdx + 1], "stream-json");
  assertEquals(args.includes("--trust"), true);
  assertEquals(args.at(-1), "hello");
});

Deno.test("buildCursorSendArgs — bypassPermissions adds --yolo", () => {
  const args = buildCursorSendArgs({
    chatId: "c",
    message: "m",
    permissionMode: "bypassPermissions",
  });
  assertEquals(args.includes("--yolo"), true);
});

Deno.test("buildCursorSendArgs — extra map-shape args pass through", () => {
  const args = buildCursorSendArgs({
    chatId: "c",
    message: "m",
    cursorArgs: {
      "--sandbox": "disabled",
      "--include-partial-messages": "",
      "--dropped": null,
    },
  });
  const sIdx = args.indexOf("--sandbox");
  assertEquals(args[sIdx + 1], "disabled");
  assertEquals(args.includes("--include-partial-messages"), true);
  assertEquals(args.includes("--dropped"), false);
});

Deno.test("buildCursorSendArgs — rejects reserved flag in cursorArgs", () => {
  assertThrows(
    () =>
      buildCursorSendArgs({
        chatId: "c",
        message: "m",
        cursorArgs: { "--resume": "other" },
      }),
    Error,
    "--resume",
  );
});

// --- Stub-cursor harness ---
//
// Writes a small shell script named `cursor` that dispatches on argv[1]
// (`agent`) and argv[2] (`create-chat` or `-p`). Tests set environment
// variables to control the stub's behavior per-call.

async function withStubCursor<T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "cursor-session-stub-" });
  const stubPath = `${dir}/cursor`;
  // The stub:
  //   $1 == "agent"
  //   $2 == "create-chat"  -> echo $STUB_CHAT_ID
  //   $2 == "-p"           -> exec $STUB_SEND_SCRIPT (full bash snippet)
  //                           with the prompt as last positional arg
  //                           (we capture the full argv to $STUB_SEND_LOG)
  await Deno.writeTextFile(
    stubPath,
    `#!/usr/bin/env bash
set -e
shift # drop "agent"
if [ "$1" = "create-chat" ]; then
  printf '%s\\n' "\${STUB_CHAT_ID:-stub-chat-1}"
  exit 0
fi
if [ "$1" = "-p" ]; then
  shift # drop "-p"
  if [ -n "$STUB_SEND_LOG" ]; then
    printf '%s\\n' "$@" >> "$STUB_SEND_LOG"
  fi
  if [ -n "$STUB_SEND_SCRIPT" ]; then
    # exec replaces the parent process so SIGTERM from the test reaches
    # the script directly (otherwise a nested bash -c would trap it and
    # the outer shell would still be waiting).
    exec bash -c "$STUB_SEND_SCRIPT" -- "$@"
  fi
  exit 0
fi
echo "unexpected stub args: $@" >&2
exit 99
`,
  );
  await Deno.chmod(stubPath, 0o755);
  const prevPath = Deno.env.get("PATH") ?? "";
  Deno.env.set("PATH", `${dir}:${prevPath}`);
  try {
    return await fn(dir);
  } finally {
    Deno.env.set("PATH", prevPath);
    for (const v of ["STUB_CHAT_ID", "STUB_SEND_SCRIPT", "STUB_SEND_LOG"]) {
      Deno.env.delete(v);
    }
    try {
      await Deno.remove(dir, { recursive: true });
    } catch {
      // best-effort cleanup
    }
  }
}

function makeOpts(
  overrides?: Partial<CursorSessionOptions>,
): CursorSessionOptions {
  return { ...overrides };
}

// --- createCursorChat ---

Deno.test("createCursorChat — returns trimmed chat ID from stdout", async () => {
  await withStubCursor(async () => {
    Deno.env.set("STUB_CHAT_ID", "chat-xyz-789");
    const id = await createCursorChat({
      env: { STUB_CHAT_ID: "chat-xyz-789" },
    });
    assertEquals(id, "chat-xyz-789");
  });
});

Deno.test("createCursorChat — throws on non-zero exit", async () => {
  // Stub that always fails for create-chat.
  const dir = await Deno.makeTempDir({ prefix: "cursor-fail-stub-" });
  const stubPath = `${dir}/cursor`;
  await Deno.writeTextFile(
    stubPath,
    `#!/usr/bin/env bash
echo "auth required" >&2
exit 7
`,
  );
  await Deno.chmod(stubPath, 0o755);
  const prevPath = Deno.env.get("PATH") ?? "";
  Deno.env.set("PATH", `${dir}:${prevPath}`);
  try {
    await assertRejects(
      () => createCursorChat({}),
      Error,
      "create-chat exited with code 7",
    );
  } finally {
    Deno.env.set("PATH", prevPath);
    await Deno.remove(dir, { recursive: true });
  }
});

// --- openCursorSession ---

Deno.test("openCursorSession — synthetic init event carries chatId", async () => {
  await withStubCursor(async () => {
    const session = await openCursorSession(
      makeOpts({ env: { STUB_CHAT_ID: "chat-A" } }),
    );
    assertEquals(session.chatId, "chat-A");
    const it = session.events[Symbol.asyncIterator]();
    const first = await it.next();
    assert(!first.done);
    assertEquals(first.value.type, "system");
    assertEquals(first.value.subtype, "init");
    assertEquals(first.value.session_id, "chat-A");
    assertEquals(first.value.synthetic, true);
    await session.endInput();
    await session.done;
  });
});

Deno.test("openCursorSession — resumeSessionId skips create-chat", async () => {
  await withStubCursor(async () => {
    // Don't set STUB_CHAT_ID — if create-chat were called it would still
    // succeed with default. Better: prove by inspecting send-log only.
    const session = await openCursorSession(
      makeOpts({ resumeSessionId: "preexisting-chat" }),
    );
    assertEquals(session.chatId, "preexisting-chat");
    await session.endInput();
    await session.done;
  });
});

Deno.test("openCursorSession — send produces parsed events and resolves", async () => {
  await withStubCursor(async () => {
    const sendScript = `
cat <<'JSON'
{"type":"system","subtype":"init","session_id":"chat-A","model":"stub"}
{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}
{"type":"result","subtype":"success","session_id":"chat-A","total_cost_usd":0,"duration_ms":1,"duration_api_ms":0,"num_turns":1,"is_error":false,"result":"hi"}
JSON
`;
    const session = await openCursorSession(makeOpts({
      env: {
        STUB_CHAT_ID: "chat-A",
        STUB_SEND_SCRIPT: sendScript,
      },
    }));
    const collected: string[] = [];
    const collector = (async () => {
      for await (const event of session.events) {
        collected.push(event.type);
        if (event.type === "result") break;
      }
    })();
    await session.send("hello");
    await session.endInput();
    await collector;
    await session.done;
    assertEquals(collected, ["system", "system", "assistant", "result"]);
  });
});

Deno.test("openCursorSession — sends are serialized in submit order", async () => {
  await withStubCursor(async () => {
    const dir = await Deno.makeTempDir({ prefix: "cursor-order-" });
    const log = `${dir}/sends.log`;
    try {
      const sendScript = `
prompt="\${@: -1}"
echo "$prompt" >> "$STUB_ORDER_LOG"
printf '%s\\n' '{"type":"result","subtype":"success","result":"ok","session_id":"x","total_cost_usd":0,"duration_ms":1,"duration_api_ms":0,"num_turns":1,"is_error":false}'
`;
      const session = await openCursorSession(makeOpts({
        env: {
          STUB_CHAT_ID: "chat-A",
          STUB_SEND_SCRIPT: sendScript,
          STUB_ORDER_LOG: log,
        },
      }));
      await Promise.all([
        session.send("first"),
        session.send("second"),
        session.send("third"),
      ]);
      await session.endInput();
      await session.done;
      const lines = (await Deno.readTextFile(log)).trim().split("\n");
      assertEquals(lines, ["first", "second", "third"]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
});

Deno.test("openCursorSession — send rejects after endInput", async () => {
  await withStubCursor(async () => {
    const session = await openCursorSession(makeOpts({
      env: { STUB_CHAT_ID: "chat-A" },
    }));
    await session.endInput();
    await assertRejects(
      () => session.send("late"),
      Error,
      "input already closed",
    );
    await session.done;
  });
});

Deno.test("openCursorSession — abort kills active subprocess", async () => {
  await withStubCursor(async () => {
    const sendScript = `trap 'exit 143' TERM; while true; do sleep 1; done`;
    const session = await openCursorSession(makeOpts({
      env: { STUB_CHAT_ID: "chat-A", STUB_SEND_SCRIPT: sendScript },
    }));
    const sendPromise = session.send("hello");
    // Give the subprocess a moment to actually start.
    await new Promise((r) => setTimeout(r, 100));
    session.abort("test");
    await assertRejects(() => sendPromise, Error);
    const status = await session.done;
    // Either the script's TERM trap (143) ran, or SIGTERM hit before trap.
    assert(
      status.exitCode === 143 || status.signal === "SIGTERM",
      `expected exitCode=143 or signal=SIGTERM, got ${JSON.stringify(status)}`,
    );
  });
});

Deno.test("openCursorSession — external AbortSignal SIGTERMs subprocess", async () => {
  await withStubCursor(async () => {
    const sendScript = `trap 'exit 143' TERM; while true; do sleep 1; done`;
    const controller = new AbortController();
    const session = await openCursorSession(makeOpts({
      signal: controller.signal,
      env: { STUB_CHAT_ID: "chat-A", STUB_SEND_SCRIPT: sendScript },
    }));
    const sendPromise = session.send("hello");
    setTimeout(() => controller.abort("external"), 100);
    await assertRejects(() => sendPromise, Error);
    const status = await session.done;
    assert(status.exitCode === 143 || status.signal === "SIGTERM");
  });
});

// Prompts may contain embedded newlines (systemPrompt prepend), so the stub
// logs them null-separated for round-tripping through the test.
const promptLogScript = `
prompt="\${@: -1}"
printf '%s\\0' "$prompt" >> "$STUB_PROMPT_LOG"
printf '%s\\n' '{"type":"result","subtype":"success","result":"ok","session_id":"x","total_cost_usd":0,"duration_ms":1,"duration_api_ms":0,"num_turns":1,"is_error":false}'
`;

function readPromptLog(path: string): Promise<string[]> {
  return Deno.readTextFile(path).then((raw) =>
    raw.split("\0").filter((s) => s.length > 0)
  );
}

Deno.test("openCursorSession — first send merges systemPrompt", async () => {
  await withStubCursor(async () => {
    const dir = await Deno.makeTempDir({ prefix: "cursor-sp-" });
    const log = `${dir}/sends.log`;
    try {
      const session = await openCursorSession(makeOpts({
        systemPrompt: "SYSTEM-X",
        env: {
          STUB_CHAT_ID: "chat-A",
          STUB_SEND_SCRIPT: promptLogScript,
          STUB_PROMPT_LOG: log,
        },
      }));
      await session.send("first");
      await session.send("second");
      await session.endInput();
      await session.done;
      const captured = await readPromptLog(log);
      assertEquals(captured.length, 2);
      assertEquals(captured[0], "SYSTEM-X\n\nfirst");
      assertEquals(captured[1], "second");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
});

Deno.test("openCursorSession — resumeSessionId suppresses systemPrompt prepend", async () => {
  await withStubCursor(async () => {
    const dir = await Deno.makeTempDir({ prefix: "cursor-sp-resume-" });
    const log = `${dir}/sends.log`;
    try {
      const session = await openCursorSession(makeOpts({
        systemPrompt: "SYSTEM-X",
        resumeSessionId: "preexisting",
        env: {
          STUB_SEND_SCRIPT: promptLogScript,
          STUB_PROMPT_LOG: log,
        },
      }));
      await session.send("first");
      await session.endInput();
      await session.done;
      const captured = await readPromptLog(log);
      assertEquals(captured, ["first"]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
});
