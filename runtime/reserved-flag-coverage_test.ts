/**
 * Cross-runtime coverage test that the per-runtime `*_RESERVED_FLAGS`
 * constants stay in sync with what each `buildXArgs` actually emits.
 *
 * Two assertions per builder:
 *
 * 1. **Coverage**: every flag-shaped argv token (starts with `-`,
 *    excluding the bare `--` separator) emitted by the builder is
 *    either in `<RUNTIME>_RESERVED_FLAGS` or in
 *    `<RUNTIME>_INTENTIONALLY_OPEN_FLAGS`. A flag that's neither is a
 *    drift symptom — the runtime emits it but `extraArgs` collisions
 *    won't be caught.
 * 2. **Symmetric**: every key in `<RUNTIME>_RESERVED_FLAGS` shows up in
 *    the union of argv across all scenario inputs for that builder,
 *    catching stale reservations after refactors.
 *
 * Adding a flag to a builder without updating one of the two lists
 * fails one of these assertions immediately.
 */

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { defaultRegistry } from "../process-registry.ts";
import {
  buildClaudeArgs,
  CLAUDE_INTENTIONALLY_OPEN_FLAGS,
  CLAUDE_RESERVED_FLAGS,
} from "../claude/process.ts";
import { buildClaudeSessionArgs } from "../claude/session.ts";
import {
  buildOpenCodeArgs,
  OPENCODE_INTENTIONALLY_OPEN_FLAGS,
  OPENCODE_RESERVED_FLAGS,
} from "../opencode/process.ts";
import {
  buildCursorArgs,
  CURSOR_INTENTIONALLY_OPEN_FLAGS,
  CURSOR_RESERVED_FLAGS,
} from "../cursor/process.ts";
import { buildCursorSendArgs } from "../cursor/session.ts";
import {
  buildCodexArgs,
  CODEX_INTENTIONALLY_OPEN_FLAGS,
  CODEX_RESERVED_FLAGS,
} from "../codex/process.ts";
import {
  CODEX_APP_SERVER_INTENTIONALLY_OPEN_FLAGS,
  CODEX_APP_SERVER_RESERVED_FLAGS,
} from "../codex/app-server.ts";
import { expandCodexSessionExtraArgs } from "../codex/session.ts";
import { getRuntimeAdapter } from "./index.ts";
import { RuntimeUnsupportedOptionError } from "./run-options.ts";

/** Extract argv tokens that look like CLI flags (start with `-`, not bare `--`). */
function flagsOnly(argv: string[]): string[] {
  return argv.filter((tok) => tok.startsWith("-") && tok !== "--");
}

/**
 * Coverage assertion: every emitted flag is reserved or intentionally
 * open. Run per builder.
 */
function assertCoverage(
  label: string,
  reserved: readonly string[],
  intentionallyOpen: readonly string[],
  argv: string[],
) {
  for (const flag of flagsOnly(argv)) {
    const isReserved = reserved.includes(flag);
    const isOpen = intentionallyOpen.includes(flag);
    if (!isReserved && !isOpen) {
      throw new Error(
        `${label}: emitted flag "${flag}" is neither reserved nor in ` +
          `INTENTIONALLY_OPEN_FLAGS. Either add it to the reserved list ` +
          `(if extraArgs must not duplicate it) or to the intentionally-` +
          `open list (with a JSDoc reason).`,
      );
    }
  }
}

/**
 * Symmetric assertion: every reserved entry shows up somewhere in the
 * union of argv across all related builders (one-shot + session) —
 * catches stale reservations after refactors.
 */
function assertSymmetricCoverage(
  label: string,
  reserved: readonly string[],
  argvUnion: string[],
) {
  const set = new Set(argvUnion);
  const stale = reserved.filter((entry) => !set.has(entry));
  assertEquals(
    stale,
    [],
    `${label}: reserved entries never emitted by any builder (stale): ${
      stale.join(", ")
    }`,
  );
}

Deno.test("reserved-flag coverage — Claude (one-shot + session)", () => {
  // Maximal fresh-run scenario hits every one-shot emit branch.
  const oneShotFresh = buildClaudeArgs({
    taskPrompt: "task",
    systemPrompt: "sys",
    agent: "a",
    model: "claude-sonnet-4-5",
    permissionMode: "plan",
    allowedTools: ["Read", "Bash"],
    reasoningEffort: "high",
    outputSchema: { type: "object" },
    ephemeral: true,
    timeoutSeconds: 60,
    maxRetries: 1,
    retryDelaySeconds: 1,
    processRegistry: defaultRegistry,
  });
  // Resume covers --resume, suppresses --agent / --model /
  // --append-system-prompt / --effort.
  const oneShotResume = buildClaudeArgs({
    taskPrompt: "task",
    resumeSessionId: "sess-1",
    permissionMode: "default",
    disallowedTools: ["Read"],
    timeoutSeconds: 60,
    maxRetries: 1,
    retryDelaySeconds: 1,
    processRegistry: defaultRegistry,
  });
  // Session builder additionally emits --input-format.
  const sessionFresh = buildClaudeSessionArgs({
    systemPrompt: "sys",
    agent: "a",
    model: "claude-sonnet-4-5",
    permissionMode: "plan",
    allowedTools: ["Read"],
    reasoningEffort: "high",
    outputSchema: { type: "object" },
    ephemeral: true,
    processRegistry: defaultRegistry,
  });
  const sessionResume = buildClaudeSessionArgs({
    resumeSessionId: "sess-1",
    permissionMode: "default",
    disallowedTools: ["Read"],
    processRegistry: defaultRegistry,
  });

  for (
    const argv of [oneShotFresh, oneShotResume, sessionFresh, sessionResume]
  ) {
    assertCoverage(
      "buildClaudeArgs/buildClaudeSessionArgs",
      CLAUDE_RESERVED_FLAGS,
      CLAUDE_INTENTIONALLY_OPEN_FLAGS,
      argv,
    );
  }
  assertSymmetricCoverage(
    "Claude one-shot + session",
    CLAUDE_RESERVED_FLAGS,
    [...oneShotFresh, ...oneShotResume, ...sessionFresh, ...sessionResume],
  );
});

Deno.test("reserved-flag coverage — OpenCode", () => {
  const fresh = buildOpenCodeArgs({
    taskPrompt: "task",
    model: "x",
    agent: "y",
    permissionMode: "bypassPermissions",
    reasoningEffort: "high",
    timeoutSeconds: 60,
    maxRetries: 1,
    retryDelaySeconds: 1,
    processRegistry: defaultRegistry,
  });
  const resume = buildOpenCodeArgs({
    taskPrompt: "task",
    resumeSessionId: "sess-1",
    timeoutSeconds: 60,
    maxRetries: 1,
    retryDelaySeconds: 1,
    processRegistry: defaultRegistry,
  });

  for (const argv of [fresh, resume]) {
    assertCoverage(
      "buildOpenCodeArgs",
      OPENCODE_RESERVED_FLAGS,
      OPENCODE_INTENTIONALLY_OPEN_FLAGS,
      argv,
    );
  }
  assertSymmetricCoverage("OpenCode", OPENCODE_RESERVED_FLAGS, [
    ...fresh,
    ...resume,
  ]);
});

Deno.test("reserved-flag coverage — Cursor (one-shot + session send)", () => {
  const oneShotFresh = buildCursorArgs({
    taskPrompt: "task",
    model: "x",
    permissionMode: "bypassPermissions",
    timeoutSeconds: 60,
    maxRetries: 1,
    retryDelaySeconds: 1,
    processRegistry: defaultRegistry,
  });
  const oneShotResume = buildCursorArgs({
    taskPrompt: "task",
    resumeSessionId: "chat-1",
    timeoutSeconds: 60,
    maxRetries: 1,
    retryDelaySeconds: 1,
    processRegistry: defaultRegistry,
  });
  const sendBypass = buildCursorSendArgs({
    chatId: "chat-1",
    message: "msg",
    permissionMode: "bypassPermissions",
  });
  const sendDefault = buildCursorSendArgs({
    chatId: "chat-1",
    message: "msg",
    permissionMode: "default",
  });

  for (
    const argv of [oneShotFresh, oneShotResume, sendBypass, sendDefault]
  ) {
    assertCoverage(
      "buildCursorArgs/buildCursorSendArgs",
      CURSOR_RESERVED_FLAGS,
      CURSOR_INTENTIONALLY_OPEN_FLAGS,
      argv,
    );
  }
  assertSymmetricCoverage(
    "Cursor one-shot + session send",
    CURSOR_RESERVED_FLAGS,
    [...oneShotFresh, ...oneShotResume, ...sendBypass, ...sendDefault],
  );
});

Deno.test("reserved-flag coverage — Codex one-shot", () => {
  // Fresh run hits every branch (model, cwd, sandbox via permission
  // mode, reasoning effort).
  const fresh = buildCodexArgs({
    taskPrompt: "task",
    model: "gpt-5",
    cwd: "/tmp/scratch",
    permissionMode: "bypassPermissions",
    reasoningEffort: "high",
    ephemeral: true,
    timeoutSeconds: 60,
    maxRetries: 1,
    retryDelaySeconds: 1,
    processRegistry: defaultRegistry,
  }, "/tmp/schema.json");
  // Resume run covers `resume <id>` positional.
  const resume = buildCodexArgs({
    taskPrompt: "task",
    resumeSessionId: "thread-1",
    timeoutSeconds: 60,
    maxRetries: 1,
    retryDelaySeconds: 1,
    processRegistry: defaultRegistry,
  });

  for (const argv of [fresh, resume]) {
    assertCoverage(
      "buildCodexArgs",
      CODEX_RESERVED_FLAGS,
      CODEX_INTENTIONALLY_OPEN_FLAGS,
      argv,
    );
  }
  assertSymmetricCoverage("Codex one-shot", CODEX_RESERVED_FLAGS, [
    ...fresh,
    ...resume,
  ]);
});

Deno.test("reserved-flag coverage — Codex app-server (session extraArgv)", () => {
  // The app-server transport receives `extraArgs` directly (validated
  // against CODEX_APP_SERVER_RESERVED_FLAGS inside spawn()). The session
  // builder prepends `--config model_reasoning_effort=…` when the typed
  // reasoning-effort field is set. Reconstruct the full argv as it
  // would appear at the spawn boundary so we exercise the literal
  // `app-server` / `--listen` tokens together with the session-emitted
  // `--config` overrides.
  const sessionExtraArgvWithEffort = [
    "--config",
    `model_reasoning_effort="high"`,
    ...expandCodexSessionExtraArgs({ "--config": 'approval_policy="never"' }),
  ];
  const fullArgv = [
    "app-server",
    ...sessionExtraArgvWithEffort,
    "--listen",
    "stdio://",
  ];

  assertCoverage(
    "codex app-server",
    CODEX_APP_SERVER_RESERVED_FLAGS,
    CODEX_APP_SERVER_INTENTIONALLY_OPEN_FLAGS,
    fullArgv,
  );
  assertSymmetricCoverage(
    "codex app-server",
    CODEX_APP_SERVER_RESERVED_FLAGS,
    fullArgv,
  );
});

const BASE_INVOKE = {
  taskPrompt: "task",
  timeoutSeconds: 60,
  maxRetries: 1,
  retryDelaySeconds: 1,
  processRegistry: defaultRegistry,
};

/** Return the value that follows `flag` in `argv`, or `undefined`. */
function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

Deno.test("FR-L50 outputSchema maps to each runtime flag", async () => {
  const schema = { type: "object", required: ["a"] };
  assertEquals(
    flagValue(
      buildClaudeArgs({ ...BASE_INVOKE, outputSchema: schema }),
      "--json-schema",
    ),
    JSON.stringify(schema),
  );
  assertEquals(
    flagValue(
      buildClaudeSessionArgs({
        outputSchema: schema,
        processRegistry: defaultRegistry,
      }),
      "--json-schema",
    ),
    JSON.stringify(schema),
  );
  // Codex: the runner owns the temp file; the builder places its path
  // before the `resume <id>` positional.
  const codexResume = buildCodexArgs(
    { ...BASE_INVOKE, resumeSessionId: "thread-1" },
    "/tmp/s.json",
  );
  assertEquals(flagValue(codexResume, "--output-schema"), "/tmp/s.json");
  assert(
    codexResume.indexOf("--output-schema") < codexResume.indexOf("resume"),
  );
  assertEquals(buildCodexArgs(BASE_INVOKE).includes("--output-schema"), false);
  // Typed field + the same flag in extraArgs is refused.
  assertThrows(
    () =>
      buildClaudeArgs({
        ...BASE_INVOKE,
        outputSchema: schema,
        claudeArgs: { "--json-schema": "{}" },
      }),
    Error,
    "collides with typed outputSchema",
  );
  for (const runtime of ["opencode", "cursor"] as const) {
    const adapter = getRuntimeAdapter(runtime);
    assertThrows(
      () => adapter.invoke({ ...BASE_INVOKE, outputSchema: schema }),
      RuntimeUnsupportedOptionError,
    );
    await assertRejects(
      () =>
        adapter.openSession!({
          processRegistry: defaultRegistry,
          outputSchema: schema,
        }),
      RuntimeUnsupportedOptionError,
    );
  }
});

Deno.test("FR-L52 ephemeral maps to each runtime flag", async () => {
  assert(
    buildClaudeArgs({ ...BASE_INVOKE, ephemeral: true }).includes(
      "--no-session-persistence",
    ),
  );
  assert(
    buildClaudeSessionArgs({
      ephemeral: true,
      processRegistry: defaultRegistry,
    })
      .includes("--no-session-persistence"),
  );
  assert(
    buildCodexArgs({ ...BASE_INVOKE, ephemeral: true }).includes("--ephemeral"),
  );
  assertEquals(buildCodexArgs(BASE_INVOKE).includes("--ephemeral"), false);
  assertEquals(
    buildClaudeArgs({ ...BASE_INVOKE, ephemeral: false }).includes(
      "--no-session-persistence",
    ),
    false,
  );
  assertThrows(
    () =>
      buildCodexArgs({
        ...BASE_INVOKE,
        ephemeral: true,
        extraArgs: { "--ephemeral": "" },
      }),
    Error,
    "collides with typed ephemeral",
  );
  for (const runtime of ["opencode", "cursor"] as const) {
    const adapter = getRuntimeAdapter(runtime);
    assertThrows(
      () => adapter.invoke({ ...BASE_INVOKE, ephemeral: true }),
      RuntimeUnsupportedOptionError,
    );
    await assertRejects(
      () =>
        adapter.openSession!({
          processRegistry: defaultRegistry,
          ephemeral: true,
        }),
      RuntimeUnsupportedOptionError,
    );
  }
});
