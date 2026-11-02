import { Context, type Effect, type Layer } from 'effect';
import type { E2eeWorkflows, LedgerView, WorkspaceInvitationSnapshot } from '@lody/e2ee-core';
import {
  ClientKeyCustody,
  ClientIdentityOriginals,
  ClientInstallationStore,
  ClientCustodyWriter,
  ClientPairingOriginalStore,
  DeviceIdentity,
  WorkspaceScope,
  LedgerSync,
  LedgerLog,
  LedgerPinStore,
  LedgerViewSource,
  SubmissionJournal,
  KeyProtector,
  CandidateProtector,
  ClientRpcOriginalStore,
  ClientApprovalEvidenceStore,
  type ClientCustodyBinding,
  type ClientCustodyScope,
  type ClientPairingKey,
} from '@lody/e2ee-core/services';
import type { E2eeContentToken, E2eeContentTokenRequest } from '@lody/cloud-api';
import type {
  E2eeMachineSharingView,
  E2eeMachineSharingWriteResult,
  E2eeMachineSharingChange,
} from '@lody/platform';
import type { PersonalPairingOffer } from './pairing';
import type { PersonalHistoryPages } from './admission';

/** Actual verified approval inputs. A ready receipt or server status is never supplied in place of these bytes. */
export type PersonalApproval = {
  readonly view: LedgerView;
  readonly offer: PersonalPairingOffer;
  readonly originalOrigin?: import('./ledger').PersonalLedgerOrigin;
} & (
  | { readonly kind: 'snapshot'; readonly invitation: WorkspaceInvitationSnapshot }
  | { readonly kind: 'history'; readonly pages: PersonalHistoryPages }
);
/** Ledger owners remain independent of key I/O. Preserve the existing origin, exact suffix and rollback pin across incarnations. */
export type PersonalControlPorts = LedgerSync | LedgerLog | LedgerPinStore | SubmissionJournal;
/** Concrete storage and backend ports; identity, verified ledger and protectors are supplied by this host. */
export type PersonalKeyPorts = Exclude<
  Layer.Services<typeof E2eeWorkflows>,
  | DeviceIdentity
  | WorkspaceScope
  | LedgerViewSource
  | LedgerPinStore
  | LedgerLog
  | SubmissionJournal
  | KeyProtector
  | CandidateProtector
>;
/** Trusted platform implementation, with no default filesystem, account or network implementation. */
export class PersonalHostPlatform extends Context.Service<
  PersonalHostPlatform,
  {
    readonly scope: ClientCustodyScope;
    readonly protection: 'web-crypto' | 'os-keystore';
    /** Captures the full binding. create is only called by explicit preparation under the custody writer. */
    custody(
      binding: ClientCustodyBinding,
      candidateRequest?: ClientPairingKey
    ): Layer.Layer<
      ClientKeyCustody | ClientIdentityOriginals,
      unknown,
      ClientInstallationStore | ClientCustodyWriter | ClientPairingOriginalStore
    >;
    /** Requalify the preserved feed origin from approval's original proof, never reset pins or use another identity's submission slot. */
    control(
      binding: ClientCustodyBinding,
      credential: Uint8Array,
      approval: PersonalApproval
    ): Layer.Layer<PersonalControlPorts, unknown>;
    /** Acquire only after current personal admission. Independent key acquisition failures leave ledger owners usable. */
    keys(
      binding: ClientCustodyBinding,
      credential: Uint8Array
    ): Layer.Layer<PersonalKeyPorts, unknown, DeviceIdentity | WorkspaceScope>;
    /** Immutable public proof pages, captured for this incarnation. */
    evidence(
      binding: ClientCustodyBinding
    ): Layer.Layer<ClientApprovalEvidenceStore, unknown, DeviceIdentity | WorkspaceScope>;
    /** Optional closed product RPC support; absence is reported unsupported. */
    rpc?(
      binding: ClientCustodyBinding
    ): Layer.Layer<ClientRpcOriginalStore, unknown, DeviceIdentity | WorkspaceScope>;
    /** Device-authenticated dedicated content/attachment grants. Captured inside the session; credentials never reach product callers. */
    contentToken?(
      binding: ClientCustodyBinding,
      credential: Uint8Array,
      request: Omit<E2eeContentTokenRequest, 'workspaceId' | 'credential' | 'cliToken'>
    ): Effect.Effect<E2eeContentToken, unknown>;
    /** Real optional policy host. Uses existing core policy verification/pins; absence does not advertise sharing. */
    machineSharing?(
      binding: ClientCustodyBinding,
      credential: Uint8Array
    ): Layer.Layer<
      PersonalMachineSharing,
      unknown,
      | DeviceIdentity
      | WorkspaceScope
      | LedgerViewSource
      | import('@lody/e2ee-core').InstalledEpochHistory
    >;
    /** Replacement requires actual quiescence of every owner of the old incarnation before its atomic switch. */
    drainOld?(binding: ClientCustodyBinding): Effect.Effect<void, unknown>;
  }
>()('@lody/e2ee-client/Platform') {}

/** Exact public exchange request retained before any network call. */
export interface PersonalExchange {
  readonly version: 1;
  readonly action: 'begin' | 'claim' | 'cancel';
  readonly accountId: string;
  readonly workspaceId: string;
  readonly genesisHash: string;
  readonly pairingSessionId: string;
  readonly requestHex: string;
}
/** Relay hints are not consent. Approved responses must contain independently verifiable original evidence. */
export interface PersonalExchangeResponse extends Omit<PersonalExchange, 'action'> {
  readonly status: 'pending' | 'admitting' | 'cancelled' | 'conflict' | 'approved';
  readonly invitationHex?: string;
  readonly history?: PersonalHistoryPages;
}
/** Remote capability captures the authenticated account; the host additionally compares every echoed scope and request. */
export class PersonalHostRemote extends Context.Service<
  PersonalHostRemote,
  {
    readonly accountId: string;
    exchange(request: PersonalExchange): Effect.Effect<PersonalExchangeResponse, unknown>;
  }
>()('@lody/e2ee-client/Remote') {}

/** Purpose-bound policy capability built within the approved session. Never expose generic signing or epoch keys to product code. */
export class PersonalMachineSharing extends Context.Service<
  PersonalMachineSharing,
  {
    read(machineId: string): Effect.Effect<E2eeMachineSharingView, unknown>;
    update(
      machineId: string,
      generation: string,
      requestId: string,
      change: E2eeMachineSharingChange
    ): Effect.Effect<E2eeMachineSharingWriteResult, unknown>;
  }
>()('@lody/e2ee-client/MachineSharing') {}
