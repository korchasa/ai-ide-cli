import { invokeOpenCodeCli } from "../opencode/process.ts";
import type {
  InteractiveOptions,
  InteractiveResult,
  RuntimeAdapter,
} from "./types.ts";
import { join } from "@std/path";
import { copy } from "@std/fs";

export const opencodeRuntimeAdapter: RuntimeAdapter = {
  id: "opencode",
  capabilities: {
    permissionMode: true,
    hitl: true,
    transcript: false,
    interactive: true,
  },
  invoke(opts) {
    return invokeOpenCodeCli(opts);
  },

  async launchInteractive(
    opts: InteractiveOptions,
  ): Promise<InteractiveResult> {
    // OpenCode discovers skills from .opencode/skills/ and .claude/skills/ (fallback).
    // Copy bundled skills to a temp .claude/skills/ dir and set CWD there.
    let tmpDir: string | undefined;
    try {
      const env: Record<string, string> = { ...opts.env };

      if (opts.skills && opts.skills.length > 0) {
        tmpDir = await Deno.makeTempDir({ prefix: "flowai-repl-oc-" });
        const skillsDir = join(tmpDir, ".claude", "skills");
        await Deno.mkdir(skillsDir, { recursive: true });
        for (const skill of opts.skills) {
          const targetDir = join(skillsDir, skill.frontmatter.name);
          await copy(skill.rootPath, targetDir, { overwrite: true });
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
      if (tmpDir) {
        try {
          await Deno.remove(tmpDir, { recursive: true });
        } catch {
          // Best-effort cleanup
        }
      }
    }
  },
};
