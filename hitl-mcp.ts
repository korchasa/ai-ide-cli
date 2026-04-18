/**
 * @module
 * Generic stdio MCP server exposing a single `request_human_input` tool.
 * Both the OpenCode and Codex HITL flows reuse this implementation — they
 * differ only in the server-name constant they advertise inside their
 * runtime's `mcp_servers` config.
 *
 * Transport: one JSON-RPC message per line over stdin/stdout (NDJSON
 * framing). This matches OpenCode's local-MCP transport and is also accepted
 * by the Codex CLI's MCP client.
 *
 * Why the tool returns immediately: the runtime adapter intercepts the
 * structured tool-call event in the runtime's stream, marks the node as
 * waiting for human input, and resumes the session later. The MCP tool only
 * needs to surface the typed request to the runtime.
 */

import type { HumanInputRequest } from "./types.ts";

/**
 * Schema of the `request_human_input` MCP tool exposed to the runtime.
 * Identical contract on both OpenCode and Codex.
 */
export const REQUEST_HUMAN_INPUT_TOOL: {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
} = {
  name: "request_human_input",
  description: "Ask a human a structured question and wait outside the model.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string" },
      header: { type: "string" },
      options: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            description: { type: "string" },
          },
          required: ["label"],
        },
      },
      multiSelect: { type: "boolean" },
    },
    required: ["question"],
  },
};

interface JsonRpcMessage {
  id?: number | string | null;
  method?: string;
  params?: {
    protocolVersion?: string;
    arguments?: Record<string, unknown>;
  };
}

/**
 * Run the stdio HITL MCP server until stdin closes.
 *
 * The server name advertised in `serverInfo.name` is purely cosmetic — the
 * runtime sees the server under whatever key the consumer registered in
 * its own `mcp_servers` config; the inner name is used only for diagnostics.
 */
export async function runHitlMcpServer(
  serverInfoName: string = "flowai-hitl",
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of Deno.stdin.readable) {
    buffer += decoder.decode(chunk, { stream: true });

    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;

      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;

      const message = JSON.parse(line) as JsonRpcMessage;
      await handleMessage(message, serverInfoName);
    }
  }

  const trailing = buffer.trim();
  if (trailing) {
    const message = JSON.parse(trailing) as JsonRpcMessage;
    await handleMessage(message, serverInfoName);
  }
}

async function handleMessage(
  message: JsonRpcMessage,
  serverInfoName: string,
): Promise<void> {
  if (message.method === "initialize") {
    await sendResponse(message.id ?? 0, {
      protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
      capabilities: {
        tools: {
          listChanged: false,
        },
      },
      serverInfo: {
        name: serverInfoName,
        version: "1",
      },
    });
    return;
  }

  if (message.method === "notifications/initialized") {
    return;
  }

  if (message.method === "tools/list") {
    await sendResponse(message.id ?? 0, {
      tools: [REQUEST_HUMAN_INPUT_TOOL],
    });
    return;
  }

  if (message.method === "tools/call") {
    const request = normalizeHumanInputRequest(message.params?.arguments ?? {});
    await sendResponse(message.id ?? 0, {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            question: request.question,
            header: request.header ?? "",
          }),
        },
      ],
    });
    return;
  }

  if (message.id !== undefined) {
    await sendResponse(message.id, {
      content: [
        {
          type: "text",
          text: `Unhandled method: ${message.method ?? "unknown"}`,
        },
      ],
    });
  }
}

/**
 * Normalize a raw `tools/call` arguments object into a {@link HumanInputRequest}.
 * Throws when the `question` field is missing or empty. Exported so runtime
 * adapters can reuse the same shape extraction when intercepting tool-use
 * events from their respective NDJSON streams.
 */
export function normalizeHumanInputRequest(
  input: Record<string, unknown>,
): HumanInputRequest {
  const question = String(input.question ?? "").trim();
  if (!question) {
    throw new Error("request_human_input requires a non-empty question");
  }

  const options = Array.isArray(input.options)
    ? input.options
      .filter((entry) => typeof entry === "object" && entry !== null)
      .map((entry) => {
        const record = entry as Record<string, unknown>;
        return {
          label: String(record.label ?? ""),
          description: typeof record.description === "string"
            ? record.description
            : undefined,
        };
      })
      .filter((entry) => entry.label)
    : undefined;

  return {
    question,
    header: typeof input.header === "string" ? input.header : undefined,
    options: options && options.length > 0 ? options : undefined,
    multiSelect: typeof input.multiSelect === "boolean"
      ? input.multiSelect
      : undefined,
  };
}

async function sendResponse(
  id: number | string | null,
  result: Record<string, unknown>,
): Promise<void> {
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id,
    result,
  });
  const data = new TextEncoder().encode(`${payload}\n`);
  await Deno.stdout.write(data);
}
