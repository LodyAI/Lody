import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { useCloudQuery } from '@lody/platform/react';

import { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerTitle } from '@/ui/drawer';
import { Button } from '@lody/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { useOrganization } from '../../hooks/useOrganization';
import { useWorkspaceSlugField } from '../../hooks/useWorkspaceSlugField';
import { cn } from '@/lib/utils';

export type MobileCreateWorkspaceSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fired with the new workspace's slug after a successful create.
     Caller is expected to navigate the user into the new workspace. */
  onCreated?: (slug: string) => void;
};

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
        className={cn(
          'mobile-create-workspace-sheet',
          'h-auto! max-h-[92dvh]! rounded-t-2xl border-border/60',
          'bottom-[var(--native-keyboard-height,0px)]!'
        )}
        style={{
          /* Match the new-chat sheet's keyboard-rise easing so the
             two bottom-sheets feel like the same family when the user
             toggles between them. */
          transition: 'bottom 320ms cubic-bezier(0.32, 0.72, 0, 1)',
          willChange: 'bottom',
        }}
      >
        <div className="flex max-h-full min-h-0 flex-col">
          <header className="relative flex items-center px-4 pb-2 pt-2">
            <DrawerTitle className="mx-auto text-[0.95rem] font-semibold tracking-tight">
              {creationBlocked
                ? t('organization.mobileWorkspaceLimitReachedTitle')
                : t('organization.createNewWorkspace', 'Create New Workspace')}
            </DrawerTitle>
            <DrawerClose asChild>
              <button
                type="button"
                aria-label={t('common.close', 'Close')}
                className={cn(
                  'absolute right-3 top-1.5 inline-flex h-9 w-9 items-center justify-center rounded-full',
                  'text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground'
                )}
              >
                <X className="h-5 w-5" aria-hidden="true" strokeWidth={1.8} />
              </button>
            </DrawerClose>
          </header>
          <DrawerDescription className="whitespace-pre-line px-4 pb-3 text-[0.78rem] text-muted-foreground">
            {creationBlocked
              ? t('organization.mobileWorkspaceLimitReachedDescription')
              : t('organization.createNewWorkspaceDescription')}
          </DrawerDescription>

          {creationAvailable ? (
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-2">
              <div className="flex flex-col gap-4">
                <div className="space-y-1.5">
                  <Label
                    htmlFor="mobile-create-workspace-name"
                    className="text-[0.78rem] font-medium"
                  >
                    {t('organization.workspaceName', 'Workspace name')}
                  </Label>
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
                  <div className="flex items-center justify-between">
                    <Label
                      htmlFor="mobile-create-workspace-slug"
                      className="text-[0.78rem] font-medium"
                    >
                      {t('organization.workspaceSlug', 'Workspace slug')}
                    </Label>
                    {canReset ? (
                      <button
                        type="button"
                        onClick={resetSlug}
                        disabled={creating}
                        className={cn(
                          'text-[0.72rem] font-medium transition-colors',
                          'text-muted-foreground hover:text-foreground active:scale-[0.97]'
                        )}
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
                    className={showError ? 'border-destructive' : ''}
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
                    <p className="text-[0.72rem] text-destructive">
                      {t(`organization.workspaceSlugError.${error}`)}
                    </p>
                  ) : showCheckingHint ? (
                    <p className="text-[0.72rem] text-muted-foreground">
                      {t('organization.workspaceSlugChecking', 'Checking availability...')}
                    </p>
                  ) : showAvailableHint ? (
                    <p className="text-[0.72rem] text-primary">
                      {t('organization.workspaceSlugAvailable', 'Slug available')}
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}

          <div
            className={cn(
              'flex shrink-0 items-center gap-2 border-t border-border/40 px-4 pt-3',
              /* Keyboard-aware bottom padding: when the soft keyboard
                 is up the home indicator is hidden behind it, so the
                 safe-area inset is dead weight. Collapse it to 12px in
                 that case while keeping the full safe-area when the
                 keyboard is down. Mirrors the new-chat sheet's same
                 trick. */
              'pb-[calc(12px+max(0px,var(--safe-area-bottom,0px)-var(--native-keyboard-height,0px)))]'
            )}
          >
            <Button
              type="button"
              variant={creationBlocked ? 'primary' : 'secondary'}
              className="flex-1"
              onClick={() => handleClose(false)}
              disabled={creating}
            >
              {creationBlocked ? t('common.close', 'Close') : t('common.cancel', 'Cancel')}
            </Button>
            {creationAvailable ? (
              <Button
                type="button"
                className="flex-1"
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
