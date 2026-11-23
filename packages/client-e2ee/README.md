# Personal cloud host ports

`@lody/client-e2ee` supplies authenticated network ports and durable
storage for the public personal-device host. Mobile injects native custody;
Web may inject browser custody through its own rollout. Neither app is enabled
by importing this package.

`personalCloudHostPorts(options, custody)` creates a lazy Layer. The caller
supplies its existing authenticated Convex client, live account reader, exact
desktop offer, explicit open mode, fixed platform namespace and old-reader drain.
It acquires no resources during React render and owns no executor. The application
must retain the complete Layer through confirmed host retirement.

The package supplies ledger/pins, installation and approval evidence, pairing
originals, per-installation submissions, key journals, RPC originals, Web Locks,
mailbox/epoch adapters and dedicated content/RPC grants. The public host verifies
approval, membership, device and key scope; network projections and local receipts
never authorize access. No additional backend API or ledger format is introduced.

The remote history capability uses the existing device-credential history endpoint
to qualify the prefix before an approved snapshot. It captures the borrowed credential
before I/O, keeps one checkpoint across pages, and checks the live account and fixed
workspace/genesis on every response. The portable host verifies and saves the public
signed pages in its existing identity/session-bound evidence store for offline reopen.
It does not replace approval originals, custody, feed origin or rollback pins.

`personalCloudDatabases(scope, 'mobile' | 'web')` defines stable names outside
ordinary replica caches. The platform namespace is a composition constant, never
a recovery option. Reopening retains the ledger/custody mode. Only the approved
installation's submission partition may be created on its first session after
restart. Missing protection requires desktop reapproval; it never creates a new
identity implicitly. Logout and ordinary cache cleanup retain identity originals.

Machine-policy administration is absent until a portable implementation exists.
This does not disable RPC to an already authorized paired machine. Optional
features must report unsupported instead of substituting ordinary transports.

Tests cover account changes during I/O, original/scope checks, relay projections,
history pagination, grants and SDK client compatibility. Injected OS-labelled
custody doubles validate host composition. Native Keychain/Keystore and
installed-app acceptance require device testing.
Use test-build for product acceptance; stable publishing is outside this task.

`personalEntry({ run, pins, ports, ledgerRecords })` is the application owner.
Its `createRuntime` returns a synchronous facade; native hosts are acquired lazily
for the captured account/workspace and retained desktop offer. Account changes
retire old entries. Only confirmed drain releases their Scope; a timed-out close
retains the complete public `PersonalCloseIncomplete.owner` until actual settlement.
`awaitRetirements` lets recovery wait for retired entries without blocking unrelated
workspaces. Applications supply their own Effect executor and reuse their existing
authenticated cloud client.

`personalEntryPins(databaseName)` retains verified public desktop offers and routing
progress. A ready phase never grants access; the public host rechecks approval and
installation evidence. It rejects a conflicting ready/pending offer rather than
clearing identity or opening another namespace. Explicit lost-identity replacement
UI remains separate work; users must not delete these records to retry pairing.

Content calls preserve the public runtime's synchronous snapshot boundary through
the lazy facade: bytes, room and context are captured before lookup. The facade
wipes its own plaintext on success or failure, including failure before the lower
runtime starts. The lower runtime owns its separate buffers through real native
settlement.

`makeClientRecovery` shares the mobile and same-origin Web vault orchestration.
The platform namespace remains a fixed composition choice. Creating a recovery
file creates an empty vault only: the user must save and reimport the exact file
before ciphertext upload. It does not enroll any workspace or authorize a device.
Reads may open a retired vault whose recovery identity is still valid; mutations
require the current vault. Mobile and Web entry points remain thin fixed-namespace wrappers.
Recovery files carry the signed-in site's canonical origin
([`recoveryServiceLocator`](../e2ee-client/README.md#recovery-service-locator)) through the
optional `serviceLocator` option. Omitted, it is the page's HTTP(S) origin, which suits the
hosted and self-hosted Web client; the mobile wrapper passes `VITE_SITE_URL`. Without a usable
origin every command refuses as `disabled`.

`makeRecoveryWorkspaces` is the shared per-workspace setup and restore engine.
The caller passes `platform: 'web' | 'mobile'`, the passkey port, and the closed
`personalEntryRecovery` commands. One vault unlock covers every selected workspace.
Each workspace publishes its own result; a bounded wait reports unconfirmed and
does not cancel the producer, its journal, or a committed submission. Only a
committed and verified setup is recoverable. Pending, conflict, and failure stay
unfinished. Entry pins use `lody-e2ee:<platform>:v1:entry-pins`, derived only from
that platform constant. Passkey PRF and recovery-file secrets stay inside the
scoped operation. Web's `makeWebRecovery` adds the browser passkey port. Mobile's
`makeMobileRecoveryWorkspaces` fixes `platform: 'mobile'` and is not used by the
current account screen.

Optional account-pairing requester composition reuses each runtime's existing
owned host and retained offer. Relay history is verified by the public host before
the entry pin becomes ready; ready alone never means workspace keys were installed.

Web recovery uses `personalEntryRecovery` on the existing facade. Its setup command
borrows one labelled reader and releases exactly that label; other readers and
independent workspaces remain usable. Restore reuses the original offer/identity,
and only a verified committed outcome makes the entry pin ready.

## Transport composition

The facade in [`src/entry.ts`](src/entry.ts) exposes the iroh methods when the
wrapper supplies the native port. Route selection uses those methods to detect
iroh support. The [mobile host test](../../apps/mobile-capacitor/tests/e2ee/mobile-host.test.ts)
exercises the path from the facade to the native plugin boundary.
