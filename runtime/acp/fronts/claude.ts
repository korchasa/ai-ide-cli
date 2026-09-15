/**
 * @module
 * Entry point for the Claude ACP front (FR-L39).
 *
 * `runtime/acp/fronts.ts` spawns this file with
 * `deno run -A <import.meta.resolve("./fronts/claude.ts")>` instead of
 * shelling out to `npx`. The single bare import below resolves through
 * this package's `deno.json` `imports`, so the front's version is a real,
 * lockfile-pinned dependency — and `deno publish` rewrites the specifier
 * to the fully-qualified `npm:` form for consumers installing from JSR.
 *
 * Deliberately NOT imported by `fronts.ts`: `import.meta.resolve` yields
 * a URL without pulling the npm package into this library's module graph,
 * so a consumer on the CLI transport never downloads it.
 */

import "@agentclientprotocol/claude-agent-acp/dist/index.js";
