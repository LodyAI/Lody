# Agent Role descriptions

Status: draft
Translation: current

[中文](agent-role-description.zh.md)

A Role owner can write an optional description explaining when other agents
should call it. The editor shows this guidance and limits input to 140 Unicode
code points, including pasted text. The description is separate from the prompt
prefix: it is discovery metadata, not an instruction prepended to a new session.

Descriptions travel with the existing workspace Role row and appear in Role
discovery list/get results under the existing visibility rules. Missing fields
from older clients read as blank without a migration or version bump. Blank and
missing descriptions are equivalent for no-op saves; changing or clearing a
description advances the Role revision through the existing edit path.

Evidence: `packages/shared/src/agent-role.ts`, the Role editor and form helpers in
`packages/components`, and `apps/cli/src/lib/resource-discovery.ts`.
