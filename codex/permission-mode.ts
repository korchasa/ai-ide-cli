/**
 * @module
 * Single source of truth for Codex permission-mode → flag mapping.
 *
 * Both Codex transports — `codex exec --experimental-json` (NDJSON,
 * snake_case argv) and `codex app-server` (JSON-RPC, camelCase fields)
 * — share the same conceptual decision: "given a runtime-neutral
 * permission mode, what sandbox + approval policy should Codex apply?".
 * This module owns that decision; the per-transport callers
 * ({@link permissionModeToCodexArgs} in `codex/process.ts` and
 * {@link permissionModeToThreadStartFields} in `codex/session.ts`)
 * become thin serializers over {@link decidePermissionMode}.
 *
 * Without this consolidation the two callers drift — already happened
 * once when the canonical mode list was extended on one side only.
 */

/**
 * Sandbox-mode literal accepted by Codex's `--sandbox <mode>` flag and
 * the app-server `thread/start` `sandbox` field.
 */
export type SandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

/**
 * Approval-policy literal accepted by Codex's
 * `--config approval_policy="<mode>"` override and the app-server
 * `thread/start` `approvalPolicy` field.
 */
export type ApprovalPolicy =
  | "never"
  | "on-request"
  | "on-failure"
  | "untrusted";

/**
 * Codex sandbox modes accepted as a `permissionMode` pass-through. When
 * the caller passes one of these directly, only `sandbox` is set.
 */
export const CODEX_SANDBOX_MODES: ReadonlySet<SandboxMode> = new Set<
  SandboxMode
>([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);

/**
 * Codex approval-policy modes accepted as a `permissionMode` pass-through.
 * When the caller passes one of these directly, only `approvalPolicy` is
 * set.
 */
export const CODEX_APPROVAL_MODES: ReadonlySet<ApprovalPolicy> = new Set<
  ApprovalPolicy
>([
  "never",
  "on-request",
  "on-failure",
  "untrusted",
]);

/**
 * Conceptual decision produced by {@link decidePermissionMode}.
 *
 * `undefined` fields mean "do not override" — Codex falls back to its
 * own config defaults. Both transports honour the same convention.
 */
export interface CodexPermissionDecision {
  /** Sandbox mode override, or `undefined` to skip. */
  sandbox?: SandboxMode;
  /** Approval-policy override, or `undefined` to skip. */
  approvalPolicy?: ApprovalPolicy;
}

/**
 * Map a runtime-neutral permission mode to Codex's sandbox + approval
 * policy decision. Pure function — no I/O, no validation side effects.
 *
 * Recognized normalized modes:
 * - `default` / `undefined`  — no overrides.
 * - `plan`                   — `read-only` + `never`.
 * - `acceptEdits`            — `workspace-write` + `never`.
 * - `bypassPermissions`      — `danger-full-access` + `never`.
 *
 * Codex-native pass-through modes:
 * - `read-only` / `workspace-write` / `danger-full-access` — bare sandbox.
 * - `never` / `on-request` / `on-failure` / `untrusted`   — bare approval.
 *
 * Unrecognized values yield `{}` so callers fall back to Codex defaults
 * rather than throwing — mirrors the historical behaviour of the
 * per-transport mappers this module replaces.
 */
export function decidePermissionMode(
  mode?: string,
): CodexPermissionDecision {
  if (!mode || mode === "default") return {};
  switch (mode) {
    case "plan":
      return { sandbox: "read-only", approvalPolicy: "never" };
    case "acceptEdits":
      return { sandbox: "workspace-write", approvalPolicy: "never" };
    case "bypassPermissions":
      return { sandbox: "danger-full-access", approvalPolicy: "never" };
  }
  if (CODEX_SANDBOX_MODES.has(mode as SandboxMode)) {
    return { sandbox: mode as SandboxMode };
  }
  if (CODEX_APPROVAL_MODES.has(mode as ApprovalPolicy)) {
    return { approvalPolicy: mode as ApprovalPolicy };
  }
  return {};
}
