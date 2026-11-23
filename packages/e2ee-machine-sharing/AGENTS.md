# Machine-sharing host

Root rules apply. The host core is platform-neutral: it imports no Node API, and
SQLite lives only in the `./sqlite` subpath (desktop and CLI); browsers and webviews
use the `./indexeddb` subpath. It still runs only inside trusted host composition;
renderers use the narrow platform methods. Policy crypto remains in e2ee-core. DTOs
remain in cloud-api.

- Storage goes through the `MachineSharingStore` port. Every store step runs its
  decision synchronously inside one transaction against committed state, and an update
  resolves only after its write is durable. Pin and request decisions stay in the host,
  not in a store, so every store enforces the same rules.

- Keep complete originals and request identity before any commit. Unknown results
  reconcile the original request before retrying; confirmed conflicts never rebase.
- Derive generation only from core-verified local admission originals. Scope originals,
  requests, pins and caches by generation; never migrate grants on readmission.
- Persist resource-bound high water and ciphertext, never credentials or freshness.
  Restart requires authenticated latest v3 reads. Verify only the latest original against
  a historically admitted owner-personal signer and local high-water pin; revision gaps are allowed.
- Recheck the current ledger and actual local project before admitting new work.
  Known withdrawal denies immediately; unknown changes have a RAM-only read-start
  lifetime strictly shorter than 15 minutes on wall and monotonic clocks.
- A verified denial in the accepted pin stays known through failed refreshes and restarts;
  only a newer verified head releases it. Signer revocation alone preserves grants and advises review.
  Re-signing preserves the complete current list; new writes require an active owner device.
- An authenticated read finding no policy for the current generation, or its removal, is
  the private default and a known denial, never an unknown outcome.

- `inspectCache` observes retained RAM objects only. It never initializes a lazy
  owner, reads a clock, refreshes a policy or establishes current authorization.

- Preserve RAM policy freshness on unchanged verified ledger heads/counts. Invalidation
  fences both issued grants and in-flight reads; late results never refill a retired cache.

- Reuse fresh cached grants. Before a cached machine/project sharing refusal, refresh
  the authenticated policy with per-binding concurrent sharing and a five-second
  read-start cooldown. Failed attempts never supply policy evidence or advance pins.
- Concurrent cold reads of one binding share one authenticated read; a read started
  before an invalidation is never joined after it. An original inlined in `readHead`
  is used only for that exact revision and digest, is verified exactly like a
  `readVersion` reply, and is never persisted as part of the head. Transports ask for it
  with `makeInlineVersionReadHead`, which stops asking a backend that refuses the field.

- Native session-read fences bind the returned view to the same verified cache object and freshness; ledger generation is fenced by the caller through response publication.
