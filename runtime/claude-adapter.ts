import { invokeClaudeCli } from "../claude/process.ts";
import type {
  InteractiveOptions,
  InteractiveResult,
  RuntimeAdapter,
} from "./types.ts";
import { join } from "@std/path";
import { copy } from "@std/fs";

/**
 * Prepare a temporary CLAUDE_CONFIG_DIR that merges the user's real config
 * (credentials, settings) with bundled REPL skills.
 *
 * Returns the temp dir path. Caller must clean up via `Deno.remove(tmpDir, { recursive: true })`.
 */
async function prepareClaudeConfigDir(
  skills: NonNullable<InteractiveOptions["skills"]>,
): Promise<string> {
  const tmpDir = await Deno.makeTempDir({ prefix: "flowai-repl-" });

  // Symlink all entries from user's real config to preserve auth, settings,
  // projects, todos, etc. Skip `skills/` — we create our own with bundled content.
  const realConfigDir = Deno.env.get("CLAUDE_CONFIG_DIR") ??
    join(Deno.env.get("HOME") ?? Deno.cwd(), ".claude");

  try {
    for await (const entry of Deno.readDir(realConfigDir)) {
      if (entry.name === "skills") continue;
      const src = join(realConfigDir, entry.name);
      const dst = join(tmpDir, entry.name);
      try {
        await Deno.symlink(src, dst);
      } catch {
        // Non-fatal: some files may be locked or inaccessible
      }
    }
  } catch {
    // Real config dir may not exist (fresh install) — proceed without symlinks
  }

  // Copy bundled skills into <tmpDir>/skills/<name>/
  const skillsDir = join(tmpDir, "skills");
  await Deno.mkdir(skillsDir, { recursive: true });

  for (const skill of skills) {
    const targetDir = join(skillsDir, skill.frontmatter.name);
    await copy(skill.rootPath, targetDir, { overwrite: true });
  }

  return tmpDir;
}

export const claudeRuntimeAdapter: RuntimeAdapter = {
  id: "claude",
  capabilities: {
    permissionMode: true,
    hitl: true,
    transcript: true,
    interactive: true,
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
      env: opts.env,
      onEvent: opts.onEvent,
    });
  },

  async launchInteractive(
    opts: InteractiveOptions,
  ): Promise<InteractiveResult> {
    let tmpDir: string | undefined;
    try {
      const env: Record<string, string> = {
        CLAUDECODE: "",
        ...opts.env,
      };

      if (opts.skills && opts.skills.length > 0) {
        tmpDir = await prepareClaudeConfigDir(opts.skills);
        env["CLAUDE_CONFIG_DIR"] = tmpDir;
      }

      const args: string[] = [];
      if (opts.systemPrompt) {
        args.push("--append-system-prompt", opts.systemPrompt);
      }

      const cmd = new Deno.Command("claude", {
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
