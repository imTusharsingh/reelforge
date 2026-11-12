import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const SELF = fileURLToPath(import.meta.url);
export const LIMITS = Object.freeze({ bytes: 262144, nodes: 20000, depth: 40, milliseconds: 3000 });
const sha = (s) => createHash("sha256").update(s).digest("hex");
export const metadataDigest = (metadata) => sha(JSON.stringify(metadata));
const fail = (s) => {
  throw new Error(s);
};
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const sha40 = (v) => typeof v === "string" && /^[a-f0-9]{40}$/.test(v);

// Child receives only bounded input and a minimal environment, never an API token.
export function inspectYaml(source) {
  if (typeof source !== "string" || Buffer.byteLength(source) > LIMITS.bytes)
    return Promise.reject(new Error("YAML byte limit"));
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--max-old-space-size=64", "--stack_size=512", SELF, "--yaml-child"],
      {
        env: { PATH: process.env.PATH },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let output = "";
    let oversized = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("YAML timeout"));
    }, LIMITS.milliseconds);
    child.stdout.on("data", (b) => {
      output += b;
      if (output.length > LIMITS.bytes * 2) {
        oversized = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || oversized) return reject(new Error("YAML rejected or resource limit"));
      try {
        resolve(JSON.parse(output));
      } catch {
        reject(new Error("YAML child invalid output"));
      }
    });
    child.stdin.end(source);
  });
}

async function yamlChild() {
  let source = "";
  for await (const b of process.stdin) {
    source += b;
    if (Buffer.byteLength(source) > LIMITS.bytes) fail("YAML byte limit");
  }
  const YAML = await import("yaml");
  // Bound lexical work and obvious nesting before constructing a recursive AST.
  let tokens = 0;
  let flowDepth = 0;
  for (const token of new YAML.Lexer().lex(source)) {
    if (++tokens > LIMITS.nodes * 4) fail("YAML lexical limit");
    if (token === "[" || token === "{") flowDepth++;
    if (token === "]" || token === "}") flowDepth--;
    if (flowDepth > LIMITS.depth) fail("YAML flow depth limit");
  }
  for (const line of source.split("\n")) {
    if (/^ {81}/.test(line)) fail("YAML indentation limit");
  }
  const doc = YAML.parseDocument(source, {
    version: "1.2",
    schema: "core",
    uniqueKeys: true,
    merge: false,
    customTags: [],
    strict: true,
  });
  if (doc.errors.length || doc.warnings.length) fail("YAML parse diagnostics");
  const stack = [[doc.contents, 0]];
  let count = 0;
  while (stack.length) {
    const [node, depth] = stack.pop();
    if (node == null) continue;
    if (++count > LIMITS.nodes || depth > LIMITS.depth) fail("YAML structure limit");
    if (node.anchor || node.tag || YAML.isAlias(node)) fail("YAML anchors/tags/aliases forbidden");
    if (YAML.isMap(node)) {
      for (const pair of node.items) {
        if (
          !YAML.isScalar(pair.key) ||
          typeof pair.key.value !== "string" ||
          pair.key.value === "<<"
        )
          fail("YAML key forbidden");
        stack.push([pair.key, depth + 1], [pair.value, depth + 1]);
      }
    } else if (YAML.isSeq(node)) {
      for (const value of node.items) stack.push([value, depth + 1]);
    } else if (!YAML.isScalar(node)) fail("YAML unsupported AST");
  }
  process.stdout.write(JSON.stringify(doc.toJS({ maxAliasCount: 0 })));
}

const CI_PATH = ".github/workflows/ci.yml";
const PROCESS_PATH = ".github/workflows/process-policy.yml";

function inspectCiTopology(flow, policy) {
  const mandatory = ["quality", "database", "tests", "build", "secrets"];
  const jobs = [...mandatory, "required", "dependency-audit"];
  if (!isDeepStrictEqual(Object.keys(flow.jobs).sort(), jobs.sort()))
    fail("CI mandatory job topology missing, renamed or extended");
  if (
    !isDeepStrictEqual(flow.on, {
      push: { branches: ["main", "work/**", "chore/**", "feat/**", "fix/**"] },
      pull_request: { branches: ["main"] },
    })
  )
    fail("CI required event topology");
  if (!isDeepStrictEqual(flow.permissions, { contents: "read" })) fail("CI read-only default");
  if (
    !isDeepStrictEqual(flow.env, {
      NEXT_TELEMETRY_DISABLED: "1",
      DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5432/reelforge?schema=public",
    })
  )
    fail("CI workflow environment override");
  for (const name of [...mandatory, "dependency-audit"]) {
    const job = flow.jobs[name];
    if (!object(job) || Object.hasOwn(job, "if") || Object.hasOwn(job, "needs"))
      fail(`CI job must run unconditionally: ${name}`);
    const env =
      name === "database"
        ? {
            MIGRATION_BASE_SHA: "${{ github.event.pull_request.base.sha || github.event.before }}",
          }
        : undefined;
    if (!isDeepStrictEqual(job.env, env)) fail(`CI job environment override: ${name}`);
  }
  const checkout = policy.actions.find((action) => action.startsWith("actions/checkout@"));
  const setupNode = policy.actions.find((action) => action.startsWith("actions/setup-node@"));
  const setup = [
    { uses: checkout, with: { "persist-credentials": false } },
    { uses: setupNode, with: { "node-version-file": ".node-version" } },
  ];
  // Exact structured jobs exclude conditionals (including false), continue-on-error,
  // environment/shell overrides, alternate checkouts and preparatory no-op scripts.
  if (
    !isDeepStrictEqual(flow.jobs.secrets, {
      name: "Secret scan (mandatory)",
      "runs-on": "ubuntu-24.04",
      "timeout-minutes": 5,
      steps: [...setup, { run: "node scripts/check-secrets.mjs" }],
    })
  )
    fail("Mandatory secret scan job must match unconditional approved invocation");
  if (
    !isDeepStrictEqual(flow.jobs.required, {
      name: "Required CI",
      if: "always()",
      needs: mandatory,
      "runs-on": "ubuntu-24.04",
      "timeout-minutes": 5,
      steps: [
        ...setup,
        {
          name: "Require every mandatory job to pass",
          env: { RESULTS: "${{ toJSON(needs) }}" },
          run: "node scripts/check-process-policy.mjs --required",
        },
      ],
    })
  )
    fail("Required CI unconditional dependency graph/aggregation");
  const commands = {
    quality: [
      "pnpm install --frozen-lockfile",
      "pnpm lint",
      "pnpm format:check",
      "pnpm typecheck",
      "node --test scripts/check-process-policy.test.mjs",
    ],
    database: [
      "pnpm install --frozen-lockfile",
      "pnpm db:check-migrations",
      "pnpm db:validate",
      "pnpm db:migrate:deploy",
    ],
    tests: [
      "pnpm install --frozen-lockfile",
      "pnpm db:migrate:deploy",
      "pnpm db:generate",
      "set -o pipefail\npnpm test 2>&1 | tee test-output.txt\n",
    ],
    build: ["pnpm install --frozen-lockfile", "pnpm build"],
    "dependency-audit": [
      "pnpm install --frozen-lockfile --ignore-scripts",
      "node scripts/check-process-policy.mjs --audit",
    ],
  };
  for (const [name, expected] of Object.entries(commands)) {
    const steps = flow.jobs[name].steps;
    if (
      !Array.isArray(steps) ||
      !isDeepStrictEqual(
        steps.filter((step) => Object.hasOwn(step, "run")),
        expected.map((run) => ({ run })),
      )
    )
      fail(`CI unconditional command topology: ${name}`);
  }
}

export function inspectWorkflow(flow, policy, path) {
  if (!object(flow) || !object(flow.jobs)) fail("Workflow structure");
  if (path === CI_PATH) inspectCiTopology(flow, policy);
  else if (
    path !== PROCESS_PATH ||
    !object(flow.on) ||
    !Object.hasOwn(flow.on, "pull_request_target")
  )
    fail("Unsupported workflow path/identity");
  const allowedTop = new Set([
    "name",
    "on",
    "permissions",
    "concurrency",
    "env",
    "jobs",
    "run-name",
  ]);
  for (const key of Object.keys(flow))
    if (!allowedTop.has(key)) fail(`Unsupported workflow key ${key}`);
  const permissions = (p) => {
    if (!object(p) || p.contents !== "read") fail("Explicit read permissions required");
    for (const [scope, value] of Object.entries(p))
      if (!policy.readScopes.includes(scope) || value !== "read") fail("Permission escalation");
  };
  permissions(flow.permissions);
  if (!object(flow.on)) fail("Explicit event mapping required");
  for (const trigger of Object.keys(flow.on))
    if (!["push", "pull_request", "pull_request_target", "workflow_dispatch"].includes(trigger))
      fail("Unsupported trigger");
  const privilegedEvent = Object.hasOwn(flow.on, "pull_request_target");
  const trustedRef = "${{ github.event.pull_request.base.sha || 'refs/heads/main' }}";
  const trustedSha = "${{ github.event.pull_request.base.sha || github.sha }}";
  const trustedCommands = new Set([
    "pnpm install --frozen-lockfile --ignore-scripts",
    "node scripts/check-process-policy.mjs",
  ]);
  for (const job of Object.values(flow.jobs)) {
    if (!object(job) || job.uses || !Array.isArray(job.steps) || job["runs-on"] !== "ubuntu-24.04")
      fail("Unsupported job/runner");
    const jobKeys = new Set([
      "name",
      "runs-on",
      "permissions",
      "timeout-minutes",
      "steps",
      "services",
      "env",
      "if",
      "needs",
      "concurrency",
    ]);
    if (Object.keys(job).some((k) => !jobKeys.has(k))) fail("Unsupported job key");
    if (
      privilegedEvent &&
      (flow.env ||
        job.env ||
        job.services ||
        (job.if &&
          job.if !==
            "github.event_name == 'pull_request_target' || github.ref == 'refs/heads/main'"))
    )
      fail("Unsupported target job configuration");
    if (job.permissions) permissions(job.permissions);
    if (job.environment || job.secrets || job.container) fail("Privileged job construct");
    for (const step of job.steps) {
      if (!object(step) || Boolean(step.run) === Boolean(step.uses)) fail("Unsupported step");
      const stepKeys = new Set([
        "name",
        "uses",
        "with",
        "run",
        "env",
        "if",
        "id",
        "timeout-minutes",
      ]);
      if (Object.keys(step).some((k) => !stepKeys.has(k))) fail("Unsupported step key");
      if (privilegedEvent) {
        if (step.if) fail("Conditional target step forbidden");
        const allowedEnv = {
          GH_TOKEN: "${{ github.token }}",
          TRUSTED_BASE_SHA: trustedSha,
          NODE_USE_ENV_PROXY: "1",
        };
        if (step.env && Object.entries(step.env).some(([key, value]) => allowedEnv[key] !== value))
          fail("Unsupported target step environment");
        const allowedWith = step.uses?.startsWith("actions/checkout@")
          ? { ref: trustedRef, "persist-credentials": false }
          : step.uses?.startsWith("pnpm/action-setup@")
            ? { version: "12.16.1" }
            : { "node-version-file": ".node-version" };
        if (
          step.with &&
          Object.entries(step.with).some(([key, value]) => allowedWith[key] !== value)
        )
          fail("Unsupported target action configuration");
        if (step.run && !trustedCommands.has(step.run)) fail("Unsupported target-workflow command");
        if (step.uses?.startsWith("actions/checkout@") && step.with?.ref !== trustedRef)
          fail("Target workflow must check out trusted base");
        if (step.with && Object.hasOwn(step.with, "repository"))
          fail("Alternate checkout repository forbidden");
        if (step.with?.run_install) fail("Action dependency execution forbidden");
      }
      if (step.uses && !policy.actions.includes(step.uses)) fail("Unapproved action");
      if (
        step.uses?.startsWith("actions/checkout@") &&
        step.with?.["persist-credentials"] !== false
      )
        fail("Checkout credentials must not persist");
      if (
        step.run &&
        /(?:git\s+(?:push|commit)|gh\s+(?:pr\s+(?:merge|edit)|api\s+.*(?:POST|PATCH|PUT|DELETE))|prettier\s+--write)/i.test(
          step.run,
        )
      )
        fail("Workflow mutation command");
    }
  }
  // Secrets interpolation is disallowed except the dedicated read-only GitHub token.
  const text = JSON.stringify(flow);
  if (/\$\{\{[^}]*\bsecrets\s*[.[]/.test(text)) fail("Repository secrets forbidden");
  return true;
}

export function requireCi(needs) {
  for (const name of ["quality", "database", "tests", "build", "secrets"]) {
    if (needs[name]?.result !== "success")
      fail(`Mandatory CI failed: ${name}=${needs[name]?.result}`);
  }
}

export function classifyAudit(exit, report) {
  if (!object(report) || report.error || !object(report.metadata?.vulnerabilities))
    fail("UNAVAILABLE: audit report");
  const counts = report.metadata.vulnerabilities;
  const levels = ["info", "low", "moderate", "high", "critical"];
  if (levels.some((k) => !Number.isSafeInteger(counts[k]) || counts[k] < 0))
    fail("UNAVAILABLE: audit counts");
  const total = levels.reduce((n, k) => n + counts[k], 0);
  const expectedFailure = counts.high + counts.critical > 0;
  if (![0, 1].includes(exit) || (exit === 1) !== expectedFailure)
    fail("UNAVAILABLE: audit exit/report disagreement");
  return { outcome: total ? "FINDINGS" : "CLEAN", exit, counts };
}

export function validatePacket({
  pr,
  files,
  metadata,
  approval,
  approver,
  issue,
  policy,
  now = Date.now(),
}) {
  if (
    !Number.isSafeInteger(pr.number) ||
    pr.base?.repo?.id !== policy.repositoryId ||
    pr.head?.repo?.id !== policy.repositoryId ||
    pr.base.ref !== "main" ||
    !sha40(pr.base.sha) ||
    !sha40(pr.head.sha)
  )
    fail("Repository/ref identity");
  if (
    !Array.isArray(files) ||
    !files.length ||
    files.length !== pr.changed_files ||
    files.length >= 3000
  )
    fail("Incomplete changed files");
  if (
    !object(metadata) ||
    metadata.issue !== issue.number ||
    metadata.base !== pr.base.sha ||
    metadata.head !== pr.head.sha ||
    !Array.isArray(metadata.files)
  )
    fail("Metadata identity");
  if (
    !issue ||
    issue.state !== "open" ||
    !Array.isArray(metadata.acceptance) ||
    !metadata.acceptance.length
  )
    fail("Missing task/acceptance");
  if (
    !object(approver) ||
    approver.id !== policy.authorizerId ||
    approver.type !== "User" ||
    approver.id === pr.user.id
  )
    fail("Independent authorization identity");
  if (
    !object(approval) ||
    approval.decision !== "APPROVE" ||
    approval.repositoryId !== policy.repositoryId ||
    approval.pr !== pr.number ||
    approval.issue !== issue.number ||
    approval.base !== pr.base.sha ||
    approval.head !== pr.head.sha ||
    !Number.isFinite(Date.parse(approval.expires)) ||
    Date.parse(approval.expires) <= now ||
    !Array.isArray(approval.paths) ||
    !Array.isArray(approval.exceptions)
  )
    fail("Authorization scope/freshness");
  for (const key of ["scope", "nonScope", "dependencies", "limitations", "reconciliation"]) {
    if (typeof metadata[key] !== "string" || !metadata[key].trim())
      fail("Missing process narrative");
  }
  if (approval.workstream !== "F" && files.some((f) => f.filename.startsWith(".github/")))
    fail("Workstream F required");
  if (approval.metadataDigest !== metadataDigest(metadata))
    fail("Authorization metadata digest mismatch");
  const actual = files.flatMap((f) =>
    f.previous_filename ? [f.filename, f.previous_filename] : [f.filename],
  );
  if (
    new Set(actual).size !== actual.length ||
    JSON.stringify([...actual].sort()) !== JSON.stringify([...metadata.files].sort())
  )
    fail("Changed file ownership mismatch");
  for (const path of actual) {
    if (!approval.paths.includes(path)) fail(`Unauthorized file ${path}`);
    if (policy.protectedPrefixes.some((p) => path.startsWith(p))) {
      const f = files.find((entry) => entry.filename === path);
      const expected = f ? (f.status === "removed" ? null : f.sha) : null;
      if (
        !object(approval.blobs) ||
        !Object.hasOwn(approval.blobs, path) ||
        approval.blobs[path] !== expected
      )
        fail(`Protected blob mismatch ${path}`);
      if (path.startsWith(".github/") && approval.workstream !== "F")
        fail("GitHub files require F authorization");
      if (path.startsWith("packages/") && !approval.adr?.length)
        fail("Shared contract requires ADR approval");
    }
  }
  const covered = new Set();
  for (const row of metadata.acceptance) {
    if (
      !object(row) ||
      typeof row.id !== "string" ||
      covered.has(row.id) ||
      !["PASS", "BLOCKED", "DEFERRED"].includes(row.result) ||
      typeof row.command !== "string" ||
      !row.command.trim() ||
      typeof row.evidence !== "string" ||
      !row.evidence.trim()
    )
      fail("Acceptance evidence missing");
    covered.add(row.id);
    if (
      row.result !== "PASS" &&
      !approval.exceptions.some(
        (e) => e.rule === row.id && typeof e.reason === "string" && e.reason.trim(),
      )
    )
      fail("Unaccepted blocked/deferred criterion");
  }
  for (const criterion of policy.requiredEvidence)
    if (!covered.has(criterion)) fail(`Missing required evidence ${criterion}`);
  if (
    metadata.status !== "IMPLEMENTED_PENDING_REVIEW" ||
    !metadata.scope ||
    !metadata.nonScope ||
    !metadata.dependencies ||
    !metadata.limitations ||
    !metadata.reconciliation ||
    metadata.reviewer !== policy.authorizerLogin
  )
    fail("Process metadata/status");
  return true;
}

export function inspectStatusChange(before, after, approval) {
  const claims = (text) =>
    String(text)
      .replaceAll("**", "")
      .replaceAll("`", "")
      .split("\n")
      .map((line) =>
        line
          .match(/^\s*(?:-\s*)?(?:state|status)\s*:\s*(APPROVED|INTEGRATED|DONE)\b/i)?.[1]
          ?.toUpperCase(),
      )
      .filter(Boolean);
  const old = claims(before),
    next = claims(after);
  if (
    next.some(
      (state) => next.filter((s) => s === state).length > old.filter((s) => s === state).length,
    ) &&
    !approval.exceptions.some(
      (e) => e.rule === "status-closeout" && typeof e.reason === "string" && e.reason.trim(),
    )
  )
    fail("Unattested terminal status claim");
}

export function extractRecord(body, marker) {
  const expression = new RegExp("```json\\s*\\n([\\s\\S]*?)\\n```", "g");
  const matches = [...String(body).matchAll(expression)]
    .map((m) => JSON.parse(m[1]))
    .filter((v) => v.kind === marker);
  if (matches.length !== 1) fail(`Exactly one ${marker} record required`);
  return matches[0];
}

async function liveCheck() {
  const policy = JSON.parse(await readFile(".github/process-policy.json", "utf8"));
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  const number = event.pull_request?.number ?? Number(event.inputs?.pr);
  if (
    process.env.GITHUB_REPOSITORY !== policy.repository ||
    !Number.isSafeInteger(number) ||
    number < 1
  )
    fail("Event repository/PR");
  const token = process.env.GH_TOKEN;
  if (!token) fail("Read token unavailable");
  const api = async (path) => {
    const response = await fetch(`https://api.github.com/repos/${policy.repository}/${path}`, {
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) fail(`GitHub read failed ${response.status}`);
    const chunks = [];
    let size = 0;
    for await (const b of response.body) {
      size += b.length;
      if (size > 4 * 1024 * 1024) fail("API size limit");
      chunks.push(b);
    }
    return JSON.parse(Buffer.concat(chunks).toString());
  };
  console.log(
    JSON.stringify(
      await evaluateLive({ api, policy, number, trustedBase: process.env.TRUSTED_BASE_SHA }),
      null,
      2,
    ),
  );
}

export async function evaluateLive({ api, policy, number, trustedBase }) {
  const pr = await api(`pulls/${number}`);
  if (pr.state !== "open" || pr.draft) fail("PR must be open and ready");
  if (trustedBase !== pr.base.sha) fail("Trusted checkout is stale");
  const files = [];
  for (let page = 1; page <= 30; page++) {
    const batch = await api(`pulls/${number}/files?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) fail("File pagination response");
    files.push(...batch);
    if (batch.length < 100) break;
  }
  const metadata = extractRecord(pr.body, "reelforge-process-v1");
  if (!Number.isSafeInteger(metadata.authorizationComment) || !Number.isSafeInteger(metadata.issue))
    fail("Record IDs");
  const issue = await api(`issues/${metadata.issue}`);
  const comment = await api(`issues/comments/${metadata.authorizationComment}`);
  if (
    comment.issue_url !==
    `https://api.github.com/repos/${policy.repository}/issues/${metadata.issue}`
  )
    fail("Approval belongs to another issue");
  const approval = extractRecord(comment.body, "reelforge-authorization-v1");
  validatePacket({ pr, files, metadata, approval, approver: comment.user, issue, policy });
  for (const file of files.filter((f) =>
    /(?:STATUS|PROJECT_STATE|WORK_LOG)\.md$/.test(f.filename),
  )) {
    const textAt = async (ref) => {
      const path = file.filename.split("/").map(encodeURIComponent).join("/");
      const content = await api(`contents/${path}?ref=${ref}`);
      if (content.encoding !== "base64" || content.size > LIMITS.bytes)
        fail("Status document limit");
      return Buffer.from(content.content, "base64").toString("utf8");
    };
    // Renames require both paths' ownership; conservative status handling compares
    // a renamed document against empty, requiring attestation for terminal claims.
    const before = ["added", "renamed"].includes(file.status) ? "" : await textAt(pr.base.sha);
    const after = file.status === "removed" ? "" : await textAt(pr.head.sha);
    inspectStatusChange(before, after, approval);
  }
  const workflows = await api(`contents/.github/workflows?ref=${pr.head.sha}`);
  if (
    !Array.isArray(workflows) ||
    workflows.length > 20 ||
    !["ci.yml", "process-policy.yml"].every((name) => workflows.some((f) => f.name === name))
  )
    fail("Workflow inventory");
  for (const f of workflows) {
    if (f.type !== "file" || !/^[a-zA-Z0-9_.-]+\.ya?ml$/.test(f.name) || !sha40(f.sha))
      fail("Unsupported workflow path");
    const blob = await api(`git/blobs/${f.sha}`);
    if (blob.encoding !== "base64" || blob.size > LIMITS.bytes) fail("Workflow blob limit");
    inspectWorkflow(
      await inspectYaml(Buffer.from(blob.content, "base64").toString("utf8")),
      policy,
      `.github/workflows/${f.name}`,
    );
  }
  const current = await api(`pulls/${number}`);
  const currentComment = await api(`issues/comments/${metadata.authorizationComment}`);
  const currentIssue = await api(`issues/${metadata.issue}`);
  if (
    currentIssue.state !== "open" ||
    current.state !== "open" ||
    current.draft ||
    current.head.sha !== pr.head.sha ||
    current.base.sha !== pr.base.sha ||
    current.body !== pr.body ||
    JSON.stringify(currentComment) !== JSON.stringify(comment)
  )
    fail("PR/approval changed during evaluation");
  return {
    result: "PASS",
    repository: policy.repository,
    pr: number,
    base: pr.base.sha,
    head: pr.head.sha,
    checker: trustedBase,
    policyDigest: sha(JSON.stringify(policy)),
    authorizationComment: comment.id,
    authorizationDigest: sha(comment.body),
    authorizationUpdated: comment.updated_at,
    files: files.map((f) => ({ path: f.filename, sha: f.sha })),
  };
}

async function main() {
  const mode = process.argv[2];
  if (mode === "--yaml-child") return yamlChild();
  if (mode === "--required") return requireCi(JSON.parse(process.env.RESULTS));
  if (mode === "--audit") {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      "pnpm-audit.json",
      JSON.stringify(
        { outcome: "UNAVAILABLE", reason: "Audit did not complete successfully" },
        null,
        2,
      ),
    );
    const child = spawn("pnpm", ["audit", "--prod", "--audit-level=high", "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let exceeded = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
    child.stdout.on("data", (b) => {
      output += b;
      if (output.length > 4 * 1024 * 1024) {
        exceeded = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.resume();
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    clearTimeout(timer);
    if (exceeded) fail("UNAVAILABLE: audit size limit");
    const raw = JSON.parse(output);
    const report = { ...classifyAudit(code, raw), advisories: raw.advisories ?? {} };
    await writeFile("pnpm-audit.json", JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    return;
  }
  return liveCheck();
}
if (process.argv[1] === SELF)
  main().catch((e) => {
    console.error(`Process policy ERROR: ${e.message}`);
    process.exitCode = 1;
  });
