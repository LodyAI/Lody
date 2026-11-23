import { useAtom } from 'jotai';
import { joinCommunityDialogOpenAtom } from '@/atoms/join-community';
import { JoinCommunityDialog } from './join-community-dialog';

/** Hosts the sidebar help menu's copy of the shared join-community dialog. */
export function JoinCommunityDialogContainer() {
  const [open, setOpen] = useAtom(joinCommunityDialogOpenAtom);
  return <JoinCommunityDialog open={open} onOpenChange={setOpen} />;
}
