import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const result = spawnSync("pnpm", ["exec", "knip", "--reporter", "json"], {
  encoding: "utf8",
  maxBuffer: 20 * 1024 * 1024,
  // Knip loads Prisma's config to resolve files; this placeholder never connects.
  env: {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://offline:offline@127.0.0.1:1/knip",
  },
});
if (
  result.error ||
  result.status === null ||
  result.status > 1 ||
  result.stderr.includes("ERROR:")
) {
  throw new Error(`Knip could not complete: ${result.error?.message ?? result.stderr}`);
}
const report = JSON.parse(result.stdout);
const findings = (report.files ?? []).map((file) => `files:${file}`);
for (const issue of report.issues) {
  for (const [kind, values] of Object.entries(issue)) {
    if (kind === "owners" || !Array.isArray(values)) continue;
    for (const value of values)
      findings.push(
        `${kind}:${issue.file}:${typeof value === "string" ? value : (value.name ?? JSON.stringify(value))}`,
      );
  }
}
const current = [...new Set(findings)].sort();
const path = "knip-baseline.json";
if (process.argv.includes("--write-baseline")) {
  writeFileSync(
    path,
    JSON.stringify(
      {
        description:
          "Existing debt only; review any additions. Remove resolved entries, never silently expand.",
        findings: current,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`Wrote ${current.length} baseline findings.`);
} else {
  const baseline = JSON.parse(readFileSync(path, "utf8")).findings;
  const allowed = new Set(baseline);
  const additions = current.filter((item) => !allowed.has(item));
  const resolved = baseline.filter((item) => !current.includes(item));
  if (additions.length) throw new Error(`New unused-code findings:\n${additions.join("\n")}`);
  console.log(
    `Knip clean against baseline (${current.length} existing; ${resolved.length} resolved).`,
  );
}
