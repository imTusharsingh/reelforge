import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  evaluateLive,
  metadataDigest,
  inspectStatusChange,
  inspectYaml,
  inspectWorkflow,
  validatePacket,
  classifyAudit,
  requireCi,
  extractRecord,
  LIMITS,
} from "./check-process-policy.mjs";

const policy = JSON.parse(
  await readFile(new URL("../.github/process-policy.json", import.meta.url)),
);
const workflowSources = Object.fromEntries(
  await Promise.all(
    ["ci.yml", "process-policy.yml"].map(async (name) => [
      name,
      await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8"),
    ]),
  ),
);
const ciPath = ".github/workflows/ci.yml";
const submittedCi = await inspectYaml(workflowSources["ci.yml"]);
const head = "a".repeat(40),
  base = "b".repeat(40),
  blob = "c".repeat(40);
function packet() {
  const value = {
    policy,
    pr: {
      number: 71,
      base: { sha: base, ref: "main", repo: { id: policy.repositoryId } },
      head: { sha: head, repo: { id: policy.repositoryId } },
      changed_files: 1,
      user: { id: 90269544 },
    },
    files: [{ filename: ".github/workflows/ci.yml", sha: blob, status: "modified" }],
    metadata: {
      issue: 69,
      base,
      head,
      files: [".github/workflows/ci.yml"],
      scope: "F",
      nonScope: "product",
      dependencies: "none",
      limitations: "manual enforcement",
      reconciliation: "append",
      reviewer: "minu-the-reviewer",
      status: "IMPLEMENTED_PENDING_REVIEW",
      acceptance: policy.requiredEvidence.map((id) => ({
        id,
        command: "actual command",
        result: "PASS",
        evidence: "log",
      })),
    },
    approver: { id: policy.authorizerId, type: "User" },
    approval: {
      decision: "APPROVE",
      repositoryId: policy.repositoryId,
      pr: 71,
      issue: 69,
      base,
      head,
      workstream: "F",
      expires: "2030-01-01T00:00:00Z",
      paths: [".github/workflows/ci.yml"],
      blobs: { ".github/workflows/ci.yml": blob },
      exceptions: [],
    },
    issue: { number: 69, state: "open" },
    now: Date.parse("2026-11-13T00:00:00Z"),
  };
  value.approval.metadataDigest = metadataDigest(value.metadata);
  return value;
}

test("valid independently authorized exact-head packet", () =>
  assert.equal(validatePacket(packet()), true));
const mutations = {
  "author self approval": (p) => {
    p.approver.id = p.pr.user.id;
  },
  "bot authorizer": (p) => {
    p.approver.type = "Bot";
  },
  "other repository": (p) => {
    p.pr.head.repo.id++;
  },
  "stale authorization head": (p) => {
    p.approval.head = base;
  },
  "expired authorization": (p) => {
    p.approval.expires = "2020-01-01";
  },
  "missing path": (p) => {
    p.approval.paths = [];
  },
  "wrong blob": (p) => {
    p.approval.blobs[".github/workflows/ci.yml"] = base;
  },
  "wrong workstream": (p) => {
    p.approval.workstream = "A";
  },
  "incomplete pagination": (p) => {
    p.pr.changed_files = 2;
  },
  "API file cap": (p) => {
    p.pr.changed_files = 3000;
  },
  "missing rename origin": (p) => {
    p.files[0].previous_filename = ".github/old.yml";
  },
  "missing evidence": (p) => {
    p.metadata.acceptance[0].evidence = "";
  },
  "missing required criterion": (p) => {
    p.metadata.acceptance.pop();
  },
  "duplicate evidence": (p) => {
    p.metadata.acceptance.push(p.metadata.acceptance[0]);
  },
  "unsupported completion claim": (p) => {
    p.metadata.status = "DONE";
  },
  "unaccepted deferral": (p) => {
    p.metadata.acceptance[0].result = "DEFERRED";
  },
  "stale metadata": (p) => {
    p.metadata.head = base;
  },
};
for (const [name, mutate] of Object.entries(mutations))
  test(`reject ${name}`, () => {
    const p = packet();
    mutate(p);
    assert.throws(() => validatePacket(p));
  });
test("bound independent exception permits explicit blocked evidence", () => {
  const p = packet();
  p.metadata.acceptance[0].result = "BLOCKED";
  p.approval.exceptions = [{ rule: "install", reason: "Independent accepted disposition" }];
  p.approval.metadataDigest = metadataDigest(p.metadata);
  assert.equal(validatePacket(p), true);
});
test("renamed origin requires explicit ownership and removal binding", () => {
  const p = packet();
  p.files[0].previous_filename = ".github/old.yml";
  p.metadata.files.push(".github/old.yml");
  p.approval.paths.push(".github/old.yml");
  p.approval.blobs[".github/old.yml"] = null;
  p.approval.metadataDigest = metadataDigest(p.metadata);
  assert.equal(validatePacket(p), true);
});

test("installed YAML API parses current workflows and pins", async () => {
  const pkg = JSON.parse(
    await readFile(new URL("../node_modules/yaml/package.json", import.meta.url)),
  );
  assert.equal(pkg.version, "2.9.1");
  for (const path of ["ci.yml", "process-policy.yml"]) {
    const flow = await inspectYaml(
      await readFile(new URL(`../.github/workflows/${path}`, import.meta.url), "utf8"),
    );
    assert.equal(inspectWorkflow(flow, policy, `.github/workflows/${path}`), true);
  }
});
const invalidYaml = {
  duplicates: "a: 1\na: 2\n",
  anchor: "a: &ref value\n",
  alias: "a: *missing\n",
  merge: "a: {<<: {x: 1}}\n",
  tag: "a: !!str value\n",
  multiple: "a: 1\n---\nb: 2\n",
  malformed: "a: [\n",
  key: "? [x,y]\n: value\n",
  depth: "a: " + "[".repeat(100) + "0" + "]".repeat(100),
  nodes: "a: [" + Array(21000).fill("0").join(",") + "]",
  bytes: "x".repeat(LIMITS.bytes + 1),
  exhaustion: "a: " + "[".repeat(50000) + "0" + "]".repeat(50000),
};
for (const [name, source] of Object.entries(invalidYaml))
  test(`YAML rejects ${name} within process bounds`, { timeout: 6000 }, async () => {
    await assert.rejects(inspectYaml(source));
  });
test("literal injection remains inert data", async () => {
  assert.equal(
    (await inspectYaml('name: "$(touch /tmp/reelforge-injection)"')).name,
    "$(touch /tmp/reelforge-injection)",
  );
});
function workflow() {
  return structuredClone(submittedCi);
}
for (const [name, mutate] of Object.entries({
  write: (w) => {
    w.permissions.contents = "write";
  },
  dynamic: (w) => {
    w.permissions = "${{ inputs.permissions }}";
  },
  override: (w) => {
    w.jobs.quality.permissions = { contents: "write" };
  },
  secrets: (w) => {
    w.jobs.quality.steps[0].run = "echo ${{ secrets.DEPLOY }}";
  },
  push: (w) => {
    w.jobs.quality.steps[0].run = "git push origin main";
  },
  localAction: (w) => {
    w.jobs.quality.steps = [{ uses: "./candidate-action" }];
  },
  credentials: (w) => {
    w.jobs.quality.steps = [{ uses: policy.actions[0], with: { "persist-credentials": true } }];
  },
  reusable: (w) => {
    w.jobs.quality.uses = "owner/repo/workflow@main";
  },
  selfHosted: (w) => {
    w.jobs.quality["runs-on"] = "self-hosted";
  },
}))
  test(`workflow rejects ${name}`, () => {
    const w = workflow();
    assert.equal(inspectWorkflow(w, policy, ".github/workflows/ci.yml"), true);
    mutate(w);
    assert.throws(() => inspectWorkflow(w, policy, ".github/workflows/ci.yml"));
  });
test("every mandatory job fail/cancel/skip blocks Required CI", () => {
  const all = Object.fromEntries(
    ["quality", "database", "tests", "build", "secrets"].map((k) => [k, { result: "success" }]),
  );
  requireCi(all);
  for (const key of Object.keys(all))
    for (const result of ["failure", "cancelled", "skipped", undefined])
      assert.throws(() => requireCi({ ...all, [key]: { result } }));
  requireCi({ ...all, "dependency-audit": { result: "failure" } });
});
const audit = (counts) => ({
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, ...counts } },
});
test("audit CLEAN and report-only FINDINGS distinguish exits", () => {
  assert.equal(classifyAudit(0, audit({})).outcome, "CLEAN");
  assert.equal(classifyAudit(1, audit({ high: 1 })).outcome, "FINDINGS");
  assert.equal(classifyAudit(0, audit({ moderate: 1 })).outcome, "FINDINGS");
});
test("unavailable/contradictory audits cannot become CLEAN", () => {
  for (const [exit, report] of [
    [1, audit({})],
    [0, audit({ high: 1 })],
    [2, audit({})],
    [null, audit({})],
    [0, {}],
    [0, { error: "registry unavailable" }],
    [0, audit({ low: -1 })],
  ])
    assert.throws(() => classifyAudit(exit, report));
});
test("metadata record must be unique and valid JSON", () => {
  const body = '```json\n{"kind":"reelforge-process-v1"}\n```';
  assert.equal(extractRecord(body, "reelforge-process-v1").kind, "reelforge-process-v1");
  assert.throws(() => extractRecord(body + body, "reelforge-process-v1"));
  assert.throws(() => extractRecord("", "reelforge-process-v1"));
});

function liveFixture(change = () => {}) {
  const p = packet();
  p.pr.state = "open";
  p.metadata.authorizationComment = 123;
  p.metadata.kind = "reelforge-process-v1";
  p.approval.kind = "reelforge-authorization-v1";
  p.approval.metadataDigest = metadataDigest(p.metadata);
  p.pr.body = "```json\n" + JSON.stringify(p.metadata) + "\n```";
  const comment = {
    id: 123,
    user: p.approver,
    body: "```json\n" + JSON.stringify(p.approval) + "\n```",
    updated_at: "2026-11-13T00:00:00Z",
    issue_url: `https://api.github.com/repos/${policy.repository}/issues/69`,
  };
  let prReads = 0,
    commentReads = 0;
  const requests = [];
  const api = async (path) => {
    requests.push(path);
    let value;
    if (path === "pulls/71") {
      value = structuredClone(p.pr);
      prReads++;
    } else if (path === "pulls/71/files?per_page=100&page=1") value = structuredClone(p.files);
    else if (path === "issues/69") value = structuredClone(p.issue);
    else if (path === "issues/comments/123") {
      value = structuredClone(comment);
      commentReads++;
    } else if (path === `contents/.github/workflows?ref=${head}`)
      value = ["ci.yml", "process-policy.yml"].map((name) => ({
        type: "file",
        name,
        sha: name === "ci.yml" ? blob : "d".repeat(40),
      }));
    else if ([`git/blobs/${blob}`, `git/blobs/${"d".repeat(40)}`].includes(path)) {
      const source =
        workflowSources[path === `git/blobs/${blob}` ? "ci.yml" : "process-policy.yml"];
      value = {
        encoding: "base64",
        size: source.length,
        content: Buffer.from(source).toString("base64"),
      };
    } else throw new Error(`Unexpected route ${path}`);
    return change({ path, value, prReads, commentReads }) ?? value;
  };
  return { api, policy, number: 71, trustedBase: base, requests };
}
test("full metadata evaluation reads candidate blobs only as data", async () => {
  const f = liveFixture();
  const result = await evaluateLive(f);
  assert.equal(result.result, "PASS");
  assert.equal(result.head, head);
  assert.ok(result.authorizationDigest);
  assert.equal(
    f.requests.some((path) => path.includes("download") || path.includes("artifacts")),
    false,
  );
});
for (const [name, change] of Object.entries({
  "API unavailable": () => {
    throw new Error("GitHub read failed 403");
  },
  "rate limited": () => {
    throw new Error("GitHub read failed 429");
  },
  "head changed": ({ path, value, prReads }) => {
    if (path === "pulls/71" && prReads === 2) value.head.sha = base;
  },
  "base changed": ({ path, value, prReads }) => {
    if (path === "pulls/71" && prReads === 2) value.base.sha = head;
  },
  "body changed": ({ path, value, prReads }) => {
    if (path === "pulls/71" && prReads === 2) value.body += "edited";
  },
  "approval edited": ({ path, value, commentReads }) => {
    if (path === "issues/comments/123" && commentReads === 2) value.body += "edited";
  },
  "approval wrong issue": ({ path, value }) => {
    if (path === "issues/comments/123") value.issue_url += "0";
  },
  "approval deleted": ({ path }) => {
    if (path === "issues/comments/123") throw new Error("GitHub read failed 404");
  },
  "missing required workflow": ({ path, value }) =>
    path.startsWith("contents/") ? value.slice(0, 1) : undefined,
  "pagination truncated": ({ path, value }) => {
    if (path === "pulls/71") value.changed_files = 2;
  },
  "oversized blob": ({ path, value }) => {
    if (path.startsWith("git/blobs/")) value.size = LIMITS.bytes + 1;
  },
}))
  test(`live check fails closed: ${name}`, async () => {
    await assert.rejects(evaluateLive(liveFixture(change)));
  });
test("trusted checkout mismatch rejected before blob inspection", async () => {
  const f = liveFixture();
  f.trustedBase = head;
  await assert.rejects(evaluateLive(f), /stale/);
  assert.equal(
    f.requests.some((p) => p.startsWith("git/blobs/")),
    false,
  );
});

test("audit CLI preserves findings, rejects unavailable output and artifact errors", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const root = await mkdtemp(join(tmpdir(), "reelforge-policy-"));
  const cli = new URL("./check-process-policy.mjs", import.meta.url).pathname;
  try {
    for (const [name, exit, output, success] of [
      ["clean", 0, JSON.stringify(audit({})), true],
      [
        "findings",
        1,
        JSON.stringify({ ...audit({ high: 1 }), advisories: { known: { severity: "high" } } }),
        true,
      ],
      ["registry", 1, JSON.stringify({ error: "network unavailable" }), false],
      ["truncated", 0, '{"metadata":', false],
      ["contradictory", 1, JSON.stringify(audit({})), false],
    ]) {
      const dir = join(root, name);
      await mkdir(dir);
      await writeFile(join(dir, "pnpm"), `#!/bin/sh\nprintf '%s' '${output}'\nexit ${exit}\n`, {
        mode: 0o700,
      });
      const result = spawnSync(process.execPath, [cli, "--audit"], {
        cwd: dir,
        env: { PATH: dir },
        encoding: "utf8",
        timeout: 5000,
      });
      assert.equal(result.status === 0, success, name);
      const report = JSON.parse(await readFile(join(dir, "pnpm-audit.json"), "utf8"));
      assert.equal(
        report.outcome,
        success ? (name === "clean" ? "CLEAN" : "FINDINGS") : "UNAVAILABLE",
      );
      if (name === "findings") assert.equal(report.advisories.known.severity, "high");
    }
    const dir = join(root, "artifact-error");
    await mkdir(join(dir, "pnpm-audit.json"), { recursive: true });
    assert.notEqual(
      spawnSync(process.execPath, [cli, "--audit"], { cwd: dir, env: { PATH: dir }, timeout: 5000 })
        .status,
      0,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("actual Required CI CLI blocks mandatory failure, skip and cancel", async () => {
  const { spawnSync } = await import("node:child_process");
  const cli = new URL("./check-process-policy.mjs", import.meta.url).pathname;
  const all = Object.fromEntries(
    ["quality", "database", "tests", "build", "secrets"].map((k) => [k, { result: "success" }]),
  );
  const run = (results) =>
    spawnSync(process.execPath, [cli, "--required"], {
      env: { RESULTS: JSON.stringify(results) },
      timeout: 5000,
    }).status;
  assert.equal(run(all), 0);
  for (const result of ["failure", "cancelled", "skipped"])
    assert.notEqual(run({ ...all, secrets: { result } }), 0);
  assert.equal(run({ ...all, "dependency-audit": { result: "failure" } }), 0);
});

test("target workflow rejects head checkout, action script and environment redirection", () => {
  const make = () => ({
    on: { pull_request_target: { branches: ["main"] } },
    permissions: { contents: "read" },
    jobs: {
      check: {
        "runs-on": "ubuntu-24.04",
        steps: [
          {
            uses: policy.actions[0],
            with: {
              ref: "${{ github.event.pull_request.head.sha }}",
              "persist-credentials": false,
            },
          },
        ],
      },
    },
  });
  assert.throws(() => inspectWorkflow(make(), policy, ".github/workflows/process-policy.yml"));
  const env = make();
  env.jobs.check.steps = [
    {
      run: "node scripts/check-process-policy.mjs",
      env: { NODE_OPTIONS: "--import ./candidate.mjs" },
    },
  ];
  assert.throws(() => inspectWorkflow(env, policy, ".github/workflows/process-policy.yml"));
  const shell = make();
  shell.jobs.check.steps = [
    { run: "node scripts/check-process-policy.mjs", shell: "./candidate-shell" },
  ];
  assert.throws(() => inspectWorkflow(shell, policy, ".github/workflows/process-policy.yml"));
});

test("new terminal claims require exact independent closeout attestation", () => {
  const a = packet().approval;
  assert.throws(() => inspectStatusChange("State: IN_PROGRESS", "- **State:** INTEGRATED", a));
  inspectStatusChange("State: INTEGRATED", "State: INTEGRATED", a);
  inspectStatusChange("State: IN_PROGRESS", "State: IMPLEMENTED_PENDING_REVIEW", a);
  inspectStatusChange("", "State: INTEGRATED", {
    ...a,
    exceptions: [{ rule: "status-closeout", reason: "Verified prior merge" }],
  });
});

test("exact root parser dependency and lock integrity", async () => {
  const YAML = await import("yaml");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.devDependencies.yaml, "2.9.1");
  const docs = YAML.parseAllDocuments(
    await readFile(new URL("../pnpm-lock.yaml", import.meta.url), "utf8"),
  );
  const lock = docs.at(-1).toJS();
  assert.deepEqual(lock.importers["."].devDependencies.yaml, {
    specifier: "2.9.1",
    version: "2.9.1",
  });
  assert.equal(
    lock.packages["yaml@2.9.1"].resolution.integrity,
    "sha512-3NxN8+78OdzbT7C/WjGsyfPAtJaN3FNDsWxv7Y7mcDsT/oOmgW8BpyQQFFBnvZE3j9Y2Sdz1ULFLezL7Eb2yFw==",
  );
});

test("edited acceptance evidence invalidates independent attestation", () => {
  const p = packet();
  p.metadata.acceptance[0].evidence = "author substituted a different result";
  assert.throws(() => validatePacket(p), /metadata digest/);
});

const ciCase = () => structuredClone(submittedCi);
for (const name of [
  "quality",
  "database",
  "tests",
  "build",
  "secrets",
  "required",
  "dependency-audit",
]) {
  test(`F-H1: reject removed mandatory CI topology job ${name}`, () => {
    const flow = ciCase();
    delete flow.jobs[name];
    assert.throws(() => inspectWorkflow(flow, policy, ciPath));
  });
}
const ciBypasses = {
  "required and secrets removed together": (flow) => {
    delete flow.jobs.required;
    delete flow.jobs.secrets;
  },
  "required job renamed": (flow) => {
    flow.jobs.other = flow.jobs.required;
    delete flow.jobs.required;
  },
  "secrets job renamed": (flow) => {
    flow.jobs.other = flow.jobs.secrets;
    delete flow.jobs.secrets;
  },
  "PR trigger removed": (flow) => {
    delete flow.on.pull_request;
  },
  "PR trigger filtered by path": (flow) => {
    flow.on.pull_request.paths = ["never/**"];
  },
  "push branch removed": (flow) => {
    flow.on.push.branches.pop();
  },
  "scanner step if false": (flow) => {
    flow.jobs.secrets.steps[2].if = false;
  },
  "scanner step false expression": (flow) => {
    flow.jobs.secrets.steps[2].if = "${{ false }}";
  },
  "scanner step true expression still conditional": (flow) => {
    flow.jobs.secrets.steps[2].if = "${{ true }}";
  },
  "scanner job if false": (flow) => {
    flow.jobs.secrets.if = false;
  },
  "scanner job skip expression": (flow) => {
    flow.jobs.secrets.if = "${{ false }}";
  },
  "scanner missing": (flow) => {
    flow.jobs.secrets.steps.pop();
  },
  "scanner exit muted": (flow) => {
    flow.jobs.secrets.steps[2].run += " || true";
  },
  "scanner output redirected": (flow) => {
    flow.jobs.secrets.steps[2].run += " > /dev/null";
  },
  "scanner step continue on error": (flow) => {
    flow.jobs.secrets.steps[2]["continue-on-error"] = true;
  },
  "scanner job continue on error": (flow) => {
    flow.jobs.secrets["continue-on-error"] = true;
  },
  "scanner environment injection": (flow) => {
    flow.jobs.secrets.steps[2].env = { NODE_OPTIONS: "--import ./neutralize.mjs" };
  },
  "scanner job environment injection": (flow) => {
    flow.jobs.secrets.env = { PATH: "/tmp/noop" };
  },
  "scanner preparatory neutralization": (flow) => {
    flow.jobs.secrets.steps.splice(2, 0, { run: "printf '' > scripts/check-secrets.mjs" });
  },
  "scanner alternate checkout": (flow) => {
    flow.jobs.secrets.steps[0].with.ref = "clean-branch";
  },
  "scanner checkout sparse omission": (flow) => {
    flow.jobs.secrets.steps[0].with["sparse-checkout"] = "README.md";
  },
  "aggregator conditional": (flow) => {
    flow.jobs.required.steps[2].if = false;
  },
  "aggregator results replaced": (flow) => {
    flow.jobs.required.steps[2].env.RESULTS = "{}";
  },
  "aggregator removed": (flow) => {
    flow.jobs.required.steps.pop();
  },
  "quality job skipped": (flow) => {
    flow.jobs.quality.if = false;
  },
  "build step skipped": (flow) => {
    flow.jobs.build.steps.at(-1).if = false;
  },
};
for (const [name, mutate] of Object.entries(ciBypasses))
  test(`F-H1/F-H2: reject ${name}`, () => {
    const flow = ciCase();
    mutate(flow);
    assert.throws(() => inspectWorkflow(flow, policy, ciPath));
  });
test("workflow name cannot grant or change trusted path identity", () => {
  const flow = ciCase();
  flow.name = "Renamed display label";
  assert.equal(inspectWorkflow(flow, policy, ciPath), true);
  assert.throws(() => inspectWorkflow(flow, policy, ".github/workflows/other.yml"));
  assert.throws(() => inspectWorkflow(flow, policy));
});

for (const [name, change] of Object.entries({
  "missing Required CI and scanner": (flow) => {
    delete flow.jobs.required;
    delete flow.jobs.secrets;
  },
  "false scanner step": (flow) => {
    flow.jobs.secrets.steps[2].if = false;
  },
  "global scanner environment redirection": (flow) => {
    flow.env.NODE_OPTIONS = "--import ./neutralize.mjs";
  },
}))
  test(`live candidate blob inspection rejects ${name}`, async () => {
    await assert.rejects(
      evaluateLive(
        liveFixture(({ path, value }) => {
          if (path !== `git/blobs/${blob}`) return;
          const flow = ciCase();
          change(flow);
          const source = JSON.stringify(flow);
          return {
            ...value,
            size: Buffer.byteLength(source),
            content: Buffer.from(source).toString("base64"),
          };
        }),
      ),
    );
  });
