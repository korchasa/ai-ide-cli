import type { RuntimeId } from "../../types.ts";

/**
 * Thrown synchronously by `invokeViaAcp` / `openSessionViaAcp` when the
 * caller set one or more options that the ACP wire cannot carry at all.
 *
 * Distinct from the lossy-but-handled `collectDegradedOptions` warn path
 * (routed through `OnCallbackError`): those options are approximated, this
 * class fires for options that would otherwise be silently dropped
 * (`resumeSessionId`, `strictMcpConfig`, `extraArgs`, `agent`,
 * `systemPromptFile`, `streamStallTimeoutSeconds`, `streamLogPath`,
 * `verbosity`, `onOutput`). The structured `fields` list lets consumers
 * pattern-match programmatically without parsing the message string.
 */
// FR-L39
export class AcpUnsupportedOptionError extends Error {
  /** Runtime whose ACP transport rejected the option(s). */
  readonly runtime: RuntimeId;
  /** Names of the offending option fields, in declaration order. */
  readonly fields: readonly string[];

  /**
   * Construct an unsupported-option error for the given runtime.
   *
   * @param runtime Runtime whose ACP transport rejected the options.
   * @param fields Option field names that the ACP wire cannot carry.
   */
  constructor(runtime: RuntimeId, fields: readonly string[]) {
    super(
      `acp(${runtime}): unsupported option(s): ${fields.join(", ")} ` +
        `— drop them or use transport: "cli"`,
    );
    this.name = "AcpUnsupportedOptionError";
    this.runtime = runtime;
    this.fields = fields;
  }
}
