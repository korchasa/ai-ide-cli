/**
 * @module
 * Typed representation of a parsed SKILL.md file. Frontmatter is a union
 * of known fields across all supported IDEs (Claude Code, OpenCode, Cursor).
 *
 * Runtime-specific validation (e.g., OpenCode name regex
 * `^[a-z0-9]+(-[a-z0-9]+)*$`) happens in the adapter, not here.
 */

/** Union of all known frontmatter fields across IDEs. */
export interface SkillFrontmatter {
  // --- Required (all IDEs) ---
  /** Skill name used for discovery and invocation. */
  name: string;
  /** Human-readable description shown in skill listings. */
  description: string;

  // --- Claude Code / Cursor ---
  /** Hint text shown next to the skill name in slash-command UI. */
  "argument-hint"?: string;
  /** Natural-language guidance for when the AI should invoke this skill. */
  "when_to_use"?: string;
  /** Comma-separated list of allowed tool names for this skill. */
  "allowed-tools"?: string;
  /** Model override: "sonnet" | "opus" | "haiku" | "inherit". */
  model?: string;
  /** Reasoning effort: "low" | "medium" | "high" | "max" or a number. */
  effort?: string;
  /** Execution context: "inline" | "fork". */
  context?: string;
  /** Agent name to delegate execution to. */
  agent?: string;
  /** Conditional activation paths (gitignore-style globs). */
  paths?: string[];
  /** Event hooks configuration. */
  hooks?: unknown;
  /** Shell type: "bash" | "powershell". */
  shell?: string;
  /** Skill type: "user" | "feedback" | "project" | "reference". */
  type?: string;
  /** Whether to disable model invocation for this skill. */
  "disable-model-invocation"?: boolean;
  /** Whether this skill is user-invocable (shows in slash commands). */
  "user-invocable"?: boolean;
  /** Whether to hide from the slash command tool listing. */
  "hide-from-slash-command-tool"?: boolean;
  /** Skill format version. */
  version?: string;

  // --- OpenCode ---
  /** License identifier (SPDX). */
  license?: string;
  /** Compatibility constraint string. */
  compatibility?: string;
  /** Arbitrary key-value metadata. */
  metadata?: Record<string, unknown>;

  // --- Extensible ---
  /** Unknown fields are preserved verbatim for forward compatibility. */
  [key: string]: unknown;
}

/**
 * Parsed representation of a skill directory: SKILL.md frontmatter + body,
 * plus metadata about the directory's location and additional files.
 */
export interface SkillDef {
  /** Parsed YAML frontmatter from SKILL.md. */
  frontmatter: SkillFrontmatter;
  /** Markdown content after the frontmatter delimiter. */
  body: string;
  /** Absolute path to the skill directory. */
  rootPath: string;
  /** Relative paths to all files in the skill directory (excludes SKILL.md). */
  files: string[];
}
