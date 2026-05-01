/**
 * @module
 * Claude-only `settingSources: []` cleanroom scenario (FR-L18). End-to-end
 * check that `invokeClaudeCli` completes cleanly against an empty
 * `CLAUDE_CONFIG_DIR`. Ported from `scripts/smoke.ts`.
 */

import { assert } from "@std/assert";
import { defaultRegistry } from "../process-registry.ts";
import { invokeClaudeCli } from "../claude/process.ts";
import { e2eEnabled, ONE_WORD_OK } from "./_helpers.ts";

const claudeEnabled = await e2eEnabled("claude");

Deno.test({
  name:
    "e2e settings/claude/settingSources=[] produces empty CLAUDE_CONFIG_DIR",
  ignore: !claudeEnabled,
  fn: async () => {
    // FR-L18 invariant: the CLI must RETURN (not stall) when pointed at an
    // empty CLAUDE_CONFIG_DIR. Whether it succeeds or fails with an auth
    // error is host-dependent — an API-key host yields `output`, a
    // login-based host yields `error: "Not logged in"`. Both are acceptable;
    // a hang (timeout) is not.
    const start = Date.now();
    const res = await invokeClaudeCli({
      processRegistry: defaultRegistry,
      taskPrompt: ONE_WORD_OK,
      timeoutSeconds: 30,
      maxRetries: 1,
      retryDelaySeconds: 1,
      settingSources: [],
      verbosity: "quiet",
    });
    const elapsed = Date.now() - start;
    assert(
      res.output !== undefined || res.error !== undefined,
      "CLI returned neither output nor error",
    );
    assert(elapsed < 25_000, `CLI stalled: ${elapsed}ms`);
  },
});
