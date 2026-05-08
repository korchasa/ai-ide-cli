/**
 * @module
 * Detect fatal upstream-API errors (HTTP 401/402/403/429) in the OpenCode
 * CLI's internal log file and surface them as adapter errors.
 *
 * Why this exists: when the OpenCode CLI's underlying provider returns a
 * non-recoverable HTTP status (auth failure, quota exceeded, rate-limit),
 * the CLI marks the failure as `isRetryable: true` and silently retries
 * inside its own runtime. Nothing reaches our `--format json` event
 * stream, so the adapter sees a healthy-looking process that produces no
 * progress. Wall-clock timeout would eventually fire, but only after the
 * full provider quota window (5 hours for `zai-coding-plan`) — well past
 * any sensible workflow budget.
 *
 * Strategy: tail the CLI's internal log (`~/.local/share/opencode/log/<ts>.log`),
 * pattern-match `"statusCode":<4XX>` plus the upstream `message`, kill the
 * subprocess on first match, and return the verbatim provider message so
 * the consumer can surface it (e.g.
 * `Usage limit reached for 5 hour. Your limit will reset at ...`).
 *
 * Override the log dir via `OPENCODE_LOG_DIR` (used by tests).
 */

/** Structured upstream-API fatal error extracted from the OpenCode log. */
export interface UpstreamFatalError {
  /** HTTP status code (one of 401, 402, 403, 429). */
  statusCode: number;
  /** Human-readable message from the upstream provider, verbatim. */
  message: string;
}

/** HTTP status codes treated as fatal (no point retrying). */
const FATAL_STATUS_CODES = new Set([401, 402, 403, 429]);

/**
 * Parse a single OpenCode log line for a fatal upstream-API error.
 * Returns the structured error if found, `undefined` otherwise.
 *
 * Recognises payloads of the form:
 *   ...{"statusCode":429,...,"data":{"error":{"message":"..."}}}...
 *   ...{"statusCode":401,...,"error":{"message":"..."}}...
 *
 * A status-code match without a message still returns a result with a
 * generic placeholder so the consumer surfaces the failure.
 */
export function detectUpstreamFatalInLine(
  line: string,
): UpstreamFatalError | undefined {
  const codeMatch = /"statusCode":\s*(\d{3})/.exec(line);
  if (!codeMatch) return undefined;
  const statusCode = parseInt(codeMatch[1], 10);
  if (!FATAL_STATUS_CODES.has(statusCode)) return undefined;

  // Extract the human message — first `"message":"<...>"` after the status
  // code. JSON-escape unwrapping is intentionally loose: the upstream payload
  // is single-line JSON so backslash-quote and backslash-backslash are the
  // only realistic escapes.
  const after = line.slice(codeMatch.index);
  const msgMatch = /"message":\s*"((?:[^"\\]|\\.)*)"/.exec(after);
  const message = msgMatch
    ? msgMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\").replace(
      /\\n/g,
      " ",
    )
    : `HTTP ${statusCode} from upstream provider`;

  return { statusCode, message };
}

/** Resolve the log directory the OpenCode CLI writes to.
 *
 * Order: explicit `OPENCODE_LOG_DIR` env var → `<HOME>/.local/share/opencode/log`.
 * Returns `undefined` when neither is available. */
export function resolveOpenCodeLogDir(): string | undefined {
  const override = Deno.env.get("OPENCODE_LOG_DIR");
  if (override) return override;
  const home = Deno.env.get("HOME");
  if (!home) return undefined;
  return `${home}/.local/share/opencode/log`;
}

/**
 * Pick the OpenCode log file most likely to belong to the just-spawned
 * subprocess. Polls the directory until a `.log` file with mtime ≥
 * `spawnedAfterMs` appears, or the budget elapses.
 *
 * Returns `undefined` if the directory does not exist, no matching file
 * appears within the budget, or the supplied signal aborts first.
 */
export async function findActiveOpenCodeLog(
  logDir: string,
  spawnedAfterMs: number,
  pollTimeoutMs: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const deadline = Date.now() + pollTimeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return undefined;
    let best: { path: string; mtime: number } | undefined;
    try {
      for await (const entry of Deno.readDir(logDir)) {
        if (!entry.isFile || !entry.name.endsWith(".log")) continue;
        const stat = await Deno.stat(`${logDir}/${entry.name}`);
        const mtime = stat.mtime?.getTime() ?? 0;
        if (mtime + 5_000 < spawnedAfterMs) continue;
        if (!best || mtime > best.mtime) {
          best = { path: `${logDir}/${entry.name}`, mtime };
        }
      }
    } catch {
      return undefined;
    }
    if (best) return best.path;
    try {
      await sleep(150, signal);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Tail a single log file and invoke `onFatal` exactly once when a fatal
 * upstream error is detected. Returns when the signal aborts or a fatal
 * line was emitted.
 */
export async function watchOpenCodeLogForFatalError(
  logPath: string,
  onFatal: (err: UpstreamFatalError) => void,
  signal: AbortSignal,
  pollIntervalMs = 250,
): Promise<void> {
  let offset = 0;
  let leftover = "";
  const decoder = new TextDecoder();

  while (!signal.aborted) {
    let stat: Deno.FileInfo;
    try {
      stat = await Deno.stat(logPath);
    } catch {
      try {
        await sleep(pollIntervalMs, signal);
        continue;
      } catch {
        return;
      }
    }

    if (stat.size > offset) {
      let file: Deno.FsFile;
      try {
        file = await Deno.open(logPath, { read: true });
      } catch {
        try {
          await sleep(pollIntervalMs, signal);
          continue;
        } catch {
          return;
        }
      }
      let chunk = "";
      try {
        await file.seek(offset, Deno.SeekMode.Start);
        const buf = new Uint8Array(stat.size - offset);
        const read = await file.read(buf);
        offset = stat.size;
        if (read !== null) {
          chunk = decoder.decode(buf.subarray(0, read));
        }
      } finally {
        file.close();
      }
      const text = leftover + chunk;
      const lines = text.split("\n");
      leftover = lines.pop() ?? "";
      for (const line of lines) {
        const fatal = detectUpstreamFatalInLine(line);
        if (fatal) {
          onFatal(fatal);
          return;
        }
      }
    }

    try {
      await sleep(pollIntervalMs, signal);
    } catch {
      return;
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const id = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(id);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
