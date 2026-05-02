/**
 * @module
 * Stdout / stderr pump helpers and the small parser/decoder used by
 * {@link import("./session.ts").openCursorSession}'s per-send subprocess
 * loop. Split out of `cursor/session.ts` to keep the worker module focused
 * on lifecycle.
 */

import {
  type OnCallbackError,
  safeInvokeCallback,
} from "../runtime/callback-safety.ts";
import type { SessionEventQueue } from "../runtime/event-queue.ts";
import type { CursorStreamEvent } from "./stream.ts";

/**
 * Drain a subprocess stdout stream, splitting on newlines, parsing each line
 * as a {@link CursorStreamEvent}, and pushing into the shared queue. The
 * optional `onEvent` callback is fired for each parsed event with throws
 * routed via {@link OnCallbackError}.
 */
export async function pumpCursorStdout(
  stream: ReadableStream<Uint8Array>,
  queue: SessionEventQueue<CursorStreamEvent>,
  onEvent: ((event: CursorStreamEvent) => void) | undefined,
  onCallbackError: OnCallbackError | undefined,
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
        const event = safeParseCursorEvent(line);
        if (!event) continue;
        queue.push(event);
        // FR-L32: route consumer-callback throws to onCallbackError.
        safeInvokeCallback(onEvent, [event], "onEvent", onCallbackError);
      }
    }
    if (buffer.trim()) {
      const event = safeParseCursorEvent(buffer);
      if (event) {
        queue.push(event);
        // FR-L32: same routing for the trailing partial line.
        safeInvokeCallback(onEvent, [event], "onEvent", onCallbackError);
      }
    }
  } catch {
    // Reader closed mid-read — worker loop handles finalization.
  }
}

/**
 * Drain a subprocess stderr stream, accumulating raw bytes for terminal
 * status and forwarding decoded lines to `onStderr` with throws routed via
 * {@link OnCallbackError}.
 */
export async function pumpCursorStderr(
  stream: ReadableStream<Uint8Array>,
  sink: Uint8Array[],
  onStderr: ((line: string) => void) | undefined,
  onCallbackError: OnCallbackError | undefined,
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
        // FR-L32: route consumer-callback throws to onCallbackError.
        safeInvokeCallback(onStderr, [line], "onStderr", onCallbackError);
      }
    }
    if (buffer.length > 0) {
      // FR-L32: same routing for the trailing partial line.
      safeInvokeCallback(onStderr, [buffer], "onStderr", onCallbackError);
    }
  } catch {
    // stream closed
  }
}

function safeParseCursorEvent(line: string): CursorStreamEvent | undefined {
  try {
    return JSON.parse(line) as CursorStreamEvent;
  } catch {
    return undefined;
  }
}

/** Concatenate captured byte chunks into a trimmed UTF-8 string. */
export function decodeConcat(chunks: Uint8Array[]): string {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(buf).trim();
}
