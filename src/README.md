# CLI Src

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. Under that one product entry point, the two top-level commerce actions are `buy` and `sell`: Buyer workflows are available now; Seller workflows will use the same entry point and are not implemented yet.

## Purpose

Contain CLI commands, API client glue, render helpers, and local CLI state.

## Rules

- `commands/` owns orchestration
- `client/` owns HTTP and SSE access
- `render/` owns terminal output only
- `state/` owns local config and credentials only
