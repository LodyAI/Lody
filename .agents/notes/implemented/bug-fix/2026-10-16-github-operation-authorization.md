# Separate GitHub operation authorization from login linking

Status: implemented
Translation: current

[中文](2026-10-16-github-operation-authorization.zh.md)

## Abstract

The personal GitHub setting used account linking, which could reject users whose
GitHub and application emails differed and also added a login identity. It now
requests operation-only authorization through the cloud capability. The browser
retains a PKCE verifier and completes the return under its authenticated user;
native clients continue handing off to browser settings. This changes authorization
only; the existing commit-author selection policy stays independent.

## Decision and responsibilities

This supersedes the browser-linking part of the
[authorization-entry fix](2026-10-11-github-personal-authorization-entry.md).
The shared hook calls dedicated begin/complete operations, and the proof helper
stores one pending verifier in sessionStorage. It consumes the callback once and
removes temporary callback data from history before requesting completion.
Settings never invokes social sign-in or account linking for operation access.

Browser desktop settings is a modal over chat or a session: its current URL cannot
be used as the OAuth return destination. Initiation constructs the canonical GitHub
settings URL; the desktop settings route preserves the authorization fragment while
opening the modal and navigating back to chat. Native clients still open browser
settings without transferring tokens or application credentials in the URL.

The cloud implementation must store operation credentials separately from login
accounts and bind completion to the initiating user, workspace and PKCE proof.
The public client declares only the operation DTOs and capability descriptors.
Existing login-derived authorization requires explicit authorization again after
the service cutover. No broader account-linking email policy is relaxed.

## Verification limits

Deterministic browser proof and settings tests cover matched/invalid returns,
single consumption, native handoff and the local capability gate. Backend tests
cover differing emails, replay, identity/workspace/expiry fences and credential
refresh generations. Actual GitHub OAuth and native browser round-trips require
live smoke validation; no deployment is claimed by this note.
