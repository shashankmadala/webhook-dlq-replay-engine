# Agent Guide

## Project Purpose

This repository is a Node.js/TypeScript webhook Dead Letter Queue replay engine. It uses Fastify for HTTP APIs, SQLite for lightweight local persistence, and a background replay engine for retrying failed webhook deliveries.

## Working Rules

- Inspect the current architecture before broad edits.
- Do not write code during read-only planning or review passes.
- Keep edits scoped to the approved phase.
- Do not touch `codebase.md` unless explicitly asked.
- Run `npm run typecheck` and `npm test` after TypeScript changes.
- Run `npm run verify:runtime` after runtime or API verification changes.
- Keep SQLite schema/client changes explicit and migration-safe.
- Avoid route names that imply auth/admin unless the product actually has auth.
- Prefer small commits with conventional commit messages.
- Surface runtime mismatches instead of patching around them.

## Quality Gates

- `npm run typecheck`
- `npm test`
- `npm run verify:runtime`

## Architecture Notes

- Replay is async: ingestion validates and persists events; it does not deliver inline.
- Replay workers must use atomic claim ownership before delivery.
- Manual and bulk replay must not steal active claims.
- `/metrics` is JSON only; `/metrics/prometheus` is not implemented.
