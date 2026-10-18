import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  confineClientFsWrite,
  resolveClientFsPath,
  serveClientFs,
} from "./client-fs.ts";

Deno.test("FR-L56 a relative path anchors to the session cwd, not the process cwd", () => {
  assertEquals(resolveClientFsPath("/sandbox", "a/b.txt"), "/sandbox/a/b.txt");
  assertEquals(resolveClientFsPath("/sandbox", "/etc/x/../y"), "/etc/y");
});

Deno.test("FR-L56 a write outside writeRoot is refused, inside is allowed", () => {
  assertEquals(confineClientFsWrite("/sb", "/sb", "x.txt"), "/sb/x.txt");
  assertThrows(
    () => confineClientFsWrite("/sb", "/sb", "../x.txt"),
    Error,
    "outside",
  );
  assertThrows(
    () => confineClientFsWrite("/sb", "/sb", "/sbx/y.txt"),
    Error,
    "outside",
  );
});

Deno.test("FR-L56 fs/read_text_file honours the 1-based line and limit", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(dir, "f.txt"), "1\n2\n3\n4");
    const read = (p: Record<string, unknown>) =>
      serveClientFs("fs/read_text_file", { path: "f.txt", ...p }, {
        cwd: dir,
        writeRoot: dir,
      });
    assertEquals(await read({}), { content: "1\n2\n3\n4" });
    assertEquals(await read({ line: 2, limit: 2 }), { content: "2\n3" });
    assertEquals(await read({ line: 3 }), { content: "3\n4" });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
