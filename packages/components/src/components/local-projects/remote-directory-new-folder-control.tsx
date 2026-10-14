import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { FolderPlus } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { Spinner } from '@/ui/spinner';
import {
  describeCreateDirectoryError,
  type RemoteDirectoryPickerController,
} from './use-remote-directory-picker';

const styles = stylex.create({
  control: { display: 'flex', flexDirection: 'column', gap: space[2], marginBottom: space[2] },
  form: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space[2] },
  input: { flexGrow: 1, minWidth: '120px' },
  icon: { width: '16px', height: '16px', flexShrink: 0 },
  error: { margin: 0, color: colors.destructive, fontSize: text.footnoteSize },
  visuallyHidden: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    padding: 0,
    margin: '-1px',
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
    borderWidth: 0,
  },
});

/** Compact, on-demand entry point for creating a directory in the current location. */
export function RemoteDirectoryNewFolderAction({
  controller: c,
}: {
  controller: RemoteDirectoryPickerController;
}) {
  const { t } = useTranslation();
  if (!c.selectedMachine?.canAddProjects || !c.selectedMachine.supportsCreateDirectory) return null;

  const label = t('localProjects.add.newFolder', 'New folder');
  return (
    <Button
      type="button"
      variant="ghost"
      size="small"
      icon
      title={label}
      aria-label={label}
      disabled={!c.canCreateFolder}
      onClick={c.startNewFolder}
    >
      <FolderPlus {...stylex.props(styles.icon)} />
      <span {...stylex.props(styles.visuallyHidden)}>{label}</span>
    </Button>
  );
}

/** Shows the creation form only after the user invokes the compact action. */
export function RemoteDirectoryNewFolderControl({
  controller: c,
}: {
  controller: RemoteDirectoryPickerController;
}) {
  const { t } = useTranslation();
  const errorId = useId();
  if (!c.selectedMachine?.canAddProjects || !c.selectedMachine.supportsCreateDirectory) return null;
  if (!c.newFolderOpen) return null;

  return (
    <div {...stylex.props(styles.control)}>
      <form
        {...stylex.props(styles.form)}
        onSubmit={(event) => {
          event.preventDefault();
          void c.createFolder();
        }}
      >
        <div {...stylex.props(styles.input)}>
          <Input
            value={c.folderName}
            onChange={(event) => c.setFolderName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                c.cancelNewFolder();
              }
            }}
            placeholder={t('localProjects.add.folderName', 'Folder name')}
            aria-label={t('localProjects.add.folderName', 'Folder name')}
            aria-invalid={!!c.createError}
            aria-describedby={c.createError ? errorId : undefined}
            autoFocus
            disabled={c.creating}
          />
        </div>
        <Button type="button" variant="secondary" onClick={c.cancelNewFolder} disabled={c.creating}>
          {t('common.cancel', 'Cancel')}
        </Button>
        <Button type="submit" disabled={!c.canCreateFolder || !c.folderName.trim()}>
          {c.creating ? <Spinner {...stylex.props(styles.icon)} /> : null}
          {t('localProjects.add.createFolder', 'Create')}
        </Button>
      </form>
      {c.createError ? (
        <p id={errorId} role="alert" {...stylex.props(styles.error)}>
          {describeCreateDirectoryError(c.createError.code, c.createError.message, t)}
        </p>
      ) : null}
    </div>
  );
}
