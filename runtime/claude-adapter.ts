/**
 * @module
 * Runtime adapter for Anthropic's Claude Code CLI.
 *
 * Modeled after Anthropic's Claude Agent SDK (TypeScript) but implemented as
 * a direct subprocess wrapper to keep the package dependency-free for Deno
 * consumers. Upstream reference — use this as source of truth when porting
 * additional flags, event types, or session-management features:
 * https://github.com/anthropics/claude-agent-sdk-typescript
 */

import { invokeClaudeCli } from "../claude/process.ts";
import { openClaudeSession } from "../claude/session.ts";
import type { ClaudeStreamEvent } from "../claude/stream.ts";
import type {
  InteractiveOptions,
  InteractiveResult,
  RuntimeAdapter,
  RuntimeSession,
  RuntimeSessionEvent,
  RuntimeSessionOptions,
} from "./types.ts";
import { join } from "@std/path";
import { copy } from "@std/fs";

/**
 * Resolve the user-level Claude skills directory.
 * Skills placed here are discovered by Claude Code in any project.
 */
function claudeSkillsDir(): string {
  const configDir = Deno.env.get("CLAUDE_CONFIG_DIR") ??
    join(Deno.env.get("HOME") ?? Deno.cwd(), ".claude");
  return join(configDir, "skills");
}

/**
 * Copy bundled skills into the user's Claude skills directory.
 * Directory name = frontmatter `name` field (already namespaced, e.g.
 * `flowai-workflow-init`). Returns created paths for cleanup.
 */
async function injectSkills(
  skills: NonNullable<InteractiveOptions["skills"]>,
): Promise<string[]> {
  const skillsDir = claudeSkillsDir();
  await Deno.mkdir(skillsDir, { recursive: true });

  const created: string[] = [];
  for (const skill of skills) {
    const targetDir = join(skillsDir, skill.frontmatter.name);
    await copy(skill.rootPath, targetDir, { overwrite: true });
    created.push(targetDir);
  }
  return created;
}

/** Remove previously injected skill directories. */
async function removeInjectedSkills(paths: string[]): Promise<void> {
  for (const p of paths) {
    try {
      await Deno.remove(p, { recursive: true });
    } catch {
      // Best-effort cleanup
    }
  }
}

export const claudeRuntimeAdapter: RuntimeAdapter = {
  id: "claude",
  capabilities: {
    permissionMode: true,
    hitl: true,
    transcript: true,
    interactive: true,
    toolUseObservation: true,
    session: true,
  },
  async invoke(opts) {
    // Translate runtime-neutral onToolUseObserved into the Claude-specific
    // callback (just adds `runtime: "claude"` to the info object).
    const claudeHook = opts.onToolUseObserved
      ? async (info: {
        id: string;
        name: string;
        input?: Record<string, unknown>;
        turn: number;
      }) => {
        return await opts.onToolUseObserved!({
          runtime: "claude",
          id: info.id,
          name: info.name,
          input: info.input,
          turn: info.turn,
        });
      }
      : undefined;

    // Translate runtime-neutral hooks into Claude-specific lifecycle
    // hooks by producing a thin adapter that emits the neutral shapes.
    const claudeHooks = opts.hooks
      ? {
        onInit: opts.hooks.onInit
          ? (e: {
            type: string;
            model?: string;
            session_id?: string;
          }) => {
            opts.hooks!.onInit!({
              runtime: "claude",
              model: e.model,
              sessionId: e.session_id,
            });
          }
          : undefined,
      }
      : undefined;

    const result = await invokeClaudeCli({
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
      signal: opts.signal,
      onOutput: opts.onOutput,
      streamLogPath: opts.streamLogPath,
      verbosity: opts.verbosity,
      cwd: opts.cwd,
      env: opts.env,
      onEvent: opts.onEvent,
      hooks: claudeHooks,
      onToolUseObserved: claudeHook,
      settingSources: opts.settingSources,
    });
    if (result.output) opts.hooks?.onResult?.(result.output);
    return result;
  },

  async openSession(opts: RuntimeSessionOptions): Promise<RuntimeSession> {
    const wrappedOnEvent = opts.onEvent
      ? (event: ClaudeStreamEvent) => {
        opts.onEvent!({
          runtime: "claude",
          type: event.type,
          raw: event as unknown as Record<string, unknown>,
        });
      }
      : undefined;

    const inner = await openClaudeSession({
      agent: opts.agent,
      systemPrompt: opts.systemPrompt,
      model: opts.model,
      permissionMode: opts.permissionMode,
      resumeSessionId: opts.resumeSessionId,
      claudeArgs: opts.extraArgs,
      cwd: opts.cwd,
      env: opts.env,
      signal: opts.signal,
      settingSources: opts.settingSources,
      onEvent: wrappedOnEvent,
      onStderr: opts.onStderr,
    });

    const events: AsyncIterable<RuntimeSessionEvent> = {
      async *[Symbol.asyncIterator]() {
        for await (const event of inner.events) {
          const raw = event as unknown as Record<string, unknown>;
          const typeField = raw["type"];
          yield {
            runtime: "claude",
            type: typeof typeField === "string" ? typeField : "unknown",
            raw,
          };
        }
      },
    };

    return {
      runtime: "claude",
      pid: inner.pid,
      send: (content: string) => inner.send(content),
      events,
      endInput: () => inner.endInput(),
      abort: (reason) => inner.abort(reason),
      done: inner.done.then((status) => ({
        exitCode: status.exitCode,
        signal: status.signal,
        stderr: status.stderr,
      })),
    };
  },

  async launchInteractive(
    opts: InteractiveOptions,
  ): Promise<InteractiveResult> {
    let injectedPaths: string[] = [];
    try {
      const env: Record<string, string> = {
        CLAUDECODE: "",
        ...opts.env,
      };

      if (opts.skills && opts.skills.length > 0) {
        injectedPaths = await injectSkills(opts.skills);
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
      await removeInjectedSkills(injectedPaths);
    }
  },
};
