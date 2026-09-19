---
date: "2026-09-19"
status: done
implements: [FR-L39, FR-L43]
tags: [acp, fronts, deno-compile, embedding]
related_tasks: [2026/09/acp-fronts-drop-npx.md]
---
# Run the npm fronts from a `deno compile` consumer

## Goal

`runtime/acp/fronts.ts` (0.9.0) launches the Claude and Codex fronts as
`Deno.execPath() run -A <entry>`. Inside a `deno compile` binary
`Deno.execPath()` is the compiled executable itself, which has no `run`
subcommand — so every consumer that ships as a binary (flowai-workflow's
release artefact does) loses both fronts, and gets whatever its own argv
parser says about `run -A https://jsr.io/…`. 0.8.x did not have this
hole: `npx` was resolved on PATH regardless of how the consumer runs.

## Overview

### Context

- The launcher record is built once at module load from
  `Deno.execPath()`; nothing checks what that path is.
- The JSDoc + README tell compiled consumers to pass their own
  `acpFront`. That hands the front version back to the consumer — the
  duplicate `acp-fronts-drop-npx` just removed.
- flowai-workflow already answers the same question for its own
  re-exec (`src/hitl/hitl-mcp-server.ts`): basename of `execPath` is
  `deno` / `deno.*` ⇒ Deno CLI, otherwise compiled.

### Constraints

- No new copy of the front versions anywhere.
- A missing Deno CLI must fail with a message that names the runtime,
  the executable and the remedy — not `os error 2`.
- Public API unchanged (`AcpFrontLauncher` shape, `getAcpFront`,
  `listAcpFronts`).

## Definition of Done

- [x] `resolveDenoCli(execPath)` returns `execPath` when its basename is
      `deno` or `deno.<ext>`, else the bare `deno` (PATH lookup by the
      spawner). Both npm launchers use it.
- [x] `spawnClient` turns `Deno.errors.NotFound` from the spawn into an
      error naming runtime + executable, with the install-Deno hint when
      the executable is the bare `deno`.
- [x] `deno task check` green.
- [x] README, SRS, SDS, `runtime/AGENTS.md` describe the resolution.

## Solution

1. `fronts.ts`: export `resolveDenoCli(execPath: string): string`; the
   two npm records use `cmd: resolveDenoCli(Deno.execPath())`.
2. `handshake.ts`: wrap the `AcpStdioClient` construction; on
   `Deno.errors.NotFound` throw `missingFrontExecutableError(runtime,
   cmd)` (exported, pure, unit-tested for both message shapes).
3. Docs: replace "compiled consumers must pass their own `acpFront`"
   with "compiled consumers need `deno` on PATH; `acpFront` remains the
   override".

### Verification

- `deno task check`
- flowai-workflow: pin bump to the released version + `deno task check`.
