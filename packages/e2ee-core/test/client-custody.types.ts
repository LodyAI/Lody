// Compile-only consumer and negative capability contracts; no synthetic adapter
// is claimed to prove platform persistence or key protection.
import { Effect, Layer } from 'effect';
import {
  ClientKeyCustody,
  ClientInstallationStore,
  type ClientCustodyBinding,
  type ClientInstallation,
} from '@lody/e2ee-core/services';

export function clientCustodyConsumer(
  custody: ClientKeyCustody['Service'],
  store: ClientInstallationStore['Service'],
  binding: ClientCustodyBinding,
  original: ClientInstallation
) {
  const ports = Layer.mergeAll(
    Layer.succeed(ClientKeyCustody, custody),
    Layer.succeed(ClientInstallationStore, store)
  );
  // Finite Effects only: the application owns when installation/reset executes.
  const initialize = custody.create();
  const remove = custody.delete();
  void initialize;
  void remove;
  const replaceAfterDesktopApproval = store.replace(
    { revision: original.revision, binding: original.binding },
    original
  );
  const retainedOldReceipt = store.readRetired(original.binding);
  void replaceAfterDesktopApproval;
  void retainedOldReceipt;
  const read = Effect.gen(function* () {
    const protector = yield* ClientKeyCustody;
    const installations = yield* ClientInstallationStore;
    yield* protector.status();
    yield* installations.read();
    yield* installations.compareAndSet(null, original);
    const blob = yield* protector.wrap('device-credential', new Uint8Array(32));
    return yield* protector.unwrap('device-credential', blob);
  }).pipe(Effect.provide(ports));

  // @ts-expect-error A KEK export is not a client capability.
  custody.exportKey();
  // @ts-expect-error The native boundary has no arbitrary file bridge.
  custody.readFile('/private-key');
  // @ts-expect-error Verification is fixed in core, never supplied by custody.
  custody.verify(new Uint8Array());
  // @ts-expect-error Only the enumerated key purposes may cross the protector.
  custody.wrap('document-body', new Uint8Array());
  // @ts-expect-error Persistent protection cannot be opted out of.
  custody.create({ persistent: false });
  // @ts-expect-error Deletion cannot select another account or workspace.
  custody.delete(binding);
  // @ts-expect-error A retained installation requires a revision precondition.
  store.compareAndSet(original);
  // @ts-expect-error Replacement requires both revision and full old incarnation.
  store.replace({ revision: original.revision }, original);
  // @ts-expect-error A server label cannot replace the independently pinned genesis.
  const untrustedBinding: ClientCustodyBinding = { ...binding, genesis: 'server-genesis' };
  void untrustedBinding;
  return read;
}
