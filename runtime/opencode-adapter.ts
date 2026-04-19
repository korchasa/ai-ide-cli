import { invokeOpenCodeCli } from "../opencode/process.ts";
import {
  type OpenCodeSessionEvent,
  openOpenCodeSession,
} from "../opencode/session.ts";
import type {
  InteractiveOptions,
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
import { join } from "@std/path";
import { copy } from "@std/fs";

function opencodeEventToRuntime(
  event: OpenCodeSessionEvent,
): RuntimeSessionEvent {
  return { runtime: "opencode", type: event.type, raw: event.raw };
}

/**
 * Resolve the OpenCode/Claude skills directory. OpenCode discovers skills
 * from `.opencode/skills/` and falls back to `.claude/skills/`. We use
 * the Claude path for broader compatibility.
 */
function opencodeSkillsDir(): string {
  return join(Deno.env.get("HOME") ?? Deno.cwd(), ".claude", "skills");
}

export const opencodeRuntimeAdapter: RuntimeAdapter = {
  id: "opencode",
  capabilities: {
    permissionMode: true,
    hitl: true,
    transcript: false,
    interactive: true,
    toolUseObservation: false,
    session: true,
    capabilityInventory: true,
  },
  invoke(opts) {
    return invokeOpenCodeCli(opts);
  },

  fetchCapabilitiesSlow(
    opts?: FetchCapabilitiesOptions,
  ): Promise<CapabilityInventory> {
    return fetchInventoryViaInvoke(
      "opencode",
      (inner) => this.invoke(inner),
      opts,
    );
  },

  async openSession(opts: RuntimeSessionOptions): Promise<RuntimeSession> {
    const inner = await openOpenCodeSession({
      agent: opts.agent,
      systemPrompt: opts.systemPrompt,
      model: opts.model,
      resumeSessionId: opts.resumeSessionId,
      cwd: opts.cwd,
      env: opts.env,
      signal: opts.signal,
      onEvent: adaptEventCallback(opts.onEvent, opencodeEventToRuntime),
      onStderr: opts.onStderr,
    });
    return adaptRuntimeSession("opencode", inner, opencodeEventToRuntime);
  },

  async launchInteractive(
    opts: InteractiveOptions,
  ): Promise<InteractiveResult> {
    const injectedPaths: string[] = [];
    try {
      const env: Record<string, string> = { ...opts.env };

      if (opts.skills && opts.skills.length > 0) {
        const skillsDir = opencodeSkillsDir();
        await Deno.mkdir(skillsDir, { recursive: true });
        for (const skill of opts.skills) {
          const targetDir = join(
            skillsDir,
            skill.frontmatter.name,
          );
          await copy(skill.rootPath, targetDir, { overwrite: true });
          injectedPaths.push(targetDir);
        }
      }

      const args: string[] = [];
      if (opts.systemPrompt) {
        args.push("--system-prompt", opts.systemPrompt);
      }

      const cmd = new Deno.Command("opencode", {
        args,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
      });

      const process = cmd.spawn();
      const status = await process.status;
      return { exitCode: status.code };
    } finally {
      for (const p of injectedPaths) {
        try {
          await Deno.remove(p, { recursive: true });
        } catch {
          // Best-effort cleanup
        }
      }
    }
  },
};
