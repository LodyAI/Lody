import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, X } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import * as stylex from '@stylexjs/stylex';

import { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerTitle } from '@/ui/drawer';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Field as UiField } from '@lody/ui/field';
import { field } from '@lody/ui/field/field.tokens.stylex';
import { withClassName } from '@/lib/stylex';
import { themeColors } from '../../style/theme-colors.stylex';
import { themeFontWeight, themeRadius, themeSpace } from '../../style/theme-scale.stylex';
import { sheetSurface } from './sheet-surface';

export type MobileDeleteWorkspaceSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Workspace name — used both for the "type to confirm" guard and
     for the destructive copy in the title / body. */
  workspaceName: string;
  /** Caller's destructive action. The sheet awaits this and shows
     a spinner on the delete button while it's in flight. */
  onConfirm: () => Promise<void>;
  /** Remaining billing obligations, rendered above the type-to-confirm card. */
  warningText?: string | null;
};

const styles = stylex.create({
  fieldLabel: {
    [field.labelSize]: '0.78rem',
    [field.labelWeight]: 'var(--font-weight-medium)',
    '--tw-font-weight': 'var(--font-weight-medium)',
  },
  /** The title, with the warning mark in front of it. */
  titleRow: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: themeSpace[1.5],
  },
  /** The sheet's description, under the header. */
  description: {
    paddingInline: themeSpace[4],
    paddingBottom: themeSpace[3],
    fontSize: '0.78rem',
    lineHeight: 1.625,
    color: themeColors.mutedForeground,
  },
  /** The sheet's body. */
  body: {
    minHeight: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflowY: 'auto',
    paddingInline: themeSpace[4],
    paddingBottom: themeSpace[2],
  },
  /** The billing warning follows the app's explicit theme scopes. */
  warning: {
    marginBottom: themeSpace[2],
    paddingInline: themeSpace[3],
    paddingTop: themeSpace[2],
    paddingBottom: themeSpace[2],
    borderRadius: themeRadius.md,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'oklch(76.9% 0.188 70.08 / 0.3)',
    backgroundColor: 'oklch(76.9% 0.188 70.08 / 0.1)',
    fontSize: '0.72rem',
    fontWeight: themeFontWeight.medium,
    lineHeight: 1.625,
    color: {
      default: 'oklch(27.9% 0.077 45.635)',
      ':where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))':
        'var(--color-amber-100)',
    },
  },
  /** The type-to-confirm card. */
  confirmCard: {
    padding: themeSpace[3],
    borderRadius: themeRadius.xl,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--destructive) / 0.3)',
    backgroundColor: 'hsl(var(--destructive) / 0.04)',
    boxShadow: '0 0 0 3px hsl(var(--destructive) / 0.04)',
  },
  confirmationInput: { marginTop: 'calc(var(--spacing) * 2)' },
  action: { flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
  busyMark: {
    marginRight: 'calc(var(--spacing) * 1.5)',
  },
});

/**
 * Mobile-native bottom-sheet replacement for the centered `Dialog`
 * the desktop delete-workspace flow uses. Keeps the same
 * confirmation pattern (type the workspace name to enable the
 * destructive button) but presents it as a Drawer that matches the
 * rest of the mobile sheet family (new-chat, workspace-switcher,
 * create-workspace, filter-drawer).
 *
 * Destructive visual treatment:
 *  - Header has a destructive-tinted warning chip + icon so the
 *    destructive intent is unmissable before the user reads any
 *    body copy.
 *  - "Type to confirm" sub-card has a destructive top-border
 *    accent — a low-contrast danger marker that doesn't shout but
 *    keeps the visual hierarchy weighted toward caution.
 *  - The confirm button uses the `destructive` variant.
 */
export function MobileDeleteWorkspaceSheet({
  open,
  onOpenChange,
  workspaceName,
  onConfirm,
  warningText = null,
}: MobileDeleteWorkspaceSheetProps) {
  const { t } = useTranslation();
  const [confirmText, setConfirmText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  /* Reset typed confirmation whenever the sheet closes — opening
     again on a different workspace shouldn't carry the old typed
     name forward. */
  useEffect(() => {
    if (!open) {
      setConfirmText('');
      setIsDeleting(false);
    }
  }, [open]);

  const canDelete = confirmText === workspaceName && !isDeleting;

  const handleDelete = async () => {
    if (!canDelete) return;
    setIsDeleting(true);
    try {
      await onConfirm();
    } finally {
      setIsDeleting(false);
      onOpenChange(false);
      setConfirmText('');
    }
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange} repositionInputs={false}>
      <DrawerContent
        className="mobile-delete-workspace-sheet h-auto! max-h-[92dvh]! rounded-t-2xl border-border/60 bottom-[var(--native-keyboard-height,0px)]!"
        style={{
          transition: 'bottom 320ms cubic-bezier(0.32, 0.72, 0, 1)',
          willChange: 'bottom',
        }}
      >
        <div {...stylex.props(sheetSurface.columnAuto)}>
          <header {...stylex.props(sheetSurface.header)}>
            {/* The destructive tint stays a Tailwind class: the drawer's
               own title colour is a Tailwind utility, and a StyleX colour
               would lose to it. */}
            <DrawerTitle
              {...withClassName(
                stylex.props(sheetSurface.title, sheetSurface.titleCentered, styles.titleRow),
                'text-destructive'
              )}
            >
              <AlertTriangle
                {...stylex.props(sheetSurface.glyph16)}
                aria-hidden="true"
                strokeWidth={2}
              />
              {t('workspace.danger.deleteWorkspace.confirmTitle', 'Delete workspace?')}
            </DrawerTitle>
            <DrawerClose asChild>
              <button
                type="button"
                aria-label={t('common.close', 'Close')}
                disabled={isDeleting}
                {...stylex.props(
                  sheetSurface.iconButton,
                  sheetSurface.iconButtonRight,
                  sheetSurface.iconButtonDisabled
                )}
              >
                <X {...stylex.props(sheetSurface.glyph20)} aria-hidden="true" strokeWidth={1.8} />
              </button>
            </DrawerClose>
          </header>
          {/* The drawer's own description carries a body size; the
              description's own size stays a Tailwind class so it keeps
              winning over it. */}
          <DrawerDescription {...withClassName(stylex.props(styles.description), 'text-[0.78rem]')}>
            {t('workspace.danger.deleteWorkspace.confirmDescription', {
              workspace: workspaceName,
              defaultValue: 'Permanently delete "{{workspace}}". This action cannot be undone.',
            })}
          </DrawerDescription>

          <div {...stylex.props(styles.body)}>
            {warningText ? <p {...stylex.props(styles.warning)}>{warningText}</p> : null}
            <div {...stylex.props(styles.confirmCard)}>
              <UiField.Label
                htmlFor="mobile-delete-workspace-confirm"
                className={`text-foreground ${stylex.props(styles.fieldLabel).className}`}
              >
                {t('workspace.danger.deleteWorkspace.typeToConfirm', {
                  workspace: workspaceName,
                  defaultValue: 'Type "{{workspace}}" to confirm',
                })}
              </UiField.Label>
              <Input
                id="mobile-delete-workspace-confirm"
                value={confirmText}
                onChange={(event) => setConfirmText(event.target.value)}
                placeholder={t(
                  'workspace.danger.deleteWorkspace.inputPlaceholder',
                  'Enter workspace name'
                )}
                disabled={isDeleting}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="done"
                {...stylex.props(styles.confirmationInput)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && canDelete) {
                    event.preventDefault();
                    void handleDelete();
                  }
                }}
              />
            </div>
          </div>

          <div {...stylex.props(sheetSurface.footer, sheetSurface.footerPadKeyboard)}>
            <Button
              type="button"
              variant="secondary"
              {...stylex.props(styles.action)}
              onClick={() => onOpenChange(false)}
              disabled={isDeleting}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              {...stylex.props(styles.action)}
              onClick={() => void handleDelete()}
              disabled={!canDelete}
            >
              {isDeleting ? (
                <>
                  <Spinner
                    diameter="calc(var(--spacing) * 3.5)"
                    {...stylex.props(styles.busyMark)}
                  />
                  {t('common.processing', 'Processing...')}
                </>
              ) : (
                t('workspace.danger.deleteWorkspace.confirmButton', 'Delete')
              )}
            </Button>
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
