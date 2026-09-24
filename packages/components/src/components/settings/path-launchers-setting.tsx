import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { usePostHog } from '@posthog/react';
import { Check, Pencil, Plus, Trash2 } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Field as UiField } from '@lody/ui/field';
import { Dialog } from '@/ui/dialog';
import { Select } from '@lody/ui/select';
import { getPathLauncherIcon } from '@/components/icons/path-launcher-icon';
import { capturePostHogEvent } from '@/lib/posthog-analytics';
import { useIsMobile } from '@/hooks/use-mobile';
import { Drawer } from '@lody/ui/drawer';
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

const MONO = 'var(--font-mono, ui-monospace, monospace)';

/** A command is typed in the face it runs in; the input owns every other declaration. */
const COMMAND_INPUT_STYLE = { fontFamily: MONO } as const;

const styles = stylex.create({
  /** A row's own action: hidden until the row is under the pointer or the keyboard. */
  rowReveal: {
    display: 'inline-flex',
    opacity: {
      default: 0,
      [stylex.when.ancestor(':hover')]: 1,
      [stylex.when.ancestor(':focus')]: 1,
    },
    pointerEvents: {
      default: 'none',
      [stylex.when.ancestor(':hover')]: 'auto',
      [stylex.when.ancestor(':focus')]: 'auto',
    },
  },
  /** A select takes a fixed column on a wide panel and the row on a narrow one. */
  select: { width: { default: '100%', '@media (min-width: 640px)': '220px' } },
  option: { display: 'flex', minWidth: 0, alignItems: 'center', gap: space[2] },
  optionIcon: { width: '16px', height: '16px', flexShrink: 0 },
  optionIconMuted: { color: colors.secondaryLabel },
  optionLabel: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  addCustom: { color: colors.secondaryLabel },
  glyph: { width: '100%', height: '100%' },
  form: { display: 'flex', flexDirection: 'column', gap: space[4] },
  field: { display: 'flex', flexDirection: 'column', gap: space[1.5] },
  preview: {
    margin: 0,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily: MONO,
    fontSize: text.captionSize,
    color: colors.secondaryLabel,
  },
  previewLabel: { color: colors.tertiaryLabel },
  error: { margin: 0, fontSize: text.footnoteSize, color: colors.destructive },
  /**
   * The footer's one row: delete at the start, the answers at the end, on every
   * width — the panel's own footer stacks its answers on a narrow one.
   */
  footerRow: {
    display: 'flex',
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
  },
  answers: { display: 'flex', alignItems: 'center', gap: space[2], marginInlineStart: 'auto' },
  icon: { width: '14px', height: '14px', flexShrink: 0 },
});

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
      <CompactSection>
        <CompactRow
          label={t('settings.pathLaunchers.title', 'Path launchers')}
          helper={t(
            'settings.pathLaunchers.description',
            'Pick the app the Open button uses in session headers.'
          )}
        >
          <Select.Root
            open={selectOpen}
            onOpenChange={setSelectOpen}
            value={selectedLauncherId}
            onValueChange={(value) => {
              if (value != null) handleSelectDefault(value);
            }}
          >
            <div {...stylex.props(styles.select)}>
              <Select.Trigger
                aria-label={t('settings.pathLaunchers.default.label', 'Default launcher')}
              >
                <Select.Value>
                  <LauncherOptionContent launcher={selectedLauncher} />
                </Select.Value>
              </Select.Trigger>
            </div>
            <Select.Content>
              {pathLauncherOptions.map((launcher) => {
                const launcherId = getPathLauncherId(launcher);
                const customLauncherId = launcher.kind === 'custom' ? launcher.id : null;
                return (
                  <Select.Item
                    key={launcherId}
                    value={launcherId}
                    // A marker, not a look: it lets the edit action show while this
                    // row is under the pointer or the keyboard.
                    className={stylex.props(stylex.defaultMarker()).className}
                    endContent={
                      customLauncherId ? (
                        <span {...stylex.props(styles.rowReveal)}>
                          <Button
                            type="button"
                            variant="ghost"
                            tabIndex={-1}
                            size="mini"
                            icon
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
                            <Pencil {...stylex.props(styles.glyph)} />
                          </Button>
                        </span>
                      ) : null
                    }
                  >
                    <LauncherOptionContent launcher={launcher} />
                  </Select.Item>
                );
              })}
              {isElectron ? (
                <>
                  <Select.Separator />
                  <Select.Item value={ADD_CUSTOM_LAUNCHER_VALUE}>
                    <span {...stylex.props(styles.option, styles.addCustom)}>
                      <Plus {...stylex.props(styles.optionIcon)} />
                      <span>{t('settings.pathLaunchers.addCustom', 'Custom launcher')}</span>
                    </span>
                  </Select.Item>
                </>
              ) : null}
            </Select.Content>
          </Select.Root>
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
    <span {...stylex.props(styles.option)}>
      {/* The launcher glyphs take a class only: some are an <img>. */}
      <Icon
        className={
          stylex.props(styles.optionIcon, launcher.kind === 'custom' && styles.optionIconMuted)
            .className
        }
      />
      <span {...stylex.props(styles.optionLabel)}>{launcher.label}</span>
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
  const FormHeader = isMobile ? Drawer.Header : Dialog.Header;
  const FormTitle = isMobile ? Drawer.Title : Dialog.Title;
  const FormDescription = isMobile ? Drawer.Description : Dialog.Description;
  const FormFooter = isMobile ? Drawer.Footer : Dialog.Footer;

  const handleOpenChange = (open: boolean) => {
    if (!open) onClose();
  };

  const form = draft ? (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave) onSave();
      }}
      {...stylex.props(styles.form)}
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

      <div {...stylex.props(styles.field)}>
        <UiField.Label htmlFor="path-launcher-name">
          {t('settings.pathLaunchers.nameLabel', 'Name')}
        </UiField.Label>
        <Input
          id="path-launcher-name"
          value={draft.label}
          autoFocus
          onChange={(event) => onChange({ ...draft, label: event.target.value })}
          placeholder={t('settings.pathLaunchers.namePlaceholder', 'Launcher name')}
        />
      </div>

      <div {...stylex.props(styles.field)}>
        <UiField.Label htmlFor="path-launcher-command">
          {t('settings.pathLaunchers.commandLabel', 'Command')}
        </UiField.Label>
        <Input
          id="path-launcher-command"
          style={COMMAND_INPUT_STYLE}
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
            <p {...stylex.props(styles.preview)}>
              <span {...stylex.props(styles.previewLabel)}>
                {t('settings.pathLaunchers.previewLabel', 'Runs')}:{' '}
              </span>
              {previewCommand}
            </p>
          )
        ) : (
          <p {...stylex.props(styles.error)}>{getTemplateValidationMessage(validation, t)}</p>
        )}
      </div>

      <FormFooter>
        <div {...stylex.props(styles.footerRow)}>
          {onDelete ? (
            <Button
              type="button"
              variant="secondary"
              tone="destructive"
              icon
              aria-label={t('common.delete')}
              title={t('common.delete')}
              onClick={onDelete}
            >
              <Trash2 {...stylex.props(styles.glyph)} />
            </Button>
          ) : null}
          <div {...stylex.props(styles.answers)}>
            <Button type="button" variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!canSave}>
              <Check {...stylex.props(styles.icon)} />
              {t('common.save')}
            </Button>
          </div>
        </div>
      </FormFooter>
    </form>
  ) : null;

  if (isMobile) {
    return (
      <Drawer.Root side="bottom" open={draft !== null} onOpenChange={handleOpenChange}>
        <Drawer.Content side="bottom">{form}</Drawer.Content>
      </Drawer.Root>
    );
  }

  return (
    <Dialog.Root open={draft !== null} onOpenChange={handleOpenChange}>
      <Dialog.Content>{form}</Dialog.Content>
    </Dialog.Root>
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
