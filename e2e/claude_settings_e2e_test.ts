/**
 * @module
 * Claude-only `settingSources` scenarios (FR-L18) against the real binary.
 * `settingSources` maps to `--setting-sources`, so a cleanroom run keeps
 * the host login, and each source is gated on its own.
 */

import { assert, assertEquals } from "@std/assert";
import { defaultRegistry } from "../process-registry.ts";
import { invokeClaudeCli } from "../claude/process.ts";
import { e2eEnabled, ONE_WORD_OK } from "./_helpers.ts";

const claudeEnabled = await e2eEnabled("claude");

Deno.test({
  name: "e2e settings/claude/settingSources=[] stays logged in",
  ignore: !claudeEnabled,
  fn: async () => {
    const res = await invokeClaudeCli({
      processRegistry: defaultRegistry,
      taskPrompt: ONE_WORD_OK,
      timeoutSeconds: 60,
      maxRetries: 1,
      retryDelaySeconds: 1,
      permissionMode: "plan",
      settingSources: [],
      verbosity: "quiet",
    });
    assert(!res.error, `claude run failed: ${res.error ?? ""}`);
    assert(res.output !== undefined, "no output from claude");
  },
});

Deno.test({
  name: "e2e settings/claude/settingSources=[local] loads only local settings",
  ignore: !claudeEnabled,
  fn: async () => {
    const tmp = await Deno.makeTempDir({
      prefix: "ai-ide-cli-e2e-claude-settings-",
    });
    try {
      await Deno.mkdir(`${tmp}/.claude`);
      const touchHook = (marker: string) =>
        JSON.stringify({
          hooks: {
            SessionStart: [{
              hooks: [{
                type: "command",
                command: `touch "$CLAUDE_PROJECT_DIR/${marker}"`,
              }],
            }],
          },
        });
      await Deno.writeTextFile(
        `${tmp}/.claude/settings.json`,
        touchHook("marker-project"),
      );
      await Deno.writeTextFile(
        `${tmp}/.claude/settings.local.json`,
        touchHook("marker-local"),
      );
      const res = await invokeClaudeCli({
        processRegistry: defaultRegistry,
        taskPrompt: ONE_WORD_OK,
        timeoutSeconds: 60,
        maxRetries: 1,
        retryDelaySeconds: 1,
        cwd: tmp,
        permissionMode: "plan",
        settingSources: ["local"],
        verbosity: "quiet",
      });
      assert(!res.error, `claude run failed: ${res.error ?? ""}`);
      const markers: string[] = [];
      for await (const e of Deno.readDir(tmp)) {
        if (e.name.startsWith("marker-")) markers.push(e.name);
      }
      assertEquals(markers, ["marker-local"]);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
});
