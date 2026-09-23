import { atomWithStorage } from 'jotai/utils';
import type { AgentConfigId, LocalProjectId, MachineId, ProviderSetupTask } from '@lody/shared';

export type DesktopOnboardingResumePhase =
  | 'ceremony'
  | 'login'
  | 'workspace'
  | 'providers'
  | 'projects'
  | 'firstTask'
  | 'summary';

export type DesktopOnboardingProjectSelection =
  | {
      kind: 'local';
      machineId: MachineId;
      localProjectId: LocalProjectId;
      name: string;
    }
  | {
      kind: 'github';
      repoFullName: string;
      name: string;
    };

export type DesktopOnboardingProviderSelection =
  | {
      kind: 'agentConfig';
      agentConfigId: AgentConfigId;
      agentName: string;
    }
  | {
      kind: 'providerSetup';
      providerSetupId: ProviderSetupTask['id'];
      agentName: string;
    };

export interface DesktopOnboardingDraft {
  provider: DesktopOnboardingProviderSelection | null;
  project: DesktopOnboardingProjectSelection | null;
}

/**
 * Last reached phase in the onboarding flow. Persisted so reload / external
 * redirect (GitHub install, OAuth) returns the user to the same screen.
 * `null` means the flow has not begun.
 */
export const desktopOnboardingPhaseAtom = atomWithStorage<DesktopOnboardingResumePhase | null>(
  'lody-desktop-onboarding-phase',
  null
);

export const desktopOnboardingDraftAtom = atomWithStorage<DesktopOnboardingDraft>(
  'lody-desktop-onboarding-draft',
  { provider: null, project: null }
);
