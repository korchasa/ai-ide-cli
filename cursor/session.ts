/**
 * @module
 * Faux streaming-input Cursor CLI session.
 *
 * Cursor CLI has no streaming-input transport (no `--input-format stream-json`
 * equivalent). `openCursorSession` emulates a long-lived session by:
 *
 * 1. Obtaining a chat ID up front via `cursor agent create-chat` (unless the
 *    caller supplies `resumeSessionId`).
 * 2. Spawning a fresh `cursor agent -p --resume <chatId> <message>` subprocess
 *    for every {@link CursorSession.send}. Sends are serialized — the worker
 *    waits for the current subprocess to exit before starting the next.
 * 3. Forwarding every NDJSON event from each subprocess into a single
 *    async-iterable queue so consumers see one unbroken event stream across
 *    turns. A synthetic `{type:"system",subtype:"init",synthetic:true}` event
 *    carrying the chat ID is pushed at open time.
 *
 * The session stays "alive" between sends from the caller's perspective, but
 * no subprocess is actually running while idle. `pid` reflects the currently
 * active subprocess (or `0` when idle). Model selection is ignored for the
 * same reason the one-shot path drops it on `--resume`: Cursor's resume flow
 * does not accept `--model`.
 *
 * Entry point: {@link openCursorSession}.
 */

import type { ExtraArgsMap } from "../runtime/types.ts";
import { expandExtraArgs } from "../runtime/index.ts";
import { register, unregister } from "../process-registry.ts";
import { CURSOR_RESERVED_FLAGS } from "./process.ts";

/** Options for {@link openCursorSession}. */
export interface CursorSessionOptions {
  /**
   * System prompt prepended to the **first** send of a newly created chat.
   * Ignored when {@link resumeSessionId} is set (resumed chats already carry
   * their original system prompt). Cursor's resume flow does not accept
   * `--append-system-prompt`, so this is merged into the first user message.
   */
  systemPrompt?: string;
  /** Runtime-specific permission mode. `"bypassPermissions"` maps to `--yolo`. */
  permissionMode?: string;
  /**
   * Resume an existing chat instead of creating a new one. When set,
   * `create-chat` is skipped.
   */
  resumeSessionId?: string;
  /**
   * Extra CLI flags forwarded to each `cursor agent -p --resume` invocation.
   * See {@link ExtraArgsMap} for value semantics. Keys in
   * {@link CURSOR_RESERVED_FLAGS} throw.
   */
  cursorArgs?: ExtraArgsMap;
  /** Working directory for the subprocesses. */
  cwd?: string;
  /** Extra env merged into each subprocess's env. */
  env?: Record<string, string>;
  /**
   * External abort signal. On abort, the current subprocess (if any) receives
   * SIGTERM, the worker loop drains and rejects pending sends, and the
   * session's `done` promise resolves.
   */
  signal?: AbortSignal;
  /** Fires for every parsed NDJSON event emitted by any send subprocess. */
  onEvent?: (event: CursorStreamEvent) => void;
  /** Fires for every decoded stderr line across all send subprocesses. */
  onStderr?: (line: string) => void;
}

/**
 * Raw Cursor stream-json event. Shape mirrors Claude Code's stream-json:
 * `{type: "system" | "assistant" | "user" | "result", ...}`. Kept as a
 * loose record so new event types pass through unchanged.
 */
// deno-lint-ignore no-explicit-any
export type CursorStreamEvent = Record<string, any>;

/** Terminal state of a Cursor session after all sends have drained. */
export interface CursorSessionStatus {
  /**
   * OS exit code of the **last** send subprocess, or `null` when the session
   * was aborted or never ran a subprocess.
   */
  exitCode: number | null;
  /**
   * Termination signal name of the last subprocess (`"SIGTERM"` after abort),
   * `null` when exited normally.
   */
  signal: Deno.Signal | null;
  /** Aggregated stderr text captured across every send subprocess. */
  stderr: string;
}

/**
 * Live handle for a faux Cursor streaming session.
 *
 * Lifecycle: open → zero or more {@link send} / {@link events} iterations →
 * {@link endInput} (graceful drain) or {@link abort} (SIGTERM current) →
 * `done` resolves.
 */
export interface CursorSession {
  /** Always `"cursor"`. */
  readonly runtime: "cursor";
  /**
   * PID of the currently active send subprocess, or `0` when the session is
   * idle (between sends or after close). Implemented as a getter — reads
   * reflect the live state.
   */
  readonly pid: number;
  /** Chat ID backing every `--resume` call. */
  readonly chatId: string;
  /**
   * Queue the given text as a new user message. Returns when that message's
   * subprocess has exited. Throws if input is closed or the session is
   * aborted.
   */
  send(content: string): Promise<void>;
  /**
   * Async iterable of every parsed NDJSON event across all send subprocesses,
   * prefixed by a synthetic `system.init` event carrying the chat ID.
   * Completes after {@link endInput} drains or {@link abort} fires. Can be
   * iterated at most once.
   */
  readonly events: AsyncIterable<CursorStreamEvent>;
  /**
   * Refuse further sends, wait for pending sends to drain, then close the
   * event stream.
   */
  endInput(): Promise<void>;
  /**
   * Refuse further sends, SIGTERM the active subprocess, reject pending sends,
   * close the event stream. Idempotent.
   */
  abort(reason?: string): void;
  /** Resolves with the terminal status once the worker loop has drained. */
  readonly done: Promise<CursorSessionStatus>;
}

/** Options for {@link createCursorChat}. */
export interface CreateCursorChatOptions {
  /** Working directory for the subprocess. */
  cwd?: string;
  /** Extra env merged into the subprocess env. */
  env?: Record<string, string>;
  /**
   * Optional timeout in seconds for the create-chat call.
   * Default: 30 seconds.
   */
  timeoutSeconds?: number;
}

/**
 * Invoke `cursor agent create-chat`, returning the new chat ID.
 * Exported for callers that want to create a chat ahead of time (e.g. to
 * pass to {@link invokeCursorCli} via `resumeSessionId`).
 */
export async function createCursorChat(
  opts: CreateCursorChatOptions = {},
): Promise<string> {
  const timeoutMs = (opts.timeoutSeconds ?? 30) * 1000;
  const cmd = new Deno.Command("cursor", {
    args: ["agent", "create-chat"],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const proc = cmd.spawn();
  register(proc);
  try {
    const [status, stdoutBuf, stderrBuf] = await Promise.all([
      proc.status,
      readAll(proc.stdout),
      readAll(proc.stderr),
    ]);
    if (!status.success) {
      const stderr = new TextDecoder().decode(stderrBuf).trim();
      throw new Error(
        `cursor agent create-chat exited with code ${status.code}${
          stderr ? `: ${stderr}` : ""
        }`,
      );
    }
    const id = parseChatId(new TextDecoder().decode(stdoutBuf));
    if (!id) {
      throw new Error(
        "cursor agent create-chat returned empty output (expected chat ID)",
      );
    }
    return id;
  } finally {
    unregister(proc);
  }
}

/**
 * Build the argv for a single `cursor agent -p --resume <chatId> <message>`
 * invocation used by {@link openCursorSession}'s worker loop. Exported for
 * unit testing.
 */
export function buildCursorSendArgs(opts: {
  /** Target chat ID for `--resume`. */
  chatId: string;
  /** The user message passed as the positional prompt. */
  message: string;
  /** Cursor permission mode. `"bypassPermissions"` maps to `--yolo`. */
  permissionMode?: string;
  /** Extra CLI flags (see {@link ExtraArgsMap}). */
  cursorArgs?: ExtraArgsMap;
}): string[] {
  const args: string[] = ["agent", "-p", "--resume", opts.chatId];
  if (opts.permissionMode === "bypassPermissions") {
    args.push("--yolo");
  }
  args.push(...expandExtraArgs(opts.cursorArgs, CURSOR_RESERVED_FLAGS));
  args.push("--output-format", "stream-json");
  args.push("--trust");
  args.push(opts.message);
  return args;
}

/**
 * Open a faux streaming-input Cursor session. See the module header for the
 * create-chat + resume-per-send emulation strategy.
 */
export async function openCursorSession(
  opts: CursorSessionOptions = {},
): Promise<CursorSession> {
  const chatId = opts.resumeSessionId ??
    (await createCursorChat({ cwd: opts.cwd, env: opts.env }));

  const queue = new EventQueue();
  queue.push({
    type: "system",
    subtype: "init",
    session_id: chatId,
    runtime: "cursor",
    synthetic: true,
  });

  interface Pending {
    message: string;
    resolve: () => void;
    reject: (err: Error) => void;
  }
  const pending: Pending[] = [];
  const stderrChunks: Uint8Array[] = [];

  let inputClosed = false;
  let aborted = false;
  let currentProcess: Deno.ChildProcess | undefined;
  let currentPid = 0;
  let pendingSystemPrompt = opts.resumeSessionId
    ? ""
    : (opts.systemPrompt ?? "");
  let lastExitCode: number | null = null;
  let lastSignal: Deno.Signal | null = null;
  let workerWaker: (() => void) | undefined;

  function wakeWorker(): void {
    const r = workerWaker;
    workerWaker = undefined;
    r?.();
  }

  async function runSingleSend(message: string): Promise<void> {
    const effective = pendingSystemPrompt
      ? `${pendingSystemPrompt}\n\n${message}`
      : message;
    pendingSystemPrompt = "";

    const args = buildCursorSendArgs({
      chatId,
      message: effective,
      permissionMode: opts.permissionMode,
      cursorArgs: opts.cursorArgs,
    });

    const proc = new Deno.Command("cursor", {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    }).spawn();

    currentProcess = proc;
    currentPid = proc.pid;
    register(proc);

    // If abort landed between spawn and registration, catch it now.
    if (aborted) {
      try {
        proc.kill("SIGTERM");
      } catch {
        // already exited
      }
    }

    const stdoutPump = pumpStdout(proc.stdout, queue, opts.onEvent);
    const stderrPump = pumpStderr(proc.stderr, stderrChunks, opts.onStderr);

    try {
      const [status] = await Promise.all([proc.status, stdoutPump, stderrPump]);
      lastExitCode = status.code;
      lastSignal = status.signal ?? null;
      if (!status.success && !aborted) {
        throw new Error(
          `Cursor CLI send exited with code ${status.code}${
            status.signal ? ` (signal ${status.signal})` : ""
          }`,
        );
      }
    } finally {
      unregister(proc);
      currentProcess = undefined;
      currentPid = 0;
    }
  }

  async function runWorker(): Promise<void> {
    try {
      while (true) {
        while (pending.length === 0 && !inputClosed && !aborted) {
          await new Promise<void>((r) => {
            workerWaker = r;
          });
        }
        if (aborted) {
          for (const p of pending.splice(0)) {
            p.reject(new Error("CursorSession: aborted"));
          }
          break;
        }
        if (pending.length === 0 && inputClosed) break;

        const item = pending.shift()!;
        try {
          await runSingleSend(item.message);
          if (aborted) {
            item.reject(new Error("CursorSession: aborted"));
          } else {
            item.resolve();
          }
        } catch (err) {
          item.reject(err as Error);
        }
      }
    } finally {
      queue.close();
    }
  }

  const workerDone = runWorker();

  function send(content: string): Promise<void> {
    if (aborted) {
      return Promise.reject(new Error("CursorSession: aborted"));
    }
    if (inputClosed) {
      return Promise.reject(new Error("CursorSession: input already closed"));
    }
    return new Promise<void>((resolve, reject) => {
      pending.push({ message: content, resolve, reject });
      wakeWorker();
    });
  }

  async function endInput(): Promise<void> {
    if (!inputClosed) {
      inputClosed = true;
      wakeWorker();
    }
    await workerDone;
  }

  function abort(_reason?: string): void {
    if (aborted) return;
    aborted = true;
    inputClosed = true;
    if (currentProcess) {
      try {
        currentProcess.kill("SIGTERM");
      } catch {
        // already exited
      }
    }
    wakeWorker();
  }

  if (opts.signal) {
    if (opts.signal.aborted) {
      abort();
    } else {
      opts.signal.addEventListener("abort", () => abort(), { once: true });
    }
  }

  const done = workerDone.then<CursorSessionStatus>(() => ({
    exitCode: lastExitCode,
    signal: lastSignal,
    stderr: decodeConcat(stderrChunks),
  }));

  return {
    runtime: "cursor",
    get pid() {
      return currentPid;
    },
    chatId,
    send,
    events: queue,
    endInput,
    abort,
    done,
  };
}

// -- Internals --

async function pumpStdout(
  stream: ReadableStream<Uint8Array>,
  queue: EventQueue,
  onEvent: CursorSessionOptions["onEvent"],
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = safeParse(line);
        if (!event) continue;
        queue.push(event);
        try {
          onEvent?.(event);
        } catch {
          // onEvent is a notification hook; swallow consumer errors.
        }
      }
    }
    if (buffer.trim()) {
      const event = safeParse(buffer);
      if (event) {
        queue.push(event);
        try {
          onEvent?.(event);
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // Reader closed mid-read — worker loop handles finalization.
  }
}

async function pumpStderr(
  stream: ReadableStream<Uint8Array>,
  sink: Uint8Array[],
  onStderr: CursorSessionOptions["onStderr"],
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sink.push(value);
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        try {
          onStderr?.(line);
        } catch {
          // ignore
        }
      }
    }
    if (buffer.length > 0) {
      try {
        onStderr?.(buffer);
      } catch {
        // ignore
      }
    }
  } catch {
    // stream closed
  }
}

function safeParse(line: string): CursorStreamEvent | undefined {
  try {
    return JSON.parse(line) as CursorStreamEvent;
  } catch {
    return undefined;
  }
}

async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.length;
  }
  return buf;
}

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

/**
 * Extract a chat ID from `cursor agent create-chat` stdout.
 *
 * The CLI may wrap the ID in surrounding log noise depending on version; we
 * pick the last non-empty whitespace-separated token to be resilient.
 */
function parseChatId(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  return tokens[tokens.length - 1] ?? "";
}

/**
 * Unbounded FIFO queue backing {@link CursorSession.events}. Mirrors the
 * {@link import("../claude/session").ClaudeSession}'s queue semantics: async
 * iterator blocks on `next()` until a new event arrives or the queue is
 * closed. Can be iterated at most once; re-iteration throws.
 */
class EventQueue implements AsyncIterable<CursorStreamEvent> {
  private items: CursorStreamEvent[] = [];
  private resolvers: Array<
    (r: IteratorResult<CursorStreamEvent>) => void
  > = [];
  private closed = false;
  private iterated = false;

  push(event: CursorStreamEvent): void {
    if (this.closed) return;
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value: event, done: false });
      return;
    }
    this.items.push(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const resolver of this.resolvers) {
      resolver({ value: undefined, done: true });
    }
    this.resolvers.length = 0;
  }

  [Symbol.asyncIterator](): AsyncIterator<CursorStreamEvent> {
    if (this.iterated) {
      throw new Error("CursorSession.events can only be iterated once");
    }
    this.iterated = true;
    return {
      next: (): Promise<IteratorResult<CursorStreamEvent>> => {
        const item = this.items.shift();
        if (item !== undefined) {
          return Promise.resolve({ value: item, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          this.resolvers.push(resolve);
        });
      },
      return: (): Promise<IteratorResult<CursorStreamEvent>> => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
