# Accept the first Nightly release in a version cycle

Status: implemented
Translation: current

[中文](2026-09-29-nightly-zero-sequence.zh.md)

## Abstract

The download manifest parser required a positive Nightly suffix, making a valid
`-nightly.0` release unavailable on the download page. It now accepts zero and
positive integer sequences without leading zeros. All six immutable installer
links must still match the manifest version; the display sequence does not stand
in for the native build number.

## Evidence and limits

`site-docs/lib/nightly-downloads.test.ts` covers complete installer links for zero
and subsequent releases, legacy positive sequences, and malformed counters.
The [channel contract](../../../../specs/desktop-channel-execution.md) records
the accepted manifest format. This parser change does not deploy the public site
or establish packaged update compatibility.
