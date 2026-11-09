# Native iOS backend configuration

Run these commands from `apps/mobile/ios`. The optional shared file is
`../.env.local` (`apps/mobile/.env.local`), already ignored by the mobile
`.gitignore`. No local file is required. Do not put credentials in it: these
origins are embedded in the app, not secrets.

```dotenv
CONVEX_URL=https://rpc.example.com
CONVEX_SITE_URL=https://auth.example.com
CF_WORKER_URL=https://worker.example.com
```

The shared `../backend-config.mjs` owns parsing, validation and defaults; iOS does not maintain a second resolver. The examples above are illustrative overrides, not production defaults. Process environment variables override
the file; missing or blank values select the corresponding production default.
Assignments, optional `export`, quoted values and whole-line comments are
supported. Shell substitution, expansion, inline comments and executable code
are not supported. The parser never sources the file. Origins must have no
credentials, path (except `/`), query or fragment. Default ports and host case
are canonicalized before storage identity is computed.

## Build

```sh
pnpm prebuild
pnpm verify:build --skip-assets
```

`prebuild` resolves configuration both for the bundled protocol runtime and the
XcodeGen-generated app/extension plists. Swift consumes `LodyBackends` in the
bundle. Rerun the complete prebuild after changing endpoints; opening Xcode alone
does not reread the env file. A build check rejects mismatched native/runtime
assets, rather than silently combining two environments.

## Local native stack

Use the public TLS origins reported by the native stack, with its port offset:

```sh
CONVEX_URL=https://127.0.0.1:3230 \
CONVEX_SITE_URL=https://127.0.0.1:3231 \
CF_WORKER_URL=https://127.0.0.1:3233 \
pnpm prebuild
pnpm verify:build --skip-assets
```

The app's `CONVEX_SITE_URL` is the **public HTTPS site**, not the server-internal
HTTP `CONVEX_SITE_URL` used for OIDC/JWKS self-access. Consult your local stack documentation for its selected endpoints. Worker ingress is separate from Convex site; its local
relay does not implement every upload/share route.

HTTPS is required in Debug and Release. Certificate validation stays enabled;
configure appropriate device trust separately. No ATS bypass or trust-all
handler is installed. Do not copy server secrets or internal environment files
into the mobile configuration.

## Isolation

All three canonical origins participate in a deterministic SHA-256 namespace.
The exact production tuple retains the original Keychain service, SQLite path,
Share App Group directory, avatar cache and Tab preference keys. Nonproduction
tuples use separate namespaces, even when only one endpoint changes. SQLite
also owns persisted drafts/outbox and catalog projections. Switching back never
deletes or migrates production data. This is build-time configuration, not a
runtime server switch; reinstall/rebuild to select a different environment.

## Verification

```sh
node --test apps/ios/tests/native/project-generation.test.mjs
python3 apps/ios/tests/backend-build_test.py
pnpm verify:native --case auth
pnpm verify:native --case auth-session
```

Password reset is supported only when `CONVEX_SITE_URL` is exactly the canonical
production origin `https://backend.lody.ai`. Other auth/site origins are rejected
before any network request, with a localized unsupported-local-reset message; no
reset email is requested. Production keeps the existing HTTPS web reset flow.
There is no additional reset URL configuration.
