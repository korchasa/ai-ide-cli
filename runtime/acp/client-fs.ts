/**
 * @module
 * Client-side filesystem for ACP sessions (FR-L56).
 *
 * ACP lets the agent delegate file reads and writes to the client
 * (`fs/read_text_file`, `fs/write_text_file`) once the client declares
 * the capability in `initialize`. The library declines it unless the
 * caller sets `acpClientFs`; when set, it serves both methods with two
 * rules the protocol leaves to the client:
 *
 * - A relative path is anchored to the session cwd, never to the
 *   consumer's own working directory. The spec asks for absolute paths,
 *   but fronts do send relative ones, and resolving them against the
 *   wrong root reads or writes the wrong tree.
 * - A write must land inside `writeRoot`. Anything else is refused with
 *   an error, so a sandboxed agent cannot reach the caller's files
 *   through the client.
 */

import { isAbsolute, join, normalize, resolve } from "@std/path";

/** Caller opt-in for the client-side filesystem. */
export interface AcpClientFsOptions {
  /**
   * Directory every `fs/write_text_file` must resolve inside. Reads are
   * not confined: the agent reads its own tree through its own tools
   * anyway, and confining only the client path would protect nothing.
   */
  writeRoot: string;
}

/**
 * Anchor `path` to `cwd` when it is relative; normalise it otherwise.
 *
 * @param cwd Session working directory.
 * @param path Path as the agent sent it.
 */
export function resolveClientFsPath(cwd: string, path: string): string {
  if (isAbsolute(path)) return normalize(path);
  return join(resolve(cwd), path);
}

/**
 * Resolve a write target and refuse it outside `writeRoot`.
 *
 * @param writeRoot Directory writes must stay inside.
 * @param cwd Session working directory (anchors a relative path).
 * @param path Path as the agent sent it.
 * @throws Error naming both paths when the target escapes `writeRoot`.
 */
export function confineClientFsWrite(
  writeRoot: string,
  cwd: string,
  path: string,
): string {
  const target = resolveClientFsPath(cwd, path);
  const root = resolve(writeRoot);
  if (target !== root && !target.startsWith(`${root}/`)) {
    throw new Error(
      `client fs: refusing to write ${target} — outside writeRoot ${root}`,
    );
  }
  return target;
}

/** Inbound fs methods this module serves. */
export const CLIENT_FS_METHODS: readonly string[] = [
  "fs/read_text_file",
  "fs/write_text_file",
];

/**
 * Serve one inbound fs request.
 *
 * `fs/read_text_file` honours the optional 1-based `line` and `limit`
 * the protocol defines; `fs/write_text_file` creates missing parent
 * directories, as an editor saving a new file would.
 *
 * @param method `fs/read_text_file` or `fs/write_text_file`.
 * @param params Request params (`path`, `content`, `line`, `limit`).
 * @param ctx Session cwd and the caller's `writeRoot`.
 */
export async function serveClientFs(
  method: string,
  params: Record<string, unknown>,
  ctx: { cwd: string; writeRoot: string },
): Promise<Record<string, unknown>> {
  const path = String(params["path"] ?? "");
  if (method === "fs/read_text_file") {
    const text = await Deno.readTextFile(resolveClientFsPath(ctx.cwd, path));
    const line = typeof params["line"] === "number"
      ? params["line"]
      : undefined;
    const limit = typeof params["limit"] === "number"
      ? params["limit"]
      : undefined;
    if (line === undefined && limit === undefined) return { content: text };
    const lines = text.split("\n");
    const start = Math.max(0, (line ?? 1) - 1);
    const end = limit === undefined ? lines.length : start + limit;
    return { content: lines.slice(start, end).join("\n") };
  }
  const target = confineClientFsWrite(ctx.writeRoot, ctx.cwd, path);
  await Deno.mkdir(join(target, ".."), { recursive: true });
  await Deno.writeTextFile(target, String(params["content"] ?? ""));
  return {};
}
