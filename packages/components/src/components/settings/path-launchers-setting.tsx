import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { usePostHog } from '@posthog/react';
import { Check, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';
import { getPathLauncherIcon } from '@/components/icons/path-launcher-icon';
import { capturePostHogEvent } from '@/lib/posthog-analytics';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/ui/sheet';
import {
  createCustomPathLauncherId,
  DEFAULT_PATH_LAUNCHER_PREFERENCE,
  getAvailablePathLauncherOptions,
  getCustomPathLauncherOptionId,
  getPathLauncherId,
  PATH_LAUNCHER_PATH_PLACEHOLDER,
  readStoredPathLauncherPreference,
  resolveSelectedPathLauncher,
  validateCustomPathLauncherCommandTemplate,
  writeStoredPathLauncherPreference,
  type CustomPathLauncher,
  type CustomPathLauncherTemplateValidation,
  type PathLauncherOption,
  type PathLauncherPreference,
} from '@/lib/session-path-launchers';
import { CompactRow, CompactSection } from './compact-layout';

type PathLauncherDraft =
  | {
      mode: 'create';
      label: string;
      commandTemplate: string;
    }
  | {
      mode: 'edit';
      id: string;
      label: string;
      commandTemplate: string;
    };

const PREVIEW_SAMPLE_PATH = '~/code/my-project';
const ADD_CUSTOM_LAUNCHER_VALUE = '__add_custom_launcher__';

export function PathLaunchersSettings({
  isElectron,
  platform,
}: {
  isElectron: boolean;
  platform?: string | null;
}) {
  const { t } = useTranslation();
  const postHog = usePostHog();
  const [preference, setPreference] = useState<PathLauncherPreference>(
    readStoredPathLauncherPreference
  );
  const [selectOpen, setSelectOpen] = useState(false);
  const [draft, setDraft] = useState<PathLauncherDraft | null>(null);

  const pathLauncherOptions = useMemo(
    () =>
      getAvailablePathLauncherOptions({
        customLaunchers: preference.customLaunchers,
        isElectron,
        platform,
      }),
    [isElectron, platform, preference.customLaunchers]
  );
  const selectedLauncher = useMemo(
    () => resolveSelectedPathLauncher(preference.selectedLauncherId, pathLauncherOptions),
    [pathLauncherOptions, preference.selectedLauncherId]
  );
  const selectedLauncherId = getPathLauncherId(selectedLauncher);

  const templateValidation = useMemo(
    () =>
      draft
        ? validateCustomPathLauncherCommandTemplate(draft.commandTemplate)
        : ({ ok: true } as const),
    [draft]
  );
  const canSaveDraft =
    draft !== null && draft.label.trim().length > 0 && templateValidation.ok === true;

  const persistPreference = (nextPreference: PathLauncherPreference) => {
    setPreference(nextPreference);
    writeStoredPathLauncherPreference(nextPreference);
  };

  const handleSelectDefault = (launcherId: string) => {
    if (launcherId === ADD_CUSTOM_LAUNCHER_VALUE) {
      setDraft({ mode: 'create', label: '', commandTemplate: '' });
      return;
    }
    if (launcherId !== selectedLauncherId) {
      persistPreference({ ...preference, selectedLauncherId: launcherId });
    }
  };

  const handleEditCustomLauncher = (launcherId: string) => {
    const launcher = preference.customLaunchers.find((item) => item.id === launcherId);
    if (!launcher) return;
    setSelectOpen(false);
    setDraft({ mode: 'edit', ...launcher });
  };

  const handleSaveDraft = () => {
    if (!draft || !canSaveDraft) return;

    const nextLauncher: CustomPathLauncher = {
      id: draft.mode === 'edit' ? draft.id : createCustomPathLauncherId(),
      label: draft.label.trim(),
      commandTemplate: draft.commandTemplate.trim(),
    };

    const nextCustomLaunchers =
      draft.mode === 'edit'
        ? preference.customLaunchers.map((launcher) =>
            launcher.id === draft.id ? nextLauncher : launcher
          )
        : [...preference.customLaunchers, nextLauncher];

    persistPreference({
      selectedLauncherId:
        draft.mode === 'create'
          ? getCustomPathLauncherOptionId(nextLauncher.id)
          : preference.selectedLauncherId,
      customLaunchers: nextCustomLaunchers,
    });

    if (draft.mode === 'create') {
      // settings/path_launcher_created: user added a custom path launcher.
      // We intentionally avoid sending the label/command (may contain personal
      // paths) and only report the kind + resulting count.
      capturePostHogEvent(postHog, 'settings/path_launcher_created', {
        launcher_kind: 'custom',
        custom_launcher_count: nextCustomLaunchers.length,
      });
    }

    setDraft(null);
  };

  const handleDeleteCustomLauncher = (launcherId: string) => {
    const deletedOptionId = getCustomPathLauncherOptionId(launcherId);
    persistPreference({
      selectedLauncherId:
        preference.selectedLauncherId === deletedOptionId
          ? DEFAULT_PATH_LAUNCHER_PREFERENCE.selectedLauncherId
          : preference.selectedLauncherId,
      customLaunchers: preference.customLaunchers.filter((launcher) => launcher.id !== launcherId),
    });
    if (draft?.mode === 'edit' && draft.id === launcherId) {
      setDraft(null);
    }
  };

  return (
    <>
      <CompactSection className="overflow-hidden">
        <CompactRow
          label={t('settings.pathLaunchers.title', 'Path launchers')}
          helper={t(
            'settings.pathLaunchers.description',
            'Pick the app the Open button uses in session headers.'
          )}
        >
          <Select
            open={selectOpen}
            onOpenChange={setSelectOpen}
            value={selectedLauncherId}
            onValueChange={handleSelectDefault}
          >
            <SelectTrigger
              aria-label={t('settings.pathLaunchers.default.label', 'Default launcher')}
              className="w-full sm:w-[220px]"
            >
              <SelectValue>
                <LauncherOptionContent launcher={selectedLauncher} />
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {pathLauncherOptions.map((launcher) => {
                const launcherId = getPathLauncherId(launcher);
                const customLauncherId = launcher.kind === 'custom' ? launcher.id : null;
                return (
                  <SelectItem
                    key={launcherId}
                    value={launcherId}
                    className={cn(customLauncherId && 'group/path-launcher pr-14')}
                  >
                    <LauncherOptionContent launcher={launcher} />
                    {customLauncherId ? (
                      <Button
                        type="button"
                        variant="ghost"
                        tabIndex={-1}
                        size="mini"
                        icon
                        className="pointer-events-none absolute right-7 top-1/2 -translate-y-1/2 opacity-0 group-hover/path-launcher:pointer-events-auto group-hover/path-launcher:opacity-100 group-focus/path-launcher:pointer-events-auto group-focus/path-launcher:opacity-100"
                        aria-label={t('settings.pathLaunchers.editAction', 'Edit')}
                        title={t('settings.pathLaunchers.editAction', 'Edit')}
                        onPointerDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                        onPointerUp={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          handleEditCustomLauncher(customLauncherId);
                        }}
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                    ) : null}
                  </SelectItem>
                );
              })}
              {isElectron ? (
                <>
                  <SelectSeparator />
                  <SelectItem value={ADD_CUSTOM_LAUNCHER_VALUE}>
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <Plus className="size-4 shrink-0" />
                      <span>{t('settings.pathLaunchers.addCustom', 'Custom launcher')}</span>
                    </span>
                  </SelectItem>
                </>
              ) : null}
            </SelectContent>
          </Select>
        </CompactRow>
      </CompactSection>

      <LauncherFormDialog
        draft={draft}
        onChange={setDraft}
        onClose={() => setDraft(null)}
        onSave={handleSaveDraft}
        onDelete={draft?.mode === 'edit' ? () => handleDeleteCustomLauncher(draft.id) : undefined}
        canSave={canSaveDraft}
        validation={templateValidation}
      />
    </>
  );
}

function LauncherOptionContent({ launcher }: { launcher: PathLauncherOption }) {
  const Icon = getPathLauncherIcon(launcher);

  return (
    <span className="flex min-w-0 items-center gap-2">
      <Icon
        className={cn('size-4 shrink-0', launcher.kind === 'custom' && 'text-muted-foreground')}
      />
      <span className="truncate">{launcher.label}</span>
    </span>
  );
}

function LauncherFormDialog({
  draft,
  onChange,
  onClose,
  onSave,
  onDelete,
  canSave,
  validation,
}: {
  draft: PathLauncherDraft | null;
  onChange: (draft: PathLauncherDraft) => void;
  onClose: () => void;
  onSave: () => void;
  onDelete?: () => void;
  canSave: boolean;
  validation: CustomPathLauncherTemplateValidation;
}) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const command = draft?.commandTemplate ?? '';
  const previewCommand = command.trim()
    ? command.replaceAll(PATH_LAUNCHER_PATH_PLACEHOLDER, PREVIEW_SAMPLE_PATH)
    : '';
  const showPreview = validation.ok === true && previewCommand.length > 0;
  const FormHeader = isMobile ? SheetHeader : DialogHeader;
  const FormTitle = isMobile ? SheetTitle : DialogTitle;
  const FormDescription = isMobile ? SheetDescription : DialogDescription;
  const FormFooter = isMobile ? SheetFooter : DialogFooter;

  const handleOpenChange = (open: boolean) => {
    if (!open) onClose();
  };

  const form = draft ? (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave) onSave();
      }}
      className="flex flex-col gap-4"
    >
      <FormHeader>
        <FormTitle>
          {draft.mode === 'edit'
            ? t('settings.pathLaunchers.editTitle', 'Edit launcher')
            : t('settings.pathLaunchers.addTitle', 'Add custom launcher')}
        </FormTitle>
        <FormDescription>
          {t(
            'settings.pathLaunchers.templateHelper',
            'Use {path} where the session worktree or project path should be inserted.'
          )}
        </FormDescription>
      </FormHeader>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="path-launcher-name">{t('settings.pathLaunchers.nameLabel', 'Name')}</Label>
        <Input
          id="path-launcher-name"
          value={draft.label}
          autoFocus
          onChange={(event) => onChange({ ...draft, label: event.target.value })}
          placeholder={t('settings.pathLaunchers.namePlaceholder', 'Launcher name')}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="path-launcher-command">
          {t('settings.pathLaunchers.commandLabel', 'Command')}
        </Label>
        <Input
          id="path-launcher-command"
          className="font-mono text-sm"
          value={draft.commandTemplate}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(event) => onChange({ ...draft, commandTemplate: event.target.value })}
          placeholder={t(
            'settings.pathLaunchers.commandPlaceholder',
            'code-insiders --reuse-window {path}'
          )}
        />
        {validation.ok ? (
          showPreview && (
            <p className="truncate font-mono text-[11px] text-muted-foreground">
              <span className="text-muted-foreground/70">
                {t('settings.pathLaunchers.previewLabel', 'Runs')}:{' '}
              </span>
              {previewCommand}
            </p>
          )
        ) : (
          <p className="text-xs text-destructive">{getTemplateValidationMessage(validation, t)}</p>
        )}
      </div>

      <FormFooter className="flex-row items-center justify-between gap-2 sm:justify-between">
        {onDelete ? (
          <Button
            type="button"
            variant="destructive"
            size="large"
            icon
            className="shrink-0"
            aria-label={t('common.delete')}
            title={t('common.delete')}
            onClick={onDelete}
          >
            <Trash2 className="size-4" />
          </Button>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={!canSave}>
            <Check className="size-3.5" />
            {t('common.save')}
          </Button>
        </div>
      </FormFooter>
    </form>
  ) : null;

  if (isMobile) {
    return (
      <Sheet open={draft !== null} onOpenChange={handleOpenChange}>
        <SheetContent
          side="bottom"
          className="max-h-[calc(100dvh-1rem)] overflow-y-auto rounded-t-2xl pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))]"
        >
          {form}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={draft !== null} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">{form}</DialogContent>
    </Dialog>
  );
}

function getTemplateValidationMessage(
  validation: Exclude<CustomPathLauncherTemplateValidation, { ok: true }>,
  t: TFunction<'translation', undefined>
): string {
  switch (validation.reason) {
    case 'empty':
      return t('settings.pathLaunchers.templateErrors.empty', 'Enter a command template.');
    case 'missing_path':
      return t(
        'settings.pathLaunchers.templateErrors.missingPath',
        'Command template must include {path}.'
      );
    case 'invalid_syntax':
      return t(
        'settings.pathLaunchers.templateErrors.invalidSyntax',
        'Command template has invalid quoting.'
      );
    case 'path_in_command':
      return t(
        'settings.pathLaunchers.templateErrors.pathInCommand',
        '{path} must be an argument, not the executable.'
      );
    default: {
      // Exhaustiveness guard: every reason is handled above, so this is `never`.
      // Keeps consistent-return happy without losing compile-time coverage.
      const exhaustiveReason: never = validation.reason;
      return exhaustiveReason;
    }
  }
}
