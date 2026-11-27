import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

export async function checkEntrypointSourceMap(entrypoint, expectedSource) {
  const javascript = await readFile(entrypoint, "utf8");
  // SWC emits an external map directive on the final line of each entrypoint.
  const reference = /(?:^|\n)\/\/# sourceMappingURL=([^\s]+)$/.exec(javascript.trimEnd())?.[1];
  assert.ok(reference, "Entrypoint is missing its sourceMappingURL");
  assert.match(reference, /^[\w.-]+\.map$/, "Entrypoint must link to a local source map");
  const map = JSON.parse(await readFile(new URL(reference, entrypoint), "utf8"));
  assert.ok(
    map.version === 3 &&
      typeof map.mappings === "string" &&
      map.mappings.length > 0 &&
      Array.isArray(map.sources) &&
      map.sources.includes(expectedSource),
    "Entrypoint source map is invalid or missing its source",
  );
}
