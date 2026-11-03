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
that references it, and initialization failure rejects, times out, and can be
retried. Releasing the upload's await releases the document; the shared snapshot
manager still keeps its adapter.

## Decision

`copy:wasm` places `zstd.wasm` next to each emitted JavaScript file whose source
contains `./zstd.wasm`. A bundle that does not contain that specifier fails the
copy instead of writing `dist/zstd.wasm`. Dev builds leave the package external,
so they keep resolving the file inside the package directory.

The patched `@loro-dev/streams-crdt@0.19.2` zstd loader rejects when reading,
fetching, compiling, or instantiating the wasm fails, and after 10 seconds if the
initializer never settles. Failed attempts are not cached. A failed attempt also
clears Emscripten's run-dependency count when the runtime has not started, so a
later attempt can succeed once the file is present. Successful initialization
stays cached.

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
an unhandled rejection. The installed Nightly bundle was not rebuilt here.
