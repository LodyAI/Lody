import type { ReactNode } from 'react';
import { Dialog } from '@/ui/dialog';
import {
  settingsEditorDialogStyles,
  SETTINGS_EDITOR_DIALOG_WIDTH,
} from '@/components/settings/surface';

/**
 * The settings editor dialog exactly as Settings opens it, so a form story shows
 * the product's chrome, width and padding rather than a story-only box.
 */
export function SettingsEditorDialogFrame({
  title,
  description,
  height,
  children,
}: {
  title: string;
  description?: string;
  /** The Role editor fixes its height; the Prompt editor sizes to its content. */
  height?: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open>
      <Dialog.Content
        width={SETTINGS_EDITOR_DIALOG_WIDTH}
        xstyle={settingsEditorDialogStyles.panel}
        style={height ? { height } : undefined}
      >
        <Dialog.Header>
          <Dialog.Title>{title}</Dialog.Title>
          {description ? <Dialog.Description>{description}</Dialog.Description> : null}
        </Dialog.Header>
        {children}
      </Dialog.Content>
    </Dialog.Root>
  );
}
