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

- `inspectCache` observes retained RAM objects only. It never initializes a lazy
  owner, reads a clock, refreshes a policy or establishes current authorization.
