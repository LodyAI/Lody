# Pinned unpublished streams-crdt

`streams-crdt.tgz` is the continuationOffset-capable pack from
`lody-e2ee-design/plans/artifacts/e2ee-p3/streams.tgz`.

- SHA-256: `a1314d8fbfaed381505001342d563993ae1f32c0682d9db8252c6f6eb97a391e`
- Source commit: `0bfe8493ce5ffaf342a593276f24ff457ea69492`
- Package version string inside the tarball is still `0.15.1`; this is **not**
  the npm registry 0.15.1 (which lacks continuationOffset).
- Do not alias a sibling `loro-streams` checkout.

Verify: `shasum -a 256 vendor/streams-crdt.tgz`
