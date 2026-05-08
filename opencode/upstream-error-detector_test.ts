import { assert, assertEquals } from "@std/assert";
import {
  detectUpstreamFatalInLine,
  findActiveOpenCodeLog,
  resolveOpenCodeLogDir,
  type UpstreamFatalError,
  watchOpenCodeLogForFatalError,
} from "./upstream-error-detector.ts";

Deno.test("detectUpstreamFatalInLine — 429 with usage-limit message", () => {
  const line =
    `INFO 2026-05-08T20:03:01 service=upstream-fetch {"statusCode":429,"data":{"error":{"code":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at 2026-05-09 04:56:07"}}}`;
  const got = detectUpstreamFatalInLine(line);
  assertEquals(
    got,
    {
      statusCode: 429,
      message:
        "Usage limit reached for 5 hour. Your limit will reset at 2026-05-09 04:56:07",
    } satisfies UpstreamFatalError,
  );
});

Deno.test("detectUpstreamFatalInLine — 401 auth failure", () => {
  const line =
    `error 2026-05-08 ... {"statusCode":401,"data":{"error":{"message":"Invalid API key"}}}`;
  assertEquals(detectUpstreamFatalInLine(line), {
    statusCode: 401,
    message: "Invalid API key",
  });
});

Deno.test("detectUpstreamFatalInLine — 402 quota", () => {
  const line = `... "statusCode":402 ... "message":"Insufficient credits"`;
  assertEquals(detectUpstreamFatalInLine(line), {
    statusCode: 402,
    message: "Insufficient credits",
  });
});

Deno.test("detectUpstreamFatalInLine — status without message yields generic", () => {
  const line = `... {"statusCode":403,"foo":1} ...`;
  assertEquals(detectUpstreamFatalInLine(line), {
    statusCode: 403,
    message: "HTTP 403 from upstream provider",
  });
});

Deno.test("detectUpstreamFatalInLine — non-fatal status returns undefined", () => {
  for (const code of [200, 204, 301, 404, 500, 503]) {
    assertEquals(
      detectUpstreamFatalInLine(`... "statusCode":${code} ...`),
      undefined,
      `expected ${code} to be ignored`,
    );
  }
});

Deno.test("detectUpstreamFatalInLine — line without statusCode is ignored", () => {
  assertEquals(
    detectUpstreamFatalInLine("INFO regular log entry, no error"),
    undefined,
  );
});

Deno.test("detectUpstreamFatalInLine — picks message AFTER the status code (skips earlier message field)", () => {
  // A previous log line on the same physical line via newlines stripped —
  // make sure the regex anchors on the position past `statusCode`.
  const line =
    `{"message":"unrelated earlier"} ... {"statusCode":429,"error":{"message":"the real one"}}`;
  assertEquals(detectUpstreamFatalInLine(line), {
    statusCode: 429,
    message: "the real one",
  });
});

Deno.test("resolveOpenCodeLogDir — OPENCODE_LOG_DIR override wins", () => {
  const prev = Deno.env.get("OPENCODE_LOG_DIR");
  Deno.env.set("OPENCODE_LOG_DIR", "/tmp/oc-test");
  try {
    assertEquals(resolveOpenCodeLogDir(), "/tmp/oc-test");
  } finally {
    if (prev === undefined) Deno.env.delete("OPENCODE_LOG_DIR");
    else Deno.env.set("OPENCODE_LOG_DIR", prev);
  }
});

Deno.test("resolveOpenCodeLogDir — falls back to $HOME", () => {
  const prevDir = Deno.env.get("OPENCODE_LOG_DIR");
  const prevHome = Deno.env.get("HOME");
  Deno.env.delete("OPENCODE_LOG_DIR");
  Deno.env.set("HOME", "/Users/test");
  try {
    assertEquals(
      resolveOpenCodeLogDir(),
      "/Users/test/.local/share/opencode/log",
    );
  } finally {
    if (prevDir !== undefined) Deno.env.set("OPENCODE_LOG_DIR", prevDir);
    if (prevHome !== undefined) Deno.env.set("HOME", prevHome);
    else Deno.env.delete("HOME");
  }
});

Deno.test("findActiveOpenCodeLog — picks file with mtime past the spawn timestamp", async () => {
  const dir = await Deno.makeTempDir({ prefix: "oc-find-active-" });
  try {
    const old = `${dir}/old.log`;
    const fresh = `${dir}/fresh.log`;
    await Deno.writeTextFile(old, "old\n");
    // Force old mtime well in the past.
    await Deno.utime(old, new Date(2020, 0, 1), new Date(2020, 0, 1));

    const spawnAt = Date.now();
    // Small delay so fresh.log mtime > spawnAt.
    await new Promise((r) => setTimeout(r, 25));
    await Deno.writeTextFile(fresh, "fresh\n");

    const got = await findActiveOpenCodeLog(dir, spawnAt, 500);
    assertEquals(got, fresh);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("findActiveOpenCodeLog — returns undefined when dir missing", async () => {
  const got = await findActiveOpenCodeLog(
    "/tmp/definitely-not-here-9c8f7d6e",
    Date.now(),
    100,
  );
  assertEquals(got, undefined);
});

Deno.test("watchOpenCodeLogForFatalError — fires onFatal on appended 429 line", async () => {
  const dir = await Deno.makeTempDir({ prefix: "oc-watch-" });
  const path = `${dir}/active.log`;
  await Deno.writeTextFile(path, "INFO startup\n");
  const ctrl = new AbortController();
  let fatal: UpstreamFatalError | undefined;

  const watcher = watchOpenCodeLogForFatalError(
    path,
    (err) => {
      fatal = err;
      ctrl.abort();
    },
    ctrl.signal,
    50,
  );

  // Append a 429 line after the watcher starts.
  setTimeout(() => {
    Deno.writeTextFile(
      path,
      `INFO startup
INFO {"statusCode":429,"data":{"error":{"message":"Usage limit reached"}}}
`,
    );
  }, 100);

  await watcher;
  assert(fatal, "expected onFatal to fire");
  assertEquals(fatal!.statusCode, 429);
  assertEquals(fatal!.message, "Usage limit reached");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("watchOpenCodeLogForFatalError — exits cleanly when signal aborts before any match", async () => {
  const dir = await Deno.makeTempDir({ prefix: "oc-watch-clean-" });
  const path = `${dir}/active.log`;
  await Deno.writeTextFile(path, "INFO startup\n");
  const ctrl = new AbortController();
  let fired = false;

  const watcher = watchOpenCodeLogForFatalError(
    path,
    () => {
      fired = true;
    },
    ctrl.signal,
    50,
  );

  setTimeout(() => ctrl.abort(), 150);
  await watcher;
  assertEquals(fired, false);
  await Deno.remove(dir, { recursive: true });
});
