/**
 * @module
 * Minimal stdio MCP server exposing a single HITL tool for OpenCode.
 *
 * Why a separate stdio process: OpenCode can inject local MCP servers per
 * invocation via config. The engine uses this server to expose a structured
 * `request_human_input` tool without mutating the user's global OpenCode
 * configuration.
 *
 * Why the tool returns immediately: the engine intercepts the structured
 * `tool_use` event in OpenCode's JSON stream, marks the node as waiting, and
 * resumes the session later. The MCP tool only needs to surface a typed
 * request to the runtime.
 */

import type { HumanInputRequest } from "../types.ts";

/**
 * CLI flag consumers pass to their own binary to dispatch into
 * {@link runOpenCodeHitlMcpServer}. Single source of truth — both the
 * dispatcher and the spawn command builder must reference this constant
 * so the two sides of the sub-process handshake stay in sync.
 */
export const INTERNAL_OPENCODE_HITL_MCP_ARG: string =
  "--internal-opencode-hitl-mcp";

/** MCP server name advertised in OpenCode's `mcp` config block. */
export const OPENCODE_HITL_MCP_SERVER_NAME: string = "hitl";

/**
 * Fully-qualified name of the `request_human_input` tool as it appears
 * in OpenCode stream events (`<server>_request_human_input`). Used by
 * the OpenCode runner to pattern-match HITL tool invocations.
 */
export const OPENCODE_HITL_MCP_TOOL_NAME: string =
  `${OPENCODE_HITL_MCP_SERVER_NAME}_request_human_input`;

const REQUEST_HUMAN_INPUT_TOOL = {
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
} as const;

interface JsonRpcMessage {
  id?: number | string | null;
  method?: string;
  params?: {
    protocolVersion?: string;
    arguments?: Record<string, unknown>;
  };
}

/**
 * Start the OpenCode HITL MCP server using the local ndjson transport.
 *
 * Transport note: OpenCode 1.3.13 sends one JSON-RPC message per line over
 * stdin/stdout for local MCP servers (not Content-Length framing). The server
 * mirrors that format to stay compatible with the documented local MCP path.
 */
export async function runOpenCodeHitlMcpServer(): Promise<void> {
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
      await handleMessage(message);
    }
  }

  const trailing = buffer.trim();
  if (trailing) {
    const message = JSON.parse(trailing) as JsonRpcMessage;
    await handleMessage(message);
  }
}

async function handleMessage(message: JsonRpcMessage): Promise<void> {
  if (message.method === "initialize") {
    await sendResponse(message.id ?? 0, {
      protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
      capabilities: {
        tools: {
          listChanged: false,
        },
      },
      serverInfo: {
        name: "flowai-hitl",
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

function normalizeHumanInputRequest(
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
