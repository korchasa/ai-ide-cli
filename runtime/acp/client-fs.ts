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
 *   through the client. Containment is checked on real paths, so a
 *   symlink inside `writeRoot` that points outside cannot carry a write
 *   out, and a target that is itself a symlink is refused. The content
 *   goes to a fresh temp file beside the target and is renamed over it,
 *   so a hard link inside `writeRoot` to an outside file is replaced,
 *   never written through.
 */

import {
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from "@std/path";

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

function isStrictlyInside(root: string, target: string): boolean {
  return target.startsWith(`${root}/`);
}

async function lstatOrNull(path: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.lstat(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}

/**
 * Real path of `path` when parts of it do not exist yet: resolve the
 * deepest existing ancestor through `Deno.realPath` and append the
 * missing tail, which `mkdir` will create as plain directories.
 */
async function realPathOfDeepestExisting(path: string): Promise<string> {
  let existing = path;
  while ((await lstatOrNull(existing)) === null) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  try {
    return join(await Deno.realPath(existing), relative(existing, path));
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new Error(
        `client fs: refusing to write ${path} — ${existing} is a dangling symbolic link`,
      );
    }
    throw e;
  }
}

/**
 * Resolve a write target and refuse it outside `writeRoot`. The target
 * must lie strictly inside: `writeRoot` itself is not a file to write,
 * and the temp file beside it would land in its parent.
 *
 * The lexical check runs first; then both `writeRoot` and the target's
 * deepest existing ancestor are resolved to real paths and compared
 * again, so a symlink inside `writeRoot` cannot point the write outside.
 * A target that is itself a symlink (dangling or not) is refused: the
 * write would follow it. The check and the write are separate syscalls,
 * so a process that swaps an intermediate directory for a symlink
 * between them can still race it; the final component cannot, because
 * {@link serveClientFs} renames a fresh file over it.
 *
 * @param writeRoot Directory writes must stay inside.
 * @param cwd Session working directory (anchors a relative path).
 * @param path Path as the agent sent it.
 * @throws Error naming both paths when the target escapes `writeRoot`,
 *   or naming the target when it is a symlink.
 */
export async function confineClientFsWrite(
  writeRoot: string,
  cwd: string,
  path: string,
): Promise<string> {
  const target = resolveClientFsPath(cwd, path);
  const root = resolve(writeRoot);
  if (!isStrictlyInside(root, target)) {
    throw new Error(
      `client fs: refusing to write ${target} — outside writeRoot ${root}`,
    );
  }
  if ((await lstatOrNull(target))?.isSymlink) {
    throw new Error(
      `client fs: refusing to write ${target} — it is a symbolic link`,
    );
  }
  const realRoot = await realPathOfDeepestExisting(root);
  const realTarget = await realPathOfDeepestExisting(target);
  if (!isStrictlyInside(realRoot, realTarget)) {
    throw new Error(
      `client fs: refusing to write ${target} — resolves to ${realTarget}, outside writeRoot ${realRoot}`,
    );
  }
  return target;
}

/**
 * Write `content` to `target` without writing through what is there:
 * create a sibling temp file with exclusive-create (which never follows
 * a symlink) and rename it over `target`. A hard link at `target` loses
 * its directory entry instead of having the shared inode rewritten.
 *
 * The temp file is created with its final mode, so its content is never
 * more readable than the old file: the old permission bits (`0o777`
 * only — setuid, setgid and sticky are dropped), narrowed by the umask;
 * `0o666` narrowed by the umask for a new file. Deno has no `fchmod`,
 * and a path-based chmod on a name in an agent-writable directory could
 * be redirected, so the mode is never changed after creation.
 */
async function replaceFile(target: string, content: string): Promise<void> {
  const previous = await lstatOrNull(target);
  const mode = previous?.mode != null ? previous.mode & 0o777 : 0o666;
  const temp = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    await Deno.writeTextFile(temp, content, { createNew: true, mode });
    await Deno.rename(temp, target);
  } catch (e) {
    await Deno.remove(temp).catch(() => {});
    throw e;
  }
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
 * directories, as an editor saving a new file would, and replaces the
 * target with a new file (permission bits kept, special bits dropped)
 * rather than writing into the existing one.
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
  const target = await confineClientFsWrite(ctx.writeRoot, ctx.cwd, path);
  await Deno.mkdir(join(target, ".."), { recursive: true });
  await replaceFile(target, String(params["content"] ?? ""));
  return {};
}
