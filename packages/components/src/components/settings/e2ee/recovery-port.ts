import { useAtomValue } from 'jotai';
import { createContext, useContext, useState, type ComponentType } from 'react';
import { e2eeRecoveryVaultFeatureEnabledAtom } from '@/atoms/settings';
import { getIpcServices } from '@/lib/electron-ipc-client';
import { desktopRecoveryPort } from './recovery-desktop-port';

/**
 * The account recovery operations the encryption console's Recovery section needs.
 * Every host (desktop main process, Web, the mobile webview) implements the same
 * closed set. The host owns the unlock: it asks for the recovery file or runs the
 * passkey ceremony itself, and returns outcomes only. No file bytes, vault handles,
 * keys or secrets ever reach the renderer through this port.
 *
 * Operations act on the host's current account. A rejected promise carries an
 * `e2ee_recovery_<code>` code in its message (`cancelled` when the user dismissed a
 * system prompt, which the section does not report as a failure). Keep the port's
 * identity stable: the section reloads whenever the port object changes.
 */
export type RecoveryPort = {
  /** What this account's recovery covers from this host. */
  readonly plan: () => Promise<RecoveryPlan>;
  readonly securityEvents: () => Promise<readonly RecoverySecurityEvent[]>;
  /** Whether this host can attempt a passkey ceremony right now. */
  readonly passkeyAvailable: () => Promise<boolean>;
  /** Create the account's vault and save its recovery file; refused when one exists.
   * Null when this host cannot save a file: the section then says where to create one. */
  readonly create:
    | (() => Promise<RecoveryCancelled | { readonly outcome: 'created'; readonly vaultId: string }>)
    | null;
  /** Restore every workspace the unlock covers onto this host, each reported separately. */
  readonly restore: (
    method: RecoveryUnlockMethod
  ) => Promise<
    | RecoveryCancelled
    | { readonly outcome: 'restored'; readonly results: readonly RecoveryRestoreResult[] }
  >;
  /** Set up or continue one workspace's recovery from the recovery file. */
  readonly setupWorkspace: (
    workspaceId: string
  ) => Promise<RecoveryCancelled | RecoverySetupResult>;
  /** Set up several workspaces after one unlock. One failure never stops the others. */
  readonly setupWorkspaces: (
    workspaceIds: readonly string[],
    method: RecoveryUnlockMethod
  ) => Promise<
    | RecoveryCancelled
    | {
        readonly outcome: 'settled';
        readonly results: readonly (RecoverySetupResult & { readonly workspaceId: string })[];
      }
  >;
  /** A readable default name for a passkey added on this host. */
  readonly passkeyDefaultLabel: () => Promise<string>;
  /** Add a passkey; the host unlocks with the recovery file first. */
  readonly addPasskey: (
    label: string
  ) => Promise<RecoveryCancelled | { readonly outcome: 'added' }>;
  /** List the vault's passkeys; the host unlocks with the recovery file first. */
  readonly listPasskeys: () => Promise<
    RecoveryCancelled | ({ readonly outcome: 'listed' } & RecoveryPasskeys)
  >;
  readonly removePasskey: (entryId: string) => Promise<RecoveryCancelled | RecoveryPasskeyRemoval>;
  /** Open a chosen recovery file and authenticate it, without restoring anything.
   * Null when this host cannot check a file: the section then offers no check. */
  readonly checkFile:
    | (() => Promise<
        | RecoveryCancelled
        | { readonly outcome: 'opened'; readonly vaultId: string; readonly workspaces: number }
      >)
    | null;
  /** Replacing the recovery file. Null when this host cannot replace it: the section
   * then offers no replace action, and a replacement in progress is shown as one to
   * finish on the device that started it. */
  readonly replacement: RecoveryReplacementPort | null;
};

export type RecoveryReplacementPort = {
  /** Save a new file and reserve its vault; the current one keeps working. */
  readonly begin: () => Promise<RecoveryCancelled | { readonly outcome: 'begun' }>;
  /** From the new file, prove every workspace and retire the old vault. A suspected
   * leak (`compromised`) revokes the old file first. */
  readonly finish: (input: {
    readonly compromised: boolean;
  }) => Promise<RecoveryCancelled | { readonly outcome: RecoveryCommitOutcome }>;
  /** Give up an unfinished replacement. */
  readonly abandon: () => Promise<{ readonly outcome: RecoveryCommitOutcome }>;
};

export type RecoveryUnlockMethod = 'file' | 'passkey';
export type RecoveryCancelled = { readonly outcome: 'cancelled' };
/** `Committed` is the only finished outcome. `Pending` (and, for a restore,
 * `Unconfirmed`) is shown as still waiting; a restore's `not-backed-up` says the file
 * does not cover that workspace yet; any other value (conflict, failure) is a failure. */
export type RecoveryCommitOutcome = string;
/** Only `Committed` with `recoverable` counts as a finished, verified setup. */
export type RecoverySetupResult = {
  readonly outcome: RecoveryCommitOutcome;
  readonly recoverable: boolean;
};
export type RecoveryRestoreResult = {
  /** Admission succeeded with newer epoch keys still awaiting repair. */
  readonly partialEpochKey?: boolean;
  /** Present when the host knows which workspace the row is; names may repeat. */
  readonly workspaceId?: string;
  readonly name: string;
  readonly outcome: RecoveryCommitOutcome;
};
/** A settled passkey removal. When the removal settled but the list could not be read
 * again, return the outcome without lists: the section keeps the outcome instead of
 * reporting a failure, and the user opens the list again to see it. */
export type RecoveryPasskeyRemoval =
  | ({ readonly outcome: 'removed' | 'incomplete' } & RecoveryPasskeys)
  | {
      readonly outcome: 'removed' | 'incomplete';
      readonly passkeys?: undefined;
      readonly pending?: undefined;
    };
export type RecoveryPasskey = { readonly entryId: string; readonly label: string };
export type RecoveryPasskeys = {
  readonly passkeys: readonly RecoveryPasskey[];
  /** Removals that started but did not finish; each can be retried. */
  readonly pending: readonly RecoveryPasskey[];
};
export type RecoverySecurityEvent = {
  /** A key unique within the returned list; it need not be a server id. */
  readonly id: string;
  /** `personal_device_recovered`, `vault_replacement_finished`, or a replacement start. */
  readonly kind: string;
  readonly occurredAt: number;
};
export type RecoveryWorkspaceStatus =
  | { readonly kind: 'notSet' }
  | { readonly kind: 'saved' }
  | { readonly kind: 'verified'; readonly update: number }
  | { readonly kind: 'unknown' };
export type RecoveryPlan = {
  readonly hasVault: boolean;
  /** A replacement of this account's recovery file is unfinished. */
  readonly replacing: boolean;
  /** Workspaces this host can set up or holds recovery for, with their status. */
  readonly covered: readonly {
    readonly id: string;
    readonly name: string;
    readonly status: RecoveryWorkspaceStatus;
  }[];
  /** Workspaces this host cannot cover yet; a restore can bring them back. */
  readonly uncovered: readonly { readonly id: string; readonly name: string }[];
};

/** What a host composes into the encryption console's Recovery tab. A host that
 * implements `port` gets the shared section; `Section` is a host-owned section kept
 * while hosts move to the port. The section owns its account scope. */
export type E2eeRecoveryHost =
  | { readonly port: RecoveryPort }
  | { readonly Section: ComponentType<{ accountId?: string | null }> };

export const E2eeRecoveryHostContext = createContext<E2eeRecoveryHost | null>(null);

/** This host's recovery port: the composed host's, else the desktop main-process
 * vault, else undefined. Undefined while the renderer's recovery switch is off, so
 * no surface offers a section that has nothing to show. The switch only hides or
 * shows the port: desktop main still refuses every vault call unless it started
 * with its own env gate. */
export function useRecoveryPort(): RecoveryPort | undefined {
  const host = useContext(E2eeRecoveryHostContext);
  const enabled = useAtomValue(e2eeRecoveryVaultFeatureEnabledAtom);
  // The IPC proxy is new on every call; build the desktop port once.
  const [desktop] = useState(() => {
    const e2ee = getIpcServices()?.e2ee;
    return e2ee ? desktopRecoveryPort(e2ee) : undefined;
  });
  if (!enabled) return undefined;
  if (host) return 'port' in host ? host.port : undefined;
  return desktop;
}
