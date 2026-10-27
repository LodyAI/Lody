# Streams token ownership

`CLAUDE.md` symlinks here. Parent rules apply.

- Native callers compose `LoroStreamsTokens` or `makeLoroStreamsTokenProvider`
  with a provider-specific `LoroStreamsTokenPorts` and owning Scope. No execution
  launches or Legacy calls inside the kernel; schemas/encoding stay ordinary functions.
- Only `createLoroStreamsTokenProviderLegacy` executes for Promise consumers; keep
  Legacy visible in the factory, platform port and consumer types. Remove the facade
  when renderer, durable transports and Machine RPC owners compose the native service.
  Borrowing `{ provider, executor }` creates neither a runtime nor another cache;
  the application owns the provider Scope and its cleanup/recovery.
- A waiter deadline/cancellation releases only its lease. The last lease, credential
  replacement and close abort and await actual producer I/O. Bounded failed release
  retains the provider/raw owners and complete Cause; require `retryCleanup` before
  handoff. Never overwrite unresolved work with a new credential generation.
- Track reader completion with a fiber observer registered after admission; a
  pre-start interruption never enters the reader Effect's finalizer.
- Injected native ports must preserve cancellation and bounded real cleanup.
  Raw port cleanup bounds must not exceed the provider cleanup base; producer/read
  observers allow 2×/3× that base to preserve inner release Causes.
  Fetch/body and WebCrypto use the single raw adapter; a signal alone is not cleanup.
  HTTP headers are not completion: await success-body EOF or error-body cancellation.
  Keep failed body releases registered until cleanup reports their ended receipt;
  combine observer failures with the original Cause. onEvent is synchronous.
  No authenticated cloud capability is built outside official cloud composition.
- Keep endpoint/workspace/credential fences and the synchronous rejected-token
  fence immediately before encrypted storage writes. Only terminal auth failures
  become undefined at the explicit Legacy facade's old-protocol auth callback.
  Native getToken/auth remain typed failures; mixed Causes never lose non-auth reasons.
  Diagnostic health/Cause summaries must contain only finite categories, state/counts
  and auth status, never credentials, tokens, URLs, raw errors, Causes or owners.
  Timeout, interruption and release failure remain observable. [Contract](README.md).
