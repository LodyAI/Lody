# Recover silently from a Convex disconnect while fetching a GitHub operation token

Status: implemented
Translation: current
PR: not created

[中文](2026-09-10-github-operation-token-reconnect.zh.md)

## Abstract

When a user clicks Merge on a pull request, the client can lose its connection during the Convex
Action that obtains the GitHub operation token. No merge request has reached GitHub at that point,
yet the interface reported the underlying connection error as "merge failed". The token request is
now retried once, silently; if the retry hits the same disconnect error, the Merge button becomes
usable again and the technical error is not shown. Real merge failures returned by GitHub are still
surfaced as before, and the retry count stays at one so a persistently unavailable network cannot
hide an unbounded wait.

## Decision and scope

- Retry only `Connection lost while action was in flight`, and only for fetching the operation
  token; it happens before any GitHub write, so a repeated request cannot merge twice.
- Once the retry is exhausted, suppress only this Convex transport error's merge toast; the request
  is still recorded by analytics events, and other token, permission and GitHub merge errors are
  still shown to the user.
- Do not query GitHub for merge status: the error point precedes the GitHub merge request, so there
  is no "already merged but unknown to the client" state.

## Evidence and limits

A token unit test covers a successful retry after a disconnect, and a PR container test covers the
absence of a toast once the retry is exhausted. This change does not establish why a particular
user's network, proxy or Convex backend disconnected; under a persistent disconnect the user can
click Merge again.
