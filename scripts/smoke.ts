#!/usr/bin/env -S deno run -A
/**
 * @module
 * Legacy smoke entrypoint. Moved to the Deno-test-based e2e suite under
 * `e2e/` (FR-L24).
 *
 * Run the suite with:
 *
 *   deno task e2e                 # all four runtimes
 *   deno task e2e:claude          # Claude only
 *   deno task e2e:opencode
 *   deno task e2e:cursor
 *   deno task e2e:codex
 */

console.log(
  "scripts/smoke.ts has moved to the Deno-test-based e2e suite.\n" +
    "Run `deno task e2e` (or `deno task e2e:<runtime>`) instead.",
);
