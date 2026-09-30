import { Avatar, type AvatarSize } from '@lody/ui/avatar';
import { Building2 } from 'lucide-react';
import { useStableAvatarSrc } from '@/hooks/use-stable-avatar-src';

interface WorkspaceAvatarProps {
  workspace?: {
    name?: string | null;
    /** BetterAuth stores the workspace avatar in `organization.logo`. */
    logo?: string | null;
  } | null;
  /** Which rung of `@lody/ui`'s avatar ladder the tile sits on. */
  size?: AvatarSize;
  /** Layout only; the tile itself belongs to the primitive. */
  className?: string;
}

/* Deterministic 0–359 hue from a string — same recipe as
   `MobileInitialLetterAvatar` so workspace tiles stay stable across
   surfaces (header chip, switcher sheet, desktop sidebar). */
function stringToHue(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

/** First grapheme uppercased (CJK / emoji-safe). */
function firstGraphemeUpper(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  return Array.from(trimmed)[0]!.toUpperCase();
}

/**
 * Workspace (organization) avatar. Shares the stable blob-cache strategy with
 * {@link UserAvatar} via `useStableAvatarSrc`.
 *
 * It is a **tile** rather than a circle, which is the shape `@lody/ui` gives a
 * thing as opposed to a person: a circle around a logo is a crop, and the mark
 * inside one was drawn square. The corner follows the rung.
 *
 * Default (no logo): first letter / character of the workspace name on a hashed
 * hue. Which hue belongs to which name is a product fact rather than a token,
 * so it is passed as a style; the gray the primitive would otherwise draw is
 * what a workspace with no name falls back to.
 */
export function WorkspaceAvatar({ workspace, size = 'medium', className }: WorkspaceAvatarProps) {
  const avatarImage = useStableAvatarSrc(workspace?.logo);
  const name = workspace?.name ?? '';
  const initial = firstGraphemeUpper(name);
  const hue = stringToHue(name || 'workspace');

  return (
    <Avatar.Root size={size} shape="tile" className={className}>
      {avatarImage ? <Avatar.Image src={avatarImage} alt={workspace?.name || 'Workspace'} /> : null}
      <Avatar.Fallback
        style={
          initial
            ? { backgroundColor: `hsl(${hue} 62% 52%)`, color: 'hsl(0 0% 100%)', fontWeight: 600 }
            : undefined
        }
      >
        {initial ?? (
          <Avatar.Glyph>
            <Building2 className="size-full" />
          </Avatar.Glyph>
        )}
      </Avatar.Fallback>
    </Avatar.Root>
  );
}
