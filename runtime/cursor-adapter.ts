import { invokeCursorCli } from "../cursor/process.ts";
import type { RuntimeAdapter } from "./types.ts";

export const cursorRuntimeAdapter: RuntimeAdapter = {
  id: "cursor",
  capabilities: {
    permissionMode: false,
    hitl: false,
    transcript: false,
  },
  invoke(opts) {
    return invokeCursorCli(opts);
  },
};
