# MCP tool discovery on the current settings surface

Status: implemented
Translation: current

[中文](2026-09-30-mcp-tool-discovery-merge.zh.md)

## Abstract

PR #905 conflicted with newer daemon capabilities, session tool RPC, and the settings UI migration. The merge preserves both RPC methods and all capability declarations, and adapts explicit MCP discovery to the current StyleX settings rows and UI primitives. Opening Settings still does not probe a server; Save and Load tools remain the triggers. Empty inventories now display the existing empty-result message instead of being hidden by the old row condition.

## Integration

Keep discovery below the row actions, retaining the current description, edit, default toggle, and remove controls. Use the existing Spinner and Badge APIs rather than restoring obsolete component props. Preserve the main-branch preview-routing test's assertion that local preview does not resolve another transport.

The catalog durability rule is unchanged; see [catalog durability](../../../docs/workspace-catalog-durability.md). No protocol version or discovery authorization changes are introduced by conflict resolution.

PR: https://github.com/LodyAI/Lody/pull/905

## Validation

The four affected suites pass all 35 tests. Full workspace typechecking, lint, formatting, translation keys, documentation, and public/platform/import boundary checks pass. The full check stops at the unrelated workspace Git service remote-backfill test under the session's Git URL rewrite; all six tests in that suite pass when rerun with standard Git and without the injected URL rewrite. Packaged desktop rendering and live third-party MCP connections were not exercised.
