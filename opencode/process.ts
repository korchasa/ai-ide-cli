/**
 * @module
 * OpenCode runtime adapter: builds CLI arguments, spawns the opencode process,
 * parses JSON event stream, extracts normalized output, and handles HITL
 * interception for the OpenCode runtime.
 * Entry point: {@link invokeOpenCodeCli}.
 */

import type { CliRunOutput, Verbosity } from "../types.ts";
import type {
  HitlConfig,
  HumanInputOption,
  HumanInputRequest,
} from "../types.ts";
import {
  OPENCODE_HITL_MCP_SERVER_NAME,
  OPENCODE_HITL_MCP_TOOL_NAME,
} from "./hitl-mcp.ts";
import { register, unregister } from "../process-registry.ts";
import type {
  RuntimeInvokeOptions,
  RuntimeInvokeResult,
} from "../runtime/types.ts";

/** Build CLI arguments for the opencode command. Exported for testing. */
export function buildOpenCodeArgs(opts: RuntimeInvokeOptions): string[] {
  const args: string[] = ["run"];

  if (opts.resumeSessionId) {
    args.push("--session", opts.resumeSessionId);
  }

  if (opts.model && !opts.resumeSessionId) {
    args.push("--model", opts.model);
  }

  if (opts.agent && !opts.resumeSessionId) {
    args.push("--agent", opts.agent);
  }

  if (opts.permissionMode === "bypassPermissions") {
    args.push("--dangerously-skip-permissions");
  }

  if (opts.extraArgs && opts.extraArgs.length > 0) {
    args.push(...opts.extraArgs);
  }

  args.push("--format", "json");
  args.push(opts.taskPrompt);

  return args;
}

/** Format a single OpenCode event as a one-line summary for output. */
export function formatOpenCodeEventForOutput(
  // deno-lint-ignore no-explicit-any
  event: Record<string, any>,
  _verbosity?: Verbosity,
): string {
  switch (event.type) {
    case "step_start":
      return "[stream] step_start";
    case "text": {
      const text = event.part?.text ?? "";
      if (!text) return "";
      const preview = text.length > 120 ? text.slice(0, 120) + "…" : text;
      return `[stream] text: ${preview.replaceAll("\n", "↵")}`;
    }
    case "tool_use": {
      const hitlRequest = extractHitlRequestFromEvent(event);
      if (hitlRequest) {
        return `[stream] hitl_request: ${hitlRequest.question}`;
      }
      const tool = event.part?.tool ?? "unknown";
      return `[stream] tool: ${tool}`;
    }
    case "step_finish":
      return `[stream] result: stop ($${(event.part?.cost ?? 0).toFixed(4)})`;
    case "error":
      return `[stream] error: ${
        event.error?.data?.message ?? event.error?.name ?? "Unknown error"
      }`;
    default:
      return "";
  }
}

/** Extract normalized output from OpenCode JSON event lines. Exported for testing. */
export function extractOpenCodeOutput(lines: string[]): CliRunOutput {
  // deno-lint-ignore no-explicit-any
  const events = lines.map((line) => JSON.parse(line) as Record<string, any>);
  const textParts: string[] = [];
  let sessionId = "";
  let startTs = 0;
  let endTs = 0;
  let steps = 0;
  let cost = 0;
  let isError = false;
  let errorMessage = "";
  let hitlRequest: HumanInputRequest | undefined;

  for (const event of events) {
    sessionId = event.sessionID ?? sessionId;
    const ts = Number(event.timestamp ?? 0);
    if (ts > 0) {
      if (startTs === 0) startTs = ts;
      endTs = ts;
    }

    switch (event.type) {
      case "step_start":
        steps++;
        break;
      case "text":
        if (event.part?.text) {
          textParts.push(String(event.part.text));
        }
        break;
      case "tool_use":
        hitlRequest = hitlRequest ?? extractHitlRequestFromEvent(event);
        break;
      case "step_finish":
        cost = Number(event.part?.cost ?? cost ?? 0);
        break;
      case "error":
        isError = true;
        errorMessage = event.error?.data?.message ?? event.error?.message ??
          event.error?.name ?? "OpenCode runtime error";
        break;
    }
  }

  return {
    runtime: "opencode",
    result: isError ? errorMessage : textParts.join("\n"),
    session_id: sessionId,
    total_cost_usd: cost,
    duration_ms: startTs > 0 && endTs >= startTs ? endTs - startTs : 0,
    duration_api_ms: 0,
    num_turns: steps,
    is_error: isError,
    hitl_request: hitlRequest,
  };
}

/** Build per-invocation OpenCode config content used to inject local MCP servers. */
export function buildOpenCodeConfigContent(
  opts: RuntimeInvokeOptions,
): string | undefined {
  if (!hasConfiguredHitl(opts.hitlConfig)) {
    return undefined;
  }

  if (!opts.hitlMcpCommandBuilder) {
    throw new Error(
      "OpenCode HITL requires hitlMcpCommandBuilder — consumer must supply " +
        "a sub-process entry point for the HITL MCP server. See " +
        "RuntimeInvokeOptions.hitlMcpCommandBuilder JSDoc.",
    );
  }

  return JSON.stringify({
    mcp: {
      [OPENCODE_HITL_MCP_SERVER_NAME]: {
        type: "local",
        command: opts.hitlMcpCommandBuilder(),
        enabled: true,
      },
    },
  });
}

/** Invoke opencode CLI with retry logic. */
export async function invokeOpenCodeCli(
  opts: RuntimeInvokeOptions,
): Promise<RuntimeInvokeResult> {
  const mergedTaskPrompt = opts.systemPrompt
    ? `${opts.systemPrompt}\n\n${opts.taskPrompt}`
    : opts.taskPrompt;
  const args = buildOpenCodeArgs({
    ...opts,
    taskPrompt: mergedTaskPrompt,
  });
  const configContent = buildOpenCodeConfigContent(opts);
  let lastError = "";

  for (let attempt = 1; attempt <= opts.maxRetries; attempt++) {
    try {
      const output = await executeOpenCodeProcess(
        args,
        opts.timeoutSeconds,
        opts.onOutput,
        opts.streamLogPath,
        opts.verbosity,
        opts.cwd,
        configContent,
        opts.env,
        opts.onEvent,
      );
      if (output.is_error) {
        lastError = `OpenCode returned error: ${output.result}`;
        if (attempt < opts.maxRetries) {
          const delay = opts.retryDelaySeconds * Math.pow(2, attempt - 1);
          await sleep(delay * 1000);
          continue;
        }
        return { output, error: lastError };
      }
      return { output };
    } catch (err) {
      lastError = (err as Error).message;
      if (attempt < opts.maxRetries) {
        const delay = opts.retryDelaySeconds * Math.pow(2, attempt - 1);
        await sleep(delay * 1000);
        continue;
      }
    }
  }

  return {
    error: `OpenCode failed after ${opts.maxRetries} attempts: ${lastError}`,
  };
}

async function executeOpenCodeProcess(
  args: string[],
  timeoutSeconds: number,
  onOutput?: (line: string) => void,
  streamLogPath?: string,
  verbosity?: Verbosity,
  cwd?: string,
  configContent?: string,
  env?: Record<string, string>,
  onEvent?: (event: Record<string, unknown>) => void,
): Promise<CliRunOutput> {
  const processEnv: Record<string, string> = { ...env };
  if (configContent) {
    processEnv.OPENCODE_CONFIG_CONTENT = configContent;
  }
  const cmd = new Deno.Command("opencode", {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    ...(Object.keys(processEnv).length > 0 ? { env: processEnv } : {}),
    ...(cwd ? { cwd } : {}),
  });

  const process = cmd.spawn();
  register(process);

  try {
    const timeoutId = setTimeout(() => {
      timedOut = true;
      try {
        process.kill("SIGTERM");
      } catch {
        // Process may have already exited.
      }
    }, timeoutSeconds * 1000);

    let logFile: Deno.FsFile | undefined;
    if (streamLogPath) {
      const dir = streamLogPath.replace(/\/[^/]+$/, "");
      await Deno.mkdir(dir, { recursive: true });
      logFile = await Deno.open(streamLogPath, {
        write: true,
        create: true,
        append: true,
      });
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let stdoutBuffer = "";
    const stdoutLines: string[] = [];
    const stderrChunks: Uint8Array[] = [];
    let timedOut = false;
    let interruptedForHitl = false;

    const stdoutReader = process.stdout.getReader();
    const stdoutDone = (async () => {
      try {
        while (true) {
          const { done, value } = await stdoutReader.read();
          if (done) break;
          stdoutBuffer += decoder.decode(value, { stream: true });
          while (true) {
            const newlineIndex = stdoutBuffer.indexOf("\n");
            if (newlineIndex === -1) break;
            const line = stdoutBuffer.slice(0, newlineIndex);
            stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
            await processOpenCodeLine(
              line,
              stdoutLines,
              encoder,
              logFile,
              onOutput,
              verbosity,
              () => {
                interruptedForHitl = true;
                try {
                  process.kill("SIGTERM");
                } catch {
                  // Process may already be gone.
                }
              },
              onEvent,
            );
          }
        }
        const trailing = stdoutBuffer.trim();
        if (trailing) {
          await processOpenCodeLine(
            trailing,
            stdoutLines,
            encoder,
            logFile,
            onOutput,
            verbosity,
            () => {
              interruptedForHitl = true;
              try {
                process.kill("SIGTERM");
              } catch {
                // Process may already be gone.
              }
            },
            onEvent,
          );
        }
      } catch {
        // Stream closed.
      }
    })();

    const stderrReader = process.stderr.getReader();
    const stderrDone = (async () => {
      try {
        while (true) {
          const { done, value } = await stderrReader.read();
          if (done) break;
          stderrChunks.push(value);
        }
      } catch {
        // Stream closed.
      }
    })();

    await Promise.all([stdoutDone, stderrDone]);
    const status = await process.status;
    clearTimeout(timeoutId);

    logFile?.close();

    const stderr = decodeChunks(stderrChunks).trim();
    const jsonLines = stdoutLines.filter((line) => {
      try {
        JSON.parse(line);
        return true;
      } catch {
        return false;
      }
    });

    if (jsonLines.length > 0) {
      const output = extractOpenCodeOutput(jsonLines);
      if (interruptedForHitl && output.hitl_request) {
        output.is_error = false;
      }
      if (timedOut && !output.hitl_request) {
        throw new Error("OpenCode timed out");
      }
      if (!status.success && !output.is_error && !interruptedForHitl) {
        throw new Error(
          `OpenCode exited with code ${status.code}${
            stderr ? `: ${stderr}` : ""
          }`,
        );
      }
      return output;
    }

    if (!status.success) {
      if (timedOut) {
        throw new Error("OpenCode timed out");
      }
      throw new Error(
        `OpenCode exited with code ${status.code}${
          stderr ? `: ${stderr}` : ""
        }`,
      );
    }

    throw new Error("OpenCode JSON output contained no parseable events");
  } finally {
    unregister(process);
  }
}

async function processOpenCodeLine(
  rawLine: string,
  stdoutLines: string[],
  encoder: TextEncoder,
  logFile: Deno.FsFile | undefined,
  onOutput: ((line: string) => void) | undefined,
  verbosity: Verbosity | undefined,
  onHitlRequest: () => void,
  onEvent?: (event: Record<string, unknown>) => void,
): Promise<void> {
  const line = rawLine.trim();
  if (!line) return;
  stdoutLines.push(line);
  if (logFile) {
    await logFile.write(encoder.encode(line + "\n"));
  }
  try {
    // deno-lint-ignore no-explicit-any
    const event = JSON.parse(line) as Record<string, any>;
    onEvent?.(event);
    const summary = formatOpenCodeEventForOutput(event, verbosity);
    if (summary) {
      onOutput?.(summary);
    }
    if (extractHitlRequestFromEvent(event)) {
      onHitlRequest();
    }
  } catch {
    // Ignore non-JSON lines in stdout.
  }
}

function extractHitlRequestFromEvent(
  // deno-lint-ignore no-explicit-any
  event: Record<string, any>,
): HumanInputRequest | undefined {
  if (event.type !== "tool_use") return undefined;
  if (event.part?.tool !== OPENCODE_HITL_MCP_TOOL_NAME) return undefined;
  if (event.part?.state?.status !== "completed") return undefined;

  const input = event.part?.state?.input;
  if (!input || typeof input.question !== "string" || !input.question.trim()) {
    return undefined;
  }

  const options = Array.isArray(input.options)
    ? input.options
      .filter((entry: unknown) => typeof entry === "object" && entry !== null)
      .map((entry: unknown) => normalizeHumanInputOption(entry))
      .filter(
        (entry: HumanInputOption | undefined): entry is HumanInputOption =>
          entry !== undefined,
      )
    : undefined;

  return {
    question: String(input.question).trim(),
    header: typeof input.header === "string" ? input.header : undefined,
    options: options && options.length > 0 ? options : undefined,
    multiSelect: typeof input.multiSelect === "boolean"
      ? input.multiSelect
      : undefined,
  };
}

function normalizeHumanInputOption(
  entry: unknown,
): HumanInputOption | undefined {
  const record = entry as Record<string, unknown>;
  if (typeof record.label !== "string" || !record.label) {
    return undefined;
  }
  return {
    label: record.label,
    description: typeof record.description === "string"
      ? record.description
      : undefined,
  };
}

function hasConfiguredHitl(config?: HitlConfig): config is HitlConfig {
  return Boolean(config?.ask_script && config?.check_script);
}

function decodeChunks(chunks: Uint8Array[]): string {
  const total = chunks.reduce((n, chunk) => n + chunk.length, 0);
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(buffer);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
