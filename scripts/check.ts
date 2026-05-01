#!/usr/bin/env -S deno run -A
/**
 * @module
 * Self-contained verification for `@korchasa/ai-ide-cli`.
 * Runs: format, lint, type-check, tests, doc-lint, publish dry-run.
 *
 * Invoked via: `deno task check` from the `ai-ide-cli/` directory.
 * The package is a workspace member, so this script assumes CWD is the
 * package root — not the repository root.
 */

async function run(
  cmd: string,
  args: string[],
  label: string,
): Promise<void> {
  console.log(`\n--- ${label} ---`);
  console.log(`> ${cmd} ${args.join(" ")}`);
  const proc = new Deno.Command(cmd, {
    args,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { success } = await proc.output();
  if (!success) {
    console.error(`FAILED: ${label}`);
    Deno.exit(1);
  }
}

async function* walkDir(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory && !entry.name.startsWith(".")) {
      yield* walkDir(path);
    } else if (entry.isFile) {
      yield path;
    }
  }
}

if (import.meta.main) {
  console.log("=== @korchasa/ai-ide-cli: Full Check ===");

  // Format the package directory.
  await run("deno", ["fmt", "."], "Formatting (auto-fix)");

  // Lint the package directory.
  await run("deno", ["lint", "."], "Linting");

  // Type check all library .ts files (source + tests). Excludes the
  // scripts/ helper dir since it's a dev tool, not shipped code.
  const typeCheckFiles: string[] = [];
  for await (const entry of walkDir(".")) {
    if (!entry.endsWith(".ts")) continue;
    if (entry.startsWith("./scripts/")) continue;
    typeCheckFiles.push(entry);
  }
  await run("deno", ["check", ...typeCheckFiles.sort()], "Type Check");

  // Tests — scoped to this package.
  await run("deno", ["test", "-A", "--no-check", "."], "Tests");

  // Doc lint — missing JSDoc, private-type-ref, circular deps on public API.
  // Caveat: `deno doc --lint <entry>` validates only symbols reachable from
  // `<entry>`. Public symbols accessed through other barrels stay invisible —
  // the publish dry-run below is what catches them.
  //
  // We also lint `runtime/index.ts` separately because it is a sub-path entry
  // (`./runtime` in deno.json). JSR's publish dry-run does not surface
  // `private-type-ref` errors per sub-path entry, so a regression there
  // (a function added to `runtime/index.ts` that references a type not
  // re-exported from the same file) would only show up to a downstream
  // consumer that imports from `@korchasa/ai-ide-cli/runtime` — never to
  // CI.
  await run("deno", ["doc", "--lint", "mod.ts"], "Doc Lint (mod.ts)");
  await run(
    "deno",
    ["doc", "--lint", "runtime/index.ts"],
    "Doc Lint (runtime/index.ts)",
  );

  // Publish dry-run — catches JSR slow-types, invalid paths, missing
  // explicit types on public API, and exports pointing at nonexistent
  // files. Runs with --allow-dirty so local uncommitted changes don't
  // fail the check.
  await run(
    "deno",
    ["publish", "--dry-run", "--allow-dirty"],
    "Publish Dry-Run",
  );

  console.log("\n=== @korchasa/ai-ide-cli: All checks passed! ===");
}
