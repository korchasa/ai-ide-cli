/**
 * @module
 * Standalone e2e for FR-L30: typed Cursor stream-json events and
 * `onToolUseObserved` lifecycle. Lives outside the session matrix because
 * it requires a one-shot `invokeCursorCli` run with
 * `permissionMode: "bypassPermissions"` so Cursor actually dispatches a
 * tool call (without `--yolo` Cursor stalls on permission prompts in
 * headless `-p` mode and never emits `tool_call/started`).
 *
 * Safety:
 * - cwd is a `Deno.makeTempDir()` scratch dir — no writes outside it.
 * - 60s `AbortSignal.timeout` ceiling.
 * - Single short prompt (one tool call → one assistant reply); negligible
 *   token spend.
 *
 * Gate: same as the rest of the e2e suite — `E2E=1` plus `cursor` on PATH
 * (or in `E2E_RUNTIMES`).
 */

import { assert } from "@std/assert";
import { defaultRegistry } from "../process-registry.ts";
import { invokeCursorCli } from "../cursor/process.ts";
import {
  parseCursorStreamEvent,
  unwrapCursorToolCall,
} from "../cursor/stream.ts";
import type { CursorToolCallWrapper } from "../cursor/stream.ts";
import type { RuntimeToolUseInfo } from "../runtime/types.ts";
import { e2eEnabled } from "./_helpers.ts";

const enabled = await e2eEnabled("cursor");

Deno.test({
  name:
    "e2e cursor-stream/cursor/tool_call typed via parseCursorStreamEvent + onToolUseObserved",
  ignore: !enabled,
  // The cursor adapter spawns a per-turn subprocess and tears it down on
  // completion; sanitizers fire on the brief reuse window. Same justification
  // as the matrix's abort-mid-turn entries — see runtime/CLAUDE.md "Gotchas".
  sanitizeOps: false,
  sanitizeResources: false,
  sanitizeExit: false,
  // FR-L30
  fn: async () => {
    const tmp = await Deno.makeTempDir({ prefix: "ai-ide-cli-e2e-cursor-" });
    try {
      await Deno.writeTextFile(`${tmp}/hello.txt`, "ok\n");

      const rawEvents: Record<string, unknown>[] = [];
      const observed: RuntimeToolUseInfo[] = [];

      const result = await invokeCursorCli({
        processRegistry: defaultRegistry,
        taskPrompt:
          "Read the file hello.txt in the current directory and reply with exactly the word inside it.",
        timeoutSeconds: 60,
        maxRetries: 1,
        retryDelaySeconds: 0,
        permissionMode: "bypassPermissions",
        cwd: tmp,
        onEvent: (event) => {
          rawEvents.push(event);
        },
        onToolUseObserved: (info) => {
          observed.push(info);
          return "allow";
        },
      });

      assert(
        !result.error,
        `cursor invoke errored: ${result.error ?? ""}`,
      );

      const typed = rawEvents
        .map((e) => parseCursorStreamEvent(JSON.stringify(e)))
        .filter((e): e is NonNullable<typeof e> => e !== null);

      const toolStarted = typed.filter(
        (e) => e.type === "tool_call" && e.subtype === "started",
      );
      assert(
        toolStarted.length >= 1,
        `expected ≥1 typed tool_call/started event; types=${
          typed.map((e) => `${e.type}/${("subtype" in e) ? e.subtype : ""}`)
            .join(",")
        }`,
      );

      const first = toolStarted[0];
      assert(
        first.type === "tool_call" && first.subtype === "started",
        "narrowing precondition failed",
      );
      const wrapper = first.tool_call as CursorToolCallWrapper;
      const unwrapped = unwrapCursorToolCall(wrapper);
      assert(
        unwrapped !== null,
        `unwrapCursorToolCall returned null on real wire payload: ${
          JSON.stringify(wrapper)
        }`,
      );
      assert(
        unwrapped.name.length > 0,
        `tool name must be non-empty; got ${JSON.stringify(unwrapped)}`,
      );

      assert(
        observed.length >= 1,
        `expected ≥1 onToolUseObserved fire; observed=${observed.length}`,
      );
      const obs = observed[0];
      assert(
        obs.runtime === "cursor",
        `onToolUseObserved.runtime should be "cursor"; got ${obs.runtime}`,
      );
      assert(
        obs.name.length > 0 && obs.id.length > 0,
        `onToolUseObserved info must carry non-empty name+id; got ${
          JSON.stringify(obs)
        }`,
      );
    } finally {
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    }
  },
});
