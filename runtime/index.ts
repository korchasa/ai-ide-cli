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
 * Expand an {@link ExtraArgsMap} into a flat argv array.
 *
 * Value semantics:
 * - `""` (empty string) emits a bare boolean flag: `--key`.
 * - any other string emits a key/value pair: `--key value`.
 * - `null` suppresses the flag entirely — useful when a downstream cascade
 *   level wants to override a parent-provided value.
 *
 * Insertion order follows `Object.entries()` which in turn reflects the
 * insertion order of the source map — stable across runs for fixed inputs.
 *
 * When `reserved` is supplied and the map contains any of the reserved
 * keys, the helper throws synchronously: those flags are emitted by the
 * runtime adapter itself and must not be duplicated or overridden via
 * `extraArgs`.
 */
export function expandExtraArgs(
  map?: ExtraArgsMap,
  reserved?: readonly string[],
): string[] {
  if (!map) return [];
  if (reserved) {
    for (const key of reserved) {
      if (key in map) {
        throw new Error(
          `extraArgs key "${key}" is reserved by the runtime adapter`,
        );
      }
    }
  }
  return Object.entries(map).flatMap(([k, v]) =>
    v === null ? [] : v === "" ? [k] : [k, v]
  );
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

  return {
    runtime,
    args: merged ?? {},
    model: model || undefined,
    permissionMode: opts.node.permission_mode ?? opts.parent?.permission_mode ??
      opts.defaults?.permission_mode,
  };
}
