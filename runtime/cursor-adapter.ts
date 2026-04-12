import { invokeCursorCli } from "../cursor/process.ts";
import type { InteractiveResult, RuntimeAdapter } from "./types.ts";

export const cursorRuntimeAdapter: RuntimeAdapter = {
  id: "cursor",
  capabilities: {
    permissionMode: false,
    hitl: false,
    transcript: false,
    interactive: false,
  },
  invoke(opts) {
    return invokeCursorCli(opts);
  },

  launchInteractive(): Promise<InteractiveResult> {
    throw new Error(
      "Cursor has no interactive CLI mode — use Cursor IDE directly",
    );
  },
};
