# Native machine-sharing host

Root rules apply. This package is host-only; renderers use the narrow platform
methods. Policy crypto remains in e2ee-core. DTOs remain in cloud-api.

- Keep complete originals and request identity before any commit. Unknown results
  reconcile the original request before retrying; confirmed conflicts never rebase.
- Derive generation only from core-verified local admission originals. Scope originals,
  requests, pins and caches by generation; never migrate grants on readmission.
- Persist resource-bound high water and ciphertext, never credentials or freshness.
  Restart requires authenticated latest reads. Historical steps grant no execution.
- Recheck the current ledger and actual local project before admitting new work.
  Known withdrawal denies immediately; unknown changes have a RAM-only read-start
  lifetime strictly shorter than 15 minutes on wall and monotonic clocks.
- A verified denial in the accepted pin stays known through failed refreshes and restarts;
  only a newer verified head releases it. It needs only historical issuer authority, so a
  later signer revocation does not void it. It never grants execution.
- An authenticated read finding no policy for the current generation, or its removal, is
  the private default and a known denial, never an unknown outcome.

- `inspectCache` observes retained RAM objects only. It never initializes a lazy
  owner, reads a clock, refreshes a policy or establishes current authorization.

- Preserve RAM policy freshness on unchanged verified ledger heads/counts. Invalidation
  fences both issued grants and in-flight reads; late results never refill a retired cache.

- Reuse fresh cached grants. Before a cached machine/project sharing refusal, refresh
  the authenticated policy with per-binding concurrent sharing and a five-second
  read-start cooldown. Failed attempts never supply policy evidence or advance pins.
