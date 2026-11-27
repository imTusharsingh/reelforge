import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
