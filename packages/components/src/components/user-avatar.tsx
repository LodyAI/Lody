import { Avatar, type AvatarSize } from '@lody/ui/avatar';
import { UserIcon } from 'lucide-react';
import { useStableAvatarSrc } from '@/hooks/use-stable-avatar-src';

interface UserAvatarProps {
  /**
   * 用户对象，包含用户信息
   */
  user?: {
    id?: string | null;
    name?: string | null;
    image?: string | null;
    email?: string | null;
  } | null;
  /**
   * Which rung of `@lody/ui`'s avatar ladder this face sits on. The rung picks
   * the letters inside it too, so a surface no longer states a box and a type
   * size that can disagree.
   */
  size?: AvatarSize;
  /**
   * Layout only — where the avatar sits in the row around it. The box, the
   * corner, the fill and the letters all belong to the primitive.
   */
  className?: string;
  /**
   * 是否显示默认图标而不是首字母
   */
  showIcon?: boolean;
}

/**
 * 用户头像组件
 * 统一处理用户头像的显示，支持图片和首字母fallback
 */
export function UserAvatar({ user, size = 'medium', className, showIcon = false }: UserAvatarProps) {
  const avatarImage = useStableAvatarSrc(user?.image);

  // TODO: 为 Lody CLI 添加一个特殊的 fallback
  // 获取用户名首字母作为 fallback
  const getInitials = () => {
    if (!user?.name) return null;
    const names = user.name.trim().split(' ');
    if (names.length === 1) {
      return names[0].charAt(0).toUpperCase();
    }
    // 如果有多个单词，取前两个单词的首字母
    return (names[0].charAt(0) + names[names.length - 1].charAt(0)).toUpperCase();
  };

  const initials = getInitials();

  return (
    <Avatar.Root size={size} className={className}>
      {avatarImage ? <Avatar.Image src={avatarImage} alt={user?.name || 'User'} /> : null}
      <Avatar.Fallback>
        {showIcon || !initials ? (
          // The glyph box is the primitive's and follows the rung; the icon
          // states 100% of it, the way every caller's icon does in that package.
          <Avatar.Glyph>
            <UserIcon className="size-full" />
          </Avatar.Glyph>
        ) : (
          initials
        )}
      </Avatar.Fallback>
    </Avatar.Root>
  );
}
