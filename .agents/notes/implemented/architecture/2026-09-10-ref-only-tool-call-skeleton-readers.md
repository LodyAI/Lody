# Ref-only tool_call skeletons in every reader

Status: implemented
Translation: pending

## Abstract

The storage and hash layers already tolerated a sealed `tool_call` skeleton, but the
TypeScript type, the Zod input parser, the ACP history applier, the UI and the CLI export
still assumed `toolCallId` and `content` were always present, so a ref-only skeleton could
not be expressed without a cast and could be corrupted by an unrelated update. This change
makes `toolCallId` optional and adds `ref`, keeps the identity requirement at every
validation boundary, and teaches each reader to classify a skeleton from
`kind`/`status`/`locations`. Turning a full call into a skeleton (payload stripping, a
sealing writer, a derived `summary`/`live`, and the Machine RPC that fetches a payload) is
deliberately not implemented; `useToolCallPayload` stays an `unavailable` stub.

## Problem

A sealed turn stores a skeleton: `{ type: 'tool_call', kind, status, title?, locations?,
ref }`, with the execution payload (`content`/`rawInput`/`rawOutput`) left on the origin
machine. Three layers disagreed about it.

- `MessageContent` declared `toolCallId: string` and had no `ref`, so a skeleton only
  compiled through `as unknown as MessageContent`.
- The Loro schema `validate` accepted a ref-only item, but the Zod `ToolCallMessageSchema`
  still required `toolCallId`, and the `AllNestedMessageFieldsHaveAParser` compile-time
  guard in `history-writer.contract.ts` failed as soon as `ref` was added to the type —
  proof that the runtime parser and the type had drifted.
- `upsertToolCall` matched tool calls with
  `(m as ToolCallMessage).toolCallId === incoming.toolCallId`. When both sides omitted
  `toolCallId`, `undefined === undefined` matched and a replayed skeleton overwrote a
  stored skeleton — the exact "filtering/reordering breaks the position reference" failure,
  and one TypeScript cannot catch because comparing two optional strings is legal.

## Decision

The `tool_call` variant carries a `ToolCallIdentity` union, so the TypeScript type itself
requires at least one of `toolCallId` (full call) or `ref` (sealed skeleton); a full call may
also carry a `ref`. The runtime boundaries enforce the same rule:

- `history-writer.contract.ts` pins the type half with `@ts-expect-error` compile-failure
  checks for an identity-less tool_call and an explicit-undefined id.
- `MessageContentSchema.superRefine` rejects a tool call with neither identity. It lives on
  the union rather than on `ToolCallMessageSchema` because `z.discriminatedUnion` needs that
  object to stay a `ZodObject` (it is used with `.omit` in the writer).
- the Loro `validate` guard accepts `typeof toolCallId === 'string' || isToolCallRef(ref)`.
- `message-content-guards.ts` mirrors both for raw values.
- `history-writer.ts` omits `ref` from `ToolStateWriteSchema`, alongside `toolCallId`, so a
  changed payload pointer is an identity change that requires the complete item parser.

Reader paths treat a skeleton as a first-class item without inventing payload:

- `acp/history-apply.ts` skips non-string ids when indexing, resolving and merging, so a
  skeleton is never a merge target and an id-less replay appends like any unknown id.
- `tool-call-skeleton.ts` owns `isToolCallRef`, `isToolCallSkeleton` and
  `getToolCallStableId`. `isToolCallSkeleton` requires `ref` AND no
  `content`/`rawInput`/`rawOutput` (an empty `content` array counts as absent); `ref` alone is
  not the predicate, because a full call may also carry a `ref` and must keep rendering its
  payload instead of the "stored on <machine>" placeholder. Activity summaries and
  React/virtual keys use these guards, so a skeleton classifies from
  `kind`/`status`/`locations` and never renders the literal `undefined`.
- `use-tool-call-payload.ts` is an explicit `unavailable` stub; the card adds a
  "stored on <machine>" row. `session-export` writes `toolCallId: null` plus `ref`, and the
  transcript markdown renders the skeleton without an id line.

## Alternatives and explicit scope

- Declaring `summary`/`live` for sealed turns was rejected: they belong to the sealing
  writer. A test proves an unknown turn-level key is ignored on read and does not block an
  unrelated write, so readers stay safe without declaring a writer's private shape.
- Casting at each call site (the previous approach) was rejected: it left the type lying
  and hid the `undefined === undefined` merge bug.
- A separate `ToolCallSkeleton` union member was rejected: both shapes share the
  `tool_call` discriminant, so a second member would force every consumer to narrow twice.
- Not implemented: payload stripping, a skeleton-emitting writer, remote payload fetch,
  and any UI for a fetched payload.

## Evidence

- `packages/shared/src/{ai,message-schemas,schema,history-writer}.ts`,
  `packages/shared/src/acp/history-apply.ts`
- `packages/components/src/components/ai-gui/{tool-call-skeleton,use-tool-call-payload,message-content-guards,assistant-turn-render-blocks,view}.ts(x)`
- `apps/cli/src/lib/session-export/{formatters,markdown,types}.ts`
- Tests: `packages/shared/tests/{session-history-shapes,acp-history-apply}.test.ts`,
  `packages/components/tests/tool-call-skeleton.test.ts`,
  `apps/cli/src/lib/session-export/formatters.test.ts`, `apps/cli/src/commands/session.test.ts`
- Spec: [session history writes](../../../../specs/session-history-writes.md)
- Prior storage/hash decision:
  [versioned turn hashes and primitive metadata insertion](2026-09-10-versioned-history-hashes-and-primitive-metadata.md)
  (its "sealed-skeleton feature itself is not implemented" limit now applies only to the
  writer and payload fetch, not the reader).
