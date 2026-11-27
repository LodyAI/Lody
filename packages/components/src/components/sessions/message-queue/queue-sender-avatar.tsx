import type { WorkspaceId } from '@lody/shared';
import { UserAvatar } from '@/components/user-avatar';
import { useWorkspaceSenderProfile } from '@/hooks/use-workspace-sender-profile';

/** The sender's face on a queued row, resolved like the conversation's own sender avatars. */
export function QueueSenderAvatar({
  userId,
  userName,
  workspaceId,
}: {
  userId: string | undefined;
  userName?: string;
  workspaceId: WorkspaceId | null | undefined;
}) {
  const profile = useWorkspaceSenderProfile({ userId, workspaceId });
  return (
    <UserAvatar
      size="small"
      user={profile ?? (userName ? { id: userId, name: userName } : undefined)}
    />
  );
}
