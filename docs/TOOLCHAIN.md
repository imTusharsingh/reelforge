# ReelForge build tooling

Use the repository's pinned Node and pnpm versions. Existing entry points remain
`pnpm build`, `pnpm lint`, `pnpm format`, `pnpm format:check`, `pnpm typecheck`,
and `pnpm test`.

| Target | Tool | Why |
| --- | --- | --- |
| Next.js Studio | Turbopack (Next.js 16.4.5) | Keeps the App Router, production page generation and API rewrites on Next's supported build path. Next's Rspack integration is experimental; Rsbuild would be a separate application build, not a drop-in replacement for Next. |
| NestJS API and queue worker | SWC 1.16.22 | Emits native ESM with legacy decorators, injection metadata, source maps, and existing `dist/` entry points. Bundling the two processes would add dependency-externalization and runtime-resolution risk without providing a deliverable the services need. |
| Shared workspace packages | SWC 1.16.22 | Keeps one JS file per source module and all existing subpath exports. The same build reads each package's current TypeScript build config and preserves its inclusion/exclusion rules. |
| Local account browser fixtures | Rspack 2.3.4 | The standalone TSX fixture actually needs a browser bundle. Rspack plus its built-in SWC loader replaces the direct esbuild integration, uses the same local Next stubs, and cleans up its temporary output. Rsbuild is useful for full front ends but would add configuration layers to this single fixture. |
| Linting and formatting | Oxlint 1.95.0 and Oxfmt 0.80.0 | Retains existing TypeScript and size checks, scoped size exceptions, and the existing 100-column style. No import or package-key sorting. |

### What stays

- TypeScript still checks types and emits real declarations for Node packages. SWC
  emits JavaScript; it does not replace the type system or package declarations.
- Prisma still owns client generation and migrations. FFmpeg, FFprobe and Aeneas
  are runtime tools and are unchanged.
- Keep Vitest and Playwright. The pinned Vitest/Vite stack already uses Oxc and
  Rolldown for transformation and bundling. An indirect esbuild dependency in
  Vite's lockfile is not a ReelForge build or script.
- Biome 2.6.9 preserved the spacing fixture too. Its default parser rejects the
  Nest parameter decorators; opt-in works. Oxfmt was closer to the previous format
  on this codebase, and Oxlint carries the existing lint rules without maintaining
  a second formatter or configuring two lint systems.

### Formatting

Leave one blank line between functions and to separate related groups of
variables. Oxfmt preserves those intentional single blank lines; it doesn't insert
blank lines based on guessing which variables belong together. Multiple adjacent
blank lines may collapse. `pnpm format:check` runs the spacing regression and the
lint guard smoke. The staged hook applies native lint fixes and then formatting.

### References

- [Next.js Turbopack](https://nextjs.org/docs/app/api-reference/turbopack)
- [Next.js experimental Rspack integration](https://nextjs.org/docs/community/rspack)
- [NestJS SWC](https://docs.nestjs.com/recipes/swc)
- [Oxlint migration](https://oxc.rs/docs/guide/usage/linter/migrate-from-eslint)
- [Oxfmt migration](https://oxc.rs/docs/guide/usage/formatter/migrate-from-prettier)
