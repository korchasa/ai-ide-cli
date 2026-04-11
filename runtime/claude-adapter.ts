import { invokeClaudeCli } from "../claude/process.ts";
import type { RuntimeAdapter } from "./types.ts";

export const claudeRuntimeAdapter: RuntimeAdapter = {
  id: "claude",
  capabilities: {
    permissionMode: true,
    hitl: true,
    transcript: true,
  },
  invoke(opts) {
    return invokeClaudeCli({
      agent: opts.agent,
      systemPrompt: opts.systemPrompt,
      taskPrompt: opts.taskPrompt,
      resumeSessionId: opts.resumeSessionId,
      claudeArgs: opts.extraArgs,
      permissionMode: opts.permissionMode,
      model: opts.model,
      timeoutSeconds: opts.timeoutSeconds,
      maxRetries: opts.maxRetries,
      retryDelaySeconds: opts.retryDelaySeconds,
      onOutput: opts.onOutput,
      streamLogPath: opts.streamLogPath,
      verbosity: opts.verbosity,
      cwd: opts.cwd,
    });
  },
};
