import { assertEquals } from "@std/assert";
import { prepareMcpConfigFile } from "./mcp.ts";
import type { McpServers } from "../runtime/mcp-injection.ts";

Deno.test("prepareMcpConfigFile — writes JSON and cleans up", async () => {
  const servers: McpServers = {
    hitl: {
      type: "stdio",
      command: "deno",
      args: ["run", "-A", "hitl.ts"],
    },
  };
  const { path, cleanup } = await prepareMcpConfigFile(servers);
  const text = await Deno.readTextFile(path);
  const parsed = JSON.parse(text) as Record<string, unknown>;
  assertEquals(parsed, {
    mcpServers: {
      hitl: { command: "deno", args: ["run", "-A", "hitl.ts"] },
    },
  });
  await cleanup();
  // After cleanup the file (and its directory) must be gone.
  let exists = true;
  try {
    await Deno.stat(path);
  } catch {
    exists = false;
  }
  assertEquals(exists, false);
});

Deno.test("prepareMcpConfigFile — cleanup is idempotent", async () => {
  const servers: McpServers = {
    s: { type: "stdio", command: "echo" },
  };
  const { cleanup } = await prepareMcpConfigFile(servers);
  await cleanup();
  await cleanup();
});
