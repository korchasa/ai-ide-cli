import { invokeCursorCli } from "../cursor/process.ts";
import {
  type CursorStreamEvent,
  openCursorSession,
} from "../cursor/session.ts";
import type {
  InteractiveResult,
  RuntimeAdapter,
  RuntimeSession,
  RuntimeSessionEvent,
  RuntimeSessionOptions,
} from "./types.ts";
import { adaptEventCallback, adaptRuntimeSession } from "./session-adapter.ts";
import {
  type CapabilityInventory,
  type FetchCapabilitiesOptions,
  fetchInventoryViaInvoke,
} from "./capabilities.ts";

function cursorEventToRuntime(event: CursorStreamEvent): RuntimeSessionEvent {
  const raw = event as Record<string, unknown>;
  const typeField = raw["type"];
  return {
    runtime: "cursor",
    type: typeof typeField === "string" ? typeField : "unknown",
    raw,
  };
}

/**
 * Cursor emulates streaming by spawning a fresh `cursor agent -p --resume`
 * subprocess per send. Each subprocess terminates its stream-json output
 * with a `result` event — one per completed turn. Drives the neutral
 * {@link SYNTHETIC_TURN_END} emission. Synthetic errors from failed
 * subprocesses carry `type: "error"` and do not trip the turn-end check.
 */
function isCursorTurnEnd(event: CursorStreamEvent): boolean {
  return event?.type === "result";
}

export const cursorRuntimeAdapter: RuntimeAdapter = {
  id: "cursor",
  capabilities: {
    permissionMode: false,
    hitl: false,
    transcript: false,
    interactive: false,
    toolUseObservation: false,
    session: true,
    capabilityInventory: true,
  },
  invoke(opts) {
    return invokeCursorCli(opts);
  },

  fetchCapabilitiesSlow(
    opts?: FetchCapabilitiesOptions,
  ): Promise<CapabilityInventory> {
    return fetchInventoryViaInvoke(
      "cursor",
      (inner) => this.invoke(inner),
      opts,
    );
  },

  async openSession(opts: RuntimeSessionOptions): Promise<RuntimeSession> {
    const inner = await openCursorSession({
      systemPrompt: opts.systemPrompt,
      permissionMode: opts.permissionMode,
      resumeSessionId: opts.resumeSessionId,
      cursorArgs: opts.extraArgs,
      cwd: opts.cwd,
      env: opts.env,
      signal: opts.signal,
      onEvent: adaptEventCallback(
        opts.onEvent,
        cursorEventToRuntime,
        isCursorTurnEnd,
      ),
      onStderr: opts.onStderr,
    });
    return adaptRuntimeSession(
      "cursor",
      inner,
      cursorEventToRuntime,
      isCursorTurnEnd,
    );
  },

  launchInteractive(): Promise<InteractiveResult> {
    throw new Error(
      "Cursor has no interactive CLI mode — use Cursor IDE directly",
    );
  },
};
