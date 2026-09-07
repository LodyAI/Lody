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
import { ErrorBoundary } from '@/components/error-boundary';
import {
  generateWorkspaceSlug,
  getWorkspaceSlugRuleError,
  isUsableWorkspaceSlug,
  normalizeWorkspaceSlugInput,
  type WorkspaceSlugRuleError,
} from '@/lib/workspace';
import { OnboardingShell, OnboardingBackButton, OnboardingNextButton } from '../onboarding-shell';
import { useOnboardingAnalytics } from '../onboarding-analytics';

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
  /** Existing workspace whose missing handle is being repaired in the form. */
  repairingWorkspaceName: string | null;
  /** Open the create form (does not commit yet). */
  onStartCreate: () => void;
  onStartRepair: (id: string) => void;
  /** Close the create form and return to the list. */
  onCancelCreate: () => void;

  /** Create-form state. Only meaningful while `creating === true`. */
  newName: string;
  newSlug: string;
  newSlugChecking: boolean;
  newSlugAvailable: boolean;
  /** True when the availability check is slow; validation remains pending. */
  newSlugCheckSlow: boolean;
  /** Underlying query failure detail; distinct from a merely slow check. */
  newSlugCheckError: string | null;
  newSlugError: SlugError | null;
  canResetSlug: boolean;
  onNewNameChange: (next: string) => void;
  onNewSlugChange: (next: string) => void;
  onResetNewSlug: () => void;
  onRetryNewSlugCheck: () => void;

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
  repairingWorkspaceName,
  onStartCreate,
  onStartRepair,
  onCancelCreate,
  newName,
  newSlug,
  newSlugChecking,
  newSlugAvailable,
  newSlugCheckSlow,
  newSlugCheckError,
  newSlugError,
  canResetSlug,
  onNewNameChange,
  onNewSlugChange,
  onResetNewSlug,
  onRetryNewSlugCheck,
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
  const repairingWorkspace = repairingWorkspaceName !== null;

  // Validation only matters while the create form is open.
  const newNameError =
    creating && !repairingWorkspace && newName.trim().length === 0
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
    newSlugAvailable &&
    newSlugCheckError === null &&
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
          ? repairingWorkspace
            ? t('onboarding.workspace.repairTitle', 'Set a workspace handle')
            : t('onboarding.workspace.createTitle', 'Create a workspace')
          : t('onboarding.workspace.title', 'Choose your workspace')
      }
      description={
        creating
          ? repairingWorkspace
            ? t(
                'onboarding.workspace.repairDescription',
                'Add the URL handle this workspace needs before continuing.'
              )
            : t(
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
              : repairingWorkspace
                ? t('onboarding.workspace.saveHandleAndContinue', 'Save & continue')
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
            {repairingWorkspace ? (
              <div className="space-y-2">
                <Label>{t('organization.workspaceName', 'Workspace name')}</Label>
                <div className="rounded-md border border-border bg-muted/30 px-3 py-2.5 text-sm font-medium">
                  {repairingWorkspaceName}
                </div>
              </div>
            ) : (
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
            )}

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
              ) : newSlugCheckError ? (
                <div
                  role="alert"
                  className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                >
                  <p>
                    {t('organization.workspaceSlugCheckFailed', 'Could not verify this handle.')}
                  </p>
                  <p className="break-words font-mono opacity-90">{newSlugCheckError}</p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-2"
                    onClick={onRetryNewSlugCheck}
                  >
                    <RotateCcw className="size-3.5" />
                    {t('common.retry', 'Retry')}
                  </Button>
                </div>
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
                  {newSlugCheckSlow ? (
                    <button
                      type="button"
                      className="shrink-0 font-medium text-foreground underline-offset-4 hover:underline"
                      onClick={onRetryNewSlugCheck}
                    >
                      {t('organization.workspaceSlugCheckAgain', 'Check again')}
                    </button>
                  ) : null}
                </p>
              ) : newSlugAvailable ? (
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
                  {repairingWorkspace
                    ? t(
                        'onboarding.workspace.repairFailed',
                        'Could not save the workspace handle. Try again.'
                      )
                    : t(
                        'onboarding.workspace.createFailed',
                        'Could not create workspace. Try again.'
                      )}
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
                        whileHover={writePending ? undefined : { y: -1 }}
                        whileTap={writePending ? undefined : { scale: 0.99 }}
                        disabled={writePending}
                        onClick={() =>
                          hasSlug ? onSelectWorkspace(workspace.id) : onStartRepair(workspace.id)
                        }
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
                                  'No handle yet — select this workspace to set one.'
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

// Existing names stay untouched here. A missing slug is repaired inline because
// workspace settings cannot be routed to until that slug exists.
/** Marks a slow slug check without treating an unanswered query as validation. */
const SLUG_CHECK_SLOW_MS = 8_000;
/** Bounds how long a workspace write may prevent Back/Cancel. */
const WORKSPACE_WRITE_STALE_MS = 15_000;
const pendingWorkspaceWrites = new WeakMap<object, Promise<unknown>>();

type SlugAvailabilityState =
  | { slug: string; status: 'checking' }
  | { slug: string; status: 'available' | 'unavailable' }
  | { slug: string; status: 'error'; message: string };

function trackWorkspaceWrite<T>(owner: object, write: Promise<T>): Promise<T> {
  pendingWorkspaceWrites.set(owner, write);
  const clear = () => {
    if (pendingWorkspaceWrites.get(owner) === write) pendingWorkspaceWrites.delete(owner);
  };
  void write.then(clear, clear);
  return write;
}

function releaseWorkspaceWrite(owner: object, write: Promise<unknown>): void {
  if (pendingWorkspaceWrites.get(owner) === write) pendingWorkspaceWrites.delete(owner);
}

function WorkspaceSlugAvailabilityProbe({
  slug,
  attempt,
  onResolved,
}: {
  slug: string;
  attempt: number;
  onResolved: (slug: string, available: boolean) => void;
}) {
  const analytics = useOnboardingAnalytics();
  const availability = useCloudQuery(cloudOperations.auth.isWorkspaceSlugAvailable, { slug });
  useEffect(() => {
    analytics.capture('onboarding/operation_started', {
      step: 'workspace',
      operation: 'slug_availability_check',
      attempt,
    });
  }, [analytics, attempt]);
  useEffect(() => {
    if (availability !== undefined) onResolved(slug, availability.available);
  }, [availability, onResolved, slug]);
  return null;
}

export function WorkspaceScreen({ onBack, onNext }: WorkspaceScreenProps) {
  const { t } = useTranslation();
  const analytics = useOnboardingAnalytics();
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
  const [repairingWorkspaceId, setRepairingWorkspaceId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [writePending, setWritePending] = useState(() =>
    pendingWorkspaceWrites.has(platform.workspaces)
  );
  const [createError, setCreateError] = useState<string | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(activeWorkspaceId);
  const [retryingWorkspaces, setRetryingWorkspaces] = useState(false);
  const [workspaceRetryError, setWorkspaceRetryError] = useState<string | null>(null);
  const repairingWorkspace =
    workspaces.find((workspace) => workspace.id === repairingWorkspaceId) ?? null;

  useEffect(() => {
    if (workspaceState.status === 'error') {
      console.error('[onboarding] Failed to load workspaces:', workspaceState.message);
      analytics.capture('onboarding/operation_failed', {
        step: 'workspace',
        operation: 'workspace_list',
        failure_code: 'workspace_list_failed',
        retryable: Boolean(platform.workspaces.retry),
      });
      return;
    }
    setWorkspaceRetryError(null);
  }, [analytics, platform.workspaces.retry, workspaceState]);

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
    analytics.capture('onboarding/operation_started', {
      step: 'workspace',
      operation: 'workspace_list_retry',
    });
    void retry()
      .then(() => {
        analytics.capture('onboarding/operation_succeeded', {
          step: 'workspace',
          operation: 'workspace_list_retry',
        });
      })
      .catch((error: unknown) => {
        console.error('[onboarding] Failed to retry workspace loading:', error);
        analytics.capture('onboarding/operation_failed', {
          step: 'workspace',
          operation: 'workspace_list_retry',
          failure_code: 'workspace_list_retry_failed',
          retryable: true,
        });
        setWorkspaceRetryError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setRetryingWorkspaces(false);
      });
  }, [analytics, platform.workspaces, retryingWorkspaces]);

  // A write can outlive this phase after Back. Re-entering the step must join
  // that write instead of issuing a competing setActive mutation.
  useEffect(() => {
    const pending = pendingWorkspaceWrites.get(platform.workspaces);
    if (!pending) return undefined;
    let mounted = true;
    setSaving(false);
    setWritePending(true);
    const settle = () => {
      clearTimeout(staleTimer);
      if (mounted) setWritePending(false);
    };
    const staleTimer = setTimeout(() => {
      if (!mounted) return;
      const error = new Error(
        'The previous workspace request is still pending. You can try again.'
      );
      console.error('[onboarding] Previous workspace request timed out:', error);
      releaseWorkspaceWrite(platform.workspaces, pending);
      setWritePending(false);
    }, WORKSPACE_WRITE_STALE_MS);
    void pending.then(settle, settle);
    return () => {
      mounted = false;
      clearTimeout(staleTimer);
    };
  }, [platform.workspaces]);

  // Only a READY empty list opens the create form; while the list is loading
  // or failed, the form must not pose as "you have no workspaces".
  const workspacesReadyEmpty =
    workspaceState.status === 'ready' && workspaceState.workspaces.length === 0;
  useEffect(() => {
    if (workspacesReadyEmpty) {
      setRepairingWorkspaceId(null);
      setCreating(true);
    }
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
  const [slugAvailability, setSlugAvailability] = useState<SlugAvailabilityState | null>(null);
  const [slugCheckAttempt, setSlugCheckAttempt] = useState(0);
  const matchingSlugAvailability = slugAvailability?.slug === newSlug ? slugAvailability : null;
  const newSlugChecking =
    canCheckAvailability &&
    (matchingSlugAvailability === null || matchingSlugAvailability.status === 'checking');
  const newSlugAvailable = matchingSlugAvailability?.status === 'available';
  const newSlugCheckError =
    matchingSlugAvailability?.status === 'error' ? matchingSlugAvailability.message : null;
  const handleSlugAvailabilityResolved = useCallback(
    (slug: string, available: boolean) => {
      setSlugAvailability({ slug, status: available ? 'available' : 'unavailable' });
      analytics.capture('onboarding/operation_succeeded', {
        step: 'workspace',
        operation: 'slug_availability_check',
        attempt: slugCheckAttempt + 1,
        available,
      });
    },
    [analytics, slugCheckAttempt]
  );
  const handleRetrySlugCheck = useCallback(() => {
    if (!canCheckAvailability) return;
    setSlugAvailability({ slug: newSlug, status: 'checking' });
    analytics.capture('onboarding/operation_succeeded', {
      step: 'workspace',
      operation: 'slug_availability_retry_request',
      attempt: slugCheckAttempt + 2,
    });
    setSlugCheckAttempt((attempt) => attempt + 1);
  }, [analytics, canCheckAvailability, newSlug, slugCheckAttempt]);
  const [newSlugCheckSlow, setNewSlugCheckSlow] = useState(false);
  useEffect(() => {
    if (!newSlugChecking) {
      setNewSlugCheckSlow(false);
      return undefined;
    }
    const timer = setTimeout(() => {
      setNewSlugCheckSlow(true);
      analytics.capture('onboarding/operation_failed', {
        step: 'workspace',
        operation: 'slug_availability_check',
        failure_code: 'slug_check_slow',
        attempt: slugCheckAttempt + 1,
        retryable: true,
      });
    }, SLUG_CHECK_SLOW_MS);
    return () => clearTimeout(timer);
  }, [analytics, newSlugChecking, slugCheckAttempt]);

  const newSlugError = useMemo<SlugError | null>(() => {
    if (!creating) return null;
    if (!newSlug) return 'required';
    const ruleError = getWorkspaceSlugRuleError(newSlug);
    if (ruleError) return ruleError;
    // Only a resolved answer can condemn a slug. A slow pending check is still
    // pending, never "taken" and never permission to bypass server validation.
    if (matchingSlugAvailability?.status === 'unavailable') {
      return 'unavailable';
    }
    return null;
  }, [creating, matchingSlugAvailability?.status, newSlug]);

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
    analytics.capture('onboarding/operation_started', {
      step: 'workspace',
      operation: 'workspace_switch',
      attempt,
    });
    const switchWrite = trackWorkspaceWrite(
      platform.workspaces,
      platform.workspaces.setActive(selectedWorkspaceId)
    );
    const staleTimer = setTimeout(() => {
      if (writeAttemptRef.current !== attempt) return;
      const error = new Error(
        t(
          'onboarding.workspace.timedOut',
          'The request is still pending. You can try again or go back.'
        )
      );
      console.error('[onboarding] Workspace switch timed out:', error);
      analytics.capture('onboarding/operation_failed', {
        step: 'workspace',
        operation: 'workspace_switch',
        failure_code: 'workspace_switch_timed_out',
        attempt,
        retryable: true,
      });
      writeAttemptRef.current += 1;
      releaseWorkspaceWrite(platform.workspaces, switchWrite);
      setSaving(false);
      setWritePending(false);
      toast.error(
        t('onboarding.workspace.switchFailed', 'Could not switch workspace. Try again.'),
        { description: error.message }
      );
    }, WORKSPACE_WRITE_STALE_MS);
    void switchWrite.then(
      () => {
        clearTimeout(staleTimer);
        if (writeAttemptRef.current !== attempt) return;
        setSaving(false);
        setWritePending(false);
        analytics.capture('onboarding/operation_succeeded', {
          step: 'workspace',
          operation: 'workspace_switch',
          attempt,
        });
        commitWorkspaceContext(target);
        onNext();
      },
      (error: unknown) => {
        clearTimeout(staleTimer);
        if (writeAttemptRef.current !== attempt) return;
        setSaving(false);
        setWritePending(false);
        console.error('[onboarding] Failed to switch workspace:', error);
        analytics.capture('onboarding/operation_failed', {
          step: 'workspace',
          operation: 'workspace_switch',
          failure_code: 'workspace_switch_failed',
          attempt,
          retryable: true,
        });
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
    analytics,
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
    if (
      writePending ||
      !trimmedName ||
      newSlugError !== null ||
      newSlugChecking ||
      !newSlugAvailable ||
      newSlugCheckError !== null
    ) {
      return;
    }
    setSaving(true);
    setWritePending(true);
    setCreateError(null);
    commitWorkspaceContext(null);
    const attempt = ++writeAttemptRef.current;
    const operation = repairingWorkspace ? 'workspace_slug_repair' : 'workspace_create';
    analytics.capture('onboarding/operation_started', {
      step: 'workspace',
      operation,
      attempt,
    });
    const createWrite = trackWorkspaceWrite(
      platform.workspaces,
      (async () => {
        if (repairingWorkspace) {
          if (!platform.workspaces.updateSlug) {
            throw new Error('Workspace handle updates are unavailable on this platform');
          }
          const updated = await platform.workspaces.updateSlug(repairingWorkspace.id, newSlug);
          if (writeAttemptRef.current !== attempt) return null;
          await platform.workspaces.setActive(updated.id);
          return updated;
        }
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
          'The request is still pending. You can try again or go back.'
        )
      );
      console.error(
        repairingWorkspace
          ? '[onboarding] Workspace handle update timed out:'
          : '[onboarding] Workspace creation timed out:',
        error
      );
      analytics.capture('onboarding/operation_failed', {
        step: 'workspace',
        operation,
        failure_code: repairingWorkspace
          ? 'workspace_slug_repair_timed_out'
          : 'workspace_create_timed_out',
        attempt,
        retryable: true,
      });
      writeAttemptRef.current += 1;
      releaseWorkspaceWrite(platform.workspaces, createWrite);
      setSaving(false);
      setWritePending(false);
      setCreateError(error.message);
    }, WORKSPACE_WRITE_STALE_MS);
    void createWrite.then(
      (created) => {
        clearTimeout(staleTimer);
        if (!created || writeAttemptRef.current !== attempt) return;
        setSaving(false);
        setWritePending(false);
        analytics.capture('onboarding/operation_succeeded', {
          step: 'workspace',
          operation,
          attempt,
        });
        commitWorkspaceContext({
          id: created.id,
          name: created.name,
          slug: created.slug ?? newSlug,
        });
        onNext();
      },
      (error: unknown) => {
        clearTimeout(staleTimer);
        if (writeAttemptRef.current !== attempt) return;
        setSaving(false);
        setWritePending(false);
        console.error(
          repairingWorkspace
            ? '[onboarding] Failed to save workspace handle:'
            : '[onboarding] Failed to create workspace:',
          error
        );
        analytics.capture('onboarding/operation_failed', {
          step: 'workspace',
          operation,
          failure_code: repairingWorkspace
            ? 'workspace_slug_repair_failed'
            : 'workspace_create_failed',
          attempt,
          retryable: true,
        });
        commitWorkspaceContext(activeWorkspace);
        // The error stays inline in the form: a toast disappears and leaves a
        // user with no workspaces without any visible way forward.
        setCreateError(error instanceof Error ? error.message : String(error));
      }
    );
  }, [
    activeWorkspace,
    analytics,
    commitWorkspaceContext,
    newName,
    newSlug,
    newSlugAvailable,
    newSlugCheckError,
    newSlugChecking,
    newSlugError,
    onNext,
    platform.workspaces,
    repairingWorkspace,
    t,
    writePending,
  ]);

  return (
    <>
      {canCheckAvailability ? (
        <ErrorBoundary
          name="OnboardingWorkspaceSlugCheck"
          fallbackRender={() => null}
          resetKeys={[newSlug, slugCheckAttempt]}
          propagateAuthErrors={false}
          onError={(error) => {
            console.error('[onboarding] Failed to verify workspace handle:', error);
            analytics.capture('onboarding/operation_failed', {
              step: 'workspace',
              operation: 'slug_availability_check',
              failure_code: 'slug_check_failed',
              attempt: slugCheckAttempt + 1,
              retryable: true,
            });
            setSlugAvailability({ slug: newSlug, status: 'error', message: error.message });
          }}
        >
          <WorkspaceSlugAvailabilityProbe
            key={`${newSlug}:${slugCheckAttempt}`}
            slug={newSlug}
            attempt={slugCheckAttempt + 1}
            onResolved={handleSlugAvailabilityResolved}
          />
        </ErrorBoundary>
      ) : null}
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
        repairingWorkspaceName={repairingWorkspace?.name ?? null}
        onStartCreate={() => {
          setRepairingWorkspaceId(null);
          setCreating(true);
          setNewName('');
          setSlugDraft(null);
          setSlugAvailability(null);
          setCreateError(null);
        }}
        onStartRepair={(workspaceId) => {
          const target = workspaces.find((workspace) => workspace.id === workspaceId);
          if (!target) return;
          setRepairingWorkspaceId(target.id);
          setCreating(true);
          setNewName(target.name);
          setSlugDraft(null);
          setSlugAvailability(null);
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
          setRepairingWorkspaceId(null);
          setCreating(false);
        }}
        newName={newName}
        newSlug={newSlug}
        newSlugChecking={newSlugChecking}
        newSlugAvailable={newSlugAvailable}
        newSlugCheckSlow={newSlugCheckSlow}
        newSlugCheckError={newSlugCheckError}
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
        onRetryNewSlugCheck={handleRetrySlugCheck}
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
    </>
  );
}
