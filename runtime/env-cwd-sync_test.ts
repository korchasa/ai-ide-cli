import {
  assertEquals,
  assertNotStrictEquals,
  assertStrictEquals,
} from "@std/assert";
import { resolve } from "@std/path";
import { withSyncedPWD } from "./env-cwd-sync.ts";

Deno.test("withSyncedPWD: cwd undefined → returns env unchanged (reference-equal)", () => {
  const env = { FOO: "bar" };
  const out = withSyncedPWD(env, undefined);
  assertStrictEquals(out, env);
});

Deno.test("withSyncedPWD: cwd undefined + env undefined → returns undefined", () => {
  const out = withSyncedPWD(undefined, undefined);
  assertEquals(out, undefined);
});

Deno.test("withSyncedPWD: env.PWD already set → caller intent wins (reference-equal)", () => {
  const env = { FOO: "bar", PWD: "/explicit/override" };
  const out = withSyncedPWD(env, "/some/other/cwd");
  assertStrictEquals(out, env);
  assertEquals(out?.PWD, "/explicit/override");
});

Deno.test("withSyncedPWD: env undefined + cwd set → injects absolute PWD", () => {
  const tmp = "/tmp/some-abs-path";
  const out = withSyncedPWD(undefined, tmp);
  assertEquals(out, { PWD: resolve(tmp) });
});

Deno.test("withSyncedPWD: env set + cwd set → merges, returns new object", () => {
  const env = { FOO: "bar", BAZ: "qux" };
  const tmp = "/tmp/another-path";
  const out = withSyncedPWD(env, tmp);
  assertNotStrictEquals(out, env, "must return a new object, not mutate input");
  assertEquals(out, { FOO: "bar", BAZ: "qux", PWD: resolve(tmp) });
  // input must not be mutated
  assertEquals(env, { FOO: "bar", BAZ: "qux" });
});

Deno.test("withSyncedPWD: relative cwd → resolved to absolute PWD", () => {
  const out = withSyncedPWD({}, "./some-relative/dir");
  const pwd = out?.PWD ?? "";
  if (!pwd.startsWith("/")) {
    throw new Error(`expected absolute PWD, got ${pwd}`);
  }
  assertEquals(pwd, resolve("./some-relative/dir"));
});

Deno.test("withSyncedPWD: integration smoke — child observes injected PWD via bash", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "pwd-sync-" });
  try {
    const env = withSyncedPWD(undefined, tmp);
    const cmd = new Deno.Command("bash", {
      args: ["-c", 'echo "$PWD"'],
      stdout: "piped",
      stderr: "piped",
      cwd: tmp,
      ...(env ? { env } : {}),
      // critical: clearEnv so the parent's PWD does not leak through.
      clearEnv: true,
    });
    const { stdout, code } = await cmd.output();
    assertEquals(code, 0);
    const text = new TextDecoder().decode(stdout).trim();
    assertEquals(text, resolve(tmp));
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
