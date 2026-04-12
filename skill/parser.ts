/**
 * @module
 * Parses a SKILL.md file from a skill directory into a typed {@link SkillDef}.
 * Extracts YAML frontmatter, validates required fields, scans the directory
 * for additional files.
 */

import { parse as parseYaml } from "@std/yaml";
import { join, relative } from "@std/path";
import type { SkillDef, SkillFrontmatter } from "./types.ts";

/** Sentinel filename expected in every skill directory. */
const SKILL_FILE = "SKILL.md";

/**
 * Parse a skill directory into a {@link SkillDef}.
 *
 * Reads `SKILL.md` from `skillDir`, extracts YAML frontmatter (delimited by
 * `---`), scans the directory recursively for additional files (excluding
 * SKILL.md itself), and returns the typed result.
 *
 * @param skillDir Absolute path to the skill directory.
 * @throws {Error} If SKILL.md is missing, frontmatter is invalid YAML,
 *   or required fields (`name`, `description`) are absent.
 */
export async function parseSkill(skillDir: string): Promise<SkillDef> {
  const skillPath = join(skillDir, SKILL_FILE);

  let raw: string;
  try {
    raw = await Deno.readTextFile(skillPath);
  } catch {
    throw new Error(`Missing ${SKILL_FILE} in ${skillDir}`);
  }

  const { frontmatter, body } = extractFrontmatter(raw, skillPath);

  if (typeof frontmatter.name !== "string" || frontmatter.name.length === 0) {
    throw new Error(
      `Missing required field "name" in frontmatter of ${skillPath}`,
    );
  }
  if (
    typeof frontmatter.description !== "string" ||
    frontmatter.description.length === 0
  ) {
    throw new Error(
      `Missing required field "description" in frontmatter of ${skillPath}`,
    );
  }

  const files = await scanFiles(skillDir);

  return {
    frontmatter,
    body,
    rootPath: skillDir,
    files,
  };
}

/**
 * Extract YAML frontmatter and markdown body from raw SKILL.md content.
 * Frontmatter is delimited by `---` at the start of the file.
 */
function extractFrontmatter(
  raw: string,
  sourcePath: string,
): { frontmatter: SkillFrontmatter; body: string } {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("---")) {
    throw new Error(`No YAML frontmatter found in ${sourcePath}`);
  }

  const endIdx = trimmed.indexOf("\n---", 3);
  if (endIdx === -1) {
    throw new Error(`Unterminated YAML frontmatter in ${sourcePath}`);
  }

  const yamlBlock = trimmed.substring(3, endIdx).trim();
  const body = trimmed.substring(endIdx + 4).trimStart();

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlBlock);
  } catch (err) {
    throw new Error(
      `Invalid YAML frontmatter in ${sourcePath}: ${(err as Error).message}`,
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Frontmatter must be a YAML mapping in ${sourcePath}`,
    );
  }

  return { frontmatter: parsed as SkillFrontmatter, body };
}

/**
 * Recursively scan `dir` for files, returning relative paths. Excludes
 * SKILL.md itself. Sorted for deterministic output.
 */
async function scanFiles(dir: string): Promise<string[]> {
  const result: string[] = [];

  async function walk(current: string): Promise<void> {
    for await (const entry of Deno.readDir(current)) {
      const full = join(current, entry.name);
      if (entry.isDirectory) {
        await walk(full);
      } else if (entry.isFile) {
        const rel = relative(dir, full);
        if (rel !== SKILL_FILE) {
          result.push(rel);
        }
      }
    }
  }

  await walk(dir);
  return result.sort();
}
