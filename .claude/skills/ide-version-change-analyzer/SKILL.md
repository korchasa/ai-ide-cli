---
name: ide-version-change-analyzer
description: Collects Claude Code, OpenCode, Cursor, and Codex release changes for a requested time window and evaluates relevance to @korchasa/ai-ide-cli. Use when asked to monitor IDE/agent CLI updates, compare versions, or assess upgrade impact.
---

# IDE Version Change Analyzer

Use this skill to fetch changes for supported agent IDE runtimes over a user-specified time window and judge whether they matter for this repository.

Supported runtimes:

- Claude Code
- OpenCode
- Cursor
- Codex

## Inputs

Accept any of these user time-window forms:

- Explicit dates: `2026-05-01..2026-05-16`
- Relative dates: `last week`, `за последние 3 дня`
- Version range: `Claude Code 2.1.130..2.1.143`
- Since last check: infer only if the project contains a previous saved report; otherwise ask for a concrete window.

If the user omits the window, ask one concise clarification before searching.

## Primary Sources

Use primary sources first:

- Claude Code: `https://code.claude.com/docs/en/changelog`
- Claude Code raw changelog: `https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md`
- OpenCode GitHub releases: `https://github.com/sst/opencode/releases`
- OpenCode releases API: `https://api.github.com/repos/sst/opencode/releases?per_page=100`
- Cursor changelog: `https://cursor.com/changelog`
- Codex changelog: `https://developers.openai.com/codex/changelog`
- Codex GitHub releases: `https://github.com/openai/codex/releases`
- Codex releases API: `https://api.github.com/repos/openai/codex/releases?per_page=100`

Secondary sources are allowed only to fill gaps and must be labeled as secondary. Do not treat social posts, scraped changelog mirrors, or search snippets as authoritative when a primary source is available.

## Fetch Fallbacks (verified 2026-05-17)

When a primary source fails, use these fallbacks instead of giving up:

- **Claude Code — raw `CHANGELOG.md` lacks calendar dates** (only version headers). For date-windowed queries, use the GitHub Releases API which has `published_at`:
  - `NO_COLOR=1 gh api 'repos/anthropics/claude-code/releases?per_page=100' --jq '[.[] | select(.published_at >= "<from>" and .published_at <= "<to>T23:59:59Z") | {tag: .tag_name, date: .published_at, body: (.body[:2500])}]' > /tmp/claude-releases.json`
- **OpenCode — `anomalyco/opencode` is the wrong repo** (returns almost no data). The correct upstream is `sst/opencode`:
  - `NO_COLOR=1 gh api 'repos/sst/opencode/releases?per_page=100' --jq '[.[] | select(.published_at >= "<from>" and .published_at <= "<to>T23:59:59Z") | {tag: .tag_name, date: .published_at, body: (.body[:2000])}]'`
- **Codex / large payloads — `WebFetch` fails with `maxContentLength size of 10485760 exceeded`** on the GitHub Releases JSON. Use `gh api` with a `--jq` projection that trims `body` (e.g. `.body[:3000]`) to keep the payload under the limit; redirect to a temp file when output may still exceed the Bash 50KB cap.
- **Persisted-output truncation** — `Bash` persists tool output at ~50 KB, which can cut a JSON document mid-string and break later `jq` calls. Always redirect `gh api` JSON to `/tmp/<runtime>-releases.json` (`> /tmp/...`) before parsing, and read it with `jq -r '.[] | ...'` from disk; do not pipe through `head -c` before `jq`.
- **Cursor patch-level dates** — the cursor.com changelog groups entries by minor version (3.3/3.4) and only marks calendar dates for the major notable items. Patch-level (3.3.x) details are not exposed; flag this as a gap rather than guessing.

## Project Relevance Model

Score each change from 0 to 5:

- `5` Blocking or urgent: CLI protocol, invocation flags, stream event schema, session behavior, auth, sandboxing, install package, or security update likely affects this library.
- `4` High: new or changed runtime capability that maps to adapters, sessions, content extraction, tool-use observation, reasoning effort, MCP, or e2e coverage.
- `3` Medium: user-visible runtime behavior worth tracking, but no immediate code change is obvious.
- `2` Low: documentation, UI, cloud-only, desktop-only, or provider update with indirect library impact.
- `1` Informational: release exists but no plausible project impact.
- `0` Irrelevant: unrelated product, marketing, or non-supported surface.

Default project hotspots:

- `claude/`, `opencode/`, `cursor/`, `codex/`
- `runtime/adapter-types.ts`, `runtime/session-types.ts`, `runtime/content.ts`
- `runtime/tool-filter.ts`, `runtime/reasoning-effort.ts`, `runtime/mcp-injection.ts`
- `e2e/`
- `documents/requirements.md`, `documents/design.md`

## Workflow

1. Normalize the requested window to concrete dates or versions.
2. Fetch primary sources for all four runtimes unless the user narrows scope.
3. Extract only entries inside the requested window or version range.
4. Classify every relevant entry by runtime and surface:
   - invocation and flags
   - stream or event schema
   - sessions and resume
   - tool use, MCP, permissions, sandboxing
   - auth, install, package, platform
   - model and reasoning behavior
   - docs-only or cloud-only
5. Score each entry with the relevance model.
6. Map score `3..5` entries to likely project areas and recommended actions.
7. Call out unknowns where the source is incomplete or Cursor lacks patch-level details.
8. Return a concise report in the user's language; write documentation/report files only if the user asks.

## Report Format

Use this structure:

```markdown
**Период**

- Окно: <normalized dates or versions>
- Источники: <primary source list>

**Итог**

- <1-3 bullets with highest-impact conclusion>

**Существенные изменения**

- <runtime>: <change> — полезность <0-5>; зона проекта: <paths or none>; действие: <recommendation>

**Низкий Приоритет**

- <runtime>: <brief grouped summary>

**Пробелы**

- <source limitations, missing patch notes, or verification gaps>
```

## Action Guidance

Recommend code work only when the source evidence points to a concrete repository risk:

- New or changed CLI flags -> inspect `<runtime>/argv.ts` or `<runtime>/process.ts`.
- Event shape changes -> inspect `<runtime>/events.ts`, `<runtime>/stream.ts`, or `<runtime>/content.ts`.
- Session changes -> inspect `<runtime>/session.ts` and `runtime/session_contract_test.ts`.
- Tool, MCP, sandbox, auth changes -> inspect matching `runtime/*` helper and e2e tests.
- Documentation-only changes -> suggest no code change.

When recommending implementation, include the smallest verification command:

- Focused unit test: `NO_COLOR=1 deno task test <path>`
- Final check: `NO_COLOR=1 deno task check`

Never claim the project is affected unless the source entry names a supported runtime surface or there is a clear adapter-level inference.
