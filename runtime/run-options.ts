/**
 * @module
 * Shared validation for the per-run options that some runtimes cannot
 * honour — `outputSchema` (FR-L50), `processGroup` (FR-L51) and
 * `ephemeral` (FR-L52) — plus the structured-reply helpers the CLI
 * runners use to fill `CliRunOutput.structured_output`.
 *
 * Cycle-free leaf: imports only shared types, so every per-runtime
 * module can depend on it.
 */

import type { CliRunOutput, RuntimeId } from "../types.ts";
import type { ExtraArgsMap } from "./adapter-types.ts";

// FR-L50
/**
 * Thrown synchronously, before any subprocess spawns, when a caller set
 * an option the selected runtime cannot honour on its CLI transport
 * (e.g. `outputSchema` on Cursor). The CLI-side counterpart of
 * `AcpUnsupportedOptionError`; `fields` lists the offending option names
 * so consumers can branch without parsing the message.
 */
export class RuntimeUnsupportedOptionError extends Error {
  /** Runtime that rejected the option(s). */
  readonly runtime: RuntimeId;
  /** Names of the offending option fields, in the order checked. */
  readonly fields: readonly string[];

  /**
   * Construct an unsupported-option error for the given runtime.
   *
   * @param runtime Runtime that cannot honour the options.
   * @param fields Option field names the runtime rejects.
   */
  constructor(runtime: RuntimeId, fields: readonly string[]) {
    super(
      `${runtime}: unsupported option(s): ${fields.join(", ")} — ` +
        `drop them or pick a runtime that supports them`,
    );
    this.name = "RuntimeUnsupportedOptionError";
    this.runtime = runtime;
    this.fields = fields;
  }
}

/**
 * Session options only the ACP transport honours (FR-L55..FR-L57). Every
 * non-ACP `openSession` passes them to {@link rejectUnsupportedRunOptions}
 * so a caller is told instead of silently ignored.
 */
export const ACP_ONLY_SESSION_OPTIONS: readonly string[] = [
  "onToolUseObserved",
  "acpClientFs",
  "acpSessionMeta",
];

/**
 * Throw {@link RuntimeUnsupportedOptionError} when any of `fields` is set
 * on `opts`. `undefined`, `null` and `false` count as unset — the three
 * boolean options are opt-in, so `false` asks for today's behaviour.
 *
 * @param runtime Runtime doing the check.
 * @param opts The invoke or session options.
 * @param fields Option names the runtime cannot honour.
 */
export function rejectUnsupportedRunOptions(
  runtime: RuntimeId,
  opts: object,
  fields: readonly string[],
): void {
  const record = opts as Record<string, unknown>;
  const set = fields.filter((f) => {
    const v = record[f];
    return v !== undefined && v !== null && v !== false;
  });
  if (set.length > 0) throw new RuntimeUnsupportedOptionError(runtime, set);
}

/**
 * Throw when a typed option is set together with the CLI flag it maps to
 * in `extraArgs`. The flag stays usable through `extraArgs` while the
 * typed field is unset — the FR-L24 rule for typed fields over legacy
 * flags, which keeps existing `extraArgs` configurations working.
 *
 * @param field Name of the typed option.
 * @param value Its value; `undefined` / `false` skip the check.
 * @param flags CLI flags the option emits.
 * @param extraArgs The caller's `extraArgs` map.
 */
export function rejectTypedFlagCollision(
  field: string,
  value: unknown,
  flags: readonly string[],
  extraArgs: ExtraArgsMap | undefined,
): void {
  if (value === undefined || value === false || !extraArgs) return;
  for (const flag of flags) {
    if (flag in extraArgs) {
      throw new Error(
        `extraArgs key "${flag}" collides with typed ${field}`,
      );
    }
  }
}

// FR-L50
/**
 * Throw unless `schema` is a plain JSON object (or unset). A JSON Schema
 * document is always an object; anything else is a caller mistake that
 * every runtime would reject later with a less specific message.
 *
 * @param schema The `outputSchema` option.
 */
export function validateOutputSchema(
  schema: Record<string, unknown> | undefined,
): void {
  if (schema === undefined) return;
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("outputSchema must be a JSON Schema object");
  }
}

// FR-L50
/**
 * Fill `structured_output` by parsing the final message as JSON — for
 * runtimes whose schema-constrained reply arrives as plain text (Codex).
 * A run that already failed is returned untouched; an unparsable reply
 * turns the run into an error with `structured_output_error` set and
 * `result` keeping the raw text.
 *
 * @param output The run's normalised output.
 */
export function parseStructuredReply(output: CliRunOutput): CliRunOutput {
  if (output.is_error) return output;
  try {
    return { ...output, structured_output: JSON.parse(output.result) };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ...output,
      is_error: true,
      structured_output_error:
        `reply is not JSON for the requested outputSchema: ${reason}`,
    };
  }
}

// FR-L50
/**
 * Turn a successful run without `structured_output` into an error — for
 * runtimes that return the parsed object in a field of their own (Claude
 * `result.structured_output`).
 *
 * @param output The run's normalised output.
 */
export function requireStructuredOutput(output: CliRunOutput): CliRunOutput {
  if (output.is_error || output.structured_output !== undefined) return output;
  return {
    ...output,
    is_error: true,
    structured_output_error:
      "runtime returned no structured_output for the requested outputSchema",
  };
}

// FR-L51
/**
 * Throw {@link RuntimeUnsupportedOptionError} for `processGroup: true` on
 * Windows, where Deno cannot signal a process group (`kill(-pgid)`).
 *
 * @param runtime Runtime doing the check.
 * @param opts The invoke or session options.
 * @param os Operating system; defaults to `Deno.build.os` (tests pass it).
 */
export function rejectProcessGroupOnWindows(
  runtime: RuntimeId,
  opts: { processGroup?: boolean },
  os: typeof Deno.build.os = Deno.build.os,
): void {
  if (opts.processGroup && os === "windows") {
    throw new RuntimeUnsupportedOptionError(runtime, ["processGroup"]);
  }
}
