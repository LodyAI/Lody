import { atom } from 'jotai';
import type { WorkspaceAdmissionDescriptor } from '@lody/cloud-api';

/** The runtime's admission verdict for the routed workspace, never a persisted mode hint.
 * `descriptor: null` permits local document access only. No local or listed
 * encryption evidence exists, so the Repo may open before classification, but
 * body egress and consuming a send wait for authenticated admission. An encrypted
 * answer retires that provisional runtime before the verdict changes.
 * Legacy remote catalogs also await the bound ordinary/legacy descriptor.
 */
export type WorkspaceContentMode =
  | {
      accountId: string | null;
      workspaceSlug: string;
      workspaceId: string;
      descriptor: WorkspaceAdmissionDescriptor;
    }
  | {
      accountId: string | null;
      workspaceSlug: string;
      workspaceId: string | null;
      descriptor: null;
    };

export const workspaceContentModeAtom = atom<WorkspaceContentMode | null>(null);
