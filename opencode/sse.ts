/**
 * @module
 * SSE-frame parsing helpers for the OpenCode server's `/event` stream.
 *
 * Split out of `opencode/session.ts` so the runtime-neutral parsing surface
 * has its own home (focused unit tests, no subprocess wiring). The parent
 * module re-exports {@link parseOpenCodeSseFrame} and
 * {@link extractOpenCodeSessionId} for back-compat.
 */

/** Parsed SSE event from the OpenCode server's `/event` endpoint. */
export interface OpenCodeSessionEvent {
  /** Native event discriminator (e.g. `"message.part.delta"`, `"session.idle"`). */
  type: string;
  /** Event `properties` object from the raw payload (may be absent). */
  properties?: Record<string, unknown>;
  /** Raw event object as parsed from the SSE `data:` line. */
  raw: Record<string, unknown>;
  /**
   * `true` when the OpenCode session dispatcher injected this event rather
   * than receiving it from the SSE stream. Currently used to emit an
   * edge-triggered turn-end marker (`type: "turn-end"`) on busy → idle
   * transitions so the runtime-neutral layer can forward one and only one
   * {@link import("../runtime/types.ts").SYNTHETIC_TURN_END} per turn
   * regardless of whether the upstream server emitted `session.idle` or
   * `session.status { status: { type: "idle" } }` (or both).
   */
  synthetic?: true;
}

/**
 * Extract the session ID from a parsed OpenCode SSE event. Looks in the
 * top-level `properties.sessionID`, then nested `properties.part.sessionID`
 * and `properties.info.sessionID` where the server places it for
 * `message.part.*` / `message.updated` variants.
 *
 * Exported for unit testing.
 */
export function extractOpenCodeSessionId(
  event: OpenCodeSessionEvent,
): string | undefined {
  const s = event.properties?.sessionID;
  if (typeof s === "string") return s;
  const part = event.properties?.part;
  if (part && typeof part === "object" && "sessionID" in part) {
    const ps = (part as Record<string, unknown>).sessionID;
    if (typeof ps === "string") return ps;
  }
  const info = event.properties?.info;
  if (info && typeof info === "object" && "sessionID" in info) {
    const is = (info as Record<string, unknown>).sessionID;
    if (typeof is === "string") return is;
  }
  return undefined;
}

/**
 * Parse one SSE frame (the text between two `\n\n` separators) into an
 * {@link OpenCodeSessionEvent}. Returns `undefined` for comment-only frames,
 * frames without a `data:` line, or frames whose `data:` payload fails to
 * `JSON.parse`.
 *
 * Exported for unit testing.
 */
export function parseOpenCodeSseFrame(
  frame: string,
): OpenCodeSessionEvent | undefined {
  const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
  if (!dataLine) return undefined;
  const json = dataLine.slice(5).trim();
  if (!json) return undefined;
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    const typeField = typeof raw.type === "string" ? raw.type : "unknown";
    const propsField = raw.properties && typeof raw.properties === "object"
      ? raw.properties as Record<string, unknown>
      : undefined;
    return { type: typeField, properties: propsField, raw };
  } catch {
    return undefined;
  }
}

/**
 * Pick a free TCP port by binding to port 0 and immediately closing the
 * listener. Yields once after close so the kernel marks the port reusable
 * before the subprocess binds it.
 */
export async function pickFreePort(hostname: string): Promise<number> {
  const listener = Deno.listen({ port: 0, transport: "tcp", hostname });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  await Promise.resolve();
  return port;
}

/** Concatenate captured byte chunks into a trimmed UTF-8 string. */
export function decodeConcat(chunks: Uint8Array[]): string {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(buf).trim();
}
