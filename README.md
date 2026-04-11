# @korchasa/ai-ide-cli

Thin wrapper around agent-CLI binaries (Claude Code, OpenCode). Normalizes
invocation, NDJSON event parsing, retry, session resume, and HITL tool
wiring. Runtime-neutral output shape (`CliRunOutput`) lets downstream code
treat Claude and OpenCode interchangeably.

Split out from [`@korchasa/flowai-workflow`](https://jsr.io/@korchasa/flowai-workflow)
so consumers that need only the CLI wrapper can depend on a small,
focused package without pulling the full DAG workflow engine.

## Install

```sh
deno add jsr:@korchasa/ai-ide-cli
```

## Usage — Claude

```ts
import { invokeClaudeCli } from "jsr:@korchasa/ai-ide-cli/claude/process";

const { output, error } = await invokeClaudeCli({
  taskPrompt: "Write a haiku about TypeScript.",
  timeoutSeconds: 60,
  maxRetries: 3,
  retryDelaySeconds: 5,
  onOutput: (line) => console.log(line),
});

if (error) throw new Error(error);
console.log(output?.result);
```

## Usage — OpenCode

```ts
import { invokeOpenCodeCli } from "jsr:@korchasa/ai-ide-cli/opencode/process";

const { output } = await invokeOpenCodeCli({
  taskPrompt: "List the files in the current directory.",
  timeoutSeconds: 60,
  maxRetries: 3,
  retryDelaySeconds: 5,
});

console.log(output?.result);
```

## Usage — Runtime Adapter (uniform dispatch)

```ts
import { getRuntimeAdapter } from "jsr:@korchasa/ai-ide-cli/runtime";

const adapter = getRuntimeAdapter("claude");
const { output, error } = await adapter.invoke({
  taskPrompt: "Explain React hooks in two sentences.",
  timeoutSeconds: 60,
  maxRetries: 1,
  retryDelaySeconds: 1,
});
```

## HITL MCP self-spawn contract

OpenCode runs a stdio MCP server for Human-in-the-Loop. The library does NOT
ship a binary — it exposes the MCP handler
(`runOpenCodeHitlMcpServer` from `jsr:@korchasa/ai-ide-cli/opencode/hitl-mcp`)
and requires the consumer to supply a zero-argument callback that returns
the `argv` for spawning that handler in a sub-process.

```ts
import { runOpenCodeHitlMcpServer } from "jsr:@korchasa/ai-ide-cli/opencode/hitl-mcp";
import { invokeOpenCodeCli } from "jsr:@korchasa/ai-ide-cli/opencode/process";

// 1. In your CLI entry point, dispatch the internal flag:
if (Deno.args.includes("--internal-opencode-hitl-mcp")) {
  await runOpenCodeHitlMcpServer();
  Deno.exit(0);
}

// 2. When invoking OpenCode with HITL enabled, pass the builder:
await invokeOpenCodeCli({
  taskPrompt: "...",
  timeoutSeconds: 60,
  maxRetries: 1,
  retryDelaySeconds: 1,
  hitlConfig: {
    ask_script: "ask.sh",
    check_script: "check.sh",
    poll_interval: 60,
    timeout: 7200,
  },
  hitlMcpCommandBuilder: () => [
    Deno.execPath(),
    "run",
    "-A",
    new URL("./my-cli.ts", import.meta.url).pathname,
    "--internal-opencode-hitl-mcp",
  ],
});
```

If `hitlConfig` is set but `hitlMcpCommandBuilder` is omitted, the library
throws at invocation time with an explicit error.

## Reference consumer

[`@korchasa/flowai-workflow`](https://jsr.io/@korchasa/flowai-workflow) —
a DAG workflow engine. Its `engine/agent.ts` wires `hitlMcpCommandBuilder`
to the engine binary's own `--internal-opencode-hitl-mcp` flag and is the
recommended reference for building a consumer binary.

## Scope

This package is deliberately minimal:
- No DAG / workflow logic
- No git / GitHub / PR operations
- No configuration file parsing
- No runtime-specific stream parsers exposed from the root entry point
  (Claude stream helpers are available on the sub-path
  `jsr:@korchasa/ai-ide-cli/claude/stream` for callers that need them)
