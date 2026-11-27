import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const api = new URL("../apps/api/dist/", import.meta.url);
const worker = new URL("../apps/worker/dist/", import.meta.url);
createRequire(new URL("../apps/api/package.json", import.meta.url))("reflect-metadata");

const { AppModule } = await import(new URL("app-module.js", api).href);
const runs = new URL("modules/runs/", api);
const { RunsService } = await import(new URL("runs.service.js", runs).href);
const { RunsStore } = await import(new URL("runs.store.js", runs).href);
const { RunsArtifacts } = await import(new URL("runs.artifacts.js", runs).href);
assert.ok(Reflect.getMetadata("imports", AppModule)?.length, "Nest module metadata missing");
assert.deepEqual(Reflect.getMetadata("design:paramtypes", RunsService), [RunsStore, RunsArtifacts]);

const { createOrchestrationRuntime } = await import(
  new URL("handlers/orchestration/factory.js", worker).href
);
// Check the compiled worker import graph without starting a worker or opening connections.
await assert.rejects(createOrchestrationRuntime({}), /DATABASE_URL is required/);

for (const output of [api, worker]) {
  await access(new URL("main.js", output));
  await access(new URL("main.d.ts", output));
  const map = JSON.parse(await readFile(new URL("main.js.map", output), "utf8"));
  assert.ok(map.sources.includes("../src/main.ts"), "Entrypoint source map missing its source");
}
console.log("Built API and worker imports, Nest metadata, declarations and source maps verified.");
