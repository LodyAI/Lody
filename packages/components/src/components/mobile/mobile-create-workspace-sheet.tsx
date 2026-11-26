import { useFoldAwareSheetHeight } from './use-vertical-division';
import { useKeyboardAwareSheet } from '@/hooks/use-keyboard-aware-scroll-into-view';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { useAtomValue } from 'jotai';
import { cloudOperations } from '@/lib/cloud-api-operations';
import * as stylex from '@stylexjs/stylex';
import { useCloudQuery, usePlatform } from '@lody/platform/react';
import { e2eeWorkspaceCreationFeatureEnabledAtom } from '@/atoms/settings';
import { useE2eeAccountId } from '@/lib/e2ee-account';
import {
  createPreparedE2eeWorkspace,
  e2eeCreationErrorCode,
  isE2eeCreationNotEnabled,
  reconcilePendingE2eeWorkspaces,
} from '../../lib/create-e2ee-workspace';
import { isLocalStorageFailure, localStorageFailureKey } from '../../lib/e2ee-actionable-failure';
import {
  clearPendingE2eeWorkspace,
  listPendingE2eeWorkspaces,
  savePendingE2eeWorkspace,
  type PendingE2eeWorkspace,
} from '@/lib/e2ee-workspace-storage';
import { isE2eeActionTimeoutError } from '../../providers/cloud-e2ee-workspaces';
import { E2eeWorkspaceCreationOption } from '@/components/pages/e2ee-workspace-creation-option';

import { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerTitle } from '@/ui/drawer';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Field as UiField } from '@lody/ui/field';
import { field } from '@lody/ui/field/field.tokens.stylex';
import { Alert } from '@lody/ui/alert';
import { useOrganization } from '../../hooks/useOrganization';
import { useWorkspaceSlugField } from '../../hooks/useWorkspaceSlugField';
import { useAuthenticatedConvex } from '@/hooks/use-authenticated-convex';
import { themeColors } from '../../style/theme-colors.stylex';
import { themeFontWeight, themeSpace, themeRadius } from '../../style/theme-scale.stylex';
import { sheetSurface } from './sheet-surface';

export type MobileCreateWorkspaceSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fired with the new workspace's slug after a successful create.
     Caller is expected to navigate the user into the new workspace.
     `workspaceId` is present for an encrypted create so the caller can open
     its device/ledger control page instead of an ordinary chat route. */
  onCreated?: (slug: string, workspaceId?: string) => void;
};

/** Tailwind's `transition-colors`: colour properties only, 150ms, standard ease. */
const TRANSITION_COLORS = {
  transitionProperty: 'color, background-color, border-color, text-decoration-color, fill, stroke',
  transitionDuration: '150ms',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
} as const;

const styles = stylex.create({
  encryptedOption: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '16px',
    borderRadius: themeRadius.xl,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'color-mix(in oklab, hsl(var(--border) / 1) 60%, transparent)',
    padding: '12px',
  },
  encryptedText: {
    minWidth: 0,
    ':is(*) > :not(:last-child)': { marginBlockStart: 0, marginBlockEnd: '4px' },
  },
  encryptedLabel: { fontSize: '0.78rem', fontWeight: 500 },
  encryptedHint: { fontSize: '0.72rem', lineHeight: 1.375, color: themeColors.mutedForeground },

  formAlert: { flexShrink: 0, paddingInline: '16px', paddingBottom: '12px' },
  sheet: {
    height: 'auto',
    maxHeight: '92dvh',
    bottom: 'var(--native-keyboard-height,0px)',
  },
  fieldSpacing: {
    ':is(*) > :not(:last-child)': {
      'margin-block-start': 0,
      'margin-block-end': 'calc(var(--spacing) * 1.5)',
    },
  },

  fieldLabel: {
    [field.labelSize]: '0.78rem',
    [field.labelWeight]: 'var(--font-weight-medium)',
  },
  /** The sheet's description, under the header. */
  description: {
    whiteSpace: 'pre-line',
    textAlign: 'center',
    paddingInline: themeSpace[4],
    paddingBottom: themeSpace[3],
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
 *   - The shared keyboard-aware sheet contract lifts and scrolls the form
 *   - Safe-area aware footer
 *   - Single shared validation hook (`useWorkspaceSlugField`) so
 *     the slug rules / availability check match the desktop dialog
 */
export function MobileCreateWorkspaceSheet({
  open,
  onOpenChange,
  onCreated,
}: MobileCreateWorkspaceSheetProps) {
  const { t, i18n } = useTranslation();
  const keyboard = useKeyboardAwareSheet({ chromeHeight: '9rem' });
  const maxHeight = useFoldAwareSheetHeight(92, true);
  const { createOrganization } = useOrganization();
  const platform = usePlatform();
  const { isAuthenticated: isConvexAuthenticated } = useAuthenticatedConvex();
  const creationEnabled = useAtomValue(e2eeWorkspaceCreationFeatureEnabledAtom);
  const accountId = useE2eeAccountId(creationEnabled);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [encrypted, setEncrypted] = useState(false);
  const submitInFlight = useRef(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const accountRef = useRef(accountId);
  accountRef.current = accountId;
  const creationAvailability = useCloudQuery(
    cloudOperations.billing.getWorkspaceCreationAvailability
  );
  const creationAvailable = creationAvailability?.canCreateFree === true;
  const creationBlocked = creationAvailability?.canCreateFree === false;
  const encryptionSupported = Boolean(platform.e2eeWorkspaces?.prepareCreation);
  const { slug, setSlug, resetSlug, canReset, isChecking, isAvailable, error } =
    useWorkspaceSlugField(name);
  const onCreatedRef = useRef(onCreated);
  onCreatedRef.current = onCreated;
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  useEffect(() => {
    const port = platform.e2eeWorkspaces;
    if (!open || !accountId || !isConvexAuthenticated || !port?.prepareCreation) return undefined;
    let active = true;
    void reconcilePendingE2eeWorkspaces(
      port,
      localStorage,
      accountId,
      () => active && accountRef.current === accountId && !submitInFlight.current
    ).then((created) => {
      if (!created || !active || accountRef.current !== accountId || submitInFlight.current) return;
      onOpenChangeRef.current(false);
      onCreatedRef.current?.(created.slug, created.workspaceId);
    });
    return () => {
      active = false;
    };
  }, [accountId, isConvexAuthenticated, open, platform.e2eeWorkspaces]);

  const slugReady = !!slug && !error && !isChecking && isAvailable;
  const canSubmit =
    creationAvailable &&
    !!name.trim() &&
    slugReady &&
    !creating &&
    (!encrypted || encryptionSupported);

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
  // An untouched form has nothing to correct yet: "required" only appears once
  // a typed name produced no usable slug (or the slug was cleared).
  const showError = !creating && error && (error !== 'required' || name.trim().length > 0);
  const showCheckingHint = !creating && slug && isChecking;
  const showAvailableHint = !creating && slug && isAvailable && !error;

  const handleClose = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      /* Reset on close so reopening starts fresh — otherwise the
         previously-typed name would still be there. The slug field's
         own reset is wired separately so it follows the name. */
      setName('');
      setEncrypted(false);
      setCreateError(null);
      resetSlug();
    }
  };

  const handleSubmit = async () => {
    if (!canSubmit || submitInFlight.current) return;
    submitInFlight.current = true;
    setCreating(true);
    setCreateError(null);
    let submitted: PendingE2eeWorkspace | null = null;
    let isFreshIntent = false;
    try {
      if (encrypted) {
        const port = platform.e2eeWorkspaces;
        if (!port?.prepareCreation || !accountId) throw new Error('e2ee_creation_unavailable');
        const trimmedName = name.trim();
        const existingIntent = listPendingE2eeWorkspaces(localStorage, accountId).find(
          (item) => item.name === trimmedName && item.slug === slug
        );
        const intent: PendingE2eeWorkspace = existingIntent ?? {
          accountId,
          requestId: crypto.randomUUID(),
          name: trimmedName,
          slug,
        };
        submitted = intent;
        isFreshIntent = !existingIntent;
        if (isFreshIntent) savePendingE2eeWorkspace(localStorage, intent);
        const created = await createPreparedE2eeWorkspace(port, localStorage, intent);
        handleClose(false);
        onCreated?.(created.slug, created.workspaceId);
        return;
      }
      const created = await createOrganization(name.trim(), slug);
      const targetSlug = created?.slug ?? slug;
      handleClose(false);
      onCreated?.(targetSlug);
    } catch (err) {
      if (
        encrypted &&
        submitted &&
        isFreshIntent &&
        err instanceof Error &&
        err.message === 'e2ee_creation_cancelled'
      ) {
        try {
          clearPendingE2eeWorkspace(localStorage, submitted);
        } catch {
          // Best-effort cleanup on failure.
        }
      }
      if (err instanceof Error && err.message === 'e2ee_creation_cancelled') return;
      if (encrypted) {
        const refusalCode = e2eeCreationErrorCode(err);
        const refusalReason =
          refusalCode && i18n.exists(`e2ee.create.reason.${refusalCode}`)
            ? t(`e2ee.create.reason.${refusalCode}`)
            : undefined;
        setCreateError(
          isE2eeCreationNotEnabled(err)
            ? t('e2ee.create.notEnabled')
            : isE2eeActionTimeoutError(err)
              ? t('e2ee.create.timeout')
              : isLocalStorageFailure(err)
                ? t(localStorageFailureKey('create'))
                : refusalReason
                  ? t('e2ee.create.requestRemoved', { code: refusalReason })
                  : t('e2ee.create.failed')
        );
      } else {
        setCreateError(t('organization.createFailed'));
      }
      console.error('Failed to create organization:', err);
    } finally {
      submitInFlight.current = false;
      setCreating(false);
    }
  };

  return (
    <Drawer open={open} onOpenChange={handleClose} repositionInputs={false}>
      <DrawerContent
        className="mobile-create-workspace-sheet"
        xstyle={[styles.sheet, keyboard.contentXstyle]}
        style={{
          maxHeight: `min(${maxHeight}, calc(100dvh - var(--native-keyboard-height, 0px)))`,
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
          <DrawerDescription {...stylex.props(styles.description)} fontSize="0.78rem">
            {creationBlocked
              ? t('organization.mobileWorkspaceLimitReachedDescription')
              : t('organization.createNewWorkspaceDescription')}
          </DrawerDescription>

          {creationAvailable ? (
            <div
              ref={keyboard.scrollRef}
              style={{ ...keyboard.scrollStyle, paddingBottom: '0.5rem' }}
              {...stylex.props(styles.body)}
            >
              <div {...stylex.props(styles.fields)}>
                <div {...stylex.props(styles.fieldSpacing)}>
                  <UiField.Label
                    htmlFor="mobile-create-workspace-name"
                    className={stylex.props(styles.fieldLabel).className}
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

                <div {...stylex.props(styles.fieldSpacing)}>
                  <div {...stylex.props(styles.slugHead)}>
                    <UiField.Label
                      htmlFor="mobile-create-workspace-slug"
                      className={stylex.props(styles.fieldLabel).className}
                    >
                      {t('organization.workspaceSlug', 'Workspace slug')}
                    </UiField.Label>
                    {canReset && !creating ? (
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

                {creationEnabled ? (
                  <E2eeWorkspaceCreationOption
                    selected={encrypted}
                    supported={encryptionSupported}
                    disabled={creating || !accountId}
                    paidRequired={false}
                    onChange={setEncrypted}
                    encryptedChoiceTestId="mobile-create-workspace-encrypted"
                  />
                ) : null}
              </div>
            </div>
          ) : null}

          {createError != null ? (
            <div {...stylex.props(styles.formAlert)}>
              <Alert.Root tone="danger">
                <Alert.Description>{createError}</Alert.Description>
              </Alert.Root>
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
                {creating
                  ? encrypted
                    ? t('e2ee.create.creating')
                    : t('common.creating', 'Creating...')
                  : t('common.create', 'Create')}
              </Button>
            ) : null}
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
