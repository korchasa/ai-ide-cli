import { invokeOpenCodeCli } from "../opencode/process.ts";
import {
  type OpenCodeSessionEvent,
  openOpenCodeSession,
} from "../opencode/session.ts";
import type {
  InteractiveOptions,
  InteractiveResult,
  RuntimeAdapter,
  RuntimeInvokeOptions,
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
import { validateToolFilter } from "./tool-filter.ts";
import { validateReasoningEffort } from "./reasoning-effort.ts";
import { join } from "@std/path";
import { copy } from "@std/fs";

// FR-L24: OpenCode has no native tool-filter CLI flag. The validator
// still runs (uniform malformed-input rejection across runtimes); the
// warn-once latch fires `console.warn` on the first valid set-value
// call per process. Shared across `invoke` and `openSession`.
let warnedToolFilter = false;

function warnToolFilterOnce(
  opts: Pick<RuntimeInvokeOptions, "allowedTools" | "disallowedTools">,
): void {
  if (warnedToolFilter) return;
  if (opts.allowedTools === undefined && opts.disallowedTools === undefined) {
    return;
  }
  warnedToolFilter = true;
  console.warn(
    "[opencode] allowedTools/disallowedTools ignored — runtime does not support tool filtering (capabilities.toolFilter === false). See FR-L24.",
  );
}

/**
 * Test-only: reset the one-time warning latch so individual tests can
 * assert the warning fires again.
 *
 * @internal
 */
export function _resetToolFilterWarning(): void {
  warnedToolFilter = false;
}

// FR-L25: OpenCode maps `reasoningEffort` → `--variant` / `body.variant`,
// but the value is provider-specific — a given provider may or may not
// support the requested depth. Warn once per process on first use so
// consumers know the translation is approximate.
let warnedReasoningEffort = false;

function warnReasoningEffortOnce(value: unknown): void {
  if (warnedReasoningEffort) return;
  if (value === undefined) return;
  warnedReasoningEffort = true;
  console.warn(
    "[opencode] reasoningEffort forwarded as provider-specific --variant / body.variant — interpretation depends on the active model provider. See FR-L25.",
  );
}

/**
 * Test-only: reset the one-time reasoning-effort warning latch.
 *
 * @internal
 */
export function _resetReasoningEffortWarning(): void {
  warnedReasoningEffort = false;
}

function opencodeEventToRuntime(
  event: OpenCodeSessionEvent,
): RuntimeSessionEvent {
  const neutral: RuntimeSessionEvent = {
    runtime: "opencode",
    type: event.type,
    raw: event.raw,
  };
  // The OpenCode dispatcher inserts an edge-triggered synthetic turn-end
  // marker into the native queue (see `opencode/session.ts`). Forward the
  // `synthetic` flag so consumers observe one and only one turn-end per
  // assistant turn — even if the server emits both `session.idle` and
  // `session.status { status: idle }` for the same idle transition.
  if (event.synthetic) neutral.synthetic = true;
  return neutral;
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
    transcript: true,
    interactive: true,
    toolUseObservation: true,
    session: true,
    capabilityInventory: true,
    toolFilter: false,
    reasoningEffort: true,
    sessionFidelity: "native",
  },
  invoke(opts) {
    validateToolFilter("opencode", opts);
    warnToolFilterOnce(opts);
    validateReasoningEffort("opencode", opts);
    warnReasoningEffortOnce(opts.reasoningEffort);
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
    validateToolFilter("opencode", opts);
    warnToolFilterOnce(opts);
    validateReasoningEffort("opencode", opts);
    warnReasoningEffortOnce(opts.reasoningEffort);
    const inner = await openOpenCodeSession({
      agent: opts.agent,
      systemPrompt: opts.systemPrompt,
      model: opts.model,
      resumeSessionId: opts.resumeSessionId,
      reasoningEffort: opts.reasoningEffort,
      cwd: opts.cwd,
      env: opts.env,
      signal: opts.signal,
      onEvent: adaptEventCallback(opts.onEvent, opencodeEventToRuntime),
      onStderr: opts.onStderr,
      processRegistry: opts.processRegistry,
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
