import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { magpieProviderSettings, type MagpieTarget } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { Checkbox } from '@lody/ui/checkbox';
import { Spinner } from '@lody/ui/spinner';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import magpieMark from '@/assets/magpie.svg?raw';
import { AgentIcon } from '@/components/icons/agent-icon';
import { InlineSvg } from '@/components/icons/inline-svg';
import { Dialog } from '@/ui/dialog';
import { FormMessage } from './form-primitives';
import { settingsCatalog as catalog } from './surface';

export interface MagpieImportOption {
  id: MagpieTarget;
  /**
   * Product label supplied by the host, such as Claude-magpie. Shown as given.
   */
  name: string;
  /**
   * When set, the runtime is not selected and cannot be selected. The string
   * is shown as the reason; the dialog does not invent one.
   */
  disabledReason?: string;
}

export interface MagpieImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Shown as given. The dialog does not parse, store, or fetch it. */
  gatewayUrl: string;
  /** Label for the current machine. Omitted until the host knows the name. */
  machineName?: string;
  options: readonly MagpieImportOption[];
  /**
   * Changes identity for a new import request while the dialog stays open
   * (a new link at the same gateway, for example). Together with `open` and
   * `gatewayUrl`, a change resets the selection to every enabled runtime and
   * drops in-flight submit state. Closing does the same. An `error` or a
   * rejected `onImport` does not.
   */
  requestKey?: string;
  /**
   * Selected enabled ids, in `options` order. The dialog waits for the promise
   * and ignores a second submit while it is pending. Resolving means the import
   * is done; the host toasts and closes. This button does not check provider setup.
   */
  onImport: (ids: MagpieTarget[]) => Promise<void>;
  /**
   * Host-owned failure for the current request. The selection stays as the
   * user left it. Clear this when starting another attempt; while a submit is
   * in flight the dialog hides it.
   */
  error?: string;
}

const styles = stylex.create({
  titleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    minWidth: 0,
  },
  titleMark: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[3],
    minWidth: 0,
  },
  /** The machine sits on the list, in the same type as a provider name. */
  where: {
    display: 'flex',
    alignItems: 'baseline',
    gap: space[2],
    minWidth: 0,
    margin: 0,
  },
  whereLabel: {
    flexShrink: 0,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.tertiaryLabel,
  },
  whereName: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 500,
    color: colors.label,
  },
  list: { minWidth: 0 },
  /** Same two-line row as a provider in the catalog: mark, name, one fact line. */
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: space[3],
    minWidth: 0,
    paddingBlock: space[3],
  },
  rowRuled: {
    boxShadow: `inset 0 1px 0 ${colors.separator}`,
  },
  rowEnabled: {
    cursor: 'pointer',
  },
  rowDisabled: {
    cursor: 'default',
  },
  checkbox: {
    display: 'flex',
    flexShrink: 0,
  },
  icon: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    width: '32px',
    height: '32px',
    color: colors.label,
  },
  glyph: { width: '20px', height: '20px' },
  rowNameDisabled: {
    color: colors.secondaryLabel,
  },
  env: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    color: colors.secondaryLabel,
  },
  empty: {
    margin: 0,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
  },
});

interface ImportSession {
  token: string | null;
  touched: boolean;
  selected: MagpieTarget[];
  submitting: boolean;
  localError: string | null;
}

const CLOSED_SESSION: ImportSession = {
  token: null,
  touched: false,
  selected: [],
  submitting: false,
  localError: null,
};

function uniqueOptions(options: readonly MagpieImportOption[]): MagpieImportOption[] {
  const seen = new Set<string>();
  const rows: MagpieImportOption[] = [];
  for (const option of options) {
    if (seen.has(option.id)) continue;
    seen.add(option.id);
    rows.push(option);
  }
  return rows;
}

function enabledIds(options: readonly MagpieImportOption[]): MagpieTarget[] {
  return uniqueOptions(options)
    .filter((option) => !option.disabledReason)
    .map((option) => option.id);
}

function providerFor(id: MagpieTarget, gatewayUrl: string) {
  try {
    return magpieProviderSettings(id, gatewayUrl);
  } catch {
    return null;
  }
}

function formatEnv(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join(' · ');
}

function rejectionMessage(reason: unknown, fallback: string): string {
  if (typeof reason === 'string' && reason.trim()) return reason.trim();
  if (reason instanceof Error && reason.message.trim()) return reason.message.trim();
  return fallback;
}

/**
 * Confirms a Magpie import for the machine the user is on. Selection and the
 * in-flight submit live here. The host owns the gateway string, the option
 * list, the failure string, and the import itself. Opening this dialog never
 * starts an import.
 */
export function MagpieImportDialog({
  open,
  onOpenChange,
  gatewayUrl,
  machineName,
  options,
  requestKey,
  onImport,
  error,
}: MagpieImportDialogProps) {
  const { t } = useTranslation();
  const resetToken = open ? `${requestKey ?? ''}\0${gatewayUrl}` : null;
  const [session, setSession] = useState<ImportSession>(CLOSED_SESSION);
  const submitGeneration = useRef(0);
  const submitLock = useRef(false);
  const tokenRef = useRef(resetToken);
  const onImportRef = useRef(onImport);
  tokenRef.current = resetToken;
  onImportRef.current = onImport;

  const sessionMatches = session.token === resetToken;
  if (!sessionMatches) {
    submitGeneration.current += 1;
    submitLock.current = false;
    setSession({ ...CLOSED_SESSION, token: resetToken });
  }

  const active: ImportSession = sessionMatches ? session : { ...CLOSED_SESSION, token: resetToken };
  const rows = uniqueOptions(options);
  const available = new Set(enabledIds(rows));
  const selected = (
    active.touched ? active.selected.filter((id) => available.has(id)) : enabledIds(rows)
  ).filter((id) => available.has(id));
  const visibleError = active.submitting ? null : error?.trim() || active.localError;

  const setSelection = (next: MagpieTarget[]) => {
    if (active.submitting || resetToken === null) return;
    setSession({
      token: resetToken,
      touched: true,
      selected: next,
      submitting: false,
      localError: active.localError,
    });
  };

  const submit = () => {
    if (submitLock.current || active.submitting || selected.length === 0 || resetToken === null) {
      return;
    }
    const generation = submitGeneration.current;
    const token = resetToken;
    const importSelected = onImportRef.current;
    const ids = rows
      .filter((row) => selected.includes(row.id) && available.has(row.id))
      .map((row) => row.id);
    submitLock.current = true;
    setSession({
      token,
      touched: true,
      selected: ids,
      submitting: true,
      localError: null,
    });
    // The click's callback is frozen here. A new link can replace `onImport`
    // before this microtask runs; that request must not receive this selection.
    void Promise.resolve()
      .then(() => {
        if (tokenRef.current !== token || submitGeneration.current !== generation) return undefined;
        return importSelected(ids);
      })
      .then(() => {
        if (submitGeneration.current !== generation || tokenRef.current !== token) return;
        submitLock.current = false;
        setSession((current) =>
          current.token !== token ? current : { ...current, submitting: false }
        );
      })
      .catch((reason: unknown) => {
        if (submitGeneration.current !== generation || tokenRef.current !== token) return;
        submitLock.current = false;
        setSession((current) =>
          current.token !== token
            ? current
            : {
                ...current,
                submitting: false,
                localError: rejectionMessage(reason, t('settings.magpieImport.failed')),
              }
        );
      });
  };

  const machine = machineName?.trim() || t('settings.magpieImport.thisMachine');

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content>
        <Dialog.Header>
          <Dialog.Title>
            <span {...stylex.props(styles.titleRow)}>
              <span {...stylex.props(styles.titleMark)}>
                <InlineSvg raw={magpieMark} />
              </span>
              {t('settings.magpieImport.title')}
            </span>
          </Dialog.Title>
          <Dialog.Description>{t('settings.magpieImport.description')}</Dialog.Description>
        </Dialog.Header>

        <div {...stylex.props(styles.body)}>
          <p {...stylex.props(styles.where)}>
            <span {...stylex.props(styles.whereLabel)}>
              {t('settings.magpieImport.machineLineLabel')}
            </span>
            <span {...stylex.props(styles.whereName)}>{machine}</span>
          </p>

          {rows.length === 0 ? (
            <p {...stylex.props(styles.empty)}>{t('settings.magpieImport.empty')}</p>
          ) : (
            <div
              role="group"
              aria-label={t('settings.magpieImport.runtimes')}
              {...stylex.props(styles.list)}
            >
              {rows.map((option, index) => {
                const disabled = Boolean(option.disabledReason) || active.submitting;
                const checked = selected.includes(option.id);
                const provider = providerFor(option.id, gatewayUrl);
                const subtitle =
                  option.disabledReason ||
                  (['kimi', 'grok', 'bub'].includes(option.id)
                    ? t('settings.magpieImport.independentConfig')
                    : provider
                      ? formatEnv(provider.env)
                      : '');
                return (
                  <label
                    key={option.id}
                    {...stylex.props(
                      styles.row,
                      index > 0 && styles.rowRuled,
                      disabled ? styles.rowDisabled : styles.rowEnabled
                    )}
                  >
                    <span {...stylex.props(styles.checkbox)}>
                      <Checkbox
                        checked={checked}
                        disabled={disabled}
                        onCheckedChange={(next) => {
                          const on = next === true;
                          const nextIds = on
                            ? rows
                                .filter(
                                  (row) =>
                                    available.has(row.id) &&
                                    (row.id === option.id || selected.includes(row.id))
                                )
                                .map((row) => row.id)
                            : selected.filter((id) => id !== option.id);
                          setSelection(nextIds);
                        }}
                      />
                    </span>
                    <span {...stylex.props(styles.icon)}>
                      <AgentIcon
                        cliType="builtin"
                        agentType={
                          provider?.agentType ?? (option.id === 'dsh' ? 'deepseek' : option.id)
                        }
                        className={stylex.props(styles.glyph).className}
                      />
                    </span>
                    <span {...stylex.props(catalog.body)}>
                      <span
                        {...stylex.props(
                          catalog.name,
                          Boolean(option.disabledReason) && styles.rowNameDisabled
                        )}
                      >
                        {option.name}
                      </span>
                      {subtitle ? (
                        <span {...stylex.props(styles.env)} title={subtitle}>
                          {subtitle}
                        </span>
                      ) : null}
                    </span>
                  </label>
                );
              })}
            </div>
          )}

          {visibleError ? <FormMessage tone="error">{visibleError}</FormMessage> : null}
        </div>

        <Dialog.Footer>
          <Button
            variant="secondary"
            size="small"
            onClick={() => onOpenChange(false)}
            disabled={active.submitting}
          >
            {t('common.cancel')}
          </Button>
          <Button
            size="small"
            onClick={submit}
            disabled={active.submitting || selected.length === 0}
          >
            {active.submitting ? <Spinner size="small" /> : null}
            {active.submitting
              ? t('settings.magpieImport.importing')
              : t('settings.magpieImport.import')}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}
