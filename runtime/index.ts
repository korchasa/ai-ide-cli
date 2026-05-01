import type { RuntimeId } from "../types.ts";
import type {
  ExtraArgsMap,
  ResolvedRuntimeConfig,
  RuntimeAdapter,
  RuntimeConfigSource,
} from "./types.ts";
import { claudeRuntimeAdapter } from "./claude-adapter.ts";
import { codexRuntimeAdapter } from "./codex-adapter.ts";
import { cursorRuntimeAdapter } from "./cursor-adapter.ts";
import { opencodeRuntimeAdapter } from "./opencode-adapter.ts";

// `expandExtraArgs` lives in `argv.ts` (cycle-free leaf module) so adapter
// modules can import it without re-entering this file's `ADAPTERS` record.
// Re-exported here to preserve the long-standing public API surface.
export { expandExtraArgs } from "./argv.ts";

const ADAPTERS: Record<RuntimeId, RuntimeAdapter> = {
  claude: claudeRuntimeAdapter,
  opencode: opencodeRuntimeAdapter,
  cursor: cursorRuntimeAdapter,
  codex: codexRuntimeAdapter,
};

/** Return the adapter implementation for the given runtime ID. */
export function getRuntimeAdapter(runtime: RuntimeId): RuntimeAdapter {
  return ADAPTERS[runtime];
}

/**
 * Merge three {@link ExtraArgsMap} cascades into one map.
 *
 * Later layers override earlier layers. A `null` value is preserved so it
 * can suppress a parent-supplied flag downstream.
 */
function mergeExtraArgs(
  defaults?: ExtraArgsMap,
  parent?: ExtraArgsMap,
  node?: ExtraArgsMap,
): ExtraArgsMap | undefined {
  if (!defaults && !parent && !node) return undefined;
  return { ...(defaults ?? {}), ...(parent ?? {}), ...(node ?? {}) };
}

/**
 * Resolve runtime, args, and runtime-scoped options using
 * node > parent > defaults precedence.
 *
 * `runtime_args` is merged with object-spread semantics — later layers
 * override earlier ones per-key. `null` survives merging and suppresses
 * the flag at expansion time.
 *
 * Consumer types with matching field names (e.g. engine's `NodeConfig` and
 * `WorkflowDefaults`) structurally satisfy {@link RuntimeConfigSource} and
 * can be passed directly.
 */
export function resolveRuntimeConfig(
  opts: {
    defaults?: RuntimeConfigSource;
    node: RuntimeConfigSource;
    parent?: RuntimeConfigSource;
  },
): ResolvedRuntimeConfig {
  const runtime = opts.node.runtime ?? opts.parent?.runtime ??
    opts.defaults?.runtime ?? "claude";
  const model = opts.node.model ?? opts.parent?.model ?? opts.defaults?.model;
  const merged = mergeExtraArgs(
    opts.defaults?.runtime_args,
    opts.parent?.runtime_args,
    opts.node.runtime_args,
  );
  // FR-L25 (cascade): reasoning-effort resolves node → parent → defaults,
  // mirroring the model precedence above.
  const reasoningEffort = opts.node.effort ?? opts.parent?.effort ??
    opts.defaults?.effort;

  return {
    runtime,
    args: merged ?? {},
    model: model || undefined,
    permissionMode: opts.node.permission_mode ?? opts.parent?.permission_mode ??
      opts.defaults?.permission_mode,
    reasoningEffort,
  };
}
