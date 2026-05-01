/**
 * @module
 * Cross-serializer-equivalence tests for
 * {@link decidePermissionMode}. Both transport-specific mappers
 * ({@link permissionModeToCodexArgs}, {@link permissionModeToThreadStartFields})
 * must derive their output from the same conceptual decision — drift
 * between them was the original motivation for this consolidation.
 */

import { assertEquals } from "@std/assert";
import {
  type ApprovalPolicy,
  decidePermissionMode,
  type SandboxMode,
} from "./permission-mode.ts";
import { permissionModeToCodexArgs } from "./process.ts";
import { permissionModeToThreadStartFields } from "./session.ts";

const ALL_MODES: readonly (string | undefined)[] = [
  undefined,
  "default",
  "plan",
  "acceptEdits",
  "bypassPermissions",
  "read-only",
  "workspace-write",
  "danger-full-access",
  "never",
  "on-request",
  "on-failure",
  "untrusted",
  "garbage",
];

function reconstructFromArgs(
  argv: string[],
): { sandbox?: SandboxMode; approvalPolicy?: ApprovalPolicy } {
  const out: { sandbox?: SandboxMode; approvalPolicy?: ApprovalPolicy } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--sandbox") {
      out.sandbox = argv[++i] as SandboxMode;
    } else if (argv[i] === "--config") {
      const m = argv[++i].match(/^approval_policy="(.+)"$/);
      if (m) out.approvalPolicy = m[1] as ApprovalPolicy;
    }
  }
  return out;
}

Deno.test("decidePermissionMode — both serializers agree across every input", () => {
  for (const mode of ALL_MODES) {
    const decision = decidePermissionMode(mode);
    const fromArgs = reconstructFromArgs(permissionModeToCodexArgs(mode));
    const fromFields = permissionModeToThreadStartFields(mode);
    assertEquals(
      fromArgs,
      decision,
      `permissionModeToCodexArgs drifted from decidePermissionMode for ${mode}`,
    );
    assertEquals(
      fromFields,
      decision,
      `permissionModeToThreadStartFields drifted from decidePermissionMode for ${mode}`,
    );
  }
});

Deno.test("decidePermissionMode — normalized modes set both sandbox and approvalPolicy", () => {
  assertEquals(decidePermissionMode("plan"), {
    sandbox: "read-only",
    approvalPolicy: "never",
  });
  assertEquals(decidePermissionMode("acceptEdits"), {
    sandbox: "workspace-write",
    approvalPolicy: "never",
  });
  assertEquals(decidePermissionMode("bypassPermissions"), {
    sandbox: "danger-full-access",
    approvalPolicy: "never",
  });
});

Deno.test("decidePermissionMode — pass-through native sandbox modes", () => {
  for (const m of ["read-only", "workspace-write", "danger-full-access"]) {
    assertEquals(decidePermissionMode(m), { sandbox: m as SandboxMode });
  }
});

Deno.test("decidePermissionMode — pass-through native approval modes", () => {
  for (const m of ["never", "on-request", "on-failure", "untrusted"]) {
    assertEquals(decidePermissionMode(m), {
      approvalPolicy: m as ApprovalPolicy,
    });
  }
});

Deno.test("decidePermissionMode — undefined / default / unknown → empty", () => {
  assertEquals(decidePermissionMode(undefined), {});
  assertEquals(decidePermissionMode("default"), {});
  assertEquals(decidePermissionMode("garbage"), {});
});
