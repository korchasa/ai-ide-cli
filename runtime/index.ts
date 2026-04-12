import type { RuntimeId } from "../types.ts";
import type {
  ResolvedRuntimeConfig,
  RuntimeAdapter,
  RuntimeConfigSource,
} from "./types.ts";
import { claudeRuntimeAdapter } from "./claude-adapter.ts";
import { cursorRuntimeAdapter } from "./cursor-adapter.ts";
import { opencodeRuntimeAdapter } from "./opencode-adapter.ts";

const ADAPTERS: Record<RuntimeId, RuntimeAdapter> = {
  claude: claudeRuntimeAdapter,
  opencode: opencodeRuntimeAdapter,
  cursor: cursorRuntimeAdapter,
};

/** Return the adapter implementation for the given runtime ID. */
export function getRuntimeAdapter(runtime: RuntimeId): RuntimeAdapter {
  return ADAPTERS[runtime];
}

/**
 * Resolve runtime, args, and runtime-scoped options using
 * node > parent > defaults precedence.
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
  const runtimeArgs = [
    ...(opts.defaults?.runtime_args ?? []),
    ...(opts.parent?.runtime_args ?? []),
    ...(opts.node.runtime_args ?? []),
  ];

  return {
    runtime,
    args: runtimeArgs,
    model: model || undefined,
    permissionMode: opts.node.permission_mode ?? opts.parent?.permission_mode ??
      opts.defaults?.permission_mode,
  };
}
