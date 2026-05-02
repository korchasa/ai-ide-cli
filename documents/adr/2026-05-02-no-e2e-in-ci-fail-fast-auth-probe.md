---
id: ADR-0001
status: accepted
date: 2026-05-02
tags: [ci, testing, e2e]
---
# Disable Auto E2E In CI; Fail-Fast Auth-Probe Locally

## Context

The opt-in real-binary e2e suite ([documents/requirements.md](../requirements.md#3-31-fr-l31-real-binary-e2e-suite))
ran automatically on every PR + push to main via `.github/workflows/ci-e2e.yml`
(soak window, `continue-on-error: true`). The repo holds no API key
secrets (`gh secret list` empty). Without authenticated CLI sessions
the suite produced a false-positive layout: `"Not logged in · Please run
/login"` arrived inside `CliRunOutput.result`, so 9/11 session
scenarios treated it as a valid response while only the two that
asserted on assistant text failed. Real regressions were therefore
hidden behind expected-looking advisory failures. Gating in
`e2e/_helpers.ts:e2eEnabled()` only verified binary presence on PATH,
not auth state.

## Alternatives

- **A. Silent auth-probe gate** — probe CLI before tests, return `false`
  from `e2eEnabled` when not authenticated so scenarios show as
  `ignored`.
  - Pros: tests stay valuable locally; CI without secrets simply skips.
  - Cons: silent skip masks "forgot to login" mistakes; CI still queues
    a run for nothing.
  - Rejected because: project rule is "fail fast, fail clearly"; silent
    skip violates it.

- **B. Add API key secrets to repo** — `gh secret set ANTHROPIC_API_KEY`
  / `OPENAI_API_KEY` / `OPENCODE_API_KEY` so CI gets real auth.
  - Pros: real-binary regressions caught on every push.
  - Cons: per-push token spend; admin overhead for key rotation;
    fork-PR auth restriction; Claude's primary auth path is OAuth, not
    API key — env-var alone may not satisfy the CLI.
  - Rejected because: operational overhead disproportionate to an OSS
    library; does not solve OAuth-vs-API-key mismatch.

- **C. Hybrid: use secret if present, else skip** — gate on env-var
  presence in CI, probe locally.
  - Pros: opt-in CI when keys exist.
  - Cons: combines complexity of A and B; behaviour diverges between
    fork-PR / push to main / Dependabot; configuration drift.
  - Rejected because: unnecessary complexity for a library — e2e is a
    developer-machine concern.

- **D. (CHOSEN) Fail-fast auth-probe + remove auto e2e in CI** —
  `e2eEnabled` runs `adapter.invoke("Reply with: ok")` after the binary
  probe; on auth-failure pattern throws loud `Error` at test-file load
  time. `.github/workflows/ci-e2e.yml` removed. Manual
  `.github/workflows/e2e.yml` (`workflow_dispatch`) remains for ad-hoc
  runs from a repo with secrets.
  - Pros: matches "fail fast, fail loud"; "forgot to login" surfaces as
    one clear error per runtime; CI noise eliminated; manual workflow
    preserved.
  - Cons: real-binary regressions caught only when developer runs
    `deno task e2e` locally; ~$0.0001 token cost per runtime per
    invocation.

## Decision

Adopt alternative **D**. The auth-probe lives in
[e2e/_auth.ts](../../e2e/_auth.ts) (`assertAuthenticated`) and is
invoked from `e2eEnabled` in [e2e/_helpers.ts](../../e2e/_helpers.ts)
after the binary check. `.github/workflows/ci-e2e.yml` is removed; the
manual `.github/workflows/e2e.yml` stays. Tracked in SRS as
[FR-L34](../requirements.md#3-33-fr-l34-auth-probe-gate-for-e2e-suite).

## Consequences

- Eliminates false-positive CI advisory failures that hid real
  regressions.
- Converts "missing login" from a noisy mix of assertion failures into
  one loud error per runtime at test-file load time.
- No token spend on every push.
- Real-binary regressions are now discovered only when the developer
  runs `deno task e2e` locally — slower feedback than automatic CI
  would provide; acceptable for a library whose consumers have other
  feedback channels (downstream `@korchasa/flowai-workflow` integration
  tests).
- ~$0.0001 token cost per runtime per `deno task e2e` invocation.
- SDS § 3.13 updated to describe `e2e/_auth.ts` and the CI policy.
- SRS adds FR-L34; FR-L31 acceptance row about `ci-e2e.yml` replaced
  with the removal note.
- If the repo later adds API key secrets and chooses to re-enable
  automatic CI e2e, this ADR must be superseded by a new ADR
  documenting the trade-off shift.
