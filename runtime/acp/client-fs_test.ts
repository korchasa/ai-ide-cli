import { assertEquals, assertRejects } from "@std/assert";
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

Deno.test("FR-L56 a write outside writeRoot is refused, inside is allowed", async () => {
  assertEquals(await confineClientFsWrite("/sb", "/sb", "x.txt"), "/sb/x.txt");
  await assertRejects(
    () => confineClientFsWrite("/sb", "/sb", "../x.txt"),
    Error,
    "outside",
  );
  await assertRejects(
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

Deno.test("FR-L56 a symlinked directory inside writeRoot cannot carry a write outside it", async () => {
  const root = await Deno.makeTempDir();
  const outside = await Deno.makeTempDir();
  try {
    await Deno.symlink(outside, join(root, "link"));
    await assertRejects(
      () =>
        serveClientFs(
          "fs/write_text_file",
          { path: "link/pwn.txt", content: "x" },
          { cwd: root, writeRoot: root },
        ),
      Error,
      "outside",
    );
    assertEquals(await Array.fromAsync(Deno.readDir(outside)), []);
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("FR-L56 a write target that is itself a symlink is refused", async () => {
  const root = await Deno.makeTempDir();
  const outside = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(outside, "existing.txt"), "keep");
    await Deno.symlink(join(outside, "existing.txt"), join(root, "file"));
    await Deno.symlink(join(outside, "new.txt"), join(root, "dangling"));
    for (const path of ["file", "dangling"]) {
      await assertRejects(
        () =>
          serveClientFs(
            "fs/write_text_file",
            { path, content: "x" },
            { cwd: root, writeRoot: root },
          ),
        Error,
        "symbolic link",
      );
    }
    assertEquals(
      await Deno.readTextFile(join(outside, "existing.txt")),
      "keep",
    );
    assertEquals(
      (await Array.fromAsync(Deno.readDir(outside))).map((e) => e.name),
      ["existing.txt"],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("FR-L56 a writeRoot reached through a symlink still accepts writes into new subdirectories", async () => {
  const base = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(base, "real"));
    await Deno.symlink(join(base, "real"), join(base, "alias"));
    const root = join(base, "alias");
    await serveClientFs(
      "fs/write_text_file",
      { path: "a/b/c.txt", content: "ok" },
      { cwd: root, writeRoot: root },
    );
    assertEquals(await Deno.readTextFile(join(base, "real/a/b/c.txt")), "ok");
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("FR-L56 a hard link inside writeRoot does not carry a write into the outside file", async () => {
  const root = await Deno.makeTempDir();
  const outside = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(outside, "secret.txt"), "keep");
    await Deno.link(join(outside, "secret.txt"), join(root, "hard.txt"));
    await serveClientFs(
      "fs/write_text_file",
      { path: "hard.txt", content: "new" },
      { cwd: root, writeRoot: root },
    );
    assertEquals(await Deno.readTextFile(join(outside, "secret.txt")), "keep");
    assertEquals(await Deno.readTextFile(join(root, "hard.txt")), "new");
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("FR-L56 overwriting a file keeps its permission bits and leaves no temp file", async () => {
  if (Deno.build.os === "windows") return;
  const root = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(root, "run.sh"), "old");
    await Deno.chmod(join(root, "run.sh"), 0o750);
    await serveClientFs(
      "fs/write_text_file",
      { path: "run.sh", content: "new" },
      { cwd: root, writeRoot: root },
    );
    assertEquals(await Deno.readTextFile(join(root, "run.sh")), "new");
    assertEquals((await Deno.stat(join(root, "run.sh"))).mode! & 0o777, 0o750);
    assertEquals(
      (await Array.fromAsync(Deno.readDir(root))).map((e) => e.name),
      ["run.sh"],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
