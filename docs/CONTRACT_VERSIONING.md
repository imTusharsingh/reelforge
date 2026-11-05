# Shared Contract Versioning

`packages/contracts` is owned by the Core Architect/Reviewer. Its schemas, event registry, and exported types are the source of truth for cross-module DTOs and events.

## HTTP/API contracts

- HTTP routes are explicitly versioned under `/api/v1`. `ApiVersionSchema` represents the v1 contract version in code.
- Validate inbound and outbound data at process boundaries with the shared runtime schemas. Do not accept unchecked casts as validation.
- Breaking changes require a new API version and a migration window approved by Core. Additive changes may remain in v1 only when they do not alter existing semantics or validation.

## Events

- An event is a registered `eventType` plus positive integer `eventVersion`; every payload is validated using the matching registry schema before publish and after consume.
- Envelope fields include event ID, UTC occurrence time, workspace ID, optional channel and causation IDs, correlation ID, aggregate identity, and payload. Never place credentials, signed URLs, or unnecessary personal data in an event.
- Producers must persist an outbox row and a stable idempotency key with the domain transaction before dispatch. Consumers deduplicate and record processing outcomes.
- Breaking payload changes require a new event version; do not mutate old schemas. Consumers may support multiple versions during rollout. Event names and payloads are Core-owned.
- Retire an event/version only after Core confirms no producer or consumer depends on it and the deprecation is recorded in the work log.

The M00 registry contains `PostPublished` and `PublishFailed`, the events explicitly named in the canonical publishing pipeline. Their first payload schemas are baseline proposals for Core review.
