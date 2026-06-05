/**
 * @module
 * FR-L42 ACP-side commands fast-channel.
 *
 * Two surfaces:
 * - {@link parseAvailableCommands} — pure projector consumed by
 *   {@link extractAcpContent} (never throws; `[]` on malformed input).
 * - {@link fetchAcpCommands} — session-lifecycle helper that spawns the
 *   ACP front, runs a minimal handshake, awaits the first
 *   `available_commands_update` push (bounded by a timeout + the
 *   caller's signal), disposes the front, and returns the snapshot.
 *
 * Reuses `spawnClient` + `handshake` from `./handshake.ts` (no parallel
 * spawn path) so abort / process-registry handling cannot drift from
 * the invoke/session adapter.
 */

import type { RuntimeId } from "../../types.ts";
import type {
  Command,
  CommandsSnapshot,
  FetchCommandsOptions,
} from "../commands.ts";
import { CommandsUnavailableError } from "../commands.ts";
import { defaultRegistry } from "../../process-registry.ts";
import type { AcpStdioClient } from "./client.ts";
import { getAcpFront } from "./fronts.ts";
import { handshake, spawnClient } from "./handshake.ts";

/** Default ceiling on the wait for the first `available_commands_update`. */
const DEFAULT_TIMEOUT_MS = 10_000;

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

// FR-L42
/**
 * Open a short-lived ACP session and capture the first
 * `available_commands_update` push as a runtime-neutral
 * {@link CommandsSnapshot}.
 *
 * Flow: `front_not_piloted` guard (synchronous, before spawn) →
 * `spawnClient` → minimal `handshake` (`skipModeAndConfig: true` —
 * a one-shot capture needs neither a mode nor config RPC) → wait for
 * the first `available_commands_update` notification (bounded by
 * `opts.timeoutMs` and `opts.signal`) → dispose the front.
 *
 * Error surfaces (all typed {@link CommandsUnavailableError}):
 * - `front_not_piloted` — non-piloted runtime without an `acpFront`
 *   override (thrown before any subprocess spawn).
 * - `timeout` — neither the notification nor the stream close arrived
 *   before the ceiling, or the caller's `signal` aborted first.
 *
 * The helper does NOT inject a `session/prompt`; a front that only
 * pushes commands after the first prompt times out (adding an
 * auto-prompt opt is a documented follow-up).
 *
 * @param runtime Pilot runtime selector.
 * @param opts Fast-channel options (transport, registry, front
 *   override, cwd/env, timeout, signal).
 */
export async function fetchAcpCommands(
  runtime: RuntimeId,
  opts: FetchCommandsOptions,
): Promise<CommandsSnapshot> {
  // Synchronous pilot guard — refuse a non-piloted front before we
  // spend a spawn, unless the caller explicitly supplied an override.
  const front = opts.acpFront ?? getAcpFront(runtime);
  if (!opts.acpFront && !front.pilot) {
    throw new CommandsUnavailableError(runtime, "acp", "front_not_piloted");
  }
  if (opts.signal?.aborted) {
    throw new CommandsUnavailableError(runtime, "acp", "timeout", {
      cause: opts.signal.reason,
    });
  }

  const registry = opts.processRegistry ?? defaultRegistry;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const client = spawnClient({
    runtime,
    cwd: opts.cwd,
    env: opts.env,
    processRegistry: registry,
    acpFront: opts.acpFront,
  });

  // Tear the front down on abort BEFORE the wait phase too — otherwise an
  // abort during a hung `handshake` (front accepted the connection but
  // never answered) would leak the subprocess and hang the caller.
  // Mirrors `invokeViaAcp`, which hooks the signal to dispose pre-handshake.
  const onAbortDispose = () => void client.dispose();
  opts.signal?.addEventListener("abort", onAbortDispose, { once: true });
  try {
    const { sessionId } = await handshake(client, runtime, opts, {
      skipModeAndConfig: true,
    });
    const commands = await awaitFirstCommands(
      client,
      runtime,
      timeoutMs,
      opts.signal,
    );
    return { runtime, sessionId, commands };
  } catch (err) {
    if (err instanceof CommandsUnavailableError) throw err;
    // Abort that landed during `handshake` surfaces as a raw "front
    // exited" rejection (dispose killed the pending RPC); normalise it to
    // the typed timeout so callers see one error class regardless of when
    // the abort fired.
    if (opts.signal?.aborted) {
      throw new CommandsUnavailableError(runtime, "acp", "timeout", {
        cause: err,
      });
    }
    throw err;
  } finally {
    opts.signal?.removeEventListener("abort", onAbortDispose);
    await client.dispose();
  }
}

/**
 * Resolve with the projected {@link Command} list from the first
 * `available_commands_update` notification, or reject with a typed
 * timeout error when the ceiling / abort fires first or the
 * notification stream closes without the variant.
 */
function awaitFirstCommands(
  client: AcpStdioClient,
  runtime: RuntimeId,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Command[]> {
  return new Promise<Command[]>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timerId);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (cause?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new CommandsUnavailableError(runtime, "acp", "timeout", { cause }),
      );
    };
    const succeed = (commands: Command[]) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(commands);
    };
    const onAbort = () => fail(signal?.reason);

    const timerId = setTimeout(
      () => fail(new Error(`waited ${timeoutMs}ms`)),
      timeoutMs,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    // The signal may already be aborted — e.g. the caller aborted while
    // the preceding `handshake` was still in flight, so this executor
    // runs post-abort. `addEventListener("abort")` never fires for an
    // already-aborted signal, so check eagerly (this `fail` clears the
    // timer + listener just armed above).
    if (signal?.aborted) {
      fail(signal.reason);
      return;
    }

    (async () => {
      try {
        for await (const note of client.notifications()) {
          if (settled) return;
          if (note.method !== "session/update") continue;
          const params = note.params ?? {};
          const update = isObject(params["update"]) ? params["update"] : params;
          if (update["sessionUpdate"] === "available_commands_update") {
            succeed(parseAvailableCommands(update));
            return;
          }
        }
        // Stream closed before the variant arrived.
        fail(new Error("notification stream closed before commands push"));
      } catch (err) {
        fail(err);
      }
    })();
  });
}
