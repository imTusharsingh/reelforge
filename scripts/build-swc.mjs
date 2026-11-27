import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "@swc/core";
import ts from "typescript";

const config = ts.getParsedCommandLineOfConfigFile(
  "tsconfig.build.json",
  {},
  {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: failDiagnostics,
  },
);

if (!config) throw new Error("Cannot load tsconfig.build.json");
if (config.errors.length) failDiagnostics(config.errors[0]);

const { rootDir, outDir, experimentalDecorators, emitDecoratorMetadata, sourceMap } =
  config.options;
if (!rootDir || !outDir || dirname(outDir) !== process.cwd() || basename(outDir) !== "dist")
  throw new Error("Expected a package-local src and dist");

const stage = await mkdtemp(join(dirname(outDir), ".dist-swc-"));
try {
  // Preserve package exports, declaration accuracy, and TypeScript's build-time checks.
  const tsc = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
  const declarations = spawnSync(
    process.execPath,
    [tsc, "-p", "tsconfig.build.json", "--emitDeclarationOnly", "--outDir", stage],
    { stdio: "inherit" },
  );
  if (declarations.error) throw declarations.error;
  if (declarations.status !== 0) throw new Error("TypeScript declaration build failed");

  // Wait for every write to settle before removing a failed staging directory.
  const results = await Promise.allSettled(
    config.fileNames.filter((file) => !file.endsWith(".d.ts")).map(emit),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  await rm(outDir, { recursive: true, force: true });
  await rename(stage, outDir);
} finally {
  await rm(stage, { recursive: true, force: true });
}

async function emit(file) {
  const name = relative(rootDir, file);
  if (!name.endsWith(".ts") || name.startsWith(".." + sep) || isAbsolute(name))
    throw new Error(`Unsupported build input: ${file}`);
  const output = name.replace(/\.ts$/, ".js");
  const stagedFile = join(stage, output);
  const { code, map } = await transform(await readFile(file, "utf8"), {
    filename: file,
    sourceFileName: relative(dirname(join(outDir, output)), file)
      .split(sep)
      .join("/"),
    swcrc: false,
    configFile: false,
    sourceMaps: sourceMap ?? false,
    jsc: {
      target: "es2024",
      parser: { syntax: "typescript", decorators: experimentalDecorators ?? false },
      transform: {
        legacyDecorator: experimentalDecorators ?? false,
        decoratorMetadata: emitDecoratorMetadata ?? false,
        verbatimModuleSyntax: true,
      },
    },
    module: { type: "es6" },
  });
  await mkdir(dirname(stagedFile), { recursive: true });
  await writeFile(stagedFile, map ? code + `//# sourceMappingURL=${basename(output)}.map\n` : code);
  if (map) await writeFile(stagedFile + ".map", map);
}

function failDiagnostics(diagnostic) {
  throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}
