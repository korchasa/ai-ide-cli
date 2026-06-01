/**
 * @module
 * FR-L39 e2e retry harness — a thin ACP-front wrapper that fails the
 * first invocation with a JSON-RPC `-32603` error on `initialize`, then
 * forwards every subsequent invocation to the real wrapped front. Spawn
 * count is persisted in a counter file so the second `Deno.Command`
 * spawned by `invokeViaAcp`'s retry loop sees the bumped value and
 * goes through to the real binary.
 *
 * Usage:
 *
 *   deno run -A e2e/_acp_retry_wrapper.ts \
 *     --counter /tmp/acp-retry-counter \
 *     -- npx -y @agentclientprotocol/claude-agent-acp@0.37.0
 *
 * Pure: side effects are limited to the counter file + child-process
 * stdio inheritance on attempt 2+. Not part of the published package
 * (lives under `e2e/`).
 */

interface ParsedArgs {
  counter: string;
  cmd: string;
  args: string[];
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let counter: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--counter") {
      counter = argv[i + 1];
      i += 2;
      continue;
    }
    if (a === "--") {
      i += 1;
      break;
    }
    throw new Error(`unexpected arg: ${a}`);
  }
  if (!counter) throw new Error("missing --counter <path>");
  const rest = argv.slice(i);
  if (rest.length === 0) throw new Error("missing wrapped command after --");
  return { counter, cmd: rest[0], args: rest.slice(1) };
}

async function readOneJsonLine(): Promise<Record<string, unknown> | null> {
  const decoder = new TextDecoder();
  let buf = "";
  const reader = Deno.stdin.readable.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: true });
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        if (line.length > 0) return JSON.parse(line);
        buf = buf.slice(nl + 1);
        continue;
      }
      if (done) return null;
    }
  } finally {
    reader.releaseLock();
  }
}

async function writeStdout(text: string): Promise<void> {
  const bytes = new TextEncoder().encode(text);
  let written = 0;
  while (written < bytes.byteLength) {
    written += await Deno.stdout.write(bytes.subarray(written));
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(Deno.args);
  const counterText = await Deno.readTextFile(parsed.counter).catch(() => "0");
  const attempts = Number(counterText.trim()) || 0;
  await Deno.writeTextFile(parsed.counter, String(attempts + 1));
  if (attempts === 0) {
    const frame = await readOneJsonLine();
    const id = frame && typeof frame["id"] !== "undefined" ? frame["id"] : 0;
    await writeStdout(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: "transient" },
      }) + "\n",
    );
    Deno.exit(0);
  }
  const child = new Deno.Command(parsed.cmd, {
    args: parsed.args,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const status = await child.status;
  Deno.exit(status.code ?? (status.success ? 0 : 1));
}

if (import.meta.main) {
  await main();
}
