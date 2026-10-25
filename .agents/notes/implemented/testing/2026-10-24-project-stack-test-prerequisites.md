# Project stack test prerequisites

Status: implemented
Translation: current

[Translation](2026-10-24-project-stack-test-prerequisites.zh.md)

## Abstract

Each Project stack layer must pass independently. Test repairs that existed only near the stack tip are moved to the runtime layer that introduces their dependencies, preserving production behavior and the assertions.

The machine registration assertion includes `multiRepoProject`; Session document fixtures expose `getMetaState`. Reopened Inbox stores use the same injected clock so startup expiration cannot erase the test batch. Electron tests use the existing relative TypeScript resolver from the stack tip, retaining Node resolution for bare and explicitly suffixed imports.

CI validates each branch independently; temporary checkouts without dependencies do not establish local runtime acceptance.
