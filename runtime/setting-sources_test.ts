import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { prepareSettingSourcesDir } from "./setting-sources.ts";

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
