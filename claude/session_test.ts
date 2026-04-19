import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  buildClaudeSessionArgs,
  type ClaudeSessionOptions,
  openClaudeSession,
} from "./session.ts";
import { SessionInputClosedError } from "../runtime/types.ts";

function makeOpts(
  overrides?: Partial<ClaudeSessionOptions>,
): ClaudeSessionOptions {
  return { ...overrides };
}

// --- buildClaudeSessionArgs ---

Deno.test("buildClaudeSessionArgs — emits -p bare and streaming transport flags", () => {
  const args = buildClaudeSessionArgs(makeOpts());
  // -p without value
  const pIdx = args.indexOf("-p");
  assert(pIdx >= 0);
  // Next token after -p must be the first of the transport block, not a value.
  assertEquals(args[pIdx + 1], "--output-format");
  assertEquals(args.includes("--input-format"), true);
  const ifIdx = args.indexOf("--input-format");
  assertEquals(args[ifIdx + 1], "stream-json");
  const ofIdx = args.indexOf("--output-format");
  assertEquals(args[ofIdx + 1], "stream-json");
  assertEquals(args.includes("--verbose"), true);
});

Deno.test("buildClaudeSessionArgs — permission mode precedes extras and transport flags", () => {
  const args = buildClaudeSessionArgs(
    makeOpts({ permissionMode: "acceptEdits" }),
  );
  const pmIdx = args.indexOf("--permission-mode");
  const pIdx = args.indexOf("-p");
  assertEquals(args[pmIdx + 1], "acceptEdits");
  assert(pmIdx < pIdx);
});

Deno.test("buildClaudeSessionArgs — resume suppresses agent/system-prompt/model", () => {
  const args = buildClaudeSessionArgs(makeOpts({
    resumeSessionId: "abc-123",
    agent: "reviewer",
    systemPrompt: "You are helpful.",
    model: "sonnet",
  }));
  const rIdx = args.indexOf("--resume");
  assertEquals(args[rIdx + 1], "abc-123");
  assertEquals(args.includes("--agent"), false);
  assertEquals(args.includes("--append-system-prompt"), false);
  assertEquals(args.includes("--model"), false);
});

Deno.test("buildClaudeSessionArgs — initial run emits agent, system prompt, model", () => {
  const args = buildClaudeSessionArgs(makeOpts({
    agent: "reviewer",
    systemPrompt: "You are helpful.",
    model: "sonnet",
  }));
  const aIdx = args.indexOf("--agent");
  assertEquals(args[aIdx + 1], "reviewer");
  const spIdx = args.indexOf("--append-system-prompt");
  assertEquals(args[spIdx + 1], "You are helpful.");
  const mIdx = args.indexOf("--model");
  assertEquals(args[mIdx + 1], "sonnet");
});

Deno.test("buildClaudeSessionArgs — map-shape claudeArgs pass through", () => {
  const args = buildClaudeSessionArgs(makeOpts({
    claudeArgs: {
      "--mcp-config": "/tmp/cfg.json",
      "--include-partial-messages": "",
      "--dropped": null,
    },
  }));
  const mcpIdx = args.indexOf("--mcp-config");
  assertEquals(args[mcpIdx + 1], "/tmp/cfg.json");
  assertEquals(args.includes("--include-partial-messages"), true);
  assertEquals(args.includes("--dropped"), false);
});

Deno.test("buildClaudeSessionArgs — rejects reserved --input-format in claudeArgs", () => {
  assertThrows(
    () =>
      buildClaudeSessionArgs(makeOpts({
        claudeArgs: { "--input-format": "stream-json" },
      })),
    Error,
    "--input-format",
  );
});

Deno.test("buildClaudeSessionArgs — rejects reserved --output-format in claudeArgs", () => {
  assertThrows(
    () =>
      buildClaudeSessionArgs(makeOpts({
        claudeArgs: { "--output-format": "json" },
      })),
    Error,
    "--output-format",
  );
});

// --- openClaudeSession runtime behavior (uses a stub binary on PATH) ---

/**
 * Write a small shell script that echoes a fixed NDJSON result line and
 * exits, then point PATH at its directory so `claude` resolves to the stub.
 */
async function withStubClaude<T>(
  script: string,
  fn: (cwd: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "claude-session-stub-" });
  const stubPath = `${dir}/claude`;
  await Deno.writeTextFile(stubPath, `#!/usr/bin/env bash\n${script}\n`);
  await Deno.chmod(stubPath, 0o755);
  const prevPath = Deno.env.get("PATH") ?? "";
  Deno.env.set("PATH", `${dir}:${prevPath}`);
  try {
    return await fn(dir);
  } finally {
    Deno.env.set("PATH", prevPath);
    try {
      await Deno.remove(dir, { recursive: true });
    } catch {
      // best-effort cleanup
    }
  }
}

Deno.test("openClaudeSession — events iterable yields parsed stream-json", async () => {
  await withStubClaude(
    // Emit one system event and one result event, then exit.
    `cat <<'EOF'
{"type":"system","subtype":"init","session_id":"stub-1","model":"stub"}
{"type":"result","subtype":"success","result":"ok","session_id":"stub-1","total_cost_usd":0,"duration_ms":1,"duration_api_ms":0,"num_turns":0,"is_error":false}
EOF`,
    async () => {
      const session = await openClaudeSession({});
      const collected: string[] = [];
      for await (const event of session.events) {
        collected.push(event.type);
        if (event.type === "result") break;
      }
      session.abort();
      await session.done;
      assertEquals(collected, ["system", "result"]);
    },
  );
});

Deno.test("openClaudeSession — send throws SessionInputClosedError after endInput", async () => {
  await withStubClaude(
    // Stay alive until stdin closes.
    `cat > /dev/null`,
    async () => {
      const session = await openClaudeSession({});
      await session.endInput();
      await assertRejects(() => session.send("late"), SessionInputClosedError);
      await session.done;
    },
  );
});

Deno.test("openClaudeSession — abort() kills subprocess and resolves done", async () => {
  await withStubClaude(
    // Sleep forever — only SIGTERM can kill us.
    `trap 'exit 143' TERM; while true; do sleep 1; done`,
    async () => {
      const session = await openClaudeSession({});
      session.abort("test");
      const status = await session.done;
      // Either exitCode=143 (script trap) or signal=SIGTERM (before trap).
      assert(status.exitCode === 143 || status.signal === "SIGTERM");
    },
  );
});

Deno.test("openClaudeSession — external signal triggers SIGTERM", async () => {
  await withStubClaude(
    `trap 'exit 143' TERM; while true; do sleep 1; done`,
    async () => {
      const controller = new AbortController();
      const session = await openClaudeSession({ signal: controller.signal });
      setTimeout(() => controller.abort("external"), 100);
      const status = await session.done;
      assert(status.exitCode === 143 || status.signal === "SIGTERM");
    },
  );
});

Deno.test("openClaudeSession — send writes JSONL to stdin in user-message shape", async () => {
  await withStubClaude(
    // Echo each stdin line to a temp file we read back after exit.
    `cat > "$STUB_CAPTURE"`,
    async (dir) => {
      const capture = `${dir}/stdin.log`;
      const env = { STUB_CAPTURE: capture };
      const session = await openClaudeSession({ env });
      await session.send("hello");
      await session.send({
        type: "user",
        message: { role: "user", content: "explicit" },
      });
      await session.endInput();
      await session.done;
      const lines = (await Deno.readTextFile(capture)).trim().split("\n");
      assertEquals(lines.length, 2);
      assertEquals(JSON.parse(lines[0]), {
        type: "user",
        message: { role: "user", content: "hello" },
      });
      assertEquals(JSON.parse(lines[1]), {
        type: "user",
        message: { role: "user", content: "explicit" },
      });
    },
  );
});

// --- Tool filter parity (FR-L24) ---

Deno.test("buildClaudeSessionArgs — allowedTools single tool emits two argv tokens", () => {
  const args = buildClaudeSessionArgs(makeOpts({ allowedTools: ["Read"] }));
  const idx = args.indexOf("--allowedTools");
  assert(idx >= 0);
  assertEquals(args[idx + 1], "Read");
});

Deno.test("buildClaudeSessionArgs — allowedTools multi-tool comma-joined into two argv tokens", () => {
  const args = buildClaudeSessionArgs(
    makeOpts({ allowedTools: ["Read", "Bash(git *)", "Edit"] }),
  );
  const idx = args.indexOf("--allowedTools");
  assert(idx >= 0);
  assertEquals(args[idx + 1], "Read,Bash(git *),Edit");
  const next = args[idx + 2];
  assertEquals(next === "Bash(git *)" || next === "Edit", false);
});

Deno.test("buildClaudeSessionArgs — disallowedTools emits --disallowedTools with comma join", () => {
  const args = buildClaudeSessionArgs(
    makeOpts({ disallowedTools: ["Bash(git push *)", "Edit"] }),
  );
  const idx = args.indexOf("--disallowedTools");
  assert(idx >= 0);
  assertEquals(args[idx + 1], "Bash(git push *),Edit");
});

Deno.test("buildClaudeSessionArgs — resume path still emits --allowedTools", () => {
  const args = buildClaudeSessionArgs(
    makeOpts({
      resumeSessionId: "ses_abc",
      allowedTools: ["Read"],
    }),
  );
  const idx = args.indexOf("--allowedTools");
  assert(idx >= 0);
  assertEquals(args[idx + 1], "Read");
});

Deno.test("buildClaudeSessionArgs — both typed fields set throws", () => {
  assertThrows(
    () =>
      buildClaudeSessionArgs(
        makeOpts({
          allowedTools: ["Read"],
          disallowedTools: ["Bash"],
        }),
      ),
    Error,
    "mutually exclusive",
  );
});

Deno.test("buildClaudeSessionArgs — typed field + --allowedTools in claudeArgs throws", () => {
  assertThrows(
    () =>
      buildClaudeSessionArgs(
        makeOpts({
          allowedTools: ["Read"],
          claudeArgs: { "--allowedTools": "Read" },
        }),
      ),
    Error,
    'extraArgs key "--allowedTools"',
  );
});

Deno.test("buildClaudeSessionArgs — typed field + --tools in claudeArgs throws", () => {
  assertThrows(
    () =>
      buildClaudeSessionArgs(
        makeOpts({
          allowedTools: ["Read"],
          claudeArgs: { "--tools": "default" },
        }),
      ),
    Error,
    'extraArgs key "--tools"',
  );
});

Deno.test("buildClaudeSessionArgs — legacy path (claudeArgs --allowedTools only) still works", () => {
  const args = buildClaudeSessionArgs(
    makeOpts({ claudeArgs: { "--allowedTools": "Read,Grep" } }),
  );
  const idx = args.indexOf("--allowedTools");
  assert(idx >= 0);
  assertEquals(args[idx + 1], "Read,Grep");
});

Deno.test("buildClaudeSessionArgs — empty allowedTools array throws", () => {
  assertThrows(
    () => buildClaudeSessionArgs(makeOpts({ allowedTools: [] })),
    Error,
    "non-empty",
  );
});

Deno.test("buildClaudeSessionArgs — empty-string member throws", () => {
  assertThrows(
    () => buildClaudeSessionArgs(makeOpts({ allowedTools: [""] })),
    Error,
    "non-empty strings",
  );
});
