import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil } from 'lucide-react';
import { Spinner } from '@/ui/spinner';
import { toast } from 'sonner';
import type { AvatarKind } from '@lody/shared';
import { cn } from '@/lib/utils';
import { AVATAR_ACCEPT, validateAvatarFile } from '@/lib/avatar-upload';
import { UserAvatar } from '../user-avatar';
import { WorkspaceAvatar } from '../workspace-avatar';

interface AvatarEditorProps {
  kind: AvatarKind;
  name?: string | null;
  image?: string | null;
  email?: string | null;
  editable?: boolean;
  /** Persist the chosen file (upload + save). The parent owns `image` state. */
  onUpload: (file: File) => Promise<void>;
  className?: string;
}

/**
 * Shared avatar picker used for the user profile photo and the workspace logo.
 * The avatar itself is the control: hovering reveals an edit overlay, clicking
 * opens the file picker. The parent's `onUpload` does the R2 upload + record
 * persistence; this component owns validation + the upload spinner.
 */
export function AvatarEditor({
  kind,
  name,
  image,
  email,
  editable = true,
  onUpload,
  className,
}: AvatarEditorProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Allow re-selecting the same file later by clearing the input value.
    event.target.value = '';
    if (!file) return;

    const validationError = validateAvatarFile(file);
    if (validationError) {
      toast.error(t('settings.profile.avatar.invalidFile'), { description: validationError });
      return;
    }

    setIsUploading(true);
    try {
      await onUpload(file);
    } catch (error) {
      toast.error(t('settings.profile.avatar.uploadFailed'), {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setIsUploading(false);
    }
  };

  const avatarClassName = 'h-8 w-8 text-xs';
  const avatar =
    kind === 'user' ? (
      <UserAvatar user={{ name, image, email }} className={avatarClassName} />
    ) : (
      <WorkspaceAvatar workspace={{ name, logo: image }} className={avatarClassName} />
    );

  if (!editable) {
    return <div className={cn('shrink-0', className)}>{avatar}</div>;
  }

  return (
    <div className={cn('shrink-0', className)}>
      <input
        ref={inputRef}
        type="file"
        accept={AVATAR_ACCEPT}
        className="hidden"
        onChange={(event) => {
          void handleFileChange(event);
        }}
      />
      <button
        type="button"
        className="group relative block h-8 w-8 shrink-0 overflow-hidden rounded-full outline-none ring-offset-2 ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
        disabled={isUploading}
        onClick={() => inputRef.current?.click()}
        aria-label={t('settings.profile.avatar.change')}
      >
        {avatar}
        <span
          className={cn(
            'absolute inset-0 flex items-center justify-center rounded-full bg-black/45 text-white transition-opacity',
            isUploading ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          )}
        >
          {isUploading ? <Spinner className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
        </span>
      </button>
    </div>
  );
}
