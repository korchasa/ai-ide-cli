import { invokeOpenCodeCli } from "../opencode/process.ts";
import type { RuntimeAdapter } from "./types.ts";

export const opencodeRuntimeAdapter: RuntimeAdapter = {
  id: "opencode",
  capabilities: {
    permissionMode: true,
    hitl: true,
    transcript: false,
  },
  invoke(opts) {
    return invokeOpenCodeCli(opts);
  },
};
