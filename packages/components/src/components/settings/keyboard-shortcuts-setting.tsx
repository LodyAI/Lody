import { text as uiText } from '@lody/ui/tokens/scales.stylex';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Keyboard, Search, Trash2 } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { SettingsPageActions, SettingsPageLead } from './settings-page-header';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, duration, ease, radius } from '@lody/ui/tokens/scales.stylex';
import {
  globalShortcutBindingHasModifier,
  type GlobalShortcutId,
  type GlobalShortcutSetError,
} from '@lody/shared';
import { Button } from '@lody/ui/button';
import { Input, InputShell } from '@lody/ui/input';
import { field } from '@lody/ui/field/field.tokens.stylex';
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
import {
  isShortcutFilterActive,
  matchesShortcutFilter,
  type ShortcutFilter,
} from './keyboard-shortcuts-filter';
import { settingsSurface as surface } from './surface';
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

const pulse = stylex.keyframes({
  '0%': { opacity: 1 },
  '50%': { opacity: 0.4 },
  '100%': { opacity: 1 },
});

const styles = stylex.create({
  error: { color: colors.destructive },
  searchIcon: { width: '16px', height: '16px', flexShrink: 0 },
  toggleOff: { color: field.icon },
  toggleOn: { color: colors.accent },
  /** The keystroke field's value: it fills the well and leaves the ring to it. */
  keystrokeValue: {
    display: 'flex',
    alignItems: 'center',
    flexGrow: 1,
    minWidth: 0,
    alignSelf: 'stretch',
    boxShadow: 'none',
    outlineStyle: 'none',
    cursor: 'pointer',
  },
  keystrokePlaceholder: {
    color: field.placeholder,
    fontWeight: 500,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  controls: { display: 'flex', alignItems: 'center' },
  // Fixed widths so the shortcut and trash columns line up across rows. The shortcut
  // slot holds up to ~4 chips comfortably; the trash slot stays present even when the
  // row has nothing to delete so the column doesn't shift when neighbors do.
  shortcutSlot: { display: 'flex', justifyContent: 'flex-end', width: '144px' },
  trashSlot: { display: 'flex', justifyContent: 'center', width: '36px' },
  /**
   * Unbinding is the row's second action, so it waits for the pointer or the
   * keyboard to reach the row: fifteen trash cans at rest read as fifteen
   * alarms. It keeps its place in the flow, so the key caps never shift.
   */
  reveal: {
    opacity: {
      default: 0,
      [stylex.when.ancestor(':hover')]: 1,
      [stylex.when.ancestor(':focus-within')]: 1,
    },
    pointerEvents: {
      default: 'none',
      [stylex.when.ancestor(':hover')]: 'auto',
      [stylex.when.ancestor(':focus-within')]: 'auto',
    },
    transitionProperty: 'opacity',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  glyph: { width: '100%', height: '100%' },
  unbound: {
    fontSize: uiText.footnoteSize,
    fontStyle: 'italic',
    fontWeight: 400,
    color: colors.tertiaryLabel,
  },
  recordingLabel: { fontWeight: 400 },
  /** The capture is live, so its mark is the accent, and it breathes while it listens. */
  recordingDot: {
    width: '6px',
    height: '6px',
    flexShrink: 0,
    borderRadius: radius.full,
    cornerShape: corner.round,
    backgroundColor: colors.accent,
    animationName: pulse,
    animationDuration: '2s',
    animationTimingFunction: 'cubic-bezier(0.4, 0, 0.6, 1)',
    animationIterationCount: 'infinite',
  },
});

/** The row the unbind action waits on: its hover and focus reveal it. */
const ROW_MARKER = stylex.props(stylex.defaultMarker()).className;

/**
 * A command's display label: its i18n key when it has one (built-in placeholders), else
 * the already-translated/static `title`. The row, its conflict notes, the palette, and
 * the search all read the same label.
 */
function commandLabel(t: TFunction<'translation', undefined>, cmd: Command): string {
  return cmd.titleKey ? t(cmd.titleKey, { defaultValue: cmd.title }) : cmd.title;
}

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

  const [query, setQuery] = useState('');
  const [keyFilter, setKeyFilter] = useState<string | null>(null);
  const filter: ShortcutFilter = { query, keyFilter };
  const filterActive = isShortcutFilterActive(filter);

  // Bindings are read on every render rather than memoized: a rebind publishes a new
  // command snapshot, and the key filter has to see the row's current bindings.
  const visibleGroups = grouped
    .map(([category, items]) => {
      const matching = items.filter((cmd) =>
        matchesShortcutFilter(
          {
            label: commandLabel(t, cmd),
            title: cmd.title,
            id: cmd.id,
            bindings: commands.getKeybindingsFor(cmd.id),
          },
          filter
        )
      );
      return [category, matching] as const;
    })
    .filter(([, items]) => items.length > 0);

  const visibleGlobalShortcuts = showGlobalShortcuts
    ? GLOBAL_SHORTCUTS.flatMap((shortcut) => {
        const live = globalBindings.find((entry) => entry.id === shortcut.id);
        const row = {
          shortcut,
          label: t(shortcut.titleKey, shortcut.defaultTitle),
          binding: live ? live.binding : shortcut.binding,
          defaultBinding: live ? live.defaultBinding : shortcut.binding,
        };
        const matches = matchesShortcutFilter(
          {
            label: row.label,
            title: shortcut.defaultTitle,
            id: shortcut.id,
            bindings: [row.binding],
          },
          filter
        );
        return matches ? [row] : [];
      })
    : [];

  const noMatches =
    filterActive && visibleGroups.length === 0 && visibleGlobalShortcuts.length === 0;

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
      <SettingsPageLead>{t('settings.keyboardShortcuts.description')}</SettingsPageLead>
      <SettingsPageActions>
        <Button variant="secondary" size="small" disabled={!anyOverridden} onClick={handleResetAll}>
          {t('settings.keyboardShortcuts.resetAll')}
        </Button>
      </SettingsPageActions>

      <ShortcutSearchBar
        query={query}
        onQueryChange={setQuery}
        keyFilter={keyFilter}
        onKeyFilterChange={setKeyFilter}
      />

      {grouped.length === 0 && !filterActive && (
        <CompactSection>
          <p {...stylex.props(surface.cardNote)}>{t('settings.keyboardShortcuts.empty')}</p>
        </CompactSection>
      )}

      {noMatches && (
        <CompactSection>
          <p {...stylex.props(surface.cardNote)}>{t('settings.keyboardShortcuts.noMatches')}</p>
        </CompactSection>
      )}

      {visibleGroups.map(([category, items]) => (
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

      {visibleGlobalShortcuts.length > 0 && (
        <CompactSection title={t('settings.keyboardShortcuts.globalSection')}>
          {visibleGlobalShortcuts.map(({ shortcut, label, binding, defaultBinding }) => (
            <GlobalShortcutRow
              key={shortcut.id}
              id={shortcut.id}
              label={label}
              binding={binding}
              defaultBinding={defaultBinding}
              onSet={setGlobalBinding}
            />
          ))}
        </CompactSection>
      )}
    </div>
  );
}

/**
 * Narrows the list by name, or — with the toggle at the field's end on — by keystroke.
 * The two never combine: switching modes drops the other mode's filter. Keystrokes use
 * the same capture the rows use, so command dispatch and OS global shortcuts stay paused
 * while the field listens, and starting it stops any row that was recording.
 */
function ShortcutSearchBar({
  query,
  onQueryChange,
  keyFilter,
  onKeyFilterChange,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  keyFilter: string | null;
  onKeyFilterChange: (binding: string | null) => void;
}) {
  const { t } = useTranslation();
  const [keystrokeMode, setKeystrokeMode] = useState(false);
  const textRef = useRef<HTMLInputElement>(null);
  const keysRef = useRef<HTMLDivElement>(null);
  const modeChanged = useRef(false);

  const leaveKeystrokeMode = () => {
    modeChanged.current = true;
    setKeystrokeMode(false);
    onKeyFilterChange(null);
  };

  const { status, preview, start, cancel } = useKeyCapture({
    // Rejecting every combo keeps the capture listening, so the next combo replaces
    // this one without the registry un-pausing in between.
    onCapture: (binding) => {
      onKeyFilterChange(binding);
      return false;
    },
    // Only Escape leaves the mode. A row taking over the capture, or the window losing
    // focus, keeps the filter: the user may be rebinding one of the rows it shows.
    onCancel: (reason) => {
      if (reason === 'escape') leaveKeystrokeMode();
    },
  });
  const listening = status === 'recording';

  // Focus follows the mode so the field the user just switched to is the one typed into.
  useEffect(() => {
    if (!modeChanged.current) return;
    modeChanged.current = false;
    if (keystrokeMode) keysRef.current?.focus();
    else textRef.current?.focus();
  }, [keystrokeMode]);

  const toggleKeystrokeMode = () => {
    if (keystrokeMode) {
      cancel();
      leaveKeystrokeMode();
      return;
    }
    modeChanged.current = true;
    onQueryChange('');
    setKeystrokeMode(true);
    start();
  };

  const resumeListening = () => {
    if (!listening) start();
  };

  const searchLabel = t('settings.keyboardShortcuts.searchPlaceholder');
  const keystrokeLabel = t('settings.keyboardShortcuts.keystrokePlaceholder');
  const toggleLabel = t('settings.keyboardShortcuts.searchByKeystroke');
  const shown = listening ? (preview ?? keyFilter) : keyFilter;

  const toggle = (
    <Button
      type="button"
      variant="ghost"
      size="mini"
      icon
      onClick={toggleKeystrokeMode}
      aria-pressed={keystrokeMode}
      aria-label={toggleLabel}
      title={toggleLabel}
    >
      <Keyboard
        {...stylex.props(styles.glyph, keystrokeMode ? styles.toggleOn : styles.toggleOff)}
      />
    </Button>
  );

  if (keystrokeMode) {
    return (
      <InputShell
        leading={<Keyboard {...stylex.props(styles.searchIcon)} aria-hidden="true" />}
        trailing={toggle}
      >
        <div
          ref={keysRef}
          role="textbox"
          aria-readonly="true"
          aria-label={keystrokeLabel}
          tabIndex={0}
          onClick={resumeListening}
          onFocus={resumeListening}
          {...stylex.props(styles.keystrokeValue)}
        >
          {shown ? (
            <Kbd binding={shown} size="medium" />
          ) : (
            <span {...stylex.props(styles.keystrokePlaceholder)}>{keystrokeLabel}</span>
          )}
        </div>
      </InputShell>
    );
  }

  return (
    <Input
      ref={textRef}
      type="search"
      value={query}
      onChange={(event) => onQueryChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && query !== '') {
          event.preventDefault();
          event.stopPropagation();
          onQueryChange('');
        }
      }}
      placeholder={searchLabel}
      aria-label={searchLabel}
      leading={<Search {...stylex.props(styles.searchIcon)} aria-hidden="true" />}
      trailing={toggle}
    />
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
      <span {...stylex.props(styles.error)}>{t('settings.keyboardShortcuts.globalConflict')}</span>
    );
  } else if (error === 'invalid') {
    helper = (
      <span {...stylex.props(styles.error)}>
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
    <CompactRow label={label} helper={helper} alignTop className={ROW_MARKER}>
      <div {...stylex.props(styles.controls)}>
        <div {...stylex.props(styles.shortcutSlot)}>
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
        <div {...stylex.props(styles.trashSlot, styles.reveal)}>
          {!recording && binding && (
            <UnbindButton
              onUnbind={() => {
                setError(null);
                void onSet(id, null);
              }}
            />
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
  const resolveTitle = (cmd: Command | undefined, fallback: string): string =>
    cmd ? commandLabel(t, cmd) : fallback;

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
      <span {...stylex.props(styles.error)}>
        {t('settings.keyboardShortcuts.alreadyUsed', {
          binding: formatKeyBinding(rejected.binding),
          command: rejected.otherTitle,
        })}
      </span>
    );
  } else if (conflictTargetTitle) {
    helper = (
      <span {...stylex.props(styles.error)}>
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
      className={ROW_MARKER}
    >
      <div {...stylex.props(styles.controls)}>
        <div {...stylex.props(styles.shortcutSlot)}>
          {recording ? (
            <RecordingButton preview={preview} onCancel={cancel} />
          ) : (
            <ShortcutButton primary={primary} onClick={handleClickPrimary} />
          )}
        </div>
        <div {...stylex.props(styles.trashSlot, styles.reveal)}>
          {!recording && primary && <UnbindButton onUnbind={handleUnbind} />}
        </div>
      </div>
    </CompactRow>
  );
}

/**
 * Removes a row's binding. It is ink until the pointer or focus is on it, and
 * only then says it destroys something: the destructive tone answers the
 * glyph itself, not the row it sits in.
 */
function UnbindButton({ onUnbind }: { onUnbind: () => void }) {
  const { t } = useTranslation();
  const [armed, setArmed] = useState(false);
  const label = t('settings.keyboardShortcuts.unbindTooltip');
  return (
    <Button
      variant="ghost"
      size="small"
      icon
      tone={armed ? 'destructive' : 'neutral'}
      onPointerEnter={() => setArmed(true)}
      onPointerLeave={() => setArmed(false)}
      onFocus={() => setArmed(true)}
      onBlur={() => setArmed(false)}
      onClick={onUnbind}
      aria-label={label}
      title={label}
    >
      <Trash2 {...stylex.props(styles.glyph)} />
    </Button>
  );
}

function ShortcutButton({ primary, onClick }: { primary: string | null; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <Button
      type="button"
      variant="ghost"
      size="small"
      onClick={onClick}
      title={t('settings.keyboardShortcuts.editTooltip')}
    >
      {primary ? (
        <Kbd binding={primary} size="medium" />
      ) : (
        <span {...stylex.props(styles.unbound)}>{t('settings.keyboardShortcuts.unbound')}</span>
      )}
    </Button>
  );
}

function RecordingButton({ preview, onCancel }: { preview: string | null; onCancel: () => void }) {
  const { t } = useTranslation();
  return (
    <Button
      type="button"
      variant="secondary"
      size="small"
      onClick={onCancel}
      title={t('settings.keyboardShortcuts.recordingCancelTooltip')}
    >
      <span {...stylex.props(styles.recordingDot)} />
      {preview ? (
        <Kbd binding={preview} size="medium" />
      ) : (
        <span {...stylex.props(styles.recordingLabel)}>
          {t('settings.keyboardShortcuts.recording')}
        </span>
      )}
    </Button>
  );
}
