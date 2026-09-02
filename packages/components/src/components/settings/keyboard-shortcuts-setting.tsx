import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import {
  globalShortcutBindingHasModifier,
  type GlobalShortcutId,
  type GlobalShortcutSetError,
} from '@lody/shared';
import { Button } from '@lody/ui/button';
import { cn } from '@/lib/utils';
import {
  canonicalizeBinding,
  commands,
  useCommands,
  useKeyCapture,
  formatKeyBinding,
  getRuntime,
  GLOBAL_SHORTCUTS,
  type Command,
  type CommandCategory,
} from '@/lib/commands';
import type { GlobalShortcutBinding } from '@lody/shared';
import { useGlobalShortcuts } from '@/hooks/use-global-shortcuts';
import { Kbd } from '@/components/commands/kbd';
import { CompactRow, CompactSection } from './compact-layout';
import { settingContainerClass } from '.';

const CATEGORY_ORDER: CommandCategory[] = [
  'Navigation',
  'Session',
  'Editor',
  'View',
  'Workspace',
  'Help',
  'Other',
];

// Fixed widths so the shortcut and trash columns line up across rows. The shortcut slot
// holds up to ~4 chips comfortably; the trash slot stays present even when the row has
// nothing to delete so the column doesn't shift when neighbors do.
const SHORTCUT_SLOT_CLASS = 'flex w-36 justify-end';
const TRASH_SLOT_CLASS = 'flex w-9 justify-center';

export function KeyboardShortcutsSetting() {
  const { t } = useTranslation();
  const all = useCommands();

  const grouped = useMemo(() => {
    const groups = new Map<CommandCategory, Command[]>();
    for (const cmd of all) {
      if (cmd.hidden) continue;
      const cat = cmd.category ?? 'Other';
      const list = groups.get(cat);
      if (list) list.push(cmd);
      else groups.set(cat, [cmd]);
    }
    return [...groups.entries()].sort(
      ([a], [b]) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b)
    );
  }, [all]);

  const anyOverridden = useMemo(() => all.some((cmd) => commands.hasUserOverride(cmd.id)), [all]);

  // Global (OS-level) shortcuts are registered in the Electron main process and only
  // exist on the desktop app — hide the section entirely on web/mobile.
  const showGlobalShortcuts = getRuntime() === 'electron' && GLOBAL_SHORTCUTS.length > 0;
  const { shortcuts: globalBindings, setBinding: setGlobalBinding } = useGlobalShortcuts();

  const handleResetAll = useCallback(() => {
    commands.resetAllUserKeybindings();
  }, []);

  // A combo that matches an OS global shortcut can't be bound to an in-app command —
  // surface which global shortcut occupies it so recording rejects it instead of saving.
  const findGlobalConflictTitle = useCallback(
    (binding: string): string | null => {
      const canonical = canonicalizeBinding(binding);
      if (!canonical) return null;
      const hit = globalBindings.find(
        (entry: GlobalShortcutBinding) =>
          entry.binding !== null && canonicalizeBinding(entry.binding) === canonical
      );
      if (!hit) return null;
      const mirror = GLOBAL_SHORTCUTS.find((shortcut) => shortcut.id === hit.id);
      return mirror ? t(mirror.titleKey, { defaultValue: mirror.defaultTitle }) : hit.id;
    },
    [globalBindings, t]
  );

  return (
    <div className={settingContainerClass}>
      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-muted-foreground">
          {t('settings.keyboardShortcuts.description')}
        </p>
        <Button variant="secondary" size="small" disabled={!anyOverridden} onClick={handleResetAll}>
          {t('settings.keyboardShortcuts.resetAll')}
        </Button>
      </div>

      {grouped.length === 0 && (
        <div className="rounded-md border border-dashed border-border/70 p-6 text-center text-xs text-muted-foreground">
          {t('settings.keyboardShortcuts.empty')}
        </div>
      )}

      {grouped.map(([category, items]) => (
        <CompactSection
          key={category}
          title={t(`settings.keyboardShortcuts.category.${category}`, { defaultValue: category })}
        >
          {items.map((cmd) => (
            <ShortcutRow
              key={cmd.id}
              command={cmd}
              findGlobalConflictTitle={findGlobalConflictTitle}
            />
          ))}
        </CompactSection>
      ))}

      {showGlobalShortcuts && (
        <CompactSection title={t('settings.keyboardShortcuts.globalSection')}>
          {GLOBAL_SHORTCUTS.map((shortcut) => {
            const live = globalBindings.find((entry) => entry.id === shortcut.id);
            return (
              <GlobalShortcutRow
                key={shortcut.id}
                id={shortcut.id}
                label={t(shortcut.titleKey, shortcut.defaultTitle)}
                binding={live ? live.binding : shortcut.binding}
                defaultBinding={live ? live.defaultBinding : shortcut.binding}
                onSet={setGlobalBinding}
              />
            );
          })}
        </CompactSection>
      )}
    </div>
  );
}

/**
 * Editable row for an OS-level global shortcut. Records a new combo (click → useKeyCapture),
 * persists it through the main process over IPC, and surfaces failures: combos without a
 * primary modifier are refused locally (Shift-only can still swallow normal typing OS-wide);
 * an OS/app collision comes back from the main process as `conflict`. The trash button
 * leaves the shortcut unbound.
 */
function GlobalShortcutRow({
  id,
  label,
  binding,
  defaultBinding,
  onSet,
}: {
  id: GlobalShortcutId;
  label: string;
  binding: string | null;
  defaultBinding: string | null;
  onSet: (id: GlobalShortcutId, binding: string | null) => Promise<{ ok: boolean }>;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<GlobalShortcutSetError | null>(null);

  const { status, preview, start, cancel } = useKeyCapture({
    onCapture: (captured) => {
      if (!globalShortcutBindingHasModifier(captured)) {
        // Global accelerators need a primary modifier; Shift-only still captures normal typing.
        setError('invalid');
        return false; // keep recording so the user can add a modifier
      }
      void onSet(id, captured).then((result) => {
        setError(result.ok ? null : 'conflict');
      });
      return true;
    },
    onCancel: () => setError(null),
  });

  const recording = status === 'recording';
  const isOverridden = binding !== defaultBinding;

  let helper: ReactNode = t('settings.keyboardShortcuts.globalHint');
  if (error === 'conflict') {
    helper = (
      <span className="text-destructive">{t('settings.keyboardShortcuts.globalConflict')}</span>
    );
  } else if (error === 'invalid') {
    helper = (
      <span className="text-destructive">
        {t('settings.keyboardShortcuts.globalNeedsModifier')}
      </span>
    );
  } else if (isOverridden) {
    helper =
      defaultBinding === null
        ? t('settings.keyboardShortcuts.noDefaultHint')
        : t('settings.keyboardShortcuts.defaultHint', {
            binding: formatKeyBinding(defaultBinding),
          });
  }

  return (
    <CompactRow label={label} helper={helper} alignTop>
      <div className="flex items-center">
        <div className={SHORTCUT_SLOT_CLASS}>
          {recording ? (
            <RecordingButton preview={preview} onCancel={cancel} />
          ) : (
            <ShortcutButton
              primary={binding}
              onClick={() => {
                setError(null);
                start();
              }}
            />
          )}
        </div>
        <div className={TRASH_SLOT_CLASS}>
          {!recording && binding && (
            <Button
              variant="ghost"
              size="small"
              icon
              tone="destructive"
              onClick={() => {
                setError(null);
                void onSet(id, null);
              }}
              title={t('settings.keyboardShortcuts.unbindTooltip')}
            >
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>
      </div>
    </CompactRow>
  );
}

function ShortcutRow({
  command,
  findGlobalConflictTitle,
}: {
  command: Command;
  findGlobalConflictTitle: (binding: string) => string | null;
}) {
  const { t } = useTranslation();
  // Resolve a command's display label: prefer its i18n key (set by built-in placeholders),
  // fall back to the already-translated/static `title`. Keeps labels correct across languages
  // and consistent between the row, the conflict notes, and the command palette.
  const resolveTitle = (cmd: Command | undefined, fallback: string): string => {
    if (!cmd) return fallback;
    return cmd.titleKey ? t(cmd.titleKey, { defaultValue: cmd.title }) : cmd.title;
  };

  const currentBindings = commands.getKeybindingsFor(command.id);
  const defaultBindings = commands.getDefaultKeybindingsFor(command.id);
  const isOverridden = commands.hasUserOverride(command.id);
  const primary = currentBindings[0] ?? null;

  const conflictTargetId = primary ? commands.findCommandBoundTo(primary, command.id) : null;
  const conflictTargetTitle = conflictTargetId
    ? resolveTitle(commands.get(conflictTargetId), conflictTargetId)
    : null;

  // Transient "we refused to save that combo" feedback — distinct from the saved-binding
  // conflict above; lives only until the user retries or cancels.
  const [rejected, setRejected] = useState<{ binding: string; otherTitle: string } | null>(null);

  const { status, preview, start, cancel } = useKeyCapture({
    onCapture: (binding) => {
      const collidingId = commands.findCommandBoundTo(binding, command.id);
      if (collidingId) {
        setRejected({ binding, otherTitle: resolveTitle(commands.get(collidingId), collidingId) });
        return false;
      }
      // An OS global shortcut occupies this combo app-wide — refuse it (the combo can't
      // reach an in-app command) rather than silently shadowing the global shortcut.
      const globalConflictTitle = findGlobalConflictTitle(binding);
      if (globalConflictTitle) {
        setRejected({ binding, otherTitle: globalConflictTitle });
        return false;
      }
      commands.setUserKeybindings(command.id, [binding]);
      setRejected(null);
      return true;
    },
    onCancel: () => {
      setRejected(null);
    },
  });

  const handleUnbind = useCallback(() => {
    commands.setUserKeybindings(command.id, []);
    setRejected(null);
  }, [command.id]);

  const handleClickPrimary = useCallback(() => {
    setRejected(null);
    start();
  }, [start]);

  const recording = status === 'recording';
  const showDefaultHint =
    isOverridden && defaultBindings[0] && defaultBindings[0] !== primary
      ? defaultBindings[0]
      : null;

  // Helper cascade by urgency: just-rejected attempt > live collision on saved
  // binding > passive "Default: X" reminder when overridden.
  let helper: ReactNode = undefined;
  if (rejected) {
    helper = (
      <span className="text-destructive">
        {t('settings.keyboardShortcuts.alreadyUsed', {
          binding: formatKeyBinding(rejected.binding),
          command: rejected.otherTitle,
        })}
      </span>
    );
  } else if (conflictTargetTitle) {
    helper = (
      <span className="text-destructive">
        {t('settings.keyboardShortcuts.conflict', { command: conflictTargetTitle })}
      </span>
    );
  } else if (showDefaultHint) {
    helper = t('settings.keyboardShortcuts.defaultHint', {
      binding: formatKeyBinding(showDefaultHint),
    });
  }

  return (
    <CompactRow
      label={resolveTitle(command, command.title)}
      helper={helper}
      alignTop={Boolean(helper)}
    >
      <div className="flex items-center">
        <div className={SHORTCUT_SLOT_CLASS}>
          {recording ? (
            <RecordingButton preview={preview} onCancel={cancel} />
          ) : (
            <ShortcutButton primary={primary} onClick={handleClickPrimary} />
          )}
        </div>
        <div className={TRASH_SLOT_CLASS}>
          {!recording && primary && (
            <Button
              variant="ghost"
              size="small"
              icon
              tone="destructive"
              onClick={handleUnbind}
              title={t('settings.keyboardShortcuts.unbindTooltip')}
            >
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>
      </div>
    </CompactRow>
  );
}

function ShortcutButton({ primary, onClick }: { primary: string | null; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-7 items-center rounded-md border border-transparent px-1.5 transition-colors',
        'hover:border-input-border hover:bg-hover',
        'focus-visible:border-input-border focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60'
      )}
      title={t('settings.keyboardShortcuts.editTooltip')}
    >
      {primary ? (
        <Kbd binding={primary} />
      ) : (
        <span className="text-xs italic text-muted-foreground">
          {t('settings.keyboardShortcuts.unbound')}
        </span>
      )}
    </button>
  );
}

function RecordingButton({ preview, onCancel }: { preview: string | null; onCancel: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onCancel}
      // Inner kbd chips get a primary tint so they read as "live capture" rather than
      // the resting muted style.
      className={cn(
        'inline-flex h-7 items-center gap-2 rounded-md border border-primary/40 bg-primary/5 px-2.5 text-xs font-medium text-primary',
        'transition-colors hover:bg-primary/10',
        '[&_[data-slot=kbd]]:bg-primary/15 [&_[data-slot=kbd]]:text-primary'
      )}
      title={t('settings.keyboardShortcuts.recordingCancelTooltip')}
    >
      <span className="size-1.5 rounded-full bg-primary animate-pulse" />
      {preview ? (
        <Kbd binding={preview} />
      ) : (
        <span>{t('settings.keyboardShortcuts.recording')}</span>
      )}
    </button>
  );
}
