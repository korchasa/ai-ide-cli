/**
 * @module
 * Shared types, validation, and rendering for the typed `mcpServers` option
 * on {@link RuntimeInvokeOptions} / {@link RuntimeSessionOptions} (FR-L35).
 *
 * Every adapter that supports MCP injection (Claude, OpenCode, Codex) calls
 * the shared {@link validateMcpServers} synchronously before dispatch and
 * delegates the wire shape to one of the per-runtime renderers
 * ({@link renderClaudeMcpServers}, {@link buildOpenCodeConfigContent},
 * {@link buildCodexMcpServersArgs}). Cursor validates uniformly, warns once,
 * and drops the spec on the wire.
 *
 * Design mirrors `runtime/tool-filter.ts` (FR-L24) and
 * `runtime/reasoning-effort.ts` (FR-L25): single validator entry point with
 * runtime-specific collision rules, throws synchronously on misuse so YAML
 * consumers see uniform errors regardless of runtime.
 */

import type { RuntimeId } from "../types.ts";
import type { ExtraArgsMap } from "./adapter-types.ts";

// FR-L35
/** Stdio-transport MCP server descriptor. */
export interface McpStdioServer {
  /** Stdio transport discriminator. */
  type: "stdio";
  /** Executable path or PATH-resolved binary name. */
  command: string;
  /** Argv passed to the executable (positional, no quoting). */
  args?: string[];
  /** Environment variables merged into the MCP server subprocess. */
  env?: Record<string, string>;
}

// FR-L35
/** HTTP/SSE-transport MCP server descriptor. */
export interface McpHttpServer {
  /** HTTP transport discriminator. */
  type: "http";
  /** Endpoint URL (https or http). */
  url: string;
  /** Headers attached to every MCP request. */
  headers?: Record<string, string>;
}

// FR-L35
/** Discriminated union of supported MCP server transports. */
export type McpServerSpec = McpStdioServer | McpHttpServer;

// FR-L35
/**
 * Map of named MCP servers to register for one invocation.
 *
 * Keys are server names (referenced by tools the agent surfaces, e.g.
 * `<name>.<tool>`). Values describe the transport — see {@link McpServerSpec}.
 */
export type McpServers = Record<string, McpServerSpec>;

/** Subset of invocation / session options relevant to {@link validateMcpServers}. */
export interface ValidateMcpServersInput {
  /** Typed servers spec under validation. */
  mcpServers?: McpServers;
  /** Caller-provided extraArgs (Claude collision detection). */
  extraArgs?: ExtraArgsMap;
  /** Caller-provided env (OpenCode collision detection). */
  env?: Record<string, string>;
}

// FR-L35
/**
 * Validate the typed `mcpServers` field synchronously.
 *
 * Contract (uniform across adapters — catches malformed input even on
 * runtimes whose adapter ignores the wire output, e.g. Cursor):
 *
 * - `undefined` → no-op.
 * - Empty record (`{}`) → throw.
 * - Empty server name (`""`) → throw.
 * - `type` outside `"stdio" | "http"` → throw.
 * - Stdio entry with empty `command` → throw.
 * - HTTP entry with empty `url` → throw.
 * - Claude only: `extraArgs?.["--mcp-config"]` set when `mcpServers` is set
 *   → throw (collision with the typed field).
 * - OpenCode only: non-empty `env?.["OPENCODE_CONFIG_CONTENT"]` when
 *   `mcpServers` is set → throw. Empty-string is treated as "not set" and
 *   the adapter overwrites it.
 *
 * **HTTP transport is supported on every runtime with
 * `capabilities.mcpInjection: true`** (Claude / OpenCode / Codex). The
 * codex-cli ≥ 0.124 release added native `mcp_servers.<name>.url`
 * support; OpenCode's `{type: "remote"}` shape has been stable since
 * the SSE-config schema landed. Cursor remains capability-flagged off.
 *
 * @param runtime Runtime identifier (used in error messages for attribution).
 * @param opts Options subset carrying the typed field, `extraArgs`, and `env`.
 */
export function validateMcpServers(
  runtime: RuntimeId,
  opts: ValidateMcpServersInput,
): void {
  const servers = opts.mcpServers;
  if (servers === undefined) return;

  const names = Object.keys(servers);
  if (names.length === 0) {
    throw new Error(
      `${runtime}: mcpServers must be non-empty when set`,
    );
  }

  for (const name of names) {
    if (name.length === 0) {
      throw new Error(
        `${runtime}: mcpServers entry name must be non-empty`,
      );
    }
    const spec = servers[name];
    if (!spec || typeof spec !== "object") {
      throw new Error(
        `${runtime}: mcpServers.${name} must be an object`,
      );
    }
    if (spec.type === "stdio") {
      if (typeof spec.command !== "string" || spec.command.length === 0) {
        throw new Error(
          `${runtime}: mcpServers.${name}.command must be a non-empty string`,
        );
      }
    } else if (spec.type === "http") {
      if (typeof spec.url !== "string" || spec.url.length === 0) {
        throw new Error(
          `${runtime}: mcpServers.${name}.url must be a non-empty string`,
        );
      }
    } else {
      throw new Error(
        `${runtime}: mcpServers.${name}.type must be "stdio" | "http" (got ${
          JSON.stringify((spec as { type?: unknown }).type)
        })`,
      );
    }
  }

  if (runtime === "claude") {
    if (opts.extraArgs && "--mcp-config" in opts.extraArgs) {
      throw new Error(
        `claude: extraArgs key "--mcp-config" collides with typed mcpServers — remove one`,
      );
    }
  }
  if (runtime === "opencode") {
    const existing = opts.env?.["OPENCODE_CONFIG_CONTENT"];
    if (typeof existing === "string" && existing.length > 0) {
      throw new Error(
        `opencode: env "OPENCODE_CONFIG_CONTENT" collides with typed mcpServers — remove one`,
      );
    }
  }
}

// FR-L35
/**
 * Render `mcpServers` into the JSON shape Claude's `--mcp-config` file
 * expects: `{<name>: {command, args?, env?} | {url, headers?}}`. Returned
 * value is a plain JS object suitable for `JSON.stringify`.
 */
export function renderClaudeMcpServers(
  servers: McpServers,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(servers)) {
    if (spec.type === "stdio") {
      const entry: Record<string, unknown> = { command: spec.command };
      if (spec.args && spec.args.length > 0) entry.args = spec.args;
      if (spec.env && Object.keys(spec.env).length > 0) entry.env = spec.env;
      out[name] = entry;
    } else {
      const entry: Record<string, unknown> = { url: spec.url };
      if (spec.headers && Object.keys(spec.headers).length > 0) {
        entry.headers = spec.headers;
      }
      out[name] = entry;
    }
  }
  return out;
}

// FR-L35
/**
 * Render `mcpServers` into the JSON string used as
 * `OPENCODE_CONFIG_CONTENT` env var, in OpenCode's native shape:
 *
 * - stdio entries: `{type: "local", command: [cmd, …args], environment?, enabled: true}`
 * - http entries:  `{type: "remote", url, headers?, enabled: true}`
 *
 * **Merge, not replacement.** Per upstream OpenCode docs, the layered
 * config sources (global → project → `OPENCODE_CONFIG_CONTENT` →
 * `OPENCODE_CONFIG`) are merged together; later layers override only
 * the conflicting keys. The user's `~/.config/opencode/opencode.json`
 * is NOT wiped — auth providers, agents, model routing, and any MCP
 * servers the user defined themselves all survive. Same-named entries
 * in this rendered config win on conflict; siblings are preserved.
 *
 * Field-name and shape verified against the upstream OpenCode SSE
 * schema (FR-L27): `command` is an array (not a single string),
 * environment-variable map is named `environment` (not `env` /
 * `envvars`), HTTP entries use `headers` (not `http_headers`), and
 * every entry needs an explicit `enabled: true`.
 */
export function buildOpenCodeConfigContent(servers: McpServers): string {
  const mcp: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(servers)) {
    if (spec.type === "stdio") {
      const entry: Record<string, unknown> = {
        type: "local",
        command: [spec.command, ...(spec.args ?? [])],
        enabled: true,
      };
      if (spec.env && Object.keys(spec.env).length > 0) {
        entry.environment = spec.env;
      }
      mcp[name] = entry;
    } else {
      const entry: Record<string, unknown> = {
        type: "remote",
        url: spec.url,
        enabled: true,
      };
      if (spec.headers && Object.keys(spec.headers).length > 0) {
        entry.headers = spec.headers;
      }
      mcp[name] = entry;
    }
  }
  return JSON.stringify({ mcp });
}

// FR-L35
/**
 * Render `mcpServers` into the repeated `--config mcp_servers.<name>.*`
 * argv tokens Codex's `--config` overrides accept on both
 * `codex exec` and `codex app-server`.
 *
 * Codex discriminates the transport by which keys are present (no
 * explicit `type` field):
 *
 * - stdio: `mcp_servers.<name>.command="<cmd>"`,
 *   `mcp_servers.<name>.args=[…]`, `mcp_servers.<name>.env={…}`
 * - http (codex-cli ≥ 0.124): `mcp_servers.<name>.url="<url>"`,
 *   `mcp_servers.<name>.http_headers={…}`
 *
 * TOML inline-table escaping uses `JSON.stringify` so values containing
 * newlines, equals signs, double quotes, and backslashes round-trip
 * without ambiguity. Headers passed via `headers` on the typed spec
 * map to Codex's `http_headers` key.
 */
export function buildCodexMcpServersArgs(
  servers: McpServers | undefined,
): string[] {
  if (!servers) return [];
  const out: string[] = [];
  for (const [name, spec] of Object.entries(servers)) {
    const prefix = `mcp_servers.${name}`;
    if (spec.type === "stdio") {
      out.push("--config", `${prefix}.command=${JSON.stringify(spec.command)}`);
      if (spec.args && spec.args.length > 0) {
        const args = spec.args.map((a) => JSON.stringify(a)).join(", ");
        out.push("--config", `${prefix}.args=[${args}]`);
      }
      if (spec.env && Object.keys(spec.env).length > 0) {
        const entries = Object.entries(spec.env)
          .map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`)
          .join(", ");
        out.push("--config", `${prefix}.env={${entries}}`);
      }
    } else {
      out.push("--config", `${prefix}.url=${JSON.stringify(spec.url)}`);
      if (spec.headers && Object.keys(spec.headers).length > 0) {
        const entries = Object.entries(spec.headers)
          .map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`)
          .join(", ");
        out.push("--config", `${prefix}.http_headers={${entries}}`);
      }
    }
  }
  return out;
}
