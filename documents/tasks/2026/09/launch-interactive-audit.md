---
date: "2026-09-15"
status: done
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

**4. Re-check 2026-10-18.**

- Consumer grep over `~/www` (excl. `.flowai-workflow/**` and
  worktrees): same picture — stubs in `flowai-workflow` (fake-runtime +
  ~16 engine test stubs), `tg-ide-bridge` (6 test stubs +
  `e2e/harness.ts:280` bind), zero calls.
- JSR `GET /scopes/korchasa/packages/ai-ide-cli/dependents` → `total: 2`
  (`flowai-workflow`, `tg-ide-bridge`), both own repos. Latest 1.2.1.
- Both consumers pin 0.x: `flowai-workflow/deno.json` `^0.9.1`,
  `tg-ide-bridge/deno.json` `^0.5.8` — neither receives 1.x today.
  Two more local importers outside JSR (plan-critic):
  `flowai/flowai-experiments/deno.json:3` `@0.8.3` and
  `tools/foxcode/opencode/test/acceptance/ide-task.test.ts:23-26`
  `@0.8.2` — exact 0.x pins, no `launchInteractive` / `.interactive`
  use. JSR exposes no download counts; dependents list + local grep is
  the available evidence of out-of-repo use.
- Per-session skill paths that avoid `~/` (probed, scratch dirs only):
  - Claude 2.1.302: `--plugin-dir <dir>` ("for this session only")
    loads `<dir>/skills/<name>/SKILL.md`; manifest optional; skill is
    exposed namespaced as `<plugin>:<name>` (`bare:zz-probe-skill`).
  - OpenCode 1.16.2: `OPENCODE_CONFIG_CONTENT='{"skills":{"paths":[<skill dir>]}}'`
    and `OPENCODE_CONFIG_DIR=<dir>` both surface the skill in
    `opencode debug skill`; `paths` accepts the skill dir itself (no copy).
  - Codex 0.159.1: none found. `-c skills.config=[{path=…,enabled=true}]`
    does not add a skill to `codex debug prompt-input`; `extraRoots` exists
    only as an app-server RPC, not for the TUI.

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

### Affected Surface

surface-scout report (2026-10-18, verbatim):

````text
## Surface

Repo root: /Users/korchasa/www/flowai/ai-ide-cli/.claude/worktrees/launch-interactive-audit-02a5e8 (call it R). Top-level dirs: claude, codex, cursor, opencode, runtime, skill, e2e, scripts, documents.

**Library code (R)**
- R/runtime/adapter-types.ts:355-411 — `InteractiveOptions` (skills, systemPrompt, cwd, env, inheritEnv), `InteractiveResult` and the `launchInteractive` member of `RuntimeAdapter`. This is the public interface the decision is about.
- R/runtime/claude-adapter.ts — `claudeSkillsDir`, `injectSkills` and `removeInjectedSkills` at 66-110. They copy skills into `<config dir>/skills` with `overwrite: true` and delete them afterwards. `launchInteractive` at ~319 (uses `--append-system-prompt`, and FR-L45 sets the traffic switch). The `interactive: true` flag is at 147 (CLI transport) and `interactive: false` at 129 (ACP).
- R/runtime/codex-adapter.ts — `codexSkillsDir` at 70 (`~/.agents/skills`), `launchInteractive` at 216-222, capability flags at 104, 130 and 148.
- R/runtime/opencode-adapter.ts — `opencodeSkillsDir` at 119 (`~/.claude/skills`), `launchInteractive` at 263-271, flags at 133, 141 and 159.
- R/runtime/cursor-adapter.ts:146 and 240-242 — `interactive: false`, and `launchInteractive` throws "no interactive CLI mode". This only changes if the method leaves the interface.
- R/runtime/capability-types.ts:9-10 — the `interactive` flag on `RuntimeCapabilities`. It goes away or stays together with the method.
- R/runtime/transport_capabilities_test.ts:5, 34-44 — asserts that ACP downgrades `interactive`.
- R/runtime/spawn-env.ts, R/runtime/index.ts:33, R/runtime/types.ts:49, R/mod.ts:53 — exports of `InteractiveOptions`. These are the public surface; the `private-type-ref` rule in AGENTS.md applies. Also check `deno.json` `exports`.
- FR-L53 code the skill-dir helpers depend on: `defaultClaudeConfigDir` with `claudeAuthEnv`, plus the codex and opencode counterparts in `<runtime>/auth-env.ts`. If the skill-dir helpers are removed or redirected, check which of these become unused.
- R/runtime/setting-sources.ts (FR-L18) — builds a tmp `CLAUDE_CONFIG_DIR`. The task file names it as the pattern to weigh. It is also a second place that writes to a Claude config dir, so check how it interacts with `injectSkills` when `settingSources` is set.
- R/skill/ — the SKILL.md parser. It supplies `skill.rootPath` and `frontmatter.name` to the injection. Not changed, but it is a producer.

**Tests**
- R/runtime/claude-adapter_test.ts:158-190 — two FR-L45 `launchInteractive` tests (traffic switch visible to the child, caller-supplied switch survives). They break or are deleted if the method is removed.
- R/runtime/inherit_env_test.ts:124-127 — FR-L53 `launchInteractive` with `inheritEnv: false`, run per runtime.
- No test for the skill injection itself. grep on `*_test.ts` for SKILL/skills only found `capabilities_test.ts`, which is the LLM-probe inventory and unrelated.
- R/e2e/ — no file mentions interactive (grep found nothing), and `scripts/` and `deno.json` have none either. Not affected.

**Docs (R)**
- R/documents/requirements.md — FR-L12 at ~331-345 (the description says "temp CLAUDE_CONFIG_DIR" and "temp .claude/skills/", which disagrees with the code, and the Evidence lines are stale). Other mentions:
  - line 65-68: FR-L2-style adapter-interface text, with `launchInteractive()` in the member list and `interactive` in the capability list;
  - 392-393: Codex capability vector and skill injection;
  - 2236: ACP capability downgrade;
  - 2756-2822: FR-L45, where `launchInteractive` is in scope and has tests;
  - 3115: FR-L53 or similar, "Not covered: launchInteractive";
  - 3152: `InteractiveOptions` in the exported-types list;
  - 3173-3175: the FR-L53 spawn-site list.
- R/documents/design.md — lines 38 (import list), 235 and 254 (`InteractiveOptions` shape; it does not list `inheritEnv`), 298 (RuntimeAdapter), 1177-1178, 1199-1203 (names `codexSkillsDir` and `opencodeSkillsDir` as child-facing reads), 1219 and 1245 (FR-L45), 1419 (capability table), 1497 (codex interactive), 1980 (excluded from something, "inherited TTY").
- R/README.md — lines 64, 76, 86 (the capability table row "interactive TUI"), 212-217 and 268 (FR-L45 and FR-L53 text that names `launchInteractive`), 482.
- R/AGENTS.md:127 (FR-L45 nonessential-traffic note naming `launchInteractive`) and R/runtime/AGENTS.md:40 (FR-L53 lists "interactive" options).
- R/CLAUDE.md rule "must not rely on mutating files under ~/ or staging temp workspaces" — the governing rule. The same rule excludes copying skills into a tmp config dir and symlink farms, so FR-L18's "filtered tmp config dir" pattern may itself conflict with it. This matters when choosing among the options.
- Task file R/documents/tasks/2026/09/launch-interactive-audit.md — the plan. Its frontmatter `status` is `to do`, and it needs Solution and DoD edits as the work proceeds. Related task files that mention the method: R/documents/tasks/2026/10/isolated-child-env.md and R/documents/tasks/2026/10/acp-usage-schema-pgroup-ephemeral.md. Both are context only.
- R/CHANGELOG.md — generated by `standard-version`. The repo says a `!` commit raises the MAJOR version, so removing a method from the public interface is breaking. Removal is therefore a MAJOR bump with a forced edit for every consumer. Release is CI-driven.

**Consumers under /Users/korchasa/www/flowai (excluding per-run `.flowai-workflow/**/worktree` copies)**
- flowai-workflow/src/testing/fake-runtime.ts:125-127 — the method is implemented and rejects with "not emulated". If the member is removed from the interface it becomes a stale extra member, which TypeScript allows on an object literal only in some positions, so check it.
- flowai-workflow/src/engine/*_test.ts — stub members `launchInteractive()` that exist only to satisfy the interface: agent_effort_test.ts:68, engine_test.ts:1327 and 1417, agent_test.ts (near 126), agent_acp_options_test.ts:70, and agent_runtime_test.ts (at least 10 places: 54, 114, 194, 295, 342, 423, 474, 541, 617, 668, 707). Each also carries `interactive: false` in its capability vector. If the interface member or the `interactive` flag is removed, these stubs become excess properties, which fails type-checking on object literals typed as `RuntimeAdapter`.
- flowai-workflow/documents/requirements-engine/04-runtime-and-hooks.md:407 — says "`interactive` / `launchInteractive` — unsupported on ACP; never invoked".
- tg-ide-bridge/e2e/harness.ts:280 — `launchInteractive: inner.launchInteractive.bind(inner)`, a re-bind that breaks outright if the member is removed (a compile error on `inner.launchInteractive`). Also tg-ide-bridge/e2e/harness_test.ts:17 and 25.
- tg-ide-bridge/engine/ide_session_test.ts:134 and 147, capabilities_test.ts:223 and 256, dispatcher_test.ts:97 and 122 — stub adapters with `interactive: true` and a `launchInteractive` stub. Stub members only; no real callers.
- No production caller exists in any consumer. The only calls are in this package's own tests (grep for `.launchInteractive(` and the `interactive:` flag across tg-ide-bridge and flowai-workflow/src found definitions and stubs only). The task file reports the same finding.
- Consumers pin the library by import specifier, so a major bump is not automatic for them. Pins of `jsr:@korchasa/ai-ide-cli@` in those repos were not enumerated (see Not examined).

## Queries used
- `ls` of R; `cat` of the task file (first 80 lines).
- `grep -rnI "launchInteractive"` over R and over /Users/korchasa/www/flowai (excluding worktree copies).
- `grep -rnE "launchInteractive|InteractiveOptions|SkillsDir|\binteractive\b"` over R (ts, md, json).
- The same pattern over tg-ide-bridge and flowai-workflow/src.
- `grep -n launchInteractive` in flowai-workflow's 04-runtime-and-hooks.md.
- A grep of e2e, scripts and deno.json for interactive (no hits); a grep of tests for skills and SKILL; the `sed` of the skill-injection code in claude-adapter.ts.

## Not examined (budget)
- The rest of the task file past line 80, including the options and DoD already written there.
- The bodies of `injectSkills` use in codex-adapter.ts and opencode-adapter.ts (lines 216-300 and 263-310), and the `finally` cleanup paths.
- The exact `deno.json` `exports` map, and whether `InteractiveOptions` is reachable from a sub-path entry.
- Whether other repos under /Users/korchasa/www (outside flowai) use the method; the task file says none did on 2026-09-15.
- `jsr:@korchasa/ai-ide-cli@` pins in consumers.
- Whether the flowai plugin or skills folders (not this repo's `.claude/agents`) reference the method.

## Could not rule out
- A hidden consumer of the skill-injection behaviour through the `flowai-workflow init` command. `injectSkills` has the comment "e.g. flowai-workflow-init", which hints at an intended caller (an interactive init flow). I found no such call, but only searched for the method name.
- An fmt or lint exclusion or JSR `publish.include` entry naming the removed files, which could surface in `deno publish --dry-run`.
- ACP front or codex-acp handling of skills as an alternative injection route; not checked.
````

Dispositions (variant C):

- `RuntimeAdapter.launchInteractive`, `InteractiveOptions`, `InteractiveResult` (`runtime/adapter-types.ts`) — covered-by Solution step 2
- Skill injection in claude / codex / opencode adapters (`claudeSkillsDir` / `injectSkills` / `removeInjectedSkills`, `codexSkillsDir`, `opencodeSkillsDir`) — covered-by Solution step 2
- `runtime/cursor-adapter.ts` throwing stub — covered-by Solution step 2
- `interactive` flag (`runtime/capability-types.ts`, every capability vector, `runtime/transport_capabilities_test.ts`) — covered-by Solution steps 1–2
- Barrel exports (`mod.ts:53`, `runtime/index.ts:33`, `runtime/types.ts:49`) — covered-by Solution step 2
- `runtime/spawn-env.ts` — not affected — `grep -n -i interactive runtime/spawn-env.ts` → no hits (helper is option-agnostic)
- FR-L53 auth matchers (`<runtime>/auth-env.ts`, `defaultClaudeConfigDir`) — not affected — `defaultClaudeConfigDir` still used by `claude/process.ts:490`, `claude/session.ts:319`; `hostHome` by other child-facing lookups (Codex sessions dir, OpenCode log dir); only their uses in the removed `*SkillsDir` helpers go
- `runtime/setting-sources.ts` (FR-L18) — not affected — never called on the interactive path (`launchInteractive` in `runtime/claude-adapter.ts` takes no `settingSources`)
- `skill/` parser (FR-L11) — covered-by Solution step 3 — `SkillDef` loses its only in-library consumer (`InteractiveOptions.skills`); `skill/` stays public (FR-L11, re-exported by `flowai-workflow/src/mod.ts:140`), FR-L11 motivation reworded; `SkillDef` re-exports in `runtime/types.ts` / `runtime/index.ts` kept (removing them is a second break with no gain)
- Tests `runtime/claude-adapter_test.ts:158-190`, `runtime/inherit_env_test.ts:124-127` — covered-by Solution step 2
- `e2e/`, `scripts/`, `deno.json` tasks — not affected — no `interactive` / `launchInteractive` mention (scout grep)
- SRS FR-L12 + other SRS mentions (FR-L2 interface list, Codex vector, ACP downgrade, FR-L45, FR-L53 lists, exported types) — covered-by Solution step 3
- SDS mentions (§3 types, RuntimeAdapter, capability table, codex interactive, FR-L45, FR-L53 child-facing reads) — covered-by Solution step 3
- `README.md` capability table + FR-L45/FR-L53 paragraphs — covered-by Solution step 3
- `AGENTS.md:127`, `runtime/AGENTS.md` (FR-L53 list, codex `~/.agents/skills` note) — covered-by Solution step 3
- `CLAUDE.md` home-mutation rule — not affected — governing constraint, not edited
- `CHANGELOG.md` / release — covered-by Solution (commit `feat(runtime)!:`; CI writes CHANGELOG on release)
- Consumers `flowai-workflow` (fake-runtime, engine test stubs, `04-runtime-and-hooks.md:407`) and `tg-ide-bridge` (test stubs, `e2e/harness.ts:280`) — not affected now — both pin 0.x (`^0.9.1`, `^0.5.8`), out of this repo; edit forced only on their deliberate upgrade
- Related tasks `2026/10/isolated-child-env.md` (FR-L53), `2026/10/acp-usage-schema-pgroup-ephemeral.md` (FR-L49..52) — not affected — context only; no FR overlap with FR-L12, so not in `related_tasks`
- ACP fronts / codex-acp as a skills route — not affected — every ACP vector already has `interactive: false`; no ACP code path takes `skills` (`grep -rn -i skill runtime/acp/` → no hits)
- `deno.json` fmt / lint / `publish.include` / `exclude` — not affected — plan deletes no file, only members
- flowai plugins / skills repos (`flowai`, `flowai-plugins`, `flowai-cli`, `flowai-hive`, `flowai-center`) — not affected — plan-critic grep for `launchInteractive` → no hits
- Hidden `flowai-workflow init` consumer of skill injection — not affected — `grep -E "flowai-workflow-init|parseSkill|loadSkill"` over `flowai-workflow/src` + `tg-ide-bridge` → no hits

## Definition of Done

- [x] Verdict recorded on whether `launchInteractive` stays, with the
      evidence behind it (consumer search + whether any out-of-repo
      consumer plausibly exists). Verdict: removed (user choice
      2026-10-18, variant C); evidence in Context §1 and §4.
      FR-L12 · `documents/requirements.md` §3.12 · manual — korchasa.
- [x] If it stays: skill injection no longer writes under `~/`, or the
      reason it cannot be avoided is documented and the method is marked
      unsupported per the `CLAUDE.md` rule. Resolved by removal: no code
      path copies skills anywhere.
      FR-L12 · `runtime/transport_capabilities_test.ts` · `grep -rn -E "injectSkills|SkillsDir" --include='*.ts' runtime` → no hits.
- [x] If it goes: removal covers the interface, all four adapters, the
      `interactive` capability flag, FR-L12, and the SDS.
      FR-L12 · `runtime/transport_capabilities_test.ts` (FR-L12 removal
      test) · `deno task test runtime/transport_capabilities_test.ts`.
- [x] FR-L12 matches the code, with current `Evidence:` locations.
      FR-L12 · `documents/requirements.md` §3.12 · `grep -n "FR-L12" documents/requirements.md`.
- [x] `deno task check` green.
      FR-L12 · whole suite · `deno task check`.

## Solution

Variant C — remove the interactive launcher from the public surface.
Breaking: commit `feat(runtime)!:` → next release MAJOR (2.0.0).
Consumers (`flowai-workflow` `^0.9.1`, `tg-ide-bridge` `^0.5.8`) are
untouched until they upgrade; then they delete their `launchInteractive`
stubs, `interactive:` capability fields and the `e2e/harness.ts:280`
bind (out of this repo — Follow-ups).

1. **RED** — `runtime/transport_capabilities_test.ts`: drop the
   `acp.interactive` assertion; add `// FR-L12` compile-time negative
   assertions in the `session_contract_test.ts` `pid` style
   (`"launchInteractive" extends keyof RuntimeAdapter ? never : true`,
   same for `"interactive"` on `RuntimeCapabilities`). No runtime
   `in` checks — adapter literals are annotated `: RuntimeAdapter`, so
   excess-property checks already reject a stale member. RED =
   `deno check runtime/transport_capabilities_test.ts` fails while the
   members exist (`deno task test` runs `--no-check`, so it cannot be
   the RED command).
2. **GREEN** — remove:
   - `runtime/adapter-types.ts`: `InteractiveOptions`,
     `InteractiveResult`, `RuntimeAdapter.launchInteractive`.
   - `runtime/capability-types.ts`: `interactive` field.
   - `runtime/claude-adapter.ts`: `claudeSkillsDir`, `injectSkills`,
     `removeInjectedSkills`, `launchInteractive`, both `interactive:`
     entries + comment; drop now-unused imports (`copy`, `join`,
     `defaultClaudeConfigDir` only if unused).
   - `runtime/codex-adapter.ts`: `codexSkillsDir`, `launchInteractive`,
     `interactive:` entries + JSDoc lines; unused imports.
   - `runtime/opencode-adapter.ts`: `opencodeSkillsDir`,
     `launchInteractive`, `interactive:` entries + comment; unused
     imports.
   - `runtime/cursor-adapter.ts`: throwing `launchInteractive`,
     `interactive:` entry, import.
   - Barrels: `mod.ts`, `runtime/index.ts`, `runtime/types.ts` exports.
   - Tests: `runtime/claude-adapter_test.ts` FR-L45 interactive pair,
     `runtime/inherit_env_test.ts` interactive case.
   - Comments mentioning the launcher (`codex-adapter.ts` ACP note,
     `opencode-adapter.ts` ACP note).
3. **Docs**:
   - SRS: §0 add "Interactive TUI out of scope (FR-L12)"; §3.12 FR-L12
     rewritten to the removal contract (Description, Tasks link,
     Acceptance → removal test); purge `launchInteractive` /
     `interactive` / `InteractiveOptions` from FR-L1 interface +
     capability lists, FR-L11 motivation, Codex vector (FR-L13), ACP
     downgrade, FR-L45, FR-L51 "Not covered", FR-L53 spawn list (14 →
     11 sites) + lookups, exported types.
   - SDS / `runtime/AGENTS.md`: same 14 → 11 spawn-site counter.
   - SDS: purge from types §, RuntimeAdapter §, capability table, codex
     notes, FR-L45 / FR-L53 sections.
   - README: capability examples, table row, FR-L45 / FR-L53 paragraphs.
   - `AGENTS.md:127`, `runtime/AGENTS.md` (codex note, FR-L51, FR-L53).
4. **Verify**:
   - `grep -rn -E "launchInteractive|InteractiveOptions|InteractiveResult|SkillsDir|injectSkills" --include='*.ts' --include='*.md' . | grep -v -E '^(\./)?(\.claude|documents/tasks|CHANGELOG)'`
     → expected hits only: FR-L12 removal text (SRS §0 + §3.12) and
     the FR-L12 assertions in `runtime/transport_capabilities_test.ts`.
   - `grep -rn -w "interactive" --include='*.ts' --include='*.md' . | grep -v -E '^(\./)?(\.claude|documents/tasks|CHANGELOG)'`
     → expected hits only: the same FR-L12 text/test and prose that is
     not the flag (`runtime/content.ts:93` "interactive UI").
   - `grep -rn -E "14 (agent spawn )?sites" documents runtime/AGENTS.md` → none.
   - `deno task check` exit 0 (doc-lint + `publish --dry-run` catch
     dangling exported types).

Error handling: none new — removal only. Consumers calling the method
get a compile error (`Property 'launchInteractive' does not exist`), the
intended fail-fast signal.

## Follow-ups

- Consumers on upgrade past 0.x: `flowai-workflow`
  (`src/testing/fake-runtime.ts`, `src/engine/*_test.ts` stubs,
  `documents/requirements-engine/04-runtime-and-hooks.md:407`) and
  `tg-ide-bridge` (`engine/*_test.ts` stubs, `e2e/harness.ts:280`,
  `e2e/harness_test.ts`) drop `launchInteractive` members and
  `interactive:` capability fields.
