import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { useCloudQuery } from '@lody/platform/react';
import * as stylex from '@stylexjs/stylex';

import { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerTitle } from '@/ui/drawer';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Field as UiField } from '@lody/ui/field';
import { useOrganization } from '../../hooks/useOrganization';
import { useWorkspaceSlugField } from '../../hooks/useWorkspaceSlugField';
import { withClassName } from '@/lib/stylex';
import { themeColors } from '../../style/theme-colors.stylex';
import { themeFontWeight, themeSpace } from '../../style/theme-scale.stylex';
import { sheetSurface } from './sheet-surface';

export type MobileCreateWorkspaceSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fired with the new workspace's slug after a successful create.
     Caller is expected to navigate the user into the new workspace. */
  onCreated?: (slug: string) => void;
};

/** Tailwind's `transition-colors`: colour properties only, 150ms, standard ease. */
const TRANSITION_COLORS = {
  transitionProperty: 'color, background-color, border-color, text-decoration-color, fill, stroke',
  transitionDuration: '150ms',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
} as const;

const styles = stylex.create({
  /** The sheet's description, under the header. */
  description: {
    whiteSpace: 'pre-line',
    paddingInline: themeSpace[4],
    paddingBottom: themeSpace[3],
    fontSize: '0.78rem',
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
  /** The form's fields, set apart from each other. */
  fields: {
    display: 'flex',
    flexDirection: 'column',
    gap: themeSpace[4],
  },
  /** The slug row: its label, and the action that restores the suggestion. */
  slugHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  /** The action that restores the suggested slug. */
  slugReset: {
    fontSize: '0.72rem',
    fontWeight: themeFontWeight.medium,
    color: { default: themeColors.mutedForeground, ':hover': themeColors.foreground },
    scale: { default: null, ':active': '0.97' },
    ...TRANSITION_COLORS,
  },
  /** The slug's hint line. */
  slugHint: {
    fontSize: '0.72rem',
  },
  slugHintError: { color: themeColors.destructive },
  slugHintChecking: { color: themeColors.mutedForeground },
  slugHintAvailable: { color: themeColors.primary },
  slugBorderError: { borderColor: 'hsl(var(--destructive) / 1)' },
  action: { flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
});

/**
 * Bottom-sheet workspace creation form on mobile. Replaces the old
 * "navigate to /settings/account" behavior the workspace switcher
 * used to fall through to — settings was a wrong destination both
 * functionally (you go there to manage existing workspaces, not
 * create new ones) and visually (a full screen swap for what's
 * really just a 2-field form).
 *
 * Structure mirrors the rest of the mobile bottom-sheet family
 * (`mobile-new-chat-sheet`, `mobile-workspace-switcher-sheet`,
 * `mobile-filter-drawer`):
 *   - vaul `Drawer` with `rounded-t-2xl border-border/60`
 *   - Centered title + close button on the right
 *   - `bottom-[var(--native-keyboard-height,0px)]!` so the sheet
 *     rises with the soft keyboard on iOS Capacitor
 *   - Safe-area aware footer
 *   - Single shared validation hook (`useWorkspaceSlugField`) so
 *     the slug rules / availability check match the desktop dialog
 */
export function MobileCreateWorkspaceSheet({
  open,
  onOpenChange,
  onCreated,
}: MobileCreateWorkspaceSheetProps) {
  const { t } = useTranslation();
  const { createOrganization } = useOrganization();
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const creationAvailability = useCloudQuery(
    cloudOperations.billing.getWorkspaceCreationAvailability
  );
  const creationAvailable = creationAvailability?.canCreateFree === true;
  const creationBlocked = creationAvailability?.canCreateFree === false;
  const { slug, setSlug, resetSlug, canReset, isChecking, isAvailable, error } =
    useWorkspaceSlugField(name);

  const canSubmit =
    creationAvailable &&
    !!name.trim() &&
    !!slug &&
    !error &&
    !isChecking &&
    isAvailable &&
    !creating;

  /* While the create mutation is in flight (and during the close
     animation right after success), suppress the slug field's error
     + checking states. Reason: `useWorkspaceSlugField` runs a
     reactive Convex query for slug availability. The moment
     `createOrganization` succeeds, the new row hits the database
     and Convex revalidates the query — it returns
     `{ available: false }` for the slug the user just took, which
     flips `error` to `'unavailable'`. The sheet is still on-screen
     during the vaul close animation (~300ms), so the user briefly
     sees a destructive-red "slug taken" message for the workspace
     they just successfully created. Skipping the message while
     `creating` is true bridges that window cleanly — the canSubmit
     check above already rules out re-submitting from this state, so
     hiding the message has no functional risk. */
  const showError = !creating && error;
  const showCheckingHint = !creating && slug && isChecking;
  const showAvailableHint = !creating && slug && isAvailable && !error;

  const handleClose = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      /* Reset on close so reopening starts fresh — otherwise the
         previously-typed name would still be there. The slug field's
         own reset is wired separately so it follows the name. */
      setName('');
      resetSlug();
    }
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setCreating(true);
    try {
      const created = await createOrganization(name.trim(), slug);
      const targetSlug = created?.slug ?? slug;
      handleClose(false);
      onCreated?.(targetSlug);
    } catch (err) {
      console.error('Failed to create organization:', err);
    } finally {
      setCreating(false);
    }
  };

  return (
    <Drawer open={open} onOpenChange={handleClose} repositionInputs={false}>
      <DrawerContent
        className="mobile-create-workspace-sheet h-auto! max-h-[92dvh]! rounded-t-2xl border-border/60 bottom-[var(--native-keyboard-height,0px)]!"
        style={{
          /* Match the new-chat sheet's keyboard-rise easing so the
             two bottom-sheets feel like the same family when the user
             toggles between them. */
          transition: 'bottom 320ms cubic-bezier(0.32, 0.72, 0, 1)',
          willChange: 'bottom',
        }}
      >
        <div {...stylex.props(sheetSurface.columnAuto)}>
          <header {...stylex.props(sheetSurface.header)}>
            <DrawerTitle {...stylex.props(sheetSurface.title, sheetSurface.titleCentered)}>
              {creationBlocked
                ? t('organization.mobileWorkspaceLimitReachedTitle')
                : t('organization.createNewWorkspace', 'Create New Workspace')}
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
          {/* The drawer's own description carries a body size; the
              description's own size stays a Tailwind class so it keeps
              winning over it. */}
          <DrawerDescription {...withClassName(stylex.props(styles.description), 'text-[0.78rem]')}>
            {creationBlocked
              ? t('organization.mobileWorkspaceLimitReachedDescription')
              : t('organization.createNewWorkspaceDescription')}
          </DrawerDescription>

          {creationAvailable ? (
            <div {...stylex.props(styles.body)}>
              <div {...stylex.props(styles.fields)}>
                {/* The field's label and its control are set apart by the
                    container's own `space-y`; StyleX has no descendant
                    selector, so that spacing stays a Tailwind class. */}
                <div className="space-y-1.5">
                  <UiField.Label
                    htmlFor="mobile-create-workspace-name"
                    className="text-[0.78rem] font-medium"
                  >
                    {t('organization.workspaceName', 'Workspace name')}
                  </UiField.Label>
                  <Input
                    id="mobile-create-workspace-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={t('organization.workspaceNamePlaceholder', 'Enter workspace name')}
                    disabled={creating}
                    autoFocus
                    enterKeyHint="next"
                  />
                </div>

                <div className="space-y-1.5">
                  <div {...stylex.props(styles.slugHead)}>
                    <UiField.Label
                      htmlFor="mobile-create-workspace-slug"
                      className="text-[0.78rem] font-medium"
                    >
                      {t('organization.workspaceSlug', 'Workspace slug')}
                    </UiField.Label>
                    {canReset ? (
                      <button
                        type="button"
                        onClick={resetSlug}
                        disabled={creating}
                        {...stylex.props(styles.slugReset)}
                      >
                        {t('organization.workspaceSlugReset', 'Use suggestion')}
                      </button>
                    ) : null}
                  </div>
                  <Input
                    id="mobile-create-workspace-slug"
                    value={slug}
                    onChange={(event) => setSlug(event.target.value)}
                    placeholder={t('organization.workspaceSlugPlaceholder', 'my-workspace')}
                    disabled={creating}
                    {...stylex.props(showError && styles.slugBorderError)}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    enterKeyHint="done"
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && canSubmit) {
                        event.preventDefault();
                        void handleSubmit();
                      }
                    }}
                  />
                  {showError ? (
                    <p {...stylex.props(styles.slugHint, styles.slugHintError)}>
                      {t(`organization.workspaceSlugError.${error}`)}
                    </p>
                  ) : showCheckingHint ? (
                    <p {...stylex.props(styles.slugHint, styles.slugHintChecking)}>
                      {t('organization.workspaceSlugChecking', 'Checking availability...')}
                    </p>
                  ) : showAvailableHint ? (
                    <p {...stylex.props(styles.slugHint, styles.slugHintAvailable)}>
                      {t('organization.workspaceSlugAvailable', 'Slug available')}
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}

          <div {...stylex.props(sheetSurface.footer, sheetSurface.footerPadKeyboard)}>
            <Button
              type="button"
              variant={creationBlocked ? 'primary' : 'secondary'}
              {...stylex.props(styles.action)}
              onClick={() => handleClose(false)}
              disabled={creating}
            >
              {creationBlocked ? t('common.close', 'Close') : t('common.cancel', 'Cancel')}
            </Button>
            {creationAvailable ? (
              <Button
                type="button"
                {...stylex.props(styles.action)}
                onClick={() => void handleSubmit()}
                disabled={!canSubmit}
              >
                {creating ? t('common.creating', 'Creating...') : t('common.create', 'Create')}
              </Button>
            ) : null}
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
