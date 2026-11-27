import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkEntrypointSourceMap } from "./check-source-map.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

function run(tool, args, input) {
  const bin = join(root, "node_modules", tool, "bin", tool);
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    encoding: "utf8",
    input,
  });
  if (result.error) throw result.error;
  return result;
}

test("Oxfmt preserves a blank line between variable groups and functions", () => {
  const source = [
    'import "reflect-metadata";',
    "",
    "const x=1;",
    "",
    "const y=2;",
    "",
    "export function one(){return x;}",
    "",
    "export function two(){return y;}",
    "",
  ].join("\n");

  const first = run("oxfmt", ["--stdin-filepath", "spacing.ts"], source);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /const x = 1;\n\nconst y = 2;\n\nexport function one/);
  assert.match(first.stdout, /return x;\n}\n\nexport function two/);

  const second = run("oxfmt", ["--stdin-filepath", "spacing.ts"], first.stdout);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, first.stdout);
});

test("Oxlint still rejects implicit return types, explicit any and new oversized functions", () => {
  const probe = mkdtempSync(join(tmpdir(), "reelforge-oxlint-"));
  try {
    const file = join(probe, "strict.ts");
    writeFileSync(
      file,
      "export function example(input: any) {\n" +
        "  input += 1;\n".repeat(62) +
        "  return input;\n}\n",
    );
    const result = run("oxlint", ["--no-ignore", "--deny-warnings", file]);
    assert.equal(result.status, 1, result.stderr);
    const diagnostics = result.stdout + result.stderr;
    assert.match(diagnostics, /explicit-function-return-type/);
    assert.match(diagnostics, /no-explicit-any/);
    assert.match(diagnostics, /max-lines-per-function/);
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
});

test("built entrypoint smoke follows the sourceMappingURL and rejects broken linkage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reelforge-source-map-"));
  try {
    const entrypoint = pathToFileURL(join(dir, "main.js"));
    const expectedSource = "../src/main.ts";
    const map = JSON.stringify({ version: 3, sources: [expectedSource], mappings: "AAAA" });
    writeFileSync(join(dir, "main.js.map"), map); // Existing map cannot hide a missing directive.
    writeFileSync(join(dir, "different-name.map"), map);

    writeFileSync(entrypoint, "export {};\n");
    await assert.rejects(checkEntrypointSourceMap(entrypoint, expectedSource), /sourceMappingURL/);

    writeFileSync(entrypoint, "export {};\n//# sourceMappingURL=absent.map\n");
    await assert.rejects(checkEntrypointSourceMap(entrypoint, expectedSource), { code: "ENOENT" });

    writeFileSync(entrypoint, "export {};\n//# sourceMappingURL=different-name.map\n");
    await checkEntrypointSourceMap(entrypoint, expectedSource);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
