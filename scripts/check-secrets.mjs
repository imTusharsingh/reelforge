import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";

const execFileAsync = promisify(execFile);
const { stdout } = await execFileAsync("git", ["ls-files", "-z"]);
const files = stdout.split("\0").filter(Boolean);
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
];
const findings = [];

for (const file of files) {
  let contents;
  try {
    contents = await readFile(file, "utf8");
  } catch {
    continue;
  }
  const lines = contents.split("\n");
  lines.forEach((line, index) => {
    if (secretPatterns.some((pattern) => pattern.test(line))) {
      findings.push(`${file}:${index + 1}`);
    }
  });
}

if (findings.length > 0) {
  throw new Error(`Potential secret material found in tracked files:\n${findings.join("\n")}`);
}

console.log(`Secret scan passed: ${files.length} tracked files inspected.`);
