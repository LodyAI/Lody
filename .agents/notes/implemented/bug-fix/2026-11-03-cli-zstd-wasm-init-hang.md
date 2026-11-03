# Place CLI zstd.wasm beside the chunk that loads it

Status: implemented
Translation: current

[中文](2026-11-03-cli-zstd-wasm-init-hang.zh.md)

## Abstract

Nightly's CLI background process kept old Loro documents alive because snapshot
compression waited forever on zstd. The production bundle resolves `./zstd.wasm`
from the `chunks/` module that contains `@loro-dev/streams-crdt`, while packaging
copied the file next to the CLI entry. The wasm initializer also waited only for
success, so a missing or corrupt file left `modulePromise` pending and the upload
task retained its document. The wasm file now sits beside every emitted module
that references it. Initialization failure rejects and is not cached. A waiter
that times out leaves the in-flight runtime reusable. Releasing the upload's
await releases the document; the shared snapshot manager still keeps its adapter.

## Decision

`copy:wasm` places `zstd.wasm` next to each emitted JavaScript file whose source
contains `./zstd.wasm`. A bundle that does not contain that specifier fails the
copy instead of writing `dist/zstd.wasm`. Dev builds leave the package external,
so they keep resolving the file inside the package directory.

The patched `@loro-dev/streams-crdt@0.19.2` zstd loader rejects when reading,
fetching, compiling, or instantiating the wasm fails. Each caller also stops
waiting after 10 seconds. That timeout rejects only the waiter. The in-flight
instantiate keeps running, and a later caller joins it. Once Emscripten has set
`calledRun`, a later caller uses the runtime that already started and does not
call `Module.init` again. Instantiate callbacks capture the attempt that started
them, so a late success or failure from an old attempt cannot settle a newer one.
After a real failure, and before `calledRun`, the next attempt clears Emscripten's
run-dependency count and may instantiate again. Failed loads are not cached.
Successful initialization stays cached.

`TransportSnapshotManager.dispose` still only clears the debounce timer. The
manager is reused after a failed join and after reconnect, so dispose must not
drop `adapter`. `disposeJoinState` already marks the join closed before dispose;
once compression settles, `maybeUpload` returns without uploading. A caller-side
timeout around the same pending promise does not release the document, because
the suspended upload is what retains it.

## Consequences

An in-process retry after the runtime has already called `abort()` can still fail
to start, because that path sets Emscripten's `ABORT` flag. Missing and corrupt
files reject without that flag. This does not shrink an already-grown wasm linear
memory, and it does not change Loro's decoded-value cache.

## Verification

`apps/cli/tests/zstd-wasm-packaging.test.ts` covers placement. The relocated
runtime check stages the zstd entry in a `chunks/` directory: missing wasm
rejects and a document retained across that await becomes collectable; copying
the wasm beside the module then round-trips; corrupt wasm rejects twice without
an unhandled rejection. The same check holds `WebAssembly.instantiate` and fires
the captured 10 second timer directly. The hold is registered when instantiate
is called, and releasing it waits for the real compile, so a slow compile cannot
end the check early. The check keeps waiting through the `zstd.wasm` read
instead of stopping after a fixed number of event-loop turns. After that timeout, a later compress
round-trips from the original instantiate, a second instantiate is not started,
and the timed-out promise stays rejected. A stale timer from a failed or
late-failing attempt does not settle its replacement, which can then round-trip.
Overlapping compress calls share one instantiate and restore their own bytes.
The installed Nightly bundle was not rebuilt here.
