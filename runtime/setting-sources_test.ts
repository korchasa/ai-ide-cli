import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  defaultClaudeConfigDir,
  prepareSettingSourcesDir,
  type SettingSource,
  validateSettingSources,
} from "./setting-sources.ts";

Deno.test("FR-L18 validateSettingSources accepts every known source, [] and undefined", () => {
  validateSettingSources(["user", "project", "local"]);
  validateSettingSources([]);
  validateSettingSources(undefined);
});

Deno.test("FR-L18 validateSettingSources rejects an unknown source", () => {
  assertThrows(
    () => validateSettingSources(["user", "User" as SettingSource]),
    Error,
    'unknown source "User"; valid: user, project, local',
  );
});

Deno.test("prepareSettingSourcesDir — ['user'] with existing settings.json symlinks it", async () => {
  const realConfigDir = await Deno.makeTempDir({ prefix: "claude-real-" });
  const realCwd = await Deno.makeTempDir({ prefix: "claude-cwd-" });
  try {
    await Deno.writeTextFile(
      join(realConfigDir, "settings.json"),
      JSON.stringify({ foo: 1 }),
    );
    const { tmpDir, cleanup } = await prepareSettingSourcesDir(
      ["user"],
      realConfigDir,
      realCwd,
    );
    const entries: string[] = [];
    for await (const entry of Deno.readDir(tmpDir)) entries.push(entry.name);
    assert(entries.includes("settings.json"));
    const content = await Deno.readTextFile(join(tmpDir, "settings.json"));
    assertEquals(JSON.parse(content).foo, 1);
    await cleanup();
  } finally {
    await Deno.remove(realConfigDir, { recursive: true });
    await Deno.remove(realCwd, { recursive: true });
  }
});

Deno.test("prepareSettingSourcesDir — ['project'] with no user settings.json leaves tmpDir empty", async () => {
  const realConfigDir = await Deno.makeTempDir({ prefix: "claude-real-" });
  const realCwd = await Deno.makeTempDir({ prefix: "claude-cwd-" });
  try {
    // No settings.json created.
    const { tmpDir, cleanup } = await prepareSettingSourcesDir(
      ["project"],
      realConfigDir,
      realCwd,
    );
    const entries: string[] = [];
    for await (const entry of Deno.readDir(tmpDir)) entries.push(entry.name);
    assertEquals(entries.length, 0);
    await cleanup();
  } finally {
    await Deno.remove(realConfigDir, { recursive: true });
    await Deno.remove(realCwd, { recursive: true });
  }
});

Deno.test("prepareSettingSourcesDir — [] yields an empty tmpDir", async () => {
  const realConfigDir = await Deno.makeTempDir({ prefix: "claude-real-" });
  const realCwd = await Deno.makeTempDir({ prefix: "claude-cwd-" });
  try {
    await Deno.writeTextFile(
      join(realConfigDir, "settings.json"),
      JSON.stringify({ foo: 1 }),
    );
    const { tmpDir, cleanup } = await prepareSettingSourcesDir(
      [],
      realConfigDir,
      realCwd,
    );
    const entries: string[] = [];
    for await (const entry of Deno.readDir(tmpDir)) entries.push(entry.name);
    assertEquals(entries.length, 0);
    await cleanup();
  } finally {
    await Deno.remove(realConfigDir, { recursive: true });
    await Deno.remove(realCwd, { recursive: true });
  }
});

Deno.test("prepareSettingSourcesDir — cleanup removes the tmpDir and is idempotent", async () => {
  const realConfigDir = await Deno.makeTempDir({ prefix: "claude-real-" });
  const realCwd = await Deno.makeTempDir({ prefix: "claude-cwd-" });
  try {
    const { tmpDir, cleanup } = await prepareSettingSourcesDir(
      ["user"],
      realConfigDir,
      realCwd,
    );
    await cleanup();
    let notFound = false;
    try {
      await Deno.stat(tmpDir);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) notFound = true;
    }
    assertEquals(notFound, true);
    // Second cleanup must not throw.
    await cleanup();
  } finally {
    await Deno.remove(realConfigDir, { recursive: true });
    await Deno.remove(realCwd, { recursive: true });
  }
});

Deno.test("prepareSettingSourcesDir — ['user'] with missing settings.json skips silently", async () => {
  const realConfigDir = await Deno.makeTempDir({ prefix: "claude-real-" });
  const realCwd = await Deno.makeTempDir({ prefix: "claude-cwd-" });
  try {
    const { tmpDir, cleanup } = await prepareSettingSourcesDir(
      ["user"],
      realConfigDir,
      realCwd,
    );
    const entries: string[] = [];
    for await (const entry of Deno.readDir(tmpDir)) entries.push(entry.name);
    assertEquals(entries.length, 0);
    await cleanup();
  } finally {
    await Deno.remove(realConfigDir, { recursive: true });
    await Deno.remove(realCwd, { recursive: true });
  }
});

Deno.test("defaultClaudeConfigDir (deprecated) isolated sees what the child sees", () => {
  const login = (n: string) => n === "CLAUDE_CONFIG_DIR";
  const prev = Deno.env.get("CLAUDE_CONFIG_DIR");
  Deno.env.set("CLAUDE_CONFIG_DIR", "/parent-cfg");
  try {
    // A carried login var reaches the child, so the lookup sees it.
    assertEquals(defaultClaudeConfigDir({}, false, login), "/parent-cfg");
    // The caller's value wins.
    assertEquals(
      defaultClaudeConfigDir({ CLAUDE_CONFIG_DIR: "/cfg" }, false, login),
      "/cfg",
    );
    // Not a login var for this matcher: the child does not get it.
    assertEquals(
      defaultClaudeConfigDir({ HOME: "/iso" }, false, () => false),
      "/iso/.claude",
    );
  } finally {
    if (prev === undefined) Deno.env.delete("CLAUDE_CONFIG_DIR");
    else Deno.env.set("CLAUDE_CONFIG_DIR", prev);
  }
});
