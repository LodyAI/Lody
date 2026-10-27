import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type {
  WorktreeCleanupScriptConfig,
  WorktreeSetupScriptConfig,
  WorktreeSetupShell,
} from '@lody/shared';
import * as stylex from '@stylexjs/stylex';

import { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerTitle } from '@/ui/drawer';
import { useKeyboardAwareSheet } from '@/hooks/use-keyboard-aware-scroll-into-view';
import { WorktreeSetupEditor } from '@/components/settings/project-settings';
import { themeSpace } from '../../style/theme-scale.stylex';
import { sheetSurface } from './sheet-surface';

export type MobileWorktreeConfigSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /* Local projects pass the machine's detected shell so each editor renders a
     single textarea; GitHub omits it so the editors render Bash / PowerShell
     tabs (a repo can be cloned on either OS). */
  shell?: WorktreeSetupShell;
  setupConfig: WorktreeSetupScriptConfig;
  cleanupConfig: WorktreeCleanupScriptConfig;
  isSetupLoading?: boolean;
  isSetupSaving?: boolean;
  setupError?: string | null;
  isCleanupLoading?: boolean;
  isCleanupSaving?: boolean;
  cleanupError?: string | null;
  onSetupSave: (config: WorktreeSetupScriptConfig) => Promise<void> | void;
  onCleanupSave: (config: WorktreeCleanupScriptConfig) => Promise<void> | void;
};

const styles = stylex.create({
  /** The sheet's scrolling body. */
  body: {
    display: 'flex',
    minHeight: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    flexDirection: 'column',
    gap: themeSpace[5],
    overflowY: 'auto',
    paddingInline: themeSpace[4],
    paddingTop: themeSpace[1],
  },
  /** The rule between the two editors. */
  divider: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: 'hsl(var(--border) / 0.4)',
  },
});

/**
 * Second-level bottom sheet that holds the worktree setup + cleanup editors.
 * The project Settings tab only shows a single "Worktree setup & cleanup" row;
 * tapping it opens this sheet. Stacking the editors as a sheet (rather than
 * drilling inside the Settings tab) keeps the project page's own back chip as
 * the sole dismiss affordance — the same reason `MobileAcpHistorySheet` exists.
 */
export function MobileWorktreeConfigSheet({
  open,
  onOpenChange,
  shell,
  setupConfig,
  cleanupConfig,
  isSetupLoading,
  isSetupSaving,
  setupError,
  isCleanupLoading,
  isCleanupSaving,
  cleanupError,
  onSetupSave,
  onCleanupSave,
}: MobileWorktreeConfigSheetProps) {
  const { t } = useTranslation();
  const title = t('workspace.projects.worktreeConfigTitle', 'Worktree setup & cleanup');

  /* Both editors are textareas, so this sheet is on screen with the soft
     keyboard up for most of its life. */
  const keyboard = useKeyboardAwareSheet();

  return (
    <Drawer open={open} onOpenChange={onOpenChange} repositionInputs={false}>
      <DrawerContent
        className={`mobile-worktree-config-sheet h-auto! max-h-[88dvh]! rounded-t-2xl border-border/60 ${keyboard.contentClassName}`}
      >
        <div {...stylex.props(sheetSurface.columnAuto)}>
          <header {...stylex.props(sheetSurface.header, sheetSurface.headerShrink)}>
            <DrawerTitle {...stylex.props(sheetSurface.title, sheetSurface.titleCentered)}>
              {title}
            </DrawerTitle>
            <DrawerClose asChild>
              <button
                type="button"
                aria-label={t('common.close', 'Close')}
                {...stylex.props(sheetSurface.iconButton, sheetSurface.iconButtonRight)}
              >
                <X {...stylex.props(sheetSurface.glyph20)} aria-hidden="true" strokeWidth={1.8} />
              </button>
            </DrawerClose>
          </header>
          <DrawerDescription {...stylex.props(sheetSurface.srOnly)}>{title}</DrawerDescription>

          <div ref={keyboard.scrollRef} {...stylex.props(styles.body)} style={keyboard.scrollStyle}>
            <WorktreeSetupEditor
              phase="setup"
              shell={shell}
              config={setupConfig}
              isLoading={isSetupLoading}
              isSaving={isSetupSaving}
              errorMessage={setupError}
              onSave={onSetupSave}
            />
            <div {...stylex.props(styles.divider)} />
            <WorktreeSetupEditor
              phase="cleanup"
              shell={shell}
              config={cleanupConfig}
              isLoading={isCleanupLoading}
              isSaving={isCleanupSaving}
              errorMessage={cleanupError}
              onSave={onCleanupSave}
            />
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
