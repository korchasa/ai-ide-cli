import { assert, assertEquals } from "@std/assert";
import {
  CLAUDE_DISABLE_NONESSENTIAL_TRAFFIC,
  withNonessentialTrafficDisabled,
} from "./nonessential-traffic.ts";

Deno.test("withNonessentialTrafficDisabled — env undefined → injects the flag", () => {
  const out = withNonessentialTrafficDisabled(undefined);
  assertEquals(out, { [CLAUDE_DISABLE_NONESSENTIAL_TRAFFIC]: "1" });
});

Deno.test("withNonessentialTrafficDisabled — merges into a populated env", () => {
  const env = { CLAUDECODE: "", FOO: "bar" };
  const out = withNonessentialTrafficDisabled(env);
  assertEquals(out, {
    CLAUDECODE: "",
    FOO: "bar",
    [CLAUDE_DISABLE_NONESSENTIAL_TRAFFIC]: "1",
  });
  // Pure: the input map is untouched.
  assertEquals(env, { CLAUDECODE: "", FOO: "bar" });
});

Deno.test("withNonessentialTrafficDisabled — caller intent wins when the var is set", () => {
  const env = { [CLAUDE_DISABLE_NONESSENTIAL_TRAFFIC]: "0" };
  const out = withNonessentialTrafficDisabled(env);
  assert(out === env, "expected the input reference back");
});

Deno.test("withNonessentialTrafficDisabled — an explicit empty value also wins", () => {
  const env = { [CLAUDE_DISABLE_NONESSENTIAL_TRAFFIC]: "" };
  const out = withNonessentialTrafficDisabled(env);
  assert(out === env, "expected the input reference back");
});
