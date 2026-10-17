import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { hostEnv, hostHome, spawnEnvOptions } from "./spawn-env.ts";

Deno.test("FR-L53 spawnEnvOptions default passes env through, no clearEnv", () => {
  assertEquals(spawnEnvOptions({ A: "1" }, undefined), { env: { A: "1" } });
  assertEquals(spawnEnvOptions({ A: "1" }, true), { env: { A: "1" } });
  assertEquals(spawnEnvOptions(undefined, undefined), {});
});

Deno.test("FR-L53 spawnEnvOptions isolated clears the parent env", () => {
  assertEquals(spawnEnvOptions({ PATH: "/bin", A: "1" }, false), {
    clearEnv: true,
    env: { PATH: "/bin", A: "1" },
  });
});

Deno.test("FR-L53 spawnEnvOptions isolated refuses an env without PATH", () => {
  // Deno resolves the binary through the parent PATH when the child env
  // has none, so the caller's env would still pick the binary.
  assertThrows(
    () => spawnEnvOptions({ HOME: "/h" }, false),
    Error,
    "inheritEnv: false needs PATH in env",
  );
  assertThrows(
    () => spawnEnvOptions(undefined, false),
    Error,
    "inheritEnv: false needs PATH in env",
  );
});

Deno.test("FR-L53 hostEnv isolated reads only the passed env", () => {
  const name = "AI_IDE_CLI_SPAWN_ENV_PROBE";
  Deno.env.set(name, "parent");
  try {
    assertEquals(hostEnv(name, {}, false), undefined);
    assertEquals(hostEnv(name, { [name]: "child" }, false), "child");
    assertEquals(hostEnv(name, { [name]: "child" }, undefined), "parent");
  } finally {
    Deno.env.delete(name);
  }
});

Deno.test("FR-L53 hostHome isolated uses env.HOME or fails naming the purpose", () => {
  assertEquals(hostHome({ HOME: "/iso" }, false, "x"), "/iso");
  assertThrows(
    () => hostHome({}, false, "Codex sessions dir"),
    Error,
    "inheritEnv: false: Codex sessions dir needs HOME",
  );
  assertEquals(
    hostHome({ HOME: "/iso" }, undefined, "x"),
    Deno.env.get("HOME") ?? Deno.cwd(),
  );
});

Deno.test("FR-L53 helpers keep the default resolution for home-relative paths", () => {
  const home = Deno.env.get("HOME") ?? Deno.cwd();
  assertEquals(
    join(hostHome(undefined, undefined, "x"), ".x"),
    join(home, ".x"),
  );
});
