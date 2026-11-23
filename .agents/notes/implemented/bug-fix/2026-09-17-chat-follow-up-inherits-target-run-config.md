# Chat follow-up inherits the target Session's last run config

Status: implemented
Translation: current

[中文](2026-09-17-chat-follow-up-inherits-target-run-config.zh.md)

## Abstract

A follow-up prompt to an existing Session (`lody_session_chat`, CLI `session chat` without
`--model`/`--mode`, and review-automation chat) wrote a new user turn with no model and, for
builtin agents, injected the builtin default mode. The composer then treated that empty turn as
the latest preference and fell back to the catalog default. Follow-ups that omit mode, model, and
config options now copy those fields from the target Session's last user turn that recorded a
model. Explicit overrides still win; incompatible inherited selectors are dropped.

## Problem

`sendSessionChatResult` did not read the target Session's history. MCP chat has no model
parameter, so it passed an empty dispatch config. The new turn's `inputConfig` therefore omitted
`modelId`, and `withBuiltinDefaultTurnMode` filled a default mode. Conversation config is not
sticky for model the way Role is, so the UI and a later recycled ACP `session/new` both saw the
catalog default instead of the model the user had already chosen on that Session.

The comment on `ResolvedTurnDispatchConfig.runConfig` claimed a follow-up "keeps the settings the
session was created with." That was aspirational: the chat path neither copied the create-turn
config nor the last selected one.

## Decision

Inheritance is per target Session, not from the requester. The source is the newest matching user
turn that recorded a `modelId`; if none exists, the newest matching turn's mode/options still
apply. A prior model-less follow-up must not hide an earlier selected model. Explicit CLI
`--model`/`--mode`/`--config-option` still validate and win. Inherited selectors that the current
capability no longer offers are dropped rather than failing the follow-up. Builtin default mode
applies only when both the request and the inherited turn left mode empty.

`taskToolsEnabled` comes only from the current caller; chat inheritance explicitly selects
mode/model/options and excludes historical consent even when the caller omits it. Semantic
`runConfig` remains create-only. Review correction: the initial generic merge did inherit
historical consent when omitted, contrary to the intended boundary.

An explicit model change drops all inherited config options, retaining inherited mode and
the caller's explicit options. The capability probe describes its current model, so it cannot
prove that old reasoning/Fast values work on the new model. Dropping the old option map is
conservative and also resets model-independent options; selecting the same model retains them.

PR: [#771](https://github.com/LodyAI/Lody/pull/771).

Review correction for omitted-model follow-ups: inherited effort is checked against
`modelReasoningEfforts` for the inherited model, including an empty supported list.
When the probe describes a different or unknown model, its option list cannot reject
the recorded effort/Fast controls. Without per-model evidence, preserve those controls
for runtime validation; ordinary options still use the snapshot compatibility filter.

Explicit option validation also runs after the effective model is resolved. This lets a raw
`--config-option` effort use an inherited model's per-model effort list instead of the probe
snapshot. Explicit config options in the mode/model categories suppress inherited top-level
selectors, matching the runtime rule that a top-level selector otherwise takes precedence.

## Alternatives

Copying the requester's model would send the parent's model onto a child that may use a different
agent. Requiring MCP callers to pass `modelId` would fix new calls but not existing coordinators
and still leave CLI chat without flags wrong. Relying on a live ACP process to remember the model
fails after idle recycle and still blanks the composer.

## Verification

Unit tests cover history walk (skip assistant and other-agent turns, prefer the last recorded
model, fall back to a mode-only turn) and merge (omitted fields inherit, explicit model keeps
inherited mode/options, incompatible inherited model/mode are dropped, builtin default mode fills
only an empty mode). Live parent-to-child MCP chat is not exercised in this change.
Regression tests reproduce the two review findings before the fix and cover omitted/false/true
caller consent, model changes, same-model inheritance, and explicit replacement options.
Additional regressions cover target-only valid effort, probe-only invalid effort, missing
per-model data, and Fast absent from the probe's option list.
The final regressions cover explicit effort with an inherited model, invalid effort rejection,
an explicit model option selecting the validation target, and mode/model option precedence.
