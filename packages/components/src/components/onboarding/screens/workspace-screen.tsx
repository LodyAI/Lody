import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSetAtom } from 'jotai';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowRight, Building2, Check, Loader2, Plus } from 'lucide-react';
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
  newSlugError: SlugError | null;
  canResetSlug: boolean;
  onNewNameChange: (next: string) => void;
  onNewSlugChange: (next: string) => void;
  onResetNewSlug: () => void;

  /** True while we're awaiting setActive / create. */
  saving: boolean;

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
  selectedWorkspaceId,
  creating,
  onStartCreate,
  onCancelCreate,
  newName,
  newSlug,
  newSlugChecking,
  newSlugError,
  canResetSlug,
  onNewNameChange,
  onNewSlugChange,
  onResetNewSlug,
  saving,
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
    !saving &&
    !newSlugChecking &&
    newNameError === null &&
    newSlugError === null &&
    newSlug.length > 0;
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
        workspaceStatus: saving
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
            {t('onboarding.workspace.createAndContinue', 'Create & continue')}
            {!saving ? <ArrowRight className="h-4 w-4" /> : null}
          </Button>
        ) : hasWorkspaces ? (
          <OnboardingNextButton
            onClick={onConfirmSelection}
            disabled={selectedWorkspaceId === null || saving}
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
                disabled={saving}
                className={newNameError ? 'border-destructive' : ''}
              />
              {newNameError ? <p className="text-xs text-destructive">{newNameError}</p> : null}
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="onboarding-workspace-slug">
                  {t('organization.workspaceSlug', 'Handle')}
                </Label>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  {canResetSlug ? (
                    <button
                      type="button"
                      className="hover:text-foreground"
                      onClick={onResetNewSlug}
                      disabled={saving}
                    >
                      {t('organization.workspaceSlugReset', 'Reset')}
                    </button>
                  ) : null}
                  {newSlugChecking ? (
                    <span className="inline-flex items-center gap-1">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {t('organization.workspaceSlugChecking', 'Checking…')}
                    </span>
                  ) : !newSlugError && newSlug.length > 0 ? (
                    <span className="text-primary">
                      {t('organization.workspaceSlugAvailable', 'Available')}
                    </span>
                  ) : null}
                </div>
              </div>
              <Input
                id="onboarding-workspace-slug"
                value={newSlug}
                onChange={(event) => onNewSlugChange(event.target.value)}
                placeholder={t('organization.workspaceSlugPlaceholder', 'my-workspace')}
                disabled={saving}
                className={newSlugError ? 'border-destructive' : ''}
              />
              {slugErrorText ? <p className="text-xs text-destructive">{slugErrorText}</p> : null}
              <p className="text-xs text-muted-foreground/80">
                {t(
                  'onboarding.workspace.slugHint',
                  'Used in URLs. Lowercase letters, numbers, and dashes.'
                )}
              </p>
            </div>
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
            {hasWorkspaces ? (
              // ~6 rows visible (each row ≈ 64px incl. gap); longer lists scroll
              // inside the card with the transparent-track style.
              <div className="scrollbar-pro -mx-1 max-h-[420px] overflow-y-auto overscroll-contain px-1 py-2">
                <div className="flex flex-col gap-2">
                  {workspaces.map((workspace) => {
                    const isSelected = workspace.id === selectedWorkspaceId;
                    return (
                      <motion.button
                        key={workspace.id}
                        type="button"
                        whileHover={saving ? undefined : { y: -1 }}
                        whileTap={saving ? undefined : { scale: 0.99 }}
                        disabled={saving}
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
                            /{workspace.slug}
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

            <button
              type="button"
              disabled={saving}
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

  const [creating, setCreating] = useState(workspaces.length === 0);
  const [saving, setSaving] = useState(false);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(activeWorkspaceId);

  // Default-select the active workspace once it loads, so the user can
  // immediately confirm and proceed without an extra click.
  useEffect(() => {
    if (selectedWorkspaceId === null && activeWorkspaceId !== null) {
      setSelectedWorkspaceId(activeWorkspaceId);
    }
  }, [activeWorkspaceId, selectedWorkspaceId]);

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
  const newSlugIsAvailable = canCheckAvailability && Boolean(availability?.available);

  const newSlugError = useMemo<SlugError | null>(() => {
    if (!creating) return null;
    if (!newSlug) return 'required';
    const ruleError = getWorkspaceSlugRuleError(newSlug);
    if (ruleError) return ruleError;
    if (shouldCheckAvailability && !newSlugChecking && !newSlugIsAvailable) {
      return 'unavailable';
    }
    return null;
  }, [creating, newSlug, shouldCheckAvailability, newSlugChecking, newSlugIsAvailable]);

  const handleConfirmSelection = useCallback(() => {
    if (selectedWorkspaceId === null) return;
    const target = workspaces.find((workspace) => workspace.id === selectedWorkspaceId);
    if (!target?.slug) return;
    if (selectedWorkspaceId === activeWorkspaceId) {
      commitWorkspaceContext(target);
      onNext();
      return;
    }
    setSaving(true);
    commitWorkspaceContext(null);
    void (async () => {
      try {
        await platform.workspaces.setActive(selectedWorkspaceId);
        commitWorkspaceContext(target);
        onNext();
      } catch (error) {
        commitWorkspaceContext(activeWorkspace);
        toast.error(
          t('onboarding.workspace.switchFailed', 'Could not switch workspace. Try again.'),
          { description: error instanceof Error ? error.message : undefined }
        );
      } finally {
        setSaving(false);
      }
    })();
  }, [
    activeWorkspace,
    activeWorkspaceId,
    commitWorkspaceContext,
    onNext,
    platform.workspaces,
    selectedWorkspaceId,
    t,
    workspaces,
  ]);

  const handleSubmitCreate = useCallback(() => {
    const trimmedName = newName.trim();
    if (!trimmedName || newSlugError !== null || newSlugChecking) return;
    setSaving(true);
    commitWorkspaceContext(null);
    void (async () => {
      try {
        if (!platform.workspaces.create) {
          throw new Error('Workspace creation is unavailable on this platform');
        }
        const created = await platform.workspaces.create({ name: trimmedName, slug: newSlug });
        await platform.workspaces.setActive(created.id);
        commitWorkspaceContext({
          id: created.id,
          name: created.name,
          slug: created.slug ?? newSlug,
        });
        onNext();
      } catch (error) {
        commitWorkspaceContext(activeWorkspace);
        toast.error(
          t('onboarding.workspace.createFailed', 'Could not create workspace. Try again.'),
          { description: error instanceof Error ? error.message : undefined }
        );
      } finally {
        setSaving(false);
      }
    })();
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
  ]);

  return (
    <WorkspaceScreenView
      workspaces={workspaces}
      selectedWorkspaceId={selectedWorkspaceId}
      creating={creating}
      onStartCreate={() => {
        setCreating(true);
        setNewName('');
        setSlugDraft(null);
      }}
      onCancelCreate={() => {
        if (workspaces.length === 0) return; // No list to fall back to.
        setCreating(false);
      }}
      newName={newName}
      newSlug={newSlug}
      newSlugChecking={newSlugChecking}
      newSlugError={newSlugError}
      canResetSlug={slugDraft !== null && slugDraft !== suggestedSlug}
      onNewNameChange={setNewName}
      onNewSlugChange={(next) => setSlugDraft(normalizeWorkspaceSlugInput(next))}
      onResetNewSlug={() => setSlugDraft(null)}
      saving={saving}
      onSelectWorkspace={setSelectedWorkspaceId}
      onConfirmSelection={handleConfirmSelection}
      onSubmitCreate={handleSubmitCreate}
      onBack={onBack}
    />
  );
}
