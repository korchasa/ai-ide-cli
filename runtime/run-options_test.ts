import {
  assertEquals,
  assertFalse,
  assertRejects,
  assertThrows,
} from "@std/assert";
import {
  parseStructuredReply,
  rejectProcessGroupOnWindows,
  rejectTypedFlagCollision,
  rejectUnsupportedRunOptions,
  requireStructuredOutput,
  RuntimeUnsupportedOptionError,
  validateOutputSchema,
} from "./run-options.ts";
import type { CliRunOutput } from "../types.ts";
import { defaultRegistry } from "../process-registry.ts";
import { getRuntimeAdapter } from "./index.ts";
import type { SettingSource } from "./setting-sources.ts";

const OK: CliRunOutput = {
  result: '{"answer":"ok"}',
  session_id: "s",
  duration_ms: 1,
  num_turns: 1,
  is_error: false,
};

Deno.test("FR-L50 rejectUnsupportedRunOptions names every set field", () => {
  const err = assertThrows(
    () =>
      rejectUnsupportedRunOptions("cursor", {
        outputSchema: {},
        ephemeral: true,
        processGroup: undefined,
      }, ["outputSchema", "ephemeral", "processGroup"]),
    RuntimeUnsupportedOptionError,
  );
  assertEquals(err.runtime, "cursor");
  assertEquals(err.fields, ["outputSchema", "ephemeral"]);
});

Deno.test("FR-L52 rejectUnsupportedRunOptions treats ephemeral: false as unset", () => {
  rejectUnsupportedRunOptions("opencode", { ephemeral: false }, ["ephemeral"]);
});

Deno.test("FR-L50 rejectTypedFlagCollision refuses the typed field plus its flag", () => {
  assertThrows(
    () =>
      rejectTypedFlagCollision("outputSchema", {}, ["--json-schema"], {
        "--json-schema": "{}",
      }),
    Error,
    'extraArgs key "--json-schema" collides with typed outputSchema',
  );
  rejectTypedFlagCollision("outputSchema", undefined, ["--json-schema"], {
    "--json-schema": "{}",
  });
});

Deno.test("FR-L50 validateOutputSchema refuses a non-object schema", () => {
  validateOutputSchema({ type: "object" });
  validateOutputSchema(undefined);
  for (const bad of [[], "x", null, 3]) {
    assertThrows(
      () => validateOutputSchema(bad as unknown as Record<string, unknown>),
      Error,
      "outputSchema must be a JSON Schema object",
    );
  }
});

Deno.test("FR-L50 parseStructuredReply parses the final message", () => {
  assertEquals(parseStructuredReply(OK).structured_output, { answer: "ok" });
});

Deno.test("FR-L50 parseStructuredReply flags an unparsable reply as an error", () => {
  const out = parseStructuredReply({ ...OK, result: "not json" });
  assertEquals(out.is_error, true);
  assertEquals(out.result, "not json");
  assertEquals(out.structured_output, undefined);
  assertEquals(
    out.structured_output_error?.startsWith(
      "reply is not JSON for the requested outputSchema",
    ),
    true,
  );
});

Deno.test("FR-L50 parseStructuredReply leaves a failed run alone", () => {
  const failed = { ...OK, result: "boom", is_error: true };
  assertEquals(parseStructuredReply(failed), failed);
});

Deno.test("FR-L50 requireStructuredOutput flags a run without the object", () => {
  const out = requireStructuredOutput({ ...OK });
  assertEquals(out.is_error, true);
  assertEquals(
    out.structured_output_error,
    "runtime returned no structured_output for the requested outputSchema",
  );
  const withObject = { ...OK, structured_output: { a: 1 } };
  assertEquals(requireStructuredOutput(withObject), withObject);
});

Deno.test("FR-L51 rejectProcessGroupOnWindows refuses only Windows", () => {
  const err = assertThrows(
    () =>
      rejectProcessGroupOnWindows("codex", { processGroup: true }, "windows"),
    RuntimeUnsupportedOptionError,
  );
  assertEquals(err.fields, ["processGroup"]);
  rejectProcessGroupOnWindows("codex", { processGroup: true }, "darwin");
  rejectProcessGroupOnWindows("codex", { processGroup: false }, "windows");
});

const NON_CLAUDE_CLI = ["codex", "opencode", "cursor"] as const;
const BASE_INVOKE = {
  processRegistry: defaultRegistry,
  taskPrompt: "ignored",
  timeoutSeconds: 1,
  maxRetries: 0,
  retryDelaySeconds: 0,
};

Deno.test("FR-L28 non-Claude CLI runtimes reject settingSources, [] included", async () => {
  for (const runtime of NON_CLAUDE_CLI) {
    const adapter = getRuntimeAdapter(runtime);
    for (const settingSources of [[], ["user"]] as SettingSource[][]) {
      const invokeErr = assertThrows(
        () => adapter.invoke({ ...BASE_INVOKE, settingSources }),
        RuntimeUnsupportedOptionError,
      );
      assertEquals(invokeErr.runtime, runtime);
      assertEquals(invokeErr.fields, ["settingSources"]);
      // async wrapper: Codex openSession throws, OpenCode / Cursor reject.
      const sessionErr = await assertRejects(
        async () =>
          await adapter.openSession!({
            processRegistry: defaultRegistry,
            settingSources,
          }),
        RuntimeUnsupportedOptionError,
      );
      assertEquals(sessionErr.fields, ["settingSources"]);
    }
  }
});

Deno.test("FR-L28 undefined settingSources passes the rejection", async () => {
  // A bad reasoningEffort is validated after the FR-L28 check, so reaching
  // its error proves settingSources: undefined was not refused.
  const reasoningEffort = "bogus" as unknown as "low";
  for (const runtime of NON_CLAUDE_CLI) {
    const adapter = getRuntimeAdapter(runtime);
    const invokeErr = assertThrows(() =>
      adapter.invoke({
        ...BASE_INVOKE,
        settingSources: undefined,
        reasoningEffort,
      })
    );
    assertFalse(invokeErr instanceof RuntimeUnsupportedOptionError);
    const sessionErr = await assertRejects(async () =>
      await adapter.openSession!({
        processRegistry: defaultRegistry,
        settingSources: undefined,
        reasoningEffort,
      })
    );
    assertFalse(sessionErr instanceof RuntimeUnsupportedOptionError);
  }
});
