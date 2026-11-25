import { atomWithStorage } from 'jotai/utils';
import type { AgentConfigId, LocalProjectId, MachineId } from '@lody/shared';
import type { SorbetConnectionSource } from '@lody/shared/electron-ipc';

export type DesktopOnboardingResumePhase = 'arrive' | 'account' | 'model' | 'start';

export type DesktopOnboardingProjectSelection =
  | {
      kind: 'local';
      machineId?: MachineId;
      localProjectId?: LocalProjectId;
      rootPath: string;
      name: string;
    }
  | {
      kind: 'github';
      repoFullName: string;
      name: string;
    };

export interface DesktopOnboardingAccountChip {
  userLabel: string;
  workspaceName: string;
  workspaceSlug: string;
}

export interface DesktopOnboardingModelChip {
  providerId: string;
  providerName: string;
  modelSelector: string;
  modelName: string;
  source: SorbetConnectionSource;
}

export interface DesktopOnboardingDraft {
  accountChip: DesktopOnboardingAccountChip | null;
  modelChip: DesktopOnboardingModelChip | null;
  project: DesktopOnboardingProjectSelection | null;
  agentConfigId: AgentConfigId | null;
}

export const EMPTY_DESKTOP_ONBOARDING_DRAFT: DesktopOnboardingDraft = {
  accountChip: null,
  modelChip: null,
  project: null,
  agentConfigId: null,
};

/**
 * Normalizes persisted phase keys, migrating any legacy pre-reorganization
 * phase names (`ceremony`, `login`, `providers`, `projects`, `firstTask`, `summary`)
 * cleanly onto the 4-step journey (`arrive | account | model | start`).
 */
export function normalizeDesktopOnboardingPhase(
  raw: string | null | undefined
): DesktopOnboardingResumePhase | null {
  if (!raw) return null;
  if (raw === 'arrive' || raw === 'account' || raw === 'model' || raw === 'start') {
    return raw;
  }
  if (raw === 'ceremony') return 'arrive';
  if (raw === 'login' || raw === 'workspace') return 'account';
  if (raw === 'providers') return 'model';
  if (raw === 'projects' || raw === 'firstTask' || raw === 'summary') return 'start';
  return null;
}

/**
 * Last reached phase in the onboarding flow. Persisted so reload / external
 * redirect (browser OAuth) returns the user to the same screen.
 * `null` means the flow has not begun.
 */
export const desktopOnboardingPhaseAtom = atomWithStorage<DesktopOnboardingResumePhase | null>(
  'lody-desktop-onboarding-phase',
  null
);

export const desktopOnboardingDraftAtom = atomWithStorage<DesktopOnboardingDraft>(
  'lody-desktop-onboarding-draft',
  EMPTY_DESKTOP_ONBOARDING_DRAFT
);
