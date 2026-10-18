/**
 * @module
 * Scriptable ACP front for unit tests (FR-L55..FR-L58). Speaks
 * newline-delimited JSON-RPC 2.0 on stdio, keeps several sessions, and
 * turns each prompt's text into one action, so a test drives the
 * agent → client direction (permission, fs) without a real IDE:
 *
 * - `PERMIT` — sends `session/request_permission`, replies with the answer.
 * - `READ <path>` / `WRITE <path> <text>` — sends `fs/read_text_file` /
 *   `fs/write_text_file`, replies with the result or the error.
 * - `META` — replies with the `_meta` its `session/new` carried.
 * - `INIT` — replies with the `clientCapabilities` of `initialize`.
 * - `PID` — replies with this process's pid.
 * - `ENV <name>` — replies with that variable of its own env, or `<unset>`.
 * - `OPEN` — replies with how many sessions are open (`session/close`
 *   removes one).
 * - `BURST <n>` — streams n one-character chunks, then ends the turn.
 * - `DIE` — exits mid-turn, without answering the prompt.
 * - anything else — replies `echo:<sessionId>:<text>`.
 *
 * Every `session/update` carries the session id, as the protocol says.
 * Not published (`deno.json` `publish.exclude`).
 */

type Json = Record<string, unknown>;

const encoder = new TextEncoder();
const write = (msg: Json) =>
  Deno.stdout.write(encoder.encode(JSON.stringify(msg) + "\n"));

const sessions = new Map<string, { meta: unknown }>();
let initParams: Json = {};
let nextOutboundId = 1000;
const pending = new Map<number, (msg: Json) => void>();

function request(method: string, params: Json): Promise<Json> {
  const id = nextOutboundId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    void write({ jsonrpc: "2.0", id, method, params });
  });
}

function reply(sessionId: string, text: string): Promise<number> {
  return write({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  });
}

async function prompt(id: number, params: Json): Promise<void> {
  const sessionId = String(params.sessionId);
  const blocks = params.prompt as Array<{ text?: string }>;
  const text = blocks.map((b) => b.text ?? "").join("");
  const [verb, arg, ...rest] = text.split(" ");
  if (verb === "PERMIT") {
    const res = await request("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: "tc-1", title: "Write" },
      options: [
        { optionId: "allow-1", kind: "allow_once", name: "Allow" },
        { optionId: "reject-1", kind: "reject_once", name: "Reject" },
      ],
    });
    await reply(sessionId, JSON.stringify(res.result ?? res.error));
  } else if (verb === "READ") {
    const res = await request("fs/read_text_file", { sessionId, path: arg });
    await reply(sessionId, JSON.stringify(res.result ?? res.error));
  } else if (verb === "WRITE") {
    const res = await request("fs/write_text_file", {
      sessionId,
      path: arg,
      content: rest.join(" "),
    });
    await reply(sessionId, JSON.stringify(res.result ?? res.error));
  } else if (verb === "DIE") {
    Deno.exit(1);
  } else if (verb === "BURST") {
    for (let i = 0; i < Number(arg); i++) await reply(sessionId, ".");
  } else if (verb === "META") {
    await reply(
      sessionId,
      JSON.stringify(sessions.get(sessionId)?.meta ?? null),
    );
  } else if (verb === "INIT") {
    await reply(sessionId, JSON.stringify(initParams.clientCapabilities));
  } else if (verb === "OPEN") {
    await reply(sessionId, String(sessions.size));
  } else if (verb === "ENV") {
    await reply(sessionId, Deno.env.get(arg) ?? "<unset>");
  } else if (verb === "PID") {
    await reply(sessionId, String(Deno.pid));
  } else {
    await reply(sessionId, `echo:${sessionId}:${text}`);
  }
  await write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
}

function handle(msg: Json): void {
  if (msg.method === undefined) {
    pending.get(msg.id as number)?.(msg);
    pending.delete(msg.id as number);
    return;
  }
  const id = msg.id as number;
  const params = (msg.params ?? {}) as Json;
  switch (msg.method) {
    case "initialize":
      initParams = params;
      void write({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { close: {} } },
        },
      });
      return;
    case "session/new": {
      const sessionId = `sess-${sessions.size + 1}`;
      sessions.set(sessionId, { meta: params._meta });
      void write({ jsonrpc: "2.0", id, result: { sessionId } });
      return;
    }
    case "session/close":
      sessions.delete(String(params.sessionId));
      void write({ jsonrpc: "2.0", id, result: {} });
      return;
    case "session/prompt":
      void prompt(id, params);
      return;
    default:
      if (id !== undefined) void write({ jsonrpc: "2.0", id, result: null });
  }
}

const decoder = new TextDecoder();
let buf = "";
for await (const chunk of Deno.stdin.readable) {
  buf += decoder.decode(chunk, { stream: true });
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handle(JSON.parse(line));
  }
}
