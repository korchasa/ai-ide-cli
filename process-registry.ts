/**
 * @module
 * Pure child-process tracker + shutdown callback registry. Runtime-neutral:
 * no operating-system signal wiring, no `Deno.exit`. Consumers (engines, test
 * harnesses) own signal installation and call {@link killAll} when shutting
 * down.
 *
 * Two ways to use:
 *
 * - **Instance-scoped** ({@link ProcessRegistry}). One registry per logical
 *   scope (e.g. one per active workflow run, one per long-lived chat session).
 *   `killAll` on one instance does not touch processes registered with
 *   another. Recommended for embedding in larger applications that host
 *   multiple independent runtimes in one Deno process.
 * - **Default singleton.** Backward-compatible free functions
 *   ({@link register}, {@link unregister}, {@link onShutdown},
 *   {@link killAll}) operate on a process-wide default instance. Existing
 *   consumers keep working unchanged. Standalone CLI use of this package
 *   continues to use the default singleton.
 */

const DEFAULT_GRACE_MS = 5000;

// FR-L51
/**
 * Send `signal` to a child, or to its whole process group when
 * `processGroup` is `true`. A child spawned with `detached: true` leads
 * its own group (`pgid == pid`), so the group is addressed as `-pid`;
 * that reaches the tools the child forked even after the child itself
 * exited. A process or group that is already gone is not an error.
 *
 * @param p The spawned child.
 * @param signal Signal to deliver.
 * @param processGroup Signal the group led by `p` instead of `p` alone.
 */
export function signalChild(
  p: Deno.ChildProcess,
  signal: Deno.Signal,
  processGroup?: boolean,
): void {
  try {
    if (processGroup) Deno.kill(-p.pid, signal);
    else p.kill(signal);
  } catch {
    // Already exited (ESRCH) — nothing to signal.
  }
}

/** Options for {@link ProcessRegistry.register}. */
export interface RegisterOptions {
  /**
   * The child leads its own process group (spawned with
   * `detached: true`), so {@link ProcessRegistry.killAll} signals the
   * whole group (FR-L51).
   */
  processGroup?: boolean;
}

interface ProcessRegistryOptions {
  /**
   * Milliseconds to wait after `SIGTERM` before escalating to `SIGKILL`.
   * Default: 5000.
   */
  graceMs?: number;
}

/**
 * Instance-scoped child-process tracker.
 *
 * Multiple instances coexist safely in one Deno process: each instance owns
 * a private `Set<Deno.ChildProcess>` and a private shutdown-callback array,
 * so `killAll` is scoped to the instance.
 */
export class ProcessRegistry {
  readonly #processes = new Set<Deno.ChildProcess>();
  readonly #groupLeaders = new Set<Deno.ChildProcess>();
  readonly #shutdownCallbacks: Array<() => Promise<void> | void> = [];
  readonly #graceMs: number;

  /** Construct a new instance-scoped registry. `opts.graceMs` overrides the
   * default 5000ms `SIGTERM`→`SIGKILL` grace window. */
  constructor(opts: ProcessRegistryOptions = {}) {
    this.#graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  }

  /** Number of currently tracked processes. */
  get size(): number {
    return this.#processes.size;
  }

  /**
   * Register a child process for tracking. Idempotent. Pass
   * `{processGroup: true}` for a child spawned with `detached: true`, so
   * {@link killAll} signals its whole group (FR-L51).
   */
  register(p: Deno.ChildProcess, opts: RegisterOptions = {}): void {
    this.#processes.add(p);
    if (opts.processGroup) this.#groupLeaders.add(p);
  }

  /** Unregister a child process (e.g. after it exits normally). */
  unregister(p: Deno.ChildProcess): void {
    this.#processes.delete(p);
    this.#groupLeaders.delete(p);
  }

  /** Register a callback to run during shutdown (lock release, state save).
   * Returns a disposer function that removes the callback. */
  onShutdown(cb: () => Promise<void> | void): () => void {
    this.#shutdownCallbacks.push(cb);
    return () => {
      const idx = this.#shutdownCallbacks.indexOf(cb);
      if (idx !== -1) this.#shutdownCallbacks.splice(idx, 1);
    };
  }

  /** Kill all registered processes and run shutdown callbacks.
   *
   * Sends `SIGTERM`, waits up to `graceMs` for graceful exit, then `SIGKILL`.
   * A group leader (FR-L51) gets both signals on its whole group; the
   * wait ends when the leaders exit, so a group member that ignores
   * `SIGTERM` is killed then. Callbacks run after the process wait
   * completes.
   */
  async killAll(): Promise<void> {
    const waitPromises: Promise<unknown>[] = [];
    for (const p of this.#processes) {
      signalChild(p, "SIGTERM", this.#groupLeaders.has(p));
      waitPromises.push(
        p.status.catch(() => {
          /* ignore */
        }),
      );
    }

    if (waitPromises.length > 0) {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<void>((r) => {
        timeoutId = setTimeout(r, this.#graceMs);
      });
      await Promise.race([
        Promise.allSettled(waitPromises),
        timeoutPromise,
      ]);
      clearTimeout(timeoutId);
    }

    for (const p of this.#processes) {
      signalChild(p, "SIGKILL", this.#groupLeaders.has(p));
    }
    this.#processes.clear();
    this.#groupLeaders.clear();

    for (const cb of this.#shutdownCallbacks) {
      try {
        await cb();
      } catch {
        // Best-effort cleanup.
      }
    }
    this.#shutdownCallbacks.length = 0;
  }

  /** Reset tracker state. For test isolation only. */
  _reset(): void {
    this.#processes.clear();
    this.#groupLeaders.clear();
    this.#shutdownCallbacks.length = 0;
  }

  /** Get process set reference. For test assertions only. */
  _getProcesses(): Set<Deno.ChildProcess> {
    return this.#processes;
  }

  /** Get shutdown callbacks array reference. For test assertions only. */
  _getShutdownCallbacks(): Array<() => Promise<void> | void> {
    return this.#shutdownCallbacks;
  }
}

// --- Default singleton + backward-compatible wrappers ---

/**
 * Process-wide default registry. Exists for backward compatibility with
 * code that calls {@link register}, {@link unregister}, {@link onShutdown},
 * and {@link killAll} as free functions, plus standalone CLI use of this
 * package. New consumers that host multiple independent runtimes in one
 * process should create per-scope {@link ProcessRegistry} instances and
 * pass them through `RuntimeInvokeOptions.processRegistry` /
 * `RuntimeSessionOptions.processRegistry`.
 */
export const defaultRegistry: ProcessRegistry = new ProcessRegistry();

/** Register a child process in the default registry. */
export function register(
  p: Deno.ChildProcess,
  opts: RegisterOptions = {},
): void {
  defaultRegistry.register(p, opts);
}

/** Unregister a child process from the default registry. */
export function unregister(p: Deno.ChildProcess): void {
  defaultRegistry.unregister(p);
}

/** Register a shutdown callback on the default registry. */
export function onShutdown(cb: () => Promise<void> | void): () => void {
  return defaultRegistry.onShutdown(cb);
}

/** Kill all processes tracked by the default registry. */
export function killAll(): Promise<void> {
  return defaultRegistry.killAll();
}

// --- Test helpers (prefixed with _ to indicate internal use) ---

/** Reset default registry state. For test isolation only. */
export function _reset(): void {
  defaultRegistry._reset();
}

/** Get default registry's process set. For test assertions only. */
export function _getProcesses(): Set<Deno.ChildProcess> {
  return defaultRegistry._getProcesses();
}

/** Get default registry's shutdown callbacks. For test assertions only. */
export function _getShutdownCallbacks(): Array<() => Promise<void> | void> {
  return defaultRegistry._getShutdownCallbacks();
}
