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
  canDiscardPendingCreation,
  canResumePendingCreation,
  clearConfirmedPendingCreation,
  createPreparedE2eeWorkspace,
  e2eeCreationAvailability,
  e2eeCreationIntent,
  isE2eeCreationNotEnabled,
  pendingCreationRemoved,
} from '@/lib/create-e2ee-workspace';
import {
  listPendingE2eeWorkspaces,
  savePendingE2eeWorkspace,
  type PendingE2eeWorkspace,
} from '@/lib/e2ee-workspace-storage';

import { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerTitle } from '@/ui/drawer';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Field as UiField } from '@lody/ui/field';
import { field } from '@lody/ui/field/field.tokens.stylex';
import { Switch } from '@lody/ui/switch';
import { Alert } from '@lody/ui/alert';
import { AlertDialog } from '@/ui/dialog';
import { useOrganization } from '../../hooks/useOrganization';
import { useWorkspaceSlugField } from '../../hooks/useWorkspaceSlugField';
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
  const { t } = useTranslation();
  const keyboard = useKeyboardAwareSheet({ chromeHeight: '9rem' });
  const maxHeight = useFoldAwareSheetHeight(92, true);
  const { createOrganization } = useOrganization();
  const platform = usePlatform();
  const creationEnabled = useAtomValue(e2eeWorkspaceCreationFeatureEnabledAtom);
  const accountId = useE2eeAccountId(creationEnabled);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [encrypted, setEncrypted] = useState(false);
  const [pendingCreation, setPendingCreation] = useState<PendingE2eeWorkspace | null>(null);
  const submitInFlight = useRef(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [intentReadFailed, setIntentReadFailed] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  // Presentation only: keeps the "continuing a saved request" notice steady
  // through a retry instead of flashing it in for a first-time submit.
  const [resumeNoticeShown, setResumeNoticeShown] = useState(false);
  const creationAvailability = useCloudQuery(
    cloudOperations.billing.getWorkspaceCreationAvailability
  );
  // A submitted request may already have consumed the free slot and taken the
  // slug. Resume must not be blocked by checks that only apply to a new workspace.
  const pendingOwned = canResumePendingCreation(pendingCreation, accountId);
  const creationState = e2eeCreationAvailability(
    pendingOwned ? pendingCreation : null,
    creationAvailability
  );
  const resumable = creationState.resumable;
  const creationAvailable = creationState.canCreate;
  const creationBlocked = creationState.blocked;
  const encryptionSupported = Boolean(platform.e2eeWorkspaces?.prepareCreation);
  const { slug, setSlug, resetSlug, canReset, isChecking, isAvailable, error } =
    useWorkspaceSlugField(name);
  const fieldsDisabled = pendingOwned || creating;
  const showResumeNotice = pendingOwned && resumeNoticeShown;
  const formAlert = intentReadFailed ? t('e2ee.create.storageFailed') : createError;

  // Recover the exact saved intent on every open. A lost create response must
  // retry this requestId, name and handle, never mint a second device identity.
  useEffect(() => {
    if (!open || !accountId) return;
    try {
      const pending = listPendingE2eeWorkspaces(localStorage, accountId)[0] ?? null;
      setPendingCreation(pending);
      setResumeNoticeShown(Boolean(pending));
      setIntentReadFailed(false);
      setCreateError(null);
      if (pending) {
        setName(pending.name);
        setSlug(pending.slug);
        setEncrypted(true);
      }
    } catch {
      setIntentReadFailed(true);
    }
  }, [accountId, open, setSlug]);

  // Account changes drop only this component's recovered intent. The saved
  // request stays on disk for that same account's next open.
  useEffect(() => {
    if (pendingCreation && (!accountId || pendingCreation.accountId !== accountId))
      setPendingCreation(null);
  }, [accountId, pendingCreation]);

  const slugReady = resumable || (!!slug && !error && !isChecking && isAvailable);
  const canSubmit =
    creationAvailable &&
    !!name.trim() &&
    slugReady &&
    !creating &&
    !intentReadFailed &&
    (!pendingCreation || pendingOwned) &&
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
  const showError = !creating && !resumable && error;
  const showCheckingHint = !creating && !resumable && slug && isChecking;
  const showAvailableHint = !creating && !resumable && slug && isAvailable && !error;

  const handleClose = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      /* Reset on close so reopening starts fresh — otherwise the
         previously-typed name would still be there. The slug field's
         own reset is wired separately so it follows the name. */
      setName('');
      setEncrypted(false);
      setPendingCreation(null);
      setResumeNoticeShown(false);
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
    try {
      if (encrypted) {
        const port = platform.e2eeWorkspaces;
        if (!port?.prepareCreation || !accountId) throw new Error('e2ee_creation_unavailable');
        const intent = e2eeCreationIntent(
          accountId,
          pendingOwned ? pendingCreation : null,
          name,
          slug
        );
        // Persist before producing a device identity or sending a request. A lost
        // response retries these exact fields on this device.
        savePendingE2eeWorkspace(localStorage, intent);
        submitted = intent;
        setPendingCreation(intent);
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
      if (encrypted) {
        const removed = Boolean(
          submitted && pendingCreationRemoved(localStorage, accountId, submitted.requestId)
        );
        if (removed) {
          setPendingCreation(null);
          setResumeNoticeShown(false);
        } else if (!isE2eeCreationNotEnabled(err)) {
          setResumeNoticeShown(true);
        }
        setCreateError(
          isE2eeCreationNotEnabled(err) ? t('e2ee.create.notEnabled') : t('e2ee.create.failed')
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
                {showResumeNotice && pendingCreation ? (
                  <Alert.Root tone="neutral" data-testid="mobile-create-workspace-resume">
                    <Alert.Title>{t('e2ee.create.savedRequest')}</Alert.Title>
                    <Alert.Description>{t('e2ee.create.pending')}</Alert.Description>
                    {pendingOwned ? (
                      <Alert.Actions>
                        <Button
                          type="button"
                          variant="ghost"
                          tone="destructive"
                          size="small"
                          disabled={
                            !canDiscardPendingCreation(creating, pendingCreation, accountId)
                          }
                          onClick={() => {
                            if (creating) return;
                            setDiscardConfirmOpen(true);
                          }}
                        >
                          {t('e2ee.create.discardPending')}
                        </Button>
                      </Alert.Actions>
                    ) : null}
                  </Alert.Root>
                ) : null}

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
                    disabled={fieldsDisabled}
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
                    {canReset && !fieldsDisabled ? (
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
                    disabled={fieldsDisabled}
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
                  <div {...stylex.props(styles.encryptedOption)}>
                    <div {...stylex.props(styles.encryptedText)}>
                      <label
                        htmlFor="mobile-create-workspace-encrypted"
                        {...stylex.props(styles.encryptedLabel)}
                      >
                        {t('e2ee.create.label', 'Encrypted workspace (developer preview)')}
                      </label>
                      <p {...stylex.props(styles.encryptedHint)}>
                        {encryptionSupported
                          ? t(
                              'e2ee.create.mobileDescription',
                              'Keys stay in this device’s protected storage. This mode cannot be changed later.'
                            )
                          : t(
                              'e2ee.create.unsupported',
                              'This platform has no protected device key storage yet.'
                            )}
                      </p>
                    </div>
                    <Switch
                      id="mobile-create-workspace-encrypted"
                      data-testid="mobile-create-workspace-encrypted"
                      checked={encrypted}
                      disabled={fieldsDisabled || !encryptionSupported || !accountId}
                      onCheckedChange={setEncrypted}
                    />
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {formAlert != null ? (
            <div {...stylex.props(styles.formAlert)}>
              <Alert.Root tone="danger">
                <Alert.Description>{formAlert}</Alert.Description>
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
                  ? t('common.creating', 'Creating...')
                  : resumable
                    ? t('e2ee.create.resume', 'Continue saved creation')
                    : t('common.create', 'Create')}
              </Button>
            ) : null}
          </div>

          <AlertDialog.Root open={discardConfirmOpen} onOpenChange={setDiscardConfirmOpen}>
            <AlertDialog.Content>
              <AlertDialog.Header>
                <AlertDialog.Title>
                  {t('e2ee.create.discardConfirmTitle', 'Discard saved creation request?')}
                </AlertDialog.Title>
                <AlertDialog.Description>
                  {t(
                    'e2ee.create.discardConfirmDescription',
                    'This removes the only saved request for this workspace on this device. It cannot be undone.'
                  )}
                </AlertDialog.Description>
              </AlertDialog.Header>
              <AlertDialog.Footer>
                <AlertDialog.Cancel>{t('common.cancel', 'Cancel')}</AlertDialog.Cancel>
                <AlertDialog.Action
                  variant="destructive"
                  onClick={() => {
                    if (!clearConfirmedPendingCreation(localStorage, pendingCreation, true)) return;
                    setPendingCreation(null);
                    setResumeNoticeShown(false);
                    setName('');
                    setEncrypted(false);
                    setCreateError(null);
                    resetSlug();
                    setDiscardConfirmOpen(false);
                  }}
                >
                  {t('e2ee.create.discardConfirmAction', 'Discard request')}
                </AlertDialog.Action>
              </AlertDialog.Footer>
            </AlertDialog.Content>
          </AlertDialog.Root>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
