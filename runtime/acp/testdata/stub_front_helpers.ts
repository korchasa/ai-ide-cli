/**
 * @module
 * Test helpers around `stub_front.ts` (FR-L55..FR-L58). Not published.
 */

import type { RuntimeSession } from "../../types.ts";
import type { AcpFrontLauncher } from "../fronts.ts";

/** The scriptable stub front, launched under this Deno CLI. */
export const STUB_FRONT: AcpFrontLauncher = {
  cmd: Deno.execPath(),
  args: [
    "run",
    "-A",
    new URL("./stub_front.ts", import.meta.url).pathname,
  ],
  pilot: true,
};

/** Send one prompt and return the reply text the turn streamed. */
export async function ask(
  session: RuntimeSession,
  text: string,
): Promise<string> {
  const sent = session.send(text);
  let reply = "";
  // `next()` by hand: leaving a `for await` closes the session's stream.
  while (true) {
    const { value: ev, done } = await session.events.next();
    if (done || ev.type === "turn-end") break;
    const update = ev.raw["update"] as Record<string, unknown> | undefined;
    if (update?.["sessionUpdate"] === "agent_message_chunk") {
      reply += (update["content"] as { text: string }).text;
    }
  }
  await sent;
  return reply;
}
