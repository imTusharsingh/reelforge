import { rspack } from "@rspack/core";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL(".", import.meta.url));

export async function buildBrowserFixture() {
  const output = await mkdtemp(join(tmpdir(), "reelforge-browser-"));
  try {
    const compiler = rspack({
      context: directory,
      mode: "development",
      target: "web",
      devtool: false,
      entry: "./mounted-fixture.tsx",
      output: { path: output, filename: "fixture.js", cssFilename: "fixture.css" },
      resolve: {
        extensions: [".tsx", ".ts", ".js", ".json"],
        extensionAlias: { ".js": [".js", ".ts", ".tsx"] },
        alias: {
          "next/link$": join(directory, "next-link.tsx"),
          "next/navigation$": join(directory, "next-navigation.ts"),
        },
      },
      module: {
        rules: [
          { test: /\.tsx$/, use: swcLoader(true) },
          { test: /\.ts$/, use: swcLoader(false) },
          { test: /\.css$/, type: "css/auto" },
        ],
      },
    });
    const stats = await new Promise((resolve, reject) => {
      compiler.run((error, result) => {
        compiler.close((closeError) => {
          if (error || closeError) reject(error ?? closeError);
          else resolve(result);
        });
      });
    });
    if (!stats || stats.hasErrors())
      throw new Error(
        stats?.toString({ all: false, errors: true }) ?? "Browser fixture did not build",
      );
    return {
      js: await readFile(join(output, "fixture.js"), "utf8"),
      css: stats.compilation.getAsset("fixture.css")
        ? await readFile(join(output, "fixture.css"), "utf8")
        : "",
    };
  } finally {
    await rm(output, { force: true, recursive: true });
  }
}

function swcLoader(tsx) {
  return {
    loader: "builtin:swc-loader",
    options: {
      jsc: {
        target: "es2022",
        parser: { syntax: "typescript", tsx },
        transform: { react: { runtime: "automatic" } },
      },
    },
  };
}
