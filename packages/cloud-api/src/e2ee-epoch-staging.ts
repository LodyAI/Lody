/** Lody Cloud epoch-staging requests. The staged-group wire contract (DTOs and
 * optional device request signatures) is `@lody/e2ee-core/host`; these types only add
 * Lody Cloud's workspace and credential envelope around it. All hex is lowercase.
 * Opaque encrypted originals, not ledger authority, membership proofs or a new
 * commit point. */
import type { EpochStagedGroupDto, EpochStagedGroupKeyDto } from '@lody/e2ee-core/host';
import type { E2eeDeviceAccess } from './e2ee-device';

export {
  epochStagingRequestSigningBytes,
  type EpochStagedEnvelopeDto,
  type EpochStagedGroupDto,
  type EpochStagedGroupKeyDto,
  type EpochStagingRequestProofDto,
} from '@lody/e2ee-core/host';

export type EpochStagingWorkspaceRequest = E2eeDeviceAccess;
export type StageEpochGroupRequest = EpochStagingWorkspaceRequest & {
  readonly group: EpochStagedGroupDto;
  /** Persisted accounting round, outside all immutable signed bytes. */
  readonly round?: string;
};
export type ReadEpochGroupRequest = EpochStagingWorkspaceRequest & {
  readonly key: EpochStagedGroupKeyDto;
};
export type DeleteEpochGroupRequest = ReadEpochGroupRequest & {
  /** Independently verified occupied slot; never a server-selected checkpoint. */
  readonly occupied: { readonly epoch: number; readonly commitment: string };
};
