import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  type AuthEnvMatcher,
  hostEnv,
  hostHome,
  spawnEnvOptions,
} from "./spawn-env.ts";

const NONE: AuthEnvMatcher = () => false;
const PROBE = "AI_IDE_CLI_SPAWN_ENV_PROBE";
const LOGIN = "AI_IDE_CLI_SPAWN_ENV_LOGIN";

/** Run `fn` with `vars` set in this process's env, restoring them after. */
function withParentEnv(vars: Record<string, string>, fn: () => void): void {
  const prev = Object.fromEntries(
    Object.keys(vars).map((k) => [k, Deno.env.get(k)]),
  );
  for (const [k, v] of Object.entries(vars)) Deno.env.set(k, v);
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

Deno.test("FR-L53 spawnEnvOptions default passes env through, no clearEnv", () => {
  assertEquals(spawnEnvOptions({ A: "1" }, undefined, NONE), {
    env: { A: "1" },
  });
  assertEquals(spawnEnvOptions({ A: "1" }, true, NONE), { env: { A: "1" } });
  assertEquals(spawnEnvOptions(undefined, undefined, NONE), {});
});

Deno.test("FR-L53 isolated env carries the parent's identity vars", () => {
  withParentEnv({ PATH: "/p", HOME: "/h", USER: "u", LOGNAME: "l" }, () => {
    assertEquals(spawnEnvOptions({ A: "1" }, false, NONE), {
      clearEnv: true,
      env: { PATH: "/p", HOME: "/h", USER: "u", LOGNAME: "l", A: "1" },
    });
  });
});

Deno.test("FR-L53 isolated env: caller values win over the parent's", () => {
  withParentEnv({ PATH: "/p", HOME: "/h", [LOGIN]: "parent" }, () => {
    const login: AuthEnvMatcher = (n) => n === LOGIN;
    const { env } = spawnEnvOptions(
      { HOME: "/caller", [LOGIN]: "caller" },
      false,
      login,
    );
    assertEquals(env?.HOME, "/caller");
    assertEquals(env?.[LOGIN], "caller");
    assertEquals(env?.PATH, "/p");
  });
});

Deno.test("FR-L53 isolated env carries login vars the matcher accepts, nothing else", () => {
  withParentEnv({ [LOGIN]: "token", [PROBE]: "leak" }, () => {
    const { env } = spawnEnvOptions({}, false, (n) => n === LOGIN);
    assertEquals(env?.[LOGIN], "token");
    assertEquals(env?.[PROBE], undefined);
  });
});

Deno.test("FR-L53 isolated env without any PATH throws", () => {
  const prev = Deno.env.get("PATH");
  Deno.env.delete("PATH");
  try {
    assertThrows(
      () => spawnEnvOptions({}, false, NONE),
      Error,
      "inheritEnv: false needs PATH",
    );
  } finally {
    if (prev !== undefined) Deno.env.set("PATH", prev);
  }
});

Deno.test("FR-L53 hostEnv isolated sees what the child sees", () => {
  withParentEnv({ [PROBE]: "parent", [LOGIN]: "parent", HOME: "/h" }, () => {
    const login: AuthEnvMatcher = (n) => n === LOGIN;
    assertEquals(hostEnv(PROBE, {}, false, login), undefined);
    assertEquals(hostEnv(PROBE, { [PROBE]: "child" }, false, login), "child");
    assertEquals(hostEnv(LOGIN, {}, false, login), "parent");
    assertEquals(hostEnv("HOME", {}, false, login), "/h");
    assertEquals(
      hostEnv(PROBE, { [PROBE]: "child" }, undefined, login),
      "parent",
    );
  });
});

Deno.test("FR-L53 hostHome isolated: caller HOME, else parent HOME", () => {
  withParentEnv({ HOME: "/parent" }, () => {
    assertEquals(hostHome({ HOME: "/iso" }, false, "x"), "/iso");
    assertEquals(hostHome({}, false, "x"), "/parent");
  });
});

Deno.test("FR-L53 hostHome isolated without any HOME fails naming the purpose", () => {
  const prev = Deno.env.get("HOME");
  Deno.env.delete("HOME");
  try {
    assertThrows(
      () => hostHome({}, false, "Codex sessions dir"),
      Error,
      "inheritEnv: false: Codex sessions dir needs HOME",
    );
  } finally {
    if (prev !== undefined) Deno.env.set("HOME", prev);
  }
});

Deno.test("FR-L53 helpers keep the default resolution for home-relative paths", () => {
  const home = Deno.env.get("HOME") ?? Deno.cwd();
  assertEquals(
    join(hostHome(undefined, undefined, "x"), ".x"),
    join(home, ".x"),
  );
});
