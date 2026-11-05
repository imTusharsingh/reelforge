# Database package

`prisma/schema.prisma` and `prisma/migrations/**` are Core-owned. User-owned records carry a required `workspaceId`; relations between workspace children use compound workspace keys where practical to prevent cross-workspace references.

## Migration policy

- Add a new, timestamped migration for every schema change. Never edit a migration after it has been applied or merged.
- Generate migrations from the schema with `pnpm db:migrate:dev` in local development; review the generated SQL for tenant constraints, indexes, data safety, and lock behavior.
- Apply only committed migrations with `prisma migrate deploy` in CI and deployment. Do not run `db push` outside disposable local experiments.
- Do not seed production or call external providers from migrations, generation hooks, or schema validation.
- Destructive or data-transforming changes require an expand/migrate/contract plan and Core Reviewer review before integration.
- Migrations must be tested against a disposable PostgreSQL instance. The M00 migration gate uses the CI PostgreSQL service container.

## Client access

Use `createDatabaseClient(connectionString)` with a configured connection string. Importing the package or generating Prisma Client does not connect to a database. Repositories must receive verified workspace context and include that workspace key in every user-owned query. Never expose raw cross-domain database access as a module contract.

The baseline models cover identity membership, workspaces, channels, content series, assets, videos, posts, workflow runs, and an event outbox. Domain-specific tables and states remain owned by their assigned work packages.
