# The CLI creates the Streams it is the first to join

Status: implemented
Translation: current
PR: [#1680](https://github.com/LodyAI/Lody/pull/1680)

[中文](2026-10-18-cli-streams-create-missing.zh.md)

## Abstract

After the native Repo and Streams adoption, Sessions created by the CLI or by
an agent's `lody_session_create` ran normally on their machine, but another
client could never open them: their cloud Session stream did not exist, and
every bootstrap returned `stream_not_found`. The native `loro-repo` transport
defaults `createStreamIfMissing` to `false`, while the Legacy transport it
replaced defaulted to `true`. Only the renderer explicitly creates the Session
streams it starts. The CLI transport now sets the option to `true` again, so the
first join creates the stream and uploads the local state. That also covers Code
Collab file-index Flock streams. Sessions already stranded recover on their
next join from a daemon that has this fix. Their data was never lost locally.

## Incident

On 2026-10-18, four child Sessions created through MCP `lody_session_create`
on one machine could not be loaded from a desktop client on another computer.
The daemon log showed the same sequence for each one and for no other Session:
`Session dispatch not yet confirmed by Loro Streams (session.create:…:doc)`,
then `Session doc initial sync timed out, continuing offline-first` eight
seconds later, then an unbounded series of `stream_not_found` bootstraps. Of 153
local Session docs, exactly those four had no cloud Session stream cursor. Their
local snapshots and updates were intact. File-index (`fi`) Flock streams
returned the same 404 for parent Sessions as well. `stream_not_found` did not
appear in the two previous days of logs.

## Cause

[#1607](https://github.com/LodyAI/Lody/pull/1607) (see
[release adoption](../architecture/2026-10-16-streams-repo-release-adoption.md))
moved the CLI from `loro-repo` 0.22's Legacy Streams transport to the native
`makeStreamsTransport` in 0.23. The published packages show the default flip:

- 0.22.0 `dist/transport/streams.js` creates meta, doc and flock rooms with
  `createStreamIfMissing: this.options.createStreamIfMissing ?? true`.
- 0.23.1 `dist/effect/streams.js` uses
  `createStreamIfMissing: options.createStreamIfMissing ?? false`. The CRDT SDK
  documents the option as letting the initial join create the stream on a 404.

Neither Lody transport passed the option. The renderer still pre-creates the
Session streams it starts (`createRemoteStreamLegacy`), so Sessions started
from the UI kept working. Nothing pre-creates a Session started by the CLI or
MCP, or a Code Collab Flock doc. Their first join had always created the
stream, and after the upgrade it silently stopped doing so.

## Decision

`createCliStreamsTransport` sets `createStreamIfMissing: true`. This restores
the CLI's pre-upgrade behavior for every room it joins. The file-index Flock
TTL still applies, because the SDK passes `streamTtlSeconds` on automatic
creation too.

Alternatives considered:

- **Explicitly create the stream in the CLI create paths.** This would also
  have to cover Code Collab Flock docs and every future CLI-originated room, and
  it would not repair Sessions that are already stranded. Creating on join fixes
  all of them in one place.
- **Restore the default in the renderer as well.** The renderer's own Session
  starts are not affected. Whether its Flock rooms need the option is a separate
  question, and this fix does not decide it.

Trade-off: a CLI join of a room whose stream was deleted remotely recreates an
empty stream instead of surfacing the 404. That was the CLI's behavior before
the upgrade.

## Verification

`apps/cli/tests/cli-streams-replica-checkpoints.test.ts` drives the real CLI
transport against a scripted server that answers 404 until a stream-level PUT.
A Session doc join creates its stream and appends the local turn. A file-index
Flock join creates its stream with the retention TTL. Both tests fail with the
option set to `false`. Recovery of the four production Sessions has not been
observed yet: it needs a daemon with this fix to rejoin them.
