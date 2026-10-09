# Unified workbench implementation contract

Working repository: `/workspace/azrail-app`, branch `codex/azrail-unified-workbench`.
Baseline: GitHub main a47b688 + audited ZIP 1.4.0 overlay, preserving main-only files. Never publish or modify remote resources while implementing.
Goal: working first release for core, project plugins, and building applications. Russian UI. Existing authentication, ownership, idempotency, budget and verification protections must remain enforced.

## Coordination

Root owns integration files: `src/unified/entry.ts`, `schema.sql`, `src/types.ts`, package/build/deployment scripts, and final docs. Agents create SQL in separate migration files and tell root which Env fields and entry handlers to add. Do not edit root-owned files without agreement.

Frontend agent owns all `ui/` files and frontend tests; backend agents should publish endpoint contracts promptly. Preserve existing UI IDs when needed by meaningful tests, and update obsolete tests intentionally rather than hiding failures.

## Project/workspace API (workspace agent)

Export `workbenchRoute(request, env): Promise<Response|null>` from `src/unified/workbench.ts`.
- `/api/workbench/projects` GET: `{projects, nextCursor}` with `q`, `status`, `cursor`; POST `{name,description?}`: `{project}`.
- `/api/workbench/projects/:id` GET `{project}`; PATCH metadata with optimistic concurrency.
- `/api/workbench/projects/:id/files` GET `{files, sourceDigest, cursor?}`.
- `/api/workbench/projects/:id/file?path=...` GET `{path,content,sourceDigest}`; PUT `{path,content,baseDigest}`; DELETE `{path,baseDigest}`; rename may use separate `/rename` route.
- `/api/workbench/projects/:id/preview` GET `{html,sourceDigest,warnings}` for bounded STATIC preview (scripts must remain isolated/disabled unless a real separate runtime is used).
- `/api/workbench/projects/:id/runtime` POST `{action:'test'|'exec'|'preview',command?,port?}`: real sandbox adapter only, honour project permissions. Return explicit unavailable when not configured.
- Existing versions, memory, backups, chat, mission and Git APIs should be reused where safe. Provide adapters/new routes if active entry no longer exposes required old routes. Do not fake a successful runtime or verification.

## Artifacts/drafts (artifact agent)

- Preserve `/api/studio/artifacts` GET/POST and `/api/studio/image`; add optional project scope with ownership checks.
- Upload uses `X-Project-Id`, image JSON may contain `projectId`.
- `/api/studio/artifacts/:id` PATCH `{projectId}` links the existing artifact; DELETE removes with proper accounting.
- Artifact returns `{id,name,mime,bytes,url,projectId?}`.
- `/api/studio/drafts/:studio?projectId=...` supports project-scoped drafts, server CAS, and legacy unassigned data safely.
- Add persistent account storage quotas/reservations, idempotent cleanup, safe migration. Migration file `010-workbench-artifacts.sql`; root will merge fresh schema and migration runner.

## Plugins (plugin agent)

Export `pluginRoute` from `src/unified/plugins.ts`.
- `/api/plugins/catalog` GET `{plugins,connections}` for real built-in skills and operator-approved MCP integrations, no arbitrary executable package installation.
- `/api/workbench/projects/:id/plugins` GET `{plugins,revision}`; PUT `{baseRevision,plugins:[{id,enabled,connectionIds?,allowedTools?}]}`.
- Server validates project scope and allowed tool capabilities. Engine applies scoped tools and selected skills. Missing config defaults preserve compatibility but explicit configured policy must fail closed.
- Existing connector UI/API remain compatible; pending external actions can be shown directly in the workbench.
- Safely improve OAuth refresh if possible; no secrets in UI/model. Use `012-project-plugins.sql`.

## Models (model agent)

Export `modelSettingsRoute` from `src/unified/model-settings.ts`.
- `/api/workbench/models` GET `{models,configuration}` with capability/availability metadata, no credentials.
- `/api/workbench/projects/:id/model` GET `{settings,revision}`; PUT `{baseRevision,settings:{preferredModel?,reasoningEffort?,maxIterations?,maxCostUsd?}}`.
- Add current OpenAI model metadata verified by docs and a real bounded provider adapter. Preserve policy gating and cost reservations. Unknown tariffs/credentials => explicit unavailable. Do not invent that Gateway supports a model merely because OpenAI does.
- Settings must affect actual mission routing, not just storage. Agent may change router/policy and offer a server-derived normalization helper for root to call.
- Use `013-project-models.sql`.

## Frontend

Keep studio navigation. Add coherent project workbench (chat, files/editor/diff, static/runtime preview, tools, memory, versions, checks/settings) with clear unavailable states. Integrate endpoint contracts above. Fix delayed attachment read crossing projects and duplicate image save. Preserve all entered input across navigation, scope state by account/project, show errors without fake success. No mock production data.

## Validation

Use existing SQLite-D1 harness and happy-dom where useful. Add meaningful negative tests for ownership, CAS, quota, scope, duplicate effects. Root runs full check/build/browser tests after integration. Do not deploy or make paid model calls.
