# Unknown workspace mode and content egress

Status: implemented
Translation: current

[中文](2026-10-29-unknown-workspace-egress.zh.md)

## Abstract

A provisionally opened ordinary runtime could transmit content before authenticated workspace classification. Rejecting the upload afterwards cannot retract its request body. Local Repo access now remains available while ordinary transports, RPC, attachment preparation, sharing and exports wait for classification. Send acceptance also waits, preserving the original composer input if an encrypted answer retires the ordinary runtime. Retained immutable ordinary admission keeps its offline behavior.

## Decision and ownership

This partially replaces the transmission trade-off in the [bootstrap decision](../feature/2026-10-17-e2ee-workspace-bootstrap.md#invisible-until-enabled-correction), preserving its local availability rationale. A cached workspace ID, missing encryption marker or unloaded listing is not plaintext authority. An authenticated descriptor or its retained account/workspace proof supplies classification; contradictory encrypted evidence still wins. Classification does not grant device approval, keys or execution authority.

The provider initialization owns the mode read and its result. Its provisional runtime owns cancellable outbound waiters. Retirement, disposal and authentication replacement prevent a late result from reviving an old ordinary path. A failed lookup leaves local content readable without admitting outbound work. A denial or transport failure belongs to one read attempt, not a permanent runtime verdict. A later send or online edge can share a fresh verification; a matching newly retained ordinary/legacy proof can also release admission after the same evidence checks. Successful recovery resumes synchronization on the same Repo. A failed admission acquired no local transport, so that attach can be retried; an actual attach remains single-flight and owned through settlement. Source bytes remain in the composer until send acceptance succeeds; a pending send is not consumed into a provisional plaintext namespace that an encrypted runtime cannot read.

The runtime gates transport attachment and both cloud and local-machine requests because a local daemon can forward ordinary content. Direct HTTP attachment admission remains enforced at its own request boundary. Sharing retains its captured runtime/account/selection through retries and rechecks before each publication boundary. A verified encrypted workspace uses its existing protected host and explicit decrypted-copy consent; classification never creates a plaintext fallback.

Holding the entire workspace behind a network lookup loses offline local access. Treating a backend 403 as confidentiality enforcement discloses a request body before the server can reject it. A caller-supplied mode flag or a UI-only disabled button cannot replace operation admission.

This is a bounded change to the existing React/Promise runtime composition. Its surrounding resource and transport owners remain unchanged; no new Effect execution boundary or native migration is claimed.

## Evidence and limits

The runtime lifecycle suite keeps a real local Repo editable before classification and inspects document bytes at its desktop transport boundary. The send suite checks retained input across failure and explicit retry. Publication tests inspect withheld operations across encrypted answers, lookup failure and account replacement. Existing retained-proof and local-only runtime cases preserve offline behavior.

These are synthetic component, Repo and adapter checks. Installed clients, deployed services, telemetry remediation, native custody and cross-device product acceptance remain separate evidence.
