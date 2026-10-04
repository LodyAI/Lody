# Synchronize simulator input and isolate native Git fixtures

Status: implemented
Translation: current

[中文](2026-10-04-cli-transport-fixture-isolation.zh.md)

## Abstract

CLI transport tests depended on WebSocket handshake ordering and inherited Git
state. Simulator input tests now await an upstream ping/pong before sending
touches, while recursive Git fixtures discard ambient Git/SSH variables and run
outside the repository executing the tests. Existing behavioral assertions remain;
timeouts and production transport behavior are unchanged.

## Evidence and decision

The simulator server's `connection` event fires before the gateway necessarily
processes the HTTP upgrade. Input received while its upstream is still connecting
closes the stream, leaving a test waiting for a forwarded touch. An automatic pong
from that upstream explicitly proves readiness without sleeps or retries. Apply
this barrier to paired touches and bottom-edge tests; the existing video round-trip
already synchronizes the ordinary touch test.

The native Git fixture previously filtered only selected configuration variables.
It still inherited `GIT_DIR`, askpass and SSH settings, and credential probes used
the caller's repository as their working directory. Supplying `GIT_DIR` reproduced
a fixture setup failure. The recursive clone test now deliberately supplies invalid
inherited repository/askpass paths and a conflicting SSH variant, then verifies the
real recursive checkout with a sanitized environment and explicit fixture cwd.
This covers environment contamination; the precise environment behind the reported
`access_denied` failure was not captured. The synthetic broker still returns 503,
and the SSH fixture still serves local repositories without GitHub access.

## Verification and scope

Both targeted suites passed (22 tests). These checks exercise local WebSockets and
native Git, not production GitHub access or a real simulator. Related owners:
[GitHub fallback](../architecture/2026-10-03-github-identity-fallback.md) and
[simulator gestures](../feature/2026-10-03-ios-simulator-two-finger.md).
