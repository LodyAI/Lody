# Make repository connection failures actionable

Status: implemented
Translation: current

[中文](2026-10-09-github-repository-connection-guidance.zh.md)

## Abstract

A recorded PR can remain visible while its workspace GitHub connection cannot be
confirmed. Repeated execution errors and a retry-only notice do not explain what
users can repair. The UI now gives localized administrator instructions and opens
GitHub settings, including when old PR details are cached. Authorization and the
existing repository cooldown remain intact; production installation recovery is
not validated by the component fixtures.

## Decision and responsibilities

This extends the [observation/association correction](../../proposed/bug-fix/2026-10-01-pr-observation-association.md).
Machine GitHub access proves the observation, not the workspace’s App connection.
The existing identity gate emits a typed error; the shared presentation helper
also recognizes the token boundary’s `repo_not_linked` code. PR and review surfaces
use the existing settings opener, preserving desktop dialog and mobile routing.
The PR view hides cached details and mutation affordances while this known block
is active, retaining its cache and comment draft for recovery. Ordinary network
errors keep their existing presentation.

The optional cloud association HTTP contract stays non-successful for rejected
links, so existing clients retain their 15-minute cooldown. No new synchronized
state, schema, polling loop, or toast is introduced. Treating the rejection as HTTP
200 was rejected because older clients use `response.ok` as confirmation. A settings
button repairs configuration only; Retry still uses safe identity repair and never
bypasses canonical association or its background cooldown.

## Verification

Focused PR view/container, identity/details, review-comment and diff-panel suites
cover blocked reads/writes, localized guidance, settings routing, cached-ready
rejection and recovery. The existing association client suite verifies HTTP 403
cooldown and recovery. Component typecheck passes. Browser verification uses the
real PR error story; it does not exercise a production workspace or installation.

Contract: [Local PR observation](../../../../specs/local-github-pr-observation.md).
