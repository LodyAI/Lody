# Cloud API Client Contract

This package is the public, client-facing contract for optional Lody Cloud
features. It may contain stable operation names and request/response DTOs, but
never Convex schemas, handlers, generated server APIs, secrets, deployment
configuration, or business-rule implementations.

- Keep the runtime value backed by Convex `anyApi`; callers receive ordinary
  typed `FunctionReference` values without depending on server code generation.
- Treat DTO changes as protocol changes. Update cloud implementations and open
  clients together before publishing a breaking change.
- Use portable public types (`string` for serialized IDs) and types from other
  open packages. Do not import from a hosted implementation or private package.
- Local OSS startup must not construct this client unless the selected platform
  provider explicitly enables the matching cloud capability.

- `./seat-invite-preview` owns the seat quote runtime schema and inferred type.
  Cloud adapters reuse it so optional payment actions survive parsing. These hints
  inform UI only; backend admission and billing checks remain authoritative.

- Machine identity restoration requires server-verified ownership of both registrations
  and an exact retained request. An installation ID is neither an encrypted device
  identity nor permission to transfer encrypted custody.
