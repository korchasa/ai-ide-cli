import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { parseSkill } from "./parser.ts";

/** Create a temp skill directory with SKILL.md and optional extra files. */
async function createTempSkillDir(
  frontmatter: string,
  body: string,
  extraFiles?: Record<string, string>,
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "skill-test-" });
  const content = `---\n${frontmatter}\n---\n${body}`;
  await Deno.writeTextFile(join(dir, "SKILL.md"), content);
  if (extraFiles) {
    for (const [path, data] of Object.entries(extraFiles)) {
      const full = join(dir, path);
      const parent = full.replace(/\/[^/]+$/, "");
      await Deno.mkdir(parent, { recursive: true });
      await Deno.writeTextFile(full, data);
    }
  }
  return dir;
}

Deno.test("parseSkill: valid skill with all required fields", async () => {
  const dir = await createTempSkillDir(
    'name: test-skill\ndescription: "A test skill"',
    "# Hello\n\nBody content here.",
  );
  try {
    const skill = await parseSkill(dir);
    assertEquals(skill.frontmatter.name, "test-skill");
    assertEquals(skill.frontmatter.description, "A test skill");
    assertEquals(skill.body, "# Hello\n\nBody content here.");
    assertEquals(skill.rootPath, dir);
    assertEquals(skill.files, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("parseSkill: detects extra files", async () => {
  const dir = await createTempSkillDir(
    'name: with-files\ndescription: "Has files"',
    "body",
    {
      "helper.ts": "export const x = 1;",
      "lib/utils.ts": "export const y = 2;",
    },
  );
  try {
    const skill = await parseSkill(dir);
    assertEquals(skill.files, ["helper.ts", "lib/utils.ts"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("parseSkill: preserves unknown frontmatter fields", async () => {
  const dir = await createTempSkillDir(
    'name: ext\ndescription: "Ext"\ncustom-field: value123',
    "body",
  );
  try {
    const skill = await parseSkill(dir);
    assertEquals(skill.frontmatter["custom-field"], "value123");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("parseSkill: rich frontmatter with Claude Code fields", async () => {
  const dir = await createTempSkillDir(
    [
      "name: rich-skill",
      'description: "Rich"',
      'argument-hint: "[options]"',
      "disable-model-invocation: true",
      "user-invocable: true",
      'model: "opus"',
    ].join("\n"),
    "body",
  );
  try {
    const skill = await parseSkill(dir);
    assertEquals(skill.frontmatter["argument-hint"], "[options]");
    assertEquals(skill.frontmatter["disable-model-invocation"], true);
    assertEquals(skill.frontmatter["user-invocable"], true);
    assertEquals(skill.frontmatter.model, "opus");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("parseSkill: missing SKILL.md throws", async () => {
  const dir = await Deno.makeTempDir({ prefix: "skill-test-" });
  try {
    await assertRejects(
      () => parseSkill(dir),
      Error,
      "Missing SKILL.md",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("parseSkill: missing name field throws", async () => {
  const dir = await createTempSkillDir(
    'description: "No name"',
    "body",
  );
  try {
    await assertRejects(
      () => parseSkill(dir),
      Error,
      'Missing required field "name"',
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("parseSkill: missing description field throws", async () => {
  const dir = await createTempSkillDir(
    "name: no-desc",
    "body",
  );
  try {
    await assertRejects(
      () => parseSkill(dir),
      Error,
      'Missing required field "description"',
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("parseSkill: no frontmatter throws", async () => {
  const dir = await Deno.makeTempDir({ prefix: "skill-test-" });
  await Deno.writeTextFile(join(dir, "SKILL.md"), "# Just markdown\nNo front.");
  try {
    await assertRejects(
      () => parseSkill(dir),
      Error,
      "No YAML frontmatter",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("parseSkill: unterminated frontmatter throws", async () => {
  const dir = await Deno.makeTempDir({ prefix: "skill-test-" });
  await Deno.writeTextFile(join(dir, "SKILL.md"), "---\nname: broken\n# oops");
  try {
    await assertRejects(
      () => parseSkill(dir),
      Error,
      "Unterminated YAML frontmatter",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
