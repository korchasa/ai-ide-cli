/**
 * @module
 * Streaming-input Claude CLI session: spawns `claude -p --input-format stream-json
 * --output-format stream-json --verbose` with piped stdin, exposes an
 * async-iterable event stream, and lets the caller push additional user
 * messages into the live subprocess via {@link ClaudeSession.send}. Closing
 * stdin via {@link ClaudeSession.endInput} triggers the CLI's final `result`
 * event and clean exit.
 *
 * This is the Claude-only counterpart to the one-shot {@link invokeClaudeCli}
 * in `claude/process.ts`. Mirrors the transport layer of Anthropic's Claude
 * Agent SDK (TypeScript) — same CLI flags, same stdin JSONL shape, same
 * stdout NDJSON stream. Source of truth for future extensions:
 * https://github.com/anthropics/claude-agent-sdk-typescript
 *
 * Entry point: {@link openClaudeSession}.
 */

import {
  type ExtraArgsMap,
  SessionAbortedError,
  SessionDeliveryError,
  SessionInputClosedError,
} from "../runtime/types.ts";
import { expandExtraArgs } from "../runtime/index.ts";
import { validateToolFilter } from "../runtime/tool-filter.ts";
import { SessionEventQueue } from "../runtime/event-queue.ts";
import {
  defaultClaudeConfigDir,
  prepareSettingSourcesDir,
  type SettingSource,
} from "../runtime/setting-sources.ts";
import { register, unregister } from "../process-registry.ts";
import { CLAUDE_RESERVED_FLAGS } from "./process.ts";
import { type ClaudeStreamEvent, parseClaudeStreamEvent } from "./stream.ts";

/** Options for {@link openClaudeSession}. */
export interface ClaudeSessionOptions {
  /** Agent name passed via --agent. */
  agent?: string;
  /** System prompt appended via --append-system-prompt. */
  systemPrompt?: string;
  /** Model override (--model). */
  model?: string;
  /** Permission mode (--permission-mode). */
  permissionMode?: string;
  /** Resume an existing session ID (--resume). */
  resumeSessionId?: string;
  /** Extra CLI args (see {@link ExtraArgsMap}). */
  claudeArgs?: ExtraArgsMap;
  /** Working directory for the subprocess. */
  cwd?: string;
  /** Extra env merged into the subprocess env. */
  env?: Record<string, string>;
  /**
   * External abort signal. On abort, the subprocess receives SIGTERM and the
   * session's `done` promise resolves with the resulting exit code.
   */
  signal?: AbortSignal;
  /** Claude configuration-source filter (see {@link prepareSettingSourcesDir}). */
  settingSources?: SettingSource[];
  /**
   * Tool-name allow-list — emitted as `--allowedTools <comma-joined>`.
   * Mutually exclusive with {@link disallowedTools}. See FR-L24.
   */
  allowedTools?: string[];
  /**
   * Tool-name deny-list — emitted as `--disallowedTools <comma-joined>`.
   * Mutually exclusive with {@link allowedTools}. See FR-L24.
   */
  disallowedTools?: string[];
  /** Fires for every parsed stream-json event in stdout order. */
  onEvent?: (event: ClaudeStreamEvent) => void;
  /** Fires for every decoded stderr line (trimmed, may be empty). */
  onStderr?: (line: string) => void;
}

/** Terminal state of a Claude session subprocess. */
export interface ClaudeSessionStatus {
  /** OS exit code when exited normally, `null` when killed by signal. */
  exitCode: number | null;
  /** Termination signal name when killed by signal, `null` otherwise. */
  signal: Deno.Signal | null;
  /** Aggregated stderr text captured during the session. */
  stderr: string;
}

/**
 * Live handle for a Claude CLI subprocess in streaming-input mode.
 *
 * Lifecycle: spawn → zero or more {@link send} / {@link events} iterations →
 * {@link endInput} (graceful close) or {@link abort} (SIGTERM) → `done`
 * resolves.
 */
export interface ClaudeSession {
  /** OS process ID of the spawned `claude` subprocess. */
  readonly pid: number;
  /**
   * Claude-assigned session id for resume. The Claude CLI allocates it
   * inside the subprocess and emits it in the first `system/init` event —
   * this field returns `""` until that event has been parsed, then holds
   * the id for the remainder of the session. Getter-backed so late
   * population is visible to downstream wrappers that captured the
   * handle before init arrived.
   */
  readonly sessionId: string;
  /**
   * Push an additional user message into the running session.
   *
   * Accepts either a plain string (wrapped as `{role: "user", content}`) or a
   * fully-formed stream-json input object. Rejects with
   * {@link SessionInputClosedError} when stdin has been closed via
   * {@link endInput}, {@link SessionAbortedError} after {@link abort}, or
   * {@link SessionDeliveryError} when the write to the subprocess stdin
   * fails (e.g. broken pipe after the CLI crashed).
   */
  send(content: string | ClaudeSessionUserInput): Promise<void>;
  /**
   * Async iterable of every parsed `stream-json` event emitted by the CLI,
   * in the order they appeared on stdout. Completes when stdout closes.
   * Can be iterated at most once.
   */
  readonly events: AsyncIterable<ClaudeStreamEvent>;
  /**
   * Close stdin (signal-only — returns promptly after the EOF is flushed).
   * The CLI finishes the current turn, emits a terminal `result` event, and
   * exits; full shutdown is observable via {@link done}. Subsequent
   * {@link send} calls throw.
   */
  endInput(): Promise<void>;
  /**
   * Send SIGTERM to the subprocess. Subsequent {@link send} calls throw.
   * Safe to call multiple times and after normal exit.
   */
  abort(reason?: string): void;
  /** Resolves when the subprocess exits (either via {@link endInput}, {@link abort}, or external signal). */
  readonly done: Promise<ClaudeSessionStatus>;
}

/**
 * Fully-formed stream-json input object as accepted by the CLI on stdin.
 * Matches Anthropic's Messages API user-message content shape.
 */
export interface ClaudeSessionUserInput {
  /** Always `"user"` for now — the CLI rejects other discriminators. */
  type: "user";
  /** Message envelope. */
  message: {
    /** Always `"user"` in the current protocol. */
    role: "user";
    /** String content (simple case) or an array of Anthropic content blocks. */
    content: string | Array<Record<string, unknown>>;
  };
}

/**
 * Build the argv for streaming-input Claude CLI invocations.
 *
 * Emits: `--permission-mode`, expanded {@link ClaudeSessionOptions.claudeArgs},
 * `--resume`, `-p`, `--agent`, `--append-system-prompt`, `--model`, then the
 * four transport flags `--output-format stream-json --verbose --input-format
 * stream-json`. Mirrors the flag order of {@link import("./process").buildClaudeArgs}
 * for the overlapping options so both adapters remain diff-friendly.
 *
 * Exported for unit testing; callers do not need it for normal use.
 */
export function buildClaudeSessionArgs(opts: ClaudeSessionOptions): string[] {
  const args: string[] = [];

  if (opts.permissionMode) {
    args.push("--permission-mode", opts.permissionMode);
  }

  // FR-L24: typed tool filter. Shares the validator with the one-shot
  // path (claude/process.ts); same two-token emission shape.
  const toolFilterMode = validateToolFilter("claude", {
    allowedTools: opts.allowedTools,
    disallowedTools: opts.disallowedTools,
    extraArgs: opts.claudeArgs,
  });
  if (toolFilterMode === "allowed") {
    args.push("--allowedTools", opts.allowedTools!.join(","));
  } else if (toolFilterMode === "disallowed") {
    args.push("--disallowedTools", opts.disallowedTools!.join(","));
  }

  args.push(...expandExtraArgs(opts.claudeArgs, CLAUDE_RESERVED_FLAGS));

  if (opts.resumeSessionId) {
    args.push("--resume", opts.resumeSessionId);
  }

  // `-p` is a bare flag in streaming mode — no prompt value. Initial prompt
  // (if any) flows in via stdin.
  args.push("-p");

  if (!opts.resumeSessionId) {
    if (opts.agent) args.push("--agent", opts.agent);
    if (opts.systemPrompt) {
      args.push("--append-system-prompt", opts.systemPrompt);
    }
  }

  if (opts.model && !opts.resumeSessionId) {
    args.push("--model", opts.model);
  }

  args.push("--output-format", "stream-json", "--verbose");
  args.push("--input-format", "stream-json");

  return args;
}

/**
 * Spawn a streaming-input Claude CLI session.
 *
 * Returns a handle whose {@link ClaudeSession.send} method pushes additional
 * user messages to the running subprocess. The session stays alive until the
 * caller closes it (via {@link ClaudeSession.endInput} or
 * {@link ClaudeSession.abort}) or the subprocess exits on its own.
 */
export async function openClaudeSession(
  opts: ClaudeSessionOptions,
): Promise<ClaudeSession> {
  const args = buildClaudeSessionArgs(opts);

  let settingCleanup: (() => Promise<void>) | undefined;
  let env: Record<string, string> = { CLAUDECODE: "", ...(opts.env ?? {}) };
  if (opts.settingSources) {
    const prepared = await prepareSettingSourcesDir(
      opts.settingSources,
      env.CLAUDE_CONFIG_DIR ?? defaultClaudeConfigDir(),
      opts.cwd ?? Deno.cwd(),
    );
    settingCleanup = prepared.cleanup;
    env = { ...env, CLAUDE_CONFIG_DIR: prepared.tmpDir };
  }

  const cmd = new Deno.Command("claude", {
    args,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });

  const process = cmd.spawn();
  register(process);

  const encoder = new TextEncoder();
  const stdinWriter = process.stdin.getWriter();
  let stdinClosed = false;
  let aborted = false;
  let currentSessionId = opts.resumeSessionId ?? "";

  const queue = new SessionEventQueue<ClaudeStreamEvent>("ClaudeSession");

  const captureSessionId = (event: ClaudeStreamEvent) => {
    const id = (event as { session_id?: unknown }).session_id;
    if (typeof id === "string" && id) currentSessionId = id;
  };

  const stdoutPump = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    const reader = process.stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const event = parseClaudeStreamEvent(line);
          if (!event) continue;
          captureSessionId(event);
          queue.push(event);
          try {
            opts.onEvent?.(event);
          } catch {
            // onEvent is a notification hook; swallow consumer errors.
          }
        }
      }
      if (buffer.trim()) {
        const event = parseClaudeStreamEvent(buffer);
        if (event) {
          captureSessionId(event);
          queue.push(event);
          try {
            opts.onEvent?.(event);
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // Reader closed mid-read — finalization runs below.
    } finally {
      queue.close();
    }
  })();

  const stderrChunks: Uint8Array[] = [];
  const stderrPump = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    const reader = process.stderr.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stderrChunks.push(value);
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          try {
            opts.onStderr?.(line);
          } catch {
            // ignore
          }
        }
      }
      if (buffer.length > 0) {
        try {
          opts.onStderr?.(buffer);
        } catch {
          // ignore
        }
      }
    } catch {
      // stream closed
    }
  })();

  const doKill = () => {
    try {
      process.kill("SIGTERM");
    } catch {
      // Process may have already exited.
    }
  };

  const onExternalAbort = () => {
    aborted = true;
    doKill();
  };
  if (opts.signal) {
    if (opts.signal.aborted) {
      onExternalAbort();
    } else {
      opts.signal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  async function forceCloseStdin(): Promise<void> {
    if (stdinClosed) return;
    stdinClosed = true;
    try {
      await stdinWriter.close();
    } catch {
      try {
        await stdinWriter.abort();
      } catch {
        // Writer already errored/released — nothing to do.
      }
    }
  }

  const done = (async (): Promise<ClaudeSessionStatus> => {
    try {
      const [status] = await Promise.all([
        process.status,
        stdoutPump,
        stderrPump,
      ]);
      // Ensure Deno's leak detector sees stdin as closed even if the caller
      // never invoked endInput() (subprocess may have exited on its own).
      await forceCloseStdin();
      const stderr = decodeConcat(stderrChunks);
      return {
        exitCode: status.code,
        signal: status.signal ?? null,
        stderr,
      };
    } finally {
      if (opts.signal) {
        opts.signal.removeEventListener("abort", onExternalAbort);
      }
      unregister(process);
      if (settingCleanup) {
        await settingCleanup();
      }
    }
  })();

  async function send(input: string | ClaudeSessionUserInput): Promise<void> {
    if (aborted) throw new SessionAbortedError("claude");
    if (stdinClosed) throw new SessionInputClosedError("claude");
    const payload: ClaudeSessionUserInput = typeof input === "string"
      ? { type: "user", message: { role: "user", content: input } }
      : input;
    const line = JSON.stringify(payload) + "\n";
    try {
      await stdinWriter.write(encoder.encode(line));
    } catch (err) {
      throw new SessionDeliveryError(
        "claude",
        `claude session: failed to write to stdin: ${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  async function endInput(): Promise<void> {
    await forceCloseStdin();
  }

  function abort(_reason?: string): void {
    if (aborted) return;
    aborted = true;
    // Fire-and-forget: once SIGTERM is sent the pipe may break immediately,
    // and the done-promise finalizer will retry closing on exit anyway.
    forceCloseStdin().catch(() => {});
    doKill();
  }

  return {
    pid: process.pid,
    get sessionId() {
      return currentSessionId;
    },
    send,
    events: queue,
    endInput,
    abort,
    done,
  };
}

/** Concatenate a list of byte chunks and decode as UTF-8. */
function decodeConcat(chunks: Uint8Array[]): string {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(buf).trim();
}
