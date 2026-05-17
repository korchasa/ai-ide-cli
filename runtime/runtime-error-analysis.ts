/**
 * @module
 * Pure runtime-error classifier built from captured CLI output fixtures
 * (FR-L37). It does not spawn subprocesses, read files, or change adapter
 * behavior; adapters may feed stdout / stderr / event / log fragments into it
 * in a follow-up integration step.
 */

import type { RuntimeId } from "../types.ts";

// FR-L37
/**
 * Runtime-neutral class of a detected runtime failure.
 */
export type RuntimeErrorKind =
  | "quota"
  | "rate_limit"
  | "context_window"
  | "token_budget"
  | "auth"
  | "policy"
  | "plan_limit"
  | "runtime_error";

// FR-L37
/** Source stream or payload kind used for runtime-error analysis. */
export type RuntimeErrorSource =
  | "stdout"
  | "stderr"
  | "event"
  | "log"
  | "error_string";

// FR-L37
/** Confidence level of a runtime-error classification. */
export type RuntimeErrorConfidence = "high" | "medium" | "low";

// FR-L37
/** Input accepted by {@link analyzeRuntimeErrorSignal}. */
export interface RuntimeErrorAnalysisInput {
  /** Runtime that emitted the signal, when known. */
  runtime?: RuntimeId;
  /** Source stream or payload being classified. */
  source: RuntimeErrorSource;
  /** Raw text captured from stdout, stderr, a log line, or an error string. */
  text?: string;
  /** Raw event payload. Used when runtimes expose errors as structured events. */
  event?: Record<string, unknown>;
  /**
   * Set by adapters only after they already know this is a runtime failure.
   * The analyzer then returns `kind: "runtime_error"` for unrecognized text
   * instead of `undefined`.
   */
  assumeRuntimeError?: boolean;
}

// FR-L37
/**
 * Structured result returned when a captured signal is classified as a
 * runtime failure.
 */
export interface RuntimeErrorAnalysis {
  /** Runtime that emitted the signal, when supplied by the caller. */
  runtime?: RuntimeId;
  /** Source stream or payload that carried the signal. */
  source: RuntimeErrorSource;
  /** Runtime-neutral class of the signal. */
  kind: RuntimeErrorKind;
  /** Classifier confidence; adapter integration should prefer high/medium. */
  confidence: RuntimeErrorConfidence;
  /** HTTP status code when the signal carried one. */
  statusCode?: number;
  /** Provider-specific error code when present in the captured payload. */
  providerCode?: string;
  /** Human-readable provider/runtime message. */
  message: string;
  /** Reset timestamp as emitted by the provider, normalized only for spacing. */
  resetAt?: string;
  /** Retry-after delay in seconds when unambiguously present. */
  retryAfterSeconds?: number;
}

// FR-L37
/**
 * Classify a captured runtime failure signal.
 *
 * Returns `undefined` for malformed input, ordinary text, and ambiguous text
 * unless `assumeRuntimeError` is set. The function records facts found in the
 * signal but does not decide retry policy or mutate adapter results.
 */
export function analyzeRuntimeErrorSignal(
  input: RuntimeErrorAnalysisInput,
): RuntimeErrorAnalysis | undefined {
  const text = collectText(input);
  if (!text) return undefined;

  const statusCode = extractStatusCode(text);
  const message = extractMessage(text) ?? text.trim();
  if (!message) return undefined;

  const kind = classifyMessage(message, statusCode) ??
    (input.assumeRuntimeError ? "runtime_error" : undefined);
  if (!kind) return undefined;

  const result: RuntimeErrorAnalysis = {
    ...(input.runtime ? { runtime: input.runtime } : {}),
    source: input.source,
    kind,
    confidence: confidenceFor(kind, statusCode),
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...optionalString("providerCode", extractProviderCode(text)),
    message,
    ...optionalString("resetAt", extractResetAt(message)),
    ...optionalNumber("retryAfterSeconds", extractRetryAfterSeconds(message)),
  };
  return result;
}

function collectText(input: RuntimeErrorAnalysisInput): string {
  const parts: string[] = [];
  if (input.text?.trim()) parts.push(input.text);
  if (input.event) {
    const eventText = extractEventText(input.event);
    if (eventText) parts.push(eventText);
  }
  return parts.join("\n").trim();
}

function extractEventText(event: Record<string, unknown>): string {
  const messages: string[] = [];
  collectEventMessages(event, messages, 0);
  return messages.join("\n").trim();
}

function collectEventMessages(
  value: unknown,
  messages: string[],
  depth: number,
): void {
  if (depth > 4 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectEventMessages(item, messages, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["message", "error", "details", "reason"]) {
    const field = record[key];
    if (typeof field === "string" && field.trim()) {
      messages.push(field.trim());
    } else {
      collectEventMessages(field, messages, depth + 1);
    }
  }
}

function extractStatusCode(text: string): number | undefined {
  const match = /"statusCode"\s*:\s*(\d{3})|status\s+(\d{3})/i.exec(text);
  const raw = match?.[1] ?? match?.[2];
  if (!raw) return undefined;
  const code = Number(raw);
  return Number.isInteger(code) ? code : undefined;
}

function extractMessage(text: string): string | undefined {
  const statusIndex = text.search(/"statusCode"\s*:\s*\d{3}/);
  const scoped = statusIndex >= 0 ? text.slice(statusIndex) : text;
  const quoted = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(scoped);
  if (quoted?.[1]) return decodeJsonishString(quoted[1]).trim();
  const trimmed = text.trim();
  return trimmed || undefined;
}

function extractProviderCode(text: string): string | undefined {
  const statusIndex = text.search(/"statusCode"\s*:\s*\d{3}/);
  const scoped = statusIndex >= 0 ? text.slice(statusIndex) : text;
  const match = /"code"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(scoped);
  return match?.[1] ? decodeJsonishString(match[1]).trim() : undefined;
}

function decodeJsonishString(value: string): string {
  return value
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
    .replace(/\\n/g, " ")
    .replace(/\\t/g, " ");
}

function classifyMessage(
  message: string,
  statusCode?: number,
): RuntimeErrorKind | undefined {
  const normalized = message.toLowerCase();
  if (
    statusCode === 401 || /invalid api key|not logged in|unauthori[sz]ed/
      .test(normalized)
  ) {
    return "auth";
  }
  if (
    statusCode === 403 ||
    /access denied|permission denied|blocked by policy|denied by policy/.test(
      normalized,
    )
  ) {
    return "policy";
  }
  if (
    /context (length|window).*exceed|exceed.*context (length|window)|maximum context/
      .test(
        normalized,
      )
  ) {
    return "context_window";
  }
  if (
    /token budget|output token.*exceed|maximum .*tokens.*exceed|too many tokens/
      .test(normalized)
  ) {
    return "token_budget";
  }
  if (
    /rate limit|too many requests|retry after|try again later/.test(normalized)
  ) {
    return "rate_limit";
  }
  if (
    /named models unavailable|free plans can only use auto|switch to auto or upgrade|upgrade plans? to continue|plan required/
      .test(normalized)
  ) {
    return "plan_limit";
  }
  if (
    statusCode === 402 ||
    /usage limit|quota exceeded|quota exhausted|insufficient credits|credit balance|billing limit/
      .test(normalized)
  ) {
    return "quota";
  }
  if (statusCode === 429) return "runtime_error";
  return undefined;
}

function confidenceFor(
  kind: RuntimeErrorKind,
  statusCode?: number,
): RuntimeErrorConfidence {
  if (statusCode !== undefined) return "high";
  if (kind === "plan_limit") return "high";
  return kind === "runtime_error" ? "low" : "medium";
}

function extractResetAt(message: string): string | undefined {
  const match =
    /reset(?:s|ting)?(?:\s+\w+){0,3}\s+at\s+([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}(?::[0-9]{2})?)/i
      .exec(message);
  return match?.[1]?.replace("T", " ");
}

function extractRetryAfterSeconds(message: string): number | undefined {
  const match =
    /retry\s+(?:after|in)\s+(\d+)\s*(second|seconds|sec|secs|minute|minutes|min|mins)?/i
      .exec(message);
  if (!match?.[1]) return undefined;
  const count = Number(match[1]);
  if (!Number.isInteger(count)) return undefined;
  const unit = (match[2] ?? "seconds").toLowerCase();
  return unit.startsWith("min") ? count * 60 : count;
}

function optionalString<K extends string>(
  key: K,
  value: string | undefined,
): { [P in K]?: string } {
  return value ? { [key]: value } as { [P in K]?: string } : {};
}

function optionalNumber<K extends string>(
  key: K,
  value: number | undefined,
): { [P in K]?: number } {
  return value !== undefined ? { [key]: value } as { [P in K]?: number } : {};
}
