import { assert, assertEquals } from "@std/assert";
import { stampLines, tsPrefix } from "./log-format.ts";

const PREFIX_RE = /^\[\d{2}:\d{2}:\d{2}\] /;

Deno.test("tsPrefix — returns [HH:MM:SS] shape", () => {
  const prefix = tsPrefix();
  assert(
    /^\[\d{2}:\d{2}:\d{2}\]$/.test(prefix),
    `tsPrefix should match [HH:MM:SS], got ${prefix}`,
  );
});

Deno.test("stampLines — single non-empty line gets prefix", () => {
  const out = stampLines("hello");
  assert(PREFIX_RE.test(out), `expected timestamp prefix, got: ${out}`);
  assert(out.endsWith("hello"));
});

Deno.test("stampLines — multi-line input stamps each non-empty line", () => {
  const out = stampLines("alpha\nbeta\ngamma");
  const lines = out.split("\n");
  assertEquals(lines.length, 3);
  for (const line of lines) {
    assert(PREFIX_RE.test(line), `line missing prefix: ${line}`);
  }
});

Deno.test("stampLines — empty lines pass through unchanged", () => {
  const out = stampLines("a\n\nb");
  const lines = out.split("\n");
  assertEquals(lines.length, 3);
  assert(PREFIX_RE.test(lines[0]));
  assertEquals(lines[1], "");
  assert(PREFIX_RE.test(lines[2]));
});

Deno.test("stampLines — trailing newline yields trailing empty segment", () => {
  const out = stampLines("only\n");
  const lines = out.split("\n");
  assertEquals(lines.length, 2);
  assert(PREFIX_RE.test(lines[0]));
  assertEquals(lines[1], "");
});

Deno.test("stampLines — empty string returns empty string", () => {
  assertEquals(stampLines(""), "");
});
