---
date: "2026-09-15"
status: to do
implements: [FR-L12]
tags: [interactive, skills, api-surface, home-dir, srs-drift]
related_tasks: []
---
# Audit `launchInteractive`: keep it, and where may it write?

## Goal

Decide whether `RuntimeAdapter.launchInteractive` stays in the public
interface, and bring its skill injection in line with the project rule
that forbids mutating the user's home directory. Today the method has no
live caller and writes into `~/` on all three runtimes that implement it
— so the library carries an API surface that costs maintenance and can
leave debris in a user's config.

## Overview

### Context

Two findings surfaced while wiring FR-L45 (the
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` switch) through every Claude
spawn site.

**1. No consumer calls it.** Searched every `.ts` / `.js` file under
`~/www` (2026-09-15): 265 hits, none of them a call. 250 sit in
`flowai-workflow/.flowai-workflow/**/worktree` — per-run copies of the
same source. Of the rest: `flowai-workflow/src/testing/fake-runtime.ts`
rejects with "launchInteractive() is not emulated", 22 stub members
across `flowai-workflow/src/engine/*_test.ts` and
`tg-ide-bridge/engine|e2e/*_test.ts` exist only to satisfy the
interface, `tg-ide-bridge/e2e/harness.ts:280` re-binds it without
calling, and the last 10 are this package's own definition,
implementations and tests. No production path invokes the method.

**2. Skill injection writes into the user's home.** All three
implementations copy skill directories into a real user-level path and
delete them in a `finally`:

- claude — `claudeSkillsDir()` → `$CLAUDE_CONFIG_DIR/skills`, falling
  back to `~/.claude/skills`
- codex — `codexSkillsDir()` → `~/.agents/skills`
- opencode — `opencodeSkillsDir()` → `~/.claude/skills`

A crash between copy and cleanup leaves foreign skill directories in a
user's config, where they are then discovered by every later session of
that IDE. Two concurrent library users injecting a same-named skill
overwrite each other (`copy(..., { overwrite: true })`).

`CLAUDE.md` forbids exactly this: solutions must not rely on mutating
files under `~/`, and a feature that would require it at runtime should
stay unsupported with the reason documented.

**3. SRS and code disagree.** FR-L12 describes the Claude path as "temp
`CLAUDE_CONFIG_DIR` with symlinked auth + copied skills" and the
OpenCode path as "temp `.claude/skills/`". Neither is temp in the code.
Its `Evidence:` lines also point at stale locations
(`runtime/types.ts:90-108`, `runtime/claude-adapter.ts:17-49,78-120`) —
the types moved to `runtime/adapter-types.ts` since.

Note that FR-L18 already solved a neighbouring problem properly:
`runtime/setting-sources.ts` builds a filtered **tmp** config dir and
redirects `CLAUDE_CONFIG_DIR` at it for one run. That is the pattern to
weigh the injection against.

### Current State

- Interface: `launchInteractive(opts: InteractiveOptions)` on
  `RuntimeAdapter` (`runtime/adapter-types.ts`), advertised by the
  `interactive` capability flag — `true` on the CLI transport for
  claude / codex / opencode, `false` for cursor and `false` on every
  ACP capability vector.
- Implementations: `runtime/claude-adapter.ts` (`--append-system-prompt`),
  `runtime/codex-adapter.ts` (`--config base_instructions=…`),
  `runtime/opencode-adapter.ts` (`--system-prompt`),
  `runtime/cursor-adapter.ts` throws "Cursor has no interactive CLI mode".
- All spawn with `stdin`/`stdout`/`stderr: "inherit"` and return only
  `{ exitCode }`; the library observes nothing about the session.
- FR-L45 (2026-09-15) added the non-essential-traffic switch to the
  claude implementation, so removing the method would remove that too.

### Constraints

- No mutation of `~/` at runtime, per `CLAUDE.md`. A tmp-dir approach is
  acceptable; a "copy in, hope to clean up" approach is not.
- Removing a public method is a breaking change for any consumer outside
  the three repos checked — confirm the JSR download story before
  proposing removal.
- Whatever is decided, FR-L12 must end up describing what the code
  actually does; stale `Evidence:` lines get fixed in the same pass.

## Definition of Done

- [ ] Verdict recorded on whether `launchInteractive` stays, with the
      evidence behind it (consumer search + whether any out-of-repo
      consumer plausibly exists).
- [ ] If it stays: skill injection no longer writes under `~/`, or the
      reason it cannot be avoided is documented and the method is marked
      unsupported per the `CLAUDE.md` rule.
- [ ] If it goes: removal covers the interface, all four adapters, the
      `interactive` capability flag, FR-L12, and the SDS.
- [ ] FR-L12 matches the code, with current `Evidence:` locations.
- [ ] `deno task check` green.

## Solution

Not filled — this task is an analysis first. Fill after the variant is
chosen with the user.
