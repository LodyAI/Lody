/** Lody Cloud epoch-staging requests. The staged-group wire contract (DTOs and
 * the device request signature) is `@lody/e2ee-core/host`; these types only add
 * Lody Cloud's workspace and credential envelope around it. All hex is lowercase.
 * Opaque encrypted originals, not ledger authority, membership proofs or a new
 * commit point. */
import type {
  EpochStagedGroupDto,
  EpochStagedGroupKeyDto,
  EpochStagingRequestProofDto,
} from '@lody/e2ee-core/host';

export {
  epochStagingRequestSigningBytes,
  type EpochStagedEnvelopeDto,
  type EpochStagedGroupDto,
  type EpochStagedGroupKeyDto,
  type EpochStagingRequestProofDto,
} from '@lody/e2ee-core/host';

export type EpochStagingWorkspaceRequest = {
  readonly workspaceId: string;
  /** Optional CLI credential; an app session otherwise supplies account identity. */
  readonly cliToken?: string;
};
export type StageEpochGroupRequest = EpochStagingWorkspaceRequest & {
  readonly group: EpochStagedGroupDto;
  readonly proof: EpochStagingRequestProofDto;
};
export type ReadEpochGroupRequest = EpochStagingWorkspaceRequest & {
  readonly key: EpochStagedGroupKeyDto;
};
export type DeleteEpochGroupRequest = ReadEpochGroupRequest & {
  /** Independently verified occupied slot; never a server-selected checkpoint. */
  readonly occupied: { readonly epoch: number; readonly commitment: string };
  readonly proof: EpochStagingRequestProofDto;
};
