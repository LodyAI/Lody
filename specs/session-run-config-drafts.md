# Private session run-config drafts

Status: draft
Translation: current

[中文](session-run-config-drafts.zh.md)

## Scenario and intent

In an existing session, a person enables or disables Fast, visits another tab,
and returns before sending. Their choice remains theirs, just like unsent text.
Another device's new Turn changes the shared baseline but does not clear this
device's unsent settings. This private-draft behavior is the selected product
direction for [PR #1287](https://github.com/LodyAI/Lody/pull/1287); this document
revision remains draft rather than claiming formal approval.

## Responsibilities

- Effective configuration is derived from private field edits, runtime state,
  accepted/queued Turn preferences, and capabilities. No resolved configuration
  is stored as another authority.
- Only actual edited fields create a retained draft entry, scoped to account,
  workspace and session. Explicit false and repeated same-value choices are edits.
  No conversation history or lifetime set of visited Turn IDs is retained.
- Each field edit has a new generation. A send captures generations only for
  fields included unchanged in its final frozen inputConfig.
- Successful local admission retires exactly those captured generations. It
  means either a completed local Turn write or admission to the existing held-send
  queue. It does not wait for upload completion, remote delivery or a model reply.
- Acknowledgment is bound to the original scope and works after unmount. A newer
  edit, including a same-value edit, must survive. Failed admission consumes none.
- A held send already owns frozen configuration. Later upload failure keeps that
  pending entry and its retry controls; promotion does not acknowledge again.
- Deletion, explicit discard and authoritative account teardown clear owned
  intent. In-flight old callbacks cannot recreate it or clear another account's
  new draft. Missing metadata during loading is not confirmed deletion.
- A confirmed agent/provider change retires the abandoned target's draft and edit
  callbacks. Missing target metadata during hydration is not a confirmed change.
- Ordinary tab/workspace navigation and reversible archive retain intent. No
  arbitrary TTL or LRU evicts real unsent choices. Drafts are in memory only and
  do not survive application restart.
- Unknown Role catalogs plus manual draft edits must not attach inherited Role
  provenance or a memory provider to a Turn that cannot be verified as that Role.

## Evidence and limits

Implementation and deterministic tests belong to the shared components package.
The [decision note](../.agents/notes/implemented/bug-fix/2026-10-07-session-run-config-drafts.md)
records verification and remaining environment limits. This contract changes the
previous implicit policy that new remote Turns could acknowledge local edits.
It does not alter the shared session protocol or provider execution semantics.
