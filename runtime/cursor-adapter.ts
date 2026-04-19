import { invokeCursorCli } from "../cursor/process.ts";
import type { InteractiveResult, RuntimeAdapter } from "./types.ts";
import {
  type CapabilityInventory,
  type FetchCapabilitiesOptions,
  fetchInventoryViaInvoke,
} from "./capabilities.ts";

export const cursorRuntimeAdapter: RuntimeAdapter = {
  id: "cursor",
  capabilities: {
    permissionMode: false,
    hitl: false,
    transcript: false,
    interactive: false,
    toolUseObservation: false,
    session: false,
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

  launchInteractive(): Promise<InteractiveResult> {
    throw new Error(
      "Cursor has no interactive CLI mode — use Cursor IDE directly",
    );
  },
};
