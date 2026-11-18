/** Node-only Session composition. Main and daemon share these implementations;
 * no renderer Doc, old Repo, Flock writer or raw patch capability is exported. */
export {
  createNativeSessionDocumentFactory,
  NativeSessionOwnerCleanupError,
  type NativeSessionRoomGrant,
} from './native-session-document-owner';
export {
  NativeLocalSessionOwnerLegacy,
  readLocalNativeSessionRoute,
  type NativeLocalSessionHost,
} from './native-session-owner';
export {
  acquireNativeSessionDomainGrant,
  type NativeSessionMetadataOwner,
} from './native-session-domain-grant';
export {
  createNativeSessionDomainService,
  NativeSessionSnapshotRegistry,
  type NativeSessionDomainService,
} from './native-session-domain-service';
export type {
  NativeSessionDocumentFactory,
  NativeSessionDocumentOwner,
  NativeSessionMetadataPort,
} from './native-session-document';
export type { SessionBackend } from './native-session-contract';
