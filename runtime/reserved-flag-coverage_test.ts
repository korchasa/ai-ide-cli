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

import { assertEquals } from "@std/assert";
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
  // mode, HITL config, reasoning effort).
  const fresh = buildCodexArgs({
    taskPrompt: "task",
    model: "gpt-5",
    cwd: "/tmp/scratch",
    permissionMode: "bypassPermissions",
    reasoningEffort: "high",
    hitlConfig: {
      ask_script: "a",
      check_script: "b",
      poll_interval: 1,
      timeout: 1,
    },
    hitlMcpCommandBuilder: () => ["my-bin", "--flag"],
    timeoutSeconds: 60,
    maxRetries: 1,
    retryDelaySeconds: 1,
    processRegistry: defaultRegistry,
  });
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
