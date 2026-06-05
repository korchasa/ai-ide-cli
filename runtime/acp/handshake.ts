/**
 * @module
 * Shared ACP spawn + handshake primitives (FR-L39 / FR-L42).
 *
 * Extracted out of `runtime/acp/adapter.ts` so both the
 * invoke/session adapter AND the commands fast-channel helper
 * (`runtime/acp/commands.ts`) reuse one spawn-and-handshake path. A
 * parallel helper would drift on abort / FR-L37 classification /
 * process-registry handling — keeping a single source of truth here
 * also keeps the `adapter.ts → content.ts → commands.ts` import graph
 * acyclic (commands.ts imports this leaf, never the adapter).
 */

import type { RuntimeId } from "../../types.ts";
import type { RuntimeInvokeOptions } from "../adapter-types.ts";
import { AcpStdioClient } from "./client.ts";
import { getAcpFront } from "./fronts.ts";
import {
  type AcpConfigOptionDecl,
  type AcpModeDecl,
  buildInitializeParams,
  buildSessionNewParams,
  pickConfigForModel,
  pickConfigForReasoningEffort,
  pickModeForPermissionMode,
} from "./mapping.ts";

/** Subset of the `session/new` response the handshake reads. */
export interface SessionNewResult {
  sessionId: string;
  modes?: { availableModes?: AcpModeDecl[]; currentModeId?: string };
  /** Field name used by claude / codex ACP fronts. */
  sessionConfigOptions?: AcpConfigOptionDecl[];
  /** Field name used by opencode ACP front (1.15.x). */
  configOptions?: AcpConfigOptionDecl[];
}

/** Error thrown when a non-piloted runtime is invoked without an override. */
export function notPiloted(runtime: RuntimeId): Error {
  return new Error(
    `acp transport: ${runtime} front is not piloted yet (FR-L39). ` +
      `Promote it in runtime/acp/fronts.ts after empirical validation.`,
  );
}

/**
 * Spawn the ACP front for a runtime and return a connected client.
 *
 * When `opts.acpFront` is supplied the per-runtime `pilot` guard is
 * bypassed (the consumer explicitly opts into the launcher they point
 * us at — local fork, binary download, test stub). Otherwise the
 * launcher is resolved from the pinned registry and a non-piloted
 * runtime throws {@link notPiloted}.
 *
 * @param opts Launcher selection + subprocess wiring.
 */
export function spawnClient(opts: {
  runtime: RuntimeId;
  cwd?: string;
  env?: Record<string, string>;
  processRegistry: RuntimeInvokeOptions["processRegistry"];
  onStderr?: (line: string) => void;
  onRequest?: ConstructorParameters<typeof AcpStdioClient>[0]["onRequest"];
  acpFront?: RuntimeInvokeOptions["acpFront"];
}): AcpStdioClient {
  const front = opts.acpFront ?? getAcpFront(opts.runtime);
  if (!opts.acpFront && !front.pilot) throw notPiloted(opts.runtime);
  const mergedEnv = { ...(front.env ?? {}), ...(opts.env ?? {}) };
  return new AcpStdioClient({
    cmd: front.cmd,
    args: front.args,
    cwd: opts.cwd,
    env: mergedEnv,
    processRegistry: opts.processRegistry,
    onStderr: opts.onStderr,
    onRequest: opts.onRequest,
  });
}

/**
 * Run the ACP `initialize` → `session/new` handshake and return the
 * server-assigned session id.
 *
 * When `hsOpts.skipModeAndConfig` is set the `session/set_mode` and
 * `session/set_config_option` calls are skipped — the commands
 * fast-channel only needs a live session to receive the initial
 * `available_commands_update` push and would otherwise issue RPCs that
 * are irrelevant to a one-shot capture. The invoke/session path passes
 * `false` (default) and keeps the full handshake.
 *
 * @param client Connected ACP stdio client from {@link spawnClient}.
 * @param runtime Runtime id (drives the per-front option mappers).
 * @param opts Invocation options the handshake reads.
 * @param hsOpts Handshake tuning. `skipModeAndConfig` short-circuits the
 *   mode + config-option RPCs.
 */
export async function handshake(
  client: AcpStdioClient,
  runtime: RuntimeId,
  opts: Pick<
    RuntimeInvokeOptions,
    | "cwd"
    | "mcpServers"
    | "extraArgs"
    | "env"
    | "permissionMode"
    | "model"
    | "reasoningEffort"
  >,
  hsOpts?: { skipModeAndConfig?: boolean },
): Promise<{ sessionId: string }> {
  await client.request("initialize", {
    ...buildInitializeParams(),
  } as unknown as Record<string, unknown>);

  const sessionParams = buildSessionNewParams(runtime, opts);
  const sessionRes = await client.request<SessionNewResult>(
    "session/new",
    sessionParams as unknown as Record<string, unknown>,
  );
  const sessionId = sessionRes.sessionId;

  if (hsOpts?.skipModeAndConfig) return { sessionId };

  const declaredModes = sessionRes.modes?.availableModes;
  const modeId = pickModeForPermissionMode(
    runtime,
    declaredModes,
    opts.permissionMode,
  );
  if (modeId) {
    await client.request("session/set_mode", {
      sessionId,
      modeId,
    });
  }

  // Claude / Codex put the declared options under `sessionConfigOptions`;
  // OpenCode (1.15.x) uses `configOptions`. Accept either so the same
  // mapper logic works across all fronts.
  const declaredCfg = sessionRes.sessionConfigOptions ??
    sessionRes.configOptions;
  const effortCfg = pickConfigForReasoningEffort(runtime, declaredCfg, {
    reasoningEffort: opts.reasoningEffort,
    extraArgs: opts.extraArgs,
  });
  if (effortCfg) {
    await client.request("session/set_config_option", {
      sessionId,
      configId: effortCfg.configId,
      value: effortCfg.value,
    });
  }
  const modelCfg = pickConfigForModel(declaredCfg, opts.model);
  if (modelCfg) {
    await client.request("session/set_config_option", {
      sessionId,
      configId: modelCfg.configId,
      value: modelCfg.value,
    });
  }

  return { sessionId };
}
