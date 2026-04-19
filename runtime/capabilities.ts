/**
 * @module
 * Capability inventory: runtime-neutral types and a shared response parser
 * for {@link RuntimeAdapter.fetchCapabilitiesSlow}.
 *
 * The inventory method sends a fixed LLM prompt to an IDE CLI asking the
 * agent to enumerate every skill and slash command it currently has access
 * to, then parses the JSON reply. It is intentionally expensive (one full
 * LLM turn per call) — hence the `Slow` suffix on the adapter method. See
 * {@link CAPABILITY_INVENTORY_PROMPT} for the exact wording sent to the
 * agent and {@link CAPABILITY_INVENTORY_SCHEMA} for the JSON Schema used by
 * runtimes that support structured-output constraints (Claude, Codex).
 */

import type { RuntimeId } from "../types.ts";
import type { ExtraArgsMap, RuntimeInvokeResult } from "./types.ts";

/** One entry in a capability inventory: skill or slash command. */
export interface CapabilityRef {
  /** Exact invocation name as the agent would type it (without leading `/`). */
  name: string;
  /**
   * Plugin source identifier when the entry comes from a plugin
   * (e.g. `"foxcode@korchasa"`). Omitted for user/project/builtin entries.
   */
  plugin?: string;
}

/**
 * Snapshot of skills and slash commands available to an IDE in a given
 * working directory. Produced by
 * {@link RuntimeAdapter.fetchCapabilitiesSlow}. Skills and commands are kept
 * as separate arrays even when a runtime (e.g. Claude) conceptually
 * conflates them — callers decide how to render each category.
 */
export interface CapabilityInventory {
  /** Runtime that produced the inventory. */
  runtime: RuntimeId;
  /** Skill entries reported by the agent. */
  skills: CapabilityRef[];
  /** Slash-command entries reported by the agent. */
  commands: CapabilityRef[];
}

/** Options for {@link RuntimeAdapter.fetchCapabilitiesSlow}. */
export interface FetchCapabilitiesOptions {
  /** Working directory in which to run the IDE CLI. */
  cwd?: string;
  /** External cancellation signal. */
  signal?: AbortSignal;
  /** Max seconds before the IDE subprocess is terminated. Default: 120. */
  timeoutSeconds?: number;
  /** Extra environment variables merged into the subprocess env. */
  env?: Record<string, string>;
  /** Model override (runtime-specific identifier). */
  model?: string;
}

/** System prompt sent alongside the inventory request. */
export const CAPABILITY_INVENTORY_SYSTEM_PROMPT: string =
  "You are in capability-inventory mode. Your ONLY task is to emit a JSON " +
  "listing of every skill and slash command available to you right now. " +
  "Do NOT execute any tools. Do NOT explain. Your entire response MUST be a " +
  "single minified JSON object with no prose and no code fences.";

/** User prompt asking the agent to enumerate its skills and commands. */
export const CAPABILITY_INVENTORY_PROMPT: string =
  'Return a JSON object: {"skills":[{"name":"<name>","plugin":"<src>?"}],' +
  '"commands":[{"name":"<name>","plugin":"<src>?"}]}. Include every skill ' +
  "and slash command you currently see in the current working directory — " +
  "user-level, project-level, and plugin-provided. Omit the `plugin` key " +
  "when the entry is not from a plugin. Do NOT invent entries. Do NOT call " +
  "tools. Respond with the JSON only.";

/**
 * JSON Schema describing the expected response shape. Emitted inline by
 * Claude via `--json-schema` and written to a temp file for Codex via
 * `--output-schema`. OpenCode and Cursor have no schema flag and rely on
 * the prompt alone.
 */
export const CAPABILITY_INVENTORY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["skills", "commands"],
  properties: {
    skills: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: {
          name: { type: "string" },
          plugin: { type: "string" },
        },
      },
    },
    commands: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: {
          name: { type: "string" },
          plugin: { type: "string" },
        },
      },
    },
  },
};

/**
 * Parse an agent's text reply into a {@link CapabilityInventory}.
 *
 * Tolerant of three response shapes:
 * 1. Pure minified JSON (expected when a schema flag enforced it).
 * 2. JSON wrapped in a ```` ```json ... ``` ```` markdown fence.
 * 3. JSON embedded in prose — extracts the first balanced `{ ... }` block.
 *
 * Throws when none of those succeed, or when the parsed value is not an
 * object with the required shape. Error messages include a truncated raw
 * response for diagnostics.
 */
export function parseCapabilityInventoryResponse(
  text: string,
  runtime: RuntimeId,
): CapabilityInventory {
  const trimmed = text.trim();
  const parsed = tryParseJson(trimmed);

  if (parsed === undefined) {
    throw new Error(
      `fetchCapabilitiesSlow: could not parse JSON from ${runtime} response. ` +
        `Raw (truncated): ${trimmed.slice(0, 500)}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `fetchCapabilitiesSlow: ${runtime} response is not a JSON object. ` +
        `Got: ${JSON.stringify(parsed).slice(0, 500)}`,
    );
  }

  const obj = parsed as { skills?: unknown; commands?: unknown };
  return {
    runtime,
    skills: normalizeEntries(obj.skills),
    commands: normalizeEntries(obj.commands),
  };
}

/** Coerce a raw array-ish value into validated {@link CapabilityRef} entries. */
function normalizeEntries(raw: unknown): CapabilityRef[] {
  if (!Array.isArray(raw)) return [];
  const out: CapabilityRef[] = [];
  for (const entry of raw) {
    const ref = normalizeEntry(entry);
    if (ref !== null) out.push(ref);
  }
  return out;
}

function normalizeEntry(entry: unknown): CapabilityRef | null {
  if (typeof entry === "string" && entry.length > 0) {
    return { name: entry };
  }
  if (typeof entry !== "object" || entry === null) return null;
  const rec = entry as Record<string, unknown>;
  if (typeof rec.name !== "string" || rec.name.length === 0) return null;
  const ref: CapabilityRef = { name: rec.name };
  if (typeof rec.plugin === "string" && rec.plugin.length > 0) {
    ref.plugin = rec.plugin;
  }
  return ref;
}

/**
 * Adapter-shared driver for {@link RuntimeAdapter.fetchCapabilitiesSlow}.
 *
 * Dispatches a single-turn invocation with the shared system/task prompt
 * and the runtime-specific `extraArgs` (for example `--json-schema` on
 * Claude or `--output-schema <file>` on Codex). Parses the returned
 * `CliRunOutput.result` into a {@link CapabilityInventory}. The caller owns
 * any temporary files it passed through `extraArgs`.
 */
export async function fetchInventoryViaInvoke(
  runtime: RuntimeId,
  invoke: (opts: {
    systemPrompt?: string;
    taskPrompt: string;
    extraArgs?: ExtraArgsMap;
    timeoutSeconds: number;
    maxRetries: number;
    retryDelaySeconds: number;
    signal?: AbortSignal;
    cwd?: string;
    env?: Record<string, string>;
    model?: string;
  }) => Promise<RuntimeInvokeResult>,
  opts: FetchCapabilitiesOptions | undefined,
  extraArgs?: ExtraArgsMap,
): Promise<CapabilityInventory> {
  const result = await invoke({
    systemPrompt: CAPABILITY_INVENTORY_SYSTEM_PROMPT,
    taskPrompt: CAPABILITY_INVENTORY_PROMPT,
    extraArgs,
    timeoutSeconds: opts?.timeoutSeconds ?? 120,
    maxRetries: 0,
    retryDelaySeconds: 0,
    signal: opts?.signal,
    cwd: opts?.cwd,
    env: opts?.env,
    model: opts?.model,
  });

  if (result.error) {
    throw new Error(`fetchCapabilitiesSlow (${runtime}): ${result.error}`);
  }
  if (!result.output) {
    throw new Error(
      `fetchCapabilitiesSlow (${runtime}): invocation produced no output`,
    );
  }
  return parseCapabilityInventoryResponse(result.output.result, runtime);
}

/** Best-effort JSON extraction; returns `undefined` on total failure. */
function tryParseJson(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // fall through
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // fall through
    }
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch {
      // fall through
    }
  }

  return undefined;
}
