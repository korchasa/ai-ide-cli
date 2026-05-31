/**
 * @module
 * FR-L39 ACP transport smoke for OpenCode. Drives `transport: "acp"`
 * end-to-end against the locally-installed `opencode acp` front
 * (registered in `runtime/acp/fronts.ts`).
 *
 * Gated on `E2E=1` + `E2E_RUNTIMES` (opencode allowed) + `opencode`
 * on PATH. Unlike claude / codex fronts, the OpenCode ACP front
 * wraps the locally-installed `opencode` binary (not an `npx`
 * launcher), so the standard `e2eEnabled` PATH probe + auth probe
 * apply via `e2eAcpEnabled`'s fallback branch.
 */

import { assert } from "@std/assert";
import { getRuntimeAdapter } from "../runtime/index.ts";
import { defaultRegistry } from "../process-registry.ts";
import { e2eAcpEnabled, ONE_WORD_OK } from "./_helpers.ts";

const enabled = await e2eAcpEnabled("opencode");

Deno.test({
  name: "e2e acp/opencode/transport=acp returns ok",
  ignore: !enabled,
  sanitizeOps: false,
  sanitizeResources: false,
  sanitizeExit: false,
  fn: async () => {
    const adapter = getRuntimeAdapter("opencode");
    const controller = new AbortController();
    const ceilingId = setTimeout(() => controller.abort("ceiling-90s"), 90_000);
    try {
      const res = await adapter.invoke({
        processRegistry: defaultRegistry,
        taskPrompt: ONE_WORD_OK,
        timeoutSeconds: 90,
        maxRetries: 0,
        retryDelaySeconds: 0,
        // Intentionally NOT setting `permissionMode: "plan"`: in
        // OpenCode's ACP front, `plan` is a READ-ONLY analysis phase
        // where the agent emits only `agent_thought_chunk` events and
        // suppresses the final `agent_message_chunk` reply — the smoke
        // would assert against an empty result. Default mode lets the
        // agent answer normally.
        //
        // Pin a fast model — the user's default opencode model
        // (`opencode auth` chooses one) may be a thinking-heavy GLM
        // build that suppresses `agent_message_chunk` for trivial
        // prompts. Routed through `session/set_config_option`; see
        // `runtime/acp/mapping.ts:pickConfigForModel`.
        model: "openai/gpt-5.4-mini-fast",
        signal: controller.signal,
        transport: "acp",
      });
      assert(
        res.output,
        `expected ACP output, got ${JSON.stringify(res)}`,
      );
      assert(
        /ok/i.test(res.output.result),
        `expected reply to contain 'ok', got ${JSON.stringify(res.output)}`,
      );
      assert(
        res.output.is_error === false,
        `expected non-error reply, got ${JSON.stringify(res.output)}`,
      );
    } finally {
      clearTimeout(ceilingId);
    }
  },
});
