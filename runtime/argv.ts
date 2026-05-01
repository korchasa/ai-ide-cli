/**
 * @module
 * Cycle-free argv helpers shared by every runtime adapter.
 *
 * Lives outside `runtime/index.ts` on purpose: importing the helper from
 * `<runtime>/process.ts` or `<runtime>/session.ts` must not pull in
 * `index.ts` (which transitively imports each `*-adapter.ts`) — otherwise
 * a direct `import { claudeRuntimeAdapter } from "./claude-adapter.ts"`
 * trips a TDZ on the `ADAPTERS` record. Keep this module a leaf:
 * **no imports from `<runtime>/*` or `*-adapter.ts`**.
 */

import type { ExtraArgsMap } from "./types.ts";

// FR-L1
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
