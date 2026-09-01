import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSetAtom } from 'jotai';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowRight, Building2, Check, Loader2, Plus, RotateCcw } from 'lucide-react';
import type { WorkspaceId } from '@lody/shared';
import { setWorkspaceContextAtom } from '@/atoms/workspace-context';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { toast } from 'sonner';
import { useCloudQuery, usePlatform, usePlatformWorkspaces } from '@lody/platform/react';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { cn } from '@/lib/utils';
import {
  generateWorkspaceSlug,
  getWorkspaceSlugRuleError,
  isUsableWorkspaceSlug,
  normalizeWorkspaceSlugInput,
  type WorkspaceSlugRuleError,
} from '@/lib/workspace';
import { OnboardingShell, OnboardingBackButton, OnboardingNextButton } from '../onboarding-shell';

type SlugError = 'required' | WorkspaceSlugRuleError | 'unavailable';

export interface WorkspaceListEntry {
  id: string;
  name: string;
  slug: string;
}

export interface WorkspaceScreenViewProps {
  /** All workspaces the current user is a member of. */
  workspaces: WorkspaceListEntry[];
  /** Load state of the workspace list itself; non-ready never looks like "empty". */
  workspacesStatus: 'loading' | 'error' | 'ready';
  /** Detail for `workspacesStatus === 'error'`, shown verbatim. */
  workspacesError: string | null;
  /** True while an explicit workspace-list retry is running. */
  retryingWorkspaces: boolean;
  onRetryWorkspaces: () => void;
  /** Highlighted (clicked, not yet confirmed) workspace id. */
  selectedWorkspaceId: string | null;
  /** True when the user has clicked "Create new" and the form is open. */
  creating: boolean;
  /** Open the create form (does not commit yet). */
  onStartCreate: () => void;
  /** Close the create form and return to the list. */
  onCancelCreate: () => void;

  /** Create-form state. Only meaningful while `creating === true`. */
  newName: string;
  newSlug: string;
  newSlugChecking: boolean;
  /** True when the availability check is slow; validation remains pending. */
  newSlugCheckSlow: boolean;
  newSlugError: SlugError | null;
  canResetSlug: boolean;
  onNewNameChange: (next: string) => void;
  onNewSlugChange: (next: string) => void;
  onResetNewSlug: () => void;

  /** True while the initial bounded wait is keeping navigation locked. */
  saving: boolean;
  /** True until the underlying mutation settles, including after the wait becomes stale. */
  writePending: boolean;
  /** Last create failure detail, shown inline until the input changes. */
  createError: string | null;

  /** Highlight a workspace in the list — does not advance. */
  onSelectWorkspace: (id: string) => void;
  /** Confirm the highlighted workspace and advance the flow. */
  onConfirmSelection: () => void;
  /** Submit the create form (advances on success). */
  onSubmitCreate: () => void;

  onBack: () => void;
}

export function WorkspaceScreenView({
  workspaces,
  workspacesStatus,
  workspacesError,
  retryingWorkspaces,
  onRetryWorkspaces,
  selectedWorkspaceId,
  creating,
  onStartCreate,
  onCancelCreate,
  newName,
  newSlug,
  newSlugChecking,
  newSlugCheckSlow,
  newSlugError,
  canResetSlug,
  onNewNameChange,
  onNewSlugChange,
  onResetNewSlug,
  saving,
  writePending,
  createError,
  onSelectWorkspace,
  onConfirmSelection,
  onSubmitCreate,
  onBack,
}: WorkspaceScreenViewProps) {
  const { t } = useTranslation();
  const hasWorkspaces = workspaces.length > 0;

  // Validation only matters while the create form is open.
  const newNameError =
    creating && newName.trim().length === 0
      ? t('organization.workspaceNameRequired', 'Workspace name is required')
      : null;
  const slugErrorText = (() => {
    if (!newSlugError) return null;
    if (newSlugError === 'required') {
      return t('organization.workspaceSlugError.required', 'Workspace handle is required');
    }
    if (newSlugError === 'unavailable') {
      return t('organization.workspaceSlugError.unavailable', 'This handle is taken');
    }
    return t(`organization.workspaceSlugError.${newSlugError}`);
  })();

  const canSubmitCreate =
    creating &&
    !writePending &&
    !newSlugChecking &&
    newNameError === null &&
    newSlugError === null &&
    newSlug.length > 0;
  // A slug-less workspace can never advance (the confirm handler requires it),
  // so the button must say so by being disabled rather than dying silently.
  const selectedEntry = workspaces.find((workspace) => workspace.id === selectedWorkspaceId);
  const canConfirmSelection =
    !writePending && selectedEntry !== undefined && selectedEntry.slug.length > 0;
  const previewWorkspaceName = creating
    ? newName.trim()
    : workspaces.find((workspace) => workspace.id === selectedWorkspaceId)?.name;

  return (
    <OnboardingShell
      stepKey="workspace"
      title={
        creating
          ? t('onboarding.workspace.createTitle', 'Create a workspace')
          : t('onboarding.workspace.title', 'Choose your workspace')
      }
      description={
        creating
          ? t(
              'onboarding.workspace.createDescription',
              'Give it a name — your team will see this everywhere.'
            )
          : workspacesStatus === 'loading'
            ? t('onboarding.workspace.loadingDescription', 'Loading your workspaces…')
            : workspacesStatus === 'error'
              ? t('onboarding.workspace.errorDescription', 'Your workspaces could not be loaded.')
              : hasWorkspaces
                ? t(
                    'onboarding.workspace.description',
                    'Pick the workspace you want to start with, or create a new one.'
                  )
                : t(
                    'onboarding.workspace.descriptionEmpty',
                    'Create your first workspace to get started.'
                  )
      }
      previewIdentity={previewWorkspaceName ? { workspaceName: previewWorkspaceName } : undefined}
      previewState={{
        workspaceStatus: writePending
          ? 'draft'
          : previewWorkspaceName || hasWorkspaces
            ? 'ready'
            : 'missing',
      }}
      secondaryAction={
        creating ? (
          <OnboardingBackButton
            onClick={onCancelCreate}
            disabled={saving}
            label={
              hasWorkspaces
                ? t('onboarding.workspace.backToList', 'Back to list')
                : t('common.cancel', 'Cancel')
            }
          />
        ) : (
          <OnboardingBackButton onClick={onBack} disabled={saving} />
        )
      }
      primaryAction={
        creating ? (
          <Button size="lg" disabled={!canSubmitCreate} onClick={onSubmitCreate} className="gap-2">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {createError
              ? t('common.retry', 'Retry')
              : t('onboarding.workspace.createAndContinue', 'Create & continue')}
            {!saving ? (
              createError ? (
                <RotateCcw className="h-4 w-4" />
              ) : (
                <ArrowRight className="h-4 w-4" />
              )
            ) : null}
          </Button>
        ) : hasWorkspaces ? (
          <OnboardingNextButton
            onClick={onConfirmSelection}
            disabled={!canConfirmSelection}
            loading={saving}
          />
        ) : null
      }
    >
      <AnimatePresence mode="wait" initial={false}>
        {creating ? (
          <motion.div
            key="create-form"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.25 }}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="onboarding-workspace-name">
                {t('organization.workspaceName', 'Workspace name')}
              </Label>
              <Input
                id="onboarding-workspace-name"
                value={newName}
                onChange={(event) => onNewNameChange(event.target.value)}
                placeholder={t('organization.workspaceNamePlaceholder', 'My Workspace')}
                autoFocus
                disabled={writePending}
                className={newNameError ? 'border-destructive' : ''}
              />
              {newNameError ? <p className="text-xs text-destructive">{newNameError}</p> : null}
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-4">
                <Label htmlFor="onboarding-workspace-slug" className="whitespace-nowrap">
                  {t('organization.workspaceSlug', 'Handle')}
                </Label>
                {canResetSlug ? (
                  <button
                    type="button"
                    className="shrink-0 whitespace-nowrap text-xs text-muted-foreground hover:text-foreground"
                    onClick={onResetNewSlug}
                    disabled={writePending}
                  >
                    {t('organization.workspaceSlugReset', 'Reset')}
                  </button>
                ) : null}
              </div>
              <Input
                id="onboarding-workspace-slug"
                value={newSlug}
                onChange={(event) => onNewSlugChange(event.target.value)}
                placeholder={t('organization.workspaceSlugPlaceholder', 'my-workspace')}
                disabled={writePending}
                className={newSlugError ? 'border-destructive' : ''}
              />
              {slugErrorText ? (
                <p className="text-xs text-destructive">{slugErrorText}</p>
              ) : newSlugChecking ? (
                <p
                  role="status"
                  className="flex max-w-full items-start gap-1.5 text-xs leading-5 text-muted-foreground"
                >
                  <Loader2 className="mt-1 size-3 shrink-0 animate-spin" />
                  <span className="min-w-0 break-words">
                    {newSlugCheckSlow
                      ? t(
                          'organization.workspaceSlugCheckingSlow',
                          'Network is taking longer than expected. Still checking…'
                        )
                      : t('organization.workspaceSlugChecking', 'Checking…')}
                  </span>
                </p>
              ) : newSlug.length > 0 ? (
                <p role="status" className="text-xs text-primary">
                  {t('organization.workspaceSlugAvailable', 'Available')}
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground/80">
                {t(
                  'onboarding.workspace.slugHint',
                  'Used in URLs. Lowercase letters, numbers, and dashes.'
                )}
              </p>
            </div>

            {createError !== null ? (
              <div
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                <p>
                  {t('onboarding.workspace.createFailed', 'Could not create workspace. Try again.')}
                </p>
                {createError.length > 0 ? (
                  <p className="mt-1 break-words opacity-90">{createError}</p>
                ) : null}
              </div>
            ) : null}
          </motion.div>
        ) : (
          <motion.div
            key="list"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.25 }}
            className="flex flex-col gap-3"
          >
            {workspacesStatus === 'loading' ? (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('onboarding.workspace.loading', 'Loading workspaces…')}
              </div>
            ) : workspacesStatus === 'error' ? (
              <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-3">
                <div role="alert" className="text-xs text-destructive">
                  <p>{t('onboarding.workspace.loadFailed', 'Could not load workspaces.')}</p>
                  {workspacesError ? (
                    <p className="mt-1 break-words font-mono opacity-90">{workspacesError}</p>
                  ) : null}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={retryingWorkspaces}
                  onClick={onRetryWorkspaces}
                  className="gap-2"
                >
                  <RotateCcw className={cn('size-3.5', retryingWorkspaces && 'animate-spin')} />
                  {t('common.retry', 'Retry')}
                </Button>
              </div>
            ) : hasWorkspaces ? (
              // ~6 rows visible (each row ≈ 64px incl. gap); longer lists scroll
              // inside the card with the transparent-track style.
              <div className="scrollbar-pro -mx-1 max-h-[420px] overflow-y-auto overscroll-contain px-1 py-2">
                <div className="flex flex-col gap-2">
                  {workspaces.map((workspace) => {
                    const isSelected = workspace.id === selectedWorkspaceId;
                    // A workspace without a slug cannot be confirmed downstream;
                    // show why instead of letting Next die silently.
                    const hasSlug = workspace.slug.length > 0;
                    return (
                      <motion.button
                        key={workspace.id}
                        type="button"
                        whileHover={writePending || !hasSlug ? undefined : { y: -1 }}
                        whileTap={writePending || !hasSlug ? undefined : { scale: 0.99 }}
                        disabled={writePending || !hasSlug}
                        onClick={() => onSelectWorkspace(workspace.id)}
                        aria-pressed={isSelected}
                        className={cn(
                          'group flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-all',
                          'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
                          'disabled:cursor-not-allowed disabled:opacity-60',
                          isSelected
                            ? 'border-primary/60 bg-primary/[0.05] shadow-[0_0_0_3px_hsl(var(--primary)/0.08)]'
                            : 'border-border/60 bg-card/40 hover:border-border hover:bg-card/70'
                        )}
                      >
                        <div
                          className={cn(
                            'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-colors',
                            isSelected
                              ? 'bg-primary text-primary-foreground'
                              : 'bg-muted/50 text-foreground/80'
                          )}
                        >
                          <Building2 className="h-5 w-5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-foreground">
                            {workspace.name}
                          </span>
                          <div className="truncate text-xs text-muted-foreground">
                            {hasSlug
                              ? `/${workspace.slug}`
                              : t(
                                  'onboarding.workspace.slugMissing',
                                  'No handle yet — open workspace settings to set one.'
                                )}
                          </div>
                        </div>
                        {isSelected ? (
                          <span
                            className={cn(
                              'flex h-5 w-5 shrink-0 items-center justify-center rounded-full',
                              'bg-primary text-primary-foreground'
                            )}
                            aria-hidden
                          >
                            <Check className="h-3 w-3" />
                          </span>
                        ) : (
                          <span
                            className="h-5 w-5 shrink-0 rounded-full border border-border/70 transition-colors group-hover:border-foreground/50"
                            aria-hidden
                          />
                        )}
                      </motion.button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {workspacesStatus === 'ready' ? (
              <button
                type="button"
                disabled={writePending}
                onClick={onStartCreate}
                className={cn(
                  'group flex items-center justify-center gap-2 rounded-lg border-2 border-dashed py-4 text-sm font-medium transition-all',
                  'border-border/60 text-muted-foreground hover:border-primary/60 hover:bg-primary/[0.04] hover:text-foreground',
                  'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
                  'disabled:opacity-50'
                )}
              >
                <Plus className="h-4 w-4 transition-transform group-hover:rotate-90" />
                {t('onboarding.workspace.createNew', 'Create a new workspace')}
              </button>
            ) : null}
          </motion.div>
        )}
      </AnimatePresence>
    </OnboardingShell>
  );
}

interface WorkspaceScreenProps {
  onBack: () => void;
  onNext: () => void;
}

// We deliberately do not edit existing names/slugs here — that's handled in
// workspace settings, where it can be undone.
/** Marks a slow slug check without treating an unanswered query as validation. */
const SLUG_CHECK_SLOW_MS = 8_000;
/** Bounds how long a workspace write may prevent Back/Cancel. */
const WORKSPACE_WRITE_STALE_MS = 15_000;
const pendingWorkspaceWrites = new WeakMap<object, Promise<unknown>>();

function trackWorkspaceWrite<T>(owner: object, write: Promise<T>): Promise<T> {
  pendingWorkspaceWrites.set(owner, write);
  const clear = () => {
    if (pendingWorkspaceWrites.get(owner) === write) pendingWorkspaceWrites.delete(owner);
  };
  void write.then(clear, clear);
  return write;
}

export function WorkspaceScreen({ onBack, onNext }: WorkspaceScreenProps) {
  const { t } = useTranslation();
  const platform = usePlatform();
  const workspaceState = usePlatformWorkspaces();
  const setWorkspaceContext = useSetAtom(setWorkspaceContextAtom);

  const workspaces = useMemo<WorkspaceListEntry[]>(
    () =>
      (workspaceState.status === 'ready' ? workspaceState.workspaces : []).map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug ?? '',
      })),
    [workspaceState]
  );
  const activeWorkspaceId =
    workspaceState.status === 'ready' ? workspaceState.activeWorkspaceId : null;
  const activeWorkspace =
    workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null;

  const commitWorkspaceContext = useCallback(
    (workspace: WorkspaceListEntry | null) => {
      setWorkspaceContext({
        slug: workspace?.slug || null,
        workspaceId: workspace ? (workspace.id as WorkspaceId) : null,
      });
    },
    [setWorkspaceContext]
  );

  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [writePending, setWritePending] = useState(() =>
    pendingWorkspaceWrites.has(platform.workspaces)
  );
  const [createError, setCreateError] = useState<string | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(activeWorkspaceId);
  const [retryingWorkspaces, setRetryingWorkspaces] = useState(false);
  const [workspaceRetryError, setWorkspaceRetryError] = useState<string | null>(null);

  useEffect(() => {
    if (workspaceState.status === 'error') {
      console.error('[onboarding] Failed to load workspaces:', workspaceState.message);
      return;
    }
    setWorkspaceRetryError(null);
  }, [workspaceState]);

  const handleRetryWorkspaces = useCallback(() => {
    if (retryingWorkspaces) return;
    const retry = platform.workspaces.retry;
    if (!retry) {
      const error = new Error('Workspace reload is unavailable on this platform');
      console.error('[onboarding] Failed to retry workspace loading:', error);
      setWorkspaceRetryError(error.message);
      return;
    }
    setRetryingWorkspaces(true);
    setWorkspaceRetryError(null);
    void retry()
      .catch((error: unknown) => {
        console.error('[onboarding] Failed to retry workspace loading:', error);
        setWorkspaceRetryError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setRetryingWorkspaces(false);
      });
  }, [platform.workspaces, retryingWorkspaces]);

  // A write can outlive this phase after Back. Re-entering the step must join
  // that write instead of issuing a competing setActive mutation.
  useEffect(() => {
    const pending = pendingWorkspaceWrites.get(platform.workspaces);
    if (!pending) return undefined;
    let mounted = true;
    setSaving(false);
    setWritePending(true);
    const settle = () => {
      if (mounted) setWritePending(false);
    };
    void pending.then(settle, settle);
    return () => {
      mounted = false;
    };
  }, [platform.workspaces]);

  // Only a READY empty list opens the create form; while the list is loading
  // or failed, the form must not pose as "you have no workspaces".
  const workspacesReadyEmpty =
    workspaceState.status === 'ready' && workspaceState.workspaces.length === 0;
  useEffect(() => {
    if (workspacesReadyEmpty) setCreating(true);
  }, [workspacesReadyEmpty]);

  // Default-select the active workspace once it loads, so the user can
  // immediately confirm and proceed without an extra click. A slug-less
  // workspace can never be confirmed, so pre-selecting it would just arm a
  // dead Next button.
  useEffect(() => {
    if (selectedWorkspaceId === null && activeWorkspace?.slug) {
      setSelectedWorkspaceId(activeWorkspace.id);
    }
  }, [activeWorkspace, selectedWorkspaceId]);

  // Incremented per write attempt so a late-settling promise from a superseded
  // attempt can never commit or navigate.
  const writeAttemptRef = useRef(0);
  useEffect(
    () => () => {
      writeAttemptRef.current += 1;
    },
    []
  );

  const [newName, setNewName] = useState('');
  // null = follow the auto-suggested slug derived from the name. A user edit
  // pins a manual draft; "Reset" clears back to null.
  const [slugDraft, setSlugDraft] = useState<string | null>(null);

  const suggestedSlug = useMemo(() => generateWorkspaceSlug(newName), [newName]);
  const newSlug = slugDraft ?? suggestedSlug;

  const shouldCheckAvailability = isUsableWorkspaceSlug(newSlug);
  const canCheckAvailability = creating && shouldCheckAvailability;
  const availability = useCloudQuery(
    cloudOperations.auth.isWorkspaceSlugAvailable,
    creating && shouldCheckAvailability ? { slug: newSlug } : 'skip'
  );
  const newSlugChecking =
    creating && shouldCheckAvailability && canCheckAvailability && availability === undefined;
  const [newSlugCheckSlow, setNewSlugCheckSlow] = useState(false);
  useEffect(() => {
    if (!newSlugChecking) {
      setNewSlugCheckSlow(false);
      return undefined;
    }
    const timer = setTimeout(() => setNewSlugCheckSlow(true), SLUG_CHECK_SLOW_MS);
    return () => clearTimeout(timer);
  }, [newSlugChecking]);

  const newSlugError = useMemo<SlugError | null>(() => {
    if (!creating) return null;
    if (!newSlug) return 'required';
    const ruleError = getWorkspaceSlugRuleError(newSlug);
    if (ruleError) return ruleError;
    // Only a resolved answer can condemn a slug. A slow pending check is still
    // pending, never "taken" and never permission to bypass server validation.
    if (shouldCheckAvailability && availability !== undefined && !availability.available) {
      return 'unavailable';
    }
    return null;
  }, [creating, newSlug, shouldCheckAvailability, availability]);

  const handleConfirmSelection = useCallback(() => {
    if (selectedWorkspaceId === null || writePending) return;
    const target = workspaces.find((workspace) => workspace.id === selectedWorkspaceId);
    if (!target?.slug) return;
    if (selectedWorkspaceId === activeWorkspaceId) {
      commitWorkspaceContext(target);
      onNext();
      return;
    }
    setSaving(true);
    setWritePending(true);
    commitWorkspaceContext(null);
    const attempt = ++writeAttemptRef.current;
    const switchWrite = trackWorkspaceWrite(
      platform.workspaces,
      platform.workspaces.setActive(selectedWorkspaceId)
    );
    const staleTimer = setTimeout(() => {
      if (writeAttemptRef.current !== attempt) return;
      const error = new Error(
        t(
          'onboarding.workspace.timedOut',
          'The request timed out. You can go back while it finishes in the background.'
        )
      );
      console.error('[onboarding] Workspace switch timed out:', error);
      setSaving(false);
      toast.error(
        t('onboarding.workspace.switchFailed', 'Could not switch workspace. Try again.'),
        { description: error.message }
      );
    }, WORKSPACE_WRITE_STALE_MS);
    void switchWrite.then(
      () => {
        clearTimeout(staleTimer);
        setSaving(false);
        setWritePending(false);
        if (writeAttemptRef.current !== attempt) return;
        commitWorkspaceContext(target);
        onNext();
      },
      (error: unknown) => {
        clearTimeout(staleTimer);
        setSaving(false);
        setWritePending(false);
        if (writeAttemptRef.current !== attempt) return;
        console.error('[onboarding] Failed to switch workspace:', error);
        commitWorkspaceContext(activeWorkspace);
        toast.error(
          t('onboarding.workspace.switchFailed', 'Could not switch workspace. Try again.'),
          { description: error instanceof Error ? error.message : String(error) }
        );
      }
    );
  }, [
    activeWorkspace,
    activeWorkspaceId,
    commitWorkspaceContext,
    onNext,
    platform.workspaces,
    selectedWorkspaceId,
    t,
    writePending,
    workspaces,
  ]);

  const handleSubmitCreate = useCallback(() => {
    const trimmedName = newName.trim();
    if (writePending || !trimmedName || newSlugError !== null || newSlugChecking) {
      return;
    }
    setSaving(true);
    setWritePending(true);
    setCreateError(null);
    commitWorkspaceContext(null);
    const attempt = ++writeAttemptRef.current;
    const createWrite = trackWorkspaceWrite(
      platform.workspaces,
      (async () => {
        if (!platform.workspaces.create) {
          throw new Error('Workspace creation is unavailable on this platform');
        }
        const created = await platform.workspaces.create({ name: trimmedName, slug: newSlug });
        if (writeAttemptRef.current !== attempt) return null;
        await platform.workspaces.setActive(created.id);
        return created;
      })()
    );
    const staleTimer = setTimeout(() => {
      if (writeAttemptRef.current !== attempt) return;
      const error = new Error(
        t(
          'onboarding.workspace.timedOut',
          'The request timed out. You can go back while it finishes in the background.'
        )
      );
      console.error('[onboarding] Workspace creation timed out:', error);
      setSaving(false);
      setCreateError(error.message);
    }, WORKSPACE_WRITE_STALE_MS);
    void createWrite.then(
      (created) => {
        clearTimeout(staleTimer);
        setSaving(false);
        setWritePending(false);
        if (!created || writeAttemptRef.current !== attempt) return;
        commitWorkspaceContext({
          id: created.id,
          name: created.name,
          slug: created.slug ?? newSlug,
        });
        onNext();
      },
      (error: unknown) => {
        clearTimeout(staleTimer);
        setSaving(false);
        setWritePending(false);
        if (writeAttemptRef.current !== attempt) return;
        console.error('[onboarding] Failed to create workspace:', error);
        commitWorkspaceContext(activeWorkspace);
        // The error stays inline in the form: a toast disappears and leaves a
        // user with no workspaces without any visible way forward.
        setCreateError(error instanceof Error ? error.message : String(error));
      }
    );
  }, [
    activeWorkspace,
    commitWorkspaceContext,
    newName,
    newSlug,
    newSlugChecking,
    newSlugError,
    onNext,
    platform.workspaces,
    t,
    writePending,
  ]);

  return (
    <WorkspaceScreenView
      workspaces={workspaces}
      workspacesStatus={workspaceState.status}
      workspacesError={
        workspaceRetryError ?? (workspaceState.status === 'error' ? workspaceState.message : null)
      }
      retryingWorkspaces={retryingWorkspaces}
      onRetryWorkspaces={handleRetryWorkspaces}
      selectedWorkspaceId={selectedWorkspaceId}
      creating={creating}
      onStartCreate={() => {
        setCreating(true);
        setNewName('');
        setSlugDraft(null);
        setCreateError(null);
      }}
      onCancelCreate={() => {
        writeAttemptRef.current += 1;
        setCreateError(null);
        if (workspaces.length === 0) {
          // No list to fall back to — cancel leaves the step instead of
          // trapping the user in a form they cannot complete.
          onBack();
          return;
        }
        setCreating(false);
      }}
      newName={newName}
      newSlug={newSlug}
      newSlugChecking={newSlugChecking}
      newSlugCheckSlow={newSlugCheckSlow}
      newSlugError={newSlugError}
      canResetSlug={slugDraft !== null && slugDraft !== suggestedSlug}
      onNewNameChange={(next) => {
        setCreateError(null);
        setNewName(next);
      }}
      onNewSlugChange={(next) => {
        setCreateError(null);
        setSlugDraft(normalizeWorkspaceSlugInput(next));
      }}
      onResetNewSlug={() => setSlugDraft(null)}
      saving={saving}
      writePending={writePending}
      createError={createError}
      onSelectWorkspace={setSelectedWorkspaceId}
      onConfirmSelection={handleConfirmSelection}
      onSubmitCreate={handleSubmitCreate}
      onBack={() => {
        writeAttemptRef.current += 1;
        onBack();
      }}
    />
  );
}
