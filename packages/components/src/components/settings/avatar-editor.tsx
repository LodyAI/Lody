import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { Spinner } from '@lody/ui/spinner';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, duration, ease, focus, radius } from '@lody/ui/tokens/scales.stylex';
import { toast } from '@/lib/toast';
import type { AvatarKind } from '@lody/shared';
import { withClassName } from '@/lib/stylex';
import { AVATAR_ACCEPT, validateAvatarFile } from '@/lib/avatar-upload';
import { UserAvatar } from '../user-avatar';
import { WorkspaceAvatar } from '../workspace-avatar';

const styles = stylex.create({
  root: { flexShrink: 0 },
  fileInput: { display: 'none' },
  /**
   * The avatar is the control. Its box is the avatar's own — a circle for a
   * person, the large tile's corner for a workspace — so the scrim and the
   * focus ring follow the face rather than cropping a tile into a circle.
   */
  button: {
    position: 'relative',
    display: 'block',
    flexShrink: 0,
    width: '32px',
    height: '32px',
    padding: 0,
    margin: 0,
    borderWidth: 0,
    overflow: 'hidden',
    backgroundColor: 'transparent',
    cursor: { default: 'pointer', ':disabled': 'default' },
    outlineStyle: 'none',
    boxShadow: { default: 'none', ':focus-visible': `0 0 0 ${focus.ringWidth} ${colors.accent}` },
  },
  person: { borderRadius: radius.full, cornerShape: corner.round },
  tile: { borderRadius: radius.medium, cornerShape: corner.shape },
  /**
   * A scrim over a photograph: it covers the whole button, so its own hover is
   * the button's. It stays up while the upload runs.
   */
  scrim: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.overlay,
    color: 'white',
    opacity: { default: 0, ':hover': 1 },
    transitionProperty: 'opacity',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  scrimShown: { opacity: { default: 1, ':hover': 1 } },
  icon: { width: '14px', height: '14px' },
});

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

  const avatar =
    kind === 'user' ? (
      <UserAvatar user={{ name, image, email }} size="large" />
    ) : (
      <WorkspaceAvatar workspace={{ name, logo: image }} size="large" />
    );

  if (!editable) {
    return <div {...withClassName(stylex.props(styles.root), className)}>{avatar}</div>;
  }

  return (
    <div {...withClassName(stylex.props(styles.root), className)}>
      <input
        ref={inputRef}
        type="file"
        accept={AVATAR_ACCEPT}
        {...stylex.props(styles.fileInput)}
        onChange={(event) => {
          void handleFileChange(event);
        }}
      />
      <button
        type="button"
        {...stylex.props(styles.button, kind === 'user' ? styles.person : styles.tile)}
        disabled={isUploading}
        onClick={() => inputRef.current?.click()}
        aria-label={t('settings.profile.avatar.change')}
      >
        {avatar}
        <span {...stylex.props(styles.scrim, isUploading && styles.scrimShown)}>
          {isUploading ? <Spinner size="small" /> : <Pencil {...stylex.props(styles.icon)} />}
        </span>
      </button>
    </div>
  );
}
