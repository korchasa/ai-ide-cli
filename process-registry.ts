/**
 * @module
 * Pure child-process tracker + shutdown callback registry. Runtime-neutral:
 * no OS signal wiring, no `Deno.exit`. Consumers (engines, test harnesses)
 * own signal installation and call {@link killAll} when shutting down.
 */

const processes = new Set<Deno.ChildProcess>();
const shutdownCallbacks: Array<() => Promise<void> | void> = [];

/** Register a child process for tracking. Idempotent. */
export function register(p: Deno.ChildProcess): void {
  processes.add(p);
}

/** Unregister a child process (e.g. after it exits normally). */
export function unregister(p: Deno.ChildProcess): void {
  processes.delete(p);
}

/** Register a callback to run during shutdown (lock release, state save).
 * Returns a disposer function that removes the callback. */
export function onShutdown(cb: () => Promise<void> | void): () => void {
  shutdownCallbacks.push(cb);
  return () => {
    const idx = shutdownCallbacks.indexOf(cb);
    if (idx !== -1) shutdownCallbacks.splice(idx, 1);
  };
}

/** Kill all registered processes and run shutdown callbacks.
 *
 * Sends SIGTERM, waits up to 5s for graceful exit, then SIGKILL.
 * Callbacks run after process wait.
 */
export async function killAll(): Promise<void> {
  const waitPromises: Promise<unknown>[] = [];
  for (const p of processes) {
    try {
      p.kill("SIGTERM");
    } catch {
      // Process may have already exited
    }
    waitPromises.push(
      p.status.catch(() => {
        /* ignore */
      }),
    );
  }

  if (waitPromises.length > 0) {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<void>((r) => {
      timeoutId = setTimeout(r, 5000);
    });
    await Promise.race([
      Promise.allSettled(waitPromises),
      timeoutPromise,
    ]);
    clearTimeout(timeoutId);
  }

  for (const p of processes) {
    try {
      p.kill("SIGKILL");
    } catch {
      // Already exited
    }
  }
  processes.clear();

  for (const cb of shutdownCallbacks) {
    try {
      await cb();
    } catch {
      // Best-effort cleanup
    }
  }
  shutdownCallbacks.length = 0;
}

// --- Test helpers (prefixed with _ to indicate internal use) ---

/** Reset tracker state. For test isolation only. */
export function _reset(): void {
  processes.clear();
  shutdownCallbacks.length = 0;
}

/** Get process set reference. For test assertions only. */
export function _getProcesses(): Set<Deno.ChildProcess> {
  return processes;
}

/** Get shutdown callbacks array reference. For test assertions only. */
export function _getShutdownCallbacks(): Array<() => Promise<void> | void> {
  return shutdownCallbacks;
}
