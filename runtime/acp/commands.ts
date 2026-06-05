/**
 * @module
 * FR-L42 ACP-side projection helpers for the commands fast-channel.
 *
 * Today this module exposes only the pure parser used by
 * {@link extractAcpContent}. The session-lifecycle helper
 * `fetchAcpCommands` (and the `adapter.fetchCommands` adapter wiring)
 * land in a follow-up slice — see
 * `documents/tasks/2026/06/acp-available-commands-discovery.md` commits
 * 4 + 5.
 *
 * Pure: no I/O, never throws, returns an empty list when the wire
 * payload is malformed.
 */

import type { Command } from "../commands.ts";

// FR-L42
/**
 * Project an ACP `available_commands_update` payload into the neutral
 * {@link Command} list.
 *
 * Schema (ACP v0.x — verified against the upstream JSON schema):
 *
 *   `{ availableCommands: Array<{ name, description, input?: { hint? } }> }`
 *
 * Defensive on every field: entries missing `name` / `description` or
 * whose `name`/`description` is not a string are silently skipped so
 * one bad entry does not poison the whole snapshot. `input` is kept
 * only when it is an object; a missing or empty `hint` collapses to
 * dropping the `input` field entirely (neutral shape's `input` is
 * meaningful only when it carries a hint).
 *
 * @param update The `update` field of one `session/update`
 *   notification whose `sessionUpdate === "available_commands_update"`.
 * @returns Ordered list of well-formed commands; empty when the
 *   payload is missing `availableCommands`, the field is not an array,
 *   or every entry is malformed.
 */
export function parseAvailableCommands(
  update: Record<string, unknown>,
): Command[] {
  const raw = update["availableCommands"];
  if (!Array.isArray(raw)) return [];
  const out: Command[] = [];
  for (const entry of raw) {
    if (!isObject(entry)) continue;
    const name = entry["name"];
    const description = entry["description"];
    if (typeof name !== "string" || typeof description !== "string") continue;
    const cmd: Command = { name, description };
    const input = entry["input"];
    if (isObject(input)) {
      const hint = input["hint"];
      if (typeof hint === "string") cmd.input = { hint };
    }
    out.push(cmd);
  }
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
