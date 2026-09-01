import { atom } from 'jotai';

/**
 * Controls the join-community dialog. Opened from the sidebar help menu, so the
 * dialog is mounted once in MainLayout — the same way the bug report dialog is.
 * Settings → About owns its own local open state through `JoinCommunityButton`.
 */
export const joinCommunityDialogOpenAtom = atom(false);
