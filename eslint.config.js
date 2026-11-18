import tseslint from "typescript-eslint";
import { readFileSync } from "node:fs";
const sizeBaseline = JSON.parse(
  readFileSync(new URL("./eslint-size-baseline.json", import.meta.url), "utf8"),
).files;

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/node_modules/**",
      "**/.local-data/**",
      "packages/database/prisma/src/generated/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "max-lines": ["error", { max: 400, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["error", { max: 60, skipBlankLines: true, skipComments: true }],
      "@typescript-eslint/explicit-function-return-type": "error",
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  ...Object.entries(sizeBaseline).map(([file, limits]) => ({
    files: [file],
    rules: {
      "max-lines": ["error", { max: limits.lines, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": [
        "error",
        { max: limits.functionLines, skipBlankLines: true, skipComments: true },
      ],
    },
  })),
  { files: ["**/*.test.ts", "**/*.fixture.ts"], rules: { "max-lines-per-function": "off" } },
);
