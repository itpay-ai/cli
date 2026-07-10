# CLI Src

## Purpose

Contain CLI commands, API client glue, render helpers, and local CLI state.

## Rules

- `commands/` owns orchestration
- `client/` owns HTTP and SSE access
- `render/` owns terminal output only
- `state/` owns local config and credentials only
