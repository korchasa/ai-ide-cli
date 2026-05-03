/**
 * @module
 * Claude-specific tmp-file lifecycle for the typed `mcpServers` option
 * (FR-L35).
 *
 * Claude's `--mcp-config <path>` flag points at a JSON file describing the
 * MCP servers to register. The library writes the rendered shape to a fresh
 * temporary directory under `Deno.makeTempDir({prefix:"claude-mcp-"})`, hands
 * the path to the runner, and reaps the directory in the runner's `finally`
 * chain (success / retry / abort / crash all converge there). Mirrors the
 * shape of `runtime/setting-sources.ts:prepareSettingSourcesDir`.
 */

import { join } from "@std/path";
import {
  type McpServers,
  renderClaudeMcpServers,
} from "../runtime/mcp-injection.ts";

/** Result handle returned by {@link prepareMcpConfigFile}. */
export interface PrepareMcpConfigResult {
  /** Absolute path to the rendered `mcp.json` file. */
  path: string;
  /** Idempotent cleanup — removes the temp directory and its contents. */
  cleanup: () => Promise<void>;
}

// FR-L35
/**
 * Render `servers` into a temporary `mcp.json` Claude can consume via
 * `--mcp-config`. Caller is responsible for invoking the returned `cleanup`
 * in a `finally` block.
 */
export async function prepareMcpConfigFile(
  servers: McpServers,
): Promise<PrepareMcpConfigResult> {
  const dir = await Deno.makeTempDir({ prefix: "claude-mcp-" });
  const path = join(dir, "mcp.json");
  const payload = JSON.stringify({
    mcpServers: renderClaudeMcpServers(servers),
  });
  await Deno.writeTextFile(path, payload);
  let cleaned = false;
  return {
    path,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      try {
        await Deno.remove(dir, { recursive: true });
      } catch {
        // best-effort cleanup
      }
    },
  };
}
