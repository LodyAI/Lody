# Same-process E2EE client-loss probe

Status: implemented
Translation: current

[中文](2026-10-30-e2ee-client-loss-probe.zh.md)

## Abstract

Desktop journeys J07/client and J08/client must show that, after a member is removed
or a device is revoked, the same desktop process stops reading, sending and starting
turns. The product had no read-only observer for that. Unpackaged `LODY_E2E=1` builds
now expose `e2ee.inspectClientLoss(workspaceId)`, a version 1 snapshot made of native
E2EE handler counters, refusal rows, reader counts and renderer transport effects.
Packaged builds neither count, register the channel, nor admit it in preload.

## Decisions

**Registration.** The channel pair is registered directly in `registerIpcServices`
rather than as an `@IpcMethod`, because service methods are always registered. Main
alone decides the gate (`!app.isPackaged && LODY_E2E === '1'`). It passes that decision
to each window as an argument, and preload derives both channel admission and the
renderer flag from the argument. A preload environment check could disagree with main's
`isPackaged`.

**Native counters.** The counters wrap the actual handler promises of `openContent`
(`read`), `seal`, `prepareDispatch`, `acceptDispatchResponse` (`dispatchResponse`),
`open`, `refresh`, `contentStreamsToken` (`token`) and `close`. Rows are scoped per
cached account, workspace and renderer sender, and one monotonic sequence spans the
whole process. A rejection whose message is exactly `e2ee_member_removed`,
`e2ee_device_revoked` or `e2ee_not_open` is recorded as a refusal. The first two also
record an authoritative row that copies the counters and latest effects at that moment,
so later activity cannot rewrite the cut. Unknown errors count as rejections and are
discarded. Rows survive owner retirement and are bounded: 64 scopes, 128 rows per list.
`readers` is a synchronous read of the account owner's reader map; it never waits on
the account lock or opens an owner.

**Transport effects.** The content SDK (`StreamsTransportAdapter`) accepts no fetch
hook, so HTTP appends cannot be observed without an SDK change. Effects are therefore
counted at the closest boundaries the product owns:
- `contentWrites` and `contentReadEvents` count completed provider `seal`/`open` calls
  that the live transport makes for each protected frame.
- `turnStarts` counts encrypted dispatch requests whose frame the stream client
  actually appended. A settled `send()` is not counted, because the channel turns an
  append failure into a `null` receipt.
- `activeContentStreams` counts cloud transports attached and not yet removed with a
  confirmed result. A removal that rejected stays counted.
- `transportOwnerClosed` is true only when runtime disposal fulfilled and no stream,
  pending write or pending dispatch remains. A disposal that destroyed the Repo but
  then threw never reports closed.

The renderer pushes a closed seven-field DTO after each change. Main validates it
strictly and attaches the scope from the sender and cached account.

## Limits and product gaps

- The desktop maps the server's `e2ee_device_revoked` to a generic `unauthorized`
  backend error and has no device-revocation fence. A J08/client run therefore cannot
  find an authoritative `e2ee_device_revoked` row and stays
  `removal_not_authoritatively_confirmed` until a product change types and fences
  that code. The CLI already types it (`CloudE2eeDeviceRevoked`).
- `turnStarts` measures the client's appended turn dispatches, not ACP starts in a
  daemon process; daemon-side execution is guarded and tested in the CLI.
- Packaged runs (`LODY_ACCEPT_CLIENT_LOSS=1` in the private harness) cannot use the
  probe.
- Unit and component tests cover the counters, scoping, bounds, provider, dispatch
  append and runtime close paths. No live Electron journey has been run here.
