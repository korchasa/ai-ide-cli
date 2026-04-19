import { invokeCursorCli } from "../cursor/process.ts";
import {
  type CursorSession,
  type CursorStreamEvent,
  openCursorSession,
} from "../cursor/session.ts";
import type {
  InteractiveResult,
  RuntimeAdapter,
  RuntimeSession,
  RuntimeSessionEvent,
  RuntimeSessionOptions,
} from "./types.ts";
import {
  type CapabilityInventory,
  type FetchCapabilitiesOptions,
  fetchInventoryViaInvoke,
} from "./capabilities.ts";

export const cursorRuntimeAdapter: RuntimeAdapter = {
  id: "cursor",
  capabilities: {
    permissionMode: false,
    hitl: false,
    transcript: false,
    interactive: false,
    toolUseObservation: false,
    session: true,
    capabilityInventory: true,
  },
  invoke(opts) {
    return invokeCursorCli(opts);
  },

  fetchCapabilitiesSlow(
    opts?: FetchCapabilitiesOptions,
  ): Promise<CapabilityInventory> {
    return fetchInventoryViaInvoke(
      "cursor",
      (inner) => this.invoke(inner),
      opts,
    );
  },

  async openSession(opts: RuntimeSessionOptions): Promise<RuntimeSession> {
    const wrappedOnEvent = opts.onEvent
      ? (event: CursorStreamEvent) => {
        const typeField = (event as { type?: unknown }).type;
        opts.onEvent!({
          runtime: "cursor",
          type: typeof typeField === "string" ? typeField : "unknown",
          raw: event as Record<string, unknown>,
        });
      }
      : undefined;

    const inner: CursorSession = await openCursorSession({
      systemPrompt: opts.systemPrompt,
      permissionMode: opts.permissionMode,
      resumeSessionId: opts.resumeSessionId,
      cursorArgs: opts.extraArgs,
      cwd: opts.cwd,
      env: opts.env,
      signal: opts.signal,
      onEvent: wrappedOnEvent,
      onStderr: opts.onStderr,
    });

    const events: AsyncIterable<RuntimeSessionEvent> = {
      async *[Symbol.asyncIterator]() {
        for await (const event of inner.events) {
          const raw = event as Record<string, unknown>;
          const typeField = raw["type"];
          yield {
            runtime: "cursor",
            type: typeof typeField === "string" ? typeField : "unknown",
            raw,
          };
        }
      },
    };

    return {
      runtime: "cursor",
      get pid() {
        return inner.pid;
      },
      send: (content: string) => inner.send(content),
      events,
      endInput: () => inner.endInput(),
      abort: (reason) => inner.abort(reason),
      done: inner.done.then((status) => ({
        exitCode: status.exitCode,
        signal: status.signal,
        stderr: status.stderr,
      })),
    };
  },

  launchInteractive(): Promise<InteractiveResult> {
    throw new Error(
      "Cursor has no interactive CLI mode — use Cursor IDE directly",
    );
  },
};
