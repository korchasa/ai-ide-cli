import { assertEquals, assertThrows } from "@std/assert";
import {
  buildCodexMcpServersArgs,
  buildOpenCodeConfigContent,
  type McpServers,
  renderClaudeMcpServers,
  validateMcpServers,
} from "./mcp-injection.ts";

Deno.test("validateMcpServers — undefined is a no-op", () => {
  validateMcpServers("claude", {});
  validateMcpServers("opencode", {});
  validateMcpServers("codex", {});
  validateMcpServers("cursor", {});
});

Deno.test("validateMcpServers — empty record throws", () => {
  assertThrows(
    () => validateMcpServers("claude", { mcpServers: {} }),
    Error,
    "mcpServers must be non-empty",
  );
});

Deno.test("validateMcpServers — empty server name throws", () => {
  const servers: McpServers = {
    "": { type: "stdio", command: "cmd" },
  };
  assertThrows(
    () => validateMcpServers("claude", { mcpServers: servers }),
    Error,
    "mcpServers entry name must be non-empty",
  );
});

Deno.test("validateMcpServers — unknown type throws", () => {
  const servers = {
    foo: { type: "ws", url: "wss://x" },
  } as unknown as McpServers;
  assertThrows(
    () => validateMcpServers("claude", { mcpServers: servers }),
    Error,
    'mcpServers.foo.type must be "stdio" | "http"',
  );
});

Deno.test("validateMcpServers — stdio requires non-empty command", () => {
  const servers = {
    foo: { type: "stdio", command: "" },
  } as unknown as McpServers;
  assertThrows(
    () => validateMcpServers("claude", { mcpServers: servers }),
    Error,
    "mcpServers.foo.command must be a non-empty string",
  );
});

Deno.test("validateMcpServers — http requires non-empty url", () => {
  const servers = {
    foo: { type: "http", url: "" },
  } as unknown as McpServers;
  assertThrows(
    () => validateMcpServers("claude", { mcpServers: servers }),
    Error,
    "mcpServers.foo.url must be a non-empty string",
  );
});

Deno.test("validateMcpServers — http accepted on every mcpInjection-capable runtime", () => {
  const servers: McpServers = {
    foo: { type: "http", url: "https://example.com/mcp" },
  };
  validateMcpServers("claude", { mcpServers: servers });
  validateMcpServers("opencode", { mcpServers: servers });
  validateMcpServers("codex", { mcpServers: servers });
  // Cursor still validates (uniform malformed-input contract) but the
  // adapter drops the field on the wire — the validator itself is
  // permissive on transport choice.
  validateMcpServers("cursor", { mcpServers: servers });
});

Deno.test("validateMcpServers — claude --mcp-config collision throws", () => {
  const servers: McpServers = {
    foo: { type: "stdio", command: "cmd" },
  };
  assertThrows(
    () =>
      validateMcpServers("claude", {
        mcpServers: servers,
        extraArgs: { "--mcp-config": "/tmp/legacy.json" },
      }),
    Error,
    `extraArgs key "--mcp-config" collides`,
  );
});

Deno.test("validateMcpServers — claude legacy --mcp-config without typed field is fine", () => {
  validateMcpServers("claude", {
    extraArgs: { "--mcp-config": "/tmp/legacy.json" },
  });
});

Deno.test("validateMcpServers — opencode env collision (non-empty) throws", () => {
  const servers: McpServers = {
    foo: { type: "stdio", command: "cmd" },
  };
  assertThrows(
    () =>
      validateMcpServers("opencode", {
        mcpServers: servers,
        env: { OPENCODE_CONFIG_CONTENT: "{}" },
      }),
    Error,
    `OPENCODE_CONFIG_CONTENT" collides`,
  );
});

Deno.test("validateMcpServers — opencode empty-string env is treated as not-set", () => {
  const servers: McpServers = {
    foo: { type: "stdio", command: "cmd" },
  };
  validateMcpServers("opencode", {
    mcpServers: servers,
    env: { OPENCODE_CONFIG_CONTENT: "" },
  });
});

Deno.test("validateMcpServers — codex stdio passes", () => {
  const servers: McpServers = {
    foo: { type: "stdio", command: "deno", args: ["run", "-A", "x.ts"] },
  };
  validateMcpServers("codex", { mcpServers: servers });
});

Deno.test("renderClaudeMcpServers — stdio + http shape", () => {
  const servers: McpServers = {
    a: { type: "stdio", command: "deno", args: ["run", "x.ts"] },
    b: {
      type: "http",
      url: "https://x/mcp",
      headers: { "X-Foo": "1" },
    },
  };
  assertEquals(renderClaudeMcpServers(servers), {
    a: { command: "deno", args: ["run", "x.ts"] },
    b: { url: "https://x/mcp", headers: { "X-Foo": "1" } },
  });
});

Deno.test("renderClaudeMcpServers — omits empty args / env / headers", () => {
  const servers: McpServers = {
    a: { type: "stdio", command: "deno", args: [], env: {} },
    b: { type: "http", url: "https://x", headers: {} },
  };
  assertEquals(renderClaudeMcpServers(servers), {
    a: { command: "deno" },
    b: { url: "https://x" },
  });
});

Deno.test("buildOpenCodeConfigContent — stdio shape uses array command and `environment`", () => {
  const servers: McpServers = {
    hitl: {
      type: "stdio",
      command: "deno",
      args: ["run", "-A", "hitl.ts"],
      env: { LEVEL: "info" },
    },
  };
  const json = buildOpenCodeConfigContent(servers);
  const parsed = JSON.parse(json) as Record<string, unknown>;
  assertEquals(parsed, {
    mcp: {
      hitl: {
        type: "local",
        command: ["deno", "run", "-A", "hitl.ts"],
        environment: { LEVEL: "info" },
        enabled: true,
      },
    },
  });
});

Deno.test("buildOpenCodeConfigContent — http renders as remote with enabled flag", () => {
  const servers: McpServers = {
    api: {
      type: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer abc" },
    },
  };
  const json = buildOpenCodeConfigContent(servers);
  const parsed = JSON.parse(json) as Record<string, unknown>;
  assertEquals(parsed, {
    mcp: {
      api: {
        type: "remote",
        url: "https://example.com/mcp",
        enabled: true,
        headers: { Authorization: "Bearer abc" },
      },
    },
  });
});

Deno.test("buildOpenCodeConfigContent — http omits empty headers", () => {
  const servers: McpServers = {
    api: { type: "http", url: "https://x", headers: {} },
  };
  const parsed = JSON.parse(
    buildOpenCodeConfigContent(servers),
  ) as Record<string, unknown>;
  assertEquals(parsed, {
    mcp: { api: { type: "remote", url: "https://x", enabled: true } },
  });
});

Deno.test("buildCodexMcpServersArgs — undefined returns []", () => {
  assertEquals(buildCodexMcpServersArgs(undefined), []);
});

Deno.test("buildCodexMcpServersArgs — emits repeating --config mcp_servers.* entries", () => {
  const servers: McpServers = {
    hitl: {
      type: "stdio",
      command: "deno",
      args: ["run", "-A", "hitl.ts"],
    },
  };
  assertEquals(buildCodexMcpServersArgs(servers), [
    "--config",
    `mcp_servers.hitl.command="deno"`,
    "--config",
    `mcp_servers.hitl.args=["run", "-A", "hitl.ts"]`,
  ]);
});

Deno.test("buildCodexMcpServersArgs — env values escape via JSON.stringify", () => {
  const servers: McpServers = {
    s: {
      type: "stdio",
      command: "x",
      env: {
        TEXT: 'a"b\nc=d\\e',
      },
    },
  };
  const argv = buildCodexMcpServersArgs(servers);
  // Only inspect the env config token.
  const envIdx = argv.findIndex((t) => t.startsWith("mcp_servers.s.env="));
  const envToken = argv[envIdx];
  // Must contain the escaped key + value pair, separated by ` = `.
  assertEquals(
    envToken,
    `mcp_servers.s.env={"TEXT" = "a\\"b\\nc=d\\\\e"}`,
  );
});

Deno.test("buildCodexMcpServersArgs — http emits --config mcp_servers.<name>.url + http_headers", () => {
  const servers: McpServers = {
    api: {
      type: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer abc" },
    },
  };
  assertEquals(buildCodexMcpServersArgs(servers), [
    "--config",
    `mcp_servers.api.url="https://example.com/mcp"`,
    "--config",
    `mcp_servers.api.http_headers={"Authorization" = "Bearer abc"}`,
  ]);
});

Deno.test("buildCodexMcpServersArgs — http without headers emits only --config url", () => {
  const servers: McpServers = {
    api: { type: "http", url: "https://x" },
  };
  assertEquals(buildCodexMcpServersArgs(servers), [
    "--config",
    `mcp_servers.api.url="https://x"`,
  ]);
});
