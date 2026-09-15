# E2EE demo

Local-only reference app. Not product E2EE, not Lody integration.

- Public core/streams-crdt APIs only. This package must not be imported by
  `@lody/e2ee-core`. No Convex, Cloudflare, MLS, or new crypto.
- Official `@loro-dev/sqlite-riverrun` on an explicit data directory. Do not
  substitute `bench/ds-cas-server.ts` or an in-memory mock for the demo host.
- Control writes: verify signature and current permission, then Streams CAS.
  Persist exact pending bytes before CAS; dropped ACK confirms by read-back
  without re-signing. Pending is not committed authority.
- Credential `expiresAt` is the original observed deadline. Cache, queue, and
  restart must not extend it. `now == expires` is expired.
- Historical admitted snapshots stay readable after later revoke. Revoke does
  not erase epoch keys already delivered.
- Bindings: [ledger spec](../../specs/e2ee-ledger.zh.md) and this README.
