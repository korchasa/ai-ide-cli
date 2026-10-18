/**
 * @module
 * Claude-only real-binary check for the typed hook lifecycle events
 * (`system.hook_started` / `system.hook_response`, FR-L25) and the
 * out-of-band effort channel Claude Code hands to tool hooks.
 *
 * Hooks are loaded per run through `claudeArgs["--settings"]` — no
 * `~/.claude` mutation, no project-hook approval prompt. Non-`SessionStart`
 * hook events reach stream-json only with `--include-hook-events`
 * (verified on claude v2.1.302). `settingSources: ["local"]` keeps the
 * user's global hooks out: `local` resolves to an absent
 * `<tmp>/.claude/settings.local.json` (FR-L18).
 */

import { assert, assertEquals } from "@std/assert";
import { defaultRegistry } from "../process-registry.ts";
import { invokeClaudeCli } from "../claude/process.ts";
import type {
  ClaudeHookResponseEvent,
  ClaudeHookStartedEvent,
} from "../claude/stream.ts";
import { e2eEnabled } from "./_helpers.ts";

const claudeEnabled = await e2eEnabled("claude");

Deno.test({
  name: "e2e hook-events/claude/typed hook lifecycle + effort sidecar",
  ignore: !claudeEnabled,
  sanitizeOps: false,
  sanitizeResources: false,
  sanitizeExit: false,
  // FR-L25
  fn: async () => {
    const tmp = await Deno.makeTempDir({
      prefix: "ai-ide-cli-e2e-claude-hooks-",
    });
    try {
      await Deno.writeTextFile(`${tmp}/note.txt`, "hello\n");
      const settingsPath = `${tmp}/hook-settings.json`;
      await Deno.writeTextFile(
        settingsPath,
        JSON.stringify({
          hooks: {
            SessionStart: [{
              hooks: [{
                type: "command",
                command: "echo session-start-failed >&2; exit 3",
              }],
            }],
            PreToolUse: [{
              matcher: "Read",
              hooks: [{ type: "command", command: "cat" }],
            }],
          },
        }),
      );

      const started: ClaudeHookStartedEvent[] = [];
      const responses: ClaudeHookResponseEvent[] = [];
      const res = await invokeClaudeCli({
        processRegistry: defaultRegistry,
        taskPrompt: "Read the file note.txt and reply with its content only.",
        timeoutSeconds: 60,
        maxRetries: 1,
        retryDelaySeconds: 0,
        cwd: tmp,
        permissionMode: "plan",
        reasoningEffort: "low",
        settingSources: ["local"],
        claudeArgs: {
          "--settings": settingsPath,
          "--include-hook-events": "",
        },
        hooks: {
          onHookStarted: (e) => started.push(e),
          onHookResponse: (e) => responses.push(e),
        },
        verbosity: "quiet",
      });
      assert(!res.error, `claude run failed: ${res.error ?? ""}`);

      const startedIds = new Set(started.map((e) => e.hook_id));
      for (const r of responses) {
        assert(
          startedIds.has(r.hook_id),
          `hook_response ${r.hook_name} has no hook_started peer`,
        );
      }

      const names = responses.map((r) => r.hook_name);
      const sessionStart = responses.find((r) =>
        r.hook_event === "SessionStart"
      );
      assert(sessionStart, `no SessionStart hook_response; saw: ${names}`);
      assertEquals(sessionStart.outcome, "error");
      assertEquals(sessionStart.exit_code, 3);
      assertEquals(sessionStart.stderr, "session-start-failed\n");

      const preRead = responses.find((r) => r.hook_name === "PreToolUse:Read");
      assert(
        preRead,
        `no PreToolUse:Read hook_response (model skipped the Read tool?); saw: ${names}`,
      );
      assertEquals(preRead.outcome, "success");
      const hookStdin = JSON.parse(preRead.stdout ?? "") as {
        effort?: { level?: string };
      };
      assertEquals(hookStdin.effort?.level, "low");
    } finally {
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    }
  },
});
