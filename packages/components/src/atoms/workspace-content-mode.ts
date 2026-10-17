import { atom } from 'jotai';
import type { WorkspaceAdmissionDescriptor } from '@lody/cloud-api';

/** An authoritative response for this runtime attempt, never a persisted mode hint. */
export const workspaceContentModeAtom = atom<{
  accountId: string | null;
  workspaceSlug: string;
  workspaceId: string;
  descriptor: WorkspaceAdmissionDescriptor;
} | null>(null);
