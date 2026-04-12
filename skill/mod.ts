/**
 * @module
 * Skill model for `@korchasa/ai-ide-cli` — typed representation of SKILL.md
 * files and a parser to load them from disk.
 *
 * Re-exported via the sub-path `@korchasa/ai-ide-cli/skill`.
 */

export type { SkillDef, SkillFrontmatter } from "./types.ts";
export { parseSkill } from "./parser.ts";
