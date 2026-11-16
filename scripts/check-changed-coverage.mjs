import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const base = process.env.COVERAGE_BASE ?? "origin/main";
const diff = execFileSync(
  "git",
  ["diff", "--no-ext-diff", "--unified=0", base, "--", "apps", "packages"],
  { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
);
const files = new Map();
let current;
for (const line of diff.split("\n")) {
  if (line.startsWith("+++ b/")) {
    const file = line.slice(6);
    current =
      /\.(?:ts|tsx)$/.test(file) && !/\.(?:test|fixture|d)\.ts$/.test(file) ? file : undefined;
    if (current) files.set(current, new Set());
  }
  const match = current && /^@@ .* \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (match)
    for (let index = 0; index < Number(match[2] ?? 1); index++)
      files.get(current).add(Number(match[1]) + index);
}
// Untracked source must be staged before this gate, so git diff includes every deliverable.
const untracked = execFileSync(
  "git",
  ["ls-files", "--others", "--exclude-standard", "apps", "packages"],
  { encoding: "utf8" },
).trim();
if (untracked)
  throw new Error("Stage new files before coverage so the changed-code gate cannot miss them.");
if (!process.argv.includes("--check-report")) {
  const result = spawnSync("pnpm", ["exec", "vitest", "run", "--coverage"], {
    stdio: "inherit",
    env: { ...process.env, COVERAGE_CHANGED_FILES: JSON.stringify([...files.keys()]) },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const report = JSON.parse(readFileSync("work/coverage/coverage-final.json", "utf8"));
let totalLines = 0,
  hitLines = 0,
  totalBranches = 0,
  hitBranches = 0;
for (const [file, changed] of files) {
  const coverage = report[resolve(file)];
  if (!coverage) {
    // Type-only interfaces/re-exports have no executable statements. Runtime code must be reported.
    const source = readFileSync(file, "utf8");
    if (/\b(?:function|class|const|let)\b/.test(source) && !file.endsWith(".types.ts"))
      throw new Error(`Missing coverage: ${file}`);
    continue;
  }
  const lines = new Map();
  for (const [id, location] of Object.entries(coverage.statementMap)) {
    const line = location.start.line;
    if (changed.has(line)) lines.set(line, Math.max(lines.get(line) ?? 0, coverage.s[id]));
  }
  totalLines += lines.size;
  hitLines += [...lines.values()].filter((count) => count > 0).length;
  for (const [id, branch] of Object.entries(coverage.branchMap)) {
    const intersects = branch.locations.some((location) => {
      for (let line = location.start.line; line <= location.end.line; line++)
        if (changed.has(line)) return true;
      return false;
    });
    if (intersects)
      for (const count of coverage.b[id]) {
        totalBranches++;
        if (count > 0) hitBranches++;
      }
  }
}
const lines = totalLines ? (hitLines / totalLines) * 100 : 100;
const branches = totalBranches ? (hitBranches / totalBranches) * 100 : 100;
console.log(
  `Changed-code v8 coverage: ${lines.toFixed(2)}% lines (${hitLines}/${totalLines}); ${branches.toFixed(2)}% branches (${hitBranches}/${totalBranches}).`,
);
if (lines < 80 || branches < 70)
  throw new Error("Changed-code coverage requires 80% lines and 70% branches.");
